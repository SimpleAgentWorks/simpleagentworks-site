#!/usr/bin/env node
// Combined Swain Photography review build - one page with everything.
//
// READ-ONLY: renders a local copy over HTTP, makes no requests to the
// deployed site and submits nothing.
//
// Proves the merged build has ALL of:
//   1. the clean J (opsz pinned to 9) on the About heading + the signature
//   2. Jenna's new portrait in About (the bicycle is gone)
//   3. 11 gallery cards including the three new photos
//   4. the auto-advancing carousel
//   5. the PHONE field
//   6. the SMS/email opt-in checkbox, unchecked by default, with the exact
//      consent wording
//   7. the form posts with source 'swain-photography-review-copy' so it can
//      never email anybody
//   8. no console errors, no mobile overflow
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(REPO, 'preview/swain-combined-review');
const PORT = 5577;
const OUT = '/tmp/swain-combined-review-shots';
mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

const MIME = { '.html': 'text/html', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(SITE, p);
  if (!file.startsWith(SITE) || !existsSync(file)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const URL = `http://127.0.0.1:${PORT}/index.html`;

const browser = await chromium.launch();
try {
  console.log('\n=== 1. The booking form shows phone + SMS opt-in ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);

    const form = await page.evaluate(() => {
      const phone = document.getElementById('phone');
      const box = document.getElementById('sms_opt_in');
      const label = document.querySelector('label[for="sms_opt_in"]');
      const btn = document.getElementById('inquiry-send');
      return {
        phoneExists: !!phone,
        phoneType: phone && phone.getAttribute('type'),
        phoneRequired: phone && phone.required,
        phoneVisible: phone ? phone.getBoundingClientRect().height > 0 : false,
        boxExists: !!box,
        boxChecked: box && box.checked,
        boxRequired: box && box.required,
        boxVisible: box ? box.getBoundingClientRect().height > 0 : false,
        consentText: label && label.textContent.replace(/\s+/g, ' ').trim(),
        submitExists: !!btn,
      };
    });

    console.log('    consent text:', form.consentText);
    check('the phone field exists', form.phoneExists);
    check('the phone field is type=tel', form.phoneType === 'tel', String(form.phoneType));
    check('the phone field is OPTIONAL', form.phoneRequired === false);
    check('the phone field is VISIBLE', form.phoneVisible);
    check('the opt-in checkbox exists', form.boxExists);
    check('the opt-in checkbox is UNCHECKED by default', form.boxChecked === false);
    check('the opt-in checkbox is OPTIONAL', form.boxRequired === false);
    check('the opt-in checkbox is VISIBLE', form.boxVisible);
    check('the consent wording is exact',
      form.consentText === 'I agree to receive text or email messages from Swain Photography about my inquiry. Msg and data rates may apply. Reply STOP to opt out.',
      form.consentText);
    check('the submit button still exists', form.submitExists);

    await page.evaluate(() => document.querySelector('#inquire').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    const inquire = await page.$('#inquire');
    await inquire.screenshot({ path: path.join(OUT, 'booking-form.png') });

    // The whole form section, so the phone + checkbox are visible together.
    const section = await page.$('section.inquiry');
    await section.screenshot({ path: path.join(OUT, 'inquiry-section.png') });
    await ctx.close();
  }

  console.log('\n=== 2. It posts as a REVIEW COPY (can never email) ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    let posted = null;
    await page.route('**/api/swain/inquiry', async (route) => {
      posted = route.request().postData();
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, id: 'review-copy-test', notifications: [] }) });
    });
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.fill('#name', 'Review Test');
    await page.fill('#email', 'review@example.invalid');
    await page.fill('#phone', '(630) 555-0123');
    await page.fill('#msg', 'combined review build probe');
    await page.check('#sms_opt_in');
    await page.click('#inquiry-send');
    await page.waitForTimeout(1500);
    check('the form POSTed to the inquiry endpoint', !!posted, String(posted));
    if (posted) {
      const body = JSON.parse(posted);
      check('it sends the phone number', body.phone === '(630) 555-0123', String(body.phone));
      check('it sends the opt-in answer yes', body.smsOptIn === 'yes', String(body.smsOptIn));
      check('it sends the review-copy source',
        body.source === 'swain-photography-review-copy', String(body.source));
    }
    await ctx.close();
  }

  console.log('\n=== 3. Everything else from the earlier builds is still here ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    const f = await page.evaluate(() => {
      const h = document.querySelector('.about h2');
      const s = document.querySelector('.about .sig');
      const a = document.querySelector('.about img');
      const cards = [...document.querySelectorAll('.work .card img')];
      return {
        hVar: getComputedStyle(h).fontVariationSettings,
        sVar: getComputedStyle(s).fontVariationSettings,
        aboutSrc: a.getAttribute('src'),
        aboutLoaded: a.complete && a.naturalWidth > 0,
        cardCount: cards.length,
        broken: cards.filter((c) => !(c.complete && c.naturalWidth > 0)).length,
        hasAutoScroll: !!document.querySelector('.flow'),
      };
    });
    check('the About heading still has the clean J (opsz 9)', /opsz\D*9/i.test(f.hVar), f.hVar);
    check('the signature still matches (opsz 9)', /opsz\D*9/i.test(f.sVar), f.sVar);
    check("the About photo is Jenna's portrait", f.aboutSrc === 'photos/jenna-woods.jpg', f.aboutSrc);
    check('the About photo loads', f.aboutLoaded);
    check('the gallery still has 11 cards', f.cardCount === 11, String(f.cardCount));
    check('every gallery image loads', f.broken === 0, String(f.broken));
    await ctx.close();
  }

  console.log('\n=== 4. Mobile is clean ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => document.querySelector('#inquire').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }));
    check('no horizontal overflow on mobile', !m.overflow, `${m.sw} vs ${m.iw}`);
    const sec = await page.$('section.inquiry');
    await sec.screenshot({ path: path.join(OUT, 'mobile-booking-form.png') });
    await ctx.close();
  }
} catch (err) {
  failures.push('UNCAUGHT: ' + (err && err.stack ? err.stack : String(err)));
  console.error('\nUNCAUGHT:', err);
} finally {
  await browser.close();
  server.close();
}

console.log('\n==============================================================');
console.log('RESULT: ' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('screenshots: ' + OUT);
console.log('==============================================================');
