/* =========================================================
   Fynd — a size suggestion for one product, from the shopper's own fit
   profile

   GET                      -> { products: [...] }     what Fynd has sizing for
   GET ?product=<id>        -> { recommendation }      for the signed-in shopper
   GET ?product=<id>&compare=1[&unit=in|cm]
                            -> { comparison }          their fit reference beside
                                                       every size (engine.compare)
   GET ?fit=<type>&items=<JSON [{ brand, name, url }]>
                            -> { fit }                 search results, each matched
                                                       to a sizing record where one
                                                       answers to it, and sized from
                                                       that type's own profile

   The last is the search page's: up to 24 listings it is showing, as
   the listing itself names them (brand, name, link — nothing about the
   shopper). A listing is matched only the way a favourite piece is
   (engine.matchProduct: the brand's own link with the product's code,
   or a name only one record answers to), never guessed; a listing with
   no match is left out of the answer, so the page says nothing about
   its size. Only the type asked for is read from the profile: a jeans
   search is never sized from a hoodie.

   Read-only: it reads the caller's own fit profile and one sizing
   record (api/_sizing), runs api/_sizing/engine.js, and changes
   nothing, so it needs no CSRF token — like reading the fit profile.
   Only the product id travels in the address; nothing about the
   shopper does.

   ---------------------------------------------------------
   Whose profile
   ---------------------------------------------------------
   Always the signed-in caller's, from the session cookie; no id in the
   query or headers is read. Signed out, every request answers 401.
   Answers are no-store, and nothing about the profile or the
   suggestion is logged.

   ---------------------------------------------------------
   Honest by construction
   ---------------------------------------------------------
   A product whose sizing nobody has checked against the brand's own
   chart gets { status: "insufficient", missing: [{ code:
   "unverified-data" }] } — never a size. So does a sizing line the data
   does not cover, or a profile with nothing to measure against.
   ========================================================= */

'use strict';

const { handledPreflight } = require('./_cors');
const { identify } = require('./_auth');
const users = require('./_users');
const fitProfiles = require('./_fit-profile');
const sizing = require('./_sizing/records');
const engine = require('./_sizing/engine');

const ProfileSchema = require('../assets/fit-profile-schema.js');

const PRODUCT_ID = /^[a-z0-9]+(?:-[a-z0-9]+){0,12}$/;
const MAX_ITEMS = 24;
const ITEM_LIMITS = { brand: 80, name: 200, url: 600 };

/* The listings the search page sent, as plain strings within their
   limits, or null for anything that is not that. */
function readItems(raw) {
  if (typeof raw !== 'string' || raw.length > 20000) return null;
  let list;
  try { list = JSON.parse(raw); } catch (err) { return null; }
  if (!Array.isArray(list) || list.length > MAX_ITEMS) return null;
  const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
  return list.map((item) => (item && typeof item === 'object' ? {
    brand: text(item.brand, ITEM_LIMITS.brand),
    name: text(item.name, ITEM_LIMITS.name),
    url: text(item.url, ITEM_LIMITS.url)
  } : { brand: null, name: null, url: null }));
}

/* One matched listing, sized: a comparison with the shopper's reference
   garment where one can be made — and where it is too thin to recommend
   ("partial"), that is the answer, never overruled by a looser reading
   of the same reference — else a suggestion from the rest of the type's
   profile, else what is missing, in the words the engine gave. */
function sizeListing(profile, record) {
  const base = { productId: record.id, product: { brand: record.brand, name: record.product.name }, verified: record.verification && record.verification.status === 'verified' };
  const compared = engine.compare(profile, record);
  if (compared.status === 'ok') {
    return Object.assign(base, { status: 'ok', by: 'reference', size: compared.recommended, alternative: compared.alternative, reliability: compared.reliability, summary: compared.summary, caveats: compared.caveats });
  }
  if (compared.status === 'partial') {
    return Object.assign(base, { status: 'partial', by: 'reference', size: null, closest: compared.closest, reliability: compared.reliability, summary: compared.summary, caveats: compared.caveats });
  }
  const suggested = engine.recommend(profile, record);
  if (suggested.status === 'ok') {
    return Object.assign(base, { status: 'ok', by: 'profile', size: suggested.leading, alternative: suggested.alternative ? suggested.alternative.size : null, reliability: suggested.confidence, summary: suggested.reasons[0] || null, caveats: suggested.caveats || [] });
  }
  const said = new Set();
  const missing = (suggested.missing || []).concat(compared.missing || []).map((m) => m.message).filter((m) => !said.has(m) && said.add(m));
  return Object.assign(base, { status: 'insufficient', size: null, missing, next: [...new Set((suggested.next || []).concat(compared.next || []))] });
}

/* The search page's listings for one type: each matched to a record,
   or left out. Pure — the profile is the caller's, read by the handler. */
function fitFor(profile, type, items) {
  const covered = Boolean(engine.CATEGORY_PARAMS[type]);
  const sized = [];
  if (covered) {
    items.forEach((item, index) => {
      if (!item.url && !item.name) return;
      const match = engine.matchProduct({ brand: item.brand, product: { url: item.url, name: item.name } }, sizing.RECORDS, type);
      if (match) sized.push(Object.assign({ index, matchedBy: match.by }, sizeListing(profile || null, match.record)));
    });
  }
  return { type, covered, items: sized };
}

async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });

  res.setHeader('Cache-Control', 'no-store, private');

  const identity = await identify(req, res, users);
  if (!identity.user) {
    return res.status(401).json({ error: 'Sign in to get a size suggestion.', reason: 'sign-in-required' });
  }

  const query = req.query || Object.fromEntries(new URL(req.url || '/', 'http://fynd.local').searchParams);
  const product = typeof query.product === 'string' ? query.product.trim() : '';

  /* the search page's listings, sized from one type's profile */
  if (query.fit !== undefined) {
    const garment = typeof query.fit === 'string' ? ProfileSchema.garmentOf(query.fit) : null;
    if (!garment) return res.status(400).json({ error: 'Choose a type of clothing.', reason: 'invalid-type' });
    const items = readItems(query.items);
    if (!items) return res.status(400).json({ error: `Send up to ${MAX_ITEMS} listings, each with a brand, name or link.`, reason: 'invalid-items' });
    try {
      const { profile, reason } = await fitProfiles.read(identity.user.id);
      if (reason === 'unsupported-version') {
        return res.status(409).json({ error: 'Your fit profile was saved by a newer version of Fynd. Reload the page.', reason });
      }
      return res.status(200).json({ fit: fitFor(profile, garment.id, items) });
    } catch (err) {
      console.error('Size recommendation failed', err && err.message);
      return res.status(500).json({ error: 'Could not work out a size suggestion. Try again in a moment.' });
    }
  }

  if (!product) {
    return res.status(200).json({ products: sizing.RECORDS.map(sizing.summary) });
  }
  if (!PRODUCT_ID.test(product)) {
    return res.status(400).json({ error: 'That is not a product id.', reason: 'invalid-product' });
  }
  const record = sizing.byId(product);
  if (!record) {
    return res.status(404).json({ error: 'Fynd has no sizing data for that product.', reason: 'unknown-product' });
  }

  try {
    const { profile, reason } = await fitProfiles.read(identity.user.id);
    if (reason === 'unsupported-version') {
      return res.status(409).json({ error: 'Your fit profile was saved by a newer version of Fynd. Reload the page.', reason });
    }
    /* compare before buying: the shopper's own fit reference beside
       every size (engine.compare), in the unit asked for, if any */
    if (query.compare === '1') {
      const unit = query.unit === 'in' || query.unit === 'cm' ? query.unit : undefined;
      return res.status(200).json({ comparison: engine.compare(profile || null, record, { unit }) });
    }
    const recommendation = engine.recommend(profile || null, record);
    return res.status(200).json({ recommendation });
  } catch (err) {
    console.error('Size recommendation failed', err && err.message);
    return res.status(500).json({ error: 'Could not work out a size suggestion. Try again in a moment.' });
  }
}

module.exports = handler;
/* for the interface tests' stand-in server, which has no sessions */
module.exports.fitFor = fitFor;
module.exports.readItems = readItems;
