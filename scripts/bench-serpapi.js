#!/usr/bin/env node
/* =========================================================
   Fynd — SerpApi benchmark

   Runs a set of realistic shopper searches through the SerpApi adapter
   and the verification gate, and reports what a shopper would actually
   have seen. Nothing here is estimated: every number is counted off the
   records the provider returned.

   What it reports, per search and averaged over the run:

     usable products      records that passed the gate
     products shown       what would fill the grid, capped at the limit
     full-page rate       searches that filled the grid completely
     direct-link rate     provider records that yielded a retailer URL
     latency              wall clock for the whole search
     duplicates           the same product URL, and the same title twice
     retailer diversity   distinct shops per search, and across the run
     requests/search      SerpApi requests spent
     cost/search          those requests at the plan's own unit price

   Usage
     SERPAPI_API_KEY=... node scripts/bench-serpapi.js

   Options
     --queries=5          how many of the query set to run (default: all)
     --limit=12           products per search, as /api/search asks for
     --max-requests=60    HARD ceiling on SerpApi requests for the whole
                          run. The run stops rather than exceeding it.
     --no-sellers         inline links only: 1 request per search
     --engine=...         override the engine (default from the adapter)
     --cost=0.015         unit price per request, when the plan does not
                          state one
     --out=path.json      write the full result as JSON, for comparing
                          against another provider later
     --force              run even when the plan has fewer searches left
                          than the worst case needs

   A run spends real quota, so it says what it is about to spend before
   it spends it, and stops at --max-requests whatever happens.
   ========================================================= */

'use strict';

const fs = require('fs');
const provider = require('../api/_providers/serpapi');
const { verifyAll, toProduct } = require('../api/_providers/product-source');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const has = (name) => argv.includes(`--${name}`);
const num = (name, fallback) => {
  const value = Number(flag(name, NaN));
  return Number.isFinite(value) ? value : fallback;
};

/* The searches, as the interpreter would hand them over: structured
   intent, not a phrase. They are ordinary clothing requests with the
   shape of things people actually type, including two with a budget,
   because a budget is where records get dropped after the fact. */
const QUERIES = [
  { label: 'black oversized hoodie under $80', intent: { colors: ['black'], fits: ['oversized'], categories: ['hoodie'], maxPrice: 80 } },
  { label: "women's white leather sneakers", intent: { gender: 'women', colors: ['white'], categories: ['sneakers'], keywords: ['leather'] } },
  { label: "men's slim fit dark wash jeans under $120", intent: { gender: 'men', fits: ['slim fit'], colors: ['dark wash'], categories: ['jeans'], maxPrice: 120 } },
  { label: 'linen dress for a summer wedding', intent: { categories: ['dress'], occasions: ['wedding'], keywords: ['linen'], season: 'summer' } },
  { label: 'north face waterproof rain jacket', intent: { brands: ['north face'], categories: ['rain jacket'], keywords: ['waterproof'] } },
  { label: 'navy wool crewneck sweater', intent: { colors: ['navy'], categories: ['sweater'], keywords: ['wool', 'crewneck'] } },
  { label: 'high waisted black leggings', intent: { colors: ['black'], categories: ['leggings'], fits: ['high waisted'] } },
  { label: "men's brown leather chelsea boots under $200", intent: { gender: 'men', colors: ['brown'], categories: ['chelsea boots'], keywords: ['leather'], maxPrice: 200 } }
];

const full = (intent) => Object.assign({
  categories: [], colors: [], occasions: [], fits: [], brands: [], styles: [], keywords: [],
  maxPrice: null, minPrice: null, season: null, gender: null
}, intent);

const round = (n, places = 2) => Number(n.toFixed(places));
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
const percentile = (list, p) => {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const rate = (part, whole) => (whole ? round((part / whole) * 100, 1) : 0);
const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);

/* A hard ceiling on what this run can spend. The adapter counts its own
   requests; this counts them again at the only place they can actually
   happen, and refuses to make one past the cap. A refused seller lookup
   costs that record its link; a refused search fails that query, and
   both are reported rather than hidden. */
function capRequests(max) {
  const original = global.fetch;
  const state = { made: 0, refused: 0 };
  global.fetch = async (url, options) => {
    /* the account endpoint is free and is not a search */
    if (String(url).startsWith(provider.ACCOUNT_URL)) return original.call(globalThis, url, options);
    if (state.made >= max) {
      state.refused += 1;
      throw new Error(`request ceiling of ${max} reached`);
    }
    state.made += 1;
    return original.call(globalThis, url, options);
  };
  return { state, restore: () => { global.fetch = original; } };
}

async function readPlan() {
  try {
    const account = await provider.account();
    const perMonth = Number(account.searches_per_month);
    const price = Number(account.plan_monthly_price);
    return {
      name: account.plan_name || account.plan_id || 'unknown',
      searchesLeft: Number(account.total_searches_left),
      usedThisMonth: Number(account.this_month_usage),
      searchesPerMonth: Number.isFinite(perMonth) ? perMonth : null,
      /* the plan's own arithmetic, when it states both halves */
      unitCost: Number.isFinite(price) && Number.isFinite(perMonth) && perMonth > 0 && price > 0
        ? price / perMonth
        : null
    };
  } catch (err) {
    return { error: provider.redact(err && err.message) };
  }
}

/* One search, measured. Latency is wall clock around exactly what
   /api/search does: ask the provider, then run the gate. */
async function runQuery(query, limit) {
  const started = Date.now();
  let records;
  let error = null;
  try {
    records = await provider.search(full(query.intent), { limit });
  } catch (err) {
    error = provider.redact(err && err.message);
    records = [];
  }
  const diagnostics = (records && records.diagnostics) || {};

  /* Pre-dedupe pass, so duplicates can be counted rather than silently
     absorbed: verifyAll keeps the first of a repeated URL. */
  const passing = [];
  for (const record of records) {
    const result = toProduct(record, { retailer: provider.defaultRetailer });
    if (result.ok) passing.push(result.product);
  }
  const { products, rejected } = verifyAll(records, { retailer: provider.defaultRetailer });
  const latency = Date.now() - started;

  const urls = new Set(passing.map((p) => p.productUrl));
  const titles = products.map((p) => p.name.toLowerCase().replace(/\s+/g, ' ').trim());
  const shown = products.slice(0, limit);
  const retailers = [...new Set(shown.map((p) => p.retailer))];
  const hosts = [...new Set(shown.map((p) => { try { return new URL(p.productUrl).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }).filter(Boolean))];

  return {
    label: query.label,
    error,
    latency,
    returnedByProvider: diagnostics.returnedByProvider || 0,
    normalized: diagnostics.normalized || 0,
    withInlineLink: diagnostics.withInlineLink || 0,
    withAnyLink: diagnostics.withAnyLink || 0,
    droppedOverBudget: diagnostics.droppedOverBudget || 0,
    reachedGate: records.length,
    usable: products.length,
    shown: shown.length,
    fullPage: shown.length >= limit,
    duplicateUrls: passing.length - urls.size,
    duplicateTitles: titles.length - new Set(titles).size,
    retailers,
    hosts,
    requests: (diagnostics.requests && diagnostics.requests.total) || 0,
    sellerRequests: (diagnostics.requests && diagnostics.requests.sellers) || 0,
    rejected,
    sellers: diagnostics.sellers || null,
    sample: shown.slice(0, 2).map((p) => ({ name: p.name, price: p.price, retailer: p.retailer, productUrl: p.productUrl }))
  };
}

function report(rows, limit, unitCost, costSource, spent) {
  const ran = rows.filter((r) => !r.error);
  const line = (label, value) => console.log(`  ${pad(label, 30)} ${value}`);

  console.log('\n=== per search ===\n');
  console.log(`  ${pad('query', 44)}${padStart('shown', 6)}${padStart('usable', 7)}${padStart('links', 12)}${padStart('reqs', 6)}${padStart('ms', 7)}  retailers`);
  for (const r of rows) {
    if (r.error) {
      console.log(`  ${pad(r.label.slice(0, 43), 44)}${padStart('—', 6)}${padStart('—', 7)}${padStart('—', 12)}${padStart(r.requests, 6)}${padStart(r.latency, 7)}  FAILED: ${r.error.slice(0, 60)}`);
      continue;
    }
    const links = `${r.withAnyLink}/${r.normalized}`;
    console.log(`  ${pad(r.label.slice(0, 43), 44)}${padStart(r.shown, 6)}${padStart(r.usable, 7)}${padStart(links, 12)}${padStart(r.requests, 6)}${padStart(r.latency, 7)}  ${r.retailers.length}`);
  }

  const latencies = ran.map((r) => r.latency);
  const allRetailers = new Set();
  const allHosts = new Set();
  const retailerCounts = {};
  const rejectedTotals = {};
  ran.forEach((r) => {
    r.retailers.forEach((name) => { allRetailers.add(name); retailerCounts[name] = (retailerCounts[name] || 0) + 1; });
    r.hosts.forEach((h) => allHosts.add(h));
    Object.entries(r.rejected || {}).forEach(([reason, n]) => { rejectedTotals[reason] = (rejectedTotals[reason] || 0) + n; });
  });

  const normalized = ran.reduce((a, r) => a + r.normalized, 0);
  const withAnyLink = ran.reduce((a, r) => a + r.withAnyLink, 0);
  const withInlineLink = ran.reduce((a, r) => a + r.withInlineLink, 0);
  const requestsPerSearch = mean(ran.map((r) => r.requests));

  console.log('\n=== over the run ===\n');
  line('searches run', `${ran.length} of ${rows.length}${rows.length - ran.length ? ` (${rows.length - ran.length} failed)` : ''}`);
  line('usable products / search', round(mean(ran.map((r) => r.usable)), 1));
  line('products shown / search', `${round(mean(ran.map((r) => r.shown)), 1)} of ${limit} asked for`);
  line('full-page rate', `${rate(ran.filter((r) => r.fullPage).length, ran.length)}%  (${ran.filter((r) => r.fullPage).length}/${ran.length} searches filled the grid)`);
  line('direct retailer-link rate', `${rate(withAnyLink, normalized)}%  (${withAnyLink} of ${normalized} records)`);
  line('  of which inline, no lookup', `${rate(withInlineLink, normalized)}%  (${withInlineLink} of ${normalized})`);
  line('latency mean / p50 / p95', `${Math.round(mean(latencies))} / ${percentile(latencies, 50)} / ${percentile(latencies, 95)} ms`);
  line('duplicates (same URL)', ran.reduce((a, r) => a + r.duplicateUrls, 0));
  line('duplicates (same title)', ran.reduce((a, r) => a + r.duplicateTitles, 0));
  line('retailer diversity', `${round(mean(ran.map((r) => r.retailers.length)), 1)} shops / search, ${allRetailers.size} distinct across the run`);
  line('  distinct link hosts', allHosts.size);
  line('requests / search', round(requestsPerSearch, 2));
  line('cost / search', `$${round(requestsPerSearch * unitCost, 4)}  (at $${round(unitCost, 5)} per request, ${costSource})`);
  line('cost for this run', `$${round(spent * unitCost, 4)} over ${spent} requests`);

  const funnel = ['returnedByProvider', 'normalized', 'withInlineLink', 'withAnyLink', 'reachedGate', 'usable'];
  console.log('\n=== where records were lost ===\n');
  funnel.forEach((stage) => line(stage, ran.reduce((a, r) => a + (r[stage] || 0), 0)));
  const overBudget = ran.reduce((a, r) => a + r.droppedOverBudget, 0);
  if (overBudget) line('dropped over budget', overBudget);

  if (Object.keys(rejectedTotals).length) {
    console.log('\n=== why the gate dropped records ===\n');
    Object.entries(rejectedTotals).sort((a, b) => b[1] - a[1]).forEach(([reason, n]) => line(reason, n));
  }

  const top = Object.entries(retailerCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length) {
    console.log('\n=== retailers shown, by how many searches they appeared in ===\n');
    top.forEach(([name, n]) => line(name, n));
  }

  const withSamples = ran.find((r) => r.sample.length);
  if (withSamples) {
    console.log('\n=== a sample of what a shopper would have seen ===\n');
    withSamples.sample.forEach((p) => {
      console.log(`  ${p.name.slice(0, 70)}`);
      console.log(`    $${p.price} at ${p.retailer} -> ${p.productUrl.slice(0, 110)}`);
    });
  }

  return {
    limit,
    unitCost,
    costSource,
    searchesRun: ran.length,
    searchesFailed: rows.length - ran.length,
    usablePerSearch: round(mean(ran.map((r) => r.usable)), 2),
    shownPerSearch: round(mean(ran.map((r) => r.shown)), 2),
    fullPageRate: rate(ran.filter((r) => r.fullPage).length, ran.length),
    directLinkRate: rate(withAnyLink, normalized),
    inlineLinkRate: rate(withInlineLink, normalized),
    latencyMeanMs: Math.round(mean(latencies)),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    duplicateUrls: ran.reduce((a, r) => a + r.duplicateUrls, 0),
    duplicateTitles: ran.reduce((a, r) => a + r.duplicateTitles, 0),
    retailersPerSearch: round(mean(ran.map((r) => r.retailers.length)), 2),
    distinctRetailers: allRetailers.size,
    distinctHosts: allHosts.size,
    requestsPerSearch: round(requestsPerSearch, 2),
    costPerSearch: round(requestsPerSearch * unitCost, 4),
    requestsSpent: spent,
    rejected: rejectedTotals,
    retailerCounts
  };
}

async function main() {
  if (!process.env.SERPAPI_API_KEY) {
    console.error('SERPAPI_API_KEY is not set. Export it and run again.');
    process.exit(2);
  }
  if (has('no-sellers')) process.env.SERPAPI_RESOLVE_SELLERS = 'off';
  const engineOverride = flag('engine', null);
  if (engineOverride) process.env.SERPAPI_ENGINE = engineOverride;

  const limit = num('limit', 12);
  const count = Math.min(num('queries', QUERIES.length), QUERIES.length);
  const queries = QUERIES.slice(0, count);
  const maxRequests = num('max-requests', 60);

  const plan = await readPlan();
  const unitCost = plan.unitCost || num('cost', 0.015);
  const costSource = plan.unitCost ? 'from the plan' : 'assumed — override with --cost';

  console.log('\n=== SerpApi benchmark ===\n');
  console.log(`  provider   : ${provider.name} (registered, not the production source)`);
  console.log(`  engine     : ${provider.engine()}`);
  console.log(`  searches   : ${queries.length}, asking for ${limit} products each`);
  console.log(`  sellers    : ${process.env.SERPAPI_RESOLVE_SELLERS === 'off' ? 'off — inline links only' : 'on — one lookup per record without a link'}`);
  if (plan.error) console.log(`  plan       : could not be read (${plan.error})`);
  else console.log(`  plan       : ${plan.name} — ${plan.usedThisMonth} used this month, ${plan.searchesLeft} left`);

  /* Worst case: the search itself plus a lookup for every record it
     returns. Said before anything is spent, because the reason this
     script exists is that quota runs out. */
  const worstCasePerSearch = process.env.SERPAPI_RESOLVE_SELLERS === 'off' ? 1 : 1 + Math.min(limit * 2, 100);
  const worstCase = queries.length * worstCasePerSearch;
  console.log(`  worst case : ${worstCase} requests (${worstCasePerSearch} per search), hard-capped at ${maxRequests}`);

  if (!plan.error && Number.isFinite(plan.searchesLeft) && Math.min(worstCase, maxRequests) > plan.searchesLeft && !has('force')) {
    console.error(`\n  Refusing to start: the cap of ${maxRequests} requests is more than the ${plan.searchesLeft} searches left on the plan.`);
    console.error('  Lower --max-requests or --queries, or pass --force.\n');
    process.exit(3);
  }

  const cap = capRequests(maxRequests);
  const rows = [];
  try {
    for (const query of queries) {
      if (cap.state.made >= maxRequests) {
        console.log(`\n  Stopping before "${query.label}": the ${maxRequests}-request ceiling is spent.`);
        break;
      }
      process.stdout.write(`  running: ${query.label} … `);
      const row = await runQuery(query, limit);
      rows.push(row);
      console.log(row.error ? `failed (${row.error.slice(0, 60)})` : `${row.shown} shown, ${row.requests} requests, ${row.latency}ms`);
    }
  } finally {
    cap.restore();
  }

  if (!rows.length) {
    console.error('\nNo search completed. Nothing to report.\n');
    process.exit(1);
  }

  const summary = report(rows, limit, unitCost, costSource, cap.state.made);
  if (cap.state.refused) console.log(`\n  ${cap.state.refused} request(s) were refused by the ceiling; the numbers above are what was measured under it.`);

  const out = flag('out', null);
  if (out) {
    const payload = { ranAt: new Date().toISOString(), provider: provider.name, engine: provider.engine(), summary, rows };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    console.log(`\n  written: ${out}`);
  }
  console.log('');
}

main().catch((err) => { console.error(provider.redact(err && err.message)); process.exit(1); });
