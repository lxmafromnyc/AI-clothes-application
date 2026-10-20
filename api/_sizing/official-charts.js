/* =========================================================
   Fynd — official brand charts, for when a product's page can't be read

   A brand often publishes one chart for a whole category: UNIQLO's
   "Body Size" tab is the same on every US men's and unisex top Fynd has
   copied. When a product's own page can't be read — it never answered,
   or it came back with no size table — and Fynd knows that product
   belongs to such a category, that chart is shown instead, labelled as
   the brand's general chart and as a fallback, never as the product's
   own or as something read just now.

   In order, for one product link:
     1  Fynd's record of exactly that product (chart.js, before any of this)
     2  the product's page, read live (chart.js)
     3  here: a general official chart, only for a product listed by its
        code under a chart whose category and line it belongs to — by
        the chart itself, UNIQLO's category pages (the snapshot), or
        UNIQLO's authorized catalogue (api/_catalog)
     4  otherwise unavailable, with the page's link

   Nothing is guessed from a link alone: an unlisted product, or another
   shop, gets no fallback. Each chart's values are checked, as it loads,
   against the records it was copied from; one that disagrees with any of
   them is left out and reported, never half-used. Body charts never
   become comparable with a garment.
   ========================================================= */

'use strict';

const { byId } = require('./records');
const uniqloSnapshot = require('./brands/uniqlo-snapshot');
const uniqloFeed = require('./brands/uniqlo-feed');
const { CATEGORIES } = require('../_catalog/product');
const schema = require('./schema');

const FILES = [
  require('./official-charts/uniqlo-us-men-tops-body.json')
];

/* Every problem with one chart; an empty list means it may be used. */
function validate(c) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (!c || typeof c !== 'object') return ['not an object'];
  if (!schema.OFFICIAL_HOSTS[c.brand]) fail('unknown brand');
  if (c.measures !== 'body') fail('only body charts are used as a fallback');
  if (!/^[A-Z]{2}$/.test(c.market || '')) fail('market');
  if (!/^(in|cm)$/.test(c.units || '')) fail('units');
  if (!c.label || !/not garment measurements/.test(c.label)) fail('label must say it is not garment measurements');
  if (!Array.isArray(c.sizes) || !c.sizes.length) fail('sizes');
  if (!Array.isArray(c.columns) || !c.columns.length) fail('columns');
  (c.sizes || []).forEach((s) => (c.columns || []).forEach((col) => {
    if (typeof (c.values[s] || {})[col.key] !== 'string') fail(`no ${col.key} for ${s}`);
  }));
  if (!Array.isArray(c.evidence) || !c.evidence.length) fail('evidence');
  (c.evidence || []).forEach((e) => {
    if (!schema.officialUrl(c.brand, e.url)) fail(`evidence ${e.url} is not on ${c.brand}’s own site`);
    const r = byId(e.recordId);
    const body = r && r.charts.body;
    if (!body) { fail(`evidence ${e.recordId}: no such record with a body chart`); return; }
    if (r.brand !== c.brand || r.region !== c.market || r.units !== c.units) fail(`evidence ${e.recordId}: another brand, market or unit`);
    if (!c.appliesTo.categories.includes(r.category) || !c.appliesTo.lines.includes(r.line)) fail(`evidence ${e.recordId}: outside the chart’s categories or lines`);
    c.sizes.forEach((s) => c.columns.forEach((col) => {
      const got = body.sizes[s] && body.sizes[s][col.key];
      if (!got || String(got.text) !== c.values[s][col.key]) fail(`evidence ${e.recordId} disagrees at ${s} ${col.key}`);
    }));
  });
  (c.products || []).forEach((p) => {
    if (!schema.officialUrl(c.brand, p.url)) fail(`product ${p.code}: not on ${c.brand}’s own site`);
    if (!c.appliesTo.categories.includes(p.category) || !c.appliesTo.lines.includes(p.line)) fail(`product ${p.code}: outside the chart’s categories or lines`);
    if (!p.identity) fail(`product ${p.code}: no account of how it is known`);
    /* what is known of the product's own Product Size tab: only that it
       wasn't retrieved, and how that was tried. Garment values never
       live here — they belong in a record of the product (step 1) */
    const ps = p.productSize;
    if (ps !== undefined) {
      const extra = ps && typeof ps === 'object' ? Object.keys(ps).filter((k) => !['status', 'checkedAt', 'tried'].includes(k)) : [];
      if (!ps || ps.status !== 'not-retrieved' || extra.length) fail(`product ${p.code}: productSize may only say it was not retrieved`);
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(ps.checkedAt || '') || !Array.isArray(ps.tried) || !ps.tried.length || !ps.tried.every((t) => typeof t === 'string' && t)) fail(`product ${p.code}: productSize needs its date and what was tried`);
    }
  });
  return errors;
}

const problems = [];
const CHARTS = [];
FILES.forEach((c) => {
  const errors = validate(c);
  if (errors.length) problems.push({ id: c && c.id, errors });
  else CHARTS.push(Object.freeze(c));
});

/* A product from the UNIQLO catalogue snapshot falls under a general
   chart only when UNIQLO's own category page put it in one of the
   chart's categories and lines: "Sweatshirts & Hoodies" covers both. */
const SNAPSHOT_CATEGORIES = { 'sweatshirts-hoodies': ['sweatshirts', 'hoodies'], tshirts: ['tshirts'] };
function covers(chart, product) {
  const cats = SNAPSHOT_CATEGORIES[product.category] || [];
  return chart.brand === 'UNIQLO' && chart.appliesTo.lines.includes(product.line) && cats.some((c) => chart.appliesTo.categories.includes(c));
}
const fromFeed = (p) => ({
  code: p.code, url: p.url, name: p.name, category: p.category, line: p.line,
  identity: `Listed under ${CATEGORIES[p.category] || p.category} for ${p.line} in ${uniqloFeed.LOADED.catalog.sourceName || 'UNIQLO’s authorized product feed'}, updated ${uniqloFeed.LOADED.catalog.lastSuccessfulSync.slice(0, 10)}.`
});
const listedProduct = (snap) => ({
  code: snap.code, url: snap.url, name: snap.name, category: snap.category, line: snap.line,
  identity: `Listed on UNIQLO’s ${snap.categoryLabel || snap.category} page for ${snap.line} (${snap.listedOn}), read ${uniqloSnapshot.SNAPSHOT.fetchedAt || 'from uniqlo.com'}.`
});

/* The general chart that applies to this product, and the product as
   Fynd knows it — or null. Matched by the product's own code in its
   canonical link, on the brand's site, in the chart's market: a product
   the chart names, or one UNIQLO's own category page placed within the
   chart's categories and lines. */
function fallbackFor(checked) {
  if (!checked || !checked.brand || checked.error) return null;
  const code = (/\/products\/(E\d{6}-\d{3})\//.exec(`${checked.url}/`) || [])[1] || null;
  for (const chart of CHARTS) {
    if (chart.brand !== checked.brand || (checked.market && checked.market !== chart.market)) continue;
    const product = (chart.products || []).find((p) => checked.url === p.url || checked.url.startsWith(`${p.url.replace(/\/[^/]*$/, '')}/`));
    if (product) return { chart, product };
    const snap = code && checked.brand === 'UNIQLO' && chart.market === 'US' ? uniqloSnapshot.byCode(code) : null;
    if (snap && checked.url.startsWith('https://www.uniqlo.com/us/') && covers(chart, snap)) return { chart, product: listedProduct(snap) };
    /* or one UNIQLO's authorized catalogue places there, by its exact code */
    const listed = !snap && code && checked.brand === 'UNIQLO' && chart.market === 'US' ? uniqloFeed.byCode(code) : null;
    if (listed && checked.url === listed.url && covers(chart, listed)) return { chart, product: fromFeed(listed) };
  }
  return null;
}

module.exports = { CHARTS, problems, validate, fallbackFor, covers };
