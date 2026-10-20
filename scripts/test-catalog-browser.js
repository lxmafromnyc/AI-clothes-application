#!/usr/bin/env node
/* =========================================================
   Fynd — the catalogue in a real browser

   Find Fit and the product page in Chromium, against the real
   /api/size-recommendation handler, with an authorized-catalogue
   FIXTURE synced the way scripts/sync-catalog.js syncs one (every code
   from E910001 / E950000 and every "FIXTURE" name is invented). What a
   shopper does: choose UNIQLO, type "black oversized hoodie", filter,
   page through more than a thousand products a page at a time, open
   one, and see its sizing — from Fynd's sizing pipeline by its exact
   code, never from the catalogue.

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
  /* one change, and the newest answer for it drawn */
  const answered = async (page, action) => {
    const before = Number(await page.getAttribute('#fit-browser', 'data-answers')) || 0;
    await action();
    await page.waitForFunction((n) => Number(document.getElementById('fit-browser').dataset.answers) > n, before);
  };
  const codes = (page) => page.$$eval('.fit-product', (bs) => bs.map((b) => b.dataset.code));
  const ready = (page) => page.waitForSelector('#fit-browser[data-answers="1"]');

  console.log('\nFind Fit, with UNIQLO’s catalogue connected');

  await test('choosing UNIQLO lists the catalogue a page at a time: 24 cards of 1,230, the source and date named, no limited-coverage notice, and never "full"', async () => {
    const page = await openPage('index.html');
    await ready(page);
    assert.strictEqual(await page.$eval('#fit-brand', (s) => s.value), 'uniqlo');
    assert.strictEqual((await codes(page)).length, 24);
    assert.match(await page.textContent('#fit-browser-status'), /^Showing 24 of 1230$/);
    assert.match(await page.textContent('#fit-coverage'), /^1230 UNIQLO US products from FIXTURE UNIQLO US feed, updated \d{4}-\d{2}-\d{2}\.$/);
    assert.ok(!/full/i.test(await page.textContent('#fit-coverage')));
    assert.strictEqual(await page.isHidden('#fit-catalog-note'), true);
    assert.strictEqual(await page.$$eval('.fit-product img', (is) => is.filter((i) => !i.getAttribute('src').startsWith('https://image.uniqlo.com/')).length), 0, 'photos only from UNIQLO’s image host');
    await page.context().close();
  });

  await test('typing "black oversized hoodie" asks the server once typing pauses, and shows the black oversized hoodies with their catalogue price', async () => {
    const page = await openPage('index.html');
    await ready(page);
    asked.length = 0;
    await answered(page, () => page.type('#fit-product-search', 'black oversized hoodie', { delay: 15 }));
    assert.deepStrictEqual(await codes(page), ['E471808-000', 'E910001-000']);
    assert.ok(asked.filter((q) => /q=/.test(q)).length <= 3, `asked ${asked.length} times while typing, not once a letter`);
    assert.strictEqual(await page.textContent('#fit-browser-status'), '');
    assert.strictEqual(await page.textContent('.fit-product[data-code="E910001-000"] .fit-product-price'), '$49.90 (was $59.90)');
    assert.strictEqual(await page.textContent('.fit-product[data-code="E471808-000"] .fit-product-name'), 'Sweat Oversized Pullover Hoodie', 'Fynd’s own name for a product it holds a record of');
    assert.strictEqual(await page.textContent('.fit-product[data-code="E471808-000"] .fit-product-holds'), 'Fynd has this product’s chart, not yet checked');
    /* Enter asks at once */
    await answered(page, async () => { await page.fill('#fit-product-search', 'parka'); await page.press('#fit-product-search', 'Enter'); });
    assert.deepStrictEqual(await codes(page), ['E910016-000']);
    await page.context().close();
  });

  await test('when no product matches every word, the closest are shown and the word that matched nothing is named — as text, whatever was typed', async () => {
    const page = await openPage('index.html');
    await ready(page);
    await answered(page, () => page.fill('#fit-product-search', 'magenta oversized hoodie'));
    assert.deepStrictEqual((await codes(page)).slice(0, 2), ['E471808-000', 'E910001-000']);
    assert.match(await page.textContent('#fit-browser-status'), /No product here matches every word — nothing matched “magenta”, so the closest matches are shown\./);
    await answered(page, () => page.fill('#fit-product-search', 'tuxedo'));
    assert.strictEqual((await codes(page)).length, 0);
    assert.strictEqual(await page.textContent('#fit-browser-status'), 'No products match. Nothing here matched “tuxedo”. Clear the search or choose another type.');
    await answered(page, () => page.fill('#fit-product-search', '<img src=x onerror="window.__owned=1">'));
    assert.strictEqual(await page.evaluate(() => window.__owned), undefined);
    assert.strictEqual(await page.$$eval('#fit-browser img:not(.fit-product img)', (is) => is.length), 0, 'nothing typed became an element');
    await page.context().close();
  });

  await test('"Show more" asks for the next page and adds it; the page never holds the whole catalogue', async () => {
    const page = await openPage('index.html');
    await ready(page);
    asked.length = 0;
    await answered(page, () => page.click('#fit-products-more'));
    assert.strictEqual((await codes(page)).length, 48);
    assert.ok(asked.some((q) => /offset=24/.test(q)), asked.join(' '));
    assert.match(await page.textContent('#fit-browser-status'), /^Showing 48 of 1230$/);
    assert.strictEqual(new Set(await codes(page)).size, 48, 'no card twice');
    assert.match(await page.textContent('#fit-products-more'), /Show more \(1182 more\)/);
    await page.context().close();
  });

  await test('filters: a type, who it’s for (kids too), and "In stock only" — each answered by the server, combinable with the search', async () => {
    const page = await openPage('index.html');
    await ready(page);
    const kinds = await page.$$eval('.fit-filter[data-group="kind"]', (bs) => bs.map((b) => b.textContent));
    assert.ok(['All', 'T-shirts', 'Sweatshirts & Hoodies', 'Outerwear', 'Jeans', 'Dresses & Skirts'].every((k) => kinds.includes(k)), kinds.join(', '));
    assert.deepStrictEqual(await page.$$eval('.fit-filter[data-group="line"]', (bs) => bs.map((b) => b.textContent)), ['Everyone', 'Men', 'Women', 'Kids']);
    await answered(page, () => page.click('.fit-filter[data-group="kind"]:has-text("Outerwear")'));
    assert.deepStrictEqual(await codes(page), ['E910016-000', 'E910017-000']);
    await answered(page, () => page.click('.fit-filter[data-group="line"]:has-text("Women")'));
    assert.deepStrictEqual(await codes(page), ['E910017-000']);
    await answered(page, () => page.click('.fit-filter[data-group="kind"]:has-text("Sweatshirts & Hoodies")'));
    await answered(page, () => page.click('.fit-filter[data-group="line"]:has-text("Kids")'));
    assert.deepStrictEqual(await codes(page), ['E910019-000']);
    await answered(page, () => page.click('.fit-filter[data-group="line"]:has-text("Everyone")'));
    const before = await codes(page);
    assert.ok(before.includes('E910004-000'), 'the sold-out cropped hoodie, before filtering');
    assert.strictEqual(await page.textContent('.fit-product[data-code="E910004-000"] .fit-product-stock'), 'Out of stock');
    await answered(page, () => page.click('.fit-filter[data-group="stock"]'));
    const stocked = await codes(page);
    assert.ok(!stocked.includes('E910004-000') && stocked.length < before.length, stocked.join(' '));
    assert.ok(!stocked.includes('E475378-000'), 'a product with no known stock isn’t called in stock');
    await answered(page, () => page.fill('#fit-product-search', 'oversized'));
    assert.deepStrictEqual(await codes(page), ['E471808-000', 'E910001-000', 'E910003-000'], 'E471808 is in stock by the catalogue');
    await page.context().close();
  });

  await test('colour and size chips come from the catalogue’s own colours and sizes, and narrow the list on the server — with in stock, per colour and size together', async () => {
    const page = await openPage('index.html');
    await ready(page);
    const colours = await page.$$eval('.fit-filter[data-group="colour"]', (bs) => bs.map((b) => b.textContent));
    assert.deepStrictEqual(colours, ['Any', 'White', 'Black', 'Gray', 'Navy', 'Green', 'Beige']);
    const sizes = await page.$$eval('.fit-filter[data-group="size"]', (bs) => bs.map((b) => b.textContent));
    assert.ok(['Any', 'XS', 'S', 'M', 'L', 'XL', '110'].every((x) => sizes.includes(x)), sizes.join(' '));
    await answered(page, () => page.click('.fit-filter[data-group="kind"]:has-text("Sweatshirts & Hoodies")'));
    await answered(page, () => page.click('.fit-filter[data-group="colour"][data-value="black"]'));
    await answered(page, () => page.click('.fit-filter[data-group="size"][data-value="XS"]'));
    const blackXs = await codes(page);
    assert.ok(blackXs.includes('E910001-000') && blackXs.includes('E910002-000'), blackXs.join(' '));
    await answered(page, () => page.click('.fit-filter[data-group="stock"]'));
    const stocked = await codes(page);
    assert.ok(!stocked.includes('E910001-000') && stocked.includes('E910002-000'), `E910001 is sold out in black XS: ${stocked.join(' ')}`);
    await answered(page, () => page.click('.fit-filter[data-group="colour"][data-value="all"]'));
    assert.ok((await codes(page)).length >= stocked.length);
    await page.context().close();
  });

  await test('only the newest answer is drawn: a slow earlier answer arriving late never replaces a later one', async () => {
    const page = await openPage('index.html');
    await ready(page);
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route(/q=hoodie/, async (route) => { await held; await route.continue(); });
    await page.fill('#fit-product-search', 'hoodie');
    await page.press('#fit-product-search', 'Enter');
    await answered(page, async () => { await page.fill('#fit-product-search', 'jeans'); await page.press('#fit-product-search', 'Enter'); });
    release();
    await page.waitForTimeout(300);
    assert.deepStrictEqual(await codes(page), ['E910012-000', 'E910011-000']);
    assert.strictEqual(await page.getAttribute('#fit-browser', 'data-query'), 'jeans');
    await page.context().close();
  });

  await test('when the catalogue can’t be fetched, Find Fit says so and offers the link box; a failed "Show more" keeps what is shown', async () => {
    failCatalog = (u) => u.searchParams.get('brand') === 'uniqlo' && !u.searchParams.has('detail') && !u.searchParams.has('item');
    const page = await openPage('index.html');
    await page.waitForSelector('#fit-browser[data-state="unavailable"]');
    assert.match(await page.textContent('#fit-browser-status'), /couldn’t be loaded just now.*paste a product’s link below/);
    assert.strictEqual((await codes(page)).length, 0);
    await page.context().close();
    failCatalog = null;
    const again = await openPage('index.html');
    await ready(again);
    failCatalog = (u) => u.searchParams.has('offset');
    await answered(again, () => again.click('#fit-products-more'));
    assert.strictEqual((await codes(again)).length, 24);
    assert.match(await again.textContent('#fit-browser-status'), /More products couldn’t be loaded just now/);
    failCatalog = null;
    await again.context().close();
  });

  console.log('\nchoosing a catalogue product');

  await test('a card opens the product’s Fynd page by its exact code: the catalogue’s colour names, size labels, price, and per-colour stock — each said to be the catalogue’s', async () => {
    const page = await openPage('index.html');
    await ready(page);
    await answered(page, () => page.fill('#fit-product-search', 'black oversized hoodie'));
    assert.strictEqual(await page.getAttribute('.fit-product[data-code="E910001-000"]', 'href'), 'product.html?brand=uniqlo&item=E910001-000');
    await page.click('.fit-product[data-code="E910001-000"]');
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
    assert.match(await page.textContent('#pdp-guide-compare'), /This chart describes bodies, not garments, so it can’t be set beside a garment you own\./);
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
    const page = await openPage('index.html');
    await ready(page);
    for (const code of ['E910106-000', 'E910102-000', 'E999999-000']) {
      await page.goto(`${ORIGIN}/product.html?brand=uniqlo&item=${code}`);
      await page.waitForSelector('#product[data-state="unknown"]');
    }
    await page.context().close();
  });

  await test('Find Fit fits a phone with the catalogue’s cards: no sideways scroll', async () => {
    const page = await openPage('index.html', { width: 360, height: 740 });
    await ready(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${overflow}px sideways`);
    await page.context().close();
  });

  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
