#!/usr/bin/env node
// Verify the Swain Photography images/heading review build.
//
// READ-ONLY: renders a local copy, makes no requests to the deployed site.
//
// Proves:
//   1. The About heading "Hi, I'm Jenna" has NO flared/swashy J (opsz is 9)
//   2. The signature "Jenna Swain" is consistent with the headings
//   3. The About photo is the new portrait of Jenna, not the old bicycle
//   4. "The work" has the three new cards, and every image actually LOADS
//      (no broken images)
//   5. No console errors, no horizontal overflow on mobile
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(REPO, 'preview/swain-images-review');
const PORT = 5573;
const OUT = '/tmp/swain-images-review-shots';
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
  // ---------------------------------------------------------- heading font
  console.log('\n=== 1. The About heading has a clean, plain J ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(URL, { waitUntil: 'networkidle' });

    const fontInfo = await page.evaluate(() => {
      const h = document.querySelector('.about h2');
      const s = document.querySelector('.about .sig');
      return {
        h2Font: getComputedStyle(h).fontFamily,
        h2Var: getComputedStyle(h).fontVariationSettings,
        sigVar: getComputedStyle(s).fontVariationSettings,
        h2Text: h.textContent.trim(),
        sigText: s.textContent.trim(),
      };
    });
    console.log('    heading font:', fontInfo.h2Font);
    console.log('    heading variation-settings:', fontInfo.h2Var);
    check('the heading pins opsz to 9 (no flared J)', /opsz\D*9/i.test(fontInfo.h2Var), fontInfo.h2Var);
    check('the signature uses the same setting', /opsz\D*9/i.test(fontInfo.sigVar), fontInfo.sigVar);

    const h2 = await page.$('.about h2');
    await h2.screenshot({ path: path.join(OUT, 'heading-fixed.png') });
    const sig = await page.$('.about .sig');
    await sig.screenshot({ path: path.join(OUT, 'signature-fixed.png') });
    const about = await page.$('.about');
    await about.screenshot({ path: path.join(OUT, 'about-section.png') });
    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------- images
  console.log('\n=== 2. The images are right and all of them load ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const failedReqs = [];
    page.on('requestfailed', (r) => failedReqs.push(r.url()));
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.work').scrollIntoView());
    await page.waitForTimeout(400);

    const imgs = await page.evaluate(() => {
      const about = document.querySelector('.about img');
      const cards = [...document.querySelectorAll('.work .card img')];
      return {
        aboutSrc: about.getAttribute('src'),
        aboutAlt: about.getAttribute('alt'),
        aboutLoaded: about.complete && about.naturalWidth > 0,
        cardCount: cards.length,
        cardSrcs: cards.map((c) => c.getAttribute('src')),
        cardAlts: cards.map((c) => c.getAttribute('alt')),
        brokenCards: cards.filter((c) => !(c.complete && c.naturalWidth > 0)).map((c) => c.getAttribute('src')),
        capCount: document.querySelectorAll('.work .card figcaption').length,
      };
    });

    check('the About photo is the new Jenna portrait', imgs.aboutSrc === 'photos/jenna-woods.jpg', imgs.aboutSrc);
    check('the About photo loads', imgs.aboutLoaded);
    check('the old bicycle photo is gone', !imgs.aboutSrc.includes('about.jpg'), imgs.aboutSrc);
    check('the gallery now has 11 cards (8 + 3 new)', imgs.cardCount === 11, String(imgs.cardCount));
    check('every gallery image loads', imgs.brokenCards.length === 0, JSON.stringify(imgs.brokenCards));
    check('the new lake-couple card is present', imgs.cardSrcs.includes('photos/lake-couple.jpg'));
    check('the new hands-tattoo card is present', imgs.cardSrcs.includes('photos/hands-tattoo.jpg'));
    check('the new mounted-police card is present', imgs.cardSrcs.includes('photos/mounted-police.jpg'));
    check('every card has a caption', imgs.capCount === imgs.cardCount, `${imgs.capCount} vs ${imgs.cardCount}`);
    check('no failed requests', failedReqs.length === 0, failedReqs.slice(0, 2).join(' | '));

    const work = await page.$('.work');
    await work.screenshot({ path: path.join(OUT, 'work-section.png') });
    await ctx.close();
  }

  // ---------------------------------------------------------- mobile
  console.log('\n=== 3. Mobile is clean ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.about').scrollIntoView());
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth,
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }));
    check('no horizontal overflow on mobile', !m.overflow, `${m.sw} vs ${m.iw}`);
    await page.screenshot({ path: path.join(OUT, 'mobile-about.png') });
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
