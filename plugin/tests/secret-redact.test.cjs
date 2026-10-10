'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, rawFixture, runHook } = require('./helpers.cjs');

const HOOK = 'secret-redact.cjs';

// Credentials are assembled from fragments at run time so this file holds no
// string a secret scanner would report.
const j = (...parts) => parts.join('');
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (claims) => j('eyJ', b64url({ alg: 'HS256', typ: 'JWT' }).slice(3), '.', b64url(claims), '.', 'c2lnbmF0dXJlc2lnbmF0dXJl');

const SAMPLES = {
  supabasePat: j('sb', 'p_', '0123456789abcdef0123456789abcdef01234567'),
  supabaseSecret: j('sb_', 'secret_', 'AbCdEfGhIjKlMnOpQrStUv'),
  github: j('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'),
  githubFineGrained: j('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'),
  anthropic: j('sk-', 'ant-', 'api03-', 'abcdefghijklmnopqrstuvwxyz012345'),
  awsKeyId: j('AK', 'IA', 'IOSFODNN7EXAMPLE'),
  awsSecret: j('aws_secret_access_key = ', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'),
  stripe: j('sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc'),
  stripeWebhook: j('wh', 'sec_', 'abcdefghijklmnopqrstuvwxyz012345'),
  privateKey: j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ', 'PRIVATE KEY-----'),
  serviceRoleJwt: jwt({ iss: 'supabase', role: 'service_role', exp: 1983812996 }),
};

function bashOutput(stdout, stderr = '') {
  return runHook(HOOK, fixture('posttooluse-bash', { tool_response: { stdout, stderr } }));
}

function assertRedacted(r, secret, label) {
  assert.equal(r.status, 0);
  assert.ok(r.json, `expected a JSON decision, got: ${r.stdout}`);
  assert.equal(r.json.decision, 'block');
  assert.match(r.json.reason, /SECRET DETECTED/);
  assert.match(r.json.reason, /rotate/);
  assert.match(r.json.reason, new RegExp(label));
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(!r.stdout.includes(secret), 'the hook output must not repeat the secret');
}

test('secret-redact: no output when the result holds no secret', () => {
  const r = runHook(HOOK, fixture('posttooluse-bash'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const r2 = runHook(HOOK, fixture('posttooluse-write'));
  assert.equal(r2.stdout, '');
  const anon = jwt({ iss: 'supabase', role: 'anon', exp: 1983812996 });
  const r3 = bashOutput(`NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon}`);
  assert.equal(r3.stdout, '', 'an anon JWT is public and is not flagged');
});

test('secret-redact: detects and redacts each credential type', () => {
  const labels = {
    supabasePat: 'Supabase personal access token',
    supabaseSecret: 'Supabase secret key',
    github: 'GitHub token',
    githubFineGrained: 'GitHub fine-grained token',
    anthropic: 'Anthropic API key',
    awsKeyId: 'AWS access key ID',
    awsSecret: 'AWS secret access key',
    stripe: 'Stripe secret key',
    stripeWebhook: 'Stripe webhook secret',
    privateKey: 'private key',
    serviceRoleJwt: 'Supabase service_role JWT',
  };
  for (const [name, secret] of Object.entries(SAMPLES)) {
    const r = bashOutput(`config dump:\n${secret}\ndone`);
    assertRedacted(r, secret, labels[name]);
    const out = r.json.hookSpecificOutput.updatedToolOutput;
    assert.ok(!out.stdout.includes(secret), `${name} must be replaced in stdout`);
    assert.match(out.stdout, /\[REDACTED: /);
    assert.match(out.stdout, /^config dump:/);
  }
});

test('secret-redact: the replacement keeps the tool output shape', () => {
  const r = bashOutput(`token ${SAMPLES.github}`, `warn ${SAMPLES.stripe}`);
  const out = r.json.hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(Object.keys(out).sort(), ['interrupted', 'isImage', 'stderr', 'stdout']);
  assert.equal(out.interrupted, false);
  assert.equal(out.isImage, false);
  assert.ok(!out.stderr.includes(SAMPLES.stripe));

  const nested = runHook(HOOK, fixture('posttooluse-write', {
    tool_name: 'mcp__db__query',
    tool_response: { rows: [{ name: 'a', value: SAMPLES.supabaseSecret }], count: 1 },
  }));
  assertRedacted(nested, SAMPLES.supabaseSecret, 'Supabase secret key');
  const n = nested.json.hookSpecificOutput.updatedToolOutput;
  assert.equal(n.count, 1);
  assert.equal(n.rows.length, 1);
  assert.equal(n.rows[0].name, 'a');
  assert.match(n.rows[0].value, /\[REDACTED: /);
});

test('secret-redact: a string tool response is redacted as a string', () => {
  const r = runHook(HOOK, fixture('posttooluse-write', { tool_name: 'mcp__x__fetch', tool_response: `key: ${SAMPLES.anthropic}` }));
  assertRedacted(r, SAMPLES.anthropic, 'Anthropic API key');
  assert.equal(typeof r.json.hookSpecificOutput.updatedToolOutput, 'string');
});

test('secret-redact: fails closed on input it cannot parse', () => {
  for (const raw of [rawFixture('malformed.txt'), '', 'null', '[1,2]']) {
    const r = runHook(HOOK, raw);
    assert.equal(r.status, 0);
    assert.ok(r.json, `expected a JSON decision for ${JSON.stringify(raw)}`);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /could not scan/);
  }
});

// Critic v0.1.0: CR-12 (a private key without its END line) and CR-15 (the
// local Supabase stack's fixed demo keys).
test('secret-redact CR-12: a BEGIN PRIVATE KEY line counts without its END line', () => {
  const partial = j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj');
  const r = bashOutput(`$ head -3 key.pem\n${partial}`);
  assertRedacted(r, 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'private key');
  assert.ok(!r.json.hookSpecificOutput.updatedToolOutput.stdout.includes('BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj'));
  const rsa = j('-----BEGIN RSA ', 'PRIVATE KEY-----');
  assertRedacted(bashOutput(`${rsa}\n`), rsa, 'private key');
});

// The local stack's demo values from the Supabase CLI source
// (.recon/brief-03/supabase-cli-v2.120.0/), assembled here from fragments.
const DEMO_SECRET_KEY = j('sb_sec', 'ret_', 'N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz');
const DEMO_JWT_SECRET = j('super-sec', 'ret-jwt-to', 'ken-with-at-least-32-characters-long');
function demoJwt(role, iss = 'supabase-demo') {
  const crypto = require('crypto');
  const data = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ iss, role, exp: 1983812996 })}`;
  return `${data}.${crypto.createHmac('sha256', DEMO_JWT_SECRET).update(data).digest('base64url')}`;
}

test('secret-redact CR-15: the local Supabase demo keys are not flagged; anything else still is', () => {
  const status = [
    'API URL: http://127.0.0.1:54321',
    `Publishable key: ${j('sb_', 'publishable_', 'ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH')}`,
    `Secret key: ${DEMO_SECRET_KEY}`,
    `anon key: ${demoJwt('anon')}`,
    `service_role key: ${demoJwt('service_role')}`,
  ].join('\n');
  const r = bashOutput(status);
  assert.equal(r.stdout, '', `the demo keys of supabase status are public: ${r.stdout}`);

  const other = j('sb_sec', 'ret_', 'Q7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz');
  assertRedacted(bashOutput(`Secret key: ${other}`), other, 'Supabase secret key');
  const longer = `${DEMO_SECRET_KEY}x`;
  assertRedacted(bashOutput(`Secret key: ${longer}`), longer, 'Supabase secret key');
  const real = demoJwt('service_role', 'supabase');
  assertRedacted(bashOutput(`service_role key: ${real}`), real, 'Supabase service_role JWT');
  const both = bashOutput(`${DEMO_SECRET_KEY}\n${other}`);
  assert.match(both.json.reason, /\(1 match\)/);
  assert.ok(both.json.hookSpecificOutput.updatedToolOutput.stdout.includes(DEMO_SECRET_KEY), 'the demo key is left as is');
});
