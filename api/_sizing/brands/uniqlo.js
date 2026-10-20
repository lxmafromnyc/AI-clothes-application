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
     the snapshot      a test's fixture only (uniqlo-snapshot.js): the
                       category-page reader that wrote one is retired,
                       and a committed snapshot is never read
     the catalogue     UNIQLO's authorized product catalogue, when one
                       has been synced (api/_catalog, uniqlo-feed.js):
                       every product it lists, with the photos, colours,
                       sizes, prices and stock its licence covers. None
                       has been authorized yet, so today the list is the
                       products above, and the page says so.

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

   The category-page reader (scripts/fetch-uniqlo-catalog.js) has been
   retired: Fynd doesn't read uniqlo.com to build its list. The snapshot
   is read only from a test's fixture (uniqlo-snapshot.js).

   A product is chosen by its code; its address comes from here, never
   from the browser. A catalogue product is matched to Fynd's sizing
   (records, general charts, the live chart read) by that exact code
   and its canonical address only: a catalogue holds no measurements.

   The list is searched and paged here (search()), from an index built
   once (api/_catalog/search.js), so the page asks for one page of
   matches at a time and never holds thousands of products.
   ========================================================= */

'use strict';

const { RECORDS, recordFrom } = require('../records');
const officialCharts = require('../official-charts');
const schema = require('../schema');
const listings = require('./uniqlo-listings.json');
const { SNAPSHOT } = require('./uniqlo-snapshot');
const { photos: PHOTOS } = require('./uniqlo-photos.json');
const feed = require('./uniqlo-feed');
const { CATEGORIES } = require('../../_catalog/product');
const { createIndex } = require('../../_catalog/search');
/* the colours and photos UNIQLO's image host holds for each product,
   found by scripts/find-uniqlo-images.js; absent, a product has its one photo */
let IMAGES = {};
try { IMAGES = require('./uniqlo-images.json').products || {}; } catch (err) { IMAGES = {}; }

const CODE = /^E\d{6}-\d{3}$/;
/* the filter a product sits under: records' own categories and the
   snapshot's category pages, grouped the way UNIQLO's pages group them */
const GROUPS = Object.assign(Object.fromEntries(Object.entries(CATEGORIES).map(([k, label]) => [k, [k, label]])), {
  hoodies: ['sweatshirts-hoodies', CATEGORIES['sweatshirts-hoodies']],
  sweatshirts: ['sweatshirts-hoodies', CATEGORIES['sweatshirts-hoodies']]
});

/* What Fynd holds for a product's sizing, said before anything is
   looked up — never that a chart was read. */
const HOLDS = {
  'checked-chart': 'Fynd has this product’s chart, checked',
  'unchecked-chart': 'Fynd has this product’s chart, not yet checked',
  'general-chart': 'UNIQLO’s general chart only',
  'live-only': 'No saved chart for this product'
};

function build(withCatalogue) {
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
    /* the sizes it is sold in, from Fynd's record, so a size filter finds it */
    sizeLabels: r.sizes.slice(),
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
  /* the authorized catalogue: a product Fynd already lists keeps what
     it holds for its sizing, its name and category, and gains the
     catalogue's facts; any other is added, its sizing looked up by its
     code when chosen. Matched by exact code only. */
  if (withCatalogue) {
    feed.LOADED.products.forEach((c) => {
      const facts = { catalogue: c };
      const known = out.get(c.code);
      if (known) {
        /* Fynd's record of its sizes wins over the catalogue's */
        out.set(c.code, Object.freeze(Object.assign({}, known, facts, { imageUrl: known.imageUrl || (c.images && c.images[0]) || null, sizeLabels: known.sizeLabels || c.sizes || undefined })));
        return;
      }
      const general = officialCharts.CHARTS.some((ch) => ch.market === 'US' && officialCharts.covers(ch, c));
      add(Object.assign({ code: c.code, name: c.name, url: c.url, category: c.category, line: c.line, imageUrl: (c.images && c.images[0]) || (c.colours && c.colours[0] && c.colours[0].image) || null,
        holds: general ? 'general-chart' : 'live-only', source: 'UNIQLO’s authorized catalogue' }, facts));
    });
  }
  /* what Fynd holds most first: a checked chart, then the rest */
  const rank = { 'checked-chart': 0, 'unchecked-chart': 1, 'general-chart': 2, 'live-only': 3 };
  return [...out.values()].sort((a, b) => (rank[a.holds] - rank[b.holds]) || a.categoryLabel.localeCompare(b.categoryLabel) || a.name.localeCompare(b.name));
}

/* the list without the catalogue, and with it: which one is served is
   asked on every request, since the catalogue can go out of date */
const ORDER = Object.keys(CATEGORIES);
const VIEWS = {};
function view(now) {
  const fresh = feed.freshness(now);
  const key = fresh.served ? 'full' : 'base';
  if (!VIEWS[key]) {
    const products = build(fresh.served);
    VIEWS[key] = { products, byCode: new Map(products.map((p) => [p.code, p])), index: createIndex(products, { categoryOrder: ORDER }) };
  }
  return Object.assign({ fresh }, VIEWS[key]);
}

const day = (iso) => (iso ? iso.slice(0, 10) : null);
const catalogueName = () => feed.LOADED.catalog.sourceName || 'UNIQLO’s authorized product catalogue';
const licensed = (field) => feed.LOADED.state === 'loaded' && feed.LOADED.catalog.licensed.includes(field);

/* what a card shows: price and stock only while they're current */
function card(p, fresh) {
  const out = { code: p.code, name: p.name, url: p.url, category: p.category, group: p.group, categoryLabel: p.categoryLabel, line: p.line, imageUrl: p.imageUrl, holds: p.holds, holdsText: p.holdsText };
  const c = p.catalogue;
  if (c && fresh.volatile) {
    if (c.price) out.price = Object.assign({}, c.price);
    if (c.availability) out.availability = c.availability;
  }
  return out;
}

const IMAGE = /^https:\/\/image\.uniqlo\.com\/UQ\/ST3\/WesternCommon\/imagesgoods\/(\d{6})\//;
const COLOUR = /^\d{2}$/;

/* Everything Fynd can show on a product's page, each with where it came
   from — and, by name, what it doesn't have. Nothing is filled in. */
function detail(code, now) {
  const fresh = feed.freshness(now);
  const p = find(code, now);
  if (!p) return null;
  const record = RECORDS.find((r) => r.brand === 'UNIQLO' && r.product.code === p.code) || null;
  const c = p.catalogue || null;
  const asOf = c ? day(feed.LOADED.catalog.lastSuccessfulSync) : null;
  const short = p.code.slice(1, 7);
  const ours = (url) => typeof url === 'string' && (IMAGE.exec(url) || [])[1] === short;
  const found = IMAGES[p.code] || null;
  const colours = [];
  if (c && c.colours) {
    /* the catalogue's own colours, by its names where it gives them */
    c.colours.forEach((col) => colours.push({ code: col.code, label: col.name || `Colour ${col.code}`, image: col.image || null, chip: null }));
  } else if (found && Array.isArray(found.colours)) {
    found.colours.filter((col) => COLOUR.test(col)).slice(0, 40).forEach((col) => {
      const image = `https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/${short}/item/goods_${col}_${short}_3x4.jpg`;
      const chip = found.chips && ours(found.chips[col]) ? found.chips[col] : null;
      colours.push({ code: col, label: `Colour ${col}`, image, chip });
    });
  }
  if (!colours.length && p.imageUrl) {
    const col = (/goods_(\d{2})_\d{6}_3x4/.exec(p.imageUrl) || [])[1] || null;
    colours.push({ code: col, label: col ? `Colour ${col}` : 'Photo', image: p.imageUrl, chip: null });
  }
  const shown = new Set(colours.map((col) => col.image));
  const gallery = c && c.images
    ? c.images.filter((u) => !shown.has(u)).slice(0, 12)
    : found && Array.isArray(found.subs) ? found.subs.filter(ours).slice(0, 12) : [];
  const price = c && c.price && fresh.volatile ? Object.assign({}, c.price, { source: `${catalogueName()}, updated ${asOf}` }) : null;
  const stock = Boolean(c && fresh.volatile && (c.availability || c.sizeAvailability || c.variants));
  let sizes = null;
  if (record) sizes = { list: record.sizes.slice(), source: `Fynd’s record of this product, ${recordFrom(record)}` };
  else if (c && c.sizes) sizes = { list: c.sizes.slice(), source: `${catalogueName()}, updated ${asOf} — size labels only, not measurements` };
  if (sizes && stock && (c.sizeAvailability || c.variants)) {
    sizes.availability = c.sizeAvailability ? Object.assign({}, c.sizeAvailability) : null;
    sizes.variants = c.variants ? c.variants.map((v) => Object.assign({}, v)) : null;
    sizes.stockAsOf = asOf;
  }
  const description = c && c.description ? { text: c.description, source: `${catalogueName()}, updated ${asOf}` } : null;
  const missing = ['price', 'description', 'care', 'reviews', 'availability'].filter((m) => !(m === 'price' && price) && !(m === 'availability' && stock) && !(m === 'description' && description));
  if (!record) missing.push(...(sizes ? [] : ['sizes']), 'fabric', 'fit');
  else if (!record.material || !record.material.composition) missing.push('fabric');
  const out = {
    brand: 'UNIQLO',
    market: 'US',
    code: p.code,
    name: p.name,
    url: p.url,
    /* where "View on UNIQLO" goes: the affiliate network's tracking link
       to this same page when the catalogue came from an affiliate feed
       (checked as it was read: api/_catalog/product.js), else the page */
    buyUrl: (c && c.affiliateUrl) || p.url,
    category: p.category,
    categoryLabel: p.categoryLabel,
    line: p.line,
    holds: p.holds,
    holdsText: p.holdsText,
    colours,
    /* the colour the product's card shows, so the page opens on the same photo */
    defaultColour: ((/goods_(\d{2})_\d{6}_3x4/.exec(p.imageUrl || '') || [])[1]) || (colours[0] && colours[0].code) || null,
    coloursNote: c && c.colours
      ? `Colours from ${catalogueName()}, updated ${asOf}.`
      : found
        ? 'Colours UNIQLO has photographed for this product, from its image host — not proof that each is on sale now.'
        : 'Only one photo of this product is known to Fynd, so its other colours aren’t shown.',
    gallery,
    sizes,
    fit: record && record.fit ? { words: record.fit.brandWords, source: record.fit.source } : null,
    material: record && record.material && record.material.composition ? { text: record.material.composition, source: record.material.source } : null,
    recordedAt: record ? record.retrievedAt : null,
    recordFrom: record ? recordFrom(record) : null,
    recordVerified: record ? schema.isVerified(record) : null,
    imagesFrom: c && (c.images || (c.colours || []).some((col) => col.image)) ? `${catalogueName()} (image.uniqlo.com)` : found ? 'image.uniqlo.com, at addresses carrying this product’s code' : (p.imageUrl ? 'image.uniqlo.com' : null),
    missing
  };
  if (price) out.price = price;
  if (description) out.description = description;
  if (stock && c.availability) out.availability = { state: c.availability, asOf };
  if (c) {
    out.catalogue = {
      name: catalogueName(),
      updatedAt: asOf,
      /* said when the catalogue had a price or stock too old to show */
      withheld: !fresh.volatile && (licensed('price') || licensed('stock')) && Boolean(c.price || c.availability || c.sizeAvailability || c.variants)
    };
  }
  return out;
}

/* a product by its exact code, or null */
function find(code, now) {
  if (typeof code !== 'string' || !CODE.test(code)) return null;
  return view(now).byCode.get(code) || null;
}

/* How much of UNIQLO's range Find Fit lists, in one honest line, and —
   while that is only the products Fynd sourced itself — a notice saying
   most of UNIQLO isn't here. Never "full": a catalogue is described by
   its own count and date. */
function coverage(now) {
  const v = view(now);
  const n = v.products.length;
  if (v.fresh.served) {
    return `${n} UNIQLO US products from ${catalogueName()}, updated ${day(feed.LOADED.catalog.lastSuccessfulSync)}${feed.LOADED.catalog.feedComplete ? '.' : ' — a partial feed, so some products may be missing.'}`;
  }
  return SNAPSHOT.products.length
    ? `${n} UNIQLO US products, as listed on uniqlo.com’s own category pages on ${SNAPSHOT.fetchedAt} — not UNIQLO’s full range.`
    : `${n} UNIQLO US products Fynd has read off uniqlo.com — not UNIQLO’s full range.`;
}
/* While Find Fit lists only the products Fynd sourced itself: how few,
   that it isn't UNIQLO's catalogue, and the one other way in — a pasted
   link, whose chart is shown only where Fynd holds one or can read one
   from the product's own page. No paid product search stands behind it. */
function notice(now) {
  const v = view(now);
  if (v.fresh.served && !v.fresh.volatile && (licensed('price') || licensed('stock'))) {
    return `Prices and stock aren’t shown: UNIQLO’s product catalogue was last updated on ${day(feed.LOADED.catalog.lastSuccessfulSync)}, too long ago for them to be current. Check them on UNIQLO’s own page.`;
  }
  if (v.fresh.served) return null;
  const n = v.products.length;
  const why = feed.LOADED.state === 'loaded'
    ? `UNIQLO’s product catalogue was last updated on ${day(feed.LOADED.catalog.lastSuccessfulSync)}, too long ago to show, so Fynd’s own list holds only the ${n} UNIQLO US products it sourced itself.`
    : `Fynd’s own list holds only ${n} UNIQLO US products — it isn’t connected to UNIQLO’s full catalogue.`;
  return `${why} For any other UNIQLO product, close this list and paste the product’s link in Find Fit: Fynd shows its size chart where it holds one, and says so plainly when it can’t.`;
}

/* one page of the products matching a query and filters */
function search(query, now) {
  const v = view(now);
  const stockKnown = v.fresh.served && v.fresh.volatile && licensed('stock');
  const found = v.index.search(query, { stockKnown });
  return {
    total: found.total,
    offset: found.offset,
    limit: found.limit,
    query: found.query,
    partial: found.partial,
    unmatched: found.unmatched,
    facets: { categories: found.facets.categories, lines: found.facets.lines, colours: found.facets.colours, sizes: found.facets.sizes, inStock: stockKnown },
    products: found.items.map((p) => card(p, v.fresh))
  };
}

module.exports = {
  id: 'uniqlo',
  name: 'UNIQLO',
  market: 'US',
  get coverage() { return coverage(); },
  get notice() { return notice(); },
  coverageAt: coverage,
  noticeAt: notice,
  snapshotAt: SNAPSHOT.fetchedAt,
  /* the catalogue's state, for the page: whether one is connected, and when it was last synced */
  catalogue: (now) => {
    const fresh = feed.freshness(now);
    return feed.LOADED.state === 'loaded'
      ? { connected: fresh.served, lastSuccessfulSync: feed.LOADED.catalog.lastSuccessfulSync, pricesShown: fresh.served && fresh.volatile && licensed('price'), stockShown: fresh.served && fresh.volatile && licensed('stock') }
      : { connected: false, lastSuccessfulSync: null, pricesShown: false, stockShown: false };
  },
  products: (now) => view(now).products,
  search,
  find,
  /* a product's page: what Fynd holds, with sources, and what it doesn't */
  detail
};
