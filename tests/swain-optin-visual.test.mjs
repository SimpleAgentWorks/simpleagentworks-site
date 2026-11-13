#!/usr/bin/env node
// Capture the inquiry form with the new phone + consent fields so the layout
// can be eyeballed on desktop and mobile. READ-ONLY: serves the static file,
// no submissions, no API calls.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(REPO, 'preview/swain-photography/index.html'), 'utf8');
const OUT = '/tmp/swain-optin-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];

for (const [label, viewport] of [
  ['desktop', { width: 1440, height: 900 }],
  ['mobile', { width: 390, height: 844 }],
]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.setContent(HTML, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    const el = document.getElementById('inquire');
    if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  await page.waitForTimeout(500);
  // Screenshot the form element itself, so the new fields are always in frame.
  const form = await page.$('#inquiry-form');
  if (form) {
    await form.screenshot({ path: path.join(OUT, `${label}-form.png`) });
  } else {
    await page.screenshot({ path: path.join(OUT, `${label}-form.png`), fullPage: false });
  }

  // Measured facts, not vibes.
  const facts = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const phone = q('#phone');
    const box = q('#sms_opt_in');
    const label = q('label[for="sms_opt_in"]');
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
      phoneExists: !!phone,
      phoneType: phone && phone.getAttribute('type'),
      phoneRequired: phone && phone.required,
      phoneAutocomplete: phone && phone.getAttribute('autocomplete'),
      checkboxExists: !!box,
      checkboxChecked: box && box.checked,
      checkboxRequired: box && box.required,
      consentText: label && label.textContent.trim(),
      checkboxBox: r(box),
      consentLabelBox: r(label),
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      // the opt-in label must NOT be uppercased like the other field labels
      labelTransform: label && getComputedStyle(label).textTransform,
    };
  });
  results.push({ label, ...facts });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log('screenshots: ' + OUT);
