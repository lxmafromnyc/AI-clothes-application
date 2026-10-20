#!/usr/bin/env node
/* =========================================================
   Fynd — the Fit panel's reference data, built from Fynd's records

   node scripts/build-fit-references.js           writes assets/fit-reference-data.js
   node scripts/build-fit-references.js --check   exits 1 if that file is stale

   The panel turns "UNIQLO, T-shirt, M" into measurements without a
   product link or a tape measure. It may only do that from measurements
   somebody actually read off a brand's page, so the data is generated
   from api/_sizing/records (each record says where every value came
   from, when, how it is measured, and whether Fynd has checked it) and
   the brand-wide body charts in api/_sizing/official-charts. Nothing is
   typed in here, and nothing is derived: estimates are worked out at
   run time by assets/fit-anchor.js, which says what each rests on.

   The extension carries the file (scripts/sync-extension.js copies it to
   extension/vendor/), so the lookup needs no network and no server.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'fit-reference-data.js');
const { RECORDS } = require('../api/_sizing/records');

/* a record's category → the Fit Anchor's kind of garment */
const CATEGORY = { tshirts: 'tshirt', hoodies: 'sweatshirt', sweatshirts: 'sweatshirt' };

/* a record's measuring method → the Fit Anchor's words for it. A method
   with no entry here is left out rather than guessed. */
const METHOD = {
  'flat-width-armpit-to-armpit': { as: 'flat', factor: 1 },
  'garment-circumference': { as: 'flat', factor: 0.5 },
  'center-back-to-hem': { as: 'back', factor: 1 },
  'high-point-shoulder-to-hem': { as: 'hps', factor: 1 },
  'center-back-to-cuff': { as: 'center-back', factor: 1 },
  'shoulder-seam-to-cuff': { as: 'shoulder-seam', factor: 1 },
  'seam-to-seam': { as: 'seam-to-seam', factor: 1 },
  'broadest-part-of-shoulders': { as: 'broadest', factor: 1 }
};
const CM = 2.54;
const inches = (v, units) => Math.round((units === 'cm' ? v / CM : v) * 1000) / 1000;

function garmentOf(record) {
  const g = record.charts && record.charts.garment;
  if (!g || g.measures !== 'finished-garment' || !g.sizes) return null;
  const methods = {};
  Object.entries(g.dimensions || {}).forEach(([id, d]) => { if (METHOD[d.method]) methods[id] = d.method; });
  const sizes = {};
  Object.entries(g.sizes).forEach(([size, row]) => {
    const dims = {};
    Object.entries(row).forEach(([id, cell]) => {
      const m = METHOD[methods[id]];
      if (!m || !cell || typeof cell.value !== 'number') return;
      dims[id] = { value: inches(cell.value * m.factor, record.units), method: m.as };
    });
    if (Object.keys(dims).length) sizes[size] = dims;
  });
  return Object.keys(sizes).length ? { label: g.label || null, source: g.source || null, retrievedAt: g.retrievedAt || record.retrievedAt, sizes } : null;
}

/* a body chart: chest circumference per size, as published */
function bodyOf(chart, units) {
  if (!chart || chart.measures !== 'body' || !chart.sizes) return null;
  const sizes = {};
  Object.entries(chart.sizes).forEach(([size, row]) => {
    const c = row && row.chest;
    if (!c) return;
    const lo = typeof c.min === 'number' ? c.min : typeof c.value === 'number' ? c.value : null;
    const hi = typeof c.max === 'number' ? c.max : lo;
    if (lo === null) return;
    sizes[size] = { chestLow: inches(lo, units), chestHigh: inches(hi, units) };
  });
  return Object.keys(sizes).length ? sizes : null;
}

function build() {
  const products = [];
  const bodyCharts = new Map();
  RECORDS.slice().sort((a, b) => a.id.localeCompare(b.id)).forEach((r) => {
    const category = CATEGORY[r.category];
    if (!category) return;
    const verification = r.verification && r.verification.status === 'verified' ? 'verified' : 'unverified';
    const garment = garmentOf(r);
    if (garment) {
      products.push({
        id: r.id,
        brand: r.brand,
        category,
        name: r.product.name,
        code: r.product.code || null,
        url: r.product.url,
        audience: r.product.audience || null,
        fit: r.fit && r.fit.fitClass || null,
        verification,
        retrievedAt: r.retrievedAt,
        sources: (r.sources || []).map((s) => ({ url: s.url, what: s.what })),
        garment,
        /* the same product's own body chart, when it publishes one: what
           lets a garment be set beside the body it is cut for */
        body: bodyOf(r.charts.body, r.units)
      });
    }
    const body = bodyOf(r.charts.body, r.units);
    if (body) {
      const key = `${r.brand}|${JSON.stringify(body)}`;
      const entry = bodyCharts.get(key) || {
        brand: r.brand,
        categories: [],
        title: r.charts.body.title || r.charts.body.label || null,
        source: r.charts.body.source || null,
        retrievedAt: r.charts.body.retrievedAt || r.retrievedAt,
        verification,
        records: [],
        sizes: body
      };
      if (!entry.categories.includes(category)) entry.categories.push(category);
      entry.records.push(r.id);
      /* checked by Fynd if any record it was read from has been */
      if (verification === 'verified') entry.verification = 'verified';
      bodyCharts.set(key, entry);
    }
  });
  return {
    note: 'Generated by scripts/build-fit-references.js from api/_sizing/records. Do not edit by hand.',
    products,
    bodyCharts: [...bodyCharts.values()].sort((a, b) => a.brand.localeCompare(b.brand))
  };
}

function render(data) {
  return `/* Generated by scripts/build-fit-references.js from api/_sizing/records —
   do not edit by hand; run the script after changing a record. */
(function (root, factory) {
  const data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  else root.FyndReferenceData = data;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return ${JSON.stringify(data, null, 2).replace(/\n/g, '\n  ')};
});
`;
}

if (require.main === module) {
  const text = render(build());
  if (process.argv.includes('--check')) {
    const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (now !== text) { console.error('assets/fit-reference-data.js is stale: run node scripts/build-fit-references.js'); process.exit(1); }
    console.log('assets/fit-reference-data.js is up to date');
  } else {
    fs.writeFileSync(OUT, text);
    const d = build();
    console.log(`wrote ${path.relative(ROOT, OUT)}: ${d.products.length} products with garment measurements, ${d.bodyCharts.length} body charts`);
  }
}

module.exports = { build, render, OUT };
