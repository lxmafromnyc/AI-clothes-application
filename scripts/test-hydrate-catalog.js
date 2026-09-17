#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue hydration test

   scripts/hydrate-catalog.js reads a product's photo, price, name and
   brand off the page a catalogue row links to. It cannot be trusted on
   the strength of having run: the whole point of it is what it REFUSES
   to write, and a refusal only shows up when the wrong thing is offered
   to it.

   So this offers it the wrong things.

   For the photo: a Google Shopping thumbnail, a stock library, an http
   URL, a tracking pixel, an image the host serves plainly and refuses to
   our Referer, and — the one that matters most once a browser is
   involved — a perfectly good photo of a DIFFERENT garment on the right
   retailer's own CDN.

   For the price: a figure in euros on a page a dollar sign will be drawn
   beside, a bare "$" on a page that never says which dollar it means, a
   negative, an amount too large to be a garment, an offer belonging to
   another sku, a struck-through was-price, an instalment plan, a
   recommendation strip's price, and a listing that quotes two live
   figures without saying which one it is charging.

   And for a row that has to be found rather than read: a comparison
   page, a redirector, a category listing, and a real product page
   selling something the row was never describing.

   Each is put in front of a gate that must turn it down. Then the right
   thing is offered, and the file it writes is checked for having changed
   nothing but the fields that verified.

   One section exists to make provenance worth writing down: a price is
   put in the file with the note that accounts for it, the number is then
   edited the way a person would edit it, and the row has to stop
   re-proving itself.

   The browser path is exercised for real: local servers play a retailer
   that refuses plain HTTP and builds its gallery in JavaScript, a
   retailer behind a cookie wall, and a retailer whose price exists only
   in the pixels. Chromium is sent at each exactly as the hydrator would.
   No retailer is contacted, so this runs anywhere, including behind a
   proxy that refuses every host on the internet.

   Usage: node scripts/test-hydrate-catalog.js
   Skips the browser section with a clear message if Playwright is absent.
   ========================================================= */

'use strict';

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const extractor = require('./hydrate-catalog');

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
   Priced pages, in the shapes retailers actually publish
   --------------------------------------------------------- */

const LLBEAN = 'https://www.llbean.com/llb/shop/129244';

const pricedJsonLd = `<!doctype html><html><head>
<link rel="canonical" href="${LLBEAN}">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","sku":"129244","name":"VentureStretch Commuter Chinos",
 "brand":{"@type":"Brand","name":"L.L.Bean"},
 "image":["https://cdni.llbean.net/is/image/wim/521659_32573_41"],
 "offers":{"@type":"Offer","price":"89.00","priceCurrency":"USD","availability":"https://schema.org/InStock"}}
</script></head><body></body></html>`;

/* a listing with no single price of its own, only a range */
const aggregateOffer = `<!doctype html><html><head>
<link rel="canonical" href="${UNIQLO}">
<script type="application/ld+json">
{"@type":"Product","sku":"E429066-000","offers":{"@type":"AggregateOffer","lowPrice":"39.90","highPrice":"49.90","priceCurrency":"USD","offerCount":4}}
</script></head><body></body></html>`;

/* the shape most retailers actually publish: a range that names its own
   starting price, with the variants it is aggregating nested under it */
const aggregateWithVariants = `<!doctype html><html><head>
<link rel="canonical" href="${UNIQLO}">
<script type="application/ld+json">
{"@type":"Product","sku":"E429066-000","offers":{"@type":"AggregateOffer","lowPrice":"39.90","highPrice":"49.90","priceCurrency":"USD","offers":[
  {"@type":"Offer","price":"39.90","priceCurrency":"USD"},
  {"@type":"Offer","price":"49.90","priceCurrency":"USD"}]}}
</script></head><body></body></html>`;

/* the same product priced two ways, with nothing saying which is charged */
const variantPrices = `<!doctype html><html><head>
<link rel="canonical" href="${UNIQLO}">
<script type="application/ld+json">
{"@type":"Product","sku":"E429066-000","offers":[
  {"@type":"Offer","price":"49.90","priceCurrency":"USD"},
  {"@type":"Offer","price":"39.90","priceCurrency":"USD"}]}
</script></head><body></body></html>`;

const pricedMeta = `<!doctype html><html><head>
<link rel="canonical" href="${UNIQLO}">
<meta property="product:price:amount" content="49.90">
<meta property="product:price:currency" content="USD">
</head><body></body></html>`;

const pricedMicrodata = `<!doctype html><html><head>
<link rel="canonical" href="${UNIQLO}">
</head><body itemtype="https://schema.org/Product" itemscope>
<meta itemprop="price" content="49.90">
<meta itemprop="priceCurrency" content="USD">
</body></html>`;

const pricedInEuros = `<!doctype html><html><head>
<link rel="canonical" href="${ZARA}">
<script type="application/ld+json">
{"@type":"Product","sku":"06887613","offers":{"@type":"Offer","price":"49.90","priceCurrency":"EUR"}}
</script></head><body></body></html>`;

/* an offer belonging to a different product, on a page that claims no
   canonical of its own — nothing here may vouch for this listing */
const someoneElsesOffer = `<!doctype html><html><head>
<script type="application/ld+json">
{"@type":"Product","sku":"999999","offers":{"@type":"Offer","price":"12.00","priceCurrency":"USD"}}
</script></head><body></body></html>`;

/* what a search result looks like: a figure on a page that publishes no
   product record at all. Nothing may read a price out of this. */
const snippetOnly = `<!doctype html><html><head><title>merino crew — results</title></head>
<body><div class="result"><a href="${UNIQLO}">Merino Crew</a><span class="price">$49.90</span></div></body></html>`;

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


/* ---------------------------------------------------------
   A retailer whose price exists only in the pixels

   No JSON-LD, no price meta with an amount in it: the figure a shopper
   reads is drawn by the page and nothing else states it. That is the
   case the rendered-price path exists for, and it is also where a wrong
   price comes from, so the page is laid out with every trap on it — a
   struck-through was-price, an instalment line, and a recommendation
   strip pricing something else entirely.

   Three pages, because the interesting answers are different:
     /p/06887613  one live figure, and everything else a distraction
     /p/06887614  two live figures and nothing saying which is charged
     /p/06887615  the same as the first, with nothing declaring USD
   --------------------------------------------------------- */
function pricedRetailer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }

    const port = server.address().port;
    const code = url.split('/').pop();

    /* ---- the shape that put a $7.90 pair of socks on a $49.90 sweater ----

       A product page carrying microdata for its own product AND for
       every tile in its recommendation carousel. Both sit on a page
       that is canonically this listing's, so being on the right page
       cannot be what vouches for a figure — only being inside the
       product's own block can. */
    if (code === '07777777' || code === '07777779') {
      /* 07777777 is the faithful one: the product's own price exists
         only as drawn text, exactly as a script-rendered storefront
         leaves it, while the carousel below publishes microdata. So the
         ONLY microdata on the page belongs to other products, and an
         unscoped read has nothing else to find.
         07777779 is the same page with the product marked up too, which
         exercises the tighter itemscope path. */
      const typed = code === '07777779';
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head>
        <link rel="canonical" href="http://127.0.0.1:${port}/p/${code}">
        <meta property="product:price:currency" content="USD">
        <title>Merino Crew</title></head>
        <body><main>
          <div class="product-info"${typed ? ' itemscope itemtype="https://schema.org/Product"' : ''}>
            <h1>Extra Fine Merino Crew Neck Sweater</h1>
            ${typed ? '<meta itemprop="price" content="49.90"><meta itemprop="priceCurrency" content="USD">' : ''}
            <div class="prices"><span class="now">$49.90</span></div>
          </div>
          <section class="recommendations">
            <div class="rec" itemscope itemtype="https://schema.org/Product">
              <h3>Ribbed Socks</h3>
              <meta itemprop="price" content="7.90">
              <meta itemprop="priceCurrency" content="USD">
              <span class="price">$7.90</span>
            </div>
            <div class="rec" itemscope itemtype="https://schema.org/Product">
              <h3>Leather Belt</h3>
              <meta itemprop="price" content="39.90">
              <meta itemprop="priceCurrency" content="USD">
              <span class="price">$39.90</span>
            </div>
          </section>
        </main></body></html>`);
    }

    /* ---- the shape that offered five live figures at once ----

       One heading block holding a was-price, a members' price, four
       colourway prices and the price actually being charged. The page
       labels the last one, and that label is the only thing that may
       settle it. /p/08888889 is the same page with the label removed,
       which must stay unanswerable. */
    if (code === '08888888' || code === '08888889') {
      const marked = code === '08888888' ? 'sale-price' : 'colour-e';
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head>
        <link rel="canonical" href="http://127.0.0.1:${port}/p/${code}">
        <meta property="product:price:currency" content="USD">
        <title>Oxford Shirt</title></head>
        <body><main>
          <div class="product-info">
            <h1>Broken-in Organic Cotton Oxford Shirt</h1>
            <div class="price-group">
              <span class="was-price"><s>$89.50</s></span>
              <span class="${marked}">$49.50</span>
              <span class="price-note">Members $44.50</span>
              <span class="colour-a">$59.50</span>
              <span class="colour-b">$64.50</span>
              <span class="colour-c">$69.50</span>
              <span class="colour-d">$74.50</span>
            </div>
          </div>
        </main></body></html>`);
    }

    /* ---- the shape the real UNIQLO page actually has ----

       Reported from a live run: 1 price candidate, $7.9, refused for a
       bare $. That is not a carousel's microdata — it is the heading
       walk anchoring on the WRONG <h1>. The first h1 in this document
       is the storefront's own, and the nearest block around it that
       holds a figure is a promo strip advertising socks. The product's
       real h1, and its real price, are further down and never reached.

       The page also declares no currency anywhere except its locale,
       which is why even the right figure would have been refused. */
    if (code === '09999999') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html lang="en-US"><head>
        <link rel="canonical" href="http://127.0.0.1:${port}/p/${code}">
        <meta property="og:title" content="Extra Fine Merino Crew Neck Long-Sleeve Sweater">
        <title>Extra Fine Merino Crew Neck Long-Sleeve Sweater | UNIQLO US</title></head>
        <body>
          <header class="site-header">
            <div class="promo-strip">
              <h1 class="sr-only">UNIQLO</h1>
              <p class="promo">Socks 3-pack now $7.90</p>
            </div>
          </header>
          <main>
            <div class="product-info">
              <h1 class="product-title">Extra Fine Merino Crew Neck Long-Sleeve Sweater</h1>
              <div class="prices"><span class="now">$49.90</span></div>
            </div>
          </main>
        </body></html>`);
    }

    /* ---- the shape the real J.Crew page actually has ----

       Reported from a live run: 1 price candidate, and a heading block
       drawing $98, $128, $118, $58.50 with none of them labelled. The
       listing DOES publish an offer — but its JSON-LD carries the
       characters &quot; inside a string, and decoding a block that
       arrived already decoded turns that into a bare quote, ends the
       string early, and throws the record away without a word. */
    if (code === 'AU763') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html lang="en-US"><head>
        <link rel="canonical" href="http://127.0.0.1:${port}/p/${code}">
        <meta property="og:title" content="Broken-in organic cotton oxford shirt">
        <title>Broken-in organic cotton oxford shirt</title>
        <script type="application/ld+json">
        {"@type":"Product","sku":"AU763","name":"The &quot;Broken-in&quot; organic cotton oxford shirt","offers":{"@type":"Offer","price":"58.50","priceCurrency":"USD"}}
        </script></head>
        <body><main>
          <div class="product-info">
            <h1>Broken-in organic cotton oxford shirt</h1>
            <div class="prices">
              <span class="a">$98</span><span class="b">$128</span>
              <span class="c">$118</span><span class="d">$58.50</span>
            </div>
          </div>
        </main></body></html>`);
    }

    const ambiguous = code === '06887614';
    const silentAboutCurrency = code === '06887615';

    /* a currency with no amount beside it: enough to say which dollar
       the page means, and nothing more. Retailers really do publish
       this, and without it a bare "$" has to be refused. */
    const currency = silentAboutCurrency ? '' : '<meta property="product:price:currency" content="USD">';

    const live = ambiguous
      ? '<span class="a">$39.00</span><span class="b">$49.90</span>'
      : '<span class="now">$49.90</span>';

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="http://127.0.0.1:${port}/p/${code}">
      ${currency}
      <title>Oxford Shirt</title></head>
      <body>
        <main>
          <div class="product-info">
            <h1>Broken-in Organic Cotton Oxford Shirt</h1>
            <div class="prices">
              <span class="was-price"><s>$79.00</s></span>
              ${live}
            </div>
            <p class="finance">or 4 payments of $12.48</p>
          </div>
          <section class="recommendations">
            <div class="rec"><h3>Ribbed Socks</h3><span class="price">$19.00</span></div>
            <div class="rec"><h3>Leather Belt</h3><span class="price">$58.00</span></div>
          </section>
        </main>
      </body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  console.log('\nCatalogue hydration\n');

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
  /* ---------- what the page says it costs ---------- */
  console.log('\n  — the price on the page\n');

  const priceOf = (html, listing) => extractor.firstVerifiablePrice(
    extractor.priceCandidatesFrom(html, listing), listing);

  test("a JSON-LD offer gives up the product's price and its currency", () => {
    const got = priceOf(pricedJsonLd, LLBEAN);
    assert.strictEqual(got.amount, 89, got.refusals && JSON.stringify(got.refusals));
    assert.strictEqual(got.currency, 'USD');
    assert.match(got.why, /sku 129244/);
  });

  test('an AggregateOffer is read as the price it starts at', () => {
    const got = priceOf(aggregateOffer, UNIQLO);
    assert.strictEqual(got.amount, 39.9, got.refusals && JSON.stringify(got.refusals));
  });

  test('an AggregateOffer settles the variants nested under it', () => {
    /* the nested offers are what it is aggregating, not a disagreement
       with it, so this must NOT come back ambiguous */
    const got = priceOf(aggregateWithVariants, UNIQLO);
    assert.strictEqual(got.amount, 39.9,
      `read ${got.amount} — refusals: ${JSON.stringify(got.refusals || [])}`);
  });

  test('a price meta is read on the page that is canonical for the listing', () => {
    const got = priceOf(pricedMeta, UNIQLO);
    assert.strictEqual(got.amount, 49.9, got.refusals && JSON.stringify(got.refusals));
    assert.match(got.from, /product:price:amount/);
  });

  test('microdata states the same claim and is read the same way', () => {
    const got = priceOf(pricedMicrodata, UNIQLO);
    assert.strictEqual(got.amount, 49.9, got.refusals && JSON.stringify(got.refusals));
  });

  test('a page with no product record offers no price to read', () => {
    /* what a search result is: a figure beside a link. The card would be
       wrong in exactly the way that is hardest to notice, so no path
       here may turn it into a candidate at all */
    const candidates = extractor.priceCandidatesFrom(snippetOnly, UNIQLO);
    assert.strictEqual(candidates.length, 0,
      `a snippet became ${candidates.length} candidate(s): ${JSON.stringify(candidates)}`);
  });

  /* ---------- is it a price at all? ---------- */
  console.log('\n  — the price soundness gate\n');

  const sound = (amount, extra) => extractor.priceSoundness(Object.assign({ amount, from: 'json-ld-offer' }, extra || {}));

  test('a figure in another currency is refused rather than shown as dollars', () => {
    const got = priceOf(pricedInEuros, ZARA);
    assert.ok(got.amount === undefined, 'a euro price was accepted');
    assert.match(got.refusals[0].why, /prices it in EUR/);
  });

  test('a bare $ is refused where nothing says which dollar it is', () => {
    const verdict = sound('$49.90', { currency: null, hint: null });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /bare \$/);
  });

  test('a bare $ is read as USD once the page has said it prices in USD', () => {
    const verdict = sound('$49.90', { currency: null, hint: 'USD' });
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.strictEqual(verdict.amount, 49.9);
  });

  test('a negative amount is refused, not turned into its own opposite', () => {
    assert.strictEqual(sound('-5.00', { currency: 'USD' }).ok, false);
    assert.strictEqual(sound('-$5.00', { currency: 'USD' }).ok, false);
    assert.strictEqual(sound('($5.00)', { currency: 'USD' }).ok, false);
  });

  test('an amount too large to be a garment is refused', () => {
    assert.match(String(sound('999999', { currency: 'USD' }).why), /too large/);
  });

  test('a page that will not name a number is not made to', () => {
    assert.match(String(sound('Call for price', { currency: 'USD' }).why), /no number/);
  });

  test('thousands and decimals are told apart rather than stripped', () => {
    assert.strictEqual(extractor.parseAmount('$1,299.00').amount, 1299);
    assert.strictEqual(extractor.parseAmount('1.299,00').amount, 1299);
    assert.strictEqual(extractor.parseAmount('1,500').amount, 1500);
    assert.strictEqual(extractor.parseAmount('1,50').amount, 1.5);
  });

  /* ---------- is it THIS product's price? ---------- */
  console.log('\n  — the price identity gate\n');

  test("an offer naming another product's sku is refused", () => {
    const got = priceOf(someoneElsesOffer, LLBEAN);
    assert.ok(got.amount === undefined, "another product's price was accepted");
    assert.match(got.refusals[0].why, /sku 999999, which is not this listing/);
  });

  test('a price meta on a page canonical for a DIFFERENT product is refused', () => {
    const elsewhere = pricedMeta.replace(UNIQLO, 'https://www.uniqlo.com/us/en/products/E111111-000/00');
    const got = priceOf(elsewhere, UNIQLO);
    assert.ok(got.amount === undefined, "another listing's price was accepted");
    assert.match(got.refusals[0].gate, /identity/);
  });

  test('a listing quoting two live figures is reported, not resolved by guess', () => {
    const got = priceOf(variantPrices, UNIQLO);
    assert.ok(got.amount === undefined, 'one of two ambiguous prices was picked');
    assert.strictEqual(got.refusals[0].gate, 'current');
    assert.match(got.refusals[0].why, /2 different amounts/);
  });

  test('a price failure says which gate stopped which figure', () => {
    const got = extractor.firstVerifiablePrice([
      { amount: '49.90', currency: 'EUR', from: 'json-ld-offer' },
      { amount: 'free', currency: 'USD', from: 'og:price:amount' },
      { amount: '12.00', currency: 'USD', from: 'json-ld-offer', node: { sku: '999999' } }
    ], LLBEAN);
    assert.ok(got.amount === undefined);
    assert.deepStrictEqual(got.refusals.map((r) => r.gate), ['sound', 'sound', 'identity']);
    assert.ok(got.refusals.every((r) => r.from && r.why), 'a refusal must say where it came from and why');
  });

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
      /* one note for the browser read, counting BOTH kinds of candidate:
         the photo and the price come out of the same load of the same
         page, which is what lets a card claim they belong together */
      assert.match(notes, /a real browser: \d+ photo candidates?, \d+ price candidates?/, `notes were: ${notes}`);
      assert.ok(retailer.plain() > 0, 'plain HTTP was never tried first');
      /* every photo candidate is http on localhost, so the host gate
         refuses them all, and the page quotes no price at all — which is
         the correct answer, and proves both halves ran their gates */
      assert.strictEqual(result.verdict, 'FAILED');
      assert.strictEqual(result.image, null);
      assert.strictEqual(result.price, null);
      assert.match(result.why, /no photo and no price/);
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

  /* ---------- a price that exists only in the pixels ---------- */
  if (!(probe.failed && probe.noBrowser)) {
    console.log('\n  — the price the page draws\n');

    const shop = await pricedRetailer();
    const shopOrigin = `http://127.0.0.1:${shop.address().port}`;
    const pageOf = async (code) => {
      const url = `${shopOrigin}/p/${code}`;
      const seen = await extractor.renderPage(url);
      return { url, seen };
    };

    const plainPage = await pageOf('06887613');

    await testAsync('the one live figure in the heading block is the price', async () => {
      assert.ok(!plainPage.seen.failed, `the browser path failed: ${plainPage.seen.failed}`);
      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(plainPage.seen.seen, plainPage.url), plainPage.url);
      assert.strictEqual(got.amount, 49.9,
        `read ${got.amount} — refusals: ${JSON.stringify(got.refusals || [])}`);
      assert.strictEqual(got.currency, 'USD');
    });

    await testAsync('the struck-through was-price is not what is read', async () => {
      const heading = plainPage.seen.seen.prices.heading;
      const was = heading.find((e) => e.text.includes('79'));
      assert.ok(was, 'the was-price was never seen at all, so this proves nothing');
      assert.strictEqual(was.struck, true, 'a $79 was-price was read as live');
    });

    await testAsync('an instalment line is not mistaken for the price', async () => {
      const heading = plainPage.seen.seen.prices.heading;
      assert.ok(!heading.some((e) => e.text.includes('12.48')),
        `"4 payments of $12.48" reached the price candidates: ${JSON.stringify(heading)}`);
    });

    await testAsync("a recommendation strip's prices never enter the heading block", async () => {
      const heading = plainPage.seen.seen.prices.heading;
      for (const other of ['19.00', '58.00']) {
        assert.ok(!heading.some((e) => e.text.includes(other)),
          `$${other} from the recommendations was read as this product's price`);
      }
    });

    await testAsync('two live figures are reported rather than chosen between', async () => {
      const page = await pageOf('06887614');
      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(page.seen.seen, page.url), page.url);
      assert.ok(got.amount === undefined, `it picked ${got.amount} out of two`);
      assert.strictEqual(got.refusals[0].gate, 'current');
      assert.match(got.refusals[0].why, /2 different live figures/);
    });

    await testAsync('a bare $ on a page that never names its currency is refused', async () => {
      const page = await pageOf('06887615');
      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(page.seen.seen, page.url), page.url);
      assert.ok(got.amount === undefined, `an undeclared dollar was accepted as ${got.amount}`);
      assert.match(got.refusals[0].why, /bare \$/);
    });

    /* ---------- the two shapes that got a price wrong in the wild ----------

       Both were found by running the hydrator against real listings, and
       both are reproduced here as the MECHANISM that defeated it rather
       than as a copy of the page: a recommendation carousel publishing
       its own microdata, and a heading block quoting several live
       figures with one of them labelled. */

    await testAsync("a recommendation carousel's microdata is not this product's price", async () => {
      const page = await pageOf('07777777');
      const candidates = extractor.priceCandidatesFromRendered(page.seen.seen, page.url);
      const got = extractor.firstVerifiablePrice(candidates, page.url);

      assert.strictEqual(got.amount, 49.9,
        `read ${got.amount} — refusals: ${JSON.stringify(got.refusals || [])}`);
      /* the specific wrong answer this page used to produce */
      assert.notStrictEqual(got.amount, 7.9, "a recommended pair of socks was read as the sweater's price");
      /* and it must never even have been offered: the page is canonical
         for this listing, so a socks price that became a candidate would
         have sailed through the identity gate on the page's authority */
      assert.ok(!candidates.some((c) => String(c.amount) === '7.90' || c.amount === 7.9),
        `the carousel's price became a candidate: ${JSON.stringify(candidates.map((c) => c.amount))}`);
    });

    await testAsync('the product block is what scopes a scraped figure, not the page', async () => {
      /* the page publishes microdata for two products, and neither is
         this one — so the correct number of microdata candidates is
         zero, and the price has to come from what the block draws */
      const loose = (await pageOf('07777777')).seen.seen.prices;
      assert.strictEqual(loose.scope, "the block holding the product's heading", `the scope was ${loose.scope}`);
      assert.deepStrictEqual(loose.microdata, [],
        `microdata was read from outside the product block: ${JSON.stringify(loose.microdata)}`);

      /* and where the product IS marked up, the tighter scope is used
         and finds its own figure rather than the carousel's */
      const typed = (await pageOf('07777779')).seen.seen.prices;
      assert.strictEqual(typed.scope, "the product's own itemscope", `the scope was ${typed.scope}`);
      assert.deepStrictEqual(typed.microdata.map((m) => m.content), ['49.90'],
        'the carousel\'s microdata was read as the product\'s');
    });

    await testAsync('a labelled sale price settles a block quoting several figures', async () => {
      const page = await pageOf('08888888');
      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(page.seen.seen, page.url), page.url);
      assert.strictEqual(got.amount, 49.5,
        `read ${got.amount} — refusals: ${JSON.stringify(got.refusals || [])}`);
      assert.match(got.from, /marks it current/);
    });

    await testAsync('without that label the same five figures stay unanswerable', async () => {
      const page = await pageOf('08888889');
      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(page.seen.seen, page.url), page.url);
      assert.ok(got.amount === undefined, `it picked ${got.amount} out of five unlabelled figures`);
      const ambiguity = got.refusals.find((r) => r.gate === 'current');
      assert.ok(ambiguity, `no ambiguity was reported: ${JSON.stringify(got.refusals)}`);
      assert.match(ambiguity.why, /none is marked as the one being charged/);
    });

    await testAsync("a members' price is not read as the price either", async () => {
      const page = await pageOf('08888888');
      const heading = page.seen.seen.prices.heading;
      assert.ok(!heading.some((e) => e.text.includes('44.50')),
        `"Members $44.50" reached the price candidates: ${JSON.stringify(heading)}`);
    });

    /* ---------- the two real listings, as they actually behaved ----------

       Both of these reproduce a symptom observed on a live run, down to
       the number that came out: $7.9 refused for a bare $, and four
       unlabelled figures with no offer to settle them. */

    await testAsync('the product\'s own heading anchors the block, not the first one on the page', async () => {
      const page = await pageOf('09999999');
      const seen = page.seen.seen.prices;

      const chosen = seen.headings.find((h) => h.chosen);
      assert.ok(chosen, 'no heading was chosen at all');
      assert.match(chosen.text, /Merino Crew Neck/,
        `the block anchored on ${JSON.stringify(chosen.text)} — the storefront's heading, not the product's`);
      assert.strictEqual(seen.headings.length, 2, 'both headings should be reported');

      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(page.seen.seen, page.url), page.url);
      assert.strictEqual(got.amount, 49.9,
        `read ${got.amount} — refusals: ${JSON.stringify(got.refusals || [])}`);
      assert.notStrictEqual(got.amount, 7.9, "the promo strip's socks were read as the sweater's price");
    });

    await testAsync('a storefront that names its locale settles a bare $', async () => {
      const page = await pageOf('09999999');
      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(page.seen.seen, page.url), page.url);
      assert.strictEqual(got.currency, 'USD');
      /* and it is recorded, so a price resting on the locale can be told
         apart later from one the page stated outright */
      assert.match(String(got.identity.currencyVia), /en-US locale/);
    });

    await testAsync('an offer record survives the characters &quot; inside it', async () => {
      const page = await pageOf('AU763');
      const got = extractor.firstVerifiablePrice(
        extractor.priceCandidatesFromRendered(page.seen.seen, page.url), page.url);

      assert.strictEqual(got.amount, 58.5,
        `read ${got.amount} — refusals: ${JSON.stringify(got.refusals || [])}`);
      assert.match(got.from, /json-ld-offer/,
        'the price came from somewhere other than the listing\'s own offer record');
      assert.match(got.why.toLowerCase(), /sku au763/);
    });

    await testAsync('the offer beats the four unlabelled figures drawn beside it', async () => {
      const page = await pageOf('AU763');
      const drawn = page.seen.seen.prices.heading.map((h) => h.text);
      /* the page really does draw all four — the offer is what settles
         them, not a filter that made them go away */
      for (const figure of ['$98', '$128', '$118', '$58.50']) {
        assert.ok(drawn.some((t) => t.includes(figure)), `${figure} was not drawn at all: ${JSON.stringify(drawn)}`);
      }
      const candidates = extractor.priceCandidatesFromRendered(page.seen.seen, page.url);
      assert.match(String(candidates[0].from), /json-ld-offer/,
        `the first candidate was ${candidates[0].from}, so the drawn figures were tried first`);
    });

    shop.close();
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

  /* ---------- the provenance a priced row carries ----------

     A photo can vouch for itself: the listing's code is in the URL. A
     price never can — 89 is 89 whatever product it belongs to. So the
     row records how it was obtained AND what was read, and that record
     is re-proved from the row alone. The test that matters is the last
     one in this block: change the number the way a person would, leave
     the note alone, and the row has to stop accounting for itself. */
  console.log('\n  — the price a shipped row carries\n');

  const priceEvidenceFor = (over) => Object.assign({
    via: 'json-ld-offer', sku: '129244', amount: 89, currency: 'USD', asOf: '2026-09-17'
  }, over || {});

  const pricedRow = (over) => Object.assign({
    id: 'x', productUrl: LLBEAN, price: 89, priceEvidence: priceEvidenceFor()
  }, over || {});

  test('a price read off its own listing accounts for itself', () => {
    const verdict = extractor.catalogRowPrice(pricedRow());
    assert.strictEqual(verdict.ok, true, verdict.why);
    assert.match(verdict.how, /129244/);
  });

  test('a price with no provenance at all is refused', () => {
    const verdict = extractor.catalogRowPrice({ id: 'x', productUrl: LLBEAN, price: 89 });
    assert.strictEqual(verdict.ok, false, 'a hand-typed price was accepted');
    assert.match(verdict.why, /records no price provenance/);
  });

  test("a recorded sku that is not this listing's is refused", () => {
    const verdict = extractor.catalogRowPrice(pricedRow({ priceEvidence: priceEvidenceFor({ sku: '888888' }) }));
    assert.strictEqual(verdict.ok, false, "another product's provenance was accepted");
    assert.match(verdict.why, /not a code in this row's own listing URL/);
  });

  /* the one the whole block exists for */
  test('a price edited after it was verified stops accounting for itself', () => {
    const verdict = extractor.catalogRowPrice(pricedRow({ price: 42 }));
    assert.strictEqual(verdict.ok, false, 'an edited price kept its old provenance and passed');
    assert.match(verdict.why, /the row says 42 but its provenance says 89 was read/);
  });

  test('provenance in another currency is refused', () => {
    const verdict = extractor.catalogRowPrice(pricedRow({ priceEvidence: priceEvidenceFor({ currency: 'EUR' }) }));
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /recorded currency is EUR/);
  });

  test('provenance with no date is refused, because a price is only true on a day', () => {
    const evidence = priceEvidenceFor();
    delete evidence.asOf;
    const verdict = extractor.catalogRowPrice(pricedRow({ priceEvidence: evidence }));
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /no date/);
  });

  test('provenance of an unrecognised kind is refused', () => {
    const verdict = extractor.catalogRowPrice(pricedRow({ priceEvidence: priceEvidenceFor({ via: 'i-checked-by-hand' }) }));
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /no recognised kind/);
  });

  test("a recorded canonical must be this row's own listing", () => {
    const mine = extractor.catalogRowPrice(pricedRow({
      priceEvidence: { via: 'rendered price', canonical: LLBEAN, amount: 89, currency: 'USD', asOf: '2026-09-17' }
    }));
    assert.strictEqual(mine.ok, true, mine.why);

    const other = extractor.catalogRowPrice(pricedRow({
      priceEvidence: { via: 'rendered price', canonical: 'https://www.llbean.com/llb/shop/555555', amount: 89, currency: 'USD', asOf: '2026-09-17' }
    }));
    assert.strictEqual(other.ok, false, "another product's canonical was accepted");
  });

  test('a price on a row that links nowhere cannot be accounted for', () => {
    const verdict = extractor.catalogRowPrice({ id: 'x', productUrl: null, price: 42 });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.why, /links to no listing/);
  });

  test('a price that is not a number is refused however it is dressed', () => {
    for (const value of ['89', '$89', NaN, Infinity, -5, 0]) {
      const verdict = extractor.catalogRowPrice(pricedRow({ price: value }));
      assert.strictEqual(verdict.ok, false, `${JSON.stringify(String(value))} was accepted as a price`);
    }
  });

  /* ---------- writing a price down ---------- */
  console.log('\n  — writing the price back\n');

  test('writing a price fills the figure and the note that accounts for it', () => {
    const next = extractor.writePriceInto(source, 'llbean-venturestretch-chino', 89,
      { ok: true, via: 'json-ld-offer', sku: '129244', amount: 89, currency: 'USD' });
    const row = evaluate(next).find((r) => r.id === 'llbean-venturestretch-chino');
    assert.strictEqual(row.price, 89);
    assert.strictEqual(plain(row.priceEvidence).via, 'json-ld-offer');
    assert.strictEqual(plain(row.priceEvidence).amount, 89);
    assert.strictEqual(extractor.catalogRowPrice(row).ok, true, 'what it wrote must re-prove');
  });

  test('a price is never written without provenance to account for it', () => {
    assert.throws(
      () => extractor.writePriceInto(source, 'llbean-venturestretch-chino', 89, null),
      /no provenance/
    );
    assert.throws(
      () => extractor.writePriceInto(source, 'llbean-venturestretch-chino', 89,
        { ok: true, via: 'json-ld-offer', amount: 89, currency: 'USD' }),
      /no provenance/
    );
  });

  test('a figure that is not a price is refused rather than written', () => {
    for (const bad of [0, -5, 'free', null, 1e9]) {
      assert.throws(
        () => extractor.writePriceInto(source, 'llbean-venturestretch-chino', bad,
          { ok: true, via: 'json-ld-offer', sku: '129244', amount: 89, currency: 'USD' }),
        /refusing to write/,
        `${JSON.stringify(bad)} was written as a price`
      );
    }
  });

  test('the price note never lands on a neighbouring row', () => {
    const next = extractor.writePriceInto(source, 'llbean-venturestretch-chino', 89,
      { ok: true, via: 'json-ld-offer', sku: '129244', amount: 89, currency: 'USD' });
    const after = evaluate(next);
    for (const row of after.filter((r) => r.id !== 'llbean-venturestretch-chino')) {
      const before = rows.find((r) => r.id === row.id);
      assert.strictEqual(row.price, before.price, `${row.id} gained or lost a price`);
      assert.deepStrictEqual(plain(row.priceEvidence), plain(before.priceEvidence), `${row.id} gained or lost a note`);
    }
  });

  test('every row still normalises after a price write', () => {
    const next = extractor.writePriceInto(source, 'llbean-venturestretch-chino', 89.5,
      { ok: true, via: 'json-ld-offer', sku: '129244', amount: 89.5, currency: 'USD' });
    const after = evaluate(next);
    assert.strictEqual(after.length, rows.length, 'no row is lost');
    assert.strictEqual(after.find((r) => r.id === 'llbean-venturestretch-chino').price, 89.5,
      'cents survive the round trip');
  });

  /* a card that shows one product's photo over another's price is worse
     than a card that shows neither, so the write is all or nothing */
  test('a row takes its photo and its price together', () => {
    const next = extractor.writeRow(source, 'llbean-venturestretch-chino', {
      image: { url: 'https://cdni.llbean.net/is/image/wim/521659_32573_41', identity: { ok: true, via: 'json-ld-sku', sku: '129244' } },
      price: { amount: 89, identity: { ok: true, via: 'json-ld-offer', sku: '129244', amount: 89, currency: 'USD' } }
    });
    const row = evaluate(next).find((r) => r.id === 'llbean-venturestretch-chino');
    assert.strictEqual(row.price, 89);
    assert.match(row.imageUrl, /521659_32573_41/);
    assert.strictEqual(extractor.catalogRowIdentity(row).ok, true, 'the photo must re-prove');
    assert.strictEqual(extractor.catalogRowPrice(row).ok, true, 'the price must re-prove');
  });

  test('the price note never reaches a rendered product', () => {
    const Products = loadProductsLayer();
    const normalised = Products.normalizeProduct({
      id: 'x', name: 'A thing', brand: 'B', price: 89,
      imageUrl: 'https://h/i.jpg', productUrl: 'https://h/p',
      priceEvidence: { via: 'json-ld-offer', sku: '1', amount: 89, currency: 'USD', asOf: '2026-09-17' }
    });
    assert.ok(normalised, 'the record did not normalise at all');
    assert.strictEqual('priceEvidence' in normalised, false, 'the note leaked into the rendered record');
    assert.strictEqual(normalised.price, 89, 'the price itself must survive');
  });

  /* ---------- what the shipped catalogue is held to ---------- */

  test('every priced row that links to a listing accounts for its price', () => {
    for (const row of rows.filter((r) => r.productUrl && r.price != null)) {
      const verdict = extractor.catalogRowPrice(row);
      assert.strictEqual(verdict.ok, true, `${row.id}: ${verdict.why}`);
    }
  });

  /* a sample row's price is demo data. It may sit in the file, but it
     may never carry provenance, because there is no page it came off —
     that is what keeps "sample" and "verified" from blurring together */
  test('a row that links nowhere carries no price provenance', () => {
    for (const row of rows.filter((r) => !r.productUrl)) {
      assert.strictEqual(row.priceEvidence, undefined,
        `${row.id} claims provenance for a price with no listing behind it`);
    }
  });

  test('a row the hydrator has not filled carries null, not a guess', () => {
    for (const row of rows.filter((r) => r.productUrl)) {
      assert.ok(row.price === null || typeof row.price === 'number',
        `${row.id} holds ${JSON.stringify(row.price)} as a price`);
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

  /* ---------- giving a row a listing ----------

     A sample row names a garment nobody sells. Making it real means
     finding a listing, and the danger there is different from anything
     above: the candidate URL comes from outside, so it can be a
     comparison page, a redirector, or a perfectly good product page
     selling something else entirely. Each of those is offered here. */
  console.log('\n  — giving a row a listing\n');

  const tee = { id: 'sample-tee', name: 'Boxy Cotton Tee', brand: 'Northfold', category: 'tee' };

  test('a page selling the row\'s own garment is recognised', () => {
    const verdict = extractor.relevance(tee, { name: 'Heavyweight Boxy Cotton T-Shirt' });
    assert.strictEqual(verdict.ok, true, verdict.why);
  });

  test('a page selling something else entirely is refused', () => {
    const verdict = extractor.relevance(tee, { name: 'Merino Wool Crew Socks' });
    assert.strictEqual(verdict.ok, false, 'a pair of socks passed as a tee');
    assert.match(verdict.why, /which is not tee/);
  });

  /* the near miss, which is the one a search source actually produces */
  test('the right kind of garment with none of the row\'s words is refused', () => {
    const verdict = extractor.relevance(tee, { name: 'Slim Fit Pocket Tee' });
    assert.strictEqual(verdict.ok, false, 'a different tee passed as this one');
    assert.match(verdict.why, /too few to be the same garment/);
  });

  test('a page that names no product cannot become a row', () => {
    assert.strictEqual(extractor.relevance(tee, { name: '' }).ok, false);
    assert.strictEqual(extractor.relevance(tee, {}).ok, false);
  });

  test('a retailer product page is the only kind of link accepted', () => {
    assert.strictEqual(extractor.listingFault('https://www.jcrew.com/p/mens/shirt/AU763'), null);

    const refused = {
      'https://www.google.com/shopping/product/123': /indexes shops/,
      'https://encrypted-tbn0.gstatic.com/shopping?q=1': /indexes shops/,
      'https://shop.example.com/out?url=https://other.com/p/1': /redirect/,
      'https://shop.example.com/search': /not a product page/,
      'https://shop.example.com/': /not a product page/,
      'http://shop.example.com/p/1': /not a retailer product page/
    };
    for (const [href, why] of Object.entries(refused)) {
      assert.match(String(extractor.listingFault(href)), why, `${href} was accepted as a listing`);
    }
  });

  test('candidate listings are read from a file in either shape it arrives in', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-candidates-'));

    const asMap = path.join(dir, 'map.json');
    fs.writeFileSync(asMap, JSON.stringify({ 'sample-tee': ['https://a.com/p/1', 'https://a.com/p/2'] }));
    assert.deepStrictEqual(extractor.readCandidatesFile(asMap), {
      'sample-tee': ['https://a.com/p/1', 'https://a.com/p/2']
    });

    const asRows = path.join(dir, 'rows.json');
    fs.writeFileSync(asRows, JSON.stringify([{ id: 'sample-tee', url: 'https://a.com/p/1' }]));
    assert.deepStrictEqual(extractor.readCandidatesFile(asRows), { 'sample-tee': ['https://a.com/p/1'] });

    assert.deepStrictEqual(extractor.readCandidatesFile(null), {}, 'no file means no candidates, not a throw');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await testAsync('a row nobody offered a listing for is skipped, not failed', async () => {
    /* no candidates file and no search key: nothing was attempted, and
       reporting that as a failure would be blaming the catalogue for the
       operator not having configured a source */
    const found = await extractor.discoverListing(tee, {});
    assert.strictEqual(found.verdict, 'SKIPPED');
    assert.match(found.why, /no product search source is configured/);
  });

  await testAsync('a comparison page is refused before it is ever opened', async () => {
    const found = await extractor.discoverListing(tee, {
      'sample-tee': ['https://www.google.com/shopping/product/123']
    });
    assert.strictEqual(found.verdict, 'FAILED');
    assert.strictEqual(found.tried.length, 1);
    assert.match(found.tried[0].why, /indexes shops/);
    /* the link gate runs before anything is fetched, so a refusal here
       carries none of the notes a page read leaves behind. That absence
       is the evidence the aggregator was never opened. */
    assert.strictEqual(found.notes, undefined, 'the aggregator was opened anyway');
  });

  test('a replacement moves the price and its provenance with everything else', () => {
    const next = extractor.replaceRow(source, 'sample-northfold-boxy-cotton-tee', {
      productUrl: 'https://www.example-shop.com/p/AU763',
      name: 'Boxy Organic Cotton Tee',
      brand: 'Example',
      imageUrl: 'https://img.example-shop.com/AU763_WHITE.jpg',
      imageEvidence: { ok: true, via: 'image-url', code: 'au763' },
      price: 42.5,
      priceEvidence: { ok: true, via: 'json-ld-offer', sku: 'AU763', amount: 42.5, currency: 'USD' }
    });
    const row = evaluate(next).find((r) => r.id === 'sample-northfold-boxy-cotton-tee');

    assert.strictEqual(row.productUrl, 'https://www.example-shop.com/p/AU763');
    assert.strictEqual(row.name, 'Boxy Organic Cotton Tee');
    assert.strictEqual(row.brand, 'Example');
    assert.strictEqual(row.imageUrl, 'https://img.example-shop.com/AU763_WHITE.jpg');
    assert.strictEqual(row.price, 42.5);

    /* and the swapped row is held to the same bar as a shipped one */
    assert.strictEqual(extractor.catalogRowIdentity(row).ok, true, 'the photo must re-prove against the new listing');
    assert.strictEqual(extractor.catalogRowPrice(row).ok, true, 'the price must re-prove against the new listing');
  });

  test('a replaced row keeps the category its artwork is drawn from', () => {
    const next = extractor.replaceRow(source, 'sample-northfold-boxy-cotton-tee', {
      productUrl: 'https://www.example-shop.com/p/AU763',
      name: 'Boxy Organic Cotton Tee', brand: 'Example',
      imageUrl: 'https://img.example-shop.com/AU763_WHITE.jpg',
      price: 42.5,
      priceEvidence: { ok: true, via: 'json-ld-offer', sku: 'AU763', amount: 42.5, currency: 'USD' }
    });
    const before = rows.find((r) => r.id === 'sample-northfold-boxy-cotton-tee');
    const row = evaluate(next).find((r) => r.id === 'sample-northfold-boxy-cotton-tee');
    assert.strictEqual(row.category, before.category, 'the fallback artwork would change garment');
    assert.deepStrictEqual([...row.style], [...before.style], 'the row would leave its own filters');
  });

  /* ---------- what a re-run costs ---------- */
  console.log('\n  — a second run\n');

  test('a row that already accounts for itself needs nothing read again', () => {
    const row = {
      id: 'x', productUrl: LLBEAN, price: 89,
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41',
      imageEvidence: { via: 'json-ld-sku', sku: '129244' },
      priceEvidence: { via: 'json-ld-offer', sku: '129244', amount: 89, currency: 'USD', asOf: '2026-09-17' }
    };
    assert.deepStrictEqual(
      { image: extractor.accountedFor(row).image, price: extractor.accountedFor(row).price },
      { image: true, price: true });
  });

  test('a row whose price was edited is read again rather than trusted', () => {
    const row = {
      id: 'x', productUrl: LLBEAN, price: 42,
      imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41',
      imageEvidence: { via: 'json-ld-sku', sku: '129244' },
      priceEvidence: { via: 'json-ld-offer', sku: '129244', amount: 89, currency: 'USD', asOf: '2026-09-17' }
    };
    const state = extractor.accountedFor(row);
    assert.strictEqual(state.image, true, 'the photo is untouched and still holds');
    assert.strictEqual(state.price, false, 'an edited price was taken on trust');
    assert.match(state.priceWhy, /changed after it was verified/);
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
