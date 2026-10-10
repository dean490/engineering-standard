#!/usr/bin/env node
// CI check "Migrations are append-only" (STANDARD 6.2, 6.3): a change may add
// migration files but never modify, delete, or rename one, because a migration
// that has shipped is never edited; a fix is a new migration. Each added
// migration's version (the digits before "_" in <version>_<name>.sql) must also
// be greater than the highest version on the base, so CI replays migrations in
// the order production applies them.
//
// Usage: node scripts/check-migrations-append-only.mjs <base> [<head>]
//   Compares the merge base of <base> and <head> (default HEAD) with <head>,
//   and the added versions with the highest version in <base>.
//   Pull request (guards.yml, the base branch's copy of this script):
//     <base> = the base branch, <head> = the pull request head.
//   Push to main (ci.yml): <base> = the commit before the push, <head> = the
//     commit pushed, so every commit in the push is covered.
// MIGRATIONS_DIR overrides the directory (default supabase/migrations).
// File names come from git's NUL-separated output (-z, core.quotePath=false).
//
// Part of the engineering standard; a protected path. No dependencies.
// Exits 1 on a change other than an in-order addition, 2 when git can't
// compare the commits.

import { execFileSync } from 'node:child_process';

const dir = (process.env.MIGRATIONS_DIR || 'supabase/migrations').replace(/\/+$/, '');
const MIGRATION = /^([0-9]+)_.*\.sql$/;

const [base, head = 'HEAD'] = process.argv.slice(2);
if (!base) {
  console.error('usage: check-migrations-append-only.mjs <base> [<head>]');
  process.exit(2);
}
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// The version of a migration directly in the migrations directory, or null.
function version(path) {
  if (!path.startsWith(`${dir}/`)) return null;
  const rest = path.slice(dir.length + 1);
  if (rest.includes('/')) return null; // the Supabase CLI reads only the top level
  const m = MIGRATION.exec(rest);
  return m ? BigInt(m[1]) : null;
}

let mergeBase;
let changes;
let shipped;
try {
  mergeBase = git('merge-base', base, head).trim();
  const parts = git('diff', '--name-status', '-z', '--no-renames', mergeBase, head, '--', `${dir}/`).split('\0');
  changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ kind: parts[i], file: parts[i + 1] });
  shipped = git('ls-tree', '-r', '-z', '--name-only', base, '--', `${dir}/`).split('\0').filter(Boolean);
} catch (err) {
  console.error(`Could not compare ${base}...${head}; is the history fetched (fetch-depth: 0)? ${err.message}`);
  process.exit(2);
}

const range = `${base}...${head}`;
const problems = [];
const notAdded = changes.filter((c) => c.kind !== 'A');
for (const c of notAdded) problems.push(`${c.kind}\t${c.file}`);

let highest = null;
let highestFile = null;
for (const file of shipped) {
  const v = version(file);
  if (v !== null && (highest === null || v > highest)) { highest = v; highestFile = file; }
}
const added = changes.filter((c) => c.kind === 'A');
for (const c of added) {
  const v = version(c.file);
  if (v !== null && highest !== null && v <= highest) {
    problems.push(`out of order: ${c.file} is not newer than ${highestFile}, already on ${base}`);
  }
}

if (problems.length) {
  console.log(`Shipped migrations were modified or deleted, or a new migration sorts before a shipped one (${range}). Write a new migration with a newer version instead (STANDARD 6.2):`);
  for (const p of problems) console.log(p);
  process.exit(1);
}
console.log(`Migrations are append-only: ${added.length} added, none modified or deleted, all newer than ${highestFile ?? 'anything shipped'} (${range}).`);
