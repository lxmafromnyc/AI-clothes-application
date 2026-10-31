/* =========================================================
   Fynd — a participating merchant's catalogue, as Find Fit browses it

   createMerchantBrand(source) answers the same questions as the UNIQLO
   module (./uniqlo.js) — products(), search(), find(), detail(),
   coverage, notice, catalogue() — for one merchant's own catalogue
   (api/_catalog/merchants, sources/merchant.js), read and checked once
   by api/_catalog/store.js.

   Two facts are kept apart on every product:

     listed    the merchant supplied it and authorized Fynd to show it:
               enough for it to appear, be searched and be filtered.
               Its photos, colours, sizes, price and stock only as far
               as the authorization covers them, and price and stock only
               while current (48 hours).
     sizing    whether Fynd holds a sizing record for it — matched by
               brand, market and exact product code, never by name — and
               what the decision policy (../decision.js) says without a
               shopper's profile. A size label is a label, not a
               measurement: a product with no record is listed all the
               same, and its sizing says INSUFFICIENT_DATA ("no-record").

   Nothing here reads a website.
   ========================================================= */

'use strict';

const store = require('../../_catalog/store');
const { CATEGORIES } = require('../../_catalog/product');
const { createIndex, sortsFor } = require('../../_catalog/search');
const { RECORDS, summary } = require('../records');
const schema = require('../schema');
const decision = require('../decision');

const HOLDS_TEXT = {
  'checked-chart': 'Fynd has this product’s chart, checked',
  'unchecked-chart': 'Fynd has this product’s chart, not yet checked',
  'live-only': 'No saved chart for this product'
};
const KINDS = { hoodies: 'Hoodies', sweatshirts: 'Sweatshirts' };
const ORDER = Object.keys(CATEGORIES);
const day = (iso) => (iso ? iso.slice(0, 10) : null);
const brandKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* hoodies apart from sweatshirts, by the product's own name only */
function kindOf(p) {
  if (p.category !== 'sweatshirts-hoodies' || typeof p.name !== 'string') return null;
  if (/\bhood(ie|ies|ed|y)?\b/i.test(p.name)) return 'hoodies';
  if (/\bsweatshirts?\b/i.test(p.name)) return 'sweatshirts';
  return null;
}

function createMerchantBrand(source) {
  const config = source.config;
  const LOADED = store.load(source);
  const licensed = (field) => LOADED.state === 'loaded' && LOADED.catalog.licensed.includes(field);
  const freshness = (now) => {
    const fresh = store.freshness(LOADED, source, now);
    /* served only while the merchant's authorization runs, too */
    const authorized = source.authorizedAt(now);
    return Object.assign({}, fresh, { served: fresh.served && authorized, volatile: fresh.volatile && authorized, authorized });
  };

  /* Fynd's sizing record for a product, by brand, market and exact code */
  function recordFor(p) {
    const brand = p.brand || config.brands[0];
    return RECORDS.find((r) => brandKey(r.brand) === brandKey(brand) && r.region === config.market && r.product.code === p.code) || null;
  }

  function build() {
    return LOADED.products.map((c) => {
      const record = recordFor(c);
      const s = record ? summary(record) : null;
      const holds = record ? (schema.isVerified(record) ? 'checked-chart' : 'unchecked-chart') : 'live-only';
      const kind = kindOf(c);
      return Object.freeze({
        code: c.code,
        name: c.name,
        brand: c.brand,
        url: c.url,
        category: c.category,
        group: c.category,
        categoryLabel: CATEGORIES[c.category],
        kind,
        kindLabel: kind ? KINDS[kind] : null,
        line: c.line,
        imageUrl: (c.images && c.images[0]) || (c.colours && (c.colours.find((col) => col.image) || {}).image) || null,
        holds,
        holdsText: HOLDS_TEXT[holds],
        /* listed, and — separately — what Fynd holds for its sizing */
        status: Object.freeze({
          catalogue: 'merchant',
          chart: record ? 'own' : 'none',
          garment: s && s.garmentDimensions.length ? (s.verified ? 'verified' : 'unverified') : 'none',
          comparable: Boolean(s && s.comparable)
        }),
        recordId: record ? record.id : null,
        catalogue: c
      });
    });
  }

  let VIEW = null;
  const view = () => {
    if (!VIEW) {
      const products = build();
      VIEW = { products, byCode: new Map(products.map((p) => [p.code, p])), index: createIndex(products, { categoryOrder: ORDER }) };
    }
    return VIEW;
  };
  const EMPTY = { products: [], byCode: new Map(), index: createIndex([], { categoryOrder: ORDER }) };
  const served = (now) => (freshness(now).served ? view() : EMPTY);

  function card(p, fresh) {
    const c = p.catalogue;
    const out = { code: p.code, name: p.name, brand: p.brand, url: p.url, category: p.category, group: p.group, categoryLabel: p.categoryLabel, kind: p.kind, kindLabel: p.kindLabel, line: p.line, imageUrl: p.imageUrl, holds: p.holds, holdsText: p.holdsText, status: Object.assign({}, p.status) };
    if (Array.isArray(c.sizes) && c.sizes.length) out.sizeRange = { first: c.sizes[0], last: c.sizes[c.sizes.length - 1], count: c.sizes.length };
    if (fresh.volatile) {
      if (c.price) out.price = Object.assign({}, c.price);
      if (c.availability) out.availability = c.availability;
    }
    return out;
  }

  function search(query, now) {
    const fresh = freshness(now);
    const v = served(now);
    const stockKnown = fresh.served && fresh.volatile && licensed('stock');
    const pricesKnown = fresh.served && fresh.volatile && licensed('price');
    const found = v.index.search(query, { stockKnown, pricesKnown });
    return {
      listed: v.products.length,
      total: found.total,
      offset: found.offset,
      limit: found.limit,
      query: found.query,
      partial: found.partial,
      unmatched: found.unmatched,
      facets: { categories: found.facets.categories, lines: found.facets.lines, vendors: found.facets.vendors, colours: found.facets.colours, sizes: found.facets.sizes, inStock: stockKnown, sorts: sortsFor(pricesKnown) },
      products: found.items.map((p) => card(p, fresh))
    };
  }

  const CODE = /^[A-Z0-9][A-Z0-9-]{2,30}$/;
  const find = (code, now) => (typeof code === 'string' && CODE.test(code) ? served(now).byCode.get(code) || null : null);

  /* the product's page: what the merchant supplied, each with its
     source; its sizing, apart; and by name what isn't known */
  function detail(code, now) {
    const fresh = freshness(now);
    const p = find(code, now);
    if (!p) return null;
    const c = p.catalogue;
    const asOf = day(LOADED.catalog.lastSuccessfulSync);
    const from = `${config.name}'s own catalogue, updated ${asOf}`;
    const colours = (c.colours || []).map((col) => ({ code: col.code, label: col.name || `Colour ${col.code}`, image: col.image || null, chip: null }));
    if (!colours.length && p.imageUrl) colours.push({ code: null, label: 'Photo', image: p.imageUrl, chip: null });
    const shown = new Set(colours.map((col) => col.image));
    const price = c.price && fresh.volatile ? Object.assign({}, c.price, { source: from }) : null;
    const stock = Boolean(fresh.volatile && (c.availability || c.sizeAvailability || c.variants));
    const sizes = c.sizes ? { list: c.sizes.slice(), source: `${from} — size labels only, not measurements` } : null;
    if (sizes && stock && (c.sizeAvailability || c.variants)) {
      sizes.availability = c.sizeAvailability ? Object.assign({}, c.sizeAvailability) : null;
      sizes.variants = c.variants ? c.variants.map((v) => Object.assign({}, v)) : null;
      sizes.stockAsOf = asOf;
    }
    const record = p.recordId ? RECORDS.find((r) => r.id === p.recordId) : null;
    const description = c.description ? { text: c.description, source: from } : null;
    const missing = ['price', 'description', 'care', 'reviews', 'availability'].filter((m) => !(m === 'price' && price) && !(m === 'availability' && stock) && !(m === 'description' && description));
    if (!sizes) missing.push('sizes');
    missing.push('fabric', 'fit');
    const out = {
      brand: p.brand || config.brands[0],
      retailer: config.name,
      market: config.market,
      code: p.code,
      name: p.name,
      url: p.url,
      buyUrl: p.url,
      /* the hosts this product's photos and page may be loaded from */
      imageHosts: source.imageHosts.slice(),
      pageHosts: source.pageHosts.slice(),
      category: p.category,
      categoryLabel: p.categoryLabel,
      line: p.line,
      holds: p.holds,
      holdsText: p.holdsText,
      status: Object.assign({}, p.status),
      colours,
      defaultColour: colours[0] ? colours[0].code : null,
      coloursNote: c.colours ? `Colours from ${from}.` : 'Only one photo of this product is known to Fynd, so its other colours aren’t shown.',
      gallery: (c.images || []).filter((u) => !shown.has(u)).slice(0, 12),
      sizes,
      fit: null,
      material: null,
      recordedAt: null,
      recordFrom: null,
      recordVerified: record ? schema.isVerified(record) : null,
      imagesFrom: c.images || colours.some((col) => col.image) ? `${from} (${source.imageHosts.join(', ')})` : null,
      missing,
      /* sizing, apart from being listed: the record matched by code, and
         the decision without a profile — never a size from a label */
      sizing: {
        record: record ? record.id : null,
        verified: record ? schema.isVerified(record) : null,
        decision: decision.decide(null, record || { category: null })
      },
      catalogue: {
        name: `${config.name}'s own catalogue`,
        merchant: config.id,
        updatedAt: asOf,
        authorization: LOADED.catalog.authorization || null,
        withheld: !fresh.volatile && (licensed('price') || licensed('stock')) && Boolean(c.price || c.availability || c.sizeAvailability || c.variants)
      }
    };
    if (price) out.price = price;
    if (description) out.description = description;
    if (stock && c.availability) out.availability = { state: c.availability, asOf };
    return out;
  }

  function coverage(now) {
    const fresh = freshness(now);
    if (!fresh.served) return `${config.name}'s catalogue isn’t available on Fynd right now.`;
    return `${view().products.length} products from ${config.name}'s own catalogue, updated ${day(LOADED.catalog.lastSuccessfulSync)}.`;
  }
  function notice(now) {
    const fresh = freshness(now);
    if (LOADED.state === 'none') return `${config.name}'s catalogue hasn’t been imported yet.`;
    /* refused as it loaded (api/_catalog/store.js): nothing from it is shown */
    if (LOADED.state !== 'loaded') {
      return ['licence-exceeds-authorization', 'authorization-mismatch'].includes(LOADED.why)
        ? `${config.name}'s catalogue doesn’t match its current authorization, so none of its products are shown until it is imported again.`
        : `${config.name}'s catalogue can’t be shown right now.`;
    }
    if (!fresh.authorized) return `${config.name}'s authorization for Fynd to list its products isn’t current, so none are shown.`;
    if (!fresh.served) return `${config.name}'s catalogue was last updated on ${day(LOADED.catalog.lastSuccessfulSync)}, too long ago to show.`;
    if (!fresh.volatile && (licensed('price') || licensed('stock'))) return `Prices and stock aren’t shown: ${config.name}'s catalogue was last updated on ${day(LOADED.catalog.lastSuccessfulSync)}, too long ago for them to be current.`;
    return null;
  }

  return {
    id: config.id,
    name: config.name,
    market: config.market,
    merchant: true,
    imageHosts: source.imageHosts.slice(),
    get coverage() { return coverage(); },
    get notice() { return notice(); },
    coverageAt: coverage,
    noticeAt: notice,
    catalogue: (now) => {
      const fresh = freshness(now);
      return LOADED.state === 'loaded'
        ? { connected: fresh.served, lastSuccessfulSync: LOADED.catalog.lastSuccessfulSync, pricesShown: fresh.served && fresh.volatile && licensed('price'), stockShown: fresh.served && fresh.volatile && licensed('stock'), authorized: fresh.authorized }
        : { connected: false, lastSuccessfulSync: null, pricesShown: false, stockShown: false, authorized: fresh.authorized };
    },
    products: (now) => served(now).products,
    search,
    find,
    detail
  };
}

module.exports = { createMerchantBrand };
