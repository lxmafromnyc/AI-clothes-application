#!/usr/bin/env node
/* =========================================================
   Fynd — offer-resolution benchmark

   Measures what one search costs the OpenWeb Ninja provider, offline.
   Both endpoints are stubbed with seeded data, so a run is repeatable
   and a change to the adapter can be measured against the run before
   it on exactly the same records.

   It reports, per scenario and averaged:

     requests        every call the adapter made
     lookups         of those, calls to /product-offers
     shown           products that would fill the grid, capped at 12
     gate pass rate  verified / records that reached the gate
     latency         wall clock, with a modelled cost per request
     wasted          lookups spent on records that were not shown

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

async function runScenario(scenario) {
  const world = buildWorld(scenario);
  const counters = { searches: 0, lookups: 0, lookedUp: [] };
  const real = global.fetch;
  global.fetch = stubFor(world, counters);
  process.env.OPENWEBNINJA_API_KEY = 'bench';

  const started = Date.now();
  let records;
  try {
    records = await provider.search(intent, { limit: LIMIT });
  } finally {
    global.fetch = real;
  }
  const { products } = verifyAll(records, { retailer: provider.defaultRetailer });
  const latency = Date.now() - started;
  const shown = products.slice(0, LIMIT);

  /* a lookup is wasted when the record it was spent on is not on the
     page: it resolved to nothing, or resolved and was dropped anyway */
  const shownUrls = new Set(shown.map((p) => p.productUrl));
  const wasted = counters.lookedUp.filter((id) => {
    const record = records.find((r) => r.sku === id);
    return !record || !record.productUrl || !shownUrls.has(record.productUrl);
  }).length + (counters.lookups - counters.lookedUp.length);

  return {
    scenario: scenario.name,
    requests: counters.searches + counters.lookups,
    lookups: counters.lookups,
    shown: shown.length,
    reachedGate: records.length,
    verified: products.length,
    gatePassRate: records.length ? Math.round((products.length / records.length) * 1000) / 10 : 0,
    latency,
    wasted,
    offers: records.diagnostics && records.diagnostics.offers ? records.diagnostics.offers : null
  };
}

const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const round = (n, p = 1) => Number(n.toFixed(p));

(async () => {
  const rows = [];
  for (const scenario of SCENARIOS) rows.push(await runScenario(scenario));

  console.log('\n=== offer resolution, one search of 12 products ===\n');
  console.log(`  ${pad('scenario', 20)}${padStart('requests', 9)}${padStart('lookups', 8)}${padStart('shown', 6)}${padStart('gate', 7)}${padStart('ms', 7)}${padStart('wasted', 8)}`);
  rows.forEach((r) => {
    console.log(`  ${pad(r.scenario, 20)}${padStart(r.requests, 9)}${padStart(r.lookups, 8)}${padStart(r.shown, 6)}${padStart(r.gatePassRate + '%', 7)}${padStart(r.latency, 7)}${padStart(r.wasted, 8)}`);
  });

  const summary = {
    requests: round(mean(rows.map((r) => r.requests)), 2),
    lookups: round(mean(rows.map((r) => r.lookups)), 2),
    shown: round(mean(rows.map((r) => r.shown)), 2),
    gatePassRate: round(mean(rows.map((r) => r.gatePassRate)), 1),
    latency: Math.round(mean(rows.map((r) => r.latency))),
    wasted: round(mean(rows.map((r) => r.wasted)), 2),
    fullPages: rows.filter((r) => r.shown >= LIMIT).length
  };

  console.log(`\n  ${pad('mean', 20)}${padStart(summary.requests, 9)}${padStart(summary.lookups, 8)}${padStart(summary.shown, 6)}${padStart(summary.gatePassRate + '%', 7)}${padStart(summary.latency, 7)}${padStart(summary.wasted, 8)}`);
  console.log(`  full pages of ${LIMIT}: ${summary.fullPages} of ${rows.length}\n`);

  const compare = flag('compare', null);
  if (compare) {
    const before = JSON.parse(fs.readFileSync(compare, 'utf8'));
    const delta = (after, prior, unit = '') => {
      const diff = round(after - prior, 2);
      const pct = prior ? ` (${diff > 0 ? '+' : ''}${round((diff / prior) * 100, 1)}%)` : '';
      return `${prior}${unit} -> ${after}${unit}  ${diff > 0 ? '+' : ''}${diff}${unit}${pct}`;
    };
    console.log('=== against ' + compare + ' ===\n');
    console.log(`  ${pad('requests / search', 22)}${delta(summary.requests, before.summary.requests)}`);
    console.log(`  ${pad('offer lookups / search', 22)}${delta(summary.lookups, before.summary.lookups)}`);
    console.log(`  ${pad('products shown', 22)}${delta(summary.shown, before.summary.shown)}`);
    console.log(`  ${pad('gate pass rate', 22)}${delta(summary.gatePassRate, before.summary.gatePassRate, '%')}`);
    console.log(`  ${pad('latency', 22)}${delta(summary.latency, before.summary.latency, 'ms')}`);
    console.log(`  ${pad('wasted lookups', 22)}${delta(summary.wasted, before.summary.wasted)}`);
    console.log(`  ${pad('full pages', 22)}${before.summary.fullPages} -> ${summary.fullPages} of ${rows.length}`);
    console.log('\n  per scenario, requests then shown:\n');
    rows.forEach((r, i) => {
      const b = before.rows[i];
      console.log(`  ${pad(r.scenario, 20)}${padStart(b.requests + ' -> ' + r.requests, 12)}${padStart(b.shown + ' -> ' + r.shown, 12)}`);
    });
    console.log('');
  }

  const out = flag('out', null);
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), limit: LIMIT, summary, rows }, null, 2));
    console.log(`  written: ${out}\n`);
  }
})();
