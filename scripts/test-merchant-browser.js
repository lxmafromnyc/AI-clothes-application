#!/usr/bin/env node
/* =========================================================
   Fynd — a merchant's own catalogue in a real browser
   Find Fit and the product page in Chromium, against the real
   /api/size-recommendation handler, with the FIXTURE merchant
   (scripts/fixtures/merchant: "FIXTURE Northwind Apparel", every host on
   the reserved .example domain) imported the way
   scripts/sync-catalog.js --merchant imports one, into a temporary
   directory. What a shopper does: choose the merchant, search, filter by
   brand, colour and size, open a product, see its photos from the
   merchant's own image host — and see that Fynd holds no sizing for it,
   never a size made from a label.
   Offline: the merchant's "photos" are a 1-pixel image served by the
   test for its image host only; every other address is refused.
     node scripts/test-merchant-browser.js
   Needs Chromium; skips with a clear message if it is not present.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const PORT = 8937;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const FIX = path.join(__dirname, 'fixtures/merchant');

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — skipping merchant browser tests.');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-merchant-browser-'));
const catalogFile = path.join(tmp, 'northwind-fixture.json');
/* a 1×1 transparent PNG, the merchant's every "photo" */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
  /* the merchant's export, imported as the CLI does, outside api/_catalog/data */
  const code = await require('./sync-catalog').main(['--merchant', path.join(FIX, 'northwind-merchant.json'), '--file', path.join(FIX, 'northwind-variants.csv'), '--complete', '--allow-fixture', '--out', catalogFile, '--status', path.join(tmp, 'status.json')], { env: {}, log: () => {}, error: (l) => console.error(l) });
  assert.strictEqual(code, 0, 'the fixture export imports');
  process.env.FYND_TEST_MERCHANTS = path.join(FIX, 'northwind-merchant.json');
  process.env.FYND_CATALOG_NORTHWIND_FIXTURE = catalogFile;
  const handler = require('../api/size-recommendation');
  /* no retailer page is ever read here */
  require('../api/_sizing/chart').setTransport(async () => { throw Object.assign(new Error('offline'), { name: 'AbortError' }); });

  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (url.pathname === '/api/size-recommendation') {
      req.query = Object.fromEntries(url.searchParams);
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (payload) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); return res; };
      try { await handler(req, res); } catch (err) { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
      return undefined;
    }
    if (url.pathname.startsWith('/api/')) {
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

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  } catch (err) {
    console.log('Chromium could not launch here — skipping merchant browser tests.');
    server.close();
    process.exit(0);
  }

  const photos = [];
  async function openPage(file) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(8000);
    await context.addInitScript((origin) => { window.FINDWEAR_API = `${origin}/api/interpret`; }, ORIGIN);
    /* the merchant's image host answers with a pixel; every other address is refused */
    await context.route((u) => !String(u).startsWith(ORIGIN), (route) => {
      const u = new URL(route.request().url());
      if (u.protocol === 'https:' && u.hostname === 'images.northwind.example') { photos.push(u.pathname); return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }); }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log(`      [page error] ${err && err.message}`));
    await page.goto(`${ORIGIN}/${file}`, { waitUntil: 'domcontentloaded' });
    return page;
  }
  const answered = async (page, action) => {
    const before = Number(await page.getAttribute('#fit-browser', 'data-answers')) || 0;
    await action();
    await page.waitForFunction((n) => Number(document.getElementById('fit-browser').dataset.answers) > n, before);
  };
  const codes = (page) => page.$$eval('.fit-product', (bs) => bs.map((b) => b.dataset.code));
  const openMerchant = async (page) => {
    await page.waitForSelector('#fit-browser[data-brands="ready"]');
    await page.click('.fit-brand-choice[data-brand="northwind-fixture"]');
    await page.waitForSelector('#fit-browser[data-answers="1"]');
  };

  console.log('\nFind Fit, with a merchant\'s own catalogue (FIXTURE)');

  await test('the merchant is in the brand menu beside UNIQLO, with its count, and opens onto its products with photos from its own image host', async () => {
    const page = await openPage('index.html');
    await page.waitForSelector('#fit-browser[data-brands="ready"]');
    assert.deepStrictEqual(await page.$$eval('.fit-brand-choice', (bs) => bs.map((b) => b.dataset.brand)), ['uniqlo', 'northwind-fixture']);
    assert.match(await page.textContent('.fit-brand-choice[data-brand="northwind-fixture"]'), /FIXTURE Northwind Apparel\s*7 products/);
    await openMerchant(page);
    assert.strictEqual((await codes(page)).length, 7);
    assert.match(await page.textContent('#fit-coverage'), /^7 products from FIXTURE Northwind Apparel's own catalogue, updated \d{4}-\d{2}-\d{2}\.$/);
    await page.waitForFunction(() => document.querySelectorAll('.fit-product-media[data-image="photo"] img').length === 7);
    const srcs = await page.$$eval('.fit-product-media img', (is) => is.map((i) => i.src));
    assert.ok(srcs.every((s) => s.startsWith('https://images.northwind.example/p/')), srcs.join(' '));
    assert.strictEqual(await page.$$eval('.fit-product-media[data-image="failed"]', (x) => x.length), 0, 'every photo loaded');
    await page.context().close();
  });

  await test('each card says it is from the merchant\'s catalogue and that Fynd has no sizing chart for it — listed, not sized', async () => {
    const page = await openPage('index.html');
    await openMerchant(page);
    const card = '.fit-product[data-code="NW-HD-1002"]';
    assert.strictEqual(await page.textContent(`${card} .fit-product-fact[data-fact="catalogue"]`), 'From the merchant’s own catalogue');
    assert.strictEqual(await page.textContent(`${card} .fit-product-fact[data-fact="chart"]`), 'No sizing chart saved');
    assert.strictEqual(await page.textContent(`${card} .fit-product-fact[data-fact="comparable"]`), 'Can’t be compared yet');
    assert.strictEqual(await page.textContent(`${card} .fit-product-sizes`), 'Sizes XS–XL');
    assert.strictEqual(await page.textContent(`${card} .fit-product-holds`), 'No saved chart for this product');
    await page.context().close();
  });

  await test('search, then filter by brand, colour and size — the server\'s filters, from the catalogue\'s own facets', async () => {
    const page = await openPage('index.html');
    await openMerchant(page);
    await answered(page, () => page.fill('#fit-product-search', 'tee'));
    assert.deepStrictEqual((await codes(page)).sort(), ['NW-TS-3001', 'NW-TS-3002']);
    await answered(page, () => page.fill('#fit-product-search', ''));
    /* two brands in one merchant: a brand row, by their own names */
    assert.deepStrictEqual(await page.$$eval('.fit-filter[data-group="vendor"]', (bs) => bs.map((b) => b.textContent)), ['Any', 'FIXTURE Harbor Supply', 'FIXTURE Northwind']);
    await answered(page, () => page.click('.fit-filter[data-group="vendor"][data-value="fixture-harbor-supply"]'));
    assert.deepStrictEqual(await codes(page), ['NW-HB-5001']);
    await answered(page, () => page.click('.fit-filter[data-group="vendor"][data-value="all"]'));
    await answered(page, () => page.click('.fit-filter[data-group="colour"][data-value="black"]'));
    assert.deepStrictEqual((await codes(page)).sort(), ['NW-CR-2001', 'NW-HD-1001', 'NW-TS-3001']);
    await answered(page, () => page.click('.fit-filter[data-group="size"][data-value="XS"]'));
    assert.deepStrictEqual(await codes(page), ['NW-CR-2001']);
    await page.context().close();
  });

  await test('sorted by price, low to high: the merchant\'s licensed, current prices', async () => {
    const page = await openPage('index.html');
    await openMerchant(page);
    await answered(page, () => page.selectOption('#fit-product-sort', 'price-asc'));
    assert.deepStrictEqual(await codes(page), ['NW-TS-3001', 'NW-TS-3002', 'NW-CR-2001', 'NW-HD-1002', 'NW-PT-4001', 'NW-HD-1001', 'NW-HB-5001']);
    assert.strictEqual(await page.textContent('.fit-product[data-code="NW-TS-3001"] .fit-product-price'), '$28.00');
    await page.context().close();
  });

  await test('a product\'s page: its name and brand, the merchant\'s photos, colours and size labels, a link to the merchant\'s own page — and no size from a label', async () => {
    const page = await openPage('product.html?brand=northwind-fixture&item=NW-HD-1002');
    await page.waitForSelector('#product[data-state="ready"]');
    assert.strictEqual(await page.textContent('#pdp-name'), 'Zip-Front Fleece Hoodie');
    assert.strictEqual(await page.textContent('#pdp-brand'), 'FIXTURE Northwind');
    assert.strictEqual(await page.textContent('#pdp-retailer'), 'View on FIXTURE Northwind Apparel');
    assert.strictEqual(await page.getAttribute('#pdp-retailer', 'href'), 'https://www.northwind.example/products/NW-HD-1002');
    await page.waitForSelector('#pdp-main-image img');
    assert.ok((await page.getAttribute('#pdp-main-image img', 'src')).startsWith('https://images.northwind.example/p/NW-HD-1002/'));
    assert.deepStrictEqual(await page.$$eval('.pdp-swatch', (bs) => bs.map((b) => b.getAttribute('aria-label'))), ['Navy', 'Oatmeal']);
    assert.deepStrictEqual(await page.$$eval('.pdp-size', (bs) => bs.map((b) => b.textContent)), ['XS', 'S', 'M', 'L', 'XL']);
    assert.strictEqual(await page.textContent('#pdp-holds'), 'No saved chart for this product');
    await page.context().close();
  });

  await test('a photo address off the merchant\'s image host is never loaded, even if an answer carries one', async () => {
    const asked = [];
    const page = await openPage('product.html?brand=northwind-fixture&item=NW-TS-3001');
    page.on('request', (r) => asked.push(r.url()));
    /* the real answer, with its first colour's photo moved to another host */
    await page.route('**/api/size-recommendation?*', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (body.product) body.product.colours[0].image = 'https://cdn.elsewhere.example/NW-TS-3001.jpg';
      return route.fulfill({ response: res, json: body });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#product[data-state="ready"]');
    assert.strictEqual(await page.$$eval('img[src*="elsewhere.example"]', (is) => is.length), 0, 'never drawn');
    assert.ok(!asked.some((u) => u.includes('elsewhere.example')), 'never asked for');
    /* the merchant's own photos of the other colours still show */
    assert.ok(await page.$$eval('.pdp-thumb img', (is) => is.length) >= 1);
    await page.context().close();
  });

  await test('the product page names the merchant, never UNIQLO, in what it says Fynd does and doesn\'t hold', async () => {
    const page = await openPage('product.html?brand=northwind-fixture&item=NW-PT-4001');
    await page.waitForSelector('#product[data-state="ready"]');
    const text = await page.textContent('#product');
    assert.ok(!/UNIQLO/.test(text), 'no UNIQLO wording on a merchant\'s page');
    assert.match(text, /Product ID NW-PT-4001, FIXTURE Northwind Apparel US\./);
    assert.match(text, /Care instructions aren’t held by Fynd — they’re on FIXTURE Northwind Apparel’s page\./);
    assert.strictEqual(await page.textContent('#pdp-crumb-brand'), 'FIXTURE Northwind Apparel');
    await page.context().close();
  });

  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
