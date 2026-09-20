#!/usr/bin/env node
/* =========================================================
   Fynd — Serper adapter test

   Serper is the fallback discovery source: SerpApi stays primary, and
   this is asked only after SerpApi reports its search allowance gone.
   That makes one property worth more than any other here, and it is
   what most of this file is about — a listing from the fallback is not
   privileged in any direction. It is mapped by the same rules, dropped
   by the same gate, and linked only where the source supplied a
   retailer URL of its own.

   The network is never touched. A stubbed response in the shape
   serper.dev documents for /shopping goes through the adapter's
   mapping and then through the verification gate in
   _providers/product-source.js, which is the same gate every other
   adapter answers to.

   Usage: node scripts/test-serper.js
   ========================================================= */

'use strict';

const assert = require('assert');
const provider = require('../api/_providers/serper');
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
   Fixtures, in the shape serper.dev documents for /shopping
   --------------------------------------------------------- */

const SHOPPING = {
  shopping: [
    {
      title: 'Nike Sportswear Club Fleece Joggers',
      source: 'Nike',
      link: 'https://www.nike.com/t/sportswear-club-fleece-joggers-1A2B3C/BV2679-010',
      price: '$62.97',
      imageUrl: 'https://static.nike.com/a/images/bv2679-010.jpg',
      productId: 'BV2679010',
      position: 1
    },
    {
      /* Google's own link, which the gate refuses: a comparison page is
         not a retailer's product page, whichever source offered it */
      title: 'Fleece Sweatpants',
      source: 'Google Shopping',
      link: 'https://www.google.com/shopping/product/1234567890',
      price: '$40.00',
      imageUrl: 'https://encrypted-tbn0.gstatic.com/x.jpg',
      position: 2
    },
    {
      /* no link at all: dropped rather than linked to something else */
      title: 'Unlinked Fleece Jogger',
      source: 'Somewhere',
      price: '$35.00',
      imageUrl: 'https://cdn.example.com/jogger.jpg',
      position: 3
    }
  ]
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
  text: async () => JSON.stringify(body)
});

function withStubbedFetch(handler, run) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls);
  };
  return Promise.resolve(run(calls)).finally(() => { global.fetch = original; });
}

(async () => {
  console.log('\nSerper adapter\n');

  const KEY = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'test-serper-key-000000000000000000';

  /* ---------------------------------------------------------
     Success
     --------------------------------------------------------- */

  await testAsync('a shopping result becomes a record, and the gate keeps the linked one', async () => {
    await withStubbedFetch(() => jsonResponse(200, SHOPPING), async (calls) => {
      const records = await provider.search({ keywords: ['Fleece Sweatpant'] }, { limit: 8 });

      assert.strictEqual(calls.length, 1, 'one request, one endpoint');
      assert.strictEqual(calls[0].url, provider.SEARCH_URL);
      assert.strictEqual(calls[0].options.method, 'POST');
      assert.strictEqual(calls[0].options.headers['X-API-KEY'], process.env.SERPER_API_KEY);
      assert.deepStrictEqual(JSON.parse(calls[0].options.body).q, 'fleece sweatpant');

      /* all three map; it is the GATE that decides which may be shown */
      assert.strictEqual(records.length, 3);
      const nike = records[0];
      assert.strictEqual(nike.title, 'Nike Sportswear Club Fleece Joggers');
      assert.strictEqual(nike.productUrl, SHOPPING.shopping[0].link);
      assert.strictEqual(nike.price, 62.97);
      assert.strictEqual(nike.currency, 'USD');
      assert.strictEqual(nike.retailer, 'Nike');

      const { products, rejected } = verifyAll(records, { retailer: null });
      assert.strictEqual(products.length, 1, 'only the retailer-linked listing may be shown');
      assert.strictEqual(products[0].productUrl, SHOPPING.shopping[0].link);
      assert.ok(Object.keys(rejected).length, 'and the gate says why it dropped the other two');
    });
  });

  test('the seller is never promoted into the brand field', () => {
    /* Serper names the shop, not the maker. Putting "Nike" in `brand`
       because it is in `source` would be a fabricated attribution, which
       is the one thing the record contract forbids outright. */
    const record = provider.toRecord(SHOPPING.shopping[0]);
    assert.strictEqual(record.brand, undefined);
    assert.strictEqual(record.retailer, 'Nike');
  });

  test('a price is read, never inferred', () => {
    assert.strictEqual(provider.toPrice('$34.97'), 34.97);
    assert.strictEqual(provider.toPrice('£1,299.00'), 1299);
    assert.strictEqual(provider.toPrice(62.97), 62.97);
    for (const nothing of ['', null, undefined, 'Sold out', 0, -5]) {
      assert.strictEqual(provider.toPrice(nothing), null, `${JSON.stringify(nothing)} is not an amount`);
    }
    assert.strictEqual(provider.currencyFrom('£19.99'), 'GBP');
    assert.strictEqual(provider.currencyFrom('€19.99'), 'EUR');
    assert.strictEqual(provider.currencyFrom('19.99'), null, 'a bare number names no currency');
  });

  test('a result that is not a result becomes no record at all', () => {
    for (const junk of [null, undefined, 'a string', 42, [], {}]) {
      assert.strictEqual(provider.toRecord(junk), null, `${JSON.stringify(junk)} should map to nothing`);
    }
  });

  test('an empty or unexpected payload reads as no results, not as a crash', () => {
    for (const payload of [null, undefined, {}, { shopping: null }, { organic: [] }, 'nope']) {
      assert.deepStrictEqual(provider.resultsFrom(payload), []);
    }
    assert.strictEqual(provider.resultsFrom({ shoppingResults: [{ title: 'x' }] }).length, 1,
      'the same array under the other name Serper uses');
  });

  /* ---------------------------------------------------------
     Quota and errors
     --------------------------------------------------------- */

  await testAsync('a 429 names the allowance rather than reading as a bug', async () => {
    await withStubbedFetch(() => jsonResponse(429, { message: 'Not enough credits' }), async () => {
      await assert.rejects(
        () => provider.search({ keywords: ['Fleece Sweatpant'] }, { limit: 8 }),
        (err) => {
          assert.match(err.message, /429/);
          assert.match(err.message, /allowance exhausted/i);
          return true;
        }
      );
    });
  });

  await testAsync('an error status is reported, and never as an empty result set', async () => {
    for (const status of [400, 401, 403, 500, 502]) {
      await withStubbedFetch(() => jsonResponse(status, { message: 'no' }), async () => {
        await assert.rejects(
          () => provider.search({ keywords: ['x'] }, { limit: 4 }),
          new RegExp(`Serper responded ${status}`),
          `${status} should reject rather than resolve to []`
        );
      });
    }
  });

  await testAsync('a 200 carrying an error string is still an error', async () => {
    await withStubbedFetch(() => jsonResponse(200, { error: 'Unauthorized' }), async () => {
      await assert.rejects(() => provider.search({ keywords: ['x'] }, { limit: 4 }), /Serper error: Unauthorized/);
    });
  });

  await testAsync('the key never reaches an error message', async () => {
    await withStubbedFetch(() => jsonResponse(500, { message: `bad key ${process.env.SERPER_API_KEY}` }), async () => {
      await assert.rejects(
        () => provider.search({ keywords: ['x'] }, { limit: 4 }),
        (err) => {
          assert.doesNotMatch(err.message, new RegExp(process.env.SERPER_API_KEY), 'the key leaked into an error');
          assert.match(err.message, /<redacted>/);
          return true;
        }
      );
    });
  });

  test('an unconfigured adapter says so rather than half-working', () => {
    const key = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;
    assert.strictEqual(provider.configured(), false);
    process.env.SERPER_API_KEY = key;
    assert.strictEqual(provider.configured(), true);
  });

  await testAsync('with no key set, it refuses rather than calling out', async () => {
    const key = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;
    await withStubbedFetch(() => jsonResponse(200, SHOPPING), async (calls) => {
      await assert.rejects(() => provider.search({ keywords: ['x'] }, { limit: 4 }), /SERPER_API_KEY is not set/);
      assert.strictEqual(calls.length, 0, 'it must not reach the network without a key');
    });
    process.env.SERPER_API_KEY = key;
  });

  if (KEY === undefined) delete process.env.SERPER_API_KEY;
  else process.env.SERPER_API_KEY = KEY;

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
