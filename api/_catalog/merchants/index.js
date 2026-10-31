/* =========================================================
   Fynd — the merchants whose own catalogues Find Fit lists

   A merchant is listed only when a person has added it to COMMITTED,
   in a reviewed change, beside its config (./<id>.json) and its
   reviewed catalogue (../data/<id>.json, written by
   scripts/sync-catalog.js --merchant). Each entry is required by name,
   so a deployment bundles exactly the files listed here and nothing
   else. See ../MERCHANTS.md for the whole workflow.

   No merchant is listed yet: no participating merchant has supplied an
   authorized export. Until one does, Find Fit browses UNIQLO only.

   ---------------------------------------------------------
   Test merchants
   ---------------------------------------------------------
   A test points FYND_TEST_MERCHANTS at fixture configs (comma-separated
   paths) and FYND_CATALOG_<ID> at their catalogues (../store.js). They
   are refused:
     - unless the config is marked "fixture": true
     - in a deployment: VERCEL set, or NODE_ENV "production"
   and a committed entry marked as a fixture is refused too. So no test
   merchant, and no test product, can reach a customer.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { createMerchantSource, validateConfig } = require('../sources/merchant');

/* { config: require('./<id>.json'), committed: () => require('../data/<id>.json') } */
const COMMITTED = [];

const deployed = (env) => Boolean(env.VERCEL) || env.NODE_ENV === 'production';

/* entries → sources, every one checked; a refused entry is said and left out */
function fromEntries(entries, { test, log } = {}) {
  const say = log || ((m) => console.error(m));
  const out = [];
  const seen = new Set();
  entries.forEach((e) => {
    const config = e && e.config;
    const id = config && config.id;
    const errors = validateConfig(config);
    if (errors.length) { say(`Merchant ${id || '(unnamed)'} refused: ${errors.map((x) => x.field).join(', ')}`); return; }
    if (config.fixture === true && !test) { say(`Merchant ${id} refused: a fixture is never listed for customers`); return; }
    if (config.fixture !== true && test) { say(`Merchant ${id} refused: a test merchant must be marked as a fixture`); return; }
    if (seen.has(id)) { say(`Merchant ${id} refused: listed twice`); return; }
    seen.add(id);
    out.push(createMerchantSource(config, { committed: e.committed }));
  });
  return out;
}

/* the fixture configs a test named, outside a deployment only */
function testEntries(env) {
  const list = (env.FYND_TEST_MERCHANTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return [];
  if (deployed(env)) {
    console.error('FYND_TEST_MERCHANTS is ignored in a deployment: test merchants are never listed for customers');
    return [];
  }
  return list.map((file) => {
    try { return { config: JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) }; } catch (err) { console.error(`Test merchant ${file} unreadable`); return null; }
  }).filter(Boolean);
}

function load(env) {
  const e = env || process.env;
  return fromEntries(COMMITTED).concat(fromEntries(testEntries(e), { test: true }));
}

const MERCHANTS = load();

module.exports = { MERCHANTS, COMMITTED, fromEntries, testEntries, load, deployed };
