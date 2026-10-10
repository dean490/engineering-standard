#!/usr/bin/env node
// CI check "Test integrity" (STANDARD 2.4): on a pull request, fail when the
// change deletes a test file, moves one out of the tests, or adds a line to a
// test file that skips, focuses, postpones, or inverts tests:
//   - any .only, .skip, .todo, or .fails member access, with or without a
//     following "(": it.only(...), describe.skip.each(...), it.skip.concurrent,
//     test.fails(...), and the same with ["only"] brackets
//   - runIf( and skipIf(, which run a test only under a condition
//   - xit( xdescribe( xtest( fit( fdescribe( ftest(
// Tests are never deleted or loosened to make a change pass.
//
// When a change really needs one of these, the Owner reads why, records it in
// the pull request, and merges with an admin override (docs/ADOPTING.md).
//
// Usage: node scripts/check-test-integrity.mjs <base> [<head>]
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

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|^supabase\/tests\//;
const WEAKENING = new RegExp([
  String.raw`\.\s*(only|skip|todo|fails)\b`,
  String.raw`\[\s*['"\x60](only|skip|todo|fails)['"\x60]\s*\]`,
  String.raw`\b(runIf|skipIf)\s*\(`,
  String.raw`(^|[^\w.$])(x|f)(it|describe|test)\s*\(`,
].join('|'));

const [base, head = 'HEAD'] = process.argv.slice(2);
if (!base) {
  console.error('usage: check-test-integrity.mjs <base> [<head>]');
  process.exit(2);
}
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// git diff --name-status -z: "<status>\0<path>\0", or for a rename or copy
// "<status>\0<from>\0<to>\0".
function nameStatus(from, to, extra = []) {
  const parts = git('diff', '--name-status', '-z', ...extra, from, to).split('\0');
  const out = [];
  for (let i = 0; i < parts.length - 1;) {
    const kind = parts[i];
    if (kind.startsWith('R') || kind.startsWith('C')) {
      out.push({ kind, from: parts[i + 1], to: parts[i + 2] });
      i += 3;
    } else {
      out.push({ kind, from: parts[i + 1], to: parts[i + 1] });
      i += 2;
    }
  }
  return out;
}

// Lines the change adds to one file. Only lines after the first hunk header
// count, so the file name in the "+++" header is never read.
function addedLines(from, to, paths) {
  const patch = git('diff', '--unified=0', '--no-color', '--no-ext-diff', '--find-renames', from, to, '--', ...paths);
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
try {
  mergeBase = git('merge-base', base, head).trim();
  changes = nameStatus(mergeBase, head, ['--find-renames']);
} catch (err) {
  console.error(`Could not compare ${base}...${head}; is the history fetched (fetch-depth: 0)? ${err.message}`);
  process.exit(2);
}

const problems = [];
for (const { kind, from, to } of changes) {
  if (kind === 'D' && TEST_FILE.test(from)) problems.push(`deleted test file: ${from}`);
  if (kind.startsWith('R') && TEST_FILE.test(from) && !TEST_FILE.test(to)) problems.push(`test file moved out of the tests: ${from} -> ${to}`);
  if (kind === 'D' || !TEST_FILE.test(to)) continue;
  const paths = kind.startsWith('R') ? [from, to] : [to];
  for (const line of addedLines(mergeBase, head, paths)) {
    if (WEAKENING.test(line)) problems.push(`${to}: adds "${line.trim()}"`);
  }
}

const summary = problems.length
  ? `### Test integrity: failed\n\nThis change deletes or loosens tests (STANDARD 2.4):\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\nThe Owner merges a change like this only with an admin override, after reading why, with the reason recorded in the pull request.\n`
  : '### Test integrity: passed\n\nNo test file deleted, and no skipped, focused, postponed, or inverted test added.\n';
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exit(problems.length ? 1 : 0);
