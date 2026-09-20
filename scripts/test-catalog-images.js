#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue image extractor test

   scripts/fetch-catalog-images.js reads a product photo off the page a
   catalogue row already links to. It cannot be trusted on the strength
   of having run: the whole point of it is what it REFUSES to write, and
   a refusal only shows up when the wrong thing is offered to it.

   So this offers it the wrong things. A Google Shopping thumbnail, a
   stock library, an http URL, a tracking pixel, an image the host serves
   plainly and refuses to our Referer, and — the one that matters most
   once a browser is involved — a perfectly good photo of a DIFFERENT
   garment on the right retailer's own CDN. Each is put in front of a
   gate that must turn it down. Then the right thing is offered, and the
   file it writes is checked for having changed nothing but the one
   field.

   The browser path is exercised for real: a local server plays a
   retailer that refuses plain HTTP and builds its gallery in JavaScript,
   and Chromium is sent at it exactly as the extractor would. No retailer
   is contacted, so this runs anywhere, including behind a proxy that
   refuses every host on the internet.

   Usage: node scripts/test-catalog-images.js
   Skips the browser section with a clear message if Playwright is absent.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const extractor = require('./fetch-catalog-images');
/* named for what it is, because the async section below already
   binds `source` to the catalogue file's text */
const productSource = require('../api/_providers/product-source');

const SCRIPT = path.join(__dirname, 'fetch-catalog-images.js');
const CATALOG = path.join(__dirname, '..', 'assets', 'catalog.js');

async function run(argv) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [SCRIPT, ...argv], { env: process.env, timeout: 120000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code === undefined ? 1 : err.code, stdout: err.stdout || '', stderr: err.stderr || String(err.message) };
  }
}

let passed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

const UNIQLO = 'https://www.uniqlo.com/us/en/products/E429066-000/00';
const ZARA = 'https://www.zara.com/us/en/oxford-shirt-p06887613.html';
const LEVIS = 'https://www.levi.com/US/en_US/chino-pants/levis-chino-pants-for-men/levis-xx-chino-standard-taper-fit-mens-pants/p/171960005';

const urls = (list) => list.map((c) => c.url);

/* ---------------------------------------------------------
   Fixtures, in the shapes retailers actually publish
   --------------------------------------------------------- */

const withJsonLd = `<!doctype html><html><head>
<link rel="canonical" href="${UNIQLO}">
<meta property="og:image" content="https://image.uniqlo.com/og-429066.jpg">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"BreadcrumbList","itemListElement":[]},
  {"@type":"Product","sku":"E429066-000","name":"Merino Crew","image":["https://image.uniqlo.com/goods/429066/item/main.jpg"]}
]}
</script></head><body></body></html>`;

const ogOnly = `<!doctype html><html><head>
<meta content="https://static.zara.net/photos/6887613250_1_1_1.jpg?ts=1&amp;w=1200" property="og:image">
</head><body></body></html>`;

const preloadOnly = `<!doctype html><html><head>
<link rel="preload" as="image" imagesrcset="https://lsco.scene7.com/is/image/levis/171960005-small.jpg 400w, https://lsco.scene7.com/is/image/levis/171960005-large.jpg 1600w">
</head><body></body></html>`;

const aggregatorOnly = `<!doctype html><html><head>
<meta property="og:image" content="https://encrypted-tbn0.gstatic.com/shopping?q=tbn:merino">
</head><body></body></html>`;

/* ---------------------------------------------------------
   A local image host, so the loadable gate can be exercised
   --------------------------------------------------------- */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8000, 0x20)]);

function imageHost() {
  const server = http.createServer((req, res) => {
    const referred = Boolean(req.headers.referer);
    if (req.url === '/photo.jpg') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPEG);
    }
    if (req.url === '/hotlinked.jpg') {
      if (referred) { res.writeHead(403); return res.end('no'); }
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPEG);
    }
    if (req.url === '/pixel.gif') {
      res.writeHead(200, { 'content-type': 'image/gif' });
      return res.end(Buffer.alloc(43, 0));
    }
    if (req.url === '/notanimage.jpg') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html>a consent wall</html>');
    }
    res.writeHead(404);
    res.end('gone');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ---------------------------------------------------------
   A local retailer that refuses plain HTTP and needs a browser

   It answers 403 to anything without a browser's Accept header, and its
   product markup does not exist until its script runs — which is exactly
   the shape that defeats the plain path and needs Chromium.
   --------------------------------------------------------- */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC',
  'base64'
);

/* A retailer that publishes everything a product page should: a
   canonical link, a JSON-LD product record naming its sku, and a photo
   whose URL carries the same code. Used by the discovery tests, where
   what is being exercised is finding the listing rather than prising a
   photo out of a difficult page. */
function simpleRetailer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.endsWith('.jpg')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPEG);
    }
    const code = (url.match(/\d{6,}/) || ['000000'])[0];
    const here = `http://127.0.0.1:${server.address().port}${url}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="${here}">
      <meta property="og:title" content="Boxy Cotton Tee">
      <meta property="og:site_name" content="Northfold">
      <script type="application/ld+json">
      {"@type":"Product","sku":"${code}","name":"Boxy Cotton Tee",
       "brand":{"@type":"Brand","name":"Northfold"},
       "image":["/img/${code}-hero.jpg"]}
      </script></head><body></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* simpleRetailer always sells the same tee. This one sells whatever its
   code is registered as, and remembers every path it was asked for, so a
   test can prove a page was never fetched at all. */
function namedRetailer(names) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits.push(url);
    if (url.endsWith('.jpg')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPEG);
    }
    const code = (url.match(/\d{6,}/) || ['000000'])[0];
    const here = `http://127.0.0.1:${server.address().port}${url}`;
    const name = names[code] || names[Number(code)] || 'Unnamed';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="${here}">
      <meta property="og:title" content="${name}">
      <meta property="og:site_name" content="Fixture">
      <script type="application/ld+json">
      {"@type":"Product","sku":"${code}","name":"${name}",
       "brand":{"@type":"Brand","name":"Fixture"},
       "image":["/img/${code}-hero.jpg"]}
      </script></head><body></body></html>`);
  });
  server.hits = hits;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* a retailer that publishes a description and a material for each of
   its products, so the product-page stage has something to read */
function describingRetailer(products) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits.push(url);
    if (url.endsWith('.jpg')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPEG);
    }
    const code = (url.match(/\d{6,}/) || ['000000'])[0];
    const here = `http://127.0.0.1:${server.address().port}${url}`;
    const product = products[code] || products[Number(code)] || { name: 'Unnamed' };
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="${here}">
      <meta property="og:title" content="${product.name}">
      <script type="application/ld+json">
      {"@type":"Product","sku":"${code}","name":"${product.name}",
       "material":"${product.material || ''}",
       "description":"${product.description || ''}",
       "brand":{"@type":"Brand","name":"Fixture"},
       "image":["/img/${code}-hero.jpg"]}
      </script></head><body>
      <div class="you-may-also-like">Fleece sweatpants, tailored wool coats, pleated midi skirts</div>
      </body></html>`);
  });
  server.hits = hits;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function stubbornRetailer() {
  let plainHits = 0;
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }

    /* The bot check. Node's own fetch sends sec-fetch-mode: cors, so the
       discriminator has to be what only a real navigation sends: a
       browser opening a page asks for a document. */
    if (req.headers['sec-fetch-mode'] !== 'navigate' || req.headers['sec-fetch-dest'] !== 'document') {
      plainHits += 1;
      res.writeHead(403, { 'content-type': 'text/html' });
      return res.end('<html><body>Access denied</body></html>');
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="http://127.0.0.1:${server.address().port}/p/171960005">
      <title>Stubborn</title></head>
      <body><div id="gallery"></div>
      <script>
        /* the gallery, and the product record, only exist after this runs */
        const ld = document.createElement('script');
        ld.type = 'application/ld+json';
        ld.textContent = JSON.stringify({'@type':'Product',sku:'171960005',image:['/img/171960005-hero.png']});
        document.head.appendChild(ld);

        const meta = document.createElement('meta');
        meta.setAttribute('property','og:image');
        meta.setAttribute('content','/img/171960005-share.png');
        document.head.appendChild(meta);

        /* main and detail appear ONLY in the gallery, so the order the
           gallery is read in is observable; hero is also in the JSON-LD
           above and is deduped into that higher-priority slot, and the
           swatch is too small to be offered at all */
        const g = document.getElementById('gallery');
        g.className = 'product-gallery';
        for (const [name, size] of [['swatch', 40], ['detail', 300], ['hero', 600], ['main', 700]]) {
          const img = document.createElement('img');
          img.src = '/img/171960005-' + name + '.png';
          img.alt = name;
          img.style.width = size + 'px';
          img.style.height = size + 'px';
          g.appendChild(img);
        }
      </script></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, plain: () => plainHits })));
}

/* ---------------------------------------------------------
   A retailer behind a cookie wall, whose gallery loads lazily

   Two things that keep a real product photo off a rendered page even
   when Chromium opened it: an overlay that covers the gallery until it
   is answered, and images that only get a src once they scroll into
   view. Neither is exotic; both are what a shopper's browser handles
   without being asked.
   --------------------------------------------------------- */
function walledRetailer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Walled</title></head>
      <body style="margin:0">
      <div id="wall" style="position:fixed;inset:0;background:#fff;z-index:9">
        <button id="onetrust-accept-btn-handler">Accept All Cookies</button>
      </div>
      <div style="height:1200px"></div>
      <div class="product-gallery" id="gallery">
        <img id="hero" data-src="/img/6887613-hero.png" alt="hero" style="width:600px;height:600px">
      </div>
      <script>
        /* the gallery image gets its src only after the wall is gone AND
           it has been scrolled to — the two conditions together */
        let accepted = false;
        document.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => {
          accepted = true;
          document.getElementById('wall').remove();
        });
        const hero = document.getElementById('hero');
        new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting && accepted && !hero.src) hero.src = hero.dataset.src;
          }
        }).observe(hero);
      </script></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  console.log('\nCatalogue image extractor\n');

  /* ---------- what the page offers ---------- */
  console.log('  — the served markup\n');

  test('a Product in @graph is preferred to the sharing card', () => {
    const found = extractor.candidatesFrom(withJsonLd, UNIQLO);
    assert.strictEqual(found[0].url, 'https://image.uniqlo.com/goods/429066/item/main.jpg');
    assert.ok(urls(found).includes('https://image.uniqlo.com/og-429066.jpg'), 'the og:image stays as a fallback');
  });

  test('the JSON-LD candidate keeps the record that supplied it', () => {
    const [first] = extractor.candidatesFrom(withJsonLd, UNIQLO);
    assert.strictEqual(first.from, 'json-ld');
    assert.strictEqual(first.node.sku, 'E429066-000', 'the sku must travel with the image');
  });

  test('an og:image is read whichever order its attributes are in', () => {
    const found = extractor.candidatesFrom(ogOnly, ZARA);
    assert.strictEqual(found[0].url, 'https://static.zara.net/photos/6887613250_1_1_1.jpg?ts=1&w=1200');
  });

  test('a preloaded srcset gives up its widest image, not its smallest', () => {
    const found = extractor.candidatesFrom(preloadOnly, LEVIS);
    assert.strictEqual(found[0].url, 'https://lsco.scene7.com/is/image/levis/171960005-large.jpg');
  });

  test('widths order the srcset even when the markup does not', () => {
    const order = extractor.largestFromSrcset('https://h/a.jpg 100w, https://h/c.jpg 2000w, https://h/b.jpg 800w');
    assert.deepStrictEqual(order, ['https://h/c.jpg', 'https://h/b.jpg', 'https://h/a.jpg']);
  });

  test('a page with no product image in it offers nothing to write', () => {
    assert.deepStrictEqual(extractor.candidatesFrom('<html><body><img src="/logo.svg"></body></html>', UNIQLO), []);
  });

  test('the canonical link is carried alongside each candidate', () => {
    const [first] = extractor.candidatesFrom(withJsonLd, UNIQLO);
    assert.strictEqual(first.canonical, UNIQLO);
  });

  /* ---------- which hosts are allowed to supply it ---------- */
  console.log('\n  — the host gate\n');

  test('a Google Shopping thumbnail is refused by name', () => {
    const [candidate] = extractor.candidatesFrom(aggregatorOnly, UNIQLO);
    assert.match(extractor.soundness(candidate, UNIQLO), /aggregator or stock host/);
  });

  test('stock libraries are refused', () => {
    for (const host of ['images.unsplash.com', 'www.shutterstock.com', 'media.gettyimages.com', 'via.placeholder.com']) {
      const verdict = extractor.soundness(`https://${host}/x.jpg`, UNIQLO);
      assert.match(String(verdict), /aggregator or stock host/, `${host} must be refused`);
    }
  });

  test('an http image is refused before it is ever requested', () => {
    assert.match(extractor.soundness('http://image.uniqlo.com/main.jpg', UNIQLO), /cannot load on an https page/);
  });

  test("the retailer's own image host is allowed", () => {
    assert.strictEqual(extractor.soundness('https://image.uniqlo.com/goods/429066/item/main.jpg', UNIQLO), null);
  });

  test('a CDN the retailer publishes through is allowed', () => {
    assert.strictEqual(extractor.soundness('https://lsco.scene7.com/is/image/levis/171960005.jpg', LEVIS), null);
  });

  /* ---------- is it THIS product? ----------

     The gate that matters once a browser is rendering whole pages full
     of related-product strips, recommendation carousels and "complete
     the look" tiles, every one of them a real photo on the real CDN. */
  console.log('\n  — the product-identity gate\n');

  test('the listing URL gives up its product code', () => {
    assert.ok(extractor.identifiersFrom(UNIQLO).includes('429066'), 'UNIQLO: 429066');
    assert.ok(extractor.identifiersFrom(ZARA).includes('6887613'), 'ZARA: 6887613 (zeros stripped)');
    assert.ok(extractor.identifiersFrom(LEVIS).includes('171960005'), "LEVI'S: 171960005");
  });

  /* a run of four digits is not the only shape a product code comes in:
     J.Crew names products AU763, and a rule that only saw digits would
     refuse every photo on the site */
  test('a letters-and-digits product code is recognised', () => {
    const ids = extractor.identifiersFrom('https://www.jcrew.com/p/mens/categories/clothing/shirts/broken-in-oxford/broken-in-organic-cotton-oxford-shirt/AU763');
    assert.ok(ids.includes('au763'), `AU763 was not read as a code, got ${ids.join(', ')}`);
  });

  test('a short code matches at a boundary, not inside a hash', () => {
    const page = 'https://www.jcrew.com/p/mens/shirt/AU763';
    const real = extractor.identityEvidence(
      { url: 'https://www.jcrew.com/s7-img-facade/AU763_WT0002?fmt=jpeg', from: 'og:image' }, page);
    assert.strictEqual(real.ok, true, `the real one was refused: ${real.why}`);

    const collision = extractor.identityEvidence(
      { url: 'https://www.jcrew.com/img/9f3beau763ac1d2e4b8f.jpg', from: 'gallery image' }, page);
    assert.strictEqual(collision.ok, false, 'a hash containing au763 matched as the product code');
  });

  /* Scene7 serves defaultImage when the asset actually asked for is
     missing, so a product code sitting there describes the stand-in, not
     the picture that will render. Counting it would let a row point at
     one asset while being vouched for by another. */
  test('a code in a defaultImage fallback parameter does not vouch for the asset', () => {
    const verdict = extractor.identityEvidence({
      url: 'https://cdni.llbean.net/is/image/wim/521659_32573_41?hei=1095&defaultImage=llbprod/129244_0_44',
      from: 'og:image'
    }, 'https://www.llbean.com/llb/shop/129244');
    assert.strictEqual(verdict.ok, false, 'the fallback parameter was accepted as proof');
    assert.match(verdict.why, /defaultImage parameter/);
    assert.match(verdict.why, /521659_32573_41/, 'the refusal should name the asset actually requested');
  });

  test('the same code in the asset path does vouch for it', () => {
    const verdict = extractor.identityEvidence({
      url: 'https://cdni.llbean.net/is/image/llbprod/129244_0_44?wid=950',
      from: 'og:image'
    }, 'https://www.llbean.com/llb/shop/129244');
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.match(verdict.how, /URL path/);
  });

  test('an ordinary query parameter may still carry the code', () => {
    const verdict = extractor.identityEvidence({
      url: 'https://img.example.com/render?sku=129244&wid=950',
      from: 'og:image'
    }, 'https://www.llbean.com/llb/shop/129244');
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.match(verdict.how, /sku parameter/);
  });

  test('an image whose URL carries the listing code is this product', () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://image.uniqlo.com/UQ/ST3/.../429066/item/goods_03_429066_3x4.jpg', from: 'og:image' }, UNIQLO);
    assert.strictEqual(verdict.ok, true);
    assert.match(verdict.how, /429066/);
  });

  test('a code split across CDN path segments still matches', () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://static.zara.net/photos///2025/V/0/1/p/6887/613/250/2/w/750/6887613250_1_1_1.jpg', from: 'og:image' }, ZARA);
    assert.strictEqual(verdict.ok, true);
  });

  test('a JSON-LD record naming the sku vouches for its own image', () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://lsco.scene7.com/is/image/levis/hero-shot-front.jpg', from: 'json-ld', node: { sku: '171960005' } }, LEVIS);
    assert.strictEqual(verdict.ok, true);
    assert.match(verdict.how, /sku 171960005/);
  });

  test('the canonical page vouches for its own og:image', () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://static.zara.net/photos/opaque-hash-with-no-code.jpg', from: 'og:image', canonical: ZARA }, ZARA);
    assert.strictEqual(verdict.ok, true);
    assert.match(verdict.how, /canonical/);
  });

  test('a canonical pointing at a DIFFERENT product does not vouch', () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://static.zara.net/photos/opaque.jpg', from: 'og:image', canonical: 'https://www.zara.com/us/en/linen-shirt-p09999999.html' }, ZARA);
    assert.strictEqual(verdict.ok, false);
  });

  /* the whole point: a real photo, real CDN, wrong garment */
  test("a similar product's photo on the right CDN is refused", () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://static.zara.net/photos///2025/V/0/1/p/1234/567/250/2/w/750/1234567250_1_1_1.jpg', from: 'gallery image' }, ZARA);
    assert.strictEqual(verdict.ok, false, 'a neighbouring product got through the identity gate');
    assert.match(verdict.why, /nothing ties it to this product/);
  });

  test('a recommendation-strip image with no code is refused', () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://image.uniqlo.com/UQ/ST3/recommendations/you-may-also-like.jpg', from: 'rendered image' }, UNIQLO);
    assert.strictEqual(verdict.ok, false);
  });

  test('a gallery image cannot lean on the canonical the way og:image can', () => {
    const verdict = extractor.identityEvidence(
      { url: 'https://static.zara.net/photos/opaque.jpg', from: 'gallery image', canonical: ZARA }, ZARA);
    assert.strictEqual(verdict.ok, false, 'only the page-level declarations may vouch');
  });

  test('the same product page is recognised through www and a trailing slash', () => {
    assert.strictEqual(extractor.samePage('https://zara.com/us/en/oxford-shirt-p06887613.html/', ZARA), true);
    assert.strictEqual(extractor.samePage('https://www.zara.com/us/en/linen-p1.html', ZARA), false);
  });

  /* ---------- whether the browser could actually load it ---------- */
  console.log('\n  — the loadable gate\n');

  const server = await imageHost();
  const origin = `http://127.0.0.1:${server.address().port}`;

  await testAsync('an image that loads is accepted, with its type and size', async () => {
    const verdict = await extractor.verifyImage(`${origin}/photo.jpg`);
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.match(verdict.why, /image\/jpeg/);
  });

  await testAsync('a hotlink block is caught here rather than on the page', async () => {
    const verdict = await extractor.verifyImage(`${origin}/hotlinked.jpg`);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /hotlink blocked/);
  });

  await testAsync('a tracking pixel is too small to be a product photo', async () => {
    const verdict = await extractor.verifyImage(`${origin}/pixel.gif`);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /too small/);
  });

  await testAsync('a consent wall answering 200 as html is not an image', async () => {
    const verdict = await extractor.verifyImage(`${origin}/notanimage.jpg`);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /text\/html/);
  });

  await testAsync('a dead URL is not written', async () => {
    const verdict = await extractor.verifyImage(`${origin}/missing.jpg`);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /answered 404/);
  });

  server.close();

  /* ---------- the order the gates run in ---------- */
  console.log('\n  — the gates together\n');

  await testAsync('an aggregator is refused before it is ever requested', async () => {
    const row = { id: 'x', productUrl: UNIQLO };
    let asked = false;
    const fetcher = async () => { asked = true; return { ok: false, why: 'should not have been asked' }; };
    const result = await extractor.firstVerifiable(
      [{ url: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn:429066', from: 'og:image' }], row, fetcher);
    assert.ok(!result.url, 'it must not verify');
    assert.strictEqual(asked, false, 'the aggregator was fetched anyway');
  });

  await testAsync('a wrong-product image is refused before it is ever requested', async () => {
    const row = { id: 'x', productUrl: ZARA };
    let asked = false;
    const fetcher = async () => { asked = true; return { ok: false, why: 'should not have been asked' }; };
    const result = await extractor.firstVerifiable(
      [{ url: 'https://static.zara.net/photos/1234567250_1_1_1.jpg', from: 'gallery image' }], row, fetcher);
    assert.ok(!result.url);
    assert.strictEqual(asked, false, 'a wrong-product image was fetched anyway');
  });

  await testAsync('the first candidate that clears every gate is the one taken', async () => {
    const row = { id: 'x', productUrl: UNIQLO };
    const fetcher = async (url) => ({
      ok: true,
      response: {
        status: 200,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => ({ byteLength: 50000 }),
        body: null
      }
    });
    const result = await extractor.firstVerifiable([
      { url: 'https://encrypted-tbn0.gstatic.com/shopping?q=1', from: 'og:image' },
      { url: 'https://image.uniqlo.com/no-code-here.jpg', from: 'gallery image' },
      { url: 'https://image.uniqlo.com/goods/429066/main.jpg', from: 'json-ld' }
    ], row, fetcher);
    assert.strictEqual(result.url, 'https://image.uniqlo.com/goods/429066/main.jpg');
  });

  await testAsync('a failure says which gate stopped which candidate', async () => {
    const row = { id: 'x', productUrl: ZARA };
    const fetcher = async () => ({
      ok: true,
      response: {
        status: 404,
        headers: { get: () => 'text/html' },
        arrayBuffer: async () => ({ byteLength: 0 }),
        body: null
      }
    });
    const result = await extractor.firstVerifiable([
      { url: 'https://encrypted-tbn0.gstatic.com/shopping?q=1', from: 'og:image' },
      { url: 'https://static.zara.net/photos/9999999250_1_1_1.jpg', from: 'gallery image' },
      { url: 'https://static.zara.net/photos/6887613250_1_1_1.jpg', from: 'json-ld' }
    ], row, fetcher);

    assert.ok(!result.url, 'nothing should have verified');
    const gates = result.refusals.map((r) => r.gate);
    assert.deepStrictEqual(gates, ['host', 'identity', 'loadable'],
      `each candidate must name its own gate, got ${gates.join(', ')}`);
    assert.ok(result.refusals.every((r) => r.url && r.from && r.why),
      'a refusal must carry the URL, where it came from, and why');
  });

  /* ---------- the browser path ---------- */
  console.log('\n  — the browser path\n');

  const retailer = await stubbornRetailer();
  const retailerOrigin = `http://127.0.0.1:${retailer.server.address().port}`;
  const productUrl = `${retailerOrigin}/p/171960005`;

  const probe = await extractor.renderPage(productUrl);

  if (probe.failed && probe.noBrowser) {
    console.log(`  skip  the browser path — ${probe.failed}`);
    skipped += 1;
  } else {
    await testAsync('a page that refuses plain HTTP is opened in a real browser', async () => {
      assert.ok(!probe.failed, `the browser could not open it: ${probe.failed}`);
      assert.ok(probe.seen, 'nothing came back from the page');
    });

    await testAsync('metadata the page wrote with JavaScript is read', async () => {
      assert.ok(probe.seen.metas['og:image'], 'the script-added og:image was missed');
      assert.ok((probe.seen.jsonld || []).length, 'the script-added JSON-LD was missed');
      assert.match(String(probe.seen.canonical), /171960005/, 'the canonical was missed');
    });

    await testAsync('the gallery it built is read, with each image\'s drawn size', async () => {
      const hero = probe.seen.imgs.find((i) => i.alt === 'hero');
      const swatch = probe.seen.imgs.find((i) => i.alt === 'swatch');
      assert.ok(hero && swatch, 'the gallery images were missed');
      assert.ok(hero.width > swatch.width, 'the drawn sizes did not come back');
      assert.strictEqual(hero.inGallery, true, 'the gallery container was not recognised');
    });

    await testAsync('the images the page actually loaded are recorded', async () => {
      assert.ok((probe.loaded || []).some((u) => u.includes('171960005-hero')), 'the loaded hero was missed');
    });

    test('the rendered candidates put the record and the card first', () => {
      const found = extractor.candidatesFromRendered(probe.seen, probe.loaded, productUrl);
      assert.match(found[0].from, /json-ld/, `first candidate came from ${found[0].from}`);
      assert.ok(urls(found).some((u) => u.includes('171960005-hero')), 'the hero never became a candidate');
    });

    test('the drawn gallery is ordered biggest first', () => {
      const found = extractor.candidatesFromRendered(probe.seen, probe.loaded, productUrl);
      const gallery = found.filter((c) => /gallery image/.test(c.from));
      const mainAt = gallery.findIndex((c) => c.url.includes('-main'));
      const detailAt = gallery.findIndex((c) => c.url.includes('-detail'));
      assert.ok(mainAt !== -1 && detailAt !== -1, `gallery candidates were ${urls(gallery).join(', ')}`);
      assert.ok(mainAt < detailAt, 'the 300px detail shot was offered before the 700px main one');
    });

    test('an image already named by the record is not offered twice', () => {
      const found = extractor.candidatesFromRendered(probe.seen, probe.loaded, productUrl);
      const hero = found.filter((c) => c.url.includes('-hero'));
      assert.strictEqual(hero.length, 1, 'the hero appeared as both a record image and a gallery image');
      assert.match(hero[0].from, /json-ld/, 'the higher-priority source did not win the dedupe');
    });

    test('images too small to be a hero are not offered at all', () => {
      const found = extractor.candidatesFromRendered(probe.seen, probe.loaded, productUrl);
      const fromGallery = found.filter((c) => /gallery image|rendered image/.test(c.from));
      assert.ok(!fromGallery.some((c) => c.url.includes('-swatch')), 'a 40px swatch was offered as a product photo');
    });

    await testAsync('the whole row escalates from plain HTTP to the browser by itself', async () => {
      const row = { id: 'stubborn', brand: 'Stubborn', name: 'Test', productUrl };
      const result = await extractor.resolveRow(row);
      const notes = (result.notes || []).join(' | ');
      assert.match(notes, /plain HTTP: the page answered 403/, `notes were: ${notes}`);
      assert.match(notes, /browser: \d+ candidate/, `notes were: ${notes}`);
      assert.ok(retailer.plain() > 0, 'plain HTTP was never tried first');
      /* every candidate is http on localhost, so the host gate refuses
         them all — which is the correct answer, and proves the gates
         still run on whatever the browser found */
      assert.strictEqual(result.verdict, 'NO IMAGE FOUND');
      assert.strictEqual(result.url, null);
    });
  }

  retailer.server.close();

  /* ---------- the cookie wall and the lazy gallery ---------- */
  if (!(probe.failed && probe.noBrowser)) {
    console.log('\n  — a consent wall over a lazy gallery\n');

    const walled = await walledRetailer();
    const walledUrl = `http://127.0.0.1:${walled.address().port}/p/06887613`;
    const seen = await extractor.renderPage(walledUrl);

    await testAsync('the consent wall is accepted and the gallery behind it read', async () => {
      assert.ok(!seen.failed, `the browser path failed: ${seen.failed}`);
      const hero = (seen.seen.imgs || []).find((i) => i.alt === 'hero');
      assert.ok(hero, 'the gallery image was never found');
      assert.ok(hero.url && hero.url.includes('6887613-hero'),
        `the lazy image never got a src (${hero.url || 'empty'}) — the wall or the scroll was not handled`);
    });

    await testAsync('the image the page lazily loaded is recorded', async () => {
      assert.ok((seen.loaded || []).some((u) => u.includes('6887613-hero')),
        'the hero was never actually fetched by the page');
    });

    walled.close();
  }

  /* ---------- what the file looks like afterwards ---------- */
  console.log('\n  — the catalogue itself\n');

  const { source, rows } = extractor.readCatalog();

  test('the catalogue reads as rows, with the linked ones carrying a productUrl', () => {
    assert.ok(rows.length >= 3, 'the catalogue has rows');
    const linked = rows.filter((r) => r.productUrl);
    assert.ok(linked.length >= 3, 'three rows link to a real listing');
    assert.ok(linked.every((r) => r.id && r.name && r.brand), 'a linked row is identifiable');
  });

  test('writing a photo fills one field and leaves the rest of the row alone', () => {
    const next = extractor.writeInto(source, 'uniqlo-merino-crew', 'https://image.uniqlo.com/goods/429066/item/main.jpg');
    assert.ok(next.includes("imageUrl: 'https://image.uniqlo.com/goods/429066/item/main.jpg'"), 'the URL is written');
    assert.ok(next.includes(`productUrl: '${UNIQLO}'`), 'the listing is untouched');
    assert.ok(next.includes("id: 'uniqlo-merino-crew'"), 'the identity is untouched');
    assert.strictEqual(next.split('imageUrl:').length, source.split('imageUrl:').length, 'no field is added or lost');
  });

  /* the neighbour is checked against what it held BEFORE the write, not
     against null: rows get photos as they are verified, and a test that
     hard-codes today's empty ones fails the day one is filled in */
  test('a photo is written into the row that owns it, and no other', () => {
    const untouched = rows
      .filter((r) => r.id !== 'jcrew-broken-in-oxford')
      .map((r) => [r.id, r.imageUrl]);

    const next = extractor.writeInto(source, 'jcrew-broken-in-oxford', 'https://static.zara.net/photos/6887613250_1_1_1.jpg');
    const rows2 = evaluate(next);

    const zara = rows2.find((r) => r.id === 'jcrew-broken-in-oxford');
    assert.strictEqual(zara.imageUrl, 'https://static.zara.net/photos/6887613250_1_1_1.jpg');

    for (const [id, before] of untouched) {
      const after = rows2.find((r) => r.id === id).imageUrl;
      assert.strictEqual(after, before, `${id} must keep the photo it had`);
    }
  });

  test('every row still normalises after a write, so the page can render it', () => {
    const next = extractor.writeInto(source, 'llbean-venturestretch-chino', 'https://lsco.scene7.com/is/image/levis/171960005-front.jpg');
    const rows2 = evaluate(next);
    assert.strictEqual(rows2.length, rows.length, 'no row is lost');
    const levis = rows2.find((r) => r.id === 'llbean-venturestretch-chino');
    assert.strictEqual(levis.productUrl, rows.find((r) => r.id === 'llbean-venturestretch-chino').productUrl);
  });

  /* the gates are worth nothing if a URL can reach the file around them,
     so the shipped catalogue is held to them too: whatever rows carry
     today, a photo on it has to be one the linked retailer could serve
     for that exact product */
  test('every photo in the shipped catalogue comes from its own listing', () => {
    for (const row of rows.filter((r) => r.imageUrl)) {
      const host = extractor.soundness(row.imageUrl, row.productUrl);
      assert.strictEqual(host, null, `${row.id}: ${host}`);
      const identity = extractor.catalogRowIdentity(row);
      assert.strictEqual(identity.ok, true, `${row.id}: ${identity.why}`);
    }
  });

  /* ---------- the evidence a shipped row carries ----------

     Some retailers name their assets in a way that says nothing about
     the product, so a row records how the extractor tied its photo to
     the listing. That record is re-proved against the row's own
     productUrl, never taken at its word — otherwise it would just be a
     way of writing "trust me" into the catalogue. */

  test('a row whose URL carries the code needs no recorded evidence', () => {
    const verdict = extractor.catalogRowIdentity({
      id: 'x', productUrl: UNIQLO,
      imageUrl: 'https://image.uniqlo.com/goods/429066/item/main.jpg'
    });
    assert.strictEqual(verdict.ok, true);
    assert.strictEqual(verdict.via, 'image-url');
  });

  test('a row whose URL cannot vouch is refused when it records nothing', () => {
    const verdict = extractor.catalogRowIdentity({
      id: 'x', productUrl: 'https://www.llbean.com/llb/shop/129244',
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41?defaultImage=llbprod/129244_0_44'
    });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /records no verification evidence/);
  });

  test('a recorded JSON-LD sku matching the listing accounts for the photo', () => {
    const verdict = extractor.catalogRowIdentity({
      id: 'x', productUrl: 'https://www.llbean.com/llb/shop/129244',
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41?defaultImage=llbprod/129244_0_44',
      imageEvidence: { via: 'json-ld-sku', sku: '129244' }
    });
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.match(verdict.how, /sku 129244/);
  });

  /* the whole point of re-proving it */
  test('a recorded sku that is not this listing\'s is refused', () => {
    const verdict = extractor.catalogRowIdentity({
      id: 'x', productUrl: 'https://www.llbean.com/llb/shop/129244',
      imageUrl: 'https://cdni.llbean.net/is/image/wim/999999_1_1.jpg',
      imageEvidence: { via: 'json-ld-sku', sku: '888888' }
    });
    assert.strictEqual(verdict.ok, false, 'a sku belonging to another product was accepted');
    assert.match(verdict.why, /not a code in this row's own listing URL/);
  });

  test('an evidence block naming no sku is refused', () => {
    const verdict = extractor.catalogRowIdentity({
      id: 'x', productUrl: 'https://www.llbean.com/llb/shop/129244',
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41',
      imageEvidence: { via: 'json-ld-sku' }
    });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /names no sku/);
  });

  test('an evidence block of an unrecognised kind is refused', () => {
    const verdict = extractor.catalogRowIdentity({
      id: 'x', productUrl: 'https://www.llbean.com/llb/shop/129244',
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41',
      imageEvidence: { via: 'i-checked-by-hand' }
    });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /no recognised kind/);
  });

  test('a recorded canonical must be this row\'s own listing', () => {
    const mine = extractor.catalogRowIdentity({
      id: 'x', productUrl: 'https://www.llbean.com/llb/shop/129244',
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41',
      imageEvidence: { via: 'canonical', canonical: 'https://www.llbean.com/llb/shop/129244' }
    });
    assert.strictEqual(mine.ok, true, mine.why);

    const other = extractor.catalogRowIdentity({
      id: 'x', productUrl: 'https://www.llbean.com/llb/shop/129244',
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41',
      imageEvidence: { via: 'canonical', canonical: 'https://www.llbean.com/llb/shop/555555' }
    });
    assert.strictEqual(other.ok, false, "another product's canonical was accepted");
  });

  test('evidence cannot rescue a photo from an aggregator host', () => {
    /* the host gate runs separately and first; this only records that
       evidence is not a way around it */
    const host = extractor.soundness(
      'https://encrypted-tbn0.gstatic.com/shopping?q=129244',
      'https://www.llbean.com/llb/shop/129244');
    assert.match(String(host), /aggregator or stock host/);
  });

  /* ---------- writing that evidence down ---------- */

  test('a photo whose URL speaks for itself gets no evidence note', () => {
    const next = extractor.writeInto(source, 'uniqlo-merino-crew',
      'https://image.uniqlo.com/goods/429066/item/main.jpg',
      { ok: true, via: 'image-url', code: '429066' });
    const row = evaluate(next).find((r) => r.id === 'uniqlo-merino-crew');
    assert.strictEqual(row.imageEvidence, undefined, 'a redundant note was written');
  });

  test('a photo verified by sku records that sku beside it', () => {
    const next = extractor.writeInto(source, 'jcrew-broken-in-oxford',
      'https://www.jcrew.com/opaque-asset.jpg',
      { ok: true, via: 'json-ld-sku', sku: 'AU763' });
    const row = evaluate(next).find((r) => r.id === 'jcrew-broken-in-oxford');
    assert.deepStrictEqual(plain(row.imageEvidence), { via: 'json-ld-sku', sku: 'AU763' });
    assert.strictEqual(extractor.catalogRowIdentity(row).ok, true);
  });

  test('re-verifying by a URL that speaks for itself clears a stale note', () => {
    const withNote = extractor.writeInto(source, 'jcrew-broken-in-oxford',
      'https://www.jcrew.com/opaque-asset.jpg', { ok: true, via: 'json-ld-sku', sku: 'AU763' });
    const cleared = extractor.writeInto(withNote, 'jcrew-broken-in-oxford',
      'https://www.jcrew.com/s7-img-facade/AU763_WT0002', { ok: true, via: 'image-url', code: 'au763' });
    const row = evaluate(cleared).find((r) => r.id === 'jcrew-broken-in-oxford');
    assert.strictEqual(row.imageEvidence, undefined, 'the old note outlived the URL it explained');
  });

  test('the evidence note never lands on a neighbouring row', () => {
    const next = extractor.writeInto(source, 'llbean-venturestretch-chino',
      'https://cdni.llbean.net/is/image/wim/521659_32573_41',
      { ok: true, via: 'json-ld-sku', sku: '129244' });
    const after = evaluate(next);
    for (const row of after.filter((r) => r.id !== 'llbean-venturestretch-chino')) {
      const before = rows.find((r) => r.id === row.id);
      assert.deepStrictEqual(plain(row.imageEvidence), plain(before.imageEvidence), `${row.id} gained or lost a note`);
    }
  });

  test('the evidence field never reaches a rendered product', () => {
    /* products.js builds an explicit record, so an extra catalogue field
       is dropped before anything draws — the note is bookkeeping, not
       something the interface has to know about. The real data layer is
       loaded to answer this, rather than the claim being asserted. */
    const Products = loadProductsLayer();
    const normalised = Products.normalizeProduct({
      id: 'x', name: 'A thing', brand: 'B',
      imageUrl: 'https://h/i.jpg', productUrl: 'https://h/p',
      imageEvidence: { via: 'json-ld-sku', sku: '1' }
    });
    assert.ok(normalised, 'the record did not normalise at all');
    assert.strictEqual('imageEvidence' in normalised, false, 'the note leaked into the rendered record');
    assert.strictEqual(normalised.imageUrl, 'https://h/i.jpg', 'the photo itself must survive');
  });

  test('a row with no verified photo carries null, not a placeholder', () => {
    for (const row of rows.filter((r) => !r.imageUrl)) {
      assert.strictEqual(row.imageUrl, null, `${row.id} holds ${JSON.stringify(row.imageUrl)} instead of null`);
    }
  });

  /* ---------- swapping a row's product ---------- */

  test('a replacement moves listing, photo, name and brand together', () => {
    const next = extractor.replaceRow(source, 'jcrew-broken-in-oxford', {
      productUrl: 'https://www.example-shop.com/p/AU763',
      imageUrl: 'https://img.example-shop.com/AU763_WHITE.jpg',
      name: 'Broken-in Organic Cotton Oxford Shirt',
      brand: 'J.Crew'
    });
    const row = evaluate(next).find((r) => r.id === 'jcrew-broken-in-oxford');
    assert.strictEqual(row.productUrl, 'https://www.example-shop.com/p/AU763');
    assert.strictEqual(row.imageUrl, 'https://img.example-shop.com/AU763_WHITE.jpg');
    assert.strictEqual(row.name, 'Broken-in Organic Cotton Oxford Shirt');
    assert.strictEqual(row.brand, 'J.Crew');
  });

  test('a replacement leaves every other row exactly as it was', () => {
    const before = rows.filter((r) => r.id !== 'jcrew-broken-in-oxford')
      .map((r) => [r.id, r.productUrl, r.imageUrl, r.name, r.brand]);
    const next = extractor.replaceRow(source, 'jcrew-broken-in-oxford', {
      productUrl: 'https://www.example-shop.com/p/AU763',
      imageUrl: 'https://img.example-shop.com/AU763_WHITE.jpg',
      name: 'Oxford Shirt', brand: 'Example'
    });
    const after = evaluate(next);
    for (const [id, productUrl, imageUrl, name, brand] of before) {
      const row = after.find((r) => r.id === id);
      assert.deepStrictEqual(
        [row.productUrl, row.imageUrl, row.name, row.brand],
        [productUrl, imageUrl, name, brand],
        `${id} was disturbed by a replacement of another row`
      );
    }
  });

  test('a name carrying an apostrophe is quoted, not broken', () => {
    const next = extractor.replaceRow(source, 'jcrew-broken-in-oxford', {
      productUrl: 'https://www.example-shop.com/p/1',
      imageUrl: 'https://img.example-shop.com/1.jpg',
      name: "Men's Oxford Shirt", brand: 'Example'
    });
    const row = evaluate(next).find((r) => r.id === 'jcrew-broken-in-oxford');
    assert.strictEqual(row.name, "Men's Oxford Shirt");
  });

  test('the swapped row still passes the identity gate against its new listing', () => {
    const next = extractor.replaceRow(source, 'jcrew-broken-in-oxford', {
      productUrl: 'https://www.example-shop.com/p/AU763',
      imageUrl: 'https://img.example-shop.com/AU763_WHITE.jpg',
      name: 'Oxford', brand: 'Example'
    });
    const row = evaluate(next).find((r) => r.id === 'jcrew-broken-in-oxford');
    const identity = extractor.identityEvidence({ url: row.imageUrl, from: 'catalogue' }, row.productUrl);
    assert.strictEqual(identity.ok, true, identity.why);
  });

  test('a URL carrying a quote is refused rather than breaking the file', () => {
    assert.throws(
      () => extractor.writeInto(source, 'uniqlo-merino-crew', "https://image.uniqlo.com/a'b.jpg"),
      /unquotable/
    );
  });

  /* ---------------------------------------------------------
     Finding a listing for a row that has none

     Most of the catalogue is sample rows: names invented to give the
     demo something to search. A sample row cannot be photographed,
     because there is nothing to photograph — it has to become a real
     listing first, and that listing has to be FOUND rather than typed
     in. What is tested here is that the finding goes through the same
     four gates as everything else, and that a row which already has a
     verified photo is never in the running.
     --------------------------------------------------------- */
  console.log('\n  — finding a listing for a row that has none\n');

  const listing = (port, code) => `http://127.0.0.1:${port}/p/${code}`;
  const record = (port, code, title) => ({
    title: title || 'Boxy Cotton Tee',
    price: 42,
    imageUrl: `http://127.0.0.1:${port}/img/${code}-hero.jpg`,
    productUrl: listing(port, code),
    retailer: 'Northfold'
  });

  test('http is still refused anywhere but a loopback fixture', () => {
    assert.strictEqual(
      extractor.soundness({ url: 'http://www.uniqlo.com/goods/429066.jpg' }, 'https://www.uniqlo.com/p'),
      'http:// cannot load on an https page'
    );
    assert.strictEqual(extractor.soundness({ url: 'http://127.0.0.1:8080/img/1.jpg' }, 'http://127.0.0.1:8080/p'), null,
      'a loopback origin is a fixture, never a retailer');
    assert.strictEqual(extractor.soundness({ url: 'https://www.uniqlo.com/goods/429066.jpg' }, 'https://www.uniqlo.com/p'), null);
  });

  test('a sample row asks for what it is, without its invented brand', () => {
    const sample = extractor.intentFor({ id: 'sample-northfold-boxy-cotton-tee', name: 'Boxy Cotton Tee', brand: 'Northfold', category: 'tee', colors: ['Neutral'] });
    assert.deepStrictEqual(sample.keywords, ['Boxy Cotton Tee']);
    assert.deepStrictEqual(sample.brands, [], 'a made-up brand would only narrow the search to nothing');
    assert.deepStrictEqual(sample.categories, ['tee']);

    const real = extractor.intentFor({ id: 'uniqlo-merino-crew', name: 'Merino Crew', brand: 'UNIQLO', category: 'knit' });
    assert.deepStrictEqual(real.brands, ['UNIQLO'], 'a real brand is worth asking for');
  });

  test('the catalogue says how much of itself is photographed', () => {
    const rows = extractor.readCatalog().rows;
    const report = extractor.coverage(rows);

    assert.strictEqual(report.rows, rows.length);
    assert.strictEqual(report.withPhoto, rows.filter((row) => row.imageUrl).length);
    assert.strictEqual(report.accounted, rows.length, 'every row accounts for what it carries');
    assert.deepStrictEqual(report.unaccounted, []);
    assert.strictEqual(report.missing.length, rows.length - report.withPhoto);
  });

  await testAsync('a found listing fills the row\u2019s link and photo, and nothing else', async () => {
    const retailer = await simpleRetailer();
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [record(port, '553311')]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(
      { id: 'sample-northfold-boxy-cotton-tee', name: 'Boxy Cotton Tee', brand: 'Northfold', category: 'tee' },
      new Map(),
      4
    );

    assert.strictEqual(result.verdict, 'VERIFIED', result.why);
    assert.strictEqual(result.proposal.productUrl, listing(port, '553311'));
    assert.match(result.proposal.imageUrl, /553311-hero\.jpg$/);
    assert.match(result.why, /553311/, 'and the photo is tied to that listing by its code');

    /* what the shop calls it is REPORTED, under names that cannot be
       mistaken for fields to write. A proposal carrying `name` or
       `brand` is one a writer could put into the row. */
    assert.strictEqual(result.proposal.listingName, 'Boxy Cotton Tee');
    assert.strictEqual(result.proposal.listingBrand, 'Northfold');
    assert.strictEqual(result.proposal.name, undefined, 'the proposal offers no name to write');
    assert.strictEqual(result.proposal.brand, undefined, 'nor a brand');
    assert.ok(result.proposal.identity, 'and it carries what the image gate established');

    retailer.close();
  });

  await testAsync('a photo another row already wears is refused', async () => {
    const retailer = await simpleRetailer();
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [record(port, '553311')]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const taken = new Map([[`http://127.0.0.1:${port}/img/553311-hero.jpg`, 'sample-halden-merino-crew-knit']]);
    const result = await extractor.discoverRow(
      { id: 'sample-northfold-boxy-cotton-tee', name: 'Boxy Cotton Tee', category: 'tee' },
      taken,
      4
    );

    assert.strictEqual(result.verdict, 'NO PRODUCT FOUND', 'two rows wearing one picture is a lie about one of them');
    assert.match(result.tried[0].why, /already on sample-halden-merino-crew-knit/);

    retailer.close();
  });

  await testAsync('an aggregator listing never reaches the gates at all', async () => {
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        { title: 'Boxy Cotton Tee', price: 42, retailer: 'Google', imageUrl: 'https://encrypted-tbn0.gstatic.com/x.jpg', productUrl: 'https://www.google.com/shopping/product/123' },
        { title: 'Boxy Cotton Tee', price: 42, retailer: 'Somewhere', imageUrl: 'https://cdn.example.com/x.jpg', productUrl: 'https://example.com/search?q=tee' }
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const offered = await extractor.listingsFor({ id: 'sample-x', name: 'Boxy Cotton Tee' }, 4);
    assert.deepStrictEqual(offered.products, [], 'a comparison page and a search page are not product pages');
    assert.ok(Object.keys(offered.rejected).length, 'and the source says why it dropped them');
  });

  await testAsync('with no source configured, discovery says so and writes nothing', async () => {
    const before = fs.readFileSync(CATALOG);
    const result = await run(['--discover', '--only', 'sample-northfold-boxy-cotton-tee', '--write']);
    const after = fs.readFileSync(CATALOG);

    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /no product source is configured/);
    assert.match(result.stdout, /rows already carry one and are not touched/);
    assert.ok(before.equals(after), 'assets/catalog.js is byte-for-byte what it was');
  });

  await testAsync('discovery leaves the verified rows out of its list entirely', async () => {
    const result = await run(['--discover']);
    assert.strictEqual(result.code, 0, result.stderr);

    for (const id of ['uniqlo-merino-crew', 'jcrew-broken-in-oxford', 'llbean-venturestretch-chino']) {
      assert.doesNotMatch(result.stdout, new RegExp(id), `${id} already carries a verified photo and is not a target`);
    }
    assert.match(result.stdout, /3 rows already carry one and are not touched/);
  });

  /* ---------------------------------------------------------
     The semantic gate: is this listing the garment the row MEANS

     Every other gate in here asks whether a photo belongs to a
     listing. None of them can ask whether the listing is the right
     garment, and that is how Aerie's "Street Trouser" came back as
     Kinfield's "Fleece Sweatpant": a real listing, a real photo, its
     own retailer's CDN, every identity gate cleared, and the wrong
     trousers.

     So the wrong garments are offered here on purpose — a trouser for
     a sweatpant, a dress for a skirt, a jacket for a hoodie, a tote
     for a sneaker — and each has to be turned down. Then the right
     ones are offered, including the awkward right ones: a blazer
     listing that never says "double breasted", a wool coat that never
     says "tailored". Those have to pass, because silence is not
     contradiction and a gate that demands every word back refuses
     every correct answer there is.
     --------------------------------------------------------- */
  console.log('\n  — the semantic gate: the garment, not just the page\n');

  const catalogueRow = (id) => {
    const row = extractor.readCatalog().rows.find((r) => r.id === id);
    assert.ok(row, `no catalogue row has the id ${id}`);
    return row;
  };
  const judge = (id, title) => extractor.semanticMatch(catalogueRow(id), { title });

  test('a fleece sweatpant is not answered with a trouser', () => {
    /* the one that started this: everything about it verified except
       what it was */
    const aerie = judge('sample-kinfield-fleece-sweatpant', 'Aerie Street Trouser');
    assert.strictEqual(aerie.ok, false, 'a trouser is not a sweatpant');
    assert.match(aerie.why, /sweatpant/);
    assert.match(aerie.why, /trouser/);

    assert.strictEqual(judge('sample-kinfield-fleece-sweatpant', 'Old Navy Straight Leg Chino Pants').ok, false,
      'a chino is a trouser however the title ends');

    /* and the sweatpants a sweatpant row is actually for — which have
       to be fleece ones, because the row's own name says fleece */
    for (const title of ['Nike Sportswear Club Fleece Joggers', 'Champion Powerblend Fleece Sweatpants', 'Uniqlo Sherpa Fleece Sweat Pants']) {
      const verdict = judge('sample-kinfield-fleece-sweatpant', title);
      assert.strictEqual(verdict.ok, true, `${title}: ${verdict.why}`);
    }

    /* the one the live run let through: a jogger is a sweatpant, and
       nothing in it contradicts the row — but nothing in the TITLE
       establishes fleece either. That is not a refusal any more: it is
       a question the page gets to answer. */
    const jumbie = judge('sample-kinfield-fleece-sweatpant', 'Jumbie Art Earth Unisex Joggers');
    assert.strictEqual(jumbie.ok, true, 'a title is a headline, not a specification');
    assert.strictEqual(jumbie.kind, 'pending', 'it is pending on the page, not settled');
    assert.deepStrictEqual(jumbie.pending.map(extractor.nameOfPending), ['fleece']);
    assert.match(jumbie.why, /never says fleece/);
  });

  test('a pleated midi skirt is answered by a pleated skirt, and by nothing shorter', () => {
    const plain = judge('sample-kinfield-pleated-midi-skirt', 'COS Pleated Twill Midi Skirt');
    assert.strictEqual(plain.ok, true, plain.why);
    assert.match(plain.why, /pleated on both/);

    /* "mid-length" IS midi, however a shop spells it, so the live run's
       French Toast title settles the row's length on its own */
    for (const title of [
      'French Toast Adjustable Waist Mid Length Pleated Skirt',
      'Boden Mid-Length Pleated Skirt',
      'Arket Midlength Pleated Skirt'
    ]) {
      const spelled = judge('sample-kinfield-pleated-midi-skirt', title);
      assert.strictEqual(spelled.ok, true, `${title}: ${spelled.why}`);
      assert.strictEqual(spelled.kind, 'match', `${title} left something pending: ${spelled.why}`);
      assert.match(spelled.why, /midi — the listing says mid ?length/);
    }

    /* a title that says nothing at all about length leaves midi pending
       for the page to settle — not refused, and not waved through */
    const quiet = judge('sample-kinfield-pleated-midi-skirt', 'Uniqlo Pleated Skirt');
    assert.strictEqual(quiet.ok, true, quiet.why);
    assert.strictEqual(quiet.kind, 'pending');
    assert.deepStrictEqual(quiet.pending.map(extractor.nameOfPending), ['midi']);

    /* one that says a different length is wrong */
    const mini = judge('sample-kinfield-pleated-midi-skirt', 'Zara Pleated Mini Skirt');
    assert.strictEqual(mini.ok, false, 'a mini is not a midi');
    assert.match(mini.why, /midi/);
    assert.match(mini.why, /mini/);

    /* and the one the source actually offered: a girls' uniform skirt
       for a row whose sizes are XS to XL */
    const kids = judge('sample-kinfield-pleated-midi-skirt', "French Toast Girls' Adjustable Waist Pleated Skirt");
    assert.strictEqual(kids.ok, false, 'a kids’ listing is a different product, not a less-described one');
    assert.match(kids.why, /kids/);
    assert.match(kids.why, /sizes/, 'and it says what made the row adult');
  });

  test('a double breasted blazer is answered only by a blazer that says so', () => {
    /* the right answer says it */
    const named = judge('sample-halden-double-breasted-blazer', 'Reiss Double Breasted Crepe Blazer');
    assert.strictEqual(named.ok, true, named.why);
    assert.match(named.why, /blazer matches blazer/);
    assert.match(named.why, /double breasted on both/);

    /* the live run's candidate is the right GARMENT with the defining
       word left open: a blazer, nothing contradicting, and nothing in
       the title saying it is the double-breasted one. Its page decides. */
    const cinq = judge('sample-halden-double-breasted-blazer', 'CINQ A SEPT Crepe Khloe Blazer');
    assert.strictEqual(cinq.ok, true, 'a title that is silent is not a title that disagrees');
    assert.strictEqual(cinq.kind, 'pending');
    assert.deepStrictEqual(cinq.pending.map(extractor.nameOfPending), ['double breasted']);

    /* and one that says the opposite is refused as the wrong garment,
       which is a different finding and says so */
    const single = judge('sample-halden-double-breasted-blazer', 'Reiss Single Breasted Wool Blazer');
    assert.strictEqual(single.ok, false);
    assert.strictEqual(single.kind, 'contradiction');
    assert.match(single.why, /single breasted/);
  });

  test('a tailored wool coat is answered by a tailored wool coat', () => {
    const theory = judge('sample-halden-tailored-wool-coat', 'Theory Tailored Merino Wool Coat');
    assert.strictEqual(theory.ok, true, theory.why);
    assert.match(theory.why, /coat matches coat/);
    assert.match(theory.why, /wool on both/);
    assert.match(theory.why, /tailored on both/);

    /* the listing may say it in its own words: the check is on what they
       mean, so "slim" establishes the row's "tailored" */
    const slim = judge('sample-halden-tailored-wool-coat', 'COS Slim Wool Coat');
    assert.strictEqual(slim.ok, true, slim.why);
    assert.match(slim.why, /tailored — the listing says slim/);

    /* merino IS wool, so it establishes a wool row; the reverse does not
       hold, which is what keeps a poplin row off a plain cotton shirt */
    assert.strictEqual(judge('sample-halden-tailored-wool-coat', 'Uniqlo Tailored Merino Coat').kind, 'match');
    assert.strictEqual(judge('sample-kinfield-poplin-shirt', 'Uniqlo Cotton Shirt').kind, 'pending',
      'cotton is broader than poplin and does not establish it');

    /* Tencel IS lyocell and establishes a lyocell row. Generic lyocell
       is one manufacturer's short of Tencel and establishes nothing, so
       the arrow points one way only. */
    assert.strictEqual(judge('sample-rue-nine-tencel-wrap-top', 'Quince Tencel Wrap Top').kind, 'match');
    const generic = judge('sample-rue-nine-tencel-wrap-top', 'Organic Basics Lyocell Wrap Top');
    assert.strictEqual(generic.kind, 'pending', 'generic lyocell is not Tencel');
    assert.deepStrictEqual(generic.pending.map(extractor.nameOfPending), ['tencel']);

    /* the live run's candidate: a wool coat, nothing contradicting, and
       the tailored cut left for its page to establish */
    const mango = judge('sample-halden-tailored-wool-coat', 'MANGO Double-breasted wool coat');
    assert.strictEqual(mango.ok, true);
    assert.strictEqual(mango.kind, 'pending');
    assert.deepStrictEqual(mango.pending.map(extractor.nameOfPending), ['tailored']);

    const cotton = judge('sample-halden-tailored-wool-coat', 'Everlane Tailored Organic Cotton Coat');
    assert.strictEqual(cotton.ok, false, 'wool is not cotton');
    assert.strictEqual(cotton.kind, 'contradiction');
    assert.match(cotton.why, /wool/);
    assert.match(cotton.why, /cotton/);
  });

  test('an unrelated garment is refused whatever else is right about it', () => {
    const wrong = [
      ['sample-solstice-ribbed-knit-skirt', 'Reformation Ribbed Knit Midi Dress', /bottom against dress/],
      ['sample-atlas-supply-oversized-hoodie', "Levi's Oversized Trucker Jacket", /top against outerwear/],
      ['sample-northfold-court-sneaker', 'Everlane The Court Day Tote', /footwear against accessory/],
      ['sample-rue-nine-silk-column-dress', 'Vince Silk Column Trousers', /dress against bottom/],
      ['sample-northfold-boxy-cotton-tee', 'Nike Everyday Cotton Crew Socks', /top against accessory/]
    ];
    for (const [id, title, family] of wrong) {
      const verdict = extractor.semanticMatch(catalogueRow(id), { title });
      assert.strictEqual(verdict.ok, false, `${title} answered ${id}: ${verdict.why}`);
      assert.match(verdict.why, family);
    }

    /* a title that names no garment at all cannot be checked, and an
       uncheckable listing is refused rather than waved through */
    const unreadable = judge('sample-northfold-boxy-cotton-tee', 'Aerie Real Good Something 3-Pack');
    assert.strictEqual(unreadable.ok, false);
    assert.match(unreadable.why, /names no garment/);
  });

  test('the brand is never compared, because these brands do not exist', () => {
    /* Kinfield, Northfold and Rue Nine were invented for the demo. A
       gate that wanted the brand back would refuse every real listing
       there is. */
    for (const [id, title] of [
      ['sample-rue-nine-tencel-wrap-top', 'Quince Tencel Jersey Wrap Top'],
      ['sample-northfold-boxy-cotton-tee', 'Everlane The Organic Cotton Boxy Tee'],
      ['sample-terrace-linen-camp-shirt', 'Banana Republic Linen Camp Collar Shirt']
    ]) {
      const verdict = judge(id, title);
      assert.strictEqual(verdict.ok, true, `${title}: ${verdict.why}`);
      assert.doesNotMatch(verdict.why, /brand/i);
    }
  });

  test('the head noun decides, because English puts it last', () => {
    const reading = (text) => extractor.readGarment(text, {});
    assert.strictEqual(reading('Ribbed Knit Skirt').type, 'skirt', 'a knit skirt is a skirt');
    assert.strictEqual(reading('Pleated Dress Pants').type, 'trouser', 'a dress pant is a trouser');
    assert.strictEqual(reading('Short Sleeve Pocket Tee').type, 'tee', 'a short sleeve is a sleeve');
    assert.strictEqual(reading('Cropped Track Jacket').type, 'jacket');
    assert.strictEqual(reading('Aerie Street Trouser Pants').type, 'trouser',
      'a generic head defers to the specific word beside it');
    assert.strictEqual(reading('Nike Fleece Jogger Pants').type, 'sweatpant');
  });

  test('the row tells the gate who it is for', () => {
    assert.strictEqual(extractor.adultSizing(['XS', 'S', 'M', 'L', 'XL']), true);
    assert.strictEqual(extractor.adultSizing(['4T', '5', '6X']), false);
    assert.strictEqual(extractor.adultSizing([]), false, 'no sizes is not evidence of anything');
  });

  test('every catalogue row names a garment the gate can read', () => {
    /* a row the gate cannot read is a row discovery can never fill, so
       this is the vocabulary's own coverage test */
    for (const row of extractor.readCatalog().rows) {
      const reading = extractor.readGarment(row.name, { sizes: row.sizes, fallback: row.category });
      assert.ok(reading.type, `${row.id} — "${row.name}" reads as no garment`);
      assert.ok(reading.family, `${row.id} — "${row.name}" reads as no family`);
    }
  });

  await testAsync('a listing that sells the wrong garment never has its page fetched', async () => {
    const retailer = await namedRetailer({ 771100: 'Street Trouser', 771200: 'Fleece Sweatpant' });
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        { title: 'Aerie Street Trouser', productUrl: listing(port, '771100'), retailer: 'Aerie' },
        { title: 'Kinfield Fleece Sweatpants', productUrl: listing(port, '771200'), retailer: 'Somewhere' }
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(catalogueRow('sample-kinfield-fleece-sweatpant'), new Map(), 4);

    assert.strictEqual(result.verdict, 'VERIFIED', result.why);
    assert.match(result.proposal.productUrl, /771200/, 'the sweatpant, not the trouser');

    /* every candidate carries its own decision, so the report can say
       why each one passed or failed rather than only naming a winner */
    assert.strictEqual(result.tried.length, 2);
    assert.strictEqual(result.tried[0].semantic.ok, false);
    assert.match(result.tried[0].semantic.why, /sweatpant.*trouser|trouser.*sweatpant/);
    assert.strictEqual(result.tried[1].semantic.ok, true);

    /* and the refused one cost no request at all: the gate reads a
       title, which is free, before anything reads a page */
    assert.ok(!retailer.hits.some((url) => url.includes('771100')),
      `the trouser's page was fetched anyway: ${retailer.hits.join(', ')}`);
    assert.ok(retailer.hits.some((url) => url.includes('771200')), 'the sweatpant’s page was read');

    retailer.close();
  });

  await testAsync('a feed title that flatters the listing is caught on the page itself', async () => {
    /* the feed says sweatpant, the page says trouser. The page is what
       is for sale. */
    const retailer = await namedRetailer({ 881100: 'Street Trouser' });
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [{ title: 'Fleece Sweatpant', productUrl: listing(port, '881100'), retailer: 'Aerie' }]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(catalogueRow('sample-kinfield-fleece-sweatpant'), new Map(), 4);

    assert.strictEqual(result.verdict, 'NO PRODUCT FOUND');
    assert.strictEqual(result.tried[0].semantic.ok, true, 'the title passed');
    assert.strictEqual(result.tried[0].onPage.ok, false, 'and the page did not');
    assert.match(result.tried[0].why, /its own page calls it "Street Trouser"/);
    assert.match(result.why, /1 refused as the wrong garment|none cleared every gate/);

    retailer.close();
  });

  await testAsync('the report says why the gate passed or failed on every candidate', async () => {
    const retailer = await namedRetailer({ 991100: 'Slip Midi Dress', 991200: 'Pleated Midi Skirt' });
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        { title: 'Reformation Slip Midi Dress', productUrl: listing(port, '991100'), retailer: 'Reformation' },
        { title: 'COS Pleated Twill Midi Skirt', productUrl: listing(port, '991200'), retailer: 'COS' }
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(catalogueRow('sample-kinfield-pleated-midi-skirt'), new Map(), 4);

    for (const attempt of result.tried) {
      assert.ok(attempt.semantic, 'every candidate carries a decision');
      assert.ok(attempt.semantic.why && attempt.semantic.why.length > 10, 'and a reason worth printing');
    }
    assert.strictEqual(result.tried[0].semantic.ok, false, 'a dress is not a skirt');
    assert.strictEqual(result.tried[1].semantic.ok, true);

    retailer.close();
  });

  /* ---------------------------------------------------------
     The product-page stage

     A shopping result's title is a headline. "Aerie Real Soft Jogger"
     is a fleece jogger or it is not, and the title will never say —
     so refusing it there throws away a candidate the PAGE settles in
     one line of its own product record.

     What the page is allowed to answer with is the whole question,
     because a page says far more than it sells. A "you may also like:
     wool midi skirts" strip would prove `midi` about a garment that is
     not for sale on that page at all. So the wrong things are put on
     the page here on purpose — the right words, in the wrong places —
     and the gate has to refuse to read them.
     --------------------------------------------------------- */
  console.log('\n  — the product-page stage\n');

  const pageSaying = (parts) => `<!doctype html><html><head>${parts.head || ''}</head><body>${parts.body || ''}</body></html>`;

  test('a descriptor missing from the title is proved by the page', () => {
    const row = catalogueRow('sample-kinfield-fleece-sweatpant');
    const stage1 = extractor.semanticMatch(row, { title: 'Aerie Real Soft Jogger' });
    assert.strictEqual(stage1.kind, 'pending', 'the title never says fleece');
    assert.deepStrictEqual(stage1.pending.map(extractor.nameOfPending), ['fleece']);

    /* the product's own structured record settles it */
    const evidence = extractor.evidenceFromHtml(pageSaying({
      head: `<script type="application/ld+json">{"@type":"Product","name":"Real Soft Jogger",
             "material":"Recycled polyester fleece"}</script>`
    }));
    const proof = extractor.proveOnPage(stage1.pending, evidence);
    assert.deepStrictEqual(proof.missing, [], 'the page says fleece and the gate did not see it');
    assert.strictEqual(proof.proved.length, 1);
    assert.strictEqual(proof.proved[0].where, 'json-ld material');

    /* and so does an attribute pair, which is where most shops put it */
    const attributes = extractor.evidenceFromHtml(pageSaying({
      head: `<script type="application/ld+json">{"@type":"Product","name":"Real Soft Jogger",
             "additionalProperty":[{"name":"Fabric","value":"100% brushed fleece"}]}</script>`
    }));
    assert.deepStrictEqual(extractor.proveOnPage(stage1.pending, attributes).missing, []);

    /* and the page's own description */
    const described = extractor.evidenceFromHtml(pageSaying({
      head: '<meta name="description" content="Cut from a soft brushed fleece.">'
    }));
    assert.deepStrictEqual(extractor.proveOnPage(stage1.pending, described).missing, []);
  });

  test('a descriptor in neither the title nor the page is refused', () => {
    const row = catalogueRow('sample-kinfield-fleece-sweatpant');
    const stage1 = extractor.semanticMatch(row, { title: 'Jumbie Art Earth Unisex Joggers' });

    const evidence = extractor.evidenceFromHtml(pageSaying({
      head: `<script type="application/ld+json">{"@type":"Product","name":"Earth Unisex Joggers",
             "material":"Organic cotton","description":"Relaxed joggers with a drawcord waist."}</script>`
    }));
    const proof = extractor.proveOnPage(stage1.pending, evidence);
    assert.strictEqual(proof.proved.length, 0);
    assert.deepStrictEqual(proof.missing.map(extractor.nameOfPending), ['fleece'],
      'nothing on that page says fleece, so nothing establishes it');
  });

  test('a page proves nothing with another product’s words', () => {
    /* the failure mode that makes page evidence dangerous: the right
       word, about the wrong garment */
    const row = catalogueRow('sample-halden-tailored-wool-coat');
    const stage1 = extractor.semanticMatch(row, { title: 'MANGO Double-breasted wool coat' });
    assert.deepStrictEqual(stage1.pending.map(extractor.nameOfPending), ['tailored']);

    for (const body of [
      '<div class="you-may-also-like">Tailored coats and blazers</div>',
      '<div class="product-recommendations"><p>Tailored wool coat</p></div>',
      '<nav><a href="/tailored">Tailored</a></nav>',
      '<footer>Tailored fits guide</footer>',
      '<div class="related-products carousel">Tailored</div>'
    ]) {
      const evidence = extractor.evidenceFromHtml(pageSaying({ body }));
      const proof = extractor.proveOnPage(stage1.pending, evidence);
      assert.strictEqual(proof.proved.length, 0,
        `a strip about other products proved "tailored": ${body}`);
    }

    /* a product-detail block that RUNS INTO a recommendation strip is
       read up to it and no further */
    const spliced = extractor.evidenceFromHtml(pageSaying({
      body: '<div class="product-description">A wool coat.<div class="you-may-also-like">Tailored coats</div></div>'
    }));
    assert.strictEqual(extractor.proveOnPage(stage1.pending, spliced).proved.length, 0,
      'the gate read past the strip it was supposed to stop at');

    /* and the same word inside the product's own description does prove it */
    const proper = extractor.evidenceFromHtml(pageSaying({
      body: '<div class="product-description">A tailored wool coat, cut close through the body.</div>'
    }));
    assert.deepStrictEqual(extractor.proveOnPage(stage1.pending, proper).missing, []);
  });

  await testAsync('discovery reads the page for what the title left pending', async () => {
    /* end to end: a title that never says fleece, a page that does */
    const retailer = await describingRetailer({
      445500: { name: 'Real Soft Jogger', material: 'Recycled polyester fleece' },
      445600: { name: 'Earth Unisex Jogger', material: 'Organic cotton' }
    });
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        { title: 'Jumbie Art Earth Unisex Joggers', productUrl: listing(port, '445600'), retailer: 'Jumbie' },
        { title: 'Aerie Real Soft Jogger', productUrl: listing(port, '445500'), retailer: 'Aerie' }
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(catalogueRow('sample-kinfield-fleece-sweatpant'), new Map(), 4);

    /* the cotton jogger read all the way to its page and still failed */
    assert.strictEqual(result.tried[0].semantic.kind, 'pending', 'its title left fleece open');
    assert.ok(result.tried[0].proof, 'so its page was read');
    assert.deepStrictEqual(result.tried[0].proof.missing.map(extractor.nameOfPending), ['fleece']);
    assert.match(result.tried[0].why, /its page never establishes fleece either/);

    /* the fleece one was proved by its page and written */
    assert.strictEqual(result.verdict, 'VERIFIED', result.why);
    assert.match(result.proposal.productUrl, /445500/);
    assert.strictEqual(result.provedOnPage.length, 1);
    assert.strictEqual(extractor.nameOfPending(result.provedOnPage[0].item), 'fleece');
    assert.match(result.provedOnPage[0].where, /material/);

    retailer.close();
  });

  await testAsync('a contradiction still ends a candidate on its title, unread', async () => {
    const retailer = await describingRetailer({
      446600: { name: 'Street Trouser', material: 'Brushed fleece' }
    });
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [{ title: 'Aerie Street Trouser', productUrl: listing(port, '446600'), retailer: 'Aerie' }]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(catalogueRow('sample-kinfield-fleece-sweatpant'), new Map(), 4);

    assert.strictEqual(result.verdict, 'NO PRODUCT FOUND');
    assert.strictEqual(result.tried[0].semantic.kind, 'contradiction');
    assert.match(result.tried[0].semantic.why, /sweatpant/);

    /* a page saying "fleece" in every field cannot rescue a trouser:
       the contradiction was settled before anything was fetched */
    assert.ok(!retailer.hits.some((url) => url.includes('446600')),
      `the trouser's page was fetched anyway: ${retailer.hits.join(', ')}`);

    retailer.close();
  });

  /* ---------------------------------------------------------
     Asking the source in more than one way
     --------------------------------------------------------- */
  console.log('\n  — asking the source in more than one way\n');

  test('the row’s own name is the first thing asked, not the last', () => {
    const forms = extractor.queryForms(catalogueRow('sample-kinfield-pleated-midi-skirt'));
    assert.strictEqual(forms[0].query, 'Pleated Midi Skirt', 'the name is the query');
    assert.ok(forms.some((form) => form.query === 'Pleated Midi Skirts'), 'and its plural');
    assert.ok(forms.some((form) => form.query === 'Midi Skirt'), 'and a widened form');
    assert.strictEqual(forms[forms.length - 1].query, null, 'the everything-query is the last resort');

    /* the old behaviour put eight words of metadata in front of the
       name, which is what a shopping API answered with nothing */
    const everything = forms[forms.length - 1].intent;
    /* spread, because a catalogue row's arrays come out of a vm realm
       and deepStrictEqual refuses them however identical they are */
    assert.deepStrictEqual([...everything.colors], ['Pastel'], 'the full intent is still there, last');
    assert.deepStrictEqual([...forms[0].intent.colors], [], 'and the first form carries none of it');
  });

  await testAsync('a query form that comes back empty is followed by another', async () => {
    const asked = [];
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async (intent) => {
        asked.push((intent.keywords || [])[0] || '(full intent)');
        /* only the widened form finds anything, which is the case the
           ladder exists for */
        return (intent.keywords || [])[0] === 'Midi Skirt'
          ? [{ title: 'COS Pleated Midi Skirt', productUrl: 'https://www.cos.com/p/123456', retailer: 'COS' }]
          : [];
      }
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const offered = await extractor.listingsFor(catalogueRow('sample-kinfield-pleated-midi-skirt'), 8);
    assert.strictEqual(offered.products.length, 1, 'the widened form found it');
    assert.ok(asked.length > 1, 'and the empty forms did not end the row');
    assert.strictEqual(asked[0], 'Pleated Midi Skirt');
  });

  await testAsync('a source that throws on one form is asked the next, not written off', async () => {
    let calls = 0;
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async (intent) => {
        calls += 1;
        if (calls === 1) throw new Error('The Google Product service is no longer offered by Google.');
        return [{ title: 'COS Pleated Midi Skirt', productUrl: 'https://www.cos.com/p/123456', retailer: 'COS' }];
      }
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const offered = await extractor.listingsFor(catalogueRow('sample-kinfield-pleated-midi-skirt'), 8);
    assert.ok(!offered.failed, `one failing query form ended the row: ${offered.failed}`);
    assert.strictEqual(offered.products.length, 1);
    assert.ok(offered.attempts.some((attempt) => attempt.failed), 'and the failure is still reported');
  });

  await testAsync('a source that throws on every form says so, and says NO SOURCE did not', async () => {
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => { throw new Error('The Google Product service is no longer offered by Google.'); }
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(catalogueRow('sample-kinfield-pleated-midi-skirt'), new Map(), 4);
    assert.strictEqual(result.verdict, 'SOURCE FAILED',
      'a source that answered with an error is not a source that was never configured');
    assert.match(result.why, /failed on all \d+ query forms/);
    assert.match(result.why, /no longer offered by Google/, 'and the error it gave is carried through');
    assert.ok((result.attempts || []).length > 1, 'and every form it tried is listed');
  });

  /* ---------------------------------------------------------
     One bad candidate is one bad candidate

     A live run verified two rows and then died on the third with
     "Cannot read properties of undefined (reading 'kind')". Nothing
     was wrong with the gate: proveOnPage returns `proved` as
     {item, where, quote} wrappers and `missing` as the pending items
     THEMSELVES, and the report read .item off both. So the first
     candidate that reached the page and failed to prove something took
     the whole run with it — twenty-two rows that had nothing wrong with
     them, lost to a console.log.

     Two things are tested here. That the exact shape is handled, and
     that it could not have aborted the run even if it had not been:
     a candidate that throws is a failed candidate, a row that throws is
     a failed row, and everything behind them still runs.
     --------------------------------------------------------- */
  console.log('\n  — one bad candidate is one bad candidate\n');

  test('the shape that crashed a run: missing entries are items, not wrappers', () => {
    const row = catalogueRow('sample-atlas-supply-cropped-track-jacket');
    const stage1 = extractor.semanticMatch(row, { title: 'Nike Windrunner Jacket' });
    assert.strictEqual(stage1.kind, 'pending');

    /* a page that establishes neither word, which is what produces a
       non-empty `missing` */
    const evidence = extractor.evidenceFromHtml(
      '<html><head><script type="application/ld+json">{"@type":"Product","name":"Windrunner Jacket",' +
      '"description":"A lightweight jacket."}</script></head><body></body></html>'
    );
    const proof = extractor.proveOnPage(stage1.pending, evidence);
    assert.ok(proof.missing.length, 'the page proves neither cropped nor track');

    /* the two collections are deliberately different shapes, and the
       report has to know which is which */
    for (const one of proof.missing) {
      assert.strictEqual(one.item, undefined, 'a missing entry IS the item');
      assert.ok(one.kind, 'and carries its kind directly');
      assert.match(extractor.nameOfPending(one), /cropped|track/);
    }
    for (const one of proof.proved) {
      assert.ok(one.item, 'a proved entry WRAPS the item');
    }

    /* and the namer survives being handed the wrong thing anyway,
       because a report is never worth a run */
    for (const wrong of [undefined, null, {}, 'a string', 42]) {
      assert.strictEqual(typeof extractor.nameOfPending(wrong), 'string',
        `nameOfPending(${JSON.stringify(wrong)}) threw or returned nothing`);
    }
  });

  await testAsync('the run that crashed now reports its unproven words instead', async () => {
    /* the exact live scenario: a jacket listing whose title leaves
       cropped and track pending, and a page that establishes neither.
       The gate never threw — the REPORT did, so the report is what is
       exercised here. */
    const retailer = await describingRetailer({
      300001: { name: 'Windrunner Jacket', description: 'A lightweight jacket.' }
    });
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [{ title: 'Nike Windrunner Jacket', productUrl: listing(port, '300001'), retailer: 'Nike' }]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(
      catalogueRow('sample-atlas-supply-cropped-track-jacket'), new Map(), 4);

    assert.strictEqual(result.verdict, 'NO PRODUCT FOUND');
    const attempt = result.tried[0];
    assert.ok(attempt.proof, 'the page was read');
    assert.ok(attempt.proof.missing.length, 'and proved neither word');

    /* printed exactly as the report prints it. Before the fix this line
       read .item off a missing entry and threw. */
    const printed = [
      ...attempt.proof.proved.map((one) => extractor.nameOfPending(one.item)),
      ...attempt.proof.missing.map((one) => extractor.nameOfPending(one))
    ];
    assert.deepStrictEqual(printed.sort(), ['cropped', 'track']);
    for (const name of printed) {
      assert.ok(name && !/unnamed/.test(name), `the report could not name a pending word: ${name}`);
    }

    retailer.close();
  });

  await testAsync('a candidate that throws is a failed candidate, and the next one still runs', async () => {
    const retailer = await describingRetailer({
      310001: { name: 'Cropped Track Jacket', description: 'A cropped track jacket.' }
    });
    const port = retailer.address().port;

    /* the first candidate's URL is a shape that breaks the page reader
       outright; the second is a perfectly good listing behind it */
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        { title: 'Cropped Track Jacket', productUrl: 'http://127.0.0.1:1/p/999999', retailer: 'Broken' },
        { title: 'Cropped Track Jacket', productUrl: listing(port, '310001'), retailer: 'Fine' }
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(
      catalogueRow('sample-atlas-supply-cropped-track-jacket'), new Map(), 4);

    assert.strictEqual(result.verdict, 'VERIFIED',
      `the second candidate was never reached: ${result.why}`);
    assert.match(result.proposal.productUrl, /310001/);
    assert.ok(result.tried[0].why, 'and the first one still says what went wrong with it');

    retailer.close();
  });

  await testAsync('a candidate whose title cannot be read at all is refused, not thrown', async () => {
    /* every tried entry carries a verdict with a kind, whatever the
       source handed over — a tried entry without one is a report that
       throws, which is the class of bug that lost a run */
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        { title: { not: 'a string' }, productUrl: 'https://www.example.com/p/1' },
        { title: null, productUrl: 'https://www.example.com/p/2' },
        { productUrl: 'https://www.example.com/p/3' }
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const result = await extractor.discoverRow(
      catalogueRow('sample-atlas-supply-cropped-track-jacket'), new Map(), 4);

    assert.ok(result.tried.length, 'the candidates were still listed');
    for (const attempt of result.tried) {
      assert.ok(attempt.semantic, 'every candidate carries a verdict');
      assert.ok(attempt.semantic.kind, 'and every verdict carries a kind the report can read');
      assert.strictEqual(typeof attempt.semantic.why, 'string');
    }
  });

  await testAsync('a record that throws when read is dropped, not propagated', async () => {
    /* the source is not obliged to hand over well-behaved objects. One
       that throws on being read is one record gone. */
    const hostile = { get productUrl() { throw new Error('this record bites'); } };
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [hostile, { title: 'Cropped Track Jacket', productUrl: 'https://www.example.com/p/778899' }]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const offered = await extractor.listingsFor(catalogueRow('sample-atlas-supply-cropped-track-jacket'), 8);
    assert.ok(!offered.failed, `one hostile record ended the row: ${offered.failed}`);
    assert.strictEqual(offered.products.length, 1, 'the good record came through');
    assert.ok(offered.rejected['unreadable-record'], 'and the bad one is counted rather than hidden');
  });

  await testAsync('a row that fails does not stop the rows behind it', async () => {
    /* the run-level promise: whatever one row does, the queue survives
       it. The provider throws for one row's queries and answers for the
       next, which is the shape a blocked retailer takes. */
    const retailer = await describingRetailer({
      320001: { name: 'Pleated Midi Skirt', description: 'A pleated midi skirt.' }
    });
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async (intent) => {
        const asked = String((intent.keywords || [])[0] || '');
        /* every form of the jacket row's query, widened ones included */
        if (/Jacket/i.test(asked)) throw new Error('the retailer blocked this query');
        return [{ title: 'COS Pleated Midi Skirt', productUrl: listing(port, '320001'), retailer: 'COS' }];
      }
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const failing = await extractor.discoverRow(
      catalogueRow('sample-atlas-supply-cropped-track-jacket'), new Map(), 4);
    assert.strictEqual(failing.verdict, 'SOURCE FAILED', 'the blocked row reports its own failure');

    /* and the very next row is unaffected */
    const following = await extractor.discoverRow(
      catalogueRow('sample-kinfield-pleated-midi-skirt'), new Map(), 4);
    assert.strictEqual(following.verdict, 'VERIFIED',
      `a row behind a failing one was affected by it: ${following.why}`);

    retailer.close();
  });

  await testAsync('a whole --discover run survives a row that throws', async () => {
    /* the outermost promise, through the real CLI: a source that throws
       on everything cannot take the process down, and the run still
       reports and still exits 0 */
    const result = await run(['--discover', '--no-browser']);
    assert.strictEqual(result.code, 0, `the run exited ${result.code}: ${result.stderr}`);
    assert.match(result.stdout, /row[s]? found a listing that cleared every gate/,
      'the run reached its own summary');
    assert.doesNotMatch(result.stderr, /Cannot read properties of undefined/);
  });

  /* ---------------------------------------------------------
     What discovery is allowed to write

     A sample row's identity is the demo's own. "Tailored Wool Coat" by
     Halden is what that row MEANS, and discovery's job is to find a
     real garment that represents it — not to rename the row after
     whichever shop happened to stock one. A row renamed to "MANGO
     Double-breasted wool coat" is no longer the row the demo was built
     around, and its price, category, style and occasion now describe a
     product nobody chose.

     And a photo whose URL does not carry its listing's code cannot be
     re-proved later without a note saying how it was tied. A written
     row with no imageEvidence is one --coverage reports as unaccounted,
     which is how three written rows came back unaccounted for.

     So: three fields filled, everything else left alone, and the
     evidence recorded every time it is needed.
     --------------------------------------------------------- */
  console.log('\n  — what discovery is allowed to write\n');

  /* a retailer whose photo filename says nothing about the product, so
     the row can only account for itself by recording the sku the page
     declared. This is the shape the three unaccounted rows had. */
  function opaqueRetailer() {
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      if (url.endsWith('.jpg')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(JPEG);
      }
      const code = (url.match(/\d{6,}/) || ['000000'])[0];
      const here = `http://127.0.0.1:${server.address().port}${url}`;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head>
        <link rel="canonical" href="${here}">
        <meta property="og:title" content="Tailored Merino Wool Coat">
        <meta property="og:site_name" content="Theory">
        <script type="application/ld+json">
        {"@type":"Product","sku":"${code}","name":"Tailored Merino Wool Coat",
         "brand":{"@type":"Brand","name":"Theory"},
         "image":["/img/anonymous-asset.jpg"]}
        </script></head><body></body></html>`);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  await testAsync('discovery keeps the sample row and fills only its link, photo and evidence', async () => {
    const retailer = await opaqueRetailer();
    const port = retailer.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [{
        title: 'Theory Tailored Merino Wool Coat',
        productUrl: listing(port, '664422'),
        retailer: 'Theory'
      }]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const before = extractor.readCatalog();
    const was = before.rows.find((r) => r.id === 'sample-halden-tailored-wool-coat');

    const found = await extractor.discoverRow(was, new Map(), 4);
    assert.strictEqual(found.verdict, 'VERIFIED', found.why);

    /* the writer, on the catalogue's own source. Nothing is written to
       disk: what is checked is what the row BECOMES. */
    const next = extractor.linkRow(before.source, 'sample-halden-tailored-wool-coat', found.proposal);
    const rows = evaluate(next);
    const now = rows.find((r) => r.id === 'sample-halden-tailored-wool-coat');

    /* 1 — the sample name is not replaced */
    assert.strictEqual(now.name, 'Tailored Wool Coat',
      `the row was renamed to ${JSON.stringify(now.name)} after the shop's listing`);

    /* 2 — nor the sample brand */
    assert.strictEqual(now.brand, 'Halden',
      `the row's brand was replaced with ${JSON.stringify(now.brand)}`);

    /* 3 — the evidence the image gate established is persisted */
    assert.ok(now.imageEvidence, 'the row records no evidence for a photo whose URL cannot vouch for it');
    assert.deepStrictEqual(plain(now.imageEvidence), { via: 'json-ld-sku', sku: '664422' });
    assert.strictEqual(extractor.catalogRowIdentity(now).ok, true,
      'and so the row accounts for itself, which is what --coverage counts');

    /* 4 — the link and the photo are persisted */
    assert.strictEqual(now.productUrl, listing(port, '664422'));
    assert.match(now.imageUrl, /anonymous-asset\.jpg$/);

    /* every other field of the row is untouched */
    for (const field of ['id', 'price', 'category']) {
      assert.deepStrictEqual(now[field], was[field], `${field} moved`);
    }
    for (const field of ['style', 'occasion', 'fit', 'colors', 'sizes']) {
      assert.deepStrictEqual([...(now[field] || [])], [...(was[field] || [])], `${field} moved`);
    }

    /* 5 — the rows that already carry a verified photo are untouched,
       byte for byte and field for field */
    for (const id of ['uniqlo-merino-crew', 'jcrew-broken-in-oxford', 'llbean-venturestretch-chino']) {
      const kept = rows.find((r) => r.id === id);
      const original = before.rows.find((r) => r.id === id);
      for (const field of ['name', 'brand', 'price', 'productUrl', 'imageUrl', 'category']) {
        assert.deepStrictEqual(kept[field], original[field], `${id}.${field} moved`);
      }
      assert.deepStrictEqual(plain(kept.imageEvidence), plain(original.imageEvidence), `${id}.imageEvidence moved`);
    }

    /* and no line of the file moved that was not one of the three.
       Compared as a multiset of lines, because adding an evidence note
       shifts every line after it without changing any of them. */
    const tally = (text) => text.split('\n').reduce((seen, line) => seen.set(line, (seen.get(line) || 0) + 1), new Map());
    const linesBefore = tally(before.source);
    const linesAfter = tally(next);
    const moved = [];
    for (const [line, count] of linesAfter) if (count > (linesBefore.get(line) || 0)) moved.push(line);
    for (const [line, count] of linesBefore) if (count > (linesAfter.get(line) || 0)) moved.push(line);
    assert.ok(moved.length, 'the writer changed nothing at all');
    for (const line of moved) {
      assert.match(line, /productUrl|imageUrl|imageEvidence/,
        `discovery rewrote a line it had no business touching: ${line.trim()}`);
    }

    retailer.close();
  });

  test('a photo that cannot account for itself is refused rather than written bare', () => {
    /* the bug this closes: a row written with no evidence for a photo
       whose URL carries no code is a row --coverage calls unaccounted.
       Better to refuse the write than to ship one. */
    assert.throws(() => extractor.linkRow(source, 'sample-kinfield-fleece-sweatpant', {
      productUrl: 'https://www.example.com/p/998877',
      imageUrl: 'https://cdn.example.com/media/anonymous.jpg',
      identity: { ok: false }
    }), /recorded no evidence/);

    /* a URL that carries the listing's own code needs no note and is
       written without one */
    const fine = extractor.linkRow(source, 'sample-kinfield-fleece-sweatpant', {
      productUrl: 'https://www.example.com/p/998877',
      imageUrl: 'https://cdn.example.com/media/998877-hero.jpg',
      identity: { ok: true, via: 'image-url', code: '998877' }
    });
    const row = evaluate(fine).find((r) => r.id === 'sample-kinfield-fleece-sweatpant');
    assert.strictEqual(row.imageEvidence, undefined, 'a URL that speaks for itself gets no note');
    assert.strictEqual(row.name, 'Fleece Sweatpant');
    assert.strictEqual(row.brand, 'Kinfield');
    assert.strictEqual(extractor.catalogRowIdentity(row).ok, true);
  });

  test('a swapped row records evidence for its new photo too', () => {
    /* --candidate --as is the deliberate replacement, where the name and
       brand SHOULD move; it still has to account for the photo */
    const next = extractor.replaceRow(source, 'jcrew-broken-in-oxford', {
      name: 'Slim Oxford Shirt',
      brand: 'Uniqlo',
      productUrl: 'https://www.uniqlo.com/us/en/products/E455000-000/00',
      imageUrl: 'https://image.uniqlo.com/opaque-asset.jpg',
      identity: { ok: true, via: 'json-ld-sku', sku: 'E455000' }
    });
    const row = evaluate(next).find((r) => r.id === 'jcrew-broken-in-oxford');
    assert.strictEqual(row.name, 'Slim Oxford Shirt', 'a hand-driven swap does move the name');
    assert.deepStrictEqual(plain(row.imageEvidence), { via: 'json-ld-sku', sku: 'E455000' });
    assert.strictEqual(extractor.catalogRowIdentity(row).ok, true);
  });

  await testAsync('--coverage reports without reading anything, and --help lists the modes', async () => {
    const report = await run(['--coverage']);
    assert.strictEqual(report.code, 0);
    assert.match(report.stdout, /of 27 rows carry a photo/);
    assert.match(report.stdout, /27 of 27 account for what they carry/);
    assert.doesNotMatch(report.stdout, /Reading \d+ linked product page/);

    const help = await run(['--help']);
    assert.match(help.stdout, /--discover/);
    assert.match(help.stdout, /--coverage/);
    for (const option of Object.keys(extractor.OPTIONS)) {
      assert.ok(extractor.USAGE.includes(option), `--help says nothing about ${option}`);
    }
  });

  await testAsync('an option nobody recognises stops the run', async () => {
    const result = await run(['--discovar']);
    assert.notStrictEqual(result.code, 0);
    assert.match(result.stderr, /unknown option "--discovar"/);
    assert.doesNotMatch(result.stdout, /Reading \d+ linked product page/);
  });

  console.log(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(failures.length ? 1 : 0);
})();

/* evaluates an edited catalogue the way the extractor reads the real
   one, so a write is judged by what the rows become, not by string
   matching on the file */
/* the real assets/products.js, run the way a page runs it, so what the
   interface does with a catalogue row is answered by the interface's own
   code rather than by this test's idea of it */
function loadProductsLayer() {
  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(path.join(__dirname, '..', 'assets', 'products.js'), 'utf8');
  /* a vm context starts without URL, and products.js uses it to decide
     whether a link is usable — without it every URL would read as
     unusable and this test would be measuring the sandbox */
  const sandbox = { URL, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(code).runInContext(sandbox, { timeout: 5000 });
  return sandbox.Products;
}

/* A catalogue row comes back from a vm context, so its objects carry
   that realm's prototype and deepStrictEqual refuses them however
   identical the contents. Copied into this realm they compare on what
   they actually hold. */
function plain(value) {
  return value == null ? value : Object.assign({}, value);
}

function evaluate(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(source + ';this.__rows = DEMO_PRODUCTS;').runInContext(sandbox, { timeout: 5000 });
  return sandbox.__rows;
}
