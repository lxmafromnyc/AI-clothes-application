/* =========================================================
   FindWear — product source adapter

   Defines the contract every product provider must satisfy, and the gate
   every record must pass before it can reach the interface. Swapping
   provider means adding one adapter here and setting its credentials in
   the environment. No frontend change, no change to /api/search.

   ---------------------------------------------------------
   Writing an adapter
   ---------------------------------------------------------
   An adapter is an object:

     {
       name: 'example',
       configured() { return Boolean(process.env.EXAMPLE_API_KEY); },
       async search(intent, { limit }) { ... return rawRecords; }
     }

   `intent` is the structured output of /api/interpret:

     { categories, colors, occasions, fits, brands, styles,
       maxPrice, minPrice, season, gender, keywords }

   `search` returns an array of raw records in whatever shape the upstream
   source uses. Field names are mapped below, so an adapter does not need
   to reshape anything itself. It must never invent a value: if the source
   does not supply a field, leave it absent and the record is rejected.

   ---------------------------------------------------------
   The verification gate
   ---------------------------------------------------------
   A record is displayed only when the source supplied ALL of:

     title, brand, price, imageUrl, productUrl, retailer

   Anything missing one is dropped rather than filled in. productUrl must
   also address a specific product page — a bare origin, or a path that
   reads as a search or category listing, is rejected, because a link to a
   homepage is not the product the card claims to show.
   ========================================================= */

'use strict';

/* Field aliases, so an adapter can pass a source record through untouched.
   Ordered by preference; the first present, non-empty value wins. */
const FIELD_ALIASES = {
  title: ['title', 'name', 'product_name', 'productName', 'productname'],
  brand: ['brand', 'brand_name', 'brandName', 'manufacturer', 'vendor'],
  price: ['price', 'search_price', 'searchPrice', 'current_price', 'currentPrice', 'sale_price', 'display_price'],
  currency: ['currency', 'currency_code', 'currencyCode'],
  imageUrl: ['imageUrl', 'image_url', 'imgurl', 'merchant_image_url', 'image', 'large_image', 'thumbnail'],
  productUrl: ['productUrl', 'product_url', 'deep_link', 'aw_deep_link', 'purl', 'link', 'url', 'merchant_deep_link'],
  retailer: ['retailer', 'merchant_name', 'merchantName', 'advertiser', 'store', 'source', 'programme_name'],
  availability: ['availability', 'in_stock', 'inStock', 'stock_status', 'is_for_sale'],
  category: ['category', 'merchant_category', 'product_type', 'productType'],
  colors: ['colors', 'colour', 'color', 'colours'],
  sizes: ['sizes', 'size'],
  sku: ['sku', 'product_id', 'productId', 'pid', 'mpn', 'ean', 'upc']
};

/* Paths that indicate a listing or search page rather than one product. */
const NON_PRODUCT_PATH = /^\/?(search|s|browse|category|categories|c|shop|collections?|results?|find)\/?$/i;

const firstOf = (record, keys) => {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
};

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

function toPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = text(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* Only absolute http(s) URLs survive, so a source cannot inject another
   scheme and a relative path cannot silently resolve against our origin. */
function toAbsoluteUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (err) {
    return null;
  }
}

/* A product page has a path beyond the origin and does not read as a
   listing. This is a guard against homepage and search-page links, not a
   guarantee the page exists — only fetching it could prove that. */
function isProductPage(href) {
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/\/+$/, '');
    if (!path || path === '') return Boolean(url.search);
    if (NON_PRODUCT_PATH.test(path)) return false;
    return true;
  } catch (err) {
    return false;
  }
}

function toList(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/\s*[,|/]\s*/);
  return items.map((v) => String(v).trim()).filter(Boolean);
}

const UNAVAILABLE = /^(0|false|no|out.?of.?stock|unavailable|sold.?out|discontinued)$/i;

/* A record is in stock unless the source explicitly says otherwise. A
   source that says nothing about stock is not treated as out of stock. */
function inStock(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  return !UNAVAILABLE.test(text(value));
}

/* Maps a raw source record onto FindWear's shape. Returns either
   { ok: true, product } or { ok: false, reason } — never a partial
   product, and never a field this function made up. */
function toProduct(raw, context) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };

  const pick = (field) => firstOf(raw, FIELD_ALIASES[field]);

  const title = text(pick('title'));
  const brand = text(pick('brand'));
  const price = toPrice(pick('price'));
  const imageUrl = toAbsoluteUrl(pick('imageUrl'));
  const productUrl = toAbsoluteUrl(pick('productUrl'));
  const retailer = text(pick('retailer')) || text(context && context.retailer);

  /* every displayed field must have come from the source */
  if (!title) return { ok: false, reason: 'missing-title' };
  if (!brand) return { ok: false, reason: 'missing-brand' };
  if (price === null) return { ok: false, reason: 'missing-price' };
  if (!imageUrl) return { ok: false, reason: 'missing-image-url' };
  if (!productUrl) return { ok: false, reason: 'missing-product-url' };
  if (!retailer) return { ok: false, reason: 'missing-retailer' };
  if (!isProductPage(productUrl)) return { ok: false, reason: 'product-url-not-a-product-page' };
  if (!inStock(pick('availability'))) return { ok: false, reason: 'out-of-stock' };

  return {
    ok: true,
    product: {
      id: text(pick('sku')) || productUrl,
      name: title,
      brand,
      price,
      currency: text(pick('currency')) || 'USD',
      imageUrl,
      productUrl,
      retailer,
      category: text(pick('category')).toLowerCase(),
      colors: toList(pick('colors')),
      sizes: toList(pick('sizes'))
    }
  };
}

/* Runs a whole batch through the gate and reports what was dropped, so a
   provider returning unusable records is visible rather than silent. */
function verifyAll(records, context) {
  const products = [];
  const rejected = {};
  const seen = new Set();

  for (const raw of Array.isArray(records) ? records : []) {
    const result = toProduct(raw, context);
    if (!result.ok) {
      rejected[result.reason] = (rejected[result.reason] || 0) + 1;
      continue;
    }
    if (seen.has(result.product.productUrl)) continue;
    seen.add(result.product.productUrl);
    products.push(result.product);
  }
  return { products, rejected };
}

/* ---------------------------------------------------------
   Provider registry
   ---------------------------------------------------------
   No provider is implemented yet, deliberately. Adding one means writing
   an adapter and registering it here; nothing else in the system changes.

   To add one:
     1. create api/providers/<name>.js exporting { name, configured, search }
     2. require it below and add it to PROVIDERS
     3. set PRODUCT_SOURCE=<name> plus that provider's credentials in the
        Vercel environment
   --------------------------------------------------------- */

const etsy = require('./etsy');

const PROVIDERS = {
  [etsy.name]: etsy,

  /* Placeholder used when nothing is configured. It returns no products
     rather than inventing any, which is what makes /api/search answer
     "not configured" instead of serving something fabricated. */
  none: {
    name: 'none',
    configured: () => false,
    async search() { return []; }
  }
};

function getProvider() {
  const requested = text(process.env.PRODUCT_SOURCE).toLowerCase();
  if (requested && PROVIDERS[requested]) return PROVIDERS[requested];
  return PROVIDERS.none;
}

module.exports = {
  getProvider,
  registerProvider: (adapter) => { PROVIDERS[adapter.name] = adapter; },
  toProduct,
  verifyAll,
  isProductPage,
  toPrice,
  toAbsoluteUrl,
  FIELD_ALIASES,
  PROVIDERS
};
