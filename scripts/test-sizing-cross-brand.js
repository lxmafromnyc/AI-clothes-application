#!/usr/bin/env node
/* =========================================================
   Fynd — the size engine across brands: UNIQLO and Everlane fixtures

   Offline, no key:

     node scripts/test-sizing-cross-brand.js

   Drives the existing engine (api/_sizing/engine.js compare()) — no
   second algorithm — with the fixtures in scripts/fixtures/cross-brand.js:
   UNIQLO's live records (pending review) and an ILLUSTRATIVE Everlane
   table (stand-in numbers, never presented as Everlane's).

   What it holds the engine to:
     - every fixture value keeps its source, raw text, unit, method and
       status, and the engine never overwrites a published value: a
       converted one is reported beside it and called estimated
     - signed differences are this size minus the reference, after only
       the conversion the engine states (a flat chest is half the way
       around); centimetres are inches × 2.54
     - a value whose method isn't stated, or is measured differently,
       is never compared, and says why
     - a size that matches on chest but not on length is reported with
       that trade-off, not as a plain match
     - the closest size is never recommended when every measurement
       compared misses its tolerance: partial, withheld
       "outside-tolerance", its differences kept as explanation
     - unverified or missing data never gives a recommendation
   ========================================================= */

'use strict';

const assert = require('assert');

const Schema = require('../assets/fit-profile-schema.js');
const sizingSchema = require('../api/_sizing/schema');
const sizing = require('../api/_sizing/records');
const engine = require('../api/_sizing/engine');
const { asChecked } = require('./fixtures/as-checked');
const X = require('./fixtures/cross-brand');

const out = (text) => process.stdout.write(text);
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    out(`  ok    ${name}\n`);
  } catch (err) {
    failures.push(name);
    out(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n        ')}\n`);
  }
}

const IN_TO_CM = 2.54;
const r2 = (v) => Math.round(v * 100) / 100;

/* a fit profile with one saved reference garment */
function profileWith(kind, anchor, favorite) {
  const p = Schema.empty();
  p.garments[kind] = Object.assign(Schema.emptyGarment(kind), { favorite: favorite || 'perfect', line: 'men', anchor });
  return p;
}
const uniqloRef = (size) => profileWith('sweatshirts', { brand: 'UNIQLO', size, product: { name: null, url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } });
const everlaneRef = (size) => profileWith('sweatshirts', { brand: 'Everlane', size, product: { name: X.EVERLANE_PUBLISHED.product } });

/* what Everlane's table would have to state for each value to be comparable — a WHAT-IF */
const IF_STATED = { chestWidth: 'garment-circumference', bodyLength: 'center-back-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };

const rowOf = (c, size) => c.sizes.find((s) => s.size === size);
const diffs = (c, size) => Object.fromEntries(Object.entries(rowOf(c, size).dimensions).filter(([, x]) => x.compared).map(([d, x]) => [d, x.difference]));

(async () => {
  out('\nthe fixtures keep where every value came from\n');

  await test('UNIQLO: every measurement keeps its source URL, raw text, unit, method and status — read from the live record, pending review', () => {
    [X.UQ_SWEATSHIRT, X.UQ_HOODIE].forEach((id) => {
      const f = X.uniqloPublished(id);
      const r = sizing.byId(id);
      assert.strictEqual(f.verification, 'unverified');
      assert.strictEqual(r.review.status, 'pending');
      Object.entries(f.sizes).forEach(([size, row]) => Object.entries(row).forEach(([d, m]) => {
        assert.ok(sizingSchema.officialUrl('UNIQLO', m.sourceUrl), `${id} ${size} ${d}: ${m.sourceUrl}`);
        assert.strictEqual(m.raw, r.charts.garment.sizes[size][d].text, 'the published text, exactly');
        assert.strictEqual(m.unit, 'in');
        assert.ok(sizingSchema.GARMENT_DIMENSIONS[d].methods.includes(m.method), m.method);
        assert.strictEqual(m.verification, 'unverified');
      }));
    });
    const s = X.uniqloPublished(X.UQ_SWEATSHIRT).sizes;
    assert.deepStrictEqual([s.S.chestWidth.raw, s.S.chestWidth.value, s.S.chestWidth.method], ['22 ¼', 22.25, 'flat-width-armpit-to-armpit'], 'UNIQLO publishes a flat chest width');
  });

  await test('Everlane (ILLUSTRATIVE): no source URL, every value marked illustrative, its raw text kept, and "chest_circumference" NOT taken as a circumference — method not stated', () => {
    const f = X.everlanePublished();
    assert.strictEqual(f.illustrative, true);
    assert.strictEqual(f.sourceUrl, null, 'no page is claimed for stand-in numbers');
    assert.strictEqual(f.verification, 'unverified');
    Object.values(f.sizes).forEach((row) => Object.values(row).forEach((m) => {
      assert.strictEqual(m.illustrative, true);
      assert.strictEqual(m.sourceUrl, null);
      assert.strictEqual(m.method, 'not-stated');
      assert.strictEqual(m.verification, 'unverified');
      assert.strictEqual(m.unit, 'in');
      assert.strictEqual(m.value, X.parseInches(m.raw));
    }));
    assert.deepStrictEqual([f.sizes.S.chestWidth.publishedAs, f.sizes.S.chestWidth.raw, f.sizes.S.chestWidth.value], ['chest_circumference', '44 ½', 44.5]);
    assert.throws(() => X.parseInches('44-46'), /not a published inch value/, 'a value that isn\'t one number is refused, never guessed');
  });

  await test('a fixture record is never a production record: built on a reserved .invalid host, accepted only inside the test, and never verified', () => {
    const record = X.everlaneRecord(X.everlanePublished(), IF_STATED);
    assert.ok(sizingSchema.validate(record).length > 0, 'outside the test, Everlane is not an accepted brand');
    X.withFixtureBrand(() => assert.deepStrictEqual(sizingSchema.validate(record), []));
    assert.ok(!sizingSchema.OFFICIAL_HOSTS.Everlane, 'put back after the test');
    assert.strictEqual(new URL(record.product.url).hostname, X.FIXTURE_HOST);
    assert.strictEqual(record.verification.status, 'unverified');
    assert.deepStrictEqual(record.fixture.methodsAssumed, IF_STATED, 'the what-if is named on the record itself');
    assert.ok(!sizing.RECORDS.some((r) => r.brand === 'Everlane' || r.id.startsWith('fixture-')), 'nothing added to the catalogue');
  });

  out('\nUNIQLO S beside UNIQLO\'s own sizes\n');

  await test('UNIQLO Sweatshirt S as the reference, the hoodie\'s sizes beside it (checked in memory): S recommended, every difference this size minus the reference, in its published inches', () => asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us', 'uniqlo-e475377-sweatshirt-us'], () => {
    const c = engine.compare(uniqloRef('S'), sizing.byId(X.UQ_HOODIE));
    assert.strictEqual(c.status, 'ok');
    assert.strictEqual(c.recommended, 'S');
    assert.strictEqual(c.unit, 'in');
    assert.deepStrictEqual(c.dimensionsCompared, ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength']);
    assert.deepStrictEqual(c.reference.measurements.chestWidth, { value: 22.25, unit: 'in', method: 'flat-width-armpit-to-armpit', source: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00', origin: 'official-published', retrievedAt: '2026-10-10' }, status: 'verified' });
    const pub = X.uniqloPublished(X.UQ_HOODIE).sizes;
    const ref = X.uniqloPublished(X.UQ_SWEATSHIRT).sizes.S;
    ['XS', 'S', 'M', 'L'].forEach((size) => {
      const want = Object.fromEntries(c.dimensionsCompared.map((d) => [d, r2(pub[size][d].value - ref[d].value)]));
      assert.deepStrictEqual(diffs(c, size), want, size);
    });
    assert.deepStrictEqual(diffs(c, 'S'), { chestWidth: 0, bodyLength: 0, shoulderWidth: 0, sleeveLength: 0 });
    assert.deepStrictEqual(diffs(c, 'M'), { chestWidth: 1.25, bodyLength: 1.25, shoulderWidth: 0.75, sleeveLength: 1 }, 'larger is positive');
    assert.ok(Object.values(diffs(c, 'XS')).every((v) => v < 0), 'smaller is negative');
    assert.ok(Object.values(rowOf(c, 'M').dimensions).every((x) => x.estimated === null), 'same method: nothing worked out');
    assert.strictEqual(c.reference.crossCategory, true, 'a sweatshirt reference for a hoodie');
    assert.strictEqual(c.reliability, 'medium', 'and lowered for it');
    assert.deepStrictEqual(c.tradeoffs, [], 'S matches on every measurement');
    assert.strictEqual(c.withheld, null);
  }));

  await test('centimetres: every value and difference is the inch figure × 2.54, and the published inches are kept on each measurement', () => asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us', 'uniqlo-e475377-sweatshirt-us'], () => {
    const inch = engine.compare(uniqloRef('S'), sizing.byId(X.UQ_HOODIE));
    const cm = engine.compare(uniqloRef('S'), sizing.byId(X.UQ_HOODIE), { unit: 'cm' });
    assert.strictEqual(cm.unit, 'cm');
    assert.strictEqual(cm.recommended, inch.recommended, 'the unit shown never changes the answer');
    inch.sizes.forEach((row) => Object.entries(row.dimensions).forEach(([d, x]) => {
      if (!x.compared) return;
      const y = rowOf(cm, row.size).dimensions[d];
      assert.strictEqual(y.difference, r2(x.difference * IN_TO_CM), `${row.size} ${d}`);
      assert.strictEqual(y.candidate, r2(x.candidate * IN_TO_CM));
      assert.deepStrictEqual([y.measurement.value, y.measurement.unit], [x.measurement.value, 'in'], 'the published value, in its published unit');
    }));
    assert.strictEqual(rowOf(cm, 'M').dimensions.chestWidth.difference, 3.18, '1¼ in');
    assert.strictEqual(rowOf(cm, 'M').dimensions.chestWidth.words, 'Chest: 3.2 cm wider');
    assert.strictEqual(cm.reference.values.chestWidth, r2(22.25 * IN_TO_CM));
  }));

  out('\nEverlane, as published: method not stated\n');

  await test('an Everlane value whose method isn\'t stated is never compared — no recommendation, no difference, and the reason given', () => asChecked(['uniqlo-e475377-sweatshirt-us'], () => X.withFixtureBrand(() => {
    const record = X.asCheckedCopy(X.everlaneRecord(X.everlanePublished()));
    assert.deepStrictEqual(sizingSchema.validate(record), [], 'a value without a stated method is still a record Fynd can hold');
    const c = engine.compare(uniqloRef('M'), record);
    assert.strictEqual(c.status, 'insufficient');
    assert.strictEqual(c.missing[0].code, 'nothing-comparable');
    assert.ok(!('recommended' in c) && !('sizes' in c));
    assert.deepStrictEqual(c.notCompared.map((x) => [x.dim, x.why]), [
      ['chestWidth', 'Everlane doesn\'t say how its chest is measured'],
      ['bodyLength', 'Everlane doesn\'t say how its length is measured'],
      ['sleeveLength', 'Everlane doesn\'t say how its sleeves are measured'],
      ['shoulderWidth', 'Everlane doesn\'t say how its shoulders are measured']
    ]);
  })));

  await test('two values whose methods are both unstated are not compared either: Everlane S as the reference, Everlane\'s own sizes beside it', () => X.withFixtureBrand(() => {
    const record = X.asCheckedCopy(X.everlaneRecord(X.everlanePublished()));
    const c = engine.compare(everlaneRef('S'), record, { records: [record] });
    assert.strictEqual(c.status, 'insufficient');
    assert.strictEqual(c.missing[0].code, 'nothing-comparable');
    assert.ok(c.notCompared.every((x) => /doesn't say how/.test(x.why)), JSON.stringify(c.notCompared));
  }));

  out('\nEverlane, IF its table stated each method (what-if)\n');

  await test('Everlane S as the reference, its chest a circumference: kept as published (44½ around), and halved — called estimated — only where UNIQLO\'s flat width is set beside it', () => asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us'], () => X.withFixtureBrand(() => {
    const ever = X.asCheckedCopy(X.everlaneRecord(X.everlanePublished(), IF_STATED));
    const c = engine.compare(everlaneRef('S'), sizing.byId(X.UQ_HOODIE), { records: [ever] });
    assert.strictEqual(c.reference.source, 'product');
    assert.deepStrictEqual([c.reference.measurements.chestWidth.value, c.reference.measurements.chestWidth.method], [44.5, 'garment-circumference'], 'the raw value, as published');
    assert.strictEqual(c.reference.values.chestWidth, 44.5, 'the reference is shown as published');
    const chestS = rowOf(c, 'S').dimensions.chestWidth;
    assert.strictEqual(chestS.reference, 22.25, 'in UNIQLO\'s method: half of 44½');
    assert.strictEqual(chestS.estimated, 'chest flat width, as half its way around');
    assert.strictEqual(chestS.difference, 0);
    assert.strictEqual(rowOf(c, 'M').dimensions.chestWidth.difference, 1.25);
    assert.strictEqual(ever.charts.garment.sizes.S.chestWidth.value, 44.5, 'the record itself is untouched');
    /* the sleeve: Everlane from the shoulder seam, UNIQLO from the centre back — not convertible */
    assert.deepStrictEqual(c.notCompared.map((x) => x.dim), ['sleeveLength']);
    assert.match(c.notCompared[0].why, /measured differently — UNIQLO's from the centre back, Everlane's from the shoulder seam/);
    assert.ok(c.caveats.some((x) => /worked-out value/.test(x)), 'said in the caveats');
    assert.notStrictEqual(c.reliability, 'high', 'an estimate caps it');
  })));

  await test('UNIQLO M as the reference, Everlane S, M and L beside it: each signed difference after doubling UNIQLO\'s flat chest, the sleeve left out, M matching on chest but 3 in longer — and that trade-off reported', () => asChecked(['uniqlo-e475377-sweatshirt-us'], () => X.withFixtureBrand(() => {
    const ever = X.asCheckedCopy(X.everlaneRecord(X.everlanePublished(), IF_STATED));
    const c = engine.compare(uniqloRef('M'), ever);
    assert.deepStrictEqual(c.dimensionsCompared, ['chestWidth', 'bodyLength', 'shoulderWidth']);
    assert.deepStrictEqual(diffs(c, 'S'), { chestWidth: -2.5, bodyLength: 1.75, shoulderWidth: -1 });
    assert.deepStrictEqual(diffs(c, 'M'), { chestWidth: 0, bodyLength: 3, shoulderWidth: 0 });
    assert.deepStrictEqual(diffs(c, 'L'), { chestWidth: 3, bodyLength: 4.25, shoulderWidth: 1 });
    const chestM = rowOf(c, 'M').dimensions.chestWidth;
    assert.deepStrictEqual([chestM.reference, chestM.candidate, chestM.estimated], [47, 47, 'chest around, as twice its flat width'], 'UNIQLO\'s 23½ flat, doubled; Everlane\'s 47 as published');
    assert.match(c.notCompared[0].why, /measured differently/);
    /* the engine's own ranking: M's length costs more than S's chest and shoulders together */
    assert.deepStrictEqual(c.sizes.map((s) => [s.size, s.rank]), [['S', 1], ['M', 2], ['L', 3]]);
    assert.strictEqual(c.closest, 'S');
    /* a trade-off is said, not hidden in a total: each compared measurement of the closest size further off than the engine's own tolerance */
    assert.deepStrictEqual(c.tradeoffs.map((t) => [t.dim, t.difference, t.tolerance]), [['chestWidth', -2.5, 2], ['bodyLength', 1.75, 1], ['shoulderWidth', -1, 0.75]]);
    assert.deepStrictEqual(c.tradeoffs.map((t) => t.words), ['Chest: 2½ in narrower', 'Body length: 1¾ in longer', 'Shoulders: 1 in narrower']);
    const m = rowOf(c, 'M').dimensions;
    assert.deepStrictEqual([m.chestWidth.withinTolerance, m.bodyLength.withinTolerance, m.shoulderWidth.withinTolerance], [true, false, true], 'M: chest and shoulders match, the length doesn\'t');
    assert.ok(c.caveats.includes('S differs from your reference by more than Fynd treats as similar on chest, length and shoulders.'), 'said with the comparison\'s limits');
    /* closest is not close: every compared measurement misses its tolerance, so nothing is recommended — the size and its differences stay, as explanation */
    assert.deepStrictEqual([c.status, c.recommended, c.withheld], ['partial', null, 'outside-tolerance']);
    assert.strictEqual(c.summary, 'S is the closest size, but its chest, length and shoulders all differ from your reference by more than Fynd treats as similar, so it isn\'t a recommendation.');
    assert.strictEqual(rowOf(c, 'S').dimensions.chestWidth.difference, -2.5, 'the signed differences are kept');
  })));

  await test('a chest match beside a substantial length mismatch, ranked closest: recommended — the measurements within tolerance support it — with the length named as a trade-off', () => asChecked(['uniqlo-e475377-sweatshirt-us'], () => X.withFixtureBrand(() => {
    /* a variant of the illustrative table: S narrower, so M (chest and shoulders matching, 3 in longer) ranks first */
    const f = X.everlanePublished(Object.assign({}, X.EVERLANE_PUBLISHED, { sizes: Object.assign({}, X.EVERLANE_PUBLISHED.sizes, { S: Object.assign({}, X.EVERLANE_PUBLISHED.sizes.S, { chest_circumference: '43' }) }) }));
    const c = engine.compare(uniqloRef('M'), X.asCheckedCopy(X.everlaneRecord(f, IF_STATED)));
    assert.strictEqual(c.closest, 'M');
    assert.deepStrictEqual(diffs(c, 'M'), { chestWidth: 0, bodyLength: 3, shoulderWidth: 0 });
    assert.deepStrictEqual([c.status, c.recommended, c.withheld], ['ok', 'M', null]);
    assert.deepStrictEqual(c.tradeoffs, [{ size: 'M', dim: 'bodyLength', difference: 3, tolerance: 1, words: 'Body length: 3 in longer' }]);
    assert.ok(c.caveats.includes('M differs from your reference by more than Fynd treats as similar on length.'));
    assert.strictEqual(c.reliability, 'medium', 'compared on three of four, one of them worked out');
  })));

  await test('a candidate that meets the fit criteria: every compared measurement within tolerance, recommended, no trade-off', () => asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us', 'uniqlo-e475377-sweatshirt-us'], () => {
    const c = engine.compare(uniqloRef('M'), sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([c.status, c.recommended, c.withheld, c.tradeoffs], ['ok', 'M', null, []]);
    assert.ok(Object.values(rowOf(c, 'M').dimensions).every((x) => x.withinTolerance === true));
    assert.ok(Object.values(rowOf(c, 'L').dimensions).some((x) => x.withinTolerance === false), 'the next size up does miss');
  }));

  out('\nmissing, mismatched and unverified data\n');

  await test('a size missing a measurement the others are compared on is shown but not ranked, and said', () => asChecked(['uniqlo-e475377-sweatshirt-us'], () => X.withFixtureBrand(() => {
    const f = X.everlanePublished();
    delete f.sizes.M.bodyLength;
    const ever = X.asCheckedCopy(X.everlaneRecord(f, IF_STATED));
    const c = engine.compare(uniqloRef('M'), ever);
    const m = rowOf(c, 'M');
    assert.strictEqual(m.score, null);
    assert.strictEqual(m.dimensions.bodyLength.compared, false);
    assert.strictEqual(m.dimensions.bodyLength.difference, undefined, 'no difference without a value');
    assert.match(m.unranked, /M isn't ranked: Everlane publishes no length for it/);
    assert.ok(c.notes.includes(m.unranked));
    assert.notStrictEqual(c.recommended, 'M');
  })));

  await test('a dimension the reference lacks is left out, with why; only chest and length in common is too little to recommend', () => asChecked(['uniqlo-e475377-sweatshirt-us'], () => X.withFixtureBrand(() => {
    const f = X.everlanePublished();
    Object.values(f.sizes).forEach((row) => { delete row.shoulderWidth; });
    const ever = X.asCheckedCopy(X.everlaneRecord(f, IF_STATED));
    const c = engine.compare(uniqloRef('M'), ever);
    assert.deepStrictEqual(c.dimensionsCompared, ['chestWidth', 'bodyLength']);
    assert.ok(c.notCompared.some((x) => x.dim === 'shoulderWidth' && x.why === 'Everlane doesn\'t publish it'));
    assert.strictEqual(c.status, 'partial');
    assert.strictEqual(c.recommended, null);
    assert.strictEqual(c.withheld, 'too-few-dimensions');
    assert.match(c.summary, /2 of 4 dimensions — not enough for a recommendation/);
  })));

  await test('lengths measured differently (from the top of the shoulder vs the centre back) are never converted or compared', () => asChecked(['uniqlo-e475377-sweatshirt-us'], () => X.withFixtureBrand(() => {
    const ever = X.asCheckedCopy(X.everlaneRecord(X.everlanePublished(), Object.assign({}, IF_STATED, { bodyLength: 'high-point-shoulder-to-hem' })));
    const c = engine.compare(uniqloRef('M'), ever);
    assert.ok(!c.dimensionsCompared.includes('bodyLength'));
    assert.match(c.notCompared.find((x) => x.dim === 'bodyLength').why, /measured differently — Everlane's from the top of the shoulder, UNIQLO's from the centre back/);
    assert.ok(c.sizes.every((s) => s.dimensions.bodyLength.compared === false && s.dimensions.bodyLength.difference === undefined));
  })));

  await test('unverified data gives no recommendation: Everlane as supplied, UNIQLO pending review, and an unverified reference', () => X.withFixtureBrand(() => {
    const ever = X.everlaneRecord(X.everlanePublished(), IF_STATED);
    const a = engine.compare(uniqloRef('M'), ever);
    assert.deepStrictEqual([a.status, a.missing[0].code, a.dataStatus], ['insufficient', 'unverified-data', 'unverified']);
    assert.ok(!('sizes' in a) && !('recommended' in a), 'not even a number');
    const b = engine.compare(uniqloRef('M'), sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([b.status, b.missing[0].code], ['insufficient', 'unverified-data'], 'UNIQLO, pending review in production');
    /* a checked product, but the reference product unchecked and nothing measured: nothing to compare with */
    const c = engine.compare(uniqloRef('M'), X.asCheckedCopy(ever));
    assert.deepStrictEqual([c.status, c.missing[0].code], ['insufficient', 'no-reference-measurements']);
    /* the evaluation suite may look at unverified numbers, and is still never given a recommendation */
    const d = asChecked(['uniqlo-e475377-sweatshirt-us'], () => engine.compare(uniqloRef('M'), ever, { includeUnverified: true }));
    assert.deepStrictEqual([d.status, d.recommended, d.dataStatus, d.withheld], ['partial', null, 'unverified', 'unverified']);
    assert.match(d.summary, /haven't been checked, so it isn't a recommendation/);
  }));

  await test('recommend(): a chest published without its method is never set against a body — the same record with the method stated is', () => X.withFixtureBrand(() => {
    const body = Schema.empty();
    body.measurements = { unit: 'in', chest: 40 };
    body.garments.sweatshirts = Object.assign(Schema.emptyGarment('sweatshirts'), { line: 'men', fitGoal: 'true-to-size' });
    const unstated = engine.recommend(body, X.asCheckedCopy(X.everlaneRecord(X.everlanePublished())));
    assert.strictEqual(unstated.status, 'insufficient', 'a chest that might be a width or a circumference is neither');
    assert.ok(!('leading' in unstated));
    const stated = engine.recommend(body, X.asCheckedCopy(X.everlaneRecord(X.everlanePublished(), IF_STATED)));
    assert.deepStrictEqual([stated.status, stated.method], ['ok', 'body-plus-ease'], 'the what-if, stated as a circumference, is scored as one');
  }));

  out('\nvalidate(): can this be compared, before any size is scored\n');

  const sizingSchema2 = require('../api/_sizing/schema');
  const measured = (m) => profileWith('hoodies', { brand: 'Carhartt', size: 'L', measurements: Object.assign({ unit: 'in' }, m) });
  /* validate() and compare() agree: ready exactly when compare() compares */
  const agree = (v, c) => assert.strictEqual(v.ready, c.status !== 'insufficient', `validate ${v.status} vs compare ${c.status}`);

  await test('each method is a kind — flat, circumference, length, width, body or unknown — from the method alone, never a column\'s name', () => {
    assert.deepStrictEqual(['flat-width-armpit-to-armpit', 'garment-circumference', 'center-back-to-hem', 'seam-to-seam', 'body-circumference', 'not-stated', 'chest_circumference'].map(sizingSchema2.methodKind),
      ['flat', 'circumference', 'length', 'width', 'body', 'unknown', 'unknown']);
    X.withFixtureBrand(() => {
      const rec = X.everlaneRecord(X.everlanePublished());
      assert.strictEqual(sizingSchema2.methodKind(rec.charts.garment.dimensions.chestWidth.method), 'unknown', 'published as "chest_circumference", method not stated: unknown');
    });
  });

  await test('ready: both sides measured the same way, each dimension with its method, kind and status; a recommendation possible on enough of them', () => asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us', 'uniqlo-e475377-sweatshirt-us'], () => {
    const v = engine.validate(uniqloRef('S'), sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([v.status, v.ready, v.canRecommend, v.code], ['ready', true, true, null]);
    assert.match(v.explanation, /^Ready to compare on chest, length, shoulders and sleeves\.$/);
    const chest = v.dimensions.find((d) => d.dim === 'chestWidth');
    assert.deepStrictEqual(chest, { dim: 'chestWidth', compared: true, code: null, why: null, target: { method: 'flat-width-armpit-to-armpit', kind: 'flat', status: 'verified' }, reference: { method: 'flat-width-armpit-to-armpit', kind: 'flat', status: 'verified' }, derived: null });
    agree(v, engine.compare(uniqloRef('S'), sizing.byId(X.UQ_HOODIE)));
  }));

  await test('ready on too few: two dimensions compare, and validate says no recommendation can follow — compare() agrees', () => asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us'], () => {
    const p = measured({ chestWidth: 23.5, shoulderWidth: 20 });
    const v = engine.validate(p, sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([v.status, v.ready, v.canRecommend], ['ready', true, false]);
    assert.match(v.explanation, /too few measurements are shared for a recommendation/);
    const c = engine.compare(p, sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([c.status, c.withheld], ['partial', 'too-few-dimensions']);
    agree(v, c);
  }));

  await test('a circumference beside a flat width: ready, the converted value named derived, and both source methods kept as they are', () => asChecked(['uniqlo-e475377-sweatshirt-us'], () => X.withFixtureBrand(() => {
    const ever = X.asCheckedCopy(X.everlaneRecord(X.everlanePublished(), IF_STATED));
    const v = engine.validate(uniqloRef('M'), ever);
    assert.strictEqual(v.status, 'ready');
    const chest = v.dimensions.find((d) => d.dim === 'chestWidth');
    assert.deepStrictEqual([chest.target.kind, chest.reference.kind], ['circumference', 'flat']);
    assert.deepStrictEqual(chest.derived, { rule: 'chest around, as twice its flat width', from: 'flat-width-armpit-to-armpit', to: 'garment-circumference' });
    assert.strictEqual(ever.charts.garment.sizes.M.chestWidth.value, 47, 'the source value untouched');
    agree(v, engine.compare(uniqloRef('M'), ever));
  })));

  await test('missing reference: no garment of this kind, or one without measurements or a matched product — the reason, and what to add', () => asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us'], () => {
    const none = engine.validate(Schema.empty(), sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([none.status, none.ready, none.code], ['missing-reference', false, 'no-reference']);
    const labelOnly = engine.validate(profileWith('hoodies', { brand: 'Champion', size: 'L' }), sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([labelOnly.status, labelOnly.code], ['missing-reference', 'no-reference']);
    const unmatched = engine.validate(profileWith('hoodies', { brand: 'Champion', size: 'L', product: { name: 'Reverse Weave' } }), sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([unmatched.status, unmatched.code], ['missing-reference', 'no-reference-measurements']);
    assert.ok(unmatched.next.some((n) => /measurements, laid flat/.test(n)), JSON.stringify(unmatched.next));
    agree(none, engine.compare(Schema.empty(), sizing.byId(X.UQ_HOODIE)));
  }));

  await test('missing target: no record, a kind not covered — never a guess', () => {
    const v = engine.validate(uniqloRef('M'), null);
    assert.deepStrictEqual([v.status, v.ready, v.code, v.dimensions], ['missing-target', false, 'no-record', []]);
  });

  await test('body-only: a record with only the body each size is cut for is never set beside a garment', () => {
    const nike = sizing.byId('nike-fn3859-club-pullover-fleece-hoodie-us');
    assert.ok(nike.charts.body && !nike.charts.garment && sizingSchema2.isVerified(nike), 'a verified record, body chart only');
    const v = engine.validate(measured({ chestWidth: 23.5 }), nike);
    assert.deepStrictEqual([v.status, v.code], ['body-only', 'body-chart-only']);
    assert.match(v.explanation, /publishes who each size is cut for, not what the garment itself measures/);
    agree(v, engine.compare(measured({ chestWidth: 23.5 }), nike));
  });

  await test('methods: values whose method isn\'t stated, or measured differently, say which and why', () => asChecked(['uniqlo-e475377-sweatshirt-us', 'uniqlo-e475378-sweat-pullover-hoodie-us'], () => X.withFixtureBrand(() => {
    const unknown = engine.validate(uniqloRef('M'), X.asCheckedCopy(X.everlaneRecord(X.everlanePublished())));
    assert.deepStrictEqual([unknown.status, unknown.code], ['methods', 'nothing-comparable']);
    assert.ok(unknown.dimensions.every((d) => d.code === 'method-unknown' && d.target.kind === 'unknown'), JSON.stringify(unknown.dimensions));
    /* the shopper's length and sleeve are taken from the shoulder; UNIQLO's from the centre back */
    const mismatch = engine.validate(measured({ bodyLength: 27, sleeveLength: 24 }), sizing.byId(X.UQ_HOODIE));
    assert.strictEqual(mismatch.status, 'methods');
    assert.deepStrictEqual(mismatch.dimensions.filter((d) => d.code === 'method-mismatch').map((d) => d.dim), ['bodyLength', 'sleeveLength']);
    agree(mismatch, engine.compare(measured({ bodyLength: 27, sleeveLength: 24 }), sizing.byId(X.UQ_HOODIE)));
  })));

  await test('unverified: a record not checked, crowdsourced numbers, or a checked record whose garment measurements a reviewer marked unverified — present, never compared', () => {
    const v = engine.validate(uniqloRef('M'), sizing.byId(X.UQ_HOODIE));
    assert.deepStrictEqual([v.status, v.code], ['unverified', 'unverified-data'], 'production: pending review');
    asChecked(['uniqlo-e475378-sweat-pullover-hoodie-us', 'uniqlo-e475377-sweatshirt-us'], () => {
      /* extracted and the record checked, but each garment measurement marked unverified: not verified */
      const lowered = JSON.parse(JSON.stringify(sizing.byId(X.UQ_HOODIE)));
      Object.values(lowered.charts.garment.dimensions).forEach((d) => { d.status = 'unverified'; });
      const w = engine.validate(uniqloRef('M'), lowered);
      assert.deepStrictEqual([w.status, w.ready], ['unverified', false]);
      assert.ok(w.dimensions.every((d) => d.code === 'target-unverified' && d.target.status === 'unverified'));
      agree(w, engine.compare(uniqloRef('M'), lowered));
    });
  });

  out(`\n${passed} passed, ${failures.length} failed\n\n`);
  process.exit(failures.length ? 1 : 0);
})();
