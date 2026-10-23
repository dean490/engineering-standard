'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixture, runHook, tempRepo, tempDir, writeFiles } = require('./helpers.cjs');

const HOOK = 'token-watch.cjs';
const SESSION = 's1';
const REASON = /This session reached about 140k tokens, so it hands off now \(eng-standard token-watch\)\. 1\. Write where you stand into your state file: `\.recon\/<step>\/INDEX\.md` for a Builder, the brief file under `~\/\.claude\/plans\/` for a Planner\. 2\. Call `start_session` directly: initiation "user_asked", context "fresh", `background: true`.*3\. After a direct start, call `detach_session` with the new session's id\. 4\. After a direct start, end your turn with one line naming the successor\. Owner override: `ENG_STANDARD_TOKEN_WATCH=off`\./;

function assistantLine(usage, extra = {}) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [], usage }, ...extra });
}

// Context of 140000 or 120000 tokens split across the three input fields.
function usageOf(total) {
  return { input_tokens: 2, cache_creation_input_tokens: 10000, cache_read_input_tokens: total - 10002, output_tokens: 500 };
}

function setup(lines) {
  const project = tempRepo({ 'src/app.ts': 'export {};\n' });
  const data = tempDir('eng-standard-plugin-data-');
  const home = tempDir('eng-standard-home-');
  fs.mkdirSync(path.join(home, '.claude', 'plans'), { recursive: true });
  const transcript = path.join(tempDir('eng-standard-transcript-'), 't.jsonl');
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  return { project, data, home, transcript, env: { CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: data, HOME: home } };
}

function call(s, toolName, toolInput = {}, overrides = {}, env = {}) {
  return runHook(HOOK, fixture('pretooluse-write', {
    session_id: SESSION, cwd: s.project, transcript_path: s.transcript, tool_name: toolName, tool_input: toolInput, ...overrides,
  }), { env: { ...s.env, ...env } });
}

function assertDenied(r, toolName) {
  assert.equal(r.status, 2, `expected exit 2; stderr: ${r.stderr}`);
  assert.match(r.stderr, REASON);
  assert.ok(r.stderr.startsWith(`Blocked: ${toolName}\n`), r.stderr);
}

function assertPasses(r) {
  assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);
  assert.equal(r.stdout, '');
}

const OVER = [assistantLine(usageOf(50000)), assistantLine(usageOf(140000))];
const UNDER = [assistantLine(usageOf(140000)), assistantLine(usageOf(120000))];

test('token-watch: fires at 140000 tokens of context and not at 120000 or 139999', () => {
  assertDenied(call(setup(OVER), 'Bash', { command: 'ls' }), 'Bash');
  assertDenied(call(setup([assistantLine(usageOf(140001))]), 'Bash', { command: 'ls' }), 'Bash');
  assertPasses(call(setup(UNDER), 'Bash', { command: 'ls' }));
  assertPasses(call(setup([assistantLine(usageOf(139999))]), 'Bash', { command: 'ls' }));
});

test('token-watch: counts input, cache creation, and cache read tokens, and uses the latest assistant entry', () => {
  const s = setup([
    assistantLine({ input_tokens: 100000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }),
  ]);
  assertPasses(call(s, 'Bash', { command: 'ls' }));
  assertDenied(call(setup([assistantLine({ input_tokens: 40000, cache_creation_input_tokens: 50000, cache_read_input_tokens: 50000 })]), 'Bash', {}), 'Bash');
  assertDenied(call(setup([assistantLine({ input_tokens: 140000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })]), 'Bash', {}), 'Bash');
});

test('token-watch: once marked, the session stays handed off even if a later entry shows less', () => {
  const s = setup(OVER);
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  fs.writeFileSync(s.transcript, assistantLine(usageOf(20000)) + '\n');
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  assert.ok(fs.existsSync(path.join(s.data, 'handoff', `${SESSION}.json`)));
  assertPasses(call(s, 'Bash', { command: 'ls' }, { session_id: 'other' }));
});

test('token-watch: ENG_STANDARD_TOKEN_WATCH=off turns it off, and a number sets the threshold', () => {
  const s = setup(OVER);
  for (const value of ['off', 'OFF', '0', 'false', 'no', 'disabled']) {
    assertPasses(call(s, 'Bash', { command: 'ls' }, {}, { ENG_STANDARD_TOKEN_WATCH: value }));
  }
  assert.ok(!fs.existsSync(path.join(s.data, 'handoff')), 'off marks nothing');
  assertPasses(call(s, 'Bash', { command: 'ls' }, {}, { ENG_STANDARD_TOKEN_WATCH: '200000' }));
  const low = call(s, 'Bash', { command: 'ls' }, {}, { ENG_STANDARD_TOKEN_WATCH: '100000' });
  assert.equal(low.status, 2);
  assert.match(low.stderr, /This session reached about 100k tokens/);
  assertDenied(call(setup(OVER), 'Bash', {}, {}, { ENG_STANDARD_TOKEN_WATCH: 'nonsense' }), 'Bash');
  assertPasses(call(setup(UNDER), 'Bash', {}, {}, { ENG_STANDARD_TOKEN_WATCH: 'nonsense' }));
});

test('token-watch: a call that carries agent_id (a subagent) is ignored and marks nothing', () => {
  const s = setup(OVER);
  assertPasses(call(s, 'Bash', { command: 'ls' }, { agent_id: 'agent-7', agent_type: 'Explore' }));
  assert.ok(!fs.existsSync(path.join(s.data, 'handoff')));
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  assertPasses(call(s, 'Bash', { command: 'ls' }, { agent_id: 'agent-7' }));
});

test('token-watch: a handing-off session may read, search, write its state file, start and detach its successor, and use turn tools', () => {
  const s = setup(OVER);
  const index = path.join(s.project, '.recon', 'step-1', 'INDEX.md');
  assertPasses(call(s, 'Read', { file_path: path.join(s.project, 'src/app.ts') }));
  assertPasses(call(s, 'Grep', { pattern: 'x' }));
  assertPasses(call(s, 'Glob', { pattern: '**/*.ts' }));
  assertPasses(call(s, 'Write', { file_path: index, content: '# INDEX\n' }));
  assertPasses(call(s, 'Edit', { file_path: index, old_string: 'a', new_string: 'b' }));
  assertPasses(call(s, 'Write', { file_path: path.join(s.home, '.claude', 'plans', 'foodplan', 'BRIEF.md'), content: 'x' }));
  assertPasses(call(s, 'Write', { file_path: path.join('.recon', 'step-1', 'INDEX.md'), content: 'x' }, { cwd: s.project }));
  assertPasses(call(s, 'mcp__ccd_session__start_session', { initiation: 'user_asked' }));
  assertPasses(call(s, 'mcp__ccd_session_mgmt__detach_session', { session_id: 'local_1' }));
  assertPasses(call(s, 'mcp__ccd_turn__wrap_up', { recap: 'handed off' }));
  assertPasses(call(s, 'mcp__ccd_turn__update_plan', { advance: true }));
});

test('token-watch: Bash and other writes are denied with the reason', () => {
  const s = setup(OVER);
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  assertDenied(call(s, 'PowerShell', { command: 'ls' }), 'PowerShell');
  assertDenied(call(s, 'Agent', { prompt: 'review' }), 'Agent');
  assertDenied(call(s, 'WebSearch', { query: 'x' }), 'WebSearch');
  assertDenied(call(s, 'SendMessage', { to: 'planner', message: 'x' }), 'SendMessage');
  assertDenied(call(s, 'mcp__ccd_session_mgmt__send_message', {}), 'mcp__ccd_session_mgmt__send_message');
  assertDenied(call(s, 'Write', { file_path: path.join(s.project, 'src/app.ts'), content: 'x' }), 'Write');
  assertDenied(call(s, 'Edit', { file_path: path.join(s.project, 'src/app.ts'), old_string: 'a', new_string: 'b' }), 'Edit');
  assertDenied(call(s, 'Write', { file_path: path.join(s.project, '.recon', 'step-1', 'REPORT.md'), content: 'x' }), 'Write');
  assertDenied(call(s, 'Write', { file_path: path.join(s.project, '.recon', 'INDEX.md'), content: 'x' }), 'Write');
  assertDenied(call(s, 'Write', { file_path: path.join(s.home, '.claude', 'settings.json'), content: 'x' }), 'Write');
  assertDenied(call(s, 'Write', { file_path: path.join(s.home, '.claude', 'plans', '..', 'settings.json'), content: 'x' }), 'Write');
  assertDenied(call(s, 'Write', { content: 'x' }), 'Write');
});

test('token-watch: fails open on a missing, empty, or malformed transcript, and on input it cannot parse', () => {
  const s = setup(UNDER);
  const bad = [
    ['missing file', { transcript_path: path.join(s.project, 'nope.jsonl') }],
    ['no transcript_path', { transcript_path: undefined }],
    ['directory', { transcript_path: s.project }],
  ];
  for (const [label, overrides] of bad) assertPasses(call(s, 'Bash', { command: 'ls' }, overrides), label);
  for (const content of ['', 'not json\n{"half":', '{"message":{"role":"assistant","usage":"x"}}\n', '{"message":{"role":"assistant","usage":{"input_tokens":"many"}}}\n', '[]\nnull\n']) {
    fs.writeFileSync(s.transcript, content);
    assertPasses(call(s, 'Bash', { command: 'ls' }), JSON.stringify(content));
  }
  for (const raw of ['', 'not json', '[]', 'null']) assert.equal(runHook(HOOK, raw, { env: s.env }).status, 0, raw);
  assertPasses(call(s, 'Bash', { command: 'ls' }, { session_id: undefined }));
  assertPasses(call(s, 'Bash', { command: 'ls' }, { hook_event_name: 'PostToolUse' }));
  assert.ok(!fs.existsSync(path.join(s.data, 'handoff')));
});

test('token-watch: reads only the end of a large transcript, skips a cut line and sidechain entries', () => {
  const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(2000) } });
  const lines = [assistantLine(usageOf(10000))];
  for (let i = 0; i < 600; i++) lines.push(filler);
  lines.push(assistantLine(usageOf(150000), { isSidechain: true }));
  lines.push(assistantLine(usageOf(141000)));
  assertDenied(call(setup(lines), 'Bash', {}), 'Bash');
  // The only entry over the limit is a sidechain one: ignored.
  assertPasses(call(setup([assistantLine(usageOf(30000)), assistantLine(usageOf(150000), { isSidechain: true })]), 'Bash', {}));
  // An old over-limit entry beyond the tail is not seen.
  const old = [assistantLine(usageOf(150000))];
  for (let i = 0; i < 600; i++) old.push(filler);
  assertPasses(call(setup(old), 'Bash', {}));
});

test('token-watch: the stop gate lets a handed-off session stop without its fast-gate demand', () => {
  const s = setup(OVER);
  writeFiles(s.project, {
    'package.json': JSON.stringify({ name: 't', private: true, scripts: { 'gate:fast': 'true' } }),
    '.gitignore': '.recon/\n',
  });
  fs.mkdirSync(path.join(s.data, 'session-roles'), { recursive: true });
  fs.writeFileSync(path.join(s.data, 'session-roles', `${SESSION}.json`), JSON.stringify({ session_id: SESSION, role: 'builder', recorded_at: new Date().toISOString() }));
  writeFiles(s.project, { 'src/app.ts': 'export const x = 2;\n' });
  const stop = (env = {}) => runHook('stop-gate.cjs', fixture('stop', { session_id: SESSION, cwd: s.project }), { env: { ...s.env, ...env } });
  assert.equal(stop().json && stop().json.decision, 'block');
  assertDenied(call(s, 'Bash', { command: 'ls' }), 'Bash');
  assertPasses(stop());
  assert.equal(stop({ ENG_STANDARD_TOKEN_WATCH: 'off' }).json.decision, 'block');
});

const SELECT_OK = [
  'select:mcp__ccd_session__start_session,mcp__ccd_session_mgmt__detach_session',
  'select:mcp__ccd_session__start_session, mcp__ccd_session_mgmt__detach_session ',
  'select:mcp__ccd_turn__wrap_up',
  'select:mcp__ccd_session__start_session',
];
const SELECT_DENIED = [
  'start session', 'select:Bash', 'select:mcp__ccd_session__start_session,Bash', 'select:Bash,mcp__ccd_session__start_session',
  'select:', 'select:,', '', '+ccd session', 'select:mcp__ccd_session__stop_session', 'select:mcp__ccd_turn__', ' select:mcp__ccd_turn__wrap_up',
];

test('token-watch: ToolSearch passes only for a select: query naming the session tools or turn tools', () => {
  const s = setup(OVER);
  for (const q of SELECT_OK) assertPasses(call(s, 'ToolSearch', { query: q, max_results: 5 }));
  for (const q of SELECT_DENIED) assertDenied(call(s, 'ToolSearch', { query: q, max_results: 5 }), 'ToolSearch');
  for (const ti of [{}, { query: 5 }, { query: null }, { query: ['select:mcp__ccd_turn__wrap_up'] }]) assertDenied(call(s, 'ToolSearch', ti), 'ToolSearch');
});

test('token-watch: the hand-off message names the direct start, the card fallback, and the card line', () => {
  const s = setup(OVER);
  const r = call(s, 'Bash', { command: 'ls' });
  assert.match(r.stderr, /2\. Call `start_session` directly: initiation "user_asked", context "fresh", `background: true`/);
  assert.match(r.stderr, /call `start_session` again with initiation "own_initiative", the same title, and the same prompt as a complete brief/);
  assert.match(r.stderr, /"Tap Start on the card '<title>' to continue\."/);
  assert.match(r.stderr, /`ToolSearch` query `select:mcp__ccd_session__start_session,mcp__ccd_session_mgmt__detach_session`/);
  assert.match(r.stderr, /3\. After a direct start, call `detach_session`/);
});
