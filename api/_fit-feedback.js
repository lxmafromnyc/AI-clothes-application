/* =========================================================
   Fynd — how a size actually fitted, kept for its owner

   One record per account, in the store the accounts use:

     fitfeedback:<user id>   { version, consent, entries }

   Read and changed through /api/fit-profile (?part=feedback, and the
   "feedback-" actions). Each entry says which product and size was tried
   and how it fitted, from fixed lists:

     asExpected       did it fit as expected — yes or no
     issues           what was off: any of too-wide, too-narrow, too-long,
                      too-short (none when it fitted as expected)
     overall, areas   the first form's answers, still accepted
     notes            optional, in the shopper's words (up to 500
                      characters, never logged)
     reference        the fit reference it was compared against, when the
                      shopper says so: a snapshot the server takes from
                      their own saved profile at that moment — never sent
                      by the page

   The product is one of two kinds:
     productId         a product Fynd holds a sizing record for; the size
                       must be one of the record's
     product           { url, brand?, name? } — any other product, named by
                       its own link (a pasted link, or the page the
                       extension read), with `category` the kind of
                       garment. The link is cleaned the way the chart
                       lookup cleans it (api/_sizing/chart.js checkUrl):
                       tracking parameters and fragment dropped, no
                       private address. Its id is "url:" and a hash of
                       that link, so the same product is the same entry.
                       The size is the label the shopper picked from the
                       sizes they compared; with no record to hold it to,
                       it is kept as a short label and nothing more.
   referenceType       optional: which saved garment the comparison used
                       (the extension and Find Fit name it), so the
                       reference snapshot is that garment, not a guess

   One entry per product and size: telling it again for the same size
   updates that entry. A change never moves an entry to another product
   or size; that is a new entry. No photo and no body measurement.

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
const { checkUrl } = require('./_sizing/chart');

const VERSION = 1;
const LIMIT = 100;
const AGGREGATE_MINIMUM = 10;
const key = (userId) => `fitfeedback:${userId}`;

const OVERALL = ['too-small', 'right', 'too-large'];
const ISSUES = ['too-wide', 'too-narrow', 'too-long', 'too-short'];
const NOTES_LIMIT = 500;
const CATEGORIES = ['hoodies', 'sweatshirts', 'tshirts'];
const LABEL_LIMIT = 16;
const TEXT_LIMIT = 120;
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

const cleanText = (raw) => String(raw).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/* One entry, checked against the product's own sizing record. */
function normaliseEntry(input) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const e = isPlainObject(input) ? input : {};

  /* a product Fynd has a record for, or one named by its own link */
  const linked = e.productId === undefined || e.productId === null || (typeof e.productId === 'string' && e.productId.startsWith('url:'))
    ? linkedProduct(e, fail) : null;
  const record = linked ? null : typeof e.productId === 'string' ? sizing.byId(e.productId) : null;
  if (!record && !linked && !errors.length) fail('productId', 'Choose a product Fynd has sizing for, or give the product\'s link.');
  const sizeTried = typeof e.sizeTried === 'string' ? cleanText(e.sizeTried) : '';
  if (record && !record.sizes.includes(sizeTried)) fail('sizeTried', `Choose one of ${record.sizes.join(', ')}.`);
  if (linked && !validLabel(sizeTried)) fail('sizeTried', 'Say which size you bought, as its label says.');
  let recommended = null;
  if (e.recommendedSize !== undefined && e.recommendedSize !== null) {
    if (record && record.sizes.includes(e.recommendedSize)) recommended = e.recommendedSize;
    else if (linked && typeof e.recommendedSize === 'string' && validLabel(cleanText(e.recommendedSize))) recommended = cleanText(e.recommendedSize);
    /* no product to hold it to: that is the one error, not a second */
    else if (record || linked) fail('recommendedSize', 'The suggested size must be one of the product\'s sizes.');
  }
  let referenceType = null;
  if (e.referenceType !== undefined && e.referenceType !== null) {
    if (!CATEGORIES.includes(e.referenceType)) fail('referenceType', `The garment compared with is one of ${CATEGORIES.join(', ')}.`);
    else referenceType = e.referenceType;
  }
  /* how it fitted: as expected or not (and what was off), or the first
     form's overall answer — at least one of them */
  let asExpected = null;
  if (e.asExpected !== undefined && e.asExpected !== null) {
    if (typeof e.asExpected !== 'boolean') fail('asExpected', 'Say whether it fitted as expected: yes or no.');
    else asExpected = e.asExpected;
  }
  let issues = [];
  if (e.issues !== undefined && e.issues !== null) {
    if (!Array.isArray(e.issues) || e.issues.some((x) => !ISSUES.includes(x))) fail('issues', 'What was off: too wide, too narrow, too long or too short.');
    else issues = ISSUES.filter((x) => e.issues.includes(x));
  }
  if (asExpected === true && issues.length) fail('issues', 'It fitted as expected, so nothing was off. Or say it didn’t fit as expected.');
  if (asExpected === false && !issues.length && (e.overall === undefined || e.overall === null)) fail('issues', 'Say what was off: too wide, too narrow, too long or too short.');
  let overall = null;
  if (e.overall !== undefined && e.overall !== null) {
    if (!OVERALL.includes(e.overall)) fail('overall', 'Overall, it was too small, right, or too large.');
    else overall = e.overall;
  }
  if (asExpected === null && overall === null && !errors.some((x) => x.field === 'asExpected' || x.field === 'overall')) fail('asExpected', 'Say whether it fitted as expected.');
  let notes = null;
  if (e.notes !== undefined && e.notes !== null && e.notes !== '') {
    if (typeof e.notes !== 'string') fail('notes', 'Notes are words.');
    else {
      const text = cleanText(e.notes);
      if (text.length > NOTES_LIMIT) fail('notes', `Keep notes to ${NOTES_LIMIT} characters.`);
      else notes = text || null;
    }
  }
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
      productId: record ? record.id : linked.id,
      brand: record ? record.brand : linked.brand,
      category: record ? record.category : linked.category,
      /* a product named by its link keeps the link and the words the page gave it */
      product: record ? null : { url: linked.url, name: linked.name },
      referenceType,
      sizeTried,
      recommendedSize: recommended,
      asExpected,
      issues,
      overall,
      areas,
      notes,
      reference: null,
      createdAt: new Date().toISOString()
    },
    errors: []
  };
}

const validLabel = (t) => typeof t === 'string' && t.length > 0 && t.length <= LABEL_LIMIT;
const shortText = (raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') return undefined;
  const t = cleanText(raw);
  return t.length > TEXT_LIMIT ? undefined : t || null;
};
const linkId = (url) => `url:${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}`;

/* A product Fynd holds no record for, named by its own link: the link
   cleaned as the chart lookup cleans it, the kind of garment, and the
   brand and name only as the page or the shopper gave them. */
function linkedProduct(e, fail) {
  const p = isPlainObject(e.product) ? e.product : null;
  if (!p) { fail('productId', 'Choose a product Fynd has sizing for, or give the product\'s link.'); return null; }
  const checked = checkUrl(p.url);
  if (checked.error) { fail('product.url', 'That isn\'t a product page\'s address.'); return null; }
  const id = linkId(checked.url);
  if (typeof e.productId === 'string' && e.productId !== id) { fail('productId', 'The product\'s id doesn\'t match its link.'); return null; }
  if (!CATEGORIES.includes(e.category)) { fail('category', `Say what kind of garment it is: ${CATEGORIES.join(', ')}.`); return null; }
  const brand = shortText(p.brand);
  const name = shortText(p.name);
  if (brand === undefined) fail('product.brand', `Keep the brand to ${TEXT_LIMIT} characters.`);
  if (name === undefined) fail('product.name', `Keep the product's name to ${TEXT_LIMIT} characters.`);
  if (brand === undefined || name === undefined) return null;
  return { id, url: checked.url, brand, name, category: e.category };
}

/* The fit reference an entry was compared against, as the shopper's own
   profile holds it now: the favourite piece of the product's type (or
   the other fleece top's). Null when there is none. A copy, so a later
   change to the reference never rewrites what this feedback was about. */
const FAMILY = { hoodies: 'fleece', sweatshirts: 'fleece', tshirts: 'tees' };
function referenceSnapshot(profile, category, referenceType) {
  const garments = (profile && profile.garments) || {};
  const usable = (c) => Boolean(garments[c] && garments[c].favorite !== 'none' && garments[c].anchor
    && (garments[c].anchor.measurements || garments[c].anchor.product));
  /* the garment the comparison named, when the shopper's profile still holds it */
  const cat = referenceType ? (usable(referenceType) ? referenceType : null)
    : usable(category) ? category : Object.keys(FAMILY).find((c) => c !== category && FAMILY[c] === FAMILY[category] && usable(c));
  if (!cat) return null;
  const a = garments[cat].anchor;
  return { category: cat, brand: a.brand || null, size: a.size || null, product: a.product || null, measurements: a.measurements || null };
}

/* Adds an entry, or — the same product and size told again — updates
   that one. `options.profile` is the caller's own fit profile, read by
   the endpoint, for the reference snapshot when the entry asks for it. */
async function add(userId, input, options) {
  if (!userId) return { errors: [{ field: 'entry', message: 'Sign in first.' }] };
  const current = await read(userId);
  if (!current.consent.store) {
    return { errors: [{ field: 'consent.store', message: 'Turn on keeping fit feedback first.' }], consentRequired: true };
  }
  const { entry, errors } = normaliseEntry(input);
  if (errors.length) return { errors };
  if (isPlainObject(input) && input.withReference === true) entry.reference = referenceSnapshot(options && options.profile, entry.category, entry.referenceType);
  const same = current.entries.find((x) => x.productId === entry.productId && x.sizeTried === entry.sizeTried);
  if (same) {
    Object.assign(entry, { id: same.id, createdAt: same.createdAt, updatedAt: new Date().toISOString() });
    const updated = current.entries.map((x) => (x.id === same.id ? entry : x));
    const next = { version: VERSION, consent: current.consent, entries: updated };
    await store.set(key(userId), next);
    return { feedback: next, entry, updated: true, errors: [] };
  }
  /* newest first; the oldest drop off past the limit */
  const entries = [entry].concat(current.entries).slice(0, LIMIT);
  const next = { version: VERSION, consent: current.consent, entries };
  await store.set(key(userId), next);
  return { feedback: next, entry, errors: [] };
}

/* Changes one entry, found by id among the caller's own. Its product and
   size are fixed: a different size is a different entry. */
async function update(userId, id, input, options) {
  if (!userId) return { errors: [{ field: 'entry', message: 'Sign in first.' }] };
  const current = await read(userId);
  const existing = current.entries.find((x) => x.id === id);
  if (!existing) return { notFound: true, errors: [{ field: 'id', message: 'No such feedback.' }] };
  const e = isPlainObject(input) ? input : {};
  if ((e.productId !== undefined && e.productId !== existing.productId) || (e.sizeTried !== undefined && e.sizeTried !== existing.sizeTried)) {
    return { errors: [{ field: 'sizeTried', message: 'Feedback stays with the product and size it was given for. For another size, add new feedback.' }] };
  }
  /* a product named by its link stays that product: its link and kind come from the entry, not the request */
  const fixed = existing.product && existing.product.url
    ? { productId: existing.productId, sizeTried: existing.sizeTried, category: existing.category, product: { url: existing.product.url, brand: existing.brand, name: existing.product.name } }
    : { productId: existing.productId, sizeTried: existing.sizeTried };
  /* the garment compared stays named unless the request names another */
  if (e.referenceType === undefined) fixed.referenceType = existing.referenceType || null;
  const { entry, errors } = normaliseEntry(Object.assign({}, e, fixed));
  if (errors.length) return { errors };
  entry.reference = e.withReference === true ? referenceSnapshot(options && options.profile, entry.category, entry.referenceType)
    : e.withReference === false ? null : existing.reference || null;
  Object.assign(entry, { id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
  const entries = current.entries.map((x) => (x.id === id ? entry : x));
  const next = { version: VERSION, consent: current.consent, entries };
  await store.set(key(userId), next);
  return { feedback: next, entry, errors: [] };
}

/* ---------------------------------------------------------
   Reading many accounts' feedback together — for evaluation only

   summarise(records) takes { consent, entries } records, one per
   account, and counts per product and size how many said it fitted as
   expected and what was off. Only accounts that agreed to `improve`
   count, each once per size. A size is `enough` to read only with
   AGGREGATE_MINIMUM accounts; `conflicting` names opposite reports
   (too long and too short, too wide and too narrow) that each come from
   at least a quarter of them. Nothing changes sizing because of it: it
   is for a person to look at.
   --------------------------------------------------------- */
const OPPOSITES = [['too-wide', 'too-narrow'], ['too-long', 'too-short']];
function summarise(records) {
  const sizes = {};
  (records || []).forEach((r) => {
    if (!r || !r.consent || !r.consent.improve) return;
    const seen = new Set();
    (r.entries || []).forEach((e) => {
      const k = `${e.productId}|${e.sizeTried}`;
      if (seen.has(k)) return;
      seen.add(k);
      const s = sizes[k] || (sizes[k] = { productId: e.productId, size: e.sizeTried, accounts: 0, asExpected: 0, notAsExpected: 0, issues: Object.fromEntries(ISSUES.map((x) => [x, 0])) });
      s.accounts += 1;
      if (e.asExpected === true) s.asExpected += 1;
      if (e.asExpected === false) s.notAsExpected += 1;
      (e.issues || []).forEach((x) => { if (s.issues[x] !== undefined) s.issues[x] += 1; });
    });
  });
  return Object.values(sizes).map((s) => Object.assign(s, {
    enough: s.accounts >= AGGREGATE_MINIMUM,
    conflicting: OPPOSITES.filter(([a, b]) => s.issues[a] && s.issues[b] && s.issues[a] * 4 >= s.accounts && s.issues[b] * 4 >= s.accounts).map((pair) => pair.join(' / '))
  }));
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

module.exports = { read, setConsent, add, update, removeEntry, removeAll, normaliseEntry, referenceSnapshot, summarise, linkId, key, OVERALL, ISSUES, AREAS, CATEGORIES, LIMIT, AGGREGATE_MINIMUM, NOTES_LIMIT };
