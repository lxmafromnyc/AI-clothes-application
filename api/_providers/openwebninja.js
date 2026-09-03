/* =========================================================
   FindWear — OpenWeb Ninja product source

   Searches Google Shopping's cross-retailer index through OpenWeb Ninja's
   Real-Time Product Search API and returns records in the shape
   api/_providers/product-source.js verifies.

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

   Because step 2 is where the requests go, it is spent carefully: only
   on records the gate could actually show, only while the page is still
   short of products that would BE shown — not merely of resolved links
   — and never more than `wanted + LOOKUP_SLACK` times. See "Which
   records are worth a lookup" below.

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

/* How far past its target one search may keep looking for products it
   can actually show. Aiming at shown products rather than at resolved
   links means an unshowable answer no longer ends the search, so
   without a ceiling a page of poor records would keep buying lookups
   down the whole candidate list.

   Measured over the scenarios in scripts/bench-offer-resolution.js, on
   one seeded set of records, against the behaviour this replaced
   (18.3 requests, 8.5 products shown, 2414ms):

     slack  0   13.0 requests   6.8 shown   cheapest, and thinnest
     slack  4   16.3 requests   8.5 shown   same page, fewer requests
     slack  8   18.5 requests   9.8 shown   same requests, fuller page
     slack 12   19.2 requests  10.3 shown   diminishing

   Four is set because the object here is to spend less: it holds the
   page where it was while cutting requests, latency and wasted
   lookups. Eight is the value to raise it to if filling the grid
   matters more than the request count. */
const LOOKUP_SLACK = 4;
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
async function offersFor(productId, region) {
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

/* -----------------------------------------------------------
   Which records are worth a lookup
   -----------------------------------------------------------

   A lookup costs one request, so it is spent only on a record that
   could actually end up on the page. The gate decides that, not a copy
   of its rules here: a copy would drift from it, and then lookups would
   be skipped for records the gate would have shown.

   What is NOT used to skip a lookup is the record's own stated price,
   though it is the obvious thing to try. It is not a bound on what the
   sellers charge: the same record priced at $87.97 has been seen with
   one seller offer at $54 and another at $240 — both cheaper and dearer
   than the price the search returned. Skipping a record for being over
   the shopper's ceiling would therefore drop products that come in
   under it once the offer is read, so the budget is applied where it
   can be applied honestly: to the offer's own price, after the lookup.

   product-source.js requires this adapter, so requiring it back at
   module load would hand over a half-built exports object. By the time
   any of this runs the module is whole, so it is required on first use
   and kept. */
let gateModule = null;
const gate = () => (gateModule || (gateModule = require('./product-source')));

/* A stand-in offer, used only to ask the gate a question: given a
   perfect price, retailer and link, would this record be shown? It is
   never stored on a record and never displayed — the answer is about
   the fields a lookup CANNOT supply, which is title and image. */
const PERFECT_OFFER = { price: 1, retailer: 'x', productUrl: 'https://example.com/p/1' };

/* The gate's own reason this record can never be shown, or null when a
   lookup could still save it. */
function unfitReason(record) {
  const result = gate().toProduct(Object.assign({}, record, PERFECT_OFFER), {});
  return result.ok ? null : result.reason;
}

/* How many products would actually be shown right now.

   Counted through the gate rather than by counting links, because a
   record can have a link and still not be displayable: the URL can be a
   redirect, the offer can carry no price or no shop, the price can be
   over budget, and two records can resolve to the same URL, which the
   gate shows once. Counting links instead of products is what used to
   stop the loop at twelve links and leave the page with nine cards. */
function verifiedCount(records, intent) {
  const urls = new Set();
  for (const record of records) {
    if (!record.productUrl) continue;
    if (!withinBudget(record, intent)) continue;
    if (gate().toProduct(record, {}).ok) urls.add(record.productUrl);
  }
  return urls.size;
}

/* One product's sellers, reduced to the offer worth showing, or null.
   Every outcome is counted where it happens, so a search that resolves
   nothing says whether the lookups failed, came back empty, or came
   back carrying no link that could be shown. */
async function lookupFor(record, region, tally) {
  tally.lookupsMade += 1;
  const result = await offersFor(record.sku, region);
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
}

/* Fills in the records that arrived without a retailer link, a few at
   a time, stopping as soon as enough of them would actually be SHOWN or
   the budget expires. Mutates in place; a record left
   unresolved keeps no price, retailer or URL and is dropped by the gate.

   Three things bound what this can spend, and none of them can be
   exceeded: a lookup is only ever made for a candidate that could end
   up on the page, no candidate is looked up twice, and the total is
   capped at `wanted + LOOKUP_SLACK`. The wall-clock budget still cuts
   it short before any of them. */
async function resolveMissingOffers(records, wanted, region, stats, intent) {
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
  tally.noProductId = records.filter((r) => !r.productUrl && !r.sku).length;
  tally.offersShape = null;
  /* records a lookup could not have saved, by the gate's own reason for
     each, so a skipped record is accounted for rather than silent */
  tally.skippedUnfit = {};

  if (!offersEnabled()) { tally.skipped = true; return tally; }

  const budget = Number(process.env.OPENWEBNINJA_OFFER_BUDGET_MS) || DEFAULT_OFFER_BUDGET_MS;
  const deadline = Date.now() + budget;

  /* The candidates, in the order the source ranked them. */
  const pending = [];
  for (const record of records) {
    if (record.productUrl || !record.sku) continue;
    const unfit = unfitReason(record);
    if (unfit) {
      tally.skippedUnfit[unfit] = (tally.skippedUnfit[unfit] || 0) + 1;
      continue;
    }
    pending.push(record);
  }
  tally.candidates = pending.length;

  /* The hard cap on what one search may spend.

     Aiming at products rather than links means a record that resolves
     to something unshowable — a redirect, a priceless offer, a URL
     another record already claimed, a price over the shopper's budget —
     no longer stops the search, and on poor data it would keep buying
     lookups down the whole candidate list. So a search spends at most
     one lookup per product it wants, plus LOOKUP_SLACK. */
  const ceiling = Math.min(pending.length, wanted + LOOKUP_SLACK);
  tally.lookupCeiling = ceiling;
  tally.ceilingReached = false;

  let verified = verifiedCount(records, intent);

  /* Four lookups in flight at a time, as before, but continuously
     rather than in batches: a worker takes the next candidate the
     moment it is free, so coming up one short costs one more round trip
     instead of one more batch.

     A worker starts a lookup only while the answers already outstanding
     could still leave the page short — `verified + inFlight < wanted`.
     That is what stops a search buying lookups it can have no use for,
     the same guarantee a batch sized to the shortfall gives, without
     waiting for a whole batch to come back. */
  let inFlight = 0;
  let next = 0;

  const worthStarting = () => next < ceiling && verified + inFlight < wanted && Date.now() < deadline;

  await new Promise((done) => {
    let settled = false;

    const pump = () => {
      while (inFlight < OFFER_CONCURRENCY && worthStarting()) {
        const record = pending[next];
        next += 1;
        inFlight += 1;

        lookupFor(record, region, tally)
          .then((commerce) => {
            if (!commerce) return;
            /* all three together, from the one offer they came from */
            record.price = commerce.price;
            record.currency = commerce.currency;
            record.retailer = commerce.retailer;
            record.productUrl = commerce.productUrl;
            tally.resolvedFromOffers += 1;
            /* asked again through the gate: a link that cannot be shown
               has not filled a slot, so the search keeps going for one
               that can */
            verified = verifiedCount(records, intent);
          })
          /* lookupFor reports its own failures; nothing here may throw
             and leave the pool with a worker it never gets back */
          .catch(() => {})
          .then(() => { inFlight -= 1; pump(); });
      }

      /* nothing running and nothing worth starting: done. The budget is
         named as the reason only when candidates were actually left. */
      if (inFlight === 0 && !settled) {
        settled = true;
        if (next < ceiling && verified < wanted && Date.now() >= deadline) tally.budgetExpired = true;
        done();
      }
    };

    pump();
  });

  tally.verified = verified;
  tally.targetMet = verified >= wanted;
  /* the page came up short because the cap stopped the search, not
     because the candidates ran out — told apart so a page that is
     habitually short is visible for what it is */
  tally.ceilingReached = !tally.targetMet && tally.lookupsMade >= ceiling && pending.length > ceiling;
  return tally;
}

async function search(intent, options) {
  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);
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
     arrive without a retailer link; this fetches the sellers for them.
     The intent goes with them so a record already over the shopper's
     ceiling is not looked up only to be dropped for its price. */
  diagnostics.offers = await resolveMissingOffers(records, wanted, region, {}, intent);

  records.forEach((r) => { delete r.retailerHint; });
  diagnostics.withAnyLink = records.filter((r) => r.productUrl).length;

  /* The source filters on price, but an offer that slipped past the
     ceiling is dropped rather than shown: "under $80" is the shopper's
     instruction, not a suggestion. Dropping is safe — it removes a real
     product from the page, it never invents one. */
  const withinLimits = records.filter((r) => withinBudget(r, intent));
  diagnostics.droppedOverBudget = records.length - withinLimits.length;

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
  unfitReason,
  verifiedCount,
  LOOKUP_SLACK,
  OFFER_CONCURRENCY,
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
