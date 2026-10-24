#!/usr/bin/env node
/* =========================================================
   Fynd — Find Fit's comparison states, drawn by the real renderer

     node scripts/test-fit-states.js

   Loads assets/size-chart.js and assets/fit-compare.js into a page with
   nothing else on it, and hands FitCompare.show() — in Find Fit's
   verdict layout — charts built by the server's own code
   (api/_sizing/chart.js fromRecord, fromPage, fromOfficial) and answers
   from the real size engine (api/_sizing/engine.js compare()):

     unsupported      no checked garment measurements for the item
     body-only        only the body each size is cut for
     methods          measurements that can't be matched to the
                      reference, or whose method isn't stated
     closest-mismatch the closest size, missing every tolerance: never
                      called a recommendation
     recommended      an "ok" answer, as before

   and then answers that don't hold together, which must draw no size
   and no figure. Every check is on what the shopper sees and can do:
   the heading, the explanation, which actions are offered, the
   differences and their units, and that nothing from a previous answer
   is left behind.

   Test data: UNIQLO's live records (pending review; marked checked in
   memory where a test needs a checked one) and the ILLUSTRATIVE Everlane
   fixture (scripts/fixtures/cross-brand.js: stand-in numbers, never
   Everlane's). Nothing here touches production records.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — skipping Find Fit state tests.');
  process.exit(0);
}

const Schema = require('../assets/fit-profile-schema.js');
const sizing = require('../api/_sizing/records');
const engine = require('../api/_sizing/engine');
const chartOf = require('../api/_sizing/chart');
const official = require('../api/_sizing/official-charts');
const { asChecked, UQ_PAIR } = require('./fixtures/as-checked');
const X = require('./fixtures/cross-brand');

const IF_STATED = { chestWidth: 'garment-circumference', bodyLength: 'center-back-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };
const clone = (v) => JSON.parse(JSON.stringify(v));

/* ---------- the charts and answers, from the server's own code ---------- */

const reference = (kind, anchor) => {
  const p = Schema.empty();
  p.garments[kind] = Object.assign(Schema.emptyGarment(kind), { favorite: 'perfect', line: 'men', anchor });
  return p;
};
const uniqloRef = (size) => reference('sweatshirts', { brand: 'UNIQLO', size, product: { name: null, url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } });
const everlane = (sizes, methods) => X.asCheckedCopy(X.everlaneRecord(X.everlanePublished(Object.assign({}, X.EVERLANE_PUBLISHED, { sizes })), methods));
const base = X.EVERLANE_PUBLISHED.sizes;

const C = {};
asChecked(UQ_PAIR, () => X.withFixtureBrand(() => {
  const hoodie = sizing.byId(X.UQ_HOODIE);
  C.checkedChart = clone(chartOf.fromRecord(hoodie));
  /* UNIQLO S beside UNIQLO's hoodie: every difference a real zero */
  C.ok = clone(engine.compare(uniqloRef('S'), hoodie));
  C.okCm = clone(engine.compare(uniqloRef('S'), hoodie, { unit: 'cm' }));
  C.closest = clone(engine.compare(uniqloRef('M'), everlane(base, IF_STATED)));
  C.closestCm = clone(engine.compare(uniqloRef('M'), everlane(base, IF_STATED), { unit: 'cm' }));
  C.tradeoff = clone(engine.compare(uniqloRef('M'), everlane(Object.assign({}, base, { S: Object.assign({}, base.S, { chest_circumference: '43' }) }), IF_STATED)));
  C.methods = clone(engine.compare(uniqloRef('M'), everlane(base)));
  const bodyOnly = clone(hoodie);
  delete bodyOnly.charts.garment;
  C.bodyAnswer = clone(engine.compare(uniqloRef('M'), bodyOnly));
  C.noReference = clone(engine.compare(Schema.empty(), hoodie));
}));
/* production state: UNIQLO pending review */
C.unverifiedChart = clone(chartOf.fromRecord(sizing.byId(X.UQ_HOODIE)));
C.unverifiedAnswer = clone(engine.compare(uniqloRef('M'), sizing.byId(X.UQ_HOODIE)));
C.noRecord = clone(engine.compare(uniqloRef('M'), null));
/* a page's own table that doesn't say what it measures */
C.notStatedChart = clone(chartOf.fromPage('<html><head><title>Tee</title></head><body><h1>Tee</h1><table><tr><th>Size</th><th>Chest</th><th>Length</th></tr><tr><td>S</td><td>20</td><td>27</td></tr><tr><td>M</td><td>21</td><td>28</td></tr></table></body></html>', { url: 'https://shop.example.test/p/tee', market: 'US' }));
/* UNIQLO's general body chart, as the fallback for a page that couldn't be read */
const general = official.CHARTS[0];
C.bodyChart = clone(chartOf.fromOfficial({ chart: general, product: general.products[0] }, { url: general.products[0].url }, { status: 'unavailable', reason: 'timeout' }));

/* the shapes these tests rest on, so a change to the engine's answers fails here first */
assert.deepStrictEqual([C.ok.status, C.ok.recommended, C.ok.tradeoffs.length], ['ok', 'S', 0]);
assert.deepStrictEqual([C.closest.status, C.closest.withheld, C.closest.closest], ['partial', 'outside-tolerance', 'S']);
assert.deepStrictEqual([C.tradeoff.status, C.tradeoff.recommended, C.tradeoff.tradeoffs.map((t) => t.dim)], ['ok', 'M', ['bodyLength']]);
assert.deepStrictEqual([C.methods.status, C.methods.missing[0].code], ['insufficient', 'nothing-comparable']);
assert.deepStrictEqual([C.bodyAnswer.status, C.bodyAnswer.missing[0].code], ['insufficient', 'body-chart-only']);
assert.deepStrictEqual([C.noReference.missing[0].code, C.unverifiedAnswer.missing[0].code, C.noRecord.missing[0].code], ['no-reference', 'unverified-data', 'no-record']);
assert.deepStrictEqual([C.checkedChart.comparable, C.unverifiedChart.comparable, C.unverifiedChart.verification], [true, false, 'unverified']);
assert.deepStrictEqual([C.notStatedChart.comparable, C.notStatedChart.charts.map((c) => c.measures)], [false, ['not-stated']]);
assert.deepStrictEqual([C.bodyChart.comparable, C.bodyChart.charts.map((c) => c.measures)], [false, ['body']]);

/* ---------- a page with only the renderer on it ---------- */

const HARNESS = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/assets/styles.css"></head><body>
<main class="ff"><section class="container"><div class="fit-result-card"><div class="fit-compare ff-verdict" id="fit-compare" aria-live="polite" hidden></div></div></section></main>
<script>
  /* the shopper's session, as Account gives it — answers set by each test */
  window.__answer = null;
  window.Account = { state: () => ({ signedIn: window.__signedIn !== false }), load: async () => {}, sizing: { compare: async () => window.__answer } };
</script>
<script src="/assets/size-chart.js"></script>
<script src="/assets/fit-compare.js"></script>
</body></html>`;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/harness.html') { res.setHeader('Content-Type', 'text/html'); return res.end(HARNESS); }
  const f = path.join(REPO, url.pathname);
  if (!f.startsWith(path.join(REPO, 'assets')) || !fs.existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
  return res.end(fs.readFileSync(f));
});

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message.split('\n').slice(0, 14).join('\n        ') : err}`); }
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  } catch (err) {
    console.log('Chromium could not launch here — skipping Find Fit state tests.');
    server.close();
    process.exit(0);
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(8000);
  await context.route((u) => !String(u).startsWith(origin), (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${origin}/harness.html`);

  /* draw one answer, as Find Fit does: the chart, then the engine's
     comparison as the server would send it ({ ok, data: { comparison } }) */
  const show = (chart, got, opts) => page.evaluate(async ({ chart, got, signedIn }) => {
    window.__answer = got;
    window.__signedIn = signedIn;
    await window.FitCompare.show(chart, document.getElementById('fit-compare'), null, { verdict: true });
  }, { chart, got: got === undefined ? null : got, signedIn: !(opts && opts.signedOut) });
  const answer = (comparison) => ({ ok: true, status: 200, data: { comparison } });
  /* what the shopper sees: heading, text, actions, and the state named */
  const seen = () => page.evaluate(() => {
    const box = document.getElementById('fit-compare');
    return {
      verdict: box.dataset.verdict || null,
      hidden: box.hidden,
      heading: box.querySelector('.fit-compare-title') ? box.querySelector('.fit-compare-title').textContent : null,
      text: box.textContent,
      links: [...box.querySelectorAll('a')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') })),
      buttons: box.querySelectorAll('button').length,
      recommended: box.querySelectorAll('.fit-compare-recommended').length,
      closest: box.querySelector('.fit-compare-closest') ? box.querySelector('.fit-compare-closest').textContent : null,
      tradeoffs: [...box.querySelectorAll('.fit-compare-tradeoffs li')].map((li) => ({ dim: li.dataset.dim, difference: Number(li.dataset.difference), text: li.textContent })),
      notCompared: [...box.querySelectorAll('.fit-compare-not-compared li')].map((li) => ({ dim: li.dataset.dim, text: li.textContent })),
      differences: [...box.querySelectorAll('.fit-compare-differences tbody tr')].map((tr) => ({ dim: tr.dataset.dim, value: Number(tr.children[1].dataset.difference), shown: tr.children[1].textContent })),
      scale: [...box.querySelectorAll('.ff-scale-row')].map((l) => [l.dataset.dim, l.dataset.place]),
      sources: box.querySelector('.ff-sources') ? box.querySelector('.ff-sources').textContent : null,
      elements: box.querySelectorAll('*').length
    };
  });
  /* never a size called recommended, and no figure */
  const noSize = (s) => {
    assert.strictEqual(s.recommended, 0, 'no recommended size');
    assert.ok(!/Recommended size/.test(s.text), s.text);
    assert.strictEqual(s.differences.length, 0, 'no differences');
    assert.strictEqual(s.scale.length, 0, 'no fit scale');
  };

  console.log('\nnothing to compare: the four reasons, each with only its own action');

  await test('unsupported — a Fynd record not yet checked: says so, what would change it, and offers no fit-profile action (the profile can\'t change it)', async () => {
    await show(C.unverifiedChart);
    const s = await seen();
    assert.strictEqual(s.verdict, 'unsupported');
    assert.strictEqual(s.heading, 'Fynd can’t compare this item yet');
    assert.match(s.text, /haven’t been checked against the brand yet/);
    assert.match(s.text, /What would change that: a person checking this chart/);
    assert.deepStrictEqual([s.links, s.buttons], [[], 0], 'no action offered');
    noSize(s);
  });

  await test('unsupported — the engine refuses an unchecked product, or has no record: the same state, its own reason, no action', async () => {
    for (const c of [C.unverifiedAnswer, C.noRecord]) {
      await show(C.checkedChart, answer(c));
      const s = await seen();
      assert.strictEqual(s.verdict, 'unsupported', c.missing[0].code);
      assert.strictEqual(s.heading, 'Fynd can’t compare this item yet');
      assert.ok(s.text.includes(c.missing[0].message), 'the engine\'s own reason');
      assert.deepStrictEqual(s.links, []);
      noSize(s);
    }
  });

  await test('body-only — a general body chart (fallback) and a record with no garment chart: says it describes bodies, offers nothing to do', async () => {
    await show(C.bodyChart);
    let s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading], ['body-only', 'Only body measurements for this item']);
    assert.match(s.text, /describes bodies, not garments/);
    assert.match(s.text, /What would change that: the brand publishing what the garment itself measures/);
    assert.deepStrictEqual(s.links, []);
    noSize(s);
    await show(C.checkedChart, answer(C.bodyAnswer));
    s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading], ['body-only', 'Only body measurements for this item']);
    assert.match(s.text, /publishes who each size is cut for, not what the garment itself measures/);
    assert.deepStrictEqual(s.links, []);
    noSize(s);
  });

  await test('methods — a page table that doesn\'t say what it measures: unknown method, said; no action', async () => {
    await show(C.notStatedChart);
    const s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading], ['methods', 'These measurements can’t be matched to your reference']);
    assert.match(s.text, /doesn’t say whether these measure the body or the garment, or how each was taken/);
    assert.deepStrictEqual(s.links, []);
    noSize(s);
  });

  await test('methods — the engine finds nothing measured the same way: each measurement and why, and the one action that can help (the reference\'s measurements)', async () => {
    await show(C.checkedChart, answer(C.methods));
    const s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading], ['methods', 'These measurements can’t be matched to your reference']);
    assert.deepStrictEqual(s.notCompared.map((x) => x.dim), ['chestWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth']);
    assert.ok(s.notCompared.every((x) => /Everlane doesn't say how its/.test(x.text)), JSON.stringify(s.notCompared));
    assert.deepStrictEqual(s.links, [{ text: 'Check your reference’s measurements', href: 'fit-profile.html?from=find-fit' }]);
    noSize(s);
  });

  await test('no reference saved: the engine\'s reason and the one action that fixes it', async () => {
    await show(C.checkedChart, answer(C.noReference));
    const s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading], ['needs-reference', 'Add a garment that fits to compare']);
    assert.match(s.text, /Save a hoodie that fits you well/);
    assert.deepStrictEqual(s.links, [{ text: 'Add a garment on your fit profile', href: 'fit-profile.html?from=find-fit' }]);
    noSize(s);
  });

  console.log('\na closest size, and a recommendation');

  await test('closest-mismatch — the closest size is named, never recommended; why, each miss with its tolerance, and the signed differences in inches', async () => {
    await show(C.checkedChart, answer(C.closest));
    const s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading], ['closest-mismatch', 'No size matches your reference']);
    assert.strictEqual(s.recommended, 0);
    assert.ok(!/Recommended size/.test(s.text));
    assert.match(s.closest, /^Closest size:\s*S\s*— not a recommendation$/);
    assert.deepStrictEqual(s.tradeoffs.map((t) => [t.dim, t.difference]), C.closest.tradeoffs.map((t) => [t.dim, t.difference]), 'the engine\'s own misses');
    s.tradeoffs.forEach((t) => assert.match(t.text, /— Fynd treats up to [\d¼½¾]+ in as similar$/));
    const row = C.closest.sizes.find((x) => x.size === 'S');
    assert.deepStrictEqual(s.differences.map((d) => [d.dim, d.value]), C.closest.dimensionsCompared.map((d) => [d, row.dimensions[d].difference]));
    assert.deepStrictEqual(s.differences.map((d) => d.shown), ['−2.5 in', '+1.8 in', '−1.0 in']);
    assert.deepStrictEqual(s.links.map((l) => l.href), ['compare.html'], 'only the way to see every size');
  });

  await test('closest-mismatch in centimetres: differences and tolerances in cm, the engine\'s own conversions', async () => {
    await show(C.checkedChart, answer(C.closestCm));
    const s = await seen();
    assert.strictEqual(s.verdict, 'closest-mismatch');
    assert.ok(s.tradeoffs.every((t) => / cm as similar$/.test(t.text) && / cm (narrower|longer|wider|shorter) /.test(t.text)), JSON.stringify(s.tradeoffs));
    assert.deepStrictEqual(s.differences.map((d) => d.value), C.closestCm.tradeoffs.map((t) => t.difference));
    assert.ok(s.differences.every((d) => / cm$/.test(d.shown)));
  });

  await test('recommended, with a trade-off: the size, the length it misses named — and the scale agreeing', async () => {
    await show(C.checkedChart, answer(C.tradeoff));
    const s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading, s.recommended], ['recommended', 'Compared with your reference', 1]);
    assert.match(s.text, /Recommended size:\s*M/);
    assert.deepStrictEqual(s.tradeoffs.map((t) => t.dim), ['bodyLength']);
    assert.deepStrictEqual(s.scale, [['chestWidth', 'same'], ['bodyLength', 'more'], ['shoulderWidth', 'same']]);
  });

  await test('an "ok" answer with every difference a real zero: "0.0 in", "the same", all similar — and the sources as the record says', async () => {
    await show(C.checkedChart, answer(C.ok));
    let s = await seen();
    assert.deepStrictEqual([s.verdict, s.recommended, s.tradeoffs.length, s.closest], ['recommended', 1, 0, null]);
    assert.deepStrictEqual(s.differences.map((d) => [d.value, d.shown]), [[0, '0.0 in'], [0, '0.0 in'], [0, '0.0 in'], [0, '0.0 in']]);
    assert.ok(s.scale.length === 4 && s.scale.every(([, p]) => p === 'same'));
    assert.match(s.text, /chest width the same as your reference/);
    /* the record's own origin: UNIQLO's published table, checked (in memory, for this test) */
    assert.strictEqual(s.sources, 'Sources: UNIQLO’s published finished-garment measurements for this item, checked against the brand’s page; your reference’s published measurements (UNIQLO).');
    await show(C.checkedChart, answer(C.okCm));
    s = await seen();
    assert.deepStrictEqual(s.differences.map((d) => d.shown), ['0.0 cm', '0.0 cm', '0.0 cm', '0.0 cm']);
  });

  await test('the sources follow each measurement\'s recorded origin: measured from the garment is said only where the record says so, and nothing claims a check that didn\'t happen', async () => {
    const hand = clone(C.ok);
    hand.sizes.forEach((r) => Object.values(r.dimensions).forEach((x) => { if (x.measurement) x.measurement.source.origin = 'physical-measurement'; }));
    await show(C.checkedChart, answer(hand));
    let s = await seen();
    assert.match(s.sources, /^Sources: UNIQLO’s finished-garment measurements taken from the garment itself for this item, checked against its sources;/);
    const unchecked = Object.assign(clone(C.ok), { dataStatus: 'unverified' });
    await show(C.checkedChart, answer(unchecked));
    s = await seen();
    assert.match(s.sources, /, not yet checked;/);
    assert.ok(!/checked against the brand/.test(s.sources));
  });

  console.log('\nchanging the answer, and answers that don\'t hold together');

  await test('each new answer replaces the last whole: no trade-off, closest size, list or action from before is left', async () => {
    await show(C.checkedChart, answer(C.closest));
    await show(C.checkedChart, answer(C.methods));
    let s = await seen();
    assert.strictEqual(s.verdict, 'methods');
    assert.deepStrictEqual([s.closest, s.tradeoffs.length, s.differences.length], [null, 0, 0]);
    await show(C.unverifiedChart);
    s = await seen();
    assert.strictEqual(s.verdict, 'unsupported');
    assert.deepStrictEqual([s.notCompared.length, s.links.length], [0, 0], 'the previous list and action are gone');
    await show(C.checkedChart, answer(C.ok));
    s = await seen();
    assert.deepStrictEqual([s.verdict, s.recommended, s.notCompared.length], ['recommended', 1, 0]);
    assert.ok(!/Fynd can’t compare/.test(s.text));
    await show(C.checkedChart, answer(C.closest));
    s = await seen();
    assert.deepStrictEqual([s.verdict, s.recommended], ['closest-mismatch', 0], 'the recommendation from before is gone');
  });

  await test('malformed answers draw no size and no figure, only that it couldn\'t be worked out — and the page throws nothing', async () => {
    const broken = [
      null,
      { ok: false, status: 500, data: null },
      answer(null),
      answer('ok'),
      answer({ status: 'ok' }),
      answer({ status: 'wonderful', recommended: 'M' }),
      answer(Object.assign(clone(C.ok), { recommended: 'XXXXL' })),
      answer(Object.assign(clone(C.ok), { recommended: { size: 'M' } })),
      answer(Object.assign(clone(C.ok), { unit: 'ft' })),
      answer(Object.assign(clone(C.ok), { sizes: null })),
      answer(Object.assign(clone(C.ok), { sizes: [null] })),
      answer(Object.assign(clone(C.ok), { reference: null })),
      answer(Object.assign(clone(C.closest), { tradeoffs: 'chest' })),
      answer(Object.assign(clone(C.closest), { closest: 7 })),
      answer(Object.assign(clone(C.ok), { summary: undefined }))
    ];
    for (const got of broken) {
      await show(C.checkedChart, got);
      const s = await seen();
      assert.strictEqual(s.verdict, 'error', JSON.stringify(got).slice(0, 120));
      assert.match(s.text, /couldn’t be worked out just now, so no size is shown/);
      noSize(s);
      assert.strictEqual(s.closest, null);
    }
    assert.deepStrictEqual(errors, []);
  });

  await test('partly malformed parts are left out, not drawn wrong: an unknown dimension, a missing difference, a trade-off without words', async () => {
    const odd = clone(C.closest);
    odd.dimensionsCompared = odd.dimensionsCompared.concat(['waist']);
    odd.sizes.find((r) => r.size === 'S').dimensions.shoulderWidth.difference = undefined;
    odd.tradeoffs = odd.tradeoffs.concat([{ dim: 'waist', difference: 2, words: 'Waist: 2 in wider' }, { dim: 'chestWidth', difference: 'a lot' }, null]);
    odd.notCompared = [{ dim: 'chestWidth' }, null];
    await show(C.checkedChart, answer(odd));
    const s = await seen();
    assert.strictEqual(s.verdict, 'closest-mismatch');
    assert.deepStrictEqual(s.differences.map((d) => d.dim), ['chestWidth', 'bodyLength'], 'no row for a missing difference or an unknown dimension');
    assert.deepStrictEqual(s.tradeoffs.map((t) => t.dim), ['chestWidth', 'bodyLength', 'shoulderWidth'], 'only the engine\'s well-formed misses');
    assert.ok(!/NaN|undefined|null/.test(s.text), s.text);
    assert.deepStrictEqual(errors, []);
  });

  await test('engine text and names are drawn as text, never markup: a brand, a size and a reason carrying HTML run nothing', async () => {
    const hostile = clone(C.closest);
    const payload = '<img src=x onerror="window.__pwned=1">';
    hostile.product.brand = payload;
    hostile.reference.product.brand = payload;
    hostile.summary = `${payload} summary`;
    hostile.tradeoffs[0].words = `Chest: ${payload}`;
    await show(C.checkedChart, answer(hostile));
    let s = await seen();
    assert.strictEqual(s.verdict, 'closest-mismatch');
    assert.ok(s.text.includes(payload), 'shown as the text it is');
    const methods = clone(C.methods);
    methods.missing[0].message = payload;
    methods.notCompared[0].why = payload;
    methods.next = ['<a href="javascript:alert(1)">fix</a>'];
    await show(C.checkedChart, answer(methods));
    s = await seen();
    const markup = await page.evaluate(() => ({ imgs: document.querySelectorAll('#fit-compare img').length, pwned: window.__pwned || null, hrefs: [...document.querySelectorAll('#fit-compare a')].map((a) => a.getAttribute('href')) }));
    assert.deepStrictEqual(markup, { imgs: 0, pwned: null, hrefs: ['fit-profile.html?from=find-fit'] }, 'only the renderer\'s own local link');
    assert.deepStrictEqual(errors, []);
  });

  console.log('\nkeyboard and signed-out');

  await test('the keyboard reaches the actions and opens the differences', async () => {
    await show(C.checkedChart, answer(C.closest));
    await page.focus('#fit-compare .fit-compare-differences > summary');
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.$eval('#fit-compare .fit-compare-differences', (d) => d.open), true);
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => document.activeElement && document.getElementById('fit-compare').contains(document.activeElement) && document.activeElement.tagName === 'A'), 'the next stop is a link inside the result');
  });

  await test('signed out with a checked chart: no comparison asked for, and the one way to start', async () => {
    await show(C.checkedChart, answer(C.ok), { signedOut: true });
    const s = await seen();
    assert.deepStrictEqual([s.verdict, s.heading], ['sign-in', 'Add a garment that fits to compare']);
    assert.deepStrictEqual(s.links, [{ text: 'your fit profile', href: 'fit-profile.html?from=find-fit' }]);
    noSize(s);
  });

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
