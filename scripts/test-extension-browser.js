#!/usr/bin/env node
/* =========================================================
   Fynd — the browser extension, loaded in Chromium

     node scripts/test-extension-browser.js

   The unpacked extension (extension/) runs in Playwright's Chromium
   against fixture pages served from this machine
   (scripts/fixtures/extension/ — invented pages, each labelled as such;
   none is a real retailer's), and hands its charts to the real Find Fit
   page, served from this repository.

   Chrome grants activeTab only when a person presses the toolbar
   button, which a test can't do. So the suite loads a copy of the
   extension whose manifest also allows this machine's pages
   (http://127.0.0.1/*), opens its popup in a tab with ?tab=<id>, and
   presses "Check sizing with Fynd" there; everything after the grant —
   the collector, the popup, the payload, Find Fit — is the code as
   shipped. A second launch loads the extension exactly as shipped and
   shows that, without a press, it can read nothing.

   Nothing here reaches the network: Find Fit's sizing endpoint is
   answered in-process by api/_sizing/chart.js with a transport that
   refuses every shop.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures/extension');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (err) { chromium = null; }

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'extension-test-secret-of-sufficient-length';
const charts = require('../api/_sizing/chart');
charts.setTransport(async () => { throw new Error('unreachable'); });

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
    out(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n        ')}\n`);
  }
}
const section = (name) => out(`\n${name}\n`);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const apiAsked = [];
function serve() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/size-recommendation') {
      /* Find Fit's wardrobe anchors load on every visit too — Fynd's own
         records, nothing about the shopper or the product: the real
         records' answer, and not counted as a lookup */
      if (u.searchParams.has('anchors')) {
        const records = require('../api/_sizing/records');
        const anchors = records.RECORDS.map(records.summary).filter((r) => r.comparable).map(({ id, brand, name, category, line, region, sizes, url }) => ({ id, brand, name, category, line, region, sizes, url }));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ anchors }));
      }
      /* Find Fit's brand menu and product list load on every visit:
         answered by the real brand modules, and not counted as lookups */
      if (u.searchParams.has('brands') || (u.searchParams.has('brand') && !u.searchParams.has('item'))) {
        const brands = require('../api/_sizing/brands');
        const brand = brands.get(u.searchParams.get('brand'));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(u.searchParams.has('brands') ? { brands: brands.list(), planned: brands.PLANNED } : { brand: { id: brand.id, name: brand.name, coverage: brand.coverage }, products: brand.products() }));
      }
      apiAsked.push(u.search);
      const chart = await charts.chartFor(u.searchParams.get('chart'), { noCache: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ chart }));
    }
    if (u.pathname.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not here"}'); }
    const base = u.pathname.startsWith('/fixtures/') ? FIXTURES : REPO;
    const rel = u.pathname.startsWith('/fixtures/') ? u.pathname.slice('/fixtures/'.length) : u.pathname.slice(1) || 'index.html';
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* the extension as shipped, plus this machine's pages, pointed at this
   machine's Find Fit */
function testCopy(site) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-ext-'));
  fs.cpSync(path.join(REPO, 'extension'), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'config.js'), `const FYND_SITE = '${site}';\n`);
  return dir;
}

async function launch(extDir) {
  const context = await chromium.launchPersistentContext('', {
    executablePath: CHROME,
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`]
  });
  const page = await context.newPage();
  await page.goto('chrome://extensions');
  const id = await page.evaluate(() => new Promise((r) => chrome.management.getAll((all) => r((all.find((x) => x.name.startsWith('Fynd')) || {}).id))));
  await page.close();
  return { context, id };
}

(async () => {
  if (!chromium || !fs.existsSync(CHROME)) {
    console.log('Chromium could not launch here — skipping extension browser tests.');
    return;
  }
  const server = await serve();
  const site = `http://127.0.0.1:${server.address().port}`;
  const extDir = testCopy(site);
  let ext;
  try {
    ext = await launch(extDir);
  } catch (err) {
    console.log(`Chromium could not launch here — skipping extension browser tests. (${err.message})`);
    server.close();
    return;
  }
  const { context, id } = ext;

  /* a fixture in one tab, the popup in another, aimed at the first */
  async function check(fixture, expect) {
    const shop = await context.newPage();
    await shop.goto(fixture.startsWith('chrome') || fixture.startsWith('about') ? fixture : `${site}/fixtures/${fixture}`);
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const target = shop.url();
    const tabId = await popup.evaluate((u) => new Promise((r) => chrome.tabs.query({}, (tabs) => r((tabs.find((t) => t.url === u || t.pendingUrl === u) || {}).id))), target);
    await popup.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
    assert.strictEqual(await popup.textContent('#check'), 'Check sizing with Fynd');
    await popup.click('#check');
    await popup.waitForFunction((states) => states.includes(document.body.dataset.state), expect || ['result', 'choose', 'problem']);
    return { shop, popup };
  }
  const visible = (popup) => popup.innerText('#result');

  section('reading a product page in the browser (fixture pages, not real retailers)');

  await test('one clear table: the chart as published, its unit and type, from this page, unverified', async () => {
    const { shop, popup } = await check('one-table.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'result');
    assert.strictEqual(await popup.textContent('#result-title'), 'Illustrative Brand · Illustrative Garment Tee');
    assert.strictEqual(await popup.getAttribute('#result-product a', 'href'), `${site}/products/garment-tee`, 'the canonical page, without tracking');
    assert.strictEqual(await popup.textContent('#result .size-chart-name'), 'Finished-garment measurements');
    assert.match(await popup.textContent('#result .size-chart-unit'), /centimetres, as published/);
    const rows = await popup.$$eval('#result tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
    assert.deepStrictEqual(rows, [['S', '51', '70'], ['M', '54', '72'], ['L', '57', '74']]);
    assert.strictEqual(await popup.textContent('#result .size-chart-caveat'), 'Read from the product page open in your browser. Not checked by Fynd.');
    const facts = await popup.$$eval('#result-body > .size-chart-facts > *', (ns) => ns.map((n) => n.textContent));
    assert.deepStrictEqual(facts, ['Fit, as the page says', 'Relaxed']);
    await popup.click('#result .size-chart-details summary');
    const details = await popup.innerText('#result .size-chart-details');
    assert.match(details, /Finished-garment measurements are available for chest width and body length only\./);
    assert.match(details, /Not verified — read automatically just now/);
    assert.strictEqual(await popup.isHidden('#other'), true, 'one table: nothing to choose');
    await shop.close();
    await popup.close();
  });

  await test('several tables, one of them a size chart: that one, and only that one', async () => {
    const { shop, popup } = await check('multi-table.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'result');
    assert.strictEqual(await popup.textContent('#result .size-chart-name'), 'Body measurements');
    assert.deepStrictEqual(await popup.$$eval('#result thead th', (ns) => ns.map((n) => n.textContent)), ['Size', 'Chest (in)', 'Waist (in)']);
    assert.ok(!/Region|Wash/.test(await visible(popup)));
    await popup.click('#result .size-chart-details summary');
    assert.match(await popup.innerText('#result .size-chart-details'), /This is a body-size chart, not the physical dimensions of the garment\./);
    await shop.close();
    await popup.close();
  });

  await test('a size guide the shopper opened in a dialog: read from there, labelled as the retailer’s size guide — the hidden table ignored', async () => {
    const { shop, popup } = await check('modal-guide.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'result');
    assert.strictEqual(await popup.textContent('#result .size-chart-kind'), 'Body measurements — the body each size fits, not the garment');
    assert.match(await popup.textContent('#result .size-chart-unit'), /inches, as published/);
    const rows = await popup.$$eval('#result tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
    assert.deepStrictEqual(rows[1], ['M', '37 ¾ - 41', '31 - 34']);
    assert.strictEqual(await popup.textContent('#result .size-chart-caveat'), 'Read from the retailer’s size guide open in your browser — possibly a general chart. Not checked by Fynd.');
    assert.strictEqual(await popup.isVisible('#other'), true, 'the hidden table can still be chosen');
    await shop.close();
    await popup.close();
  });

  await test('no unit and no word for what it measures: shown, marked unknown, never guessed', async () => {
    const { shop, popup } = await check('ambiguous.html');
    assert.strictEqual(await popup.textContent('#result .size-chart-name'), 'Measurements');
    assert.match(await popup.textContent('#result .size-chart-kind'), /^Not stated/);
    assert.match(await popup.textContent('#result .size-chart-unit'), /not stated — check the source/);
    await popup.click('#result .size-chart-details summary');
    assert.match(await popup.innerText('#result .size-chart-details'), /The table’s measurement type could not be established from the page\./);
    await shop.close();
    await popup.close();
  });

  await test('two size charts in view: the shopper chooses; nothing is picked for them', async () => {
    const { shop, popup } = await check('two-charts.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'choose');
    const choices = await popup.$$eval('.pop-choice-name', (ns) => ns.map((n) => n.textContent));
    assert.deepStrictEqual(choices, ['Jacket — garment measurements (cm)', 'Pants — garment measurements (cm)']);
    await popup.click('.pop-choice >> nth=1');
    await popup.waitForFunction(() => document.body.dataset.state === 'result');
    assert.deepStrictEqual(await popup.$$eval('#result thead th', (ns) => ns.map((n) => n.textContent)), ['Size', 'Waist width', 'Inseam']);
    await popup.click('#other-button');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'choose');
    await shop.close();
    await popup.close();
  });

  await test('a body chart and a product-size chart on one page: each labelled by its own heading — the body one never speaks for the garment one', async () => {
    const { shop, popup } = await check('body-and-product.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'choose');
    await popup.click('.pop-choice >> nth=0');
    await popup.waitForFunction(() => document.body.dataset.state === 'result');
    const first = await popup.textContent('#result .size-chart-name');
    await popup.click('#other-button');
    await popup.click('.pop-choice >> nth=1');
    await popup.waitForFunction(() => document.body.dataset.state === 'result');
    const second = await popup.textContent('#result .size-chart-name');
    assert.deepStrictEqual([first, second].sort(), ['Body measurements', 'Finished-garment measurements']);
    const garmentHead = second === 'Finished-garment measurements' ? 1 : 0;
    await popup.click('#other-button');
    await popup.click(`.pop-choice >> nth=${garmentHead}`);
    await popup.waitForFunction(() => document.body.dataset.state === 'result');
    assert.deepStrictEqual(await popup.$$eval('#result thead th', (ns) => ns.map((n) => n.textContent)), ['Size', 'Body length', 'Body width', 'Sleeve length']);
    await shop.close();
    await popup.close();
  });

  await test('a tabbed size guide open on Body Size: its Product Size tab is the chart, each table named by its own tab', async () => {
    const { shop, popup } = await check('tabbed-guide.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'result', 'no question asked: the garment tab of the open guide');
    assert.strictEqual(await popup.textContent('#result .size-chart-name'), 'Finished-garment measurements');
    assert.match(await popup.textContent('#result .size-chart-unit'), /inches, as published/);
    assert.deepStrictEqual(await popup.$$eval('#result thead th', (ns) => ns.map((n) => n.textContent)), ['Size', 'Length (back)', 'Shoulder width (seam to seam)', 'Chest', 'Sleeve Length (center back)']);
    assert.deepStrictEqual(await popup.$$eval('#result tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent))), [['S', '26', '21', '23', '33'], ['M', '27', '22', '24', '34'], ['L', '28', '23', '25', '35']]);
    /* the body tab is still there to choose, saying what it measures */
    await popup.click('#other-button');
    const choices = await popup.$$eval('.pop-choice', (bs) => bs.map((b) => b.innerText.replace(/\s+/g, ' ')));
    assert.strictEqual(choices.length, 2);
    assert.match(choices[0], /^Product Size Garment measurements · 3 sizes/);
    assert.match(choices[1], /^Body Size Body measurements · 3 sizes · Chest · in the open size guide/);
    await shop.close();
    await popup.close();
  });

  await test('a guide that draws only the chosen tab: on Body Size the popup says the garment’s own aren’t there; the shopper picks Product Size, checks again, inspects it, and hands Find Fit only that chart', async () => {
    const { shop, popup } = await check('one-tab-at-a-time.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-state'), 'result');
    assert.strictEqual(await popup.textContent('#result .size-chart-name'), 'Body measurements');
    assert.strictEqual(await popup.textContent('#result .size-chart-missing'), 'Product measurements: none in the table read from your browser. If the retailer’s size guide has a Product Size tab, open it and check again.');
    await popup.close();
    /* the shopper chooses Product Size on the retailer's own page; Fynd clicks nothing */
    await shop.click('#tab-product');
    const again = await context.newPage();
    await again.goto(`chrome-extension://${id}/popup.html`);
    const tabId = await again.evaluate((u) => new Promise((r) => chrome.tabs.query({}, (tabs) => r((tabs.find((t) => t.url === u) || {}).id))), shop.url());
    await again.goto(`chrome-extension://${id}/popup.html?tab=${tabId}`);
    await again.click('#check');
    await again.waitForFunction(() => document.body.dataset.state === 'result');
    /* what was read, to inspect before handing it on: the garment's own table, its tab's words, its units and methods */
    assert.strictEqual(await again.textContent('#result .size-chart-name'), 'Finished-garment measurements');
    assert.strictEqual(await again.$$eval('#result .size-chart-missing', (ns) => ns.length), 0);
    assert.deepStrictEqual(await again.$$eval('#result thead th', (ns) => ns.map((n) => n.textContent)), ['Size', 'Length (back)', 'Shoulder width', 'Chest', 'Sleeve length (center back)']);
    assert.deepStrictEqual(await again.$$eval('#result tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent))),
      [['S', '27', '22 1/2', '23 1/2', '33 1/2'], ['M', '28', '23', '24 1/2', '34 1/2'], ['L', '29 1/2', '24', '26', '35 1/2']]);
    assert.match(await again.textContent('#result .size-chart-unit'), /inches, as published/);
    assert.match(await again.textContent('#result .size-chart-method'), /^How it’s measured, in the page’s words — Sleeve length \(center back\): center back$/);
    assert.strictEqual(await again.getAttribute('#result-product a', 'href'), 'https://shop.example.test/products/FIX-HOOD-8/00', 'tied to the product’s canonical page');
    /* accepted: only the chart travels, in the address fragment, and Find Fit draws it unverified */
    const asked = apiAsked.length;
    const page = await openInFynd(again);
    await page.waitForSelector('#fit-result[data-from="extension"][data-state="ok"]');
    assert.strictEqual(await page.textContent('#fit-result .size-chart-name'), 'Finished-garment measurements');
    assert.match(await page.textContent('#fit-result .size-chart-method'), /center back/);
    /* once step 1 has read the shopper's state — the moment an early check could ask — still nothing sent */
    await page.waitForSelector('#ff-reference[data-state]');
    await page.waitForTimeout(600);
    assert.strictEqual(await page.isHidden('#ff-check'), true, 'no check of a link the extension handed over');
    assert.strictEqual(apiAsked.length, asked, 'nothing was sent to Fynd’s server');
    await page.waitForSelector('#fit-compare:not([hidden])');
    assert.match(await page.textContent('#fit-compare'), /Fynd holds no checked garment measurements for this item/, 'read, not checked: never compared');
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'unsupported');
    await page.close();
    await shop.close();
    await again.close();
  });

  await test('sizes but no measurements: labels only, said plainly', async () => {
    const { shop, popup } = await check('labels-only.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-result'), 'labels-only');
    assert.match(await visible(popup), /Sizes listed: XS, S, M, L, XL — the page gives no measurements\./);
    assert.strictEqual(await popup.$$eval('#result table', (ns) => ns.length), 0);
    await shop.close();
    await popup.close();
  });

  await test('a size-guide link that isn’t open: asks the shopper to open it and check again; no chart', async () => {
    const { shop, popup } = await check('guide-closed.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-result'), 'unavailable');
    assert.strictEqual(await popup.textContent('#result .size-chart-status'), 'No sizing chart found on this page');
    assert.match(await popup.textContent('#result .size-chart-note'), /Open the retailer’s size guide on the page, then check again\./);
    assert.strictEqual(await popup.textContent('#open-fynd'), 'Check Fynd’s catalog');
    await shop.close();
    await popup.close();
  });

  await test('a chart drawn without a table, beside a table that isn’t a size chart: nothing extracted, and why', async () => {
    const { shop, popup } = await check('unsupported.html');
    assert.strictEqual(await popup.getAttribute('body', 'data-result'), 'unavailable');
    assert.strictEqual(await popup.textContent('#result .size-chart-note'), 'The product page doesn’t include a sizing chart Fynd can read.');
    assert.match(await popup.textContent('#result .size-chart-hint'), /If the retailer has a size guide button, open it on the page, then check again\./);
    assert.strictEqual(await popup.$$eval('#result table', (ns) => ns.length), 0);
    await shop.close();
    await popup.close();
  });

  await test('malformed page: broken JSON-LD, a table with a form field, markup and junk in cells — no field read, nothing run, only real rows kept', async () => {
    let dialogs = 0;
    context.on('page', (p) => p.on('dialog', (d) => { dialogs += 1; d.dismiss(); }));
    const { shop, popup } = await check('malformed.html');
    shop.on('dialog', (d) => { dialogs += 1; d.dismiss(); });
    popup.on('dialog', (d) => { dialogs += 1; d.dismiss(); });
    const collected = await popup.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: fyndCollect }))[0].result,
      Number(new URL(popup.url()).searchParams.get('tab')));
    const all = JSON.stringify(collected);
    assert.ok(!/hunter2|4111111111111111|typed-secret/.test(all), 'no field value or typed text is read');
    assert.strictEqual(collected.tables.length, 1, 'the table holding a field is skipped');
    assert.strictEqual(collected.product.name, 'Illustrative Vest', 'broken JSON-LD is passed over');
    const rows = await popup.$$eval('#result tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
    assert.deepStrictEqual(rows, [['S', '36'], ['M', '38']], 'the row with no number and the notes column are left out');
    assert.strictEqual(await popup.$$eval('#result img, #result script', (ns) => ns.length), 0);
    assert.strictEqual(dialogs, 0, 'nothing from the page ran');
    await shop.close();
    await popup.close();
  });

  await test('a page the extension may not read: says so, safely', async () => {
    for (const where of ['chrome://version/', 'about:blank']) {
      const { shop, popup } = await check(where, ['problem']);
      assert.strictEqual(await popup.textContent('#problem-title'), 'Fynd can’t read this page');
      assert.match(await popup.textContent('#problem-text'), /web pages|Chrome doesn’t let extensions read this page/);
      await shop.close();
      await popup.close();
    }
  });

  section('into Find Fit');

  async function openInFynd(popup) {
    const [page] = await Promise.all([context.waitForEvent('page'), popup.click('#open-fynd')]);
    await page.waitForLoadState('domcontentloaded');
    return page;
  }

  await test('"Open in Fynd" shows the same chart on Find Fit, labelled as read in the browser and unverified; the fragment is cleared once read', async () => {
    const { shop, popup } = await check('one-table.html');
    const asked = apiAsked.length;
    const page = await openInFynd(popup);
    await page.waitForSelector('#fit-result[data-from="extension"][data-state="ok"]');
    assert.strictEqual(new URL(page.url()).hash, '', 'the chart is gone from the address');
    assert.strictEqual(await page.textContent('#fit-result-title'), 'Illustrative Brand · Illustrative Garment Tee');
    assert.strictEqual(await page.getAttribute('#fit-result-product a', 'href'), `${site}/products/garment-tee`);
    const rows = await page.$$eval('#fit-result tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
    assert.deepStrictEqual(rows, [['S', '51', '70'], ['M', '54', '72'], ['L', '57', '74']]);
    assert.match(await page.textContent('#fit-result .size-chart-unit'), /centimetres/);
    assert.strictEqual(await page.textContent('#fit-result .size-chart-caveat'), 'Read from the product page open in your browser. Not checked by Fynd.');
    assert.match(await page.textContent('#fit-result .size-chart-details'), /Not verified — read automatically just now/);
    assert.ok(!/Verified —/.test(await page.textContent('#fit-result')));
    /* never compared: read in the browser, checked by nobody */
    await page.waitForSelector('#fit-compare:not([hidden])');
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-title'), 'Fynd can’t compare this item yet');
    assert.match(await page.textContent('#fit-compare'), /hasn’t been checked, so Fynd won’t compare it[\s\S]*Fynd holds no checked garment measurements for this item/);
    assert.strictEqual(apiAsked.length, asked, 'nothing was sent to Fynd’s server');
    assert.strictEqual(await page.inputValue('#fit-url'), `${site}/products/garment-tee`);
    await page.close();
    await shop.close();
    await popup.close();
  });

  await test('a body chart from a size guide: Find Fit says it measures the body, not the garment, and never compares it with a garment', async () => {
    const { shop, popup } = await check('modal-guide.html');
    const page = await openInFynd(popup);
    await page.waitForSelector('#fit-result[data-from="extension"]');
    assert.strictEqual(await page.textContent('#fit-result .size-chart-kind'), 'Body measurements — the body each size fits, not the garment');
    await page.waitForSelector('#fit-compare:not([hidden])');
    assert.match(await page.textContent('#fit-compare'), /Fynd cannot directly compare these measurements with your reference garment\. No size recommendation is available from this chart alone\./);
    assert.deepStrictEqual([await page.getAttribute('#fit-compare', 'data-verdict'), await page.textContent('#fit-compare .fit-compare-title')], ['body-only', 'This chart measures the body, not the finished garment.']);
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest, #fit-compare .fit-compare-differences', (ns) => ns.length), 0);
    await page.close();
    await shop.close();
    await popup.close();
  });

  await test('no chart on the page: "Check Fynd’s catalog" asks Find Fit to look the product up, as if its link were pasted', async () => {
    const { shop, popup } = await check('guide-closed.html');
    const asked = apiAsked.length;
    const page = await openInFynd(popup);
    await page.waitForFunction(() => document.getElementById('fit-result').dataset.state === 'unavailable');
    assert.strictEqual(new URL(page.url()).hash, '');
    await page.waitForSelector('#ff-reference[data-state]');
    await page.waitForTimeout(600);
    assert.strictEqual(apiAsked.length, asked + 1, 'one lookup, for this product');
    assert.ok(decodeURIComponent(apiAsked[apiAsked.length - 1]).includes('/fixtures/guide-closed.html'));
    await page.close();
    await shop.close();
    await popup.close();
  });

  await test('from the extension’s chart, "Check Fynd’s catalog" finds the product Fynd holds a record for, with that record’s own status', async () => {
    const page = await context.newPage();
    const Payload = require('../assets/fynd-payload');
    const payload = Payload.validate({ v: 1, kind: Payload.KIND, readAt: '2026-10-17', page: { url: 'https://www.uniqlo.com/us/en/products/E475378-000/00', title: 'Sweat Pullover Hoodie' }, product: { name: 'Sweat Pullover Hoodie', brand: 'UNIQLO' }, sizes: [], chart: { where: 'product-page', measures: 'not-stated', unit: null, title: null, columns: ['Chest'], rows: [{ size: 'S', values: ['1'] }, { size: 'M', values: ['2'] }] } }).payload;
    await page.goto(`${site}/index.html#fynd-chart=${Payload.encode(payload)}`);
    await page.waitForSelector('#fit-result[data-from="extension"]');
    await page.click('.fit-catalog');
    await page.waitForFunction(() => document.getElementById('fit-result').dataset.state === 'ok' && !document.getElementById('fit-result').dataset.from);
    /* the record's own status: the UNIQLO pair is pending review */
    assert.strictEqual(await page.textContent('#fit-result .size-chart-caveat'), 'This product’s own chart, copied from UNIQLO’s page on 2026-10-10 — pending review, not yet checked.');
    await page.close();
  });

  await test('a tampered or invented chart link is refused on Find Fit, and nothing from it is shown', async () => {
    const page = await context.newPage();
    const Payload = require('../assets/fynd-payload');
    const bad = Buffer.from(JSON.stringify({ v: 1, kind: Payload.KIND, page: { url: 'javascript:alert(1)' }, chart: null })).toString('base64url');
    for (const hash of [`#fynd-chart=${bad}`, '#fynd-chart=%%%notbase64', '#fynd-chart=e30']) {
      await page.goto(`${site}/index.html`);
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForFunction(() => document.getElementById('fit-result').dataset.state === 'error');
      assert.strictEqual(await page.textContent('#fit-result-title'), 'This chart couldn’t be opened');
      assert.strictEqual(await page.$$eval('#fit-result table', (ns) => ns.length), 0);
      assert.strictEqual(new URL(page.url()).hash, '');
    }
    await page.close();
  });

  await context.close();

  section('the extension exactly as shipped');

  await test('without a press on its toolbar button, the shipped extension can read no page at all', async () => {
    const shipped = await launch(path.join(REPO, 'extension'));
    try {
      const shop = await shipped.context.newPage();
      await shop.goto(`${site}/fixtures/one-table.html`);
      const popup = await shipped.context.newPage();
      await popup.goto(`chrome-extension://${shipped.id}/popup.html`);
      const tabId = await popup.evaluate(() => new Promise((r) => chrome.tabs.query({}, (tabs) => r(tabs.map((t) => t.id)))));
      for (const t of tabId) {
        await popup.goto(`chrome-extension://${shipped.id}/popup.html?tab=${t}`);
        await popup.click('#check');
        await popup.waitForFunction(() => document.body.dataset.state === 'problem');
        assert.strictEqual(await popup.textContent('#problem-title'), 'Fynd can’t read this page');
      }
    } finally {
      await shipped.context.close();
    }
  });

  server.close();
  fs.rmSync(extDir, { recursive: true, force: true });
  out(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
