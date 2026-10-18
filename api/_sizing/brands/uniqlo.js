/* =========================================================
   Fynd — UNIQLO, the first brand Find Fit browses

   The products a shopper can pick from, without pasting a link. Each
   is a real UNIQLO US product that Fynd has read off uniqlo.com
   itself — nothing here is invented, and this is not UNIQLO's whole
   catalogue:

     sizing records    api/_sizing/records (the product's own charts,
                       with their verification status)
     general charts    api/_sizing/official-charts (a product listed
                       under UNIQLO's general body-size chart, used
                       only when its own page can't be read)
     listings          uniqlo-listings.json (a product Fynd has a
                       listing for and nothing more: its chart is
                       looked up live)

   Why not UNIQLO's own site or catalogue? Even where a retailer lets
   its pages be framed, a page in an iframe from another origin can't
   tell Find Fit which product was clicked, so it can't start a lookup
   (scripts/check-embed.js reports what UNIQLO's headers allow, from a
   machine that can reach it). The deployed server's requests to
   uniqlo.com go unanswered, and UNIQLO publishes no open product feed
   or licence for one. So the list is the products Fynd has already
   sourced, and it says so.

   A product is chosen by its code; its address comes from here, never
   from the browser.
   ========================================================= */

'use strict';

const { RECORDS } = require('../records');
const officialCharts = require('../official-charts');
const schema = require('../schema');
const listings = require('./uniqlo-listings.json');

const CODE = /^E\d{6}-\d{3}$/;
const LABELS = { hoodies: 'Hoodies', sweatshirts: 'Sweatshirts', tshirts: 'T-shirts', knitwear: 'Knitwear' };

/* What Fynd holds for a product's sizing, said before anything is
   looked up — never that a chart was read. */
const HOLDS = {
  'checked-chart': 'Fynd has this product’s chart, checked',
  'unchecked-chart': 'Fynd has this product’s chart, not yet checked',
  'general-chart': 'UNIQLO’s general chart only',
  'live-only': 'No saved chart — read from UNIQLO when chosen'
};

function build() {
  const out = new Map();
  const add = (p) => {
    if (!CODE.test(p.code) || !schema.officialUrl('UNIQLO', p.url) || out.has(p.code)) return;
    if (p.imageUrl && !/^https:\/\/image\.uniqlo\.com\//.test(p.imageUrl)) p.imageUrl = null;
    out.set(p.code, Object.freeze(Object.assign(p, { holdsText: HOLDS[p.holds], categoryLabel: LABELS[p.category] || 'Other' })));
  };
  RECORDS.filter((r) => r.brand === 'UNIQLO' && r.region === 'US').forEach((r) => add({
    code: r.product.code, name: r.product.name, url: r.product.url, category: r.category, line: r.line, imageUrl: null,
    holds: schema.isVerified(r) ? 'checked-chart' : 'unchecked-chart', source: `sizing record ${r.id}`
  }));
  officialCharts.CHARTS.filter((c) => c.brand === 'UNIQLO' && c.market === 'US').forEach((c) => (c.products || []).forEach((p) => add({
    code: p.code, name: p.name, url: p.url, category: p.category, line: p.line, imageUrl: null,
    holds: 'general-chart', source: `listed under ${c.id}`
  })));
  listings.products.forEach((p) => add({
    code: p.code, name: p.name, url: p.url, category: p.category, line: p.line, imageUrl: p.imageUrl || null,
    holds: 'live-only', source: p.source
  }));
  return [...out.values()].sort((a, b) => (a.categoryLabel.localeCompare(b.categoryLabel)) || a.name.localeCompare(b.name));
}

const PRODUCTS = build();

module.exports = {
  id: 'uniqlo',
  name: 'UNIQLO',
  market: 'US',
  coverage: `${PRODUCTS.length} UNIQLO US products Fynd has read off uniqlo.com — not UNIQLO’s full range.`,
  products: () => PRODUCTS,
  /* a product by its exact code, or null */
  find: (code) => (typeof code === 'string' && CODE.test(code) ? PRODUCTS.find((p) => p.code === code) || null : null)
};
