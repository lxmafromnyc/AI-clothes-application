#!/usr/bin/env node
/* =========================================================
   Fynd — hydrate the catalogue from the retailers' own pages

   A Discover card claims four things about a product: this is its photo,
   this is its name and brand, this is what it costs, and this is where
   you buy it. Those four have to be true TOGETHER — a real photo beside
   a stale price, or the right price beside a neighbouring product's
   picture, is a worse lie than an empty tile, because it looks finished.

   So every field a row carries is read off ONE load of ONE page: the
   listing the row links to. The photo, the price, the name and the brand
   come out of the same markup in the same pass, which is what makes them
   the same product's. Nothing here is typed in, and nothing is assembled
   from a pattern.

   ---------------------------------------------------------
   What a row goes through
   ---------------------------------------------------------
   A row that already links to a listing is read. A row that does not is
   first given one, from a candidate the operator supplies or a search
   source finds, and that listing then goes through exactly the same
   gates — a replacement is not a shortcut past them.

   The photo has four gates to clear:

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

   The price has four of its own, and they are the same shape:

     found    it appeared in the page's own record of the product — a
              JSON-LD offer, a price meta tag, microdata, or the one
              price the product's own heading block displays. A number
              from a search-result snippet is not a price this page
              published, and is never read as one.
     sound    it parses to a positive amount with at most two decimals,
              and the page says it is in USD. A card renders "$" with no
              currency beside it, so a figure the page priced in another
              currency would be shown as dollars it is not — that is
              refused rather than converted or assumed.
     this     the record carrying the price names a sku matching the
              listing, or the page declares itself canonical for it.
              A recommendation strip's price is another product's price.
     current  it is the price the page asks today, not a struck-through
              was-price and not a compare-at. Where the page shows more
              than one live figure and nothing says which is being
              charged, the ambiguity is reported, not resolved by guess.

   A row that fails any gate is left exactly as it was — null imageUrl
   keeps the drawn artwork, null price renders "Price at retailer" — and
   is reported FAILED. Half a hydration is never written: a row takes its
   photo and its price together or takes neither, so a card can never
   show one product's picture over another's price.

   ---------------------------------------------------------
   Provenance
   ---------------------------------------------------------
   An image URL is its own evidence when it carries the listing's code.
   A price is a bare number and can never speak for itself, so every
   verified price is written with a priceEvidence block recording how it
   was obtained — and the amount that was read.

   That block is re-proved, never trusted. The recorded sku has to be a
   code in the row's own productUrl, the recorded canonical has to be
   that same listing, and the recorded amount has to equal the price the
   row actually carries. So a price typed in by hand fails for having no
   evidence, and a price edited afterwards fails because the evidence
   still names the number that was read. "Trust me" is not writable.

   ---------------------------------------------------------
   Two ways in
   ---------------------------------------------------------
   Plain HTTP first, because it is cheap and most pages publish
   everything needed in their served markup. When that comes back with
   nothing usable — no candidates, or a 403 from the retailer's bot
   check — the page is opened in a real Chromium through Playwright,
   which runs the page's scripts, answers the cookie wall, scrolls the
   gallery into existence and reports what the page actually rendered. A
   retailer that refuses a bare client is answered with a real browser
   rather than with a guess.

   It reports by default and changes nothing. --write is what edits
   assets/catalog.js, and it only ever writes rows that verified end to
   end; id, category and the matching vocabulary are left exactly as they
   were. A row that already carries a verified photo and price is left
   alone unless --refresh says otherwise, so working data is never
   churned and a re-run costs nothing.

   Run it from a machine with an ordinary internet connection. Behind a
   proxy that refuses retailer hosts every row comes back FAILED with the
   network named, and the report is about the proxy rather than about the
   catalogue.

   Usage
     node scripts/hydrate-catalog.js                    report on everything
     node scripts/hydrate-catalog.js --write            hydrate the catalogue
     node scripts/hydrate-catalog.js --only jcrew-broken-in-oxford
     node scripts/hydrate-catalog.js --refresh          re-read rows already filled
     node scripts/hydrate-catalog.js --discover         give unlinked rows a listing
     node scripts/hydrate-catalog.js --candidates urls.json
     node scripts/hydrate-catalog.js --no-browser       plain HTTP only
     node scripts/hydrate-catalog.js --site https://example.github.io

   One command for the whole catalogue:

     node scripts/hydrate-catalog.js --discover --write

   --candidates takes { "<row id>": ["<url>", ...] } and is the way to
   hydrate without a search key: the URLs are candidates only, and every
   field still has to come off the page they open.
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
const discovering = has('--discover');
const candidatesFile = flag('--candidates');

/* The date a price was read. A price is only true on a day, so the day
   is recorded beside it and a stale one is visible rather than implied. */
const TODAY = new Date().toISOString().slice(0, 10);

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

/* ---------- what the page says the product COSTS ----------

   A price is a bare number. Unlike an image URL it carries nothing
   inside it that says which product it belongs to, which day it was
   true, or even which currency it is in — so all of that has to come
   from the record that published it, and be written down beside it.

   The sources, in the order they deserve to be believed:

     json-ld-offer   the offer attached to the page's own Product record.
                     That record also names the sku, which is what ties
                     the figure to this listing rather than to a
                     neighbour in the same feed.
     price meta      product:price:amount / og:price:amount, the figure
                     the retailer publishes for sharing. It speaks for
                     the page, so the page has to be this listing's
                     canonical one before it is believed.
     microdata       itemprop="price", the same claim in an older shape.
     rendered price  the one live figure the product's own heading block
                     displays. Last, and the most constrained: see
                     priceFromHeadingBlock below for what it refuses.

   Nothing reads a figure out of a search result, a comparison page or a
   snippet. Those say what something cost somewhere, which is not what
   this listing is charging. */

const MAX_SANE_PRICE = 100000;

/* Amounts as retailers actually write them: 49.90, "49.90", "$1,299.00",
   "USD 89", "1.299,00". The separators are the whole difficulty, so they
   are decided rather than stripped: whichever of . and , comes last is
   the decimal point when both appear, a lone comma with three digits
   behind it is a thousands separator, and a lone comma with one or two
   is a decimal comma. Anything that survives none of those readings is
   refused rather than rounded into something plausible. */
function parseAmount(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? gradeAmount(raw) : { why: 'not a finite number' };
  }
  if (typeof raw !== 'string') return { why: `a ${typeof raw} is not a price` };

  const text = raw.trim();
  if (!text) return { why: 'empty' };

  const digits = text.match(/\d[\d., \s]*\d|\d/);
  if (!digits) return { why: `no number in ${JSON.stringify(text.slice(0, 24))}` };

  /* A minus in front survives the digit match, which drops it — so a
     negative would come back as its own absolute value, which is how a
     credit or an adjustment turns into a price. It is read here and
     refused rather than quietly flipped. */
  const before = text.slice(0, digits.index);
  if (/[-−]\s*[^\d\s]{0,2}\s*$/.test(before) || /^\s*\(/.test(text)) {
    return { why: `${JSON.stringify(text.slice(0, 24))} reads as a negative amount, which is not a price` };
  }

  let body = digits[0].replace(/[ \s]/g, '');
  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    /* both present: the later one is the decimal point, the other groups */
    const decimalAt = Math.max(lastDot, lastComma);
    const grouping = decimalAt === lastDot ? ',' : '.';
    body = body.split(grouping).join('');
    body = body.replace(/,/g, '.');
  } else if (lastComma !== -1) {
    const after = body.length - lastComma - 1;
    if (after === 3 && /^\d{1,3}(,\d{3})+$/.test(body)) body = body.replace(/,/g, '');
    else if (after === 1 || after === 2) body = body.replace(',', '.');
    else return { why: `cannot tell whether the comma in ${body} groups or divides` };
  }

  if (!/^\d+(\.\d+)?$/.test(body)) return { why: `${JSON.stringify(digits[0])} is not a plain amount` };
  return gradeAmount(Number(body));
}

/* A number that parsed still has to be a price: positive, priced to the
   cent rather than to a fraction of one, and not an order of magnitude
   that says the figure was something else on the page. */
function gradeAmount(value) {
  if (!Number.isFinite(value)) return { why: 'not a finite number' };
  if (value <= 0) return { why: `${value} is not a price` };
  if (value > MAX_SANE_PRICE) return { why: `${value} is too large to be a garment's price` };
  if (Math.round(value * 100) !== Number((value * 100).toFixed(4))) {
    return { why: `${value} is priced below the cent` };
  }
  return { amount: Math.round(value * 100) / 100 };
}

const SYMBOL_CURRENCY = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW' };

/* Which currency a figure is in, from the record that carried it, from
   an ISO code written beside it, or from its symbol.

   "$" is deliberately not enough on its own: it is the Canadian,
   Australian, Singapore and Hong Kong dollar as much as the US one, and
   a card that renders "$" beside an amount would show all of them as
   dollars they are not. So a bare "$" resolves only when the page has
   said somewhere that it prices in USD, and otherwise comes back
   undecided — which the soundness gate refuses. */
function currencyOf(declared, text, hint) {
  const named = String(declared || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(named)) return { currency: named, how: 'the record names it' };

  const body = String(text == null ? '' : text);
  const iso = body.toUpperCase().match(/\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NOK|DKK|INR|KRW|CNY|MXN|BRL)\b/);
  if (iso) return { currency: iso[1], how: 'the amount is written with its code' };

  for (const [symbol, code] of Object.entries(SYMBOL_CURRENCY)) {
    if (body.includes(symbol)) return { currency: code, how: `the ${symbol} symbol` };
  }

  if (body.includes('$')) {
    if (hint === 'USD') return { currency: 'USD', how: 'a $ amount on a page that prices in USD' };
    return { currency: null, why: 'it is written with a bare $, and nothing on the page says which dollar' };
  }

  return { currency: null, why: 'nothing says which currency it is in' };
}

/* What the page says it prices in, taken from whichever record mentions
   a currency at all. This is what lets a bare "$" in the heading block
   be read as USD, and only that. */
function currencyHintFrom(nodes, metas) {
  for (const node of nodes || []) {
    for (const offer of offersOf(node)) {
      const named = String(offer.priceCurrency || (offer.priceSpecification || {}).priceCurrency || '').toUpperCase();
      if (/^[A-Z]{3}$/.test(named)) return named;
    }
  }
  const meta = metas || {};
  for (const key of ['product:price:currency', 'og:price:currency', 'twitter:data2']) {
    const named = String(meta[key] || '').trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(named)) return named;
  }
  return null;
}

/* Every offer hanging off a Product node, however it is nested: a single
   Offer, an array of them, an AggregateOffer, or offers inside one. */
function offersOf(node) {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  const stack = [node.offers];
  while (stack.length) {
    const offer = stack.pop();
    if (!offer) continue;
    if (Array.isArray(offer)) { stack.push(...offer); continue; }
    if (typeof offer !== 'object') continue;
    out.push(offer);
    if (offer.offers) stack.push(offer.offers);
  }
  return out;
}

/* The amount one offer names, and which field named it. An AggregateOffer
   has no single price by definition, so its lowPrice is read as the
   product's starting price and says so — a shopper sees that figure on
   the page too. */
function amountOf(offer) {
  const spec = offer.priceSpecification && typeof offer.priceSpecification === 'object' ? offer.priceSpecification : null;
  for (const [field, source] of [['price', offer], ['price', spec], ['lowPrice', offer]]) {
    if (!source) continue;
    const value = source[field];
    if (value === undefined || value === null || value === '') continue;
    const currency = source.priceCurrency || offer.priceCurrency || null;
    return { raw: value, currency, field: source === spec ? `priceSpecification.${field}` : field };
  }
  return null;
}

/* The page's own Product record, priced. The sku travels with it,
   because that is what ties the figure to this listing.

   A listing that prices its variants differently and names no single
   product price is ambiguous, and ambiguity is reported rather than
   resolved: taking the first, the lowest or the most common would each
   be a guess at what the page is actually charging. */
function priceFromJsonLd(nodes) {
  const found = [];
  for (const node of nodes) {
    if (!/product/i.test(String(node['@type'] || ''))) continue;

    const priced = offersOf(node).map((offer) => ({ offer, named: amountOf(offer) })).filter((o) => o.named);
    if (!priced.length) continue;

    /* An AggregateOffer exists precisely to name one figure for a
       product sold at several: its lowPrice is the "from" price the page
       itself shows. Where the listing publishes one, it settles the
       question, and the variant offers nested under it are not a
       disagreement — they are what it is aggregating. */
    const aggregate = priced.find((o) => /aggregateoffer/i.test(String(o.offer['@type'] || '')));

    if (!aggregate) {
      const distinct = new Set(priced.map((o) => {
        const parsed = parseAmount(o.named.raw);
        return parsed.amount === undefined ? String(o.named.raw) : parsed.amount;
      }));

      if (distinct.size > 1) {
        found.push({
          ambiguous: true,
          from: 'json-ld-offer',
          node,
          why: `the listing's record prices it at ${distinct.size} different amounts (${[...distinct].slice(0, 4).join(', ')}) and names none of them as the product's`
        });
        continue;
      }
    }

    const best = aggregate || priced[0];
    found.push({
      amount: best.named.raw,
      currency: best.named.currency,
      field: best.named.field,
      offerType: String(best.offer['@type'] || 'Offer'),
      from: 'json-ld-offer',
      node
    });
  }
  return found;
}

/* The figure the retailer publishes for sharing. It speaks for the page
   rather than for a record inside it, so it is only believed on a page
   that declares itself this listing's canonical one. */
const PRICE_METAS = [
  ['product:price:amount', 'product:price:currency'],
  ['og:price:amount', 'og:price:currency'],
  ['product:sale_price:amount', 'product:sale_price:currency']
];

function priceFromMetas(metas) {
  const out = [];
  const meta = metas || {};
  for (const [amountKey, currencyKey] of PRICE_METAS) {
    const value = meta[amountKey];
    if (value === undefined || value === null || value === '') continue;
    out.push({ amount: value, currency: meta[currencyKey] || null, from: amountKey });
  }
  return out;
}

/* itemprop="price", the same claim written the older way. Read only from
   a content attribute: an itemprop wrapped around visible text is the
   heading-block case, and that path has its own gate. */
function priceFromMicrodata(html) {
  const out = [];
  const re = /<(?:meta|span|div|data)[^>]+itemprop=["']price["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const content = m[0].match(/content=["']([^"']+)["']/i) || m[0].match(/value=["']([^"']+)["']/i);
    if (content) out.push({ amount: content[1], currency: microdataCurrency(html), from: 'microdata' });
  }
  return out;
}

function microdataCurrency(html) {
  const tag = html.match(/<[^>]+itemprop=["']priceCurrency["'][^>]*>/i);
  if (!tag) return null;
  const content = tag[0].match(/content=["']([^"']+)["']/i);
  return content ? content[1] : null;
}

/* The figures in a run of text that are written AS money: a number with
   a currency symbol or code against it. The heading block is read with
   this rather than with parseAmount alone, because an element there can
   hold more than a price — "2 for $49" starts with a number that is not
   one, and "$49.90 $79.00" holds two. Reading only what is marked as
   money answers the first; reporting every one of them answers the
   second, and the caller refuses the ambiguity rather than picking. */
const MONEY_BEFORE = /([$\u20ac\u00a3\u00a5]|\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|INR|KRW)\b)\s*([-\u2212]?\s*\d[\d.,\u00a0]*)/gi;
const MONEY_AFTER = /([-\u2212]?\s*\d[\d.,\u00a0]*\d|[-\u2212]?\s*\d)\s*(USD|EUR|GBP|CAD|AUD|JPY|CHF|INR|KRW)\b/gi;

function amountsIn(text) {
  const body = String(text == null ? '' : text);
  const out = [];
  const take = (mark, number) => {
    const parsed = parseAmount(`${mark} ${number}`);
    if (parsed.amount === undefined) return;
    const code = /^[a-z]{3}$/i.test(String(mark));
    out.push({
      amount: parsed.amount,
      mark: String(mark),
      shown: code ? `${mark} ${String(number).trim()}` : `${mark}${String(number).trim()}`
    });
  };
  let m;
  MONEY_BEFORE.lastIndex = 0;
  while ((m = MONEY_BEFORE.exec(body))) take(m[1], m[2]);
  MONEY_AFTER.lastIndex = 0;
  while ((m = MONEY_AFTER.exec(body))) take(m[2], m[1]);
  return out;
}

/* ---------- the price the page actually shows ----------

   The last resort, for a listing whose price exists only in the pixels:
   no JSON-LD, no price meta, no microdata, just a number rendered by a
   script. Read carelessly this is where a wrong price comes from — a
   recommendation strip, a shipping threshold, a struck-through
   was-price, a "4 payments of" — so it is read under four constraints,
   all of them enforced in the page by gatherInPage:

     where   only inside the smallest block that contains the product's
             own <h1>. That is the heading block: the title and the price
             a shopper reads together. A related product's price is in a
             different block by construction.
     live    a figure the page draws through, or labels as a was-price,
             a compare-at or a list price, is not what is being charged
             and is dropped rather than compared.
     single  what is left has to agree. Two different live figures in the
             heading block means the page is saying something this cannot
             read — an instalment plan, a range, a member price — and the
             answer is to report it, not to pick one.
     visible a figure in a hidden node is not what the page is showing.

   Even then it only counts on a page that declares itself canonical for
   this listing, because unlike an offer record it names no sku of its
   own. */
function priceFromHeadingBlock(prices, hint) {
  const seen = prices && Array.isArray(prices.heading) ? prices.heading : [];
  if (!seen.length) return [];

  const live = seen.filter((entry) => !entry.struck);
  if (!live.length) {
    return [{ ambiguous: true, from: 'rendered price', why: 'every figure in the heading block is struck through or labelled a was-price' }];
  }

  const amounts = new Map();
  for (const entry of live) {
    for (const found of amountsIn(entry.text)) {
      const money = currencyOf(null, found.mark, hint);
      const key = `${found.amount} ${money.currency || '?'}`;
      if (!amounts.has(key)) amounts.set(key, { amount: found.amount, currency: money.currency, text: found.shown });
    }
  }

  if (!amounts.size) return [];
  if (amounts.size > 1) {
    return [{
      ambiguous: true,
      from: 'rendered price',
      why: `the heading block shows ${amounts.size} different live figures (${[...amounts.values()].map((a) => a.text).slice(0, 4).join(', ')}) and nothing says which is being charged`
    }];
  }

  const only = [...amounts.values()][0];
  return [{ amount: only.amount, currency: only.currency, from: 'rendered price', shown: only.text }];
}

/* every price the served markup offers, in the order above */
function priceCandidatesFrom(html, pageUrl) {
  const nodes = jsonLdNodes(html);
  const metas = {};
  for (const [amountKey, currencyKey] of PRICE_METAS) {
    const amount = metaContent(html, amountKey);
    if (amount) metas[amountKey] = decode(amount);
    const currency = metaContent(html, currencyKey);
    if (currency) metas[currencyKey] = decode(currency);
  }
  const hint = currencyHintFrom(nodes, metas);
  const canonical = canonicalOf(html);

  return [
    ...priceFromJsonLd(nodes),
    ...priceFromMetas(metas),
    ...priceFromMicrodata(html)
  ].map((c) => Object.assign({ canonical, hint, pageUrl }, c));
}

/* the same, from a page a real browser rendered */
function priceCandidatesFromRendered(seen, pageUrl) {
  const nodes = [];
  for (const block of seen.jsonld || []) nodes.push(...parseLdBlock(block));
  const metas = seen.metas || {};
  const hint = currencyHintFrom(nodes, metas);
  const canonical = seen.canonical || null;

  const microdata = (seen.prices && Array.isArray(seen.prices.microdata) ? seen.prices.microdata : [])
    .map((entry) => ({ amount: entry.content, currency: entry.currency || null, from: 'microdata (rendered)' }));

  return [
    ...priceFromJsonLd(nodes),
    ...priceFromMetas(metas),
    ...microdata,
    ...priceFromHeadingBlock(seen.prices, hint)
  ].map((c) => Object.assign({ canonical, hint, pageUrl }, c));
}

/* ---------- the price gates ---------- */

/* Numeric, in the cent, and in the currency the interface can render. A
   card draws "$" with no code beside it, so a figure the page priced in
   euros would be shown as dollars it is not — refused here rather than
   converted, because converting invents a number no retailer quoted. */
const RENDERS_AS = 'USD';

function priceSoundness(candidate) {
  const parsed = parseAmount(candidate.amount);
  if (parsed.amount === undefined) return { ok: false, why: parsed.why };

  /* A rendered figure arrives already parsed, so the symbol that was
     written beside it is only still on `shown`. Reading currency off the
     bare number instead would lose the one mark the page gave us. */
  const written = candidate.shown != null ? candidate.shown : candidate.amount;
  const money = currencyOf(candidate.currency, String(written), candidate.hint);
  if (!money.currency) return { ok: false, why: money.why };
  if (money.currency !== RENDERS_AS) {
    return { ok: false, why: `the page prices it in ${money.currency}, and a card renders $ with no currency beside it` };
  }

  return { ok: true, amount: parsed.amount, currency: money.currency, how: money.how };
}

/* Is this THIS product's price? The same question the photo answers, and
   the same two ways of answering it: the record carrying the figure
   names a sku belonging to this listing, or the page carrying it
   declares itself this listing's canonical page. */
function priceIdentity(candidate, productUrl) {
  const ids = identifiersFrom(productUrl);

  const skus = skuOf(candidate.node);
  for (const sku of skus) {
    const bare = sku.replace(/[^a-z0-9]/g, '');
    for (const id of ids) {
      if (bare.includes(id) || id.includes(bare)) {
        return { ok: true, via: 'json-ld-offer', sku, how: `the JSON-LD product it is an offer on names sku ${sku}` };
      }
    }
  }

  if (candidate.canonical && samePage(candidate.canonical, productUrl)) {
    return {
      ok: true,
      via: candidate.from === 'json-ld-offer' ? 'json-ld-offer' : 'canonical',
      canonical: candidate.canonical,
      how: `the page declares itself the canonical page for this listing, and this is its ${candidate.from}`
    };
  }

  if (skus.length) {
    return { ok: false, why: `it is an offer on sku ${skus[0]}, which is not this listing (looked for ${ids.slice(0, 3).join(', ')})` };
  }
  return { ok: false, why: `nothing ties it to this product — no sku on the record, and the page claims no canonical for this listing` };
}

/* Walks the price candidates in order and returns the first that clears
   every gate, keeping every refusal so a failure says which gate stopped
   which figure. */
function firstVerifiablePrice(candidates, productUrl) {
  const refusals = [];
  for (const candidate of candidates) {
    if (candidate.ambiguous) {
      refusals.push({ amount: '—', from: candidate.from, gate: 'current', why: candidate.why });
      continue;
    }

    const sound = priceSoundness(candidate);
    if (!sound.ok) {
      refusals.push({ amount: String(candidate.amount), from: candidate.from, gate: 'sound', why: sound.why });
      continue;
    }

    const identity = priceIdentity(candidate, productUrl);
    if (!identity.ok) {
      refusals.push({ amount: String(candidate.amount), from: candidate.from, gate: 'identity', why: identity.why });
      continue;
    }

    return {
      amount: sound.amount,
      currency: sound.currency,
      from: candidate.from,
      why: `${sound.currency} ${sound.amount} — ${identity.how}`,
      identity: Object.assign({}, identity, { amount: sound.amount, currency: sound.currency, from: candidate.from })
    };
  }
  return { refusals };
}

/* ---------- is a SHIPPED row's price still accounted for? ----------

   An image URL can vouch for itself by carrying the listing's code. A
   price never can: 89 is 89 whatever product it belongs to and whatever
   day it was read. So a priced row has to carry a priceEvidence block,
   and that block is re-proved from the row alone, exactly the way the
   image's is.

   Three things are checked, and the third is the one that makes this
   worth doing: the recorded sku has to be a code in this row's own
   productUrl, the recorded canonical has to be this row's own listing,
   and the recorded AMOUNT has to be the price the row actually carries.
   That last one is what a hand-edited price fails on — the evidence goes
   on naming the figure that was read off the page, so changing the
   number in the row without changing the page it came from is caught
   here rather than shipped. */
function catalogRowPrice(row) {
  if (!row || row.price === null || row.price === undefined) return { ok: true, how: 'no price to account for' };
  if (!row.productUrl) return { ok: false, why: 'carries a price but links to no listing to have read it from' };

  const graded = gradeAmount(typeof row.price === 'number' ? row.price : NaN);
  if (graded.amount === undefined) {
    return { ok: false, why: `the price is ${JSON.stringify(row.price)}, which is not a numeric currency value` };
  }

  const evidence = row.priceEvidence;
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, why: 'the row records no price provenance, so nothing says where the figure came from' };
  }

  if (String(evidence.currency || '').toUpperCase() !== RENDERS_AS) {
    return { ok: false, why: `the recorded currency is ${evidence.currency || 'unnamed'}, and a card renders $` };
  }

  const recorded = gradeAmount(typeof evidence.amount === 'number' ? evidence.amount : NaN);
  if (recorded.amount === undefined) {
    return { ok: false, why: 'the recorded provenance names no amount that was read' };
  }
  if (recorded.amount !== graded.amount) {
    return { ok: false, why: `the row says ${graded.amount} but its provenance says ${recorded.amount} was read — the figure was changed after it was verified` };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(evidence.asOf || ''))) {
    return { ok: false, why: 'the recorded provenance names no date the price was read' };
  }

  const ids = identifiersFrom(row.productUrl);

  if (evidence.via === 'json-ld-offer' || evidence.via === 'microdata') {
    if (evidence.sku !== undefined) {
      const bare = String(evidence.sku).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!bare) return { ok: false, why: 'the recorded evidence names an empty sku' };
      const matched = ids.find((id) => bare.includes(id) || id.includes(bare));
      if (!matched) {
        return { ok: false, why: `the recorded sku ${evidence.sku} is not a code in this row's own listing URL` };
      }
      return { ok: true, via: evidence.via, how: `its listing's offer record names sku ${evidence.sku}` };
    }
    /* an offer read off the canonical page, with no sku on the record */
    if (!samePage(evidence.canonical, row.productUrl)) {
      return { ok: false, why: `the recorded canonical ${evidence.canonical || '(none)'} is not this row's listing` };
    }
    return { ok: true, via: evidence.via, how: 'it was published by this listing\'s own canonical page' };
  }

  if (evidence.via === 'canonical' || evidence.via === 'rendered price') {
    if (!samePage(evidence.canonical, row.productUrl)) {
      return { ok: false, why: `the recorded canonical ${evidence.canonical || '(none)'} is not this row's listing` };
    }
    return { ok: true, via: evidence.via, how: 'this listing\'s own canonical page published it' };
  }

  return { ok: false, why: `the recorded evidence names no recognised kind (${evidence.via || 'none'})` };
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

  /* ---- what the page is charging ----

     Two readings, kept apart because they are believed differently. The
     microdata one is a claim the page makes in a machine-readable field.
     The heading-block one is what a shopper's eye lands on, and it is
     the riskier of the two, so it is narrowed here rather than in Node:
     only the smallest block containing the product's own <h1>, only
     figures the page draws live, and only ones actually on screen. */
  const MONEY = /(?:[$\u20ac\u00a3\u00a5]|\bUSD\b)\s*\d[\d.,]*|\d[\d.,]*\s*(?:USD|EUR|GBP)\b/;

  /* text beside a figure that says it is not the price being charged */
  const NOISE = /payment|instal?lment|afterpay|klarna|affirm|shipping|deliver|save\b|\boff\b|rrp|msrp|member|reward|point|tax|total|subtotal|per month|\/mo\b|financ/i;

  /* markings that say a figure is the old one, not the live one */
  const STRUCK = /strike|struck|through|\bwas\b|compare|original|list-?price|old-?price|regular-?price|slash|previous/i;

  const microdata = [...document.querySelectorAll('[itemprop="price"]')].map((el) => ({
    content: el.getAttribute('content') || el.getAttribute('value') || el.textContent.trim(),
    currency: (() => {
      const scope = el.closest('[itemtype]') || document;
      const cur = scope.querySelector('[itemprop="priceCurrency"]');
      return cur ? (cur.getAttribute('content') || cur.textContent.trim()) : null;
    })()
  })).filter((e) => e.content);

  const drawnOut = (el) => {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return true;
    const rect = el.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  };

  const looksStruck = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const tag = node.tagName;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') return true;
      const marks = `${typeof node.className === 'string' ? node.className : ''} ${node.getAttribute('data-testid') || ''} ${node.getAttribute('aria-label') || ''}`;
      if (STRUCK.test(marks)) return true;
      const line = window.getComputedStyle(node).textDecorationLine || window.getComputedStyle(node).textDecoration || '';
      if (String(line).includes('line-through')) return true;
    }
    return false;
  };

  /* the innermost elements that wholly contain a figure: an element
     whose own text reads as money and none of whose descendants' does */
  const moneyIn = (block) => [...block.querySelectorAll('*')].filter((el) => {
    const own = (el.textContent || '').trim();
    if (!own || own.length > 120 || !MONEY.test(own)) return false;
    for (const child of el.querySelectorAll('*')) {
      if (MONEY.test((child.textContent || '').trim())) return false;
    }
    return true;
  });

  /* Walk out from the product's own heading until a block containing it
     also contains a figure. The closest such block is the heading block:
     the title and the price a shopper reads as one. Anything further out
     starts taking in the rest of the page. */
  const heading = [];
  const h1 = document.querySelector('h1');
  if (h1) {
    for (let block = h1.parentElement; block && block !== document.documentElement; block = block.parentElement) {
      const found = moneyIn(block);
      if (!found.length) continue;
      for (const el of found) {
        const own = (el.textContent || '').trim();
        const context = `${own} ${el.getAttribute('aria-label') || ''}`;
        if (NOISE.test(context)) continue;
        if (drawnOut(el)) continue;
        heading.push({ text: own, struck: looksStruck(el) });
      }
      break;
    }
  }

  return {
    canonical: text('link[rel="canonical"]', 'href') || metas['og:url'] || null,
    metas,
    jsonld,
    preload,
    imgs,
    prices: { microdata, heading }
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

/* Walks the photo candidates in order and returns the first that clears
   every gate, or the reasons they all failed. */
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

/* ---------- one load of one page ----------

   Both doors report the same four things, so nothing downstream cares
   which one a row came through: what the page says the product is, the
   photos it offers, the prices it offers, and — for the browser — a way
   to check an image from inside the session that loaded the page. */
async function readServed(url) {
  const page = await fetchPage(url);
  if (!page.html) return { failed: page.failed, blocked: page.blocked, refused: page.refused };
  return {
    how: 'plain HTTP',
    facts: factsFromHtml(page.html),
    images: candidatesFrom(page.html, url),
    prices: priceCandidatesFrom(page.html, url),
    verify: null
  };
}

async function readRendered(url) {
  const rendered = await renderPage(url);
  if (rendered.failed) return { failed: rendered.failed, noBrowser: rendered.noBrowser };
  return {
    how: 'a real browser',
    facts: factsFromRendered(rendered.seen),
    images: candidatesFromRendered(rendered.seen, rendered.loaded, url),
    prices: priceCandidatesFromRendered(rendered.seen, url),
    verify: rendered.verify
  };
}

/* ---------- one row ----------

   The photo and the price are pulled out of the SAME reading of the
   page, which is the whole reason a card can claim they belong to each
   other. Where a second reading is needed — the served markup gave up
   nothing, so a browser is sent — it is a second reading of that same
   listing, never of a different page.

   `need` says which fields are still outstanding, so a row that already
   carries a re-proved photo spends its page read on the price alone. */
async function resolveRow(row, need) {
  const want = need || { image: true, price: true };
  const notes = [];
  const facts = { name: null, brand: null };
  const refusals = { image: [], price: [] };
  let image = want.image ? null : { url: row.imageUrl, kept: true, why: 'already accounted for in the catalogue' };
  let price = want.price ? null : { amount: row.price, currency: RENDERS_AS, kept: true, why: 'already accounted for in the catalogue' };

  const outstanding = () => (!image ? 1 : 0) + (!price ? 1 : 0);

  const consider = async (read) => {
    if (read.facts) {
      if (!facts.name) facts.name = read.facts.name;
      if (!facts.brand) facts.brand = read.facts.brand;
    }
    const count = (n, what) => `${n} ${what} candidate${n === 1 ? '' : 's'}`;
    notes.push(`${read.how}: ${count(read.images.length, 'photo')}, ${count(read.prices.length, 'price')}`);

    if (!image) {
      const found = await firstVerifiable(read.images, row, read.verify);
      if (found.url) image = found;
      else refusals.image.push(...(found.refusals || []));
    }
    if (!price) {
      const found = firstVerifiablePrice(read.prices, row.productUrl);
      if (found.amount !== undefined) price = found;
      else refusals.price.push(...(found.refusals || []));
    }
  };

  const done = () => ({
    id: row.id,
    verdict: 'VERIFIED',
    image,
    price,
    facts,
    notes,
    productUrl: row.productUrl
  });

  if (!outstanding()) return done();

  /* ---- plain HTTP ---- */
  const served = await readServed(row.productUrl);
  if (served.blocked) {
    /* the sandbox, not the retailer: a browser here would be refused the
       same way, so say so rather than spending a Chromium on it */
    return {
      id: row.id, verdict: 'FAILED', why: served.failed, blocked: true,
      image: null, price: null, facts, notes, refusals, productUrl: row.productUrl,
      partial: { image, price }
    };
  }
  if (served.failed) notes.push(`plain HTTP: ${served.failed}`);
  else await consider(served);

  if (!outstanding()) return done();

  /* ---- a real browser ---- */
  if (!useBrowser) {
    return {
      id: row.id,
      verdict: 'FAILED',
      why: `${served.failed || 'the served markup did not account for every field'} (browser path off)`,
      image: null, price: null, facts, notes, refusals, productUrl: row.productUrl,
      partial: { image, price }
    };
  }

  const rendered = await readRendered(row.productUrl);
  if (rendered.failed) {
    notes.push(`browser: ${rendered.failed}`);
    return {
      id: row.id,
      verdict: 'FAILED',
      why: served.failed && rendered.noBrowser
        ? `${served.failed}, and ${rendered.failed}`
        : rendered.failed,
      image: null, price: null, facts, notes, refusals, productUrl: row.productUrl,
      partial: { image, price }
    };
  }
  await consider(rendered);

  if (!outstanding()) return done();

  /* A row takes its photo and its price together or takes neither. Half
     a hydration is a card showing one thing it verified beside another
     it did not, and that reads as finished when it is not. */
  const missing = [!image ? 'photo' : null, !price ? 'price' : null].filter(Boolean);
  const counted = refusals.image.length + refusals.price.length;
  return {
    id: row.id,
    verdict: 'FAILED',
    why: `no ${missing.join(' and no ')} cleared every gate` + (counted ? ` (${counted} candidate${counted === 1 ? '' : 's'} refused)` : ''),
    image: null, price: null, facts, notes, refusals, productUrl: row.productUrl,
    /* what DID verify is reported but not written, so the next run has
       somewhere to start and the file is left honest meanwhile */
    partial: { image, price }
  };
}

/* ---------- writing it back ----------

   A targeted edit, not a re-serialisation: the file keeps its comments,
   its spacing and its row order, and only the fields belonging to the
   row being filled are touched. The row is located by its id, and the
   first field of each name after that id is the one it owns. */
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
  out = setNote(out, id, 'imageEvidence', 'imageUrl', evidenceNote(evidence), indent);
  return out;
}

/* The price, and the note that accounts for it. Unlike a photo this one
   is never optional: a number cannot carry its own provenance, so a
   price written without a note would be indistinguishable from a price
   somebody typed in, which is the thing this is for. */
function writePriceInto(source, id, amount, evidence) {
  const idAt = source.indexOf(`id: '${id}'`);
  if (idAt === -1) throw new Error(`could not find the row for ${id}`);

  const graded = gradeAmount(typeof amount === 'number' ? amount : NaN);
  if (graded.amount === undefined) {
    throw new Error(`refusing to write ${JSON.stringify(amount)} as a price for ${id}: ${graded.why}`);
  }

  const note = priceEvidenceNote(evidence);
  if (!note) throw new Error(`refusing to write a price for ${id} with no provenance to account for it`);

  const field = /(\n\s*price:\s*)(null|-?\d+(?:\.\d+)?)/;
  const rest = source.slice(idAt);
  const m = rest.match(field);
  if (!m) throw new Error(`could not find a price for ${id}`);

  const at = idAt + m.index;
  const indent = m[1].replace(/\n/, '').replace(/price:\s*$/, '');
  let out = source.slice(0, at) + m[1] + formatAmount(graded.amount) + source.slice(at + m[0].length);
  out = setNote(out, id, 'priceEvidence', 'price', note, indent);
  return out;
}

/* A row takes its photo and its price together, so the write does too: a
   file is never left with one field of a pair in it. */
function writeRow(source, id, result) {
  let out = source;
  if (result.image && !result.image.kept) out = writeInto(out, id, result.image.url, result.image.identity);
  if (result.price && !result.price.kept) out = writePriceInto(out, id, result.price.amount, result.price.identity);
  return out;
}

/* money the way the interface reads it back: whole amounts stay whole,
   and anything else keeps its cents rather than trailing a lone digit */
function formatAmount(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/* where the row that starts at idAt stops: the next row's id, or the end
   of the file. Every row carries exactly one id, so this needs no
   brace counting. */
function rowEndsAt(source, idAt) {
  const next = source.indexOf("id: '", idAt + 1);
  return next === -1 ? source.length : next;
}

/* the photo evidence worth keeping: the kinds a shipped row can be
   re-proved against without the page in front of it */
function evidenceNote(evidence) {
  if (!evidence || !evidence.ok) return null;
  if (evidence.via === 'json-ld-sku' && evidence.sku) {
    return `{ via: 'json-ld-sku', sku: '${quotable(evidence.sku)}' }`;
  }
  if (evidence.via === 'canonical' && evidence.canonical) {
    return `{ via: 'canonical', canonical: '${quotable(evidence.canonical)}' }`;
  }
  return null; // via: 'image-url' — the URL is its own evidence
}

/* The price's note. It records the amount that was read as well as how
   it was read, because that is what makes a later edit to the number
   detectable: the note goes on naming the figure the page published. */
function priceEvidenceNote(evidence) {
  if (!evidence || !evidence.ok) return null;
  const graded = gradeAmount(typeof evidence.amount === 'number' ? evidence.amount : NaN);
  if (graded.amount === undefined) return null;
  if (String(evidence.currency || '').toUpperCase() !== RENDERS_AS) return null;

  const parts = [`via: '${quotable(evidence.via)}'`];
  if (evidence.sku) parts.push(`sku: '${quotable(evidence.sku)}'`);
  else if (evidence.canonical) parts.push(`canonical: '${quotable(evidence.canonical)}'`);
  else return null; // nothing to re-prove it against
  parts.push(`amount: ${formatAmount(graded.amount)}`);
  parts.push(`currency: '${RENDERS_AS}'`);
  parts.push(`asOf: '${quotable(evidence.asOf || TODAY)}'`);
  return `{ ${parts.join(', ')} }`;
}

const quotable = (value) => String(value).replace(/['\r\n]/g, '');

/* Writes, replaces or removes a row's note field, keeping the file's
   shape: the note sits directly under the field it explains. */
function setNote(source, id, field, after, note, indent) {
  const idAt = source.indexOf(`id: '${id}'`);
  /* bounded to THIS row. The field it explains exists on every row so
     the first one after the id is always the right one, but the note
     does not: searched to the end of the file, a row with no note would
     find the next row's and rewrite that one instead. */
  const rest = source.slice(idAt, rowEndsAt(source, idAt));
  const existing = rest.match(new RegExp(`\\n\\s*${field}:\\s*(\\{[^}]*\\}|null),?`));

  if (existing) {
    const at = idAt + existing.index;
    const replacement = note ? `\n${indent}${field}: ${note},` : '';
    return source.slice(0, at) + replacement + source.slice(at + existing[0].length);
  }
  if (!note) return source;

  const anchor = rest.match(new RegExp(`(\\n\\s*${after}:\\s*(?:null|-?\\d+(?:\\.\\d+)?|'[^']*'|"[^"]*"),)`));
  if (!anchor) return source;
  const at = idAt + anchor.index + anchor[0].length;
  return source.slice(0, at) + `\n${indent}${field}: ${note},` + source.slice(at);
}

/* kept for the shape the image path already had */
function setEvidence(source, id, note, indent) {
  return setNote(source, id, 'imageEvidence', 'imageUrl', note, indent);
}

/* ---------- giving a row a listing ----------

   A sample row names a garment nobody sells: "Boxy Cotton Tee" by
   "Northfold" is a shape in the demo's vocabulary, not a product. To
   become real it needs a listing, and a listing has to be FOUND rather
   than composed — there is no URL that can be derived from a made-up
   brand and a category.

   So candidates come from outside: a list the operator supplies, or a
   configured product search source. What they supply is a URL and
   nothing else. The name, the brand, the photo and the price are then
   read off the page that URL opens, through the same gates every other
   row goes through. A search result's own title, thumbnail and price are
   never written — they are that source's record of a product, not the
   retailer's page, and the brief is the retailer's page.

   A candidate becomes the row only when all of it holds together: the
   page opens, it is a product page on a retailer rather than a
   comparison or a redirect, it names the product and its brand, its
   photo and its price both clear their gates, and what it is selling is
   recognisably the garment the row was describing. */

/* the garment words a category actually appears as on a retailer's page */
const CATEGORY_WORDS = {
  tee: ['tee', 't-shirt', 'tshirt', 'shirt'],
  shirt: ['shirt', 'blouse', 'button-down', 'button down', 'oxford', 'poplin'],
  knit: ['knit', 'sweater', 'jumper', 'cardigan', 'pullover', 'hoodie', 'sweatshirt'],
  jacket: ['jacket', 'blazer', 'puffer', 'anorak', 'windbreaker'],
  coat: ['coat', 'overcoat', 'parka', 'trench'],
  dress: ['dress', 'gown'],
  trousers: ['trouser', 'trousers', 'pant', 'pants', 'chino', 'chinos', 'jean', 'jeans', 'sweatpant', 'sweatpants', 'joggers'],
  skirt: ['skirt'],
  shorts: ['short', 'shorts'],
  sneaker: ['sneaker', 'sneakers', 'trainer', 'trainers', 'shoe', 'shoes']
};

const words = (text) => String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];

/* Is the page selling the garment this row was describing? Not a
   likeness test and not a search ranking — the row's category has to be
   what the page is selling, and enough of the row's own words have to
   turn up in the page's name that the two are plainly the same idea.

   This is the gate that stops "Boxy Cotton Tee" quietly becoming a pair
   of socks because a search source ranked them together. */
function relevance(row, facts) {
  const name = String(facts && facts.name ? facts.name : '');
  if (!name) return { ok: false, why: 'the page named no product' };

  const haystack = name.toLowerCase();
  const wanted = CATEGORY_WORDS[row.category];
  if (wanted && !wanted.some((word) => haystack.includes(word))) {
    return { ok: false, why: `the page is selling "${name}", which is not ${row.category} (looked for ${wanted.slice(0, 3).join(', ')})` };
  }

  const categoryWords = new Set(wanted || []);
  const own = words(row.name).filter((w) => w.length >= 3 && !categoryWords.has(w));
  if (!own.length) {
    return { ok: true, how: `it is ${row.category}, which is all the row's name said` };
  }

  const theirs = new Set(words(name));
  const shared = own.filter((w) => theirs.has(w));
  if (!shared.length || shared.length * 2 < own.length) {
    return {
      ok: false,
      why: `"${name}" shares ${shared.length} of the row's ${own.length} descriptive words (${own.join(', ')}), too few to be the same garment`
    };
  }

  return { ok: true, how: `it is ${row.category} and shares ${shared.join(', ')} with the row's own name` };
}

/* Candidate listings for a row, best first: whatever the operator named
   for it, then whatever a configured search source finds. Both are
   URLs only — nothing else from either is kept. */
async function candidateListings(row, supplied) {
  const out = [];
  const seen = new Set();
  const add = (url, where) => {
    const text = String(url || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ url: text, where });
  };

  for (const url of (supplied && supplied[row.id]) || []) add(url, 'the candidates file');

  const searched = await searchListings(row);
  for (const url of searched.urls) add(url, `the ${searched.source} search source`);
  if (searched.why) out.note = searched.why;

  return out;
}

/* Asks whichever product source is configured for listings matching the
   row's own concept. Its records are read for ONE field — the retailer
   URL — and everything else it returns is discarded unread. */
async function searchListings(row) {
  let source;
  try {
    source = require('../api/_providers/product-source');
  } catch (err) {
    return { urls: [], why: 'the product source layer could not be loaded' };
  }

  const provider = source.getProvider();
  if (!provider || provider.name === 'none' || (provider.configured && !provider.configured())) {
    return { urls: [], why: 'no product search source is configured (set PRODUCT_SOURCE and its key), so only the candidates file is used' };
  }

  /* the row's concept, minus its brand: a sample row's brand is invented,
     and filtering a real search by it would return nothing or, worse,
     something from a shop that happens to share the name */
  const intent = {
    categories: row.category ? [row.category] : [],
    styles: row.style || [],
    occasions: row.occasion || [],
    fits: row.fit || [],
    colors: row.colors || [],
    brands: [],
    keywords: words(row.name)
  };

  let records;
  try {
    records = await provider.search(intent, { limit: 10 });
  } catch (err) {
    return { urls: [], why: `the ${provider.name} search source failed (${err && err.message ? String(err.message).split('\n')[0] : 'unknown'})` };
  }

  const urls = [];
  for (const record of records || []) {
    const href = record && (record.productUrl || record.url || record.link);
    if (!href) continue;
    urls.push(String(href));
  }
  return { urls, source: provider.name };
}

/* Is this a page that could be a row's listing at all? The link rules
   the product gate already applies to a live search result, applied
   here for the same reason: a comparison page, a redirector or a
   category listing is not the product the card would claim to show. */
function listingFault(href) {
  let url;
  try { url = new URL(href); } catch (err) { return 'it is not a URL'; }
  if (url.protocol !== 'https:') return `${url.protocol}// is not a retailer product page`;

  const host = url.hostname.toLowerCase();
  if (NOT_THE_RETAILER.some((bad) => host === bad || host.endsWith('.' + bad))) {
    return `${host} indexes shops rather than being one`;
  }

  try {
    const fault = require('../api/_providers/product-source').linkFault(href);
    if (fault) return fault.replace(/-/g, ' ').replace(/^product url /, 'the link ');
  } catch (err) { /* the layer is optional; the checks above still ran */ }

  return null;
}

/* One candidate listing, put through every gate a shipped row is held
   to, and reported as the row it WOULD become. Nothing is written here. */
async function inspectListing(productUrl, row) {
  const fault = listingFault(productUrl);
  if (fault) return { verdict: 'FAILED', why: fault, productUrl };

  const result = await resolveRow(Object.assign({}, row, { productUrl }), { image: true, price: true });
  if (result.verdict !== 'VERIFIED') {
    return Object.assign({}, result, { productUrl });
  }

  const facts = result.facts || {};
  if (!facts.name) return { verdict: 'FAILED', why: 'the page named no product, so the row would have no name', productUrl, notes: result.notes };
  if (!facts.brand) return { verdict: 'FAILED', why: 'the page named no brand, and a brand is not something to fill in', productUrl, notes: result.notes };

  const fits = relevance(row, facts);
  if (!fits.ok) return { verdict: 'FAILED', why: fits.why, productUrl, notes: result.notes };

  return {
    verdict: 'VERIFIED',
    productUrl,
    notes: result.notes,
    relevance: fits,
    replacement: {
      productUrl,
      name: facts.name,
      brand: facts.brand,
      imageUrl: result.image.url,
      imageEvidence: result.image.identity,
      price: result.price.amount,
      priceEvidence: result.price.identity
    },
    image: result.image,
    price: result.price,
    facts
  };
}

/* Walks a row's candidate listings and takes the first that becomes a
   whole row, keeping why each of the others did not. */
async function discoverListing(row, supplied) {
  const candidates = await candidateListings(row, supplied);
  if (!candidates.length) {
    return { verdict: 'SKIPPED', why: candidates.note || 'no candidate listing was offered for this row', tried: [] };
  }

  const tried = [];
  for (const candidate of candidates) {
    const looked = await inspectListing(candidate.url, row);
    if (looked.verdict === 'VERIFIED') return Object.assign({}, looked, { tried, from: candidate.where });
    tried.push({ url: candidate.url, where: candidate.where, why: looked.why || 'it did not verify' });
  }

  return { verdict: 'FAILED', why: `${tried.length} candidate listing${tried.length === 1 ? '' : 's'} offered, none became a whole row`, tried };
}

/* Swaps a row's product for a verified candidate: the listing, the
   photo, the price, the name and the brand move together, because half
   a swap is a row that points at one product and pictures another. */
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
  if (next.imageUrl) out = writeInto(out, id, next.imageUrl, next.imageEvidence);
  if (next.price != null) out = writePriceInto(out, id, next.price, next.priceEvidence);
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

/* ---------- what a row already has ----------

   A re-run should cost nothing on a row that is already right, and
   should notice a row that only looks right. Both come from the same
   question: does what this row carries still account for itself?

   The photo re-proves through its URL or its note; the price re-proves
   through its note and the amount that note names. A field that does not
   re-prove is treated as absent, so a hand-edited price is re-read from
   the page rather than trusted for having been in the file. */
function accountedFor(row) {
  const photo = catalogRowIdentity(row);
  const money = catalogRowPrice(row);
  return {
    image: Boolean(row.imageUrl) && photo.ok,
    price: row.price !== null && row.price !== undefined && money.ok,
    imageWhy: row.imageUrl && !photo.ok ? photo.why : null,
    priceWhy: (row.price !== null && row.price !== undefined) && !money.ok ? money.why : null
  };
}

/* The operator's own candidate listings: { "<row id>": ["<url>", ...] }.
   An array of { id, url } is accepted too, because that is the shape a
   spreadsheet export lands in. */
function readCandidatesFile(where) {
  const from = where === undefined ? candidatesFile : where;
  if (!from) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(from, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${from}: ${err && err.message}`);
  }

  const out = {};
  const add = (id, url) => {
    if (!id || !url) return;
    (out[id] = out[id] || []).push(String(url));
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const urls = entry.urls || entry.url || entry.productUrl;
      for (const url of Array.isArray(urls) ? urls : [urls]) add(entry.id, url);
    }
    return out;
  }

  for (const [id, urls] of Object.entries(parsed || {})) {
    for (const url of Array.isArray(urls) ? urls : [urls]) add(id, url);
  }
  return out;
}

/* ---------- report ----------

   Every row gets a line, whatever happened to it, because a catalogue
   is only as good as the row nobody looked at. A verified row shows the
   three things it verified — where it points, what it pictures, what it
   costs — so the report can be read instead of the file. */

const PAD = 13;
const gutter = ''.padEnd(PAD);

function say(verdict, headline) {
  console.log(`  ${String(verdict).padEnd(PAD)}${headline}`);
}

function detail(label, value) {
  console.log(`  ${gutter}${String(label).padEnd(9)}${value}`);
}

function reportRefusals(refusals, limit) {
  const list = refusals || [];
  for (const refusal of list.slice(0, limit)) {
    const what = refusal.url ? short(refusal.url) : refusal.amount;
    console.log(`  ${gutter}  [${refusal.gate}] ${what}`);
    console.log(`  ${gutter}    from ${refusal.from} — ${refusal.why}`);
  }
  const extra = list.length - limit;
  if (extra > 0) console.log(`  ${gutter}  …and ${extra} more`);
}

/* one row, reported */
function reportRow(row, outcome) {
  say(outcome.verdict, `${row.brand} — ${String(row.name).slice(0, 44)}`);
  for (const note of outcome.notes || []) console.log(`  ${gutter}· ${note}`);

  if (outcome.verdict === 'VERIFIED') {
    const next = outcome.replacement;
    detail('product', next ? next.productUrl : row.productUrl);
    detail('photo', short(next ? next.imageUrl : outcome.image.url));
    const amount = next ? next.price : outcome.price.amount;
    detail('price', `$${formatAmount(amount)}`);
    if (next) {
      detail('name', next.name);
      detail('brand', next.brand);
      if (outcome.relevance) console.log(`  ${gutter}  ${outcome.relevance.how}`);
    }
    if (outcome.image && outcome.image.why && !outcome.image.kept) console.log(`  ${gutter}  photo: ${outcome.image.why}`);
    if (outcome.price && outcome.price.why && !outcome.price.kept) console.log(`  ${gutter}  price: ${outcome.price.why}`);
    return;
  }

  console.log(`  ${gutter}${outcome.why}`);

  const partial = outcome.partial || {};
  if (partial.image) {
    console.log(`  ${gutter}  photo ${partial.image.kept ? 'already accounted for' : 'did verify'}: ${short(partial.image.url)}`);
  }
  if (partial.price) {
    console.log(`  ${gutter}  price ${partial.price.kept ? 'already accounted for' : 'did verify'}: $${formatAmount(partial.price.amount)}`);
  }

  const refusals = outcome.refusals || {};
  if ((refusals.image || []).length) {
    console.log(`  ${gutter}  photo candidates refused:`);
    reportRefusals(refusals.image, 6);
  }
  if ((refusals.price || []).length) {
    console.log(`  ${gutter}  price candidates refused:`);
    reportRefusals(refusals.price, 6);
  }
  for (const attempt of (outcome.tried || []).slice(0, 6)) {
    console.log(`  ${gutter}  ${short(attempt.url)}`);
    console.log(`  ${gutter}    from ${attempt.where} — ${attempt.why}`);
  }
}

/* ---------- one row, start to finish ---------- */
async function hydrateRow(row, supplied) {
  const have = accountedFor(row);
  const notes = [];
  /* Only worth saying on a row that DOES link to a listing: there it is a
     discrepancy between what the row claims and what it can prove. On an
     unlinked row it is just the definition of a sample row, and the skip
     reason below already says so. */
  if (row.productUrl && have.imageWhy) notes.push(`the photo it carries is not accounted for: ${have.imageWhy}`);
  if (row.productUrl && have.priceWhy) notes.push(`the price it carries is not accounted for: ${have.priceWhy}`);

  /* ---- a row that links nowhere needs a listing before anything else ---- */
  if (!row.productUrl) {
    if (!discovering) {
      const priced = row.price !== null && row.price !== undefined;
      return {
        verdict: 'SKIPPED',
        notes,
        why: `it links to no listing, so there is no page to read a photo${priced ? ' off and nothing to account for the price it shows' : ' or a price off'} — pass --discover to give it one`
      };
    }
    const found = await discoverListing(row, supplied);
    return Object.assign({ notes: notes.concat(found.notes || []) }, found);
  }

  /* ---- a row already accounted for is left alone ---- */
  const need = refreshing ? { image: true, price: true } : { image: !have.image, price: !have.price };
  if (!need.image && !need.price) {
    return {
      verdict: 'VERIFIED',
      notes,
      kept: true,
      image: { url: row.imageUrl, kept: true },
      price: { amount: row.price, kept: true }
    };
  }

  const result = await resolveRow(row, need);
  return Object.assign({}, result, { notes: notes.concat(result.notes || []) });
}

async function main() {
  const supplied = readCandidatesFile();

  /* --candidate <url> [--as <row-id>] : try one listing against one row */
  const single = flag('--candidate');
  if (single) {
    const forId = flag('--as');
    const { source: current, rows: currentRows } = readCatalog();
    const target = forId ? currentRows.find((r) => r.id === forId) : null;
    if (forId && !target) throw new Error(`no catalogue row has the id ${forId}`);

    console.log(`\nTrying ${single}${forId ? ` as a replacement for ${forId}` : ''}.\n`);
    const looked = await inspectListing(single, target || { id: 'candidate', name: '', category: '', brand: '—' });
    reportRow(target || { brand: '—', name: single }, looked);

    if (looked.verdict !== 'VERIFIED' || !forId) {
      if (looked.verdict === 'VERIFIED' && !forId) console.log('\n  Pass --as <row-id> to see it written into a row.\n');
      else console.log('\n  Not usable as a replacement.\n');
      return;
    }
    if (!writing) {
      console.log(`\n  Re-run with --write to put it into ${forId}.\n`);
      return;
    }
    fs.writeFileSync(CATALOG, replaceRow(current, forId, looked.replacement));
    console.log(`\n  Replaced ${forId} — listing, photo, price, name and brand together.\n`);
    return;
  }

  const { source, rows } = readCatalog();
  const targets = only ? rows.filter((r) => r.id === only) : rows;
  if (only && !targets.length) throw new Error(`no catalogue row has the id ${only}`);

  console.log(`\nHydrating ${targets.length} catalogue row${targets.length === 1 ? '' : 's'}${writing ? ', and writing what verifies' : ''}.`);
  console.log(useBrowser ? 'A page that gives up nothing over plain HTTP is opened in a real browser.' : 'Plain HTTP only (--no-browser).');
  console.log(discovering
    ? 'Rows that link nowhere are given a listing from a candidate, then read like any other.'
    : 'Rows that link nowhere are left alone — pass --discover to give them a listing.');
  if (Object.keys(supplied).length) {
    console.log(`${Object.keys(supplied).length} row${Object.keys(supplied).length === 1 ? ' has' : 's have'} candidate listings from ${candidatesFile}.`);
  }
  console.log('');

  const outcomes = [];
  for (const row of targets) {
    const outcome = await hydrateRow(row, supplied);
    outcomes.push({ row, outcome });
    reportRow(row, outcome);
  }

  /* ---- the tally ---- */
  const tally = { VERIFIED: 0, SKIPPED: 0, FAILED: 0 };
  for (const { outcome } of outcomes) tally[outcome.verdict] = (tally[outcome.verdict] || 0) + 1;

  console.log('\n  ' + ['VERIFIED', 'SKIPPED', 'FAILED'].map((k) => `${tally[k]} ${k}`).join(', '));

  const whole = outcomes.filter(({ outcome }) => outcome.verdict === 'VERIFIED');
  console.log(`  ${whole.length} of ${targets.length} row${targets.length === 1 ? '' : 's'} ${whole.length === 1 ? 'carries' : 'carry'} a real photo, a real price and a direct retailer link`);

  const blocked = outcomes.filter(({ outcome }) => outcome.blocked);
  if (blocked.length) {
    const hosts = [...new Set(blocked.map(({ row }) => new URL(row.productUrl).hostname))].join(', ');
    console.log('\n  FAILED here is this machine, not the listings: ' + hosts);
    console.log('  is refused by the network egress policy, and a real browser is refused the');
    console.log('  same way. Run this from an ordinary connection, or allow those hosts.');
  }

  /* ---- writing ---- */
  const fresh = whole.filter(({ outcome }) => !outcome.kept);
  if (!writing) {
    console.log(fresh.length
      ? `\n  Re-run with --write to put ${fresh.length} row${fresh.length === 1 ? '' : 's'} into assets/catalog.js.\n`
      : '\n  Nothing new verified, so there is nothing to write.\n');
    return;
  }

  if (!fresh.length) {
    console.log('\n  Nothing new verified — assets/catalog.js is left exactly as it was.');
    console.log('  A row only gets what was read off the retailer\'s own page.\n');
    return;
  }

  let next = source;
  for (const { row, outcome } of fresh) {
    next = outcome.replacement
      ? replaceRow(next, row.id, outcome.replacement)
      : writeRow(next, row.id, outcome);
  }
  fs.writeFileSync(CATALOG, next);
  console.log(`\n  Wrote ${fresh.length} row${fresh.length === 1 ? '' : 's'} into assets/catalog.js.`);
  console.log('  Nothing that failed a gate was written.\n');
}

/* The gates are the part worth testing, and they are all decidable
   without a retailer: what the markup offers, which hosts are refused,
   whether a photo and a price belong to this product, and what the file
   looks like afterwards. Required as a module it hands those over and
   runs nothing. */
if (require.main === module) {
  main().catch((err) => { console.error(err && err.message); process.exit(1); });
} else {
  module.exports = {
    candidatesFrom, candidatesFromRendered, soundness, writeInto, verifyImage,
    largestFromSrcset, readCatalog, identifiersFrom, identityEvidence, samePage,
    gatherInPage, renderPage, resolveRow, firstVerifiable,
    replaceRow, factsFromHtml, factsFromRendered,
    catalogRowIdentity, evidenceNote, setEvidence,

    /* the price half */
    parseAmount, gradeAmount, currencyOf, offersOf, priceCandidatesFrom,
    priceCandidatesFromRendered, priceSoundness, priceIdentity,
    firstVerifiablePrice, catalogRowPrice, priceEvidenceNote, writePriceInto,
    writeRow, formatAmount, accountedFor,

    /* giving a row a listing */
    relevance, listingFault, inspectListing, discoverListing, readCandidatesFile
  };
}
