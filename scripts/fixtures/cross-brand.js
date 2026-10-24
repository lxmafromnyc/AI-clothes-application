/* =========================================================
   Fynd — test fixtures: UNIQLO and Everlane, for the size engine

   Test data only. Nothing here is loaded by the site, written to
   api/_sizing/records, or marked verified on disk.

   Every measurement keeps where it came from:

     sourceUrl      the page it was published on, or null when the
                    published table wasn't supplied to this suite
     raw            the published text, exactly
     value, unit    that text as a number, in the unit it was published in
     method         how it was measured, as the source states it —
                    "not-stated" when the source doesn't say
     verification   the record's own status ("unverified" until a
                    person checks it against the source)

   UNIQLO: read from the live records for the Sweatshirt (E475377) and
   the Sweat Pullover Hoodie (E475378), copied from uniqlo.com on
   2026-10-10 and pending review. Nothing is copied by hand here.

   Everlane: ILLUSTRATIVE NUMBERS. Everlane's published size table
   wasn't available to this suite (its site can't be reached from the
   test environment, and no copy of the table was supplied), so these
   values are stand-ins chosen to exercise the engine — a chest that
   matches beside a length that doesn't — and are never presented as
   Everlane's. Each is marked `illustrative: true` with no source URL.
   Replace EVERLANE_PUBLISHED with the real table and its URL; the
   tests read whatever it holds.

   Everlane's chest is offered as "chest_circumference". The name alone
   doesn't say how it was measured, so its method is "not-stated" until
   the source says — and a value whose method isn't stated is never
   compared. confirmed(fixture, methods) builds the record as it would
   be IF the source stated those methods: a what-if for testing the
   engine's conversions, named as such in the record itself.
   ========================================================= */

'use strict';

const sizing = require('../../api/_sizing/records');
const sizingSchema = require('../../api/_sizing/schema');

const UQ_SWEATSHIRT = 'uniqlo-e475377-sweatshirt-us';
const UQ_HOODIE = 'uniqlo-e475378-sweat-pullover-hoodie-us';

/* One UNIQLO record's published garment measurements, with provenance,
   straight from the live record. */
function uniqloPublished(id) {
  const r = sizing.byId(id);
  const g = r.charts.garment;
  const sizes = {};
  r.sizes.forEach((size) => {
    const row = g.sizes[size];
    if (!row) return;
    sizes[size] = {};
    Object.keys(row).forEach((d) => {
      sizes[size][d] = {
        sourceUrl: g.source,
        raw: row[d].text,
        value: row[d].value,
        unit: r.units,
        method: g.dimensions[d].method,
        verification: sizingSchema.measurementStatus(r, d)
      };
    });
  });
  return { id, brand: r.brand, product: r.product.name, units: r.units, retrievedAt: g.retrievedAt, verification: r.verification.status, sizes };
}

/* ILLUSTRATIVE — not Everlane's published numbers (see the header).
   Inches. The field names are the proposed fixture's; each says what
   it is published as, and what is (not) known about how it was taken. */
const EVERLANE_PUBLISHED = {
  brand: 'Everlane',
  product: 'Illustrative Everlane crew sweatshirt',
  category: 'sweatshirts',
  line: 'men',
  units: 'in',
  sourceUrl: null,
  illustrative: true,
  verification: 'unverified',
  sizes: {
    S: { chest_circumference: '44 ½', body_length: '28 ½', shoulder_width: '19', sleeve_length: '25' },
    M: { chest_circumference: '47', body_length: '29 ¾', shoulder_width: '20', sleeve_length: '25 ½' },
    L: { chest_circumference: '50', body_length: '31', shoulder_width: '21', sleeve_length: '26' }
  }
};

/* the proposed fixture's field, the engine's dimension */
const EVERLANE_FIELDS = { chest_circumference: 'chestWidth', body_length: 'bodyLength', shoulder_width: 'shoulderWidth', sleeve_length: 'sleeveLength' };

/* "29 ¾" -> 29.75; anything else is refused, never guessed */
function parseInches(text) {
  const m = /^(\d+)(?:\s*([¼½¾]))?$/.exec(String(text).trim());
  if (!m) throw new Error(`not a published inch value: ${text}`);
  return Number(m[1]) + ({ '¼': 0.25, '½': 0.5, '¾': 0.75 }[m[2]] || 0);
}

/* The Everlane fixture with provenance on every measurement. Nothing
   about how each was measured is known, so every method is "not-stated". */
function everlanePublished(source) {
  const f = source || EVERLANE_PUBLISHED;
  const sizes = {};
  Object.entries(f.sizes).forEach(([size, row]) => {
    sizes[size] = {};
    Object.entries(row).forEach(([field, raw]) => {
      sizes[size][EVERLANE_FIELDS[field]] = {
        sourceUrl: f.sourceUrl,
        raw,
        value: parseInches(raw),
        unit: f.units,
        method: 'not-stated',
        publishedAs: field,
        illustrative: Boolean(f.illustrative),
        verification: f.verification
      };
    });
  });
  return { brand: f.brand, product: f.product, category: f.category, line: f.line, units: f.units, sourceUrl: f.sourceUrl, illustrative: Boolean(f.illustrative), verification: f.verification, sizes };
}

/* Everlane isn't one of the brands a production record may come from.
   For a test's duration only, its fixture host is accepted — a reserved
   .invalid name, so a record built here can never pass for a real page —
   and put back however the test ends. */
const FIXTURE_HOST = 'everlane.fixture.invalid';
function withFixtureBrand(fn) {
  const hosts = sizingSchema.OFFICIAL_HOSTS;
  const had = Object.prototype.hasOwnProperty.call(hosts, 'Everlane');
  const before = hosts.Everlane;
  hosts.Everlane = [FIXTURE_HOST];
  const restore = () => { if (had) hosts.Everlane = before; else delete hosts.Everlane; };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

/* A sizing record the engine reads (api/_sizing/schema.js), built from
   the fixture — every value its published text, every method as the
   fixture states it, unless `methods` says what a source would have to
   state (a what-if, recorded on the record as `fixture.methodsAssumed`).
   Never verified: a test that needs a checked record says so itself. */
function everlaneRecord(fixture, methods) {
  const assumed = methods || {};
  const page = `https://${FIXTURE_HOST}/products/illustrative-crew`;
  const dims = {};
  const rows = {};
  Object.entries(fixture.sizes).forEach(([size, row]) => {
    rows[size] = {};
    Object.entries(row).forEach(([d, m]) => {
      const method = assumed[d] || m.method;
      if (!dims[d]) {
        dims[d] = {
          method,
          methodSource: { url: page, says: assumed[d] ? `WHAT-IF: assumed ${method} for this test; the source does not say` : `published as "${m.publishedAs}", with no method stated` }
        };
        if (method === 'flat-width-armpit-to-armpit') dims[d].derivedCircumference = { status: 'estimated', factor: 2, derivation: 'twice the flat width' };
      }
      rows[size][d] = { value: m.value, text: m.raw };
    });
  });
  return {
    sizingVersion: sizingSchema.SIZING_VERSION,
    id: 'fixture-everlane-illustrative-crew',
    brand: 'Everlane',
    product: { name: fixture.product, url: page, garmentType: 'crewneck-sweatshirt' },
    category: fixture.category,
    region: 'US',
    line: fixture.line,
    sizeScale: fixture.line,
    units: fixture.units,
    sizes: Object.keys(fixture.sizes),
    fit: { fitClass: 'regular', brandWords: 'Not stated (fixture)' },
    material: { composition: null, stretch: null },
    charts: { garment: { measures: 'finished-garment', source: page, retrievedAt: '2026-10-24', dimensions: dims, sizes: rows } },
    sources: [{ url: page, retrievedAt: '2026-10-24' }],
    retrievedAt: '2026-10-24',
    fixture: { illustrative: fixture.illustrative, sourceUrl: fixture.sourceUrl, methodsAssumed: Object.keys(assumed).length ? assumed : null },
    verification: { status: 'unverified', checkedBy: null, checkedAt: null }
  };
}

/* the same record, marked checked — in this test's memory only, and named */
function asCheckedCopy(record) {
  return Object.assign(JSON.parse(JSON.stringify(record)), { verification: { status: 'verified', checkedBy: 'Test checker (fixture)', checkedAt: '2026-10-24' } });
}

module.exports = {
  UQ_SWEATSHIRT,
  UQ_HOODIE,
  EVERLANE_PUBLISHED,
  FIXTURE_HOST,
  uniqloPublished,
  everlanePublished,
  everlaneRecord,
  withFixtureBrand,
  asCheckedCopy,
  parseInches
};
