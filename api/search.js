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
  const limit = Math.min(Math.max(Number(body.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  let records;
  try {
    records = await provider.search(intent, { limit });
  } catch (err) {
    console.error('Product source failed', provider.name, err && err.message);
    return res.status(502).json({ error: 'The product source is unavailable right now.', source: provider.name });
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

  return res.status(200).json({
    source: provider.name,
    products: products.slice(0, limit),
    /* how many the source returned that could not be verified, and why —
       so a badly behaved provider shows up instead of silently thinning */
    returned: Array.isArray(records) ? records.length : 0,
    rejected,
    diagnostics
  });
};

module.exports.shapeIntent = shapeIntent;
