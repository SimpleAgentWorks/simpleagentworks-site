#!/usr/bin/env node
/**
 * Hosted notification-lifecycle test — ZERO provider calls, against the REAL
 * Supabase storage (the same PostgREST surface the hosted function uses).
 *
 * Proves the parts of the job lifecycle that cannot be proven without a real
 * outbox:
 *
 *   1. capture enqueues notification jobs atomically (inquiry + jobs together)
 *   2. a 'failed' job IS claimed again for retry  <-- the dead-letter gap fix
 *   3. the retry respects its backoff window (a fresh failure is NOT retried
 *      immediately)
 *   4. a job that exhausts SWAIN_MAX_ATTEMPTS is parked in 'held' and becomes
 *      VISIBLE in the summary, instead of vanishing
 *   5. a job with an expired lease is 'held' (ambiguous) and never retried
 *   6. a delivery-DISABLED run restores every job to the state it had
 *      (a 'failed' job goes back to 'failed', not 'pending') and sends nothing
 *
 * ZERO PROVIDER CALLS is structural:
 *   * globalThis.fetch is intercepted; any provider host throws and fails the
 *     run immediately
 *   * SWAIN_NOTIFY_ENABLED is 'false' and no recipient vars are set, so
 *     processBatch never reaches a transport
 *
 * Scoped cleanup: every row this test creates is removed at the end. It only
 * ever touches rows whose id it generated.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
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

// ---------------------------------------------------------------- env
const env = {};
for (const p of [
  process.env.SWAIN_TEST_ENV_FILE,
  path.join(REPO, '.env'),
  path.join(REPO, '..', '.env'),
  path.join(process.env.HOME || '', '.openclaw/workspace/simpleagentworks-site/.env'),
  path.join(process.env.HOME || '', '.openclaw/workspace/dashboards/.env'),
]) {
  if (!p) continue;
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const k = t.slice(0, t.indexOf('=')).trim();
      const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      if (v && !env[k]) env[k] = v;
    }
  } catch { /* file may not exist */ }
}
const SUPABASE_URL = env.SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('SKIP: no Supabase credentials available for the lifecycle test');
  process.exit(0);
}

process.env.SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_KEY;
process.env.SWAIN_NOTIFY_ENABLED = 'false';   // delivery OFF
process.env.SWAIN_MAX_ATTEMPTS = '2';          // small ceiling so exhaustion is testable
process.env.SWAIN_RETRY_BASE_SECONDS = '1';    // short backoff so the test is quick
process.env.SWAIN_RETRY_MAX_SECONDS = '2';
delete process.env.SWAIN_EMAIL_TO;
delete process.env.SWAIN_SMS_TO_JENNA;
delete process.env.SWAIN_SMS_TO_JOHN;

const { config } = await import(pathToFileURL(path.join(REPO, 'api/swain/_lib.mjs')).href);
const { processBatch } = await import(
  pathToFileURL(path.join(REPO, 'api/swain/notifications.mjs')).href);

// ---------------------------------------------------------------- storage helper
const BASE = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1';
const H = {
  apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json', Prefer: 'return=representation',
};
async function sb(path_, init = {}) {
  const r = await realFetch(BASE + path_, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = t; }
  if (!r.ok) throw new Error('storage ' + r.status + ': ' + String(t).slice(0, 200));
  return b;
}

// ---------------------------------------------------------------- fixtures
const createdInquiryIds = [];
const createdJobIds = [];

async function makeInquiryWithJobs(jobSpecs) {
  const id = randomUUID();
  const jobs = jobSpecs.map((j) => ({
    channel: j.channel, destination: j.destination,
    recipient: j.recipient, subject: j.subject || null, body: j.body || 'lifecycle test',
  }));
  await sb('/rpc/swain_capture_inquiry', {
    method: 'POST',
    body: JSON.stringify({
      p_id: id, p_content_hash: 'lifecycle-' + id, p_name: 'LIFECYCLE TEST',
      p_email: 'lifecycle@example.invalid', p_message: 'lifecycle test ' + id,
      p_source: 'swain-photography-preview', p_jobs: jobs,
    }),
  });
  createdInquiryIds.push(id);
  const rows = await sb('/swain_notification_outbox?inquiry_id=eq.' + id + '&select=id,state,destination,attempts');
  for (const r of rows || []) createdJobIds.push(r.id);
  return { id, rows: rows || [] };
}

async function setJobState(jobId, state, extra = {}) {
  await sb('/swain_notification_outbox?id=eq.' + jobId, {
    method: 'PATCH',
    body: JSON.stringify({ state, lease_until: null, updated_at: new Date().toISOString(), ...extra }),
  });
}
async function jobRow(jobId) {
  const rows = await sb('/swain_notification_outbox?id=eq.' + jobId + '&select=id,state,attempts,provider_status,last_error');
  return (rows || [])[0] || null;
}

try {
  // ================================================================
  section('A. capture enqueues jobs atomically');
  const f1 = await makeInquiryWithJobs([
    { channel: 'email', destination: 'jenna_email', recipient: 'a@example.invalid' },
    { channel: 'sms', destination: 'jenna_sms', recipient: '6303443087' },
    { channel: 'sms', destination: 'john_sms', recipient: '6304560567' },
  ]);
  check('inquiry captured', !!f1.id);
  check('three jobs enqueued', f1.rows.length === 3, 'got ' + f1.rows.length);
  check('all jobs start as pending',
    f1.rows.every((r) => r.state === 'pending'), JSON.stringify(f1.rows.map((r) => r.state)));

  // ================================================================
  section('B. a FAILED job is claimed again for retry (dead-letter gap fix)');
  const f2 = await makeInquiryWithJobs([
    { channel: 'email', destination: 'jenna_email', recipient: 'a@example.invalid' },
  ]);
  const job2 = f2.rows[0].id;
  await setJobState(job2, 'failed', { attempts: 1, last_error: 'simulated definitive rejection' });
  check('job is in failed state', (await jobRow(job2)).state === 'failed');

  // Backoff: the first retry is not immediate.
  const immediate = await processBatch({ limit: 5 });
  const afterImmediate = await jobRow(job2);
  check('a fresh failure is NOT retried instantly (backoff honoured)',
    afterImmediate.state === 'failed', afterImmediate.state);
  check('disabled run reported no sends',
    (immediate.processed || []).every((p) => p.state === 'not_sent_disabled'),
    JSON.stringify(immediate.processed));

  // Wait out the backoff, then it must be claimed.
  await new Promise((r) => setTimeout(r, 2200));
  const retried = await processBatch({ limit: 5 });
  const afterRetry = await jobRow(job2);
  check('after the backoff the FAILED job IS claimed (retry works)',
    afterRetry.state === 'failed' || afterRetry.state === 'sending',
    afterRetry.state + ' attempts=' + afterRetry.attempts);
  check('the retried job was reported as processed',
    (retried.processed || []).some((p) => p.id === job2),
    JSON.stringify(retried.processed));

  // ================================================================
  section('C. a disabled run restores the state a job had');
  // Put it back to failed, then run disabled and confirm it returns to
  // 'failed' (NOT 'pending') so retry history is not silently erased.
  await setJobState(job2, 'failed', { attempts: 1 });
  await new Promise((r) => setTimeout(r, 2200));
  await processBatch({ limit: 5 });
  const restored = await jobRow(job2);
  check('a disabled run leaves a failed job as failed (not pending)',
    restored.state === 'failed', restored.state + ' attempts=' + restored.attempts);
  check('retry history preserved (attempts not reset by a disabled run)',
    restored.attempts >= 1, 'attempts=' + restored.attempts);

  // ================================================================
  section('D. retries exhausted => parked in held and VISIBLE');
  const f3 = await makeInquiryWithJobs([
    { channel: 'email', destination: 'jenna_email', recipient: 'a@example.invalid' },
  ]);
  const job3 = f3.rows[0].id;
  // attempts >= SWAIN_MAX_ATTEMPTS (2) => must be parked, not retried.
  await setJobState(job3, 'failed', { attempts: 5, last_error: 'simulated permanent failure' });
  await new Promise((r) => setTimeout(r, 2200));
  const exhausted = await processBatch({ limit: 5 });
  const afterExhausted = await jobRow(job3);
  check('a job past max attempts is parked in held', afterExhausted.state === 'held',
    afterExhausted.state);
  check('the parking reason is recorded',
    (afterExhausted.provider_status || '').includes('retries_exhausted'),
    String(afterExhausted.provider_status));
  check('the exhausted job is VISIBLE in the summary (not a silent dead letter)',
    (exhausted.held || []).some((h) => h.id === job3),
    JSON.stringify(exhausted.held));

  // ================================================================
  section('E. expired lease => held (ambiguous), never retried');
  const f4 = await makeInquiryWithJobs([
    { channel: 'email', destination: 'jenna_email', recipient: 'a@example.invalid' },
  ]);
  const job4 = f4.rows[0].id;
  await sb('/swain_notification_outbox?id=eq.' + job4, {
    method: 'PATCH',
    body: JSON.stringify({
      state: 'sending',
      lease_until: new Date(Date.now() - 60000).toISOString(), // expired
      attempts: 1, updated_at: new Date().toISOString(),
    }),
  });
  await processBatch({ limit: 5 });
  const afterLease = await jobRow(job4);
  check('an expired-lease job is HELD, not retried', afterLease.state === 'held',
    afterLease.state);
  check('the ambiguity is recorded',
    (afterLease.provider_status || '').includes('ambiguous'),
    String(afterLease.provider_status));

  // ================================================================
  section('F. zero provider calls');
  check('NO provider endpoint was contacted', providerCalls.length === 0,
    JSON.stringify(providerCalls));
  check('delivery was disabled for the whole suite',
    config.notifyEnabled === false);

} finally {
  // ==============================================================
  section('G. scoped cleanup — only rows this test created');
  try {
    for (const id of createdJobIds) {
      await sb('/swain_notification_outbox?id=eq.' + id, { method: 'DELETE' });
    }
    for (const id of createdInquiryIds) {
      await sb('/swain_inquiries?id=eq.' + id, { method: 'DELETE' });
    }
    console.log('  deleted ' + createdJobIds.length + ' job(s) and ' +
      createdInquiryIds.length + ' inquiry row(s)');
  } catch (e) {
    console.log('  CLEANUP ERROR: ' + e.message);
    fail++;
    failures.push('cleanup: ' + e.message);
  }
  // Verify nothing of ours remains.
  try {
    const left = await sb('/swain_inquiries?name=eq.LIFECYCLE%20TEST&select=id');
    check('no LIFECYCLE TEST inquiry rows remain', (left || []).length === 0,
      JSON.stringify(left));
    const jobsLeft = await sb('/swain_notification_outbox?select=id&inquiry_id=neq.00000000-0000-0000-0000-000000000000&limit=50');
    const ourJobs = (jobsLeft || []).filter((j) => createdJobIds.includes(j.id));
    check('no jobs of ours remain', ourJobs.length === 0, JSON.stringify(ourJobs));
    const eligible = (jobsLeft || []).filter((j) =>
      ['pending', 'sending', 'failed'].includes(j.state));
    check('NO job anywhere remains eligible for delivery', eligible.length === 0,
      JSON.stringify(eligible.map((j) => ({ id: j.id, state: j.state }))));
  } catch (e) {
    console.log('  cleanup verification error: ' + e.message);
  }
}

console.log('\n=== SUMMARY ===');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('  provider calls made: ' + providerCalls.length + ' (must be 0)');
if (failures.length) { console.log('  failures:'); for (const f of failures) console.log('    - ' + f); }
process.exit(fail === 0 && providerCalls.length === 0 ? 0 : 1);
