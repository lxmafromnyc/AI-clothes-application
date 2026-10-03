/* npm test (second half) — npm run collect, end to end, against a local
   stand-in shop: real files over HTTP, real product pages, the real
   collector, Fynd's real photo gates. Nothing here is used by the film.

   The Prada search is built to need every path:
     #1  a Prada bag with a good photo                       → used as listed
     #2  a Prada bag whose card photo is 194px, served from
         ?width=194; the same photo without it is 600px      → its full size
     #3  a Prada bag whose card photo is 194px; its own page
         declares a 600px photo carrying its product code    → the listing page's photo
     #4  a Prada bag whose card photo is 194px and whose
         page offers only that                               → left out
     #5  a Gucci bag with a good photo                       → left out (not Prada)
     #6, #7  Prada bags with good photos                     → used, in their place
   and a second run, with too few Prada results left, must refuse. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { REPO, ROOT } from './shared.mjs';
import { photoProblem } from './photos.mjs';

const require = createRequire(path.join(REPO, 'package.json'));
try { require.resolve('playwright'); } catch (err) {
  console.log('collector test skipped: Playwright is not installed at the repo root (npm i -D playwright)');
  process.exit(0);
}

const DIR = path.join(ROOT, 'out', 'test-collect');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(DIR, 'img'), { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const photo = (name, w, h, hue) => {
  const file = path.join(DIR, 'img', name);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}`, '-vf', `hue=h=${hue}`, '-frames:v', '1', '-q:v', '3', file]);
  return fs.readFileSync(file);
};
const BIG = (n) => photo(`big-${n}.jpg`, 600, 750, n * 23);
const SMALL = (n) => photo(`small-${n}.jpg`, 194, 243, n * 23);

const files = new Map();       /* path → jpeg */
const pages = new Map();       /* path → html */
const words = '<p>' + 'A product page with a full description, the materials, sizes and delivery details. '.repeat(40) + '</p>';
const pageFor = (pathname, name, images) => pages.set(pathname, `<!doctype html><html><head><title>${name}</title>
<link rel="canonical" href="${origin()}${pathname}"><meta property="og:type" content="product">
${images.map((src) => `<meta property="og:image" content="${origin()}${src}">`).join('')}
<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name, image: images.map((src) => `${origin()}${src}`) })}</script>
</head><body><h1>${name}</h1>${words}</body></html>`);

let port = 0;
const origin = () => `http://127.0.0.1:${port}`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, origin());
  /* a CDN that serves the size it is asked for, or the original */
  const rend = /^\/cdn\/rend-(\d+)\.jpg$/.exec(u.pathname);
  if (rend) {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(u.searchParams.has('width') ? files.get(`/small/${rend[1]}`) : files.get(`/big/${rend[1]}`));
  }
  if (files.has(u.pathname)) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(files.get(u.pathname)); }
  if (pages.has(u.pathname)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pages.get(u.pathname)); }
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('<title>Not found</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
port = server.address().port;

/* one search, as the recorder saves it: the API reply and the cards */
function search(slot, query, rows) {
  const products = [];
  const shown = [];
  rows.forEach((r, i) => {
    const productUrl = `${origin()}/products/${r.slug}-${r.code}`;
    pageFor(`/products/${r.slug}-${r.code}`, r.name, r.pageImages || []);
    products.push({ id: String(r.code), name: r.name, brand: r.brand, retailer: r.retailer, price: r.price, currency: 'USD', imageUrl: r.photo, productUrl });
    shown.push({ name: r.name, retailer: r.retailer, href: productUrl, photo: r.photo, width: r.w || 600, height: r.h || 750, check: { kind: 'loaded' } });
  });
  return { slot, query, interpret: null, search: { status: 200, response: { products } }, shown };
}
const big = (code, n) => { files.set(`/img/${code}.jpg`, BIG(n)); return `${origin()}/img/${code}.jpg`; };
const small = (code, n) => { files.set(`/img/${code}-s.jpg`, SMALL(n)); return `${origin()}/img/${code}-s.jpg`; };

const hoodies = Array.from({ length: 9 }, (_, i) => ({
  slug: 'black-oversized-hoodie', code: 1000001 + i, name: `Oversized hoodie ${i + 1}`, brand: `Brand ${i + 1}`,
  retailer: `Shop ${String.fromCharCode(65 + i)}`, price: 40 + i, photo: big(1000001 + i, i)
}));
const dresses = Array.from({ length: 4 }, (_, i) => ({
  slug: 'cream-linen-midi-dress', code: 3000001 + i, name: `Linen midi dress ${i + 1}`, brand: `Maker ${i + 1}`,
  retailer: `Store ${i + 1}`, price: 90 + i, photo: big(3000001 + i, i + 3)
}));
files.set('/big/2000002', BIG(12)); files.set('/small/2000002', SMALL(12));
files.set('/cdn/2000003_main.jpg', BIG(13));
const bags = [
  { slug: 'prada-re-edition-nylon', code: 2000001, name: 'Prada Re-Edition nylon shoulder bag', brand: 'Prada', retailer: 'Resale One', price: 420, photo: big(2000001, 11) },
  { slug: 'prada-tessuto-tote', code: 2000002, name: 'Prada Tessuto tote', brand: 'Prada', retailer: 'Resale Two', price: 380, photo: `${origin()}/cdn/rend-2000002.jpg?width=194`, w: 194, h: 243 },
  { slug: 'prada-saffiano-bag', code: 2000003, name: 'Vintage Prada Saffiano bag', brand: 'Prada', retailer: 'Resale Three', price: 465, photo: small(2000003, 13), w: 194, h: 243, pageImages: ['/cdn/2000003_main.jpg'] },
  { slug: 'prada-mini-bag', code: 2000004, name: 'Prada mini bag', brand: 'Prada', retailer: 'Resale Four', price: 299, photo: small(2000004, 14), w: 194, h: 243 },
  { slug: 'gucci-jackie-bag', code: 2000005, name: 'Gucci Jackie 1961 bag', brand: 'Gucci', retailer: 'Resale Five', price: 480, photo: big(2000005, 15) },
  { slug: 'prada-cleo-bag', code: 2000006, name: 'Prada Cleo bag', brand: 'Prada', retailer: 'Resale Six', price: 495, photo: big(2000006, 16) },
  { slug: 'prada-galleria-bag', code: 2000007, name: 'Prada Galleria bag', brand: 'Prada', retailer: 'Resale Seven', price: 450, photo: big(2000007, 17) }
];
pageFor('/products/prada-mini-bag-2000004', 'Prada mini bag', ['/img/2000004-s.jpg']);

const saved = (bagRows) => ({
  searchedAt: '2026-10-03T00:00:00.000Z', productSource: 'test',
  searches: [
    search('everyday', 'black oversized hoodie under $80', hoodies),
    search('different', 'cream linen midi dress for summer', dresses),
    search('brand', 'vintage Prada bag under $500', bagRows)
  ]
});
/* the collector runs as its own process; this one keeps serving the shop */
const run = (name, bagRows) => new Promise((resolve) => {
  const file = path.join(DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(saved(bagRows)));
  const out = path.join(DIR, name);
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'collect-assets.mjs'), `--search=${file}`, `--public=${out}`, '--allow-loopback'],
    { env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const timer = setTimeout(() => child.kill(), 300000);
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, log, out }); });
});

let passed = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`); }
};

console.log('collector, against a stand-in shop');
const full = await run('full', bags);
const data = full.status === 0 ? JSON.parse(fs.readFileSync(path.join(full.out, 'data', 'captured.json'), 'utf8')) : null;
test('the collection completes and writes captured.json', () => assert.equal(full.status, 0, full.log));
if (data) {
  const bag = data.searches.find((s) => s.id === 'bag');
  const byCode = (code) => bag.products.find((p) => p.url.endsWith(`-${code}`));
  test('the Prada row is #1, #2, #3, #6, #7 in grid order', () => assert.deepEqual(bag.products.map((p) => p.id), ['bag-1', 'bag-2', 'bag-3', 'bag-6', 'bag-7']));
  test('every product in the Prada row is Prada', () => { for (const p of bag.products) assert.match(`${p.brand} ${p.name}`, /prada/i); });
  test('#1 keeps the photo its card showed', () => { const p = byCode(2000001); assert.equal(p.photoUrl, p.listedPhotoUrl); });
  test('#2 uses the same photo at its full size (the ?width=194 taken off)', () => {
    const p = byCode(2000002);
    assert.equal(p.listedPhotoUrl, `${origin()}/cdn/rend-2000002.jpg?width=194`);
    assert.equal(p.photoUrl, `${origin()}/cdn/rend-2000002.jpg`);
    assert.match(p.photoSource, /full size/);
  });
  test('#3 uses the photo its own listing page declares as this product\'s', () => {
    const p = byCode(2000003);
    assert.equal(p.photoUrl, `${origin()}/cdn/2000003_main.jpg`);
    assert.match(p.photoSource, /listing page/);
  });
  test('#4, with no real photo of 320px+ anywhere in its listing, is left out', () => {
    assert.equal(byCode(2000004), undefined);
    assert.ok(data.skipped.some((s) => s.search === 'bag' && s.index === 4 && /no real photograph/.test(s.why)));
  });
  test('#5, a Gucci bag, is left out of the Prada row', () => {
    assert.equal(byCode(2000005), undefined);
    assert.ok(data.skipped.some((s) => s.search === 'bag' && s.index === 5 && /prada/i.test(s.why)));
  });
  test('name, price, link and shop are the listing\'s own, unchanged', () => {
    for (const [code, row] of [[2000002, bags[1]], [2000003, bags[2]]]) {
      const p = byCode(code);
      assert.equal(p.name, row.name); assert.equal(p.price, `$${row.price}`); assert.equal(p.retailer, row.retailer);
      assert.equal(p.url, `${origin()}/products/${row.slug}-${row.code}`);
    }
  });
  test('every photo in the film is a real photograph of 320px+, with its fingerprint', () => {
    for (const s of data.searches) {
      for (const p of s.products) {
        const file = path.join(full.out, p.image);
        assert.equal(photoProblem(file), null, `${p.id}: ${photoProblem(file)}`);
        assert.ok(p.imageWidth >= 320, `${p.id}: ${p.imageWidth}px`);
        assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), p.sha256);
      }
    }
  });
  test('nothing is upscaled: each photo is the size its server sent', () => {
    for (const p of bag.products) assert.equal(p.imageWidth, 600, `${p.id}: ${p.imageWidth}px`);
  });
  test('no photo of a left-out result is kept', () => {
    const kept = fs.readdirSync(path.join(full.out, 'products'));
    assert.ok(!kept.some((f) => /^bag-(4|5)\./.test(f)), kept.join(', '));
  });
}
const few = await run('few', bags.slice(0, 5));
test('with fewer than four Prada results with real photos, the collection refuses', () => {
  assert.notEqual(few.status, 0);
  assert.match(few.log, /only 3 result\(s\) with a real photograph/);
  assert.ok(!fs.existsSync(path.join(few.out, 'data', 'captured.json')));
});

server.close();
fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed` : ''}`);
if (failures.length) process.exit(1);
