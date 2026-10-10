#!/usr/bin/env node
'use strict';
// PreToolUse: protected paths (STANDARD 3.5, 6.2). Matches Edit|Write|NotebookEdit.
//
// Blocks Claude's file tools from changing:
//   - a file under supabase/migrations/ that exists on the base branch (shipped
//     migrations are never edited; a fix is a new migration). The base is the
//     merge base of HEAD and origin/main, or local main when there is no
//     origin/main, or HEAD itself when the current branch is main or there is
//     no main. A migration committed earlier on the step branch isn't shipped
//     yet, so the Builder can still fix it.
//   - the lockfile (pnpm-lock.yaml and the other package-manager lockfiles); the
//     package manager still updates it through Bash
//   - anything under .github/ (workflows, local actions, Dependabot) or .githooks/
//   - the secret-scan configuration: .gitleaks.toml and .gitleaksignore
//   - the standard's CI check scripts in scripts/ (copied from templates/scripts/)
//   - .claude/settings.json
// unless the file's repo-relative path is listed in .recon/current-brief-paths.txt,
// the current brief's explicit permission list (one path per line, # comments).
// For .github/, .githooks/, and the gitleaks files the list doesn't help: the
// template's Edit deny rules block them first, so only the Owner changes them.
//
// A guardrail: it sees only Claude's file tools, not shell commands. The walls
// behind it (STANDARD 3.5, 6.2): the sandbox's write block on .github/,
// .githooks/, and the gitleaks files (templates/.claude/settings.json), and the
// CI checks "Migrations are append-only" and "Sensitive change", which run
// from the base branch (guards.yml) and which the Owner's merge depends on.
//
// The permission list itself can never be edited through these tools, so a
// session can't grant itself permission. The Owner writes it outside the session.
//
// Exit 2 = deny (reason on stderr). Exit 0 = no decision.
// Fails closed: unparseable input, a missing path, or a git error on a
// migration path is denied.

let common;
try {
  common = require('./lib/common.cjs');
} catch (err) {
  process.stderr.write(`protect-paths: failed to load helpers (${err.message}); blocking (fail closed).\n`);
  process.exit(2);
}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TAG = '(guard: eng-standard protect-paths)';
const LIST_FILE = '.recon/current-brief-paths.txt';
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);
// The CI check scripts templates/scripts/ ships, at their path in a project.
const CHECK_SCRIPTS = new Set([
  'scripts/check-action-pins.mjs', 'scripts/check-client-bundle.mjs', 'scripts/check-migrations-append-only.mjs',
  'scripts/check-release-age.mjs', 'scripts/check-rls.mjs', 'scripts/check-sensitive-change.mjs',
  'scripts/check-test-integrity.mjs',
]);
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s) => (FOLD ? s.toLowerCase() : s);

// Walk up from dir to the nearest directory holding .git (a directory, or a
// file in a linked worktree).
function findRepoRoot(dir) {
  let current = dir;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function classify(rel) {
  const r = fold(rel);
  if (r === fold(LIST_FILE)) return 'list';
  if (LOCKFILES.has(path.posix.basename(r))) return 'lockfile';
  if (r.startsWith('.github/workflows/')) return 'workflow';
  if (r.startsWith('.github/')) return 'github';
  if (r.startsWith('.githooks/')) return 'githook';
  if (r === '.gitleaks.toml' || r === '.gitleaksignore') return 'gitleaks';
  if (CHECK_SCRIPTS.has(r)) return 'check-script';
  if (r === '.claude/settings.json') return 'settings';
  if (/(^|\/)supabase\/migrations\//.test(r)) return 'migration';
  return null;
}

// The commit that counts as shipped: { rev, label } | 'none' (no commits yet) | 'unknown'.
function shippedBase(repoRoot) {
  const run = (...args) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  const head = run('rev-parse', '--verify', '-q', 'HEAD');
  if (head.error) return 'unknown';
  if (head.status === 1) return 'none'; // no commits yet: nothing is shipped
  if (head.status !== 0) return 'unknown';
  const branch = run('symbolic-ref', '--short', '-q', 'HEAD');
  if (branch.error) return 'unknown';
  if (branch.status === 0 && branch.stdout.trim() === 'main') return { rev: 'HEAD', label: 'main (HEAD)' };
  for (const [ref, label] of [['refs/remotes/origin/main', 'origin/main'], ['refs/heads/main', 'main']]) {
    const exists = run('rev-parse', '--verify', '-q', ref);
    if (exists.error) return 'unknown';
    if (exists.status !== 0) continue;
    const mb = run('merge-base', 'HEAD', ref);
    if (mb.error || mb.status !== 0) return 'unknown';
    return { rev: mb.stdout.trim(), label: `the merge base with ${label}` };
  }
  return { rev: 'HEAD', label: 'HEAD (no main branch)' };
}

// 'yes' | 'no' | 'unknown', and the base it was judged against.
function shippedMigration(repoRoot, rel) {
  const base = shippedBase(repoRoot);
  if (base === 'none') return { answer: 'no' };
  if (base === 'unknown') return { answer: 'unknown' };
  const cat = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${base.rev}:${rel}`], { encoding: 'utf8' });
  if (cat.error) return { answer: 'unknown' };
  return { answer: cat.status === 0 ? 'yes' : 'no', label: base.label };
}

function listedPaths(roots) {
  const listed = new Set();
  for (const root of roots) {
    let text;
    try {
      text = fs.readFileSync(path.join(root, LIST_FILE), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const entry = line.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      if (entry && !entry.startsWith('#')) listed.add(fold(entry));
    }
  }
  return listed;
}

const KIND_TEXT = {
  lockfile: 'the lockfile (change it only through the package manager)',
  workflow: 'a CI workflow',
  github: 'GitHub configuration (a local action, Dependabot, or another file under .github/)',
  githook: 'a git hook (the pre-commit secret scan lives here)',
  gitleaks: 'the secret-scan configuration',
  'check-script': 'a CI check script from the engineering standard',
  settings: 'the committed agent settings',
  migration: 'a shipped migration',
};

function decide(payload) {
  const ti = payload.tool_input;
  if (ti === null || typeof ti !== 'object') return `Blocked: hook input has no tool_input; blocking (fail closed). ${TAG}`;
  const target = ti.file_path || ti.notebook_path;
  if (typeof target !== 'string' || target.length === 0) {
    return `Blocked: ${payload.tool_name || 'edit'} call without a file path; blocking (fail closed). ${TAG}`;
  }

  const base = payload.cwd || common.projectDir(payload);
  const realTarget = common.realpathLoose(path.isAbsolute(target) ? target : path.resolve(base, target));
  const projectRoot = common.realpathLoose(common.projectDir(payload));
  let root = findRepoRoot(path.dirname(realTarget));
  if (!root && common.isInside(realTarget, projectRoot)) root = projectRoot;
  if (!root) return null; // not in a repository or the project

  const rel = common.toPosix(path.relative(root, realTarget));
  const kind = classify(rel);
  if (!kind) return null;

  if (kind === 'list') {
    return (
      `Blocked: ${LIST_FILE} is the current brief's permission list. A session can't edit it; ` +
      `the Owner writes it outside the session. ${TAG}`
    );
  }

  let shippedOn = '';
  if (kind === 'migration') {
    const shipped = shippedMigration(root, rel);
    if (shipped.answer === 'no') return null; // a new migration, or one not yet on the base branch
    if (shipped.answer === 'unknown') {
      return `Blocked: could not ask git whether ${rel} is a shipped migration; blocking (fail closed). ${TAG}`;
    }
    shippedOn = ` (it exists in ${shipped.label})`;
  }

  if (listedPaths([...new Set([projectRoot, root])]).has(fold(rel))) return null;

  const listHint = `the Owner lists "${rel}" in ${LIST_FILE}`;
  const fix =
    kind === 'migration'
      ? `Shipped migrations are never edited (STANDARD 6.2): write a new migration instead. ` +
        `Only a brief that names this file may change it: ${listHint}.`
      : `Edit it only when the current brief names it: ${listHint}.`;
  return `Blocked: ${rel} is ${KIND_TEXT[kind]}${shippedOn}, a protected path (STANDARD 3.5). ${fix} ${TAG}`;
}

common.readStdin((err, raw) => {
  if (err) common.block(`Blocked: could not read hook input (${err.message}); blocking (fail closed). ${TAG}`);
  let payload;
  try {
    payload = common.parsePayload(raw);
  } catch (e) {
    common.block(`Blocked: could not parse hook input (${e.message}); blocking (fail closed). ${TAG}`);
  }
  let reason;
  try {
    reason = decide(payload);
  } catch (e) {
    reason = `Blocked: protected-path check failed (${e.message}); blocking (fail closed). ${TAG}`;
  }
  if (reason) common.block(reason);
  common.allow();
});
