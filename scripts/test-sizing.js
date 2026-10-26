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
/* a copy marked checked in this test's memory: verified, with no review left pending */
const verifiedCopy = (id) => { const r = Object.assign(copy(id), { verification: { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-10' } }); delete r.review; return r; };
/* the UNIQLO pair, marked checked in memory for a test of logic on their real numbers */
const { asChecked, UQ_PAIR } = require('./fixtures/as-checked');
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

/* the six records approved by the source audit of 2026-10-10; every
   other record waits for its own approved check */
const VERIFIED_IDS = [NIKE_HOODIE, NIKE_CREW, CARHARTT_HOODIE, CARHARTT_CREW];

await test('all fifteen records load, each from the brand\'s own site: the four audited body-chart records verified, the UNIQLO pair pending review, every other record not yet', () => {
  /* the UNIQLO pair: their only check was an automated source audit, and their identical tables still need a person to confirm them */
  UQ_PAIR.forEach((id) => {
    const r = sizing.byId(id);
    assert.ok(!sizingSchema.isVerified(r), id);
    assert.strictEqual(r.review.status, 'pending', id);
    assert.match(r.review.needs, /A person compares the Product Size tab/, id);
    assert.ok(r.notes.some((n) => /verification withdrawn/.test(n) && /claude-code-source-audit/.test(n)), `${id}: says why, and what the old check was`);
  });
  assert.deepStrictEqual(sizing.problems, []);
  assert.strictEqual(sizing.RECORDS.length, 15);
  assert.deepStrictEqual([...new Set(sizing.RECORDS.map((r) => r.brand))].sort(), ['Carhartt', 'H&M', 'Nike', 'UNIQLO', 'Zara']);
  assert.deepStrictEqual([...new Set(sizing.RECORDS.map((r) => r.category))].sort(), ['hoodies', 'sweatshirts', 'tshirts']);
  sizing.RECORDS.forEach((r) => {
    if (!VERIFIED_IDS.includes(r.id)) {
      /* copied from the brands' pages; only an approved check against
         those pages may mark them verified */
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
    /* Zara's hoodies are kept in centimetres, the unit Zara measures in */
    assert.ok(r.retrievedAt && r.region === 'US' && (r.units === 'in' || (r.brand === 'Zara' && r.units === 'cm')), r.id);
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
    /* "23 ½", H&M's "30¾-33¾" and the "25 1/4" of a table transcribed as supplied alike */
    const n = (t) => t.replace(/ 1\/4\b/g, '.25').replace(/ 1\/2\b/g, '.5').replace(/ 3\/4\b/g, '.75')
      .replace(/ ?¼/g, '.25').replace(/ ?½/g, '.5').replace(/ ?¾/g, '.75').replace(/\s*-\s*/, ' - ');
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

await test('unverified data never gives a size; verified data does, and says so', () => asChecked(UQ_PAIR, () => {
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
}));

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

await test('each size is assessed dimension by dimension, and only where the evidence reaches', () => asChecked(UQ_PAIR, () => {
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
}));

await test('each class says whether it rests on verified, estimated or unknown measurements', () => asChecked(UQ_PAIR, () => {
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
}));

await test('a letter size is read only with its sizing line, and never from a brand without a chart', () => {
  const r = engine.recommend(profileWith({ anchor: { brand: 'Nike', size: 'M' }, fitGoal: 'true-to-size', line: null }), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.strictEqual(r.status, 'insufficient');
  assert.ok(r.missing.some((m) => m.code === 'line-needed'));
  const gap = engine.recommend(profileWith({ anchor: { brand: 'Gap', size: 'M' }, fitGoal: 'true-to-size', line: 'men' }), sizing.byId(UQ_HOODIE), { includeUnverified: true });
  assert.ok(gap.notes.some((n) => /no Gap size chart/.test(n)), gap.notes.join(' | '));
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
  assert.strictEqual(list.body.products.length, 15);
  assert.ok(list.body.products.every((p) => p.verified === VERIFIED_IDS.includes(p.id)), 'only the audited records say they are verified');
  /* only a checked record with finished-garment measurements can be compared: none, while the UNIQLO pair is pending review */
  assert.deepStrictEqual(list.body.products.filter((p) => p.comparable).map((p) => p.id), []);
});

/* a comparison with a garment that isn't saved: POST, the garment in the body */
const compareUnsaved = (jar, product, body, query) => call(recommendEndpoint, {
  jar, method: 'POST', body,
  query: Object.assign({ product, compare: '1' }, query || {}),
  url: `/api/size-recommendation?product=${product}&compare=1`
});
const UQ_REF = { type: 'sweatshirts', garment: { favorite: 'perfect', line: 'men', anchor: { brand: 'UNIQLO', size: 'S', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } };

await test('a garment not saved is compared without an account: the same engine and rules, the garment from the body only — production\'s unchecked pair gives no numbers', async () => {
  const unchecked = await compareUnsaved({}, UQ_HOODIE, { reference: UQ_REF });
  assert.strictEqual(unchecked.status, 200);
  assert.strictEqual(unchecked.res.getHeader('cache-control'), 'no-store, private');
  assert.deepStrictEqual([unchecked.body.comparison.status, unchecked.body.comparison.missing[0].code], ['insufficient', 'unverified-data']);
  assert.ok(!('sizes' in unchecked.body.comparison) && !('recommended' in unchecked.body.comparison), 'not even a number for a guest');
  await asChecked(UQ_PAIR, async () => {
    const got = await compareUnsaved({}, UQ_HOODIE, { reference: UQ_REF }, { unit: 'cm' });
    const profile = Object.assign(Schema.empty(), { garments: { sweatshirts: Object.assign(Schema.emptyGarment('sweatshirts'), UQ_REF.garment) } });
    assert.deepStrictEqual(got.body.comparison, JSON.parse(JSON.stringify(engine.compare(profile, sizing.byId(UQ_HOODIE), { unit: 'cm' }))), 'exactly the engine\'s answer');
    assert.strictEqual(got.body.comparison.recommended, 'S');
  });
});

await test('a garment not saved never reads or writes a stored profile: signed in, the posted garment is the one compared, and the saved profile is unchanged', () => asChecked(UQ_PAIR, async () => {
  const { jar, user } = await signUp('ines@example.test');
  await fitProfiles.saveGuide(user.id, { garments: { sweatshirts: { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'XL', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } } });
  const before = JSON.stringify(await fitProfiles.read(user.id));
  const got = await compareUnsaved(jar, UQ_HOODIE, { reference: UQ_REF });
  assert.strictEqual(got.body.comparison.reference.size, 'S', 'the posted garment, not the saved XL');
  assert.strictEqual(got.body.comparison.recommended, 'S');
  assert.strictEqual(JSON.stringify(await fitProfiles.read(user.id)), before, 'nothing saved');
  /* and a guest leaves nothing behind */
  const guestBefore = logged.length;
  await compareUnsaved({}, UQ_HOODIE, { reference: UQ_REF });
  assert.strictEqual(logged.length, guestBefore, 'nothing logged');
}));

await test('a garment not saved is checked by the fit profile\'s own validator, and anything else is refused with why', async () => {
  const bad = async (body, reason, field) => {
    const r = await compareUnsaved({}, UQ_HOODIE, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.strictEqual(r.body.reason, reason);
    if (field) assert.ok(r.body.errors.some((e) => e.field === field), JSON.stringify(r.body.errors));
    assert.ok(!('comparison' in r.body));
  };
  await bad({}, 'invalid-reference');
  await bad({ reference: { type: 'jeans', garment: { anchor: { brand: 'Levi’s', size: '32' } } } }, 'invalid-reference');
  await bad({ reference: { type: 'hoodies', garment: [] } }, 'invalid-reference');
  await bad({ reference: { type: 'hoodies', garment: { anchor: { brand: 'Carhartt', size: 'L', measurements: { unit: 'cm', chestWidth: 120 } } } } }, 'invalid-reference', 'garments.hoodies.anchor.measurements.chestWidth');
  await bad({ reference: { type: 'hoodies', garment: { anchor: { brand: 'Carhartt', size: 'Huge' } } } }, 'invalid-reference', 'garments.hoodies.anchor.size');
  await bad({ reference: { type: 'hoodies', garment: { anchor: { brand: 'Carhartt', size: 'L', product: { url: 'javascript:alert(1)' } } } } }, 'invalid-reference', 'garments.hoodies.anchor.product.url');
  const unknown = await compareUnsaved({}, 'no-such-product', { reference: UQ_REF });
  assert.strictEqual(unknown.status, 404);
  const malformed = await compareUnsaved({}, 'NOT a product', { reference: UQ_REF });
  assert.strictEqual(malformed.status, 400);
  /* without an account, kept to a shopper's pace */
  const limits = require('../api/_ratelimit');
  const pace = (n) => call(recommendEndpoint, { jar: {}, method: 'POST', body: { reference: UQ_REF }, query: { product: UQ_HOODIE, compare: '1' }, url: '/api/size-recommendation', headers: { 'x-forwarded-for': '198.51.100.77' } });
  let last = null;
  for (let i = 0; i <= limits.LIMITS['sizing:compare-unsaved'].max; i += 1) last = await pace(i);
  assert.strictEqual(last.status, 429);
  assert.strictEqual(last.body.reason, 'rate-limited');
  /* POST is only for this comparison */
  const other = await call(recommendEndpoint, { jar: {}, method: 'POST', body: { reference: UQ_REF }, query: { product: UQ_HOODIE }, url: `/api/size-recommendation?product=${UQ_HOODIE}` });
  assert.strictEqual(other.status, 405);
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

await test('verified, it suggests from the caller\'s own profile and nobody else\'s', () => asChecked(UQ_PAIR, async () => {
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
}));

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
  assert.deepStrictEqual(Object.keys(added.body.entry).sort(), ['areas', 'asExpected', 'brand', 'category', 'createdAt', 'id', 'issues', 'notes', 'overall', 'productId', 'recommendedSize', 'reference', 'sizeTried']);
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

await test('a favourite found in the catalogue by its link is compared garment to garment only on enough measured the same way — UNIQLO\'s and Zara\'s tees share two, so it isn\'t', () => {
  const profile = tee({ favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { name: null, url: UQ_TEE_LINK } } });
  const r = engine.recommend(profile, verifiedCopy(ZARA_TEE), { records: teePool(UQ_TEE, ZARA_TEE) });
  /* found, by its link — and then not used as a garment: chest and shoulders alone are too few */
  assert.deepStrictEqual(r.anchor.match, { id: UQ_TEE, by: 'link', name: 'SUPIMA® Cotton T-Shirt', size: 'M' });
  assert.strictEqual(r.anchor.source, 'product');
  assert.notStrictEqual(r.method, 'reference-garment', 'no garment-to-garment size from two measurements');
  assert.notStrictEqual(r.anchor.usedAs, 'garment');
  assert.deepStrictEqual(r.anchor.compared, []);
  assert.ok(r.notes.includes('The UNIQLO M you said fits shares only chest and shoulders measured the same way with this product — too few to compare, so it wasn\'t compared.'), JSON.stringify(r.notes));
  /* what remains is the engine's separate, labelled estimate from the brand's body chart — never high */
  assert.strictEqual(r.method, 'body-plus-ease');
  assert.strictEqual(r.confidence, 'low');
  /* not a letter translated: Medium in one brand is not taken as any size in the other */
  assert.ok(!r.reasons.some((x) => /M in UNIQLO is|runs (small|large)/.test(x)));
  /* the same, found by its name */
  const byName = engine.recommend(tee({ favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { name: 'Supima Cotton T-Shirt', url: null } } }), verifiedCopy(ZARA_TEE), { records: teePool(UQ_TEE, ZARA_TEE) });
  assert.strictEqual(byName.anchor.match.by, 'name');
  assert.deepStrictEqual(byName.ranking, r.ranking);
});

await test('what makes the favourite fit well decides between sizes, and "close" lowers confidence', () => {
  const pool = teePool(ZARA_TEE);
  /* a tee measured at home, all four measured as Zara measures them: its
     chest sits nearest Zara M (21.7), its shoulders nearest Zara S (18.1) */
  const base = { brand: 'Gap', size: 'M', measurements: { unit: 'in', chestWidth: 21.3, shoulderWidth: 17.6, bodyLength: 27.6, sleeveLength: 8.5 } };
  const chest = engine.recommend(tee({ favorite: 'close', anchor: Object.assign({ likes: ['chest'] }, base) }), verifiedCopy(ZARA_TEE), { records: pool });
  const shoulders = engine.recommend(tee({ favorite: 'close', anchor: Object.assign({ likes: ['shoulders'] }, base) }), verifiedCopy(ZARA_TEE), { records: pool });
  assert.deepStrictEqual([chest.method, shoulders.method], ['reference-garment', 'reference-garment']);
  assert.strictEqual(chest.leading, 'M', 'the chest is what fits: the closest chest');
  assert.strictEqual(shoulders.leading, 'S', 'the shoulders are what fit: the closest shoulders');
  assert.strictEqual(chest.confidence, 'low', 'close, and measured at home');
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

await test('a favourite T-shirt never stands in for a hoodie, and a T-shirt chart never for a hoodie\'s', () => asChecked(UQ_PAIR, () => {
  const profile = tee({ favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: UQ_TEE_LINK }, measurements: MEASURED } });
  const r = engine.recommend(profile, sizing.byId(UQ_HOODIE), { records: [verifiedCopy(UQ_TEE), sizing.byId(UQ_HOODIE)] });
  assert.strictEqual(r.status, 'insufficient');
  assert.strictEqual(r.anchor, null, 'the hoodie answer has no favourite in it');
  /* a usual hoodie size never stands in for a T-shirt's garment */
  const viaHoodie = engine.recommend(tee({}, { brandSizes: [{ brand: 'UNIQLO', category: 'hoodies', size: 'M', fit: 'about-right' }] }), verifiedCopy(ZARA_TEE), { records: [sizing.byId(UQ_HOODIE), verifiedCopy(ZARA_TEE)] });
  assert.notStrictEqual(viaHoodie.method, 'reference-garment');
}));

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
    assert.strictEqual(ok.anchor.source, 'product', 'the saved favourite, found');
    /* found, but sharing too few measurements with Zara's tee to be set beside it */
    assert.notStrictEqual(ok.method, 'reference-garment');
    assert.ok(ok.notes.some((n) => /too few to compare/.test(n)), JSON.stringify(ok.notes));
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

section('compare before buying');

/* ILLUSTRATIVE FIXTURE — invented numbers for testing the arithmetic,
   not a real product's measurements. It is measured the way a shopper's
   reference is (chest flat, length from the top of the shoulder, sleeve
   from the shoulder seam, shoulders seam to seam), and marked verified
   only in this test's memory. */
const ILLUSTRATIVE = () => {
  const r = copy('zara-00761810-basic-heavyweight-hoodie-us');
  r.id = 'illustrative-test-hoodie';
  r.product = Object.assign({}, r.product, { name: 'Illustrative test hoodie (not a real product)', code: 'TEST0001' });
  r.sizes = ['S', 'M', 'L', 'XL'];
  const row = (chest, length, shoulder, sleeve) => ({
    chestWidth: { value: chest, text: String(chest) }, bodyLength: { value: length, text: String(length) },
    shoulderWidth: { value: shoulder, text: String(shoulder) }, sleeveLength: { value: sleeve, text: String(sleeve) }
  });
  r.charts.garment.sizes = { S: row(57, 65, 49, 61), M: row(60, 67, 51, 62), L: row(63, 69, 53, 63), XL: row(66, 71, 55, 64) };
  r.verification = { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-16' };
  r.material = { composition: 'Illustrative: 80% cotton, 20% polyester', stretch: null, source: 'test fixture' };
  return r;
};
/* a hoodie reference measured at home, laid flat */
const hoodieRef = (anchor, extra) => {
  const p = Object.assign(Schema.empty(), extra || {});
  p.garments.hoodies = Object.assign(Schema.emptyGarment('hoodies'), { favorite: 'perfect', anchor: Object.assign({ brand: 'Carhartt', size: 'L' }, anchor) });
  return p;
};
const REF_CM = { unit: 'cm', chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 };
const compareCall = (jar, product, unit) => call(recommendEndpoint, {
  method: 'GET', jar, query: Object.assign({ product, compare: '1' }, unit ? { unit } : {}),
  url: `/api/size-recommendation?product=${product}&compare=1${unit ? `&unit=${unit}` : ''}`
});

await test('all four signed differences are worked out for every size, in the reference\'s own unit', () => {
  const r = engine.compare(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE());
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.unit, 'cm');
  assert.deepStrictEqual(r.reference.values, { chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 });
  assert.deepStrictEqual(r.dimensionsCompared, ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength']);
  const m = r.sizes.find((s) => s.size === 'M').dimensions;
  assert.deepStrictEqual(['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'].map((d) => m[d].difference), [2, -1, 1, 0]);
  assert.deepStrictEqual(['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'].map((d) => m[d].words),
    ['Chest: 2 cm wider', 'Body length: 1 cm shorter', 'Shoulders: 1 cm wider', 'Sleeves: the same as your reference']);
  const s = r.sizes.find((x) => x.size === 'S').dimensions;
  assert.deepStrictEqual(['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'].map((d) => s[d].difference), [-1, -3, -1, -1]);
  /* every size, not just the one on the reference's label */
  assert.deepStrictEqual(r.sizes.map((x) => x.size), ['S', 'M', 'L', 'XL']);
  assert.ok(r.sizes.every((x) => typeof x.rank === 'number'));
});

await test('each size is compared on its own published measurements: the candidate is that size’s value, the difference is it minus yours', () => {
  const rec = ILLUSTRATIVE();
  const r = engine.compare(hoodieRef({ measurements: REF_CM }), rec);
  assert.deepStrictEqual(r.sizes.map((x) => x.size), rec.sizes);
  r.sizes.forEach((x) => ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'].forEach((d) => {
    const v = x.dimensions[d];
    assert.strictEqual(v.candidate, rec.charts.garment.sizes[x.size][d].value, `${x.size} ${d}: that size’s own value`);
    assert.strictEqual(v.reference, REF_CM[d]);
    assert.strictEqual(v.difference, Math.round((v.candidate - v.reference) * 100) / 100);
  }));
  /* the illustration in the brief, on fixture data: yours 58 cm, M 60 cm — 2 cm wider */
  const m = r.sizes.find((x) => x.size === 'M').dimensions.chestWidth;
  assert.deepStrictEqual([m.reference, m.candidate, m.words], [58, 60, 'Chest: 2 cm wider']);
});

/* too few measured the same way: nothing compared at all — no size, no closest, no difference */
const tooFewGate = (r, shared) => {
  assert.deepStrictEqual([r.status, r.missing[0].code], ['insufficient', 'too-few-dimensions']);
  ['sizes', 'recommended', 'closest', 'reference', 'tradeoffs'].forEach((k) => assert.ok(!(k in r), `no ${k} worked out on too little`));
  assert.deepStrictEqual(r.dimensionsShared, shared);
};

await test('a reference with only its chest measured is not compared on the chest alone: no size, no difference, and what is missing said', () => {
  const r = engine.compare(hoodieRef({ measurements: { unit: 'cm', chestWidth: 58 } }), ILLUSTRATIVE());
  tooFewGate(r, ['chestWidth']);
  assert.match(r.missing[0].message, /^Only chest is measured the same way on your reference and this product\. Fynd compares sizes only on at least three of chest, length, shoulders and sleeves, the chest among them/);
  assert.deepStrictEqual(r.notCompared.map((x) => [x.dim, x.code]), [['bodyLength', 'reference-missing'], ['sleeveLength', 'reference-missing'], ['shoulderWidth', 'reference-missing']]);
  assert.ok(r.notCompared.every((x) => /didn't measure it/.test(x.why)));
  assert.deepStrictEqual(r.next, ['Add the measurements your reference is missing, laid flat, as Fynd shows.']);
});

await test('a reference the shopper measured is named for what it is — a hoodie, never "the T-shirt you measured"', () => {
  const said = JSON.stringify(engine.recommend(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE()));
  assert.ok(!/T-shirt you measured/.test(said), 'not called a T-shirt');
  assert.ok(/the hoodie you measured/.test(said), 'named a hoodie');
});

await test('the size recommended is the closest by measurement, not the same letter', () => {
  /* the reference says L on its label; this product's M is closer */
  const r = engine.compare(hoodieRef({ size: 'L', measurements: REF_CM }), ILLUSTRATIVE());
  assert.strictEqual(r.recommended, 'M');
  assert.strictEqual(r.reliability, 'medium', 'measured at home: never high');
  assert.ok(/M is the closest to your reference across chest, length, shoulders and sleeves/.test(r.summary), r.summary);
  assert.ok(r.caveats.some((c) => /don't guarantee the same fit or feel/.test(c)));
});

await test('inches and centimetres give the same comparison, converted once, never twice', () => {
  const inches = {};
  Object.entries(REF_CM).forEach(([k, v]) => { inches[k] = k === 'unit' ? 'in' : v / 2.54; });
  const cm = engine.compare(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE());
  const inch = engine.compare(hoodieRef({ measurements: inches }), ILLUSTRATIVE());
  assert.strictEqual(inch.unit, 'in');
  assert.deepStrictEqual(inch.sizes.map((s) => s.score), cm.sizes.map((s) => s.score));
  const mIn = inch.sizes.find((s) => s.size === 'M').dimensions.chestWidth;
  assert.ok(Math.abs(mIn.difference - 2 / 2.54) < 0.01, `${mIn.difference}`);
  assert.strictEqual(mIn.words, 'Chest: ¾ in wider');
  /* asked for in cm, an inch reference reads back in cm, from one conversion */
  const asked = engine.compare(hoodieRef({ measurements: inches }), ILLUSTRATIVE(), { unit: 'cm' });
  assert.strictEqual(asked.unit, 'cm');
  assert.ok(Math.abs(asked.sizes.find((s) => s.size === 'M').dimensions.chestWidth.difference - 2) < 0.01);
  assert.ok(Math.abs(asked.reference.values.chestWidth - 58) < 0.01);
});

await test('what matters most to the shopper decides between sizes, deterministically', () => {
  /* a reference between M and L: M is right in the shoulders, L in the chest */
  const ref = { unit: 'cm', chestWidth: 61.8, bodyLength: 68, shoulderWidth: 51, sleeveLength: 62.5 };
  const chest = engine.compare(hoodieRef({ measurements: ref, likes: ['chest'] }), ILLUSTRATIVE());
  const shoulders = engine.compare(hoodieRef({ measurements: ref, likes: ['shoulders'] }), ILLUSTRATIVE());
  assert.strictEqual(chest.recommended, 'L');
  assert.strictEqual(shoulders.recommended, 'M');
  assert.deepStrictEqual(engine.compare(hoodieRef({ measurements: ref, likes: ['chest'] }), ILLUSTRATIVE()).sizes, chest.sizes, 'the same inputs, the same answer');
});

await test('missing measurements are said: a dimension not measured, and a size without one, are never compared', () => {
  const partial = engine.compare(hoodieRef({ measurements: { unit: 'cm', chestWidth: 58, shoulderWidth: 50 } }), ILLUSTRATIVE());
  tooFewGate(partial, ['chestWidth', 'shoulderWidth']);
  assert.deepStrictEqual(partial.notCompared.map((x) => [x.dim, x.why]), [['bodyLength', 'you didn\'t measure it'], ['sleeveLength', 'you didn\'t measure it']]);
  assert.match(partial.missing[0].message, /^Only chest and shoulders are measured the same way/);
  /* a size the product publishes no sleeve for is shown, not ranked */
  const gap = ILLUSTRATIVE();
  delete gap.charts.garment.sizes.XL.sleeveLength;
  const r = engine.compare(hoodieRef({ measurements: REF_CM }), gap);
  const xl = r.sizes.find((s) => s.size === 'XL');
  assert.strictEqual(xl.score, null);
  assert.ok(/XL isn't ranked: .* publishes no sleeves/.test(xl.unranked), xl.unranked);
  assert.strictEqual(xl.dimensions.sleeveLength.compared, false);
  assert.ok(r.notes.includes(xl.unranked));
});

await test('a body chart is never compared with a garment, and a label alone is not a reference', () => {
  const nike = engine.compare(hoodieRef({ measurements: REF_CM }), sizing.byId(NIKE_HOODIE));
  assert.strictEqual(nike.missing[0].code, 'body-chart-only');
  assert.ok(!('sizes' in nike));
  const label = engine.compare(hoodieRef({ brand: 'Carhartt', size: 'L' }), ILLUSTRATIVE());
  assert.strictEqual(label.missing[0].code, 'no-reference');
  const none = engine.compare(Schema.empty(), ILLUSTRATIVE());
  assert.strictEqual(none.missing[0].code, 'no-reference');
  assert.ok(/Save a hoodie that fits you well/.test(none.missing[0].message));
  /* a product named but not in Fynd's records, with no measurements: nothing to compare */
  const named = engine.compare(hoodieRef({ product: { name: 'Some hoodie Fynd has never seen', url: null } }), ILLUSTRATIVE());
  assert.strictEqual(named.missing[0].code, 'no-reference-measurements');
});

await test('an unverified product gives no numbers at all; production compares only checked records', () => {
  const zara = engine.compare(hoodieRef({ measurements: REF_CM }), sizing.byId('zara-00761810-basic-heavyweight-hoodie-us'));
  assert.strictEqual(zara.status, 'insufficient');
  assert.strictEqual(zara.missing[0].code, 'unverified-data');
  assert.ok(!('sizes' in zara) && !('recommended' in zara) && !('closest' in zara));
  /* with the evaluation flag the arithmetic runs, and still recommends nothing */
  const evalRun = engine.compare(hoodieRef({ measurements: REF_CM }), sizing.byId('zara-00761810-basic-heavyweight-hoodie-us'), { includeUnverified: true });
  assert.strictEqual(evalRun.recommended, null);
  assert.ok(/haven't been checked, so it isn't a recommendation/.test(evalRun.summary));
});

await test('against UNIQLO\'s checked hoodie, a home-measured reference compares only what is measured the same way', () => asChecked(UQ_PAIR, () => {
  const r = engine.compare(hoodieRef({ measurements: REF_CM }), sizing.byId(UQ_HOODIE));
  /* only chest and shoulders are measured the same way: too few to compare at all */
  tooFewGate(r, ['chestWidth', 'shoulderWidth']);
  assert.ok(r.notCompared.every((x) => /measured differently — UNIQLO's from the centre back/.test(x.why)), JSON.stringify(r.notCompared));
}));

await test('a reference found in the catalogue uses its published measurements; fabric and construction are said, never scored', () => asChecked(UQ_PAIR, () => {
  /* the shopper's sweatshirt is UNIQLO's (found by its link); comparing UNIQLO's hoodie */
  const p = Schema.empty();
  p.garments.sweatshirts = Object.assign(Schema.emptyGarment('sweatshirts'), { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { name: null, url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } });
  const r = engine.compare(p, sizing.byId(UQ_HOODIE));
  assert.strictEqual(r.reference.source, 'product');
  assert.strictEqual(r.reference.crossCategory, true);
  assert.deepStrictEqual(r.dimensionsCompared, ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength']);
  assert.strictEqual(r.recommended, 'M', 'the same published measurements');
  assert.ok(r.sizes.find((s) => s.size === 'M').dimensions.chestWidth.words.endsWith('the same as your reference'));
  assert.strictEqual(r.reliability, 'medium', 'a sweatshirt for a hoodie lowers it');
  assert.ok(r.caveats.some((c) => /Your reference is a sweatshirt, and this is a hoodie/.test(c)));
  /* context: the brand's own words, and unknown where it says nothing */
  assert.strictEqual(r.context.product.stretch, 'unknown');
  assert.strictEqual(r.context.product.construction, 'unknown');
  assert.ok(/100% Cotton/.test(r.context.product.fabric));
  assert.ok(/100% Cotton/.test(r.context.reference.fabric));
  /* no fabric word turns into a claim about fit */
  assert.ok(!/stretch|fabric|cotton/i.test(r.summary));
  assert.ok(!r.sizes.some((s) => Object.values(s.dimensions).some((d) => /stretch|fabric/i.test(d.words || ''))));
}));

await test('/api/size-recommendation compares only the caller\'s own reference, read-only and no-store', () => asChecked(UQ_PAIR, async () => {
  const ada = await signUp('ada@example.test');
  const bob = await signUp('bob@example.test');
  assert.strictEqual((await compareCall({}, UQ_HOODIE)).status, 401);
  /* Ada's reference: UNIQLO's own sweatshirt, by its link — measured the same way as the hoodie */
  await fitProfiles.saveGuide(ada.user.id, { garments: { sweatshirts: { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } } });
  const mine = await compareCall(ada.jar, UQ_HOODIE);
  assert.strictEqual(mine.status, 200);
  assert.strictEqual(mine.res.getHeader('cache-control'), 'no-store, private');
  assert.strictEqual(mine.body.comparison.reference.source, 'product');
  assert.strictEqual(mine.body.comparison.unit, 'in');
  const cm = await compareCall(ada.jar, UQ_HOODIE, 'cm');
  assert.strictEqual(cm.body.comparison.unit, 'cm');
  /* Bob's session reads Bob's (empty) profile, never Ada's */
  const his = await compareCall(bob.jar, UQ_HOODIE);
  assert.strictEqual(his.body.comparison.missing[0].code, 'no-reference');
  assert.strictEqual((await compareCall(ada.jar, 'not a product')).status, 400);
  /* reading changes nothing */
  const before = JSON.stringify((await fitProfiles.read(ada.user.id)).profile);
  await compareCall(ada.jar, UQ_HOODIE);
  assert.strictEqual(JSON.stringify((await fitProfiles.read(ada.user.id)).profile), before);
}));

section('each garment measurement: its unit, method, source and status');

const DIMS4 = ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'];
/* the illustrative fixture in inches: the same garment, converted once */
const ILLUSTRATIVE_IN = () => {
  const r = ILLUSTRATIVE();
  r.units = 'in';
  Object.values(r.charts.garment.sizes).forEach((row) => Object.values(row).forEach((cell) => { cell.value /= 2.54; cell.text = String(cell.value); }));
  return r;
};
/* a sweatshirt reference found by its link: UNIQLO's checked Sweatshirt */
const uqSweatshirtRef = (size) => {
  const p = Schema.empty();
  p.garments.sweatshirts = Object.assign(Schema.emptyGarment('sweatshirts'), { favorite: 'perfect', anchor: { brand: 'UNIQLO', size, product: { name: null, url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } });
  return p;
};

await test('a record\'s measurement is read whole from the record — value, unit, method, source, status — and every existing record still loads without the new fields', () => asChecked(UQ_PAIR, () => {
  sizing.RECORDS.forEach((r) => assert.deepStrictEqual(sizingSchema.validate(r), [], r.id));
  const m = sizingSchema.measurementOf(sizing.byId(UQ_HOODIE), 'M', 'chestWidth');
  assert.deepStrictEqual(Object.keys(m), ['value', 'unit', 'method', 'source', 'status']);
  assert.strictEqual(m.unit, 'in');
  assert.strictEqual(m.method, 'flat-width-armpit-to-armpit');
  assert.strictEqual(m.status, 'verified');
  assert.ok(m.value > 0);
  assert.ok(sizingSchema.officialUrl('UNIQLO', m.source.url));
  assert.strictEqual(sizingSchema.measurementOf(sizing.byId(UQ_HOODIE), 'M', 'notADimension'), null);
  assert.strictEqual(sizingSchema.measurementOf(sizing.byId(NIKE_HOODIE), 'M', 'chestWidth'), null, 'a body chart holds no garment measurement');
  /* an unchecked record's measurements are unverified, never verified */
  assert.strictEqual(sizingSchema.measurementStatus(sizing.byId('zara-00761810-basic-heavyweight-hoodie-us'), 'chestWidth'), 'unverified');
  /* a physical length is never negative or zero */
  const neg = ILLUSTRATIVE();
  neg.charts.garment.sizes.M.chestWidth.value = -60;
  assert.ok(sizingSchema.validate(neg).some((e) => e.field === 'charts.garment.sizes.M.chestWidth'));
}));

await test('crowdsourced measurements name who gathered them and when, are never verified, and a dimension can only lower its own status', () => {
  const crowd = ILLUSTRATIVE();
  crowd.charts.garment.origin = 'crowdsourced';
  assert.ok(sizingSchema.validate(crowd).some((e) => e.field === 'charts.garment.origin'), 'who and when are required');
  Object.assign(crowd.charts.garment, { measuredBy: 'Fynd shopper submissions (test)', measuredAt: '2026-10-20' });
  assert.deepStrictEqual(sizingSchema.validate(crowd), []);
  assert.ok(sizingSchema.isVerified(crowd), 'the record itself is checked');
  DIMS4.forEach((d) => assert.strictEqual(sizingSchema.measurementStatus(crowd, d), 'crowdsourced', `${d}: still crowdsourced`));

  const own = ILLUSTRATIVE();
  own.charts.garment.dimensions.shoulderWidth.status = 'unverified';
  own.charts.garment.dimensions.chestWidth.status = 'crowdsourced';
  assert.deepStrictEqual(sizingSchema.validate(own), []);
  assert.deepStrictEqual(DIMS4.map((d) => sizingSchema.measurementStatus(own, d)), ['crowdsourced', 'verified', 'unverified', 'verified']);
  own.charts.garment.dimensions.bodyLength.status = 'verified';
  assert.ok(sizingSchema.validate(own).some((e) => e.field === 'charts.garment.dimensions.bodyLength.status'), 'a dimension cannot call itself verified');
  const body = copy(NIKE_HOODIE);
  body.charts.body.dimensions.chest.status = 'unverified';
  assert.ok(sizingSchema.validate(body).some((e) => e.field === 'charts.body.dimensions.chest.status'), 'only garment measurements keep a status');
});

await test('missing reference measurements: no comparison, no recommendation, and the shopper is told what to add', () => {
  const r = engine.compare(hoodieRef({ measurements: null }), ILLUSTRATIVE());
  assert.strictEqual(r.status, 'insufficient');
  assert.strictEqual(r.missing[0].code, 'no-reference');
  assert.ok(!('recommended' in r) && !('sizes' in r));
  /* a reference named but with nothing Fynd can measure */
  const named = engine.compare(hoodieRef({ product: { name: 'Unknown hoodie', url: null }, measurements: null }), ILLUSTRATIVE());
  assert.strictEqual(named.missing[0].code, 'no-reference-measurements');
  assert.ok(named.next.length);
});

await test('missing target measurements: a dimension the product doesn\'t publish is not compared, and too few gives no recommendation', () => {
  const thin = ILLUSTRATIVE();
  ['bodyLength', 'sleeveLength'].forEach((d) => {
    delete thin.charts.garment.dimensions[d];
    Object.values(thin.charts.garment.sizes).forEach((row) => delete row[d]);
  });
  const r = engine.compare(hoodieRef({ measurements: REF_CM }), thin);
  tooFewGate(r, ['chestWidth', 'shoulderWidth']);
  assert.ok(r.notCompared.every((x) => /doesn't publish it/.test(x.why) && x.code === 'target-missing'), JSON.stringify(r.notCompared));
  assert.deepStrictEqual(r.next, [], 'nothing the shopper can add would help');
});

await test('a centimetre reference against an inch product: converted before the difference, the same answer in either unit', () => {
  const cmProduct = engine.compare(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE());
  const inProduct = engine.compare(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE_IN());
  assert.strictEqual(inProduct.unit, 'cm', 'shown in the reference\'s own unit');
  assert.strictEqual(inProduct.recommended, cmProduct.recommended);
  inProduct.sizes.forEach((s) => DIMS4.forEach((d) => {
    const want = cmProduct.sizes.find((x) => x.size === s.size).dimensions[d].difference;
    assert.ok(Math.abs(s.dimensions[d].difference - want) < 0.02, `${s.size} ${d}: ${s.dimensions[d].difference} vs ${want}`);
  }));
  /* each side keeps its own unit as given */
  assert.strictEqual(inProduct.reference.measurements.chestWidth.unit, 'cm');
  assert.strictEqual(inProduct.reference.measurements.chestWidth.value, 58);
  assert.strictEqual(inProduct.sizes[0].dimensions.chestWidth.measurement.unit, 'in');
  /* asked for in inches, a 2 cm difference reads as 2 / 2.54 in */
  const asIn = engine.compare(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE_IN(), { unit: 'in' });
  assert.ok(Math.abs(asIn.sizes.find((s) => s.size === 'M').dimensions.chestWidth.difference - 2 / 2.54) < 0.01);
});

await test('every difference is signed target minus reference: positive is larger, negative smaller, and the words agree', () => {
  const rec = ILLUSTRATIVE();
  /* a reference exactly the product's M: M differs by nothing, S is smaller in every dimension, L larger */
  const mRow = rec.charts.garment.sizes.M;
  const ref = Object.assign({ unit: 'cm' }, Object.fromEntries(DIMS4.map((d) => [d, mRow[d].value])));
  const r = engine.compare(hoodieRef({ measurements: ref }), rec);
  assert.strictEqual(r.recommended, 'M');
  const at = (size) => r.sizes.find((s) => s.size === size).dimensions;
  DIMS4.forEach((d) => {
    assert.strictEqual(at('M')[d].difference, 0, `M ${d}`);
    assert.ok(at('S')[d].difference < 0, `S ${d} is smaller`);
    assert.ok(at('L')[d].difference > 0, `L ${d} is larger`);
    assert.ok(/narrower|shorter/.test(at('S')[d].words), at('S')[d].words);
    assert.ok(/wider|longer/.test(at('L')[d].words), at('L')[d].words);
  });
  r.sizes.forEach((s) => DIMS4.forEach((d) => {
    const x = s.dimensions[d];
    assert.strictEqual(x.difference, Math.round((x.candidate - x.reference) * 100) / 100, 'candidate − reference, never the reverse');
    assert.strictEqual(x.measurement.value, rec.charts.garment.sizes[s.size][d].value, 'the published value, unsigned');
    assert.ok(x.measurement.value > 0 && x.reference > 0 && x.candidate > 0);
  }));
});

await test('incompatible measurement methods are never compared — listed with why, no difference shown, no recommendation', () => {
  const rec = ILLUSTRATIVE();
  Object.assign(rec.charts.garment.dimensions.bodyLength, { method: 'center-back-to-hem' });
  Object.assign(rec.charts.garment.dimensions.sleeveLength, { method: 'center-back-to-cuff' });
  Object.assign(rec.charts.garment.dimensions.shoulderWidth, { method: 'broadest-part-of-shoulders' });
  assert.deepStrictEqual(sizingSchema.validate(rec), []);
  const r = engine.compare(hoodieRef({ measurements: REF_CM }), rec);
  tooFewGate(r, ['chestWidth']);
  assert.deepStrictEqual(r.notCompared.map((x) => x.dim), ['bodyLength', 'sleeveLength', 'shoulderWidth']);
  assert.ok(r.notCompared.every((x) => /measured differently/.test(x.why) && x.code === 'method-mismatch'));
});

await test('a body measurement is never set against a garment measurement', () => {
  /* a chest measurement alone is not a reference garment */
  const body = Object.assign(Schema.empty(), { measurements: Object.assign(Schema.empty().measurements, { unit: 'in', chest: 40 }) });
  body.garments.hoodies = Object.assign(Schema.emptyGarment('hoodies'), { fitGoal: 'true-to-size', line: 'men' });
  const r = engine.compare(body, ILLUSTRATIVE());
  assert.strictEqual(r.missing[0].code, 'no-reference');
  assert.ok(!('sizes' in r));
  /* a reference garment against a product that publishes only body measurements */
  const nike = engine.compare(hoodieRef({ measurements: REF_CM }), sizing.byId(NIKE_HOODIE));
  assert.strictEqual(nike.missing[0].code, 'body-chart-only');
  assert.ok(!('sizes' in nike) && !('recommended' in nike));
  /* and the suggestion from a body chest uses the room a fit wants, never chest = chest */
  const s = engine.recommend(body, ILLUSTRATIVE());
  assert.strictEqual(s.method, 'body-plus-ease');
});

await test('crowdsourced or unchecked measurements give no recommendation: a crowdsourced chart is refused, a crowdsourced dimension is not compared', () => {
  const crowd = ILLUSTRATIVE();
  Object.assign(crowd.charts.garment, { origin: 'crowdsourced', measuredBy: 'Fynd shopper submissions (test)', measuredAt: '2026-10-20' });
  const r = engine.compare(hoodieRef({ measurements: REF_CM }), crowd);
  assert.deepStrictEqual([r.status, r.missing[0].code, r.dataStatus], ['insufficient', 'crowdsourced-data', 'crowdsourced']);
  assert.ok(!('sizes' in r) && !('recommended' in r));
  /* not even the evaluation suite compares crowdsourced numbers */
  assert.strictEqual(engine.compare(hoodieRef({ measurements: REF_CM }), crowd, { includeUnverified: true }).missing[0].code, 'crowdsourced-data');
  /* nor does the suggestion from a body chest lean on a crowdsourced chest */
  const body = Object.assign(Schema.empty(), { measurements: Object.assign(Schema.empty().measurements, { unit: 'in', chest: 40 }) });
  body.garments.hoodies = Object.assign(Schema.emptyGarment('hoodies'), { fitGoal: 'true-to-size', line: 'men' });
  assert.notStrictEqual(engine.recommend(body, crowd).method, 'body-plus-ease');

  /* one crowdsourced dimension, the chest: never compared, so never recommended */
  const chest = ILLUSTRATIVE();
  chest.charts.garment.dimensions.chestWidth.status = 'crowdsourced';
  const c = engine.compare(hoodieRef({ measurements: REF_CM }), chest);
  tooFewGate(c, ['bodyLength', 'shoulderWidth', 'sleeveLength']);
  assert.match(c.notCompared.find((x) => x.dim === 'chestWidth').why, /gathered from shoppers/);

  /* an unchecked shoulder on a checked record: left out; the three checked ones, chest among them, still stand */
  const shoulder = ILLUSTRATIVE();
  shoulder.charts.garment.dimensions.shoulderWidth.status = 'unverified';
  const u = engine.compare(hoodieRef({ measurements: REF_CM }), shoulder);
  assert.deepStrictEqual(u.dimensionsCompared, ['chestWidth', 'bodyLength', 'sleeveLength']);
  assert.match(u.notCompared.find((x) => x.dim === 'shoulderWidth').why, /not yet checked/);
  assert.strictEqual(u.recommended, 'M');

  /* an unverified product: no numbers at all (production) */
  const zara = engine.compare(hoodieRef({ measurements: REF_CM }), sizing.byId('zara-00761810-basic-heavyweight-hoodie-us'));
  assert.strictEqual(zara.missing[0].code, 'unverified-data');
});

await test('a reference product\'s measurements are given whole and checked the same way; a crowdsourced one is not compared', () => asChecked(UQ_PAIR, () => {
  const r = engine.compare(uqSweatshirtRef('M'), sizing.byId(UQ_HOODIE));
  assert.strictEqual(r.status, 'ok');
  DIMS4.forEach((d) => {
    const m = r.reference.measurements[d];
    assert.strictEqual(m.status, 'verified');
    assert.strictEqual(m.unit, 'in');
    assert.strictEqual(m.source.url, 'https://www.uniqlo.com/us/en/products/E475377-000/00');
  });
  /* the shopper's own measurements are called what they are */
  const home = engine.compare(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE());
  assert.deepStrictEqual(home.reference.measurements.chestWidth, { value: 58, unit: 'cm', method: 'flat-width-armpit-to-armpit', source: { origin: 'shopper-measured' }, status: 'shopper-measured' });
  /* a reference product whose chest was crowdsourced: that dimension is left out */
  const pool = sizing.RECORDS.map((x) => (x.id === 'uniqlo-e475377-sweatshirt-us' ? (() => { const y = JSON.parse(JSON.stringify(x)); y.charts.garment.dimensions.chestWidth.status = 'crowdsourced'; return y; })() : x));
  const c = engine.compare(uqSweatshirtRef('M'), sizing.byId(UQ_HOODIE), { records: pool });
  /* no chest: not enough to compare at all — no recommendation, no difference */
  tooFewGate(c, ['bodyLength', 'shoulderWidth', 'sleeveLength']);
  assert.match(c.notCompared.find((x) => x.dim === 'chestWidth').why, /your UNIQLO reference's chest is gathered from shoppers/);
}));

await test('a size judged against the shopper\'s own measurements is "shopper-measured", never "verified", even on a checked product', () => {
  const r = engine.recommend(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE());
  assert.strictEqual(r.method, 'reference-garment');
  const classed = r.fitBySize.flatMap((f) => Object.values(f.dimensions)).filter((x) => x.class);
  assert.ok(classed.length, 'something was judged');
  classed.forEach((x) => assert.ok(['shopper-measured', 'estimated'].includes(x.measurements), x.measurements));
  assert.ok(classed.some((x) => x.measurements === 'shopper-measured'));
  /* (verified, against checked charts only: test-size-eval's checkFitBySize) */
});

/* the illustrative fixture with its chest published all the way around:
   the same garment, its chest written as twice the flat width */
const ILLUSTRATIVE_AROUND = () => {
  const r = ILLUSTRATIVE();
  r.charts.garment.dimensions.chestWidth = { method: 'garment-circumference', methodSource: r.charts.garment.dimensions.chestWidth.methodSource };
  Object.values(r.charts.garment.sizes).forEach((row) => { row.chestWidth = { value: row.chestWidth.value * 2, text: String(row.chestWidth.value * 2) }; });
  return r;
};

await test('a chest published all the way around is scored with a tolerance twice the flat one: the same garment ranks the same however its chart is written', () => {
  const around = ILLUSTRATIVE_AROUND();
  assert.deepStrictEqual(sizingSchema.validate(around), []);
  const flat = engine.compare(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE());
  const circ = engine.compare(hoodieRef({ measurements: REF_CM }), around);
  assert.strictEqual(circ.recommended, flat.recommended, 'M either way (it was S before the fix)');
  assert.strictEqual(circ.recommended, 'M');
  assert.deepStrictEqual(circ.sizes.map((x) => x.score), flat.sizes.map((x) => x.score), 'identical scores, size by size');
  assert.deepStrictEqual(circ.sizes.map((x) => x.rank), flat.sizes.map((x) => x.rank));
  /* the difference itself is around the chest — twice the flat one — and marked estimated */
  const m = circ.sizes.find((x) => x.size === 'M').dimensions.chestWidth;
  assert.strictEqual(m.difference, 2 * flat.sizes.find((x) => x.size === 'M').dimensions.chestWidth.difference);
  assert.match(m.estimated, /twice its flat width/);
  /* recommend()'s reference-garment score: the same */
  const rFlat = engine.recommend(hoodieRef({ measurements: REF_CM }), ILLUSTRATIVE());
  const rCirc = engine.recommend(hoodieRef({ measurements: REF_CM }), around);
  assert.strictEqual(rCirc.method, 'reference-garment');
  assert.strictEqual(rCirc.leading, rFlat.leading);
  assert.deepStrictEqual(rCirc.ranking.map((x) => x.size), rFlat.ranking.map((x) => x.size));
  /* in inches too: the tolerance is converted with the record's own units */
  const inAround = ILLUSTRATIVE_AROUND();
  inAround.units = 'in';
  Object.values(inAround.charts.garment.sizes).forEach((row) => Object.values(row).forEach((c) => { c.value /= 2.54; c.text = String(c.value); }));
  const circIn = engine.compare(hoodieRef({ measurements: REF_CM }), inAround);
  circIn.sizes.forEach((x, i) => assert.ok(Math.abs(x.score - flat.sizes[i].score) < 1e-6, `${x.size}: ${x.score} vs ${flat.sizes[i].score}`));
});

await test('the extension\'s reference data calls a product verified only when every garment measurement is', () => asChecked(UQ_PAIR, () => {
  const builder = require('./build-fit-references.js');
  const live = sizing.byId(UQ_HOODIE);
  const product = () => builder.build().products.find((x) => x.id === UQ_HOODIE);
  assert.strictEqual(product().verification, 'verified');
  const dim = live.charts.garment.dimensions.shoulderWidth;
  dim.status = 'crowdsourced';
  try {
    assert.strictEqual(product().verification, 'unverified');
  } finally {
    delete dim.status;
  }
  assert.strictEqual(product().verification, 'verified');
}));

await test('real checked records: UNIQLO\'s Sweatshirt in M against every size of its Sweat Pullover Hoodie — zero only at M, signed elsewhere, from the published text', () => asChecked(UQ_PAIR, () => {
  /* The two records hold identical Product Size tables (the Sweatshirt's
     own note says so, as published), so the matching size differs by
     nothing; every other size differs by what UNIQLO publishes. */
  const sweat = sizing.byId('uniqlo-e475377-sweatshirt-us');
  const hood = sizing.byId(UQ_HOODIE);
  hood.sizes.forEach((size) => DIMS4.forEach((d) => assert.strictEqual(sweat.charts.garment.sizes[size][d].text, hood.charts.garment.sizes[size][d].text, `${size} ${d}: as recorded`)));
  const r = engine.compare(uqSweatshirtRef('M'), hood);
  assert.deepStrictEqual([r.status, r.recommended, r.unit], ['ok', 'M', 'in']);
  const diffs = (size) => DIMS4.map((d) => r.sizes.find((s) => s.size === size).dimensions[d].difference);
  assert.deepStrictEqual(diffs('M'), [0, 0, 0, 0]);
  /* L: chest 25 vs 23 ½, length 28 vs 26 ¾, shoulders 20 ¾ vs 20, sleeves 35 ¾ vs 34 ¾ */
  assert.deepStrictEqual(diffs('L'), [1.5, 1.25, 0.75, 1]);
  /* S: chest 22 ¼, length 25 ½, shoulders 19 ¼, sleeves 33 ¾ */
  assert.deepStrictEqual(diffs('S'), [-1.25, -1.25, -0.75, -1]);
  assert.strictEqual(r.sizes.find((s) => s.size === 'L').dimensions.chestWidth.words, 'Chest: 1½ in wider');
  assert.strictEqual(r.sizes.find((s) => s.size === 'S').dimensions.bodyLength.words, 'Body length: 1¼ in shorter');
  /* every size: the hoodie's own value minus the sweatshirt's M, in order */
  const ranked = r.sizes.map((s) => s.dimensions.chestWidth.difference);
  assert.deepStrictEqual(ranked, ranked.slice().sort((a, b) => a - b), 'chest differences rise with the size');
  /* the same, shown in centimetres: converted once, sign kept */
  const cm = engine.compare(uqSweatshirtRef('M'), hood, { unit: 'cm' });
  assert.strictEqual(cm.unit, 'cm');
  assert.strictEqual(cm.sizes.find((s) => s.size === 'L').dimensions.chestWidth.difference, 3.81);
  const sCm = cm.sizes.find((s) => s.size === 'S').dimensions.chestWidth.difference;
  assert.ok(sCm < 0 && Math.abs(sCm - (-1.25 * 2.54)) <= 0.005, `S chest in cm: ${sCm}`);
  assert.strictEqual(cm.recommended, 'M');
  /* a reference in L moves the recommendation to L: the label matched by measurement, not copied */
  assert.strictEqual(engine.compare(uqSweatshirtRef('L'), hood).recommended, 'L');
}));

await test('through /api/size-recommendation, a checked comparison carries its signed differences and each measurement\'s provenance', () => asChecked(UQ_PAIR, async () => {
  const { jar, user } = await signUp('cleo@example.test');
  await fitProfiles.saveGuide(user.id, { garments: { sweatshirts: { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } } });
  const got = await compareCall(jar, UQ_HOODIE);
  assert.strictEqual(got.status, 200);
  const c = got.body.comparison;
  assert.deepStrictEqual([c.status, c.recommended, c.reference.brand, c.reference.size], ['ok', 'M', 'UNIQLO', 'M']);
  const s = c.sizes.find((x) => x.size === 'S').dimensions.chestWidth;
  assert.ok(s.difference < 0, 'S is narrower than the M reference');
  assert.strictEqual(s.measurement.status, 'verified');
  /* the same product with no reference saved: nothing recommended */
  const none = await compareCall((await signUp('dov@example.test')).jar, UQ_HOODIE);
  assert.deepStrictEqual([none.body.comparison.status, none.body.comparison.missing[0].code], ['insufficient', 'no-reference']);
}));

section('fit feedback against the reference');

const TRIED = () => ({ productId: UQ_HOODIE, sizeTried: 'M', asExpected: false, issues: ['too-long', 'too-wide'], notes: '  sleeves   a bit long ' });

await test('feedback names the exact product and size, what was off, and the reference — snapshotted from the caller\'s own profile', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await fitProfiles.saveGuide(user.id, { garments: { hoodies: { favorite: 'perfect', anchor: { brand: 'Carhartt', size: 'L', measurements: REF_CM } } } });
  await feedback(jar, { action: 'consent', consent: { store: true } });
  /* a reference the page sends is ignored: only the server's snapshot counts */
  const added = await feedback(jar, { action: 'add', entry: Object.assign(TRIED(), { withReference: true, reference: { brand: 'Forged', measurements: { chestWidth: 99 } } }) });
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));
  const e = added.body.entry;
  assert.deepStrictEqual([e.productId, e.sizeTried, e.asExpected, e.issues, e.notes], [UQ_HOODIE, 'M', false, ['too-wide', 'too-long'], 'sleeves a bit long']);
  assert.deepStrictEqual(e.reference, { category: 'hoodies', brand: 'Carhartt', size: 'L', product: null, measurements: Object.assign({}, REF_CM) });
  /* a later change to the reference never rewrites the feedback */
  await fitProfiles.saveGuide(user.id, { garments: { hoodies: { anchor: { brand: 'Nike', size: 'M', measurements: { unit: 'in', chestWidth: 25 } } } } });
  assert.strictEqual((await readFeedback(jar)).body.feedback.entries[0].reference.brand, 'Carhartt');
});

await test('one entry per product and size: told again it updates; another size is a new entry; an edit never moves an entry', async () => {
  const { jar } = await signUp('ada@example.test');
  await feedback(jar, { action: 'consent', consent: { store: true } });
  const first = (await feedback(jar, { action: 'add', entry: TRIED() })).body;
  const again = (await feedback(jar, { action: 'add', entry: Object.assign(TRIED(), { asExpected: true, issues: [] }) })).body;
  assert.strictEqual(again.updated, true);
  assert.strictEqual(again.entry.id, first.entry.id);
  assert.strictEqual(again.feedback.entries.length, 1, 'no duplicate');
  assert.strictEqual(again.entry.asExpected, true);
  const other = (await feedback(jar, { action: 'add', entry: Object.assign(TRIED(), { sizeTried: 'L' }) })).body;
  assert.strictEqual(other.feedback.entries.length, 2);
  /* an update keeps product and size, and refuses to change them */
  const moved = await feedback(jar, { action: 'update', id: first.entry.id, entry: { sizeTried: 'L', asExpected: true } });
  assert.strictEqual(moved.status, 400);
  assert.match(moved.body.error, /stays with the product and size/);
  const edited = await feedback(jar, { action: 'update', id: first.entry.id, entry: { asExpected: false, issues: ['too-short'] } });
  assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
  assert.deepStrictEqual([edited.body.entry.sizeTried, edited.body.entry.issues], ['M', ['too-short']]);
  /* and removed */
  assert.strictEqual((await feedback(jar, { action: 'delete', id: first.entry.id })).status, 200);
  assert.deepStrictEqual((await readFeedback(jar)).body.feedback.entries.map((x) => x.sizeTried), ['L']);
});

await test('feedback is checked, and another account can neither change nor delete it', async () => {
  const ada = await signUp('ada@example.test');
  const bob = await signUp('bob@example.test');
  await feedback(ada.jar, { action: 'consent', consent: { store: true } });
  await feedback(bob.jar, { action: 'consent', consent: { store: true } });
  for (const [entry, field] of [
    [Object.assign(TRIED(), { issues: ['too-tight'] }), 'issues'],
    [Object.assign(TRIED(), { asExpected: true }), 'issues'],
    [Object.assign(TRIED(), { asExpected: false, issues: [] }), 'issues'],
    [Object.assign(TRIED(), { asExpected: 'kind of' }), 'asExpected'],
    [Object.assign(TRIED(), { notes: 'x'.repeat(501) }), 'notes'],
    [{ productId: UQ_HOODIE, sizeTried: 'M' }, 'asExpected']
  ]) {
    const r = await feedback(ada.jar, { action: 'add', entry });
    assert.strictEqual(r.status, 400, field);
    assert.ok(r.body.errors.some((e) => e.field === field), `${field}: ${JSON.stringify(r.body.errors)}`);
  }
  const id = (await feedback(ada.jar, { action: 'add', entry: TRIED() })).body.entry.id;
  assert.strictEqual((await feedback(bob.jar, { action: 'update', id, entry: { asExpected: true } })).status, 404);
  assert.strictEqual((await feedback(bob.jar, { action: 'delete', id })).status, 404);
  assert.strictEqual((await feedback(ada.jar, { action: 'update', id, entry: { asExpected: true } }, { omitCsrf: true })).status, 403);
  assert.strictEqual((await readFeedback(ada.jar)).body.feedback.entries[0].asExpected, false, 'untouched');
});

await test('feedback is read together only with consent and enough accounts, and conflicting reports are flagged, not acted on', () => {
  const said = (issues, improve) => ({ consent: { store: true, improve: improve !== false }, entries: [{ productId: UQ_HOODIE, sizeTried: 'M', asExpected: !issues.length, issues }] });
  const records = [];
  for (let i = 0; i < 6; i += 1) records.push(said(['too-long']));
  for (let i = 0; i < 4; i += 1) records.push(said(['too-short']));
  records.push(said(['too-wide'], false));
  const [m] = fitFeedback.summarise(records);
  assert.strictEqual(m.accounts, 10, 'only accounts that agreed to improve count');
  assert.strictEqual(m.enough, true);
  assert.deepStrictEqual(m.conflicting, ['too-long / too-short']);
  assert.strictEqual(m.issues['too-wide'], 0);
  const [few] = fitFeedback.summarise(records.slice(0, 3));
  assert.strictEqual(few.enough, false, 'three accounts are not enough to read');
  /* nothing in the engine reads feedback */
  const code = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', '_sizing', 'engine.js'), 'utf8');
  assert.ok(!/_fit-feedback|fitFeedback|summarise/.test(code));
});

section('search results, sized from one type of clothing');

const fitCall = (jar, type, items, o) => call(recommendEndpoint, Object.assign({
  method: 'GET', jar, query: { fit: type, items: typeof items === 'string' ? items : JSON.stringify(items) },
  url: '/api/size-recommendation?fit=…'
}, o));
const UQ_HOODIE_URL = sizing.byId(UQ_HOODIE).product.url;
const LISTINGS = [
  { brand: 'UNIQLO', name: 'Sweat Pullover Hoodie', url: `${UQ_HOODIE_URL}?colorDisplayCode=09` },
  { brand: 'Gap', name: 'Gap Arch Logo Hoodie', url: 'https://www.gap.com/browse/product.do?pid=1' },
  { brand: null, name: 'A hoodie', url: null }
];

await test('the engine’s types are the schema’s sized types: one list, never two', () => {
  assert.deepStrictEqual(Schema.SIZED_TYPES.slice().sort(), Object.keys(engine.CATEGORY_PARAMS).sort());
});

await test('signed out it answers 401; a type or list it cannot read is refused', async () => {
  assert.strictEqual((await fitCall({}, 'hoodies', LISTINGS)).status, 401);
  const { jar } = await signUp('ada@example.test');
  assert.strictEqual((await fitCall(jar, 'scarves', LISTINGS)).status, 400);
  assert.strictEqual((await fitCall(jar, 'hoodies', 'not json')).status, 400);
  assert.strictEqual((await fitCall(jar, 'hoodies', { brand: 'x' })).status, 400, 'a list, not an object');
  assert.strictEqual((await fitCall(jar, 'hoodies', Array.from({ length: 25 }, () => LISTINGS[1]))).status, 400, 'at most 24');
});

await test('only a listing that matches a sizing record is sized; the rest are left out, never guessed', () => asChecked(UQ_PAIR, async () => {
  const { jar, user } = await signUp('ada@example.test');
  await fitProfiles.save(user.id, { schemaVersion: 5, measurements: { unit: 'in', chest: 40 } });
  await fitProfiles.saveGuide(user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });
  const { status, body, res } = await fitCall(jar, 'hoodies', LISTINGS);
  assert.strictEqual(status, 200);
  assert.strictEqual(res.getHeader('cache-control'), 'no-store, private');
  assert.strictEqual(body.fit.type, 'hoodies');
  assert.strictEqual(body.fit.covered, true);
  assert.deepStrictEqual(body.fit.items.map((i) => i.index), [0], 'the Gap and unnamed listings get nothing');
  const item = body.fit.items[0];
  assert.strictEqual(item.productId, UQ_HOODIE);
  assert.strictEqual(item.matchedBy, 'link');
  /* the same answer the product endpoint gives, from the same profile */
  const direct = (await suggest(jar, UQ_HOODIE)).body.recommendation;
  assert.strictEqual(item.status, 'ok');
  assert.strictEqual(item.size, direct.leading);
  assert.strictEqual(item.by, 'profile');
  /* read-only */
  const before = await store.get(fitProfiles.profileKey(user.id));
  await fitCall(jar, 'hoodies', LISTINGS);
  assert.deepStrictEqual(await store.get(fitProfiles.profileKey(user.id)), before);
}));

await test('a hoodie reference compares a hoodie search, and is never read for jeans or T-shirts', () => asChecked(UQ_PAIR, async () => {
  const { jar, user } = await signUp('ada@example.test');
  await fitProfiles.saveGuide(user.id, { garments: { hoodies: { favorite: 'perfect', anchor: { brand: 'Carhartt', size: 'L', measurements: { unit: 'cm', chestWidth: '58', bodyLength: '68', shoulderWidth: '50', sleeveLength: '62' } } } } });
  const hoodie = (await fitCall(jar, 'hoodies', LISTINGS)).body.fit.items[0];
  /* UNIQLO measures sleeves and length from the centre back: chest and shoulders only — too few to compare, so no size, no closest */
  assert.strictEqual(hoodie.status, 'insufficient');
  assert.strictEqual(hoodie.size, null);
  assert.ok(!('closest' in hoodie));
  assert.ok(hoodie.missing.some((m) => /^Only chest and shoulders are measured the same way on your reference and this product/.test(m)), JSON.stringify(hoodie.missing));
  const jeans = (await fitCall(jar, 'jeans', LISTINGS)).body.fit;
  assert.strictEqual(jeans.covered, false);
  assert.deepStrictEqual(jeans.items, [], 'jeans are never sized from a hoodie');
  const tees = (await fitCall(jar, 'tshirts', LISTINGS)).body.fit;
  assert.deepStrictEqual(tees.items, [], 'a hoodie listing is not a T-shirt');
}));

await test('a T-shirt reference is not used for a hoodie, and an unchecked T-shirt record gives no size', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await fitProfiles.saveGuide(user.id, { garments: { tshirts: { favorite: 'perfect', line: 'men', fitGoal: 'true-to-size', anchor: { brand: 'UNIQLO', size: 'M', measurements: { unit: 'in', chestWidth: '20', bodyLength: '28', shoulderWidth: '17', sleeveLength: '8' } } } } });
  const hoodie = (await fitCall(jar, 'hoodies', LISTINGS)).body.fit.items[0];
  assert.strictEqual(hoodie.status, 'insufficient');
  assert.strictEqual(hoodie.size, null);
  const tee = (await fitCall(jar, 'tshirts', [{ brand: 'UNIQLO', name: 'Supima Cotton T-Shirt', url: sizing.byId(UQ_TEE).product.url }])).body.fit.items[0];
  assert.strictEqual(tee.productId, UQ_TEE);
  assert.strictEqual(tee.status, 'insufficient');
  assert.strictEqual(tee.size, null);
  assert.ok(tee.missing.some((m) => /hasn't been checked|haven't been checked/.test(m)), tee.missing.join(' | '));
});

await test('each caller’s listings are sized from their own profile, whatever the request names', () => asChecked(UQ_PAIR, async () => {
  const ada = await signUp('ada@example.test');
  const bea = await signUp('bea@example.test');
  await fitProfiles.save(ada.user.id, { schemaVersion: 5, measurements: { unit: 'in', chest: 40 } });
  await fitProfiles.saveGuide(ada.user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });
  await fitProfiles.save(bea.user.id, { schemaVersion: 5, measurements: { unit: 'in', chest: 46 } });
  await fitProfiles.saveGuide(bea.user.id, { garments: { hoodies: { fitGoal: 'true-to-size', line: 'men' } } });
  const beas = await fitCall(bea.jar, 'hoodies', LISTINGS, { headers: { 'x-user-id': ada.user.id } });
  assert.strictEqual(beas.body.fit.items[0].size, 'XL');
  assert.strictEqual((await fitCall(ada.jar, 'hoodies', LISTINGS)).body.fit.items[0].size, 'M');
}));

section('sizing charts from a product link (api/_sizing/chart.js)');

const charts = require('../api/_sizing/chart');
/* ILLUSTRATIVE FIXTURES — invented markup in the shapes product pages
   and size guides take, to test the reader. None of it is a real page
   or a real measurement, and nothing here is evidence about any shop. */
const SHOP = 'https://shop.example.com/products/illustrative-tee';
const NIKE_OTHER = 'https://www.nike.com/t/illustrative-tee-TEST001';
const FILLER = '<p>' + 'Soft cotton jersey with a crew neck, made for everyday wear and easy layering. '.repeat(8) + '</p>';
const page = (inner, extra) => `<!doctype html><html><head><title>Illustrative Tee | Example Shop</title>${extra || ''}</head><body>${FILLER}${inner}</body></html>`;
const LD = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const GARMENT_CM = page(`<h2>Garment measurements</h2><p>Measured laid flat, in cm.</p>
  <table><caption>Product size (cm)</caption><tr><th>Size</th><th>Chest width</th><th>Body length</th><th>Sleeve</th></tr>
  <tr><td>S</td><td>51</td><td>70</td><td>20.5</td></tr><tr><td>M</td><td>54</td><td>72</td><td>21</td></tr><tr><td>L</td><td>57</td><td>74</td><td>21.5</td></tr></table>`,
  `<meta property="og:site_name" content="Example Shop"><meta property="og:locale" content="en_GB">${LD({ '@context': 'https://schema.org', '@type': 'Product', name: 'Illustrative Tee', brand: { '@type': 'Brand', name: 'Example Brand' }, sku: 'TEST001' })}`);
const BODY_IN = page(`<h3>Body measurements</h3><p>Use these to find the size made to fit your body. Inches.</p>
  <table><tr><th>Size</th><th>Chest</th><th>Waist</th></tr><tr><td>S</td><td>35 - 37.5</td><td>29 - 32</td></tr><tr><td>M</td><td>37.5 - 41</td><td>32 - 35</td></tr></table>`);
/* What the reader does with a page it may read, on stubbed pages: the
   shops are marked permitted for this suite only (api/_sizing/page-access.js).
   In production no domain is, so none of these pages would be fetched —
   scripts/test-page-access.js holds that. A shop with no robots.txt route
   has none (404), which sets no rules. */
const pageAccess = require('../api/_sizing/page-access');
const TEST_SHOPS = Object.fromEntries(['example.com', 'example.test', 'uniqlo.com', 'nike.com', 'carhartt.com', 'hm.com', 'zara.com', 'gap.com']
  .map((d) => [d, { access: 'permitted', basis: 'this test suite only; stubbed pages, never fetched' }]));
pageAccess.setPolicy(TEST_SHOPS);
const NO_ROBOTS = { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' };
const fakeFetch = (routes, log) => async (url, opts) => {
  const robots = /\/robots\.txt$/.test(url);
  if (log && !robots) log.push({ url, redirect: opts && opts.redirect });
  const r = routes[url] || (robots ? NO_ROBOTS : null);
  if (!r) throw new Error('unreachable');
  if (r.throws) { const e = new Error(r.throws); e.name = r.throws === 'abort' ? 'AbortError' : 'Error'; if (r.throws === 'blocked') e.code = 'EBLOCKED'; throw e; }
  const headers = new Map(Object.entries(Object.assign({ 'content-type': 'text/html; charset=utf-8' }, r.headers || {})));
  return { status: r.status || 200, ok: (r.status || 200) < 300, headers: { get: (k) => headers.get(k.toLowerCase()) || null }, text: async () => r.body || '' };
};
const read = (url, routes, log) => charts.chartFor(url, { noCache: true, fetch: fakeFetch(routes, log) });

await test('any public http(s) product page is accepted; anything else is refused before a request', () => {
  assert.strictEqual(charts.checkUrl('https://www.uniqlo.com/us/en/products/E475378-000/00?utm_source=x&colorDisplayCode=09#reviews').url,
    'https://www.uniqlo.com/us/en/products/E475378-000/00', 'tracking, colour choice and fragments dropped: the path names the product');
  assert.strictEqual(charts.checkUrl('https://www.gap.com/browse/product.do?pid=1').url, 'https://www.gap.com/browse/product.do?pid=1');
  assert.strictEqual(charts.checkUrl('http://shop.example.com/p/1').url, 'http://shop.example.com/p/1');
  assert.strictEqual(charts.checkUrl('https://www2.hm.com/en_us/productpage.0685816001.html').market, 'US');
  assert.strictEqual(charts.checkUrl('https://www.carhartt.com/product/K121/x').market, null, 'a market the address doesn’t name is not guessed');
  ['ftp://shop.example.com/x', 'javascript:alert(1)', 'not a url', '', 'https://user:pw@shop.example.com/x', 'file:///etc/passwd']
    .forEach((u) => assert.strictEqual(charts.checkUrl(u).error, 'invalid-url', u));
  ['https://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://[fd00::1]/x',
    'https://shop.example.com:8443/x', 'http://metadata.google.internal/x', 'http://intranet/x', 'http://printer.local/x', 'http://8.8.8.8/x']
    .forEach((u) => assert.strictEqual(charts.checkUrl(u).error, 'blocked-address', u));
});

await test('only public addresses are ever connected to: private, loopback, link-local, metadata and mapped addresses are refused', async () => {
  ['10.1.2.3', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']
    .forEach((ip) => assert.strictEqual(charts.isPublicAddress(ip), false, ip));
  ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111'].forEach((ip) => assert.strictEqual(charts.isPublicAddress(ip), true, ip));
  /* the lookup the connection itself uses: a name that resolves privately is refused at connect time */
  const dns = require('dns');
  const original = dns.lookup;
  dns.lookup = (host, opts, cb) => cb(null, host === 'rebind.example.com' ? [{ address: '10.0.0.7', family: 4 }, { address: '93.184.216.34', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
  try {
    const refused = await new Promise((resolve) => charts.guardedLookup('rebind.example.com', {}, (err) => resolve(err)));
    assert.strictEqual(refused && refused.code, 'EBLOCKED');
    const allowed = await new Promise((resolve) => charts.guardedLookup('shop.example.com', {}, (err, address) => resolve([err, address])));
    assert.deepStrictEqual(allowed, [null, '93.184.216.34']);
  } finally { dns.lookup = original; }
  /* a refused connection is said as such */
  const r = await read(SHOP, { [SHOP]: { throws: 'blocked' } });
  assert.strictEqual(r.reason, 'blocked-address');
});

await test('a product Fynd has a record for: its own body and garment charts, as the brand wrote them, with the record’s own status', async () => {
  const log = [];
  const r = await read('https://www.uniqlo.com/us/en/products/E475378-000/00?colorDisplayCode=09', {}, log);
  assert.deepStrictEqual(log, [], 'the record is used; the page is not read again');
  assert.strictEqual(r.from, 'fynd-record');
  assert.strictEqual(r.productId, 'uniqlo-e475378-sweat-pullover-hoodie-us');
  assert.strictEqual(r.scope, 'product-specific');
  assert.strictEqual(r.verification, 'unverified', 'the record’s own status: the UNIQLO pair is pending review');
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.unit]), [['finished-garment', 'in'], ['body', 'in']], 'the garment’s own measurements first');
  assert.deepStrictEqual(r.charts[1].rows.find((x) => x.size === 'M').values, ['37 ¾ - 41'], 'values kept exactly as published');
  /* each column says how the brand measured it: a flat width, never a circumference */
  const garment = r.charts[0];
  const methodOf = (label) => garment.methods[garment.columns.findIndex((c) => label.test(c))];
  assert.strictEqual(garment.methods.length, garment.columns.length);
  assert.strictEqual(methodOf(/^chest/i), 'flat, armpit to armpit');
  assert.strictEqual(methodOf(/length \(back\)/i), 'from the centre back');
  assert.strictEqual(methodOf(/shoulder/i), 'seam to seam');
  assert.deepStrictEqual(r.charts[1].methods, ['around the body'], 'the body chest is a circumference of the body');
  assert.strictEqual(r.comparable, false, 'pending review: never set beside a garment the shopper owns');
  const tee = await read('https://www.zara.com/us/en/basic-medium-weight-t-shirt--02-p01887411.html', {});
  assert.deepStrictEqual([tee.verification, tee.comparable], ['unverified', false]);
  const nike = await read('https://www.nike.com/t/club-mens-fleece-crew-RU1Il4yl/FN3886-010', {});
  assert.deepStrictEqual(nike.charts.map((c) => c.measures), ['body']);
  assert.deepStrictEqual(nike.charts[0].columns, ['Chest/Bust (in)'], 'a chest-only chart gains no columns, and keeps the brand’s own label');
  assert.ok(nike.note.some((n) => /no finished-garment measurements/.test(n)));
});

await test('any shop’s product page: its garment table read as written, in its own unit, labelled from its own words, and not verified', async () => {
  const r = await read(SHOP, { [SHOP]: { body: GARMENT_CM } });
  assert.deepStrictEqual([r.status, r.from, r.scope, r.verification], ['ok', 'live-page', 'product-page', 'not-verified']);
  assert.deepStrictEqual(r.product, { brand: 'Example Brand', name: 'Illustrative Tee', code: 'TEST001' });
  assert.strictEqual(r.retailer, 'Example Shop');
  assert.strictEqual(r.market, 'GB', 'from the page’s own og:locale');
  const c = r.charts[0];
  assert.deepStrictEqual([c.measures, c.unit, c.source.url], ['finished-garment', 'cm', SHOP]);
  assert.deepStrictEqual(c.columns, ['Chest width', 'Body length', 'Sleeve']);
  assert.deepStrictEqual(c.rows, [{ size: 'S', values: ['51', '70', '20.5'] }, { size: 'M', values: ['54', '72', '21'] }, { size: 'L', values: ['57', '74', '21.5'] }]);
  assert.strictEqual(r.comparable, false, 'how each was measured isn’t known, so it isn’t offered for comparison');
});

await test('a body chart is called a body chart, never the garment; an unlabelled one is "not stated", never assumed', async () => {
  const body = await read(SHOP, { [SHOP]: { body: BODY_IN } });
  assert.deepStrictEqual([body.charts[0].measures, body.charts[0].unit], ['body', 'in']);
  assert.ok(body.note.some((n) => /body measurements — the body each size is cut for, not the garment/.test(n)));
  assert.strictEqual(charts.unitOf('Measured laid flat, in cm.'), 'cm', '"in" as a word is not inches');
  assert.strictEqual(charts.unitOf('Chest (in)'), 'in');
  const html = page('<table><tr><th>Size</th><th>Chest</th><th>Length</th></tr><tr><td>S</td><td>96</td><td>70</td></tr><tr><td>M</td><td>102</td><td>72</td></tr></table>');
  const r = await read(SHOP, { [SHOP]: { body: html } });
  assert.deepStrictEqual([r.charts[0].measures, r.charts[0].unit], ['not-stated', null]);
  assert.ok(r.note.some((n) => /doesn’t say whether these are body or garment/.test(n)));
});

/* Illustrative tables only (FIXTURE): invented sizes and numbers in the
   shapes size guides take, to test how a table is labelled. */
const fixtureTable = (caption, cols, rows) => `<table><caption>${caption}</caption><tr><th>Size</th>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}</table>`;
const kindsOf = async (inner) => (await read(SHOP, { [SHOP]: { body: page(inner) } })).charts.map((c) => c.measures);

await test('a "Product size" label alone doesn’t make a table the garment: its columns must be the garment’s own, and a body-only column makes it "not stated"', async () => {
  /* the garment's own geometry under a product-size label: the garment */
  assert.deepStrictEqual(await kindsOf(fixtureTable('Product size (cm)', ['Body length', 'Body width', 'Sleeve length'], [['S', '66', '50', '60'], ['M', '68', '53', '61']])), ['finished-garment']);
  /* a product-size label over height, chest and waist: those describe a person — not stated */
  assert.deepStrictEqual(await kindsOf(fixtureTable('Product size', ['Height', 'Chest', 'Waist'], [['S', '165-170', '86-90', '70-74'], ['M', '170-175', '90-94', '74-78']])), ['not-stated']);
  /* a product-size label over chest and waist alone: nothing says which, so not stated */
  assert.deepStrictEqual(await kindsOf(fixtureTable('Product size', ['Chest', 'Waist'], [['S', '96', '80'], ['M', '102', '86']])), ['not-stated']);
  /* even a method-stated garment table is not stated once it has a measure of the wearer */
  assert.deepStrictEqual(await kindsOf(`<h3>Garment measurements</h3><p>Measured laid flat.</p>${fixtureTable('', ['Chest width', 'Height'], [['S', '51', '165-170'], ['M', '54', '170-175']])}`), ['not-stated']);
  /* a stated garment table may measure bust or hip: a dress's, a pair of jeans' — laid flat */
  assert.deepStrictEqual(await kindsOf(`<h3>Garment measurements</h3><p>Measured laid flat.</p>${fixtureTable('', ['Waist', 'Hip', 'Inseam'], [['30', '40', '52', '81'], ['32', '42', '54', '81']])}`), ['finished-garment']);
  /* but a bare label over hip and waist says nothing: those could be the wearer's */
  assert.deepStrictEqual(await kindsOf(fixtureTable('Product size', ['Waist', 'Hip', 'Inseam'], [['30', '76', '96', '81'], ['32', '81', '101', '81']])), ['not-stated']);
  assert.deepStrictEqual(await kindsOf(fixtureTable('Product size', ['Bust width', 'Length'], [['S', '44', '90'], ['M', '46', '92']])), ['finished-garment'], 'unless the column itself says width');
  /* a body chart keeps its body columns, and stays a body chart */
  assert.deepStrictEqual(await kindsOf(`<h3>Body size</h3><p>Body measurements, in inches.</p>${fixtureTable('', ['Height', 'Chest', 'Waist'], [['S', '65-67', '35-37', '29-31'], ['M', '67-69', '38-40', '32-34']])}`), ['body']);
});

await test('a page with both a body chart and the garment’s own: the garment comes first, each labelled by its own heading, and nothing is verified', async () => {
  const both = `<h3>Body size</h3><p>Body measurements, in inches. Use these to find the size made to fit your body.</p>
    ${fixtureTable('', ['Chest', 'Waist'], [['S', '35-37', '29-31'], ['M', '38-40', '32-34']])}
    <h3>Product size</h3><p>Garment measurements, laid flat, in inches.</p>
    ${fixtureTable('', ['Body length', 'Body width', 'Sleeve length'], [['S', '26', '20', '24'], ['M', '27', '21', '24.5']])}`;
  const r = await read(SHOP, { [SHOP]: { body: page(both) } });
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.unit, c.columns[0]]), [['finished-garment', 'in', 'Body length'], ['body', 'in', 'Chest']],
    'the garment first; the body heading above the first table doesn’t speak for the second');
  assert.deepStrictEqual([r.verification, r.comparable], ['not-verified', false], 'read just now: never verified, never compared');
});

await test('a size guide in UNIQLO’s words (FIXTURE values): Product Size first, “Chest” kept as published, the Body Size tab still body', async () => {
  /* the tab sentences are UNIQLO's (as recorded in uniqlo-e475378's notes); every value here is invented */
  const both = `<h3>Body Size</h3><p>The dimensions shown below are body size measurements that correspond with a product’s size. Inches</p>
    ${fixtureTable('', ['Chest'], [['S', '34 - 37'], ['M', '37 - 40']])}
    <h3>Product Size</h3><p>The dimensions shown below are the actual measurements of the product. Inches</p>
    ${fixtureTable('', ['Length (back)', 'Shoulder width (seam to seam)', 'Chest', 'Sleeve Length (center back)'], [['S', '26', '21', '23', '33'], ['M', '27', '22', '24', '34']])}`;
  const r = await read(SHOP, { [SHOP]: { body: page(both) } });
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.unit]), [['finished-garment', 'in'], ['body', 'in']]);
  assert.deepStrictEqual(r.charts[0].columns, ['Length (back)', 'Shoulder width (seam to seam)', 'Chest', 'Sleeve Length (center back)'], 'columns as published: “Chest” is not renamed a circumference or a width');
  assert.deepStrictEqual(r.charts[0].rows.find((x) => x.size === 'M').values, ['27', '22', '24', '34']);
  assert.deepStrictEqual(r.charts[0].methods, [null, 'seam to seam', null, 'center back'], 'a method only in the column’s own words; “Chest” says none');
  assert.ok(!('methods' in r.charts[1]), 'a body chart has no garment method');
  assert.deepStrictEqual([r.verification, r.comparable], ['not-verified', false]);
  /* the classifier itself */
  const T = require('../assets/sizing-tables');
  const PRODUCT = 'Product Size The dimensions shown below are the actual measurements of the product.';
  const BODY = 'Body Size The dimensions shown below are body size measurements that correspond with a product’s size.';
  assert.strictEqual(T.kindOf(`${PRODUCT} Chest`, ['Chest']), 'finished-garment', 'the brand’s statement, not the tab’s name, makes a chest-only table the garment');
  assert.strictEqual(T.kindOf(`${PRODUCT} Height Chest`, ['Height', 'Chest']), 'not-stated', 'a body-only column still vetoes it');
  assert.strictEqual(T.kindOf(`${BODY} Chest`, ['Chest']), 'body', '“a product’s size” is not a product-size label');
  assert.strictEqual(T.kindOf('Body Size Product Size Chest', ['Chest']), 'not-stated', 'a tab list naming both tabs speaks for neither');
  assert.strictEqual(T.kindOf('Product Size Chest', ['Chest']), 'not-stated', 'the tab’s name alone is not proof');
});

await test('every record with the garment’s own chart lists it first, with its unit and each column’s method; body-only records stay body', () => {
  const recs = require('../api/_sizing/records');
  const all = recs.RECORDS;
  assert.ok(Array.isArray(all) && all.length >= 10, 'every record is checked');
  all.forEach((rec) => {
    const r = charts.fromRecord(rec, null);
    const kinds = r.charts.map((c) => c.measures);
    if (rec.charts.garment) {
      assert.strictEqual(kinds[0], 'finished-garment', rec.id);
      const g = r.charts[0];
      assert.strictEqual(g.unit, rec.units, rec.id);
      assert.deepStrictEqual(g.methods, Object.values(rec.charts.garment.dimensions).map((d) => engine.METHOD_WORDS[d.method] || null), rec.id);
    } else {
      assert.deepStrictEqual(kinds, ['body'], rec.id);
      assert.strictEqual(r.comparable, false, `${rec.id}: a body chart is never comparable`);
    }
  });
});

await test('no table on the page: the size guide it links to is read, and labelled as the retailer’s guide, not the product’s own', async () => {
  const GUIDE = 'https://shop.example.com/pages/size-guide';
  const product = page('<a href="/pages/size-guide">Size guide</a><a href="/cart">Cart</a><a href="https://other.example.org/size-chart">Size chart elsewhere</a>',
    LD({ '@type': 'Product', name: 'Illustrative Tee', brand: 'Example Brand', hasVariant: ['S', 'M'].map((size) => ({ size })) }));
  const guide = page('<h1>Men’s tops size guide</h1><p>Body measurements in inches.</p><table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>34-36</td></tr><tr><td>M</td><td>38-40</td></tr></table>');
  const log = [];
  const r = await read(SHOP, { [SHOP]: { body: product }, [GUIDE]: { body: guide } }, log);
  assert.deepStrictEqual(log.map((x) => x.url), [SHOP, GUIDE], 'only the same site’s guide is read');
  assert.deepStrictEqual([r.status, r.scope], ['ok', 'linked-size-guide']);
  assert.strictEqual(r.charts[0].source.url, GUIDE);
  assert.deepStrictEqual([r.charts[0].measures, r.charts[0].columns], ['body', ['Chest']]);
  assert.match(r.note[0], /retailer’s size guide linked from that page — it may be a general chart/);
  assert.deepStrictEqual(r.guides, [{ url: GUIDE, read: true, reason: null }]);
  /* a guide that can't be read leaves the sizes as labels, and says the guide was tried */
  const labels = await read(SHOP, { [SHOP]: { body: product }, [GUIDE]: { status: 403 } });
  assert.strictEqual(labels.status, 'labels-only');
  assert.match(labels.note[0], /or in the size guide it links to/);
  assert.deepStrictEqual(labels.guides, [{ url: GUIDE, read: false, reason: 'refused' }]);
});

await test('incomplete and sideways tables keep only what they give; a table that isn’t a size chart is ignored', async () => {
  const sideways = page('<p>Body measurements (cm)</p><table><tr><th>Size</th><th>S</th><th>M</th><th>L</th></tr><tr><td>Chest</td><td>88-96</td><td>96-104</td><td></td></tr><tr><td>Waist</td><td>73-81</td><td>81-89</td><td>89-97</td></tr></table>');
  const r = await read(SHOP, { [SHOP]: { body: sideways } });
  assert.deepStrictEqual(r.charts[0].columns, ['Chest', 'Waist']);
  assert.deepStrictEqual(r.charts[0].rows.find((x) => x.size === 'L').values, ['', '89-97'], 'a missing value stays missing');
  const notChart = page('<table><tr><th>Delivery</th><th>Price</th></tr><tr><td>Standard</td><td>$5</td></tr><tr><td>Express</td><td>$15</td></tr></table>');
  const none = await read(SHOP, { [SHOP]: { body: notChart } });
  assert.deepStrictEqual([none.status, none.reason], ['unavailable', 'no-chart']);
  assert.strictEqual(none.note[1], charts.COULD_NOT);
});

await test('a page drawn by script is said to be, with nothing invented', async () => {
  const shell = '<!doctype html><html><head><title>Shop</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
  const r = await read(SHOP, { [SHOP]: { body: shell } });
  assert.deepStrictEqual([r.status, r.reason, r.charts.length], ['unavailable', 'needs-script', 0]);
  assert.match(r.note[0], /builds its content with JavaScript/);
});

await test('sizes with no measurements are labels only, and said', async () => {
  const html = page('<p>Pick a size.</p>', LD({ '@type': 'ProductGroup', name: 'Illustrative Tee', brand: 'Example Brand', hasVariant: ['S', 'M', 'L', 'XL'].map((size) => ({ '@type': 'Product', size })) }));
  const r = await read(SHOP, { [SHOP]: { body: html } });
  assert.deepStrictEqual([r.status, r.sizes, r.charts], ['labels-only', ['S', 'M', 'L', 'XL'], []]);
  assert.match(r.note[0], /lists sizes S–XL, but Fynd found no measurements/);
});

await test('malformed pages and markup in cells: nothing breaks, nothing executable comes back', async () => {
  const broken = page('<script type="application/ld+json">{ not json</script><table><tr><td>oops');
  assert.strictEqual((await read(SHOP, { [SHOP]: { body: broken } })).reason, 'no-chart');
  const hostile = page('<p>Garment measurements, cm</p><table><tr><th>Size</th><th>Chest <img src=x onerror=alert(1)></th></tr><tr><td>S<script>alert(1)</script></td><td>50 &lt;b&gt;</td></tr><tr><td>M</td><td>53</td></tr></table><a href="javascript:alert(1)">Size guide</a>');
  const r = await read(SHOP, { [SHOP]: { body: hostile } });
  const text = JSON.stringify(r);
  assert.ok(!/<script|onerror|<img|javascript:/i.test(text), text);
  assert.deepStrictEqual(r.charts[0].rows[0], { size: 'S', values: ['50 <b>'] }, 'entities read as text, drawn as text');
});

await test('an inaccessible page answers unavailable with its reason and its link — never a chart from elsewhere', async () => {
  const cases = [
    [{ throws: 'unreachable' }, 'unreachable'], [{ throws: 'abort' }, 'no-answer'], [{ status: 403 }, 'refused'], [{ status: 401 }, 'refused'], [{ status: 429 }, 'refused'],
    [{ status: 500 }, 'http-error'], [{ headers: { 'content-type': 'application/pdf' }, body: '%PDF' }, 'not-html'],
    [{ headers: { 'content-length': String(charts.MAX_BYTES + 1) }, body: 'x' }, 'too-large']
  ];
  for (const [route, reason] of cases) {
    const r = await read(SHOP, { [SHOP]: route });
    assert.deepStrictEqual([r.status, r.reason, r.charts.length], ['unavailable', reason, 0], reason);
    assert.strictEqual(r.source.url, SHOP);
    assert.ok(!/runs (small|large)|true to size/i.test(r.note.join(' ')));
  }
});

await test('a link with a brand’s variant and advertising parameters is read as the product’s canonical page', () => {
  const pasted = 'https://www.uniqlo.com/us/en/products/E471808-000/00?colorDisplayCode=03&sizeDisplayCode=005&utm_campaign=pmax_broad_seasonal_promotions_google_cpc_sales_us_evergreen_en&utm_source=google&utm_medium=cpc';
  assert.strictEqual(charts.checkUrl(pasted).url, 'https://www.uniqlo.com/us/en/products/E471808-000/00');
  assert.strictEqual(charts.checkUrl('https://www.gap.com/browse/product.do?pid=1&utm_source=x').url, 'https://www.gap.com/browse/product.do?pid=1', 'another shop keeps the query that names its product');
});

/* A transport that holds its answer until the request is aborted —
   a shop that never starts answering, or one whose page stops arriving. */
const holding = (whenAnswered) => async (url, init) => new Promise((resolve, reject) => {
  if (/\/robots\.txt$/.test(url)) return resolve({ status: 404, ok: false, headers: { get: () => null }, text: async () => '' });
  const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (!whenAnswered) { init.signal.addEventListener('abort', abort); return; }
  resolve({ status: 200, ok: true, headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
    text: () => new Promise((done, fail) => init.signal.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
});

await test('no answer and a page still arriving are two failures, each said as itself, with what was tried', async () => {
  const silent = await charts.chartFor(SHOP, { noCache: true, deadlineMs: 150, fetch: holding(false) });
  assert.deepStrictEqual([silent.status, silent.reason], ['unavailable', 'no-answer']);
  assert.match(silent.note[0], /didn’t start answering within a few seconds/);
  assert.deepStrictEqual([silent.trace[0].phase, silent.trace[0].status], ['connect', null]);
  assert.ok(silent.trace[0].ms >= 100 && silent.trace[0].ms < 2000, `${silent.trace[0].ms} ms`);
  const slow = await charts.chartFor(SHOP, { noCache: true, deadlineMs: 150, fetch: holding(true) });
  assert.deepStrictEqual([slow.reason, slow.trace[0].phase, slow.trace[0].status], ['slow-page', 'body', 200]);
  assert.match(slow.note[0], /answered, but the page hadn’t finished arriving/);
});

await test('REGRESSION: a page that loads but has no chart says so — what the page said is kept, and nothing claims a timeout', async () => {
  const product = page('<p>Pick a size.</p>', LD({ '@type': 'Product', name: 'Illustrative Sweat Shorts', brand: { name: 'Example Brand' },
    material: '100% Cotton', additionalProperty: [{ '@type': 'PropertyValue', name: 'Fit', value: 'Relaxed' }] }));
  const r = await read(SHOP, { [SHOP]: { body: product } });
  assert.deepStrictEqual([r.status, r.reason], ['unavailable', 'no-chart']);
  assert.ok(!/took too long|didn’t start answering|hadn’t finished arriving/.test(r.note.join(' ')), r.note.join(' | '));
  assert.ok(r.note.some((n) => /The product page itself did load/.test(n)));
  assert.deepStrictEqual(r.product, { brand: 'Example Brand', name: 'Illustrative Sweat Shorts', code: null });
  assert.deepStrictEqual(r.details, { material: '100% Cotton', fit: 'Relaxed' });
  assert.deepStrictEqual(r.charts, []);
  assert.deepStrictEqual([r.trace[0].status, r.trace[0].phase, r.trace[0].contentType], [200, 'done', 'text/html; charset=utf-8']);
  assert.ok(r.trace[0].bytes > 0);
  assert.strictEqual(r.verification, 'not-verified', 'a page read is not a chart checked');
});

await test('a page that links a size guide which can’t be read says that — not that the page failed', async () => {
  const GUIDE = 'https://shop.example.com/pages/size-guide';
  const product = page('<a href="/pages/size-guide">Size guide</a>');
  const r = await read(SHOP, { [SHOP]: { body: product }, [GUIDE]: { status: 403 } });
  assert.deepStrictEqual([r.status, r.reason], ['unavailable', 'guide-unreadable']);
  assert.match(r.note[0], /The product page loaded and links to a size guide, but that guide couldn’t be read/);
  assert.ok(r.note.some((n) => n.includes(GUIDE) && /refused/.test(n)));
  assert.deepStrictEqual(r.trace.map((t) => [t.requested, t.status]), [[SHOP, 200], [GUIDE, 403]]);
});

await test('redirects are recorded in what was tried', async () => {
  const moved = 'https://shop.example.com/products/illustrative-tee-v2';
  const r = await read(SHOP, { [SHOP]: { status: 301, headers: { location: '/products/illustrative-tee-v2' } }, [moved]: { body: GARMENT_CM } });
  assert.deepStrictEqual(r.trace[0].redirects, [{ status: 301, to: moved }]);
  assert.strictEqual(r.trace[0].url, moved);
});

await test('the real request path: compressed pages are inflated, the size limit applies to what they inflate to, and a slow body is a slow page', async () => {
  const http = require('http');
  const zlib = require('zlib');
  const server = http.createServer((req, res) => {
    if (req.url === '/gzip') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(GARMENT_CM)); }
    if (req.url === '/br') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'br' }); return res.end(zlib.brotliCompressSync(GARMENT_CM)); }
    if (req.url === '/bomb') { res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(Buffer.alloc(charts.MAX_BYTES + 10, 'a'))); }
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>'); return; }
    res.writeHead(404); return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  /* the shop's name is checked as usual, then this test alone sends the
     request to this machine — the real transport refuses loopback */
  const via = (url, init) => charts.request(url.replace('http://shop.example.com', `http://127.0.0.1:${port}`), init);
  try {
    for (const path of ['/gzip', '/br']) {
      const r = await charts.chartFor(`http://shop.example.com${path}`, { noCache: true, fetch: via });
      assert.deepStrictEqual([r.status, r.charts[0].measures, r.charts[0].rows.length], ['ok', 'finished-garment', 3], path);
    }
    assert.strictEqual((await charts.chartFor('http://shop.example.com/bomb', { noCache: true, fetch: via })).reason, 'too-large');
    const slow = await charts.chartFor('http://shop.example.com/slow', { noCache: true, fetch: via, deadlineMs: 300 });
    assert.deepStrictEqual([slow.reason, slow.trace[0].status], ['slow-page', 200]);
  } finally { server.close(); server.closeAllConnections && server.closeAllConnections(); }
});

/* ---------- official fallback charts ---------- */

const officialCharts = require('../api/_sizing/official-charts');
const UQ_OVERSIZED = 'https://www.uniqlo.com/us/en/products/E471808-000/00';
/* A FIXTURE product listed under UNIQLO's general chart with no record
   of its own (E471808, listed there, now has one): added to the chart's
   list for one test, then taken off. Its code is invented. */
const UQ_LISTED = 'https://www.uniqlo.com/us/en/products/E900099-000/00';
const listedUnderGeneral = async (fn) => {
  const entry = { code: 'E900099-000', url: UQ_LISTED, name: 'FIXTURE Listed Hoodie', category: 'hoodies', line: 'men', identity: 'FIXTURE: listed for one test only.' };
  officialCharts.CHARTS[0].products.push(entry);
  try { return await fn(); } finally { officialCharts.CHARTS[0].products.splice(officialCharts.CHARTS[0].products.indexOf(entry), 1); }
};

await test('a product page that times out still shows its brand’s applicable official chart — as a fallback, labelled body-size, with every value’s source', () => listedUnderGeneral(async () => {
  const pasted = `${UQ_LISTED}?colorDisplayCode=03&sizeDisplayCode=005&utm_campaign=pmax&utm_source=google&utm_medium=cpc`;
  const r = await read(pasted, { [UQ_LISTED]: { throws: 'abort' } });
  assert.deepStrictEqual([r.status, r.from, r.fallback.reason, r.scope], ['fallback', 'official-fallback', 'no-answer', 'brand-general']);
  assert.deepStrictEqual(r.product, { brand: 'UNIQLO', name: 'FIXTURE Listed Hoodie', code: 'E900099-000' });
  const c = r.charts[0];
  assert.strictEqual(c.label, 'Official UNIQLO body-size chart — not garment measurements.');
  assert.deepStrictEqual([c.measures, c.unit, c.columns], ['body', 'in', ['Chest']]);
  /* the values are exactly those UNIQLO publishes on the pages it names */
  const hoodie = require('../api/_sizing/records').byId('uniqlo-e475378-sweat-pullover-hoodie-us');
  assert.deepStrictEqual(c.rows.map((x) => [x.size, x.values[0]]), hoodie.sizes.map((s) => [s, hoodie.charts.body.sizes[s].chest.text]));
  assert.deepStrictEqual(c.rows.find((x) => x.size === 'M').values, ['37 ¾ - 41']);
  assert.strictEqual(c.source.url, 'https://www.uniqlo.com/us/en/products/E475378-000/00');
  assert.deepStrictEqual(r.otherSources.map((o) => o.url), ['https://www.uniqlo.com/us/en/products/E475377-000/00', 'https://www.uniqlo.com/us/en/products/E455365-000/00']);
  assert.ok([c.source.url, ...r.otherSources.map((o) => o.url)].every((u) => new URL(u).hostname === 'www.uniqlo.com'), 'every source is UNIQLO’s own site');
  /* never presented as read live, or as this product's own */
  assert.strictEqual(r.source.url, UQ_LISTED);
  assert.strictEqual(r.source.retrievedAt, null, 'the product page was not read');
  assert.strictEqual(r.verification, 'official-general');
  assert.match(r.note[0], /^Reading this product’s page directly timed out/);
  assert.match(r.note[1], /fallback chart, not one extracted from the product’s page/);
  assert.match(r.note.join(' '), /hasn’t been confirmed on this product’s own page/);
  assert.strictEqual(r.trace[0].phase, 'connect', 'what was tried is still reported');
}));

await test('a body-size fallback can never start a garment comparison, and says the product’s own measurements weren’t found', () => listedUnderGeneral(async () => {
  const r = await read(UQ_LISTED, { [UQ_LISTED]: { throws: 'abort' } });
  assert.strictEqual(r.comparable, false);
  assert.strictEqual(r.productId, undefined, 'no record to compare against');
  assert.ok(!r.charts.some((c) => c.measures === 'finished-garment'), 'no garment chart is made up from the body chart');
  assert.strictEqual(require('../api/_sizing/records').byId(r.fallback.chartId), null, 'the chart is not a sizing record the compare endpoint would accept');
  assert.match(r.note.join(' '), /can’t be set beside a garment you own/);
  assert.strictEqual(r.productSize.status, 'not-retrieved');
  /* the moment it was looked for, as an ISO timestamp — never a UTC calendar date that can read as tomorrow */
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.productSize.checkedAt) && Math.abs(Date.now() - Date.parse(r.productSize.checkedAt)) < 60000, r.productSize.checkedAt);
  assert.ok(r.note.some((n) => /^This product’s own measurements — a Product Size chart, where UNIQLO publishes one — weren’t found: its page couldn’t be read\. None are shown, and none are worked out from a body chart\.$/.test(n)), 'the note names no date: the page shows it in the viewer\'s time zone');
}));

await test('a page that loads but holds no chart gets the same fallback, saying the page was read', () => listedUnderGeneral(async () => {
  const shell = '<!doctype html><html><head><title>FIXTURE Listed Hoodie | UNIQLO US</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
  const r = await read(UQ_LISTED, { [UQ_LISTED]: { body: shell } });
  assert.deepStrictEqual([r.status, r.fallback.reason], ['fallback', 'needs-script']);
  assert.match(r.note[0], /^Fynd read this product’s page, but found no size chart in it/);
  assert.ok(!/timed out/.test(r.note.join(' ')));
}));

await test('no fallback is invented: another UNIQLO product, another market, or another shop stays honestly unavailable', async () => {
  const other = 'https://www.uniqlo.com/us/en/products/E999999-000/00';
  const a = await read(other, { [other]: { throws: 'abort' } });
  assert.deepStrictEqual([a.status, a.reason, a.charts], ['unavailable', 'no-answer', []]);
  assert.strictEqual(a.source.url, other, 'the official page is still linked');
  /* E471808 in another market: neither its US record nor the US general chart */
  const uk = 'https://www.uniqlo.com/uk/en/products/E471808-000/00';
  const ukr = await read(uk, { [uk]: { throws: 'abort' } });
  assert.deepStrictEqual([ukr.status, ukr.charts, ukr.productId], ['unavailable', [], undefined]);
  const b = await read(SHOP, { [SHOP]: { throws: 'abort' } });
  assert.deepStrictEqual([b.status, b.reason], ['unavailable', 'no-answer']);
  assert.strictEqual(officialCharts.fallbackFor(charts.checkUrl('https://www.uniqlo.com/us/en/products/E4718080-000/00')), null, 'a code is matched whole');
});

await test('a page that does give its own chart is used, not the fallback', () => listedUnderGeneral(async () => {
  const r = await read(UQ_LISTED, { [UQ_LISTED]: { body: BODY_IN } });
  assert.deepStrictEqual([r.status, r.from, r.scope], ['ok', 'live-page', 'product-page']);
}));

await test('the official-chart loader refuses a chart that disagrees with its sources, isn’t a body chart, or reaches past its category', () => {
  assert.deepStrictEqual(officialCharts.problems, []);
  assert.strictEqual(officialCharts.CHARTS.length, 1);
  const base = JSON.parse(JSON.stringify(require('../api/_sizing/official-charts/uniqlo-us-men-tops-body.json')));
  const variant = (f) => { const c = JSON.parse(JSON.stringify(base)); f(c); return officialCharts.validate(c); };
  assert.deepStrictEqual(officialCharts.validate(base), []);
  assert.ok(variant((c) => { c.values.M.chest = '38 - 41'; }).some((e) => /disagrees at M chest/.test(e)), 'a changed value');
  assert.ok(variant((c) => { c.measures = 'finished-garment'; }).length, 'a garment chart');
  assert.ok(variant((c) => { c.label = 'Official UNIQLO size chart'; }).length, 'a label that doesn’t say body-size');
  assert.ok(variant((c) => { c.products[0].category = 'jeans'; }).length, 'a product outside the category');
  assert.ok(variant((c) => { c.products[0].url = 'https://uniqlo.example.com/us/en/products/E471808-000/00'; }).length, 'a product off the brand’s site');
  assert.ok(variant((c) => { c.evidence[0].recordId = 'zara-00761810-basic-heavyweight-hoodie-us'; }).length, 'evidence from another brand');
  assert.ok(variant((c) => { c.evidence[0].url = 'https://uniqlloshop.it.com/product/sweat-pullover-hoodie/'; }).length, 'evidence off the brand’s site');
  assert.ok(variant((c) => { delete c.products[0].identity; }).length, 'a product with no account of how it is known');
  /* a fallback product's productSize may only say it wasn't retrieved: garment values belong in a record */
  const ps = (extra) => (c) => { c.products[0].productSize = Object.assign({ status: 'not-retrieved', checkedAt: '2026-10-19', tried: ['FIXTURE: somewhere'] }, extra); };
  assert.deepStrictEqual(variant(ps({})), [], 'saying where it was looked for is allowed');
  assert.ok(variant((c) => { ps({})(c); c.products[0].productSize.status = 'verified'; }).some((e) => /productSize may only say it was not retrieved/.test(e)), 'a claimed Product Size');
  assert.ok(variant(ps({ values: { M: { chestWidth: '24' } } })).some((e) => /productSize may only say/.test(e)), 'garment values in a fallback');
  assert.ok(variant(ps({ tried: [] })).some((e) => /its date and what was tried/.test(e)), 'no account of what was tried');
  assert.deepStrictEqual(variant((c) => { delete c.products[0].productSize; }), [], 'saying nothing about it is allowed');
});

await test('redirects are followed by hand, and every new address is checked again', async () => {
  const log = [];
  const moved = 'https://shop.example.com/products/illustrative-tee-v2';
  const r = await read(SHOP, { [SHOP]: { status: 301, headers: { location: '/products/illustrative-tee-v2' } }, [moved]: { body: GARMENT_CM } }, log);
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.source.url, moved);
  assert.ok(log.every((x) => x.redirect === 'manual'));
  for (const location of ['http://127.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/', 'https://localhost/x', 'ftp://shop.example.com/x', 'http://10.0.0.1/']) {
    const away = await read(SHOP, { [SHOP]: { status: 302, headers: { location } } });
    assert.strictEqual(away.reason, 'redirected-away', location);
  }
  const loop = await read(SHOP, { [SHOP]: { status: 302, headers: { location: SHOP } } });
  assert.strictEqual(loop.reason, 'too-many-redirects');
});

await test('cached by address without tracking: asked twice, read once; another product is its own entry', async () => {
  const log = [];
  const opts = { fetch: fakeFetch({ [SHOP]: { body: GARMENT_CM } }, log) };
  const first = await charts.chartFor(`${SHOP}?utm_source=mail`, opts);
  const second = await charts.chartFor(`${SHOP}?utm_campaign=x#top`, opts);
  assert.strictEqual(log.length, 1);
  assert.strictEqual(second.cached, true);
  assert.deepStrictEqual(second.charts, first.charts);
  const other = await charts.chartFor('https://shop.example.com/products/other', { fetch: fakeFetch({}, log) });
  assert.strictEqual(other.reason, 'unreachable', 'another product is never answered from this one’s entry');
});

await test('/api/size-recommendation?chart= needs no account, reads no profile, and is rate limited', async () => {
  charts.setTransport(fakeFetch({ [SHOP]: { body: GARMENT_CM } }));
  try {
    const chartCall = (url, o) => call(recommendEndpoint, Object.assign({ method: 'GET', jar: {}, query: { chart: url }, url: '/api/size-recommendation?chart=…' }, o));
    const signedOut = await chartCall('https://www.uniqlo.com/us/en/products/E475378-000/00');
    assert.deepStrictEqual([signedOut.status, signedOut.body.chart.status], [200, 'ok']);
    assert.strictEqual(signedOut.res.getHeader('cache-control'), 'no-store, private');
    assert.strictEqual((await chartCall(SHOP)).body.chart.scope, 'product-page');
    assert.strictEqual((await chartCall('http://169.254.169.254/latest/meta-data/')).body.chart.reason, 'blocked-address');
    const headers = { 'x-forwarded-for': '198.51.100.77' };
    let last;
    for (let i = 0; i < 41; i += 1) last = await chartCall('not a url', { headers });
    assert.deepStrictEqual([last.status, last.body.reason], [429, 'rate-limited']);
  } finally { charts.setTransport(null); pageAccess.setPolicy(TEST_SHOPS); }
});

section('every product: its own finished-garment measurements first (FIXTURE pages)');

/* ILLUSTRATIVE FIXTURES — invented pages in the shapes real ones take.
   Every number is made up; none is evidence about any product. The
   retailers' addresses are used only so the brand rules apply; nothing
   is fetched from them. */
const NIKE_CREW_URL = 'https://www.nike.com/t/club-mens-fleece-crew-RU1Il4yl/FN3886-010';
const garmentTableIn = (heading, words, cols, rows) => `<h3>${heading}</h3><p>${words}</p>${fixtureTable('', cols, rows)}`;
const NIKE_GARMENT = page(garmentTableIn('Product measurements', 'Garment measurements, laid flat, in inches.', ['Chest width', 'Body length', 'Sleeve length (center back)'],
  [['S', '20', '26', '33'], ['M', '21.5', '27', '34'], ['L', '23', '28', '35']]));

await test('a product whose record holds only the body chart still has its page read for the garment’s own measurements, which lead', async () => {
  const log = [];
  const r = await read(NIKE_CREW_URL, { [NIKE_CREW_URL]: { body: NIKE_GARMENT } }, log);
  assert.deepStrictEqual(log.map((x) => x.url), [NIKE_CREW_URL], 'the exact product’s page was asked');
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.origin, c.verification]),
    [['finished-garment', 'product-page', 'not-verified'], ['body', 'fynd-record', 'verified']], 'the page’s garment chart first; the record’s checked body chart kept apart');
  assert.deepStrictEqual(r.charts[0].columns, ['Chest width', 'Body length', 'Sleeve length (center back)']);
  assert.deepStrictEqual(r.charts[0].methods, ['laid flat (said of the whole table)', null, 'center back'], 'methods only in the page’s own words');
  assert.deepStrictEqual(r.charts[1].columns, ['Chest/Bust (in)'], 'the record’s body chart as the brand labels it');
  assert.strictEqual(r.productId, 'nike-fn3886-club-fleece-crew-us');
  assert.strictEqual(r.comparable, false, 'a garment table read just now is never compared');
  assert.ok(!r.productSize, 'the garment’s own measurements were found');
  assert.ok(r.note.some((n) => /body chart is from Fynd’s record of this product/.test(n)));
});

await test('the same product, its page read but with no garment table: the record’s body chart, and the missing measurements said', async () => {
  const bodyOnly = page(`<h3>Body size</h3><p>Body measurements, in inches.</p>${fixtureTable('', ['Chest'], [['S', '35-37.5'], ['M', '37.5-41']])}`);
  const r = await read(NIKE_CREW_URL, { [NIKE_CREW_URL]: { body: bodyOnly } });
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.origin]), [['body', 'fynd-record']], 'one body chart: the record’s, not the page’s again');
  assert.strictEqual(r.productSize.status, 'not-found');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.productSize.checkedAt), r.productSize.checkedAt);
  assert.ok(r.note.some((n) => /^This product’s page had no finished-garment measurements/.test(n)));
  const slow = await read(NIKE_CREW_URL, { [NIKE_CREW_URL]: { throws: 'abort' } });
  assert.deepStrictEqual([slow.from, slow.productSize.status, slow.productSize.reason], ['fynd-record', 'not-retrieved', 'no-answer']);
  assert.ok(slow.note.some((n) => /weren’t found: its page couldn’t be read/.test(n)));
});

await test('a record with the garment’s own chart answers without a read; only the exact product, in its own market, matches it', async () => {
  const log = [];
  await read('https://www.uniqlo.com/us/en/products/E475378-000/00', {}, log);
  assert.deepStrictEqual(log, []);
  /* a longer code that starts the same is another product */
  const near = 'https://www.uniqlo.com/us/en/products/E4753780-000/00';
  const a = await read(near, { [near]: { throws: 'abort' } });
  assert.ok(!a.productId && !a.charts.some((c) => c.origin === 'fynd-record'), 'E4753780 is not E475378');
  /* the same product in another market is not the US record */
  const uk = 'https://www.uniqlo.com/uk/en/products/E475378-000/00';
  const b = await read(uk, { [uk]: { throws: 'abort' } });
  assert.deepStrictEqual([b.status, b.charts], ['unavailable', []], 'a US record never answers for a UK page');
  /* each brand's own code forms */
  const schemaMod = require('../api/_sizing/schema');
  assert.ok(schemaMod.codeIn('/us/en/basic-heavyweight-hoodie-p00761810.html', 'Zara', '00761810'));
  assert.ok(!schemaMod.codeIn('/us/en/x-p007618109.html', 'Zara', '00761810'));
  assert.ok(schemaMod.codeIn('/en_us/productpage.0685816001.html', 'H&M', '0685816'), 'H&M’s colour after the code');
  assert.ok(!schemaMod.codeIn('/product/K1210/x', 'Carhartt', 'K121'));
});

await test('a page with only a body chart: the garment chart from the size guide it links to leads, labelled as the guide’s', async () => {
  const guide = 'https://shop.example.com/pages/size-guide';
  const withLink = page(`<h3>Body size</h3><p>Body measurements, in inches.</p>${fixtureTable('', ['Chest', 'Waist'], [['S', '35-37', '29-31'], ['M', '38-40', '32-34']])}
    <p><a href="/pages/size-guide">Size guide</a></p>`);
  const guidePage = page(`${garmentTableIn('Tees — garment measurements', 'Laid flat, in inches.', ['Chest width', 'Body length'], [['S', '19', '27'], ['M', '20.5', '28']])}
    <h3>Tees — body size</h3><p>Body measurements, in inches.</p>${fixtureTable('', ['Chest'], [['S', '34-36'], ['M', '37-39']])}`);
  const r = await read(SHOP, { [SHOP]: { body: withLink }, [guide]: { body: guidePage } });
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.origin]), [['finished-garment', 'linked-size-guide'], ['body', 'product-page']],
    'the guide’s garment chart first, the page’s own body chart kept; the guide’s general body chart adds nothing');
  assert.strictEqual(r.scope, 'linked-size-guide');
  assert.strictEqual(r.charts[0].source.url, guide);
  assert.ok(r.note.some((n) => /^The product page has no garment measurements of its own\. The garment chart is from the retailer’s size guide/.test(n)));
  /* a page that has its own garment table never reaches for a guide */
  const log = [];
  await read(SHOP, { [SHOP]: { body: GARMENT_CM.replace('</body>', '<a href="/pages/size-guide">Size guide</a></body>') } }, log);
  assert.deepStrictEqual(log.map((x) => x.url), [SHOP]);
});

await test('each kind of garment keeps its own measurements: tops, jeans and a dress, two tables on one page never merged', async () => {
  const jeans = garmentTableIn('Jeans — product measurements', 'Garment measurements, laid flat, in cm.', ['Waist', 'Hip', 'Front rise', 'Thigh', 'Leg opening', 'Inseam'],
    [['28', '37', '48', '27', '29', '18', '81'], ['30', '39', '50', '28', '30', '19', '81'], ['32', '41', '52', '29', '31', '20', '81']]);
  const tops = garmentTableIn('Overshirt — product measurements', 'Garment measurements, laid flat, in cm.', ['Chest width', 'Body length', 'Shoulder width', 'Sleeve length'],
    [['S', '54', '72', '45', '62'], ['M', '57', '74', '47', '63']]);
  const r = await read(SHOP, { [SHOP]: { body: page(tops + jeans) } });
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.unit, c.columns.length]), [['finished-garment', 'cm', 4], ['finished-garment', 'cm', 6]]);
  assert.deepStrictEqual(r.charts[1].columns, ['Waist', 'Hip', 'Front rise', 'Thigh', 'Leg opening', 'Inseam'], 'a bottom’s own columns, not a hoodie’s four');
  assert.deepStrictEqual(r.charts[1].rows.map((x) => x.size), ['28', '30', '32']);
  assert.deepStrictEqual(r.charts[1].methods, ['laid flat (said of the whole table)', 'laid flat (said of the whole table)', null, 'laid flat (said of the whole table)', 'laid flat (said of the whole table)', null]);
  assert.deepStrictEqual(r.charts[0].rows[0].values, ['54', '72', '45', '62'], 'the first table’s values stay its own');
  const dress = garmentTableIn('Product measurements', 'Garment measurements, laid flat, in inches.', ['Bust', 'Waist', 'Length (shoulder to hem)'], [['XS', '16', '13', '35'], ['S', '17', '14', '35.5']]);
  const d = await read(SHOP, { [SHOP]: { body: page(dress) } });
  assert.deepStrictEqual([d.charts[0].measures, d.charts[0].columns], ['finished-garment', ['Bust', 'Waist', 'Length (shoulder to hem)']], 'a stated garment table may measure a bust');
});

await test('a missing value stays missing; a page with no table it can read, or an unlisted product, gets no chart from elsewhere', async () => {
  const gaps = garmentTableIn('Product measurements', 'Garment measurements, laid flat, in inches.', ['Chest width', 'Body length', 'Sleeve length'], [['S', '20', '26', ''], ['M', '21', '27', '34']]);
  const r = await read(SHOP, { [SHOP]: { body: page(gaps) } });
  assert.deepStrictEqual(r.charts[0].rows[0].values, ['20', '26', ''], 'nothing filled in from M');
  const divs = page('<div class="chart"><div>S</div><div>Chest 20</div><div>M</div><div>Chest 21</div></div>');
  const n = await read(SHOP, { [SHOP]: { body: divs } });
  assert.deepStrictEqual([n.status, n.charts, n.productSize], ['unavailable', [], undefined], 'no chart, and no measurement promised');
  const other = 'https://www.uniqlo.com/us/en/products/E999998-000/00';
  const o = await read(other, { [other]: { body: page('<p>No size table here.</p>') } });
  assert.ok(!o.fallback && !o.charts.length, 'E471808’s general fallback is not lent to an unlisted product');
});

await test('a draft record from extracted tables: the product’s identity, every value as text and number, methods left for a person — always unverified, never loaded', async () => {
  const { draftFrom } = require('./draft-sizing-record');
  const r = await read(NIKE_CREW_URL.replace('FN3886', 'FX0000'), { [NIKE_CREW_URL.replace('FN3886', 'FX0000')]: { body: NIKE_GARMENT } });
  assert.strictEqual(r.from, 'live-page');
  const { draft, problems } = draftFrom(r, { category: 'sweatshirts', line: 'men' });
  assert.strictEqual(draft.verification.status, 'unverified');
  assert.strictEqual(draft.review.status, 'pending');
  assert.strictEqual(draft.product.url, NIKE_CREW_URL.replace('FN3886', 'FX0000'));
  assert.deepStrictEqual(Object.keys(draft.charts), ['garment']);
  const g = draft.charts.garment;
  assert.deepStrictEqual(Object.keys(g.dimensions), ['chestWidth', 'bodyLength', 'sleeveLength']);
  assert.deepStrictEqual([g.dimensions.chestWidth.method, g.dimensions.chestWidth.pageSays], [null, 'laid flat (said of the whole table)'], 'the page’s words kept; the method is a person’s to set');
  assert.deepStrictEqual(g.sizes.M.chestWidth, { value: 21.5, text: '21.5' });
  assert.ok(problems.some((p) => /method/i.test(p)), 'the schema’s refusals are the checklist');
  assert.ok(require('../api/_sizing/schema').validate(draft).length > 0, 'a draft can’t pass as a record');
  assert.ok(!require('../api/_sizing/records').RECORDS.some((x) => x.id === draft.id), 'and is never loaded');
  /* columns the schema has no dimension for are kept, not dropped */
  const jeans = await read(SHOP, { [SHOP]: { body: page(garmentTableIn('Product measurements', 'Garment measurements, laid flat, in cm.', ['Waist', 'Inseam'], [['30', '39', '81'], ['32', '41', '81']])) } });
  const dj = draftFrom(jeans, {});
  assert.deepStrictEqual(dj.draft.review.unmapped.map((u) => u.column), ['Waist', 'Inseam']);
  assert.deepStrictEqual(dj.draft.review.unmapped[1].values, { 30: '81', 32: '81' });
  /* nothing to draft from a body-only or failed answer's garment */
  assert.strictEqual(draftFrom({ status: 'unavailable', reason: 'no-answer' }).draft, null);
});

section('E471808: the Product Size table supplied for it, pending review');

/* The table as it was supplied (transcribed from UNIQLO's official
   Product Size tab for E471808, inches). These are the record's own
   values, not a fixture; Fynd has not read them from uniqlo.com. */
const E471808_SUPPLIED = [
  ['XXS', '25 1/4', '21 1/2', '21 1/4', '32 1/4'], ['XS', '26', '22', '22 1/2', '32 3/4'], ['S', '27 1/4', '22 3/4', '23 1/2', '33 3/4'],
  ['M', '28 1/4', '23 1/4', '24 3/4', '34 3/4'], ['L', '29 1/2', '24', '26 1/2', '35 3/4'], ['XL', '30 1/4', '24 3/4', '28', '36 1/4'],
  ['XXL', '30 1/2', '25 1/2', '29 1/4', '36 1/2'], ['3XL', '31 1/4', '26 1/2', '30 3/4', '37']
];
const E471808_ID = 'uniqlo-e471808-sweat-oversized-pullover-hoodie-us';

await test('E471808: its own Product Size chart — eight sizes, four columns, inches, as supplied — leads UNIQLO’s general body chart, pending review, with nothing read', async () => {
  const log = [];
  const r = await read(`${UQ_OVERSIZED}?colorDisplayCode=09&sizeDisplayCode=005`, {}, log);
  assert.deepStrictEqual(log, [], 'the record answers; uniqlo.com is not asked');
  assert.deepStrictEqual([r.status, r.from, r.productId, r.verification, r.comparable, r.capture], ['ok', 'fynd-record', E471808_ID, 'unverified', false, 'supplied-transcription']);
  assert.deepStrictEqual(r.product, { brand: 'UNIQLO', name: 'Sweat Oversized Pullover Hoodie', code: 'E471808-000' });
  assert.deepStrictEqual(r.charts.map((c) => [c.measures, c.origin, c.verification]), [['finished-garment', 'fynd-record', 'unverified'], ['body', 'official-general', 'official-general']]);
  const g = r.charts[0];
  assert.deepStrictEqual(g.columns, ['Length (back)', 'Shoulder width', 'Chest', 'Sleeve length (center back)'], 'the dimensions’ own names');
  assert.strictEqual(g.unit, 'in');
  assert.deepStrictEqual(g.rows.map((x) => [x.size, ...x.values]), E471808_SUPPLIED, 'every value exactly as supplied');
  assert.deepStrictEqual(g.methods, ['from the centre back', 'across the broadest part of the shoulders', 'flat, armpit to armpit', 'from the centre back'], 'shoulders by UNIQLO’s own instruction, never assumed seam to seam');
  assert.strictEqual(g.source.url, 'https://www.uniqlo.com/us/en/products/E471808-000/00/size?sizeDisplayCode=005&measurementUnit=inch');
  assert.match(g.recordFrom, /^transcribed from UNIQLO’s official size guide and supplied to Fynd on 2026-10-20 — Fynd hasn’t read the page itself$/);
  assert.strictEqual(r.source.url, UQ_OVERSIZED);
  assert.ok(r.otherSources.some((o) => o.url === 'https://faq-us.uniqlo.com/articles/en_US/FAQ/How-to-Measure'), 'how each column is measured, sourced');
  /* the general body chart beside it is labelled general, and comes second */
  assert.strictEqual(r.charts[1].label, 'Official UNIQLO body-size chart — not garment measurements.');
  assert.ok(!r.productSize, 'the product’s own measurements are held');
  assert.ok(r.note.some((n) => /^The garment chart is from Fynd’s record of this product, transcribed from UNIQLO’s official size guide and supplied to Fynd on 2026-10-20 — Fynd hasn’t read the page itself; not yet checked\.$/.test(n)));
  assert.ok(r.note.some((n) => /^The body chart is UNIQLO’s general chart for this kind of product, not this product’s own\.$/.test(n)));
  /* the record says how it was captured and that its check is pending; the schema won't let it be both */
  const rec = sizing.byId(E471808_ID);
  assert.deepStrictEqual([rec.capture.how, rec.review.status, rec.verification.status, rec.product.retailerProductId], ['supplied-transcription', 'pending', 'unverified', '489933']);
  const both = JSON.parse(JSON.stringify(rec));
  both.verification = { status: 'verified', checkedBy: 'Someone', checkedAt: '2026-10-20' };
  assert.ok(sizingSchema.validate(both).some((e) => e.field === 'review'), 'still pending review: can’t be verified');
  both.review.status = 'done';
  assert.deepStrictEqual(sizingSchema.validate(both), [], 'checked and approved, it can be');
});

await test('a general body chart joins a garment-only record only where it applies to that exact product; a record with its own body chart keeps its own', async () => {
  const hoodie = await read('https://www.uniqlo.com/us/en/products/E475378-000/00', {});
  assert.deepStrictEqual(hoodie.charts.map((c) => c.origin), ['fynd-record', 'fynd-record'], 'its own body chart, not the general one');
  const zara = await read('https://www.zara.com/us/en/basic-heavyweight-hoodie-p00761810.html', {});
  assert.deepStrictEqual(zara.charts.map((c) => [c.measures, c.origin]), [['finished-garment', 'fynd-record']], 'no general chart is listed for it');
  /* E471808's record answers only E471808 in the US */
  const near = 'https://www.uniqlo.com/us/en/products/E4718080-000/00';
  const n = await read(near, { [near]: { throws: 'abort' } });
  assert.ok(n.productId !== E471808_ID && !n.charts.length);
  const other = 'https://www.uniqlo.com/us/en/products/E475377-000/00';
  assert.strictEqual((await read(other, {})).productId, 'uniqlo-e475377-sweatshirt-us', 'another UNIQLO hoodie-like top keeps its own record');
});

await test('only verified, compatible garment measurements are compared: E471808 is refused while pending; once checked, only what was measured the same way is compared', () => asChecked(UQ_PAIR, () => {
  const rec = sizing.byId(E471808_ID);
  const measured = hoodieRef({ brand: 'Carhartt', size: 'L', measurements: { unit: 'in', chestWidth: 24, bodyLength: 28, shoulderWidth: 22, sleeveLength: 34 } });
  const refused = engine.compare(measured, rec);
  assert.deepStrictEqual([refused.status, refused.missing[0].code], ['insufficient', 'unverified-data']);
  assert.strictEqual(sizing.summary(rec).comparable, false);
  /* the same record, as if checked and approved (a copy made here; the file stays pending) */
  const checked = JSON.parse(JSON.stringify(rec));
  checked.verification = { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-20' };
  checked.review.status = 'done';
  const home = engine.compare(measured, checked);
  /* a reference measured at home shares only the flat chest with UNIQLO's methods: not compared at all */
  tooFewGate(home, ['chestWidth']);
  assert.deepStrictEqual(home.notCompared.map((x) => x.dim).sort(), ['bodyLength', 'shoulderWidth', 'sleeveLength']);
  /* against UNIQLO's own checked hoodie, M: chest, length and sleeves measured alike; shoulders not */
  const uq = engine.compare(hoodieRef({ brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E475378-000/00' } }), checked);
  assert.deepStrictEqual(uq.dimensionsCompared, ['chestWidth', 'bodyLength', 'sleeveLength']);
  const m = uq.sizes.find((x) => x.size === 'M').dimensions;
  assert.deepStrictEqual([m.chestWidth.candidate, m.chestWidth.reference, m.chestWidth.difference], [24.75, 23.5, 1.25], 'this product’s M against the reference’s M — its own values');
  assert.ok(!m.shoulderWidth || !m.shoulderWidth.compared);
  assert.ok(uq.caveats.some((c) => /shoulders: measured differently/.test(c)));
  /* a body chart never: the general chart beside it is not a record */
  assert.strictEqual(sizing.byId('uniqlo-us-men-tops-body'), null);
}));

section('browsing a brand in Find Fit');

const brandsIndex = require('../api/_sizing/brands');
const uniqloBrand = brandsIndex.get('uniqlo');

await test('only brands with a working product list are offered; the rest are named as coming, not offered', () => {
  assert.deepStrictEqual(brandsIndex.list().map((b) => b.id), ['uniqlo']);
  assert.deepStrictEqual(brandsIndex.PLANNED, ['Nike', 'Zara', 'H&M']);
  assert.match(uniqloBrand.coverage, /not UNIQLO’s full range/);
});

await test('every UNIQLO product listed is a real one Fynd sourced: a sizing record, a product named under a general chart, or a recorded listing — on uniqlo.com, nothing invented', () => {
  const listings = require('../api/_sizing/brands/uniqlo-listings.json').products.map((p) => p.code);
  const recordCodes = sizing.RECORDS.filter((r) => r.brand === 'UNIQLO').map((r) => r.product.code);
  const generalCodes = require('../api/_sizing/official-charts').CHARTS.flatMap((c) => (c.products || []).map((p) => p.code));
  const products = uniqloBrand.products();
  assert.ok(products.length >= 5);
  products.forEach((p) => {
    assert.ok(recordCodes.includes(p.code) || generalCodes.includes(p.code) || listings.includes(p.code), p.code);
    assert.strictEqual(p.url, `https://www.uniqlo.com/us/en/products/${p.code}/00`);
    assert.ok(!/sample|example|illustrative|placeholder/i.test(JSON.stringify(p)), p.code);
    if (p.imageUrl) assert.match(p.imageUrl, new RegExp(`^https://image\\.uniqlo\\.com/.*${p.code.slice(1, 7)}`), 'a photo carries its product’s code');
  });
  const holds = Object.fromEntries(products.map((p) => [p.code, p.holds]));
  assert.deepStrictEqual(holds, { 'E475378-000': 'unchecked-chart', 'E475377-000': 'unchecked-chart', 'E455365-000': 'unchecked-chart', 'E471808-000': 'unchecked-chart', 'E429066-000': 'live-only' });
});

await test('a catalogue snapshot (FIXTURE) adds UNIQLO’s listed products: rows that break a rule are dropped, known products keep what Fynd holds, and only men’s tops in UNIQLO’s own categories fall under the general men’s chart', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const probe = `
    const b = require('./api/_sizing/brands/uniqlo');
    const oc = require('./api/_sizing/official-charts');
    const ch = require('./api/_sizing/chart');
    const fb = (code) => { const f = oc.fallbackFor(ch.checkUrl('https://www.uniqlo.com/us/en/products/' + code + '/00')); return f ? f.product.identity : null; };
    console.log(JSON.stringify({ coverage: b.coverage, products: b.products(), menHoodie: fb('E900001-000'), womenTee: fb('E900019-000'), menKnit: fb('E900027-000'), uk: oc.fallbackFor(ch.checkUrl('https://www.uniqlo.com/uk/en/products/E900001-000/00')) }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', probe], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { FYND_UNIQLO_CATALOG: path.join(__dirname, 'fixtures/uniqlo-catalog-fixture.json') }) }).toString());
  const codes = out.products.map((p) => p.code);
  assert.strictEqual(out.products.length, 36);
  assert.match(out.coverage, /36 UNIQLO US products, as listed on uniqlo\.com’s own category pages on 2026-10-18/);
  ['E9BAD-000', 'E999901-000', 'E999903-000', 'E999904-000'].forEach((c) => assert.ok(!codes.includes(c), `${c} dropped`));
  assert.strictEqual(out.products.find((p) => p.code === 'E999902-000').imageUrl, null, 'a photo off UNIQLO’s image host is dropped, the product kept');
  const known = out.products.find((p) => p.code === 'E475378-000');
  assert.deepStrictEqual([known.holds, known.line, known.category], ['unchecked-chart', 'unisex', 'hoodies'], 'the snapshot changes nothing Fynd holds');
  assert.deepStrictEqual(out.products.slice(0, 3).map((p) => p.holds), ['unchecked-chart', 'unchecked-chart', 'unchecked-chart']);
  assert.strictEqual(out.products.find((p) => p.code === 'E900001-000').holds, 'general-chart');
  assert.strictEqual(out.products.find((p) => p.code === 'E900019-000').holds, 'live-only');
  assert.strictEqual(out.products.find((p) => p.code === 'E900027-000').holds, 'live-only');
  assert.match(out.menHoodie, /Listed on UNIQLO’s Sweatshirts & Hoodies page for men \(https:\/\/www\.uniqlo\.com\/us\/en\/men\/tops\/sweatshirts-and-hoodies\)/);
  assert.deepStrictEqual([out.womenTee, out.menKnit, out.uk], [null, null, null], 'women’s tops, knitwear and another market never get the men’s chart');
});

await test('a snapshot committed beside the brand module is never read: the category-page reader is retired, and only a test’s own fixture is loaded', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  const committed = path.join(__dirname, '../api/_sizing/brands/uniqlo-catalog.json');
  assert.ok(!fs.existsSync(committed));
  fs.copyFileSync(path.join(__dirname, 'fixtures/uniqlo-catalog-fixture.json'), committed);
  try {
    const env = Object.assign({}, process.env);
    delete env.FYND_UNIQLO_CATALOG;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', `const s = require('./api/_sizing/brands/uniqlo-snapshot'); const b = require('./api/_sizing/brands/uniqlo'); console.log(JSON.stringify({ snap: s.SNAPSHOT.products.length, listed: b.products().length }))`], { cwd: path.join(__dirname, '..'), env }).toString());
    assert.deepStrictEqual(out, { snap: 0, listed: 5 });
  } finally { fs.unlinkSync(committed); }
});

await test('a product’s page holds only what Fynd has, each with its source, and names what it doesn’t — no price, description, care, reviews or stock', () => {
  const hoodie = uniqloBrand.detail('E475378-000');
  assert.deepStrictEqual([hoodie.name, hoodie.code, hoodie.url, hoodie.market], ['Sweat Pullover Hoodie', 'E475378-000', 'https://www.uniqlo.com/us/en/products/E475378-000/00', 'US']);
  assert.deepStrictEqual(hoodie.sizes.list, ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']);
  assert.match(hoodie.sizes.source, /Fynd’s record of this product, copied from UNIQLO’s page on 2026-10-10/);
  assert.deepStrictEqual(hoodie.fit, { words: 'Regular', source: 'product page, product details: "Fit: Regular"' });
  assert.match(hoodie.material.text, /^Body: 100% Cotton/);
  assert.deepStrictEqual(hoodie.missing, ['price', 'description', 'care', 'reviews', 'availability']);
  assert.ok(!('price' in hoodie) && !('rating' in hoodie) && !('stock' in hoodie));
  assert.ok(hoodie.colours.length >= 1);
  hoodie.colours.forEach((c) => {
    assert.match(c.code, /^\d{2}$/);
    assert.strictEqual(c.label, `Colour ${c.code}`, 'a colour is named by UNIQLO’s code, never by a guessed name');
    assert.strictEqual(c.image, `https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/475378/item/goods_${c.code}_475378_3x4.jpg`);
    if (c.chip) assert.match(c.chip, /^https:\/\/image\.uniqlo\.com\/.*\/475378\//);
  });
  hoodie.gallery.forEach((u) => assert.match(u, /^https:\/\/image\.uniqlo\.com\/UQ\/ST3\/WesternCommon\/imagesgoods\/475378\//));
  /* no record: no sizes, fabric or fit — said, not filled */
  const merino = uniqloBrand.detail('E429066-000');
  assert.deepStrictEqual([merino.sizes, merino.fit, merino.material], [null, null, null]);
  assert.ok(['sizes', 'fabric', 'fit'].every((m) => merino.missing.includes(m)));
  /* a record supplied as a transcription: its sizes and fit, said to be transcribed and unchecked; no fabric it doesn't hold */
  const oversized = uniqloBrand.detail('E471808-000');
  assert.deepStrictEqual(oversized.sizes.list, ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']);
  assert.match(oversized.sizes.source, /transcribed from UNIQLO’s official size guide and supplied to Fynd on 2026-10-20 — Fynd hasn’t read the page itself/);
  assert.deepStrictEqual([oversized.fit.words, oversized.material, oversized.recordVerified], ['Oversized', null, false]);
  assert.ok(oversized.missing.includes('fabric') && !oversized.missing.includes('sizes'));
  assert.strictEqual(uniqloBrand.detail('E999999-000'), null);
  assert.strictEqual(uniqloBrand.detail('https://www.uniqlo.com/us/en/products/E475378-000/00'), null);
});

await test('a product is found by its exact code only — never by a link, a near code or anything else the browser sends', () => {
  assert.strictEqual(uniqloBrand.find('E475378-000').name, 'Sweat Pullover Hoodie');
  for (const bad of ['E475378', 'e475378-000', 'E475378-0000', 'https://www.uniqlo.com/us/en/products/E475378-000/00', 'E999999-000', ' E475378-000', null, {}, ['E475378-000']]) {
    assert.strictEqual(uniqloBrand.find(bad), null, JSON.stringify(bad));
  }
});

await test('/api/size-recommendation lists brands and products, and looks a chosen product up by its code — public, read-only, rate limited', async () => {
  const UQ_OVERSIZED_URL = 'https://www.uniqlo.com/us/en/products/E471808-000/00';
  const asked = [];
  charts.setTransport(async (url) => { asked.push(url); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
  /* the deployment's own policy: no retailer domain is permitted */
  pageAccess.setPolicy(null);
  try {
    const get = (query, o) => call(recommendEndpoint, Object.assign({ method: 'GET', jar: {}, query, url: '/api/size-recommendation' }, o));
    const listed = await get({ brands: '1' });
    assert.deepStrictEqual([listed.status, listed.body.brands.map((b) => b.name), listed.body.planned], [200, ['UNIQLO'], ['Nike', 'Zara', 'H&M']]);
    const page = await get({ brand: 'uniqlo', detail: 'E475378-000' });
    assert.deepStrictEqual([page.status, page.body.product.name, page.body.product.sizes.list.length], [200, 'Sweat Pullover Hoodie', 8]);
    assert.deepStrictEqual([(await get({ brand: 'uniqlo', detail: 'E999999-000' })).status, (await get({ brand: 'uniqlo', detail: '../x' })).status], [404, 404]);
    assert.deepStrictEqual(asked, [], 'a product page reads nothing from the retailer');
    const catalog = await get({ brand: 'uniqlo' });
    assert.strictEqual(catalog.status, 200);
    assert.strictEqual(catalog.body.products.length, uniqloBrand.products().length);
    assert.ok(catalog.body.products.every((p) => !('source' in p)), 'bookkeeping stays on the server');
    assert.deepStrictEqual([(await get({ brand: 'nike' })).status, (await get({ brand: 'nike' })).body.reason], [404, 'unknown-brand']);

    /* a checked record: its own charts, no page asked */
    const hoodie = await get({ brand: 'uniqlo', item: 'E475378-000' });
    assert.deepStrictEqual([hoodie.status, hoodie.body.chart.from, hoodie.body.chart.verification, hoodie.body.item.code], [200, 'fynd-record', 'unverified', 'E475378-000'], 'its record’s own status: pending review');
    assert.deepStrictEqual(asked, []);
    /* E471808: its own Product Size record first (pending review, never compared), UNIQLO's general body chart after it; nothing read */
    const oversized = await get({ brand: 'uniqlo', item: 'E471808-000' });
    assert.deepStrictEqual([oversized.body.chart.status, oversized.body.chart.from, oversized.body.chart.verification, oversized.body.chart.comparable], ['ok', 'fynd-record', 'unverified', false]);
    assert.deepStrictEqual(oversized.body.chart.charts.map((c) => [c.measures, c.origin]), [['finished-garment', 'fynd-record'], ['body', 'official-general']]);
    assert.deepStrictEqual(asked, [], 'a record of the product’s own measurements needs no read');
    assert.strictEqual(UQ_OVERSIZED_URL, oversized.body.item.url, 'the address came from the brand module');
    /* E429066: no record, no general chart, and UNIQLO's pages aren't read without confirmed permission — so honestly unavailable, never E471808's fallback, and nothing fetched */
    const merino = await get({ brand: 'uniqlo', item: 'E429066-000' });
    assert.deepStrictEqual([merino.body.chart.status, merino.body.chart.reason, merino.body.chart.charts], ['unavailable', 'unreviewed', []]);
    assert.deepStrictEqual(asked, [], 'not even its robots.txt');
    assert.ok(!merino.body.chart.fallback);
    assert.strictEqual(merino.body.chart.source.url, 'https://www.uniqlo.com/us/en/products/E429066-000/00', 'the official page is still linked');
    /* anything not listed by its exact code is refused before anything is fetched */
    const before = asked.length;
    for (const item of ['https://169.254.169.254/latest/', 'E999999-000', '../../etc', 'E475378-000/../x']) {
      const r = await get({ brand: 'uniqlo', item });
      assert.deepStrictEqual([r.status, r.body.reason], [404, 'unknown-product'], item);
    }
    assert.strictEqual(asked.length, before);
    const headers = { 'x-forwarded-for': '198.51.100.88' };
    let last;
    for (let i = 0; i < 41; i += 1) last = await get({ brand: 'uniqlo', item: 'E475378-000' }, { headers });
    assert.deepStrictEqual([last.status, last.body.reason], [429, 'rate-limited']);
  } finally { charts.setTransport(null); pageAccess.setPolicy(TEST_SHOPS); }
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

section('checking an item before comparing');

const checkFirst = (jar, body, headers) => call(recommendEndpoint, { jar, method: 'POST', body, query: { check: '1' }, url: '/api/size-recommendation?check=1', headers });

await test('checking reads nothing from any shop: a UNIQLO link with a record, a UNIQLO product Fynd has no record of, another shop, and malformed or private addresses — each said apart', async () => {
  const access = require('../api/_sizing/page-access');
  const asked = [];
  charts.setTransport(async (url) => { asked.push(url); throw new Error('nothing should be fetched'); });
  access.setPolicy({});  /* production: no shop's pages are cleared for reading */
  try {
    const record = (await checkFirst({}, { target: { url: 'https://www.uniqlo.com/us/en/products/E475378-000/00?colorDisplayCode=09&utm_source=x' } })).body.check;
    assert.deepStrictEqual([record.target.status, record.target.url, record.target.pages, record.chart, record.comparable], ['record', 'https://www.uniqlo.com/us/en/products/E475378-000/00', 'unreviewed', 'record', false]);
    assert.deepStrictEqual([record.validation.status, record.validation.code], ['unverified', 'unverified-data'], 'production: pending review');
    const unknown = (await checkFirst({}, { target: { url: 'https://www.uniqlo.com/us/en/products/E999999-000/00' } })).body.check;
    assert.deepStrictEqual([unknown.target.status, unknown.chart, unknown.validation.status, unknown.comparable], ['no-record', 'none', 'missing-target', false]);
    assert.match(unknown.validation.explanation, /Fynd holds no checked garment measurements for this UNIQLO product/);
    const shop = (await checkFirst({}, { target: { url: 'https://shop.example.test/products/tee' } })).body.check;
    assert.deepStrictEqual([shop.target.status, shop.target.pages, shop.chart, shop.validation.status], ['unsupported-retailer', 'unreviewed', 'none', 'missing-target']);
    assert.match(shop.validation.explanation, /Fynd holds no sizing for products from shop\.example\.test, and hasn’t been cleared to read its pages/);
    const bad = (await checkFirst({}, { target: { url: 'not a link' } })).body.check;
    assert.deepStrictEqual([bad.target.status, bad.comparable, bad.validation], ['invalid-url', false, null]);
    const local = (await checkFirst({}, { target: { url: 'http://127.0.0.1/admin' } })).body.check;
    assert.strictEqual(local.target.status, 'blocked-address');
    const js = (await checkFirst({}, { target: { url: 'javascript:alert(1)' } })).body.check;
    assert.strictEqual(js.target.status, 'invalid-url');
    /* a shop whose pages are cleared for reading: no record, but a chart may be readable */
    access.setPolicy({ 'example.test': { access: 'permitted', basis: 'this test only' } });
    const readable = (await checkFirst({}, { target: { url: 'https://shop.example.test/products/tee' } })).body.check;
    assert.deepStrictEqual([readable.target.status, readable.target.pages, readable.chart, readable.comparable], ['no-record', 'readable', 'page', false]);
    assert.deepStrictEqual(asked, [], 'no request to any shop, ever, to answer a check');
  } finally {
    charts.setTransport(null);
    access.setPolicy(TEST_SHOPS);
  }
});

await test('checking a listed product by brand and code, with the garment sent, or the signed-in shopper\'s saved one — ready only when the engine says so', () => asChecked(UQ_PAIR, async () => {
  const listed = (await checkFirst({}, { target: { brand: 'uniqlo', code: 'E475378-000' }, reference: UQ_REF })).body.check;
  assert.deepStrictEqual([listed.target.status, listed.comparable, listed.validation.status, listed.validation.canRecommend], ['record', true, 'ready', true]);
  const noRef = (await checkFirst({}, { target: { brand: 'uniqlo', code: 'E475378-000' } })).body.check;
  assert.deepStrictEqual([noRef.comparable, noRef.validation.status], [false, 'missing-reference']);
  const { jar, user } = await signUp('jun@example.test');
  await fitProfiles.saveGuide(user.id, { garments: { sweatshirts: { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } } });
  const saved = (await checkFirst(jar, { target: { url: 'https://www.uniqlo.com/us/en/products/E475378-000/00' } })).body.check;
  assert.deepStrictEqual([saved.comparable, saved.validation.status], [true, 'ready'], 'the saved reference, read with their own session');
  const unknownItem = await checkFirst({}, { target: { brand: 'uniqlo', code: 'E000000-000' } });
  assert.strictEqual(unknownItem.status, 404);
  const noTarget = await checkFirst({}, {});
  assert.strictEqual(noTarget.status, 400);
  const badRef = await checkFirst({}, { target: { brand: 'uniqlo', code: 'E475378-000' }, reference: { type: 'hoodies', garment: { anchor: { brand: 'X', size: 'Huge' } } } });
  assert.deepStrictEqual([badRef.status, badRef.body.reason], [400, 'invalid-reference']);
}));

await test('a record\'s chart answer names each column\'s method as the record holds it — a flat width, a circumference, a body measurement — beside the words shown', () => {
  const answer = charts.fromRecord(sizing.byId(UQ_HOODIE));
  const garment = answer.charts.find((c) => c.measures === 'finished-garment');
  const body = answer.charts.find((c) => c.measures === 'body');
  assert.deepStrictEqual(garment.methodIds.map(sizingSchema.methodKind), garment.methodIds.map((m) => ({ 'flat-width-armpit-to-armpit': 'flat', 'center-back-to-hem': 'length', 'seam-to-seam': 'width', 'center-back-to-cuff': 'length' })[m]));
  assert.ok(garment.methodIds.includes('flat-width-armpit-to-armpit'));
  assert.deepStrictEqual(body.methodIds, ['body-circumference']);
  assert.strictEqual(answer.verification, 'unverified', 'copied into a record is not verified');
});

await test('no measurement, size, product or feedback answer appears in the logs', () => {
  const all = logged.join('\n');
  assert.ok(all.length > 0, 'something was logged, or this proves nothing');
  [UQ_HOODIE, NIKE_HOODIE, 'sizeTried', 'too-small', 'sleeves', '"overall"', 'chest', 'consent'].forEach((w) => assert.ok(!all.includes(w), `${w} was logged`));
});

out(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length ? 1 : 0);
})();
