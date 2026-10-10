'use strict';
// A cheap, deterministic fingerprint of the working tree's uncommitted non-doc
// changes. The gate script records it beside each gate result
// (.recon/gate/last.json) and the stop gate compares it with the current tree.
//
// Method: SHA-256 over the HEAD commit ID and, for every path git status
// reports as changed against HEAD (staged, unstaged, untracked; both sides of a
// rename), sorted, the path and its working-tree state: the SHA-256 of a file's
// content plus its executable bit, a symlink's target, "dir" (a submodule), or
// "deleted". Doc paths are left out (isDocPath), and so are ignored files.
// The same HEAD and the same changed content give the same hash; any edit to a
// non-doc file, or a new commit, gives a different one. Only changed files are
// read, so the cost grows with the size of the change, not of the repository.
// git runs with --no-optional-locks, so computing the hash never writes .git.
//
// Not a security boundary: anyone who can write .recon/gate/last.json can forge
// a record. The stop gate is a convenience; CI is the wall (STANDARD 2.1).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function git(root, args) {
  return spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot(start) {
  const r = git(start, ['rev-parse', '--show-toplevel']);
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim() || null;
}

// Markdown, plain text, and anything under docs/, .recon/, or .claude/.
function isDocPath(p) {
  return /\.(md|mdx|txt)$/i.test(p) || /^(docs|\.recon|\.claude)\//.test(p);
}

// Paths from `git status --porcelain=v1 -z`, rename sources included.
function changedPaths(root) {
  const r = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (r.error || r.status !== 0) return null;
  const parts = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let k = 0; k < parts.length; k += 1) {
    const entry = parts[k];
    out.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      k += 1; // the next field is the source path
      if (parts[k] !== undefined) out.push(parts[k]);
    }
  }
  return out;
}

function pathState(root, rel) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return 'deleted';
  }
  if (st.isSymbolicLink()) return `link ${fs.readlinkSync(abs)}`;
  if (st.isDirectory()) return 'dir';
  const exec = (st.mode & 0o111) !== 0 ? 'x' : '-';
  return `file ${exec} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
}

// { hash, paths } for the repository at root, or null when git can't answer.
// paths lists the changed non-doc paths; an empty list means nothing to gate.
function treeHash(root) {
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (head.error) return null;
  const changed = changedPaths(root);
  if (!changed) return null;
  const paths = [...new Set(changed.filter((p) => !isDocPath(p)))].sort();
  const h = crypto.createHash('sha256');
  h.update('eng-standard tree v1\n');
  h.update(`head ${head.status === 0 ? head.stdout.trim() : 'none'}\n`);
  for (const p of paths) h.update(`${p}\0${pathState(root, p)}\n`);
  return { hash: h.digest('hex'), paths };
}

module.exports = { repoRoot, isDocPath, changedPaths, treeHash };
