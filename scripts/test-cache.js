#!/usr/bin/env node
/* =========================================================
   Fynd — search and offer cache test

   Proves the two cache layers in api/_cache.js do what they claim and,
   more importantly, that they have not quietly changed what a shopper
   is shown. Nothing here touches the network: both OpenWeb Ninja
   endpoints are stubbed, and every request the adapter would have made
   is counted, so "this cost nothing" is a measurement rather than a
   hope.

   What is asserted, in order:

     keys        the same search is one key however it was typed, and
                 two different searches are never one key
     search      a verified answer is reused for its TTL and bought
                 again after it
     offers      a resolved offer is reused for its TTL, and a product
                 with nothing usable is remembered only briefly
     failures    a 429 or a 500 is never written down as an answer
     the gate    a cached record is verified when it is SERVED, not when
                 it was stored
     stampedes   ten identical misses at once cost one search
     metering    one shopper search is one metered search, hot or cold
     off         with the cache disabled, or its store broken, the
                 provider behaves exactly as it did before any of this

   Usage: node scripts/test-cache.js
   ========================================================= */

'use strict';

const assert = require('assert');
const cache = require('../api/_cache');
const store = require('../api/_store');
const provider = require('../api/_providers/openwebninja');
const { verifyAll, linkFault } = require('../api/_providers/product-source');
const { findProducts } = require('../api/search');

let passed = 0;
const failures = [];

/* Time, as this file tells it. Real TTLs are minutes and hours; a test
   that waited them out would not be a test anybody runs. */
let offset = 0;
const advance = (ms) => { offset += ms; };
cache.setClock(() => Date.now() + offset);

const MINUTE = 60 * 1000;

/* Every test starts on an empty cache, at time zero, with the cache on
   and the adapter configured. */
function fresh() {
  offset = 0;
  cache.reset();
  delete process.env.FYND_CACHE;
  delete process.env.PRODUCT_SOURCE;
  delete process.env.OPENWEBNINJA_OFFER_BUDGET_MS;
  process.env.OPENWEBNINJA_API_KEY = 'test-key';
}

function test(name, fn) {
  try {
    fresh();
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    fresh();
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

/* ---------------------------------------------------------
   Fixtures — the shapes a live response has been observed in
   --------------------------------------------------------- */

const intent = {
  categories: ['hoodie'], colors: ['black'], occasions: [], fits: ['oversized'],
  brands: [], styles: [], keywords: [], maxPrice: 80, minPrice: null, season: null, gender: null
};

const withIntent = (over) => Object.assign({}, intent, over);

/* a search record with no retailer link: the common case, and the one
   that costs a /product-offers request */
const product = (over) => Object.assign({
  product_id: 'p1',
  product_title: 'Champion Reverse Weave Oversized Hoodie, Black',
  price: '$68.00',
  store_name: 'nordstrom.com',
  product_photos: ['https://img.example-cdn.com/champion-black.jpg'],
  product_page_url: 'https://www.google.com/shopping/product/111'
}, over);

const offer = (store_name, price, url) => ({ store_name, price, offer_page_url: url });

const envelope = (data) => ({ status: 'OK', request_id: 'r', data });
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

/* Answers both endpoints and records every call, so what a search cost
   is counted rather than inferred. `offersById` maps a product id to
   its offers, or to a status code to make that lookup fail. */
function stubFor(searchPayload, offersById) {
  const calls = [];
  const impl = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    if (u.pathname.endsWith('/product-offers')) {
      const id = u.searchParams.get('product_id');
      const offers = (offersById || {})[id];
      if (typeof offers === 'number') return { ok: false, status: offers, text: async () => 'upstream' };
      return okResponse(envelope(offers || []));
    }
    if (typeof searchPayload === 'number') return { ok: false, status: searchPayload, text: async () => 'upstream' };
    return okResponse(searchPayload);
  };
  impl.calls = calls;
  impl.searches = () => calls.filter((p) => p.endsWith('/search')).length;
  impl.lookups = () => calls.filter((p) => p.endsWith('/product-offers')).length;
  return impl;
}

function withStubbedFetch(handler, run) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(run()).finally(() => { global.fetch = real; });
}

/* One shopper search, through the same function /api/search calls. */
const search = (searchIntent, stats) => findProducts(provider, searchIntent || intent, 12, stats || cache.counters());

/* ---------------------------------------------------------
   1. Keys
   --------------------------------------------------------- */

console.log('\ncache keys');

const keyFor = (searchIntent, over) => cache.searchKey(Object.assign({
  provider: 'openwebninja', limit: 12, intent: searchIntent, context: provider.cacheContext()
}, over));

test('the same search is one key however the interpreter spelled it', () => {
  assert.strictEqual(
    keyFor(withIntent({ colors: ['Black'], categories: [' Hoodie '], maxPrice: 80 })),
    keyFor(withIntent({ colors: ['black'], categories: ['hoodie'], maxPrice: 80.0 })),
    'case and spacing are not part of what a shopper asked for');
});

test('field order within the intent does not fork the key', () => {
  const a = { categories: ['hoodie'], colors: ['black'], maxPrice: 80 };
  const b = { maxPrice: 80, colors: ['black'], categories: ['hoodie'] };
  assert.strictEqual(keyFor(withIntent(a)), keyFor(withIntent(b)));
});

test('a repeated term is the same search as one that says it once', () => {
  assert.strictEqual(
    keyFor(withIntent({ keywords: ['hoodie', 'hoodie'] })),
    keyFor(withIntent({ keywords: ['hoodie'] })),
    'the query builder drops the duplicate, so the key must too');
});

test('two budgets are two searches', () => {
  assert.notStrictEqual(keyFor(withIntent({ maxPrice: 80 })), keyFor(withIntent({ maxPrice: 60 })));
  assert.notStrictEqual(keyFor(withIntent({ minPrice: 20 })), keyFor(withIntent({ minPrice: null })));
});

test('colour, fit, brand, category, occasion, style, gender and season each separate a key', () => {
  const base = keyFor(intent);
  const different = {
    colors: ['white'],
    fits: ['slim'],
    brands: ['nike'],
    categories: ['jacket'],
    occasions: ['wedding'],
    styles: ['vintage'],
    keywords: ['fleece'],
    gender: 'women',
    season: 'winter'
  };
  const seen = new Set([base]);
  for (const [field, value] of Object.entries(different)) {
    const key = keyFor(withIntent({ [field]: value }));
    assert.notStrictEqual(key, base, `${field} must change the key`);
    assert.ok(!seen.has(key), `${field} must not collide with another field's key`);
    seen.add(key);
  }
});

test('term order within one field IS part of the search', () => {
  assert.notStrictEqual(
    keyFor(withIntent({ colors: ['black', 'white'] })),
    keyFor(withIntent({ colors: ['white', 'black'] })),
    'the adapter builds its query phrase in this order, so the results differ');
});

test('the page size, the provider and the marketplace are all in the key', () => {
  assert.notStrictEqual(keyFor(intent), keyFor(intent, { limit: 24 }));
  assert.notStrictEqual(keyFor(intent), keyFor(intent, { provider: 'serpapi' }));
  assert.notStrictEqual(keyFor(intent), keyFor(intent, { context: { country: 'gb', language: 'en', offers: 'on' } }));
  assert.notStrictEqual(keyFor(intent), keyFor(intent, { context: { country: 'us', language: 'en', offers: 'off' } }));
});

test('the key is versioned, so everything can be invalidated at once', () => {
  assert.ok(keyFor(intent).startsWith(`fynd:cache:${cache.CACHE_VERSION}:search:`), keyFor(intent));
});

test('the key carries none of what the shopper typed', () => {
  const key = keyFor(withIntent({ keywords: ['unmistakable-search-term'] }));
  assert.ok(!key.includes('unmistakable'), 'a key is a digest, not a record of the request');
  assert.ok(!key.includes('hoodie'));
});

/* ---------------------------------------------------------
   2. The search-result cache
   --------------------------------------------------------- */

(async () => {
  console.log('\nsearch-result cache');

  const oneGoodWorld = () => stubFor(
    envelope([product({ product_id: 'a' }), product({ product_id: 'b' })]),
    {
      a: [offer('Nordstrom', '$68.00', 'https://www.nordstrom.com/s/hoodie/a')],
      b: [offer('Walmart', '$24.98', 'https://www.walmart.com/ip/hoodie/b')]
    });

  await testAsync('a verified answer is reused, and the hit costs no provider request at all', async () => {
    const stub = oneGoodWorld();
    const cold = cache.counters();
    const warm = cache.counters();

    const first = await withStubbedFetch(stub, () => search(intent, cold));
    const spent = stub.calls.length;
    assert.ok(spent >= 3, `the cold search must really have cost something, spent ${spent}`);
    assert.strictEqual(first.products.length, 2);
    assert.strictEqual(cold.searchCache.miss, 1);
    assert.strictEqual(cold.searchCache.stored, 1);

    const second = await withStubbedFetch(stub, () => search(intent, warm));
    assert.strictEqual(stub.calls.length, spent, 'a hit must not touch OpenWeb Ninja at all');
    assert.strictEqual(warm.searchCache.hit, 1);
    assert.strictEqual(warm.searchCache.miss, 0);
    assert.strictEqual(second.servedFromCache, true);
    assert.deepStrictEqual(second.products, first.products, 'and it is the same page of products');
    assert.strictEqual(warm.providerRequestsAvoided, spent, 'the hit is credited with what the cold search cost');
  });

  await testAsync('the answer is still there at 29 minutes and gone at 31', async () => {
    const stub = oneGoodWorld();
    await withStubbedFetch(stub, () => search());
    const spent = stub.calls.length;

    advance(29 * MINUTE);
    await withStubbedFetch(stub, () => search());
    assert.strictEqual(stub.calls.length, spent, 'within the TTL it is still a hit');

    advance(2 * MINUTE);
    const stats = cache.counters();
    await withStubbedFetch(stub, () => search(intent, stats));
    assert.strictEqual(stats.searchCache.miss, 1, 'past the TTL it is a miss');
    assert.ok(stub.searches() === 2, `and the provider is asked again, searches: ${stub.searches()}`);
  });

  await testAsync('two different searches do not answer each other', async () => {
    const stub = oneGoodWorld();
    await withStubbedFetch(stub, () => search(intent));
    const stats = cache.counters();
    await withStubbedFetch(stub, () => search(withIntent({ maxPrice: 60 }), stats));
    assert.strictEqual(stats.searchCache.miss, 1, 'a different budget is a different search');
    assert.strictEqual(stub.searches(), 2);
  });

  await testAsync('a search that verified nothing is not stored', async () => {
    /* every seller links to Google: the records reach the gate and the
       gate drops them all. That may be the provider having a bad
       minute, and half an hour of it is not worth keeping. */
    const stub = stubFor(envelope([product({ product_id: 'a' })]),
      { a: [offer('shop.com', '$50.00', 'https://www.google.com/shopping/product/x')] });

    const first = await withStubbedFetch(stub, () => search());
    assert.strictEqual(first.products.length, 0);

    const stats = cache.counters();
    await withStubbedFetch(stub, () => search(intent, stats));
    assert.strictEqual(stats.searchCache.hit, 0, 'nothing to hit');
    assert.strictEqual(stub.searches(), 2, 'so the provider is asked again');
  });

  /* -------------------------------------------------------
     3. The offer cache
     ------------------------------------------------------- */

  console.log('\noffer cache');

  const twoNeedingLookups = () => stubFor(
    envelope([product({ product_id: 'a' }), product({ product_id: 'b' })]),
    {
      a: [offer('Nordstrom', '$68.00', 'https://www.nordstrom.com/s/hoodie/a')],
      b: [offer('Walmart', '$24.98', 'https://www.walmart.com/ip/hoodie/b')]
    });

  await testAsync('a resolved offer is reused, and the lookup is not bought twice', async () => {
    const stub = twoNeedingLookups();
    const first = await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 2, 'both records needed a link');
    assert.strictEqual(first.diagnostics.offers.lookupsMade, 2);

    const second = await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 2, 'the second search buys no lookups');
    assert.strictEqual(second.diagnostics.offers.lookupsMade, 0);
    assert.strictEqual(second.diagnostics.cache.offerCache.hit, 2);
    assert.strictEqual(second.diagnostics.cache.providerRequestsAvoided, 2);

    /* and the records are the ones the offers described, not shadows */
    const { products } = verifyAll(second, { retailer: provider.defaultRetailer });
    assert.strictEqual(products.length, 2);
    assert.deepStrictEqual(products.map((p) => p.productUrl).sort(),
      ['https://www.nordstrom.com/s/hoodie/a', 'https://www.walmart.com/ip/hoodie/b']);
    assert.strictEqual(products.find((p) => p.retailer === 'Nordstrom').price, 68);
  });

  await testAsync('an offer is still good at 119 minutes and bought again at 121', async () => {
    const stub = twoNeedingLookups();
    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));

    advance(119 * MINUTE);
    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 2, 'within the TTL the stored offer stands');

    advance(2 * MINUTE);
    const third = await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 4, 'past it, the offer is looked up again');
    assert.strictEqual(third.diagnostics.offers.lookupsMade, 2);
  });

  await testAsync('an expired offer is never served, whatever the store still holds', async () => {
    const key = cache.offerKey({ provider: 'openwebninja', productId: 'a', country: 'us', language: 'en' });
    const stub = twoNeedingLookups();
    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.ok(await store.get(key), 'the offer was stored');

    advance(121 * MINUTE);
    /* the row is still in the store — its own TTL has not been swept —
       and it must still not be used */
    assert.ok(await store.get(key), 'the row outlives its stamp in this test');
    const stats = cache.counters();
    assert.strictEqual(await cache.readOffer(key, stats), null);
    assert.strictEqual(stats.offerCache.miss, 1);
    assert.strictEqual(stats.offerCache.hit, 0);
  });

  await testAsync('"no usable offer" is remembered for five minutes, and no longer', async () => {
    /* the sellers answered; not one of them gave a link Fynd can show */
    const stub = stubFor(envelope([product({ product_id: 'a' })]),
      { a: [offer('shop.com', '$50.00', 'https://www.google.com/shopping/product/x')] });

    const first = await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 1);
    assert.strictEqual(first.diagnostics.offers.noDirectLinkInOffers, 1);
    assert.strictEqual(first.diagnostics.cache.offerCache.negativeStored, 1);

    advance(4 * MINUTE);
    const second = await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 1, 'the dead lookup is not bought again');
    assert.strictEqual(second.diagnostics.cache.offerCache.negativeHit, 1);
    assert.strictEqual(second.diagnostics.offers.negativeCacheHits, 1);

    advance(2 * MINUTE);
    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 2, 'six minutes on, the product is asked about again');
  });

  await testAsync('a product with no offers at all is remembered the same brief way', async () => {
    const stub = stubFor(envelope([product({ product_id: 'a' })]), { a: [] });
    const first = await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(first.diagnostics.offers.lookupsEmpty, 1);
    assert.strictEqual(first.diagnostics.cache.offerCache.negativeStored, 1);

    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 1);

    advance(6 * MINUTE);
    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 2);
  });

  /* -------------------------------------------------------
     4. Failures are never answers
     ------------------------------------------------------- */

  console.log('\nprovider failures');

  for (const status of [429, 500, 503]) {
    await testAsync(`an offer lookup answering ${status} is not written down as "no offer"`, async () => {
      const stub = stubFor(envelope([product({ product_id: 'a' })]), { a: status });

      const first = await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
      assert.strictEqual(first.diagnostics.offers.lookupsFailed, 1);
      assert.strictEqual(first.diagnostics.cache.offerCache.negativeStored, 0, 'nothing may be stored for a failure');
      assert.strictEqual(first.diagnostics.cache.offerCache.stored, 0);

      /* the very next search must go and ask again, and when the
         provider has recovered the product is shown */
      const healthy = stubFor(envelope([product({ product_id: 'a' })]),
        { a: [offer('Nordstrom', '$68.00', 'https://www.nordstrom.com/s/hoodie/a')] });
      const second = await withStubbedFetch(healthy, () => provider.search(intent, { limit: 12 }));
      assert.strictEqual(healthy.lookups(), 1, 'the failure did not suppress the retry');
      assert.strictEqual(verifyAll(second, {}).products.length, 1);
    });

    await testAsync(`a search answering ${status} is not stored, and the next search is real`, async () => {
      const failing = stubFor(status, {});
      await assert.rejects(withStubbedFetch(failing, () => search()), new RegExp(String(status)));

      const healthy = stubFor(envelope([product({ product_id: 'a' })]),
        { a: [offer('Nordstrom', '$68.00', 'https://www.nordstrom.com/s/hoodie/a')] });
      const stats = cache.counters();
      const result = await withStubbedFetch(healthy, () => search(intent, stats));
      assert.strictEqual(stats.searchCache.hit, 0, 'a failure left nothing behind to hit');
      assert.strictEqual(result.products.length, 1);
    });
  }

  await testAsync('a store that cannot be reached is a miss, not a failed search', async () => {
    const realGet = store.get;
    const realSet = store.set;
    store.get = async () => { throw new Error('store unreachable'); };
    store.set = async () => { throw new Error('store unreachable'); };
    try {
      const stub = oneGoodWorld();
      const stats = cache.counters();
      const result = await withStubbedFetch(stub, () => search(intent, stats));
      assert.strictEqual(result.products.length, 2, 'the shopper still gets their products');
      assert.strictEqual(stats.searchCache.miss, 1);
      assert.strictEqual(stats.searchCache.stored, 0);
    } finally {
      store.get = realGet;
      store.set = realSet;
    }
  });

  /* -------------------------------------------------------
     5. The gate runs on cached records
     ------------------------------------------------------- */

  console.log('\nthe gate, on a cache hit');

  await testAsync('a cached record is verified when it is served, not when it was stored', async () => {
    const stub = oneGoodWorld();
    const first = await withStubbedFetch(stub, () => search());
    assert.strictEqual(first.products.length, 2);

    /* Reach into the entry and spoil one link, as a provider whose
       rules changed under us would. The record is still in the cache;
       the gate must still refuse it. */
    const key = keyFor(intent);
    const entry = await store.get(key);
    const spoiled = entry.records.find((r) => r.productUrl.includes('nordstrom'));
    spoiled.productUrl = 'https://www.google.com/shopping/product/111';
    await store.set(key, entry);

    const stats = cache.counters();
    const second = await withStubbedFetch(stub, () => search(intent, stats));
    assert.strictEqual(stats.searchCache.hit, 1, 'it really was served from the cache');
    assert.strictEqual(second.products.length, 1, 'and the spoiled record was dropped');
    assert.strictEqual(second.rejected['product-url-not-a-retailer-page'], 1);
    second.products.forEach((p) => assert.strictEqual(linkFault(p.productUrl), null));
  });

  await testAsync('the budget a page was stored under is the budget it is served under', async () => {
    /* The adapter drops an over-budget offer before /api/search ever
       sees it, so the records that reach the cache are already inside
       the ceiling — and the ceiling is in the key, so they can only be
       served back to a search that asked for that same ceiling. Both
       halves are checked here, because either one alone would let a
       $240 hoodie onto a page that said "under $80". */
    const stub = stubFor(
      envelope([product({ product_id: 'a' }), product({ product_id: 'dear' })]),
      {
        a: [offer('Nordstrom', '$68.00', 'https://www.nordstrom.com/s/hoodie/a')],
        dear: [offer('Saks', '$240.00', 'https://www.saks.com/product/hoodie-0400012345678')]
      });

    const cold = await withStubbedFetch(stub, () => search());
    assert.strictEqual(cold.products.length, 1, 'the dear one never reaches the page');

    const stored = await store.get(keyFor(intent));
    stored.records.forEach((r) => assert.ok(r.price <= 80, `a record over the ceiling was stored: ${r.price}`));

    const warm = await withStubbedFetch(stub, () => search());
    assert.strictEqual(warm.servedFromCache, true);
    warm.products.forEach((p) => assert.ok(p.price <= 80, 'and nothing over it is served'));

    const stats = cache.counters();
    await withStubbedFetch(stub, () => search(withIntent({ maxPrice: 300 }), stats));
    assert.strictEqual(stats.searchCache.hit, 0, 'a wider budget is a different search, not a free hit');
  });

  await testAsync('the target of twelve products survives a cache hit', async () => {
    const many = Array.from({ length: 24 }, (_, i) => product({ product_id: `p${i}` }));
    const offers = {};
    many.forEach((_, i) => { offers[`p${i}`] = [offer('Nordstrom', '$50.00', `https://www.nordstrom.com/s/p/${i}`)]; });
    const stub = stubFor(envelope(many), offers);

    const cold = await withStubbedFetch(stub, () => search());
    assert.strictEqual(cold.products.length, 12, 'the cold search fills the grid');
    assert.ok(stub.lookups() <= 12 + provider.LOOKUP_SLACK, 'and spends no more than the ceiling allows');

    const warm = await withStubbedFetch(stub, () => search());
    assert.strictEqual(warm.products.length, 12, 'and so does the cached one');
    assert.deepStrictEqual(warm.products, cold.products);
  });

  /* -------------------------------------------------------
     6. Stampedes
     ------------------------------------------------------- */

  console.log('\nstampede protection');

  await testAsync('ten identical searches arriving at once cost one search', async () => {
    const stub = oneGoodWorld();
    const stats = Array.from({ length: 10 }, () => cache.counters());

    const results = await withStubbedFetch(stub,
      () => Promise.all(stats.map((s) => search(intent, s))));

    assert.strictEqual(stub.searches(), 1, `one /search, not ten — made ${stub.searches()}`);
    assert.strictEqual(stub.lookups(), 2, `one round of lookups, not ten — made ${stub.lookups()}`);
    assert.strictEqual(stats.reduce((n, s) => n + s.searchCache.coalesced, 0), 9, 'nine waited on the first');
    results.forEach((r) => assert.strictEqual(r.products.length, 2, 'and every one of them was answered'));
    assert.deepStrictEqual(results[9].products, results[0].products);
  });

  await testAsync('a follower is handed its own copy, not the leader\'s objects', async () => {
    const stub = oneGoodWorld();
    const [a, b] = await withStubbedFetch(stub, () => Promise.all([search(), search()]));
    assert.notStrictEqual(a.records[0], b.records[0], 'two requests must not share one record object');
    assert.deepStrictEqual(a.products, b.products);
  });

  await testAsync('two different searches at once are two searches', async () => {
    const stub = oneGoodWorld();
    await withStubbedFetch(stub, () => Promise.all([search(intent), search(withIntent({ maxPrice: 60 }))]));
    assert.strictEqual(stub.searches(), 2, 'coalescing must not merge searches that differ');
  });

  await testAsync('a failing search does not leave a poisoned promise behind', async () => {
    const failing = stubFor(500, {});
    const both = await withStubbedFetch(failing,
      () => Promise.allSettled([search(), search()]));
    both.forEach((r) => assert.strictEqual(r.status, 'rejected'));

    const healthy = oneGoodWorld();
    const after = await withStubbedFetch(healthy, () => search());
    assert.strictEqual(after.products.length, 2, 'the next search is unaffected');
  });

  /* -------------------------------------------------------
     7. Metering
     ------------------------------------------------------- */

  console.log('\nmetering');

  function fakeRes() {
    const res = { statusCode: null, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.end = () => res;
    return res;
  }

  const callSearch = (stub) => {
    const handler = require('../api/search');
    const res = fakeRes();
    return withStubbedFetch(stub,
      () => handler({ method: 'POST', headers: {}, body: { intent, limit: 12 }, on: () => {} }, res)).then(() => res);
  };

  await testAsync('a cache hit is still exactly one metered search', async () => {
    const meter = require('../api/_meter');
    const realSpend = meter.spend;
    const spends = [];
    meter.spend = async (identity, metric, amount) => { spends.push({ metric, amount }); return realSpend(identity, metric, amount); };

    try {
      const stub = oneGoodWorld();

      const cold = await callSearch(stub);
      assert.strictEqual(cold.statusCode, 200);
      assert.strictEqual(cold.body.products.length, 2);
      const spent = stub.calls.length;

      const warm = await callSearch(stub);
      assert.strictEqual(warm.statusCode, 200);
      assert.strictEqual(warm.body.products.length, 2);
      assert.strictEqual(stub.calls.length, spent, 'the warm search cost the provider nothing');

      assert.deepStrictEqual(spends, [{ metric: 'searches', amount: 1 }, { metric: 'searches', amount: 1 }],
        'two shopper searches, two metered searches — the cache changes what WE spend, not what they do');
    } finally {
      meter.spend = realSpend;
    }
  });

  await testAsync('a search the provider refused is not metered', async () => {
    const meter = require('../api/_meter');
    const realSpend = meter.spend;
    const spends = [];
    meter.spend = async (identity, metric, amount) => { spends.push({ metric, amount }); return realSpend(identity, metric, amount); };
    try {
      const res = await callSearch(stubFor(429, {}));
      assert.strictEqual(res.statusCode, 502);
      assert.deepStrictEqual(spends, [], 'a failed search costs the shopper nothing');
    } finally {
      meter.spend = realSpend;
    }
  });

  await testAsync('the reply reports the cache in counts, and never a key', async () => {
    const stub = oneGoodWorld();
    await callSearch(stub);
    const warm = await callSearch(stub);

    const report = warm.body.diagnostics.cache;
    assert.strictEqual(report.servedFromCache, true);
    assert.strictEqual(report.searchCache.hit, 1);
    assert.strictEqual(report.searchCache.miss, 0);
    assert.ok(report.providerRequestsAvoided > 0);
    assert.strictEqual(typeof report.enabled, 'boolean');

    const raw = JSON.stringify(warm.body);
    assert.ok(!raw.includes('fynd:cache'), 'no cache key may reach a browser');
    assert.ok(!raw.includes(keyFor(intent).split(':').pop()), 'nor the digest a search was stored under');
    assert.ok(!raw.includes('test-key'), 'nor the API key');
  });

  await testAsync('a cold reply reports the miss, and the funnel is still there', async () => {
    const res = await callSearch(oneGoodWorld());
    const d = res.body.diagnostics;
    assert.strictEqual(d.cache.servedFromCache, false);
    assert.strictEqual(d.cache.searchCache.miss, 1);
    assert.strictEqual(d.cache.searchCache.hit, 0);
    assert.strictEqual(d.returnedByProvider, 2, 'the adapter\'s own account of the search survives');
    assert.strictEqual(d.verified, 2);
  });

  /* -------------------------------------------------------
     8. With the cache off, or its store missing
     ------------------------------------------------------- */

  console.log('\ncache disabled');

  await testAsync('FYND_CACHE=off restores exactly the old provider behaviour', async () => {
    process.env.FYND_CACHE = 'off';
    const stub = oneGoodWorld();

    const first = await withStubbedFetch(stub, () => search());
    const spent = stub.calls.length;
    const second = await withStubbedFetch(stub, () => search());

    assert.strictEqual(stub.calls.length, spent * 2, 'every search is bought, as before');
    assert.deepStrictEqual(second.products, first.products, 'and answers the same thing');
    assert.strictEqual(second.servedFromCache, false);
  });

  await testAsync('with the cache off, nothing is written for a later search to find', async () => {
    process.env.FYND_CACHE = 'off';
    await withStubbedFetch(oneGoodWorld(), () => search());
    assert.strictEqual(await store.get(keyFor(intent)), null);

    delete process.env.FYND_CACHE;
    const stats = cache.counters();
    const stub = oneGoodWorld();
    await withStubbedFetch(stub, () => search(intent, stats));
    assert.strictEqual(stats.searchCache.miss, 1, 'turning it back on finds nothing stale');
  });

  await testAsync('with the cache off, ten at once are ten searches', async () => {
    process.env.FYND_CACHE = 'off';
    const stub = oneGoodWorld();
    await withStubbedFetch(stub, () => Promise.all(Array.from({ length: 10 }, () => search())));
    assert.strictEqual(stub.searches(), 10, 'coalescing is part of the cache, and it is off');
  });

  await testAsync('with the cache off, offers are looked up every time', async () => {
    process.env.FYND_CACHE = 'off';
    const stub = twoNeedingLookups();
    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    await withStubbedFetch(stub, () => provider.search(intent, { limit: 12 }));
    assert.strictEqual(stub.lookups(), 4);
  });

  await testAsync('the reply says the cache is off rather than pretending', async () => {
    process.env.FYND_CACHE = 'off';
    const res = await callSearch(oneGoodWorld());
    assert.strictEqual(res.body.diagnostics.cache.enabled, false);
    assert.strictEqual(res.body.products.length, 2);
  });

  await testAsync('with no Redis configured the cache still runs on the memory driver', async () => {
    /* what a local `node scripts/…` run and a cold function instance
       both get: no KV_REST_API_URL, no UPSTASH_REDIS_REST_URL */
    assert.strictEqual(store.durable(), false, 'this suite runs without a store configured');
    const stub = oneGoodWorld();
    await withStubbedFetch(stub, () => search());
    const spent = stub.calls.length;
    const stats = cache.counters();
    await withStubbedFetch(stub, () => search(intent, stats));
    assert.strictEqual(stub.calls.length, spent);
    assert.strictEqual(stats.searchCache.hit, 1);
    assert.strictEqual(cache.report(stats).driver, 'memory');
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
