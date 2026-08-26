/* =========================================================
   FindWear — product search

   Takes the structured intent produced by /api/interpret and asks the
   configured product source for real listings. Every record passes the
   verification gate in providers/product-source.js before it is returned,
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
   ========================================================= */

'use strict';

const { getProvider, verifyAll } = require('./providers/product-source');
const { handledPreflight } = require('./_cors');
const { envReport } = require('./_env-report');

const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 12;
const MAX_QUERY = 400;

/* What a shopper is told when a stage fails. Each one says what happened
   and what to do about it; none of them repeats an upstream message, a
   status line or anything else a provider put in a response body. */
const MESSAGES = {
  'rate-limited': 'Fynd is searching more than the product source allows right now. Wait a moment and try again.',
  timeout: 'The product search took too long to answer. Try again in a moment.',
  upstream: 'The product source is having trouble right now. Try again in a moment.',
  unparseable: 'The product source returned something Fynd could not read. Try again in a moment.',
  'not-configured': 'No product source is connected.',
  failed: 'The product source is unavailable right now.'
};

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/* Queries are composed by Fynd from the shopper's request, so a log could
   carry one safely — but it is a shopper's words either way, and a count
   is enough to see whether broadening was the thing that worked. */
const countTerms = (q) => String(q || '').split(/\s+/).filter(Boolean).length;

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
    let done = false;
    /* every path answers exactly once. Destroying the stream on an
       oversized body does not emit 'end', so a promise waiting only for
       that would never settle and the function would sit there until the
       platform killed it. */
    const settle = (value) => { if (!done) { done = true; resolve(value); } };
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20000) { req.destroy(); settle({}); }
    });
    req.on('end', () => { try { settle(JSON.parse(data)); } catch (e) { settle({}); } });
    req.on('error', () => settle({}));
    req.on('close', () => settle({}));
  });
}

module.exports = async function handler(req, res) {
  /* answers the preflight, and refuses an origin that is not allowed */
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

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

  const body = await readBody(req);
  const intent = shapeIntent(body.intent);
  const attachments = shapeAttachments(body.attachments);
  const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  /* What the shopper typed, carried alongside the interpretation. It is
     never trusted as intent — it is a last search phrase to fall back on
     when the interpretation finds nothing, so an interpreter that read
     the request wrongly cannot empty the page on its own. */
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY) : '';

  const started = Date.now();
  let records;
  try {
    records = await provider.search(intent, { limit, query });
  } catch (err) {
    const kind = (err && err.kind) || 'failed';
    /* the kind is ours and safe to send; the message never is */
    console.error('Product source failed', provider.name, kind);
    const status = kind === 'rate-limited' ? 429 : 502;
    return res.status(status).json({
      error: MESSAGES[kind] || MESSAGES.failed,
      reason: kind,
      source: provider.name
    });
  }

  const { products, rejected } = verifyAll(records, { retailer: provider.defaultRetailer });

  /* An adapter may carry a stage-by-stage account of what it did. Without
     one, a search that returns nothing looks identical whether the source
     had no stock, the records could not be parsed, the links could not be
     obtained, or the budget filter took them all. */
  const diagnostics = records && records.diagnostics
    ? Object.assign({}, records.diagnostics, {
      reachedGate: records.length,
      verified: products.length,
      rejected,
      elapsedMs: Date.now() - started
    })
    : null;

  /* One line per search, whatever the outcome, so a deployment can be
     read from its logs rather than guessed at. Everything in it is a
     count, a stage name or a query Fynd itself composed. No product
     field, no response body, no credential, no attachment name — see
     the rule in api/_env-report.js. */
  if (diagnostics) {
    console.log('search', JSON.stringify({
      source: provider.name,
      attempts: (diagnostics.attempts || []).map((a) => ({ terms: countTerms(a.q), returned: a.returned, error: a.error })),
      broadened: diagnostics.broadened,
      returnedByProvider: diagnostics.returnedByProvider,
      normalized: diagnostics.normalized,
      withInlineLink: diagnostics.withInlineLink,
      offerLookups: diagnostics.offers ? diagnostics.offers.lookupsMade : 0,
      offerFailures: diagnostics.offers ? diagnostics.offers.lookupsFailed : 0,
      offerRateLimited: diagnostics.offers ? diagnostics.offers.rateLimited : 0,
      offerTimeouts: diagnostics.offers ? diagnostics.offers.timedOut : 0,
      withAnyLink: diagnostics.withAnyLink,
      droppedOverBudget: diagnostics.droppedOverBudget,
      reachedGate: diagnostics.reachedGate,
      rejected,
      verified: products.length,
      elapsedMs: diagnostics.elapsedMs
    }));
  }

  return res.status(200).json({
    source: provider.name,
    products: products.slice(0, limit),
    /* how many the source returned that could not be verified, and why —
       so a badly behaved provider shows up instead of silently thinning */
    returned: Array.isArray(records) ? records.length : 0,
    rejected,
    diagnostics,
    /* said out loud so an attachment is never mistaken for something
       that shaped these results. It did not. */
    attachments: { received: attachments.length, used: 0, reason: attachments.length ? 'Attachments are not read yet.' : null }
  });
};

module.exports.shapeIntent = shapeIntent;
module.exports.shapeAttachments = shapeAttachments;
