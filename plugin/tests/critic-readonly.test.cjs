'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, rawFixture, runHook } = require('./helpers.cjs');

const HOOK = 'critic-readonly.cjs';
const TAG = 'guard: eng-standard critic-readonly';

function asAgent(command, agentType = 'eng-standard:critic') {
  return runHook(HOOK, fixture('pretooluse-bash-subagent', { agent_type: agentType, tool_input: { command } }));
}
function assertAllowed(r, label) {
  assert.equal(r.status, 0, `expected "${label}" to be allowed; stderr: ${r.stderr}`);
}
function assertBlocked(r, label) {
  assert.equal(r.status, 2, `expected "${label}" to be blocked; exit ${r.status}`);
  assert.match(r.stderr, new RegExp(TAG));
}

test('critic-readonly: other sessions and agents pass through untouched', () => {
  const builder = fixture('pretooluse-bash', { tool_input: { command: 'rm -rf build && pnpm install' } });
  assertAllowed(runHook(HOOK, builder), 'main session');
  assertAllowed(asAgent('rm -rf build', 'general-purpose'), 'general-purpose subagent');
  assertAllowed(asAgent('rm -rf build', 'critic'), 'a project agent that is not the plugin critic');
});

test('critic-readonly: the critic may run read-only git, file utilities, tests, and typecheck', () => {
  for (const cmd of [
    'git diff main...HEAD',
    'git -C . log --oneline -5',
    'git show HEAD:src/app.ts',
    'git status 2>/dev/null',
    'git branch',
    'git branch --contains abc123',
    'git stash list',
    'git config --get user.name',
    'git ls-files | grep migrations',
    'cat src/app.ts | head -20',
    'grep -rn "createClient" src',
    'find . -name "*.sql" -type f',
    'ls -la supabase/migrations',
    'wc -l src/*.ts',
    'cd src && git log -3',
    'pnpm test',
    'pnpm run test:integration',
    'pnpm run typecheck',
    'pnpm exec vitest run src/lib',
    'npm test',
  ]) assertAllowed(asAgent(cmd), cmd);
});

test('critic-readonly: the critic may not change files or run arbitrary code', () => {
  for (const cmd of [
    'rm -rf build',
    'git commit -F msg.txt',
    'git add src/app.ts',
    'git checkout -b fix',
    'git stash',
    'git branch fix-it',
    'git config --global user.name x',
    'git config user.name x',
    'git -c core.pager=sh log',
    'git diff --output=diff.txt',
    'git grep -Ovim TODO',
    'echo x > file.txt',
    'cat a >> b',
    'ls | tee listing.txt',
    "sed -i 's/a/b/' src/app.ts",
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} ;',
    'sort -o out.txt in.txt',
    'pnpm install',
    'pnpm run build',
    'pnpm run lint',
    'npm run gate',
    'node -e "require(\'fs\').writeFileSync(\'x\', \'y\')"',
    "bash -c 'ls'",
    'FOO=1 git log',
    'xargs rm < files.txt',
    'echo $(rm -rf x)',
    'curl https://example.com',
  ]) assertBlocked(asAgent(cmd), cmd);
});

test('critic-readonly: the security-reviewer agent gets the same limits', () => {
  assertAllowed(asAgent('git log -p -- supabase/migrations', 'eng-standard:security-reviewer'), 'git log');
  assertBlocked(asAgent('git push origin main', 'eng-standard:security-reviewer'), 'git push');
});

test('critic-readonly: fails closed on input it cannot parse', () => {
  assertBlocked(runHook(HOOK, rawFixture('malformed.txt')), 'malformed payload');
  assertBlocked(runHook(HOOK, ''), 'empty payload');
  assertBlocked(asAgent('cat "unterminated'), 'unparseable command');
  assertBlocked(runHook(HOOK, fixture('pretooluse-bash-subagent', { tool_input: { command: null } })), 'missing command');
});

// Critic v0.1.0, CR-11: options that run commands or write files, in every
// spelling the report lists.
test('critic-readonly CR-11: abbreviations, clusters, attached values, snapshot updates, and tsc writes are blocked', () => {
  for (const cmd of [
    'git grep --open=touch a',
    "git grep --open='touch pager-ran.txt' -e zz",
    'git grep --open-files-in-pager=x -e a',
    'git grep -nOtouch a',
    'git grep -O -e a',
    'git diff --ou=diff.txt',
    'git log --ext-diff -p',
    'git show --textconv HEAD:a.bin',
    'sort -oFILE in.txt',
    'sort -ro out.txt in.txt',
    'sort --out=out.txt in.txt',
    'tree -o tree.txt',
    'tree -R -H . ',
    'date -s 2020-01-01',
    'pnpm test -- -u',
    'pnpm test -u',
    'npm test -- -u',
    'pnpm run test:unit -- --update',
    'pnpm exec vitest run -u',
    'pnpm exec vitest run --update',
    'pnpm test -- --updateSnapshot',
    'pnpm test -- --outputFile=report.json',
    'pnpm exec tsc --noEmit --generateTrace trace-dir',
    'pnpm exec tsc',
    'pnpm exec tsc -p tsconfig.json',
    'pnpm exec tsc --noEmit false',
    'pnpm exec tsc --noEmit --build',
    'pnpm exec tsc --noEmit --watch',
    'pnpm run typecheck --generateTrace trace-dir',
    'pnpm run typecheck -- --noEmit false',
  ]) assertBlocked(asAgent(cmd), cmd);
  for (const cmd of [
    'git diff --text main...HEAD',
    'git log -S createClient --oneline',
    'git grep -n -e createClient',
    'git grep -e Object -- src',
    'sort -r names.txt',
    'tree -L 2',
    'pnpm test -- -t "rejects other tenants"',
    'pnpm exec vitest run src/lib --reporter=dot',
    'pnpm exec tsc --noEmit',
    'pnpm exec tsc --noEmit -p tsconfig.json',
    'pnpm exec tsc --noemit',
    'pnpm run typecheck',
  ]) assertAllowed(asAgent(cmd), cmd);
});

test('critic-readonly CR-3: Monitor commands from a review agent get the same allowlist', () => {
  const monitor = (command) => runHook(HOOK, fixture('pretooluse-monitor', { agent_type: 'eng-standard:critic', tool_input: { command } }));
  assertBlocked(monitor('touch reviewed.txt'), 'Monitor touch');
  assertBlocked(monitor('git grep --open=true a'), 'Monitor git grep --open');
  assertAllowed(monitor('git log --oneline -5'), 'Monitor git log');
  assertAllowed(runHook(HOOK, fixture('pretooluse-monitor', { agent_type: 'eng-standard:critic', tool_input: { command: undefined, ws: { url: 'wss://example.com/x' } } })), 'Monitor WebSocket');
});
