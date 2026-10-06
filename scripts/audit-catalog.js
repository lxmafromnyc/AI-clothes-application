#!/usr/bin/env node
/* =========================================================
   Fynd — is every catalogue row what its card says it is?

   A card shows four things about a product: who makes it, what it is
   called, what it costs and where it is sold, over its photo. Each one
   has to be true of the listing the card links to. This re-proves all of
   them, row by row, from the row itself — the same way the photo and the
   price are already re-proved, and with the same functions:

     photo    catalogRowIdentity  (scripts/fetch-catalog-images.js)
     price    catalogRowPrice     (scripts/fetch-catalog-prices.js)
     name     identity.name       (below)
     brand    identity.brand      (below)
     link     an http(s) listing, with a product code or handle in it

   `identity` is a bookkeeping note on the row, like imageEvidence: it
   records HOW the name and the brand were tied to the listing, and it is
   never taken on faith. A note that cannot be re-proved fails exactly as
   a made-up name would.

     name: 'listing'          written with the listing by the tools that
                              verified it; requires a sku-level price or
                              photo record that is re-proved against the
                              row's own URL
     name: 'product-record'   the name IS the title in the store's own
                              product record (imageEvidence.title)
     name: 'url-slug'         the name IS the product's own URL slug, word
                              for word, and that slug is in the row's URL

     brand: 'listing'         as name: 'listing'
     brand: 'image-asset'     the store's own photo of this product is
                              filed under the brand's name
     brand: 'url-slug'        the product's own URL slug opens with it

   A brand with no note is not shown on Discover, and the fix for an
   unknown brand is `brand: null` — never the store's name, and never a
   guess. A row whose name cannot be re-proved is not shelved.

   Usage:  node scripts/audit-catalog.js          a table, every row
           node scripts/audit-catalog.js --json   the same, as JSON
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const images = require('./fetch-catalog-images');
const prices = require('./fetch-catalog-prices');

const CATALOGUE = path.join(__dirname, '..', 'assets', 'catalog.js');

/* the catalogue's rows exactly as the browser sees them */
function readCatalogue(source) {
  const text = source === undefined ? fs.readFileSync(CATALOGUE, 'utf8') : source;
  const sandbox = {};
  vm.runInNewContext(`${text}\n;this.rows = DEMO_PRODUCTS;`, sandbox);
  return sandbox.rows;
}

/* letters and digits only, so "Men's T-Shirt" and "mens-t-shirt" compare
   as the same words and nothing else does */
const bare = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

const hasBrand = (row) => typeof row.brand === 'string' && row.brand.trim() !== '';

function pathSegments(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
  } catch (err) {
    return [];
  }
}

/* the listing link: an http(s) page that names a product, by a code or
   by a handle, so it is a product page and not a store front */
function auditLink(row) {
  if (!row.productUrl) return { ok: false, why: 'links to no listing' };
  let url;
  try { url = new URL(row.productUrl); } catch (err) { return { ok: false, why: `${row.productUrl} is not a URL` }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, why: `${url.protocol} is not a web link` };
  const codes = images.identifiersFrom(row.productUrl);
  const handle = images.shopifyHandle(row.productUrl);
  if (!codes.length && !handle) return { ok: false, why: 'the link names no product' };
  return { ok: true, how: handle ? `listing ${handle.handle}` : `listing ${codes[0]}` };
}

/* 'listing' is only as good as the record that tied the listing to the
   row: a price or a photo recorded against a sku or product code that is
   in the row's own URL */
function listingRecord(row) {
  const price = row.priceEvidence ? prices.catalogRowPrice(row) : null;
  if (price && price.ok && price.via) return { ok: true, how: `its listing's ${price.via} record` };
  const ev = row.imageEvidence;
  if (ev && (ev.via === 'json-ld-sku' || ev.via === 'product-record')) {
    const photo = images.catalogRowIdentity(row);
    if (photo.ok) return { ok: true, how: `its listing's ${ev.via} record` };
  }
  return { ok: false, why: 'no sku-level record ties this listing to the row' };
}

function auditName(row) {
  const identity = row.identity || {};
  const via = identity.name;
  if (!row.name || !String(row.name).trim()) return { ok: false, why: 'names nothing' };
  if (!via) return { ok: false, why: `"${row.name}" is not tied to the listing` };

  if (via === 'listing') return listingRecord(row);

  if (via === 'product-record') {
    const ev = row.imageEvidence;
    if (!ev || ev.via !== 'product-record' || !ev.title) return { ok: false, why: 'cites a product record the row does not carry' };
    if (bare(ev.title) !== bare(row.name)) return { ok: false, why: `"${row.name}" is not the record's title "${ev.title}"` };
    return { ok: true, how: `the store's product record titles it "${ev.title}"` };
  }

  if (via === 'url-slug') {
    const slug = String(identity.slug || '').toLowerCase();
    if (!slug) return { ok: false, why: 'cites a URL slug it does not record' };
    const listed = pathSegments(row.productUrl).concat(
      row.imageEvidence && row.imageEvidence.canonical ? pathSegments(row.imageEvidence.canonical) : []);
    if (!listed.includes(slug)) return { ok: false, why: `the slug ${slug} is not in this row's own listing URL` };
    if (bare(slug) !== bare(row.name)) return { ok: false, why: `"${row.name}" is not the slug ${slug}, word for word` };
    return { ok: true, how: `its listing's URL names it ${slug}` };
  }

  return { ok: false, why: `names no recognised kind of evidence (${via})` };
}

function auditBrand(row) {
  if (!hasBrand(row)) {
    if (row.brand !== null && row.brand !== undefined && row.brand !== '') return { ok: false, why: `${JSON.stringify(row.brand)} is not a brand` };
    return { ok: true, shown: false, how: 'no brand is claimed' };
  }
  const via = (row.identity || {}).brand;
  if (!via) return { ok: false, why: `"${row.brand}" is not tied to the listing` };
  const want = bare(row.brand);

  if (via === 'listing') {
    const record = listingRecord(row);
    return record.ok ? { ok: true, shown: true, how: record.how } : record;
  }

  if (via === 'image-asset') {
    const file = bare(pathSegments(row.imageUrl).pop());
    if (!want || !file.includes(want)) return { ok: false, why: `the photo's own file does not name ${row.brand}` };
    const photo = images.catalogRowIdentity(row);
    if (!photo.ok) return { ok: false, why: `the photo naming it is not tied to the listing: ${photo.why}` };
    return { ok: true, shown: true, how: `the store files this product's photo under ${row.brand}` };
  }

  if (via === 'url-slug') {
    const slug = String((row.identity || {}).slug || '').toLowerCase();
    const first = slug.split('-')[0];
    if (!slug || !pathSegments(row.productUrl).includes(slug)) return { ok: false, why: 'cites a URL slug that is not in the listing URL' };
    if (bare(first) !== want) return { ok: false, why: `the slug ${slug} does not open with ${row.brand}` };
    return { ok: true, shown: true, how: `its listing's URL names it ${slug}` };
  }

  return { ok: false, why: `names no recognised kind of evidence (${via})` };
}

function auditPhoto(row) {
  if (!row.imageUrl) return { ok: false, why: 'has no photo' };
  const verdict = images.catalogRowIdentity(row);
  return verdict.ok ? { ok: true, how: verdict.how } : { ok: false, why: verdict.why };
}

function auditPrice(row) {
  const verdict = prices.catalogRowPrice(row);
  return verdict.ok ? { ok: true, how: verdict.how } : { ok: false, why: verdict.why };
}

/* Every check, for one row. `shelvable` is the one Discover cares about:
   a row it may put on a shelf has every field on its card proved. */
function auditRow(row) {
  const checks = {
    link: auditLink(row),
    name: auditName(row),
    brand: auditBrand(row),
    photo: auditPhoto(row),
    price: auditPrice(row)
  };
  const problems = Object.entries(checks).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.why}`);
  return { id: row.id, checks, problems, shelvable: problems.length === 0 };
}

/* What the browser decides from the same note, without re-proving it:
   see `identified` in assets/products.js. A row the browser would shelve
   that this audit rejects is a bug in the catalogue, and the tests say so. */
const claimsIdentity = (row) => Boolean(row && row.identity && row.identity.name && (!hasBrand(row) || row.identity.brand));

function auditCatalogue(source) {
  return readCatalogue(source).map(auditRow);
}

if (require.main === module) {
  const results = auditCatalogue();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  } else {
    for (const r of results) {
      console.log(`${r.shelvable ? 'ok  ' : 'SKIP'}  ${r.id}`);
      r.problems.forEach((p) => console.log(`        ${p}`));
    }
    const ok = results.filter((r) => r.shelvable).length;
    console.log(`\n${results.length} rows audited, ${ok} shelvable, ${results.length - ok} kept off Discover`);
  }
}

module.exports = { readCatalogue, auditRow, auditCatalogue, auditName, auditBrand, auditPhoto, auditLink, auditPrice, claimsIdentity, bare };
