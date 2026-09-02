/* =========================================================
   Fynd — SerpApi Google Shopping source  [PROTOTYPE, NOT WIRED UP]

   An evaluation adapter written to be benchmarked against the OpenWeb
   Ninja adapter, not to serve traffic. It is deliberately NOT registered
   in _providers/product-source.js, so no value of PRODUCT_SOURCE can
   select it and nothing in production can reach it. Enabling it later is
   one require and one line there — and should not happen until the
   measurement in scripts/bench-providers.js has been run against a live
   key.

   ---------------------------------------------------------
   Why this adapter exists
   ---------------------------------------------------------
   The OpenWeb Ninja adapter costs 13-17 requests per search, and the
   reason is structural rather than incidental: its /search endpoint
   returns Google Shopping's PRODUCT view, whose only link is a Google
   URL. No amount of overfetching helps, because none of those records
   carries a retailer link at all — every usable link has to be bought
   with a second request.

   SerpApi returns a page of shopping results in ONE call. If those
   results carry the merchant's own URL, one request replaces seventeen.
   Whether they do turns entirely on which engine is asked, which a live
   run settled the hard way — see below.

   ---------------------------------------------------------
   The endpoint, and the engine that matters
   ---------------------------------------------------------
     GET https://serpapi.com/search.json
       engine=<SERPAPI_ENGINE, default google_shopping_light>
       q=<phrase>
       api_key=<SERPAPI_API_KEY>
       gl=<country>   hl=<language>
       num=<results>

   A live run of 12 queries against engine=google_shopping returned 40
   results each and verified ZERO products, because Google's Shopping
   redesign removed the merchant link from that engine: its results carry
   `product_link` (a Google item page, which this adapter refuses on
   purpose) and `immersive_product_page_token`, and a retailer URL then
   costs a SECOND request through the immersive product API. That run
   also averaged 5.5s and peaked near 12s.

   google_shopping_light is documented to return `link` — the merchant's
   own URL — and to answer much faster. It is therefore the default. The
   engine is configurable so the two can be compared rather than argued
   about, and diagnostics.verdict says in one sentence which failure a
   given run hit.

   ---------------------------------------------------------
   The credential travels in the QUERY STRING
   ---------------------------------------------------------
   This is the one genuinely dangerous difference from the OpenWeb Ninja
   adapter, which sends its key as an x-api-key header and has a test
   asserting the key never appears in a URL. SerpApi has no header form:
   `api_key` is a query parameter, so the full request URL IS a
   credential.

   Therefore nothing in this file ever logs, returns, or embeds a request
   URL. Every diagnostic path goes through redactUrl(), and the tests
   assert that. Treat any code that logs a SerpApi URL as a key leak.

   ---------------------------------------------------------
   What is confirmed, and what is not
   ---------------------------------------------------------
   CONFIRMED by a live run against engine=google_shopping:
     results arrive with title, source, price, extracted_price,
     thumbnail, product_id and product_link — and NO usable merchant
     link, on any of ~480 results across 12 queries.

   NOT CONFIRMED, because serpapi.com is unreachable from the sandbox
   this adapter was written in — every live figure quoted here was
   produced by running scripts/bench-providers.js elsewhere:
     - whether engine=google_shopping_light does return a merchant `link`
     - what proportion of its results carry one
     - whether it is materially faster in practice

   scripts/capture-serpapi.js answers all three from one query, and
   prints a redacted field inventory rather than requiring anyone to
   read a raw response.

   Everything below therefore FAILS CLOSED in the same way the OpenWeb
   Ninja adapter does: a record whose link is absent, or is a Google or
   redirector URL, yields no productUrl and is dropped by the gate. A
   wrong guess shows up as an empty result set with a populated rejected
   tally, never as a product pointing somewhere it should not.

   Credentials
     SERPAPI_API_KEY   required. Create this in the server environment
                       only. Never prefix it so a bundler would publish
                       it, and never read it from anything under assets/.
   ========================================================= */

'use strict';

const SEARCH_URL = 'https://serpapi.com/search.json';
const REQUEST_TIMEOUT = 20000;
const MAX_TERMS = 12;

/* Which SerpApi engine to ask.

   This is the setting a live run showed to matter most, and it is the
   first thing to change when nothing verifies:

     google_shopping_light  DEFAULT. Documented to return `link` — the
                            merchant's own URL — and to answer much
                            faster than the full engine.
     google_shopping        The full engine. Google's Shopping redesign
                            removed the merchant link from it: results
                            carry `product_link` (a Google item page) and
                            `immersive_product_page_token`, and a
                            retailer URL then costs a SECOND request
                            through the immersive product API.

   A run against the full engine returned 40 results per query and zero
   usable retailer links, which is exactly what the field list above
   predicts. The default is therefore the light engine; override with
   SERPAPI_ENGINE to compare them. */
const DEFAULT_ENGINE = 'google_shopping_light';
const engine = () => text(process.env.SERPAPI_ENGINE) || DEFAULT_ENGINE;

/* SerpApi returns a page of shopping results in one call. Asking for
   more costs nothing extra — it is one search credit either way — so the
   adapter asks for a generous page and lets the gate thin it. This is
   the structural advantage over a per-product lookup model, and the
   reason one request may be enough. */
const DEFAULT_PAGE = 60;
const MAX_PAGE = 100;

/* Matches the production ceiling in api/search.js, so the benchmark
   compares like with like rather than crediting SerpApi for a bigger
   page than Fynd would actually ask for. */
const MAX_WANTED = 12;

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/* -----------------------------------------------------------
   Never let the credential reach a log
   ----------------------------------------------------------- */

/* Returns a URL safe to print: the key is replaced, not shortened, so a
   prefix of it cannot be reassembled from logs. Anything unparseable
   collapses to a constant rather than being echoed. */
function redactUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.searchParams.has('api_key')) url.searchParams.set('api_key', 'REDACTED');
    return url.href;
  } catch (err) {
    return '[unparseable url]';
  }
}

/* -----------------------------------------------------------
   Intent -> query

   Identical ordering to the OpenWeb Ninja adapter on purpose: the
   benchmark has to send both providers the same phrase, or it is
   measuring two query builders rather than two providers.
   ----------------------------------------------------------- */

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

/* Google Shopping's documented price filter form. Left off entirely when
   the shopper stated no budget — an unasked-for filter would narrow
   their results on our guess. */
function priceFilter(intent) {
  const i = intent && typeof intent === 'object' ? intent : {};
  if (!i.minPrice && !i.maxPrice) return null;
  const parts = ['mr:1'];
  if (i.minPrice) parts.push(`price:1,ppr_min:${Number(i.minPrice)}`);
  if (i.maxPrice) parts.push(`price:1,ppr_max:${Number(i.maxPrice)}`);
  return parts.join(',');
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

function toPrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = text(value).replace(/,/g, '').match(/\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

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

/* Google's own surfaces, refused for the same reason the OpenWeb Ninja
   adapter refuses them: a comparison page is not a retailer's page.
   `product_link` points at one by definition, so it is never read as a
   product URL — only `link` is, and only when it survives this. */
const GOOGLE_HOST = /(^|\.)(google\.[a-z]{2,3}(\.[a-z]{2})?|googleadservices\.com|googleusercontent\.com|gstatic\.com|googlesyndication\.com)$/i;

/* Ad-server and click-through paths. SerpApi's `link` has historically
   been a google.com/aclk tracking URL for some result types, so this is
   the check that decides whether one request is enough. */
const REDIRECT_PATH = /^\/?(url|aclk|aclick|clk|click|redirect|redir|out|go|goto|jump|ref|link)\/?$/i;
const REDIRECT_PARAM = /^(url|u|q|to|dest|destination|target|adurl|redirect|redirect_uri|redirect_url|r|out|link|goto|continue|next)$/i;
const URL_VALUED = /^(https?:)?\/\//i;

/* Returns an absolute retailer URL, or null. Null for a Google host, a
   redirector, and anything unparseable or non-http — so a tracking link
   can never be mistaken for a retailer's product page. The authoritative
   check still runs in the verification gate; this one exists so the
   adapter can COUNT how often the response was directly usable, which is
   the number this whole prototype was built to produce. */
function looksDirect(value) {
  const raw = text(value);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch (err) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (GOOGLE_HOST.test(url.hostname)) return null;

  const path = url.pathname.replace(/\/+$/, '');
  if (REDIRECT_PATH.test(path)) return null;
  for (const [key, value2] of url.searchParams.entries()) {
    if (REDIRECT_PARAM.test(key) && URL_VALUED.test(value2)) return null;
  }
  return url.href;
}

/* The merchant link, if this result carries one at all.

   ONLY `link` is considered. `product_link` is Google's item page and
   `serpapi_product_api` is a SerpApi endpoint — neither is a retailer
   URL, and reading either as one would put the wrong destination behind
   a product card. */
const LINK_KEYS = ['link', 'direct_link', 'merchant_link', 'seller_link', 'offer_link', 'product_page_url'];

/* Why a candidate link was refused, or null when it was accepted. The
   plain looksDirect() answer is a URL or nothing, which is all the
   mapping needs — but when a whole run verifies nothing, "nothing" is
   useless and the REASON is the entire finding. */
function linkVerdict(value) {
  const raw = text(value);
  if (!raw) return 'absent';
  let url;
  try { url = new URL(raw); } catch (err) { return 'unparseable'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'non-http';
  if (GOOGLE_HOST.test(url.hostname)) return 'google-host';
  const path = url.pathname.replace(/\/+$/, '');
  if (REDIRECT_PATH.test(path)) return 'redirector';
  for (const [key, v] of url.searchParams.entries()) {
    if (REDIRECT_PARAM.test(key) && URL_VALUED.test(v)) return 'redirector';
  }
  return null;
}

/* Which of the candidate link fields this result actually carried, and
   what became of each. An adapter that only reports "no link" cannot
   tell a missing field from a refused one, and those call for opposite
   fixes: a missing field means the wrong engine, a refused one means the
   right engine and a link Fynd will not display. */
function linkReport(result) {
  const seen = {};
  let accepted = null;
  for (const key of LINK_KEYS) {
    if (result[key] === undefined || result[key] === null || String(result[key]).trim() === '') continue;
    const verdict = linkVerdict(result[key]);
    seen[key] = verdict || 'accepted';
    if (!verdict && !accepted) accepted = new URL(text(result[key])).href;
  }
  return { seen, accepted, hadAnyLinkField: Object.keys(seen).length > 0 };
}

/* SerpApi supplies the retailer as `source`. `source_icon` is an image
   of it, never its name. */
const STORE_KEYS = ['source', 'merchant', 'seller', 'store', 'store_name'];

const IMAGE_KEYS = ['thumbnail', 'serpapi_thumbnail', 'image', 'product_photo'];

/* SerpApi does not document a brand field on a shopping result. It is
   read where present and omitted where not — never filled from `source`,
   because a shop is not the brand of everything it sells. */
function brandFrom(result) {
  const direct = firstOf(result, ['brand', 'product_brand', 'brand_name', 'manufacturer']);
  if (text(direct)) return text(direct);
  const extensions = result.extensions;
  if (Array.isArray(extensions)) {
    /* extensions is a list of free-text badges; nothing in it is
       reliably a brand, so nothing is taken from it */
    return null;
  }
  return null;
}

/* Whether a result claims to be out of stock. SerpApi has no explicit
   stock field on a shopping result; `second_hand_condition` and the
   extensions list sometimes carry wording. Absent means available, the
   same rule the gate applies. */
function availabilityFrom(result) {
  const extensions = Array.isArray(result.extensions) ? result.extensions.join(' ') : '';
  if (/out of stock|sold out/i.test(extensions)) return 'out-of-stock';
  return undefined;
}

/* Maps one shopping result onto a Fynd record.

   Title, image, brand and id come from the result itself. Price,
   retailer and link come from that same result — SerpApi returns them
   together on one object, so unlike the OpenWeb Ninja path there is no
   possibility of pairing one product's photo with another's link. */
function toRecord(result) {
  if (!result || typeof result !== 'object') return null;

  const productUrl = linkReport(result).accepted;
  const priceSource = firstOf(result, ['extracted_price', 'price', 'current_price']);

  const record = {
    title: text(firstOf(result, ['title', 'name', 'product_title'])),
    imageUrl: text(firstOf(result, IMAGE_KEYS)) || undefined,
    brand: brandFrom(result) || undefined,
    sku: text(firstOf(result, ['product_id', 'productId', 'id'])) || undefined,
    price: toPrice(priceSource),
    currency: currencyFrom(firstOf(result, ['price'])) || undefined,
    retailer: text(firstOf(result, STORE_KEYS)) || undefined,
    productUrl: productUrl || undefined,
    availability: availabilityFrom(result)
  };

  Object.keys(record).forEach((k) => {
    if (record[k] === null || record[k] === undefined || record[k] === '') delete record[k];
  });
  return record;
}

/* -----------------------------------------------------------
   The request
   ----------------------------------------------------------- */

/* SerpApi documents the envelope as { search_metadata, search_parameters,
   shopping_results, ... }. Both a bare array and the documented object
   are accepted, and several result blocks are read because Google's
   redesign moved listings between them. */
function resultsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['shopping_results', 'inline_shopping_results', 'immersive_products', 'results']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

/* Structure only — key names, never a value, so nothing from a response
   body and no fragment of a credential can travel through a log. */
function shapeOf(payload) {
  if (Array.isArray(payload)) return `array[${payload.length}]`;
  if (!payload || typeof payload !== 'object') return String(typeof payload);
  return `{${Object.keys(payload).join(',')}}`;
}

/* One GET against SerpApi. The URL carries the credential, so it is
   never logged, never thrown in an error message, and never returned. */
async function apiGet(params) {
  const key = process.env.SERPAPI_API_KEY;
  if (!key) throw new Error('SERPAPI_API_KEY is not set');

  const url = `${SEARCH_URL}?${params.toString()}&api_key=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    /* status and a short body only; the URL is deliberately absent */
    throw new Error(`SerpApi responded ${response.status}: ${detail.slice(0, 200)}`);
  }
  return response.json();
}

/* One request. That is the whole point of the prototype.

   Where the OpenWeb Ninja adapter would now start buying retailer links
   one product at a time, this counts how many it would have needed and
   returns. `wouldNeedSecondRequest` is the number that decides whether
   SerpApi is a one-call provider for Fynd or a two-call one. */
async function search(intent, options) {
  const wanted = Math.min(Math.max(Number(options && options.limit) || 12, 1), MAX_WANTED);
  const page = Math.min(Math.max(Number(options && options.page) || DEFAULT_PAGE, wanted), MAX_PAGE);

  const params = new URLSearchParams({
    engine: engine(),
    q: queryFrom(intent) || 'clothing',
    gl: process.env.SERPAPI_COUNTRY || 'us',
    hl: process.env.SERPAPI_LANGUAGE || 'en',
    num: String(page)
  });

  const tbs = priceFilter(intent);
  if (tbs) params.set('tbs', tbs);

  const startedAt = Date.now();
  const payload = await apiGet(params);
  const elapsedMs = Date.now() - startedAt;

  const results = resultsFrom(payload);

  const records = results.map(toRecord).filter(Boolean);
  const withLink = records.filter((r) => r.productUrl);

  /* Why every record failed, when they do.

     A run that verifies nothing is the case this adapter most has to
     explain, and the earlier version could not: it filtered unusable
     records out before the gate, so the gate had nothing to reject and
     the tally came back empty. The counts below are gathered from the
     RAW results, so a zero-product run says which field was missing
     rather than only that there were none. */
  const linkFields = {};
  const linkVerdicts = { absent: 0, 'google-host': 0, redirector: 0, unparseable: 0, 'non-http': 0, accepted: 0 };
  const coverage = { title: 0, price: 0, image: 0, retailer: 0, anyLinkField: 0, immersiveTokenOnly: 0 };

  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const report = linkReport(result);
    for (const [key, verdict] of Object.entries(report.seen)) {
      linkFields[key] = (linkFields[key] || 0) + 1;
      if (linkVerdicts[verdict] !== undefined) linkVerdicts[verdict] += 1;
    }
    if (!report.hadAnyLinkField) linkVerdicts.absent += 1;

    if (text(firstOf(result, ['title', 'name', 'product_title']))) coverage.title += 1;
    if (toPrice(firstOf(result, ['extracted_price', 'price', 'current_price'])) !== null) coverage.price += 1;
    if (text(firstOf(result, IMAGE_KEYS))) coverage.image += 1;
    if (text(firstOf(result, STORE_KEYS))) coverage.retailer += 1;
    if (report.hadAnyLinkField) coverage.anyLinkField += 1;
    /* the tell-tale of the full engine after Google's redesign: a Google
       item page plus a token, and no merchant URL anywhere */
    if (!report.accepted && text(firstOf(result, ['immersive_product_page_token']))) coverage.immersiveTokenOnly += 1;
  }

  /* The single sentence a failing run should be readable from. */
  let verdict = 'ok';
  if (!results.length) verdict = 'no-results-from-provider';
  else if (!withLink.length) {
    verdict = coverage.anyLinkField === 0
      ? `no result carried any of the link fields (${LINK_KEYS.join(', ')}) — likely the wrong engine`
      : `every link was refused (${Object.entries(linkVerdicts).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(' ')})`;
  }

  /* Every stage a record can be lost at, counted the same way the
     OpenWeb Ninja adapter counts them, so the two are comparable. */
  const diagnostics = {
    provider: 'serpapi',
    engine: engine(),
    requests: 1,
    elapsedMs,
    returnedByProvider: results.length,
    searchShape: results.length ? null : shapeOf(payload),
    normalized: records.length,
    /* the number this prototype exists to measure */
    withInlineLink: withLink.length,
    inlineLinkRate: results.length ? Number((withLink.length / results.length).toFixed(3)) : 0,
    /* records that had everything BUT a usable link — each one is a
       product SerpApi would need a second request to make usable */
    wouldNeedSecondRequest: records.filter((r) => !r.productUrl).length,
    /* whether one request was enough to fill the page Fynd asks for */
    filledPageInOneRequest: withLink.length >= wanted,
    /* why, when the answer is none */
    verdict,
    fieldCoverage: coverage,
    linkFieldsSeen: linkFields,
    linkVerdicts,
    offers: { skipped: true, reason: 'single-request prototype: no follow-up call is made' }
  };

  const withinLimits = withLink.filter((r) => withinBudget(r, intent));
  diagnostics.droppedOverBudget = withLink.length - withinLimits.length;
  diagnostics.withAnyLink = withinLimits.length;

  return Object.assign(withinLimits, { diagnostics });
}

function withinBudget(record, intent) {
  if (!intent || typeof record.price !== 'number') return true;
  if (intent.maxPrice && record.price > intent.maxPrice) return false;
  if (intent.minPrice && record.price < intent.minPrice) return false;
  return true;
}

module.exports = {
  name: 'serpapi',
  defaultRetailer: null,
  configured: () => Boolean(process.env.SERPAPI_API_KEY),
  search,
  /* exported for the benchmark and the tests */
  toRecord,
  queryFrom,
  priceFilter,
  looksDirect,
  resultsFrom,
  shapeOf,
  redactUrl,
  withinBudget,
  brandFrom,
  availabilityFrom,
  toPrice,
  currencyFrom,
  SEARCH_URL,
  MAX_WANTED,
  DEFAULT_PAGE
};
