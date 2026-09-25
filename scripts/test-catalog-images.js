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
const os = require('os');
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

/* The catalogue as shipped, read once before any test can write to it.
   A test of what the shipped catalogue says reads this, never the file
   as some earlier test may have left it mid-run. */
const SHIPPED_CATALOG = fs.readFileSync(CATALOG, 'utf8');

/* Every discovery report these tests write lives here, and --report
   points the script at it. Nothing touches the default path beside the
   catalogue, so a run of this suite cannot pick up — or leave behind —
   a report belonging to a real --discover run. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-catalog-images-'));

/* The environment of a run that has no product source at all. The
   subprocess inherits this process's environment, which on a developer's
   machine carries whatever keys .env.local exported — and a leftover
   PRODUCT_SOURCE from an earlier test. A test of "nothing is configured"
   cannot lean on either being absent, so every variable that selects or
   unlocks a source is removed here rather than hoped away. */
const SOURCE_ENV = /^(PRODUCT_SOURCE|OPENWEBNINJA_.*|SERPAPI_.*|SERPER_.*|ETSY_.*|EXAMPLE_API_KEY)$/;

function withoutSources() {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!SOURCE_ENV.test(name.toUpperCase())) env[name] = value;
  }
  return env;
}

async function run(argv, options) {
  const env = (options && options.env) || process.env;
  try {
    const { stdout, stderr } = await execFile(process.execPath, [SCRIPT, ...argv], { env, timeout: 120000 });
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

/* a page that publishes someone else's garment as its og:image, and its
   own product's photo further down. This is the shape that wrote a linen
   shirt into a sweater polo's row. */
function mismatchedRetailer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.endsWith('.jpg')) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(JPEG);
    }
    const here = `http://127.0.0.1:${server.address().port}${url}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="${here}">
      <meta property="og:title" content="Linen Camp Shirt">
      <link rel="preload" as="image" href="/img/441122-hero.jpg">
      <script type="application/ld+json">
      {"@type":"Product","name":"Linen Camp Shirt",
       "image":["/img/todd-snyder-cotton-cashmere-sweater-polo.jpg"]}
      </script>
      </head><body></body></html>`);
  });
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

      /* Nothing verifies, and WHICH gate refuses is the point. This
         fixture's images are a 78-byte PNG, so the size gate turns them
         down — a real refusal, reached by actually loading the image
         through the browsing context that loaded the page.

         It used to be refused for another reason entirely: the browser
         had already been closed by the time the checker was handed
         over, so every candidate came back "Target page, context or
         browser has been closed". The verdict was the same and the gate
         was never reached. */
      assert.strictEqual(result.verdict, 'NO IMAGE FOUND');
      assert.strictEqual(result.url, null);

      const loadable = (result.refusals || []).filter((r) => r.gate === 'loadable');
      assert.ok(loadable.length, `no candidate reached the loadable gate: ${JSON.stringify(result.refusals)}`);
      for (const refusal of loadable) {
        assert.match(refusal.why, /too small to be a product photo/,
          `the image was never actually loaded: ${refusal.why}`);
        assert.doesNotMatch(refusal.why, /has been closed/,
          'the browser was closed before the photo could be checked through it');
      }
    });
  }

  /* renderPage hands the page back OPEN now, so that an image can be
     checked through the browsing context that loaded it. Whoever asked
     for it closes it. */
  if (probe.close) await probe.close();
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

    if (seen.close) await seen.close();
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
    const rows = evaluate(SHIPPED_CATALOG);
    const report = extractor.coverage(rows);

    assert.strictEqual(report.rows, rows.length);
    assert.strictEqual(report.withPhoto, rows.filter((row) => row.imageUrl).length);
    /* a row vouched for by its page's embedded record is not counted
       from the file: it waits for --coverage to read that page again,
       and is accounted for only then. Nothing else may be left over. */
    for (const id of report.awaitingPage) {
      const checked = extractor.catalogRowIdentity(rows.find((row) => row.id === id));
      assert.ok(checked.ok && checked.needsLive, `${id} waits on its page without evidence that needs one`);
    }
    assert.strictEqual(report.accounted + report.awaitingPage.length, rows.length, 'every row accounts for what it carries');
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

  /* A catalogue row that exists only for the length of one test, with no
     link and no photo, so discovery has something to look for however
     much of the real catalogue has been photographed since. With nothing
     to look for, discovery never asks for a source, and a test of "no
     source is configured" would pass without ever reaching that path.
     It wears the garment of the Northfold tee, under an id of its own. */
  const NO_SOURCE_FIXTURE = {
    id: 'fixture-northfold-boxy-cotton-tee',
    name: 'Boxy Cotton Tee',
    brand: 'Northfold',
    price: null,
    productUrl: null,
    imageUrl: null,
    category: 'tee',
    style: ['Minimal', 'Sporty'],
    occasion: ['Everyday', 'Weekend'],
    fit: ['Relaxed', 'Oversized'],
    colors: ['White'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  };

  /* Adds rows to the end of DEMO_PRODUCTS in the file's own shape, runs
     the test, and puts assets/catalog.js back byte for byte whatever
     happens. The callback is handed the catalogue as it stood WITH the
     fixture rows, so "wrote nothing" is judged against what the run was
     given. A function declaration, so it is usable above
     withCatalogRestored, which it relies on. */
  async function withFixtureRows(rows, fn, options) {
    const unlink = (options && options.unlink) || [];
    const literal = (value) => {
      if (value === null || value === undefined) return 'null';
      if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
      if (typeof value === 'number') return String(value);
      return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    };
    return withCatalogRestored(async () => {
      const source = unlinkedCatalogue(fs.readFileSync(CATALOG, 'utf8'), unlink);
      const start = source.indexOf('const DEMO_PRODUCTS = [');
      assert.ok(start >= 0, 'assets/catalog.js no longer declares DEMO_PRODUCTS');
      const end = source.indexOf('\n];', start);
      assert.ok(end >= 0, 'could not find the end of DEMO_PRODUCTS');

      const text = rows.map((row) => `  {\n${Object.entries(row)
        .map(([field, value]) => `    ${field}: ${literal(value)}`)
        .join(',\n')}\n  }`).join(',\n');
      fs.writeFileSync(CATALOG, `${source.slice(0, end)},\n${text}${source.slice(end)}`);

      const ids = extractor.readCatalog().rows.map((r) => r.id);
      for (const row of rows) {
        assert.strictEqual(ids.filter((id) => id === row.id).length, 1, `fixture row ${row.id} did not land once`);
      }
      return fn(fs.readFileSync(CATALOG));
    });
  }

  /* The catalogue text with the named rows put back to how a sample row
     starts: no listing, no photo, no evidence. Every other row, and every
     other field of these, is left exactly as it is.

     The shipped catalogue is real data that discovery keeps filling in,
     so a test that needs a row to start empty — or needs the only row
     carrying some piece of evidence to be its own fixture — cannot take
     that from the live file. It says which rows it needs cleared, and
     gets them cleared. */
  function unlinkedCatalogue(source, ids) {
    let out = source;
    for (const id of ids) {
      const at = out.indexOf(`\n    id: '${id}',`);
      assert.ok(at >= 0, `assets/catalog.js has no row ${id} to clear`);
      const start = out.lastIndexOf('\n  {', at);
      const end = out.indexOf('\n  }', at);
      const row = out.slice(start, end)
        .replace(/\n    productUrl: .*,/, '\n    productUrl: null,')
        .replace(/\n    imageUrl: .*,/, '\n    imageUrl: null,')
        .replace(/\n    imageEvidence: .*,/, '');
      out = out.slice(0, start) + row + out.slice(end);
    }

    const was = evaluate(source);
    const now = evaluate(out);
    assert.strictEqual(now.length, was.length, 'clearing rows added or dropped one');
    for (let at = 0; at < was.length; at += 1) {
      const cleared = ids.includes(was[at].id);
      assert.strictEqual(now[at].id, was[at].id, 'clearing rows moved one');
      if (cleared) {
        assert.strictEqual(now[at].productUrl, null, `${was[at].id} is still linked`);
        assert.strictEqual(now[at].imageUrl, null, `${was[at].id} still carries a photo`);
        assert.strictEqual(now[at].imageEvidence, undefined, `${was[at].id} still carries evidence`);
      }
      for (const field of Object.keys(was[at])) {
        if (cleared && ['productUrl', 'imageUrl', 'imageEvidence'].includes(field)) continue;
        assert.strictEqual(JSON.stringify(now[at][field]), JSON.stringify(was[at][field]), `${was[at].id}.${field} moved`);
      }
    }
    return out;
  }

  /* Runs the test against a fixture catalogue — the shipped one with the
     named rows cleared — and puts assets/catalog.js back byte for byte
     whatever happens. The callback is handed the fixture as it stood
     before the test did anything to it. */
  async function withFixtureCatalogue(ids, fn) {
    return withCatalogRestored(async () => {
      fs.writeFileSync(CATALOG, unlinkedCatalogue(fs.readFileSync(CATALOG, 'utf8'), ids));
      return fn(fs.readFileSync(CATALOG));
    });
  }

  /* the shipped rows whose photo is vouched for by their own page's
     embedded record, which only reading that page again can re-prove.
     A test that reads the whole catalogue back through --coverage clears
     these, so it never depends on a live retailer answering, and a test
     that plants such a row of its own is the only one of its kind. */
  const EMBEDDED_ROWS = extractor.coverage(evaluate(SHIPPED_CATALOG)).awaitingPage;

  await testAsync('with no source configured, discovery says so and writes nothing', async () => {
    const original = fs.readFileSync(CATALOG);
    const fixture = NO_SOURCE_FIXTURE;
    await withFixtureRows([fixture], async (before) => {
      const result = await run([
        '--discover', '--only', fixture.id, '--write',
        /* a report path with nothing at it, so this stays a test of what
           happens with no source rather than of what was left lying
           beside the catalogue by an earlier run */
        '--report', path.join(TMP, 'no-source.json')
      ], { env: withoutSources() });
      const after = fs.readFileSync(CATALOG);

      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.stdout, /Looking for a real listing for 1 row that carries no photo/,
        'discovery had nothing to look for, so this never reached the source');
      assert.match(result.stdout, new RegExp(fixture.id));
      assert.match(result.stdout, /no product source is configured/);
      assert.match(result.stdout, /rows? already carry one and are not touched/);
      assert.ok(before.equals(after), 'assets/catalog.js is byte-for-byte what it was');
    });
    assert.ok(fs.readFileSync(CATALOG).equals(original), 'the fixture row was left in assets/catalog.js');
  });

  await testAsync('discovery leaves the verified rows out of its list entirely', async () => {
    const result = await run(['--discover']);
    assert.strictEqual(result.code, 0, result.stderr);

    /* counted off the catalogue rather than written in: every run of
       --write moves this number, and a test that hardcodes it fails
       for the one reason that is not a fault */
    const photographed = extractor.readCatalog().rows.filter((row) => row && row.imageUrl);
    assert.ok(photographed.length, 'the catalogue carries no verified photo to leave alone');

    for (const row of photographed) {
      assert.doesNotMatch(result.stdout, new RegExp(row.id),
        `${row.id} already carries a verified photo and is not a target`);
    }
    assert.match(result.stdout, new RegExp(
      `${photographed.length} rows? already carry one and are not touched`));
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

  test('a puffer jacket or coat is a puffer, not the jacket or coat after it', () => {
    /* the way shops title the garment: "jacket" and "coat" end the
       title, and read as the head noun they refused every one */
    for (const title of ['Cropped Puffer Jacket', "Women's Cropped Puffer Jacket - Red", 'Cropped Puffer Coat']) {
      const verdict = judge('sample-coveworks-cropped-puffer', title);
      assert.strictEqual(verdict.ok, true, `${title}: ${verdict.why}`);
      assert.strictEqual(verdict.kind, 'match', `${title} left something pending: ${verdict.why}`);
      assert.match(verdict.why, /puffer matches puffer/);
      assert.match(verdict.why, /cropped on both/);
    }

    /* the garment is a puffer, but the title never says cropped: the
       page still has to establish it */
    for (const title of ['Puffer Jacket', 'Quilted Puffer Coat']) {
      const verdict = judge('sample-coveworks-cropped-puffer', title);
      assert.strictEqual(verdict.ok, true, `${title}: ${verdict.why}`);
      assert.strictEqual(verdict.kind, 'pending', `${title} was settled without saying cropped`);
      assert.deepStrictEqual(verdict.pending.map(extractor.nameOfPending), ['cropped']);
    }

    /* a puffer VEST is a vest, not a puffer jacket */
    const vest = judge('sample-coveworks-cropped-puffer', 'Cropped Puffer Vest');
    assert.strictEqual(vest.ok, false, 'a vest answered a puffer');
    assert.match(vest.why, /is a vest/);

    /* and the jacket and coat types around it are read as before */
    assert.strictEqual(extractor.readGarment('Cropped Puffer Jacket').type, 'puffer');
    assert.strictEqual(extractor.readGarment('Puffer Coat').type, 'puffer');
    assert.strictEqual(extractor.readGarment('Puffer Vest').type, 'vest');
    assert.strictEqual(extractor.readGarment('Denim Jacket').type, 'jacket');
    assert.strictEqual(extractor.readGarment('Cropped Track Jacket').type, 'jacket');
    assert.strictEqual(extractor.readGarment('Tailored Wool Coat').type, 'coat');
    assert.strictEqual(extractor.readGarment('Trench Coat').type, 'coat');
    assert.strictEqual(extractor.readGarment('Button Down Coat').type, 'coat', 'a button-down coat is not a puffer');
    const coat = judge('sample-halden-tailored-wool-coat', 'Tailored Wool Puffer Coat');
    assert.strictEqual(coat.ok, false, 'a puffer answered a tailored coat');
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
     Canonical evidence has to name the same product

     `via: 'canonical'` says: this page declares itself the canonical
     page for the listing, and this is the image it publishes as its
     product's. The first half was checked and the second half was
     assumed, which makes it circular — virtually every product page is
     canonical for its own URL, so the page was vouching for the page
     and nothing was ever tied to the PRODUCT.

     A live run wrote a linen shirt's photo under a cotton-cashmere
     sweater polo's listing, with a canonical that matched the listing
     exactly. Both halves of the note were true and the row was wrong.
     --------------------------------------------------------- */
  console.log('\n  — canonical evidence has to name the same product\n');

  const LYST = 'https://www.lyst.com/clothing/todd-snyder-cotton-cashmere-sweater-polo-441122/';

  test('a canonical page whose photo is a different garment is refused', () => {
    /* the exact row the live run produced */
    const verdict = extractor.identityEvidence({
      url: 'https://cdn.lyst.com/photos/todd-snyder-sea-soft-irish-linen-shirt.jpg',
      from: 'og:image',
      canonical: LYST
    }, LYST);

    assert.strictEqual(verdict.ok, false, 'a polo listing accepted a linen shirt');
    assert.match(verdict.why, /different garment/);
    assert.match(verdict.why, /polo against shirt/);
  });

  test('the same listing, photographed, still proves itself', () => {
    /* the rule refuses a disagreement it can SEE. It must not refuse
       agreement, or every canonical row in the catalogue goes with it. */
    const verdict = extractor.identityEvidence({
      url: 'https://cdn.lyst.com/photos/todd-snyder-cotton-cashmere-sweater-polo.jpg',
      from: 'og:image',
      canonical: LYST
    }, LYST);
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.strictEqual(verdict.via, 'canonical');
  });

  test('an opaque photo filename leaves the rule exactly where it was', () => {
    /* silence is not disagreement here either: a CDN that names its
       assets with a hash says nothing about the garment, and canonical
       evidence stands or falls on what it always did */
    const verdict = extractor.identityEvidence({
      url: 'https://cdn.lyst.com/photos/8f2a91c4e7b3.jpg',
      from: 'og:image',
      canonical: LYST
    }, LYST);
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.strictEqual(verdict.via, 'canonical');
  });

  test('the photo’s alt text and product record are read too', () => {
    /* an opaque filename is not the only thing a candidate knows about
       what it is a picture of */
    const byAlt = extractor.identityEvidence({
      url: 'https://cdn.lyst.com/photos/8f2a91c4e7b3.jpg',
      from: 'og:image',
      alt: 'Todd Snyder Sea Soft Irish Linen Shirt',
      canonical: LYST
    }, LYST);
    assert.strictEqual(byAlt.ok, false, 'the alt text said shirt and the listing says polo');

    const byRecord = extractor.identityEvidence({
      url: 'https://cdn.lyst.com/photos/8f2a91c4e7b3.jpg',
      from: 'json-ld',
      node: { name: 'Sea Soft Irish Linen Shirt' },
      canonical: LYST
    }, LYST);
    assert.strictEqual(byRecord.ok, false, 'the product record named a different garment');
  });

  test('a fabric the listing rules out is refused as well as a garment', () => {
    const wool = 'https://www.example.com/clothing/merino-wool-crew-sweater-551133/';
    const verdict = extractor.identityEvidence({
      url: 'https://cdn.example.com/photos/organic-cotton-crew-sweater.jpg',
      from: 'og:image',
      canonical: wool
    }, wool);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /wool against cotton/);
  });

  test('a code from a tracking parameter is not a product code', () => {
    /* what let the live case reach the canonical rule at all: the only
       digits in that URL came off an ad network's click id */
    assert.deepStrictEqual(
      extractor.identifiersFrom('https://www.lyst.com/clothing/todd-snyder-sweater-polo/?atc_medium=cpc&gclid=99887766554'),
      [], 'a click id is not a product');

    /* a parameter that really does name the product still counts */
    assert.deepStrictEqual(
      extractor.identifiersFrom('https://shop.example.com/p?productId=1234567'), ['1234567']);

    /* and the shipped rows are untouched */
    assert.ok(extractor.identifiersFrom('https://www.uniqlo.com/us/en/products/E429066-000/00').includes('429066'));
    assert.ok(extractor.identifiersFrom('https://www.jcrew.com/p/AU763').includes('au763'));
  });

  test('a recorded canonical note is re-proved, not trusted', () => {
    /* --coverage has to catch a row like the live one, whether this
       rule existed when it was written or not */
    const wrong = {
      id: 'x',
      productUrl: LYST,
      imageUrl: 'https://cdn.lyst.com/photos/todd-snyder-sea-soft-irish-linen-shirt.jpg',
      imageEvidence: { via: 'canonical', canonical: LYST }
    };
    const checked = extractor.catalogRowIdentity(wrong);
    assert.strictEqual(checked.ok, false, 'a row carrying this note reports as accounted for');
    assert.match(checked.why, /different garment/);

    const right = Object.assign({}, wrong, {
      imageUrl: 'https://cdn.lyst.com/photos/todd-snyder-cotton-cashmere-sweater-polo.jpg'
    });
    assert.strictEqual(extractor.catalogRowIdentity(right).ok, true);
  });

  test('the shipped catalogue still accounts for every row', () => {
    /* the rule is a tightening, and a tightening that unseats a
       verified row is a bug in the rule */
    const rows = evaluate(SHIPPED_CATALOG);
    const report = extractor.coverage(rows);
    assert.deepStrictEqual(report.unaccounted, []);
    /* every row is accounted for from the file, or has evidence that is
       sound on its face and only its own page, read again, can settle */
    for (const id of report.awaitingPage) {
      const checked = extractor.catalogRowIdentity(rows.find((row) => row.id === id));
      assert.ok(checked.ok && checked.needsLive, `${id} is set aside without evidence that needs its page`);
    }
    assert.strictEqual(report.accounted + report.awaitingPage.length, report.rows);
  });

  await testAsync('a refused canonical falls back to a photo that proves itself', async () => {
    /* the page offers its og:image first — a different garment — and a
       gallery image second that carries the listing's own code. The
       first is refused and the second is taken, which is the whole
       point of refusing rather than accepting. */
    const retailer = await mismatchedRetailer();
    const port = retailer.address().port;
    const productUrl = `http://127.0.0.1:${port}/clothing/terrace-linen-camp-shirt-441122/`;

    const result = await extractor.resolveRow({
      id: 'sample-terrace-linen-camp-shirt',
      brand: 'Terrace',
      name: 'Linen Camp Shirt',
      productUrl
    });

    assert.strictEqual(result.verdict, 'VERIFIED', result.why);
    assert.match(result.url, /441122-hero\.jpg$/, 'it took the photo that carries the code');
    assert.doesNotMatch(result.url, /sweater-polo/, 'and not the one the canonical would have waved through');
    assert.strictEqual(result.identity.via, 'image-url', 'proved by the code, not by the page vouching for itself');

    /* and the row that results accounts for itself with no note at all */
    assert.strictEqual(extractor.evidenceNote(result.identity), null);

    retailer.close();
  });

  /* ---------------------------------------------------------
     Falling back to Serper when the allowance runs out

     SerpApi sells a monthly allowance and a catalogue run is the thing
     most likely to spend it. When it goes, every remaining row gets the
     same 429 and a run that was working stops working for a reason
     that has nothing to do with the catalogue.

     So discovery carries a second source. What is tested here is that
     it changes nothing except who answers the question: the fallback is
     reached ONLY on a quota refusal, it is never reached when no key is
     set, and a listing that arrives through it is put through exactly
     the same gates in exactly the same order. A candidate from Serper
     that is the wrong garment is refused as the wrong garment. A
     candidate from Serper whose page proves nothing is refused as
     unproven. Where it came from is not evidence about the garment.
     --------------------------------------------------------- */
  console.log('\n  — falling back when the allowance runs out\n');

  const QUOTA = 'SerpApi responded 429 (SerpApi search allowance exhausted): out of searches';

  /* the fallback is only in the chain when its key is set, so every
     test here says which world it is in rather than inheriting one */
  function withSerperKey(key, run) {
    const had = process.env.SERPER_API_KEY;
    if (key === null) delete process.env.SERPER_API_KEY;
    else process.env.SERPER_API_KEY = key;
    return Promise.resolve(run()).finally(() => {
      if (had === undefined) delete process.env.SERPER_API_KEY;
      else process.env.SERPER_API_KEY = had;
    });
  }

  test('what counts as running out of searches, and what does not', () => {
    for (const said of [
      QUOTA,
      'SerpApi responded 429: too many requests',
      'Serper responded 429 (Serper search allowance exhausted)',
      'Your account has run out of searches',
      'quota exceeded for this project',
      'rate limit reached'
    ]) {
      assert.strictEqual(extractor.outOfSearches(new Error(said)), true, `${said} is the allowance`);
    }

    /* everything else is a fault to report, not a reason to ask
       somebody else the same question */
    for (const said of [
      'SerpApi responded 500: boom',
      'The Google Product service is no longer offered by Google.',
      'fetch failed',
      'SERPAPI_API_KEY is not set'
    ]) {
      assert.strictEqual(extractor.outOfSearches(new Error(said)), false, `${said} is not the allowance`);
    }
  });

  await testAsync('with no SERPER_API_KEY there is no fallback to reach for', async () => {
    await withSerperKey(null, async () => {
      const chain = extractor.providerChain(productSource);
      assert.strictEqual(chain.length, 1, 'an unconfigured fallback is not in the chain');

      /* and a quota refusal is simply a failure, as it always was */
      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const result = await extractor.discoverRow(
        catalogueRow('sample-kinfield-pleated-midi-skirt'), new Map(), 4);
      assert.strictEqual(result.verdict, 'SOURCE FAILED');
      assert.match(result.why, /allowance exhausted/);
    });
  });

  await testAsync('the primary is asked first, and stays primary', async () => {
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const asked = [];
      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => {
          asked.push('primary');
          return [{ title: 'COS Pleated Twill Midi Skirt', productUrl: 'https://www.cos.com/p/123456', retailer: 'COS' }];
        }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const chain = extractor.providerChain(productSource);
      assert.strictEqual(chain[0].name, 'fake-source', 'the configured source leads');
      assert.strictEqual(chain[1].name, 'serper', 'and the fallback only follows');

      const offered = await extractor.listingsFor(catalogueRow('sample-kinfield-pleated-midi-skirt'), 8);
      assert.strictEqual(offered.provider, 'fake-source', 'a source that answers is never replaced');
      assert.strictEqual(offered.switched, null, 'and nothing was switched');
      assert.ok(asked.every((one) => one === 'primary'));
    });
  });

  await testAsync('a quota refusal moves the run to Serper, mid-row', async () => {
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      const asked = { primary: 0, serper: 0 };

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { asked.primary += 1; throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      serper.search = async () => {
        asked.serper += 1;
        return [{ title: 'COS Pleated Twill Midi Skirt', productUrl: 'https://www.cos.com/p/123456', retailer: 'COS' }];
      };
      try {
        const offered = await extractor.listingsFor(catalogueRow('sample-kinfield-pleated-midi-skirt'), 8);

        assert.strictEqual(asked.primary, 1, 'the primary was asked once and refused once');
        assert.ok(asked.serper >= 1, 'and the fallback answered');
        assert.strictEqual(offered.provider, 'serper');
        assert.strictEqual(offered.primary, 'fake-source', 'the primary is still named as the primary');
        assert.ok(offered.switched, 'the switch is recorded rather than silent');
        assert.strictEqual(offered.switched.from, 'fake-source');
        assert.strictEqual(offered.switched.to, 'serper');
        assert.match(offered.switched.why, /allowance exhausted/);
        assert.strictEqual(offered.products.length, 1);

        /* the run says where each query went, so a report can be read */
        assert.ok(offered.attempts.some((one) => one.fellBackTo === 'serper'));
        assert.ok(offered.attempts.some((one) => one.provider === 'serper' && one.offered === 1));
      } finally {
        serper.search = real;
      }
    });
  });

  await testAsync('a failure that is not a quota refusal never reaches for the fallback', async () => {
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      let serperAsked = 0;

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error('SerpApi responded 500: boom'); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      serper.search = async () => { serperAsked += 1; return []; };
      try {
        const result = await extractor.discoverRow(
          catalogueRow('sample-kinfield-pleated-midi-skirt'), new Map(), 4);
        assert.strictEqual(result.verdict, 'SOURCE FAILED');
        assert.strictEqual(serperAsked, 0, 'a 500 is a fault to report, not a source to replace');
      } finally {
        serper.search = real;
      }
    });
  });

  await testAsync('a Serper candidate faces every gate a SerpApi candidate faces', async () => {
    /* the property the whole fallback stands on. Serper offers three
       listings for a fleece sweatpant: a trouser, a jogger whose page
       says nothing about fleece, and a fleece jogger. The first two are
       refused exactly as they would be from the primary. */
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      const retailer = await describingRetailer({
        551100: { name: 'Street Trouser', material: 'Brushed fleece' },
        551200: { name: 'Earth Jogger', material: 'Organic cotton' },
        551300: { name: 'Club Jogger', material: 'Recycled polyester fleece' }
      });
      const port = retailer.address().port;

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      serper.search = async () => [
        { title: 'Aerie Street Trouser', productUrl: listing(port, '551100'), retailer: 'Aerie' },
        { title: 'Jumbie Art Earth Joggers', productUrl: listing(port, '551200'), retailer: 'Jumbie' },
        /* its title never says fleece — its page does, and the page
           stage has to be what settles it, from Serper as from anywhere */
        { title: 'Nike Club Joggers', productUrl: listing(port, '551300'), retailer: 'Nike' }
      ];
      try {
        const result = await extractor.discoverRow(
          catalogueRow('sample-kinfield-fleece-sweatpant'), new Map(), 8);

        /* the semantic gate, unchanged */
        assert.strictEqual(result.tried[0].semantic.kind, 'contradiction', 'a trouser is still a trouser');
        assert.match(result.tried[0].semantic.why, /sweatpant/);
        assert.ok(!retailer.hits.some((url) => url.includes('551100')),
          'and it still costs no request');

        /* the page-evidence gate, unchanged */
        assert.strictEqual(result.tried[1].semantic.kind, 'pending');
        assert.ok(result.tried[1].proof, 'its page was read');
        assert.deepStrictEqual(result.tried[1].proof.missing.map(extractor.nameOfPending), ['fleece']);

        /* and the one that earns it is written on the same evidence */
        assert.strictEqual(result.verdict, 'VERIFIED', result.why);
        assert.match(result.proposal.productUrl, /551300/);
        assert.strictEqual(result.tried[2].semantic.kind, 'pending', 'its title left fleece open');
        assert.strictEqual(result.provedOnPage.length, 1, 'and its page closed it');
        assert.strictEqual(extractor.nameOfPending(result.provedOnPage[0].item), 'fleece');
        assert.match(result.provedOnPage[0].where, /material/);

        /* the proposal still offers the same three fields and no others:
           where a candidate came from is not something a row records */
        assert.strictEqual(result.proposal.name, undefined);
        assert.strictEqual(result.proposal.brand, undefined);
        assert.ok(result.proposal.identity, 'and the image gate still had to prove it');
        assert.strictEqual(
          extractor.evidenceNote(result.proposal.identity),
          extractor.evidenceNote(result.proposal.identity),
          'the note is the gate’s, not the source’s'
        );
      } finally {
        serper.search = real;
        retailer.close();
      }
    });
  });

  await testAsync('a row written from a Serper listing keeps its own identity', async () => {
    /* the writer contract does not know which source found the listing,
       and must not start knowing */
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      const retailer = await describingRetailer({
        552200: { name: 'Club Fleece Jogger', material: 'Recycled polyester fleece' }
      });
      const port = retailer.address().port;

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      serper.search = async () => [
        { title: 'Nike Club Fleece Joggers', productUrl: listing(port, '552200'), retailer: 'Nike' }
      ];
      try {
        const before = extractor.readCatalog();
        const was = before.rows.find((r) => r.id === 'sample-kinfield-fleece-sweatpant');
        const found = await extractor.discoverRow(was, new Map(), 8);
        assert.strictEqual(found.verdict, 'VERIFIED', found.why);

        const now = evaluate(extractor.linkRow(before.source, was.id, found.proposal))
          .find((r) => r.id === was.id);

        assert.strictEqual(now.name, 'Fleece Sweatpant', 'the row was renamed');
        assert.strictEqual(now.brand, 'Kinfield', 'the row lost its brand');
        assert.strictEqual(now.price, was.price, 'the row lost its price');
        assert.strictEqual(now.category, was.category);
        assert.match(now.productUrl, /552200/);
        assert.ok(now.imageUrl);
      } finally {
        serper.search = real;
        retailer.close();
      }
    });
  });

  await testAsync('a run that gets only Google cards says so, instead of saying nothing', async () => {
    /* The report a live run produced — "[serper] — 40 offered" and then
       "offered no listing that is a product page" — named a symptom and
       hid the cause: whether the adapter read the wrong field, or the
       source sent no retailer URL at all. Those have opposite fixes.
       The tally and the adapter's own account of the search both
       already existed; this is them reaching the report. */
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      const card = (i) => ({
        title: `Boxy Cotton Tee ${i}`,
        source: 'Madewell',
        link: `https://www.google.com/search?ibp=oshop_%3A%3Apid%3D149545234219632133${i}`,
        price: '$34.50',
        imageUrl: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn',
        productId: `pid-${i}`,
        position: i
      });

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      const realOrganic = serper.searchOrganic;
      /* the escalation is stubbed to find nothing, so this test stays
         about the report: a row that ends with nothing has to say why */
      serper.searchOrganic = async () => [];
      /* mapped by the real adapter, and carrying the real diagnostics,
         so this is the live path rather than a hand-written stand-in */
      serper.search = async () => {
        const results = [card(1), card(2), card(3)];
        const records = results.map(serper.toRecord).filter(Boolean);
        records.diagnostics = {
          engine: 'serper-shopping',
          returnedByProvider: results.length,
          normalized: records.length,
          withInlineLink: 0,
          googleLinkedOnly: results.length,
          unlinked: 0,
          urlFieldsSeen: ['link']
        };
        return records;
      };
      try {
        const row = catalogueRow('sample-kinfield-fleece-sweatpant');
        const offered = await extractor.listingsFor(row, 8);

        assert.strictEqual(offered.provider, 'serper');
        assert.strictEqual(offered.products.length, 0, 'a Google card is not a product page');
        assert.ok(offered.rejected['no-product-url'], 'and the reason is counted, not lost');

        /* the adapter's own account of the search survives the trip */
        const asked = offered.attempts.filter((one) => one.provider === 'serper' && one.diagnostics);
        assert.ok(asked.length, 'the adapter\'s diagnostics reach the attempt');
        assert.strictEqual(asked[0].diagnostics.googleLinkedOnly, 3);
        assert.deepStrictEqual(asked[0].diagnostics.urlFieldsSeen, ['link']);

        /* and the row's own verdict names the fault rather than only
           reporting that nothing was found */
        const found = await extractor.discoverRow(row, new Map(), 8);
        assert.strictEqual(found.verdict, 'NO PRODUCT FOUND');
        assert.match(found.why, /no-product-url/, 'the report names why the listings were dropped');

        /* and the escalation is recorded rather than silent */
        assert.ok(offered.attempts.some((one) => one.escalated && one.escalated.endpoint === 'organic'),
          'the organic endpoint was asked once the batch came back linkless');
      } finally {
        serper.search = real;
        serper.searchOrganic = realOrganic;
      }
    });
  });

  await testAsync('an organic result enters the same pipeline, and clears the same gates', async () => {
    /* what the fallback is for: /shopping carries Google's cards and no
       retailer URL, /search carries the shop's own page. The page is
       then read, the photo proved and the row written by exactly the
       path a SerpApi listing takes. */
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      const retailer = await describingRetailer({
        552200: { name: 'Club Fleece Jogger', material: 'Recycled polyester fleece' }
      });
      const port = retailer.address().port;

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      const realOrganic = serper.searchOrganic;
      const asked = { shopping: 0, organic: 0 };

      /* Google's cards, mapped by the real adapter: no productUrl */
      serper.search = async () => {
        asked.shopping += 1;
        const records = [serper.toRecord({
          title: 'Nike Club Fleece Jogger',
          source: 'Nike',
          link: 'https://www.google.com/search?ibp=oshop_%3A%3Apid%3D14954523421963213331',
          price: '$62.97',
          imageUrl: 'https://encrypted-tbn0.gstatic.com/shopping?q=tbn'
        })].filter(Boolean);
        records.diagnostics = { engine: 'serper-shopping', withInlineLink: 0, googleLinkedOnly: 1, unlinked: 0, urlFieldsSeen: ['link'] };
        return records;
      };
      /* the organic answer, mapped by the real adapter: a title and a
         link, and nothing the endpoint did not supply */
      serper.searchOrganic = async () => {
        asked.organic += 1;
        const records = [serper.toOrganicRecord({
          title: 'Nike Club Fleece Joggers | Nike.com',
          link: listing(port, '552200')
        })].filter(Boolean);
        records.diagnostics = { engine: 'serper-search', withInlineLink: 1, googleLinkedOnly: 0, unlinked: 0, urlFieldsSeen: ['link'] };
        return records;
      };

      try {
        const before = extractor.readCatalog();
        const was = before.rows.find((r) => r.id === 'sample-kinfield-fleece-sweatpant');
        const found = await extractor.discoverRow(was, new Map(), 8);

        assert.strictEqual(found.verdict, 'VERIFIED', found.why);
        assert.strictEqual(asked.shopping, 1, 'the product surface is asked first, once');
        assert.ok(asked.organic >= 1, 'and the organic endpoint only after it came back linkless');

        /* the candidate went through the gates, not around them */
        const cleared = found.tried.find((one) => one.semantic && one.semantic.ok);
        assert.ok(cleared, 'the semantic gate judged it');
        assert.ok(found.proposal.imageUrl, 'and the photo came off the retailer page');
        assert.ok(found.proposal.identity, 'tied to this product by recorded evidence');
        assert.ok(retailer.hits.some((url) => url.includes('552200')), 'the page really was read');

        /* and only the three permitted fields are written */
        const now = evaluate(extractor.linkRow(before.source, was.id, found.proposal)).find((r) => r.id === was.id);
        assert.strictEqual(now.productUrl, found.proposal.productUrl);
        assert.ok(now.imageUrl);
        /* the row accounts for its photo: either the URL carries the
           listing's own code, or a note says how it was tied */
        assert.ok(/552200/.test(now.imageUrl) || now.imageEvidence,
          'the written row cannot account for its own photo');

        /* every other field, unchanged. Objects are compared through
           plain() because a row read out of the file and a row
           evaluated out of it do not share a prototype. */
        for (const field of Object.keys(was)) {
          if (field === 'productUrl' || field === 'imageUrl' || field === 'imageEvidence') continue;
          const mine = was[field] && typeof was[field] === 'object' ? plain(was[field]) : was[field];
          const theirs = now[field] && typeof now[field] === 'object' ? plain(now[field]) : now[field];
          assert.deepStrictEqual(theirs, mine, `${field} was changed and must not be`);
        }
        assert.strictEqual(now.name, 'Fleece Sweatpant', 'the row keeps its own name');
        assert.strictEqual(now.brand, 'Kinfield');
        assert.strictEqual(now.price, was.price, 'and its own price — nothing from Serper');
      } finally {
        serper.search = real;
        serper.searchOrganic = realOrganic;
        retailer.close();
      }
    });
  });

  await testAsync('the gates refuse an organic candidate exactly as they refuse any other', async () => {
    /* an organic link is a candidate, not a pass. The title stage and
       the page stage both still get their say, and a row that clears
       neither is written nothing at all. */
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      const retailer = await namedRetailer({ 881100: 'Street Trouser', 881200: 'Linen Camp Shirt' });
      const port = retailer.address().port;

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      const realOrganic = serper.searchOrganic;
      serper.search = async () => [];
      serper.searchOrganic = async () => [
        /* the wrong garment on its face: refused before a page is read */
        { title: 'Linen Camp Shirt', productUrl: listing(port, '881200') },
        /* and one whose title passes and whose PAGE gives it away */
        { title: 'Fleece Sweatpant', productUrl: listing(port, '881100') }
      ];

      try {
        const found = await extractor.discoverRow(
          catalogueRow('sample-kinfield-fleece-sweatpant'), new Map(), 4);

        assert.strictEqual(found.verdict, 'NO PRODUCT FOUND');
        assert.strictEqual(found.proposal, undefined, 'nothing is proposed, so nothing would be written');

        const onTitle = found.tried.find((one) => one.semantic && !one.semantic.ok);
        assert.ok(onTitle, 'the title stage refused the wrong garment');
        const onPage = found.tried.find((one) => one.semantic && one.semantic.ok && one.onPage && !one.onPage.ok);
        assert.ok(onPage, 'and the page stage refused the flattering title');
        assert.match(onPage.why, /its own page calls it "Street Trouser"/);
      } finally {
        serper.search = real;
        serper.searchOrganic = realOrganic;
        retailer.close();
      }
    });
  });

  await testAsync('the organic endpoint is asked once per row, not once per phrasing', async () => {
    /* the cost rule. A row is asked five ways; paying for the linkless
       product surface five times to learn the same thing five times is
       four wasted requests, so the rest of the row goes straight to the
       endpoint that carries a link. */
    await withSerperKey('test-key-000000000000000000000000', async () => {
      const serper = require('../api/_providers/serper');
      const asked = { shopping: 0, organic: 0 };

      productSource.registerProvider({
        name: 'fake-source', configured: () => true,
        search: async () => { throw new Error(QUOTA); }
      });
      process.env.PRODUCT_SOURCE = 'fake-source';

      const real = serper.search;
      const realOrganic = serper.searchOrganic;
      serper.search = async () => { asked.shopping += 1; return []; };
      serper.searchOrganic = async () => { asked.organic += 1; return []; };

      try {
        const offered = await extractor.listingsFor(catalogueRow('sample-kinfield-fleece-sweatpant'), 8);

        assert.strictEqual(asked.shopping, 1, 'the linkless surface is paid for once per row');
        assert.ok(asked.organic >= 2, 'and the other phrasings go straight to the organic endpoint');

        /* one request per query form, plus the one escalation that
           taught the row this surface carries no link */
        const serperForms = offered.attempts.filter((one) => one.provider === 'serper').length;
        assert.strictEqual(asked.shopping + asked.organic, serperForms + 1);
        assert.strictEqual(offered.attempts.filter((one) => one.escalated).length, serperForms,
          'every serper attempt says which endpoint answered it');
        assert.strictEqual(offered.products.length, 0, 'and nothing found is still nothing written');
      } finally {
        serper.search = real;
        serper.searchOrganic = realOrganic;
      }
    });
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

  /* ---------------------------------------------------------
     Ceilings, and a few at a time

     A run used to be able to take as long as the slowest shop on the
     internet felt like taking. Three things made that possible: a
     timeout that covered a response's HEADERS and then cleared itself
     before anyone read the BODY, an image check inside the browser with
     no ceiling over it at all, and every network operation waiting for
     the one in front of it.

     What is tested here is that each of those is now bounded, that a
     shop which never answers costs its ceiling and not the row, and —
     the part that could quietly go wrong — that reading a few
     candidates at once still answers with the one that was ranked
     first, not the one that came back first. Order is a gate. A fast
     shop further down the ranking must not overtake a better match
     above it.

     No retailer is contacted. The slow shops here are local servers
     that hold their sockets open on purpose.
     --------------------------------------------------------- */
  console.log('\n  — ceilings, and a few at a time\n');

  /* a server that accepts the connection and then says nothing, ever */
  function stallingHost() {
    const sockets = new Set();
    const server = http.createServer(() => { /* no answer is the point */ });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.shutdown = () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    };
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  /* a server that answers, starts its body, and then stops. This is the
     one the old ceiling could not see: the headers arrived inside the
     timeout, which cleared it, and the body then never came. */
  function dribblingHost() {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      const type = req.url.endsWith('.jpg') ? 'image/jpeg' : 'text/html';
      res.writeHead(200, { 'content-type': type });
      res.write(req.url.endsWith('.jpg') ? JPEG.slice(0, 10) : '<!doctype html><html><head>');
      /* and never ends the response */
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.shutdown = () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    };
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  /* an image host that takes its time and counts how many requests are
     in flight at once, so a claim about lanes can be measured rather
     than asserted. It serves plainly and refuses a Referer, so every
     candidate costs two requests and fails the hotlink gate. */
  function countingHost(delay) {
    let live = 0;
    let peak = 0;
    const asked = [];
    const server = http.createServer((req, res) => {
      live += 1;
      peak = Math.max(peak, live);
      asked.push(req.url.split('?')[0]);
      setTimeout(() => {
        live -= 1;
        if (req.headers.referer) { res.writeHead(403); return res.end(); }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(JPEG);
      }, delay);
    });
    server.stats = () => ({ peak, asked: asked.slice() });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  await testAsync('a host that never answers costs its ceiling and no more', async () => {
    const host = await stallingHost();
    const url = `http://127.0.0.1:${host.address().port}/p/171960005`;

    const started = Date.now();
    const got = await extractor.request(url, null, 400);
    const took = Date.now() - started;

    assert.strictEqual(got.ok, false);
    assert.strictEqual(got.why, 'timed out');
    assert.ok(took < 3000, `it waited ${took}ms on a 400ms ceiling`);

    host.shutdown();
  });

  await testAsync('a body that never arrives is a timeout, not a hang', async () => {
    /* the bug: fetch() resolving means the response LINE arrived. The
       old timer was cleared on the way out of request(), so the read
       that followed had nothing over it. */
    const host = await dribblingHost();
    const url = `http://127.0.0.1:${host.address().port}/p/171960005`;

    const started = Date.now();
    const page = await extractor.fetchPage(url, 400);
    const took = Date.now() - started;

    assert.ok(page.failed, `it read a page that was never finished: ${JSON.stringify(page).slice(0, 120)}`);
    assert.match(page.failed, /timed out/);
    assert.ok(took < 3000, `it waited ${took}ms on a 400ms ceiling`);

    host.shutdown();
  });

  await testAsync('an image that never finishes downloading is refused on time', async () => {
    const host = await dribblingHost();
    const url = `http://127.0.0.1:${host.address().port}/img/171960005-hero.jpg`;

    const started = Date.now();
    const check = await extractor.verifyImage(url, null, 400);
    const took = Date.now() - started;

    assert.strictEqual(check.ok, false);
    assert.match(check.why, /timed out/);
    assert.ok(took < 3000, `it waited ${took}ms on a 400ms ceiling`);

    host.shutdown();
  });

  await testAsync('a source that does not answer is given up on, and is not mistaken for a quota refusal', async () => {
    const forever = new Promise(() => {});
    const started = Date.now();
    let failed = null;
    try {
      await extractor.withCeiling(forever, 300, 'the fake source did not answer within 0s');
    } catch (err) {
      failed = err;
    }
    const took = Date.now() - started;

    assert.ok(failed, 'it waited for a promise that never settles');
    assert.ok(took < 3000, `it waited ${took}ms on a 300ms ceiling`);

    /* the fallback ladder reads a quota refusal and moves to the next
       source. A ceiling is not that, and a run that treated it as one
       would burn its fallback on a shop that was merely slow. */
    assert.strictEqual(extractor.outOfSearches(failed), false,
      'a source that timed out was read as a source that had run out of searches');
  });

  await testAsync('a spent budget refuses the work rather than starting it', async () => {
    const spent = extractor.budgetOf(0);
    assert.strictEqual(spent.spent(), true);
    assert.strictEqual(spent.cap(10000), 0);

    /* the most expensive thing here is a Chromium, and a row with no
       time left must not launch one */
    const rendered = await extractor.renderPage('http://127.0.0.1:1/p/1', spent);
    assert.ok(rendered.failed);
    assert.match(rendered.failed, /no time left|Playwright is not installed/);

    const budget = extractor.budgetOf(5000);
    assert.ok(budget.cap(10000) <= 5000, 'a ceiling outlasted the budget it sits under');
    assert.strictEqual(budget.cap(100), 100, 'a short ceiling was stretched to the budget');
  });

  await testAsync('the earliest candidate that clears wins, not the quickest', async () => {
    /* ranked first but slow, ranked second but fast. Serially the first
       one won because it was reached first; the danger in reading them
       at once is that "first to come back" quietly replaces "first". */
    const order = [];
    const { results, winner } = await extractor.raceInOrder([300, 10, 10], 3, async (delay, at) => {
      await new Promise((r) => setTimeout(r, delay));
      order.push(at);
      return { ok: true, at };
    });

    assert.strictEqual(winner, 0, `the winner was ${winner} — ranking lost to speed`);
    assert.strictEqual(results[0].at, 0);
    assert.deepStrictEqual(order.slice(0, 2), [1, 2], 'the later ones did not actually finish first');
  });

  await testAsync('nothing beyond the winner is read, and nothing runs more than the lanes allow', async () => {
    let live = 0;
    let peak = 0;
    const started = [];

    const { winner } = await extractor.raceInOrder([0, 1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      started.push(item);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 30));
      live -= 1;
      /* the first one clears, so everything ranked below it is moot */
      return { ok: item === 0 };
    });

    assert.strictEqual(winner, 0);
    assert.ok(peak <= 3, `${peak} ran at once with three lanes`);
    assert.ok(started.length <= 3, `${started.length} candidates were read when the first one cleared`);
  });

  await testAsync('a candidate that throws is that candidate failing, not the run', async () => {
    const { results, winner } = await extractor.raceInOrder([0, 1, 2], 2, async (item) => {
      if (item === 0) throw new Error('this one is broken');
      return { ok: item === 1 };
    });

    assert.strictEqual(winner, 1, 'a thrown candidate took the others with it');
    assert.ok(results[0].threw, 'the throw was not recorded against the candidate that threw');
    assert.strictEqual(results[0].ok, false);
  });

  await testAsync('reading photos in lanes still answers with the highest-priority one', async () => {
    /* two candidates that both verify, the better-ranked one served
       slowly. The gates are unchanged; what must not change with them
       is which answer comes back. */
    const slow = await countingHost(250);
    const fast = await countingHost(0);
    const port = slow.address().port;
    const row = { id: 'x', productUrl: `http://127.0.0.1:${port}/p/171960005` };

    /* served plainly and refused to a Referer above, so neither would
       pass; these two are served by a host that allows both */
    const both = http.createServer((req, res) => {
      const delay = req.url.includes('ranked-first') ? 250 : 0;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(JPEG);
      }, delay);
    });
    await new Promise((r) => both.listen(0, '127.0.0.1', r));
    const at = both.address().port;

    const candidates = [
      { url: `http://127.0.0.1:${at}/img/171960005-ranked-first.jpg`, from: 'json-ld' },
      { url: `http://127.0.0.1:${at}/img/171960005-ranked-second.jpg`, from: 'og:image' }
    ];

    const found = await extractor.firstVerifiable(candidates, { id: 'x', productUrl: `http://127.0.0.1:${at}/p/171960005` });
    assert.ok(found.url, `nothing verified: ${JSON.stringify(found.refusals)}`);
    assert.match(found.url, /ranked-first/, 'the quicker, lower-ranked photo was taken');

    both.close();
    slow.close();
    fast.close();
  });

  await testAsync('the free gates still run first, and never spend a request', async () => {
    const host = await countingHost(0);
    const port = host.address().port;
    const row = { id: 'x', productUrl: `http://127.0.0.1:${port}/p/171960005` };

    const candidates = [
      /* refused by the host gate: an aggregator */
      { url: 'https://encrypted-tbn0.gstatic.com/img/171960005.jpg', from: 'json-ld' },
      /* refused by the identity gate: nothing ties it to this listing */
      { url: `http://127.0.0.1:${port}/img/something-else.jpg`, from: 'og:image' },
      /* reaches the network, and is refused for the Referer */
      { url: `http://127.0.0.1:${port}/img/171960005-hero.jpg`, from: 'preload' }
    ];

    const found = await extractor.firstVerifiable(candidates, row);
    assert.ok(!found.url, 'something cleared that should not have');

    const { asked } = host.stats();
    assert.ok(!asked.some((u) => u.includes('something-else')),
      'a request was spent on a candidate the identity gate had already refused');

    /* and every refusal comes back in the order the candidates were
       offered in, whatever order they came back in */
    assert.deepStrictEqual(found.refusals.map((r) => r.gate), ['host', 'identity', 'loadable']);
    assert.match(found.refusals[0].why, /aggregator or stock host/);
    assert.match(found.refusals[1].why, /nothing ties it to this product/);
    assert.match(found.refusals[2].why, /hotlink blocked/);

    host.close();
  });

  await testAsync('photos are checked no more than the lanes allow', async () => {
    const host = await countingHost(120);
    const port = host.address().port;
    const row = { id: 'x', productUrl: `http://127.0.0.1:${port}/p/171960005` };

    /* six candidates that all tie to the listing and all fail the
       hotlink gate, so every one of them is read to the end */
    const candidates = [1, 2, 3, 4, 5, 6].map((n) => ({
      url: `http://127.0.0.1:${port}/img/171960005-${n}.jpg`,
      from: 'gallery image'
    }));

    const found = await extractor.firstVerifiable(candidates, row);
    assert.ok(!found.url, 'a hotlink-blocked photo was accepted');
    assert.strictEqual(found.refusals.length, 6, 'not every candidate was decided');

    const { peak } = host.stats();
    assert.ok(peak > 1, `nothing ran in parallel at all (peak ${peak})`);
    assert.ok(peak <= extractor.LANES, `${peak} requests were in flight with ${extractor.LANES} lanes`);

    host.close();
  });

  await testAsync('a shop that never answers costs its own ceiling, not the row', async () => {
    const stalled = await stallingHost();
    const working = await simpleRetailer();
    const port = working.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        /* ranked first, and it will never answer */
        { title: 'Boxy Cotton Tee', productUrl: `http://127.0.0.1:${stalled.address().port}/p/553311`, retailer: 'Nowhere' },
        record(port, '553311')
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const started = Date.now();
    const result = await extractor.discoverRow(
      { id: 'sample-northfold-boxy-cotton-tee', name: 'Boxy Cotton Tee', category: 'tee' },
      new Map(),
      4,
      { budget: extractor.budgetOf(6000) }
    );
    const took = Date.now() - started;

    /* The dead shop is ranked FIRST, and the run still waits it out —
       deliberately. Ranking is a gate: a listing the source put above
       another does not lose its place for being slow, or the answer
       would depend on which shop's CDN was quicker that afternoon.

       What changed is what that wait costs. The working shop is read
       during it rather than after it, so the row comes back with a
       verified listing at roughly the dead shop's ceiling instead of
       the ceiling plus everything queued behind it — and the ceiling
       itself is now the row's budget, not "whenever the socket gives
       up". */
    assert.strictEqual(result.verdict, 'VERIFIED', result.why);
    assert.match(result.proposal.productUrl, new RegExp(`:${port}/`), 'it took the listing that never answered');
    assert.ok(took < 12000, `the row took ${took}ms against a 6s budget — the wait is not bounded`);

    /* and the dead one is on the record, refused for the reason it was
       actually refused for */
    assert.ok(result.tried.length >= 2, 'the dead candidate was never recorded');
    const dead = result.tried.find((one) => one.url.includes(String(stalled.address().port)));
    assert.ok(dead, 'the dead candidate is missing from the record');
    /* whichever ceiling it reached first — the page read, or the
       browser it had no time left to open — it is refused by a clock
       rather than left hanging on a socket */
    assert.match(String(dead.why), /timed out|unreachable|ran out|no time left/,
      `the dead shop was recorded as: ${dead.why}`);

    stalled.shutdown();
    working.close();
  });

  await testAsync('a row with no time left refuses its listings instead of reading them', async () => {
    const working = await simpleRetailer();
    const port = working.address().port;

    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [record(port, '553311')]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    /* enough to get the listings back, and nothing left for the pages */
    const budget = extractor.budgetOf(30);
    await new Promise((r) => setTimeout(r, 60));

    const result = await extractor.discoverRow(
      { id: 'sample-northfold-boxy-cotton-tee', name: 'Boxy Cotton Tee', category: 'tee' },
      new Map(),
      4,
      { budget }
    );

    assert.notStrictEqual(result.verdict, 'VERIFIED', 'a row out of time wrote something anyway');
    const whys = (result.tried || []).map((one) => one.why).join(' | ');
    const ranOut = (result.tried || []).some((one) => one.ranOut) || /ran out/.test(whys) ||
      /no listing|offered no listing/.test(result.why || '');
    assert.ok(ranOut, `it did not report running out of time: ${result.why} — ${whys}`);

    working.close();
  });

  /* ---------------------------------------------------------
     The hand-off: what a run proved, and a write that costs nothing

     Discovery is the expensive half — a live search per row, a page per
     candidate, a browser for the pages that refuse a bare client. It
     used to be paid for twice, because --discover and --discover --write
     were the same command run twice, and the second run re-derived from
     nothing what the first had already proved.

     So a run writes down what cleared every gate, and the write reads it
     back. What is tested here is that the saving records only verified
     rows, that the write contacts nobody, that it still moves only the
     three fields discovery is allowed to fill, and — the part that
     matters most — that the file is believed about nothing. Every gate
     that can be decided without a retailer is decided again on the way
     in, so a report edited by hand fails exactly as a catalogue row
     edited by hand fails.
     --------------------------------------------------------- */
  console.log('\n  — the discovery report, and a write that searches nothing\n');

  /* the catalogue is written to for real by these tests, because what is
     under test is the command rather than a string it might have
     produced. It goes back byte for byte afterwards, whatever happens. */
  async function withCatalogRestored(fn) {
    const before = fs.readFileSync(CATALOG);
    try {
      return await fn(before);
    } finally {
      fs.writeFileSync(CATALOG, before);
    }
  }

  const reportWith = (entries, extra) => Object.assign({
    version: extractor.REPORT_VERSION,
    createdAt: new Date().toISOString(),
    catalog: 'assets/catalog.js',
    options: {},
    appliedAt: null,
    applied: [],
    entries
  }, extra || {});

  /* a row's fields as the report records them, so an entry can be built
     against the catalogue as it actually is */
  const snapshot = (id) => {
    const row = catalogueRow(id);
    return { name: row.name, brand: row.brand, category: row.category };
  };

  /* rows come back from a vm context wearing that realm's prototypes,
     which deepStrictEqual refuses however identical the contents */
  const same = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  /* Every row a report below is applied to. Applying a report writes
     only into an empty row and refuses one that already carries a
     photo, so these tests start from a fixture catalogue in which each
     of them is empty — whatever discovery has since filled in for real. */
  const REPORT_ROWS = [
    'sample-halden-tailored-wool-coat',
    'sample-halden-merino-crew-knit',
    'sample-terrace-linen-camp-shirt',
    'sample-coveworks-wide-leg-trouser',
    'sample-northfold-boxy-cotton-tee',
    'sample-solstice-ribbed-knit-skirt',
    'sample-kinfield-poplin-shirt'
  ];

  /* filled by the first test and used by the rest: one genuinely
     discovered row, proved against a fixture retailer through every
     gate, which is the only kind of thing that may be written */
  let verified = null;

  await testAsync('a run writes down what cleared every gate, and nothing else', async () => {
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

    const { rows } = extractor.readCatalog();
    const was = rows.find((r) => r.id === 'sample-halden-tailored-wool-coat');
    const found = await extractor.discoverRow(was, new Map(), 4);
    assert.strictEqual(found.verdict, 'VERIFIED', found.why);

    /* a row that found nothing is in the run's printed output and
       nowhere else: the report is what may be written, not a list of
       everything that was looked at */
    const report = extractor.reportFrom(
      [found, { id: 'sample-halden-merino-crew-knit', verdict: 'NO PRODUCT FOUND', why: 'nothing cleared' }],
      rows,
      { limit: 4 }
    );

    assert.strictEqual(report.entries.length, 1, 'a row that cleared nothing was written down anyway');
    const entry = report.entries[0];
    assert.strictEqual(entry.id, 'sample-halden-tailored-wool-coat');
    assert.strictEqual(entry.verified, true);

    /* the three fields, exactly as the run produced them */
    assert.strictEqual(entry.productUrl, found.proposal.productUrl);
    assert.strictEqual(entry.imageUrl, found.proposal.imageUrl);
    assert.strictEqual(entry.imageEvidence, "{ via: 'json-ld-sku', sku: '664422' }",
      'the note recorded is the one that will be written into the file');

    /* and what it takes to re-decide the gates without a retailer */
    assert.strictEqual(entry.listingName, 'Tailored Merino Wool Coat');
    assert.deepStrictEqual(entry.row, { name: 'Tailored Wool Coat', brand: 'Halden', category: 'coat' },
      'the row as it was when this listing was held against it');
    assert.strictEqual(entry.appliedAt, undefined);
    assert.strictEqual(report.appliedAt, null, 'nothing is applied by being written down');

    /* and it survives the round trip to disk unchanged */
    const file = path.join(TMP, 'saved.json');
    extractor.saveReport(file, report);
    const loaded = extractor.loadReport(file);
    assert.ok(loaded.report, loaded.why);
    assert.deepStrictEqual(loaded.report.entries, report.entries);

    verified = entry;
    retailer.close();
  });

  await testAsync('--write applies the saved report without searching, fetching or rendering', async () => {
    assert.ok(verified, 'the test above produced no verified entry to apply');
    await withFixtureCatalogue(REPORT_ROWS, async () => {
      const file = path.join(TMP, 'apply.json');
      extractor.saveReport(file, reportWith([verified]));

      /* the fixture retailer that proved this row was closed at the end
         of the test above, so its port answers nothing. A write that
         reached for the page would fail on it, and a write that went
         searching would say no source is configured — the subprocess
         has no provider registered. Neither happens, and the row lands. */
      const result = await run(['--discover', '--write', '--report', file]);
      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.stdout, /Applying 1 verified row/);
      assert.match(result.stdout, /without contacting a retailer/);
      assert.doesNotMatch(result.stdout, /Looking for a real listing/, 'it went searching all over again');
      assert.doesNotMatch(result.stdout, /no product source is configured/, 'it tried to search');

      const now = evaluate(fs.readFileSync(CATALOG, 'utf8')).find((r) => r.id === verified.id);
      assert.strictEqual(now.productUrl, verified.productUrl);
      assert.strictEqual(now.imageUrl, verified.imageUrl);
      assert.deepStrictEqual(plain(now.imageEvidence), { via: 'json-ld-sku', sku: '664422' });
      assert.strictEqual(extractor.catalogRowIdentity(now).ok, true,
        'a row written from the report still accounts for itself');

      /* and the report is spent, so repeating the command cannot write
         the same rows twice or be mistaken for "go and search again" */
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(after.appliedAt, 'the report does not record that it was applied');
      assert.deepStrictEqual(after.applied, [verified.id]);

      const again = await run(['--discover', '--write', '--report', file]);
      assert.strictEqual(again.code, 0, again.stderr);
      assert.match(again.stdout, /was already written into assets\/catalog\.js/);
      assert.doesNotMatch(again.stdout, /Looking for a real listing/, 'a spent report sent it searching');
    });
  });

  await testAsync('applying a report moves the three permitted fields and no others', async () => {
    assert.ok(verified, 'the test above produced no verified entry to apply');
    await withFixtureCatalogue(REPORT_ROWS, async (before) => {
      const file = path.join(TMP, 'fields.json');
      extractor.saveReport(file, reportWith([verified]));

      const result = await run(['--discover', '--write', '--report', file]);
      assert.strictEqual(result.code, 0, result.stderr);

      const wasRows = evaluate(before.toString());
      const nowRows = evaluate(fs.readFileSync(CATALOG, 'utf8'));
      assert.strictEqual(nowRows.length, wasRows.length, 'the write added or dropped a row');

      /* every field of every row, compared by name rather than by the
         three this happens to know about: a field added to the schema
         later is covered by this without anyone remembering to add it */
      for (let at = 0; at < wasRows.length; at += 1) {
        const wasRow = wasRows[at];
        const nowRow = nowRows[at];
        assert.strictEqual(nowRow.id, wasRow.id, 'the row order moved');
        const allowed = nowRow.id === verified.id ? ['productUrl', 'imageUrl', 'imageEvidence'] : [];
        for (const field of new Set([...Object.keys(wasRow), ...Object.keys(nowRow)])) {
          if (allowed.includes(field)) continue;
          assert.deepStrictEqual(same(nowRow[field]), same(wasRow[field]), `${nowRow.id}.${field} moved`);
        }
      }

      const now = nowRows.find((r) => r.id === verified.id);
      assert.strictEqual(now.name, 'Tailored Wool Coat', 'the row was renamed after the shop');
      assert.strictEqual(now.brand, 'Halden');
      assert.strictEqual(now.price, 298);
      assert.strictEqual(now.productUrl, verified.productUrl);
      assert.strictEqual(now.imageUrl, verified.imageUrl);
    });
  });

  await testAsync('an entry that cannot answer for itself is refused rather than written', async () => {
    assert.ok(verified, 'the test above produced no verified entry to apply');
    await withFixtureCatalogue(REPORT_ROWS, async (before) => {
      /* Six ways a report can say something it cannot prove. Every one
         of them is decidable without a retailer, which is exactly why
         they are decided again here rather than taken from the file. */
      const tampered = [
        {
          id: 'sample-halden-merino-crew-knit',
          verified: false,
          productUrl: 'https://shop.example.com/p/112233',
          imageUrl: 'https://cdn.example.com/img/112233-hero.jpg',
          imageEvidence: null,
          identity: { ok: true, via: 'image-url', code: '112233' },
          listingName: 'Merino Crew Knit',
          provedOnPage: [],
          row: snapshot('sample-halden-merino-crew-knit')
        },
        {
          /* a listing on an aggregator: the soundness gate, again */
          id: 'sample-terrace-linen-camp-shirt',
          verified: true,
          productUrl: 'https://www.google.com/shopping/product/223344',
          imageUrl: 'https://cdn.example.com/img/223344-hero.jpg',
          imageEvidence: null,
          identity: { ok: true, via: 'image-url', code: '223344' },
          listingName: 'Linen Camp Shirt',
          provedOnPage: [],
          row: snapshot('sample-terrace-linen-camp-shirt')
        },
        {
          /* a photo tied to nothing: the evidence gate, again */
          id: 'sample-coveworks-wide-leg-trouser',
          verified: true,
          productUrl: 'https://shop.example.com/p/334455',
          imageUrl: 'https://cdn.example.com/media/anonymous.jpg',
          imageEvidence: null,
          identity: null,
          listingName: 'Wide Leg Trouser',
          provedOnPage: [],
          row: snapshot('sample-coveworks-wide-leg-trouser')
        },
        {
          /* a note that is not what its finding produces: edited on one
             side and not the other, and no longer what was proved */
          id: 'sample-northfold-boxy-cotton-tee',
          verified: true,
          productUrl: 'https://shop.example.com/p/445566',
          imageUrl: 'https://cdn.example.com/media/anonymous.jpg',
          imageEvidence: "{ via: 'json-ld-sku', sku: '000000' }",
          identity: { ok: true, via: 'json-ld-sku', sku: '445566' },
          listingName: 'Boxy Cotton Tee',
          provedOnPage: [],
          row: snapshot('sample-northfold-boxy-cotton-tee')
        },
        {
          /* the wrong garment: the semantic gate's title stage, again */
          id: 'sample-solstice-ribbed-knit-skirt',
          verified: true,
          productUrl: 'https://shop.example.com/p/556677',
          imageUrl: 'https://cdn.example.com/img/556677-hero.jpg',
          imageEvidence: null,
          identity: { ok: true, via: 'image-url', code: '556677' },
          listingName: 'Chunky Knit Jumper',
          provedOnPage: [],
          row: snapshot('sample-solstice-ribbed-knit-skirt')
        },
        {
          /* a row that has been renamed since: this listing was never
             held against the row the catalogue now carries */
          id: 'sample-kinfield-poplin-shirt',
          verified: true,
          productUrl: 'https://shop.example.com/p/667788',
          imageUrl: 'https://cdn.example.com/img/667788-hero.jpg',
          imageEvidence: null,
          identity: { ok: true, via: 'image-url', code: '667788' },
          listingName: 'Poplin Shirt',
          provedOnPage: [],
          row: Object.assign(snapshot('sample-kinfield-poplin-shirt'), { name: 'Something Else Entirely' })
        }
      ];

      const file = path.join(TMP, 'tampered.json');
      extractor.saveReport(file, reportWith([...tampered, verified]));

      const result = await run(['--discover', '--write', '--report', file]);
      assert.strictEqual(result.code, 0, result.stderr);

      const rows = evaluate(fs.readFileSync(CATALOG, 'utf8'));
      for (const entry of tampered) {
        const row = rows.find((r) => r.id === entry.id);
        assert.strictEqual(row.imageUrl, null, `${entry.id} was written from an entry that proves nothing`);
        assert.strictEqual(row.productUrl, null, `${entry.id} was linked from an entry that proves nothing`);
        assert.match(result.stdout, new RegExp(`REFUSED\\s+${entry.id}`), `${entry.id} was not reported as refused`);
      }

      /* each refusal names the gate that made it, because a gate whose
         reasoning is invisible cannot be corrected */
      assert.match(result.stdout, /it is not marked as having cleared the gates/);
      assert.match(result.stdout, /is an aggregator or stock host/);
      assert.match(result.stdout, /nothing ties it to this product/);
      assert.match(result.stdout, /its recorded evidence is not what its identity finding produces/);
      assert.match(result.stdout, /is not the garment the row means/);
      assert.match(result.stdout, /has changed since the run/);

      /* and the one entry that can answer for itself is unaffected by
         the company it kept */
      const good = rows.find((r) => r.id === verified.id);
      assert.strictEqual(good.imageUrl, verified.imageUrl, 'a good entry was taken down by the bad ones');
      assert.strictEqual(extractor.catalogRowIdentity(good).ok, true);

      /* nothing else in the file moved */
      const wasRows = evaluate(before.toString());
      for (const wasRow of wasRows) {
        if (wasRow.id === verified.id) continue;
        const nowRow = rows.find((r) => r.id === wasRow.id);
        for (const field of Object.keys(wasRow)) {
          assert.deepStrictEqual(same(nowRow[field]), same(wasRow[field]), `${wasRow.id}.${field} moved`);
        }
      }
    });
  });

  await testAsync('--only applies one row of a report and leaves the rest of it applicable', async () => {
    assert.ok(verified, 'the test above produced no verified entry to apply');
    await withFixtureCatalogue(REPORT_ROWS, async () => {
      /* a second entry that answers every gate this side can ask: its
         photo carries its listing's code, and the shop calls it what
         the row means */
      const second = {
        id: 'sample-halden-merino-crew-knit',
        verified: true,
        productUrl: 'https://www.example-shop.com/p/merino-crew-knit/778899',
        imageUrl: 'https://cdn.example-shop.com/img/778899-hero.jpg',
        imageEvidence: null,
        identity: { ok: true, via: 'image-url', code: '778899' },
        listingName: 'Merino Crew Knit',
        provedOnPage: [],
        row: snapshot('sample-halden-merino-crew-knit')
      };

      const file = path.join(TMP, 'only.json');
      extractor.saveReport(file, reportWith([verified, second]));

      const one = await run(['--discover', '--write', '--only', second.id, '--report', file]);
      assert.strictEqual(one.code, 0, one.stderr);

      let rows = evaluate(fs.readFileSync(CATALOG, 'utf8'));
      assert.strictEqual(rows.find((r) => r.id === second.id).imageUrl, second.imageUrl);
      assert.strictEqual(rows.find((r) => r.id === verified.id).imageUrl, null,
        'a row nobody asked for was written');

      /* the report is NOT spent: the entry it never looked at would
         otherwise be stranded, and the only way back to that row would
         be the live search this whole thing exists to avoid */
      const between = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(between.appliedAt, null, 'one row closed the whole report');
      assert.deepStrictEqual(between.applied, [second.id]);

      const rest = await run(['--discover', '--write', '--report', file]);
      assert.strictEqual(rest.code, 0, rest.stderr);
      assert.doesNotMatch(rest.stdout, /Looking for a real listing/, 'the remainder cost a search');

      rows = evaluate(fs.readFileSync(CATALOG, 'utf8'));
      assert.strictEqual(rows.find((r) => r.id === verified.id).imageUrl, verified.imageUrl,
        'the entry left over was never applied');

      /* and the row written first is refused the second time rather
         than written twice */
      assert.match(rest.stdout, new RegExp(`REFUSED\\s+${second.id} — the row already carries a photo`));

      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(after.appliedAt, 'the report is spent once the whole of it has been considered');
      assert.deepStrictEqual(after.applied.sort(), [second.id, verified.id].sort());
    });
  });

  await testAsync('a stale, unreadable or unknown report is refused, and never quietly re-run', async () => {
    assert.ok(verified, 'the test above produced no verified entry to apply');
    const before = fs.readFileSync(CATALOG);

    const stale = path.join(TMP, 'stale.json');
    extractor.saveReport(stale, reportWith([verified], {
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    }));

    const ahead = path.join(TMP, 'ahead.json');
    extractor.saveReport(ahead, reportWith([verified], {
      createdAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    }));

    const broken = path.join(TMP, 'broken.json');
    fs.writeFileSync(broken, '{ this is not json');

    const older = path.join(TMP, 'older.json');
    extractor.saveReport(older, reportWith([verified], { version: extractor.REPORT_VERSION + 99 }));

    const undated = path.join(TMP, 'undated.json');
    extractor.saveReport(undated, reportWith([verified], { createdAt: 'whenever' }));

    for (const [file, says] of [
      [stale, /hours old, past the 24-hour limit/],
      [ahead, /dated \d+ hours in the future/],
      [broken, /is not readable JSON/],
      [older, /written by a different version of this script/],
      [undated, /does not say when it was made/]
    ]) {
      const result = await run(['--discover', '--write', '--report', file]);
      assert.notStrictEqual(result.code, 0, `${path.basename(file)} was accepted`);
      assert.match(result.stderr, says);
      assert.match(result.stderr, /Nothing was written\. Re-run --discover/);

      /* the expensive half is never started on the strength of a report
         that could not be read: a 35-minute search nobody asked for is
         its own kind of damage */
      assert.doesNotMatch(result.stdout, /Looking for a real listing/,
        `${path.basename(file)} sent it searching`);
      assert.ok(fs.readFileSync(CATALOG).equals(before), 'the catalogue is not byte-for-byte what it was');
    }
  });

  await testAsync('with no report saved at all, --discover still means go and find out', async () => {
    /* its own unlinked row, so "go and find out" has something to find
       out about — see the no-source test above */
    const original = fs.readFileSync(CATALOG);
    const fixture = NO_SOURCE_FIXTURE;
    await withFixtureRows([fixture], async (before) => {
      const result = await run([
        '--discover', '--write',
        '--only', fixture.id,
        '--report', path.join(TMP, 'nothing-was-ever-here.json')
      ], { env: withoutSources() });

      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.stdout, /No discovery report at/);
      assert.match(result.stdout, /Looking for a real listing for 1 row that carries no photo/,
        'with nothing saved it has to go and look');
      assert.match(result.stdout, new RegExp(fixture.id));
      assert.match(result.stdout, /no product source is configured/);
      assert.ok(fs.readFileSync(CATALOG).equals(before), 'and it wrote nothing, having verified nothing');
    });
    assert.ok(fs.readFileSync(CATALOG).equals(original), 'the fixture row was left in assets/catalog.js');
  });

  await testAsync('the plain path leaves a discovery report alone, and says it is there', async () => {
    const before = fs.readFileSync(CATALOG);
    const file = path.join(TMP, 'waiting.json');
    extractor.saveReport(file, reportWith([verified]));

    /* --write with no --discover is the other mode: it reads the pages
       rows already link to. Every linked row carries a photo already, so
       this reads nothing at all — and it must not help itself to a
       report that belongs to --discover --write. */
    const result = await run(['--write', '--report', file]);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /holds 1 verified row from a --discover run/);
    assert.match(result.stdout, /Run --discover --write to apply them/);

    assert.ok(fs.readFileSync(CATALOG).equals(before), 'the plain path applied a report that was not its to apply');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.appliedAt, null, 'and it marked the report spent without writing it');
  });

  await testAsync('--coverage reports without reading anything, and --help lists the modes', async () => {
    /* the shipped catalogue with the rows that can only be re-proved by
       reading their page cleared, so "without reading anything" is what
       is tested rather than whether a live retailer answered. Those rows
       are held to account on their own, below and by the tests of the
       shipped catalogue above. */
    await withFixtureCatalogue(EMBEDDED_ROWS, async () => {
      const report = await run(['--coverage']);
      assert.strictEqual(report.code, 0);
      assert.match(report.stdout, /of 27 rows carry a photo/);
      assert.match(report.stdout, /27 of 27 account for what they carry/);
      assert.doesNotMatch(report.stdout, /Reading \d+ linked product page/);
      assert.doesNotMatch(report.stdout, /Reading \d+ product pages? again/);
    });

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

  /* ---------------------------------------------------------
     A picture of the site is not a picture of the product

     A live run wrote three rows whose photos were not photographs of a
     garment at all: White House Black Market's whbm_logo_seo.avif (9KB),
     ASOS's social-share-1x.jpg and Telfar's social_telfar.jpg. Each was
     the page's og:image, each was accepted `via: 'canonical'`, and the
     canonical rule was working as written — it refuses a DISAGREEMENT it
     can see, and a logo disagrees with nothing. What it never asked was
     whether the image is a product photo at all.
     --------------------------------------------------------- */
  console.log('\n  — a picture of the site is not a picture of the product\n');

  const WHBM = 'https://www.whitehouseblackmarket.com/store/product/wide-leg-trouser/570412345';
  const ASOS = 'https://www.asos.com/us/asos-design/asos-design-wide-leg-trouser/prd/205123456';
  const TELFAR = 'https://www.telfar.net/products/wide-leg-trouser-black?variant=41234567890';

  /* a JPEG whose header says how big it is, padded to a photo's weight */
  const jpegOf = (width, height) => {
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08,
      (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0'), Buffer.alloc(9, 0)]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(40000, 0x20)]);
  };
  /* a fetcher that serves whatever it is asked for as this body, and
     remembers what it was asked */
  const serving = (body, type) => {
    const asked = [];
    const fetcher = async (url) => {
      asked.push(url);
      return {
        ok: true,
        response: {
          status: 200,
          headers: { get: () => type || 'image/jpeg' },
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          body: null
        }
      };
    };
    fetcher.asked = asked;
    return fetcher;
  };

  test('a retailer logo is refused even though the canonical page vouches for it', () => {
    const logo = 'https://www.whitehouseblackmarket.com/Assets/whbm/images/whbm_logo_seo.avif';
    const verdict = extractor.identityEvidence({ url: logo, from: 'og:image', canonical: WHBM }, WHBM);
    assert.strictEqual(verdict.ok, false, 'a wordmark was accepted as a wide leg trouser');
    assert.match(verdict.why, /not a product photo/);
    assert.match(verdict.why, /logo/);

    assert.match(extractor.siteAsset(logo, WHBM), /logo/);
    assert.match(extractor.siteAsset('https://cdn.example.com/brand/logos/wordmark-black.png', WHBM) || '', /wordmark|logos/);
  });

  test('a social-share card is refused even though the canonical page vouches for it', () => {
    for (const [url, listing] of [
      ['https://images.asos-media.com/navigation/social-share-1x.jpg', ASOS],
      ['https://www.telfar.net/cdn/shop/files/social_telfar.jpg?v=1699', TELFAR],
      ['https://cdn.example.com/static/og-image-default.png', WHBM],
      ['https://cdn.example.com/static/twitterCard.jpg', WHBM]
    ]) {
      const verdict = extractor.identityEvidence({ url, from: 'og:image', canonical: listing }, listing);
      assert.strictEqual(verdict.ok, false, `${url} was accepted as a product photo`);
      assert.match(verdict.why, /not a product photo/, url);
    }
  });

  test('a favicon, a touch icon, a placeholder or a bare brand image is refused', () => {
    for (const url of [
      'https://www.telfar.net/favicon.ico',
      'https://www.telfar.net/cdn/shop/files/favicon-32x32.png',
      'https://www.telfar.net/apple-touch-icon.png',
      'https://www.telfar.net/cdn/shop/files/telfar.png',
      'https://www.telfar.net/assets/brand-mark.svg',
      'https://cdn.example.com/img/placeholder-product.jpg',
      'https://cdn.example.com/img/no-image-available.jpg',
      'https://cdn.example.com/logos/12ab34cd.png'
    ]) {
      assert.ok(extractor.siteAsset(url, TELFAR), `${url} passed as a product photo`);
    }
    /* never a product photo, whatever vouches for it: a placeholder
       carrying the listing's own code is still a placeholder */
    assert.ok(extractor.siteAsset('https://cdn.example.com/img/570412345_placeholder.jpg', WHBM));
  });

  await testAsync('a site asset is refused before it is ever requested', async () => {
    const fetcher = serving(jpegOf(1200, 1500));
    const result = await extractor.firstVerifiable([
      { url: 'https://www.whitehouseblackmarket.com/Assets/whbm/images/whbm_logo_seo.avif', from: 'og:image', canonical: WHBM },
      { url: 'https://www.whitehouseblackmarket.com/favicon.ico', from: 'loaded by the page', canonical: WHBM }
    ], { id: 'x', productUrl: WHBM }, fetcher);
    assert.ok(!result.url, `a logo verified: ${result.url}`);
    assert.deepStrictEqual(result.refusals.map((one) => one.gate), ['asset', 'asset']);
    assert.strictEqual(fetcher.asked.length, 0, 'a lane was spent loading a logo');
  });

  await testAsync('a real product hero still passes, past the logo in front of it', async () => {
    const hero = 'https://www.whitehouseblackmarket.com/Product_Images/570412345_001_main.jpg';
    const fetcher = serving(jpegOf(1200, 1500));
    const result = await extractor.firstVerifiable([
      { url: 'https://www.whitehouseblackmarket.com/Assets/whbm/images/whbm_logo_seo.avif', from: 'og:image', canonical: WHBM },
      { url: hero, from: 'preload', canonical: WHBM }
    ], { id: 'x', productUrl: WHBM }, fetcher);
    assert.strictEqual(result.url, hero, JSON.stringify(result.refusals));
    assert.strictEqual(result.identity.via, 'image-url');
    assert.deepStrictEqual([...new Set(fetcher.asked)], [hero], 'only the hero was loaded');

    /* a garment with a logo on it is a garment: the word is not banned,
       a filename that says nothing else is */
    assert.strictEqual(extractor.siteAsset('https://cdn.example.com/p/logo-tee-white.jpg', WHBM), null);
    assert.strictEqual(extractor.siteAsset('https://image.uniqlo.com/og-429066.jpg', UNIQLO), null,
      'a share card named for the product is that product’s card');
  });

  await testAsync('a valid canonical product image still passes', async () => {
    /* an opaque CDN filename on the listing's own canonical page is
       exactly what the canonical rule exists for, and nothing here
       touches it */
    const opaque = 'https://cdn.lyst.com/photos/8f2a91c4e7b3.jpg';
    const verdict = extractor.identityEvidence({ url: opaque, from: 'og:image', canonical: LYST }, LYST);
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.strictEqual(verdict.via, 'canonical');

    const named = 'https://www.telfar.net/cdn/shop/files/wide-leg-trouser-black-front.jpg';
    const byName = extractor.identityEvidence({ url: named, from: 'og:image', canonical: TELFAR }, TELFAR);
    assert.strictEqual(byName.ok, true, byName.why);
    assert.strictEqual(byName.via, 'canonical');

    const result = await extractor.firstVerifiable([
      { url: 'https://www.telfar.net/cdn/shop/files/social_telfar.jpg', from: 'og:image', canonical: TELFAR },
      { url: named, from: 'og:image:secure_url', canonical: TELFAR }
    ], { id: 'x', productUrl: TELFAR }, serving(jpegOf(1000, 1250)));
    assert.strictEqual(result.url, named, JSON.stringify(result.refusals));
    assert.strictEqual(result.identity.via, 'canonical');
  });

  await testAsync('a picture the shape of a logo is refused by its own header', async () => {
    /* the byte floor stops a tracking pixel, not a 9KB wordmark; the
       wordmark's shape gives it away wherever its name does not */
    const opaque = 'https://www.telfar.net/cdn/shop/files/8f2a91c4e7b3.jpg';
    const candidate = [{ url: opaque, from: 'og:image', canonical: TELFAR }];
    const strip = await extractor.firstVerifiable(candidate, { id: 'x', productUrl: TELFAR }, serving(jpegOf(600, 90)));
    assert.ok(!strip.url);
    assert.match(strip.refusals[0].why, /600x90/);
    const badge = await extractor.firstVerifiable(candidate, { id: 'x', productUrl: TELFAR }, serving(jpegOf(96, 96)));
    assert.ok(!badge.url);
    assert.match(badge.refusals[0].why, /icon or a badge/);
    const svg = await extractor.firstVerifiable(candidate, { id: 'x', productUrl: TELFAR }, serving(jpegOf(1000, 1000), 'image/svg+xml'));
    assert.ok(!svg.url);

    const photo = await extractor.firstVerifiable(candidate, { id: 'x', productUrl: TELFAR }, serving(jpegOf(1200, 630)));
    assert.strictEqual(photo.url, opaque, 'a landscape product photo was refused for its shape');

    /* and every format a shop serves says its size */
    assert.deepStrictEqual(extractor.imageDimensions(jpegOf(640, 800)), { width: 640, height: 800 });
    assert.deepStrictEqual(extractor.imageDimensions(PNG), { width: 2, height: 2 });
    assert.strictEqual(extractor.imageDimensions(Buffer.alloc(8000, 0x20)), null, 'an unreadable header refuses nothing');
  });

  test('the shipped catalogue carries no site asset', () => {
    for (const row of extractor.readCatalog().rows) {
      if (!row.imageUrl || !row.productUrl) continue;
      assert.strictEqual(extractor.siteAsset(row.imageUrl, row.productUrl), null, `${row.id}: ${row.imageUrl}`);
    }
  });

  test('a recorded canonical row wearing a logo is caught by --coverage', () => {
    const checked = extractor.catalogRowIdentity({
      id: 'x',
      productUrl: WHBM,
      imageUrl: 'https://www.whitehouseblackmarket.com/Assets/whbm/images/whbm_logo_seo.avif',
      imageEvidence: { via: 'canonical', canonical: WHBM }
    });
    assert.strictEqual(checked.ok, false);
    assert.match(checked.why, /logo/);
  });

  /* ---------------------------------------------------------
     A product page before a page about products

     The organic fallback answers with whatever mentions the words: a
     category page, a round-up, a Reddit thread, a Pinterest board. They
     are semantically related and not one of them is a listing, and they
     were read in the search engine's order ahead of the product page.
     --------------------------------------------------------- */
  console.log('\n  — a product page before a page about products\n');

  test('each kind of result is told apart', () => {
    const shape = (url, title) => extractor.listingShape(url, title).kind;
    assert.strictEqual(shape(TELFAR, 'Wide Leg Trouser'), 'product');
    assert.strictEqual(shape('https://www.telfar.net/collections/bottoms/products/wide-leg-trouser', 'Wide Leg Trouser'), 'product');
    assert.strictEqual(shape(ASOS, 'ASOS DESIGN wide leg trouser'), 'product');
    assert.strictEqual(shape('https://www.example.com/womens/sale/wide-leg-trouser-570412345.html', 'Wide Leg Trouser'), 'product');
    assert.strictEqual(shape('https://www.example.com/collections/trousers', 'Wide Leg Trousers'), 'listing');
    assert.strictEqual(shape('https://www.example.com/c/12345', 'Trousers'), 'listing');
    assert.strictEqual(shape('https://www.example.com/womens/pants?q=wide+leg', 'Wide Leg Pants'), 'listing');
    assert.strictEqual(shape('https://www.example.com/womens-trousers', 'Shop Women’s Trousers (148)'), 'listing');
    assert.strictEqual(shape('https://www.example.com/blog/how-to-style-wide-leg-trousers', 'How to Style Wide Leg Trousers'), 'editorial');
    assert.strictEqual(shape('https://www.whowhatwear.com/wide-leg-trousers', 'Wide Leg Trousers'), 'editorial');
    assert.strictEqual(shape('https://www.example.com/wide-leg-trousers', 'The 12 Best Wide Leg Trousers of 2026'), 'editorial');
    for (const url of [
      'https://www.reddit.com/r/femalefashionadvice/comments/abc/wide_leg_trousers/',
      'https://www.pinterest.com/pin/123456789/',
      'https://www.youtube.com/watch?v=abc',
      'https://www.instagram.com/p/xyz/'
    ]) assert.strictEqual(shape(url, 'Wide Leg Trousers'), 'not-a-shop', url);
  });

  test('product pages are ranked first, and a site that sells nothing is set aside', () => {
    const { ranked, dropped } = extractor.rankListings([
      { productUrl: 'https://www.reddit.com/r/x/comments/1/wide_leg/', title: 'Wide leg trousers?' },
      { productUrl: 'https://www.example.com/blog/wide-leg-edit', title: 'Our wide leg edit' },
      { productUrl: 'https://www.example.com/collections/trousers', title: 'Trousers' },
      { productUrl: 'https://shop.one.com/about-the-trouser', title: 'The Trouser' },
      { productUrl: 'https://shop.two.com/products/wide-leg-trouser', title: 'Wide Leg Trouser' },
      { productUrl: 'https://www.pinterest.com/pin/1/', title: 'Wide leg' },
      { productUrl: 'https://shop.three.com/p/778899', title: 'Wide Leg Trouser' }
    ]);
    assert.deepStrictEqual(ranked.map((one) => one.productUrl), [
      'https://shop.two.com/products/wide-leg-trouser',
      'https://shop.three.com/p/778899',
      'https://shop.one.com/about-the-trouser',
      'https://www.example.com/collections/trousers',
      'https://www.example.com/blog/wide-leg-edit'
    ]);
    assert.strictEqual(dropped.length, 2);
  });

  await testAsync('discovery reads a product page before the category page the source ranked above it', async () => {
    const retailer = await describingRetailer({
      320001: { name: 'Pleated Midi Skirt', description: 'A pleated midi skirt.' }
    });
    const port = retailer.address().port;
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [
        { title: 'Pleated Midi Skirts — Reddit', productUrl: 'https://www.reddit.com/r/x/comments/1/pleated_midi_skirt/' },
        { title: 'Pleated Midi Skirt', productUrl: `http://127.0.0.1:${port}/collections/skirts` },
        { title: 'Pleated Midi Skirt', productUrl: listing(port, '320001') }
      ]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';

    const offered = await extractor.listingsFor(catalogueRow('sample-kinfield-pleated-midi-skirt'), 8);
    assert.deepStrictEqual(offered.products.map((one) => one.shape.kind), ['product', 'listing']);
    assert.ok(offered.rejected['not-a-shop'], 'the forum thread is counted, not hidden');

    const found = await extractor.discoverRow(catalogueRow('sample-kinfield-pleated-midi-skirt'), new Map(), 8);
    assert.strictEqual(found.verdict, 'VERIFIED', found.why);
    assert.strictEqual(found.proposal.productUrl, listing(port, '320001'));
    assert.strictEqual(found.tried[0].shape, 'product');
    retailer.close();
  });

  /* ---------------------------------------------------------
     A Shopify store's own product record

     A live diagnosis of Telfar's cropped-track-jacket-white-2025: 98
     image candidates, 89 refused on identity, the store's own
     TELFAR-CROPPED-... photographs among them. The listing URL is a
     slug, and the only "code" in it was the year. The store publishes
     the record behind the page at /products/<handle>.js, and that
     record names the product and lists its images. These are the rules
     that record is held to.
     --------------------------------------------------------- */
  console.log('\n  — a Shopify store’s own product record\n');

  const HANDLE = 'cropped-track-jacket-white-2025';
  const JACKET_ROW = { id: 'fixture-cropped-track-jacket', name: 'Cropped Track Jacket', brand: 'Atlas Supply', category: 'jacket' };
  const PHOTO = jpegOf(1000, 1250);

  /* a store whose page, record and images the test decides. `record`
     is the JSON the record answers with, or a status to answer instead;
     `page` a status for the listing page itself. It counts what it was
     asked for, so a test can say what was NOT requested. */
  function shopifyStore({ record, page }) {
    const asked = [];
    const server = http.createServer((req, res) => {
      asked.push(req.url);
      const port = server.address().port;
      const here = `http://127.0.0.1:${port}`;
      if (req.url === `/products/${HANDLE}`) {
        if (page) { res.writeHead(page, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Access denied</title>'); }
        res.writeHead(200, { 'content-type': 'text/html' });
        /* what the live page offered: a canonical that is this listing,
           a social-share card as og:image, the real photographs only in
           the drawn gallery, and no JSON-LD Product at all */
        return res.end(`<!doctype html><html><head>
<link rel="canonical" href="${here}/products/${HANDLE}">
<meta property="og:image" content="${here}/cdn/shop/files/telfar-social-share.jpg">
</head><body><img src="/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1" width="800" height="1000" alt="Cropped Track Jacket"></body></html>`);
      }
      if (req.url === `/products/${HANDLE}.js`) {
        if (typeof record === 'number') { res.writeHead(record, { 'content-type': 'text/html' }); return res.end('no'); }
        if (typeof record === 'string') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(record); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(typeof record === 'function' ? record(port) : record));
      }
      if (req.url.startsWith('/cdn/shop/files/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(PHOTO);
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, port: server.address().port })));
  }

  /* the record Shopify publishes, in its own shape: protocol-relative
     image URLs, a featured image, media and per-variant images */
  const jacketRecord = (overrides) => (port) => Object.assign({
    id: 8123456789012,
    handle: HANDLE,
    title: 'Cropped Track Jacket - White',
    vendor: 'Telfar',
    images: [
      `//127.0.0.1:${port}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1`,
      `//127.0.0.1:${port}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-2.jpg?v=1`
    ],
    featured_image: `//127.0.0.1:${port}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1`,
    media: [{ media_type: 'video', src: `//127.0.0.1:${port}/cdn/shop/files/clip.mp4` }],
    variants: [{ id: 45000000000001, sku: 'TJ-CRP-WHT-S', featured_image: null }]
  }, overrides || {});

  const listingOf = (port) => `http://127.0.0.1:${port}/products/${HANDLE}`;
  const asListing = (port) => ({ id: JACKET_ROW.id, brand: '—', name: 'Cropped Track Jacket', productUrl: listingOf(port) });

  test('a year is not a product code, and a Shopify handle is read off its listing', () => {
    assert.deepStrictEqual(extractor.identifiersFrom(`https://telfar.net/products/${HANDLE}`), [],
      'the year was taken for the product');
    /* a real code keeps its place beside a year */
    const both = extractor.identifiersFrom('https://shop.example.com/p/wide-leg-2024-570412345');
    assert.ok(both.includes('570412345'));
    assert.ok(!both.includes('2024'));

    assert.deepStrictEqual(extractor.shopifyHandle(`https://telfar.net/products/${HANDLE}?variant=1`),
      { handle: HANDLE, origin: 'https://telfar.net', recordUrl: `https://telfar.net/products/${HANDLE}.js` });
    assert.strictEqual(extractor.shopifyHandle(`https://telfar.net/en-us/collections/new/products/${HANDLE}`).handle, HANDLE);
    assert.strictEqual(extractor.shopifyHandle('https://www.jcrew.com/p/womens/wide-leg-pant/BX123'), null);
    assert.strictEqual(extractor.shopifyHandle(`https://telfar.net/products/${HANDLE}.js`), null,
      'the record itself is not a listing');
  });

  test('the canonical rule alone still vouches for nothing a code-less listing publishes', () => {
    /* the page is canonical for itself; that proves the page, not a
       photo in its gallery, and the record path does not change it */
    const url = `https://telfar.net/products/${HANDLE}`;
    const gallery = extractor.identityEvidence(
      { url: 'https://telfar.net/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg', from: 'gallery image', canonical: url }, url);
    assert.strictEqual(gallery.ok, false);
    assert.match(gallery.why, /carries no product code/);
  });

  await testAsync('a Shopify listing with no product code is tied to its photo by the store’s own record', async () => {
    const store = await shopifyStore({ record: jacketRecord() });
    try {
      const result = await extractor.resolveRow(asListing(store.port), undefined, { catalogRow: JACKET_ROW });
      assert.strictEqual(result.verdict, 'VERIFIED', result.why);
      assert.strictEqual(result.url, `http://127.0.0.1:${store.port}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1`);
      assert.strictEqual(result.from, 'product-record');
      assert.strictEqual(result.identity.via, 'product-record');
      assert.strictEqual(result.identity.handle, HANDLE);
      assert.strictEqual(result.identity.productId, '8123456789012');
      assert.strictEqual(result.identity.title, 'Cropped Track Jacket - White');

      /* the page's own og:image, a share card, was refused first */
      assert.ok(result.diagnosis.refusals.some((one) => /telfar-social-share/.test(one.url) && one.gate === 'asset'),
        'the social card was never put to the asset gate');
      /* the record was asked for once, on the listing's own origin */
      assert.strictEqual(store.asked.filter((u) => u === `/products/${HANDLE}.js`).length, 1);

      assert.strictEqual(extractor.evidenceNote(result.identity),
        `{ via: 'product-record', handle: '${HANDLE}', productId: '8123456789012', title: 'Cropped Track Jacket - White' }`);
    } finally {
      store.server.close();
    }
  });

  await testAsync('a record for a different product, or a different garment, offers nothing', async () => {
    for (const [record, says] of [
      [jacketRecord({ handle: 'cropped-track-jacket-black-2024' }), /is for cropped-track-jacket-black-2024, not this listing's/],
      [jacketRecord({ title: 'Medium Shopping Bag - White' }), /is not the garment the row means/],
      [jacketRecord({ title: 'Track Jacket - White' }), /is not the garment the row means/],
      [jacketRecord({ id: 'abc' }), /names no product id/]
    ]) {
      const store = await shopifyStore({ record });
      try {
        const got = await extractor.productRecordFor(listingOf(store.port), JACKET_ROW);
        assert.ok(!got.candidates, `a record that ${says} offered images`);
        assert.match(got.failed, says);
      } finally {
        store.server.close();
      }
    }

    /* and a record read for one listing does not speak for another */
    const stranger = extractor.productRecordEvidence({
      url: 'https://telfar.net/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg',
      from: 'product-record',
      record: { handle: 'shopping-bag-medium', id: '1', title: 'Shopping Bag', images: ['https://telfar.net/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg'] }
    }, `https://telfar.net/products/${HANDLE}`);
    assert.strictEqual(stranger.ok, false);
    assert.match(stranger.why, /is for shopping-bag-medium, not this listing's/);

    /* nor for an image it does not list */
    const unlisted = extractor.productRecordEvidence({
      url: 'https://telfar.net/cdn/shop/files/SOMETHING-ELSE.jpg',
      from: 'product-record',
      record: { handle: HANDLE, id: '1', title: 'Cropped Track Jacket', images: ['https://telfar.net/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg'] }
    }, `https://telfar.net/products/${HANDLE}`);
    assert.strictEqual(unlisted.ok, false);
    assert.match(unlisted.why, /does not list this image/);
  });

  await testAsync('a social or share image in the record is still refused as site artwork', async () => {
    const store = await shopifyStore({
      record: jacketRecord({ images: [`/cdn/shop/files/telfar-social-share.jpg`], featured_image: null, media: [] })
    });
    try {
      const got = await extractor.productRecordFor(listingOf(store.port), JACKET_ROW);
      assert.strictEqual(got.candidates.length, 1);
      const found = await extractor.firstVerifiable(got.candidates, { id: 'x', productUrl: listingOf(store.port) });
      assert.ok(!found.url, 'a share card was accepted because the record listed it');
      assert.strictEqual(found.refusals[0].gate, 'asset');
      assert.match(found.refusals[0].why, /names a site (social|share) image/);
    } finally {
      store.server.close();
    }
  });

  await testAsync('an image the record lists on an unrelated host is refused', async () => {
    const store = await shopifyStore({
      record: jacketRecord({
        images: ['https://images.example.org/cdn/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg'],
        featured_image: null,
        media: []
      })
    });
    try {
      const got = await extractor.productRecordFor(listingOf(store.port), JACKET_ROW);
      const found = await extractor.firstVerifiable(got.candidates, { id: 'x', productUrl: listingOf(store.port) });
      assert.ok(!found.url);
      assert.strictEqual(found.refusals[0].gate, 'identity');
      assert.match(found.refusals[0].why, /images\.example\.org is not the store's own host or Shopify's CDN/);
    } finally {
      store.server.close();
    }

    /* Shopify's own CDN is the store's, for this purpose */
    const listed = 'https://cdn.shopify.com/s/files/1/0000/0001/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg';
    const cdn = extractor.productRecordEvidence(
      { url: listed, from: 'product-record', record: { handle: HANDLE, id: '8123456789012', title: 'Cropped Track Jacket - White', images: [listed] } },
      `https://telfar.net/products/${HANDLE}`);
    assert.strictEqual(cdn.ok, true, cdn.why);
  });

  await testAsync('a missing or refused record, or a refused page, gives no false positive', async () => {
    for (const record of [404, 403, 418, 'not json at all']) {
      const store = await shopifyStore({ record });
      try {
        const got = await extractor.productRecordFor(listingOf(store.port), JACKET_ROW);
        assert.ok(!got.candidates, `a record answering ${record} offered images`);
        assert.match(got.failed, typeof record === 'number' ? new RegExp(`answered ${record}`) : /not readable JSON/);
        /* asked once, and never asked again another way */
        assert.strictEqual(store.asked.filter((u) => u.startsWith(`/products/${HANDLE}.js`)).length, 1);
      } finally {
        store.server.close();
      }
    }

    /* end to end: a refused record leaves the page's own candidates to
       decide it, and they cannot — the real photographs sit only in the
       gallery, which the canonical rule does not vouch for */
    const refused = await shopifyStore({ record: 418 });
    try {
      const result = await extractor.resolveRow(asListing(refused.port), undefined, { catalogRow: JACKET_ROW });
      assert.notStrictEqual(result.verdict, 'VERIFIED', `verified with the record refused: ${result.why}`);
      assert.strictEqual(refused.asked.filter((u) => u === `/products/${HANDLE}.js`).length, 1);
    } finally {
      refused.server.close();
    }

    /* a store that refuses the PAGE to a plain request is not asked for
       its record by one */
    const walled = await shopifyStore({ record: jacketRecord(), page: 403 });
    try {
      const result = await extractor.resolveRow(asListing(walled.port), undefined, { catalogRow: JACKET_ROW });
      assert.notStrictEqual(result.verdict, 'VERIFIED');
      assert.strictEqual(walled.asked.filter((u) => u.startsWith(`/products/${HANDLE}.js`)).length, 0,
        'the record was used to get round a refused page');
    } finally {
      walled.server.close();
    }

    /* and with no catalogue row to hold its title against, it is not asked for */
    const rowless = await shopifyStore({ record: jacketRecord() });
    try {
      const got = await extractor.productRecordFor(listingOf(rowless.port), null);
      assert.ok(!got.candidates);
      assert.strictEqual(rowless.asked.length, 0);
    } finally {
      rowless.server.close();
    }
  });

  test('product-record evidence is re-proved from the row’s own URL, never trusted', () => {
    const shipped = {
      id: 'fixture-cropped-track-jacket',
      name: 'Cropped Track Jacket',
      brand: 'Atlas Supply',
      category: 'jacket',
      productUrl: `https://telfar.net/products/${HANDLE}`,
      imageUrl: 'https://telfar.net/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1',
      imageEvidence: { via: 'product-record', handle: HANDLE, productId: '8123456789012', title: 'Cropped Track Jacket - White' }
    };
    assert.strictEqual(extractor.catalogRowIdentity(shipped).ok, true, extractor.catalogRowIdentity(shipped).why);

    const refusedFor = (change) => {
      const verdict = extractor.catalogRowIdentity(Object.assign({}, shipped, change));
      assert.strictEqual(verdict.ok, false, `accepted: ${JSON.stringify(change)}`);
      return verdict.why;
    };
    assert.match(refusedFor({ imageEvidence: Object.assign({}, shipped.imageEvidence, { handle: 'shopping-bag-medium' }) }),
      /is not this row's listing/);
    assert.match(refusedFor({ productUrl: 'https://telfar.net/products/shopping-bag-medium' }), /is not this row's listing/);
    assert.match(refusedFor({ productUrl: 'https://www.jcrew.com/p/womens/jacket/BX123' }), /not a Shopify/);
    assert.match(refusedFor({ imageUrl: 'https://images.example.org/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg' }),
      /not the store's own host or Shopify's CDN/);
    assert.match(refusedFor({ imageUrl: 'https://telfar.net/cdn/shop/files/telfar-social-share.jpg' }), /site (social|share) image/);
    assert.match(refusedFor({ name: 'Wide Leg Trouser', category: 'trousers' }), /is not the garment the row means/);
    assert.match(refusedFor({ imageEvidence: Object.assign({}, shipped.imageEvidence, { productId: '' }) }), /names no product id/);
    assert.match(refusedFor({ imageEvidence: Object.assign({}, shipped.imageEvidence, { title: '' }) }), /names no title/);

    /* the note the file carries reads back as the evidence it records */
    const note = extractor.evidenceNote(Object.assign({ ok: true }, shipped.imageEvidence));
    const readBack = vm.runInNewContext(`(${note})`);
    assert.strictEqual(extractor.catalogRowIdentity(Object.assign({}, shipped, { imageEvidence: readBack })).ok, true);
  });

  await testAsync('--coverage and a replayed report both re-prove a product-record row', async () => {
    const productUrl = `https://telfar.net/products/${HANDLE}`;
    const imageUrl = 'https://telfar.net/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1';
    const identity = { ok: true, via: 'product-record', handle: HANDLE, productId: '8123456789012', title: 'Cropped Track Jacket - White' };
    const fixture = {
      id: 'fixture-cropped-track-jacket',
      name: 'Cropped Track Jacket',
      brand: 'Atlas Supply',
      price: null,
      productUrl: null,
      imageUrl: null,
      category: 'jacket',
      style: ['Streetwear'],
      occasion: ['Weekend'],
      fit: ['Regular'],
      colors: ['White'],
      sizes: ['S', 'M', 'L']
    };

    /* replay: an entry carrying this evidence answers every gate again */
    const entry = {
      id: fixture.id,
      verified: true,
      productUrl,
      imageUrl,
      imageEvidence: extractor.evidenceNote(identity),
      identity,
      listingName: 'Cropped Track Jacket - White',
      provedOnPage: [],
      row: { name: fixture.name, brand: fixture.brand, category: fixture.category }
    };
    const replayed = extractor.replayable(entry, [fixture], new Map());
    assert.strictEqual(replayed.ok, true, replayed.why);
    const tampered = extractor.replayable(Object.assign({}, entry, {
      identity: Object.assign({}, identity, { handle: 'shopping-bag-medium' }),
      imageEvidence: extractor.evidenceNote(Object.assign({}, identity, { handle: 'shopping-bag-medium' }))
    }), [fixture], new Map());
    assert.strictEqual(tampered.ok, false, 'a report naming another product’s record was replayed');
    assert.match(tampered.why, /is not this row's listing/);

    /* --coverage: the row written the way discovery writes it, then the
       whole catalogue read back by the command itself */
    await withFixtureRows([fixture], async () => {
      const linked = extractor.linkRow(fs.readFileSync(CATALOG, 'utf8'), fixture.id, { productUrl, imageUrl, identity });
      fs.writeFileSync(CATALOG, linked);
      const written = extractor.readCatalog().rows.find((r) => r.id === fixture.id);
      assert.strictEqual(written.imageEvidence.via, 'product-record');
      assert.strictEqual(extractor.catalogRowIdentity(written).ok, true);

      const report = await run(['--coverage']);
      assert.strictEqual(report.code, 0, report.stderr);
      const total = extractor.readCatalog().rows.length;
      assert.match(report.stdout, new RegExp(`${total} of ${total} account for what they carry`));

      /* and the same row with its note pointed at another product is
         called out, not waved through on the strength of the note */
      fs.writeFileSync(CATALOG, fs.readFileSync(CATALOG, 'utf8').replace(`handle: '${HANDLE}'`, "handle: 'shopping-bag-medium'"));
      const caught = await run(['--coverage']);
      assert.doesNotMatch(caught.stdout, new RegExp(`${total} of ${total} account for what they carry`));
      assert.match(caught.stdout, new RegExp(fixture.id));
    }, { unlink: EMBEDDED_ROWS });
  });

  /* ---------------------------------------------------------
     The same record, embedded in a React Router page

     Telfar's listing is a headless React Router app: /products/<handle>.js
     answers 404, and the product lives in the loader data the page
     hydrates from — window.__reactRouterContext.state.loaderData
     ["routes/_app.($locale).products.$handle"].product, with id (a
     Product GID), handle, title and media.nodes[*].image.url. Some nodes
     carry only previewImage.url, and one captured live was a bag.
     --------------------------------------------------------- */
  console.log('\n  — a React Router store’s embedded product\n');

  const ROUTE = 'routes/_app.($locale).products.$handle';
  const GID = 'gid://shopify/Product/7689314336867';
  const PLANTED_TOKEN = 'fixture-storefront-token-must-never-print';

  /* the route's own product, as the live page carries it */
  const routerProduct = (here, overrides) => Object.assign({
    __typename: 'Product',
    id: GID,
    handle: HANDLE,
    title: 'Cropped Track Jacket - White',
    media: {
      nodes: [
        { __typename: 'MediaImage', mediaContentType: 'IMAGE', image: { url: `${here}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1` } },
        { __typename: 'MediaImage', mediaContentType: 'IMAGE', image: { url: `${here}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-BACK.jpg?v=1` } },
        /* a video whose poster is another product entirely */
        { __typename: 'Video', mediaContentType: 'VIDEO', previewImage: { url: `${here}/cdn/shop/files/Track_Medium_Bag_Black.jpg` } }
      ]
    },
    /* a duplicate reference under a variant, which is not the route's product */
    selectedOrFirstAvailableVariant: { id: 'gid://shopify/ProductVariant/42986310926435', product: { handle: HANDLE, title: 'Cropped Track Jacket - White' } }
  }, overrides || {});

  /* a store whose page hydrates from `loader(here)`. Its .js record is
     404, as Telfar's is. Its og:image is a share card and its drawn
     gallery carries no code, so nothing the page itself publishes can
     be tied to the product. */
  function routerStore(loader, options) {
    const asked = [];
    const server = http.createServer((req, res) => {
      asked.push(req.url);
      const here = `http://127.0.0.1:${server.address().port}`;
      if (req.url === `/products/${HANDLE}`) {
        const state = { state: { loaderData: Object.assign({ root: { env: { PUBLIC_STOREFRONT_API_TOKEN: PLANTED_TOKEN } } }, loader(here)) } };
        const canonical = (options && options.canonical) || `${here}/products/${HANDLE}`;
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html><head>
<link rel="canonical" href="${canonical}">
<meta property="og:image" content="${here}/cdn/shop/files/telfar-social-share.jpg">
</head><body>
<img src="/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1" width="800" height="1000" alt="">
<script>window.__reactRouterContext = ${JSON.stringify(state)};</script>
</body></html>`);
      }
      if (req.url.startsWith('/cdn/shop/files/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(PHOTO);
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, port: server.address().port })));
  }
  const withProduct = (overrides) => (here) => ({ [ROUTE]: { product: routerProduct(here, overrides) } });

  /* what reactRouterProducts hands back from a page, for the rules that
     are decided without one */
  const probeOf = (here, products, extra) => Object.assign({
    pathHandle: HANDLE,
    canonical: `${here}/products/${HANDLE}`,
    products: products.map((product) => ({
      where: `__reactRouterContext.state.loaderData["${ROUTE}"].product`,
      id: product.id,
      handle: product.handle,
      title: product.title,
      media: ((product.media && product.media.nodes) || []).map((node) => ({
        typename: node.__typename || null,
        contentType: node.mediaContentType || null,
        image: node.image ? node.image.url : null,
        previewOnly: Boolean(!node.image && node.previewImage)
      }))
    }))
  }, extra || {});
  const TELFAR_URL = `https://telfar.net/products/${HANDLE}`;
  const TELFAR_HERE = 'https://telfar.net';

  test('only the route’s own product, by exact handle, GID and full title, offers anything', () => {
    const good = extractor.embeddedRecordFrom(probeOf(TELFAR_HERE, [routerProduct(TELFAR_HERE)]), TELFAR_URL, JACKET_ROW);
    assert.ok(good.record, good.failed);
    assert.strictEqual(good.record.source, 'embedded-react-router');
    assert.strictEqual(good.record.id, '7689314336867');
    assert.strictEqual(good.record.handle, HANDLE);
    /* media.nodes[*].image.url and nothing else: the video's poster is not taken */
    assert.deepStrictEqual(good.record.images, [
      `${TELFAR_HERE}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1`,
      `${TELFAR_HERE}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-BACK.jpg?v=1`
    ]);
    assert.strictEqual(good.record.previewOnly, 1);

    const refusedBy = (products, says, extra, row) => {
      const got = extractor.embeddedRecordFrom(probeOf(TELFAR_HERE, products, extra), TELFAR_URL, row || JACKET_ROW);
      assert.ok(!got.candidates, `offered images when it should say ${says}`);
      assert.match(got.failed, says);
    };
    refusedBy([routerProduct(TELFAR_HERE, { handle: 'cropped-track-jacket-black-2025' })], /no route-level product for this handle/);
    refusedBy([routerProduct(TELFAR_HERE, { title: 'Track Medium Bag - Black' })], /is not the garment the row means/);
    refusedBy([routerProduct(TELFAR_HERE, { title: 'Track Jacket - White' })], /is not the garment the row means/);
    refusedBy([routerProduct(TELFAR_HERE, { title: '' })], /names no title/);
    refusedBy([routerProduct(TELFAR_HERE, { id: 'gid://shopify/ProductVariant/42986310926435' })], /no valid Shopify Product GID/);
    refusedBy([routerProduct(TELFAR_HERE, { id: 'gid://shopify/Product/abc' })], /no valid Shopify Product GID/);
    refusedBy([routerProduct(TELFAR_HERE, { id: undefined })], /no valid Shopify Product GID/);
    refusedBy([routerProduct(TELFAR_HERE), routerProduct(TELFAR_HERE, { id: 'gid://shopify/Product/1' })], /different products under this handle/);
    refusedBy([routerProduct(TELFAR_HERE)], /the browser ended on shopping-bag-medium/, { pathHandle: 'shopping-bag-medium' });
    refusedBy([routerProduct(TELFAR_HERE)], /declares .* canonical, which is not this listing/, { canonical: `${TELFAR_HERE}/products/shopping-bag-medium` });
    refusedBy([routerProduct(TELFAR_HERE)], /router state could not be read/, { failed: 'boom' });

    /* with no catalogue row, or no probe, it is not read at all */
    assert.ok(extractor.embeddedRecordFrom(probeOf(TELFAR_HERE, [routerProduct(TELFAR_HERE)]), TELFAR_URL, null).skipped);
    assert.ok(extractor.embeddedRecordFrom(undefined, TELFAR_URL, JACKET_ROW).skipped);
  });

  await testAsync('an embedded record’s images still answer to every gate', async () => {
    const recordWith = (images) => ({
      source: 'embedded-react-router', handle: HANDLE, id: '7689314336867', gid: GID, title: 'Cropped Track Jacket - White', images
    });
    const decide = (url) => extractor.productRecordEvidence({ url, from: 'product-record', record: recordWith([url]) }, TELFAR_URL);

    const front = `${TELFAR_HERE}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1`;
    const passed = decide(front);
    assert.strictEqual(passed.ok, true, passed.why);
    assert.strictEqual(passed.source, 'embedded-react-router');
    assert.strictEqual(passed.productId, '7689314336867');
    assert.strictEqual(decide('https://cdn.shopify.com/s/files/1/0001/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg').ok, true);

    /* an image on an unrelated host */
    assert.match(decide('https://images.example.org/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg').why, /not the store's own host or Shopify's CDN/);
    /* a media node inside the product that is plainly another garment */
    assert.match(decide(`${TELFAR_HERE}/cdn/shop/files/Track_Medium_Bag_Black.jpg`).why, /names a different garment — jacket .* against bag/);
    /* an image the record does not list */
    const unlisted = extractor.productRecordEvidence({ url: front, from: 'product-record', record: recordWith([]) }, TELFAR_URL);
    assert.match(unlisted.why, /does not list this image/);

    /* the share card and the shop's artwork are refused before identity is asked */
    for (const [url, says] of [
      [`${TELFAR_HERE}/cdn/shop/files/telfar-social-share.jpg`, /names a site (social|share) image/],
      [`${TELFAR_HERE}/cdn/shop/files/telfar-logo.png`, /names a site logo image/]
    ]) {
      const found = await extractor.firstVerifiable([{ url, from: 'product-record', record: recordWith([url]) }], { id: 'x', productUrl: TELFAR_URL });
      assert.ok(!found.url, `${url} was accepted`);
      assert.strictEqual(found.refusals[0].gate, 'asset');
      assert.match(found.refusals[0].why, says);
    }

    /* and the path is closed to everything else: a gallery image of the
       very same file, on a listing with no code, is still refused */
    const gallery = extractor.identityEvidence({ url: front, from: 'gallery image', canonical: TELFAR_URL }, TELFAR_URL);
    assert.match(gallery.why, /carries no product code/);
  });

  test('embedded product-record evidence is structurally checked, and never counted on its note', () => {
    const evidence = { via: 'product-record', source: 'embedded-react-router', handle: HANDLE, productId: '7689314336867', title: 'Cropped Track Jacket - White' };
    assert.strictEqual(extractor.evidenceNote(Object.assign({ ok: true }, evidence)),
      `{ via: 'product-record', source: 'embedded-react-router', handle: '${HANDLE}', productId: '7689314336867', title: 'Cropped Track Jacket - White' }`);

    const row = {
      id: 'fixture-cropped-track-jacket', name: 'Cropped Track Jacket', brand: 'Atlas Supply', category: 'jacket',
      productUrl: TELFAR_URL,
      imageUrl: `${TELFAR_HERE}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1`,
      imageEvidence: evidence
    };
    const structural = extractor.catalogRowIdentity(row);
    assert.strictEqual(structural.ok, true, structural.why);
    assert.strictEqual(structural.needsLive, true, 'an embedded note was accounted for without its page');

    for (const [change, says] of [
      [{ imageEvidence: Object.assign({}, evidence, { handle: 'shopping-bag-medium' }) }, /is not this row's listing/],
      [{ imageEvidence: Object.assign({}, evidence, { productId: '' }) }, /names no product id/],
      [{ imageEvidence: Object.assign({}, evidence, { source: 'somewhere-else' }) }, /unknown source/],
      [{ imageUrl: 'https://images.example.org/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg' }, /not the store's own host or Shopify's CDN/],
      [{ name: 'Wide Leg Trouser', category: 'trousers' }, /is not the garment the row means/]
    ]) {
      const verdict = extractor.catalogRowIdentity(Object.assign({}, row, change));
      assert.strictEqual(verdict.ok, false, `accepted: ${JSON.stringify(change)}`);
      assert.match(verdict.why, says);
    }

    /* --coverage, without its page, does not count it */
    const report = extractor.coverage([row]);
    assert.strictEqual(report.accounted, 0);
    assert.deepStrictEqual(report.awaitingPage, [row.id]);
  });

  if (!extractor.loadPlaywright()) {
    console.log('  skip  the embedded React Router record in a real browser — Playwright is not installed here');
    skipped += 4;
  } else {
    await testAsync('a no-code Shopify listing verifies through its page’s React Router product', async () => {
      const store = await routerStore(withProduct());
      try {
        const result = await extractor.resolveRow(asListing(store.port), undefined, { catalogRow: JACKET_ROW });
        assert.strictEqual(result.verdict, 'VERIFIED', result.why);
        assert.strictEqual(result.from, 'product-record');
        assert.strictEqual(result.url, `http://127.0.0.1:${store.port}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1`);
        assert.strictEqual(result.identity.source, 'embedded-react-router');
        assert.strictEqual(result.identity.productId, '7689314336867');
        assert.strictEqual(result.identity.handle, HANDLE);
        assert.ok(result.notes.some((note) => /embedded React Router product cropped-track-jacket-white-2025 lists 2 media images/.test(note)), result.notes.join(' | '));

        /* the .js record was asked for once, answered 404, and nothing got round it */
        assert.strictEqual(store.asked.filter((u) => u === `/products/${HANDLE}.js`).length, 1);
        /* the page's own share card was refused as artwork on the way */
        assert.ok(result.diagnosis.refusals.some((one) => /telfar-social-share/.test(one.url) && one.gate === 'asset'));
        /* and none of the router state left the page */
        assert.ok(!JSON.stringify(result).includes(PLANTED_TOKEN), 'the loader data’s env reached the result');
      } finally {
        store.server.close();
      }
    });

    await testAsync('preview images, other products and nested duplicates offer nothing', async () => {
      const cases = [
        /* a product whose only media is a video poster */
        [withProduct({ media: { nodes: [{ __typename: 'Video', mediaContentType: 'VIDEO', previewImage: { url: '/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg' } }] } }),
          (result) => assert.strictEqual(result.diagnosis.embeddedRecord.previewOnly, 1)],
        /* the adjacent colour is the route's product; this handle only appears nested under it */
        [(here) => ({ [ROUTE]: { product: routerProduct(here, { handle: 'cropped-track-jacket-black-2025', title: 'Cropped Track Jacket - Black' }) },
          'routes/_app.($locale).products.$handle.recommendations': { products: [routerProduct(here)] } }),
          (result) => assert.match(result.diagnosis.embeddedRecord.failed, /no route-level product for this handle/)],
        /* the right handle, the wrong garment */
        [withProduct({ title: 'Track Medium Bag - Black' }),
          (result) => assert.match(result.diagnosis.embeddedRecord.failed, /is not the garment the row means/)]
      ];
      for (const [loader, check] of cases) {
        const store = await routerStore(loader);
        try {
          const result = await extractor.resolveRow(asListing(store.port), undefined, { catalogRow: JACKET_ROW });
          assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
          check(result);
        } finally {
          store.server.close();
        }
      }
    });

    await testAsync('the evidence is re-proved by reading the row’s own page again', async () => {
      const store = await routerStore(withProduct());
      try {
        const here = `http://127.0.0.1:${store.port}`;
        const row = {
          id: JACKET_ROW.id, name: JACKET_ROW.name, brand: JACKET_ROW.brand, category: JACKET_ROW.category,
          productUrl: `${here}/products/${HANDLE}`,
          imageUrl: `${here}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1`,
          imageEvidence: { via: 'product-record', source: 'embedded-react-router', handle: HANDLE, productId: '7689314336867', title: 'Cropped Track Jacket - White' }
        };
        const proved = await extractor.reproveEmbeddedRecord(row);
        assert.strictEqual(proved.ok, true, proved.why);

        const refusedFor = async (change, says) => {
          const verdict = await extractor.reproveEmbeddedRecord(Object.assign({}, row, change));
          assert.strictEqual(verdict.ok, false, `re-proved: ${JSON.stringify(change)}`);
          assert.match(verdict.why, says);
        };
        /* another product's id recorded against this page */
        await refusedFor({ imageEvidence: Object.assign({}, row.imageEvidence, { productId: '1111111111' }) }, /now carries product 7689314336867, not the recorded 1111111111/);
        /* a photo the product's media does not list */
        await refusedFor({ imageUrl: `${here}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-SIDE.jpg` }, /no longer lists this photo/);
        /* the video poster, which is not taken */
        await refusedFor({ imageUrl: `${here}/cdn/shop/files/Track_Medium_Bag_Black.jpg` }, /no longer lists this photo|different garment/);
        /* a row that now means something else */
        await refusedFor({ name: 'Wide Leg Trouser', category: 'trousers' }, /is not the garment the row means/);
      } finally {
        store.server.close();
      }
    });

    await testAsync('replay and --coverage re-prove an embedded record, and refuse a tampered one', async () => {
      const store = await routerStore(withProduct());
      const here = `http://127.0.0.1:${store.port}`;
      const productUrl = `${here}/products/${HANDLE}`;
      const imageUrl = `${here}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1`;
      const identity = { ok: true, via: 'product-record', source: 'embedded-react-router', handle: HANDLE, productId: '7689314336867', title: 'Cropped Track Jacket - White' };
      const fixture = {
        id: JACKET_ROW.id, name: JACKET_ROW.name, brand: JACKET_ROW.brand, price: null, productUrl: null, imageUrl: null,
        category: JACKET_ROW.category, style: ['Streetwear'], occasion: ['Weekend'], fit: ['Regular'], colors: ['White'], sizes: ['S', 'M', 'L']
      };
      const entryFor = (image) => ({
        id: fixture.id, verified: true, productUrl, imageUrl: image,
        imageEvidence: extractor.evidenceNote(identity), identity,
        listingName: 'Cropped Track Jacket - White', provedOnPage: [],
        row: { name: fixture.name, brand: fixture.brand, category: fixture.category }
      });
      try {
        await withFixtureRows([fixture], async () => {
          /* a tampered report: this product's evidence, another photo */
          const tampered = path.join(TMP, 'embedded-tampered.json');
          extractor.saveReport(tampered, reportWith([entryFor(`${here}/cdn/shop/files/SOMEONE-ELSES-JACKET.jpg`)]));
          const refused = await run(['--discover', '--write', '--report', tampered]);
          assert.strictEqual(refused.code, 0, refused.stderr);
          assert.match(refused.stdout, new RegExp(`REFUSED\\s+${fixture.id} — its page's product ${HANDLE} no longer lists this photo`));
          assert.strictEqual(extractor.readCatalog().rows.find((r) => r.id === fixture.id).imageUrl, null, 'a tampered entry was written');

          /* the real one: its page is read again, and it lands */
          const file = path.join(TMP, 'embedded.json');
          extractor.saveReport(file, reportWith([entryFor(imageUrl)]));
          const applied = await run(['--discover', '--write', '--report', file]);
          assert.strictEqual(applied.code, 0, applied.stderr);
          assert.match(applied.stdout, /has its page read again — the note alone is never believed/);
          assert.match(applied.stdout, new RegExp(`VERIFIED\\s+${fixture.id} — its page was read again`));
          const written = extractor.readCatalog().rows.find((r) => r.id === fixture.id);
          assert.strictEqual(written.imageUrl, imageUrl);
          assert.strictEqual(written.imageEvidence.source, 'embedded-react-router');

          /* --coverage reads that one page, and only that one */
          const total = extractor.readCatalog().rows.length;
          const report = await run(['--coverage']);
          assert.strictEqual(report.code, 0, report.stderr);
          assert.match(report.stdout, /Reading 1 product page again/);
          assert.match(report.stdout, new RegExp(`${total} of ${total} account for what they carry`));

          /* and a note pointed at another product is caught against the page */
          fs.writeFileSync(CATALOG, fs.readFileSync(CATALOG, 'utf8').replace("productId: '7689314336867'", "productId: '1111111111'"));
          const caught = await run(['--coverage']);
          assert.doesNotMatch(caught.stdout, new RegExp(`${total} of ${total} account for what they carry`));
          assert.match(caught.stdout, new RegExp(`${fixture.id} — its page now carries product 7689314336867, not the recorded 1111111111`));
        }, { unlink: EMBEDDED_ROWS });
      } finally {
        store.server.close();
      }
    });
  }

  /* ---------------------------------------------------------
     The .js record, asked for by the page that rendered

     A store can wall its page off from a plain request and serve it to a
     browser. Plain HTTP never gets the page, so it never asks for the
     record; the browser that did get the page asks for it, same-origin,
     and the record is judged exactly as a plain-HTTP one is.
     --------------------------------------------------------- */
  console.log('\n  — the .js record, asked for by the page that rendered\n');

  test('the browser asks only when it ended up on this very listing', () => {
    const listing = `https://shop.example.com/products/${HANDLE}`;
    assert.ok(extractor.browserRecordListing(listing, listing, null).listing);
    assert.ok(extractor.browserRecordListing(`${listing}?variant=1`, listing, listing).listing);
    const refused = [
      [`https://shop.example.com/collections/jackets`, null],
      [`https://shop.example.com/search?q=jacket`, null],
      [`https://shop.example.com/blogs/journal/how-to-wear-a-track-jacket`, null],
      [`https://shop.example.com/products/cropped-track-jacket-black-2025`, null],
      [`https://other.example.net/products/${HANDLE}`, null],
      [listing, 'https://shop.example.com/collections/jackets']
    ];
    for (const [landed, canonical] of refused) {
      const got = extractor.browserRecordListing(landed, listing, canonical);
      assert.ok(!got.listing, `asked on ${landed} (canonical ${canonical})`);
    }
    assert.ok(extractor.browserRecordListing(listing, 'https://shop.example.com/collections/jackets', null).skipped,
      'a listing that is not /products/<handle> has no record to ask for');
  });

  /* a store that answers its page only to a browser's navigation: Node's
     fetch sends no `sec-fetch-mode: navigate`, Chromium's goto does.
     `page` walls the browser off too; `redirect` sends the browser
     elsewhere; `analyticsId` is what ShopifyAnalytics names. */
  function browserOnlyStore({ record, page, redirect, analyticsId }) {
    const asked = [];
    const server = http.createServer((req, res) => {
      asked.push({ url: req.url, site: req.headers['sec-fetch-site'] || null, mode: req.headers['sec-fetch-mode'] || null });
      const port = server.address().port;
      const here = `http://127.0.0.1:${port}`;
      const navigating = req.headers['sec-fetch-mode'] === 'navigate';
      if (req.url === `/products/${HANDLE}` || req.url === '/collections/jackets') {
        if (!navigating || page) { res.writeHead(page || 403, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Access denied</title>'); }
        if (redirect && req.url === `/products/${HANDLE}`) { res.writeHead(302, { location: redirect }); return res.end(); }
        res.writeHead(200, { 'content-type': 'text/html' });
        const analytics = analyticsId === undefined ? 8123456789012 : analyticsId;
        return res.end(`<!doctype html><html><head>
<link rel="canonical" href="${here}${req.url}">
<meta property="og:image" content="${here}/cdn/shop/files/telfar-social-share.jpg">
</head><body>
<img src="/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1" width="800" height="1000" alt="">
${analytics === null ? '' : `<script>window.ShopifyAnalytics = { meta: { product: { id: ${JSON.stringify(analytics)}, variants: [] } } };</script>`}
</body></html>`);
      }
      if (req.url === `/products/${HANDLE}.js`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(typeof record === 'function' ? record(port) : record));
      }
      if (req.url.startsWith('/cdn/shop/files/')) {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(PHOTO);
      }
      res.writeHead(404);
      res.end();
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, asked, port: server.address().port })));
  }
  const recordAsks = (store) => store.asked.filter((one) => one.url === `/products/${HANDLE}.js`);

  if (!extractor.loadPlaywright()) {
    console.log('  skip  the .js record asked for by a rendered page — Playwright is not installed here');
    skipped += 5;
  } else {
    await testAsync('plain HTTP walled, the browser served: the page’s own .js record ties the photo', async () => {
      const store = await browserOnlyStore({ record: jacketRecord() });
      try {
        const result = await extractor.resolveRow(asListing(store.port), undefined, { catalogRow: JACKET_ROW });
        assert.strictEqual(result.verdict, 'VERIFIED', result.why);
        assert.strictEqual(result.from, 'product-record');
        assert.strictEqual(result.url, `http://127.0.0.1:${store.port}/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg?v=1`);
        assert.strictEqual(result.identity.via, 'product-record');
        assert.strictEqual(result.identity.source, undefined, 'the .js record is the standard one, not the embedded kind');
        assert.strictEqual(result.identity.handle, HANDLE);
        assert.strictEqual(result.identity.productId, '8123456789012');
        assert.strictEqual(result.diagnosis.productRecord.via, 'browser');
        assert.ok(result.notes.some((note) => /product record \(browser\): cropped-track-jacket-white-2025 lists 2 images/.test(note)), result.notes.join(' | '));

        /* the page was refused to plain HTTP first, and the record was
           asked for once — by the page, same-origin, never by a plain request */
        assert.ok(store.asked.some((one) => one.url === `/products/${HANDLE}` && one.mode !== 'navigate'), 'plain HTTP never asked for the page');
        assert.strictEqual(recordAsks(store).length, 1);
        assert.strictEqual(recordAsks(store)[0].site, 'same-origin');

        /* the gallery photo was refused on identity before the record was read */
        assert.ok(result.diagnosis.refusals.some((one) => one.gate === 'identity' && /TELFAR-CROPPED-TRACK-JACKET-WHITE-1/.test(one.url) && one.source !== 'Shopify product record'));
      } finally {
        store.server.close();
      }
    });

    await testAsync('a browser-read record for another handle, product or garment offers nothing', async () => {
      const cases = [
        [{ record: jacketRecord({ handle: 'cropped-track-jacket-black-2025' }) }, /is for cropped-track-jacket-black-2025, not this listing's/],
        [{ record: jacketRecord({ id: 'gid://shopify/Product/8123456789012' }) }, /names no product id/],
        [{ record: jacketRecord(), analyticsId: 7000000000001 }, /ShopifyAnalytics names product 7000000000001, but the product record is product 8123456789012/],
        [{ record: jacketRecord({ title: 'Track Medium Bag - Black' }) }, /is not the garment the row means/]
      ];
      for (const [setup, says] of cases) {
        const store = await browserOnlyStore(setup);
        try {
          const result = await extractor.resolveRow(asListing(store.port), undefined, { catalogRow: JACKET_ROW });
          assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
          assert.strictEqual(result.diagnosis.productRecord.via, 'browser');
          assert.match(result.diagnosis.productRecord.failed, says);
          assert.strictEqual(recordAsks(store).length, 1, 'the record was not asked for through the page');
          assert.ok(!result.diagnosis.refusals.some((one) => one.source === 'Shopify product record'), 'a refused record still offered photos');
        } finally {
          store.server.close();
        }
      }
    });

    await testAsync('a browser-read record’s photo on a foreign host is refused', async () => {
      const store = await browserOnlyStore({
        record: jacketRecord({ images: [], featured_image: null, variants: [],
          media: [{ media_type: 'image', src: 'http://localhost:1/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg' }] })
      });
      try {
        const result = await extractor.resolveRow(asListing(store.port), undefined, { catalogRow: JACKET_ROW });
        assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
        const refusal = result.diagnosis.refusals.find((one) => one.url === 'http://localhost:1/cdn/shop/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-1.jpg');
        assert.ok(refusal, 'the foreign photo was never put to the gates');
        assert.strictEqual(refusal.gate, 'identity');
        assert.match(refusal.why, /localhost is not the store's own host or Shopify's CDN/);
      } finally {
        store.server.close();
      }
    });

    await testAsync('a page that is not /products/<handle> is never asked for a record', async () => {
      /* the listing redirects the browser to a collection */
      const moved = await browserOnlyStore({ record: jacketRecord(), redirect: '/collections/jackets' });
      try {
        const result = await extractor.resolveRow(asListing(moved.port), undefined, { catalogRow: JACKET_ROW });
        assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
        assert.match(result.diagnosis.productRecord.failed, /the browser ended on .*\/collections\/jackets, not this listing's/);
        assert.strictEqual(recordAsks(moved).length, 0, 'a collection page was asked for a product record');
      } finally {
        moved.server.close();
      }

      /* and a listing that is a collection to begin with */
      const collection = await browserOnlyStore({ record: jacketRecord() });
      try {
        const result = await extractor.resolveRow(
          Object.assign(asListing(collection.port), { productUrl: `http://127.0.0.1:${collection.port}/collections/jackets` }),
          undefined, { catalogRow: JACKET_ROW });
        assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
        assert.ok(result.diagnosis.productRecord.skipped);
        assert.strictEqual(recordAsks(collection).length, 0, 'a collection listing was asked for a product record');
      } finally {
        collection.server.close();
      }
    });

    await testAsync('a page the browser is refused too is never asked for a record', async () => {
      const store = await browserOnlyStore({ record: jacketRecord(), page: 403 });
      try {
        const result = await extractor.resolveRow(asListing(store.port), undefined, { catalogRow: JACKET_ROW });
        assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
        assert.match(result.why, /answered 403 to a real browser too/);
        assert.strictEqual(recordAsks(store).length, 0, 'the record was used to get round a page the browser was refused');
      } finally {
        store.server.close();
      }
    });
  }

  /* ---------------------------------------------------------
     A category page's own products, as candidates

     A live run for Wide Leg Trouser came back with nothing but category
     pages — Ann Taylor, White House Black Market, Express, J.Crew — two
     of them misread as product pages because a category id looked like
     a product code, and J.Crew's __NEXT_DATA__ never read. A category
     page is never the answer; the products its own data lists may be,
     and each is tried on its own product page, through every gate.
     --------------------------------------------------------- */
  console.log('\n  — a category page’s own products, as candidates\n');

  test('a category id is not a product code, and /products/ followed by a category is not a product', () => {
    for (const url of [
      'https://www.whitehouseblackmarket.com/store/category/pants/wide-leg-pants/cat210019',
      'https://www.express.com/womens-clothing/pants/wide-leg-pants/cat4700001',
      'https://www.anntaylor.com/clothing/pants/wide-leg-pants/cata000013'
    ]) assert.strictEqual(extractor.listingShape(url, '').kind, 'listing', url);
    assert.notStrictEqual(extractor.listingShape('https://www2.hm.com/en_us/women/products/skirts/pleated-skirts.html', '').kind, 'product');
    for (const url of [
      'https://www.whitehouseblackmarket.com/store/product/wide-leg-trouser/570412345',
      'https://www.jcrew.com/p/womens/categories/clothing/pants/wide-leg/BX123',
      'https://shop.two.com/products/wide-leg-trouser',
      'https://www.example.com/collections/trousers/products/wide-leg',
      'https://www.zara.com/us/en/wide-leg-cargo-trousers-p05555123.html'
    ]) assert.strictEqual(extractor.listingShape(url, '').kind, 'product', url);
  });

  const tile = (url, name, id, image) => Object.assign({}, url === undefined ? {} : { url }, name === undefined ? {} : { name },
    id === undefined ? {} : { productId: id }, image === undefined ? {} : { image: { url: image } });

  test('only a tile that names its own page, a name, an id and an image is read — never a recommendation', () => {
    const data = {
      props: { pageProps: {
        grid: { products: [
          tile('/p/wide-leg-trouser/570412345', 'Wide Leg Trouser', '570412345', '/img/570412345-tile.jpg'),
          tile(undefined, 'Wide Leg Trouser No Link', '570411111', '/img/570411111-tile.jpg'),
          tile('/p/wide-leg-trouser/570422222', 'Wide Leg Trouser No Id', undefined, '/img/570422222-tile.jpg'),
          tile('/p/wide-leg-trouser/570433333', 'Wide Leg Trouser No Image', '570433333', undefined),
          tile('/p/wide-leg-trouser/570444444', undefined, '570444444', '/img/570444444-tile.jpg')
        ] },
        recommendations: { products: [tile('/p/wide-leg-trouser/570499999', 'Wide Leg Trouser Recommended', '570499999', '/img/570499999.jpg')] },
        relatedProducts: [tile('/p/wide-leg-trouser/570488888', 'Wide Leg Trouser Related', '570488888', '/img/570488888.jpg')],
        recentlyViewed: [tile('/p/wide-leg-trouser/570477777', 'Wide Leg Trouser Recent', '570477777', '/img/570477777.jpg')],
        navigation: { menu: [tile('/p/wide-leg-trouser/570466666', 'Wide Leg Trouser Menu', '570466666', '/img/570466666.jpg')] }
      } }
    };
    const tiles = extractor.embeddedProductTiles(data, '__NEXT_DATA__');
    assert.deepStrictEqual(tiles.map((one) => one.id), ['570412345']);

    /* a JSON-LD ItemList: a ListItem whose item is a Product counts; a
       bare ListItem with only a url and a name does not */
    const ld = [{ '@type': 'ItemList', itemListElement: [
      { '@type': 'ListItem', position: 1, item: { '@type': 'Product', url: '/p/wide-leg-trouser/570412345', name: 'Wide Leg Trouser', sku: '570412345', image: '/img/570412345-tile.jpg' } },
      { '@type': 'ListItem', position: 2, url: '/p/wide-leg-trouser/570455555', name: 'Wide Leg Trouser Bare' }
    ] }];
    assert.deepStrictEqual(extractor.embeddedProductTiles(ld, 'json-ld').map((one) => one.id), ['570412345']);

    /* and on this side, a tile has to be one product on the listing's own site */
    const listingUrl = 'https://shop.example.com/c/womens/pants/wide-leg';
    const links = extractor.listingProductLinks(listingUrl, [
      { url: '/p/wide-leg-trouser/570412345', name: 'Wide Leg Trouser', id: '570412345', image: '/img/a.jpg' },
      { url: 'https://elsewhere.example.net/p/wide-leg-trouser/570412346', name: 'Wide Leg Trouser', id: '570412346', image: '/img/b.jpg' },
      { url: '/collections/wide-leg-trousers', name: 'Wide Leg Trousers', id: '99', image: '/img/c.jpg' },
      { url: '/c/womens/pants/wide-leg', name: 'Wide Leg Trouser', id: '98', image: '/img/d.jpg' },
      { url: '/p/wide-leg-trouser/570412345#reviews', name: 'Wide Leg Trouser', id: '570412345', image: '/img/a.jpg' }
    ]);
    assert.deepStrictEqual(links.map((one) => one.productUrl), ['https://shop.example.com/p/wide-leg-trouser/570412345']);
  });

  const TROUSER_ROW = { id: 'fixture-wide-leg-trouser', name: 'Wide Leg Trouser', brand: 'Coveworks', category: 'trousers' };

  /* a shop with a category page whose __NEXT_DATA__ and JSON-LD list its
     products, drawing their tiles as artwork, and a page per product.
     `pages` decides what each product page says; it counts every request. */
  function categoryShop(pages, options) {
    const opts = options || {};
    const hits = [];
    const server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      hits.push(url);
      const here = `http://127.0.0.1:${server.address().port}`;
      if (url.endsWith('.jpg')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPEG); }
      if (url === '/c/womens/pants/wide-leg') {
        const next = opts.next ? opts.next(here) : { props: { pageProps: {
          grid: { products: [
            tile('/p/pleated-midi-skirt/570477777', 'Pleated Midi Skirt', '570477777', '/img/570477777-tile.jpg'),
            tile('/p/wide-leg-trouser-no-id/570455555', 'Wide Leg Trouser', undefined, '/img/570455555-tile.jpg'),
            tile('/p/wide-leg-trouser/570412345', 'Wide Leg Trouser', '570412345', '/img/570412345-tile.jpg')
          ] },
          recommendations: { products: [tile('/p/wide-leg-trouser/570499999', 'Wide Leg Trouser', '570499999', '/img/570499999-tile.jpg')] }
        } } };
        const ld = { '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: [
          { '@type': 'ListItem', position: 1, item: { '@type': 'Product', url: `${here}/p/wide-leg-trouser/570412345`, name: 'Wide Leg Trouser', sku: '570412345', image: `${here}/img/570412345-tile.jpg` } }
        ] };
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html><head><title>Wide Leg Pants for Women | Fixture</title>
<link rel="canonical" href="${here}/c/womens/pants/wide-leg">
<meta property="og:image" content="${here}/img/570412345-tile.jpg">
${opts.ld === false ? '' : `<script type="application/ld+json">${JSON.stringify(ld)}</script>`}
</head><body>
<div class="product-grid"><img src="/img/570412345-tile.jpg" width="800" height="1000" alt="Wide Leg Trouser"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>
</body></html>`);
      }
      const code = (url.match(/\d{6,}/) || [null])[0];
      const page = code && pages[code];
      if (!page) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head>
<link rel="canonical" href="${here}${url}">
<meta property="og:title" content="${page.name}">
<script type="application/ld+json">${JSON.stringify(Object.assign({ '@type': 'Product', sku: code, name: page.name, brand: { '@type': 'Brand', name: 'Fixture' } },
        page.photo ? { image: [`/img/${code}-hero.jpg`] } : {}))}</script>
</head><body></body></html>`);
    });
    server.hits = hits;
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  }

  const categoryFor = (port) => `http://127.0.0.1:${port}/c/womens/pants/wide-leg`;
  const offerCategory = (port) => {
    productSource.registerProvider({
      name: 'fake-source',
      configured: () => true,
      search: async () => [{ title: 'Wide Leg Pants for Women | Fixture', productUrl: categoryFor(port) }]
    });
    process.env.PRODUCT_SOURCE = 'fake-source';
  };

  await testAsync('a category page’s own product tile is tried on its own page, and verifies there', async () => {
    const shop = await categoryShop({
      570412345: { name: 'Wide Leg Trouser', photo: true },
      570477777: { name: 'Pleated Midi Skirt', photo: true },
      570499999: { name: 'Wide Leg Trouser', photo: true },
      570455555: { name: 'Wide Leg Trouser', photo: true }
    });
    const port = shop.address().port;
    try {
      offerCategory(port);
      const result = await extractor.discoverRow(TROUSER_ROW, new Map(), 8);
      assert.strictEqual(result.verdict, 'VERIFIED', result.why);
      assert.strictEqual(result.proposal.productUrl, `http://127.0.0.1:${port}/p/wide-leg-trouser/570412345`);
      assert.match(result.proposal.imageUrl, /\/img\/570412345-hero\.jpg$/, 'the photo is the product page’s own, not the category tile');

      /* the category page was tried first and refused, as always */
      const category = result.tried.find((one) => one.url === categoryFor(port));
      assert.ok(category && !category.verified, 'the category page itself was accepted');
      assert.strictEqual(category.shape, 'listing');

      /* the tile's candidate says where it came from */
      const winner = result.tried.find((one) => one.verified);
      assert.strictEqual(winner.foundOn, categoryFor(port));

      /* the wrong garment was offered and refused by the normal title gate, before any request */
      const skirt = result.tried.find((one) => /570477777/.test(one.url || ''));
      assert.ok(skirt, 'the skirt tile was never offered');
      assert.strictEqual(skirt.semantic.ok, false);
      assert.match(skirt.why, /semantic gate refused it/);
      assert.ok(!shop.hits.some((hit) => /570477777/.test(hit) && !hit.endsWith('.jpg')), 'the skirt’s page was read');

      /* a recommendation and a tile with no id were never offered, or read */
      for (const code of ['570499999', '570455555']) {
        assert.ok(!result.tried.some((one) => (one.url || '').includes(code)), `${code} was offered`);
        assert.ok(!shop.hits.some((hit) => hit.includes(`/p/`) && hit.includes(code)), `${code}'s page was read`);
      }
    } finally {
      shop.close();
    }
  });

  await testAsync('category-page artwork is never the product’s photo, even with a tile that names it', async () => {
    /* the product page has no photo of its own; the category page draws
       the tile, carries it as og:image and names its sku in an ItemList */
    const shop = await categoryShop({ 570412345: { name: 'Wide Leg Trouser', photo: false } });
    const port = shop.address().port;
    try {
      offerCategory(port);
      const result = await extractor.discoverRow(TROUSER_ROW, new Map(), 8);
      assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
      assert.ok(!result.proposal, 'a proposal was made');
      const offered = result.tried.find((one) => one.foundOn === categoryFor(port));
      assert.ok(offered, 'the tile was never offered');
      assert.ok(!offered.verified);
      assert.ok(!result.tried.some((one) => one.verified), 'something verified on category artwork');
    } finally {
      shop.close();
    }
  });

  /* ---------------------------------------------------------
     __NEXT_DATA__ as a retailer actually writes it

     The first extractor matched exact field names and an image only under
     url/src/href, and never opened state kept as a JSON string, so a grid
     written as {productCode, productName, pdpURL, images: {primary}} —
     or hydrated from a stringified initialState — gave nothing.
     --------------------------------------------------------- */
  test('retailer-shaped __NEXT_DATA__ tiles are read; recommendations and incomplete tiles still are not', () => {
    const grid = [
      /* J.Crew-like: productCode, productName, pdpURL, images.primary */
      { productCode: 'BX123', productName: 'Wide-Leg Pant', pdpURL: '/p/womens/pants/wide-leg-pant/BX123', images: { primary: 'https://www.example.com/s7-img-facade/BX123_KA2345' } },
      /* partNumber, productLink, image.path */
      { partNumber: '570412345', name: 'Wide Leg Trouser', productLink: '/store/product/wide-leg-trouser/570412345', image: { path: '/images/570412345.jpg' } },
      /* incomplete: an "image" that is not an address, and one with no id */
      { sku: '570400001', name: 'Wide Leg Trouser', url: '/p/wide-leg-trouser/570400001', image: 'Wide leg trouser photo' },
      { name: 'Wide Leg Trouser', pdp_url: '/p/wide-leg-trouser/570400002', imageUrl: '/img/570400002.jpg' }
    ];
    const state = JSON.stringify({
      search: { results: [{ skuId: '570455555', displayName: 'Wide Leg Trouser', productUrl: '/p/wide-leg-trouser/570455555', primaryImageUrl: '/img/570455555.jpg' }] },
      recommendations: [{ sku: '570499999', name: 'Wide Leg Trouser', url: '/p/wide-leg-trouser/570499999', image: '/img/570499999.jpg' }]
    });
    const data = { props: { pageProps: {
      category: { products: grid },
      initialState: state,
      youMayAlsoLike: JSON.stringify([{ sku: '570488888', name: 'Wide Leg Trouser', url: '/p/wide-leg-trouser/570488888', image: '/img/570488888.jpg' }])
    } } };
    const ids = extractor.embeddedProductTiles(data, '__NEXT_DATA__').map((one) => one.id).sort();
    assert.deepStrictEqual(ids, ['570412345', '570455555', 'BX123']);
  });

  /* J.Crew-shaped: the grid is inside a stringified initialState, with
     pdpURL and images.primary; its recommendations sit beside it */
  const jcrewNext = (products, recommended) => () => ({ props: { pageProps: {
    initialState: JSON.stringify({ category: { name: 'Wide-Leg Pants', productGrid: { products } }, recommendations: { products: recommended } })
  } } });
  const gridTile = (code, name, withImage) => Object.assign({ productCode: code, productName: name, pdpURL: `/p/womens/pants/${name.toLowerCase().replace(/\W+/g, '-')}/BX${code}` },
    withImage === false ? {} : { images: { primary: `/s7-img-facade/BX${code}_KA2345` } });

  await testAsync('a category page’s __NEXT_DATA__ grid, as a retailer writes it, yields a product that verifies on its own page', async () => {
    const shop = await categoryShop({
      570412345: { name: 'Wide Leg Trouser', photo: true },
      570477777: { name: 'Pleated Midi Skirt', photo: true },
      570499999: { name: 'Wide Leg Trouser', photo: true },
      570466666: { name: 'Wide Leg Trouser', photo: true }
    }, {
      ld: false,
      next: jcrewNext(
        [gridTile('570477777', 'Pleated Midi Skirt'), gridTile('570466666', 'Wide Leg Trouser', false), gridTile('570412345', 'Wide Leg Trouser')],
        [gridTile('570499999', 'Wide Leg Trouser')])
    });
    const port = shop.address().port;
    try {
      offerCategory(port);
      const result = await extractor.discoverRow(TROUSER_ROW, new Map(), 8);
      assert.strictEqual(result.verdict, 'VERIFIED', result.why);
      assert.strictEqual(result.proposal.productUrl, `http://127.0.0.1:${port}/p/womens/pants/wide-leg-trouser/BX570412345`);
      assert.match(result.proposal.imageUrl, /\/img\/570412345-hero\.jpg$/, 'the photo is the product page’s own');
      assert.ok(!/s7-img-facade/.test(result.proposal.imageUrl), 'the grid thumbnail became the photo');

      const category = result.tried.find((one) => one.url === categoryFor(port));
      assert.strictEqual(category.shape, 'listing');
      assert.ok(!category.verified, 'the category page itself was accepted');
      assert.strictEqual(category.productLinks.length, 2, 'the skirt and the trouser, and nothing else');

      /* the skirt was refused by the title gate, unread */
      const skirt = result.tried.find((one) => /570477777/.test(one.url || ''));
      assert.strictEqual(skirt.semantic.ok, false);
      assert.ok(!shop.hits.some((hit) => hit.includes('/p/') && hit.includes('570477777')));
      /* the recommendation and the tile with no image were never offered or read */
      for (const code of ['570499999', '570466666']) {
        assert.ok(!result.tried.some((one) => (one.url || '').includes(code)), `${code} was offered`);
        assert.ok(!shop.hits.some((hit) => hit.includes('/p/') && hit.includes(code)), `${code}'s page was read`);
      }
    } finally {
      shop.close();
    }
  });

  await testAsync('a __NEXT_DATA__ grid thumbnail is never the photo when the product page has none', async () => {
    const shop = await categoryShop({ 570412345: { name: 'Wide Leg Trouser', photo: false } }, {
      next: jcrewNext([gridTile('570412345', 'Wide Leg Trouser')], [])
    });
    const port = shop.address().port;
    try {
      offerCategory(port);
      const result = await extractor.discoverRow(TROUSER_ROW, new Map(), 8);
      assert.notStrictEqual(result.verdict, 'VERIFIED', `verified: ${result.why}`);
      assert.ok(result.tried.some((one) => one.foundOn === categoryFor(port)), 'the grid product was never offered');
      assert.ok(!result.tried.some((one) => one.verified));
    } finally {
      shop.close();
    }
  });

  await testAsync('once a category page has listed products, the category pages still waiting are held back for them', async () => {
    const shop = await categoryShop({ 570412345: { name: 'Wide Leg Trouser', photo: true } }, {
      ld: false,
      next: jcrewNext([gridTile('570412345', 'Wide Leg Trouser')], [])
    });
    const port = shop.address().port;
    try {
      productSource.registerProvider({
        name: 'fake-source',
        configured: () => true,
        search: async () => [1, 2, 3, 4].map((n) => ({ title: 'Wide Leg Pants for Women | Fixture', productUrl: `${categoryFor(port)}?page=${n}` }))
      });
      process.env.PRODUCT_SOURCE = 'fake-source';
      /* a row with 30s left: less than the reserve, but plenty to read in */
      const budget = { left: () => 30000, spent: () => false, cap: (want) => Math.max(0, Math.min(want, 30000)) };
      const result = await extractor.discoverRow(TROUSER_ROW, new Map(), 8, { budget });
      assert.strictEqual(result.verdict, 'VERIFIED', result.why);
      const fourth = result.tried.find((one) => one.url === `${categoryFor(port)}?page=4`);
      assert.match(fourth.why, /held back/, `the fourth category page was read: ${fourth.why}`);
    } finally {
      shop.close();
    }
  });

  /* ---------------------------------------------------------
     A canonical page vouches for its image only if it is a product page

     A live run accepted sample-coveworks-cargo-utility-pant from
     "Utility Pants vs. Cargo Pants" — an article on a trade
     publication, classed [editorial] — because the page declared itself
     canonical and carried a product-looking og:image.
     --------------------------------------------------------- */
  console.log('\n  — a canonical page vouches for its image only if it is a product page\n');

  const CARGO_ROW = { id: 'fixture-cargo-utility-pant', name: 'Cargo Utility Pant', brand: 'Coveworks', category: 'trousers' };
  const pageOf = ({ canonical, ogImage, ogType, jsonld, title }) => `<!doctype html><html><head>
${title ? `<title>${title}</title>` : ''}
<link rel="canonical" href="${canonical}">
<meta property="og:image" content="${ogImage}">
${ogType ? `<meta property="og:type" content="${ogType}">` : ''}
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head><body></body></html>`;
  /* the gates, as the pipeline runs them, on a page's own markup */
  const decidePage = async (url, html, title, row) => {
    const candidates = extractor.candidatesFrom(html, url);
    return extractor.firstVerifiable(candidates, Object.assign({ id: 'x', productUrl: url, name: title }, row || {}), serving(jpegOf(1000, 1250)));
  };

  await testAsync('"Utility Pants vs. Cargo Pants" is refused though it is canonical with a product-looking og:image', async () => {
    const article = 'https://www.forconstructionpros.com/workwear/article/22912345/utility-pants-vs-cargo-pants';
    /* as live: accepted via canonical, so the image carries no code of its own */
    const image = 'https://img.forconstructionpros.com/files/base/cygnus/fcp/image/2023/05/cargo-utility-pant.png';
    const opaque = 'https://img.forconstructionpros.com/files/base/cygnus/fcp/image/2023/05/hero.png';

    /* the listing is editorial by its own address and title, whatever the page declares */
    assert.strictEqual(extractor.listingShape(article, 'Utility Pants vs. Cargo Pants').kind, 'editorial');
    for (const [ogImage, jsonld] of [
      [opaque, null],
      [opaque, { '@context': 'https://schema.org', '@type': 'Product', name: 'Cargo Utility Pant' }]
    ]) {
      const found = await decidePage(article, pageOf({ canonical: article, ogImage }), 'Utility Pants vs. Cargo Pants');
      assert.ok(!found.url, `the article's og:image was accepted${jsonld ? ' because it marked up a Product' : ''}`);
      const refusal = found.refusals.find((one) => one.url === ogImage);
      assert.strictEqual(refusal.gate, 'identity');
      assert.match(refusal.why, /canonical for this listing, but it is not a product page — the listing is an editorial page/);
    }

    /* an article whose address alone would read as a product is caught by
       what the page declares itself to be */
    const coded = 'https://www.forconstructionpros.com/workwear/utility-pants-cargo-pants-22912345';
    assert.strictEqual(extractor.listingShape(coded, 'Cargo Utility Pant').kind, 'product');
    for (const declared of [
      { ogType: 'article' },
      { jsonld: { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Utility Pants vs. Cargo Pants' } },
      /* an article that marks up the product it reviews is still an article */
      { jsonld: { '@context': 'https://schema.org', '@graph': [{ '@type': 'BlogPosting' }, { '@type': 'Product', name: 'Cargo Utility Pant' }] } }
    ]) {
      const found = await decidePage(coded, pageOf(Object.assign({ canonical: coded, ogImage: opaque }, declared)), 'Cargo Utility Pant');
      assert.ok(!found.url, `an article was accepted: ${JSON.stringify(declared)}`);
      assert.match(found.refusals[0].why, /not a product page — the page declares itself an article or other non-product page/);
    }

    /* and the saved report entry from that run is refused on --write */
    const identity = { ok: true, via: 'canonical', canonical: article };
    const replay = extractor.replayable({
      id: CARGO_ROW.id, verified: true, productUrl: article, imageUrl: image,
      imageEvidence: extractor.evidenceNote(identity), identity,
      listingName: 'Utility Pants vs. Cargo Pants', provedOnPage: [],
      row: { name: CARGO_ROW.name, brand: CARGO_ROW.brand, category: CARGO_ROW.category }
    }, [Object.assign({ productUrl: null, imageUrl: null }, CARGO_ROW)], new Map());
    assert.strictEqual(replay.ok, false, 'the editorial entry in a saved report would have been written');
    assert.match(replay.why, /canonical evidence is for a page that is not a product page/);

    /* nor does --coverage account for such a row if one was ever written */
    const shipped = extractor.catalogRowIdentity(Object.assign({}, CARGO_ROW, {
      productUrl: article, imageUrl: image, imageEvidence: { via: 'canonical', canonical: article }
    }));
    assert.strictEqual(shipped.ok, false);
    assert.match(shipped.why, /not a product page — its path sits under \/article\//);
  });

  await testAsync('a genuine product page still vouches for an opaque og:image', async () => {
    /* its address names one product; the page declares nothing either way */
    const zara = 'https://www.zara.com/us/en/wide-leg-cargo-trousers-p05555123.html';
    const opaque = 'https://static.zara.net/photos/2024/I/0/1/p/opaque-hash-e1.jpg?ts=1';
    const plain = await decidePage(zara, pageOf({ canonical: zara, ogImage: opaque }), 'Wide Leg Cargo Trousers', { name: 'Wide Leg Cargo Trousers' });
    assert.strictEqual(plain.url, opaque, JSON.stringify(plain.refusals));
    assert.strictEqual(plain.identity.via, 'canonical');

    /* and one that says it is a product, in its structured data or its og:type */
    for (const declared of [
      { jsonld: { '@context': 'https://schema.org', '@type': 'Product', name: 'Wide Leg Cargo Trousers', image: opaque } },
      { ogType: 'product' }
    ]) {
      const found = await decidePage(zara, pageOf(Object.assign({ canonical: zara, ogImage: opaque }, declared)), 'Wide Leg Cargo Trousers');
      assert.strictEqual(found.url, opaque, `a product page was refused: ${JSON.stringify(declared)} — ${JSON.stringify(found.refusals)}`);
      assert.strictEqual(found.identity.via, 'canonical');
    }

    /* and its saved entry still replays */
    const identity = { ok: true, via: 'canonical', canonical: zara };
    const replay = extractor.replayable({
      id: CARGO_ROW.id, verified: true, productUrl: zara, imageUrl: opaque,
      imageEvidence: extractor.evidenceNote(identity), identity,
      listingName: 'Wide Leg Cargo Trousers', provedOnPage: [],
      row: { name: 'Wide Leg Cargo Trousers', brand: CARGO_ROW.brand, category: CARGO_ROW.category }
    }, [Object.assign({}, CARGO_ROW, { name: 'Wide Leg Cargo Trousers', productUrl: null, imageUrl: null })], new Map());
    assert.strictEqual(replay.ok, true, replay.why);
  });

  test('a page that says nothing at an address that says nothing is not a product page', () => {
    const unknown = { kind: 'unknown', why: 'nothing in its URL or title says either way' };
    assert.strictEqual(extractor.productPageVerdict(unknown, { declaresProduct: 'its og:type is product', declaresArticle: null }).ok, true);
    assert.strictEqual(extractor.productPageVerdict(unknown, { declaresProduct: null, declaresArticle: null }).ok, false);
    assert.strictEqual(extractor.productPageVerdict({ kind: 'product', why: 'x' }, { declaresProduct: null, declaresArticle: null }).ok, true);
    /* what a page declares, read the same way the pipeline reads it */
    const declared = (html) => extractor.pageDeclarationsFromHtml(html);
    assert.ok(declared('<meta property="og:type" content="product">').declaresProduct);
    assert.ok(declared('<meta property="product:price:amount" content="98.00">').declaresProduct);
    assert.ok(declared('<div itemscope itemtype="https://schema.org/Product"></div>').declaresProduct);
    assert.ok(declared('<script type="application/ld+json">{"@type":"FAQPage"}</script>').declaresArticle);
    assert.ok(declared('<meta property="og:type" content="article">').declaresArticle);
  });

  await testAsync('category, search and other unrelated canonical pages stay refused', async () => {
    const opaque = 'https://cdn.example-shop.com/img/hero-opaque.jpg';

    /* a search results page, canonical for itself */
    const search = 'https://www.example-shop.com/search?q=cargo+pants&start=555123';
    assert.strictEqual(extractor.listingShape(search, 'Search results for cargo pants').kind, 'listing');
    const searched = await decidePage(search, pageOf({ canonical: search, ogImage: opaque }), 'Search results for cargo pants');
    assert.ok(!searched.url);
    assert.match(searched.refusals[0].why, /not a product page — the listing is a listing page/);

    /* a collection page whose address reads as a product */
    const collection = 'https://www.example-shop.com/women/cargo-pants-555123';
    const collected = await decidePage(collection, pageOf({ canonical: collection, ogImage: opaque, jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Cargo Pants' } }), 'Cargo Utility Pant');
    assert.ok(!collected.url);
    assert.match(collected.refusals[0].why, /declares itself an article or other non-product page — its structured data calls it CollectionPage/);

    /* and a canonical that names another page is refused as it always was */
    const listing = 'https://www.zara.com/us/en/wide-leg-cargo-trousers-p05555123.html';
    const elsewhere = await decidePage(listing, pageOf({ canonical: 'https://www.zara.com/us/en/linen-shirt-p09999999.html', ogImage: opaque }), 'Wide Leg Cargo Trousers');
    assert.ok(!elsewhere.url);
    assert.match(elsewhere.refusals[0].why, /nothing ties it to this product/);
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
