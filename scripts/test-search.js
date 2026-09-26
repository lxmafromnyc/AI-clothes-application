#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue search tests

   The real assets/products.js, assets/interpret.js and assets/catalog.js,
   run the way a page runs them, reading requests the way the page reads
   them when no AI interpreter answers and ranking the verified catalogue
   with the function the page ranks it with. scripts/bench-search.js
   drives the same path through a real browser; this is its fast,
   dependency-free floor.

   Usage: node scripts/test-search.js
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const context = { console, URL };
context.window = context;
vm.createContext(context);
for (const file of ['products.js', 'interpret.js', 'catalog.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, 'assets', file), 'utf8'), context, { filename: file });
}
vm.runInContext('this.__rows = DEMO_PRODUCTS;', context);
const { Products, Interpreter } = context;
const catalogue = Products.normalizeAll(context.__rows);
const { QUERIES, BRAND_QUERIES } = require('./bench-search.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); } catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`); }
}

/* what the page does: read the request against the catalogue's own
   vocabulary, rank the catalogue, show eight */
function vocabulary() {
  return {
    categories: [...new Set(catalogue.map((p) => p.category))],
    colors: [...new Set(catalogue.flatMap((p) => p.colors))],
    occasions: [...new Set(catalogue.flatMap((p) => p.occasions))],
    fits: [...new Set(catalogue.flatMap((p) => p.fits))],
    brands: [...new Set(catalogue.map((p) => p.brand))],
    styles: [...new Set(catalogue.flatMap((p) => p.styles))]
  };
}
const VOCAB = vocabulary();
const search = (query) => Products.rank(catalogue, Interpreter.localInterpret(query, VOCAB)).slice(0, 8);
const names = (list) => list.map((one) => one.name);
const idOf = (row) => row.id.replace(/^sample-/, '');
const rankOf = (query, id) => search(query).findIndex((one) => idOf(one) === id) + 1;

console.log('\n  — descriptors decide between garments of one kind\n');

test('"cropped puffer jacket" is the cropped puffer, not the cheaper cropped track jacket', () => {
  const shown = names(search('cropped puffer jacket'));
  assert.strictEqual(shown[0], 'Cropped Puffer', shown.join(' | '));
  assert.ok(shown.indexOf('Cropped Track Jacket') > 0);
});

test('a full match on the request’s own words is not capped level with a bare category match', () => {
  /* two jackets that both match "jacket": the one the words describe wins,
     whatever the price */
  const prefs = Object.assign(Interpreter.EMPTY(), { categories: ['jacket'], keywords: ['double', 'breasted', 'blazer'] });
  const blazer = { name: 'Double Breasted Blazer', brand: 'A', category: 'jacket', price: 500, colors: [], occasions: [], fits: [], styles: [] };
  const cheap = { name: 'Washed Denim Jacket', brand: 'B', category: 'jacket', price: 20, colors: [], occasions: [], fits: [], styles: [] };
  const ranked = Products.rank([cheap, blazer], prefs);
  assert.deepStrictEqual(names(ranked), ['Double Breasted Blazer', 'Washed Denim Jacket']);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('pleated, midi, chinos and double-breasted are all kept', () => {
  assert.strictEqual(search("women's pleated midi skirt")[0].name, 'Pleated Midi Skirt');
  assert.strictEqual(search('stretchy chinos for commuting')[0].name, "Men's VentureStretch Commuter Chinos");
  assert.strictEqual(search('double breasted blazer')[0].name, 'Double Breasted Blazer');
});

console.log('\n  — what the local interpreter reads\n');

test('a t-shirt is a tee, not a tee and a shirt', () => {
  const read = Interpreter.localInterpret('white boxy t-shirt', VOCAB);
  assert.deepStrictEqual([...read.categories], ['tee']);
  assert.deepStrictEqual([...Interpreter.localInterpret('heavyweight pocket tshirt', VOCAB).categories], ['tee']);
  /* and a shirt is still a shirt */
  assert.deepStrictEqual([...Interpreter.localInterpret('white oxford shirt', VOCAB).categories], ['shirt']);
});

test('a top may be a shirt-cut top as well as a tee', () => {
  assert.deepStrictEqual([...Interpreter.localInterpret('tencel wrap top', VOCAB).categories].sort(), ['shirt', 'tee']);
  assert.strictEqual(search('tencel wrap top')[0].name, 'Tencel Wrap Top');
});

console.log('\n  — brands, ties and nothing\n');

test('a brand the shopper names is weighed once, and cannot outrank the garment', () => {
  const shown = names(search('coveworks wide leg trousers'));
  assert.strictEqual(shown[0], 'Wide Leg Trouser', shown.join(' | '));
  assert.ok(shown.indexOf('Cargo Utility Pant') > 0, 'the brand’s other trousers are still shown, below');
});

test('ties keep the lower price first, and the same request always gives the same order', () => {
  const prefs = Object.assign(Interpreter.EMPTY(), { categories: ['trousers'] });
  const first = names(Products.rank(catalogue, prefs));
  assert.deepStrictEqual(names(Products.rank(catalogue, prefs)), first);
  const trousers = Products.rank(catalogue, prefs);
  for (let i = 1; i < trousers.length; i += 1) {
    if (trousers[i].score === trousers[i - 1].score) assert.ok((trousers[i - 1].price ?? Infinity) <= (trousers[i].price ?? Infinity));
  }
});

test('a request the catalogue answers nothing of shows nothing', () => {
  assert.strictEqual(search('swimsuit').length, 0);
});

console.log('\n  — the benchmark, as a floor\n');

test('each of the 27 verified rows is in the top three for its own shopper query, and 26 are first', () => {
  const ranks = QUERIES.map(([id, query]) => [id, query, rankOf(query, id)]);
  const missing = ranks.filter(([, , rank]) => !rank || rank > 3);
  assert.deepStrictEqual(missing, [], 'rows outside the top three');
  const first = ranks.filter(([, , rank]) => rank === 1).length;
  assert.ok(first >= 26, `${first}/27 first: ${ranks.filter(([, , rank]) => rank !== 1).map(([, q, r]) => `${q} → ${r}`).join('; ')}`);
});

test('every brand query puts the named garment first', () => {
  for (const [id, query] of BRAND_QUERIES) assert.strictEqual(rankOf(query, id), 1, query);
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
