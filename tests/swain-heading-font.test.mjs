#!/usr/bin/env node
// Render the About heading and signature at several font sizes / optical
// settings so the "squiggly swash J" can be seen and compared.
//
// READ-ONLY: renders a local copy of the page, makes no requests to the site.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(REPO, 'preview/swain-photography');
const HTML = readFileSync(path.join(SITE, 'index.html'), 'utf8');
const OUT = '/tmp/swain-j-test';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.setContent(HTML, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  document.querySelectorAll('.hero,.panel').forEach((e) => e.remove());
});

const variants = [
  { label: 'current (Fraunces default)', css: '' },
  { label: 'Fraunces opsz 9 (minimum)', css: 'font-variation-settings:"opsz" 9;' },
  { label: 'Fraunces opsz 144 (max)', css: 'font-variation-settings:"opsz" 144;' },
  { label: 'Fraunces opsz 9 + no SOFT/WONK', css: 'font-variation-settings:"opsz" 9,"SOFT" 0,"WONK" 0;' },
  { label: 'Outfit (clean sans)', css: "font-family:'Outfit',sans-serif;" },
  { label: 'Georgia (clean serif)', css: 'font-family:Georgia,serif;' },
];

const box = await page.evaluate(() => {
  const h = document.querySelector('.about h2');
  const s = document.querySelector('.about .sig');
  return { h: h.getBoundingClientRect().top, s: s.getBoundingClientRect().top };
});

for (const v of variants) {
  await page.evaluate(({ css }) => {
    document.querySelectorAll('.about h2,.about .sig').forEach((el) => {
      el.style.cssText = '';
      if (css) el.style.cssText += css;
    });
  }, v);
  await page.waitForTimeout(350);
  const h = await page.$('.about h2');
  const s = await page.$('.about .sig');
  const slug = v.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await h.screenshot({ path: path.join(OUT, `h2-${slug}.png`) });
  await s.screenshot({ path: path.join(OUT, `sig-${slug}.png`) });
  console.log('rendered:', v.label);
}

await browser.close();
console.log('screenshots: ' + OUT);
