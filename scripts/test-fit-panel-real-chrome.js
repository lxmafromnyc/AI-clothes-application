#!/usr/bin/env node
/* =========================================================
   Fynd — the Fit panel end to end, in a real, visible Chrome

     node scripts/test-fit-panel-real-chrome.js
     node scripts/test-fit-panel-real-chrome.js --live URL [URL ...]

   What this does that the other browser suites can't:

     - Chromium runs headed, on a virtual display (Xvfb), with the
       extension loaded exactly as shipped from extension/ — no test copy,
       no extra host permission, no ?tab= hook.
     - Fynd's toolbar button is clicked with a real X11 mouse click
       (scripts/real-chrome/xinput.py, via XTEST). That click is what
       Chrome turns into activeTab access and what opens the side panel;
       nothing else can stand in for it.
     - The panel is then driven like a shopper would: create a reference
       from brand, kind, size and fit only; open a product page; click
       Fynd; open the page's size guide; read it; get a recommendation;
       move to other pages; record how a purchase fit. Every request the
       panel makes and every console error is recorded.

   The pages (scripts/fixtures/fit-panel/shop/) are served from this
   machine. They are built like shop pages — structured product data,
   size buttons, a size guide that is a closed <dialog> with Body and
   Product tabs — but they are invented, and passing here says nothing
   about any real retailer. One is served at UNIQLO US's product address
   (Chrome is told to resolve www.uniqlo.com to this machine) only to
   check that the address is recognised; it is not UNIQLO's page.

   --live: after the same reference set-up, opens each URL given, clicks
   Fynd, and reports what the panel read and recommended, with a
   screenshot. That is the check against real retailer pages; it needs
   network access to them, and makes no assertions about their content.

   Needs: Xvfb and ImageMagick's `import`, python3 with python-xlib and
   Pillow, Playwright, and Chromium (CHROME_PATH). Screenshots go to
   FYND_SHOTS (default: a temporary folder, printed at the end).
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const EXT = path.join(REPO, 'extension');
const SHOP = path.join(__dirname, 'fixtures/fit-panel/shop');
const XINPUT = path.join(__dirname, 'real-chrome/xinput.py');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIVE = process.argv.includes('--live') ? process.argv.slice(process.argv.indexOf('--live') + 1) : null;
const { recordFromReport } = require('../api/_sizing/page-record');
const SHOTS = process.env.FYND_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-real-chrome-'));
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (err) { chromium = null; }

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 10).join('\n        ')}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chromeLog = '';
const chromeTail = () => chromeLog.split('\n').filter(Boolean).slice(-15).join('\n          ');

/* ---------- prerequisites: say what's missing, never pass silently ---------- */

function missing() {
  const need = [];
  if (!chromium) need.push('Playwright (npm i -g playwright, or PLAYWRIGHT_PATH)');
  if (!fs.existsSync(CHROME)) need.push(`Chromium at ${CHROME} (CHROME_PATH)`);
  for (const bin of ['Xvfb', 'import']) { try { execFileSync('which', [bin], { stdio: 'ignore' }); } catch (err) { need.push(bin); } }
  try { execFileSync('python3', ['-c', 'import Xlib.ext.xtest, PIL'], { stdio: 'ignore' }); } catch (err) { need.push('python3 with python-xlib and Pillow (pip install python-xlib pillow)'); }
  return need;
}

/* ---------- the machinery ---------- */

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/* an unpacked extension's id: its absolute path, hashed, in a–p */
const extensionId = (dir) => [...crypto.createHash('sha256').update(dir).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const host = String(req.headers.host || '').split(':')[0];
    let file = null;
    if (host === 'www.uniqlo.com' && /^\/us\/en\/products\/E475377-000\/00\/?$/.test(u.pathname)) file = path.join(SHOP, 'uniqlo-sweatshirt.html');
    else if (u.pathname.startsWith('/shop/')) file = path.join(SHOP, path.basename(u.pathname));
    if (!file || !fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function xinput(display, ...args) {
  return execFileSync('python3', [XINPUT, display, ...args], { encoding: 'utf8' }).trim();
}

async function launch(display, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-profile-'));
  const id = extensionId(EXT);
  /* pinned, so its button is on the toolbar as a shopper would pin it */
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { pinned_extensions: [id] } }));
  const debug = await freePort();
  const args = [
    '--no-sandbox', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    /* DisableLoadExtensionCommandLineSwitch: newer Chrome builds (137+)
       ignore --load-extension unless this is switched back off */
    '--disable-features=Translate,OptimizationHints,MediaRouter,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,DisableLoadExtensionCommandLineSwitch', '--password-store=basic',
    '--window-position=0,0', '--window-size=1400,900', `--remote-debugging-port=${debug}`,
    /* draw on the X display, never another backend */
    '--ozone-platform=x11',
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    `--host-resolver-rules=MAP www.uniqlo.com:80 127.0.0.1:${port}`,
    'about:blank'
  ];
  const proc = spawn(CHROME, args, { env: Object.assign({}, process.env, { DISPLAY: display }), stdio: ['ignore', 'ignore', 'pipe'] });
  /* Chrome's own complaints, for when something goes wrong */
  proc.stderr.on('data', (d) => { chromeLog = (chromeLog + d).slice(-20000); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${debug}/json/version`); if (r.ok) break; } catch (err) { /* starting */ }
    await sleep(250);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
  /* the extension must actually be running before anything is clicked:
     its background worker is the proof */
  let targets = [];
  for (let i = 0; i < 40; i++) {
    targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
    if (targets.some((t) => t.url === `chrome-extension://${id}/background.js`)) return { proc, browser, id, profile, debug };
    await sleep(250);
  }
  const version = await browser.version();
  proc.kill();
  console.log(`Chrome’s last output:\n          ${chromeTail()}`);
  throw new Error(`the extension did not load in ${version} (no chrome-extension://${id}/background.js worker; targets: ${targets.map((t) => `${t.type} ${t.url}`).join(', ') || 'none'})`);
}

/* ---------- the run ---------- */

(async () => {
  const need = missing();
  if (need.length) {
    console.log(`Real-Chrome test NOT RUN — missing: ${need.join('; ')}`);
    process.exit(2);
  }
  const display = `:${90 + Math.floor(Math.random() * 9)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  /* Chrome must not start before the display accepts it */
  try { xinput(display, 'ready'); } catch (err) {
    console.log(`  FAIL  the virtual display ${display} starts\n        it never accepted a connection\n\n0 passed, 1 failed`);
    xvfb.kill();
    process.exit(1);
  }
  const server = await serve();
  const port = server.address().port;
  const local = (p) => `http://127.0.0.1:${port}${p}`;
  let launched;
  try { launched = await launch(display, port); } catch (err) {
    console.log(`  FAIL  Chromium starts with the extension loaded\n        ${err.message}\n\n0 passed, 1 failed`);
    xvfb.kill(); server.close();
    process.exit(1);
  }
  const { proc, browser, id, debug } = launched;
  const context = browser.contexts()[0];
  const shot = (name) => { const file = path.join(SHOTS, `${name}.png`); xinput(display, 'shot', file); return file; };

  /* everything the panel asks the network for, and every console error */
  const requests = [];
  const errors = [];
  const watch = (page) => {
    page.on('request', (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url())) requests.push(r.url()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  };
  /* Playwright doesn't surface a side panel that opens after it
     connected: once Chrome lists the panel's target, connect again */
  const panelUrl = `chrome-extension://${id}/sidepanel.html`;
  const panelPage = async () => {
    if (panel) return panel;
    for (let i = 0; i < 40; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
      if (targets.some((t) => t.url.startsWith(panelUrl))) {
        const again = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
        const p = again.contexts()[0].pages().find((x) => x.url().startsWith(panelUrl));
        if (p) return p;
      }
      await sleep(250);
    }
    const file = shot(`no-panel-${Date.now()}`);
    const targets = context.pages().map((x) => x.url()).concat(context.serviceWorkers().map((w) => `worker ${w.url()}`));
    throw new Error(`the side panel never opened (screen: ${file}; targets: ${targets.join(', ')})`);
  };
  let panel = null;
  let watched = false;
  const clickFynd = async () => {
    let at = 'none';
    try { at = xinput(display, 'click-fynd'); } catch (err) { at = String(err.stdout || '').trim() || 'none'; }
    if (at === 'none') {
      let screen = '';
      try { screen = xinput(display, 'describe'); } catch (err) { screen = `couldn’t describe it: ${err.message}`; }
      throw new Error(`Fynd’s toolbar button wasn’t found on screen (${screen}; saved: ${shot(`no-button-${Date.now()}`)})\n        Chrome’s last output:\n          ${chromeTail() || '(none)'}`);
    }
    panel = await panelPage();
    if (!watched) { watch(panel); watched = true; }
    await sleep(900);
    return at;
  };
  const text = (sel) => panel.locator(sel).innerText();
  const shop = context.pages()[0];

  console.log(`Chromium ${(await browser.version())}, headed on Xvfb ${display}; extension ${id} loaded unpacked from extension/ as shipped.`);

  if (LIVE) {
    await shop.goto(local('/shop/no-chart.html'));
    await clickFynd();
    await panel.fill('#a-brand', 'UNIQLO');
    await panel.selectOption('#a-category', 'tshirt');
    await panel.fill('#a-size', 'M');
    await panel.click('#anchor-form button[type="submit"]');
    await panel.click('#resolve-skip');
    for (const url of LIVE) {
      console.log(`\n--- ${url}`);
      try {
        await shop.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(3000);
        await clickFynd();
        await sleep(2500);
        const report = await panel.evaluate(() => ({
          product: document.getElementById('product-name').textContent,
          meta: document.getElementById('product-meta').textContent,
          problem: document.getElementById('problem').hidden ? null : `${document.getElementById('problem-title').textContent} — ${document.getElementById('problem-text').textContent}`,
          chart: document.getElementById('chart-area').innerText.slice(0, 600),
          choices: [...document.querySelectorAll('#chart-choices .pop-choice-name')].map((x) => x.textContent),
          recommendation: document.getElementById('rec').hidden ? null : `${document.getElementById('rec-title').textContent} · ${document.getElementById('rec-confidence').textContent}`,
          explanation: document.getElementById('rec-explain').innerText.slice(0, 800)
        }));
        console.log(JSON.stringify(report, null, 2));
        console.log(`screenshot: ${shot(`live-${LIVE.indexOf(url) + 1}`)}`);
      } catch (err) {
        console.log(`could not check: ${err.message}`);
        console.log(`screenshot: ${shot(`live-${LIVE.indexOf(url) + 1}-failed`)}`);
      }
    }
    console.log(`\nrequests from the panel: ${requests.length ? requests.join(', ') : 'none'}`);
    console.log(`console errors: ${errors.length ? errors.join(' | ') : 'none'}`);
    await browser.close().catch(() => {});
    proc.kill(); xvfb.kill(); server.close();
    return;
  }

  console.log('\nthe workflow, with a real toolbar click');

  await test('a product page, a real click on Fynd’s toolbar button: the side panel opens beside the page and asks for a reference first', async () => {
    await shop.goto(local('/shop/tee.html'));
    await shop.bringToFront();
    shot('00-shop-before-click');
    await clickFynd();
    await panel.waitForSelector('#onboard:not([hidden])');
    assert.match(await text('#onboard-title'), /Which clothes already fit you the way you like\?/);
    /* one click, straight to the panel: no popup in between */
    const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
    assert.ok(!targets.some((t) => /popup\.html/.test(t.url)), `a popup opened: ${targets.map((t) => t.url).join(', ')}`);
    shot('01-panel-opened-onboarding');
  });

  await test('a reference from brand, kind, size and fit only — no link, no tape measure: measurements found, ranges and sources shown', async () => {
    await panel.fill('#a-brand', 'UNIQLO');
    await panel.selectOption('#a-category', 'tshirt');
    await panel.fill('#a-size', 'M');
    await panel.check('input[name="a-fit"][value="tight"]');
    await panel.click('#anchor-form button[type="submit"]');
    await panel.waitForSelector('#resolve:not([hidden])');
    assert.match(await text('#ref-tier'), /same brand’s products/);
    assert.match(await text('#resolve-text'), /SUPIMA® Cotton T-Shirt/);
    assert.match(await text('#ref-dims'), /chest width: about 21½ in \(somewhere 20¾ in–22¼ in\), laid flat/);
    await panel.click('#ref-sources-box summary');
    const link = await panel.getAttribute('#ref-sources a', 'href');
    assert.strictEqual(link, 'https://www.uniqlo.com/us/en/products/E455365-000/00');
    const stored = await panel.evaluate(() => chrome.storage.local.get('fyndAnchors'));
    assert.strictEqual(stored.fyndAnchors.length, 1);
    assert.strictEqual(stored.fyndAnchors[0].feel.fit, 'tight');
    assert.strictEqual(stored.fyndAnchors[0].dims.chestWidth.source, 'similar-product');
    shot('02-reference-estimated');
  });

  await test('the product is identified and its closed size guide is reported — not an empty panel', async () => {
    await panel.click('#resolve-skip');
    await panel.waitForSelector('#product:not([hidden])');
    await sleep(700);
    assert.strictEqual(await text('#product-name'), 'Everyday Crew Tee');
    assert.match(await text('#product-meta'), /Northwind · 127\.0\.0\.1/);
    assert.match(await text('#chart-area'), /No size chart found on this page\. The page lists sizes XS, S, M, L, XL, XXL, but no measurements\. The page has a size guide \(“Size guide”\): open it on the page, then press Read this page\./);
    shot('03-guide-closed');
  });

  await test('the shopper opens the size guide on the page and presses Read this page: the garment tab is read, not the body tab', async () => {
    await shop.click('#open-guide');
    await panel.click('#read');
    await panel.waitForSelector('#rec-title:not(:empty)');
    await sleep(400);
    const area = await text('#chart-area');
    assert.match(area, /Garment measurements · in inches · read from this page in your browser/);
    assert.match(area, /Chest width \(flat\)/);
    const choices = await panel.locator('#chart-choices .pop-choice-name').allInnerTexts();
    assert.ok(choices.some((c) => /Body measurements/.test(c)) && choices.some((c) => /Product measurements/.test(c)), choices.join(' | '));
    shot('04-guide-read');
  });

  await test('the recommendation: a size, its confidence and every reason, the differences per measurement, and what wasn’t compared', async () => {
    const title = await text('#rec-title');
    assert.strictEqual(title, 'L');
    assert.match(await text('#rec-confidence'), /^Low confidence$/);
    const explain = await text('#rec-explain');
    assert.match(explain, /Your reference T-shirt \(UNIQLO M\) has a flat chest width of about 21½ in, somewhere between 20¾ in and 22¼ in \(estimated from the same brand’s published measurements\)\. This L measures 22 in — about what you like\./);
    await panel.click('#rec-details summary');
    const why = await text('#rec-why');
    assert.match(why, /estimated from the same brand’s published measurements/);
    assert.match(why, /estimated from one answer/);
    const notes = await text('#rec-notes');
    assert.match(notes, /Not compared — length: your reference’s length is measured down the centre back, this chart’s from the top of the shoulder \(front length\)/);
    assert.match(notes, /Not compared — sleeve: your reference’s sleeve is measured from the centre back, this chart’s from the shoulder seam/);
    const rows = await panel.locator('#rec-table tbody tr').count();
    assert.strictEqual(rows, 6);
    shot('05-recommendation');
  });

  await test('the test report: what was identified, every table found, the chosen chart normalised to inches, the reference and the recommendation — copied, never sent', async () => {
    await panel.click('#copy-report');
    await sleep(300);
    const r = JSON.parse(await panel.inputValue('#report-text'));
    assert.strictEqual(r.read.how, 'button');
    assert.strictEqual(r.page.address, local('/shop/tee.html'));
    assert.deepStrictEqual([r.identified.name, r.identified.brand, r.identified.code, r.identified.kindUsed], ['Everyday Crew Tee', 'Northwind', 'NW-TEE-100', 'tshirt']);
    assert.deepStrictEqual(r.identified.sizesListed, ['XS', 'S', 'M', 'L', 'XL', 'XXL']);
    assert.ok(r.charts.some((c) => c.measures === 'body') && r.charts.some((c) => c.measures === 'finished-garment'));
    const m = r.normalised.sizes.find((z) => z.size === 'M').dims;
    assert.deepStrictEqual([m.chestWidth.inches, m.chestWidth.method, m.bodyLength.method, m.sleeveLength.method], [20.5, 'flat', 'hps', 'shoulder-seam']);
    assert.deepStrictEqual([r.recommendation.status, r.recommendation.size, r.recommendation.confidence], ['ok', 'L', 'low']);
    assert.strictEqual(r.reference.tier, 'same-brand');
    assert.match(await text('#open-fynd-note'), /address after “#”, which browsers don’t send to the server/);
  });

  await test('another page on the same site: Chrome keeps Fynd’s access for that site, so the panel follows without another click — and a body-measurement chart is never compared with a garment', async () => {
    await shop.goto(local('/shop/body-only.html'));
    await panel.waitForFunction(() => document.getElementById('product-name').textContent === 'Relaxed Tee', null, { timeout: 8000 });
    await sleep(400);
    assert.match(await text('#chart-area'), /Body measurements · in inches/);
    assert.strictEqual(await text('#rec-title'), 'Not enough to compare');
    assert.match(await text('#rec-explain'), /body/i);
    shot('06-same-site-body-chart');
  });

  await test('a page on another site: access doesn’t carry over, and the panel says to click Fynd — with technical details kept, not an empty panel', async () => {
    await shop.goto(`http://localhost:${port}/shop/no-chart.html`);
    await panel.waitForSelector('#problem:not([hidden])', { timeout: 8000 });
    assert.strictEqual(await text('#problem-title'), 'Click Fynd to read this page');
    await panel.click('#diag summary');
    const diag = await text('#diag-text');
    assert.match(diag, /"step": "read the page"/);
    assert.match(diag, /"kind": "no-access"/);
    assert.match(diag, /"how": "navigated"/);
    shot('07-other-site-needs-click');
  });

  await test('a click on Fynd there: sizes but no chart anywhere — said so, sizes listed, nothing recommended', async () => {
    await clickFynd();
    await panel.waitForSelector('#problem[hidden]', { state: 'attached' });
    await panel.waitForFunction(() => document.getElementById('product-name').textContent === 'Pocket Tee');
    assert.match(await text('#chart-area'), /No size chart found on this page\. The page lists sizes S, M, L, but no measurements\./);
    assert.strictEqual(await text('#rec-title'), 'Not enough to compare');
    shot('08-no-chart');
  });

  await test('a chart drawn with ARIA table roles instead of a <table>, in centimetres: read, normalised to inches, and compared', async () => {
    await shop.goto(`http://localhost:${port}/shop/grid-tee.html`);
    await panel.waitForFunction(() => document.getElementById('product-name').textContent === 'Loop Knit Tee', null, { timeout: 8000 });
    await panel.waitForSelector('#rec-title:not(:empty)');
    await sleep(300);
    assert.match(await text('#chart-area'), /Garment measurements · in centimetres · read from this page in your browser/);
    await panel.click('#copy-report');
    await sleep(200);
    const r = JSON.parse(await panel.inputValue('#report-text'));
    const m = r.normalised.sizes.find((z) => z.size === 'M').dims;
    assert.ok(Math.abs(m.chestWidth.inches - 52 / 2.54) < 0.01, 'cm to inches');
    assert.strictEqual(r.recommendation.status, 'ok');
    assert.strictEqual(await text('#rec-title'), r.recommendation.size);
    shot('08b-aria-grid-cm');
  });

  await test('a second reference (a UNIQLO sweatshirt that feels tight), then UNIQLO US’s product address: recognised, and compared from the measurements Fynd holds for it', async () => {
    await panel.click('#add-anchor');
    await panel.fill('#a-brand', 'UNIQLO');
    await panel.selectOption('#a-category', 'sweatshirt');
    await panel.fill('#a-size', 'M');
    await panel.selectOption('#a-cut', 'regular');
    await panel.check('input[name="a-fit"][value="tight"]');
    await panel.click('#anchor-form button[type="submit"]');
    await panel.waitForSelector('#resolve:not([hidden])');
    assert.match(await text('#resolve-text'), /Estimated from 2 UNIQLO sweatshirts or hoodies in M \(Sweatshirt; Sweat Pullover Hoodie\)/);
    await panel.click('#resolve-skip');
    await shop.goto('http://www.uniqlo.com/us/en/products/E475377-000/00');
    await sleep(600);
    await clickFynd();
    await panel.waitForSelector('#rec-title:not(:empty)');
    await sleep(500);
    assert.match(await text('#product-meta'), /UNIQLO US product E475377-000 · Fynd holds this product’s measurements/);
    assert.match(await text('#chart-area'), /Fynd’s data, checked by Fynd/);
    assert.strictEqual(await text('#rec-title'), 'L');
    assert.match(await text('#rec-anchor'), /Compared with your UNIQLO sweatshirt or hoodie in M/);
    /* from Fynd's data, Find Fit would look the product up on Fynd's server: said before it happens */
    assert.match(await text('#open-fynd-note'), /sends this product’s address \(www\.uniqlo\.com\/us\/en\/products\/E475377-000\/00\) to Fynd’s server/);
    shot('09-uniqlo-address');
  });

  await test('text-only extraction on the UNIQLO-address page: its size guide opened and read, the test report turned into a draft record — product, sizes, Product Size and Body Size kept apart, the published text and values, nothing invented', async () => {
    await shop.click('#open-guide');
    await panel.click('#read');
    await panel.waitForFunction(() => /Fynd’s data/.test(document.getElementById('chart-area').textContent));
    await sleep(300);
    await panel.click('#copy-report');
    await sleep(200);
    const report = JSON.parse(await panel.inputValue('#report-text'));
    const fromPage = report.charts.filter((c) => c.source === 'retailer-page');
    assert.deepStrictEqual(fromPage.map((c) => c.measures).sort(), ['body', 'finished-garment']);
    const out = recordFromReport(report);
    const rec = require('../api/_sizing/records/uniqlo-e475377-sweatshirt-us.json');
    const d = out.record;
    assert.deepStrictEqual([d.brand, d.product.name, d.product.url, d.product.code, d.category, d.line, d.units, d.sizes.join(',')],
      /* the address as read: this machine serves it over http, and the record keeps what was read */
      ['UNIQLO', 'Sweatshirt', 'http://www.uniqlo.com/us/en/products/E475377-000/00', 'E475377-000', 'sweatshirts', 'men', 'in', rec.sizes.join(',')]);
    assert.deepStrictEqual(d.fit, { brandWords: 'Regular', fitClass: 'regular', source: 'product page, read by the Fynd extension' });
    Object.entries(rec.charts.garment.sizes).forEach(([size, row]) => Object.entries(row).forEach(([dim, cell]) => assert.deepStrictEqual(d.charts.garment.sizes[size][dim], { value: cell.value, text: cell.text }, `${size} ${dim}`)));
    Object.entries(rec.charts.body.sizes).forEach(([size, row]) => assert.deepStrictEqual(d.charts.body.sizes[size].chest, row.chest, `body ${size}`));
    assert.deepStrictEqual(out.missing.map((m) => m.field), ['material']);
    assert.deepStrictEqual([d.verification.status, d.capture.how], ['unverified', 'browser-extension']);
    /* what keeps it from loading: the missing fabric, and (here only) the http address */
    assert.ok(out.errors.length && out.errors.every((e) => e.field === 'material.stretch' || /url|source|methodSource/i.test(e.field)), JSON.stringify(out.errors));
  });

  await test('how it fit: “Too tight” in L is stored with L’s measurements and moves the recommendation', async () => {
    await panel.selectOption('#f-size', 'L');
    await panel.click('[data-outcome="too-tight"]');
    await sleep(300);
    assert.match(await text('#feedback-saved'), /Saved on this device: L was too tight/);
    assert.strictEqual(await text('#rec-title'), 'XL');
    const stored = await panel.evaluate(() => chrome.storage.local.get('fyndAnchors'));
    const hoodie = stored.fyndAnchors.find((a) => a.category === 'sweatshirt');
    assert.strictEqual(hoodie.feedback[0].outcome, 'too-tight');
    assert.strictEqual(hoodie.feedback[0].dims.chestWidth, 25);
    shot('10-outcome');
  });

  await test('text-only extraction on a body-only page and a page with no chart: no garment measurement is produced from either', async () => {
    await shop.goto(local('/shop/body-only.html'));
    await sleep(600);
    await clickFynd();
    await panel.waitForFunction(() => document.getElementById('product-name').textContent === 'Relaxed Tee');
    await panel.click('#copy-report');
    await sleep(200);
    const body = JSON.parse(await panel.inputValue('#report-text'));
    assert.deepStrictEqual(body.charts.map((c) => c.measures), ['body']);
    /* an invented shop isn't a brand a record may hold: refused, not guessed */
    assert.strictEqual(recordFromReport(body).status, 'refused');
    /* the same body-only chart on a brand's own address: body chest only */
    const asBrand = Object.assign({}, body, { page: Object.assign({}, body.page, { address: 'https://www2.hm.com/en_us/productpage.0685816001.html' }) });
    const out = recordFromReport(asBrand);
    assert.deepStrictEqual(Object.keys(out.record.charts), ['body']);
    assert.ok(out.notRecorded.some((n) => /None is worked out from a body chart/.test(n)));
    await shop.goto(local('/shop/no-chart.html'));
    await sleep(600);
    await panel.click('#copy-report');
    await sleep(200);
    const none = JSON.parse(await panel.inputValue('#report-text'));
    assert.deepStrictEqual(none.charts, []);
    assert.strictEqual(recordFromReport(Object.assign({}, none, { page: Object.assign({}, none.page, { address: 'https://www.uniqlo.com/us/en/products/E475377-000/00' }) })).status, 'refused');
  });

  await test('pages Chrome won’t let any extension read, and pages that didn’t load: an explanation, not an empty panel', async () => {
    await shop.goto('chrome://version');
    await sleep(400);
    await clickFynd();
    await panel.waitForSelector('#problem:not([hidden])');
    assert.strictEqual(await text('#problem-title'), 'Chrome doesn’t let extensions read this page');
    const dead = await freePort();
    await shop.goto(`http://127.0.0.1:${dead}/`).catch(() => {});
    await sleep(600);
    await clickFynd();
    await panel.waitForSelector('#problem:not([hidden])');
    assert.strictEqual(await text('#problem-title'), 'This page didn’t load');
    shot('11-error-page');
  });

  await test('the references persist: the panel reloaded reads them back, and the next product is compared without asking again', async () => {
    await panel.reload();
    await shop.goto(local('/shop/tee.html'));
    await sleep(500);
    await clickFynd();
    await shop.click('#open-guide');
    await panel.click('#read');
    await panel.waitForSelector('#rec-title:not(:empty)');
    await sleep(300);
    assert.ok(await panel.locator('#onboard').isHidden());
    assert.strictEqual(await panel.locator('#anchor-list li').count(), 2);
    assert.strictEqual(await text('#rec-title'), 'L');
  });

  await test('nothing left the browser, and nothing failed in the console', async () => {
    assert.deepStrictEqual(requests, [], `the panel made requests: ${requests.join(', ')}`);
    assert.deepStrictEqual(errors.filter((e) => !/Receiving end does not exist/.test(e)), []);
  });

  await browser.close().catch(() => {});
  proc.kill();
  xvfb.kill();
  server.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log('These pages are invented and served from this machine: this shows the extension’s own workflow in a real Chrome, not compatibility with any real retailer.');
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
