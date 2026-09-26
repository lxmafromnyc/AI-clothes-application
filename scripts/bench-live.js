#!/usr/bin/env node
/* =========================================================
   Fynd — LIVE search benchmark

   The shopper queries of scripts/bench-search.js, put through the real
   live path with the real keys:

     1. the interpreter      api/interpret.js interpretQuery() — the AI
                             reading the site uses. When it is not
                             configured or fails, the page's own local
                             reader, exactly as the page falls back, and
                             the failure is counted.
     2. the intent           api/search.js shapeIntent() — the endpoint's
                             own whitelist
     3. the search           api/search.js searchWithFallback() — the
                             configured provider, and the fallback the
                             endpoint itself turns to when that provider's
                             allowance is spent, each answer through the
                             verification gate, untouched, inside the
                             endpoint's own time budget. Which provider
                             answered is recorded per query.

   The handlers' metering is the one thing not gone through: a benchmark
   must not spend a shopper's plan, or write usage rows to a production
   store. Everything that decides what a shopper sees is the real code.

   What is measured is not the catalogue. A live search returns shops'
   listings, so a query is judged by whether the RIGHT GARMENT came back
   — read by the same semantic gate catalogue discovery uses — not by
   whether a particular catalogue row did. This is live shopping
   accuracy; scripts/bench-search.js is the catalogue benchmark, and the
   two are never reported as one.

   Usage: node --env-file=.env.local scripts/bench-live.js [--held-out] [--limit N] [--json]
          [--only "query one|query two"] [--repeat N]   (each pass from a cold cache)
          [--out bench-live.json]                     (the JSON, written as UTF-8)
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const { QUERIES, HELD_OUT } = require('./bench-search.js');
const { interpretQuery } = require('../api/interpret');
const { shapeIntent, searchWithFallback, requestBudget, DEFAULT_LIMIT } = require('../api/search');
const { getProvider, providerChain } = require('../api/_providers/product-source');
const { queryFrom } = require('../api/_providers/query');
const cache = require('../api/_cache');
const interpreters = require('../api/_interpreters');
const { semanticMatch } = require('./fetch-catalog-images.js');
const { timedOut } = require('../api/_providers/deadline');

/* the page's own scripts, as the page runs them: the catalogue it sends
   as vocabulary, and the local reader it falls back to */
function page() {
  const context = { console, URL };
  context.window = context;
  vm.createContext(context);
  for (const file of ['products.js', 'interpret.js', 'catalog.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO, 'assets', file), 'utf8'), context, { filename: file });
  }
  vm.runInContext('this.__rows = DEMO_PRODUCTS;', context);
  const catalogue = context.Products.normalizeAll(context.__rows);
  const vocabulary = {
    categories: [...new Set(catalogue.map((p) => p.category))],
    colors: [...new Set(catalogue.flatMap((p) => p.colors))],
    occasions: [...new Set(catalogue.flatMap((p) => p.occasions))],
    fits: [...new Set(catalogue.flatMap((p) => p.fits))],
    brands: [...new Set(catalogue.map((p) => p.brand))],
    styles: [...new Set(catalogue.flatMap((p) => p.styles))]
  };
  return { Interpreter: context.Interpreter, catalogue, vocabulary };
}

function interpreterConfigured() {
  const alternative = interpreters.getInterpreter();
  return alternative ? alternative.configured() : Boolean(process.env.OPENAI_API_KEY);
}

/* the page's reading of a request: the AI one when it answers, the local
   one when it does not, and which it was */
async function readRequest(query, env) {
  const started = Date.now();
  if (!interpreterConfigured()) {
    return { source: 'local', failure: 'not-configured', preferences: env.Interpreter.localInterpret(query, env.vocabulary), ms: Date.now() - started };
  }
  const reading = await interpretQuery({ query, vocabulary: env.vocabulary });
  if (!reading.ok) {
    return { source: 'local', failure: reading.reason || 'unavailable', preferences: env.Interpreter.localInterpret(query, env.vocabulary), ms: Date.now() - started };
  }
  return { source: reading.source, failure: null, preferences: reading.preferences, ms: Date.now() - started };
}

const wordsOf = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean);
const stem = (word) => (word.length > 3 && /s$/.test(word) && !/ss$/.test(word) ? word.slice(0, -1) : word);
/* a descriptor is in a text when every word of it is */
const says = (text, descriptor) => {
  const have = new Set(wordsOf(text).map(stem));
  const joined = wordsOf(text).join('');
  const own = wordsOf(descriptor).map(stem);
  return own.every((word) => have.has(word)) || joined.includes(own.join(''));
};

function listingKey(product) {
  try {
    const url = new URL(product.productUrl);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch (err) {
    return `name:${String(product.name || '').toLowerCase()}|${String(product.retailer || product.brand || '').toLowerCase()}`;
  }
}

async function measure(id, query, category, env, provider, limit) {
  const reading = await readRequest(query, env);
  const intent = shapeIntent(JSON.parse(JSON.stringify(reading.preferences)));
  const asked = queryFrom(intent);
  /* what the shopper asked for, by the page's own vocabulary: the garment
     and every descriptor, as the ground truth to check survival against */
  const wanted = env.Interpreter.readGarments(query);
  const descriptors = [...wanted.descriptors];

  const started = Date.now();
  let found = null;
  let failure = null;
  try {
    found = await searchWithFallback(provider, intent, limit, cache.counters(), Date.now() + requestBudget());
  } catch (err) {
    failure = String(err && err.message ? err.message : err).split('\n')[0].slice(0, 200);
  }
  const searchMs = Date.now() - started;
  const products = found ? found.products.slice(0, limit) : [];

  const row = { id: 'query', name: query, category };
  const verdicts = products.map((product) => {
    let verdict;
    try { verdict = semanticMatch(row, { title: product.name }); } catch (err) { verdict = { ok: false, kind: 'error' }; }
    return { name: product.name, retailer: product.retailer || product.brand || null, kind: verdict.ok ? verdict.kind : (verdict.kind || 'refused'), ok: verdict.ok,
      /* why the semantic reader refused it, so a "wrong garment" can be
         told apart from a word the reader does not know */
      why: verdict.ok ? null : String(verdict.why || '').slice(0, 200), productUrl: product.productUrl };
  });
  const garmentAt = verdicts.findIndex((one) => one.ok);
  const matchAt = verdicts.findIndex((one) => one.ok && one.kind === 'match');
  const above = verdicts.slice(0, garmentAt < 0 ? verdicts.length : garmentAt).filter((one) => one.kind === 'contradiction');
  const wrongAbove = above.length;

  const keys = products.map(listingKey);
  const duplicates = keys.length - new Set(keys).size;

  return {
    id, query,
    interpreter: reading.source, interpreterFailure: reading.failure, interpretMs: reading.ms,
    asked,
    garments: [...wanted.garments], descriptors,
    /* each descriptor the shopper used: did it reach the provider's
       query, and how many of the top three results carry it */
    survived: descriptors.map((one) => ({ descriptor: one, inQuery: says(asked, one), inTop3: verdicts.slice(0, 3).filter((v) => says(v.name, one)).length })),
    providerFailure: failure,
    /* the provider that answered, and whether it was the fallback */
    provider: found ? found.provider : null,
    usedFallback: Boolean(found && found.fellBackFrom),
    fellBackFrom: found && found.fellBackFrom ? found.fellBackFrom : null,
    returned: products.length,
    rejected: found ? found.rejected : null,
    /* when the answering source's batch named no shop: what its organic
       endpoint offered, and what reading each listing's own page proved */
    organic: found && found.funnel && found.funnel.organic ? found.funnel.organic : null,
    /* a failure that was the clock rather than the provider refusing */
    providerTimedOut: Boolean(failure && timedOut(new Error(failure))),
    /* which stage, when it was the clock */
    timedOutStage: failure && timedOut(new Error(failure))
      ? [...failure.matchAll(/([A-Za-z][\w /]*?) did not answer within (\d+)ms/g)].map((m) => `${m[1].trim()} after ${m[2]}ms`).join('; then ') || failure.split(' did not answer')[0]
      : null,
    /* where the search's time went, stage by stage, when the source ran
       an organic stage: the product search, the organic search (started
       alongside it on a live search), and reading the listings' pages */
    stageMs: found && found.funnel && found.funnel.organic && found.funnel.organic.timing ? found.funnel.organic.timing
      : (found && found.funnel && found.funnel.timing) || null,
    productSearchTimedOutButAnswered: Boolean(found && found.funnel && found.funnel.organic && found.funnel.organic.productSearchTimedOut),
    servedFromCache: Boolean(found && found.servedFromCache),
    garmentRank: garmentAt < 0 ? null : garmentAt + 1,
    matchRank: matchAt < 0 ? null : matchAt + 1,
    wrongAbove,
    wrongGarments: above.map((one) => ({ name: one.name, retailer: one.retailer, productUrl: one.productUrl, why: one.why })),
    /* every result shown, with the reader's verdict on it — so a query
       that showed something and still found no correct garment says
       what it showed and why each one was not counted */
    shown: verdicts.map((one) => ({ name: one.name, retailer: one.retailer, productUrl: one.productUrl, kind: one.kind, why: one.why })),
    duplicates,
    searchMs,
    top: verdicts.slice(0, 3)
  };
}

/* Why a query that showed nothing showed nothing: the FURTHEST stage any
   of its listings reached, because that is the stage that stopped it. A
   query whose best listing was priced but had no provable photo was
   blocked at the photo, whatever its other listings did. */
function blockingCause(r) {
  if (r.returned > 0) return null;
  if (r.providerFailure) return r.providerTimedOut ? 'provider-timeout' : 'provider-failure';
  const o = r.organic;
  if (!o) return r.rejected && Object.keys(r.rejected).length ? 'product-search-refused-by-gate' : 'provider-returned-nothing';
  if (o.failed) return 'organic-search-failed';
  if (!o.offered) return 'organic-search-offered-nothing';
  const outcomes = (o.pages && o.pages.outcomes) || {};
  const n = (what) => (outcomes[what] || 0) + (outcomes[`tile:${what}`] || 0);
  for (const [what, cause] of [
    ['photographed', 'photographed-but-refused-by-gate'],
    ['no-photo', 'no-photo'],
    ['no-price', 'no-price'],
    ['no-identity', 'no-identity'],
    ['left-the-retailer', 'left-the-retailer'],
    ['unreadable', 'unreadable'],
    ['no-time', 'out-of-time'],
    ['not-reached', 'out-of-time'],
    ['category-page', 'only-category-pages'],
    ['editorial-page', 'only-articles-and-forums'],
    ['not-a-shop', 'only-articles-and-forums']
  ]) if (n(what)) return cause;
  return 'no-readable-listing';
}

/* The same queries asked more than once: whether a failure is the query
   or the moment. A query that times out on every pass is deterministic;
   one that times out on some passes is the provider's variability. */
function stability(all, repeat) {
  const byQuery = new Map();
  for (const r of all) {
    const one = byQuery.get(r.query) || { query: r.query, passes: 0, returned: [], timeouts: 0, failures: 0, searchMs: [] };
    one.passes += 1;
    one.returned.push(r.returned);
    if (r.providerTimedOut) one.timeouts += 1;
    if (r.providerFailure) one.failures += 1;
    one.searchMs.push(r.searchMs);
    byQuery.set(r.query, one);
  }
  const rows = [...byQuery.values()].map((one) => Object.assign(one, {
    verdict: one.timeouts === 0 ? 'no timeouts' : one.timeouts === one.passes ? 'times out every pass' : `times out on ${one.timeouts} of ${one.passes} passes`,
    showedSomething: `${one.returned.filter((n) => n > 0).length}/${one.passes}`
  }));
  return {
    passes: repeat,
    alwaysTimesOut: rows.filter((one) => one.timeouts === one.passes).map((one) => one.query),
    sometimesTimesOut: rows.filter((one) => one.timeouts > 0 && one.timeouts < one.passes).map((one) => one.query),
    unstableResults: rows.filter((one) => new Set(one.returned.map((n) => n > 0)).size > 1).map((one) => one.query),
    queries: rows
  };
}

function summarise(results) {
  const n = results.length || 1;
  const pct = (count) => `${count}/${results.length} (${Math.round((count / n) * 100)}%)`;
  const withResults = results.filter((r) => r.returned > 0);
  const ms = (key) => results.map((r) => r[key]).sort((a, b) => a - b);
  const p = (list, q) => list[Math.min(list.length - 1, Math.floor(list.length * q))];
  const allDescriptors = results.flatMap((r) => r.survived);
  const returnedTotal = results.reduce((sum, r) => sum + r.returned, 0);
  const matchRanks = results.filter((r) => r.matchRank).map((r) => r.matchRank);
  return {
    queries: results.length,
    returnedResults: pct(withResults.length),
    correctGarmentFound: pct(results.filter((r) => r.garmentRank).length),
    correctGarmentFirst: pct(results.filter((r) => r.garmentRank === 1).length),
    fullMatchInTop3: pct(results.filter((r) => r.matchRank && r.matchRank <= 3).length),
    fullMatchFound: pct(results.filter((r) => r.matchRank).length),
    meanBestMatchRank: matchRanks.length ? Number((matchRanks.reduce((a, b) => a + b, 0) / matchRanks.length).toFixed(2)) : null,
    queriesWithWrongGarmentAbove: pct(results.filter((r) => r.wrongAbove > 0).length),
    wrongGarmentsAbove: results.filter((r) => r.wrongAbove > 0).map((r) => ({ query: r.query, results: r.wrongGarments })),
    /* queries that SHOWED something and found no correct garment, with
       every result and its verdict. A result the reader could not judge
       — its title names no garment it knows ("Air Force 1 '07") — is
       listed apart from one it judged to be a different garment: the
       first may well be right, the second is wrong. */
    returnedWithoutCorrectGarment: results.filter((r) => r.returned > 0 && !r.garmentRank).map((r) => ({
      query: r.query,
      unjudged: (r.shown || []).filter((one) => one.kind === 'unreadable'),
      wrong: (r.shown || []).filter((one) => one.kind === 'contradiction'),
      shown: r.shown || []
    })),
    descriptorsInQuery: `${allDescriptors.filter((d) => d.inQuery).length}/${allDescriptors.length}`,
    descriptorsInSomeTop3Result: `${allDescriptors.filter((d) => d.inTop3 > 0).length}/${allDescriptors.length}`,
    duplicateRate: returnedTotal ? `${results.reduce((sum, r) => sum + r.duplicates, 0)}/${returnedTotal}` : '0/0',
    providerFailures: results.filter((r) => r.providerFailure).length,
    providerTimeouts: results.filter((r) => r.providerTimedOut).length,
    providerTimeoutStages: results.filter((r) => r.providerTimedOut).map((r) => `${r.query}: ${r.timedOutStage}`),
    /* a product search that ran out of time while the organic search
       still answered the query */
    productSearchTimeoutsAbsorbed: results.filter((r) => r.productSearchTimedOutButAnswered).map((r) => r.query),
    /* how much of the clock each stage took, across the queries that ran it */
    stageMs: (() => {
      const out = {};
      for (const stage of ['productSearchMs', 'organicMs', 'pagesMs', 'totalMs']) {
        const list = results.map((r) => r.stageMs && r.stageMs[stage]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
        if (list.length) out[stage] = { n: list.length, p50: p(list, 0.5), p90: p(list, 0.9), max: list[list.length - 1] };
      }
      return out;
    })(),
    /* every query that showed nothing, under the stage that stopped it */
    failedQueriesByCause: results.reduce((groups, r) => {
      const cause = blockingCause(r);
      if (cause) (groups[cause] = groups[cause] || []).push(r.query);
      return groups;
    }, {}),
    /* every page that proved no price, by which of the four answers it
       was (see priceDiagnosis in api/_providers/retailer-page.js), and
       the queries that showed nothing for want of one, with theirs */
    noPricePages: (() => {
      const { PRICE_CLASSES } = require('../api/_providers/retailer-page');
      const byCategory = {};
      const byClass = {};
      for (const r of results) {
        for (const [category, n] of Object.entries((r.organic && r.organic.pages && r.organic.pages.priceCategories) || {})) {
          byCategory[category] = (byCategory[category] || 0) + n;
          const cls = PRICE_CLASSES[category] || 'unclassified';
          byClass[cls] = (byClass[cls] || 0) + n;
        }
      }
      const queries = results.filter((r) => r.blockedBy === 'no-price')
        .map((r) => ({ query: r.query, categories: (r.organic && r.organic.pages && r.organic.pages.priceCategories) || {} }));
      return { byClass, byCategory, queries };
    })(),
    organicCategoryPagesRead: results.reduce((sum, r) => sum + ((r.organic && r.organic.pages && r.organic.pages.categoryPagesRead) || 0), 0),
    organicTilesOffered: results.reduce((sum, r) => sum + ((r.organic && r.organic.pages && r.organic.pages.tilesOffered) || 0), 0),
    organicEscalations: results.filter((r) => r.organic).length,
    organicListingsOffered: results.reduce((sum, r) => sum + ((r.organic && r.organic.offered) || 0), 0),
    organicPagesRead: results.reduce((sum, r) => sum + ((r.organic && r.organic.pages && r.organic.pages.pagesRead) || 0), 0),
    organicPageOutcomes: results.reduce((tally, r) => { for (const [what, n] of Object.entries((r.organic && r.organic.pages && r.organic.pages.outcomes) || {})) tally[what] = (tally[what] || 0) + n; return tally; }, {}),
    organicSearchFailures: results.filter((r) => r.organic && r.organic.failed).length,
    /* for every page that was read and proved nothing: why, by outcome,
       most frequent first */
    organicPageReasons: (() => {
      const tally = {};
      for (const r of results) {
        for (const [outcome, whys] of Object.entries((r.organic && r.organic.pages && r.organic.pages.reasons) || {})) {
          const group = tally[outcome] || (tally[outcome] = {});
          for (const [why, n] of Object.entries(whys)) group[why] = (group[why] || 0) + n;
        }
      }
      for (const outcome of Object.keys(tally)) {
        tally[outcome] = Object.fromEntries(Object.entries(tally[outcome]).sort((a, b) => b[1] - a[1]));
      }
      return tally;
    })(),
    answeredBy: results.reduce((tally, r) => { const who = r.provider ? `${r.provider}${r.usedFallback ? ' (fallback)' : ' (primary)'}` : 'none'; tally[who] = (tally[who] || 0) + 1; return tally; }, {}),
    rejectedByGate: results.reduce((tally, r) => { for (const [why, n] of Object.entries(r.rejected || {})) tally[why] = (tally[why] || 0) + n; return tally; }, {}),
    interpreterFailures: results.filter((r) => r.interpreterFailure && r.interpreterFailure !== 'not-configured').length,
    interpreter: [...new Set(results.map((r) => r.interpreter))].join(', '),
    servedFromCache: results.filter((r) => r.servedFromCache).length,
    interpretMs: { p50: p(ms('interpretMs'), 0.5), p90: p(ms('interpretMs'), 0.9) },
    searchMs: { p50: p(ms('searchMs'), 0.5), p90: p(ms('searchMs'), 0.9), max: p(ms('searchMs'), 1) }
  };
}

async function run(options) {
  const opts = options || {};
  const provider = getProvider();
  if (!provider.configured()) return { skipped: `no product source is configured (PRODUCT_SOURCE=${process.env.PRODUCT_SOURCE || 'unset'}) — run with --env-file=.env.local` };
  /* which sources the endpoint would ask, and whether each can run —
     yes or no only: a key is never read out, only whether one is set */
  const chain = providerChain(provider);
  const sources = [...new Set([...chain, require('../api/_providers/product-source').PROVIDERS.serper].filter(Boolean))]
    .map((one) => ({ name: one.name, role: one.name === provider.name ? 'primary' : 'fallback', configured: Boolean(one.configured()), inChain: chain.includes(one) }));
  const env = page();
  const categoryOf = new Map(env.catalogue.map((p) => [String(p.id).replace(/^sample-/, ''), p.category]));
  const only = (opts.only || []).map((one) => String(one).trim().toLowerCase()).filter(Boolean);
  const list = (opts.heldOut ? QUERIES.concat(HELD_OUT) : QUERIES)
    .filter(([, query]) => !only.length || only.includes(String(query).toLowerCase()))
    .slice(0, opts.max || Infinity);
  const limit = opts.limit || DEFAULT_LIMIT;
  const repeat = Math.max(1, Number(opts.repeat) || 1);
  const results = [];
  const runs = [];
  /* one at a time: a provider's rate limit is not what is being measured.
     With --repeat, each pass starts from a cold cache, so a repeated
     query really asks the provider again rather than replaying itself. */
  for (let pass = 0; pass < repeat; pass += 1) {
    if (pass) cache.reset();
    for (const [id, query] of list) {
      const measured = await measure(id, query, categoryOf.get(id) || '', env, provider, limit);
      measured.blockedBy = blockingCause(measured);
      measured.pass = pass + 1;
      (pass ? runs : results).push(measured);
      if (pass) continue;
      if (opts.onResult) opts.onResult(results[results.length - 1]);
    }
  }
  const out = { provider: provider.name, sources, limit, results, summary: summarise(results) };
  if (repeat > 1) out.stability = stability(results.concat(runs), repeat);
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => { const at = args.indexOf(flag); return at >= 0 ? Number(args[at + 1]) : undefined; };
  const json = args.includes('--json');
  const line = (r) => `${String(r.garmentRank || '—').padStart(2)} ${String(r.matchRank || '—').padStart(2)}  ${r.query.padEnd(38)} `
    + `${String(r.returned).padStart(2)} shown  ${String(r.searchMs).padStart(5)}ms  [${r.interpreter}${r.interpreterFailure ? `: ${r.interpreterFailure}` : ''}] `
    + `${r.provider ? `via ${r.provider}${r.usedFallback ? ' (fallback)' : ''} ` : ''}`
    + `asked "${r.asked}"${r.providerFailure ? `  PROVIDER FAILED: ${r.providerFailure}` : ''}${r.wrongAbove ? `  ${r.wrongAbove} wrong above` : ''}`
    + `${r.duplicates ? `  ${r.duplicates} duplicate` : ''}${r.survived.some((d) => !d.inQuery) ? `  LOST: ${r.survived.filter((d) => !d.inQuery).map((d) => d.descriptor).join(', ')}` : ''}`;
  if (!json) console.log('\ngarment-rank / full-match-rank, query, results, search latency, interpreter, what the provider was asked\n');
  const textOf = (flag) => { const at = args.indexOf(flag); return at >= 0 ? String(args[at + 1] || '') : ''; };
  run({
    heldOut: args.includes('--held-out'), limit: valueOf('--limit'), max: valueOf('--max'),
    /* --only "comfy fleece joggers|thick tee with a pocket" --repeat 3 */
    only: textOf('--only') ? textOf('--only').split('|') : null,
    repeat: valueOf('--repeat'),
    onResult: json ? null : (r) => console.log(line(r))
  })
    .then((out) => {
      if (out.skipped) { console.log(`Live benchmark skipped: ${out.skipped}`); return; }
      /* --out writes the whole result as UTF-8 JSON: a shell redirect on
         Windows writes UTF-16, which is awkward to share or diff */
      const outFile = textOf('--out');
      if (outFile) {
        fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
        console.error(`wrote ${path.resolve(outFile)}`);
      }
      if (json) { console.log(JSON.stringify(out, null, 2)); return; }
      console.log(`\nLIVE search (primary ${out.provider}, ${out.limit} per query) — not the catalogue benchmark:`);
      console.log(`  sources: ${out.sources.map((one) => `${one.name} ${one.role}, ${one.configured ? 'configured' : 'NOT configured'}${one.inChain ? '' : ' (not in the chain)'}`).join('; ')}`);
      for (const [key, value] of Object.entries(out.summary)) console.log(`  ${key.padEnd(30)} ${typeof value === 'object' ? JSON.stringify(value) : value}`);
      console.log('');
    })
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run, measure, summarise, readRequest, blockingCause, stability };
