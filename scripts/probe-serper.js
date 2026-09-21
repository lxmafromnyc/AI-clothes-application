#!/usr/bin/env node
/* =========================================================
   Fynd — Serper response probe

   Answers ONE question against a live response, with evidence rather
   than inference: does Serper's /shopping endpoint carry a retailer's
   own product URL ANYWHERE on a result, and if so under which key.

   It exists because the question cannot honestly be answered from the
   outside. Serper publishes no field list for /shopping, the client
   libraries that mirror it disagree with what a live run returns, and
   a catalogue run that verifies nothing cannot tell you whether the
   adapter read the wrong field or the response simply has no retailer
   URL in it. Those two have completely different fixes, so this prints
   the whole result and lets the response say which it is.

   Usage
     SERPER_API_KEY=... node scripts/probe-serper.js "Boxy Cotton Tee"

   Options
     --num=20        how many shopping results to ask for
     --all           walk every result, not only the first
     --json          print the raw first result as JSON (it is printed
                     in full by default; this adds the whole batch)
     --search        ALSO spend one request on the web /search endpoint,
                     to see whether organic results carry retailer
                     product pages. Spent automatically when /shopping
                     turns out to carry no retailer URL at all, because
                     that is the question the run is left with.
     --no-search     never spend that second request

   What it prints
     1. the endpoint, the query the adapter would build, and the
        response envelope's keys
     2. shopping[0] in full, as JSON, key by key
     3. EVERY url-valued path anywhere in that result — nested objects
        and arrays included — each one classified: a retailer product
        page, a Google page, a Google-hosted image, a forwarder and
        where it forwards to, or a URL the gate refuses and why
     4. the same question across the whole batch: how many results
        yield a retailer URL, which keys URLs arrived under at all
     5. the record the adapter maps out of shopping[0], and the
        verification gate's verdict on the whole batch
     6. a plain verdict: whether /shopping carries a merchant URL

   Nothing is written anywhere. Nothing is inferred: a field is reported
   because it is in the response. The key is sent as a header, never
   printed, and stripped out of every line this prints.
   ========================================================= */

'use strict';

const provider = require('../api/_providers/serper');
const { verifyAll, linkFault } = require('../api/_providers/product-source');

const SHOPPING_URL = 'https://google.serper.dev/shopping';
const SEARCH_URL = 'https://google.serper.dev/search';
const REQUEST_TIMEOUT = 20000;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const words = argv.filter((a) => !a.startsWith('--'));

/* The key is stripped by VALUE rather than by pattern. A pattern that
   matches long tokens also matches half the path segments in a real
   product URL, and mangling the URLs would destroy the one thing this
   probe is for. */
function safely(value) {
  const key = String(process.env.SERPER_API_KEY || '');
  const raw = value === undefined || value === null ? String(value) : String(value);
  return key ? raw.split(key).join('***') : raw;
}

const isUrl = (value) => typeof value === 'string' && /^(https?:)?\/\//i.test(value.trim());

/* Every url-valued path in a result, however deeply it sits. The paths
   are printed as written so a field that turns out to matter can be
   named exactly — `offers[0].link`, not "somewhere in offers". */
function urlPaths(value, path, into) {
  const found = into || [];
  const here = path || '';

  if (isUrl(value)) {
    found.push({ path: here || '(root)', url: String(value).trim() });
    return found;
  }
  if (!value || typeof value !== 'object') return found;

  if (Array.isArray(value)) {
    value.forEach((entry, i) => urlPaths(entry, `${here}[${i}]`, found));
    return found;
  }
  for (const [key, entry] of Object.entries(value)) {
    urlPaths(entry, here ? `${here}.${key}` : key, found);
  }
  return found;
}

/* Says what a URL is, in the terms the gate uses. Exactly one verdict
   here means a link can be shown, and it is the one with the stars. */
function classify(url) {
  const raw = String(url || '').trim();
  if (!isUrl(raw)) return null;

  let host;
  try { host = new URL(/^\/\//.test(raw) ? `https:${raw}` : raw).hostname; } catch (err) { return 'UNPARSEABLE'; }

  if (/(^|\.)(gstatic\.com|googleusercontent\.com|ggpht\.com)$/i.test(host)) {
    return 'GOOGLE-HOSTED IMAGE — fine as a photo, never a link';
  }

  const resolved = provider.retailerUrl(raw, 0);
  if (!resolved) return "GOOGLE'S OWN / NOT A SHOP — refused as a link";
  if (resolved !== raw) {
    const fault = linkFault(resolved);
    return `FORWARDER -> ${resolved}${fault ? `  (and the gate refuses that: ${fault})` : '  (and that destination is usable)'}`;
  }

  const fault = linkFault(resolved);
  if (fault) return `REFUSED BY THE GATE — ${fault}`;
  return '*** RETAILER PRODUCT PAGE — usable ***';
}

async function post(url, body) {
  const key = String(process.env.SERPER_API_KEY || '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}: ${provider.redact(safely(text)).slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${url} answered with something that is not JSON: ${safely(text).slice(0, 200)}`);
  }
}

function report(results, label) {
  console.log(`\n=== ${label}: every url-valued path, classified ===`);
  const scope = has('all') ? results : results.slice(0, 1);

  scope.forEach((result, i) => {
    const paths = urlPaths(result, '', []);
    console.log(`\n  [${i}] ${String(result && result.title || '(no title)').slice(0, 64)}`);
    if (!paths.length) {
      console.log('       (this result carries no url-valued field at all)');
      return;
    }
    for (const { path, url } of paths) {
      console.log(`       ${path}`);
      console.log(`         ${safely(url)}`);
      console.log(`         ^ ${classify(url)}`);
    }
  });
}

async function main() {
  if (!process.env.SERPER_API_KEY) {
    console.error('SERPER_API_KEY is not set. Export it and run again — the probe makes one live request.');
    process.exit(2);
  }

  const query = words.join(' ') || 'Boxy Cotton Tee';
  const intent = { keywords: query.split(/\s+/) };
  const q = provider.queryFrom(intent) || query;
  const num = Number(flag('num', '20')) || 20;

  console.log(`endpoint : ${SHOPPING_URL}`);
  console.log(`query    : ${q}   (the phrase the adapter builds from the row)`);
  console.log(`asked for: ${num} results`);

  let payload;
  try {
    payload = await post(SHOPPING_URL, {
      q,
      gl: process.env.SERPER_COUNTRY || 'us',
      hl: process.env.SERPER_LANGUAGE || 'en',
      num
    });
  } catch (err) {
    console.error(`\nrequest failed: ${safely(err && err.message)}`);
    process.exit(1);
  }

  console.log(`\nenvelope keys: ${Object.keys(payload || {}).join(', ')}`);
  if (payload && payload.searchParameters) {
    console.log(`searchParameters: ${safely(JSON.stringify(payload.searchParameters))}`);
  }
  if (payload && payload.credits !== undefined) console.log(`credits charged: ${payload.credits}`);

  const results = provider.resultsFrom(payload);
  console.log(`results returned: ${results.length}`);
  if (!results.length) {
    console.log('\nNo results under `shopping` or `shoppingResults`. The envelope keys above say where they went.');
    return;
  }

  const first = results[0];
  console.log('\n=== shopping[0], raw and entire ===');
  console.log(safely(JSON.stringify(first, null, 2)));

  console.log('\n=== shopping[0], key by key ===');
  for (const [key, value] of Object.entries(first)) {
    const shown = value && typeof value === 'object' ? JSON.stringify(value) : String(value);
    console.log(`  ${key.padEnd(22)} ${safely(shown).slice(0, 160)}`);
  }

  report(results, 'shopping[0]' + (has('all') ? ' … [n]' : ''));
  if (has('json')) console.log('\n=== the whole batch, raw ===\n' + safely(JSON.stringify(results, null, 2)));

  /* the batch-wide version of the same question, asked through the
     adapter's own reader so the probe and the adapter cannot disagree */
  const keys = new Set();
  let withRetailer = 0;
  let googleOnly = 0;
  let unlinked = 0;
  for (const result of results) {
    for (const field of provider.urlFieldsOf(result, '', undefined)) keys.add(field);
    if (provider.productUrlFrom(result, 0)) withRetailer += 1;
    else if (urlPaths(result, '', []).length) googleOnly += 1;
    else unlinked += 1;
  }

  console.log(`\n=== across all ${results.length} results ===`);
  console.log(`  yield a retailer URL the adapter can use : ${withRetailer}`);
  console.log(`  carry URLs, but only Google's            : ${googleOnly}`);
  console.log(`  carry no URL at all                      : ${unlinked}`);
  console.log(`  keys URLs arrived under (images aside)   : ${[...keys].sort().join(', ') || '(none)'}`);

  const records = results.map(provider.toRecord).filter(Boolean);
  console.log('\n=== the record the adapter maps out of shopping[0] ===');
  console.log(safely(JSON.stringify(provider.toRecord(first), null, 2)));

  const { products, rejected } = verifyAll(records, { retailer: null });
  console.log('\n=== the verification gate, whole batch ===');
  console.log(`  passed  : ${products.length} / ${records.length}`);
  console.log(`  rejected: ${Object.keys(rejected).length ? JSON.stringify(rejected) : 'none'}`);

  console.log('\n=== verdict ===');
  if (withRetailer) {
    console.log(`  /shopping DOES carry a retailer URL: ${withRetailer} of ${results.length} results.`);
    console.log('  The paths above name the key it arrived under. If that key is not in');
    console.log('  DIRECT_URL_KEYS in api/_providers/serper.js, that is the one-line change.');
  } else {
    console.log(`  /shopping carries NO retailer URL on any of the ${results.length} results.`);
    console.log('  Nothing in the adapter can fix that: the URL is not in the response.');
    console.log('  The next question is whether another Serper result type carries one.');
  }

  const askSearch = has('search') || (!withRetailer && !has('no-search'));
  if (!askSearch) return;

  console.log(`\n=== one more request: the web /search endpoint, same query ===`);
  console.log('  Organic results are ordinary web results, so their `link` is the page');
  console.log('  itself rather than a Shopping card. This says whether that is true here.');

  let web;
  try {
    web = await post(SEARCH_URL, {
      q,
      gl: process.env.SERPER_COUNTRY || 'us',
      hl: process.env.SERPER_LANGUAGE || 'en',
      num: 10
    });
  } catch (err) {
    console.error(`  request failed: ${safely(err && err.message)}`);
    return;
  }

  const organic = Array.isArray(web && web.organic) ? web.organic : [];
  console.log(`\n  envelope keys: ${Object.keys(web || {}).join(', ')}`);
  console.log(`  organic results: ${organic.length}`);

  let usable = 0;
  for (const entry of organic.slice(0, 10)) {
    const verdict = classify(entry && entry.link);
    if (verdict && verdict.startsWith('***')) usable += 1;
    console.log(`\n    ${String(entry && entry.title || '').slice(0, 64)}`);
    console.log(`      ${safely(entry && entry.link)}`);
    console.log(`      ^ ${verdict}`);
  }
  console.log(`\n  ${usable} of ${Math.min(organic.length, 10)} organic links are retailer product pages by the gate's own rule.`);
  console.log('  A result here has a title and a link but NO price and NO photo of its own,');
  console.log('  so it can only feed discovery (which reads the photo off the page), never');
  console.log('  /api/search (whose gate requires a price and a photo from the source).');
}

if (require.main === module) {
  main().catch((err) => { console.error(safely(err && err.message)); process.exit(1); });
} else {
  /* exported for scripts/test-serper.js — required as a module it runs nothing */
  module.exports = { classify, urlPaths, safely, isUrl, SHOPPING_URL, SEARCH_URL };
}
