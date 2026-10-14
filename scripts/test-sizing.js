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
     - the six records are verified by a named check, and unverified
       data never gives a size outside the evaluation suite
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
const NIKE_CREW = 'nike-fn3886-club-fleece-crew-us';
const CARHARTT_HOODIE = 'carhartt-k121-loose-fit-midweight-hoodie-us';
const CARHARTT_CREW = 'carhartt-k124-loose-fit-midweight-crewneck-us';
const copy = (id) => JSON.parse(JSON.stringify(sizing.byId(id)));
const unverifiedCopy = (id) => Object.assign(copy(id), { verification: { status: 'unverified', checkedBy: null, checkedAt: null } });
const verifiedCopy = (id) => Object.assign(copy(id), { verification: { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-10' } });
const profileWith = (garment, extra) => {
  const p = Object.assign(Schema.empty(), extra || {});
  p.garments.hoodies = Object.assign(Schema.emptyGarment('hoodies'), garment);
  p.garments.sweatshirts = Object.assign(Schema.emptyGarment('sweatshirts'), garment);
  return p;
};
const chest = (c, unit) => ({ measurements: { unit: unit || 'in', height: null, chest: c, waist: null, hip: null } });

/* with every record marked unverified in memory, for the gate */
async function withUnverifiedRecords(fn) {
  const saved = sizing.RECORDS.map((r) => Object.assign({}, r.verification));
  sizing.RECORDS.forEach((r) => Object.assign(r.verification, { status: 'unverified', checkedBy: null, checkedAt: null }));
  try { await fn(); } finally { sizing.RECORDS.forEach((r, i) => { Object.keys(r.verification).forEach((k) => delete r.verification[k]); Object.assign(r.verification, saved[i]); }); }
}

(async () => {

section('sizing records');

await test('all ten records load, each from the brand\'s own site: the six fleece tops verified by the source audit, the four T-shirts not yet', () => {
  assert.deepStrictEqual(sizing.problems, []);
  assert.strictEqual(sizing.RECORDS.length, 10);
  assert.deepStrictEqual([...new Set(sizing.RECORDS.map((r) => r.brand))].sort(), ['Carhartt', 'H&M', 'Nike', 'UNIQLO', 'Zara']);
  assert.deepStrictEqual([...new Set(sizing.RECORDS.map((r) => r.category))].sort(), ['hoodies', 'sweatshirts', 'tshirts']);
  sizing.RECORDS.forEach((r) => {
    if (r.category === 'tshirts') {
      /* copied from the brands' pages on 2026-10-14; only an approved
         check against those pages may mark them verified */
      assert.deepStrictEqual(r.verification, { status: 'unverified', checkedBy: null, checkedAt: null }, r.id);
      assert.ok(!sizingSchema.isVerified(r), r.id);
    } else {
      assert.deepStrictEqual(r.verification, { status: 'verified', checkedBy: 'claude-code-source-audit', checkedAt: '2026-10-10' }, r.id);
      assert.ok(sizingSchema.isVerified(r), r.id);
    }
    /* the official source and the brand's own words stay on the record */
    assert.ok(sizingSchema.OFFICIAL_HOSTS[r.brand].includes(new URL(r.product.url).hostname), r.id);
    Object.values(r.charts).forEach((chart) => Object.values(chart.dimensions).forEach((d) => {
      assert.ok(sizingSchema.OFFICIAL_HOSTS[r.brand].includes(new URL(d.methodSource.url).hostname), `${r.id}: ${d.label}`);
      assert.ok(/"/.test(d.methodSource.says), `${r.id}: ${d.label} quotes the brand`);
    }));
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
    if (r.charts.body) assert.strictEqual(r.charts.body.dimensions.chest.method, 'body-circumference', `${r.id}: body chest`);
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
    /* "23 ½" and H&M's "30¾-33¾" alike */
    const n = (t) => t.replace(/ ?¼/g, '.25').replace(/ ?½/g, '.5').replace(/ ?¾/g, '.75').replace(/\s*-\s*/, ' - ');
    if ('value' in cell) assert.strictEqual(Number(n(cell.text)), cell.value, `${r.id}: ${cell.text}`);
    else assert.strictEqual(n(cell.text), `${cell.min} - ${cell.max}`, `${r.id}: ${cell.text}`);
  }))));
});

await test('who a product is for, what its chart is called, and what a flat width can say are kept apart', () => {
  /* Nike: sold to men, on a chart Nike calls gender-neutral, men's-based */
  [NIKE_HOODIE, NIKE_CREW].forEach((id) => {
    const r = sizing.byId(id);
    assert.strictEqual(r.product.audience, 'men', id);
    assert.strictEqual(r.line, 'men', id);
    assert.strictEqual(r.charts.body.designation, 'gender-neutral, men\'s-based', id);
    assert.strictEqual(r.charts.body.title, 'Gender Neutral (Men\'s Based) Size Chart', id);
    assert.strictEqual(r.charts.body.source, 'https://www.nike.com/size-fit/gender-neutral-clothing-mens-based-alpha', id);
    assert.ok(r.sources.some((s) => s.url === r.charts.body.source), id);
  });
  /* UNIQLO: body chest ranges in one chart, flat garment widths in another; doubling one is an estimate */
  [UQ_HOODIE, UQ_SWEAT].forEach((id) => {
    const r = sizing.byId(id);
    assert.strictEqual(r.charts.body.measures, 'body', id);
    assert.strictEqual(r.charts.body.dimensions.chest.kind, 'range', id);
    assert.ok(!('chestWidth' in r.charts.body.dimensions), id);
    assert.strictEqual(r.charts.garment.measures, 'finished-garment', id);
    assert.ok(!('chest' in r.charts.garment.dimensions), id);
    const d = r.charts.garment.dimensions.chestWidth.derivedCircumference;
    assert.strictEqual(d.status, 'estimated', id);
    assert.strictEqual(d.factor, 2, id);
    assert.match(d.derivation, /2 × the published flat width/, id);
    Object.values(r.charts.garment.sizes).forEach((row) => assert.deepStrictEqual(Object.keys(row.chestWidth).sort(), ['text', 'value'], `${id}: no derived value is stored`));
  });
  /* Carhartt: body measurements; heading, page title and garment type each kept */
  [[CARHARTT_HOODIE, 'Marquette Sweatshirt', "Men's Marquette Loose Fit Midweight Hoodie | Carhartt", 'pullover-hoodie'],
    [CARHARTT_CREW, 'Marquette Crewneck Sweatshirt', "Men's Marquette Loose Fit Midweight Crewneck Sweatshirt | Carhartt", 'crewneck-sweatshirt']].forEach(([id, heading, title, type]) => {
    const r = sizing.byId(id);
    assert.deepStrictEqual(Object.keys(r.charts), ['body'], id);
    assert.strictEqual(r.charts.body.measures, 'body', id);
    assert.strictEqual(r.charts.body.dimensions.chest.method, 'body-circumference', id);
    assert.deepStrictEqual([r.product.name, r.product.pageTitle, r.product.garmentType], [heading, title, type], id);
  });
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
  assert.ok(bad((r) => { delete r.charts.garment.dimensions.chestWidth.derivedCircumference; }).includes('charts.garment.dimensions.chestWidth.derivedCircumference'), 'a flat width says how a circumference is derived');
  assert.ok(bad((r) => { r.charts.garment.dimensions.chestWidth.derivedCircumference.status = 'verified'; }).includes('charts.garment.dimensions.chestWidth.derivedCircumference'), 'a doubled flat width is never verified');
  assert.ok(bad((r) => { r.product.audience = 'everyone'; }).includes('product.audience'));
  assert.ok(bad((r) => { r.charts.body.designation = ''; }).includes('charts.body.designation'));
  /* checked by somebody, dated: then it is verified */
  assert.deepStrictEqual(sizingSchema.validate(verifiedCopy(UQ_HOODIE)), []);
});

section('the engine');

await test('unverified data never gives a size; verified data does, and says so', () => {
  const profile = profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40));
  const refused = engine.recommend(profile, unverifiedCopy(UQ_HOODIE));
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
  assert.ok(!r.reasons.some((x) => /^Sleeves: (?!not compared)/.test(x)), `sleeves compared across methods: ${r.reasons.join(' | ')}`);
  /* and it says why it left them out */
  assert.ok(r.reasons.some((x) => /^Sleeves: not compared — measured differently/.test(x)), r.reasons.join(' | '));
  assert.ok(r.reasons.some((x) => /^Chest/.test(x)));
});

await test('a chest in centimetres is converted exactly, never relabelled', () => {
  const inches = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40)), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  const cm = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(101.6, 'cm')), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.deepStrictEqual(cm.ranking, inches.ranking);
  assert.ok(cm.reasons[0].includes('101.6 cm'), cm.reasons[0]);
  /* the per-size classes too: the same chest, the same feel */
  const classes = (r) => r.fitBySize.map((f) => [f.size, f.dimensions.chestWidth.class, f.dimensions.chestWidth.couldBe || null]);
  assert.deepStrictEqual(classes(cm), classes(inches));
});

await test('each size is assessed dimension by dimension, and only where the evidence reaches', () => {
  const r = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40)), sizing.byId(UQ_HOODIE));
  assert.strictEqual(r.fitScale.basis, 'garment-vs-body');
  assert.match(r.fitScale.note, /hypotheses/);
  const m = r.fitBySize.find((f) => f.size === 'M');
  assert.strictEqual(m.dimensions.chestWidth.class, 'about-right');
  assert.deepStrictEqual(m.dimensions.chestWidth.ease, { value: 7, lo: 6.5, hi: 7.5, aim: [5, 9] });
  assert.deepStrictEqual(m.assessed, ['chestWidth']);
  ['bodyLength', 'sleeveLength', 'shoulderWidth'].forEach((d) => {
    assert.strictEqual(m.dimensions[d].class, null, d);
    assert.match(m.dimensions[d].reason, /no measurement of your/, d);
  });
  assert.ok(r.caveats.some((c) => /How M will feel through the length, sleeves, shoulders can't be told/.test(c)), r.caveats.join(' | '));
  assert.strictEqual(r.tradeoffs[0], 'M: chest about right; length, sleeves, shoulders: not enough data.');
  /* the order of the sizes is the ranking's, unchanged */
  assert.deepStrictEqual(r.fitBySize.slice().sort((a, b) => a.rank - b.rank).map((f) => f.size), r.ranking.map((x) => x.size));

  /* a body chart says who a size is cut for, never how it feels */
  const nike = engine.recommend(profileWith({ fitGoal: 'true-to-size', line: 'men' }, chest(40)), sizing.byId(NIKE_HOODIE));
  assert.strictEqual(nike.fitScale.basis, 'body-chart');
  assert.match(nike.fitScale.note, /can't say how much room any size has/);
  nike.fitBySize.forEach((f) => Object.values(f.dimensions).forEach((x) => assert.strictEqual(x.class, null, f.size)));
  assert.strictEqual(nike.fitBySize.find((f) => f.size === 'M').dimensions.chestWidth.chart.yourChest, 'inside');
});

await test('each class says whether it rests on verified, estimated or unknown measurements', () => {
  const tts = { fitGoal: 'true-to-size', line: 'men' };
  /* a doubled flat width is an estimate; what has no class is unknown */
  const m = engine.recommend(profileWith(tts, chest(40)), sizing.byId(UQ_HOODIE)).fitBySize.find((f) => f.size === 'M').dimensions;
  assert.strictEqual(m.chestWidth.measurements, 'estimated');
  assert.deepStrictEqual(m.chestWidth.estimated, ['garment chest around, as twice its flat width']);
  ['bodyLength', 'sleeveLength', 'shoulderWidth'].forEach((d) => assert.strictEqual(m[d].measurements, 'unknown', d));
  /* published lengths against a verified garment that fits: verified */
  const ref = engine.recommend(profileWith(Object.assign({ anchor: { brand: 'UNIQLO', size: 'L' } }, tts)), sizing.byId(UQ_HOODIE)).fitBySize.find((f) => f.size === 'M').dimensions;
  assert.deepStrictEqual(['bodyLength', 'sleeveLength', 'shoulderWidth'].map((d) => [ref[d].class, ref[d].measurements]),
    [['slightly-short', 'verified'], ['slightly-short', 'verified'], ['slightly-tight', 'verified']]);
  assert.strictEqual(ref.chestWidth.measurements, 'estimated', 'a difference of doubled flat widths is an estimate');
  /* a chest inferred from another brand's chart is an estimate too */
  const inferred = engine.recommend(profileWith(Object.assign({ anchor: { brand: 'Nike', size: 'M' } }, tts)), sizing.byId(UQ_HOODIE)).fitBySize.find((f) => f.size === 'M').dimensions.chestWidth;
  assert.strictEqual(inferred.measurements, 'estimated');
  assert.ok(inferred.estimated.includes('your chest, from the chart for a size you wear'));
  /* the same comparison from records nobody has checked says so */
  const pool = [unverifiedCopy(UQ_HOODIE)];
  const unchecked = engine.recommend(profileWith(Object.assign({ anchor: { brand: 'UNIQLO', size: 'L' } }, tts)), pool[0], { includeUnverified: true, records: pool });
  assert.strictEqual(unchecked.fitBySize.find((f) => f.size === 'M').dimensions.bodyLength.measurements, 'unverified');
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
  assert.ok(r.dataQuality.estimated.includes('garment chest circumference, estimated as 2 × its published flat width (armpit to armpit)'));
  /* M's flat 23 ½ in is shown as a width, and its way around (47 in) is what meets 40 in + room */
  assert.ok(r.reasons.some((x) => /M measures 23½ in flat, about 47 in around/.test(x)), r.reasons.join(' | '));
  /* garment-to-garment needs no such step */
  const ref = engine.recommend(profileWith({ anchor: { brand: 'UNIQLO', size: 'M' }, fitGoal: 'true-to-size', line: 'men' }), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.ok(!ref.dataQuality.estimated.some((e) => /2 × its published flat width/.test(e)));
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
  assert.strictEqual(list.body.products.length, 10);
  assert.ok(list.body.products.every((p) => p.verified === (p.category !== 'tshirts')), 'the T-shirt records say they are not verified');
});

await test('an unknown or malformed product id is refused, and nothing is guessed', async () => {
  const { jar } = await signUp('ada@example.test');
  assert.strictEqual((await suggest(jar, 'not a product')).status, 400);
  assert.strictEqual((await suggest(jar, 'uniqlo-made-up-hoodie')).status, 404);
});

await test('with unverified records every suggestion is an honest "insufficient"', async () => withUnverifiedRecords(async () => {
  const { jar, user } = await signUp('ada@example.test');
  await fitProfiles.save(user.id, { schemaVersion: 4, measurements: { unit: 'in', chest: 40 } });
  await fitProfiles.saveGuide(user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });
  for (const r of sizing.RECORDS) {
    const { status, body } = await suggest(jar, r.id);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.recommendation.status, 'insufficient', r.id);
    assert.strictEqual(body.recommendation.missing[0].code, 'unverified-data');
  }
}));

await test('verified, it suggests from the caller\'s own profile and nobody else\'s', async () => {
  const ada = await signUp('ada@example.test');
  const bea = await signUp('bea@example.test');
  await fitProfiles.save(ada.user.id, { schemaVersion: 4, measurements: { unit: 'in', chest: 40 } });
  await fitProfiles.saveGuide(ada.user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });
  await fitProfiles.save(bea.user.id, { schemaVersion: 4, measurements: { unit: 'in', chest: 46 } });
  await fitProfiles.saveGuide(bea.user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });

  const adas = (await suggest(ada.jar, UQ_HOODIE)).body.recommendation;
  assert.strictEqual(adas.status, 'ok');
  /* the existing answer is unchanged in shape; how each size may feel is added beside it */
  ['productId', 'product', 'method', 'leading', 'alternative', 'confidence', 'reasons', 'ranking', 'fitGoal', 'dataQuality', 'dataStatus', 'caveats', 'notes', 'fitBySize', 'fitScale', 'tradeoffs']
    .forEach((k) => assert.ok(k in adas, k));
  assert.strictEqual(adas.fitBySize.find((f) => f.size === 'M').dimensions.chestWidth.class, 'about-right');
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

await test('a signed-in caller with no profile is told what is missing, not given a size', async () => {
  const { jar } = await signUp('ada@example.test');
  const r = (await suggest(jar, NIKE_HOODIE)).body.recommendation;
  assert.strictEqual(r.status, 'insufficient');
  assert.strictEqual(r.missing[0].code, 'no-evidence');
  assert.ok(r.next.some((n) => /chest measurement/.test(n)));
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

section('the favourite T-shirt');

const UQ_TEE = 'uniqlo-e455365-supima-cotton-tshirt-us';
const NIKE_TEE = 'nike-ih1121-premium-essentials-tshirt-us';
const HM_TEE = 'hm-0685816-regular-fit-tshirt-us';
const ZARA_TEE = 'zara-01887411-basic-medium-weight-tshirt-us';
const UQ_TEE_LINK = 'https://www.uniqlo.com/us/en/products/E455365-000/00';
const tee = (entry, extra) => {
  const p = Object.assign(Schema.empty(), extra || {});
  p.garments.tshirts = Object.assign(Schema.emptyGarment('tshirts'), entry);
  return p;
};
const teePool = (...ids) => ids.map(verifiedCopy);
/* a T-shirt measured at home, laid flat, in inches */
const MEASURED = { unit: 'in', chestWidth: 21.5, shoulderWidth: 18.5, sleeveLength: 8, bodyLength: 27 };

await test('the T-shirt records keep what each brand publishes: UNIQLO both charts, Zara garment only, Nike and H&M body only', () => {
  assert.deepStrictEqual(Object.keys(sizing.byId(UQ_TEE).charts).sort(), ['body', 'garment']);
  assert.deepStrictEqual(Object.keys(sizing.byId(ZARA_TEE).charts), ['garment']);
  assert.deepStrictEqual(Object.keys(sizing.byId(NIKE_TEE).charts), ['body']);
  assert.deepStrictEqual(Object.keys(sizing.byId(HM_TEE).charts), ['body']);
  /* both garment chests are flat widths, and each says how a circumference would be worked out */
  [UQ_TEE, ZARA_TEE].forEach((id) => {
    const chest = sizing.byId(id).charts.garment.dimensions.chestWidth;
    assert.strictEqual(chest.method, 'flat-width-armpit-to-armpit', id);
    assert.strictEqual(chest.derivedCircumference.status, 'estimated', id);
  });
  /* measured differently, and kept so */
  assert.strictEqual(sizing.byId(UQ_TEE).charts.garment.dimensions.sleeveLength.method, 'center-back-to-cuff');
  assert.strictEqual(sizing.byId(ZARA_TEE).charts.garment.dimensions.sleeveLength.method, 'shoulder-seam-to-cuff');
  assert.strictEqual(sizing.byId(UQ_TEE).charts.garment.sizes.M.chestWidth.text, '21 ½');
  assert.strictEqual(sizing.byId(ZARA_TEE).charts.garment.sizes.M.chestWidth.value, 21.7);
  /* each fit word is the product's own, not the brand's in general */
  assert.deepStrictEqual([UQ_TEE, NIKE_TEE, HM_TEE, ZARA_TEE].map((id) => sizing.byId(id).fit.fitClass), ['regular', 'loose', 'regular', 'regular']);
});

await test('no brand is given a fit by rule: the engine\'s code names no brand', () => {
  const code = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', '_sizing', 'engine.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\b(Nike|UNIQLO|Uniqlo|H&M|Zara|Carhartt)\b/.test(code), 'a brand is named in the engine\'s logic');
});

await test('a favourite found in the catalogue by its link is compared garment to garment, and only where both measure the same way', () => {
  const profile = tee({ favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { name: null, url: UQ_TEE_LINK } } });
  const r = engine.recommend(profile, verifiedCopy(ZARA_TEE), { records: teePool(UQ_TEE, ZARA_TEE) });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.method, 'reference-garment');
  assert.deepStrictEqual(r.anchor.match, { id: UQ_TEE, by: 'link', name: 'SUPIMA® Cotton T-Shirt', size: 'M' });
  assert.strictEqual(r.anchor.source, 'product');
  assert.deepStrictEqual(r.anchor.compared.map((c) => c.dim), ['chestWidth', 'shoulderWidth']);
  assert.deepStrictEqual(r.anchor.notCompared.map((c) => c.dim), ['bodyLength', 'sleeveLength']);
  assert.ok(r.anchor.notCompared.every((c) => /measured differently/.test(c.why)));
  assert.ok(r.reasons[0].includes('UNIQLO SUPIMA® Cotton T-Shirt in M'), r.reasons[0]);
  assert.ok(r.reasons.some((x) => /^Length: not compared — measured differently — Zara's from the top of the shoulder, UNIQLO's from the centre back/.test(x)), r.reasons.join(' | '));
  assert.strictEqual(r.leading, 'S');
  /* two measurements of four: not high, whatever the gap */
  assert.strictEqual(r.confidence, 'medium');
  /* not a letter translated: Medium in one brand is not taken as any size in the other */
  assert.ok(!r.reasons.some((x) => /M in UNIQLO is|runs (small|large)/.test(x)));
  /* the same, found by its name */
  const byName = engine.recommend(tee({ favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { name: 'Supima Cotton T-Shirt', url: null } } }), verifiedCopy(ZARA_TEE), { records: teePool(UQ_TEE, ZARA_TEE) });
  assert.strictEqual(byName.anchor.match.by, 'name');
  assert.deepStrictEqual(byName.ranking, r.ranking);
});

await test('what makes the favourite fit well decides between sizes, and "close" lowers confidence', () => {
  const pool = teePool(UQ_TEE, ZARA_TEE);
  const base = { brand: 'UNIQLO', size: 'M', product: { url: UQ_TEE_LINK } };
  /* UNIQLO M is 21½ in flat and 17½ in across the shoulders; Zara S is
     20.9 and 18.1, Zara M 21.7 and 18.9 */
  const chest = engine.recommend(tee({ favorite: 'close', anchor: Object.assign({ likes: ['chest'] }, base) }), verifiedCopy(ZARA_TEE), { records: pool });
  const shoulders = engine.recommend(tee({ favorite: 'close', anchor: Object.assign({ likes: ['shoulders'] }, base) }), verifiedCopy(ZARA_TEE), { records: pool });
  assert.strictEqual(chest.leading, 'M', 'the chest is what fits: the closest chest');
  assert.strictEqual(shoulders.leading, 'S', 'the shoulders are what fit: the closest shoulders');
  assert.strictEqual(chest.confidence, 'low', 'close, two measurements');
  assert.ok(chest.caveats.some((c) => /close to the fit you like/.test(c)));
  const perfect = engine.recommend(tee({ favorite: 'perfect', anchor: Object.assign({ likes: ['chest'] }, base) }), verifiedCopy(ZARA_TEE), { records: pool });
  assert.strictEqual(perfect.confidence, 'medium');
});

await test('the shopper\'s own measurements are compared measurement by measurement, and never called published', () => {
  const pool = teePool(ZARA_TEE);
  const r = engine.recommend(tee({ favorite: 'perfect', anchor: { brand: 'Gap', size: 'M', measurements: MEASURED } }), verifiedCopy(ZARA_TEE), { records: pool });
  assert.strictEqual(r.method, 'reference-garment');
  assert.strictEqual(r.anchor.source, 'measured');
  assert.deepStrictEqual(r.anchor.compared.map((c) => c.dim), ['chestWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth']);
  assert.strictEqual(r.leading, 'M');
  assert.strictEqual(r.confidence, 'medium', 'measured at home: never high');
  assert.ok(r.caveats.some((c) => /measured at home/.test(c)));
  assert.ok(r.reasons[0].startsWith('Compared with the measurements you took of your Gap T-shirt (M on the label)'), r.reasons[0]);
  /* the same garment in centimetres gives the same answer */
  const cm = { unit: 'cm' };
  ['chestWidth', 'shoulderWidth', 'sleeveLength', 'bodyLength'].forEach((k) => { cm[k] = MEASURED[k] * 2.54; });
  const inCm = engine.recommend(tee({ favorite: 'perfect', anchor: { brand: 'Gap', size: 'M', measurements: cm } }), verifiedCopy(ZARA_TEE), { records: pool });
  assert.deepStrictEqual(inCm.ranking, r.ranking);
  /* against a product that publishes only who each size is cut for, there is nothing to compare */
  for (const id of [NIKE_TEE, HM_TEE]) {
    const none = engine.recommend(tee({ favorite: 'perfect', anchor: { measurements: MEASURED } }), verifiedCopy(id), { records: teePool(id) });
    assert.strictEqual(none.status, 'insufficient', id);
    assert.strictEqual(none.missing[0].code, 'incompatible-measurements', id);
    assert.ok(!('leading' in none));
  }
});

await test('brand and size alone is a weaker reference: a chest range from the brand\'s chart, never another product\'s garment', () => {
  /* UNIQLO M, no product: Zara is not compared with the Supima's garment measurements */
  const pool = teePool(UQ_TEE, ZARA_TEE);
  const r = engine.recommend(tee({ favorite: 'perfect', line: 'men', anchor: { brand: 'UNIQLO', size: 'M' } }), verifiedCopy(ZARA_TEE), { records: pool });
  assert.strictEqual(r.method, 'body-plus-ease');
  assert.strictEqual(r.anchor.source, 'brand-size');
  assert.strictEqual(r.anchor.usedAs, 'chest-range');
  assert.strictEqual(r.confidence, 'low');
  assert.ok(r.caveats.some((c) => /weaker reference/.test(c)), r.caveats.join(' | '));
  assert.ok(r.dataQuality.estimated.some((e) => /your chest, from the chart/.test(e)));
  /* Nike M against a Nike T-shirt: the chart size stands — no fit goal was said, so "Loose" moves nothing */
  const nike = engine.recommend(tee({ favorite: 'perfect', line: 'men', anchor: { brand: 'Nike', size: 'M' } }), verifiedCopy(NIKE_TEE), { records: teePool(NIKE_TEE) });
  assert.strictEqual(nike.method, 'body-chart');
  assert.strictEqual(nike.leading, 'M');
  assert.ok(!nike.reasons.some((x) => /aims one size/.test(x)));
  assert.strictEqual(nike.confidence, 'low');
  /* without the sizing line, the label can't be read at all — and it says what would help */
  const noLine = engine.recommend(tee({ favorite: 'perfect', anchor: { brand: 'Nike', size: 'M' } }), verifiedCopy(NIKE_TEE), { records: teePool(NIKE_TEE) });
  assert.strictEqual(noLine.status, 'insufficient');
  assert.deepStrictEqual(noLine.missing.map((m) => m.code), ['anchor-unmeasured', 'line-needed', 'no-evidence']);
  assert.ok(noLine.next.some((n) => /Measure your favourite T-shirt laid flat/.test(n)));
});

await test('a named product Fynd has no sizing for is kept as context, and nothing is made up for it', () => {
  const r = engine.recommend(tee({ favorite: 'perfect', anchor: { brand: 'Uniqlo', size: 'M', product: { name: 'AIRism Cotton Oversized T-Shirt', url: 'https://www.uniqlo.com/us/en/products/E465185-000/00' } } }),
    verifiedCopy(ZARA_TEE), { records: teePool(UQ_TEE, ZARA_TEE) });
  assert.strictEqual(r.status, 'insufficient');
  assert.strictEqual(r.anchor.match, null);
  assert.ok(r.notes.some((n) => /no sizing for the product you named/.test(n)));
});

await test('unverified T-shirt data gives no size: neither the product shopped for nor the favourite\'s', () => {
  /* as shipped: the T-shirt records are unverified */
  const profile = tee({ favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: UQ_TEE_LINK } } });
  const shipped = engine.recommend(profile, sizing.byId(ZARA_TEE));
  assert.strictEqual(shipped.status, 'insufficient');
  assert.strictEqual(shipped.missing[0].code, 'unverified-data');
  /* the product verified, the favourite's record not: the favourite isn't used */
  const half = engine.recommend(profile, verifiedCopy(ZARA_TEE), { records: [copy(UQ_TEE), verifiedCopy(ZARA_TEE)] });
  assert.strictEqual(half.status, 'insufficient');
  assert.ok(half.notes.some((n) => /hasn't been checked against UNIQLO's chart yet/.test(n)), half.notes.join(' | '));
});

await test('a favourite T-shirt never stands in for a hoodie, and a T-shirt chart never for a hoodie\'s', () => {
  const profile = tee({ favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: UQ_TEE_LINK }, measurements: MEASURED } });
  const r = engine.recommend(profile, sizing.byId(UQ_HOODIE), { records: [verifiedCopy(UQ_TEE), sizing.byId(UQ_HOODIE)] });
  assert.strictEqual(r.status, 'insufficient');
  assert.strictEqual(r.anchor, null, 'the hoodie answer has no favourite in it');
  /* a usual hoodie size never stands in for a T-shirt's garment */
  const viaHoodie = engine.recommend(tee({}, { brandSizes: [{ brand: 'UNIQLO', category: 'hoodies', size: 'M', fit: 'about-right' }] }), verifiedCopy(ZARA_TEE), { records: [sizing.byId(UQ_HOODIE), verifiedCopy(ZARA_TEE)] });
  assert.notStrictEqual(viaHoodie.method, 'reference-garment');
});

await test('/api/size-recommendation reads the saved favourite, for its owner only, and says honestly when the data is unchecked', async () => {
  const { jar, user } = await signUp('ada@example.test');
  const saved = await fitProfiles.saveGuide(user.id, { garments: { tshirts: { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: `${UQ_TEE_LINK}?colorDisplayCode=07` } } } } });
  assert.deepStrictEqual(saved.errors, []);
  /* as shipped, unverified: an honest "insufficient" */
  const shipped = await suggest(jar, ZARA_TEE);
  assert.strictEqual(shipped.status, 200);
  assert.strictEqual(shipped.body.recommendation.status, 'insufficient');
  assert.strictEqual(shipped.body.recommendation.missing[0].code, 'unverified-data');
  /* once both records are checked, the favourite is used end to end */
  const marks = [UQ_TEE, ZARA_TEE].map((id) => sizing.byId(id).verification);
  const before = marks.map((m) => Object.assign({}, m));
  try {
    marks.forEach((m) => Object.assign(m, { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-14' }));
    const ok = (await suggest(jar, ZARA_TEE)).body.recommendation;
    assert.strictEqual(ok.status, 'ok');
    assert.strictEqual(ok.anchor.source, 'product');
    assert.strictEqual(ok.leading, 'S');
    /* someone else's session reads their own (empty) profile, never Ada's */
    const bob = await signUp('bob@example.test');
    const theirs = (await suggest(bob.jar, ZARA_TEE)).body.recommendation;
    assert.strictEqual(theirs.status, 'insufficient');
    assert.strictEqual(theirs.anchor, null);
  } finally {
    marks.forEach((m, i) => { Object.keys(m).forEach((k) => delete m[k]); Object.assign(m, before[i]); });
  }
  assert.strictEqual((await suggest({}, ZARA_TEE)).status, 401);
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
