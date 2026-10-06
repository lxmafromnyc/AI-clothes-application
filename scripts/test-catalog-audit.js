#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue audit tests

   Holds the catalogue to scripts/audit-catalog.js: whatever a card shows
   — brand, name, price, photo, link — is proved from the row, and a row
   that cannot prove it is never shelved. Offline: nothing here reads a
   retailer.

   Usage: node scripts/test-catalog-audit.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const audit = require('./audit-catalog');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message}`); }
}

const rows = audit.readCatalogue();
const byId = (id) => JSON.parse(JSON.stringify(rows.find((r) => r.id === id)));

/* the browser's own verdict, from assets/products.js itself */
const Products = (() => {
  const sandbox = { location: { href: 'https://fynd.test/' }, URL };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'products.js'), 'utf8'), sandbox);
  return sandbox.Products;
})();

console.log('\nthe shipped catalogue');

test('every row the browser would shelve passes the whole audit', () => {
  for (const row of rows) {
    const browser = Products.normalizeProduct(row);
    const shelvable = Boolean(browser && browser.identified && browser.productUrl && browser.imageUrl);
    const verdict = audit.auditRow(row);
    if (shelvable) assert.ok(verdict.shelvable, `${row.id}: ${verdict.problems.join('; ')}`);
    assert.strictEqual(audit.claimsIdentity(row), Boolean(browser && browser.identified), `${row.id}: the browser and the audit read the note differently`);
  }
});

test('no row claims a brand it cannot prove', () => {
  for (const row of rows) {
    const brand = audit.auditBrand(row);
    assert.ok(brand.ok, `${row.id}: ${brand.why}`);
  }
});

test('none of the invented brands the sample rows were drafted with is left', () => {
  const drafted = ['Northfold', 'Halden', 'Coveworks', 'Atlas Supply', 'Rue Nine', 'Terrace', 'Kinfield', 'Solstice'];
  for (const row of rows) assert.ok(!drafted.includes(row.brand), `${row.id} is still labelled ${row.brand}`);
});

test('every linked row accounts for its price', () => {
  for (const row of rows) {
    const price = audit.auditPrice(row);
    assert.ok(price.ok, `${row.id}: ${price.why}`);
  }
});

test('enough rows are shelvable for Discover to fill its shelves', () => {
  const shelvable = rows.filter((r) => audit.auditRow(r).shelvable);
  assert.ok(shelvable.length >= 16, `${shelvable.length} shelvable rows`);
});

test('a photo that failed in a real browser is not shipped on any row', () => {
  /* found by scripts/validate-discover-photos.js against the live hosts */
  const failedLive = [
    'https://www.eileenfisher.com/dw/image/v2/BGKB_PRD/on/demandware.static/-/Sites-ef-main-catalog/default/dw287f7711/images/S6YFF-S4429M-349.jpg?sw=525&sh=700&sfrm=png&q=90'
  ];
  for (const row of rows) assert.ok(!failedLive.includes(row.imageUrl), `${row.id} still carries a photo that failed to load`);
  const skirt = rows.find((r) => r.id === 'sample-solstice-ribbed-knit-skirt');
  assert.strictEqual(audit.auditRow(skirt).shelvable, false, 'a row with no working photo is not shelvable');
  assert.strictEqual(skirt.imageEvidence, undefined, 'no evidence is kept for a photo that is gone');
});

console.log('\nwhat the audit refuses');

test('a brand with no evidence is refused, and the browser does not shelve it', () => {
  const row = byId('sample-rue-nine-slip-midi-dress');
  row.brand = 'Rue Nine';
  assert.strictEqual(audit.auditBrand(row).ok, false);
  assert.strictEqual(audit.auditRow(row).shelvable, false);
  assert.strictEqual(Products.normalizeProduct(row).identified, false);
});

test('a brand whose cited evidence names someone else is refused', () => {
  const asset = byId('sample-halden-merino-crew-knit');
  asset.brand = 'Halden';
  assert.match(audit.auditBrand(asset).why, /does not name Halden/);

  const slug = byId('sample-terrace-straight-leg-jean');
  slug.brand = 'Terrace';
  assert.match(audit.auditBrand(slug).why, /does not open with Terrace/);
});

test('the store a listing is on is not accepted as its brand', () => {
  const row = byId('sample-terrace-washed-denim-jacket');
  row.brand = 'Stetson';
  row.identity = Object.assign({}, row.identity, { brand: 'image-asset' });
  assert.strictEqual(audit.auditBrand(row).ok, false, 'the photo file does not name the maker');
});

test('a name that is not the record’s title, or not the slug, is refused', () => {
  const record = byId('sample-halden-tailored-wool-coat');
  record.name = 'Tailored Wool Coat';
  assert.match(audit.auditName(record).why, /is not the record's title/);

  const slug = byId('sample-solstice-printed-maxi-dress');
  slug.name = 'Printed Maxi Dress';
  assert.match(audit.auditName(slug).why, /is not the slug/);

  const elsewhere = byId('sample-solstice-printed-maxi-dress');
  elsewhere.identity = { name: 'url-slug', slug: 'printed-maxi-dress' };
  elsewhere.name = 'Printed Maxi Dress';
  assert.match(audit.auditName(elsewhere).why, /not in this row's own listing URL/);
});

test('a "listing" note with no sku-level record behind it is refused', () => {
  const row = byId('sample-kinfield-poplin-shirt');
  row.identity = { name: 'listing' };
  /* the photo's json-ld sku vouches for the listing, so give it nothing */
  delete row.imageEvidence;
  assert.strictEqual(audit.auditName(row).ok, false);
});

test('a row with no photo, or a photo not tied to its listing, is not shelvable', () => {
  const none = byId('sample-northfold-boxy-cotton-tee');
  none.imageUrl = null;
  assert.strictEqual(audit.auditRow(none).shelvable, false);

  const foreign = byId('sample-northfold-boxy-cotton-tee');
  foreign.imageEvidence = Object.assign({}, foreign.imageEvidence, { handle: 'some-other-product' });
  assert.strictEqual(audit.auditPhoto(foreign).ok, false);
});

test('a row with no listing, or a link that names no product, is not shelvable', () => {
  const none = byId('sample-terrace-linen-camp-shirt');
  none.productUrl = null;
  assert.strictEqual(audit.auditLink(none).ok, false);

  const front = byId('sample-terrace-linen-camp-shirt');
  front.productUrl = 'https://mackweldon.com/';
  assert.strictEqual(audit.auditLink(front).ok, false);

  const script = byId('sample-terrace-linen-camp-shirt');
  script.productUrl = 'javascript:alert(1)';
  assert.strictEqual(audit.auditLink(script).ok, false);
});

test('a demo price on a linked row, with no record of where it was read, is refused', () => {
  const row = byId('sample-halden-tailored-wool-coat');
  row.price = 298;
  assert.strictEqual(audit.auditPrice(row).ok, false);
  assert.strictEqual(audit.auditRow(row).shelvable, false);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
