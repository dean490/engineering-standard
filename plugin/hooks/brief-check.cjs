#!/usr/bin/env node
'use strict';
// Brief check (constitution IV; STANDARD 1.9, 10.6).
//
// A brief can be marked approved only when it names one layer (server,
// screens, docs, or tooling), its model, and its effort. The hook runs before
// Write and Edit on ~/.claude/plans/**/BRIEF-*.md, computes the file as it
// will be after the call, and denies when that text has a `**Status:**
// approved` line and lacks any of:
//   - `**Layer:**` naming exactly one of server, screens, docs, tooling
//     (a parenthetical after it is ignored)
//   - a `**Model:**` line
//   - an effort, on the Model line or on an `**Effort:**` line
// A brief not marked approved is never checked.
//
// ENG_STANDARD_BRIEF_CHECK=off is the Owner's override. A guardrail, not a
// wall: it reads tool input, and it fails open on input it can't read, because
// a brief is a plan file, not a safety boundary.
// Exit 2 = deny (reason on stderr). Exit 0 = no decision.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAG = '(guard: eng-standard brief-check)';
const OFF_VALUES = new Set(['off', '0', 'false', 'no', 'disabled']);
const LAYERS = ['server', 'screens', 'docs', 'tooling'];
const REASON =
  'A brief can be approved only when it names one layer (server, screens, docs, or tooling), its model, and its effort ' +
  '(eng-standard brief-check, STANDARD 1.9, 10.6). Add the missing line and write again. ' +
  'Owner override: `ENG_STANDARD_BRIEF_CHECK=off`.';

function allow() {
  process.exit(0);
}

function isBriefPath(common, target) {
  if (!/^BRIEF-.+\.md$/.test(path.basename(target))) return false;
  const plans = common.realpathLoose(path.join(os.homedir(), '.claude', 'plans'));
  return common.isInside(common.realpathLoose(target), plans);
}

// The file's text after the call, or null when it can't be worked out.
function textAfter(payload, target) {
  const ti = payload.tool_input;
  if (payload.tool_name === 'Write') return typeof ti.content === 'string' ? ti.content : null;
  if (payload.tool_name !== 'Edit' || typeof ti.old_string !== 'string' || typeof ti.new_string !== 'string') return null;
  let before;
  try {
    before = fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
  if (ti.old_string === '' || !before.includes(ti.old_string)) return null;
  return ti.replace_all === true
    ? before.split(ti.old_string).join(ti.new_string)
    : before.replace(ti.old_string, () => ti.new_string);
}

function lineValue(text, label) {
  const m = new RegExp(`^[ \\t]*\\*\\*${label}:\\*\\*[ \\t]*(.*)$`, 'im').exec(text);
  return m ? m[1].trim() : null;
}

// What the approved brief lacks, as a list; empty when it is complete.
function missing(text) {
  const out = [];
  const layer = lineValue(text, 'Layer');
  const named = layer === null
    ? []
    : LAYERS.filter((l) => new RegExp(`\\b${l}\\b`, 'i').test(layer.replace(/\([^)]*\)/g, '')));
  if (named.length !== 1) out.push(layer === null ? 'a **Layer:** line' : `exactly one layer on the **Layer:** line (found: ${named.join(', ') || 'none'})`);
  const model = lineValue(text, 'Model');
  if (!model) out.push('a **Model:** line');
  const effort = lineValue(text, 'Effort');
  if (!(effort || (model && /\beffort\b/i.test(model)))) out.push('an effort (on the **Model:** line or an **Effort:** line)');
  return out;
}

function main(raw) {
  if (OFF_VALUES.has(String(process.env.ENG_STANDARD_BRIEF_CHECK || '').toLowerCase())) allow();
  const common = require('./lib/common.cjs');
  const payload = common.parsePayload(raw);
  if (payload.tool_name !== 'Write' && payload.tool_name !== 'Edit') allow();
  const ti = payload.tool_input;
  if (!ti || typeof ti !== 'object' || typeof ti.file_path !== 'string' || !ti.file_path) allow();
  const target = path.resolve(payload.cwd || process.cwd(), ti.file_path);
  if (!isBriefPath(common, target)) allow();
  const text = textAfter(payload, target);
  if (text === null || !/^[ \t]*\*\*Status:\*\*[ \t]*[`'"_*]*approved\b/im.test(text)) allow();
  const lacks = missing(text);
  if (lacks.length === 0) allow();
  common.block(`Blocked: ${payload.tool_name} -> ${ti.file_path}\nThis brief is marked approved but lacks ${lacks.join('; ')}.\n${REASON} ${TAG}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
  try {
    main(buf);
  } catch {
    allow();
  }
});
process.stdin.on('error', () => allow());
