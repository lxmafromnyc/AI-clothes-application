#!/usr/bin/env node
/* =========================================================
   Fynd — a draft sizing record from a chart Fynd actually read

     node scripts/draft-sizing-record.js --url <product link> [--category hoodies --line men]
     node scripts/draft-sizing-record.js --payload <#fynd-chart= value, or a file holding it>
     node scripts/draft-sizing-record.js --chart <a saved /api/size-recommendation chart, as JSON>

   When a product's own page (read by Fynd's server, --url, the same
   lookup Find Fit makes) or the Fynd extension (--payload, what "Open
   in Fynd" carries) gives the product's real size tables, this turns
   them into a draft of a record in the shape api/_sizing/schema.js
   checks, and prints it with what is still missing. Nothing is written
   into api/_sizing/records/, and a draft is never loaded: records.js
   loads only the files it names.

   A draft keeps:
     * the product's identity as the page gave it: brand, name, code,
       canonical link and market — never another product's
     * every published value as its text, and the number read from it
       ("23 ½" → 23.5, "30 ¾ - 33" → 30.75–33); a value that doesn't
       read as a number is kept as text and listed as a problem
     * body and finished-garment tables apart, each with its source and
       the date it was read
     * how each column was measured only as the page said it
       (`pageSays`); `method` is left null for a person to set from the
       brand's own words, with `methodSource`, as every record needs
     * columns Fynd's schema has no dimension for (a waist, an inseam)
       under review.unmapped, with their values, so nothing is lost

   It is always "unverified", with review.status "pending": only a check
   against its official sources, approved by the people who own this
   data, marks a record verified (README, "Size recommendations"); the
   code never does.
   ========================================================= */

'use strict';

const fs = require('fs');
const schema = require('../api/_sizing/schema');

/* A published value as a number: "23 ½", "20 1/2", "51.5" — or null. */
const VULGAR = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
function numberOf(text) {
  const t = String(text).trim();
  let m = /^(\d+(?:\.\d+)?)?\s*([¼½¾⅛⅜⅝⅞])?$/.exec(t);
  if (m && (m[1] || m[2])) return (m[1] ? Number(m[1]) : 0) + (m[2] ? VULGAR[m[2]] : 0);
  m = /^(\d+)\s+(\d)\/(\d{1,2})$/.exec(t);
  if (m && Number(m[3])) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  return null;
}
/* A cell: { value } or { min, max }, with its text; numbers or nulls. */
function cellOf(text) {
  const parts = String(text).split(/\s+[-–—]\s+|(?<=\d)[-–—](?=\d)/);
  if (parts.length === 2) {
    const [min, max] = parts.map(numberOf);
    return { min, max, text: String(text) };
  }
  return { value: numberOf(text), text: String(text) };
}

/* The schema's dimension a column is, by its own heading, or null.
   Only the dimension: how it was measured is for a person to set. */
const GARMENT_KEYS = [
  [/\b(chest|bust|body width|pit to pit|armpit to armpit)\b/i, 'chestWidth'],
  [/\bsleeve\b/i, 'sleeveLength'],
  [/\bshoulders?\b/i, 'shoulderWidth'],
  [/\b(body )?length\b/i, 'bodyLength']
];
const BODY_KEYS = [[/\b(chest|bust)\b/i, 'chest']];
const keyOf = (column, keys) => (keys.find(([re]) => re.test(column)) || [])[1] || null;

function chartOf(c, kind, sizes, unmapped) {
  const keys = kind === 'body' ? BODY_KEYS : GARMENT_KEYS;
  const dims = {};
  const rows = {};
  c.columns.forEach((col, j) => {
    const key = keyOf(col, keys);
    if (!key || dims[key]) {
      unmapped.push({ chart: kind, column: col, values: Object.fromEntries(c.rows.map((r) => [r.size, r.values[j]])) });
      return;
    }
    const pageSays = c.methods && c.methods[j] ? c.methods[j] : null;
    dims[key] = kind === 'body'
      ? { label: col, kind: c.rows.some((r) => /\d\s*[-–—]\s*\d/.test(r.values[j])) ? 'range' : 'point', method: null, methodSource: null }
      : { label: col, method: null, methodSource: null, pageSays };
    c.rows.forEach((r) => {
      if (!r.values[j]) return;            /* not published for this size: absent */
      rows[r.size] = rows[r.size] || {};
      rows[r.size][key] = cellOf(r.values[j]);
    });
  });
  sizes.forEach((s) => { if (!rows[s]) delete rows[s]; });
  return {
    measures: kind === 'body' ? 'body' : 'finished-garment',
    label: c.title || (kind === 'body' ? 'Body size chart' : 'Product size chart'),
    source: c.source && c.source.url,
    retrievedAt: null,
    dimensions: dims,
    sizes: rows
  };
}

const slug = (v) => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* A draft record from one chart answer (as /api/size-recommendation
   gives it, or as the extension's payload draws). `opts`: category,
   line, sizeScale, garmentType, when a person knows them. */
function draftFrom(answer, opts) {
  const o = opts || {};
  const problems = [];
  if (!answer || answer.status !== 'ok' || !(answer.charts || []).length) {
    return { draft: null, problems: [`No chart to draft from: ${answer ? answer.status : 'nothing'}${answer && answer.reason ? ` (${answer.reason})` : ''}.`] };
  }
  const read = (answer.source && answer.source.retrievedAt) || new Date().toISOString().slice(0, 10);
  const garment = answer.charts.find((c) => c.measures === 'finished-garment');
  const body = answer.charts.find((c) => c.measures === 'body');
  answer.charts.filter((c) => c.measures === 'not-stated').forEach((c) => problems.push(`A table whose page doesn’t say body or garment was left out: ${c.columns.join(', ')}.`));
  if (!garment && !body) return { draft: null, problems: problems.concat('No table says whether it measures the body or the garment, so there is nothing to record.') };
  /* the chart's own sizes, in its order: the product's, as published */
  const sizes = [];
  [garment, body].filter(Boolean).forEach((c) => c.rows.forEach((r) => { if (!sizes.includes(r.size)) sizes.push(r.size); }));
  const unmapped = [];
  const charts = {};
  if (garment) charts.garment = Object.assign(chartOf(garment, 'garment', sizes, unmapped), { retrievedAt: read });
  if (body) charts.body = Object.assign(chartOf(body, 'body', sizes, unmapped), { retrievedAt: read });
  const product = answer.product || {};
  const brand = product.brand || answer.retailer || null;
  const url = answer.source && answer.source.url;
  const market = answer.market || null;
  const units = [garment, body].filter(Boolean).map((c) => c.unit);
  const draft = {
    sizingVersion: schema.SIZING_VERSION,
    id: [slug(brand), slug(product.code), slug(product.name), slug(market)].filter(Boolean).join('-'),
    brand,
    product: { name: product.name || null, code: product.code || null, url, garmentType: o.garmentType || null },
    category: o.category || null,
    region: market,
    line: o.line || null,
    sizeScale: o.sizeScale || (o.line && o.line !== 'unisex' ? o.line : null),
    units: units.every((u) => u === units[0]) && (units[0] === 'in' || units[0] === 'cm') ? units[0] : null,
    sizes,
    fit: null,
    material: null,
    charts,
    sources: url ? [{ url, what: `Size tables read ${answer.from === 'browser-extension' ? 'by the Fynd extension in a shopper’s browser' : 'by Fynd’s server'}`, retrievedAt: read }] : [],
    retrievedAt: read,
    verification: { status: 'unverified' },
    review: {
      status: 'pending',
      draftedBy: 'scripts/draft-sizing-record.js',
      draftedAt: new Date().toISOString().slice(0, 10),
      readFrom: answer.from || null,
      unmapped
    }
  };
  if (units.some((u) => u !== units[0])) problems.push(`The tables give different units (${units.join(', ')}); a record holds one.`);
  if (!draft.units) problems.push('No unit is stated by the page: a person must confirm it from the source.');
  /* everything the schema still refuses, in its words: the person's checklist */
  schema.validate(draft).forEach((e) => problems.push(`${e.field}: ${e.message}`));
  unmapped.forEach((u) => problems.push(`Column “${u.column}” (${u.chart}) has no dimension in the schema; kept under review.unmapped.`));
  draft.review.todo = problems.slice();
  return { draft, problems };
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const opts = { category: arg('--category'), line: arg('--line'), sizeScale: arg('--size-scale'), garmentType: arg('--garment-type') };
    let answer;
    if (arg('--url')) {
      answer = await require('../api/_sizing/chart').chartFor(arg('--url'), { noCache: true });
    } else if (arg('--payload')) {
      const Payload = require('../assets/fynd-payload');
      let raw = arg('--payload');
      if (fs.existsSync(raw)) raw = fs.readFileSync(raw, 'utf8').trim();
      raw = raw.replace(/^.*#fynd-chart=/, '');
      const got = Payload.decode(raw);
      if (got.error) { console.error(`Not a Fynd extension chart: ${got.error}`); process.exit(1); }
      answer = Payload.toChart(got.payload);
    } else if (arg('--chart')) {
      const saved = JSON.parse(fs.readFileSync(arg('--chart'), 'utf8'));
      answer = saved.chart || saved;
    } else {
      console.error('Give --url, --payload or --chart. See the top of this file.');
      process.exit(2);
    }
    if (answer && answer.from === 'fynd-record') {
      console.error(`Fynd already has a record of this product: ${answer.productId}. Nothing drafted.`);
      process.exit(1);
    }
    const { draft, problems } = draftFrom(answer, opts);
    if (draft) console.log(JSON.stringify(draft, null, 2));
    console.error(`\n${problems.length ? `Still to do before this can be a record (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}` : 'Nothing missing — still unverified until a person checks it.'}`);
    process.exit(draft ? 0 : 1);
  })();
}

module.exports = { draftFrom, numberOf, cellOf };
