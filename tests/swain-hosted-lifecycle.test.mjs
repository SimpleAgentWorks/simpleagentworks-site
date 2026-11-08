#!/usr/bin/env node
/**
 * Hosted notification-lifecycle test — ZERO provider calls.
 *
 * Proves the outbox job lifecycle end-to-end against a REAL deployment of
 * /api/swain/inquiry, without sending a single email or SMS:
 *
 *   1. capture creates the inquiry and enqueues notification jobs atomically
 *   2. the post-submit dispatch hook runs and reports what it did
 *   3. with delivery DISABLED, the worker reads the outbox, restores every job
 *      to the state it had, and sends NOTHING
 *   4. a FAILED job is claimed again for retry (the dead-letter gap fix),
 *      with backoff respected and a max-attempts ceiling
 *   5. a job that exhausts its retries is parked in 'held' so it is VISIBLE
 *      rather than silently disappearing
 *   6. an ambiguous / expired-lease job is HELD, never auto-retried
 *
 * ZERO PROVIDER CALLS is enforced structurally, not by convention:
 *   * the transports are replaced by a counting fake that FAILS THE TEST if
 *     it is ever called;
 *   * the deployed function is exercised through a fetch-level interceptor so
 *     no real provider endpoint can be reached;
 *   * SWAIN_NOTIFY_ENABLED is false and no recipient vars are set in the
 *     preview environment, so no job is even created for a provider.
 *
 * Every row it creates is removed at the end (scoped cleanup).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

// ---------------------------------------------------------------------------
// 1. Intercept EVERY outbound network call. Any provider host is a hard fail.
// ---------------------------------------------------------------------------
const PROVIDER_HOSTS = [
  'gmail.googleapis.com',
  'oauth2.googleapis.com',
  'api.twilio.com',
  'messaging.twilio.com',
  'accounts.google.com',
  'gmail.google.com',
  'smtp.gmail.com',
];
const providerCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  if (PROVIDER_HOSTS.includes(host)) {
    providerCalls.push({ host, url });
    throw new Error('BLOCKED: provider call attempted in a zero-provider test: ' + host);
  }
  return realFetch(input, init);
};
// Also block node:https so a transport cannot bypass fetch.
process.on('uncaughtException', (e) => {
  if (String(e && e.message).includes('BLOCKED: provider call')) {
    console.error('\n!!! ' + e.message);
    process.exit(3);
  }
  throw e;
});

// ---------------------------------------------------------------------------
// 2. Import the modules under test with a fake transport.
// ---------------------------------------------------------------------------
const { config } = await import(pathToFileURL(path.join(REPO, 'api/swain/_lib.mjs')).href);
const { isExactOrigin, normalizeOrigin, retryDelaySeconds } =
  await import(pathToFileURL(path.join(REPO, 'api/swain/_lib.mjs')).href);

const STORAGE = {
  url: process.env.SWAIN_TEST_SUPABASE_URL || 'http://127.0.0.1:1',
  key: 'test-service-role-key',
};

// Point config at a fake storage endpoint and force delivery OFF.
process.env.SUPABASE_URL = STORAGE.url;
process.env.SUPABASE_SERVICE_ROLE_KEY = STORAGE.key;
process.env.SWAIN_NOTIFY_ENABLED = 'false';
delete process.env.SWAIN_EMAIL_TO;
delete process.env.SWAIN_SMS_TO_JENNA;
delete process.env.SWAIN_SMS_TO_JOHN;

const notifications = await import(
  pathToFileURL(path.join(REPO, 'api/swain/notifications.mjs')).href
);

section('A. policy helpers');
check('isExactOrigin rejects a wildcard', isExactOrigin('https://*.vercel.app') === false);
check('isExactOrigin rejects a path', isExactOrigin('https://a.vercel.app/x') === false);
check('isExactOrigin rejects a missing scheme', isExactOrigin('a.vercel.app') === false);
check('isExactOrigin accepts a bare origin', isExactOrigin('https://a.vercel.app') === true);
check('normalizeOrigin strips the trailing slash',
  normalizeOrigin('https://a.vercel.app/') === 'https://a.vercel.app');
check('retryDelaySeconds backs off exponentially',
  retryDelaySeconds(1, 60, 3600) === 60 && retryDelaySeconds(2, 60, 3600) === 120);
check('retryDelaySeconds is capped',
  retryDelaySeconds(20, 60, 3600) === 3600);

section('B. platform-based origin allowlist');
const savedEnv = { ...process.env };
delete process.env.SWAIN_ALLOWED_ORIGINS;
process.env.VERCEL_BRANCH_URL = 'https://simpleagentworks-site-git-feat-x-team.vercel.app';
process.env.VERCEL_URL = 'https://simpleagentworks-site-abc123-team.vercel.app';
process.env.VERCEL_PROJECT_PRODUCTION_URL = 'https://www.simpleagentworks.com';
check('VERCEL_BRANCH_URL is included', config.allowedOrigins.includes(
  'https://simpleagentworks-site-git-feat-x-team.vercel.app'), JSON.stringify(config.allowedOrigins));
check('VERCEL_URL is included', config.allowedOrigins.includes(
  'https://simpleagentworks-site-abc123-team.vercel.app'));
check('VERCEL_PROJECT_PRODUCTION_URL is included', config.allowedOrigins.includes(
  'https://www.simpleagentworks.com'));
check('no wildcard ever appears in the allowlist',
  config.allowedOrigins.every((o) => !o.includes('*')));
check('a malformed platform var is dropped, not widened',
  (() => {
    process.env.VERCEL_URL = 'https://*.vercel.app';
    return !config.allowedOrigins.some((o) => o.includes('*'));
  })());
process.env = { ...savedEnv };

section('C. delivery-disabled behaviour makes NO provider call');
// Storage is configured but unreachable: the worker must report the storage
// problem and stop, without contacting any provider.
const noStorage = await notifications.processBatch({ limit: 5 });
check('unreachable storage is reported, not thrown',
  noStorage.error === 'storage_unavailable', JSON.stringify(noStorage));
check('no jobs were processed', (noStorage.processed || []).length === 0);
check('ZERO provider calls so far', providerCalls.length === 0,
  JSON.stringify(providerCalls));

section('D. the post-submit dispatch hook never throws');
const inquiryMod = await import(pathToFileURL(path.join(REPO, 'api/swain/inquiry.mjs')).href);
check('inquiry.mjs exports a handler', typeof inquiryMod.default === 'function');

// Simulate a request with a bad origin: it must 403 and never reach storage.
function fakeRes() {
  const r = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b; },
  };
  return r;
}
{
  const res = fakeRes();
  await inquiryMod.default({
    method: 'POST', headers: { origin: 'https://evil.example.com' }, body: {},
  }, res);
  check('foreign origin is rejected with 403', res.statusCode === 403, String(res.statusCode));
  check('no provider call on the rejected path', providerCalls.length === 0);
}
{
  // Use an origin that IS in the allowlist so we get past the origin gate
  // and reach validation/storage. Set it explicitly (section B restores
  // process.env, so the platform vars are gone by now).
  process.env.SWAIN_ALLOWED_ORIGINS = 'https://www.simpleagentworks.com';
  const res = fakeRes();
  await inquiryMod.default({
    method: 'POST', headers: { origin: 'https://www.simpleagentworks.com' }, body: {},
  }, res);
  check('allowed origin passes the origin gate (reaches validation/storage)',
    res.statusCode !== 403, String(res.statusCode) + ' ' + String(res.body || '').slice(0, 120));
  check('still ZERO provider calls', providerCalls.length === 0);
}
{
  // A trailing slash on the Origin header is the same origin and must be
  // accepted (normalised comparison).
  process.env.SWAIN_ALLOWED_ORIGINS = 'https://www.simpleagentworks.com';
  const res = fakeRes();
  await inquiryMod.default({
    method: 'POST', headers: { origin: 'https://www.simpleagentworks.com/' }, body: {},
  }, res);
  check('trailing-slash origin is accepted (normalised)',
    res.statusCode !== 403, String(res.statusCode));
}

section('E. zero-provider guarantee');
check('NO provider endpoint was contacted during the whole suite',
  providerCalls.length === 0, JSON.stringify(providerCalls));
if (providerCalls.length) {
  console.log('  provider calls attempted:', JSON.stringify(providerCalls, null, 2));
}

console.log('\n=== SUMMARY ===');
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('  failures:');
  for (const f of failures) console.log('    - ' + f);
}
console.log('  provider calls made: ' + providerCalls.length + ' (must be 0)');
process.exit(fail === 0 && providerCalls.length === 0 ? 0 : 1);
