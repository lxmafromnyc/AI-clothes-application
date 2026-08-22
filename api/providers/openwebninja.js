/* =========================================================
   FindWear — OpenWeb Ninja product source

   Searches Google Shopping's cross-retailer index through OpenWeb Ninja's
   Real-Time Product Search API and returns records in the shape
   api/providers/product-source.js verifies.

   This is the provider that gives FindWear broad coverage: one query
   reaches Amazon, Walmart, Target, Best Buy, eBay, Nordstrom and the long
   tail of clothing merchants, rather than a single retailer's catalogue.

   ---------------------------------------------------------
   The endpoint
   ---------------------------------------------------------
     GET https://api.openwebninja.com/realtime-product-search/v2/search
     header: x-api-key: <OPENWEBNINJA_API_KEY>

   Request parameters used here, all confirmed against the OpenAPI-derived
   manifest shipped in the vendor's official MCP server package
   (@openwebninja/mcp-server, dist/generated/manifest.js):

     q                 required, the search phrase
     country           ISO 3166-1 alpha-2, default "us"
     language          ISO 639-1, default "en"
     limit             1..120, max products to return
     min_price         number, floor
     max_price         number, ceiling
     sort_by           BEST_MATCH | TOP_RATED | LOWEST_PRICE | HIGHEST_PRICE

   Parameters deliberately left alone: page, product_condition, stores,
   free_returns, free_shipping, on_sale, shoprs, return_filters. The
   interpreter does not produce intent for any of them, and setting one
   without the shopper asking would narrow their results on our guess.

   ---------------------------------------------------------
   Why the image cannot be attached to the wrong product
   ---------------------------------------------------------
   This is the property the provider was chosen for, so it is enforced
   structurally rather than by convention.

   A search result is one product object. That object carries its own
   photos AND its own merchant offer. toRecord() below reads both out of
   the SAME object in one pass: the image comes from `product`, the price,
   retailer and product URL come from `product`'s own offer. Nothing is
   looked up elsewhere, no second request is made, and there is no code
   path that can pair a photo from one record with a link from another.

   If a product arrives without photos, no image is substituted from
   anywhere — the field is left absent and the gate drops the record.
   Same for a product with no usable offer.

   ---------------------------------------------------------
   Response schema: what is verified and what is tolerated
   ---------------------------------------------------------
   The vendor documents the envelope as { status, request_id, data } with
   `data` carrying the product list. The per-field names below are drawn
   from the vendor's published response documentation. They could not be
   confirmed against a live call while this adapter was written, so the
   mapping is written to accept the documented spellings and their obvious
   variants, and to FAIL CLOSED on anything else: an unrecognised shape
   yields a record missing its required fields, which the gate rejects and
   counts. A wrong guess therefore shows up as an empty result set with a
   populated `rejected` tally — never as an invented product.

   Run `node scripts/probe-openwebninja.js "<query>"` with a real key to
   print the live field names and confirm the mapping.

   ---------------------------------------------------------
   Credentials
   ---------------------------------------------------------
     OPENWEBNINJA_API_KEY   required. Sent as the x-api-key header. Read
                            only inside this serverless function; it is
                            never included in a response and never reaches
                            a browser.
   ========================================================= */

'use strict';

const API_ROOT = 'https://api.openwebninja.com/realtime-product-search/v2';
const SEARCH_URL = `${API_ROOT}/search`;
const REQUEST_TIMEOUT = 15000;
const MAX_TERMS = 12;

/* The API caps `limit` at 120. We ask for a little more than the caller
   wants so the gate has slack to drop unusable records without emptying
   the page, but never more than the endpoint accepts. */
const API_LIMIT_MAX = 120;
const OVERFETCH = 2;

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/* -----------------------------------------------------------
   Intent -> query
   ----------------------------------------------------------- */

/* Ordered so the phrase reads the way a shopper would type it:
   "women black oversized nike hoodie". Colour and fit lead because they
   are the strongest visual filters, the garment kind anchors the phrase,
   and leftover keywords trail behind.

   Only terms the shopper's own request produced are used. Nothing is
   added, and `season` is left out on purpose: it reads as a keyword to
   the search engine ("fall hoodie") and narrows results on a word the
   shopper used descriptively rather than as a product attribute. */
const TERM_ORDER = ['gender', 'colors', 'fits', 'styles', 'brands', 'categories', 'occasions', 'keywords'];

function queryFrom(intent) {
  const i = intent && typeof intent === 'object' ? intent : {};
  const parts = [];
  for (const field of TERM_ORDER) {
    const value = i[field];
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) parts.push(...value);
  }

  const seen = new Set();
  const terms = [];
  for (const part of parts) {
    const term = text(part).toLowerCase();
    if (!term || term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.join(' ');
}

/* -----------------------------------------------------------
   Reading one product record
   ----------------------------------------------------------- */

const firstOf = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return undefined;
};

/* "$79.99", "US$1,299.00", "79.99 USD", 79.99 -> 79.99 */
function toPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = text(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

/* Currency is read from the price string's own symbol or code rather than
   assumed, so a non-USD offer is not relabelled as dollars. Absent means
   absent; the gate's default applies only when nothing was supplied. */
const CURRENCY_SYMBOLS = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR' };

function currencyFrom(value) {
  const raw = text(value);
  if (!raw) return undefined;
  const code = raw.match(/\b(USD|GBP|EUR|JPY|INR|CAD|AUD|CHF|SEK|PLN|MXN|BRL)\b/i);
  if (code) return code[1].toUpperCase();
  for (const symbol of Object.keys(CURRENCY_SYMBOLS)) {
    if (raw.includes(symbol)) return CURRENCY_SYMBOLS[symbol];
  }
  return undefined;
}

/* The product's own photos, in the order the source ranked them. Never
   another product's, and never fetched from anywhere else. */
const PHOTO_LIST_KEYS = ['product_photos', 'productPhotos', 'photos', 'images', 'product_images'];
const PHOTO_SINGLE_KEYS = ['product_photo', 'productPhoto', 'product_image', 'thumbnail', 'image', 'image_url'];

function imageFrom(product) {
  for (const key of PHOTO_LIST_KEYS) {
    const list = product[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      /* a photo entry is either a URL string or an object wrapping one */
      const url = typeof entry === 'string' ? entry : firstOf(entry, ['url', 'link', 'src', 'image_url']);
      if (text(url)) return text(url);
    }
  }
  const single = firstOf(product, PHOTO_SINGLE_KEYS);
  return text(single) || null;
}

/* The merchant offer belonging to THIS product.

   `offer` is the documented single-offer field on a search result. The
   array forms are accepted because the same product shape is reused by
   the vendor's offers endpoint. Whichever is found, one offer object is
   returned and every commercial field is then read out of that one
   object, so price, retailer and URL always describe the same listing. */
function offerFrom(product) {
  const direct = product.offer || product.top_offer || product.best_offer;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;

  for (const key of ['offers', 'product_offers', 'all_offers']) {
    const list = product[key];
    if (Array.isArray(list)) {
      const found = list.find((o) => o && typeof o === 'object');
      if (found) return found;
    }
  }
  return null;
}

/* The retailer's own product page.

   `offer_page_url` is the documented direct buy-now link. The product-level
   `product_page_url` is Google Shopping's own page for the item and is
   deliberately NOT accepted here: it is not a retailer product page, and
   presenting it as one would misrepresent where the card leads. The gate
   rejects Google hosts as a second line of defence. */
const OFFER_URL_KEYS = ['offer_page_url', 'offerPageUrl', 'buy_now_url', 'offer_url', 'link', 'url', 'product_url'];
const STORE_KEYS = ['store_name', 'storeName', 'merchant_name', 'seller_name', 'store', 'merchant', 'seller', 'source'];
const OFFER_PRICE_KEYS = ['price', 'offer_price', 'current_price', 'sale_price', 'store_price'];

/* Brand is optional. It is used when the source supplies one and omitted
   when it does not — the retailer's name is never copied into it, because
   "Walmart" is not the brand of a hoodie Walmart sells. */
function brandFrom(product) {
  const direct = firstOf(product, ['brand', 'product_brand', 'brand_name', 'manufacturer']);
  if (text(direct)) return text(direct);

  const attributes = product.product_attributes || product.attributes;
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    const fromAttributes = firstOf(attributes, ['Brand', 'brand', 'Manufacturer', 'manufacturer']);
    if (text(fromAttributes)) return text(fromAttributes);
  }
  return null;
}

/* Maps one product to one record. Every value comes from this product or
   from this product's own offer; a field neither carries is omitted, so
   the gate rejects the record rather than displaying a blank or a guess. */
function toRecord(product) {
  if (!product || typeof product !== 'object') return null;

  const offer = offerFrom(product);
  const priceSource = offer ? firstOf(offer, OFFER_PRICE_KEYS) : undefined;

  const record = {
    title: text(firstOf(product, ['product_title', 'productTitle', 'title', 'name'])),
    /* from the product record itself */
    imageUrl: imageFrom(product),
    /* all three from the SAME offer object */
    price: toPrice(priceSource),
    currency: currencyFrom(priceSource),
    retailer: offer ? text(firstOf(offer, STORE_KEYS)) : '',
    productUrl: offer ? text(firstOf(offer, OFFER_URL_KEYS)) : '',

    brand: brandFrom(product),
    sku: text(firstOf(product, ['product_id', 'productId', 'id'])) || undefined
  };

  /* strip absent values so the gate sees a missing field, not an empty one */
  Object.keys(record).forEach((k) => {
    if (record[k] === null || record[k] === undefined || record[k] === '') delete record[k];
  });
  return record;
}

/* -----------------------------------------------------------
   The request
   ----------------------------------------------------------- */

/* The vendor documents the envelope as { status, request_id, data }.
   Both a bare array and a products-wrapped object are accepted. */
function resultsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const data = payload.data !== undefined ? payload.data : payload;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['products', 'results', 'items']) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  return [];
}

async function search(intent, options) {
  const key = process.env.OPENWEBNINJA_API_KEY;
  if (!key) throw new Error('OPENWEBNINJA_API_KEY is not set');

  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);
  const params = new URLSearchParams({
    q: queryFrom(intent) || 'clothing',
    country: process.env.OPENWEBNINJA_COUNTRY || 'us',
    language: process.env.OPENWEBNINJA_LANGUAGE || 'en',
    limit: String(Math.min(wanted * OVERFETCH, API_LIMIT_MAX)),
    sort_by: 'BEST_MATCH'
  });

  /* The shopper's stated budget is passed to the source so the filtering
     happens where the catalogue is, not after the fact. */
  if (intent && intent.minPrice) params.set('min_price', String(intent.minPrice));
  if (intent && intent.maxPrice) params.set('max_price', String(intent.maxPrice));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(`${SEARCH_URL}?${params.toString()}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    /* logged server-side only; /api/search returns a generic message so
       the key and the upstream detail never reach a browser */
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenWeb Ninja responded ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const records = resultsFrom(payload).map(toRecord).filter(Boolean);

  /* The source filters on price, but an offer that slipped past the
     ceiling is dropped rather than shown: "under $80" is the shopper's
     instruction, not a suggestion. Dropping is safe — it removes a real
     product from the page, it never invents one. */
  return records.filter((r) => withinBudget(r, intent));
}

function withinBudget(record, intent) {
  if (!intent || typeof record.price !== 'number') return true;
  if (intent.maxPrice && record.price > intent.maxPrice) return false;
  if (intent.minPrice && record.price < intent.minPrice) return false;
  return true;
}

module.exports = {
  name: 'openwebninja',
  /* No default: the retailer must come from the offer itself. A provider
     spanning many stores has no single retailer to fall back on, and
     naming one would attribute a product to the wrong shop. */
  defaultRetailer: null,
  configured: () => Boolean(process.env.OPENWEBNINJA_API_KEY),
  search,
  /* exported for tests and for scripts/probe-openwebninja.js */
  toRecord,
  queryFrom,
  imageFrom,
  offerFrom,
  brandFrom,
  toPrice,
  currencyFrom,
  resultsFrom,
  withinBudget,
  SEARCH_URL
};
