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

  await test('Manifest V3 with only what the Fit panel needs: Fynd’s own API the one host, no content scripts, a background worker that only opens the panel', () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    assert.strictEqual(m.manifest_version, 3);
    /* activeTab + scripting: read a page only after the toolbar press;
       sidePanel: the Fit panel; storage: the tab pressed on, this session only */
    assert.deepStrictEqual(m.permissions, ['activeTab', 'scripting', 'sidePanel', 'storage']);
    /* one host at install: Fynd's own API, for the saved garments and the comparison — no shop's */
    assert.deepStrictEqual(m.host_permissions, ['https://ai-clothes-application.vercel.app/*']);
    assert.strictEqual(m.optional_host_permissions, undefined, 'no site is ever asked for: a page is read only on a toolbar press');
    assert.strictEqual(m.optional_permissions, undefined);
    /* the key pins the extension's ID, the one origin api/_cors.js lets in */
    const crypto = require('crypto');
    const id = crypto.createHash('sha256').update(Buffer.from(m.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
    assert.deepStrictEqual(require('../api/_cors').EXTENSION_ORIGINS, [`chrome-extension://${id}`]);
    const config = fs.readFileSync(path.join(EXT, 'config.js'), 'utf8');
    assert.match(config, /const FYND_API = FYND_SITE;/);
    assert.match(config, /const FYND_SITE = 'https:\/\/ai-clothes-application\.vercel\.app';/, 'the API the manifest grants, and no other');
    for (const key of ['content_scripts', 'externally_connectable', 'web_accessible_resources']) {
      assert.strictEqual(m[key], undefined, `${key} must not be requested`);
    }
    assert.ok(!m.permissions.includes('tabs') && !m.permissions.includes('history') && !m.permissions.includes('<all_urls>'));
    /* the toolbar button opens the panel (background.js), not a popup */
    assert.strictEqual(m.action.default_popup, undefined);
    assert.deepStrictEqual(m.background, { service_worker: 'background.js' });
    assert.strictEqual(m.side_panel.default_path, 'sidepanel.html');
    assert.match(m.content_security_policy.extension_pages, /script-src 'self'/);
    Object.values(m.icons).forEach((f) => assert.ok(fs.existsSync(path.join(EXT, f)), f));
    const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|executeScript|storage\.local|permissions\.request/.test(bg), 'the worker reads nothing and fetches nothing');
    /* sidePanel.open is the first thing in the click, before any await */
    assert.match(bg, /onClicked\.addListener\(\(tab\) => \{\s*const opening = chrome\.sidePanel\.open\(/);
  });

  await test('the popup and the page collector make no request and run nothing they read', () => {
    for (const f of ['popup.js', 'collect.js', 'config.js', 'retailers.js']) {
      const src = fs.readFileSync(path.join(EXT, f), 'utf8');
      assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|\beval\s*\(|new Function|innerHTML|insertAdjacentHTML|document\.write/.test(src), f);
    }
    for (const page of ['popup.html', 'sidepanel.html']) {
      const html = fs.readFileSync(path.join(EXT, page), 'utf8');
      assert.ok(!/<script>(?!<\/script>)|https?:\/\/[^"]*\.js/.test(html), `${page}: only the extension’s own scripts`);
    }
  });

  await test('the Fit panel: its one route to the network is api.js, to Fynd’s API alone; no storage but the session; nothing it reads is run', () => {
    const src = fs.readFileSync(path.join(EXT, 'sidepanel.js'), 'utf8');
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|\beval\s*\(|new Function|innerHTML|insertAdjacentHTML|document\.write/.test(src));
    assert.ok(!/storage\.sync|storage\.local|localStorage|sessionStorage|indexedDB|document\.cookie/.test(src), 'nothing kept on the device: the shopper’s garments stay on their Fynd profile');
    assert.ok(!/permissions\.request/.test(src), 'no site access asked for');
    /* api.js: the only fetch in the extension, to FYND_API, two existing endpoints */
    const api = fs.readFileSync(path.join(EXT, 'api.js'), 'utf8');
    assert.strictEqual((api.match(/\bfetchFn\(/g) || []).length, 1);
    assert.match(api, /fetchFn\(`\$\{base\}\$\{path\}`/);
    assert.deepStrictEqual((api.match(/request\('([^']+)'/g) || []).map((x) => x.slice(9, -1)), ['/api/fit-profile', '/api/size-recommendation?compare=1&candidate=1', '/api/size-recommendation?parse=1', '/api/size-recommendation?metrics=1']);
    /* the AI-assisted reading goes through Fynd's server: no model, provider or key in the extension */
    for (const f of fs.readdirSync(EXT).filter((x) => /\.(js|json|html)$/.test(x))) {
      assert.ok(!/generativelanguage|googleapis|openai\.com|anthropic\.com|GEMINI|api[_-]?key/i.test(fs.readFileSync(path.join(EXT, f), 'utf8')), `${f} names no model provider or key`);
    }
    assert.ok(!/\beval\s*\(|new Function|innerHTML/.test(api));
    for (const f of fs.readdirSync(EXT).filter((x) => x.endsWith('.js') && x !== 'api.js')) {
      assert.ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/.test(fs.readFileSync(path.join(EXT, f), 'utf8')), `${f} makes no request`);
    }
    /* the panel's families are the engine's own (a hint only: the server decides) */
    const family = /const FAMILY = (\{[^}]+\});/.exec(src)[1];
    const engineSrc = fs.readFileSync(path.join(REPO, 'api/_sizing/engine.js'), 'utf8');
    const ef = /const FAMILY = (\{[^}]+\});/.exec(engineSrc);
    assert.ok(ef, 'the engine’s FAMILY');
    const parse = (t) => Function(`return (${t});`)();
    const mine = parse(family);
    const theirs = parse(ef[1]);
    Object.keys(mine).forEach((k) => assert.strictEqual(mine[k], theirs[k], k));
    /* the shared extraction code is the site's own, and no reference data ships in the extension */
    assert.ok(!fs.existsSync(path.join(EXT, 'vendor/fit-reference-data.js')) && !fs.existsSync(path.join(EXT, 'vendor/fit-anchor.js')), 'no second engine, no local references');
    assert.ok(!/fit-anchor|fit-reference-data|FyndAnchor/.test(src + fs.readFileSync(path.join(EXT, 'sidepanel.html'), 'utf8')));
    /* retailer modules: product recognition only */
    const vm = require('vm');
    const sandbox = { URL };
    vm.runInNewContext(`${fs.readFileSync(path.join(EXT, 'retailers.js'), 'utf8')}; this.R = FyndRetailers;`, sandbox);
    const j = (v) => JSON.stringify(v);
    assert.strictEqual(j(sandbox.R.match('https://www.uniqlo.com/us/en/products/E475377-000/00?colorDisplayCode=09').product), j({ code: 'E475377-000', canonical: 'https://www.uniqlo.com/us/en/products/E475377-000/00' }));
    assert.strictEqual(sandbox.R.match('https://www.uniqlo.com/us/en/spl/men').product, null, 'a UNIQLO page that isn’t a product');
    assert.strictEqual(sandbox.R.match('https://www.uniqlo.com.evil.example/us/en/products/E475377-000/00'), null);
    assert.strictEqual(sandbox.R.match('https://www.zara.com/us/en/basic-medium-weight-t-shirt--02-p01887411.html').product.code, '01887411');
    assert.strictEqual(sandbox.R.match('https://www2.hm.com/en_us/productpage.0685816001.html').product.code, '0685816');
    assert.strictEqual(sandbox.R.match('https://www.nike.com/t/sportswear-premium-essentials-mens-t-shirt-KvYyYtT6/IH1121-491').product.code, 'IH1121');
    assert.strictEqual(sandbox.R.match('https://www.nike.com/w/mens-tops-t-shirts').product, null);
    assert.ok(sandbox.R.RETAILERS.every((r) => r.liveChecked === false), 'no module claims live-checked until it is');
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

  /* a tabbed size guide shaped like UNIQLO's: its Body Size tab in view,
     its Product Size tab beside it (FIXTURE values, not UNIQLO's) */
  const bodyTab = { rows: [['Size', 'Chest'], ['S', '34 - 37'], ['M', '37 - 40']], before: 'Body Size The dimensions shown below are body size measurements that correspond with a product’s size. Inches', heading: 'Body Size', tab: 'Body Size', caption: '', visible: true, inDialog: true };
  const productTab = { rows: [['Size', 'Length (back)', 'Shoulder width (seam to seam)', 'Chest', 'Sleeve Length (center back)'], ['S', '26', '19', '22', '33'], ['M', '27', '20', '23', '34']], before: 'Product Size The dimensions shown below are the actual measurements of the product. Inches', heading: 'Product Size', tab: 'Product Size', caption: '', visible: false, inDialog: true };

  await test('a size guide opened on its Body Size tab: the Product Size tab beside it is the chart, clearly', () => {
    const found = Payload.candidates(raw([bodyTab, productTab]));
    assert.deepStrictEqual(found.list.map((c) => [c.tab, c.chart.measures]), [['Product Size', 'finished-garment'], ['Body Size', 'body']]);
    assert.ok(found.confident, 'no question to ask: the garment’s own measurements, from the same guide');
    const p = Payload.build(raw([bodyTab, productTab]), 0);
    assert.deepStrictEqual([p.chart.measures, p.chart.unit, p.chart.title, p.chart.where], ['finished-garment', 'in', 'Product Size', 'size-guide-dialog']);
    assert.deepStrictEqual(p.chart.columns, ['Length (back)', 'Shoulder width (seam to seam)', 'Chest', 'Sleeve Length (center back)'], 'every column as published, “Chest” not renamed');
    /* tab panels outside any dialog are one guide too */
    const onPage = Payload.candidates(raw([Object.assign({}, bodyTab, { inDialog: false }), Object.assign({}, productTab, { inDialog: false })]));
    assert.deepStrictEqual([onPage.list[0].tab, onPage.confident], ['Product Size', true]);
  });

  await test('a “Product Size” tab whose columns are the body is not promoted; nor is a garment table outside the open guide', () => {
    const bodyish = Object.assign({}, productTab, { rows: [['Size', 'Height', 'Chest'], ['S', '165-170', '34-37'], ['M', '170-175', '37-40']], before: 'Product Size' });
    const a = Payload.candidates(raw([bodyTab, bodyish]));
    assert.strictEqual(a.list[0].tab, 'Body Size');
    assert.strictEqual(a.list.find((c) => c.tab === 'Product Size').chart.measures, 'not-stated');
    const elsewhere = Object.assign({}, garmentTable, { visible: false });
    const b = Payload.candidates(raw([bodyTab, elsewhere]));
    assert.deepStrictEqual([b.list[0].chart.measures, b.list[0].inDialog], ['body', true], 'a hidden garment table elsewhere never displaces the open guide');
  });

  await test('two garment tables in one guide: not confident — the shopper chooses', () => {
    const second = Object.assign({}, productTab, { tab: 'Product Size (Tall)', before: 'Product Size (Tall) The dimensions shown below are the actual measurements of the product. Inches' });
    const found = Payload.candidates(raw([bodyTab, productTab, second]));
    assert.strictEqual(found.list[0].chart.measures, 'finished-garment');
    assert.strictEqual(found.confident, false);
  });

  await test('a garment table carries how its columns were measured, in the page’s own words; a body table says the garment’s own are not in it', () => {
    const p = Payload.build(raw([bodyTab, productTab]), 0);
    assert.deepStrictEqual(p.chart.methods, [null, 'seam to seam', null, 'center back']);
    const back = Payload.decode(Payload.encode(p));
    assert.ok(!back.error, back.error);
    const drawn = Payload.toChart(back.payload);
    assert.deepStrictEqual([drawn.charts[0].origin, drawn.charts[0].verification, drawn.charts[0].methods], ['browser-size-guide', 'not-verified', [null, 'seam to seam', null, 'center back']]);
    assert.strictEqual(drawn.productSize, undefined);
    assert.strictEqual(drawn.comparable, false);
    /* methods on a body chart, or not one per column, or not text: refused, never repaired */
    const bad = (f) => { const x = JSON.parse(JSON.stringify(p)); f(x); return Payload.validate(x).error; };
    assert.strictEqual(bad((x) => { x.chart.methods = ['seam to seam']; }), 'bad methods');
    assert.strictEqual(bad((x) => { x.chart.methods[0] = { evil: 1 }; }), 'bad methods');
    assert.strictEqual(bad((x) => { x.chart.measures = 'body'; }), 'bad methods');
    /* only the body tab read: drawn, and said to hold no garment measurements */
    const bodyOnly = Payload.toChart(Payload.build(raw([bodyTab]), 0));
    assert.deepStrictEqual([bodyOnly.charts[0].measures, bodyOnly.productSize.status], ['body', 'not-in-browser']);
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
