'use strict';
// The read-only shell allowlist shared by the review agents' guard
// (critic-readonly.cjs) and the Planner guard (planner-readonly.cjs):
// read-only git commands, read-only file utilities, and the project's test and
// typecheck scripts. Anything else is denied (constitution II; STANDARD 1.2, 1.4).
//
// A guardrail: it reads command text. Tests are project code, so running them
// runs whatever they contain; the sandbox limits what that code can reach.

const shell = require('./shell.cjs');
const { longMatches, clusterHas } = require('./options.cjs');

const GIT_READ = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'cat-file',
  'grep', 'shortlog', 'describe', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'whatchanged',
  'diff-tree', 'diff-index', 'diff-files', 'count-objects', 'check-ignore', 'check-attr', 'version',
]);
// Allowed only in their read-only forms.
const GIT_READ_FORMS = {
  branch: (rest) => rest.every((a) => /^(--list|-l|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--no-color|--color(=.*)?|--column|--no-column|--sort=.*|--format=.*)$/.test(a)) ||
    (rest.length === 2 && /^(--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(rest[0])),
  tag: (rest) => rest.length === 0 || rest.every((a) => /^(--list|-l|-n\d*|--sort=.*|--format=.*|--column|--no-column)$/.test(a)),
  remote: (rest) => rest.length === 0 || (rest.length === 1 && /^(-v|--verbose)$/.test(rest[0])) || rest[0] === 'get-url' || rest[0] === 'show',
  stash: (rest) => rest[0] === 'list' || rest[0] === 'show',
  worktree: (rest) => rest[0] === 'list',
  config: (rest) => rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)) &&
    !rest.some((a) => /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e|--global|--system|--file|-f|--blob)$/.test(a)),
  reflog: (rest) => rest.length === 0 || rest[0] === 'show',
};
// Long options that write a file or run a command, in any abbreviation git
// accepts (git grep --open is --open-files-in-pager).
const GIT_WRITE_OR_RUN = ['--output', '--ext-diff', '--textconv', '--exec', '--open-files-in-pager', '--exec-path'];
// Complete options of their own that are prefixes of the above.
const GIT_EXACT = new Set(['--text']);
// git grep's short options that take a value; an O before one of them in a
// cluster is -O (open the matches in a pager command).
const GIT_GREP_VALUE_SHORTS = 'efABCm';

const FILE_READ = new Set([
  'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'stat', 'file', 'diff', 'cmp', 'tree', 'du', 'which', 'realpath',
  'readlink', 'basename', 'dirname', 'nl', 'cut', 'tr', 'jq', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'sort',
  'uniq', 'echo', 'printf', 'true', 'test', 'date', 'uname', 'column', 'comm', 'cd',
]);
const SCRIPT_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const TEST_SCRIPT = /^test(:[\w.-]+)?$/;
// Test-runner arguments that write files: snapshot updates and report files.
const TEST_WRITES = ['--update', '--updateSnapshot', '--outputFile', '--output-file'];
// tsc options that write files or start a watcher (tsc options are case-insensitive).
const TSC_WRITES = new Set(['--generatetrace', '--generatecpuprofile', '--build', '-b', '--init', '--watch', '-w', '--tsbuildinfofile']);

function gitDenied(argv) {
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    const opt = argv[i];
    if (opt === '-c' || opt.startsWith('--config-env') || opt.startsWith('--exec-path')) return 'is a git command that can change state or run code';
    i += opt === '-C' || opt === '--git-dir' || opt === '--work-tree' || opt === '--namespace' ? 2 : 1;
  }
  const sub = argv[i];
  const rest = argv.slice(i + 1);
  if (!sub) return 'is a git command that can change state or run code';
  if (rest.some((a) => GIT_WRITE_OR_RUN.some((o) => longMatches(a, o, GIT_EXACT)))) {
    return 'is a git command with an option that writes a file or runs a command';
  }
  if (sub === 'grep' && rest.some((a) => clusterHas(a, 'O', GIT_GREP_VALUE_SHORTS))) {
    return 'is git grep -O, which runs a pager command';
  }
  if (GIT_READ.has(sub)) return null;
  if (Object.prototype.hasOwnProperty.call(GIT_READ_FORMS, sub) && GIT_READ_FORMS[sub](rest)) return null;
  return 'is a git command that can change state or run code';
}

function fileUtilDenied(base, args) {
  const writes = `uses ${base} with an option that writes files or runs code`;
  if (base === 'find') return args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)) ? writes : null;
  if (base === 'rg') return args.some((a) => /^--(pre|pre-glob)(=|$)/.test(a)) ? writes : null;
  if (base === 'sort') {
    return args.some((a) => clusterHas(a, 'o', 'kStT') || longMatches(a, '--output') || longMatches(a, '--compress-program')) ? writes : null;
  }
  if (base === 'tree') return args.some((a) => clusterHas(a, 'o', 'LPIHT') || clusterHas(a, 'R', 'LPIHT')) ? writes : null;
  if (base === 'file') return args.some((a) => clusterHas(a, 'C', 'mfFeP') || longMatches(a, '--compile')) ? writes : null;
  if (base === 'date') return args.some((a) => clusterHas(a, 's', 'dfrI') || longMatches(a, '--set')) ? writes : null;
  if (base === 'uniq') return args.filter((a) => !a.startsWith('-')).length > 1 ? writes : null;
  return null;
}

// Arguments after the script name (or after "exec <bin>") that a test runner
// would read as a snapshot update or a report file.
function testArgsDenied(args) {
  for (const a of args) {
    if (a === '--') continue;
    if (TEST_WRITES.some((o) => longMatches(a, o))) return 'passes a test-runner option that writes files (snapshot update or report file)';
    if (clusterHas(a, 'u')) return 'passes -u, which updates test snapshots';
  }
  return null;
}

function tscArgsDenied(args) {
  const lower = args.map((a) => a.toLowerCase());
  const k = lower.findIndex((a) => a === '--noemit' || a.startsWith('--noemit='));
  if (k < 0) return 'runs tsc without --noEmit';
  if (/^--noemit=(false|0)$/.test(lower[k]) || /^(false|0)$/.test(lower[k + 1] || '')) return 'runs tsc with --noEmit turned off';
  const bad = lower.find((a) => TSC_WRITES.has(a.split('=')[0]));
  return bad ? `runs tsc ${bad}, which writes files or starts a watcher` : null;
}

function scriptDenied(base, args) {
  const other = 'runs a script other than test or typecheck';
  let script;
  let rest;
  if (args[0] === 'test' || args[0] === 't') { script = 'test'; rest = args.slice(1); }
  else if (args[0] === 'run') { script = args[1] || ''; rest = args.slice(2); }
  else if ((base === 'pnpm' || base === 'npm') && args[0] === 'exec') {
    const bin = args[1];
    if (bin === 'vitest') {
      if (!(args[2] === 'run' || args.includes('--run'))) return 'runs vitest in watch mode';
      return testArgsDenied(args.slice(2));
    }
    if (bin === 'tsc') return tscArgsDenied(args.slice(2));
    return other;
  } else if (base !== 'npm') { script = args[0] || ''; rest = args.slice(1); }
  else return other;
  if (TEST_SCRIPT.test(script)) return testArgsDenied(rest);
  if (script === 'typecheck') return rest.length === 0 ? null : 'passes extra arguments to the typecheck script';
  return other;
}

// Why one parsed simple command is not read-only, or null when it is.
function commandDenied(cmd) {
  for (const r of cmd.redirects) {
    if (r.heredoc || r.op === '<' || r.op === '<<<' || r.op === '<&') continue;
    if (r.op === '>&' && /^\d+$/.test(r.target)) continue;
    if (r.target === '/dev/null') continue;
    return 'writes to a file with a redirection';
  }
  const eff = shell.effectiveArgv(cmd.argv);
  if (eff.length === 0) return null;
  if (eff.length !== cmd.argv.length) return 'sets environment variables or runs a wrapper (env, sudo, xargs, timeout, ...)';
  const base = shell.baseName(eff[0]);
  const args = eff.slice(1);
  if (base === 'git') return gitDenied(eff);
  if (FILE_READ.has(base)) return fileUtilDenied(base, args);
  if (SCRIPT_RUNNERS.has(base)) return scriptDenied(base, args);
  return `runs "${base}", which is not on the read-only allowlist`;
}

// Why a command string is not read-only, or null when every command in it is.
function commandStringDenied(command) {
  let pipelines;
  try {
    pipelines = shell.parse(command);
  } catch (e) {
    return `could not be parsed (${e.message})`;
  }
  for (const cmd of shell.allCommands(pipelines)) {
    const why = commandDenied(cmd);
    if (why) return why;
  }
  return null;
}

const ALLOWED_SUMMARY = "read-only git commands, read-only file utilities, and the project's test and typecheck scripts";

module.exports = { commandStringDenied, commandDenied, ALLOWED_SUMMARY };
