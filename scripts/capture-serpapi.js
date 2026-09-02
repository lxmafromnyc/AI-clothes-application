#!/usr/bin/env node
/* =========================================================
   Fynd — SerpApi live response capture (safely redacted)

   Answers one question: what does a SerpApi shopping result ACTUALLY
   contain, and which of Fynd's five required fields is missing?

     node scripts/capture-serpapi.js
     node scripts/capture-serpapi.js --engine google_shopping
     node scripts/capture-serpapi.js --compare        both engines
     node scripts/capture-serpapi.js --out sample.json

   Requires SERPAPI_API_KEY in the environment. Never pass a key on the
   command line — it would land in your shell history and in ps output.

   ---------------------------------------------------------
   What is redacted, and why it has to be
   ---------------------------------------------------------
   SerpApi's credential travels as an `api_key` QUERY PARAMETER, and its
   own response echoes request URLs back at you: search_metadata carries
   json_endpoint, raw_html_file and friends, several of which contain the
   key. A naive dump of a SerpApi response is therefore a published
   credential.

   So: every string value in the captured sample is walked, and anything
   that looks like a URL has its api_key replaced. Keys whose NAME marks
   them as credential-bearing are dropped outright. The result is safe to
   paste into a ticket or hand to someone else.

   Product data itself is not secret and is kept verbatim — the point is
   to see the real field names and shapes.
   ========================================================= */

'use strict';

const fs = require('fs');
const serp = require('../api/_providers/serpapi');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const COMPARE = args.includes('--compare');
const OUT = flag('--out', null);
const QUERY = flag('--query', 'black oversized nike hoodie');
const ENGINES = COMPARE ? ['google_shopping_light', 'google_shopping'] : [flag('--engine', 'google_shopping_light')];

/* Key names whose VALUE is a credential or carries one. Dropped, not
   redacted, because there is no version of them worth reading. */
const SECRET_KEY = /^(api_key|apikey|token|secret|authorization|serpapi_api_key)$/i;
/* Key names SerpApi uses for URLs that embed the request, key included. */
const ECHO_KEY = /^(json_endpoint|raw_html_file|prettify_html_file|serpapi_.*_link|.*_endpoint)$/i;

function redactValue(v) {
  if (typeof v !== 'string') return v;
  if (!/^https?:\/\//i.test(v)) return v;
  try {
    const url = new URL(v);
    let touched = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (SECRET_KEY.test(key)) { url.searchParams.set(key, 'REDACTED'); touched = true; }
    }
    return touched ? url.href : v;
  } catch (err) {
    return v;
  }
}

/* Walks the whole payload. Depth-limited so a cyclic or pathological
   response cannot hang the capture. */
function redact(node, depth) {
  if (depth > 12) return '[depth limit]';
  if (Array.isArray(node)) return node.map((n) => redact(n, depth + 1));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (SECRET_KEY.test(k)) { out[k] = 'REDACTED'; continue; }
      if (ECHO_KEY.test(k) && typeof v === 'string') { out[k] = redactValue(v); continue; }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return redactValue(node);
}

/* Fynd's gate requires all five. This is the table that says which one
   is the problem. */
const REQUIRED = ['title', 'price', 'imageUrl', 'productUrl', 'retailer'];

function inventory(results) {
  const fields = new Map();
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    for (const [k, v] of Object.entries(r)) {
      if (!fields.has(k)) fields.set(k, { count: 0, sample: null, type: Array.isArray(v) ? 'array' : typeof v });
      const f = fields.get(k);
      f.count += 1;
      if (f.sample === null && v !== null && v !== '') {
        const s = Array.isArray(v) ? JSON.stringify(v) : String(v);
        f.sample = redactValue(s).slice(0, 78);
      }
    }
  }
  return [...fields.entries()].sort((a, b) => b[1].count - a[1].count);
}

async function run(engineName) {
  process.env.SERPAPI_ENGINE = engineName;
  const intent = { categories: ['knit'], colors: ['black'], fits: ['oversized'], brands: ['Nike'], keywords: ['hoodie'] };

  console.log('\n' + '='.repeat(92));
  console.log(`engine: ${engineName}`);
  console.log(`query:  "${serp.queryFrom(intent)}"`);
  console.log('='.repeat(92));

  /* Capture the raw payload by intercepting the adapter's own fetch, so
     what is inspected is exactly what the adapter saw. */
  let raw = null;
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const response = await realFetch(url, init);
    const body = await response.text();
    try { raw = JSON.parse(body); } catch (err) { raw = { unparseable: body.slice(0, 400) }; }
    return { ok: response.ok, status: response.status, json: async () => raw, text: async () => body };
  };

  const startedAt = Date.now();
  let records;
  let failure = null;
  try {
    records = await serp.search(intent, { limit: 12 });
  } catch (err) {
    failure = err && err.message;
    records = [];
  } finally {
    global.fetch = realFetch;
  }
  const elapsed = Date.now() - startedAt;

  if (failure) {
    console.log(`\n  REQUEST FAILED: ${failure}`);
    return { engineName, failure };
  }

  const results = serp.resultsFrom(raw);
  const d = records.diagnostics || {};

  console.log(`\n  latency            ${elapsed} ms`);
  console.log(`  top-level keys     ${Object.keys(raw || {}).join(', ')}`);
  console.log(`  results returned   ${results.length}`);
  console.log(`  verdict            ${d.verdict}`);

  console.log('\n  FIELD INVENTORY  (present on N of ' + results.length + ' results)');
  console.log('    ' + 'field'.padEnd(32) + 'n'.padStart(5) + '  type      sample');
  for (const [name, f] of inventory(results)) {
    console.log('    ' + name.slice(0, 31).padEnd(32) + String(f.count).padStart(5) +
      '  ' + f.type.padEnd(9) + ' ' + (f.sample === null ? '—' : f.sample));
  }

  console.log('\n  LINK FIELDS  (which candidates appeared, and their verdict)');
  const seen = d.linkFieldsSeen || {};
  /* Named fields and discovered paths are reported SEPARATELY. Reading
     only the named ones — as this did — announces "no merchant URL at
     all" for exactly the response the walk was added to rescue, which
     is the wrong conclusion in the one case that matters. */
  const found = d.discoveredLinkPaths || {};
  if (!Object.keys(seen).length && !Object.keys(found).length) {
    console.log('    none of: ' + serp.LINK_KEYS.join(', '));
    console.log('    ...and no other string in the result was a usable URL either');
    console.log('    -> this engine does not hand out a merchant URL at all');
  } else {
    for (const [k, n] of Object.entries(seen)) {
      console.log('    ' + k.slice(0, 33).padEnd(34) + String(n).padStart(5) + ' occurrences  (documented name)');
    }
    for (const [k, n] of Object.entries(found)) {
      console.log('    ' + k.slice(0, 33).padEnd(34) + String(n).padStart(5) + ' occurrences  (DISCOVERED)');
    }
  }
  const used = d.acceptedLinkPaths || {};
  if (Object.keys(used).length) {
    console.log('    the URL actually used came from: ' +
      Object.entries(used).map(([k, n]) => `${k} (${n})`).join(', '));
  }
  console.log('    verdicts: ' + Object.entries(d.linkVerdicts || {}).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join('  '));

  console.log('\n  FYND GATE REQUIREMENTS  (all five are mandatory)');
  const cov = d.fieldCoverage || {};
  const map = { title: cov.title, price: cov.price, imageUrl: cov.image, retailer: cov.retailer, productUrl: d.withInlineLink };
  for (const field of REQUIRED) {
    const n = map[field] || 0;
    const rate = results.length ? Math.round((n / results.length) * 100) : 0;
    console.log('    ' + field.padEnd(14) + String(n).padStart(4) + '/' + String(results.length).padEnd(5) +
      String(rate + '%').padStart(6) + '   ' + (rate === 100 ? 'ok' : rate === 0 ? '<-- BLOCKING: never present' : 'partial'));
  }
  if (cov.immersiveTokenOnly) {
    console.log(`\n    ${cov.immersiveTokenOnly} results carried immersive_product_page_token and no merchant URL`);
    console.log('    -> a retailer link would cost a SECOND SerpApi search credit each');
  }

  console.log(`\n  verified by Fynd's gate: ${records.length} of ${results.length}`);

  if (OUT) {
    const sample = {
      captured_at: new Date().toISOString(),
      engine: engineName,
      note: 'api_key values redacted; product data verbatim',
      top_level_keys: Object.keys(raw || {}),
      result_count: results.length,
      first_three_results: redact(results.slice(0, 3), 0),
      diagnostics: d
    };
    const path = ENGINES.length > 1 ? OUT.replace(/(\.json)?$/, `.${engineName}.json`) : OUT;
    fs.writeFileSync(path, JSON.stringify(sample, null, 2));
    /* prove the file is clean before telling anyone it is safe to share */
    const written = fs.readFileSync(path, 'utf8');
    const key = process.env.SERPAPI_API_KEY || '';
    if (key && written.includes(key)) {
      fs.unlinkSync(path);
      console.log(`\n  ABORTED WRITE: the credential appeared in ${path}; file deleted.`);
    } else {
      console.log(`\n  redacted sample written to ${path} (verified free of the key)`);
    }
  }

  return { engineName, results: results.length, verified: records.length, elapsed, diagnostics: d };
}

(async () => {
  if (!process.env.SERPAPI_API_KEY) {
    console.error('SERPAPI_API_KEY is not set. Export it in your shell; do not pass it as an argument.');
    process.exit(1);
  }

  const runs = [];
  for (const e of ENGINES) runs.push(await run(e));

  if (runs.length > 1) {
    console.log('\n' + '='.repeat(92));
    console.log('ENGINE COMPARISON');
    console.log('='.repeat(92));
    console.log('  ' + 'engine'.padEnd(26) + 'results'.padStart(9) + 'verified'.padStart(10) +
      'link rate'.padStart(11) + 'latency'.padStart(10));
    for (const r of runs) {
      if (r.failure) { console.log('  ' + r.engineName.padEnd(26) + 'FAILED: ' + r.failure); continue; }
      console.log('  ' + r.engineName.padEnd(26) + String(r.results).padStart(9) +
        String(r.verified).padStart(10) +
        String(Math.round((r.diagnostics.inlineLinkRate || 0) * 100) + '%').padStart(11) +
        String(r.elapsed + 'ms').padStart(10));
    }
    console.log('\n  The engine with a non-zero link rate is the one Fynd can use with');
    console.log('  a single request. A zero on both means SerpApi needs a second call');
    console.log('  per product, exactly like OpenWeb Ninja, at ~6x the price per call.');
  }
  console.log('');
})();
