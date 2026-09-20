#!/usr/bin/env node
/* =========================================================
   FindWear — OpenWeb Ninja response probe

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
     5. the PHOTOS: which field each one came from, whether the URL
        answers with an actual image, whether it answers differently
        when a referrer is sent, whether it is signed or expiring, and
        how many of the batch have a photo that can be shown at all

   Nothing is written anywhere. No API key is printed, and no photo URL
   is printed whole: a signed URL carries its signature in the query, so
   only the scheme, the host and the NAMES of the query keys are shown.
   ========================================================= */

'use strict';

const provider = require('../api/_providers/openwebninja');
const { verifyAll } = require('../api/_providers/product-source');

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

async function main() {
  if (!process.env.OPENWEBNINJA_API_KEY) {
    console.error('OPENWEBNINJA_API_KEY is not set. Export it and run again.');
    process.exit(2);
  }

  /* flags are not search words: --site takes a value, and neither it nor
     its value belongs in the query the provider is asked */
  const argv = process.argv.slice(2);
  const words = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] === '--site'));
  const query = words.join(' ') || 'black oversized hoodie';
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

  /* the question the gate cannot answer: not whether a URL is there,
     but whether it answers with a picture */
  const site = (process.argv.includes('--site') ? process.argv[process.argv.indexOf('--site') + 1] : '')
    || 'https://ai-clothes-application.vercel.app';
  await reportPhotos(results, site);
}

/* Run as a script; required as a module by scripts/test-pipeline.js, so
   the parts that read a response can be tested without a live call. */
if (require.main === module) {
  main().catch((err) => { console.error(err && err.message); process.exit(1); });
}

module.exports = { describeUrl, photoCandidates, SIGNING_KEY };
