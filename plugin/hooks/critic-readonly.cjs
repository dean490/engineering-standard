#!/usr/bin/env node
'use strict';
// PreToolUse: keep the review agents read-only (constitution II; STANDARD 1.4,
// 4.5). Matches Bash|PowerShell|Monitor.
//
// Applies only when the call comes from the plugin's critic or
// security-reviewer agent, as a subagent or as the main agent of a session
// started with `claude --agent eng-standard:critic`. Hook input names the
// agent in agent_type. Every other session passes through untouched.
//
// Those agents get no Edit or Write tool (their `tools` frontmatter), and
// Claude Code ignores hooks declared in a plugin agent's frontmatter, so this
// plugin-level hook limits their shell commands to the read-only allowlist in
// lib/readonly-allowlist.cjs, which the Planner guard shares: read-only git
// commands, read-only file utilities, and the project's test and typecheck
// scripts. Anything not on the allowlist is denied. A guardrail: the sandbox
// and the Owner's review are the walls behind it.
//
// Exit 2 = deny (reason on stderr). Exit 0 = no decision.
// Fails closed: unparseable input is denied (the agent can't be identified).

let common;
let allowlist;
try {
  common = require('./lib/common.cjs');
  allowlist = require('./lib/readonly-allowlist.cjs');
} catch (err) {
  process.stderr.write(`critic-readonly: failed to load helpers (${err.message}); blocking (fail closed).\n`);
  process.exit(2);
}

const TAG = '(guard: eng-standard critic-readonly)';
const REVIEW_AGENTS = new Set(['eng-standard:critic', 'eng-standard:security-reviewer']);

function decide(payload) {
  const agent = payload.agent_type;
  if (typeof agent !== 'string' || !REVIEW_AGENTS.has(agent)) return null;
  const ti = payload.tool_input;
  // A Monitor WebSocket watch runs no command.
  if (payload.tool_name === 'Monitor' && ti && typeof ti === 'object' && ti.command === undefined && ti.ws && typeof ti.ws === 'object') return null;
  if (ti === null || typeof ti !== 'object' || typeof ti.command !== 'string') {
    return `Blocked: hook input has no command string; blocking (fail closed). ${TAG}`;
  }
  const why = allowlist.commandStringDenied(ti.command);
  if (!why) return null;
  return `Blocked: review agents run read-only commands only; this one ${why}.\nCommand: ${ti.command}\n` +
    `Allowed: ${allowlist.ALLOWED_SUMMARY}. ${TAG}`;
}

common.readStdin((err, raw) => {
  if (err) common.block(`Blocked: could not read hook input (${err.message}); blocking (fail closed). ${TAG}`);
  let payload;
  try {
    payload = common.parsePayload(raw);
  } catch (e) {
    common.block(`Blocked: could not parse hook input (${e.message}); blocking (fail closed). ${TAG}`);
  }
  let reason;
  try {
    reason = decide(payload);
  } catch (e) {
    reason = `Blocked: critic read-only check failed (${e.message}); blocking (fail closed). ${TAG}`;
  }
  if (reason) common.block(reason);
  common.allow();
});
