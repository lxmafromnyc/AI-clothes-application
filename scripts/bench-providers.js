#!/usr/bin/env node
/* =========================================================
   Fynd — product source benchmark: OpenWeb Ninja vs SerpApi

   Runs BOTH adapters over the SAME query set and reports the numbers a
   provider decision actually turns on. Nothing here touches production:
   it imports the two adapters directly, never /api/search, so no
   metering, no auth and no store is involved.

     node scripts/bench-providers.js               stubbed (default)
     node scripts/bench-providers.js --sweep       + link-rate sensitivity
     node scripts/bench-providers.js --live        real calls, real keys
     node scripts/bench-providers.js --latency 250 ms per simulated call

   ---------------------------------------------------------
   What this measures honestly, and what it cannot
   ---------------------------------------------------------
   STRUCTURAL, and exact even when stubbed. These follow from the two
   adapters' control flow, not from the contents of any fixture:

     requests per search        how many upstream calls each makes
     sequential round trips     the latency floor: OpenWeb Ninja resolves
                                offers in batches of 4, so its wall clock
                                is several round trips deep; SerpApi is
                                one call
     usable-result rate         every record is run through the REAL gate
                                in _providers/product-source.js, so the
                                pass/reject tallies are the ones
                                production would produce
     duplicate rate             the gate dedupes on productUrl; this
                                reports what it collapsed
     schema fit                 whether records map into Fynd's product
                                shape with no frontend change

   NOT MEASURABLE FROM A STUB, and reported as unknown rather than
   guessed. These depend on what the live services actually return:

     real latency               stubbed runs use --latency to model it
     relevance                  needs live results and human judgement
     diversity                  needs live results
     inline direct-link rate    THE decisive unknown for SerpApi. The
                                stub takes it as a parameter and --sweep
                                shows the whole curve, so a single live
                                run drops straight into the answer.

   ---------------------------------------------------------
   Credentials
   ---------------------------------------------------------
   --live needs, in the environment and never on the command line:

     OPENWEBNINJA_API_KEY   already used by production
     SERPAPI_API_KEY        create this one for the evaluation

   Read from the process environment only. This script does NOT load a
   .env file, so a key that lives only in .env is invisible here — which
   is the trap that produced one unreadable run, described below.

   SerpApi has no header form for its credential: it travels as an
   `api_key` QUERY PARAMETER, so a request URL is itself a secret. This
   script never prints a URL from either provider, asserts the adapter's
   redaction before it runs, and scrubs every error message it prints.

   ---------------------------------------------------------
   Why a run of zeros is no longer possible
   ---------------------------------------------------------
   A --live run once reported, for BOTH providers, 12 failures, 0
   requests per search, 0 results and 0 verified products, in ~43ms —
   and gave no reason for any of it. Three separate faults combined:

     1. --live substituted the placeholder 'bench-stub-key' when a real
        key was absent, so every query authenticated as a fake key and
        was refused in milliseconds. That is where the 43ms came from.
     2. Each adapter's error was caught, COUNTED, and discarded. The
        message naming the status was never printed anywhere.
     3. A thrown adapter returns no diagnostics, and the missing request
        count was rendered as 0 — asserting that no call had been made,
        when twelve had been made and refused.

   All three are fixed. --live now refuses to start without real keys;
   every failure is printed with the provider's own status and message,
   grouped by distinct message; an unknown request count prints as '-'
   and is shown beside `http`, the calls that actually left the process;
   and a run with any failure is banner-marked NOT PROVIDER DATA, has its
   comparison and cost tables suppressed when nothing got through, and
   exits non-zero.

   Before spending 24 live calls, settle one query per provider:

     node scripts/diagnose-provider.js serpapi
     node scripts/diagnose-provider.js openwebninja

   Both exit 0 only on a 200 with results, so they chain:

     node scripts/diagnose-provider.js serpapi && \
     node scripts/diagnose-provider.js openwebninja && \
     node scripts/bench-providers.js --live
   ========================================================= */

'use strict';

const own = require('../api/_providers/openwebninja');
const serp = require('../api/_providers/serpapi');
const { verifyAll } = require('../api/_providers/product-source');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const SWEEP = args.includes('--sweep');
const LATENCY = (() => {
  const i = args.indexOf('--latency');
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 40;
})();

/* The rate at which SerpApi results carry a usable merchant link. The
   whole comparison hinges on it and it cannot be known without a live
   key, so the stub takes it as a parameter rather than assuming one. */
const DEFAULT_SERP_LINK_RATE = 0.5;
/* The rate at which an OpenWeb Ninja /product-offers lookup yields a
   usable link. 0.8 is the figure the cost analysis used. */
const DEFAULT_OWN_RESOLVE_RATE = 0.8;

/* ---------------------------------------------------------
   The query set

   Six kinds of shopping request, because they stress different parts of
   the pipeline: term count, brand matching, price filtering, and how
   much the interpreter had to invent. `intent` is the shape
   /api/interpret produces, which is what an adapter is handed.
   --------------------------------------------------------- */

const QUERIES = [
  { kind: 'simple', text: 'black shirt',
    intent: { categories: ['shirt'], colors: ['Black'], keywords: ['black', 'shirt'] } },
  { kind: 'simple', text: 'jeans',
    intent: { categories: ['trousers'], keywords: ['jeans'] } },

  { kind: 'brand + item', text: 'nike hoodie',
    intent: { categories: ['knit'], brands: ['Nike'], keywords: ['nike', 'hoodie'] } },
  { kind: 'brand + item', text: 'levis 501 jeans',
    intent: { categories: ['trousers'], brands: ["Levi's"], keywords: ['501', 'jeans'] } },

  { kind: 'color + item', text: 'olive green jacket',
    intent: { categories: ['jacket'], colors: ['Green'], keywords: ['olive', 'green', 'jacket'] } },
  { kind: 'color + item', text: 'white oxford shirt',
    intent: { categories: ['shirt'], colors: ['White'], styles: ['Classic'], keywords: ['oxford'] } },

  { kind: 'budget', text: 'running shoes under $80',
    intent: { categories: ['sneaker'], maxPrice: 80, keywords: ['running', 'shoes'] } },
  { kind: 'budget', text: 'winter coat between $100 and $250',
    intent: { categories: ['coat'], minPrice: 100, maxPrice: 250, keywords: ['winter', 'coat'] } },

  { kind: 'occasion/style', text: 'something smart for a work interview',
    intent: { categories: ['shirt'], occasions: ['Work'], styles: ['Classic'], keywords: ['smart', 'interview'] } },
  { kind: 'occasion/style', text: 'streetwear oversized tee',
    intent: { categories: ['tee'], fits: ['Oversized'], styles: ['Streetwear'], keywords: ['streetwear'] } },

  { kind: 'ambiguous NL', text: 'something cosy for autumn walks that is not too bulky',
    intent: { categories: ['knit'], occasions: ['Weekend'], season: 'fall', keywords: ['cosy', 'autumn', 'walks', 'bulky'] } },
  { kind: 'ambiguous NL', text: 'i need an outfit for my friends wedding in june',
    intent: { occasions: ['Evening'], season: 'summer', keywords: ['outfit', 'wedding', 'june'] } }
];

/* ---------------------------------------------------------
   Fixtures

   Modelled on each provider's DOCUMENTED response shape, not invented
   freely. The one knob each is the thing that is genuinely unknown:
   how often a usable retailer link is present.
   --------------------------------------------------------- */

/* Eleven, not ten, on purpose: the link pattern below marks every Nth
   result, and with a ten-shop list an even N would only ever land on
   half the shops — making retailer diversity an artifact of the fixture
   rather than a property of the provider. Eleven is coprime with the
   strides this produces. */
const SHOPS = ['nike.com', 'zappos.com', 'nordstrom.com', 'uniqlo.com', 'target.com',
  'macys.com', 'asos.com', 'jcrew.com', 'levi.com', 'adidas.com', 'ssense.com'];

const priceFor = (i) => 25 + ((i * 37) % 220);

/* OpenWeb Ninja /search: Google Shopping's PRODUCT view. The defining
   property is that product_page_url is ALWAYS a Google URL — no record
   ever arrives with a retailer link, which is why the adapter must buy
   one per product. */
const ownSearchPayload = (n) => ({
  status: 'OK',
  request_id: 'bench',
  data: Array.from({ length: n }, (_, i) => ({
    product_id: `own-p${i}`,
    product_title: `Product ${i} — cotton blend`,
    price: `$${priceFor(i)}.00`,
    store_name: SHOPS[i % SHOPS.length],
    product_photos: [`https://img.example-cdn.com/own/${i}.jpg`],
    product_page_url: 'https://www.google.com/search?q=item&tbm=shop',
    product_attributes: { Brand: `Brand${i % 6}` }
  }))
});

/* OpenWeb Ninja /product-offers: the second request, which is where a
   retailer link finally comes from. */
const ownOffersPayload = (id, resolves) => ({
  status: 'OK',
  data: resolves
    ? [{ store_name: SHOPS[Math.abs(hash(id)) % SHOPS.length],
         price: `$${priceFor(Math.abs(hash(id)) % 12)}.00`,
         offer_page_url: `https://www.${SHOPS[Math.abs(hash(id)) % SHOPS.length]}/p/${id}` }]
    : [{ store_name: SHOPS[0] }]
});

/* SerpApi google_shopping: every field arrives on ONE object. `link` is
   a merchant URL for some fraction of results and a google.com/aclk
   tracking URL for the rest — that fraction is the unknown. */
const serpPayload = (n, linkRate) => ({
  search_metadata: { status: 'Success' },
  search_parameters: { engine: 'google_shopping' },
  shopping_results: Array.from({ length: n }, (_, i) => {
    const shop = SHOPS[i % SHOPS.length];
    /* Exactly floor(n × linkRate) direct links, spread evenly through
       the page rather than clustered at the front — clustering would
       flatter whichever provider is read first. */
    const direct = Math.floor((i + 1) * linkRate) > Math.floor(i * linkRate);
    return {
      position: i + 1,
      title: `Product ${i} — cotton blend`,
      product_link: 'https://www.google.com/shopping/product/1234567890',
      link: direct
        ? `https://www.${shop}/products/item-${i}`
        : 'https://www.google.com/aclk?sa=l&adurl=https%3A%2F%2Fexample.com',
      product_id: `serp-p${i}`,
      source: shop,
      price: `$${priceFor(i)}.00`,
      extracted_price: priceFor(i),
      thumbnail: `https://serpapi.com/images/${i}.jpg`,
      rating: 4.2,
      reviews: 100 + i,
      delivery: 'Free delivery',
      extensions: ['Free delivery']
    };
  })
});

function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i += 1) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return h;
}

/* ---------------------------------------------------------
   The harness
   --------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Counts calls and injects a per-call delay, so the wall clock reflects
   how many round trips deep each adapter is rather than how fast this
   machine is. */
function stubFetch({ serpLinkRate, ownResolveRate, latencyMs }) {
  const calls = { own: 0, ownOffers: 0, serp: 0 };
  const impl = async (url) => {
    const href = String(url);
    await sleep(latencyMs);

    if (href.startsWith('https://serpapi.com/')) {
      calls.serp += 1;
      return ok(serpPayload(60, serpLinkRate));
    }
    if (href.includes('/product-offers')) {
      calls.ownOffers += 1;
      const id = new URL(href).searchParams.get('product_id');
      return ok(ownOffersPayload(id, Math.abs(hash(id)) % 100 < Math.round(ownResolveRate * 100)));
    }
    calls.own += 1;
    return ok(ownSearchPayload(24));
  };
  impl.calls = calls;
  return impl;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

/* HTTP calls that actually left this process during one query.

   In live mode the adapter's own diagnostics are the request count — but
   an adapter that THREW returns no diagnostics, and the old code then
   read that absence as zero requests. "0 requests" and "the request was
   made and refused" are opposite diagnoses, and printing the first when
   the second is true is what made the last run unreadable. So count the
   calls independently of what the adapter lived to report. */
const attempts = { n: 0 };

/* Wraps whichever fetch is in play — the stub, or the real one in live
   mode — so the count is taken the same way in both. */
async function withFetch(impl, run) {
  const real = global.fetch;
  attempts.n = 0;
  global.fetch = (...a) => { attempts.n += 1; return (impl || real)(...a); };
  try { return await run(); } finally { global.fetch = real; }
}

/* One provider, one query. Returns the row the tables are built from. */
async function runOne(adapter, query, stub, counterKey) {
  const before = stub ? stub.calls[counterKey] + (counterKey === 'own' ? stub.calls.ownOffers : 0) : 0;
  const startedAt = Date.now();

  let records;
  let failed = null;
  try {
    records = await adapter.search(query.intent, { limit: 12 });
  } catch (err) {
    failed = err && err.message;
    records = [];
  }
  const wallMs = Date.now() - startedAt;

  const after = stub ? stub.calls[counterKey] + (counterKey === 'own' ? stub.calls.ownOffers : 0) : 0;
  /* null means UNKNOWN — the adapter threw before it could report — and
     is rendered as '-', never as 0. A zero here would claim the adapter
     made no call, which is a far stronger statement than "it did not
     finish", and usually a false one. */
  const requests = stub
    ? after - before
    : (records && records.diagnostics && typeof records.diagnostics.requests === 'number'
      ? records.diagnostics.requests
      : null);
  const attempted = attempts.n;

  const { products, rejected } = verifyAll(records, { retailer: adapter.defaultRetailer });
  const reachedGate = Array.isArray(records) ? records.length : 0;
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);

  /* What the PROVIDER returned, not what the adapter chose to pass on.
     This is the denominator the usable-result rate has to use: an
     adapter that silently drops its own unusable records before the gate
     would otherwise score 100%. */
  const providerReturned = (records.diagnostics && records.diagnostics.returnedByProvider) || reachedGate;

  return {
    query,
    failed,
    requests,
    attempted,
    wallMs,
    providerReturned,
    reachedGate,
    verified: products.length,
    /* Fynd shows 12; /api/search slices to `limit`. Anything past that
       is not a benefit the shopper ever sees. */
    shown: Math.min(products.length, 12),
    rejected,
    rejectedTotal,
    /* the gate dedupes on productUrl; anything it collapsed is a
       duplicate the provider returned */
    duplicates: Math.max(0, reachedGate - rejectedTotal - products.length),
    retailers: new Set(products.map((p) => p.retailer)).size,
    diagnostics: (records && records.diagnostics) || null,
    products
  };
}

async function runProvider(adapter, counterKey, opts) {
  const stub = LIVE ? null : stubFetch(opts);
  const rows = [];
  for (const query of QUERIES) {
    const row = await withFetch(stub, () => runOne(adapter, query, stub, counterKey));
    rows.push(row);
  }
  return rows;
}

const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
const mean = (rows, f) => (rows.length ? sum(rows, f) / rows.length : 0);

function summarise(rows) {
  const returned = sum(rows, (r) => r.providerReturned);
  return {
    queries: rows.length,
    failures: rows.filter((r) => r.failed).length,
    attempted: sum(rows, (r) => r.attempted),
    reqPerSearch: mean(rows, (r) => r.requests),
    maxReq: Math.max(...rows.map((r) => r.requests || 0)),
    wallMs: mean(rows, (r) => r.wallMs),
    returnedPerSearch: mean(rows, (r) => r.providerReturned),
    verifiedPerSearch: mean(rows, (r) => r.verified),
    shownPerSearch: mean(rows, (r) => r.shown),
    /* verified as a fraction of what the provider returned */
    usableRate: returned ? sum(rows, (r) => r.verified) / returned : 0,
    fullPageRate: rows.filter((r) => r.shown >= 12).length / rows.length,
    duplicates: sum(rows, (r) => r.duplicates),
    retailersPerSearch: mean(rows, (r) => r.retailers),
    rejected: rows.reduce((acc, r) => {
      for (const [k, v] of Object.entries(r.rejected)) acc[k] = (acc[k] || 0) + v;
      return acc;
    }, {})
  };
}

/* ---------------------------------------------------------
   Cost

   OpenWeb Ninja bills per REQUEST; SerpApi bills per SEARCH, where one
   search is one API call. So the units are the same — a call — but the
   per-call prices differ by an order of magnitude, and the call COUNTS
   differ by another. Both effects have to be carried together.
   --------------------------------------------------------- */

const OWN_TIERS = [
  { name: 'Pro', monthly: 25, included: 10000 },
  { name: 'Ultra', monthly: 75, included: 50000 },
  { name: 'Mega', monthly: 150, included: 200000 }
];
const SERP_TIERS = [
  { name: 'Starter', monthly: 25, included: 1000 },
  { name: 'Developer', monthly: 75, included: 5000 },
  { name: 'Production', monthly: 150, included: 15000 },
  { name: 'Big Data', monthly: 275, included: 30000 }
];

/* The cheapest tier that covers the volume, and what that costs. A tier
   too small for the volume is not silently used at its blended rate. */
function monthlyCost(tiers, callsPerSearch, searches) {
  const calls = callsPerSearch * searches;
  const fits = tiers.filter((t) => t.included >= calls);
  if (fits.length) {
    const t = fits.reduce((a, b) => (a.monthly <= b.monthly ? a : b));
    return { tier: t.name, monthly: t.monthly, calls, perSearch: t.monthly / searches, covered: true };
  }
  const biggest = tiers[tiers.length - 1];
  const bundles = Math.ceil(calls / biggest.included);
  return {
    tier: `${biggest.name} ×${bundles}`,
    monthly: biggest.monthly * bundles,
    calls,
    perSearch: (biggest.monthly * bundles) / searches,
    covered: false
  };
}

const money = (n) => '$' + n.toFixed(n < 1 ? 4 : 2);
const pct = (n) => (n * 100).toFixed(1) + '%';

/* ---------------------------------------------------------
   Report
   --------------------------------------------------------- */

function line(char) { console.log(char.repeat(96)); }

/* Both adapters raise errors that name a status and a short body and
   deliberately omit the URL, so their messages are already safe to
   print. This is the second lock on that door: an api_key parameter is
   rewritten wherever it appears, and the literal keys this process holds
   are replaced, so a future adapter that starts quoting a URL cannot
   turn this report into a published credential. */
const SECRETS = ['SERPAPI_API_KEY', 'OPENWEBNINJA_API_KEY']
  .map((n) => process.env[n])
  .filter((v) => typeof v === 'string' && v.length >= 8 && v !== 'bench-stub-key');

function scrub(value) {
  let out = String(value === undefined || value === null ? '' : value);
  out = out.replace(/([?&](?:api_key|apikey|key|token)=)[^&\s"']+/gi, '$1REDACTED');
  for (const secret of SECRETS) out = out.split(secret).join('REDACTED');
  return out;
}

/* The error messages, which the previous version counted and threw away.

   Grouped by distinct message, because twelve identical 401s are one
   finding printed once, not twelve. Each group also says whether an HTTP
   request actually left the process, which is the line that separates a
   missing credential from a refused one. */
function printFailures(label, rows) {
  const failed = rows.filter((r) => r.failed);
  if (!failed.length) return;

  console.log(`\n  ${label} — ${failed.length} of ${rows.length} queries FAILED`);
  const groups = new Map();
  for (const r of failed) {
    const message = scrub(r.failed) || '(the adapter threw without a message)';
    if (!groups.has(message)) groups.set(message, []);
    groups.get(message).push(r);
  }
  for (const [message, rs] of groups) {
    const calls = rs.reduce((a, r) => a + (r.attempted || 0), 0);
    console.log(`    ${String(rs.length).padStart(2)}x  ${message}`);
    console.log('        ' + (calls === 0
      ? 'NO HTTP request left this process: the adapter threw before calling out, '
        + 'so this is a local problem (usually a missing key), not the provider refusing.'
      : `${calls} HTTP request(s) were made and did not succeed: the provider, or `
        + 'something between here and it, returned the status above.'));
  }
}

function printRows(label, rows) {
  console.log(`\n${label}`);
  console.log('  ' + 'query'.padEnd(40) + 'reqs'.padStart(6) + 'http'.padStart(6) +
    'from'.padStart(6) + 'gate'.padStart(6) + 'ok'.padStart(5) + 'shown'.padStart(7) +
    'dupes'.padStart(7) + 'shops'.padStart(7) + 'ms'.padStart(7) + '  status');
  for (const r of rows) {
    console.log('  ' + `${r.query.kind}: ${r.query.text}`.slice(0, 39).padEnd(40) +
      /* '-' not 0: the adapter never got to say, and 0 would be a claim */
      String(r.requests === null ? '-' : r.requests).padStart(6) +
      String(r.attempted).padStart(6) +
      String(r.providerReturned).padStart(6) +
      String(r.reachedGate).padStart(6) + String(r.verified).padStart(5) +
      String(r.shown).padStart(7) + String(r.duplicates).padStart(7) +
      String(r.retailers).padStart(7) + String(r.wallMs).padStart(7) +
      (r.failed ? '  FAILED' : '  ok'));
  }
  printFailures(label, rows);
}

async function main() {
  /* Refuse to run if the adapter would ever put a key in a log. */
  const probe = serp.redactUrl('https://serpapi.com/search.json?engine=google_shopping&api_key=SHOULD_NOT_APPEAR');
  if (probe.includes('SHOULD_NOT_APPEAR')) {
    console.error('ABORT: serpapi.redactUrl did not redact the credential.');
    process.exit(1);
  }

  console.log('');
  line('=');
  console.log('Fynd product-source benchmark — OpenWeb Ninja vs SerpApi');
  line('=');
  console.log(`mode                ${LIVE ? 'LIVE (real API calls)' : 'STUBBED (no network)'}`);
  console.log(`queries             ${QUERIES.length} across ${new Set(QUERIES.map((q) => q.kind)).size} kinds`);
  if (!LIVE) {
    console.log(`simulated latency   ${LATENCY} ms per upstream call`);
    console.log(`SerpApi link rate   ${pct(DEFAULT_SERP_LINK_RATE)}  <-- ASSUMED, not measured`);
    console.log(`OWN resolve rate    ${pct(DEFAULT_OWN_RESOLVE_RATE)}`);
  }
  console.log(`credential check    serpapi.redactUrl redacts api_key: ok`);

  /* A placeholder key is what the STUB needs — its fetch never leaves
     the process, and the adapters refuse to run without something in the
     variable. Handing that same placeholder to a LIVE run was the bug
     that produced the unreadable run: every query authenticated as
     'bench-stub-key', every query was refused in milliseconds, and the
     report showed twelve failures and a wall of zeros with no hint that
     the credential was fake. A live run now demands real keys and
     refuses to start without them, because a benchmark that cannot reach
     a provider must say so instead of measuring the refusal. */
  if (LIVE) {
    const missing = [];
    if (!own.configured()) missing.push('OPENWEBNINJA_API_KEY');
    if (!serp.configured()) missing.push('SERPAPI_API_KEY');
    if (missing.length) {
      console.error(`\nABORT: --live needs ${missing.join(' and ')} in the environment.\n`);
      console.error('Nothing was measured and nothing was requested. Export the real key(s) in');
      console.error('the shell that runs this — this script never reads a .env file, so a key that');
      console.error('lives only in .env is not visible here.\n');
      console.error('Then settle ONE query per provider before spending 24 live calls:');
      console.error('  node scripts/diagnose-provider.js serpapi');
      console.error('  node scripts/diagnose-provider.js openwebninja\n');
      process.exit(2);
    }
  } else {
    process.env.OPENWEBNINJA_API_KEY = process.env.OPENWEBNINJA_API_KEY || 'bench-stub-key';
    process.env.SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || 'bench-stub-key';
  }

  const opts = {
    serpLinkRate: DEFAULT_SERP_LINK_RATE,
    ownResolveRate: DEFAULT_OWN_RESOLVE_RATE,
    latencyMs: LIVE ? 0 : LATENCY
  };

  const ownRows = await runProvider(own, 'own', opts);
  const serpRows = await runProvider(serp, 'serp', opts);

  printRows('OpenWeb Ninja', ownRows);
  printRows('SerpApi', serpRows);

  const o = summarise(ownRows);
  const s = summarise(serpRows);

  /* The point of the whole exercise: a run that failed is a report ABOUT
     THE FAILURE, never a row of zeros presented in the same shape as a
     measurement. When nothing got through, the comparison and cost
     tables are not printed at all — a zero in a cost table is a number
     someone will quote. */
  const totalFailures = o.failures + s.failures;
  if (LIVE && totalFailures) {
    console.log('\n');
    line('!');
    console.log('THIS RUN IS NOT PROVIDER DATA');
    line('!');
    console.log(`  ${totalFailures} of ${ownRows.length + serpRows.length} queries failed. The messages are printed above,`);
    console.log('  under each provider. Fix those first; nothing below would mean anything.');
    if (o.failures === ownRows.length && s.failures === serpRows.length) {
      console.log('');
      console.log('  EVERY query failed for BOTH providers, so the comparison and cost tables are');
      console.log('  suppressed rather than printed as zeros.');
      console.log(`  HTTP requests actually attempted: OpenWeb Ninja ${o.attempted}, SerpApi ${s.attempted}.`);
      console.log('');
      console.log('  Narrow it down on a single query, which costs one call instead of twelve:');
      console.log('    node scripts/diagnose-provider.js serpapi');
      console.log('    node scripts/diagnose-provider.js openwebninja');
      console.log('');
      process.exitCode = 1;
      return;
    }
    console.log('');
    console.log('  The tables below cover ONLY the queries that succeeded, and the per-search');
    console.log('  means are diluted by the failed ones. Treat them as provisional.');
    process.exitCode = 1;
  }

  console.log('\n');
  line('-');
  console.log('COMPARISON');
  line('-');
  const row = (k, a, b) => console.log('  ' + k.padEnd(34) + String(a).padStart(26) + String(b).padStart(26));
  row('', 'OpenWeb Ninja', 'SerpApi');
  line('-');
  row('requests / search (mean)', o.reqPerSearch.toFixed(1), s.reqPerSearch.toFixed(1));
  row('requests / search (max)', o.maxReq, s.maxReq);
  row('sequential round trips', '1 + up to 4 batches', '1');
  row('engine', 'realtime-product-search', (serpRows[0].diagnostics && serpRows[0].diagnostics.engine) || 'n/a');
  row(`wall clock @${LATENCY}ms/call`, Math.round(o.wallMs) + ' ms', Math.round(s.wallMs) + ' ms');
  row('results returned by provider', o.returnedPerSearch.toFixed(1), s.returnedPerSearch.toFixed(1));
  row('verified products / search', o.verifiedPerSearch.toFixed(1), s.verifiedPerSearch.toFixed(1));
  row('products actually shown (max 12)', o.shownPerSearch.toFixed(1), s.shownPerSearch.toFixed(1));
  row('usable-result rate', pct(o.usableRate), pct(s.usableRate));
  row('full 12-product page rate', pct(o.fullPageRate), pct(s.fullPageRate));
  row('duplicates collapsed', o.duplicates, s.duplicates);
  row('failures', o.failures, s.failures);
  if (LIVE) row('HTTP requests attempted', o.attempted, s.attempted);
  if (!LIVE) {
    console.log('\n  fixture-derived — these are properties of the stub, NOT findings:');
    row('  distinct retailers / search', o.retailersPerSearch.toFixed(1), s.retailersPerSearch.toFixed(1));
    row('  duplicate rate', pct(o.duplicates / Math.max(1, sum(ownRows, (r) => r.providerReturned))),
      pct(s.duplicates / Math.max(1, sum(serpRows, (r) => r.providerReturned))));
  } else {
    row('distinct retailers / search', o.retailersPerSearch.toFixed(1), s.retailersPerSearch.toFixed(1));
  }

  /* When a provider verified nothing, the reason is the whole result —
     print it before anything else, and per distinct reason rather than
     once per query. */
  for (const [label, rows] of [['OpenWeb Ninja', ownRows], ['SerpApi', serpRows]]) {
    const verdicts = new Map();
    for (const r of rows) {
      const v = r.diagnostics && r.diagnostics.verdict;
      if (v && v !== 'ok') verdicts.set(v, (verdicts.get(v) || 0) + 1);
    }
    if (verdicts.size) {
      console.log(`\n  ${label} — why nothing verified:`);
      for (const [v, n] of verdicts) console.log(`    ${n}/${rows.length} queries: ${v}`);
      const cov = rows[0].diagnostics && rows[0].diagnostics.fieldCoverage;
      if (cov) {
        console.log('    field coverage on the first query: ' +
          Object.entries(cov).map(([k, n]) => `${k}=${n}`).join(' '));
      }
    }
  }

  console.log('\n  direct retailer link in FIRST response');
  row('  records with inline link', '0 (by endpoint design)',
    serpRows[0].diagnostics ? `${pct(mean(serpRows, (r) => r.diagnostics.inlineLinkRate))} of results` : 'n/a');
  row('  second request needed?', 'yes, per product',
    serpRows.every((r) => r.diagnostics && r.diagnostics.filledPageInOneRequest) ? 'no' : 'sometimes');

  console.log('\n  rejection reasons');
  for (const [k, v] of Object.entries(o.rejected)) console.log('    OWN  ' + k.padEnd(34) + String(v).padStart(5));
  for (const [k, v] of Object.entries(s.rejected)) console.log('    SERP ' + k.padEnd(34) + String(v).padStart(5));

  /* ---- cost ---- */
  console.log('\n');
  line('-');
  console.log('COST PER FYND SEARCH  (provider fees only; OpenAI adds ~$0.00014)');
  line('-');
  console.log('  ' + 'searches/mo'.padEnd(14) +
    'OWN calls'.padStart(11) + 'OWN cost'.padStart(11) + 'OWN tier'.padStart(14) +
    'SERP calls'.padStart(12) + 'SERP cost'.padStart(11) + 'SERP tier'.padStart(15));

  const ownCalls = Math.round(o.reqPerSearch);
  const serpCalls = Math.max(1, Math.round(s.reqPerSearch));
  for (const n of [100, 1000, 10000, 100000]) {
    const a = monthlyCost(OWN_TIERS, ownCalls, n);
    const b = monthlyCost(SERP_TIERS, serpCalls, n);
    console.log('  ' + String(n).padEnd(14) +
      String(a.calls).padStart(11) + money(a.perSearch).padStart(11) + a.tier.padStart(14) +
      String(b.calls).padStart(12) + money(b.perSearch).padStart(11) + b.tier.padStart(15));
  }
  console.log('\n  monthly totals');
  console.log('  ' + 'searches/mo'.padEnd(14) + 'OpenWeb Ninja'.padStart(18) + 'SerpApi'.padStart(18) + 'cheaper by'.padStart(18));
  for (const n of [100, 1000, 10000, 100000]) {
    const a = monthlyCost(OWN_TIERS, ownCalls, n);
    const b = monthlyCost(SERP_TIERS, serpCalls, n);
    const diff = a.monthly === b.monthly ? 'even'
      : a.monthly < b.monthly ? `OWN ${money(b.monthly - a.monthly)}` : `SERP ${money(a.monthly - b.monthly)}`;
    console.log('  ' + String(n).padEnd(14) + money(a.monthly).padStart(18) + money(b.monthly).padStart(18) + diff.padStart(18));
  }

  /* ---- sensitivity ---- */
  if (SWEEP) {
    console.log('\n');
    line('-');
    console.log('SENSITIVITY — SerpApi inline direct-link rate (the one unknown)');
    line('-');
    console.log('  ' + 'link rate'.padEnd(12) + 'shown/search'.padStart(17) +
      'full page?'.padStart(12) + 'requests'.padStart(10) + 'usable rate'.padStart(14));
    for (const rate of [0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0]) {
      const rows = await runProvider(serp, 'serp',
        { serpLinkRate: rate, ownResolveRate: DEFAULT_OWN_RESOLVE_RATE, latencyMs: 0 });
      const x = summarise(rows);
      console.log('  ' + pct(rate).padEnd(12) + x.shownPerSearch.toFixed(1).padStart(17) +
        (x.fullPageRate === 1 ? 'yes' : x.fullPageRate === 0 ? 'no' : pct(x.fullPageRate)).padStart(12) +
        x.reqPerSearch.toFixed(1).padStart(10) + pct(x.usableRate).padStart(14));
    }
    console.log('\n  A 60-result page needs only 12 usable links to fill Fynd\'s page,');
    console.log('  so any inline link rate at or above 20% makes SerpApi a ONE-request provider.');
  }

  console.log('\n');
  line('-');
  console.log('NOT MEASURED HERE — needs a live key');
  line('-');
  console.log('  relevance / result quality   requires live results and human judgement');
  console.log('  real latency                 stub models round trips only, at --latency');
  console.log('  true inline link rate        the decisive unknown; run --live to settle it');
  console.log('  real duplicate & diversity   fixtures cannot stand in for a live index');
  console.log('');
  if (!LIVE) {
    console.log('  To settle them:  SERPAPI_API_KEY=... OPENWEBNINJA_API_KEY=... \\');
    console.log('                   node scripts/bench-providers.js --live --sweep');
    console.log('  (keys from the environment only — never pass them on the command line)');
  }
  console.log('');
}

main().catch((err) => {
  console.error('benchmark failed:', err && err.message);
  process.exit(1);
});
