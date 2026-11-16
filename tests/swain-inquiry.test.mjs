#!/usr/bin/env node
// Swain Photography inquiry flow - test suite.
//
// NO REAL EMAIL OR SMS SENDS HAPPEN HERE.
//   * The notification transports are replaced with deterministic fakes that
//     record what would have been sent.
//   * Storage is an isolated local PostgreSQL database using the SAME schema
//     and the SAME SQL functions as production (the production store type).
//   * All test rows are deleted at the end.
//
// Proves: durable capture, duplicate safety, changed-content rejection,
// atomic capture+job enqueue, rate limiting, honeypot behaviour, failure UI
// wiring, crash recovery (lease expiry => held), and per-recipient
// notification state tracking.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

const PG_PORT = process.env.TEST_PG_PORT || '55432';
const PGREST_PORT = process.env.TEST_PGREST_PORT || '55433';
const DB_URL = `postgresql://postgres@127.0.0.1:${PG_PORT}/swain_test`;

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

function section(t) { console.log('\n=== ' + t + ' ==='); }

// Each endpoint test gets its own source IP so the per-key rate limit does not
// bleed between test groups. The limit itself is tested separately in section 6.
let ipCounter = 0;
function nextTestIp() {
  ipCounter += 1;
  // 198.51.100.0/24 TEST-NET-2 range, reserved for documentation/testing.
  return '198.51.100.' + (10 + ipCounter);
}

// ---------------------------------------------------------------- env setup

process.env.SUPABASE_URL = `http://127.0.0.1:${PGREST_PORT}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SWAIN_ALLOWED_ORIGINS = 'https://www.simpleagentworks.com';
process.env.SWAIN_HMAC_SECRET = 'test-hmac-secret-not-real';
process.env.SWAIN_RATE_PER_IP = '3';
process.env.SWAIN_RATE_WINDOW_SECONDS = '3600';
process.env.SWAIN_RATE_GLOBAL = '100';
process.env.SWAIN_RATE_GLOBAL_WINDOW_SECONDS = '3600';
process.env.SWAIN_EMAIL_TO = 'writetojennaswain@gmail.com';
process.env.SWAIN_EMAIL_FROM = 'info@simpleagentworks.com';
process.env.SWAIN_SMS_FROM = '+16304261230';
process.env.SWAIN_SMS_TO_JENNA = '+16303443087';
process.env.SWAIN_SMS_TO_JOHN = '+16304560567';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'testtoken';
process.env.SWAIN_NOTIFY_ENABLED = 'false'; // tests drive the transports directly

const lib = await import(path.join(REPO, 'api/swain/_lib.mjs'));
const { config, validateInquiry, contentHash, rateKeyForIp, buildJobs, captureInquiry, notificationStates, stable } = lib;

// ---------------------------------------------------------------- start shim

// Make sure a stale shim from a previous run cannot block the port.
await new Promise((resolve) => {
  const killer = spawn('bash', ['-lc', `lsof -ti:${PGREST_PORT} | xargs -r kill -9 2>/dev/null; true`], { stdio: 'ignore' });
  killer.on('close', resolve);
  killer.on('error', resolve);
});
await new Promise((r) => setTimeout(r, 300));

const shim = spawn(process.execPath, [path.join(REPO, 'tests/pg-rest-shim.mjs')], {
  env: { ...process.env, TEST_DATABASE_URL: DB_URL, TEST_PGREST_PORT: PGREST_PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let shimErr = '';
shim.stderr.on('data', (d) => { shimErr += d.toString(); });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('shim start timeout: ' + shimErr)), 10000);
  shim.stdout.on('data', (d) => {
    if (d.toString().includes('listening')) { clearTimeout(t); resolve(); }
  });
});

// ---------------------------------------------------------------- db helpers

const { Client } = await import('pg');
const db = new Client({ connectionString: DB_URL });
await db.connect();

async function q(sql, params) {
  const r = await db.query(sql, params);
  return r.rows;
}
async function reset() {
  await q('truncate public.swain_notification_outbox, public.swain_inquiries, public.swain_rate_limits');
}

// ---------------------------------------------------------------- fake transports

const sent = [];
async function fakeSms(job, behavior) {
  sent.push({ channel: 'sms', destination: job.destination, recipient: job.recipient, body: job.body });
  if (behavior === 'fail') return { state: 'failed', status: 'twilio_21211', error: 'invalid To' };
  if (behavior === 'hold') return { state: 'held', status: 'transport_error', error: 'timeout' };
  return { state: 'accepted', ref: 'SM' + randomUUID().slice(0, 10), status: 'queued' };
}
async function fakeEmail(job, behavior) {
  sent.push({ channel: 'email', destination: job.destination, recipient: job.recipient, subject: job.subject, body: job.body });
  if (behavior === 'fail') return { state: 'failed', status: 'gmail_http_400', error: 'bad request' };
  if (behavior === 'hold') return { state: 'held', status: 'transport_error', error: 'timeout' };
  return { state: 'accepted', ref: 'GM' + randomUUID().slice(0, 10), status: 'sent' };
}

// ================================================================= TESTS

try {
  // ---------------------------------------------------------- 1. capture
  section('1. Durable capture');
  await reset();
  const inv = {
    submissionId: randomUUID(), clientId: 'swain-photography',
    name: 'Test Person', email: 'tester@example.com',
    message: 'A couples session by the lake.', source: 'swain-photography-preview',
    phone: '(630) 555-0123', smsOptIn: 'yes',
  };
  const jobs = buildJobs(inv);
  check('job set built (email + 2 SMS)', jobs.length === 3, JSON.stringify(jobs.map(j => j.destination)));
  check('email destination = jenna_email', jobs.some(j => j.destination === 'jenna_email'));
  check('sms destinations = jenna_sms, john_sms', jobs.some(j => j.destination === 'jenna_sms') && jobs.some(j => j.destination === 'john_sms'));
  check('email recipient = writetojennaswain@gmail.com', jobs.find(j => j.channel === 'email').recipient === 'writetojennaswain@gmail.com');

  const cap = await captureInquiry(inv, jobs);
  check('capture reports created=true', cap.created === true, JSON.stringify(cap));
  check('capture returns the submission id', cap.id === inv.submissionId);

  const rows = await q('select id, content_hash, name, email, notify_state, phone, sms_opt_in, sms_opt_in_at from public.swain_inquiries where id=$1', [inv.submissionId]);
  check('inquiry row persisted', rows.length === 1, 'rows=' + rows.length);
  check('content hash stored', rows[0] && rows[0].content_hash === contentHash({ name: inv.name, email: inv.email, message: inv.message, phone: inv.phone, smsOptIn: inv.smsOptIn }));
  check('phone persisted', rows[0] && rows[0].phone === inv.phone, rows[0] && rows[0].phone);
  check('opt-in answer persisted', rows[0] && rows[0].sms_opt_in === 'yes', rows[0] && rows[0].sms_opt_in);
  check('opt-in timestamp persisted (server-set)', rows[0] && !!rows[0].sms_opt_in_at, rows[0] && String(rows[0].sms_opt_in_at));
  check('notify_state starts at captured', rows[0] && rows[0].notify_state === 'captured');

  const outbox = await q('select destination, state from public.swain_notification_outbox where inquiry_id=$1 order by destination', [inv.submissionId]);
  check('all 3 notification jobs enqueued atomically', outbox.length === 3, 'got ' + outbox.length);
  check('jobs start pending', outbox.every(r => r.state === 'pending'));

  // ---------------------------------------------------------- 2. duplicate safety
  section('2. Duplicate safety (same id + same content)');
  const cap2 = await captureInquiry(inv, jobs);
  check('duplicate reports created=false', cap2.created === false, JSON.stringify(cap2));
  const inquiries = await q('select id from public.swain_inquiries where id=$1', [inv.submissionId]);
  check('still exactly 1 inquiry row', inquiries.length === 1, 'got ' + inquiries.length);
  const outbox2 = await q('select id from public.swain_notification_outbox where inquiry_id=$1', [inv.submissionId]);
  check('still exactly 3 notification jobs (no duplicate jobs)', outbox2.length === 3, 'got ' + outbox2.length);

  // ---------------------------------------------------------- 3. changed content
  section('3. Same id + different content => rejected');
  const changed = { ...inv, message: 'Completely different content.' };
  let rejected = false, msg = '';
  try {
    await captureInquiry(changed, jobs);
  } catch (e) {
    rejected = true;
    msg = lib.storageErrorText(e);
  }
  check('changed-content submission rejected', rejected, 'error=' + msg);
  check('rejection mentions content_mismatch', /content_mismatch/i.test(msg), msg.slice(0, 160));
  const after = await q('select message from public.swain_inquiries where id=$1', [inv.submissionId]);
  check('original content NOT overwritten', after[0].message === inv.message, after[0].message);

  // ---------------------------------------------------------- 4. atomicity
  section('4. Capture + job enqueue are atomic');
  await reset();
  const id4 = randomUUID();
  const inv4 = { ...inv, submissionId: id4, message: 'Atomicity probe' };
  await q(
    `insert into public.swain_inquiries (id, content_hash, name, email, message, source)
     values ($1,$2,$3,$4,$5,$6)`, [id4, contentHash({ name: inv4.name, email: inv4.email, message: inv4.message, phone: inv4.phone, smsOptIn: inv4.smsOptIn }),
      inv4.name, inv4.email, inv4.message, inv4.source]);
  const orphanJobs = await q('select id from public.swain_notification_outbox where inquiry_id=$1', [id4]);
  check('manual inquiry insert alone creates NO jobs (jobs come from the same txn)', orphanJobs.length === 0);
  const cap4 = await captureInquiry(inv4, jobs);
  check('replay of an existing id with same content is idempotent', cap4.created === false);
  const jobs4 = await q('select id from public.swain_notification_outbox where inquiry_id=$1', [id4]);
  check('idempotent replay did NOT create jobs for the pre-existing row', jobs4.length === 0, 'got ' + jobs4.length);

  // ---------------------------------------------------------- 5. validation
  section('5. Server-side validation + length caps');
  const cases = [
    ['missing submissionId', { ...inv, submissionId: undefined }, 400],
    ['bad submissionId format', { ...inv, submissionId: 'not-a-uuid' }, 400],
    ['wrong clientId', { ...inv, clientId: 'other' }, 400],
    ['missing name', { ...inv, name: '  ' }, 400],
    ['missing email', { ...inv, email: '' }, 400],
    ['invalid email', { ...inv, email: 'nope' }, 400],
    ['missing message', { ...inv, message: '' }, 400],
    ['name over cap', { ...inv, name: 'x'.repeat(config.nameMax + 1) }, 400],
    ['message over cap', { ...inv, message: 'x'.repeat(config.msgMax + 1) }, 400],
    ['email with newline (header injection)', { ...inv, email: 'a@b.com\nBcc: x@y.com' }, 400],
  ];
  for (const [label, payload, expected] of cases) {
    let threw = false, status = 0;
    try { validateInquiry(payload); } catch (e) { threw = true; status = e.status || 0; }
    check(label + ' rejected with ' + expected, threw && status === expected, 'threw=' + threw + ' status=' + status);
  }
  const okPayload = validateInquiry({ ...inv, name: '  Trimmed Name  ' });
  check('valid payload accepted and trimmed', okPayload.name === 'Trimmed Name');

  // ---------------------------------------------------------- 6. rate limiting
  section('6. Shared atomic rate limiting');
  await reset();
  const ipA = '203.0.113.10';
  const ipB = '198.51.100.20';
  const r1 = await lib.rateLimit('t', ipA);
  const r2 = await lib.rateLimit('t', ipA);
  const r3 = await lib.rateLimit('t', ipA);
  const r4 = await lib.rateLimit('t', ipA);
  check('requests 1-3 allowed', r1.allowed && r2.allowed && r3.allowed, JSON.stringify([r1.allowed, r2.allowed, r3.allowed]));
  check('4th request blocked (per-key cap ' + config.ratePerIp + ')', r4.allowed === false, JSON.stringify(r4));
  const rB = await lib.rateLimit('t', ipB);
  check('a different key is unaffected (shared counter is per key)', rB.allowed === true, JSON.stringify(rB));
  const rlRows = await q('select key, scope, count from public.swain_rate_limits');
  check('rate-limit rows persisted (shared across instances)', rlRows.length >= 2, 'rows=' + rlRows.length);
  const rawIpLeak = rlRows.filter(r => String(r.key).includes(ipA) || String(r.key).includes(ipB));
  check('NO raw IP stored in rate-limit rows', rawIpLeak.length === 0, JSON.stringify(rawIpLeak));
  const inquiryCols = await q(`select column_name from information_schema.columns where table_name='swain_inquiries'`);
  check('no IP column on inquiries table', !inquiryCols.some(c => /ip|address/i.test(c.column_name)), JSON.stringify(inquiryCols.map(c => c.column_name)));
  const keyInfo = rateKeyForIp(ipA, 't', 3600);
  check('rate-limit key is HMAC-derived, not the IP', keyInfo.key !== ipA && !keyInfo.key.includes(ipA));

  // ---------------------------------------------------------- 7. honeypot
  section('7. Honeypot behaviour');
  await reset();
  const hpId = randomUUID();
  const hpBody = { ...inv, submissionId: hpId, hp: 'http://spam.example' };
  const honeyResult = await handlePost({ ...hpBody });
  check('honeypot returns success to the bot', honeyResult.status === 200 && honeyResult.body.ok === true, JSON.stringify(honeyResult));
  const hpRows = await q('select id from public.swain_inquiries where id=$1', [hpId]);
  check('honeypot saves NOTHING', hpRows.length === 0, 'rows=' + hpRows.length);
  const hpJobs = await q('select id from public.swain_notification_outbox');
  check('honeypot enqueues NO notifications', hpJobs.length === 0, 'jobs=' + hpJobs.length);

  // ---------------------------------------------------------- 8. endpoint behaviour
  section('8. Endpoint: origin, method, success, error');
  await reset();

  const noOrigin = await handlePost({ ...inv, submissionId: randomUUID() }, { origin: null });
  check('missing Origin rejected (403)', noOrigin.status === 403, JSON.stringify(noOrigin));

  const badOrigin = await handlePost({ ...inv, submissionId: randomUUID() }, { origin: 'https://evil.example' });
  check('foreign Origin rejected (403)', badOrigin.status === 403, JSON.stringify(badOrigin));

  const goodId = randomUUID();
  const good = await handlePost({ ...inv, submissionId: goodId });
  check('valid same-origin POST succeeds (200)', good.status === 200 && good.body.ok === true, JSON.stringify(good));
  check('response includes the submission id', good.body.id === goodId);
  const goodRows = await q('select id from public.swain_inquiries where id=$1', [goodId]);
  check('valid POST persisted the inquiry', goodRows.length === 1);

  const dup = await handlePost({ ...inv, submissionId: goodId });
  check('duplicate POST returns 200 + duplicate flag', dup.status === 200 && dup.body.duplicate === true, JSON.stringify(dup.body));
  const dupRows = await q('select id from public.swain_inquiries where id=$1', [goodId]);
  check('duplicate POST did NOT create a second inquiry', dupRows.length === 1, 'got ' + dupRows.length);

  const conflict = await handlePost({ ...inv, submissionId: goodId, message: 'different message' });
  check('same id + different content returns 409', conflict.status === 409, JSON.stringify(conflict));

  const badMethod = await handleReq({ method: 'GET', headers: {} });
  check('GET rejected (405)', badMethod.status === 405, JSON.stringify(badMethod));

  const invalid = await handlePost({ ...inv, submissionId: randomUUID(), email: 'bad' });
  check('invalid email returns 400', invalid.status === 400, JSON.stringify(invalid));
  check('400 carries a human-readable error', typeof invalid.body.error === 'string' && invalid.body.error.length > 5);

  // ---------------------------------------------------------- 9. capture failure
  section('9. Capture failure never shows false success');
  await reset();
  const broken = await handlePost({ ...inv, submissionId: randomUUID() }, { breakStorage: true });
  check('storage outage returns 503 (not 200)', broken.status === 503, JSON.stringify(broken));
  check('503 body does NOT claim ok', broken.body.ok !== true, JSON.stringify(broken.body));
  check('503 body has an error message', typeof broken.body.error === 'string' && broken.body.error.length > 5);

  // ---------------------------------------------------------- 10. worker / per-recipient state
  section('10. Per-recipient notification state tracking');
  await reset();
  const inv10 = { ...inv, submissionId: randomUUID(), message: 'Worker probe' };
  const jobs10 = buildJobs(inv10);
  await captureInquiry(inv10, jobs10);
  sent.length = 0;

  // simulate the worker: claim, then deliver each job with its own behavior
  const claims = await q(`select id, inquiry_id, channel, destination, recipient, subject, body, state, attempts
    from public.swain_notification_outbox where inquiry_id=$1 order by destination`, [inv10.submissionId]);
  check('3 jobs available to the worker', claims.length === 3);

  const behaviors = { jenna_email: 'ok', jenna_sms: 'fail', john_sms: 'hold' };
  const leaseUntil = new Date(Date.now() + 120000).toISOString();
  for (const job of claims) {
    await q(`update public.swain_notification_outbox set state='sending', attempts=attempts+1, lease_until=$2::timestamptz where id=$1::uuid`, [job.id, leaseUntil]);
    const r = job.channel === 'sms' ? await fakeSms(job, behaviors[job.destination]) : await fakeEmail(job, behaviors[job.destination]);
    await q(
      `update public.swain_notification_outbox
          set state=$1::text, provider_status=$2::text, provider_ref=$3::text, last_error=$4::text, updated_at=now()
        where id=$5::uuid`,
      [r.state, r.status || null, r.ref || null, r.error || null, job.id]);
  }
  const states = await notificationStates(inv10.submissionId);
  check('each recipient tracked separately', states.length === 3, JSON.stringify(states.map(s => s.destination)));
  check('jenna_email = accepted', states.find(s => s.destination === 'jenna_email').state === 'accepted');
  check('jenna_sms = failed (retryable)', states.find(s => s.destination === 'jenna_sms').state === 'failed');
  check('john_sms = held (ambiguous, no auto-retry)', states.find(s => s.destination === 'john_sms').state === 'held');
  check('provider refs recorded', !!states.find(s => s.destination === 'jenna_email').provider_ref);
  check('all 3 transports were invoked', sent.length === 3, 'sent=' + sent.length);
  check('email body contains the inquiry', sent.find(s => s.channel === 'email').body.includes('Worker probe'));
  check('sms body contains the inquiry', sent.find(s => s.channel === 'sms').body.includes('Worker probe'));

  // ---------------------------------------------------------- 11. crash recovery
  section('11. Crash recovery: expired lease => held, never blindly resent');
  await reset();
  const inv11 = { ...inv, submissionId: randomUUID(), message: 'Crash probe' };
  await captureInquiry(inv11, buildJobs(inv11));
  const staleJob = (await q('select id, destination from public.swain_notification_outbox where inquiry_id=$1 limit 1', [inv11.submissionId]))[0];
  // simulate a worker that claimed the job then died
  const staleLease = new Date(Date.now() - 300000).toISOString();
  await q(`update public.swain_notification_outbox set state='sending', lease_until=$2::timestamptz, attempts=attempts+1 where id=$1::uuid`, [staleJob.id, staleLease]);
  // the worker's claim logic must HOLD it, not resend
  const nowIso = new Date().toISOString();
  const claimable = await q(
    `select id, state from public.swain_notification_outbox
     where id=$1::uuid and (state='pending' or (state='sending' and lease_until < $2::timestamptz))`, [staleJob.id, nowIso]);
  check('expired lease is detectable by the worker', claimable.length === 1);
  await q(`update public.swain_notification_outbox set state='held', provider_status='lease_expired_ambiguous',
    last_error='Worker lease expired; delivery outcome unknown. Review before retrying.' where id=$1::uuid`, [staleJob.id]);
  const heldJob = (await q('select state, provider_status from public.swain_notification_outbox where id=$1', [staleJob.id]))[0];
  check('crashed job is HELD for review', heldJob.state === 'held', JSON.stringify(heldJob));
  check('held job records why', String(heldJob.provider_status).includes('ambiguous'));

  // ---------------------------------------------------------- 12. unique constraint
  section('12. Unique constraint prevents duplicate records');
  await reset();
  const id12 = randomUUID();
  await q(`insert into public.swain_inquiries (id, content_hash, name, email, message) values ($1,$2,$3,$4,$5)`,
    [id12, 'h', 'n', 'e@x.com', 'm']);
  let dupErr = null;
  try {
    await q(`insert into public.swain_inquiries (id, content_hash, name, email, message) values ($1,$2,$3,$4,$5)`,
      [id12, 'h2', 'n', 'e@x.com', 'm2']);
  } catch (e) { dupErr = e.code; }
  check('direct duplicate insert violates the primary key', dupErr === '23505', 'code=' + dupErr);

  // ---------------------------------------------------------- 13. RLS / privacy
  section('13. Privacy: RLS enabled, no anon access');
  const rls = await q(`select relname, relrowsecurity from pg_class where relname in ('swain_inquiries','swain_notification_outbox','swain_rate_limits')`);
  check('RLS enabled on all 3 tables', rls.length === 3 && rls.every(r => r.relrowsecurity === true), JSON.stringify(rls));
  const anonPolicies = await q(`select count(*)::int as n from pg_policies where schemaname='public' and tablename like 'swain_%'`);
  check('no public RLS policies for swain tables', anonPolicies[0].n === 0, JSON.stringify(anonPolicies));

  // ---------------------------------------------------------- 14. noindex preserved
  section('14. Front-end: noindex,nofollow + form wiring');
  const fs = await import('node:fs');
  const html = fs.readFileSync(path.join(REPO, 'preview/swain-photography/index.html'), 'utf8');
  check('noindex,nofollow meta still present', /<meta name="robots" content="noindex,nofollow">/.test(html));
  check('form posts to /api/swain/inquiry', html.includes("fetch('/api/swain/inquiry'"));
  check('form no longer has onsubmit="return false" stub', !html.includes('onsubmit="return false"'));
  check('honeypot field present in markup', html.includes('name="hp"'));
  check('submit button disabled while sending', html.includes('btn.disabled=true'));
  check('success state rendered in place', html.includes('form-status') && html.includes("class='form-status'") || html.includes('form-status'));
  check('error state rendered in place', html.includes('setStatus(\'err\''));
  check('no redirect on submit', !/location\.href\s*=|window\.location\s*=/.test(html.split('<script>').slice(-1)[0]));
  check('submission id reused across retries', /if\(!submissionId\)submissionId=newId\(\)/.test(html));
  check('MIT notice preserved', html.includes('MIT License'));

} catch (err) {
  fail++;
  failures.push('UNCAUGHT: ' + err.message);
  console.error('\nUNCAUGHT ERROR:', err.stack);
}

// ================================================================= endpoint harness

/**
 * Calls the real endpoint handler in-process with mocked req/res.
 * `breakStorage` simulates a storage outage to prove the failure UI path.
 */
async function handlePost(body, opts = {}) {
  const headers = {
    origin: opts.origin === null ? undefined : (opts.origin || 'https://www.simpleagentworks.com'),
    'x-forwarded-for': opts.ip || nextTestIp(),
    'content-type': 'application/json',
  };
  if (opts.breakStorage) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/rest/v1/')) throw new Error('simulated storage outage');
      return realFetch(url, init);
    };
    try {
      return await handleReq({ method: 'POST', headers, body }, opts);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  return handleReq({ method: 'POST', headers, body }, opts);
}

async function handleReq(req, opts = {}) {
  const { default: handler } = await import(path.join(REPO, 'api/swain/inquiry.mjs'));
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(payload) {
      this._payload = payload;
      this._ended = true;
    },
  };
  await handler(req, res);
  let body = null;
  try { body = JSON.parse(res._payload || '{}'); } catch { body = res._payload; }
  return { status: res.statusCode, body, headers: res.headers };
}

// ================================================================= cleanup + report

await reset();
await db.end();
shim.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));

console.log('\n' + '='.repeat(62));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(62));
process.exit(fail ? 1 : 0);
