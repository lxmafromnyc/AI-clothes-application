#!/usr/bin/env node
/* =========================================================
   Fynd — a merchant's own catalogue: config, import, validation,
   duplicates, search, sizing apart from listing, and that test data
   never reaches customers
   Offline, no key:
     node scripts/test-merchant-catalog.js

   Every product here is a FIXTURE: scripts/fixtures/merchant/ holds an
   invented merchant ("FIXTURE Northwind Apparel"), its config marked
   "fixture": true, and its exports — 62 variant rows of 7 products
   (northwind-variants.csv), the same products as a structured feed
   (northwind-feed.json), and a file of broken rows, one fault each
   (northwind-invalid.csv). Every host is on the reserved .example
   domain. Catalogues are written to a temporary directory only.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures/merchant');
const CONFIG = path.join(FIX, 'northwind-merchant.json');
const CSV = path.join(FIX, 'northwind-variants.csv');
const FEED = path.join(FIX, 'northwind-feed.json');
const INVALID = path.join(FIX, 'northwind-invalid.csv');
const DATA = path.join(REPO, 'api/_catalog/data');

const { createMerchantSource, validateConfig } = require('../api/_catalog/sources/merchant');
const { read } = require('../api/_catalog/import');
const store = require('../api/_catalog/store');
const registry = require('../api/_catalog/merchants');
const { main } = require('./sync-catalog');

const out = (text) => process.stdout.write(text);
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    out(`  ok    ${name}\n`);
  } catch (err) {
    failures.push(name);
    out(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 8).join('\n        ')}\n`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-merchant-'));
const config = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const writeJson = (name, value) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(value)); return f; };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const NOW = new Date().toISOString();

/* one CLI run, in this process, with its own output files */
async function sync(name, args, env) {
  const logs = [];
  const errors = [];
  const files = { out: path.join(tmp, `${name}.json`), status: path.join(tmp, `${name}.status.json`), report: path.join(tmp, `${name}.report.json`) };
  const code = await main(args.concat(['--out', files.out, '--status', files.status, '--report', files.report, '--now', NOW]), { env: env || {}, log: (l) => logs.push(l), error: (l) => errors.push(l) });
  return Object.assign({ code, logs: logs.join('\n'), errors: errors.join('\n') }, files);
}
const importCsv = (name, extra, cfg) => sync(name, ['--merchant', cfg || CONFIG, '--file', CSV, '--complete', '--allow-fixture'].concat(extra || []));

/* a fresh process, so the registry and brands load from the env given */
function inChild(env, code) {
  const childEnv = Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME }, env);
  const js = `(async () => { ${code} })().then((v) => process.stdout.write(JSON.stringify(v)), (e) => { console.error(e && e.stack); process.exit(1); });`;
  return JSON.parse(execFileSync(process.execPath, ['-e', js], { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString());
}

(async () => {
  out('Merchant catalogues\n\n');

  /* ---------- the config ---------- */

  await test('the fixture config is valid, and makes a source the catalogue components can use', () => {
    assert.deepStrictEqual(validateConfig(config()), []);
    const s = createMerchantSource(config());
    assert.deepStrictEqual([s.id, s.brand, s.merchant, s.fixture, s.market, s.currency], ['northwind-fixture', 'FIXTURE Northwind Apparel', true, true, 'US', 'USD']);
    assert.deepStrictEqual(s.LICENSED, ['images', 'colours', 'sizes', 'price', 'stock', 'description']);
    assert.deepStrictEqual(s.FEED_HOSTS, [], 'nothing is ever fetched for a merchant');
  });

  await test('a config that can\'t be used names each problem: id, hosts, authorization, fields, brands, categories', () => {
    const bad = (change, field) => {
      const c = config();
      change(c);
      const errs = validateConfig(c).map((e) => e.field);
      assert.ok(errs.includes(field), `${field} expected in ${JSON.stringify(errs)}`);
      assert.throws(() => createMerchantSource(c));
    };
    bad((c) => { c.id = 'Bad_ID'; }, 'id');
    bad((c) => { c.id = 'uniqlo'; }, 'id');
    bad((c) => { c.productPages.hosts = ['https://www.northwind.example']; }, 'productPages.hosts');
    bad((c) => { c.productPages.hosts = ['10.0.0.8']; }, 'productPages.hosts');
    bad((c) => { c.imageHosts = ['localhost']; }, 'imageHosts');
    bad((c) => { delete c.productPages.codeInPath; }, 'productPages.codeInPath');
    bad((c) => { delete c.authorization; }, 'authorization');
    bad((c) => { c.authorization.grantedBy = ' '; }, 'authorization.grantedBy');
    bad((c) => { c.authorization.grantedAt = '1 Jan 2026'; }, 'authorization.grantedAt');
    bad((c) => { c.authorization.expiresAt = '2025-12-31'; }, 'authorization.expiresAt');
    bad((c) => { c.authorization.licensedFields = ['photos']; }, 'authorization.licensedFields');
    bad((c) => { c.brands = ['Acme', 'acme']; }, 'brands');
    bad((c) => { c.currency = 'usd'; }, 'currency');
    bad((c) => { c.categories = { Hats: 'headwear' }; }, 'categories');
    bad((c) => { c.fixture = 'yes'; }, 'fixture');
  });

  /* ---------- import: one row per variant ---------- */

  await test('the CSV export — 62 variant rows — becomes 7 products, each variant kept under its product', async () => {
    const r = await importCsv('csv');
    assert.strictEqual(r.code, 0, r.errors);
    const cat = readJson(r.out);
    assert.strictEqual(cat.products.length, 7);
    const report = readJson(r.report);
    assert.deepStrictEqual([report.ok, report.report.read, report.report.rejected, report.report.duplicateCount], [true, 7, 0, 0]);
    const hoodie = cat.products.find((p) => p.code === 'NW-HD-1001');
    assert.deepStrictEqual([hoodie.name, hoodie.brand, hoodie.line, hoodie.url], ['Heavyweight Pullover Hoodie', 'FIXTURE Northwind', 'men', 'https://www.northwind.example/products/NW-HD-1001']);
    assert.deepStrictEqual(hoodie.colours.map((c) => [c.code, c.name]), [['BLK', 'Black'], ['HGR', 'Heather Grey']]);
    assert.deepStrictEqual(hoodie.sizes, ['S', 'M', 'L', 'XL']);
    assert.strictEqual(hoodie.variants.length, 8, '2 colours × 4 sizes');
    assert.ok(hoodie.images.every((u) => u.startsWith('https://images.northwind.example/p/NW-HD-1001/')));
    assert.deepStrictEqual(hoodie.price, { currency: 'USD', amount: 6800, was: null });
    /* the merchant's own category words first, then the general rules */
    assert.strictEqual(hoodie.category, 'sweatshirts-hoodies', '"Fleece" is mapped by the config');
    assert.strictEqual(cat.products.find((p) => p.code === 'NW-HB-5001').category, 'outerwear', '"Workwear" is mapped by the config');
    assert.strictEqual(cat.products.find((p) => p.code === 'NW-PT-4001').category, 'pants');
    /* a sale price and its was-price, in minor units */
    assert.deepStrictEqual(cat.products.find((p) => p.code === 'NW-HD-1002').price, { currency: 'USD', amount: 5900, was: 7400 });
    /* stock exactly as the merchant reported it, per variant */
    const states = new Set(cat.products.flatMap((p) => p.variants.map((v) => v.availability)));
    assert.deepStrictEqual([...states].sort(), ['in_stock', 'limited', 'out_of_stock']);
  });

  await test('the snapshot keeps its source and the merchant\'s authorization, and is marked as the fixture it is', async () => {
    const r = await importCsv('attribution');
    const cat = readJson(r.out);
    assert.deepStrictEqual([cat.format, cat.source, cat.merchant, cat.fixture, cat.sourceKind], ['fynd-catalog', 'northwind-fixture', 'northwind-fixture', true, 'file']);
    assert.strictEqual(cat.sourceName, 'FIXTURE Northwind Apparel — supplied by the merchant');
    assert.strictEqual(cat.licence, 'FIXTURE test authorization (not an agreement)');
    assert.deepStrictEqual(cat.authorization, { grantedBy: 'FIXTURE — nobody: this is test data', reference: 'FIXTURE test authorization (not an agreement)', grantedAt: '2026-01-01', expiresAt: null, licensedFields: ['images', 'colours', 'sizes', 'price', 'stock', 'description'] });
    assert.deepStrictEqual(cat.licensed, ['colours', 'description', 'images', 'price', 'sizes', 'stock']);
    assert.strictEqual(readJson(r.status).lastAttemptOk, true);
  });

  await test('price and stock only when licensed: a merchant authorizing photos, colours and sizes only gets neither, and --licensed can\'t widen it', async () => {
    const c = config();
    c.authorization.licensedFields = ['images', 'colours', 'sizes'];
    const narrow = writeJson('cfg-narrow.json', c);
    const r = await importCsv('narrow', [], narrow);
    assert.strictEqual(r.code, 0, r.errors);
    const cat = readJson(r.out);
    cat.products.forEach((p) => {
      assert.ok(p.colours && p.sizes && p.images, 'what is licensed is kept');
      ['price', 'wasPrice', 'availability', 'sizeAvailability', 'variants', 'description'].forEach((k) => assert.strictEqual(p[k], undefined, `${p.code} keeps no ${k}`));
    });
    const wider = await importCsv('wider', ['--licensed', 'images,price'], narrow);
    assert.strictEqual(wider.code, 2);
    assert.ok(/doesn't cover/.test(wider.errors), wider.errors);
    /* narrowing is allowed */
    const fewer = await importCsv('fewer', ['--licensed', 'images']);
    assert.strictEqual(fewer.code, 0, fewer.errors);
    assert.ok(readJson(fewer.out).products.every((p) => p.images && !p.colours && !p.sizes && !p.price));
  });

  await test('the structured JSON export gives the same products as the CSV', async () => {
    const csv = readJson((await importCsv('same-csv')).out);
    const json = await sync('same-json', ['--merchant', CONFIG, '--file', FEED, '--allow-fixture']);
    assert.strictEqual(json.code, 0, json.errors);
    const cat = readJson(json.out);
    const key = (p) => [p.code, p.name, p.brand, p.category, p.line, p.sizes.join('/'), p.colours.map((c) => c.code).join('/'), p.url].join('|');
    assert.deepStrictEqual(cat.products.map(key), csv.products.map(key));
    assert.strictEqual(cat.feedFormat, 'fynd-catalog-feed/1');
  });

  /* ---------- validation and duplicates ---------- */

  await test('every broken row is refused with its own reason, naming its rows; a dropped photo or price keeps the product, said in the notes', () => {
    const source = createMerchantSource(config());
    const r = read(fs.readFileSync(INVALID, 'utf8'), source, { licensed: source.LICENSED });
    const why = r.rejected.map((x) => [x.code || null, x.rows ? x.rows.join() : `row ${x.row}`, x.error]);
    assert.deepStrictEqual(why, [
      ['NW-HD-1001', 'row 2', 'the row id (SKU) NW-HD-1001-BLK-S is already used by an earlier row'],
      ['NW-HD-1001', 'row 3', 'the same colour and size as an earlier row of NW-HD-1001'],
      ['NW-HD-1001', 'row 4', 'a different brand from NW-HD-1001’s earlier rows'],
      [null, 'row 5', 'a row for merchant "another-merchant", not northwind-fixture'],
      [null, 'row 6', 'item_group_id (or id) is not the brand’s exact product ID'],
      ['NW-TS-3009', '7', 'no product page on the brand’s own site carrying this product’s ID'],
      ['NW-TS-3010', '8', 'no product page on the brand’s own site carrying this product’s ID'],
      ['NW-TS-3012', '10', 'no plain-text name (≤ 160 characters, no markup or control characters)'],
      ['NW-TS-3013', '11', 'no line (men, women, unisex, kids or baby)'],
      ['NW-TS-3014', '12', 'a brand this merchant isn’t authorized to list (or none, where it lists several)']
    ]);
    assert.deepStrictEqual(r.products.map((p) => p.code), ['NW-HD-1001', 'NW-TS-3011', 'NW-TS-3015']);
    assert.strictEqual(r.products.find((p) => p.code === 'NW-TS-3011').images, undefined, 'the off-host photo is dropped');
    assert.strictEqual(r.products.find((p) => p.code === 'NW-TS-3015').price, undefined, 'the unreadable price is dropped, never guessed');
    assert.deepStrictEqual(r.notes, [
      'NW-TS-3011: an image off the brand’s image host, or not this product’s, was dropped',
      'NW-TS-3015: a price that isn’t a plain amount in the market’s currency was dropped'
    ]);
  });

  await test('an export this broken is refused whole: nothing written, the report and status say why', async () => {
    const r = await sync('invalid', ['--merchant', CONFIG, '--file', INVALID, '--allow-fixture']);
    assert.strictEqual(r.code, 1);
    assert.ok(/too-many-rejected/.test(r.errors), r.errors);
    assert.strictEqual(fs.existsSync(r.out), false, 'no catalogue written');
    const report = readJson(r.report);
    assert.deepStrictEqual([report.ok, report.reason, report.written, report.report.rejected], [false, 'too-many-rejected', null, 10]);
    assert.strictEqual(readJson(r.status).lastAttemptOk, false);
  });

  await test('one duplicate SKU in a good export: that row is refused, the rest imported, and the report names it', async () => {
    const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
    const dup = lines[1].replace(/,S,68\.00 USD/, ',M,68.00 USD');
    assert.notStrictEqual(dup, lines[1]);
    const file = path.join(tmp, 'one-dup.csv');
    fs.writeFileSync(file, `${lines.concat([dup]).join('\n')}\n`);
    const r = await sync('one-dup', ['--merchant', CONFIG, '--file', file, '--complete', '--allow-fixture']);
    assert.strictEqual(r.code, 0, r.errors);
    const report = readJson(r.report).report;
    assert.deepStrictEqual([report.read, report.rejected], [7, 1]);
    assert.ok(/already used by an earlier row/.test(report.rejectedRows[0].error));
    assert.strictEqual(readJson(r.out).products.find((p) => p.code === 'NW-HD-1001').variants.length, 8, 'the duplicate added nothing');
  });

  await test('the same product twice in a structured export is listed once, and counted as a duplicate', () => {
    const feed = readJson(FEED);
    feed.products.push(Object.assign({}, feed.products[0], { name: 'A second entry under the same code' }));
    const source = createMerchantSource(config());
    const r = read(JSON.stringify(feed), source, { licensed: source.LICENSED });
    assert.deepStrictEqual(r.duplicates, ['NW-HD-1001']);
    assert.strictEqual(r.products.filter((p) => p.code === 'NW-HD-1001').length, 1);
    assert.strictEqual(r.products.find((p) => p.code === 'NW-HD-1001').name, 'Heavyweight Pullover Hoodie', 'the first is kept');
  });

  await test('another merchant\'s structured export is refused whole', async () => {
    const feed = readJson(FEED);
    feed.source.merchant = 'someone-else';
    const r = await sync('wrong-merchant', ['--merchant', CONFIG, '--file', writeJson('wrong-merchant-feed.json', feed), '--allow-fixture']);
    assert.strictEqual(r.code, 1);
    assert.ok(/wrong-merchant/.test(r.errors), r.errors);
    assert.strictEqual(fs.existsSync(r.out), false);
  });

  await test('nothing is imported outside the authorization\'s dates', async () => {
    const ended = config();
    ended.authorization.grantedAt = '2025-01-01';
    ended.authorization.expiresAt = '2025-12-31';
    const r = await importCsv('ended', [], writeJson('cfg-ended.json', ended));
    assert.strictEqual(r.code, 1);
    assert.ok(/not-authorized/.test(r.errors), r.errors);
    assert.strictEqual(fs.existsSync(r.out), false);
    const future = config();
    future.authorization.grantedAt = '2099-01-01';
    assert.strictEqual((await importCsv('future', [], writeJson('cfg-future.json', future))).code, 1);
  });

  /* ---------- test data never reaches customers ---------- */

  await test('the CLI never writes a test merchant\'s catalogue or status into api/_catalog/data — nothing is created there', async () => {
    const before = fs.readdirSync(DATA).sort();
    const logs = [];
    const code = await main(['--merchant', CONFIG, '--file', CSV, '--complete'], { env: {}, log: (l) => logs.push(l), error: (l) => logs.push(l) });
    assert.strictEqual(code, 2);
    assert.ok(/test merchant \(a fixture\)/.test(logs.join('\n')));
    /* --allow-fixture into the customer-facing path is refused too */
    assert.strictEqual(await main(['--merchant', CONFIG, '--file', CSV, '--allow-fixture'], { env: {}, log: () => {}, error: () => {} }), 2);
    assert.deepStrictEqual(fs.readdirSync(DATA).sort(), before);
  });

  await test('a real merchant\'s config with a fixture export is refused at the customer-facing path', async () => {
    const real = config();
    delete real.fixture;
    const feed = readJson(FEED);
    const before = fs.readdirSync(DATA).sort();
    const code = await main(['--merchant', writeJson('cfg-real.json', real), '--file', writeJson('fixture-feed.json', feed), '--status', path.join(tmp, 'real.status.json')], { env: {}, log: () => {}, error: () => {} });
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(fs.readdirSync(DATA).sort(), before);
  });

  await test('the registry refuses a fixture listed for customers, an unmarked test merchant, and every test merchant in a deployment', () => {
    const quiet = { log: () => {} };
    assert.deepStrictEqual(registry.fromEntries([{ config: config() }], quiet), [], 'a fixture in COMMITTED is never listed');
    const unmarked = config();
    delete unmarked.fixture;
    assert.deepStrictEqual(registry.fromEntries([{ config: unmarked }], Object.assign({ test: true }, quiet)), [], 'a test merchant must be marked');
    const env = { FYND_TEST_MERCHANTS: CONFIG };
    assert.strictEqual(registry.testEntries(env).length, 1);
    assert.deepStrictEqual(registry.testEntries(Object.assign({ VERCEL: '1' }, env)), []);
    assert.deepStrictEqual(registry.testEntries(Object.assign({ NODE_ENV: 'production' }, env)), []);
    assert.deepStrictEqual(registry.load(Object.assign({ NODE_ENV: 'production' }, env)).map((s) => s.id), []);
  });

  await test('the store refuses a fixture snapshot as a merchant\'s committed catalogue', async () => {
    const r = await importCsv('as-committed');
    const real = config();
    delete real.fixture;
    const source = createMerchantSource(real, { committed: () => readJson(r.out) });
    const loaded = store.load(source);
    assert.deepStrictEqual([loaded.state, loaded.why, loaded.products.length], ['invalid', 'fixture', 0]);
  });

  await test('what is committed holds no test data: no merchant listed, no fixture in api/_catalog/data, no fixture name anywhere in api/', () => {
    assert.ok(registry.COMMITTED.every((e) => e.config.fixture !== true));
    fs.readdirSync(DATA).filter((f) => f.endsWith('.json')).forEach((f) => {
      const body = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
      assert.notStrictEqual(body.fixture, true, `${f} is a fixture`);
    });
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    walk(path.join(REPO, 'api')).forEach((f) => {
      const body = fs.readFileSync(f, 'utf8');
      assert.ok(!/northwind/i.test(body), `${path.relative(REPO, f)} mentions the test merchant`);
    });
  });

  await test('as deployed — no test merchant named, or one named in a production environment — Find Fit browses UNIQLO only', () => {
    const plain = inChild({}, 'return require("./api/_sizing/brands").list().map((b) => b.id);');
    assert.deepStrictEqual(plain, ['uniqlo']);
    const r = path.join(tmp, 'deployed.json');
    fs.copyFileSync(path.join(tmp, 'csv.json'), r);
    const prod = inChild({ NODE_ENV: 'production', FYND_TEST_MERCHANTS: CONFIG, FYND_CATALOG_NORTHWIND_FIXTURE: r }, 'return require("./api/_sizing/brands").list().map((b) => b.id);');
    assert.deepStrictEqual(prod, ['uniqlo']);
  });

  /* ---------- in Find Fit's search ---------- */

  const TEST_ENV = { FYND_TEST_MERCHANTS: CONFIG, FYND_CATALOG_NORTHWIND_FIXTURE: path.join(tmp, 'csv.json') };

  await test('imported, the test merchant is a brand Find Fit browses: searched, filtered by category, brand, colour and size, paged and sorted', () => {
    const r = inChild(TEST_ENV, `
      const b = require('./api/_sizing/brands');
      const m = b.get('northwind-fixture');
      const s = (q) => { const r = b.browse(m, q); return { total: r.total, codes: r.products.map((p) => p.code) }; };
      return {
        list: b.list().map((x) => [x.id, x.count]),
        all: s({}), hoodie: s({ q: 'hoodie' }), tees: s({ category: 'tshirts' }), black: s({ colour: 'black' }),
        xs: s({ size: 'XS' }), harbor: s({ vendor: 'fixture-harbor-supply' }), women: s({ line: 'women' }),
        page2: s({ limit: '2', offset: '2' }), cheap: s({ sort: 'price-asc' }), byName: s({ sort: 'name' }),
        facets: b.browse(m, {}).facets
      };`);
    assert.deepStrictEqual(r.list, [['uniqlo', 5], ['northwind-fixture', 7]]);
    assert.strictEqual(r.all.total, 7);
    assert.deepStrictEqual(r.hoodie.codes.slice(0, 2), ['NW-HD-1001', 'NW-HD-1002']);
    assert.deepStrictEqual(r.tees.codes, ['NW-TS-3001', 'NW-TS-3002']);
    assert.deepStrictEqual(r.black.codes.sort(), ['NW-CR-2001', 'NW-HD-1001', 'NW-TS-3001']);
    assert.deepStrictEqual(r.xs.codes.sort(), ['NW-CR-2001', 'NW-HD-1002', 'NW-TS-3002']);
    assert.deepStrictEqual(r.harbor.codes, ['NW-HB-5001']);
    assert.ok(r.women.codes.includes('NW-CR-2001') && r.women.codes.includes('NW-HD-1002'), 'a unisex hoodie is in women\'s too');
    assert.deepStrictEqual([r.page2.total, r.page2.codes.length], [7, 2]);
    assert.deepStrictEqual(r.cheap.codes, ['NW-TS-3001', 'NW-TS-3002', 'NW-CR-2001', 'NW-HD-1002', 'NW-PT-4001', 'NW-HD-1001', 'NW-HB-5001']);
    /* names A–Z: Harbor, Heavyweight, Midweight, Organic, Relaxed, Straight, Zip-Front */
    assert.deepStrictEqual(r.byName.codes, ['NW-HB-5001', 'NW-HD-1001', 'NW-CR-2001', 'NW-TS-3001', 'NW-TS-3002', 'NW-PT-4001', 'NW-HD-1002']);
    assert.deepStrictEqual(r.facets.vendors.map((v) => [v.value, v.count]), [['fixture-harbor-supply', 1], ['fixture-northwind', 6]]);
    assert.deepStrictEqual(r.facets.sorts, ['featured', 'name', 'price-asc', 'price-desc']);
    assert.strictEqual(r.facets.inStock, true);
  });

  await test('listed apart from sized: every product is shown with "no saved chart", and its sizing decision is INSUFFICIENT_DATA — no size from a label', () => {
    const r = inChild(TEST_ENV, `
      const b = require('./api/_sizing/brands');
      const m = b.get('northwind-fixture');
      const cards = b.browse(m, { limit: '48' }).products;
      const d = m.detail('NW-HD-1002');
      return { cards, d };`);
    assert.strictEqual(r.cards.length, 7);
    r.cards.forEach((c) => {
      assert.deepStrictEqual(c.status, { catalogue: 'merchant', chart: 'none', garment: 'none', comparable: false });
      assert.strictEqual(c.holds, 'live-only');
      assert.ok(c.imageUrl.startsWith('https://images.northwind.example/'));
    });
    assert.deepStrictEqual([r.d.sizing.record, r.d.sizing.decision.outcome, r.d.sizing.decision.reasons], [null, 'INSUFFICIENT_DATA', [{ code: 'no-record' }]]);
    assert.strictEqual(r.d.sizes.source, 'FIXTURE Northwind Apparel\'s own catalogue, updated ' + NOW.slice(0, 10) + ' — size labels only, not measurements');
    assert.ok(r.d.missing.includes('fit') && r.d.missing.includes('fabric'));
    assert.deepStrictEqual([r.d.retailer, r.d.brand, r.d.imageHosts, r.d.pageHosts], ['FIXTURE Northwind Apparel', 'FIXTURE Northwind', ['images.northwind.example'], ['www.northwind.example']]);
    assert.deepStrictEqual(r.d.price, { currency: 'USD', amount: 5900, was: 7400, source: r.d.price.source });
    assert.strictEqual(r.d.catalogue.authorization.reference, 'FIXTURE test authorization (not an agreement)');
  });

  await test('through the real endpoint: ?brands=1 lists it, ?brand= searches it, ?brand=&detail= opens a product', () => {
    const r = inChild(TEST_ENV, `
      const handler = require('./api/size-recommendation');
      const call = (query) => new Promise((resolve) => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(p) { resolve({ code: this.code, body: p }); return this; }, end() { resolve({ code: this.code }); } };
        handler({ method: 'GET', query, headers: {} }, res);
      });
      return { brands: await call({ brands: '1' }), search: await call({ brand: 'northwind-fixture', q: 'tee', size: 'XS' }), detail: await call({ brand: 'northwind-fixture', detail: 'NW-TS-3002' }), missing: await call({ brand: 'northwind-fixture', detail: 'NW-XX-0000' }) };`);
    assert.deepStrictEqual(r.brands.body.brands.map((b) => b.id), ['uniqlo', 'northwind-fixture']);
    assert.deepStrictEqual([r.search.code, r.search.body.total, r.search.body.products.map((p) => p.code)], [200, 1, ['NW-TS-3002']]);
    assert.deepStrictEqual([r.search.body.brand.merchant, r.search.body.brand.imageHosts], [true, ['images.northwind.example']]);
    assert.deepStrictEqual([r.detail.code, r.detail.body.product.code, r.detail.body.product.sizing.decision.outcome], [200, 'NW-TS-3002', 'INSUFFICIENT_DATA']);
    assert.strictEqual(r.missing.code, 404);
  });

  await test('prices and stock stop showing after 48 hours, the catalogue after 30 days, and every product once the authorization ends', async () => {
    /* the store reads `now` as a timestamp, as every catalogue caller passes it */
    const days = (n) => Date.now() + n * 86400000;
    const isoDay = (n) => new Date(days(n)).toISOString().slice(0, 10);
    const r = inChild(TEST_ENV, `
      const b = require('./api/_sizing/brands');
      const m = b.get('northwind-fixture');
      const at = (iso) => { const s = m.search({}, iso); return { total: s.total, price: Boolean(s.products[0] && s.products[0].price), stock: s.facets.inStock, notice: m.noticeAt(iso) }; };
      return { now: at(${JSON.stringify(days(0))}), later: at(${JSON.stringify(days(3))}), stale: at(${JSON.stringify(days(31))}) };`);
    assert.deepStrictEqual([r.now.total, r.now.price, r.now.stock, r.now.notice], [7, true, true, null]);
    assert.deepStrictEqual([r.later.total, r.later.price, r.later.stock], [7, false, false]);
    assert.ok(/Prices and stock aren’t shown/.test(r.later.notice));
    assert.deepStrictEqual([r.stale.total], [0]);
    /* an authorization that ends tomorrow: listed today, gone the day after */
    const ending = config();
    ending.authorization.expiresAt = isoDay(1);
    const cfg = writeJson('cfg-ending.json', ending);
    const e = inChild({ FYND_TEST_MERCHANTS: cfg, FYND_CATALOG_NORTHWIND_FIXTURE: path.join(tmp, 'csv.json') }, `
      const m = require('./api/_sizing/brands').get('northwind-fixture');
      return { today: m.search({}).total, after: m.search({}, ${JSON.stringify(days(2))}).total, notice: m.noticeAt(${JSON.stringify(days(2))}) };`);
    assert.deepStrictEqual([e.today, e.after], [7, 0]);
    assert.ok(/authorization .* isn’t current/.test(e.notice), e.notice);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  out(`\n${passed} passed, ${failures.length} failed\n\n`);
  process.exit(failures.length ? 1 : 0);
})();
