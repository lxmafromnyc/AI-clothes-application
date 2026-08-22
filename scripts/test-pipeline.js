#!/usr/bin/env node
/* =========================================================
   FindWear — product pipeline test

   Exercises the whole server side of a search without touching the
   network: interpreted intent -> adapter query -> provider response ->
   verification gate -> the JSON the browser receives.

   The provider's HTTP call is stubbed with a payload in the shape the
   OpenWeb Ninja Real-Time Product Search API documents, so what is being
   tested is FindWear's handling of it — the mapping, the gate, and the
   rules about which links and which missing fields are unacceptable.

   A live check of the real response shape is a separate script:
     OPENWEBNINJA_API_KEY=... node scripts/probe-openwebninja.js

   Usage: node scripts/test-pipeline.js
   ========================================================= */

'use strict';

const assert = require('assert');
const provider = require('../api/providers/openwebninja');
const { verifyAll, linkFault } = require('../api/providers/product-source');

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

const product = (over) => Object.assign({
  product_id: 'p1',
  product_title: 'Champion Reverse Weave Oversized Hoodie, Black',
  product_photos: ['https://img.example-cdn.com/champion/hoodie-black-1.jpg'],
  product_page_url: 'https://www.google.com/shopping/product/111',
  product_attributes: { Brand: 'Champion', Material: 'Cotton blend' },
  offer: {
    store_name: 'Nordstrom',
    price: '$68.00',
    offer_page_url: 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321',
    product_condition: 'NEW'
  }
}, over);

const envelope = (products) => ({ status: 'OK', request_id: 'req-1', data: products });

/* ---------------------------------------------------------
   1. Intent -> query
   --------------------------------------------------------- */

console.log('\nprovider selection');

const { getProvider, DEFAULT_SOURCE } = require('../api/providers/product-source');

const selectWith = (env) => {
  const saved = {};
  ['PRODUCT_SOURCE', 'OPENWEBNINJA_API_KEY', 'ETSY_API_KEY'].forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env);
  try { return getProvider(); }
  finally {
    ['PRODUCT_SOURCE', 'OPENWEBNINJA_API_KEY', 'ETSY_API_KEY'].forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
  }
};

test('the key alone is enough to go live — PRODUCT_SOURCE is optional', () => {
  assert.strictEqual(selectWith({ OPENWEBNINJA_API_KEY: 'k' }).name, 'openwebninja');
});

test('naming the default explicitly selects the same provider', () => {
  assert.strictEqual(selectWith({ PRODUCT_SOURCE: 'openwebninja', OPENWEBNINJA_API_KEY: 'k' }).name, 'openwebninja');
});

test('no key and no setting selects nothing, so /api/search answers 503', () => {
  const p = selectWith({});
  assert.strictEqual(p.name, 'none');
  assert.strictEqual(p.configured(), false);
});

test('Etsy is never selected unless it is asked for by name', () => {
  assert.notStrictEqual(selectWith({ ETSY_API_KEY: 'k' }).name, 'etsy');
  assert.strictEqual(selectWith({ PRODUCT_SOURCE: 'etsy', ETSY_API_KEY: 'k' }).name, 'etsy');
});

test('a misspelt PRODUCT_SOURCE selects nothing rather than silently defaulting', () => {
  assert.strictEqual(selectWith({ PRODUCT_SOURCE: 'openwebninjaa', OPENWEBNINJA_API_KEY: 'k' }).name, 'none');
});

test('the default source is the OpenWeb Ninja adapter', () => {
  assert.strictEqual(DEFAULT_SOURCE, 'openwebninja');
});

console.log('\nintent -> search query');

/* what /api/interpret produces for "black oversized Nike hoodie under $80" */
const nikeIntent = {
  categories: ['hoodie'], colors: ['black'], occasions: [], fits: ['oversized'],
  brands: ['Nike'], styles: [], keywords: ['hoodie', 'black'],
  maxPrice: 80, minPrice: null, season: null, gender: null
};

test('reads as a shopper would type it', () => {
  assert.strictEqual(provider.queryFrom(nikeIntent), 'black oversized nike hoodie');
});

test('duplicate keywords do not repeat in the query', () => {
  assert.strictEqual((provider.queryFrom(nikeIntent).match(/hoodie/g) || []).length, 1);
});

test('gender leads the phrase when the request stated one', () => {
  assert.strictEqual(
    provider.queryFrom({ gender: 'women', colors: ['black'], categories: ['hoodie'] }),
    'women black hoodie'
  );
});

test('season is left out of the query', () => {
  assert.strictEqual(provider.queryFrom({ categories: ['coat'], season: 'fall' }), 'coat');
});

test('an empty intent produces an empty query, not an invented one', () => {
  assert.strictEqual(provider.queryFrom({}), '');
});

/* ---------------------------------------------------------
   2. Mapping one product
   --------------------------------------------------------- */

console.log('\nproduct -> record');

test('maps the six displayed fields off the product and its own offer', () => {
  const r = provider.toRecord(product());
  assert.strictEqual(r.title, 'Champion Reverse Weave Oversized Hoodie, Black');
  assert.strictEqual(r.imageUrl, 'https://img.example-cdn.com/champion/hoodie-black-1.jpg');
  assert.strictEqual(r.price, 68);
  assert.strictEqual(r.retailer, 'Nordstrom');
  assert.strictEqual(r.productUrl, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321');
  assert.strictEqual(r.brand, 'Champion');
});

test('never uses the Google Shopping page as the product URL', () => {
  const r = provider.toRecord(product({ offer: undefined }));
  assert.strictEqual(r.productUrl, undefined, 'a product with no offer must have no product URL');
  assert.ok(!JSON.stringify(r).includes('google.com'), 'no Google URL may survive into a record');
});

test('reads brand out of product_attributes when there is no brand field', () => {
  assert.strictEqual(provider.brandFrom(product()), 'Champion');
});

test('omits brand rather than borrowing the retailer name', () => {
  const r = provider.toRecord(product({ product_attributes: { Material: 'Fleece' } }));
  assert.strictEqual(r.brand, undefined);
  assert.strictEqual(r.retailer, 'Nordstrom');
});

test('reads the currency off the price rather than assuming dollars', () => {
  assert.strictEqual(provider.currencyFrom('£49.99'), 'GBP');
  assert.strictEqual(provider.currencyFrom('$68.00'), 'USD');
  assert.strictEqual(provider.currencyFrom('49.99'), undefined);
});

test('parses prices with separators and currency codes', () => {
  assert.strictEqual(provider.toPrice('$1,299.00'), 1299);
  assert.strictEqual(provider.toPrice('79.99 USD'), 79.99);
  assert.strictEqual(provider.toPrice('Out of stock'), null);
  assert.strictEqual(provider.toPrice(0), null);
});

test('takes the first usable photo, and none at all when there are none', () => {
  assert.strictEqual(provider.imageFrom({ product_photos: [] }), null);
  assert.strictEqual(provider.imageFrom({ product_photos: ['', 'https://a/b.jpg'] }), 'https://a/b.jpg');
});

/* ---------------------------------------------------------
   3. The property the provider was chosen for
   --------------------------------------------------------- */

console.log('\nimage and product URL belong to the same product');

test('each record keeps its own photo and its own link', () => {
  const batch = [
    product({ product_id: 'a', product_photos: ['https://img/a.jpg'], offer: { store_name: 'Target', price: '$40.00', offer_page_url: 'https://www.target.com/p/a/-/A-111' } }),
    product({ product_id: 'b', product_photos: ['https://img/b.jpg'], offer: { store_name: 'Walmart', price: '$45.00', offer_page_url: 'https://www.walmart.com/ip/b/222' } })
  ];
  const records = batch.map(provider.toRecord);
  assert.strictEqual(records[0].imageUrl, 'https://img/a.jpg');
  assert.strictEqual(records[0].productUrl, 'https://www.target.com/p/a/-/A-111');
  assert.strictEqual(records[1].imageUrl, 'https://img/b.jpg');
  assert.strictEqual(records[1].productUrl, 'https://www.walmart.com/ip/b/222');
});

test('a product with photos but no offer yields no link, not another product\'s', () => {
  const batch = [
    product({ product_id: 'a', product_photos: ['https://img/a.jpg'], offer: undefined }),
    product({ product_id: 'b', product_photos: ['https://img/b.jpg'] })
  ];
  const records = batch.map(provider.toRecord);
  assert.strictEqual(records[0].productUrl, undefined);
  assert.strictEqual(records[1].productUrl, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321');
});

test('price, retailer and link always come from one and the same offer', () => {
  const r = provider.toRecord(product({
    offer: { store_name: 'REI', price: '$88.50', offer_page_url: 'https://www.rei.com/product/999/hoodie' },
    offers: [{ store_name: 'Zappos', price: '$12.00', offer_page_url: 'https://www.zappos.com/p/other' }]
  }));
  assert.strictEqual(r.retailer, 'REI');
  assert.strictEqual(r.price, 88.5);
  assert.strictEqual(r.productUrl, 'https://www.rei.com/product/999/hoodie');
});

/* ---------------------------------------------------------
   4. The verification gate
   --------------------------------------------------------- */

console.log('\nverification gate');

const gate = (records) => verifyAll(records, { retailer: provider.defaultRetailer });

test('a complete record passes', () => {
  const { products, rejected } = gate([provider.toRecord(product())]);
  assert.strictEqual(products.length, 1);
  assert.deepStrictEqual(rejected, {});
  assert.strictEqual(products[0].retailer, 'Nordstrom');
});

test('a record with no brand still passes, and carries no brand key', () => {
  const { products } = gate([provider.toRecord(product({ product_attributes: {} }))]);
  assert.strictEqual(products.length, 1);
  assert.ok(!('brand' in products[0]), 'brand must be absent, not empty');
});

[
  ['missing title', { product_title: '' }, 'missing-title'],
  ['missing image', { product_photos: [] }, 'missing-image-url'],
  ['missing price', { offer: { store_name: 'Target', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-price'],
  ['missing retailer', { offer: { price: '$20.00', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-retailer'],
  ['missing product URL', { offer: { store_name: 'Target', price: '$20.00' } }, 'missing-product-url'],
  ['zero price', { offer: { store_name: 'Target', price: '$0.00', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-price'],
  ['unparseable price', { offer: { store_name: 'Target', price: 'see site', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-price']
].forEach(([label, over, reason]) => {
  test(`rejects a record with a ${label}`, () => {
    const { products, rejected } = gate([provider.toRecord(product(over))]);
    assert.strictEqual(products.length, 0, 'nothing may pass');
    assert.strictEqual(rejected[reason], 1, `expected ${reason}, got ${JSON.stringify(rejected)}`);
  });
});

[
  ['a Google Shopping page', 'https://www.google.com/shopping/product/111', 'product-url-not-a-retailer-page'],
  ['a Google ad click', 'https://www.googleadservices.com/pagead/aclk?adurl=https%3A%2F%2Fshop.com%2Fp', 'product-url-not-a-retailer-page'],
  ['a redirector', 'https://www.example.com/aclk?u=https://shop.com/p/1', 'product-url-is-a-redirect'],
  ['a homepage', 'https://www.uniqlo.com/', 'product-url-not-a-product-page'],
  ['a search listing', 'https://www.uniqlo.com/search', 'product-url-not-a-product-page'],
  ['a category listing', 'https://www.uniqlo.com/collections', 'product-url-not-a-product-page']
].forEach(([label, url, reason]) => {
  test(`rejects ${label} as the product URL`, () => {
    const record = provider.toRecord(product({ offer: { store_name: 'Shop', price: '$20.00', offer_page_url: url } }));
    const { products, rejected } = gate([record]);
    assert.strictEqual(products.length, 0);
    assert.strictEqual(rejected[reason], 1, `expected ${reason}, got ${JSON.stringify(rejected)}`);
  });
});

test('keeps a real product URL that carries a tracking parameter', () => {
  assert.strictEqual(linkFault('https://www.gap.com/browse/product.do?pid=525built&returnUrl=https://www.gap.com/cart'), null);
});

test('two products sharing a URL are counted once', () => {
  const records = [provider.toRecord(product()), provider.toRecord(product({ product_id: 'p2' }))];
  const { products } = gate(records);
  assert.strictEqual(products.length, 1);
});

/* ---------------------------------------------------------
   5. The adapter's request, and the budget
   --------------------------------------------------------- */

console.log('\nadapter request');

function withStubbedFetch(handler, run) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(run()).finally(() => { global.fetch = real; });
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

(async () => {
  await testAsync('sends the query, the budget and the key as x-api-key', async () => {
    let seen = null;
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    await withStubbedFetch(async (url, init) => { seen = { url, init }; return okResponse(envelope([product()])); },
      () => provider.search(nikeIntent, { limit: 12 }));

    const url = new URL(seen.url);
    assert.strictEqual(url.origin + url.pathname, provider.SEARCH_URL);
    assert.strictEqual(url.searchParams.get('q'), 'black oversized nike hoodie');
    assert.strictEqual(url.searchParams.get('max_price'), '80');
    assert.strictEqual(url.searchParams.get('country'), 'us');
    assert.strictEqual(seen.init.headers['x-api-key'], 'test-key');
    assert.ok(!seen.url.includes('test-key'), 'the key must not travel in the query string');
  });

  await testAsync('never sends a limit above the endpoint maximum', async () => {
    let seen = null;
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    await withStubbedFetch(async (url) => { seen = url; return okResponse(envelope([])); },
      () => provider.search(nikeIntent, { limit: 100 }));
    assert.ok(Number(new URL(seen).searchParams.get('limit')) <= 120);
  });

  await testAsync('drops an offer above the stated budget', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    const records = await withStubbedFetch(
      async () => okResponse(envelope([
        product({ product_id: 'cheap', offer: { store_name: 'Target', price: '$54.00', offer_page_url: 'https://www.target.com/p/a/-/A-1' } }),
        product({ product_id: 'dear', offer: { store_name: 'Target', price: '$130.00', offer_page_url: 'https://www.target.com/p/b/-/A-2' } })
      ])),
      () => provider.search(nikeIntent, { limit: 12 }));
    assert.strictEqual(records.length, 1, 'the $130 offer must not survive "under $80"');
    assert.strictEqual(records[0].price, 54);
  });

  await testAsync('surfaces an upstream failure instead of returning nothing quietly', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    await assert.rejects(
      withStubbedFetch(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
        () => provider.search(nikeIntent, { limit: 12 })),
      /429/
    );
  });

  await testAsync('refuses to search without a key', async () => {
    delete process.env.OPENWEBNINJA_API_KEY;
    await assert.rejects(() => provider.search(nikeIntent, { limit: 12 }), /OPENWEBNINJA_API_KEY/);
  });

  /* -------------------------------------------------------
     6. End to end through /api/search
     ------------------------------------------------------- */

  console.log('\n/api/search end to end');

  function fakeRes() {
    const res = { statusCode: null, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.end = () => res;
    return res;
  }

  const callSearch = async (intent, payload) => {
    /* required in here so the provider registry reads the env we just set */
    const handler = require('../api/search');
    const res = fakeRes();
    await withStubbedFetch(async () => okResponse(payload),
      () => handler({ method: 'POST', body: { intent, limit: 12 }, on: () => {} }, res));
    return res;
  };

  await testAsync('answers 503, not a fabricated product, when no source is configured', async () => {
    delete process.env.OPENWEBNINJA_API_KEY;
    process.env.PRODUCT_SOURCE = 'openwebninja';
    const res = await callSearch(nikeIntent, envelope([product()]));
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { error: 'No product source is configured.', source: null });
  });

  await testAsync('"black oversized hoodie under $80" reaches the browser as real records', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.PRODUCT_SOURCE = 'openwebninja';

    const payload = envelope([
      product({
        product_id: '1', product_title: 'Champion Reverse Weave Oversized Hoodie, Black',
        product_photos: ['https://img.example-cdn.com/champion-black.jpg'],
        offer: { store_name: 'Nordstrom', price: '$68.00', offer_page_url: 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321' }
      }),
      product({
        product_id: '2', product_title: "Hanes ComfortWash Garment Dyed Hoodie, Black",
        product_photos: ['https://img.example-cdn.com/hanes-black.jpg'],
        product_attributes: {},
        offer: { store_name: 'Walmart', price: '$24.98', offer_page_url: 'https://www.walmart.com/ip/Hanes-ComfortWash-Hoodie/558123456' }
      }),
      /* these three must not reach the browser */
      product({ product_id: '3', offer: { store_name: 'Google', price: '$50.00', offer_page_url: 'https://www.google.com/shopping/product/999' } }),
      product({ product_id: '4', product_photos: [], offer: { store_name: 'Target', price: '$30.00', offer_page_url: 'https://www.target.com/p/x/-/A-9' } }),
      product({ product_id: '5', offer: { store_name: 'Saks', price: '$240.00', offer_page_url: 'https://www.saks.com/product/hoodie-0400012345678' } })
    ]);

    const res = await callSearch(nikeIntent, payload);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.source, 'openwebninja');

    const products = res.body.products;
    assert.strictEqual(products.length, 2, `expected 2 verified products, got ${products.length}`);

    /* the over-budget item was dropped before the gate, the Google link
       and the image-less record by the gate */
    assert.strictEqual(res.body.rejected['product-url-not-a-retailer-page'], 1);
    assert.strictEqual(res.body.rejected['missing-image-url'], 1);

    products.forEach((p) => {
      assert.ok(p.name, 'every card needs a title');
      assert.ok(/^https:\/\//.test(p.imageUrl), 'every card needs an absolute image URL');
      assert.ok(typeof p.price === 'number' && p.price > 0, 'every card needs a real price');
      assert.ok(p.retailer, 'every card names its retailer');
      assert.ok(/^https:\/\//.test(p.productUrl), 'every card links to a page');
      assert.strictEqual(linkFault(p.productUrl), null, 'every link is a retailer product page');
      assert.ok(p.price <= 80, 'nothing over the stated budget');
      assert.ok(!/google\./i.test(p.productUrl), 'no Google URL reaches the browser');
    });

    /* the pairing survives the whole pipeline */
    const nordstrom = products.find((p) => p.retailer === 'Nordstrom');
    assert.strictEqual(nordstrom.imageUrl, 'https://img.example-cdn.com/champion-black.jpg');
    assert.strictEqual(nordstrom.productUrl, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321');
    assert.strictEqual(nordstrom.brand, 'Champion');

    const walmart = products.find((p) => p.retailer === 'Walmart');
    assert.strictEqual(walmart.imageUrl, 'https://img.example-cdn.com/hanes-black.jpg');
    assert.strictEqual(walmart.productUrl, 'https://www.walmart.com/ip/Hanes-ComfortWash-Hoodie/558123456');
    assert.ok(!('brand' in walmart), 'a brandless product still shows, without a brand');
  });

  await testAsync('an empty upstream answer returns no products rather than invented ones', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.PRODUCT_SOURCE = 'openwebninja';
    const res = await callSearch(nikeIntent, envelope([]));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.products, []);
  });

  await testAsync('a provider failure answers 502 without leaking the key or the upstream body', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.PRODUCT_SOURCE = 'openwebninja';
    const handler = require('../api/search');
    const res = fakeRes();
    await withStubbedFetch(async () => ({ ok: false, status: 500, text: async () => 'upstream detail with test-key' }),
      () => handler({ method: 'POST', body: { intent: nikeIntent, limit: 12 }, on: () => {} }, res));
    assert.strictEqual(res.statusCode, 502);
    assert.ok(!JSON.stringify(res.body).includes('test-key'));
    assert.ok(!JSON.stringify(res.body).includes('upstream detail'));
  });

  /* -------------------------------------------------------
     7. What the page is allowed to show
     -------------------------------------------------------
     The sample catalogue may stand in only when nothing is connected.
     Once a source IS configured, a failed or empty search must say so
     rather than pad the page with demo rows. assets/search.js decides
     that, so it is loaded here and driven directly. */

  console.log('\nclient search states');

  const loadClient = () => {
    const g = { fetch: null, AbortController, setTimeout, clearTimeout, FINDWEAR_SEARCH_API: 'http://test/api/search' };
    const src = require('fs').readFileSync(require('path').join(__dirname, '../assets/search.js'), 'utf8');
    new Function('window', 'globalThis', `${src}`).call(g, g, g);
    return g.ProductSearch;
  };

  const clientAnswer = async (fetchImpl) => {
    const client = loadClient();
    const realFetch = global.fetch;
    global.fetch = fetchImpl;
    try { return await client.find({ categories: ['hoodie'] }, 12); }
    finally { global.fetch = realFetch; }
  };

  const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  await testAsync('verified products come back as state "ok"', async () => {
    const r = await clientAnswer(async () => jsonResponse(200, { source: 'openwebninja', products: [{ name: 'Hoodie', productUrl: 'https://shop.com/p/1' }] }));
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.products.length, 1);
  });

  await testAsync('503 is the only state that permits the sample catalogue', async () => {
    const r = await clientAnswer(async () => jsonResponse(503, { error: 'No product source is configured.' }));
    assert.strictEqual(r.state, 'not-configured');
  });

  await testAsync('a configured source that fails is "unavailable", not "not-configured"', async () => {
    const r = await clientAnswer(async () => jsonResponse(502, { error: 'unavailable' }));
    assert.strictEqual(r.state, 'unavailable', 'samples must not be shown for a 502');
    assert.ok(r.notice && !/sample/i.test(r.notice), 'the notice must not promise sample items');
  });

  await testAsync('an unreachable endpoint is "unavailable" rather than assumed unconfigured', async () => {
    const r = await clientAnswer(async () => { throw new Error('network down'); });
    assert.strictEqual(r.state, 'unavailable');
  });

  await testAsync('a source answering with nothing verifiable is "empty"', async () => {
    const r = await clientAnswer(async () => jsonResponse(200, { source: 'openwebninja', products: [], rejected: { 'missing-image-url': 3 } }));
    assert.strictEqual(r.state, 'empty');
    assert.strictEqual(r.products.length, 0);
    assert.deepStrictEqual(r.rejected, { 'missing-image-url': 3 });
  });

  await testAsync('no state but "not-configured" ever promises sample items', async () => {
    for (const [label, impl] of [
      ['502', async () => jsonResponse(502, {})],
      ['network failure', async () => { throw new Error('down'); }],
      ['empty result', async () => jsonResponse(200, { source: 'openwebninja', products: [] })]
    ]) {
      const r = await clientAnswer(impl);
      assert.ok(!/sample/i.test(r.notice || ''), `${label} must not offer sample items`);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
