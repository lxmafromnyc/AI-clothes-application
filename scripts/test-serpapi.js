#!/usr/bin/env node
/* =========================================================
   Fynd — SerpApi prototype adapter test

   Covers the evaluation adapter in api/_providers/serpapi.js. It is not
   wired into production, so these do not run as part of the product
   pipeline suite; they exist so the benchmark is measuring an adapter
   that behaves the way the comparison claims it does.

   Two things matter more than the mapping here:

     - the credential travels in the QUERY STRING, so a leak is one
       console.log away. Several tests exist only to prove it cannot.
     - the adapter must FAIL CLOSED on a link it cannot verify, exactly
       like the OpenWeb Ninja one, or the benchmark would credit SerpApi
       with usable results that are really Google tracking URLs.

   Usage: node scripts/test-serpapi.js
   ========================================================= */

'use strict';

const assert = require('assert');
const serp = require('../api/_providers/serpapi');
const { verifyAll, linkFault } = require('../api/_providers/product-source');

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

/* One shopping result in SerpApi's documented shape. */
const result = (over) => Object.assign({
  position: 1,
  title: "Nike Men's Sportswear Club Fleece Hoodie",
  product_link: 'https://www.google.com/shopping/product/1234567890',
  link: 'https://www.nike.com/t/sportswear-club-fleece-hoodie/BV2654-010',
  product_id: '1234567890',
  source: 'Nike',
  price: '$54.97',
  extracted_price: 54.97,
  thumbnail: 'https://serpapi.com/images/hoodie.jpg',
  rating: 4.7,
  reviews: 812,
  delivery: 'Free delivery',
  extensions: ['Free delivery']
}, over);

const envelope = (results) => ({
  search_metadata: { id: 'x', status: 'Success' },
  search_parameters: { engine: 'google_shopping' },
  shopping_results: results
});

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

function withStubbedFetch(handler, run) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(run()).finally(() => { global.fetch = real; });
}

const hoodieIntent = {
  categories: ['knit'], colors: ['black'], fits: ['oversized'], brands: ['Nike'],
  keywords: ['hoodie'], maxPrice: 80
};

/* ---------------------------------------------------------
   1. The credential never escapes
   --------------------------------------------------------- */

const SECRET = 'sk-serp-DO-NOT-LEAK-abcdef123456';

console.log('\ncredential safety');

test('redactUrl replaces the key rather than trimming it', () => {
  const out = serp.redactUrl(`https://serpapi.com/search.json?engine=google_shopping&api_key=${SECRET}`);
  assert.ok(!out.includes(SECRET), 'the key must not survive redaction');
  assert.ok(!out.includes(SECRET.slice(0, 8)), 'not even a prefix of it');
  assert.ok(out.includes('api_key=REDACTED'));
});

test('redactUrl does not echo an unparseable value', () => {
  assert.strictEqual(serp.redactUrl(`not a url ${SECRET}`), '[unparseable url]');
});

testAsync('an upstream failure reports the status without the request URL', async () => {
  process.env.SERPAPI_API_KEY = SECRET;
  let message = null;
  await withStubbedFetch(
    async () => ({ ok: false, status: 401, text: async () => 'Invalid API key' }),
    async () => {
      try { await serp.search(hoodieIntent, { limit: 12 }); } catch (err) { message = err.message; }
    }
  );
  assert.ok(message, 'it must throw');
  assert.ok(message.includes('401'), 'the status is useful and is kept');
  assert.ok(!message.includes(SECRET), 'the key must not appear in the error');
  assert.ok(!message.includes('serpapi.com/search'), 'nor must the URL that carries it');
});

testAsync('nothing the adapter returns carries the key', async () => {
  process.env.SERPAPI_API_KEY = SECRET;
  const records = await withStubbedFetch(
    async () => okResponse(envelope([result()])),
    () => serp.search(hoodieIntent, { limit: 12 })
  );
  const serialised = JSON.stringify({ records, diagnostics: records.diagnostics });
  assert.ok(!serialised.includes(SECRET), 'no returned field may contain the credential');
});

test('refuses to search without a key rather than calling anonymously', async () => {
  delete process.env.SERPAPI_API_KEY;
  await assert.rejects(() => serp.search(hoodieIntent, { limit: 12 }), /SERPAPI_API_KEY/);
});

/* ---------------------------------------------------------
   2. Fail closed on links it cannot verify
   --------------------------------------------------------- */

console.log('\nlink verification, failing closed');

test('a merchant product URL is accepted', () => {
  assert.strictEqual(
    serp.looksDirect('https://www.nike.com/t/sportswear-club-fleece-hoodie/BV2654-010'),
    'https://www.nike.com/t/sportswear-club-fleece-hoodie/BV2654-010'
  );
});

test('a google.com/aclk tracking link is refused', () => {
  assert.strictEqual(serp.looksDirect('https://www.google.com/aclk?sa=l&adurl=https%3A%2F%2Fnike.com%2Fp'), null);
});

test('any Google host is refused, however product-like the path', () => {
  for (const href of [
    'https://www.google.com/shopping/product/1234567890',
    'https://google.co.uk/shopping/product/1',
    'https://googleadservices.com/pagead/aclk?adurl=https://x.com'
  ]) {
    assert.strictEqual(serp.looksDirect(href), null, href);
  }
});

test('a redirector carrying its destination in a parameter is refused', () => {
  assert.strictEqual(serp.looksDirect('https://track.example.com/go?url=https://nike.com/p/1'), null);
});

test('a non-http scheme is refused', () => {
  assert.strictEqual(serp.looksDirect('javascript:alert(1)'), null);
  assert.strictEqual(serp.looksDirect('ftp://files.example.com/x'), null);
});

test('product_link is never read as a product URL', () => {
  /* the only link is Google's item page: the record must come back
     without a productUrl rather than pointing at a comparison page */
  const record = serp.toRecord(result({ link: undefined }));
  assert.strictEqual(record.productUrl, undefined);
  assert.ok(!JSON.stringify(record).includes('google.com'), 'no Google URL may survive anywhere on the record');
});

test('a record with no usable link keeps no price, retailer or URL to pair with one', () => {
  const record = serp.toRecord(result({ link: 'https://www.google.com/aclk?adurl=https://x.com' }));
  assert.strictEqual(record.productUrl, undefined);
  const { products, rejected } = verifyAll([record], { retailer: null });
  assert.strictEqual(products.length, 0, 'the gate must drop it');
  assert.ok(rejected['missing-product-url'], `expected missing-product-url, got ${JSON.stringify(rejected)}`);
});

/* ---------------------------------------------------------
   3. It maps into Fynd's schema with no frontend change
   --------------------------------------------------------- */

console.log('\nschema fit');

test('a documented result becomes a product the existing gate accepts', () => {
  const record = serp.toRecord(result());
  const { products, rejected } = verifyAll([record], { retailer: null });
  assert.strictEqual(products.length, 1, `expected one product, rejected: ${JSON.stringify(rejected)}`);

  const p = products[0];
  /* exactly the shape assets/products.js normalises and the cards render */
  assert.strictEqual(p.name, "Nike Men's Sportswear Club Fleece Hoodie");
  assert.strictEqual(p.price, 54.97);
  assert.strictEqual(p.currency, 'USD');
  assert.strictEqual(p.imageUrl, 'https://serpapi.com/images/hoodie.jpg');
  assert.strictEqual(p.productUrl, 'https://www.nike.com/t/sportswear-club-fleece-hoodie/BV2654-010');
  assert.strictEqual(p.retailer, 'Nike');
  assert.strictEqual(p.id, '1234567890');
  assert.ok(Array.isArray(p.colors) && Array.isArray(p.sizes));
  assert.strictEqual(linkFault(p.productUrl), null);
});

test('the product shape has exactly the keys the frontend already consumes', () => {
  const { products } = verifyAll([serp.toRecord(result())], { retailer: null });
  const keys = Object.keys(products[0]).sort();
  assert.deepStrictEqual(keys, [
    'category', 'colors', 'currency', 'id', 'imageUrl', 'name', 'price', 'productUrl', 'retailer', 'sizes'
  ], 'no new key, and none missing — the frontend must not need changing');
});

test('the retailer name is never copied into brand', () => {
  const record = serp.toRecord(result());
  assert.strictEqual(record.brand, undefined, 'SerpApi supplies no brand; none may be invented');
  const { products } = verifyAll([record], { retailer: null });
  assert.strictEqual(products[0].brand, undefined, 'and "Nike" the shop must not become "Nike" the brand');
});

test('a price is read from extracted_price and the currency from the symbol', () => {
  const record = serp.toRecord(result({ price: '£42.00', extracted_price: 42 }));
  assert.strictEqual(record.price, 42);
  assert.strictEqual(record.currency, 'GBP', 'a non-USD offer must not be relabelled as dollars');
});

test('a result explicitly out of stock is dropped', () => {
  const record = serp.toRecord(result({ extensions: ['Out of stock'] }));
  const { products, rejected } = verifyAll([record], { retailer: null });
  assert.strictEqual(products.length, 0);
  assert.ok(rejected['out-of-stock']);
});

/* ---------------------------------------------------------
   4. One request, and the query matches the other adapter
   --------------------------------------------------------- */

console.log('\nrequest shape');

(async () => {
  await testAsync('one search makes exactly one request, with no follow-up', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    const calls = [];
    const records = await withStubbedFetch(
      async (url) => { calls.push(String(url)); return okResponse(envelope([result(), result({ product_id: '2' })])); },
      () => serp.search(hoodieIntent, { limit: 12 })
    );
    assert.strictEqual(calls.length, 1, 'no second call may be made');
    assert.strictEqual(records.diagnostics.requests, 1);
    assert.strictEqual(records.diagnostics.offers.skipped, true);
  });

  await testAsync('builds the same phrase as the OpenWeb Ninja adapter for the same intent', async () => {
    const own = require('../api/_providers/openwebninja');
    assert.strictEqual(
      serp.queryFrom(hoodieIntent), own.queryFrom(hoodieIntent),
      'a benchmark comparing two query builders would not be comparing two providers'
    );
  });

  await testAsync('a stated budget becomes a price filter; an unstated one does not', async () => {
    assert.strictEqual(serp.priceFilter({}), null, 'no budget, no filter');
    assert.ok(/ppr_max:80/.test(serp.priceFilter({ maxPrice: 80 })));
    const both = serp.priceFilter({ minPrice: 40, maxPrice: 80 });
    assert.ok(/ppr_min:40/.test(both) && /ppr_max:80/.test(both));
  });

  await testAsync('counts how many records would have needed a second request', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    const mixed = [
      result({ product_id: 'a' }),
      result({ product_id: 'b', link: 'https://www.google.com/aclk?adurl=https://x.com' }),
      result({ product_id: 'c', link: undefined }),
      result({ product_id: 'd' })
    ];
    const records = await withStubbedFetch(
      async () => okResponse(envelope(mixed)),
      () => serp.search({ categories: ['knit'] }, { limit: 12 })
    );
    const d = records.diagnostics;
    assert.strictEqual(d.returnedByProvider, 4);
    assert.strictEqual(d.withInlineLink, 2);
    assert.strictEqual(d.wouldNeedSecondRequest, 2, 'the number that decides one-call vs two-call');
    assert.strictEqual(d.inlineLinkRate, 0.5);
    assert.strictEqual(d.filledPageInOneRequest, false, 'two links is not a page of twelve');
  });

  await testAsync('an offer above the stated budget is dropped', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    const records = await withStubbedFetch(
      async () => okResponse(envelope([
        result({ product_id: 'cheap', price: '$54.00', extracted_price: 54 }),
        result({ product_id: 'dear', price: '$130.00', extracted_price: 130 })
      ])),
      () => serp.search(hoodieIntent, { limit: 12 })
    );
    assert.strictEqual(records.length, 1, 'the $130 result must not survive "under $80"');
    assert.strictEqual(records.diagnostics.droppedOverBudget, 1);
  });

  await testAsync('an unreadable payload is reported as a shape, never as values', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    const records = await withStubbedFetch(
      async () => okResponse({ search_metadata: { status: 'Success' }, error: 'no results' }),
      () => serp.search(hoodieIntent, { limit: 12 })
    );
    assert.strictEqual(records.length, 0);
    assert.ok(records.diagnostics.searchShape.includes('search_metadata'));
    assert.ok(!records.diagnostics.searchShape.includes('no results'), 'key names only, never a value');
  });

  await testAsync('the engine is configurable and defaults to the light one', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    delete process.env.SERPAPI_ENGINE;
    let seen = null;
    await withStubbedFetch(
      async (url) => { seen = new URL(String(url)).searchParams.get('engine'); return okResponse(envelope([result()])); },
      () => serp.search(hoodieIntent, { limit: 12 })
    );
    assert.strictEqual(seen, 'google_shopping_light',
      'the full engine returns no merchant link, so it must not be the default');

    process.env.SERPAPI_ENGINE = 'google_shopping';
    try {
      await withStubbedFetch(
        async (url) => { seen = new URL(String(url)).searchParams.get('engine'); return okResponse(envelope([result()])); },
        () => serp.search(hoodieIntent, { limit: 12 })
      );
      assert.strictEqual(seen, 'google_shopping', 'so the two can be compared rather than argued about');
    } finally {
      delete process.env.SERPAPI_ENGINE;
    }
  });

  await testAsync('a run where no result carries a link field says so, and blames the engine', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    /* exactly what engine=google_shopping returned live: everything but
       a merchant URL, plus an immersive token */
    const noLink = Array.from({ length: 40 }, (_, i) => {
      const r = result({ product_id: `p${i}` });
      delete r.link;
      r.immersive_product_page_token = 'eyJ0b2tlbiI6';
      return r;
    });
    const records = await withStubbedFetch(
      async () => okResponse(envelope(noLink)),
      () => serp.search(hoodieIntent, { limit: 12 })
    );

    assert.strictEqual(records.length, 0);
    const d = records.diagnostics;
    assert.strictEqual(d.returnedByProvider, 40, 'the provider did answer');
    assert.match(d.verdict, /no result carried any of the link fields/);
    assert.match(d.verdict, /wrong engine/);
    assert.strictEqual(d.linkVerdicts.absent, 40);
    assert.strictEqual(d.fieldCoverage.anyLinkField, 0);
    assert.strictEqual(d.fieldCoverage.immersiveTokenOnly, 40,
      'and it names the second-request cost that would follow');
  });

  await testAsync('a run whose links are all Google blames the links, not the engine', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    const googleLinks = Array.from({ length: 10 }, (_, i) =>
      result({ product_id: `p${i}`, link: 'https://www.google.com/aclk?adurl=https://nike.com/p' }));
    const records = await withStubbedFetch(
      async () => okResponse(envelope(googleLinks)),
      () => serp.search(hoodieIntent, { limit: 12 })
    );

    assert.strictEqual(records.length, 0);
    const d = records.diagnostics;
    assert.match(d.verdict, /every link was refused/);
    assert.strictEqual(d.linkVerdicts.redirector + d.linkVerdicts['google-host'], 10);
    assert.strictEqual(d.fieldCoverage.anyLinkField, 10,
      'the field WAS there — a different problem from it being missing');
    assert.ok(!/wrong engine/.test(d.verdict), 'and the engine must not be blamed for it');
  });

  await testAsync('field coverage counts each of the gate\'s five requirements', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    const mixed = [
      result({ product_id: 'full' }),
      result({ product_id: 'no-image', thumbnail: undefined }),
      result({ product_id: 'no-price', price: undefined, extracted_price: undefined }),
      result({ product_id: 'no-shop', source: undefined })
    ];
    const records = await withStubbedFetch(
      async () => okResponse(envelope(mixed)),
      () => serp.search({ categories: ['knit'] }, { limit: 12 })
    );
    const c = records.diagnostics.fieldCoverage;
    assert.strictEqual(c.title, 4);
    assert.strictEqual(c.price, 3);
    assert.strictEqual(c.image, 3);
    assert.strictEqual(c.retailer, 3);
    assert.strictEqual(c.anyLinkField, 4);
  });

  await testAsync('a healthy run reports verdict ok', async () => {
    process.env.SERPAPI_API_KEY = SECRET;
    const records = await withStubbedFetch(
      async () => okResponse(envelope(Array.from({ length: 20 }, (_, i) =>
        result({ product_id: `p${i}`, link: `https://www.nike.com/t/hoodie-${i}` })))),
      () => serp.search({ categories: ['knit'] }, { limit: 12 })
    );
    assert.strictEqual(records.diagnostics.verdict, 'ok');
    assert.strictEqual(records.diagnostics.filledPageInOneRequest, true);
    assert.strictEqual(records.diagnostics.inlineLinkRate, 1);
  });

  await testAsync('it is NOT registered as a selectable production provider', async () => {
    const { getProvider } = require('../api/_providers/product-source');
    const before = process.env.PRODUCT_SOURCE;
    process.env.PRODUCT_SOURCE = 'serpapi';
    try {
      const provider = getProvider();
      assert.notStrictEqual(provider.name, 'serpapi',
        'the prototype must not be reachable by setting PRODUCT_SOURCE');
    } finally {
      if (before === undefined) delete process.env.PRODUCT_SOURCE; else process.env.PRODUCT_SOURCE = before;
    }
  });

  delete process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_ENGINE;
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
