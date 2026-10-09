#!/usr/bin/env node
/* =========================================================
   FindWear — OpenWeb Ninja response probe

   Confirms the live response schema against the adapter's mapping. The
   adapter's request parameters were taken from the vendor's published
   OpenAPI manifest; the per-field response names come from published
   documentation and are accepted tolerantly. This script is how you
   check them against a real call.

   Usage
     node --env-file=.env.local scripts/probe-openwebninja.js "black oversized hoodie"
       [--local]            the page's local reading even if OPENAI_API_KEY is set
       [--body body.json]   the exact body the browser posted (from its network panel)
       [--keywords]         the raw words as keywords, as the probe used to send them
       [--budget-ms N]      a request budget other than /api/search's own
       [--no-photos] [--json] [--site https://...]

   It runs /api/search's own search (runSearch in api/search.js) on the
   body the page would post, under the route's own deadline, and prints:
     1. every request sent to OpenWeb Ninja — and to Serper, when the
        route falls back to it: source, path, parameters, header names,
        status, time, and whether the clock aborted it
     2. the response envelope's top-level keys, every key on the first
        product and on its offer, and the record the adapter maps out
     3. what /api/search would answer: the status, and the verified
        products or the failure's kind and upstream status
     4. the PHOTOS: which field each one came from, whether the URL
        answers with an actual image, whether it answers differently
        when a referrer is sent, whether it is signed or expiring

   Nothing is written anywhere. No API key is printed, and no photo URL
   is printed whole: a signed URL carries its signature in the query, so
   only the scheme, the host and the NAMES of the query keys are shown.
   ========================================================= */

'use strict';

const provider = require('../api/_providers/openwebninja');

const keysOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);

/* long values are cut so the output stays readable, but URLs are shown in
   full: whether a link is a retailer page or a Google page is the whole
   question this probe exists to answer */
function preview(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    return `[${value.length}] ` + (value.length ? preview(value[0]) : '');
  }
  if (typeof value === 'object') return `{${Object.keys(value).join(', ')}}`;
  const s = String(value);
  if (/^https?:\/\//i.test(s)) return s;
  return s.length > 70 ? s.slice(0, 70) + '…' : s;
}

function dump(label, obj) {
  console.log(`\n--- ${label} ---`);
  if (!obj || typeof obj !== 'object') return console.log('  (not an object):', preview(obj));
  for (const key of Object.keys(obj)) console.log(`  ${key.padEnd(26)} ${preview(obj[key])}`);
}

/* ---------------------------------------------------------
   Photos
   ---------------------------------------------------------
   The card shows the source's own photo or it shows drawn artwork.
   Which of those a shopper gets is decided by whether this URL answers
   with an image when a browser asks for it, and that is a question only
   a real call can settle.
   --------------------------------------------------------- */

/* Query keys that mean a URL is signed, and therefore stops working on
   its own schedule. Their VALUES are never printed. */
const SIGNING_KEY = /^(sig|signature|token|expires?|exp|hmac|policy|x-amz-|x-goog-|key-pair-id)/i;

const PHOTO_TIMEOUT = 10000;

/* Everything that can be said about a URL without quoting it. */
function describeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (err) { return { safe: '(not a URL)', https: false, signed: null }; }
  const keys = [...url.searchParams.keys()];
  const signed = keys.filter((k) => SIGNING_KEY.test(k));
  return {
    safe: `${url.protocol}//${url.host}  path ${url.pathname.length} chars, `
      + (keys.length ? `query keys: ${keys.join(', ')}` : 'no query'),
    https: url.protocol === 'https:',
    signed: signed.length ? signed.join(', ') : null
  };
}

/* One request for the picture. `referer` null is how the card asks for
   it — the img carries referrerpolicy="no-referrer" — so the plain call
   is the one that matches what a shopper's browser actually does. */
async function askForPhoto(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PHOTO_TIMEOUT);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: referer ? { Referer: referer } : {}
    });
    const type = (response.headers.get('content-type') || '').split(';')[0];
    let bytes = 0;
    try { bytes = (await response.arrayBuffer()).byteLength; } catch (err) { bytes = 0; }
    return { status: response.status, type, bytes, image: /^image\//i.test(type) && bytes > 0 };
  } catch (err) {
    return { status: null, type: '', bytes: 0, image: false, failed: (err && err.name === 'AbortError') ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/* Every photo URL a product carries, labelled with the field it came
   from, in the order the adapter reads them. */
function photoCandidates(product) {
  const out = [];
  const add = (field, value) => {
    const url = typeof value === 'string' ? value.trim() : '';
    if (url && !out.some((c) => c.url === url)) out.push({ field, url });
  };
  for (const key of provider.PHOTO_LIST_KEYS) {
    const list = product[key];
    if (!Array.isArray(list)) continue;
    list.forEach((entry, i) => {
      if (typeof entry === 'string') return add(`${key}[${i}]`, entry);
      if (entry && typeof entry === 'object') {
        for (const inner of ['url', 'link', 'src', 'image_url']) add(`${key}[${i}].${inner}`, entry[inner]);
      }
    });
  }
  for (const key of provider.PHOTO_SINGLE_KEYS) add(key, product[key]);
  return out;
}

async function reportPhotos(results, site) {
  console.log('\n\n=========================================================');
  console.log('  PHOTOS');
  console.log('=========================================================');
  console.log(`  referrer used for the second request: ${site}`);

  const sample = results.slice(0, 5);
  const fieldCount = {};
  let productsWithAPhoto = 0;
  let productsWithAShowablePhoto = 0;
  let chosenWorked = 0;
  let anotherFieldWouldHave = 0;

  for (const [i, product] of sample.entries()) {
    const candidates = photoCandidates(product);
    const chosen = provider.imageFrom(product);
    candidates.forEach((c) => { fieldCount[c.field.replace(/\[\d+\]/, '[n]')] = (fieldCount[c.field.replace(/\[\d+\]/, '[n]')] || 0) + 1; });

    console.log(`\n--- product[${i}] — ${String(product.product_title || '').slice(0, 48)} ---`);
    if (!candidates.length) {
      console.log('  NO PHOTO FIELD AT ALL. This record is dropped by the gate as missing-image-url.');
      continue;
    }
    productsWithAPhoto += 1;
    console.log(`  photo fields present : ${candidates.map((c) => c.field).join(', ')}`);
    console.log(`  the adapter takes    : ${candidates.find((c) => c.url === chosen) ? candidates.find((c) => c.url === chosen).field : '(none)'}`);

    let showable = false;
    let first = true;
    for (const candidate of candidates) {
      const shape = describeUrl(candidate.url);
      const plain = await askForPhoto(candidate.url, null);
      const withRef = await askForPhoto(candidate.url, site);

      console.log(`\n  ${candidate.field}`);
      console.log(`    ${shape.safe}`);
      console.log(`    https              : ${shape.https ? 'yes' : 'NO — the gate rejects this as image-url-not-https'}`);
      console.log(`    signed / expiring  : ${shape.signed ? `YES (${shape.signed}) — this URL stops working on its own` : 'no signing keys in the query'}`);
      console.log(`    as the card asks   : ${plain.failed || `${plain.status} ${plain.type || '(no type)'} ${plain.bytes} bytes`}${plain.image ? '  <- an image' : ''}`);
      console.log(`    with a referrer    : ${withRef.failed || `${withRef.status} ${withRef.type || '(no type)'} ${withRef.bytes} bytes`}`);
      if (plain.image && !withRef.image) console.log('    HOTLINK PROTECTED  : served plainly, refused with our referrer.');
      if (!plain.image && withRef.image) console.log('    WANTS A REFERRER   : refused plainly, served with one.');

      const usable = shape.https && plain.image;
      if (usable && !showable) {
        showable = true;
        if (candidate.url === chosen) chosenWorked += 1;
        else { anotherFieldWouldHave += 1; console.log(`    BETTER THAN THE CHOSEN FIELD: this one works and the chosen one did not.`); }
      }
      first = false;
    }
    if (showable) productsWithAShowablePhoto += 1;
    else console.log('\n  Nothing this product carries can be shown. Artwork is the honest answer for it.');
  }

  console.log('\n--- across the sample ---');
  console.log(`  products checked                 : ${sample.length}`);
  console.log(`  carrying at least one photo field: ${productsWithAPhoto}`);
  console.log(`  with a photo that really loads   : ${productsWithAShowablePhoto}`
    + (sample.length ? `  (${Math.round((productsWithAShowablePhoto / sample.length) * 100)}%)` : ''));
  console.log(`  where the adapter's choice worked: ${chosenWorked}`);
  console.log(`  where another field was better   : ${anotherFieldWouldHave}`);
  console.log('\n  Field frequency in the sample:');
  for (const [field, n] of Object.entries(fieldCount).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${field.padEnd(26)} ${n}`);
  }
  console.log('');
}

/* ---------------------------------------------------------
   The probe: /api/search's own search, watched
   ---------------------------------------------------------
   It used to send a /search request of its own and look the offers up
   its own way: the same builder, but not the same request — the raw
   words as keywords where the route has the page's reading of them (a
   different q, no max_price), no deadline where the route has one, its
   own offer lookups where the route caps and orders them. A probe that
   worked therefore said little about the route.

   Now it runs runSearch() from api/search.js — the route's search,
   everything but the shopper's allowance — on the body the page would
   post, under the route's own deadline, and watches every request that
   goes to OpenWeb Ninja on the way: path, parameters, the NAMES of the
   headers (whether the key sent is the one this environment holds, as a
   yes or no), status, time, and whether the clock aborted it. The raw
   /search envelope is read from that same response, so there is still
   one provider search, not two.

   The route falls back to Serper when OpenWeb Ninja says its allowance
   is spent (searchWithFallback, through providerChain). The probe runs
   that same chain, so it watches Serper's host too: a fallback is then
   one more request in the list, under its own source, instead of a
   search the route made and the probe never showed. */

const { runSearch, shapeIntent, requestBudget } = require('../api/search');
const { getProvider, failureKind } = require('../api/_providers/product-source');
const { envReport } = require('../api/_env-report');

/* the hosts the route's provider chain can ask, and the key each one
   is sent with — read as each adapter reads it */
const PROVIDER_HOSTS = {
  'api.openwebninja.com': { source: 'openwebninja', key: () => provider.apiKey() },
  'google.serper.dev': { source: 'serper', key: () => String(process.env.SERPER_API_KEY || '').trim() }
};
const SEARCH_PATH = /\/(search|shopping)$/;

/* the scalar fields of a JSON request body (Serper posts its query):
   what was asked, never a header */
function bodyFields(body) {
  if (typeof body !== 'string') return {};
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, String(v)]));
  } catch (err) {
    return {};
  }
}

/* every request to a provider, with nothing secret in it */
function watchProvider() {
  const real = global.fetch;
  const calls = [];
  const seen = { envelope: null };
  global.fetch = async (input, init) => {
    const href = String(input && input.url ? input.url : input);
    let url;
    try { url = new URL(href); } catch (err) { return real(input, init); }
    const host = PROVIDER_HOSTS[url.hostname];
    if (!host) return real(input, init);
    const headers = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = {
      source: host.source,
      method: (init && init.method) || 'GET',
      path: url.pathname,
      params: Object.assign(Object.fromEntries(url.searchParams.entries()), bodyFields(init && init.body)),
      headerNames: Object.keys(headers).sort(),
      /* a yes or no, never the key */
      keyIsThisEnvironments: Boolean(host.key()) && headers['x-api-key'] === host.key(),
      status: null,
      ms: null,
      abortedAfterMs: null,
      error: null
    };
    calls.push(call);
    const startedAt = Date.now();
    const signal = init && init.signal;
    if (signal) signal.addEventListener('abort', () => { call.abortedAfterMs = Date.now() - startedAt; });
    try {
      const response = await real(input, init);
      call.status = response.status;
      call.ms = Date.now() - startedAt;
      if (host.source === 'openwebninja' && /\/search$/.test(url.pathname) && response.ok && !seen.envelope) {
        try { seen.envelope = await response.clone().json(); } catch (err) { seen.envelope = { unreadable: String(err && err.message).slice(0, 80) }; }
      }
      return response;
    } catch (err) {
      call.ms = Date.now() - startedAt;
      const cause = err && err.cause ? (err.cause.code || '') : '';
      call.error = `${err && err.name === 'AbortError' ? 'aborted' : String(err && err.message).split('\n')[0].slice(0, 80)}${cause ? ` (${cause})` : ''}`;
      throw err;
    }
  };
  return { calls, seen, restore: () => { global.fetch = real; } };
}

/* The body the route is given: as the page would post it (its own
   reader, or the served interpreter when it is configured here), a body
   copied from the browser, or — only when asked — the raw words. */
async function bodyFor(o) {
  if (o.body) return { body: o.body, input: 'the body given' };
  if (o.keywords) return { body: { intent: { keywords: o.query.split(/\s+/).filter(Boolean) }, limit: 12 }, input: 'the raw words as keywords' };
  const { browserBody } = require('./diagnose-search');
  const read = await browserBody(o.query, { served: !o.local });
  return { body: read.body, input: `the page's ${read.interpreter} reading` };
}

function fellBackFrom(outcome) {
  const refused = outcome.status === 200 ? outcome.found && outcome.found.fellBackFrom : outcome.error && outcome.error.fellBackFrom;
  return refused ? { provider: refused.provider, kind: failureKind(refused.reason) } : null;
}

/* Runs the probe and says what happened; prints nothing. */
async function probe(options) {
  const o = Object.assign({ query: 'black oversized hoodie' }, options || {});
  /* the key first: with none, the route has no source at all and answers 503 */
  if (!provider.configured()) throw new Error('OPENWEBNINJA_API_KEY is not set in this environment');
  const source = getProvider();
  if (source.name !== provider.name) throw new Error(`the configured product source is ${source.name}, not OpenWeb Ninja`);

  const { body, input } = await bodyFor(o);
  const intent = shapeIntent(body && body.intent);
  const budgetMs = Number(o.budgetMs) > 0 ? Number(o.budgetMs) : requestBudget();
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const plannedSearchTimeoutMs = provider.searchLegTimeout(deadline);

  const watch = watchProvider();
  let outcome;
  try {
    outcome = await runSearch(body, { provider: source, startedAt, budgetMs, deadline });
  } finally {
    watch.restore();
  }
  const answer = outcome.status === 200 ? outcome.compose(null) : outcome.body;
  return {
    input,
    body,
    intent,
    budgetMs,
    plannedSearchTimeoutMs,
    calls: watch.calls,
    envelope: watch.seen.envelope,
    status: outcome.status,
    answer,
    /* when OpenWeb Ninja refused for want of searches and the route asked
       the fallback: which source refused, and the kind of refusal — never
       its message */
    fellBackFrom: fellBackFrom(outcome),
    /* the failure as /api/search classifies it, when there was one */
    failure: outcome.status === 200 ? null : { kind: outcome.body.kind || failureKind(outcome.error), upstreamStatus: outcome.body.upstreamStatus === undefined ? null : outcome.body.upstreamStatus, stage: outcome.body.stage || null }
  };
}

function flags(argv) {
  const value = (flag) => { const at = argv.indexOf(flag); return at === -1 ? null : argv[at + 1]; };
  const valued = new Set(['--site', '--body', '--budget-ms']);
  const words = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const file = value('--body');
  return {
    query: words.join(' ') || 'black oversized hoodie',
    body: file ? JSON.parse(require('fs').readFileSync(file, 'utf8')) : null,
    keywords: argv.includes('--keywords'),
    local: argv.includes('--local'),
    budgetMs: value('--budget-ms'),
    photos: !argv.includes('--no-photos'),
    json: argv.includes('--json'),
    site: value('--site') || 'https://ai-clothes-application.vercel.app'
  };
}

async function main() {
  const o = flags(process.argv.slice(2));
  if (!provider.configured()) {
    console.error('OPENWEBNINJA_API_KEY is not set. Run with: node --env-file=.env.local scripts/probe-openwebninja.js "..."');
    console.error(`env: ${JSON.stringify(envReport())}`);
    process.exit(2);
  }
  const r = await probe(o);
  if (o.json) {
    console.log(JSON.stringify(Object.assign({}, r, { envelope: r.envelope ? { keys: keysOf(r.envelope) } : null }), null, 2));
    process.exit(r.status === 200 ? 0 : 1);
  }

  console.log(`input    : ${r.input}${o.body ? '' : ` of "${o.query}"`}`);
  console.log(`env      : ${JSON.stringify(envReport())}  (states only, never values)`);
  console.log(`deadline : ${r.budgetMs}ms budget; the /search leg was given ${r.plannedSearchTimeoutMs}ms`);
  r.calls.forEach((c, i) => {
    const params = Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join('&');
    console.log(`request ${i + 1}: [${c.source}] ${c.method} ${c.path}?${params}`);
    console.log(`           headers: ${c.headerNames.join(', ')} (x-api-key ${c.keyIsThisEnvironments ? 'is' : 'is NOT'} this environment's ${c.source === 'serper' ? 'SERPER_API_KEY' : 'OPENWEBNINJA_API_KEY'}; never printed)`);
    console.log(`           -> ${c.status === null ? `no answer: ${c.error}` : c.status} in ${c.ms}ms${c.abortedAfterMs !== null ? ` (aborted by the clock after ${c.abortedAfterMs}ms)` : ''}`);
  });
  const bySource = {};
  for (const c of r.calls) {
    const counts = bySource[c.source] || (bySource[c.source] = { searches: 0, lookups: 0 });
    if (SEARCH_PATH.test(c.path)) counts.searches += 1; else counts.lookups += 1;
  }
  console.log(`provider : ${Object.entries(bySource).map(([name, n]) => `${name} ${n.searches} search${n.searches === 1 ? '' : 'es'}, ${n.lookups} offer lookups`).join('; ') || 'no request (answered from the search cache)'}`);
  if (r.fellBackFrom) console.log(`fallback : ${r.fellBackFrom.provider} refused (${r.fellBackFrom.kind}), so the route asked the next source, as it would for a shopper`);

  if (r.status !== 200) {
    console.log(`\n/api/search would answer: ${r.status} ${JSON.stringify(r.answer)}`);
    process.exit(1);
  }

  const payload = r.envelope;
  const results = payload ? provider.resultsFrom(payload) : [];
  if (payload) {
    console.log(`\nenvelope keys: ${keysOf(payload).join(', ')}`);
    console.log(`products returned: ${results.length}`);
  } else if (r.fellBackFrom) {
    console.log(`\n(answered by ${r.answer.source} after ${r.fellBackFrom.provider} refused: there is no OpenWeb Ninja envelope to show)`);
  } else {
    console.log('\n(answered from the search cache: no envelope was fetched)');
  }
  if (results.length) {
    dump('product[0]', results[0]);
    const offer = provider.offerFrom(results[0]);
    if (offer) dump('product[0] offer', offer);
    else console.log('\n--- product[0] offer ---\n  NONE FOUND. offerFrom() did not recognise an offer on this product.');
    console.log('\n--- adapter mapping of product[0] ---');
    console.log(JSON.stringify(provider.toRecord(results[0]), null, 2));
    const inline = provider.inlineCommerce(results[0]);
    console.log('\n--- can this record supply a retailer link on its own? ---');
    console.log(inline ? `  yes: ${inline.retailer} -> ${inline.productUrl}` : '  no. product_page_url is Google\'s, so /product-offers is needed.');
  }

  const a = r.answer;
  console.log(`\n/api/search would answer: 200 with ${a.products.length} verified products (of ${a.returned} the source returned)`);
  console.log(`  rejected: ${Object.keys(a.rejected || {}).length ? JSON.stringify(a.rejected) : 'none'}`);
  console.log(`  offers  : ${JSON.stringify((a.diagnostics && a.diagnostics.offers) || null)}`);
  if (a.products.length) {
    console.log('\n--- first verified product as the browser would receive it ---');
    console.log(JSON.stringify(a.products[0], null, 2));
  } else {
    console.log('\nNothing passed the gate. The reasons above name the missing or unusable field for each record.');
  }

  /* the question the gate cannot answer: not whether a URL is there,
     but whether it answers with a picture */
  if (o.photos && results.length) await reportPhotos(results, o.site);
}

/* Run as a script; required as a module by scripts/test-pipeline.js, so
   the parts that read a response can be tested without a live call. */
if (require.main === module) {
  main().catch((err) => { console.error(err && err.message); process.exit(1); });
}

module.exports = { describeUrl, photoCandidates, SIGNING_KEY, probe, watchProvider, flags };
