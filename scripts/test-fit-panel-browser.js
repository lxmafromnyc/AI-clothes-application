#!/usr/bin/env node
/* =========================================================
   Fynd — the Fit panel, in Chromium, against Fynd's own API

     node scripts/test-fit-panel-browser.js
     FYND_TEST_ONLY=<regex> node scripts/test-fit-panel-browser.js

   The extension's Fit panel (extension/sidepanel.html) in Playwright's
   headless Chromium, on invented FIXTURE pages
   (scripts/fixtures/extension-panel/ and scripts/fixtures/fit-panel/),
   talking to Fynd's real handlers run on this machine —
   /api/auth, /api/fit-profile and /api/size-recommendation, as
   Vercel runs them — with a shopper signed in through /api/auth the way
   the site signs them in, so the panel's requests carry the browser's
   own Fynd session cookie, and the extension's own origin passes
   api/_cors.js as it will in production (the manifest's key pins the
   ID, so this copy has the same one).

   Covered: reading the product (structured data, and the page alone),
   choosing a chart (garment, body, unlabelled, none), reviewing and
   correcting values, choosing a saved garment, the one comparison
   request and the server's answer drawn as it is (OK, NO_MATCH,
   INSUFFICIENT_DATA), and each failure: not a product, signed out, no
   garment saved, 401, 400, 429, 5xx and a timeout — and that the panel
   asks nothing of any host but Fynd's API.

   As in test-extension-browser.js: Chrome grants activeTab only on a
   real toolbar press, so the suite loads a copy whose manifest also
   allows this machine's pages and opens the panel in a tab with
   ?tab=<id>. Shops are served as 127.0.0.1 and Fynd's API as
   localhost, two sites. A last launch loads the extension as shipped
   and shows the panel reads nothing without a press.
   scripts/test-fit-panel-real-chrome.js is the visible-Chrome check.

   Fixture success is not live compatibility: no real retailer's page
   is loaded here.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.AUTH_SECRET = 'fit-panel-browser-secret-of-sufficient-length';
delete process.env.ALLOWED_ORIGIN;
delete process.env.RESEND_API_KEY;
delete process.env.POSTMARK_SERVER_TOKEN;
const quiet = !process.env.SHOW_LOGS;
['log', 'warn', 'error'].forEach((level) => { const o = console[level]; console[level] = (...a) => { if (!quiet || (level === 'log' && /^(\s{2}(ok|FAIL)|\n|\d+ passed|Chromium)/.test(String(a[0])))) o(...a); }; });

const REPO = path.join(__dirname, '..');
const FIXTURES = [path.join(__dirname, 'fixtures/extension-panel'), path.join(__dirname, 'fixtures/fit-panel')];
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (err) { chromium = null; }

const Schema = require('../assets/fit-profile-schema.js');
const users = require('../api/_users');
const fitProfiles = require('../api/_fit-profile');
/* Gemini, scripted: the real /api/size-recommendation?parse=1 runs here, and its one call to
   Google is answered by the test (a fixture's model answer, a hang or a
   failure) — no model is reached. The key is a fake. */
process.env.GEMINI_API_KEY = 'browser-test-key-not-real';
const gemini = { mode: 'answer', model: null, calls: 0 };
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return realFetch(url, init);
  gemini.calls += 1;
  if (gemini.mode === 'hang') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
  if (gemini.mode === 'fail') return { ok: false, status: 500, headers: { get: () => null }, text: async () => '{}', json: async () => ({}) };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini.model) }] } }], usageMetadata: { totalTokenCount: 800 } }) };
};
const { CASES: AI_CASES, byId: aiCase } = require('./fixtures/chart-ai/cases.js');
const parseChart = require('../api/_sizing/parse-chart');
/* each chart-AI fixture as a shop page: a product, and its table as the page shows it (merged cells merged) */
function aiPage(c) {
  const esc = (t) => String(t).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const spans = c.table.spans || {};
  const rows = c.table.grid.map((r, ri) => {
    const cells = [];
    for (let ci = 0; ci < r.length; ci++) {
      const span = spans[`${ri},${ci}`] || 1;
      const tag = ri === 0 || (ri === 1 && !r[0]) ? 'th' : 'td';
      cells.push(`<${tag}${span > 1 ? ` colspan="${span}"` : ''}>${esc(r[ci])}</${tag}>`);
      ci += span - 1;
    }
    return `<tr>${cells.join('')}</tr>`;
  }).join('\n');
  const name = { hoodies: 'Illustrative Zip Hoodie', sweatshirts: 'Illustrative Sweatshirt', tshirts: 'Illustrative Crew T-Shirt' }[c.type];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}","brand":{"name":"Illustrative Brand"},"offers":[{"size":"S"},{"size":"M"},{"size":"L"}]}</script></head>
<body><p>FIXTURE — invented for Fynd’s tests (${esc(c.id)}). Not a real retailer’s page.</p><h1>${name}</h1>
${c.table.before ? `<p>${esc(c.table.before)}</p>` : ''}<table>${c.table.caption ? `<caption>${esc(c.table.caption)}</caption>` : ''}${rows}</table></body></html>`;
}

const HANDLERS = {
  '/api/auth': require('../api/auth'),
  '/api/fit-profile': require('../api/fit-profile'),
  '/api/size-recommendation': require('../api/size-recommendation')
};

const ONLY = process.env.FYND_TEST_ONLY ? new RegExp(process.env.FYND_TEST_ONLY, 'i') : null;
let passed = 0;
const failures = [];
async function test(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n        ')}`); }
}
const section = (s) => console.log(`\n${s}`);

/* ---------- this machine's Fynd: the shops' pages, and the API ---------- */
const hits = [];        /* every API request: what the server saw */
const faults = [];      /* one-shot answers in place of the handler: { path, status, body, headers, delayMs } */
function adapt(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(payload)); return res; };
  return res;
}
function readBody(req) {
  return new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => resolve(d)); req.on('error', () => resolve('')); });
}
function serve() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const handler = HANDLERS[u.pathname];
    if (handler) {
      adapt(res);
      /* Vercel parses a JSON body before the handler; so does this host */
      const raw = req.method === 'POST' ? await readBody(req) : '';
      let body;
      try { body = raw ? JSON.parse(raw) : undefined; } catch (err) { body = raw; }
      if (body !== undefined) req.body = body;
      req.query = Object.fromEntries(u.searchParams);
      const hit = { method: req.method, path: u.pathname, search: u.search, host: req.headers.host, origin: req.headers.origin || null, cookie: /fynd_session=/.test(req.headers.cookie || ''), body: body === undefined ? null : body, status: null };
      hits.push(hit);
      const fault = faults.findIndex((f) => f.path === u.pathname && (!f.method || f.method === req.method));
      if (fault >= 0 && req.method !== 'OPTIONS') {
        const f = faults.splice(fault, 1)[0];
        if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
        const { applyCors } = require('../api/_cors');
        applyCors(req, res);
        Object.entries(f.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
        hit.status = f.status;
        return res.status(f.status).json(f.body || {});
      }
      try { await handler(req, res); } catch (err) { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
      if (!res.writableEnded) res.end();
      hit.status = res.statusCode;
      return;
    }
    const ai = /^\/shop\/ai\/([\w-]+)\.html$/.exec(u.pathname);
    if (ai && aiCase(ai[1])) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(aiPage(aiCase(ai[1]))); }
    const m = /^\/shop\/([\w-]+\.html)$/.exec(u.pathname);
    const file = m ? FIXTURES.map((d) => path.join(d, m[1])).find((f) => fs.existsSync(f)) : null;
    if (!file) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------- the extension: a test copy, and as shipped ---------- */
function copy(api, testHosts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-fit-'));
  fs.cpSync(path.join(REPO, 'extension'), dir, { recursive: true });
  if (testHosts) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    /* the test copy only: this machine's shops (?tab= reads them without a press) and its Fynd */
    manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'config.js'), `const FYND_SITE = '${api}';\nconst FYND_API = FYND_SITE;\nconst FYND_API_TIMEOUT_MS = 1500;\nconst FYND_AI_TIMEOUT_MS = 4000;\n`);
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

/* ---------- the shopper's saved garments (invented) ---------- */
const FORM = { chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };
function profileWith(garments) {
  const p = Schema.empty();
  p.garments = {};
  Object.entries(garments).forEach(([type, measurements]) => {
    p.garments[type] = Object.assign(Schema.emptyGarment(type), { favorite: 'perfect', anchor: { brand: 'Owned Brand', size: 'L', measurements, methods: Object.assign({ registry: 1 }, Object.fromEntries(Object.keys(FORM).filter((k) => measurements[k] != null).map((k) => [k, FORM[k]]))) } });
  });
  return p;
}
const HOODIE = { unit: 'cm', chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 };
const TEE = { unit: 'in', chestWidth: 21.5, bodyLength: 29 };

(async () => {
  if (!chromium || !fs.existsSync(CHROME)) { console.log('Chromium could not launch here — skipping Fit panel browser tests.'); return; }
  const server = await serve();
  const port = server.address().port;
  const SHOP = `http://127.0.0.1:${port}`;
  const API = `http://localhost:${port}`;
  let ext;
  try { ext = await launch(copy(API, true)); } catch (err) { console.log(`Chromium could not launch here — skipping Fit panel browser tests. (${err.message})`); server.close(); return; }
  const { context, id } = ext;
  const EXT_ORIGIN = `chrome-extension://${id}`;
  assert.strictEqual(EXT_ORIGIN, require('../api/_cors').EXTENSION_ORIGINS[0], 'the copy has the shipped extension’s ID (the manifest key)');

  /* the panel's own requests: only ever to Fynd's API */
  const asked = [];
  async function open(file) {
    const shop = await context.newPage();
    await shop.goto(`${SHOP}/shop/${file}`);
    const panel = await context.newPage();
    await panel.setViewportSize({ width: 420, height: 900 });
    panel.on('request', (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url())) asked.push(r.url()); });
    await panel.goto(`${EXT_ORIGIN}/sidepanel.html`);
    const tabId = await panel.evaluate((u) => new Promise((r) => chrome.tabs.query({}, (tabs) => r((tabs.find((t) => t.url === u) || {}).id))), shop.url());
    await panel.goto(`${EXT_ORIGIN}/sidepanel.html?tab=${tabId}`);
    return { shop, panel, close: async () => { await shop.close(); await panel.close(); } };
  }
  const view = (panel, v) => panel.waitForFunction((want) => document.body.dataset.view === want, v, { timeout: 8000 });
  const text = (panel, sel) => panel.textContent(sel);
  const texts = (panel, sel) => panel.$$eval(sel, (ns) => ns.map((n) => n.textContent.trim()));

  /* signing in, as the site does: /api/auth sets the Fynd session cookie in this browser */
  let n = 0;
  async function signIn(garments) {
    n += 1;
    const email = `shopper${n}.panel@example.test`;
    await context.clearCookies();
    const r = await context.request.post(`${API}/api/auth`, { data: { action: 'signup', name: 'Shopper', email, password: 'correct-horse-battery-staple', confirmPassword: 'correct-horse-battery-staple' }, headers: { 'x-forwarded-for': `203.0.113.${n + 10}` } });
    assert.strictEqual(r.status(), 200, 'signed up');
    const user = await users.byEmail(email);
    if (garments) await fitProfiles.save(user.id, profileWith(garments));
    return user;
  }
  /* product → chart → review, the steps every comparison passes */
  async function toReview(panel) {
    await view(panel, 'product');
    await panel.click('#confirm-product');
    await view(panel, 'measure');
    await panel.click('#use-chart');
    await view(panel, 'review');
  }
  async function toResults(panel, type) {
    await panel.click('#to-reference');
    await view(panel, 'reference');
    await panel.waitForSelector('input[name="reference"]');
    if (type) await panel.check(`input[name="reference"][value="${type}"]`);
    await panel.click('#compare');
  }

  section('a garment chart with every method stated (structured data, size variants)');

  await test('the product from its structured data: name, brand, kind, colour and each size with whether it’s on offer', async () => {
    await signIn({ hoodies: HOODIE });
    const { panel, close } = await open('variants-hoodie.html');
    await view(panel, 'product');
    assert.strictEqual(await panel.inputValue('#p-name'), 'Illustrative Heavyweight Hoodie');
    assert.strictEqual(await panel.inputValue('#p-brand'), 'Illustrative Outfitters');
    assert.strictEqual(await panel.inputValue('#p-type'), 'hoodies');
    const offered = await panel.$$eval('#p-sizes li', (ns) => ns.map((x) => [x.textContent, x.dataset.available]));
    assert.deepStrictEqual(offered, [['S', 'true'], ['M', 'true'], ['L', 'true'], ['XL', 'false']], JSON.stringify(offered));
    assert.match(await text(panel, '#p-meta'), /Colour: Heather Grey/);
    assert.match(await text(panel, '#product-found'), /name from the page’s product data/);
    assert.strictEqual(await panel.getAttribute('#steps li[data-step="product"]', 'aria-current'), 'step');
    await close();
  });

  await test('its chart: garment measurements, every method read from the headings, nothing to fix — one request compares every size, and the server’s decision is drawn as it is', async () => {
    await signIn({ hoodies: HOODIE });
    const { panel, close } = await open('variants-hoodie.html');
    await toReview(panel);
    assert.match(await text(panel, '#review-kind'), /measures the garment itself/);
    assert.strictEqual(await panel.isHidden('#review-confirm-row'), true);
    assert.strictEqual(await panel.inputValue('#review-unit'), 'cm');
    assert.deepStrictEqual(await panel.$$eval('select[data-role="method"]', (ns) => ns.map((s) => s.value)), [FORM.chestWidth, FORM.shoulderWidth, FORM.bodyLength, FORM.sleeveLength]);
    assert.deepStrictEqual(await texts(panel, '#review-problems li'), []);
    assert.strictEqual(await panel.isDisabled('#to-reference'), false);
    const before = hits.length;
    await toResults(panel);
    await view(panel, 'results');
    assert.strictEqual(await text(panel, '#result-title'), 'The size that meets Fynd’s comparison criteria');
    assert.strictEqual(await text(panel, '#result-size'), 'L');
    assert.deepStrictEqual(await panel.$$eval('#result-table tr[data-size]', (ns) => ns.map((r) => [r.dataset.size, r.dataset.pick || ''])), [['S', ''], ['M', ''], ['L', 'recommended'], ['XL', '']]);
    assert.ok(!/−0(?![.\d])/.test(await text(panel, '#result-table')), 'a difference that rounds to nothing reads 0, never −0');
    assert.match(await text(panel, '#result-reliability'), /^Reliability: medium — .*Fynd hasn’t checked them/);
    assert.match(await text(panel, '#result-source'), /read from shop\.example\.test and confirmed by you\. Not verified by Fynd\./);
    /* what reached Fynd: the saved garments once, the comparison once — with the session, from the extension */
    const mine = hits.slice(before);
    assert.deepStrictEqual(mine.map((h) => [h.method, h.path + h.search, h.status]).filter((h) => h[0] !== 'OPTIONS'), [['GET', '/api/fit-profile', 200], ['POST', '/api/size-recommendation?compare=1&candidate=1', 200]]);
    /* the browser's own Fynd session on both; Chrome sends Origin on the POST (a GET from an extension with host access carries none) */
    assert.ok(mine.filter((h) => h.method !== 'OPTIONS').every((h) => h.cookie), 'the browser’s own Fynd session cookie');
    assert.strictEqual(mine.find((h) => h.method === 'POST').origin, EXT_ORIGIN, 'from the extension’s origin, which the API allows');
    const sent = mine.find((h) => h.method === 'POST').body;
    assert.deepStrictEqual(Object.keys(sent).sort(), ['chart', 'referenceType']);
    assert.strictEqual(sent.referenceType, 'hoodies');
    assert.deepStrictEqual([sent.chart.measures, sent.chart.unit, sent.chart.type, sent.chart.sizes.length], ['finished-garment', 'cm', 'hoodies', 4]);
    assert.deepStrictEqual(sent.chart.sizes[2].provenance.chestWidth, { source: 'page-table', header: 'Chest (½)', corrected: false });
    assert.strictEqual(sent.chart.url, 'https://shop.example.test/products/heavyweight-hoodie', 'the canonical address, no tracking');
    await close();
  });

  await test('another product read in the same panel: what was chosen for the last one doesn’t carry over; the same one read again keeps it', async () => {
    const { shop, panel, close } = await open('variants-hoodie.html');
    await view(panel, 'product');
    await panel.selectOption('#p-type', 'sweatshirts');
    await panel.click('#confirm-product');
    await view(panel, 'measure');
    await panel.click('#measure-reread');
    await view(panel, 'product');
    assert.strictEqual(await panel.inputValue('#p-type'), 'sweatshirts', 'the same product, read again');
    await shop.goto(`${SHOP}/shop/html-only-tee.html`);
    await panel.click('#product-reread');
    await panel.waitForFunction(() => document.getElementById('p-name').value === 'Illustrative Pocket Tee');
    assert.strictEqual(await panel.inputValue('#p-type'), 'tshirts', 'a new product: its own kind, from its own name');
    await close();
  });

  section('a page without structured data, with an ambiguous value');

  await test('the product from what the page shows; a range is flagged and blocks until corrected; a correction is sent as the shopper’s; too few comparable measurements is said, with no size', async () => {
    await signIn({ tshirts: TEE });
    const { panel, close } = await open('html-only-tee.html');
    await view(panel, 'product');
    assert.strictEqual(await panel.inputValue('#p-name'), 'Illustrative Pocket Tee');
    assert.strictEqual(await panel.inputValue('#p-brand'), 'Illustrative Goods');
    assert.strictEqual(await panel.inputValue('#p-type'), 'tshirts');
    assert.deepStrictEqual(await panel.$$eval('#p-sizes li', (ns) => ns.map((x) => x.textContent)), ['S', 'M', 'L', 'XL']);
    await toReview(panel);
    assert.strictEqual(await panel.inputValue('#review-unit'), 'in');
    assert.strictEqual(await panel.getAttribute('input[data-role="value"][data-row="2"][data-col="0"]', 'data-problem'), 'range');
    assert.strictEqual(await panel.isDisabled('#to-reference'), true);
    const problems = (await texts(panel, '#review-problems li')).join(' | ');
    assert.match(problems, /aren’t single numbers \(sizes L\)/);
    assert.match(problems, /how the chart measures the body length/);
    await panel.fill('input[data-role="value"][data-row="2"][data-col="0"]', '21.5');
    assert.strictEqual(await panel.getAttribute('input[data-role="value"][data-row="2"][data-col="0"]', 'data-corrected'), 'true');
    await panel.selectOption('select[data-role="method"][data-col="1"]', 'not-stated');
    assert.deepStrictEqual(await texts(panel, '#review-problems li'), []);
    const before = hits.length;
    await toResults(panel, 'tshirts');
    await view(panel, 'results');
    assert.strictEqual(await text(panel, '#result-title'), 'Fynd can’t compare these sizes reliably');
    assert.strictEqual(await panel.isHidden('#result-size'), true, 'no size, not even the closest');
    assert.strictEqual(await panel.$$eval('#result-table tr[data-pick]', (ns) => ns.length), 0);
    assert.ok((await texts(panel, '#result-dims li')).length > 0, 'the reasons, measurement by measurement');
    assert.strictEqual(await text(panel, '#result-reliability'), '');
    assert.match(await text(panel, '#result-source'), /with your corrections/);
    const sent = hits.slice(before).find((h) => h.method === 'POST').body.chart;
    assert.deepStrictEqual(sent.sizes.find((s) => s.size === 'L').provenance.chestWidth, { source: 'page-table', header: 'Body width', corrected: true });
    assert.deepStrictEqual(sent.sizes.find((s) => s.size === 'XL').measurements, { chestWidth: 23.5 }, 'the blank length stays missing');
    await close();
  });

  section('charts Fynd can’t compare as they are');

  await test('a body chart is shown for what it is and can’t be chosen; the measurements can be entered by hand instead', async () => {
    const { panel, close } = await open('body-chart.html');
    await view(panel, 'product');
    await panel.click('#confirm-product');
    await view(panel, 'measure');
    assert.strictEqual(await panel.isDisabled('input[name="chart"]'), true);
    assert.strictEqual(await panel.isHidden('#use-chart'), true);
    assert.match(await text(panel, '#measure-text'), /measures the body each size is for, not the garment/);
    assert.strictEqual(await text(panel, '#charts .fp-kind'), 'Body measurements');
    await panel.click('#manual-entry');
    await view(panel, 'review');
    assert.strictEqual(await text(panel, '#review-title'), 'Enter the measurements');
    await close();
  });

  await test('a chart that doesn’t say what it measures: the shopper must confirm it is the garment’s, and say each method', async () => {
    const { panel, close } = await open('unlabelled.html');
    await toReview(panel);
    assert.match(await text(panel, '#review-kind'), /doesn’t say whether this table measures the garment or the body/);
    assert.strictEqual(await panel.isHidden('#review-confirm-row'), false);
    assert.match((await texts(panel, '#review-problems li')).join(' | '), /Confirm these are the garment’s own measurements/);
    await panel.check('#review-confirm');
    await panel.selectOption('select[data-role="method"][data-col="0"]', FORM.chestWidth);
    await panel.selectOption('select[data-role="method"][data-col="1"]', 'not-stated');
    if (!(await panel.inputValue('#review-unit'))) await panel.selectOption('#review-unit', 'in');
    assert.deepStrictEqual(await texts(panel, '#review-problems li'), []);
    await close();
  });

  await test('no chart and a kind Fynd can’t tell: the shopper chooses the kind, then enters each size by hand — sent as the shopper’s own', async () => {
    await signIn({ tshirts: TEE });
    const { panel, close } = await open('no-chart.html');
    await view(panel, 'product');
    assert.strictEqual(await panel.inputValue('#p-type'), '');
    await panel.click('#confirm-product');
    assert.match(await text(panel, '#product-error'), /Choose what kind of garment this is/);
    await panel.selectOption('#p-type', 'tshirts');
    await panel.click('#confirm-product');
    await view(panel, 'measure');
    assert.match(await text(panel, '#measure-text'), /No size chart found on this page/);
    assert.strictEqual(await panel.isHidden('#use-chart'), true);
    await panel.click('#manual-entry');
    await view(panel, 'review');
    assert.deepStrictEqual(await panel.$$eval('input[data-role="size"]', (ns) => ns.map((x) => x.value)), ['S', 'M', 'L']);
    await panel.check('#review-confirm');
    await panel.selectOption('#review-unit', 'in');
    await panel.fill('input[data-role="value"][data-row="2"][data-col="0"]', '21.5');
    await panel.fill('input[data-role="value"][data-row="2"][data-col="1"]', '19');
    await panel.fill('input[data-role="value"][data-row="2"][data-col="2"]', '29');
    for (const col of ['0', '1', '2', '3']) await panel.selectOption(`select[data-role="method"][data-col="${col}"]`, [FORM.chestWidth, FORM.shoulderWidth, FORM.bodyLength, FORM.sleeveLength][Number(col)]);
    assert.deepStrictEqual(await texts(panel, '#review-problems li'), []);
    await panel.click('#review-add-size');
    await panel.fill('input[data-role="value"][data-row="3"][data-col="0"]', '23');
    assert.match((await texts(panel, '#review-problems li')).join(' | '), /Give every size with measurements its label/);
    await panel.fill('input[data-role="size"][data-row="3"]', 'XL');
    assert.deepStrictEqual(await texts(panel, '#review-problems li'), []);
    const before = hits.length;
    await toResults(panel, 'tshirts');
    await view(panel, 'results');
    const sent = hits.slice(before).find((h) => h.method === 'POST').body.chart;
    assert.deepStrictEqual(sent.sizes.map((s) => s.size), ['L', 'XL']);
    assert.ok(sent.sizes.every((s) => Object.values(s.provenance).every((p) => p.source === 'shopper')));
    assert.strictEqual(await text(panel, '#result-source'), 'Measurements: entered by you from the product’s chart.');
    await close();
  });

  await test('a page with no product: said so, with the choice to enter it by hand — never a product made up', async () => {
    const { panel, close } = await open('not-a-product.html');
    await view(panel, 'problem');
    assert.strictEqual(await text(panel, '#problem-title'), 'No product found on this page');
    assert.strictEqual(await panel.isHidden('#problem-manual'), false);
    await panel.click('#problem-manual');
    await view(panel, 'product');
    assert.strictEqual(await panel.inputValue('#p-name'), '');
    await close();
  });

  section('the shopper’s saved garments');

  await test('signed out: the panel says to sign in on Fynd, links there, and offers to try again — no garment invented', async () => {
    await context.clearCookies();
    const { panel, close } = await open('variants-hoodie.html');
    await toReview(panel);
    await panel.click('#to-reference');
    await view(panel, 'reference');
    await panel.waitForFunction(() => /Sign in to Fynd/.test(document.getElementById('reference-text').textContent));
    assert.strictEqual(await panel.getAttribute('#reference-links a', 'href'), `${API}/account.html`);
    assert.strictEqual(await panel.isHidden('#compare'), true);
    assert.strictEqual(await panel.isHidden('#reference-retry'), false);
    assert.strictEqual(await panel.$$eval('input[name="reference"]', (ns) => ns.length), 0);
    /* signing in, then trying again, lists them */
    await signIn({ hoodies: HOODIE });
    await panel.click('#reference-retry');
    await panel.waitForSelector('input[name="reference"][value="hoodies"]');
    await close();
  });

  await test('signed in with nothing saved: says so and links to add a garment', async () => {
    await signIn(null);
    const { panel, close } = await open('variants-hoodie.html');
    await toReview(panel);
    await panel.click('#to-reference');
    await panel.waitForFunction(() => /no saved garment yet/.test(document.getElementById('reference-text').textContent));
    assert.strictEqual(await panel.getAttribute('#reference-links a', 'href'), `${API}/fit-profile.html`);
    await close();
  });

  await test('several saved: the same kind is chosen first; one of another family is marked as possibly not comparable', async () => {
    await signIn({ hoodies: HOODIE, tshirts: TEE });
    const { panel, close } = await open('variants-hoodie.html');
    await toReview(panel);
    await panel.click('#to-reference');
    await panel.waitForSelector('input[name="reference"]');
    assert.strictEqual(await panel.$eval('input[name="reference"]:checked', (r) => r.value), 'hoodies');
    const tee = await panel.$eval('input[name="reference"][value="tshirts"]', (r) => r.closest('label').textContent);
    assert.match(tee, /A different kind of garment from this product/);
    assert.match(await panel.$eval('input[name="reference"][value="hoodies"]', (r) => r.closest('label').textContent), /Owned Brand hoodie, size L.*Chest width 58 cm/);
    await close();
  });

  section('when the comparison fails');

  async function failing(fault, expect) {
    await signIn({ hoodies: HOODIE });
    const { panel, close } = await open('variants-hoodie.html');
    await toReview(panel);
    faults.push(Object.assign({ path: '/api/size-recommendation', method: 'POST' }, fault));
    await toResults(panel);
    await view(panel, 'error');
    assert.strictEqual(await text(panel, '#error-title'), expect.title);
    if (expect.text) assert.match(await text(panel, '#error-text'), expect.text);
    if (expect.list) assert.deepStrictEqual(await texts(panel, '#error-list li'), expect.list);
    assert.strictEqual(await text(panel, '#error-retry'), expect.retry || 'Try again');
    assert.strictEqual(await panel.isHidden('#result-size'), true);
    return { panel, close };
  }

  await test('a server error: nothing compared, said so; trying again compares', async () => {
    const { panel, close } = await failing({ status: 500, body: { error: 'Could not work out a comparison.' } }, { title: 'Fynd couldn’t compare just now', text: /Nothing was compared/ });
    await panel.click('#error-retry');
    await view(panel, 'results');
    assert.strictEqual(await text(panel, '#result-size'), 'L');
    await close();
  });

  await test('rate limited: says how long to wait, from the server’s Retry-After', async () => {
    const { close } = await failing({ status: 429, body: { error: 'Too many comparisons', reason: 'rate-limited' }, headers: { 'Retry-After': '120' } }, { title: 'Too many comparisons just now', text: /Try again in 2 min/ });
    await close();
  });

  await test('the session ended: sign in again, and choose the garment again', async () => {
    const { panel, close } = await failing({ status: 401, body: { error: 'Sign in', reason: 'sign-in-required' } }, { title: 'Sign in to Fynd', retry: 'Choose your garment again' });
    await panel.click('#error-retry');
    await view(panel, 'reference');
    await close();
  });

  await test('the server refuses the chart: its own messages, listed', async () => {
    const { close } = await failing({ status: 400, body: { error: 'This chart measures the body.', reason: 'body-measurements', errors: [{ field: 'measures', message: 'This chart measures the body.' }] } }, { title: 'Fynd couldn’t read these measurements', list: ['This chart measures the body.'] });
    await close();
  });

  await test('no answer in time: a timeout, nothing compared', async () => {
    const { close } = await failing({ status: 200, delayMs: 2500, body: {} }, { title: 'Fynd didn’t answer in time', text: /Nothing was compared/ });
    await close();
  });

  await test('the saved garments can’t load (5xx): said so, with try again', async () => {
    await signIn({ hoodies: HOODIE });
    const { panel, close } = await open('variants-hoodie.html');
    await toReview(panel);
    faults.push({ path: '/api/fit-profile', method: 'GET', status: 503, body: {} });
    await panel.click('#to-reference');
    await panel.waitForFunction(() => /couldn’t load your fit profile/.test(document.getElementById('reference-text').textContent));
    await panel.click('#reference-retry');
    await panel.waitForSelector('input[name="reference"][value="hoodies"]');
    await close();
  });

  section('the AI-assisted reading (Gemini scripted on this machine)');

  const aiHits = () => hits.filter((h) => h.path === '/api/size-recommendation' && h.search === '?parse=1' && h.method === 'POST');
  async function toMeasure(panel) {
    await view(panel, 'product');
    await panel.click('#confirm-product');
    await view(panel, 'measure');
  }

  await test('a chart Fynd reads on its own takes the fast path: no AI request at all, and the review says it was read automatically', async () => {
    await signIn({ hoodies: HOODIE });
    const before = aiHits().length;
    const calls = gemini.calls;
    const { panel, close } = await open('ai/fast-path.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'review');
    assert.strictEqual(await text(panel, '#review-path'), 'Read automatically from the page.');
    assert.strictEqual(await panel.isHidden('#review-check'), true);
    assert.deepStrictEqual([aiHits().length - before, gemini.calls - calls], [0, 0]);
    await close();
  });

  await test('two heading rows: Fynd asks its AI; the suggestions come back with the page’s own words, and nothing goes on until the shopper confirms them', async () => {
    await signIn({ tshirts: { unit: 'in', chestWidth: 20.5, bodyLength: 28, sleeveLength: 8.25 } });
    gemini.mode = 'answer';
    gemini.model = aiCase('multi-row-header').model;
    const before = aiHits().length;
    const { panel, close } = await open('ai/multi-row-header.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'review');
    assert.strictEqual(aiHits().length - before, 1);
    const sent = aiHits().slice(-1)[0];
    assert.deepStrictEqual(Object.keys(sent.body).sort(), ['table', 'type']);
    assert.deepStrictEqual(sent.body.table.grid[1], ['', '½ width', 'HPS', 'from shoulder seam'], 'the second heading row is sent');
    assert.ok(sent.cookie && sent.origin === EXT_ORIGIN);
    assert.match(await text(panel, '#review-path'), /Fynd’s AI suggested how to read this chart/);
    const list = await texts(panel, '#review-check-list li');
    assert.ok(list.some((t) => /“Chest ½ width” → Chest width, flat, armpit to armpit \(the page says “Chest” and “½ width”\)/.test(t)), list.join(' | '));
    assert.deepStrictEqual(await panel.$$eval('select[data-role="method"]', (ns) => ns.map((x) => x.value)), ['flat-width-armpit-to-armpit', 'high-point-shoulder-to-hem', 'shoulder-seam-to-cuff']);
    assert.strictEqual(await panel.inputValue('#review-unit'), 'in');
    assert.strictEqual(await panel.isDisabled('#to-reference'), true, 'not until confirmed');
    if (process.env.FYND_SHOTS) await panel.screenshot({ path: path.join(process.env.FYND_SHOTS, 'ai-review.png'), fullPage: true });
    assert.match((await texts(panel, '#review-problems li')).join(' '), /Check the reading Fynd’s AI suggested, then confirm it/);
    await panel.check('#review-check-confirm');
    assert.deepStrictEqual(await texts(panel, '#review-problems li'), []);
    const cmpBefore = hits.length;
    await toResults(panel, 'tshirts');
    await view(panel, 'results');
    assert.strictEqual(await text(panel, '#result-size'), 'M', 'the engine decides, from the page’s own numbers');
    assert.match(await text(panel, '#result-source'), /interpreted with Fynd’s AI and confirmed by you\. Not verified by Fynd\./);
    const chart = hits.slice(cmpBefore).find((h) => h.method === 'POST' && h.path === '/api/size-recommendation').body.chart;
    assert.deepStrictEqual(chart.sizes[1].provenance.chestWidth, { source: 'page-table', header: 'Chest ½ width', corrected: false, interpretedBy: 'ai' });
    await close();
  });

  await test('a table Fynd can’t read on its own is offered as “Not read automatically”; the AI’s reading of it comes back for confirming, with what stays open', async () => {
    gemini.mode = 'answer';
    gemini.model = aiCase('unusual-labels').model;
    const { panel, close } = await open('ai/unusual-labels.html');
    await toMeasure(panel);
    assert.strictEqual(await text(panel, '#charts .fp-kind'), 'Not read automatically');
    await panel.click('#use-chart');
    await view(panel, 'review');
    const notes = (await texts(panel, '#review-check-notes li')).join(' | ');
    assert.match(notes, /“Back”/);
    assert.deepStrictEqual(await panel.$$eval('select[data-role="dim"]', (ns) => ns.map((x) => x.value)), ['chestWidth', 'bodyLength', 'sleeveLength']);
    assert.deepStrictEqual(await panel.$$eval('select[data-role="method"]', (ns) => ns.map((x) => x.value)), ['flat-width-armpit-to-armpit', '', '']);
    await close();
  });

  await test('merged headings: the collector lines a merged cell up with its columns before anything is sent', async () => {
    gemini.mode = 'answer';
    gemini.model = aiCase('merged-header').model;
    const { panel, close } = await open('ai/merged-header.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'review');
    assert.deepStrictEqual(aiHits().slice(-1)[0].body.table.grid[0], ['Size', 'Chest', 'Chest', 'Length']);
    assert.match(await text(panel, '#review-path'), /couldn’t find enough on the page/);
    await close();
  });

  await test('text on the page aimed at the AI: the shopper sees that Fynd ignored it, and nothing it asked for is taken', async () => {
    gemini.mode = 'answer';
    gemini.model = aiCase('prompt-injection').model;
    const { panel, close } = await open('ai/prompt-injection.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'review');
    assert.match((await texts(panel, '#review-check-notes li')).join(' | '), /addressed to software.*Fynd ignored it/);
    assert.strictEqual(await panel.inputValue('#review-unit'), '', 'no unit from the injected text');
    assert.strictEqual(await panel.$eval('select[data-role="method"][data-col="1"]', (x) => x.value), '');
    await close();
  });

  await test('the AI unavailable, failing or too slow: Fynd keeps its own reading for the shopper to correct, and says why — never a made-up one', async () => {
    const tryWith = async (setup, expect) => {
      setup();
      const { panel, close } = await open('ai/flat-vs-circumference.html');
      await toMeasure(panel);
      await panel.click('#use-chart');
      await view(panel, 'review');
      assert.match(await text(panel, '#review-path'), expect);
      /* what made Fynd ask is still unresolved: the shopper must check its own reading before going on */
      assert.match((await texts(panel, '#review-check-list li')).join(' '), /couldn’t read part of this chart reliably/);
      assert.match((await texts(panel, '#review-problems li')).join(' '), /Check what Fynd marked as uncertain/);
      /* Fynd's own reading, kept: the stated circumference, the unstated length left to choose */
      assert.deepStrictEqual(await panel.$$eval('select[data-role="method"]', (ns) => ns.map((x) => x.value)), ['garment-circumference', '']);
      await close();
    };
    const key = process.env.GEMINI_API_KEY;
    await tryWith(() => { delete process.env.GEMINI_API_KEY; }, /AI reading isn’t available right now\. Fynd kept its own reading/);
    process.env.GEMINI_API_KEY = key;
    await tryWith(() => { gemini.mode = 'fail'; }, /The AI reading failed\. Fynd kept its own reading/);
    await tryWith(() => { gemini.mode = 'answer'; gemini.model = Object.assign({}, aiCase('flat-vs-circumference').model, { verified: true }); }, /didn’t follow Fynd’s rules, so Fynd ignored it/);
    parseChart.settings.modelTimeoutMs = 50;
    await tryWith(() => { gemini.mode = 'hang'; }, /took too long/);
    parseChart.settings.modelTimeoutMs = 12000;
    await context.clearCookies();
    await tryWith(() => { gemini.mode = 'answer'; gemini.model = aiCase('flat-vs-circumference').model; }, /Sign in to Fynd to use its AI chart reading/);
  });

  await test('REGRESSION merged heading in a real page: a colspan heading is lined up with its columns, so “Length” shows its own values — even with no AI', async () => {
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    await signIn({ hoodies: HOODIE });
    const { panel, close } = await open('ai/merged-header.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'review');
    process.env.GEMINI_API_KEY = key;
    const lengthCol = await panel.$$eval('select[data-role="dim"]', (ns) => ns.find((x) => x.value === 'bodyLength').dataset.col);
    assert.deepStrictEqual(await panel.$$eval(`input[data-role="value"][data-col="${lengthCol}"]`, (ns) => ns.map((x) => x.value)), ['68', '70', '72'], 'never the circumference column’s 100, 106, 112');
    await close();
  });

  await test('REGRESSION injected unit in a real page: text near the table addressed to an AI fills in no unit — and the shopper is told it was ignored', async () => {
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const { panel, close } = await open('ai/prompt-injection.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'review');
    process.env.GEMINI_API_KEY = key;
    assert.strictEqual(await panel.inputValue('#review-unit'), '');
    assert.match((await texts(panel, '#review-check-notes li')).join(' '), /addressed to software/);
    await close();
  });

  await test('a unit stated only near the table, in plain words: filled in for the shopper to check, never silently — the next step waits for the check', async () => {
    gemini.mode = 'answer';
    gemini.model = aiCase('nearby-text-only').model;
    const { panel, close } = await open('ai/nearby-text-only.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'review');
    assert.strictEqual(await panel.inputValue('#review-unit'), '', 'the AI reading doesn’t fill it from nearby text');
    assert.match((await texts(panel, '#review-check-notes li')).join(' '), /Text near the table says “All measurements in centimetres\.”/);
    assert.strictEqual(await panel.$eval('select[data-role="method"][data-col="1"]', (x) => x.value), '');
    await close();
  });

  await test('while the AI reads, the shopper can review it themselves instead', async () => {
    await signIn({ hoodies: HOODIE });
    gemini.mode = 'hang';
    parseChart.settings.modelTimeoutMs = 3000;
    const { panel, close } = await open('ai/fractions-ranges.html');
    await toMeasure(panel);
    await panel.click('#use-chart');
    await view(panel, 'interpreting');
    assert.match(await text(panel, '#interpreting-text'), /how some measurements are taken is written outside the headings/);
    await panel.click('#interpreting-skip');
    await view(panel, 'review');
    assert.strictEqual(await text(panel, '#review-path'), 'Fynd’s own reading, without the AI. Check and correct it.');
    parseChart.settings.modelTimeoutMs = 12000;
    gemini.mode = 'answer';
    await close();
  });

  await test('a body chart is never sent for an AI reading', async () => {
    const before = aiHits().length;
    const { panel, close } = await open('ai/body-chart.html');
    await toMeasure(panel);
    assert.strictEqual(await panel.isHidden('#use-chart'), true);
    assert.strictEqual(aiHits().length, before);
    await close();
  });

  section('what the panel asks of the network');

  await test('every request the panel made went to Fynd’s API, and only to its three endpoints', async () => {
    assert.ok(asked.length > 0);
    const off = asked.filter((u) => !u.startsWith(`${API}/api/fit-profile`) && !u.startsWith(`${API}/api/size-recommendation?compare=1&candidate=1`) && u !== `${API}/api/size-recommendation?parse=1`);
    assert.deepStrictEqual(off, []);
    assert.ok(!hits.some((h) => h.path === '/api/size-recommendation' && h.method === 'GET'), 'never the catalogue lookup');
  });

  await context.close();

  section('the extension as shipped');

  await test('without a toolbar press, the panel reads nothing — it says to click Fynd, and keeps the technical detail', async () => {
    const shipped = await launch(copy(API, false));
    const shop = await shipped.context.newPage();
    await shop.goto(`${SHOP}/shop/variants-hoodie.html`);
    const panel = await shipped.context.newPage();
    await panel.goto(`chrome-extension://${shipped.id}/sidepanel.html`);
    const tabId = await panel.evaluate((u) => new Promise((r) => chrome.tabs.query({}, (tabs) => r((tabs.find((t) => t.url === u || !t.url) || {}).id))), shop.url());
    await panel.goto(`chrome-extension://${shipped.id}/sidepanel.html?tab=${tabId}`);
    await view(panel, 'problem');
    assert.strictEqual(await text(panel, '#problem-title'), 'Click Fynd to read this page');
    assert.match(await text(panel, '#problem-diag'), /"kind": "no-access"/);
    await shipped.context.close();
  });

  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
