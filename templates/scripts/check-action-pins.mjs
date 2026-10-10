#!/usr/bin/env node
// CI check "Actions pinned to commit SHAs" (STANDARD 5.4): every action a
// workflow or a local action uses is pinned to a full commit SHA, and every
// docker:// action or image to a digest (@sha256:...).
//
// Checks every .yml/.yaml file under .github/workflows/, every action.yml or
// action.yaml under .github/, and every local action a checked file uses
// (uses: ./path), wherever it lives, following local actions into each other.
// Each file is read with yq, so every YAML spelling of a uses: key or value
// counts: a value on the next line, a quoted or escaped key, anchors and
// aliases, flow mappings.
//
// Usage: node scripts/check-action-pins.mjs [--rev <commit>]
//   From the repository root. With --rev, reads the files from that commit
//   instead of the working tree; guards.yml checks a pull request's head this
//   way, with the base branch's copy of this script.
// Needs yq v4 (https://github.com/mikefarah/yq) on PATH, or its path in YQ.
// The ubuntu-24.04 runner image includes it.
// Part of the engineering standard; a protected path. No other dependencies.
// Exits 1 when an action isn't pinned or a file can't be read as YAML, 2 when
// yq or git can't run.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const args = process.argv.slice(2);
const revAt = args.indexOf('--rev');
const rev = revAt >= 0 ? args[revAt + 1] : null;
if (revAt >= 0 && !rev) {
  console.error('usage: check-action-pins.mjs [--rev <commit>]');
  process.exit(2);
}
const YQ = process.env.YQ || 'yq';
const SHA = /^[^@\s]+@[0-9a-f]{40}$/;
const DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const git = (...a) => execFileSync('git', ['-c', 'core.quotePath=false', ...a], { maxBuffer: 256 * 1024 * 1024 });

// Files, from the working tree or from a commit.
const source = rev
  ? {
    list(dir) {
      return git('ls-tree', '-r', '-z', '--name-only', rev, '--', `${dir}/`).toString('utf8').split('\0').filter(Boolean);
    },
    isFile(p) {
      try { return git('cat-file', '-t', `${rev}:${p}`).toString().trim() === 'blob'; } catch { return false; }
    },
    read(p) { return git('cat-file', 'blob', `${rev}:${p}`); },
  }
  : {
    list(dir) {
      const out = [];
      const walk = (d) => {
        let entries;
        try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const p = posix.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) out.push(p);
        }
      };
      walk(dir);
      return out;
    },
    isFile(p) { return existsSync(p) && statSync(p).isFile(); },
    read(p) { return readFileSync(join(p)); },
  };

// Every YAML document in the file, as JSON, with anchors and aliases expanded.
function documents(file) {
  const text = execFileSync(YQ, ['-o=json', '-I=0', 'explode(.)', '-'], { input: source.read(file), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// [value, where] for every "uses" key, and for "image" under "runs" in an action.
function references(node, path = []) {
  const found = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => found.push(...references(v, [...path, i])));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const here = [...path, k];
      if (k === 'uses') found.push([v, here.join('.')]);
      else if (k === 'image' && path[path.length - 1] === 'runs') found.push([v, here.join('.')]);
      else found.push(...references(v, here));
    }
  }
  return found;
}

const isWorkflow = (p) => /^\.github\/workflows\/.+\.ya?ml$/.test(p);
const isAction = (p) => p.startsWith('.github/') && /(^|\/)action\.ya?ml$/.test(p);
let queue;
try {
  queue = source.list('.github').filter((p) => isWorkflow(p) || isAction(p));
} catch (err) {
  console.error(`Could not list .github/ ${rev ? `at ${rev}` : ''}: ${err.message}`);
  process.exit(2);
}
if (queue.length === 0) {
  console.log('No workflow or action files under .github/.');
  process.exit(0);
}

const seen = new Set();
const problems = [];
let count = 0;
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  let docs;
  try {
    docs = documents(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`yq is not installed (${YQ}); install yq v4 or set YQ to its path.`);
      process.exit(2);
    }
    problems.push(`${file}: could not be read as YAML (${String(err.stderr || err.message).trim().split('\n')[0]})`);
    continue;
  }
  for (const doc of docs) {
    for (const [value, where] of references(doc)) {
      count += 1;
      if (typeof value !== 'string') { problems.push(`${file}: ${where} is not a single string: ${JSON.stringify(value)}`); continue; }
      const v = value.trim();
      if (where.endsWith('.image') && !v.startsWith('docker://')) continue; // a Dockerfile in the action itself
      if (v.startsWith('./')) {
        // A local action or reusable workflow, relative to the repository root.
        const target = posix.normalize(v.replace(/@.*$/, ''));
        const candidates = /\.ya?ml$/.test(target) ? [target] : [posix.join(target, 'action.yml'), posix.join(target, 'action.yaml')];
        const hit = candidates.find((c) => source.isFile(c));
        if (hit) queue.push(hit);
        else problems.push(`${file}: ${where}: local action ${v} not found (looked for ${candidates.join(', ')})`);
        continue;
      }
      if (v.startsWith('docker://') ? !DIGEST.test(v) : !SHA.test(v)) problems.push(`${file}: ${where}: ${v}`);
    }
  }
}

if (problems.length) {
  console.log('These actions are not pinned to a full commit SHA (or a docker:// image to a sha256 digest), or could not be read:');
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
console.log(`Every action is pinned (${count} references in ${seen.size} files${rev ? ` at ${rev}` : ''}).`);
