'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixture, runHook, tempDir } = require('./helpers.cjs');

const HOOK = 'web-limit.cjs';
const REASON = /This session has made 3 web lookups \(eng-standard web-limit\)\. Start a background research subagent \(Agent tool, `run_in_background: true`\) with the question and the file to save its findings to, and keep working\. Owner override: `ENG_STANDARD_WEB_LIMIT=off` or a number\./;

function setup() {
  return { data: tempDir('eng-standard-plugin-data-') };
}

function call(s, toolName, overrides = {}, env = {}) {
  return runHook(HOOK, fixture('pretooluse-write', {
    session_id: 's1', tool_name: toolName, tool_input: { url: 'https://example.com' }, ...overrides,
  }), { env: { CLAUDE_PLUGIN_DATA: s.data, ...env } });
}

function assertPasses(r) {
  assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
}

function assertDenied(r, toolName) {
  assert.equal(r.status, 2, `expected exit 2; stderr: ${r.stderr}`);
  assert.match(r.stderr, REASON);
  assert.ok(r.stderr.startsWith(`Blocked: ${toolName}\n`), r.stderr);
}

test('web-limit: the first 3 lookups pass and the 4th and later are denied, WebFetch and WebSearch together', () => {
  const s = setup();
  assertPasses(call(s, 'WebSearch'));
  assertPasses(call(s, 'WebFetch'));
  assertPasses(call(s, 'WebSearch'));
  assertDenied(call(s, 'WebFetch'), 'WebFetch');
  assertDenied(call(s, 'WebSearch'), 'WebSearch');
  assertDenied(call(s, 'WebSearch'), 'WebSearch');
});

test('web-limit: the count is per session', () => {
  const s = setup();
  for (let i = 0; i < 3; i++) assertPasses(call(s, 'WebSearch'));
  assertDenied(call(s, 'WebSearch'), 'WebSearch');
  assertPasses(call(s, 'WebSearch', { session_id: 'other' }));
});

test('web-limit: calls that carry agent_id are neither counted nor denied', () => {
  const s = setup();
  for (let i = 0; i < 10; i++) assertPasses(call(s, 'WebSearch', { agent_id: 'agent-7', agent_type: 'general-purpose' }));
  for (let i = 0; i < 3; i++) assertPasses(call(s, 'WebSearch'));
  assertDenied(call(s, 'WebSearch'), 'WebSearch');
  assertPasses(call(s, 'WebFetch', { agent_id: 'agent-7' }));
});

test('web-limit: ENG_STANDARD_WEB_LIMIT=off turns it off, and a number sets the limit', () => {
  const s = setup();
  for (let i = 0; i < 6; i++) assertPasses(call(s, 'WebSearch', {}, { ENG_STANDARD_WEB_LIMIT: 'off' }));
  for (let i = 0; i < 5; i++) assertPasses(call(s, 'WebSearch', { session_id: 'n' }, { ENG_STANDARD_WEB_LIMIT: '5' }));
  const sixth = call(s, 'WebSearch', { session_id: 'n' }, { ENG_STANDARD_WEB_LIMIT: '5' });
  assert.equal(sixth.status, 2);
  assert.match(sixth.stderr, /This session has made 5 web lookups/);
  const bad = setup();
  for (let i = 0; i < 3; i++) assertPasses(call(bad, 'WebSearch', {}, { ENG_STANDARD_WEB_LIMIT: 'lots' }));
  assertDenied(call(bad, 'WebSearch', {}, { ENG_STANDARD_WEB_LIMIT: 'lots' }), 'WebSearch');
});

test('web-limit: other tools are not counted, and it fails open on bad input or an unwritable counter', () => {
  const s = setup();
  for (let i = 0; i < 6; i++) assertPasses(call(s, 'Bash'));
  assert.ok(!fs.existsSync(path.join(s.data, 'web-lookups')));
  for (const raw of ['', 'not json', '[]', 'null']) assert.equal(runHook(HOOK, raw, { env: { CLAUDE_PLUGIN_DATA: s.data } }).status, 0, raw);
  assertPasses(call(s, 'WebSearch', { session_id: undefined }));
  assertPasses(call(s, 'WebSearch', { hook_event_name: 'PostToolUse' }));
  const blocked = path.join(s.data, 'file');
  fs.writeFileSync(blocked, '');
  for (let i = 0; i < 5; i++) assertPasses(runHook(HOOK, fixture('pretooluse-write', { tool_name: 'WebSearch' }), { env: { CLAUDE_PLUGIN_DATA: blocked } }));
});

test('web-limit: removes counters not touched for 30 days', () => {
  const s = setup();
  const dir = path.join(s.data, 'web-lookups');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old.count');
  fs.writeFileSync(old, '...');
  const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  assertPasses(call(s, 'WebSearch'));
  assert.ok(!fs.existsSync(old));
});
