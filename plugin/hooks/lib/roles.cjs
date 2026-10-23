'use strict';
// The session role store shared by the Planner guard and the stop gate (and
// the file-name helper that compact-marks.cjs uses for its own store).
//
// Roles live in ${CLAUDE_PLUGIN_DATA}/session-roles/<session_id>.json, written
// once per session by planner-readonly.cjs --record-role. Sandboxed commands
// can't write there (it is under ~/.claude, a sandbox protected path), and the
// Planner guard denies Claude's file tools there for every session.
//
// readRole fails closed: a record that exists but can't be read or parsed, or
// names no valid role, counts as "planner".

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROLES = new Set(['planner', 'builder']);

// The plugin's data directory; the OS temp directory stands in when Claude Code
// hasn't set CLAUDE_PLUGIN_DATA (a hook run by hand).
function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'eng-standard');
}

function storeDir() {
  return path.join(dataDir(), 'session-roles');
}

// A session ID as a file name: used as is when it is plain, hashed otherwise.
function safeName(sessionId) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ? sessionId
    : crypto.createHash('sha256').update(sessionId).digest('hex');
}

function rolePath(sessionId) {
  return path.join(storeDir(), `${safeName(sessionId)}.json`);
}

// { role, record } for a readable record; { role: 'planner', unreadable: reason }
// for a record that exists but can't be used; null when the session has none.
function readRole(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  let raw;
  try {
    raw = fs.readFileSync(rolePath(sessionId), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { role: 'planner', unreadable: `can't be read (${err.code || err.message})` };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return { role: 'planner', unreadable: 'is not valid JSON' };
  }
  if (!record || typeof record !== 'object' || !ROLES.has(record.role)) {
    return { role: 'planner', unreadable: 'names no valid role' };
  }
  return { role: record.role, record };
}

module.exports = { ROLES, dataDir, storeDir, safeName, rolePath, readRole };
