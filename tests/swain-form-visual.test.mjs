#!/usr/bin/env node
// Visual + interaction check for the Swain Photography inquiry form.
//
// Serves preview/swain-photography over HTTP and drives the real page in
// Playwright at desktop (1440x900) and mobile (390x844) sizes, capturing:
//   * client-side validation error state
//   * server-error state
//   * success state
//   * button disabled while sending
//   * no redirect (URL unchanged)
//   * console errors / failed requests
//
// The API is stubbed by the page proxy so NO real inquiry is stored and NO
// notification is ever attempted.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SITE = path.join(REPO, 'preview/swain-photography');
const OUT = '/tmp/swain-form-shots';
const PORT = 55440;

fs.mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };

// Stub mode is toggled by a query param so the test can force server behaviour.
let stubMode = 'success';
let seen = [];

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/swain/inquiry')) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      seen.push({ body, headers: req.headers });
      const send = (status, payload) => {
        const t = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(t);
      };
      if (stubMode === 'server-error') return send(503, { error: 'We could not save your inquiry. Please try again — if it keeps failing, email us directly.' });
      if (stubMode === 'validation-error') return send(400, { error: 'Please check the email address.' });
      if (stubMode === 'rate-limited') return send(429, { error: 'Too many inquiries from your connection. Please try again later.' });
      return send(200, { ok: true, id: body.submissionId || 'test-id', notifications: [] });
    });
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(SITE, p);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch();
const results = [];

async function run(viewport, label, mobile) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: !!mobile,
    hasTouch: !!mobile,
  });
  const page = await ctx.newPage();
  const errors = [], failed = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()); });

  const base = `http://127.0.0.1:${PORT}/`;
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const urlBefore = page.url();

  // --- 1. client-side validation error (empty submit) ---
  await page.locator('#inquiry-send').scrollIntoViewIfNeeded();
  await page.locator('#inquiry-send').click();
  await page.waitForTimeout(400);
  const validationVisible = await page.locator('#inquiry-status').isVisible();
  const validationText = (await page.locator('#inquiry-status').innerText()).trim();
  await page.screenshot({ path: `${OUT}/${label}-1-validation-error.png`, fullPage: false });

  // --- 2. server error state ---
  stubMode = 'server-error';
  await page.fill('#name', 'Test Person');
  await page.fill('#email', 'tester@example.com');
  await page.fill('#msg', 'A couples session by the lake in June.');
  await page.locator('#inquiry-send').click();
  await page.waitForTimeout(900);
  const errorVisible = await page.locator('#inquiry-status').isVisible();
  const errorText = (await page.locator('#inquiry-status').innerText()).trim();
  const errorClass = await page.locator('#inquiry-status').getAttribute('class');
  await page.screenshot({ path: `${OUT}/${label}-2-server-error.png`, fullPage: false });

  // --- 3. success state ---
  stubMode = 'success';
  await page.locator('#inquiry-send').click();
  await page.waitForTimeout(900);
  const successVisible = await page.locator('#inquiry-status').isVisible();
  const successText = (await page.locator('#inquiry-status').innerText()).trim();
  const successClass = await page.locator('#inquiry-status').getAttribute('class');
  const urlAfter = page.url();
  await page.screenshot({ path: `${OUT}/${label}-3-success.png`, fullPage: false });

  // --- 4. button disabled while sending ---
  stubMode = 'success';
  await page.fill('#name', 'Another Person');
  await page.fill('#email', 'another@example.com');
  await page.fill('#msg', 'A graduation party.');
  const disabledDuringSend = await page.evaluate(async () => {
    const btn = document.getElementById('inquiry-send');
    const form = document.getElementById('inquiry-form');
    document.getElementById('name').value = 'During Send';
    document.getElementById('email').value = 'during@example.com';
    document.getElementById('msg').value = 'Checking disabled state';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    // synchronous check right after dispatch
    const wasDisabled = btn.disabled;
    const label = btn.textContent;
    return { wasDisabled, label };
  });
  await page.waitForTimeout(800);

  results.push({
    view: label,
    validationVisible, validationText: validationText.slice(0, 90),
    errorVisible, errorText: errorText.slice(0, 90), errorClass,
    successVisible, successText: successText.slice(0, 120), successClass,
    urlUnchanged: urlBefore === urlAfter,
    buttonDisabledDuringSend: disabledDuringSend.wasDisabled,
    buttonLabelDuringSend: disabledDuringSend.label,
    consoleErrors: errors, failedRequests: failed,
  });
  await ctx.close();
}

await run({ width: 1440, height: 900 }, 'desktop', false);
await run({ width: 390, height: 844 }, 'mobile', true);

await browser.close();
server.close();

console.log(JSON.stringify(results, null, 2));

const checks = [];
const d = results[0], m = results[1];
for (const [name, r] of [['desktop', d], ['mobile', m]]) {
  checks.push([name + ': validation error visible', r.validationVisible]);
  checks.push([name + ': server error visible + .err class', r.errorVisible && r.errorClass.includes('err')]);
  checks.push([name + ': success visible + .ok class', r.successVisible && r.successClass.includes('ok')]);
  checks.push([name + ': no redirect (URL unchanged)', r.urlUnchanged]);
  checks.push([name + ': button disabled while sending', r.buttonDisabledDuringSend]);
  checks.push([name + ': no console errors (excluding the deliberate 503 error-state stub)',
    r.consoleErrors.filter((e) => !/503/.test(e)).length === 0]);
  checks.push([name + ': no unexpected failed requests (only the deliberate 503 stub)',
    r.failedRequests.filter((f) => !/^503 /.test(f)).length === 0]);
}
console.log('\n' + '='.repeat(60));
let bad = 0;
for (const [label, ok] of checks) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label);
  if (!ok) bad++;
}
console.log(`RESULT: ${checks.length - bad} passed, ${bad} failed`);
console.log('screenshots: ' + OUT);
console.log('='.repeat(60));
process.exit(bad ? 1 : 0);
