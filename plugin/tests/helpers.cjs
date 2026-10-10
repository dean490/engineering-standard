'use strict';
// Test helpers: load a documented payload fixture, run a hook the way Claude
// Code does (JSON on stdin, environment variables set), and build throwaway
// git repositories.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOKS = path.join(__dirname, '..', 'hooks');
const FIXTURES = path.join(__dirname, 'fixtures');

function merge(base, overrides) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) return overrides;
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

function fixture(name, overrides = {}) {
  const base = JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
  return merge(base, overrides);
}

function rawFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Environment for a hook run: the caller's PATH and HOME, nothing inherited
// from the session that runs the tests (such as CLAUDE_PROJECT_DIR). git reads
// no global or system configuration, so the user's own aliases can't change a
// result; a test that needs one passes GIT_CONFIG_GLOBAL.
function hookEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function runHook(hook, input, { env = {}, args = [], cwd } = {}) {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const r = spawnSync(process.execPath, [path.join(HOOKS, hook), ...args], {
    input: raw,
    encoding: 'utf8',
    env: hookEnv(env),
    cwd: cwd || os.tmpdir(),
    timeout: 120000,
  });
  let json = null;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  } catch {
    json = undefined;
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, error: r.error };
}

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// A throwaway repository under the OS temp directory. On macOS the returned
// path goes through the /var -> /private/var symlink on purpose.
function tempRepo(files = {}, { commit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-standard-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'user.name', 'eng-standard tests');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFiles(dir, files);
  if (commit && Object.keys(files).length > 0) {
    git(dir, 'add', '--', ...Object.keys(files));
    git(dir, 'commit', '-q', '-m', 'fixture');
  }
  return dir;
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function tempDir(prefix = 'eng-standard-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { fixture, rawFixture, runHook, git, tempRepo, tempDir, writeFiles, hookEnv };
