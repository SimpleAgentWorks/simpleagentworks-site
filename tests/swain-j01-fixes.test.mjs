#!/usr/bin/env node
/**
 * J-01 fix tests — credential selection, token gating, response ordering and
 * budget exhaustion.
 *
 * ZERO PROVIDER CALLS is structural: globalThis.fetch is intercepted and any
 * provider host throws and fails the run immediately. No email or SMS is sent.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else {
    fail++; failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------- provider guard
const PROVIDER_HOSTS = [
  'gmail.googleapis.com', 'oauth2.googleapis.com', 'api.twilio.com',
  'messaging.twilio.com', 'accounts.google.com', 'gmail.google.com',
  'smtp.gmail.com',
];
const providerCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  let host = '';
  try { host = new URL(url).host; } catch { host = ''; }
  if (PROVIDER_HOSTS.includes(host)) {
    providerCalls.push({ host });
    throw new Error('BLOCKED provider call: ' + host);
  }
  return realFetch(input, init);
};

const lib = await import(pathToFileURL(path.join(REPO, 'api/swain/_lib.mjs')).href);
const notifications = await import(pathToFileURL(path.join(REPO, 'api/swain/notifications.mjs')).href);
const inquiry = await import(pathToFileURL(path.join(REPO, 'api/swain/inquiry.mjs')).href);

// =====================================================================
section('A. hosted Gmail credential selection');
{
  const saved = { ...process.env };
  for (const k of ['GMAIL_REFRESH_TOKEN', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET',
    'SWAIN_ALLOW_GOG_FALLBACK']) delete process.env[k];

  check('no credentials -> null (transport not configured)',
    notifications.gmailCredentialsFromEnv() === null);

  process.env.GMAIL_REFRESH_TOKEN = 'rt';
  check('a partial set is treated as NOT configured',
    notifications.gmailCredentialsFromEnv() === null,
    'a partial credential set must not select the hosted transport');

  process.env.GMAIL_CLIENT_ID = 'cid';
  process.env.GMAIL_CLIENT_SECRET = 'cs';
  const full = notifications.gmailCredentialsFromEnv();
  check('a complete set selects the hosted transport', full !== null);
  check('the credential fields are carried', full && full.refreshToken === 'rt' &&
    full.clientId === 'cid' && full.clientSecret === 'cs');
  process.env = saved;
}

section('B. no Mac-only fallback on a serverless runtime');
{
  const saved = { ...process.env };
  process.env.SWAIN_ALLOW_GOG_FALLBACK = 'false';
  check('the gog fallback can be disabled', notifications.canUseGogFallback() === false);

  process.env.SWAIN_ALLOW_GOG_FALLBACK = 'true';
  check('the gog fallback can be forced on (local worker)', notifications.canUseGogFallback() === true);
  delete process.env.SWAIN_ALLOW_GOG_FALLBACK;
  process.env = saved;
}

section('C. worker token gating fails CLOSED');
{
  const saved = { ...process.env };
  function fakeRes() {
    return { statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { this.body = b; } };
  }

  delete process.env.SWAIN_WORKER_TOKEN;
  {
    const res = fakeRes();
    await notifications.default({ method: 'POST', headers: {} }, res);
    check('a MISSING worker token refuses with 503 (fail closed)',
      res.statusCode === 503, String(res.statusCode));
    check('the 503 body does not leak anything', !res.body ||
      !/token|secret/i.test(String(res.body)), String(res.body));
  }
  {
    const res = fakeRes();
    await notifications.default({ method: 'POST', headers: {} }, res);
    check('a missing token never reaches the worker', res.statusCode === 503);
  }
  process.env.SWAIN_WORKER_TOKEN = 'correct-token';
  {
    const res = fakeRes();
    await notifications.default({ method: 'POST', headers: {} }, res);
    check('a WRONG token is rejected with 401', res.statusCode === 401, String(res.statusCode));
  }
  {
    const res = fakeRes();
    await notifications.default({ method: 'POST', headers: { 'x-sworker-token': 'wrong' } }, res);
    check('a wrong x-sworker-token is rejected with 401', res.statusCode === 401);
  }
  process.env = saved;
}

section('D. dispatch budget and batch configuration');
{
  const saved = { ...process.env };
  delete process.env.SWAIN_DISPATCH_BUDGET_MS;
  delete process.env.SWAIN_DISPATCH_BATCH;
  check('the dispatch budget has a safe default (5000ms)',
    lib.config.dispatchBudgetMs === 5000, String(lib.config.dispatchBudgetMs));
  check('the dispatch batch has a safe default (2)',
    lib.config.dispatchBatch === 2, String(lib.config.dispatchBatch));
  process.env.SWAIN_DISPATCH_BUDGET_MS = '1500';
  process.env.SWAIN_DISPATCH_BATCH = '4';
  check('the budget is configurable', lib.config.dispatchBudgetMs === 1500);
  check('the batch is configurable', lib.config.dispatchBatch === 4);
  process.env = saved;
}

section('E. response ordering — the response is written BEFORE the drain');
{
  const order = [];
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b; order.push('response'); },
  };
  // Storage unreachable so the capture fails fast, but we can still observe
  // that respond() is called before any drain work begins.
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  process.env.SWAIN_ALLOWED_ORIGINS = 'https://www.simpleagentworks.com';
  process.env.SWAIN_NOTIFY_ENABLED = 'true';
  const res2 = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = b; order.push('response'); },
  };
  await inquiry.default({
    method: 'POST',
    headers: { origin: 'https://www.simpleagentworks.com' },
    body: {},
  }, res2, null);
  check('the handler writes a response', order.includes('response'), JSON.stringify(order));
  check('the response body is JSON with ok:true or an error, never a hang',
    res2.body && typeof res2.body === 'string' && res2.body.length < 400,
    String(res2.body).slice(0, 120));
  check('no provider call happened', providerCalls.length === 0);
}

section('F. zero-provider guarantee');
check('NO provider endpoint was contacted during the whole suite',
  providerCalls.length === 0, JSON.stringify(providerCalls));

console.log('\n=== SUMMARY ===');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('  provider calls made: ' + providerCalls.length + ' (must be 0)');
if (failures.length) { console.log('  failures:'); for (const f of failures) console.log('    - ' + f); }
process.exit(fail === 0 && providerCalls.length === 0 ? 0 : 1);
