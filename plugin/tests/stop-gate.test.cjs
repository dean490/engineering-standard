'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fixture, rawFixture, runHook, tempRepo, tempDir, writeFiles, git, hookEnv } = require('./helpers.cjs');

const HOOK = 'stop-gate.cjs';
const RUN_GATE = path.join(__dirname, '..', 'scripts', 'run-gate.cjs');
const REASON = 'Run `/eng-standard:gate fast` before finishing; CI runs the full gate. (hook: eng-standard stop-gate)';

// The gate scripts append to gate-ran.log, so a test can tell whether one ran.
const PASS = 'node -e "require(\'fs\').appendFileSync(\'gate-ran.log\',\'ran\\n\')"';
const FAIL = 'node -e "require(\'fs\').appendFileSync(\'gate-ran.log\',\'ran\\n\');console.log(\'typecheck: 2 errors\');process.exit(1)"';

// A project, a plugin data directory, and a recorded role for session "s1".
function setup({ fast = PASS, role = 'builder', pkg = {} } = {}) {
  const scripts = fast === null ? {} : { 'gate:fast': fast, gate: PASS };
  const dir = tempRepo({
    'package.json': JSON.stringify({ name: 'stop-gate-test', private: true, scripts, ...pkg }, null, 2),
    'src/app.ts': 'export const x = 1;\n',
    'docs/SPEC.md': '# Spec\n',
    '.gitignore': 'gate-ran.log\n.recon/\n',
  });
  const data = tempDir('eng-standard-plugin-data-');
  if (role) {
    fs.mkdirSync(path.join(data, 'session-roles'), { recursive: true });
    fs.writeFileSync(path.join(data, 'session-roles', 's1.json'), JSON.stringify({ session_id: 's1', role, recorded_at: new Date().toISOString() }));
  }
  return { dir, data, env: { CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: data } };
}

function stop(s, overrides = {}, env = {}) {
  return runHook(HOOK, fixture('stop', { session_id: 's1', cwd: s.dir, ...overrides }), { env: { ...s.env, ...env } });
}
function gateRan(s) {
  return fs.existsSync(path.join(s.dir, 'gate-ran.log'));
}
function assertBlocks(r) {
  assert.equal(r.status, 0);
  assert.ok(r.json, `expected a JSON decision, got: ${JSON.stringify(r.stdout)}`);
  assert.equal(r.json.decision, 'block');
  assert.equal(r.json.reason, REASON, 'the reason is fixed text, never command output');
}
function assertAllows(r) {
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
}
// Run the gate the way the /eng-standard:gate skill does.
function runGate(s, arg, env = {}) {
  return spawnSync(process.execPath, [RUN_GATE, arg], { cwd: s.dir, encoding: 'utf8', env: hookEnv(env) });
}
function record(s) {
  return JSON.parse(fs.readFileSync(path.join(s.dir, '.recon', 'gate', 'last.json'), 'utf8'));
}

test('stop-gate CR-1: blocks a Builder with changes and no passing record, and never runs project code', () => {
  const s = setup();
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 2;\n' });
  assertBlocks(stop(s));
  assert.ok(!gateRan(s), 'the hook ran no project script');
  assert.ok(!fs.existsSync(path.join(s.dir, '.recon')), 'the hook wrote nothing');
});

test('stop-gate CR-1: allows the stop once a passing gate:fast record matches the tree, and blocks again after an edit', () => {
  const s = setup();
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 2;\n', 'src/new.ts': 'export const y = 1;\n' });
  const g = runGate(s, 'fast');
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /^evidence: \.recon\/gate\/gate-fast\.txt\nexit=0\n$/);
  assert.ok(gateRan(s));
  assert.equal(record(s).script, 'gate:fast');
  assert.equal(record(s).exit, 0);
  assertAllows(stop(s));
  writeFiles(s.dir, { 'docs/SPEC.md': '# Spec\n\nMore.\n' });
  assertAllows(stop(s), 'a docs edit leaves the record valid');
  writeFiles(s.dir, { 'src/new.ts': 'export const y = 2;\n' });
  assertBlocks(stop(s));
});

test('stop-gate CR-1: a full gate run counts too; a failing one or one for another tree does not', () => {
  const s = setup({ fast: FAIL });
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 2;\n' });
  assert.equal(runGate(s, 'fast').status, 1);
  assert.equal(record(s).exit, 1);
  assertBlocks(stop(s));
  assert.equal(runGate(s, 'step-01').status, 0, 'the full gate script passes');
  assert.equal(record(s).script, 'gate');
  assert.ok(fs.existsSync(path.join(s.dir, '.recon', 'step-01', 'gate.txt')));
  assertAllows(stop(s));
  const forged = { ...record(s), tree: '0'.repeat(64) };
  fs.writeFileSync(path.join(s.dir, '.recon', 'gate', 'last.json'), JSON.stringify(forged));
  assertBlocks(stop(s));
});

test('stop-gate CR-1: a record written by hand with the right fingerprint is accepted (a convenience; CI is the wall)', () => {
  const s = setup();
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 2;\n' });
  const { treeHash } = require('../hooks/lib/tree-hash.cjs');
  const tree = treeHash(fs.realpathSync(s.dir)).hash;
  writeFiles(s.dir, { '.recon/gate/last.json': JSON.stringify({ script: 'gate:fast', exit: 0, tree, time: 'x' }) });
  assertAllows(stop(s));
});

test('stop-gate: only Builder sessions are blocked', () => {
  for (const role of ['planner', null]) {
    const s = setup({ role });
    writeFiles(s.dir, { 'src/app.ts': 'export const x = 2;\n' });
    assertAllows(stop(s));
  }
  const s = setup();
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 2;\n' });
  fs.writeFileSync(path.join(s.data, 'session-roles', 's1.json'), '{ not json');
  assertAllows(stop(s), 'a record that cannot be read counts as a Planner');
  const b = setup();
  writeFiles(b.dir, { 'src/app.ts': 'export const x = 2;\n' });
  for (const agent of ['eng-standard:critic', 'eng-standard:security-reviewer']) assertAllows(stop(b, { agent_type: agent }));
  assertBlocks(stop(b, { agent_type: 'general-purpose' }));
});

test('stop-gate: does nothing without non-doc changes or without a gate:fast script', () => {
  const s = setup();
  assertAllows(stop(s));
  writeFiles(s.dir, { 'docs/SPEC.md': '# Spec\n\nMore.\n', 'NOTES.md': 'x\n', '.claude/settings.json': '{}\n', '.recon/x/y.json': '{}\n' });
  assertAllows(stop(s), 'docs, .claude/, and .recon/ are not code');
  const n = setup({ fast: null });
  writeFiles(n.dir, { 'src/app.ts': 'export const x = 2;\n' });
  assertAllows(stop(n));
});

test('stop-gate CR-24: a renamed file counts as a change on both sides', () => {
  const s = setup();
  git(s.dir, 'mv', 'src/app.ts', 'src/main.ts');
  assertBlocks(stop(s));
  const { treeHash } = require('../hooks/lib/tree-hash.cjs');
  assert.deepEqual(treeHash(fs.realpathSync(s.dir)).paths, ['src/app.ts', 'src/main.ts']);
});

test('stop-gate CR-24: with packageManager pnpm and no pnpm on PATH, the hook still decides without running anything', () => {
  const s = setup({ pkg: { packageManager: 'pnpm@10.34.6' } });
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 2;\n' });
  const bin = path.dirname(process.execPath);
  const gitBin = path.dirname(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim());
  const pathWithoutPnpm = [bin, gitBin, '/usr/bin', '/bin'].join(path.delimiter);
  const r = stop(s, {}, { PATH: pathWithoutPnpm });
  assertBlocks(r);
  assert.ok(!/ENOENT|spawn/.test(r.stdout));
  // The gate script, run without pnpm, records the failure to start; the stop gate still asks for a passing run.
  const g = runGate(s, 'fast', { PATH: pathWithoutPnpm });
  assert.equal(g.status, 2);
  assert.match(g.stdout, /exit=error \(spawn pnpm ENOENT\)/);
  assert.match(String(record(s).exit), /ENOENT/);
  assertBlocks(stop(s, {}, { PATH: pathWithoutPnpm }));
});

test('stop-gate: a stop that is already a stop-hook continuation is not blocked again', () => {
  const s = setup();
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 3;\n' });
  assertAllows(stop(s, { stop_hook_active: true }));
});

test('stop-gate: a project can switch it off', () => {
  const s = setup();
  writeFiles(s.dir, { 'src/app.ts': 'export const x = 4;\n' });
  for (const value of ['off', 'false', '0']) assertAllows(stop(s, {}, { ENG_STANDARD_STOP_GATE: value }));
});

test('stop-gate: fails open on input it cannot parse or outside a repository', () => {
  for (const raw of [rawFixture('malformed.txt'), '', 'null']) assertAllows(runHook(HOOK, raw));
  const s = setup();
  assertAllows(runHook(HOOK, fixture('stop', { session_id: 's1', cwd: '/' }), { env: { ...s.env, CLAUDE_PROJECT_DIR: '/' } }));
});

test('run-gate: rejects a bad argument and reports a missing script', () => {
  const s = setup({ fast: null });
  for (const arg of ['..', 'a/b', '']) assert.equal(runGate(s, arg).status, 2);
  const r = runGate(s, 'fast');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no "gate:fast" script/);
});

test('run-gate: prints only the evidence path and the exit code; the evidence file starts with a result line and keeps the raw output', () => {
  const noisy = 'node -e "for (let i = 1; i <= 500; i++) console.log(\'gate line \' + i); process.exit(1)"';
  const s = setup({ fast: noisy });
  const g = runGate(s, 'fast');
  assert.equal(g.status, 1);
  assert.equal(g.stdout, 'evidence: .recon/gate/gate-fast.txt\nexit=1\n', 'no gate output on stdout');
  const text = fs.readFileSync(path.join(s.dir, '.recon', 'gate', 'gate-fast.txt'), 'utf8');
  assert.equal(text.split('\n')[0], '# result: gate:fast exit=1');
  assert.ok(text.includes('gate line 1\n') && text.includes('gate line 500\n'), 'the raw output follows in full');
  assert.match(text, /\nexit=1\n/);
});
