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
     node scripts/fetch-catalog-images.js --only jcrew-broken-in-oxford
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

  /* a long run of digits, with and without its leading zeros: Levi's
     171960005, Zara's 06887613, UNIQLO's 429066 */
  for (const token of text.match(/[A-Za-z]{0,3}\d{4,}[A-Za-z0-9]*/g) || []) {
    ids.add(token.toLowerCase());
    const digits = token.replace(/\D/g, '');
    if (digits.length >= 4) {
      ids.add(digits);
      const trimmed = digits.replace(/^0+/, '');
      if (trimmed.length >= 4) ids.add(trimmed);
    }
  }

  /* a letters-and-digits style code, which a run of four digits misses
     entirely: J.Crew names products AU763, BD640, MP919. Four characters
     is the floor, and a code this short is matched at a boundary rather
     than anywhere inside a hash, so it cannot collide its way in. */
  for (const token of text.match(/\b[A-Za-z]{1,4}\d{2,}[A-Za-z]?\b/g) || []) {
    if (token.length >= 4) ids.add(token.toLowerCase());
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

  const where = identityHaystacks(candidate.url);
  if (where.unparseable) return { ok: false, why: 'not a URL' };

  /* The code, as it appears in the image URL — but only where it says
     something about the asset being requested. A long code may sit
     anywhere in those parts; a short one such as J.Crew's AU763 has to
     sit at a boundary, so it cannot match its way in from the middle of
     a hash. */
  for (const id of ids) {
    for (const place of where.meaningful) {
      if (containsCode(place.text, id)) {
        return { ok: true, via: 'image-url', code: id, how: `the ${place.label} carries the listing's code ${id}` };
      }
    }
  }

  /* the code, with the separators a CDN path puts through it — Zara
     splits 6887613 across /6887/613/. Only long codes are matched this
     way, because a short run of digits collides by accident. */
  for (const id of ids) {
    if (!/^\d{6,}$/.test(id)) continue;
    for (const place of where.meaningful) {
      if (place.text.replace(/\D/g, '').includes(id)) {
        return { ok: true, via: 'image-url', code: id, how: `the ${place.label} carries the listing's code ${id}, split across segments` };
      }
    }
  }

  /* the structured record that supplied the image names the product */
  const skus = skuOf(candidate.node);
  for (const sku of skus) {
    const bare = sku.replace(/[^a-z0-9]/g, '');
    for (const id of ids) {
      if (bare.includes(id) || id.includes(bare)) {
        return { ok: true, via: 'json-ld-sku', sku, how: `the JSON-LD product it came from names sku ${sku}` };
      }
    }
  }

  /* the page vouches for itself: this IS the canonical page for the
     listing, and the image is the one it publishes as the product's */
  const vouches = candidate.from === 'json-ld' || String(candidate.from).startsWith('og:');
  if (vouches && candidate.canonical && samePage(candidate.canonical, productUrl)) {
    return {
      ok: true,
      via: 'canonical',
      canonical: candidate.canonical,
      how: `the page declares itself the canonical page for this listing, and this is its ${candidate.from}`
    };
  }

  if (where.onlyInFallback.length) {
    return {
      ok: false,
      why: `the code appears only in the ${where.onlyInFallback.join(' and ')} parameter, which names the stand-in image, not the one requested (${where.assetLabel})`
    };
  }

  return {
    ok: false,
    why: `nothing ties it to this product (looked for ${ids.slice(0, 3).join(', ')})`
  };
}

/* Parameters that name a picture to serve INSTEAD of the one asked for.
   Scene7's defaultImage is the common one: it is what the CDN falls back
   to when the requested asset is missing, so a product code sitting
   there says what would be shown if this image did not exist — the
   opposite of proof that this image is the product's. */
const FALLBACK_PARAMS = ['defaultimage', 'default', 'fallback', 'placeholder', 'errorimage', 'missingimage'];

/* The parts of an image URL that say something about the asset being
   requested, kept apart from the parts that do not. */
function identityHaystacks(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch (err) { return { unparseable: true, meaningful: [], onlyInFallback: [] }; }

  const meaningful = [{ label: 'URL path', text: decodeURIComponent(url.pathname).toLowerCase() }];
  const onlyInFallback = [];

  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    const text = decodeURIComponent(String(value)).toLowerCase();
    if (FALLBACK_PARAMS.includes(name)) onlyInFallback.push(key);
    else meaningful.push({ label: `${key} parameter`, text });
  }

  return {
    meaningful,
    /* only worth naming in a refusal if nothing meaningful matched */
    onlyInFallback,
    assetLabel: decodeURIComponent(url.pathname).split('/').filter(Boolean).pop() || url.pathname
  };
}

/* a long code may sit anywhere; a short one has to sit at a boundary */
function containsCode(text, id) {
  if (id.length >= 6) return text.includes(id);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

/* ---------- is a SHIPPED row's photo still accounted for? ----------

   A row in the catalogue is a URL with no page attached, and some
   retailers name their assets in a way that says nothing about the
   product: L.L.Bean requests 521659_32573_41 for product 129244. The
   extractor could tie that image to the listing because it was reading
   the page, where the JSON-LD product record named the sku. The file
   cannot re-read the page, so the row records how the tie was made.

   That record is re-proved here, never taken on faith. A recorded sku
   has to match a code in the row's own productUrl, and a recorded
   canonical has to be that same listing, so a made-up evidence block
   fails exactly as a made-up URL does. What the row buys is the fact
   that verification happened, not permission to skip it. */
function catalogRowIdentity(row) {
  if (!row || !row.imageUrl) return { ok: true, how: 'no photo to account for' };
  if (!row.productUrl) return { ok: false, why: 'carries a photo but links to no listing' };

  /* the URL says it itself — UNIQLO and J.Crew */
  const direct = identityEvidence({ url: row.imageUrl, from: 'catalogue' }, row.productUrl);
  if (direct.ok) return direct;

  const evidence = row.imageEvidence;
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, why: `${direct.why}, and the row records no verification evidence` };
  }

  const ids = identifiersFrom(row.productUrl);

  if (evidence.via === 'json-ld-sku') {
    const sku = String(evidence.sku || '').toLowerCase();
    const bare = sku.replace(/[^a-z0-9]/g, '');
    if (!bare) return { ok: false, why: 'the recorded evidence names no sku' };
    const matched = ids.find((id) => bare.includes(id) || id.includes(bare));
    if (!matched) {
      return { ok: false, why: `the recorded sku ${evidence.sku} is not a code in this row's own listing URL` };
    }
    return { ok: true, via: 'json-ld-sku', how: `its listing's JSON-LD product names sku ${evidence.sku}` };
  }

  if (evidence.via === 'canonical') {
    if (!samePage(evidence.canonical, row.productUrl)) {
      return { ok: false, why: `the recorded canonical ${evidence.canonical} is not this row's listing` };
    }
    return { ok: true, via: 'canonical', how: 'its listing declared itself canonical for this product' };
  }

  return { ok: false, why: `the recorded evidence names no recognised kind (${evidence.via || 'none'})` };
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

    /* A consent wall sits over the gallery and, on some retailers, stops
       its images loading at all until it is answered. Accepting it is
       what a shopper does to see the page, and it is the only thing
       clicked here — nothing is submitted, bought or logged into. */
    const consent = await dismissConsent(page);
    if (consent) await page.waitForTimeout(800);

    /* a gallery that loads as it is scrolled shows nothing to a browser
       that never scrolls, so the page is walked down before it is read */
    await coaxLazyImages(page);

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

/* The buttons a cookie wall puts its acceptance behind. Matched on the
   accessible name rather than on a retailer's class names, so this is
   one list rather than one rule per shop. Anything that reads like
   rejecting, managing or configuring is left alone: the goal is to get
   the overlay out of the way, not to make choices on someone's behalf. */
const CONSENT = [
  '#onetrust-accept-btn-handler',
  '#truste-consent-button',
  'button[id*="accept" i]',
  'button[class*="accept" i]',
  '[data-testid*="accept" i]',
  'button:has-text("Accept all")',
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept")',
  'button:has-text("Agree")',
  'button:has-text("I agree")',
  'button:has-text("Got it")'
];

async function dismissConsent(page) {
  for (const selector of CONSENT) {
    try {
      const button = page.locator(selector).first();
      if (!(await button.isVisible({ timeout: 400 }).catch(() => false))) continue;
      await button.click({ timeout: 2000 });
      return selector;
    } catch (err) { /* the next one, or none at all */ }
  }
  return null;
}

/* Walks the page down in screenfuls so an image that only loads when it
   scrolls into view actually loads, then returns to the top so the
   gallery is measured where the page puts it. */
async function coaxLazyImages(page) {
  try {
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.8);
      const end = Math.min(document.body.scrollHeight, step * 6);
      for (let y = 0; y <= end; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 200));
    });
    /* whatever that started, give it a moment to arrive */
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (err) { /* a page that will not scroll is read as it stands */ }
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

/* ---------- what the page says the product IS ----------

   Replacing a row means replacing its identity, not just its photo, and
   the name and brand have to come from the same page the image did —
   typed in by hand they are one more thing nobody checked. */
function factsFrom(nodes, metas) {
  const facts = { name: null, brand: null };
  for (const node of nodes) {
    if (!/product/i.test(String(node['@type'] || ''))) continue;
    if (!facts.name && typeof node.name === 'string') facts.name = node.name.trim();
    if (!facts.brand) {
      const brand = node.brand;
      if (typeof brand === 'string') facts.brand = brand.trim();
      else if (brand && typeof brand === 'object' && typeof brand.name === 'string') facts.brand = brand.name.trim();
    }
  }
  const meta = metas || {};
  if (!facts.name && meta['og:title']) facts.name = String(meta['og:title']).trim();
  if (!facts.brand && meta['og:site_name']) facts.brand = String(meta['og:site_name']).trim();
  return facts;
}

function factsFromHtml(html) {
  const metas = {};
  for (const key of ['og:title', 'og:site_name']) {
    const value = metaContent(html, key);
    if (value) metas[key] = decode(value);
  }
  return factsFrom(jsonLdNodes(html), metas);
}

function factsFromRendered(seen) {
  const nodes = [];
  for (const block of seen.jsonld || []) nodes.push(...parseLdBlock(block));
  return factsFrom(nodes, seen.metas || {});
}

/* ---------- one row ---------- */

/* Walks candidates in order and returns the first that clears every
   gate, or the reasons they all failed. */
async function firstVerifiable(candidates, row, fetcher) {
  const refusals = [];
  /* each refusal keeps the URL and the gate that turned it down, because
     "none of them worked" is not a diagnosis — which gate stopped which
     candidate is what says whether the page was read wrong, the wrong
     product was offered, or the host refused to serve us */
  const note = (candidate, gate, why) => refusals.push({ url: candidate.url, from: candidate.from, gate, why });

  for (const candidate of candidates) {
    const unsound = soundness(candidate, row.productUrl);
    if (unsound) { note(candidate, 'host', unsound); continue; }

    const identity = identityEvidence(candidate, row.productUrl);
    if (!identity.ok) { note(candidate, 'identity', identity.why); continue; }

    const check = await verifyImage(candidate.url, fetcher);
    if (check.ok) {
      return { url: candidate.url, why: `${check.why} — ${identity.how}`, from: candidate.from, identity };
    }
    note(candidate, 'loadable', check.why);
  }
  return { refusals };
}

async function resolveRow(row) {
  const notes = [];
  let facts = { name: null, brand: null };

  /* ---- plain HTTP ---- */
  const page = await fetchPage(row.productUrl);
  let served = null;

  if (page.html) {
    facts = factsFromHtml(page.html);
    const candidates = candidatesFrom(page.html, row.productUrl);
    notes.push(`plain HTTP: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
    if (candidates.length) {
      served = await firstVerifiable(candidates, row);
      if (served.url) return { id: row.id, verdict: 'VERIFIED', why: served.why, url: served.url, from: served.from, identity: served.identity, facts, notes };
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

  facts = factsFromRendered(rendered.seen) ;
  const candidates = candidatesFromRendered(rendered.seen, rendered.loaded, row.productUrl);
  notes.push(`browser: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
  if (!candidates.length) {
    return { id: row.id, verdict: 'NO IMAGE FOUND', why: 'the rendered page published no product image either', url: null, notes };
  }

  const found = await firstVerifiable(candidates, row, rendered.verify);
  if (found.url) return { id: row.id, verdict: 'VERIFIED', why: found.why, url: found.url, from: found.from, identity: found.identity, facts, notes };

  const all = [...(served && served.refusals ? served.refusals : []), ...found.refusals];
  return {
    id: row.id,
    verdict: 'NO IMAGE FOUND',
    why: `${all.length} candidate${all.length === 1 ? '' : 's'} found, none cleared every gate`,
    url: null,
    refusals: all,
    facts,
    notes
  };
}

/* ---------- writing it back ----------

   A targeted edit, not a re-serialisation: the file keeps its comments,
   its spacing and its row order, and only the imageUrl belonging to the
   row being filled is touched. The row is located by its id, and the
   first imageUrl after that id is the one it owns. */
function writeInto(source, id, url, evidence) {
  const idAt = source.indexOf(`id: '${id}'`);
  if (idAt === -1) throw new Error(`could not find the row for ${id}`);

  const field = /(\n\s*imageUrl:\s*)(null|'[^']*'|"[^"]*")/;
  const rest = source.slice(idAt);
  const m = rest.match(field);
  if (!m) throw new Error(`could not find an imageUrl for ${id}`);

  if (url.includes("'") || /[\r\n]/.test(url)) throw new Error(`refusing to write an unquotable URL for ${id}`);

  const at = idAt + m.index;
  const indent = m[1].replace(/\n/, '').replace(/imageUrl:\s*$/, '');
  let out = source.slice(0, at) + m[1] + `'${url}'` + source.slice(at + m[0].length);

  /* A photo whose URL does not carry the product's code is only
     accountable later if the row says how it was tied to the listing, so
     that is recorded beside it rather than left to memory. A URL that
     speaks for itself needs no note and does not get one. */
  const note = evidenceNote(evidence);
  out = setEvidence(out, id, note, indent);
  return out;
}

/* where the row that starts at idAt stops: the next row's id, or the end
   of the file. Every row carries exactly one id, so this needs no
   brace counting. */
function rowEndsAt(source, idAt) {
  const next = source.indexOf("id: '", idAt + 1);
  return next === -1 ? source.length : next;
}

/* the evidence worth keeping: the kinds a shipped row can be re-proved
   against without the page in front of it */
function evidenceNote(evidence) {
  if (!evidence || !evidence.ok) return null;
  if (evidence.via === 'json-ld-sku' && evidence.sku) {
    return `{ via: 'json-ld-sku', sku: '${String(evidence.sku).replace(/'/g, "")}' }`;
  }
  if (evidence.via === 'canonical' && evidence.canonical) {
    return `{ via: 'canonical', canonical: '${String(evidence.canonical).replace(/'/g, "")}' }`;
  }
  return null; // via: 'image-url' — the URL is its own evidence
}

/* writes, replaces or removes the row's imageEvidence, keeping the file's
   shape: the note sits directly under the imageUrl it explains */
function setEvidence(source, id, note, indent) {
  const idAt = source.indexOf(`id: '${id}'`);
  /* bounded to THIS row. imageUrl exists on every row so the first one
     after the id is always the right one, but imageEvidence does not:
     searched to the end of the file, a row with no note would find the
     next row's and rewrite that one instead. */
  const rest = source.slice(idAt, rowEndsAt(source, idAt));
  const existing = rest.match(/\n\s*imageEvidence:\s*(\{[^}]*\}|null),?/);

  if (existing) {
    const at = idAt + existing.index;
    const replacement = note ? `\n${indent}imageEvidence: ${note},` : '';
    return source.slice(0, at) + replacement + source.slice(at + existing[0].length);
  }
  if (!note) return source;

  const after = rest.match(/(\n\s*imageUrl:\s*(?:null|'[^']*'|"[^"]*"),)/);
  if (!after) return source;
  const at = idAt + after.index + after[0].length;
  return source.slice(0, at) + `\n${indent}imageEvidence: ${note},` + source.slice(at);
}

/* ---------- trying a replacement product ----------

   When a retailer will not be read at all, the row's product has to
   change rather than its photo. That is a bigger edit — productUrl, name
   and brand move together with imageUrl — so it gets its own mode: point
   it at a candidate listing and it reports what the catalogue WOULD say,
   every field taken off the page rather than typed in, and writes
   nothing until it is told to.

   The gates are the same ones. A replacement that cannot be verified is
   not a replacement; it is a different row that also has no photo. */
async function inspectCandidate(productUrl, forId) {
  const row = { id: forId || 'candidate', brand: '—', name: productUrl, productUrl };
  const result = await resolveRow(row);
  const facts = result.facts || {};

  console.log(`\n  ${result.verdict.padEnd(15)} ${productUrl}`);
  for (const note of result.notes || []) console.log(`  ${''.padEnd(15)} · ${note}`);

  if (result.verdict !== 'VERIFIED') {
    console.log(`  ${''.padEnd(15)} ${result.why}`);
    for (const refusal of (result.refusals || []).slice(0, 12)) {
      console.log(`  ${''.padEnd(15)}   [${refusal.gate}] ${short(refusal.url)}`);
      console.log(`  ${''.padEnd(15)}     from ${refusal.from} — ${refusal.why}`);
    }
    console.log('\n  Not usable as a replacement.\n');
    return null;
  }

  console.log(`  ${''.padEnd(15)} ${result.why}${result.from ? ` [${result.from}]` : ''}`);
  console.log('\n  The row this would become:\n');
  console.log(`    name:       ${facts.name || '(the page named none — set it by hand)'}`);
  console.log(`    brand:      ${facts.brand || '(the page named none — set it by hand)'}`);
  console.log(`    productUrl: ${productUrl}`);
  console.log(`    imageUrl:   ${result.url}`);
  console.log(`\n  Every field above came off that page. Nothing was typed in.\n`);
  return { productUrl, imageUrl: result.url, name: facts.name, brand: facts.brand };
}

/* Swaps a row's product for a verified candidate: the listing, the
   photo, the name and the brand move together, because half a swap is a
   row that points at one product and pictures another. */
function replaceRow(source, id, next) {
  let out = source;
  const set = (field, value) => {
    if (value == null) return;
    const idAt = out.indexOf(`id: '${id}'`);
    if (idAt === -1) throw new Error(`could not find the row for ${id}`);
    const re = new RegExp(`(\\n\\s*${field}:\\s*)(null|'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`);
    const rest = out.slice(idAt);
    const m = rest.match(re);
    if (!m) throw new Error(`could not find ${field} for ${id}`);
    const quoted = value.includes("'")
      ? `"${value.replace(/"/g, '\\"')}"`
      : `'${value}'`;
    if (/[\r\n]/.test(value)) throw new Error(`refusing to write a multi-line ${field} for ${id}`);
    const at = idAt + m.index;
    out = out.slice(0, at) + m[1] + quoted + out.slice(at + m[0].length);
  };
  set('name', next.name);
  set('brand', next.brand);
  set('productUrl', next.productUrl);
  set('imageUrl', next.imageUrl);
  return out;
}

/* a URL kept readable in a report column without losing which image it
   names: the middle of a long CDN path is what goes */
function short(url, width = 96) {
  const text = String(url || '');
  if (text.length <= width) return text;
  const head = Math.ceil((width - 3) * 0.6);
  return `${text.slice(0, head)}...${text.slice(-(width - 3 - head))}`;
}

/* ---------- report ---------- */
async function main() {
  /* --candidate <url> [--as <row-id>] : try a replacement product */
  const candidate = flag('--candidate');
  if (candidate) {
    const forId = flag('--as');
    console.log(`\nTrying ${candidate} as a replacement${forId ? ` for ${forId}` : ''}.`);
    const proposal = await inspectCandidate(candidate, forId);
    if (!proposal || !forId) {
      if (proposal && !forId) console.log('  Pass --as <row-id> to see it written into a row.\n');
      return;
    }
    if (!writing) {
      console.log(`  Re-run with --write to put it into ${forId}.\n`);
      return;
    }
    const { source: current, rows: currentRows } = readCatalog();
    const target = currentRows.find((r) => r.id === forId);
    if (!target) throw new Error(`no catalogue row has the id ${forId}`);
    fs.writeFileSync(CATALOG, replaceRow(current, forId, proposal));
    console.log(`  Replaced ${forId} — listing, photo, name and brand together.\n`);
    return;
  }

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
      /* every candidate and the gate that stopped it: without this a
         failure is unactionable, and the next step is guesswork */
      for (const refusal of (result.refusals || []).slice(0, 12)) {
        console.log(`  ${''.padEnd(15)}   [${refusal.gate}] ${short(refusal.url)}`);
        console.log(`  ${''.padEnd(15)}     from ${refusal.from} — ${refusal.why}`);
      }
      const extra = (result.refusals || []).length - 12;
      if (extra > 0) console.log(`  ${''.padEnd(15)}   …and ${extra} more`);
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
  for (const r of fresh) next = writeInto(next, r.id, r.url, r.identity);
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
    gatherInPage, renderPage, resolveRow, firstVerifiable,
    replaceRow, factsFromHtml, factsFromRendered, inspectCandidate,
    catalogRowIdentity, evidenceNote
  };
}
