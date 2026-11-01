#!/usr/bin/env node
/* =========================================================
   Fynd — measurements are compared only when genuinely comparable
   Offline, no key:
     node scripts/test-measurement-methods.js

   One principle, held at every step: never recommend a size from
   measurements that aren't measured the same way, or that aren't the
   shopper's own garment's.
     the registry      the canonical method ids (api/_sizing/methods.js),
                       one source for the schema, the engine, the
                       decision and the fit profile; which pairs compare
     the reference     saved methods (fit profile v6), migrated from v5
     labels            a brand and size never become garment measurements
     no fallback       a reference that can't be compared gives
                       INSUFFICIENT_DATA, never a size from the body
     per dimension     every status the decision can give, from real
                       records or in-memory copies of them
     unchanged         the 3-of-4-with-chest rule, and every compatible
                       input's ranking
   Records marked checked are so in memory only (scripts/fixtures/
   as-checked.js); copies are made in memory; nothing is written.
   ========================================================= */

'use strict';

const assert = require('assert');

const Schema = require('../assets/fit-profile-schema.js');
const sizing = require('../api/_sizing/records');
const sizingSchema = require('../api/_sizing/schema');
const engine = require('../api/_sizing/engine');
const decision = require('../api/_sizing/decision');
const methods = require('../api/_sizing/methods');
const { asChecked } = require('./fixtures/as-checked');

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

const ZARA = 'zara-00761350-basic-relaxed-fit-hoodie-us';
const ZARA_B = 'zara-00761810-basic-heavyweight-hoodie-us';
const UQ_HOODIE = 'uniqlo-e475378-sweat-pullover-hoodie-us';
const NIKE = 'nike-fn3859-club-pullover-fleece-hoodie-us';
const ALL_ZARA = sizing.RECORDS.filter((r) => r.brand === 'Zara').map((r) => r.id);
const GARMENT_RECORDS = sizing.RECORDS.filter((r) => r.charts.garment).map((r) => r.id);
const DIMS = methods.DIMENSIONS;
const copy = (v) => JSON.parse(JSON.stringify(v));
const verified = (id) => { const r = copy(sizing.byId(id)); r.verification = { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-31' }; if (r.review) r.review.status = 'done'; return r; };
const rowOf = (record, size) => Object.fromEntries(Object.entries(record.charts.garment.sizes[size]).map(([d, c]) => [d, c.value]));
const codes = (d) => d.reasons.map((r) => r.code);

/* the shopper's own garment: measured (with methods, or the form's), or a product by link or name */
const measuredRef = (category, values, unit, savedMethods) => {
  const p = Schema.empty();
  p.garments[category] = Object.assign(Schema.emptyGarment(category), { favorite: 'perfect', line: 'men', fitGoal: 'true-to-size',
    anchor: Object.assign({ brand: null, size: 'M', measurements: Object.assign({ unit }, values) }, savedMethods ? { methods: savedMethods } : {}) });
  return p;
};
const productRef = (category, product, size) => {
  const p = Schema.empty();
  p.garments[category] = Object.assign(Schema.emptyGarment(category), { favorite: 'perfect', line: 'men', fitGoal: 'true-to-size', anchor: { brand: null, size, product } });
  return p;
};
const labelOnly = (category, brand, size) => {
  const p = Schema.empty();
  p.garments[category] = Object.assign(Schema.emptyGarment(category), { line: 'men', fitGoal: 'true-to-size', anchor: { brand, size } });
  return p;
};
const usualSize = (category, brand, size, measuredChest) => {
  const p = Object.assign(Schema.empty(), { brandSizes: [{ brand, category, size, fit: 'about-right' }] });
  if (measuredChest) p.measurements = { unit: 'in', height: null, chest: measuredChest, waist: null, hip: null };
  p.garments[category] = Object.assign(Schema.emptyGarment(category), { line: 'men', fitGoal: 'true-to-size' });
  return p;
};
const withChest = (p, c) => Object.assign(p, { measurements: { unit: 'in', height: null, chest: c, waist: null, hip: null } });
const DEVELOPER = /\b(engine|policy|reason code|record|registry|validate|undefined|null)\b|`/i;

(async () => {
  out('Measurement methods\n\n');

  /* ---------- the canonical registry ---------- */

  await test('every pair of methods, per dimension: the same compares; chest flat ↔ around converts, as an estimate; nothing else ever does', () => {
    DIMS.forEach((dim) => {
      const ids = methods.methodsOf(dim);
      ids.forEach((a) => ids.forEach((b) => {
        const r = methods.relation(dim, a, b);
        const flatAround = dim === 'chestWidth' && [a, b].sort().join() === ['flat-width-armpit-to-armpit', 'garment-circumference'].sort().join();
        if (a === methods.NOT_STATED || b === methods.NOT_STATED) assert.strictEqual(r, null, `${dim} ${a}/${b}: a method not stated never compares, not even with another`);
        else if (a === b) assert.deepStrictEqual(r, { relation: 'same' }, `${dim} ${a}`);
        else if (flatAround) {
          assert.strictEqual(r.relation, 'convertible');
          assert.strictEqual(r.factor, a === 'flat-width-armpit-to-armpit' ? 2 : 0.5);
          assert.ok(/as (twice|half)/.test(r.estimated));
        } else assert.strictEqual(r, null, `${dim} ${a} → ${b} must not compare`);
      }));
    });
    /* an unknown id, or another dimension's, is never comparable */
    assert.strictEqual(methods.relation('sleeveLength', 'from-the-moon', 'from-the-moon'), null);
    assert.strictEqual(methods.relation('chestWidth', 'seam-to-seam', 'seam-to-seam'), null);
  });

  await test('one source: the schema, the engine\'s words, the method kinds and the fit profile\'s form all read the registry', () => {
    DIMS.forEach((d) => assert.deepStrictEqual(sizingSchema.GARMENT_DIMENSIONS[d].methods, methods.methodsOf(d), d));
    assert.deepStrictEqual(Object.keys(sizingSchema.GARMENT_DIMENSIONS), DIMS);
    assert.strictEqual(sizingSchema.METHOD_KINDS, methods.METHOD_KINDS);
    assert.strictEqual(engine.METHOD_WORDS, methods.SHORT_WORDS);
    /* the form measures each dimension by the method the registry marks for it */
    DIMS.forEach((d) => assert.strictEqual(Schema.GARMENT_MEASURES[d].method, methods.REFERENCE_METHODS[d], d));
    assert.strictEqual(Schema.METHODS_REGISTRY_VERSION, methods.REGISTRY_VERSION);
    /* every record names only canonical methods */
    sizing.RECORDS.filter((r) => r.charts.garment).forEach((r) => Object.entries(r.charts.garment.dimensions).forEach(([d, spec]) => assert.ok(methods.isMethod(d, spec.method), `${r.id} ${d} ${spec.method}`)));
  });

  await test('the engine compares a dimension exactly when the registry says the two methods compare — for every pair, on a real record', () => {
    const base = verified(ZARA);
    DIMS.forEach((dim) => methods.methodsOf(dim).forEach((target) => methods.methodsOf(dim).forEach((ref) => {
      const record = copy(base);
      record.charts.garment.dimensions[dim].method = target;
      if (dim === 'chestWidth' && target !== 'flat-width-armpit-to-armpit') delete record.charts.garment.dimensions[dim].derivedCircumference;
      const saved = Object.assign({ registry: 1 }, Object.fromEntries(DIMS.map((d) => [d, record.charts.garment.dimensions[d].method])), { [dim]: ref });
      const v = engine.validate(measuredRef('hoodies', rowOf(base, 'M'), base.units, saved), record);
      const x = v.dimensions.find((y) => y.dim === dim);
      const r = methods.relation(dim, ref, target);
      assert.strictEqual(x.compared, Boolean(r), `${dim}: reference ${ref}, product ${target}`);
      assert.strictEqual(Boolean(x.derived), Boolean(r && r.relation === 'convertible'), `${dim}: ${ref} → ${target} estimated?`);
    })));
  });

  /* ---------- the reference's saved methods ---------- */

  await test('a version 5 reference is migrated with the method its form measured each value by — only the values it holds; a label-only one is untouched', () => {
    const v5 = { schemaVersion: 5, garments: {
      hoodies: { favorite: 'perfect', line: 'men', anchor: { brand: 'Zara', size: 'M', measurements: { unit: 'cm', chestWidth: 66, bodyLength: null, sleeveLength: 65, shoulderWidth: null } } },
      tshirts: { anchor: { brand: 'Nike', size: 'L' } } } };
    const up = Schema.upgrade(v5);
    assert.strictEqual(up.schemaVersion, 6);
    assert.deepStrictEqual(up.garments.hoodies.anchor.methods, { registry: 1, chestWidth: 'flat-width-armpit-to-armpit', sleeveLength: 'shoulder-seam-to-cuff' });
    assert.deepStrictEqual(up.garments.hoodies.anchor.measurements, v5.garments.hoodies.anchor.measurements, 'every value as it was');
    assert.deepStrictEqual(up.garments.tshirts.anchor, { brand: 'Nike', size: 'L' });
    /* a saved v6 reference keeps its methods, but never an id that isn't one */
    const v6 = Schema.upgrade({ schemaVersion: 6, garments: { hoodies: { anchor: { brand: 'Zara', size: 'M', measurements: { unit: 'cm', chestWidth: 66, bodyLength: 67, sleeveLength: null, shoulderWidth: null }, methods: { registry: 1, chestWidth: 'garment-circumference', bodyLength: '<b>x</b>' } } } } });
    assert.deepStrictEqual(v6.garments.hoodies.anchor.methods, { registry: 1, chestWidth: 'garment-circumference' });
  });

  await test('saving a reference records the form\'s own methods — never a method the client claims', () => {
    const n = Schema.normaliseGuide({ garments: { hoodies: { favorite: 'perfect', anchor: { brand: 'Zara', size: 'M', measurements: { unit: 'cm', chestWidth: 60, bodyLength: 70 }, methods: { registry: 1, chestWidth: 'garment-circumference', bodyLength: 'center-back-to-hem' } } } } });
    assert.deepStrictEqual(n.errors, []);
    assert.deepStrictEqual(n.answers.garments.hoodies.anchor.methods, { registry: 1, chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem' });
  });

  await test('the engine uses the saved methods: a length saved as measured from the centre back meets UNIQLO\'s; an unknown id or a newer registry is never compared', () => asChecked([UQ_HOODIE], () => {
    const uq = sizing.byId(UQ_HOODIE);
    /* UNIQLO's centre-back sleeve (34 ¾ in for M) is past the form's range
       for a sleeve measured from the seam, so it is left out here */
    const m = Object.assign(rowOf(uq, 'M'), { sleeveLength: null });
    const status = (saved) => decision.decide(measuredRef('hoodies', m, uq.units, saved), uq).dimensions.find((x) => x.dim === 'bodyLength').status;
    /* legacy: the form's own (top of the shoulder) — not UNIQLO's */
    assert.strictEqual(status(undefined), 'incompatible-method');
    assert.strictEqual(status({ registry: 1, chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'center-back-to-hem', sleeveLength: 'center-back-to-cuff', shoulderWidth: 'seam-to-seam' }), 'compatible');
    assert.strictEqual(status({ registry: 1, bodyLength: 'from-the-moon' }), 'method-not-stated');
    assert.strictEqual(status({ registry: 99, bodyLength: 'center-back-to-hem' }), 'method-not-stated', 'a registry this code doesn\'t know names nothing it can trust');
    /* with every method saved as UNIQLO measures, the shopper's own hoodie is compared: OK */
    const all = decision.decide(measuredRef('hoodies', m, uq.units, { registry: 1, chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'center-back-to-hem', sleeveLength: 'center-back-to-cuff', shoulderWidth: 'seam-to-seam' }), uq);
    assert.deepStrictEqual([all.outcome, all.size, all.comparison], ['OK', 'M', 'garment-to-garment']);
  }));

  /* ---------- a label is never a garment's measurements ---------- */

  await test('a brand and size alone — as the reference or as a usual size — never becomes garment measurements, in any category, for any product', () => asChecked(GARMENT_RECORDS, () => {
    sizing.RECORDS.filter((r) => r.charts.garment && engine.CATEGORY_PARAMS[r.category]).forEach((record) => {
      const brand = record.brand;
      record.sizes.forEach((size) => {
        [labelOnly(record.category, brand, size), usualSize(record.category, brand, size), usualSize(record.category, brand, size, 40)].forEach((p) => {
          const r = engine.recommend(p, record);
          assert.notStrictEqual(r.method, 'reference-garment', `${record.id} ${size}`);
          if (r.status === 'ok') assert.ok(!r.anchor || r.anchor.usedAs !== 'garment');
          const c = engine.compare(p, record);
          assert.strictEqual(c.status, 'insufficient', `${record.id} ${size}: compare needs the shopper's own garment`);
          const d = decision.decide(p, record);
          assert.notStrictEqual(d.comparison, 'garment-to-garment', `${record.id} ${size}`);
          if (d.outcome === 'OK' && !p.measurements.chest) assert.ok(d.qualifiers.some((q) => q.code === 'evidence-from-size-label'), `${record.id} ${size} says it rests on a label`);
        });
      });
    });
  }));

  await test('only the shopper\'s exact product lends its own measurements — by its link or whole name; never a name that merely contains it, nor another product of the brand', () => asChecked(ALL_ZARA, () => {
    const a = sizing.byId(ZARA);
    const b = sizing.byId(ZARA_B);
    const viaLink = engine.recommend(productRef('hoodies', { name: null, url: a.product.url }, 'M'), b);
    assert.deepStrictEqual([viaLink.method, viaLink.anchor.match.id, viaLink.anchor.match.by], ['reference-garment', ZARA, 'link']);
    const viaName = engine.recommend(productRef('hoodies', { name: a.product.name, url: null }, 'M'), b);
    assert.deepStrictEqual([viaName.method, viaName.anchor.match.id], ['reference-garment', ZARA]);
    /* "BASIC HOODIE" only appears inside several names: no product, and no garment */
    const partly = engine.recommend(productRef('hoodies', { name: 'Basic hoodie', url: null }, 'M'), b);
    assert.ok(!partly.anchor || !partly.anchor.match, JSON.stringify(partly.anchor));
    assert.notStrictEqual(partly.method, 'reference-garment');
  }));

  /* ---------- no body fallback for a garment comparison ---------- */

  await test('a reference that can\'t be compared is never replaced by the body: UNIQLO (lengths from the centre back) with a measured hoodie and a 40 in chest is INSUFFICIENT_DATA', () => asChecked([UQ_HOODIE], () => {
    const uq = sizing.byId(UQ_HOODIE);
    const p = withChest(measuredRef('hoodies', Object.assign(rowOf(uq, 'M'), { sleeveLength: 25 }), uq.units), 40);
    const d = decision.decide(p, uq);
    assert.deepStrictEqual([d.outcome, d.comparison, d.size], ['INSUFFICIENT_DATA', 'garment-to-garment', null]);
    assert.deepStrictEqual(d.dimensions.filter((x) => x.status === 'incompatible-method').map((x) => x.dim).sort(), ['bodyLength', 'sleeveLength']);
    /* the engine alone says the same, and offers no body-based size */
    const r = engine.recommend(p, uq);
    assert.deepStrictEqual([r.status, r.missing[0].code], ['insufficient', 'too-few-dimensions']);
    /* without the reference, the same chest is still sized from the body, as before */
    const chestOnly = decision.decide(withChest(Object.assign(Schema.empty(), { garments: { hoodies: Object.assign(Schema.emptyGarment('hoodies'), { line: 'men', fitGoal: 'true-to-size' }) } }), 40), uq);
    assert.deepStrictEqual([chestOnly.outcome, chestOnly.size, chestOnly.comparison], ['OK', 'M', 'body-plus-assumed-room']);
  }));

  await test('a reference beside a body-only chart is INSUFFICIENT_DATA "body-vs-garment", even with a chest measurement; the chest alone is still sized by the chart', () => {
    const nike = sizing.byId(NIKE);
    const p = withChest(measuredRef('hoodies', { chestWidth: 23.5, bodyLength: 28, sleeveLength: 24, shoulderWidth: 19 }, 'in'), 39);
    const d = decision.decide(p, nike);
    assert.deepStrictEqual([d.outcome, codes(d)], ['INSUFFICIENT_DATA', ['body-vs-garment']]);
    assert.ok(d.dimensions.every((x) => x.status === 'body-vs-garment'));
    const chestOnly = decision.decide(withChest(Object.assign(Schema.empty(), { garments: { hoodies: Object.assign(Schema.emptyGarment('hoodies'), { line: 'men', fitGoal: 'true-to-size' }) } }), 39), nike);
    assert.deepStrictEqual([chestOnly.outcome, chestOnly.size, chestOnly.comparison], ['OK', 'M', 'body-to-body-chart']);
  });

  /* ---------- per-dimension statuses ---------- */

  await test('each dimension\'s status, from real records and in-memory copies: every status the decision can give, with its own words', () => {
    const z = verified(ZARA);
    const m = rowOf(z, 'M');
    const dimsOf = (p, record) => Object.fromEntries(decision.decide(p, record).dimensions.map((x) => [x.dim, x]));
    const seen = new Set();
    const expect = (got, dim, status) => { assert.strictEqual(got[dim].status, status, `${dim}: ${got[dim].status}`); seen.add(status); };
    /* the same methods throughout: compatible, chest required */
    const same = dimsOf(measuredRef('hoodies', m, z.units), z);
    DIMS.forEach((d) => expect(same, d, 'compatible'));
    assert.deepStrictEqual(DIMS.map((d) => same[d].required), DIMS.map((d) => d === 'chestWidth'));
    /* the product's chest all the way around: estimated, by the stated factor */
    const around = copy(z);
    around.charts.garment.dimensions.chestWidth.method = 'garment-circumference';
    delete around.charts.garment.dimensions.chestWidth.derivedCircumference;
    z.sizes.forEach((s) => { around.charts.garment.sizes[s].chestWidth.value *= 2; });
    expect(dimsOf(measuredRef('hoodies', m, z.units), around), 'chestWidth', 'convertible-estimated');
    /* the product's sleeve from the centre back, its length not stated, its shoulders unchecked or unpublished */
    const odd = copy(z);
    odd.charts.garment.dimensions.sleeveLength.method = 'center-back-to-cuff';
    odd.charts.garment.dimensions.bodyLength.method = 'not-stated';
    odd.charts.garment.dimensions.shoulderWidth.status = 'unverified';
    const oddDims = dimsOf(measuredRef('hoodies', m, z.units), odd);
    expect(oddDims, 'sleeveLength', 'incompatible-method');
    expect(oddDims, 'bodyLength', 'method-not-stated');
    expect(oddDims, 'shoulderWidth', 'unverified');
    const noShoulders = copy(z);
    delete noShoulders.charts.garment.dimensions.shoulderWidth;
    z.sizes.forEach((s) => { delete noShoulders.charts.garment.sizes[s].shoulderWidth; });
    expect(dimsOf(measuredRef('hoodies', m, z.units), noShoulders), 'shoulderWidth', 'missing-target');
    /* the reference's own gap */
    expect(dimsOf(measuredRef('hoodies', Object.assign({}, m, { sleeveLength: null }), z.units), z), 'sleeveLength', 'missing-reference');
    /* a body chart: never a garment */
    expect(dimsOf(measuredRef('hoodies', m, z.units), sizing.byId(NIKE)), 'chestWidth', 'body-vs-garment');
    assert.deepStrictEqual([...seen].sort(), [...decision.DIMENSION_STATUSES].sort(), 'every status is reachable');
    /* each says why in a shopper's words */
    decision.DIMENSION_STATUSES.forEach((status) => {
      const text = decision.dimensionMessage({ dim: 'sleeveLength', status, reference: { words: 'from the shoulder seam to the cuff' }, target: { words: 'from the centre of the back of the neck to the cuff' } });
      assert.ok(/^Sleeves: /.test(text) && !DEVELOPER.test(text), text);
    });
  });

  /* ---------- unchanged ---------- */

  await test('the requirement is unchanged: three of the four measured the same way, the chest among them', () => {
    const z = verified(ZARA);
    const m = rowOf(z, 'M');
    const decide = (keep) => decision.decide(measuredRef('hoodies', Object.fromEntries(DIMS.map((d) => [d, keep.includes(d) ? m[d] : null])), z.units), z);
    assert.strictEqual(decide(DIMS).outcome, 'OK');
    assert.strictEqual(decide(['chestWidth', 'bodyLength', 'shoulderWidth']).outcome, 'OK');
    const noChest = decide(['bodyLength', 'shoulderWidth', 'sleeveLength']);
    assert.strictEqual(noChest.outcome, 'INSUFFICIENT_DATA');
    assert.ok(noChest.reasons.some((r) => r.code === 'missing-required-measurement' && r.dim === 'chestWidth'));
    assert.strictEqual(decide(['chestWidth', 'bodyLength']).outcome, 'INSUFFICIENT_DATA');
    assert.strictEqual(decision.requirementsFor('hoodies')['reference-garment'].minimumCompared, 3);
  });

  await test('a compatible reference ranks exactly as before: each Zara hoodie and tee, measured as each of its sizes, comes back that size — OK, garment to garment', () => {
    ALL_ZARA.map(verified).forEach((record) => record.sizes.forEach((size) => {
      const p = measuredRef(record.category, rowOf(record, size), record.units);
      const c = engine.compare(p, record);
      assert.deepStrictEqual([c.status, c.recommended], ['ok', size], `${record.id} ${size}`);
      const r = engine.recommend(p, record);
      assert.deepStrictEqual([r.method, r.leading], ['reference-garment', size], `${record.id} ${size}`);
      const d = decision.decide(p, record);
      assert.deepStrictEqual([d.outcome, d.size], ['OK', size], `${record.id} ${size}`);
    }));
  });

  out(`\n${passed} passed, ${failures.length} failed\n\n`);
  process.exit(failures.length ? 1 : 0);
})();
