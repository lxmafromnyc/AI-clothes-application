#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue feed tests

   The authorized-catalogue path end to end, offline: a feed read row by
   row (api/_catalog/import.js), synced into the catalogue
   (api/_catalog/sync.js, scripts/sync-catalog.js), fetched from an API
   only where a host is authorized (api/_catalog/fetch.js), loaded back
   and checked again (api/_catalog/store.js), searched and paged
   (api/_catalog/search.js), and served by Find Fit's UNIQLO module and
   /api/size-recommendation — each product matched to Fynd's sizing by
   its exact code.

   The feeds are FIXTURES (scripts/fixtures/catalog-feed): every code
   from E910001 / E920001 and every "FIXTURE" name is invented. They are
   marked as fixtures, and the tests prove the customer-facing path
   refuses them. No network is touched: every fetch is a stand-in.

   Usage: node scripts/test-catalog-feed.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures/catalog-feed');
const FEED_V1 = path.join(FIXTURES, 'uniqlo-feed-v1.json');
const FEED_ROWS = path.join(FIXTURES, 'uniqlo-feed-rows.jsonl');
const ALL = ['images', 'colours', 'sizes', 'price', 'stock'];

const adapter = require('../api/_catalog/sources/uniqlo-us');
const { read, FeedError, LIMITS } = require('../api/_catalog/import');
const { sync } = require('../api/_catalog/sync');
const { fetchFeed } = require('../api/_catalog/fetch');
const store = require('../api/_catalog/store');
const { createIndex, words, readQuery } = require('../api/_catalog/search');
const product = require('../api/_catalog/product');
const cli = require('./sync-catalog');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err}`); }
}
const section = (name) => console.log(`\n${name}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-catalog-'));
const feedText = fs.readFileSync(FEED_V1, 'utf8');
const feedJson = () => JSON.parse(feedText);
const NOW = '2026-10-20T07:00:00.000Z';
const at = (iso, hours) => new Date(Date.parse(iso) + hours * 3600 * 1000).toISOString();
/* a feed from a list of rows, in the Fynd format */
const feedOf = (products, extra) => JSON.stringify(Object.assign({ format: 'fynd-catalog-feed', version: 1, source: { name: 'TEST feed' }, generatedAt: NOW, complete: true, products }, extra || {}));
const row = (n, extra) => Object.assign({ id: `E${930000 + n}-000`, name: `FIXTURE Product ${n}`, url: `https://www.uniqlo.com/us/en/products/E${930000 + n}-000/00`, category: 'Men > Tops > T-Shirts', gender: 'men' }, extra || {});
/* an adapter with an authorized host, for the fetch tests only */
const authorized = Object.assign({}, adapter, { FEED_HOSTS: ['feed.uniqlo.test'] });

/* the brand module and the endpoint, in a process of their own, with the
   catalogue a test names (or none) */
function inChild(env, code) {
  const out = execFileSync(process.execPath, ['-e', `(async () => { ${code} })().then((v) => process.stdout.write(JSON.stringify(v)), (e) => { console.error(e); process.exit(1); });`], {
    cwd: REPO,
    env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS || '', FYND_OFFLINE_LOG: process.env.FYND_OFFLINE_LOG || '' }, env),
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString();
  return JSON.parse(out);
}

(async () => {
  section('reading a feed');

  await test('a Fynd catalogue feed is read row by row: categories and lines mapped by UNIQLO’s own words, licensed fields kept, a duplicate and a discontinued row set aside', () => {
    const r = read(feedText, adapter, { licensed: ALL });
    assert.strictEqual(r.header.format, 'fynd-catalog-feed/1');
    assert.strictEqual(r.header.complete, true);
    assert.strictEqual(r.header.fixture, true, 'the fixture says it is one');
    assert.deepStrictEqual(r.header.licensed, ['colours', 'images', 'price', 'sizes', 'stock']);
    assert.strictEqual(r.products.length, 26);
    assert.deepStrictEqual(r.duplicates, ['E910001-000']);
    assert.deepStrictEqual(r.discontinued, ['E910106-000']);
    const by = Object.fromEntries(r.products.map((p) => [p.code, p]));
    assert.deepStrictEqual([by['E910001-000'].category, by['E910001-000'].line], ['sweatshirts-hoodies', 'men']);
    assert.deepStrictEqual([by['E910006-000'].category, by['E910006-000'].line], ['tshirts', 'women'], '"Short-Sleeve T-Shirt" is a T-shirt, not shorts');
    assert.deepStrictEqual([by['E910015-000'].category, by['E910017-000'].category, by['E910018-000'].category], ['shorts', 'outerwear', 'dresses-skirts']);
    assert.deepStrictEqual([by['E910019-000'].line, by['E910023-000'].line], ['kids', 'unisex']);
    assert.strictEqual(by['E910001-000'].url, 'https://www.uniqlo.com/us/en/products/E910001-000/00');
    assert.strictEqual(by['E471808-000'].url, 'https://www.uniqlo.com/us/en/products/E471808-000/00', 'a colour page is rebuilt as the product’s canonical page');
    assert.deepStrictEqual(by['E910001-000'].price, { currency: 'USD', amount: 4990, was: 5990 });
    assert.deepStrictEqual(by['E910001-000'].colours.map((c) => c.name), ['Black', 'Gray', 'Olive']);
    assert.deepStrictEqual(by['E910019-000'].sizes, ['110', '120', '130', '140', '150']);
    assert.ok(!('measurements' in by['E910001-000']) && Object.keys(by['E910001-000']).every((k) => ['code', 'name', 'url', 'category', 'line', 'images', 'colours', 'sizes', 'price', 'availability', 'variants'].includes(k)), 'nothing but the catalogue’s own fields');
  });

  await test('product-feed rows are grouped into one product by its exact ID: colours, sizes, the lowest price with what it was, and stock per colour and size', () => {
    const r = read(fs.readFileSync(FEED_ROWS, 'utf8'), adapter, { licensed: ALL });
    assert.strictEqual(r.header.format, 'product-feed-rows');
    assert.strictEqual(r.header.complete, false, 'a file with no header removes nothing unless the operator says it is complete');
    assert.deepStrictEqual(r.products.map((p) => p.code), ['E920001-000', 'E920002-000', 'E920003-000']);
    assert.deepStrictEqual(r.discontinued, ['E920004-000']);
    assert.deepStrictEqual(r.rejected.map((x) => x.error), ['item_group_id (or id) is not the brand’s exact product ID']);
    const hoodie = r.products[0];
    assert.deepStrictEqual(hoodie.colours.map((c) => [c.code, c.name]), [['09', 'Black'], ['03', 'Gray']]);
    assert.deepStrictEqual(hoodie.sizes, ['S', 'M', 'L']);
    assert.deepStrictEqual(hoodie.price, { currency: 'USD', amount: 3990, was: 4990 });
    assert.strictEqual(hoodie.variants.length, 6);
    assert.deepStrictEqual(hoodie.variants.find((v) => v.colour === '09' && v.size === 'S'), { colour: '09', size: 'S', availability: 'out_of_stock' });
    assert.strictEqual(hoodie.url, 'https://www.uniqlo.com/us/en/products/E920001-000/00', 'the link’s colour and size query is not part of the product’s identity');
    assert.deepStrictEqual([r.products[1].category, r.products[1].line, r.products[2].category, r.products[2].line], ['shirts', 'women', 'outerwear', 'kids']);
    const complete = read(fs.readFileSync(FEED_ROWS, 'utf8'), adapter, { licensed: ALL, complete: true });
    assert.strictEqual(complete.header.complete, true);
  });

  await test('only licensed fields are kept: with no licence recorded, price, stock, sizes, colours and photos are dropped — and a feed can only narrow the operator’s licence, never widen it', () => {
    const none = read(feedText, adapter, { licensed: [] });
    none.products.forEach((p) => assert.deepStrictEqual(Object.keys(p).sort(), ['category', 'code', 'line', 'name', 'url']));
    assert.deepStrictEqual(adapter.LICENSED, [], 'no licence is recorded in the source today');
    const priceOnly = read(feedText, adapter, { licensed: ['price'] });
    assert.ok(priceOnly.products.every((p) => !p.images && !p.colours && !p.sizes && !p.availability && !p.variants));
    assert.ok(priceOnly.products.some((p) => p.price));
    const narrowed = feedJson();
    narrowed.source.licensedFields = ['sizes'];
    const r = read(JSON.stringify(narrowed), adapter, { licensed: ALL });
    assert.deepStrictEqual(r.header.licensed, ['sizes']);
    assert.ok(r.products.every((p) => !p.price && !p.colours));
    const widened = feedJson();
    widened.source.licensedFields = ALL;
    assert.deepStrictEqual(read(JSON.stringify(widened), adapter, { licensed: ['images'] }).header.licensed, ['images']);
    assert.deepStrictEqual(read(feedText, adapter, { licensed: ['price', 'measurements', 'reviews'] }).header.licensed, ['price'], 'only fields Fynd knows how to hold');
  });

  await test('a product is listed once: a repeated ID keeps the first row; repeated variants are folded; distinct products may share a name', () => {
    const r = read(feedOf([row(1), row(1, { name: 'FIXTURE Product 1 again' }), row(2, { name: 'FIXTURE Product 1' })]), adapter, {});
    assert.deepStrictEqual(r.products.map((p) => [p.code, p.name]), [['E930001-000', 'FIXTURE Product 1'], ['E930002-000', 'FIXTURE Product 1']]);
    assert.deepStrictEqual(r.duplicates, ['E930001-000']);
    const v = read(feedOf([row(3, { colours: [{ code: '09', name: 'Black' }, { code: '09', name: 'Black again' }], sizes: ['M', 'M', 'S'], variants: [{ colour: '09', size: 'M', availability: 'in_stock' }, { colour: '09', size: 'M', availability: 'out_of_stock' }] })]), adapter, { licensed: ALL });
    assert.deepStrictEqual(v.products[0].colours.map((c) => c.name), ['Black']);
    assert.deepStrictEqual(v.products[0].sizes, ['S', 'M']);
    assert.deepStrictEqual(v.products[0].variants, [{ colour: '09', size: 'M', availability: 'in_stock' }]);
  });

  await test('URLs are checked, not trusted: only https on www.uniqlo.com, the product’s own page with its own ID; photos only on image.uniqlo.com and only the product’s own', () => {
    const bad = {
      'off-site': 'https://uniqlo.example/us/en/products/E930001-000/00',
      'http': 'http://www.uniqlo.com/us/en/products/E930001-000/00',
      'credentials': 'https://user:pass@www.uniqlo.com/us/en/products/E930001-000/00',
      'port': 'https://www.uniqlo.com:8443/us/en/products/E930001-000/00',
      'fragment': 'https://www.uniqlo.com/us/en/products/E930001-000/00#x',
      'another product': 'https://www.uniqlo.com/us/en/products/E930002-000/00',
      'another market': 'https://www.uniqlo.com/uk/en/products/E930001-000/00',
      'script': 'javascript:alert(1)',
      'quote': 'https://www.uniqlo.com/us/en/products/E930001-000/00"onmouseover="x',
      'not a page': 'https://www.uniqlo.com/us/en/search?q=E930001-000'
    };
    Object.entries(bad).forEach(([why, url]) => {
      const r = read(feedOf([row(1, { url })]), adapter, {});
      assert.strictEqual(r.products.length, 0, why);
      assert.match(r.rejected[0].error, /no product page on the brand’s own site/, why);
    });
    const ok = read(feedOf([row(1, { url: 'https://www.uniqlo.com/us/en/products/E930001-000/09?colorDisplayCode=09' })]), adapter, {});
    assert.strictEqual(ok.products[0].url, 'https://www.uniqlo.com/us/en/products/E930001-000/00');
    const photos = read(feedOf([row(1, { images: [
      'https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/930001/item/goods_09_930001_3x4.jpg',
      'https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/475378/item/goods_09_475378_3x4.jpg',
      'https://tracker.example/930001/pixel.gif',
      'http://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/930001/item/goods_00_930001_3x4.jpg',
      'data:image/svg+xml,<svg onload=alert(1)>'
    ] })]), adapter, { licensed: ['images'] });
    assert.deepStrictEqual(photos.products[0].images, ['https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/930001/item/goods_09_930001_3x4.jpg']);
    assert.ok(photos.notes.some((n) => /image off the brand’s image host/.test(n)));
  });

  await test('untrusted text never becomes markup or code: names with markup or control characters are refused, nothing in the feed reaches an object’s prototype, and IDs must be exact', () => {
    for (const name of ['<img src=x onerror=alert(1)>', 'FIXTURE\u0000Null', 'FIXTURE `template`', 'x'.repeat(161), '', '   ', 42.5 === 0 ? '' : { toString: () => 'x' }]) {
      const r = read(feedOf([row(1, { name })]), adapter, {});
      assert.strictEqual(r.products.length, 0, JSON.stringify(name));
    }
    for (const id of ['e930001-000', 'E930001', 'E930001-0000', ' E930001-000x', '../E930001-000', 'E930001-000<']) {
      assert.strictEqual(read(feedOf([row(1, { id })]), adapter, {}).products.length, 0, id);
    }
    const polluted = `{"format":"fynd-catalog-feed","version":1,"complete":true,"products":[{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"id":"E930001-000","name":"FIXTURE ok","url":"https://www.uniqlo.com/us/en/products/E930001-000/00","category":"T-Shirts","gender":"men"}]}`;
    const r = read(polluted, adapter, {});
    assert.strictEqual(r.products.length, 1);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
    const priced = read(feedOf([row(1, { price: '1e3' }), row(2, { price: -5 }), row(3, { price: '39.90 EUR' }), row(4, { price: { amount: 29.9, currency: 'USD' } })]), adapter, { licensed: ['price'] });
    assert.deepStrictEqual(priced.products.map((p) => p.price || null), [null, null, null, { currency: 'USD', amount: 2990, was: null }]);
  });

  await test('a feed that isn’t one is refused whole, with the reason: not JSON, an unknown format or version, too large, too many products', () => {
    const reason = (body) => { try { read(body, adapter, {}); return 'read'; } catch (err) { assert.ok(err instanceof FeedError); return err.reason; } };
    assert.strictEqual(reason(''), 'empty');
    assert.strictEqual(reason('{"format":'), 'bad-json');
    assert.strictEqual(reason('{"a":1}\nnot json'), 'bad-json');
    assert.strictEqual(reason('{"format":"something-else","products":[]}'), 'unknown-format');
    assert.strictEqual(reason('{"format":"fynd-catalog-feed","version":2,"products":[]}'), 'unknown-version');
    assert.strictEqual(reason('{"format":"fynd-catalog-feed","version":1}'), 'no-products');
    assert.strictEqual(reason('<html>Access denied</html>'), 'bad-json');
    assert.strictEqual(reason(' '.repeat(10) + 'x'.repeat(LIMITS.bytes)), 'too-large');
    assert.strictEqual(reason(feedOf(new Array(LIMITS.products + 1).fill(0))), 'too-many-products');
  });

  section('syncing the catalogue');

  const first = () => sync(null, read(feedText, adapter, { licensed: ALL }), adapter, { now: NOW, allowFixture: true });

  await test('a first sync adds every valid product, records when it succeeded, and keeps the licence and source it was read under', () => {
    const s = first();
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.catalog.products.length, 26);
    assert.strictEqual(s.catalog.lastSuccessfulSync, NOW);
    assert.deepStrictEqual([s.report.added, s.report.updated, s.report.unchanged, s.report.rejected, s.report.duplicateCount], [26, 0, 0, 2, 1]);
    assert.strictEqual(s.catalog.fixture, true);
    assert.deepStrictEqual(s.catalog.licensed, ['colours', 'images', 'price', 'sizes', 'stock']);
    assert.strictEqual(new Set(s.catalog.products.map((p) => p.code)).size, 26, 'no product twice');
    assert.ok(s.catalog.products.every((p) => p.firstSeenAt === NOW && p.lastSeenAt === NOW));
  });

  await test('a fixture feed is refused unless fixtures are allowed by name', () => {
    const s = sync(null, read(feedText, adapter, { licensed: ALL }), adapter, { now: NOW });
    assert.deepStrictEqual([s.ok, s.reason], [false, 'fixture']);
  });

  await test('the next sync updates what changed and leaves the rest; a complete feed removes what it no longer lists, and a discontinued product goes with its reason', () => {
    const prev = first().catalog;
    const later = at(NOW, 24);
    const next = feedJson();
    next.generatedAt = later;
    next.products = next.products.filter((p) => p.id !== 'E910024-000');
    next.products.find((p) => p.id === 'E910005-000').price = '12.90';
    next.products.find((p) => p.id === 'E910002-000').status = 'discontinued';
    const s = sync(prev, read(JSON.stringify(next), adapter, { licensed: ALL }), adapter, { now: later, allowFixture: true });
    assert.strictEqual(s.ok, true, s.error);
    const codes = s.catalog.products.map((p) => p.code);
    assert.ok(!codes.includes('E910024-000') && !codes.includes('E910002-000'));
    assert.deepStrictEqual(s.report.removed, { discontinued: 1, 'absent-from-complete-feed': 1 });
    assert.strictEqual(s.report.updated, 1);
    assert.strictEqual(s.report.unchanged, 23);
    assert.strictEqual(s.catalog.products.find((p) => p.code === 'E910005-000').price.amount, 1290);
    assert.strictEqual(s.catalog.products.find((p) => p.code === 'E910001-000').firstSeenAt, NOW, 'first seen stays when it was');
    assert.deepStrictEqual(s.catalog.removed.map((r) => [r.code, r.reason]).sort(), [['E910002-000', 'discontinued'], ['E910024-000', 'absent-from-complete-feed']]);
    /* back in a later feed: listed again, and out of the removed list */
    const again = feedJson();
    again.generatedAt = at(NOW, 48);
    const back = sync(s.catalog, read(JSON.stringify(again), adapter, { licensed: ALL }), adapter, { now: at(NOW, 48), allowFixture: true });
    assert.ok(back.catalog.products.some((p) => p.code === 'E910024-000'));
    assert.ok(!back.catalog.removed.some((r) => r.code === 'E910024-000'));
  });

  await test('a partial feed removes nothing it doesn’t mention — but last sync’s prices and stock aren’t carried as current, and a product unseen for 30 days goes', () => {
    const prev = first().catalog;
    const partial = read(feedOf([row(1)], { complete: false, generatedAt: at(NOW, 24) }), adapter, { licensed: ALL });
    const s = sync(prev, partial, adapter, { now: at(NOW, 24), allowFixture: true });
    assert.strictEqual(s.ok, true, s.error);
    assert.strictEqual(s.catalog.products.length, 27);
    const kept = s.catalog.products.find((p) => p.code === 'E910001-000');
    assert.ok(!kept.price && !kept.variants && !kept.availability, 'no stale price or stock');
    assert.ok(kept.colours && kept.sizes, 'the rest of what it was is kept');
    const month = sync(s.catalog, read(feedOf([row(1)], { complete: false, generatedAt: at(NOW, 24 * 32) }), adapter, { licensed: ALL }), adapter, { now: at(NOW, 24 * 32), allowFixture: true });
    assert.deepStrictEqual(month.catalog.products.map((p) => p.code), ['E930001-000']);
    assert.strictEqual(month.report.removed['not-seen-in-30-days'], 26);
  });

  await test('a complete feed that would remove most of the catalogue is refused as a likely truncated download — unless it is said to be real', () => {
    const prev = first().catalog;
    const tiny = read(feedOf([row(1)], { generatedAt: at(NOW, 1), fixture: true }), adapter, { licensed: ALL });
    const s = sync(prev, tiny, adapter, { now: at(NOW, 1), allowFixture: true });
    assert.deepStrictEqual([s.ok, s.reason], [false, 'mass-removal']);
    const forced = sync(prev, tiny, adapter, { now: at(NOW, 1), allowFixture: true, allowMassRemoval: true });
    assert.deepStrictEqual([forced.ok, forced.catalog.products.length], [true, 1]);
  });

  await test('the sync refuses, and keeps the catalogue as it was, for an empty feed, one mostly rejected, or one older than the catalogue', () => {
    const prev = first().catalog;
    assert.strictEqual(sync(prev, read(feedOf([row(1, { url: 'x' })], { generatedAt: at(NOW, 1) }), adapter, {}), adapter, { now: at(NOW, 1) }).reason, 'empty');
    const mostlyBad = [row(1), row(2), row(3, { url: 'https://evil.example/' }), row(4, { name: '<b>' })];
    assert.strictEqual(sync(prev, read(feedOf(mostlyBad, { generatedAt: at(NOW, 1) }), adapter, {}), adapter, { now: at(NOW, 1) }).reason, 'too-many-rejected');
    assert.strictEqual(sync(prev, read(feedOf([row(1)], { generatedAt: at(NOW, -5) }), adapter, {}), adapter, { now: at(NOW, 1) }).reason, 'older-feed', 'the catalogue was built from a feed generated at 06:00');
  });

  await test('a narrower licence on a later sync strips what it no longer covers from every product kept', () => {
    const prev = first().catalog;
    const partial = feedOf([row(1)], { complete: false, generatedAt: at(NOW, 1), source: { name: 'TEST', licensedFields: ['sizes'] } });
    const s = sync(prev, read(partial, adapter, { licensed: ALL }), adapter, { now: at(NOW, 1) });
    assert.strictEqual(s.ok, true, s.error);
    assert.ok(s.catalog.products.every((p) => !p.images && !p.colours && !p.price));
  });

  section('fetching from an authorized API');

  const headers = (h) => ({ get: (k) => h[k.toLowerCase()] || null });
  const answer = (status, body, h) => ({ status, headers: headers(Object.assign({ 'content-type': 'application/json' }, h || {})), text: async () => body });

  await test('with no host authorized for UNIQLO, nothing is fetched at all', async () => {
    let asked = 0;
    await assert.rejects(fetchFeed(adapter, { env: { UNIQLO_FEED_URL: 'https://feed.uniqlo.test/us.json', UNIQLO_FEED_TOKEN: 'secret-token-123' }, fetch: async () => { asked += 1; return answer(200, '{}'); } }), (err) => err.reason === 'host-not-allowed' && /No feed host has been authorized/.test(err.message));
    await assert.rejects(fetchFeed(adapter, { env: {}, fetch: async () => { asked += 1; } }), (err) => err.reason === 'not-configured');
    assert.strictEqual(asked, 0);
  });

  await test('an authorized host is asked over https with the credential as a bearer header; anywhere else, http, or a credential in the address is refused before connecting', async () => {
    const seen = [];
    const env = { UNIQLO_FEED_URL: 'https://feed.uniqlo.test/us.json', UNIQLO_FEED_TOKEN: 'secret-token-123' };
    const body = await fetchFeed(authorized, { env, fetch: async (url, opts) => { seen.push([url, opts.headers.Authorization, opts.redirect]); return answer(200, feedText); } });
    assert.strictEqual(body, feedText);
    assert.deepStrictEqual(seen, [['https://feed.uniqlo.test/us.json', 'Bearer secret-token-123', 'manual']]);
    for (const [url, why] of [['http://feed.uniqlo.test/us.json', 'bad-url'], ['https://feed.uniqlo.test.evil.example/us.json', 'host-not-allowed'], ['https://169.254.169.254/latest/meta-data', 'host-not-allowed'], ['https://u:p@feed.uniqlo.test/', 'bad-url'], ['not a url', 'bad-url']]) {
      await assert.rejects(fetchFeed(authorized, { env: Object.assign({}, env, { UNIQLO_FEED_URL: url }), fetch: async () => { throw new Error('should not connect'); } }), (err) => err.reason === why, url);
    }
  });

  await test('an unavailable feed is a plain failure, never a partial catalogue — and the credential never appears in what is said', async () => {
    const env = { UNIQLO_FEED_URL: 'https://feed.uniqlo.test/us.json', UNIQLO_FEED_TOKEN: 'secret-token-123' };
    const cases = [
      [async () => answer(302, '', { location: 'https://elsewhere.example/' }), 'redirect'],
      [async () => answer(401, ''), 'unauthorized'],
      [async () => answer(503, 'down'), 'bad-status'],
      [async () => answer(200, '<html>', { 'content-type': 'text/html' }), 'bad-type'],
      [async () => answer(200, '{}', { 'content-length': String(LIMITS.bytes + 1) }), 'too-large'],
      [async () => { throw new Error('getaddrinfo ENOTFOUND with secret-token-123 echoed'); }, 'unreachable'],
      [(url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), 'timeout']
    ];
    for (const [fake, reason] of cases) {
      await assert.rejects(fetchFeed(authorized, { env, fetch: fake, timeoutMs: 30 }), (err) => {
        assert.strictEqual(err.reason, reason);
        assert.ok(!err.message.includes('secret-token-123'), err.message);
        return true;
      });
    }
    /* a body that streams past the cap is stopped, not buffered */
    const chunk = new Uint8Array(1024);
    let reads = 0;
    const stream = { getReader: () => ({ read: async () => { reads += 1; return { done: false, value: chunk }; }, cancel: async () => {} }) };
    await assert.rejects(fetchFeed(authorized, { env, maxBytes: 4096, fetch: async () => ({ status: 200, headers: headers({ 'content-type': 'application/json' }), body: stream }) }), (err) => err.reason === 'too-large');
    assert.ok(reads <= 6, `stopped after ${reads} chunks`);
  });

  section('the sync command');

  const run = async (argv, env) => {
    const lines = [];
    const code = await cli.main(argv, { env: env || {}, log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)), fetch: async () => { throw new Error('offline'); } });
    return { code, out: lines.join('\n') };
  };

  await test('a file sync writes the catalogue and a status naming the last successful sync; a failed one keeps the catalogue byte for byte and records the failure', async () => {
    const out = path.join(tmp, 'cli', 'uniqlo-us.json');
    const status = path.join(tmp, 'cli', 'uniqlo-us.status.json');
    const ok = await run(['--source', 'uniqlo-us', '--file', FEED_V1, '--licensed', ALL.join(','), '--out', out, '--status', status, '--allow-fixture', '--now', NOW]);
    assert.strictEqual(ok.code, 0, ok.out);
    const written = fs.readFileSync(out, 'utf8');
    assert.strictEqual(JSON.parse(written).products.length, 26);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(status, 'utf8')), { source: 'uniqlo-us', lastAttempt: NOW, lastAttemptOk: true, reason: null, error: null, lastSuccessfulSync: NOW, products: 26 });
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, '{"format":"fynd-catalog-feed","version":1,"products":"nope"}');
    const failed = await run(['--source', 'uniqlo-us', '--file', bad, '--out', out, '--status', status, '--now', at(NOW, 1)]);
    assert.strictEqual(failed.code, 1);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), written, 'the catalogue as it was');
    const st = JSON.parse(fs.readFileSync(status, 'utf8'));
    assert.deepStrictEqual([st.lastAttemptOk, st.reason, st.lastSuccessfulSync, st.products], [false, 'no-products', NOW, 26]);
    const missing = await run(['--source', 'uniqlo-us', '--file', path.join(tmp, 'nope.json'), '--out', out, '--status', status]);
    assert.strictEqual(missing.code, 1);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), written);
  });

  await test('an API sync with no authorized host, or none configured, fails without touching the catalogue or printing the credential', async () => {
    const out = path.join(tmp, 'api', 'uniqlo-us.json');
    const status = path.join(tmp, 'api', 'status.json');
    const r = await run(['--source', 'uniqlo-us', '--api', '--out', out, '--status', status], { UNIQLO_FEED_URL: 'https://feed.uniqlo.test/us.json', UNIQLO_FEED_TOKEN: 'secret-token-123' });
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /host-not-allowed/);
    assert.ok(!r.out.includes('secret-token-123'));
    assert.ok(!fs.existsSync(out));
    assert.ok(!fs.readFileSync(status, 'utf8').includes('secret-token-123'));
    assert.strictEqual((await run(['--source', 'uniqlo-us', '--api', '--out', out, '--status', status], {})).code, 1);
  });

  await test('a fixture can never be written to the customer-facing catalogue, and a dry run writes nothing', async () => {
    const usage = await run(['--source', 'uniqlo-us', '--file', FEED_V1, '--allow-fixture']);
    assert.strictEqual(usage.code, 2);
    const dataDir = path.join(REPO, 'api/_catalog/data');
    const before = fs.readdirSync(dataDir).sort();
    const refused = await run(['--source', 'uniqlo-us', '--file', FEED_V1, '--licensed', ALL.join(','), '--dry-run']);
    assert.strictEqual(refused.code, 1);
    assert.match(refused.out, /fixture/);
    assert.deepStrictEqual(fs.readdirSync(dataDir).sort(), before, 'nothing written to api/_catalog/data');
    const out = path.join(tmp, 'dry.json');
    const dry = await run(['--source', 'uniqlo-us', '--file', FEED_ROWS, '--out', out, '--status', path.join(tmp, 'dry.status.json'), '--dry-run']);
    assert.strictEqual(dry.code, 0, dry.out);
    assert.ok(!fs.existsSync(out) && !fs.existsSync(path.join(tmp, 'dry.status.json')));
    assert.strictEqual((await run(['--source', 'nike-us', '--file', FEED_V1])).code, 2);
    assert.strictEqual((await run(['--source', 'uniqlo-us'])).code, 2);
  });

  section('loading the committed catalogue');

  const catalogFile = path.join(tmp, 'cli', 'uniqlo-us.json');
  const withCommitted = (raw) => Object.assign({}, adapter, { committed: () => { if (raw === null) throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }); return raw; } });

  await test('no catalogue is committed today, so none is loaded', () => {
    assert.ok(!fs.existsSync(path.join(REPO, 'api/_catalog/data/uniqlo-us.json')), 'no UNIQLO catalogue is committed until a real, authorized feed has been synced');
    delete process.env[store.envName(adapter)];
    assert.strictEqual(store.load(adapter).state, 'none');
    assert.strictEqual(store.freshness(store.load(adapter), adapter, Date.now()).served, false);
  });

  await test('a fixture catalogue at the customer-facing path is refused; a product edited into the file by hand is checked again and dropped if it breaks a rule', () => {
    const raw = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.deepStrictEqual([store.load(withCommitted(raw)).state, store.load(withCommitted(raw)).why], ['invalid', 'fixture']);
      const real = Object.assign({}, raw, { fixture: false });
      real.products = raw.products.concat([
        Object.assign({}, raw.products[0], { code: 'E939999-000', name: '<script>x</script>', url: 'https://www.uniqlo.com/us/en/products/E939999-000/00' }),
        Object.assign({}, raw.products[1], { url: 'https://evil.example/' }),
        raw.products[2],
        Object.assign({}, raw.products[3], { price: { currency: 'USD', amount: 39.9 } })
      ]);
      const loaded = store.load(withCommitted(real));
      assert.strictEqual(loaded.state, 'loaded');
      assert.strictEqual(loaded.products.length, 26, 'the bad, repeated and broken rows left out');
      assert.strictEqual(loaded.products.find((p) => p.code === raw.products[3].code).price.amount, raw.products[3].price.amount, 'the first, valid copy is the one kept');
      assert.strictEqual(store.load(withCommitted({ format: 'fynd-catalog', version: 1, source: 'zara-us', products: [] })).state, 'invalid');
    } finally { console.error = quiet; }
  });

  await test('freshness is asked at each use: price and stock for 48 hours, the catalogue for 30 days, and never one dated in the future', () => {
    const raw = Object.assign(JSON.parse(fs.readFileSync(catalogFile, 'utf8')), { fixture: false });
    const loaded = store.load(withCommitted(raw));
    const f = (hours) => store.freshness(loaded, adapter, Date.parse(at(NOW, hours)));
    assert.deepStrictEqual([f(1).served, f(1).volatile], [true, true]);
    assert.deepStrictEqual([f(49).served, f(49).volatile], [true, false]);
    assert.deepStrictEqual([f(24 * 31).served, f(24 * 31).volatile], [false, false]);
    assert.strictEqual(f(-48).served, false);
  });

  section('searching');

  const products = read(feedText, adapter, { licensed: ALL }).products.map((p) => Object.assign({}, p, { categoryLabel: product.CATEGORIES[p.category] }));
  const index = createIndex(products, { categoryOrder: Object.keys(product.CATEGORIES) });
  const names = (r) => r.items.map((p) => p.name);

  await test('words are folded the way shoppers type them: plurals, "tee"/"t-shirt", "hoody", "men’s", accents and ®', () => {
    assert.deepStrictEqual(words('Black Oversized HOODIES').map((w) => w.term), ['black', 'oversized', 'hoodie']);
    assert.deepStrictEqual(words('t-shirts tees T Shirt').map((w) => w.term), ['tshirt', 'tshirt', 'tshirt']);
    assert.deepStrictEqual(words('Men’s hoody for the café').map((w) => w.term), ['men', 'hoodie', 'cafe']);
    assert.deepStrictEqual(words('SUPIMA® Cotton').map((w) => w.term), ['supima', 'cotton']);
    assert.deepStrictEqual(words('dress jeans'), [{ raw: 'dress', term: 'dress' }, { raw: 'jeans', term: 'jean' }]);
  });

  await test('"black oversized hoodie" finds the black oversized hoodie — every word must match the name, category, line or a colour', () => {
    const r = index.search({ q: 'black oversized hoodie' });
    assert.deepStrictEqual(names(r), ['FIXTURE Oversized Sweat Hoodie']);
    assert.deepStrictEqual([r.partial, r.unmatched], [false, []]);
    assert.deepStrictEqual(names(index.search({ q: 'navy jeans' })), ['FIXTURE Ultra Stretch Skinny Jeans', 'FIXTURE Baggy Jeans']);
    assert.deepStrictEqual(names(index.search({ q: 'E910016' })), ['FIXTURE Pocketable Parka'], 'by ID');
    assert.deepStrictEqual(names(index.search({ q: '910016' })), ['FIXTURE Pocketable Parka']);
  });

  await test('the word being typed matches as a prefix ("hood", "oversiz"), and a name match ranks before a category match', () => {
    const hood = index.search({ q: 'hood' });
    assert.strictEqual(hood.total, 7, 'every product under Sweatshirts & Hoodies');
    assert.ok(hood.items.slice(0, 5).every((p) => /Hoodie/.test(p.name)), 'the hoodies by name first');
    assert.ok(hood.items.slice(5).every((p) => !/Hoodie/.test(p.name)), 'then the rest of the category');
    assert.deepStrictEqual(names(index.search({ q: 'oversiz' })), ['FIXTURE Oversized Sweat Hoodie', 'FIXTURE Oversized Crew Neck Sweatshirt', 'FIXTURE Oversized Short-Sleeve T-Shirt']);
    const tee = names(index.search({ q: 't-shirt' }));
    assert.ok(tee.indexOf('FIXTURE Dry Pique Polo Shirt') > tee.indexOf('FIXTURE Kids Graphic T-Shirt'), 'a polo is under T-shirts, after the T-shirts by name');
  });

  await test('when nothing matches every word, the closest are shown and the word nothing matched is named — never pretended', () => {
    const r = index.search({ q: 'magenta oversized hoodie' });
    assert.deepStrictEqual([r.partial, r.unmatched], [true, ['magenta']]);
    assert.deepStrictEqual(names(r), ['FIXTURE Oversized Sweat Hoodie', 'FIXTURE Oversized Crew Neck Sweatshirt'], 'both words in the name first, then one in the name and one in the category');
    const none = index.search({ q: 'tuxedo' });
    assert.deepStrictEqual([none.total, none.partial, none.unmatched], [0, false, ['tuxedo']]);
  });

  await test('filters: a category, a line (a unisex product counts as both men’s and women’s), and in-stock only where stock is known', () => {
    assert.strictEqual(index.search({ category: 'sweatshirts-hoodies' }).total, 7);
    const women = index.search({ category: 'sweatshirts-hoodies', line: 'women' });
    assert.deepStrictEqual(names(women), ['FIXTURE Oversized Crew Neck Sweatshirt', 'FIXTURE Cropped Hoodie', 'FIXTURE Unisex Sweat Pullover Hoodie']);
    assert.deepStrictEqual(names(index.search({ q: 'hoodie', line: 'kids' })), ['FIXTURE Kids Sweat Pullover Hoodie']);
    assert.strictEqual(index.search({ inStock: '1' }).total, 26, 'ignored while stock isn’t known');
    const stocked = index.search({ inStock: '1', category: 'sweatshirts-hoodies' }, { stockKnown: true });
    assert.ok(!names(stocked).includes('FIXTURE Cropped Hoodie'), 'the sold-out hoodie is left out');
    assert.strictEqual(index.search({ category: '<script>' }).total, 26, 'an unknown filter value is no filter');
    assert.deepStrictEqual(index.facets.categories.slice(0, 3).map((c) => c.value), ['tshirts', 'sweatshirts-hoodies', 'knitwear']);
  });

  await test('pages: 24 at a time by default, at most 48, offsets clamped — and a catalogue of 20,000 is searched in milliseconds without being sent whole', () => {
    const big = [];
    const kinds = [['Hoodie', 'sweatshirts-hoodies'], ['T-Shirt', 'tshirts'], ['Jeans', 'jeans'], ['Parka', 'outerwear']];
    const colours = ['Black', 'White', 'Navy', 'Olive', 'Gray'];
    for (let i = 0; i < 20000; i += 1) {
      const [kind, category] = kinds[i % 4];
      big.push({ code: `E${String(800000 + i)}-000`, name: `FIXTURE ${i % 3 ? 'Oversized' : 'Slim'} ${kind} ${i}`, category, categoryLabel: product.CATEGORIES[category], line: i % 2 ? 'men' : 'women', catalogue: { colours: [{ code: '09', name: colours[i % 5] }] } });
    }
    const t0 = process.hrtime.bigint();
    const bigIndex = createIndex(big);
    const built = Number(process.hrtime.bigint() - t0) / 1e6;
    const t1 = process.hrtime.bigint();
    const r = bigIndex.search({ q: 'black oversized hoodie' });
    const took = Number(process.hrtime.bigint() - t1) / 1e6;
    assert.strictEqual(r.items.length, 24);
    assert.ok(r.total > 600 && r.total < 1000, String(r.total));
    assert.ok(r.items.every((p) => /Oversized Hoodie/.test(p.name)));
    assert.ok(took < 150, `searched in ${took.toFixed(1)}ms`);
    assert.ok(built < 3000, `built in ${built.toFixed(0)}ms`);
    const pages = [0, 24, 48].map((offset) => bigIndex.search({ q: 'black oversized hoodie', offset: String(offset) }).items.map((p) => p.code));
    assert.strictEqual(new Set(pages.flat()).size, 72, 'pages don’t overlap');
    assert.strictEqual(bigIndex.search({ limit: '500' }).items.length, 48);
    assert.strictEqual(bigIndex.search({ limit: '0' }).items.length, 1);
    assert.deepStrictEqual(readQuery({ offset: '-3', limit: 'x', q: 'x'.repeat(500) }).offset, 0);
    assert.strictEqual(readQuery({ q: 'x'.repeat(500) }).q.length, 120);
    const end = bigIndex.search({ offset: '99999' });
    assert.deepStrictEqual([end.items.length, end.offset], [0, 20000]);
  });

  section('Find Fit’s UNIQLO list, and each product’s sizing');

  const served = path.join(tmp, 'served.json');
  const synced = sync(null, read(feedText, adapter, { licensed: ALL }), adapter, { now: new Date().toISOString(), allowFixture: true });
  fs.writeFileSync(served, JSON.stringify(synced.catalog));
  const WITH = { FYND_CATALOG_UNIQLO_US: served };
  const browseCode = (expr) => `const b = require('./api/_sizing/brands'); const u = b.get('uniqlo'); return ${expr};`;

  await test('with no catalogue connected, the five products Fynd sourced are listed as they were, and the page is told plainly that most of UNIQLO isn’t there', () => {
    const r = inChild({}, browseCode(`{ list: b.browse(u, {}), notice: u.notice, catalogue: u.catalogue() }`));
    assert.deepStrictEqual(r.list.products.map((p) => p.code), ['E475378-000', 'E475377-000', 'E471808-000', 'E455365-000', 'E429066-000']);
    assert.strictEqual(r.list.total, 5);
    assert.match(r.list.brand.coverage, /^5 UNIQLO US products Fynd has read off uniqlo\.com — not UNIQLO’s full range\.$/);
    assert.match(r.notice, /^Limited selection: Fynd isn’t connected to UNIQLO’s product catalogue yet, so most UNIQLO products aren’t listed here\./);
    assert.deepStrictEqual(r.catalogue, { connected: false, lastSuccessfulSync: null, pricesShown: false, stockShown: false });
    assert.ok(!JSON.stringify(r).includes('FIXTURE'), 'no fixture product reaches a customer');
    assert.ok(r.list.products.every((p) => !('price' in p) && !('availability' in p)));
  });

  await test('with a catalogue: its products join the five, each once; the five keep their own names and sizing holds; the coverage line names the source and date and never claims the full range', () => {
    const r = inChild(WITH, browseCode(`{ all: u.products().map((p) => [p.code, p.name, p.holds]), page: b.browse(u, {}), notice: u.notice }`));
    assert.strictEqual(r.all.length, 30);
    assert.strictEqual(new Set(r.all.map((p) => p[0])).size, 30);
    const held = Object.fromEntries(r.all.map(([code, name, holds]) => [code, [name, holds]]));
    assert.deepStrictEqual(held['E471808-000'], ['Sweat Oversized Pullover Hoodie', 'unchecked-chart'], 'Fynd’s own record of E471808, not the catalogue’s name');
    assert.deepStrictEqual(held['E475378-000'][1], 'checked-chart');
    assert.strictEqual(held['E910001-000'][1], 'general-chart', 'a men’s hoodie the catalogue places in UNIQLO’s general chart’s category');
    assert.strictEqual(held['E910003-000'][1], 'live-only', 'a women’s top: no general chart');
    assert.match(r.page.brand.coverage, /^30 UNIQLO US products from FIXTURE UNIQLO US feed, updated \d{4}-\d{2}-\d{2}\.$/);
    assert.ok(!/full/i.test(r.page.brand.coverage));
    assert.strictEqual(r.notice, null);
    assert.deepStrictEqual([r.page.products.length, r.page.total, r.page.limit], [24, 30, 24]);
    assert.deepStrictEqual(r.page.products.slice(0, 4).map((p) => p.code), ['E475378-000', 'E475377-000', 'E471808-000', 'E455365-000'], 'a saved chart first, as before');
    assert.ok(r.page.products.every((p) => !('catalogue' in p) && !('source' in p)), 'bookkeeping stays on the server');
  });

  await test('/api/size-recommendation searches and pages the catalogue: "black oversized hoodie", filters, the next page — and anything else in the address is ignored', () => {
    const r = inChild(WITH, `
      const handler = require('./api/size-recommendation');
      const call = (query) => new Promise((resolve) => {
        const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, end() { resolve({ status: this.statusCode }); } };
        handler({ method: 'GET', query, headers: { host: 'fynd.test' }, url: '/api/size-recommendation', socket: { remoteAddress: '203.0.113.7' } }, res);
      });
      return {
        hoodie: await call({ brand: 'uniqlo', q: 'black oversized hoodie' }),
        women: await call({ brand: 'uniqlo', q: 'jeans', line: 'women' }),
        next: await call({ brand: 'uniqlo', offset: '24' }),
        stock: await call({ brand: 'uniqlo', inStock: '1', category: 'sweatshirts-hoodies', limit: '48' }),
        odd: await call({ brand: 'uniqlo', q: '<img src=x onerror=alert(1)>', category: '../../etc', offset: 'NaN', limit: '1e9' }),
        nike: await call({ brand: 'nike', q: 'hoodie' })
      };`);
    assert.strictEqual(r.hoodie.status, 200);
    assert.deepStrictEqual(r.hoodie.body.products.map((p) => p.code), ['E471808-000', 'E910001-000']);
    assert.deepStrictEqual(r.hoodie.body.products[1].price, { currency: 'USD', amount: 4990, was: 5990 });
    assert.strictEqual(r.hoodie.body.products[1].availability, 'in_stock');
    assert.deepStrictEqual(r.women.body.products.map((p) => p.name), ['FIXTURE Ultra Stretch Skinny Jeans']);
    assert.deepStrictEqual([r.next.body.offset, r.next.body.products.length, r.next.body.total], [24, 6, 30]);
    assert.strictEqual(r.stock.body.facets.inStock, true);
    assert.ok(!r.stock.body.products.some((p) => p.code === 'E910004-000'), 'the sold-out hoodie');
    assert.ok(r.stock.body.products.every((p) => p.availability === 'in_stock'), 'products with no known stock aren’t claimed to be in stock');
    assert.deepStrictEqual([r.odd.status, r.odd.body.total, r.odd.body.query.category, r.odd.body.query.offset, r.odd.body.query.limit], [200, 0, 'all', 0, 24]);
    assert.strictEqual(r.nike.status, 404);
  });

  await test('choosing a product: found by its exact code only; its page shows the catalogue’s colours, size labels, price and stock — each said to be the catalogue’s — and never measurements', () => {
    const r = inChild(WITH, browseCode(`{ feed: u.detail('E910001-000'), record: u.detail('E471808-000'), near: [u.find('e910001-000'), u.find('E910001'), u.find('E910106-000'), u.find('E910102-000'), u.find('https://www.uniqlo.com/us/en/products/E910001-000/00')] }`));
    assert.deepStrictEqual(r.near, [null, null, null, null, null], 'no near code, no discontinued or rejected product, no link');
    const f = r.feed;
    assert.deepStrictEqual(f.colours.map((c) => [c.code, c.label]), [['09', 'Black'], ['03', 'Gray'], ['56', 'Olive']]);
    assert.deepStrictEqual(f.sizes.list, ['XS', 'S', 'M', 'L', 'XL', 'XXL']);
    assert.match(f.sizes.source, /FIXTURE UNIQLO US feed, updated \d{4}-\d{2}-\d{2} — size labels only, not measurements/);
    assert.ok(Array.isArray(f.sizes.variants) && f.sizes.variants.length === 18);
    assert.deepStrictEqual([f.price.amount, f.price.was, f.availability.state], [4990, 5990, 'in_stock']);
    assert.deepStrictEqual(f.missing, ['description', 'care', 'reviews', 'fabric', 'fit']);
    assert.deepStrictEqual([f.fit, f.material, f.recordedAt], [null, null, null]);
    /* a product Fynd holds a record for: the record's sizes and fit, the catalogue's price and colour */
    const rec = r.record;
    assert.deepStrictEqual([rec.name, rec.sizes.list.length, rec.fit.words, rec.price.amount], ['Sweat Oversized Pullover Hoodie', 8, 'Oversized', 4990]);
    assert.match(rec.sizes.source, /^Fynd’s record of this product/);
  });

  await test('a chosen product’s chart comes through the sizing pipeline by its exact code: its own record when Fynd has one, UNIQLO’s general chart (a body chart, never compared) only by category, otherwise honestly none', () => {
    const r = inChild(WITH, `
      const u = require('./api/_sizing/brands').get('uniqlo');
      const charts = require('./api/_sizing/chart');
      const offline = { noCache: true, fetch: async () => { throw new Error('offline'); } };
      const look = async (code) => { const c = await charts.chartFor(u.find(code).url, offline); return { status: c.status, from: c.from, verification: c.verification, comparable: c.comparable, measures: (c.charts || []).map((x) => x.measures), identity: c.fallback ? c.fallback.identity || null : null, text: JSON.stringify(c) }; };
      return { record: await look('E471808-000'), general: await look('E910001-000'), women: await look('E910003-000'), kids: await look('E910019-000') };`);
    assert.deepStrictEqual([r.record.from, r.record.measures[0]], ['fynd-record', 'finished-garment'], 'E471808’s own record, not a catalogue guess');
    assert.strictEqual(r.general.status, 'fallback');
    assert.strictEqual(r.general.comparable, false);
    assert.deepStrictEqual(r.general.measures, ['body']);
    assert.match(r.general.text, /"chartId":"uniqlo-us-men-tops-body"/);
    assert.match(r.general.text, /UNIQLO’s general Body Size chart for its US men’s and unisex tops, which this product is one of/);
    assert.ok(!/"measures":"finished-garment"/.test(r.general.text), 'no garment measurements from a catalogue');
    assert.deepStrictEqual([r.women.status, r.kids.status], ['unavailable', 'unavailable'], 'a women’s or kids’ product never gets the men’s chart');
  });

  await test('stale data: after 48 hours prices and stock are withheld and said to be; after 30 days the catalogue isn’t served at all and the page says how old it is', () => {
    const later = (hours) => `Date.now() + ${hours} * 3600 * 1000`;
    const r = inChild(WITH, browseCode(`{
      stale: { page: u.search({ q: 'black oversized hoodie' }, ${later(49)}), detail: u.detail('E910001-000', ${later(49)}), catalogue: u.catalogue(${later(49)}) },
      expired: { page: u.search({}, ${later(24 * 31)}), find: u.find('E910001-000', ${later(24 * 31)}), coverage: u.coverageAt(${later(24 * 31)}), notice: u.noticeAt(${later(24 * 31)}), record: u.find('E475378-000', ${later(24 * 31)}) !== null }
    }`));
    assert.ok(r.stale.page.products.every((p) => !('price' in p) && !('availability' in p)));
    assert.strictEqual(r.stale.page.facets.inStock, false);
    assert.ok(!('price' in r.stale.detail) && !('availability' in r.stale.detail) && !r.stale.detail.sizes.variants);
    assert.ok(r.stale.detail.missing.includes('price') && r.stale.detail.missing.includes('availability'));
    assert.strictEqual(r.stale.detail.catalogue.withheld, true);
    assert.deepStrictEqual([r.stale.catalogue.connected, r.stale.catalogue.pricesShown], [true, false]);
    assert.strictEqual(r.expired.page.total, 5);
    assert.strictEqual(r.expired.find, null);
    assert.strictEqual(r.expired.record, true, 'the five stay');
    assert.match(r.expired.coverage, /^5 UNIQLO US products Fynd has read off uniqlo\.com/);
    assert.match(r.expired.notice, /^Limited selection: UNIQLO’s product catalogue was last updated on \d{4}-\d{2}-\d{2}, too long ago to show/);
  });

  await test('an unreadable or broken catalogue file is no catalogue: the five products, and the limited-coverage notice', () => {
    const broken = path.join(tmp, 'broken.json');
    fs.writeFileSync(broken, '{"format":"fynd-catalog","version":1,');
    const r = inChild({ FYND_CATALOG_UNIQLO_US: broken }, browseCode(`{ total: b.browse(u, {}).total, notice: u.notice }`));
    assert.strictEqual(r.total, 5);
    assert.match(r.notice, /isn’t connected to UNIQLO’s product catalogue yet/);
    const elsewhere = inChild({ FYND_CATALOG_UNIQLO_US: path.join(tmp, 'served.txt') }, browseCode(`b.browse(u, {}).total`));
    assert.strictEqual(elsewhere, 5, 'only a .json file is read');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
