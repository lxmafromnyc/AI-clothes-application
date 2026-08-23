#!/usr/bin/env node
/* =========================================================
   Fynd — OpenWeb Ninja response probe

   Confirms the live response schema against the adapter's mapping. The
   adapter's request parameters were taken from the vendor's published
   OpenAPI manifest; the per-field response names come from published
   documentation and are accepted tolerantly. This script is how you
   check them against a real call.

   Usage
     OPENWEBNINJA_API_KEY=... node scripts/probe-openwebninja.js "black oversized hoodie"

   It prints, for one live search:
     1. the response envelope's top-level keys
     2. every key on the first product, and on that product's offer
     3. the record the adapter maps out of it
     4. the verdict the verification gate reaches, for the whole batch

   Nothing is written anywhere and no key is printed.
   ========================================================= */

'use strict';

const provider = require('../api/providers/openwebninja');
const { verifyAll } = require('../api/providers/product-source');

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

async function main() {
  if (!process.env.OPENWEBNINJA_API_KEY) {
    console.error('OPENWEBNINJA_API_KEY is not set. Export it and run again.');
    process.exit(2);
  }

  const query = process.argv.slice(2).join(' ') || 'black oversized hoodie';
  /* a probe stands in for the interpreter: the words are treated as
     keywords so the adapter builds its query exactly as it would live */
  const intent = { categories: [], colors: [], fits: [], styles: [], brands: [], occasions: [], keywords: query.split(/\s+/) };

  console.log(`query    : ${provider.queryFrom(intent)}`);
  console.log(`endpoint : ${provider.SEARCH_URL}`);

  /* call the endpoint directly so the raw envelope can be inspected,
     rather than only what the adapter kept */
  const params = new URLSearchParams({ q: provider.queryFrom(intent), country: 'us', language: 'en', limit: '10', sort_by: 'BEST_MATCH' });
  const response = await fetch(`${provider.SEARCH_URL}?${params}`, {
    headers: { 'x-api-key': process.env.OPENWEBNINJA_API_KEY, Accept: 'application/json' }
  });

  console.log(`status   : ${response.status} ${response.statusText}`);
  if (!response.ok) {
    console.error(await response.text().catch(() => ''));
    process.exit(1);
  }

  const payload = await response.json();
  console.log(`\nenvelope keys: ${keysOf(payload).join(', ')}`);

  const results = provider.resultsFrom(payload);
  console.log(`products returned: ${results.length}`);
  if (!results.length) {
    console.log('\nNo products in the payload. The envelope above is what came back —');
    console.log('if the list lives under a key the adapter does not read, resultsFrom() needs it.');
    return;
  }

  const first = results[0];
  dump('product[0]', first);

  const offer = provider.offerFrom(first);
  if (offer) dump('product[0] offer', offer);
  else console.log('\n--- product[0] offer ---\n  NONE FOUND. offerFrom() did not recognise an offer on this product.');

  console.log('\n--- adapter mapping of product[0] ---');
  console.log(JSON.stringify(provider.toRecord(first), null, 2));

  /* the search endpoint returns Google's product view, so this shows
     whether a retailer link is obtainable and from where */
  const inline = provider.inlineCommerce(first);
  console.log('\n--- can this record supply a retailer link on its own? ---');
  console.log(inline ? `  yes: ${inline.retailer} -> ${inline.productUrl}`
                     : '  no. product_page_url is Google\'s, so /product-offers is needed.');

  const records = results.map(provider.toRecord).filter(Boolean);
  records.forEach((r, i) => { r.retailerHint = String((results[i] && results[i].store_name) || ''); });

  const needing = records.filter((r) => !r.productUrl).length;
  console.log(`\n--- resolving offers for ${needing} of ${records.length} records ---`);
  const region = { country: 'us', language: 'en' };

  if (needing) {
    const sample = records.find((r) => !r.productUrl && r.sku);
    if (sample) {
      const offers = provider.resultsFrom(await (async () => {
        const params = new URLSearchParams({ product_id: sample.sku, country: 'us', language: 'en' });
        const res = await fetch(`${provider.OFFERS_URL}?${params}`, { headers: { 'x-api-key': process.env.OPENWEBNINJA_API_KEY, Accept: 'application/json' } });
        console.log(`  GET /product-offers?product_id=${sample.sku} -> ${res.status}`);
        return res.ok ? res.json() : {};
      })());
      console.log(`  offers returned: ${offers.length}`);
      if (offers.length) dump('offer[0]', offers[0]);
      else console.log('  NONE. No seller links are obtainable for this product.');
    }
  }

  await provider.resolveMissingOffers(records, records.length, region);
  records.forEach((r) => { delete r.retailerHint; });

  const { products, rejected } = verifyAll(records, { retailer: provider.defaultRetailer });

  console.log('\n--- verification gate, whole batch ---');
  console.log(`  passed  : ${products.length} / ${records.length}`);
  console.log(`  rejected: ${Object.keys(rejected).length ? JSON.stringify(rejected) : 'none'}`);

  if (products.length) {
    console.log('\n--- first verified product as the browser would receive it ---');
    console.log(JSON.stringify(products[0], null, 2));
  } else {
    console.log('\nNothing passed the gate. The reasons above name the missing or');
    console.log('unusable field for each record — compare them with product[0] to see');
    console.log('which alias the adapter is missing.');
  }
}

main().catch((err) => { console.error(err && err.message); process.exit(1); });
