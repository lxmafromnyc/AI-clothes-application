#!/usr/bin/env node
/* =========================================================
   Fynd — Find Fit's product search, in a browser

   index.html in Chromium against Fynd's REAL handlers: /api/search
   (api/search.js) on a stand-in product source registered like any
   adapter, and /api/size-recommendation for Fynd's own list and the
   chosen product's chart. The page's /api/search is not stubbed: every
   result on screen came through the real gate, cursor and meter.

   The item is asked for by its link alone (no search competes with the
   link box); the search is the garment owned's, in step 01. What is
   asserted:
     * no item search on the page, the link box and the extension named
     * step 01's search: live listings, Fynd's own list labelled, Load
       more from the server with no repeats and no new search on the
       meter, a listing with no checked record refused until measured,
       a checked record compared and saved
     * a phone-width screen: no sideways scroll, Load more still works

   Nothing leaves this machine: the browser can reach only this server,
   and the chart reader's transport refuses.

   Usage: node scripts/test-find-fit-search-browser.js
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const PORT = 8973;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';

delete process.env.OPENWEBNINJA_API_KEY;
delete process.env.SERPER_API_KEY;
delete process.env.SERPAPI_API_KEY;
process.env.PRODUCT_SOURCE = 'standin';
/* the real account handlers, for saving a garment found in step 01 */
process.env.AUTH_SECRET = 'find-fit-search-secret-of-sufficient-length';
process.env.ALLOWED_ORIGIN = 'http://127.0.0.1:8973';

const source = require('../api/_providers/product-source');
const store = require('../api/_store');
const cache = require('../api/_cache');
const chart = require('../api/_sizing/chart');
chart.setTransport(async () => { throw Object.assign(new Error('offline'), { name: 'AbortError' }); });

/* ---------- a stand-in source: a generated inventory, with real pages ---------- */
const BRANDS = ['Nike', "Levi's", 'Zara', 'Carhartt', 'Patagonia', 'Champion', 'Everlane', 'Adidas', 'H&M'];
const GARMENTS = ['hoodie', 'jeans', 'wool coat', 't-shirt', 'trousers', 'sweatshirt', 'jacket'];
const COLOURS = ['black', 'white', 'navy', 'grey', 'olive', 'cream', 'red', 'tan'];
const INVENTORY = [];
BRANDS.forEach((brand, b) => GARMENTS.forEach((garment, g) => COLOURS.forEach((colour, c) => {
  const id = `${b}-${g}-${c}`;
  INVENTORY.push({ product_id: id, title: `${brand} ${colour} ${garment}`, brand, price: 30 + ((b * 13 + g * 7 + c) % 120), image: `https://img.shop.example/${id}.jpg`, link: `https://www.shop.example/p/${id}`, store: 'shop.example' });
})));
/* UNIQLO's own page for its Sweatshirt, as a source can list it: the one
   listing here that Fynd holds a record of (E475377) */
const UQ_SWEATSHIRT_URL = 'https://www.uniqlo.com/us/en/products/E475377-000/00';
INVENTORY.push({ product_id: 'uq-e475377', title: 'UNIQLO Sweatshirt', brand: 'UNIQLO', price: 39.9, image: 'https://img.shop.example/uq-e475377.jpg', link: UQ_SWEATSHIRT_URL, store: 'uniqlo.com' });
const sourceCalls = [];
const standin = {
  name: 'standin',
  paginates: true,
  configured: () => true,
  delayMs: 0,
  failNext: 0,
  async search(intent, options) {
    const page = (options && options.page) || 1;
    const size = (options && options.limit) || 12;
    const words = [].concat(intent.keywords || []).map((w) => String(w).toLowerCase().replace(/'/g, ''));
    sourceCalls.push({ page, words: words.join(' ') });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failNext > 0) { this.failNext -= 1; throw Object.assign(new Error('Standin responded 500 on search'), { status: 500 }); }
    const matching = INVENTORY.filter((p) => words.every((w) => p.title.toLowerCase().replace(/'/g, '').includes(w)));
    const start = Math.max(0, (page - 1) * size - 2);
    return matching.slice(start, start + size);
  }
};
source.registerProvider(standin);

const searchHandler = require('../api/search');
const sizingHandler = require('../api/size-recommendation');
const ACCOUNT_HANDLERS = { '/api/auth': require('../api/auth'), '/api/account': require('../api/account'), '/api/fit-profile': require('../api/fit-profile') };
const { asChecked, UQ_PAIR } = require('./fixtures/as-checked');

/* ---------- the server ---------- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };
const hits = [];
const searchBodies = [];
const quietly = async (fn) => {
  const saved = [console.warn, console.error];
  console.warn = () => {};
  console.error = () => {};
  try { return await fn(); } finally { [console.warn, console.error] = saved; }
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  hits.push(url.pathname + (url.pathname === '/api/size-recommendation' ? url.search : ''));
  const asJson = () => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); return res; };
  };
  if (url.pathname === '/api/size-recommendation') {
    req.query = Object.fromEntries(url.searchParams);
    asJson();
    try { await quietly(() => sizingHandler(req, res)); } catch (err) { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
    return undefined;
  }
  if (url.pathname === '/api/search') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (err) { req.body = {}; }
    searchBodies.push(req.body);
    asJson();
    try { await quietly(() => searchHandler(req, res)); } catch (err) { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
    return undefined;
  }
  if (ACCOUNT_HANDLERS[url.pathname]) {
    req.query = Object.fromEntries(url.searchParams);
    asJson();
    try { await quietly(() => ACCOUNT_HANDLERS[url.pathname](req, res)); } catch (err) { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
    if (!res.writableEnded) res.end();
    return undefined;
  }
  if (url.pathname.startsWith('/api/')) {
    /* no AI interpreter and no other API is wanted here */
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 503;
    return res.end('{"error":"not here"}');
  }
  const file = path.join(REPO, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  return res.end(fs.readFileSync(file));
});

let passed = 0;
const failures = [];
async function test(name, fn) {
  store.reset();
  cache.reset();
  standin.delayMs = 0;
  standin.failNext = 0;
  sourceCalls.length = 0;
  searchBodies.length = 0;
  hits.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${err && err.message ? String(err.message).slice(0, 1500) : err}\n        ${err && err.stack ? err.stack.split("\n").find((l) => /test-find-fit/.test(l)) : ""}`);
  }
}

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FYND_FIVE = ['Sweat Oversized Pullover Hoodie', 'Sweat Pullover Hoodie', 'Sweatshirt', 'SUPIMA® Cotton T-Shirt', "Men's Extra Fine Merino Crew Neck Long-Sleeve Sweater"];

(async () => {
  let chromium;
  try { chromium = require(process.env.PLAYWRIGHT_PATH || 'playwright').chromium; } catch (err) {
    console.log('Playwright is not available here — skipping the browser tests.');
    return;
  }
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  } catch (err) {
    console.log('Chromium could not launch here — skipping the browser tests.');
    server.close();
    return;
  }

  async function openPage(viewport) {
    const context = await browser.newContext({ viewport: viewport || { width: 1440, height: 900 } });
    context.setDefaultTimeout(8000);
    await context.addInitScript((origin) => {
      window.FINDWEAR_API = `${origin}/api/interpret`;
      window.FINDWEAR_SEARCH_API = `${origin}/api/search`;
    }, ORIGIN);
    /* the listings' photos, from their own host: a small image, here */
    await context.route((u) => !String(u).startsWith(ORIGIN), (route) => (/^https:\/\/img\.shop\.example\//.test(route.request().url())
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
      : route.abort()));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err && err.message));
    page.errors = errors;
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ffi-link');
    return page;
  }
  try {
    console.log('\nthe item: one link box, no search of its own');

    await test('Find Fit asks for the item by its link only: no product search competes with it, and the extension is the other way in', async () => {
      const page = await openPage();
      assert.strictEqual(await page.$('#ffs, #ffs-q, #ffs-go, #ffs-results'), null, 'no item search on the page');
      assert.strictEqual(await page.textContent('label[for="ffi-link"]'), 'Paste a product link');
      assert.match(await page.textContent('#ffi-ext-tip'), /^Already on the product page\? Use the Fynd extension\.$/);
      /* the shared search is still there for the garment owned */
      assert.deepStrictEqual(await page.evaluate(() => [typeof window.FyndLiveSearch, typeof window.FindFitSearch]), ['object', 'undefined']);
      assert.deepStrictEqual(page.errors, []);
      await page.context().close();
    });

    /* ---------- step 01: the garment the shopper already owns ---------- */
    console.log('\nstep 01: the garment you own');

    const refLive = (page) => page.$$eval('#ffr-live-results .ffs-card[data-from="live"] .ffs-name', (ns) => ns.map((n) => n.textContent));
    const refSearch = async (page, text, how) => {
      await page.waitForSelector('#ffr-search');
      await page.fill('#ffr-search', text);
      if (how === 'enter') {
        /* Fynd's list answers first; Enter with nothing of it offered searches the shops */
        await page.waitForSelector('#ffr-suggest-box:is([data-state="empty"], [data-state="error"])');
        page.listSaid = await page.textContent('#ffr-suggest-status');
        await page.press('#ffr-search', 'Enter');
      } else await page.click('#ffr-live-go');
      await page.waitForSelector('#ffr-live:not([data-state="loading"])[data-state]');
    };
    const heldStatus = async (page) => {
      await page.waitForSelector('#ffr-held:not([hidden]):not([data-status="checking"])');
      return page.getAttribute('#ffr-held', 'data-status');
    };
    /* an item typed from a record's own chart, as the item's form takes it */
    const byHandFrom = (id, size) => {
      const record = require('../api/_sizing/records').byId(id);
      const g = record.charts.garment;
      return { type: record.category, size, unit: record.units,
        measurements: Object.fromEntries(Object.keys(g.dimensions).map((d) => [d, g.sizes[size][d].value])),
        how: Object.fromEntries(Object.keys(g.dimensions).map((d) => [d, g.dimensions[d].method])) };
    };
    const compareWithItem = async (page, it) => {
      await page.click('#ff-manual > summary');
      await page.waitForSelector('#ffc-form');
      await page.check(`input[name="ff-type"][value="${it.type}"]`);
      await page.fill('#ffc-size', it.size);
      await page.check(`input[name="ff-unit"][value="${it.unit}"]`);
      for (const [k, v] of Object.entries(it.measurements)) {
        await page.fill(`#ffc-m-${k}`, String(v));
        await page.selectOption(`#ffc-how-${k}`, it.how[k]);
      }
      await page.click('#ff-submit');
      await page.waitForSelector('#fit-compare:not([hidden]):not([data-verdict="loading"]) .fit-compare-title');
    };
    const UQ_HOODIE_M = byHandFrom('uniqlo-e475378-sweat-pullover-hoodie-us', 'M');

    await test('“nike” finds nothing on Fynd’s list, and Enter searches the shops: live Nike listings, labelled, 20 to a page', async () => {
      const page = await openPage();
      await refSearch(page, 'nike', 'enter');
      /* Fynd's list says it has none, and still names what it is */
      assert.match(page.listSaid, /Nothing on Fynd’s list matches “nike”\. Press Search shops/);
      assert.match(page.listSaid, /Fynd’s list: 5 UNIQLO US products/);
      /* the list's box closes once the shops are searched */
      assert.strictEqual(await page.isHidden('#ffr-suggest-box'), true);
      const shown = await refLive(page);
      assert.strictEqual(shown.length, 20);
      assert.ok(shown.every((n) => /^Nike /.test(n)), shown.join(', '));
      assert.strictEqual(await page.isVisible('#ffr-live-more'), true);
      assert.match(await page.textContent('#ffr-live-note'), /not every retailer/);
      assert.match(await page.textContent('#ffr-live-note'), /only when it holds verified ones for that exact product, or you enter your own/);
      const card = await page.$eval('#ffr-live-results .ffs-card[data-from="live"]', (c) => ({ brand: c.querySelector('.ffs-brand').textContent, pick: c.querySelector('.ffs-pick').textContent, href: c.querySelector('.ffs-open').href }));
      assert.deepStrictEqual([card.brand, card.pick], ['Nike', 'This is mine']);
      assert.match(card.href, /^https:\/\/www\.shop\.example\/p\//);
      /* the shopper's own words, as a paginated search */
      assert.strictEqual(searchBodies[0].paginate, true);
      assert.strictEqual(searchBodies[0].limit, 20);
      assert.deepStrictEqual(searchBodies[0].intent.keywords, ['nike']);
      assert.deepStrictEqual(page.errors, []);
      await page.context().close();
    });

    await test('different brands and requests find different garments; Fynd’s own list stays, labelled', async () => {
      const page = await openPage();
      const seen = {};
      /* three new searches, and Fynd's list below: inside a Free day's allowance */
      for (const q of ['adidas sweatshirt', 'zara t-shirt', "levi's jeans"]) {
        await refSearch(page, q);
        seen[q] = await refLive(page);
        assert.ok(seen[q].length > 0, `${q}: ${await page.textContent('#ffr-live-status')} / ${JSON.stringify(searchBodies[searchBodies.length - 1])}`);
      }
      assert.ok(seen['adidas sweatshirt'].every((n) => /^Adidas .*sweatshirt$/.test(n)), seen['adidas sweatshirt'].join(', '));
      assert.ok(seen['zara t-shirt'].every((n) => /^Zara .*t-shirt$/.test(n)));
      assert.ok(seen["levi's jeans"].every((n) => /^Levi's .*jeans$/.test(n)));
      /* UNIQLO: Fynd's own products, labelled as its list */
      await refSearch(page, 'uniqlo sweatshirt');
      const fynd = await page.$$eval('#ffr-live-results .ffs-card[data-from="catalogue"] .ffs-meta', (ns) => ns.map((n) => n.textContent));
      assert.ok(fynd.length >= 1 && fynd.every((m) => /Fynd’s list/.test(m)));
      await page.context().close();
    });

    await test('Load more fetches the provider’s next page for step 01 too, with no repeats, and isn’t a new search', async () => {
      const page = await openPage();
      await refSearch(page, 'hoodie');
      const left = Number((/\((\d+) live (?:search|searches) left today\)/.exec(await page.textContent('#ffr-live-note')) || [])[1]);
      const first = await page.$$eval('#ffr-live-results .ffs-open', (as) => as.map((a) => a.href));
      await page.click('#ffr-live-more');
      await page.waitForSelector('#ffr-live:not([data-state="loading-more"])');
      const all = await page.$$eval('#ffr-live-results .ffs-open', (as) => as.map((a) => a.href));
      assert.deepStrictEqual(all.slice(0, first.length), first);
      assert.ok(all.length > first.length);
      assert.strictEqual(new Set(all).size, all.length);
      assert.deepStrictEqual(sourceCalls.map((c) => c.page), [1, 2]);
      assert.deepStrictEqual(Object.keys(searchBodies[1]), ['cursor']);
      assert.ok(Number.isFinite(left));
      assert.ok(!hits.includes('/api/interpret'), 'the AI interpreter was asked');
      await page.context().close();
    });

    await test('a listing Fynd holds no verified measurements for can be picked, but can’t become your garment without your own measurements — no brand chart, nothing compared', async () => {
      const page = await openPage();
      const compares = [];
      page.on('request', (r) => { if (/[?&]compare=1/.test(r.url())) compares.push(r.url()); });
      await refSearch(page, 'nike hoodie');
      const href = await page.$eval('#ffr-live-results .ffs-card[data-from="live"] .ffs-open', (a) => a.href);
      await page.click('#ffr-live-results .ffs-card[data-from="live"] .ffs-pick');
      assert.strictEqual(await heldStatus(page), 'listing');
      const said = await page.textContent('#ffr-held');
      assert.match(said, /doesn’t have verified measurements for this exact garment/);
      assert.match(said, /won’t use a general Nike size chart or another model’s measurements/);
      /* Fynd asked its own records about that exact product, by its link */
      assert.ok(hits.some((h) => h === '/api/size-recommendation?check=1'), hits.join(' '));
      /* the listing is kept as the product, the brand from the listing, the kind from its name */
      assert.strictEqual(await page.inputValue('#ffr-product'), href);
      assert.strictEqual(await page.inputValue('#ffr-brand'), 'Nike');
      assert.strictEqual(await page.inputValue('#ffr-type'), 'hoodies');
      assert.strictEqual(await page.$eval('#ffr-manual', (d) => d.open), true);
      if (process.env.FYND_SHOTS) await (await page.$('#ff-step-reference')).screenshot({ path: path.join(process.env.FYND_SHOTS, 'find-fit-step01-listing.png') });
      /* a size alone is not enough: no silent reference */
      await page.selectOption('#ffr-size', 'L');
      await page.click('#ffr-use');
      await page.waitForSelector('#ffr-m-chestWidth-error.show');
      assert.match(await page.textContent('#ffr-m-chestWidth-error'), /no verified measurements for this exact garment/);
      assert.strictEqual(await page.getAttribute('#ff-reference', 'data-visit'), 'empty');
      assert.deepStrictEqual(compares, []);
      /* the existing fallback: its own measurements, laid flat */
      await page.check('input[name="ff-unit"][value="cm"]');
      for (const [k, v] of Object.entries({ chestWidth: 60, bodyLength: 70, shoulderWidth: 54, sleeveLength: 61 })) await page.fill(`#ffr-m-${k}`, String(v));
      await page.click('#ffr-use');
      await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
      const kept = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fynd:find-fit:reference')));
      /* in the fit profile's own shape: the listing's identity, the label's size, the shopper's measurements */
      assert.deepStrictEqual([kept.garment.anchor.brand, kept.garment.anchor.size, kept.garment.anchor.product.url], ['Nike', 'L', href]);
      assert.deepStrictEqual(kept.garment.anchor.measurements, { unit: 'cm', chestWidth: 60, bodyLength: 70, shoulderWidth: 54, sleeveLength: 61 });
      assert.match(await page.textContent('.ff-ref--visit'), /Measured:/);
      /* and the comparison runs on those measurements, through the existing engine */
      const sent = [];
      page.on('request', (r) => { if (/[?&]candidate=1/.test(r.url())) sent.push(r.postDataJSON()); });
      await compareWithItem(page, UQ_HOODIE_M);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].reference.garment.anchor.measurements, kept.garment.anchor.measurements);
      assert.ok(await page.getAttribute('#fit-compare', 'data-verdict'));
      await page.context().close();
    });

    await test('a listing Fynd holds a checked record of: its verified measurements are used, compared, saved — and the saved garment stays', () => asChecked(UQ_PAIR, async () => {
      const page = await openPage();
      /* signed in, nothing saved yet */
      await page.goto(`${ORIGIN}/account.html`);
      await page.waitForSelector('#panel-choose:not([hidden])');
      await page.click('#email-button');
      await page.click('#auth-switch');
      await page.waitForSelector('#field-name:not([hidden])');
      await page.fill('#auth-name', 'Ada');
      await page.fill('#auth-email', `ada${Date.now()}@example.com`);
      await page.fill('#auth-password', 'find-fit-search-password');
      await page.fill('#auth-confirm', 'find-fit-search-password');
      await page.click('#auth-submit');
      await page.waitForSelector('#panel-account:not([hidden])');
      /* only the live listing, so the pick is the listing's own path */
      await page.route('**/api/size-recommendation?brands=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ brands: [], planned: [] }) }));
      await page.goto(`${ORIGIN}/index.html`);
      await refSearch(page, 'uniqlo sweatshirt M');
      const listing = await page.$$eval('#ffr-live-results .ffs-card[data-from="live"] .ffs-open', (as) => as.map((a) => a.href));
      assert.deepStrictEqual(listing, ['https://www.uniqlo.com/us/en/products/E475377-000/00']);
      await page.click('#ffr-live-results .ffs-card[data-from="live"] .ffs-pick');
      assert.strictEqual(await heldStatus(page), 'checked');
      assert.match(await page.textContent('#ffr-held'), /Fynd holds checked garment measurements for this product/);
      /* the size read apart from the words, the product the record's own page */
      assert.strictEqual(await page.inputValue('#ffr-size'), 'M');
      assert.strictEqual(await page.inputValue('#ffr-brand'), 'UNIQLO');
      await page.click('#ffr-use');
      await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
      const sent = [];
      page.on('request', (r) => { if (/[?&]compare=1/.test(r.url())) sent.push(r.postDataJSON()); });
      await compareWithItem(page, UQ_HOODIE_M);
      /* no measurements of the shopper's: the engine used the record's */
      assert.deepStrictEqual(sent[0].reference.garment.anchor, { brand: 'UNIQLO', size: 'M', product: { name: null, url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } });
      assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
      /* saved with the existing save */
      await page.waitForSelector('#ff-save .ff-save-confirm');
      await page.click('#ff-save .ff-save-confirm');
      await page.waitForSelector('#ff-save[data-state="saved"], #ff-save .ff-save-title:text("Saved")');
      /* and there next time, as a saved garment, through a new search */
      await page.reload();
      await page.waitForSelector('#ff-reference[data-state="saved"]');
      assert.match(await page.textContent('#ff-reference .ff-ref'), /UNIQLO · size M/);
      await page.context().close();
    }));

    await test('a phone-width screen: step 01’s listings in two columns, no sideways scroll, Load more works', async () => {
      const page = await openPage({ width: 390, height: 844 });
      await refSearch(page, 'hoodie');
      const first = (await refLive(page)).length;
      await page.click('#ffr-live-more');
      await page.waitForSelector('#ffr-live:not([data-state="loading-more"])');
      assert.ok((await refLive(page)).length > first);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(scroll <= 0, `sideways scroll of ${scroll}px`);
      const cols = await page.$eval('#ffr-live-results', (l) => getComputedStyle(l).gridTemplateColumns.split(' ').length);
      assert.strictEqual(cols, 2);
      await page.context().close();
    });

  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
