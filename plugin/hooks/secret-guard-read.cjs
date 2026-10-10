#!/usr/bin/env node
'use strict';
// PreToolUse: secret guard, part A. Matches Read|Grep|Bash|PowerShell|Monitor.
// Ported from QuaSaR's .claude/hooks/secret-guard-read.cjs (proven there), made
// portable and fail-closed for the engineering standard (STANDARD 3.1, 3.7).
//
// Denies any attempt to read a .env* file or a key file, either directly with
// the Read or Grep tool or through a file-reading shell command (cat, type,
// Get-Content and close relatives). It stops the secret before it is ever
// produced, but it is a guardrail: it reads command text, and code such as
// node -e "...readFileSync('.env.local')" gets past it. The wall for shell
// commands is the sandbox's read block on .env* (sandbox.filesystem.denyRead
// and the Read deny rules in templates/.claude/settings.json); the Read deny
// rules are the wall for Claude's own file tools.
//
// Shell commands are parsed, so a path counts only where a file-reading command
// reads it: grep's and rg's pattern, jq's filter, and sed's and awk's script
// are not paths (`jq .key package.json`, `grep -rn "api.key" src/`). A glob
// that matches a secret file (`cat .en?` where .env exists) counts. A command the parser
// can't read falls back to the text patterns below.
//
// Exit 2 = deny (reason on stderr). Exit 0 = no decision.
// Fails closed: input that can't be parsed is denied.

let common;
let shell;
try {
  common = require('./lib/common.cjs');
  shell = require('./lib/shell.cjs');
} catch (err) {
  process.stderr.write(`secret-guard-read: failed to load helpers (${err.message}); blocking (fail closed).\n`);
  process.exit(2);
}
const fs = require('fs');
const path = require('path');

const TAG = '(guard: eng-standard secret-guard-read)';

// A path component that is .env or starts with .env (.env.local, .envrc),
// matching the .env* deny rule.
const ENV_BASENAME = /^\.env/i;
// Private keys and certificate stores: a name before the extension (so a jq
// path such as .key is not a key file), or an SSH private key name.
const KEY_BASENAME = /(^.+\.(pem|key|p12|pfx)$)|(^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$)/i;
// Names a glob is tested against when its directory can't be listed.
const SECRET_SAMPLES = ['.env', '.env.local', '.envrc', 'server.pem', 'server.key', 'cert.p12', 'cert.pfx', 'id_rsa', 'id_ed25519'];

// Commands that emit or copy file contents (QuaSaR list plus source, cp, mv,
// base64, jq, tac, cut, sort, diff, dd, hexdump, bat).
const READ_VERBS = new Set([
  'cat', 'type', 'more', 'less', 'head', 'tail', 'nl', 'strings', 'gc', 'get-content', 'select-string', 'sls', 'grep',
  'rg', 'egrep', 'fgrep', 'awk', 'sed', 'xxd', 'od', 'format-hex', 'source', '.', 'cp', 'mv', 'base64', 'jq', 'tac',
  'cut', 'sort', 'diff', 'dd', 'hexdump', 'bat',
]);
// Commands whose first operand is a pattern, filter, or script, not a file,
// unless an option such as -e or -f supplies it.
const FIRST_OPERAND_NOT_A_PATH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'jq', 'sed', 'awk', 'select-string', 'sls']);
const PATTERN_OPTIONS = /^(-e|-f|--regexp|--file|--expression|--from-file|-Pattern)(=|$)|^-[A-Za-z]*[ef]$/i;

// Fallback text patterns for a command the parser can't read: a .env* or
// key-file token that starts a path (after the start, "/", whitespace, or a
// quote) and a file-reading command anywhere in the text.
const ENV_IN_COMMAND = /(?:^|[\s"'/])\.env[A-Za-z0-9_.-]*(?=$|[\s"'`)\];|&,<>])/i;
const KEY_IN_COMMAND =
  /(?:(?:^|[\s"'/])[^\s"'`;|&<>()/.][^\s"'`;|&<>()/]*\.(?:pem|key|p12|pfx)|(?:^|[\s"'/])id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?)(?=$|[\s"'`)\];|&,<>])/i;
const READ_VERB =
  /(?:^|[\s;|&(])(?:cat|type|more|less|head|tail|nl|strings|gc|Get-Content|Select-String|sls|grep|rg|egrep|fgrep|awk|sed|xxd|od|Format-Hex|source|cp|mv|base64|jq|tac|cut|sort|diff|dd|hexdump|bat)(?=[\s;|&)]|$)/i;
const REDIRECT_FROM_SECRET =
  /<\s*["']?[^\s"'`;|&<>()]*(?:\.env[A-Za-z0-9_.-]*|\.(?:pem|key|p12|pfx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?)["']?(?=$|[\s;|&)])/i;

function secretKind(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const base = path.basename(p.replace(/\\/g, '/'));
  if (ENV_BASENAME.test(base)) return 'environment/secret file';
  if (KEY_BASENAME.test(base)) return 'key file';
  return null;
}

// A shell glob for one path component, as a regular expression. A leading * or
// ? doesn't match a leading dot, as in the shell.
function globRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') re += i === 0 ? '(?!\\.)[^/]*' : '[^/]*';
    else if (c === '?') re += i === 0 ? '[^/.]' : '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

// The kind of secret a word names, or that a glob in it matches, or null. A
// glob is expanded against the files in its directory, as the shell would;
// when that directory can't be listed, it is tested against typical names.
function wordSecret(word, cwd) {
  const kind = secretKind(word.value);
  if (kind) return kind;
  if (!word.glob) return null;
  const value = word.value.replace(/\\/g, '/');
  let re;
  try {
    re = globRegExp(path.posix.basename(value));
  } catch {
    return null;
  }
  const dir = path.posix.dirname(value);
  let names = SECRET_SAMPLES;
  if (!/[*?[]/.test(dir)) {
    try {
      names = fs.readdirSync(path.resolve(cwd, dir));
    } catch {
      names = SECRET_SAMPLES;
    }
  }
  const hit = names.find((n) => re.test(n) && secretKind(n));
  return hit ? secretKind(hit) : null;
}

// The secret a parsed command line reads, or null. Throws ParseError.
function shellReadsSecret(command, cwd, depth = 0) {
  for (const cmd of shell.allCommands(shell.parse(command))) {
    for (const r of cmd.redirects) {
      if ((r.op === '<' || r.op === '<>') && secretKind(r.target)) return `${secretKind(r.target)} "${r.target}" (input redirection)`;
    }
    const eff = shell.effectiveArgv(cmd.argv);
    if (eff.length === 0) continue;
    const script = shell.inlineScript(eff);
    if (script !== null && depth < 4) {
      const inner = shellReadsSecret(script, cwd, depth + 1);
      if (inner) return inner;
    }
    const base = shell.baseName(eff[0]).toLowerCase();
    if (!READ_VERBS.has(base)) continue;
    // The words of the effective command, with their glob flags.
    const words = cmd.words.slice(cmd.words.length - eff.length + 1);
    const args = eff.slice(1);
    let skip = -1;
    if (FIRST_OPERAND_NOT_A_PATH.has(base) && !args.some((a) => PATTERN_OPTIONS.test(a))) {
      skip = args.findIndex((a) => !a.startsWith('-'));
    }
    for (let k = 0; k < args.length; k += 1) {
      if (k === skip) continue;
      const word = words.length === args.length ? words[k] : { value: args[k], glob: false };
      const kind = wordSecret(word, cwd);
      if (kind) return `${kind} "${args[k]}"`;
    }
  }
  return null;
}

function decide(payload) {
  const tool = payload.tool_name;
  const ti = payload.tool_input;
  if (typeof tool !== 'string') return `Blocked: hook input has no tool_name; blocking (fail closed). ${TAG}`;
  if (ti === null || typeof ti !== 'object') return `Blocked: hook input has no tool_input; blocking (fail closed). ${TAG}`;

  if (tool === 'Read' || tool === 'NotebookRead') {
    const target = ti.file_path || ti.notebook_path || ti.path;
    if (typeof target !== 'string' || target.length === 0) {
      return `Blocked: ${tool} call without a file path; blocking (fail closed). ${TAG}`;
    }
    const kind = secretKind(target);
    if (kind) return `Blocked: reading ${kind} "${target}" is not permitted. ${TAG}`;
    return null;
  }

  if (tool === 'Grep') {
    for (const field of ['path', 'glob']) {
      const kind = secretKind(ti[field]);
      if (kind) return `Blocked: searching ${kind} "${ti[field]}" is not permitted. ${TAG}`;
    }
    return null;
  }

  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor') {
    // A Monitor WebSocket watch runs no command.
    if (tool === 'Monitor' && ti.command === undefined && ti.ws && typeof ti.ws === 'object') return null;
    if (typeof ti.command !== 'string') {
      return `Blocked: ${tool} call without a command string; blocking (fail closed). ${TAG}`;
    }
    const cmd = ti.command;
    let found;
    try {
      found = shellReadsSecret(cmd, typeof payload.cwd === 'string' ? payload.cwd : common.projectDir(payload));
    } catch (e) {
      if (!(e instanceof shell.ParseError)) throw e;
      if (REDIRECT_FROM_SECRET.test(cmd)) found = 'a .env* or key file (input redirection)';
      else if ((ENV_IN_COMMAND.test(cmd) || KEY_IN_COMMAND.test(cmd)) && READ_VERB.test(cmd)) found = 'a .env* or key file';
    }
    if (found) return `Blocked: this command reads ${found}, which holds secrets.\nCommand: ${cmd}\n${TAG}`;
    return null;
  }

  return null;
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
  try {
    reason = decide(payload);
  } catch (e) {
    reason = `Blocked: secret guard failed (${e.message}); blocking (fail closed). ${TAG}`;
  }
  if (reason) common.block(reason);
  common.allow();
});
