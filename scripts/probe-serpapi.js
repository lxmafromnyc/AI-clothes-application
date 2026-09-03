#!/usr/bin/env node
/* =========================================================
   Fynd — SerpApi response probe

   Answers one question against a live response: WHICH field on a
   `shopping_results` entry carries the retailer's own product URL, if
   any does. Everything else the adapter maps is easy to read off a
   response; that field is the one the whole provider stands or falls on,
   because a record without it is dropped by the verification gate.

   Usage
     SERPAPI_API_KEY=... node scripts/probe-serpapi.js "black oversized hoodie"

   Options
     --engine=google_shopping   probe a different engine
     --num=10                   how many results to ask for
     --sellers                  also spend ONE request on the
                                google_product sellers endpoint for the
                                first result that has no inline link
     --json                     print the raw first result as JSON too

   It prints, for one live search:
     1. the plan and the searches left on it (the account endpoint is
        free; it spends no search quota)
     2. the response envelope's keys, and search_metadata's status
     3. every key on the first result, with every URL-valued one
        classified: retailer page, Google's own, SerpApi's own,
        redirector, or listing page
     4. how many of the whole batch carry a usable retailer link inline
     5. the record the adapter maps out of the first result
     6. the verdict the verification gate reaches for the whole batch
     7. with --sellers, the same treatment for one seller object

   Nothing is written anywhere, and the key is redacted out of every
   line this prints.
   ========================================================= */

'use strict';

const provider = require('../api/_providers/serpapi');
const { verifyAll, linkFault } = require('../api/_providers/product-source');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const words = argv.filter((a) => !a.startsWith('--'));

const keysOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);

/* Long values are cut so the output stays readable, but URLs are shown
   in full: whether a link is a retailer page or a Google page is the
   whole question this probe exists to answer. */
function preview(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.length}] ` + (value.length ? preview(value[0]) : '');
  if (typeof value === 'object') return `{${Object.keys(value).join(', ')}}`;
  const s = provider.redact(String(value));
  if (/^https?:\/\//i.test(s)) return s;
  return s.length > 70 ? s.slice(0, 70) + '…' : s;
}

/* Says what a URL is, in the terms the gate uses. This is the column to
   read: exactly one classification means the field can be shown. */
function classify(value) {
  const raw = String(value || '');
  if (!/^https?:\/\//i.test(raw)) return null;
  let host;
  try { host = new URL(raw).hostname; } catch (err) { return 'UNPARSEABLE'; }

  if (/(^|\.)serpapi\.com$/i.test(host)) return "SERPAPI'S OWN — an API endpoint, not a shop";
  if (!provider.looksDirect(raw)) return "GOOGLE'S OWN — a comparison page, refused";

  const fault = linkFault(raw);
  if (fault) return `REFUSED BY THE GATE — ${fault}`;
  return '*** RETAILER PRODUCT PAGE — usable ***';
}

function dump(label, obj) {
  console.log(`\n--- ${label} ---`);
  if (!obj || typeof obj !== 'object') return console.log('  (not an object):', preview(obj));
  for (const key of Object.keys(obj)) {
    const verdict = classify(obj[key]);
    console.log(`  ${key.padEnd(28)} ${preview(obj[key])}`);
    if (verdict) console.log(`  ${''.padEnd(28)} ^ ${verdict}`);
  }
}

/* Which of the adapter's candidate fields this record actually answers
   to. The adapter reads them in this order and takes the first that
   survives; printing the whole list shows what else was available. */
function candidateReport(record) {
  console.log('\n--- the adapter\'s candidate URL fields, against this record ---');
  let any = false;
  for (const key of provider.DIRECT_URL_KEYS) {
    const value = record[key];
    if (value === undefined) { console.log(`  ${key.padEnd(16)} (absent)`); continue; }
    const direct = provider.looksDirect(value);
    any = any || Boolean(direct);
    console.log(`  ${key.padEnd(16)} ${direct ? 'DIRECT  ' : 'refused '} ${provider.redact(String(value)).slice(0, 90)}`);
  }
  console.log(any
    ? '\n  At least one field yields a retailer URL: no seller lookup is needed for this record.'
    : '\n  No field yields a retailer URL: this record needs the google_product sellers lookup.');
}

async function main() {
  if (!process.env.SERPAPI_API_KEY) {
    console.error('SERPAPI_API_KEY is not set. Export it and run again.');
    process.exit(2);
  }

  const query = words.join(' ') || 'black oversized hoodie';
  const intent = { categories: [], colors: [], fits: [], styles: [], brands: [], occasions: [], keywords: query.split(/\s+/) };
  const engine = flag('engine', provider.engine());
  const num = flag('num', '10');

  /* free: the account endpoint is not a search */
  try {
    const account = await provider.account();
    console.log(`plan     : ${account.plan_name || account.plan_id || 'unknown'}`);
    console.log(`searches : ${account.this_month_usage} used this month, ${account.total_searches_left} left`);
  } catch (err) {
    console.log(`plan     : could not be read (${provider.redact(err && err.message)})`);
  }

  console.log(`query    : ${provider.queryFrom(intent)}`);
  console.log(`engine   : ${engine}`);
  console.log(`endpoint : ${provider.SEARCH_URL}`);

  const tally = provider.newTally();
  let payload;
  try {
    payload = await provider.apiGet({
      engine,
      q: provider.queryFrom(intent),
      gl: process.env.SERPAPI_COUNTRY || 'us',
      hl: process.env.SERPAPI_LANGUAGE || 'en',
      num: String(num)
    }, tally, 'search');
  } catch (err) {
    console.error(`\nrequest failed: ${provider.redact(err && err.message)}`);
    process.exit(1);
  }

  console.log(`status   : 200`);
  console.log(`\nenvelope keys: ${keysOf(payload).join(', ')}`);
  if (payload.search_metadata) {
    const m = payload.search_metadata;
    console.log(`search_metadata: status=${m.status} total_time_taken=${m.total_time_taken}s`);
  }
  if (payload.search_information) {
    console.log(`search_information keys: ${keysOf(payload.search_information).join(', ')}`);
  }

  const results = provider.resultsFrom(payload);
  console.log(`results returned: ${results.length}`);
  if (!results.length) {
    console.log(`\nNo results in the payload. Its shape was: ${provider.shapeOf(payload)}`);
    console.log('If the list lives under a key the adapter does not read, resultsFrom() needs it.');
    return;
  }

  const first = results[0];
  dump('shopping_results[0]', first);
  if (has('json')) console.log('\n--- shopping_results[0] raw ---\n' + provider.redact(JSON.stringify(first, null, 2)));

  candidateReport(first);

  /* the batch-wide version of the same question */
  const inline = results.filter((r) => provider.inlineCommerce(r));
  console.log(`\n--- how many of the ${results.length} results carry a retailer link inline? ---`);
  console.log(`  ${inline.length} of ${results.length}`);
  inline.slice(0, 5).forEach((r) => {
    const c = provider.inlineCommerce(r);
    console.log(`    ${(c.retailer || '(no retailer named)').padEnd(22)} ${c.productUrl.slice(0, 100)}`);
  });

  console.log('\n--- adapter mapping of shopping_results[0] ---');
  console.log(provider.redact(JSON.stringify(provider.toRecord(first), null, 2)));

  const records = results.map(provider.toRecord).filter(Boolean);

  if (has('sellers')) {
    const sample = records.find((r) => !r.productUrl && r.sku);
    if (!sample) {
      console.log('\n--- sellers lookup ---\n  Not needed: every record already has a retailer link.');
    } else {
      console.log(`\n--- sellers lookup for product_id=${sample.sku} (one request) ---`);
      const region = { country: process.env.SERPAPI_COUNTRY || 'us', language: process.env.SERPAPI_LANGUAGE || 'en' };
      const result = await provider.sellersFor(sample.sku, region, tally);
      console.log(`  sellers returned: ${result.sellers.length}${result.failed ? ' (the lookup failed)' : ''}`);
      if (result.shape) console.log(`  payload shape: ${result.shape}`);
      if (result.sellers.length) {
        dump('online_sellers[0]', result.sellers[0]);
        const commerce = provider.pickSeller(result.sellers, sample.retailerHint);
        console.log('\n  pickSeller ->', commerce ? `${commerce.retailer} @ ${commerce.price} -> ${commerce.productUrl}` : 'no seller carried a usable retailer link');
      }
    }
  } else {
    const needing = records.filter((r) => !r.productUrl).length;
    console.log(`\n--- ${needing} of ${records.length} records would need a sellers lookup ---`);
    console.log('  Run again with --sellers to spend one request on seeing what that returns.');
  }

  const { products, rejected } = verifyAll(records, { retailer: provider.defaultRetailer });

  console.log('\n--- verification gate, whole batch (inline links only) ---');
  console.log(`  passed  : ${products.length} / ${records.length}`);
  console.log(`  rejected: ${Object.keys(rejected).length ? JSON.stringify(rejected) : 'none'}`);

  if (products.length) {
    console.log('\n--- first verified product as the browser would receive it ---');
    console.log(provider.redact(JSON.stringify(products[0], null, 2)));
  } else {
    console.log('\nNothing passed the gate on inline links alone. The reasons above name');
    console.log('the missing or unusable field for each record — compare them with the');
    console.log('candidate table to see which field the adapter should be reading.');
  }

  console.log(`\nSerpApi requests spent by this probe: ${tally.total} (search ${tally.search}, sellers ${tally.sellers})`);
}

main().catch((err) => { console.error(provider.redact(err && err.message)); process.exit(1); });
