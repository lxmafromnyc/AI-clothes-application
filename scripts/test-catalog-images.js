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
const http = require('http');
const vm = require('vm');
const extractor = require('./fetch-catalog-images');

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
      assert.ok(row.productUrl, `${row.id} carries a photo but links to no listing`);
      const host = extractor.soundness(row.imageUrl, row.productUrl);
      assert.strictEqual(host, null, `${row.id}: ${host}`);
      const identity = extractor.identityEvidence({ url: row.imageUrl, from: 'catalogue' }, row.productUrl);
      assert.strictEqual(identity.ok, true, `${row.id}: ${identity.why}`);
    }
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

  console.log(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(failures.length ? 1 : 0);
})();

/* evaluates an edited catalogue the way the extractor reads the real
   one, so a write is judged by what the rows become, not by string
   matching on the file */
function evaluate(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(source + ';this.__rows = DEMO_PRODUCTS;').runInContext(sandbox, { timeout: 5000 });
  return sandbox.__rows;
}
