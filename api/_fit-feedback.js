/* =========================================================
   Fynd — how a size actually fitted, kept for its owner

   One record per account, in the store the accounts use:

     fitfeedback:<user id>   { version, consent, entries }

   Read and changed through /api/fit-profile (?part=feedback, and the
   "feedback-" actions). Each entry says which product and size was tried, how it fitted
   overall, and how it fitted where it matters — all from fixed lists.
   There is no free text, no photo and no body measurement here.

   ---------------------------------------------------------
   Consent first
   ---------------------------------------------------------
     consent.store     keep my fit feedback on my account. Nothing is
                       saved without it; turning it off deletes every
                       entry at once.
     consent.improve   let Fynd use my feedback, without my name or
                       account, to improve product sizing data. Recorded
                       here; nothing reads it yet. When something does,
                       it may use only counts per product and size, and
                       only once at least AGGREGATE_MINIMUM accounts have
                       given feedback on that size.

   Both start off. Like the fit profile, every function takes the user
   id the session resolved to and nothing else names a record; the
   record is deleted with the fit profile and appears in no other
   response. Nothing here logs what an entry says.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const store = require('./_store');
const sizing = require('./_sizing/records');

const VERSION = 1;
const LIMIT = 100;
const AGGREGATE_MINIMUM = 10;
const key = (userId) => `fitfeedback:${userId}`;

const OVERALL = ['too-small', 'right', 'too-large'];
/* the areas a top can be told about, and the words for each */
const AREAS = {
  chest: ['tight', 'right', 'loose'],
  shoulders: ['tight', 'right', 'loose'],
  waist: ['tight', 'right', 'loose'],
  length: ['short', 'right', 'long'],
  sleeves: ['short', 'right', 'long']
};

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const empty = () => ({ version: VERSION, consent: { store: false, improve: false, updatedAt: null }, entries: [] });

async function read(userId) {
  if (!userId) return empty();
  const record = await store.get(key(userId));
  if (!isPlainObject(record) || record.version !== VERSION) return empty();
  return {
    version: VERSION,
    consent: Object.assign({ store: false, improve: false, updatedAt: null }, record.consent),
    entries: Array.isArray(record.entries) ? record.entries : []
  };
}

/* { consent } with only booleans; withdrawing "store" deletes entries. */
async function setConsent(userId, input) {
  if (!userId) return { errors: [{ field: 'consent', message: 'Sign in first.' }] };
  const errors = [];
  const c = isPlainObject(input) ? input : {};
  ['store', 'improve'].forEach((k) => {
    if (c[k] !== undefined && typeof c[k] !== 'boolean') errors.push({ field: `consent.${k}`, message: 'Consent is yes or no.' });
  });
  if (!Object.keys(c).some((k) => k === 'store' || k === 'improve')) errors.push({ field: 'consent', message: 'Say which consent to change.' });
  if (errors.length) return { errors };

  const current = await read(userId);
  const consent = Object.assign({}, current.consent);
  if (c.store !== undefined) consent.store = c.store;
  if (c.improve !== undefined) consent.improve = c.improve;
  /* nothing kept means nothing to use */
  if (!consent.store) consent.improve = false;
  consent.updatedAt = new Date().toISOString();
  const next = { version: VERSION, consent, entries: consent.store ? current.entries : [] };
  await store.set(key(userId), next);
  return { feedback: next, errors: [] };
}

/* One entry, checked against the product's own sizing record. */
function normaliseEntry(input) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const e = isPlainObject(input) ? input : {};

  const record = typeof e.productId === 'string' ? sizing.byId(e.productId) : null;
  if (!record) fail('productId', 'Choose a product Fynd has sizing for.');
  const sizeTried = typeof e.sizeTried === 'string' ? e.sizeTried.trim() : '';
  if (record && !record.sizes.includes(sizeTried)) fail('sizeTried', `Choose one of ${record ? record.sizes.join(', ') : 'its sizes'}.`);
  let recommended = null;
  if (e.recommendedSize !== undefined && e.recommendedSize !== null) {
    if (record && record.sizes.includes(e.recommendedSize)) recommended = e.recommendedSize;
    else fail('recommendedSize', 'The suggested size must be one of the product\'s sizes.');
  }
  if (!OVERALL.includes(e.overall)) fail('overall', 'Overall, it was too small, right, or too large.');
  const areas = {};
  if (e.areas !== undefined) {
    if (!isPlainObject(e.areas)) fail('areas', 'Send the areas as an object.');
    else {
      Object.entries(e.areas).forEach(([area, said]) => {
        if (!AREAS[area]) fail(`areas.${area}`, `Areas are ${Object.keys(AREAS).join(', ')}.`);
        else if (said === null || said === undefined || said === '') return;
        else if (!AREAS[area].includes(said)) fail(`areas.${area}`, `${area} was ${AREAS[area].join(', ')}.`);
        else areas[area] = said;
      });
    }
  }
  if (errors.length) return { entry: null, errors };
  return {
    entry: {
      id: crypto.randomBytes(9).toString('base64url'),
      productId: record.id,
      brand: record.brand,
      category: record.category,
      sizeTried,
      recommendedSize: recommended,
      overall: e.overall,
      areas,
      createdAt: new Date().toISOString()
    },
    errors: []
  };
}

async function add(userId, input) {
  if (!userId) return { errors: [{ field: 'entry', message: 'Sign in first.' }] };
  const current = await read(userId);
  if (!current.consent.store) {
    return { errors: [{ field: 'consent.store', message: 'Turn on keeping fit feedback first.' }], consentRequired: true };
  }
  const { entry, errors } = normaliseEntry(input);
  if (errors.length) return { errors };
  /* newest first; the oldest drop off past the limit */
  const entries = [entry].concat(current.entries).slice(0, LIMIT);
  const next = { version: VERSION, consent: current.consent, entries };
  await store.set(key(userId), next);
  return { feedback: next, entry, errors: [] };
}

async function removeEntry(userId, id) {
  if (!userId) return false;
  const current = await read(userId);
  const entries = current.entries.filter((e) => e.id !== id);
  if (entries.length === current.entries.length) return false;
  await store.set(key(userId), { version: VERSION, consent: current.consent, entries });
  return true;
}

async function removeAll(userId) {
  if (!userId) return false;
  await store.remove(key(userId));
  return true;
}

module.exports = { read, setConsent, add, removeEntry, removeAll, normaliseEntry, key, OVERALL, AREAS, LIMIT, AGGREGATE_MINIMUM };
