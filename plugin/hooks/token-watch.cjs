#!/usr/bin/env node
'use strict';
// Token-watch (constitution IV: a rule broken twice gets enforced).
//
// Sessions ran far past a useful size, and a rule that asks a session to watch
// its own context wasn't followed. On every PreToolUse of the main session this
// hook reads the latest assistant entry's usage from the transcript (input +
// cache_creation + cache_read tokens, the context the last request carried).
// At 140000 or more it marks the session (lib/compact-marks.cjs, the "handoff"
// store) and from then on denies every call except those a hand-off needs
// (lib/handoff.cjs, shared with compact-stop.cjs: reads, the state files,
// start_session, detach_session, mcp__ccd_turn__ tools, and ToolSearch with a
// `select:` query naming only those tools), with the hand-off steps as the
// reason; when the app refuses a "user_asked" start because the turn came from
// another session, the steps have the session leave a start card instead. Exit 2 with the reason on stderr, like the other guards.
//
// Skipped: any call that carries agent_id (a subagent or teammate; the session
// is the main one), and a payload without a readable transcript_path.
//
// The stop gate (stop-gate.cjs) lets a marked session stop without its
// fast-gate demand.
//
// ENG_STANDARD_TOKEN_WATCH=off turns it off; ENG_STANDARD_TOKEN_WATCH=<number>
// sets the threshold. A guardrail, not a wall, and it fails open: input it can't
// parse, a transcript it can't read or a usage entry it can't find never blocks
// a call. The Owner can always end the session.

const fs = require('fs');

const DEFAULT_THRESHOLD = 140000;
const TAIL_BYTES = 512 * 1024;

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

function threshold() {
  const n = Number(process.env.ENG_STANDARD_TOKEN_WATCH);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// The context of the latest assistant entry in the last TAIL_BYTES of the
// transcript, or null when there is none. The cut may land inside a line; a
// line that doesn't parse is skipped.
function latestContext(transcriptPath) {
  const fd = fs.openSync(transcriptPath, 'r');
  let text;
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!entry || entry.isSidechain === true) continue;
    const msg = entry.message;
    const usage = msg && msg.role === 'assistant' ? msg.usage : null;
    if (!usage || typeof usage !== 'object') continue;
    const total = count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens);
    if (total > 0) return total;
  }
  return null;
}

function main(raw) {
  const { handoff: marks } = require('./lib/compact-marks.cjs');
  if (!marks.enabled()) allow();
  const common = require('./lib/common.cjs');
  const payload = common.parsePayload(raw);
  if (payload.hook_event_name !== 'PreToolUse' || payload.agent_id) allow();
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId) allow();

  const limit = threshold();
  if (!marks.isMarked(sessionId)) {
    if (typeof payload.transcript_path !== 'string' || !payload.transcript_path) allow();
    const tokens = latestContext(payload.transcript_path);
    if (tokens === null || tokens < limit) allow();
    marks.mark(sessionId, { tokens, threshold: limit });
  }

  const handoff = require('./lib/handoff.cjs');
  if (handoff.toolAllowed(common, payload)) allow();
  marks.touch(sessionId);
  const reason = handoff.message(
    `This session reached about ${Math.round(limit / 1000)}k tokens, so it hands off now (eng-standard token-watch).`,
    'ENG_STANDARD_TOKEN_WATCH=off'
  );
  common.block(`Blocked: ${payload.tool_name}\n${reason}`);
}

readStdin((raw) => {
  try {
    main(raw);
  } catch {
    allow();
  }
});
