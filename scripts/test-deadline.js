#!/usr/bin/env node
/* =========================================================
   Fynd — bounded-time search test

   A search has one clock. /api/search starts it, every provider call is
   bounded by what is left of it, and when it runs out the request
   answers with whatever the verification gate has passed — rather than
   running on past the point the browser stopped listening.

   What this file holds to:

     * a fast source is untouched — full page, no lookups wasted
     * a slow source returns the products that DID resolve, as a 200,
       not a 502
     * a search that never answers fails inside the budget, not at the
       provider's own 15s
     * a lookup still in flight at the deadline is aborted, not awaited
     * nothing invented: a failure is an empty page, never a filled one
     * the verification gate is exactly what it was — the clock never
       relaxes what may be shown

   The network is stubbed throughout: every fetch here is answered from
   this file, and the stub honours the abort signal, which is what makes
   the deadline assertions mean anything.

   Usage: node scripts/test-deadline.js
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.OPENWEBNINJA_API_KEY = 'test-key-never-used';

const provider = require('../api/_providers/openwebninja');
const { verifyAll } = require('../api/_providers/product-source');
const handler = require('../api/search');
const cache = require('../api/_cache');

let passed = 0;
const failures = [];

/* Every test starts cold: a warm search cache would answer the next
   test's request with the previous test's records, and the counts this
   file asserts are counts of requests actually made. */
function reset() {
  cache.reset();
  delete process.env.FYND_REQUEST_BUDGET_MS;
}

async function testAsync(name, fn) {
  const realFetch = global.fetch;
  try {
    reset();
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  } finally {
    global.fetch = realFetch;
    reset();
  }
}

/* ---------------------------------------------------------
   Fixtures
   --------------------------------------------------------- */

/* A record carrying its own retailer link: showable with no lookup. */
const withInlineLink = (n) => ({
  product_id: `inline-${n}`,
  product_title: `Black Oversized Knit Jumper ${n}`,
  product_photos: [`https://img.example-cdn.com/knit/${n}.jpg`],
  product_page_url: 'https://www.google.com/shopping/product/1',
  product_attributes: { Brand: 'Everlane' },
  offer: {
    store_name: 'Nordstrom',
    price: '$64.00',
    offer_page_url: `https://www.nordstrom.com/s/oversized-knit/${n}`
  }
});

/* A record as the live search endpoint usually returns one: a Google
   product view and no retailer link, so it is worth exactly one lookup. */
const needsLookup = (n) => ({
  product_id: `needs-${n}`,
  product_title: `Black Oversized Knit Cardigan ${n}`,
  product_photos: [`https://img.example-cdn.com/cardi/${n}.jpg`],
  product_page_url: 'https://www.google.com/shopping/product/2',
  product_attributes: { Brand: 'Arket' },
  price: '$70.00',
  store_name: 'arket.com'
});

const envelope = (products) => ({ status: 'OK', request_id: 'req-1', data: products });
const offersPayload = (offers) => ({ status: 'OK', request_id: 'req-offers', data: offers });
const sellerOffer = (n) => ({
  store_name: 'Arket',
  price: '$70.00',
  offer_page_url: `https://www.arket.com/en/product/knit-cardigan-${n}`,
  product_condition: 'NEW'
});

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

/* The stub. `search` and `offer` each say how that call behaves:
   a number of milliseconds, or HANG to never answer at all. A HANGing
   call is only ever ended by its abort signal — which is the whole
   point: the request has to end because the DEADLINE ended it. */
const HANG = Symbol('never answers');

function installFetch({ search, offers }) {
  const state = { searchCalls: 0, offerCalls: 0, aborted: 0, urls: [] };

  global.fetch = (url, options) => {
    const href = String(url);
    state.urls.push(href);
    const isOffers = href.includes('/product-offers');
    const index = isOffers ? state.offerCalls++ : state.searchCalls++;
    const plan = isOffers ? offers(index) : search(index);

    return new Promise((resolve, reject) => {
      let timer = null;

      if (plan && plan.error !== undefined && plan.delay === undefined) {
        return reject(new Error(plan.error));
      }
      if (plan.answer !== HANG) {
        timer = setTimeout(() => resolve(plan.answer), plan.delay || 0);
      }

      const signal = options && options.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          if (timer) clearTimeout(timer);
          state.aborted += 1;
          const err = new Error('This operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
  };

  return state;
}

/* The handler, driven the way a browser drives it. */
function mockRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

async function post(body) {
  const res = mockRes();
  const startedAt = Date.now();
  await handler({
    method: 'POST',
    headers: { host: 'ai-clothes-application.vercel.app', origin: 'https://lxmafromnyc.github.io', 'content-type': 'application/json' },
    body,
    on: (ev, cb) => { if (ev === 'end') cb(); }
  }, res);
  return { res, elapsed: Date.now() - startedAt };
}

const INTENT = { categories: ['knit'], colors: ['Black'], fits: ['Oversized'], maxPrice: 80, keywords: ['knit'] };

async function main() {
  console.log('\na fast product source is left alone');

  await testAsync('full page of products, no lookups spent, well inside the budget', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => withInlineLink(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(twelve)), delay: 5 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });

    const { res, elapsed } = await post({ intent: INTENT, limit: 12 });

    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.products.length, 12, 'every record should be shown');
    assert.strictEqual(state.searchCalls, 1, 'one search request');
    assert.strictEqual(state.offerCalls, 0, 'a record with its own link needs no lookup');
    assert.strictEqual(res.body.diagnostics.timing.deadlineExpired, false);
    assert.ok(elapsed < 2000, `answered in ${elapsed}ms`);
  });

  await testAsync('the budget is reported alongside what the request spent', async () => {
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope([withInlineLink(1)])), delay: 0 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    const { res } = await post({ intent: INTENT, limit: 12 });
    const timing = res.body.diagnostics.timing;
    assert.strictEqual(timing.budgetMs, 9000, 'nine seconds by default');
    assert.ok(typeof timing.totalMs === 'number' && timing.totalMs >= 0);
    assert.ok(typeof res.body.diagnostics.searchMs === 'number', 'the search leg is timed');
    assert.ok(typeof res.body.diagnostics.offersMs === 'number', 'the offer phase is timed');
    assert.strictEqual(state.searchCalls, 1);
  });

  console.log('\na slow product source returns what it resolved, not an error');

  await testAsync('partial verified results come back as 200, not 502', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '500';
    const eight = Array.from({ length: 8 }, (_, i) => needsLookup(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(eight)), delay: 5 }),
      /* three sellers answer at once; every later lookup hangs until the
         deadline aborts it */
      offers: (i) => (i < 3
        ? { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 }
        : { answer: HANG })
    });

    const { res, elapsed } = await post({ intent: INTENT, limit: 8 });

    assert.strictEqual(res.statusCode, 200, `a partly resolved search is not a failure: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.products.length, 3, 'the three that resolved are shown');
    assert.ok(state.offerCalls > 3, 'later lookups were started and cut off');
    assert.strictEqual(res.body.diagnostics.offers.budgetExpired, true, 'the tally says the clock ended it');
    assert.ok(elapsed < 2500, `answered in ${elapsed}ms, inside the browser's window`);
  });

  await testAsync('a short page is still a real page — every product keeps a direct retailer link', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '500';
    const six = Array.from({ length: 6 }, (_, i) => needsLookup(i));
    installFetch({
      search: () => ({ answer: okResponse(envelope(six)), delay: 5 }),
      offers: (i) => (i < 2
        ? { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 }
        : { answer: HANG })
    });

    const { res } = await post({ intent: INTENT, limit: 6 });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.products.length >= 1 && res.body.products.length < 6, 'short, not empty and not full');
    res.body.products.forEach((p) => {
      assert.ok(/^https:\/\//.test(p.productUrl), `${p.productUrl} must be https`);
      assert.ok(!/google\./i.test(new URL(p.productUrl).hostname), 'never a Google page');
      assert.ok(/^https:\/\//.test(p.imageUrl), 'the photo must be loadable');
      assert.ok(p.price > 0 && p.retailer, 'price and retailer intact');
    });
  });

  console.log('\na search that never answers fails inside the budget');

  await testAsync('the upstream search timing out is a 502, at the deadline and not at 15s', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '400';
    const state = installFetch({
      search: () => ({ answer: HANG }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });

    const { res, elapsed } = await post({ intent: INTENT, limit: 12 });

    assert.strictEqual(res.statusCode, 502, 'no records at all is the one case that is a failure');
    assert.strictEqual(res.body.source, 'openwebninja');
    assert.ok(!res.body.products, 'a failure carries no products');
    assert.strictEqual(state.aborted, 1, 'the search request itself was aborted');
    assert.ok(elapsed < 2000, `failed in ${elapsed}ms rather than the provider's own 15000`);
  });

  await testAsync('the search leg is capped short of the deadline, leaving the offer phase a window', async () => {
    const now = Date.now();
    /* nine seconds left, two of them reserved */
    assert.strictEqual(provider.legTimeout(now + 9000, provider.OFFER_RESERVE_MS), 7000);
    /* when the reserve would leave nothing, the search gets what is left
       rather than one millisecond */
    assert.strictEqual(provider.legTimeout(now + 1500, provider.OFFER_RESERVE_MS), 1500);
    /* no deadline at all is the old behaviour, unchanged */
    assert.strictEqual(provider.legTimeout(null, provider.OFFER_RESERVE_MS), 15000);
    /* and a single call is never given more than its own allowance */
    assert.strictEqual(provider.legTimeout(now + 60000, 0), 15000);
    /* past the deadline there is no time to give */
    assert.strictEqual(provider.legTimeout(now - 1, 0), 0);
  });

  await testAsync('no request is opened once the deadline has passed', async () => {
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope([])), delay: 0 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    await assert.rejects(
      () => provider.search(INTENT, { limit: 12, deadline: Date.now() - 1 }),
      /time budget/i,
      'a deadline already gone refuses rather than dialling out'
    );
    assert.strictEqual(state.searchCalls, 0, 'nothing was sent');
  });

  console.log('\nlookups in flight at the deadline are dropped, not awaited');

  await testAsync('every hanging lookup is aborted', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '400';
    const eight = Array.from({ length: 8 }, (_, i) => needsLookup(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(eight)), delay: 5 }),
      offers: () => ({ answer: HANG })
    });

    const { res, elapsed } = await post({ intent: INTENT, limit: 8 });

    assert.ok(state.offerCalls >= 4, `lookups were started (${state.offerCalls})`);
    assert.strictEqual(state.aborted, state.offerCalls, 'every one of them was aborted');
    assert.ok(elapsed < 2000, `the answer did not wait for them: ${elapsed}ms`);
    assert.strictEqual(res.statusCode, 200, 'nothing resolved, but the search itself worked');
    assert.strictEqual(res.body.products.length, 0, 'and nothing unverified was shown');
  });

  await testAsync('the answer arrives near the deadline, not near the provider timeout', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '600';
    const four = Array.from({ length: 4 }, (_, i) => needsLookup(i));
    installFetch({
      search: () => ({ answer: okResponse(envelope(four)), delay: 10 }),
      offers: () => ({ answer: HANG })
    });

    const { elapsed } = await post({ intent: INTENT, limit: 4 });

    /* the budget, plus room for a slow machine — and nowhere near the
       15000 a single unbounded lookup would have taken */
    assert.ok(elapsed < 3000, `answered in ${elapsed}ms`);
  });

  await testAsync('a lookup is never started with too little time to answer', async () => {
    /* the search leg eats all but a sliver of the budget */
    process.env.FYND_REQUEST_BUDGET_MS = '500';
    const six = Array.from({ length: 6 }, (_, i) => needsLookup(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(six)), delay: 400 }),
      offers: () => ({ answer: HANG })
    });

    const { res } = await post({ intent: INTENT, limit: 6 });

    assert.strictEqual(state.offerCalls, 0, 'no request spent on a lookup that could only be aborted');
    assert.strictEqual(res.statusCode, 200, 'the search itself still answered');
    assert.strictEqual(res.body.diagnostics.offers.budgetExpired, true, 'and the tally says why the page is thin');
  });

  console.log('\nnothing is invented when the source fails');

  await testAsync('a failed search returns no products at all', async () => {
    installFetch({
      search: () => ({ error: 'connection reset' }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });

    const { res } = await post({ intent: INTENT, limit: 12 });

    assert.strictEqual(res.statusCode, 502);
    assert.ok(!res.body.products);
    assert.ok(!/sample|demo/i.test(JSON.stringify(res.body)), 'no stand-in items');
  });

  await testAsync('offers that all fail give an empty page, never a filled one', async () => {
    const six = Array.from({ length: 6 }, (_, i) => needsLookup(i));
    installFetch({
      search: () => ({ answer: okResponse(envelope(six)), delay: 0 }),
      offers: () => ({ error: 'upstream 500' })
    });

    const { res } = await post({ intent: INTENT, limit: 6 });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.products.length, 0, 'no link, no product');
    assert.strictEqual(res.body.returned, 6, 'the records are still counted honestly');
    /* an unresolved record carries no price either: toRecord takes price,
       retailer and URL from one offer or takes none of them, so the gate
       names the first field it finds missing */
    assert.strictEqual(res.body.rejected['missing-price'], 6, 'and every drop is named');
  });

  await testAsync('a failed search is never cached, so the next shopper still asks', async () => {
    const state = installFetch({
      search: () => ({ error: 'connection reset' }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    await post({ intent: INTENT, limit: 12 });
    await post({ intent: INTENT, limit: 12 });
    assert.strictEqual(state.searchCalls, 2, 'a failure must not be stored as an answer');
  });

  console.log('\nthe verification gate is untouched by the clock');

  await testAsync('a Google link is still refused, deadline or no deadline', async () => {
    /* a complete record in every other way, pointed at Google: this is
       the link rule itself, with nothing else to fail on */
    const record = provider.toRecord(withInlineLink(1));
    record.productUrl = 'https://www.google.com/shopping/product/9';
    const { products, rejected } = verifyAll([record], { retailer: null });
    assert.strictEqual(products.length, 0);
    assert.strictEqual(rejected['product-url-not-a-retailer-page'], 1, JSON.stringify(rejected));
  });

  await testAsync('a search record that only ever had a Google link yields no commerce at all', async () => {
    const googleOnly = Object.assign(needsLookup(1), { product_page_url: 'https://www.google.com/shopping/product/9' });
    const record = provider.toRecord(googleOnly);
    assert.strictEqual(record.productUrl, undefined, 'no link');
    assert.strictEqual(record.price, undefined, 'and no price to show beside one');
    const { products } = verifyAll([record], { retailer: null });
    assert.strictEqual(products.length, 0);
  });

  await testAsync('an http photo is still refused', async () => {
    const record = provider.toRecord(withInlineLink(1));
    record.imageUrl = 'http://img.example-cdn.com/knit/1.jpg';
    const { products, rejected } = verifyAll([record], { retailer: null });
    assert.strictEqual(products.length, 0);
    assert.strictEqual(rejected['image-url-not-https'], 1);
  });

  await testAsync('a complete record still passes, and carries the source’s own fields', async () => {
    const { products } = verifyAll([provider.toRecord(withInlineLink(3))], { retailer: null });
    assert.strictEqual(products.length, 1);
    assert.strictEqual(products[0].productUrl, 'https://www.nordstrom.com/s/oversized-knit/3');
    assert.strictEqual(products[0].imageUrl, 'https://img.example-cdn.com/knit/3.jpg');
    assert.strictEqual(products[0].price, 64);
  });

  await testAsync('a truncated search shows only what the gate passed', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '500';
    const mixed = [withInlineLink(1), needsLookup(2), needsLookup(3), needsLookup(4)];
    installFetch({
      search: () => ({ answer: okResponse(envelope(mixed)), delay: 5 }),
      offers: () => ({ answer: HANG })
    });

    const { res } = await post({ intent: INTENT, limit: 4 });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.products.length, 1, 'only the one that never needed a lookup');
    assert.strictEqual(res.body.products[0].productUrl, 'https://www.nordstrom.com/s/oversized-knit/1');
    assert.ok(res.body.rejected['missing-price'] >= 3, 'the rest were dropped by the gate, not shown');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
