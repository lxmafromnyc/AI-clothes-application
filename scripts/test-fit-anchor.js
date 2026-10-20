#!/usr/bin/env node
/* =========================================================
   Fynd — Fit Anchor: tests for the comparison and the calibration

   assets/fit-anchor.js on hand-worked charts. Every chart here is an
   invented FIXTURE, built so the right answer can be worked out by hand;
   none is a retailer's real chart, and passing says nothing about how
   often a recommendation is right in real life (only measured outcomes
   can say that).

   Usage: node scripts/test-fit-anchor.js
   ========================================================= */

'use strict';

const assert = require('assert');
const F = require('../assets/fit-anchor');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message.split('\n').slice(0, 10).join('\n        ') : err}`); }
}
const section = (s) => console.log(`\n${s}`);

/* a tee chart, flat widths in inches: S 19 / M 20½ / L 22 / XL 23½ */
const TEE = {
  measures: 'finished-garment', unit: 'in',
  columns: ['Chest width', 'Body length (back)', 'Sleeve length (center back)'],
  rows: [
    { size: 'S', values: ['19', '27', '8'] },
    { size: 'M', values: ['20 1/2', '28', '8¼'] },
    { size: 'L', values: ['22', '29', '8½'] },
    { size: 'XL', values: ['23.5', '30', '8.75'] }
  ]
};
const anchor = (over) => {
  const r = F.makeAnchor(Object.assign({ brand: 'UNIQLO', category: 'tshirt', size: 'L', feel: { fit: 'right', length: 'right' },
    dims: { chestWidth: { value: 22, source: 'fynd-record', verified: true }, bodyLength: { value: 29, source: 'fynd-record', verified: true, method: 'back' }, sleeveLength: { value: 8.5, source: 'fynd-record', verified: true, method: 'center-back' } } }, over || {}));
  if (r.error) throw new Error(r.error);
  return r.anchor;
};

const round = (v) => Math.round(v * 100) / 100;

section('reading numbers and units');

test('values as charts write them: decimals, decimal commas, fractions, ½, ranges, inline units', () => {
  const v = (s) => F.parseCell(s);
  assert.strictEqual(v('20').value, 20);
  assert.strictEqual(v('20.5').value, 20.5);
  assert.strictEqual(v('20,5').value, 20.5);
  assert.strictEqual(v('20 1/2').value, 20.5);
  assert.strictEqual(v('20½').value, 20.5);
  assert.strictEqual(v('20 ¾"').value, 20.75);
  assert.deepStrictEqual([v('51 cm').value, v('51 cm').unit], [51, 'cm']);
  assert.deepStrictEqual([v('51–53').value, v('51-53').range], [52, [51, 53]]);
  assert.strictEqual(v('—'), null);
  assert.strictEqual(v('n/a'), null);
  assert.strictEqual(v('53-51'), null, 'a range running backwards isn’t a range');
});

test('centimetres become inches; a circumference becomes a flat width; formatting in eighths', () => {
  const cm = F.readChart({ measures: 'finished-garment', unit: 'cm', columns: ['Chest width', 'Length'], rows: [{ size: 'M', values: ['52', '71'] }, { size: 'L', values: ['55', '73'] }] }, 'tshirt');
  assert.strictEqual(round(cm.sizes[0].dims.chestWidth.value), 20.47);
  assert.strictEqual(round(cm.sizes[0].dims.bodyLength.value), 27.95);
  const around = F.readChart({ measures: 'finished-garment', unit: 'in', columns: ['Chest (circumference)', 'Length'], rows: [{ size: 'M', values: ['41', '28'] }, { size: 'L', values: ['44', '29'] }] }, 'tshirt');
  assert.deepStrictEqual([around.sizes[0].dims.chestWidth.value, around.columns.chestWidth.method, around.columns.chestWidth.methodBy], [20.5, 'around', 'stated']);
  assert.deepStrictEqual([F.format(22.5), F.format(20.125), F.format(0.5), F.format(30), F.format(22.5, 'cm')], ['22½ in', '20⅛ in', '½ in', '30 in', '57.2 cm']);
});

test('a chart that names no unit: inferred from what the values could be, and said to be inferred — or refused when they could be either', () => {
  const asCm = F.readChart({ measures: 'finished-garment', unit: null, columns: ['Chest width', 'Length'], rows: [{ size: 'M', values: ['52', '71'] }, { size: 'L', values: ['55', '73'] }] }, 'tshirt');
  assert.deepStrictEqual([asCm.columns.chestWidth.unit, asCm.columns.chestWidth.unitBy], ['cm', 'inferred']);
  const asIn = F.readChart({ measures: 'finished-garment', unit: null, columns: ['Chest width', 'Length'], rows: [{ size: 'M', values: ['20.5', '28'] }, { size: 'L', values: ['22', '29'] }] }, 'tshirt');
  assert.deepStrictEqual([asIn.columns.chestWidth.unit, asIn.columns.bodyLength.unit], ['in', 'in']);
  /* a sleeve of 22–23 could be a long sleeve in inches or a short one in centimetres */
  const either = F.readChart({ measures: 'finished-garment', unit: null, columns: ['Chest width', 'Sleeve length'], rows: [{ size: 'M', values: ['20.5', '22'] }, { size: 'L', values: ['22', '23'] }] }, 'tshirt');
  assert.strictEqual(either.columns.sleeveLength.unit, null);
  assert.ok(either.issues.some((i) => i.kind === 'unknown-unit' && i.severity === 'blocking' && i.dim === 'sleeveLength'));
});

test('a width that doesn’t say flat or around: inferred from its size when only one reading is possible, refused otherwise', () => {
  const flat = F.readChart({ measures: 'finished-garment', unit: 'in', columns: ['Chest', 'Length'], rows: [{ size: 'M', values: ['20.5', '28'] }, { size: 'L', values: ['22', '29'] }] }, 'tshirt');
  assert.deepStrictEqual([flat.columns.chestWidth.method, flat.columns.chestWidth.methodBy], ['flat', 'inferred']);
  const around = F.readChart({ measures: 'finished-garment', unit: 'in', columns: ['Chest', 'Length'], rows: [{ size: 'M', values: ['41', '28'] }, { size: 'L', values: ['44', '29'] }] }, 'tshirt');
  assert.deepStrictEqual([around.columns.chestWidth.method, around.sizes[0].dims.chestWidth.value], ['around', 20.5]);
  const ambiguous = F.readChart({ measures: 'finished-garment', unit: 'in', columns: ['Chest', 'Length'], rows: [{ size: 'XS', values: ['30', '26'] }, { size: 'XXL', values: ['36', '31'] }] }, 'tshirt');
  assert.strictEqual(ambiguous.columns.chestWidth.method, null);
  assert.ok(ambiguous.issues.some((i) => i.kind === 'unknown-method'));
});

section('charts that are wrong or incomplete');

test('a width that shrinks as the size grows is flagged; on the main dimension it blocks that dimension', () => {
  const bad = F.readChart({ measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Length'], rows: [{ size: 'S', values: ['20', '27'] }, { size: 'M', values: ['19', '28'] }, { size: 'L', values: ['22', '29'] }] }, 'tshirt');
  const issue = bad.issues.find((i) => i.kind === 'not-increasing');
  assert.ok(issue && issue.dim === 'chestWidth' && issue.severity === 'blocking', JSON.stringify(bad.issues));
  const r = F.recommend(anchor(), { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Length'], rows: [{ size: 'S', values: ['20', '27'] }, { size: 'M', values: ['19', '28'] }, { size: 'L', values: ['22', '29'] }] });
  assert.ok(!r.compared || !r.compared.includes('chestWidth'));
  assert.ok(r.status !== 'ok' || r.confidence === 'low', 'never confident without the chest');
});

test('a step wildly out of line is flagged and lowers confidence; duplicated sizes and ranges are said', () => {
  const chart = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length', 'Sleeve length'], rows: [{ size: 'S', values: ['19', '27', '8'] }, { size: 'M', values: ['20', '28', '8.25'] }, { size: 'L', values: ['21', '29', '8.5'] }, { size: 'XL', values: ['22', '41', '8.75'] }, { size: 'XL', values: ['22', '30', '8.75'] }] };
  const read = F.readChart(chart, 'tshirt');
  assert.ok(read.issues.some((i) => i.kind === 'step-outlier' && i.dim === 'bodyLength'));
  assert.ok(read.issues.some((i) => i.kind === 'duplicate-size'));
  const clean = F.recommend(anchor({ size: 'L', dims: { chestWidth: { value: 21, source: 'fynd-record', verified: true }, bodyLength: { value: 29, source: 'fynd-record', verified: true }, sleeveLength: { value: 8.5, source: 'fynd-record', verified: true } } }), Object.assign({}, chart, { rows: chart.rows.slice(0, 3) }));
  const flagged = F.recommend(anchor({ size: 'L', dims: { chestWidth: { value: 21, source: 'fynd-record', verified: true }, bodyLength: { value: 29, source: 'fynd-record', verified: true }, sleeveLength: { value: 8.5, source: 'fynd-record', verified: true } } }), chart);
  assert.strictEqual(flagged.size, 'L');
  assert.ok(['high', 'medium', 'low'].indexOf(flagged.confidence) >= ['high', 'medium', 'low'].indexOf(clean.confidence), `${flagged.confidence} vs ${clean.confidence}`);
  assert.ok(flagged.uncertain.some((t) => /jumps unusually/.test(t)));
  const ranged = F.readChart({ measures: 'finished-garment', unit: 'in', columns: ['Chest width'], rows: [{ size: 'M', values: ['20-21'] }, { size: 'L', values: ['22-23'] }] }, 'tshirt');
  assert.ok(ranged.issues.some((i) => i.kind === 'range'));
});

test('missing measurements: a size missing a value is compared on what it has; nothing shared is “insufficient” with what’s missing', () => {
  const partial = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length'], rows: [{ size: 'M', values: ['20.5', ''] }, { size: 'L', values: ['22', '29'] }, { size: 'XL', values: ['23.5', '30'] }] };
  const r = F.recommend(anchor(), partial);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.size, 'L');
  assert.strictEqual(r.ranked.find((x) => x.size === 'M').covered, 1);
  const none = F.recommend(anchor(), { measures: 'finished-garment', unit: 'in', columns: ['Hem width'], rows: [{ size: 'M', values: ['20'] }, { size: 'L', values: ['21'] }] });
  assert.strictEqual(none.status, 'insufficient');
  assert.ok(none.explanation.length >= 1);
  const noDims = F.recommend(F.makeAnchor({ brand: 'UNIQLO', category: 'tshirt', size: 'L' }).anchor, TEE);
  assert.strictEqual(noDims.status, 'insufficient');
  assert.ok(noDims.missing.includes('your reference garment’s measurements'));
  assert.match(noDims.explanation[0], /no measurements for your reference garment/);
});

test('a body chart is never compared with a garment; a chart that doesn’t say needs the shopper to confirm it', () => {
  const body = F.recommend(anchor(), Object.assign({}, TEE, { measures: 'body' }));
  assert.strictEqual(body.status, 'body-chart');
  assert.ok(!('size' in body));
  const unsaid = F.recommend(anchor(), Object.assign({}, TEE, { measures: 'not-stated' }));
  assert.strictEqual(unsaid.status, 'insufficient');
  const confirmed = F.recommend(anchor(), Object.assign({}, TEE, { measures: 'not-stated' }), { allowNotStated: true });
  assert.deepStrictEqual([confirmed.status, confirmed.confidence], ['ok', 'low']);
});

test('only size labels, same brand: a label match at low confidence, said to be a label match; another brand: nothing', () => {
  const labels = F.recommend(anchor(), { measures: 'body', unit: 'in', columns: ['Chest'], rows: [{ size: 'M', values: ['38-40'] }, { size: 'L', values: ['41-43'] }] }, { brand: 'UNIQLO' });
  assert.ok(labels.labelMatch && labels.labelMatch.size === 'L' && labels.labelMatch.confidence === 'low');
  assert.match(labels.labelMatch.text, /label match, not a measurement match/);
  const other = F.recommend(anchor(), null, { brand: 'Gap', sizes: ['S', 'M', 'L'] });
  assert.deepStrictEqual([other.status, other.labelMatch], ['labels-only', null]);
});

section('the comparison');

test('a garment that fits “just right”: the size nearest it wins, and the explanation states verified numbers exactly', () => {
  const r = F.recommend(anchor(), TEE);
  assert.strictEqual(r.size, 'L');
  assert.deepStrictEqual(r.compared, ['chestWidth', 'bodyLength', 'sleeveLength']);
  assert.match(r.explanation[0], /^Your reference T-shirt \(UNIQLO L\) has a flat chest width of 22 in \(verified by Fynd\)\. This L measures 22 in — about what you like\.$/);
  assert.ok(r.explanation.some((l) => /^Its body length matches your reference/.test(l)));
});

test('“feels tight” moves the pick up, “feels loose” down — by a range, not one arbitrary inch', () => {
  const tight = anchor({ size: 'M', feel: { fit: 'tight', length: 'right' }, dims: { chestWidth: { value: 20.5, source: 'fynd-record', verified: true }, bodyLength: { value: 28, source: 'fynd-record', verified: true } } });
  const pref = F.preferred(tight).chestWidth;
  assert.deepStrictEqual([pref.low, pref.high, pref.adjusted], [20.75, 22, true], 'somewhere between ¼ in and 1½ in wider');
  assert.strictEqual(F.recommend(tight, TEE).size, 'L');
  const loose = anchor({ size: 'L', feel: { fit: 'loose', length: 'right' }, dims: { chestWidth: { value: 22, source: 'fynd-record', verified: true }, bodyLength: { value: 28.5, source: 'fynd-record', verified: true } } });
  assert.strictEqual(F.recommend(loose, TEE).size, 'M');
  const confidence = F.recommend(tight, TEE).confidence;
  assert.notStrictEqual(confidence, 'high', 'one answer can’t make a confident preference');
  assert.ok(F.recommend(tight, TEE).confidenceWhy.some((w) => /estimated from one answer/.test(w)));
});

test('a size that repeats the complaint doesn’t win: “feels tight” in M won’t pick a chart’s identical M because its lengths match', () => {
  /* the shape of Fynd's own UNIQLO records: a hoodie M (chest 23½) that
     feels tight, against a sweatshirt whose M has the same chest */
  const chart = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length (back)', 'Sleeve length (center back)', 'Shoulder width (seam to seam)'], rows: [{ size: 'S', values: ['22.25', '25.5', '33.75', '19.25'] }, { size: 'M', values: ['23.5', '26.75', '34.75', '20'] }, { size: 'L', values: ['25', '28', '35.75', '20.75'] }, { size: 'XL', values: ['26.5', '28.75', '36.25', '21.5'] }] };
  const hoodie = anchor({ category: 'sweatshirt', size: 'M', feel: { fit: 'tight', length: 'right' }, dims: { chestWidth: { value: 23.5, source: 'fynd-record', verified: true }, bodyLength: { value: 26.75, source: 'fynd-record', verified: true, method: 'back' }, sleeveLength: { value: 34.75, source: 'fynd-record', verified: true, method: 'center-back' }, shoulderWidth: { value: 20, source: 'fynd-record', verified: true, method: 'seam-to-seam' } } });
  assert.strictEqual(F.recommend(hoodie, chart).size, 'L');
  assert.strictEqual(F.recommend(hoodie, chart, { heuristics: { repeatPenalty: 0 } }).size, 'M', 'without the penalty, matching lengths outvote the complaint');
  /* once a measured outcome speaks, it — not the penalty — decides */
  const fine = Object.assign({}, hoodie, { feedback: [F.outcome(hoodie, 'about-right', { size: 'M', dims: { chestWidth: { value: 23.5 } } })] });
  assert.strictEqual(F.recommend(fine, chart).size, 'M');
});

test('length matters on its own axis: “feels short” prefers a longer size when the chest allows, and the shopper’s priority weighs it', () => {
  const chart = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length'], rows: [{ size: 'M', values: ['21', '27'] }, { size: 'M Tall', values: ['21', '29'] }, { size: 'L', values: ['22.5', '28'] }] };
  const short = anchor({ size: 'M', feel: { fit: 'right', length: 'short' }, dims: { chestWidth: { value: 21, source: 'fynd-record', verified: true }, bodyLength: { value: 27, source: 'fynd-record', verified: true } } });
  assert.strictEqual(F.recommend(short, chart).size, 'M Tall');
  const chestFirst = anchor({ size: 'M', feel: { fit: 'right', length: 'short' }, priority: { fit: 2, length: 0.25 }, dims: { chestWidth: { value: 21, source: 'fynd-record', verified: true }, bodyLength: { value: 27, source: 'fynd-record', verified: true } } });
  const r = F.recommend(chestFirst, chart);
  assert.ok(['M', 'M Tall'].includes(r.size), r.size);
});

test('the closest single measurement doesn’t win alone: chest and length are weighed together', () => {
  /* M matches the chest exactly but is 3 in short; L is ½ in wide and the right length */
  const chart = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length', 'Sleeve length'], rows: [{ size: 'M', values: ['21', '25', '8.5'] }, { size: 'L', values: ['21.5', '28', '8.5'] }] };
  const a = anchor({ size: 'M', dims: { chestWidth: { value: 21, source: 'fynd-record', verified: true }, bodyLength: { value: 28, source: 'fynd-record', verified: true }, sleeveLength: { value: 8.5, source: 'fynd-record', verified: true } } });
  assert.strictEqual(F.recommend(a, chart).size, 'L');
});

test('jeans: waist, inseam and hips in centimetres, measured flat — the right pair, and a jacket chart for a T-shirt anchor stays cautious', () => {
  const jeans = { measures: 'finished-garment', unit: 'cm', columns: ['Waist (laid flat)', 'Hip width', 'Inseam', 'Front rise'], rows: [
    { size: '30x32', values: ['39', '49', '81', '27'] }, { size: '32x32', values: ['41.5', '51', '81', '28'] }, { size: '34x32', values: ['44', '53', '81', '29'] }, { size: '32x34', values: ['41.5', '51', '86', '28'] }] };
  const a = F.makeAnchor({ brand: 'Levi’s', category: 'jeans', size: '32x32', feel: { fit: 'right', length: 'short' }, dims: { waist: { value: 16.3, source: 'shopper' }, hip: { value: 20.1, source: 'shopper' }, inseam: { value: 31.9, source: 'shopper' } } }).anchor;
  const r = F.recommend(a, jeans);
  assert.strictEqual(r.size, '32x34', 'same waist, longer inseam');
  assert.ok(r.confidence !== 'high', 'typed measurements and one length answer');
  const jacket = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length', 'Sleeve length'], rows: [{ size: 'M', values: ['22', '27', '25'] }, { size: 'L', values: ['23.5', '28', '25.5'] }] };
  const asJacket = F.recommend(anchor(), jacket, { category: 'jacket' });
  assert.strictEqual(asJacket.status, 'insufficient', 'a T-shirt can’t speak for a jacket: different family');
  const asSweat = F.recommend(anchor(), TEE, { category: 'sweatshirt' });
  assert.deepStrictEqual([asSweat.status, asSweat.confidence], ['ok', 'low']);
});

test('lengths measured from different points are never compared: a centre-back sleeve isn’t a shoulder-seam sleeve, a front length isn’t a back length', () => {
  const zara = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Front length', 'Sleeve length (from shoulder seam)'], rows: [{ size: 'M', values: ['20.5', '27', '8'] }, { size: 'L', values: ['22', '28', '8.25'] }] };
  const r = F.recommend(anchor(), zara);
  assert.deepStrictEqual(r.compared, ['chestWidth']);
  const why = Object.fromEntries(r.notCompared.map((n) => [n.dim, n.why]));
  assert.match(why.sleeveLength, /centre back, this chart’s from the shoulder seam/);
  assert.match(why.bodyLength, /back length, this chart’s front length/);
  assert.notStrictEqual(r.confidence, 'high');
  /* a sleeve whose method neither chart states isn't compared either */
  const unsaid = F.recommend(anchor({ dims: { chestWidth: { value: 22, source: 'fynd-record', verified: true }, sleeveLength: { value: 8.5, source: 'fynd-record', verified: true } } }), { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Sleeve length'], rows: [{ size: 'M', values: ['20.5', '8'] }, { size: 'L', values: ['22', '8.5'] }] });
  assert.ok(!unsaid.compared.includes('sleeveLength'));
});

section('confidence and honesty');

test('high confidence only with trusted measurements on both sides, several dimensions, and a clear winner', () => {
  const clear = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length (back)', 'Sleeve length (center back)'], rows: [{ size: 'S', values: ['18', '26', '7.5'] }, { size: 'M', values: ['20', '27.5', '8'] }, { size: 'L', values: ['22', '29', '8.5'] }, { size: 'XL', values: ['24', '30.5', '9'] }] };
  assert.strictEqual(F.recommend(anchor(), clear).confidence, 'high');
  const typed = anchor({ dims: { chestWidth: { value: 22, source: 'shopper' }, bodyLength: { value: 29, source: 'shopper', method: 'back' }, sleeveLength: { value: 8.5, source: 'shopper', method: 'center-back' } } });
  assert.strictEqual(F.recommend(typed, clear).confidence, 'medium');
  const unverified = anchor({ dims: { chestWidth: { value: 22, source: 'fynd-record', verified: false }, bodyLength: { value: 29, source: 'fynd-record', verified: false, method: 'back' } } });
  const u = F.recommend(unverified, clear);
  assert.strictEqual(u.confidence, 'medium');
  assert.match(u.explanation[0], /from Fynd’s record, not yet checked/);
  const similar = anchor({ dims: { chestWidth: { value: 22, source: 'similar-product' }, bodyLength: { value: 29, source: 'similar-product', method: 'back' } } });
  const s = F.recommend(similar, clear);
  assert.strictEqual(s.confidence, 'low');
  assert.match(s.explanation[0], /of about 22 in \(estimated from a similar product\)/, 'an estimate is never stated as exact');
  const inferred = F.recommend(anchor(), { measures: 'finished-garment', unit: null, columns: ['Chest', 'Length', 'Sleeve'], rows: clear.rows });
  assert.notStrictEqual(inferred.confidence, 'high');
  assert.ok(inferred.explanation.some((l) => /about/.test(l)));
});

test('the target chart’s own source caps confidence: an unchecked Fynd record or a chart the shopper corrected is never “high”', () => {
  const clear = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length (back)', 'Sleeve length (center back)'], rows: [{ size: 'S', values: ['18', '26', '7.5'] }, { size: 'M', values: ['20', '27.5', '8'] }, { size: 'L', values: ['22', '29', '8.5'] }, { size: 'XL', values: ['24', '30.5', '9'] }] };
  assert.strictEqual(F.recommend(anchor(), clear, { targetSource: 'retailer-page' }).confidence, 'high');
  const unchecked = F.recommend(anchor(), clear, { targetSource: 'fynd-record-unverified' });
  assert.strictEqual(unchecked.confidence, 'medium');
  assert.ok(unchecked.confidenceWhy.some((w) => /this product’s chart is from Fynd’s record, not yet checked/.test(w)));
  assert.strictEqual(F.recommend(anchor(), clear, { targetSource: 'shopper' }).confidence, 'medium');
});

test('a near tie is said, and offers the runner-up', () => {
  const tie = { measures: 'finished-garment', unit: 'in', columns: ['Chest width', 'Body length'], rows: [{ size: 'M', values: ['21.5', '28.5'] }, { size: 'L', values: ['22.5', '29.5'] }] };
  const r = F.recommend(anchor(), tie);
  assert.ok(r.alternative, JSON.stringify(r.ranked));
  assert.notStrictEqual(r.confidence, 'high');
});

section('learning from outcomes');

test('“L was too tight” moves the preferred width above L’s; “about right” centres it on L; disagreeing outcomes are flagged', () => {
  const a = anchor({ size: 'M', feel: { fit: 'tight', length: 'right' }, dims: { chestWidth: { value: 20.5, source: 'fynd-record', verified: true } } });
  const L = F.readChart(TEE, 'tshirt').sizes.find((s) => s.size === 'L');
  const tooTight = F.outcome(a, 'too-tight', L);
  assert.deepStrictEqual(tooTight.dims, { chestWidth: 22, bodyLength: 29, sleeveLength: 8.5 });
  const after = Object.assign({}, a, { feedback: [tooTight] });
  const p = F.preferred(after).chestWidth;
  assert.ok(p.low >= 22.125, JSON.stringify(p));
  assert.strictEqual(F.recommend(after, TEE).size, 'XL');
  const right = Object.assign({}, a, { feedback: [F.outcome(a, 'about-right', L)] });
  const q = F.preferred(right).chestWidth;
  assert.deepStrictEqual([q.low, q.high], [21.5, 22.5], 'about right at 22 in: around 22 in, whatever the first guess was');
  const conflicting = Object.assign({}, a, { feedback: [F.outcome(a, 'too-tight', L), F.outcome(a, 'too-loose', F.readChart(TEE, 'tshirt').sizes.find((s) => s.size === 'M'))] });
  assert.ok(F.preferred(conflicting).chestWidth.conflict);
  assert.ok(F.recommend(conflicting, TEE).confidenceWhy.some((w) => /disagree/.test(w)));
  assert.strictEqual(F.outcome(a, 'too-tight', { size: 'L', dims: {} }), null, 'an outcome with no measurements teaches nothing');
});

test('outcomes on one axis don’t move the other: “too short” moves length, not chest', () => {
  const a = anchor({ size: 'L' });
  const L = F.readChart(TEE, 'tshirt').sizes.find((s) => s.size === 'L');
  const after = Object.assign({}, a, { feedback: [F.outcome(a, 'too-short', L)] });
  const p = F.preferred(after);
  assert.ok(p.bodyLength.low >= 29.125);
  assert.deepStrictEqual([p.chestWidth.low, p.chestWidth.high], [21.5, 22.5]);
});

section('anchors and products');

test('makeAnchor keeps only known fields and every measurement’s source; a brand and label alone hold no dimensions', () => {
  assert.ok(F.makeAnchor({ brand: 'UNIQLO', size: 'M' }).error);
  assert.ok(F.makeAnchor({ brand: 'UNIQLO', category: 'tshirt' }).error);
  const a = F.makeAnchor({ brand: 'UNIQLO', category: 'tshirt', size: 'M', feel: { fit: 'snug' }, dims: { chestWidth: { value: 21, source: 'made-up' }, waist: { value: 16, source: 'shopper' }, bodyLength: { value: 28, source: 'shopper' } }, product: { url: 'javascript:alert(1)', name: 'Tee' }, extra: 'dropped' }).anchor;
  assert.deepStrictEqual(Object.keys(a.dims), ['bodyLength'], 'an unknown source, and a waist on a T-shirt, are dropped');
  assert.strictEqual(a.feel.fit, 'right');
  assert.strictEqual(a.product.url, null);
  assert.ok(!('extra' in a));
  assert.deepStrictEqual(F.makeAnchor({ brand: 'UNIQLO', category: 'tshirt', size: 'M' }).anchor.dims, {});
});

test('a reference from its own product’s garment chart, in the size on its label; never from a body chart', () => {
  const got = F.dimsFromChart(TEE, 'tshirt', 'M');
  assert.deepStrictEqual(Object.keys(got.dims).sort(), ['bodyLength', 'chestWidth', 'sleeveLength']);
  assert.strictEqual(got.dims.chestWidth.value, 20.5);
  assert.strictEqual(got.dims.chestWidth.source, 'retailer-page');
  assert.ok(F.dimsFromChart(Object.assign({}, TEE, { measures: 'body' }), 'tshirt', 'M').error);
  assert.ok(F.dimsFromChart(TEE, 'tshirt', 'XXS').error);
});

test('which anchor speaks for a product: same category first, then same family, never another family', () => {
  const tee = anchor();
  const sweat = Object.assign({}, anchor(), { id: 's', category: 'sweatshirt' });
  const jeans = F.makeAnchor({ brand: 'Levi’s', category: 'jeans', size: '32x32' }).anchor;
  assert.strictEqual(F.anchorFor([tee, sweat, jeans], 'sweatshirt').id, 's');
  assert.strictEqual(F.anchorFor([tee, jeans], 'shirt'), tee);
  assert.strictEqual(F.anchorFor([tee], 'jacket'), null);
  assert.strictEqual(F.anchorFor([tee, jeans], 'pants'), jeans);
});

test('a product’s kind from its own words; size order across letters, numbers and waist×inseam', () => {
  assert.strictEqual(F.categoryOf('Supima Cotton Crew Neck T-Shirt'), 'tshirt');
  assert.strictEqual(F.categoryOf('Sweat Pullover Hoodie'), 'sweatshirt');
  assert.strictEqual(F.categoryOf('Selvedge Slim Fit Jeans'), 'jeans');
  assert.strictEqual(F.categoryOf('Denim Jacket'), 'jacket');
  assert.strictEqual(F.categoryOf('Ceramic Mug'), null);
  const order = ['XL', 'S', 'M', 'XS', 'L'].sort((a, b) => F.sizeRank(a) - F.sizeRank(b));
  assert.deepStrictEqual(order, ['XS', 'S', 'M', 'L', 'XL']);
  assert.ok(F.sizeRank('32x30') < F.sizeRank('32x32') && F.sizeRank('32x34') < F.sizeRank('34x30'));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
