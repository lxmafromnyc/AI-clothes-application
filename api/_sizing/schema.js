/* =========================================================
   Fynd — product sizing records: their shape, and what they may claim

   One record per product, region and sizing line, in
   api/_sizing/records/*.json. A record holds what the brand itself
   publishes about that product's sizes, and nothing else:

     charts.body      who each size is cut for: body measurements, as a
                      range ("37 ¾ - 41") or a single value ("40") —
                      whichever the brand publishes
     charts.garment   what the finished piece measures, per size

   Two different things, and each chart says which it is (`measures`:
   "body" or "finished-garment"). A body chest and a garment chest are
   never compared directly: a 40 in chest and a 47 in garment are a fit,
   not a mismatch.

   Every dimension names how it was measured (`method`, from the lists
   below — a flat width armpit to armpit is not a circumference; a
   sleeve from the centre back is not one from the shoulder seam) and
   the brand's own words that say so (`methodSource`: a URL on the
   brand's site and what it says). Two measurements are only compared
   when their method is the same.

   ---------------------------------------------------------
   What each value is
   ---------------------------------------------------------
   Each published value keeps the exact text it was copied from, so it
   can be checked against its source. A value the brand does not publish
   is absent — never filled in from a neighbouring size or another
   product. The engine reports every attribute as one of:

     verified     copied from the brand's own page, on a record somebody
                  has checked against its sources
     unverified   copied from the brand's own page, not yet checked
     estimated    worked out from published values by a stated rule
                  (the engine says which), never stored here
     unknown      not published

   A record is "verified" only when `verification.status` is "verified"
   and it names who checked it and when. Nothing in this repository sets
   that: the person checking does, by hand.
   ========================================================= */

'use strict';

const SIZING_VERSION = 2;

const CATEGORIES = ['hoodies', 'sweatshirts'];
/* The lines a product's sizes are cut for. A unisex product also says
   which scale its sizes follow (`sizeScale`). */
const LINES = ['men', 'women', 'unisex'];
const SCALES = ['men', 'women'];
const UNITS = ['in', 'cm'];
/* The brand's own words, mapped to one of these. "loose" is Carhartt's
   word for a cut roomier than relaxed. */
const FIT_CLASSES = ['slim', 'regular', 'relaxed', 'loose', 'oversized'];
const STRETCH = ['none', 'low', 'moderate', 'high'];
const VERIFICATION = ['unverified', 'verified'];
/* the garment each category holds, stored apart from the brand's own
   name for the product */
const GARMENT_TYPES = { hoodies: ['pullover-hoodie'], sweatshirts: ['crewneck-sweatshirt'] };
const MEASURES = { body: 'body', garment: 'finished-garment' };

/* Every dimension a record may hold, and the methods each may be
   measured by. A new category adds its own here (jeans: waist, inseam,
   rise). */
const BODY_DIMENSIONS = {
  chest: { kinds: ['range', 'point'], methods: ['body-circumference'] }
};
const GARMENT_DIMENSIONS = {
  chestWidth: { methods: ['flat-width-armpit-to-armpit', 'garment-circumference'] },
  bodyLength: { methods: ['center-back-to-hem', 'high-point-shoulder-to-hem'] },
  sleeveLength: { methods: ['center-back-to-cuff', 'shoulder-seam-to-cuff'] },
  shoulderWidth: { methods: ['seam-to-seam'] }
};

/* The brands' own sites. A source on any other host is refused. */
const OFFICIAL_HOSTS = {
  UNIQLO: ['www.uniqlo.com', 'faq-us.uniqlo.com'],
  Nike: ['www.nike.com'],
  Carhartt: ['www.carhartt.com']
};

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function officialUrl(brand, url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (OFFICIAL_HOSTS[brand] || []).includes(u.hostname);
  } catch (err) {
    return false;
  }
}

/* Every problem with a record, as { field, message }. An empty list
   means the record may be loaded. */
function validate(record) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  if (!isPlainObject(record)) return [{ field: 'record', message: 'A sizing record is an object.' }];
  const r = record;

  if (r.sizingVersion !== SIZING_VERSION) fail('sizingVersion', `Expected sizingVersion ${SIZING_VERSION}.`);
  if (typeof r.id !== 'string' || !ID.test(r.id)) fail('id', 'The id is lower-case words joined by hyphens.');
  if (!Object.prototype.hasOwnProperty.call(OFFICIAL_HOSTS, r.brand)) fail('brand', `Brand must be one of ${Object.keys(OFFICIAL_HOSTS).join(', ')}.`);
  const product = isPlainObject(r.product) ? r.product : {};
  if (typeof product.name !== 'string' || !product.name) fail('product.name', 'Give the product\'s name as the brand displays it.');
  if (product.pageTitle !== undefined && (typeof product.pageTitle !== 'string' || !product.pageTitle)) fail('product.pageTitle', 'A page title, when kept, is the page\'s own.');
  if (!officialUrl(r.brand, product.url)) fail('product.url', 'The product URL must be on the brand\'s own site.');
  if (!CATEGORIES.includes(r.category)) fail('category', `Category must be one of ${CATEGORIES.join(', ')}.`);
  else if (!GARMENT_TYPES[r.category].includes(product.garmentType)) fail('product.garmentType', `A ${r.category} record's garment type is ${GARMENT_TYPES[r.category].join(' or ')}.`);
  if (typeof r.region !== 'string' || !/^[A-Z]{2}$/.test(r.region)) fail('region', 'Region is a two-letter country code.');
  if (!LINES.includes(r.line)) fail('line', `Line must be one of ${LINES.join(', ')}.`);
  if (!SCALES.includes(r.sizeScale)) fail('sizeScale', `Size scale must be one of ${SCALES.join(', ')}.`);
  if (r.line !== 'unisex' && r.sizeScale !== r.line) fail('sizeScale', 'A men\'s or women\'s product is sized on its own scale.');
  if (!UNITS.includes(r.units)) fail('units', 'Units are in or cm.');

  const sizes = Array.isArray(r.sizes) ? r.sizes : [];
  if (!sizes.length || sizes.some((s) => typeof s !== 'string' || !s) || new Set(sizes).size !== sizes.length) {
    fail('sizes', 'List each size once, smallest first.');
  }

  if (!isPlainObject(r.fit) || !FIT_CLASSES.includes(r.fit.fitClass) || typeof r.fit.brandWords !== 'string') {
    fail('fit', `Give the brand's fit words and a fit class (${FIT_CLASSES.join(', ')}).`);
  }
  if (!isPlainObject(r.material) || (r.material.stretch !== null && !STRETCH.includes(r.material.stretch))) {
    fail('material.stretch', `Stretch is ${STRETCH.join(', ')}, or null when the brand does not say.`);
  }

  const charts = isPlainObject(r.charts) ? r.charts : {};
  if (!charts.body && !charts.garment) fail('charts', 'A record needs a body chart, a garment chart, or both.');
  const checkChart = (kind, table) => {
    const chart = charts[kind];
    if (chart === undefined) return;
    const at = `charts.${kind}`;
    if (!isPlainObject(chart)) { fail(at, 'A chart is an object.'); return; }
    if (chart.measures !== MEASURES[kind]) fail(`${at}.measures`, `A ${kind} chart measures "${MEASURES[kind]}".`);
    if (!officialUrl(r.brand, chart.source)) fail(`${at}.source`, 'A chart\'s source must be on the brand\'s own site.');
    if (!isDate(chart.retrievedAt)) fail(`${at}.retrievedAt`, 'Give the date the chart was read, as YYYY-MM-DD.');
    const dims = isPlainObject(chart.dimensions) ? chart.dimensions : {};
    if (!Object.keys(dims).length) fail(`${at}.dimensions`, 'Name the dimensions the chart holds.');
    Object.entries(dims).forEach(([dim, spec]) => {
      const allowed = table[dim];
      if (!allowed) { fail(`${at}.dimensions.${dim}`, `${dim} is not a ${kind} dimension.`); return; }
      if (!isPlainObject(spec) || !allowed.methods.includes(spec.method)) fail(`${at}.dimensions.${dim}.method`, `Method must be one of ${allowed.methods.join(', ')}.`);
      const src = isPlainObject(spec) && isPlainObject(spec.methodSource) ? spec.methodSource : {};
      if (!officialUrl(r.brand, src.url) || typeof src.says !== 'string' || !src.says) {
        fail(`${at}.dimensions.${dim}.methodSource`, 'Say where the brand states how this was measured: its URL and what it says.');
      }
      if (allowed.kinds && !allowed.kinds.includes(spec.kind)) fail(`${at}.dimensions.${dim}.kind`, `Kind must be one of ${allowed.kinds.join(', ')}.`);
    });
    const rows = isPlainObject(chart.sizes) ? chart.sizes : {};
    Object.keys(rows).forEach((size) => {
      if (!sizes.includes(size)) fail(`${at}.sizes.${size}`, `${size} is not one of this product's sizes.`);
    });
    sizes.forEach((size) => {
      const row = rows[size];
      if (!isPlainObject(row)) return;           /* a size the chart leaves out is unknown */
      Object.entries(row).forEach(([dim, cell]) => {
        const spec = dims[dim];
        const where = `${at}.sizes.${size}.${dim}`;
        if (!spec) { fail(where, `${dim} is not declared in this chart.`); return; }
        if (!isPlainObject(cell) || typeof cell.text !== 'string' || !cell.text) { fail(where, 'Keep the text the value was copied from.'); return; }
        if (spec.kind === 'range') {
          if (!isNumber(cell.min) || !isNumber(cell.max) || cell.min >= cell.max) fail(where, 'A range has a min below its max.');
        } else if (!isNumber(cell.value)) {
          fail(where, 'A value is a positive number.');
        }
      });
    });
  };
  checkChart('body', BODY_DIMENSIONS);
  checkChart('garment', GARMENT_DIMENSIONS);

  const sources = Array.isArray(r.sources) ? r.sources : [];
  if (!sources.length) fail('sources', 'List the sources the record was copied from.');
  sources.forEach((s, i) => {
    if (!isPlainObject(s) || !officialUrl(r.brand, s.url)) fail(`sources.${i}.url`, 'Each source must be on the brand\'s own site.');
    else if (!isDate(s.retrievedAt)) fail(`sources.${i}.retrievedAt`, 'Give the date it was read, as YYYY-MM-DD.');
  });

  if (!isDate(r.retrievedAt)) fail('retrievedAt', 'Give the date the record was read from its sources, as YYYY-MM-DD.');

  const v = isPlainObject(r.verification) ? r.verification : {};
  if (!VERIFICATION.includes(v.status)) fail('verification.status', 'Verification is "unverified" or "verified".');
  if (v.status === 'verified' && (typeof v.checkedBy !== 'string' || !v.checkedBy.trim() || !isDate(v.checkedAt))) {
    fail('verification', 'A verified record names who checked it and the date.');
  }
  return errors;
}

const isVerified = (record) => Boolean(record && record.verification && record.verification.status === 'verified');

module.exports = {
  SIZING_VERSION,
  CATEGORIES,
  LINES,
  FIT_CLASSES,
  STRETCH,
  GARMENT_TYPES,
  BODY_DIMENSIONS,
  GARMENT_DIMENSIONS,
  OFFICIAL_HOSTS,
  validate,
  isVerified
};
