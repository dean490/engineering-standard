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

// lead: the sentence that says why the session hands off, ending in the hook's
// name; override: how the Owner turns the hook off.
function message(lead, override) {
  return `${lead} ` +
    '1. Write where you stand into your state file: `.recon/<step>/INDEX.md` for a Builder, the brief file under `~/.claude/plans/` for a Planner. ' +
    '2. Start your successor with `start_session`: initiation "user_asked", context "fresh", the same model and permission mode as this session (plan for a Planner), ' +
    'prompt "Continue <role> work from <state file>." plus this session\'s start-prompt role lines. ' +
    '3. Call `detach_session` with the new session\'s id. ' +
    '4. End your turn with one line naming the successor. ' +
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

// True when a handing-off session may make this call.
function toolAllowed(common, payload) {
  const name = payload.tool_name;
  if (typeof name !== 'string') return true;
  if (ALWAYS_ALLOWED.has(name) || name.startsWith(TURN_PREFIX)) return true;
  return WRITE_TOOLS.has(name) && writeAllowed(common, payload);
}

module.exports = { message, toolAllowed };
