/* =========================================================
   Fynd — search results, read against the shopper's own Fit Guide

   personalize(profile, items, options) takes the products a search
   returned (api/search.js, from whichever product source answered — any
   brand, any retailer) and says, for each, how much Fynd can honestly
   tell this shopper about its size. It never removes, reorders or hides
   a result: catalogue coverage decides how strong a fit answer is, not
   whether a product can be found.

   ---------------------------------------------------------
   Which part of the Fit Guide applies
   ---------------------------------------------------------
   The garment is read from the listing's own title, else from the
   shopper's search, by word (garmentOf): a hoodie search reads the
   hoodie answers, a T-shirt search the T-shirt answers, jeans the jeans
   answers — never another type's. A reference is the type's own
   favourite piece, else the same family's (a sweatshirt for a hoodie,
   said so); the shopper may choose the other one (referenceCategory).
   Nothing is asked again: only what is saved is read.

   ---------------------------------------------------------
   How strong the answer is — strongest evidence first
   ---------------------------------------------------------
   A listing is matched to one of Fynd's sizing records only by its own
   address: the brand's official site, with that record's product code in
   the path. Never by a similar name, and never across brands.

     strong    a checked record with finished-garment measurements, and
               a reference with measurements (or itself a checked
               product): engine.compare() recommends a size, with the
               differences dimension by dimension
     partial   the same, but too few dimensions compared to recommend
               (the closest size, said as such); or a checked record with
               only a body-size chart — engine.recommend() reads it as
               who each size is cut for, never as what the garment
               measures; or no record, and the shopper's own saved size
               in that brand for that type ("your usual size"), never
               called a recommendation
     none      nothing reliable: the product still shows, and links to
               its shop, with a plain word on why there is no size

   An unchecked record gives no numbers (the engine's own gate). Nothing
   here estimates a measurement, and no brand is given a fit by rule.

   ---------------------------------------------------------
   What a listing can and can't do here
   ---------------------------------------------------------
   Listings are third-party text. Only a few fields are read (address,
   title, brand, retailer), each capped and treated as data: a title is
   matched against a fixed word list and never followed, echoed into an
   instruction, or used to choose code. Every message returned is Fynd's
   own wording, with names taken from Fynd's records, not the listing.
   ========================================================= */

'use strict';

const sizingSchema = require('./schema');
const { RECORDS } = require('./records');
const engine = require('./engine');
const ProfileSchema = require('../../assets/fit-profile-schema.js');

const MAX_ITEMS = 48;
const FAMILY = { hoodies: 'fleece', sweatshirts: 'fleece', tshirts: 'tees' };
const WORDS = { tshirts: 'T-shirt', hoodies: 'hoodie', sweatshirts: 'sweatshirt', pants: 'pants', sweatpants: 'sweatpants', jeans: 'jeans' };
const PLURAL = { tshirts: 'T-shirts', hoodies: 'hoodies', sweatshirts: 'sweatshirts', pants: 'pants', sweatpants: 'sweatpants', jeans: 'jeans' };

/* The Fit Guide type a piece of text names, or null. Order matters: a
   "hooded sweatshirt" is a hoodie, and "sweatpants" are not a
   sweatshirt. */
const GARMENT_WORDS = [
  ['hoodies', /\bhood(?:ie|y|ies|ed)\b|\bzip[- ]?up hood/i],
  ['sweatpants', /\bsweat ?pants?\b|\bjoggers?\b|\btrack ?pants?\b/i],
  /* a crew-neck T-shirt is a T-shirt */
  ['tshirts', /\bt-? ?shirts?\b|\btees?\b/i],
  ['sweatshirts', /\bsweat ?shirts?\b|\bpullover sweat/i],
  /* "crewneck" alone is a sweatshirt; a crew-neck sweater or knit is not */
  ['sweatshirts', (t) => /\bcrew ?necks?\b/i.test(t) && !/\bsweaters?\b|\bjumpers?\b|\bknit|\bcardigans?\b/i.test(t)],
  ['jeans', /\bjeans?\b|\bdenim (?:pants|trousers)\b/i],
  ['pants', /\bpants\b|\btrousers?\b|\bchinos?\b|\bslacks\b/i]
];
function garmentOf(text) {
  const t = typeof text === 'string' ? text.slice(0, 300) : '';
  const hit = GARMENT_WORDS.find(([, rule]) => (typeof rule === 'function' ? rule(t) : rule.test(t)));
  return hit ? hit[0] : null;
}

const brandKey = (name) => ProfileSchema.brandKey(name || '');

/* A listing's address, as a URL, or null. */
function urlOf(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch (err) {
    return null;
  }
}

/* The one sizing record a listing IS, by its address: the record's
   brand's official host and its product code in the path. Exactly one,
   or none — never a guess between two. */
function recordFor(item, pool) {
  const u = urlOf(item.productUrl);
  if (!u) return null;
  const path = u.pathname.toLowerCase();
  const hits = pool.filter((r) => (sizingSchema.OFFICIAL_HOSTS[r.brand] || []).includes(u.hostname.toLowerCase())
    && r.product.code && path.includes(String(r.product.code).split('-')[0].toLowerCase()));
  return hits.length === 1 ? hits[0] : null;
}

/* The brand a listing is, from its brand field or its retailer, matched
   to a brand the shopper has saved a size in — or null. */
const sameBrand = (a, b) => Boolean(a && b && brandKey(a) && brandKey(a) === brandKey(b));

/* the shopper's own saved size in this brand for this type, if any */
function usualSize(profile, category, item) {
  const entry = profile && profile.garments && profile.garments[category];
  const named = [item.brand, item.retailer].filter((x) => typeof x === 'string').map((x) => x.slice(0, 60));
  const a = entry && entry.favorite !== 'none' ? entry.anchor : null;
  if (a && a.size && named.some((n) => sameBrand(n, a.brand))) return { brand: a.brand, size: a.length ? `${a.size} × ${a.length}` : a.size, from: 'fit guide' };
  const usual = ((profile && profile.brandSizes) || []).find((b) => b.category === category && b.size && b.fit === 'about-right' && named.some((n) => sameBrand(n, b.brand)));
  return usual ? { brand: usual.brand, size: usual.size, from: 'usual sizes' } : null;
}

/* what the shopper has saved that a comparison could use, per type */
function referencesIn(profile) {
  const garments = (profile && profile.garments) || {};
  return Object.keys(FAMILY).filter((c) => {
    const e = garments[c];
    return e && e.favorite !== 'none' && e.anchor && (e.anchor.measurements || e.anchor.product);
  }).map((c) => ({ category: c, brand: garments[c].anchor.brand || null, size: garments[c].anchor.size || null, measured: Boolean(garments[c].anchor.measurements) }));
}

const differenceLines = (comparison, size) => {
  const row = comparison.sizes.find((s) => s.size === size);
  return row ? Object.values(row.dimensions).filter((d) => d.compared).map((d) => d.words) : [];
};

/* One listing's fit answer. */
function one(profile, item, query, options) {
  const pool = options.records;
  const record = recordFor(item, pool);
  const category = record ? record.category : (garmentOf(item.name) || garmentOf(query));
  const base = { level: 'none', category, productId: record ? record.id : null, size: null, sizeKind: null, evidence: null, differences: [], reference: null };
  const word = category ? WORDS[category] : null;

  if (record) {
    const verified = sizingSchema.isVerified(record) || options.includeUnverified;
    if (!verified) {
      return Object.assign(base, { label: 'No size yet', detail: `Fynd has ${record.brand}'s size chart for this product, but hasn't checked it yet, so it won't suggest a size from it.` });
    }
    if (record.charts.garment) {
      const c = engine.compare(profile, record, { includeUnverified: options.includeUnverified, referenceCategory: options.referenceCategory });
      if (c.status === 'ok' || c.status === 'partial') {
        const size = c.recommended || c.closest;
        return Object.assign(base, {
          level: c.recommended ? 'strong' : 'partial',
          size,
          sizeKind: c.recommended ? 'recommended' : 'closest',
          evidence: 'verified-garment',
          reliability: c.reliability,
          differences: differenceLines(c, size),
          reference: { category: c.reference.category, brand: c.reference.brand, size: c.reference.size, crossCategory: c.reference.crossCategory },
          compared: c.dimensionsCompared,
          label: c.recommended ? `Suggested size: ${size}` : `Closest size: ${size}`,
          detail: c.recommended
            ? `Compared with your ${WORDS[c.reference.category]}, measurement by measurement, using ${record.brand}'s checked garment measurements.`
            : `Closest to your ${WORDS[c.reference.category]} on ${c.dimensionsCompared.length} of 4 measurements — not enough to recommend a size.`
        });
      }
      const code = c.missing && c.missing[0] && c.missing[0].code;
      if (code === 'no-reference' || code === 'no-reference-measurements') {
        return Object.assign(base, {
          evidence: 'verified-garment',
          label: 'Can be compared',
          detail: `Fynd has ${record.brand}'s checked garment measurements for this product. Save a ${word} that fits you, with its measurements, to compare every size.`,
          action: 'add-reference'
        });
      }
      return Object.assign(base, { label: 'No size yet', detail: c.missing && c.missing[0] ? c.missing[0].message : 'Fynd can\'t compare this product yet.' });
    }
    /* a body-size chart: who each size is cut for, never the garment */
    const r = engine.recommend(profile, record, { includeUnverified: options.includeUnverified });
    if (r.status === 'ok') {
      return Object.assign(base, {
        level: 'partial',
        size: r.leading,
        sizeKind: 'body-chart',
        evidence: 'body-chart',
        reliability: r.confidence,
        label: `Likely size: ${r.leading}`,
        detail: `From ${record.brand}'s body-size chart — who each size is cut for, not what this garment measures — and your Fit Guide. Less certain than a garment comparison.`
      });
    }
    return Object.assign(base, {
      evidence: 'body-chart',
      label: 'No size yet',
      detail: `${record.brand} publishes only a body-size chart for this product, and your Fit Guide doesn't have what it takes to read it (your chest measurement, or a size you wear in a brand Fynd has a chart for).`
    });
  }

  /* not in Fynd's records: the shopper's own saved size, at most */
  if (category) {
    const usual = usualSize(profile, category, item);
    if (usual) {
      return Object.assign(base, {
        level: 'partial',
        size: usual.size,
        sizeKind: 'usual',
        evidence: 'saved-size',
        label: `Your usual ${usual.brand} size: ${usual.size}`,
        detail: `From your ${usual.from === 'fit guide' ? 'Fit Guide' : 'usual sizes'} for ${PLURAL[category]}. Fynd hasn't checked this product's measurements, so it may fit differently.`
      });
    }
  }
  return Object.assign(base, {
    label: 'No size suggestion',
    detail: 'Fynd doesn\'t have reliable sizing for this item yet, so it can\'t suggest a size. Check the size guide at the shop.'
  });
}

/* Read only the fields that matter, each capped; anything else is not
   looked at. */
function shapeItem(raw) {
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const r = raw && typeof raw === 'object' ? raw : {};
  return { productUrl: s(r.productUrl, 2048), name: s(r.name, 300), brand: s(r.brand, 60), retailer: s(r.retailer, 80) };
}

function personalize(profile, rawItems, opts) {
  const options = Object.assign({ includeUnverified: false, records: RECORDS, query: '', referenceCategory: null }, opts || {});
  const query = typeof options.query === 'string' ? options.query.slice(0, 300) : '';
  const items = (Array.isArray(rawItems) ? rawItems : []).slice(0, MAX_ITEMS).map(shapeItem);
  const results = items.map((item) => Object.assign({ productUrl: item.productUrl }, one(profile, item, query, options)));
  const category = garmentOf(query) || (results.find((r) => r.category) || {}).category || null;
  const entry = category && profile && profile.garments ? profile.garments[category] : null;
  return {
    category,
    /* whether the Fit Guide has anything for this type at all */
    fitGuide: Boolean(entry && !ProfileSchema.garmentIsEmpty(entry)),
    /* the references a shopper could switch between for this search */
    references: referencesIn(profile).filter((r) => category && FAMILY[r.category] && FAMILY[r.category] === FAMILY[category]),
    referenceCategory: options.referenceCategory || null,
    counts: { strong: results.filter((r) => r.level === 'strong').length, partial: results.filter((r) => r.level === 'partial').length, none: results.filter((r) => r.level === 'none').length },
    results
  };
}

module.exports = { personalize, garmentOf, recordFor, MAX_ITEMS };
