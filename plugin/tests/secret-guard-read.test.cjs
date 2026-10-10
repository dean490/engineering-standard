'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, rawFixture, runHook, tempDir, writeFiles } = require('./helpers.cjs');

const HOOK = 'secret-guard-read.cjs';
const TAG = 'guard: eng-standard secret-guard-read';

function read(filePath) {
  return runHook(HOOK, fixture('pretooluse-read', { tool_input: { file_path: filePath } }));
}
function bash(command, tool = 'Bash') {
  return runHook(HOOK, fixture('pretooluse-bash', { tool_name: tool, tool_input: { command } }));
}
function assertBlocked(r) {
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(TAG));
}
function assertAllowed(r) {
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
}

test('secret-guard-read: allows ordinary reads and commands', () => {
  assertAllowed(read('/home/user/my-project/src/app.ts'));
  assertAllowed(read('/home/user/my-project/README.md'));
  assertAllowed(read('/home/user/my-project/docs/environment.md'));
  assertAllowed(bash('npm test'));
  assertAllowed(bash('cat src/app.ts | head -20'));
  assertAllowed(bash('grep -rn "apiKey" src/'));
  assertAllowed(bash('echo "API_URL=" >> .env.example'));
  assertAllowed(runHook(HOOK, fixture('pretooluse-grep')));
});

test('secret-guard-read: blocks Read of .env* files', () => {
  for (const p of ['/home/user/my-project/.env', '/home/user/my-project/.env.local', '/home/user/my-project/.env.example',
    '/home/user/my-project/apps/web/.env.production', '/home/user/my-project/.envrc', 'C:\\project\\.env']) {
    const r = read(p);
    assertBlocked(r);
    assert.match(r.stderr, /environment\/secret file/);
  }
});

test('secret-guard-read: blocks Read of key files', () => {
  for (const p of ['/home/user/my-project/certs/server.pem', '/home/user/my-project/secrets/api.key',
    '/home/user/.ssh/id_ed25519', '/home/user/.ssh/id_rsa', '/home/user/my-project/cert.p12']) {
    const r = read(p);
    assertBlocked(r);
    assert.match(r.stderr, /key file/);
  }
  assertAllowed(read('/home/user/.ssh/id_ed25519.pub'));
});

test('secret-guard-read: blocks Grep that targets a secret file', () => {
  const r = runHook(HOOK, fixture('pretooluse-grep', { tool_input: { path: '/home/user/my-project/.env.local' } }));
  assertBlocked(r);
  const r2 = runHook(HOOK, fixture('pretooluse-grep', { tool_input: { glob: '.env*' } }));
  assertBlocked(r2);
});

test('secret-guard-read: blocks shell commands that read secret files', () => {
  for (const cmd of [
    'cat .env',
    'grep SUPABASE .env.local',
    'head -1 /home/user/my-project/.env',
    'source .env && echo $SUPABASE_SERVICE_ROLE_KEY',
    'cp .env /tmp/x && cat /tmp/x',
    'while read l; do echo $l; done < .env',
    'cat config/tls.pem',
    'base64 ~/.ssh/id_ed25519',
    'sort secrets/api.key',
  ]) {
    assertBlocked(bash(cmd));
  }
  assertBlocked(bash('Get-Content .env', 'PowerShell'));
});

test('secret-guard-read: fails closed on input it cannot parse', () => {
  assertBlocked(runHook(HOOK, rawFixture('malformed.txt')));
  assertBlocked(runHook(HOOK, ''));
  assertBlocked(runHook(HOOK, '[]'));
  assertBlocked(runHook(HOOK, fixture('pretooluse-read', { tool_input: null })));
  assertBlocked(runHook(HOOK, fixture('pretooluse-read', { tool_input: { file_path: '' } })));
  assertBlocked(runHook(HOOK, fixture('pretooluse-bash', { tool_input: { command: 42 } })));
  assertBlocked(runHook(HOOK, fixture('pretooluse-bash', { tool_name: 42 })));
});

// Critic v0.1.0: CR-16 (false positives on ordinary commands) and CR-3 (Monitor).
test('secret-guard-read CR-16: jq paths, grep patterns, and sed scripts are not file paths', () => {
  for (const cmd of [
    'jq .key package.json',
    "jq '.compilerOptions.key' tsconfig.json",
    'jq -r .env.production config.json',
    'grep -rn "api.key" src/',
    "git ls-files | grep -c '\\.env'",
    "grep -n 'NEXT_PUBLIC_' docs/ENVIRONMENT.md",
    "sed -n '/\\.env/p' docs/SETUP.md",
    'ls -la .env.local',
    'cat docs/key.md',
  ]) assertAllowed(bash(cmd));
  for (const cmd of [
    'jq . .env',
    'jq -r .key secrets/api.key',
    'grep -e SUPABASE .env.local',
    'grep -f .env src/app.ts',
    'cat ./.env.local',
    'cat "apps/web/.env.local"',
    "bash -c 'cat .env'",
    'echo $(cat .env)',
    'sudo cat .env',
    'cat < .env.local',
    '. .env',
  ]) assertBlocked(bash(cmd));
});

test('secret-guard-read CR-16: a glob that matches a secret file in its directory is blocked', () => {
  const dir = tempDir();
  writeFiles(dir, { '.env': 'X=1\n', 'src/app.ts': 'export {};\n', 'certs/server.pem': 'x\n' });
  const run = (command) => runHook(HOOK, fixture('pretooluse-bash', { cwd: dir, tool_input: { command } }));
  assertBlocked(run('cat .en?'));
  assertBlocked(run('cat .e*'));
  assertBlocked(run('cat certs/*'));
  assertAllowed(run('cat src/*'));
  assertAllowed(run('cat *'), 'a leading * does not match a dotfile');
});

test('secret-guard-read: a command the parser cannot read falls back to the text patterns', () => {
  assertBlocked(bash('cat .env "unterminated'));
  assertAllowed(bash('jq .key "unterminated'));
});

test('secret-guard-read CR-3: Monitor commands are checked like Bash', () => {
  const monitor = (command) => runHook(HOOK, fixture('pretooluse-monitor', { tool_input: { command } }));
  assertBlocked(monitor('tail -f .env.local'));
  assertBlocked(monitor('while true; do cat .env; sleep 5; done'));
  assertAllowed(monitor('tail -f dev.log | grep --line-buffered ERROR'));
  assertAllowed(runHook(HOOK, fixture('pretooluse-monitor', { tool_input: { command: undefined, ws: { url: 'wss://example.com/x' } } })));
  assertBlocked(runHook(HOOK, fixture('pretooluse-monitor', { tool_input: { command: 42 } })));
});
