/* =========================================================
   Fynd — the search and offer cache

   Two things cost OpenWeb Ninja requests: the /search call that finds
   the records, and the /product-offers call that turns each record into
   a retailer link. A shopper asking for "black oversized hoodie under
   $80" spends one of the first and up to `12 + LOOKUP_SLACK` of the
   second, and the next shopper asking the same thing spends them all
   again. This file is what stops that.

   ---------------------------------------------------------
   Where it is kept
   ---------------------------------------------------------
   In api/_store.js — the Redis-over-HTTP store the accounts, sessions,
   usage counters and rate limits already use. There is no second
   database and no new service: a deployment that has KV_REST_API_URL or
   UPSTASH_REDIS_REST_URL set already has everything this needs, and one
   that has neither falls back to the same per-instance memory driver
   everything else falls back to.

   ---------------------------------------------------------
   The two layers
   ---------------------------------------------------------
   1. SEARCH RESULTS, 30 minutes.
      Keyed by the normalized search intent plus everything else that
      changes what comes back: which provider is running, how many
      products were asked for, the marketplace, and whether offer
      resolution is on. What is stored is the RECORDS the adapter
      produced — not the products the browser was shown — so a cache hit
      still goes through the verification gate in product-source.js and
      a record that would fail it today is dropped today. Only a search
      that actually verified something is stored: an empty answer might
      be the provider having a bad minute, and half an hour of it is not
      worth saving.

   2. PRODUCT OFFERS, 2 hours.
      Keyed by the product's own id and the marketplace it was looked up
      in. What is stored is the one offer the adapter picked — price,
      currency, retailer and retailer URL — which is exactly what the
      gate reads. Offers move more slowly than search rankings, so they
      are kept four times as long.

   3. "NO USABLE OFFER", 5 minutes.
      A product whose sellers came back with no link Fynd can show is
      remembered briefly, so a page of the same unusable records does
      not buy the same dead lookups over and over. Five minutes, not two
      hours, because "no offer right now" is a statement about a moment.

   ---------------------------------------------------------
   What is never cached
   ---------------------------------------------------------
   A provider failure. A 429, a 500, a timeout and a torn connection all
   mean the same thing here: we do not know. Writing that down as "no
   offer" would turn one bad minute upstream into five minutes of
   pretending, and writing it down as a result would be worse. Every
   write below happens on a path where the provider actually answered.

   ---------------------------------------------------------
   Two things going wrong at once
   ---------------------------------------------------------
   Nothing in here may take a search down. Every read and every write is
   wrapped: a store that cannot be reached is a miss, and a write that
   fails is a search that was not cached. `FYND_CACHE=off` turns the
   whole thing into those same misses, on purpose, which is what makes
   "does the cache do this, or does the provider" answerable by setting
   one variable.

   ---------------------------------------------------------
   Expiry is written down twice
   ---------------------------------------------------------
   The store is asked to expire the key, AND the payload carries its own
   `expiresAt` which is checked on read. The store's TTL is what keeps
   Redis from filling up; the stamp is what makes "do not reuse an offer
   after its TTL expires" a property of this file rather than a promise
   about someone else's clock. It is also what lets the tests and the
   benchmark move time forward without waiting for it.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const store = require('./_store');

/* Bumping this invalidates every entry at once, without touching the
   store: old keys simply stop being asked for and expire on their own.
   Bump it whenever a change alters what a record MEANS — a new field
   the gate reads, a different query builder, a changed offer picker. */
const CACHE_VERSION = 'v1';
const PREFIX = `fynd:cache:${CACHE_VERSION}`;

const seconds = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const SEARCH_TTL_SECONDS = () => seconds('FYND_SEARCH_CACHE_TTL_SECONDS', 30 * 60);
const OFFER_TTL_SECONDS = () => seconds('FYND_OFFER_CACHE_TTL_SECONDS', 2 * 60 * 60);
const NEGATIVE_TTL_SECONDS = () => seconds('FYND_OFFER_NEGATIVE_TTL_SECONDS', 5 * 60);

/* Tests and the benchmark move this forward to watch an entry expire.
   Nothing in api/ ever sets it. */
let clock = () => Date.now();
const setClock = (fn) => { clock = typeof fn === 'function' ? fn : () => Date.now(); };

const enabled = () => String(process.env.FYND_CACHE || '').trim().toLowerCase() !== 'off';

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/* ---------------------------------------------------------
   Keys
   ---------------------------------------------------------
   A key is a digest, so it is a fixed length whatever a shopper typed
   and carries none of it in readable form. It is never returned to a
   browser — see report() — and never logged.
   --------------------------------------------------------- */

/* Key order cannot be allowed to decide identity: two intents with the
   same fields in a different order are the same search. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const digest = (input) => crypto.createHash('sha256').update(input).digest('hex').slice(0, 32);

/* The intent fields a search is made of. Every one of them can change
   what comes back, so every one of them is in the key: a $60 ceiling
   and an $80 ceiling are two different searches, and so are black and
   white, oversized and slim, hoodie and jacket. */
const LIST_FIELDS = ['categories', 'colors', 'occasions', 'fits', 'brands', 'styles', 'keywords'];
const TEXT_FIELDS = ['season', 'gender'];
const PRICE_FIELDS = ['maxPrice', 'minPrice'];

/* Case and spacing are noise — "Black" and " black " are one search.
   Order within a field is NOT noise: the adapter builds its query
   phrase in the order the terms arrive, so ["black","white"] and
   ["white","black"] ask the provider two different questions and must
   not share an answer. Duplicates are dropped the same way the query
   builder drops them, so a repeated term does not fork the key. */
function normalizeIntent(intent) {
  const i = intent && typeof intent === 'object' ? intent : {};
  const out = {};

  for (const field of LIST_FIELDS) {
    const list = Array.isArray(i[field]) ? i[field] : [];
    const seen = new Set();
    const terms = [];
    for (const entry of list) {
      const term = text(entry).toLowerCase();
      if (!term || seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
    }
    out[field] = terms;
  }

  for (const field of TEXT_FIELDS) {
    const value = text(i[field]).toLowerCase();
    out[field] = value || null;
  }

  for (const field of PRICE_FIELDS) {
    const n = Number(i[field]);
    /* to the cent: $79.999 and $80 are the same ceiling to a shopper
       and to the provider, and floats should not fork a key */
    out[field] = Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  return out;
}

/* `context` is whatever the running adapter says changes its results
   beyond the intent — marketplace, language, whether it resolves
   offers. It is asked for rather than assumed, so this file holds no
   knowledge of any one provider's environment variables. */
function searchKey(parts) {
  const p = parts && typeof parts === 'object' ? parts : {};
  const shape = {
    provider: text(p.provider).toLowerCase(),
    limit: Math.floor(Number(p.limit) || 0),
    context: p.context && typeof p.context === 'object' ? p.context : {},
    intent: normalizeIntent(p.intent)
  };
  return `${PREFIX}:search:${digest(stable(shape))}`;
}

/* A product's identity, as the offer lookup sees it: the provider's own
   id for it, in the marketplace it was looked up in. Nothing about the
   shopper or their search is in here — the same product found by two
   different searches is one lookup. */
function offerKey(parts) {
  const p = parts && typeof parts === 'object' ? parts : {};
  const shape = {
    provider: text(p.provider).toLowerCase(),
    productId: text(p.productId),
    country: text(p.country).toLowerCase(),
    language: text(p.language).toLowerCase()
  };
  return `${PREFIX}:offer:${digest(stable(shape))}`;
}

/* ---------------------------------------------------------
   Counters
   ---------------------------------------------------------
   One object per request, passed to whoever reads or writes, so the
   answer to "did this search cost anything" is assembled where it
   happens rather than guessed afterwards.
   --------------------------------------------------------- */

function counters() {
  return {
    searchCache: { hit: 0, miss: 0, stored: 0, coalesced: 0 },
    offerCache: { hit: 0, miss: 0, negativeHit: 0, stored: 0, negativeStored: 0 },
    providerRequestsAvoided: 0
  };
}

/* Folds one set of counters into another. The adapter counts its own
   offer lookups; /api/search counts the search itself and then adds
   them together for one report. */
function merge(into, from) {
  if (!into || !from) return into;
  for (const group of ['searchCache', 'offerCache']) {
    if (!from[group]) continue;
    for (const key of Object.keys(from[group])) {
      into[group][key] = (into[group][key] || 0) + (Number(from[group][key]) || 0);
    }
  }
  into.providerRequestsAvoided += Number(from.providerRequestsAvoided) || 0;
  return into;
}

/* What a shopper's browser is allowed to see: how many times each layer
   answered, and how many provider requests that saved. No key, no
   digest, no intent, nothing a record was stored under. */
function report(stats, extra) {
  const base = stats || counters();
  return Object.assign({
    enabled: enabled(),
    driver: store.driver(),
    searchCache: Object.assign({}, base.searchCache),
    offerCache: Object.assign({}, base.offerCache),
    providerRequestsAvoided: base.providerRequestsAvoided
  }, extra || {});
}

/* ---------------------------------------------------------
   Reading and writing
   ---------------------------------------------------------
   Nothing here throws. A miss and a broken store are the same thing to
   a caller: go and ask the provider.
   --------------------------------------------------------- */

const live = (entry) => Boolean(entry && typeof entry === 'object' && Number(entry.expiresAt) > clock());

async function read(key) {
  if (!enabled()) return null;
  try {
    const entry = await store.get(key);
    if (!entry) return null;
    if (!live(entry)) {
      /* past its stamp: the store's own TTL is late, or the clock moved.
         Dropped rather than served — an expired offer is not an offer. */
      store.remove(key).catch(() => {});
      return null;
    }
    return entry;
  } catch (err) {
    console.warn('Cache read failed; treating as a miss.', err && err.message);
    return null;
  }
}

async function write(key, entry, ttlSeconds) {
  if (!enabled()) return false;
  try {
    await store.set(key, Object.assign({ storedAt: clock(), expiresAt: clock() + ttlSeconds * 1000 }, entry), { ttlSeconds });
    return true;
  } catch (err) {
    console.warn('Cache write failed; the result was not stored.', err && err.message);
    return false;
  }
}

/* One search's records, or null. `providerRequests` was recorded when
   the entry was written: it is what the cold search cost, and therefore
   what this hit just saved. */
async function readSearch(key, stats) {
  const entry = await read(key);
  if (!entry || !Array.isArray(entry.records)) {
    if (stats) stats.searchCache.miss += 1;
    return null;
  }
  if (stats) {
    stats.searchCache.hit += 1;
    stats.providerRequestsAvoided += Number(entry.providerRequests) || 0;
  }
  return { records: entry.records, diagnostics: entry.diagnostics || null };
}

/* Stored only by a caller that has already run the gate and seen real
   products come out of it. */
async function writeSearch(key, payload, stats) {
  const ok = await write(key, {
    records: payload.records,
    diagnostics: payload.diagnostics || null,
    providerRequests: Math.max(0, Math.floor(Number(payload.providerRequests) || 0))
  }, SEARCH_TTL_SECONDS());
  if (ok && stats) stats.searchCache.stored += 1;
  return ok;
}

/* `{ commerce }` for a product whose offer we have, `{ none: true }`
   for one we know has nothing usable, null for one we know nothing
   about. Every hit is one /product-offers request not made. */
async function readOffer(key, stats) {
  const entry = await read(key);
  if (!entry) {
    if (stats) stats.offerCache.miss += 1;
    return null;
  }
  if (stats) stats.providerRequestsAvoided += 1;
  if (entry.none) {
    if (stats) stats.offerCache.negativeHit += 1;
    return { none: true, reason: entry.reason || null };
  }
  if (stats) stats.offerCache.hit += 1;
  return { none: false, commerce: entry.commerce };
}

/* The one offer the adapter picked, whole: the gate reads price,
   retailer and productUrl off this and nothing else is stored. */
async function writeOffer(key, commerce, stats) {
  if (!commerce || typeof commerce !== 'object' || !commerce.productUrl) return false;
  const ok = await write(key, {
    commerce: {
      price: typeof commerce.price === 'number' ? commerce.price : null,
      currency: commerce.currency || undefined,
      retailer: commerce.retailer || '',
      productUrl: commerce.productUrl
    }
  }, OFFER_TTL_SECONDS());
  if (ok && stats) stats.offerCache.stored += 1;
  return ok;
}

/* "The sellers answered, and not one of them gave us a link we could
   show." Only ever called where the provider actually answered. */
async function writeOfferMiss(key, reason, stats) {
  const ok = await write(key, { none: true, reason: text(reason) || 'no-usable-offer' }, NEGATIVE_TTL_SECONDS());
  if (ok && stats) stats.offerCache.negativeStored += 1;
  return ok;
}

/* ---------------------------------------------------------
   Stampede protection
   ---------------------------------------------------------
   A cache miss is the moment every duplicate request is worst: ten
   shoppers asking the same thing in the same second all find nothing,
   all call the provider, and nine of those searches are bought twice.

   So the first one runs and the rest wait on it. In process, because
   that is where the duplicates actually pile up — one warm function
   instance handling a burst — and because a distributed lock brings a
   second failure mode (a holder that dies, a lease that has to be
   renewed) to a problem that does not need one. Losing coalescing
   across instances costs one duplicate provider search per instance in
   the worst case, which is the cost of not having a lock to get wrong.

   Bounded two ways: an entry is removed the moment its promise settles,
   and past MAX_IN_FLIGHT keys nothing is tracked at all and callers
   simply go to the provider. The map can therefore never grow without
   limit and can never hold a promise nobody is waiting on.
   --------------------------------------------------------- */

const MAX_IN_FLIGHT = 64;
const inFlight = new Map();

/* A follower must not be handed the leader's own object: they are two
   requests, and one mutating what the other is reading is a bug waiting
   to be written. The payload is plain JSON by construction. */
const clone = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

/* Resolves to { value, coalesced }. `coalesced` is true for a caller
   that waited on somebody else's provider request rather than making
   its own — which is how the caller knows not to write the cache entry
   the leader is already going to write. */
function coalesce(key, run) {
  if (!enabled() || inFlight.size >= MAX_IN_FLIGHT) {
    return Promise.resolve(run()).then((value) => ({ value, coalesced: false }));
  }

  const waiting = inFlight.get(key);
  if (waiting) return waiting.then((value) => ({ value: clone(value), coalesced: true }));

  const promise = Promise.resolve().then(run);
  inFlight.set(key, promise);
  const forget = () => { if (inFlight.get(key) === promise) inFlight.delete(key); };
  /* both arms, so a failed provider call never leaves a rejected
     promise parked in the map for the next caller to wait on */
  promise.then(forget, forget);

  return promise.then((value) => ({ value, coalesced: false }));
}

/* Tests and the benchmark own the cache's contents; nothing in api/
   calls this. It clears the memory driver, which is the whole cache
   when no Redis is configured. */
function reset() {
  inFlight.clear();
  store.reset();
}

module.exports = {
  CACHE_VERSION,
  PREFIX,
  SEARCH_TTL_SECONDS,
  OFFER_TTL_SECONDS,
  NEGATIVE_TTL_SECONDS,
  MAX_IN_FLIGHT,
  enabled,
  normalizeIntent,
  searchKey,
  offerKey,
  counters,
  merge,
  report,
  readSearch,
  writeSearch,
  readOffer,
  writeOffer,
  writeOfferMiss,
  coalesce,
  setClock,
  reset
};
