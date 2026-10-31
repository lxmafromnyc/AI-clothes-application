/* =========================================================
   Fynd — the committed catalogue for one source, checked as it loads

   scripts/sync-catalog.js writes api/_catalog/data/<source>.json from an
   authorized feed; a person reads the sync report and commits it. This
   reads it back and trusts none of it: every product is checked again
   by the same rules the import used (./product.js), with the licence
   the file records, and a product that fails is left out.

   No file — the state today, since no feed has been authorized — means
   no catalogue: Find Fit lists only the products Fynd sourced itself,
   and says its coverage is limited.

   A file marked as a fixture is refused here unless a test pointed at
   it by name (FYND_CATALOG_<SOURCE>, e.g. FYND_CATALOG_UNIQLO_US), so
   test data can never reach a customer by being committed in its place.

   How old it may be is the source's to say, and is checked on every
   request (freshness), not once:
     older than maxAgeDays          not served at all ("expired")
     older than volatileMaxAgeHours prices and stock not shown
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { normalise, LICENSABLE, isPlain } = require('./product');

const HOUR = 60 * 60 * 1000;

const envName = (adapter) => `FYND_CATALOG_${adapter.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

function readFile(adapter) {
  const named = process.env[envName(adapter)];
  if (named) {
    if (!/\.json$/.test(named)) return { raw: null, error: 'not a .json file' };
    try { return { raw: JSON.parse(fs.readFileSync(path.resolve(named), 'utf8')), test: true }; } catch (err) { return { raw: null, error: err.code === 'ENOENT' ? 'missing' : 'unreadable' }; }
  }
  try {
    /* the adapter's own require, so the deployment bundles the file; a
       .json is only parsed, never run */
    return { raw: adapter.committed(), test: false };
  } catch (err) {
    return { raw: null, error: err && err.code === 'MODULE_NOT_FOUND' ? 'missing' : 'unreadable' };
  }
}

function load(adapter) {
  const none = (state, why) => ({ state, why, products: [], catalog: null });
  const { raw, error, test } = readFile(adapter);
  if (!raw) return none(error === 'missing' ? 'none' : 'invalid', error);
  if (!isPlain(raw) || raw.format !== 'fynd-catalog' || raw.version !== 1 || raw.source !== adapter.id || !Array.isArray(raw.products)) return none('invalid', 'not a Fynd catalogue for this source');
  if (raw.fixture === true && !test) {
    console.error(`Catalogue ${adapter.id}: refusing a fixture catalogue at the customer-facing path`);
    return none('invalid', 'fixture');
  }
  const synced = Date.parse(raw.lastSuccessfulSync);
  if (!Number.isFinite(synced)) return none('invalid', 'no lastSuccessfulSync');
  const licensed = new Set((Array.isArray(raw.licensed) ? raw.licensed : []).filter((f) => LICENSABLE.includes(f)));
  const seen = new Set();
  const products = [];
  let dropped = 0;
  raw.products.slice(0, 50000).forEach((p) => {
    const result = normalise(p, adapter, licensed, { stored: true });
    if (result.error || seen.has(result.product.code)) { dropped += 1; return; }
    seen.add(result.product.code);
    products.push(Object.freeze(result.product));
  });
  if (dropped) console.error(`Catalogue ${adapter.id}: ${dropped} product(s) failed their checks on load and were left out`);
  return {
    state: 'loaded',
    products,
    catalog: {
      sourceName: typeof raw.sourceName === 'string' ? raw.sourceName.slice(0, 120) : null,
      licensed: [...licensed].sort(),
      lastSuccessfulSync: new Date(synced).toISOString(),
      feedComplete: raw.feedComplete === true,
      fixture: raw.fixture === true,
      /* a merchant's own catalogue: whose, and the authorization it was imported under */
      merchant: typeof raw.merchant === 'string' && raw.merchant === adapter.id ? raw.merchant : null,
      authorization: authorizationOf(raw.authorization)
    }
  };
}

/* the authorization a merchant's catalogue records, as plain short strings only */
function authorizationOf(a) {
  if (!isPlain(a)) return null;
  const str = (v) => (typeof v === 'string' ? v.slice(0, 200) : null);
  return {
    grantedBy: str(a.grantedBy),
    reference: str(a.reference),
    grantedAt: str(a.grantedAt),
    expiresAt: str(a.expiresAt),
    licensedFields: (Array.isArray(a.licensedFields) ? a.licensedFields : []).filter((f) => LICENSABLE.includes(f))
  };
}

/* how fresh the loaded catalogue is at `now` */
function freshness(loaded, adapter, now) {
  if (!loaded || loaded.state !== 'loaded') return { served: false, volatile: false, ageHours: null };
  const age = (Number(now || Date.now()) - Date.parse(loaded.catalog.lastSuccessfulSync)) / HOUR;
  /* a sync dated more than a day ahead is a broken clock or a forged file */
  if (age < -24) return { served: false, volatile: false, ageHours: age, why: 'dated in the future' };
  return { served: age <= adapter.maxAgeDays * 24, volatile: age <= adapter.volatileMaxAgeHours, ageHours: age };
}

module.exports = { load, freshness, envName };
