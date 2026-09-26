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

  await testAsync('a listing whose URL names no product is never fetched: no price on it could be tied to it', async () => {
    const slug = 'https://www.slug-shop.com/products/wide-leg-trouser-stone';
    const calls = web();
    const { records, diagnostics } = await readListings([{ title: 'Wide Leg Trouser', productUrl: slug }], { limit: 12, deadline: deadlineIn(9000) });
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(diagnostics.outcomes, { 'no-product-code': 1 });
    assert.strictEqual(verifyAll(records).rejected['missing-price'], 1);
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
    assert.deepStrictEqual(outcomes, { photographed: 2, 'no-price': 1, 'no-photo': 1, 'left-the-retailer': 1, 'not-a-product-page': 1 });
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
      assert.match(err.message, /^Serper did not answer within \d+ms \(timed out\)$/);
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
        /Serper did not answer within \d+ms \(timed out\)$/
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

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
