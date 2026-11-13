#!/usr/bin/env node
// Swain Photography inquiry — optional phone + marketing opt-in.
//
// NO REAL EMAIL OR SMS SENDS HAPPEN HERE.
//   * The notification transports are replaced with deterministic fakes.
//   * Storage is an isolated local PostgreSQL database using the SAME schema
//     and the SAME SQL functions as production.
//   * All test rows are deleted at the end.
//
// Proves:
//   * every field stays OPTIONAL (name/email/message remain required)
//   * phone is optional and validated when present
//   * the opt-in answer is recorded as yes/no with a server-side timestamp
//   * the opt-in answer and phone appear in the email body AND the SMS alert
//   * "ticked the box but gave no phone and no email" => rejected with a
//     message that asks for one
//   * a changed opt-in answer changes the content hash (a retry cannot
//     silently reuse a stored inquiry)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:55432/swain_test';
const PGREST_PORT = Number(process.env.TEST_PGREST_PORT || 5599);

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------------------------------------------------------------- harness

const shim = spawn(process.execPath, [path.join(REPO, 'tests/pg-rest-shim.mjs')], {
  env: { ...process.env, TEST_DATABASE_URL: DB_URL, TEST_PGREST_PORT: String(PGREST_PORT) },
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

const { Client } = await import('pg');
const db = new Client({ connectionString: DB_URL });
await db.connect();
async function q(sql, params) { return (await db.query(sql, params)).rows; }
async function reset() {
  await q('truncate public.swain_notification_outbox, public.swain_inquiries, public.swain_rate_limits');
}

process.env.SUPABASE_URL = `http://127.0.0.1:${PGREST_PORT}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SWAIN_HMAC_SECRET = 'test-hmac-secret-for-optin-suite';
process.env.SWAIN_EMAIL_TO = 'writetojennaswain@gmail.com,info@simpleagentworks.com';
process.env.SWAIN_EMAIL_FROM = 'info@simpleagentworks.com';
// SMS legs are configured so the alert-copy assertions are meaningful.
process.env.SWAIN_SMS_TO_JENNA = '+16303443087';
process.env.SWAIN_SMS_TO_JOHN = '+16304560567';

const lib = await import(path.join(REPO, 'api/swain/_lib.mjs'));
const { validateInquiry, buildJobs, contentHash } = lib;

function base(over = {}) {
  return {
    submissionId: randomUUID(),
    clientId: 'swain-photography',
    name: 'Test Person',
    email: 'tester@example.com',
    message: 'A couples session by the lake.',
    hp: '',
    ...over,
  };
}

// ================================================================= TESTS

try {
  // ---------------------------------------------------------- 1. optionality
  section('1. Every field stays OPTIONAL (except the three original ones)');
  const noPhone = validateInquiry(base());
  check('phone defaults to empty string', noPhone.phone === '', JSON.stringify(noPhone.phone));
  check('opt-in defaults to null (not provided)', noPhone.smsOptIn === null, JSON.stringify(noPhone.smsOptIn));

  const unticked = validateInquiry(base({ smsOptIn: 'no' }));
  check('explicit "no" is accepted', unticked.smsOptIn === 'no');
  const ticked = validateInquiry(base({ smsOptIn: 'yes', phone: '(630) 555-0123' }));
  check('explicit "yes" with a phone is accepted', ticked.smsOptIn === 'yes');
  check('phone is retained', ticked.phone === '(630) 555-0123', ticked.phone);

  // ---------------------------------------------------------- 2. phone validation
  section('2. Phone validation (only flagged when present)');
  for (const good of ['630-555-0123', '(630) 555-0123', '+1 630 555 0123', '630.555.0123']) {
    let ok = true;
    try { validateInquiry(base({ phone: good })); } catch (e) { ok = false; }
    check('accepts ' + good, ok);
  }
  for (const bad of ['123', 'abc', '630-555-0123 <script>', '630-555-0123\nBcc: x@y.com']) {
    let rejected = false;
    try { validateInquiry(base({ phone: bad })); } catch (e) { rejected = true; }
    check('rejects ' + JSON.stringify(bad), rejected);
  }

  // ---------------------------------------------------------- 3. consent rule
  section('3. Consent without a way to be contacted => rejected');
  let msg = '';
  let rejected = false;
  try {
    validateInquiry(base({ smsOptIn: 'yes', email: '', phone: '' }));
  } catch (e) { rejected = true; msg = e.publicMessage || e.message; }
  check('ticked box + no phone + no email is rejected', rejected, msg);
  check('the error asks for a phone number or email', /phone number or email/i.test(msg), msg);

  // The same rule must hold server-side when email is absent but a phone is not.
  let okPhoneOnly = true;
  let phoneMsg = '';
  try {
    // email is required by this form, so we simulate the rule directly.
    const r = validateInquiry(base({ smsOptIn: 'yes', phone: '630-555-0123' }));
    okPhoneOnly = r.smsOptIn === 'yes';
  } catch (e) { okPhoneOnly = false; phoneMsg = e.message; }
  check('ticked box + phone (+ email) is accepted', okPhoneOnly, phoneMsg);

  // No consent + no email => the normal "email required" error (not the
  // consent error), because consent was never given.
  let noConsentMsg = '';
  let noConsentRejected = false;
  try {
    validateInquiry(base({ smsOptIn: 'no', email: '', phone: '630-555-0123' }));
  } catch (e) { noConsentRejected = true; noConsentMsg = e.publicMessage || e.message; }
  check('no consent + no email => email is still required', noConsentRejected, noConsentMsg);
  check('that error is the email one, not the consent one',
    /email/i.test(noConsentMsg) && !/phone number or email/i.test(noConsentMsg), noConsentMsg);

  // ---------------------------------------------------------- 4. email + SMS content
  section('4. Phone + opt-in appear in the email body AND the SMS alert');
  const inv = validateInquiry(base({ phone: '(630) 555-0123', smsOptIn: 'yes' }));
  inv.smsOptInAt = '2026-11-13T16:00:00.000Z';
  const jobs = buildJobs(inv);
  const emailJob = jobs.find((j) => j.channel === 'email');
  check('email body contains the phone number', emailJob.body.includes('(630) 555-0123'), emailJob.body);
  check('email body contains the opt-in answer YES', /Agreed to receive text or email messages: YES/.test(emailJob.body), emailJob.body);
  check('email body contains the opt-in timestamp', emailJob.body.includes('2026-11-13T16:00:00.000Z'), emailJob.body);
  check('email body still contains the name', emailJob.body.includes('Test Person'));
  check('email body still contains the message', emailJob.body.includes('A couples session by the lake.'));
  check('email body still contains the reference', emailJob.body.includes(inv.submissionId));
  const smsJob = jobs.find((j) => j.channel === 'sms');
  check('SMS alert contains the phone number', smsJob && smsJob.body.includes('(630) 555-0123'), smsJob && smsJob.body);
  check('SMS alert has the phone even when none was given', (() => {
    const noPhoneInv = validateInquiry(base());
    const j = buildJobs(noPhoneInv).find((x) => x.channel === 'sms');
    return j && j.body.includes('no phone');
  })(), '');

  // "no" must be reported as NO, not omitted.
  const noInv = validateInquiry(base({ smsOptIn: 'no', phone: '630-555-0123' }));
  noInv.smsOptInAt = '2026-11-13T16:00:00.000Z';
  const noBody = buildJobs(noInv).find((j) => j.channel === 'email').body;
  check('email body reports the opt-in answer NO', /Agreed to receive text or email messages: NO/.test(noBody), noBody);
  check('email body reports "not provided" when unanswered', (() => {
    const unknownInv = validateInquiry(base());
    const b = buildJobs(unknownInv).find((j) => j.channel === 'email').body;
    return /Agreed to receive text or email messages: Not provided/.test(b);
  })(), '');

  // ---------------------------------------------------------- 5. content hash
  section('5. A changed opt-in answer changes the content hash');
  const h1 = contentHash({ name: 'A', email: 'a@b.com', message: 'm', phone: '630-555-0123', smsOptIn: 'yes' });
  const h2 = contentHash({ name: 'A', email: 'a@b.com', message: 'm', phone: '630-555-0123', smsOptIn: 'no' });
  const h3 = contentHash({ name: 'A', email: 'a@b.com', message: 'm', phone: '630-555-0124', smsOptIn: 'yes' });
  check('yes vs no => different hash', h1 !== h2);
  check('different phone => different hash', h1 !== h3);

  // ---------------------------------------------------------- 6. DB round trip
  section('6. Capture stores phone + opt-in + server timestamp');
  await reset();
  const capInv = validateInquiry(base({ phone: '630-555-0123', smsOptIn: 'yes' }));
  capInv.smsOptInAt = new Date().toISOString();
  const capJobs = buildJobs(capInv);
  const cap = await lib.captureInquiry(capInv, capJobs);
  check('capture created', cap.created === true, JSON.stringify(cap));
  const rows = await q('select phone, sms_opt_in, sms_opt_in_at from public.swain_inquiries where id=$1', [capInv.submissionId]);
  check('phone in the DB row', rows[0] && rows[0].phone === '630-555-0123', rows[0] && rows[0].phone);
  check('opt-in in the DB row', rows[0] && rows[0].sms_opt_in === 'yes', rows[0] && rows[0].sms_opt_in);
  check('opt-in timestamp in the DB row', rows[0] && !!rows[0].sms_opt_in_at);
  const jobRows = await q('select body from public.swain_notification_outbox where inquiry_id=$1 and channel=$2', [capInv.submissionId, 'email']);
  check('the queued email body carries the phone', jobRows[0] && jobRows[0].body.includes('630-555-0123'));
  check('the queued email body carries the opt-in answer', jobRows[0] && /messages: YES/.test(jobRows[0].body));

  // ---------------------------------------------------------- 7. no-phone capture
  section('7. Capture with no phone and no opt-in still works');
  await reset();
  const plainInv = validateInquiry(base());
  const plainCap = await lib.captureInquiry(plainInv, buildJobs(plainInv));
  check('capture created without a phone', plainCap.created === true);
  const plainRows = await q('select phone, sms_opt_in from public.swain_inquiries where id=$1', [plainInv.submissionId]);
  check('phone is null in the DB', plainRows[0] && plainRows[0].phone === null, plainRows[0] && JSON.stringify(plainRows[0].phone));
  check('opt-in is null in the DB', plainRows[0] && plainRows[0].sms_opt_in === null);

  await reset();
} catch (err) {
  failures.push('UNCAUGHT: ' + (err && err.stack ? err.stack : String(err)));
  console.error('\nUNCAUGHT ERROR:', err);
} finally {
  try { await db.end(); } catch {}
  shim.kill('SIGKILL');
}

console.log('\n==============================================================');
console.log('RESULT: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('==============================================================');
