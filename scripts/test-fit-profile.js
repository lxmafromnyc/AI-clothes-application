#!/usr/bin/env node
/* =========================================================
   Fynd — Shopper Fit Profile test

   The schema (assets/fit-profile-schema.js) on its own, then the real
   endpoint (api/fit-profile.js) driven through real sign-ups and real
   session cookies, with the store on its memory driver. Offline, no key:

     node scripts/test-fit-profile.js

   What it holds the profile to:
     - a measurement is kept in the unit it was given in, or refused —
       never converted, defaulted or read as the other unit
     - every part is optional; sizes and preferred fit alone are a
       complete profile, and an unknown size stays unknown
     - many brands and both categories, and no brand listed twice
     - only the signed-in owner can read, change or delete it, and no
       request can name another account's profile
     - it appears in no other response, and nothing about it is logged
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.AUTH_SECRET = 'fit-profile-test-secret-of-sufficient-length';
/* no email provider: a sign-up says the confirmation was not sent, and
   nothing reaches for the network */
delete process.env.RESEND_API_KEY;
delete process.env.POSTMARK_SERVER_TOKEN;

global.fetch = async (url) => { throw new Error(`unexpected outbound request to ${url}`); };

const Schema = require('../assets/fit-profile-schema.js');
const store = require('../api/_store');
const users = require('../api/_users');
const auth = require('../api/_auth');
const fitProfiles = require('../api/_fit-profile');

const profileEndpoint = require('../api/fit-profile');
const authEndpoint = require('../api/auth');
const accountEndpoint = require('../api/account');

/* ---------------------------------------------------------
   Everything logged, for the check at the end
   --------------------------------------------------------- */

const logged = [];
['log', 'warn', 'error'].forEach((level) => {
  const original = console[level];
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    if (process.env.SHOW_LOGS) original(...args);
  };
});

/* ---------------------------------------------------------
   Requests and responses, as the auth suite makes them
   --------------------------------------------------------- */

function makeRes() {
  return {
    statusCode: 200, headers: {}, payload: null, ended: false,
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    getHeader(n) { return this.headers[String(n).toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.ended = true; return this; },
    end() { this.ended = true; return this; }
  };
}

function cookiesFrom(res, existing) {
  const jar = Object.assign({}, existing || {});
  [].concat(res.getHeader('Set-Cookie') || []).forEach((line) => {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = decodeURIComponent(pair.slice(at + 1).trim());
    if (value === '') delete jar[name];
    else jar[name] = value;
  });
  return jar;
}

const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

let address = 10;

async function call(endpoint, opts) {
  const o = opts || {};
  const res = makeRes();
  const jar = o.jar || {};
  const session = jar.fynd_session;
  const csrf = session && !o.omitCsrf ? { 'x-fynd-csrf': auth.csrfTokenFor(session) } : {};
  const req = {
    method: o.method || 'POST',
    url: o.url || '/api/fit-profile',
    query: o.query,
    body: o.body,
    headers: Object.assign({ host: 'fynd.test' },
      Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}, csrf, o.headers || {}),
    socket: { remoteAddress: o.remoteAddress || '203.0.113.5' },
    on() { return this; }
  };
  await endpoint(req, res);
  return { res, jar: cookiesFrom(res, jar), status: res.statusCode, body: res.payload };
}

const PASSWORD = 'correct-horse-battery-staple';

async function signUp(email) {
  address += 1;
  const { res, jar } = await call(authEndpoint, {
    remoteAddress: `203.0.113.${address}`,
    body: { action: 'signup', name: 'Shopper', email, password: PASSWORD, confirmPassword: PASSWORD }
  });
  assert.strictEqual(res.statusCode, 200, `sign-up for ${email} answered ${res.statusCode}`);
  return { jar, user: await users.byEmail(email) };
}

const read = (jar, opts) => call(profileEndpoint, Object.assign({ method: 'GET', jar }, opts));
const save = (jar, profile, opts) => call(profileEndpoint, Object.assign({ jar, body: { action: 'save', profile } }, opts));
const del = (jar, opts) => call(profileEndpoint, Object.assign({ jar, body: { action: 'delete' } }, opts));
const guide = (jar, answers, opts) => call(profileEndpoint, Object.assign({ jar, body: { action: 'guide', answers } }, opts));

/* Distinctive values, so the log check can look for them by name. */
const SENTINEL_BRAND = 'Quillborough';
const FULL = () => ({
  schemaVersion: 1,
  measurements: { unit: 'in', height: 69.4, chest: 43.3, waist: 33, hip: 39.5 },
  brandSizes: [
    { brand: SENTINEL_BRAND, category: 'hoodies', size: 'M', fit: 'about-right' },
    { brand: SENTINEL_BRAND, category: 'sweatshirts', size: 'L', fit: 'too-large' },
    { brand: 'Champion', category: 'hoodies', size: null, fit: null }
  ],
  fitPreferences: { hoodies: 'relaxed', sweatshirts: 'oversized' }
});

const fieldsOf = (result) => result.errors.map((e) => e.field);
const normalise = (input) => Schema.normalise(input);

/* ---------------------------------------------------------
   Runner
   --------------------------------------------------------- */

let passed = 0;
const failures = [];

async function test(name, fn) {
  store.reset();
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name}\n        ${err && err.message}\n`);
  }
}

const section = (title) => process.stdout.write(`\n${title}\n`);

(async () => {

/* =========================================================
   Measurements and units
   ========================================================= */
section('measurements and units');

await test('measurements in inches are kept in inches, as entered, with the unit beside them', () => {
  const { profile, errors } = normalise({ measurements: { unit: 'in', height: 70, chest: 40.5, waist: 32, hip: 38 } });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(profile.measurements, { unit: 'in', height: 70, chest: 40.5, waist: 32, hip: 38 });
});

await test('measurements in centimetres are kept in centimetres — never converted on the way in', () => {
  const { profile } = normalise({ measurements: { unit: 'cm', height: 178, chest: 102.5, waist: 81, hip: 97 } });
  assert.deepStrictEqual(profile.measurements, { unit: 'cm', height: 178, chest: 102.5, waist: 81, hip: 97 });
});

await test('values are rounded to a tenth, and numbers typed into a form are read as numbers', () => {
  const { profile } = normalise({ measurements: { unit: 'in', chest: '40.25', waist: ' 32 ', hip: 38.04 } });
  assert.strictEqual(profile.measurements.chest, 40.3);
  assert.strictEqual(profile.measurements.waist, 32);
  assert.strictEqual(profile.measurements.hip, 38);
});

await test('a unit is written in either case and with spaces, but only as in or cm', () => {
  assert.strictEqual(normalise({ measurements: { unit: ' IN ', chest: 40 } }).profile.measurements.unit, 'in');
  assert.strictEqual(normalise({ measurements: { unit: 'Cm', chest: 100 } }).profile.measurements.unit, 'cm');
  for (const unit of ['inches', 'inch', 'mm', 'ft', 'metric', 'imperial', 'm', 0, true]) {
    const result = normalise({ measurements: { unit, chest: 40 } });
    assert.ok(fieldsOf(result).includes('measurements.unit'), `unit ${JSON.stringify(unit)} was accepted`);
    assert.strictEqual(result.profile, null);
  }
});

await test('a measurement with no unit is refused, never given a default', () => {
  for (const unit of [undefined, null, '']) {
    const result = normalise({ measurements: { unit, chest: 40, height: 70 } });
    assert.strictEqual(result.profile, null, `unit ${JSON.stringify(unit)} defaulted`);
    assert.deepStrictEqual(fieldsOf(result), ['measurements.unit'], 'asked once, about the unit');
    assert.match(result.errors[0].message, /inches or centimetres/);
  }
});

await test('a value that only makes sense in the other unit is refused, with a hint — never read as that unit', () => {
  const cases = [
    [{ unit: 'in', chest: 102 }, 'chest', /102 looks like centimetres/],
    [{ unit: 'in', height: 178 }, 'height', /178 looks like centimetres/],
    [{ unit: 'cm', chest: 40 }, 'chest', /40 looks like inches/],
    [{ unit: 'cm', height: 70 }, 'height', /70 looks like inches/],
    [{ unit: 'cm', waist: 32 }, 'waist', /32 looks like inches/]
  ];
  for (const [measurements, key, hint] of cases) {
    const result = normalise({ measurements });
    assert.strictEqual(result.profile, null, `${JSON.stringify(measurements)} was stored`);
    const error = result.errors.find((e) => e.field === `measurements.${key}`);
    assert.ok(error, `no error for ${key}`);
    assert.match(error.message, hint);
    assert.match(error.message, /switch the unit/);
  }
});

await test('a value implausible in both units is refused with its range, and no hint', () => {
  for (const [unit, chest] of [['in', 500], ['cm', 5], ['in', 0], ['cm', 0], ['in', -40]]) {
    const result = normalise({ measurements: { unit, chest } });
    const error = result.errors.find((e) => e.field === 'measurements.chest');
    assert.ok(error, `${chest} ${unit} accepted`);
    assert.doesNotMatch(error.message, /looks like/);
  }
  const height = normalise({ measurements: { unit: 'in', height: 30 } }).errors[0].message;
  assert.match(height, /4 ft 0 in and 7 ft 6 in/, 'a height range in inches is said in feet and inches too');
});

await test('the ends of each range are allowed, and just past them are not', () => {
  for (const key of Schema.MEASUREMENT_KEYS) {
    for (const unit of Schema.UNITS) {
      const [min, max] = Schema.rangeOf(key, unit);
      assert.deepStrictEqual(normalise({ measurements: { unit, [key]: min } }).errors, [], `${key} ${min} ${unit}`);
      assert.deepStrictEqual(normalise({ measurements: { unit, [key]: max } }).errors, [], `${key} ${max} ${unit}`);
      assert.ok(normalise({ measurements: { unit, [key]: min - 0.2 } }).errors.length, `${key} under ${min} ${unit}`);
      assert.ok(normalise({ measurements: { unit, [key]: max + 0.2 } }).errors.length, `${key} over ${max} ${unit}`);
    }
  }
});

await test('anything that is not a plain number is refused, not guessed at', () => {
  for (const chest of ["5'10", '40in', '40 in', '1e2', 'forty', '40,5', '-40', '0x28', true, {}, [40], NaN, Infinity]) {
    const result = normalise({ measurements: { unit: 'in', chest } });
    const error = result.errors.find((e) => e.field === 'measurements.chest');
    assert.ok(error, `${JSON.stringify(String(chest))} was read as a number`);
  }
});

await test('the ranges in each unit describe the same people, and the conversion the page uses round-trips', () => {
  for (const key of Schema.MEASUREMENT_KEYS) {
    const [inMin, inMax] = Schema.rangeOf(key, 'in');
    const [cmMin, cmMax] = Schema.rangeOf(key, 'cm');
    assert.ok(Math.abs(inMin * 2.54 - cmMin) <= 3 && Math.abs(inMax * 2.54 - cmMax) <= 3, `${key} ranges disagree`);
  }
  assert.strictEqual(Schema.convert(70, 'in', 'cm'), 177.8);
  assert.strictEqual(Schema.convert(177.8, 'cm', 'in'), 70);
  assert.strictEqual(Schema.convert(40, 'in', 'in'), 40);
  assert.deepStrictEqual(Schema.feetAndInches(70), { feet: 5, inches: 10 });
  assert.deepStrictEqual(Schema.feetAndInches(71.96), { feet: 6, inches: 0 }, 'never 5 ft 12 in');
});

/* =========================================================
   Optional and partial profiles
   ========================================================= */
section('optional and partial profiles');

await test('an empty profile is valid, and is empty', () => {
  for (const input of [{}, { measurements: {}, brandSizes: [], fitPreferences: {} }, { measurements: null, brandSizes: null, fitPreferences: null }]) {
    const { profile, errors } = normalise(input);
    assert.deepStrictEqual(errors, []);
    assert.ok(Schema.isEmpty(profile));
    assert.strictEqual(profile.schemaVersion, Schema.SCHEMA_VERSION);
  }
});

await test('usual sizes and preferred fit alone are a complete profile — no measurement, no unit', () => {
  const { profile, errors } = normalise({
    brandSizes: [{ brand: 'Uniqlo', category: 'hoodies', size: 'M', fit: 'about-right' }],
    fitPreferences: { hoodies: 'oversized' }
  });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(profile.measurements, { unit: null, height: null, chest: null, waist: null, hip: null });
  assert.strictEqual(profile.brandSizes.length, 1);
  assert.deepStrictEqual(profile.fitPreferences, { hoodies: 'oversized' });
  assert.ok(!Schema.isEmpty(profile));
});

await test('a partly filled profile keeps exactly what was given', () => {
  const height = normalise({ measurements: { unit: 'cm', height: 165, chest: '' } }).profile;
  assert.deepStrictEqual(height.measurements, { unit: 'cm', height: 165, chest: null, waist: null, hip: null });

  const unitOnly = normalise({ measurements: { unit: 'cm' } }).profile;
  assert.strictEqual(unitOnly.measurements.unit, 'cm', 'the chosen unit is kept even with nothing measured');
  assert.ok(Schema.isEmpty(unitOnly));

  const brandOnly = normalise({ brandSizes: [{ brand: 'Gap', category: 'sweatshirts' }] }).profile;
  assert.deepStrictEqual(brandOnly.brandSizes, [{ brand: 'Gap', category: 'sweatshirts', size: null, fit: null }]);
});

await test('an unknown size stays unknown — blank, or any way of saying "not sure" — and is never filled in', () => {
  for (const size of [undefined, null, '', '   ', 'not sure', 'Not Sure', 'unknown', '?', "don't know", 'idk', 'n/a']) {
    const { profile, errors } = normalise({ brandSizes: [{ brand: 'Nike', category: 'hoodies', size }] });
    assert.deepStrictEqual(errors, [], `size ${JSON.stringify(size)} refused`);
    assert.strictEqual(profile.brandSizes[0].size, null, `size ${JSON.stringify(size)} became ${profile.brandSizes[0].size}`);
  }
});

await test('fit feedback can be given without a size, and either can be left out', () => {
  const { profile } = normalise({ brandSizes: [
    { brand: 'Nike', category: 'hoodies', size: null, fit: 'too-small' },
    { brand: 'Adidas', category: 'hoodies', size: 'L' }
  ] });
  assert.deepStrictEqual(profile.brandSizes.map((e) => [e.size, e.fit]), [[null, 'too-small'], ['L', null]]);
});

await test('weight, photos, ids and any other field it does not name are dropped, not stored', () => {
  const { profile, errors } = normalise({
    weight: 80, photo: 'data:image/png;base64,AAAA', userId: 'usr_someone_else', email: 'x@y.z',
    measurements: { unit: 'in', chest: 40, weight: 180, inseam: 32, photo: 'x' },
    brandSizes: [{ brand: 'Gap', category: 'hoodies', size: 'S', fit: null, note: 'private', price: 50 }],
    fitPreferences: { hoodies: 'regular' }
  });
  assert.deepStrictEqual(errors, []);
  const text = JSON.stringify(profile);
  for (const word of ['weight', 'photo', 'userId', 'email', 'inseam', 'note', 'price', 'usr_someone_else', 'private']) {
    assert.ok(!text.includes(word), `${word} was kept`);
  }
  assert.deepStrictEqual(Object.keys(profile).sort(),
    ['anchor', 'brandSizes', 'fitGoal', 'fitPreferences', 'measurements', 'schemaVersion', 'troubleZones']);
});

/* =========================================================
   Brands and categories
   ========================================================= */
section('brands and categories');

await test('many brands, across both categories, are kept in the order given', () => {
  const { profile, errors } = normalise(FULL());
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(profile.brandSizes.map((e) => `${e.brand}/${e.category}/${e.size}/${e.fit}`), [
    `${SENTINEL_BRAND}/hoodies/M/about-right`,
    `${SENTINEL_BRAND}/sweatshirts/L/too-large`,
    'Champion/hoodies/null/null'
  ]);
  assert.deepStrictEqual(Schema.CATEGORIES.map((c) => c.id), ['hoodies', 'sweatshirts']);
});

await test('the same brand and category twice is refused, however the brand is typed', () => {
  const pairs = [['Uniqlo', 'UNIQLO '], ['H&M', 'h & m'], ['Levi’s', 'Levis'], ['Café Kitsuné', 'cafe kitsune'], ['The  North Face', 'the north face']];
  for (const [first, second] of pairs) {
    const result = normalise({ brandSizes: [
      { brand: first, category: 'hoodies', size: 'M' },
      { brand: second, category: 'hoodies', size: 'L' }
    ] });
    assert.deepStrictEqual(fieldsOf(result), ['brandSizes.1.brand'], `${first} / ${second}`);
    assert.match(result.errors[0].message, /already listed/);
    assert.ok(result.errors[0].message.startsWith(first.replace(/\s+/g, ' ')), 'names the row already there');
  }
});

await test('the same brand in two categories, and two brands in one category, are separate entries', () => {
  const { profile, errors } = normalise({ brandSizes: [
    { brand: 'Uniqlo', category: 'hoodies', size: 'M' },
    { brand: 'uniqlo', category: 'sweatshirts', size: 'M' },
    { brand: 'Gap', category: 'hoodies', size: 'S' }
  ] });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(profile.brandSizes.length, 3);
});

await test('brand names are tidied, and letter sizes are written the usual way; a brand’s own label is kept', () => {
  const { profile } = normalise({ brandSizes: [
    { brand: '  Arc’teryx   Veilance ', category: 'hoodies', size: ' xl ' },
    { brand: 'COS', category: 'hoodies', size: '38' },
    { brand: 'Uniqlo U', category: 'sweatshirts', size: 'M Tall' },
    { brand: 'Gap', category: 'sweatshirts', size: '3xl' }
  ] });
  assert.deepStrictEqual(profile.brandSizes.map((e) => [e.brand, e.size]), [
    ['Arc’teryx Veilance', 'XL'], ['COS', '38'], ['Uniqlo U', 'M Tall'], ['Gap', '3XL']
  ]);
});

await test('each part of a usual size is checked, and the error names its row and field', () => {
  const result = normalise({ brandSizes: [
    { brand: '', category: 'hoodies' },
    { brand: 'Gap', category: 'jeans' },
    { brand: 'x'.repeat(61), category: 'hoodies' },
    { brand: 'Nike', category: 'hoodies', size: '<script>' },
    { brand: 'Adidas', category: 'hoodies', fit: 'perfect' },
    { brand: '!!!', category: 'hoodies' },
    'not an entry'
  ] });
  assert.deepStrictEqual(fieldsOf(result), [
    'brandSizes.0.brand', 'brandSizes.1.category', 'brandSizes.2.brand',
    'brandSizes.3.size', 'brandSizes.4.fit', 'brandSizes.5.brand', 'brandSizes.6'
  ]);
  assert.strictEqual(result.profile, null);
});

await test('a list longer than fifty brands, or not a list, is refused', () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ brand: `Brand ${i}`, category: 'hoodies' }));
  assert.deepStrictEqual(fieldsOf(normalise({ brandSizes: many })), ['brandSizes']);
  assert.deepStrictEqual(normalise({ brandSizes: many.slice(0, 50) }).errors, []);
  assert.deepStrictEqual(fieldsOf(normalise({ brandSizes: { brand: 'Gap' } })), ['brandSizes']);
});

await test('preferred fit is kept per category, and "no preference" is simply left out', () => {
  const { profile } = normalise({ fitPreferences: { hoodies: 'fitted', sweatshirts: '' } });
  assert.deepStrictEqual(profile.fitPreferences, { hoodies: 'fitted' });
  for (const id of ['fitted', 'regular', 'relaxed', 'oversized']) {
    assert.deepStrictEqual(normalise({ fitPreferences: { sweatshirts: id } }).profile.fitPreferences, { sweatshirts: id });
  }
});

await test('a preferred fit for a category that does not exist, or that is not a fit, is refused', () => {
  assert.deepStrictEqual(fieldsOf(normalise({ fitPreferences: { jeans: 'relaxed' } })), ['fitPreferences']);
  assert.deepStrictEqual(fieldsOf(normalise({ fitPreferences: { hoodies: 'baggy' } })), ['fitPreferences.hoodies']);
  assert.deepStrictEqual(fieldsOf(normalise({ fitPreferences: ['relaxed'] })), ['fitPreferences']);
});

/* =========================================================
   Versions
   ========================================================= */
section('versions');

await test('a stored profile missing whole groups reads with "not said" in their place', () => {
  const read = Schema.upgrade({ schemaVersion: 1, measurements: { unit: 'cm', chest: 100 } });
  assert.deepStrictEqual(read.measurements, { unit: 'cm', height: null, chest: 100, waist: null, hip: null });
  assert.deepStrictEqual(read.brandSizes, []);
  assert.deepStrictEqual(read.fitPreferences, {});
});

await test('a stored profile with no version is read as the first one, and only named fields come back', () => {
  const read = Schema.upgrade({ measurements: { unit: 'in', chest: 40, weight: 180 }, secret: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
  /* read as version 1, and handed back in the current shape */
  assert.strictEqual(read.schemaVersion, Schema.SCHEMA_VERSION);
  assert.strictEqual(read.measurements.chest, 40);
  assert.deepStrictEqual([read.anchor, read.fitGoal, read.troubleZones], [null, null, null]);
  assert.strictEqual(read.createdAt, '2026-01-01T00:00:00.000Z');
  assert.ok(!JSON.stringify(read).includes('weight') && !('secret' in read));
});

await test('a version this code does not know is not guessed at — reading or writing', () => {
  assert.strictEqual(Schema.upgrade({ schemaVersion: Schema.SCHEMA_VERSION + 1 }), null);
  assert.strictEqual(Schema.upgrade({ schemaVersion: 'one' }), null);
  assert.strictEqual(Schema.upgrade('not a profile'), null);
  assert.deepStrictEqual(fieldsOf(normalise({ schemaVersion: Schema.SCHEMA_VERSION + 1 })), ['schemaVersion']);
  assert.deepStrictEqual(fieldsOf(normalise({ schemaVersion: 0 })), ['schemaVersion']);
  assert.deepStrictEqual(normalise({ schemaVersion: Schema.SCHEMA_VERSION }).errors, []);
});

/* =========================================================
   Saving, editing and deleting, through the endpoint
   ========================================================= */
section('saving, editing and deleting');

await test('a new account has no profile, and is told so', async () => {
  const { jar } = await signUp('new@example.test');
  const { status, body, res } = await read(jar);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.profile, null);
  assert.strictEqual(body.storage.durable, false, 'the memory driver is said to be memory');
  assert.strictEqual(res.getHeader('cache-control'), 'no-store, private');
});

await test('a saved profile reads back exactly as the server shaped it', async () => {
  const { jar } = await signUp('ada@example.test');
  const saved = await save(jar, FULL());
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  assert.strictEqual(saved.body.saved, true);
  assert.strictEqual(saved.res.getHeader('cache-control'), 'no-store, private');

  const { body } = await read(jar);
  assert.deepStrictEqual(body.profile, saved.body.profile);
  assert.deepStrictEqual(body.profile.measurements, { unit: 'in', height: 69.4, chest: 43.3, waist: 33, hip: 39.5 });
  assert.strictEqual(body.profile.brandSizes.length, 3);
  assert.ok(body.profile.createdAt && body.profile.updatedAt);
});

await test('editing replaces the whole profile, keeps when it was made, and moves when it changed', async () => {
  const { jar } = await signUp('ada@example.test');
  const first = (await save(jar, FULL())).body.profile;
  await new Promise((r) => setTimeout(r, 5));

  const edited = FULL();
  edited.measurements = { unit: 'cm', chest: 110 };
  edited.brandSizes = [{ brand: 'Uniqlo', category: 'sweatshirts', size: 'not sure' }];
  delete edited.fitPreferences.sweatshirts;
  const second = await save(jar, edited);
  assert.strictEqual(second.status, 200);

  const { body } = await read(jar);
  assert.deepStrictEqual(body.profile.measurements, { unit: 'cm', height: null, chest: 110, waist: null, hip: null },
    'the old inch values are gone, not converted and not kept');
  assert.deepStrictEqual(body.profile.brandSizes, [{ brand: 'Uniqlo', category: 'sweatshirts', size: null, fit: null }]);
  assert.deepStrictEqual(body.profile.fitPreferences, { hoodies: 'relaxed' });
  assert.strictEqual(body.profile.createdAt, first.createdAt);
  assert.notStrictEqual(body.profile.updatedAt, first.updatedAt);
});

await test('an invalid save is refused field by field, and what was saved before is untouched', async () => {
  const { jar } = await signUp('ada@example.test');
  await save(jar, FULL());
  const before = (await read(jar)).body.profile;

  const bad = FULL();
  bad.measurements.chest = 102;
  bad.brandSizes.push({ brand: SENTINEL_BRAND.toUpperCase(), category: 'hoodies' });
  const refused = await save(jar, bad);
  assert.strictEqual(refused.status, 400);
  assert.strictEqual(refused.body.reason, 'invalid');
  assert.deepStrictEqual(refused.body.errors.map((e) => e.field), ['measurements.chest', 'brandSizes.3.brand']);

  assert.deepStrictEqual((await read(jar)).body.profile, before);
});

await test('a profile with only sizes and preferred fit saves and reads back', async () => {
  const { jar } = await signUp('ada@example.test');
  const saved = await save(jar, { brandSizes: [{ brand: 'Gap', category: 'hoodies', size: 'S' }], fitPreferences: { sweatshirts: 'regular' } });
  assert.strictEqual(saved.status, 200);
  const { body } = await read(jar);
  assert.strictEqual(body.profile.measurements.chest, null);
  assert.deepStrictEqual(body.profile.fitPreferences, { sweatshirts: 'regular' });
});

await test('deleting removes the profile, and deleting again is harmless', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await save(jar, FULL());
  const gone = await del(jar);
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(gone.body.deleted, true);
  assert.strictEqual(gone.body.profile, null);
  assert.strictEqual(await store.get(fitProfiles.profileKey(user.id)), null, 'nothing left in the store');
  assert.strictEqual((await read(jar)).body.profile, null);
  assert.strictEqual((await del(jar)).status, 200);
});

await test('a profile can be saved again after it is deleted', async () => {
  const { jar } = await signUp('ada@example.test');
  await save(jar, FULL());
  await del(jar);
  const again = await save(jar, { fitPreferences: { hoodies: 'fitted' } });
  assert.strictEqual(again.status, 200);
  assert.deepStrictEqual((await read(jar)).body.profile.fitPreferences, { hoodies: 'fitted' });
});

await test('a profile saved by a later version is reported, never overwritten, and can still be deleted', async () => {
  const { jar, user } = await signUp('ada@example.test');
  const later = { schemaVersion: Schema.SCHEMA_VERSION + 1, somethingNew: true };
  await store.set(fitProfiles.profileKey(user.id), later);

  const seen = await read(jar);
  assert.strictEqual(seen.status, 409);
  assert.strictEqual(seen.body.reason, 'unsupported-version');

  const overwrite = await save(jar, FULL());
  assert.strictEqual(overwrite.status, 409);
  assert.deepStrictEqual(await store.get(fitProfiles.profileKey(user.id)), later);

  assert.strictEqual((await del(jar)).status, 200);
  assert.strictEqual((await read(jar)).body.profile, null);
});

await test('an unknown action, or another method, changes nothing', async () => {
  const { jar } = await signUp('ada@example.test');
  await save(jar, FULL());
  const before = (await read(jar)).body.profile;

  const unknown = await call(profileEndpoint, { jar, body: { action: 'merge', profile: {} } });
  assert.strictEqual(unknown.status, 400);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.strictEqual((await call(profileEndpoint, { jar, method, body: { action: 'delete' } })).status, 405, method);
  }
  assert.deepStrictEqual((await read(jar)).body.profile, before);
});

/* =========================================================
   Who may read and change it
   ========================================================= */
section('authentication and cross-account access');

await test('signed out, every method answers 401 and nothing is written', async () => {
  const { user } = await signUp('ada@example.test');
  for (const attempt of [
    () => read({}),
    () => save({}, FULL()),
    () => del({})
  ]) {
    const { status, body } = await attempt();
    assert.strictEqual(status, 401);
    assert.strictEqual(body.reason, 'sign-in-required');
    assert.ok(!('profile' in body), 'no profile shape is answered');
  }
  assert.strictEqual(await store.get(fitProfiles.profileKey(user.id)), null);
  assert.strictEqual(await store.get(fitProfiles.profileKey('undefined')), null);
  assert.strictEqual(await store.get(fitProfiles.profileKey('null')), null);
});

await test('a session cookie that was never issued, or that has been logged out, reads nothing', async () => {
  const { jar } = await signUp('ada@example.test');
  await save(jar, FULL());

  const forged = { fynd_session: 'A'.repeat(43) };
  assert.strictEqual((await read(forged)).status, 401);

  const out = await call(authEndpoint, { jar, body: { action: 'logout' } });
  assert.strictEqual(out.status, 200);
  assert.strictEqual((await read(jar)).status, 401, 'the old cookie no longer reads the profile');
  assert.strictEqual((await save(jar, {})).status, 401);
  assert.strictEqual((await del(jar)).status, 401);
});

await test('a session from before a password change no longer reads the profile', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await save(jar, FULL());
  await users.setPassword(user, auth.hashPassword('a-brand-new-password'));
  assert.strictEqual((await read(jar)).status, 401);
});

await test('saving and deleting need the CSRF token; reading does not', async () => {
  const { jar } = await signUp('ada@example.test');
  await save(jar, FULL());
  const before = (await read(jar)).body.profile;

  const noToken = await save(jar, { fitPreferences: { hoodies: 'fitted' } }, { omitCsrf: true });
  assert.strictEqual(noToken.status, 403);
  assert.strictEqual(noToken.body.reason, 'csrf');

  const wrongToken = await del(jar, { omitCsrf: true, headers: { 'x-fynd-csrf': auth.csrfTokenFor('B'.repeat(43)) } });
  assert.strictEqual(wrongToken.status, 403);

  assert.deepStrictEqual((await read(jar)).body.profile, before);
  assert.strictEqual((await read(jar, { omitCsrf: true })).status, 200);
});

await test('one account cannot read, change or delete another account’s profile', async () => {
  const ada = await signUp('ada@example.test');
  const bob = await signUp('bob@example.test');

  await save(ada.jar, FULL());
  const adas = (await read(ada.jar)).body.profile;

  assert.strictEqual((await read(bob.jar)).body.profile, null, 'Bob sees no profile, not Ada’s');

  await save(bob.jar, { measurements: { unit: 'cm', chest: 96 } });
  await del(bob.jar);
  assert.deepStrictEqual((await read(ada.jar)).body.profile, adas, 'Bob saving and deleting left Ada’s alone');
  assert.strictEqual((await read(bob.jar)).body.profile, null);
});

await test('no id, email or key in the request can point at another account’s profile', async () => {
  const ada = await signUp('ada@example.test');
  const bob = await signUp('bob@example.test');
  await save(ada.jar, FULL());
  const adas = (await read(ada.jar)).body.profile;

  const pointing = {
    url: `/api/fit-profile?userId=${ada.user.id}&user=${ada.user.id}&email=ada@example.test`,
    query: { userId: ada.user.id, email: 'ada@example.test' },
    headers: { 'x-user-id': ada.user.id, 'x-fynd-user': ada.user.id }
  };
  assert.strictEqual((await read(bob.jar, pointing)).body.profile, null);

  const aimed = await call(profileEndpoint, Object.assign({ jar: bob.jar, body: {
    action: 'save', userId: ada.user.id, user: ada.user.id, email: 'ada@example.test',
    profile: Object.assign({ userId: ada.user.id }, { fitPreferences: { hoodies: 'fitted' } })
  } }, pointing));
  assert.strictEqual(aimed.status, 200);
  await call(profileEndpoint, Object.assign({ jar: bob.jar, body: { action: 'delete', userId: ada.user.id } }, pointing));

  assert.deepStrictEqual((await read(ada.jar)).body.profile, adas, 'Ada’s profile is exactly as she left it');
  assert.ok(!JSON.stringify(await store.get(fitProfiles.profileKey(ada.user.id))).includes('fitted'));
});

await test('a profile is stored under its owner’s id and nowhere else', async () => {
  const ada = await signUp('ada@example.test');
  await save(ada.jar, FULL());
  assert.ok(await store.get(`fitprofile:${ada.user.id}`));
  assert.strictEqual(fitProfiles.profileKey(ada.user.id), `fitprofile:${ada.user.id}`);
});

await test('only origins the site already trusts may call it from a browser', async () => {
  const { jar } = await signUp('ada@example.test');
  const foreign = await read(jar, { headers: { origin: 'https://evil.example' } });
  assert.strictEqual(foreign.status, 403);
  assert.ok(!foreign.body.profile);

  const preflight = await call(profileEndpoint, { method: 'OPTIONS', headers: { origin: 'https://lxmafromnyc.github.io' } });
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.res.getHeader('access-control-allow-origin'), 'https://lxmafromnyc.github.io');
});

/* =========================================================
   The fit guide: version 2's three answers
   ========================================================= */
section('the fit guide (schema version 2)');

const ANSWERS = () => ({
  anchor: { brand: SENTINEL_BRAND, size: 'm' },
  fitGoal: 'true-to-size',
  troubleZones: ['waist-loose', 'sleeves-short']
});
const kept = (profile) => ({ measurements: profile.measurements, brandSizes: profile.brandSizes, fitPreferences: profile.fitPreferences });

await test('a stored version 1 profile reads as version 2, with the guide unanswered and nothing it held changed', async () => {
  const { jar, user } = await signUp('ada@example.test');
  const v1 = Object.assign(FULL(), { createdAt: '2026-09-01T00:00:00.000Z' });
  await store.set(fitProfiles.profileKey(user.id), v1);

  const { status, body } = await read(jar);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.profile.schemaVersion, 2);
  assert.deepStrictEqual(kept(body.profile), kept(Schema.upgrade(v1)));
  assert.deepStrictEqual(body.profile.fitPreferences, { hoodies: 'relaxed', sweatshirts: 'oversized' },
    'per-category fits are read exactly as saved — never re-read through the new fit goal');
  assert.deepStrictEqual([body.profile.anchor, body.profile.fitGoal, body.profile.troubleZones], [null, null, null]);
  assert.strictEqual(body.profile.createdAt, '2026-09-01T00:00:00.000Z');
});

await test('the guide saves its three answers, and measurements, usual sizes and per-category fits stay as they were', async () => {
  const { jar } = await signUp('ada@example.test');
  const before = (await save(jar, FULL())).body.profile;

  const { status, body } = await guide(jar, ANSWERS());
  assert.strictEqual(status, 200, JSON.stringify(body));
  assert.strictEqual(body.saved, true);
  assert.deepStrictEqual(body.profile.anchor, { brand: SENTINEL_BRAND, size: 'M' });
  assert.strictEqual(body.profile.fitGoal, 'true-to-size');
  assert.deepStrictEqual(body.profile.troubleZones, ['sleeves-short', 'waist-loose'], 'stored in the listed order');
  assert.deepStrictEqual(kept(body.profile), kept(before));
  assert.strictEqual(body.profile.createdAt, before.createdAt);

  const reread = (await read(jar)).body.profile;
  assert.deepStrictEqual(reread, body.profile);
});

await test('the guide works for an account with no profile yet, and needs no measurements', async () => {
  const { jar } = await signUp('ada@example.test');
  const { status, body } = await guide(jar, { fitGoal: 'oversized' });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.profile.fitGoal, 'oversized');
  assert.ok(Object.values(body.profile.measurements).every((v) => v === null));
  assert.deepStrictEqual(body.profile.brandSizes, []);
});

await test('a skipped step keeps its saved answer, and None of these is saved as an empty list, apart from unanswered', async () => {
  const { jar } = await signUp('ada@example.test');
  await guide(jar, ANSWERS());

  /* step 3 changed to "None of these"; steps 1 and 2 skipped */
  let profile = (await guide(jar, { troubleZones: [] })).body.profile;
  assert.deepStrictEqual(profile.troubleZones, []);
  assert.strictEqual(profile.fitGoal, 'true-to-size', 'a skipped step is not an erased one');
  assert.deepStrictEqual(profile.anchor, { brand: SENTINEL_BRAND, size: 'M' });
  assert.strictEqual(Schema.isEmpty(Object.assign(Schema.empty(), { troubleZones: [] })), false, '"none" is an answer');

  /* a brand typed under Other, size not known */
  profile = (await guide(jar, { anchor: { brand: '  arc’teryx ', size: 'Not sure' } })).body.profile;
  assert.deepStrictEqual(profile.anchor, { brand: 'arc’teryx', size: null }, 'not sure is unknown, never a size');

  /* a listed brand typed in another case is stored as listed */
  profile = (await guide(jar, { anchor: { brand: 'uniqlo', size: 'xl' } })).body.profile;
  assert.deepStrictEqual(profile.anchor, { brand: 'UNIQLO', size: 'XL' });

  /* sent as null, an answer is cleared */
  profile = (await guide(jar, { fitGoal: null })).body.profile;
  assert.strictEqual(profile.fitGoal, null);
});

await test('a page that predates the guide cannot erase its answers; an explicit null still can', async () => {
  const { jar } = await signUp('ada@example.test');
  await guide(jar, ANSWERS());

  /* the fit profile page as it was at version 1: no guide fields at all */
  let profile = (await save(jar, FULL())).body.profile;
  assert.strictEqual(profile.fitGoal, 'true-to-size');
  assert.deepStrictEqual(profile.troubleZones, ['sleeves-short', 'waist-loose']);

  /* a version 2 save that leaves them out keeps them too */
  profile = (await save(jar, Object.assign(FULL(), { schemaVersion: 2 }))).body.profile;
  assert.deepStrictEqual(profile.anchor, { brand: SENTINEL_BRAND, size: 'M' });

  /* and one that sends them as null means it */
  profile = (await save(jar, Object.assign(FULL(), { schemaVersion: 2, anchor: null, fitGoal: null, troubleZones: null }))).body.profile;
  assert.deepStrictEqual([profile.anchor, profile.fitGoal, profile.troubleZones], [null, null, null]);
});

await test('what the guide sends is checked, field by field, and nothing is written when any of it is wrong', async () => {
  const { jar, user } = await signUp('ada@example.test');
  await guide(jar, ANSWERS());
  const stored = await store.get(fitProfiles.profileKey(user.id));

  for (const [answers, field] of [
    [{ anchor: { brand: 'Nike', size: 'huge' } }, 'anchor.size'],
    [{ anchor: { brand: '!!!' } }, 'anchor.brand'],
    [{ anchor: { brand: 'x'.repeat(61) } }, 'anchor.brand'],
    [{ anchor: 'Nike M' }, 'anchor'],
    [{ fitGoal: 'baggy' }, 'fitGoal'],
    [{ fitGoal: 'fitted' }, 'fitGoal'],
    [{ troubleZones: ['knees'] }, 'troubleZones'],
    [{ troubleZones: 'sleeves-short' }, 'troubleZones']
  ]) {
    const { status, body } = await guide(jar, answers);
    assert.strictEqual(status, 400, `${JSON.stringify(answers)} answered ${status}`);
    assert.strictEqual(body.reason, 'invalid');
    assert.ok(body.errors.some((e) => e.field === field), `${JSON.stringify(answers)}: expected an error on ${field}, got ${JSON.stringify(body.errors)}`);
  }
  assert.deepStrictEqual(await store.get(fitProfiles.profileKey(user.id)), stored, 'nothing was written');
});

await test('the guide needs a session and the CSRF token, like every other change', async () => {
  const signedOut = await guide({}, ANSWERS());
  assert.strictEqual(signedOut.status, 401);
  assert.strictEqual(signedOut.body.reason, 'sign-in-required');

  const { jar, user } = await signUp('ada@example.test');
  const forged = await guide(jar, ANSWERS(), { omitCsrf: true });
  assert.strictEqual(forged.status, 403);
  assert.strictEqual(forged.body.reason, 'csrf');
  assert.strictEqual(await store.get(fitProfiles.profileKey(user.id)), null);
  assert.strictEqual((await guide(jar, ANSWERS())).res.getHeader('cache-control'), 'no-store, private');
});

await test('a profile saved by a newer version is reported and never saved over, by the guide either', async () => {
  const { jar, user } = await signUp('ada@example.test');
  const later = { schemaVersion: Schema.SCHEMA_VERSION + 1, somethingNew: true, fitGoal: 'slim' };
  await store.set(fitProfiles.profileKey(user.id), later);

  const { status, body } = await guide(jar, ANSWERS());
  assert.strictEqual(status, 409);
  assert.strictEqual(body.reason, 'unsupported-version');
  assert.deepStrictEqual(await store.get(fitProfiles.profileKey(user.id)), later);
});

await test('one account’s guide answers are never another’s', async () => {
  const ada = await signUp('ada@example.test');
  const bea = await signUp('bea@example.test');
  await guide(ada.jar, ANSWERS());
  assert.strictEqual((await read(bea.jar)).body.profile, null);
  await guide(bea.jar, { fitGoal: 'slim' });
  assert.strictEqual((await read(ada.jar)).body.profile.fitGoal, 'true-to-size');
  assert.strictEqual((await read(bea.jar)).body.profile.anchor, null);
});

/* =========================================================
   What other responses and the logs say
   ========================================================= */
section('privacy');

await test('/api/account says nothing about the fit profile, and its shape has not changed', async () => {
  const { jar } = await signUp('ada@example.test');
  await save(jar, FULL());
  await guide(jar, ANSWERS());
  const { body } = await call(accountEndpoint, { method: 'GET', jar });
  const text = JSON.stringify(body);
  for (const word of [SENTINEL_BRAND, '43.3', '69.4', 'measurements', 'brandSizes', 'fitPreferences', 'oversized', 'fitprofile', 'anchor', 'fitGoal', 'troubleZones', 'true-to-size', 'sleeves-short']) {
    assert.ok(!text.includes(word), `/api/account carries ${word}`);
  }
  assert.deepStrictEqual(Object.keys(body).sort(), [
    'accounts', 'billing', 'csrfToken', 'emailVerified', 'plan', 'plans', 'signedIn',
    'signedInWith', 'storage', 'subscription', 'usage', 'user'
  ]);
});

await test('a store that fails answers a plain 500 and logs only the store’s own message', async () => {
  const { jar } = await signUp('ada@example.test');
  /* the real driver's own wording: the command, never its arguments */
  const original = { get: store.get, set: store.set, remove: store.remove };
  store.get = async function (key) {
    if (String(key).startsWith('fitprofile:')) throw new Error('store GET failed with 500');
    return original.get.apply(store, arguments);
  };
  store.set = async function (key) {
    if (String(key).startsWith('fitprofile:')) throw new Error('store SET failed with 500');
    return original.set.apply(store, arguments);
  };
  store.remove = async function (key) {
    if (String(key).startsWith('fitprofile:')) throw new Error('store DEL failed with 500');
    return original.remove.apply(store, arguments);
  };
  try {
    const reading = await read(jar);
    assert.strictEqual(reading.status, 500);
    assert.match(reading.body.error, /Could not read your fit profile/);
    const saving = await save(jar, FULL());
    assert.strictEqual(saving.status, 500);
    assert.ok(!JSON.stringify(saving.body).includes(SENTINEL_BRAND));
    const answering = await guide(jar, ANSWERS());
    assert.strictEqual(answering.status, 500);
    assert.match(answering.body.error, /Could not save your fit profile/);
    assert.ok(!JSON.stringify(answering.body).includes(SENTINEL_BRAND));
    const deleting = await del(jar);
    assert.strictEqual(deleting.status, 500);
  } finally {
    Object.assign(store, original);
  }
  const all = logged.join('\n');
  assert.ok(/Fit profile read failed store GET failed with 500/.test(all), 'the failure is diagnosable');
  assert.ok(/Fit profile save failed store GET failed with 500/.test(all));
  assert.ok(/Fit profile delete failed store DEL failed with 500/.test(all));
});

await test('no measurement, brand, size or preference ever appears in the logs', () => {
  const all = logged.join('\n');
  assert.ok(all.length > 0, 'the suite should have logged something, or this proves nothing');
  for (const value of [SENTINEL_BRAND, '43.3', '69.4', '39.5', 'about-right', 'too-large', 'oversized', 'relaxed', 'brandSizes', 'measurements',
    'true-to-size', 'sleeves-short', 'waist-loose', 'troubleZones', 'fitGoal', 'anchor']) {
    assert.ok(!all.includes(value), `${value} was logged`);
  }
});

/* ------------------------------------------------------- */

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length ? 1 : 0);
})().catch((err) => { process.stdout.write(`${err && err.stack}\n`); process.exit(1); });
