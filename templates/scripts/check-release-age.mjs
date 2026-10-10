#!/usr/bin/env node
// CI check "Release age" (STANDARD 5.2): on a pull request, fail when the
// change adds a package version to pnpm-lock.yaml that was published more
// recently than the base branch's minimumReleaseAge (pnpm-workspace.yaml,
// minutes) and isn't in its minimumReleaseAgeExclude.
//
// pnpm applies minimumReleaseAge when it resolves a version, on the machine
// that writes the lockfile; CI's frozen install on pnpm 10 resolves nothing, so
// this check re-applies the rule to what the pull request adds. Dependabot's
// 7-day cooldown (.github/dependabot.yml) keeps its own pull requests passing.
//
// Usage: node scripts/check-release-age.mjs <base> [<head>]
//   Reads the settings from <base>'s pnpm-workspace.yaml, and compares
//   <head>'s pnpm-lock.yaml (default HEAD) with the lockfile at the merge base
//   of <base> and <head>. guards.yml runs the base branch's copy of this
//   script against the pull request head. It reads files with git and the
//   registry over HTTPS, and runs nothing from the pull request.
//   NPM_REGISTRY: the registry to ask (default https://registry.npmjs.org).
//   REGISTRY_DATA=<dir>: read recorded registry responses instead, one
//     <dir>/<name>.json per package (a scoped name's "/" written as "%2f").
//   NOW=<ISO time>: the time to measure ages from, for testing.
// Writes a summary to $GITHUB_STEP_SUMMARY when it is set.
// Part of the engineering standard; a protected path. No dependencies.
// Exits 1 when a version is too new or isn't from the registry, 2 when the
// lockfile, the settings, or the registry can't be read.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [base, head = 'HEAD'] = process.argv.slice(2);
if (!base) {
  console.error('usage: check-release-age.mjs <base> [<head>]');
  process.exit(2);
}
const REGISTRY = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const NOW = process.env.NOW ? Date.parse(process.env.NOW) : Date.now();
const LOCKFILE = 'pnpm-lock.yaml';
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const fail = (message) => {
  console.error(message);
  process.exit(2);
};
// A file at a commit, or null when it doesn't exist there.
function show(rev, file) {
  try {
    git('cat-file', '-e', `${rev}:${file}`);
  } catch {
    return null;
  }
  return git('cat-file', 'blob', `${rev}:${file}`);
}
const unquote = (s) => {
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s);
  return s;
};

// The "packages:" keys of a lockfile v9 (<name>@<version>), as {name, version}.
// pnpm writes the file, so its shape is regular; anything else fails closed.
function lockfilePackages(text, where) {
  if (text === null) return [];
  const version = /^lockfileVersion:\s*['"]?([0-9.]+)['"]?\s*$/m.exec(text);
  if (!version || !version[1].startsWith('9')) fail(`${where}: lockfileVersion ${version ? version[1] : '(none)'} is not 9.x, the format pnpm 10 writes.`);
  const out = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inPackages = line.trim() === 'packages:'; continue; }
    if (!inPackages || !/^ {2}\S/.test(line)) continue;
    const m = /^ {2}(.+):\s*(\{\})?\s*$/.exec(line);
    if (!m) fail(`${where}: can't read the packages key in line ${JSON.stringify(line)}.`);
    const id = unquote(m[1]);
    const at = id.indexOf('@', 1); // a name holds no "@" after a scope's leading one
    if (at <= 0) fail(`${where}: can't read the package id ${JSON.stringify(id)}.`);
    out.push({ name: id.slice(0, at), version: id.slice(at + 1) });
  }
  return out;
}

// minimumReleaseAge and minimumReleaseAgeExclude from pnpm-workspace.yaml.
function settings(text) {
  if (text === null) fail(`${base} has no pnpm-workspace.yaml, so there is no minimumReleaseAge to check against.`);
  const age = /^minimumReleaseAge:\s*(\d+)\s*(#.*)?$/m.exec(text);
  if (!age) fail(`${base}'s pnpm-workspace.yaml has no minimumReleaseAge (in minutes).`);
  const exclude = [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^minimumReleaseAgeExclude:/.test(l));
  if (start >= 0) {
    const inline = lines[start].replace(/^minimumReleaseAgeExclude:\s*/, '').replace(/\s+#.*$/, '').trim();
    if (inline.startsWith('[')) {
      if (!inline.endsWith(']')) fail('minimumReleaseAgeExclude: write the list on one line ([a, b]) or as "- item" lines.');
      for (const item of inline.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)) exclude.push(unquote(item));
    } else if (inline !== '') {
      fail(`minimumReleaseAgeExclude: unexpected value ${JSON.stringify(inline)}.`);
    } else {
      for (const l of lines.slice(start + 1)) {
        if (/^\S/.test(l)) break;
        const item = /^\s*-\s*(.+?)\s*(#.*)?$/.exec(l);
        if (item) exclude.push(unquote(item[1]));
      }
    }
  }
  return { minutes: Number(age[1]), exclude };
}

// pnpm's minimumReleaseAgeExclude entries: a name, a name pattern with *
// (@myorg/*), or name@version, with versions joined by ||.
function excluded(name, version, entries) {
  return entries.some((entry) => {
    const at = entry.lastIndexOf('@');
    const pattern = at > 0 ? entry.slice(0, at) : entry;
    const versions = at > 0 ? entry.slice(at + 1).split('||').map((v) => v.trim()) : null;
    const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
    return re.test(name) && (versions === null || versions.includes(version));
  });
}

async function publishTimes(name) {
  const file = name.replace('/', '%2f');
  if (process.env.REGISTRY_DATA) return JSON.parse(readFileSync(join(process.env.REGISTRY_DATA, `${file}.json`), 'utf8')).time || {};
  const res = await fetch(`${REGISTRY}/${file}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${REGISTRY}/${file}: HTTP ${res.status}`);
  return (await res.json()).time || {};
}

let mergeBase;
let rules;
let before;
let after;
try {
  mergeBase = git('merge-base', base, head).trim();
  rules = settings(show(base, 'pnpm-workspace.yaml'));
  before = lockfilePackages(show(mergeBase, LOCKFILE), `${LOCKFILE} at the merge base`);
  after = lockfilePackages(show(head, LOCKFILE), `${LOCKFILE} at ${head}`);
} catch (err) {
  fail(`Could not compare ${base}...${head}; is the history fetched (fetch-depth: 0)? ${err.message}`);
}

const known = new Set(before.map((p) => `${p.name}@${p.version}`));
const added = after.filter((p) => !known.has(`${p.name}@${p.version}`));
const problems = [];
const checked = [];
for (const { name, version } of added) {
  if (excluded(name, version, rules.exclude)) { checked.push(`${name}@${version}: excluded by minimumReleaseAgeExclude`); continue; }
  if (!SEMVER.test(version)) { problems.push(`${name}@${version}: not a registry version, so its age can't be checked`); continue; }
  let time;
  try {
    time = (await publishTimes(name))[version];
  } catch (err) {
    fail(`Could not read the publish time of ${name}@${version}: ${err.message}`);
  }
  if (!time || Number.isNaN(Date.parse(time))) { problems.push(`${name}@${version}: the registry has no publish time for it`); continue; }
  const minutes = Math.floor((NOW - Date.parse(time)) / 60000);
  const age = `published ${time}, ${(minutes / 1440).toFixed(1)} days ago`;
  if (minutes < rules.minutes) problems.push(`${name}@${version}: ${age}, younger than ${rules.minutes} minutes`);
  else checked.push(`${name}@${version}: ${age}`);
}

const summary = problems.length
  ? `### Release age: failed\n\nThis pull request adds package versions younger than minimumReleaseAge (${rules.minutes} minutes) on ${base}, or that the check can't date (STANDARD 5.2):\n\n${problems.map((p) => `- ${p}`).join('\n')}\n\nWait until they are old enough, or list a security fix in minimumReleaseAgeExclude with the reason in docs/DECISIONS.md.\n`
  : `### Release age: passed\n\n${added.length} package version(s) added to ${LOCKFILE}, none younger than ${rules.minutes} minutes.\n${checked.map((c) => `\n- ${c}`).join('')}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exit(problems.length ? 1 : 0);
