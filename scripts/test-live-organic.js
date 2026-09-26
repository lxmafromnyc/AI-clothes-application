#!/usr/bin/env node
/* =========================================================
   Fynd — the live search's Serper fallback, end to end

   The live benchmark found the fallback working and showing nothing:
   SerpApi out of searches, Serper answering, and every one of its
   /shopping results a Google card with no retailer URL — 1,292 of them
   refused as missing-product-url, 0 products shown. This holds the
   path that fixes that to four properties:

     1. a shopping batch with no retailer URL is followed by Serper's
        organic results, whose listings are read off their own pages
     2. a Google URL is never a product URL: not on a shopping card,
        not as an organic result, not as where a listing redirects to
     3. an organic listing reaches a shopper only through the gates it
        was always going to face — the price reader's, the image
        reader's, and then verifyAll(), untouched
     4. a provider that does not answer is stopped by the request's
        clock, and the error says it timed out and who did

   The network is never touched. Every fetch — Serper's two endpoints,
   the retailers' pages and their photos — is answered from this file,
   and the stub honours the abort signal, which is what makes the
   timeout assertions mean anything.

   Usage: node scripts/test-live-organic.js
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.SERPER_API_KEY = 'test-serper-key-000000000000000000';
process.env.SERPAPI_API_KEY = 'test-serpapi-key-00000000000000000';
delete process.env.FYND_REQUEST_BUDGET_MS;

const productSource = require('../api/_providers/product-source');
const serper = require('../api/_providers/serper');
const serpapi = require('../api/_providers/serpapi');
const { verifyAll, outOfSearches } = productSource;
const { searchWithFallback, findProducts } = require('../api/search');
const { readListings, precheck } = require('../api/_providers/retailer-page');
const { legTimeout, timedOut } = require('../api/_providers/deadline');
const cache = require('../api/_cache');

let passed = 0;
const failures = [];

async function testAsync(name, fn) {
  const realFetch = global.fetch;
  try {
    cache.reset();
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 4).join('\n        ')}`);
  } finally {
    global.fetch = realFetch;
  }
}

/* ---------------------------------------------------------
   The web, as this file serves it
   --------------------------------------------------------- */

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function page(html, finalUrl) {
  const response = new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  if (finalUrl) Object.defineProperty(response, 'url', { value: finalUrl });
  return response;
}

/* a photo: an image type and enough bytes that it is not a tracker */
const photo = () => new Response(Buffer.alloc(4096, 7), { status: 200, headers: { 'content-type': 'image/jpeg' } });

function productPage({ sku, name, price, image, siteName, brand, offerSku }) {
  const node = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    sku: offerSku || sku,
    image: [image],
    offers: { '@type': 'Offer', price, priceCurrency: 'USD', availability: 'https://schema.org/InStock' }
  };
  if (brand) node.brand = { '@type': 'Brand', name: brand };
  return `<!doctype html><html><head><title>${name}</title>
    ${siteName ? `<meta property="og:site_name" content="${siteName}">` : ''}
    <script type="application/ld+json">${JSON.stringify(node)}</script>
    </head><body><h1>${name}</h1></body></html>`;
}

/* Every card a Google card: the shape the live probe found. The
   forwarder here forwards to Google too, so unwrapping it finds no
   shop. */
const SHOPPING = {
  shopping: [
    { title: 'Wide Leg Trouser', source: 'Shop Example', link: 'https://www.google.com/search?ibp=oshop&q=wide+leg+trouser&prds=pid:1', price: '$88.00', imageUrl: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:1', productId: '1' },
    { title: 'Pleated Wide Leg Trouser', source: 'Other Shop', link: 'https://www.google.com/shopping/product/2233445566', price: '$120.00', imageUrl: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:2', productId: '2' },
    { title: 'Wide Trouser', source: 'Third', link: 'https://www.google.com/url?q=https%3A%2F%2Fwww.google.com%2Fshopping%2Fproduct%2F3', price: '$60.00', imageUrl: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:3', productId: '3' }
  ]
};

const URLS = {
  good: 'https://www.shop-example.com/p/wide-leg-trouser-WL48213',
  forwarded: 'https://www.other-shop.com/products/pleated-trouser-PT9921',
  wrongSku: 'https://www.third-shop.com/p/wide-trouser-TS30001',
  noPhoto: 'https://www.fourth-shop.com/p/wide-leg-pant-FS77120',
  redirects: 'https://www.redirect-shop.com/p/trouser-RS55512',
  editorial: 'https://www.vogue.com/article/best-wide-leg-trousers'
};

const ORGANIC = {
  organic: [
    { title: 'Wide Leg Trouser | Shop Example', link: URLS.good, position: 1 },
    /* Google's own: never an organic record */
    { title: 'wide leg trousers - Google Shopping', link: 'https://www.google.com/search?tbm=shop&q=wide+leg+trousers', position: 2 },
    /* a forwarder, unwrapped to the shop it names */
    { title: 'Pleated Trouser', link: `https://www.google.com/url?q=${encodeURIComponent(URLS.forwarded)}`, position: 3 },
    { title: 'Wide Trouser | Third Shop', link: URLS.wrongSku, position: 4 },
    { title: 'Wide Leg Pant | Fourth Shop', link: URLS.noPhoto, position: 5 },
    { title: 'Trouser | Redirect Shop', link: URLS.redirects, position: 6 },
    { title: 'The 12 Best Wide-Leg Trousers', link: URLS.editorial, position: 7 }
  ]
};

const PAGES = {
  [URLS.good]: () => page(productPage({
    sku: 'WL48213', name: 'Wide Leg Trouser in Stone', price: '88.00', siteName: 'Shop Example', brand: 'Northfold',
    image: 'https://cdn.shop-example.com/i/WL48213-front.jpg'
  })),
  [URLS.forwarded]: () => page(productPage({
    sku: 'PT9921', name: 'Pleated Wide Leg Trouser', price: '120.00', siteName: 'Other Shop',
    image: 'https://cdn.other-shop.com/i/PT9921_1.jpg'
  })),
  /* an offer, and a sku, for a DIFFERENT product: the price gate refuses */
  [URLS.wrongSku]: () => page(productPage({
    sku: 'TS30001', offerSku: 'ZZ11111', name: 'Wide Trouser', price: '60.00', siteName: 'Third Shop',
    image: 'https://cdn.third-shop.com/i/TS30001.jpg'
  })),
  /* a proven price, and a photo only on Google's image host */
  [URLS.noPhoto]: () => page(productPage({
    sku: 'FS77120', name: 'Wide Leg Pant', price: '54.00', siteName: 'Fourth Shop',
    image: 'https://encrypted-tbn0.gstatic.com/images?q=FS77120'
  })),
  /* served from somewhere else entirely */
  [URLS.redirects]: () => page(productPage({
    sku: 'RS55512', name: 'Trouser', price: '40.00', siteName: 'Redirect Shop',
    image: 'https://www.google.com/images/RS55512.jpg'
  }), 'https://www.google.com/search?q=trouser')
};

const PHOTOS = new Set(['https://cdn.shop-example.com/i/WL48213-front.jpg', 'https://cdn.other-shop.com/i/PT9921_1.jpg']);

/* One stub for the whole web. Records what was asked, and never
   answers a request this file did not expect. */
function web(overrides) {
  const calls = [];
  global.fetch = async (url, options) => {
    const href = String(url);
    calls.push({ url: href, method: (options && options.method) || 'GET', body: options && options.body });
    const custom = overrides && overrides(href, options);
    if (custom) return custom;
    if (href === serper.SEARCH_URL) return jsonResponse(200, SHOPPING);
    if (href === serper.WEB_SEARCH_URL) return jsonResponse(200, ORGANIC);
    if (PAGES[href]) return PAGES[href]();
    if (PHOTOS.has(href)) return photo();
    return new Response('not found', { status: 404 });
  };
  return calls;
}

const hostOf = (href) => new URL(href).hostname;
const INTENT = { garments: ['trousers'], descriptors: ['wide-leg'], keywords: ['wide', 'leg', 'trousers'] };
const QUOTA = 'SerpApi responded 429 (SerpApi search allowance exhausted): Your account has run out of searches.';

/* the endpoint's chain, with a primary whose allowance is spent and the
   REAL Serper adapter behind it */
async function withSpentPrimary(fn) {
  const saved = process.env.PRODUCT_SOURCE;
  let asked = 0;
  productSource.registerProvider({ name: 'spent-primary', configured: () => true, search: async () => { asked += 1; throw new Error(QUOTA); } });
  process.env.PRODUCT_SOURCE = 'spent-primary';
  try {
    assert.strictEqual(productSource.PROVIDERS.serper, serper, 'the real Serper adapter is the fallback under test');
    await fn(productSource.getProvider(), () => asked);
  } finally {
    if (saved === undefined) delete process.env.PRODUCT_SOURCE; else process.env.PRODUCT_SOURCE = saved;
  }
}

const deadlineIn = (ms) => Date.now() + ms;

(async () => {
  console.log('\n  — 1. a linkless shopping batch falls back to organic retailer listings\n');

  await testAsync('SerpApi out of searches → Serper shopping, all Google cards → Serper organic → the retailer’s own listing, shown', async () => {
    const calls = web();
    await withSpentPrimary(async (primary, asked) => {
      const found = await searchWithFallback(primary, INTENT, 12, cache.counters(), deadlineIn(9000));

      assert.strictEqual(asked(), 1);
      assert.strictEqual(found.provider, 'serper');
      assert.strictEqual(found.fellBackFrom.provider, 'spent-primary');

      /* the shop's listing and the forwarded one, in the engine's order */
      assert.deepStrictEqual(found.products.map((one) => one.productUrl), [URLS.good, URLS.forwarded]);
      const shown = found.products[0];
      assert.strictEqual(shown.name, 'Wide Leg Trouser in Stone', 'the product record’s own name');
      assert.strictEqual(shown.price, 88);
      assert.strictEqual(shown.currency, 'USD');
      assert.strictEqual(shown.imageUrl, 'https://cdn.shop-example.com/i/WL48213-front.jpg');
      assert.strictEqual(shown.retailer, 'Shop Example', 'the name the site gives itself');
      assert.strictEqual(shown.brand, 'Northfold');

      /* both endpoints asked, the same phrase, shopping first */
      const serperCalls = calls.filter((one) => one.url.startsWith('https://google.serper.dev/'));
      assert.deepStrictEqual(serperCalls.map((one) => one.url), [serper.SEARCH_URL, serper.WEB_SEARCH_URL]);
      assert.strictEqual(JSON.parse(serperCalls[0].body).q, JSON.parse(serperCalls[1].body).q);

      /* the account of it */
      const organic = found.funnel.organic;
      assert.strictEqual(organic.failed, null);
      assert.strictEqual(organic.offered, 6, 'the Google result never became a listing');
      assert.strictEqual(organic.pages.outcomes.photographed, 2);
    });
  });

  await testAsync('a shopping batch that DOES name a shop is answered as it always was — no organic request', async () => {
    const calls = web((href) => (href === serper.SEARCH_URL ? jsonResponse(200, { shopping: [
      { title: 'Wide Leg Trouser', source: 'Shop Example', link: URLS.good, price: '$88.00', imageUrl: 'https://cdn.shop-example.com/i/WL48213-front.jpg' }
    ] }) : null));
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    assert.deepStrictEqual(found.products.map((one) => one.productUrl), [URLS.good]);
    assert.ok(!calls.some((one) => one.url === serper.WEB_SEARCH_URL), 'the organic endpoint was asked anyway');
    assert.ok(!calls.some((one) => one.url === URLS.good), 'a listing the source already priced and photographed was fetched');
    assert.ok(!found.funnel || !found.funnel.organic);
  });

  await testAsync('a failed organic search is recorded, and the shopping batch is answered as it was', async () => {
    web((href) => (href === serper.WEB_SEARCH_URL ? jsonResponse(500, { message: 'down' }) : null));
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    assert.strictEqual(found.products.length, 0);
    assert.strictEqual(found.rejected['missing-product-url'], SHOPPING.shopping.length);
    assert.match(found.funnel.organic.failed, /Serper responded 500/);
  });

  await testAsync('an adapter with no organic endpoint is never escalated, whatever its batch holds', async () => {
    const calls = web();
    const linklessOnly = { name: 'no-organic', configured: () => true, search: async () => [{ title: 'Card', price: 10, imageUrl: 'https://x.example/a.jpg', retailer: 'X' }] };
    const found = await findProducts(linklessOnly, INTENT, 12, cache.counters(), deadlineIn(9000));
    assert.strictEqual(found.products.length, 0);
    assert.strictEqual(calls.length, 0, 'nothing was fetched');
    for (const other of ['openwebninja', 'serpapi', 'etsy', 'none']) {
      assert.strictEqual(typeof productSource.PROVIDERS[other].searchOrganic, 'undefined', other);
    }
  });

  console.log('\n  — 2. a Google URL is never a retailer product URL\n');

  await testAsync('Google Shopping cards with no retailer listing are refused, and never fetched', async () => {
    const calls = web();
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    /* every card reached the gate, and every card was refused for it */
    assert.strictEqual(found.rejected['missing-product-url'], SHOPPING.shopping.length);
    for (const record of found.records.slice(0, SHOPPING.shopping.length)) {
      assert.strictEqual(record.productUrl, undefined, `a Google card was given a product URL: ${record.productUrl}`);
    }
    /* no shown product, and no request at all, on a Google host */
    for (const product of found.products) assert.doesNotMatch(hostOf(product.productUrl), /google\./);
    for (const call of calls.filter((one) => !one.url.startsWith('https://google.serper.dev/'))) {
      assert.doesNotMatch(hostOf(call.url), /(^|\.)google\.[a-z.]+$|gstatic\.com$/, `fetched ${call.url}`);
    }
  });

  await testAsync('a listing that redirects off the shop it named is refused, not believed', async () => {
    web();
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    assert.ok(!found.products.some((one) => one.productUrl === URLS.redirects));
    assert.strictEqual(found.funnel.organic.pages.outcomes['left-the-retailer'], 1);
    const record = found.records.find((one) => one.productUrl === URLS.redirects);
    assert.deepStrictEqual(Object.keys(record).sort(), ['productUrl', 'title'], 'a redirected page proved nothing and was given nothing');
  });

  await testAsync('the adapter and the gate each refuse Google on their own', async () => {
    for (const google of [
      'https://www.google.com/search?ibp=oshop&q=x',
      'https://www.google.com/shopping/product/1',
      'https://www.google.com/url?q=https%3A%2F%2Fwww.google.com%2Fshopping%2Fproduct%2F3',
      'https://shopping.google.com/product/1'
    ]) {
      assert.strictEqual(serper.retailerUrl(google), null, google);
      assert.strictEqual(serper.toOrganicRecord({ title: 'x', link: google }), null, google);
      assert.strictEqual(precheck({ title: 'x', productUrl: google }).outcome, 'refused-link', google);
    }
  });

  console.log('\n  — 3. an organic listing meets exactly the gates every live result meets\n');

  await testAsync('what is shown is exactly what verifyAll() makes of the records — nothing added after the gate', async () => {
    web();
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    const again = verifyAll(found.records, { retailer: serper.defaultRetailer });
    assert.deepStrictEqual(found.products, again.products);
    assert.deepStrictEqual(found.rejected, again.rejected);
  });

  await testAsync('each organic listing is refused by the gate for exactly what its page could not prove', async () => {
    web();
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    const byUrl = new Map(found.records.map((one) => [one.productUrl, one]));

    /* an offer on another product's record proves no price for this one */
    assert.strictEqual(byUrl.get(URLS.wrongSku).price, undefined);
    assert.strictEqual(verifyAll([byUrl.get(URLS.wrongSku)]).rejected['missing-price'], 1);

    /* a proven price, and a photo only on Google's image host */
    assert.strictEqual(byUrl.get(URLS.noPhoto).price, 54);
    assert.strictEqual(byUrl.get(URLS.noPhoto).imageUrl, undefined);
    assert.strictEqual(verifyAll([byUrl.get(URLS.noPhoto)]).rejected['missing-image-url'], 1);

    /* an article is never read, and goes to the gate as it came */
    assert.deepStrictEqual(Object.keys(byUrl.get(URLS.editorial)).sort(), ['productUrl', 'title']);

    const outcomes = found.funnel.organic.pages.outcomes;
    assert.deepStrictEqual(outcomes, { photographed: 2, 'no-price': 1, 'no-photo': 1, 'left-the-retailer': 1, 'editorial-page': 1 });
    assert.strictEqual(found.rejected['missing-price'], 3, 'the wrong-sku listing, the redirect and the article');
    assert.strictEqual(found.rejected['missing-image-url'], 1);
  });

  await testAsync('an article is never fetched, and a listing with no provable price costs no photo check', async () => {
    const calls = web();
    await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    assert.ok(!calls.some((one) => one.url === URLS.editorial), 'the article was fetched');
    assert.ok(!calls.some((one) => one.url === 'https://cdn.third-shop.com/i/TS30001.jpg'), 'a photo was checked for a listing with no price');
  });

  await testAsync('a photo that cannot be tied to the listing is refused, whatever else the page proved', async () => {
    /* the right price, on the right record — and a photo whose URL
       carries no code, on no record, from a page that does not declare
       itself canonical for the listing */
    const hero = 'https://cdn.shop-example.com/i/hero.jpg';
    const listingPage = (canonical) => page(`<!doctype html><html><head>
      <meta property="og:site_name" content="Shop Example">
      <meta property="og:image" content="${hero}">
      ${canonical ? `<link rel="canonical" href="${canonical}">` : ''}
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Wide Leg Trouser', sku: 'WL48213', offers: { price: '88.00', priceCurrency: 'USD' } })}</script>
      </head></html>`);
    const one = [{ title: 'Wide Leg Trouser', productUrl: URLS.good }];

    web((href) => (href === URLS.good ? listingPage(null) : href === hero ? photo() : null));
    const refused = await readListings(one, { limit: 12, deadline: deadlineIn(9000) });
    assert.strictEqual(refused.records[0].price, 88, 'the price is proven');
    assert.strictEqual(refused.records[0].imageUrl, undefined, 'a photo nothing ties to the product was taken');
    assert.deepStrictEqual(refused.diagnostics.outcomes, { 'no-photo': 1 });
    assert.match(refused.diagnostics.samples[0].why, /^identity: /);

    /* the control: the same page, canonical for this product listing,
       vouches for its own og:image by the identity gate's canonical rule */
    web((href) => (href === URLS.good ? listingPage(URLS.good) : href === hero ? photo() : null));
    const vouched = await readListings(one, { limit: 12, deadline: deadlineIn(9000) });
    assert.strictEqual(vouched.records[0].imageUrl, hero);
    assert.deepStrictEqual(vouched.diagnostics.outcomes, { photographed: 1 });
  });

  await testAsync('a cached answer is put through the gate again, and shows the same products in the same order', async () => {
    web();
    const cold = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    const calls = web(() => { throw new Error('a cache hit reached the network'); });
    const warm = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    assert.strictEqual(warm.servedFromCache, true);
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(warm.products, cold.products);
  });

  await testAsync('the same answers give the same order, however the pages race', async () => {
    const orders = [];
    for (const slowFirst of [true, false]) {
      cache.reset();
      web((href) => {
        const make = PAGES[href];
        if (!make) return null;
        const wait = (href === URLS.good) === slowFirst ? 60 : 0;
        return new Promise((resolve) => setTimeout(() => resolve(make()), wait));
      });
      const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
      orders.push(found.products.map((one) => one.productUrl));
    }
    assert.deepStrictEqual(orders[0], orders[1]);
    assert.deepStrictEqual(orders[0], [URLS.good, URLS.forwarded]);
  });

  console.log('\n  — 4. a provider that does not answer is stopped by the request’s clock\n');

  /* a fetch that never answers, but gives up when it is aborted — as a
     real one does */
  const hanging = (href, options) => new Promise((resolve, reject) => {
    const signal = options && options.signal;
    if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });

  await testAsync('Serper that never answers times out at the deadline, says so, and names itself', async () => {
    web(hanging);
    const started = Date.now();
    await assert.rejects(() => serper.search(INTENT, { limit: 12, deadline: deadlineIn(700) }), (err) => {
      assert.match(err.message, /^Serper \/shopping did not answer within \d+ms \(timed out\)$/);
      assert.doesNotMatch(err.message, /This operation was aborted/);
      assert.ok(timedOut(err));
      assert.strictEqual(outOfSearches(err), false, 'a timeout is not an exhausted allowance');
      return true;
    });
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms against a 700ms deadline`);
  });

  await testAsync('SerpApi that never answers times out at the deadline, and never with the key in the message', async () => {
    web(hanging);
    const started = Date.now();
    await assert.rejects(() => serpapi.search(INTENT, { limit: 12, deadline: deadlineIn(600) }), (err) => {
      assert.match(err.message, /^SerpApi did not answer within \d+ms \(timed out\)$/);
      assert.doesNotMatch(err.message, new RegExp(process.env.SERPAPI_API_KEY));
      return true;
    });
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms`);
  });

  await testAsync('a primary that times out is reported, not handed to the fallback', async () => {
    const calls = web(hanging);
    const saved = process.env.PRODUCT_SOURCE;
    process.env.PRODUCT_SOURCE = 'serpapi';
    try {
      await assert.rejects(
        () => searchWithFallback(productSource.getProvider(), INTENT, 12, cache.counters(), deadlineIn(600)),
        /SerpApi did not answer within \d+ms \(timed out\)/
      );
      assert.ok(!calls.some((one) => one.url.startsWith('https://google.serper.dev/')), 'a timeout sent the search to Serper');
    } finally {
      if (saved === undefined) delete process.env.PRODUCT_SOURCE; else process.env.PRODUCT_SOURCE = saved;
    }
  });

  await testAsync('the fallback timing out after an exhausted primary is named as the fallback’s timeout', async () => {
    web(hanging);
    await withSpentPrimary(async (primary) => {
      await assert.rejects(
        () => searchWithFallback(primary, INTENT, 12, cache.counters(), deadlineIn(800)),
        /Serper \/shopping did not answer within \d+ms \(timed out\)$/
      );
    });
  });

  await testAsync('a spent budget makes no request at all', async () => {
    const calls = web();
    await assert.rejects(() => serper.search(INTENT, { limit: 12, deadline: Date.now() - 1 }), /ran out before the request was made/);
    await assert.rejects(() => serper.searchOrganic(INTENT, { limit: 12, deadline: Date.now() + 100 }), /ran out before the request was made/);
    assert.strictEqual(calls.length, 0);
  });

  await testAsync('with no deadline a call keeps its own ceiling, exactly as before', async () => {
    assert.strictEqual(legTimeout(undefined, 4000, 15000), 15000);
    assert.strictEqual(legTimeout(null, 0, 15000), 15000);
    /* a deadline never lengthens a call past its own ceiling */
    assert.strictEqual(legTimeout(Date.now() + 60000, 0, 15000), 15000);
    /* and a reserve is kept only when it leaves the call something */
    const t = legTimeout(Date.now() + 9000, 4000, 15000);
    assert.ok(t > 4500 && t <= 5000, String(t));
    const tight = legTimeout(Date.now() + 2000, 4000, 15000);
    assert.ok(tight > 1500 && tight <= 2000, String(tight));
  });

  await testAsync('a retailer page that never answers is abandoned at the deadline, and the search still answers', async () => {
    web((href, options) => (href === URLS.good ? hanging(href, options) : null));
    const started = Date.now();
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(2500));
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms against a 2500ms deadline`);
    assert.deepStrictEqual(found.products.map((one) => one.productUrl), [URLS.forwarded]);
    assert.strictEqual(found.funnel.organic.pages.outcomes.unreadable, 1);
  });

  await testAsync('/api/search answers from the organic listings, with counts and no record contents in its diagnostics', async () => {
    web();
    await withSpentPrimary(async () => {
      const handler = require('../api/search');
      const res = { statusCode: null, body: null, headers: {} };
      res.setHeader = (k, v) => { res.headers[k] = v; };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (payload) => { res.body = payload; return res; };
      res.end = () => res;
      await handler({ method: 'POST', headers: {}, body: { intent: INTENT, limit: 12 }, on: () => {} }, res);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.source, 'serper');
      assert.deepStrictEqual(res.body.products.map((one) => one.productUrl), [URLS.good, URLS.forwarded]);
      assert.strictEqual(res.body.diagnostics.organic.pages.samples, undefined, 'sample refusals reached the browser');
      assert.strictEqual(res.body.diagnostics.organic.pages.outcomes.photographed, 2);
    });
  });


  console.log('\n  — 5. a listing’s own page proves what its search result could not\n');

  const images = require('./fetch-catalog-images.js');
  const prices = require('./fetch-catalog-prices.js');
  const SLUG = 'https://www.slug-shop.com/products/boxy-cotton-tee';
  const SLUG_PHOTO = 'https://cdn.slug-shop.com/files/boxy-tee-front.jpg';

  /* a Shopify-style listing: no code in its URL, and a page that says
     plainly which product it is */
  function slugPage(options) {
    const o = Object.assign({ canonical: SLUG, ogType: 'product', sku: 'SUB-TEE-1042', image: SLUG_PHOTO, price: '48.00', extra: [] }, options || {});
    const records = [{ '@type': 'Product', name: 'Boxy Cotton Tee', brand: { '@type': 'Brand', name: 'Subset' }, image: [o.image],
      offers: [{ '@type': 'Offer', sku: o.sku, price: o.price, priceCurrency: 'USD' }] }].concat(o.extra);
    return `<!doctype html><html><head><title>Boxy Cotton Tee</title>
      <meta property="og:site_name" content="Slug Shop">
      <meta property="og:type" content="${o.ogType}">
      <meta property="og:image" content="${o.image}">
      ${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ''}
      ${records.map((one) => `<script type="application/ld+json">${JSON.stringify(Object.assign({ '@context': 'https://schema.org' }, one))}</script>`).join('\n')}
      </head><body></body></html>`;
  }
  const readSlug = async (html, photos, listing) => {
    web((href) => (href === ((listing && listing.productUrl) || SLUG) ? page(html) : (photos || [SLUG_PHOTO]).includes(href) ? photo() : null));
    return readListings([listing || { title: 'Boxy Cotton Tee | Slug Shop', productUrl: SLUG }], { limit: 12, deadline: deadlineIn(9000) });
  };

  await testAsync('a code-less listing whose own page names its product is priced, photographed and shown', async () => {
    const { records, diagnostics } = await readSlug(slugPage());
    assert.deepStrictEqual(diagnostics.outcomes, { photographed: 1 }, JSON.stringify(diagnostics.samples));
    const { products } = verifyAll(records, { retailer: null });
    assert.strictEqual(products.length, 1);
    assert.deepStrictEqual(
      { name: products[0].name, price: products[0].price, imageUrl: products[0].imageUrl, retailer: products[0].retailer, productUrl: products[0].productUrl },
      { name: 'Boxy Cotton Tee', price: 48, imageUrl: SLUG_PHOTO, retailer: 'Slug Shop', productUrl: SLUG }
    );
  });

  await testAsync('the page must be canonical for the listing, or it proves nothing about it', async () => {
    for (const canonical of [null, 'https://www.slug-shop.com/products/linen-camp-shirt']) {
      const { records, diagnostics } = await readSlug(slugPage({ canonical }));
      assert.deepStrictEqual(diagnostics.outcomes, { 'no-identity': 1 }, String(canonical));
      assert.strictEqual(records[0].price, undefined);
      assert.strictEqual(verifyAll(records).rejected['missing-price'], 1);
    }
  });

  await testAsync('a page that is an article, or that describes two products, proves no identity', async () => {
    const article = await readSlug(slugPage({ ogType: 'article' }).replace('"@type":"Product"', '"@type":"Article"'));
    assert.deepStrictEqual(article.diagnostics.outcomes, { 'no-identity': 1 });
    const two = await readSlug(slugPage({ extra: [{ '@type': 'Product', name: 'Linen Shirt', sku: 'LIN-7788', offers: { price: '90.00', priceCurrency: 'USD' } }] }));
    assert.deepStrictEqual(two.diagnostics.outcomes, { 'no-identity': 1 });
    assert.match(two.diagnostics.samples[0].why, /product records naming different products/);
    /* two records, neither naming this page as its own, and no code in
       common: the page has not said which product it is */
    const unnamed = await readSlug(slugPage({ sku: 'SUB-TEE', extra: [{ '@type': 'Product', name: 'Boxy Linen Tee', sku: 'SUB-LINEN', offers: { price: '52.00', priceCurrency: 'USD' } }] }));
    assert.deepStrictEqual(unnamed.diagnostics.outcomes, { 'no-identity': 1 });
  });

  await testAsync('on a page-proven code the record cannot vouch for its own photo: a different garment is refused', async () => {
    /* the photo sits on the very record the code came from, and names a
       shirt — the canonical rule's garment check refuses it */
    const shirt = 'https://cdn.slug-shop.com/files/linen-camp-shirt.jpg';
    const refused = await readSlug(slugPage({ image: shirt }), [shirt]);
    assert.deepStrictEqual(refused.diagnostics.outcomes, { 'no-photo': 1 });
    assert.strictEqual(refused.records[0].price, 48, 'the price is still proven');
    assert.strictEqual(refused.records[0].imageUrl, undefined);
    /* the same kind of photo carrying the page's code proves itself */
    const coded = 'https://cdn.slug-shop.com/files/SUB-TEE-1042-shirt-detail.jpg';
    const accepted = await readSlug(slugPage({ image: coded }), [coded]);
    assert.strictEqual(accepted.records[0].imageUrl, coded);
  });

  await testAsync('a title that reads like an article or a category is read, not skipped — its page decides', async () => {
    const url = 'https://www.slug-shop.com/boxy-cotton-tee';
    const listing = { title: 'Best Boxy Cotton Tees for Women | Slug Shop', productUrl: url };
    assert.strictEqual(images.listingShape(url, listing.title).kind === 'product', false, 'the title alone would have skipped it');
    assert.strictEqual(precheck(listing), null);
    const { records, diagnostics } = await readSlug(slugPage({ canonical: url }), null, listing);
    assert.deepStrictEqual(diagnostics.outcomes, { photographed: 1 }, JSON.stringify(diagnostics.samples));
    assert.strictEqual(verifyAll(records).products.length, 1);
  });

  await testAsync('an ADDRESS that is a category, an article or a forum is still never fetched', async () => {
    const calls = web();
    const skipped = [
      ['https://www.slug-shop.com/collections/tees', 'category-page'],
      ['https://www.slug-shop.com/blogs/journal/how-to-style-a-boxy-tee', 'editorial-page'],
      ['https://www.reddit.com/r/malefashion/comments/abc123/boxy_tees', 'not-a-shop']
    ];
    const { diagnostics } = await readListings(skipped.map(([productUrl]) => ({ title: 'Boxy Tee', productUrl })), { limit: 12, deadline: deadlineIn(9000) });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(diagnostics.outcomes, { 'category-page': 1, 'editorial-page': 1, 'not-a-shop': 1 });
  });

  await testAsync('an offer naming the listing’s code proves its price when the record itself names none', async () => {
    const html = `<!doctype html><html><head><meta property="og:site_name" content="Shop Example">
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Wide Leg Trouser', image: 'https://cdn.shop-example.com/i/WL48213-front.jpg',
        offers: [{ '@type': 'Offer', sku: 'WL48213-S', price: '88.00', priceCurrency: 'USD' }, { '@type': 'Offer', sku: 'WL48213-M', price: '88.00', priceCurrency: 'USD' }] })}</script>
      </head></html>`;
    web((href) => (href === URLS.good ? page(html) : null));
    const { records } = await readListings([{ title: 'Wide Leg Trouser', productUrl: URLS.good }], { limit: 12, deadline: deadlineIn(9000) });
    assert.strictEqual(records[0].price, 88);
    assert.strictEqual(records[0].imageUrl, 'https://cdn.shop-example.com/i/WL48213-front.jpg');
    /* and offers that disagree still fail closed */
    const split = html.replace('"sku":"WL48213-M","price":"88.00"', '"sku":"WL48213-M","price":"98.00"');
    web((href) => (href === URLS.good ? page(split) : null));
    const ambiguous = await readListings([{ title: 'Wide Leg Trouser', productUrl: URLS.good }], { limit: 12, deadline: deadlineIn(9000) });
    assert.deepStrictEqual(ambiguous.diagnostics.outcomes, { 'no-price': 1 });
    assert.match(ambiguous.diagnostics.samples[0].why, /different amounts/);
  });

  await testAsync('catalogue discovery, which passes no page identity, judges a code-less listing exactly as before', async () => {
    const html = slugPage();
    const candidate = images.candidatesFrom(html, SLUG)[0];
    assert.match(images.identityEvidence(candidate, SLUG).why, /carries no product code/);
    const read = prices.pricesFromHtml(html);
    const decided = prices.decide(read.candidates, SLUG);
    assert.strictEqual(decided.price, undefined);
    assert.match(decided.refusals[0].why, /carries no product code/);
    /* and a URL that names its product never consults the page's claim */
    assert.strictEqual(images.pageIdentity(html, URLS.good).ok, false);
  });

  await testAsync('listings whose URL names a product are read first; what is shown keeps the engine’s order', async () => {
    const { readTier } = require('../api/_providers/retailer-page');
    assert.strictEqual(readTier({ productUrl: URLS.good }), 0);
    assert.strictEqual(readTier({ productUrl: SLUG, title: 'Boxy Cotton Tee' }), 1);
    assert.strictEqual(readTier({ productUrl: 'https://www.slug-shop.com/boxy-cotton-tee', title: 'Boxy Cotton Tee' }), 2);

    const seen = [];
    web((href) => {
      if (href === SLUG) { seen.push(href); return page(slugPage()); }
      if (href === SLUG_PHOTO) return photo();
      if (PAGES[href]) { seen.push(href); return PAGES[href](); }
      return null;
    });
    const { records } = await readListings([
      { title: 'Boxy Cotton Tee', productUrl: SLUG },
      { title: 'Wide Leg Trouser', productUrl: URLS.good }
    ], { limit: 12, deadline: deadlineIn(9000) });
    assert.deepStrictEqual(verifyAll(records).products.map((one) => one.productUrl), [SLUG, URLS.good], 'the engine’s order');
    assert.strictEqual(seen[0], URLS.good, 'the coded listing was not read first');
  });


  console.log('\n  — 6. formats and evidence the gates already stand for, read where they were missed\n');

  const offerPage = (records) => `<!doctype html><html><head><meta property="og:site_name" content="Shop Example">
    ${records.map((one) => `<script type="application/ld+json">${JSON.stringify(Object.assign({ '@context': 'https://schema.org' }, one))}</script>`).join('\n')}
    </head></html>`;
  const priceOf = (html, url) => prices.decide(prices.pricesFromHtml(html).candidates, url || URLS.good);

  await testAsync('a ProductGroup’s price is read off its variant for this listing, and variants that disagree fail closed', async () => {
    const group = (second) => offerPage([{ '@type': 'ProductGroup', name: 'Wide Leg Trouser', productGroupID: 'WL48213', hasVariant: [
      { '@type': 'Product', sku: 'WL48213-S', offers: { price: '88.00', priceCurrency: 'USD' } },
      { '@type': 'Product', sku: 'WL48213-M', offers: { price: second, priceCurrency: 'USD' } }
    ] }]);
    assert.strictEqual(priceOf(group('88.00')).price, 88);
    const split = priceOf(group('98.00'));
    assert.strictEqual(split.price, undefined);
    assert.deepStrictEqual(split.ambiguous, [88, 98]);
  });

  await testAsync('an AggregateOffer’s own listed offers are read; its range alone is still not a price', async () => {
    const aggregate = (inner) => offerPage([{ '@type': 'Product', name: 'Wide Leg Trouser', sku: 'WL48213',
      offers: Object.assign({ '@type': 'AggregateOffer', lowPrice: '70.00', highPrice: '88.00', priceCurrency: 'USD' }, inner ? { offers: inner } : {}) }]);
    assert.strictEqual(priceOf(aggregate(null)).price, undefined, 'a range is not a price');
    assert.strictEqual(priceOf(aggregate([{ '@type': 'Offer', price: '88.00', priceCurrency: 'USD' }, { '@type': 'Offer', price: '88.00', priceCurrency: 'USD' }])).price, 88);
    assert.strictEqual(priceOf(aggregate([{ '@type': 'Offer', price: '70.00' }, { '@type': 'Offer', price: '88.00' }])).price, undefined, 'two listed prices still fail closed');
  });

  await testAsync('a list-price specification is never read as the amount charged', async () => {
    const spec = (specs) => offerPage([{ '@type': 'Product', name: 'Wide Leg Trouser', sku: 'WL48213', offers: { '@type': 'Offer', priceCurrency: 'USD', priceSpecification: specs } }]);
    assert.strictEqual(priceOf(spec([{ price: '120.00', priceType: 'https://schema.org/ListPrice' }, { price: '88.00' }])).price, 88);
    /* it used to be: one specification was read whatever it said it was */
    assert.strictEqual(priceOf(spec({ price: '120.00', priceType: 'https://schema.org/StrikethroughPrice' })).price, undefined);
    assert.strictEqual(priceOf(spec({ price: '88.00' })).price, 88);
  });

  await testAsync('a code-less listing whose page names a coded canonical address is judged, and shown, at that address', async () => {
    const alias = 'https://www.shop-example.com/wide-leg-trouser-stone';
    const html = productPage({ sku: 'WL48213', name: 'Wide Leg Trouser in Stone', price: '88.00', siteName: 'Shop Example',
      image: 'https://cdn.shop-example.com/i/WL48213-front.jpg' }).replace('<title>', `<link rel="canonical" href="${URLS.good}"><title>`);
    web((href) => (href === alias ? page(html) : null));
    const { records, diagnostics } = await readListings([{ title: 'Wide Leg Trouser', productUrl: alias }], { limit: 12, deadline: deadlineIn(9000) });
    assert.deepStrictEqual(diagnostics.outcomes, { photographed: 1 }, JSON.stringify(diagnostics.samples));
    assert.deepStrictEqual(verifyAll(records).products.map((one) => [one.productUrl, one.price]), [[URLS.good, 88]]);
  });

  await testAsync('a canonical address on another site, or on a category, identifies nothing', async () => {
    const alias = 'https://www.shop-example.com/wide-leg-trouser-stone';
    for (const canonical of ['https://www.elsewhere.com/p/wide-leg-trouser-WL48213', 'https://www.shop-example.com/collections/trousers']) {
      const html = productPage({ sku: 'WL48213', name: 'Wide Leg Trouser', price: '88.00', siteName: 'Shop Example', image: 'https://cdn.shop-example.com/i/WL48213-front.jpg' })
        .replace('<title>', `<link rel="canonical" href="${canonical}"><title>`);
      web((href) => (href === alias ? page(html) : null));
      const { records, diagnostics } = await readListings([{ title: 'Wide Leg Trouser', productUrl: alias }], { limit: 12, deadline: deadlineIn(9000) });
      assert.deepStrictEqual(diagnostics.outcomes, { 'no-identity': 1 }, canonical);
      assert.strictEqual(verifyAll(records).products.length, 0);
    }
  });

  await testAsync('a record with no code is the product when it is the page’s own — and only its own offers count', async () => {
    /* one record, a sku with no code in it */
    const single = await readSlug(slugPage({ sku: 'SUB-TEE' }));
    assert.deepStrictEqual(single.diagnostics.outcomes, { photographed: 1 }, JSON.stringify(single.diagnostics.samples));
    /* two records: the one naming this page is the product, and a
       recommended product's offer on the same page is not its price */
    const own = { '@type': 'Product', url: SLUG, name: 'Boxy Cotton Tee', image: [SLUG_PHOTO], offers: { price: '48.00', priceCurrency: 'USD' } };
    const other = { '@type': 'Product', url: 'https://www.slug-shop.com/products/linen-shirt', name: 'Linen Shirt', offers: { price: '90.00', priceCurrency: 'USD' } };
    const html = slugPage().replace(/<script type="application\/ld\+json">[\s\S]*<\/script>/, [own, other].map((one) => `<script type="application/ld+json">${JSON.stringify(one)}</script>`).join(''));
    const named = await readSlug(html);
    assert.strictEqual(named.records[0].price, 48, JSON.stringify(named.diagnostics.samples));
    assert.strictEqual(named.records[0].imageUrl, SLUG_PHOTO);
    /* a group whose other records are its variants: the group is the product */
    const variantGroup = { '@type': 'ProductGroup', '@id': `${SLUG}#group`, name: 'Boxy Cotton Tee', image: [SLUG_PHOTO], hasVariant: [{ '@id': `${SLUG}#s` }, { '@id': `${SLUG}#m` }] };
    const variants = ['s', 'm'].map((size) => ({ '@type': 'Product', '@id': `${SLUG}#${size}`, isVariantOf: { '@id': `${SLUG}#group` }, name: `Boxy Cotton Tee - ${size.toUpperCase()}`, offers: { price: '48.00', priceCurrency: 'USD' } }));
    const grouped = await readSlug(slugPage().replace(/<script type="application\/ld\+json">[\s\S]*<\/script>/, `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [variantGroup, ...variants] })}</script>`));
    /* the group's variants' offers are the group's offers, and the
       product is named by the group, not by a size */
    assert.deepStrictEqual(grouped.diagnostics.outcomes, { photographed: 1 }, JSON.stringify(grouped.diagnostics.samples));
    assert.strictEqual(grouped.records[0].price, 48);
    assert.strictEqual(grouped.records[0].title, 'Boxy Cotton Tee');
    /* and variants that disagree about the price still fail closed */
    const disagreeing = await readSlug(slugPage().replace(/<script type="application\/ld\+json">[\s\S]*<\/script>/, `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [variantGroup, variants[0], Object.assign({}, variants[1], { offers: { price: '58.00', priceCurrency: 'USD' } })] })}</script>`));
    assert.deepStrictEqual(disagreeing.diagnostics.outcomes, { 'no-price': 1 });
  });

  await testAsync('a page naming a different garment from the listing it was reached by is not that listing', async () => {
    const { diagnostics } = await readSlug(slugPage({ canonical: 'https://www.slug-shop.com/products/linen-camp-shirt' }));
    assert.deepStrictEqual(diagnostics.outcomes, { 'no-identity': 1 });
    assert.match(diagnostics.samples[0].why, /different garment/);
  });

  const CATEGORY = 'https://www.shop-example.com/c/womens/trousers';
  const TILE = 'https://www.shop-example.com/p/wide-leg-trouser-navy-WL48299';
  const HOODIE = 'https://www.shop-example.com/p/oversized-hoodie-HD11223';
  const categoryPage = () => page(`<!doctype html><html><head><title>Women's Trousers | Shop Example</title>
    <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [
      { '@type': 'ListItem', position: 1, item: { '@type': 'Product', url: TILE, name: 'Wide Leg Trouser in Navy', sku: 'WL48299', image: 'https://cdn.shop-example.com/i/WL48299-tile.jpg' } },
      { '@type': 'ListItem', position: 2, item: { '@type': 'Product', url: HOODIE, name: 'Oversized Hoodie', sku: 'HD11223', image: 'https://cdn.shop-example.com/i/HD11223-tile.jpg' } },
      { '@type': 'ListItem', position: 3, item: { '@type': 'Product', url: URLS.good, name: 'Wide Leg Trouser in Stone', sku: 'WL48213', image: 'https://cdn.shop-example.com/i/WL48213-tile.jpg' } }
    ] })}</script></head><body></body></html>`);
  const tileRoutes = (href) => {
    if (href === CATEGORY) return categoryPage();
    if (href === TILE) return page(productPage({ sku: 'WL48299', name: 'Wide Leg Trouser in Navy', price: '84.00', siteName: 'Shop Example', image: 'https://cdn.shop-example.com/i/WL48299-front.jpg' }));
    if (href === 'https://cdn.shop-example.com/i/WL48299-front.jpg') return photo();
    return null;
  };

  await testAsync('a category page’s own listed products are offered — held to the shopper’s words, each proved on its own page', async () => {
    const calls = web(tileRoutes);
    const { records, diagnostics } = await readListings([
      { title: 'Wide Leg Trouser | Shop Example', productUrl: URLS.good },
      { title: "Women's Trousers | Shop Example", productUrl: CATEGORY }
    ], { limit: 12, deadline: deadlineIn(9000), query: 'wide leg trousers' });
    const { products, rejected } = verifyAll(records);
    /* the organic listing, then the category's product; never the category */
    assert.deepStrictEqual(products.map((one) => one.productUrl), [URLS.good, TILE]);
    assert.strictEqual(products[1].price, 84);
    assert.strictEqual(rejected['missing-price'], 1, 'the category page itself went to the gate and was refused');
    assert.ok(!calls.some((one) => one.url === HOODIE), 'a listed product that is not the garment asked for was fetched');
    assert.strictEqual(calls.filter((one) => one.url === URLS.good).length, 1, 'a product already offered was read twice');
    assert.strictEqual(diagnostics.categoryPagesRead, 1);
    assert.strictEqual(diagnostics.tilesOffered, 1);
    assert.strictEqual(diagnostics.outcomes['tile:photographed'], 1);
  });

  await testAsync('without the shopper’s words a category page is not read at all', async () => {
    const calls = web(tileRoutes);
    const { diagnostics } = await readListings([{ title: 'Trousers', productUrl: CATEGORY }], { limit: 12, deadline: deadlineIn(9000) });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(diagnostics.outcomes, { 'category-page': 1 });
  });

  await testAsync('the live search hands the shopper’s phrase to the category reader', async () => {
    web((href, options) => {
      if (href === serper.WEB_SEARCH_URL) return jsonResponse(200, { organic: [{ title: "Women's Trousers | Shop Example", link: CATEGORY, position: 1 }] });
      return tileRoutes(href, options);
    });
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(9000));
    /* both of the category's trousers — this time the Stone one was not
       among the organic results — in the category's own order; never
       the hoodie, and never the category */
    assert.deepStrictEqual(found.products.map((one) => one.productUrl), [TILE, URLS.good], JSON.stringify(found.funnel.organic));
  });

  await testAsync('a product search that times out still leaves the organic search its reserved time', async () => {
    web((href, options) => (href === serper.SEARCH_URL ? hanging(href, options) : null));
    const started = Date.now();
    const found = await findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(6500));
    assert.ok(Date.now() - started < 7000, `took ${Date.now() - started}ms`);
    assert.deepStrictEqual(found.products.map((one) => one.productUrl), [URLS.good, URLS.forwarded]);
    assert.match(found.funnel.organic.productSearchTimedOut, /^Serper \/shopping did not answer within/);
    assert.strictEqual(found.funnel.organic.asked, 'after the product search timed out');
  });

  await testAsync('a timeout is still the answer when the organic search fails too — and a non-timeout failure is never swallowed', async () => {
    web((href, options) => (href === serper.SEARCH_URL ? hanging(href, options) : href === serper.WEB_SEARCH_URL ? jsonResponse(500, { message: 'down' }) : null));
    await assert.rejects(() => findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(6500)), /Serper \/shopping did not answer within/);
    web((href) => (href === serper.SEARCH_URL ? jsonResponse(500, { message: 'boom' }) : null));
    await assert.rejects(() => findProducts(serper, INTENT, 12, cache.counters(), deadlineIn(6500)), /Serper responded 500/);
  });

  await testAsync('the benchmark names the stage that stopped each query that showed nothing', async () => {
    const { blockingCause } = require('./bench-live');
    const at = (outcomes, extra) => Object.assign({ returned: 0, providerFailure: null, organic: { offered: 5, failed: null, pages: { outcomes } } }, extra || {});
    assert.strictEqual(blockingCause(at({ unreadable: 3, 'no-price': 1 })), 'no-price', 'the furthest stage reached');
    assert.strictEqual(blockingCause(at({ 'category-page': 2, 'not-a-shop': 3 })), 'only-category-pages');
    assert.strictEqual(blockingCause(at({ 'tile:no-photo': 1, 'no-identity': 4 })), 'no-photo');
    assert.strictEqual(blockingCause(at({}, { providerFailure: 'Serper /shopping did not answer within 4000ms (timed out)', providerTimedOut: true })), 'provider-timeout');
    assert.strictEqual(blockingCause(at({}, { returned: 2 })), null);
  });


  console.log('\n  — 7. prices the reader could not read, and a garment it could not name\n');

  const { priceDiagnosis, PRICE_CLASSES } = require('../api/_providers/retailer-page');
  const ldRaw = (text) => `<!doctype html><html><head><meta property="og:site_name" content="Shop Example"><script type="application/ld+json">${text}</script></head></html>`;
  const readOne = async (html, url, photos) => {
    const target = url || URLS.good;
    web((href) => (href === target ? page(html) : (photos || ['https://cdn.shop-example.com/i/WL48213-front.jpg']).includes(href) ? photo() : null));
    return readListings([{ title: 'Wide Leg Trouser', productUrl: target }], { limit: 12, deadline: deadlineIn(9000) });
  };
  const PRODUCT_TEXT = (extra) => `{"@context":"https://schema.org","@type":"Product","name":"Wide Leg Trouser","sku":"WL48213","image":"https://cdn.shop-example.com/i/WL48213-front.jpg",${extra}"offers":{"@type":"Offer","price":"88.00","priceCurrency":"USD"}}`;

  await testAsync('a product record whose description says 30&quot; is still read — decoding had been breaking the JSON', async () => {
    const { records } = await readOne(ldRaw(PRODUCT_TEXT('"description":"A 30&quot; inseam, cut wide.",')));
    assert.strictEqual(records[0].price, 88);
    assert.strictEqual(records[0].imageUrl, 'https://cdn.shop-example.com/i/WL48213-front.jpg');
  });

  await testAsync('a raw newline in a string, or a trailing comma, no longer loses the whole record', async () => {
    assert.strictEqual((await readOne(ldRaw(PRODUCT_TEXT('"description":"Line one\nline two",')))).records[0].price, 88);
    assert.strictEqual((await readOne(ldRaw(PRODUCT_TEXT('').replace(/}}$/, '},}')))).records[0].price, 88);
    /* and a block that is not JSON at all is still nothing */
    assert.deepStrictEqual(images.jsonLdNodes(ldRaw('{"@type":"Product", nope')), []);
  });

  await testAsync('a Product that is a WebPage’s mainEntity is read', async () => {
    const { records } = await readOne(ldRaw(`{"@context":"https://schema.org","@type":"ItemPage","mainEntity":${PRODUCT_TEXT('')}}`));
    assert.strictEqual(records[0].price, 88);
  });

  await testAsync('a group named by its productGroupID is this listing; a record naming ANOTHER product still is not', async () => {
    const group = (id) => ldRaw(JSON.stringify({ '@context': 'https://schema.org', '@type': 'ProductGroup', name: 'Wide Leg Trouser', productGroupID: id,
      image: 'https://cdn.shop-example.com/i/WL48213-front.jpg', offers: { '@type': 'Offer', price: '88.00', priceCurrency: 'USD' } }));
    assert.strictEqual((await readOne(group('WL48213'))).records[0].price, 88);
    const other = await readOne(group('ZZ11111'));
    assert.strictEqual(other.records[0].price, undefined);
    assert.strictEqual(other.diagnostics.samples[0].priceCategory, 'record-names-another-product');
  });

  await testAsync('a record with no identifier is this listing’s when it names this page, or is the page’s own on its canonical page', async () => {
    const bare = (extra) => ({ '@context': 'https://schema.org', '@type': 'Product', name: 'Wide Leg Trouser', image: 'https://cdn.shop-example.com/i/WL48213-front.jpg',
      offers: { '@type': 'Offer', price: '88.00', priceCurrency: 'USD' } , ...extra });
    /* nothing names it: refused, as before */
    const none = await readOne(ldRaw(JSON.stringify(bare({}))));
    assert.strictEqual(none.records[0].price, undefined);
    assert.strictEqual(none.diagnostics.samples[0].priceCategory, 'record-not-tied-to-listing');
    /* its own url is this listing */
    assert.strictEqual((await readOne(ldRaw(JSON.stringify(bare({ url: URLS.good }))))).records[0].price, 88);
    /* its page is canonical for exactly this listing, and it is the only record */
    const canonical = ldRaw(JSON.stringify(bare({}))).replace('<head>', `<head><link rel="canonical" href="${URLS.good}"><meta property="og:type" content="product">`);
    assert.strictEqual((await readOne(canonical)).records[0].price, 88);
    /* but a coded listing is never moved: a page canonical for another address proves nothing for it */
    const moved = ldRaw(JSON.stringify(bare({}))).replace('<head>', '<head><link rel="canonical" href="https://www.shop-example.com/p/wide-leg-trouser-WL00001"><meta property="og:type" content="product">');
    assert.strictEqual((await readOne(moved)).records[0].price, undefined);
  });

  const MICRO = (priceBlock, extra) => `<!doctype html><html><head><meta property="og:site_name" content="Shop Example">${extra || ''}</head><body>
    <div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Wide Leg Trouser</h1><meta itemprop="sku" content="WL48213">
      <img itemprop="image" src="https://cdn.shop-example.com/i/WL48213-front.jpg">
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="priceCurrency" content="USD">${priceBlock}</div>
      <div class="related" itemscope itemtype="https://schema.org/Product"><meta itemprop="sku" content="ZZ99999">
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><span itemprop="price">$15.00</span></div></div>
    </div></body></html>`;

  await testAsync('microdata on the served page is read by the same gates the rendered page’s is', async () => {
    const onSale = prices.decide(prices.pricesFromHtml(MICRO('<s class="price-was" itemprop="price" content="120.00">$120</s><span class="price-sale" itemprop="price" content="88.00">$88</span>')).candidates, URLS.good);
    assert.strictEqual(onSale.price, 88, JSON.stringify(onSale.refusals));
    assert.ok(onSale.refusals.some((one) => one.amount === 15 && one.gate === 'this'), 'the related product’s price was not refused for identity');
    assert.ok(onSale.refusals.some((one) => one.amount === 120 && one.gate === 'charged'), 'the was-price was not refused as a list price');
  });

  await testAsync('served microdata that disagrees with the structured offer fails closed rather than outranking it', async () => {
    const both = MICRO('<span itemprop="price" content="78.00">$78</span>', `<script type="application/ld+json">${PRODUCT_TEXT('')}</script>`);
    const decided = prices.decide(prices.pricesFromHtml(both).candidates, URLS.good);
    assert.strictEqual(decided.price, undefined);
    assert.deepStrictEqual(decided.ambiguous, [78, 88]);
    const agreeing = MICRO('<span itemprop="price" content="88.00">$88</span>', `<script type="application/ld+json">${PRODUCT_TEXT('')}</script>`);
    assert.strictEqual(prices.decide(prices.pricesFromHtml(agreeing).candidates, URLS.good).price, 88);
  });

  await testAsync('every no-price page is classed by which of the four answers it was', async () => {
    const classOf = (html) => {
      const read = prices.pricesFromHtml(html);
      const decided = read.candidates.length ? prices.decide(read.candidates, URLS.good) : { refusals: [] };
      assert.strictEqual(decided.price, undefined, 'the fixture was meant to have no provable price');
      const category = priceDiagnosis(html, read, decided, images);
      return [category, PRICE_CLASSES[category]];
    };
    assert.deepStrictEqual(classOf('<html><body><p>Wide Leg Trouser</p></body></html>'), ['no-price-in-served-markup', '1-no-usable-price']);
    assert.deepStrictEqual(classOf('<html><head><meta property="og:price:amount" content="88.00"></head></html>'), ['price-only-in-page-metadata', '1-no-usable-price']);
    assert.deepStrictEqual(classOf(ldRaw('{"@type":"Product", nope')), ['json-ld-not-readable', '2-reader-gap']);
    assert.deepStrictEqual(classOf('<html><script id="__NEXT_DATA__">{"product":{"salePrice":"88.00"}}</script></html>'), ['price-only-in-embedded-data', '2-reader-gap']);
    assert.deepStrictEqual(classOf(ldRaw(JSON.stringify({ '@type': 'Product', sku: 'WL48213', offers: [{ price: '88' }, { price: '98' }] }))), ['several-prices', '3-refused-rightly']);
    assert.deepStrictEqual(classOf(ldRaw(JSON.stringify({ '@type': 'Product', sku: 'WL48213', offers: { '@type': 'AggregateOffer', lowPrice: '70', highPrice: '98' } }))), ['range-only', '3-refused-rightly']);
    assert.deepStrictEqual(classOf(ldRaw(JSON.stringify({ '@type': 'Product', sku: 'ZZ11111', offers: { price: '88' } }))), ['record-names-another-product', '4-identity-or-variant']);
    assert.deepStrictEqual(classOf(ldRaw(JSON.stringify({ '@type': 'Product', name: 'x', offers: { price: '88' } }))), ['record-not-tied-to-listing', '4-identity-or-variant']);
  });

  await testAsync('"puffy jacket" is a puffer to the semantic reader — and a puffy sleeve is still not outerwear', async () => {
    const read = (query, title) => images.semanticMatch({ id: 'query', name: query }, { title });
    for (const title of ['Cropped Puffer Jacket', 'Cropped Down Jacket', 'Short Puffer Coat']) {
      assert.strictEqual(read('short puffy jacket', title).ok, true, title);
    }
    assert.strictEqual(read('short puffy jacket', 'Washed Denim Jacket').ok, false, 'a denim jacket is not a puffer');
    assert.strictEqual(read('short puffy jacket', 'Quilted Puffer Vest').ok, false, 'a vest is not a jacket');
    assert.strictEqual(read('puff sleeve blouse', 'Puffy Sleeve Blouse').ok, true);
  });

  await testAsync('the benchmark says why a result above the target was the wrong garment', async () => {
    const { summarise } = require('./bench-live');
    const row = { query: 'short puffy jacket', returned: 2, garmentRank: 2, matchRank: 2, wrongAbove: 1, survived: [], duplicates: 0, interpretMs: 1, searchMs: 1, interpreter: 'local',
      wrongGarments: [{ name: 'Denim Jacket', retailer: 'X', productUrl: 'https://x.example/p/1', why: 'the row means a puffer and "Denim Jacket" is a jacket' }] };
    const summary = summarise([row]);
    assert.deepStrictEqual(summary.wrongGarmentsAbove, [{ query: 'short puffy jacket', results: row.wrongGarments }]);
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
