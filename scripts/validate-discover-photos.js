#!/usr/bin/env node
/* =========================================================
   Fynd — Discover, with the retailers' real photographs

   The interface tests stand a local file in for every retailer photo,
   because they must run anywhere. This does the opposite: it serves the
   site as it is, lets the browser reach the retailers' own image hosts,
   and checks what a shopper would actually see on Discover's shelves.

   For every shelf card, at every width:
     - the photo is the row's own verified photo (scripts/audit-catalog.js)
     - it really loaded, at product-photo size — not a stub, not broken
     - no drawn artwork stands in for it
     - it fills its 4:5 tile by cropping, never stretched
     - the card's brand is the one the row proves, or the store's address
     - the card links to the row's own listing
   and the page never scrolls sideways.

   It needs a network that can reach the retailers. Where it cannot —
   a sandbox with an egress policy — nothing is shelved (Discover will
   not put artwork on a shelf), and this says which hosts were refused
   rather than passing.

   Usage:
     node scripts/validate-discover-photos.js
     node scripts/validate-discover-photos.js --widths=1440,390
     node scripts/validate-discover-photos.js --out=artifacts/ui-validation

   Screenshots are written only when every check passes:
     <out>/discover-real-<width>.png
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const audit = require('./audit-catalog');

const REPO = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const WIDTHS = arg('widths', '1440,1024,768,390,375,360').split(',').map(Number);
const OUT = path.resolve(REPO, arg('out', 'artifacts/ui-validation'));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  try { chromium = require('playwright').chromium; } catch (e) {
    console.error('Playwright is not available.');
    process.exit(2);
  }
}

const rows = audit.readCatalogue();
const rowFor = (href) => rows.find((r) => r.productUrl === href);
const hostOf = (url) => new URL(url).hostname.replace(/^www\d?\./, '');

/* The site is answered from this checkout by the browser's own request
   routing, on an origin of its own. Nothing about it touches the network,
   so the only traffic that leaves is the retailers' photos — directly, or
   through the sandbox's proxy when there is one. */
const ORIGIN = 'http://fynd.validate';
async function serveSite(page) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const file = path.join(REPO, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
}

(async () => {
  /* inside a sandbox whose traffic leaves through a proxy, the browser
     has to use it too */
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(Object.assign(
    fs.existsSync(CHROME) ? { executablePath: CHROME } : {},
    proxy ? { proxy: { server: proxy } } : {}));
  const report = { widths: {}, photos: {}, refusedHosts: [], ok: true };
  const problems = [];

  for (const width of WIDTHS) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const refused = new Set();
    page.on('requestfailed', (req) => {
      if (req.resourceType() === 'image') refused.add(new URL(req.url()).hostname);
    });
    await serveSite(page);
    await page.goto(`${ORIGIN}/discover.html`, { waitUntil: 'domcontentloaded' });
    /* the shelves are drawn once the photos have answered; ten seconds
       is the longest Discover waits for any one of them */
    await page.waitForSelector('.shelf .item-card', { timeout: 15000 }).catch(() => {});
    /* bring every lazy photo in, and wait for each to finish */
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.shelf .item-media img')].every((i) => i.complete),
      null, { timeout: 20000 }).catch(() => {});

    const seen = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      artwork: document.querySelectorAll('.shelf svg.silhouette').length,
      cards: [...document.querySelectorAll('.shelf .item-card')].filter((c) => c.offsetParent).map((c) => {
        const img = c.querySelector('.item-media img');
        const box = img ? img.getBoundingClientRect() : null;
        const tile = c.querySelector('.item-media').getBoundingClientRect();
        return {
          href: c.getAttribute('href'),
          seller: c.querySelector('.item-retailer').textContent.trim(),
          name: c.querySelector('.item-name').textContent.trim(),
          src: img ? img.getAttribute('src') : null,
          loaded: Boolean(img && img.complete && img.naturalWidth > 0),
          natural: img ? [img.naturalWidth, img.naturalHeight] : null,
          fit: img ? getComputedStyle(img).objectFit : null,
          fills: Boolean(box && Math.abs(box.width - tile.width) < 1 && Math.abs(box.height - tile.height) < 1),
          tile: tile.width / tile.height
        };
      })
    }));

    const at = (why) => problems.push(`${width}px: ${why}`);
    if (seen.overflow > 0) at(`the page scrolls sideways by ${seen.overflow}px`);
    if (seen.artwork) at(`${seen.artwork} drawn artwork tile(s) on a shelf`);
    if (!seen.cards.length) at('no shelf was drawn — no catalogue photo could be loaded');

    for (const card of seen.cards) {
      const row = rowFor(card.href);
      if (!row) { at(`${card.href} is not a catalogue listing`); continue; }
      const verdict = audit.auditRow(row);
      const label = `${row.id}`;
      if (!verdict.shelvable) at(`${label} is shelved but fails its audit: ${verdict.problems.join('; ')}`);
      if (card.src !== row.imageUrl) at(`${label} shows ${card.src}, not its own photo`);
      if (!card.loaded) at(`${label}'s photo did not load`);
      else if (Math.min(...card.natural) < 200) at(`${label}'s photo is ${card.natural.join('×')}, too small to be a product photo`);
      if (card.fit !== 'cover' || !card.fills) at(`${label}'s photo does not fill its tile by cropping`);
      if (Math.abs(card.tile - 0.8) > 0.02) at(`${label}'s tile is ${card.tile.toFixed(3)}, not 4:5`);
      const brand = verdict.checks.brand.shown ? row.brand : hostOf(row.productUrl);
      if (card.seller !== brand) at(`${label} is labelled "${card.seller}", expected "${brand}"`);
      if (card.name !== row.name) at(`${label} is named "${card.name}", expected "${row.name}"`);
      report.photos[row.id] = { url: row.imageUrl, natural: card.natural, loaded: card.loaded };
    }

    report.widths[width] = { cards: seen.cards.length, overflow: seen.overflow, artwork: seen.artwork };
    refused.forEach((h) => report.refusedHosts.includes(h) || report.refusedHosts.push(h));
    await page.screenshot({ path: path.join(OUT, `.discover-real-${width}.pending.png`), fullPage: true });
    await page.close();
  }

  report.ok = problems.length === 0;
  report.problems = problems;
  report.validatedPhotos = Object.values(report.photos).filter((p) => p.loaded).length;

  /* screenshots are kept only when they show what was asked for */
  for (const width of WIDTHS) {
    const pending = path.join(OUT, `.discover-real-${width}.pending.png`);
    if (report.ok) fs.renameSync(pending, path.join(OUT, `discover-real-${width}.png`));
    else fs.rmSync(pending, { force: true });
  }
  fs.writeFileSync(path.join(OUT, 'discover-real-photos.json'), JSON.stringify(report, null, 2) + '\n');

  await browser.close();

  if (report.ok) {
    console.log(`Discover shows ${report.validatedPhotos} real product photos, every check passed at ${WIDTHS.join(', ')}px.`);
    process.exit(0);
  }
  console.log('Discover could not be validated with real photos:');
  problems.slice(0, 40).forEach((p) => console.log(`  - ${p}`));
  if (report.refusedHosts.length) {
    console.log('\nImage hosts the browser could not reach (if this is a sandbox, allow these in its network policy):');
    report.refusedHosts.sort().forEach((h) => console.log(`  ${h}`));
  }
  process.exit(1);
})().catch((err) => { console.error(err); process.exit(2); });
