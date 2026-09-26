#!/usr/bin/env node
/* =========================================================
   Fynd — search benchmark against the verified catalogue

   Drives the real find-clothes page in a real browser, the way a shopper
   uses it, with the two endpoints answering exactly as a deployment with
   no keys answers: /api/interpret is not deployed (404), so the page's
   own local interpreter reads the request, and /api/search has no
   product source (503), so the page ranks the catalogue itself. Nothing
   in the ranking is stubbed or copied: what is measured is what the
   page renders.

   One natural-language query per catalogue row, none of them the row's
   name verbatim, plus a few with a brand in them. For each: where the
   row lands in the grid, how long the page took, what it said it
   understood, and whether a different garment was shown above it — read
   by the same semantic gate catalogue discovery uses.

   Usage: node scripts/bench-search.js [--json]
   Needs Chromium; exits cleanly with a message if it is not present.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/* one query per row, worded the way a shopper would ask — never the name */
const QUERIES = [
  ['uniqlo-merino-crew', "men's merino wool crew neck sweater"],
  ['jcrew-broken-in-oxford', 'white cotton oxford shirt'],
  ['llbean-venturestretch-chino', 'stretchy chinos for commuting'],
  ['northfold-boxy-cotton-tee', 'white boxy t-shirt'],
  ['halden-merino-crew-knit', 'merino crewneck jumper'],
  ['coveworks-wide-leg-trouser', 'black wide leg trousers'],
  ['atlas-supply-cropped-track-jacket', 'cropped track jacket'],
  ['rue-nine-slip-midi-dress', 'pastel slip dress, midi length'],
  ['terrace-washed-denim-jacket', 'washed denim jacket'],
  ['kinfield-poplin-shirt', 'crisp white poplin shirt for work'],
  ['solstice-ribbed-knit-skirt', 'brown ribbed knit skirt'],
  ['atlas-supply-oversized-hoodie', 'green oversized hoodie'],
  ['halden-tailored-wool-coat', 'tailored wool overcoat'],
  ['coveworks-cargo-utility-pant', 'olive cargo pants'],
  ['rue-nine-silk-column-dress', 'black silk evening dress'],
  ['northfold-court-sneaker', 'white court sneakers'],
  ['terrace-linen-camp-shirt', 'linen camp collar shirt'],
  ['atlas-supply-performance-short', 'black running shorts'],
  ['solstice-colour-block-knit', 'colour block knit sweater'],
  ['kinfield-pleated-midi-skirt', "women's pleated midi skirt"],
  ['terrace-straight-leg-jean', 'straight leg jeans'],
  ['coveworks-cropped-puffer', 'cropped puffer jacket'],
  ['rue-nine-tencel-wrap-top', 'tencel wrap top'],
  ['northfold-heavyweight-pocket-tee', 'heavyweight pocket t-shirt'],
  ['halden-double-breasted-blazer', 'double breasted blazer'],
  ['solstice-printed-maxi-dress', 'printed maxi dress'],
  ['kinfield-fleece-sweatpant', 'fleece sweatpants']
];

/* a brand beside the garment: the brand's other rows must not outrank it */
const BRAND_QUERIES = [
  ['halden-double-breasted-blazer', 'halden double breasted blazer'],
  ['coveworks-wide-leg-trouser', 'coveworks wide leg trousers'],
  ['northfold-court-sneaker', 'northfold court sneakers'],
  ['solstice-printed-maxi-dress', 'solstice printed maxi dress']
];

/* worded differently again, and never used while tuning: a check that
   the ranking generalises rather than fits the list above */
const HELD_OUT = [
  ['coveworks-cropped-puffer', 'short puffy jacket'],
  ['halden-double-breasted-blazer', 'womens tailored blazer double-breasted'],
  ['kinfield-pleated-midi-skirt', 'pleated skirt for the office'],
  ['terrace-straight-leg-jean', 'blue straight jeans'],
  ['rue-nine-slip-midi-dress', 'satin slip dress'],
  ['atlas-supply-oversized-hoodie', 'heavyweight hoodie'],
  ['coveworks-cargo-utility-pant', 'utility cargo trousers'],
  ['northfold-heavyweight-pocket-tee', 'thick tee with a pocket'],
  ['terrace-linen-camp-shirt', 'blue linen shirt for the weekend'],
  ['kinfield-fleece-sweatpant', 'comfy fleece joggers']
];

function catalogue() {
  const context = { window: {}, console };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(REPO, 'assets', 'catalog.js'), 'utf8')};this.__rows = DEMO_PRODUCTS;`, context);
  return context.__rows;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt' };

/* the site, with the API answering as an unconfigured deployment does */
function serve() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/interpret') { res.writeHead(404); return res.end(); }
    if (url === '/api/search') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"no product source is configured"}'); }
    if (url.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    const file = path.join(REPO, url === '/' ? 'find-clothes.html' : decodeURIComponent(url));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function run() {
  let chromium;
  try {
    chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
  } catch (err) {
    console.log('Playwright is not available here — the benchmark needs a real browser.');
    return null;
  }
  const extractor = require('./fetch-catalog-images.js');
  const rows = catalogue();
  const byUrl = new Map(rows.map((row) => [row.productUrl, row]));
  const byId = new Map(rows.map((row) => [row.id.replace(/^sample-/, ''), row]));

  const server = await serve();
  const browser = await chromium.launch({ executablePath: fs.existsSync(CHROME) ? CHROME : undefined });
  const page = await browser.newPage();
  /* The page is wired to its production API host by a meta tag. Its
     interpreter and search are answered, wherever the page sends them,
     as an unconfigured deployment answers; anything else off-origin —
     retailer photos — is not what is being measured. */
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    const where = new URL(route.request().url()).pathname;
    if (/\/api\/search$/.test(where)) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"no product source is configured"}' });
    if (/\/api\//.test(where)) return route.fulfill({ status: 404, body: '' });
    return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/find-clothes.html`);

  const ask = async (query) => {
    await page.fill('#ask', query);
    const started = Date.now();
    await page.click('#ask-form button[type="submit"]');
    await page.waitForFunction(() => {
      const results = document.getElementById('results');
      return results && !results.hidden && !results.querySelector('.thinking') && (results.querySelector('.item-card') || results.querySelector('.empty'));
    }, null, { timeout: 20000 });
    const ms = Date.now() - started;
    const shown = await page.$$eval('#results .item-card', (cards) => cards.map((card) => ({
      url: card.getAttribute('href'), name: card.querySelector('.item-name').textContent.trim()
    })));
    const understood = await page.$$eval('#results .understood span:not(.understood-label)', (chips) => chips.map((chip) => chip.textContent.trim()));
    return { ms, shown, understood };
  };

  const measure = async (id, query) => {
    const target = byId.get(id);
    const { ms, shown, understood } = await ask(query);
    const ids = shown.map((one) => (byUrl.get(one.url) || { id: `?${one.name}` }).id.replace(/^sample-/, ''));
    const at = ids.indexOf(id);
    /* read by the gate discovery uses: the query as the row, the shown
       item's name as the listing */
    const asked = { id: 'query', name: query, category: target.category };
    const verdictOf = (name) => { try { return extractor.semanticMatch(asked, { title: name }); } catch (err) { return { ok: false, kind: 'error' }; } };
    const above = shown.slice(0, at < 0 ? shown.length : at);
    const wrongAbove = above.filter((one) => { const v = verdictOf(one.name); return !v.ok && v.kind === 'contradiction'; }).map((one) => one.name);
    const top = shown[0] ? verdictOf(shown[0].name) : null;
    return { id, query, rank: at < 0 ? null : at + 1, shown: ids, understood, wrongAbove, top: shown[0] ? { name: shown[0].name, verdict: top.kind } : null, ms, target: target.name };
  };

  const results = [];
  for (const [id, query] of QUERIES) results.push(await measure(id, query));
  const branded = [];
  for (const [id, query] of BRAND_QUERIES) branded.push(await measure(id, query));
  const heldOut = [];
  for (const [id, query] of HELD_OUT) heldOut.push(await measure(id, query));

  await browser.close();
  server.close();
  return { results, branded, heldOut };
}

function summarise({ results, branded, heldOut }) {
  const n = results.length;
  const top1 = results.filter((r) => r.rank === 1).length;
  const top3 = results.filter((r) => r.rank && r.rank <= 3).length;
  const found = results.filter((r) => r.rank).length;
  const mrr = results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n;
  const wrong = results.filter((r) => r.wrongAbove.length).length;
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  return { n, top1, top3, found, mrr: Number(mrr.toFixed(3)), wrongAbove: wrong, p50: ms[Math.floor(n / 2)], max: ms[n - 1],
    brandTop1: branded.filter((r) => r.rank === 1).length, brandN: branded.length,
    heldTop1: (heldOut || []).filter((r) => r.rank === 1).length, heldTop3: (heldOut || []).filter((r) => r.rank && r.rank <= 3).length, heldN: (heldOut || []).length };
}

if (require.main === module) {
  run().then((out) => {
    if (!out) return;
    if (process.argv.includes('--json')) { console.log(JSON.stringify(Object.assign(out, { summary: summarise(out) }), null, 2)); return; }
    const line = (r) => `${String(r.rank || '—').padStart(2)}  ${r.query.padEnd(38)} ${r.target.padEnd(28)} ${String(r.ms).padStart(4)}ms  `
      + `understood [${r.understood.join(', ')}]${r.wrongAbove.length ? `  WRONG ABOVE: ${r.wrongAbove.slice(0, 3).join(' | ')}` : ''}`;
    console.log('\nrank query                                  target                        latency');
    out.results.forEach((r) => console.log(line(r)));
    console.log('\nwith a brand:');
    out.branded.forEach((r) => console.log(line(r)));
    console.log('\nheld out (worded differently, not used while tuning):');
    out.heldOut.forEach((r) => console.log(line(r)));
    const s = summarise(out);
    console.log(`\n${s.top1}/${s.n} ranked first, ${s.top3}/${s.n} in the top 3, ${s.found}/${s.n} shown at all; MRR ${s.mrr}; `
      + `${s.wrongAbove} with a different garment above the target; latency p50 ${s.p50}ms, max ${s.max}ms; brand queries ${s.brandTop1}/${s.brandN} first; `
      + `held out ${s.heldTop1}/${s.heldN} first, ${s.heldTop3}/${s.heldN} in the top 3\n`);
  }).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { run, summarise, QUERIES, BRAND_QUERIES, HELD_OUT };
