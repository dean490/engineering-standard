'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixture, runHook, tempDir } = require('./helpers.cjs');

const HOOK = 'brief-check.cjs';
const DENIAL = /A brief can be approved only when it names one layer \(server, screens, docs, or tooling\), its model, and its effort \(eng-standard brief-check, STANDARD 1\.9, 10\.6\)\. Add the missing line and write again\. Owner override: `ENG_STANDARD_BRIEF_CHECK=off`\./;

const COMPLETE = [
  '# Brief 1: example',
  '',
  '**Status:** approved (Owner, Oct 23)',
  '**Layer:** tooling (plugin hooks and standard text)',
  '**Model:** Sonnet 5.5, effort high',
  '',
  'Body.',
  '',
].join('\n');

function setup() {
  const home = tempDir('eng-standard-home-');
  const dir = path.join(home, '.claude', 'plans', 'proj');
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir, file: path.join(dir, 'BRIEF-1-example.md') };
}

function write(s, content, file = s.file, env = {}) {
  return runHook(HOOK, fixture('pretooluse-write', { cwd: s.home, tool_input: { file_path: file, content } }), { env: { HOME: s.home, ...env } });
}

function edit(s, oldString, newString, extra = {}) {
  return runHook(HOOK, fixture('pretooluse-edit', {
    cwd: s.home, tool_input: { file_path: s.file, old_string: oldString, new_string: newString, replace_all: false, ...extra },
  }), { env: { HOME: s.home } });
}

function assertDenied(r, lacks) {
  assert.equal(r.status, 2, `expected exit 2; stderr: ${r.stderr}`);
  assert.match(r.stderr, DENIAL);
  assert.match(r.stderr, /guard: eng-standard brief-check/);
  if (lacks) assert.match(r.stderr, lacks);
}

function assertPasses(r) {
  assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
}

test('brief-check: passes a complete approved brief, with effort on the Model line or an Effort line', () => {
  const s = setup();
  assertPasses(write(s, COMPLETE));
  assertPasses(write(s, COMPLETE.replace(', effort high', '') + '**Effort:** high\n'));
  for (const layer of ['server', 'screens', 'docs', 'tooling']) {
    assertPasses(write(s, COMPLETE.replace('tooling (plugin hooks and standard text)', layer)));
  }
});

test('brief-check: denies an approved brief missing each required line', () => {
  const s = setup();
  assertDenied(write(s, COMPLETE.replace(/\*\*Layer:\*\*.*\n/, '')), /a \*\*Layer:\*\* line/);
  assertDenied(write(s, COMPLETE.replace('tooling (plugin hooks and standard text)', 'server and screens')), /exactly one layer.*server, screens/);
  assertDenied(write(s, COMPLETE.replace('tooling (plugin hooks and standard text)', 'backend')), /exactly one layer.*none/);
  assertDenied(write(s, COMPLETE.replace(/\*\*Model:\*\*.*\n/, '')), /a \*\*Model:\*\* line/);
  assertDenied(write(s, COMPLETE.replace(', effort high', '')), /an effort/);
});

test('brief-check: a brief not marked approved is ignored, and so is any other file', () => {
  const s = setup();
  assertPasses(write(s, '# Draft\n\n**Status:** draft\n'));
  assertPasses(write(s, '# Draft\n\nNothing yet.\n'));
  assertPasses(write(s, '**Status:** approved\n', path.join(s.dir, 'NOTES.md')));
  assertPasses(write(s, '**Status:** approved\n', path.join(s.home, 'BRIEF-2.md')));
});

test('brief-check: Edit is judged on the text after the edit', () => {
  const s = setup();
  fs.writeFileSync(s.file, COMPLETE.replace('approved (Owner, Oct 23)', 'draft').replace(/\*\*Layer:\*\*.*\n/, ''));
  assertDenied(edit(s, '**Status:** draft', '**Status:** approved'), /a \*\*Layer:\*\* line/);
  assertPasses(edit(s, '**Status:** draft', '**Status:** approved\n**Layer:** docs'));
  fs.writeFileSync(s.file, COMPLETE);
  assertDenied(edit(s, '**Model:** Sonnet 5.5, effort high', ''), /a \*\*Model:\*\* line/);
  assertPasses(edit(s, 'Body.', 'Other body.'));
  assertPasses(edit(s, 'text that is not in the file', 'x'));
});

test('brief-check: ENG_STANDARD_BRIEF_CHECK=off turns it off, and unreadable input never blocks', () => {
  const s = setup();
  assertPasses(write(s, '**Status:** approved\n', s.file, { ENG_STANDARD_BRIEF_CHECK: 'off' }));
  assertDenied(write(s, '**Status:** approved\n'));
  const r = runHook(HOOK, 'not json', { env: { HOME: s.home } });
  assert.equal(r.status, 0);
});
