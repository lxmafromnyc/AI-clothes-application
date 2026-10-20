#!/usr/bin/env node
/* =========================================================
   Fynd — the live UNIQLO US search, offline

   Find Fit's "Search all of UNIQLO US" (api/_catalog/live.js, through
   /api/search with scope "uniqlo-us"): the route's own search, cache,
   verification gate and allowance, answered with UNIQLO US product
   pages only, each once, by its own product code.

   OpenWeb Ninja is stubbed at the network, in the response shape the
   adapter reads. One record is the shape of a genuine result a recorded
   Fynd session got back (assets/demo/demo-search.json, 3 October 2026:
   E491096-000); every other code from E960001 and every "FIXTURE" name
   is invented. Nothing here reaches the network.

   Usage: node scripts/test-catalog-live.js
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.OPENWEBNINJA_API_KEY = 'test-live-key-123';
delete process.env.PRODUCT_SOURCE;
process.env.FYND_CACHE = 'off';

const live = require('../api/_catalog/live');
const adapter = require('../api/_catalog/sources/uniqlo-us');
const cache = require('../api/_cache');
const meter = require('../api/_meter');
const handler = require('../api/search');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { cache.reset(); await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n        ') : err}`); }
}

const thumb = (n) => `https://encrypted-tbn${n}.gstatic.com/shopping?q=tbn:FIXTURE${n}`;
/* a search record carrying its own offer, as the adapter reads one */
const record = (id, title, url, price, store, photo) => ({
  product_id: id,
  product_title: title,
  product_photos: [photo || thumb(2)],
  offer: { offer_page_url: url, price: `$${price}`, store_name: store }
});
const UQ = (code, extra) => `https://www.uniqlo.com/us/en/products/${code}/00${extra || ''}`;
const RESULTS = [
  /* the shape of the genuine recorded result */
  record('g1', "UNIQLO Men's Zip-Up Blouson Jacket", `${UQ('E491096-000')}?colorDisplayCode=57&sizeDisplayCode=005&srsltid=AU7gw4V`, '49.90', 'Uniqlo'),
  record('f1', 'FIXTURE UNIQLO Sweat Oversized Hoodie', `${UQ('E960001-000')}?colorDisplayCode=09`, '39.90', 'uniqlo.com', thumb(3)),
  /* the same product in another colour: one card */
  record('f2', 'FIXTURE UNIQLO Sweat Oversized Hoodie, Gray', `${UQ('E960001-000')}?colorDisplayCode=03`, '39.90', 'uniqlo.com'),
  /* a product Fynd already lists: Fynd's own name and sizing holds */
  record('f3', 'FIXTURE retailer title for a listed product', UQ('E475378-000'), '39.90', 'uniqlo.com'),
  /* not a UNIQLO US product page, each for one reason */
  record('x1', 'FIXTURE UNIQLO search page', 'https://www.uniqlo.com/us/en/search?q=hoodie', '19.90', 'uniqlo.com'),
  record('x2', 'FIXTURE UNIQLO UK Hoodie', 'https://www.uniqlo.com/uk/en/products/E960002-000/00', '29.90', 'uniqlo.com'),
  record('x3', 'FIXTURE Hoodie on Another Shop', 'https://www.othershop.example/p/123', '25.00', 'othershop.example'),
  record('x4', 'FIXTURE UNIQLO hoodie resold', 'https://reseller.example/uniqlo/us/en/products/E960003-000/00', '25.00', 'reseller.example'),
  /* a UNIQLO product whose photo is on neither allowed host: kept, with no photo */
  record('f4', 'FIXTURE UNIQLO Wide Pants', UQ('E960004-000'), '29.90', 'uniqlo.com', 'https://tracker.example/pixel.png')
];

/* the network, as OpenWeb Ninja would answer; every call recorded */
function stubNetwork(answer) {
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: (options && options.headers) || {} });
    const status = typeof answer === 'number' ? answer : 200;
    const body = typeof answer === 'number' ? {} : { status: 'OK', request_id: 'r', data: answer };
    return { ok: status === 200, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return calls;
}

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.getHeader = (k) => res.headers[k];
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
}
const post = async (body, ip) => {
  const res = fakeRes();
  await handler({ method: 'POST', url: '/api/search', headers: { host: 'fynd.test', 'x-forwarded-for': ip || '198.51.100.7' }, body, socket: { remoteAddress: '203.0.113.9' }, on: () => {} }, res);
  return res;
};

(async () => {
  console.log('\nthe query');

  await test('the shopper’s words become the search, with UNIQLO named as the brand — capped, and nothing to search for is no search', () => {
    assert.deepStrictEqual(live.searchBody({ q: '  black   oversized hoodie ' }, 24), { q: 'black oversized hoodie', body: { intent: { brands: ['UNIQLO'], keywords: ['black', 'oversized', 'hoodie'] }, limit: 24 } });
    assert.strictEqual(live.searchBody({ q: 'UNIQLO hoodie' }, 24).q, 'hoodie', 'the brand is named once, by Fynd');
    assert.strictEqual(live.searchBody({ q: 'one two three four five six seven eight nine ten' }, 24).body.intent.keywords.length, 8);
    for (const q of ['', '   ', 'uniqlo', '<>', null, 42, ['hoodie']]) assert.strictEqual(live.searchBody({ q }, 24), null, JSON.stringify(q));
    assert.strictEqual(live.searchBody({ q: 'x'.repeat(500) }, 24).q.length, 120);
    assert.strictEqual(live.searchBody({ q: '<script>alert(1)</script> hoodie' }, 24).q, 'scriptalert1script hoodie', 'markup is reduced to its letters, and sent only as search words');
  });

  console.log('\nwhat is kept');

  await test('only UNIQLO US product pages are kept, once each, rebuilt as the product’s canonical page by its own code', () => {
    const products = RESULTS.map((r) => ({ name: r.product_title, price: Number(r.offer.price.slice(1)), currency: 'USD', imageUrl: r.product_photos[0], productUrl: r.offer.offer_page_url, retailer: r.offer.store_name }));
    const listed = (code) => (code === 'E475378-000' ? { name: 'Sweat Pullover Hoodie', holds: 'checked-chart', holdsText: 'Fynd has this product’s chart, checked' } : null);
    const out = live.cards(products, adapter, listed);
    assert.deepStrictEqual(out.products.map((p) => [p.code, p.url]), [
      ['E491096-000', 'https://www.uniqlo.com/us/en/products/E491096-000/00'],
      ['E960001-000', 'https://www.uniqlo.com/us/en/products/E960001-000/00'],
      ['E475378-000', 'https://www.uniqlo.com/us/en/products/E475378-000/00'],
      ['E960004-000', 'https://www.uniqlo.com/us/en/products/E960004-000/00']
    ]);
    assert.deepStrictEqual(out.dropped, { 'same-product-twice': 1, 'not-a-uniqlo-us-product-page': 4 });
    const [blouson, hoodie, known, pants] = out.products;
    assert.deepStrictEqual([blouson.name, blouson.price, blouson.colourCode, blouson.listed, blouson.holds], ["UNIQLO Men's Zip-Up Blouson Jacket", { currency: 'USD', amount: 4990, was: null }, '57', false, 'live-only']);
    assert.strictEqual(hoodie.imageUrl, thumb(3), 'the first record’s photo: the source’s own thumbnail');
    assert.deepStrictEqual([known.name, known.listed, known.holds], ['Sweat Pullover Hoodie', true, 'checked-chart'], 'a listed product keeps Fynd’s name and sizing holds');
    assert.strictEqual(pants.imageUrl, null, 'a photo off both allowed hosts is dropped, the product kept');
    assert.deepStrictEqual(out.missing, { image: 1, price: 0, colours: 4, sizes: 4 }, 'what the source didn’t carry is counted, never filled in');
    assert.ok(out.products.every((p) => !('sizes' in p) && !('measurements' in p) && !('colours' in p)));
  });

  console.log('\n/api/search, scope uniqlo-us');

  await test('a scoped search asks the product source for "uniqlo <words>" in the US market, and answers with UNIQLO US products only — and their counts', async () => {
    const calls = stubNetwork(RESULTS);
    const res = await post({ scope: 'uniqlo-us', q: 'black oversized hoodie' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const searched = new URL(calls[0].url);
    assert.deepStrictEqual([searched.searchParams.get('q'), searched.searchParams.get('country')], ['uniqlo black oversized hoodie', 'us']);
    assert.strictEqual(calls[0].headers['x-api-key'], 'test-live-key-123', 'the key goes to the product source as a header, as for every search');
    const b = res.body;
    assert.deepStrictEqual([b.scope, b.live, b.query, b.source], ['uniqlo-us', true, 'black oversized hoodie', 'openwebninja']);
    assert.deepStrictEqual(b.products.map((p) => p.code), ['E491096-000', 'E960001-000', 'E475378-000', 'E960004-000']);
    assert.deepStrictEqual([b.returned, b.verified, b.kept], [9, 9, 4], 'nine records, all through the gate; four of them UNIQLO US products');
    assert.deepStrictEqual(b.dropped, { 'same-product-twice': 1, 'not-a-uniqlo-us-product-page': 4 }, JSON.stringify(b.dropped));
    assert.deepStrictEqual(b.missing, { image: 1, price: 0, colours: 4, sizes: 4 }, 'the tracker photo passed the gate but isn’t on an image host Find Fit shows');
    assert.ok(!JSON.stringify(b).includes('test-live-key-123'), 'the key is never in the answer');
    assert.ok(b.usage && Number.isInteger(b.usage.used), 'the allowance moves on screen');
    assert.ok(!('diagnostics' in b) && !('records' in b), 'nothing of the provider’s raw answer is passed on');
  });

  await test('a scoped search is one metered search; nothing to search for, or a source that fails, costs the shopper nothing', async () => {
    const real = meter.spend;
    const spends = [];
    meter.spend = async (identity, metric, amount) => { spends.push(amount); return real(identity, metric, amount); };
    try {
      let calls = stubNetwork(RESULTS);
      assert.strictEqual((await post({ scope: 'uniqlo-us', q: 'hoodie' }, '198.51.100.21')).statusCode, 200);
      assert.deepStrictEqual(spends, [1]);
      calls = stubNetwork(RESULTS);
      const empty = await post({ scope: 'uniqlo-us', q: '   ' }, '198.51.100.21');
      assert.deepStrictEqual([empty.statusCode, empty.body.reason, calls.length, spends.length], [400, 'empty-query', 0, 1]);
      stubNetwork(500);
      const failed = await post({ scope: 'uniqlo-us', q: 'hoodie' }, '198.51.100.21');
      assert.deepStrictEqual([failed.statusCode, spends.length], [502, 1]);
    } finally { meter.spend = real; }
  });

  await test('with no product source configured, a scoped search says so — and nothing is invented in its place', async () => {
    const key = process.env.OPENWEBNINJA_API_KEY;
    delete process.env.OPENWEBNINJA_API_KEY;
    try {
      const calls = stubNetwork(RESULTS);
      const res = await post({ scope: 'uniqlo-us', q: 'hoodie' });
      assert.deepStrictEqual([res.statusCode, res.body.source, calls.length], [503, null, 0]);
      assert.ok(!('products' in res.body));
    } finally { process.env.OPENWEBNINJA_API_KEY = key; }
  });

  await test('a live search never reads a shop’s own pages: under a source with an organic path it is refused, and an exhausted source never falls back to one', async () => {
    process.env.SERPER_API_KEY = 'serper-test-key';
    process.env.PRODUCT_SOURCE = 'serper';
    try {
      const calls = stubNetwork(RESULTS);
      const res = await post({ scope: 'uniqlo-us', q: 'hoodie' }, '198.51.100.31');
      assert.deepStrictEqual([res.statusCode, res.body.reason, calls.length], [503, 'unsupported-source', 0], 'refused before anything is asked');
    } finally { delete process.env.PRODUCT_SOURCE; }
    try {
      /* OpenWeb Ninja out of searches: the Search page would fall back to Serper; a live UNIQLO search doesn't */
      const calls = stubNetwork(429);
      const res = await post({ scope: 'uniqlo-us', q: 'hoodie' }, '198.51.100.32');
      assert.strictEqual(res.statusCode, 502);
      assert.ok(calls.every((c) => /openwebninja/.test(c.url)), `only OpenWeb Ninja was asked: ${calls.map((c) => new URL(c.url).hostname).join(' ')}`);
    } finally { delete process.env.SERPER_API_KEY; }
  });

  await test('a source that answers with no UNIQLO US product is an honest empty answer, with what it did return counted', async () => {
    stubNetwork([RESULTS[6], RESULTS[4]]);
    const res = await post({ scope: 'uniqlo-us', q: 'tuxedo' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual([res.body.products, res.body.returned, res.body.kept, res.body.dropped['not-a-uniqlo-us-product-page']], [[], 2, 0, 2]);
  });

  await test('an unscoped search is exactly what it was: every retailer, the full answer', async () => {
    stubNetwork(RESULTS);
    const res = await post({ intent: { categories: ['hoodie'], keywords: [] }, limit: 12 });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!('scope' in res.body) && Array.isArray(res.body.products) && 'diagnostics' in res.body);
    assert.ok(res.body.products.some((p) => /othershop\.example/.test(p.productUrl)), 'other shops are still searched on the Search page');
  });

  await test('a live result is never added to Fynd’s list or catalogue: the brand module still lists the same products after a search', async () => {
    const uniqlo = require('../api/_sizing/brands').get('uniqlo');
    const before = uniqlo.products().map((p) => p.code);
    stubNetwork(RESULTS);
    await post({ scope: 'uniqlo-us', q: 'jacket' });
    assert.deepStrictEqual(uniqlo.products().map((p) => p.code), before);
    assert.strictEqual(uniqlo.find('E491096-000'), null, 'found live, not listed: its product page isn’t Fynd’s to claim');
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
