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

   ---------------------------------------------------------
   What a live response actually said
   ---------------------------------------------------------
   scripts/probe-serper.js was run against a live key, for one
   catalogue row's query. /shopping returned 40 results. Every one of
   them carried exactly one url-valued field, `link`, and every one of
   those was a google.com Shopping URL. There was no retailer URL
   anywhere in the response — not in another field, not nested, not
   embedded in a forwarder.

   So the shopping endpoint cannot answer the question discovery asks,
   and no amount of reading it differently will change that. What it
   can still do is what it does above: map a result, and come back
   with no productUrl rather than with Google's page.

   The same query put to the web endpoint returned 9 organic results,
   all 9 of them retailer URLs that pass the link rule. That is the
   fallback, and it is deliberately NOT part of search(): see
   searchOrganic() below for who asks for it, and on what evidence its
   results may ever be shown.
   ========================================================= */

'use strict';

const SEARCH_URL = 'https://google.serper.dev/shopping';
/* The web endpoint. Not a second product source: see searchOrganic(). */
const WEB_SEARCH_URL = 'https://google.serper.dev/search';
const REQUEST_TIMEOUT = 15000;
const API_LIMIT_MAX = 100;
const OVERFETCH = 2;

/* What each call leaves on the request's clock for the work after it,
   when /api/search passes a deadline (see _providers/deadline.js). A
   shopping batch with no retailer link is followed by the organic
   search and then by reading each listing's own page for its price and
   photo, so the shopping call leaves room for both, and the organic
   call leaves room for the pages. Without a deadline — catalogue
   discovery, which carries its own clock — each call has the whole
   REQUEST_TIMEOUT, exactly as before. */
const SHOPPING_RESERVE_MS = 4000;
const ORGANIC_RESERVE_MS = 3000;

const { legTimeout, fetchWithin } = require('./deadline');

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

/* one phrase for every adapter: see _providers/query.js */
const { queryFrom } = require('./query');

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
/* `timeout` is all the time this one call may have — the request's
   remaining budget less what comes after it, or REQUEST_TIMEOUT when no
   deadline was given. Running out is an error that says so and names
   Serper, rather than the runtime's bare "This operation was aborted". */
async function apiPost(url, body, timeout) {
  const key = text(process.env.SERPER_API_KEY);
  if (!key) throw new Error('SERPER_API_KEY is not set');

  const response = await fetchWithin('Serper', url, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  }, timeout === undefined ? REQUEST_TIMEOUT : timeout);

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

  const payload = await apiPost(SEARCH_URL, {
    q: queryFrom(intent) || 'clothing',
    gl: text(process.env.SERPER_COUNTRY) || 'us',
    hl: text(process.env.SERPER_LANGUAGE) || 'en',
    num: Math.min(wanted * OVERFETCH, API_LIMIT_MAX)
  }, legTimeout(options && options.deadline, SHOPPING_RESERVE_MS, REQUEST_TIMEOUT));

  const results = resultsFrom(payload);
  const records = results.map(toRecord).filter(Boolean);
  records.diagnostics = accountFor('serper-shopping', results, records);
  return records;
}

/* The counted account of what a search returned and what was lost, so a
   search that comes back with nothing says which of the two happened:
   the source had nothing, or the records carried no link. Shared by
   both endpoints, because the question is the same either way. */
function accountFor(engine, results, records) {
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

  return {
    engine,
    returnedByProvider: results.length,
    normalized: records.length,
    /* the records that named a shop: what the gate can act on at all */
    withInlineLink: records.filter((r) => r.productUrl).length,
    googleLinkedOnly,
    unlinked,
    urlFieldsSeen: [...urlFields].sort()
  };
}

/* -----------------------------------------------------------
   The organic path
   -----------------------------------------------------------

   A live probe settled what /shopping carries: forty results for one
   catalogue row, every `link` a google.com Shopping card, and not one
   retailer URL anywhere in the response. There is no field to read and
   nothing to repair, so the shopping endpoint cannot answer the
   question either caller is asking.

   The web endpoint can. An organic result is an ordinary web result,
   so its `link` is the page itself — the shop's own product page, not
   a card about it. What an organic result does NOT carry is a price or
   a photo, and that is not a gap to fill in here:

     * catalogue discovery wants a page to read. The photo comes off the
       retailer's own page, through the four image gates, and the price
       in the catalogue is the row's own and is never touched.
     * /api/search wants a displayable product, and its gate requires a
       title, price, photo, link and retailer. A record from here has
       two of the five, so on its own it is refused there, by the same
       gate that refuses everything else that is short — checked in
       scripts/test-serper.js. It reaches a shopper only after its own
       listing page has proved a price and a photo through discovery's
       price and image gates (_providers/retailer-page.js), and then
       only by passing that same gate.

   No retailer name is read off a hostname either: "shop.madewell.com"
   is a domain, not a shop's name, and inventing one is the fabricated
   attribution the record contract exists to prevent. So a record from
   here carries a title and a link, and nothing it did not receive.

   Both callers ask for it the same way, on the same rule: only when a
   batch from search() named no shop at all (linkless() in
   product-source.js). It is a separate call rather than part of
   search(), so search() answers exactly what it always answered. */
function organicFrom(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.organic)) return payload.organic;
  if (Array.isArray(payload.organicResults)) return payload.organicResults;
  return [];
}

/* One organic result, mapped. A result whose link is not a shop's own
   URL maps to nothing at all — there is no second field to fall back
   to, and Google's own URL is not a product page however it arrived. */
function toOrganicRecord(result) {
  if (!result || typeof result !== 'object') return null;

  const productUrl = retailerUrl(result.link, 0);
  const title = text(result.title);
  if (!productUrl || !title) return null;

  /* title and link, and nothing else: no price, no photo, no retailer,
     because the source supplied none of them */
  return { title, productUrl };
}

/* A result's sitelinks: the same shop's own deeper links, verbatim from
   the same response — a department, often a product. Kept only on the
   host of the result they sit under, four at most, and put through the
   same retailerUrl() test; they carry a title and a link like any
   organic record and prove nothing on their own. */
const MAX_SITELINKS = 4;

function sitelinkRecords(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.sitelinks)) return [];
  const parent = retailerUrl(result.link, 0);
  if (!parent) return [];
  const host = new URL(parent).hostname.replace(/^www\./, '').toLowerCase();
  const out = [];
  for (const link of result.sitelinks.slice(0, MAX_SITELINKS)) {
    if (!link || typeof link !== 'object') continue;
    const productUrl = retailerUrl(link.link, 0);
    const title = text(link.title);
    if (!productUrl || !title) continue;
    if (new URL(productUrl).hostname.replace(/^www\./, '').toLowerCase() !== host) continue;
    out.push({ title, productUrl });
  }
  return out;
}

async function searchOrganic(intent, options) {
  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);

  /* the same phrase the shopping search is given, built by the same
     function, so the two endpoints are asked the same question */
  const payload = await apiPost(WEB_SEARCH_URL, {
    q: queryFrom(intent) || 'clothing',
    gl: text(process.env.SERPER_COUNTRY) || 'us',
    hl: text(process.env.SERPER_LANGUAGE) || 'en',
    num: Math.min(wanted * OVERFETCH, API_LIMIT_MAX)
  }, legTimeout(options && options.deadline, ORGANIC_RESERVE_MS, REQUEST_TIMEOUT));

  const results = organicFrom(payload);
  const main = results.map(toOrganicRecord).filter(Boolean);
  /* every main result first, in the engine's order, then the sitelinks
     under them: a shop's deeper links never outrank a result */
  const seen = new Set(main.map((record) => record.productUrl));
  const deeper = results.flatMap(sitelinkRecords).filter((record) => !seen.has(record.productUrl) && seen.add(record.productUrl));
  const records = main.concat(deeper);
  records.diagnostics = Object.assign(accountFor('serper-search', results, records), { fromSitelinks: deeper.length });
  return records;
}

module.exports = {
  name: 'serper',
  configured,
  search,
  /* Not part of the contract every adapter must meet, which is name +
     configured + search. Catalogue discovery and /api/search both ask
     for it, by name, only when search() came back naming no shop; no
     other adapter has one, so nothing changes for them. */
  searchOrganic,
  /* exported for scripts/test-serper.js and scripts/probe-serper.js */
  toRecord, toOrganicRecord, sitelinkRecords, queryFrom, toPrice, currencyFrom, resultsFrom, organicFrom,
  redact, SEARCH_URL, WEB_SEARCH_URL,
  retailerUrl, productUrlFrom, urlFieldsOf
};
