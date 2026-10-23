'use strict';
// The hand-off rule shared by compact-stop.cjs and token-watch.cjs (STANDARD
// 10.1): what a session is told to do, and which tool calls it may still make
// while it does it.

const os = require('os');
const path = require('path');

const ALWAYS_ALLOWED = new Set([
  'Read', 'Grep', 'Glob',
  'mcp__ccd_session__start_session', 'mcp__ccd_session_mgmt__detach_session',
]);
const WRITE_TOOLS = new Set(['Edit', 'Write']);
const TURN_PREFIX = 'mcp__ccd_turn__';
// The only tools ToolSearch may load while handing off.
const LOADABLE = new Set(['mcp__ccd_session__start_session', 'mcp__ccd_session_mgmt__detach_session']);

// lead: the sentence that says why the session hands off, ending in the hook's
// name; override: how the Owner turns the hook off.
function message(lead, override) {
  return `${lead} ` +
    '1. Write where you stand into your state file: `.recon/<step>/INDEX.md` for a Builder, the brief file under `~/.claude/plans/` for a Planner. ' +
    '2. Call `start_session` directly: initiation "user_asked", context "fresh", `background: true`, the same model, effort and permission mode as this session (plan for a Planner), ' +
    'prompt "Continue <role> work from <state file>." plus this session\'s start-prompt role lines. ' +
    'If the call fails for a missing schema, load the tools with `ToolSearch` query `select:mcp__ccd_session__start_session,mcp__ccd_session_mgmt__detach_session` and call it again. ' +
    'If the app refuses the start because this turn came from another session, call `start_session` again with initiation "own_initiative", the same title, and the same prompt as a complete brief, which puts a start card in the transcript, ' +
    'then end your turn with one line: "Tap Start on the card \'<title>\' to continue." ' +
    '3. After a direct start, call `detach_session` with the new session\'s id. ' +
    '4. After a direct start, end your turn with one line naming the successor. ' +
    `Owner override: \`${override}\`.`;
}

// True when a write to the file in payload.tool_input is one a handing-off
// session may make: an INDEX.md one level under .recon/ in the project, or
// anything under ~/.claude/plans/.
function writeAllowed(common, payload) {
  const ti = payload.tool_input;
  const target = ti && typeof ti === 'object' ? ti.file_path : undefined;
  if (typeof target !== 'string' || target.length === 0) return false;
  const base = payload.cwd || common.projectDir(payload);
  const real = common.realpathLoose(path.isAbsolute(target) ? target : path.resolve(base, target));

  const plans = common.realpathLoose(path.join(os.homedir(), '.claude', 'plans'));
  if (common.isInside(real, plans)) return true;

  const recon = common.realpathLoose(path.join(common.projectDir(payload), '.recon'));
  if (!common.isInside(real, recon)) return false;
  const parts = common.toPosix(real).slice(common.toPosix(recon).replace(/\/+$/, '').length + 1).split('/');
  return parts.length === 2 && parts[0] !== '' && parts[0] !== '..' && parts[1] === 'INDEX.md';
}

// True when payload.tool_input.query is `select:<name>[,<name>...]` and every
// name is a tool a hand-off needs. Keyword queries and anything else are not.
function searchAllowed(payload) {
  const ti = payload.tool_input;
  const query = ti && typeof ti === 'object' ? ti.query : undefined;
  if (typeof query !== 'string' || !query.startsWith('select:')) return false;
  const names = query.slice('select:'.length).split(',').map((n) => n.trim());
  return names.every((n) => LOADABLE.has(n) || (n.startsWith(TURN_PREFIX) && n.length > TURN_PREFIX.length));
}

// True when a handing-off session may make this call.
function toolAllowed(common, payload) {
  const name = payload.tool_name;
  if (typeof name !== 'string') return true;
  if (ALWAYS_ALLOWED.has(name) || name.startsWith(TURN_PREFIX)) return true;
  if (name === 'ToolSearch') return searchAllowed(payload);
  return WRITE_TOOLS.has(name) && writeAllowed(common, payload);
}

module.exports = { message, toolAllowed };
