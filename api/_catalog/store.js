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
   That override is ignored in a deployment (VERCEL set, or NODE_ENV
   "production"): there, only the committed catalogue is ever read, and
   a committed fixture is refused.

   A merchant's catalogue (sources/merchant.js) is also held to the
   merchant's reviewed config as it stands: refused whole if it claims a
   licensed field the current authorization doesn't cover, is another
   merchant's, or was imported under another agreement; and the
   authorization it is served under is always the config's.

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
/* a deployment: Vercel, or any production process — where a test's
   catalogue override is never honoured */
const deployed = (env) => Boolean(env.VERCEL) || env.NODE_ENV === 'production';

function readFile(adapter, env) {
  const named = env[envName(adapter)];
  if (named && deployed(env)) {
    /* only the committed catalogue, never a file named in the environment */
    console.error(`Catalogue ${adapter.id}: ${envName(adapter)} is ignored in a deployment; only the committed catalogue is read`);
  } else if (named) {
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

/* options.env: the environment to read (the process's by default) */
function load(adapter, options) {
  const env = (options && options.env) || process.env;
  const none = (state, why) => ({ state, why, products: [], catalog: null });
  const { raw, error, test } = readFile(adapter, env);
  if (!raw) return none(error === 'missing' ? 'none' : 'invalid', error);
  if (!isPlain(raw) || raw.format !== 'fynd-catalog' || raw.version !== 1 || raw.source !== adapter.id || !Array.isArray(raw.products)) return none('invalid', 'not a Fynd catalogue for this source');
  if (raw.fixture === true && !test) {
    console.error(`Catalogue ${adapter.id}: refusing a fixture catalogue at the customer-facing path`);
    return none('invalid', 'fixture');
  }
  const synced = Date.parse(raw.lastSuccessfulSync);
  if (!Number.isFinite(synced)) return none('invalid', 'no lastSuccessfulSync');
  /* A merchant's catalogue is held to the merchant's reviewed config as
     it stands now, never to what the file says about itself: refused
     whole — not narrowed — when it claims a field the current
     authorization doesn't cover (so narrowing an authorization takes
     every catalogue imported under the wider one out of service until
     it is imported again), when it is another merchant's, or when it was
     imported under another agreement. */
  if (adapter.merchant) {
    const claimed = Array.isArray(raw.licensed) ? raw.licensed : [];
    const beyond = claimed.filter((f) => !adapter.LICENSED.includes(f));
    if (beyond.length) {
      console.error(`Catalogue ${adapter.id}: refusing a catalogue that claims ${beyond.map((f) => String(f).slice(0, 20)).join(', ')}, beyond the merchant's current authorization`);
      return none('invalid', 'licence-exceeds-authorization');
    }
    if (raw.merchant !== adapter.id) return none('invalid', 'not this merchant\'s catalogue');
    if (!isPlain(raw.authorization) || raw.authorization.reference !== adapter.config.authorization.reference) {
      console.error(`Catalogue ${adapter.id}: refusing a catalogue imported under another authorization than the merchant's current one`);
      return none('invalid', 'authorization-mismatch');
    }
  }
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
      /* a merchant's own catalogue: whose, and the authorization it is
         served under — always the reviewed config's, never the file's */
      merchant: adapter.merchant ? adapter.id : null,
      authorization: adapter.merchant ? authorizationOf(adapter.config.authorization) : null
    }
  };
}

/* an authorization, as plain short strings only */
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

module.exports = { load, freshness, envName, deployed };
