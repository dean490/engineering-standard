#!/usr/bin/env node
'use strict';
// Compact-stop (constitution IV: a rule broken twice gets enforced).
//
// A session that runs past its context window compacts again and again; each
// compaction loses detail and every later turn costs more. The rule is "stop at
// your first auto-compaction and hand off" (token-watch.cjs does the same
// earlier, at about 140k tokens). This hook enforces it, one script
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
//       directory or on anything under ~/.claude/plans/; start_session and
//       detach_session; and tools whose name starts with mcp__ccd_turn__ (the
//       list is in lib/handoff.cjs, shared with token-watch.cjs). The reason is
//       the same instruction. Exit 2 with the reason on stderr, like the other
//       guards. It applies to every session, Planner or Builder.
//
// The stop gate (stop-gate.cjs) lets a marked session stop without its
// fast-gate demand.
//
// ENG_STANDARD_COMPACT_STOP=off turns all of it off. A guardrail, not a wall,
// and it fails open: input it can't parse or a marker it can't check never
// blocks a call. The Owner can always end the session.

const marks = require('./lib/compact-marks.cjs');
const handoff = require('./lib/handoff.cjs');

const INSTRUCTION = handoff.message(
  'This session compacted, so it stops here (eng-standard compact-stop).',
  'ENG_STANDARD_COMPACT_STOP=off'
);

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

function decideTool(common, payload) {
  if (typeof payload.tool_name !== 'string' || handoff.toolAllowed(common, payload)) return null;
  return `Blocked: ${payload.tool_name}\n${INSTRUCTION}`;
}

function main(raw) {
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
          hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: INSTRUCTION },
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
