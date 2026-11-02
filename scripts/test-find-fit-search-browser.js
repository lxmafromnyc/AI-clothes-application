#!/usr/bin/env node
/* =========================================================
   Fynd — Find Fit's product search, in a browser

   index.html in Chromium against Fynd's REAL handlers: /api/search
   (api/search.js) on a stand-in product source registered like any
   adapter, and /api/size-recommendation for Fynd's own list and the
   chosen product's chart. The page's /api/search is not stubbed: every
   result on screen came through the real gate, cursor and meter.

   What is asserted:
     * a search shows 20 real listings, not Fynd's five products; a
       different search shows different ones
     * Load more fetches the next page from the server (a request that
       carries only the cursor), keeps what is shown, adds no repeats,
       and one click at a time — repeated clicks send one request
     * a new search replaces the list and starts again at page 1
     * loading, empty, failure and end-of-results are each said
     * Fynd's own list is shown, labelled, for a request it matches
     * picking a listing hands its link to the existing lookup: the chart
       request is the one a pasted link makes, and the existing states
       (and their fallbacks) are what follow
     * searching asks no AI and no comparison, a new search is one live
       search on the meter and Load more is none
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

const source = require('../api/_providers/product-source');
const store = require('../api/_store');
const cache = require('../api/_cache');
const chart = require('../api/_sizing/chart');
chart.setTransport(async () => { throw Object.assign(new Error('offline'), { name: 'AbortError' }); });

/* ---------- a stand-in source: a generated inventory, with real pages ---------- */
const BRANDS = ['Nike', "Levi's", 'Zara', 'Carhartt', 'Patagonia', 'Champion', 'Everlane'];
const GARMENTS = ['hoodie', 'jeans', 'wool coat', 't-shirt', 'trousers'];
const COLOURS = ['black', 'white', 'navy', 'grey', 'olive', 'cream', 'red', 'tan'];
const INVENTORY = [];
BRANDS.forEach((brand, b) => GARMENTS.forEach((garment, g) => COLOURS.forEach((colour, c) => {
  const id = `${b}-${g}-${c}`;
  INVENTORY.push({ product_id: id, title: `${brand} ${colour} ${garment}`, brand, price: 30 + ((b * 13 + g * 7 + c) % 120), image: `https://img.shop.example/${id}.jpg`, link: `https://www.shop.example/p/${id}`, store: 'shop.example' });
})));
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
  if (url.pathname.startsWith('/api/')) {
    /* signed out; no AI interpreter and no other API is wanted here */
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = url.pathname === '/api/account' ? 401 : 503;
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
    console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err}`);
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
    await page.waitForSelector('#ffs-form');
    return page;
  }
  const searchFor = async (page, text) => {
    await page.fill('#ffs-q', text);
    await page.click('#ffs-go');
    await page.waitForSelector('#ffs:not([data-state="loading"])[data-state]');
  };
  const names = (page) => page.$$eval('#ffs-results .ffs-card[data-from="live"] .ffs-name', (ns) => ns.map((n) => n.textContent));
  const links = (page) => page.$$eval('#ffs-results .ffs-card[data-from="live"] .ffs-open', (ns) => ns.map((n) => n.href));
  const loadMore = async (page) => {
    await page.click('#ffs-more');
    await page.waitForSelector('#ffs:not([data-state="loading-more"])');
  };

  try {
    console.log('\nsearching');

    await test('a search shows 20 real listings from the source, not Fynd’s five; another search shows others', async () => {
      const page = await openPage();
      await searchFor(page, 'hoodie');
      const first = await names(page);
      assert.strictEqual(first.length, 20);
      assert.ok(first.every((n) => /hoodie/i.test(n)), first.join(', '));
      assert.ok(first.every((n) => !FYND_FIVE.includes(n)));
      assert.strictEqual(await page.isVisible('#ffs-more'), true);
      /* 20 live listings, and Fynd's own hoodies above them, labelled */
      const fynd = await page.$$eval('#ffs-results .ffs-card[data-from="catalogue"]', (cs) => cs.length);
      assert.match(await page.textContent('#ffs-status'), new RegExp(`${20 + fynd} products for “hoodie”`));
      assert.match(await page.textContent('#ffs-note'), /not every retailer/);
      /* the card: brand, name, price, retailer, a working link */
      const card = await page.$eval('#ffs-results .ffs-card[data-from="live"]', (c) => ({ brand: c.querySelector('.ffs-brand').textContent, meta: c.querySelector('.ffs-meta').textContent, href: c.querySelector('.ffs-open').href, img: c.querySelector('img') && c.querySelector('img').getAttribute('src') }));
      assert.match(card.meta, /^\$\d+\.\d\d · at shop\.example$/);
      assert.match(card.href, /^https:\/\/www\.shop\.example\/p\//);
      assert.match(card.img, /^https:\/\/img\.shop\.example\//);
      await searchFor(page, "Levi's jeans");
      const second = await names(page);
      assert.ok(second.length > 0 && second.every((n) => /levi's .*jeans/i.test(n)), second.join(', '));
      assert.strictEqual(sourceCalls.length, 2);
      assert.strictEqual(sourceCalls[0].words, 'hoodie');
      assert.match(sourceCalls[1].words, /levi/);
      assert.match(sourceCalls[1].words, /jeans/);
      assert.deepStrictEqual(page.errors, []);
      await page.context().close();
    });

    await test('Load more fetches the next page from the server, keeps the list, and adds no repeats', async () => {
      const page = await openPage();
      await searchFor(page, 'hoodie');
      const before = await links(page);
      await loadMore(page);
      const after = await links(page);
      if (process.env.FYND_SHOTS) await page.screenshot({ path: path.join(process.env.FYND_SHOTS, 'find-fit-search-desktop.png'), fullPage: true });
      assert.deepStrictEqual(after.slice(0, before.length), before, 'the first page was replaced');
      assert.ok(after.length > before.length);
      assert.strictEqual(new Set(after).size, after.length, 'a product repeated');
      assert.deepStrictEqual(sourceCalls.map((c) => c.page), [1, 2]);
      assert.deepStrictEqual(Object.keys(searchBodies[1]), ['cursor'], 'the next page was asked by cursor alone');
      assert.strictEqual(searchBodies[0].paginate, true);
      assert.strictEqual(searchBodies[0].limit, 20);
      await page.context().close();
    });

    await test('repeated clicks on Load more send one request, and the button says it is loading', async () => {
      const page = await openPage();
      await searchFor(page, 'hoodie');
      standin.delayMs = 500;
      await page.click('#ffs-more');
      assert.strictEqual(await page.isDisabled('#ffs-more'), true);
      assert.strictEqual((await page.textContent('#ffs-more')).trim(), 'Loading more…');
      await page.click('#ffs-more', { force: true }).catch(() => {});
      await page.evaluate(() => { window.FindFitSearch.loadMore(); window.FindFitSearch.loadMore(); });
      await page.waitForSelector('#ffs:not([data-state="loading-more"])');
      assert.strictEqual(searchBodies.filter((b) => b.cursor).length, 1);
      assert.deepStrictEqual(sourceCalls.map((c) => c.page), [1, 2]);
      await page.context().close();
    });

    await test('browsing to the end says so, and offers no more', async () => {
      const page = await openPage();
      await searchFor(page, 'navy');
      let guard = 0;
      while (await page.isVisible('#ffs-more') && guard < 10) { await loadMore(page); guard += 1; }
      assert.match(await page.textContent('#ffs-status'), /That’s everything this search returned\./);
      const all = await links(page);
      assert.strictEqual(new Set(all).size, all.length);
      /* every navy listing the source holds, once */
      assert.strictEqual(all.length, INVENTORY.filter((p) => /navy/.test(p.title)).length);
      await page.context().close();
    });

    await test('a new search replaces the list and starts again at page 1', async () => {
      const page = await openPage();
      await searchFor(page, 'hoodie');
      await loadMore(page);
      await searchFor(page, 'wool coat');
      const shown = await names(page);
      assert.ok(shown.length > 0 && shown.every((n) => /wool coat/i.test(n)));
      assert.deepStrictEqual(sourceCalls.map((c) => c.page), [1, 2, 1]);
      assert.strictEqual(searchBodies[2].paginate, true);
      assert.ok(!('cursor' in searchBodies[2]));
      await page.context().close();
    });

    await test('nothing found, and a failed source, are each said; searching again still works', async () => {
      const page = await openPage();
      /* seven matches: shown, and said to be all of them */
      await searchFor(page, 'black hoodie');
      assert.strictEqual((await names(page)).length, 7);
      assert.strictEqual(await page.isVisible('#ffs-more'), false);
      assert.match(await page.textContent('#ffs-status'), /That’s everything this search returned\./);
      await searchFor(page, 'sequinned kilt');
      assert.strictEqual(await page.getAttribute('#ffs', 'data-state'), 'empty');
      assert.match(await page.textContent('#ffs-status'), /No products found for “sequinned kilt”/);
      assert.strictEqual(await page.isVisible('#ffs-more'), false);
      standin.failNext = 1;
      await searchFor(page, 'red hoodie');
      assert.strictEqual(await page.getAttribute('#ffs', 'data-state'), 'error');
      assert.match(await page.textContent('#ffs-status'), /could not|failed|unavailable/i);
      assert.strictEqual((await names(page)).length, 0);
      await searchFor(page, 'hoodie');
      assert.strictEqual((await names(page)).length, 20);
      await page.context().close();
    });

    await test('Fynd’s own list is shown, labelled, for a request every word of which it matches', async () => {
      const page = await openPage();
      await searchFor(page, 'sweat pullover hoodie');
      const fynd = await page.$$eval('#ffs-results .ffs-card[data-from="catalogue"]', (cs) => cs.map((c) => [c.querySelector('.ffs-name').textContent, c.querySelector('.ffs-meta').textContent]));
      assert.ok(fynd.length >= 1, 'no match from Fynd’s list');
      assert.ok(fynd.every(([n, meta]) => /Hoodie/.test(n) && /Fynd’s list/.test(meta)));
      /* the brand's own name narrows to the brand, and isn't required of the product's words */
      await searchFor(page, 'UNIQLO sweatshirt');
      const named = await page.$$eval('#ffs-results .ffs-card[data-from="catalogue"] .ffs-name', (ns) => ns.map((n) => n.textContent));
      assert.ok(named.includes('Sweatshirt'), named.join(', '));
      /* a request it does not wholly match shows nothing from it */
      await searchFor(page, 'black hoodie');
      assert.strictEqual(await page.$$eval('#ffs-results .ffs-card[data-from="catalogue"]', (cs) => cs.length), 0);
      await page.context().close();
    });

    console.log('\npicking a result');

    await test('picking a listing hands its link to the existing lookup, which says what it can and cannot read', async () => {
      const page = await openPage();
      await searchFor(page, 'black hoodie');
      const href = await page.$eval('#ffs-results .ffs-card[data-from="live"] .ffs-open', (a) => a.href);
      await page.click('#ffs-results .ffs-card[data-from="live"] .ffs-pick');
      await page.waitForSelector('#ffi-found:not([hidden]):not([data-state="loading"])');
      if (process.env.FYND_SHOTS) await (await page.$('#ff-step-target')).screenshot({ path: path.join(process.env.FYND_SHOTS, 'find-fit-search-picked.png') });
      assert.strictEqual(await page.inputValue('#ffi-link'), href);
      assert.ok(hits.includes(`/api/size-recommendation?chart=${encodeURIComponent(href)}`), hits.join(' '));
      /* a shop Fynd can't read from its server: the existing fallbacks, not a fit */
      assert.strictEqual(await page.getAttribute('#ffi-found', 'data-state'), 'unavailable');
      assert.match(await page.textContent('#ffi-found'), /extension/i);
      assert.strictEqual(await page.$eval('#ffs-results .ffs-card.is-picked .ffs-open', (a) => a.href), href);
      await page.context().close();
    });

    await test('picking one of Fynd’s own products continues to its chart, as its pasted link does', async () => {
      const page = await openPage();
      await searchFor(page, 'sweat pullover hoodie');
      await page.click('#ffs-results .ffs-card[data-from="catalogue"] .ffs-pick');
      await page.waitForSelector('#ffi-found:not([hidden]):not([data-state="loading"])');
      assert.match(await page.inputValue('#ffi-link'), /^https:\/\/www\.uniqlo\.com\/us\/en\/products\//);
      assert.strictEqual(await page.getAttribute('#ffi-found', 'data-state'), 'assisted');
      await page.context().close();
    });

    console.log('\nwhat searching costs');

    await test('no AI and no comparison; a new search is one live search, Load more none', async () => {
      const page = await openPage();
      const left = async () => Number((/\((\d+) live (?:search|searches) left today\)/.exec(await page.textContent('#ffs-note')) || [])[1]);
      /* An anonymous browser's first request is metered by its address and
         the next by the device cookie it was given (api/_auth.js), so the
         counts are read from the second search on. */
      await searchFor(page, 'hoodie');
      await searchFor(page, 'jeans');
      const before = await left();
      assert.ok(Number.isFinite(before), await page.textContent('#ffs-note'));
      await loadMore(page);
      await loadMore(page);
      assert.strictEqual(searchBodies.filter((b) => b.cursor).length, 2);
      await searchFor(page, 'wool coat');
      const after = await left();
      assert.strictEqual(after, before - 1, `a new search is one live search, and the two pages were none (${before} then ${after}; ${await page.textContent('#ffs-note')} / ${await page.textContent('#ffs-status')})`);
      assert.ok(!hits.includes('/api/interpret'), 'the AI interpreter was asked');
      assert.ok(!hits.some((h) => /compare=1|candidate=1|check=1/.test(h)), `a comparison was asked: ${hits.join(' ')}`);
      /* the allowance spent: the paid search can still be browsed; a new one says why it can't */
      while ((await left()) > 0) await searchFor(page, ['coat', 'navy', 'tan'][await left() % 3]);
      const shown = (await names(page)).length;
      await loadMore(page);
      assert.ok((await names(page)).length > shown, 'Load more stopped with the allowance');
      await searchFor(page, 'trousers');
      assert.match(await page.textContent('#ffs-status'), /used the live product searches your plan allows/);
      await page.context().close();
    });

    console.log('\non a phone');

    await test('a phone-width screen: two columns, no sideways scroll, Load more works', async () => {
      const page = await openPage({ width: 390, height: 844 });
      await searchFor(page, 'hoodie');
      await loadMore(page);
      const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(scroll <= 0, `sideways scroll of ${scroll}px`);
      if (process.env.FYND_SHOTS) await page.screenshot({ path: path.join(process.env.FYND_SHOTS, 'find-fit-search-phone.png'), fullPage: false });
      const cols = await page.$eval('#ffs-results', (l) => getComputedStyle(l).gridTemplateColumns.split(' ').length);
      assert.strictEqual(cols, 2);
      assert.ok((await links(page)).length > 20);
      await page.context().close();
    });
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
