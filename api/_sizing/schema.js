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
   and it names who checked it and when. Only a check against the
   record's sources, approved by the people who own this data, sets it;
   the code never does.

   Who a product is sold to (`product.audience`) is not the same as what
   its chart is called: Nike sells the Club hoodie to men, on a chart it
   titles "Gender Neutral (Men's Based)". A chart keeps its own `title`
   and `designation` when the brand gives one.

   ---------------------------------------------------------
   Each garment measurement, and how far it may be trusted
   ---------------------------------------------------------
   A garment chart's cell is one measurement: its value (positive, a
   physical length — never signed), in the record's `units`, by the
   method its dimension names, from the chart's `source`. Its status is
   worked out, never stored on the cell (measurementStatus, below):

     verified       the record is verified, and nothing below lowers it
     crowdsourced   the chart's numbers were gathered from shoppers'
                    own measurements (`origin: "crowdsourced"`), or the
                    dimension says so (`status: "crowdsourced"`)
     unverified     anything else, including a dimension a reviewer
                    marked `status: "unverified"` on a checked record

   A dimension's `status` can only lower what the record says, never
   raise it: "verified" is not accepted there. Crowdsourced numbers are
   never verified, whoever checked the rest of the record. The size
   engine compares and recommends only from verified measurements.

   The three measurements a comparison rests on most are chestWidth
   (chest width), bodyLength (garment length) and shoulderWidth
   (shoulder width); sleeveLength is the fourth. These are the only
   names: the shopper's fit profile uses the same ones
   (assets/fit-profile-schema.js GARMENT_MEASURES).

   A flat garment width is not a circumference. A record holding one
   says how a circumference is worked out from it
   (`derivedCircumference`: always "estimated", the factor, and why),
   and that worked-out value is never stored.
   ========================================================= */

'use strict';

const SIZING_VERSION = 2;

const CATEGORIES = ['hoodies', 'sweatshirts', 'tshirts'];
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
/* How the sleeves are set, where the brand says (construction.sleeve);
   null when it doesn't. Said beside a comparison, never scored. */
const SLEEVE_TYPES = ['set-in', 'raglan', 'drop-shoulder'];
/* Where a garment chart's numbers come from (charts.garment.origin):
     official-published     the brand's own published finished-garment
                            measurements (every record so far)
     physical-measurement   somebody measured the garment itself, laid
                            flat; names who and when
   Absent reads as official-published. Estimates are never stored. */
/*   crowdsourced           gathered from shoppers' own measurements of
                            the garment; names who gathered them and
                            when, and is never verified */
const ORIGINS = ['official-published', 'physical-measurement', 'crowdsourced'];
/* what one measurement may be called (measurementStatus); a dimension
   may lower its own to one of DIMENSION_STATUSES */
const MEASUREMENT_STATUSES = ['verified', 'crowdsourced', 'unverified'];
const DIMENSION_STATUSES = ['crowdsourced', 'unverified'];
/* the garment each category holds, stored apart from the brand's own
   name for the product */
const GARMENT_TYPES = { hoodies: ['pullover-hoodie'], sweatshirts: ['crewneck-sweatshirt'], tshirts: ['crewneck-tshirt'] };
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
  /* "broadest-part-of-shoulders" is UNIQLO's own instruction ("the length
     between the broadest part of the shoulders"), kept apart from
     seam to seam when the product's table doesn't say seam to seam:
     a drop-shoulder hoodie's broadest point need not be its seams */
  shoulderWidth: { methods: ['seam-to-seam', 'broadest-part-of-shoulders'] }
};

/* How a record's values reached Fynd (`capture.how`). Absent reads as
   "copied-from-page", which is how every record before it was made.
     copied-from-page        copied from the brand's page by whoever made
                             the record
     supplied-transcription  transcribed from the brand's official table
                             by someone else and supplied to Fynd; Fynd
                             didn't read the page itself
     browser-extension       read by the Fynd extension from the page
                             open in a shopper's browser
     server-read             read by Fynd's server from the page
   None of them is a check: a record is verified only by its own
   verification, never by how it was captured. */
const CAPTURES = ['copied-from-page', 'supplied-transcription', 'browser-extension', 'server-read'];

/* The brands' own sites. A source on any other host is refused. */
const OFFICIAL_HOSTS = {
  UNIQLO: ['www.uniqlo.com', 'faq-us.uniqlo.com'],
  Nike: ['www.nike.com'],
  Carhartt: ['www.carhartt.com'],
  'H&M': ['www2.hm.com'],
  Zara: ['www.zara.com']
};

/* How each brand writes a product's code in its own links, around the
   code a record keeps: Zara after a "p" (…-p00761810.html); H&M with a
   three-digit colour after it (productpage.0685816001.html), which a
   record's chart doesn't depend on. Every other brand: the code alone. */
const CODE_FORMS = { Zara: { before: 'p?' }, 'H&M': { after: '(?:\\d{3})?' } };

/* Whether a link's path names this product: its whole code, never part
   of a longer one (K121 is not K1210; E475378 is not E4753780). */
function codeIn(path, brand, code) {
  const form = CODE_FORMS[brand] || {};
  const own = String(code).split('-')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!own) return false;
  return new RegExp(`(?:^|[^a-z0-9])${form.before || ''}${own}${form.after || ''}(?:[^a-z0-9]|$)`).test(String(path).toLowerCase());
}

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
  if (product.audience !== undefined && !LINES.includes(product.audience)) fail('product.audience', `Audience, when kept, is one of ${LINES.join(', ')}.`);
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

  if (r.construction !== undefined) {
    const c = r.construction;
    if (!isPlainObject(c) || (c.sleeve !== null && !SLEEVE_TYPES.includes(c.sleeve))) {
      fail('construction.sleeve', `Sleeves are ${SLEEVE_TYPES.join(', ')}, or null when the brand does not say.`);
    } else if (c.sleeve && (typeof c.source !== 'string' || !c.source)) {
      fail('construction.source', 'Say where the brand describes how the sleeves are set.');
    } else if (c.notes !== undefined && c.notes !== null && (typeof c.notes !== 'string' || !c.notes)) {
      fail('construction.notes', 'Construction notes, when kept, are the brand\'s own words.');
    }
  }

  const charts = isPlainObject(r.charts) ? r.charts : {};
  if (isPlainObject(charts.garment) && charts.garment.origin !== undefined) {
    const g = charts.garment;
    if (!ORIGINS.includes(g.origin)) fail('charts.garment.origin', `Origin is ${ORIGINS.join(' or ')}.`);
    else if ((g.origin === 'physical-measurement' || g.origin === 'crowdsourced') && (typeof g.measuredBy !== 'string' || !g.measuredBy.trim() || !isDate(g.measuredAt))) {
      fail('charts.garment.origin', g.origin === 'crowdsourced'
        ? 'Crowdsourced measurements name who gathered them and the date.'
        : 'A garment measured by hand names who measured it and the date.');
    }
  }
  if (!charts.body && !charts.garment) fail('charts', 'A record needs a body chart, a garment chart, or both.');
  const checkChart = (kind, table) => {
    const chart = charts[kind];
    if (chart === undefined) return;
    const at = `charts.${kind}`;
    if (!isPlainObject(chart)) { fail(at, 'A chart is an object.'); return; }
    if (chart.measures !== MEASURES[kind]) fail(`${at}.measures`, `A ${kind} chart measures "${MEASURES[kind]}".`);
    ['title', 'designation'].forEach((k) => {
      if (chart[k] !== undefined && (typeof chart[k] !== 'string' || !chart[k])) fail(`${at}.${k}`, `A chart's ${k}, when kept, is the brand's own.`);
    });
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
      if (isPlainObject(spec) && spec.method === 'flat-width-armpit-to-armpit') {
        const d = spec.derivedCircumference;
        if (!isPlainObject(d) || d.status !== 'estimated' || d.factor !== 2 || typeof d.derivation !== 'string' || !d.derivation) {
          fail(`${at}.dimensions.${dim}.derivedCircumference`, 'A flat width says how a circumference is worked out from it: status "estimated", factor 2, and the derivation.');
        }
      }
      if (allowed.kinds && !allowed.kinds.includes(spec.kind)) fail(`${at}.dimensions.${dim}.kind`, `Kind must be one of ${allowed.kinds.join(', ')}.`);
      if (isPlainObject(spec) && spec.status !== undefined && (kind !== 'garment' || !DIMENSION_STATUSES.includes(spec.status))) {
        fail(`${at}.dimensions.${dim}.status`, kind !== 'garment'
          ? 'Only a garment measurement keeps its own status.'
          : `A measurement's own status, when kept, is ${DIMENSION_STATUSES.join(' or ')}: only the record's verification makes it verified.`);
      }
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

  if (r.capture !== undefined) {
    const c = r.capture;
    if (!isPlainObject(c) || !CAPTURES.includes(c.how)) fail('capture.how', `How the values reached Fynd is one of ${CAPTURES.join(', ')}.`);
    else if (!isDate(c.at) || typeof c.by !== 'string' || !c.by.trim()) fail('capture', 'Say who captured the values and when.');
  }

  if (!isDate(r.retrievedAt)) fail('retrievedAt', 'Give the date the record was read from its sources, as YYYY-MM-DD.');

  /* what a reviewer still has to check: a record waiting on that check
     is "pending" and can't also be verified */
  if (r.review !== undefined) {
    const rv = r.review;
    if (!isPlainObject(rv) || !['pending', 'done'].includes(rv.status) || typeof rv.needs !== 'string' || !rv.needs) fail('review', 'A review is "pending" or "done", and says what it checks.');
    else if (rv.status === 'pending' && isPlainObject(r.verification) && r.verification.status === 'verified') fail('review', 'A record still pending review can\'t be verified.');
  }

  const v = isPlainObject(r.verification) ? r.verification : {};
  if (!VERIFICATION.includes(v.status)) fail('verification.status', 'Verification is "unverified" or "verified".');
  if (v.status === 'verified' && (typeof v.checkedBy !== 'string' || !v.checkedBy.trim() || !isDate(v.checkedAt))) {
    fail('verification', 'A verified record names who checked it and the date.');
  }
  return errors;
}

const isVerified = (record) => Boolean(record && record.verification && record.verification.status === 'verified');

/* One garment dimension's status (see the header): "verified",
   "crowdsourced" or "unverified"; null when the record has no such
   garment dimension. */
function measurementStatus(record, dim) {
  const chart = record && record.charts && record.charts.garment;
  const spec = chart && chart.dimensions && chart.dimensions[dim];
  if (!spec) return null;
  if (chart.origin === 'crowdsourced' || spec.status === 'crowdsourced') return 'crowdsourced';
  if (spec.status === 'unverified') return 'unverified';
  return isVerified(record) ? 'verified' : 'unverified';
}

/* One size's garment measurement as a whole: { value, unit, method,
   source, status }, read from the record (never stored apart from it),
   or null when the record publishes none for that size. */
function measurementOf(record, size, dim) {
  const chart = record && record.charts && record.charts.garment;
  const cell = chart && chart.sizes && chart.sizes[size] && chart.sizes[size][dim];
  if (!cell || !chart.dimensions[dim]) return null;
  return {
    value: cell.value,
    unit: record.units,
    method: chart.dimensions[dim].method,
    source: { url: chart.source || null, origin: chart.origin || 'official-published', retrievedAt: chart.retrievedAt || null },
    status: measurementStatus(record, dim)
  };
}

module.exports = {
  SIZING_VERSION,
  CATEGORIES,
  LINES,
  FIT_CLASSES,
  STRETCH,
  SLEEVE_TYPES,
  ORIGINS,
  MEASUREMENT_STATUSES,
  CAPTURES,
  GARMENT_TYPES,
  BODY_DIMENSIONS,
  GARMENT_DIMENSIONS,
  OFFICIAL_HOSTS,
  officialUrl,
  codeIn,
  validate,
  isVerified,
  measurementStatus,
  measurementOf
};
