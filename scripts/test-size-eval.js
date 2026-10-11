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
     top two       the case's first expected size is the leading size or
                   the alternative (reported, not required: a case that
                   accepts two sizes may get the other one)
     insufficient  "not enough data" comes back exactly when expected
     confidence    the label is one the case allows

   Every case must pass. The expectations are reasoned, not observed:
   they check the engine does what its documented method says with real
   published data. Whether that method is right for real shoppers is a
   question only fit feedback can answer.

   The records are unverified, so this suite asks the engine for
   includeUnverified; it also checks that without it every answer is
   "insufficient".
   ========================================================= */

'use strict';

const assert = require('assert');
const path = require('path');

const Schema = require('../assets/fit-profile-schema.js');
const engine = require('../api/_sizing/engine');
const sizing = require('../api/_sizing/records');
const fixture = require(path.join(__dirname, 'fixtures', 'size-eval.json'));

/* A full profile from a case's short form. */
function profileOf(c) {
  const p = Schema.empty();
  const spec = c.profile || {};
  if (typeof spec.chest === 'number') {
    p.measurements.unit = spec.unit || 'in';
    p.measurements.chest = spec.chest;
  }
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

let passed = 0;
const failures = [];
const tally = { leading: [0, 0], topTwo: [0, 0], insufficient: [0, 0], confidence: [0, 0] };
const count = (name, ok) => { tally[name][1] += 1; if (ok) tally[name][0] += 1; };

function check(c) {
  const record = sizing.byId(c.product);
  assert.ok(record, `no record ${c.product}`);
  const result = engine.recommend(profileOf(c), record, { includeUnverified: true });
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
  const expectedPrimary = e.leadingAnyOf[0];
  count('topTwo', result.leading === expectedPrimary || Boolean(result.alternative && result.alternative.size === expectedPrimary));
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
  assert.strictEqual(result.dataStatus, 'unverified', 'says the data is unverified');
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
try {
  fixture.cases.forEach((c) => {
    const r = engine.recommend(profileOf(c), sizing.byId(c.product));
    assert.strictEqual(r.status, 'insufficient', `${c.id} gave a size from unverified data`);
    assert.strictEqual(r.missing[0].code, 'unverified-data');
  });
  passed += 1;
  console.log('  ok    without includeUnverified, every case is "insufficient: unverified-data"');
} catch (err) {
  failures.push('unverified gate');
  console.log(`  FAIL  unverified gate\n        ${err.message}`);
}

const pct = ([ok, n]) => (n ? `${ok}/${n} (${Math.round((ok / n) * 100)}%)` : 'n/a');
console.log('\nmetrics');
console.log(`  leading size as expected     ${pct(tally.leading)}`);
console.log(`  expected size in the top two ${pct(tally.topTwo)}`);
console.log(`  insufficient exactly when    ${pct(tally.insufficient)}`);
console.log(`  confidence label allowed     ${pct(tally.confidence)}`);
console.log(`  insufficient-data cases      ${fixture.cases.filter((c) => c.expect.status === 'insufficient').length} of ${fixture.cases.length}`);

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
