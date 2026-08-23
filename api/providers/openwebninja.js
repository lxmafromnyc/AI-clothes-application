/* =========================================================
   Fynd — OpenWeb Ninja product source

   Searches Google Shopping's cross-retailer index through OpenWeb Ninja's
   Real-Time Product Search API and returns records in the shape
   api/providers/product-source.js verifies.

   This is the provider that gives Fynd broad coverage: one query
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
   Where a direct retailer URL actually comes from
   ---------------------------------------------------------
   /search returns Google Shopping's PRODUCT view. Its `product_page_url`
   is a Google URL — Google's own page for the item — and a live response
   confirmed it can even be a /search URL. It is never the retailer's
   product page, so it is never used as one. `store_name` is a domain
   ("nike.com"), which the store-reviews endpoint corroborates by keying
   on `store_domain`; a domain is not a URL and no URL is built from it.

   The per-seller links live behind a second endpoint:

     GET /realtime-product-search/v2/product-offers?product_id=...
     "Get all offers available for a product. Each page of offers
      contains offers from 10 sellers."

   So a direct retailer URL costs one extra request per product. This
   adapter therefore:

     1. reads whatever the search record already carries, and uses it
        directly if it yields a real retailer URL — some records do
     2. otherwise asks /product-offers for that product_id and takes the
        first offer that has one
     3. otherwise leaves the record without a URL, and the gate drops it

   Nothing is inferred at any step. A product with no obtainable retailer
   link is dropped, never linked to Google and never linked to a URL
   assembled out of a store domain.

   ---------------------------------------------------------
   Why the image cannot be attached to the wrong product
   ---------------------------------------------------------
   The image always comes from the product record it belongs to, and the
   price, retailer and link always come from ONE offer — either the offer
   embedded in that product record, or one offer object returned by
   /product-offers for that product's own id. The three are read out of
   the same object in one pass, so the price shown is the price at the
   shop being linked to. There is no path that pairs one product's photo
   with another's link.

   A product with no photos gets no image; none is substituted.

   ---------------------------------------------------------
   Response shape: what is confirmed
   ---------------------------------------------------------
   Confirmed from a live response: product_title, price, product_photos,
   store_name and product_page_url appear at the TOP level of a search
   record, not only nested under `offer`. Both shapes are read, because
   both have been observed.

   The per-offer field names from /product-offers are not confirmed, so
   they are matched tolerantly and FAIL CLOSED: an unrecognised shape
   yields no URL, and the gate drops the record. A wrong guess shows up
   as an empty result set with a populated `rejected` tally, never as a
   product pointing somewhere it should not.

   ---------------------------------------------------------
   Credentials
   ---------------------------------------------------------
     OPENWEBNINJA_API_KEY   required. Sent as the x-api-key header. Read
                            only inside this serverless function; it is
                            never included in a response and never reaches
                            a browser.
     OPENWEBNINJA_RESOLVE_OFFERS
                            set to "off" to skip the /product-offers step.
                            Cheaper by one request per product, and almost
                            everything is then dropped for having no
                            retailer link. Default on.
     OPENWEBNINJA_OFFER_BUDGET_MS
                            total wall-clock budget for the offer lookups,
                            default 6000. Whatever is resolved when it
                            expires is what gets shown.
   ========================================================= */

'use strict';

const { createCallBudget } = require('../_call-budget');

const API_ROOT = 'https://api.openwebninja.com/realtime-product-search/v2';
const SEARCH_URL = `${API_ROOT}/search`;
const OFFERS_URL = `${API_ROOT}/product-offers`;
const REQUEST_TIMEOUT = 15000;
const MAX_TERMS = 12;

/* The API caps `limit` at 120. We ask for a little more than the caller
   wants so the gate has slack to drop unusable records without emptying
   the page, but never more than the endpoint accepts. */
const API_LIMIT_MAX = 120;
const OVERFETCH = 2;

/* Offer lookups cost one request each, so they are bounded three ways:
   only products that need one are looked up, only until enough records
   have a link, and only until the wall-clock budget runs out. Whatever
   resolved by then is what gets shown. */
const OFFER_CONCURRENCY = 4;
const DEFAULT_OFFER_BUDGET_MS = 6000;
const offersEnabled = () => text(process.env.OPENWEBNINJA_RESOLVE_OFFERS).toLowerCase() !== 'off';

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

/* Google's own surfaces. `product_page_url` points at one of these by
   design, so it is recognised and refused rather than displayed. */
const GOOGLE_HOST = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|googleadservices\.com|googleusercontent\.com|gstatic\.com|googlesyndication\.com)$/i;

/* Returns an absolute retailer URL, or null. Null for anything on a
   Google host, anything unparseable, and anything that is not http(s) —
   so a value that is not a retailer link can never be mistaken for one.
   The authoritative check still runs in the verification gate; this one
   exists so the adapter knows whether it needs to go and find a link. */
function looksDirect(value) {
  const raw = text(value);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch (err) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (GOOGLE_HOST.test(url.hostname)) return null;
  return url.href;
}

/* Field names carrying a seller's own link. `product_page_url` is
   deliberately absent: it is Google's page for the item, and a live
   response returned a google.com/search URL in it. */
const OFFER_URL_KEYS = ['offer_page_url', 'offerPageUrl', 'buy_now_url', 'offer_url', 'seller_link', 'link', 'url'];
const STORE_KEYS = ['store_name', 'storeName', 'merchant_name', 'seller_name', 'store', 'merchant', 'seller', 'source', 'store_domain'];
const OFFER_PRICE_KEYS = ['price', 'offer_price', 'current_price', 'sale_price', 'store_price'];

/* An offer embedded in a search record. Live responses put these at the
   top level of the product too, so the product itself is accepted as an
   offer-like object — the fields are read from whichever carries them,
   but always from ONE object, never mixed between two. */
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

/* Price, retailer and link out of one offer-like object. Returns null
   unless that object yields a real retailer URL, because a price and a
   shop name with no link to the thing being priced is not a product we
   can honestly show. */
function commerceFrom(source) {
  if (!source || typeof source !== 'object') return null;
  const productUrl = looksDirect(firstOf(source, OFFER_URL_KEYS));
  if (!productUrl) return null;

  const priceSource = firstOf(source, OFFER_PRICE_KEYS);
  return {
    price: toPrice(priceSource),
    currency: currencyFrom(priceSource),
    retailer: text(firstOf(source, STORE_KEYS)),
    productUrl
  };
}

/* The commerce fields a search record can supply on its own: from its
   embedded offer if it has one, otherwise from its own top-level fields.
   Null when neither yields a retailer link — which is the common case,
   and what sends this product to /product-offers. */
function inlineCommerce(product) {
  return commerceFrom(offerFrom(product)) || commerceFrom(product);
}

/* Brand is optional. It is used when the source supplies one and omitted
   when it does not — the retailer's name is never copied into it, because
   "nike.com" is a shop, not the brand of everything it sells. */
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

/* Maps one product to one record.

   The title, image, brand and id come from the product itself. The
   price, retailer and link come from one offer, when the record already
   carries one that has a real retailer URL. When it does not, those
   three are left absent together — never half-filled — and search()
   fills them from that product's own offers, or the gate drops it. */
function toRecord(product) {
  if (!product || typeof product !== 'object') return null;

  const commerce = inlineCommerce(product);

  const record = {
    title: text(firstOf(product, ['product_title', 'productTitle', 'title', 'name'])),
    imageUrl: imageFrom(product),
    brand: brandFrom(product),
    sku: text(firstOf(product, ['product_id', 'productId', 'id'])) || undefined,

    /* all three from the same offer, or none of them */
    price: commerce ? commerce.price : undefined,
    currency: commerce ? commerce.currency : undefined,
    retailer: commerce ? commerce.retailer : undefined,
    productUrl: commerce ? commerce.productUrl : undefined
  };

  /* strip absent values so the gate sees a missing field, not an empty one */
  Object.keys(record).forEach((k) => {
    if (record[k] === null || record[k] === undefined || record[k] === '') delete record[k];
  });
  return record;
}

/* Prefers the offer from the shop the search result named, so the card
   shows the retailer the search actually found, and falls back to the
   first seller that has a usable link. */
function pickOffer(offers, preferredStore) {
  const list = Array.isArray(offers) ? offers.filter((o) => o && typeof o === 'object') : [];
  const wanted = text(preferredStore).toLowerCase();

  if (wanted) {
    for (const offer of list) {
      const store = text(firstOf(offer, STORE_KEYS)).toLowerCase();
      if (store && store === wanted && commerceFrom(offer)) return commerceFrom(offer);
    }
  }
  for (const offer of list) {
    const commerce = commerceFrom(offer);
    if (commerce) return commerce;
  }
  return null;
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

/* Describes a payload's structure so a parsing miss can be seen in a log.
   Key names only — never a value, so nothing from a response body can
   leak through it. */
function shapeOf(payload) {
  if (Array.isArray(payload)) return `array[${payload.length}]`;
  if (!payload || typeof payload !== 'object') return String(typeof payload);
  const top = Object.keys(payload).join(',');
  const data = payload.data;
  if (Array.isArray(data)) return `{${top}} data=array[${data.length}]`;
  if (data && typeof data === 'object') return `{${top}} data={${Object.keys(data).join(',')}}`;
  return `{${top}} data=${typeof data}`;
}

/* One GET against the API. The key travels as a header, never in the
   query string, and the response body is never surfaced to a browser. */
async function apiGet(url, params) {
  const key = process.env.OPENWEBNINJA_API_KEY;
  if (!key) throw new Error('OPENWEBNINJA_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(`${url}?${params.toString()}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenWeb Ninja responded ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.json();
}

/* The sellers for one product. A failure here is not fatal: that one
   product ends up without a link and the gate drops it, rather than the
   whole search failing because one lookup did. */
async function offersFor(productId, region, budget) {
  /* the cap is checked before the call, not after: a refused lookup must
     cost nothing */
  if (budget && !budget.take()) return { offers: [], failed: false, capped: true, shape: null };
  const params = new URLSearchParams({ product_id: String(productId), country: region.country, language: region.language });
  try {
    const payload = await apiGet(OFFERS_URL, params);
    const offers = resultsFrom(payload);
    /* when nothing was found, the shape says whether the array is simply
       under a key resultsFrom does not read yet */
    return { offers, failed: false, shape: offers.length ? null : shapeOf(payload) };
  } catch (err) {
    console.warn('Offer lookup failed for product', String(productId), err && err.message);
    return { offers: [], failed: true, shape: null };
  }
}

/* Fills in the records that arrived without a retailer link, in small
   parallel batches, stopping as soon as enough records have one or the
   budget expires. Mutates in place; a record left unresolved keeps no
   price, retailer or URL and is dropped by the gate. */
async function resolveMissingOffers(records, wanted, region, stats, callBudget) {
  const tally = stats || {};
  tally.neededOfferLookup = records.filter((r) => !r.productUrl).length;
  tally.lookupsMade = 0;
  tally.lookupsFailed = 0;
  tally.lookupsEmpty = 0;
  tally.resolvedFromOffers = 0;
  /* offers came back, but not one carried a usable retailer link — the
     URL rule doing its job, told apart from finding no offers at all */
  tally.noDirectLinkInOffers = 0;
  tally.budgetExpired = false;
  tally.callCapReached = false;
  tally.noProductId = records.filter((r) => !r.productUrl && !r.sku).length;
  tally.offersShape = null;

  if (!offersEnabled()) { tally.skipped = true; return tally; }

  /* the LATENCY budget, in milliseconds — distinct from the call cap
     above, which bounds spend rather than time */
  const timeBudgetMs = Number(process.env.OPENWEBNINJA_OFFER_BUDGET_MS) || DEFAULT_OFFER_BUDGET_MS;
  const deadline = Date.now() + timeBudgetMs;
  const pending = records.filter((r) => !r.productUrl && r.sku);
  let resolved = records.filter((r) => r.productUrl).length;

  for (let i = 0; i < pending.length; i += OFFER_CONCURRENCY) {
    if (resolved >= wanted) break;
    if (Date.now() >= deadline) { tally.budgetExpired = true; break; }
    /* the call cap ends the fan-out outright: unlike the time budget,
       going over it costs money rather than latency */
    if (callBudget && callBudget.exhausted) { tally.callCapReached = true; break; }

    const batch = pending.slice(i, i + OFFER_CONCURRENCY);
    const found = await Promise.all(batch.map(async (record) => {
      const result = await offersFor(record.sku, region, callBudget);
      if (result.capped) { tally.callCapReached = true; return null; }
      tally.lookupsMade += 1;
      if (result.failed) { tally.lookupsFailed += 1; return null; }
      if (!result.offers.length) {
        tally.lookupsEmpty += 1;
        /* one sample is enough to see whether parsing is the problem */
        if (!tally.offersShape) tally.offersShape = result.shape;
        return null;
      }
      const commerce = pickOffer(result.offers, record.retailerHint);
      if (!commerce) tally.noDirectLinkInOffers += 1;
      return commerce;
    }));

    found.forEach((commerce, n) => {
      if (!commerce) return;
      const record = batch[n];
      /* all three together, from the one offer they came from */
      record.price = commerce.price;
      record.currency = commerce.currency;
      record.retailer = commerce.retailer;
      record.productUrl = commerce.productUrl;
      resolved += 1;
      tally.resolvedFromOffers += 1;
    });
  }
  return tally;
}

async function search(intent, options) {
  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);
  /* Every billable call this search makes comes out of here. The caller
     supplies one so /api/search can report what a single search cost;
     without one a default cap still applies, because an uncapped search
     is the thing this exists to prevent. */
  const budget = (options && options.budget) || createCallBudget();
  const region = {
    country: process.env.OPENWEBNINJA_COUNTRY || 'us',
    language: process.env.OPENWEBNINJA_LANGUAGE || 'en'
  };

  const params = new URLSearchParams({
    q: queryFrom(intent) || 'clothing',
    country: region.country,
    language: region.language,
    limit: String(Math.min(wanted * OVERFETCH, API_LIMIT_MAX)),
    sort_by: 'BEST_MATCH'
  });

  /* The shopper's stated budget is passed to the source so the filtering
     happens where the catalogue is, not after the fact. */
  if (intent && intent.minPrice) params.set('min_price', String(intent.minPrice));
  if (intent && intent.maxPrice) params.set('max_price', String(intent.maxPrice));

  /* the search itself is the first call against the cap */
  if (!budget.take()) throw new Error('Upstream call budget exhausted before the search could run.');
  const payload = await apiGet(SEARCH_URL, params);
  const products = resultsFrom(payload);

  /* Every stage a record can be lost at, counted. Without this a search
     that returns nothing looks the same whether the source had no stock,
     the offers could not be read, or the budget filter took them all. */
  const diagnostics = {
    returnedByProvider: products.length,
    searchShape: products.length ? null : shapeOf(payload)
  };

  const records = products.map((product) => {
    const record = toRecord(product);
    if (!record) return null;
    /* remembered only to prefer the same shop when looking up offers;
       never displayed, and never used to build a URL */
    record.retailerHint = text(firstOf(product, STORE_KEYS));
    return record;
  }).filter(Boolean);

  diagnostics.normalized = records.length;
  diagnostics.withInlineLink = records.filter((r) => r.productUrl).length;

  /* the search endpoint returns Google's product view, so most records
     arrive without a retailer link; this fetches the sellers for them */
  diagnostics.offers = await resolveMissingOffers(records, wanted, region, {}, budget);

  records.forEach((r) => { delete r.retailerHint; });
  diagnostics.withAnyLink = records.filter((r) => r.productUrl).length;

  /* The source filters on price, but an offer that slipped past the
     ceiling is dropped rather than shown: "under $80" is the shopper's
     instruction, not a suggestion. Dropping is safe — it removes a real
     product from the page, it never invents one. */
  const withinLimits = records.filter((r) => withinBudget(r, intent));
  diagnostics.droppedOverBudget = records.length - withinLimits.length;

  /* what this one search actually cost upstream */
  diagnostics.upstreamCalls = budget.report();

  /* carried on the array so /api/search can report it without every
     adapter having to grow a new return shape */
  return Object.assign(withinLimits, { diagnostics });
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
  looksDirect,
  commerceFrom,
  inlineCommerce,
  pickOffer,
  offersFor,
  resolveMissingOffers,
  OFFERS_URL,
  imageFrom,
  offerFrom,
  brandFrom,
  toPrice,
  currencyFrom,
  resultsFrom,
  withinBudget,
  shapeOf,
  SEARCH_URL
};
