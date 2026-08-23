/* =========================================================
   Fynd — product search

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

   ---------------------------------------------------------
   Live-search metering
   ---------------------------------------------------------
   A live search is the expensive thing Fynd does, so it is the meter
   the interface leads with. Three rules govern it, and all three are
   enforced here rather than in the browser:

     * the allowance is taken before the provider is called, so
       simultaneous requests cannot each pass the same check
     * a search that never reached the provider, or whose provider call
       failed, hands its allowance straight back — a shopper is not
       charged for an outage
     * a repeated submission carrying the same idempotency key is
       answered from the first one's result and charged nothing, so a
       double-click costs one search rather than two

   Every upstream call this endpoint causes is counted against a hard
   per-search cap. See api/_call-budget.js for why counting calls, not
   milliseconds, is what bounds the bill.
   ========================================================= */

'use strict';

const { getProvider, verifyAll } = require('./providers/product-source');
const { handledPreflight } = require('./_cors');
const { envReport } = require('./_env-report');
const { requireAccount } = require('./_accounts');
const { createCallBudget } = require('./_call-budget');
const usage = require('./_usage');

const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 12;

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

module.exports = async function handler(req, res) {
  /* answers the preflight, and refuses an origin that is not allowed */
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  /* who is spending. A missing credential is an anonymous Free caller; a
     credential that does not verify is refused outright. */
  const account = requireAccount(req, res);
  if (!account) return;

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

  /* A resubmission of the same search — a double-click, a retry, a
     reconnect — is recognised before anything is reserved, so it cannot
     take a second allowance. */
  const claim = await usage.claimSubmission(account, headerKey(req) || body.idempotencyKey);

  if (claim.state === 'replay') {
    /* the first attempt already finished: hand back what it produced */
    return res.status(200).json(Object.assign({}, claim.result, {
      duplicate: true,
      duplicateReason: 'This search was already run; the original result is shown and nothing was charged.',
      usage: await usage.snapshot(account)
    }));
  }

  if (claim.state === 'in-flight') {
    /* the first attempt is still running. Answering 409 rather than
       running a second one is the whole point: two live searches is
       exactly what a double-click must not buy. */
    return res.status(409).json({
      error: 'That search is already running.',
      code: 'duplicate_in_flight',
      duplicate: true,
      source: provider.name,
      usage: await usage.snapshot(account)
    });
  }

  /* Take the allowance BEFORE the provider is called. Two simultaneous
     searches cannot both pass this, because the counter is incremented
     atomically and each caller is told its own resulting position. */
  const taken = await usage.reserve(account, 'searches', 1);
  if (!taken.ok) {
    await usage.releaseSubmission(claim);
    return res.status(429).json(Object.assign({ source: 'usage-limit' }, taken.limit));
  }

  /* Every billable upstream call this search makes comes out of here. */
  const callBudget = createCallBudget();

  let records;
  try {
    records = await provider.search(intent, { limit, budget: callBudget });
  } catch (err) {
    console.error('Product source failed', provider.name, err && err.message);
    /* The live search did not happen, so it is not charged. This is the
       rule that keeps an outage from costing a shopper their allowance —
       and the claim is released so their retry is a real attempt. */
    await usage.refund(taken.reservation);
    await usage.releaseSubmission(claim);
    return res.status(502).json({
      error: 'The product source is unavailable right now.',
      source: provider.name,
      charged: false,
      usage: await usage.snapshot(account)
    });
  }

  const { products, rejected } = verifyAll(records, { retailer: provider.defaultRetailer });

  /* An adapter may carry a stage-by-stage account of what it did. Without
     one, a search that returns nothing looks identical whether the source
     had no stock, the records could not be parsed, the links could not be
     obtained, or the budget filter took them all. */
  const diagnostics = records && records.diagnostics
    ? Object.assign({}, records.diagnostics, { reachedGate: records.length, verified: products.length, rejected })
    : null;

  if (!products.length && diagnostics) {
    /* server log only; counts and key names, never a value from a record */
    console.warn('Search verified nothing.', JSON.stringify(diagnostics));
  }

  /* The provider answered, so the search ran and is charged — even if
     nothing passed the gate. The call was made and billed upstream; a
     thin result is not a free one. */
  const answer = {
    source: provider.name,
    products: products.slice(0, limit),
    /* how many the source returned that could not be verified, and why —
       so a badly behaved provider shows up instead of silently thinning */
    returned: Array.isArray(records) ? records.length : 0,
    rejected,
    diagnostics,
    /* what this one search cost upstream, so a cap that is biting is
       visible in the response rather than only in a bill */
    upstreamCalls: callBudget.report(),
    /* said out loud so an attachment is never mistaken for something
       that shaped these results. It did not. */
    attachments: { received: attachments.length, used: 0, reason: attachments.length ? 'Attachments are not read yet.' : null }
  };

  /* stored before the reply, so a retry that overlaps the reply still
     finds the finished result rather than starting a second search */
  await usage.recordSubmission(claim, answer);

  return res.status(200).json(Object.assign({}, answer, {
    /* the browser renders its meter from this and never computes it
       itself, so the number on screen is the number enforced against */
    usage: await usage.snapshot(account)
  }));
};

/* The standard header, preferred over a body field: a proxy or a fetch
   wrapper can carry it without understanding the payload. */
function headerKey(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['idempotency-key'] || headers['x-idempotency-key'];
  return typeof raw === 'string' ? raw.trim() : null;
}

module.exports.shapeIntent = shapeIntent;
module.exports.shapeAttachments = shapeAttachments;
