#!/usr/bin/env node
// Capture the NEW gallery cards by scrolling the carousel to the end.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(REPO, 'preview/swain-images-review');
const PORT = 5576;
const OUT = '/tmp/swain-images-review-shots';
mkdirSync(OUT, { recursive: true });

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

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
// The page pulls Fraunces/Outfit from Google Fonts. If that is slow or
// blocked, do not fail the capture - the layout is still verifiable.
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

// Park the carousel at the far right so the new cards are in frame.
await page.evaluate(() => {
  const f = document.querySelector('.flow');
  f.scrollLeft = f.scrollWidth - f.clientWidth;
});
await page.waitForTimeout(1200);

// Bring the Work section into view before clipping.
await page.evaluate(() => {
  document.querySelector('.work').scrollIntoView({ block: 'center', behavior: 'instant' });
});
await page.waitForTimeout(800);

const box = await page.locator('.work').boundingBox();
const vp = page.viewportSize();
const clipY = Math.max(0, box.y);
const clipH = Math.min(vp.height - clipY, box.height);
await page.screenshot({
  path: path.join(OUT, 'work-new-cards.png'),
  clip: { x: 0, y: clipY, width: vp.width, height: Math.max(60, clipH) },
});

// Also capture just the three new cards, one by one.
const cards = await page.$$('.work .card');
for (const c of cards.slice(-3)) {
  const alt = await c.$eval('img', (i) => i.getAttribute('alt'));
  const slug = alt.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  await c.screenshot({ path: path.join(OUT, `newcard-${slug}.png`) });
  console.log('captured card:', alt);
}

await browser.close();
server.close();
console.log('screenshots: ' + OUT);
