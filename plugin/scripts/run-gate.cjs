#!/usr/bin/env node
'use strict';
// Run the project's gate script and save its raw output as evidence.
// Usage:
//   node run-gate.cjs <step>   runs "gate" (the full gate) and writes .recon/<step>/gate.txt
//   node run-gate.cjs fast     runs "gate:fast" and writes .recon/gate/gate-fast.txt
// Either way it then writes .recon/gate/last.json, the record the stop gate
// reads: { script, exit, tree, time, evidence }. tree is the fingerprint of the
// uncommitted non-doc changes, taken before the gate starts, so it names the
// tree the gate ran on (lib/tree-hash.cjs). Prints the evidence path and the
// exit code, never the gate's output. The evidence file starts with one result
// line (STANDARD 2.2) and holds the raw output in full. Exits with the gate's
// exit code (2 when it can't be started).
//
// Claude runs this through the /eng-standard:gate skill with Bash, so it and
// the project's scripts run inside the sandbox.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { treeHash } = require('../hooks/lib/tree-hash.cjs');

const arg = process.argv[2];
if (!arg || !/^[A-Za-z0-9._-]{1,64}$/.test(arg) || arg === '.' || arg === '..') {
  process.stderr.write('usage: run-gate.cjs <step> | run-gate.cjs fast  (letters, digits, ".", "_", "-")\n');
  process.exit(2);
}
const fast = arg === 'fast';
const script = fast ? 'gate:fast' : 'gate';

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const inRepo = top.status === 0;
const root = inRepo ? top.stdout.trim() : process.cwd();

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (err) {
  process.stderr.write(`run-gate: can't read package.json in ${root} (${err.message})\n`);
  process.exit(2);
}
if (!pkg.scripts || typeof pkg.scripts[script] !== 'string') {
  process.stderr.write(`run-gate: package.json has no "${script}" script (STANDARD 2.1)\n`);
  process.exit(2);
}

function packageManager() {
  const pm = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  if (['pnpm', 'npm', 'yarn', 'bun'].includes(pm)) return pm;
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

const pm = packageManager();
const tree = inRepo ? treeHash(root) : null;
const relFile = fast ? path.join('.recon', 'gate', 'gate-fast.txt') : path.join('.recon', arg, 'gate.txt');
const relRecord = path.join('.recon', 'gate', 'last.json');
const file = path.join(root, relFile);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `$ ${pm} run ${script}\n# started ${new Date().toISOString()} in ${root}\n# ${script} script: ${pkg.scripts[script]}\n`);
const fd = fs.openSync(file, 'a');

function finish(exit, code) {
  try {
    fs.mkdirSync(path.join(root, '.recon', 'gate'), { recursive: true });
    fs.writeFileSync(path.join(root, relRecord), JSON.stringify({
      script,
      exit,
      tree: tree ? tree.hash : null,
      time: new Date().toISOString(),
      evidence: relFile,
    }, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`run-gate: could not write ${relRecord} (${err.message})\n`);
  }
  process.stdout.write(`evidence: ${relFile}\nexit=${exit}\n`);
  process.exit(code);
}

const child = spawn(pm, ['run', script], {
  cwd: root,
  stdio: ['ignore', fd, fd],
  shell: process.platform === 'win32',
});
// STANDARD 2.2: the evidence file starts with one result line, so a reviewer can check it with head.
function stamp(exit) {
  fs.writeFileSync(file, `# result: ${script} exit=${exit}\n${fs.readFileSync(file, 'utf8')}`);
}

child.on('error', (err) => {
  fs.appendFileSync(file, `\nexit=error (${err.message})\n`);
  stamp(`error (${err.message})`);
  finish(`error (${err.message})`, 2);
});
child.on('close', (code, signal) => {
  const exit = code === null ? `signal ${signal}` : code;
  fs.closeSync(fd);
  fs.appendFileSync(file, `\nexit=${exit}\n# finished ${new Date().toISOString()}\n`);
  stamp(exit);
  finish(exit, typeof code === 'number' ? code : 2);
});
