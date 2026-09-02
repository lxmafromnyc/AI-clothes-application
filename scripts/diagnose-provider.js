#!/usr/bin/env node
/* =========================================================
   Fynd — single-query provider diagnostic

   ONE query against ONE provider, printing only what is safe to paste
   into a ticket. This exists because scripts/bench-providers.js reported
   a wall of zeros without ever saying why: it caught each adapter's
   error, counted it, and threw the message away. A zero with no reason
   is indistinguishable from a zero with a reason you would have fixed in
   a minute, so settle the reason HERE, on one query, before spending
   twenty-four live calls on a benchmark.

     node scripts/diagnose-provider.js serpapi
     node scripts/diagnose-provider.js openwebninja
     node scripts/diagnose-provider.js serpapi --engine google_shopping
     node scripts/diagnose-provider.js serpapi --query "black nike hoodie"

   Exits 0 only when the provider answered 200 AND returned at least one
   result, so it can gate a benchmark run in a shell:

     node scripts/diagnose-provider.js serpapi && \
     node scripts/diagnose-provider.js openwebninja && \
     node scripts/bench-providers.js --live

   ---------------------------------------------------------
   What it prints
   ---------------------------------------------------------
     request URL          with api_key= replaced, never shortened
     HTTP status          the number the provider actually returned
     error message        the response body, truncated, when not 2xx
     results              shopping_results for SerpApi, products for
                          OpenWeb Ninja — the count, not the contents
     verified             how many survive Fynd's real gate
     fetch attempts       whether a request LEFT THIS PROCESS at all,
                          which separates "the network refused us" from
                          "the adapter never got as far as calling out"

   ---------------------------------------------------------
   The credential
   ---------------------------------------------------------
   Read from the environment, never from an argument — a key on the
   command line lands in shell history and in `ps` output.

   SerpApi's key travels as a QUERY PARAMETER, so a SerpApi request URL
   is itself a secret and its own responses echo that URL back inside
   search_metadata. Everything this script prints therefore goes through
   scrub(): the live key values are replaced wherever they appear, and
   any api_key= parameter is rewritten, whether or not it matched a key
   this process knows about. The key's VALUE is never printed, in any
   form — not a prefix, not a length-preserving mask, not a hash.
   ========================================================= */

'use strict';

const PROVIDERS = {
  serpapi: {
    module: '../api/_providers/serpapi',
    envVar: 'SERPAPI_API_KEY',
    resultsKey: 'shopping_results',
    /* SerpApi puts the credential in the query string. */
    keyInUrl: true
  },
  openwebninja: {
    module: '../api/_providers/openwebninja',
    envVar: 'OPENWEBNINJA_API_KEY',
    resultsKey: 'data',
    /* OpenWeb Ninja puts the credential in an x-api-key header, so the
       URL is safe — scrubbed anyway rather than trusted. */
    keyInUrl: false
  }
};

const args = process.argv.slice(2);
const name = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
const flag = (f, fallback) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const QUERY = flag('--query', null);
const ENGINE = flag('--engine', null);

if (!PROVIDERS[name]) {
  console.error(`usage: node scripts/diagnose-provider.js <${Object.keys(PROVIDERS).join('|')}> [--query "..."] [--engine ...]`);
  process.exit(2);
}

const spec = PROVIDERS[name];
const adapter = require(spec.module);

/* -----------------------------------------------------------
   Redaction

   Two independent passes, because either alone has a hole:

     1. every api_key= parameter is rewritten, which catches keys this
        process never saw — one echoed back by the provider, say
     2. the literal values of the keys in this environment are replaced
        wherever they appear, which catches a key that arrives somewhere
        other than an api_key parameter

   Applied to EVERY string this script prints, including error messages
   and response bodies, rather than at each call site where one could be
   forgotten.
   ----------------------------------------------------------- */

const SECRETS = Object.values(PROVIDERS)
  .map((p) => process.env[p.envVar])
  .filter((v) => typeof v === 'string' && v.length >= 8);

function scrub(value) {
  let out = String(value === undefined || value === null ? '' : value);
  /* any api_key parameter, in a URL or in prose */
  out = out.replace(/([?&](?:api_key|apikey|key|token)=)[^&\s"']+/gi, '$1REDACTED');
  /* the literal keys this process holds */
  for (const secret of SECRETS) out = out.split(secret).join('REDACTED');
  return out;
}

const say = (...parts) => console.log(parts.map(scrub).join(''));

/* -----------------------------------------------------------
   The capturing fetch

   Wraps the real fetch rather than replacing it, so the adapter's OWN
   code path runs — its URL building, its headers, its timeout and its
   error handling. A diagnostic that reimplements the request proves
   nothing about the adapter.
   ----------------------------------------------------------- */

function capturingFetch() {
  const real = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    const record = { url: String(url), status: null, statusText: null, body: null, error: null, ms: 0 };
    seen.push(record);
    const startedAt = Date.now();
    try {
      const response = await real(url, init);
      record.status = response.status;
      record.statusText = response.statusText;
      /* Read the body once, here, then hand the adapter a replayable
         clone — otherwise reading it for diagnostics would consume the
         stream the adapter is about to parse. */
      const body = await response.text();
      record.body = body;
      record.ms = Date.now() - startedAt;
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        json: async () => JSON.parse(body),
        text: async () => body
      };
    } catch (err) {
      record.error = (err && err.message) || String(err);
      record.ms = Date.now() - startedAt;
      throw err;
    }
  };
  return { seen, restore: () => { global.fetch = real; } };
}

/* How many results the PROVIDER returned, read from the raw body rather
   than from what the adapter chose to keep — an adapter that drops its
   own unusable records would otherwise report zero for a healthy
   response, which is the exact confusion this script exists to end. */
function countResults(body) {
  if (!body) return null;
  let payload;
  try { payload = JSON.parse(body); } catch (err) { return null; }
  const direct = payload && payload[spec.resultsKey];
  if (Array.isArray(direct)) return direct.length;
  /* OpenWeb Ninja nests its products under data.products on some routes */
  if (direct && Array.isArray(direct.products)) return direct.products.length;
  for (const key of ['products', 'results', 'items']) {
    if (Array.isArray(payload && payload[key])) return payload[key].length;
  }
  return null;
}

/* Every leaf of the first result, as path + type + a short sample.

   This is the answer to "what does this engine actually call the
   merchant URL?", taken from the response itself rather than from
   anyone's memory of the documentation. It prints automatically when
   the provider returned results but the adapter mapped none of them —
   which is exactly the moment the field names are the whole question.

   Product data is not secret and is shown, truncated. It still goes
   through scrub() on the way out, because a response that echoes the
   request back (SerpApi's search_metadata does) would otherwise carry
   the credential into this output. */
const MAX_DUMP_DEPTH = 6;
const MAX_DUMP_LINES = 120;

function leaves(node, path, out, depth) {
  if (out.length >= MAX_DUMP_LINES || depth > MAX_DUMP_DEPTH) return out;
  if (node === null || typeof node !== 'object') {
    out.push({ path, type: node === null ? 'null' : typeof node, value: node });
    return out;
  }
  if (Array.isArray(node)) {
    if (!node.length) out.push({ path, type: 'array[0]', value: '' });
    for (let i = 0; i < node.length && out.length < MAX_DUMP_LINES; i += 1) {
      leaves(node[i], `${path}[${i}]`, out, depth + 1);
    }
    return out;
  }
  const keys = Object.keys(node);
  if (!keys.length) out.push({ path, type: 'object{}', value: '' });
  for (const key of keys) {
    if (out.length >= MAX_DUMP_LINES) break;
    leaves(node[key], path ? `${path}.${key}` : key, out, depth + 1);
  }
  return out;
}

/* Marks the leaves that could be a destination, so the merchant URL is
   findable by eye in a long inventory. */
function urlNote(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return '';
  let url;
  try { url = new URL(value); } catch (err) { return '   <- unparseable url'; }
  if (/(^|\.)serpapi\.com$/i.test(url.hostname)) return '   <- SerpApi endpoint, not a retailer';
  if (/(^|\.)(google\.[a-z.]+|googleusercontent\.com|gstatic\.com|googleadservices\.com)$/i.test(url.hostname)) {
    return '   <- GOOGLE host, refused by the gate';
  }
  if (/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(url.pathname)) return '   <- image';
  return '   <- ** CANDIDATE MERCHANT URL **';
}

function dumpFirstResult(body) {
  if (!body) return;
  let payload;
  try { payload = JSON.parse(body); } catch (err) { return; }
  let list = payload && payload[spec.resultsKey];
  if (!Array.isArray(list)) {
    for (const key of ['shopping_results', 'inline_shopping_results', 'products', 'results', 'items']) {
      if (Array.isArray(payload && payload[key])) { list = payload[key]; break; }
    }
  }
  if (!Array.isArray(list) || !list.length) return;

  console.log('');
  say(`  FIRST RESULT — every field the provider actually returned`);
  say(`  (${spec.resultsKey}[0]; product data shown, credentials scrubbed)`);
  console.log('');
  const rows = leaves(list[0], '', [], 0);
  for (const r of rows) {
    let sample = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
    sample = String(sample === undefined ? '' : sample);
    if (sample.length > 78) sample = sample.slice(0, 78) + '...';
    say('    ' + r.path.slice(0, 38).padEnd(40) + r.type.padEnd(9) + sample + urlNote(r.value));
  }
  if (rows.length >= MAX_DUMP_LINES) say(`    ... truncated at ${MAX_DUMP_LINES} fields`);
}

/* The provider's own words for what went wrong, dug out of whichever
   field it uses. Truncated, and scrubbed by say() on the way out. */
function errorMessage(body) {
  if (!body) return null;
  let payload;
  try { payload = JSON.parse(body); } catch (err) { return body.slice(0, 300); }
  for (const key of ['error', 'message', 'detail', 'errors', 'status_message']) {
    const v = payload && payload[key];
    if (typeof v === 'string' && v.trim()) return v.slice(0, 300);
    if (v) return JSON.stringify(v).slice(0, 300);
  }
  return null;
}

async function main() {
  if (ENGINE) process.env.SERPAPI_ENGINE = ENGINE;

  const intent = QUERY
    ? { keywords: QUERY.split(/\s+/).filter(Boolean) }
    : { categories: ['shirt'], colors: ['Black'], keywords: ['black', 'shirt'] };

  console.log('');
  console.log('='.repeat(84));
  say(`single-query diagnostic — ${name}`);
  console.log('='.repeat(84));

  const phrase = typeof adapter.queryFrom === 'function' ? adapter.queryFrom(intent) : JSON.stringify(intent);
  say(`  query              "${phrase}"`);
  if (name === 'serpapi') say(`  engine             ${process.env.SERPAPI_ENGINE || 'google_shopping_light (default)'}`);

  /* Presence only. Never the value, never a prefix, never a length —
     a length narrows a brute force and buys the reader nothing. */
  const configured = typeof adapter.configured === 'function' ? adapter.configured() : Boolean(process.env[spec.envVar]);
  say(`  ${spec.envVar.padEnd(18)} ${configured ? 'present' : 'NOT SET'}`);
  say(`  credential travels ${spec.keyInUrl ? 'in the query string (URL is itself a secret)' : 'in an x-api-key header'}`);

  if (!configured) {
    console.log('');
    say(`  RESULT: no request attempted — ${spec.envVar} is not set in this environment.`);
    say('  Export it in the shell that runs this; it is never read from a file or an argument.');
    console.log('');
    process.exit(1);
  }

  const cap = capturingFetch();
  const startedAt = Date.now();
  let records = null;
  let thrown = null;
  try {
    records = await adapter.search(intent, { limit: 12 });
  } catch (err) {
    thrown = (err && err.message) || String(err);
  } finally {
    cap.restore();
  }
  const wallMs = Date.now() - startedAt;

  console.log('');
  say(`  fetch attempts     ${cap.seen.length}` +
    (cap.seen.length === 0 ? '   <-- NO REQUEST LEFT THIS PROCESS' : ''));
  say(`  wall clock         ${wallMs} ms`);

  for (const [i, r] of cap.seen.entries()) {
    console.log('');
    say(`  request ${i + 1} of ${cap.seen.length}`);
    /* redactUrl is the adapter's own redaction where it has one, so this
       also exercises the guarantee the benchmark asserts. */
    const shown = typeof adapter.redactUrl === 'function' ? adapter.redactUrl(r.url) : r.url;
    say(`    url              ${shown}`);
    if (r.error !== null) {
      say(`    transport error  ${r.error}`);
      say('    (no HTTP status: the connection itself failed — DNS, TLS, proxy or timeout)');
      continue;
    }
    say(`    HTTP status      ${r.status} ${r.statusText || ''}`);
    say(`    latency          ${r.ms} ms`);
    const msg = errorMessage(r.body);
    if (r.status >= 400) say(`    error message    ${msg || '(no message in body)'}`);
    const n = countResults(r.body);
    say(`    ${spec.resultsKey.padEnd(16)} ${n === null ? 'absent from the response' : n}`);
  }

  console.log('');
  if (thrown) {
    say(`  ADAPTER THREW: ${thrown}`);
  } else {
    const returned = (records && records.diagnostics && records.diagnostics.returnedByProvider);
    say(`  adapter returned   ${Array.isArray(records) ? records.length : 0} records` +
      (returned ? ` (provider returned ${returned})` : ''));
    if (records && records.diagnostics && records.diagnostics.verdict) {
      say(`  verdict            ${records.diagnostics.verdict}`);
    }
  }

  /* The field inventory, printed exactly when it is the question: the
     provider answered with results and the adapter mapped none of them. */
  const returnedCount = cap.seen.reduce((a, r) => Math.max(a, countResults(r.body) || 0), 0);
  const mapped = Array.isArray(records) ? records.length : 0;
  if (returnedCount > 0 && mapped === 0) {
    console.log('');
    say(`  ${returnedCount} results came back and the adapter mapped 0 of them.`);
    say('  The fields below are what it had to work with:');
    for (const r of cap.seen) dumpFirstResult(r.body);
  } else if (args.includes('--dump-first')) {
    for (const r of cap.seen) dumpFirstResult(r.body);
  }

  /* The real gate, so "verified" here means what it means in production. */
  let verified = 0;
  try {
    const { verifyAll } = require('../api/_providers/product-source');
    verified = verifyAll(Array.isArray(records) ? records : [], { retailer: adapter.defaultRetailer }).products.length;
  } catch (err) {
    verified = 0;
  }
  say(`  verified by gate   ${verified}`);

  const httpOk = cap.seen.length > 0 && cap.seen.every((r) => r.error === null && r.status < 400);
  const gotResults = cap.seen.some((r) => (countResults(r.body) || 0) > 0);

  console.log('');
  if (!httpOk) {
    say('  RESULT: FAILED — see the status and error message above. Do not run the');
    say('  benchmark until this returns 200; a benchmark cannot report what it cannot reach.');
    console.log('');
    process.exit(1);
  }
  if (!gotResults) {
    say('  RESULT: reached the provider (200) but it returned no results for this query.');
    say('  That is a query or engine problem, not a credential or network one.');
    console.log('');
    process.exit(1);
  }
  /* A 200 full of results that the adapter maps to nothing is NOT a
     green light. Saying "safe to run the benchmark" here would send
     twelve more queries at a mapping that is known to drop everything,
     and would report the result as a provider finding. */
  if (mapped === 0) {
    say(`  RESULT: MAPPING FAILURE — the provider answered 200 with ${returnedCount} results and the`);
    say('  adapter mapped 0 of them. The network and the credential are fine; the response');
    say('  parsing is not. The field inventory above shows what the response actually holds.');
    console.log('');
    process.exit(1);
  }
  if (verified === 0) {
    say(`  RESULT: the adapter mapped ${mapped} records but Fynd's gate verified none of them.`);
    say('  The gate\'s rejection reasons are the next thing to read.');
    console.log('');
    process.exit(1);
  }
  say(`  RESULT: OK — 200, ${returnedCount} results, ${mapped} mapped, ${verified} verified. Safe to run the benchmark.`);
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error(scrub(`diagnostic failed: ${(err && err.message) || err}`));
  process.exit(1);
});
