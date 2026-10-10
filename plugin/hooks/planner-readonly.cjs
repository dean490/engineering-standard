#!/usr/bin/env node
'use strict';
// Planner read-only guard (constitution II; STANDARD 1.1, 1.2).
//
// The Planner is a session that starts in plan mode. Plan mode blocks edits
// while it is on, but approving a plan ends plan mode and the same session
// starts editing, which would make the Planner a Builder. A Builder, on the
// other hand, may explore, plan, have the plan approved, and implement in one
// session. So the guard fixes each session's role when the session starts,
// without a hand-maintained list of session IDs:
//
//   1. On a session's first UserPromptSubmit, the guard records its role:
//      "planner" if permission_mode is "plan", otherwise "builder". Later
//      prompts never change it. Resuming with --resume, --continue, or /resume
//      keeps the session ID, so a resumed session keeps its role;
//      --fork-session and /clear start a new session ID, which gets its own.
//   2. In a "planner" session:
//      - Edit, Write, and NotebookEdit calls on files inside the repository
//        are denied, whatever the permission mode is by then. Files outside
//        the repository (plan files in ~/.claude/plans, auto memory, the
//        scratchpad) stay writable.
//      - Bash, PowerShell, and Monitor commands must be on the read-only
//        allowlist the review agents use (lib/readonly-allowlist.cjs): read-only
//        git, read-only file utilities, and the test and typecheck scripts.
//   3. A "builder" session, or one with no record, is governed by plan mode
//      alone: repository edits are denied while permission_mode is "plan".
//   4. In every session, Claude's file tools can't write the plugin's data
//      directory (${CLAUDE_PLUGIN_DATA}), which holds the role records.
//
// A record that exists but can't be read or parsed counts as "planner" (fail
// closed). A guardrail: it reads tool input. The walls behind it are the
// Owner's review and the protected main branch (STANDARD 1.2).
//
// Roles live in ${CLAUDE_PLUGIN_DATA}/session-roles/<session_id>.json
// (lib/roles.cjs). Each later prompt refreshes the file's time, and a role
// unused for 30 days is removed the next time any session records one.
//
// Run with --record-role (UserPromptSubmit): records the role and always exits
// 0, so it can never block a prompt.
// Run without arguments (PreToolUse Edit|Write|NotebookEdit and
// Bash|PowerShell|Monitor): enforces.
// Exit 2 = deny (reason on stderr). Exit 0 = no decision.
// Fails closed on input it can't parse.

const RECORD_ROLE = process.argv.includes('--record-role');

let common;
let roles;
let allowlist;
try {
  common = require('./lib/common.cjs');
  roles = require('./lib/roles.cjs');
  allowlist = require('./lib/readonly-allowlist.cjs');
} catch (err) {
  if (RECORD_ROLE) process.exit(0);
  process.stderr.write(`planner-readonly: failed to load helpers (${err.message}); blocking (fail closed).\n`);
  process.exit(2);
}
const fs = require('fs');
const path = require('path');

const TAG = '(guard: eng-standard planner-readonly)';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor']);

function recordRole(payload) {
  const sessionId = payload.session_id;
  const mode = payload.permission_mode;
  if (typeof sessionId !== 'string' || !sessionId) return;
  const file = roles.rolePath(sessionId);
  if (fs.existsSync(file)) {
    // A later prompt: the role stays as recorded. Refresh the time so an
    // active session's role doesn't expire.
    const now = new Date();
    fs.utimesSync(file, now, now);
    return;
  }
  // Without a permission mode there is nothing to decide from; the next prompt
  // that carries one records the role.
  if (typeof mode !== 'string' || !mode) return;
  const dir = roles.storeDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({
      session_id: sessionId,
      role: mode === 'plan' ? 'planner' : 'builder',
      permission_mode: mode,
      project_dir: common.projectDir(payload),
      recorded_at: new Date().toISOString(),
    }) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err; // another hook process recorded it first
  }
  // Remove roles unused for 30 days.
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > MAX_AGE_MS) fs.unlinkSync(f);
    } catch {
      // another session may have removed it
    }
  }
}

function repoRoot(dir) {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}

function plannerReason(role) {
  return role.unreadable
    ? `This session's role record ${role.unreadable}, so it is treated as a Planner session (fail closed). `
    : `This is a Planner session: it started in plan mode (role recorded ${role.record.recorded_at}). `;
}

function decideFile(payload, role) {
  const ti = payload.tool_input;
  const target = ti && typeof ti === 'object' ? ti.file_path || ti.notebook_path : undefined;
  if (typeof target !== 'string' || target.length === 0) {
    return `Blocked: ${payload.tool_name || 'edit'} call without a file path; blocking (fail closed). ${TAG}`;
  }
  const base = payload.cwd || common.projectDir(payload);
  const realTarget = common.realpathLoose(path.isAbsolute(target) ? target : path.resolve(base, target));
  if (common.isInside(realTarget, common.realpathLoose(roles.dataDir()))) {
    return (
      `Blocked: ${payload.tool_name || 'edit'} -> ${target}\n` +
      `That is the eng-standard plugin's data directory, which holds each session's role record. ` +
      `No session edits it (STANDARD 1.2). ${TAG}`
    );
  }

  const planner = role !== null && role.role === 'planner';
  if (!planner && payload.permission_mode !== 'plan') return null;
  const root = repoRoot(common.realpathLoose(common.projectDir(payload)));
  if (!common.isInside(realTarget, root)) return null;

  if (planner) {
    return (
      `Blocked: ${payload.tool_name || 'edit'} -> ${target}\n` + plannerReason(role) +
      `A Planner session stays read-only in the repository for its whole life, including after a plan is approved ` +
      `(STANDARD 1.1, 1.2). The Planner designs and specifies; a Builder writes the code. Start a new session ` +
      `that is not in plan mode and give it the Builder prompt. ${TAG}`
    );
  }
  return (
    `Blocked: ${payload.tool_name || 'edit'} -> ${target}\n` +
    `This session is in plan mode, which is read-only in the repository (STANDARD 1.2). ` +
    `Edits can start once the plan is approved. ${TAG}`
  );
}

function decideShell(payload, role) {
  if (role === null || role.role !== 'planner') return null;
  const ti = payload.tool_input;
  // A Monitor WebSocket watch runs no command.
  if (payload.tool_name === 'Monitor' && ti && typeof ti === 'object' && ti.command === undefined && ti.ws && typeof ti.ws === 'object') return null;
  if (ti === null || typeof ti !== 'object' || typeof ti.command !== 'string') {
    return `Blocked: ${payload.tool_name} call without a command string in a Planner session; blocking (fail closed). ${TAG}`;
  }
  const why = allowlist.commandStringDenied(ti.command);
  if (!why) return null;
  return (
    `Blocked: a Planner session runs read-only commands only; this one ${why}.\nCommand: ${ti.command}\n` +
    plannerReason(role) +
    `Allowed: ${allowlist.ALLOWED_SUMMARY} (STANDARD 1.1, 1.2). A Builder session makes changes. ${TAG}`
  );
}

function decide(payload) {
  const role = roles.readRole(payload.session_id);
  if (FILE_TOOLS.has(payload.tool_name)) return decideFile(payload, role);
  if (SHELL_TOOLS.has(payload.tool_name)) return decideShell(payload, role);
  return null;
}

common.readStdin((err, raw) => {
  let payload;
  try {
    if (err) throw err;
    payload = common.parsePayload(raw);
  } catch (e) {
    if (RECORD_ROLE) process.exit(0);
    common.block(`Blocked: could not parse hook input (${e.message}); blocking (fail closed). ${TAG}`);
  }

  if (RECORD_ROLE) {
    try {
      recordRole(payload);
    } catch {
      // recording is best effort; it must never block a prompt
    }
    process.exit(0);
  }

  let reason;
  try {
    reason = decide(payload);
  } catch (e) {
    reason = `Blocked: planner read-only check failed (${e.message}); blocking (fail closed). ${TAG}`;
  }
  if (reason) common.block(reason);
  common.allow();
});
