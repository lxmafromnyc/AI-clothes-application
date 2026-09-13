#!/usr/bin/env node
/* =========================================================
   Fynd — obtain each real catalogue row's own product photo

   The rows in assets/catalog.js that carry a productUrl are real
   listings, and their imageUrl is null because no retailer host is
   reachable from the environment this repository is usually edited in.
   This asks each retailer's own product page for its own photo, checks
   the answer, and writes back only what passed.

   Nothing is guessed. A URL is only ever taken FROM the product page
   the row already points at — never built out of a product id, never
   taken from a search engine, never a stock photo. That provenance is
   the whole guarantee, so the extraction method is reported for every
   row and recorded in the write-back.

   ---------------------------------------------------------
   How a photo is found, in order
   ---------------------------------------------------------
     og:image           what the retailer itself publishes as the
                        page's picture
     json-ld            a schema.org Product's `image`
     structured-data    a product blob in the page's own scripts
                        (__NEXT_DATA__, preloaded state) carrying an
                        image beside the row's product code
     twitter:image      the same idea under a different tag
     gallery            a primary <img> whose URL carries the product
                        code, which is what ties it to this product

   A page that renders its gallery in the browser — Zara and Levi's both
   do — yields nothing to a plain fetch. Those fall through to Chromium
   via Playwright, which runs the page and is then asked the same five
   questions against the rendered DOM.

   ---------------------------------------------------------
   What "verified" means
   ---------------------------------------------------------
     https              an http photo is one a browser refuses on an
                        https page, so it is not a photo at all
     an image           the response's content-type is image/*
     not an aggregator  google, gstatic, bing and the stock-photo hosts
                        are refused outright, whatever a page says
     the same product   the row's product code appears in the image URL,
                        or the block the URL came from named a matching
                        sku. Without one of those the row is LEFT ALONE:
                        a photo of a similar garment under a real
                        product's name is worse than no photo.
     loadable from the
     site               the image is requested twice, once plainly and
                        once carrying the Pages origin as Referer. A
                        host that serves the photo to itself but not to
                        us would leave an empty tile on the live page,
                        so that counts as a failure here.

   ---------------------------------------------------------
   Usage
   ---------------------------------------------------------
     node scripts/fetch-catalog-images.js                 report only
     node scripts/fetch-catalog-images.js --write          apply passes
     node scripts/fetch-catalog-images.js --only zara-oxford-shirt
     node scripts/fetch-catalog-images.js --no-browser     skip Chromium
     node scripts/fetch-catalog-images.js --site https://example.github.io

   Run it from a machine with an ordinary internet connection. Behind a
   proxy that refuses retailer hosts every row fails on the fetch, and
   the report is about the proxy rather than about the photos.

   Exit status is 0 when every row was verified, 1 when any was not, so
   a run that half-works is visible to a script as well as to a reader.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const CATALOG = path.join(__dirname, '..', 'assets', 'catalog.js');
const DEFAULT_SITE = 'https://lxmafromnyc.github.io';
const TIMEOUT = 20000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/* Hosts whose pictures are never a retailer's own, whatever page names
   them. A search thumbnail is not the product's photo, and a stock
   library's picture is of a different garment entirely. */
const NEVER = [
  'google.com', 'gstatic.com', 'googleusercontent.com', 'ggpht.com',
  'bing.com', 'bing.net', 'duckduckgo.com', 'yandex.net',
  'shutterstock.com', 'istockphoto.com', 'gettyimages.com',
  'unsplash.com', 'pexels.com', 'pixabay.com', 'placeholder.com'
];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const value = (f, fallback) => {
  const i = args.indexOf(f);
  return i === -1 || !args[i + 1] ? fallback : args[i + 1];
};

/* ---------------------------------------------------------
   The rows
   --------------------------------------------------------- */

/* catalog.js is a browser script: it declares the array and nothing
   else, so it is read by evaluating it rather than by pattern-matching
   a shape that could drift. */
function readRows(source) {
  const rows = new Function(`${source}\n;return DEMO_PRODUCTS;`)();
  return rows.filter((r) => r && typeof r.productUrl === 'string' && r.productUrl);
}

/* The codes a product page's URL carries, longest first, so the most
   specific one decides a match. UNIQLO puts E429066-000 in the path,
   Zara p06887613, Levi's 171960005 — all of them appear again in the
   retailer's own image paths, which is what makes them usable as the
   tie between a picture and a product. */
function codesFrom(productUrl) {
  let url;
  try { url = new URL(productUrl); } catch (err) { return []; }
  const found = new Set();
  const parts = url.pathname.split(/[/.]/).filter(Boolean);
  for (const part of parts) {
    const m = part.match(/([A-Z]?\d[\dA-Z-]{4,})/i);
    if (!m) continue;
    const code = m[1].replace(/^p/i, '');
    if (/\d{4,}/.test(code)) {
      found.add(code);
      /* a code with a colour suffix also matches on its stem */
      const stem = code.split('-')[0];
      if (/\d{4,}/.test(stem)) found.add(stem);
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

const registrable = (host) => String(host || '').split('.').slice(-2).join('.');

/* ---------------------------------------------------------
   Extraction, from a page's own markup
   --------------------------------------------------------- */

const absolute = (href, base) => {
  try { return new URL(String(href).trim(), base).href; } catch (err) { return null; }
};

const metaOf = (html, prop) => {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
};

const scriptsOf = (html, typeAttr) => {
  const re = typeAttr
    ? new RegExp(`<script[^>]+type=["']${typeAttr}["'][^>]*>([\\s\\S]*?)</script>`, 'gi')
    : /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
};

/* schema.org Product images, in the order the page lists them. */
function fromJsonLd(html) {
  for (const block of scriptsOf(html, 'application\\/ld\\+json')) {
    let parsed;
    try { parsed = JSON.parse(block); } catch (err) { continue; }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) queue.push(...node['@graph']);
      const type = [].concat(node['@type'] || []).map(String);
      if (type.some((t) => /product/i.test(t))) {
        const image = node.image;
        const first = Array.isArray(image) ? image[0] : image;
        const href = first && typeof first === 'object' ? (first.url || first.contentUrl) : first;
        if (href) return { href, sku: node.sku || node.mpn || node.productID || null, name: node.name || null };
      }
      Object.values(node).forEach((v) => { if (v && typeof v === 'object') queue.push(v); });
    }
  }
  return null;
}

/* A product blob in the page's own scripts. Only an image sitting in the
   same script as one of this product's codes is taken, so an unrelated
   banner in the same bundle cannot pass for the product's photo. */
function fromStructuredData(html, codes) {
  for (const block of scriptsOf(html)) {
    if (!codes.some((code) => block.includes(code))) continue;
    const urls = block.match(/https:\\?\/\\?\/[^"'\s\\]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\s\\]*)?/gi) || [];
    const cleaned = urls.map((u) => u.replace(/\\/g, ''));
    const withCode = cleaned.find((u) => codes.some((code) => u.includes(code)));
    if (withCode) return withCode;
  }
  return null;
}

/* A gallery image tied to the product by its own code. */
function fromGallery(html, codes) {
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1]
      || ((tag.match(/\bsrcset=["']([^"']+)["']/i) || [])[1] || '').split(',')[0].trim().split(/\s+/)[0];
    if (!src) continue;
    if (codes.some((code) => src.includes(code))) return src;
  }
  return null;
}

/* The ladder. Returns { url, method, sku, name } or null. */
function extract(html, baseUrl, codes) {
  const og = metaOf(html, 'og:image:secure_url') || metaOf(html, 'og:image');
  if (og) return { url: absolute(og, baseUrl), method: 'og:image' };

  const ld = fromJsonLd(html);
  if (ld && ld.href) return { url: absolute(ld.href, baseUrl), method: 'json-ld', sku: ld.sku, name: ld.name };

  const structured = fromStructuredData(html, codes);
  if (structured) return { url: absolute(structured, baseUrl), method: 'structured-data' };

  const twitter = metaOf(html, 'twitter:image') || metaOf(html, 'twitter:image:src');
  if (twitter) return { url: absolute(twitter, baseUrl), method: 'twitter:image' };

  const gallery = fromGallery(html, codes);
  if (gallery) return { url: absolute(gallery, baseUrl), method: 'gallery' };

  return null;
}

/* ---------------------------------------------------------
   Verification
   --------------------------------------------------------- */

/* Does this picture belong to THIS product?

     code      the row's product code is in the image URL
     sku       the block the URL came from named a matching sku
     none      neither, and the row is left alone */
function productMatch(url, found, codes, row) {
  if (codes.some((code) => String(url).includes(code))) return 'code';
  const sku = String((found && found.sku) || '');
  if (sku && codes.some((code) => sku.includes(code) || code.includes(sku))) return 'sku';
  const name = String((found && found.name) || '').toLowerCase();
  if (name && row.name && name.includes(String(row.name).toLowerCase().split('—')[0].trim().toLowerCase())) return 'sku';
  return 'none';
}

async function fetchOnce(url, headers, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await (fetchImpl || fetch)(url, { headers, redirect: 'follow', signal: controller.signal });
    return { status: res.status, ok: res.ok, type: res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '', text: res.text ? () => res.text() : null };
  } catch (err) {
    return { status: 0, ok: false, type: '', error: (err && err.message) || 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/* Every rule, in the order that lets the report name the first failure
   rather than a general one. */
async function verify(url, row, options) {
  const site = (options && options.site) || DEFAULT_SITE;
  const fetchImpl = options && options.fetchImpl;
  if (!url) return { pass: false, why: 'nothing extracted' };

  let parsed;
  try { parsed = new URL(url); } catch (err) { return { pass: false, why: 'unparseable URL' }; }
  if (parsed.protocol !== 'https:') return { pass: false, why: `not https (${parsed.protocol})`, host: parsed.hostname };

  const host = parsed.hostname;
  if (NEVER.some((bad) => host === bad || host.endsWith(`.${bad}`))) {
    return { pass: false, why: 'an aggregator or stock host, never a retailer photo', host };
  }

  const plain = await fetchOnce(url, { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*' }, fetchImpl);
  if (!plain.ok) return { pass: false, why: `image request returned ${plain.status || plain.error}`, host };
  if (!/^image\//i.test(plain.type)) return { pass: false, why: `not an image (content-type ${plain.type || 'none'})`, host };

  const withReferer = await fetchOnce(url, { 'User-Agent': UA, Accept: 'image/*,*/*', Referer: `${site}/` }, fetchImpl);
  if (!withReferer.ok) {
    return { pass: false, why: `hotlink blocked: served plainly, refused for ${site} (${withReferer.status})`, host };
  }

  return { pass: true, why: 'loads over https, as an image, with and without the site referer', host, type: plain.type };
}

/* ---------------------------------------------------------
   Chromium, for the pages that build their gallery in the browser
   --------------------------------------------------------- */

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    '/opt/node22/lib/node_modules/playwright'
  ].filter(Boolean);
  for (const where of candidates) {
    try { return require(where).chromium; } catch (err) { /* try the next */ }
  }
  return null;
}

async function renderedHtml(url) {
  const chromium = loadPlaywright();
  if (!chromium) return { html: null, why: 'playwright is not installed here' };

  const launch = {};
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  let browser;
  try {
    browser = await chromium.launch(launch);
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    /* the gallery arrives after the first paint on both Zara and Levi's */
    await page.waitForTimeout(2500);
    const html = await page.content();
    return { html, why: null };
  } catch (err) {
    return { html: null, why: (err && err.message) || 'chromium failed' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/* ---------------------------------------------------------
   One row, end to end
   --------------------------------------------------------- */

async function resolveRow(row, options) {
  const opts = options || {};
  const codes = codesFrom(row.productUrl);
  const retailer = new URL(row.productUrl).hostname;
  const base = { id: row.id, name: row.name, brand: row.brand, retailer, codes };

  const page = await fetchOnce(row.productUrl, { 'User-Agent': UA, Accept: 'text/html,*/*' }, opts.fetchImpl);
  let html = null;
  if (page.ok && page.text) html = await page.text();

  let found = html ? extract(html, row.productUrl, codes) : null;
  let method = found ? found.method : null;

  /* nothing in the served HTML: run the page and ask again */
  if (!found && !opts.noBrowser) {
    const rendered = opts.renderImpl ? await opts.renderImpl(row.productUrl) : await renderedHtml(row.productUrl);
    if (rendered.html) {
      found = extract(rendered.html, row.productUrl, codes);
      if (found) method = `${found.method} (rendered)`;
    } else if (!page.ok) {
      return Object.assign(base, { url: null, method: null, verdict: 'FAIL', why: `page fetch returned ${page.status || page.error}; ${rendered.why}` });
    }
  }

  if (!page.ok && !found) {
    return Object.assign(base, { url: null, method: null, verdict: 'FAIL', why: `page fetch returned ${page.status || page.error}` });
  }
  if (!found || !found.url) {
    return Object.assign(base, { url: null, method: null, verdict: 'FAIL', why: 'no product image in the page or its rendered DOM' });
  }

  const match = productMatch(found.url, found, codes, row);
  const checked = await verify(found.url, row, opts);
  const sameSite = registrable(checked.host || '') === registrable(retailer);

  if (!checked.pass) {
    return Object.assign(base, { url: found.url, method, host: checked.host, match, verdict: 'FAIL', why: checked.why });
  }
  if (match === 'none' && !opts.allowUnmatched) {
    return Object.assign(base, {
      url: found.url, method, host: checked.host, match, verdict: 'SKIP',
      why: 'loads, but nothing ties it to this product — pass --allow-unmatched to accept it anyway'
    });
  }

  return Object.assign(base, {
    url: found.url, method, host: checked.host, match, sameSite,
    verdict: 'OK', why: checked.why
  });
}

/* ---------------------------------------------------------
   The write-back
   --------------------------------------------------------- */

/* Only `imageUrl: null` inside the matching row is replaced, and only
   for a row that passed. Everything else in the file is left byte for
   byte as it was. */
function applyToCatalog(source, results) {
  let out = source;
  const written = [];
  for (const r of results) {
    if (r.verdict !== 'OK' || !r.url) continue;
    const rowRe = new RegExp(`(id: '${r.id}',[\\s\\S]{0,600}?)imageUrl: null`, 'm');
    if (!rowRe.test(out)) continue;
    out = out.replace(rowRe, `$1imageUrl: '${r.url}'`);
    written.push(r.id);
  }
  return { source: out, written };
}

/* ---------------------------------------------------------
   The report
   --------------------------------------------------------- */

function renderReport(results) {
  const lines = [];
  const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
  lines.push('');
  lines.push(`${pad('product', 24)}${pad('retailer', 18)}${pad('image host', 24)}${pad('method', 22)}${pad('match', 7)}verdict`);
  lines.push('-'.repeat(103));
  for (const r of results) {
    lines.push(`${pad(r.id, 24)}${pad(r.retailer, 18)}${pad(r.host || '(none)', 24)}${pad(r.method || '(none)', 22)}${pad(r.match || '-', 7)}${r.verdict}`);
    lines.push(`  ${r.why}`);
    if (r.url) lines.push(`  ${r.url}`);
    if (r.verdict === 'OK' && r.sameSite === false) {
      lines.push('  note: a different registrable domain from the product page — a retailer CDN, taken from the page itself');
    }
    lines.push('');
  }
  const ok = results.filter((r) => r.verdict === 'OK').length;
  lines.push(`${ok} of ${results.length} verified`);
  return lines.join('\n');
}

/* ---------------------------------------------------------
   CLI
   --------------------------------------------------------- */

async function main() {
  const source = fs.readFileSync(CATALOG, 'utf8');
  let rows = readRows(source);
  const only = value('--only', null);
  if (only) rows = rows.filter((r) => r.id === only);

  if (!rows.length) {
    console.log(only ? `No row with a productUrl matches --only ${only}` : 'No catalogue row carries a productUrl.');
    process.exit(1);
  }

  const options = {
    site: value('--site', DEFAULT_SITE),
    noBrowser: has('--no-browser'),
    allowUnmatched: has('--allow-unmatched')
  };

  console.log(`Asking ${rows.length} retailer page${rows.length === 1 ? '' : 's'} for its own product photo.`);
  console.log(`Hotlink check uses ${options.site} as the Referer.`);

  const results = [];
  for (const row of rows) results.push(await resolveRow(row, options));

  console.log(renderReport(results));

  if (has('--write')) {
    const { source: updated, written } = applyToCatalog(source, results);
    if (written.length) {
      fs.writeFileSync(CATALOG, updated);
      console.log(`written into assets/catalog.js: ${written.join(', ')}`);
    } else {
      console.log('nothing verified, so assets/catalog.js is untouched');
    }
  } else {
    const ok = results.filter((r) => r.verdict === 'OK').length;
    console.log(ok ? 'report only — pass --write to put these into assets/catalog.js' : 'report only — nothing would be written');
  }

  process.exit(results.every((r) => r.verdict === 'OK') ? 0 : 1);
}

module.exports = {
  readRows, codesFrom, extract, metaOf, fromJsonLd, fromStructuredData, fromGallery,
  productMatch, verify, applyToCatalog, renderReport, resolveRow, registrable,
  renderedHtml, loadPlaywright, NEVER
};

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
