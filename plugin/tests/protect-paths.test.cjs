'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { fixture, rawFixture, runHook, tempRepo, git, writeFiles } = require('./helpers.cjs');

const HOOK = 'protect-paths.cjs';
const TAG = 'guard: eng-standard protect-paths';
const MIGRATION = 'supabase/migrations/20260101000000_init.sql';

function repo() {
  return tempRepo({
    [MIGRATION]: 'create table plans (id uuid primary key);\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    '.github/workflows/ci.yml': 'name: CI\n',
    '.claude/settings.json': '{}\n',
    'src/app.ts': 'export const x = 1;\n',
  });
}

function edit(dir, rel, { tool = 'Edit', env = {} } = {}) {
  const payload = tool === 'Write'
    ? fixture('pretooluse-write', { cwd: dir, tool_input: { file_path: path.isAbsolute(rel) ? rel : path.join(dir, rel) } })
    : fixture('pretooluse-edit', { cwd: dir, tool_input: { file_path: path.isAbsolute(rel) ? rel : path.join(dir, rel) } });
  return runHook(HOOK, payload, { env: { CLAUDE_PROJECT_DIR: dir, ...env } });
}

function assertBlocked(r, pattern) {
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(TAG));
  if (pattern) assert.match(r.stderr, pattern);
}
function assertAllowed(r) {
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
}

test('protect-paths: allows ordinary files and new migrations', () => {
  const dir = repo();
  assertAllowed(edit(dir, 'src/app.ts'));
  assertAllowed(edit(dir, 'src/new-file.ts', { tool: 'Write' }));
  assertAllowed(edit(dir, 'supabase/migrations/20260102000000_add_items.sql', { tool: 'Write' }));
  assertAllowed(edit(dir, 'docs/SPEC.md'));
  assertAllowed(edit(dir, '/somewhere/else/entirely.txt'));
});

test('protect-paths: blocks shipped migrations, the lockfile, workflows, and agent settings', () => {
  const dir = repo();
  assertBlocked(edit(dir, MIGRATION), /shipped migration/);
  assertBlocked(edit(dir, MIGRATION, { tool: 'Write' }), /write a new migration/);
  assertBlocked(edit(dir, 'pnpm-lock.yaml', { tool: 'Write' }), /lockfile/);
  assertBlocked(edit(dir, 'package-lock.json', { tool: 'Write' }), /lockfile/);
  assertBlocked(edit(dir, '.github/workflows/ci.yml'), /CI workflow/);
  assertBlocked(edit(dir, '.github/workflows/new.yml', { tool: 'Write' }), /CI workflow/);
  assertBlocked(edit(dir, '.claude/settings.json'), /agent settings/);
});

test('protect-paths: a path listed in .recon/current-brief-paths.txt is allowed', () => {
  const dir = repo();
  writeFiles(dir, { '.recon/current-brief-paths.txt': `# brief 07\n${MIGRATION}\n./.github/workflows/ci.yml\n` });
  assertAllowed(edit(dir, MIGRATION));
  assertAllowed(edit(dir, '.github/workflows/ci.yml'));
  assertBlocked(edit(dir, 'pnpm-lock.yaml'), /lockfile/);
});

test('protect-paths: the permission list itself can never be edited', () => {
  const dir = repo();
  writeFiles(dir, { '.recon/current-brief-paths.txt': '.recon/current-brief-paths.txt\n' });
  assertBlocked(edit(dir, '.recon/current-brief-paths.txt', { tool: 'Write' }), /permission list/);
});

test('protect-paths: in a repository with no commits, nothing is shipped yet', () => {
  const dir = tempRepo({ [MIGRATION]: 'select 1;\n' }, { commit: false });
  assertAllowed(edit(dir, MIGRATION));
});

test('protect-paths: resolves symlinked and relative paths', () => {
  const dir = repo();
  const real = fs.realpathSync(dir);
  // mkdtemp on macOS returns /var/..., whose real path is /private/var/...
  assertBlocked(edit(real, MIGRATION));
  assertBlocked(runHook(HOOK, fixture('pretooluse-edit', { cwd: dir, tool_input: { file_path: MIGRATION } }), { env: { CLAUDE_PROJECT_DIR: dir } }));
});

test('protect-paths: protects shipped migrations inside a linked worktree', () => {
  const dir = repo();
  const wt = `${dir}-wt`;
  git(dir, 'worktree', 'add', '-q', wt);
  assertBlocked(runHook(HOOK, fixture('pretooluse-edit', { cwd: wt, tool_input: { file_path: path.join(wt, MIGRATION) } }), { env: { CLAUDE_PROJECT_DIR: dir } }));
});

test('protect-paths: fails closed when git cannot answer or the input is malformed', () => {
  const dir = repo();
  assertBlocked(edit(dir, MIGRATION, { env: { PATH: '' } }), /could not ask git/);
  assertBlocked(runHook(HOOK, rawFixture('malformed.txt')));
  assertBlocked(runHook(HOOK, ''));
  assertBlocked(runHook(HOOK, fixture('pretooluse-edit', { tool_input: { file_path: '' } })));
  assertBlocked(runHook(HOOK, fixture('pretooluse-write', { tool_input: null })));
});

// Critic v0.1.0: CR-5 (the pre-commit scan's files), CR-21 (local actions),
// CR-25 (every lockfile, NotebookEdit input).
test('protect-paths CR-5, CR-21: git hooks, all of .github/, gitleaks files, and the CI check scripts', () => {
  const dir = repo();
  for (const [rel, pattern] of [
    ['.githooks/pre-commit', /git hook/],
    ['.github/actions/setup/action.yml', /GitHub configuration/],
    ['.github/dependabot.yml', /GitHub configuration/],
    ['.github/pull_request_template.md', /GitHub configuration/],
    ['.gitleaks.toml', /secret-scan configuration/],
    ['.gitleaksignore', /secret-scan configuration/],
    ['scripts/check-rls.mjs', /CI check script/],
    ['scripts/check-client-bundle.mjs', /CI check script/],
    ['scripts/check-migrations-append-only.mjs', /CI check script/],
    ['scripts/check-release-age.mjs', /CI check script/],
    ['scripts/check-sensitive-change.mjs', /CI check script/],
    ['scripts/check-test-integrity.mjs', /CI check script/],
    ['scripts/check-action-pins.mjs', /CI check script/],
  ]) assertBlocked(edit(dir, rel, { tool: 'Write' }), pattern);
  assertAllowed(edit(dir, 'scripts/seed-dev.mjs', { tool: 'Write' }));
  assertAllowed(edit(dir, 'githooks-notes.md', { tool: 'Write' }));
  writeFiles(dir, { '.recon/current-brief-paths.txt': '.githooks/pre-commit\n.github/actions/setup/action.yml\n' });
  assertAllowed(edit(dir, '.githooks/pre-commit'));
  assertAllowed(edit(dir, '.github/actions/setup/action.yml', { tool: 'Write' }));
});

test('protect-paths CR-25: every package-manager lockfile, at any depth', () => {
  const dir = repo();
  for (const rel of ['yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'package-lock.json', 'apps/web/pnpm-lock.yaml']) {
    assertBlocked(edit(dir, rel, { tool: 'Write' }), /lockfile/);
  }
});

test('protect-paths CR-25: NotebookEdit input (notebook_path) is checked like a file path', () => {
  const dir = repo();
  const nb = (rel) => runHook(HOOK, fixture('pretooluse-notebookedit', { cwd: dir, tool_input: { notebook_path: path.join(dir, rel) } }), { env: { CLAUDE_PROJECT_DIR: dir } });
  assertBlocked(nb('.github/notebooks/release.ipynb'), /GitHub configuration/);
  assertBlocked(nb(MIGRATION), /shipped migration/);
  assertAllowed(nb('notebooks/analysis.ipynb'));
  assertBlocked(runHook(HOOK, fixture('pretooluse-notebookedit', { cwd: dir, tool_input: { notebook_path: '' } }), { env: { CLAUDE_PROJECT_DIR: dir } }));
});

// Critic v0.1.0 pass 2, R2-18: a migration counts as shipped when it exists on
// the base branch (the merge base with origin/main, else local main), or in HEAD
// when the current branch is main or there is no main.
test('protect-paths R2-18: a migration committed only on the step branch can still be fixed', () => {
  // The Critic's reproduction: 20261008000000_add_n.sql committed on step-3 only.
  const dir = repo();
  git(dir, 'checkout', '-q', '-b', 'step-3');
  const STEP = 'supabase/migrations/20261008000000_add_n.sql';
  writeFiles(dir, { [STEP]: 'alter table plans add column n int;\n' });
  git(dir, 'add', '--', STEP);
  git(dir, 'commit', '-q', '-m', 'step 3 migration');
  assertAllowed(edit(dir, STEP));
  assertAllowed(edit(dir, 'supabase/migrations/20261009000000_untracked.sql', { tool: 'Write' }));
  // The migration main already had is still shipped.
  assertBlocked(edit(dir, MIGRATION), /shipped migration \(it exists in the merge base with main\)/);
});

test('protect-paths R2-18: origin/main is the base when it exists', () => {
  const dir = repo();
  const origin = `${dir}-origin.git`;
  git(dir, 'clone', '-q', '--bare', dir, origin);
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'fetch', '-q', 'origin');
  // A migration merged to local main but not to origin/main isn't shipped.
  const LOCAL = 'supabase/migrations/20261010000000_local_only.sql';
  writeFiles(dir, { [LOCAL]: 'select 1;\n' });
  git(dir, 'add', '--', LOCAL);
  git(dir, 'commit', '-q', '-m', 'local main only');
  git(dir, 'checkout', '-q', '-b', 'step-4');
  assertAllowed(edit(dir, LOCAL));
  assertBlocked(edit(dir, MIGRATION), /\(it exists in the merge base with origin\/main\)/);
});

test('protect-paths R2-18: on main, or with no main, HEAD is the base', () => {
  // On main: everything committed counts as shipped.
  const dir = repo();
  const MAIN_ONLY = 'supabase/migrations/20261011000000_on_main.sql';
  writeFiles(dir, { [MAIN_ONLY]: 'select 1;\n' });
  git(dir, 'add', '--', MAIN_ONLY);
  git(dir, 'commit', '-q', '-m', 'on main');
  assertBlocked(edit(dir, MAIN_ONLY), /\(it exists in main \(HEAD\)\)/);
  // A repository whose only branch isn't called main.
  const other = tempRepo({ [MIGRATION]: 'select 1;\n' });
  git(other, 'branch', '-m', 'main', 'trunk');
  assertBlocked(edit(other, MIGRATION), /\(it exists in HEAD \(no main branch\)\)/);
  // A detached HEAD on a step branch still uses main as the base.
  const det = repo();
  git(det, 'checkout', '-q', '-b', 'step-5');
  const STEP = 'supabase/migrations/20261012000000_step.sql';
  writeFiles(det, { [STEP]: 'select 2;\n' });
  git(det, 'add', '--', STEP);
  git(det, 'commit', '-q', '-m', 'step 5');
  git(det, 'checkout', '-q', '--detach');
  assertAllowed(edit(det, STEP));
  assertBlocked(edit(det, MIGRATION), /shipped migration/);
});

test('protect-paths R2-18: unrelated histories fail closed', () => {
  const dir = repo();
  git(dir, 'checkout', '-q', '--orphan', 'unrelated');
  git(dir, 'commit', '-q', '-m', 'unrelated root', '--allow-empty');
  writeFiles(dir, { [MIGRATION]: 'select 9;\n' });
  assertBlocked(edit(dir, MIGRATION), /could not ask git/);
});
