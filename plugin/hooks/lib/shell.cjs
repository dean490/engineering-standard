'use strict';
// Best-effort POSIX shell parser for the eng-standard guard hooks.
//
// It turns a command line into pipelines of simple commands, keeps redirections
// apart from arguments, and pulls out commands nested in $(...), `...`, <(...)
// and >(...) so a guard can inspect every command that would run. Heredoc
// bodies and comments are skipped. It is not a full shell: callers that enforce
// policy treat a ParseError as "can't tell" and fail closed.
//
// No dependencies. Node >= 18.

class ParseError extends Error {}

const MAX_DEPTH = 8;

// Operators, longest first so the lexer takes the longest match.
const OPERATORS = [
  '&>>', '<<<', '<<-',
  '&&', '||', ';;', '|&', '>>', '<<', '<>', '>|', '>&', '<&', '&>',
  ';', '|', '&', '<', '>', '(', ')', '\n',
];
const REDIRECT_OPS = new Set(['>', '>>', '<', '<>', '>|', '>&', '<&', '&>', '&>>', '<<<']);
const HEREDOC_OPS = new Set(['<<', '<<-']);
const LIST_SEPARATORS = new Set([';', '&', '&&', '||', '\n', '(', ')', ';;']);
const PIPE_OPS = new Set(['|', '|&']);
const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);

// Reserved words that start a compound command; the command follows them.
const PREFIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
// Reserved words that end a compound command and carry no command of their own.
const CLOSING_KEYWORDS = new Set(['fi', 'done', 'esac', '}']);

// Read from text[i] (just after an opening "(") to the matching ")".
// Returns the index of the closing ")".
function findClosingParen(text, i) {
  let depth = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new ParseError('unterminated single quote');
      i = end + 1;
      continue;
    }
    if (c === '"') { i = findClosingDoubleQuote(text, i + 1) + 1; continue; }
    if (c === '`') { i = findClosingBacktick(text, i + 1) + 1; continue; }
    if (c === '(') depth += 1;
    if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  throw new ParseError('unterminated parenthesis');
}

function findClosingBacktick(text, i) {
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') return i;
    i += 1;
  }
  throw new ParseError('unterminated backtick');
}

function findClosingDoubleQuote(text, i) {
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i;
    if (c === '`') { i = findClosingBacktick(text, i + 1) + 1; continue; }
    if (c === '$' && text[i + 1] === '(') { i = findClosingParen(text, i + 2) + 1; continue; }
    i += 1;
  }
  throw new ParseError('unterminated double quote');
}

// Lex one word starting at text[i]. Returns { word, end }.
function readWord(text, i) {
  const word = { value: '', glob: false, nested: [], quoted: false };
  while (i < text.length) {
    const c = text[i];
    if (WORD_BREAK.has(c)) {
      // "<(" and ">(" inside a word are process substitutions, not redirections.
      if ((c === '<' || c === '>') && text[i + 1] === '(' && word.value === '') {
        const close = findClosingParen(text, i + 2);
        word.nested.push(text.slice(i + 2, close));
        word.value += text.slice(i, close + 1);
        i = close + 1;
        continue;
      }
      break;
    }
    if (c === '\\') {
      if (text[i + 1] === '\n') { i += 2; continue; }
      if (i + 1 < text.length) word.value += text[i + 1];
      word.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new ParseError('unterminated single quote');
      word.value += text.slice(i + 1, end);
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === "'") {
      // ANSI-C quoting: keep the text, drop the quotes.
      let j = i + 2;
      let out = '';
      while (j < text.length && text[j] !== "'") {
        if (text[j] === '\\' && j + 1 < text.length) { out += text[j + 1]; j += 2; continue; }
        out += text[j];
        j += 1;
      }
      if (j >= text.length) throw new ParseError("unterminated $'...'");
      word.value += out;
      word.quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const end = findClosingDoubleQuote(text, i + 1);
      const inner = text.slice(i + 1, end);
      collectSubstitutions(inner, word.nested);
      word.value += inner.replace(/\\(["\\$`])/g, '$1');
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = findClosingBacktick(text, i + 1);
      word.nested.push(text.slice(i + 1, end));
      word.value += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === '(' && text[i + 2] === '(') {
      // Arithmetic expansion: not a command.
      const close = findClosingParen(text, i + 3);
      const close2 = text[close + 1] === ')' ? close + 1 : close;
      word.value += text.slice(i, close2 + 1);
      i = close2 + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      const close = findClosingParen(text, i + 2);
      word.nested.push(text.slice(i + 2, close));
      word.value += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === '$' && text[i + 1] === '{') {
      const close = text.indexOf('}', i + 2);
      if (close < 0) throw new ParseError('unterminated ${');
      word.value += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (c === '*' || c === '?' || c === '[') word.glob = true;
    word.value += c;
    i += 1;
  }
  return { word, end: i };
}

// Find $(...) and `...` inside double-quoted text.
function collectSubstitutions(inner, out) {
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      const end = findClosingBacktick(inner, i + 1);
      out.push(inner.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === '$' && inner[i + 1] === '(' && inner[i + 2] !== '(') {
      const close = findClosingParen(inner, i + 2);
      out.push(inner.slice(i + 2, close));
      i = close + 1;
      continue;
    }
    i += 1;
  }
}

function matchOperator(text, i) {
  for (const op of OPERATORS) {
    if (text.startsWith(op, i)) return op;
  }
  return null;
}

// Lex the whole string into tokens: { type: 'word', word } | { type: 'op', op, fd }.
function lex(text) {
  const tokens = [];
  const pendingHeredocs = [];
  const heredocNested = []; // $(...) and `...` in unquoted heredoc bodies, which the shell runs
  let i = 0;
  let atWordStart = true;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; atWordStart = true; continue; }
    if (c === '\\' && text[i + 1] === '\n') { i += 2; continue; }
    if (c === '#' && atWordStart) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    // An fd number glued to a redirection, such as 2> or 1>&2.
    const fdMatch = /^(\d+)(?=[<>])/.exec(text.slice(i));
    if (fdMatch) {
      const op = matchOperator(text, i + fdMatch[1].length);
      if (op && (REDIRECT_OPS.has(op) || HEREDOC_OPS.has(op))) {
        tokens.push({ type: 'op', op, fd: fdMatch[1] });
        i += fdMatch[1].length + op.length;
        atWordStart = true;
        if (HEREDOC_OPS.has(op)) i = readHeredocDelimiter(text, i, op, pendingHeredocs, tokens);
        continue;
      }
    }
    const op = (c === '<' || c === '>') && text[i + 1] === '(' ? null : matchOperator(text, i);
    if (op) {
      tokens.push({ type: 'op', op });
      i += op.length;
      atWordStart = true;
      if (HEREDOC_OPS.has(op)) {
        i = readHeredocDelimiter(text, i, op, pendingHeredocs, tokens);
        continue;
      }
      if (op === '\n' && pendingHeredocs.length > 0) i = skipHeredocBodies(text, i, pendingHeredocs, heredocNested);
      continue;
    }
    const { word, end } = readWord(text, i);
    tokens.push({ type: 'word', word });
    i = end;
    atWordStart = false;
  }
  return { tokens, heredocNested };
}

function readHeredocDelimiter(text, i, op, pending, tokens) {
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  const { word, end } = readWord(text, i);
  if (!word.value) throw new ParseError('heredoc without a delimiter');
  pending.push({ delimiter: word.value, stripTabs: op === '<<-', expands: !word.quoted });
  tokens.push({ type: 'word', word: { value: word.value, glob: false, nested: [], quoted: true } });
  return end;
}

// Skip heredoc bodies. With an unquoted delimiter the shell expands $(...) and
// backticks in the body, so those are collected for inspection.
function skipHeredocBodies(text, i, pending, nestedOut) {
  while (pending.length > 0) {
    const { delimiter, stripTabs, expands } = pending.shift();
    for (;;) {
      if (i >= text.length) return i; // unterminated heredoc ends at end of input, as in bash
      const nl = text.indexOf('\n', i);
      const lineEnd = nl < 0 ? text.length : nl;
      let line = text.slice(i, lineEnd);
      if (stripTabs) line = line.replace(/^\t+/, '');
      i = nl < 0 ? text.length : nl + 1;
      if (line === delimiter) break;
      if (expands) collectSubstitutions(line, nestedOut);
    }
  }
  return i;
}

function newCommand() {
  return { argv: [], words: [], redirects: [] };
}

// Parse a command string. Returns a flat list of pipelines; each pipeline is
// { commands: [{ argv, words, redirects }], nested: boolean }.
function parse(text, depth = 0) {
  if (depth > MAX_DEPTH) throw new ParseError('command nesting too deep');
  if (typeof text !== 'string') throw new ParseError('command is not a string');
  const { tokens, heredocNested } = lex(text);
  const pipelines = [];
  const nestedSources = heredocNested.slice();
  let pipeline = { commands: [], nested: depth > 0 };
  let cmd = newCommand();

  const endCommand = () => {
    if (cmd.argv.length > 0 || cmd.redirects.length > 0) pipeline.commands.push(cmd);
    cmd = newCommand();
  };
  const endPipeline = () => {
    endCommand();
    if (pipeline.commands.length > 0) pipelines.push(pipeline);
    pipeline = { commands: [], nested: depth > 0 };
  };

  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];
    if (tok.type === 'op') {
      if (LIST_SEPARATORS.has(tok.op)) { endPipeline(); continue; }
      if (PIPE_OPS.has(tok.op)) { endCommand(); continue; }
      if (REDIRECT_OPS.has(tok.op) || HEREDOC_OPS.has(tok.op)) {
        const next = tokens[t + 1];
        if (!next || next.type !== 'word') throw new ParseError(`redirection ${tok.op} without a target`);
        cmd.redirects.push({ op: tok.op, fd: tok.fd || null, target: next.word.value, heredoc: HEREDOC_OPS.has(tok.op) });
        for (const n of next.word.nested) nestedSources.push(n);
        t += 1;
        continue;
      }
      throw new ParseError(`unexpected operator ${tok.op}`);
    }
    const w = tok.word;
    for (const n of w.nested) nestedSources.push(n);
    if (cmd.argv.length === 0 && !w.quoted) {
      if (PREFIX_KEYWORDS.has(w.value)) continue;
      if (CLOSING_KEYWORDS.has(w.value)) continue;
    }
    cmd.argv.push(w.value);
    cmd.words.push(w);
  }
  endPipeline();

  for (const src of nestedSources) {
    for (const p of parse(src, depth + 1)) {
      p.nested = true;
      pipelines.push(p);
    }
  }
  return pipelines;
}

// All simple commands in a parsed command, nested ones included.
function allCommands(pipelines) {
  const out = [];
  for (const p of pipelines) for (const c of p.commands) out.push(c);
  return out;
}

function baseName(cmd) {
  if (typeof cmd !== 'string') return '';
  const b = cmd.replace(/\\/g, '/').split('/').pop();
  return b.replace(/\.(exe|cmd|bat)$/i, '');
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Strip leading VAR=value assignments and process wrappers that run their
// arguments as the command (timeout, nice, env, sudo, xargs, ...).
// Returns the argv of the command that actually runs.
function effectiveArgv(argv) {
  let a = argv.slice();
  for (let guard = 0; guard < 16 && a.length > 0; guard += 1) {
    while (a.length > 0 && ASSIGNMENT.test(a[0])) a.shift();
    if (a.length === 0) return a;
    const name = baseName(a[0]);
    let rest = null;
    switch (name) {
      case 'time':
      case 'nohup':
      case 'builtin':
      case 'noglob':
      case 'nocorrect':
        rest = a.slice(1).filter((x, idx) => !(idx === 0 && x === '-p'));
        break;
      case 'command': {
        rest = a.slice(1);
        if (rest[0] === '-v' || rest[0] === '-V') return a; // lookup, not execution
        if (rest[0] === '-p') rest = rest.slice(1);
        break;
      }
      case 'exec': {
        rest = a.slice(1);
        while (rest.length && /^-/.test(rest[0])) rest = rest[0] === '-a' ? rest.slice(2) : rest.slice(1);
        break;
      }
      case 'nice': {
        rest = a.slice(1);
        if (rest[0] === '-n') rest = rest.slice(2);
        else if (/^-\d+$/.test(rest[0] || '') || /^-n\d+$/.test(rest[0] || '')) rest = rest.slice(1);
        break;
      }
      case 'timeout': {
        rest = a.slice(1);
        while (rest.length && /^-/.test(rest[0])) {
          rest = /^-(s|k)$/.test(rest[0]) || /^--(signal|kill-after)$/.test(rest[0]) ? rest.slice(2) : rest.slice(1);
        }
        rest = rest.slice(1); // the duration
        break;
      }
      case 'stdbuf': {
        rest = a.slice(1);
        while (rest.length && /^-/.test(rest[0])) rest = /^-[ioe]$/.test(rest[0]) ? rest.slice(2) : rest.slice(1);
        break;
      }
      case 'env': {
        rest = a.slice(1);
        while (rest.length && (/^-/.test(rest[0]) || ASSIGNMENT.test(rest[0]))) {
          if (rest[0] === '-S' || rest[0] === '--split-string') {
            // env -S 'cmd args' splits one string into argv.
            const split = (rest[1] || '').split(/\s+/).filter(Boolean);
            rest = split.concat(rest.slice(2));
            break;
          }
          rest = /^-(u|C)$/.test(rest[0]) || /^--(unset|chdir)$/.test(rest[0]) ? rest.slice(2) : rest.slice(1);
        }
        break;
      }
      case 'sudo':
      case 'doas': {
        rest = a.slice(1);
        while (rest.length && /^-/.test(rest[0])) {
          if (rest[0] === '--') { rest = rest.slice(1); break; }
          rest = /^-[ugCDhpRrTt]$/.test(rest[0]) ? rest.slice(2) : rest.slice(1);
        }
        break;
      }
      case 'xargs': {
        rest = a.slice(1);
        while (rest.length && /^-/.test(rest[0])) {
          if (rest[0] === '--') { rest = rest.slice(1); break; }
          rest = /^-[nILPdEsa]$/.test(rest[0]) ? rest.slice(2) : rest.slice(1);
        }
        break;
      }
      default:
        return a;
    }
    a = rest;
  }
  return a;
}

const PNPM_BUILTINS = new Set([
  'add', 'i', 'install', 'ln', 'link', 'rm', 'remove', 'un', 'uninstall', 'unlink', 'up', 'update',
  'upgrade', 'audit', 'ls', 'list', 'outdated', 'why', 'run', 'test', 't', 'tst', 'start', 'exec',
  'dlx', 'create', 'init', 'publish', 'pack', 'prune', 'rebuild', 'rb', 'root', 'bin', 'store',
  'config', 'c', 'get', 'set', 'env', 'setup', 'import', 'fetch', 'patch', 'patch-commit',
  'approve-builds', 'dedupe', 'deploy', 'doctor', 'licenses', 'self-update', 'server', 'help',
  'cat-file', 'cat-index', 'find-hash', 'pm', 'runtime', 'sbom', 'version', 'install-test', 'it',
]);

// When argv runs a package binary through a runner (npx, pnpm exec, pnpm dlx,
// pnpx, bunx, yarn, npm exec), return the argv of that binary. Otherwise null.
function unwrapRunner(argv) {
  if (argv.length === 0) return null;
  const name = baseName(argv[0]);
  const stripVersion = (pkg) => pkg.replace(/^(@[^/]+\/[^@]+|[^@]+)@.*$/, '$1');
  const binOf = (pkg) => baseName(stripVersion(pkg));
  const takeAfterOptions = (rest, optsWithValue) => {
    let r = rest;
    while (r.length && /^-/.test(r[0])) {
      if (r[0] === '--') { r = r.slice(1); break; }
      r = optsWithValue.test(r[0]) ? r.slice(2) : r.slice(1);
    }
    return r;
  };
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    const r = takeAfterOptions(argv.slice(1), /^(-p|--package|--registry|--cache)$/);
    return r.length ? [binOf(r[0])].concat(r.slice(1)) : null;
  }
  if (name === 'pnpm' || name === 'yarn' || name === 'bun') {
    let r = argv.slice(1);
    // Global options such as -C <dir>, --dir <dir>, --filter <pkg>, -w.
    r = takeAfterOptions(r, /^(-C|--dir|--filter|-F|--workspace|--prefix|--cwd)$/);
    if (r.length === 0) return null;
    if (r[0] === 'exec' || r[0] === 'dlx' || r[0] === 'x') {
      const r2 = takeAfterOptions(r.slice(1), /^(--package|-p|--filter|-F|--shell-mode|-c)$/);
      return r2.length ? [binOf(r2[0])].concat(r2.slice(1)) : null;
    }
    if (name === 'pnpm' && !PNPM_BUILTINS.has(r[0])) return [binOf(r[0])].concat(r.slice(1));
    if (name === 'yarn' && !['add', 'install', 'remove', 'run', 'test', 'up', 'upgrade', 'why', 'info', 'init', 'config', 'workspace', 'workspaces', 'npm', 'set', 'cache', 'plugin', 'version', 'pack', 'link', 'unlink', 'patch', 'patch-commit', 'constraints', 'explain', 'node', 'rebuild', 'search', 'stage', 'unplug', 'dedupe', 'outdated', 'audit', 'global', 'help'].includes(r[0])) {
      return [binOf(r[0])].concat(r.slice(1));
    }
    return null;
  }
  if (name === 'npm') {
    const r = argv.slice(1);
    if (r[0] === 'exec' || r[0] === 'x') {
      const r2 = takeAfterOptions(r.slice(1), /^(-p|--package|-c|--call|-w|--workspace)$/);
      return r2.length ? [binOf(r2[0])].concat(r2.slice(1)) : null;
    }
  }
  return null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'mksh', 'busybox']);

// If argv runs a shell on an inline script (sh -c '...', bash -lc "...",
// eval ..., npx -c '...'), return the script text. Otherwise null.
function inlineScript(argv) {
  if (argv.length === 0) return null;
  const name = baseName(argv[0]);
  if (name === 'eval') return argv.slice(1).join(' ');
  if (SHELLS.has(name)) {
    for (let k = 1; k < argv.length; k += 1) {
      const a = argv[k];
      if (a === '--') break;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return argv[k + 1] !== undefined ? argv[k + 1] : '';
      if (!/^-/.test(a) && !/^\+/.test(a)) break;
    }
  }
  if ((name === 'npx' || name === 'pnpm') && argv.includes('-c')) {
    const k = argv.indexOf('-c');
    return argv[k + 1] !== undefined ? argv[k + 1] : '';
  }
  return null;
}

module.exports = {
  ParseError,
  parse,
  allCommands,
  baseName,
  effectiveArgv,
  unwrapRunner,
  inlineScript,
  SHELLS,
};
