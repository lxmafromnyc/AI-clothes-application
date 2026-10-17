#!/usr/bin/env node
/* =========================================================
   Fynd — the browser extension, without a browser

     node scripts/test-extension.js

   What the extension may do (its manifest), that its copies of the
   shared sizing code are the site's own, and the chart payload it hands
   to Find Fit: how tables are chosen, what a payload may hold, what is
   refused, and that a chart from the browser is never verified or
   comparable. The extension itself, loaded in Chromium against fixture
   pages, is test-extension-browser's.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const EXT = path.join(REPO, 'extension');
const Tables = require('../assets/sizing-tables');
const Payload = require('../assets/fynd-payload');
const { SHARED } = require('./sync-extension');

let passed = 0;
const failures = [];
const out = (s) => process.stdout.write(s);
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    out(`  ok    ${name}\n`);
  } catch (err) {
    failures.push(name);
    out(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}\n`);
  }
}
const section = (name) => out(`\n${name}\n`);

/* what fyndCollect returns, in the shapes pages take */
const garmentTable = { rows: [['Size', 'Chest width', 'Body length'], ['S', '51', '70'], ['M', '54', '72']], before: 'Garment measurements, laid flat (cm)', heading: 'Garment measurements, laid flat (cm)', caption: '', visible: true, inDialog: false };
const bodyTable = { rows: [['Size', 'Chest', 'Waist'], ['S', '34 ¾ - 37 ¾', '28 - 31'], ['M', '37 ¾ - 41', '31 - 34']], before: 'Size guide Body measurements in inches.', heading: 'Size guide', caption: 'Tops — body size', visible: true, inDialog: true };
const shipping = { rows: [['Region', 'Days'], ['US', '3-5'], ['EU', '5-8']], before: 'Delivery', visible: true, inDialog: false };
const raw = (tables, extra) => Object.assign({
  url: 'https://shop.example.test/products/tee?utm_source=mail&colour=black#reviews',
  canonical: null,
  title: 'Illustrative Tee | Illustrative Shop',
  retailer: 'Illustrative Shop',
  product: { name: 'Illustrative Tee', brand: 'Illustrative Brand', code: 'FIX-1', sizes: ['S', 'M'] },
  fit: 'Relaxed',
  tables,
  guides: []
}, extra || {});

(async () => {
  section('what the extension may do');

  await test('Manifest V3, with only activeTab and scripting: no host access, no content scripts, no background page', () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    assert.strictEqual(m.manifest_version, 3);
    assert.deepStrictEqual(m.permissions, ['activeTab', 'scripting']);
    for (const key of ['host_permissions', 'optional_host_permissions', 'content_scripts', 'background', 'externally_connectable', 'web_accessible_resources']) {
      assert.strictEqual(m[key], undefined, `${key} must not be requested`);
    }
    assert.strictEqual(m.action.default_popup, 'popup.html');
    assert.match(m.content_security_policy.extension_pages, /script-src 'self'/);
    Object.values(m.icons).forEach((f) => assert.ok(fs.existsSync(path.join(EXT, f)), f));
  });

  await test('the popup and the page collector make no request and run nothing they read', () => {
    for (const f of ['popup.js', 'collect.js', 'config.js']) {
      const src = fs.readFileSync(path.join(EXT, f), 'utf8');
      assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|\beval\s*\(|new Function|innerHTML|insertAdjacentHTML|document\.write/.test(src), f);
    }
    const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
    assert.ok(!/<script>(?!<\/script>)|https?:\/\/[^"]*\.js/.test(html), 'only the extension’s own scripts');
  });

  await test('the collector reads no form field and skips any table holding one', () => {
    const src = fs.readFileSync(path.join(EXT, 'collect.js'), 'utf8');
    assert.ok(!/\.value\b/.test(src.replace(/fitProp\.value/g, '')), 'never reads a field’s value (the only .value is a JSON-LD property’s)');
    assert.match(src, /querySelector\('input, select, textarea, button'\)\) continue/);
  });

  await test('the extension’s copies of the shared sizing code are the site’s own', () => {
    SHARED.forEach((name) => assert.strictEqual(fs.readFileSync(path.join(EXT, 'vendor', name), 'utf8'), fs.readFileSync(path.join(REPO, 'assets', name), 'utf8'),
      `extension/vendor/${name} differs from assets/${name}: run node scripts/sync-extension.js`));
  });

  await test('the collector calls the same links a size guide that the server does', () => {
    const src = fs.readFileSync(path.join(EXT, 'collect.js'), 'utf8');
    const m = /const GUIDE_WORDS = (\/.*\/i);/.exec(src);
    assert.ok(m);
    assert.strictEqual(m[1], String(Tables.GUIDE_WORDS));
  });

  await test('the server reads tables with the same shared code', () => {
    const src = fs.readFileSync(path.join(REPO, 'api/_sizing/chart.js'), 'utf8');
    assert.match(src, /require\('\.\.\/\.\.\/assets\/sizing-tables'\)/);
    assert.ok(!/function sizeTable|function kindOf|function unitOf/.test(src), 'no second copy on the server');
  });

  section('choosing the table');

  await test('one size table among others is the chart; tables that aren’t size tables are never offered', () => {
    const found = Payload.candidates(raw([shipping, garmentTable]));
    assert.strictEqual(found.list.length, 1);
    assert.ok(found.confident);
    assert.deepStrictEqual([found.list[0].chart.measures, found.list[0].chart.unit], ['finished-garment', 'cm']);
  });

  await test('a table in an open size guide outranks one elsewhere; one in view outranks one hidden', () => {
    const inGuide = Payload.candidates(raw([Object.assign({}, garmentTable), bodyTable]));
    assert.ok(inGuide.confident);
    assert.strictEqual(inGuide.list[0].inDialog, true);
    const hidden = Payload.candidates(raw([Object.assign({}, bodyTable, { visible: false, inDialog: false }), garmentTable]));
    assert.ok(hidden.confident);
    assert.strictEqual(hidden.list[0].visible, true);
  });

  await test('two size tables, both in view: not confident — the shopper chooses', () => {
    const pants = { rows: [['Size', 'Waist width', 'Inseam'], ['S', '38', '76'], ['M', '40', '78']], before: 'Pants — garment measurements (cm)', visible: true, inDialog: false };
    const found = Payload.candidates(raw([garmentTable, pants]));
    assert.strictEqual(found.list.length, 2);
    assert.strictEqual(found.confident, false);
  });

  section('the payload');

  await test('a payload keeps the page’s values, units and words; the address loses its tracking and fragment', () => {
    const p = Payload.build(raw([garmentTable]), 0);
    assert.strictEqual(p.page.url, 'https://shop.example.test/products/tee?colour=black');
    assert.deepStrictEqual(p.chart.rows, [{ size: 'S', values: ['51', '70'] }, { size: 'M', values: ['54', '72'] }]);
    assert.deepStrictEqual([p.chart.measures, p.chart.unit, p.chart.where], ['finished-garment', 'cm', 'product-page']);
    assert.deepStrictEqual(Payload.validate(p).payload.chart, p.chart);
    const canonical = Payload.build(raw([garmentTable], { canonical: 'https://shop.example.test/products/tee' }), 0);
    assert.strictEqual(canonical.page.url, 'https://shop.example.test/products/tee');
  });

  await test('encoded for an address fragment and decoded back unchanged, in any script', () => {
    const p = Payload.validate(Payload.build(raw([bodyTable], { product: { name: 'Pull à capuche — 卫衣', brand: 'Marque', code: null, sizes: [] } }), 0)).payload;
    const text = Payload.encode(p);
    assert.match(text, /^[A-Za-z0-9_-]+$/);
    assert.deepStrictEqual(Payload.decode(text).payload, p);
  });

  await test('a chart from the browser is never verified or comparable, and says what it measures', () => {
    const body = Payload.toChart(Payload.build(raw([bodyTable]), 0));
    assert.deepStrictEqual([body.verification, body.comparable, body.from, body.scope], ['not-verified', false, 'browser-extension', 'browser-size-guide']);
    assert.ok(body.note.includes('This is a body-size chart, not the physical dimensions of the garment.'));
    const garment = Payload.toChart(Payload.build(raw([garmentTable]), 0));
    assert.ok(garment.note.includes('Finished-garment measurements are available for chest width and body length only.'));
    assert.strictEqual(garment.comparable, false);
    const unsure = Payload.toChart(Payload.build(raw([{ rows: [['Size', 'Chest', 'Length'], ['S', '100', '70'], ['M', '106', '72']], before: 'Sizes', visible: true }]), 0));
    assert.deepStrictEqual([unsure.charts[0].measures, unsure.charts[0].unit], ['not-stated', null]);
    assert.ok(unsure.note.includes('The table’s measurement type could not be established from the page.'));
    assert.ok(unsure.note.some((n) => /doesn’t state the unit/.test(n)));
  });

  await test('no table: sizes alone are labels only; a size-guide link that isn’t open says to open it; nothing is invented', () => {
    const labels = Payload.toChart(Payload.build(raw([]), null));
    assert.deepStrictEqual([labels.status, labels.charts], ['labels-only', []]);
    const closed = Payload.toChart(Payload.build(raw([], { product: { name: 'X', sizes: [] }, guides: [{ url: 'https://shop.example.test/size-chart', text: 'Size chart' }] }), null));
    assert.deepStrictEqual([closed.status, closed.reason], ['unavailable', 'guide-not-open']);
    const none = Payload.toChart(Payload.build(raw([], { product: { name: 'X', sizes: [] } }), null));
    assert.deepStrictEqual([none.status, none.reason, none.charts], ['unavailable', 'no-chart', []]);
  });

  await test('malformed or hostile payloads are refused, never repaired', () => {
    const good = Payload.validate(Payload.build(raw([garmentTable]), 0)).payload;
    const variant = (f) => { const p = JSON.parse(JSON.stringify(good)); f(p); return Payload.validate(p); };
    const refused = {
      'another kind': (p) => { p.kind = 'something-else'; },
      'a newer version': (p) => { p.v = 2; },
      'a javascript: page': (p) => { p.page.url = 'javascript:alert(1)'; },
      'a page with credentials': (p) => { p.page.url = 'https://user:pass@shop.example.test/p'; },
      'a data: guide link': (p) => { p.guide = { url: 'data:text/html,hi', text: 'x' }; },
      'a short row': (p) => { p.chart.rows[0].values.pop(); },
      'a row with no number': (p) => { p.chart.rows[0].values = ['n/a', 'none']; },
      'one row': (p) => { p.chart.rows = p.chart.rows.slice(0, 1); },
      'too many columns': (p) => { p.chart.columns = Array(13).fill('Chest'); p.chart.rows.forEach((r) => { r.values = Array(13).fill('1'); }); },
      'a huge cell': (p) => { p.chart.rows[0].values[0] = '1'.repeat(61); },
      'an unknown measurement type': (p) => { p.chart.measures = 'garment'; },
      'an unknown unit': (p) => { p.chart.unit = 'mm'; },
      'a size that is an object': (p) => { p.chart.rows[0].size = { toString: () => 'S' }; },
      'a name that is too long': (p) => { p.product.name = 'x'.repeat(400); },
      'sizes that are not text': (p) => { p.sizes = [{}]; }
    };
    Object.entries(refused).forEach(([why, f]) => assert.ok(variant(f).error, why));
    assert.ok(Payload.validate(null).error);
    assert.ok(Payload.validate([]).error);
    const extra = variant((p) => { p.verification = 'verified'; p.comparable = true; p.chart.extra = '<script>'; });
    assert.ok(!('verification' in extra.payload) && !('extra' in extra.payload.chart), 'unknown fields are dropped');
    assert.strictEqual(Payload.toChart(extra.payload).verification, 'not-verified', 'a payload cannot make itself verified');
  });

  await test('a fragment that isn’t a payload is refused: bad base64, bad JSON, bad UTF-8, too long', () => {
    for (const bad of ['', 'not base64!', Buffer.from('{"v":1').toString('base64url'), Buffer.from([0xff, 0xfe, 0x7b]).toString('base64url'), 'A'.repeat(Payload.MAX_ENCODED + 1)]) {
      assert.ok(Payload.decode(bad).error, JSON.stringify(bad.slice(0, 20)));
    }
  });

  await test('text is folded and bounded; control characters never survive', () => {
    const p = Payload.build(raw([garmentTable], { title: 'A\u0000B\u2028C   D', product: { name: `  ${'n'.repeat(500)}  `, sizes: [] } }), 0);
    assert.strictEqual(p.page.title, 'A B C D');
    assert.strictEqual(p.product.name.length, 160);
  });

  out(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
