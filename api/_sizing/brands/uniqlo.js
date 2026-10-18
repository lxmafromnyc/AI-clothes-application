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
     the snapshot      uniqlo-catalog.json, when there is one: the
                       products on UNIQLO's own US category pages, read
                       by scripts/fetch-uniqlo-catalog.js and checked as
                       it loads (uniqlo-snapshot.js)

   Where else could the list come from? UNIQLO publishes no product
   API, feed or affiliate catalogue. Its own site is the source, and it
   can't be read from where Fynd runs: on 18 October 2026, from GitHub's
   runners, www.uniqlo.com accepted the connection and then reset every
   request — robots.txt included, under curl's own user agent and
   Fynd's — and the deployed server's requests go unanswered too. Fynd
   doesn't disguise itself to get past that. image.uniqlo.com does
   answer, which is where the photos (uniqlo-photos.json) come from.
   A page in a frame can't tell Find Fit which product was clicked, so
   UNIQLO's site in an iframe couldn't start a lookup either.

   scripts/fetch-uniqlo-catalog.js reads UNIQLO's US category pages from
   any machine uniqlo.com does answer, and writes uniqlo-catalog.json;
   this module lists every product in it, with no change anywhere else.

   A product is chosen by its code; its address comes from here, never
   from the browser.
   ========================================================= */

'use strict';

const { RECORDS } = require('../records');
const officialCharts = require('../official-charts');
const schema = require('../schema');
const listings = require('./uniqlo-listings.json');
const { SNAPSHOT } = require('./uniqlo-snapshot');
const { photos: PHOTOS } = require('./uniqlo-photos.json');

const CODE = /^E\d{6}-\d{3}$/;
/* the filter a product sits under: records' own categories and the
   snapshot's category pages, grouped the way UNIQLO's pages group them */
const GROUPS = {
  hoodies: ['sweatshirts-hoodies', 'Sweatshirts & Hoodies'],
  sweatshirts: ['sweatshirts-hoodies', 'Sweatshirts & Hoodies'],
  'sweatshirts-hoodies': ['sweatshirts-hoodies', 'Sweatshirts & Hoodies'],
  tshirts: ['tshirts', 'T-shirts'],
  knitwear: ['knitwear', 'Sweaters & Cardigans'],
  shirts: ['shirts', 'Shirts']
};

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
    /* a photo only from UNIQLO's image host, at an address carrying the
       product's own code */
    if (!p.imageUrl && PHOTOS[p.code]) p.imageUrl = PHOTOS[p.code];
    if (p.imageUrl && !(/^https:\/\/image\.uniqlo\.com\//.test(p.imageUrl) && p.imageUrl.includes(p.code.slice(1, 7)))) p.imageUrl = null;
    const [group, groupLabel] = GROUPS[p.category] || ['other', 'Other'];
    out.set(p.code, Object.freeze(Object.assign(p, { holdsText: HOLDS[p.holds], group, categoryLabel: groupLabel })));
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
  /* the snapshot last: a product already known keeps what Fynd holds
     for it, and gains the snapshot's photo when it had none */
  SNAPSHOT.products.forEach((p) => {
    const known = out.get(p.code);
    if (known) {
      if (!known.imageUrl && p.imageUrl) out.set(p.code, Object.freeze(Object.assign({}, known, { imageUrl: p.imageUrl })));
      return;
    }
    const general = officialCharts.CHARTS.some((c) => c.market === 'US' && officialCharts.covers(c, p));
    add({ code: p.code, name: p.name, url: p.url, category: p.category, line: p.line, imageUrl: p.imageUrl,
      holds: general ? 'general-chart' : 'live-only', source: `listed on ${p.listedOn}` });
  });
  /* what Fynd holds most first: a checked chart, then the rest */
  const rank = { 'checked-chart': 0, 'unchecked-chart': 1, 'general-chart': 2, 'live-only': 3 };
  return [...out.values()].sort((a, b) => (rank[a.holds] - rank[b.holds]) || a.categoryLabel.localeCompare(b.categoryLabel) || a.name.localeCompare(b.name));
}

const PRODUCTS = build();

module.exports = {
  id: 'uniqlo',
  name: 'UNIQLO',
  market: 'US',
  coverage: SNAPSHOT.products.length
    ? `${PRODUCTS.length} UNIQLO US products, as listed on uniqlo.com’s own category pages on ${SNAPSHOT.fetchedAt} — not UNIQLO’s full range.`
    : `${PRODUCTS.length} UNIQLO US products Fynd has read off uniqlo.com — not UNIQLO’s full range.`,
  snapshotAt: SNAPSHOT.fetchedAt,
  products: () => PRODUCTS,
  /* a product by its exact code, or null */
  find: (code) => (typeof code === 'string' && CODE.test(code) ? PRODUCTS.find((p) => p.code === code) || null : null)
};
