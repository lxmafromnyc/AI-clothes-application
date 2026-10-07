#!/usr/bin/env node
/* =========================================================
   Fynd — messy-input LIVE check

   A small set of the messy requests in scripts/bench-messy.js, put
   through the real live path with the real keys — the served
   interpreter (OpenAI, or whichever AI_PROVIDER names), /api/search's
   intent, the configured product source with its offer lookups and its
   fallback, the verification gate, the garment filter and the ranking —
   and every product that would be shown checked again here:

     real          it came back from the provider, through the gate
     price         a positive number, and inside any budget the request
                   stated
     retailer URL  passes the gate's own link rules: the shop's product
                   page, not a search, a redirect or Google
     photo         an absolute https URL from the source's own record
     no invention  no field the gate does not build a product from

   and every provider request counted, so "one Fynd search is one
   provider search" is checked against the real provider, not a stub.

   What it cannot judge is relevance: the titles are printed for a person
   to read. The offline benchmark is where relevance is measured.

   Usage: node --env-file=.env.local scripts/bench-messy-live.js [--json]
          [--only "query one|query two"]
   ========================================================= */

'use strict';

const { interpretQuery } = require('../api/interpret');
const { shapeIntent, searchWithFallback, requestBudget, DEFAULT_LIMIT } = require('../api/search');
const { getProvider, toProduct, linkFault, toHttpsUrl } = require('../api/_providers/product-source');
const { queryFrom } = require('../api/_providers/query');
const cache = require('../api/_cache');

const REQUESTS = [
  'pants that arent skinny',
  'something warm but not a coat',
  'something like a hoodie without the hood',
  'blak hoddie',
  'jeens that arent skiny',
  'a shirt but heavier',
  'i want the same vibe as a sweatshirt but thinner',
  'something cozy I can wear with jeans',
  'that jacket shirt thing',
  'hoodie with no logo',
  'black oversized hoodie under $80',
  'something nice for dinner'
];

const GATE_FIELDS = new Set(['id', 'name', 'price', 'currency', 'imageUrl', 'productUrl', 'retailer', 'category', 'colors', 'sizes', 'brand']);

/* counts every request the search makes, by host and path, without
   reading or keeping anything from it */
function counting() {
  const real = global.fetch;
  const calls = [];
  global.fetch = (input, init) => {
    try {
      const url = new URL(String(input && input.url ? input.url : input));
      calls.push(`${url.hostname}${url.pathname}`);
    } catch (err) { calls.push('unparseable'); }
    return real(input, init);
  };
  return { calls, restore: () => { global.fetch = real; } };
}

function check(product, intent) {
  const problems = [];
  for (const key of Object.keys(product)) if (!GATE_FIELDS.has(key)) problems.push(`carries "${key}", which the gate never builds`);
  if (!(typeof product.price === 'number' && product.price > 0)) problems.push('no verified price');
  if (intent.maxPrice && product.price > intent.maxPrice) problems.push(`$${product.price} is over the stated $${intent.maxPrice}`);
  if (intent.minPrice && product.price < intent.minPrice) problems.push(`$${product.price} is under the stated $${intent.minPrice}`);
  const fault = linkFault(product.productUrl);
  if (fault) problems.push(`link: ${fault}`);
  if (!toHttpsUrl(product.imageUrl)) problems.push('photo is not an absolute https URL');
  if (!product.retailer) problems.push('no retailer');
  /* and the product as shown is what the gate makes of itself */
  const again = toProduct({ title: product.name, price: product.price, imageUrl: product.imageUrl, productUrl: product.productUrl, retailer: product.retailer }, {});
  if (!again.ok) problems.push(`the gate refuses it now: ${again.reason}`);
  return problems;
}

async function run(options) {
  const opts = options || {};
  const provider = getProvider();
  if (!provider.configured()) throw new Error('No product source is configured: set OPENWEBNINJA_API_KEY (or PRODUCT_SOURCE and its key).');
  const list = opts.only ? REQUESTS.filter((q) => opts.only.includes(q)).concat(opts.only.filter((q) => !REQUESTS.includes(q))) : REQUESTS;
  const results = [];
  for (const query of list) {
    cache.reset();
    const reading = await interpretQuery({ query, vocabulary: {} });
    const intent = shapeIntent(reading.ok ? reading.preferences : {});
    const net = counting();
    let found;
    let failed = null;
    const started = Date.now();
    try {
      found = await searchWithFallback(provider, intent, DEFAULT_LIMIT, cache.counters(), Date.now() + requestBudget());
    } catch (err) {
      failed = String(err && err.message).split('\n')[0].slice(0, 200);
    } finally {
      net.restore();
    }
    const shown = found ? found.products.slice(0, 8) : [];
    const searches = net.calls.filter((c) => /\/search$|\/shopping$|\/search\.json$/.test(c)).length;
    results.push({
      query,
      interpreter: reading.ok ? reading.source : `failed (${reading.reason})`,
      asked: queryFrom(intent),
      providerAnswered: found ? found.provider : null,
      failed,
      ms: Date.now() - started,
      providerSearches: searches,
      providerRequests: net.calls.length,
      shown: shown.map((p) => ({ name: p.name, price: p.price, retailer: p.retailer, problems: check(p, intent) })),
      removedAsRuledOut: found ? found.rejected['ruled-out-by-the-request'] || 0 : 0,
      removedAsAnotherGarment: found ? found.rejected['contradicts-the-requested-garment'] || 0 : 0
    });
  }
  const problems = results.flatMap((r) => r.shown.flatMap((p) => p.problems.map((why) => `${r.query}: ${p.name}: ${why}`)));
  return {
    results,
    summary: {
      requests: results.length,
      failed: results.filter((r) => r.failed).length,
      shown: results.reduce((n, r) => n + r.shown.length, 0),
      productsWithProblems: problems.length,
      problems,
      providerSearchesPerFyndSearch: results.reduce((n, r) => n + r.providerSearches, 0) / Math.max(1, results.length),
      providerRequestsPerFyndSearch: results.reduce((n, r) => n + r.providerRequests, 0) / Math.max(1, results.length)
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--only');
  const out = await run({ only: at === -1 ? null : args[at + 1].split('|') });
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  for (const r of out.results) {
    console.log(`\n${r.query}\n  interpreter ${r.interpreter} · asked "${r.asked}" · ${r.providerAnswered || 'no provider'} · ${r.providerSearches} search, ${r.providerRequests} requests · ${r.ms}ms${r.failed ? ` · FAILED ${r.failed}` : ''}`);
    r.shown.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} — $${p.price} at ${p.retailer}${p.problems.length ? `   ✗ ${p.problems.join('; ')}` : ''}`));
  }
  const s = out.summary;
  console.log(`\n${s.requests} requests, ${s.failed} failed, ${s.shown} products shown, ${s.productsWithProblems} problems`);
  console.log(`provider searches per Fynd search ${s.providerSearchesPerFyndSearch.toFixed(2)}, provider requests per Fynd search ${s.providerRequestsPerFyndSearch.toFixed(2)}`);
  s.problems.forEach((p) => console.log(`  ✗ ${p}`));
  if (s.productsWithProblems) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(err.message || err); process.exit(1); });

module.exports = { run, REQUESTS, check };
