#!/usr/bin/env node
/* =========================================================
   Fynd — size engine evaluation

   Runs api/_sizing/engine.js over scripts/fixtures/size-eval.json: a
   small set of shoppers and products whose expected outcomes were
   worked out by hand from the published charts, each with its reason.

     node scripts/test-size-eval.js

   For every case it checks the status, the leading size, the
   alternative, the confidence and, for an insufficient answer, what was
   missing; then it reports:

     leading       the leading size is one the case expects
     top two       every size the case accepts is the leading size or the
                   alternative (reported, not required). A case's accepted
                   sizes (leadingAnyOf) are listed smallest first, not in
                   order of preference, so no one of them is "the" expected
                   size; a miss means an accepted size was not offered,
                   and the cases that miss are named
     insufficient  "not enough data" comes back exactly when expected
     confidence    the label is one the case allows

   Then the fixture's perSize cases: for chosen sizes, the class each
   dimension must get (too tight … too loose), or that it must get none,
   worked out by hand from the same published numbers. Every "ok" answer
   in either set is also held to fitBySize's rules (checkFitBySize).

   Every case must pass. The expectations are reasoned, not observed:
   they check the engine does what its documented method says with real
   published data. Whether that method is right for real shoppers is a
   question only fit feedback can answer.

   Some of these records are verified and some are pending review (the
   UNIQLO pair: see their review.needs). This suite is the evaluation
   the engine allows to read unverified data, so it asks with
   includeUnverified and holds every answer to say which it rests on
   (dataStatus, and each class's measurements). For every case on a
   record that isn't verified it also asks exactly as the endpoint
   does, and that answer must be "insufficient: unverified-data". And
   it checks the gate on every case: with each record marked
   unverified, every answer is "insufficient". A case on a verified
   product is asked exactly as the endpoint asks.
   ========================================================= */

'use strict';

const assert = require('assert');
const path = require('path');

const Schema = require('../assets/fit-profile-schema.js');
const engine = require('../api/_sizing/engine');
const sizing = require('../api/_sizing/records');
const fixture = require(path.join(__dirname, 'fixtures', 'size-eval.json'));
const sizingSchema = require('../api/_sizing/schema');
/* the evaluation's own way of asking: unverified data allowed, and said */
const EVAL = { includeUnverified: true };

/* A full profile from a case's short form. */
function profileOf(c) {
  const p = Schema.empty();
  const spec = c.profile || {};
  ['chest', 'waist', 'hip'].forEach((key) => {
    if (typeof spec[key] !== 'number') return;
    p.measurements.unit = spec.unit || 'in';
    p.measurements[key] = spec[key];
  });
  if (spec.brandSizes) p.brandSizes = spec.brandSizes.map((b) => Object.assign({ fit: null }, b));
  if (spec.fitPreferences) p.fitPreferences = spec.fitPreferences;
  const record = sizing.byId(c.product);
  if (spec.garment && record) {
    const entry = Object.assign(Schema.emptyGarment(record.category), spec.garment);
    if (entry.anchor) entry.anchor = Object.assign({ brand: null, size: null }, entry.anchor);
    p.garments[record.category] = entry;
  }
  return p;
}

/* What every per-size answer must hold to, whatever the case: every
   size ranked is assessed, a dimension with no class says why, a body
   chart never gives a class, and an estimate is said to be one. */
function checkFitBySize(result, record, basis) {
  const dims = ['chestWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth'];
  assert.deepStrictEqual(result.fitBySize.map((f) => f.size).sort(), result.ranking.map((r) => r.size).sort(), 'every ranked size is assessed');
  result.fitBySize.forEach((f) => {
    assert.deepStrictEqual(Object.keys(f.dimensions).sort(), dims.slice().sort(), `${f.size}: the four dimensions of a top`);
    dims.forEach((d) => {
      const x = f.dimensions[d];
      if (x.class === null) {
        assert.ok(typeof x.reason === 'string' && x.reason, `${f.size} ${d}: no class, and says why`);
        assert.strictEqual(x.measurements, 'unknown', `${f.size} ${d}: no class rests on unknown measurements`);
      } else {
        /* verified (or unverified, when the record is), or estimated with what was estimated listed — never unknown, never both */
        assert.ok(Array.isArray(x.estimated), `${f.size} ${d}: estimated is a list`);
        assert.strictEqual(x.measurements, x.estimated.length ? 'estimated' : basis, `${f.size} ${d}: ${x.measurements} with ${x.estimated.length} estimates`);
      }
      if (result.fitScale.basis === 'body-chart') assert.strictEqual(x.class, null, `${f.size} ${d}: a body chart gives no class`);
      if (result.fitScale.basis === 'garment-vs-body' && d !== 'chestWidth') assert.strictEqual(x.class, null, `${f.size} ${d}: no body measurement to meet`);
    });
    const chest = f.dimensions.chestWidth;
    if (result.fitScale.basis === 'garment-vs-body' && record.charts.garment.dimensions.chestWidth.method === 'flat-width-armpit-to-armpit') {
      assert.ok(chest.estimated.some((e) => /twice its flat width/.test(e)), `${f.size}: the doubled flat width is an estimate`);
      if (chest.class) assert.strictEqual(chest.measurements, 'estimated', `${f.size}: a doubled flat width is never verified`);
    }
  });
  assert.ok(result.tradeoffs.length >= 1 && result.tradeoffs[0].startsWith(`${result.leading}:`), 'the leading size\'s trade-offs come first');
}

/* what an unestimated class must say it rests on: the product's own
   status. A verified product is asked without includeUnverified, so it
   reads no unverified record; an unverified one makes every class
   unverified. */
const basisOf = (record) => (sizingSchema.isVerified(record) ? 'verified' : 'unverified');

let passed = 0;
const failures = [];
const tally = { leading: [0, 0], topTwo: [0, 0], insufficient: [0, 0], confidence: [0, 0] };
const topTwoMisses = [];
const count = (name, ok) => { tally[name][1] += 1; if (ok) tally[name][0] += 1; };

function check(c) {
  const record = sizing.byId(c.product);
  assert.ok(record, `no record ${c.product}`);
  assert.strictEqual(sizing.problems.length, 0);
  const status = sizingSchema.isVerified(record) ? 'verified' : 'unverified';
  if (status === 'unverified') {
    /* the endpoint's own call: no size from a record nobody has checked */
    const live = engine.recommend(profileOf(c), record);
    assert.strictEqual(live.status, 'insufficient', `${c.product} is unverified, but the endpoint's call gave ${live.status}`);
    assert.strictEqual(live.missing[0].code, 'unverified-data');
    assert.ok(!('leading' in live));
  }
  /* a verified product is asked exactly as the endpoint asks */
  const result = engine.recommend(profileOf(c), record, status === 'verified' ? {} : EVAL);
  const e = c.expect;

  const insufficientOk = (result.status === 'insufficient') === (e.status === 'insufficient');
  count('insufficient', insufficientOk);
  assert.ok(insufficientOk, `status ${result.status}, expected ${e.status}${result.missing ? ` (${result.missing.map((m) => m.code).join(', ')})` : ''}`);

  if (e.status === 'insufficient') {
    const codes = result.missing.map((m) => m.code);
    e.missing.forEach((code) => assert.ok(codes.includes(code), `missing ${codes.join(', ')}, expected ${code}`));
    assert.ok(!('leading' in result), 'an insufficient answer names no size');
    return result;
  }

  const leadingOk = e.leadingAnyOf.includes(result.leading);
  count('leading', leadingOk);
  const offered = [result.leading, result.alternative ? result.alternative.size : null];
  const notOffered = e.leadingAnyOf.filter((size) => !offered.includes(size));
  count('topTwo', notOffered.length === 0);
  if (notOffered.length) topTwoMisses.push(`${c.id}: accepts ${e.leadingAnyOf.join(', ')}; offered ${offered.filter(Boolean).join(', ')}`);
  assert.ok(leadingOk, `leading ${result.leading}, expected one of ${e.leadingAnyOf.join(', ')}`);

  if (e.alternativeAnyOf) {
    const alt = result.alternative ? result.alternative.size : null;
    assert.ok(e.alternativeAnyOf.includes(alt), `alternative ${alt}, expected one of ${e.alternativeAnyOf.map(String).join(', ')}`);
    assert.notStrictEqual(alt, result.leading, 'the alternative is a different size');
  }
  const confOk = e.confidenceAnyOf.includes(result.confidence);
  count('confidence', confOk);
  assert.ok(confOk, `confidence ${result.confidence}, expected one of ${e.confidenceAnyOf.join(', ')}`);
  if (e.method) assert.strictEqual(result.method, e.method);

  /* every answer explains itself, and promises nothing */
  assert.ok(result.reasons.length >= 1, 'reasons are given');
  const words = JSON.stringify([result.reasons, result.caveats]);
  assert.ok(!/will fit|guarantee|perfect fit|exact fit/i.test(words), `promises a fit: ${words}`);
  assert.ok(result.caveats.some((x) => /not a promise of fit/.test(x)), 'says it is a suggestion');
  assert.strictEqual(result.dataStatus, status, `says the data is ${status}`);
  checkFitBySize(result, record, basisOf(record));
  return result;
}

console.log(`\nsize engine evaluation (${fixture.cases.length} cases)\n`);
fixture.cases.forEach((c) => {
  try {
    const r = check(c);
    passed += 1;
    const summary = r.status === 'ok'
      ? `${r.leading}${r.alternative ? ` (or ${r.alternative.size})` : ''}, ${r.confidence}, ${r.method}`
      : `insufficient: ${r.missing.map((m) => m.code).join(', ')}`;
    console.log(`  ok    ${c.id} — ${summary}`);
  } catch (err) {
    failures.push(c.id);
    console.log(`  FAIL  ${c.id}\n        ${err.message}\n        expected because: ${c.rationale}`);
  }
});

/* the gate: without includeUnverified, nothing unverified gives a size */
const unverified = (record) => Object.assign(JSON.parse(JSON.stringify(record)), { verification: { status: 'unverified', checkedBy: null, checkedAt: null } });
try {
  fixture.cases.forEach((c) => {
    const pool = sizing.RECORDS.map(unverified);
    const r = engine.recommend(profileOf(c), pool.find((x) => x.id === c.product), { records: pool });
    assert.strictEqual(r.status, 'insufficient', `${c.id} gave a size from unverified data`);
    assert.strictEqual(r.missing[0].code, 'unverified-data');
  });
  passed += 1;
  console.log('  ok    with the records marked unverified, every case is "insufficient: unverified-data"');
} catch (err) {
  failures.push('unverified gate');
  console.log(`  FAIL  unverified gate\n        ${err.message}`);
}

/* how each size may feel: the hand-worked per-size cases */
console.log(`\nper-size fit classes (${fixture.perSize.length} cases)\n`);
let perSizeChecked = 0;
fixture.perSize.forEach((c) => {
  try {
    const record = sizing.byId(c.product);
    const result = engine.recommend(profileOf(c), record, sizingSchema.isVerified(record) ? {} : EVAL);
    assert.strictEqual(result.status, 'ok', `status ${result.status}`);
    assert.strictEqual(result.fitScale.basis, c.expect.basis);
    checkFitBySize(result, record, basisOf(record));
    Object.entries(c.expect.sizes).forEach(([size, want]) => {
      const got = result.fitBySize.find((f) => f.size === size);
      assert.ok(got, `${size} is assessed`);
      Object.entries(want).forEach(([d, expected]) => {
        if (d === 'chart') { assert.strictEqual(got.dimensions.chestWidth.chart.yourChest, expected, `${size}: your chest ${got.dimensions.chestWidth.chart.yourChest} of the range, expected ${expected}`); return; }
        if (d === 'chartEstimated') { assert.strictEqual(got.dimensions.chestWidth.chart.estimated, expected, `${size}: chart range estimated`); return; }
        const x = got.dimensions[d];
        const said = x.class === null ? null : x.class + (x.couldBe ? `|${x.couldBe}` : '');
        assert.strictEqual(said, expected, `${size} ${d}: ${said}, expected ${expected}`);
        perSizeChecked += 1;
      });
    });
    passed += 1;
    console.log(`  ok    ${c.id} — ${Object.keys(c.expect.sizes).length} sizes`);
  } catch (err) {
    failures.push(c.id);
    console.log(`  FAIL  ${c.id}\n        ${err.message}\n        expected because: ${c.rationale}`);
  }
});

const pct = ([ok, n]) => (n ? `${ok}/${n} (${Math.round((ok / n) * 100)}%)` : 'n/a');
console.log('\nmetrics');
console.log(`  leading size as expected      ${pct(tally.leading)}`);
console.log(`  accepted sizes in the top two ${pct(tally.topTwo)}`);
topTwoMisses.forEach((m) => console.log(`    not all offered — ${m}`));
console.log(`  insufficient exactly when     ${pct(tally.insufficient)}`);
console.log(`  confidence label allowed      ${pct(tally.confidence)}`);
console.log(`  insufficient-data cases       ${fixture.cases.filter((c) => c.expect.status === 'insufficient').length} of ${fixture.cases.length}`);

console.log(`  per-size classes checked      ${perSizeChecked}, across ${fixture.perSize.length} cases`);

/* What this run shows, and what it does not */
const withStretch = sizing.RECORDS.filter((r) => r.material && r.material.stretch).length;
console.log('\nwhat this shows');
console.log('  code correctness              the engine does what its documented method says, on the published data (above)');
console.log('  real-fit accuracy             not measured: 0 real fit outcomes in this set; the bands are uncalibrated hypotheses');
console.log(`  stretch vs non-stretch        not testable: ${withStretch} of ${sizing.RECORDS.length} records state stretch`);
console.log('  bottoms (waist, hip, rise,    not testable: no bottoms records, and the profile has no rise, thigh or inseam');
console.log('    thigh, inseam)');

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
