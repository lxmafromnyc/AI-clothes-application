/* =========================================================
   FindWear — product search

   Takes the structured intent produced by /api/interpret and asks the
   configured product source for real listings. Every record passes the
   verification gate in _providers/product-source.js before it is returned,
   so a product missing its title, brand, price, image or exact product
   URL never reaches the browser.

   This endpoint holds provider credentials server-side, the same way
   /api/interpret holds the OpenAI key. Nothing here is ever sent to a
   browser except verified product records.

   Environment
     PRODUCT_SOURCE   name of the adapter to use. Unset, or naming an
                      adapter that is not configured, makes this endpoint
                      answer 503 and the interface says no product source
                      is connected.
     ALLOWED_ORIGIN   origins allowed to call this from a browser, beyond
                      the deployment's own. Comma-separated. See _cors.js.

   Metering
     A live search spends product-search quota, so each one is counted
     against the caller's plan — 1 a day on Free, 100 a month on Pro,
     500 on Max. The plan is read from the stored user record, which is
     derived from a Stripe subscription; nothing in the request can
     change it. A caller with none left gets a 429 saying when theirs
     comes back. See api/_meter.js.

     A cache hit is still a search. The shopper asked, and they were
     answered, so it costs them exactly what a cold search costs them:
     one. What the cache changes is what it costs US — see below.

   Time
     The request answers within REQUEST_BUDGET_MS below, whatever the
     product source does. The search leg is capped short of that so the
     offer lookups — which is where the retailer links come from — still
     have a window, and a lookup still in flight when the deadline
     arrives is aborted rather than waited for. What verified inside the
     budget is what comes back: a short page of real products, not an
     error. See api/_providers/openwebninja.js. SerpApi and Serper are
     held to the same clock (api/_providers/deadline.js), and a provider
     that does not answer inside it fails with an error that says it
     timed out, and which provider it was.

   Serper's organic fallback
     When a source's whole batch names no shop — Serper's /shopping
     results are Google's own cards — and the source has an organic
     endpoint, that endpoint is asked too, and each listing it offers is
     read off its own page by discovery's price and image gates before
     it reaches the verification gate below. See recordsFrom().

   Caching
     Both halves of a search are cached in api/_cache.js: the records a
     search produced, for 30 minutes, and each product's offer, for two
     hours. What is stored is RECORDS, never products, so a cache hit
     runs through verifyAll below exactly as a live answer does and a
     record that would fail the gate today fails it today. Only a search
     that verified something is stored, and a provider failure is never
     stored at all.
   ========================================================= */

'use strict';

const { getProvider, verifyAll, providerChain, outOfSearches, linkless } = require('./_providers/product-source');
const { readListings } = require('./_providers/retailer-page');
const { handledPreflight } = require('./_cors');
const { envReport } = require('./_env-report');
const meter = require('./_meter');
const cache = require('./_cache');
const { SEARCHES } = require('./_plans');

const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 12;

/* How long the whole request has before it answers with whatever it has
   got. The browser stops listening at 15s (assets/search.js), so
   answering inside nine leaves room for a cold start, TLS and the trip
   back — and means a slow product source produces a short page rather
   than an error the shopper waited fifteen seconds to be told.

   Every provider call is bounded by what remains of this, so no single
   upstream request can spend the browser's whole window on its own. */
const DEFAULT_REQUEST_BUDGET_MS = 9000;
const requestBudget = () => Number(process.env.FYND_REQUEST_BUDGET_MS) || DEFAULT_REQUEST_BUDGET_MS;

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

function asNumber(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/* Accepts only the intent fields /api/interpret produces, so a caller
   cannot smuggle arbitrary parameters through to a provider. */
function shapeIntent(raw) {
  const i = raw && typeof raw === 'object' ? raw : {};
  return {
    categories: asArray(i.categories),
    colors: asArray(i.colors),
    occasions: asArray(i.occasions),
    fits: asArray(i.fits),
    brands: asArray(i.brands),
    styles: asArray(i.styles),
    /* the garment and its descriptors in the shopper's words, when the
       interpreter read them: "hoodie", "pleated", "double-breasted" */
    garments: asArray(i.garments),
    descriptors: asArray(i.descriptors),
    keywords: asArray(i.keywords),
    maxPrice: asNumber(i.maxPrice),
    minPrice: asNumber(i.minPrice),
    season: typeof i.season === 'string' ? i.season.trim() : null,
    gender: typeof i.gender === 'string' ? i.gender.trim() : null
  };
}

/* The attachment manifest the browser sends: name, type and size only.
   Nothing here reads a file, because no file content is transmitted —
   see assets/search.js. It is shaped and counted so the request format
   is settled and a future reader has something defined to consume, and
   so the reply can state plainly that it changed nothing. */
const MAX_ATTACHMENTS = 8;

function shapeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_ATTACHMENTS).map((item) => {
    const a = item && typeof item === 'object' ? item : {};
    return {
      name: typeof a.name === 'string' ? a.name.slice(0, 200) : '',
      type: typeof a.type === 'string' ? a.type.slice(0, 100) : '',
      size: Number.isFinite(Number(a.size)) && Number(a.size) >= 0 ? Number(a.size) : 0,
      kind: a.kind === 'image' || a.kind === 'document' ? a.kind : 'document'
    };
  }).filter((a) => a.name);
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/* One search, through the cache and the gate.

   Three outcomes, and the caller can tell them apart:

     * a cache hit — no provider request of any kind was made
     * a coalesced miss — an identical search was already in flight, and
       this one waited on it rather than buying the same answer twice
     * a miss — the provider was asked, and if the gate liked the answer
       it was stored for the next shopper

   The gate runs on all three. That is the point of storing records
   rather than products: the rules about what may be shown live in one
   place and apply to a cached answer at the moment it is served, not at
   the moment it was stored.

   Throws whatever the provider throws, so the handler can answer 502 —
   and so nothing about a failure reaches the cache. */
/* The search a shopper's request runs: the configured source, and — only
   when that source says its allowance is spent — the fallback the
   product source names (see providerChain in _providers/product-source).
   Every answer, from either, goes through findProducts and so through
   the same verification gate. Any other failure is thrown as it always
   was. The answer says which source it came from and, when it fell
   back, from what and why. */
async function searchWithFallback(primary, intent, limit, stats, deadline) {
  const chain = providerChain(primary);
  let refused = null;
  for (let at = 0; at < chain.length; at += 1) {
    const provider = chain[at];
    try {
      const found = await findProducts(provider, intent, limit, stats, deadline);
      return Object.assign(found, {
        provider: provider.name,
        fellBackFrom: refused
      });
    } catch (err) {
      const said = err && err.message ? String(err.message).split('\n')[0] : String(err);
      if (!outOfSearches(err) || at + 1 >= chain.length) throw err;
      refused = { provider: provider.name, reason: said.slice(0, 200) };
      console.warn('Product source out of searches; falling back.', provider.name, '->', chain[at + 1].name);
    }
  }
  throw new Error('no product source answered');
}

/* What one provider has to offer the gate for one search.

   The adapter's search, and — only when not one record it returned
   names a shop, and only from a source that has an organic endpoint —
   that endpoint too, with each organic listing read off its own page
   (see _providers/retailer-page.js). That is catalogue discovery's rule,
   shared through product-source.js, and today it means Serper: its
   /shopping results are Google's own cards and carry no retailer URL,
   while its web results are the shops' own pages.

   Nothing here loosens anything. The shopping records still go to the
   gate and are still refused, and counted, for having no link. The
   organic records go after them, in the engine's order, carrying only
   what their own pages proved; a listing whose page proved nothing goes
   to the gate as it came and is refused there. A failed organic search
   is recorded and the shopping batch is answered as it was. */
async function recordsFrom(provider, intent, limit, deadline) {
  const batch = await provider.search(intent, { limit, deadline });
  /* the adapter carries its funnel on the array itself; a cache
     entry and a coalesced follower both need it as a plain field */
  let records = Array.from(batch || []);
  let diagnostics = (batch && batch.diagnostics) || null;
  if (!linkless(records) || typeof provider.searchOrganic !== 'function') return { records, diagnostics };

  const organic = { asked: 'after a linkless batch', offered: 0, failed: null, diagnostics: null, pages: null };
  try {
    const found = await provider.searchOrganic(intent, { limit, deadline });
    const listings = Array.from(found || []);
    organic.offered = listings.length;
    organic.diagnostics = (found && found.diagnostics) || null;
    const read = await readListings(listings, { limit, deadline });
    organic.pages = read.diagnostics;
    records = records.concat(read.records);
  } catch (err) {
    organic.failed = err && err.message ? String(err.message).split('\n')[0].slice(0, 200) : String(err);
  }
  diagnostics = Object.assign({}, diagnostics || {}, { organic });
  return { records, diagnostics };
}

async function findProducts(provider, intent, limit, stats, deadline) {
  /* whatever this adapter says changes its results beyond the intent */
  const context = typeof provider.cacheContext === 'function' ? provider.cacheContext() : {};
  const key = cache.searchKey({ provider: provider.name, intent, limit, context });

  const cached = await cache.readSearch(key, stats);
  let payload = cached;
  let storeable = false;

  if (!payload) {
    const run = await cache.coalesce(key, () => recordsFrom(provider, intent, limit, deadline));
    payload = run.value;
    /* the request that made the provider call writes the entry; a
       follower would only write the same thing over the top of it */
    storeable = !run.coalesced;
    if (run.coalesced) stats.searchCache.coalesced += 1;
  }

  const funnel = payload.diagnostics ? Object.assign({}, payload.diagnostics) : null;
  if (funnel) {
    /* the adapter's own offer-cache counters belong to this request only
       when this request really ran a search: replaying the counters
       stored with a hit would report lookups nobody made */
    if (!cached) cache.merge(stats, funnel.cache);
    delete funnel.cache;
  }

  const { products, rejected } = verifyAll(payload.records, { retailer: provider.defaultRetailer });

  /* Stored only here, and only because the gate has just produced real
     products out of these records. A search that verified nothing is not
     stored: it may be the provider having a bad minute, and half an hour
     of that is not worth keeping. */
  if (storeable && products.length) {
    await cache.writeSearch(key, {
      records: payload.records,
      diagnostics: funnel,
      /* what the cold search cost, and therefore what each hit saves */
      providerRequests: 1 + ((funnel && funnel.offers && Number(funnel.offers.lookupsMade)) || 0)
    }, stats);
  }

  return { records: payload.records, products, rejected, funnel, servedFromCache: Boolean(cached) };
}

/* The organic stage's sample refusals name a listing's host and the
   gate's reason. The benchmark reads them off findProducts directly;
   the browser gets the counts and nothing out of a record. */
function withoutSamples(funnel) {
  if (!funnel || !funnel.organic || !funnel.organic.pages || !funnel.organic.pages.samples) return funnel;
  const pages = Object.assign({}, funnel.organic.pages);
  delete pages.samples;
  return Object.assign({}, funnel, { organic: Object.assign({}, funnel.organic, { pages }) });
}

module.exports = async function handler(req, res) {
  /* answers the preflight, and refuses an origin that is not allowed */
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  /* The clock this whole request answers by. Started here so everything
     it does — reading the plan, the search, the offer lookups — runs
     inside one budget, rather than each step holding a timeout of its
     own that nothing adds up. */
  const startedAt = Date.now();
  const budgetMs = requestBudget();
  const deadline = startedAt + budgetMs;

  const provider = getProvider();
  if (!provider.configured()) {
    /* No real source is connected. Saying so is the whole point: the
       alternative would be serving something invented.

       The log records which variables this function can actually see, so
       "never configured" and "configured somewhere this deployment
       cannot read" can be told apart. States only — never values. */
    console.warn('No product source configured. env:', envReport());
    return res.status(503).json({
      error: 'No product source is configured.',
      source: null
    });
  }

  /* Checked before the provider is called, so a shopper with nothing
     left costs no quota. Counted after it answers, so a search that
     failed upstream is not charged to them. */
  const { identity, state, blocked } = await meter.guard(req, res, SEARCHES);
  if (blocked) return meter.overLimit(res, state);

  const body = await readBody(req);
  const intent = shapeIntent(body.intent);
  const attachments = shapeAttachments(body.attachments);
  const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const cacheStats = cache.counters();

  let found;
  try {
    found = await searchWithFallback(provider, intent, limit, cacheStats, deadline);
  } catch (err) {
    /* Only the search itself can reach here. An offer lookup that fails
       or runs out of time leaves its own record without a link, and the
       gate drops that one record — never the search. So a 502 means the
       search produced nothing usable at all, and a search that came back
       with something and then ran short of time is answered below with
       what it did verify. */
    console.error('Product source failed', provider.name, `${Date.now() - startedAt}ms`, err && err.message);
    return res.status(502).json({ error: 'The product source is unavailable right now.', source: provider.name });
  }

  /* The search happened — from the provider or from the cache — whatever
     the gate then makes of the records: the quota was spent either way,
     and it is the shopper's one search either way. */
  const after = await meter.spend(identity, SEARCHES, 1);

  const { records, products, rejected } = found;

  /* An adapter may carry a stage-by-stage account of what it did. Without
     one, a search that returns nothing looks identical whether the source
     had no stock, the records could not be parsed, the links could not be
     obtained, or the budget filter took them all.

     `cache` is always present, on every answer, so "this was free" and
     "this cost us fourteen requests" are never a guess. It carries
     counts and nothing else: no key, no digest, nothing a record or an
     intent was stored under. */
  const diagnostics = Object.assign({}, withoutSamples(found.funnel) || {}, {
    reachedGate: records.length,
    /* which source answered, and from which one it fell back and why */
    provider: found.provider || provider.name,
    fellBackFrom: found.fellBackFrom || null,
    verified: products.length,
    rejected,
    cache: cache.report(cacheStats, { servedFromCache: found.servedFromCache }),
    /* where the time went, so "the page is short" and "the source was
       slow" are never the same question. Milliseconds and nothing else:
       no key, no term, nothing out of a record. */
    timing: {
      budgetMs,
      totalMs: Date.now() - startedAt,
      deadlineExpired: Date.now() >= deadline
    }
  });

  if (!products.length) {
    /* server log only; counts and key names, never a value from a record */
    console.warn('Search verified nothing.', JSON.stringify(diagnostics));
  }

  return res.status(200).json({
    /* the source that actually answered: the fallback, when it was used */
    source: found.provider || provider.name,
    products: products.slice(0, limit),
    /* how many the source returned that could not be verified, and why —
       so a badly behaved provider shows up instead of silently thinning */
    returned: Array.isArray(records) ? records.length : 0,
    rejected,
    diagnostics,
    /* said out loud so an attachment is never mistaken for something
       that shaped these results. It did not. */
    attachments: { received: attachments.length, used: 0, reason: attachments.length ? 'Attachments are not read yet.' : null },
    /* so the meter on screen moves without a second round trip */
    usage: meter.report(after || state)
  });
};

module.exports.shapeIntent = shapeIntent;
module.exports.shapeAttachments = shapeAttachments;
/* exported for scripts/test-cache.js and scripts/bench-offer-resolution.js,
   so both measure the path a shopper actually takes */
module.exports.findProducts = findProducts;
module.exports.recordsFrom = recordsFrom;
module.exports.searchWithFallback = searchWithFallback;
/* the endpoint's own budget and page size, for scripts/bench-live.js */
module.exports.requestBudget = requestBudget;
module.exports.DEFAULT_LIMIT = DEFAULT_LIMIT;
