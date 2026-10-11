#!/usr/bin/env node
/* =========================================================
   Fynd — sizing records, the size engine, and its endpoints

   Offline, no key, the store on its memory driver:

     node scripts/test-sizing.js

   What it holds them to:
     - every record is from the brand's own site, keeps the text each
       value was copied from, and is refused when it claims more than it
       has (a verified record nobody checked, a range upside down, a
       dimension or method that does not exist)
     - unverified data never gives a size outside the evaluation suite
     - a body measurement is never compared with a garment measurement,
       and garment measurements only by the same method
     - /api/size-recommendation reads only the caller's own profile, is
       read-only and no-store, and answers 401 signed out
     - fit feedback (on /api/fit-profile) keeps nothing without consent, takes only fixed
       choices, carries the CSRF token on every change, belongs to its
       owner alone, goes when the fit profile goes, and is never logged
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.AUTH_SECRET = 'sizing-test-secret-of-sufficient-length';
delete process.env.RESEND_API_KEY;
delete process.env.POSTMARK_SERVER_TOKEN;
global.fetch = async (url) => { throw new Error(`unexpected outbound request to ${url}`); };

const Schema = require('../assets/fit-profile-schema.js');
const sizingSchema = require('../api/_sizing/schema');
const sizing = require('../api/_sizing/records');
const engine = require('../api/_sizing/engine');
const store = require('../api/_store');
const users = require('../api/_users');
const auth = require('../api/_auth');
const fitProfiles = require('../api/_fit-profile');
const fitFeedback = require('../api/_fit-feedback');

const recommendEndpoint = require('../api/size-recommendation');
const profileEndpoint = require('../api/fit-profile');
const authEndpoint = require('../api/auth');
const accountEndpoint = require('../api/account');

const logged = [];
['log', 'warn', 'error'].forEach((level) => {
  const original = console[level];
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    if (process.env.SHOW_LOGS) original(...args);
  };
});
const out = (text) => process.stdout.write(text);

/* ---------- requests, as the fit profile suite makes them ---------- */

function makeRes() {
  return {
    statusCode: 200, headers: {}, payload: null,
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    getHeader(n) { return this.headers[String(n).toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
    end() { return this; }
  };
}
function cookiesFrom(res, existing) {
  const jar = Object.assign({}, existing || {});
  [].concat(res.getHeader('Set-Cookie') || []).forEach((line) => {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    const value = decodeURIComponent(pair.slice(at + 1).trim());
    if (value === '') delete jar[pair.slice(0, at).trim()];
    else jar[pair.slice(0, at).trim()] = value;
  });
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
let address = 20;
async function call(endpoint, o) {
  const res = makeRes();
  const jar = o.jar || {};
  const csrf = jar.fynd_session && !o.omitCsrf ? { 'x-fynd-csrf': auth.csrfTokenFor(jar.fynd_session) } : {};
  const req = {
    method: o.method || 'POST', url: o.url || '/api/x', query: o.query, body: o.body,
    headers: Object.assign({ host: 'fynd.test' }, Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}, csrf, o.headers || {}),
    socket: { remoteAddress: '203.0.113.9' }, on() { return this; }
  };
  await endpoint(req, res);
  return { res, jar: cookiesFrom(res, jar), status: res.statusCode, body: res.payload };
}
const PASSWORD = 'correct-horse-battery-staple';
async function signUp(email) {
  address += 1;
  const { res, jar } = await call(authEndpoint, {
    headers: { 'x-forwarded-for': `203.0.113.${address}` },
    body: { action: 'signup', name: 'Shopper', email, password: PASSWORD, confirmPassword: PASSWORD }
  });
  assert.strictEqual(res.statusCode, 200, `sign-up ${email} answered ${res.statusCode}`);
  return { jar, user: await users.byEmail(email) };
}
const suggest = (jar, product, o) => call(recommendEndpoint, Object.assign({ method: 'GET', jar, query: product === undefined ? {} : { product }, url: `/api/size-recommendation${product ? `?product=${product}` : ''}` }, o));
/* fit feedback lives on /api/fit-profile: GET ?part=feedback, and "feedback-" actions */
const feedback = (jar, body, o) => call(profileEndpoint, Object.assign({ jar, body: Object.assign({}, body, { action: 'feedback-' + body.action }) }, o));
const readFeedback = (jar) => call(profileEndpoint, { method: 'GET', jar, query: { part: 'feedback' }, url: '/api/fit-profile?part=feedback' });

/* ---------- runner ---------- */

let passed = 0;
const failures = [];
async function test(name, fn) {
  store.reset();
  try { await fn(); passed += 1; out(`  ok    ${name}\n`); } catch (err) { failures.push(name); out(`  FAIL  ${name}\n        ${err && err.message}\n`); }
}
const section = (t) => out(`\n${t}\n`);

const UQ_HOODIE = 'uniqlo-e475378-sweat-pullover-hoodie-us';
const UQ_SWEAT = 'uniqlo-e475377-sweatshirt-us';
const NIKE_HOODIE = 'nike-fn3859-club-pullover-fleece-hoodie-us';
const CARHARTT_HOODIE = 'carhartt-k121-loose-fit-midweight-hoodie-us';
const copy = (id) => JSON.parse(JSON.stringify(sizing.byId(id)));
const verifiedCopy = (id) => Object.assign(copy(id), { verification: { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-10' } });
const profileWith = (garment, extra) => {
  const p = Object.assign(Schema.empty(), extra || {});
  p.garments.hoodies = Object.assign(Schema.emptyGarment('hoodies'), garment);
  p.garments.sweatshirts = Object.assign(Schema.emptyGarment('sweatshirts'), garment);
  return p;
};
const chest = (c, unit) => ({ measurements: { unit: unit || 'in', height: null, chest: c, waist: null, hip: null } });

/* with every record verified in memory, for the endpoint's happy path */
async function withVerifiedRecords(fn) {
  const saved = sizing.RECORDS.map((r) => Object.assign({}, r.verification));
  sizing.RECORDS.forEach((r) => Object.assign(r.verification, { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-10' }));
  try { await fn(); } finally { sizing.RECORDS.forEach((r, i) => { Object.keys(r.verification).forEach((k) => delete r.verification[k]); Object.assign(r.verification, saved[i]); }); }
}

(async () => {

section('sizing records');

await test('all six records load, each from the brand\'s own site, and none is marked verified', () => {
  assert.deepStrictEqual(sizing.problems, []);
  assert.strictEqual(sizing.RECORDS.length, 6);
  assert.deepStrictEqual([...new Set(sizing.RECORDS.map((r) => r.brand))].sort(), ['Carhartt', 'Nike', 'UNIQLO']);
  assert.deepStrictEqual([...new Set(sizing.RECORDS.map((r) => r.category))].sort(), ['hoodies', 'sweatshirts']);
  sizing.RECORDS.forEach((r) => {
    assert.strictEqual(r.verification.status, 'unverified', `${r.id} must wait for a manual check`);
    assert.strictEqual(r.verification.checkedBy, null);
    r.sources.forEach((s) => assert.ok(sizingSchema.OFFICIAL_HOSTS[r.brand].includes(new URL(s.url).hostname), s.url));
    assert.ok(r.region && r.line && r.units && r.sizes.length, r.id);
  });
});

await test('records keep exactly what each brand publishes: UNIQLO both charts, Nike and Carhartt body charts only', () => {
  const uq = sizing.byId(UQ_HOODIE);
  assert.deepStrictEqual(Object.keys(uq.charts).sort(), ['body', 'garment']);
  assert.deepStrictEqual(Object.keys(uq.charts.garment.dimensions).sort(), ['bodyLength', 'chestWidth', 'shoulderWidth', 'sleeveLength']);
  /* a flat width, armpit to armpit — not a circumference — on UNIQLO's own word */
  assert.strictEqual(uq.charts.body.measures, 'body');
  assert.strictEqual(uq.charts.garment.measures, 'finished-garment');
  assert.strictEqual(uq.charts.garment.dimensions.chestWidth.method, 'flat-width-armpit-to-armpit');
  assert.strictEqual(uq.charts.body.dimensions.chest.method, 'body-circumference');
  assert.strictEqual(uq.charts.garment.dimensions.chestWidth.methodSource.url, 'https://faq-us.uniqlo.com/articles/en_US/FAQ/How-to-Measure');
  assert.match(uq.charts.garment.dimensions.chestWidth.methodSource.says, /armpit to armpit/);
  sizing.RECORDS.forEach((r) => {
    assert.strictEqual(r.charts.body.dimensions.chest.method, 'body-circumference', `${r.id}: body chest`);
    assert.ok(r.retrievedAt && r.region === 'US' && r.units === 'in', r.id);
    assert.ok(r.product.name && r.product.garmentType, r.id);
  });
  assert.deepStrictEqual([sizing.byId(CARHARTT_HOODIE).product.name, sizing.byId(CARHARTT_HOODIE).product.garmentType], ['Marquette Sweatshirt', 'pullover-hoodie'],
    'Carhartt’s displayed name and the garment type are kept apart');
  assert.strictEqual(uq.charts.garment.sizes.M.chestWidth.text, '23 ½');
  assert.strictEqual(uq.charts.garment.sizes.M.chestWidth.value, 23.5);
  assert.deepStrictEqual(Object.keys(sizing.byId(NIKE_HOODIE).charts), ['body']);
  const ch = sizing.byId(CARHARTT_HOODIE);
  assert.deepStrictEqual(Object.keys(ch.charts), ['body']);
  assert.strictEqual(ch.charts.body.dimensions.chest.kind, 'point', 'Carhartt publishes one value per size, kept as one');
  assert.strictEqual(ch.charts.body.sizes.M.chest.value, 40);
  /* nothing a brand does not publish is filled in */
  sizing.RECORDS.forEach((r) => assert.strictEqual(r.material.stretch, null, `${r.id}: no brand states stretch`));
  assert.strictEqual(sizing.byId(NIKE_HOODIE).material.composition, null);
  /* every value's text reads as its number */
  sizing.RECORDS.forEach((r) => Object.values(r.charts).forEach((chart) => Object.values(chart.sizes).forEach((row) => Object.values(row).forEach((cell) => {
    const n = (t) => t.replace(/ ¼/g, '.25').replace(/ ½/g, '.5').replace(/ ¾/g, '.75');
    if ('value' in cell) assert.strictEqual(Number(n(cell.text)), cell.value, `${r.id}: ${cell.text}`);
    else assert.strictEqual(n(cell.text), `${cell.min} - ${cell.max}`, `${r.id}: ${cell.text}`);
  }))));
});

await test('a record that claims more than it has is refused', () => {
  const bad = (change) => { const r = copy(UQ_HOODIE); change(r); return sizingSchema.validate(r).map((e) => e.field); };
  assert.ok(bad((r) => { r.verification = { status: 'verified', checkedBy: null, checkedAt: null }; }).includes('verification'));
  assert.ok(bad((r) => { r.sources[0].url = 'https://some-blog.example/uniqlo-sizes'; }).includes('sources.0.url'));
  assert.ok(bad((r) => { r.charts.body.sizes.M.chest.min = 45; }).includes('charts.body.sizes.M.chest'));
  assert.ok(bad((r) => { r.charts.garment.dimensions.chestWidth.method = 'roughly'; }).includes('charts.garment.dimensions.chestWidth.method'));
  assert.ok(bad((r) => { r.charts.garment.dimensions.chestWidth.method = 'body-circumference'; }).includes('charts.garment.dimensions.chestWidth.method'), 'a garment width is not a body circumference');
  assert.ok(bad((r) => { r.charts.body.dimensions.chest.method = 'flat-width-armpit-to-armpit'; }).includes('charts.body.dimensions.chest.method'), 'a body chest is not a flat width');
  assert.ok(bad((r) => { delete r.charts.garment.dimensions.chestWidth.methodSource; }).includes('charts.garment.dimensions.chestWidth.methodSource'));
  assert.ok(bad((r) => { r.charts.garment.dimensions.chestWidth.methodSource.url = 'https://sizes.example/uniqlo'; }).includes('charts.garment.dimensions.chestWidth.methodSource'));
  assert.ok(bad((r) => { r.charts.garment.measures = 'body'; }).includes('charts.garment.measures'));
  assert.ok(bad((r) => { r.product.garmentType = 'crewneck-sweatshirt'; }).includes('product.garmentType'));
  assert.ok(bad((r) => { delete r.retrievedAt; }).includes('retrievedAt'));
  assert.ok(bad((r) => { r.charts.garment.dimensions.neck = { method: 'flat-width-armpit-to-armpit', methodSource: { url: r.product.url, says: 'x' } }; }).includes('charts.garment.dimensions.neck'));
  assert.ok(bad((r) => { r.charts.body.sizes.XXXXL = { chest: { min: 60, max: 64, text: '60 - 64' } }; }).includes('charts.body.sizes.XXXXL'));
  assert.ok(bad((r) => { delete r.charts.garment.sizes.M.chestWidth.text; }).includes('charts.garment.sizes.M.chestWidth'));
  assert.ok(bad((r) => { r.category = 'jeans'; }).includes('category'));
  assert.ok(bad((r) => { r.charts.body.retrievedAt = 'last week'; }).includes('charts.body.retrievedAt'));
  /* checked by somebody, dated: then it is verified */
  assert.deepStrictEqual(sizingSchema.validate(verifiedCopy(UQ_HOODIE)), []);
});

section('the engine');

await test('unverified data never gives a size; verified data does, and says so', () => {
  const profile = profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40));
  const refused = engine.recommend(profile, sizing.byId(UQ_HOODIE));
  assert.strictEqual(refused.status, 'insufficient');
  assert.strictEqual(refused.missing[0].code, 'unverified-data');
  assert.ok(!('leading' in refused));
  const ok = engine.recommend(profile, verifiedCopy(UQ_HOODIE), { records: [verifiedCopy(UQ_HOODIE)] });
  assert.strictEqual(ok.status, 'ok');
  assert.strictEqual(ok.leading, 'M');
  assert.strictEqual(ok.dataStatus, 'verified');
  assert.ok(ok.dataQuality.verified.includes('garment chest'));
  assert.deepStrictEqual(ok.dataQuality.unverified, []);
});

await test('a body measurement is never compared with a garment one: body-only products are scored on their body chart', () => {
  const profile = profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40));
  const nike = engine.recommend(profile, sizing.byId(NIKE_HOODIE), { includeUnverified: true });
  assert.strictEqual(nike.method, 'body-chart');
  assert.ok(nike.dataQuality.unknown.includes('garment chest') && nike.dataQuality.unknown.includes('sleeve length'));
  assert.ok(nike.reasons.some((r) => /doesn't publish this product's garment measurements/.test(r)));
  /* a garment reference alone, against a body-only product, is not
     compared: with UNIQLO's body chart removed from the reference, Nike
     has nothing to compare with */
  const uqGarmentOnly = copy(UQ_HOODIE);
  delete uqGarmentOnly.charts.body;
  const refOnly = profileWith({ anchor: { brand: 'UNIQLO', size: 'M' }, fitGoal: 'true-to-size', line: 'men' });
  const r = engine.recommend(refOnly, sizing.byId(NIKE_HOODIE), { includeUnverified: true, records: [uqGarmentOnly, sizing.byId(NIKE_HOODIE)] });
  assert.strictEqual(r.status, 'insufficient');
  assert.strictEqual(r.missing[0].code, 'incompatible-measurements');
});

await test('garment measurements are compared only by the same method', () => {
  const target = copy(UQ_HOODIE);
  target.charts.garment.dimensions.sleeveLength.method = 'shoulder-seam-to-cuff';
  /* the reference is the sweatshirt, whose sleeve is measured from the centre back */
  const profile = profileWith({ fitGoal: 'true-to-size', line: 'men' }, { brandSizes: [{ brand: 'UNIQLO', category: 'sweatshirts', size: 'M', fit: 'about-right' }] });
  const r = engine.recommend(profile, target, { includeUnverified: true, records: [sizing.byId(UQ_SWEAT), target] });
  assert.strictEqual(r.method, 'reference-garment');
  assert.ok(!r.reasons.some((x) => /^Sleeves/.test(x)), `sleeves compared across methods: ${r.reasons.join(' | ')}`);
  assert.ok(r.reasons.some((x) => /^Chest/.test(x)));
});

await test('a chest in centimetres is converted exactly, never relabelled', () => {
  const inches = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  const cm = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(101.6, 'cm')), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.deepStrictEqual(cm.ranking, inches.ranking);
  assert.ok(cm.reasons[0].includes('101.6 cm'), cm.reasons[0]);
});

await test('a letter size is read only with its sizing line, and never from a brand without a chart', () => {
  const r = engine.recommend(profileWith({ anchor: { brand: 'Nike', size: 'M' }, fitGoal: 'true-to-size', line: null }), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.strictEqual(r.status, 'insufficient');
  assert.ok(r.missing.some((m) => m.code === 'line-needed'));
  const zara = engine.recommend(profileWith({ anchor: { brand: 'Zara', size: 'M' }, fitGoal: 'true-to-size', line: 'men' }), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.ok(zara.notes.some((n) => /no Zara size chart/.test(n)));
  const women = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'women' }, chest(36)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.strictEqual(women.missing[0].code, 'line-not-covered');
});

await test('trouble spots weigh in their direction, and what no chart covers is said, not scored', () => {
  const base = { fitGoal: 'true-to-size', line: 'men' };
  const plain = engine.recommend(profileWith(base, chest(41.5)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  const tight = engine.recommend(profileWith(Object.assign({ troubleZones: ['chest-tight'] }, base), chest(41.5)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.strictEqual(tight.leading, 'L');
  assert.ok(tight.ranking.find((x) => x.size === 'M').score > plain.ranking.find((x) => x.size === 'M').score, 'a tighter size costs more');
  const neck = engine.recommend(profileWith(Object.assign({ troubleZones: ['neckline-tight', 'waist-loose'] }, base), chest(40)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.ok(neck.caveats.some((c) => /neck openings are not published/.test(c)));
  assert.ok(neck.caveats.some((c) => /hem and waist widths are not published/.test(c)));
  assert.deepStrictEqual(neck.ranking, plain.ranking.length ? engine.recommend(profileWith(base, chest(40)), sizing.byId(UQ_HOODIE), { includeUnverified: true }).ranking : [], 'unassessable spots change nothing');
});

await test('Carhartt\'s single chest values become ranges only as a stated estimate, and its loose cut keeps the chart size on offer', () => {
  const range = engine.bodyRange(sizing.byId(CARHARTT_HOODIE), 'M');
  assert.deepStrictEqual([range.lo, range.hi, range.estimated], [38, 42, true]);
  const r = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40)), sizing.byId(CARHARTT_HOODIE), { includeUnverified: true });
  assert.ok(r.dataQuality.estimated.some((e) => /halfway to the next size/.test(e)));
  assert.strictEqual(r.leading, 'S');
  assert.strictEqual(r.alternative.size, 'M');
  assert.ok(r.reasons.some((x) => /aims one size down/.test(x)));
  assert.notStrictEqual(r.confidence, 'high');
});

await test('a flat garment width is never set against a body circumference: it becomes a garment circumference, said as an estimate', () => {
  const r = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.strictEqual(r.method, 'body-plus-ease');
  assert.ok(r.dataQuality.estimated.includes('garment chest around, taken as twice its flat width'));
  /* M's flat 23 ½ in is shown as a width, and its way around (47 in) is what meets 40 in + room */
  assert.ok(r.reasons.some((x) => /M measures 23½ in flat, about 47 in around/.test(x)), r.reasons.join(' | '));
  /* garment-to-garment needs no such step */
  const ref = engine.recommend(profileWith({ anchor: { brand: 'UNIQLO', size: 'M' }, fitGoal: 'true-to-size', line: 'men' }), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.ok(!ref.dataQuality.estimated.some((e) => /twice its flat width/.test(e)));
});

await test('the room-for-fit numbers are labelled an assumption wherever they are used', () => {
  const r = engine.recommend(profileWith({ fitGoal: 'oversized', line: 'men' }, chest(40)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.strictEqual(r.method, 'body-plus-ease');
  assert.ok(r.reasons[0].includes('a starting assumption, not a rule'));
  assert.ok(r.dataQuality.estimated.some((e) => /starting assumption/.test(e)));
  assert.deepStrictEqual(engine.CATEGORY_PARAMS.hoodies.ease, { slim: [2, 5], 'true-to-size': [5, 9], oversized: [10, 16] });
});

section('/api/size-recommendation');

await test('signed out it answers 401; it is GET only and no-store', async () => {
  const out1 = await suggest({}, UQ_HOODIE);
  assert.strictEqual(out1.status, 401);
  assert.strictEqual(out1.body.reason, 'sign-in-required');
  const { jar } = await signUp('ada@example.test');
  const post = await call(recommendEndpoint, { jar, method: 'POST', body: { product: UQ_HOODIE } });
  assert.strictEqual(post.status, 405);
  const list = await suggest(jar);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.res.getHeader('cache-control'), 'no-store, private');
  assert.strictEqual(list.body.products.length, 6);
  assert.ok(list.body.products.every((p) => p.verified === false));
});

await test('an unknown or malformed product id is refused, and nothing is guessed', async () => {
  const { jar } = await signUp('ada@example.test');
  assert.strictEqual((await suggest(jar, 'not a product')).status, 400);
  assert.strictEqual((await suggest(jar, 'uniqlo-made-up-hoodie')).status, 404);
});

await test('with today\'s unverified records every suggestion is an honest "insufficient"', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await fitProfiles.save(user.id, { schemaVersion: 4, measurements: { unit: 'in', chest: 40 } });
  await fitProfiles.saveGuide(user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });
  for (const r of sizing.RECORDS) {
    const { status, body } = await suggest(jar, r.id);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.recommendation.status, 'insufficient', r.id);
    assert.strictEqual(body.recommendation.missing[0].code, 'unverified-data');
  }
});

await test('once verified, it suggests from the caller\'s own profile and nobody else\'s', async () => {
  await withVerifiedRecords(async () => {
    const ada = await signUp('ada@example.test');
    const bea = await signUp('bea@example.test');
    await fitProfiles.save(ada.user.id, { schemaVersion: 4, measurements: { unit: 'in', chest: 40 } });
    await fitProfiles.saveGuide(ada.user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });
    await fitProfiles.save(bea.user.id, { schemaVersion: 4, measurements: { unit: 'in', chest: 46 } });
    await fitProfiles.saveGuide(bea.user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });

    const adas = (await suggest(ada.jar, UQ_HOODIE)).body.recommendation;
    assert.strictEqual(adas.status, 'ok');
    assert.strictEqual(adas.leading, 'M');
    assert.strictEqual(adas.dataStatus, 'verified');
    /* no id in the query or headers can point at Ada's profile */
    const pointed = await suggest(bea.jar, UQ_HOODIE, { query: { product: UQ_HOODIE, userId: ada.user.id }, headers: { 'x-user-id': ada.user.id } });
    assert.notStrictEqual(pointed.body.recommendation.leading, 'M', 'Bea gets her own size');
    assert.strictEqual(pointed.body.recommendation.leading, 'XL');
    /* read-only */
    const before = await store.get(fitProfiles.profileKey(ada.user.id));
    await suggest(ada.jar, NIKE_HOODIE);
    assert.deepStrictEqual(await store.get(fitProfiles.profileKey(ada.user.id)), before);
  });
});

await test('a signed-in caller with no profile is told what is missing, not given a size', async () => {
  await withVerifiedRecords(async () => {
    const { jar } = await signUp('ada@example.test');
    const r = (await suggest(jar, NIKE_HOODIE)).body.recommendation;
    assert.strictEqual(r.status, 'insufficient');
    assert.strictEqual(r.missing[0].code, 'no-evidence');
    assert.ok(r.next.some((n) => /chest measurement/.test(n)));
  });
});

section('fit feedback, on /api/fit-profile');

const ENTRY = () => ({ productId: UQ_HOODIE, sizeTried: 'M', recommendedSize: 'M', overall: 'right', areas: { chest: 'right', sleeves: 'short' } });

await test('nothing is kept without consent to keep it', async () => {
  const { jar, user } = await signUp('ada@example.test');
  const first = await feedback(jar, { action: 'add', entry: ENTRY() });
  assert.strictEqual(first.status, 409);
  assert.strictEqual(first.body.reason, 'consent-required');
  assert.strictEqual(await store.get(fitFeedback.key(user.id)), null);
  const view = await readFeedback(jar);
  assert.deepStrictEqual(view.body.feedback, { consent: { store: false, improve: false, updatedAt: null }, entries: [] });
});

await test('with consent, an entry of fixed choices is kept; anything else is refused', async () => {
  const { jar } = await signUp('ada@example.test');
  assert.strictEqual((await feedback(jar, { action: 'consent', consent: { store: true } })).status, 200);
  const added = await feedback(jar, { action: 'add', entry: Object.assign(ENTRY(), { note: 'my chest is 40', email: 'x@y.z' }) });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));
  assert.deepStrictEqual(Object.keys(added.body.entry).sort(), ['areas', 'brand', 'category', 'createdAt', 'id', 'overall', 'productId', 'recommendedSize', 'sizeTried']);
  assert.ok(!JSON.stringify(added.body).includes('my chest is 40'), 'free text is dropped');
  for (const [entry, field] of [
    [Object.assign(ENTRY(), { productId: 'made-up' }), 'productId'],
    [Object.assign(ENTRY(), { sizeTried: '5XL' }), 'sizeTried'],
    [Object.assign(ENTRY(), { overall: 'meh' }), 'overall'],
    [Object.assign(ENTRY(), { areas: { chest: 'snug' } }), 'areas.chest'],
    [Object.assign(ENTRY(), { areas: { neck: 'tight' } }), 'areas.neck'],
    [Object.assign(ENTRY(), { recommendedSize: 'XXXXL' }), 'recommendedSize']
  ]) {
    const r = await feedback(jar, { action: 'add', entry });
    assert.strictEqual(r.status, 400, field);
    assert.ok(r.body.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(r.body.errors)}`);
  }
  assert.strictEqual((await readFeedback(jar)).body.feedback.entries.length, 1);
});

await test('every change needs the CSRF token, and signed out every method answers 401', async () => {
  const { jar, user } = await signUp('ada@example.test');
  const forged = await feedback(jar, { action: 'consent', consent: { store: true } }, { omitCsrf: true });
  assert.strictEqual(forged.status, 403);
  assert.strictEqual(await store.get(fitFeedback.key(user.id)), null);
  assert.strictEqual((await readFeedback({})).status, 401);
  assert.strictEqual((await feedback({}, { action: 'add', entry: ENTRY() })).status, 401);
  assert.strictEqual((await readFeedback(jar)).res.getHeader('cache-control'), 'no-store, private');
});

await test('withdrawing consent deletes every entry; improve cannot outlive store', async () => {
  const { jar } = await signUp('ada@example.test');
  await feedback(jar, { action: 'consent', consent: { store: true, improve: true } });
  await feedback(jar, { action: 'add', entry: ENTRY() });
  const off = await feedback(jar, { action: 'consent', consent: { store: false } });
  assert.deepStrictEqual(off.body.feedback.entries, []);
  assert.strictEqual(off.body.feedback.consent.improve, false);
  assert.strictEqual((await feedback(jar, { action: 'consent', consent: { store: 'yes' } })).status, 400);
});

await test('one account\'s feedback is never another\'s, and an entry can be deleted alone or all at once', async () => {
  const ada = await signUp('ada@example.test');
  const bea = await signUp('bea@example.test');
  await feedback(ada.jar, { action: 'consent', consent: { store: true } });
  const added = await feedback(ada.jar, { action: 'add', entry: ENTRY() });
  assert.deepStrictEqual((await readFeedback(bea.jar)).body.feedback.entries, []);
  assert.strictEqual((await feedback(bea.jar, { action: 'delete', id: added.body.entry.id })).status, 404, 'Bea cannot delete Ada\'s entry');
  assert.strictEqual((await readFeedback(ada.jar)).body.feedback.entries.length, 1);
  assert.strictEqual((await feedback(ada.jar, { action: 'delete', id: added.body.entry.id })).status, 200);
  await feedback(ada.jar, { action: 'add', entry: ENTRY() });
  const gone = await feedback(ada.jar, { action: 'delete-all' });
  assert.strictEqual(gone.body.deleted, true);
  assert.strictEqual(await store.get(fitFeedback.key(ada.user.id)), null);
});

await test('deleting the fit profile deletes the fit feedback too', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await feedback(jar, { action: 'consent', consent: { store: true } });
  await feedback(jar, { action: 'add', entry: ENTRY() });
  assert.ok(await store.get(fitFeedback.key(user.id)));
  const del = await call(profileEndpoint, { jar, body: { action: 'delete' } });
  assert.strictEqual(del.status, 200);
  assert.strictEqual(await store.get(fitFeedback.key(user.id)), null);
});

section('privacy');

await test('/api/account says nothing about suggestions or feedback', async () => {
  const { jar } = await signUp('ada@example.test');
  await feedback(jar, { action: 'consent', consent: { store: true } });
  await feedback(jar, { action: 'add', entry: ENTRY() });
  const { body } = await call(accountEndpoint, { method: 'GET', jar });
  const text = JSON.stringify(body);
  ['feedback', 'sizeTried', UQ_HOODIE, 'recommend'].forEach((w) => assert.ok(!text.includes(w), `/api/account carries ${w}`));
});

await test('a store that fails answers a plain 500 and logs only the store’s own message', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await fitProfiles.save(user.id, { schemaVersion: 4, measurements: { unit: 'in', chest: 40 } });
  await feedback(jar, { action: 'consent', consent: { store: true } });
  const original = store.get;
  store.get = async function (key) {
    if (/^fit(profile|feedback):/.test(String(key))) throw new Error('store GET failed with 500');
    return original.apply(store, arguments);
  };
  try {
    const s1 = await suggest(jar, UQ_HOODIE);
    assert.strictEqual(s1.status, 500);
    const s2 = await feedback(jar, { action: 'add', entry: ENTRY() });
    assert.strictEqual(s2.status, 500);
    assert.ok(!JSON.stringify([s1.body, s2.body]).includes(UQ_HOODIE));
  } finally {
    store.get = original;
  }
  const all = logged.join('\n');
  assert.ok(/Size recommendation failed store GET failed with 500/.test(all));
  assert.ok(/Fit feedback failed store GET failed with 500/.test(all));
});

await test('no measurement, size, product or feedback answer appears in the logs', () => {
  const all = logged.join('\n');
  assert.ok(all.length > 0, 'something was logged, or this proves nothing');
  [UQ_HOODIE, NIKE_HOODIE, 'sizeTried', 'too-small', 'sleeves', '"overall"', 'chest', 'consent'].forEach((w) => assert.ok(!all.includes(w), `${w} was logged`));
});

out(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length ? 1 : 0);
})();
