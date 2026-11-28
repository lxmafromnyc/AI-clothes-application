#!/usr/bin/env node
/* =========================================================
   Fynd — the extension's reading of a captured UNIQLO Size Guide

     node scripts/test-uniqlo-capture.js

   The real extension/collect.js, run in Playwright's headless Chromium
   on two CAPTURED fixtures of UNIQLO's E471808 Size Guide drawer
   (scripts/fixtures/fit-panel/shop/uniqlo-product-size-modal.html and
   uniqlo-body-size-modal.html: the drawer's HTML as the browser rendered
   it on 2026-11-28, each byte checked against the hash recorded when it
   was captured), then extension/extract.js in this process, then the
   batch comparison on Fynd's own handler (api/size-recommendation.js,
   ?compare=1&candidate=1) against a controlled, invented reference.

   This is a fixture test. It is not live verification: no request
   leaves this machine (every one the page tries is refused and
   counted), and passing says nothing about UNIQLO's page today. The
   fixture is not sizing evidence and is not used by any sizing record.
   ========================================================= */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.AUTH_SECRET = 'uniqlo-capture-secret-of-sufficient-length';
delete process.env.ALLOWED_ORIGIN;
delete process.env.RESEND_API_KEY;
delete process.env.POSTMARK_SERVER_TOKEN;
global.fetch = async (url) => { throw new Error(`unexpected outbound request to ${url}`); };
['log', 'warn', 'error'].forEach((level) => { const o = console[level]; console[level] = (...a) => { if (process.env.SHOW_LOGS) o(...a); }; });

const ROOT = path.join(__dirname, '..');
const SHOP = path.join(__dirname, 'fixtures', 'fit-panel', 'shop');
const X = require('../extension/extract.js');
const sizing = require('../api/_sizing/records');
const sizingSchema = require('../api/_sizing/schema');
const recommendEndpoint = require('../api/size-recommendation');

const out = (text) => process.stdout.write(text);
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; out(`  ok    ${name}\n`); }
  catch (err) { failures.push(name); out(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n        ')}\n`); }
}

/* the two captures, and the hash of each drawer as captured */
const CAPTURES = {
  product: { file: 'uniqlo-product-size-modal.html', length: 21776, sha256: '393ea2b2957ccdcd798103fa3febe69ffb5989c5814514c2dd53dc8bd2bd999f' },
  body: { file: 'uniqlo-body-size-modal.html', length: 17878, sha256: '0809e70b136d89331e5a6a6a6eb7ea976419d3856d694c607d81c12afe8a49a9' }
};
const drawerOf = (file) => {
  const page = fs.readFileSync(path.join(SHOP, file), 'utf8');
  const m = page.match(/<!-- captured drawer begins -->\r?\n([\s\S]*?)\r?\n<!-- captured drawer ends -->/);
  return m ? m[1] : null;
};

/* UNIQLO's Product Size table for E471808, as the captured drawer shows it (inches) */
const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const SHOWN = {
  bodyLength: [25.25, 26, 27.25, 28.25, 29.5, 30.25, 30.5, 31.25],
  shoulderWidth: [21.5, 22, 22.75, 23.25, 24, 24.75, 25.5, 26.5],
  chestWidth: [21.25, 22.5, 23.5, 24.75, 26.5, 28, 29.25, 30.75],
  sleeveLength: [32.25, 32.75, 33.75, 34.75, 35.75, 36.25, 36.5, 37]
};

/* ---------- the server's handler, in this process ---------- */
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
let caller = 0;
async function compare(body) {
  const res = makeRes();
  caller += 1;
  const req = {
    method: 'POST', url: '/api/size-recommendation?compare=1&candidate=1', query: { compare: '1', candidate: '1' }, body,
    headers: { host: 'fynd.test' }, socket: { remoteAddress: `198.51.100.${caller}` }, on() { return this; }
  };
  await recommendEndpoint(req, res);
  return { status: res.statusCode, body: res.payload };
}

/* An invented reference garment (not a real product), in inches, sent with the
   request as Find Fit sends one: the form's own methods, plus the two
   construction-free alternates ("measure more"), so length and sleeve can be
   compared from the centre back. Its sleeves aren't stated. */
const REFERENCE = {
  type: 'hoodies',
  garment: {
    favorite: 'perfect',
    anchor: {
      brand: null, size: null,
      measurements: { unit: 'in', chestWidth: '26.5', bodyLength: '28', shoulderWidth: '20', sleeveLength: '25' },
      alternates: [{ dimension: 'bodyLength', value: 29.5 }, { dimension: 'sleeveLength', value: 35.75 }]
    }
  }
};

(async () => {
  out('test-uniqlo-capture\n');

  await test('each captured drawer is byte for byte what was captured: its length and sha256 as recorded on capture', () => {
    Object.values(CAPTURES).forEach((c) => {
      const drawer = drawerOf(c.file);
      assert.ok(drawer, `${c.file}: the captured drawer is marked`);
      assert.strictEqual(drawer.length, c.length, `${c.file}: length`);
      assert.strictEqual(crypto.createHash('sha256').update(drawer, 'utf8').digest('hex'), c.sha256, `${c.file}: sha256`);
    });
  });

  await test('the captures are fixtures, not sizing evidence: no record, approval or evidence names them', () => {
    const named = (text) => Object.values(CAPTURES).some((c) => text.includes(c.file));
    assert.ok(!named(fs.readFileSync(path.join(ROOT, 'api', '_sizing', 'approvals.json'), 'utf8')));
    fs.readdirSync(path.join(ROOT, 'api', '_sizing', 'records')).forEach((f) => assert.ok(!named(fs.readFileSync(path.join(ROOT, 'api', '_sizing', 'records', f), 'utf8')), f));
    assert.ok(!fs.existsSync(path.join(ROOT, 'api', '_sizing', 'evidence')) || fs.readdirSync(path.join(ROOT, 'api', '_sizing', 'evidence')).every((f) => !named(f)));
  });

  await test('the shared method reader (assets/ and the extension’s copy): explicit words map, broadest and seam to seam stay apart, and anything ambiguous stays unresolved', () => {
    const Shared = require('../assets/chart-reading.js');
    const cases = [
      ['shoulderWidth', 'Shoulder width (seam to seam)', 'seam-to-seam'],
      ['shoulderWidth', 'Shoulder width(seam to seam)', 'seam-to-seam'],
      ['shoulderWidth', 'Shoulder width (broadest part of the shoulders)', 'broadest-part-of-shoulders'],
      ['shoulderWidth', 'Shoulder width (broadest part)', 'broadest-part-of-shoulders'],
      /* not one phrase about the shoulders: a comma-separated clause isn't read as one */
      ['shoulderWidth', 'Shoulders, at the broadest point', null],
      ['shoulderWidth', 'Shoulder width (seam to seam; broadest part)', null],
      /* generic words that never name the shoulders: evidence text is read alone (api/_sizing/chart-ai.js) */
      ['shoulderWidth', 'broadest part', null],
      ['shoulderWidth', 'measured at the broadest part', null],
      ['shoulderWidth', 'at the broadest point', null],
      ['shoulderWidth', 'broadest', null],
      ['shoulderWidth', 'Width (broadest part)', null],
      ['shoulderWidth', 'Shoulder width (broadest)', null],
      ['shoulderWidth', 'Shoulder width', null],
      ['sleeveLength', 'Sleeve length (centre back)', 'center-back-to-cuff'],
      ['sleeveLength', 'Sleeve Length(center back)', 'center-back-to-cuff'],
      ['sleeveLength', 'Sleeve length (from shoulder seam)', 'shoulder-seam-to-cuff'],
      ['sleeveLength', 'Sleeve length', null],
      ['bodyLength', 'Length (back)', 'center-back-to-hem'],
      ['bodyLength', 'Length(back)', 'center-back-to-hem'],
      ['bodyLength', 'Length', null],
      ['chestWidth', 'Chest', null]
    ];
    cases.forEach(([dim, words, method]) => {
      assert.strictEqual(Shared.methodSaid(dim, words), method, `${dim} “${words}”`);
      assert.strictEqual(X.methodSaid(dim, words), method, `extension copy: ${dim} “${words}”`);
    });
    const Tables = require('../assets/sizing-tables.js');
    assert.deepStrictEqual(Tables.methodsOf(['Shoulder width (broadest part of the shoulders)', 'Chest'], ''), ['broadest part of the shoulders', null]);
    assert.strictEqual(Tables.methodsOf(['Chest (broadest part)', 'Hem broadest'], ''), null, 'a “broadest” said of no shoulder is no method word');
  });

  await test('“broadest” from another clause or dimension never makes a broadest-shoulder method: chest, hip, hem and the like, however the clauses are separated', () => {
    const Shared = require('../assets/chart-reading.js');
    const Tables = require('../assets/sizing-tables.js');
    [
      'Shoulder width; chest measured at the broadest part',
      'Shoulder width; hip measured at the broadest point',
      'Shoulder width. Chest: broadest part',
      'Shoulder width | hips at the broadest point',
      'Shoulder width\nchest at the broadest part',
      'Shoulder width, chest at the broadest part',
      'Shoulder width (chest at the broadest part)',
      'Shoulder width (hip, broadest point)',
      'Chest (broadest part); shoulder width',
      'Hip at the broadest point of the body; shoulders',
      'Shoulder width (broadest part of the chest)'
    ].forEach((words) => {
      assert.strictEqual(Shared.methodSaid('shoulderWidth', words), null, `“${words}”`);
      assert.strictEqual(X.methodSaid('shoulderWidth', words), null, `extension copy: “${words}”`);
      assert.strictEqual(Tables.broadestShoulder(words), null, `methodsOf’s reader: “${words}”`);
    });
    /* seam to seam beside any "broadest" is ambiguous: neither method */
    ['Shoulder width (seam to seam); chest at the broadest part', 'Shoulder width (broadest part); seam to seam'].forEach((words) => assert.strictEqual(Shared.methodSaid('shoulderWidth', words), null, `“${words}”`));
  });

  await test('every supported broadest-shoulder heading is read the same by methodSaid and methodsOf (METHOD_WORDS): the method, and the words it was said in', () => {
    const Shared = require('../assets/chart-reading.js');
    const Tables = require('../assets/sizing-tables.js');
    const SUPPORTED = {
      'Shoulder width (broadest part)': 'broadest part',
      'Shoulder width (broadest point)': 'broadest point',
      'Shoulder width(broadest part)': 'broadest part',
      'Shoulders (broadest part)': 'broadest part',
      'Shoulder (at the broadest point)': 'broadest point',
      'Shoulder width (measured at the broadest part)': 'broadest part',
      'SHOULDER WIDTH (BROADEST PART)': 'broadest part',
      'Shoulder width (broadest part of the shoulders)': 'broadest part of the shoulders',
      'Broadest point of the shoulder': 'broadest point of the shoulder',
      'Across the broadest part of shoulders': 'broadest part of shoulders'
    };
    Object.entries(SUPPORTED).forEach(([heading, said]) => {
      assert.strictEqual(Shared.methodSaid('shoulderWidth', heading), 'broadest-part-of-shoulders', `methodSaid “${heading}”`);
      assert.strictEqual(X.methodSaid('shoulderWidth', heading), 'broadest-part-of-shoulders', `extension copy “${heading}”`);
      assert.deepStrictEqual(Tables.methodsOf([heading], ''), [said], `methodsOf “${heading}”`);
      /* the extension's own path: the heading and what methodsOf said of it */
      assert.strictEqual(Shared.methodSaid('shoulderWidth', `${heading} ${said}`), 'broadest-part-of-shoulders', `heading + said “${heading}”`);
    });
    /* seam to seam: the same agreement */
    assert.strictEqual(Shared.methodSaid('shoulderWidth', 'Shoulder width (seam to seam)'), 'seam-to-seam');
    assert.deepStrictEqual(Tables.methodsOf(['Shoulder width (seam to seam)'], ''), ['seam to seam']);
  });

  let chromium;
  try { ({ chromium } = require('playwright')); } catch (err) { chromium = null; }
  let browser = null;
  if (chromium) {
    try { browser = await chromium.launch(); } catch (err) { browser = null; }
  }
  await test('Chromium launches (a suite that can’t run its browser fails, never skips)', () => assert.ok(browser, 'Chromium did not launch'));

  /* the real collect.js in a page, with every request the page makes refused and counted */
  const collected = {};
  const attempted = [];
  if (browser) {
    for (const [key, c] of Object.entries(CAPTURES)) {
      const page = await browser.newPage();
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('file:')) return route.continue();
        attempted.push(url);
        return route.abort();
      });
      await page.goto(`file:///${path.join(SHOP, c.file).split(path.sep).join('/')}`);
      await page.addScriptTag({ path: path.join(ROOT, 'extension', 'collect.js') });
      collected[key] = await page.evaluate(() => fyndCollect()); // eslint-disable-line no-undef
      await page.close();
    }
    await browser.close();
  }
  const raw = (key) => { assert.ok(collected[key], `collect.js ran on the ${key} capture`); return collected[key]; };

  await test('nothing leaves this machine: each request the captured page tries (UNIQLO’s icons) is refused, and none is to Fynd or anything collect.js asked for', () => {
    raw('product');
    attempted.forEach((u) => assert.ok(/^https:\/\/asset\.uniqlo\.com\/g\/icons\//.test(u), u));
  });

  await test('the Product Size drawer: one table, read as a finished-garment chart, its eight sizes and four columns', () => {
    const r = raw('product');
    assert.strictEqual(r.tables.length, 1);
    assert.deepStrictEqual(r.tables[0].rows[0], ['Size', 'Length(back)', 'Shoulder width(seam to seam)', 'Chest', 'Sleeve Length(center back)'], 'each heading as collect.js reads it: its line break joins the words');
    const c = X.charts(r);
    assert.strictEqual(c.confident, true);
    assert.deepStrictEqual(c.unread, []);
    assert.strictEqual(c.list.length, 1);
    assert.strictEqual(c.list[0].measures, 'finished-garment', 'the drawer says “the actual measurements of the product”');
    assert.deepStrictEqual(c.list[0].rows.map((row) => row.size), SIZES);
  });

  await test('every displayed size and value is read exactly (fractions included), into the measurement its heading names', () => {
    const r = raw('product');
    const chart = X.charts(r).list[0];
    const review = X.startReview(chart, X.detectProduct(r), r.tables[chart.rawIndex]);
    assert.deepStrictEqual(review.columns.map((c) => c.dim), ['bodyLength', 'shoulderWidth', 'chestWidth', 'sleeveLength']);
    assert.deepStrictEqual(review.rows.map((row) => row.size), SIZES);
    review.columns.forEach((col) => {
      assert.deepStrictEqual(review.rows.map((row) => row.cells[col.index].value), SHOWN[col.dim], col.header);
      review.rows.forEach((row) => assert.strictEqual(row.cells[col.index].problem, null, `${row.size} ${col.header}`));
    });
  });

  await test('the methods the headings state, and only those: length and sleeve from the centre back, shoulders seam to seam (kept apart from broadest), chest unresolved', () => {
    const r = raw('product');
    const chart = X.charts(r).list[0];
    const review = X.startReview(chart, X.detectProduct(r), r.tables[chart.rawIndex]);
    const methods = Object.fromEntries(review.columns.map((c) => [c.dim, c.method]));
    assert.deepStrictEqual(methods, {
      bodyLength: 'center-back-to-hem',
      shoulderWidth: 'seam-to-seam',
      chestWidth: null,
      sleeveLength: 'center-back-to-cuff'
    });
    assert.ok(review.columns.every((c) => !c.nearby), 'each stated method is the chart’s own heading, not nearby text');
    /* "Chest" alone could be flat or around: the linked How-to-Measure page isn't this chart, and isn't read */
    assert.ok(X.reviewProblems(review, 'hoodies').some((p) => /chest width/.test(p)), 'the shopper is asked how the chest is measured');
  });

  await test('the unit is left unresolved: the drawer offers both CM and IN as a choice, and collect.js reads no form control — the shopper is asked', () => {
    const r = raw('product');
    const chart = X.charts(r).list[0];
    assert.strictEqual(chart.unit, null);
    const review = X.startReview(chart, X.detectProduct(r), r.tables[chart.rawIndex]);
    assert.strictEqual(review.unit, null);
    assert.ok(X.reviewProblems(review, 'hoodies').includes('Say whether the chart is in centimetres or inches.'));
  });

  await test('“the actual measurements of the product” is text above the table, not the chart itself: kept as a claim the shopper confirms, and the reading is never automatic', () => {
    const r = raw('product');
    const chart = X.charts(r).list[0];
    const review = X.startReview(chart, X.detectProduct(r), r.tables[chart.rawIndex]);
    assert.strictEqual(review.measuresConfirmed, false);
    assert.strictEqual(review.nearbyMeasures, true);
    assert.strictEqual(X.isAutomatic(review), false);
  });

  await test('the Body Size drawer: read as a body chart, never a garment one — no garment measurement, nothing to send, and the server refuses it', async () => {
    const r = raw('body');
    const c = X.charts(r);
    assert.strictEqual(c.list.length, 1);
    assert.strictEqual(c.list[0].measures, 'body', 'the drawer says “body size measurements”');
    const review = X.startReview(c.list[0], X.detectProduct(r), r.tables[c.list[0].rawIndex]);
    assert.ok(review.columns.every((col) => col.dim === null), 'a body chart maps to no garment measurement');
    assert.ok(X.reviewProblems(review, 'hoodies').some((p) => /measures the body, not the garment/.test(p)));
    const sent = X.buildChart(review, X.detectProduct(r), 'hoodies');
    assert.strictEqual(sent.measures, 'body');
    assert.deepStrictEqual(sent.sizes, []);
    const got = await compare({ chart: Object.assign(sent, { unit: 'in' }), reference: REFERENCE });
    assert.deepStrictEqual([got.status, got.body.reason], [400, 'body-measurements']);
  });

  await test('the two tabs are told apart: the same drawer, Product Size read as the garment, Body Size as the body', () => {
    assert.deepStrictEqual([X.charts(raw('product')).list[0].measures, X.charts(raw('body')).list[0].measures], ['finished-garment', 'body']);
  });

  await test('the garment chart, once the shopper answers what the page leaves open, compares on Fynd’s engine with a controlled reference: chest, length and sleeve; the seam-to-seam shoulder is skipped, construction unknown', async () => {
    const r = raw('product');
    const product = X.detectProduct(r);
    const chart = X.charts(r).list[0];
    const review = X.startReview(chart, product, r.tables[chart.rawIndex]);
    /* the shopper's own answers in the panel, not the page's: the unit, that these are the garment's own
       measurements, and how the chest is measured */
    review.unit = 'in';
    review.measuresConfirmed = true;
    review.columns.find((c) => c.dim === 'chestWidth').method = 'flat-width-armpit-to-armpit';
    review.checked = true;
    assert.deepStrictEqual(X.reviewProblems(review, 'hoodies'), []);
    const sent = X.buildChart(review, product, 'hoodies');
    assert.strictEqual(sent.sizes.length, 8);
    assert.ok(sent.sizes.every((s) => Object.values(s.provenance).every((p) => p.source === 'page-table' && p.corrected === false)));
    const before = sizing.all().map((rec) => rec.id);
    const got = await compare({ chart: sent, reference: REFERENCE });
    assert.strictEqual(got.status, 200, JSON.stringify(got.body));
    assert.deepStrictEqual([got.body.decision.outcome, got.body.decision.size], ['OK', 'L']);
    const dims = Object.fromEntries(got.body.decision.dimensions.map((d) => [d.dim, d.status]));
    ['chestWidth', 'bodyLength', 'sleeveLength'].forEach((d) => assert.strictEqual(dims[d], 'compatible', `${d}: ${dims[d]}`));
    assert.notStrictEqual(dims.shoulderWidth, 'compatible', 'a seam-to-seam shoulder is never compared without both garments’ construction');
    const shoulder = got.body.decision.dimensions.find((d) => d.dim === 'shoulderWidth');
    assert.ok(/aren.t known to be attached the same way/.test(shoulder.message), shoulder.message);
    assert.strictEqual(got.body.comparison.dataStatus, 'shopper-entered');
    /* session-specific: nothing joins Fynd's catalogue, and nothing is verified */
    assert.deepStrictEqual(sizing.all().map((rec) => rec.id), before);
    assert.ok(!sizing.all().some((rec) => sizingSchema.isVerified(rec)));
    assert.ok(!JSON.stringify(got.body).includes('"status":"verified"'));
  });

  out(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
})().catch((err) => { out(`\n${String(err && err.stack || err)}\n${passed} passed, ${failures.length + 1} failed\n`); process.exit(1); });
