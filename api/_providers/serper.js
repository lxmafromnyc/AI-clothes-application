/* =========================================================
   Fynd — Serper product source (fallback)

   NOT the default, and not a replacement: SerpApi stays the primary
   source and is untouched. This exists for one situation, the one the
   catalogue runs keep hitting — SerpApi's monthly search allowance runs
   out mid-run, every remaining row reports the same 429, and a run that
   was working stops working for a reason that has nothing to do with
   the catalogue.

   Serper (serper.dev) answers the same question from the same index
   through a different account, so discovery can carry on. What it is
   NOT is a softer route to the catalogue. A listing from here goes
   through every gate a SerpApi listing goes through, in the same order,
   with nothing skipped and nothing relaxed:

     the link rule         aggregators, search pages, category pages and
                           redirectors refused by product-source.js
     the semantic gate     the listing has to be the garment the row
                           means, on its title and then on its page
     the four image gates  found in the markup, on the retailer's own
                           host, tied to THIS product, and loadable
     the writer            productUrl, imageUrl and imageEvidence, and
                           nothing else, ever

   A photo that arrives via Serper is written on exactly the evidence a
   photo via SerpApi is written on. Where the candidate came from is not
   evidence of anything and is never recorded as if it were.

   Configure with SERPER_API_KEY. Left unset the adapter reports itself
   unconfigured and discovery carries on saying so, rather than half
   working.

     POST https://google.serper.dev/shopping
     X-API-KEY: <key>
     { "q": "...", "gl": "us", "hl": "en", "num": 20 }

   The response carries a `shopping` array whose entries name the seller
   in `source` and the listing in `link`. As with any Google-derived
   result, `link` is sometimes Google's own and sometimes the shop's —
   which is precisely what the link rule is for, and why nothing here
   tries to repair a URL it was given.
   ========================================================= */

'use strict';

const SEARCH_URL = 'https://google.serper.dev/shopping';
const REQUEST_TIMEOUT = 15000;
const API_LIMIT_MAX = 100;
const OVERFETCH = 2;

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

/* a key must never reach a log or an error message */
function redact(detail) {
  return text(detail).replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');
}

function configured() {
  return Boolean(text(process.env.SERPER_API_KEY));
}

/* The same terms, in the same order, that the primary source is asked
   for. Discovery builds its own single-phrase intents; this keeps a
   hand-built intent readable too. */
const TERM_ORDER = ['gender', 'colors', 'fits', 'styles', 'brands', 'categories', 'occasions', 'keywords'];
const MAX_TERMS = 12;

function queryFrom(intent) {
  const i = intent && typeof intent === 'object' ? intent : {};
  const parts = [];
  for (const field of TERM_ORDER) {
    const value = i[field];
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) parts.push(...value);
  }

  const seen = new Set();
  const terms = [];
  for (const part of parts) {
    const term = text(part).toLowerCase();
    if (!term || term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.join(' ');
}

/* "$34.97" -> 34.97, and anything that is not an amount -> null. No
   figure is ever inferred: a listing with no price keeps none, and the
   display gate drops it rather than showing a guess. */
function toPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = text(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null;
}

function currencyFrom(value) {
  const raw = text(value);
  if (/£/.test(raw)) return 'GBP';
  if (/€/.test(raw)) return 'EUR';
  if (/\$/.test(raw)) return 'USD';
  const named = raw.match(/\b(USD|GBP|EUR|CAD|AUD|JPY)\b/i);
  return named ? named[1].toUpperCase() : null;
}

/* One shopping result, mapped. Absent fields are left absent — the
   verification gate drops a record that is missing what it needs, and
   filling a gap here would be inventing the thing the gate exists to
   catch. Notably there is no brand: Serper does not separate one out,
   and putting the seller's name in that field would be a fabricated
   attribution. */
function toRecord(result) {
  if (!result || typeof result !== 'object') return null;

  const record = {
    title: text(result.title) || undefined,
    productUrl: text(result.link) || undefined,
    imageUrl: text(result.imageUrl) || undefined,
    retailer: text(result.source) || undefined,
    price: toPrice(result.price) || undefined,
    currency: currencyFrom(result.price) || undefined,
    sku: text(result.productId) || undefined
  };

  for (const key of Object.keys(record)) {
    if (record[key] === undefined || record[key] === '') delete record[key];
  }
  return Object.keys(record).length ? record : null;
}

function resultsFrom(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.shopping)) return payload.shopping;
  /* the same array under the name other Serper endpoints use */
  if (Array.isArray(payload.shoppingResults)) return payload.shoppingResults;
  return [];
}

/* Serper's own failures, named rather than swallowed. 429 is the
   account's allowance, which is worth saying out loud for the same
   reason it is worth saying about SerpApi: it is the one failure that
   is not a bug in this adapter. */
async function apiPost(body) {
  const key = text(process.env.SERPER_API_KEY);
  if (!key) throw new Error('SERPER_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const note = response.status === 429 ? ' (Serper search allowance exhausted)' : '';
    throw new Error(`Serper responded ${response.status}${note}: ${redact(detail).slice(0, 200)}`);
  }

  const payload = await response.json();
  if (payload && typeof payload === 'object' && payload.error) {
    throw new Error(`Serper error: ${redact(payload.error).slice(0, 200)}`);
  }
  return payload;
}

async function search(intent, options) {
  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);

  const payload = await apiPost({
    q: queryFrom(intent) || 'clothing',
    gl: text(process.env.SERPER_COUNTRY) || 'us',
    hl: text(process.env.SERPER_LANGUAGE) || 'en',
    num: Math.min(wanted * OVERFETCH, API_LIMIT_MAX)
  });

  const results = resultsFrom(payload);
  const records = results.map(toRecord).filter(Boolean);

  /* the same counted account of what was lost and where, so a search
     that returns nothing says whether the source had nothing or the
     records could not be read */
  records.diagnostics = {
    engine: 'serper-shopping',
    returnedByProvider: results.length,
    normalized: records.length,
    withInlineLink: records.filter((r) => r.productUrl).length
  };
  return records;
}

module.exports = {
  name: 'serper',
  configured,
  search,
  /* exported for scripts/test-serper.js */
  toRecord, queryFrom, toPrice, currencyFrom, resultsFrom, redact, SEARCH_URL
};
