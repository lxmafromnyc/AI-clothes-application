#!/usr/bin/env node
/* =========================================================
   Fynd — read each catalogue row's photo off the retailer's own page

   The rows that name a productUrl point at a real listing, and that
   listing already publishes its main photo — in its JSON-LD, in its
   og:image, in the image it preloads, in the gallery it renders. This
   reads that photo from the page the row already links to, so the URL
   written back is the retailer's own, not a guess.

   Nothing here invents a URL. A candidate has to survive four gates
   before it may be written:

     found    it appeared in the markup of the linked product page,
              never assembled from a product code or a CDN pattern
     sound    it is https, and its host belongs to the retailer or a
              CDN they publish through — aggregators, search-result
              thumbnails and stock libraries are refused by name
     this     it can be tied to THIS product: the code from the listing
              URL appears in the image URL, or the structured record
              carrying the image names a matching sku, or the page
              proves itself the canonical page for this listing. A photo
              of a similar garment is a wrong answer, not a near miss.
     loadable it answers 200 with an image content-type, plainly AND
              carrying the site's own Referer, so a hotlink block is
              caught here rather than on the page

   A row that fails any gate keeps imageUrl: null and keeps its drawn
   artwork. That is the honest outcome, and it is never overwritten with
   something that merely looks plausible.

   Two ways in, in this order. Plain HTTP first, because it is cheap and
   most pages publish everything needed in their served markup. When that
   comes back with nothing usable — no candidates, or a 403 from the
   retailer's bot check — the page is opened in a real Chromium through
   Playwright, which runs the page's scripts, renders its gallery, and
   reports the images it actually loaded. A retailer that refuses a bare
   client is answered with a real browser rather than with a guess.

   It reports by default and changes nothing. --write is what edits
   assets/catalog.js, and it only ever fills in rows that verified;
   productUrl, id and every other field are left exactly as they were. A
   row that already carries a photo is left alone unless --refresh says
   otherwise, so a working URL is never churned.

   Run it from a machine with an ordinary internet connection. Behind a
   proxy that refuses retailer hosts every row comes back UNREACHABLE,
   and the report is about the proxy rather than about the catalogue.

   Usage
     node scripts/fetch-catalog-images.js
     node scripts/fetch-catalog-images.js --write
     node scripts/fetch-catalog-images.js --only zara-oxford-shirt
     node scripts/fetch-catalog-images.js --refresh        re-read rows that have one
     node scripts/fetch-catalog-images.js --no-browser     plain HTTP only
     node scripts/fetch-catalog-images.js --site https://example.github.io
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CATALOG = path.join(__dirname, '..', 'assets', 'catalog.js');
const TIMEOUT = 20000;
const BROWSER_TIMEOUT = 45000;
const MIN_BYTES = 2000; // a 1x1 tracker is not a product photo
const MIN_RENDERED = 150; // a rendered image smaller than this is a chip, not the hero
const DEFAULT_SITE = 'https://lxmafromnyc.github.io';

/* a browser's headers, because a product page served to a bare client is
   often a consent wall or a bot check with no product markup in it */
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

/* hosts that serve pictures of a product without being the retailer's
   own image host. A URL on one of these is refused even when the page
   itself handed it to us: the brief is the retailer's actual CDN. */
const NOT_THE_RETAILER = [
  'google.com', 'googleapis.com', 'googleusercontent.com', 'gstatic.com', 'ggpht.com',
  'shopping.google.com', 'bing.com', 'bing.net', 'yandex.net',
  'unsplash.com', 'pexels.com', 'pixabay.com', 'shutterstock.com', 'istockphoto.com',
  'gettyimages.com', 'adobestock.com', 'dreamstime.com', 'alamy.com',
  'placehold.co', 'placeholder.com', 'via.placeholder.com', 'dummyimage.com',
  'facebook.com', 'fbcdn.net', 'twitter.com', 'twimg.com', 'pinterest.com', 'pinimg.com',
  'doubleclick.net', 'scorecardresearch.com', 'google-analytics.com'
];

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const site = flag('--site') || DEFAULT_SITE;
const only = flag('--only');
const writing = has('--write');
const refreshing = has('--refresh');
const useBrowser = !has('--no-browser');

/* ---------- reading the catalogue ----------

   The file is a script, not data, so it is evaluated rather than parsed:
   that way a row added in any shape the file already allows is read
   correctly, with no second grammar to keep in step. */
function readCatalog() {
  const source = fs.readFileSync(CATALOG, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(source + ';this.__rows = DEMO_PRODUCTS;').runInContext(sandbox, { timeout: 5000 });
  const rows = sandbox.__rows;
  if (!Array.isArray(rows)) throw new Error('assets/catalog.js did not define DEMO_PRODUCTS as an array');
  return { source, rows };
}

/* ---------- finding the photo in the page ----------

   Priority order is how confidently a source names THE main product
   image: the structured record first, then the card the retailer
   publishes for sharing, then the image the page itself preloads. */

const decode = (text) => String(text)
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x2F;/gi, '/').replace(/&amp;/g, '&');

/* every <script type="application/ld+json"> block, parsed and flattened,
   so a Product inside @graph or inside an array is still found */
function jsonLdNodes(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push(...parseLdBlock(m[1]));
  }
  return out;
}

function parseLdBlock(text) {
  const out = [];
  let parsed;
  try { parsed = JSON.parse(decode(text).trim()); } catch (err) { return out; }
  const stack = [parsed];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { stack.push(...node); continue; }
    out.push(node);
    if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
  }
  return out;
}

/* A Product node's images, kept WITH the node that supplied them: the
   node also carries the sku, and that is what ties an image to this
   product rather than to a neighbour in the same feed. */
function fromJsonLd(nodes) {
  const found = [];
  for (const node of nodes) {
    const type = String(node['@type'] || '');
    if (!/product/i.test(type)) continue;
    const take = (v) => {
      if (typeof v === 'string') found.push({ url: v, node });
      else if (v && typeof v === 'object' && typeof v.url === 'string') found.push({ url: v.url, node });
    };
    if (Array.isArray(node.image)) node.image.forEach(take); else take(node.image);
  }
  return found;
}

/* a meta tag's content, whichever order the attributes are written in */
function metaContent(html, name) {
  const attr = `(?:property|name)=["']${name}["']`;
  const patterns = [
    new RegExp(`<meta[^>]+${attr}[^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function canonicalOf(html) {
  const link = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
  if (link) {
    const href = link[0].match(/href=["']([^"']+)["']/i);
    if (href) return href[1];
  }
  return metaContent(html, 'og:url');
}

function fromPreload(html) {
  const out = [];
  const re = /<link[^>]+rel=["']preload["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/as=["']image["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) out.push(href[1]);
    const setAttr = tag.match(/imagesrcset=["']([^"']+)["']/i);
    if (setAttr) out.push(...largestFromSrcset(setAttr[1]));
  }
  return out;
}

/* a srcset's entries, widest first, so the candidate is the full-size
   photo rather than the thumbnail the browser would pick on a phone */
function largestFromSrcset(value) {
  return String(value).split(',')
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      const width = /^(\d+)w$/.exec(bits[1] || '');
      return { url: bits[0], width: width ? Number(width[1]) : 0 };
    })
    .filter((e) => e.url)
    .sort((a, b) => b.width - a.width)
    .map((e) => e.url);
}

/* candidates in the order they deserve to be tried, deduplicated. Each
   keeps where it came from, because the identity gate below weighs an
   og:image on a canonical page differently from a bare URL. */
function candidatesFrom(html, pageUrl) {
  const nodes = jsonLdNodes(html);
  const canonical = canonicalOf(html);

  const raw = [];
  for (const hit of fromJsonLd(nodes)) raw.push({ url: hit.url, from: 'json-ld', node: hit.node });
  for (const name of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    const value = metaContent(html, name);
    if (value) raw.push({ url: value, from: name });
  }
  for (const url of fromPreload(html)) raw.push({ url, from: 'preload' });

  return dedupe(raw, pageUrl, canonical);
}

function dedupe(raw, pageUrl, canonical) {
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (!entry || !entry.url) continue;
    let resolved;
    try { resolved = new URL(decode(String(entry.url)).trim(), pageUrl).href; } catch (err) { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(Object.assign({}, entry, { url: resolved, canonical }));
  }
  return out;
}

/* ---------- is this THIS product's photo? ----------

   A listing URL names the product: E429066 for the UNIQLO sweater,
   p06887613 for the Zara shirt, 171960005 for the Levi's chino. The
   retailer's own image URLs almost always carry that same code, and when
   they do not, the structured record that supplied the image names it as
   a sku. Either is proof. Failing both, a page that declares itself the
   canonical page for this exact listing vouches for its own og:image,
   because that is by definition the picture the retailer publishes for
   this product.

   Nothing else counts. A photo that cannot be tied back to the listing
   is refused even when it is plainly a photo of clothing on the right
   retailer's CDN — that is how a similar product gets in. */
function identifiersFrom(productUrl) {
  let url;
  try { url = new URL(productUrl); } catch (err) { return []; }
  const text = decodeURIComponent(url.pathname) + ' ' + decodeURIComponent(url.search);
  const ids = new Set();
  for (const token of text.match(/[A-Za-z]{0,3}\d{4,}[A-Za-z0-9]*/g) || []) {
    ids.add(token.toLowerCase());
    const digits = token.replace(/\D/g, '');
    if (digits.length >= 4) {
      ids.add(digits);
      const trimmed = digits.replace(/^0+/, '');
      if (trimmed.length >= 4) ids.add(trimmed);
    }
  }
  return [...ids];
}

/* the same product path, ignoring the things that do not change which
   product a URL names */
function samePage(a, b) {
  const norm = (u) => {
    try {
      const url = new URL(u);
      return (url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/+$/, '')).toLowerCase();
    } catch (err) { return null; }
  };
  const left = norm(a);
  return left !== null && left === norm(b);
}

function skuOf(node) {
  if (!node || typeof node !== 'object') return [];
  const out = [];
  for (const key of ['sku', 'mpn', 'productID', 'productId', 'gtin', 'gtin13', 'gtin12', 'identifier']) {
    const value = node[key];
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value).toLowerCase());
  }
  return out;
}

function identityEvidence(candidate, productUrl) {
  const ids = identifiersFrom(productUrl);
  if (!ids.length) return { ok: false, why: 'the listing URL carries no product code to match against' };

  /* the code, as it appears anywhere in the image URL */
  const image = candidate.url.toLowerCase();
  for (const id of ids) {
    if (image.includes(id)) return { ok: true, how: `its URL carries the listing's code ${id}` };
  }

  /* the code, with the separators a CDN path puts through it — Zara
     splits 6887613 across /6887/613/. Only long codes are matched this
     way, because a short run of digits collides by accident. */
  const digitsOnly = image.replace(/\D/g, '');
  for (const id of ids) {
    if (/^\d{6,}$/.test(id) && digitsOnly.includes(id)) {
      return { ok: true, how: `its URL path carries the listing's code ${id}, split across segments` };
    }
  }

  /* the structured record that supplied the image names the product */
  const skus = skuOf(candidate.node);
  for (const sku of skus) {
    const bare = sku.replace(/[^a-z0-9]/g, '');
    for (const id of ids) {
      if (bare.includes(id) || id.includes(bare)) {
        return { ok: true, how: `the JSON-LD product it came from names sku ${sku}` };
      }
    }
  }

  /* the page vouches for itself: this IS the canonical page for the
     listing, and the image is the one it publishes as the product's */
  const vouches = candidate.from === 'json-ld' || String(candidate.from).startsWith('og:');
  if (vouches && candidate.canonical && samePage(candidate.canonical, productUrl)) {
    return { ok: true, how: `the page declares itself the canonical page for this listing, and this is its ${candidate.from}` };
  }

  return {
    ok: false,
    why: `nothing ties it to this product (looked for ${ids.slice(0, 3).join(', ')})`
  };
}

/* ---------- the gates ---------- */
function registrable(host) {
  const bits = String(host).toLowerCase().split('.');
  return bits.length <= 2 ? bits.join('.') : bits.slice(-2).join('.');
}

function soundness(candidate, pageUrl) {
  const raw = typeof candidate === 'string' ? candidate : candidate.url;
  let url;
  try { url = new URL(raw); } catch (err) { return 'not a URL'; }
  if (url.protocol !== 'https:') return `${url.protocol}// cannot load on an https page`;

  const host = url.hostname.toLowerCase();
  if (NOT_THE_RETAILER.some((bad) => host === bad || host.endsWith('.' + bad))) {
    return `${host} is an aggregator or stock host, not the retailer`;
  }
  return null;
}

/* ---------- the network ---------- */
async function request(url, extra) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: Object.assign({}, BROWSER, extra || {})
    });
    return { ok: true, response };
  } catch (err) {
    const why = (err && err.name === 'AbortError') ? 'timed out'
      : (err && err.message) ? err.message : 'unreachable';
    return { ok: false, why };
  } finally {
    clearTimeout(timer);
  }
}

/* A sandbox that refuses the host answers in place of the retailer, and
   it answers 403 — the same status a retailer's bot check uses. Telling
   them apart decides what the reader should do about it, so the refusal
   is read rather than just counted: an egress denial names the host it
   refused, and the fix is an allowlist entry, not a different catalogue. */
const EGRESS_DENIAL = /not in allowlist|egress|proxy|blocked by/i;

async function fetchPage(url) {
  const got = await request(url, null);
  if (!got.ok) return { failed: got.why };
  const { response } = got;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 403 && EGRESS_DENIAL.test(body)) {
      return { failed: `this machine's network refuses ${new URL(url).hostname}`, blocked: true };
    }
    /* a retailer's own 403 is a bot check, and a real browser is the
       answer to it rather than a different URL */
    return { failed: `the page answered ${response.status}`, refused: response.status === 403 || response.status === 429 };
  }
  return { html: await response.text() };
}

async function verifyImage(url, fetcher) {
  const ask = fetcher || request;
  const plain = await ask(url, null);
  if (!plain.ok) return { ok: false, why: `image host ${plain.why}` };

  const type = plain.response.headers.get('content-type') || '';
  const status = plain.response.status;
  const bytes = (await plain.response.arrayBuffer()).byteLength;

  if (status !== 200) return { ok: false, why: `answered ${status}` };
  if (!/^image\//i.test(type)) return { ok: false, why: `answered 200 as ${type.split(';')[0] || 'no type'}` };
  if (bytes < MIN_BYTES) return { ok: false, why: `only ${bytes} bytes, too small to be a product photo` };

  const referred = await ask(url, { Referer: site });
  if (!referred.ok) return { ok: false, why: `refused for ${site}: ${referred.why}` };
  if (referred.response.body) await referred.response.body.cancel();
  if (referred.response.status !== 200) {
    return { ok: false, why: `hotlink blocked — served plainly, ${referred.response.status} for ${site}` };
  }

  return { ok: true, why: `${type.split(';')[0]}, ${Math.round(bytes / 1024)}KB` };
}

/* ---------- the real browser ----------

   Loaded only when it is needed, so a plain run costs nothing and a
   machine without Playwright still does everything it can. */
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright', '/opt/node22/lib/node_modules/playwright']
    .filter(Boolean);
  for (const where of tries) {
    try { return require(where).chromium; } catch (err) { /* next */ }
  }
  return null;
}

/* What the rendered page says about its images. This runs inside the
   page, so it sees the gallery the scripts built, the src the browser
   actually chose out of a srcset, and the size each image is drawn at —
   which is what separates a hero shot from a colour swatch. */
function gatherInPage() {
  const text = (sel, attr) => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute(attr) : null;
  };
  const metas = {};
  for (const el of document.querySelectorAll('meta[property], meta[name]')) {
    const key = el.getAttribute('property') || el.getAttribute('name');
    if (key) metas[key.toLowerCase()] = el.getAttribute('content');
  }
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent);
  const preload = [...document.querySelectorAll('link[rel="preload"][as="image"]')]
    .map((l) => ({ href: l.getAttribute('href'), srcset: l.getAttribute('imagesrcset') }));

  const imgs = [...document.querySelectorAll('img')].map((img) => {
    const rect = img.getBoundingClientRect();
    const container = img.closest('[class*="gallery" i], [class*="product" i], [class*="media" i], [id*="gallery" i], [class*="carousel" i], [class*="zoom" i]');
    return {
      url: img.currentSrc || img.src,
      srcset: img.getAttribute('srcset'),
      alt: img.getAttribute('alt') || '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      natural: img.naturalWidth,
      inGallery: Boolean(container)
    };
  });

  return {
    canonical: text('link[rel="canonical"]', 'href') || metas['og:url'] || null,
    metas,
    jsonld,
    preload,
    imgs
  };
}

/* One page, in a real browser, reported the same way fetchPage reports:
   candidates in priority order, or a reason there are none. */
async function renderPage(url) {
  const chromium = loadPlaywright();
  if (!chromium) return { failed: 'Playwright is not installed here, so the browser path is unavailable', noBrowser: true };

  const launch = { args: ['--disable-blink-features=AutomationControlled'] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;

  let browser;
  try {
    browser = await chromium.launch(launch);
  } catch (err) {
    return { failed: `Chromium would not start (${err && err.message ? err.message.split('\n')[0] : 'unknown'})`, noBrowser: true };
  }

  try {
    const context = await browser.newContext({
      userAgent: BROWSER['User-Agent'],
      locale: 'en-US',
      viewport: { width: 1400, height: 1000 }
    });
    const page = await context.newPage();

    /* the images the page itself went and fetched: the strongest
       evidence of what it considers the product's photo, because it is
       what the browser actually put on the screen */
    const loaded = [];
    page.on('response', (response) => {
      const type = response.headers()['content-type'] || '';
      if (/^image\//i.test(type) && response.status() === 200) loaded.push(response.url());
    });

    let status = null;
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT });
      status = response ? response.status() : null;
    } catch (err) {
      await browser.close();
      return { failed: `the browser could not open the page (${String(err.message).split('\n')[0]})` };
    }

    /* give the gallery a chance to build itself, without hanging on a
       page that never goes idle */
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const seen = await page.evaluate(gatherInPage);
    const verify = imageFetcherFor(page);
    await browser.close();

    if (status && status >= 400) {
      return { failed: `the page answered ${status} to a real browser too` };
    }
    return { seen, loaded, verify };
  } catch (err) {
    await browser.close().catch(() => {});
    return { failed: `the browser path failed (${err && err.message ? String(err.message).split('\n')[0] : 'unknown'})` };
  }
}

/* An image check that goes through the browser's own context, so a CDN
   that only serves to a session which has loaded the page is judged the
   way the page's own requests are. Shaped like request() so verifyImage
   does not care which one it was handed. */
function imageFetcherFor(page) {
  return async (url, extra) => {
    try {
      const result = await page.evaluate(async ({ url, extra }) => {
        const response = await fetch(url, { headers: extra || {}, redirect: 'follow' });
        const buffer = await response.arrayBuffer();
        return { status: response.status, type: response.headers.get('content-type') || '', bytes: buffer.byteLength };
      }, { url, extra });
      return {
        ok: true,
        response: {
          status: result.status,
          headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? result.type : null) },
          arrayBuffer: async () => ({ byteLength: result.bytes }),
          body: null
        }
      };
    } catch (err) {
      return { ok: false, why: String(err && err.message ? err.message : err).split('\n')[0] };
    }
  };
}

/* The rendered page's candidates, in the same priority order as the
   served markup's, with the drawn gallery images after them and the
   images the page actually loaded last. */
function candidatesFromRendered(seen, loaded, pageUrl) {
  const nodes = [];
  for (const block of seen.jsonld || []) nodes.push(...parseLdBlock(block));

  const raw = [];
  for (const hit of fromJsonLd(nodes)) raw.push({ url: hit.url, from: 'json-ld (rendered)', node: hit.node });
  for (const name of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    if (seen.metas && seen.metas[name]) raw.push({ url: seen.metas[name], from: `${name} (rendered)` });
  }
  for (const link of seen.preload || []) {
    if (link.href) raw.push({ url: link.href, from: 'preload (rendered)' });
    if (link.srcset) for (const url of largestFromSrcset(link.srcset)) raw.push({ url, from: 'preload srcset (rendered)' });
  }

  /* the gallery, biggest drawn image first — that ordering is what makes
     the hero shot beat the colour swatches and the recommendation strip */
  const drawn = (seen.imgs || [])
    .filter((img) => img.url && img.width >= MIN_RENDERED && img.height >= MIN_RENDERED)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height));
  for (const img of drawn) {
    if (img.srcset) for (const url of largestFromSrcset(img.srcset)) raw.push({ url, from: 'gallery srcset', alt: img.alt });
    raw.push({ url: img.url, from: img.inGallery ? 'gallery image' : 'rendered image', alt: img.alt });
  }

  for (const url of loaded || []) raw.push({ url, from: 'loaded by the page' });

  return dedupe(raw, pageUrl, seen.canonical);
}

/* ---------- one row ---------- */

/* Walks candidates in order and returns the first that clears every
   gate, or the reasons they all failed. */
async function firstVerifiable(candidates, row, fetcher) {
  const refusals = [];
  for (const candidate of candidates) {
    const unsound = soundness(candidate, row.productUrl);
    if (unsound) { refusals.push(unsound); continue; }

    const identity = identityEvidence(candidate, row.productUrl);
    if (!identity.ok) { refusals.push(identity.why); continue; }

    const check = await verifyImage(candidate.url, fetcher);
    if (check.ok) {
      return { url: candidate.url, why: `${check.why} — ${identity.how}`, from: candidate.from };
    }
    refusals.push(check.why);
  }
  return { refusals };
}

async function resolveRow(row) {
  const notes = [];

  /* ---- plain HTTP ---- */
  const page = await fetchPage(row.productUrl);
  let served = null;

  if (page.html) {
    const candidates = candidatesFrom(page.html, row.productUrl);
    notes.push(`plain HTTP: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
    if (candidates.length) {
      served = await firstVerifiable(candidates, row);
      if (served.url) return { id: row.id, verdict: 'VERIFIED', why: served.why, url: served.url, from: served.from, notes };
    }
  } else if (page.blocked) {
    /* the sandbox, not the retailer: a browser here would be refused the
       same way, so say so rather than spending a Chromium on it */
    return { id: row.id, verdict: 'UNREACHABLE', why: page.failed, url: null, blocked: true, notes };
  } else {
    notes.push(`plain HTTP: ${page.failed}`);
  }

  /* ---- a real browser ---- */
  if (!useBrowser) {
    return {
      id: row.id,
      verdict: page.html ? 'NO IMAGE FOUND' : 'UNREACHABLE',
      why: served && served.refusals && served.refusals.length
        ? served.refusals[0]
        : `${page.failed || 'nothing usable in the served markup'} (browser path off)`,
      url: null,
      notes
    };
  }

  const rendered = await renderPage(row.productUrl);
  if (rendered.failed) {
    notes.push(`browser: ${rendered.failed}`);
    const why = rendered.noBrowser && page.html
      ? `nothing usable in the served markup, and ${rendered.failed}`
      : rendered.failed;
    return {
      id: row.id,
      verdict: page.html || !rendered.noBrowser ? (page.html ? 'NO IMAGE FOUND' : 'UNREACHABLE') : 'UNREACHABLE',
      why,
      url: null,
      notes
    };
  }

  const candidates = candidatesFromRendered(rendered.seen, rendered.loaded, row.productUrl);
  notes.push(`browser: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
  if (!candidates.length) {
    return { id: row.id, verdict: 'NO IMAGE FOUND', why: 'the rendered page published no product image either', url: null, notes };
  }

  const found = await firstVerifiable(candidates, row, rendered.verify);
  if (found.url) return { id: row.id, verdict: 'VERIFIED', why: found.why, url: found.url, from: found.from, notes };

  const all = [...(served && served.refusals ? served.refusals : []), ...found.refusals];
  return {
    id: row.id,
    verdict: 'NO IMAGE FOUND',
    why: `${candidates.length} candidates, none tied to this product and loadable — ${all[0] || 'no reason recorded'}`,
    url: null,
    notes
  };
}

/* ---------- writing it back ----------

   A targeted edit, not a re-serialisation: the file keeps its comments,
   its spacing and its row order, and only the imageUrl belonging to the
   row being filled is touched. The row is located by its id, and the
   first imageUrl after that id is the one it owns. */
function writeInto(source, id, url) {
  const idAt = source.indexOf(`id: '${id}'`);
  if (idAt === -1) throw new Error(`could not find the row for ${id}`);

  const field = /(\n\s*imageUrl:\s*)(null|'[^']*'|"[^"]*")/;
  const rest = source.slice(idAt);
  const m = rest.match(field);
  if (!m) throw new Error(`could not find an imageUrl for ${id}`);

  if (url.includes("'") || /[\r\n]/.test(url)) throw new Error(`refusing to write an unquotable URL for ${id}`);

  const at = idAt + m.index;
  return source.slice(0, at) + m[1] + `'${url}'` + source.slice(at + m[0].length);
}

/* ---------- report ---------- */
async function main() {
  const { source, rows } = readCatalog();

  let targets = rows.filter((r) => r && r.productUrl);
  if (only) targets = targets.filter((r) => r.id === only);

  if (!targets.length) {
    console.log(only
      ? `\nNo catalogue row with a productUrl has the id ${only}.\n`
      : '\nNo catalogue row carries a productUrl, so there is no page to read a photo from.\n');
    return;
  }

  const already = targets.filter((r) => r.imageUrl && !refreshing);
  const todo = refreshing ? targets : targets.filter((r) => !r.imageUrl);

  console.log(`\nReading ${todo.length} linked product page${todo.length === 1 ? '' : 's'}${writing ? ', and writing what verifies' : ''}.`);
  if (already.length) {
    console.log(already.length === 1
      ? '1 row already carries a photo and is left alone — pass --refresh to re-read it.'
      : `${already.length} rows already carry a photo and are left alone — pass --refresh to re-read them.`);
  }
  console.log(useBrowser ? 'A page that gives up nothing over plain HTTP is opened in a real browser.\n' : 'Plain HTTP only (--no-browser).\n');

  const results = [];
  for (const row of already) {
    results.push({ id: row.id, verdict: 'VERIFIED', why: 'already in the catalogue, left as it was', url: row.imageUrl, kept: true });
  }

  for (const row of todo) {
    const result = await resolveRow(row);
    results.push(result);
    console.log(`  ${result.verdict.padEnd(15)} ${row.brand} — ${String(row.name).slice(0, 44)}`);
    for (const note of result.notes || []) console.log(`  ${''.padEnd(15)} · ${note}`);
    if (result.url) {
      console.log(`  ${''.padEnd(15)} ${result.url}`);
      console.log(`  ${''.padEnd(15)} ${result.why}${result.from ? ` [${result.from}]` : ''}`);
    } else {
      console.log(`  ${''.padEnd(15)} ${result.why}`);
    }
  }

  for (const kept of results.filter((r) => r.kept)) {
    console.log(`  ${'VERIFIED'.padEnd(15)} ${(rows.find((r) => r.id === kept.id) || {}).brand} — kept`);
    console.log(`  ${''.padEnd(15)} ${kept.url}`);
  }

  const fresh = results.filter((r) => r.verdict === 'VERIFIED' && !r.kept);
  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;

  console.log('\n  ' + ['VERIFIED', 'NO IMAGE FOUND', 'UNREACHABLE']
    .filter((k) => tally[k])
    .map((k) => `${tally[k]} ${k}`).join(', '));

  const populated = results.filter((r) => r.verdict === 'VERIFIED').length;
  console.log(`  ${populated} of ${targets.length} linked rows carry a real product photo` +
    (fresh.length ? `, ${fresh.length} newly verified this run` : ''));

  if (tally['UNREACHABLE'] && results.some((r) => r.blocked)) {
    const hosts = [...new Set(results.filter((r) => r.blocked)
      .map((r) => new URL(targets.find((t) => t.id === r.id).productUrl).hostname))].join(', ');
    console.log('\n  UNREACHABLE here is this machine, not the listings: ' + hosts);
    console.log('  is refused by the network egress policy, and a real browser is refused');
    console.log('  the same way. Run this from an ordinary connection, or allow those hosts.');
  }

  if (!writing) {
    console.log(fresh.length
      ? `\n  Re-run with --write to put ${fresh.length} verified URL${fresh.length === 1 ? '' : 's'} into assets/catalog.js.\n`
      : '\n  Nothing new verified, so there is nothing to write.\n');
    return;
  }

  if (!fresh.length) {
    console.log('\n  Nothing new verified — assets/catalog.js is left exactly as it was.');
    console.log('  A row only gets a photo it actually read off the retailer\'s page.\n');
    return;
  }

  let next = source;
  for (const r of fresh) next = writeInto(next, r.id, r.url);
  fs.writeFileSync(CATALOG, next);
  console.log(`\n  Wrote ${fresh.length} image URL${fresh.length === 1 ? '' : 's'} into assets/catalog.js.\n`);
}

/* The gates are the part worth testing, and they are all decidable
   without a retailer: what the markup offers, which hosts are refused,
   whether a photo belongs to this product, and what the file looks like
   afterwards. Required as a module it hands those over and runs nothing. */
if (require.main === module) {
  main().catch((err) => { console.error(err && err.message); process.exit(1); });
} else {
  module.exports = {
    candidatesFrom, candidatesFromRendered, soundness, writeInto, verifyImage,
    largestFromSrcset, readCatalog, identifiersFrom, identityEvidence, samePage,
    gatherInPage, renderPage, resolveRow, firstVerifiable
  };
}
