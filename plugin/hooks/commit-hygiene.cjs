#!/usr/bin/env node
'use strict';
// PreToolUse: commit hygiene and the deny patterns a Bash rule can't reliably
// match (STANDARD 3.2, 9.3; constitution XI). Matches Bash|PowerShell|Monitor.
//
// A guardrail, not a wall: it reads command text, so a determined agent can
// find a spelling it misses (Claude Code's own docs say the same of Bash deny
// rules). It stops the common forms early. The walls behind it are the
// sandbox's network allowlist, which gives agent sessions no route to GitHub,
// the ruleset on main and its required checks, the sandbox's file blocks, no
// production credentials on development machines, and the Owner's review at
// merge (STANDARD, introduction; DECISIONS 11, 12).
//
// Blocks, in any spelling the parser can see (git -C/-c/--config-env options,
// abbreviated long options, VAR=value prefixes, timeout/nice/env/sudo/xargs
// wrappers, find -exec, npx, pnpm exec/dlx, bunx, and yarn runners, $(...),
// backticks, sh -c '...', eval, and git aliases from the user's config):
//   - bulk staging: git add -A/--all/--no-ignore-removal/--pathspec-from-file,
//     git add . (or :/, a directory, or a glob that names no existing file),
//     git add -u/--update without paths, git commit -a, git commit with ".",
//     ":/", a directory, a glob, or --pathspec-from-file
//   - git commit -m/--message (write the message to a file; commit with -F)
//   - skipping git hooks: --no-verify on any git command, git commit -n,
//     git commit-tree; changing core.hooksPath, aliases, or includes with
//     git -c, --config-env, or git config; any GIT_CONFIG* variable; HOME or
//     XDG_CONFIG_HOME on a git command
//   - git push in any form, and the plumbing that pushes (git send-pack,
//     git http-push): the Owner pushes (STANDARD 1.6)
//   - git branch -D (and --delete --force), git reset --hard, git update-ref,
//     git symbolic-ref writes
//   - other commands that destroy uncommitted work: git clean -f/--force/-i (or
//     with clean.requireForce turned off), git checkout or git restore of ".",
//     ":/", a directory, or a glob (git restore --staged alone only unstages),
//     git checkout -f, git switch -f/--discard-changes, git stash drop|clear,
//     git read-tree -u, git checkout-index -a -f
//   - git run in a way the hook can't read: a command name, subcommand, or
//     argument of a git command that changes things coming from a variable or
//     a substitution, and xargs or find -exec feeding such a command
//   - gitleaks configuration overrides (GITLEAKS_CONFIG, GITLEAKS_CONFIG_TOML,
//     any GITLEAKS_* variable) on any command
//   - a download piped into a shell: curl|wget ... | sh, sh <(curl ...),
//     sh -c "$(curl ...)", eval "$(wget ...)"
//   - Vercel deploys and promotions: vercel with no subcommand or with a path,
//     vercel deploy|redeploy|promote|rollback, vercel alias set|rm, vercel
//     rolling-release start|approve|complete|abort, --prod, --target production
//   - remote Supabase changes: any supabase command with --linked, --db-url,
//     or --project-ref in any spelling, or a remote --from/--to; supabase db
//     push, link, functions deploy|delete, secrets set|unset, config push,
//     branches create|delete, projects create|delete; gen types --project-id
//
// Commit gate (STANDARD 1.6; constitution IV): a git commit that passes the
// checks above is also denied in a non-Planner session unless the
// .recon/<step>/INDEX.md that changed most recently under the project has a
// "## Needs a ruling" section that is empty or says "none", and a line
// "result: gate:fast exit=0" (the first line /eng-standard:gate fast writes to
// its evidence file). A project with no INDEX passes. Owner override:
// ENG_STANDARD_COMMIT_GATE=off.
//
// Exit 2 = deny (reason on stderr). Exit 0 = no decision.
// Fails closed: unparseable input is denied, and so is a command the parser
// can't read when it mentions git, vercel, supabase, curl, or wget.

let common;
let shell;
let options;
try {
  common = require('./lib/common.cjs');
  shell = require('./lib/shell.cjs');
  options = require('./lib/options.cjs');
} catch (err) {
  process.stderr.write(`commit-hygiene: failed to load helpers (${err.message}); blocking (fail closed).\n`);
  process.exit(2);
}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { longMatches, walkOptions } = options;

// The payload being decided, for the commit gate (session and project).
let currentPayload = null;

const TAG = '(guard: eng-standard commit-hygiene)';
const STAGE_BY_NAME = 'Stage each file by name (git add path/to/file ...), STANDARD 9.3.';
const OWNER_ACTION = 'That is an Owner action (STANDARD 1.6, 3.2); ask the Owner to run it.';
const OWNER_PUSHES = 'The Owner pushes (STANDARD 1.6): stop and report, and the Owner pushes the branch and opens the pull request.';
const DESTROYS_WORK = 'It destroys uncommitted work; the Owner runs it (STANDARD 1.6, 3.2).';
const SKIPS_HOOKS = "skips the repository's git hooks, the same as --no-verify.";
const COMPUTED = 'so the hook can\'t tell what would run. Write the command and its arguments out literally.';

// A word that may change when the shell expands it: $VAR, ${...}, $(...), `...`.
const EXPANSION = /[$`]/;

// git subcommands that don't change the repository, the working tree, or
// anything remote. Their arguments may come from a substitution, as in
// git diff $(git merge-base main HEAD).
const GIT_READ_ONLY = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'annotate', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list',
  'cat-file', 'grep', 'shortlog', 'describe', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'show-branch',
  'diff-tree', 'diff-index', 'diff-files', 'count-objects', 'check-ignore', 'check-attr', 'check-ref-format',
  'version', 'help', 'whatchanged', 'var', 'cherry', 'range-diff', 'verify-commit', 'verify-tag',
]);
// git's own commands (git help -a). An alias can't shadow one, so only other
// subcommands are looked up as aliases.
const GIT_COMMANDS = new Set([
  ...GIT_READ_ONLY,
  'add', 'am', 'apply', 'archive', 'bisect', 'branch', 'bundle', 'checkout', 'checkout-index', 'cherry-pick',
  'citool', 'clean', 'clone', 'commit', 'commit-graph', 'commit-tree', 'config', 'credential', 'daemon', 'difftool',
  'fetch', 'filter-branch', 'format-patch', 'fsck', 'gc', 'gitk', 'gui', 'hash-object', 'index-pack', 'init',
  'instaweb', 'interpret-trailers', 'maintenance', 'merge', 'merge-file', 'merge-tree', 'mergetool', 'mktag',
  'mktree', 'mv', 'notes', 'pack-objects', 'pack-refs', 'prune', 'pull', 'push', 'send-pack', 'http-push', 'read-tree', 'rebase', 'reflog',
  'remote', 'repack', 'replace', 'request-pull', 'rerere', 'reset', 'restore', 'revert', 'rm', 'send-email',
  'sparse-checkout', 'stash', 'stripspace', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-objects',
  'update-index', 'update-ref', 'update-server-info', 'worktree', 'write-tree',
]);

// git's global options that take the next word as their value.
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--list-cmds', '--attr-source']);

// Split git argv into { configs, dir, literal, sub, args }.
function parseGit(argv) {
  const configs = [];
  let dir = null;
  let literal = false;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    const opt = argv[i];
    if (GIT_GLOBAL_WITH_VALUE.has(opt)) {
      const value = argv[i + 1] || '';
      if (opt === '-c' || opt === '--config-env') configs.push(value);
      if (opt === '-C') dir = dir ? path.join(dir, value) : value;
      i += 2;
      continue;
    }
    if (opt.startsWith('--config-env=')) configs.push(opt.slice('--config-env='.length));
    if (opt === '--literal-pathspecs') literal = true;
    if (opt === '--glob-pathspecs') literal = false;
    i += 1;
  }
  return { configs, dir, literal, sub: argv[i], args: argv.slice(i + 1) };
}

// Config keys that change which hooks run or what a git command means.
function configProblem(key) {
  const k = key.toLowerCase();
  if (k === 'core.hookspath') return `overriding core.hooksPath ${SKIPS_HOOKS}`;
  if (k.startsWith('alias.')) return 'defining a git alias on the command line hides what the command runs.';
  if (k.startsWith('include.') || k.startsWith('includeif.')) return 'including another git configuration file hides what it sets (aliases, core.hooksPath).';
  return null;
}

// ---------------------------------------------------------------------------
// Pathspecs (CR-13): a pathspec is one named file when it names an existing
// file on disk or in the index, uses :(literal), or comes after
// --literal-pathspecs. Otherwise ".", ":/", a directory, other pathspec magic,
// and a glob are bulk: git expands a glob itself even when it is quoted.

function gitRun(cwd, args) {
  return spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
}

// 'file' | 'dir' | 'none' for a path in the index.
function inIndex(base, abs) {
  const r = gitRun(base, ['ls-files', '-z', '--cached', '--', `:(literal)${path.relative(base, abs) || '.'}`]);
  if (r.error || r.status !== 0) return 'none';
  const entries = r.stdout.split('\0').filter(Boolean).map((e) => path.resolve(base, e));
  if (entries.includes(abs)) return 'file';
  return entries.some((e) => e.startsWith(abs + path.sep)) ? 'dir' : 'none';
}

// null when p names one file; otherwise why it is bulk.
function pathspecProblem(p, ctx) {
  if (EXPANSION.test(p)) return 'a name produced by a substitution';
  let spec = p;
  let base = ctx.base;
  let literal = ctx.literal;
  if (spec.startsWith(':')) {
    const magic = /^:\(([^)]*)\)(.*)$/s.exec(spec);
    if (magic) {
      const words = magic[1].split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
      if (!words.every((w) => w === 'literal' || w === 'top')) return 'pathspec magic';
      if (words.includes('literal')) literal = true;
      if (words.includes('top')) base = ctx.top();
      spec = magic[2];
    } else if (spec.startsWith(':/')) {
      base = ctx.top();
      spec = spec.slice(2);
    } else {
      return 'pathspec magic';
    }
  }
  if (spec === '' || spec === '.' || spec === './' || spec === '*') return 'the whole tree';
  const abs = path.resolve(base, spec);
  let st = null;
  try {
    st = fs.lstatSync(abs);
  } catch {
    st = null;
  }
  if (st) return st.isDirectory() ? 'a directory' : null;
  const indexed = inIndex(base, abs);
  if (indexed === 'file') return null;
  if (indexed === 'dir') return 'a directory';
  if (literal) return null;
  return /[*?[]/.test(spec) ? 'a pattern' : null;
}

function pathspecContext(cwd, dir, literal) {
  const base = path.resolve(cwd, dir || '.');
  let top;
  return {
    base,
    literal,
    top: () => {
      if (top === undefined) {
        const r = gitRun(base, ['rev-parse', '--show-toplevel']);
        top = r.status === 0 ? r.stdout.trim() : base;
      }
      return top;
    },
  };
}

// ---------------------------------------------------------------------------
// git

function lookupAlias(base, sub) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(sub)) return null;
  const r = gitRun(base, ['config', '--get', `alias.${sub}`]);
  if (r.error || r.status !== 0) return null;
  return r.stdout.replace(/\n$/, '');
}

const COMMIT_SPEC = {
  shortWithValue: 'mFCct',
  shortAttachedOnly: 'Su',
  longWithValue: ['--message', '--file', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--template', '--author', '--date', '--cleanup', '--trailer', '--pathspec-from-file'],
};

const GATE_OFF = new Set(['off', '0', 'false', 'no', 'disabled']);
const GATE_OVERRIDE = 'Owner override: `ENG_STANDARD_COMMIT_GATE=off`.';

// The most recently changed .recon/<step>/INDEX.md under the project, or null.
function latestIndex(root) {
  let best = null;
  let steps;
  try {
    steps = fs.readdirSync(path.join(root, '.recon'), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of steps) {
    if (!d.isDirectory()) continue;
    const file = path.join(root, '.recon', d.name, 'INDEX.md');
    try {
      const t = fs.statSync(file).mtimeMs;
      if (best === null || t > best.t) best = { file, t, step: d.name };
    } catch {
      // no INDEX in this step
    }
  }
  return best;
}

// The text of the "## Needs a ruling" section, or null when there is none.
function rulingSection(text) {
  const m = /^##[ \t]+Needs a ruling[ \t]*$/im.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^##[ \t]/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// STANDARD 1.6: an agent commits once the gate, the reviews and the rulings
// are clear. Returns a denial, or null to pass.
function commitGate(payload) {
  if (!payload || GATE_OFF.has(String(process.env.ENG_STANDARD_COMMIT_GATE || '').toLowerCase())) return null;
  const role = require('./lib/roles.cjs').readRole(payload.session_id);
  if (role !== null && role.role === 'planner') return null;
  const index = latestIndex(common.projectDir(payload));
  if (index === null) return null;
  const rel = path.join('.recon', index.step, 'INDEX.md');
  let text;
  try {
    text = fs.readFileSync(index.file, 'utf8');
  } catch (e) {
    return `Blocked: git commit. The commit gate could not read ${rel} (${e.message}). ${GATE_OVERRIDE} ${TAG}`;
  }
  const lacks = [];
  const section = rulingSection(text);
  if (section === null) {
    lacks.push('a "## Needs a ruling" section (write "none" under it when nothing is open)');
  } else {
    const body = section.replace(/<!--[\s\S]*?-->/g, '').trim().replace(/^[>*-]+\s*/, '').replace(/\.$/, '');
    if (body !== '' && !/^none$/i.test(body)) {
      lacks.push('an empty "## Needs a ruling" section: a ruling is open, so tell the Owner "Rule on brief <N>" and stop, then continue from the Rulings section of the brief');
    }
  }
  if (!/\bresult:[ \t]*gate:fast[ \t]+exit=0(?!\d)/i.test(text)) {
    lacks.push('a fast-gate result line recording exit 0 ("result: gate:fast exit=0", the first line of .recon/gate/gate-fast.txt): run /eng-standard:gate fast, fix what fails, and copy the line under Checks');
  }
  if (lacks.length === 0) return null;
  return (
    `Blocked: git commit. The commit gate (STANDARD 1.6) found ${rel} lacking:\n- ${lacks.join('\n- ')}\n` +
    `Commit once the gate, the reviews and the rulings are clear. ${GATE_OVERRIDE} ${TAG}`
  );
}

function checkGit(argv, ctx) {
  const g = parseGit(argv);
  for (const c of g.configs) {
    if (EXPANSION.test(c)) return `Blocked: a git -c value comes from a variable or substitution, ${COMPUTED} ${TAG}`;
    const why = configProblem(c.split('=')[0]);
    if (why) return `Blocked: ${why} ${TAG}`;
  }
  // git stage is git's own synonym for git add.
  const sub = g.sub === 'stage' ? 'add' : g.sub;
  if (!sub) return null;
  if (EXPANSION.test(sub)) return `Blocked: the git subcommand comes from a variable or substitution, ${COMPUTED} ${TAG}`;
  const args = g.args;

  if (!GIT_COMMANDS.has(sub) && (ctx.aliasDepth || 0) < 5) {
    const alias = lookupAlias(path.resolve(ctx.cwd, g.dir || '.'), sub);
    if (alias !== null) {
      if (alias.startsWith('!')) {
        return checkCommandString(`${alias.slice(1)} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, ctx.cwd, (ctx.depth || 0) + 1);
      }
      const expanded = shell.allCommands(shell.parse(alias))[0];
      if (expanded) {
        const next = ['git', ...(g.dir ? ['-C', g.dir] : []), ...expanded.argv, ...args];
        return checkGit(next, { ...ctx, aliasDepth: (ctx.aliasDepth || 0) + 1 });
      }
    }
  }

  if (sub === 'push' || sub === 'send-pack' || sub === 'http-push') {
    // Agent sessions have no route to GitHub; the Owner pushes, opens pull
    // requests, and merges (STANDARD 1.6; DECISIONS 12).
    return `Blocked: git ${sub}. ${OWNER_PUSHES} ${TAG}`;
  }

  const readOnly = GIT_READ_ONLY.has(sub);
  if (!readOnly && ctx.viaOther) {
    return sub === 'add' || sub === 'commit'
      ? `Blocked: "git ${sub}" with paths from another command (xargs, find -exec) is staging in bulk. ${STAGE_BY_NAME} ${TAG}`
      : `Blocked: "git ${sub}" takes its arguments from another command (xargs, find -exec), ${COMPUTED} ${TAG}`;
  }
  if (!readOnly && sub !== 'add') {
    // git add reports a computed pathspec as bulk staging, below.
    const computed = args.find((a) => EXPANSION.test(a));
    if (computed !== undefined) return `Blocked: an argument of "git ${sub}" (${computed}) comes from a variable or substitution, ${COMPUTED} ${TAG}`;
  }
  if (args.some((a) => longMatches(a, '--no-verify'))) {
    return `Blocked: --no-verify skips the repository's git hooks. Fix what the hook reports instead. ${TAG}`;
  }
  const pctx = pathspecContext(ctx.cwd, g.dir, g.literal);

  if (sub === 'add') {
    const o = walkOptions(args, { longWithValue: ['--chmod', '--pathspec-from-file'] });
    if (o.has('-A') || o.has('--all') || o.has('--no-ignore-removal')) {
      return `Blocked: git add -A/--all stages every change in bulk. ${STAGE_BY_NAME} ${TAG}`;
    }
    if (o.has('--pathspec-from-file')) {
      return `Blocked: git add --pathspec-from-file stages a list of files from another source in bulk. ${STAGE_BY_NAME} ${TAG}`;
    }
    if ((o.has('-u') || o.has('--update')) && o.positional.length === 0) {
      return `Blocked: git add -u without paths stages every tracked change in bulk. ${STAGE_BY_NAME} ${TAG}`;
    }
    for (const p of o.positional) {
      const why = pathspecProblem(p, pctx);
      if (why) return `Blocked: "git add ${p}" stages files in bulk (${why}). ${STAGE_BY_NAME} ${TAG}`;
    }
    return null;
  }

  if (sub === 'commit') {
    const o = walkOptions(args, COMMIT_SPEC);
    if (o.has('-n')) return `Blocked: git commit -n skips the repository's git hooks (--no-verify). ${TAG}`;
    if (o.has('-a') || o.has('--all')) {
      return `Blocked: git commit -a stages every modified file in bulk. ${STAGE_BY_NAME} Then commit with -F. ${TAG}`;
    }
    if (o.has('-m') || o.has('--message')) {
      return (
        `Blocked: git commit -m. Write the message to a file and commit with "git commit -F <file>" ` +
        `(STANDARD 9.3: subject of 72 characters or less, trailers naming the model that did the work). ${TAG}`
      );
    }
    if (o.has('--pathspec-from-file')) {
      return `Blocked: git commit --pathspec-from-file commits a list of files from another source in bulk. ${STAGE_BY_NAME} ${TAG}`;
    }
    for (const p of o.positional) {
      const why = pathspecProblem(p, pctx);
      if (why) return `Blocked: "git commit ${p}" commits every change under it in bulk (${why}). ${STAGE_BY_NAME} Then commit with -F. ${TAG}`;
    }
    return commitGate(currentPayload);
  }

  if (sub === 'commit-tree') {
    return `Blocked: git commit-tree makes a commit without running the repository's git hooks. Commit with "git commit -F <file>". ${TAG}`;
  }

  if (sub === 'branch') {
    const o = walkOptions(args, { shortWithValue: 'u', longWithValue: ['--set-upstream-to', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'] });
    const del = o.has('-d') || o.has('--delete');
    const force = o.has('-f') || o.has('--force');
    if (o.has('-D') || (del && force)) return `Blocked: force-deleting a branch. ${OWNER_ACTION} ${TAG}`;
    return null;
  }

  if (sub === 'update-ref') {
    return `Blocked: git update-ref moves or deletes a branch directly. ${OWNER_ACTION} ${TAG}`;
  }

  if (sub === 'symbolic-ref') {
    const o = walkOptions(args, { shortWithValue: 'm' });
    if (o.positional.length >= 2 || o.has('-d') || o.has('--delete')) {
      return `Blocked: git symbolic-ref changes what HEAD points to without a checkout. ${OWNER_ACTION} ${TAG}`;
    }
    return null;
  }

  if (sub === 'reset') {
    const o = walkOptions(args, { longWithValue: ['--pathspec-from-file'] });
    if (o.has('--hard')) return `Blocked: git reset --hard discards uncommitted work. ${OWNER_ACTION} ${TAG}`;
    return null;
  }

  if (sub === 'read-tree') {
    const o = walkOptions(args, { longWithValue: ['--prefix', '--index-output', '--exclude-per-directory'] });
    if (o.has('-u')) return `Blocked: git read-tree -u overwrites the working tree, like git reset --hard. ${DESTROYS_WORK} ${TAG}`;
    return null;
  }

  if (sub === 'checkout-index') {
    const o = walkOptions(args, { longWithValue: ['--prefix', '--stage'] });
    if ((o.has('-a') || o.has('--all')) && (o.has('-f') || o.has('--force'))) {
      return `Blocked: git checkout-index -a -f overwrites every file in the working tree. ${DESTROYS_WORK} ${TAG}`;
    }
    return null;
  }

  if (sub === 'clean') {
    const o = walkOptions(args, { shortWithValue: 'e', longWithValue: ['--exclude'] });
    const dryRun = o.has('-n') || o.has('--dry-run');
    const forceOff = g.configs.some((c) => /^clean\.requireforce\s*=\s*(false|no|off|0)?\s*$/i.test(c));
    if (o.has('-f') || o.has('--force') || o.has('-i') || o.has('--interactive') || (forceOff && !dryRun)) {
      return `Blocked: git clean deletes untracked files. ${DESTROYS_WORK} ${TAG}`;
    }
    return null;
  }

  if (sub === 'checkout') {
    // git checkout [<tree-ish>] [--] <pathspec>... overwrites those paths. Without
    // "--", the first word may be a branch, so it counts as a pathspec only in a
    // spelling no branch can have (".", ":/", magic, a glob, a trailing "/").
    const dd = args.indexOf('--');
    const o = walkOptions(dd < 0 ? args : args.slice(0, dd), { shortWithValue: 'bB', longWithValue: ['--orphan', '--conflict', '--pathspec-from-file'] });
    if (o.has('-f') || o.has('--force')) {
      return `Blocked: git checkout -f throws away local changes. ${DESTROYS_WORK} ${TAG}`;
    }
    if (o.has('--pathspec-from-file')) {
      return `Blocked: "git checkout --pathspec-from-file" overwrites uncommitted changes in more than one named file. ${DESTROYS_WORK} ${TAG}`;
    }
    const pathspecs = dd < 0 ? o.positional.slice(1) : args.slice(dd + 1);
    const first = dd < 0 ? o.positional[0] : undefined;
    if (first !== undefined && (isWholeTreeOrGlob(first) || first.endsWith('/'))) pathspecs.unshift(first);
    for (const p of pathspecs) {
      const why = pathspecProblem(p, pctx);
      if (why) return `Blocked: "git checkout ${p}" overwrites uncommitted changes in more than one named file (${why}). ${DESTROYS_WORK} ${TAG}`;
    }
    return null;
  }

  if (sub === 'restore') {
    const o = walkOptions(args, { shortWithValue: 's', longWithValue: ['--source', '--pathspec-from-file', '--conflict'] });
    const staged = o.has('-S') || o.has('--staged');
    const worktree = o.has('-W') || o.has('--worktree') || !staged;
    if (!worktree) return null; // --staged alone only unstages; the working tree keeps the changes
    if (o.has('--pathspec-from-file')) {
      return `Blocked: "git restore --pathspec-from-file" discards uncommitted changes in more than one named file. ${DESTROYS_WORK} ${TAG}`;
    }
    for (const p of o.positional) {
      const why = pathspecProblem(p, pctx);
      if (why) return `Blocked: "git restore ${p}" discards uncommitted changes in more than one named file (${why}). ${DESTROYS_WORK} ${TAG}`;
    }
    return null;
  }

  if (sub === 'switch') {
    const o = walkOptions(args, { shortWithValue: 'cC', longWithValue: ['--create', '--force-create', '--orphan', '--conflict'] });
    if (o.has('-f') || o.has('--force') || o.has('--discard-changes')) {
      return `Blocked: git switch --discard-changes throws away local changes. ${DESTROYS_WORK} ${TAG}`;
    }
    return null;
  }

  if (sub === 'stash') {
    const action = args.find((a) => !a.startsWith('-'));
    if (action === 'drop' || action === 'clear') {
      return `Blocked: git stash ${action} deletes stashed work. ${DESTROYS_WORK} ${TAG}`;
    }
    return null;
  }

  if (sub === 'config') {
    const key = args.find((a) => configProblem(a));
    if (key === undefined) return null;
    const o = walkOptions(args, { shortWithValue: 'f', longWithValue: ['--file', '--blob', '--type', '--default', '--comment', '--value'] });
    const writes = ['--unset', '--unset-all', '--replace-all', '--add', '--rename-section', '--remove-section', '-e', '--edit'].some((f) => o.has(f));
    const reads = ['get', 'list'].includes(o.positional[0]) || ['--get', '--get-all', '--get-regexp', '--list', '-l'].some((f) => o.has(f)) || o.positional.length === 1;
    if (writes || !reads) {
      return `Blocked: changing ${key} with git config: ${configProblem(key)} The project's "prepare" script sets core.hooksPath. ${TAG}`;
    }
    return null;
  }
  return null;
}

// "." or ":/" (the whole tree), pathspec magic, or a glob: never a branch name.
function isWholeTreeOrGlob(p) {
  return ['.', './', '*', ':', ':/', ':/*', ':/.'].includes(p) || p.startsWith(':(') || /[*?[]/.test(p);
}

// ---------------------------------------------------------------------------
// Downloads piped into a shell

const DOWNLOADERS = new Set(['curl', 'wget']);

function firstBase(src) {
  try {
    for (const c of shell.allCommands(shell.parse(src))) {
      const eff = shell.effectiveArgv(c.argv);
      if (eff.length) return shell.baseName(eff[0]);
    }
  } catch {
    return /\b(curl|wget)\b/.test(src) ? 'curl' : '';
  }
  return '';
}

function checkPipeToShell(pipeline) {
  const bases = pipeline.commands.map((c) => {
    const eff = shell.effectiveArgv(c.argv);
    return eff.length ? shell.baseName(eff[0]) : '';
  });
  const dl = bases.findIndex((b) => DOWNLOADERS.has(b));
  if (dl >= 0 && bases.slice(dl + 1).some((b) => shell.SHELLS.has(b))) {
    return `Blocked: piping a download into a shell runs unreviewed code (STANDARD 3.2). Download to a file and show it to the Owner instead. ${TAG}`;
  }
  return null;
}

function checkShellOfDownload(cmd) {
  const eff = shell.effectiveArgv(cmd.argv);
  if (!eff.length) return null;
  const base = shell.baseName(eff[0]);
  if (!(shell.SHELLS.has(base) || base === 'eval' || base === 'source' || base === '.')) return null;
  for (const w of cmd.words) {
    for (const src of w.nested) {
      if (DOWNLOADERS.has(firstBase(src))) {
        return `Blocked: running a download as a shell script (STANDARD 3.2). Download to a file and show it to the Owner instead. ${TAG}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Deploys and remote database changes

// Flags of the Supabase CLI that take the next word (Go CLI and the TypeScript
// CLI of v2.120.0; .recon/brief-03/supabase-cli-v2.120.0/).
const SUPABASE_FLAGS_WITH_VALUE = new Set([
  '--workdir', '--profile', '-o', '--output', '--output-format', '--db-url', '-p', '--password', '--project-ref',
  '--project-id', '--dns-resolver', '--network-id', '--agent', '--schema', '-s', '--version', '--last', '--from',
  '--to', '-f', '--file', '--sql-paths', '--lang', '--level', '--fail-on', '--type', '--env-file', '--import-map',
  '--name', '--region', '--org-id', '--query-timeout', '-x', '--exclude',
]);
// A flag that points the Supabase CLI at a remote database or project, in any
// spelling: --linked, --linked=true, --db-url=..., --project-ref ... .
const SUPABASE_REMOTE_FLAG = /^--(linked|db-url|project-ref)/;
const SUPABASE_REMOTE_VALUE = (v) => v === 'linked' || /^postgres(ql)?:\/\//i.test(v || '');
// Subcommands that change a remote project, with or without flags.
const SUPABASE_REMOTE_COMMANDS = [
  ['db', 'push'], ['link'], ['functions', 'deploy'], ['functions', 'delete'], ['secrets', 'set'], ['secrets', 'unset'],
  ['config', 'push'], ['branches', 'create'], ['branches', 'delete'], ['projects', 'create'], ['projects', 'delete'],
];

// Vercel CLI global options that take a value (https://vercel.com/docs/cli/global-options).
const VERCEL_FLAGS_WITH_VALUE = new Set(['--cwd', '-Q', '--global-config', '-A', '--local-config', '-S', '--scope', '--project', '-t', '--token', '-T', '--team']);
// Vercel CLI commands that don't deploy (https://vercel.com/docs/cli). Any other
// first word is a path, and "vercel <path>" deploys it, as plain "vercel" does.
const VERCEL_OTHER_COMMANDS = new Set([
  'activity', 'agent', 'ai-gateway', 'alerts', 'api', 'bisect', 'blob', 'build', 'buy', 'cache', 'certs',
  'comments', 'connect', 'contract', 'crons', 'curl', 'deploy-hooks', 'dev', 'dns', 'domains', 'env',
  'firewall', 'flags', 'git', 'global-config', 'guidance', 'help', 'httpstat', 'init', 'inspect', 'install',
  'integration', 'link', 'list', 'ls', 'login', 'logout', 'logs', 'mcp', 'metrics', 'microfrontends', 'open',
  'project', 'pull', 'redirects', 'remove', 'rm', 'routes', 'sandbox', 'security', 'setup', 'signup', 'skills',
  'switch', 'target', 'teams', 'telemetry', 'tokens', 'traces', 'upgrade', 'usage', 'vcr', 'webhooks', 'whoami',
]);
const VERCEL_OWNER = 'Deploys are an Owner action (STANDARD 1.6); deploys happen through GitHub, not the CLI.';

// What a vercel command deploys or promotes, or null when it does neither.
function vercelDeploys(args) {
  const prod = args.some((a) => a === '--prod' || /^--prod=(true|1)$/i.test(a) || /^--target=production$/i.test(a)) ||
    args.some((a, k) => a === '--target' && /^production$/i.test(args[k + 1] || ''));
  if (prod) return 'a production deploy to Vercel';
  if (args.includes('-h') || args.includes('--help')) return null;
  const words = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a === '--') { words.push(...args.slice(k + 1)); break; }
    if (a.startsWith('-')) {
      if (VERCEL_FLAGS_WITH_VALUE.has(a)) k += 1;
      continue;
    }
    words.push(a);
  }
  const [sub, action] = words;
  if (sub === undefined) {
    return args.includes('-v') || args.includes('--version') ? null : '"vercel" with no subcommand deploys to Vercel';
  }
  if (sub === 'deploy' || sub === 'redeploy') return `"vercel ${sub}" deploys to Vercel`;
  if (sub === 'promote' || sub === 'rollback') return action === 'status' ? null : `"vercel ${sub}" changes which deployment is in production`;
  if (sub === 'alias') return action === undefined || action === 'ls' || action === 'list' ? null : '"vercel alias" points a domain at a deployment';
  if (sub === 'rolling-release' || sub === 'rr') {
    return ['start', 'approve', 'complete', 'abort'].includes(action) ? `"vercel ${sub} ${action}" changes a production rollout` : null;
  }
  if (VERCEL_OTHER_COMMANDS.has(sub)) return null;
  return `"vercel ${sub}" deploys the path "${sub}" to Vercel`;
}

function supabaseRemote(args) {
  const words = [];
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k];
    if (a.startsWith('-')) {
      if (SUPABASE_FLAGS_WITH_VALUE.has(a)) k += 1;
      continue;
    }
    words.push(a);
  }
  if (words[0] === 'db' && words[1] === 'push') return `supabase db push changes a remote database. ${OWNER_ACTION}`;
  const remoteFlag = args.find((a) => SUPABASE_REMOTE_FLAG.test(a));
  if (remoteFlag !== undefined) {
    return (
      `${remoteFlag} points the Supabase CLI at a remote database or project (the linked project, a database URL, ` +
      `or a project ref). Development machines use the local stack only (supabase ... --local); production changes ` +
      `go through CI or the Owner. ${OWNER_ACTION}`
    );
  }
  const remoteTarget = args.find((a, k) => (/^--(from|to)=/.test(a) && SUPABASE_REMOTE_VALUE(a.split('=').slice(1).join('='))) ||
    ((a === '--from' || a === '--to') && SUPABASE_REMOTE_VALUE(args[k + 1])));
  if (remoteTarget !== undefined) {
    return `${remoteTarget} points the Supabase CLI at a remote database. Development machines use the local stack only. ${OWNER_ACTION}`;
  }
  if (words[0] === 'gen' && words[1] === 'types' && args.some((a) => /^--project-id(=|$)/.test(a))) {
    return `supabase gen types --project-id reads a remote project. Generate types from the local stack (--local). ${OWNER_ACTION}`;
  }
  const match = SUPABASE_REMOTE_COMMANDS.find((c) => c.every((w, k) => words[k] === w));
  if (match) return `"supabase ${match.join(' ')}" changes a remote Supabase project. ${OWNER_ACTION}`;
  return null;
}

function checkDeploy(argv) {
  const base = shell.baseName(argv[0] || '');
  const args = argv.slice(1);
  if (base === 'vercel') {
    const what = vercelDeploys(args);
    if (what) return `Blocked: ${what}. ${VERCEL_OWNER} ${TAG}`;
  }
  if (base === 'supabase') {
    const why = supabaseRemote(args);
    if (why) return `Blocked: ${why} ${TAG}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Walking a command line

// Commands find runs for each match: -exec/-execdir/-ok/-okdir ... ; or +.
function findExecCommands(args) {
  const out = [];
  for (let k = 0; k < args.length; k += 1) {
    if (/^-(exec|execdir|ok|okdir)$/.test(args[k])) {
      const cmd = [];
      let j = k + 1;
      while (j < args.length && args[j] !== ';' && args[j] !== '+') { cmd.push(args[j]); j += 1; }
      out.push(cmd);
      k = j;
    }
  }
  return out;
}

const GIT_ENV_OVERRIDE = /^(HOME|XDG_CONFIG_HOME|GIT_CONFIG\w*)=/;

// Check one simple command's argv. ctx: { cwd, depth, viaOther }.
function checkArgv(argv, ctx) {
  const eff = shell.effectiveArgv(argv);
  if (eff.length === 0) return null;
  const prefix = argv.slice(0, Math.max(0, argv.length - eff.length));
  const viaOther = ctx.viaOther || prefix.some((w) => shell.baseName(w) === 'xargs');
  if (EXPANSION.test(eff[0])) {
    return `Blocked: the command name (${eff[0]}) comes from a variable or substitution, ${COMPUTED} ${TAG}`;
  }
  // The command itself, then whatever a runner (npx, pnpm exec, bunx, ...) runs.
  const runs = [eff];
  for (let inner = shell.unwrapRunner(eff); inner && runs.length < 4; inner = shell.unwrapRunner(runs[runs.length - 1])) {
    runs.push(shell.effectiveArgv(inner));
  }
  for (const run of runs) {
    if (run.length === 0) continue;
    if (EXPANSION.test(run[0])) return `Blocked: the command name (${run[0]}) comes from a variable or substitution, ${COMPUTED} ${TAG}`;
    const base = shell.baseName(run[0]);
    if (base === 'git') {
      const env = prefix.find((w) => GIT_ENV_OVERRIDE.test(w));
      if (env !== undefined) {
        return `Blocked: ${env.split('=')[0]} on a git command points git at other configuration (aliases, core.hooksPath), which ${SKIPS_HOOKS} ${TAG}`;
      }
      const r = checkGit(run, { ...ctx, viaOther });
      if (r) return r;
    }
    if (base === 'find') {
      for (const inner of findExecCommands(run.slice(1))) {
        const r = checkArgv(inner, { ...ctx, viaOther: true });
        if (r) return r;
      }
    }
    const r = checkDeploy(run);
    if (r) return r;
  }
  const script = shell.inlineScript(eff);
  if (script !== null && (ctx.depth || 0) < 4) {
    const r = checkCommandString(script, ctx.cwd, (ctx.depth || 0) + 1);
    if (r) return r;
  }
  return null;
}

function checkCommandString(command, cwd, depth = 0) {
  const pipelines = shell.parse(command);
  for (const p of pipelines) {
    const r = checkPipeToShell(p);
    if (r) return r;
  }
  for (const c of shell.allCommands(pipelines)) {
    const r1 = checkShellOfDownload(c);
    if (r1) return r1;
    const r2 = checkArgv(c.argv, { cwd, depth, viaOther: false });
    if (r2) return r2;
  }
  return null;
}

// Checks on the raw text, so every spelling of an assignment (VAR=x cmd,
// export, env, declare, PowerShell $env:) is covered, wherever it sits.
function rawTextProblem(command) {
  if (/(^|[^A-Za-z0-9_])GIT_CONFIG\w*\s*=|\$env:GIT_CONFIG|\b(export|declare|typeset|set)\b[^;&|\n]*\bGIT_CONFIG/i.test(command)) {
    return (
      `Blocked: setting GIT_CONFIG* variables gives git configuration this hook can't see, such as an alias or ` +
      `core.hooksPath, which ${SKIPS_HOOKS} ${TAG}`
    );
  }
  if (/GITLEAKS_[A-Z0-9_]*\s*=|\$env:GITLEAKS_|GITLEAKS_CONFIG|\b(export|declare|typeset|set)\b[^;&|\n]*\bGITLEAKS_/i.test(command)) {
    return (
      `Blocked: a GITLEAKS_* variable changes which rules the pre-commit secret scan uses (STANDARD 4.6). ` +
      `Fix what the scan reports instead. ${TAG}`
    );
  }
  if (/\bgit\b/.test(command) && /(^|[\s;&|(])(export\s+|declare\s+-x\s+)(HOME|XDG_CONFIG_HOME)\s*=/.test(command)) {
    return `Blocked: changing HOME or XDG_CONFIG_HOME before a git command points git at other configuration (aliases, core.hooksPath). ${TAG}`;
  }
  return null;
}

function decide(payload) {
  const ti = payload.tool_input;
  // A Monitor WebSocket watch runs no command.
  if (payload.tool_name === 'Monitor' && ti && typeof ti === 'object' && ti.command === undefined && ti.ws && typeof ti.ws === 'object') return null;
  if (ti === null || typeof ti !== 'object' || typeof ti.command !== 'string') {
    return `Blocked: hook input has no command string; blocking (fail closed). ${TAG}`;
  }
  let command = ti.command;
  if (payload.tool_name === 'PowerShell') {
    // PowerShell uses the backtick as its escape and line-continuation character.
    command = command.replace(/`\r?\n/g, ' ').replace(/`(.)/g, '$1');
  }
  const raw = rawTextProblem(command);
  if (raw) return raw;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : common.projectDir(payload);
  try {
    return checkCommandString(command, cwd);
  } catch (e) {
    if (e instanceof shell.ParseError) {
      if (/\b(git|vercel|supabase|curl|wget)\b/.test(command)) {
        return `Blocked: could not parse this command (${e.message}) and it runs git, vercel, supabase, curl, or wget; blocking (fail closed). Rewrite it in a simpler form. ${TAG}`;
      }
      return null;
    }
    throw e;
  }
}

common.readStdin((err, raw) => {
  if (err) common.block(`Blocked: could not read hook input (${err.message}); blocking (fail closed). ${TAG}`);
  let payload;
  try {
    payload = common.parsePayload(raw);
  } catch (e) {
    common.block(`Blocked: could not parse hook input (${e.message}); blocking (fail closed). ${TAG}`);
  }
  let reason;
  currentPayload = payload;
  try {
    reason = decide(payload);
  } catch (e) {
    reason = `Blocked: commit-hygiene check failed (${e.message}); blocking (fail closed). ${TAG}`;
  }
  if (reason) common.block(reason);
  common.allow();
});
