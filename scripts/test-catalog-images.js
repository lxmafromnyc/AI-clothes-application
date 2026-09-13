#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue photo extraction test

   scripts/fetch-catalog-images.js takes a real catalogue row's own
   productUrl, asks that page for its own photo, checks the answer and
   writes back only what passed. This holds it to that, without a
   network: every page and every image here is answered from this file.

   The one exception is the rendered-page test, which starts a local
   server and drives the real Chromium through Playwright — because
   "Zara builds its gallery in the browser" is the case a stub cannot
   honestly stand in for.

   Also holds the catalogue itself to the rules, whatever ends up in it:
   an https URL, tied to its own product, never an aggregator's.

   Usage: node scripts/test-catalog-images.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const X = require('./fetch-catalog-images');

let passed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message}`); }
}

async function testAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message}`); }
}

/* ---------------------------------------------------------
   Stubs
   --------------------------------------------------------- */

const response = (over) => Object.assign({
  status: 200,
  ok: true,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
  text: async () => ''
}, over);

const htmlResponse = (html) => response({
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
  text: async () => html
});

/* answers pages and images from a map; records what was asked and with
   which Referer, which is how the hotlink rule is tested */
function stubFetch(routes) {
  const calls = [];
  return Object.assign(async (url, opts) => {
    const headers = (opts && opts.headers) || {};
    calls.push({ url: String(url), referer: headers.Referer || null });
    for (const [pattern, answer] of Object.entries(routes)) {
      if (String(url).includes(pattern)) {
        return typeof answer === 'function' ? answer(String(url), headers) : answer;
      }
    }
    return response({ status: 404, ok: false });
  }, { calls });
}

const UNIQLO_URL = 'https://www.uniqlo.com/us/en/products/E429066-000/00';
const ZARA_URL = 'https://www.zara.com/us/en/oxford-shirt-p06887613.html';
const LEVIS_URL = 'https://www.levi.com/US/en_US/chino-pants/levis-chino-pants-for-men/levis-xx-chino-standard-taper-fit-mens-pants/p/171960005';

async function main() {
  console.log('\nthe product code that ties a photo to a product');

  test("UNIQLO's page code, with and without the colour suffix", () => {
    const codes = X.codesFrom(UNIQLO_URL);
    assert.ok(codes.includes('E429066-000'), codes.join(','));
    assert.ok(codes.includes('E429066'), codes.join(','));
  });

  test("Zara's reference, with the p- prefix dropped", () => {
    assert.ok(X.codesFrom(ZARA_URL).includes('06887613'), X.codesFrom(ZARA_URL).join(','));
  });

  test("Levi's style number", () => {
    assert.ok(X.codesFrom(LEVIS_URL).includes('171960005'), X.codesFrom(LEVIS_URL).join(','));
  });

  console.log('\nextraction, from the page’s own markup');

  test('og:image is taken, in either attribute order', () => {
    const a = X.extract('<meta property="og:image" content="https://image.uniqlo.com/a/E429066-000.jpg">', UNIQLO_URL, []);
    assert.strictEqual(a.method, 'og:image');
    assert.strictEqual(a.url, 'https://image.uniqlo.com/a/E429066-000.jpg');
    const b = X.extract('<meta content="https://image.uniqlo.com/b.jpg" property="og:image">', UNIQLO_URL, []);
    assert.strictEqual(b.url, 'https://image.uniqlo.com/b.jpg');
  });

  test('a JSON-LD Product image is taken when there is no og:image', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Product', name: 'Oxford Shirt',
      sku: '06887613', image: ['https://static.zara.net/photos/06887613-front.jpg']
    })}</script>`;
    const found = X.extract(html, ZARA_URL, X.codesFrom(ZARA_URL));
    assert.strictEqual(found.method, 'json-ld');
    assert.strictEqual(found.url, 'https://static.zara.net/photos/06887613-front.jpg');
    assert.strictEqual(found.sku, '06887613');
  });

  test('a Product nested in an @graph is found, and an ImageObject unwrapped', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@graph': [{ '@type': 'WebPage' }, { '@type': ['Product'], image: { '@type': 'ImageObject', url: 'https://lsco.scene7.com/is/image/171960005.jpg' } }]
    })}</script>`;
    const found = X.extract(html, LEVIS_URL, X.codesFrom(LEVIS_URL));
    assert.strictEqual(found.url, 'https://lsco.scene7.com/is/image/171960005.jpg');
  });

  test('og:image outranks JSON-LD', () => {
    const html = '<meta property="og:image" content="https://image.uniqlo.com/og.jpg">'
      + `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', image: 'https://elsewhere/ld.jpg' })}</script>`;
    assert.strictEqual(X.extract(html, UNIQLO_URL, []).method, 'og:image');
  });

  test('structured data is only read from a script that names this product', () => {
    const mine = '<script>window.__NEXT_DATA__={"product":{"ref":"06887613","img":"https://static.zara.net/photos/06887613-1.jpg"}}</script>';
    const found = X.extract(mine, ZARA_URL, X.codesFrom(ZARA_URL));
    assert.strictEqual(found.method, 'structured-data');
    assert.strictEqual(found.url, 'https://static.zara.net/photos/06887613-1.jpg');

    const someoneElse = '<script>window.banner={"img":"https://static.zara.net/promo/summer-sale.jpg"}</script>';
    assert.strictEqual(X.extract(someoneElse, ZARA_URL, X.codesFrom(ZARA_URL)), null, 'a banner in the bundle is not the product');
  });

  test('a gallery image is taken only when its URL carries the code', () => {
    const right = '<img src="https://static.zara.net/photos/06887613-e1.jpg" alt="">';
    assert.strictEqual(X.extract(right, ZARA_URL, X.codesFrom(ZARA_URL)).method, 'gallery');
    const wrong = '<img src="https://static.zara.net/photos/99999999-e1.jpg" alt="">';
    assert.strictEqual(X.extract(wrong, ZARA_URL, X.codesFrom(ZARA_URL)), null, 'another product’s photo is not this one');
  });

  test('a relative URL is resolved against the product page', () => {
    const found = X.extract('<meta property="og:image" content="/media/E429066-000.jpg">', UNIQLO_URL, []);
    assert.strictEqual(found.url, 'https://www.uniqlo.com/media/E429066-000.jpg');
  });

  test('no image anywhere is null, not a guess', () => {
    assert.strictEqual(X.extract('<html><body><p>Sold out</p></body></html>', UNIQLO_URL, X.codesFrom(UNIQLO_URL)), null);
  });

  console.log('\nverification');

  const row = { id: 'zara-oxford-shirt', name: 'Oxford Shirt — White', productUrl: ZARA_URL };

  await testAsync('http is refused before a request is made', async () => {
    const v = await X.verify('http://static.zara.net/photos/06887613.jpg', row, { fetchImpl: stubFetch({}) });
    assert.strictEqual(v.pass, false);
    assert.ok(/not https/.test(v.why), v.why);
  });

  await testAsync('an aggregator or stock host is refused even though it loads', async () => {
    for (const bad of [
      'https://encrypted-tbn0.gstatic.com/images?q=abc',
      'https://lh3.googleusercontent.com/x.jpg',
      'https://www.shutterstock.com/image-photo/shirt.jpg'
    ]) {
      const v = await X.verify(bad, row, { fetchImpl: stubFetch({ '': response() }) });
      assert.strictEqual(v.pass, false, bad);
      assert.ok(/aggregator or stock/.test(v.why), `${bad}: ${v.why}`);
    }
  });

  await testAsync('a page served where an image was expected is refused', async () => {
    const v = await X.verify('https://static.zara.net/photos/06887613.jpg', row, {
      fetchImpl: stubFetch({ '06887613': htmlResponse('<html>not an image</html>') })
    });
    assert.strictEqual(v.pass, false);
    assert.ok(/not an image/.test(v.why), v.why);
  });

  await testAsync('a dead URL is refused', async () => {
    const v = await X.verify('https://static.zara.net/photos/gone.jpg', row, {
      fetchImpl: stubFetch({ gone: response({ status: 404, ok: false }) })
    });
    assert.strictEqual(v.pass, false);
    assert.ok(/returned 404/.test(v.why), v.why);
  });

  await testAsync('a hotlink block is refused — it would be an empty tile on the site', async () => {
    const v = await X.verify('https://static.zara.net/photos/06887613.jpg', row, {
      site: 'https://lxmafromnyc.github.io',
      fetchImpl: stubFetch({ '06887613': (url, headers) => (headers.Referer ? response({ status: 403, ok: false }) : response()) })
    });
    assert.strictEqual(v.pass, false);
    assert.ok(/hotlink blocked/.test(v.why), v.why);
    assert.ok(/lxmafromnyc\.github\.io/.test(v.why), v.why);
  });

  await testAsync('an image that loads both ways passes, and the host is reported', async () => {
    const v = await X.verify('https://static.zara.net/photos/06887613.jpg', row, {
      fetchImpl: stubFetch({ '06887613': response() })
    });
    assert.strictEqual(v.pass, true, v.why);
    assert.strictEqual(v.host, 'static.zara.net');
  });

  console.log('\ndoes the photo belong to THIS product');

  test('the code in the URL is the strongest tie', () => {
    assert.strictEqual(X.productMatch('https://static.zara.net/p/06887613-e1.jpg', null, X.codesFrom(ZARA_URL), row), 'code');
  });

  test("a matching sku in the block the URL came from also counts", () => {
    const m = X.productMatch('https://static.zara.net/p/opaque-hash.jpg', { sku: '06887613' }, X.codesFrom(ZARA_URL), row);
    assert.strictEqual(m, 'sku');
  });

  test('neither is "none", which is what makes the row be left alone', () => {
    assert.strictEqual(X.productMatch('https://static.zara.net/p/opaque.jpg', null, X.codesFrom(ZARA_URL), { name: 'Nothing alike' }), 'none');
  });

  console.log('\none row, end to end');

  await testAsync('a page with og:image is verified and reported OK', async () => {
    const r = await X.resolveRow({ id: 'uniqlo-merino-crew', name: 'Merino Crew', brand: 'UNIQLO', productUrl: UNIQLO_URL }, {
      noBrowser: true,
      fetchImpl: stubFetch({
        'uniqlo.com/us/en/products': htmlResponse('<meta property="og:image" content="https://image.uniqlo.com/goods/E429066-000.jpg">'),
        'image.uniqlo.com': response()
      })
    });
    assert.strictEqual(r.verdict, 'OK', r.why);
    assert.strictEqual(r.host, 'image.uniqlo.com');
    assert.strictEqual(r.method, 'og:image');
    assert.strictEqual(r.match, 'code');
    assert.strictEqual(r.sameSite, true);
  });

  await testAsync('a page whose markup has nothing falls through to the rendered DOM', async () => {
    const r = await X.resolveRow({ id: 'zara-oxford-shirt', name: 'Oxford Shirt', brand: 'ZARA', productUrl: ZARA_URL }, {
      fetchImpl: stubFetch({
        'zara.com/us/en': htmlResponse('<html><head></head><body><div id="app"></div></body></html>'),
        'static.zara.net': response()
      }),
      renderImpl: async () => ({ html: '<meta property="og:image" content="https://static.zara.net/photos/06887613-e1.jpg">', why: null })
    });
    assert.strictEqual(r.verdict, 'OK', r.why);
    assert.strictEqual(r.method, 'og:image (rendered)', r.method);
    assert.strictEqual(r.host, 'static.zara.net');
  });

  await testAsync('an image nothing ties to the product is SKIPped, not written', async () => {
    const r = await X.resolveRow({ id: 'zara-oxford-shirt', name: 'Oxford Shirt', brand: 'ZARA', productUrl: ZARA_URL }, {
      noBrowser: true,
      fetchImpl: stubFetch({
        'zara.com/us/en': htmlResponse('<meta property="og:image" content="https://static.zara.net/photos/unrelated-hash.jpg">'),
        'static.zara.net': response()
      })
    });
    assert.strictEqual(r.verdict, 'SKIP', r.why);
    assert.strictEqual(r.match, 'none');
  });

  await testAsync('a page that cannot be fetched is FAIL, with the status said out loud', async () => {
    const r = await X.resolveRow({ id: 'levis-xx-chino-taper', name: 'XX Chino', brand: "LEVI'S", productUrl: LEVIS_URL }, {
      noBrowser: true,
      fetchImpl: stubFetch({ 'levi.com': response({ status: 403, ok: false }) })
    });
    assert.strictEqual(r.verdict, 'FAIL');
    assert.ok(/403/.test(r.why), r.why);
    assert.strictEqual(r.url, null);
  });

  console.log('\nthe write-back');

  const sample = fs.readFileSync(path.join(__dirname, '..', 'assets', 'catalog.js'), 'utf8');

  test('a verified row is written, and only that field of it', () => {
    const { source, written } = X.applyToCatalog(sample, [
      { id: 'uniqlo-merino-crew', verdict: 'OK', url: 'https://image.uniqlo.com/goods/E429066-000.jpg' }
    ]);
    assert.deepStrictEqual(written, ['uniqlo-merino-crew']);
    assert.ok(source.includes("imageUrl: 'https://image.uniqlo.com/goods/E429066-000.jpg'"));
    /* one field changed, nothing else in the file */
    assert.strictEqual(source.length - sample.length, "'https://image.uniqlo.com/goods/E429066-000.jpg'".length - 'null'.length);
    assert.strictEqual((source.match(/imageUrl:/g) || []).length, (sample.match(/imageUrl:/g) || []).length);
  });

  test('a FAIL or SKIP leaves its row exactly as it was', () => {
    const { source, written } = X.applyToCatalog(sample, [
      { id: 'zara-oxford-shirt', verdict: 'FAIL', url: null },
      { id: 'levis-xx-chino-taper', verdict: 'SKIP', url: 'https://static.zara.net/unrelated.jpg' }
    ]);
    assert.deepStrictEqual(written, []);
    assert.strictEqual(source, sample, 'the file is untouched');
  });

  test('writing one row does not touch another row that is still null', () => {
    const { source } = X.applyToCatalog(sample, [
      { id: 'uniqlo-merino-crew', verdict: 'OK', url: 'https://image.uniqlo.com/goods/E429066-000.jpg' }
    ]);
    const rows = X.readRows(source);
    const zara = rows.find((r) => r.id === 'zara-oxford-shirt');
    assert.strictEqual(zara.imageUrl, null, 'the other real row is still null');
  });

  console.log('\nthe catalogue itself, whatever ends up in it');

  const rows = X.readRows(sample);
  const all = new Function(`${sample}\n;return DEMO_PRODUCTS;`)();

  test('every populated imageUrl is https', () => {
    all.filter((r) => r.imageUrl).forEach((r) => {
      assert.ok(/^https:\/\//.test(r.imageUrl), `${r.id}: ${r.imageUrl}`);
    });
  });

  test('every populated imageUrl belongs to its own product', () => {
    rows.filter((r) => r.imageUrl).forEach((r) => {
      const codes = X.codesFrom(r.productUrl);
      assert.ok(codes.some((c) => r.imageUrl.includes(c)),
        `${r.id}: ${r.imageUrl} carries none of ${codes.join(', ')}`);
    });
  });

  test('no populated imageUrl is a search thumbnail or a stock photo', () => {
    all.filter((r) => r.imageUrl).forEach((r) => {
      const host = new URL(r.imageUrl).hostname;
      X.NEVER.forEach((bad) => {
        assert.ok(host !== bad && !host.endsWith(`.${bad}`), `${r.id} points at ${host}`);
      });
    });
  });

  test('a sample row with no productUrl may keep its silhouette', () => {
    const samples = all.filter((r) => !r.productUrl);
    assert.ok(samples.length, 'there are sample rows');
    samples.forEach((r) => {
      assert.ok(r.imageUrl === null || /^https:\/\//.test(r.imageUrl), `${r.id}: ${r.imageUrl}`);
    });
  });

  console.log('\nthe rendered path, driving the real Chromium');

  await testAsync('a page that builds its gallery in the browser gives up its photo', async () => {
    /* served markup with no image at all; the gallery arrives from a
       script, exactly as Zara and Levi's do it */
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Oxford Shirt</title></head><body>
        <div id="app"></div>
        <script>
          /* assembled at runtime, so neither the URL nor the product code
             appears in the served bytes — which is what makes this a
             genuine stand-in for a gallery built in the browser */
          var host = 'static.' + 'zara' + '.net';
          var ref = '068' + '87613';
          var m = document.createElement('meta');
          m.setAttribute('property', 'og:image');
          m.setAttribute('content', 'https://' + host + '/photos/' + ref + '-e1.jpg');
          document.head.appendChild(m);
        </script></body></html>`);
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}/oxford-shirt-p06887613.html`;

    try {
      const served = await new Promise((done) => {
        http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => done(b)); });
      });
      assert.strictEqual(X.extract(served, url, ['06887613']), null, 'nothing in the served HTML, as expected');

      const rendered = await X.renderedHtml(url);
      assert.ok(rendered.html, `chromium did not render: ${rendered.why}`);
      const found = X.extract(rendered.html, url, ['06887613']);
      assert.ok(found, 'the rendered DOM should carry the photo');
      assert.strictEqual(found.url, 'https://static.zara.net/photos/06887613-e1.jpg');
      assert.strictEqual(found.method, 'og:image');
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
