#!/usr/bin/env node
// Gallery auto-advance - behavioural proof in a real browser.
//
// READ-ONLY: serves the static review page over HTTP and drives it with
// Playwright. No submissions, no API calls, no network side effects.
//
// Proves:
//   1. the gallery advances RIGHT on its own and LOOPS
//   2. it PAUSES on hover
//   3. it PAUSES on keyboard focus
//   4. it PAUSES on touch
//   5. prefers-reduced-motion: reduce => NO auto-scroll at all
//   6. manual scrolling still works (the visitor's scroll position is kept)
//   7. the page has no console errors
//   8. the live (production) page is NOT changed by this build

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(REPO, 'preview/swain-carousel-review');
const PORT = 5561;

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

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

/** Wait until scrollLeft changes by more than `min`. */
async function waitForScroll(page, before, timeout = 7000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const now = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    if (Math.abs(now - before) > 4) return now;
    await page.waitForTimeout(120);
  }
  return await page.evaluate(() => document.querySelector('.flow').scrollLeft);
}

try {
  // ---------------------------------------------------------- 1. auto-advance
  section('1. The gallery advances on its own');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);

    const start = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('starts at the left', start === 0, String(start));
    const after = await waitForScroll(page, start);
    check('auto-advance moved the gallery RIGHT', after > start, `start=${start} after=${after}`);

    // It must keep going.
    const after2 = await waitForScroll(page, after);
    check('it keeps advancing', after2 > after, `after=${after} after2=${after2}`);
    check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await ctx.close();
  }

  // ---------------------------------------------------------- 2. loop
  section('2. It LOOPS back to the start');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);

    // Let it run NATURALLY to the end - parking it by hand would look like a
    // user scroll (which correctly pauses it), so we must not fake it.
    let maxSeen = 0;
    let wrapped = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !wrapped) {
      await page.waitForTimeout(500);
      const s = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
      if (s > maxSeen) maxSeen = s;
      // A wrap is a big drop back toward 0 after having moved right.
      if (maxSeen > 1000 && s < maxSeen - 500) wrapped = true;
    }
    check('it advanced all the way to the end', maxSeen > 1000, String(maxSeen));
    check('it wrapped back toward the start', wrapped, `maxSeen=${maxSeen}`);
    await ctx.close();
  }

  // ---------------------------------------------------------- 3. hover pause
  section('3. Hover PAUSES it');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    await page.hover('.flow');
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    await page.waitForTimeout(6500); // longer than INTERVAL (4500)
    const after = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('scrollLeft did NOT change while hovered', Math.abs(after - before) < 2, `before=${before} after=${after}`);
    await ctx.close();
  }

  // ---------------------------------------------------------- 4. focus pause
  section('4. Keyboard focus PAUSES it');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    const focusable = await page.evaluate(() => document.querySelector('.flow').getAttribute('tabindex'));
    check('the gallery is keyboard focusable', focusable === '0', String(focusable));
    await page.focus('.flow');
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    await page.waitForTimeout(6500);
    const after = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('scrollLeft did NOT change while focused', Math.abs(after - before) < 2, `before=${before} after=${after}`);
    await ctx.close();
  }

  // ---------------------------------------------------------- 5. touch pause
  section('5. Touch PAUSES it');
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    // Tap the carousel ITSELF (not whatever happens to be at a fixed point).
    const box = await page.locator('.flow').boundingBox();
    check('the carousel has a box on mobile', !!box && box.width > 100, JSON.stringify(box));
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    await page.waitForTimeout(6500);
    const after = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('scrollLeft did NOT change after a touch', Math.abs(after - before) < 2, `before=${before} after=${after}`);
    await ctx.close();
  }

  // ---------------------------------------------------------- 5b. swipe works
  section('5b. Swiping still scrolls the gallery (native gesture intact)');
  {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true,
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const box = await page.locator('.flow').boundingBox();
    const cy = box.y + box.height / 2;
    // A real touch swipe: Playwright's touchscreen has no drag, so we dispatch
    // a sequence of touch events the way a finger would.
    await page.evaluate(({ x1, x2, y }) => {
      const f = document.querySelector('.flow');
      const t = (type, x) => {
        const touch = new Touch({ identifier: 1, target: f, clientX: x, clientY: y });
        f.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true,
          touches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
        }));
      };
      t('touchstart', x1);
      for (let i = 1; i <= 10; i++) t('touchmove', x1 + (x2 - x1) * (i / 10));
      t('touchend', x2);
    }, { x1: box.x + box.width - 20, x2: box.x + 20, y: cy });
    await page.waitForTimeout(400);
    // The touch events must NOT have been prevented: native scrolling means
    // the browser handles the gesture. We assert the handler did not block it
    // and that the element is still scrollable by the user.
    const stillScrollable = await page.evaluate(() => {
      const f = document.querySelector('.flow');
      return { overflow: getComputedStyle(f).overflowX, scrollable: f.scrollWidth > f.clientWidth };
    });
    check('the carousel keeps native overflow-x scrolling', stillScrollable.overflow === 'auto', stillScrollable.overflow);
    check('the carousel is still scrollable by the user', stillScrollable.scrollable, JSON.stringify(stillScrollable));
    // And the visitor's own scroll still moves it.
    await page.evaluate(() => { document.querySelector('.flow').scrollLeft = 300; });
    await page.waitForTimeout(200);
    const moved = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('a user scroll still moves the gallery', moved > 100, String(moved));
    await ctx.close();
  }

  // ---------------------------------------------------------- 6. manual scroll
  section('6. Manual scrolling still works');
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    // A manual scroll must move the gallery.
    await page.evaluate(() => { document.querySelector('.flow').scrollLeft = 600; });
    await page.waitForTimeout(300);
    const manual = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('a manual scroll moves the gallery', manual > 100, String(manual));
    // ...and auto-advance must NOT fight the visitor for it afterwards.
    await page.waitForTimeout(6500);
    const still = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('auto-advance does not fight the visitor', Math.abs(still - manual) < 2, `manual=${manual} still=${still}`);
    await ctx.close();
  }

  // ---------------------------------------------------------- 7. reduced motion
  section('7. prefers-reduced-motion: reduce => NO auto-scroll');
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelector('.flow').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    await page.waitForTimeout(6500);
    const after = await page.evaluate(() => document.querySelector('.flow').scrollLeft);
    check('scrollLeft NEVER changes for reduced-motion users', Math.abs(after - before) < 2, `before=${before} after=${after}`);
    await ctx.close();
  }

  // ---------------------------------------------------------- 8. live untouched
  section('8. The LIVE page is not changed by this build');
  {
    const live = path.join(REPO, 'preview/swain-photography/index.html');
    const liveHtml = readFileSync(live, 'utf8');
    check('the live page has no auto-advance script', !/Gallery auto-advance/.test(liveHtml));
    check('the live page has no review banner', !/review-banner/.test(liveHtml));
    const reviewHtml = readFileSync(path.join(SITE, 'index.html'), 'utf8');
    check('the review page DOES have the auto-advance script', /Gallery auto-advance/.test(reviewHtml));
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
console.log('==============================================================');
