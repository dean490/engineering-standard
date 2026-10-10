'use strict';
// Shared helpers for the eng-standard hooks. No dependencies.
//
// Exit codes follow the Claude Code hooks reference:
//   0  no decision (or a JSON decision on stdout)
//   2  blocking error; stderr is the reason Claude sees
// Exit 1 is never used: Claude Code treats it as a non-blocking error.

const fs = require('fs');
const path = require('path');

function readStdin(callback) {
  let buf = '';
  let done = false;
  const finish = (err) => {
    if (done) return;
    done = true;
    callback(err || null, buf);
  };
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => finish(null));
    process.stdin.on('error', (err) => finish(err));
  } catch (err) {
    finish(err);
  }
}

// Parse the hook payload. Throws when it is not a JSON object.
function parsePayload(raw) {
  const payload = JSON.parse(raw);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('hook input is not a JSON object');
  }
  return payload;
}

function block(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(2);
}

function allow() {
  process.exit(0);
}

// The project root the session started in. Claude Code sets CLAUDE_PROJECT_DIR
// for every hook; the payload's cwd is the fallback.
function projectDir(payload) {
  return process.env.CLAUDE_PROJECT_DIR || (payload && payload.cwd) || process.cwd();
}

// Resolve symlinks for a path that may not exist yet: resolve the longest
// existing ancestor and append the rest. On macOS this maps /tmp to /private/tmp.
function realpathLoose(p) {
  const abs = path.resolve(p);
  let current = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

// True when child is parent or lies under it. Case-insensitive on Windows and macOS.
function isInside(child, parent) {
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  let c = toPosix(child);
  let p = toPosix(parent).replace(/\/+$/, '');
  if (fold) { c = c.toLowerCase(); p = p.toLowerCase(); }
  return c === p || c.startsWith(p + '/');
}

module.exports = {
  readStdin,
  parsePayload,
  block,
  allow,
  projectDir,
  realpathLoose,
  toPosix,
  isInside,
};
