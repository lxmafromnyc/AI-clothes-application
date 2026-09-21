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
const { verifyAll, linkFault, isProductPage } = require('../api/_providers/product-source');

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
     The retailer's URL

     The property this section exists for: `link` on a Serper shopping
     result is as often Google's own card as it is the shop's page, and
     a run against the current surface got the card every time. The
     mapping has to find the shop's URL where the response actually
     carries it, and has to come back with NOTHING when the response
     carries none — never with Google's page, and never by relaxing
     anything the gate asks for.
     --------------------------------------------------------- */

  /* the shape a live run returned: Google's shopping card, which is a
     comparison page and not a product page */
  const GOOGLE_CARD = 'https://www.google.com/search?ibp=oshop_%3A%3Apid%3D14954523421963213331%3A%3Aoid%3D9';

  const cardedResult = (i) => ({
    title: `Fleece Jogger ${i}`,
    source: 'A Shop',
    link: `${GOOGLE_CARD}&n=${i}`,
    price: '$48.00',
    imageUrl: `https://encrypted-tbn0.gstatic.com/shopping?q=${i}`,
    productId: `pid-${i}`,
    offers: '4',
    position: i
  });

  const SHOP_LINKED = {
    title: 'Champion Powerblend Fleece Jogger',
    source: 'Champion',
    link: 'https://www.champion.com/products/powerblend-fleece-jogger-p1234',
    price: '$45.00',
    imageUrl: 'https://cdn.champion.com/p1234.jpg',
    productId: 'P1234',
    position: 20
  };

  /* nineteen carded rows and one that names a shop — the run that
     reported nothing verified, reproduced */
  const LIVE = { shopping: [...Array.from({ length: 19 }, (_, i) => cardedResult(i + 1)), SHOP_LINKED] };

  test('a shopping result becomes a real retailer product URL', () => {
    /* 1. the shop's URL in `link`, which is the easy case */
    assert.strictEqual(
      provider.toRecord(SHOP_LINKED).productUrl,
      'https://www.champion.com/products/powerblend-fleece-jogger-p1234'
    );

    /* 2. Google's card in `link`, the shop's URL in a field beside it.
          Each of these is read, in this order of explicitness, and the
          card is never what wins. */
    const beside = [
      ['productLink', 'https://www.uniqlo.com/us/en/products/E460318-000'],
      ['offerLink', 'https://www.gap.com/browse/product.do?pid=502587002'],
      ['merchantLink', 'https://www.jcrew.com/p/BX291'],
      ['seller_link', 'https://shop.lululemon.com/p/men-joggers/ABC-Jogger/_/prod9750561']
    ];
    for (const [field, url] of beside) {
      const record = provider.toRecord({ ...cardedResult(1), [field]: url });
      assert.strictEqual(record.productUrl, url, `${field} should be read for the retailer URL`);
    }

    /* 3. the shop's URL inside the result's own offer or seller object.
          `offers` is a COUNT on a Serper result ("4"), so a string there
          must not throw and must not be mistaken for an offer. */
    assert.strictEqual(
      provider.toRecord({ ...cardedResult(1), offers: [{ source: 'Nordstrom', link: 'https://www.nordstrom.com/s/jogger/7654321' }] }).productUrl,
      'https://www.nordstrom.com/s/jogger/7654321'
    );
    assert.strictEqual(
      provider.toRecord({ ...cardedResult(1), seller: { name: 'Madewell', url: 'https://www.madewell.com/p/NK123.html' } }).productUrl,
      'https://www.madewell.com/p/NK123.html'
    );
    assert.strictEqual(provider.toRecord({ ...cardedResult(1), offers: '4' }).productUrl, undefined,
      'a count is not an offer');

    /* 4. a Google forwarder, which carries the shop's URL verbatim in
          its own query string. Reading it out is reading the response,
          not repairing a link. */
    assert.strictEqual(
      provider.retailerUrl('https://www.google.com/url?q=https%3A%2F%2Fwww.uniqlo.com%2Fus%2Fen%2Fproducts%2FE460318-000&sa=U', 0),
      'https://www.uniqlo.com/us/en/products/E460318-000'
    );
    assert.strictEqual(
      provider.retailerUrl('https://www.googleadservices.com/pagead/aclk?sa=L&adurl=https%3A%2F%2Fwww.jcrew.com%2Fp%2FBX291', 0),
      'https://www.jcrew.com/p/BX291'
    );
  });

  test('Google Shopping and search URLs are not accepted as product URLs', () => {
    const googles = [
      GOOGLE_CARD,
      'https://www.google.com/search?tbm=shop&q=fleece+joggers',
      'https://www.google.com/shopping/product/1234567890',
      'https://www.google.co.uk/shopping/product/1234567890',
      'https://shopping.google.com/product/9',
      'https://encrypted-tbn0.gstatic.com/shopping?q=x',
      /* a forwarder whose destination is itself Google: unwrapping must
         not launder a comparison page into a product page */
      `https://www.google.com/url?q=${encodeURIComponent(GOOGLE_CARD)}`,
      'https://www.bing.com/shop?q=joggers',
      'not a url at all',
      'ftp://www.champion.com/products/p1234'
    ];

    for (const href of googles) {
      assert.strictEqual(provider.retailerUrl(href, 0), null, `${href} is not a retailer URL`);

      const record = provider.toRecord({ ...cardedResult(1), link: href });
      assert.strictEqual(record.productUrl, undefined, `${href} must not become a productUrl`);

      /* and it is not kept anywhere else either: discovery reads `link`
         and `url` off a raw record too, so a leftover would put back
         exactly what the gate refuses. The photo is not part of this —
         Google serves shopping thumbnails from its own CDN, and an
         image URL is not a link anybody is sent to. */
      for (const [field, value] of Object.entries(record)) {
        if (field === 'imageUrl') continue;
        assert.ok(!String(value).includes(href), `the refused URL survived on the record as ${field}`);
        assert.ok(!/^https?:\/\/[^/]*(google|gstatic|bing\.com)/i.test(String(value)),
          `${field} still carries a search engine's URL`);
      }
    }
  });

  await testAsync('the run that verified nothing: carded rows are dropped, and the search says why', async () => {
    await withStubbedFetch(() => jsonResponse(200, LIVE), async () => {
      const records = await provider.search({ keywords: ['fleece jogger'] }, { limit: 12 });

      assert.strictEqual(records.length, 20, 'every result still maps');
      assert.strictEqual(records.filter((r) => r.productUrl).length, 1, 'one of them named a shop');

      const { products, rejected } = verifyAll(records, { retailer: null });
      assert.strictEqual(products.length, 1);
      assert.strictEqual(products[0].productUrl, SHOP_LINKED.link);
      assert.strictEqual(rejected['missing-product-url'], 19,
        'the carded rows are dropped for having no retailer URL, not handed one');
      assert.ok(!rejected['product-url-not-a-retailer-page'],
        'and Google is never offered to the gate in the first place');

      /* the diagnostics are what turn a silent empty run into a named
         cause, and what names the field to read if Google moves it */
      const d = records.diagnostics;
      assert.strictEqual(d.returnedByProvider, 20);
      assert.strictEqual(d.googleLinkedOnly, 19);
      assert.strictEqual(d.unlinked, 0);
      assert.strictEqual(d.withInlineLink, 1);
      assert.deepStrictEqual(d.urlFieldsSeen, ['link'], 'the field the URLs arrived in, images aside');
    });
  });

  test('a result Serper gave no link at all keeps none', () => {
    const { link, ...linkless } = cardedResult(1);
    const record = provider.toRecord(linkless);
    assert.strictEqual(record.productUrl, undefined);
    assert.strictEqual(record.title, 'Fleece Jogger 1', 'the rest of the record is still read');
  });

  /* ---------------------------------------------------------
     What did not change
     --------------------------------------------------------- */

  test('the gate still decides, and the adapter never pre-approves', () => {
    /* the link rule itself, unchanged: each of these is the gate's own
       verdict, and a mapping change must not have moved any of them */
    assert.strictEqual(linkFault('https://www.champion.com/products/powerblend-fleece-jogger-p1234'), null);
    assert.strictEqual(linkFault(GOOGLE_CARD), 'product-url-not-a-retailer-page');
    assert.strictEqual(linkFault('https://www.google.com/shopping/product/1234567890'), 'product-url-not-a-retailer-page');
    assert.strictEqual(linkFault('https://www.googleadservices.com/pagead/aclk?adurl=https%3A%2F%2Fx.com%2Fp'), 'product-url-not-a-retailer-page');
    assert.strictEqual(linkFault('https://shop.example.com/out?url=https%3A%2F%2Fother.com%2Fp'), 'product-url-is-a-redirect');
    assert.strictEqual(linkFault('https://shop.example.com/search'), 'product-url-not-a-product-page');
    assert.strictEqual(linkFault('https://shop.example.com/'), 'product-url-not-a-product-page');
    assert.strictEqual(isProductPage('https://www.champion.com/products/p1234'), true);

    /* a URL the adapter resolved is still only a CANDIDATE: the gate
       refuses a category page just as readily when it arrived as a
       forwarder's destination */
    const category = provider.toRecord({
      ...cardedResult(1),
      link: 'https://www.google.com/url?q=https%3A%2F%2Fshop.example.com%2Fbrowse'
    });
    assert.strictEqual(category.productUrl, 'https://shop.example.com/browse', 'the adapter reads it');
    assert.strictEqual(verifyAll([category], {}).rejected['product-url-not-a-product-page'], 1, 'and the gate refuses it');

    /* and every other thing the gate asks for is still asked for: a
       retailer URL buys a record nothing on its own */
    const noPrice = provider.toRecord({ ...SHOP_LINKED, price: undefined });
    assert.strictEqual(verifyAll([noPrice], {}).rejected['missing-price'], 1);
    const httpImage = provider.toRecord({ ...SHOP_LINKED, imageUrl: 'http://cdn.champion.com/p1234.jpg' });
    assert.strictEqual(verifyAll([httpImage], {}).rejected['image-url-not-https'], 1);
    const noImage = provider.toRecord({ ...SHOP_LINKED, imageUrl: undefined });
    assert.strictEqual(verifyAll([noImage], {}).rejected['missing-image-url'], 1);
    const noRetailer = provider.toRecord({ ...SHOP_LINKED, source: undefined });
    assert.strictEqual(verifyAll([noRetailer], {}).rejected['missing-retailer'], 1);

    /* the seller's name is still never promoted into brand, and the
       record still carries only the fields it always carried */
    const record = provider.toRecord(SHOP_LINKED);
    assert.deepStrictEqual(
      Object.keys(record).sort(),
      ['currency', 'imageUrl', 'price', 'productUrl', 'retailer', 'sku', 'title']
    );
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
