#!/usr/bin/env node
// CI check "Client bundle has no privileged key" (STANDARD 4.2), a backstop.
// The rule is held by the Owner's check, at adoption and at each phase gate,
// that the privileged key isn't set in the app's hosting environment (4.2 is
// [checked]). CI builds without secrets, so this check can only see a key that
// was written into the repository, or a browser-exposed variable named for one.
// Runs after the build and fails when:
//   1. the client build output (CLIENT_BUNDLE_DIR, default .next/static) holds a
//      Supabase secret key (sb_secret_ followed by a key), a JWT whose role is
//      service_role or supabase_admin, or the text service_role / SERVICE_ROLE
//   2. a file tracked by git names a browser-exposed variable (NEXT_PUBLIC_*, or
//      the prefixes in PUBLIC_ENV_PREFIXES, comma-separated) whose name contains
//      SERVICE_ROLE, SB_SECRET, or SECRET
//
// The bare prefix "sb_secret_" is not enough on its own: @supabase/supabase-js
// carries it in its browser code to recognize key formats
// (engineering-standard .recon/brief-03/supabase-js-bundle-strings.txt).
// A project with no client bundle sets CLIENT_BUNDLE_DIR=none.
//
// Usage: node scripts/check-client-bundle.mjs
// Part of the engineering standard; a protected path. No dependencies.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SELF = 'scripts/check-client-bundle.mjs';
const bundleDir = process.env.CLIENT_BUNDLE_DIR || '.next/static';
const prefixes = (process.env.PUBLIC_ENV_PREFIXES || 'NEXT_PUBLIC_').split(',').map((p) => p.trim()).filter(Boolean);

const SECRET_KEY = /\bsb_secret_[A-Za-z0-9_-]{16,}/;
const ROLE_TEXT = /service_role|SERVICE_ROLE/;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PRIVILEGED_ROLES = new Set(['service_role', 'supabase_admin']);
const BAD_NAME = /SERVICE_ROLE|SB_SECRET|SECRET/i;
const MAX_BYTES = 32 * 1024 * 1024;

const findings = [];

function privilegedJwt(text) {
  for (const token of text.match(JWT) || []) {
    try {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      if (claims && PRIVILEGED_ROLES.has(claims.role)) return claims.role;
    } catch {
      // not a JWT after all
    }
  }
  return null;
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else if (entry.isFile()) yield p;
  }
}

if (bundleDir !== 'none') {
  if (!existsSync(bundleDir) || !statSync(bundleDir).isDirectory()) {
    console.error(`No client bundle at ${bundleDir}. Build first, set CLIENT_BUNDLE_DIR to the client output directory, or set it to "none" for a project with no client.`);
    process.exit(2);
  }
  for (const file of files(bundleDir)) {
    if (statSync(file).size > MAX_BYTES) continue;
    const text = readFileSync(file, 'latin1');
    if (SECRET_KEY.test(text)) findings.push(`${file}: a Supabase secret key (sb_secret_...)`);
    const role = privilegedJwt(text);
    if (role) findings.push(`${file}: a JWT with role ${role}`);
    const m = ROLE_TEXT.exec(text);
    if (m) findings.push(`${file}: the text "${m[0]}"`);
  }
}

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
const names = new RegExp(`\\b(?:${prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[A-Za-z0-9_]*`, 'g');
for (const file of tracked) {
  if (relative('.', file) === SELF) continue;
  let text;
  try {
    if (statSync(file).size > MAX_BYTES) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree, or a submodule
  }
  if (text.includes('\0')) continue; // binary
  for (const name of new Set(text.match(names) || [])) {
    if (BAD_NAME.test(name)) findings.push(`${file}: browser-exposed variable ${name}`);
  }
}

if (findings.length) {
  console.log('A privileged key, or a browser-exposed variable named for one, would reach the client (STANDARD 4.2):');
  for (const f of findings) console.log(`- ${f}`);
  console.log('Use the privileged key only in server-side admin scripts; the app queries as the signed-in user.');
  process.exit(1);
}
console.log(`Client bundle check passed: ${bundleDir === 'none' ? 'no client bundle' : bundleDir}, ${tracked.length} tracked files.`);
