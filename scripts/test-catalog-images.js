#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue image extractor test

   scripts/fetch-catalog-images.js reads a product photo off the page a
   catalogue row already links to. It cannot be trusted on the strength
   of having run: the whole point of it is what it REFUSES to write, and
   a refusal only shows up when the wrong thing is offered to it.

   So this offers it the wrong things. A Google Shopping thumbnail, a
   stock library, an http URL, a tracking pixel, an image the host serves
   plainly and refuses to our Referer — each is put in front of a gate
   that must turn it down. Then the right thing is offered, and the file
   it writes is checked for having changed nothing but the one field.

   No retailer is contacted. The markup is a fixture and the image host
   is a local server, so this runs anywhere, including behind a proxy
   that refuses every host on the internet.

   Usage: node scripts/test-catalog-images.js
   ========================================================= */

'use strict';

const assert = require('assert');
const http = require('http');
const extractor = require('./fetch-catalog-images');

let passed = 0;
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

const PAGE = 'https://www.uniqlo.com/us/en/products/E429066-000/00';

/* ---------------------------------------------------------
   Fixtures, in the shapes retailers actually publish
   --------------------------------------------------------- */

const withJsonLd = `<!doctype html><html><head>
<meta property="og:image" content="https://image.uniqlo.com/og-card.jpg">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"BreadcrumbList","itemListElement":[]},
  {"@type":"Product","name":"Merino Crew","image":["https://image.uniqlo.com/goods/44/item/main.jpg"]}
]}
</script></head><body></body></html>`;

const ogOnly = `<!doctype html><html><head>
<meta content="https://static.zara.net/photos/shirt.jpg?ts=1&amp;w=1200" property="og:image">
</head><body></body></html>`;

const preloadOnly = `<!doctype html><html><head>
<link rel="preload" as="image" imagesrcset="https://lsco.scene7.com/s/small.jpg 400w, https://lsco.scene7.com/s/large.jpg 1600w">
</head><body></body></html>`;

/* what a page looks like when the only picture on it belongs to a
   comparison service rather than to the shop */
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

(async () => {
  console.log('\nCatalogue image extractor\n');

  /* ---------- what the page offers ---------- */

  test('a Product in @graph is preferred to the sharing card', () => {
    const found = extractor.candidatesFrom(withJsonLd, PAGE);
    assert.strictEqual(found[0], 'https://image.uniqlo.com/goods/44/item/main.jpg');
    assert.ok(found.includes('https://image.uniqlo.com/og-card.jpg'), 'the og:image stays as a fallback');
  });

  test('an og:image is read whichever order its attributes are in', () => {
    const found = extractor.candidatesFrom(ogOnly, PAGE);
    assert.strictEqual(found[0], 'https://static.zara.net/photos/shirt.jpg?ts=1&w=1200');
  });

  test('a preloaded srcset gives up its widest image, not its smallest', () => {
    const found = extractor.candidatesFrom(preloadOnly, PAGE);
    assert.strictEqual(found[0], 'https://lsco.scene7.com/s/large.jpg');
  });

  test('widths order the srcset even when the markup does not', () => {
    const order = extractor.largestFromSrcset('https://h/a.jpg 100w, https://h/c.jpg 2000w, https://h/b.jpg 800w');
    assert.deepStrictEqual(order, ['https://h/c.jpg', 'https://h/b.jpg', 'https://h/a.jpg']);
  });

  test('a page with no product image in it offers nothing to write', () => {
    assert.deepStrictEqual(extractor.candidatesFrom('<html><body><img src="/logo.svg"></body></html>', PAGE), []);
  });

  /* ---------- which hosts are allowed to supply it ---------- */

  test('a Google Shopping thumbnail is refused by name', () => {
    const [url] = extractor.candidatesFrom(aggregatorOnly, PAGE);
    assert.match(extractor.soundness(url, PAGE), /aggregator or stock host/);
  });

  test('stock libraries are refused', () => {
    for (const host of ['images.unsplash.com', 'www.shutterstock.com', 'media.gettyimages.com', 'via.placeholder.com']) {
      const verdict = extractor.soundness(`https://${host}/x.jpg`, PAGE);
      assert.match(String(verdict), /aggregator or stock host/, `${host} must be refused`);
    }
  });

  test('an http image is refused before it is ever requested', () => {
    assert.match(extractor.soundness('http://image.uniqlo.com/main.jpg', PAGE), /cannot load on an https page/);
  });

  test("the retailer's own image host is allowed", () => {
    assert.strictEqual(extractor.soundness('https://image.uniqlo.com/goods/44/item/main.jpg', PAGE), null);
  });

  test('a CDN the retailer publishes through is allowed', () => {
    assert.strictEqual(extractor.soundness('https://lsco.scene7.com/is/image/levis/171960005-front.jpg', PAGE), null);
  });

  /* ---------- whether the browser could actually load it ---------- */

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

  /* ---------- what the file looks like afterwards ---------- */

  const { source, rows } = extractor.readCatalog();

  test('the catalogue reads as rows, with the linked ones carrying a productUrl', () => {
    assert.ok(rows.length >= 3, 'the catalogue has rows');
    const linked = rows.filter((r) => r.productUrl);
    assert.ok(linked.length >= 3, 'three rows link to a real listing');
    assert.ok(linked.every((r) => r.id && r.name && r.brand), 'a linked row is identifiable');
  });

  test('writing a photo fills one field and leaves the rest of the row alone', () => {
    const next = extractor.writeInto(source, 'uniqlo-merino-crew', 'https://image.uniqlo.com/goods/44/item/main.jpg');
    assert.ok(next.includes("imageUrl: 'https://image.uniqlo.com/goods/44/item/main.jpg'"), 'the URL is written');
    assert.ok(next.includes("productUrl: 'https://www.uniqlo.com/us/en/products/E429066-000/00'"), 'the listing is untouched');
    assert.ok(next.includes("id: 'uniqlo-merino-crew'"), 'the identity is untouched');
    assert.strictEqual(next.split('imageUrl:').length, source.split('imageUrl:').length, 'no field is added or lost');
  });

  test('a photo is written into the row that owns it, and no other', () => {
    const next = extractor.writeInto(source, 'zara-oxford-shirt', 'https://static.zara.net/photos/shirt.jpg');
    const rows2 = new vmLessRead(next).rows;
    const zara = rows2.find((r) => r.id === 'zara-oxford-shirt');
    const uniqlo = rows2.find((r) => r.id === 'uniqlo-merino-crew');
    assert.strictEqual(zara.imageUrl, 'https://static.zara.net/photos/shirt.jpg');
    assert.strictEqual(uniqlo.imageUrl, null, 'the row above it keeps its null');
  });

  test('every row still normalises after a write, so the page can render it', () => {
    const next = extractor.writeInto(source, 'levis-xx-chino-taper', 'https://lsco.scene7.com/is/image/levis/171960005-front.jpg');
    const rows2 = new vmLessRead(next).rows;
    assert.strictEqual(rows2.length, rows.length, 'no row is lost');
    const levis = rows2.find((r) => r.id === 'levis-xx-chino-taper');
    assert.strictEqual(levis.productUrl, rows.find((r) => r.id === 'levis-xx-chino-taper').productUrl);
  });

  test('a URL carrying a quote is refused rather than breaking the file', () => {
    assert.throws(
      () => extractor.writeInto(source, 'uniqlo-merino-crew', "https://image.uniqlo.com/a'b.jpg"),
      /unquotable/
    );
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();

/* evaluates an edited catalogue the way the extractor reads the real
   one, so a write is judged by what the rows become, not by string
   matching on the file */
function vmLessRead(source) {
  const vm = require('vm');
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(source + ';this.__rows = DEMO_PRODUCTS;').runInContext(sandbox, { timeout: 5000 });
  this.rows = sandbox.__rows;
}
