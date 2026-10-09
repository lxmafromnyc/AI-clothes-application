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
    /* nothing resolved because no seller answered in time: said as that,
       not as an empty page that reads like "nothing matched" */
    assert.strictEqual(res.statusCode, 502, JSON.stringify(res.body));
    assert.strictEqual(res.body.reason, 'timeout');
    assert.strictEqual(res.body.stage, 'offers');
    assert.strictEqual(res.body.products, undefined, 'and nothing unverified was shown');
    assert.strictEqual(res.body.diagnostics.offers.lookupsTimedOut, state.offerCalls, 'the tally the 200 carried still says how far it got');
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
    /* the source answered, and there was no time left to confirm a price */
    assert.strictEqual(res.statusCode, 502, JSON.stringify(res.body));
    assert.deepStrictEqual([res.body.reason, res.body.stage], ['timeout', 'offers']);
    assert.strictEqual(res.body.diagnostics.offers.budgetExpired, true, 'and the tally says why the page is empty');
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

  console.log('\npartial offer resolution is a partial answer, never a 502');

  /* The live shape that prompted these: the provider answers 200 with
     ten products, six resolve to verified offers, four lookups time
     out. That is a page of six, not a failure. */
  const withLookupCap = async (ms, fn) => {
    process.env.OPENWEBNINJA_OFFER_LOOKUP_TIMEOUT_MS = String(ms);
    try { return await fn(); } finally { delete process.env.OPENWEBNINJA_OFFER_LOOKUP_TIMEOUT_MS; }
  };

  await testAsync('ten returned, four lookups time out, six verify: 200 with the six', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '1500';
    const ten = Array.from({ length: 10 }, (_, i) => needsLookup(i));
    installFetch({
      search: () => ({ answer: okResponse(envelope(ten)), delay: 5 }),
      /* every fourth seller never answers */
      offers: (i) => (i % 3 === 1 && i < 10 ? { answer: HANG } : { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 })
    });

    const { res } = await withLookupCap(200, () => post({ intent: INTENT, limit: 6 }));

    assert.strictEqual(res.statusCode, 200, `a partly resolved search is not a failure: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.products.length, 6, 'the six that verified are shown');
    assert.ok(res.body.diagnostics.offers.lookupsTimedOut >= 1, 'the timed-out lookups are counted as timeouts');
    assert.strictEqual(res.body.diagnostics.offers.lookupsTimedOut, res.body.diagnostics.offers.lookupsFailed,
      'every failure here was the clock, and the tally says so');
    res.body.products.forEach((p) => {
      assert.ok(p.price === 70, `${p.productUrl} carries the seller's own price`);
      assert.ok(/^https:\/\/www\.arket\.com\/en\/product\/knit-cardigan-\d+$/.test(p.productUrl), `${p.productUrl} is the seller's own link`);
    });
  });

  await testAsync('stragglers at the head of the list no longer starve the candidates behind them', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '1500';
    const ten = Array.from({ length: 10 }, (_, i) => needsLookup(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(ten)), delay: 5 }),
      /* the FIRST four lookups — one per worker — never answer */
      offers: (i) => (i < 4 ? { answer: HANG } : { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 })
    });

    const { res, elapsed } = await withLookupCap(200, () => post({ intent: INTENT, limit: 6 }));

    assert.strictEqual(res.statusCode, 200);
    /* before the cap, each straggler was given the whole remaining
       budget, held its worker to the deadline, and the page was empty */
    assert.strictEqual(res.body.products.length, 6, `the six behind the stragglers verify: ${JSON.stringify(res.body.rejected)}`);
    assert.strictEqual(res.body.diagnostics.offers.lookupsTimedOut, 4);
    assert.strictEqual(state.offerCalls, 10, 'each straggler was replaced by the next candidate');
    assert.ok(elapsed < 1500, `answered in ${elapsed}ms, before the deadline`);
  });

  await testAsync('a straggler gives up its worker at the cap, and itself ends at the deadline, not the provider\'s 15s', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '1200';
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope([needsLookup(0), needsLookup(1)])), delay: 5 }),
      offers: (i) => (i === 0 ? { answer: HANG } : { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 })
    });
    const { res, elapsed } = await withLookupCap(200, () => post({ intent: INTENT, limit: 2 }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.products.length, 1, 'the one that answered is shown');
    const offers = res.body.diagnostics.offers;
    assert.deepStrictEqual([offers.lookupsPastCap, offers.lookupsTimedOut, offers.lookupsAnsweredLate], [1, 1, 0]);
    /* the page was short, so the straggler was waited for — to the
       request's own deadline, and no further */
    assert.ok(elapsed >= 1000 && elapsed < 3000, `held to the deadline, not to 15s (${elapsed}ms)`);
    assert.strictEqual(state.aborted, 1, 'and aborted there');
  });

  await testAsync('a product whose lookup timed out or carried no price stays rejected', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '1500';
    const six = Array.from({ length: 6 }, (_, i) => needsLookup(i));
    installFetch({
      search: () => ({ answer: okResponse(envelope(six)), delay: 5 }),
      offers: (i) => {
        if (i < 2) return { answer: HANG };
        /* a seller that answers with a link and no price */
        if (i < 4) return { answer: okResponse(offersPayload([Object.assign(sellerOffer(i), { price: undefined })])), delay: 5 };
        return { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 };
      }
    });

    const { res } = await withLookupCap(200, () => post({ intent: INTENT, limit: 6 }));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.products.length, 2, 'only the two with a verified price and link');
    assert.strictEqual(res.body.rejected['missing-price'], 4, `${JSON.stringify(res.body.rejected)}`);
    res.body.products.forEach((p) => assert.ok(typeof p.price === 'number' && p.price > 0, 'no product without a real price'));
  });

  console.log('\na lookup slower than its cap is still a lookup (the live shape: every seller past 2.5s)');

  await testAsync('every lookup slower than its cap but inside the deadline: used, not thrown away, at no extra request', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '1500';
    const six = Array.from({ length: 6 }, (_, i) => needsLookup(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(six)), delay: 5 }),
      /* every seller answers, slower than the cap */
      offers: (i) => ({ answer: okResponse(offersPayload([sellerOffer(i)])), delay: 450 })
    });
    const { res, elapsed } = await withLookupCap(200, () => post({ intent: INTENT, limit: 6 }));
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    /* with the cap aborting them, this was the production page: nothing */
    assert.strictEqual(res.body.products.length, 6, `the late answers are shown: ${JSON.stringify(res.body.diagnostics.offers)}`);
    const offers = res.body.diagnostics.offers;
    /* the same lookups the capped pool started — six, at the same moments */
    assert.strictEqual(state.offerCalls, 6, 'no request the capped pool would not have made');
    assert.deepStrictEqual([offers.lookupsPastCap, offers.lookupsAnsweredLate, offers.resolvedLate, offers.lookupsTimedOut], [6, 6, 6, 0]);
    assert.strictEqual(offers.lookupTiming.answered, 6);
    assert.ok(offers.lookupTiming.totalMsMin >= 400, `each lookup's own time is measured: ${JSON.stringify(offers.lookupTiming)}`);
    assert.ok(elapsed < 1500, `inside the deadline (${elapsed}ms)`);
    res.body.products.forEach((p) => {
      assert.strictEqual(p.price, 70, 'the seller\'s own price');
      assert.ok(/^https:\/\/www\.arket\.com\/en\/product\/knit-cardigan-\d+$/.test(p.productUrl), p.productUrl);
      assert.ok(/^https:\/\/img\.example-cdn\.com\//.test(p.imageUrl), 'the product\'s own photo');
    });
  });

  await testAsync('a late answer without a price is refused exactly as an early one', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '1500';
    const four = Array.from({ length: 4 }, (_, i) => needsLookup(i));
    installFetch({
      search: () => ({ answer: okResponse(envelope(four)), delay: 5 }),
      offers: (i) => ({ answer: okResponse(offersPayload([Object.assign(sellerOffer(i), { price: undefined })])), delay: 400 })
    });
    const { res } = await withLookupCap(200, () => post({ intent: INTENT, limit: 4 }));
    /* the sellers answered, in time, with nothing that can be shown: an honest empty page */
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.products.length, 0);
    assert.strictEqual(res.body.rejected['missing-price'], 4);
  });

  await testAsync('fast, late and never: the fast and the late are shown, the never ends at the deadline', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '1200';
    const six = Array.from({ length: 6 }, (_, i) => needsLookup(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(six)), delay: 5 }),
      offers: (i) => {
        if (i < 2) return { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 };
        if (i < 4) return { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 450 };
        return { answer: HANG };
      }
    });
    const { res, elapsed } = await withLookupCap(200, () => post({ intent: INTENT, limit: 6 }));
    assert.strictEqual(res.statusCode, 200, 'a partial page is a page');
    assert.strictEqual(res.body.products.length, 4);
    const offers = res.body.diagnostics.offers;
    assert.deepStrictEqual([offers.resolvedFromOffers, offers.resolvedLate, offers.lookupsTimedOut], [4, 2, 2]);
    assert.strictEqual(state.aborted, 2, 'the two that never answered were aborted');
    assert.ok(elapsed >= 1000 && elapsed < 3000, `ended at the deadline (${elapsed}ms)`);
  });

  await testAsync('once the page is full, stragglers are cancelled and the search answers then', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '3000';
    const four = Array.from({ length: 4 }, (_, i) => needsLookup(i));
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope(four)), delay: 5 }),
      offers: (i) => (i < 2 ? { answer: HANG } : { answer: okResponse(offersPayload([sellerOffer(i)])), delay: 5 })
    });
    const { res, elapsed } = await withLookupCap(200, () => post({ intent: INTENT, limit: 2 }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.products.length, 2);
    assert.strictEqual(res.body.diagnostics.offers.lookupsCancelled, 2);
    assert.strictEqual(state.aborted, 2);
    assert.ok(elapsed < 1000, `answered when full, not at the 3s deadline (${elapsed}ms)`);
  });

  await testAsync('no seller answers before the deadline: a 502 that says so, with the tally, and not charged', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '700';
    const six = Array.from({ length: 6 }, (_, i) => needsLookup(i));
    installFetch({
      search: () => ({ answer: okResponse(envelope(six)), delay: 5 }),
      offers: () => ({ answer: HANG })
    });
    const before = await withLookupCap(200, () => post({ intent: INTENT, limit: 6 }));
    assert.strictEqual(before.res.statusCode, 502, JSON.stringify(before.res.body));
    assert.deepStrictEqual(
      [before.res.body.error, before.res.body.reason, before.res.body.kind, before.res.body.stage, before.res.body.source],
      ['The product source did not confirm any prices in time.', 'timeout', 'timeout', 'offers', 'openwebninja']);
    assert.strictEqual(before.res.body.products, undefined, 'no product, verified or not');
    assert.strictEqual(before.res.body.usage, undefined, 'nothing charged');
    assert.strictEqual(before.res.body.returned, 6);
    assert.strictEqual(before.res.body.rejected['missing-price'], 6);
    const offers = before.res.body.diagnostics.offers;
    assert.strictEqual(offers.resolvedFromOffers, 0);
    assert.strictEqual(offers.lookupsTimedOut, offers.lookupsMade);
    /* the same shopper's next search is their first charged one */
    cache.reset();
    installFetch({
      search: () => ({ answer: okResponse(envelope([withInlineLink(1)])), delay: 5 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 5 })
    });
    const after = await post({ intent: INTENT, limit: 1 });
    assert.strictEqual(after.res.statusCode, 200);
    assert.strictEqual(after.res.body.usage.used, 1, `the 502 was not counted: ${JSON.stringify(after.res.body.usage)}`);
  });

  console.log('\na total failure is still a failure, and says which kind');

  await testAsync('a search that never answers is a 502 that says it timed out', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '400';
    installFetch({
      search: () => ({ answer: HANG }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    const { res } = await post({ intent: INTENT, limit: 12 });
    assert.strictEqual(res.statusCode, 502);
    assert.deepStrictEqual(res.body, { error: 'The product source did not answer in time.', reason: 'timeout', kind: 'timeout', upstreamStatus: null, source: 'openwebninja' });
  });

  await testAsync('a source that errors is a 502 that says it failed, with no products', async () => {
    installFetch({
      search: () => ({ answer: { ok: false, status: 500, json: async () => ({}), text: async () => 'upstream exploded' }, delay: 5 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    const { res } = await post({ intent: INTENT, limit: 12 });
    assert.strictEqual(res.statusCode, 502);
    assert.deepStrictEqual(res.body, { error: 'The product source is unavailable right now.', reason: 'failed', kind: 'server-error', upstreamStatus: 500, source: 'openwebninja' });
  });

  await testAsync('a refused key is a 502 that names the refusal and its status, and nothing from the source', async () => {
    installFetch({
      search: () => ({ answer: { ok: false, status: 403, json: async () => ({}), text: async () => '{"message":"You are not subscribed to this API."}' }, delay: 5 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    const { res } = await post({ intent: INTENT, limit: 12 });
    assert.strictEqual(res.statusCode, 502);
    assert.deepStrictEqual(res.body, { error: 'The product source is unavailable right now.', reason: 'failed', kind: 'invalid-key', upstreamStatus: 403, source: 'openwebninja' });
    assert.ok(!JSON.stringify(res.body).includes('subscribed'), 'the source\'s own message reached the browser');
  });

  await testAsync('a connection that fails is a 502 that says it was the network, with no status', async () => {
    installFetch({
      search: () => ({ error: 'fetch failed' }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    const { res } = await post({ intent: INTENT, limit: 12 });
    assert.strictEqual(res.statusCode, 502);
    assert.deepStrictEqual({ reason: res.body.reason, kind: res.body.kind, upstreamStatus: res.body.upstreamStatus }, { reason: 'failed', kind: 'network', upstreamStatus: null });
  });

  await testAsync('a source that answers 200 with a page that is not JSON is a 502 that says so', async () => {
    installFetch({
      search: () => ({ answer: { ok: true, status: 200, json: async () => JSON.parse('<!doctype html>'), text: async () => '<!doctype html>' }, delay: 0 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    const { res } = await post({ intent: INTENT, limit: 12 });
    assert.strictEqual(res.statusCode, 502);
    assert.deepStrictEqual({ reason: res.body.reason, kind: res.body.kind }, { reason: 'failed', kind: 'bad-response' });
  });

  await testAsync('a failure of ours after the source answered is a 500 that names the stage, never "the source is unavailable"', async () => {
    const relevance = require('../api/_providers/relevance');
    const real = relevance.rankByIntent;
    relevance.rankByIntent = () => { throw new TypeError("Cannot read properties of undefined (reading 'length')"); };
    delete require.cache[require.resolve('../api/search')];
    const fresh = require('../api/search');
    const error = console.error;
    const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    try {
      installFetch({
        search: () => ({ answer: okResponse(envelope([withInlineLink(1), withInlineLink(2)])), delay: 0 }),
        offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
      });
      const res = mockRes();
      await fresh({ method: 'POST', headers: { host: 'ai-clothes-application.vercel.app', origin: 'https://lxmafromnyc.github.io' }, body: { intent: INTENT, limit: 12 }, on: () => {} }, res);
      assert.strictEqual(res.statusCode, 500);
      assert.deepStrictEqual(res.body, { error: 'The search failed inside Fynd.', reason: 'internal', stage: 'ranking', source: 'openwebninja' });
      assert.ok(logged.some((line) => /Search failed inside Fynd .*stage: ranking/.test(line)), logged.join(' | '));
      assert.ok(!logged.some((line) => /Product source failed/.test(line)), 'reported as the source failing');
    } finally {
      console.error = error;
      relevance.rankByIntent = real;
      delete require.cache[require.resolve('../api/search')];
      require('../api/search');
    }
  });

  await testAsync('a cached offer of another shape is a miss: the lookup is made and the product keeps its link', async () => {
    const store = require('../api/_store');
    const region = provider.cacheContext();
    const record = needsLookup(7);
    const key = cache.offerKey({ provider: 'openwebninja', productId: record.product_id, country: region.country, language: region.language, store: record.store_name });
    await store.set(key, { expiresAt: Date.now() + 600000, commerce: 'from another version' }, { ttlSeconds: 600 });
    assert.strictEqual(await cache.readOffer(key, cache.counters()), null);
    await store.set(key, { expiresAt: Date.now() + 600000 }, { ttlSeconds: 600 });
    assert.strictEqual(await cache.readOffer(key, cache.counters()), null);
    /* a real negative entry and a real offer still read as they always did */
    await store.set(key, { expiresAt: Date.now() + 600000, none: true, reason: 'no-offers' }, { ttlSeconds: 600 });
    assert.deepStrictEqual(await cache.readOffer(key, cache.counters()), { none: true, reason: 'no-offers' });
    await store.set(key, { expiresAt: Date.now() + 600000, commerce: { price: 70, retailer: 'Arket', productUrl: 'https://www.arket.com/p/7' } }, { ttlSeconds: 600 });
    assert.strictEqual((await cache.readOffer(key, cache.counters())).commerce.productUrl, 'https://www.arket.com/p/7');
  });

  await testAsync('a cached search whose records are not records is a miss, not half an hour of nothing', async () => {
    const store = require('../api/_store');
    const key = cache.searchKey({ provider: 'openwebninja', intent: INTENT, limit: 12, context: {} });
    await store.set(key, { expiresAt: Date.now() + 600000, records: [null, 7, 'x'] }, { ttlSeconds: 600 });
    assert.strictEqual(await cache.readSearch(key, cache.counters()), null);
    await store.set(key, { expiresAt: Date.now() + 600000, records: [{ title: 'A Hoodie' }] }, { ttlSeconds: 600 });
    assert.deepStrictEqual((await cache.readSearch(key, cache.counters())).records, [{ title: 'A Hoodie' }]);
  });

  await testAsync('a provider timeout says so in its own words', async () => {
    installFetch({ search: () => ({ answer: HANG }), offers: () => ({ answer: HANG }) });
    await assert.rejects(() => provider.search(INTENT, { limit: 4, deadline: Date.now() + 300 }),
      (err) => /OpenWeb Ninja did not answer within \d+ms \(timed out\)/.test(err.message));
  });

  console.log('\nthe request the search makes is the one the probe makes');

  const withEnv = async (vars, fn) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
    try { return await fn(); } finally {
      Object.entries(saved).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
    }
  };

  await testAsync('the search sends exactly the request searchRequest builds — the one the probe sends', async () => {
    const state = installFetch({
      search: () => ({ answer: okResponse(envelope([withInlineLink(1)])), delay: 0 }),
      offers: () => ({ answer: okResponse(offersPayload([])), delay: 0 })
    });
    for (const intent of [INTENT, { garments: ['hoodie'], colors: ['Grey'], fits: ['Relaxed'], keywords: ['baggy', 'cozy'] }, { keywords: ['linen', 'shirt'], minPrice: 20, maxPrice: 60 }]) {
      state.urls.length = 0;
      cache.reset();
      await provider.search(intent, { limit: 12 });
      const built = provider.searchRequest(intent, { limit: 12 });
      assert.strictEqual(state.urls[0], `${built.url}?${built.params}`);
    }
  });

  await testAsync('a key pasted with quotes, spaces or a newline is sent clean; an empty one is not a key', async () => {
    const seen = [];
    global.fetch = (url, options) => { seen.push(options.headers['x-api-key']); return Promise.resolve(okResponse(envelope([withInlineLink(1)]))); };
    for (const raw of ['"the-key"', "  'the-key'  ", 'the-key\n', ' the-key ']) {
      await withEnv({ OPENWEBNINJA_API_KEY: raw }, async () => {
        cache.reset();
        assert.strictEqual(provider.configured(), true);
        await provider.search(INTENT, { limit: 1 });
      });
    }
    assert.deepStrictEqual(seen, ['the-key', 'the-key', 'the-key', 'the-key']);
    for (const raw of ['', '   ', '""']) {
      await withEnv({ OPENWEBNINJA_API_KEY: raw }, async () => assert.strictEqual(provider.configured(), false, JSON.stringify(raw)));
    }
  });

  await testAsync('the country and language are sent as the two-letter codes the API takes, and never guessed', async () => {
    const cases = [
      [{}, 'us', 'en'],
      [{ OPENWEBNINJA_COUNTRY: ' US ', OPENWEBNINJA_LANGUAGE: 'en-US' }, 'us', 'en'],
      [{ OPENWEBNINJA_COUNTRY: '"gb"', OPENWEBNINJA_LANGUAGE: 'FR' }, 'gb', 'fr'],
      [{ OPENWEBNINJA_COUNTRY: 'United States', OPENWEBNINJA_LANGUAGE: 'English' }, 'us', 'en']
    ];
    const warn = console.warn;
    const warnings = [];
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
      for (const [vars, country, language] of cases) {
        await withEnv(Object.assign({ OPENWEBNINJA_COUNTRY: undefined, OPENWEBNINJA_LANGUAGE: undefined }, vars), async () => {
          const built = provider.searchRequest(INTENT, { limit: 12 });
          assert.deepStrictEqual([built.params.get('country'), built.params.get('language')], [country, language], JSON.stringify(vars));
          /* the cache files the answer under the region actually asked */
          const context = provider.cacheContext();
          assert.deepStrictEqual([context.country, context.language], [country, language]);
        });
      }
    } finally { console.warn = warn; }
    /* a value that is not a code is named, not silently replaced */
    assert.ok(warnings.some((w) => /OPENWEBNINJA_COUNTRY is not a two-letter code/.test(w)), warnings.join(' | '));
    assert.ok(warnings.some((w) => /OPENWEBNINJA_LANGUAGE is not a two-letter code/.test(w)), warnings.join(' | '));
  });

  console.log('\nthe probe runs the route: the same effective request, deadline and answer');

  const probeModule = require('./probe-openwebninja');
  const { browserBody } = require('./diagnose-search');

  /* a stand-in OpenWeb Ninja that records every request whole —
     headers included, compared here and never printed — and answers
     each as `plan` says */
  const recorder = (plan) => {
    const seen = [];
    global.fetch = (url, options) => {
      const u = new URL(String(url));
      seen.push({ host: u.hostname, method: (options && options.method) || 'GET', path: u.pathname, params: Object.fromEntries(u.searchParams.entries()), body: (options && options.body) || null, headers: Object.assign({}, options && options.headers), at: Date.now() });
      return plan(u, options);
    };
    return seen;
  };
  const answering = (u) => Promise.resolve(u.pathname.endsWith('/product-offers')
    ? okResponse(offersPayload([sellerOffer(u.searchParams.get('product_id'))]))
    : okResponse(envelope([withInlineLink(1), needsLookup(2), withInlineLink(3), needsLookup(4)])));
  const routeAnswer = async (body) => {
    const res = mockRes();
    await handler({ method: 'POST', headers: { host: 'ai-clothes-application.vercel.app', origin: 'https://lxmafromnyc.github.io', 'content-type': 'application/json' }, body, on: () => {} }, res);
    return res;
  };

  await testAsync('for the same body and environment, the probe and /api/search send identical requests to the provider', async () => {
    const messy = (await browserBody('pants that arent skinny')).body;
    const bodies = [
      { intent: INTENT, limit: 12 },
      messy,
      { intent: { garments: ['hoodie'], colors: ['Grey'], keywords: ['hoodie'], minPrice: 30, maxPrice: 90 }, limit: 24 },
      { intent: { keywords: ['linen', 'shirt'] }, limit: 3 }
    ];
    const envs = [{}, { OPENWEBNINJA_COUNTRY: ' GB ', OPENWEBNINJA_LANGUAGE: 'en-GB', OPENWEBNINJA_API_KEY: '"quoted-key"' }];
    let compared = 0;
    const warn = console.warn;
    console.warn = () => {};
    try {
    for (const env of envs) {
      for (const body of bodies) {
        await withEnv(env, async () => {
          cache.reset();
          const viaRoute = recorder(answering);
          const res = await routeAnswer(body);
          cache.reset();
          const viaProbe = recorder(answering);
          const probed = await probeModule.probe({ body, photos: false });
          const label = `${JSON.stringify(env)} ${JSON.stringify(body.intent).slice(0, 60)}`;
          assert.strictEqual(res.statusCode, 200, label);
          assert.strictEqual(probed.status, 200, label);
          assert.deepStrictEqual(viaProbe.map((c) => [c.path, c.params]), viaRoute.map((c) => [c.path, c.params]), `${label}: a different request`);
          assert.deepStrictEqual(viaProbe.map((c) => c.headers), viaRoute.map((c) => c.headers), `${label}: different headers`);
          assert.ok(viaRoute.every((c) => c.headers['x-api-key'] === provider.apiKey()), `${label}: not this environment's key`);
          /* and the answer the browser gets is the answer the probe reports */
          assert.deepStrictEqual(probed.answer.products, res.body.products, `${label}: different products`);
          assert.deepStrictEqual(probed.answer.rejected, res.body.rejected, `${label}: different refusals`);
          assert.ok(probed.calls.every((c) => c.keyIsThisEnvironments), label);
          if (res.body.products.length) compared += 1;
        });
      }
    }
    } finally {
      console.warn = warn;
    }
    /* the products compared were real verified products, not two empty lists */
    assert.ok(compared >= 2, `${compared} cases verified anything`);
  });

  await testAsync('the probe gives the /search leg the route\'s own timeout, and is cut off at the same moment', async () => {
    process.env.FYND_REQUEST_BUDGET_MS = '600';
    const hang = (u, options) => new Promise((resolve, reject) => {
      const signal = options && options.signal;
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
    });
    try {
      cache.reset();
      let started = Date.now();
      const viaRoute = recorder(hang);
      const res = await routeAnswer({ intent: INTENT, limit: 12 });
      const routeMs = Date.now() - started;
      cache.reset();
      started = Date.now();
      recorder(hang);
      const probed = await probeModule.probe({ body: { intent: INTENT, limit: 12 }, photos: false });
      const probeMs = Date.now() - started;
      assert.strictEqual(res.statusCode, 502);
      assert.strictEqual(probed.status, 502);
      assert.deepStrictEqual(probed.answer, res.body);
      assert.strictEqual(res.body.reason, 'timeout');
      assert.strictEqual(probed.plannedSearchTimeoutMs <= 600 && probed.plannedSearchTimeoutMs >= 500, true, `${probed.plannedSearchTimeoutMs}`);
      assert.ok(probed.calls[0].abortedAfterMs !== null, 'the probe\'s request was not cut off by the clock');
      assert.ok(Math.abs(routeMs - probeMs) < 150, `route ${routeMs}ms, probe ${probeMs}ms`);
      assert.strictEqual(viaRoute.length, 1);
    } finally {
      delete process.env.FYND_REQUEST_BUDGET_MS;
    }
  });

  await testAsync('every provider failure reads the same from the probe as from /api/search', async () => {
    const replies = {
      'invalid key': () => Promise.resolve({ ok: false, status: 401, json: async () => ({}), text: async () => '{"message":"Invalid API key"}' }),
      'not subscribed': () => Promise.resolve({ ok: false, status: 403, json: async () => ({}), text: async () => '{"message":"You are not subscribed to this API."}' }),
      'bad request': () => Promise.resolve({ ok: false, status: 400, json: async () => ({}), text: async () => '{"message":"Invalid value for country"}' }),
      'rate limited': () => Promise.resolve({ ok: false, status: 429, json: async () => ({}), text: async () => '{"message":"Too many requests"}' }),
      'server error': () => Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => 'down' }),
      'not JSON': () => Promise.resolve({ ok: true, status: 200, json: async () => JSON.parse('<html>'), text: async () => '<html>' }),
      network: () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))
    };
    const error = console.error;
    console.error = () => {};
    try {
      for (const [name, reply] of Object.entries(replies)) {
        cache.reset();
        recorder(reply);
        const res = await routeAnswer({ intent: INTENT, limit: 12 });
        cache.reset();
        recorder(reply);
        const probed = await probeModule.probe({ body: { intent: INTENT, limit: 12 }, photos: false });
        assert.strictEqual(res.statusCode, 502, name);
        assert.strictEqual(probed.status, 502, name);
        assert.deepStrictEqual(probed.answer, res.body, name);
        assert.strictEqual(probed.failure.kind, res.body.kind, name);
      }
    } finally {
      console.error = error;
    }
  });

  /* OpenWeb Ninja out of searches, and Serper behind it: the route's
     own fallback (searchWithFallback through providerChain), answered
     here by the real Serper adapter against a stand-in for its host */
  const OWN_SPENT = () => Promise.resolve({ ok: false, status: 429, json: async () => ({}), text: async () => '{"message":"Too many requests"}' });
  const serperShopping = {
    shopping: [1, 2, 3].map((n) => ({
      title: `Black Oversized Knit Sweater ${n}`,
      price: `$${55 + n}.00`,
      link: `https://www.arket.com/en/product/knit-${n}`,
      imageUrl: `https://img.arket-cdn.com/knit-${n}.jpg`,
      source: 'Arket',
      productId: `s${n}`
    }))
  };
  const withSerper = (serper) => (u, options) => (u.hostname === 'google.serper.dev' ? serper(u, options) : OWN_SPENT());
  /* the requests both made, in a stable order: Serper may start its
     organic search beside the shopping one */
  const outbound = (seen) => seen.map((c) => JSON.stringify([c.host, c.method, c.path, c.params, c.body, c.headers])).sort();

  await testAsync('when OpenWeb Ninja is out of searches, the probe and /api/search fall back to Serper identically, and the probe shows the Serper request', async () => {
    const error = console.error;
    const warn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      await withEnv({ SERPER_API_KEY: 'serper-test-key' }, async () => {
        const serper = (u) => Promise.resolve(okResponse(u.pathname === '/shopping' ? serperShopping : { organic: [] }));
        cache.reset();
        const viaRoute = recorder(withSerper(serper));
        const res = await routeAnswer({ intent: INTENT, limit: 12 });
        cache.reset();
        const viaProbe = recorder(withSerper(serper));
        const probed = await probeModule.probe({ body: { intent: INTENT, limit: 12 }, photos: false });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(probed.status, 200);
        assert.strictEqual(res.body.source, 'serper');
        assert.strictEqual(res.body.diagnostics.fellBackFrom.provider, 'openwebninja');
        assert.deepStrictEqual(outbound(viaProbe), outbound(viaRoute), 'a different request somewhere in the chain');
        assert.deepStrictEqual(viaRoute.map((c) => c.host).filter((h, i, all) => all.indexOf(h) === i), ['api.openwebninja.com', 'google.serper.dev']);
        assert.ok(res.body.products.length > 0, 'the fallback verified nothing, so nothing was compared');
        assert.deepStrictEqual(probed.answer.products, res.body.products);
        assert.deepStrictEqual(probed.answer.diagnostics.fellBackFrom, res.body.diagnostics.fellBackFrom);
        /* and the probe now shows what the route did: both sources, each with its own key, the refusal by kind */
        assert.deepStrictEqual(probed.calls.map((c) => c.source).filter((h, i, all) => all.indexOf(h) === i), ['openwebninja', 'serper']);
        assert.ok(probed.calls.every((c) => c.keyIsThisEnvironments), JSON.stringify(probed.calls.map((c) => [c.source, c.keyIsThisEnvironments])));
        const shopping = probed.calls.find((c) => c.source === 'serper' && c.path === '/shopping');
        assert.ok(shopping && shopping.method === 'POST' && shopping.params.q, 'the Serper search is missing from the probe, or without its query');
        assert.deepStrictEqual(probed.fellBackFrom, { provider: 'openwebninja', kind: 'rate-limited' });
        assert.ok(!JSON.stringify(probed.calls).includes('serper-test-key') && !JSON.stringify(probed.calls).includes('test-key-never-used'), 'a key reached the probe\'s record');
      });
    } finally {
      console.error = error;
      console.warn = warn;
    }
  });

  await testAsync('when the fallback is spent too, the probe and /api/search answer the same 502 after the same requests', async () => {
    const error = console.error;
    const warn = console.warn;
    console.error = () => {};
    console.warn = () => {};
    try {
      await withEnv({ SERPER_API_KEY: 'serper-test-key' }, async () => {
        const spent = () => Promise.resolve({ ok: false, status: 400, json: async () => ({}), text: async () => '{"message":"Not enough credits","statusCode":400}' });
        cache.reset();
        const viaRoute = recorder(withSerper(spent));
        const res = await routeAnswer({ intent: INTENT, limit: 12 });
        cache.reset();
        const viaProbe = recorder(withSerper(spent));
        const probed = await probeModule.probe({ body: { intent: INTENT, limit: 12 }, photos: false });
        assert.strictEqual(res.statusCode, 502);
        assert.strictEqual(probed.status, 502);
        assert.deepStrictEqual(probed.answer, res.body);
        assert.strictEqual(res.body.kind, 'credits-exhausted', 'the answer is the fallback\'s own failure');
        assert.deepStrictEqual(outbound(viaProbe), outbound(viaRoute));
        /* OpenWeb Ninja asked once; Serper's shopping search (and the organic one it starts beside it) once each */
        assert.strictEqual(viaRoute.filter((c) => c.host === 'api.openwebninja.com' && /\/search$/.test(c.path)).length, 1);
        assert.strictEqual(viaRoute.filter((c) => c.host === 'api.openwebninja.com').length, 1, 'a refused search was followed by offer lookups');
        assert.deepStrictEqual(viaRoute.filter((c) => c.host === 'google.serper.dev').map((c) => c.path).sort(), ['/search', '/shopping']);
        assert.deepStrictEqual(probed.fellBackFrom, { provider: 'openwebninja', kind: 'rate-limited' });
      });
    } finally {
      console.error = error;
      console.warn = warn;
    }
  });

  await testAsync('with no product source configured, /api/search answers 503 and the probe refuses to run; neither asks a provider', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      await withEnv({ OPENWEBNINJA_API_KEY: undefined, SERPER_API_KEY: 'serper-test-key' }, async () => {
        cache.reset();
        const viaRoute = recorder(answering);
        const res = await routeAnswer({ intent: INTENT, limit: 12 });
        assert.strictEqual(res.statusCode, 503);
        assert.deepStrictEqual(res.body, { error: 'No product source is configured.', source: null });
        const viaProbe = recorder(answering);
        await assert.rejects(() => probeModule.probe({ body: { intent: INTENT, limit: 12 }, photos: false }), /OPENWEBNINJA_API_KEY is not set/);
        /* a configured fallback is not a configured source: nothing was asked */
        assert.strictEqual(viaRoute.length + viaProbe.length, 0);
      });
    } finally {
      console.warn = warn;
    }
  });

  await testAsync('the diagnostic says whether the running server answered as this process does, and names a disagreement', async () => {
    const { agreement } = require('./diagnose-search');
    const handlerAnswer = { status: 200, kind: null, upstreamStatus: null };
    assert.ok(/agree \(200\)/.test(agreement({ server: { status: 200 }, handler: handlerAnswer })));
    /* the probe's environment works, the server's key is refused: two environments */
    const split = agreement({ server: { status: 502, kind: 'invalid-key', upstreamStatus: 401 }, handler: handlerAnswer });
    assert.ok(/DISAGREE/.test(split) && /invalid-key/.test(split) && /not reading the same environment/.test(split), split);
    assert.ok(/could not be reached/.test(agreement({ server: { status: null }, handler: handlerAnswer })));
  });

  await testAsync('by default the probe searches what the page would post, not the raw words', async () => {
    cache.reset();
    const seen = recorder(answering);
    await probeModule.probe({ query: 'black oversized hoodie under $80', photos: false });
    const page = (await browserBody('black oversized hoodie under $80')).body;
    const built = provider.searchRequest(require('../api/search').shapeIntent(page.intent), { limit: page.limit });
    assert.deepStrictEqual(seen[0].params, Object.fromEntries(built.params.entries()));
    assert.strictEqual(seen[0].params.max_price, '80', 'the stated budget never reached the provider');
    /* the old behaviour is still there, and says what it is */
    cache.reset();
    const raw = recorder(answering);
    const old = await probeModule.probe({ query: 'black oversized hoodie under $80', keywords: true, photos: false });
    assert.strictEqual(old.input, 'the raw words as keywords');
    assert.strictEqual(raw[0].params.max_price, undefined);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
