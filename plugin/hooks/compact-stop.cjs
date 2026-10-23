#!/usr/bin/env node
'use strict';
// Compact-stop (constitution IV: a rule broken twice gets enforced).
//
// A session that runs past its context window compacts again and again; each
// compaction loses detail and every later turn costs more. The rule is "stop at
// your first auto-compaction and hand off". This hook enforces it, one script
// for three events (dispatching on hook_event_name):
//
//   PreCompact, trigger "auto": records the session as compacted
//       (lib/compact-marks.cjs). A manual /compact records nothing. It never
//       blocks compaction: blocking doesn't stop the session, and at the context
//       limit the request then fails. Always exit 0. A PreCompact input that
//       carries agent_id comes from a subagent and doesn't mark the session (the
//       hooks reference doesn't say that a subagent's compaction fires PreCompact
//       at all; this is the safe reading if it does).
//   SessionStart, source "compact": when the session is marked, adds the
//       instruction below to Claude's context (additionalContext).
//   PreToolUse, every tool: when the session is marked, denies every call except
//       Read, Grep, Glob; Edit and Write on .recon/*/INDEX.md under the project
//       directory or on anything under ~/.claude/plans/; SendMessage; and tools
//       whose name starts with mcp__ccd_turn__. The reason is the same
//       instruction. Exit 2 with the reason on stderr, like the other guards.
//
// The stop gate (stop-gate.cjs) lets a marked session stop without its
// fast-gate demand.
//
// ENG_STANDARD_COMPACT_STOP=off turns all of it off. A guardrail, not a wall,
// and it fails open: input it can't parse or a marker it can't check never
// blocks a call. The Owner can always end the session.

const os = require('os');
const path = require('path');

const TAG = '(hook: eng-standard compact-stop)';
const INSTRUCTION =
  'This session compacted, so it stops here (eng-standard compact-stop). ' +
  'Write where you stand into `.recon/<step>/INDEX.md` (a Planner session: its handoff file under `~/.claude/plans/`), ' +
  'send your report to the Planner, and end your turn. A fresh session continues from that file.';
const ALWAYS_ALLOWED = new Set(['Read', 'Grep', 'Glob', 'SendMessage']);
const WRITE_TOOLS = new Set(['Edit', 'Write']);
const TURN_PREFIX = 'mcp__ccd_turn__';

function allow() {
  process.exit(0);
}

function readStdin(callback) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => callback(buf));
  process.stdin.on('error', () => allow());
}

// True when a write to filePath is one a marked session may make: an INDEX.md
// one level under .recon/ in the project, or anything under ~/.claude/plans/.
function writeAllowed(common, payload) {
  const ti = payload.tool_input;
  const target = ti && typeof ti === 'object' ? ti.file_path : undefined;
  if (typeof target !== 'string' || target.length === 0) return false;
  const base = payload.cwd || common.projectDir(payload);
  const real = common.realpathLoose(path.isAbsolute(target) ? target : path.resolve(base, target));

  const plans = common.realpathLoose(path.join(os.homedir(), '.claude', 'plans'));
  if (common.isInside(real, plans)) return true;

  const recon = common.realpathLoose(path.join(common.projectDir(payload), '.recon'));
  if (!common.isInside(real, recon)) return false;
  const parts = common.toPosix(real).slice(common.toPosix(recon).replace(/\/+$/, '').length + 1).split('/');
  return parts.length === 2 && parts[0] !== '' && parts[0] !== '..' && parts[1] === 'INDEX.md';
}

function decideTool(common, payload) {
  const name = payload.tool_name;
  if (typeof name !== 'string') return null;
  if (ALWAYS_ALLOWED.has(name) || name.startsWith(TURN_PREFIX)) return null;
  if (WRITE_TOOLS.has(name) && writeAllowed(common, payload)) return null;
  return `Blocked: ${name}\n${INSTRUCTION} ${TAG}`;
}

function main(raw) {
  const marks = require('./lib/compact-marks.cjs');
  if (!marks.enabled()) allow();
  const common = require('./lib/common.cjs');
  const payload = common.parsePayload(raw);
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId) allow();

  switch (payload.hook_event_name) {
    case 'PreCompact':
      if (payload.trigger === 'auto' && !payload.agent_id) marks.mark(sessionId, { trigger: 'auto' });
      return allow();
    case 'SessionStart':
      if (payload.source === 'compact' && marks.isMarked(sessionId)) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${INSTRUCTION} ${TAG}` },
        }));
      }
      return allow();
    case 'PreToolUse': {
      if (!marks.isMarked(sessionId)) return allow();
      const reason = decideTool(common, payload);
      if (reason) {
        marks.touch(sessionId);
        common.block(reason);
      }
      return allow();
    }
    default:
      return allow();
  }
}

readStdin((raw) => {
  try {
    main(raw);
  } catch {
    allow();
  }
});
