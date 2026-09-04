#!/usr/bin/env node
/* =========================================================
   Fynd — SerpApi adapter test

   Exercises the SerpApi adapter without touching the network: a stubbed
   response in the shape SerpApi documents for `google_shopping_light`,
   through the adapter's mapping, the seller lookup, and the verification
   gate in _providers/product-source.js.

   What it is really testing is the rule the adapter is built on: a
   Google Shopping result's own links point back at Google, so a record
   is shown only when a retailer URL was actually supplied, and a record
   without one is dropped rather than linked to a comparison page.

   A live check of the real response shape is a separate script:
     SERPAPI_API_KEY=... node scripts/probe-serpapi.js

   Usage: node scripts/test-serpapi.js
   ========================================================= */

'use strict';

const assert = require('assert');
const provider = require('../api/_providers/serpapi');
const { verifyAll } = require('../api/_providers/product-source');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
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
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

/* ---------------------------------------------------------
   Fixtures, in the documented response shape
   --------------------------------------------------------- */

/* A google_shopping_light result as Google's index describes an item:
   every URL on it belongs to Google or to SerpApi. This is the shape the
   adapter must refuse to link to. */
const googleOnly = (over) => Object.assign({
  position: 1,
  title: 'Champion Reverse Weave Oversized Hoodie, Black',
  product_link: 'https://www.google.com/shopping/product/1234567890',
  product_id: '1234567890',
  serpapi_product_api: 'https://serpapi.com/search.json?engine=google_product&product_id=1234567890',
  source: 'Nordstrom',
  price: '$68.00',
  extracted_price: 68,
  thumbnail: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:champion-hoodie',
  delivery: 'Free delivery'
}, over);

/* The same result when it carries the merchant's own link. */
const withDirectLink = (over) => googleOnly(Object.assign({
  product_id: '2222222222',
  title: "Nike Men's Sportswear Club Fleece Hoodie",
  source: 'Nike',
  price: '$60.00',
  direct_link: 'https://www.nike.com/t/sportswear-club-fleece-hoodie/CZ7857-010'
}, over));

/* One seller object as the google_product offers endpoint returns them. */
const seller = (over) => Object.assign({
  position: 1,
  name: 'Nordstrom',
  link: 'https://www.google.com/url?q=https://www.nordstrom.com/s/hoodie/7654321',
  direct_link: 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321',
  base_price: '$68.00',
  total_price: '$68.00'
}, over);

const sellersPayload = (sellers) => ({ sellers_results: { online_sellers: sellers } });
const searchPayload = (results) => ({
  search_metadata: { status: 'Success', total_time_taken: 1.2 },
  search_parameters: { engine: 'google_shopping_light' },
  shopping_results: results
});

/* ---------------------------------------------------------
   Stubbing the network
   --------------------------------------------------------- */

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
  text: async () => JSON.stringify(body)
});

/* Routes by engine, so one stub serves both endpoints and the test can
   count what each was asked for. */
function withStubbedFetch(handler, run) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options, calls);
  };
  return Promise.resolve(run(calls)).finally(() => { global.fetch = original; });
}

function twoEndpointStub(search, sellersById) {
  return (url) => {
    const params = new URL(url).searchParams;
    if (params.get('engine') === 'google_product') {
      const id = params.get('product_id');
      const found = sellersById[id];
      if (found === undefined) return jsonResponse(200, sellersPayload([]));
      if (found === 'fail') return jsonResponse(500, { error: 'boom' });
      return jsonResponse(200, sellersPayload(found));
    }
    return jsonResponse(200, search);
  };
}

const intentFor = (words, over) => Object.assign({
  categories: [], colors: [], fits: [], styles: [], brands: [], occasions: [],
  keywords: String(words).split(/\s+/)
}, over);

/* ---------------------------------------------------------
   The tests
   --------------------------------------------------------- */

(async () => {
  process.env.SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || 'test-key-not-real';

  console.log('\nintent -> query\n');

  test('terms read in the order a shopper would type them', () => {
    const q = provider.queryFrom({ gender: 'women', colors: ['black'], fits: ['oversized'], brands: ['nike'], categories: ['hoodie'] });
    assert.strictEqual(q, 'women black oversized nike hoodie');
  });

  test('a repeated term appears once', () => {
    const q = provider.queryFrom({ colors: ['black'], keywords: ['black', 'hoodie'] });
    assert.strictEqual(q, 'black hoodie');
  });

  test('season is never sent: it is description, not a product attribute', () => {
    const q = provider.queryFrom({ categories: ['coat'], season: 'winter' });
    assert.strictEqual(q, 'coat');
  });

  test('an empty intent produces an empty query, not an invented one', () => {
    assert.strictEqual(provider.queryFrom({}), '');
    assert.strictEqual(provider.queryFrom(null), '');
  });

  console.log('\nreading one result\n');

  test('title, image, brand and id come from the result itself', () => {
    const record = provider.toRecord(googleOnly({ brand: 'Champion' }));
    assert.strictEqual(record.title, 'Champion Reverse Weave Oversized Hoodie, Black');
    assert.strictEqual(record.imageUrl, 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:champion-hoodie');
    assert.strictEqual(record.brand, 'Champion');
    assert.strictEqual(record.sku, '1234567890');
  });

  test("Google's product_link is never used as a retailer URL", () => {
    const record = provider.toRecord(googleOnly());
    assert.strictEqual(record.productUrl, undefined, 'a google.com link must not become the product URL');
    assert.strictEqual(provider.looksDirect('https://www.google.com/shopping/product/1234567890'), null);
  });

  test("SerpApi's own endpoint is never used as a retailer URL", () => {
    assert.strictEqual(provider.looksDirect('https://serpapi.com/search.json?engine=google_product&product_id=1'), null);
  });

  test('price, retailer and link are absent together when there is no link', () => {
    const record = provider.toRecord(googleOnly());
    assert.strictEqual(record.price, undefined, 'a price without a link is half a product');
    assert.strictEqual(record.retailer, undefined);
    assert.strictEqual(record.currency, undefined);
  });

  test('a direct merchant link is used, with the price and shop from the same object', () => {
    const record = provider.toRecord(withDirectLink());
    assert.strictEqual(record.productUrl, 'https://www.nike.com/t/sportswear-club-fleece-hoodie/CZ7857-010');
    assert.strictEqual(record.price, 60);
    assert.strictEqual(record.retailer, 'Nike');
    assert.strictEqual(record.currency, 'USD');
  });

  test('a redirector is refused, whatever field it arrives in', () => {
    const record = provider.toRecord(googleOnly({ link: 'https://www.google.com/url?q=https://www.nordstrom.com/s/hoodie/1' }));
    assert.strictEqual(record.productUrl, undefined);
  });

  test('the retailer is never derived from the URL host', () => {
    const record = provider.toRecord(withDirectLink({ source: '' }));
    assert.strictEqual(record.retailer, undefined, 'nike.com is a host, not a stated retailer name');
  });

  test('a brand is used when stated and omitted when not', () => {
    assert.strictEqual(provider.toRecord(googleOnly()).brand, undefined);
    assert.strictEqual(provider.toRecord(googleOnly({ product_attributes: { Brand: 'Champion' } })).brand, 'Champion');
  });

  test('a non-USD price keeps its own currency', () => {
    const record = provider.toRecord(withDirectLink({ price: '£48.00' }));
    assert.strictEqual(record.currency, 'GBP');
    assert.strictEqual(record.price, 48);
  });

  test('a result with no photo gets no image, never a substitute', () => {
    const record = provider.toRecord(googleOnly({ thumbnail: undefined }));
    assert.strictEqual(record.imageUrl, undefined);
  });

  test('a used listing is recognised as one', () => {
    assert.strictEqual(provider.secondHand(googleOnly({ second_hand_condition: 'used' })), true);
    assert.strictEqual(provider.secondHand(googleOnly()), false);
  });

  console.log('\nthe verification gate\n');

  test('a record with a real retailer link passes', () => {
    const { products, rejected } = verifyAll([provider.toRecord(withDirectLink())], { retailer: null });
    assert.strictEqual(products.length, 1, JSON.stringify(rejected));
    assert.strictEqual(products[0].retailer, 'Nike');
    assert.strictEqual(products[0].productUrl, 'https://www.nike.com/t/sportswear-club-fleece-hoodie/CZ7857-010');
  });

  test('a record with only Google links is dropped, and the reason is named', () => {
    const { products, rejected } = verifyAll([provider.toRecord(googleOnly())], { retailer: null });
    assert.strictEqual(products.length, 0);
    assert.ok(rejected['missing-price'] || rejected['missing-product-url'], `expected a named reason, got ${JSON.stringify(rejected)}`);
  });

  test('two records pointing at the same URL are shown once', () => {
    const records = [provider.toRecord(withDirectLink()), provider.toRecord(withDirectLink({ product_id: '3' }))];
    const { products } = verifyAll(records, { retailer: null });
    assert.strictEqual(products.length, 1);
  });

  console.log('\nthe sellers lookup\n');

  await testAsync('a seller supplies the link, price and shop together', async () => {
    await withStubbedFetch(twoEndpointStub(searchPayload([googleOnly()]), { '1234567890': [seller()] }), async () => {
      const records = await provider.search(intentFor('black hoodie'), { limit: 4 });
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].productUrl, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321');
      assert.strictEqual(records[0].retailer, 'Nordstrom');
      assert.strictEqual(records[0].price, 68);
      const { products } = verifyAll(records, { retailer: null });
      assert.strictEqual(products.length, 1, 'the resolved record must pass the gate');
    });
  });

  await testAsync('the shop the search named is preferred over the first seller listed', async () => {
    const sellers = [seller({ name: 'Some Marketplace', direct_link: 'https://www.marketplace.example/p/999' }), seller()];
    await withStubbedFetch(twoEndpointStub(searchPayload([googleOnly()]), { '1234567890': sellers }), async () => {
      const records = await provider.search(intentFor('black hoodie'), { limit: 4 });
      assert.strictEqual(records[0].retailer, 'Nordstrom', 'the card should show the shop the search found');
    });
  });

  await testAsync('a seller with only a redirect link resolves nothing, and the record is dropped', async () => {
    const redirectOnly = [{ name: 'Nordstrom', link: 'https://www.google.com/url?q=https://www.nordstrom.com/s/hoodie/1', base_price: '$68.00' }];
    await withStubbedFetch(twoEndpointStub(searchPayload([googleOnly()]), { '1234567890': redirectOnly }), async () => {
      const records = await provider.search(intentFor('black hoodie'), { limit: 4 });
      assert.strictEqual(records[0].productUrl, undefined);
      assert.strictEqual(records.diagnostics.sellers.noDirectLinkInSellers, 1);
      const { products } = verifyAll(records, { retailer: null });
      assert.strictEqual(products.length, 0, 'a record whose only link is a redirect must not be shown');
    });
  });

  await testAsync('a failed lookup drops one record rather than failing the search', async () => {
    const search = searchPayload([googleOnly(), withDirectLink()]);
    await withStubbedFetch(twoEndpointStub(search, { '1234567890': 'fail' }), async () => {
      const records = await provider.search(intentFor('hoodie'), { limit: 4 });
      assert.strictEqual(records.diagnostics.sellers.lookupsFailed, 1);
      const { products } = verifyAll(records, { retailer: null });
      assert.strictEqual(products.length, 1, 'the record that already had a link must still be shown');
    });
  });

  await testAsync('an unrecognised sellers shape yields nothing, and says what it saw', async () => {
    const stub = (url) => {
      const params = new URL(url).searchParams;
      if (params.get('engine') === 'google_product') return jsonResponse(200, { unexpected_key: { sellers: [] } });
      return jsonResponse(200, searchPayload([googleOnly()]));
    };
    await withStubbedFetch(stub, async () => {
      const records = await provider.search(intentFor('hoodie'), { limit: 4 });
      assert.strictEqual(records.diagnostics.sellers.lookupsEmpty, 1);
      assert.ok(records.diagnostics.sellers.sellersShape, 'the payload shape must be reported so a parsing miss is visible');
      assert.ok(!/gstatic|nordstrom/i.test(records.diagnostics.sellers.sellersShape), 'the shape must carry key names, never values');
    });
  });

  await testAsync('the lookup is skipped entirely when it is switched off', async () => {
    process.env.SERPAPI_RESOLVE_SELLERS = 'off';
    await withStubbedFetch(twoEndpointStub(searchPayload([googleOnly()]), { '1234567890': [seller()] }), async (calls) => {
      const records = await provider.search(intentFor('hoodie'), { limit: 4 });
      assert.strictEqual(records.diagnostics.sellers.skipped, true);
      assert.strictEqual(calls.length, 1, 'only the search request should have been made');
      assert.strictEqual(records.diagnostics.requests.total, 1);
    });
    delete process.env.SERPAPI_RESOLVE_SELLERS;
  });

  console.log('\nwhat a search costs, and what it reports\n');

  await testAsync('every request is counted, because cost per search is computed from it', async () => {
    const results = [googleOnly({ product_id: 'a' }), googleOnly({ product_id: 'b' }), googleOnly({ product_id: 'c' })];
    const sellersById = { a: [seller({ direct_link: 'https://www.nordstrom.com/s/a/1' })], b: [seller({ direct_link: 'https://www.nordstrom.com/s/b/2' })], c: [seller({ direct_link: 'https://www.nordstrom.com/s/c/3' })] };
    await withStubbedFetch(twoEndpointStub(searchPayload(results), sellersById), async (calls) => {
      const records = await provider.search(intentFor('hoodie'), { limit: 12 });
      assert.strictEqual(records.diagnostics.requests.search, 1);
      assert.strictEqual(records.diagnostics.requests.sellers, 3);
      assert.strictEqual(records.diagnostics.requests.total, calls.length);
    });
  });

  await testAsync('lookups stop once enough records have a link', async () => {
    const results = Array.from({ length: 8 }, (_, i) => googleOnly({ product_id: `p${i}` }));
    const sellersById = Object.fromEntries(results.map((r, i) => [`p${i}`, [seller({ direct_link: `https://www.nordstrom.com/s/x/${i}` })]]));
    await withStubbedFetch(twoEndpointStub(searchPayload(results), sellersById), async () => {
      const records = await provider.search(intentFor('hoodie'), { limit: 2 });
      assert.ok(records.diagnostics.requests.sellers <= 4, `wanted at most one batch, made ${records.diagnostics.requests.sellers}`);
    });
  });

  await testAsync('an over-budget record is dropped rather than shown', async () => {
    const search = searchPayload([withDirectLink({ price: '$240.00' }), withDirectLink({ product_id: '9', price: '$40.00', direct_link: 'https://www.nike.com/t/other/9' })]);
    await withStubbedFetch(twoEndpointStub(search, {}), async () => {
      const records = await provider.search(intentFor('hoodie', { maxPrice: 80 }), { limit: 12 });
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].price, 40);
      assert.strictEqual(records.diagnostics.droppedOverBudget, 1);
    });
  });

  await testAsync('a search that parses nothing reports the shape it saw', async () => {
    await withStubbedFetch(() => jsonResponse(200, { search_metadata: { status: 'Success' }, error: undefined, unexpected: [] }), async () => {
      const records = await provider.search(intentFor('hoodie'), { limit: 4 });
      assert.strictEqual(records.length, 0);
      assert.ok(records.diagnostics.searchShape.includes('search_metadata'));
    });
  });

  await testAsync('SerpApi\'s own error is surfaced, not swallowed', async () => {
    await withStubbedFetch(() => jsonResponse(200, { error: "Google hasn't returned any results for this query." }), async () => {
      await assert.rejects(() => provider.search(intentFor('hoodie'), { limit: 4 }), /SerpApi error/);
    });
  });

  await testAsync('an exhausted allowance is named for what it is', async () => {
    await withStubbedFetch(() => jsonResponse(429, { error: 'Your account has run out of searches.' }), async () => {
      await assert.rejects(() => provider.search(intentFor('hoodie'), { limit: 4 }), /allowance exhausted/);
    });
  });

  console.log('\nthe key\n');

  test('the key never appears in a message that could be logged', () => {
    process.env.SERPAPI_API_KEY = 'super-secret-key';
    const message = `https://serpapi.com/search.json?q=hoodie&api_key=super-secret-key failed`;
    assert.ok(!provider.redact(message).includes('super-secret-key'));
    assert.ok(provider.redact(message).includes('***'));
    process.env.SERPAPI_API_KEY = 'test-key-not-real';
  });

  await testAsync('the key travels as a query parameter and nowhere else', async () => {
    await withStubbedFetch(twoEndpointStub(searchPayload([]), {}), async (calls) => {
      await provider.search(intentFor('hoodie'), { limit: 4 });
      const url = new URL(calls[0]);
      assert.strictEqual(url.searchParams.get('api_key'), 'test-key-not-real');
      assert.strictEqual(url.searchParams.get('engine'), 'google_shopping_light');
    });
  });

  test('an unconfigured adapter says so rather than half-working', () => {
    const key = process.env.SERPAPI_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    assert.strictEqual(provider.configured(), false);
    process.env.SERPAPI_API_KEY = key;
    assert.strictEqual(provider.configured(), true);
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
