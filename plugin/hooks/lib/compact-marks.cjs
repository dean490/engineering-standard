'use strict';
// Which sessions auto-compacted (compact-stop.cjs), shared with the stop gate.
//
// A marker is the file ${CLAUDE_PLUGIN_DATA}/compacted/<session_id>.json, next
// to the role records (lib/roles.cjs), and like them it is out of reach of
// sandboxed commands and of Claude's file tools (planner-readonly.cjs denies
// the whole data directory).
//
// Everything here fails open: a marker that can't be checked counts as absent,
// because compact-stop is a process rule, not a security wall, and a fault in
// it must never lock a session out of its tools.

const fs = require('fs');
const path = require('path');
const roles = require('./roles.cjs');

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disabled']);

// ENG_STANDARD_COMPACT_STOP=off turns compact-stop off, the way
// ENG_STANDARD_STOP_GATE=off turns the stop gate off (an env block in
// .claude/settings.json, or .claude/settings.local.json for one machine).
function enabled() {
  return !OFF_VALUES.has(String(process.env.ENG_STANDARD_COMPACT_STOP || '').toLowerCase());
}

function storeDir() {
  return path.join(roles.dataDir(), 'compacted');
}

function markPath(sessionId) {
  return path.join(storeDir(), `${roles.safeName(sessionId)}.json`);
}

function isMarked(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  try {
    return fs.statSync(markPath(sessionId)).isFile();
  } catch {
    return false;
  }
}

// A marked session still in use keeps its marker from expiring.
function touch(sessionId) {
  try {
    const now = new Date();
    fs.utimesSync(markPath(sessionId), now, now);
  } catch {
    // best effort
  }
}

function mark(sessionId, info = {}) {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(markPath(sessionId), JSON.stringify({
      session_id: sessionId,
      marked_at: new Date().toISOString(),
      ...info,
    }) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err; // marked by an earlier compaction
    touch(sessionId);
  }
  // Remove markers older than 30 days.
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > MAX_AGE_MS) fs.unlinkSync(f);
    } catch {
      // another session may have removed it
    }
  }
}

module.exports = { enabled, storeDir, markPath, isMarked, touch, mark };
