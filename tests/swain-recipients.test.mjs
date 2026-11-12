#!/usr/bin/env node
/**
 * Tests for multiple-recipient handling and the hosted-transport contract.
 *
 * Bug this covers: SWAIN_EMAIL_TO with two recipients produced ONE job whose
 * recipient field was the comma-joined string 'a@x,b@y' - so the provider got
 * an invalid address. Worse, the outbox has UNIQUE (inquiry_id, destination),
 * so two recipients sharing one destination would collide and only one would
 * be queued. Each recipient now gets its own job with its own destination.
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

const lib = await import(pathToFileURL(path.join(REPO, 'api/swain/_lib.mjs')).href);
const { config, buildJobs } = lib;

const inquiry = {
  submissionId: '11111111-2222-4333-8444-555555555555',
  name: 'Test Person', email: 'test@example.invalid',
  message: 'hello', source: 'swain-photography-preview',
};

section('A. ONE email recipient');
{
  process.env.SWAIN_EMAIL_TO = 'solo@example.invalid';
  const jobs = buildJobs(inquiry).filter((j) => j.channel === 'email');
  check('one job created', jobs.length === 1, String(jobs.length));
  check('recipient is the single address', jobs[0].recipient === 'solo@example.invalid',
    jobs[0].recipient);
  check('destination is jenna_email', jobs[0].destination === 'jenna_email',
    jobs[0].destination);
  check('no address contains a comma', !jobs.some((j) => j.recipient.includes(',')));
}

section('B. TWO email recipients (the live configuration)');
{
  process.env.SWAIN_EMAIL_TO = 'writetojennaswain@gmail.com,info@simpleagentworks.com';
  const jobs = buildJobs(inquiry).filter((j) => j.channel === 'email');
  check('two jobs created', jobs.length === 2, String(jobs.length));
  const recips = jobs.map((j) => j.recipient).sort();
  check('recipients are split correctly',
    JSON.stringify(recips) === JSON.stringify(
      ['info@simpleagentworks.com', 'writetojennaswain@gmail.com'].sort()),
    JSON.stringify(recips));
  check('no job recipient contains a comma', !jobs.some((j) => j.recipient.includes(',')));
  const dests = jobs.map((j) => j.destination);
  check('destinations are DISTINCT (unique inquiry_id+destination constraint)',
    new Set(dests).size === dests.length, JSON.stringify(dests));
  check('every recipient is a valid-looking address',
    jobs.every((j) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(j.recipient)),
    JSON.stringify(recips));
  check('all jobs share the same subject', new Set(jobs.map((j) => j.subject)).size === 1);
  check('all jobs share the same body', new Set(jobs.map((j) => j.body)).size === 1);
}

section('C. THREE recipients, whitespace, and empty entries');
{
  process.env.SWAIN_EMAIL_TO = ' a@x.invalid , b@y.invalid ,, c@z.invalid ';
  const jobs = buildJobs(inquiry).filter((j) => j.channel === 'email');
  check('three jobs (empty entries dropped)', jobs.length === 3, String(jobs.length));
  check('addresses trimmed',
    JSON.stringify(jobs.map((j) => j.recipient).sort()) ===
    JSON.stringify(['a@x.invalid', 'b@y.invalid', 'c@z.invalid']),
    JSON.stringify(jobs.map((j) => j.recipient)));
  check('destinations still distinct', new Set(jobs.map((j) => j.destination)).size === 3);
}

section('D. NO recipients configured -> no email jobs at all');
{
  process.env.SWAIN_EMAIL_TO = '';
  const jobs = buildJobs(inquiry).filter((j) => j.channel === 'email');
  check('zero email jobs', jobs.length === 0, String(jobs.length));
}

section('E. SMS stays off regardless');
{
  process.env.SWAIN_EMAIL_TO = 'a@x.invalid';
  delete process.env.SWAIN_SMS_FROM;
  delete process.env.SWAIN_SMS_TO_JENNA;
  delete process.env.SWAIN_SMS_TO_JOHN;
  const jobs = buildJobs(inquiry);
  check('no SMS jobs when no SMS vars are set',
    jobs.filter((j) => j.channel === 'sms').length === 0);
}

console.log('\n=== SUMMARY ===');
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('  failures:'); for (const f of failures) console.log('    - ' + f); }
process.exit(fail === 0 ? 0 : 1);
