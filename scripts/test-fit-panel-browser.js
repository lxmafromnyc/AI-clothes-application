#!/usr/bin/env node
/* =========================================================
   Fynd — the Fit panel, in Chromium

     node scripts/test-fit-panel-browser.js

   The extension's Fit panel (extension/sidepanel.html) runs in
   Playwright's headless Chromium against invented FIXTURE pages
   (scripts/fixtures/fit-panel/). The panel makes no network request;
   every request it attempts is recorded, to check that.

   scripts/test-fit-panel-real-chrome.js is the end-to-end check: a
   visible Chrome, the extension as shipped, a real click on its
   toolbar button. This suite covers the many states quickly.

   As in test-extension-browser.js: Chrome grants activeTab only on a
   real toolbar press, so the suite loads a copy whose manifest also
   allows this machine's pages, opens the panel in a tab with ?tab=<id>,
   and points its UNIQLO US adapter at this machine too
   (FYND_RETAILER_HOSTS in the copy's config.js), served as "localhost"
   while the other fixtures, standing for shops Fynd doesn't support,
   are served as 127.0.0.1. A second launch loads
   the extension as shipped and shows the panel can read nothing
   without a press.

   Fixture success is not live compatibility: no real retailer's page
   is loaded here.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures/fit-panel');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (err) { chromium = null; }


let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n        ')}`); }
}
const section = (s) => console.log(`\n${s}`);

const asked = [];
function serve() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    /* the UNIQLO-shaped address the adapter recognises */
    const product = /^\/us\/en\/products\/(E\d{6}-\d{3})\/00$/.exec(u.pathname);
    const file = product ? path.join(FIXTURES, 'uniqlo-product.html') : u.pathname.startsWith('/fixtures/') ? path.join(FIXTURES, path.basename(u.pathname)) : null;
    if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function copy(site, testHosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-fit-'));
  fs.cpSync(path.join(REPO, 'extension'), dir, { recursive: true });
  if (testHosts) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    /* the test copy only: so ?tab= can read this machine's pages without the toolbar press */
    manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'config.js'), `const FYND_SITE = '${site}';\nconst FYND_RETAILER_HOSTS = { 'uniqlo-us': ['localhost'] };\n`);
  }
  return dir;
}

async function launch(dir) {
  const context = await chromium.launchPersistentContext('', { executablePath: CHROME, headless: true, args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
  const page = await context.newPage();
  await page.goto('chrome://extensions');
  const id = await page.evaluate(() => new Promise((r) => chrome.management.getAll((all) => r((all.find((x) => x.name.startsWith('Fynd')) || {}).id))));
  await page.close();
  return { context, id };
}

(async () => {
  if (!chromium || !fs.existsSync(CHROME)) { console.log('Chromium could not launch here — skipping Fit panel browser tests.'); return; }
  const server = await serve();
  const site = `http://127.0.0.1:${server.address().port}`;
  let ext;
  try { ext = await launch(copy(site, true)); } catch (err) { console.log(`Chromium could not launch here — skipping Fit panel browser tests. (${err.message})`); server.close(); return; }
  const { context, id } = ext;

  /* a shop page in one tab, the panel in another, aimed at the first */
  /* UNIQLO-shaped addresses are served as "localhost" (the adapter's
     test host); every other fixture as 127.0.0.1, a shop Fynd doesn't support */
  async function open(pathname, opts) {
    const shop = await context.newPage();
    await shop.goto(`${pathname.startsWith('/us/en/products/') ? site.replace('127.0.0.1', 'localhost') : site}${pathname}`);
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    panel.on('request', (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url())) asked.push(r.url()); });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    if (!(opts && opts.keep)) await panel.evaluate(() => chrome.storage.local.clear());
    if (opts && opts.anchors) await panel.evaluate((a) => chrome.storage.local.set({ fyndAnchors: a }), opts.anchors);
    const tabId = await panel.evaluate((u) => new Promise((r) => chrome.tabs.query({}, (tabs) => r((tabs.find((t) => t.url === u) || {}).id))), shop.url());
    await panel.goto(`chrome-extension://${id}/sidepanel.html?tab=${tabId}`);
    return { shop, panel };
  }
  const stored = (panel) => panel.evaluate(() => chrome.storage.local.get('fyndAnchors').then((r) => r.fyndAnchors || []));
  const recShown = (panel) => panel.waitForFunction(() => { const t = document.getElementById('rec-title'); return !document.getElementById('rec').hidden && t.textContent; });

  /* a reference whose measurements come from its own page's chart */
  const teeFromPage = { id: 'tee', brand: 'Illustrative Brand', category: 'tshirt', size: 'L', feel: { fit: 'right', length: 'right' }, dims: { chestWidth: { value: 22, source: 'retailer-page' }, bodyLength: { value: 29, source: 'retailer-page', method: 'back' }, sleeveLength: { value: 16, source: 'retailer-page', method: 'center-back' } } };

  section('Fit Anchor onboarding');

  await test('first run asks which clothes already fit; brand, kind and size alone give a saved reference with sourced measurements and their spread — no link, no tape measure, no request', async () => {
    const { shop, panel } = await open('/fixtures/garment-tee.html');
    await panel.waitForSelector('#onboard:not([hidden])');
    assert.strictEqual(await panel.textContent('#onboard-title'), 'Which clothes already fit you the way you like?');
    asked.length = 0;
    await panel.fill('#a-brand', 'uniqlo');
    await panel.selectOption('#a-category', 'sweatshirt');
    await panel.fill('#a-size', 'Medium');
    await panel.check('input[name="a-fit"][value="tight"]');
    await panel.click('#anchor-form button[type="submit"]');
    await panel.waitForSelector('#resolve:not([hidden])');
    assert.strictEqual(await panel.textContent('#ref-tier'), 'Estimated from the same brand’s products');
    assert.match(await panel.textContent('#resolve-text'), /Estimated from 3 UNIQLO sweatshirts or hoodies in Medium \(Sweat Oversized Pullover Hoodie; Sweatshirt; Sweat Pullover Hoodie\)/);
    const offered = await panel.$$eval('#resolve-options .pop-choice-name', (ns) => ns.map((n) => n.textContent));
    assert.deepStrictEqual(offered, ['UNIQLO Sweat Oversized Pullover Hoodie', 'UNIQLO Sweatshirt', 'UNIQLO Sweat Pullover Hoodie']);
    const saved = await stored(panel);
    assert.strictEqual(saved.length, 1, 'saved at once: nothing blocks the start');
    assert.deepStrictEqual([saved[0].brand, saved[0].category, saved[0].size, saved[0].feel.fit, saved[0].reference.tier], ['uniqlo', 'sweatshirt', 'Medium', 'tight', 'same-brand']);
    assert.ok(Object.values(saved[0].dims).every((m) => m.source === 'similar-product' && m.verified === false && m.low < m.value + 0.001 && m.high > m.value - 0.001));
    assert.deepStrictEqual(asked, [], 'the lookup is local');
    /* "mine is this one": its own published measurements */
    await panel.click('#resolve-options li:nth-child(2) .pop-choice');
    await panel.waitForFunction(() => document.getElementById('ref-tier').textContent === 'Its own published measurements');
    const exact = await stored(panel);
    assert.strictEqual(exact.length, 1);
    assert.strictEqual(exact[0].dims.chestWidth.value, 23.5);
    /* the record's own values, said to be unverified: the UNIQLO pair is pending review */
    assert.ok(Object.values(exact[0].dims).every((m) => m.source === 'fynd-record' && m.verified === false && m.low === undefined));
    await shop.close(); await panel.close();
  });

  await test('every tier says what it rests on: a brand that publishes body charts only (chest only, wide range), a brand Fynd has nothing for (other brands’ range), and a kind with no data at all (nothing invented)', async () => {
    const { shop, panel } = await open('/fixtures/garment-tee.html');
    await panel.waitForSelector('#onboard:not([hidden])');
    const add = async (brand, category, size) => {
      if (await panel.isVisible('#add-anchor')) await panel.click('#add-anchor');
      await panel.fill('#a-brand', brand);
      await panel.selectOption('#a-category', category);
      await panel.fill('#a-size', size);
      await panel.click('#anchor-form button[type="submit"]');
      await panel.waitForSelector('#resolve:not([hidden])');
      return { tier: await panel.textContent('#ref-tier'), text: await panel.textContent('#resolve-text'), dims: await panel.$$eval('#ref-dims li', (ls) => ls.map((l) => l.textContent)) };
    };
    const nike = await add('Nike', 'tshirt', 'L');
    assert.strictEqual(nike.tier, 'Estimated from the brand’s size chart — chest only');
    assert.match(nike.text, /Nike publishes who its L is cut for \(chest 41 in–44 in around the body\)/);
    assert.deepStrictEqual(nike.dims.length, 1);
    assert.match(nike.dims[0], /^chest width: about 23 in \(somewhere 21¾ in–24½ in\), laid flat$/);
    const gap = await add('Gap', 'tshirt', 'M');
    assert.strictEqual(gap.tier, 'Rough estimate from other brands');
    assert.match(gap.text, /no published measurements for Gap T-shirts\. This is the range of 2 T-shirts labelled M from UNIQLO and Zara/);
    const levis = await add('Levi’s', 'jeans', '32x30');
    assert.strictEqual(levis.tier, 'No measurements yet');
    assert.deepStrictEqual(levis.dims, []);
    assert.strictEqual(await panel.isVisible('#manual-fields'), true, 'measurements offered, never required');
    const saved = await stored(panel);
    assert.deepStrictEqual(saved.find((a) => a.category === 'jeans').dims, {}, 'a label is not a measurement');
    await shop.close(); await panel.close();
  });

  section('reading the product and recommending a size');

  await test('UNIQLO US: the product recognised by its address and compared from the measurements Fynd holds for it — the size, the confidence and the measured reasons, with nothing sent', async () => {
    asked.length = 0;
    const hoodie = { id: 'h', brand: 'UNIQLO', category: 'sweatshirt', size: 'M', feel: { fit: 'right', length: 'right' }, product: { url: 'https://www.uniqlo.com/us/en/products/E475378-000/00' }, dims: { chestWidth: { value: 23.5, source: 'fynd-record', verified: true }, bodyLength: { value: 26.75, source: 'fynd-record', verified: true, method: 'back' }, sleeveLength: { value: 34.75, source: 'fynd-record', verified: true, method: 'center-back' }, shoulderWidth: { value: 20, source: 'fynd-record', verified: true, method: 'seam-to-seam' } } };
    const { shop, panel } = await open('/us/en/products/E475377-000/00', { anchors: [hoodie] });
    await recShown(panel);
    assert.match(await panel.textContent('#product-meta'), /UNIQLO US product E475377-000 · Fynd holds this product’s measurements/);
    assert.strictEqual(await panel.inputValue('#p-category'), 'sweatshirt');
    assert.match(await panel.textContent('#chart-area'), /Fynd’s data, as published — not yet checked/);
    assert.ok(!/checked by Fynd/.test(await panel.textContent('#chart-area')), 'never called checked while pending review');
    assert.ok(/^(S|M|L)$/.test(await panel.textContent('#rec-title')));
    assert.match(await panel.textContent('#rec-confidence'), /^(High|Medium) confidence$/);
    const lines = await panel.$$eval('#rec-explain p', (ps) => ps.map((p) => p.textContent));
    assert.match(lines[0], /^Your reference sweatshirt or hoodie \(UNIQLO M\) has a flat chest width of 23½ in \(verified by Fynd\)\. This \w+ measures [\d½¼¾⅛⅜⅝⅞]+ in — /);
    assert.deepStrictEqual(asked, []);
    await shop.close(); await panel.close();
  });

  await test('another shop, with no retailer module: its own garment chart, read from the page; “This fits me” makes it a reference; the same chart then recommends that size, labelled as read from the page', async () => {
    asked.length = 0;
    const { shop, panel } = await open('/fixtures/garment-tee.html', { anchors: [Object.assign({}, teeFromPage, { id: 'old', brand: 'Placeholder', size: 'M', dims: { chestWidth: { value: 20.5, source: 'shopper' } } })] });
    await recShown(panel);
    assert.match(await panel.textContent('#product-meta'), /Illustrative Brand · 127\.0\.0\.1/);
    assert.match(await panel.textContent('#chart-area'), /Garment measurements · in inches · read from this page in your browser/);
    assert.deepStrictEqual(asked, [], 'nothing sent anywhere');
    await panel.click('#use-as-anchor');
    await panel.waitForSelector('#onboard:not([hidden])');
    assert.strictEqual(await panel.inputValue('#a-brand'), 'Illustrative Brand');
    await panel.fill('#a-size', 'L');
    await panel.click('#anchor-form button[type="submit"]');
    await panel.waitForSelector('#resolve:not([hidden])');
    assert.strictEqual(await panel.textContent('#ref-tier'), 'Read from its product page');
    await panel.click('#resolve-skip');
    await recShown(panel);
    const saved = await stored(panel);
    const ref = saved.find((a) => a.size === 'L');
    assert.deepStrictEqual(Object.keys(ref.dims).sort(), ['bodyLength', 'chestWidth', 'sleeveLength']);
    assert.ok(Object.values(ref.dims).every((m) => m.source === 'retailer-page'));
    await shop.close(); await panel.close();
  });

  await test('the same reference against its own chart: L, high confidence, every dimension compared and explained', async () => {
    const { shop, panel } = await open('/fixtures/garment-tee.html', { anchors: [teeFromPage] });
    await recShown(panel);
    assert.strictEqual(await panel.textContent('#rec-title'), 'L');
    assert.strictEqual(await panel.textContent('#rec-confidence'), 'High confidence');
    const lines = await panel.$$eval('#rec-explain p', (ps) => ps.map((p) => p.textContent));
    assert.strictEqual(lines[0], 'Your reference T-shirt (Illustrative Brand L) has a flat chest width of 22 in (from the retailer’s published chart). This L measures 22 in — about what you like.');
    await panel.click('#rec-details summary');
    const rows = await panel.$$eval('#rec-table tbody tr', (trs) => trs.map((tr) => tr.firstChild.textContent));
    assert.strictEqual(rows[0], 'L');
    await shop.close(); await panel.close();
  });

  await test('units: switching to centimetres changes the words, not the sizes', async () => {
    const { shop, panel } = await open('/fixtures/garment-tee.html', { anchors: [teeFromPage] });
    await recShown(panel);
    await panel.click('.fp-unit [data-unit="cm"]');
    await panel.waitForFunction(() => /55\.9 cm/.test(document.getElementById('rec-explain').textContent));
    assert.strictEqual(await panel.textContent('#rec-title'), 'L');
    await panel.click('.fp-unit [data-unit="in"]');
    await shop.close(); await panel.close();
  });

  await test('a body chart is never compared with a garment; a chart that doesn’t say is compared only once the shopper confirms it, at low confidence; no chart says what to do', async () => {
    let { shop, panel } = await open('/fixtures/body-chart.html', { anchors: [Object.assign({}, teeFromPage, { category: 'sweatshirt' })] });
    await recShown(panel);
    /* same brand, same label on offer: a label match, said to be only that */
    assert.strictEqual(await panel.textContent('#rec-title'), 'L?');
    assert.strictEqual(await panel.textContent('#rec-confidence'), 'Label match only — low confidence');
    assert.match(await panel.textContent('#rec-explain'), /body measurements .* not the garment’s own/);
    assert.match(await panel.textContent('#rec-explain'), /a label match, not a measurement match/);
    assert.strictEqual(await panel.isHidden('#feedback'), true);
    await shop.close(); await panel.close();

    ({ shop, panel } = await open('/fixtures/unlabelled.html', { anchors: [teeFromPage] }));
    await recShown(panel);
    assert.strictEqual(await panel.textContent('#rec-title'), 'L?', 'until confirmed, only a same-brand label match');
    assert.match(await panel.textContent('#rec-explain'), /doesn’t say whether it measures the garment or the body/);
    assert.strictEqual(await panel.isVisible('#confirm-kind'), true);
    await panel.click('#confirm-garment');
    await panel.waitForFunction(() => document.getElementById('rec-title').textContent === 'L');
    assert.strictEqual(await panel.textContent('#rec-confidence'), 'Low confidence');
    await shop.close(); await panel.close();

    ({ shop, panel } = await open('/fixtures/no-chart.html', { anchors: [Object.assign({}, teeFromPage, { category: 'shirt' })] }));
    await panel.waitForFunction(() => /No size chart found on this page/.test(document.getElementById('chart-area').textContent));
    await recShown(panel);
    assert.match(await panel.textContent('#rec-explain'), /no size chart with measurements/);
    await shop.close(); await panel.close();
  });

  await test('correcting a measurement: the chart becomes the shopper’s, and confidence can no longer be high', async () => {
    const { shop, panel } = await open('/fixtures/garment-tee.html', { anchors: [teeFromPage] });
    await recShown(panel);
    await panel.click('#correct');
    await panel.fill('#chart-area input[aria-label="XL, Chest width"]', '24');
    await panel.click('#correct');
    await panel.waitForFunction(() => /as you corrected it/.test(document.getElementById('chart-area').textContent));
    assert.match(await panel.textContent('#status'), /1 value corrected/);
    assert.notStrictEqual(await panel.textContent('#rec-confidence'), 'High confidence');
    await shop.close(); await panel.close();
  });

  section('learning from how it fit');

  await test('“L was too tight” is kept on this device with L’s own measurements, and moves the recommendation up', async () => {
    const { shop, panel } = await open('/fixtures/garment-tee.html', { anchors: [teeFromPage] });
    await recShown(panel);
    assert.strictEqual(await panel.textContent('#rec-title'), 'L');
    await panel.selectOption('#f-size', 'L');
    await panel.click('[data-outcome="too-tight"]');
    await panel.waitForFunction(() => /Saved on this device: L was too tight/.test(document.getElementById('feedback-saved').textContent));
    assert.strictEqual(await panel.textContent('#rec-title'), 'XL');
    const saved = await stored(panel);
    assert.deepStrictEqual(saved[0].feedback.map((f) => [f.outcome, f.size, f.dims.chestWidth]), [['too-tight', 'L', 22]]);
    await shop.close(); await panel.close();
  });

  section('privacy');

  await test('the panel made no network request in any of the above', async () => {
    assert.deepStrictEqual(asked, []);
  });

  await context.close();

  section('the extension as shipped');

  await test('without a toolbar press, the panel reads nothing — it says to click Fynd, keeps the technical detail, and shows no recommendation', async () => {
    const shipped = await launch(copy(site, false));
    const shop = await shipped.context.newPage();
    await shop.goto(`${site}/fixtures/garment-tee.html`);
    const panel = await shipped.context.newPage();
    await panel.goto(`chrome-extension://${shipped.id}/sidepanel.html`);
    await panel.evaluate((a) => chrome.storage.local.set({ fyndAnchors: a }), [teeFromPage]);
    const tabId = await panel.evaluate((u) => new Promise((r) => chrome.tabs.query({}, (tabs) => r((tabs.find((t) => t.url === u || !t.url) || {}).id))), shop.url());
    await panel.goto(`chrome-extension://${shipped.id}/sidepanel.html?tab=${tabId}`);
    await panel.waitForSelector('#problem:not([hidden])');
    assert.strictEqual(await panel.textContent('#problem-title'), 'Click Fynd to read this page');
    assert.match(await panel.textContent('#diag-text'), /"kind": "no-access"/);
    assert.strictEqual(await panel.isHidden('#rec'), true);
    await shipped.context.close();
  });

  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
