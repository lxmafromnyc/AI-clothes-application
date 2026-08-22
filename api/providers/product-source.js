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

     title, price, imageUrl, productUrl, retailer

   Anything missing one is dropped rather than filled in.

   `brand` is OPTIONAL. Cross-retailer sources often carry no separate
   brand for a listing, and a product is still a real product without one.
   When the source supplies a brand it is shown; when it does not, the
   field is omitted and the record still passes. What is never done is
   substituting something else for it — a retailer's name in the brand
   field would be a fabricated attribution, which is exactly what this
   gate exists to prevent.

   productUrl must address a specific product page on the retailer's own
   site. Three kinds of link are rejected:

     * a bare origin, or a path that reads as a search or category
       listing — a homepage is not the product the card claims to show
     * an aggregator or search-engine host, Google Shopping included — a
       comparison page is not a retailer's product page
     * a redirector, meaning a path like /aclk or a query parameter whose
       value is itself another URL — where it lands cannot be verified
       from the link, so it cannot be presented as the product page
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

/* Hosts that index other shops rather than selling anything themselves.
   A Google Shopping page for an item is a comparison page: it is not the
   retailer's product page, so it is rejected however product-like its
   path looks. */
const AGGREGATOR_HOST = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|googleadservices\.com|googlesyndication\.com|googleusercontent\.com|gstatic\.com|bing\.com|duckduckgo\.com|yahoo\.com|yandex\.[a-z]+|shopping\.com|shopzilla\.com|pricegrabber\.com)$/i;

/* Paths used by ad servers and click-through redirectors. */
const REDIRECT_PATH = /^\/?(url|aclk|aclick|clk|click|redirect|redir|out|go|goto|jump|ref|link)\/?$/i;

/* A redirect carries its destination in a query parameter. Both halves
   must match — a known forwarding key AND a value that is itself a URL —
   so a genuine product link that happens to carry a `returnUrl` tracking
   parameter is not mistaken for a redirector. */
const REDIRECT_PARAM = /^(url|u|q|to|dest|destination|target|adurl|redirect|redirect_uri|redirect_url|r|out|link|goto|continue|next)$/i;
const URL_VALUED = /^(https?:)?\/\//i;

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

/* Names what is wrong with a product link, or null when nothing is.

   These are guards against homepage, comparison and redirect links, not a
   guarantee the page exists — only fetching it could prove that. Each
   fault returns its own reason so a provider handing back the wrong kind
   of URL is visible in the rejected tally rather than lumped together. */
function linkFault(href) {
  let url;
  try {
    url = new URL(href);
  } catch (err) {
    return 'product-url-unparseable';
  }

  if (AGGREGATOR_HOST.test(url.hostname)) return 'product-url-not-a-retailer-page';

  const path = url.pathname.replace(/\/+$/, '');
  if (REDIRECT_PATH.test(path)) return 'product-url-is-a-redirect';
  for (const [key, value] of url.searchParams.entries()) {
    if (REDIRECT_PARAM.test(key) && URL_VALUED.test(value)) return 'product-url-is-a-redirect';
  }

  if (!path || path === '') return url.search ? null : 'product-url-not-a-product-page';
  if (NON_PRODUCT_PATH.test(path)) return 'product-url-not-a-product-page';
  return null;
}

/* Kept as the plain yes/no form of the same rules. */
const isProductPage = (href) => linkFault(href) === null;

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
  const price = toPrice(pick('price'));
  const imageUrl = toAbsoluteUrl(pick('imageUrl'));
  const productUrl = toAbsoluteUrl(pick('productUrl'));
  const retailer = text(pick('retailer')) || text(context && context.retailer);
  /* optional: shown when the source has it, omitted when it does not */
  const brand = text(pick('brand'));

  /* every displayed field must have come from the source */
  if (!title) return { ok: false, reason: 'missing-title' };
  if (price === null) return { ok: false, reason: 'missing-price' };
  if (!imageUrl) return { ok: false, reason: 'missing-image-url' };
  if (!productUrl) return { ok: false, reason: 'missing-product-url' };
  if (!retailer) return { ok: false, reason: 'missing-retailer' };
  if (!inStock(pick('availability'))) return { ok: false, reason: 'out-of-stock' };

  const fault = linkFault(productUrl);
  if (fault) return { ok: false, reason: fault };

  const product = {
    id: text(pick('sku')) || productUrl,
    name: title,
    price,
    currency: text(pick('currency')) || 'USD',
    imageUrl,
    productUrl,
    retailer,
    category: text(pick('category')).toLowerCase(),
    colors: toList(pick('colors')),
    sizes: toList(pick('sizes'))
  };
  /* absent rather than empty, so the interface can tell the difference */
  if (brand) product.brand = brand;

  return { ok: true, product };
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
   FindWear runs on whichever adapter PRODUCT_SOURCE names. Adding another
   means writing an adapter and registering it here; nothing else in the
   system changes, and no page has any knowledge of which one is live.

   To add one:
     1. create api/providers/<name>.js exporting { name, configured, search }
     2. require it below and add it to PROVIDERS
     3. set PRODUCT_SOURCE=<name> plus that provider's credentials in the
        Vercel environment
   --------------------------------------------------------- */

const openwebninja = require('./openwebninja');
/* kept registered and working, but no longer the provider FindWear runs
   on. Nothing outside this file refers to it, so it can be dropped by
   deleting one require and one line below. */
const etsy = require('./etsy');

const PROVIDERS = {
  [openwebninja.name]: openwebninja,
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
  linkFault,
  toPrice,
  toAbsoluteUrl,
  FIELD_ALIASES,
  PROVIDERS
};
