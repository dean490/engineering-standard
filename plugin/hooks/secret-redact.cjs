#!/usr/bin/env node
'use strict';
// PostToolUse: secret guard, part B. Matches every tool.
// Ported from QuaSaR's .claude/hooks/secret-redact.cjs and widened for the
// engineering standard (STANDARD 3.1): Supabase, GitHub, Anthropic, AWS, Stripe,
// and PEM private-key patterns. The local Supabase stack's fixed demo keys are
// exempt (exact values only).
//
// Scans the tool OUTPUT for credentials and returns a blocking decision that
// names the tool that leaked, so the value is not carried forward, echoed into
// a file, or committed, and so the Owner rotates it.
//
// ---------------------------------------------------------------------------
// KNOWN LIMITATION (carried forward from QuaSaR, corrected 2026-10-07):
// QuaSaR wrote that the PostToolUse API had no documented field for rewriting
// tool_response, so the hook could only detect and block. That is no longer
// true. The current hooks reference documents `updatedToolOutput`, which
// replaces the tool's output before Claude sees it, and says `decision: "block"`
// alone leaves Claude seeing the original output
// (evidence: .recon/brief-01/docs-cc-hooks.md, "PostToolUse decision control").
// So this hook does both: it blocks with the rotate-this-credential message and
// hands back a copy of the output with each match replaced.
//
// What still holds from QuaSaR's note: by the time this hook runs, the tool has
// already produced the value. Files it wrote, commands it ran, and telemetry
// that captured the original output are unchanged, and Claude Code ignores a
// replacement that doesn't match a built-in tool's output shape. So this is a
// SECOND line of defense. The load-bearing control is part A
// (secret-guard-read.cjs) plus the deny rules, which stop the read before any
// secret exists. Treat a part B firing as an incident signal, not as containment.
// ---------------------------------------------------------------------------
//
// Always exits 0; the decision travels as JSON on stdout.
// Fails closed: input that can't be parsed produces a blocking decision too.

const TAG = '(guard: eng-standard secret-redact)';

// The local Supabase stack's fixed demo values (Supabase CLI v2.120.0,
// packages/stack/src/Defaults.ts and apps/cli-go/pkg/config/apikeys.go; saved
// in .recon/brief-03/supabase-cli-v2.120.0/). `supabase start` and `supabase
// status` print them on every machine; they are public and are not flagged.
// The secret key is spelled in two parts so this file holds no token-shaped string.
const LOCAL_DEMO_SECRET_KEY = 'sb_secret_' + 'N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const LOCAL_DEMO_JWT_ISSUER = 'supabase-demo';

const PATTERNS = [
  { label: 'Supabase personal access token (sbp_)', re: /\bsbp_[A-Za-z0-9_-]{20,}/g },
  { label: 'Supabase secret key (sb_secret_)', re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g, except: (m) => m === LOCAL_DEMO_SECRET_KEY },
  { label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: 'AWS access key ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: 'AWS secret access key', re: /(aws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi, keepGroup: 1 },
  { label: 'Stripe secret key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { label: 'Stripe webhook secret', re: /\bwhsec_[A-Za-z0-9]{24,}/g },
  {
    // A BEGIN line counts on its own: output cut short by head, a Read limit,
    // or truncation still carries key material. Without an END line, the match
    // runs on through the lines that follow it that look like key material.
    label: 'private key',
    re: /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?)-----(?:[\s\S]*?-----END \1-----|(?:\r?\n[ \t]*[A-Za-z0-9+/=:,\- ]*)*)/g,
  },
];

// JWTs are public in general (the Supabase anon key is one), so only a JWT whose
// payload claims a privileged Supabase role counts as a secret, and not one the
// local stack issued (issuer supabase-demo).
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PRIVILEGED_ROLES = new Set(['service_role', 'supabase_admin']);

function jwtClaims(token) {
  try {
    const part = token.split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

// Replace every secret in a string. Returns { text, found: [labels] }.
function redactString(text) {
  let out = text;
  const found = [];
  for (const { label, re, keepGroup, except } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (...m) => {
      if (except && except(m[0])) return m[0];
      found.push(label);
      const keep = keepGroup ? m[keepGroup] : '';
      return `${keep}[REDACTED: ${label}]`;
    });
  }
  JWT.lastIndex = 0;
  out = out.replace(JWT, (token) => {
    const claims = jwtClaims(token);
    const role = claims && typeof claims.role === 'string' ? claims.role : null;
    if (role && PRIVILEGED_ROLES.has(role) && claims.iss !== LOCAL_DEMO_JWT_ISSUER) {
      const label = `Supabase ${role} JWT`;
      found.push(label);
      return `[REDACTED: ${label}]`;
    }
    return token;
  });
  return { text: out, found };
}

// Deep-copy a tool response, redacting every string. Keeps keys, types, and
// array lengths, so the copy has the same shape as the original.
function redactValue(value, found, depth = 0) {
  if (depth > 64) return value;
  if (typeof value === 'string') {
    const r = redactString(value);
    found.push(...r.found);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, found, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, found, depth + 1);
    return out;
  }
  return value;
}

function decide(payload) {
  const resp = payload.tool_response;
  if (resp === undefined || resp === null) return null;
  const found = [];
  const redacted = redactValue(resp, found);
  if (found.length === 0) return null;
  const kinds = [...new Set(found)];
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : 'a tool';
  const reason =
    `SECRET DETECTED in the output of ${tool}: ${kinds.join(', ')} ` +
    `(${found.length} match${found.length === 1 ? '' : 'es'}). The matches were replaced before ` +
    `this result reached you, but the credential has been exposed and must be rotated.\n` +
    `Do NOT echo, summarize, quote, write to a file, or commit any credential. Stop and tell ` +
    `the user which command or file produced it so the Owner can rotate it.\n${TAG}`;
  return {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: redacted,
    },
  };
}

let common;
try {
  common = require('./lib/common.cjs');
} catch (err) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `secret-redact could not load its helpers (${err.message}); this tool output was not scanned for secrets. ${TAG}`,
  }));
  process.exit(0);
}

function failClosed(why) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `secret-redact could not scan this tool output (${why}). Treat the output as unverified and ` +
      `do not repeat any credential it may contain. ${TAG}`,
  }));
  process.exit(0);
}

common.readStdin((err, raw) => {
  if (err) failClosed(`could not read hook input: ${err.message}`);
  let payload;
  try {
    payload = common.parsePayload(raw);
  } catch (e) {
    failClosed(`could not parse hook input: ${e.message}`);
  }
  let result;
  try {
    result = decide(payload);
  } catch (e) {
    failClosed(`scanner error: ${e.message}`);
  }
  if (result) process.stdout.write(JSON.stringify(result));
  process.exit(0);
});
