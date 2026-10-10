'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fixture, rawFixture, runHook, tempRepo, tempDir } = require('./helpers.cjs');

const HOOK = 'planner-readonly.cjs';
const TAG = 'guard: eng-standard planner-readonly';

function setup() {
  const project = tempRepo({ 'src/app.ts': 'export {};\n' });
  const data = tempDir('eng-standard-plugin-data-');
  return { project, data, env: { CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: data } };
}

function write(s, sessionId, mode, filePath) {
  return runHook(HOOK, fixture('pretooluse-write', {
    session_id: sessionId,
    cwd: s.project,
    permission_mode: mode,
    tool_input: { file_path: filePath || path.join(s.project, 'src/app.ts') },
  }), { env: s.env });
}

// A Bash (or PowerShell, or Monitor) call.
function shellCall(s, sessionId, mode, command, tool = 'Bash') {
  const name = tool === 'Monitor' ? 'pretooluse-monitor' : 'pretooluse-bash';
  return runHook(HOOK, fixture(name, { session_id: sessionId, cwd: s.project, permission_mode: mode, tool_name: tool, tool_input: { command } }), { env: s.env });
}

// A submitted prompt; overrides can drop or replace fields of the fixture.
function prompt(s, sessionId, mode, overrides = {}) {
  const payload = fixture('userpromptsubmit', { session_id: sessionId, cwd: s.project, permission_mode: mode, ...overrides });
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete payload[k];
  return runHook(HOOK, payload, { env: s.env, args: ['--record-role'] });
}

function roleFile(s, sessionId) {
  return path.join(s.data, 'session-roles', `${sessionId}.json`);
}

function role(s, sessionId) {
  return JSON.parse(fs.readFileSync(roleFile(s, sessionId), 'utf8')).role;
}

function assertBlocked(r, pattern) {
  assert.equal(r.status, 2, `expected exit 2; stderr: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(TAG));
  if (pattern) assert.match(r.stderr, pattern);
}

test('planner-readonly: a session started outside plan mode is a Builder and can edit', () => {
  const s = setup();
  assert.equal(prompt(s, 'builder-1', 'default').status, 0);
  assert.equal(role(s, 'builder-1'), 'builder');
  assert.equal(write(s, 'builder-1', 'default').status, 0);
  assert.equal(write(s, 'builder-1', 'acceptEdits').status, 0);
  assert.equal(write(s, 'builder-1', 'auto').status, 0);
});

test('planner-readonly: a session started in plan mode stays read-only after its plan is approved', () => {
  const s = setup();
  assert.equal(prompt(s, 'planner-1', 'plan').status, 0, 'recording never blocks a prompt');
  assert.equal(role(s, 'planner-1'), 'planner');
  assertBlocked(write(s, 'planner-1', 'plan'));
  // Approving the plan switches the session to another mode; later prompts don't change the role.
  for (const mode of ['auto', 'acceptEdits', 'default', 'bypassPermissions']) {
    assert.equal(prompt(s, 'planner-1', mode).status, 0);
    assertBlocked(write(s, 'planner-1', mode), /started in plan mode/);
  }
  assert.equal(role(s, 'planner-1'), 'planner');
  assert.equal(write(s, 'other-session', 'auto').status, 0, 'other sessions are unaffected');
});

test('planner-readonly: a Builder that enters plan mode later, has the plan approved, and then edits is allowed', () => {
  const s = setup();
  prompt(s, 'builder-2', 'default');
  // Explore, then switch to plan mode (Shift+Tab or /plan) and plan.
  assert.equal(prompt(s, 'builder-2', 'plan').status, 0);
  assertBlocked(write(s, 'builder-2', 'plan'), /in plan mode, which is read-only/);
  // Plan approved: the session leaves plan mode and implements.
  assert.equal(prompt(s, 'builder-2', 'acceptEdits').status, 0);
  assert.equal(write(s, 'builder-2', 'acceptEdits').status, 0);
  assert.equal(write(s, 'builder-2', 'auto').status, 0);
  assert.equal(role(s, 'builder-2'), 'builder');
});

test('planner-readonly: a resumed session keeps its role', () => {
  const s = setup();
  // --resume and --continue reuse the session ID (cli-reference, --fork-session).
  prompt(s, 'planner-3', 'plan');
  assert.equal(prompt(s, 'planner-3', 'default').status, 0, 'resumed in default mode');
  assertBlocked(write(s, 'planner-3', 'default'), /started in plan mode/);

  prompt(s, 'builder-3', 'default');
  assert.equal(prompt(s, 'builder-3', 'plan').status, 0, 'resumed in plan mode (the session ended in plan mode)');
  assert.equal(role(s, 'builder-3'), 'builder');
  assert.equal(write(s, 'builder-3', 'auto').status, 0);
});

test('planner-readonly: edits in plan mode are blocked in a session with no recorded role', () => {
  const s = setup();
  assertBlocked(write(s, 'unrecorded', 'plan'), /in plan mode/);
  assert.equal(write(s, 'unrecorded', 'auto').status, 0);
  assert.ok(!fs.existsSync(roleFile(s, 'unrecorded')), 'only a prompt records a role');
});

test('planner-readonly: a Planner session may still write outside the repository, but not in the plugin data directory', () => {
  const s = setup();
  prompt(s, 'planner-4', 'plan');
  const plans = path.join(os.homedir(), '.claude', 'plans', 'refactor.md');
  assert.equal(write(s, 'planner-4', 'plan', plans).status, 0);
  assert.equal(write(s, 'planner-4', 'auto', path.join(os.tmpdir(), 'planner-notes.md')).status, 0);
  assertBlocked(write(s, 'planner-4', 'auto', path.join(s.data, 'notes.md')), /plugin's data directory/);
});

test('planner-readonly: recording never blocks, even on bad input, and needs a session ID and a mode', () => {
  const s = setup();
  for (const raw of [rawFixture('malformed.txt'), '', 'null']) {
    const r = runHook(HOOK, raw, { env: s.env, args: ['--record-role'] });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  }
  assert.equal(prompt(s, 'no-mode', undefined, { permission_mode: undefined }).status, 0);
  assert.ok(!fs.existsSync(roleFile(s, 'no-mode')), 'no role without a permission mode');
  prompt(s, 'no-mode', 'plan');
  assert.equal(role(s, 'no-mode'), 'planner', 'the first prompt that carries a mode records the role');
  assert.equal(prompt(s, '', 'plan').status, 0);
  const blocked = { ...s, env: { ...s.env, CLAUDE_PLUGIN_DATA: path.join(s.project, 'src/app.ts') } };
  assert.equal(prompt(blocked, 'unwritable', 'plan').status, 0, 'a store that cannot be written does not block');
});

test('planner-readonly CR-10: a role record that exists but cannot be used counts as a Planner (fail closed)', () => {
  const s = setup();
  for (const [id, content] of [['corrupt', '{ not json'], ['empty', '{}'], ['unknown-role', '{"role":"admin"}'], ['null', 'null']]) {
    prompt(s, id, 'default');
    fs.writeFileSync(roleFile(s, id), content);
    assertBlocked(write(s, id, 'auto'), /role record .* treated as a Planner session/);
    assertBlocked(shellCall(s, id, 'auto', 'touch src/x.ts'), /treated as a Planner session/);
    assert.equal(prompt(s, id, 'default').status, 0);
    assert.equal(fs.readFileSync(roleFile(s, id), 'utf8'), content, 'a later prompt never rewrites a record');
  }
  // A record that can't be read at all.
  prompt(s, 'unreadable', 'default');
  fs.chmodSync(roleFile(s, 'unreadable'), 0o000);
  try {
    if (process.getuid && process.getuid() !== 0) assertBlocked(write(s, 'unreadable', 'auto'), /can't be read/);
  } finally {
    fs.chmodSync(roleFile(s, 'unreadable'), 0o600);
  }
});

test('planner-readonly CR-10: no session can write the role store with Claude\'s file tools', () => {
  const s = setup();
  prompt(s, 'planner-7', 'plan');
  prompt(s, 'builder-7', 'default');
  for (const id of ['planner-7', 'builder-7', 'no-record']) {
    assertBlocked(write(s, id, 'bypassPermissions', roleFile(s, 'planner-7')), /plugin's data directory/);
    const nb = runHook(HOOK, fixture('pretooluse-notebookedit', {
      session_id: id, cwd: s.project, permission_mode: 'bypassPermissions', tool_input: { notebook_path: path.join(s.data, 'x.ipynb') },
    }), { env: s.env });
    assertBlocked(nb, /plugin's data directory/);
  }
  assert.equal(role(s, 'planner-7'), 'planner');
});

test('planner-readonly CR-7: a Planner session runs read-only shell commands only, through Bash, PowerShell, or Monitor', () => {
  const s = setup();
  prompt(s, 'planner-8', 'plan');
  for (const mode of ['plan', 'auto', 'default', 'bypassPermissions']) {
    for (const cmd of [
      "cat > src/lib/plan.ts <<'EOF'\nexport {};\nEOF",
      "sed -i 's/a/b/' src/app.ts",
      'touch src/new.ts',
      'git add src/app.ts',
      'pnpm install',
      'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"',
      'git grep --open=true -e x',
    ]) assertBlocked(shellCall(s, 'planner-8', mode, cmd), /Planner session runs read-only commands only/);
  }
  assertBlocked(shellCall(s, 'planner-8', 'auto', 'touch src/x.ts', 'Monitor'), /read-only commands only/);
  assertBlocked(shellCall(s, 'planner-8', 'auto', 'Set-Content src/x.ts y', 'PowerShell'), /read-only commands only/);
  for (const cmd of ['git status', 'git log --oneline -5', 'git diff main...HEAD', 'cat src/app.ts | head -20', 'grep -rn createClient src', 'pnpm test', 'pnpm run typecheck']) {
    assert.equal(shellCall(s, 'planner-8', 'auto', cmd).status, 0, cmd);
  }
  const ws = runHook(HOOK, fixture('pretooluse-monitor', { session_id: 'planner-8', cwd: s.project, tool_input: { command: undefined, ws: { url: 'wss://example.com/x' } } }), { env: s.env });
  assert.equal(ws.status, 0, 'a WebSocket watch runs no command');
  // Builder sessions and sessions without a record are not limited.
  prompt(s, 'builder-8', 'default');
  assert.equal(shellCall(s, 'builder-8', 'auto', 'touch src/new.ts').status, 0);
  assert.equal(shellCall(s, 'builder-8', 'plan', 'touch src/new.ts').status, 0, 'plan mode in a Builder session governs file tools only');
  assert.equal(shellCall(s, 'no-record', 'auto', 'touch src/new.ts').status, 0);
});

test('planner-readonly CR-25: NotebookEdit is covered like Edit and Write', () => {
  const s = setup();
  prompt(s, 'planner-9', 'plan');
  prompt(s, 'builder-9', 'default');
  const nb = (id, mode, p) => runHook(HOOK, fixture('pretooluse-notebookedit', {
    session_id: id, cwd: s.project, permission_mode: mode, tool_input: { notebook_path: p },
  }), { env: s.env });
  const inRepo = path.join(s.project, 'notebooks', 'analysis.ipynb');
  assertBlocked(nb('planner-9', 'auto', inRepo), /Planner session/);
  assertBlocked(nb('builder-9', 'plan', inRepo), /in plan mode/);
  assert.equal(nb('builder-9', 'auto', inRepo).status, 0);
});

test('planner-readonly: roles unused for 30 days are removed; active ones are kept', () => {
  const s = setup();
  prompt(s, 'stale', 'plan');
  prompt(s, 'active', 'plan');
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  fs.utimesSync(roleFile(s, 'stale'), old, old);
  fs.utimesSync(roleFile(s, 'active'), old, old);
  prompt(s, 'active', 'default'); // a later prompt refreshes the record's time
  prompt(s, 'new-session', 'default'); // recording a new role prunes
  assert.ok(!fs.existsSync(roleFile(s, 'stale')));
  assert.equal(role(s, 'active'), 'planner');
});

test('planner-readonly: enforcement fails closed on input it cannot parse', () => {
  const s = setup();
  assertBlocked(runHook(HOOK, rawFixture('malformed.txt'), { env: s.env }));
  assertBlocked(runHook(HOOK, '', { env: s.env }));
  prompt(s, 'planner-6', 'plan');
  assertBlocked(runHook(HOOK, fixture('pretooluse-write', { session_id: 'planner-6', cwd: s.project, permission_mode: 'auto', tool_input: { file_path: '' } }), { env: s.env }));
});

test('planner-readonly: hooks.json records roles on UserPromptSubmit only, and ExitPlanMode marks nothing', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const runs = (entries) => entries.flatMap((e) => e.hooks.map((h) => ({ matcher: e.matcher, args: h.args })));
  const recorders = Object.entries(config).flatMap(([event, entries]) =>
    runs(entries).filter((h) => h.args.some((a) => a.endsWith('planner-readonly.cjs')) && h.args.includes('--record-role')).map(() => event));
  assert.deepEqual(recorders, ['UserPromptSubmit']);
  const enforcers = runs(config.PreToolUse).filter((h) => h.args.some((a) => a.endsWith('planner-readonly.cjs')));
  assert.deepEqual(enforcers.map((h) => h.matcher), ['Edit|Write|NotebookEdit', 'Bash|PowerShell|Monitor']);
  assert.ok(!runs(config.PreToolUse).some((h) => /ExitPlanMode/.test(h.matcher || '')));
});
