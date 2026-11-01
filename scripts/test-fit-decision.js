#!/usr/bin/env node
/* =========================================================
   Fynd — the fit decision policy (api/_sizing/decision.js)
   Offline, no key:
     node scripts/test-fit-decision.js

   decide(profile, target) is the one place a size is decided: the
   engine's compare() and recommend() answer, unchanged in their
   mathematics, and the policy holds both to one contract — OK,
   INSUFFICIENT_DATA or NO_MATCH, with machine-readable reason codes.

   The regression cases are the sizing audit's own, on the live records:
     Nike Club Pullover Fleece Hoodie (verified, body chart only):
       chest 24.5 in and 66 in, beyond its XXS (28.5–31.5) and 4XL
       (58–63), used to come back "ok" at medium confidence
     Zara Basic Relaxed Fit Hoodie (garment chart, all four methods
       match a home-measured reference; pending review, so marked
       checked in memory for a test only — scripts/fixtures/as-checked):
       a reference 10 cm narrower through the chest than S came back
       "ok, S"; a size missing its length won the ranking
   Every record used is the live one or an in-memory copy of it; nothing
   is written to disk.
   ========================================================= */

'use strict';

const assert = require('assert');

const Schema = require('../assets/fit-profile-schema.js');
const sizing = require('../api/_sizing/records');
const engine = require('../api/_sizing/engine');
const decision = require('../api/_sizing/decision');
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

const { OK, INSUFFICIENT_DATA, NO_MATCH } = decision.OUTCOMES;
const NIKE = 'nike-fn3859-club-pullover-fleece-hoodie-us';
const ZARA = 'zara-00761350-basic-relaxed-fit-hoodie-us';
const UQ_HOODIE = 'uniqlo-e475378-sweat-pullover-hoodie-us';
const codes = (d) => d.reasons.map((r) => r.code);
const qualifierCodes = (d) => d.qualifiers.map((r) => r.code);
const copy = (record) => JSON.parse(JSON.stringify(record));

/* a body chest, a men's hoodie, true to size */
function chestProfile(chest, unit, extra) {
  return Object.assign(Schema.empty(), {
    measurements: { unit: unit || 'in', height: null, chest, waist: null, hip: null },
    garments: { hoodies: Object.assign({ line: 'men', fitGoal: 'true-to-size' }, extra || {}) }
  });
}
/* a hoodie the shopper owns and measured, laid flat, by the fit
   profile's own methods (fit-profile-schema GARMENT_MEASURES) */
function referenceProfile(measurements, unit, category) {
  return Object.assign(Schema.empty(), {
    garments: { [category || 'hoodies']: { line: 'men', fitGoal: 'true-to-size', favorite: 'perfect', anchor: { brand: 'Zara', size: 'M', measurements: Object.assign({ unit: unit || 'cm' }, measurements) } } }
  });
}
/* one size's published garment measurements, as plain numbers */
const rowOf = (record, size) => Object.fromEntries(Object.entries(record.charts.garment.sizes[size]).map(([k, v]) => [k, v.value]));

/* every decision, whatever it says, is in the contract's shape */
function holdsContract(d) {
  assert.strictEqual(d.contract, decision.CONTRACT);
  assert.ok(Object.values(decision.OUTCOMES).includes(d.outcome), `outcome ${d.outcome}`);
  d.reasons.concat(d.qualifiers).forEach((r) => assert.ok(decision.REASONS[r.code], `unknown reason code ${r.code}`));
  /* a size is named only by OK; a closest size only by NO_MATCH */
  assert.strictEqual(d.size !== null, d.outcome === OK, `size ${d.size} with ${d.outcome}`);
  if (d.outcome !== NO_MATCH) assert.strictEqual(d.closest, null);
  if (d.outcome !== OK) assert.strictEqual(d.confidence, null);
  /* every reason that decides an outcome decides this one; OK has none */
  if (d.outcome === OK) assert.deepStrictEqual(d.reasons, []);
  else {
    assert.ok(d.reasons.length, 'a refusal says why');
    d.reasons.forEach((r) => assert.strictEqual(decision.REASONS[r.code].outcome, d.outcome, `${r.code} under ${d.outcome}`));
  }
  /* qualifiers never decide an outcome */
  d.qualifiers.forEach((r) => assert.strictEqual(decision.REASONS[r.code].outcome, null, `${r.code} is a qualifier`));
}

(async () => {
  out('Fit decision policy\n\n');

  /* ---------- 1. outside the supported size range ---------- */

  await test('1  Nike, chest 24.5 in (XXS is 28.5–31.5): NO_MATCH "outside-size-range", below the smallest — never a recommendation', () => {
    const nike = sizing.byId(NIKE);
    /* the engine alone still ranks a closest size, as it always has */
    assert.strictEqual(engine.recommend(chestProfile(24.5), nike).status, 'ok');
    const d = decision.decide(chestProfile(24.5), nike);
    holdsContract(d);
    assert.strictEqual(d.outcome, NO_MATCH);
    assert.deepStrictEqual(codes(d), ['outside-size-range']);
    assert.strictEqual(d.reasons[0].side, 'below-smallest');
    assert.deepStrictEqual([d.size, d.closest, d.method], [null, 'XXS', 'body-chart']);
  });

  await test('1  Nike, chest 66 in (4XL is 58–63): NO_MATCH, above the largest', () => {
    const d = decision.decide(chestProfile(66), sizing.byId(NIKE));
    holdsContract(d);
    assert.strictEqual(d.outcome, NO_MATCH);
    assert.strictEqual(d.reasons[0].code, 'outside-size-range');
    assert.strictEqual(d.reasons[0].side, 'above-largest');
    assert.strictEqual(d.closest, '4XL');
  });

  await test('1  the same in centimetres: 62 cm (24.4 in) is beyond XXS too', () => {
    const d = decision.decide(chestProfile(62, 'cm'), sizing.byId(NIKE));
    assert.strictEqual(d.outcome, NO_MATCH);
    assert.strictEqual(d.reasons[0].code, 'outside-size-range');
  });

  await test('1  the search listings say "no-match" with no size for the out-of-range shopper, and carry the decision', () => {
    const { fitFor } = require('../api/size-recommendation');
    const nike = sizing.byId(NIKE);
    const fit = fitFor(chestProfile(66), 'hoodies', [{ brand: 'Nike', name: nike.product.name, url: nike.product.url }]);
    assert.strictEqual(fit.items.length, 1);
    const item = fit.items[0];
    assert.deepStrictEqual([item.status, item.size, item.closest], ['no-match', null, '4XL']);
    assert.strictEqual(item.decision.outcome, NO_MATCH);
    assert.ok(item.missing.length && typeof item.missing[0] === 'string');
  });

  /* ---------- 1b. chart eligibility apart from the fit preference ---------- */

  const CARHARTT = 'carhartt-k121-loose-fit-midweight-hoodie-us';

  await test('1b Carhartt (one chest value per size: XS 32, S 36…), chest 30 in, true to size: OK XS at low confidence — the "loose fit" shift no longer rules out the size the chart covers', () => {
    const carhartt = sizing.byId(CARHARTT);
    /* the fit preference scores XS against S's range (34–38), which the shopper doesn't reach */
    const r = engine.recommend(chestProfile(30), carhartt);
    assert.deepStrictEqual([r.status, r.leading, r.evidence.aim.size], ['ok', 'XS', 'S']);
    assert.ok(r.evidence.body.hi < r.evidence.aim.lo, 'the shifted range alone would have refused');
    /* XS's own range — 30–34, estimated as halfway to S and mirrored below — does */
    assert.deepStrictEqual(engine.bodyRange(carhartt, 'XS'), { lo: 30, hi: 34, estimated: true, text: '32' });
    const d = decision.decide(chestProfile(30), carhartt);
    holdsContract(d);
    assert.deepStrictEqual([d.outcome, d.size, d.confidence], [OK, 'XS', 'low']);
    /* the estimate is kept: XS reaches 30 in only through its mirrored half, below the published 32 */
    const est = d.qualifiers.find((q) => q.code === 'estimated-chart-range');
    assert.deepStrictEqual(est, { code: 'estimated-chart-range', sizes: ['XS'], mirroredEdge: { size: 'XS', published: 32, side: 'below' } });
  });

  await test('1b a listing shows the decision\'s confidence: low where the size rests on a mirrored chart edge, even if the engine said more', () => {
    const { fitFor } = require('../api/size-recommendation');
    const carhartt = sizing.byId(CARHARTT);
    const item = { brand: 'Carhartt', name: carhartt.product.name, url: carhartt.product.url };
    /* oversized: no shift for a loose cut, and a confidence the engine leaves at medium */
    const profile = chestProfile(31, 'in', { fitGoal: 'oversized' });
    assert.strictEqual(engine.recommend(profile, carhartt).confidence, 'medium');
    const it = fitFor(profile, 'hoodies', [item]).items[0];
    /* a body estimate, its own result type: the estimated size apart from `size` */
    assert.deepStrictEqual([it.status, it.resultType, it.size, it.estimate, it.reliability, it.decision.confidence], ['estimate', 'body-estimate', null, 'XS', 'low', 'low']);
  });

  await test('1b Carhartt, chest 29 in or 24.5 in: still NO_MATCH — beyond even the estimated XS range', () => {
    [29, 24.5].forEach((c) => {
      const d = decision.decide(chestProfile(c), sizing.byId(CARHARTT));
      holdsContract(d);
      assert.deepStrictEqual([d.outcome, d.closest, codes(d)], [NO_MATCH, 'XS', ['outside-size-range']], String(c));
      assert.deepStrictEqual([d.reasons[0].side, d.reasons[0].chart.estimated], ['below-smallest', true]);
    });
  });

  await test('1b Carhartt, chest 39 in: OK S, the shift reported apart from eligibility — the chart puts them in M, offered as the alternative', () => {
    const d = decision.decide(chestProfile(39), sizing.byId(CARHARTT));
    holdsContract(d);
    assert.deepStrictEqual([d.outcome, d.size, d.alternative], [OK, 'S', 'M']);
    const shift = d.qualifiers.find((q) => q.code === 'fit-preference-shift');
    assert.deepStrictEqual(shift, { code: 'fit-preference-shift', size: 'S', chartSizes: ['M'], fitClass: 'loose', goal: 'true-to-size' });
    /* an interior estimated range is said, without the mirrored-edge cap */
    const est = d.qualifiers.find((q) => q.code === 'estimated-chart-range');
    assert.ok(est && !est.mirroredEdge);
  });

  await test('1b Nike ("Standard fit"), chest 60.5 in, oversized: OK 4XL — a size-up preference with no larger size never eliminates the 4XL the chart covers; 66 in is still NO_MATCH', () => {
    const nike = sizing.byId(NIKE);
    const oversized = (c) => chestProfile(c, 'in', { fitGoal: 'oversized' });
    assert.strictEqual(engine.sizeOffset(nike, 'oversized'), 1);
    /* the shift scores 4XL against 3XL's range (53.5–58), short of 60.5 */
    const r = engine.recommend(oversized(60.5), nike);
    assert.deepStrictEqual([r.leading, r.evidence.aim.size], ['4XL', '3XL']);
    const d = decision.decide(oversized(60.5), nike);
    holdsContract(d);
    assert.deepStrictEqual([d.outcome, d.size], [OK, '4XL']);
    /* published ranges, no estimate to mark */
    assert.ok(!d.qualifiers.some((q) => q.code === 'estimated-chart-range'));
    const beyond = decision.decide(oversized(66), nike);
    assert.deepStrictEqual([beyond.outcome, beyond.closest, codes(beyond)], [NO_MATCH, '4XL', ['outside-size-range']]);
  });

  /* ---------- 1c. what a shopper reads ---------- */

  const DEVELOPER_WORDS = /\b(shopper|engine|policy|reason code|fitBands|tolerance|evidence|record)\b|`/i;

  await test('1c a NO_MATCH listing reads as a shopper\'s sentence, chosen from the reason code: the brand, the size, which side', () => {
    const { fitFor } = require('../api/size-recommendation');
    const nike = sizing.byId(NIKE);
    const item = (c) => fitFor(chestProfile(c), 'hoodies', [{ brand: 'Nike', name: nike.product.name, url: nike.product.url }]).items[0];
    const big = item(66);
    assert.deepStrictEqual(big.missing, ['Your chest measurement is larger than Nike’s largest size (4XL) is made for, so Fynd isn’t suggesting a size for this product.']);
    const small = item(24.5);
    assert.deepStrictEqual(small.missing, ['Your chest measurement is smaller than Nike’s smallest size (XXS) is made for, so Fynd isn’t suggesting a size for this product.']);
    [big, small].forEach((x) => {
      assert.ok(!DEVELOPER_WORDS.test(x.missing[0]), x.missing[0]);
      /* the words follow the code, and the code is there for a page to act on */
      assert.deepStrictEqual(x.missing, decision.customerMessages(x.decision, { brand: 'Nike' }));
      assert.strictEqual(x.decision.reasons[0].code, 'outside-size-range');
    });
  });

  await test('1c each NO_MATCH code has its own customer wording, by its data: roomier or tighter, against a fit or a garment', () => {
    const say = (r) => decision.customerMessage(r, { brand: 'Zara' });
    assert.strictEqual(say({ code: 'chest-outside-acceptable-range', size: 'S', class: 'too-loose' }), 'Even the closest size, size S, would be much roomier through the chest than the fit you asked for, so Fynd isn’t suggesting a size for this product.');
    assert.strictEqual(say({ code: 'chest-outside-acceptable-range', size: 'S', class: 'too-tight' }), 'Even the closest size, size S, would be much tighter through the chest than the fit you asked for, so Fynd isn’t suggesting a size for this product.');
    assert.strictEqual(say({ code: 'chest-outside-acceptable-range', size: 'S', differenceAroundIn: 7.87 }), 'Even the closest size, size S, would be much roomier through the chest than the garment you compared it with, so Fynd isn’t suggesting a size for this product.');
    assert.strictEqual(say({ code: 'chest-outside-acceptable-range', size: 'S', differenceAroundIn: -4 }), 'Even the closest size, size S, would be much tighter through the chest than the garment you compared it with, so Fynd isn’t suggesting a size for this product.');
    assert.ok(/size M/.test(say({ code: 'all-compared-outside-tolerance', size: 'M' })));
    /* every code a decision can carry has a sentence a shopper can read, none of it developer wording */
    Object.keys(decision.REASONS).forEach((code) => {
      const text = say({ code, size: 'M', side: 'below-smallest', class: 'too-loose' });
      assert.ok(typeof text === 'string' && text.length > 20, code);
      assert.ok(!DEVELOPER_WORDS.test(text), `${code}: ${text}`);
    });
  });

  await test('1c the Zara NO_MATCH, through the decision: the message matches its data (10 cm narrower reference: the size is roomier)', () => {
    asChecked([ZARA], () => {
      const zara = sizing.byId(ZARA);
      const S = rowOf(zara, 'S');
      const d = decision.decide(referenceProfile(Object.assign({}, S, { chestWidth: S.chestWidth - 10 })), zara);
      assert.deepStrictEqual(decision.customerMessages(d, { brand: 'Zara' }), ['Even the closest size, size S, would be much roomier through the chest than the garment you compared it with, so Fynd isn’t suggesting a size for this product.']);
    });
  });

  await test('1c an INSUFFICIENT_DATA listing the policy alone found (a conflict) is in a shopper\'s words too', () => {
    const { fitFor } = require('../api/size-recommendation');
    const nike = sizing.byId(NIKE);
    const profile = Object.assign(chestProfile(34), { brandSizes: [{ brand: 'Nike', size: 'XL', category: 'hoodies', fit: 'about-right' }] });
    const it = fitFor(profile, 'hoodies', [{ brand: 'Nike', name: nike.product.name, url: nike.product.url }]).items[0];
    assert.strictEqual(it.status, 'insufficient');
    assert.strictEqual(it.missing[0], 'Your chest measurement and the sizes you said fit you point to different sizes. Check them on your fit profile, and Fynd can suggest a size once they agree.');
    /* the developer's description of the code is never what a shopper reads */
    Object.values(decision.REASONS).forEach((r) => assert.ok(!it.missing.includes(r.about), r.about));
  });

  await test('1  a measurement outside the range Fynd accepts at all (chest 80 in) is INSUFFICIENT_DATA, not a size', () => {
    const d = decision.decide(chestProfile(80), sizing.byId(NIKE));
    holdsContract(d);
    assert.strictEqual(d.outcome, INSUFFICIENT_DATA);
    assert.strictEqual(d.reasons[0].code, 'measurement-out-of-supported-range');
    assert.deepStrictEqual(d.reasons[0].range, Schema.rangeOf('chest', 'in'));
  });

  /* ---------- 2. a missing required measurement never ranks higher ---------- */

  await test('2  Zara: L without its length, reference 8 cm shorter than L — L is left out, never ranked first on less data', () => {
    asChecked([ZARA], () => {
      const zara = copy(sizing.byId(ZARA));
      delete zara.charts.garment.sizes.L.bodyLength;
      const L = rowOf(zara, 'L');
      const lengthL = sizing.byId(ZARA).charts.garment.sizes.L.bodyLength.value;
      const profile = referenceProfile({ chestWidth: L.chestWidth, shoulderWidth: L.shoulderWidth, sleeveLength: L.sleeveLength, bodyLength: lengthL - 8 });
      /* recommend(): L used to win at a score of 0 */
      const r = engine.recommend(profile, zara);
      assert.strictEqual(r.status, 'ok');
      assert.notStrictEqual(r.leading, 'L');
      assert.ok(!r.ranking.some((x) => x.size === 'L'), 'L is not ranked');
      /* compare() already left it unranked; the decision agrees */
      const d = decision.decide(profile, zara);
      holdsContract(d);
      assert.notStrictEqual(d.size, 'L');
      assert.notStrictEqual(d.closest, 'L');
      assert.ok(d.qualifiers.some((q) => q.code === 'sizes-excluded-incomplete' && q.sizes.includes('L')));
    });
  });

  await test('2  every size missing a measurement the chart declares and the reference shares: INSUFFICIENT_DATA "incomplete-size-rows", from both methods', () => {
    asChecked([ZARA], () => {
      const zara = copy(sizing.byId(ZARA));
      zara.sizes.forEach((s) => { delete zara.charts.garment.sizes[s].sleeveLength; });
      const profile = referenceProfile(rowOf(sizing.byId(ZARA), 'M'));
      /* neither method ranks a size on less than it compares the others on */
      assert.deepStrictEqual(engine.recommend(profile, zara).missing.map((m) => m.code), ['no-candidates']);
      const c = engine.compare(profile, zara);
      assert.deepStrictEqual([c.missing[0].code, c.unranked], ['nothing-comparable', zara.sizes]);
      const d = decision.decide(profile, zara);
      holdsContract(d);
      assert.deepStrictEqual([d.outcome, codes(d)], [INSUFFICIENT_DATA, ['incomplete-size-rows']]);
      assert.deepStrictEqual(d.reasons[0].sizes, zara.sizes);
    });
  });

  await test('2  "sleeves run short" on a product missing one size\'s sleeve: the optional length is set aside for every size, said in the notes', () => {
    asChecked([UQ_HOODIE], () => {
      const uq = copy(sizing.byId(UQ_HOODIE));
      delete uq.charts.garment.sizes.XL.sleeveLength;
      const plain = engine.recommend(chestProfile(40), uq);
      const short = engine.recommend(chestProfile(40, 'in', { troubleZones: ['sleeves-short'] }), uq);
      assert.strictEqual(short.status, 'ok');
      /* XL gains nothing from its missing sleeve: the ranking is the chest's alone */
      assert.deepStrictEqual(short.ranking, plain.ranking);
      assert.ok(short.notes.some((n) => /Sleeve length wasn't used/.test(n) && /XL/.test(n)), short.notes.join(' | '));
    });
  });

  /* ---------- 3. incompatible measuring methods ---------- */

  await test('3  UNIQLO (sleeve and length from the centre back) against a reference measured from the shoulder: INSUFFICIENT_DATA "incompatible-methods", nothing converted', () => {
    asChecked([UQ_HOODIE], () => {
      const d = decision.decide(referenceProfile({ chestWidth: 58, shoulderWidth: 50, sleeveLength: 60, bodyLength: 68 }), sizing.byId(UQ_HOODIE));
      holdsContract(d);
      assert.strictEqual(d.outcome, INSUFFICIENT_DATA);
      const incompatible = d.reasons.filter((r) => r.code === 'incompatible-methods').map((r) => r.dim).sort();
      assert.deepStrictEqual(incompatible, ['bodyLength', 'sleeveLength']);
      assert.ok(!d.qualifiers.some((q) => q.code === 'estimated-conversion'));
    });
  });

  await test('3  the one stated conversion is kept: a flat reference chest against a chart all the way around is compared, and called estimated', () => {
    asChecked([ZARA], () => {
      const zara = copy(sizing.byId(ZARA));
      const dim = zara.charts.garment.dimensions.chestWidth;
      dim.method = 'garment-circumference';
      delete dim.derivedCircumference;
      zara.sizes.forEach((s) => { const c = zara.charts.garment.sizes[s].chestWidth; c.value *= 2; c.text = String(c.value); });
      const d = decision.decide(referenceProfile(rowOf(sizing.byId(ZARA), 'M')), zara);
      holdsContract(d);
      assert.deepStrictEqual([d.outcome, d.size], [OK, 'M']);
      assert.ok(d.qualifiers.some((q) => q.code === 'estimated-conversion'));
    });
  });

  /* ---------- 4. units not stated ---------- */

  await test('4  a chart whose unit isn\'t stated (as a page or the extension reads it) never decides a size', () => {
    const chart = { measures: 'finished-garment', unit: null, columns: ['Size', 'Chest'], rows: [{ size: 'M', values: ['M', '22'] }] };
    const d = decision.decide(referenceProfile(rowOf(sizing.byId(ZARA), 'M')), { chart });
    holdsContract(d);
    assert.strictEqual(d.outcome, INSUFFICIENT_DATA);
    assert.ok(codes(d).includes('unit-not-stated'));
    assert.ok(codes(d).includes('unverified-source'));
    /* a stated unit doesn't make a browser-read chart authoritative either */
    const stated = decision.decide(null, { chart: Object.assign({}, chart, { unit: 'in', methods: [null, 'flat'] }) });
    assert.deepStrictEqual(codes(stated), ['unverified-source']);
  });

  await test('4  the shopper\'s own measurements without a unit are refused, never read as inches or centimetres', () => {
    asChecked([ZARA], () => {
      const profile = referenceProfile(rowOf(sizing.byId(ZARA), 'M'));
      delete profile.garments.hoodies.anchor.measurements.unit;
      const d = decision.decide(profile, sizing.byId(ZARA));
      holdsContract(d);
      assert.deepStrictEqual([d.outcome, codes(d)], [INSUFFICIENT_DATA, ['invalid-measurement']]);
    });
  });

  /* ---------- 5. unverified data ---------- */

  await test('5  Zara as it is (pending review): a perfect reference still gives INSUFFICIENT_DATA "unverified-data"', () => {
    const zara = sizing.byId(ZARA);
    /* the evaluation suite's reading would rank it; the policy never does */
    assert.strictEqual(engine.compare(referenceProfile(rowOf(zara, 'M')), zara, { includeUnverified: true }).closest, 'M');
    const d = decision.decide(referenceProfile(rowOf(zara, 'M')), zara);
    holdsContract(d);
    assert.deepStrictEqual([d.outcome, codes(d)], [INSUFFICIENT_DATA, ['unverified-data']]);
  });

  await test('5  no unverified record gives OK, whatever the profile', () => {
    const profiles = [chestProfile(40), chestProfile(100, 'cm'), referenceProfile({ chestWidth: 60, shoulderWidth: 52, sleeveLength: 62, bodyLength: 70 })];
    sizing.RECORDS.filter((r) => r.verification.status !== 'verified').forEach((r) => profiles.forEach((p) => {
      const d = decision.decide(p, r);
      holdsContract(d);
      assert.strictEqual(d.outcome, INSUFFICIENT_DATA, r.id);
      assert.ok(codes(d).includes('unverified-data'), r.id);
    }));
  });

  /* ---------- 6. conflicting references ---------- */

  await test('6  a 34 in chest beside "Nike XL fits me" (44–48.5 in): INSUFFICIENT_DATA "conflicting-references" — the engine alone answered at low confidence', () => {
    const nike = sizing.byId(NIKE);
    const profile = Object.assign(chestProfile(34), { brandSizes: [{ brand: 'Nike', size: 'XL', category: 'hoodies', fit: 'about-right' }] });
    const r = engine.recommend(profile, nike);
    assert.deepStrictEqual([r.status, r.confidence, r.evidence.conflict], ['ok', 'low', true]);
    const d = decision.decide(profile, nike);
    holdsContract(d);
    assert.deepStrictEqual([d.outcome, codes(d)], [INSUFFICIENT_DATA, ['conflicting-references']]);
  });

  /* ---------- 7. requirements by category and method ---------- */

  await test('7  requirements are per category and method: tops need a chest, by the method in use; categories without data have none', () => {
    ['hoodies', 'sweatshirts', 'tshirts'].forEach((c) => {
      const req = decision.requirementsFor(c);
      assert.deepStrictEqual(req['reference-garment'].required, { shopper: ['reference.chestWidth'], target: ['garment.chestWidth'] });
      assert.deepStrictEqual(req['body-plus-ease'].required, { shopper: ['body.chest'], target: ['garment.chestWidth'] });
      assert.deepStrictEqual(req['body-chart'].required, { shopper: ['body.chest'], target: ['body.chest'] });
    });
    /* no sizing records or engine parameters exist for bottoms: none invented */
    ['jeans', 'pants', 'shorts', 'jackets'].forEach((c) => assert.strictEqual(decision.requirementsFor(c), null));
    const d = decision.decide(null, { category: 'jeans' });
    holdsContract(d);
    assert.deepStrictEqual([d.outcome, codes(d)], [INSUFFICIENT_DATA, ['category-not-supported']]);
  });

  await test('7  a reference with shoulders, sleeve and length but no chest: INSUFFICIENT_DATA, the chest named as the missing requirement', () => {
    asChecked([ZARA], () => {
      const M = rowOf(sizing.byId(ZARA), 'M');
      const d = decision.decide(referenceProfile({ shoulderWidth: M.shoulderWidth, sleeveLength: M.sleeveLength, bodyLength: M.bodyLength }), sizing.byId(ZARA));
      holdsContract(d);
      assert.strictEqual(d.outcome, INSUFFICIENT_DATA);
      assert.ok(d.reasons.some((r) => r.code === 'missing-required-measurement' && r.dim === 'chestWidth'), JSON.stringify(d.reasons));
    });
  });

  await test('7  the answer says what its method required, for its category', () => {
    const d = decision.decide(chestProfile(39), sizing.byId(NIKE));
    assert.strictEqual(d.method, 'body-chart');
    assert.deepStrictEqual(d.requirements, decision.REQUIREMENTS.hoodies['body-chart']);
  });

  /* ---------- 8. complete but unacceptable: NO_MATCH ---------- */

  await test('8  Zara (checked): a reference 10 cm narrower through the chest than S — the engine\'s compare() says "ok, S"; the decision is NO_MATCH', () => {
    asChecked([ZARA], () => {
      const zara = sizing.byId(ZARA);
      const S = rowOf(zara, 'S');
      const profile = referenceProfile(Object.assign({}, S, { chestWidth: S.chestWidth - 10 }));
      const c = engine.compare(profile, zara);
      assert.deepStrictEqual([c.status, c.recommended], ['ok', 'S']);
      const d = decision.decide(profile, zara);
      holdsContract(d);
      assert.deepStrictEqual([d.outcome, d.closest, d.method], [NO_MATCH, 'S', 'reference-garment']);
      assert.strictEqual(d.reasons[0].code, 'chest-outside-acceptable-range');
      /* 10 cm flat is about 7.9 in around: past the engine's 3 in "slightly" band */
      assert.ok(Math.abs(d.reasons[0].differenceAroundIn - 7.87) < 0.01, d.reasons[0].differenceAroundIn);
    });
  });

  await test('8  UNIQLO hoodie (checked), chest 24.5 in: even its smallest garment is far roomier than a true-to-size fit wants — NO_MATCH', () => {
    asChecked([UQ_HOODIE], () => {
      const d = decision.decide(chestProfile(24.5), sizing.byId(UQ_HOODIE));
      holdsContract(d);
      assert.strictEqual(d.outcome, NO_MATCH);
      assert.strictEqual(d.method, 'body-plus-ease');
      assert.deepStrictEqual(d.reasons.map((r) => [r.code, r.class]), [['chest-outside-acceptable-range', 'too-loose']]);
    });
  });

  /* ---------- 9. not enough to go on: INSUFFICIENT_DATA ---------- */

  await test('9  nothing about the shopper, or no record: INSUFFICIENT_DATA with what is missing', () => {
    const empty = decision.decide(Object.assign(Schema.empty(), { garments: { hoodies: { line: 'men' } } }), sizing.byId(NIKE));
    holdsContract(empty);
    assert.deepStrictEqual([empty.outcome, codes(empty)], [INSUFFICIENT_DATA, ['missing-required-measurement']]);
    assert.strictEqual(empty.reasons[0].side, 'shopper');
    const none = decision.decide(chestProfile(40), null);
    assert.deepStrictEqual([none.outcome, codes(none)], [INSUFFICIENT_DATA, ['no-record']]);
    const broken = copy(sizing.byId(NIKE));
    delete broken.sizes;
    assert.deepStrictEqual(codes(decision.decide(chestProfile(40), broken)), ['no-record']);
  });

  await test('9  a reference garment against a body chart only: INSUFFICIENT_DATA "body-vs-garment"', () => {
    const d = decision.decide(referenceProfile({ chestWidth: 56, shoulderWidth: 50, sleeveLength: 60, bodyLength: 70 }), sizing.byId(NIKE));
    holdsContract(d);
    assert.strictEqual(d.outcome, INSUFFICIENT_DATA);
    assert.ok(codes(d).includes('body-vs-garment'), JSON.stringify(d.reasons));
  });

  /* ---------- 10. the supported paths still answer ---------- */

  await test('10 Nike, chest 39 in: OK, M, by the body chart (as before); chest 30 in: OK, XXS', () => {
    const nike = sizing.byId(NIKE);
    const d = decision.decide(chestProfile(39), nike);
    holdsContract(d);
    assert.deepStrictEqual([d.outcome, d.size, d.method, d.via], [OK, 'M', 'body-chart', 'recommend']);
    assert.strictEqual(d.size, engine.recommend(chestProfile(39), nike).leading);
    assert.strictEqual(decision.decide(chestProfile(30), nike).size, 'XXS');
  });

  await test('10 Zara (checked), a reference the same as M: OK, M, garment with garment', () => {
    asChecked([ZARA], () => {
      const d = decision.decide(referenceProfile(rowOf(sizing.byId(ZARA), 'M')), sizing.byId(ZARA));
      holdsContract(d);
      assert.deepStrictEqual([d.outcome, d.size, d.method, d.via], [OK, 'M', 'reference-garment', 'compare']);
    });
  });

  await test('10 UNIQLO hoodie (checked), chest 40 in, true to size: OK, M, body plus room — the evaluation suite\'s own case', () => {
    asChecked([UQ_HOODIE], () => {
      const d = decision.decide(chestProfile(40), sizing.byId(UQ_HOODIE));
      holdsContract(d);
      assert.deepStrictEqual([d.outcome, d.size, d.method], [OK, 'M', 'body-plus-ease']);
      assert.ok(qualifierCodes(d).includes('estimated-conversion'));
    });
  });

  await test('10 both methods follow one contract: every record, through compare() and recommend(), answers in its shape and codes', () => {
    asChecked([ZARA, UQ_HOODIE], () => {
      const profiles = [chestProfile(24.5), chestProfile(39), chestProfile(66), chestProfile(102, 'cm'), Schema.empty(),
        referenceProfile({ chestWidth: 56, shoulderWidth: 50, sleeveLength: 60, bodyLength: 70 }),
        referenceProfile({ chestWidth: 22, shoulderWidth: 19, sleeveLength: 24, bodyLength: 27 }, 'in', 'tshirts')];
      let seen = new Set();
      sizing.RECORDS.forEach((r) => profiles.forEach((p) => ['compare', 'recommend', undefined].forEach((via) => {
        const d = decision.decide(p, r, { via });
        holdsContract(d);
        /* with a reference garment the answer rests on it alone, whichever route asked */
        /* a reference for this kind of top (hoodies and sweatshirts share one; a T-shirt's is its own) */
        const family = (c) => engine.FAMILY[c];
        const own = Object.entries(p.garments || {}).some(([c, e]) => family(c) === family(r.category) && e && e.anchor && (e.anchor.measurements || e.anchor.product));
        if (d.via) assert.strictEqual(d.via, own || via === 'compare' ? 'compare' : 'recommend');
        seen.add(d.outcome);
      })));
      assert.deepStrictEqual([...seen].sort(), [INSUFFICIENT_DATA, NO_MATCH, OK].sort());
    });
  });

  await test('10 the API keeps its fields and adds the decision beside them', async () => {
    const handler = require('../api/size-recommendation');
    const { fitFor } = handler;
    const nike = sizing.byId(NIKE);
    const item = fitFor(chestProfile(39), 'hoodies', [{ brand: 'Nike', name: nike.product.name, url: nike.product.url }]).items[0];
    /* body measurements only: a body estimate, never a size called the shopper's */
    assert.deepStrictEqual([item.status, item.by, item.resultType, item.size, item.estimate, item.reliability], ['estimate', 'body', 'body-estimate', null, 'M', engine.recommend(chestProfile(39), nike).confidence]);
    assert.strictEqual(item.decision.outcome, OK);
    assert.strictEqual(item.decision.comparison, 'body-to-body-chart');
    assert.strictEqual(decision.resultTypeOf(item.decision), 'body-estimate');
    assert.strictEqual(item.decision.size, item.estimate);
  });

  out(`\n${passed} passed, ${failures.length} failed\n\n`);
  process.exit(failures.length ? 1 : 0);
})();
