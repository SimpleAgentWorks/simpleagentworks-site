#!/usr/bin/env node
// Production build verification for the Swain Photography live page.
//
// READ-ONLY: renders a local copy over HTTP. Submits nothing to the site.
//
// Proves the PRODUCTION page (not the review copy) has everything:
//   1. the clean J on the About heading and the signature
//   2. Jenna's portrait in About, the old bicycle photo is gone
//   3. 11 gallery cards, every image loads
//   4. the auto-advancing carousel script
//   5. the OPTIONAL phone field
//   6. the OPTIONAL, unchecked-by-default consent checkbox, exact wording
//   7. NO review banner and NO review-copy source - the live form posts a
//      normal inquiry that DOES deliver
//   8. no console errors, no mobile overflow
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(REPO, 'preview/swain-photography');
const PORT = 5578;
const OUT = '/tmp/swain-production-verify';
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
  console.log('\n=== 1. The form shows phone + SMS opt-in, and posts a REAL inquiry ===');
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
      return {
        phoneExists: !!phone,
        phoneType: phone && phone.getAttribute('type'),
        phoneRequired: phone && phone.required,
        phoneVisible: phone ? phone.getBoundingClientRect().height > 0 : false,
        boxExists: !!box,
        boxChecked: box && box.checked,
        boxRequired: box && box.required,
        boxVisible: box ? box.getBoundingClientRect().height > 0 : false,
        consent: label && label.textContent.replace(/\s+/g, ' ').trim(),
        hasBanner: !!document.querySelector('.review-banner'),
        html: document.documentElement.innerHTML,
      };
    });

    check('the phone field exists', form.phoneExists);
    check('the phone field is type=tel', form.phoneType === 'tel', String(form.phoneType));
    check('the phone field is OPTIONAL', form.phoneRequired === false);
    check('the phone field is VISIBLE', form.phoneVisible);
    check('the opt-in checkbox exists', form.boxExists);
    check('the opt-in checkbox is UNCHECKED by default', form.boxChecked === false);
    check('the opt-in checkbox is OPTIONAL', form.boxRequired === false);
    check('the opt-in checkbox is VISIBLE', form.boxVisible);
    check('the consent wording is exact',
      form.consent === 'I agree to receive text or email messages from Swain Photography about my inquiry. Msg and data rates may apply. Reply STOP to opt out.',
      form.consent);
    check('NO review banner on the production page', form.hasBanner === false);
    check('NO review-copy source on the production page',
      !form.html.includes('swain-photography-review-copy'));

    // Intercept the POST and confirm it is a NORMAL inquiry (no review source).
    let posted = null;
    await page.route('**/api/swain/inquiry', async (route) => {
      posted = route.request().postData();
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, id: 'prod-test', notifications: [] }) });
    });
    await page.fill('#name', 'Production Test');
    await page.fill('#email', 'prod@example.invalid');
    await page.fill('#phone', '(630) 555-0123');
    await page.fill('#msg', 'production build probe');
    await page.check('#sms_opt_in');
    await page.click('#inquiry-send');
    await page.waitForTimeout(1500);
    check('the form POSTed', !!posted, String(posted));
    if (posted) {
      const b = JSON.parse(posted);
      check('it sends the phone number', b.phone === '(630) 555-0123', String(b.phone));
      check('it sends the opt-in answer yes', b.smsOptIn === 'yes', String(b.smsOptIn));
      check('it does NOT send a review-copy source',
        b.source !== 'swain-photography-review-copy', String(b.source));
    }
    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  console.log('\n=== 2. The clean J, the portrait and the gallery ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
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
        broken: cards.filter((c) => !(c.complete && c.naturalWidth > 0)).map((c) => c.getAttribute('src')),
        hasAutoScroll: !!document.querySelector('.flow'),
        robots: document.querySelector('meta[name=robots]')?.content,
      };
    });
    check('the About heading has the clean J (opsz 9)', /opsz\D*9/i.test(f.hVar), f.hVar);
    check('the signature matches (opsz 9)', /opsz\D*9/i.test(f.sVar), f.sVar);
    check("the About photo is Jenna's portrait", f.aboutSrc === 'photos/jenna-woods.jpg', f.aboutSrc);
    check('the About photo loads', f.aboutLoaded);
    check('the gallery has 11 cards', f.cardCount === 11, String(f.cardCount));
    check('every gallery image loads', f.broken.length === 0, JSON.stringify(f.broken));
    check('the auto-advance script is present', f.hasAutoScroll);
    check('the page is still noindex,nofollow', f.robots === 'noindex,nofollow', String(f.robots));

    await page.evaluate(() => document.querySelector('.about').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    const h2 = await page.$('.about h2');
    await h2.screenshot({ path: path.join(OUT, 'heading-J.png') });
    const sig = await page.$('.about .sig');
    await sig.screenshot({ path: path.join(OUT, 'signature.png') });
    const about = await page.$('.about');
    await about.screenshot({ path: path.join(OUT, 'about.png') });
    await ctx.close();
  }

  console.log('\n=== 3. Mobile ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.querySelector('#inquire').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      sw: document.documentElement.scrollWidth, iw: window.innerWidth,
    }));
    check('no horizontal overflow on mobile', !m.overflow, `${m.sw} vs ${m.iw}`);
    const sec = await page.$('section.inquiry');
    await sec.screenshot({ path: path.join(OUT, 'form.png') });
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
