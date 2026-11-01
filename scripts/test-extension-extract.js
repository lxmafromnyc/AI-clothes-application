#!/usr/bin/env node
/* =========================================================
   Fynd — the extension's reading, and the one request it makes

     node scripts/test-extension-extract.js

   In Node, no browser:

     - extension/extract.js: the product (structured data, then what the
       page shows), each column's measurement and the method its own
       words state (never a guess), the values (fractions, ranges,
       blanks), body against garment charts, the review the shopper
       corrects, and the chart it sends, each value with where it came
       from
     - the batch comparison on Fynd's server (api/size-recommendation.js,
       ?compare=1&candidate=1 with { chart }), the real handler in this
       process: every size in one request, through the same engine and
       decision as Find Fit's single size — per-size differences equal
       to comparing each size alone — the server's own reasons for a
       body chart, an unstated one and an invalid one, a saved garment
       chosen by type with the shopper's own session (401 without one,
       404 for one not saved), and the rate limit counting a batch once
     - api/_cors.js: the extension's own origin may call the API with
       credentials, and is never taken for the site
     - extension/api.js: each failure — 401, 404, 429 with Retry-After,
       400 with the server's messages, 5xx, an answer that isn't JSON, a
       timeout, no network — named for the panel

   The DOM side (collect.js on fixture pages, and the panel) is in
   scripts/test-fit-panel-browser.js.
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.AUTH_SECRET = 'extension-test-secret-of-sufficient-length';
delete process.env.RESEND_API_KEY;
delete process.env.POSTMARK_SERVER_TOKEN;
delete process.env.ALLOWED_ORIGIN;
global.fetch = async (url) => { throw new Error(`unexpected outbound request to ${url}`); };
['log', 'warn', 'error'].forEach((level) => { const o = console[level]; console[level] = (...a) => { if (process.env.SHOW_LOGS) o(...a); }; });

const X = require('../extension/extract.js');
const ApiFactory = require('../extension/api.js');
const Candidate = require('../assets/fit-candidate.js');
const Schema = require('../assets/fit-profile-schema.js');
const engine = require('../api/_sizing/engine');
const store = require('../api/_store');
const users = require('../api/_users');
const auth = require('../api/_auth');
const fitProfiles = require('../api/_fit-profile');
const cors = require('../api/_cors');
const recommendEndpoint = require('../api/size-recommendation');
const authEndpoint = require('../api/auth');

const out = (text) => process.stdout.write(text);
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; out(`  ok    ${name}\n`); }
  catch (err) { failures.push(name); out(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n        ')}\n`); }
}

/* ---------- requests to the real handlers, in this process ---------- */
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
function cookiesFrom(res, jar) {
  const next = Object.assign({}, jar || {});
  [].concat(res.getHeader('Set-Cookie') || []).forEach((line) => {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    next[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  });
  return next;
}
let caller = 0;
async function call(endpoint, o) {
  const res = makeRes();
  const jar = o.jar || {};
  caller += 1;
  const req = {
    method: o.method || 'POST', url: o.url || '/api/x', query: o.query, body: o.body,
    headers: Object.assign({ host: 'fynd.test' }, Object.keys(jar).length ? { cookie: Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') } : {}, o.headers || {}),
    socket: { remoteAddress: o.ip || `198.51.100.${caller % 250}` }, on() { return this; }
  };
  await endpoint(req, res);
  return { res, status: res.statusCode, body: res.payload, jar: cookiesFrom(res, jar) };
}
const compare = (body, o) => call(recommendEndpoint, Object.assign({ query: { compare: '1', candidate: '1' }, url: '/api/size-recommendation?compare=1&candidate=1', body }, o || {}));
const PASSWORD = 'correct-horse-battery-staple';
async function signUp(email) {
  const { status, jar } = await call(authEndpoint, { headers: { 'x-forwarded-for': `203.0.113.${(caller % 200) + 20}` }, body: { action: 'signup', name: 'Shopper', email, password: PASSWORD, confirmPassword: PASSWORD } });
  assert.strictEqual(status, 200, 'sign-up');
  return { jar, user: await users.byEmail(email) };
}

/* ---------- invented data (none is a real product's) ---------- */
const FORM = { chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };
const MINE = { unit: 'cm', chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 };
const SENT_REFERENCE = { type: 'hoodies', garment: { favorite: 'perfect', anchor: { brand: null, size: null, measurements: { unit: 'cm', chestWidth: '58', bodyLength: '68', shoulderWidth: '50', sleeveLength: '62' } } } };
function savedProfile() {
  const p = Schema.empty();
  p.garments = { hoodies: Object.assign(Schema.emptyGarment('hoodies'), { favorite: 'perfect', anchor: { brand: 'Owned Brand', size: 'L', measurements: Object.assign({}, MINE), methods: Object.assign({ registry: 1 }, FORM) } }) };
  return p;
}
/* the variants-hoodie fixture's chart, as charts() lists it */
const HOODIE_CHART = {
  index: 0, measures: 'finished-garment', unit: 'cm', title: 'Product size (cm)', tab: null, inDialog: false, visible: true,
  columns: ['Chest (½)', 'Shoulder (seam to seam)', 'Length (HPS)', 'Sleeve (from shoulder seam)'],
  methodsSaid: null,
  rows: [['S', '53', '45', '64', '59'], ['M', '55.5', '47.5', '66', '60.5'], ['L', '58', '50', '68', '62'], ['XL', '60.5', '52.5', '70', '63.5']].map(([size, ...values]) => ({ size, values }))
};
const HOODIE_RAW = {
  url: 'https://shop.example.test/products/heavyweight-hoodie?utm_source=x#reviews',
  canonical: 'https://shop.example.test/products/heavyweight-hoodie?utm_source=fixture',
  product: {
    name: 'Illustrative Heavyweight Hoodie', brand: 'Illustrative Outfitters', code: 'FIX-HOOD-1', sku: null, color: 'Heather Grey', url: null,
    sizes: ['S', 'M', 'L', 'XL'],
    variants: [{ sku: 'FIX-HOOD-1-S', size: 'S', color: 'Heather Grey', available: true }, { sku: 'FIX-HOOD-1-XL', size: 'XL', color: 'Heather Grey', available: false }],
    pageSizes: [{ size: 'S', available: true }, { size: 'M', available: true }, { size: 'L', available: true }, { size: 'XL', available: false }],
    from: { name: 'json-ld', brand: 'json-ld', sizes: 'json-ld', color: 'json-ld', code: 'json-ld' }
  }
};
const product = () => X.detectProduct(HOODIE_RAW);
const chartFor = (review) => X.buildChart(review, product(), 'hoodies');

(async () => {
  store.reset();

  out('\nthe product (extract.js detectProduct)\n');

  await test('structured data: name, brand, colour, code and every size, each with whether the page offers it — the picker first, then the variants', () => {
    const p = product();
    assert.deepStrictEqual([p.name, p.brand, p.color, p.code, p.found, p.type], ['Illustrative Heavyweight Hoodie', 'Illustrative Outfitters', 'Heather Grey', 'FIX-HOOD-1', true, 'hoodies']);
    assert.deepStrictEqual(p.sizes, [{ size: 'S', available: true }, { size: 'M', available: true }, { size: 'L', available: true }, { size: 'XL', available: false }]);
    assert.deepStrictEqual(p.missing, []);
    assert.strictEqual(p.url, 'https://shop.example.test/products/heavyweight-hoodie', 'the canonical address, without tracking or a fragment');
    const variantsOnly = X.detectProduct(Object.assign({}, HOODIE_RAW, { product: Object.assign({}, HOODIE_RAW.product, { pageSizes: [] }) }));
    assert.deepStrictEqual(variantsOnly.sizes.map((s) => s.available), [true, null, null, false], 'a size no variant speaks for stays unknown');
  });

  await test('no structured data: what the page shows — and a page with no product is said to have none, never guessed', () => {
    const html = X.detectProduct({ url: 'https://shop.example.test/pocket-tee', product: { name: 'Illustrative Pocket Tee', brand: 'Illustrative Goods', sizes: ['S', 'M', 'L', 'XL'], pageSizes: [{ size: 'XL', available: false }], from: { name: 'heading', brand: 'meta', sizes: 'page' } } });
    assert.deepStrictEqual([html.found, html.type, html.brand, html.from.name, html.from.sizes], [true, 'tshirts', 'Illustrative Goods', 'heading', 'page']);
    assert.deepStrictEqual(html.sizes.map((s) => s.available), [null, null, null, false]);
    const article = X.detectProduct({ url: 'https://journal.example.test/wool', product: { name: 'How to care for wool', sizes: [], from: { name: 'heading' } } });
    assert.strictEqual(article.found, false, 'a heading alone is not a product');
    assert.deepStrictEqual(article.missing, ['brand', 'sizes']);
    assert.strictEqual(X.detectProduct(null).found, false);
    assert.strictEqual(X.detectProduct({ product: { name: 'Illustrative Oxford Shirt', from: { name: 'json-ld' } } }).type, null, 'a kind Fynd doesn’t compare is left for the shopper to choose');
  });

  await test('the kind of garment only from the product’s own name; the address only a plain web page', () => {
    assert.strictEqual(X.guessType('Zip Hooded Sweatshirt'), 'hoodies');
    assert.strictEqual(X.guessType('Crew Neck Sweatshirt'), 'sweatshirts');
    assert.strictEqual(X.guessType('Supima Cotton T-Shirt'), 'tshirts');
    assert.strictEqual(X.guessType('Relaxed Tee'), 'tshirts');
    assert.strictEqual(X.guessType('Straight Jeans'), null);
    assert.strictEqual(X.pageUrl('chrome://settings'), null);
    assert.strictEqual(X.pageUrl('https://user:pw@shop.example.test/p'), null);
    assert.strictEqual(X.pageUrl('https://shop.example.test/p?color=grey&gclid=1&fbclid=2#x'), 'https://shop.example.test/p?color=grey');
  });

  out('\ncolumns and values\n');

  await test('a column is a measurement only when its heading says so; body-only columns never are', () => {
    const dims = ['Chest (½)', 'Bust', 'Pit to pit', 'Body width', 'Shoulder', 'Sleeve length from shoulder', 'Length (HPS)', 'Body length', 'Waist', 'Hips', 'Height', 'Hem width', 'Size', 'Fit'].map(X.dimOf);
    assert.deepStrictEqual(dims, ['chestWidth', 'chestWidth', 'chestWidth', 'chestWidth', 'shoulderWidth', 'sleeveLength', 'bodyLength', 'bodyLength', null, null, null, null, null, null]);
    /* where it's measured from is the method, never the measurement */
    assert.deepStrictEqual(['Front length (from high point of shoulder)', 'Length (shoulder to hem)', 'Body length from shoulder', 'Sleeve length (from shoulder seam)', 'Shoulder width (seam to seam)', 'Chest (measured 1" below armhole)', 'Waist (from side seam)'].map(X.dimOf),
      ['bodyLength', 'bodyLength', 'bodyLength', 'sleeveLength', 'shoulderWidth', 'chestWidth', null]);
  });

  await test('the method only from the chart’s own words: unstated stays unstated', () => {
    assert.strictEqual(X.methodSaid('chestWidth', 'Chest'), null);
    assert.strictEqual(X.methodSaid('chestWidth', 'Chest (½)'), 'flat-width-armpit-to-armpit');
    assert.strictEqual(X.methodSaid('chestWidth', 'Chest 1/2'), 'flat-width-armpit-to-armpit');
    assert.strictEqual(X.methodSaid('chestWidth', 'Pit to pit'), 'flat-width-armpit-to-armpit');
    assert.strictEqual(X.methodSaid('chestWidth', 'Chest circumference'), 'garment-circumference');
    assert.strictEqual(X.methodSaid('bodyLength', 'Length'), null);
    assert.strictEqual(X.methodSaid('bodyLength', 'Length (HPS)'), 'high-point-shoulder-to-hem');
    assert.strictEqual(X.methodSaid('bodyLength', 'Back length'), 'center-back-to-hem');
    assert.strictEqual(X.methodSaid('sleeveLength', 'Sleeve (center back)'), 'center-back-to-cuff');
    assert.strictEqual(X.methodSaid('sleeveLength', 'Sleeve'), null);
    assert.strictEqual(X.methodSaid('shoulderWidth', 'Shoulder (seam to seam)'), 'seam-to-seam');
    assert.strictEqual(X.methodSaid('shoulderWidth', 'Shoulder'), null);
  });

  await test('a body chart maps no column to a garment measurement; a measurement named twice keeps its first column', () => {
    const body = X.planColumns({ measures: 'body', columns: ['Chest', 'Waist', 'Length'] });
    assert.ok(body.every((c) => c.dim === null));
    const twice = X.planColumns({ measures: 'finished-garment', columns: ['Chest (½)', 'Chest circumference', 'Length'] });
    assert.deepStrictEqual(twice.map((c) => [c.dim, c.method]), [['chestWidth', 'flat-width-armpit-to-armpit'], [null, null], ['bodyLength', null]]);
  });

  await test('values: whole, decimal, comma, fractions — a range, a word or a blank is never a number', () => {
    const v = (t) => X.parseValue(t);
    assert.deepStrictEqual([v('21').value, v('21.5').value, v('21,5').value, v('20 ½').value, v('23½').value, v('20 1/2').value, v('58 cm').value, v('22"').value], [21, 21.5, 21.5, 20.5, 23.5, 20.5, 58, 22]);
    assert.deepStrictEqual([v('21-22').problem, v('34 – 37').problem, v('21 to 22').problem], ['range', 'range', 'range']);
    assert.deepStrictEqual([v('XL').problem, v('approx').problem, v('').problem, v(null).problem], ['not-a-number', 'not-a-number', 'empty', 'empty']);
    assert.strictEqual(v('20 3/2').problem, 'not-a-number');
  });

  out('\nthe review and the chart sent\n');

  await test('a garment chart whose headings state every method: nothing left to ask, and the chart sent says where each value came from', () => {
    const review = X.startReview(HOODIE_CHART, product());
    assert.deepStrictEqual([review.source, review.measures, review.measuresConfirmed, review.unit], ['page-table', 'finished-garment', true, 'cm']);
    assert.deepStrictEqual(review.columns.map((c) => [c.dim, c.method]), [['chestWidth', FORM.chestWidth], ['shoulderWidth', FORM.shoulderWidth], ['bodyLength', FORM.bodyLength], ['sleeveLength', FORM.sleeveLength]]);
    assert.deepStrictEqual(review.rows.map((r) => r.available), [true, true, true, false]);
    assert.deepStrictEqual(X.reviewProblems(review, 'hoodies'), []);
    const chart = chartFor(review);
    assert.deepStrictEqual(chart.methods, Object.assign({ registry: 1 }, { chestWidth: FORM.chestWidth, shoulderWidth: FORM.shoulderWidth, bodyLength: FORM.bodyLength, sleeveLength: FORM.sleeveLength }));
    assert.strictEqual(chart.measures, 'finished-garment');
    assert.strictEqual(chart.sizes.length, 4);
    assert.deepStrictEqual(chart.sizes[2], { size: 'L', measurements: { chestWidth: 58, shoulderWidth: 50, bodyLength: 68, sleeveLength: 62 }, provenance: {
      chestWidth: { source: 'page-table', header: 'Chest (½)', corrected: false }, shoulderWidth: { source: 'page-table', header: 'Shoulder (seam to seam)', corrected: false },
      bodyLength: { source: 'page-table', header: 'Length (HPS)', corrected: false }, sleeveLength: { source: 'page-table', header: 'Sleeve (from shoulder seam)', corrected: false } } });
    assert.ok(!JSON.stringify(chart).includes('verified'), 'nothing in the chart claims to be checked');
  });

  await test('a chart that doesn’t say what it measures, or how, or in what unit: each is asked, nothing assumed', () => {
    const unlabelled = { index: 0, measures: 'not-stated', unit: null, title: 'Size chart', columns: ['Chest', 'Length'], rows: [{ size: 'S', values: ['19', '27'] }, { size: 'M', values: ['20.5', '28'] }] };
    const review = X.startReview(unlabelled, null);
    const problems = X.reviewProblems(review, 'tshirts');
    assert.ok(problems.some((t) => /Confirm these are the garment’s own measurements/.test(t)));
    assert.ok(problems.some((t) => /centimetres or inches/.test(t)));
    assert.ok(problems.some((t) => /how the chart measures the chest width/.test(t)));
    assert.ok(problems.some((t) => /how the chart measures the body length/.test(t)));
    assert.deepStrictEqual(X.reviewProblems(review, null)[0], 'Choose what kind of garment this is.');
    /* the shopper answers: confirmed, inches, and "the chart doesn't say" — sent as not-stated, never a guess */
    review.measuresConfirmed = true;
    review.unit = 'in';
    review.columns[0].method = 'not-stated';
    review.columns[1].method = 'not-stated';
    assert.deepStrictEqual(X.reviewProblems(review, 'tshirts'), []);
    const chart = X.buildChart(review, null, 'tshirts');
    assert.deepStrictEqual([chart.measures, chart.methods.chestWidth, chart.methods.bodyLength], ['finished-garment', 'not-stated', 'not-stated']);
  });

  await test('a body chart can never be sent as the garment’s: the review says why, and what it builds still says body', () => {
    const body = { index: 0, measures: 'body', unit: 'in', columns: ['Chest', 'Waist'], rows: [{ size: 'S', values: ['34 - 37', '28 - 31'] }] };
    const review = X.startReview(body, null);
    assert.strictEqual(review.measuresConfirmed, false);
    assert.ok(X.reviewProblems(review, 'hoodies').some((t) => /measures the body, not the garment/.test(t)));
    assert.strictEqual(X.buildChart(review, null, 'hoodies').measures, 'body');
  });

  await test('ambiguous and missing values: a range blocks until corrected or cleared; a blank is left out, never filled', () => {
    const chart = { index: 0, measures: 'finished-garment', unit: 'in', columns: ['Body width', 'Body length'], rows: [{ size: 'S', values: ['19', '27'] }, { size: 'L', values: ['21-22', '29'] }, { size: 'XL', values: ['23½', ''] }] };
    const review = X.startReview(chart, null);
    review.columns[0].method = 'flat-width-armpit-to-armpit';
    review.columns[1].method = 'not-stated';
    assert.deepStrictEqual(review.rows[1].cells[0], { raw: '21-22', value: null, problem: 'range', corrected: false });
    assert.ok(X.reviewProblems(review, 'tshirts').some((t) => /aren’t single numbers \(sizes L\)/.test(t)));
    const sent = X.buildChart(review, null, 'tshirts');
    assert.deepStrictEqual(sent.sizes.find((s) => s.size === 'XL').measurements, { chestWidth: 23.5 }, 'the blank length is missing, not zero');
    assert.deepStrictEqual(sent.sizes.find((s) => s.size === 'L').measurements, { bodyLength: 29 }, 'an unreadable value is never sent');
  });

  await test('a manual correction is the shopper’s: marked corrected on that value alone; a value the page left blank and the shopper typed is theirs', () => {
    const chart = { index: 0, measures: 'finished-garment', unit: 'in', columns: ['Body width', 'Body length'], rows: [{ size: 'L', values: ['21-22', '29'] }, { size: 'XL', values: ['23.5', ''] }] };
    const review = X.startReview(chart, null);
    review.columns[0].method = 'flat-width-armpit-to-armpit';
    review.columns[1].method = 'not-stated';
    /* as the panel does on input: parse, mark corrected */
    const correct = (ri, ci, text) => { const c = review.rows[ri].cells[ci]; const p = X.parseValue(text); c.corrected = p.value !== c.value || c.corrected; c.value = p.value; c.problem = p.problem; };
    correct(0, 0, '21.5');
    correct(1, 1, '30');
    assert.deepStrictEqual(X.reviewProblems(review, 'tshirts'), []);
    const sent = X.buildChart(review, null, 'tshirts');
    assert.deepStrictEqual(sent.sizes[0].provenance, { chestWidth: { source: 'page-table', header: 'Body width', corrected: true }, bodyLength: { source: 'page-table', header: 'Body length', corrected: false } });
    assert.deepStrictEqual(sent.sizes[1].provenance.bodyLength, { source: 'shopper', header: 'Body length', corrected: true });
    assert.deepStrictEqual(sent.sizes[0].measurements, { chestWidth: 21.5, bodyLength: 29 });
  });

  await test('no chart on the page: the product’s sizes to fill in by hand, every value the shopper’s, the size labels checked', () => {
    const review = X.emptyReview(product());
    assert.deepStrictEqual([review.source, review.measures, review.rows.map((r) => r.size)], ['shopper', 'not-stated', ['S', 'M', 'L', 'XL']]);
    assert.ok(X.reviewProblems(review, 'hoodies').some((t) => /no measurements to compare yet/.test(t)));
    review.measuresConfirmed = true;
    review.unit = 'cm';
    review.columns.forEach((c) => { c.method = FORM[c.dim]; });
    review.rows[2].cells[0] = { raw: '58', value: 58, problem: null, corrected: false };
    assert.deepStrictEqual(X.reviewProblems(review, 'hoodies'), []);
    const sent = X.buildChart(review, product(), 'hoodies');
    assert.deepStrictEqual(sent.sizes, [{ size: 'L', measurements: { chestWidth: 58 }, provenance: { chestWidth: { source: 'shopper', header: 'Chest width', corrected: false } } }]);
    review.rows.push({ size: 'l', available: null, cells: { 0: { raw: '59', value: 59, problem: null, corrected: false } } });
    review.rows.push({ size: '', available: null, cells: { 0: { raw: '60', value: 60, problem: null, corrected: false } } });
    const problems = X.reviewProblems(review, 'hoodies');
    assert.ok(problems.includes('Each size can be listed once only.'));
    assert.ok(problems.includes('Give every size with measurements its label (S, M, L…).'));
  });

  await test('the chest is required, as the decision requires it', () => {
    const review = X.startReview({ index: 0, measures: 'finished-garment', unit: 'cm', columns: ['Length (HPS)'], rows: [{ size: 'M', values: ['66'] }] }, null);
    assert.ok(X.reviewProblems(review, 'hoodies').some((t) => /needs the chest/.test(t)));
  });

  out('\nthe server: every size in one request (api/size-recommendation.js)\n');

  const fullChart = () => chartFor(X.startReview(HOODIE_CHART, product()));

  await test('one request, every size: Fynd’s engine compares them all and its decision picks one — the same as comparing each size alone', async () => {
    const got = await compare({ chart: fullChart(), reference: SENT_REFERENCE });
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    const { comparison: c, decision: d, chart } = got.body;
    assert.deepStrictEqual(c.sizes.map((s) => s.size), ['S', 'M', 'L', 'XL']);
    assert.deepStrictEqual([d.outcome, d.size], ['OK', 'L']);
    assert.strictEqual(c.dataStatus, 'shopper-entered');
    assert.notStrictEqual(c.reliability, 'high', 'a shopper-confirmed chart is never more than medium');
    assert.strictEqual(chart.sizes[2].provenance.chestWidth.source, 'page-table', 'the chart echoed as the server read it, with its provenance');
    /* each size beside the garment exactly as Find Fit's single-size comparison sets it */
    for (const s of fullChart().sizes) {
      const one = await compare({ candidate: { type: 'hoodies', brand: 'Illustrative Outfitters', name: 'Illustrative Heavyweight Hoodie', size: s.size, unit: 'cm', measurements: s.measurements, methods: fullChart().methods }, reference: SENT_REFERENCE });
      assert.strictEqual(one.status, 200);
      const alone = one.body.comparison.sizes[0].dimensions;
      const inBatch = c.sizes.find((x) => x.size === s.size).dimensions;
      Object.keys(alone).forEach((dim) => assert.deepStrictEqual([inBatch[dim].difference, inBatch[dim].tolerance, inBatch[dim].withinTolerance, inBatch[dim].compared], [alone[dim].difference, alone[dim].tolerance, alone[dim].withinTolerance, alone[dim].compared], `${s.size} ${dim}`));
    }
  });

  await test('each value the server compares is labelled the shopper’s, from the product’s page — never "official-published", never verified', async () => {
    const got = await compare({ chart: fullChart(), reference: SENT_REFERENCE });
    const m = got.body.comparison.sizes[0].dimensions.chestWidth.measurement;
    assert.deepStrictEqual([m.source.origin, m.source.url, m.status], ['shopper-entered', 'https://shop.example.test/products/heavyweight-hoodie', 'unverified']);
  });

  await test('no size meets the criteria: NO_MATCH with the closest, in the catalogue’s words for several sizes', async () => {
    /* every size well under the garment: none within the tolerances */
    const small = fullChart();
    small.sizes = small.sizes.slice(0, 2).map((x) => Object.assign({}, x, { measurements: Object.fromEntries(Object.entries(x.measurements).map(([d, v]) => [d, v - 6])) }));
    const got = await compare({ chart: small, reference: SENT_REFERENCE });
    assert.strictEqual(got.status, 200);
    const d = got.body.decision;
    assert.deepStrictEqual([d.outcome, d.size, d.closest], ['NO_MATCH', null, 'M']);
    assert.ok(!d.messages.some((t) => /the size you entered/i.test(t)), d.messages.join(' | '));
  });

  await test('methods the chart doesn’t state: INSUFFICIENT_DATA, measurement by measurement — never a size', async () => {
    const chart = fullChart();
    chart.methods = { registry: 1, chestWidth: 'not-stated', shoulderWidth: 'not-stated', bodyLength: 'not-stated', sleeveLength: 'not-stated' };
    const got = await compare({ chart, reference: SENT_REFERENCE });
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual([got.body.decision.outcome, got.body.decision.size, got.body.decision.closest || null], ['INSUFFICIENT_DATA', null, null]);
    assert.ok(got.body.decision.dimensions.every((x) => x.status === 'method-not-stated'));
  });

  await test('the server refuses a body chart, an unstated one, and an invalid one — with its own reason and messages', async () => {
    const body = Object.assign(fullChart(), { measures: 'body' });
    let got = await compare({ chart: body, reference: SENT_REFERENCE });
    assert.deepStrictEqual([got.status, got.body.reason], [400, 'body-measurements']);
    got = await compare({ chart: Object.assign(fullChart(), { measures: 'not-stated' }), reference: SENT_REFERENCE });
    assert.deepStrictEqual([got.status, got.body.reason], [400, 'measures-not-stated']);
    const tooMany = fullChart();
    tooMany.sizes = Array.from({ length: 31 }, (_, i) => ({ size: `S${i}`, measurements: { chestWidth: 50 + i * 0.5 }, provenance: {} }));
    got = await compare({ chart: tooMany, reference: SENT_REFERENCE });
    assert.deepStrictEqual([got.status, got.body.reason], [400, 'invalid-chart']);
    const twice = fullChart();
    twice.sizes[1].size = 'S';
    got = await compare({ chart: twice, reference: SENT_REFERENCE });
    assert.deepStrictEqual([got.status, got.body.reason], [400, 'invalid-chart']);
    const claimed = fullChart();
    claimed.sizes[0].provenance.chestWidth.source = 'verified';
    got = await compare({ chart: claimed, reference: SENT_REFERENCE });
    assert.strictEqual(got.status, 200);
    assert.deepStrictEqual(got.body.chart.sizes[0].provenance.chestWidth, undefined, 'a source claiming to be checked is never kept: provenance is recorded, never trusted');
    assert.strictEqual(got.body.comparison.dataStatus, 'shopper-entered');
    got = await compare({ chart: Object.assign(fullChart(), { unit: null }), reference: SENT_REFERENCE });
    assert.strictEqual(got.status, 400);
    assert.ok(got.body.errors.length && got.body.errors.every((e) => typeof e.message === 'string'));
  });

  await test('a saved garment chosen by type: only with the shopper’s own session — 401 without one, 404 for one not saved, and the comparison uses that garment alone', async () => {
    let got = await compare({ chart: fullChart(), referenceType: 'hoodies' });
    assert.deepStrictEqual([got.status, got.body.reason], [401, 'sign-in-required']);
    const ada = await signUp('ada.extension@example.test');
    got = await compare({ chart: fullChart(), referenceType: 'hoodies' }, { jar: ada.jar });
    assert.deepStrictEqual([got.status, got.body.reason], [404, 'reference-not-found'], 'nothing saved yet');
    await fitProfiles.save(ada.user.id, savedProfile());
    got = await compare({ chart: fullChart(), referenceType: 'tshirts' }, { jar: ada.jar });
    assert.deepStrictEqual([got.status, got.body.reason], [404, 'reference-not-found'], 'a type with no garment saved');
    got = await compare({ chart: fullChart(), referenceType: 'jeans' }, { jar: ada.jar });
    assert.strictEqual(got.status, 404);
    got = await compare({ chart: fullChart(), referenceType: 'hoodies' }, { jar: ada.jar });
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.deepStrictEqual(got.body.reference, { type: 'hoodies' });
    assert.deepStrictEqual([got.body.decision.outcome, got.body.decision.size], ['OK', 'L']);
    assert.strictEqual(got.body.comparison.reference.category, 'hoodies');
    /* another shopper's session never reaches Ada's garment */
    const bo = await signUp('bo.extension@example.test');
    got = await compare({ chart: fullChart(), referenceType: 'hoodies' }, { jar: bo.jar });
    assert.strictEqual(got.status, 404);
    /* a forged session cookie is no session */
    got = await compare({ chart: fullChart(), referenceType: 'hoodies' }, { jar: { fynd_session: 'forged' } });
    assert.strictEqual(got.status, 401);
  });

  await test('the rate limit counts a batch once, whatever its sizes; past it, 429 with Retry-After — and the usage meter is untouched', async () => {
    const ip = '192.0.2.77';
    /* the plan's usage meter (api/_usage.js, metered on /api/search) is never called by a comparison */
    const usage = require('../api/_usage');
    const metered = [];
    const kept = {};
    ['meter', 'check', 'record'].forEach((k) => { kept[k] = usage[k]; usage[k] = (...a) => { metered.push(k); return kept[k](...a); }; });
    for (let i = 0; i < 60; i += 1) {
      const got = await compare({ chart: fullChart(), reference: SENT_REFERENCE }, { ip });
      assert.strictEqual(got.status, 200, `request ${i + 1}`);
    }
    const over = await compare({ chart: fullChart(), reference: SENT_REFERENCE }, { ip });
    assert.deepStrictEqual([over.status, over.body.reason], [429, 'rate-limited']);
    assert.ok(Number(over.res.getHeader('Retry-After')) > 0);
    const other = await compare({ chart: fullChart(), reference: SENT_REFERENCE }, { ip: '192.0.2.78' });
    assert.strictEqual(other.status, 200, 'another address has its own allowance');
    Object.assign(usage, kept);
    assert.deepStrictEqual(metered, [], 'no usage metered, no plan quota spent');
  });

  await test('the engine itself is unchanged for one size: Find Fit’s single-size record has the same shape as before, plus only the shopper origin', () => {
    const r = engine.candidateRecord({ type: 'hoodies', brand: 'B', name: 'N', size: 'L', unit: 'cm', measurements: { chestWidth: 58 }, methods: { registry: 1, chestWidth: FORM.chestWidth } });
    assert.deepStrictEqual(r, { id: 'your-candidate', brand: 'B', product: { name: 'N' }, category: 'hoodies', units: 'cm', sizes: ['L'],
      charts: { garment: { measures: 'finished-garment', origin: 'shopper-entered', source: null, dimensions: { chestWidth: { method: FORM.chestWidth } }, sizes: { L: { chestWidth: { value: 58, text: '58' } } } } },
      verification: { status: 'shopper-entered' } });
    assert.strictEqual(engine.candidateRecord({ type: 'hoodies', unit: 'cm', sizes: [] }), null);
    assert.strictEqual(engine.candidateRecord({ type: 'hoodies', unit: 'cm', sizes: Array.from({ length: 31 }, (_, i) => ({ size: `S${i}`, measurements: { chestWidth: 50 } })) }), null);
  });

  out('\nthe extension’s origin (api/_cors.js)\n');

  await test('the extension may call the API with credentials; it is never the site, and no other extension is let in', () => {
    const ext = cors.EXTENSION_ORIGINS[0];
    assert.match(ext, /^chrome-extension:\/\/[a-p]{32}$/);
    const req = (origin) => ({ method: 'GET', headers: { host: 'ai-clothes-application.vercel.app', origin } });
    const res = makeRes();
    cors.applyCors(req(ext), res);
    assert.strictEqual(res.getHeader('Access-Control-Allow-Origin'), ext);
    assert.strictEqual(String(res.getHeader('Access-Control-Allow-Credentials')), 'true');
    assert.strictEqual(cors.isSiteOrigin(req(ext), ext), false);
    assert.ok(!/^chrome-extension:/.test(cors.siteOrigin(req(ext))), 'links and redirects are never built on the extension');
    const other = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const res2 = makeRes();
    cors.applyCors(req(other), res2);
    assert.notStrictEqual(res2.getHeader('Access-Control-Allow-Origin'), other);
    assert.strictEqual(cors.isAllowed(req('https://lxmafromnyc.github.io'), 'https://lxmafromnyc.github.io'), true, 'the Pages site unchanged');
  });

  out('\nthe panel’s requests (extension/api.js)\n');

  const reply = (status, data, headers) => async () => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => (headers || {})[k] || null }, json: async () => { if (data === undefined) throw new SyntaxError('not JSON'); return data; } });
  const api = (fetchFn, timeoutMs) => ApiFactory({ base: 'https://api.example.test/', fetch: fetchFn, timeoutMs });

  await test('one POST for every size, with the shopper’s own session and nothing cached', async () => {
    const seen = [];
    const a = api(async (url, init) => { seen.push({ url, init }); return reply(200, { decision: { outcome: 'OK' } })(); });
    const got = await a.compareChart({ sizes: [] }, 'hoodies');
    assert.strictEqual(got.ok, true);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, 'https://api.example.test/api/size-recommendation?compare=1&candidate=1');
    assert.deepStrictEqual([seen[0].init.method, seen[0].init.credentials, seen[0].init.cache], ['POST', 'include', 'no-store']);
    assert.deepStrictEqual(JSON.parse(seen[0].init.body), { chart: { sizes: [] }, referenceType: 'hoodies' });
    await a.savedGarments();
    assert.deepStrictEqual([seen[1].url, seen[1].init.method], ['https://api.example.test/api/fit-profile', 'GET']);
  });

  await test('each failure is named: sign-in, not found, rate limited with its wait, invalid with the server’s messages, server, not JSON', async () => {
    const kind = async (f) => (await api(f).compareChart({}, 'hoodies')).problem;
    assert.strictEqual((await kind(reply(401, { error: 'Sign in' }))).kind, 'sign-in');
    assert.strictEqual((await kind(reply(404, { error: 'x', reason: 'reference-not-found' }))).reason, 'reference-not-found');
    const limited = await kind(reply(429, { error: 'Too many' }, { 'Retry-After': '120' }));
    assert.deepStrictEqual([limited.kind, limited.retryAfter], ['rate-limited', 120]);
    const invalid = await kind(reply(400, { error: 'Bad', reason: 'body-measurements', errors: [{ field: 'measures', message: 'Body sizes' }, { nope: 1 }] }));
    assert.deepStrictEqual([invalid.kind, invalid.reason, invalid.errors.length], ['invalid', 'body-measurements', 1]);
    assert.strictEqual((await kind(reply(500, { error: 'x' }))).kind, 'server');
    assert.strictEqual((await kind(reply(200))).kind, 'server', 'a 200 that isn’t JSON is no answer');
    assert.strictEqual((await kind(reply(502))).message, 'Fynd couldn’t answer just now.');
  });

  await test('no answer in time is a timeout, the request aborted; no network is offline', async () => {
    let aborted = false;
    const hang = (url, init) => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => { aborted = true; const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); });
    const t = await api(hang, 30).compareChart({}, 'hoodies');
    assert.deepStrictEqual([t.ok, t.problem.kind, aborted], [false, 'timeout', true]);
    const o = await api(async () => { throw new TypeError('Failed to fetch'); }).savedGarments();
    assert.strictEqual(o.problem.kind, 'offline');
  });

  out(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) { failures.forEach((f) => out(`  - ${f}\n`)); process.exit(1); }
})();
