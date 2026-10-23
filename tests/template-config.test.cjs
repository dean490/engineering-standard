'use strict';
// The template's Claude Code settings and CI workflows, read as files: the
// rulings on the second Critic pass (R2-n, .recon/critic-v0.1.0-r2/REPORT.md)
// that live in configuration rather than in a script.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const settings = JSON.parse(read('templates/.claude/settings.json'));
const deny = settings.permissions.deny;
const CI = read('templates/.github/workflows/ci.yml');
const GUARDS = read('templates/.github/workflows/guards.yml');

// The text of every run: block in a workflow, with its indentation removed.
function runBlocks(yaml) {
  const blocks = [];
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:- )?run:\s*(\|)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!m[2]) { blocks.push(m[3]); continue; }
    const body = [];
    const indent = m[1].length;
    for (i += 1; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > indent); i += 1) body.push(lines[i].trim());
    i -= 1;
    blocks.push(body.join('\n'));
  }
  return blocks;
}
// Job ids and names: [[id, name], ...].
function jobs(yaml) {
  const out = [];
  const body = yaml.slice(yaml.indexOf('\njobs:\n'));
  for (const m of body.matchAll(/^ {2}([a-z0-9-]+):\n {4}name: (.+)$/gm)) out.push([m[1], m[2].trim()]);
  return out;
}

test('R2-1 settings: no route to GitHub from the sandbox, and git push is denied', () => {
  const domains = settings.sandbox.network.allowedDomains;
  assert.deepEqual(domains, ['registry.npmjs.org']);
  for (const d of domains) assert.doesNotMatch(d, /github/i);
  assert.ok(deny.includes('Bash(git push*)'), 'git push is a deny rule');
  assert.ok(!settings.permissions.ask.some((r) => /push/.test(r)), 'no ask rule for push');
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.failIfUnavailable, true);
});

test('R2-3 settings: the Supabase CLI leaves the sandbox only by its absolute path', () => {
  const excluded = settings.sandbox.excludedCommands;
  assert.ok(excluded.length > 0);
  for (const e of excluded) {
    assert.match(e, /^\/opt\/homebrew\/bin\/supabase (start|stop|status|db reset --local|db diff --local|test db --local|gen types --local) \*$/, e);
  }
  assert.ok(!excluded.some((e) => /pnpm|npx|exec|^supabase/.test(e)), 'no runner and no bare supabase');
  // CI pins the CLI through setup-cli's version input, not a devDependency.
  assert.match(CI, /uses: supabase\/setup-cli@[0-9a-f]{40} # v3\.0\.1\n\s+with:\n\s+version: 2\.119\.0\n/);
});

test('R2-4 settings: .env* files can\'t be written, renamed, or read, at any depth', () => {
  const fsx = settings.sandbox.filesystem;
  for (const p of ['./.env*', './**/.env*']) {
    assert.ok(fsx.denyRead.includes(p), `denyRead ${p}`);
    assert.ok(fsx.denyWrite.includes(p), `denyWrite ${p}`);
  }
  assert.ok(deny.includes('Read(.env*)'));
  assert.ok(deny.includes('Edit(.env*)'));
});

test('R2-14 settings: Claude\'s file tools can\'t change .githooks/, .github/, or the gitleaks files', () => {
  for (const r of ['Edit(/.githooks/**)', 'Edit(/.github/**)', 'Edit(/.gitleaks.toml)', 'Edit(/.gitleaksignore)']) assert.ok(deny.includes(r), r);
  for (const p of ['./.githooks', './.github', './.gitleaks.toml', './.gitleaksignore']) assert.ok(settings.sandbox.filesystem.denyWrite.includes(p), p);
});

test('skills policy: every allow-list row in templates/docs/SKILLS.md pins a 40-hex commit', () => {
  const section = /\n## Allow-list\n([\s\S]*?)(?=\n## |$)/.exec(read('templates/docs/SKILLS.md'));
  assert.ok(section, 'an "## Allow-list" section');
  const rows = section[1].split('\n').filter((l) => l.startsWith('| `'));
  assert.ok(rows.length > 0, 'at least one allow-list row');
  for (const row of rows) assert.match(row, /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/, row);
});

test('R2-15 settings: more credential stores unreadable, token variables removed from sandboxed commands', () => {
  for (const r of ['Read(~/.npmrc)', 'Read(~/.netrc)', 'Read(~/.docker/config.json)', 'Read(~/Library/Application Support/com.vercel.cli/**)', 'Read(~/.local/share/com.vercel.cli/**)', 'Read(~/.now/**)']) {
    assert.ok(deny.includes(r), r);
  }
  const vars = settings.sandbox.credentials.envVars;
  for (const name of ['GITHUB_TOKEN', 'NPM_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'VERCEL_TOKEN']) {
    assert.ok(vars.some((v) => v.name === name && v.mode === 'deny'), name);
  }
});

// Two limits. A `/path` rule anchors at the session's primary working directory
// (.recon/brief-04/docs-cc-permissions.md:374), so in a linked worktree, where the
// project's .git is a file and the shared .git sits outside these rules, only Claude
// Code's protected-path handling applies. And the rule stops at the three paths git
// never writes during ordinary work, because `Read` and `Edit` deny rules are merged
// into the sandbox write block (.recon/brief-04/docs-cc-sandboxing.md:650, :655, :263):
// a rule over all of .git makes .git/index.lock unwritable and `git add` fails
// (.recon/brief-06/git-deny-wide.txt).
test('brief 07: file tools can\'t write .git/config, .git/config.worktree, or .git/hooks, and no rule covers the whole of .git', () => {
  const own = JSON.parse(read('.claude/settings.json')).permissions.deny;
  for (const [name, rules] of [['template', deny], ['this repository', own]]) {
    for (const r of ['Edit(/.git/config)', 'Edit(/.git/config.worktree)', 'Edit(/.git/hooks/**)']) assert.ok(rules.includes(r), `${name}: ${r}`);
    assert.ok(!rules.includes('Edit(/.git/**)'), `${name}: Edit(/.git/**) would block .git/index.lock`);
    // Edit(/.git) alone is not asserted either way until its probe (brief 07 section 2) has run.
  }
});

test('brief 05 settings: compaction at 200k tokens and no claude.ai connectors fetched (STANDARD 10.2, 10.7)', () => {
  assert.equal(settings.autoCompactWindow, 160000);
  assert.equal(settings.disableClaudeAiConnectors, true);
});

test('brief 05 AGENTS.md: "Working efficiently" is at most 6 lines and points to STANDARD §10', () => {
  const agents = read('templates/AGENTS.md');
  const m = agents.match(/^## Working efficiently\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(m, 'the section exists');
  const lines = ('## Working efficiently\n' + m[1]).replace(/\n+$/, '').split('\n');
  assert.ok(lines.length <= 6, `${lines.length} lines`);
  assert.match(m[1], /STANDARD §10/);
});

test('R2-2 guards.yml: the guard checks run from the default branch and never run the pull request', () => {
  assert.match(GUARDS, /^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, edited\]$/m);
  assert.doesNotMatch(GUARDS, /^\s+pull_request:/m);
  assert.match(GUARDS, /^permissions:\n {2}contents: read$/m);
  const names = jobs(GUARDS).map(([, n]) => n);
  assert.deepEqual(names.sort(), ['Actions pinned to commit SHAs', 'Migrations are append-only', 'Release age', 'Secret scan', 'Sensitive change', 'Test integrity']);
  // Every checkout is of the default branch (no ref), without stored credentials.
  const checkouts = [...GUARDS.matchAll(/uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n((?: {8}.*\n)*)/g)].map((m) => m[1]);
  assert.equal(checkouts.length, names.length);
  for (const c of checkouts) {
    assert.match(c, /persist-credentials: false/);
    assert.doesNotMatch(c, /\bref:|repository:/);
  }
  // The head is fetched as git data from refs/pull/<n>/head, and checked against the event's SHA.
  assert.equal((GUARDS.match(/"\+refs\/pull\/\$PR_NUMBER\/head:refs\/remotes\/pull\/head"/g) || []).length, names.length);
  // No install, build, cache, or execution of anything from the pull request.
  const code = GUARDS.replace(/(^|\s)#.*$/gm, '');
  assert.doesNotMatch(code, /pnpm|npm (ci|install)|setup-node|actions\/cache|cache:/);
  for (const block of runBlocks(GUARDS)) {
    // No expression in a run: line; pull request values come through env:.
    assert.doesNotMatch(block, /\$\{\{/, block);
    // Scripts run from the checkout of the default branch, and only these.
    for (const m of block.matchAll(/node (\S+)/g)) assert.match(m[1], /^scripts\/check-[a-z-]+\.mjs$/);
  }
  assert.doesNotMatch(code, /github\.event\.pull_request\.(title|body|head\.ref|head\.label)|github\.head_ref/);
});

test('R2-2, R2-11 ci.yml: only the jobs that run the pull request\'s code, with edited events', () => {
  assert.match(CI, /^on:\n {2}pull_request:\n {4}types: \[opened, synchronize, reopened, edited\]\n {2}push:\n {4}branches: \[main\]$/m);
  const names = jobs(CI).map(([, n]) => n);
  assert.deepEqual(names, ['Gate', 'Dependency audit', 'Secret scan on main', 'Migrations are append-only on main', 'Actions pinned on main']);
  // A required check name comes from exactly one workflow on pull requests.
  const guardNames = jobs(GUARDS).map(([, n]) => n);
  for (const n of names) assert.ok(!guardNames.includes(n), n);
  // The "on main" jobs run on push only.
  for (const [id] of jobs(CI).slice(2)) {
    assert.match(CI, new RegExp(`^ {2}${id}:\\n {4}name: .+\\n {4}if: github\\.event_name == 'push'$`, 'm'), id);
  }
});

test('R2-9 ci.yml: push to main checks every commit pushed, and a push run is never cancelled', () => {
  assert.match(CI, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(CI, /BEFORE: \$\{\{ github\.event\.before \}\}\n\s+AFTER: \$\{\{ github\.sha \}\}/);
  assert.match(CI, /if \[ "\$BEFORE" = 0{40} \]; then/);
  assert.match(CI, /node scripts\/check-migrations-append-only\.mjs "\$BEFORE" "\$AFTER"/);
  assert.doesNotMatch(CI, /HEAD\^/);
});

test('workflows: every third-party action is pinned to a full commit SHA', () => {
  for (const [file, text] of [['ci.yml', CI], ['guards.yml', GUARDS], ['root ci.yml', read('.github/workflows/ci.yml')]]) {
    for (const m of text.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /^[^@]+@[0-9a-f]{40}$/, `${file}: ${m[1]}`);
  }
});
