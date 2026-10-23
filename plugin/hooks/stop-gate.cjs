#!/usr/bin/env node
'use strict';
// Stop: remind a Builder session to run the fast gate before it finishes with
// uncommitted source or test changes (STANDARD 2.1). Convenience hook: it fails
// open, and it never runs the project's scripts.
//
// Hooks run outside the sandbox, so this hook runs no project code and puts no
// command output in its reason (DECISIONS 7, 10). The gate itself runs through
// the /eng-standard:gate skill, which Claude runs with Bash inside the sandbox;
// its script (plugin/scripts/run-gate.cjs) records each result in
// .recon/gate/last.json: { script, exit, tree, time, evidence }, where tree is
// the fingerprint of the uncommitted non-doc changes the gate ran on
// (lib/tree-hash.cjs).
//
// When Claude is about to stop:
//   - skip if the project turned the gate off: ENG_STANDARD_STOP_GATE=off in the
//     env block of .claude/settings.json or .claude/settings.local.json
//   - skip if this stop is already a continuation caused by a stop hook
//     (stop_hook_active), so the hook blocks a stop at most once
//   - skip if the session auto-compacted or passed the token limit
//     (lib/compact-marks.cjs): compact-stop or token-watch has told it to hand off
//     and end its turn, so it stops without the gate demand
//   - skip unless the session's role is "builder" (lib/roles.cjs): Planner
//     sessions, sessions whose record can't be read, sessions with no record,
//     and the review agents (agent_type) are never blocked
//   - skip if the working tree has no uncommitted change outside docs (Markdown,
//     plain text, docs/, .recon/, .claude/)
//   - skip if package.json has no "gate:fast" script
//   - skip if .recon/gate/last.json records a passing gate:fast or gate run
//     (exit 0) for the current tree fingerprint
//   - otherwise block the stop once: "Run `/eng-standard:gate fast` before
//     finishing; CI runs the full gate."
//
// The record isn't protected: a forged one only silences this reminder. CI's
// required Gate check is the wall.
//
// Output: JSON {"decision":"block","reason":...} on stdout when it blocks.
// Exit 0 always.

const fs = require('fs');
const path = require('path');

const TAG = '(hook: eng-standard stop-gate)';
const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disabled']);
const REVIEW_AGENTS = new Set(['eng-standard:critic', 'eng-standard:security-reviewer']);
const RECORD = path.join('.recon', 'gate', 'last.json');
const PASSING_SCRIPTS = new Set(['gate:fast', 'gate']);
const REASON = 'Run `/eng-standard:gate fast` before finishing; CI runs the full gate.';

function allowStop() {
  process.exit(0);
}

function readStdin(callback) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('end', () => callback(buf));
  process.stdin.on('error', () => allowStop());
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main(raw) {
  if (OFF_VALUES.has(String(process.env.ENG_STANDARD_STOP_GATE || '').toLowerCase())) allowStop();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    allowStop();
  }
  if (!payload || typeof payload !== 'object') allowStop();
  if (payload.stop_hook_active === true) allowStop();
  if (typeof payload.agent_type === 'string' && REVIEW_AGENTS.has(payload.agent_type)) allowStop();

  const marks = require('./lib/compact-marks.cjs');
  if (marks.enabled() && marks.isMarked(payload.session_id)) allowStop();
  if (marks.handoff.enabled() && marks.handoff.isMarked(payload.session_id)) allowStop();

  const roles = require('./lib/roles.cjs');
  const role = roles.readRole(payload.session_id);
  if (!role || role.role !== 'builder') allowStop();

  const { repoRoot, treeHash } = require('./lib/tree-hash.cjs');
  const root = repoRoot(process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd());
  if (!root) allowStop();
  const tree = treeHash(root);
  if (!tree || tree.paths.length === 0) allowStop();

  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg || !pkg.scripts || typeof pkg.scripts['gate:fast'] !== 'string') allowStop();

  const record = readJson(path.join(root, RECORD));
  if (record && record.exit === 0 && PASSING_SCRIPTS.has(record.script) && record.tree === tree.hash) allowStop();

  process.stdout.write(JSON.stringify({ decision: 'block', reason: `${REASON} ${TAG}` }));
  process.exit(0);
}

readStdin((raw) => {
  try {
    main(raw);
  } catch {
    allowStop();
  }
});
