#!/usr/bin/env node
/* =========================================================
   Fynd — Find Fit with the item entered by hand
   Offline, no key:
     node scripts/test-find-fit-manual.js
   The shopper copies one size's finished-garment measurements from any
   product's own chart; Fynd sets them beside a garment the shopper owns
   with the same engine and decision as everything else.
     the reader      assets/fit-candidate.js: types, labels, numbers
                     above zero, a method for every value, the reference
                     form's own ranges where the method is the form's,
                     nothing filled in — shared by the page and server
     units           one conversion from what was typed, never drifting
     methods         the item's choices are the canonical registry's
     the engine      a hand-entered item is "shopper-entered", never
                     verified: compared, reliability held to medium, said
     the decision    OK, NO_MATCH and INSUFFICIENT_DATA by the existing
                     rules — three comparable with chest, compatible
                     methods only — and nothing a page sends can change it
     the route       POST /api/size-recommendation?compare=1&candidate=1,
                     with this visit's garment or the saved one
     unchanged       Fynd's own records, and unverified ones, as before
   Nothing is written; the store is the in-memory one.
   ========================================================= */

'use strict';

const assert = require('assert');
const Candidate = require('../assets/fit-candidate.js');
const Schema = require('../assets/fit-profile-schema.js');
const engine = require('../api/_sizing/engine');
const decision = require('../api/_sizing/decision');
const methods = require('../api/_sizing/methods');
const sizing = require('../api/_sizing/records');
const { asChecked, UQ_PAIR } = require('./fixtures/as-checked');

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'find-fit-manual-test-secret-of-length';
const endpoint = require('../api/size-recommendation');

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

/* the form's own method for each dimension — how the reference is measured */
const FORM = { chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };
const MINE = { unit: 'cm', chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 };
/* a garment the shopper owns, measured at home, in the fit profile's own shape */
const referenceProfile = (m) => {
  const p = Schema.empty();
  const measurements = Object.assign({}, m || MINE);
  p.garments = { hoodies: Object.assign(Schema.emptyGarment('hoodies'), { favorite: 'perfect', anchor: { brand: null, size: null, measurements, methods: Object.assign({ registry: 1 }, Object.fromEntries(Object.keys(FORM).filter((k) => measurements[k] != null).map((k) => [k, FORM[k]]))) } }) };
  return p;
};
/* the same garment as the page sends it for this visit */
const SENT = { type: 'hoodies', garment: { favorite: 'perfect', anchor: { brand: null, size: null, measurements: { unit: 'cm', chestWidth: '58', bodyLength: '68', shoulderWidth: '50', sleeveLength: '62' } } } };
const item = (m, how, extra) => Object.assign({ type: 'hoodies', brand: 'AnyBrand', name: 'Heavy Hood', size: 'L', unit: 'cm', measurements: m, methods: Object.assign({ registry: 1 }, how || FORM) }, extra || {});
const SAME = { chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 };
const decide = (profile, raw) => {
  const read = Candidate.readCandidate(raw);
  assert.deepStrictEqual(read.errors, []);
  return decision.decide(profile, engine.candidateRecord(read.candidate), { via: 'compare' });
};
const statuses = (d) => Object.fromEntries(d.dimensions.map((x) => [x.dim, x.status]));

/* the real handler, called in this process */
let caller = 0;
const post = (body, opts) => new Promise((resolve) => {
  const o = opts || {};
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p, res: this }); return this; }, end() { return this; } };
  caller += 1;
  endpoint({ method: 'POST', query: Object.assign({ compare: '1', candidate: '1' }, o.query || {}), url: '/api/size-recommendation?compare=1&candidate=1', body,
    headers: Object.assign({ host: 'fynd.test' }, o.headers || {}), socket: { remoteAddress: o.ip || `198.51.100.${caller % 250}` }, on() { return this; } }, res);
});

(async () => {
  out('\nthe reader (assets/fit-candidate.js)\n');

  await test('a whole item reads as given: type, labels cleaned, every value to a hundredth in its own unit, each with its method', () => {
    const r = Candidate.readCandidate(item({ chestWidth: '58.256', bodyLength: '68', shoulderWidth: 50, sleeveLength: ' 62 ' }, null, { brand: '  Any   Brand ', name: 'Heavy\u0000Hood' }));
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.candidate, { type: 'hoodies', brand: 'Any Brand', name: 'Heavy Hood', size: 'L', unit: 'cm', measurements: { chestWidth: 58.26, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 }, methods: Object.assign({ registry: 1 }, FORM) });
  });

  await test('partial measurements: only the values given — a blank stays missing, never filled in, and its method isn’t asked for', () => {
    const r = Candidate.readCandidate(item({ chestWidth: '58', bodyLength: '', shoulderWidth: null }, { chestWidth: FORM.chestWidth }));
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.candidate.measurements, { chestWidth: 58 });
    assert.deepStrictEqual(r.candidate.methods, { registry: 1, chestWidth: FORM.chestWidth });
  });

  await test('invalid input is refused with a message for its own field: negative, zero, words, no method, an unknown method, no unit, no size, no type, nothing at all', () => {
    const field = (raw) => Candidate.readCandidate(raw).errors.map((e) => e.field);
    assert.deepStrictEqual(field(item({ chestWidth: '-3' })), ['measurements.chestWidth']);
    assert.deepStrictEqual(field(item({ chestWidth: 0 })), ['measurements.chestWidth']);
    assert.deepStrictEqual(field(item({ chestWidth: 'fifty' })), ['measurements.chestWidth']);
    assert.deepStrictEqual(field(item({ chestWidth: '1e3' })), ['measurements.chestWidth']);
    assert.deepStrictEqual(field(item({ chestWidth: 58 }, {})), ['methods.chestWidth']);
    assert.deepStrictEqual(field(item({ chestWidth: 58 }, { chestWidth: 'by eye' })), ['methods.chestWidth']);
    assert.deepStrictEqual(field(item({ chestWidth: 58 }, null, { unit: 'mm' })), ['unit']);
    assert.deepStrictEqual(field(item({ chestWidth: 58 }, null, { size: '  ' })), ['size']);
    assert.deepStrictEqual(field(item({ chestWidth: 58 }, null, { type: 'jeans' })), ['type']);
    assert.deepStrictEqual(field(item({})), ['measurements']);
    assert.deepStrictEqual(field(null), ['type', 'size', 'measurements']);
    assert.match(Candidate.readCandidate(item({ chestWidth: '-3' })).errors[0].message, /number above zero/);
    assert.match(Candidate.readCandidate(item({ chestWidth: 58 }, {})).errors[0].message, /how the chart measures the chest width — or “The chart doesn’t say”/);
  });

  await test('plausible values: the reference form’s own range where the item uses the form’s method, twice it for a chest all the way around, none invented for any other method', () => {
    const [lo, hi] = Schema.measureRange('hoodies', 'chestWidth', 'cm');
    assert.deepStrictEqual(Candidate.rangeFor('hoodies', 'chestWidth', FORM.chestWidth, 'cm'), [lo, hi]);
    assert.deepStrictEqual(Candidate.rangeFor('hoodies', 'chestWidth', 'garment-circumference', 'cm'), [lo * 2, hi * 2]);
    assert.strictEqual(Candidate.rangeFor('hoodies', 'sleeveLength', 'center-back-to-cuff', 'in'), null);
    /* a flat chest past the form's range: refused, with the likely mix-up said */
    const wide = Candidate.readCandidate(item({ chestWidth: hi + 10 }));
    assert.deepStrictEqual(wide.errors.map((e) => e.field), ['measurements.chestWidth']);
    assert.match(wide.errors[0].message, /If the chart gives the chest all the way around, choose that method\./);
    /* the same number, said to be all the way around: in range */
    assert.deepStrictEqual(Candidate.readCandidate(item({ chestWidth: hi + 10 }, { chestWidth: 'garment-circumference' })).errors, []);
    /* UNIQLO's centre-back sleeve (34 ¾ in) is past the form's shoulder-seam range, and is no error: it's another measurement */
    assert.deepStrictEqual(Candidate.readCandidate(item({ chestWidth: 22.25, sleeveLength: 34.75 }, { chestWidth: FORM.chestWidth, sleeveLength: 'center-back-to-cuff' }, { unit: 'in' })).errors, []);
  });

  await test('the methods offered are exactly the canonical registry’s, for every dimension, in its own ids', () => {
    assert.deepStrictEqual(Candidate.DIMS.slice().sort(), methods.DIMENSIONS.slice().sort());
    Candidate.DIMS.forEach((d) => assert.deepStrictEqual(Candidate.METHODS[d].map((m) => m.id).sort(), methods.methodsOf(d).slice().sort(), d));
    assert.strictEqual(Candidate.REGISTRY, methods.REGISTRY_VERSION);
    assert.strictEqual(Candidate.NOT_STATED, methods.NOT_STATED);
  });

  out('\nunits\n');

  await test('unit conversion: centimetres to a tenth, inches to a hundredth; quarter inches kept; converting from what was typed never drifts', () => {
    assert.strictEqual(Candidate.convertValue(22.5, 'in', 'cm'), 57.2);
    assert.strictEqual(Candidate.convertValue(56, 'cm', 'in'), 22.05);
    assert.strictEqual(Candidate.convertValue(21.25, 'in', 'in'), 21.25);
    assert.strictEqual(Candidate.convertValue(25.4, 'cm', 'in'), 10);
    /* the page converts each time from the typed value, so a hundred switches still show the typed value */
    const typed = { value: 56, unit: 'cm' };
    let shown = 56;
    for (let i = 0; i < 100; i += 1) shown = Candidate.convertValue(typed.value, typed.unit, i % 2 ? 'cm' : 'in');
    assert.strictEqual(shown, 56);
  });

  await test('the same garment in inches and in centimetres reads the same against a reference in centimetres: OK, the same size, the same dimensions', () => {
    const cm = decide(referenceProfile(), item(SAME));
    const inch = decide(referenceProfile(), item(Object.fromEntries(Object.entries(SAME).map(([k, v]) => [k, Candidate.convertValue(v, 'cm', 'in')])), null, { unit: 'in' }));
    assert.deepStrictEqual([cm.outcome, cm.size], ['OK', 'L']);
    assert.deepStrictEqual([inch.outcome, inch.size], ['OK', 'L']);
    assert.deepStrictEqual(statuses(inch), statuses(cm));
  });

  out('\nthe engine and the decision, by the existing rules\n');

  await test('a hand-entered item is "shopper-entered", never verified: compared, its reliability held to medium as a home-measured reference is, and said', () => {
    const rec = engine.candidateRecord(Candidate.readCandidate(item(SAME)).candidate);
    assert.strictEqual(rec.verification.status, 'shopper-entered');
    assert.strictEqual(require('../api/_sizing/schema').isVerified(rec), false);
    assert.ok(require('../api/_sizing/schema').validate(rec).length > 0, 'not a sizing record: the catalogue schema still refuses it');
    const c = engine.compare(referenceProfile(), rec);
    assert.deepStrictEqual([c.status, c.recommended, c.reliability, c.dataStatus], ['ok', 'L', 'medium', 'shopper-entered']);
    assert.ok(c.caveats.includes('The item\'s measurements are the ones you entered from its chart; Fynd hasn\'t checked them against the brand.'));
    const d = decision.decide(referenceProfile(), rec, { via: 'compare' });
    assert.deepStrictEqual([d.outcome, d.size, d.confidence, d.comparison], ['OK', 'L', 'medium', 'garment-to-garment']);
    assert.ok(d.qualifiers.some((q) => q.code === 'target-entered-by-shopper'));
    assert.ok(d.dimensions.every((x) => x.target.status === 'shopper-entered'));
  });

  await test('partial measurements: three comparable with chest is OK; two, or three without chest, is INSUFFICIENT_DATA — the existing rule, unchanged', () => {
    const three = decide(referenceProfile(), item({ chestWidth: 58, bodyLength: 68, shoulderWidth: 50 }, { chestWidth: FORM.chestWidth, bodyLength: FORM.bodyLength, shoulderWidth: FORM.shoulderWidth }));
    assert.deepStrictEqual([three.outcome, three.size], ['OK', 'L']);
    assert.strictEqual(statuses(three).sleeveLength, 'missing-target');
    assert.match(three.dimensions.find((x) => x.dim === 'sleeveLength').message, /^Sleeves: not entered for this item, so it isn’t compared\.$/);
    const two = decide(referenceProfile(), item({ chestWidth: 58, bodyLength: 68 }, { chestWidth: FORM.chestWidth, bodyLength: FORM.bodyLength }));
    assert.deepStrictEqual([two.outcome, two.size, two.closest], ['INSUFFICIENT_DATA', null, null]);
    assert.deepStrictEqual(two.messages, ['Fynd needs at least three measurements taken the same way on both garments, including the chest, to compare them. Enter more from the product’s chart.']);
    const noChest = decide(referenceProfile(), item({ bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 }, { bodyLength: FORM.bodyLength, shoulderWidth: FORM.shoulderWidth, sleeveLength: FORM.sleeveLength }));
    assert.deepStrictEqual([noChest.outcome, noChest.size], ['INSUFFICIENT_DATA', null]);
    assert.ok(noChest.messages.includes('Every comparison needs the chest width. Enter it from the product’s chart, if the chart gives it.'));
  });

  await test('incompatible methods are never compared: a centre-back sleeve and length beside the form’s are not the same measurement — said so, and too few left', () => {
    const d = decide(referenceProfile(), item({ chestWidth: 58, bodyLength: 75, shoulderWidth: 50, sleeveLength: 86 }, Object.assign({}, FORM, { bodyLength: 'center-back-to-hem', sleeveLength: 'center-back-to-cuff' })));
    assert.deepStrictEqual(statuses(d), { chestWidth: 'compatible', bodyLength: 'incompatible-method', shoulderWidth: 'compatible', sleeveLength: 'incompatible-method' });
    assert.deepStrictEqual([d.outcome, d.size], ['INSUFFICIENT_DATA', null]);
    assert.match(d.dimensions.find((x) => x.dim === 'sleeveLength').message, /from the shoulder seam to the cuff on your garment and from the centre of the back of the neck to the cuff on this one — not the same measurement, so not compared\./);
    assert.ok(d.messages.some((m) => /can’t be compared reliably/.test(m)), d.messages.join(' | '));
    /* one incompatible, three compatible with chest: still enough */
    const one = decide(referenceProfile(), item({ chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 86 }, Object.assign({}, FORM, { sleeveLength: 'center-back-to-cuff' })));
    assert.deepStrictEqual([one.outcome, one.size, statuses(one).sleeveLength], ['OK', 'L', 'incompatible-method']);
  });

  await test('a method the chart doesn’t state is never compared, not even with another unstated one: the chest unstated is INSUFFICIENT_DATA, said to be unreliable', () => {
    const d = decide(referenceProfile(), item(SAME, Object.assign({}, FORM, { chestWidth: 'not-stated' })));
    assert.deepStrictEqual([d.outcome, d.size, statuses(d).chestWidth], ['INSUFFICIENT_DATA', null, 'method-not-stated']);
    assert.match(d.dimensions.find((x) => x.dim === 'chestWidth').message, /isn’t said how it was measured, so it can’t be compared reliably/);
  });

  await test('a chest all the way around compares with a flat one only by the stated rule, as an estimate', () => {
    const d = decide(referenceProfile(), item(Object.assign({}, SAME, { chestWidth: 116 }), Object.assign({}, FORM, { chestWidth: 'garment-circumference' })));
    assert.deepStrictEqual([d.outcome, d.size, statuses(d).chestWidth], ['OK', 'L', 'convertible-estimated']);
    assert.ok(d.qualifiers.some((q) => q.code === 'estimated-conversion'));
  });

  await test('NO_MATCH by the existing chest rule: the one size entered, 8 cm wider flat, doesn’t meet the criteria — never recommended, never called "the closest"', () => {
    const d = decide(referenceProfile(), item(Object.assign({}, SAME, { chestWidth: 66 })));
    assert.deepStrictEqual([d.outcome, d.size, d.closest, d.reasons.map((r) => r.code)], ['NO_MATCH', null, 'L', ['chest-outside-acceptable-range']]);
    /* one size entered: said to fail the comparison — never "the closest" of sizes the shopper didn't enter */
    assert.deepStrictEqual(d.messages, ['Size L would be much roomier through the chest than your garment — more than Fynd’s comparison allows — so it isn’t recommended.']);
    assert.ok(!/closest/i.test(d.messages.join(' ')));
    /* and an OK one says it meets the criteria, never "the closest" */
    const ok = engine.compare(referenceProfile(), engine.candidateRecord(Candidate.readCandidate(item(SAME)).candidate));
    assert.strictEqual(ok.summary, 'Size L meets Fynd’s comparison criteria against your reference on chest, length, shoulders and sleeves.');
  });

  await test('with no garment of the shopper’s, INSUFFICIENT_DATA — and the words say to add one', () => {
    const d = decide(null, item(SAME));
    assert.deepStrictEqual([d.outcome, d.size], ['INSUFFICIENT_DATA', null]);
    assert.deepStrictEqual(d.messages, ['Add the garment you own that fits well, with its measurements, so Fynd has something to compare this item with.']);
  });

  await test('scoring unchanged: the same answer as a checked catalogue record with the same numbers — only the reliability cap and its caveat differ', () => asChecked(['zara-00761810-basic-heavyweight-hoodie-us'], () => {
    const zara = sizing.byId('zara-00761810-basic-heavyweight-hoodie-us');
    const m = zara.charts.garment.sizes.M;
    const numbers = Object.fromEntries(Object.keys(FORM).map((k) => [k, m[k].value]));
    const profile = referenceProfile(Object.assign({ unit: 'cm' }, numbers, { chestWidth: numbers.chestWidth + 1 }));
    const fromRecord = engine.compare(profile, zara).sizes.find((s) => s.size === 'M');
    const byHand = engine.compare(profile, engine.candidateRecord(Candidate.readCandidate(item(numbers, null, { size: 'M' })).candidate)).sizes[0];
    assert.deepStrictEqual(Object.fromEntries(Object.entries(byHand.dimensions).map(([k, x]) => [k, [x.difference, x.withinTolerance, x.tolerance]])),
      Object.fromEntries(Object.entries(fromRecord.dimensions).map(([k, x]) => [k, [x.difference, x.withinTolerance, x.tolerance]])));
    assert.strictEqual(byHand.score, fromRecord.score, 'the same score, by the same weights and tolerances');
  }));

  await test('Fynd’s own records are unchanged: an unverified one is still refused, a hand-entered shape never passes as a record, and nothing a page sends makes an item verified', () => {
    const record = sizing.byId('uniqlo-e475378-sweat-pullover-hoodie-us');
    assert.strictEqual(decision.decide(referenceProfile(), record, { via: 'compare' }).reasons[0].code, 'unverified-data');
    /* a shape claiming to be shopper-entered but not candidateRecord's: no record */
    const forged = Object.assign(JSON.parse(JSON.stringify(record)), { verification: { status: 'shopper-entered' } });
    assert.strictEqual(decision.decide(referenceProfile(), forged, { via: 'compare' }).reasons[0].code, 'no-record');
    /* extra fields sent with an item are dropped by the reader */
    const r = Candidate.readCandidate(Object.assign(item(SAME), { verification: { status: 'verified' }, id: 'uniqlo-e475378-sweat-pullover-hoodie-us' }));
    assert.deepStrictEqual(Object.keys(r.candidate).sort(), ['brand', 'measurements', 'methods', 'name', 'size', 'type', 'unit']);
    assert.strictEqual(engine.candidateRecord(r.candidate).verification.status, 'shopper-entered');
  });

  out('\ntrust: what the client can’t set\n');

  await test('unknown methods and “The chart doesn’t say” never become comparable — not past the reader, not past the record, not even beside another unstated one', () => {
    /* the reader refuses an id the registry doesn't know, for every dimension */
    Candidate.DIMS.forEach((d) => {
      const r = Candidate.readCandidate(item({ [d]: 50 }, { [d]: 'flat-ish' }));
      assert.deepStrictEqual(r.errors.map((e) => e.field), [`methods.${d}`], d);
    });
    /* a candidate built around the reader: an unknown id, or another registry's, is "not stated" in the record */
    const bypass = engine.candidateRecord({ type: 'hoodies', size: 'L', unit: 'cm', measurements: SAME, methods: { registry: 1, chestWidth: 'by-eye', bodyLength: FORM.bodyLength, shoulderWidth: FORM.shoulderWidth, sleeveLength: FORM.sleeveLength } });
    assert.strictEqual(bypass.charts.garment.dimensions.chestWidth.method, 'not-stated');
    const otherRegistry = engine.candidateRecord({ type: 'hoodies', size: 'L', unit: 'cm', measurements: SAME, methods: Object.assign({ registry: 99 }, FORM) });
    assert.ok(Object.values(otherRegistry.charts.garment.dimensions).every((x) => x.method === 'not-stated'), 'a registry Fynd doesn’t know names nothing');
    assert.deepStrictEqual([decision.decide(referenceProfile(), otherRegistry, { via: 'compare' }).outcome], ['INSUFFICIENT_DATA']);
    /* every measurement "the chart doesn't say": nothing comparable */
    const silent = decide(referenceProfile(), item(SAME, { chestWidth: 'not-stated', bodyLength: 'not-stated', shoulderWidth: 'not-stated', sleeveLength: 'not-stated' }));
    assert.deepStrictEqual([silent.outcome, silent.size], ['INSUFFICIENT_DATA', null]);
    assert.ok(silent.dimensions.every((x) => x.status === 'method-not-stated'), JSON.stringify(silent.dimensions.map((x) => x.status)));
    /* unstated beside unstated: still never compared */
    const unstatedRef = referenceProfile();
    unstatedRef.garments.hoodies.anchor.methods = { registry: 1, chestWidth: 'not-stated', bodyLength: 'not-stated', shoulderWidth: 'not-stated', sleeveLength: 'not-stated' };
    const both = decide(unstatedRef, item(SAME, { chestWidth: 'not-stated', bodyLength: 'not-stated', shoulderWidth: 'not-stated', sleeveLength: 'not-stated' }));
    assert.deepStrictEqual([both.outcome, both.size], ['INSUFFICIENT_DATA', null]);
    assert.ok(both.dimensions.every((x) => x.status === 'method-not-stated'));
    Candidate.DIMS.forEach((d) => assert.strictEqual(methods.relation(d, 'not-stated', 'not-stated'), null, d));
  });

  await test('the server assigns "shopper-entered" itself: verification, authorization, source and record fields sent with the item — or in place of its numbers — are never read', async () => {
    const forged = Object.assign(item(SAME), {
      verification: { status: 'verified', checkedBy: 'Fynd', checkedAt: '2026-10-01' },
      authorization: { merchant: 'uniqlo-us', grantedAt: '2026-01-01', scope: ['sizes', 'measurements'] },
      capture: { how: 'server-read', at: '2026-10-01', by: 'Fynd' },
      charts: { garment: { dimensions: {}, sizes: {} } },
      sources: [{ url: 'https://www.uniqlo.com/us/en/products/E475378-000/00' }],
      id: 'uniqlo-e475378-sweat-pullover-hoodie-us',
      origin: 'official-published',
      dataStatus: 'verified',
      methods: Object.assign({ registry: 99 }, FORM)
    });
    const got = await post({ candidate: forged, reference: SENT, verification: { status: 'verified' }, record: sizing.byId('uniqlo-e475378-sweat-pullover-hoodie-us') },
      { query: { product: 'uniqlo-e475378-sweat-pullover-hoodie-us' } });
    assert.strictEqual(got.status, 200);
    const { comparison, decision: d, candidate } = got.body;
    assert.deepStrictEqual(Object.keys(candidate).sort(), ['brand', 'measurements', 'methods', 'name', 'size', 'type', 'unit'], 'only the item’s own fields read');
    assert.strictEqual(candidate.methods.registry, 1, 'the registry version is the server’s, never the client’s');
    assert.deepStrictEqual([comparison.dataStatus, comparison.productId, comparison.reliability], ['shopper-entered', 'your-candidate', 'medium'], 'the hand-entered item, never the record named in the body or the address');
    assert.ok(d.dimensions.every((x) => x.target.status === 'shopper-entered'), 'every measurement the shopper’s, never "verified"');
    assert.ok(d.qualifiers.some((q) => q.code === 'target-entered-by-shopper'));
    /* numbers sent as objects carrying flags are no numbers at all */
    const flagged = await post({ candidate: item({ chestWidth: { value: 58, verified: true } }), reference: SENT });
    assert.deepStrictEqual([flagged.status, flagged.body.errors.map((e) => e.field)], [400, ['measurements.chestWidth']]);
    /* and the garment sent for the visit can't carry methods or flags of its own */
    const ref = JSON.parse(JSON.stringify(SENT));
    Object.assign(ref.garment.anchor, { verified: true, methods: { registry: 1, chestWidth: 'garment-circumference' }, verification: { status: 'verified' } });
    const withRef = (await post({ candidate: item(SAME), reference: ref })).body;
    assert.strictEqual(withRef.decision.dimensions.find((x) => x.dim === 'chestWidth').reference.method, FORM.chestWidth, 'the form’s method, not the one sent');
    assert.ok(withRef.decision.dimensions.every((x) => x.reference.status === 'shopper-measured'));
  });

  out('\nthe route: POST /api/size-recommendation?compare=1&candidate=1\n');

  await test('with this visit’s garment: the comparison and the decision, held to it — OK names the size in every field; the item read back as the server read it; nothing cached', async () => {
    const got = await post({ candidate: item(SAME), reference: SENT });
    assert.strictEqual(got.status, 200);
    assert.strictEqual(got.res.getHeader('cache-control'), 'no-store, private');
    const { comparison, decision: d, resultType, candidate } = got.body;
    assert.deepStrictEqual([d.outcome, d.size, comparison.recommended, resultType, comparison.dataStatus], ['OK', 'L', 'L', 'garment-comparison', 'shopper-entered']);
    assert.deepStrictEqual(candidate.measurements, SAME);
    assert.deepStrictEqual(comparison.sizes.map((s) => s.size), ['L']);
  });

  await test('INSUFFICIENT_DATA and NO_MATCH through the route: no field names a size the decision didn’t give', async () => {
    const few = (await post({ candidate: item({ chestWidth: 58, bodyLength: 68 }, { chestWidth: FORM.chestWidth, bodyLength: FORM.bodyLength }), reference: SENT })).body;
    assert.deepStrictEqual([few.decision.outcome, few.decision.size, few.comparison.status], ['INSUFFICIENT_DATA', null, 'insufficient']);
    assert.ok(!few.comparison.recommended);
    const wide = (await post({ candidate: item(Object.assign({}, SAME, { chestWidth: 66 })), reference: SENT })).body;
    assert.deepStrictEqual([wide.decision.outcome, wide.decision.size, wide.decision.closest, wide.comparison.recommended, wide.comparison.closest, wide.comparison.withheld], ['NO_MATCH', null, 'L', null, 'L', 'decision']);
  });

  await test('an item that doesn’t read is refused whole with every field’s message; a garment that doesn’t read, too — nothing compared', async () => {
    const bad = await post({ candidate: item({ chestWidth: '-1', bodyLength: 'x' }), reference: SENT });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.reason, 'invalid-candidate');
    assert.deepStrictEqual(bad.body.errors.map((e) => e.field), ['measurements.chestWidth', 'measurements.bodyLength']);
    assert.ok(!('decision' in bad.body));
    const noItem = await post({ reference: SENT });
    assert.deepStrictEqual([noItem.status, noItem.body.reason], [400, 'invalid-candidate']);
    const badRef = await post({ candidate: item(SAME), reference: { type: 'jeans', garment: {} } });
    assert.deepStrictEqual([badRef.status, badRef.body.reason], [400, 'invalid-reference']);
  });

  await test('signed out with no garment sent: INSUFFICIENT_DATA, the way to add one — never a size from the item alone', async () => {
    const got = (await post({ candidate: item(SAME) })).body;
    assert.deepStrictEqual([got.decision.outcome, got.decision.size], ['INSUFFICIENT_DATA', null]);
    assert.match(got.decision.messages[0], /^Add the garment you own that fits well/);
  });

  await test('only POST with compare=1 compares; a burst from one address is slowed like any comparison', async () => {
    const wrong = await post({ candidate: item(SAME), reference: SENT }, { query: { compare: '0' } });
    assert.strictEqual(wrong.status, 405);
    let last = null;
    for (let i = 0; i < 80 && (!last || last.status !== 429); i += 1) last = await post({ candidate: item(SAME), reference: SENT }, { ip: '203.0.113.99' });
    assert.strictEqual(last.status, 429);
    assert.strictEqual(last.body.reason, 'rate-limited');
  });

  out(`\n${passed} passed, ${failures.length} failed\n\n`);
  process.exit(failures.length ? 1 : 0);
})();
