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

const { RECORDS, recordFrom } = require('../records');
const officialCharts = require('../official-charts');
const schema = require('../schema');
const listings = require('./uniqlo-listings.json');
const { SNAPSHOT } = require('./uniqlo-snapshot');
const { photos: PHOTOS } = require('./uniqlo-photos.json');
/* the colours and photos UNIQLO's image host holds for each product,
   found by scripts/find-uniqlo-images.js; absent, a product has its one photo */
let IMAGES = {};
try { IMAGES = require('./uniqlo-images.json').products || {}; } catch (err) { IMAGES = {}; }

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

const IMAGE = /^https:\/\/image\.uniqlo\.com\/UQ\/ST3\/WesternCommon\/imagesgoods\/(\d{6})\//;
const COLOUR = /^\d{2}$/;

/* Everything Fynd can show on a product's page, each with where it came
   from — and, by name, what it doesn't have. Nothing is filled in. */
function detail(code) {
  const p = module.exports.find(code);
  if (!p) return null;
  const record = RECORDS.find((r) => r.brand === 'UNIQLO' && r.product.code === p.code) || null;
  const short = p.code.slice(1, 7);
  const ours = (url) => typeof url === 'string' && (IMAGE.exec(url) || [])[1] === short;
  const found = IMAGES[p.code] || null;
  const colours = [];
  if (found && Array.isArray(found.colours)) {
    found.colours.filter((c) => COLOUR.test(c)).slice(0, 40).forEach((c) => {
      const image = `https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/${short}/item/goods_${c}_${short}_3x4.jpg`;
      const chip = found.chips && ours(found.chips[c]) ? found.chips[c] : null;
      colours.push({ code: c, label: `Colour ${c}`, image, chip });
    });
  }
  if (!colours.length && p.imageUrl) {
    const c = (/goods_(\d{2})_\d{6}_3x4/.exec(p.imageUrl) || [])[1] || null;
    colours.push({ code: c, label: c ? `Colour ${c}` : 'Photo', image: p.imageUrl, chip: null });
  }
  const gallery = found && Array.isArray(found.subs) ? found.subs.filter(ours).slice(0, 12) : [];
  const missing = ['price', 'description', 'care', 'reviews', 'availability'];
  if (!record) missing.push('sizes', 'fabric', 'fit');
  else if (!record.material || !record.material.composition) missing.push('fabric');
  return {
    brand: 'UNIQLO',
    market: 'US',
    code: p.code,
    name: p.name,
    url: p.url,
    category: p.category,
    categoryLabel: p.categoryLabel,
    line: p.line,
    holds: p.holds,
    holdsText: p.holdsText,
    colours,
    /* the colour the product's card shows, so the page opens on the same photo */
    defaultColour: ((/goods_(\d{2})_\d{6}_3x4/.exec(p.imageUrl || '') || [])[1]) || (colours[0] && colours[0].code) || null,
    coloursNote: found
      ? 'Colours UNIQLO has photographed for this product, from its image host — not proof that each is on sale now.'
      : 'Only one photo of this product is known to Fynd, so its other colours aren’t shown.',
    gallery,
    sizes: record ? { list: record.sizes.slice(), source: `Fynd’s record of this product, ${recordFrom(record)}` } : null,
    fit: record && record.fit ? { words: record.fit.brandWords, source: record.fit.source } : null,
    material: record && record.material && record.material.composition ? { text: record.material.composition, source: record.material.source } : null,
    recordedAt: record ? record.retrievedAt : null,
    recordFrom: record ? recordFrom(record) : null,
    recordVerified: record ? schema.isVerified(record) : null,
    imagesFrom: found ? 'image.uniqlo.com, at addresses carrying this product’s code' : (p.imageUrl ? 'image.uniqlo.com' : null),
    missing
  };
}

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
  find: (code) => (typeof code === 'string' && CODE.test(code) ? PRODUCTS.find((p) => p.code === code) || null : null),
  /* a product's page: what Fynd holds, with sources, and what it doesn't */
  detail
};
