#!/usr/bin/env node
/* =========================================================
   Fynd — UNIQLO's catalogue from a Rakuten Product Catalog file

   The whole path a real feed would take, end to end, on a FIXTURE file
   written in Rakuten Advertising's documented format (HDR / 38 pipe-
   delimited fields / TRL; Class 60 clothing attributes; tracking links
   carrying the product's page in `murl`). Every code (E96xxxx) and every
   "FIXTURE" name is invented; nothing here is UNIQLO's data.

     the reader      header, trailer and field count checked; quoted
                     pipes, decimal commas, tracking links, ended
                     products, deltas, the wrong advertiser
     the sync        scripts/sync-catalog.js on the file: thousands of
                     variant lines grouped into products, priced, sized,
                     coloured; a second full file removes what it no
                     longer lists; a delta adds, updates and deletes; a
                     cut-off file changes nothing
     coverage        scripts/catalog-coverage.js, against the feed and a
                     reference list
     Find Fit        the catalogue API over it (search, filters, pages),
                     a product's page (price, colours, sizes, the
                     affiliate link) and its chart through the sizing
                     pipeline; then in Chromium, if present: UNIQLO opens
                     the popup on the synced catalogue, filters, searches,
                     pages, and a product continues into its page

   Offline: nothing is fetched; UNIQLO's pages are never read.

   Usage: node scripts/test-catalog-rakuten.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-rakuten-'));
const MID = '44210';
const SID = '3857120';
const LICENSED = 'images,colours,sizes,price,stock,description';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message.split('\n').slice(0, 12).join('\n        ') : err}`); }
}
const section = (s) => console.log(`\n${s}`);

/* ---------- a FIXTURE feed in Rakuten's format ---------- */

const CATS = [
  ['Men~~Tops~~T-Shirts', 'T-Shirts', 'Male', 'Adult', 9.9],
  ['Men~~Tops~~Sweatshirts & Hoodies', 'Hoodies', 'Male', 'Adult', 39.9],
  ['Women~~Tops~~Sweaters & Cardigans', 'Sweaters', 'Female', 'Adult', 49.9],
  ['Women~~Bottoms~~Jeans', 'Jeans', 'Female', 'Adult', 49.9],
  ['Men~~Bottoms~~Pants', 'Pants', 'Male', 'Adult', 39.9],
  ['Women~~Outerwear~~Jackets & Coats', 'Jackets', 'Female', 'Adult', 89.9],
  ['Kids~~Tops~~T-Shirts', 'T-Shirts', 'Unisex', 'Kids', 7.9],
  ['Men~~Innerwear~~HEATTECH', 'Innerwear', 'Male', 'Adult', 14.9]
];
const COLOURS = [['09', 'BLACK'], ['00', 'WHITE'], ['69', 'NAVY'], ['03', 'GRAY']];
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const code = (i) => `E96${String(i).padStart(4, '0')}-000`;
const page = (c) => `https://www.uniqlo.com/us/en/products/${c}/00`;
const track = (c, extra) => `https://click.linksynergy.com/link?id=FIXTUREID&offerid=${MID}.${c.slice(1, 7)}&type=15&murl=${encodeURIComponent(`${page(c)}${extra || ''}`)}`;
const photo = (c, colour) => `https://image.uniqlo.com/UQ/ST3/AsianCommon/imagesgoods/${c.slice(1, 7)}/item/goodsimages/goods_${colour}_${c.slice(1, 7)}_3x4.jpg`;

/* one variant line, all 38 fields (39 with a Modification) */
function line(c, i, colour, size, o) {
  const opts = o || {};
  const [cats, type, gender, age, base] = CATS[i % CATS.length];
  const [primary, ...secondary] = cats.split('~~');
  const retail = (opts.retail !== undefined ? opts.retail : base).toFixed(2);
  const sale = opts.sale ? opts.sale.toFixed(2) : '';
  const f = new Array(38).fill('');
  f[0] = String(100000 + i);
  f[1] = opts.name || `FIXTURE ${gender === 'Female' ? "Women's" : age === 'Kids' ? "Kids'" : "Men's"} ${type} ${i}`;
  f[2] = `${c.slice(1, 7)}-${colour[0]}-${size}`;
  f[3] = primary;
  f[4] = secondary.join('~~');
  f[5] = opts.url || track(c, `?colorDisplayCode=${colour[0]}`);
  f[6] = photo(c, colour[0]);
  f[7] = track(c);
  f[8] = `FIXTURE short description ${i}`;
  f[9] = opts.long === undefined ? `FIXTURE description of product ${i}.` : opts.long;
  f[12] = opts.decimalComma ? sale.replace('.', ',') : sale;
  f[13] = opts.decimalComma ? retail.replace('.', ',') : retail;
  f[15] = opts.ended || '';
  f[16] = 'UNIQLO';
  f[22] = opts.stock || (size === 'XL' && colour[0] === '03' ? 'out-of-stock' : 'in-stock');
  f[24] = '60';
  f[25] = 'USD';
  f[29] = type;
  f[30] = size;
  f[31] = '100% Cotton';
  f[32] = `${colour[0]} ${colour[1]}`;
  f[33] = gender;
  f[35] = age;
  if (opts.modification) f.push(opts.modification);
  return f.map((v) => (v.includes('|') ? `"${v.replace(/"/g, '""')}"` : v)).join('|');
}
function file(lines, o) {
  const opts = o || {};
  return [`HDR|${opts.mid || MID}|${opts.name || 'FIXTURE UNIQLO USA'}|${opts.at || '10/20/2026 06:00:00'}`, ...lines, `TRL|${opts.count !== undefined ? opts.count : lines.length}`].join('\n');
}
/* every product in 2 colours × 5 sizes = 10 lines */
function catalogue(from, to, o) {
  const lines = [];
  for (let i = from; i < to; i += 1) {
    const c = code(i);
    for (const colour of [COLOURS[i % 4], COLOURS[(i + 1) % 4]]) for (const size of SIZES) lines.push(line(c, i, colour, size, o && o(i)));
  }
  return lines;
}

const PRODUCTS = 2400;
const full = file(catalogue(0, PRODUCTS, (i) => (i % 10 === 0 ? { sale: CATS[i % CATS.length][4] - 5 } : null)));
const feedFile = path.join(tmp, `${MID}_${SID}_mp.txt`);
fs.writeFileSync(feedFile, full);
const out = path.join(tmp, 'uniqlo-us.json');
const statusFile = path.join(tmp, 'uniqlo-us.status.json');

const rakuten = require('../api/_catalog/rakuten');
const adapter = require('../api/_catalog/sources/uniqlo-us');
const { read } = require('../api/_catalog/import');

async function sync(feed, extra) {
  const logs = [];
  const errors = [];
  const code = await require('./sync-catalog').main(['--source', 'uniqlo-us', '--file', feed, '--out', out, '--status', statusFile, '--licensed', LICENSED, '--allow-fixture', '--now', '2026-10-20T07:00:00Z'].concat(extra || []), { env: { RAKUTEN_UNIQLO_MID: MID }, log: (l) => logs.push(l), error: (l) => errors.push(l) });
  return { code, logs: logs.join('\n'), errors: errors.join('\n') };
}
/* the catalogue API, in a child with the synced catalogue as Find Fit's */
function inChild(code) {
  return JSON.parse(execFileSync(process.execPath, ['-e', `(async () => { ${code} })().then((v) => process.stdout.write(JSON.stringify(v)), (e) => { console.error(e); process.exit(1); });`], {
    cwd: REPO,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS || '', FYND_OFFLINE_LOG: process.env.FYND_OFFLINE_LOG || '', FYND_CATALOG_UNIQLO_US: out },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString());
}

(async () => {
  section('reading a Rakuten Product Catalog file');

  await test('a full file: header and trailer checked, each line one variant row, the product’s page taken from the tracking link’s murl', () => {
    const r = rakuten.read(file([line(code(1), 1, COLOURS[0], 'M')]), adapter, { mid: MID });
    assert.deepStrictEqual([r.header.mid, r.header.delta, r.header.declared, r.header.fixture, r.header.generatedAt], [MID, false, 1, true, '2026-10-20T06:00:00.000Z']);
    const row = r.rows[0];
    assert.strictEqual(row.item_group_id, code(1));
    assert.strictEqual(row.link, `${page(code(1))}?colorDisplayCode=09`);
    assert.ok(row.affiliate_link.startsWith('https://click.linksynergy.com/link?'));
    assert.deepStrictEqual([row.color, row.size, row.gender, row.age_group, row.price], ['09 BLACK', 'M', 'Male', 'Adult', '39.90 USD'], 'Class 60’s attributes, by position');
    assert.strictEqual(row.product_type, 'Men > Tops > Sweatshirts & Hoodies > Hoodies');
    /* Rakuten's samples write the destination as http://: UNIQLO's page is taken as https, and nothing else is upgraded */
    assert.strictEqual(rakuten.pages(`http://click.linksynergy.com/link?id=X&murl=${encodeURIComponent('http://www.uniqlo.com/us/en/products/E960001-000/00')}`).page, page('E960001-000'));
    assert.strictEqual(rakuten.pages(`https://click.linksynergy.com/link?id=X&murl=${encodeURIComponent('http://www.example.com/x')}`).page, 'http://www.example.com/x');
  });

  await test('a file cut off — no trailer, or a trailer counting other than its lines — is refused whole', () => {
    const lines = [line(code(1), 1, COLOURS[0], 'M'), line(code(1), 1, COLOURS[0], 'L')];
    assert.throws(() => rakuten.read(file(lines, { count: 3 }), adapter), (e) => e.reason === 'truncated');
    assert.throws(() => rakuten.read(`HDR|${MID}|FIXTURE|10/20/2026 06:00:00\n${lines.join('\n')}`, adapter), (e) => e.reason === 'truncated');
    assert.throws(() => rakuten.read(file(lines, { mid: '999' }), adapter, { mid: MID }), (e) => e.reason === 'wrong-advertiser');
    assert.throws(() => rakuten.read('id|title\n1|x', adapter), (e) => e.reason === 'unknown-format');
  });

  await test('quoted pipes, a decimal comma, a sale price, an ended product, a page off UNIQLO’s site, a tracking link to another product', () => {
    const ok = line(code(2), 2, COLOURS[0], 'M', { name: 'FIXTURE Tee | Organic', decimalComma: true, retail: 19.9, sale: 14.9 });
    const ended = line(code(3), 3, COLOURS[0], 'M', { ended: '01/01/2026 00:00:00' });
    const offsite = line(code(4), 4, COLOURS[0], 'M', { url: `https://click.linksynergy.com/link?id=X&murl=${encodeURIComponent('https://www.example-shop.com/us/en/products/E960004-000/00')}` });
    const r = rakuten.read(file([ok, ended, offsite]), adapter, { now: '2026-10-20T00:00:00Z' });
    assert.deepStrictEqual([r.rows[0].title, r.rows[0].price, r.rows[0].sale_price], ['FIXTURE Tee | Organic', '19.90 USD', '14.90 USD']);
    assert.strictEqual(r.rows[1].status, 'discontinued', 'its End Date has passed');
    assert.strictEqual(r.rows[2].item_group_id, null, 'not a UNIQLO US page: no product code');
    const imported = read(file([ok, ended, offsite]), adapter, { licensed: LICENSED.split(','), now: '2026-10-20T00:00:00Z' });
    assert.deepStrictEqual(imported.products.map((p) => p.code), [code(2)]);
    assert.deepStrictEqual(imported.discontinued, [code(3)]);
    assert.strictEqual(imported.rejected.length, 1);
    assert.deepStrictEqual(imported.products[0].price, { currency: 'USD', amount: 1490, was: 1990 });
    /* the affiliate link is kept only on Rakuten's click host and only when it leads to this product's page */
    const { normalise } = require('../api/_catalog/product');
    const base = { code: code(5), name: 'FIXTURE Tee', url: page(code(5)), category: 'tshirts', line: 'men' };
    assert.strictEqual(normalise(Object.assign({ affiliateUrl: track(code(5)) }, base), adapter, new Set()).product.affiliateUrl, track(code(5)));
    const httpDest = track(code(5)).replace(encodeURIComponent('https://'), encodeURIComponent('http://'));
    assert.strictEqual(normalise(Object.assign({ affiliateUrl: httpDest }, base), adapter, new Set()).product.affiliateUrl, httpDest, 'a destination written as http:// still leads to the page');
    for (const bad of [track(code(6)), track(code(5)).replace('click.linksynergy.com', 'click.example.com'), track(code(5)).replace('https:', 'http:')]) {
      const r = normalise(Object.assign({ affiliateUrl: bad }, base), adapter, new Set());
      assert.ok(r.product && !r.product.affiliateUrl, bad);
    }
  });

  section(`syncing a catalogue-scale file (${PRODUCTS} products, ${PRODUCTS * 10} variant lines)`);

  await test('every line grouped into its product: priced, coloured, sized, in stock per variant, each once', async () => {
    const r = await sync(feedFile);
    assert.strictEqual(r.code, 0, r.errors);
    const cat = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.strictEqual(cat.products.length, PRODUCTS);
    assert.strictEqual(new Set(cat.products.map((p) => p.code)).size, PRODUCTS, 'no product twice');
    const p = cat.products.find((x) => x.code === code(10));
    assert.deepStrictEqual(p.price, { currency: 'USD', amount: 4490, was: 4990 }, 'on sale, from its retail price');
    assert.deepStrictEqual(p.sizes, SIZES);
    assert.strictEqual(p.colours.length, 2);
    assert.ok(p.images.length >= 1 && p.images.every((u) => u.startsWith('https://image.uniqlo.com/')));
    assert.ok(p.affiliateUrl.startsWith('https://click.linksynergy.com/'));
    assert.strictEqual(p.url, page(code(10)));
    assert.ok(cat.products.some((x) => x.variants && x.variants.some((v) => v.availability === 'out_of_stock')));
    assert.match(cat.sourceName, /Rakuten Advertising Product Catalog — FIXTURE UNIQLO USA \(MID 44210\)/);
  });

  await test('what a server holds at this scale: the catalogue file’s size, and how long a cold start takes to load and index it', () => {
    const bytes = fs.statSync(out).size;
    const r = inChild(`const t = Date.now(); const b = require('./api/_sizing/brands'); const u = b.get('uniqlo'); b.browse(u, { q: 'hoodie' }); return { ms: Date.now() - t, n: u.products().length };`);
    console.log(`        ${PRODUCTS} products × 10 variants: ${(bytes / 1024 / 1024).toFixed(1)} MB on disk; loaded, checked and indexed in ${r.ms} ms`);
    assert.strictEqual(r.n, PRODUCTS + 5);
    assert.ok(bytes < 16 * 1024 * 1024, `${bytes} bytes`);
    assert.ok(r.ms < 5000, `${r.ms} ms`);
  });

  await test('coverage is measured against the feed, and against a reference list only when one is given', () => {
    const { measure, report } = require('./catalog-coverage');
    const cat = JSON.parse(fs.readFileSync(out, 'utf8'));
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const m = measure(cat, status, null);
    assert.strictEqual(m.products, PRODUCTS);
    assert.deepStrictEqual([m.fields.price.pct, m.fields.photo.pct, m.fields.sizes.pct, m.fields.affiliateLink.pct], [100, 100, 100, 100]);
    assert.strictEqual(m.againstFeed.read, PRODUCTS);
    assert.match(report(m), /not measured — no independent list of its products was given/);
    const ref = Array.from({ length: PRODUCTS + 100 }, (_, i) => code(i));
    const withRef = measure(cat, status, ref);
    assert.deepStrictEqual([withRef.againstReference.held, withRef.againstReference.missingCount, withRef.againstReference.pct], [PRODUCTS, 100, 96]);
  });

  await test('the next full file: what it no longer lists is removed, new products added, changed prices updated — nothing twice', async () => {
    const next = path.join(tmp, 'next.txt');
    /* products 0–2299 again (100 gone), 2400–2499 new, and product 1's price changed */
    const lines = catalogue(0, 2300, (i) => (i === 1 ? { retail: 44.9 } : null)).concat(catalogue(2400, 2500));
    fs.writeFileSync(next, file(lines, { at: '10/21/2026 06:00:00' }));
    const r = await sync(next);
    assert.strictEqual(r.code, 0, r.errors);
    const cat = JSON.parse(fs.readFileSync(out, 'utf8'));
    const codes = new Set(cat.products.map((p) => p.code));
    assert.strictEqual(cat.products.length, 2400);
    assert.ok(!codes.has(code(2350)) && codes.has(code(2450)));
    assert.strictEqual(cat.products.find((p) => p.code === code(1)).price.amount, 4490);
    assert.ok(cat.removed.some((x) => x.code === code(2350)), 'removed, with its reason, never served');
  });

  await test('a delta file inserts, updates and deletes only what it names', async () => {
    const delta = path.join(tmp, `${MID}_${SID}_mp_delta.txt`);
    const lines = [
      ...SIZES.map((s) => line(code(2600), 2600, COLOURS[0], s, { modification: 'I' })),
      ...SIZES.map((s) => line(code(2), 2, COLOURS[2], s, { retail: 29.9, modification: 'U' })),
      ...[COLOURS[3], COLOURS[0]].flatMap((c) => SIZES.map((s) => line(code(3), 3, c, s, { modification: 'D' })))
    ];
    fs.writeFileSync(delta, file(lines, { at: '10/21/2026 12:00:00' }));
    const r = await sync(delta);
    assert.strictEqual(r.code, 0, r.errors);
    const cat = JSON.parse(fs.readFileSync(out, 'utf8'));
    const by = new Map(cat.products.map((p) => [p.code, p]));
    assert.ok(by.has(code(2600)), 'inserted');
    assert.strictEqual(by.get(code(2)).price.amount, 2990, 'updated');
    assert.ok(!by.has(code(3)), 'deleted');
    assert.strictEqual(cat.products.length, 2400, 'nothing else touched');
  });

  await test('a cut-off file, or another advertiser’s, changes nothing: the catalogue as it was is kept', async () => {
    const before = fs.readFileSync(out, 'utf8');
    const cut = path.join(tmp, 'cut.txt');
    fs.writeFileSync(cut, full.split('\n').slice(0, 5000).join('\n'));
    const r = await sync(cut);
    assert.strictEqual(r.code, 1);
    assert.match(r.errors, /truncated|cut off/);
    const other = path.join(tmp, 'other.txt');
    fs.writeFileSync(other, file(catalogue(0, 5), { mid: '1237', at: '10/22/2026 06:00:00' }));
    assert.strictEqual((await sync(other)).code, 1);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), before);
  });

  section('Find Fit over the synced catalogue');

  /* a fresh sync of the full file, for what follows */
  fs.rmSync(out, { force: true });
  assert.strictEqual((await sync(feedFile)).code, 0);

  await test('the catalogue API pages it, filters by category and line, and searches — the five products Fynd sourced still there', () => {
    const r = inChild(`
      const b = require('./api/_sizing/brands'); const u = b.get('uniqlo');
      const all = b.browse(u, {});
      const tees = b.browse(u, { category: 'tshirts' });
      const women = b.browse(u, { line: 'women' });
      const page2 = b.browse(u, { offset: 24 });
      const q = b.browse(u, { q: 'FIXTURE hoodies 1001' });
      return { total: all.total, first: all.products.length, cats: all.facets.categories.map((c) => c.value).sort(), tees: tees.total, women: women.total, page2: page2.products[0].code !== all.products[0].code, q: q.products.slice(0, 1).map((p) => p.code), coverage: all.brand.coverage, notice: all.brand.notice, five: ['E475378-000','E475377-000','E471808-000','E455365-000','E429066-000'].every((c) => u.find(c)), priced: all.products.filter((p) => p.price).length };`);
    assert.strictEqual(r.total, PRODUCTS + 5);
    assert.strictEqual(r.first, 24);
    assert.ok(r.cats.includes('tshirts') && r.cats.includes('jeans') && r.cats.includes('outerwear') && r.cats.includes('innerwear'), r.cats.join(','));
    assert.strictEqual(r.tees, PRODUCTS / 8 * 2 + 1, 'men’s and kids’ T-shirts, and the SUPIMA tee Fynd sourced');
    assert.strictEqual(r.women, PRODUCTS / 8 * 3 + 2, 'women’s, and the two unisex products Fynd sourced (unisex is offered to both)');
    assert.ok(r.page2);
    assert.deepStrictEqual(r.q, ['E961001-000']);
    assert.match(r.coverage, /^2405 UNIQLO US products from Rakuten Advertising Product Catalog — FIXTURE UNIQLO USA \(MID 44210\), updated 2026-10-20\.$/);
    assert.ok(!/full/i.test(r.coverage));
    assert.strictEqual(r.notice, null, 'no limited-coverage notice once a current catalogue is served');
    assert.ok(r.five);
    assert.ok(r.priced > 0);
  });

  await test('a product’s page carries the feed’s price, colours and sizes, and “View on UNIQLO” is the affiliate link to that same page', () => {
    const r = inChild(`const b = require('./api/_sizing/brands'); const u = b.get('uniqlo'); return u.detail('${code(10)}');`);
    assert.strictEqual(r.code, code(10));
    assert.strictEqual(r.url, page(code(10)));
    assert.ok(r.buyUrl.startsWith('https://click.linksynergy.com/') && decodeURIComponent(r.buyUrl).includes(page(code(10))));
    assert.ok(r.price && r.price.amount === 4490 && r.price.was === 4990, JSON.stringify(r.price));
    assert.strictEqual(r.colours.length, 2);
  });

  await test('choosing one goes through Fynd’s sizing pipeline by its code, and UNIQLO’s page is never read', () => {
    const r = inChild(`
      const chart = require('./api/_sizing/chart');
      const asked = []; chart.setTransport(async (u) => { asked.push(u); throw new Error('offline'); });
      const b = require('./api/_sizing/brands'); const u = b.get('uniqlo');
      const tee = await chart.chartFor(u.find('${code(0)}').url);
      const jeans = await chart.chartFor(u.find('${code(3 + 8)}').url);
      return { tee: [tee.status, tee.charts.map((c) => c.origin)], jeans: [jeans.status, jeans.reason], asked };`);
    assert.deepStrictEqual(r.tee, ['fallback', ['official-general']], 'a men’s tee: UNIQLO’s general chart, labelled as such');
    assert.deepStrictEqual(r.jeans, ['unavailable', 'unreviewed'], 'no chart held, and the page isn’t read: said, not invented');
    assert.deepStrictEqual(r.asked, []);
  });

  await browserTests();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) process.exit(1);
})();

/* ---------- the popup in Chromium, on the synced catalogue ---------- */

async function browserTests() {
  let chromium;
  try { chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium; } catch (err) { console.log('\nPlaywright is not available here — skipping the browser half.'); return; }
  process.env.FYND_CATALOG_UNIQLO_US = out;
  const handler = require('../api/size-recommendation');
  require('../api/_sizing/chart').setTransport(async () => { throw new Error('offline'); });
  const PORT = 8961;
  const ORIGIN = `http://127.0.0.1:${PORT}`;
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    if (url.pathname === '/api/size-recommendation') {
      req.query = Object.fromEntries(url.searchParams);
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (p) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(p)); return res; };
      return handler(req, res);
    }
    if (url.pathname.startsWith('/api/')) { res.statusCode = url.pathname === '/api/account' ? 401 : 503; return res.end('{}'); }
    const f = path.join(REPO, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!f.startsWith(REPO) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
    return res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium', args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  } catch (err) { console.log('\nChromium could not launch here — skipping the browser half.'); server.close(); return; }
  section('the UNIQLO popup, on the synced catalogue (Chromium)');
  try {
    await test('UNIQLO opens straight into the catalogue: 24 of 2,405, category filters, search, more pages, and a product continues into its page with its price', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      context.setDefaultTimeout(10000);
      await context.addInitScript((o) => { window.FINDWEAR_API = `${o}/api/interpret`; }, ORIGIN);
      await context.route((u) => !String(u).startsWith(ORIGIN), (route) => route.abort());
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/index.html`);
      await page.waitForSelector('#fit-browser[data-brands="ready"]');
      assert.match(await page.textContent('.fit-brand-choice[data-brand="uniqlo"]'), /2405 products/);
      await page.click('.fit-brand-choice[data-brand="uniqlo"]');
      await page.waitForSelector('#fit-browser[data-answers="1"]');
      const answered = async (action) => {
        const before = Number(await page.getAttribute('#fit-browser', 'data-answers'));
        await action();
        await page.waitForFunction((n) => Number(document.getElementById('fit-browser').dataset.answers) > n, before);
      };
      assert.strictEqual(await page.$$eval('.fit-product', (b) => b.length), 24);
      assert.match(await page.textContent('#fit-browser-status'), /^Showing 24 of 2405$/);
      assert.strictEqual(await page.isHidden('#fit-catalog-note'), true, 'no limited-coverage notice');
      await answered(() => page.click('#fit-products-more'));
      assert.strictEqual(await page.$$eval('.fit-product', (b) => b.length), 48);
      await answered(() => page.click('.fit-filter[data-group="kind"][data-value="jeans"]'));
      assert.match(await page.textContent('#fit-browser-status'), /of 300$/);
      await answered(() => page.click('.fit-filter[data-group="kind"][data-value="all"]'));
      await answered(() => page.fill('#fit-product-search', 'FIXTURE hoodies 1001'));
      const first = await page.$eval('.fit-product', (b) => b.dataset.code);
      assert.strictEqual(first, 'E961001-000');
      assert.match(await page.textContent('.fit-product[data-code="E961001-000"] .fit-product-price'), /^\$39\.90$/);
      await Promise.all([page.waitForURL(/product\.html\?brand=uniqlo&item=E961001-000/), page.click('.fit-product[data-code="E961001-000"]')]);
      await page.waitForSelector('#product[data-state="ready"]');
      assert.match(await page.getAttribute('#pdp-retailer', 'href'), /^https:\/\/click\.linksynergy\.com\//);
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
}
