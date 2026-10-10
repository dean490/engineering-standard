'use strict';
// The CI check scripts in templates/scripts/, run against throwaway git
// repositories the way the CI templates run them. Tests named after a finding
// of the second Critic pass (R2-n, .recon/critic-v0.1.0-r2/REPORT.md) replay
// its reproduction.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'templates', 'scripts');
const REGISTRY = path.join(__dirname, 'fixtures', 'registry');

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (content === null) { fs.rmSync(p, { force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}
function commit(dir, files, message = 'change') {
  write(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}
// A repository with "main" holding base, and a branch "pr" checked out.
function repo(base = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-standard-ci-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'eng-standard tests');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', '/dev/null');
  commit(dir, { 'README.md': '# x\n', ...base }, 'base');
  git(dir, 'checkout', '-q', '-b', 'pr');
  return dir;
}
function run(dir, script, args = [], env = {}, scriptsDir = SCRIPTS) {
  const r = spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const j = (...parts) => parts.join('');

// Without yq the two pinning-check tests skip on a developer machine. In CI
// (GitHub Actions sets CI=true) a missing yq fails them: the ubuntu-24.04
// runner image has yq, and a skipped check there would pass for the wrong reason.
function skipOrFailWithoutYq(t) {
  const why = 'yq v4 is not installed (YQ or yq on PATH); the ubuntu-24.04 runner image has it';
  if (process.env.CI) assert.fail(`${why}; in CI the pinning check must run, not skip`);
  t.skip(why);
}

// yq for the pinning check: YQ, or yq on PATH.
function findYq() {
  const candidates = [process.env.YQ, 'yq'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /version v4\./.test(r.stdout)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Migrations are append-only

test('check-migrations-append-only: additions pass; a modified, deleted, or renamed migration fails', () => {
  const M1 = 'supabase/migrations/20260101000000_init.sql';
  for (const [change, ok, pattern] of [
    [{ 'supabase/migrations/20260102000000_items.sql': 'create table items ();\n' }, true, /1 added/],
    [{ [M1]: 'create table plans (id uuid);\n' }, false, /^M\t/m],
    [{ [M1]: null }, false, /^D\t/m],
    [{ [M1]: null, 'supabase/migrations/20260101000000_renamed.sql': 'create table plans ();\n' }, false, /^D\t/m],
    [{ 'src/app.ts': 'export {};\n' }, true, /0 added/],
  ]) {
    const dir = repo({ [M1]: 'create table plans ();\n' });
    commit(dir, change);
    const r = run(dir, 'check-migrations-append-only.mjs', ['main']);
    assert.equal(r.status, ok ? 0 : 1, r.out);
    assert.match(r.out, pattern);
  }
  const dir = repo();
  assert.equal(run(dir, 'check-migrations-append-only.mjs', ['no-such-branch']).status, 2);
  assert.equal(run(dir, 'check-migrations-append-only.mjs', []).status, 2);
});

test('R2-10 check-migrations-append-only: an added migration must be newer than every shipped one', () => {
  const shipped = { 'supabase/migrations/20260101000000_init.sql': 'select 1;\n', 'supabase/migrations/20260301000000_second.sql': 'select 2;\n' };
  // The Critic's reproduction: a migration dated between two shipped ones.
  let dir = repo(shipped);
  commit(dir, { 'supabase/migrations/20260201000000_inserted.sql': 'select 3;\n' });
  let r = run(dir, 'check-migrations-append-only.mjs', ['main']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /out of order: supabase\/migrations\/20260201000000_inserted\.sql is not newer than supabase\/migrations\/20260301000000_second\.sql/);
  // The same version as a shipped one is not newer either.
  dir = repo(shipped);
  commit(dir, { 'supabase/migrations/20260301000000_same_version.sql': 'select 3;\n' });
  assert.equal(run(dir, 'check-migrations-append-only.mjs', ['main']).status, 1);
  // Control: a newer one passes; files that aren't top-level migrations don't count.
  dir = repo(shipped);
  commit(dir, { 'supabase/migrations/20260401000000_third.sql': 'select 3;\n', 'supabase/migrations/README.md': 'notes\n' });
  r = run(dir, 'check-migrations-append-only.mjs', ['main']);
  assert.equal(r.status, 0, r.out);
  // The base branch moved on after the pull request branched: its newer
  // migration makes the pull request's one out of order.
  dir = repo(shipped);
  commit(dir, { 'supabase/migrations/20260401000000_on_pr.sql': 'select 4;\n' });
  git(dir, 'checkout', '-q', 'main');
  commit(dir, { 'supabase/migrations/20260501000000_on_main.sql': 'select 5;\n' });
  git(dir, 'checkout', '-q', 'pr');
  r = run(dir, 'check-migrations-append-only.mjs', ['main']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /20260401000000_on_pr\.sql is not newer than supabase\/migrations\/20260501000000_on_main\.sql/);
});

test('R2-9 check-migrations-append-only: push mode compares the commit before the push with the commit pushed', () => {
  const M1 = 'supabase/migrations/20260101000000_init.sql';
  const dir = repo({ [M1]: 'create table plans ();\n' });
  git(dir, 'checkout', '-q', 'main');
  const before = git(dir, 'rev-parse', 'HEAD').trim();
  commit(dir, { 'supabase/migrations/20260201000000_second.sql': 'select 2;\n' }, 'second migration ships');
  commit(dir, { [M1]: 'create table plans (id uuid);\n' }, 'edit shipped migration');
  commit(dir, { 'docs/notes.md': 'x\n' }, 'docs');
  // The old push-mode comparison (HEAD^ HEAD) saw only the last commit.
  const lastOnly = run(dir, 'check-migrations-append-only.mjs', ['HEAD^', 'HEAD']);
  assert.equal(lastOnly.status, 0, lastOnly.out);
  // ci.yml now passes github.event.before and github.sha.
  const whole = run(dir, 'check-migrations-append-only.mjs', [before, 'HEAD']);
  assert.equal(whole.status, 1, whole.out);
  assert.match(whole.out, /^M\tsupabase\/migrations\/20260101000000_init\.sql$/m);
});

// ---------------------------------------------------------------------------
// Test integrity

test('check-test-integrity: .only, .skip, todo, x- and f-prefixed tests, and deleted test files fail', () => {
  for (const [change, ok] of [
    [{ 'src/plan.test.ts': "it('a', () => {});\nit('b', () => {});\n" }, true],
    [{ 'src/plan.test.ts': "it.only('a', () => {});\n" }, false],
    [{ 'src/plan.test.ts': "describe.skip('x', () => {});\n" }, false],
    [{ 'src/plan.test.ts': "it.todo('later');\n" }, false],
    [{ 'src/plan.test.ts': "xit('a', () => {});\n" }, false],
    [{ 'tests/e2e/flow.spec.ts': "xdescribe('flow', () => {});\n" }, false],
    [{ 'src/plan.test.ts': "it.skipIf(ci)('a', () => {});\n" }, false],
    [{ 'src/plan.test.ts': null }, false],
    [{ 'src/plan.ts': 'export const skip = (n) => list.skip(n);\n' }, true],
  ]) {
    const dir = repo({ 'src/plan.test.ts': "it('a', () => {});\n", 'tests/e2e/flow.spec.ts': "describe('flow', () => {});\n" });
    commit(dir, change);
    const summary = path.join(dir, '..', `${path.basename(dir)}-summary.md`);
    const r = run(dir, 'check-test-integrity.mjs', ['main'], { GITHUB_STEP_SUMMARY: summary });
    assert.equal(r.status, ok ? 0 : 1, `${JSON.stringify(change)}\n${r.out}`);
    assert.match(fs.readFileSync(summary, 'utf8'), ok ? /passed/ : /failed/);
  }
});

test('R2-5 check-test-integrity: any .only/.skip/.todo/.fails member access, runIf( and skipIf( fail', () => {
  const weakening = [
    "it.skip.each([1, 2])('a %i', () => {});",
    "describe.only.each([1])('d', () => {});",
    "it.fails('inverted', () => { throw new Error('x'); });",
    "it.runIf(false)('never', () => {});",
    "it.skip.concurrent('a', async () => {});",
    'const later = test.todo;',
    "it['only']('bracket', () => {});",
    "test.skipIf(process.env.CI)('local only', () => {});",
    "describe . skip ('spaced', () => {});",
  ];
  for (const line of weakening) {
    const dir = repo({ 'src/math.test.ts': "it('adds', () => {});\n" });
    commit(dir, { 'src/math.test.ts': `it('adds', () => {});\n${line}\n` });
    const r = run(dir, 'check-test-integrity.mjs', ['main']);
    assert.equal(r.status, 1, `${line}\n${r.out}`);
  }
  // Control: ordinary test code and lookalikes don't count.
  for (const line of ["const skipped = results.filter((r) => r.skipped);", "expect(onlyOne).toBe(1);", "it.each([1])('ok %i', () => {});"]) {
    const dir = repo({ 'src/math.test.ts': "it('adds', () => {});\n" });
    commit(dir, { 'src/math.test.ts': `it('adds', () => {});\n${line}\n` });
    const r = run(dir, 'check-test-integrity.mjs', ['main']);
    assert.equal(r.status, 0, `${line}\n${r.out}`);
  }
});

// ---------------------------------------------------------------------------
// Sensitive change

test('check-sensitive-change: scripts, .github, .githooks, settings, gitleaks, pnpm settings, and check scripts fail', () => {
  const base = {
    'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { lint: 'eslint .', test: 'vitest run' } }, null, 2),
    'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { build: 'next build' } }),
    'src/app.ts': 'export {};\n',
  };
  for (const [change, ok, pattern] of [
    [{ 'src/app.ts': 'export const x = 1;\n' }, true, /none/],
    [{ 'package.json': JSON.stringify({ name: 'x', version: '1.1.0', scripts: { test: 'vitest run', lint: 'eslint .' } }, null, 2) }, true, /none/],
    [{ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { lint: 'true', test: 'vitest run' } }, null, 2) }, false, /package\.json scripts: package\.json/],
    [{ 'apps/web/package.json': JSON.stringify({ name: 'web', scripts: { build: 'echo skip' } }) }, false, /apps\/web\/package\.json/],
    [{ '.github/workflows/ci.yml': 'name: CI\n' }, false, /GitHub configuration/],
    [{ '.github/workflows/guards.yml': 'name: Guards\n' }, false, /GitHub configuration/],
    [{ '.github/actions/setup/action.yml': 'runs: {}\n' }, false, /GitHub configuration/],
    [{ '.githooks/pre-commit': 'exit 0\n' }, false, /git hook/],
    [{ '.claude/settings.json': '{}\n' }, false, /agent settings/],
    [{ '.gitleaks.toml': '[allowlist]\n' }, false, /secret-scan configuration/],
    [{ '.gitleaksignore': 'abc:x:rule:1\n' }, false, /secret-scan configuration/],
    [{ 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n' }, false, /supply-chain/],
    [{ 'scripts/check-rls.mjs': 'process.exit(0)\n' }, false, /CI check script/],
    [{ 'scripts/check-release-age.mjs': 'process.exit(0)\n' }, false, /CI check script/],
    [{ 'scripts/check-action-pins.mjs': 'process.exit(0)\n' }, false, /CI check script/],
    [{ 'scripts/check-migrations-append-only.mjs': 'process.exit(0)\n' }, false, /CI check script/],
    [{ 'src/app.ts': 'const k = "x"; // gitleaks:allow\n' }, false, /gitleaks:allow added: src\/app\.ts/],
  ]) {
    const dir = repo(base);
    commit(dir, change);
    const r = run(dir, 'check-sensitive-change.mjs', ['main']);
    assert.equal(r.status, ok ? 0 : 1, `${JSON.stringify(change)}\n${r.out}`);
    assert.match(r.out, pattern);
  }
  // Removing a gitleaks:allow line is not an addition.
  const dir = repo({ ...base, 'src/old.ts': 'const k = "x"; // gitleaks:allow\n' });
  commit(dir, { 'src/old.ts': 'const k = "x";\n' });
  assert.equal(run(dir, 'check-sensitive-change.mjs', ['main']).status, 0);
});

test('R2-5 check-sensitive-change: test-runner, TypeScript, lint configuration and supabase/config.toml, at any depth', () => {
  for (const [file, pattern] of [
    ['vitest.config.ts', /test-runner configuration: A vitest\.config\.ts/],
    ['apps/web/vitest.config.mts', /test-runner configuration/],
    ['vitest.workspace.ts', /test-runner configuration/],
    ['playwright.config.ts', /test-runner configuration/],
    ['jest.config.js', /test-runner configuration/],
    ['tsconfig.json', /TypeScript configuration/],
    ['apps/web/tsconfig.build.json', /TypeScript configuration/],
    ['packages/db/tsconfig.json', /TypeScript configuration/],
    ['eslint.config.mjs', /lint configuration/],
    ['apps/web/.eslintrc.json', /lint configuration/],
    ['supabase/config.toml', /Supabase configuration/],
  ]) {
    const dir = repo();
    commit(dir, { [file]: 'export default { test: { exclude: ["src/**"], passWithNoTests: true } };\n' });
    const r = run(dir, 'check-sensitive-change.mjs', ['main']);
    assert.equal(r.status, 1, `${file}\n${r.out}`);
    assert.match(r.out, pattern);
  }
  // next.config.* is not on the list: the gate runs typecheck and lint as their own steps.
  const dir = repo();
  commit(dir, { 'next.config.ts': 'export default { typescript: { ignoreBuildErrors: true } };\n' });
  assert.equal(run(dir, 'check-sensitive-change.mjs', ['main']).status, 0);
});

// ---------------------------------------------------------------------------
// R2-6: paths git quotes

test('R2-6 non-ASCII paths: Test integrity, Sensitive change, and Migrations are append-only read them as they are', () => {
  const base = {
    'src/café/menu.test.ts': "it('lists', () => {});\n",
    'packages/naïve/package.json': JSON.stringify({ name: 'naive', scripts: { test: 'vitest run' } }),
    'supabase/migrations/20260101000000_crème.sql': 'select 1;\n',
    'src/spaced name "quoted"/a.test.ts': "it('a', () => {});\n",
  };
  // The Critic's reproduction: git prints these paths quoted by default.
  let dir = repo(base);
  commit(dir, { 'src/café/menu.test.ts': "it.only('lists', () => {});\n" });
  assert.match(git(dir, 'diff', '--name-status', 'main...HEAD'), /"src\/caf\\303\\251\/menu\.test\.ts"/);
  let r = run(dir, 'check-test-integrity.mjs', ['main']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /src\/café\/menu\.test\.ts: adds "it\.only/);

  dir = repo(base);
  commit(dir, { 'src/café/menu.test.ts': null });
  r = run(dir, 'check-test-integrity.mjs', ['main']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /deleted test file: src\/café\/menu\.test\.ts/);

  dir = repo(base);
  commit(dir, { 'src/spaced name "quoted"/a.test.ts': "it.skip('a', () => {});\n" });
  r = run(dir, 'check-test-integrity.mjs', ['main']);
  assert.equal(r.status, 1, r.out);

  dir = repo(base);
  commit(dir, { 'packages/naïve/package.json': JSON.stringify({ name: 'naive', scripts: { test: 'true' } }) });
  r = run(dir, 'check-sensitive-change.mjs', ['main']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /package\.json scripts: packages\/naïve\/package\.json/);

  dir = repo(base);
  commit(dir, { '.github/workflows/nïghtly.yml': 'name: x\n', 'src/naïve.ts': 'const k = 1; // gitleaks:allow\n' });
  r = run(dir, 'check-sensitive-change.mjs', ['main']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /GitHub configuration: A \.github\/workflows\/nïghtly\.yml/);
  assert.match(r.out, /gitleaks:allow added: src\/naïve\.ts/);

  dir = repo(base);
  commit(dir, { 'supabase/migrations/20260101000000_crème.sql': 'select 2;\n' });
  r = run(dir, 'check-migrations-append-only.mjs', ['main']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^M\tsupabase\/migrations\/20260101000000_crème\.sql$/m);
});

// ---------------------------------------------------------------------------
// R2-2: the base branch's copies judge the pull request head

test('R2-2 the base branch\'s check scripts flag a pull request that also replaces them', () => {
  // main holds the template's scripts; the pull request edits a shipped
  // migration, package.json scripts, and both check scripts that would catch it.
  const scripts = Object.fromEntries(fs.readdirSync(SCRIPTS).map((f) => [`scripts/${f}`, fs.readFileSync(path.join(SCRIPTS, f))]));
  const M1 = 'supabase/migrations/20260101000000_init.sql';
  const dir = repo({ ...scripts, [M1]: 'create table plans ();\n', 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }) });
  commit(dir, {
    [M1]: 'create table plans (id uuid);\n',
    'package.json': JSON.stringify({ name: 'x', scripts: { test: 'true' } }),
    'scripts/check-migrations-append-only.mjs': "console.log('Migrations are append-only: 0 added');\n",
    'scripts/check-sensitive-change.mjs': "console.log('### Sensitive change: none');\n",
  });
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  // The pull request's own copies pass: what ci.yml ran before brief 04.
  const prScripts = path.join(dir, 'scripts');
  assert.equal(run(dir, 'check-migrations-append-only.mjs', ['main'], {}, prScripts).status, 0);
  assert.equal(run(dir, 'check-sensitive-change.mjs', ['main'], {}, prScripts).status, 0);
  // guards.yml: check out the base branch, fetch the head as git data, and run
  // the base branch's copies against base...head.
  const baseCheckout = `${dir}-base`;
  git(dir, 'worktree', 'add', '-q', '--detach', baseCheckout, 'main');
  const baseScripts = path.join(baseCheckout, 'scripts');
  const mig = run(baseCheckout, 'check-migrations-append-only.mjs', ['main', head], {}, baseScripts);
  assert.equal(mig.status, 1, mig.out);
  assert.match(mig.out, /^M\tsupabase\/migrations\/20260101000000_init\.sql$/m);
  const sens = run(baseCheckout, 'check-sensitive-change.mjs', ['main', head], {}, baseScripts);
  assert.equal(sens.status, 1, sens.out);
  assert.match(sens.out, /package\.json scripts: package\.json/);
  assert.match(sens.out, /CI check script: M scripts\/check-migrations-append-only\.mjs/);
  assert.match(sens.out, /CI check script: M scripts\/check-sensitive-change\.mjs/);
});

// ---------------------------------------------------------------------------
// Client bundle (a backstop, STANDARD 4.2)

test('check-client-bundle: a secret key, a service_role JWT, or a public variable named for one fails; supabase-js code passes', () => {
  const jwt = (claims) => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${crypto.randomBytes(24).toString('base64url')}`;
  const SUPABASE_JS = 'jn=e=>e.startsWith(`sb_publishable_`)||e.startsWith(`sb_secret_`),Mn=new Set;';
  for (const [files, ok, pattern] of [
    [{ '.next/static/chunks/app.js': `${SUPABASE_JS}const a=${JSON.stringify(jwt({ iss: 'supabase', role: 'anon' }))};` }, true, /passed/],
    [{ '.next/static/chunks/app.js': `const k="${j('sb_sec', 'ret_', 'AbCdEfGhIjKlMnOpQrStUv12')}";` }, false, /Supabase secret key/],
    [{ '.next/static/chunks/app.js': `const k="${jwt({ iss: 'supabase', role: 'service_role' })}";` }, false, /role service_role/],
    [{ '.next/static/chunks/app.js': 'const r="service_role";' }, false, /the text "service_role"/],
    [{ '.next/static/chunks/app.js': 'x', '.env.example': `${j('NEXT_PUBLIC_', 'SUPABASE_SERVICE_ROLE_KEY')}=\n` }, false, /browser-exposed variable/],
    [{ '.next/static/chunks/app.js': 'x', 'src/lib/admin.ts': `const k = process.env.${j('NEXT_PUBLIC_', 'SUPABASE_SECRET_KEY')};\n` }, false, /browser-exposed variable/],
    [{ '.next/static/chunks/app.js': 'x', 'src/lib/db.ts': 'const u = process.env.NEXT_PUBLIC_SUPABASE_URL;\n' }, true, /passed/],
  ]) {
    const dir = repo();
    const tracked = Object.fromEntries(Object.entries(files).filter(([k]) => !k.startsWith('.next/')));
    commit(dir, tracked);
    write(dir, Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith('.next/'))));
    const r = run(dir, 'check-client-bundle.mjs');
    assert.equal(r.status, ok ? 0 : 1, `${JSON.stringify(files)}\n${r.out}`);
    assert.match(r.out, pattern);
  }
  const dir = repo();
  assert.equal(run(dir, 'check-client-bundle.mjs').status, 2, 'no bundle directory');
  assert.equal(run(dir, 'check-client-bundle.mjs', [], { CLIENT_BUNDLE_DIR: 'none' }).status, 0);
  write(dir, { 'dist/assets/a.js': 'const r="SERVICE_ROLE";' });
  assert.equal(run(dir, 'check-client-bundle.mjs', [], { CLIENT_BUNDLE_DIR: 'dist/assets' }).status, 1);
});

// ---------------------------------------------------------------------------
// Row-level security

test('check-rls: tables without row-level security in an exposed schema fail (recorded query results)', () => {
  const dir = repo({ 'supabase/config.toml': '[api]\nenabled = true\nschemas = [\n  "public",\n  "graphql_public",\n  "api",\n]\n\n[db]\nport = 54322\n' });
  write(dir, { 'none.tsv': '', 'one.tsv': 'public\tshopping_lists\tr\n', 'two.tsv': 'public\tshopping_lists\tr\napi\tnotes\tp\n' });
  const ok = run(dir, 'check-rls.mjs', ['--rows', 'none.tsv']);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /public, graphql_public, api/);
  const one = run(dir, 'check-rls.mjs', ['--rows', 'one.tsv']);
  assert.equal(one.status, 1);
  assert.match(one.out, /- public\.shopping_lists: row-level security disabled/);
  assert.match(run(dir, 'check-rls.mjs', ['--rows', 'two.tsv']).out, /2 object\(s\)/);
  const plain = repo();
  write(plain, { 'none.tsv': '' });
  assert.match(run(plain, 'check-rls.mjs', ['--rows', 'none.tsv']).out, /in public, graphql_public\./, 'Supabase default schemas');
  write(plain, { 'supabase/config.toml': '[api]\nschemas = ["public; drop table x"]\n' });
  assert.equal(run(plain, 'check-rls.mjs', ['--rows', 'none.tsv']).status, 2, 'a schema name that is not an identifier is refused');
  const live = run(plain, 'check-rls.mjs', [], { PATH: path.dirname(process.execPath), DB_URL: 'postgresql://127.0.0.1:1/none' });
  assert.equal(live.status, 2, 'no psql or no database: the check fails');
});

test('R2-7 check-rls: public and graphql_public are always checked; views, materialized views, and foreign tables count', () => {
  // The Critic's reproduction: narrowing [api] schemas no longer drops public.
  for (const schemas of ['["graphql_public"]', '["nothing_here"]', '[]']) {
    const dir = repo({ 'supabase/config.toml': `[api]\nschemas = ${schemas}\n` });
    write(dir, { 'rows.tsv': 'public\tnotes\tr\n' });
    const r = run(dir, 'check-rls.mjs', ['--rows', 'rows.tsv']);
    assert.equal(r.status, 1, `${schemas}\n${r.out}`);
    assert.match(r.out, /\(public, graphql_public/);
  }
  // A psql stand-in that prints the schema filter the query names, so the
  // test sees which schemas the real query would cover.
  const dir = repo({ 'supabase/config.toml': '[api]\nschemas = ["api"]\n' });
  const bin = path.join(dir, '..', `${path.basename(dir)}-bin`);
  write(bin, { psql: '#!/bin/sh\nfor a; do q="$a"; done\nprintf "%s" "$q" | grep -o "nspname in ([^)]*)" >&2\nexit 0\n' });
  fs.chmodSync(path.join(bin, 'psql'), 0o755);
  const live = run(dir, 'check-rls.mjs', [], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(live.status, 0, live.out);
  assert.match(live.out, /nspname in \('public', 'graphql_public', 'api'\)/);
  // Recorded rows for each kind of object the query reports.
  write(dir, { 'rows.tsv': 'public\tall_notes\tv\npublic\tnote_counts\tm\napi\tremote_notes\tf\n' });
  const r = run(dir, 'check-rls.mjs', ['--rows', 'rows.tsv']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /public\.all_notes: a view without security_invoker = true/);
  assert.match(r.out, /public\.note_counts: a materialized view that anon or authenticated can select/);
  assert.match(r.out, /api\.remote_notes: a foreign table that anon or authenticated can select/);
  // The query itself names each case.
  const src = fs.readFileSync(path.join(SCRIPTS, 'check-rls.mjs'), 'utf8');
  assert.match(src, /c\.relkind = 'v' and not coalesce\(/);
  assert.match(src, /option_name = 'security_invoker'/);
  assert.match(src, /c\.relkind in \('m', 'f'\)/);
  assert.match(src, /has_any_column_privilege/);
});

// ---------------------------------------------------------------------------
// Release age

const LOCK = (pkgs) => [
  "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '',
  'importers:', '', '  .:', '    dependencies: {}', '', 'packages:', '',
  ...pkgs.flatMap(([id, extra = '']) => [`  ${id}:${extra}`, '    resolution: {integrity: sha512-x}', '']),
  'snapshots:', '', ...pkgs.map(([id]) => `  ${id}: {}`), '',
].join('\n');
const WORKSPACE = (exclude = '[]') => `minimumReleaseAge: 10080\nminimumReleaseAgeExclude: ${exclude}\nallowBuilds: {}\n`;

test('R2-8 check-release-age: a version younger than minimumReleaseAge fails; old, excluded, and unchanged ones pass', () => {
  const env = (now) => ({ REGISTRY_DATA: REGISTRY, NOW: now });
  // is-number@7.0.0 was published 2018-07-04T15:08:58.238Z (recorded registry response).
  const dir = repo({ 'pnpm-workspace.yaml': WORKSPACE(), 'pnpm-lock.yaml': LOCK([['is-number@6.0.0']]) });
  commit(dir, { 'pnpm-lock.yaml': LOCK([['is-number@6.0.0'], ['is-number@7.0.0']]) });
  let r = run(dir, 'check-release-age.mjs', ['main'], env('2018-07-07T15:08:58Z'));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is-number@7\.0\.0: published 2018-07-04T15:08:58\.238Z, 3\.0 days ago, younger than 10080 minutes/);
  r = run(dir, 'check-release-age.mjs', ['main'], env('2018-07-11T15:09:00Z'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /1 package version\(s\) added/);
  // A scoped package, quoted in the lockfile as pnpm writes it.
  // @sindresorhus/is@8.1.0 was published 2026-05-11T11:22:36.268Z.
  const scoped = repo({ 'pnpm-workspace.yaml': WORKSPACE(), 'pnpm-lock.yaml': LOCK([]) });
  commit(scoped, { 'pnpm-lock.yaml': LOCK([["'@sindresorhus/is@8.1.0'"]]) });
  r = run(scoped, 'check-release-age.mjs', ['main'], env('2026-05-12T00:00:00Z'));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /@sindresorhus\/is@8\.1\.0/);
  // minimumReleaseAgeExclude on the base branch, by name, pattern, or version.
  for (const exclude of ['[is-number]', "['is-*']", '\n  - is-number@7.0.0', "\n  - 'is-number@5.0.0 || 7.0.0'"]) {
    const ex = repo({ 'pnpm-workspace.yaml': WORKSPACE(exclude), 'pnpm-lock.yaml': LOCK([]) });
    commit(ex, { 'pnpm-lock.yaml': LOCK([['is-number@7.0.0']]) });
    r = run(ex, 'check-release-age.mjs', ['main'], env('2018-07-05T00:00:00Z'));
    assert.equal(r.status, 0, `${exclude}\n${r.out}`);
  }
  // The pull request's own pnpm-workspace.yaml doesn't count: the base's does.
  const own = repo({ 'pnpm-workspace.yaml': WORKSPACE(), 'pnpm-lock.yaml': LOCK([]) });
  commit(own, { 'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n', 'pnpm-lock.yaml': LOCK([['is-number@7.0.0']]) });
  assert.equal(run(own, 'check-release-age.mjs', ['main'], env('2018-07-05T00:00:00Z')).status, 1);
});

test('R2-8 check-release-age: versions it can\'t date fail; a missing setting or unknown lockfile stops the check', () => {
  const env = { REGISTRY_DATA: REGISTRY, NOW: '2026-10-08T00:00:00Z' };
  let dir = repo({ 'pnpm-workspace.yaml': WORKSPACE(), 'pnpm-lock.yaml': LOCK([]) });
  commit(dir, { 'pnpm-lock.yaml': LOCK([['left-pad@https://example.invalid/left-pad-1.0.0.tgz'], ['is-number@99.0.0']]) });
  let r = run(dir, 'check-release-age.mjs', ['main'], env);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /left-pad@https:\/\/example\.invalid\/left-pad-1\.0\.0\.tgz: not a registry version/);
  assert.match(r.out, /is-number@99\.0\.0: the registry has no publish time/);
  // No lockfile change: nothing to check.
  dir = repo({ 'pnpm-workspace.yaml': WORKSPACE(), 'pnpm-lock.yaml': LOCK([['is-number@7.0.0']]) });
  commit(dir, { 'src/a.ts': 'export {};\n' });
  assert.equal(run(dir, 'check-release-age.mjs', ['main'], env).status, 0);
  // The base has no minimumReleaseAge, or the lockfile isn't version 9.
  dir = repo({ 'pnpm-workspace.yaml': 'allowBuilds: {}\n', 'pnpm-lock.yaml': LOCK([]) });
  commit(dir, { 'pnpm-lock.yaml': LOCK([['is-number@7.0.0']]) });
  assert.equal(run(dir, 'check-release-age.mjs', ['main'], env).status, 2);
  dir = repo({ 'pnpm-workspace.yaml': WORKSPACE(), 'pnpm-lock.yaml': "lockfileVersion: '6.0'\n" });
  commit(dir, { 'pnpm-lock.yaml': "lockfileVersion: '6.0'\npackages:\n  /is-number@7.0.0:\n    resolution: {}\n" });
  assert.equal(run(dir, 'check-release-age.mjs', ['main'], env).status, 2);
  // A package the recorded data doesn't have: the registry can't be read.
  dir = repo({ 'pnpm-workspace.yaml': WORKSPACE(), 'pnpm-lock.yaml': LOCK([]) });
  commit(dir, { 'pnpm-lock.yaml': LOCK([['not-recorded@1.0.0']]) });
  assert.equal(run(dir, 'check-release-age.mjs', ['main'], env).status, 2);
});

// ---------------------------------------------------------------------------
// Actions pinned to commit SHAs

test('check-action-pins: unpinned actions, docker tags, and unpinned local composite actions fail', (t) => {
  const yq = findYq();
  if (!yq) { skipOrFailWithoutYq(t); return; }
  const SHA = 'a'.repeat(40);
  const DIGEST = 'b'.repeat(64);
  for (const [files, ok] of [
    [{ '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n      - uses: ./.github/actions/setup\n`, '.github/actions/setup/action.yml': 'runs:\n  using: composite\n  steps: []\n' }, true],
    [{ '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n' }, false],
    [{ '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: docker://alpine:latest\n' }, false],
    [{ '.github/workflows/ci.yml': `jobs:\n  a:\n    steps:\n      - uses: docker://alpine@sha256:${DIGEST}\n` }, true],
    [{ '.github/workflows/ci.yml': 'jobs: {}\n', '.github/actions/setup/action.yml': 'runs:\n  using: composite\n  steps:\n    - uses: some/action@v1\n' }, false],
    [{ '.github/workflows/ci.yml': 'jobs: {}\n', '.github/actions/setup/action.yaml': `runs:\n  using: composite\n  steps:\n    - uses: "some/action@${SHA}"\n` }, true],
    [{ '.github/workflows/ci.yml': 'jobs: {}\n', '.github/actions/img/action.yml': 'runs:\n  using: docker\n  image: docker://alpine:3\n' }, false],
    [{ '.github/workflows/ci.yml': 'jobs: {}\n', '.github/actions/img/action.yml': 'runs:\n  using: docker\n  image: Dockerfile\n' }, true],
  ]) {
    const dir = repo(files);
    const r = run(dir, 'check-action-pins.mjs', [], { YQ: yq });
    assert.equal(r.status, ok ? 0 : 1, `${JSON.stringify(files)}\n${r.out}`);
  }
  const empty = repo();
  assert.equal(run(empty, 'check-action-pins.mjs', [], { YQ: yq }).status, 0);
  const noYq = repo({ '.github/workflows/ci.yml': 'jobs: {}\n' });
  assert.equal(run(noYq, 'check-action-pins.mjs', [], { YQ: path.join(noYq, 'no-such-yq') }).status, 2);
});

test('R2-12 check-action-pins: next-line values, quoted and escaped keys, spaces in names, anchors, and local actions anywhere', (t) => {
  const yq = findYq();
  if (!yq) { skipOrFailWithoutYq(t); return; }
  const SHA = 'c'.repeat(40);
  const pinned = `jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@${SHA} # v7\n`;
  for (const [label, files] of [
    ['uses: with its value on the next line', { '.github/workflows/next-line.yml': 'jobs:\n  a:\n    steps:\n      - uses:\n          some-owner/some-action@v1\n' }],
    ['a quoted "uses" key', { '.github/workflows/quoted.yml': 'jobs:\n  a:\n    steps:\n      - "uses": some-owner/some-action@v1\n' }],
    ['an escaped key that spells uses', { '.github/workflows/escaped.yml': 'jobs:\n  a:\n    steps:\n      - "u\\x73es": some-owner/some-action@v1\n' }],
    ['a flow mapping', { '.github/workflows/flow.yml': 'jobs: {a: {steps: [{uses: some-owner/some-action@v1}]}}\n' }],
    ['an anchor and alias', { '.github/workflows/anchor.yml': 'x: &unpinned some-owner/some-action@v1\njobs:\n  a:\n    steps:\n      - uses: *unpinned\n' }],
    ['a file name with a space', { '.github/workflows/nightly build.yml': 'jobs:\n  a:\n    steps:\n      - uses: some-owner/some-action@v1\n' }],
    ['a local action outside .github/actions', { '.github/workflows/local.yml': 'jobs:\n  a:\n    steps:\n      - uses: ./tools/setup\n', 'tools/setup/action.yml': 'runs:\n  using: composite\n  steps:\n    - uses: some-owner/some-action@v1\n' }],
    ['a local action that uses another local action', { '.github/workflows/local.yml': 'jobs:\n  a:\n    steps:\n      - uses: ./tools/a\n', 'tools/a/action.yml': 'runs:\n  using: composite\n  steps:\n    - uses: ./tools/b\n', 'tools/b/action.yaml': 'runs:\n  using: composite\n  steps:\n    - uses: some-owner/some-action@v1\n' }],
    ['a local action that does not exist', { '.github/workflows/local.yml': 'jobs:\n  a:\n    steps:\n      - uses: ./tools/missing\n' }],
    ['a reusable workflow at a tag', { '.github/workflows/call.yml': 'jobs:\n  a:\n    uses: some-owner/repo/.github/workflows/x.yml@v1\n' }],
    ['a uses: value that is not a string', { '.github/workflows/list.yml': 'jobs:\n  a:\n    steps:\n      - uses: [some-owner/some-action@v1]\n' }],
    ['a file yq cannot read', { '.github/workflows/broken.yml': 'jobs: [\n' }],
  ]) {
    const dir = repo({ '.github/workflows/ci.yml': pinned, ...files });
    const r = run(dir, 'check-action-pins.mjs', [], { YQ: yq });
    assert.equal(r.status, 1, `${label}\n${r.out}`);
  }
  // Controls: the same shapes, pinned.
  const ok = repo({
    '.github/workflows/ci.yml': pinned,
    '.github/workflows/next-line.yml': `jobs:\n  a:\n    steps:\n      - uses:\n          some-owner/some-action@${SHA}\n`,
    '.github/workflows/nightly build.yml': `jobs: {a: {steps: [{"uses": "some-owner/some-action@${SHA}"}]}}\n`,
    '.github/workflows/local.yml': 'jobs:\n  a:\n    steps:\n      - uses: ./tools/setup\n',
    'tools/setup/action.yml': `runs:\n  using: composite\n  steps:\n    - uses: some-owner/some-action@${SHA}\n`,
  });
  const r = run(ok, 'check-action-pins.mjs', [], { YQ: yq });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /in 5 files/);
  // --rev reads a commit, not the working tree (guards.yml checks the pull request head this way).
  const dir = repo({ '.github/workflows/ci.yml': pinned });
  commit(dir, { '.github/workflows/ci.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n' });
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  git(dir, 'checkout', '-q', 'main');
  assert.equal(run(dir, 'check-action-pins.mjs', [], { YQ: yq }).status, 0, 'working tree on main');
  assert.equal(run(dir, 'check-action-pins.mjs', ['--rev', head], { YQ: yq }).status, 1, 'the pull request head');
});
