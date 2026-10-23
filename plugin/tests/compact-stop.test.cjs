'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixture, runHook, tempRepo, tempDir, writeFiles } = require('./helpers.cjs');

const HOOK = 'compact-stop.cjs';
const TAG = 'hook: eng-standard compact-stop';
const INSTRUCTION = /This session compacted, so it stops here \(eng-standard compact-stop\)\. Write where you stand into `\.recon\/<step>\/INDEX\.md`/;
const SESSION = 's1';

// A project, a plugin data directory, and a HOME whose ~/.claude/plans exists.
function setup() {
  const project = tempRepo({ 'src/app.ts': 'export {};\n' });
  const data = tempDir('eng-standard-plugin-data-');
  const home = tempDir('eng-standard-home-');
  fs.mkdirSync(path.join(home, '.claude', 'plans'), { recursive: true });
  return { project, data, home, env: { CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: data, HOME: home } };
}

function markerFile(s, sessionId = SESSION) {
  return path.join(s.data, 'compacted', `${sessionId}.json`);
}

function preCompact(s, trigger, overrides = {}, env = {}) {
  return runHook(HOOK, {
    session_id: SESSION, transcript_path: '/x/t.jsonl', cwd: s.project,
    hook_event_name: 'PreCompact', trigger, custom_instructions: null, ...overrides,
  }, { env: { ...s.env, ...env } });
}

function sessionStart(s, source, overrides = {}, env = {}) {
  return runHook(HOOK, {
    session_id: SESSION, transcript_path: '/x/t.jsonl', cwd: s.project,
    hook_event_name: 'SessionStart', source, ...overrides,
  }, { env: { ...s.env, ...env } });
}

function call(s, toolName, toolInput = {}, overrides = {}, env = {}) {
  return runHook(HOOK, fixture('pretooluse-write', {
    session_id: SESSION, cwd: s.project, tool_name: toolName, tool_input: toolInput, ...overrides,
  }), { env: { ...s.env, ...env } });
}

function stop(s, env = {}) {
  return runHook('stop-gate.cjs', fixture('stop', { session_id: SESSION, cwd: s.project }), { env: { ...s.env, ...env } });
}

function mark(s) {
  const r = preCompact(s, 'auto');
  assert.equal(r.status, 0);
  assert.ok(fs.existsSync(markerFile(s)), 'auto compaction should mark the session');
}

function assertDenied(r, toolName) {
  assert.equal(r.status, 2, `expected exit 2; stderr: ${r.stderr}`);
  assert.match(r.stderr, INSTRUCTION);
  assert.match(r.stderr, new RegExp(TAG));
  assert.ok(r.stderr.startsWith(`Blocked: ${toolName}\n`), r.stderr);
}

function assertPasses(r) {
  assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
  assert.equal(r.stdout, '');
}

test('compact-stop: an auto compaction marks the session and never blocks compaction', () => {
  const s = setup();
  const r = preCompact(s, 'auto');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  const rec = JSON.parse(fs.readFileSync(markerFile(s), 'utf8'));
  assert.equal(rec.session_id, SESSION);
  assert.equal(rec.trigger, 'auto');
  assert.equal(preCompact(s, 'auto').status, 0, 'a second compaction is fine');
  assert.ok(!fs.existsSync(markerFile(s, 'other')), 'other sessions are not marked');
});

test('compact-stop: a manual /compact marks nothing', () => {
  const s = setup();
  assert.equal(preCompact(s, 'manual', { custom_instructions: 'keep the schema' }).status, 0);
  assert.ok(!fs.existsSync(path.join(s.data, 'compacted')));
  assert.equal(call(s, 'Bash', { command: 'ls' }).status, 0);
});

test('compact-stop: a PreCompact input that carries agent_id (a subagent) does not mark the parent session', () => {
  const s = setup();
  assert.equal(preCompact(s, 'auto', { agent_id: 'agent-7', agent_type: 'Explore' }).status, 0);
  assert.ok(!fs.existsSync(path.join(s.data, 'compacted')));
  assert.equal(call(s, 'Bash', { command: 'ls' }).status, 0);
});

test('compact-stop: SessionStart compact adds the instruction to a marked session only', () => {
  const s = setup();
  assertPasses(sessionStart(s, 'compact'));
  mark(s);
  const r = sessionStart(s, 'compact');
  assert.equal(r.status, 0);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(r.json.hookSpecificOutput.additionalContext, INSTRUCTION);
  assert.match(r.json.hookSpecificOutput.additionalContext, /send your report to the Planner, and end your turn\. A fresh session continues from that file\./);
  for (const source of ['startup', 'resume', 'clear', 'fork']) assertPasses(sessionStart(s, source));
});

test('compact-stop: a marked session may read, search, send messages, and write its INDEX', () => {
  const s = setup();
  mark(s);
  const index = path.join(s.project, '.recon', 'step-1', 'INDEX.md');
  const plan = path.join(s.home, '.claude', 'plans', 'foodplan', 'HANDOFF.md');
  assertPasses(call(s, 'Read', { file_path: path.join(s.project, 'src/app.ts') }));
  assertPasses(call(s, 'Grep', { pattern: 'x' }));
  assertPasses(call(s, 'Glob', { pattern: '**/*.ts' }));
  assertPasses(call(s, 'SendMessage', { to: 'planner', message: 'done' }));
  assertPasses(call(s, 'mcp__ccd_turn__wrap_up', { recap: 'stopped' }));
  assertPasses(call(s, 'mcp__ccd_turn__update_plan', { advance: true }));
  assertPasses(call(s, 'Write', { file_path: index, content: '# INDEX\n' }));
  assertPasses(call(s, 'Edit', { file_path: index, old_string: 'a', new_string: 'b' }));
  assertPasses(call(s, 'Write', { file_path: plan, content: 'x' }));
  assertPasses(call(s, 'Edit', { file_path: path.join(s.home, '.claude', 'plans', 'BRIEF.md'), old_string: 'a', new_string: 'b' }));
  assertPasses(call(s, 'Write', { file_path: path.join('.recon', 'step-1', 'INDEX.md'), content: 'x' }, { cwd: s.project }));
});

test('compact-stop: a marked session is denied Bash, Agent, and writes anywhere else, with the reason', () => {
  const s = setup();
  mark(s);
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  assertDenied(call(s, 'PowerShell', { command: 'ls' }), 'PowerShell');
  assertDenied(call(s, 'Agent', { prompt: 'review' }), 'Agent');
  assertDenied(call(s, 'WebFetch', { url: 'https://example.com' }), 'WebFetch');
  assertDenied(call(s, 'NotebookEdit', { notebook_path: path.join(s.project, 'n.ipynb') }), 'NotebookEdit');
  assertDenied(call(s, 'mcp__db__query', { sql: 'select 1' }), 'mcp__db__query');
  assertDenied(call(s, 'mcp__ccd_session__start_session', {}), 'mcp__ccd_session__start_session');
  assertDenied(call(s, 'Write', { file_path: path.join(s.project, 'src/app.ts'), content: 'x' }), 'Write');
  assertDenied(call(s, 'Edit', { file_path: path.join(s.project, 'src/app.ts'), old_string: 'a', new_string: 'b' }), 'Edit');
});

test('compact-stop: only INDEX.md one level under .recon, or files under ~/.claude/plans, are writable', () => {
  const s = setup();
  mark(s);
  const denied = [
    path.join(s.project, '.recon', 'INDEX.md'),
    path.join(s.project, '.recon', 'a', 'b', 'INDEX.md'),
    path.join(s.project, '.recon', 'step-1', 'REPORT.md'),
    path.join(s.project, '.recon', 'step-1', 'INDEX.md.bak'),
    path.join(s.project, '.recon', 'step-1', '..', '..', 'src', 'app.ts'),
    path.join(s.project, '.recon', '..', 'INDEX.md'),
    path.join(s.project, 'INDEX.md'),
    path.join(s.project, 'docs', 'step-1', 'INDEX.md'),
    path.join(s.home, '.claude', 'plans-other', 'x.md'),
    path.join(s.home, '.claude', 'settings.json'),
    path.join(s.home, '.claude', 'plans', '..', 'settings.json'),
    path.join(s.data, 'compacted', `${SESSION}.json`),
    path.join(path.dirname(s.project), 'other', '.recon', 'step-1', 'INDEX.md'),
  ];
  for (const file_path of denied) assertDenied(call(s, 'Write', { file_path, content: 'x' }), 'Write');
  assertDenied(call(s, 'Write', { content: 'x' }), 'Write');
  assertDenied(call(s, 'Write', { file_path: '', content: 'x' }), 'Write');
});

test('compact-stop: a symlink inside .recon or the plans directory does not carry a write outside it', () => {
  const s = setup();
  mark(s);
  fs.mkdirSync(path.join(s.project, '.recon'), { recursive: true });
  fs.symlinkSync(path.join(s.project, 'src'), path.join(s.project, '.recon', 'link'));
  fs.symlinkSync(s.project, path.join(s.home, '.claude', 'plans', 'out'));
  assertDenied(call(s, 'Write', { file_path: path.join(s.project, '.recon', 'link', 'INDEX.md'), content: 'x' }), 'Write');
  assertDenied(call(s, 'Write', { file_path: path.join(s.home, '.claude', 'plans', 'out', 'src', 'app.ts'), content: 'x' }), 'Write');
});

test('compact-stop: an unmarked session is untouched, and a mark is per session', () => {
  const s = setup();
  assertPasses(call(s, 'Bash', { command: 'git status' }));
  assertPasses(call(s, 'Write', { file_path: path.join(s.project, 'src/app.ts'), content: 'x' }));
  mark(s);
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  assertPasses(call(s, 'Bash', { command: 'ls' }, { session_id: 'other' }));
});

test('compact-stop: ENG_STANDARD_COMPACT_STOP=off turns it all off', () => {
  const s = setup();
  for (const value of ['off', 'OFF', '0', 'false', 'no', 'disabled']) {
    const env = { ENG_STANDARD_COMPACT_STOP: value };
    assert.equal(preCompact(s, 'auto', {}, env).status, 0);
    assert.ok(!fs.existsSync(path.join(s.data, 'compacted')), `${value}: nothing recorded`);
  }
  mark(s);
  const off = { ENG_STANDARD_COMPACT_STOP: 'off' };
  assertPasses(call(s, 'Bash', { command: 'ls' }, {}, off));
  assertPasses(sessionStart(s, 'compact', {}, off));
  assertDenied(call(s, 'Bash', { command: 'ls' }, {}, { ENG_STANDARD_COMPACT_STOP: 'on' }), 'Bash');
});

test('compact-stop: fails open on input it cannot parse, and ignores other events', () => {
  const s = setup();
  mark(s);
  for (const raw of ['', 'not json', '[]', 'null']) {
    const r = runHook(HOOK, raw, { env: s.env });
    assert.equal(r.status, 0, raw);
    assert.equal(r.stdout, '');
  }
  assertPasses(call(s, 'Bash', { command: 'ls' }, { session_id: undefined }));
  assertPasses(runHook(HOOK, { session_id: SESSION, hook_event_name: 'Stop' }, { env: s.env }));
  assertPasses(call(s, 'Bash', { command: 'ls' }, { tool_name: undefined }));
});

test('compact-stop: removes markers not touched for 30 days when it records a new one', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.data, 'compacted'), { recursive: true });
  const old = markerFile(s, 'old-session');
  fs.writeFileSync(old, '{}\n');
  const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  mark(s);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(markerFile(s)));
});

test('compact-stop: a denied call, or a later auto compaction, keeps the marker from expiring', () => {
  const s = setup();
  mark(s);
  const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(markerFile(s), longAgo, longAgo);
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  assert.ok(Date.now() - fs.statSync(markerFile(s)).mtimeMs < 60 * 1000, 'a denial refreshes the marker');
  fs.utimesSync(markerFile(s), longAgo, longAgo);
  assert.equal(preCompact(s, 'auto').status, 0);
  assert.ok(Date.now() - fs.statSync(markerFile(s)).mtimeMs < 60 * 1000, 'a repeat compaction refreshes the marker');
  // Another session's marker write must not remove it.
  assert.equal(preCompact(s, 'auto', { session_id: 'other' }).status, 0);
  assert.ok(fs.existsSync(markerFile(s)));
});

test('compact-stop: the stop gate lets a marked session stop without its fast-gate demand', () => {
  const s = setup();
  writeFiles(s.project, {
    'package.json': JSON.stringify({ name: 't', private: true, scripts: { 'gate:fast': 'true' } }),
    '.gitignore': '.recon/\n',
  });
  fs.mkdirSync(path.join(s.data, 'session-roles'), { recursive: true });
  fs.writeFileSync(path.join(s.data, 'session-roles', `${SESSION}.json`), JSON.stringify({ session_id: SESSION, role: 'builder', recorded_at: new Date().toISOString() }));
  writeFiles(s.project, { 'src/app.ts': 'export const x = 2;\n' });

  const before = stop(s);
  assert.equal(before.json && before.json.decision, 'block', 'an unmarked Builder with changes is asked to run the gate');
  mark(s);
  assertPasses(stop(s));
  assert.equal(stop(s, { ENG_STANDARD_COMPACT_STOP: 'off' }).json.decision, 'block', 'with compact-stop off the gate applies again');
});
