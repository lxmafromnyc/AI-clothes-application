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

   NAMES FIRST, THEN STRUCTURE.

   The previous version knew six key names and looked only at the TOP
   LEVEL of a result. A live google_shopping_light run returned 40
   results, matched none of those names, and every record was dropped —
   leaving the adapter able to say only "no recognized link fields".
   Guessing a seventh name would be the same mistake one layer down, and
   would be a guess about a response this was not written in front of.

   So the names below are a PREFERENCE ORDER, not the search space. When
   none matches, every string in the result is walked — nested objects
   and arrays included — and each one that parses as an http(s) URL is
   put through the SAME gate. The path it was found at is reported, so a
   run NAMES the field that carried the link instead of leaving it to be
   guessed by the next person.

   `product_link` is Google's item page and `serpapi_product_api` is a
   SerpApi endpoint — neither is a retailer URL, and reading either as
   one would put the wrong destination behind a product card. Both are
   refused: the first by GOOGLE_HOST, the second by SERPAPI_HOST. */
const LINK_KEYS = ['link', 'direct_link', 'merchant_link', 'seller_link', 'offer_link', 'product_page_url'];

/* SerpApi's own hosts. `serpapi_thumbnail` and `serpapi_product_api`
   are https URLs on a non-Google host, so nothing above would refuse
   them — and a discovery pass that accepted one would put a SerpApi
   endpoint behind a product card. Refused by name AND by host. */
const SERPAPI_HOST = /(^|\.)serpapi\.com$/i;

/* An image is not a product page. Without this, discovery would happily
   accept a CDN photo as the destination of a product card. */
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|bmp|ico)$/i;

/* Field names whose value is never a merchant product URL, whatever it
   looks like: pictures, icons, and API endpoints. Skipped by discovery
   rather than tested, because the name is the more reliable signal and
   testing would let a plausible-looking image URL through. */
const NON_LINK_KEY = /(thumbnail|image|photo|picture|icon|logo|avatar|sprite|_api$|api_url|endpoint|json|html)/i;

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

/* Every string in one result, with the path it was found at.

   Bounded in depth and in count: a provider response is untrusted input
   and must not be able to turn one mapping pass into an unbounded walk
   of a deeply nested or self-referential payload. */
const MAX_WALK_DEPTH = 6;
const MAX_WALK_STRINGS = 400;

function collectStrings(node, path, out, depth) {
  if (out.length >= MAX_WALK_STRINGS || depth > MAX_WALK_DEPTH) return out;
  if (typeof node === 'string') {
    if (node.trim()) out.push({ path, value: node });
    return out;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length && out.length < MAX_WALK_STRINGS; i += 1) {
      collectStrings(node[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (out.length >= MAX_WALK_STRINGS) break;
      /* an image or an API endpoint, whatever its value looks like */
      if (NON_LINK_KEY.test(key)) continue;
      collectStrings(value, path ? `${path}.${key}` : key, out, depth + 1);
    }
  }
  return out;
}

/* Whether a string could be a retailer's product page at all. The gate
   in product-source.js still has the final say — this only stops
   discovery from PROPOSING something that plainly is not a destination,
   which matters because discovery, unlike a named lookup, has no author
   vouching for the field it read. */
function couldBeProductUrl(value) {
  const raw = text(value);
  if (!/^https?:\/\//i.test(raw)) return false;
  let url;
  try { url = new URL(raw); } catch (err) { return false; }
  if (SERPAPI_HOST.test(url.hostname)) return false;
  if (IMAGE_EXT.test(url.pathname)) return false;
  return true;
}

/* Which fields this result carried a link in, and what became of each.

   An adapter that only reports "no link" cannot tell a MISSING field
   from a REFUSED one, and those call for opposite fixes. This reports
   both, and separates the documented names from the discovered paths so
   a reader can see which of the two actually supplied the URL. */
function linkReport(result) {
  const seen = {};
  let accepted = null;
  let acceptedPath = null;

  /* 1. the documented names, in preference order, at the top level */
  for (const key of LINK_KEYS) {
    const value = result[key];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    if (!couldBeProductUrl(value)) { seen[key] = 'not-a-product-url'; continue; }
    const verdict = linkVerdict(value);
    seen[key] = verdict || 'accepted';
    if (!verdict && !accepted) { accepted = new URL(text(value)).href; acceptedPath = key; }
  }
  const hadNamedLinkField = Object.keys(seen).length > 0;

  /* 2. anything else in the result that is a usable URL. Only reached
        when the names above yielded nothing, so a documented field is
        never overruled by a discovered one. */
  const discovered = {};
  if (!accepted) {
    for (const { path, value } of collectStrings(result, '', [], 0)) {
      if (LINK_KEYS.indexOf(path) !== -1) continue;   /* already judged above */
      if (!couldBeProductUrl(value)) continue;
      const verdict = linkVerdict(value);
      discovered[path] = verdict || 'accepted';
      if (!verdict && !accepted) { accepted = new URL(text(value)).href; acceptedPath = path; }
    }
  }

  /* ONE verdict for the whole result, not one per candidate. A result
     whose named field was refused and whose three discovered paths were
     refused too is a SINGLE refusal; counting per candidate inflates the
     tallies past the number of results, which reads as a bug in the
     adapter rather than as a finding about the response. */
  const candidates = Object.values(seen).concat(Object.values(discovered));
  const outcome = accepted ? 'accepted' : (candidates.length ? candidates[0] : 'absent');

  return {
    seen,
    discovered,
    accepted,
    acceptedPath,
    outcome,
    hadAnyLinkField: hadNamedLinkField || Object.keys(discovered).length > 0,
    hadNamedLinkField
  };
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
  /* paths found by the structural walk rather than by name — this is
     what NAMES the real field when the documented ones are absent */
  const discoveredPaths = {};
  /* where the URL that was actually used came from, per result */
  const acceptedFrom = {};
  /* key names that look like a handle for a follow-up offers call. Only
     INVENTORIED — no second request is made, and none is invented. */
  const tokenFields = {};
  const linkVerdicts = {
    absent: 0, 'google-host': 0, redirector: 0, unparseable: 0,
    'non-http': 0, 'not-a-product-url': 0, accepted: 0
  };
  const coverage = { title: 0, price: 0, image: 0, retailer: 0, anyLinkField: 0, immersiveTokenOnly: 0 };

  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    const report = linkReport(result);
    /* field inventories: per OCCURRENCE, because a result carrying the
       URL in three places is three occurrences of three field names */
    for (const key of Object.keys(report.seen)) linkFields[key] = (linkFields[key] || 0) + 1;
    for (const path of Object.keys(report.discovered)) discoveredPaths[path] = (discoveredPaths[path] || 0) + 1;
    /* verdicts: per RESULT, so the tallies sum to results.length */
    if (linkVerdicts[report.outcome] !== undefined) linkVerdicts[report.outcome] += 1;
    if (report.acceptedPath) acceptedFrom[report.acceptedPath] = (acceptedFrom[report.acceptedPath] || 0) + 1;
    for (const key of Object.keys(result)) {
      if (/token|product_id|offers?$|offer_id|_api$/i.test(key)) tokenFields[key] = (tokenFields[key] || 0) + 1;
    }


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
    const tally = Object.entries(linkVerdicts).filter(([, n]) => n).map(([k, n]) => `${k}:${n}`).join(' ');
    if (coverage.immersiveTokenOnly === results.length) {
      /* The signature of the full engine after Google's redesign: a
         Google item page plus a token to buy the retailer URL with a
         SECOND credit. This, not the absence of a field name, is what
         actually identifies the wrong engine — discovery means a result
         almost always carries SOME URL, so "no field at all" no longer
         distinguishes the two. */
      verdict = `no result carried a merchant URL — every one had a Google item page `
        + `and an immersive token (${tally}) — likely the wrong engine`;
    } else if (coverage.anyLinkField === 0) {
      verdict = `no result carried a URL in ANY field, named or discovered `
        + `(searched ${LINK_KEYS.join(', ')} plus every nested string) — likely the wrong engine`;
    } else {
      verdict = `every link was refused (${tally})`;
    }
  } else if (!Object.keys(linkFields).length && Object.keys(acceptedFrom).length) {
    /* worth saying out loud: the documented names supplied nothing and
       the walk is the only reason this run has links at all */
    verdict = `ok — but via discovered path(s) ${Object.keys(acceptedFrom).join(', ')}, `
      + `not any of the documented names (${LINK_KEYS.join(', ')})`;
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
    /* the answer to "what does this engine actually call the link?" */
    discoveredLinkPaths: discoveredPaths,
    acceptedLinkPaths: acceptedFrom,
    tokenFieldsSeen: tokenFields,
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
  DEFAULT_PAGE,
  /* exported so the scripts report the names the adapter ACTUALLY
     consults. A hardcoded copy in a script drifts the moment this list
     changes, and then reports a conclusion the adapter never reached. */
  LINK_KEYS,
  linkReport,
  couldBeProductUrl
};
