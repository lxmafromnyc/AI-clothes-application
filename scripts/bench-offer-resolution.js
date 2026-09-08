#!/usr/bin/env node
/* =========================================================
   Fynd — offer-resolution benchmark

   Measures what one search costs the OpenWeb Ninja provider, offline.
   Both endpoints are stubbed with seeded data, so a run is repeatable
   and a change to the adapter can be measured against the run before
   it on exactly the same records.

   Every scenario is run three times on the SAME seeded world, which is
   what makes the cache's effect a measurement rather than a claim:

     cold      an empty cache: what a search costs when nobody has
               asked for it before
     warm      the same search again, inside the search TTL: the
               search-result cache answers, and nothing is bought
     offers    the same search once the 30-minute search entry has
               expired but the 2-hour offer entries have not: one
               /search request, and no lookups behind it

   It reports, per scenario and averaged:

     requests        every call the adapter made
     lookups         of those, calls to /product-offers
     shown           products that would fill the grid, capped at 12
     gate pass rate  verified / records that reached the gate
     latency         wall clock, with a modelled cost per request
     wasted          lookups spent on records that were not shown
     hit rate        cache reads answered, over cache reads made

   The comparison the cache is meant to be judged on is cold against
   the other two: the products shown must be identical, and the
   requests must not be.

   Usage
     node scripts/bench-offer-resolution.js
     node scripts/bench-offer-resolution.js --out=before.json
     node scripts/bench-offer-resolution.js --compare=before.json

   No key and no network: nothing here reaches OpenWeb Ninja, and the
   numbers are about the adapter's decisions, not the vendor's data.
   ========================================================= */

'use strict';

const fs = require('fs');
const provider = require('../api/_providers/openwebninja');
const { verifyAll } = require('../api/_providers/product-source');
const cache = require('../api/_cache');
const { findProducts } = require('../api/search');

/* The benchmark owns the clock, so a 30-minute TTL can expire between
   two passes without the run taking 30 minutes. */
let clockOffset = 0;
cache.setClock(() => Date.now() + clockOffset);

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

/* Modelled network cost. Real numbers vary; what matters is that the
   same model is applied before and after, so the shape of the change —
   fewer round trips, or the same ones — is visible.

   Lookups are given a spread rather than one fixed cost, because a
   straggler is the whole difference between waiting for a batch and
   taking the next answer as it arrives. The spread is seeded, so the
   same lookup costs the same in every run. */
const SEARCH_MS = 300;
const OFFER_MS_MIN = 150;
const OFFER_MS_SPREAD = 450;

/* A seeded generator, so "85% of records have a photo" means the same
   85 records in every run. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* One scenario's data: the search payload and the offers each product
   would return, both fixed up front so the adapter's choices are the
   only thing that varies. */
function buildWorld(scenario) {
  const random = seeded(scenario.seed);
  const products = [];
  const offersById = {};
  const latencyById = {};

  for (let i = 0; i < scenario.returned; i += 1) {
    const id = `p${i}`;
    const hasPhoto = random() < scenario.imageRate;
    const overBudget = random() < scenario.overBudgetRate;
    const resolves = random() < scenario.resolveRate;
    const fails = random() < scenario.failRate;
    const duplicate = random() < scenario.duplicateRate;
    const price = overBudget ? 90 + Math.floor(random() * 200) : 20 + Math.floor(random() * 55);
    latencyById[id] = OFFER_MS_MIN + Math.floor(random() * OFFER_MS_SPREAD);

    products.push(Object.assign({
      product_id: id,
      product_title: `Oversized hoodie ${i}`,
      price: `$${price}.00`,
      store_name: 'nordstrom.com',
      /* Google's own page, as live responses return */
      product_page_url: `https://www.google.com/shopping/product/${i}`
    }, hasPhoto ? { product_photos: [`https://img.example-cdn.com/${i}.jpg`] } : {}));

    if (fails) { offersById[id] = 'fail'; continue; }
    if (!resolves) {
      /* sellers came back, but none with a link we can show */
      offersById[id] = [{ store_name: 'Marketplace', price: `$${price}.00`, offer_page_url: 'https://www.google.com/shopping/product/x' }];
      continue;
    }
    /* a duplicate points at a URL another record also resolves to */
    const target = duplicate ? 'p0' : id;
    offersById[id] = [{
      store_name: 'Nordstrom',
      /* the offer's price, which is not always the record's stated one */
      price: `$${overBudget ? price + 40 : price}.00`,
      offer_page_url: `https://www.nordstrom.com/s/hoodie/${target}`
    }];
  }
  return { products, offersById, latencyById };
}

function stubFor(world, counters) {
  const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  return async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/product-offers')) {
      counters.lookups += 1;
      const id = u.searchParams.get('product_id');
      await sleep(world.latencyById[id]);
      const offers = world.offersById[id];
      if (offers === 'fail') return { ok: false, status: 500, text: async () => 'upstream' };
      counters.lookedUp.push(id);
      return okResponse({ status: 'OK', request_id: 'r', data: offers || [] });
    }
    counters.searches += 1;
    await sleep(SEARCH_MS);
    return okResponse({ status: 'OK', request_id: 'r', data: world.products });
  };
}

const SCENARIOS = [
  { name: 'clean data', seed: 11, returned: 24, imageRate: 1, resolveRate: 1, failRate: 0, overBudgetRate: 0, duplicateRate: 0 },
  { name: 'typical', seed: 22, returned: 24, imageRate: 0.85, resolveRate: 0.8, failRate: 0.05, overBudgetRate: 0.1, duplicateRate: 0.05 },
  { name: 'thin on photos', seed: 33, returned: 24, imageRate: 0.6, resolveRate: 0.85, failRate: 0.05, overBudgetRate: 0.1, duplicateRate: 0 },
  { name: 'tight budget', seed: 44, returned: 24, imageRate: 0.95, resolveRate: 0.85, failRate: 0, overBudgetRate: 0.35, duplicateRate: 0 },
  { name: 'many duplicates', seed: 55, returned: 24, imageRate: 0.95, resolveRate: 0.9, failRate: 0, overBudgetRate: 0.05, duplicateRate: 0.25 },
  { name: 'poor resolution', seed: 66, returned: 24, imageRate: 0.9, resolveRate: 0.5, failRate: 0.1, overBudgetRate: 0.05, duplicateRate: 0 }
];

const intent = {
  categories: ['hoodie'], colors: ['black'], occasions: [], fits: ['oversized'],
  brands: [], styles: [], keywords: [], maxPrice: 80, minPrice: null, season: null, gender: null
};

const LIMIT = 12;

/* Reads answered over reads made, across both layers. A cold pass reads
   and finds nothing, so its rate is 0 by construction; the number to
   look at is the warm one. */
function hitRate(stats) {
  const hits = stats.searchCache.hit + stats.offerCache.hit + stats.offerCache.negativeHit;
  const misses = stats.searchCache.miss + stats.offerCache.miss;
  return hits + misses ? Math.round((hits / (hits + misses)) * 1000) / 10 : 0;
}

/* One pass over one world, through the same function /api/search calls,
   so the search-result cache is part of what is being measured rather
   than something the benchmark steps around. */
async function runPass(world, label) {
  const counters = { searches: 0, lookups: 0, lookedUp: [] };
  const stats = cache.counters();
  const real = global.fetch;
  global.fetch = stubFor(world, counters);
  process.env.OPENWEBNINJA_API_KEY = 'bench';

  const started = Date.now();
  let found;
  try {
    found = await findProducts(provider, intent, LIMIT, stats);
  } finally {
    global.fetch = real;
  }
  const latency = Date.now() - started;

  const records = found.records;
  const products = found.products;
  const shown = products.slice(0, LIMIT);

  /* a lookup is wasted when the record it was spent on is not on the
     page: it resolved to nothing, or resolved and was dropped anyway */
  const shownUrls = new Set(shown.map((p) => p.productUrl));
  const wasted = counters.lookedUp.filter((id) => {
    const record = records.find((r) => r.sku === id);
    return !record || !record.productUrl || !shownUrls.has(record.productUrl);
  }).length + (counters.lookups - counters.lookedUp.length);

  return {
    pass: label,
    requests: counters.searches + counters.lookups,
    lookups: counters.lookups,
    shown: shown.length,
    reachedGate: records.length,
    verified: products.length,
    gatePassRate: records.length ? Math.round((products.length / records.length) * 1000) / 10 : 0,
    latency,
    wasted,
    hitRate: hitRate(stats),
    avoided: stats.providerRequestsAvoided,
    servedFromCache: found.servedFromCache,
    urls: shown.map((p) => p.productUrl),
    offers: found.funnel && found.funnel.offers ? found.funnel.offers : null
  };
}

/* The three passes, on one world and one seeded set of records.

   The cache starts empty for every scenario, so "cold" means cold. The
   clock is what separates the second pass from the third: 31 minutes
   past the search TTL and well inside the offer TTL, which is the state
   a busy deployment spends most of its time in. */
async function runScenario(scenario) {
  const world = buildWorld(scenario);

  cache.reset();
  clockOffset = 0;

  const cold = await runPass(world, 'cold');
  const warm = await runPass(world, 'warm');

  clockOffset += 31 * 60 * 1000;
  const offersWarm = await runPass(world, 'offers');

  clockOffset = 0;
  cache.reset();

  /* The whole point, asserted rather than assumed: a cache that changes
     what a shopper sees is not a cache, it is a bug. */
  const same = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);
  const consistent = same(cold.urls, warm.urls) && same(cold.urls, offersWarm.urls);

  return { scenario: scenario.name, cold, warm, offersWarm, consistent };
}

const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const round = (n, p = 1) => Number(n.toFixed(p));

/* One pass, averaged over the scenarios. This is the row a change to
   the adapter or to the cache is judged on. */
const summarise = (passes) => ({
  requests: round(mean(passes.map((r) => r.requests)), 2),
  lookups: round(mean(passes.map((r) => r.lookups)), 2),
  shown: round(mean(passes.map((r) => r.shown)), 2),
  gatePassRate: round(mean(passes.map((r) => r.gatePassRate)), 1),
  latency: Math.round(mean(passes.map((r) => r.latency))),
  wasted: round(mean(passes.map((r) => r.wasted)), 2),
  hitRate: round(mean(passes.map((r) => r.hitRate)), 1),
  avoided: round(mean(passes.map((r) => r.avoided)), 2),
  fullPages: passes.filter((r) => r.shown >= LIMIT).length
});

const HEAD = `  ${pad('scenario', 20)}${padStart('requests', 9)}${padStart('lookups', 8)}${padStart('shown', 6)}${padStart('gate', 7)}${padStart('ms', 7)}${padStart('wasted', 8)}${padStart('hit%', 7)}${padStart('avoided', 9)}`;

const line = (label, r) =>
  `  ${pad(label, 20)}${padStart(r.requests, 9)}${padStart(r.lookups, 8)}${padStart(r.shown, 6)}` +
  `${padStart(r.gatePassRate + '%', 7)}${padStart(r.latency, 7)}${padStart(r.wasted, 8)}` +
  `${padStart(r.hitRate + '%', 7)}${padStart(r.avoided, 9)}`;

(async () => {
  const rows = [];
  for (const scenario of SCENARIOS) rows.push(await runScenario(scenario));

  const passes = {
    cold: rows.map((r) => r.cold),
    warm: rows.map((r) => r.warm),
    offersWarm: rows.map((r) => r.offersWarm)
  };

  const summary = {
    cold: summarise(passes.cold),
    warm: summarise(passes.warm),
    offersWarm: summarise(passes.offersWarm)
  };

  for (const [label, title] of [
    ['cold', 'cold cache — nobody has asked for this before'],
    ['warm', 'warm cache — asked for again inside the 30-minute search TTL'],
    ['offersWarm', 'search TTL expired, offers still warm — one /search, no lookups']
  ]) {
    console.log(`\n=== ${title} ===\n`);
    console.log(HEAD);
    rows.forEach((r) => console.log(line(r.scenario, r[label])));
    console.log('');
    console.log(line('mean', summary[label]));
    console.log(`  full pages of ${LIMIT}: ${summary[label].fullPages} of ${rows.length}`);
  }

  /* The claim the whole thing rests on. A cache that changes what a
     shopper sees has failed whatever it did to the request count. */
  const inconsistent = rows.filter((r) => !r.consistent);
  console.log('');
  if (inconsistent.length) {
    console.log(`  DIFFERENT PRODUCTS SHOWN in: ${inconsistent.map((r) => r.scenario).join(', ')}`);
  } else {
    console.log('  every pass showed exactly the same products, in the same order');
  }

  const delta = (after, prior, unit = '') => {
    const diff = round(after - prior, 2);
    const pct = prior ? ` (${diff > 0 ? '+' : ''}${round((diff / prior) * 100, 1)}%)` : '';
    return `${prior}${unit} -> ${after}${unit}  ${diff > 0 ? '+' : ''}${diff}${unit}${pct}`;
  };

  console.log('\n=== cold against warm ===\n');
  console.log(`  ${pad('requests / search', 24)}${delta(summary.warm.requests, summary.cold.requests)}`);
  console.log(`  ${pad('offer lookups / search', 24)}${delta(summary.warm.lookups, summary.cold.lookups)}`);
  console.log(`  ${pad('products shown', 24)}${delta(summary.warm.shown, summary.cold.shown)}`);
  console.log(`  ${pad('latency', 24)}${delta(summary.warm.latency, summary.cold.latency, 'ms')}`);
  console.log(`  ${pad('cache hit rate', 24)}${summary.cold.hitRate}% -> ${summary.warm.hitRate}%`);

  console.log('\n=== cold against offers-warm ===\n');
  console.log(`  ${pad('requests / search', 24)}${delta(summary.offersWarm.requests, summary.cold.requests)}`);
  console.log(`  ${pad('offer lookups / search', 24)}${delta(summary.offersWarm.lookups, summary.cold.lookups)}`);
  console.log(`  ${pad('products shown', 24)}${delta(summary.offersWarm.shown, summary.cold.shown)}`);
  console.log(`  ${pad('latency', 24)}${delta(summary.offersWarm.latency, summary.cold.latency, 'ms')}`);
  console.log(`  ${pad('cache hit rate', 24)}${summary.cold.hitRate}% -> ${summary.offersWarm.hitRate}%`);
  console.log('');

  /* A file written before the cache existed carries `summary.requests`
     rather than `summary.cold.requests`; both are read, so an old
     baseline is still comparable against this run's cold pass. */
  const compare = flag('compare', null);
  if (compare) {
    const before = JSON.parse(fs.readFileSync(compare, 'utf8'));
    const priorSummary = before.summary.cold || before.summary;
    const priorRow = (i) => (before.rows[i] && before.rows[i].cold) || before.rows[i];

    console.log('=== this run\'s cold pass against ' + compare + ' ===\n');
    console.log(`  ${pad('requests / search', 24)}${delta(summary.cold.requests, priorSummary.requests)}`);
    console.log(`  ${pad('offer lookups / search', 24)}${delta(summary.cold.lookups, priorSummary.lookups)}`);
    console.log(`  ${pad('products shown', 24)}${delta(summary.cold.shown, priorSummary.shown)}`);
    console.log(`  ${pad('gate pass rate', 24)}${delta(summary.cold.gatePassRate, priorSummary.gatePassRate, '%')}`);
    console.log(`  ${pad('latency', 24)}${delta(summary.cold.latency, priorSummary.latency, 'ms')}`);
    console.log(`  ${pad('wasted lookups', 24)}${delta(summary.cold.wasted, priorSummary.wasted)}`);
    console.log(`  ${pad('full pages', 24)}${priorSummary.fullPages} -> ${summary.cold.fullPages} of ${rows.length}`);
    console.log('\n  per scenario, requests then shown:\n');
    rows.forEach((r, i) => {
      const b = priorRow(i);
      console.log(`  ${pad(r.scenario, 20)}${padStart(b.requests + ' -> ' + r.cold.requests, 12)}${padStart(b.shown + ' -> ' + r.cold.shown, 12)}`);
    });
    console.log('');
  }

  const out = flag('out', null);
  if (out) {
    /* the URLs are dropped: they are how a pass is checked against
       another pass, not something a saved baseline needs to carry */
    const strip = (r) => Object.assign({}, r, { urls: undefined });
    fs.writeFileSync(out, JSON.stringify({
      ranAt: new Date().toISOString(),
      limit: LIMIT,
      ttls: {
        searchSeconds: cache.SEARCH_TTL_SECONDS(),
        offerSeconds: cache.OFFER_TTL_SECONDS(),
        negativeSeconds: cache.NEGATIVE_TTL_SECONDS()
      },
      summary,
      rows: rows.map((r) => ({
        scenario: r.scenario,
        consistent: r.consistent,
        cold: strip(r.cold),
        warm: strip(r.warm),
        offersWarm: strip(r.offersWarm)
      }))
    }, null, 2));
    console.log(`  written: ${out}\n`);
  }
})();
