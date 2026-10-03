#!/usr/bin/env node
/* =========================================================
   Fynd — the demo recorder's retailer visits

   scripts/demo-retailer-visit.js opens a product at its retailer the way
   the demo recording does: click the card, catch the new tab, give the
   page a short look, come back. Retailers are slow, block robots and
   sometimes never answer, and none of that may stop the recording or the
   next product. These checks drive a real browser against four kinds of
   "retailer" served locally:

     fast    answers at once                      → 'loaded', shown
     slow    answers after 3.5s (inside 5s)       → 'loaded', shown
     never   never answers                        → 'slow', not shown
     no-tab  the click opens no new tab           → 'no-tab'

   Each must come back within its own limits, and a slow or failed visit
   must leave the page ready for the next one.

   Needs Playwright's Chromium (as scripts/test-ui.js does):
     node scripts/test-retailer-visit.js
   ========================================================= */

'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { visitRetailer, LIMITS } = require('./demo-retailer-visit');

let chromium;
for (const t of [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) {
  try { chromium = require(t).chromium; break; } catch (err) { /* next */ }
}
if (!chromium) { console.log('Playwright is not available here — skipping.'); process.exit(0); }

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;
  const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()[0];
  const p = dir && path.join(root, dir, 'chrome-linux', 'chrome');
  return p && fs.existsSync(p) ? p : undefined;
}

const PORT = 8941;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHOP = (name) => `<!doctype html><title>${name} shop</title><body><h1>${name}</h1>${'<p>A product page with enough words on it.</p>'.repeat(5)}</body>`;
const hung = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (url.pathname === '/fynd') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(`<!doctype html><title>Fynd</title><body>
      <a class="card" id="fast" href="${ORIGIN}/shop/fast" target="_blank" rel="noopener">fast</a>
      <a class="card" id="slow" href="${ORIGIN}/shop/slow" target="_blank" rel="noopener">slow</a>
      <a class="card" id="never" href="${ORIGIN}/shop/never" target="_blank" rel="noopener">never</a>
      <a class="card" id="blocked" href="${ORIGIN}/shop/blocked" target="_blank" rel="noopener">blocked</a>
      <a class="card" id="notab" href="${ORIGIN}/shop/notab" onclick="event.preventDefault()">no tab</a>
    </body>`);
  }
  if (url.pathname === '/shop/fast') { res.setHeader('Content-Type', 'text/html'); return res.end(SHOP('Fast')); }
  if (url.pathname === '/shop/slow') {
    return setTimeout(() => { res.setHeader('Content-Type', 'text/html'); res.end(SHOP('Slow')); }, 3500);
  }
  if (url.pathname === '/shop/blocked') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><title>Access Denied</title><body>Access Denied</body>');
  }
  if (url.pathname === '/shop/never') { hung.push(res); return undefined; } /* never answers */
  res.statusCode = 404; return res.end('no');
});

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const browser = await chromium.launch({ executablePath: chromePath() });
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/fynd`);

  const logs = [];
  const visit = async (id, extra) => {
    const href = await page.getAttribute(`#${id}`, 'href');
    const started = Date.now();
    const v = await visitRetailer({
      context, page, href, holdMs: 300, log: (m) => logs.push(m),
      click: () => page.click(`#${id}`), ...(extra || {})
    });
    return { ...v, took: Date.now() - started };
  };
  /* after any visit: only the Fynd tab is left, and it still answers */
  const backOnFynd = async () => {
    assert.strictEqual(context.pages().length, 1, `${context.pages().length} tabs left open`);
    assert.strictEqual(context.pages()[0], page);
    assert.strictEqual(await page.title(), 'Fynd');
  };

  console.log('\nretailer visits');

  await test('A, fast retailer: new tab, loaded, shown, closed', async () => {
    let named = null;
    const v = await visit('fast', { onLoaded: async (tab) => { named = new URL(tab.url()).pathname; } });
    assert.strictEqual(v.kind, 'loaded');
    assert.ok(v.openedAt && v.domAt && v.closedAt);
    assert.strictEqual(named, '/shop/fast', 'onLoaded was not given the real tab');
    assert.ok(v.url.endsWith('/shop/fast'), v.url);
    assert.ok(v.took < 2000, `took ${v.took}ms`);
    await backOnFynd();
  });

  await test('A, slow retailer (3.5s): still inside the 5s limit, loaded and shown', async () => {
    const v = await visit('slow');
    assert.strictEqual(v.kind, 'loaded');
    assert.ok(v.domAt - v.openedAt >= 3000, `DOM after ${v.domAt - v.openedAt}ms`);
    assert.ok(v.took < LIMITS.tab + LIMITS.dom + 1000, `took ${v.took}ms`);
    await backOnFynd();
  });

  await test('B, retailer that never reaches domcontentloaded: reported slow, not shown, back within the limit', async () => {
    const v = await visit('never');
    assert.strictEqual(v.kind, 'slow');
    assert.strictEqual(v.domAt, null);
    assert.ok(v.openedAt, 'the new tab should still have been seen');
    assert.ok(v.took >= LIMITS.dom - 200 && v.took < LIMITS.dom + 1500, `took ${v.took}ms`);
    assert.ok(logs.some((m) => /did not reach domcontentloaded/.test(m)), 'slow page was not logged');
    await backOnFynd();
  });

  await test('…and the next product after a never-loading one opens normally', async () => {
    const v = await visit('fast');
    assert.strictEqual(v.kind, 'loaded');
    await backOnFynd();
  });

  await test('C, click that opens no new tab: reported, nothing shown, back within the tab limit', async () => {
    const v = await visit('notab');
    assert.strictEqual(v.kind, 'no-tab');
    assert.strictEqual(v.openedAt, null);
    assert.strictEqual(v.video, null);
    assert.ok(v.took >= LIMITS.tab - 200 && v.took < LIMITS.tab + 1500, `took ${v.took}ms`);
    assert.ok(logs.some((m) => /opened no new tab/.test(m)), 'missing tab was not logged');
    await backOnFynd();
  });

  await test('…and the next product after a failed click opens normally', async () => {
    const v = await visit('slow');
    assert.strictEqual(v.kind, 'loaded');
    await backOnFynd();
  });

  await test('a bot-check page is reported blocked and not shown', async () => {
    let shown = false;
    const v = await visit('blocked', { onLoaded: async () => { shown = true; } });
    assert.strictEqual(v.kind, 'blocked');
    assert.strictEqual(shown, false);
    await backOnFynd();
  });

  await test('three products in a row with a slow one in the middle all get their turn', async () => {
    const kinds = [];
    for (const id of ['fast', 'never', 'slow']) kinds.push((await visit(id)).kind);
    assert.deepStrictEqual(kinds, ['loaded', 'slow', 'loaded']);
    await backOnFynd();
  });

  await browser.close();
  hung.forEach((res) => res.destroy());
  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
