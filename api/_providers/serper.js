/* =========================================================
   Fynd — Serper product source (fallback)

   NOT the default, and not a replacement: SerpApi stays the primary
   source and is untouched. This exists for one situation, the one the
   catalogue runs keep hitting — SerpApi's monthly search allowance runs
   out mid-run, every remaining row reports the same 429, and a run that
   was working stops working for a reason that has nothing to do with
   the catalogue.

   Serper (serper.dev) answers the same question from the same index
   through a different account, so discovery can carry on. What it is
   NOT is a softer route to the catalogue. A listing from here goes
   through every gate a SerpApi listing goes through, in the same order,
   with nothing skipped and nothing relaxed:

     the link rule         aggregators, search pages, category pages and
                           redirectors refused by product-source.js
     the semantic gate     the listing has to be the garment the row
                           means, on its title and then on its page
     the four image gates  found in the markup, on the retailer's own
                           host, tied to THIS product, and loadable
     the writer            productUrl, imageUrl and imageEvidence, and
                           nothing else, ever

   A photo that arrives via Serper is written on exactly the evidence a
   photo via SerpApi is written on. Where the candidate came from is not
   evidence of anything and is never recorded as if it were.

   Configure with SERPER_API_KEY. Left unset the adapter reports itself
   unconfigured and discovery carries on saying so, rather than half
   working.

     POST https://google.serper.dev/shopping
     X-API-KEY: <key>
     { "q": "...", "gl": "us", "hl": "en", "num": 20 }

   The response carries a `shopping` array whose entries name the seller
   in `source` and carry the listing's URL in `link`.

   ---------------------------------------------------------
   Where a retailer URL actually comes from
   ---------------------------------------------------------
   `link` is NOT reliably the shop's page. Serper passes through
   whatever the Google Shopping card points at, and on the current
   surface that is usually Google's own product card:

     https://www.google.com/search?ibp=oshop…      Google's shopping card
     https://www.google.com/shopping/product/…     Google's product page
     https://www.google.com/url?q=<retailer url>   a Google forwarder
     https://www.nike.com/t/…                      the shop's own page

   Only the last of those is a product page, and the mapping used to
   copy `link` into `productUrl` whatever it held — so a run against
   the current surface handed the gate a google.com URL for every row,
   the gate refused all of them as `product-url-not-a-retailer-page`,
   and the run reported nothing verified.

   So the URL is READ rather than assumed. Every URL-valued field on
   the result, and on any offer or seller object nested inside it, is
   considered in order of how explicitly it names a shop, and a
   candidate is taken only if it survives retailerUrl(): absolute
   http(s), and not on Google's or another index's host. A Google
   forwarder is unwrapped to the destination it already carries
   verbatim in its own query string — that is reading a URL out of the
   response, not repairing one.

   Nothing is invented, and nothing is loosened. A result that offers
   no retailer URL is mapped WITHOUT productUrl, so the gate drops it
   as `missing-product-url` rather than being handed Google's page and
   asked to be lenient about it. The link rule in product-source.js is
   still the authority on every URL that does survive: retailerUrl()
   only decides whether the adapter found a shop's URL at all.

   WHICH field carries it on a live response is answered by the search's
   own diagnostics — `urlFieldsSeen` names every field a response put an
   http(s) URL in, and `googleLinkedOnly` counts the results whose only
   URLs were Google's — so a surface that moves the link to a new field
   shows up as a named field rather than as a silent empty run.
   ========================================================= */

'use strict';

const SEARCH_URL = 'https://google.serper.dev/shopping';
const REQUEST_TIMEOUT = 15000;
const API_LIMIT_MAX = 100;
const OVERFETCH = 2;

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

/* a key must never reach a log or an error message */
function redact(detail) {
  return text(detail).replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');
}

function configured() {
  return Boolean(text(process.env.SERPER_API_KEY));
}

/* The same terms, in the same order, that the primary source is asked
   for. Discovery builds its own single-phrase intents; this keeps a
   hand-built intent readable too. */
const TERM_ORDER = ['gender', 'colors', 'fits', 'styles', 'brands', 'categories', 'occasions', 'keywords'];
const MAX_TERMS = 12;

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

/* "$34.97" -> 34.97, and anything that is not an amount -> null. No
   figure is ever inferred: a listing with no price keeps none, and the
   display gate drops it rather than showing a guess. */
function toPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = text(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : null;
}

function currencyFrom(value) {
  const raw = text(value);
  if (/£/.test(raw)) return 'GBP';
  if (/€/.test(raw)) return 'EUR';
  if (/\$/.test(raw)) return 'USD';
  const named = raw.match(/\b(USD|GBP|EUR|CAD|AUD|JPY)\b/i);
  return named ? named[1].toUpperCase() : null;
}

/* -----------------------------------------------------------
   The retailer's own URL
   ----------------------------------------------------------- */

/* Hosts that are a search engine, an ad server or another index rather
   than a shop. Google's own are first because that is where a Shopping
   card points by default, and a Google product card is a comparison
   page however product-like its path reads. Kept in step with the
   AGGREGATOR_HOST rule in product-source.js on purpose: this one only
   decides whether the adapter FOUND a shop's URL, and that one remains
   the authority on whether the URL may be shown. */
const NOT_A_SHOP_HOST = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|googleadservices\.com|googlesyndication\.com|googleusercontent\.com|gstatic\.com|goo\.gl|bing\.com|duckduckgo\.com|yahoo\.com|yandex\.[a-z]+|shopping\.com|shopzilla\.com|pricegrabber\.com|serper\.dev)$/i;

/* Query parameters a forwarder carries its destination in. Google's
   /url and /aclk both do, and the destination is the retailer's own
   URL, spelled out in full. */
const FORWARDING_PARAM = /^(url|u|q|adurl|dest|destination|target|to|continue|redirect|redirect_uri|redirect_url|r|out|link|goto|next)$/i;
const URL_VALUED = /^(https?:)?\/\//i;

/* A forwarder can wrap a forwarder. Three unwrappings is more than any
   real response needs and stops a crafted one looping. */
const MAX_UNWRAP = 3;

/* Returns the retailer's own absolute URL, or null.

   Null for anything unparseable, anything that is not http(s), and
   anything on a host above. A Google URL is not simply refused first:
   if it carries a destination in its query string that destination is
   read out and put through this same test, because that URL came from
   the response verbatim — it is not a repair, a guess, or a request
   made to find out where a link lands. */
function retailerUrl(value, depth) {
  const raw = text(value);
  if (!raw) return null;

  let url;
  try {
    url = new URL(URL_VALUED.test(raw) && !/^https?:/i.test(raw) ? `https:${raw}` : raw);
  } catch (err) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!NOT_A_SHOP_HOST.test(url.hostname)) return url.href;

  const level = Number(depth) || 0;
  if (level >= MAX_UNWRAP) return null;
  for (const [key, embedded] of url.searchParams.entries()) {
    if (!FORWARDING_PARAM.test(key) || !URL_VALUED.test(embedded)) continue;
    const destination = retailerUrl(embedded, level + 1);
    if (destination) return destination;
  }
  return null;
}

/* Candidate fields for the shop's own link, most explicit first.
   `link` is in the list and is not a mistake: on some results it IS
   the shop's URL, and retailerUrl() refusing Google is what makes
   reading it safe. Nothing here is trusted for being present — only
   for surviving retailerUrl(). */
const DIRECT_URL_KEYS = [
  'productLink', 'product_link', 'offerLink', 'offer_link',
  'merchantLink', 'merchant_link', 'sellerLink', 'seller_link',
  'storeLink', 'store_link', 'directLink', 'direct_link',
  'sourceLink', 'source_link', 'productUrl', 'product_url',
  'link', 'url'
];

/* Objects a result can hold an offer or a seller in. `offers` is a
   COUNT on a Serper shopping result ("4"), so only an object or an
   array of objects is descended into and a string is left alone. */
const NESTED_KEYS = ['offer', 'offers', 'seller', 'sellers', 'merchant', 'merchants', 'store', 'stores', 'product', 'listing'];
const MAX_NESTING = 2;

/* The retailer URL a result carries, wherever it carries it, or null
   when it carries none. Null is a real answer: the record is then
   mapped without productUrl and the gate drops it, which is the honest
   outcome for a result that only ever pointed at Google. */
function productUrlFrom(result, depth) {
  if (!result || typeof result !== 'object') return null;
  const level = Number(depth) || 0;

  for (const key of DIRECT_URL_KEYS) {
    const direct = retailerUrl(result[key], 0);
    if (direct) return direct;
  }
  if (level >= MAX_NESTING) return null;

  for (const key of NESTED_KEYS) {
    const nested = result[key];
    for (const entry of Array.isArray(nested) ? nested : [nested]) {
      if (!entry || typeof entry !== 'object') continue;
      const found = productUrlFrom(entry, level + 1);
      if (found) return found;
    }
  }
  return null;
}

/* Names the fields a result put an http(s) URL in, images aside. It is
   reported in diagnostics rather than acted on: when Google moves the
   merchant link to a field this adapter does not read yet, a live run
   says which field that is instead of returning an empty page. */
const IMAGE_KEYS = /^(image|imageUrl|image_url|thumbnail|thumbnailUrl|thumbnail_url|photo|photoUrl)$/i;

function urlFieldsOf(result, prefix, into) {
  const found = into || new Set();
  if (!result || typeof result !== 'object') return found;

  for (const [key, value] of Object.entries(result)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      if (!IMAGE_KEYS.test(key) && /^https?:\/\//i.test(value.trim())) found.add(name);
    } else if (value && typeof value === 'object' && !prefix) {
      for (const entry of Array.isArray(value) ? value.slice(0, 4) : [value]) {
        if (entry && typeof entry === 'object') urlFieldsOf(entry, name, found);
      }
    }
  }
  return found;
}

/* One shopping result, mapped. Absent fields are left absent — the
   verification gate drops a record that is missing what it needs, and
   filling a gap here would be inventing the thing the gate exists to
   catch. Notably there is no brand: Serper does not separate one out,
   and putting the seller's name in that field would be a fabricated
   attribution.

   productUrl is the one field that is looked for rather than copied,
   for the reason in the header: `link` is as often Google's card as
   the shop's page. A result with no retailer URL keeps none, and no
   Google URL is carried on the record under any other name either —
   discovery reads `link` and `url` off a raw record too, so leaving
   one there would put back exactly what the gate refuses. */
function toRecord(result) {
  if (!result || typeof result !== 'object') return null;

  const record = {
    title: text(result.title) || undefined,
    productUrl: productUrlFrom(result, 0) || undefined,
    imageUrl: text(result.imageUrl) || undefined,
    retailer: text(result.source) || undefined,
    price: toPrice(result.price) || undefined,
    currency: currencyFrom(result.price) || undefined,
    sku: text(result.productId) || undefined
  };

  for (const key of Object.keys(record)) {
    if (record[key] === undefined || record[key] === '') delete record[key];
  }
  return Object.keys(record).length ? record : null;
}

function resultsFrom(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.shopping)) return payload.shopping;
  /* the same array under the name other Serper endpoints use */
  if (Array.isArray(payload.shoppingResults)) return payload.shoppingResults;
  return [];
}

/* Serper's own failures, named rather than swallowed. 429 is the
   account's allowance, which is worth saying out loud for the same
   reason it is worth saying about SerpApi: it is the one failure that
   is not a bug in this adapter. */
async function apiPost(body) {
  const key = text(process.env.SERPER_API_KEY);
  if (!key) throw new Error('SERPER_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const note = response.status === 429 ? ' (Serper search allowance exhausted)' : '';
    throw new Error(`Serper responded ${response.status}${note}: ${redact(detail).slice(0, 200)}`);
  }

  const payload = await response.json();
  if (payload && typeof payload === 'object' && payload.error) {
    throw new Error(`Serper error: ${redact(payload.error).slice(0, 200)}`);
  }
  return payload;
}

async function search(intent, options) {
  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);

  const payload = await apiPost({
    q: queryFrom(intent) || 'clothing',
    gl: text(process.env.SERPER_COUNTRY) || 'us',
    hl: text(process.env.SERPER_LANGUAGE) || 'en',
    num: Math.min(wanted * OVERFETCH, API_LIMIT_MAX)
  });

  const results = resultsFrom(payload);
  const records = results.map(toRecord).filter(Boolean);

  /* the same counted account of what was lost and where, so a search
     that returns nothing says whether the source had nothing or the
     records could not be read — and, since the link is the thing this
     source most often cannot supply, which of those two it was:
     `googleLinkedOnly` is a result that pointed only at Google, and
     `urlFieldsSeen` names the fields a URL arrived in at all. */
  const urlFields = new Set();
  let googleLinkedOnly = 0;
  let unlinked = 0;
  for (const result of results) {
    const fields = urlFieldsOf(result, '', undefined);
    for (const field of fields) urlFields.add(field);
    if (productUrlFrom(result, 0)) continue;
    if (fields.size) googleLinkedOnly += 1;
    else unlinked += 1;
  }

  records.diagnostics = {
    engine: 'serper-shopping',
    returnedByProvider: results.length,
    normalized: records.length,
    /* the records that named a shop: what the gate can act on at all */
    withInlineLink: records.filter((r) => r.productUrl).length,
    googleLinkedOnly,
    unlinked,
    urlFieldsSeen: [...urlFields].sort()
  };
  return records;
}

module.exports = {
  name: 'serper',
  configured,
  search,
  /* exported for scripts/test-serper.js */
  toRecord, queryFrom, toPrice, currencyFrom, resultsFrom, redact, SEARCH_URL,
  retailerUrl, productUrlFrom, urlFieldsOf
};
