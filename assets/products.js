/* =========================================================
   FindWear — product data layer

   Everything the interface renders passes through here first. A product
   source supplies records; this module normalises them into one canonical
   shape and hands them to the store. Rendering never sees a raw record, so
   swapping the demo catalogue for a feed, an API or a database needs no
   changes to any page.

   ---------------------------------------------------------
   Canonical product
   ---------------------------------------------------------
     id          string        stable identifier
     name        string        product name as the retailer lists it
     brand       string        brand or retailer
     price       number|null   listed price; null renders no price
     productUrl  string|null   product page; null renders no link
     imageUrl    string|null   product photo; null falls back to artwork
     category    string        garment kind, selects fallback artwork
     styles      string[]      matching vocabulary
     occasions   string[]      matching vocabulary
     fits        string[]      matching vocabulary
     colors      string[]      colour families
     sizes       string[]      available sizes

   ---------------------------------------------------------
   Source records
   ---------------------------------------------------------
   Feeds disagree about field names, so normalisation accepts the common
   spellings rather than demanding one. Singular or plural, string or
   array, "S,M,L" or ["S","M","L"] all arrive at the same place:

     name        name | title | productName
     brand       brand | retailer | vendor
     price       price | currentPrice   ("$49.90" parses to 49.9)
     productUrl  productUrl | url | link
     imageUrl    imageUrl | image | image_url | thumbnail
     category    category | type | productType
     styles      style | styles
     occasions   occasion | occasions
     fits        fit | fits
     colors      color | colors | colour | colours
     sizes       size | sizes

   Anything unrecognised is ignored rather than throwing, so one malformed
   record cannot take down a page of results.
   ========================================================= */

(function (global) {
  'use strict';

  const first = (raw, keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
    }
    return undefined;
  };

  /* accepts an array, a delimited string, or a single value */
  function toList(value) {
    if (value === undefined || value === null) return [];
    const items = Array.isArray(value) ? value : String(value).split(/\s*[,|/]\s*/);
    return items
      .map((v) => String(v).trim())
      .filter(Boolean);
  }

  /* accepts 49.9, "49.90", "$49.90", "USD 49.90"; anything else is null */
  function toPrice(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    const match = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  const toText = (value) => (value === undefined || value === null ? '' : String(value).trim());

  /* only http(s) links are kept, so a feed cannot inject javascript: urls */
  function toUrl(value) {
    const text = toText(value);
    if (!text) return null;
    try {
      const url = new URL(text, global.location ? global.location.href : 'https://findwear.local');
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (err) {
      return null;
    }
  }

  /* derives a stable id when the source has none, so a record keeps the
     same identity across reloads and hero picks by id keep resolving */
  function derivedId(record) {
    const seed = `${record.brand}|${record.name}|${record.productUrl || ''}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    return 'p' + Math.abs(hash).toString(36);
  }

  function normalizeProduct(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const name = toText(first(raw, ['name', 'title', 'productName']));
    const brand = toText(first(raw, ['brand', 'retailer', 'vendor']));
    if (!name || !brand) return null; // a product without these cannot be shown

    const product = {
      id: toText(first(raw, ['id', 'sku', 'productId'])),
      name,
      brand,
      price: toPrice(first(raw, ['price', 'currentPrice'])),
      productUrl: toUrl(first(raw, ['productUrl', 'url', 'link'])),
      imageUrl: toUrl(first(raw, ['imageUrl', 'image', 'image_url', 'thumbnail'])),
      category: toText(first(raw, ['category', 'type', 'productType'])).toLowerCase(),
      styles: toList(first(raw, ['styles', 'style'])),
      occasions: toList(first(raw, ['occasions', 'occasion'])),
      fits: toList(first(raw, ['fits', 'fit'])),
      colors: toList(first(raw, ['colors', 'color', 'colours', 'colour'])),
      sizes: toList(first(raw, ['sizes', 'size']))
    };
    if (!product.id) product.id = derivedId(product);
    return product;
  }

  /* normalises a whole source, dropping records that cannot be rendered */
  function normalizeAll(records) {
    if (!Array.isArray(records)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of records) {
      const product = normalizeProduct(raw);
      if (!product || seen.has(product.id)) continue;
      seen.add(product.id);
      out.push(product);
    }
    return out;
  }

  /* the values actually present in the data, so filter controls can be
     built from the catalogue rather than hard-coded per page */
  function facets(products) {
    const collect = (key) => {
      const counts = new Map();
      products.forEach((p) => (p[key] || []).forEach((v) => counts.set(v, (counts.get(v) || 0) + 1)));
      return counts;
    };
    return {
      styles: collect('styles'),
      occasions: collect('occasions'),
      fits: collect('fits'),
      colors: collect('colors'),
      sizes: collect('sizes'),
      brands: products.reduce((m, p) => m.set(p.brand, (m.get(p.brand) || 0) + 1), new Map()),
      maxPrice: products.reduce((max, p) => (p.price != null && p.price > max ? p.price : max), 0)
    };
  }

  /* Holds the current catalogue and tells the pages when it changes, so a
     later feed can arrive asynchronously and the interface just re-renders.

       Products.load(DEMO_PRODUCTS)            an array
       Products.load('/api/products.json')     a URL returning JSON
       Products.load(() => fetchFromDb())      a function or promise

     All four pages call Products.subscribe(render), so whichever source is
     used, the same render path runs. */
  const listeners = [];
  let items = [];

  const store = {
    all: () => items,
    byId: (id) => items.find((p) => p.id === id) || null,
    facets: () => facets(items),

    subscribe(fn) {
      listeners.push(fn);
      if (items.length) fn(items);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },

    set(records) {
      items = normalizeAll(records);
      listeners.forEach((fn) => fn(items));
      return items;
    },

    load(source) {
      const resolved = typeof source === 'function' ? source() : source;
      if (typeof resolved === 'string') {
        return fetch(resolved)
          .then((r) => r.json())
          .then((json) => store.set(Array.isArray(json) ? json : json.products || []));
      }
      return Promise.resolve(resolved).then((records) => store.set(records));
    },

    normalizeProduct,
    normalizeAll
  };

  global.Products = store;
})(typeof window !== 'undefined' ? window : globalThis);
