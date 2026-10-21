#!/usr/bin/env node
/* =========================================================
   Fynd — a sizing record from a product page's own text
   (api/_sizing/page-record.js, scripts/record-from-report.js)

     node scripts/test-page-record.js

   The pages here are rebuilt from Fynd's own records: each record keeps
   the exact text of every cell it was copied from, the table's column
   labels, and the page's address and title, so the test report the Fit
   panel would produce on that page can be put back together from it —
   real published values, not invented ones. That shows the conversion
   reproduces what a person copied by hand. It does not show that the
   live page still shows those tables: that needs the page itself.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { recordFromReport } = require('../api/_sizing/page-record');
const schema = require('../api/_sizing/schema');
const builder = require('./build-fit-references');
const F = require('../assets/fit-anchor');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n        ')}`); }
}

const DIR = path.join(__dirname, '..', 'api', '_sizing', 'records');
const records = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
const byId = (id) => records.find((r) => r.id === id);

/* the test report the panel would produce on a record's page, its size
   guide open: each chart's columns and cells as the record kept them */
function reportFor(rec, extra) {
  const chart = (c, measures, label) => {
    const dims = Object.keys(c.dimensions);
    return { key: `page-${measures}`, label, title: label, source: 'retailer-page', where: 'in the open size guide', measures, unit: rec.units, methods: null,
      columns: dims.map((d) => c.dimensions[d].label),
      rows: rec.sizes.filter((z) => c.sizes[z]).map((z) => ({ size: z, values: dims.map((d) => (c.sizes[z][d] ? c.sizes[z][d].text : '')) })) };
  };
  return Object.assign({
    fynd: { version: '0.3.0', at: `${rec.retrievedAt}T12:00:00.000Z` },
    page: { address: `${rec.product.url}?colorDisplayCode=09`, canonical: null, title: rec.product.pageTitle || null },
    identified: { name: rec.product.name, brand: rec.brand, code: rec.product.code, sizesListed: rec.sizes, fit: rec.fit.brandWords },
    charts: [rec.charts.body && chart(rec.charts.body, 'body', 'Body Size'), rec.charts.garment && chart(rec.charts.garment, 'finished-garment', 'Product Size')].filter(Boolean)
  }, extra || {});
}
/* what a person supplies after checking the page: only what the page
   reading can't give, taken from the record itself */
const complete = (draft, rec) => Object.assign({}, draft, { material: rec.material, line: rec.line, sizeScale: rec.sizeScale });

const uniqloWithGarment = records.filter((r) => r.brand === 'UNIQLO' && r.charts.garment);

console.log('\nreal UNIQLO pages, rebuilt from the records copied from them');

test('every UNIQLO record with a Product Size chart: name, address, code, sizes, units and every garment value and method come back exactly; a body chart stays a body chart', () => {
  assert.ok(uniqloWithGarment.length >= 4, uniqloWithGarment.map((r) => r.id).join(', '));
  uniqloWithGarment.forEach((rec) => {
    const out = recordFromReport(reportFor(rec));
    const d = out.record;
    assert.ok(d, rec.id);
    assert.deepStrictEqual([d.brand, d.product.name, d.product.url, d.product.code, d.category, d.units, d.sizes.join(',')],
      [rec.brand, rec.product.name, rec.product.url, rec.product.code, rec.category, rec.units, rec.sizes.join(',')], rec.id);
    Object.entries(rec.charts.garment.sizes).forEach(([size, row]) => Object.entries(row).forEach(([dim, cell]) => {
      assert.deepStrictEqual(d.charts.garment.sizes[size][dim], { value: cell.value, text: cell.text }, `${rec.id} ${size} ${dim}`);
    }));
    Object.entries(rec.charts.garment.dimensions).forEach(([dim, spec]) => assert.strictEqual(d.charts.garment.dimensions[dim].method, spec.method, `${rec.id} ${dim} method`));
    if (rec.charts.body) {
      Object.entries(rec.charts.body.sizes).forEach(([size, row]) => assert.deepStrictEqual(d.charts.body.sizes[size].chest, row.chest, `${rec.id} body ${size}`));
      assert.strictEqual(d.charts.body.measures, 'body');
      assert.strictEqual(d.charts.body.dimensions.chest.method, 'body-circumference');
    }
    assert.deepStrictEqual([d.verification.status, d.capture.how, d.review.status], ['unverified', 'browser-extension', 'pending']);
    assert.ok(d.sources.every((s) => s.retrievedAt === rec.retrievedAt));
    assert.strictEqual(d.product.url.includes('?'), false, 'the address without its query');
  });
});

test('incomplete until a person supplies what the page reading can\'t (fabric and stretch); then it validates as an unverified record', () => {
  const rec = byId('uniqlo-e475377-sweatshirt-us');
  const out = recordFromReport(reportFor(rec));
  assert.strictEqual(out.status, 'incomplete');
  assert.deepStrictEqual(out.missing.map((m) => m.field), ['material']);
  assert.deepStrictEqual(out.errors.map((e) => e.field), ['material.stretch']);
  const done = complete(out.record, rec);
  assert.deepStrictEqual(schema.validate(done), []);
  assert.strictEqual(schema.isVerified(done), false);
});

test('Fynd\'s comparison reads it exactly as it reads the hand-copied record: the same inches, sizes and methods', () => {
  uniqloWithGarment.forEach((rec) => {
    const done = complete(recordFromReport(reportFor(rec)).record, rec);
    const fromPage = builder.garmentOf(done);
    const fromHand = builder.garmentOf(rec);
    assert.deepStrictEqual(fromPage.sizes, fromHand.sizes, rec.id);
    const chart = F.chartFromReference({ brand: rec.brand, name: rec.product.name, garment: fromPage });
    const read = F.readChart(chart, rec.category === 'tshirts' ? 'tshirt' : 'sweatshirt');
    assert.strictEqual(read.sizes.length, Object.keys(fromHand.sizes).length);
    assert.deepStrictEqual(read.issues.filter((i) => i.severity === 'blocking'), []);
  });
});

console.log('\nbody charts, missing charts and what isn\'t said');

test('a body-only page (Nike, H&M, Carhartt): the body chest ranges, and no garment measurement at all — none is worked out from the body', () => {
  records.filter((r) => !r.charts.garment && r.charts.body).forEach((rec) => {
    const out = recordFromReport(reportFor(rec));
    assert.ok(out.record, rec.id);
    assert.deepStrictEqual(Object.keys(out.record.charts), ['body'], rec.id);
    Object.entries(rec.charts.body.sizes).forEach(([size, row]) => assert.deepStrictEqual(out.record.charts.body.sizes[size].chest, row.chest, `${rec.id} ${size}`));
    assert.ok(out.notRecorded.some((n) => /No garment measurements.*None is worked out from a body chart/.test(n)), rec.id);
  });
});

test('Zara: its tables name "Chest", "Front length", "Back width" without the measuring method (Zara says it in prose the reader doesn\'t keep) — values kept in centimetres, each method listed as missing, nothing assumed', () => {
  const rec = byId('zara-00761810-basic-heavyweight-hoodie-us');
  const out = recordFromReport(reportFor(rec));
  assert.strictEqual(out.record.units, 'cm');
  assert.deepStrictEqual(out.record.charts.garment.sizes.M.chestWidth, { value: rec.charts.garment.sizes.M.chestWidth.value, text: rec.charts.garment.sizes.M.chestWidth.text });
  const methods = out.missing.filter((m) => /\.method$/.test(m.field)).map((m) => m.field).sort();
  assert.ok(methods.includes('charts.garment.dimensions.chestWidth.method'), methods.join(', '));
  assert.ok(Object.values(out.record.charts.garment.dimensions).some((d) => d.method === null));
  assert.strictEqual(out.status, 'incomplete');
});

test('a chart that doesn\'t say whether it measures the garment or the body isn\'t recorded; nor is one without a stated unit', () => {
  const rec = byId('uniqlo-e475377-sweatshirt-us');
  const r = reportFor(rec);
  r.charts.forEach((c) => { c.measures = 'not-stated'; });
  const out = recordFromReport(r);
  assert.deepStrictEqual(out.record.charts, {});
  assert.ok(out.notRecorded.some((n) => /doesn't say whether it measures the garment or the body/.test(n)));
  assert.strictEqual(out.status, 'incomplete');
  const noUnit = reportFor(rec);
  noUnit.charts.forEach((c) => { c.unit = null; });
  const out2 = recordFromReport(noUnit);
  assert.deepStrictEqual(out2.record.charts, {});
  assert.ok(out2.missing.some((m) => m.field === 'charts.garment.units'));
});

test('refused, with the reason: no chart read from the page, only Fynd\'s own data, a site that isn\'t a brand\'s own, no date', () => {
  const rec = byId('uniqlo-e475377-sweatshirt-us');
  assert.strictEqual(recordFromReport(reportFor(rec, { charts: [] })).status, 'refused');
  const own = reportFor(rec);
  own.charts.forEach((c) => { c.source = 'fynd-record'; });
  assert.match(recordFromReport(own).missing[0].why, /no size chart read from the page/);
  const shop = reportFor(rec, { page: { address: 'https://shop.example/tee' } });
  assert.match(recordFromReport(shop).missing[0].why, /isn't a site Fynd's record schema knows/);
  assert.strictEqual(recordFromReport(reportFor(rec, { fynd: {} })).status, 'refused');
});

test('a size a chart leaves blank stays unknown; a range where a garment value belongs is not recorded; a column without a method keeps its values and says so', () => {
  const rec = byId('uniqlo-e475377-sweatshirt-us');
  const r = reportFor(rec);
  const g = r.charts.find((c) => c.measures === 'finished-garment');
  g.rows.find((row) => row.size === '3XL').values[0] = '–';
  g.rows.find((row) => row.size === 'XXS').values[2] = '19 - 21';
  g.columns[1] = 'Shoulder';
  const out = recordFromReport(r);
  assert.strictEqual(out.record.charts.garment.sizes['3XL'].bodyLength, undefined);
  assert.strictEqual(out.record.charts.garment.sizes.XXS.chestWidth, undefined);
  assert.ok(out.notRecorded.some((n) => /a range \("19 - 21"\) where a garment measurement is one value/.test(n)));
  assert.strictEqual(out.record.charts.garment.dimensions.shoulderWidth.method, null);
  assert.ok(out.missing.some((m) => m.field === 'charts.garment.dimensions.shoulderWidth.method'));
  assert.strictEqual(out.record.charts.garment.sizes.M.shoulderWidth.value, 20);
});

test('nothing about images: no image field or image address anywhere in a record built from a page', () => {
  uniqloWithGarment.concat(records.filter((r) => !r.charts.garment)).forEach((rec) => {
    const text = JSON.stringify(recordFromReport(reportFor(rec)).record);
    assert.ok(!/image|img|photo|\.(jpe?g|png|webp|gif|avif)\b/i.test(text), rec.id);
  });
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'collect.js'), 'utf8');
  assert.ok(!/querySelectorAll\(['"][^'"]*\bimg\b|\.src\b|currentSrc|og:image/.test(src), 'the page reader reads no image');
});

test('the command line: prints what was extracted and what is missing; refuses with a reason', () => {
  const { describe } = require('./record-from-report');
  const text = describe(recordFromReport(reportFor(byId('uniqlo-e475377-sweatshirt-us'))));
  assert.match(text, /product_name: Sweatshirt/);
  assert.match(text, /M: bodyLength "26 ¾" = 26\.75 in; shoulderWidth "20" = 20 in; chestWidth "23 ½" = 23\.5 in; sleeveLength "34 ¾" = 34\.75 in/);
  assert.match(text, /body chart — "Body Size" \(the person's body\)/);
  assert.match(text, /material: Fabric and stretch aren't read from the page/);
  assert.match(describe(recordFromReport({})), /refused: The report has no page address/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
