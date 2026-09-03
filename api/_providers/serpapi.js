/* =========================================================
   Fynd — SerpApi product source (evaluation only)

   Searches Google Shopping through SerpApi and returns records in the
   shape api/_providers/product-source.js verifies. It is registered but
   NOT the default: nothing selects it unless PRODUCT_SOURCE=serpapi
   names it, exactly as with the Etsy adapter.

   It exists to be measured against OpenWeb Ninja on the only questions
   that matter for this product: how many records survive the
   verification gate, and how many of those carry a link to the
   retailer's own product page rather than to a comparison page.

   ---------------------------------------------------------
   The endpoint
   ---------------------------------------------------------
     GET https://serpapi.com/search.json
         ?engine=google_shopping_light&q=...&gl=us&hl=en&num=...
         &api_key=<SERPAPI_API_KEY>

   SerpApi authenticates by query parameter; it accepts no key header.
   That is a real difference from the OpenWeb Ninja adapter, which sends
   its key as x-api-key. The consequence is handled rather than ignored:
   the key is read only inside this serverless function, it is never
   included in a response, and every URL that could be logged goes
   through redact() below, which replaces the key with "***" first.

   `google_shopping_light` is the engine because it is the cheaper, faster
   Google Shopping surface. SERPAPI_ENGINE overrides it, so comparing it
   against the full `google_shopping` engine is one environment variable.

   ---------------------------------------------------------
   Where a direct retailer URL actually comes from
   ---------------------------------------------------------
   A Google Shopping result is Google's record of an item, so most of its
   URLs point back at Google:

     product_link          Google's product page for the item
     serpapi_product_api   SerpApi's own endpoint for the item
     thumbnail             a Google-hosted image

   None of those is a retailer product page and none is used as one. A
   direct merchant URL, when the result has one at all, arrives under a
   separate field, and WHICH field is the question scripts/probe-serpapi.js
   answers against a live response — it prints every URL-valued key on a
   result and classifies each one.

   Until a live response says otherwise this adapter reads the candidates
   in DIRECT_URL_KEYS and FAILS CLOSED: every candidate is put through
   looksDirect(), anything on a Google or SerpApi host is refused, and a
   record left without a retailer URL is dropped by the gate rather than
   linked somewhere it should not be. A wrong guess shows up as an empty
   result set with a populated `rejected` tally, never as a product card
   pointing at a comparison page.

   When the search result carries no direct link, the sellers for that
   product are fetched:

     GET https://serpapi.com/search.json?engine=google_product
         &product_id=...&offers=1

   which costs one extra SerpApi request per product. Every record that
   needs one is counted in diagnostics.requests, because requests per
   search is the number the cost per search is computed from.

   ---------------------------------------------------------
   Why the image cannot be attached to the wrong product
   ---------------------------------------------------------
   The title, image, brand and id always come from the search result they
   belong to. The price, retailer and link always come from ONE object —
   either that same result, or one seller object returned for that
   result's own product_id. The three are read out of a single object in
   one pass, so the price shown is the price at the shop being linked to.
   No path pairs one product's photo with another's link.

   ---------------------------------------------------------
   Credentials and settings
   ---------------------------------------------------------
     SERPAPI_API_KEY          required. Sent as the api_key query
                              parameter, because SerpApi takes no header.
     SERPAPI_ENGINE           default google_shopping_light.
     SERPAPI_COUNTRY          gl, default us.
     SERPAPI_LANGUAGE         hl, default en.
     SERPAPI_RESOLVE_SELLERS  "off" skips the per-product seller lookup.
                              Cheaper by one request per product, and
                              everything without an inline retailer link
                              is then dropped. Default on.
     SERPAPI_SELLER_BUDGET_MS total wall-clock budget for seller lookups,
                              default 6000. Whatever resolved by then is
                              what gets shown.
   ========================================================= */

'use strict';

const SEARCH_URL = 'https://serpapi.com/search.json';
const ACCOUNT_URL = 'https://serpapi.com/account';
const DEFAULT_ENGINE = 'google_shopping_light';
const PRODUCT_ENGINE = 'google_product';
const REQUEST_TIMEOUT = 15000;
const MAX_TERMS = 12;

/* Ask for more than the caller wants so the gate has slack to drop
   unusable records without emptying the page. SerpApi's Google Shopping
   surfaces return at most 100 per request. */
const API_LIMIT_MAX = 100;
const OVERFETCH = 2;

/* Seller lookups cost one request each, so they are bounded three ways:
   only products that need one are looked up, only until enough records
   have a link, and only until the wall-clock budget runs out. */
const SELLER_CONCURRENCY = 4;
const DEFAULT_SELLER_BUDGET_MS = 6000;

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

const engine = () => text(process.env.SERPAPI_ENGINE) || DEFAULT_ENGINE;
const sellersEnabled = () => text(process.env.SERPAPI_RESOLVE_SELLERS).toLowerCase() !== 'off';

/* The key rides in the query string because SerpApi accepts it nowhere
   else. Anything that might be printed — a log line, an error message,
   a probe's output — goes through this first. */
function redact(value) {
  const key = text(process.env.SERPAPI_API_KEY);
  const raw = String(value === undefined || value === null ? '' : value);
  return key ? raw.split(key).join('***') : raw;
}

/* -----------------------------------------------------------
   Intent -> query
   -----------------------------------------------------------

   Ordered so the phrase reads the way a shopper would type it:
   "women black oversized nike hoodie". Colour and fit lead because they
   are the strongest visual filters, the garment kind anchors the phrase,
   and leftover keywords trail behind.

   Only terms the shopper's own request produced are used. Nothing is
   added, and `season` is left out on purpose: it reads as a keyword to
   the search engine ("fall hoodie") and would narrow results on a word
   the shopper used descriptively rather than as a product attribute.

   No Google search operator is added either. A quoted phrase or a
   site: filter would be Fynd deciding what the shopper meant. */
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
   Reading one shopping result
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

/* Currency is read from the price string's own symbol or code rather
   than assumed, so a non-USD offer is not relabelled as dollars. */
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

/* The result's own image, in the order the source ranked them. Google
   serves shopping thumbnails from its own CDN, so this is usually a
   gstatic URL — that is the image Google holds for the item, not a
   substitute for a missing one, and the gate only requires that an image
   URL came from the source. A result with no photo gets no image. */
const IMAGE_LIST_KEYS = ['thumbnails', 'images', 'product_photos'];
const IMAGE_SINGLE_KEYS = ['thumbnail', 'serpapi_thumbnail', 'image', 'product_photo'];

function imageFrom(result) {
  for (const key of IMAGE_LIST_KEYS) {
    const list = result[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const url = typeof entry === 'string' ? entry : firstOf(entry, ['link', 'url', 'src', 'image', 'thumbnail']);
      if (text(url)) return text(url);
    }
  }
  const single = firstOf(result, IMAGE_SINGLE_KEYS);
  return text(single) || null;
}

/* Hosts that are never a retailer's product page. Google's own surfaces
   are here because `product_link` points at one by design, and SerpApi's
   are here because `serpapi_product_api` is an API endpoint, not a shop. */
const NOT_A_SHOP_HOST = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|googleadservices\.com|googleusercontent\.com|gstatic\.com|googlesyndication\.com|serpapi\.com)$/i;

/* Returns an absolute retailer URL, or null. Null for anything on a
   host above, anything unparseable, and anything that is not http(s).
   The authoritative check still runs in the verification gate — this one
   exists so the adapter knows whether it needs to go and find a link. */
function looksDirect(value) {
  const raw = text(value);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch (err) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (NOT_A_SHOP_HOST.test(url.hostname)) return null;
  return url.href;
}

/* Candidate fields for a merchant's own link, most explicit first.
   `product_link` is included last and is not a mistake: on a Google
   Shopping result it is Google's page and looksDirect() refuses it, but
   some result types put the merchant's URL there, and the refusal is
   what makes reading it safe. Nothing here is trusted for being present
   — only for surviving looksDirect(). */
const DIRECT_URL_KEYS = [
  'direct_link', 'merchant_link', 'seller_link', 'store_link', 'offer_link',
  'link', 'product_link', 'url'
];

/* The seller's own name, as the source states it. Never derived from a
   URL's hostname: "shop.nordstrom.com" is not a retailer's name, and
   inventing one is what the gate exists to prevent. */
const STORE_KEYS = ['source', 'merchant', 'store', 'seller', 'name', 'store_name', 'source_name', 'merchant_name', 'seller_name'];

const OFFER_PRICE_KEYS = ['price', 'base_price', 'extracted_price', 'total_price', 'offer_price', 'current_price', 'sale_price'];

/* Price, retailer and link out of ONE object. Returns null unless that
   object yields a real retailer URL, because a price and a shop name
   with no link to the thing being priced is not a product we can
   honestly show. */
function commerceFrom(source) {
  if (!source || typeof source !== 'object') return null;

  let productUrl = null;
  for (const key of DIRECT_URL_KEYS) {
    const candidate = looksDirect(source[key]);
    if (candidate) { productUrl = candidate; break; }
  }
  if (!productUrl) return null;

  const priceSource = firstOf(source, OFFER_PRICE_KEYS);
  return {
    price: toPrice(priceSource),
    currency: currencyFrom(priceSource),
    retailer: text(firstOf(source, STORE_KEYS)),
    productUrl
  };
}

/* The commerce fields a search result can supply on its own. Null when
   it carries no retailer link — which is the common case on Google
   Shopping, and what sends the product to the sellers endpoint. */
function inlineCommerce(result) {
  if (!result || typeof result !== 'object') return null;
  const nested = result.offer || result.offers;
  const embedded = Array.isArray(nested) ? nested.find((o) => o && typeof o === 'object') : nested;
  return commerceFrom(result) || commerceFrom(embedded);
}

/* Brand is optional. It is used when the source supplies one and omitted
   when it does not — the retailer's name is never copied into it,
   because "Nordstrom" is a shop, not the brand of everything it sells. */
function brandFrom(result) {
  const direct = firstOf(result, ['brand', 'product_brand', 'manufacturer']);
  if (text(direct)) return text(direct);

  const attributes = result.product_attributes || result.attributes || result.specs;
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    const fromAttributes = firstOf(attributes, ['Brand', 'brand', 'Manufacturer', 'manufacturer']);
    if (text(fromAttributes)) return text(fromAttributes);
  }
  return null;
}

/* Google marks used and refurbished listings. A shopper asking for a
   hoodie is not asking for a second-hand one, but nothing here invents
   a condition: only an explicit second-hand marking is acted on, and it
   is recorded rather than silently dropped. */
const secondHand = (result) => Boolean(text(firstOf(result, ['second_hand_condition', 'condition'])).match(/used|refurb|pre-?owned|second/i));

/* Maps one shopping result to one record.

   Title, image, brand and id come from the result itself. Price,
   retailer and link come from one object, when the result already
   carries a real retailer URL. When it does not, those three are left
   absent TOGETHER — never half-filled — and search() fills them from
   that product's own sellers, or the gate drops the record. */
function toRecord(result) {
  if (!result || typeof result !== 'object') return null;

  const commerce = inlineCommerce(result);

  const record = {
    title: text(firstOf(result, ['title', 'product_title', 'name'])),
    imageUrl: imageFrom(result),
    brand: brandFrom(result),
    sku: text(firstOf(result, ['product_id', 'productId', 'id'])) || undefined,

    /* all three from the same object, or none of them */
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

/* Prefers the seller the search result named, so the card shows the shop
   the search actually found, and falls back to the first seller with a
   usable link. */
function pickSeller(sellers, preferredStore) {
  const list = Array.isArray(sellers) ? sellers.filter((s) => s && typeof s === 'object') : [];
  const wanted = text(preferredStore).toLowerCase();

  if (wanted) {
    for (const seller of list) {
      const store = text(firstOf(seller, STORE_KEYS)).toLowerCase();
      if (store && store === wanted) {
        const commerce = commerceFrom(seller);
        if (commerce) return commerce;
      }
    }
  }
  for (const seller of list) {
    const commerce = commerceFrom(seller);
    if (commerce) return commerce;
  }
  return null;
}

/* -----------------------------------------------------------
   The request
   ----------------------------------------------------------- */

/* SerpApi returns the shopping list under `shopping_results`. The other
   keys are read too because the engine decides which one it fills, and
   an engine change should not silently return nothing. */
function resultsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['shopping_results', 'inline_shopping_results', 'immersive_products', 'organic_results', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

/* The sellers for one product, under whichever of the documented shapes
   the response uses. Unrecognised shapes yield nothing, which drops the
   record rather than guessing at a link. */
function sellersFrom(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const containers = [
    payload.sellers_results,
    payload.product_results,
    payload
  ];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of ['online_sellers', 'sellers', 'offers', 'stores']) {
      if (Array.isArray(container[key])) return container[key];
    }
  }
  return [];
}

/* Describes a payload's structure so a parsing miss can be seen in a
   log. Key names only — never a value, so nothing from a response body
   can leak through it. */
function shapeOf(payload) {
  if (Array.isArray(payload)) return `array[${payload.length}]`;
  if (!payload || typeof payload !== 'object') return String(typeof payload);
  const parts = Object.keys(payload).map((key) => {
    const value = payload[key];
    if (Array.isArray(value)) return `${key}=array[${value.length}]`;
    if (value && typeof value === 'object') return `${key}={${Object.keys(value).join(',')}}`;
    return key;
  });
  return `{${parts.join(', ')}}`;
}

/* Every SerpApi request this process makes, counted. Requests per search
   is what the cost per search is computed from, so it is measured rather
   than assumed. */
function newTally() {
  return { search: 0, sellers: 0, total: 0 };
}

/* One GET against SerpApi. The key is added here and nowhere else, and
   no thrown message or log line carries it: the URL is redacted before
   it can reach either. */
async function apiGet(params, tally, kind) {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error('SERPAPI_API_KEY is not set');

  const query = new URLSearchParams(params);
  query.set('api_key', key);
  query.set('output', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    if (tally) { tally[kind] += 1; tally.total += 1; }
    response = await fetch(`${SEARCH_URL}?${query.toString()}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    /* 429 is SerpApi's monthly search allowance, which is worth naming:
       it is the one failure that is not a bug in this adapter. */
    const note = response.status === 429 ? ' (SerpApi search allowance exhausted)' : '';
    throw new Error(`SerpApi responded ${response.status}${note}: ${redact(detail).slice(0, 200)}`);
  }

  const payload = await response.json();
  /* SerpApi reports some failures with 200 and an `error` string */
  if (payload && typeof payload === 'object' && payload.error) {
    throw new Error(`SerpApi error: ${redact(payload.error).slice(0, 200)}`);
  }
  return payload;
}

/* A failure here is not fatal: that one product ends up without a link
   and the gate drops it, rather than the whole search failing because
   one lookup did. */
async function sellersFor(productId, region, tally) {
  try {
    const payload = await apiGet({
      engine: PRODUCT_ENGINE,
      product_id: String(productId),
      offers: '1',
      gl: region.country,
      hl: region.language
    }, tally, 'sellers');
    const sellers = sellersFrom(payload);
    return { sellers, failed: false, shape: sellers.length ? null : shapeOf(payload) };
  } catch (err) {
    console.warn('Seller lookup failed for product', String(productId), redact(err && err.message));
    return { sellers: [], failed: true, shape: null };
  }
}

/* Fills in the records that arrived without a retailer link, in small
   parallel batches, stopping as soon as enough records have one or the
   budget expires. Mutates in place; a record left unresolved keeps no
   price, retailer or URL and is dropped by the gate. */
async function resolveMissingSellers(records, wanted, region, stats, tally) {
  const t = stats || {};
  t.neededSellerLookup = records.filter((r) => !r.productUrl).length;
  t.lookupsMade = 0;
  t.lookupsFailed = 0;
  t.lookupsEmpty = 0;
  t.resolvedFromSellers = 0;
  /* sellers came back, but not one carried a usable retailer link — the
     URL rule doing its job, told apart from finding no sellers at all */
  t.noDirectLinkInSellers = 0;
  t.budgetExpired = false;
  t.noProductId = records.filter((r) => !r.productUrl && !r.sku).length;
  t.sellersShape = null;

  if (!sellersEnabled()) { t.skipped = true; return t; }

  const budget = Number(process.env.SERPAPI_SELLER_BUDGET_MS) || DEFAULT_SELLER_BUDGET_MS;
  const deadline = Date.now() + budget;
  const pending = records.filter((r) => !r.productUrl && r.sku);
  let resolved = records.filter((r) => r.productUrl).length;

  for (let i = 0; i < pending.length; i += SELLER_CONCURRENCY) {
    if (resolved >= wanted) break;
    if (Date.now() >= deadline) { t.budgetExpired = true; break; }

    const batch = pending.slice(i, i + SELLER_CONCURRENCY);
    const found = await Promise.all(batch.map(async (record) => {
      t.lookupsMade += 1;
      const result = await sellersFor(record.sku, region, tally);
      if (result.failed) { t.lookupsFailed += 1; return null; }
      if (!result.sellers.length) {
        t.lookupsEmpty += 1;
        /* one sample is enough to see whether parsing is the problem */
        if (!t.sellersShape) t.sellersShape = result.shape;
        return null;
      }
      const commerce = pickSeller(result.sellers, record.retailerHint);
      if (!commerce) t.noDirectLinkInSellers += 1;
      return commerce;
    }));

    found.forEach((commerce, n) => {
      if (!commerce) return;
      const record = batch[n];
      /* all four together, from the one seller they came from */
      record.price = commerce.price;
      record.currency = commerce.currency;
      record.retailer = commerce.retailer;
      record.productUrl = commerce.productUrl;
      resolved += 1;
      t.resolvedFromSellers += 1;
    });
  }
  return t;
}

/* The shopper's stated budget is applied here rather than sent upstream.
   Google Shopping takes a price range through its `tbs` filter, whose
   support on the light engine is unconfirmed — sending an unconfirmed
   filter risks narrowing a search on a parameter the engine may read
   differently. Dropping an over-budget record is safe: it removes a real
   product from the page, it never invents one. */
function withinBudget(record, intent) {
  if (!intent || typeof record.price !== 'number') return true;
  if (intent.maxPrice && record.price > intent.maxPrice) return false;
  if (intent.minPrice && record.price < intent.minPrice) return false;
  return true;
}

async function search(intent, options) {
  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);
  const region = {
    country: process.env.SERPAPI_COUNTRY || 'us',
    language: process.env.SERPAPI_LANGUAGE || 'en'
  };
  const tally = newTally();

  const payload = await apiGet({
    engine: engine(),
    q: queryFrom(intent) || 'clothing',
    gl: region.country,
    hl: region.language,
    num: String(Math.min(wanted * OVERFETCH, API_LIMIT_MAX))
  }, tally, 'search');

  const results = resultsFrom(payload);

  /* Every stage a record can be lost at, counted. Without this a search
     that returns nothing looks the same whether the source had no stock,
     the results could not be parsed, the links could not be obtained, or
     the budget filter took them all. */
  const diagnostics = {
    engine: engine(),
    returnedByProvider: results.length,
    searchShape: results.length ? null : shapeOf(payload)
  };

  const records = results.map((result) => {
    const record = toRecord(result);
    if (!record) return null;
    /* remembered only to prefer the same shop when looking up sellers;
       never displayed, and never used to build a URL */
    record.retailerHint = text(firstOf(result, STORE_KEYS));
    return record;
  }).filter(Boolean);

  diagnostics.normalized = records.length;
  diagnostics.withInlineLink = records.filter((r) => r.productUrl).length;
  diagnostics.secondHand = results.filter(secondHand).length;

  diagnostics.sellers = await resolveMissingSellers(records, wanted, region, {}, tally);

  records.forEach((r) => { delete r.retailerHint; });
  diagnostics.withAnyLink = records.filter((r) => r.productUrl).length;

  const withinLimits = records.filter((r) => withinBudget(r, intent));
  diagnostics.droppedOverBudget = records.length - withinLimits.length;
  diagnostics.requests = tally;

  /* carried on the array so /api/search can report it without every
     adapter having to grow a new return shape */
  return Object.assign(withinLimits, { diagnostics });
}

/* The plan and the searches left on it, for the benchmark's preflight.
   Not used by /api/search: a shopper's search never spends a request on
   asking about the account. */
async function account() {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error('SERPAPI_API_KEY is not set');
  const response = await fetch(`${ACCOUNT_URL}?api_key=${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`SerpApi account responded ${response.status}`);
  return response.json();
}

module.exports = {
  name: 'serpapi',
  /* No default: the retailer must come from the seller itself. A source
     spanning many shops has no single retailer to fall back on, and
     naming one would attribute a product to the wrong shop. */
  defaultRetailer: null,
  configured: () => Boolean(process.env.SERPAPI_API_KEY),
  search,
  account,
  /* exported for scripts/test-serpapi.js, probe-serpapi.js and bench-serpapi.js */
  toRecord,
  queryFrom,
  looksDirect,
  commerceFrom,
  inlineCommerce,
  pickSeller,
  sellersFor,
  sellersFrom,
  resolveMissingSellers,
  imageFrom,
  brandFrom,
  toPrice,
  currencyFrom,
  resultsFrom,
  withinBudget,
  shapeOf,
  redact,
  newTally,
  apiGet,
  engine,
  secondHand,
  DIRECT_URL_KEYS,
  STORE_KEYS,
  SEARCH_URL,
  ACCOUNT_URL,
  DEFAULT_ENGINE,
  PRODUCT_ENGINE
};
