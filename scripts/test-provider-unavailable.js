#!/usr/bin/env node
/* =========================================================
   Fynd — with no paid product source

   OpenWeb Ninja's plan has lapsed. These tests hold Fynd to what that
   means: with its key still set but its subscription not marked active
   (OPENWEBNINJA_SUBSCRIPTION), OpenWeb Ninja is never asked anything —
   not by /api/search, not by the adapter called directly — nothing falls
   back to another paid search on its own, and what a shopper sees says
   so honestly:

     Find Fit     the item entered by hand from its own chart: no product
                  list, no search box, and no product source asked; a
                  record link is still answered by /api/size-recommendation
                  from Fynd's records alone
     Search page  the 503 that means "no source", shown as Fynd's
                  labelled sample items, never as real listings

   Every request this process would make is counted by a stubbed fetch,
   and the chart reader's transport refuses, so nothing leaves it; the
   browser can reach nothing but this server.

   Usage: node scripts/test-provider-unavailable.js
   The browser half needs Chromium and skips with a clear message if it
   is not present.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const PORT = 8937;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* the deployment as it stands: the old key still set, the plan lapsed */
process.env.OPENWEBNINJA_API_KEY = 'lapsed-plan-key';
delete process.env.OPENWEBNINJA_SUBSCRIPTION;
delete process.env.PRODUCT_SOURCE;
delete process.env.SERPER_API_KEY;
process.env.FYND_CACHE = 'off';

/* every request this process makes, counted; none is expected */
const requested = [];
global.fetch = async (u) => { requested.push(String(u)); throw new Error(`no request expected: ${u}`); };

const openwebninja = require('../api/_providers/openwebninja');
const { getProvider } = require('../api/_providers/product-source');
const { envReport } = require('../api/_env-report');
const searchHandler = require('../api/search');
const sizingHandler = require('../api/size-recommendation');
const chart = require('../api/_sizing/chart');
const brands = require('../api/_sizing/brands');

/* UNIQLO's pages, and any other shop's, are never read here — and any
   attempt the page reader makes is counted with the rest */
chart.setTransport(async (u) => { requested.push(String(u)); throw Object.assign(new Error('offline'), { name: 'AbortError' }); });

const withEnv = async (env, fn) => {
  const saved = {};
  Object.keys(env).forEach((k) => { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; });
  try { return await fn(); }
  finally { Object.keys(saved).forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
};

const fakeRes = () => ({
  statusCode: 200,
  headers: {},
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
  getHeader(k) { return this.headers[k.toLowerCase()]; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.body = payload; return this; },
  end(text) { if (text !== undefined && this.body === undefined) this.body = text; return this; }
});

const quietly = async (fn) => {
  const real = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = real; }
};

/* the five UNIQLO US products Fynd sourced itself, and what each one's
   pasted link answers with no product source and no page read */
/* in the order Find Fit lists them: the four with a saved chart (none checked: the UNIQLO pair is pending review) in the list's own order, then the one without */
const FIVE = ['E471808-000', 'E475378-000', 'E475377-000', 'E455365-000', 'E429066-000'];
const RECORDS = { 'E475378-000': 'unverified', 'E475377-000': 'unverified', 'E471808-000': 'unverified', 'E455365-000': 'unverified' };
const uniqloUrl = (code) => `https://www.uniqlo.com/us/en/products/${code}/00`;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message.split('\n').slice(0, 12).join('\n        ') : err}`); }
}

async function nodeTests() {
  console.log('\nOpenWeb Ninja, with its plan lapsed');

  await test('a key without a subscription marked active is not configured, and selects no product source', async () => {
    for (const value of [undefined, '', 'expired', 'inactive', 'true', 'yes']) {
      await withEnv({ OPENWEBNINJA_SUBSCRIPTION: value }, () => {
        assert.strictEqual(openwebninja.configured(), false, JSON.stringify(value));
        assert.strictEqual(getProvider().name, 'none', JSON.stringify(value));
      });
    }
    /* only the word itself turns it on, however the dashboard quoted it */
    for (const value of ['active', 'ACTIVE', ' "active" ']) {
      await withEnv({ OPENWEBNINJA_SUBSCRIPTION: value }, () => assert.strictEqual(openwebninja.configured(), true, JSON.stringify(value)));
    }
    await withEnv({ OPENWEBNINJA_SUBSCRIPTION: 'active', OPENWEBNINJA_API_KEY: undefined }, () => assert.strictEqual(openwebninja.configured(), false, 'and never without a key'));
  });

  await test('naming OpenWeb Ninja explicitly changes nothing: still not configured, still a 503, still no request', async () => {
    await withEnv({ PRODUCT_SOURCE: 'openwebninja' }, async () => {
      assert.strictEqual(getProvider().configured(), false);
      requested.length = 0;
      const res = fakeRes();
      await quietly(() => searchHandler({ method: 'POST', headers: {}, body: { intent: { category: 'hoodie' } }, on: () => {} }, res));
      assert.strictEqual(res.statusCode, 503);
      assert.deepStrictEqual(requested, []);
    });
  });

  await test('nothing falls back to another paid search on its own: a Serper key alone selects nothing', async () => {
    await withEnv({ SERPER_API_KEY: 'serper-key-on-file' }, () => assert.strictEqual(getProvider().name, 'none'));
  });

  await test('/api/search answers 503 "no product source" and asks OpenWeb Ninja nothing', async () => {
    requested.length = 0;
    const res = fakeRes();
    await quietly(() => searchHandler({ method: 'POST', headers: {}, body: { intent: { category: 'hoodie', colors: ['black'] } }, on: () => {} }, res));
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { error: 'No product source is configured.', source: null });
    assert.deepStrictEqual(requested, []);
  });

  await test('the adapter refuses before any request, whoever calls it: a search, and an offer lookup', async () => {
    requested.length = 0;
    await assert.rejects(() => openwebninja.search({ category: 'hoodie' }, { country: 'us', language: 'en' }), (err) => err.inactive === true && /no request was made/.test(err.message));
    const record = { title: 'x', retailerHint: 'nike.com', productId: 'p1', sourceProductId: 'p1' };
    await openwebninja.resolveMissingOffers([record], 1, { country: 'us', language: 'en' }).catch(() => {});
    assert.strictEqual(record.productUrl, undefined, 'nothing was looked up');
    assert.deepStrictEqual(requested, []);
  });

  await test('the configuration log says whether the subscription is set — never its value', async () => {
    assert.match(envReport(), /OPENWEBNINJA_API_KEY=present OPENWEBNINJA_SUBSCRIPTION=absent/);
    await withEnv({ OPENWEBNINJA_SUBSCRIPTION: 'active' }, () => {
      assert.match(envReport(), /OPENWEBNINJA_SUBSCRIPTION=present/);
      assert.ok(!envReport().includes('=active'));
    });
  });

  console.log('\nFind Fit, with no product source');

  await test('Find Fit lists the five UNIQLO products, says that is all it holds, and offers no live search', () => {
    const found = brands.browse(brands.get('uniqlo'), {});
    assert.deepStrictEqual(found.products.map((p) => p.code), FIVE);
    assert.strictEqual(found.total, 5);
    assert.ok(!('live' in found.brand));
    assert.strictEqual(found.brand.notice, 'Fynd’s own list holds only 5 UNIQLO US products — it isn’t connected to UNIQLO’s full catalogue. For any other UNIQLO product, close this list and paste the product’s link in Find Fit: Fynd shows its size chart where it holds one, and says so plainly when it can’t.');
    assert.ok(!/Search all of UNIQLO|live listings|full catalogue\./.test(found.brand.notice.replace('isn’t connected to UNIQLO’s full catalogue.', '')));
  });

  await test('a pasted link to each of the five is answered from Fynd’s own records with no request, each keeping its verification status', async () => {
    requested.length = 0;
    for (const code of FIVE) {
      const r = await chart.chartFor(uniqloUrl(code));
      if (RECORDS[code]) {
        assert.deepStrictEqual([r.status, r.from, r.verification], ['ok', 'fynd-record', RECORDS[code]], code);
        assert.ok(r.charts.length > 0, code);
      } else {
        /* the one listing with no record: UNIQLO's page can't be read here, so it says so */
        assert.strictEqual(r.status, 'unavailable', code);
        assert.strictEqual(r.charts.length, 0, code);
      }
    }
    assert.deepStrictEqual(requested, []);
  });

  await test('a pasted link Fynd holds nothing for is answered honestly as unavailable — never another product’s chart', async () => {
    for (const url of [uniqloUrl('E999999-000'), 'https://shop.example.test/products/plain-tee']) {
      const r = await chart.chartFor(url);
      assert.strictEqual(r.status, 'unavailable', url);
      assert.deepStrictEqual(r.charts, [], url);
      assert.strictEqual(r.verification, 'not-verified', url);
    }
    assert.deepStrictEqual(requested, []);
  });

  await test('/api/size-recommendation answers a pasted record link with its chart, signed out and with no product source', async () => {
    const res = fakeRes();
    await sizingHandler({ method: 'GET', headers: {}, query: { chart: uniqloUrl('E475378-000') }, url: `/api/size-recommendation?chart=${encodeURIComponent(uniqloUrl('E475378-000'))}` }, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual([res.body.chart.status, res.body.chart.from, res.body.chart.verification], ['ok', 'fynd-record', 'unverified'], 'its record’s own status: pending review');
  });
}

/* ---------- the browser: Find Fit and the Search page ---------- */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const hits = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  hits.push(url.pathname);
  const asJson = () => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); return res; };
  };
  if (url.pathname === '/api/size-recommendation') {
    req.query = Object.fromEntries(url.searchParams);
    asJson();
    try { await sizingHandler(req, res); } catch (err) { console.error('sizing threw', err && err.message); if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
    return undefined;
  }
  if (url.pathname === '/api/search') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (err) { req.body = {}; }
    asJson();
    try { await quietly(() => searchHandler(req, res)); } catch (err) { console.error('search threw', err && err.message); if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
    return undefined;
  }
  if (url.pathname.startsWith('/api/')) {
    /* signed out, and no model to read the request: the page parses it itself */
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = url.pathname === '/api/account' ? 401 : 503;
    return res.end('{"error":"not here"}');
  }
  const file = path.join(REPO, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  return res.end(fs.readFileSync(file));
});

async function browserTests() {
  let chromium;
  try {
    chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
  } catch (err) {
    console.log('\nPlaywright is not available here — skipping the browser half.');
    return;
  }
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  } catch (err) {
    console.log('\nChromium could not launch here — skipping the browser half.');
    server.close();
    return;
  }

  async function openPage(file) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.setDefaultTimeout(8000);
    await context.addInitScript((origin) => {
      window.FINDWEAR_API = `${origin}/api/interpret`;
      window.FINDWEAR_SEARCH_API = `${origin}/api/search`;
    }, ORIGIN);
    await context.route((u) => !String(u).startsWith(ORIGIN), (route) => route.abort());
    const page = await context.newPage();
    page.on('pageerror', (err) => console.log(`      [page error] ${err && err.message}`));
    await page.goto(`${ORIGIN}/${file}`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  try {
    console.log('\nin the browser, with no product source');

    await test('Find Fit with no product source: the item is entered by hand from its own chart — no product list, no search box, and nothing asks a product source', async () => {
      hits.length = 0;
      requested.length = 0;
      const page = await openPage('index.html');
      await page.waitForSelector('#ffc-form');
      assert.strictEqual(await page.$('#fit-browser, #fit-url, #fit-live'), null, 'no list, link box or live search');
      await page.fill('#ffc-size', 'M');
      await page.fill('#ffc-m-chestWidth', '56');
      await page.selectOption('#ffc-how-chestWidth', 'flat-width-armpit-to-armpit');
      await page.waitForTimeout(300);
      assert.ok(!hits.includes('/api/search'), `pages asked: ${hits.join(' ')}`);
      assert.deepStrictEqual(requested, []);
      await page.context().close();
    });

    await test('Search page: the 503 is shown as Fynd’s sample items, said to be so above them, and OpenWeb Ninja is asked nothing', async () => {
      hits.length = 0;
      requested.length = 0;
      const page = await openPage('find-clothes.html');
      await page.fill('#ask', 'black hoodie');
      await page.press('#ask', 'Enter');
      await page.waitForSelector('#results .notice');
      assert.ok(hits.includes('/api/search'), 'the search was asked');
      assert.match(await page.textContent('#results'), /No product source is connected yet, so these are Fynd’s sample items rather than real listings\./);
      /* the demo catalogue's rows: each either links to its own listing
         or is marked Sample on the card, with the note above the grid */
      const cards = await page.$$eval('#results .item-card', (cs) => cs.map((c) => ({ links: Boolean(c.querySelector('a.item-link[href^="https://"]')), badge: Boolean(c.querySelector('.item-badge')) })));
      assert.ok(cards.length > 0, 'the sample catalogue stands in');
      assert.ok(cards.every((c) => c.links || c.badge), JSON.stringify(cards));
      if (cards.some((c) => c.badge)) assert.strictEqual(await page.isVisible('#results .sample-note'), true);
      assert.deepStrictEqual(requested, []);
      await page.context().close();
    });
  } finally {
    await browser.close();
    server.close();
  }
}

(async () => {
  await nodeTests();
  await browserTests();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
