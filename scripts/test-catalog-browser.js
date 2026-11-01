#!/usr/bin/env node
/* =========================================================
   Fynd — the catalogue in a real browser

   The product page in Chromium, against the real
   /api/size-recommendation handler, with an authorized-catalogue
   FIXTURE synced the way scripts/sync-catalog.js syncs one (every code
   from E910001 / E950000 and every "FIXTURE" name is invented). What a
   shopper sees on a product's page, reached by its exact code: the
   catalogue's price, colours, sizes and description, each said to be
   the catalogue's, and its sizing — from Fynd's sizing pipeline by that
   code, never from the catalogue. (Find Fit no longer browses the
   catalogue: its item is entered by hand. Searching, filtering and
   paging the catalogue are tested at the API in test-catalog-feed.js.)

   Offline: UNIQLO's pages are never read (the chart reader's transport
   refuses), and the browser can reach nothing but this server.

   Usage: node scripts/test-catalog-browser.js
   Needs Chromium; skips with a clear message if it is not present.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const PORT = 8931;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — skipping catalogue browser tests.');
  process.exit(0);
}

/* ---------- the catalogue: the FIXTURE feed, plus 1,200 more products ---------- */

const adapter = require('../api/_catalog/sources/uniqlo-us');
const { read } = require('../api/_catalog/import');
const { sync } = require('../api/_catalog/sync');

const feed = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/catalog-feed/uniqlo-feed-v1.json'), 'utf8'));
for (let i = 0; i < 1200; i += 1) {
  const code = `E${950000 + i}-000`;
  feed.products.push({ id: code, name: `FIXTURE Bulk Crew Neck T-Shirt ${i + 1}`, url: `https://www.uniqlo.com/us/en/products/${code}/00`, category: 'Men > Tops > T-Shirts', gender: 'men', price: '9.90' });
}
const synced = sync(null, read(JSON.stringify(feed), adapter, { licensed: ['images', 'colours', 'sizes', 'price', 'stock', 'description'] }), adapter, { now: new Date().toISOString(), allowFixture: true });
assert.ok(synced.ok, synced.error);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-catalog-browser-'));
const catalogFile = path.join(tmp, 'uniqlo-us.json');
fs.writeFileSync(catalogFile, JSON.stringify(synced.catalog));
process.env.FYND_CATALOG_UNIQLO_US = catalogFile;

const handler = require('../api/size-recommendation');
/* UNIQLO's pages are never read here */
require('../api/_sizing/chart').setTransport(async () => { throw Object.assign(new Error('offline'), { name: 'AbortError' }); });

/* ---------- the server ---------- */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const asked = [];
let failCatalog = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/api/size-recommendation') {
    asked.push(url.search);
    if (failCatalog && failCatalog(url)) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"down"}'); }
    req.query = Object.fromEntries(url.searchParams);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); return res; };
    try { await handler(req, res); } catch (err) { console.error('handler threw', err && err.message); if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
    return undefined;
  }
  if (url.pathname.startsWith('/api/')) {
    /* the account and the interpreter aren't what this suite is about */
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/account') { res.statusCode = 401; return res.end('{"error":"signed out"}'); }
    return res.end('{}');
  }
  const file = path.join(REPO, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  return res.end(fs.readFileSync(file));
});

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message.split('\n').slice(0, 12).join('\n        ') : err}`); }
}

(async () => {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  } catch (err) {
    console.log('Chromium could not launch here — skipping catalogue browser tests.');
    server.close();
    process.exit(0);
  }

  async function openPage(file, viewport) {
    const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    context.setDefaultTimeout(8000);
    await context.addInitScript((origin) => { window.FINDWEAR_API = `${origin}/api/interpret`; }, ORIGIN);
    await context.route((u) => !String(u).startsWith(ORIGIN), (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log(`      [page error] ${err && err.message}`));
    await page.goto(`${ORIGIN}/${file}`, { waitUntil: 'domcontentloaded' });
    return page;
  }
  console.log('\na product’s page, with UNIQLO’s catalogue connected');









  console.log('\nthe UNIQLO popup');










  console.log('\nchoosing a catalogue product');

  await test('a product’s Fynd page, by its exact code: the catalogue’s colour names, size labels, price, and per-colour stock — each said to be the catalogue’s', async () => {
    const page = await openPage('product.html?brand=uniqlo&item=E910001-000');
    await page.waitForSelector('#product[data-state="ready"]');
    assert.strictEqual(await page.textContent('#pdp-name'), 'FIXTURE Oversized Sweat Hoodie');
    assert.strictEqual(await page.textContent('#pdp-price'), '$49.90$59.90');
    assert.strictEqual(await page.textContent('#pdp-price .pdp-price-was'), '$59.90');
    assert.match(await page.textContent('#pdp-retailer-note'), /^Price and stock as UNIQLO’s catalogue said on \d{4}-\d{2}-\d{2} — checkout, and the current figures, are on UNIQLO’s own page\.$/);
    assert.deepStrictEqual(await page.$$eval('.pdp-swatch', (bs) => bs.map((b) => b.getAttribute('aria-label'))), ['Black', 'Gray', 'Olive']);
    assert.strictEqual(await page.textContent('#pdp-colour-name'), 'Black');
    assert.deepStrictEqual(await page.$$eval('.pdp-size', (bs) => bs.map((b) => b.textContent)), ['XS', 'S', 'M', 'L', 'XL', 'XXL']);
    /* variant stock in the FIXTURE: (row + colour + size) % 7 === 0 is sold out — Black XS here */
    assert.deepStrictEqual(await page.$$eval('.pdp-size.is-out', (bs) => bs.map((b) => b.getAttribute('aria-label'))), ['XS, out of stock']);
    assert.match(await page.textContent('#pdp-sizes-note'), /^Out of stock in this colour: XS \(as of \d{4}-\d{2}-\d{2}\)\.$/);
    await page.click('.pdp-swatch[aria-label="Olive"]');
    assert.deepStrictEqual(await page.$$eval('.pdp-size.is-out', (bs) => bs.map((b) => b.textContent)), ['XXL'], 'stock follows the colour');
    await page.click('.pdp-section > summary:has-text("Source details")');
    const sources = await page.textContent('#pdp-sections');
    assert.match(sources, /Sizes from FIXTURE UNIQLO US feed, updated \d{4}-\d{2}-\d{2} — size labels only, not measurements\. Stock as the catalogue said on/);
    assert.match(sources, /Price from FIXTURE UNIQLO US feed/);
    assert.match(sources, /Listed in FIXTURE UNIQLO US feed, updated/);
    assert.match(sources, /Not held by Fynd: care, reviews, fabric, fit\./, 'its licensed description is held');
    await page.context().close();
  });

  await test('a licensed description is shown under Description & features, with where it came from', async () => {
    const page = await openPage('product.html?brand=uniqlo&item=E910016-000');
    await page.waitForSelector('#product[data-state="ready"]');
    await page.click('.pdp-section > summary:has-text("Description & features")');
    const text = await page.textContent('#pdp-sections .pdp-section:first-child');
    assert.match(text, /FIXTURE description: water-repellent shell that packs into its own pocket\.Source: FIXTURE UNIQLO US feed, updated \d{4}-\d{2}-\d{2}Read it on UNIQLO/);
    await page.context().close();
  });

  await test('its Size Guide comes from Fynd’s sizing pipeline by that code: UNIQLO’s general body chart for a men’s hoodie, said to be one and never compared — no measurements from the catalogue', async () => {
    const page = await openPage('product.html?brand=uniqlo&item=E910001-000');
    await page.waitForSelector('#product[data-state="ready"]');
    asked.length = 0;
    await page.click('#pdp-size-guide');
    await page.waitForSelector('#pdp-guide[open][data-state="fallback"]');
    assert.ok(asked.some((q) => q === '?brand=uniqlo&item=E910001-000'), 'only the brand and code travel');
    const body = await page.textContent('#pdp-guide-body');
    assert.match(body, /Product measurements of this hoodie: not available\./);
    assert.match(body, /None are shown or estimated/);
    assert.match(body, /General UNIQLO US sizing guide\s*Body measurements/);
    await page.waitForSelector('#pdp-guide-compare:not([hidden])');
    assert.match(await page.textContent('#pdp-guide-compare'), /This chart measures the body, not the finished garment\.\s*Fynd cannot directly compare these measurements with your reference garment\. No size recommendation is available from this chart alone\./);
    await page.context().close();
  });

  await test('a product Fynd holds a record for keeps its own chart and sizes; the catalogue adds only its price and colour', async () => {
    const page = await openPage('product.html?brand=uniqlo&item=E471808-000');
    await page.waitForSelector('#product[data-state="ready"]');
    assert.strictEqual(await page.textContent('#pdp-name'), 'Sweat Oversized Pullover Hoodie');
    assert.strictEqual(await page.textContent('#pdp-price'), '$49.90');
    assert.deepStrictEqual(await page.$$eval('.pdp-size', (bs) => bs.map((b) => b.textContent)), ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'], 'the record’s sizes, not the catalogue’s three');
    await page.click('#pdp-size-guide');
    await page.waitForSelector('#pdp-guide[open][data-state="ok"]');
    assert.match(await page.textContent('#pdp-guide-body'), /Product Size/);
    await page.context().close();
  });

  await test('a code the catalogue doesn’t list — discontinued, rejected, or made up — is no product', async () => {
    const page = await openPage('product.html?brand=uniqlo&item=E910001-000');
    await page.waitForSelector('#product[data-state="ready"]');
    for (const code of ['E910106-000', 'E910102-000', 'E999999-000']) {
      await page.goto(`${ORIGIN}/product.html?brand=uniqlo&item=${code}`);
      await page.waitForSelector('#product[data-state="unknown"]');
    }
    await page.context().close();
  });


  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
