#!/usr/bin/env node
'use strict';
// Web-limit (constitution IV: a rule broken twice gets enforced).
//
// Research done in the main session fills its context. This hook counts
// WebFetch and WebSearch calls per session_id (a file under
// ${CLAUDE_PLUGIN_DATA}/web-lookups/) and denies the 4th and later, telling the
// session to send the question to a background research subagent. A call that
// carries agent_id comes from a subagent and is neither counted nor denied.
// Exit 2 with the reason on stderr, like the other guards.
//
// ENG_STANDARD_WEB_LIMIT=off turns it off; ENG_STANDARD_WEB_LIMIT=<number>
// sets the limit. A guardrail, not a wall, and it fails open: input it can't
// parse or a counter it can't write never blocks a call.

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 3;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disabled']);
const REASON = (name, max) =>
  `Blocked: ${name}\n` +
  `This session has made ${max} web lookups (eng-standard web-limit). ` +
  'Start a background research subagent (Agent tool, `run_in_background: true`) with the question and the file to save its findings to, and keep working. ' +
  'Owner override: `ENG_STANDARD_WEB_LIMIT=off` or a number.';

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

// The limit, or null when the hook is off.
function limit() {
  const v = String(process.env.ENG_STANDARD_WEB_LIMIT || '').toLowerCase();
  if (OFF_VALUES.has(v)) return null;
  const n = Number(v);
  return v !== '' && Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

// Record one more lookup for the session and return how many it has made.
// Each lookup appends one byte to the session's file, so concurrent calls
// can't lose a count.
function countLookup(roles, sessionId) {
  const dir = path.join(roles.dataDir(), 'web-lookups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${roles.safeName(sessionId)}.count`);
  fs.appendFileSync(file, '.');
  const n = fs.statSync(file).size;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > MAX_AGE_MS) fs.unlinkSync(f);
    } catch {
      // another session may have removed it
    }
  }
  return n;
}

function main(raw) {
  const max = limit();
  if (max === null) allow();
  const common = require('./lib/common.cjs');
  const payload = common.parsePayload(raw);
  if (payload.hook_event_name !== 'PreToolUse' || payload.agent_id) allow();
  if (payload.tool_name !== 'WebFetch' && payload.tool_name !== 'WebSearch') allow();
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || !sessionId) allow();

  const made = countLookup(require('./lib/roles.cjs'), sessionId);
  if (made > max) common.block(REASON(payload.tool_name, max));
  allow();
}

readStdin((raw) => {
  try {
    main(raw);
  } catch {
    allow();
  }
});
