'use strict';
// Which events and tools each hook in hooks.json runs for (Critic v0.1.0,
// CR-3 and CR-25). A matcher is evaluated as the hooks reference describes
// ("Matcher patterns", .recon/brief-03/docs-cc-hooks.md): "*", "", or none
// matches everything; letters, digits, "_", "-", spaces, ",", and "|" form a
// list of exact names; anything else is an unanchored regular expression.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const config = JSON.parse(fs.readFileSync(path.join(HOOKS_DIR, 'hooks.json'), 'utf8')).hooks;

function matches(matcher, value) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((m) => m.trim()).includes(value);
  return new RegExp(matcher).test(value);
}

// For each hook script (and argument list), the events it is wired to and the
// tools its matchers select from TOOLS.
const TOOLS = ['Bash', 'PowerShell', 'Monitor', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'Agent', 'mcp__db__query'];
function wiring() {
  const out = {};
  for (const [event, entries] of Object.entries(config)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        assert.equal(h.type, 'command');
        assert.equal(h.command, 'node');
        assert.match(h.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[a-z-]+\.cjs$/);
        const key = [path.basename(h.args[0]), ...h.args.slice(1)].join(' ');
        out[key] = out[key] || {};
        out[key][event] = [...new Set([...(out[key][event] || []), ...TOOLS.filter((t) => matches(entry.matcher, t))])].sort();
      }
    }
  }
  return out;
}

const SHELL = ['Bash', 'Monitor', 'PowerShell'];

test('hooks.json: every hook runs for exactly the events and tools it guards', () => {
  assert.deepEqual(wiring(), {
    'secret-guard-read.cjs': { PreToolUse: ['Grep', 'Read', ...SHELL].sort() },
    'protect-paths.cjs': { PreToolUse: ['Edit', 'NotebookEdit', 'Write'] },
    'planner-readonly.cjs': { PreToolUse: ['Edit', 'NotebookEdit', 'Write', ...SHELL].sort() },
    'planner-readonly.cjs --record-role': { UserPromptSubmit: [...TOOLS].sort() },
    'compact-stop.cjs': { PreToolUse: [...TOOLS].sort(), PreCompact: [...TOOLS].sort(), SessionStart: [...TOOLS].sort() },
    'token-watch.cjs': { PreToolUse: [...TOOLS].sort() },
    'web-limit.cjs': { PreToolUse: ['WebFetch'] },
    'commit-hygiene.cjs': { PreToolUse: [...SHELL].sort() },
    'critic-readonly.cjs': { PreToolUse: [...SHELL].sort() },
    'secret-redact.cjs': { PostToolUse: [...TOOLS].sort() },
    'stop-gate.cjs': { Stop: [...TOOLS].sort() },
  });
});

test('hooks.json: every hook that reads a shell command also runs for Monitor (CR-3)', () => {
  for (const [hook, events] of Object.entries(wiring())) {
    const tools = events.PreToolUse || [];
    if (tools.includes('Bash')) assert.ok(tools.includes('Monitor') && tools.includes('PowerShell'), `${hook} runs for Bash but not for every shell tool`);
  }
});

test('hooks.json: every hook script is wired, and every wired script exists', () => {
  const scripts = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.cjs')).sort();
  const wired = [...new Set(Object.keys(wiring()).map((k) => k.split(' ')[0]))].sort();
  assert.deepEqual(wired, scripts);
});

test('hooks.json: compact-stop runs for every tool call, every PreCompact, and every SessionStart, and decides inside the script', () => {
  // No matcher on PreCompact or SessionStart: the script checks trigger "auto" and source "compact" itself,
  // so a change in the matcher values can't switch the guard off without a test failing.
  for (const event of ['PreToolUse', 'PreCompact', 'SessionStart']) {
    const entries = config[event].filter((e) => e.hooks.some((h) => h.args[0].endsWith('/compact-stop.cjs')));
    assert.equal(entries.length, 1, event);
    assert.ok(entries[0].matcher === undefined || entries[0].matcher === '*', `${event} matcher`);
    const hook = entries[0].hooks.find((h) => h.args[0].endsWith('/compact-stop.cjs'));
    assert.deepEqual(hook.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/compact-stop.cjs']);
    assert.ok(hook.timeout <= 30);
  }
});

test('hooks.json: token-watch runs for every tool call with no matcher narrowing, and web-limit for WebFetch and WebSearch', () => {
  const entries = config.PreToolUse.filter((e) => e.hooks.some((h) => h.args[0].endsWith('/token-watch.cjs')));
  assert.equal(entries.length, 1);
  assert.ok(entries[0].matcher === '*');
  assert.ok(entries[0].hooks[0].timeout <= 30);
  const web = config.PreToolUse.filter((e) => e.hooks.some((h) => h.args[0].endsWith('/web-limit.cjs')));
  assert.equal(web.length, 1);
  assert.ok(matches(web[0].matcher, 'WebFetch') && matches(web[0].matcher, 'WebSearch') && !matches(web[0].matcher, 'Read'));
});

test('hooks.json: the stop gate needs no long timeout, since it runs no project scripts', () => {
  const stopHook = config.Stop[0].hooks[0];
  assert.ok(stopHook.timeout <= 60, `timeout ${stopHook.timeout}`);
});

test('the matcher rules used here follow the hooks reference', () => {
  assert.ok(matches('Bash|PowerShell|Monitor', 'Monitor'));
  assert.ok(!matches('Bash|PowerShell', 'Monitor'));
  assert.ok(matches('Bash, Monitor', 'Monitor'), 'a comma also separates names');
  assert.ok(!matches('Bash', 'Monitor'));
  assert.ok(matches('Edit.*', 'NotebookEdit'), 'a regular expression is unanchored');
  assert.ok(matches('*', 'anything'));
});
