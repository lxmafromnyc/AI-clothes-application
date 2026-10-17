/* =========================================================
   Fynd — a size suggestion for one product, from the shopper's own fit
   profile

   GET                      -> { products: [...] }     what Fynd has sizing for
   GET ?product=<id>        -> { recommendation }      for the signed-in shopper
   GET ?product=<id>&compare=1[&unit=in|cm]
                            -> { comparison }          their fit reference beside
                                                       every size (engine.compare)
   POST { action: "personalize", query, items, referenceCategory }
                            -> { personalized }        each search result read against
                                                       the shopper's own Fit Guide
                                                       (api/_sizing/personalize.js)

   The POST changes nothing either. It is a POST only because a page of
   search results does not fit in an address; it still carries the CSRF
   token, like every other request that sends a body. Any other POST is
   refused, as before.

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
const { personalize } = require('./_sizing/personalize');
const { readJson } = require('./_body');
const { csrfOk } = require('./_auth');

const PRODUCT_ID = /^[a-z0-9]+(?:-[a-z0-9]+){0,12}$/;

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Use GET.' });

  res.setHeader('Cache-Control', 'no-store, private');

  const identity = await identify(req, res, users);
  if (!identity.user) {
    return res.status(401).json({ error: 'Sign in to get a size suggestion.', reason: 'sign-in-required' });
  }

  /* ---- search results, against the shopper's Fit Guide ---- */
  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body || body.action !== 'personalize') return res.status(405).json({ error: 'Use GET.' });
    if (identity.sessionToken && !csrfOk(req, identity.sessionToken)) {
      return res.status(403).json({ error: 'Missing or invalid CSRF token.', reason: 'csrf' });
    }
    if (!Array.isArray(body.items)) return res.status(400).json({ error: 'Send the search results as a list.', reason: 'invalid' });
    const referenceCategory = ['hoodies', 'sweatshirts', 'tshirts'].includes(body.referenceCategory) ? body.referenceCategory : null;
    try {
      const { profile, reason } = await fitProfiles.read(identity.user.id);
      if (reason === 'unsupported-version') {
        return res.status(409).json({ error: 'Your fit profile was saved by a newer version of Fynd. Reload the page.', reason });
      }
      return res.status(200).json({ personalized: personalize(profile || null, body.items, { query: body.query, referenceCategory }) });
    } catch (err) {
      console.error('Search personalisation failed', err && err.message);
      return res.status(500).json({ error: 'Could not read these results against your Fit Guide. The results are unaffected.' });
    }
  }

  const query = req.query || Object.fromEntries(new URL(req.url || '/', 'http://fynd.local').searchParams);
  const product = typeof query.product === 'string' ? query.product.trim() : '';

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
};
