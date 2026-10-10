#!/usr/bin/env node
// CI check "Sensitive change" (STANDARD 3.5, 9.2): on a pull request, fail
// when the change touches what the other checks and guards rely on, and list it
// in the job summary, so the Owner reads that part of the diff and merges it
// deliberately with an admin override:
//   - the "scripts" of any package.json (CI runs them as the gate)
//   - test-runner, TypeScript, and lint configuration at any depth, which
//     decide what the gate's steps check: vitest.config.*, vitest.workspace.*,
//     playwright.config.*, jest.config.*, tsconfig*.json, eslint.config.*,
//     .eslintrc*
//   - supabase/config.toml (the schemas the row-level security check covers)
//   - .github/** (workflows, local actions, Dependabot) and .githooks/**
//   - .claude/settings.json (agent permissions and sandbox)
//   - .gitleaks* (secret-scan configuration and ignore list), and any added
//     line containing gitleaks:allow
//   - pnpm-workspace.yaml (supply-chain settings)
//   - the CI check scripts copied from the standard's templates/scripts/
// next.config.* is not on the list: the gate runs typecheck and lint as their
// own steps (pnpm run typecheck, pnpm run lint), so next.config can't switch
// either off.
//
// Usage: node scripts/check-sensitive-change.mjs <base> [<head>]
//   Compares the merge base of <base> and <head> (default HEAD) with <head>.
//   On a pull request, guards.yml runs the base branch's copy of this script
//   against the pull request head, so a pull request can't change the check
//   that judges it.
// File names come from git's NUL-separated output (-z, core.quotePath=false),
// so a path with non-ASCII or special characters is read as it is.
// Writes a summary to $GITHUB_STEP_SUMMARY when it is set.
// Part of the engineering standard; a protected path. No dependencies.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const CHECK_SCRIPTS = new Set([
  'scripts/check-action-pins.mjs', 'scripts/check-client-bundle.mjs', 'scripts/check-migrations-append-only.mjs',
  'scripts/check-release-age.mjs', 'scripts/check-rls.mjs', 'scripts/check-sensitive-change.mjs',
  'scripts/check-test-integrity.mjs',
]);
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const SENSITIVE = [
  [(p) => p.startsWith('.github/'), 'GitHub configuration'],
  [(p) => p.startsWith('.githooks/'), 'git hook'],
  [(p) => p === '.claude/settings.json', 'agent settings'],
  [(p) => /^\.gitleaks/.test(p), 'secret-scan configuration'],
  [(p) => p === 'pnpm-workspace.yaml', 'supply-chain settings'],
  [(p) => CHECK_SCRIPTS.has(p), 'CI check script'],
  [(p) => /^(vitest\.config\.|vitest\.workspace\.|playwright\.config\.|jest\.config\.)/.test(basename(p)), 'test-runner configuration'],
  [(p) => /^tsconfig[^/]*\.json$/.test(basename(p)), 'TypeScript configuration'],
  [(p) => /^(eslint\.config\.|\.eslintrc)/.test(basename(p)), 'lint configuration'],
  [(p) => /(^|\/)supabase\/config\.toml$/.test(p), 'Supabase configuration'],
];

const [base, head = 'HEAD'] = process.argv.slice(2);
if (!base) {
  console.error('usage: check-sensitive-change.mjs <base> [<head>]');
  process.exit(2);
}
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// git diff --name-status -z --no-renames: "<status>\0<path>\0" per file.
function nameStatus(from, to) {
  const parts = git('diff', '--name-status', '-z', '--no-renames', from, to).split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ kind: parts[i], file: parts[i + 1] });
  return out;
}

// Lines the change adds to one file, read after the first hunk header.
function addedLines(from, to, file) {
  const patch = git('diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', from, to, '--', file);
  const lines = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (inHunk && line.startsWith('+')) lines.push(line.slice(1));
  }
  return lines;
}

let mergeBase;
let changes;
let allowCandidates;
try {
  mergeBase = git('merge-base', base, head).trim();
  changes = nameStatus(mergeBase, head);
  // Files whose diff adds or removes a line mentioning gitleaks:allow.
  allowCandidates = git('diff', '--name-only', '-z', '--no-renames', '-G', 'gitleaks:allow', mergeBase, head).split('\0').filter(Boolean);
} catch (err) {
  console.error(`Could not compare ${base}...${head}; is the history fetched (fetch-depth: 0)? ${err.message}`);
  process.exit(2);
}

function scriptsAt(rev, file) {
  try {
    const pkg = JSON.parse(git('show', `${rev}:${file}`));
    const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    return JSON.stringify(Object.keys(scripts).sort().map((k) => [k, scripts[k]]));
  } catch {
    return '[]'; // absent, or not JSON: no scripts
  }
}

const findings = [];
for (const { kind, file } of changes) {
  const match = SENSITIVE.find(([test]) => test(file));
  if (match) findings.push(`${match[1]}: ${kind} ${file}`);
  if (basename(file) === 'package.json') {
    if (scriptsAt(mergeBase, file) !== scriptsAt(head, file)) findings.push(`package.json scripts: ${file}`);
  }
}
for (const file of allowCandidates) {
  if (addedLines(mergeBase, head, file).some((line) => line.includes('gitleaks:allow'))) findings.push(`gitleaks:allow added: ${file}`);
}

const summary = findings.length
  ? `### Sensitive change: Owner review needed\n\nThis pull request changes what the gate, the guards, or the secret scan rely on:\n\n${findings.map((f) => `- ${f}`).join('\n')}\n\nThe Owner reads these parts of the diff and merges with an admin override (docs/ADOPTING.md in the engineering-standard repository).\n`
  : '### Sensitive change: none\n\nNo change to package.json scripts, test-runner, TypeScript, or lint configuration, supabase/config.toml, .github/, .githooks/, .claude/settings.json, .gitleaks*, pnpm-workspace.yaml, or the CI check scripts.\n';
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exit(findings.length ? 1 : 0);
