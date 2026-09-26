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

   --discover fills three fields and no others: productUrl, imageUrl and
   the imageEvidence that ties the second to the first. A sample row's
   id, name, brand, price, category, style, occasion, fit, colours and
   sizes are the demo's own and are never renamed after whichever shop
   happened to stock a match. The evidence is not optional — a photo
   whose URL does not carry the listing's code cannot be re-proved
   without it, and a row that cannot be re-proved is one --coverage
   reports as unaccounted.

   --discover adds one more gate, ahead of those four, because those
   four cannot ask it: whether the listing is the GARMENT the row means.
   A photo can be provably this listing's own and still be the wrong
   answer, which is how "Fleece Sweatpant" came back as Aerie's "Street
   Trouser". So a candidate is read as a garment — type, family,
   audience, material, and the descriptors that exclude one another —
   and refused before its page is ever fetched when the reading
   contradicts the row's. Brand is deliberately not compared: the sample
   brands were invented.

   A word the row states that the title merely does not say is a
   different matter, and it is settled in two stages. The title stage
   marks it pending; the page stage looks for it in the product's own
   record, description, attributes and material fields, and the
   candidate passes only once every one of them is established. Nothing
   waives that. A title is a headline — "Real Soft Jogger" is a fleece
   jogger or it is not, and only its page will say.

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

   Discovery and writing are two commands, and only the first one costs
   anything. A --discover run writes what cleared every gate into a
   temporary report, and --discover --write puts that report into the
   catalogue without searching, fetching or rendering anything — so
   keeping a result no longer means paying for the search that found it
   a second time. Nothing in the report is taken on faith: every gate
   that can be decided without a retailer is decided again on the way
   in, and an entry that cannot answer for itself is refused and its row
   left exactly as it was.

   Everything here has a ceiling and a row has a clock. A shop that
   accepts a connection and then says nothing costs its ceiling and no
   more; a row that spends its clock reports what it managed rather than
   holding up the rows behind it. A few candidates are read at once, and
   the answer is still the EARLIEST that cleared every gate rather than
   the first to come back — ranking is a gate, and a quicker CDN is not
   an argument about which garment a listing sells.

   Run it from a machine with an ordinary internet connection. Behind a
   proxy that refuses retailer hosts every row comes back UNREACHABLE,
   and the report is about the proxy rather than about the catalogue.

   Usage
     node scripts/fetch-catalog-images.js
     node scripts/fetch-catalog-images.js --write
     node scripts/fetch-catalog-images.js --discover          finds, and saves what it proved
     node scripts/fetch-catalog-images.js --discover --write  writes that, searching nothing
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

/* Where a --discover run leaves what it proved, so --write can put it
   into the catalogue without asking the internet a second time. It is a
   hand-off between two commands rather than a second catalogue: named
   for being temporary, gitignored, and believed by nothing. */
const DEFAULT_REPORT = path.join(__dirname, '..', '.catalog-discovery.tmp.json');
const REPORT_VERSION = 1;

/* A hand-off is minutes old, not days. Past this the listings behind it
   have had time to move, and a photo proved against a page that has
   since changed is not a proved photo — so it is refused rather than
   written, and a fresh --discover is the operator's call to make. */
const REPORT_TTL_MS = 24 * 60 * 60 * 1000;

/* ---------- what any one thing is allowed to take ----------

   Every number here is a ceiling, never a wait: nothing sleeps for its
   timeout, and a fast retailer is as fast as it ever was. What they buy
   is that no single slow shop can hold up the row behind it, and that a
   run's worst case can be worked out on paper rather than discovered at
   minute thirty-five.

   They are ceilings on WORK, not on judgement. Nothing here decides
   whether a photo is this product's, whether a listing is the garment
   the row means, or whether a page vouches for its own image — a
   candidate that runs out of time is refused, exactly as one that
   answered wrongly is. Running out of time never admits anything. */
const TIMEOUT = 20000;          // one plain HTTP read of a retailer's page, headers AND body
const IMAGE_TIMEOUT = 10000;    // a product photo either serves or it does not
const SEARCH_TIMEOUT = 15000;   // one question put to the product source
const BROWSER_TIMEOUT = 45000;  // page.goto, still capped by what is left of the render budget
const RENDER_BUDGET = 30000;    // one page in a real browser, from launch to close
const SETTLE_TIMEOUT = 6000;    // waiting for the network to go quiet after load
const SETTLE_AFTER_SCROLL = 3000; // and again after the lazy-load walk
const ROW_BUDGET = 120000;      // one catalogue row's whole discovery
const LANES = 3;                // how many network operations are allowed at once

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

/* ---------- the command line ----------

   Read once, in both spellings and any case, and an option nobody
   recognises STOPS the run. An ignored option is a different command
   than the one that was typed, and a flag that swallows the next token
   whatever it is turns --only --write into a row id. */
const OPTIONS = {
  '--help': 'boolean',
  '--write': 'boolean',
  '--refresh': 'boolean',
  '--no-browser': 'boolean',
  '--discover': 'boolean',
  '--coverage': 'boolean',
  '--only': 'value',
  '--site': 'value',
  '--candidate': 'value',
  '--as': 'value',
  '--limit': 'value',
  '--report': 'value',
  '--diagnose': 'boolean'
};

function parseArgs(argv) {
  const flags = {};
  const errors = [];

  for (let at = 0; at < argv.length; at += 1) {
    const token = String(argv[at]);
    if (!token.startsWith('--')) {
      errors.push(`stray argument "${token}" — options are written --like-this`);
      continue;
    }
    const equals = token.indexOf('=');
    const name = (equals >= 0 ? token.slice(0, equals) : token).toLowerCase();
    let value = equals >= 0 ? token.slice(equals + 1) : undefined;

    const kind = OPTIONS[name];
    if (!kind) { errors.push(`unknown option "${name}"`); continue; }
    if (kind === 'boolean') {
      if (value !== undefined) errors.push(`${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (value === undefined) {
      const next = argv[at + 1];
      if (next !== undefined && !String(next).startsWith('--')) { value = String(next); at += 1; }
    }
    flags[name] = value === undefined || value === '' ? null : value;
  }
  return { flags, errors };
}

const USAGE = `
  Fynd — read each catalogue row's photo off the retailer's own page

    --only <row-id>      just this row
    --refresh            re-read rows that already carry a photo
    --no-browser         plain HTTP only, no Chromium
    --write              write what verified into assets/catalog.js.
                         With --discover it applies the report the last
                         --discover saved and searches nothing.
    --site <origin>      the origin an image is hotlink-tested for

    --candidate <productUrl> --as <row-id>
                         try one replacement listing through the gates

    --discover           for rows carrying no photo, ask the configured
                         product source for real listings. When that
                         source reports its search allowance exhausted
                         and SERPER_API_KEY is set, Serper is asked for
                         the rest of the run — through every one of the
                         same gates, with nothing relaxed. Each is read
                         as a garment first, and only one that is the
                         garment the row means goes on to the same four
                         gates. Every candidate's semantic verdict is
                         printed. A row that already carries a photo is
                         never touched. Needs
                         PRODUCT_SOURCE and its key; --limit <n> sets how
                         many listings to try per row (default 8).

    --report <file>      where --discover writes down what it proved,
                         and where --discover --write reads it back from
                         (default .catalog-discovery.tmp.json)

    --diagnose           TEMPORARY. With --discover or --candidate, say
                         which gate refused each image candidate and what
                         kind of evidence offered it, and write it all to
                         .catalog-image-diagnosis.tmp.json. Reports only:
                         no gate reads anything it records.

    --coverage           how many rows carry a verified photo, and
                         whether each still accounts for itself. Reads
                         nothing but the catalogue.

    --help               this

  Options may be written --flag value or --flag=value.
`;

const args = process.argv.slice(2);
const parsedArgs = parseArgs(args);
const has = (name) => Object.prototype.hasOwnProperty.call(parsedArgs.flags, name);
const flag = (name) => (has(name) ? parsedArgs.flags[name] : null);

const site = flag('--site') || DEFAULT_SITE;
const only = flag('--only');
const writing = has('--write');
const refreshing = has('--refresh');
const useBrowser = !has('--no-browser');
const diagnosing = has('--diagnose');
const reportFile = flag('--report') ? path.resolve(String(flag('--report'))) : DEFAULT_REPORT;

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
    /* `shape` is for the diagnostics tally only */
    const take = (v) => {
      if (typeof v === 'string') found.push({ url: v, node, shape: 'string' });
      else if (v && typeof v === 'object' && typeof v.url === 'string') found.push({ url: v.url, node, shape: 'ImageObject' });
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

/* ---------- is this page a product page at all? ----------

   The canonical rule lets a page vouch for its own og:image. That is
   only worth anything when the page is a PRODUCT page. A live run
   accepted "Utility Pants vs. Cargo Pants", an article on a trade
   publication, because it declared itself canonical and carried an
   og:image — an article vouching for its own illustration.

   What the page says it is, read from its structured data and its
   Open Graph type: a product (JSON-LD Product, ProductGroup, Offer; og
   type product; a product price in its metas; a schema.org Product
   itemtype), or an article, blog, guide, FAQ, collection or search
   results page. An article that marks up a Product it reviews is still
   an article. */
const PRODUCT_TYPES = /^(product|productgroup|individualproduct|productmodel|someproducts|offer|aggregateoffer)$/i;
const NOT_PRODUCT_TYPES = /^(article|newsarticle|blogposting|blog|report|techarticle|scholarlyarticle|analysisnewsarticle|opinionnewsarticle|reviewnewsarticle|liveblogposting|faqpage|qapage|howto|collectionpage|searchresultspage)$/i;

function pageDeclarations(nodes, metas, html) {
  const types = new Set();
  for (const node of nodes || []) {
    for (const type of [].concat(node && node['@type'] ? node['@type'] : [])) types.add(String(type).replace(/^.*[/#]/, ''));
  }
  const meta = (name) => {
    const value = metas && (metas[name] || metas[name.toLowerCase()]);
    return value ? String(value).trim().toLowerCase() : '';
  };
  const ogType = meta('og:type');
  const productType = [...types].find((type) => PRODUCT_TYPES.test(type));
  const articleType = [...types].find((type) => NOT_PRODUCT_TYPES.test(type));
  const priced = ['product:price:amount', 'og:price:amount', 'product:retailer_item_id'].find((name) => meta(name));
  const itemtype = html && /itemtype=["']https?:\/\/schema\.org\/Product["']/i.test(html);

  const declaresArticle = articleType ? `its structured data calls it ${articleType}`
    : /^(article|blog|website:article)/.test(ogType) ? `its og:type is ${ogType}` : null;
  const declaresProduct = productType ? `its structured data describes a ${productType}`
    : /^(product|og:product|product\.)/.test(ogType) ? `its og:type is ${ogType}`
      : priced ? `it publishes ${priced}`
        : itemtype ? 'its markup is a schema.org Product' : null;
  return { declaresProduct, declaresArticle };
}

function pageDeclarationsFromHtml(html) {
  const metas = {};
  for (const name of ['og:type', 'product:price:amount', 'og:price:amount', 'product:retailer_item_id']) {
    const value = metaContent(html, name);
    if (value) metas[name] = decode(value);
  }
  return pageDeclarations(jsonLdNodes(html), metas, html);
}

function pageDeclarationsFromRendered(seen) {
  const nodes = [];
  for (const block of (seen && seen.jsonld) || []) nodes.push(...parseLdBlock(block));
  return pageDeclarations(nodes, (seen && seen.metas) || {}, null);
}

/* The page's declarations and the listing's own shape, together: the
   one verdict the canonical rule asks for. An editorial, listing or
   non-shop listing is never a product page, whatever it declares; a
   page that declares itself an article is not one either; a product-
   shaped URL, or a page that declares a product, is. A page that says
   nothing, at an address that says nothing, is not. */
const NOT_PRODUCT_SHAPES = new Set(['editorial', 'listing', 'not-a-shop']);

function productPageVerdict(shape, page) {
  if (shape && NOT_PRODUCT_SHAPES.has(shape.kind)) return { ok: false, why: `the listing is ${shape.kind === 'not-a-shop' ? 'not a shop' : `a${shape.kind === 'editorial' ? 'n editorial page' : ' listing page'}`} — ${shape.why}` };
  if (page && page.declaresArticle) return { ok: false, why: `the page declares itself an article or other non-product page — ${page.declaresArticle}` };
  if (shape && shape.kind === 'product') return { ok: true, why: `its address names one product — ${shape.why}` };
  if (page && page.declaresProduct) return { ok: true, why: `the page declares a product — ${page.declaresProduct}` };
  return { ok: false, why: 'nothing on the page or in its address says it is a product page' };
}

/* candidates in the order they deserve to be tried, deduplicated. Each
   keeps where it came from, because the identity gate below weighs an
   og:image on a canonical page differently from a bare URL. */
function candidatesFrom(html, pageUrl) {
  const nodes = jsonLdNodes(html);
  const canonical = canonicalOf(html);

  const raw = [];
  for (const hit of fromJsonLd(nodes)) raw.push({ url: hit.url, from: 'json-ld', node: hit.node, shape: hit.shape });
  for (const name of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    const value = metaContent(html, name);
    if (value) raw.push({ url: value, from: name });
  }
  for (const url of fromPreload(html)) raw.push({ url, from: 'preload' });

  const page = pageDeclarationsFromHtml(html);
  return dedupe(raw, pageUrl, canonical).map((one) => Object.assign(one, { page }));
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
/* Parameters an ad network or an analytics tag puts on a link. Their
   values are long digit runs that look exactly like product codes, and
   a click id is not a product: a listing whose ONLY "code" came from
   one of these carries no code at all. */
const TRACKING_PARAMS = /^(utm_|atc_|gclid|gbraid|wbraid|fbclid|msclkid|srsltid|gad_|irclickid|ranmid|ranei|ransiteid|cjevent|epik|ttclid|twclid|yclid|mc_|_gl|sessionid|sid|ref|referrer|source|campaign|affiliate|aff_|clickid|subid)/i;

function identifiersFrom(productUrl) {
  let url;
  try { url = new URL(productUrl); } catch (err) { return []; }

  const kept = [];
  for (const [key, value] of url.searchParams) {
    if (TRACKING_PARAMS.test(key)) continue;
    kept.push(`${key}=${value}`);
  }
  const text = decodeURIComponent(url.pathname) + ' ' + decodeURIComponent(kept.join('&'));
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

  /* A year is not a product. Telfar's cropped-track-jacket-white-2025
     yields 2025 and nothing else, and a bare year matches every image
     that season's shoot produced — or any file that merely says 2025.
     Only the four digits on their own are dropped: a longer code that
     happens to contain a year still names its product. */
  return [...ids].filter((id) => !YEAR.test(id));
}

const YEAR = /^(19|20)\d\d$/;

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

/* ---------- canonical evidence has to name the same product ----------

   `via: 'canonical'` says: this page declares itself the canonical page
   for the listing, and this is the image it publishes as its product's.
   The first half is checked; the second half was assumed. That makes it
   circular, because virtually every product page declares itself
   canonical for its own URL — the page is vouching for the page, and
   nothing in it was ever tied to the PRODUCT.

   A live run wrote this:

     productUrl    .../todd-snyder-cotton-cashmere-sweater-polo-4/
     imageUrl      ...todd-snyder-sea-soft-irish-linen-shirt...
     imageEvidence { via: 'canonical', canonical: .../sweater-polo-4/ }

   The canonical matched the listing exactly, and the picture was of a
   different garment. A cotton cashmere sweater polo is not a Sea Soft
   Irish Linen Shirt, and the evidence said nothing either way because
   it was never looking at the garment.

   So it looks now. The listing URL's own path describes a garment; so
   do the image's filename, its alt text and the product record that
   supplied it. Both sides are read with the same reader the semantic
   gate uses, and canonical evidence is refused when they name different
   garments. Silence still proves nothing either way — an opaque CDN
   filename and a coded path leave the rule exactly where it was — so
   this only ever REFUSES a disagreement it can see, and a refusal sends
   the candidate back for the next image, which may carry the code and
   prove itself outright. */

/* the descriptive part of a URL path: the words, without the segments
   that name a shop's shelving rather than its garment */
const SHELVING = /^(p|dp|pd|prod|product|products|item|items|clothing|clothes|shop|store|buy|en|us|uk|ca|au|gb|www|catalog|category|c|g|men|mens|women|womens|sale|new|collection|collections)$/i;

function wordsInPath(url) {
  let parsed;
  try { parsed = new URL(url); } catch (err) { return ''; }
  return decodeURIComponent(parsed.pathname)
    .split('/')
    .filter(Boolean)
    .filter((segment) => !SHELVING.test(segment))
    .join(' ')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
}

/* Everything this candidate says about what it is a picture OF, kept
   APART. Run together into one string they mask each other — the head
   noun of "sweater-polo.jpg" + "Linen Camp Shirt" is shirt, and the
   filename's disagreement disappears into the join. Each description
   answers for itself. */
function wordsAboutImage(candidate) {
  const said = [];
  const file = wordsInPath(candidate && candidate.url);
  if (file) said.push({ where: 'its filename', text: file });
  const alt = candidate && candidate.alt;
  if (typeof alt === 'string' && alt.trim()) said.push({ where: 'its alt text', text: alt.trim() });
  const node = candidate && candidate.node;
  if (node && typeof node.name === 'string' && node.name.trim()) {
    said.push({ where: 'the product record it came from', text: node.name.trim() });
  }
  return said;
}

/* The same test the semantic gate applies to a title, applied here to
   two descriptions of one product. It refuses only what it can see: a
   side that names no garment agrees with everything.

   It weighs the garment and the fibre and stops there, deliberately.
   Length and cut words are as likely to be an image transform as a
   fact about the garment — a CDN path carrying "crop", "zoom" or
   "detail" says nothing about whether the coat is cropped — while the
   garment type and an exclusive fibre are what make one product a
   different product from another. */
function garmentsAgree(left, right) {
  const a = readGarment(left, {});
  const b = readGarment(right, {});
  if (!a.type || !b.type) return { agree: true, why: 'one side names no garment, so there is nothing to disagree with' };

  if (a.family !== b.family) {
    return { agree: false, why: `${a.type} (${a.family}) against ${b.type} (${b.family})` };
  }
  if (a.type !== b.type && !a.generic && !b.generic) {
    return { agree: false, why: `${a.type} against ${b.type}` };
  }

  const ours = [...a.fibres].filter(exclusiveFibre);
  const theirs = [...b.fibres].filter(exclusiveFibre);
  if (ours.length && theirs.length) {
    const shared = ours.filter((fibre) => theirs.includes(fibre));
    const blendable = ours.some((one) => theirs.some((two) => fibresBlend(one, two)));
    if (!shared.length && !blendable) {
      return { agree: false, why: `${ours.join('/')} against ${theirs.join('/')}` };
    }
  }
  return { agree: true, why: `both read as a ${b.type}` };
}

/* Whether a page's canonical claim may stand for THIS image. Every
   description the candidate carries has to agree; one that names a
   different garment refuses it, whatever the others say. */
function canonicalCorroborated(productUrl, candidate) {
  const listing = wordsInPath(productUrl);
  for (const said of wordsAboutImage(candidate)) {
    const verdict = garmentsAgree(listing, said.text);
    if (!verdict.agree) return { agree: false, why: `${said.where} says ${verdict.why}` };
  }
  return { agree: true, why: 'nothing it says about itself names a different garment' };
}

/* ---------- a picture of the SITE is not a picture of the product ----------

   A live run accepted three photos that were not photographs of any
   garment:

     whbm_logo_seo.avif     9KB, White House Black Market's wordmark
     social-share-1x.jpg    ASOS's share card
     social_telfar.jpg      Telfar's share card

   Each came in as the page's og:image, and each was written under
   `via: 'canonical'`, because the page was canonical for the listing and
   nothing in the filename named a DIFFERENT garment. That is the
   canonical rule working as written: it refuses a disagreement it can
   see, and a logo disagrees with nothing. What it never asked is whether
   the image is a photograph of a product at all — and a page that
   publishes its logo as its og:image is vouching for its brand, not for
   the garment.

   So an image is read for what KIND of asset it is before anything is
   asked about which product it shows. Two tiers:

     never a product photo   favicons, touch icons, placeholders, "no
                             image", "coming soon", spacers, and any .ico
                             or .svg. Refused whatever else is true.

     a site asset            logos, wordmarks, social and share cards,
                             Open Graph and SEO images, sprites, icons,
                             banners, and a filename that is nothing but
                             the shop's own name. Refused unless the
                             filename itself carries the listing's code or
                             names a garment — a "logo-tee.jpg" is a
                             T-shirt, and "og-429066.jpg" is product
                             429066's own card.

   Only the FILENAME is read for the kind of asset, plus a directory
   whose whole name is a site-asset folder (/logos/, /social/, /og/).
   Other directory names say nothing: Salesforce stores every product
   photo under /default/, and that is not a default image. */
const NEVER_A_PRODUCT_PHOTO = /\b(favicons?|apple touch icon|touch icon|placeholders?|placeholder image|no ?image|image not available|image unavailable|not available|coming soon|spacer|1x1|missing image)\b/;
const SITE_ASSET = /\b(logos?|logotype|wordmark|brandmark|favicon|icons?|sprites?|social|share|sharing|shareimage|socialshare|og|ogimage|opengraph|open graph|seo|meta image|twitter|twitter card|facebook|fb|banner|masthead|header|footer|newsletter|branding|default share|site image)\b/;
const SITE_ASSET_FOLDER = /^(logos?|favicons?|icons?|social|share|sharing|og|og-images?|opengraph|seo|branding|brand-assets|placeholders?|sprites?)$/i;
const NEVER_A_PHOTO_TYPE = /\.(ico|svg|svgz)$/i;
/* words a filename uses for its SIZE or its version rather than its
   subject, discounted before asking whether the rest is only the shop's
   own name */
const FILENAME_FILLER = /^(image|images|img|photo|pic|main|large|small|medium|default|final|new|web|hi|hires|lores|retina|copy|v\d+|\d+x|x\d+|\d+x\d+|\d+)$/;
const HOST_FILLER = new Set(['www', 'cdn', 'com', 'net', 'org', 'co', 'uk', 'us', 'img', 'images', 'image', 'static', 'media', 'assets', 'shop', 'store']);

/* a filename's words, with camelCase and every separator split apart */
function filenameWords(pathname) {
  const base = String(pathname || '').split('/').filter(Boolean).pop() || '';
  return decodeURIComponent(base)
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function siteAsset(candidate, productUrl) {
  const raw = typeof candidate === 'string' ? candidate : candidate && candidate.url;
  let url;
  try { url = new URL(String(raw)); } catch (err) { return null; }

  const pathname = (() => { try { return decodeURIComponent(url.pathname); } catch (err) { return url.pathname; } })();
  if (NEVER_A_PHOTO_TYPE.test(pathname)) {
    return `${pathname.split('.').pop().toLowerCase()} is an icon or vector format, never a product photograph`;
  }

  const words = filenameWords(pathname);
  const said = words.join(' ');
  const file = pathname.split('/').filter(Boolean).pop() || pathname;

  const never = said.match(NEVER_A_PRODUCT_PHOTO);
  if (never) return `its filename ${file} names a ${never[1]}, which is a stand-in, not a product photo`;

  /* the escape from the second tier: the filename speaks for a product */
  const carriesCode = identifiersFrom(productUrl).some((id) => containsCode(file.toLowerCase(), id));
  if (carriesCode) return null;
  const garment = readGarment(said, {});
  if (garment.type) return null;

  const asset = said.match(SITE_ASSET);
  if (asset) return `its filename ${file} names a site ${asset[1]} image, not a photograph of the garment`;

  const folders = pathname.split('/').filter(Boolean).slice(0, -1);
  const folder = folders.find((segment) => SITE_ASSET_FOLDER.test(segment));
  if (folder) return `it sits in the site's /${folder}/ folder, which holds the shop's own artwork, not its products`;

  /* a filename that is nothing but the shop's own name: telfar.jpg */
  const hostWords = new Set();
  for (const host of [url.hostname, (() => { try { return new URL(productUrl).hostname; } catch (err) { return ''; } })()]) {
    for (const label of String(host).toLowerCase().split(/[.-]/)) if (label && !HOST_FILLER.has(label)) hostWords.add(label);
  }
  const subject = words.filter((word) => !FILENAME_FILLER.test(word) && word.length >= 3);
  if (subject.length && subject.every((word) => hostWords.has(word))) {
    return `its filename ${file} is only the shop's own name, which is the shop's picture, not the product's`;
  }
  return null;
}

function identityEvidence(candidate, productUrl) {
  /* a photo offered by the store's own product record answers to that
     record and to nothing else — and nothing else may claim it */
  if (candidate && candidate.from === 'product-record') return productRecordEvidence(candidate, productUrl);

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
    /* a page vouches for its own image only if it is a product page: an
       article, a guide, a category or a search page declaring itself
       canonical is vouching for its illustration, not for a product */
    if (candidate.productPage && !candidate.productPage.ok) {
      return {
        ok: false,
        why: `the page is canonical for this listing, but it is not a product page — ${candidate.productPage.why}`
      };
    }
    /* the page vouching for the page is not the picture vouching for
       the product: a canonical that matches the listing exactly is
       still worthless when the image is of a different garment */
    const corroborated = canonicalCorroborated(productUrl, candidate);
    if (!corroborated.agree) {
      return {
        ok: false,
        why: `the page is canonical for this listing, but its ${candidate.from} is a different garment — ${corroborated.why}`
      };
    }
    /* and the page vouching for its og:image is not the og:image being
       a photograph: a shop that publishes its logo there is vouching for
       its brand, and a logo agrees with every garment */
    const asset = siteAsset(candidate, productUrl);
    if (asset) {
      return {
        ok: false,
        why: `the page is canonical for this listing, but its ${candidate.from} is not a product photo — ${asset}`
      };
    }
    return {
      ok: true,
      via: 'canonical',
      canonical: candidate.canonical,
      how: `the page declares itself the canonical page for this listing, and this is its ${candidate.from} (${corroborated.why})`
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

/* ---------- a Shopify store's own product record ----------

   A Shopify listing is /products/<handle>, and its handle is a slug —
   cropped-track-jacket-white-2025 — with no product code in it. The
   identity gate has nothing to match, and every photo on the page is
   refused, including the store's own photographs of the product.

   Every Shopify store publishes the record behind that page at
   /products/<handle>.js: the product's id, its handle, its title and
   the images that belong to it. That is the store saying which photos
   are this product's, in a form that names the product. It is read
   with the ordinary request, and it counts only when:

   - the listing is a /products/<handle> page, and the record is asked
     for on the listing's own origin;
   - the record answers for exactly that handle;
   - its title is, by the semantic gate, the garment the catalogue row
     means — a full match, nothing left pending;
   - the image is one the record itself lists, on the store's own host
     or Shopify's CDN.

   A record that is missing, refused (403, 418, anything not 200), not
   JSON, or for another product offers nothing, and the page's own
   candidates are decided exactly as before. The photos it does offer
   still go through the asset, host, identity and loadable gates like
   any other candidate. */
const SHOPIFY_CDN = 'cdn.shopify.com';

function shopifyHandle(productUrl) {
  let url;
  try { url = new URL(String(productUrl)); } catch (err) { return null; }
  const m = url.pathname.match(/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?(?:\/collections\/[^/]+)?\/products\/([^/]+?)\/?$/i);
  if (!m) return null;
  let handle;
  try { handle = decodeURIComponent(m[1]).toLowerCase(); } catch (err) { return null; }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle) || /\.(js|json|oembed|xml)$/.test(handle)) return null;
  return { handle, origin: url.origin, recordUrl: `${url.origin}/products/${handle}.js` };
}

/* the images a record says are its product's, and only those: the
   gallery, the featured image, image media and each variant's own
   image. Video and 3D media are not photographs of anything. */
function recordImages(record, recordUrl) {
  const out = [];
  const add = (value) => {
    const raw = typeof value === 'string' ? value : value && typeof value.src === 'string' ? value.src : null;
    if (!raw || !raw.trim()) return;
    try { out.push(new URL(raw.trim(), recordUrl).href); } catch (err) { /* not a URL: not offered */ }
  };
  if (Array.isArray(record.images)) record.images.forEach(add);
  add(record.featured_image);
  if (Array.isArray(record.media)) {
    for (const media of record.media) {
      if (media && (media.media_type === undefined || media.media_type === 'image')) add(media.src || media.preview_image);
    }
  }
  if (Array.isArray(record.variants)) {
    for (const variant of record.variants) if (variant && variant.featured_image) add(variant.featured_image);
  }
  return [...new Set(out)];
}

/* the store's own host, or Shopify's CDN — nowhere else */
function recordImageHost(imageUrl, productUrl) {
  let image;
  let listing;
  try { image = new URL(String(imageUrl)); listing = new URL(String(productUrl)); } catch (err) { return 'not a URL'; }
  const host = image.hostname.toLowerCase();
  if (host === SHOPIFY_CDN) return null;
  if (host === listing.hostname.toLowerCase() || registrable(host) === registrable(listing.hostname)) return null;
  return `${host} is not the store's own host or Shopify's CDN`;
}

/* Fetches and checks the record. Returns the candidates it offers, or
   why it offers none; either way a note for the report.

   `how` changes only how the record is FETCHED, never how it is judged:
   `fetch` is a request()-shaped reader (the rendered page's own, for a
   store that serves its page only to a browser), and `analyticsId` is
   the product id the page's ShopifyAnalytics names, which the record's
   id then has to be. */
async function productRecordFor(productUrl, catalogRow, within, how) {
  const listing = shopifyHandle(productUrl);
  if (!listing) return { failed: 'not a Shopify /products/<handle> listing', skipped: true };
  if (!catalogRow || !catalogRow.name) {
    return { failed: 'there is no catalogue row to hold the record\'s title against', skipped: true };
  }

  const fetcher = (how && how.fetch) || request;
  const got = await fetcher(listing.recordUrl, null, within);
  if (!got.ok) return { failed: `the product record could not be read (${got.why})` };
  let record;
  try {
    const { response } = got;
    if (response.status !== 200) {
      if (response.body) await response.body.cancel().catch(() => {});
      /* refused is refused: no second way in is tried */
      return { failed: `the product record answered ${response.status}` };
    }
    record = JSON.parse(await response.text());
  } catch (err) {
    return { failed: `the product record is not readable JSON (${readingFailed(err)})` };
  } finally {
    got.release();
  }

  if (!record || typeof record !== 'object' || Array.isArray(record)) return { failed: 'the product record is not a product' };
  const handle = typeof record.handle === 'string' ? record.handle.toLowerCase() : '';
  if (handle !== listing.handle) {
    return { failed: `the product record is for ${handle || 'no handle'}, not this listing's ${listing.handle}` };
  }
  const id = typeof record.id === 'number' || typeof record.id === 'string' ? String(record.id) : '';
  if (!/^\d+$/.test(id)) return { failed: 'the product record names no product id' };
  const analyticsId = how && how.analyticsId ? String(how.analyticsId) : null;
  if (analyticsId && analyticsId !== id) {
    return { failed: `the page's ShopifyAnalytics names product ${analyticsId}, but the product record is product ${id}` };
  }
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) return { failed: 'the product record names no title' };

  const verdict = semanticMatch(catalogRow, { title });
  if (!verdict.ok || verdict.kind !== 'match') {
    return { failed: `the product record's title "${title}" is not the garment the row means — ${verdict.why}` };
  }

  const images = recordImages(record, listing.recordUrl);
  const summary = { handle, id, title, images };
  return {
    record: summary,
    candidates: images.map((url) => ({ url, from: 'product-record', record: summary }))
  };
}

/* ---------- the same record, embedded in a React Router page ----------

   Some Shopify stores are headless: Telfar's listing is a React Router
   app, and /products/<handle>.js answers 404. The page carries the
   product anyway, in the loader data the router hydrates from — at
   window.__reactRouterContext.state.loaderData (and on the data router
   as __reactRouterDataRouter.state.loaderData), under the product
   route's own key, as `.product`: id (a Shopify Product GID), handle,
   title, and media.nodes, each image node carrying image.url.

   Read in the rendered page itself, and only this much of it: each
   route's OWN `.product` whose handle is this listing's — never a
   product nested under a variant, an option, a recommendation or a
   collection — and of that, only id, handle, title and, per media
   node, its type and image.url. previewImage is never taken: a video's
   poster is not a photograph of the garment, and one captured on
   Telfar was of a bag. Nothing else of the router state leaves the
   page, and none of it is printed.

   This function runs INSIDE the page (page.evaluate), so it must not
   reach for anything outside itself. */
function reactRouterProducts(handle) {
  const out = { pathHandle: null, canonical: null, products: [] };
  try {
    const path = location.pathname.match(/\/products\/([^/?#]+)\/?$/i);
    out.pathHandle = path ? decodeURIComponent(path[1]).toLowerCase() : null;
    const link = document.querySelector('link[rel="canonical"]');
    out.canonical = link && link.href ? String(link.href).slice(0, 1000) : null;
    const text = (value, most) => (typeof value === 'string' ? value.slice(0, most) : null);
    const sources = [
      ['__reactRouterContext.state.loaderData', window.__reactRouterContext && window.__reactRouterContext.state && window.__reactRouterContext.state.loaderData],
      ['__reactRouterDataRouter.state.loaderData', window.__reactRouterDataRouter && window.__reactRouterDataRouter.state && window.__reactRouterDataRouter.state.loaderData]
    ];
    for (const [name, loaderData] of sources) {
      if (!loaderData || typeof loaderData !== 'object') continue;
      for (const route of Object.keys(loaderData).slice(0, 200)) {
        const data = loaderData[route];
        const product = data && typeof data === 'object' ? data.product : null;
        if (!product || typeof product !== 'object' || typeof product.handle !== 'string') continue;
        if (product.handle.toLowerCase() !== handle) continue;
        const nodes = product.media && Array.isArray(product.media.nodes) ? product.media.nodes.slice(0, 100) : [];
        out.products.push({
          where: `${name}[${JSON.stringify(route).slice(0, 200)}].product`,
          id: text(product.id, 120),
          handle: text(product.handle, 200),
          title: text(product.title, 300),
          media: nodes.map((node) => ({
            typename: node ? text(node.__typename, 40) : null,
            contentType: node ? text(node.mediaContentType, 40) : null,
            image: node && node.image ? text(node.image.url, 2000) : null,
            previewOnly: Boolean(node && !(node.image && node.image.url) && node.previewImage)
          }))
        });
        if (out.products.length >= 8) return out;
      }
    }
  } catch (err) {
    out.failed = String(err && err.message ? err.message : err).slice(0, 200);
  }
  return out;
}

const SHOPIFY_PRODUCT_GID = /^gid:\/\/shopify\/Product\/(\d+)$/;

/* What the page's router state says, held to the same rules as the .js
   record — and to two more, because this record came out of a page: the
   browser has to have ended up on THIS listing, and a canonical the page
   declares has to name this handle. */
function embeddedRecordFrom(probe, productUrl, catalogRow, canonical) {
  const listing = shopifyHandle(productUrl);
  if (!listing) return { skipped: true, failed: 'not a Shopify /products/<handle> listing' };
  if (!catalogRow || !catalogRow.name) return { skipped: true, failed: 'there is no catalogue row to hold the record\'s title against' };
  if (!probe) return { skipped: true, failed: 'the page was not read in a browser' };
  if (probe.failed) return { failed: `the page's router state could not be read (${probe.failed})` };
  if (probe.pathHandle !== listing.handle) {
    return { failed: `the browser ended on ${probe.pathHandle || 'a page that is not a product'}, not this listing's ${listing.handle}` };
  }
  const declared = canonical || probe.canonical;
  if (declared) {
    const named = shopifyHandle(declared);
    if (!named || named.handle !== listing.handle) {
      return { failed: `the page declares ${declared} canonical, which is not this listing` };
    }
  }

  const products = (probe.products || []).filter((one) => one && typeof one.handle === 'string' && one.handle.toLowerCase() === listing.handle);
  if (!products.length) return { failed: 'the page\'s router state carries no route-level product for this handle' };
  if (new Set(products.map((one) => one.id)).size > 1) {
    return { failed: 'the page\'s router state carries different products under this handle' };
  }
  const product = products[0];
  const gid = SHOPIFY_PRODUCT_GID.exec(String(product.id || ''));
  if (!gid) return { failed: `the embedded product names no valid Shopify Product GID (${product.id || 'none'})` };
  const title = typeof product.title === 'string' ? product.title.trim() : '';
  if (!title) return { failed: 'the embedded product names no title' };
  const verdict = semanticMatch(catalogRow, { title });
  if (!verdict.ok || verdict.kind !== 'match') {
    return { failed: `the embedded product's title "${title}" is not the garment the row means — ${verdict.why}` };
  }

  const images = [];
  let previewOnly = 0;
  for (const node of product.media || []) {
    if (!node) continue;
    if (!node.image) { if (node.previewOnly) previewOnly += 1; continue; }
    try { images.push(new URL(node.image, productUrl).href); } catch (err) { /* not a URL: not offered */ }
  }
  const record = {
    source: 'embedded-react-router',
    where: product.where,
    handle: listing.handle,
    id: gid[1],
    gid: product.id,
    title,
    images: [...new Set(images)],
    previewOnly
  };
  return { record, candidates: record.images.map((url) => ({ url, from: 'product-record', record })) };
}

/* ---------- the .js record, asked for by the page that rendered ----------

   A store can refuse its page to a plain request and serve it to a
   browser. That store is not asked for its record by a plain request —
   but the browser it served the page to can ask for it, same-origin,
   the way the page's own scripts would. The record it gets back is
   judged by productRecordFor, exactly as a plain-HTTP one is.

   Asked only when the browser ended up on THIS listing: the same
   origin, a /products/<handle> path with the listing's handle, and a
   canonical, if the page declares one, that names that handle. A
   collection, a search, an article or any other page the listing
   redirected to is not a product page and is never asked for a record. */
function browserRecordListing(finalUrl, productUrl, canonical) {
  const listing = shopifyHandle(productUrl);
  if (!listing) return { skipped: true, failed: 'not a Shopify /products/<handle> listing' };
  const landed = shopifyHandle(finalUrl);
  if (!landed || landed.origin !== listing.origin || landed.handle !== listing.handle) {
    return { failed: `the browser ended on ${finalUrl || 'no page'}, not this listing's ${listing.origin}/products/${listing.handle}` };
  }
  if (canonical) {
    const named = shopifyHandle(canonical);
    if (!named || named.handle !== listing.handle) return { failed: `the page declares ${canonical} canonical, which is not this listing` };
  }
  return { listing };
}

async function browserProductRecord(rendered, productUrl, catalogRow, within) {
  const seen = rendered.seen || {};
  const allowed = browserRecordListing(rendered.finalUrl, productUrl, seen.canonical);
  if (!allowed.listing) return allowed;
  if (typeof rendered.fetchRecord !== 'function') return { skipped: true, failed: 'the rendered page cannot be asked for anything' };
  const shopify = seen.diagnostics && seen.diagnostics.shopify;
  return productRecordFor(productUrl, catalogRow, within, {
    fetch: rendered.fetchRecord,
    analyticsId: shopify && shopify.productId ? shopify.productId : null
  });
}

function productRecordEvidence(candidate, productUrl) {
  const record = candidate.record;
  const listing = shopifyHandle(productUrl);
  if (!listing) return { ok: false, why: 'the listing is not a Shopify /products/<handle> page, so no product record speaks for it' };
  if (!record || !Array.isArray(record.images)) return { ok: false, why: 'it names a product record that was never read' };
  if (record.handle !== listing.handle) {
    return { ok: false, why: `the product record is for ${record.handle}, not this listing's ${listing.handle}` };
  }
  if (!record.images.includes(candidate.url)) return { ok: false, why: 'the product record does not list this image as its product\'s' };
  const off = recordImageHost(candidate.url, productUrl);
  if (off) return { ok: false, why: `the product record lists it, but ${off}` };
  if (record.source === 'embedded-react-router') {
    /* a merchant can attach another product's picture to a product's
       media; a filename that names a different garment refuses it. This
       only ever refuses — a filename proves nothing on its own. */
    const agrees = garmentsAgree(record.title, wordsInPath(candidate.url));
    if (!agrees.agree) return { ok: false, why: `the embedded product lists it, but its filename names a different garment — ${agrees.why}` };
    return {
      ok: true,
      via: 'product-record',
      source: 'embedded-react-router',
      handle: record.handle,
      productId: record.id,
      title: record.title,
      how: `the page's own React Router product ${record.handle} (product ${record.id}, "${record.title}") lists it in its media`
    };
  }
  return {
    ok: true,
    via: 'product-record',
    handle: record.handle,
    productId: record.id,
    title: record.title,
    how: `the store's product record for ${record.handle} (product ${record.id}, "${record.title}") lists it as the product's own image`
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

  /* whatever evidence the row records, a logo is not its product's photo */
  const asset = siteAsset(row.imageUrl, row.productUrl);
  if (asset) return { ok: false, why: asset };

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
    /* a canonical claim only ever stood for a product page, and an
       address that is plainly an article, a category or not a shop at
       all never was one */
    const shape = listingShape(row.productUrl, '');
    if (NOT_PRODUCT_SHAPES.has(shape.kind)) {
      return { ok: false, why: `the recorded canonical is for a page that is not a product page — ${shape.why}` };
    }
    /* re-proved, not trusted: a note recorded before this rule existed,
       or written by hand, has to survive the same test */
    const corroborated = canonicalCorroborated(row.productUrl, { url: row.imageUrl });
    if (!corroborated.agree) {
      return {
        ok: false,
        why: `the recorded canonical is this row's listing, but the photo is of a different garment — ${corroborated.why}`
      };
    }
    return { ok: true, via: 'canonical', how: 'its listing declared itself canonical for this product' };
  }

  if (evidence.via === 'product-record') {
    /* re-proved from the row's own URL: the handle has to be the one its
       listing names, the photo has to sit where the store keeps its
       photos, and the title the record gave has to be, today, the
       garment this row means */
    const listing = shopifyHandle(row.productUrl);
    if (!listing) return { ok: false, why: 'the recorded product record cannot speak for a listing that is not a Shopify /products/<handle> page' };
    const handle = String(evidence.handle || '').toLowerCase();
    if (handle !== listing.handle) {
      return { ok: false, why: `the recorded product record ${evidence.handle} is not this row's listing ${listing.handle}` };
    }
    if (!/^\d+$/.test(String(evidence.productId || ''))) return { ok: false, why: 'the recorded product record names no product id' };
    const off = recordImageHost(row.imageUrl, row.productUrl);
    if (off) return { ok: false, why: `the photo is not where the store keeps its photos: ${off}` };
    const title = String(evidence.title || '').trim();
    if (!title) return { ok: false, why: 'the recorded product record names no title' };
    if (!row.name) return { ok: false, why: 'the row names no garment to hold the recorded title against' };
    const verdict = semanticMatch(row, { title });
    if (!verdict.ok || verdict.kind !== 'match') {
      return { ok: false, why: `the recorded product record's title "${title}" is not the garment the row means — ${verdict.why}` };
    }
    if (evidence.source === 'embedded-react-router') {
      /* the structure holds — but a note is not the page. This row is
         accounted for only once its own page has been read again and
         still lists this photo; see reproveEmbeddedRecord. */
      return {
        ok: true,
        via: 'product-record',
        source: 'embedded-react-router',
        needsLive: true,
        how: `its page's React Router product ${handle} (product ${evidence.productId}) is to be read again`
      };
    }
    if (evidence.source !== undefined) return { ok: false, why: `the recorded product record names an unknown source (${evidence.source})` };
    return { ok: true, via: 'product-record', how: `its store's product record for ${handle} (product ${evidence.productId}) lists it` };
  }

  return { ok: false, why: `the recorded evidence names no recognised kind (${evidence.via || 'none'})` };
}

/* ---------- the gates ---------- */
function registrable(host) {
  const bits = String(host).toLowerCase().split('.');
  return bits.length <= 2 ? bits.join('.') : bits.slice(-2).join('.');
}

/* A loopback origin is a fixture, never a retailer. The https rule is
   about what a shipped page can load, and nothing shipped ever points
   at 127.0.0.1 — so http is allowed there and nowhere else, which is
   what lets the whole path be tested end to end against a local
   server rather than only in pieces. */
const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|localhost)$/i;

function soundness(candidate, pageUrl) {
  const raw = typeof candidate === 'string' ? candidate : candidate.url;
  let url;
  try { url = new URL(raw); } catch (err) { return 'not a URL'; }
  if (url.protocol !== 'https:' && !LOOPBACK.test(url.hostname)) {
    return `${url.protocol}// cannot load on an https page`;
  }

  const host = url.hostname.toLowerCase();
  if (NOT_THE_RETAILER.some((bad) => host === bad || host.endsWith('.' + bad))) {
    return `${host} is an aggregator or stock host, not the retailer`;
  }
  return null;
}

/* ---------- how long is left ----------

   A budget is a clock a row carries with it. Every network operation
   asks it how much time remains and takes the lesser of that and its own
   ceiling, so a row's total is bounded by one number rather than by the
   sum of everything that might go slowly inside it.

   It is checked before work STARTS rather than raced against work in
   flight. A race would leave the loser running — an orphaned fetch, or
   worse, an orphaned Chromium — and a browser nobody closes is a leak
   that outlives the run that made it. */
function budgetOf(ms) {
  const until = Date.now() + Math.max(0, ms);
  return {
    left: () => Math.max(0, until - Date.now()),
    spent: () => Date.now() >= until,
    /* what an operation may take: its own ceiling, or what is left of
       the row, whichever runs out first */
    cap: (want) => Math.max(0, Math.min(want, until - Date.now()))
  };
}

/* ---------- a few at a time, answered in order ----------

   Candidates arrive ranked — by how confidently their source names the
   main product image, or by how well the shop's listing matched what
   was asked for — and the first that clears every gate is the answer.
   Ranked first and finished first are not the same thing, so this runs
   a few at once and still answers with the EARLIEST that cleared, never
   the quickest.

   Dispatch stops as soon as nothing still unstarted could beat the best
   clearance so far, which keeps the speculation bounded: at most a
   lane's worth of candidates are read that a serial run would not have
   reached. A worker that throws is that candidate's failure and no
   one else's. */
async function raceInOrder(items, lanes, attempt) {
  const results = new Array(items.length);
  const running = new Map();
  let winner = -1;
  let next = 0;

  const settle = (at, value) => {
    results[at] = value;
    running.delete(at);
    if (value && value.ok && (winner === -1 || at < winner)) winner = at;
  };

  for (;;) {
    while (running.size < Math.max(1, lanes) && next < items.length && (winner === -1 || next < winner)) {
      const at = next;
      next += 1;
      running.set(at, Promise.resolve()
        .then(() => attempt(items[at], at))
        .then((value) => settle(at, value), (err) => settle(at, { ok: false, threw: err })));
    }
    if (!running.size) break;
    await Promise.race(running.values());
  }

  return { results, winner };
}

/* ---------- the network ---------- */

/* The abort covers the BODY as well as the headers, which it did not
   before: fetch() resolving means only that the response line arrived,
   and the timer was cleared on the way out of here — so a retailer that
   then dribbled its HTML a byte at a time was, for all the ceiling
   above said, unbounded. The timer now goes back to the caller and is
   cleared when the body has been read, not when the headers have. */
async function request(url, extra, within) {
  const controller = new AbortController();
  const ms = Math.max(1, within === undefined || within === null ? TIMEOUT : within);
  const timer = setTimeout(() => controller.abort(), ms);
  const release = () => clearTimeout(timer);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: Object.assign({}, BROWSER, extra || {})
    });
    return { ok: true, response, release };
  } catch (err) {
    release();
    const why = (err && err.name === 'AbortError') ? 'timed out'
      : (err && err.message) ? err.message : 'unreachable';
    return { ok: false, why, release: () => {} };
  }
}

/* an abort part-way through a body reads as a timeout, because that is
   what it is: the ceiling was reached with the page still arriving */
function readingFailed(err) {
  if (err && (err.name === 'AbortError' || /aborted|abort/i.test(String(err.message || '')))) {
    return 'timed out while the page was still arriving';
  }
  return err && err.message ? String(err.message).split('\n')[0] : 'the body could not be read';
}

/* A sandbox that refuses the host answers in place of the retailer, and
   it answers 403 — the same status a retailer's bot check uses. Telling
   them apart decides what the reader should do about it, so the refusal
   is read rather than just counted: an egress denial names the host it
   refused, and the fix is an allowlist entry, not a different catalogue. */
const EGRESS_DENIAL = /not in allowlist|egress|proxy|blocked by/i;

async function fetchPage(url, within) {
  const got = await request(url, null, within);
  if (!got.ok) return { failed: got.why };
  const { response } = got;
  try {
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 403 && EGRESS_DENIAL.test(body)) {
        return { failed: `this machine's network refuses ${new URL(url).hostname}`, blocked: true };
      }
      /* a retailer's own 403 is a bot check, and a real browser is the
         answer to it rather than a different URL */
      return { failed: `the page answered ${response.status}`, refused: response.status === 403 || response.status === 429 };
    }
    /* where the page actually came from, after redirects: a caller that
       has to know the listing still resolves to the shop it named reads
       it here rather than asking a second time */
    return { html: await response.text(), url: response.url || url };
  } catch (err) {
    return { failed: readingFailed(err) };
  } finally {
    /* the ceiling covered the body too, and this is where it stops */
    got.release();
  }
}

/* ---------- how big the picture actually is ----------

   The byte floor catches a tracking pixel and nothing else: the 9KB
   wordmark a live run accepted was four times over it. What a logo
   cannot hide is its SHAPE — a strip a few dozen pixels tall, or a
   square the size of a tab icon — and every format a shop serves says
   its own dimensions in its first few hundred bytes. So they are read
   from the header, never decoded. A format this cannot read, or a body
   too short to say, answers null and the photo is judged exactly as it
   was before: this only ever refuses a shape it can SEE. */
function imageDimensions(data) {
  if (!data || typeof data.length !== 'number' || data.length < 24) return null;
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const at = (text, offset) => b.toString('latin1', offset, offset + text.length) === text;
  const ok = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

  /* PNG: IHDR is always first */
  if (b[0] === 0x89 && at('PNG', 1)) return ok(b.readUInt32BE(16), b.readUInt32BE(20));
  if (at('GIF8', 0)) return ok(b.readUInt16LE(6), b.readUInt16LE(8));

  /* JPEG: walk the markers to the first start-of-frame */
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xff) { i += 1; continue; }
      const length = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return ok(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      }
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }

  /* WebP, in each of its three encodings */
  if (at('RIFF', 0) && at('WEBP', 8) && b.length >= 30) {
    if (at('VP8 ', 12)) return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    if (at('VP8L', 12)) {
      const bits = b.readUInt32LE(21);
      return ok((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (at('VP8X', 12)) return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
    return null;
  }

  /* AVIF and HEIF: the image-spatial-extents property, the largest if
     the file carries a thumbnail as well */
  if (at('ftyp', 4)) {
    let best = null;
    let from = 0;
    for (;;) {
      const found = b.indexOf('ispe', from, 'latin1');
      if (found < 0 || found + 16 > b.length) break;
      const width = b.readUInt32BE(found + 8);
      const height = b.readUInt32BE(found + 12);
      if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { width, height };
      from = found + 4;
    }
    return best;
  }
  return null;
}

/* the shape of a logo, a badge or a banner rather than a garment */
const MAX_ASPECT = 3;
function shapeFault(size) {
  if (!size) return null;
  const { width, height } = size;
  if (Math.min(width, height) < MIN_RENDERED) {
    return `it is ${width}x${height}, the size of an icon or a badge, not a product photo`;
  }
  if (Math.max(width, height) / Math.min(width, height) > MAX_ASPECT) {
    return `it is ${width}x${height}, the shape of a logo or a banner, not a product photo`;
  }
  return null;
}

/* The two loads a photo has to survive: plainly, and then carrying the
   site's own Referer, so a hotlink block is caught here rather than on
   the page. Both are bounded — an image host that accepts a connection
   and then serves nothing is the shape that hangs a run, and it is
   indistinguishable from a slow one until the ceiling says so. */
async function verifyImage(url, fetcher, within) {
  const ask = fetcher || request;
  const ms = within === undefined || within === null ? IMAGE_TIMEOUT : within;

  const plain = await ask(url, null, ms);
  if (!plain.ok) return { ok: false, why: `image host ${plain.why}` };

  let type;
  let status;
  let bytes;
  let size = null;
  try {
    type = plain.response.headers.get('content-type') || '';
    status = plain.response.status;
    const body = await plain.response.arrayBuffer();
    bytes = body.byteLength;
    /* the browser path decodes the picture itself and says how big it
       is; the plain path reads it off the header */
    size = plain.response.dimensions
      || (body instanceof ArrayBuffer ? imageDimensions(Buffer.from(body)) : imageDimensions(body));
  } catch (err) {
    return { ok: false, why: `image host ${readingFailed(err)}` };
  } finally {
    if (plain.release) plain.release();
  }

  if (status !== 200) return { ok: false, why: `answered ${status}` };
  if (!/^image\//i.test(type)) return { ok: false, why: `answered 200 as ${type.split(';')[0] || 'no type'}` };
  if (bytes < MIN_BYTES) return { ok: false, why: `only ${bytes} bytes, too small to be a product photo` };
  if (/^image\/(svg|x-icon|vnd\.microsoft\.icon)/i.test(type)) {
    return { ok: false, why: `answered as ${type.split(';')[0]}, an icon or vector format, never a product photograph` };
  }
  const misshapen = shapeFault(size);
  if (misshapen) return { ok: false, why: misshapen };

  const referred = await ask(url, { Referer: site }, ms);
  if (!referred.ok) return { ok: false, why: `refused for ${site}: ${referred.why}` };
  try {
    if (referred.response.body) await referred.response.body.cancel();
    if (referred.response.status !== 200) {
      return { ok: false, why: `hotlink blocked — served plainly, ${referred.response.status} for ${site}` };
    }
  } catch (err) {
    return { ok: false, why: `refused for ${site}: ${readingFailed(err)}` };
  } finally {
    if (referred.release) referred.release();
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

  /* the text the page itself marks as THIS product's description,
     details, specification or composition — and never a block sitting
     inside a recommendation strip, a carousel or the chrome, which
     describe other products entirely */
  const AWAY = 'nav, header, footer, [class*="recommend" i], [class*="related" i], [class*="also-like" i], [class*="carousel" i], [class*="cross-sell" i], [class*="upsell" i], [class*="similar" i], [class*="breadcrumb" i], [class*="review" i]';
  const detail = [...document.querySelectorAll(
    '[itemprop="description"], [class*="product-description" i], [class*="product-detail" i], [class*="product-info" i], [class*="description" i], [class*="composition" i], [class*="material" i], [class*="fabric" i], [class*="specification" i]'
  )]
    .filter((el) => !el.closest(AWAY))
    .map((el) => (el.innerText || el.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 20);
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

  /* diagnostics only: whether the page carries a product record no gate
     reads — Shopify's, or a framework's embedded state */
  const diagnostics = { shopify: null, embedded: [] };
  try {
    const product = window.ShopifyAnalytics && window.ShopifyAnalytics.meta && window.ShopifyAnalytics.meta.product;
    if (product) {
      const variants = Array.isArray(product.variants) ? product.variants : [];
      diagnostics.shopify = {
        productId: product.id ? String(product.id) : null,
        variants: variants.length,
        skus: variants.map((one) => one && one.sku).filter(Boolean).slice(0, 3)
      };
    }
    for (const name of ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__']) {
      if (window[name] || document.getElementById(name)) diagnostics.embedded.push(name);
    }
    if (document.querySelector('script[data-product-json], script[type="application/json"][id*="product" i]')) {
      diagnostics.embedded.push('product JSON script');
    }
  } catch (err) { /* a probe that throws reports nothing */ }

  /* TEMPORARY: the hydrated React Router / Remix runtime, searched for
     this listing's handle. Bounded in depth and in nodes; a key that
     sounds like a credential is neither entered nor reported; only key
     NAMES and the id/handle/title/image-URL values of a matching
     product are returned — never a whole object. */
  try {
    const handleMatch = location.pathname.match(/\/products\/([^/?#]+)/i);
    const handle = handleMatch ? decodeURIComponent(handleMatch[1]).toLowerCase() : null;
    const SECRET = /token|secret|password|passwd|cookie|credential|auth|session|api.?key|private|signature|env/i;
    const IMAGE = /^(?:https?:)?\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|avif|gif)(?:\?[^\s"'<>]*)?$/i;
    const keysOf = (value) => {
      if (!value || typeof value !== 'object') return null;
      try { return Object.keys(value).filter((k) => !SECRET.test(k)).slice(0, 60); } catch (err) { return null; }
    };
    const describe = (value) => {
      if (value === null || value === undefined) return String(value);
      if (Array.isArray(value)) return `array(${value.length})`;
      if (typeof value === 'object') {
        const name = value.constructor && value.constructor.name;
        return `${name && name !== 'Object' ? name : 'object'}{${(keysOf(value) || []).slice(0, 12).join(',')}}`;
      }
      return typeof value;
    };
    const runtime = { handle, globals: [], roots: {}, matches: [], searched: 0, truncated: false };
    runtime.globals = Object.keys(window).filter((k) => /^__(react|remix|next|nuxt)/i.test(k)).slice(0, 30);

    const roots = [
      ['window.__reactRouterContext', window.__reactRouterContext],
      ['window.__reactRouterContext.state', window.__reactRouterContext && window.__reactRouterContext.state],
      ['window.__reactRouterContext.state.loaderData', window.__reactRouterContext && window.__reactRouterContext.state && window.__reactRouterContext.state.loaderData],
      ['window.__reactRouterDataRouter', window.__reactRouterDataRouter],
      ['window.__reactRouterDataRouter.state', window.__reactRouterDataRouter && window.__reactRouterDataRouter.state],
      ['window.__reactRouterDataRouter.state.loaderData', window.__reactRouterDataRouter && window.__reactRouterDataRouter.state && window.__reactRouterDataRouter.state.loaderData],
      ['window.__remixRouter.state.loaderData', window.__remixRouter && window.__remixRouter.state && window.__remixRouter.state.loaderData],
      ['window.__remixContext.state.loaderData', window.__remixContext && window.__remixContext.state && window.__remixContext.state.loaderData]
    ];
    for (const [name, value] of roots) {
      runtime.roots[name] = value === undefined ? 'absent' : { is: describe(value), keys: keysOf(value) };
    }
    /* what the streamed-payload plumbing is, by kind only */
    if (window.__reactRouterContext) {
      runtime.stream = {};
      for (const key of ['stream', 'streamController', 'decoder', 'decode']) {
        if (key in window.__reactRouterContext) runtime.stream[key] = describe(window.__reactRouterContext[key]);
      }
      runtime.stream.locked = window.__reactRouterContext.stream && 'locked' in window.__reactRouterContext.stream
        ? Boolean(window.__reactRouterContext.stream.locked) : null;
    }

    /* the images inside a matched product, by path, a few levels down */
    const imagesWithin = (root, base) => {
      const found = [];
      const stack = [{ node: root, path: base, depth: 0 }];
      const seen = new WeakSet();
      let budget = 4000;
      while (stack.length && budget-- > 0 && found.length < 16) {
        const { node, path, depth } = stack.pop();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        for (const key of keysOf(node) || []) {
          let value;
          try { value = node[key]; } catch (err) { continue; }
          const at = Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`;
          if (typeof value === 'string' && IMAGE.test(value)) found.push({ path: at, url: value.slice(0, 300) });
          else if (value && typeof value === 'object' && depth < 6) stack.push({ node: value, path: at, depth: depth + 1 });
        }
      }
      return found;
    };

    if (handle) {
      const seen = new WeakSet();
      const queue = roots.filter(([, value]) => value && typeof value === 'object').map(([name, value]) => ({ node: value, path: name, depth: 0 }));
      while (queue.length) {
        if (runtime.searched >= 60000) { runtime.truncated = true; break; }
        const { node, path, depth } = queue.shift();
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        runtime.searched += 1;
        if (typeof Node !== 'undefined' && node instanceof Node) continue;
        const keys = keysOf(node) || [];
        let hit = false;
        for (const key of keys) {
          let value;
          try { value = node[key]; } catch (err) { continue; }
          if (typeof value === 'string' && value.toLowerCase() === handle) hit = true;
          else if (value && typeof value === 'object' && depth < 14) {
            queue.push({ node: value, path: Array.isArray(node) ? `${path}[${key}]` : `${path}.${key}`, depth: depth + 1 });
          }
        }
        if (hit && runtime.matches.length < 12) {
          const field = (key) => (typeof node[key] === 'string' || typeof node[key] === 'number' ? String(node[key]).slice(0, 200) : node[key] === undefined ? null : describe(node[key]));
          const shapes = {};
          for (const key of ['media', 'images', 'featuredImage', 'variants', 'selectedVariant', 'firstVariant']) {
            if (key in node) shapes[key] = describe(node[key]);
          }
          runtime.matches.push({
            path,
            id: field('id'),
            handle: field('handle'),
            title: field('title'),
            typename: field('__typename'),
            keys,
            shapes,
            images: imagesWithin(node, path)
          });
        }
      }
    }
    diagnostics.runtime = runtime;
  } catch (err) {
    diagnostics.runtime = { failed: String(err && err.message ? err.message : err).slice(0, 200) };
  }

  return {
    canonical: text('link[rel="canonical"]', 'href') || metas['og:url'] || null,
    metas,
    jsonld,
    detail,
    preload,
    imgs,
    diagnostics
  };
}

/* One page, in a real browser, reported the same way fetchPage reports:
   candidates in priority order, or a reason there are none. */
async function renderPage(url, within) {
  const chromium = loadPlaywright();
  if (!chromium) return { failed: 'Playwright is not installed here, so the browser path is unavailable', noBrowser: true };

  /* the whole render — launch, open, settle, scroll, read — under one
     ceiling, because the individual waits below cannot see each other
     and five reasonable ones in a row are not a reasonable total */
  const budget = within || budgetOf(RENDER_BUDGET);
  if (budget.spent()) return { failed: 'there was no time left in this row to open a browser' };

  /* never 0: Playwright reads a timeout of 0 as "no timeout at all",
     so a budget that emptied between the check above and this line
     would turn the ceiling into its opposite */
  const launch = {
    args: ['--disable-blink-features=AutomationControlled'],
    timeout: Math.max(1, budget.cap(RENDER_BUDGET))
  };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;

  let browser;
  try {
    browser = await chromium.launch(launch);
  } catch (err) {
    return { failed: `Chromium would not start (${err && err.message ? err.message.split('\n')[0] : 'unknown'})`, noBrowser: true };
  }

  /* Closing is the caller's to do, once the images have been checked
     through this page's own context — see the note on `verify` below.
     Every path out of here that does NOT hand the page over closes it
     itself, and closing twice is harmless. */
  const close = async () => { await browser.close().catch(() => {}); };

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
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1, budget.cap(BROWSER_TIMEOUT))
      });
      status = response ? response.status() : null;
    } catch (err) {
      await close();
      return { failed: `the browser could not open the page (${String(err.message).split('\n')[0]})` };
    }

    /* Give the gallery a chance to build itself, without hanging on a
       page that never goes idle. A retailer's page carries analytics
       beacons and live chat that keep the network busy for as long as
       anyone watches, so this wait almost always ran to its full length
       — it was not a wait for the gallery, it was a flat toll on every
       page. What actually loads a lazy gallery is the scroll below, so
       the toll is now a short one. */
    await page.waitForLoadState('networkidle', { timeout: Math.max(1, budget.cap(SETTLE_TIMEOUT)) }).catch(() => {});
    await page.waitForTimeout(Math.min(1200, budget.left()));

    /* A consent wall sits over the gallery and, on some retailers, stops
       its images loading at all until it is answered. Accepting it is
       what a shopper does to see the page, and it is the only thing
       clicked here — nothing is submitted, bought or logged into. */
    const consent = await dismissConsent(page, budget);
    if (consent) await page.waitForTimeout(Math.min(800, budget.left()));

    /* a gallery that loads as it is scrolled shows nothing to a browser
       that never scrolls, so the page is walked down before it is read */
    await coaxLazyImages(page, budget);

    const seen = await page.evaluate(gatherInPage);

    /* a Shopify listing's own product, as the page's router hydrated it:
       read here, on the page already open, and only the fields
       reactRouterProducts takes — never the state itself */
    const listing = shopifyHandle(url);
    if (listing) {
      try {
        seen.reactRouter = await page.evaluate(`(${reactRouterProducts.toString()})(${JSON.stringify(listing.handle)})`);
      } catch (err) {
        seen.reactRouter = { failed: String(err && err.message ? err.message : err).split('\n')[0].slice(0, 200) };
      }
    }

    /* the products a category page's own framework state lists, read on
       the page already open; discovery decides whether to offer them */
    try {
      const state = await page.evaluate(`(${pageStateTiles.toString()})(${embeddedProductTiles.toString()})`);
      seen.embeddedTiles = state && Array.isArray(state.tiles) ? state.tiles : [];
      seen.embeddedStats = state && state.stats ? state.stats : null;
    } catch (err) {
      seen.embeddedTiles = [];
      seen.embeddedStats = { failed: String(err && err.message ? err.message : err).split('\n')[0].slice(0, 200) };
    }

    if (status && status >= 400) {
      await close();
      return { failed: `the page answered ${status} to a real browser too` };
    }

    /* The page stays OPEN, and this is the whole point of it. `verify`
       checks an image through this page's own browsing context, which is
       how a CDN that only serves to a session which has loaded the page
       gets judged the way the page's own requests are judged. It was
       being handed back after the browser had already been closed, so
       every image the browser path ever found was refused by the
       loadable gate with "Target page, context or browser has been
       closed" — the gate was not passing wrong photos, it was passing
       none, and the whole render was spent to reach it. The caller
       closes once it has finished checking. */
    return { seen, loaded, finalUrl: page.url(), verify: imageFetcherFor(page, budget), fetchRecord: recordFetcherFor(page, budget), close };
  } catch (err) {
    await close();
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

async function dismissConsent(page, within) {
  const budget = within || budgetOf(RENDER_BUDGET);
  for (const selector of CONSENT) {
    /* a wall that has not been found by the time the page's budget is
       gone is a wall this run reads around rather than through */
    if (budget.spent()) return null;
    try {
      const button = page.locator(selector).first();
      if (!(await button.isVisible({ timeout: Math.max(1, budget.cap(400)) }).catch(() => false))) continue;
      await button.click({ timeout: Math.max(1, budget.cap(2000)) });
      return selector;
    } catch (err) { /* the next one, or none at all */ }
  }
  return null;
}

/* Walks the page down in screenfuls so an image that only loads when it
   scrolls into view actually loads, then returns to the top so the
   gallery is measured where the page puts it. */
async function coaxLazyImages(page, within) {
  const budget = within || budgetOf(RENDER_BUDGET);
  try {
    /* the walk carries its own deadline INSIDE the page, because
       page.evaluate takes no timeout and a scroll handler that never
       returns would otherwise be the one thing here with no ceiling
       over it at all */
    const walk = Math.max(1, budget.cap(6 * 250 + 200));
    await page.evaluate(async (deadline) => {
      const until = Date.now() + deadline;
      const step = Math.round(window.innerHeight * 0.8);
      const end = Math.min(document.body.scrollHeight, step * 6);
      for (let y = 0; y <= end && Date.now() < until; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 250));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 200));
    }, walk);
    /* whatever that started, give it a moment to arrive */
    await page.waitForLoadState('networkidle', {
      timeout: Math.max(1, budget.cap(SETTLE_AFTER_SCROLL))
    }).catch(() => {});
  } catch (err) { /* a page that will not scroll is read as it stands */ }
}

/* An image check that goes through the browser's own context, so a CDN
   that only serves to a session which has loaded the page is judged the
   way the page's own requests are. Shaped like request() so verifyImage
   does not care which one it was handed. */
function imageFetcherFor(page, within) {
  const budget = within || budgetOf(RENDER_BUDGET);
  return async (url, extra, ms) => {
    /* page.evaluate has no timeout of its own, so the ceiling goes
       INSIDE the page as an AbortController. Without it an image host
       that accepts the connection and then serves nothing forever
       stalls this evaluate, and with it the row, with nothing above to
       cut it off. */
    const ceiling = Math.max(1, budget.cap(ms === undefined || ms === null ? IMAGE_TIMEOUT : ms));
    try {
      const result = await page.evaluate(async ({ url, extra, ceiling }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ceiling);
        try {
          const response = await fetch(url, { headers: extra || {}, redirect: 'follow', signal: controller.signal });
          const buffer = await response.arrayBuffer();
          const type = response.headers.get('content-type') || '';
          /* the browser can decode every format a shop serves, so it
             says how big the picture is rather than leaving it to a
             header this side might not know how to read */
          let width = 0;
          let height = 0;
          try {
            const bitmap = await createImageBitmap(new Blob([buffer], { type }));
            width = bitmap.width;
            height = bitmap.height;
            bitmap.close();
          } catch (err) { /* undecodable: judged on everything else */ }
          return { status: response.status, type, bytes: buffer.byteLength, width, height };
        } finally {
          clearTimeout(timer);
        }
      }, { url, extra, ceiling });
      return {
        ok: true,
        response: {
          status: result.status,
          headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? result.type : null) },
          arrayBuffer: async () => ({ byteLength: result.bytes }),
          dimensions: result.width > 0 && result.height > 0 ? { width: result.width, height: result.height } : null,
          body: null
        }
      };
    } catch (err) {
      return { ok: false, why: String(err && err.message ? err.message : err).split('\n')[0] };
    }
  };
}

/* The rendered page asking its OWN origin for a text resource — the
   Shopify .js record — the way its scripts would. Shaped like request()
   so productRecordFor does not care which one it was handed. Anything
   that is not the page's origin, or that redirects off it, is not
   fetched or not believed; the body is capped, and a record cut short by
   the cap is simply not JSON. */
const RECORD_MAX_CHARS = 2000000;

function recordFetcherFor(page, within) {
  const budget = within || budgetOf(RENDER_BUDGET);
  return async (url, extra, ms) => {
    const ceiling = Math.max(1, budget.cap(ms === undefined || ms === null ? TIMEOUT : ms));
    try {
      const result = await page.evaluate(async ({ url, extra, ceiling, most }) => {
        if (new URL(url, location.href).origin !== location.origin) return { offOrigin: true };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ceiling);
        try {
          const response = await fetch(url, {
            headers: Object.assign({ accept: 'application/json' }, extra || {}),
            credentials: 'same-origin',
            redirect: 'follow',
            signal: controller.signal
          });
          const body = await response.text();
          return { status: response.status, finalOrigin: new URL(response.url || url, location.href).origin, origin: location.origin, text: body.slice(0, most) };
        } finally {
          clearTimeout(timer);
        }
      }, { url, extra, ceiling, most: RECORD_MAX_CHARS });
      if (result.offOrigin) return { ok: false, why: 'it is not on the rendered page\'s own origin' };
      if (result.finalOrigin !== result.origin) return { ok: false, why: `it redirected off the page's origin, to ${result.finalOrigin}` };
      return {
        ok: true,
        response: { status: result.status, text: async () => result.text, body: null },
        release: () => {}
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
  for (const hit of fromJsonLd(nodes)) raw.push({ url: hit.url, from: 'json-ld (rendered)', node: hit.node, shape: hit.shape });
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

  const page = pageDeclarationsFromRendered(seen);
  return dedupe(raw, pageUrl, seen.canonical).map((one) => Object.assign(one, { page }));
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

/* ---------- TEMPORARY: image-gate diagnostics ----------

   A run that finds real listings and verifies none of their photos says
   "233 image candidates, none cleared every gate" and nothing else, so
   the gate doing the refusing cannot be seen. Everything in this section
   REPORTS; none of it decides. No verdict reads a field set here, and
   deleting the section (and the few lines that call it, each marked
   "diagnostics") leaves every gate exactly as it is.

   Printed and written to DIAGNOSIS_FILE only under --diagnose. */
const DIAGNOSIS_FILE = path.join(__dirname, '..', '.catalog-image-diagnosis.tmp.json');
const DIAGNOSIS_LOG = [];

/* which gate turned a candidate down, in words a tally can group. A
   candidate is refused by the FIRST gate it fails — host, then
   identity, then loadable — so this is its first and main reason. */
function refusalCategory(gate, why) {
  const said = String(why || '');
  if (gate === 'asset') {
    if (/icon or vector format/i.test(said)) return 'site-asset (icon/vector file)';
    if (/stand-in/i.test(said)) return 'site-asset (placeholder/stand-in)';
    return 'site-asset';
  }
  if (gate === 'host') {
    if (/not a URL|cannot load on an https page/i.test(said)) return 'unsupported protocol/URL';
    if (/aggregator or stock host/i.test(said)) return 'wrong host (aggregator/stock)';
    return 'host: other';
  }
  if (gate === 'identity') {
    if (/carries no product code/i.test(said)) return 'identity not proven — listing URL has no product code';
    if (/product record/i.test(said)) return 'identity not proven — product record';
    if (/is a different garment/i.test(said)) return 'evidence mismatch (canonical names a different garment)';
    if (/is not a product photo/i.test(said)) return 'site-asset (refused on the canonical branch)';
    if (/parameter, which names the stand-in/i.test(said)) return 'identity not proven — code only in a fallback parameter';
    if (/not a URL/i.test(said)) return 'unsupported protocol/URL';
    if (/nothing ties it/i.test(said)) return 'identity not proven';
    return 'identity: other';
  }
  if (gate === 'loadable') {
    if (/hotlink blocked/i.test(said)) return 'image hotlink-blocked (served plainly, refused with Referer)';
    if (/^answered (401|403|418|429)\b/i.test(said)) return 'image refused by host (401/403/418/429)';
    if (/^answered 200 as /i.test(said)) return 'image served a non-image content-type';
    if (/^answered \d+/i.test(said)) return 'image failed to load (HTTP status)';
    if (/too small/i.test(said)) return `image too small (under ${MIN_BYTES} bytes)`;
    if (/the size of an icon|the shape of a logo or a banner/i.test(said)) return 'invalid dimensions/aspect ratio';
    if (/icon or vector format/i.test(said)) return 'image served as an icon/vector content-type';
    if (/ran out|never reached/i.test(said)) return 'not reached (time ran out)';
    if (/failed to fetch|typeerror|networkerror|cors/i.test(said)) return 'image failed to load (in-page fetch refused — CORS?)';
    if (/timed out|unreachable|image host|refused for/i.test(said)) return 'image failed to load (network/timeout)';
    return 'image failed to load (other)';
  }
  return `other gate: ${gate}`;
}

/* where a candidate came from, in the terms of the question being asked:
   which kind of evidence put this URL in front of the gates */
function evidenceSource(candidate) {
  const from = String((candidate && candidate.from) || '');
  if (from.startsWith('json-ld')) {
    const type = String((candidate.node && candidate.node['@type']) || '');
    if (/productgroup/i.test(type)) return 'JSON-LD ProductGroup';
    if (candidate.shape === 'ImageObject') return 'JSON-LD ImageObject';
    return 'JSON-LD Product';
  }
  if (/^(og|twitter):/.test(from)) return 'social meta (og/twitter)';
  if (from.startsWith('preload')) return 'preload link';
  if (from.startsWith('gallery')) return 'gallery img/srcset (rendered)';
  if (from === 'rendered image') return 'other drawn <img> (rendered)';
  if (from === 'loaded by the page') return 'network-loaded image (everything the page fetched)';
  if (from === 'product-record') return candidate.record && candidate.record.source === 'embedded-react-router' ? 'embedded React Router product' : 'Shopify product record';
  return 'other';
}

/* what a URL LOOKS like, for reading a tally — there is no site-asset
   gate, and this is not one: nothing is refused for matching it */
const SITE_ASSET_LOOK = /(logo|icon|sprite|favicon|placeholder|spinner|loader|banner|badge|payment|klarna|afterpay|paypal|apple-?pay|flag|pixel|tracking|beacon|spacer|blank|\.svg(\?|$)|\.gif(\?|$))/i;

function diagnosedRefusal(candidate, gate, why) {
  return {
    url: candidate.url,
    from: candidate.from,
    gate,
    why,
    category: refusalCategory(gate, why),
    source: evidenceSource(candidate),
    looksLikeSiteAsset: SITE_ASSET_LOOK.test(String(candidate.url || ''))
  };
}

/* What a page offers that could tie a photo to its product, whether or
   not this pipeline reads it. ProductGroup variants, Shopify's product
   record and a framework's embedded state are NOT read by any gate —
   this only says whether they are there to be read. */
function pageFactsFrom(nodes, extra) {
  const ids = (node) => {
    const out = {};
    for (const key of ['sku', 'mpn', 'productID', 'productId', 'productGroupID', 'gtin', 'gtin13', 'gtin12']) {
      if (typeof node[key] === 'string' || typeof node[key] === 'number') out[key] = String(node[key]);
    }
    return out;
  };
  const products = [];
  for (const node of nodes) {
    const type = String(node['@type'] || '');
    if (!/product/i.test(type)) continue;
    const images = Array.isArray(node.image) ? node.image : node.image ? [node.image] : [];
    const variants = Array.isArray(node.hasVariant) ? node.hasVariant : [];
    products.push({
      type,
      name: typeof node.name === 'string' ? node.name.slice(0, 80) : null,
      ids: ids(node),
      images: images.length,
      imageObjects: images.filter((one) => one && typeof one === 'object').length,
      /* an ImageObject that names its file only as contentUrl is never
         taken — fromJsonLd reads .url */
      imageObjectsWithoutUrl: images.filter((one) => one && typeof one === 'object' && typeof one.url !== 'string').length,
      variants: variants.length,
      variantIds: variants.slice(0, 4).map((one) => (one && typeof one === 'object' ? ids(one) : {})),
      variantImages: variants.reduce((n, one) => n + (one && one.image ? (Array.isArray(one.image) ? one.image.length : 1) : 0), 0)
    });
  }
  return Object.assign({
    jsonLdTypes: [...new Set(nodes.map((node) => String(node['@type'] || '?')))].slice(0, 12),
    products
  }, extra || {});
}

const EMBEDDED_MARKERS = ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', 'data-product-json'];

function pageFactsFromHtml(html) {
  const text = String(html || '');
  const shopifyId = text.match(/"product"\s*:\s*\{\s*"id"\s*:\s*(\d{6,})/);
  return pageFactsFrom(jsonLdNodes(text), {
    /* what was actually seen, named: a page that only loads images from
       Shopify's CDN is a Shopify store, not a page carrying a record */
    shopify: /ShopifyAnalytics|Shopify\.shop|cdn\.shopify\.com|\/cdn\/shop\//.test(text)
      ? {
        productId: shopifyId ? shopifyId[1] : null,
        signals: [
          /ShopifyAnalytics/.test(text) && 'ShopifyAnalytics',
          /Shopify\.shop/.test(text) && 'Shopify.shop',
          /cdn\.shopify\.com|\/cdn\/shop\//.test(text) && 'Shopify CDN URLs',
          shopifyId && '"product":{"id":…}'
        ].filter(Boolean)
      }
      : null,
    embedded: EMBEDDED_MARKERS.filter((marker) => text.includes(marker))
  });
}

function pageFactsFromRendered(seen) {
  const nodes = [];
  for (const block of (seen && seen.jsonld) || []) nodes.push(...parseLdBlock(block));
  const probe = (seen && seen.diagnostics) || {};
  return pageFactsFrom(nodes, { shopify: probe.shopify || null, embedded: probe.embedded || [] });
}

/* the metadata a page states about itself, in one shape for both ways
   of reading it, so the two can be compared */
function metadataOf(canonical, metas, nodes) {
  return {
    canonical: canonical || null,
    ogImage: (metas && metas['og:image']) ? decode(String(metas['og:image'])) : null,
    ogTitle: (metas && metas['og:title']) ? decode(String(metas['og:title'])).trim() : null,
    jsonLdProducts: (nodes || [])
      .filter((node) => /product/i.test(String(node['@type'] || '')))
      .map((node) => `${node['@type']}:${typeof node.name === 'string' ? node.name.trim() : '?'}`)
  };
}

function metadataDiffers(metadata) {
  if (!metadata || !metadata.served || !metadata.rendered) return null;
  const changed = [];
  for (const key of ['canonical', 'ogImage', 'ogTitle']) {
    if ((metadata.served[key] || null) !== (metadata.rendered[key] || null)) changed.push(key);
  }
  if (JSON.stringify(metadata.served.jsonLdProducts) !== JSON.stringify(metadata.rendered.jsonLdProducts)) changed.push('JSON-LD products');
  return changed;
}

/* TEMPORARY: every excerpt of page text is redacted before it is printed
   or saved. A React Router page streams its loaders' data in the same
   script as the product, and a root loader commonly carries env values —
   a Storefront API token among them. So: the value of any credential-
   named key, in `key: value`, `key=value` or the turbo-stream
   `"key","value"` form; the known Shopify token shapes; JWTs and bearer
   strings; and any long opaque hex or base64 run, because a turbo-stream
   value can sit far from the key that names it. */
const CREDENTIAL_KEY = '[A-Za-z0-9_$-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|cookie|session|credential|signature|private)[A-Za-z0-9_$-]*';
function redact(text) {
  return String(text === undefined || text === null ? '' : text)
    /* first, so a credential-named header does not take "Bearer" as its value */
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(new RegExp(`((?:\\\\)?["']?${CREDENTIAL_KEY}(?:\\\\)?["']?\\s*[:=]\\s*(?:\\\\)?["']?)([^"'\\\\,}\\]\\s]{4,})`, 'gi'), '$1[REDACTED]')
    .replace(new RegExp(`((?:\\\\)?"${CREDENTIAL_KEY}(?:\\\\)?"\\s*,\\s*(?:\\\\)?")([^"\\\\]{4,})`, 'gi'), '$1[REDACTED]')
    .replace(/\b(shpat|shpca|shpss|shppa|shptka)_[A-Za-z0-9]{8,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED]')
    .replace(/(^|[^A-Za-z0-9/._-])([A-Za-z0-9+/_-]{40,}={0,2})(?=$|[^A-Za-z0-9/._-])/g, '$1[REDACTED]');
}

/* TEMPORARY capture limits: bounded windows, never the whole script */
const CAPTURE_WINDOW = 2000;
const CAPTURE_OCCURRENCES = 6;
const CAPTURE_MARKERS = [
  'gid://shopify/Product/',
  'gid://shopify/ProductVariant/',
  '"title"',
  '"handle"',
  '"images"',
  '"featuredImage"',
  '"media"',
  '"variants"'
];

/* what kind of payload a script is, from what it says about itself */
function payloadFramework(body) {
  const head = body.slice(0, 400);
  const whole = [
    [/self\.__next_f\.push\(/, 'Next.js app-router flight data (self.__next_f.push)'],
    [/__remixContext/, 'Remix (window.__remixContext)'],
    [/__NEXT_DATA__/, 'Next.js pages-router (__NEXT_DATA__)'],
    [/__NUXT__/, 'Nuxt (__NUXT__)'],
    [/__INITIAL_STATE__|__PRELOADED_STATE__|__APOLLO_STATE__/, 'a framework state assignment'],
    [/ShopifyAnalytics/, 'ShopifyAnalytics'],
    [/Shopify\.theme|window\.Shopify\b/, 'Shopify theme globals']
  ];
  for (const [re, name] of whole) if (re.test(head)) return `${name} — named in its first 400 characters`;
  for (const [re, name] of whole) if (re.test(body)) return `${name} — named further in`;
  return 'unrecognised';
}

/* one handle mention, with the text either side and what lies near it */
function occurrenceContext(body, at, handle) {
  const from = Math.max(0, at - CAPTURE_WINDOW);
  const to = Math.min(body.length, at + handle.length + CAPTURE_WINDOW);
  const before = body.slice(from, at);
  const after = body.slice(at + handle.length, to);

  /* the nearest mention of each marker on either side, written plainly
     or escaped inside a JS string (\"title\"), within the whole script */
  const nearest = {};
  for (const marker of CAPTURE_MARKERS) {
    const forms = [marker];
    if (marker.startsWith('"')) forms.push(marker.replace(/"/g, '\\"'));
    let best = null;
    for (const form of forms) {
      const back = body.lastIndexOf(form, at);
      const ahead = body.indexOf(form, at + handle.length);
      for (const [pos, side] of [[back, 'before'], [ahead, 'after']]) {
        if (pos < 0) continue;
        const distance = side === 'before' ? at - pos : pos - (at + handle.length);
        if (!best || distance < best.distance) {
          best = {
            side,
            distance,
            form: form === marker ? 'plain' : 'escaped',
            snippet: redact(body.slice(Math.max(0, pos - 80), Math.min(body.length, pos + form.length + 220)))
          };
        }
      }
    }
    nearest[marker] = best;
  }

  const window = before + handle + after;
  const uniq = (list) => [...new Set(list)];
  const contains = {
    handle: window.includes(handle),
    productIds: uniq(window.match(/gid:\/\/shopify\/Product\/\d+/g) || []).slice(0, 8),
    variantIds: uniq(window.match(/gid:\/\/shopify\/ProductVariant\/\d+/g) || []).slice(0, 8),
    titles: uniq([...window.matchAll(/\\?"title\\?"\s*:\s*\\?"([^"\\]{1,120})/g)].map((m) => m[1])).slice(0, 8),
    imageUrls: uniq(window.match(/(?:https?:)?\/\/[^\s"'\\<>]+?\.(?:jpe?g|png|webp|avif|gif)(?:\?[^\s"'\\<>]*)?/gi) || []).slice(0, 12),
    /* how the text is put together around it: whether objects open and
       close inside the window, and which way the nesting leans */
    boundaries: {
      opens: (window.match(/\{/g) || []).length,
      closes: (window.match(/\}/g) || []).length,
      arrays: (window.match(/\[/g) || []).length,
      flightChunks: (window.match(/self\.__next_f\.push/g) || []).length,
      escapedQuotes: (window.match(/\\"/g) || []).length
    }
  };

  return { at, before: redact(before), after: redact(after), nearest, contains };
}

/* Where a page carries the listing's own product, found by its handle
   rather than by guessing a framework. Every <script> whose text names
   the handle is described: its attributes, whether it parses as JSON,
   and — for JSON — the path to each object whose handle is this one and
   the keys that object carries; otherwise the text around each mention,
   so the real structure can be read before anything is built on it.
   Reporting only. */
function recordCapture(html, productUrl) {
  const listing = shopifyHandle(productUrl);
  if (!listing || !html) return null;
  const handle = listing.handle;
  const out = { handle, scripts: [] };
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let index = 0;
  while ((m = re.exec(String(html)))) {
    index += 1;
    const attrs = m[1].trim().replace(/\s+/g, ' ').slice(0, 200);
    const body = m[2];
    if (!body.includes(handle)) continue;
    const entry = {
      index,
      attrs,
      length: body.length,
      mentions: 0,
      json: false,
      head: redact(body.slice(0, 200)),
      framework: payloadFramework(body),
      objects: [],
      around: [],
      occurrences: []
    };
    let at = body.indexOf(handle);
    while (at >= 0) {
      entry.mentions += 1;
      if (entry.around.length < 4) {
        entry.around.push(redact(body.slice(Math.max(0, at - 220), at + handle.length + 220)).replace(/\s+/g, ' '));
      }
      if (entry.occurrences.length < CAPTURE_OCCURRENCES) entry.occurrences.push(occurrenceContext(body, at, handle));
      at = body.indexOf(handle, at + handle.length);
    }
    let parsed;
    try { parsed = JSON.parse(body.trim()); entry.json = true; } catch (err) { parsed = undefined; }
    if (entry.json) {
      const stack = [{ node: parsed, path: '$' }];
      let seen = 0;
      while (stack.length && seen < 20000) {
        seen += 1;
        const { node, path: where } = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (!Array.isArray(node) && typeof node.handle === 'string' && node.handle.toLowerCase() === handle && entry.objects.length < 6) {
          entry.objects.push({
            path: where,
            keys: Object.keys(node).slice(0, 40),
            id: node.id === undefined ? null : String(node.id).slice(0, 60),
            title: typeof node.title === 'string' ? redact(node.title.slice(0, 120)) : null
          });
        }
        for (const [key, value] of Object.entries(node)) {
          if (value && typeof value === 'object') stack.push({ node: value, path: `${where}${Array.isArray(node) ? `[${key}]` : `.${key}`}` });
        }
      }
      entry.around = entry.around.slice(0, 1);
    }
    out.scripts.push(entry);
    if (out.scripts.length >= 12) break;
  }
  return out;
}

/* one listing's refusals, counted two ways */
function tallyRefusals(refusals) {
  const byCategory = {};
  const bySource = {};
  let siteAssetLike = 0;
  for (const one of refusals || []) {
    if (!one) continue;
    const category = one.category || refusalCategory(one.gate, one.why);
    const source = one.source || 'other';
    byCategory[category] = (byCategory[category] || 0) + 1;
    bySource[source] = bySource[source] || { total: 0, byCategory: {} };
    bySource[source].total += 1;
    bySource[source].byCategory[category] = (bySource[source].byCategory[category] || 0) + 1;
    if (one.looksLikeSiteAsset) siteAssetLike += 1;
  }
  const ranked = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  return { total: (refusals || []).length, byCategory, bySource, siteAssetLike, main: ranked.length ? ranked[0][0] : null };
}

/* The candidates that COULD have been this product's photo — everything
   a page publishes as its product image, as opposed to the pool of every
   image it fetched — because their refusals are the ones that matter. */
function likelyProductRefusals(refusals, limit) {
  return (refusals || [])
    .filter((one) => one && one.source !== 'network-loaded image (everything the page fetched)' && !one.looksLikeSiteAsset)
    .slice(0, limit || 8);
}

function printImageDiagnosis(indent, diagnosis) {
  if (!diagnosis) return;
  const pad = ' '.repeat(indent);
  const tally = tallyRefusals(diagnosis.refusals);
  console.log(`${pad}IMAGE DIAGNOSIS — ${tally.total} candidate${tally.total === 1 ? '' : 's'} refused; first rejecting gate:`);
  for (const [category, n] of Object.entries(tally.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`${pad}  ${String(n).padStart(5)}  ${category}`);
  }
  console.log(`${pad}  (${tally.siteAssetLike} of them look like site assets by a broad URL pattern — a reading aid, not the asset gate)`);
  console.log(`${pad}by evidence source:`);
  for (const [source, entry] of Object.entries(tally.bySource).sort((a, b) => b[1].total - a[1].total)) {
    const top = Object.entries(entry.byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} ${c}`).join('; ');
    console.log(`${pad}  ${String(entry.total).padStart(5)}  ${source} — ${top}`);
  }
  console.log(`${pad}  never offered as candidates by this pipeline: ProductGroup variants; a category page's embedded product tiles are offered only as their own product pages`);
  const embedded = diagnosis.embeddedRecord;
  if (embedded) {
    console.log(`${pad}product record: ${embedded.failed ? `embedded React Router product ${embedded.skipped ? 'not read' : 'offered nothing'} — ${embedded.failed}`
      : `embedded React Router product ${embedded.handle} (product ${embedded.id}, "${embedded.title}") offered ${embedded.images} media.nodes[*].image.url image${embedded.images === 1 ? '' : 's'}${embedded.previewOnly ? `; ${embedded.previewOnly} preview-only node${embedded.previewOnly === 1 ? '' : 's'} not taken` : ''}`}`);
  }
  const record = diagnosis.productRecord;
  const through = record && record.via === 'browser' ? ' (asked by the rendered page)' : '';
  console.log(`${pad}Shopify product record${through}: ${!record ? 'not asked for (a candidate verified first, the page never rendered, or time ran out)'
    : record.failed ? `${record.skipped ? 'not asked for' : 'offered nothing'} — ${record.failed}`
      : `${record.handle} (product ${record.id}, "${record.title}") lists ${record.images} image${record.images === 1 ? '' : 's'}`}`);

  const page = diagnosis.page || {};
  console.log(`${pad}listing codes: ${(diagnosis.listingCodes || []).join(', ') || '(none — every candidate fails identity before the canonical check)'}`);
  console.log(`${pad}canonical: ${diagnosis.canonical || '(none)'}${diagnosis.canonical ? ` — ${diagnosis.canonicalMatchesListing ? 'same page as the listing' : 'NOT the listing\'s page'}` : ''}`);
  for (const [label, facts] of [['served', page.served], ['rendered', page.rendered]]) {
    if (!facts) continue;
    const products = (facts.products || []).map((p) => {
      const idText = Object.entries(p.ids).map(([k, v]) => `${k}=${v}`).join(' ') || 'no ids';
      return `${p.type} [${idText}] ${p.images} image${p.images === 1 ? '' : 's'}` +
        `${p.imageObjects ? ` (${p.imageObjects} ImageObject${p.imageObjectsWithoutUrl ? `, ${p.imageObjectsWithoutUrl} without .url — dropped` : ''})` : ''}` +
        `${p.variants ? `, ${p.variants} variants (${p.variantImages} variant images, unread)` : ''}`;
    });
    console.log(`${pad}${label} page: JSON-LD ${products.length ? products.join(' | ') : `has no Product node (types: ${(facts.jsonLdTypes || []).join(', ') || 'none'})`}`);
    if (facts.shopify && facts.shopify.signals) {
      console.log(`${pad}  Shopify signals: ${facts.shopify.signals.join(', ')}${facts.shopify.productId ? ` — product id ${facts.shopify.productId}` : ' — no product id seen, so no record is known to be here'}`);
    } else if (facts.shopify) console.log(`${pad}  ShopifyAnalytics.meta.product present${facts.shopify.productId ? ` (product id ${facts.shopify.productId})` : ''}${facts.shopify.variants !== undefined ? `, ${facts.shopify.variants} variants${facts.shopify.skus && facts.shopify.skus.length ? ` skus ${facts.shopify.skus.join(', ')}` : ''}` : ''} (the page's own copy; the gate reads /products/<handle>.js instead)`);
    if (facts.embedded && facts.embedded.length) console.log(`${pad}  embedded product data present: ${facts.embedded.join(', ')} — see "product tiles" below`);
  }
  for (const line of tileLines(diagnosis.tiles)) console.log(`${pad}${line}`);
  const capture = diagnosis.recordCapture;
  if (capture) {
    console.log(`${pad}where the served page names the handle ${capture.handle}: ${capture.scripts.length ? `${capture.scripts.length} script${capture.scripts.length === 1 ? '' : 's'}` : 'in no <script> at all'}`);
    for (const one of capture.scripts) {
      console.log(`${pad}  <script ${one.attrs || '(no attributes)'}> #${one.index}, ${one.length} chars, ${one.mentions} mention${one.mentions === 1 ? '' : 's'}, ${one.json ? 'JSON' : 'not JSON'}`);
      for (const obj of one.objects) {
        console.log(`${pad}    ${obj.path}: id ${obj.id}, title ${JSON.stringify(obj.title)}, keys ${obj.keys.join(', ')}`);
      }
      if (!one.objects.length && one.around.length) console.log(`${pad}    …${short(one.around[0], 160)}…`);
      console.log(`${pad}    framework: ${one.framework}`);
      console.log(`${pad}    first 200 characters:`);
      console.log(`${pad}      ${JSON.stringify(one.head)}`);
      one.occurrences.forEach((occ, n) => {
        console.log(`${pad}    ── mention ${n + 1} of ${one.mentions}, at character ${occ.at} ──`);
        const c = occ.contains;
        console.log(`${pad}    in the ${CAPTURE_WINDOW}-character windows either side:`);
        console.log(`${pad}      product ids: ${c.productIds.join(', ') || '(none)'}`);
        console.log(`${pad}      variant ids: ${c.variantIds.length ? `${c.variantIds.length} — ${c.variantIds.slice(0, 3).join(', ')}` : '(none)'}`);
        console.log(`${pad}      titles:      ${c.titles.map((t) => JSON.stringify(t)).join(', ') || '(none)'}`);
        console.log(`${pad}      image urls:  ${c.imageUrls.length}${c.imageUrls.length ? ` — ${c.imageUrls.slice(0, 4).join('  ')}` : ''}`);
        console.log(`${pad}      boundaries:  ${c.boundaries.opens} {, ${c.boundaries.closes} }, ${c.boundaries.arrays} [, ${c.boundaries.flightChunks} __next_f.push, ${c.boundaries.escapedQuotes} escaped quotes`);
        console.log(`${pad}    nearest markers:`);
        for (const [marker, near] of Object.entries(occ.nearest)) {
          console.log(`${pad}      ${marker.padEnd(30)} ${near ? `${near.distance} chars ${near.side} (${near.form})` : 'not in this script'}`);
          if (near) console.log(`${pad}        ${JSON.stringify(near.snippet.slice(0, 260))}`);
        }
        console.log(`${pad}    BEFORE (${occ.before.length} chars):`);
        console.log(occ.before);
        console.log(`${pad}    >>> ${capture.handle} <<<`);
        console.log(`${pad}    AFTER (${occ.after.length} chars):`);
        console.log(occ.after);
        console.log('');
      });
    }
  }
  const runtime = diagnosis.runtime;
  if (runtime) {
    console.log(`${pad}HYDRATED RUNTIME (browser):`);
    if (runtime.failed) console.log(`${pad}  the probe failed: ${runtime.failed}`);
    else {
      console.log(`${pad}  framework globals: ${runtime.globals.join(', ') || '(none)'}`);
      for (const [name, info] of Object.entries(runtime.roots)) {
        console.log(`${pad}  ${name}: ${info === 'absent' ? 'absent' : `${info.is}${info.keys ? ` — keys: ${info.keys.join(', ')}` : ''}`}`);
      }
      if (runtime.stream) console.log(`${pad}  stream plumbing: ${Object.entries(runtime.stream).map(([k, v]) => `${k}=${v}`).join(', ')}`);
      console.log(`${pad}  searched ${runtime.searched} objects for ${runtime.handle}${runtime.truncated ? ' (stopped at the limit)' : ''}: ${runtime.matches.length} match${runtime.matches.length === 1 ? '' : 'es'}`);
      for (const match of runtime.matches) {
        console.log(`${pad}  ▸ ${match.path}`);
        console.log(`${pad}      id ${match.id}  handle ${match.handle}  title ${JSON.stringify(match.title)}${match.typename ? `  __typename ${match.typename}` : ''}`);
        console.log(`${pad}      keys: ${match.keys.join(', ')}`);
        const shapes = Object.entries(match.shapes);
        console.log(`${pad}      media/images/featuredImage/variants: ${shapes.length ? shapes.map(([k, v]) => `${k}=${v}`).join('; ') : 'none of them'}`);
        console.log(`${pad}      image URLs inside it: ${match.images.length}`);
        for (const image of match.images.slice(0, 10)) console.log(`${pad}        ${image.path} = ${short(image.url, 120)}`);
      }
    }
  }
  const md = diagnosis.metadata || {};
  const changed = metadataDiffers(md);
  if (changed === null) {
    console.log(`${pad}metadata: ${md.served ? 'only plain HTTP read the page' : md.rendered ? 'only the browser read the page' : 'the page was read neither way'}, so there is nothing to compare`);
  } else {
    console.log(`${pad}metadata, plain HTTP vs browser: ${changed.length ? `DIFFERS in ${changed.join(', ')}` : 'the same'}`);
    for (const key of changed) {
      const show = (v) => (Array.isArray(v) ? v.join(' | ') || '(none)' : v || '(none)');
      const field = key === 'JSON-LD products' ? 'jsonLdProducts' : key;
      console.log(`${pad}  served:   ${short(show(md.served[field]), 110)}`);
      console.log(`${pad}  rendered: ${short(show(md.rendered[field]), 110)}`);
    }
  }
  const codes = diagnosis.listingCodes || [];
  const carrying = (diagnosis.refusals || []).filter((one) => one && codes.some((id) => String(one.url || '').toLowerCase().includes(id)));
  console.log(`${pad}candidates whose URL carries a listing code: ${carrying.length}`);
  const loadedButRefused = (diagnosis.refusals || []).filter((one) => one && one.pageLoadedIt);
  if (loadedButRefused.length) {
    console.log(`${pad}${loadedButRefused.length} image${loadedButRefused.length === 1 ? '' : 's'} the page itself loaded with a 200 were refused by the loadable check:`);
    for (const one of loadedButRefused.slice(0, 4)) console.log(`${pad}  ${short(one.url, 90)} — ${one.why}`);
  }
  if (diagnosis.loadedByPage !== undefined) console.log(`${pad}the rendered page itself loaded ${diagnosis.loadedByPage} image${diagnosis.loadedByPage === 1 ? '' : 's'} with a 200`);

  const likely = likelyProductRefusals(diagnosis.refusals, 8);
  if (likely.length) {
    console.log(`${pad}the candidates that could have been the product photo, and what stopped each:`);
    for (const one of likely) {
      console.log(`${pad}  [${one.gate}] ${one.source}${one.pageLoadedIt ? ' — the page itself loaded this image' : ''}`);
      console.log(`${pad}      ${short(one.url, 110)}`);
      console.log(`${pad}      ${one.why}`);
    }
  } else {
    console.log(`${pad}no candidate came from anything the page publishes as its product image`);
  }
}

function recordDiagnosis(entry) {
  DIAGNOSIS_LOG.push(entry);
}

function writeDiagnosisFile() {
  const rollup = tallyRefusals(DIAGNOSIS_LOG.flatMap((one) => (one.diagnosis && one.diagnosis.refusals) || []));
  const byListing = DIAGNOSIS_LOG.map((one) => {
    const tally = tallyRefusals((one.diagnosis && one.diagnosis.refusals) || []);
    return {
      rowId: one.rowId,
      listing: one.listing,
      title: one.title || null,
      verdict: one.verdict,
      why: typeof one.why === 'string' ? one.why : JSON.stringify(one.why),
      main: tally.main,
      byCategory: tally.byCategory,
      bySource: tally.bySource,
      siteAssetLike: tally.siteAssetLike,
      listingCodes: one.diagnosis ? one.diagnosis.listingCodes : [],
      canonical: one.diagnosis ? one.diagnosis.canonical : null,
      canonicalMatchesListing: one.diagnosis ? one.diagnosis.canonicalMatchesListing : null,
      page: one.diagnosis ? one.diagnosis.page : null,
      loadedByPage: one.diagnosis ? one.diagnosis.loadedByPage : null,
      productRecord: one.diagnosis ? one.diagnosis.productRecord || null : null,
      embeddedRecord: one.diagnosis ? one.diagnosis.embeddedRecord || null : null,
      tiles: one.diagnosis ? one.diagnosis.tiles || null : null,
      recordCapture: one.diagnosis ? one.diagnosis.recordCapture || null : null,
      runtime: one.diagnosis ? one.diagnosis.runtime || null : null,
      metadata: one.diagnosis ? one.diagnosis.metadata || null : null,
      metadataDiffers: one.diagnosis ? metadataDiffers(one.diagnosis.metadata) : null,
      likelyProduct: likelyProductRefusals(one.diagnosis && one.diagnosis.refusals, 20),
      refusals: one.diagnosis ? one.diagnosis.refusals : []
    };
  });
  fs.writeFileSync(DIAGNOSIS_FILE, JSON.stringify({
    createdAt: new Date().toISOString(),
    note: 'temporary image-gate diagnostics; nothing in here decided anything',
    rollup,
    byListing
  }, null, 2));
  return { file: DIAGNOSIS_FILE, rollup, listings: byListing.length };
}

function printDiagnosisRollup() {
  const all = DIAGNOSIS_LOG.flatMap((one) => (one.diagnosis && one.diagnosis.refusals) || []);
  const tally = tallyRefusals(all);
  const likely = tallyRefusals(likelyProductRefusals(all, Infinity));
  console.log(`  IMAGE DIAGNOSIS, whole run — ${DIAGNOSIS_LOG.length} listing page${DIAGNOSIS_LOG.length === 1 ? '' : 's'} read, ${tally.total} candidates refused:`);
  for (const [category, n] of Object.entries(tally.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(6)}  ${category}`);
  }
  console.log(`  of which ${likely.total} came from what a page publishes as its product image (JSON-LD, og/twitter, preload, gallery):`);
  for (const [category, n] of Object.entries(likely.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(6)}  ${category}`);
  }
}

/* ---------- one row ---------- */

/* Walks candidates in order and returns the first that clears every
   gate, or the reasons they all failed. */
async function firstVerifiable(candidates, row, fetcher, within) {
  const budget = within || budgetOf(ROW_BUDGET);
  /* each refusal keeps the URL and the gate that turned it down, because
     "none of them worked" is not a diagnosis — which gate stopped which
     candidate is what says whether the page was read wrong, the wrong
     product was offered, or the host refused to serve us */
  /* diagnostics: the same four fields, plus a category and a source the
     tally reads — nothing below looks at them */
  const note = (candidate, gate, why) => diagnosedRefusal(candidate, gate, why);

  /* The two gates that need nothing from the network are decided first,
     in order and for free. A lane is a network operation, and spending
     one on a candidate the host gate or the identity gate has already
     refused is the cheapest thing here done the most expensive way. */
  /* whether this listing is a product page at all, settled once from its
     own shape and from what each candidate's page declared; only the
     canonical rule reads it */
  const title = row.name && row.name !== row.productUrl ? row.name : '';
  const shape = listingShape(row.productUrl, title);
  const decided = candidates.map((offered) => {
    const candidate = Object.assign({}, offered, { productPage: productPageVerdict(shape, offered.page) });
    const unsound = soundness(candidate, row.productUrl);
    if (unsound) return { candidate, refusal: note(candidate, 'host', unsound) };

    /* a logo, a share card or a placeholder is refused before anyone
       asks which product it shows, because it shows none */
    const asset = siteAsset(candidate, row.productUrl);
    if (asset) return { candidate, refusal: note(candidate, 'asset', asset) };

    const identity = identityEvidence(candidate, row.productUrl);
    if (!identity.ok) return { candidate, refusal: note(candidate, 'identity', identity.why) };

    return { candidate, identity };
  });

  const loadable = decided.filter((one) => !one.refusal);
  const { results, winner } = await raceInOrder(loadable, LANES, async (one) => {
    if (budget.spent()) return { ok: false, why: 'the time for this page ran out before this candidate was loaded' };
    const check = await verifyImage(one.candidate.url, fetcher, budget.cap(IMAGE_TIMEOUT));
    return { ok: check.ok, why: check.why };
  });

  if (winner >= 0) {
    const one = loadable[winner];
    return {
      url: one.candidate.url,
      why: `${results[winner].why} — ${one.identity.how}`,
      from: one.candidate.from,
      identity: one.identity
    };
  }

  /* refusals in the order the candidates were offered in, whatever
     order they happened to come back in */
  const loadRefusals = new Map();
  loadable.forEach((one, at) => {
    const result = results[at];
    const why = result && result.threw
      ? `it could not be checked (${String(result.threw.message || result.threw).split('\n')[0]})`
      : result && result.why ? result.why
        : 'it was never reached — the time for this page ran out';
    loadRefusals.set(one, note(one.candidate, 'loadable', why));
  });

  return { refusals: decided.map((one) => one.refusal || loadRefusals.get(one)) };
}

/* diagnostics: the verdict is resolveRowInner's, untouched; this only
   hangs what the gates saw off the side of it */
async function resolveRow(row, within, options) {
  const diagnosis = { listingCodes: identifiersFrom(row.productUrl), canonical: null, page: {}, refusals: [] };
  /* the products the page's own data lists — kept apart from the
     diagnosis, which reports and never decides */
  const tiles = [];
  tiles.stats = { served: {}, rendered: null };
  const result = await resolveRowInner(row, within, diagnosis, options || {}, tiles);
  diagnosis.canonicalMatchesListing = diagnosis.canonical ? samePage(diagnosis.canonical, row.productUrl) : null;
  const linkStats = {};
  const productLinks = listingProductLinks(row.productUrl, tiles, linkStats);
  /* diagnostics: what the page data held, what was taken, and why the
     rest was not — field names only, never the data */
  diagnosis.tiles = tileReport(tiles, productLinks, linkStats);
  return Object.assign(result, { diagnosis, productLinks });
}

async function resolveRowInner(row, within, diagnosis, options, tiles) {
  const budget = within || budgetOf(ROW_BUDGET);
  const notes = [];
  let facts = { name: null, brand: null };

  /* ---- plain HTTP ---- */
  const page = await fetchPage(row.productUrl, budget.cap(TIMEOUT));
  let served = null;

  let evidence = [];

  if (page.html) {
    diagnosis.page.served = pageFactsFromHtml(page.html);
    diagnosis.recordCapture = recordCapture(page.html, row.productUrl);
    diagnosis.canonical = canonicalOf(page.html);
    diagnosis.metadata = diagnosis.metadata || {};
    diagnosis.metadata.served = metadataOf(canonicalOf(page.html), {
      'og:image': metaContent(page.html, 'og:image'),
      'og:title': metaContent(page.html, 'og:title')
    }, jsonLdNodes(page.html));
    facts = factsFromHtml(page.html);
    /* what this page says about its own product, kept whether or not a
       photo comes out of it: the semantic gate asks for it afterwards */
    evidence = evidenceFromHtml(page.html);
    if (tiles) {
      tiles.push(...tilesFromHtml(page.html, tiles.stats.served));
      if (shopifyCollection(row.productUrl) && SHOPIFY_PAGE.test(page.html) && !budget.spent()) {
        tiles.push(...await collectionTiles(row.productUrl, request, budget.cap(TIMEOUT), tiles.stats.served));
      }
    }
    const candidates = candidatesFrom(page.html, row.productUrl);
    notes.push(`plain HTTP: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);
    if (candidates.length) {
      served = await firstVerifiable(candidates, row, null, budget);
      diagnosis.refusals.push(...(served.refusals || []));
      if (served.url) return { id: row.id, verdict: 'VERIFIED', why: served.why, url: served.url, from: served.from, identity: served.identity, facts, evidence, notes };
    }

    /* The store's own product record, asked for only when nothing the
       page published could be tied to its product, and only because the
       page itself was served to a plain request: a store that refuses
       its page to one is not asked for its record by one. Its photos
       are decided by the same gates, in the same order. */
    if (!budget.spent()) {
      const fromStore = await productRecordFor(row.productUrl, options.catalogRow, budget.cap(TIMEOUT));
      diagnosis.productRecord = fromStore.record
        ? { handle: fromStore.record.handle, id: fromStore.record.id, title: fromStore.record.title, images: fromStore.record.images.length }
        : { failed: fromStore.failed, skipped: Boolean(fromStore.skipped) };
      if (!fromStore.skipped) {
        notes.push(fromStore.record
          ? `product record: ${fromStore.record.handle} lists ${fromStore.record.images.length} image${fromStore.record.images.length === 1 ? '' : 's'}`
          : `product record: ${fromStore.failed}`);
      }
      if (fromStore.candidates && fromStore.candidates.length) {
        const recorded = await firstVerifiable(fromStore.candidates, row, null, budget);
        diagnosis.refusals.push(...(recorded.refusals || []));
        if (recorded.url) return { id: row.id, verdict: 'VERIFIED', why: recorded.why, url: recorded.url, from: recorded.from, identity: recorded.identity, facts, evidence, notes };
        served = { refusals: [...((served && served.refusals) || []), ...(recorded.refusals || [])] };
      }
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

  const rendered = await renderPage(row.productUrl, budgetOf(budget.cap(RENDER_BUDGET)));
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

  /* the browser stays open until the images have been checked through
     it, and is closed on every way out from here */
  const shut = rendered.close || (async () => {});
  let found;
  try {
    diagnosis.page.rendered = pageFactsFromRendered(rendered.seen);
    diagnosis.runtime = (rendered.seen.diagnostics && rendered.seen.diagnostics.runtime) || null;
    diagnosis.metadata = diagnosis.metadata || {};
    diagnosis.metadata.rendered = metadataOf(rendered.seen.canonical, rendered.seen.metas || {},
      (rendered.seen.jsonld || []).flatMap((block) => parseLdBlock(block)));
    diagnosis.canonical = rendered.seen.canonical || diagnosis.canonical;
    diagnosis.loadedByPage = (rendered.loaded || []).length;
    facts = factsFromRendered(rendered.seen);
    if (tiles) {
      tiles.stats.rendered = Object.assign({}, rendered.seen.embeddedStats || {});
      tiles.push(...embeddedProductTiles((rendered.seen.jsonld || []).flatMap((block) => parseLdBlock(block)), 'json-ld (rendered)', 200, tiles.stats.rendered));
      tiles.push(...(Array.isArray(rendered.seen.embeddedTiles) ? rendered.seen.embeddedTiles : []));
      /* plain HTTP never got this page, so the browser that did asks */
      if (!page.html && tiles.stats.rendered.shopify && shopifyCollection(row.productUrl) && !budget.spent()) {
        tiles.push(...await collectionTiles(row.productUrl, rendered.fetchRecord, budget.cap(TIMEOUT), tiles.stats.rendered));
      }
    }
    /* the rendered page knows which text belongs to the product, because
       it can ask the DOM rather than guess from markup */
    evidence = evidenceFromRendered(rendered.seen).concat(evidence);
    const candidates = candidatesFromRendered(rendered.seen, rendered.loaded, row.productUrl);
    notes.push(`browser: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`);

    found = candidates.length ? await firstVerifiable(candidates, row, rendered.verify, budget) : { refusals: [] };
    /* diagnostics: an image the page itself loaded with a 200 and the
       loadable gate still refused is a refusal of the CHECK, not of the
       image, and is marked so the tally can tell the two apart */
    const pageLoaded = new Set(rendered.loaded || []);
    for (const one of found.refusals || []) {
      if (one && one.gate === 'loadable' && pageLoaded.has(one.url)) one.pageLoadedIt = true;
      diagnosis.refusals.push(one);
    }

    /* The product the page's router hydrated, asked for only when nothing
       the rendered page drew could be tied to its product. It is read off
       the page already open — no request — and its photos are checked
       through that page, by the same gates, in the same order. */
    if (!found.url && !budget.spent()) {
      const embedded = embeddedRecordFrom(rendered.seen.reactRouter, row.productUrl, options.catalogRow, rendered.seen.canonical);
      diagnosis.embeddedRecord = embedded.record
        ? { source: embedded.record.source, handle: embedded.record.handle, id: embedded.record.id, title: embedded.record.title, images: embedded.record.images.length, previewOnly: embedded.record.previewOnly }
        : { failed: embedded.failed, skipped: Boolean(embedded.skipped) };
      if (!embedded.skipped) {
        notes.push(embedded.record
          ? `product record: embedded React Router product ${embedded.record.handle} lists ${embedded.record.images.length} media image${embedded.record.images.length === 1 ? '' : 's'}`
          : `product record (embedded): ${embedded.failed}`);
      }
      if (embedded.candidates && embedded.candidates.length) {
        const recorded = await firstVerifiable(embedded.candidates, row, rendered.verify, budget);
        diagnosis.refusals.push(...(recorded.refusals || []));
        found = recorded.url ? recorded : { refusals: [...found.refusals, ...(recorded.refusals || [])] };
      }
    }

    /* The store's own .js record, for a store that served its page only
       to the browser: plain HTTP never got the page, so it never asked
       for the record, and the browser that did get the page asks for it
       now, same-origin. A page that plain HTTP DID get has had its record
       asked for already, and refused is refused. */
    if (!found.url && !page.html && !budget.spent()) {
      const fromPage = await browserProductRecord(rendered, row.productUrl, options.catalogRow, budget.cap(TIMEOUT));
      diagnosis.productRecord = fromPage.record
        ? { via: 'browser', handle: fromPage.record.handle, id: fromPage.record.id, title: fromPage.record.title, images: fromPage.record.images.length }
        : { via: 'browser', failed: fromPage.failed, skipped: Boolean(fromPage.skipped) };
      if (!fromPage.skipped) {
        notes.push(fromPage.record
          ? `product record (browser): ${fromPage.record.handle} lists ${fromPage.record.images.length} image${fromPage.record.images.length === 1 ? '' : 's'}`
          : `product record (browser): ${fromPage.failed}`);
      }
      if (fromPage.candidates && fromPage.candidates.length) {
        const recorded = await firstVerifiable(fromPage.candidates, row, rendered.verify, budget);
        diagnosis.refusals.push(...(recorded.refusals || []));
        found = recorded.url ? recorded : { refusals: [...found.refusals, ...(recorded.refusals || [])] };
      }
    }

    if (!found.url && !candidates.length && !found.refusals.length) {
      return { id: row.id, verdict: 'NO IMAGE FOUND', why: 'the rendered page published no product image either', url: null, notes };
    }
  } finally {
    await shut();
  }

  if (found.url) return { id: row.id, verdict: 'VERIFIED', why: found.why, url: found.url, from: found.from, identity: found.identity, facts, evidence, notes };

  const all = [...(served && served.refusals ? served.refusals : []), ...found.refusals];
  return {
    id: row.id,
    verdict: 'NO IMAGE FOUND',
    why: `${all.length} candidate${all.length === 1 ? '' : 's'} found, none cleared every gate`,
    url: null,
    refusals: all,
    facts,
    evidence,
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
  if (evidence.via === 'product-record' && evidence.source === 'embedded-react-router' && evidence.handle && evidence.productId && evidence.title) {
    const clean = (value) => String(value).replace(/['\\\r\n]/g, '');
    return `{ via: 'product-record', source: 'embedded-react-router', handle: '${clean(evidence.handle)}', productId: '${clean(evidence.productId)}', title: '${clean(evidence.title)}' }`;
  }
  if (evidence.via === 'product-record' && evidence.handle && evidence.productId && evidence.title) {
    const clean = (value) => String(value).replace(/['\\\r\n]/g, '');
    return `{ via: 'product-record', handle: '${clean(evidence.handle)}', productId: '${clean(evidence.productId)}', title: '${clean(evidence.title)}' }`;
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
  /* the row this would replace, for anything that has to be held against
     the garment it means — a store's product record, for one. With no
     --as, nothing is. */
  const catalogRow = forId ? (readCatalog().rows.find((one) => one && one.id === forId) || null) : null;
  const result = await resolveRow(row, undefined, { catalogRow });
  const facts = result.facts || {};

  console.log(`\n  ${result.verdict.padEnd(15)} ${productUrl}`);
  for (const note of result.notes || []) console.log(`  ${''.padEnd(15)} · ${note}`);

  if (result.verdict !== 'VERIFIED') {
    console.log(`  ${''.padEnd(15)} ${result.why}`);
    for (const refusal of (result.refusals || []).slice(0, 12)) {
      console.log(`  ${''.padEnd(15)}   [${refusal.gate}] ${short(refusal.url)}`);
      console.log(`  ${''.padEnd(15)}     from ${refusal.from} — ${refusal.why}`);
    }
    /* diagnostics */
    if (diagnosing) {
      console.log('');
      printImageDiagnosis(4, result.diagnosis);
      recordDiagnosis({ rowId: forId || 'candidate', listing: productUrl, verdict: result.verdict, why: result.why, diagnosis: result.diagnosis });
      console.log(`\n  Written to ${rel(writeDiagnosisFile().file)}.`);
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
  return { productUrl, imageUrl: result.url, name: facts.name, brand: facts.brand, identity: result.identity };
}

/* One string field of one row, replaced in place. The row is found by
   its id and the field by the first match after it, so nothing outside
   the row it names can move. */
function setField(source, id, field, value) {
  if (value == null) return source;
  const idAt = source.indexOf(`id: '${id}'`);
  if (idAt === -1) throw new Error(`could not find the row for ${id}`);
  const re = new RegExp(`(\\n\\s*${field}:\\s*)(null|'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`);
  const rest = source.slice(idAt);
  const m = rest.match(re);
  if (!m) throw new Error(`could not find ${field} for ${id}`);
  if (/[\r\n]/.test(value)) throw new Error(`refusing to write a multi-line ${field} for ${id}`);
  const quoted = value.includes("'")
    ? `"${value.replace(/"/g, '\\"')}"`
    : `'${value}'`;
  const at = idAt + m.index;
  return source.slice(0, at) + m[1] + quoted + source.slice(at + m[0].length);
}

/* the indent the row is written at, read off its own imageUrl line, so
   an evidence note lands in the file's own shape */
function indentOf(source, id) {
  const idAt = source.indexOf(`id: '${id}'`);
  if (idAt === -1) throw new Error(`could not find the row for ${id}`);
  const m = source.slice(idAt).match(/(\n\s*)imageUrl:/);
  return m ? m[1].replace(/\n/, '') : '    ';
}

/* ---------- what discovery is allowed to write ----------

   A sample row's identity is the demo's own. "Tailored Wool Coat" by
   Halden is what the catalogue means by that row, and discovery's job is
   to find a real garment that REPRESENTS it — not to rename the row
   after whatever shop happened to stock one. A row renamed to "MANGO
   Double-breasted wool coat" is no longer the row the demo was built
   around, and its price, category, style, occasion and fit now describe
   a product nobody chose.

   So discovery fills exactly three fields and touches nothing else:
   productUrl, imageUrl, and the imageEvidence that ties the second to
   the first. id, name, brand, price, category, style, occasion, fit,
   colors and sizes are left exactly as they were.

   The evidence is not optional. A photo whose URL does not carry the
   listing's own code cannot be re-proved later without it, and a row
   that cannot be re-proved is one --coverage reports as unaccounted.
   Whatever the image gate established is what gets recorded, so a
   written row accounts for itself the moment it is written. */
function linkRow(source, id, proposal) {
  if (!proposal || !proposal.productUrl || !proposal.imageUrl) {
    throw new Error(`refusing to link ${id} without both a listing and a photo`);
  }
  const indent = indentOf(source, id);
  let out = setField(source, id, 'productUrl', proposal.productUrl);
  out = setField(out, id, 'imageUrl', proposal.imageUrl);

  /* the gate's own finding, recorded verbatim. A URL that carries the
     code speaks for itself and is given no note; anything else records
     how it was tied, and a tie the gate could not make is a row this
     should never have been called for. */
  const note = evidenceNote(proposal.identity);
  if (!note && !identityEvidence({ url: proposal.imageUrl, from: 'catalogue' }, proposal.productUrl).ok) {
    throw new Error(
      `refusing to write ${id}: its photo does not carry the listing's code and the gate recorded no evidence to stand in for it`
    );
  }
  return setEvidence(out, id, note, indent);
}

/* Swaps a row's product for a verified candidate: the listing, the
   photo, the name and the brand move together, because half a swap is a
   row that points at one product and pictures another. This is the
   deliberate, hand-driven replacement (--candidate --as); discovery uses
   linkRow above, which leaves a row's identity alone. */
function replaceRow(source, id, next) {
  const indent = indentOf(source, id);
  let out = source;
  for (const field of ['name', 'brand', 'productUrl', 'imageUrl']) {
    out = setField(out, id, field, next[field]);
  }
  /* the same evidence rule: a swapped row has to account for its new
     photo too, or --coverage will call it unaccounted */
  if (next.productUrl && next.imageUrl) {
    out = setEvidence(out, id, evidenceNote(next.identity), indent);
  }
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

/* ---------- the semantic gate: is this listing the garment the row means? ----------

   The four gates above all ask one question about a picture: does this
   image belong to THIS listing. None of them can ask the question that
   comes before it — whether the listing is the GARMENT the row asked
   for. A photo can be provably the hero image of a real product page, on
   the retailer's own CDN, carrying that listing's own code, and still be
   the wrong answer, because the product on that page is not what the row
   means.

   That is not hypothetical. Asked for Kinfield's "Fleece Sweatpant" the
   source offered Aerie's "Street Trouser": a real listing, a real photo,
   every identity gate cleared — and a trouser, which is not a sweatpant.
   The picture was right about the page and wrong about the catalogue.

   So a listing is read as a garment before its page is ever fetched, and
   that reading is compared with the row's own:

     type         sweatpant, trouser, skirt, blazer, sneaker… taken from
                  the head noun, because English puts it last: a "ribbed
                  knit skirt" is a skirt, not a knit
     family       bottom, top, outerwear, dress, footwear. Two garments in
                  different families are never the same garment, which is
                  what refuses a hoodie for a jacket and a sneaker for
                  anything that is not a shoe
     audience     an adult-sized row is not answered with a girls' listing
     gender       compared where both sides say
     material     compared where both sides say, and only across the fibre
                  families that genuinely exclude each other: wool is not
                  cotton, leather is not cloth. A fibre that blends with
                  anything contradicts nothing
     descriptors  midi, cropped, pleated, wrap, double-breasted, wide leg,
                  printed, heavyweight… grouped so that only CONTRADICTION
                  refuses. A listing silent about length is not refused
                  for a midi row; a listing that says mini is

   Brand is deliberately NOT compared. Most of these rows are samples
   whose brands were invented — Kinfield, Northfold, Rue Nine and the
   rest exist nowhere — so demanding the brand would refuse every correct
   answer there is. What is compared is the garment the listing describes.

   Silence is not contradiction, and that asymmetry is the whole design:
   "Crepe Khloe Blazer" answers "Double Breasted Blazer" because nothing
   in it says the blazer is anything else. Audience is the one exception,
   because a girls' skirt is a different product rather than an
   under-described one.

   Every decision it makes is printed, pass or refusal, with the reason —
   a gate whose refusals are invisible cannot be argued with, and this one
   is meant to be argued with. */

/* Garment types. `terms` are matched as whole words over the singularised
   tokens of a name, longest first, so "sweatpant" is never read as "pant"
   and "dress pant" is never read as "dress". A `generic` type names a
   family without choosing within it: "pant" and "top" are generic, while
   "trouser" and "tee" are specific claims about what the garment is. */
const GARMENT_TYPES = [
  /* footwear */
  { type: 'sneaker', family: 'footwear', terms: ['sneaker', 'trainer', 'running shoe', 'tennis shoe'] },
  { type: 'boot', family: 'footwear', terms: ['boot', 'bootie', 'chelsea boot'] },
  { type: 'sandal', family: 'footwear', terms: ['sandal', 'slide', 'flip flop', 'espadrille'] },
  { type: 'loafer', family: 'footwear', terms: ['loafer', 'moccasin', 'mule'] },
  { type: 'heel', family: 'footwear', terms: ['heel', 'pump', 'stiletto'] },
  { type: 'shoe', family: 'footwear', generic: true, terms: ['shoe', 'footwear'] },

  /* outerwear */
  { type: 'coat', family: 'outerwear', terms: ['coat', 'overcoat', 'topcoat', 'peacoat', 'pea coat', 'trench', 'trench coat', 'raincoat', 'rain coat', 'duster'] },
  { type: 'parka', family: 'outerwear', terms: ['parka', 'anorak'] },
  /* "puffer jacket" and "puffer coat" are how shops title a puffer; as
     whole terms they outrank the bare "jacket" and "coat" beside them,
     which would otherwise be read as the head noun */
  { type: 'puffer', family: 'outerwear', terms: ['puffer', 'puffer jacket', 'puffer coat', 'down jacket', 'quilted jacket'] },
  { type: 'blazer', family: 'outerwear', terms: ['blazer', 'sport coat', 'sports coat', 'suit jacket', 'dinner jacket'] },
  { type: 'vest', family: 'outerwear', terms: ['vest', 'gilet', 'waistcoat'] },
  { type: 'jacket', family: 'outerwear', terms: ['jacket', 'bomber', 'windbreaker', 'shacket', 'track jacket', 'denim jacket', 'trucker jacket'] },

  /* tops */
  { type: 'hoodie', family: 'top', terms: ['hoodie', 'hoody', 'hooded sweatshirt'] },
  { type: 'sweatshirt', family: 'top', terms: ['sweatshirt'] },
  { type: 'sweater', family: 'top', terms: ['sweater', 'knit', 'jumper', 'pullover', 'crew', 'turtleneck sweater'] },
  { type: 'cardigan', family: 'top', terms: ['cardigan'] },
  { type: 'tee', family: 'top', terms: ['tee', 't shirt', 'tshirt', 'tee shirt'] },
  { type: 'shirt', family: 'top', terms: ['shirt', 'blouse', 'button down', 'button up', 'oxford', 'oxford shirt', 'camp shirt', 'overshirt'] },
  { type: 'tank', family: 'top', terms: ['tank', 'tank top', 'camisole', 'cami'] },
  { type: 'polo', family: 'top', terms: ['polo'] },
  { type: 'bodysuit', family: 'top', terms: ['bodysuit', 'leotard'] },
  { type: 'top', family: 'top', generic: true, terms: ['top'] },

  /* bottoms */
  { type: 'sweatpant', family: 'bottom', terms: ['sweatpant', 'sweat pant', 'jogger', 'track pant'] },
  { type: 'trouser', family: 'bottom', terms: ['trouser', 'chino', 'slack', 'dress pant', 'suit pant'] },
  { type: 'jean', family: 'bottom', terms: ['jean', 'denim pant'] },
  { type: 'legging', family: 'bottom', terms: ['legging', 'tight'] },
  { type: 'short', family: 'bottom', terms: ['short'] },
  { type: 'skirt', family: 'bottom', terms: ['skirt', 'skort'] },
  { type: 'pant', family: 'bottom', generic: true, terms: ['pant', 'bottom'] },

  /* one-piece and the rest */
  { type: 'dress', family: 'dress', terms: ['dress', 'gown', 'sundress'] },
  { type: 'jumpsuit', family: 'onepiece', terms: ['jumpsuit', 'romper', 'playsuit', 'overall', 'coverall'] },
  { type: 'swim', family: 'swim', terms: ['swimsuit', 'bikini', 'swim short', 'swim trunk', 'trunk'] },
  { type: 'underwear', family: 'underwear', terms: ['brief', 'boxer', 'bra', 'thong', 'underwear', 'panty'] },
  { type: 'sock', family: 'accessory', terms: ['sock'] },
  { type: 'hat', family: 'accessory', terms: ['hat', 'cap', 'beanie', 'visor'] },
  { type: 'bag', family: 'accessory', terms: ['bag', 'backpack', 'tote', 'purse', 'handbag'] },
  { type: 'accessory', family: 'accessory', terms: ['scarf', 'glove', 'mitten', 'belt', 'wallet'] }
];

/* A descriptor group holds values that EXCLUDE one another: a skirt is
   midi or mini, not both. Two sides contradict when both name a value in
   the same group and they share none. A `soft` group never refuses — a
   cargo pant may also be a utility pant — and only reports what the two
   sides had in common. */
const DESCRIPTORS = [
  { group: 'length', value: 'mini', terms: ['mini', 'micro mini'] },
  { group: 'length', value: 'midi', terms: ['midi', 'midlength', 'mid length', 'tea length'] },
  { group: 'length', value: 'maxi', terms: ['maxi', 'floor length'] },
  { group: 'length', value: 'knee', terms: ['knee length', 'above the knee', 'below the knee'] },
  { group: 'length', value: 'cropped', terms: ['cropped', 'crop', 'shrunken'] },
  { group: 'length', value: 'longline', terms: ['longline', 'long line', 'ankle length', 'full length'] },

  { group: 'cut', value: 'narrow', terms: ['slim', 'skinny', 'fitted', 'tapered', 'tailored', 'bodycon', 'compression'] },
  { group: 'cut', value: 'straight', terms: ['straight', 'straight leg', 'straight fit'] },
  { group: 'cut', value: 'wide', terms: ['wide', 'wide leg', 'relaxed', 'oversized', 'baggy', 'loose', 'boxy', 'slouchy', 'flowy'] },

  { group: 'silhouette', value: 'slip', terms: ['slip'] },
  { group: 'silhouette', value: 'column', terms: ['column', 'sheath'] },
  { group: 'silhouette', value: 'shift', terms: ['shift'] },
  { group: 'silhouette', value: 'a line', terms: ['a line', 'aline'] },
  { group: 'silhouette', value: 'flare', terms: ['flare', 'flared', 'fit and flare'] },

  { group: 'closure', value: 'double breasted', terms: ['double breasted'] },
  { group: 'closure', value: 'single breasted', terms: ['single breasted'] },
  { group: 'closure', value: 'wrap', terms: ['wrap', 'surplice', 'faux wrap'] },
  { group: 'closure', value: 'zip', terms: ['zip', 'zip up', 'full zip', 'half zip', 'quarter zip'] },
  { group: 'closure', value: 'pullover', terms: ['pullover', 'popover'] },
  { group: 'closure', value: 'button', terms: ['button front', 'button up', 'button down', 'buttoned'] },

  { group: 'pattern', value: 'printed', terms: ['print', 'printed', 'graphic'] },
  { group: 'pattern', value: 'solid', terms: ['solid'] },
  { group: 'pattern', value: 'striped', terms: ['stripe', 'striped'] },
  { group: 'pattern', value: 'floral', terms: ['floral'] },
  { group: 'pattern', value: 'colour block', terms: ['colour block', 'color block', 'colourblock', 'colorblock'] },
  { group: 'pattern', value: 'check', terms: ['plaid', 'check', 'checked', 'gingham', 'tartan', 'windowpane', 'houndstooth'] },
  { group: 'pattern', value: 'camo', terms: ['camo', 'camouflage'] },
  { group: 'pattern', value: 'animal', terms: ['leopard', 'zebra', 'animal print'] },

  { group: 'texture', value: 'ribbed', terms: ['ribbed', 'rib knit'] },
  { group: 'texture', value: 'cable', terms: ['cable', 'cable knit'] },
  { group: 'texture', value: 'quilted', terms: ['quilted'] },
  { group: 'texture', value: 'pleated', terms: ['pleat', 'pleated', 'accordion pleat'] },
  { group: 'texture', value: 'waffle', terms: ['waffle'] },
  { group: 'texture', value: 'smocked', terms: ['smocked', 'shirred'] },
  { group: 'texture', value: 'washed', terms: ['washed', 'acid wash', 'stone wash', 'distressed'] },

  { group: 'sleeve', value: 'short', terms: ['short sleeve'] },
  { group: 'sleeve', value: 'long', terms: ['long sleeve'] },
  { group: 'sleeve', value: 'sleeveless', terms: ['sleeveless'] },
  { group: 'sleeve', value: 'cap', terms: ['cap sleeve'] },
  { group: 'sleeve', value: 'puff', terms: ['puff sleeve', 'puffed sleeve'] },

  { group: 'neckline', value: 'crew', terms: ['crewneck', 'crew neck'] },
  { group: 'neckline', value: 'v', terms: ['v neck', 'vneck'] },
  { group: 'neckline', value: 'scoop', terms: ['scoop neck'] },
  { group: 'neckline', value: 'turtle', terms: ['turtleneck', 'turtle neck', 'mock neck'] },
  { group: 'neckline', value: 'collared', terms: ['camp collar', 'spread collar', 'point collar'] },
  { group: 'neckline', value: 'halter', terms: ['halter'] },
  { group: 'neckline', value: 'strapless', terms: ['strapless', 'tube'] },

  { group: 'rise', value: 'high', terms: ['high rise', 'high waist', 'high waisted'] },
  { group: 'rise', value: 'mid', terms: ['mid rise'] },
  { group: 'rise', value: 'low', terms: ['low rise'] },

  { group: 'weight', value: 'heavy', terms: ['heavyweight', 'heavy weight'] },
  { group: 'weight', value: 'light', terms: ['lightweight', 'light weight'] },

  /* named because they are worth reporting as agreement, not because
     they exclude one another */
  { group: 'detail', value: 'cargo', soft: true, terms: ['cargo'] },
  { group: 'detail', value: 'utility', soft: true, terms: ['utility'] },
  { group: 'detail', value: 'performance', soft: true, terms: ['performance'] },
  { group: 'detail', value: 'track', soft: true, terms: ['track'] },
  { group: 'detail', value: 'camp', soft: true, terms: ['camp'] },
  { group: 'detail', value: 'court', soft: true, terms: ['court'] },
  { group: 'detail', value: 'pocket', soft: true, terms: ['pocket'] },
  { group: 'detail', value: 'hooded', soft: true, terms: ['hooded', 'hood'] },
  { group: 'detail', value: 'lined', soft: true, terms: ['lined', 'insulated'] },
  { group: 'detail', value: 'pleat front', soft: true, terms: ['pleat front', 'flat front'] }
];

/* Fibres, grouped by what they actually are. Only EXCLUSIVE fibres can
   contradict: wool is not cotton and leather is not cloth, but a fibre
   in `blend` — tencel, polyester, fleece, crepe, jersey — turns up mixed
   with anything and so says nothing that could contradict. */
const MATERIALS = [
  { fibre: 'wool', exclusive: true, terms: ['wool', 'merino', 'cashmere', 'alpaca', 'mohair', 'tweed', 'lambswool', 'shetland'] },
  { fibre: 'cotton', exclusive: true, terms: ['cotton', 'denim', 'poplin', 'corduroy', 'twill', 'canvas', 'chambray', 'terry', 'french terry', 'seersucker', 'flannel'] },
  { fibre: 'linen', exclusive: true, terms: ['linen', 'ramie'] },
  { fibre: 'silk', exclusive: true, terms: ['silk', 'satin', 'charmeuse', 'chiffon'] },
  { fibre: 'leather', exclusive: true, terms: ['leather', 'suede', 'shearling', 'nubuck'] },
  { fibre: 'blend', terms: ['polyester', 'nylon', 'acrylic', 'spandex', 'elastane', 'tencel', 'lyocell', 'modal', 'viscose', 'rayon', 'cupro', 'bamboo', 'fleece', 'crepe', 'velvet', 'jersey', 'ponte', 'scuba', 'mesh', 'ripstop', 'sherpa'] }
];

/* the pairs that coexist often enough that naming one is no argument
   against the other */
const FIBRES_THAT_BLEND = [['cotton', 'linen']];

/* What a fibre also counts as. Merino IS wool, so a merino listing
   establishes a row that asked for wool; wool is not merino, so it does
   not work the other way. Narrower establishes broader, never the
   reverse — which is why "cotton shirt" does not answer a poplin row. */
const FIBRE_WITHIN = {
  /* wool by definition */
  merino: ['wool'], cashmere: ['wool'], lambswool: ['wool'], shetland: ['wool'],
  alpaca: ['wool'], mohair: ['wool'], tweed: ['wool'],
  /* cotton by definition. Twill, canvas, jersey and flannel are NOT
     here: each names a weave or a knit that is made in wool and in
     polyester just as readily, so none of them establishes cotton. */
  denim: ['cotton'], poplin: ['cotton'], corduroy: ['cotton'],
  chambray: ['cotton'], terry: ['cotton'], seersucker: ['cotton'],
  'french terry': ['cotton', 'terry'],
  /* leather by definition. Satin, charmeuse and chiffon are NOT under
     silk for the same reason as twill: they are weaves, and most of
     them on sale are polyester. */
  suede: ['leather'], shearling: ['leather'], nubuck: ['leather'],
  sherpa: ['fleece'],
  /* Tencel IS lyocell, so it establishes a lyocell row. Generic lyocell
     is NOT Tencel — that is one manufacturer's — so it does not
     establish a Tencel row, and the arrow only points one way. */
  tencel: ['lyocell'],
  modal: ['viscose'], rayon: ['viscose'],
  /* elastane and spandex are two names for one fibre */
  spandex: ['elastane'], elastane: ['spandex']
};

/* ---- what has to be PROVED, not merely left uncontradicted ----

   Silence is not contradiction — that asymmetry is what lets a blazer
   listing answer a blazer row without repeating every word. But it also
   let "Jumbie Art Earth Unisex Joggers" answer a FLEECE sweatpant and
   "Mid Length Pleated Skirt" answer a MIDI one: nothing in either
   contradicted the row, and nothing in either established what the row
   actually asked for.

   So a descriptor the row's own name STATES has to be established by the
   listing. The row's name is its specification, and a word in it is a
   requirement rather than a hope. What is exempt is what titles
   routinely omit without it meaning anything: sleeve, neckline and rise
   are almost never in a product title, so demanding them would refuse
   correct answers rather than wrong ones.

   The listing may say it in its own words — "slim" establishes a
   tailored row, "relaxed" a wide one, "merino" a wool one — because the
   check is on what the words MEAN, not on matching strings. */
const DEFINING_GROUPS = new Set(['length', 'cut', 'silhouette', 'closure', 'pattern', 'texture', 'weight']);

/* inside the soft detail group, the words that name construction rather
   than marketing or a collar. "Cargo" is a pocket arrangement;
   "performance" is an adjective a shop chose, and "camp" is a collar a
   listing is as likely to call a camp collar. */
const DEFINING_DETAILS = new Set(['cargo', 'track', 'pocket']);

/* who the garment is for. A kids' listing answering an adult-sized row
   is the one place silence on the row's side is not neutral: the sizes
   say adult even when the name does not. */
const AUDIENCES = [
  { audience: 'kids', terms: ['kid', 'girl', 'boy', 'toddler', 'infant', 'baby', 'newborn', 'youth', 'junior', 'child', 'children', 'teen', 'tween', 'big kid', 'preschool', 'grade school'] },
  { audience: 'pet', terms: ['dog', 'cat', 'pet', 'doll', 'puppy'] },
  { audience: 'adult', terms: ['men', 'man', 'women', 'woman', 'lady', 'adult', 'unisex', 'misses'] }
];

const GENDERS = [
  { gender: 'men', terms: ['men', 'man', 'male', 'boy'] },
  { gender: 'women', terms: ['women', 'woman', 'female', 'lady', 'girl', 'misses'] }
];

/* ---- reading a name as a garment ---- */

/* Plurals only, and conservatively: a retailer writes "Sweatpants" where
   the catalogue writes "Sweatpant", and nothing should turn on which. */
function singular(word) {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (/ss$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singular);
}

/* a term is a sequence of tokens, so "wide leg" matches "wide-leg" and
   "Wide Leg" and nothing inside a longer word */
function vocabulary(entries) {
  const index = new Map();
  for (const entry of entries) {
    for (const term of entry.terms) {
      const tokens = tokenise(term);
      if (!tokens.length) continue;
      index.set(tokens.join(' '), { ...entry, term });
    }
  }
  return index;
}

const TYPE_INDEX = vocabulary(GARMENT_TYPES);
const DESCRIPTOR_INDEX = vocabulary(DESCRIPTORS);
const MATERIAL_INDEX = vocabulary(MATERIALS);
const AUDIENCE_INDEX = vocabulary(AUDIENCES);
const GENDER_INDEX = vocabulary(GENDERS);

/* the groups that report agreement but never refuse */
const SOFT_GROUPS = new Set(DESCRIPTORS.filter((entry) => entry.soft).map((entry) => entry.group));

const LONGEST_TERM = 4;

/* every place a vocabulary matches, with the shorter match inside a
   longer one dropped: "dress pant" is a trouser, not a dress */
function spansIn(tokens, index) {
  const spans = [];
  for (let start = 0; start < tokens.length; start += 1) {
    for (let length = Math.min(LONGEST_TERM, tokens.length - start); length >= 1; length -= 1) {
      const hit = index.get(tokens.slice(start, start + length).join(' '));
      if (hit) spans.push({ start, end: start + length, length, hit });
    }
  }
  return spans.filter((span) => !spans.some((other) =>
    other !== span && other.start <= span.start && other.end >= span.end && other.length > span.length));
}

function readGarment(text, extra) {
  const options = extra || {};
  const tokens = tokenise(text);
  const descriptorSpans = spansIn(tokens, DESCRIPTOR_INDEX);
  const materialSpans = spansIn(tokens, MATERIAL_INDEX);

  /* "short sleeve" is a sleeve, not a pair of shorts: a type term buried
     inside a longer descriptor is not a claim about the garment */
  const covered = [...descriptorSpans, ...materialSpans];
  const typeSpans = spansIn(tokens, TYPE_INDEX).filter((span) => !covered.some((other) =>
    other.start <= span.start && other.end >= span.end && other.length > span.length));

  /* the head noun: English puts it last, so a "ribbed knit skirt" is a
     skirt. A generic head — "pants", "top" — defers to the specific type
     beside it in the same family, which is what keeps "trouser pants"
     a trouser. */
  let head = typeSpans.length ? typeSpans[typeSpans.length - 1] : null;
  if (head && head.hit.generic) {
    const specific = typeSpans.filter((span) => !span.hit.generic && span.hit.family === head.hit.family);
    if (specific.length) head = specific[specific.length - 1];
  }

  /* a row that names no garment can still say one in its category */
  let via = head ? 'name' : null;
  if (!head && options.fallback) {
    const fallbackSpans = spansIn(tokenise(options.fallback), TYPE_INDEX);
    if (fallbackSpans.length) { head = fallbackSpans[fallbackSpans.length - 1]; via = 'category'; }
  }

  const descriptors = new Map();
  /* the words the name actually used, so a refusal can quote the row
     rather than the vocabulary's name for what it meant */
  const said = new Map();
  for (const span of descriptorSpans) {
    if (!descriptors.has(span.hit.group)) descriptors.set(span.hit.group, new Set());
    descriptors.get(span.hit.group).add(span.hit.value);
    if (!said.has(span.hit.group)) said.set(span.hit.group, new Set());
    said.get(span.hit.group).add(tokens.slice(span.start, span.end).join(' '));
  }

  /* A head noun that is also a fabric word is naming the GARMENT, not
     its cloth: "Colour Block Knit" is a knit, and demanding that a
     listing repeat the word "knit" would refuse every sweater. In
     "Ribbed Knit Skirt" the same word sits beside the head and does
     describe the cloth, so it is kept. */
  const fabricSpans = head && via === 'name'
    ? materialSpans.filter((span) => !(span.start === head.start && span.end === head.end))
    : materialSpans;

  const fibres = new Set(fabricSpans.map((span) => span.hit.fibre));
  /* the fabric words as the name actually said them, which is what the
     positive-evidence check compares */
  const materialTerms = new Set(fabricSpans.map((span) => tokens.slice(span.start, span.end).join(' ')));

  /* what the row asks for in its own fields rather than in its name.
     These are a permissive set — a row that lists Regular AND Slim is
     naming what would suit it, not what it IS — so they are reported,
     never used to refuse. */
  const hints = new Map();
  for (const span of spansIn(tokenise((options.hints || []).join(' ')), DESCRIPTOR_INDEX)) {
    if (!hints.has(span.hit.group)) hints.set(span.hit.group, new Set());
    hints.get(span.hit.group).add(span.hit.value);
  }

  const audiences = new Set(spansIn(tokens, AUDIENCE_INDEX).map((span) => span.hit.audience));
  const genders = new Set(spansIn(tokens, GENDER_INDEX).map((span) => span.hit.gender));

  let audience = audiences.has('kids') ? 'kids' : audiences.has('pet') ? 'pet' : audiences.has('adult') ? 'adult' : null;
  let audienceFrom = audience ? 'its name' : null;
  if (!audience && adultSizing(options.sizes)) { audience = 'adult'; audienceFrom = 'its sizes'; }

  return {
    text: String(text || ''),
    tokens,
    type: head ? head.hit.type : null,
    family: head ? head.hit.family : null,
    generic: head ? Boolean(head.hit.generic) : false,
    typeVia: via,
    types: typeSpans.map((span) => span.hit.type),
    descriptors,
    said,
    fibres,
    materialTerms,
    hints,
    audience,
    audienceFrom,
    gender: genders.size === 1 ? [...genders][0] : null
  };
}

/* XS through XL is adult sizing; 4T, 5, 6X and the rest are not. It is
   evidence rather than an assumption, which is why the refusal it
   produces can name it. */
function adultSizing(sizes) {
  const list = (Array.isArray(sizes) ? sizes : []).map((size) => String(size).trim().toUpperCase());
  if (!list.length) return false;
  return list.every((size) => /^(XXXS|XXS|XS|S|M|L|XL|XXL|XXXL|[2-6]XL|ONE SIZE|OS)$/.test(size));
}

function listOf(set) {
  return [...set].join('/');
}

/* what a pattern shop, a tutorial or a kit calls itself. Not a bare
   "pattern": a floral pattern dress is a dress. */
const NOT_THE_GARMENT = /\b(knitting|crochet|sewing|dressmaking|quilting)\s+(patterns?|kits?|tutorials?|charts?)\b|\bpatterns?\s+(pdf|download|booklet|leaflet|book)\b|\b(pdf|digital|printable|downloadable|free)\s+(knitting\s+|sewing\s+|crochet\s+)?patterns?\b|\bpatterns?\s+by\b|\btutorials?\b|\bhow\s+to\s+(knit|sew|crochet|make)\b|\b(yarn|knitting|diy)\s+kits?\b|\bravelry\b/i;

/* ---- the gate itself ---- */

/* `row` is a catalogue row; `listing` is what the source offered, or the
   page's own name once it has been read. Returns a decision and the
   sentence explaining it, which is printed either way. */
function semanticMatch(row, listing) {
  const title = String((listing && listing.title) || '').trim();
  const hints = [];
  for (const field of ['fit', 'style']) {
    const value = row && row[field];
    if (Array.isArray(value)) hints.push(...value.filter(Boolean).map(String));
  }
  const wanted = readGarment(row && row.name, {
    sizes: row && row.sizes,
    fallback: row && row.category,
    hints
  });
  const offered = readGarment(title, {});
  /* 'contradiction' is the listing saying something else; 'unproven' is
     the listing never saying what the row asked for. Both refuse, and
     the difference is printed, because they call for different fixes:
     one means look elsewhere, the other means look harder. */
  const refuse = (why, kind) => ({ ok: false, kind: kind || 'contradiction', why, wanted, offered });
  const agreed = [];

  if (!title) return refuse('the listing carries no title to read, so what it sells cannot be checked', 'unreadable');
  /* a listing that sells the MAKING of a garment — a knitting or sewing
     pattern, a kit, a tutorial — is not the garment, however well its
     name describes one */
  const making = NOT_THE_GARMENT.exec(title);
  if (making) return refuse(`"${title}" sells ${making[0].trim().toLowerCase()} — how to make a garment, not the garment`);
  if (!wanted.type) return refuse(`the row's own name — "${wanted.text}" — names no garment this can read, so nothing can be checked against it`, 'unreadable');
  if (!offered.type) return refuse(`"${title}" names no garment this can read`, 'unreadable');

  /* family, then type. A different family is a different kind of thing;
     inside one family, a specific type is a claim that has to agree. */
  if (wanted.family !== offered.family) {
    return refuse(`the row means a ${wanted.type} and "${title}" is a ${offered.type} — ${wanted.family} against ${offered.family}`);
  }
  if (wanted.type !== offered.type && !wanted.generic && !offered.generic) {
    return refuse(`the row means a ${wanted.type} and "${title}" is a ${offered.type}`);
  }
  agreed.push(wanted.type === offered.type
    ? `${offered.type} matches ${wanted.type}`
    : wanted.generic
      ? `a ${offered.type} is one of the ${wanted.type}s the row asks for`
      : `"${title}" says ${offered.type}, which the row's ${wanted.type} is one of`);

  /* audience: the one asymmetric check, because a kids' or a pet's
     garment is a different product rather than a less-described one */
  if (offered.audience && offered.audience !== 'adult' && wanted.audience === 'adult') {
    return refuse(`the row is for adults (${wanted.audienceFrom} say so) and "${title}" is ${offered.audience === 'pet' ? 'not for people' : `a ${offered.audience}' listing`}`);
  }
  if (wanted.audience && offered.audience && wanted.audience !== offered.audience) {
    return refuse(`the row is a ${wanted.audience} garment and "${title}" is a ${offered.audience} one`);
  }
  if (wanted.audience && offered.audience) agreed.push(`both ${offered.audience}`);

  /* gender, where both say */
  if (wanted.gender && offered.gender && wanted.gender !== offered.gender) {
    return refuse(`the row is ${wanted.gender}'s and "${title}" is ${offered.gender}'s`);
  }
  if (wanted.gender && offered.gender) agreed.push(`both ${offered.gender}'s`);

  /* material, where both say, and only across fibres that exclude */
  const wantedFibres = new Set([...wanted.fibres].filter((fibre) => exclusiveFibre(fibre)));
  const offeredFibres = new Set([...offered.fibres].filter((fibre) => exclusiveFibre(fibre)));
  if (wantedFibres.size && offeredFibres.size) {
    const shared = [...wantedFibres].filter((fibre) => offeredFibres.has(fibre));
    const blendable = [...wantedFibres].some((one) => [...offeredFibres].some((two) => fibresBlend(one, two)));
    if (!shared.length && !blendable) {
      return refuse(`the row is ${listOf(wantedFibres)} and "${title}" is ${listOf(offeredFibres)}`);
    }
    agreed.push(shared.length ? `${shared.join('/')} on both` : `${listOf(wantedFibres)} and ${listOf(offeredFibres)} blend`);
  }

  /* descriptors: only contradiction refuses. Silence on the listing's
     side is silence, not disagreement. */
  const unstated = [];
  const unproven = [];
  for (const [group, values] of wanted.descriptors) {
    const theirs = offered.descriptors.get(group);
    const soft = SOFT_GROUPS.has(group);
    const ours = wanted.said.get(group) || values;
    const shared = theirs ? [...values].filter((value) => theirs.has(value)) : [];

    if (shared.length) {
      /* the check is on what the words mean, so say both when they
         differ: "tailored — the listing says slim" is honest where
         "tailored on both" would not be */
      const ourWords = listOf(wanted.said.get(group) || new Set(shared));
      const theirWords = listOf(offered.said.get(group) || new Set(shared));
      agreed.push(ourWords === theirWords ? `${ourWords} on both` : `${ourWords} — the listing says ${theirWords}`);
      continue;
    }
    if (theirs && theirs.size && !soft) {
      return refuse(`the row is ${listOf(ours)} and "${title}" is ${listOf(offered.said.get(group) || theirs)}`);
    }
    /* nothing shared and nothing contradicting: either the row's word
       has to be established, or its absence is only worth a note */
    if (mustBeEstablished(group, values)) {
      unproven.push({ kind: 'descriptor', group, values: new Set(values), words: listOf(ours) });
    } else if (!soft) {
      unstated.push(`${listOf(ours)} unstated`);
    }
  }

  /* the fabric the row names has to be named back, in the listing's own
     words or a narrower one: fleece by fleece or sherpa, wool by wool or
     merino. This is what refuses a jogger that never claims to be fleece
     and a wrap top that never claims to be tencel. */
  for (const term of wanted.materialTerms) {
    if (![...offered.materialTerms].some((theirs) => theirs === term || (FIBRE_WITHIN[theirs] || []).includes(term))) {
      unproven.push({ kind: 'material', term, words: term });
    } else if (offered.materialTerms.has(term)) {
      agreed.push(`${term} on both`);
    } else {
      agreed.push(`${[...offered.materialTerms].find((theirs) => (FIBRE_WITHIN[theirs] || []).includes(term))} is ${term}`);
    }
  }

  /* A word the title never says is PENDING, not refused. The title is a
     headline; the page is the specification, and asking it is what the
     product-page stage is for. A candidate only fails on this once the
     page has been read and still does not say it. */
  if (unproven.length) {
    return {
      ok: true,
      kind: 'pending',
      pending: unproven,
      why: [
        [...new Set(agreed)].join('; ') || `${offered.type} matches ${wanted.type}`,
        `nothing contradicts, but "${title}" never says ${unproven.map(nameOfPending).join(', ')}`,
        'which the row does — its page has to establish it'
      ].filter(Boolean).join('; '),
      wanted,
      offered
    };
  }

  /* the row's own fit and style fields, reported and never decisive:
     they name what would suit the row, not what it is */
  const cautions = [];
  for (const [group, values] of wanted.hints) {
    if (wanted.descriptors.has(group)) continue;
    const theirs = offered.descriptors.get(group);
    if (!theirs || !theirs.size) continue;
    const shared = [...values].filter((value) => theirs.has(value));
    if (shared.length) agreed.push(`${shared.join('/')} as the row asks`);
    else cautions.push(`the row asks for ${listOf(values)} and "${title}" says ${listOf(offered.said.get(group) || theirs)}`);
  }

  /* descriptors the listing names that the row's group does not mention
     are extra precision, not disagreement, and are not reported */
  const why = [
    [...new Set(agreed)].join('; '),
    unstated.length ? `nothing contradicts (${unstated.join(', ')})` : 'nothing contradicts',
    ...cautions.map((note) => `worth a look: ${note}`)
  ].join('; ');
  return { ok: true, kind: 'match', why, pending: [], wanted, offered, cautions };
}

/* a descriptor group whose words the listing has to say back */
function mustBeEstablished(group, values) {
  if (DEFINING_GROUPS.has(group)) return true;
  return [...values].some((value) => DEFINING_DETAILS.has(value));
}

function exclusiveFibre(fibre) {
  return MATERIALS.some((entry) => entry.fibre === fibre && entry.exclusive);
}

function fibresBlend(one, two) {
  return FIBRES_THAT_BLEND.some((pair) => pair.includes(one) && pair.includes(two));
}

/* ---------- proving a descriptor off the product page ----------

   A shopping result's title is a headline, not a specification. "Aerie
   Real Soft Jogger" is a fleece jogger or it is not, and the title will
   not say either way — so refusing it at the title stage throws away a
   candidate that the PAGE would have settled in one line of its own
   product record.

   So the title stage no longer has the last word on a missing
   descriptor. A contradiction still ends a candidate there and then,
   because a trouser will not become a sweatpant further down the page.
   A descriptor that is merely ABSENT is carried forward as pending, and
   the page is asked.

   What the page is allowed to answer with is the question this turns
   on, because a page says far more than it sells. "You may also like:
   midi skirts" would prove `midi` about the wrong garment entirely. So
   evidence is taken from the places that describe THIS product and
   nowhere else:

     json-ld     the product's own record — name, description, material,
                 pattern, colour, size and its additionalProperty pairs,
                 which is where a retailer puts "Fabric: 100% cotton"
     meta        og:title, og:description and the page description,
                 which are written about the page's own product
     detail      text inside an element the page itself marks as the
                 product's description, details, specification,
                 composition or materials

   And nowhere near the places that describe other products:
   recommendation strips, "you may also like", carousels, cross-sells,
   breadcrumbs, navigation, headers and footers are cut out before
   anything is read, and a detail block that mentions one is dropped
   whole rather than trusted in part.

   Evidence can only ever ESTABLISH a pending descriptor. It is never
   read for contradictions: a size chart naming every length there is
   would otherwise refuse a skirt for being available in mini. The
   contradiction check stays where it can be trusted — the title, and
   the product's own name on the page. */

/* the places on a page that are about something else */
const NOT_THIS_PRODUCT = /(recommend|related|you[-_ ]?may|also[-_ ]?like|also[-_ ]?bought|complete[-_ ]?the|carousel|slider|cross[-_ ]?sell|upsell|similar|recently[-_ ]?viewed|breadcrumb|\bnav\b|navigation|menu|header|footer|newsletter|cookie|review)/i;

/* the places a retailer puts what this product is made of and is */
const ABOUT_THIS_PRODUCT = /(product[-_ ]?(description|detail|info|spec|attribute|feature)|description|composition|material|fabric|specification|details)/i;

const EVIDENCE_KEYS = ['name', 'description', 'material', 'pattern', 'color', 'colour', 'size', 'keywords'];
const PART_LIMIT = 4000;
/* A markup slice starts at an opening tag and has no reliable end: the
   block's own </div> is indistinguishable from any other. So it is cut
   short instead — a product description that needs more than this is
   one the rendered path reads exactly, with real element boundaries. */
const MARKUP_LIMIT = 1200;
const PARTS_LIMIT = 40;

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ')
    /* a slice cut mid-tag leaves an opener with no '>' to match */
    .replace(/<[^>]*$/, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PART_LIMIT);
}

/* the product's own structured record, flattened into readable parts */
function evidenceFromNodes(nodes) {
  const parts = [];
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue;
    if (!/product/i.test(String(node['@type'] || ''))) continue;

    for (const key of EVIDENCE_KEYS) {
      const value = node[key];
      if (typeof value === 'string' || typeof value === 'number') {
        const text = cleanText(value);
        if (text) parts.push({ where: `json-ld ${key}`, text });
      } else if (Array.isArray(value)) {
        const text = cleanText(value.filter((one) => typeof one === 'string' || typeof one === 'number').join(', '));
        if (text) parts.push({ where: `json-ld ${key}`, text });
      }
    }

    /* "Fabric: 100% recycled polyester fleece" lives here on most
       retailers that publish structured data at all */
    const extra = Array.isArray(node.additionalProperty) ? node.additionalProperty : [];
    for (const property of extra) {
      if (!property || typeof property !== 'object') continue;
      const text = cleanText([property.name, property.value].filter(Boolean).join(': '));
      if (text) parts.push({ where: 'json-ld additionalProperty', text });
    }
  }
  return parts;
}

function evidenceFromMetas(metas) {
  const parts = [];
  for (const key of ['og:title', 'og:description', 'description', 'twitter:description']) {
    const text = cleanText((metas || {})[key]);
    if (text) parts.push({ where: `meta ${key}`, text });
  }
  return parts;
}

/* The served markup, with everything that is about another product cut
   out first. This is the least trustworthy tier and the most bounded:
   only blocks the page itself labels as this product's description,
   details, specification or composition, and only when nothing inside
   them names a recommendation strip. */
function evidenceFromMarkup(html) {
  const parts = [];
  if (typeof html !== 'string' || !html) return parts;

  /* scripts and styles are not product text, and a <script> holding a
     whole catalogue would otherwise prove anything about anything */
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ');

  const opening = /<(div|section|ul|ol|dl|table|p|span)\b([^>]*)>/gi;
  let match;
  while ((match = opening.exec(body)) !== null && parts.length < PARTS_LIMIT) {
    const attributes = match[2] || '';
    const labelled = attributes.match(/(?:class|id|itemprop|data-testid)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const label = labelled ? (labelled[1] || labelled[2] || '') : '';
    if (!ABOUT_THIS_PRODUCT.test(label)) continue;
    if (NOT_THIS_PRODUCT.test(label)) continue;

    const from = match.index + match[0].length;
    let slice = body.slice(from, from + MARKUP_LIMIT);
    /* an opening tag says where a block starts but not where it ends,
       so the slice is cut at the first thing inside it that belongs to
       another product. Reading up to a recommendation strip is safe;
       reading past one is how "you may also like" proves something. */
    const strip = slice.search(NOT_THIS_PRODUCT);
    if (strip >= 0) slice = slice.slice(0, strip);
    const text = cleanText(slice);
    if (text) parts.push({ where: `page ${label.trim().slice(0, 40) || 'detail'}`, text });
  }
  return parts;
}

function evidenceFromHtml(html) {
  return [
    ...evidenceFromNodes(jsonLdNodes(html)),
    ...evidenceFromMetas(metasFromHtml(html)),
    ...evidenceFromMarkup(html)
  ].slice(0, PARTS_LIMIT);
}

function evidenceFromRendered(seen) {
  const nodes = [];
  for (const block of (seen && seen.jsonld) || []) nodes.push(...parseLdBlock(block));
  return [
    ...evidenceFromNodes(nodes),
    ...evidenceFromMetas((seen && seen.metas) || {}),
    ...(((seen && seen.detail) || []).map((text) => ({ where: 'page detail', text: cleanText(text) })).filter((part) => part.text))
  ].slice(0, PARTS_LIMIT);
}

/* the metas the evidence reader wants, which is more of them than the
   name-and-brand reader needs */
function metasFromHtml(html) {
  const metas = {};
  for (const key of ['og:title', 'og:description', 'description', 'twitter:description']) {
    const value = metaContent(html, key);
    if (value) metas[key] = decode(value);
  }
  return metas;
}

/* ---- settling what the title left pending ----

   Each pending item is put to each piece of evidence through the SAME
   reading the title got, so "mid-length" proves midi exactly where it
   would have in a title, and "100% merino" proves wool exactly where it
   would have. Nothing is matched as a bare string. */
function proveOnPage(pending, evidence) {
  const proved = [];
  const missing = [];
  const readings = (evidence || []).map((part) => ({ part, reading: readGarment(part.text, {}) }));

  for (const item of Array.isArray(pending) ? pending : []) {
    /* an item that is not an item cannot be established by anything, so
       it counts as missing rather than as a crash */
    if (!item || typeof item !== 'object') { missing.push(item); continue; }
    let found = null;
    for (const { part, reading } of readings) {
      if (item.kind === 'material') {
        const has = [...reading.materialTerms].some((theirs) =>
          theirs === item.term || (FIBRE_WITHIN[theirs] || []).includes(item.term));
        if (has) { found = part; break; }
      } else {
        const theirs = reading.descriptors.get(item.group);
        if (theirs && [...item.values].some((value) => theirs.has(value))) { found = part; break; }
      }
    }
    if (found) proved.push({ item, where: found.where, quote: found.text.slice(0, 90) });
    else missing.push(item);
  }
  return { proved, missing };
}

/* What a pending item is called in a sentence. It is called on every
   reporting path, and a report that throws takes the whole run with it,
   so it never assumes it was handed one. */
function nameOfPending(item) {
  if (!item || typeof item !== 'object') return '(an unnamed requirement)';
  if (item.kind === 'material') return item.term || '(an unnamed fabric)';
  return item.words || item.term || '(an unnamed descriptor)';
}

/* ---------- finding a real product for a row that has none ----------

   Most of the catalogue is sample rows: names invented to give the demo
   something to search. A sample row cannot be photographed, because
   there is nothing to photograph — so it has to become a real listing
   first, and that listing has to be found rather than typed in.

   The finding is done by the product source the app already uses, which
   is the same thing that answers /api/search: it returns real listings
   on retailers' own sites, and its own gate has already refused
   aggregators, search pages, category pages and redirectors. Each
   listing it offers is then read as a garment and put through the four
   gates any other row goes through, and the first that clears them all
   becomes the row — listing, photo, name and brand together, every
   field off that page.

   Nothing here is hardcoded. Run it again and it re-derives what it
   wrote; run it without --write and it writes nothing at all. */
function intentFor(row) {
  const list = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
  /* a sample row's brand is invented, so it is not asked for — the
     others are real names worth keeping in the query */
  const invented = /^sample-/.test(String(row.id || ''));
  return {
    keywords: [row.name].filter(Boolean),
    brands: !invented && row.brand ? [row.brand] : [],
    categories: row.category ? [row.category] : [],
    colors: list(row.colors),
    occasions: list(row.occasion),
    fits: list(row.fit),
    styles: list(row.style),
    maxPrice: null,
    minPrice: null,
    season: null,
    gender: null
  };
}

function productSource() {
  try {
    return require(path.join(__dirname, '..', 'api', '_providers', 'product-source.js'));
  } catch (err) {
    return null;
  }
}

/* ---------- asking the source more than one way ----------

   intentFor packs everything the row knows into one intent, and the
   adapter turns that into a query by concatenating it: colour, fit,
   style, category, occasion and only then the name. "Boxy Cotton Tee"
   goes out as

     white relaxed oversized minimal sporty tee everyday weekend boxy cotton tee

   which is not a query anyone would type, and a shopping API answers it
   with nothing — or with an error, which is what NO SOURCE was on most
   rows. The row's NAME is the query. The rest is metadata that belongs
   in the gates, not in the search box.

   So the source is asked in several forms, cheapest and most exact
   first, stopping as soon as enough product pages are in hand:

     1  the row's name                     "Fleece Sweatpant"
     2  the same, pluralised               "Fleece Sweatpants"
     3  the name and its category          "Cropped Puffer jacket"
     4  the name with one word dropped     "Pleated Skirt", "Midi Skirt"
     5  everything the row knows           the old behaviour, last

   Form 4 deliberately WIDENS the search, which would once have been
   reckless. It is safe now because the semantic gate no longer takes a
   title's word for anything: a candidate found by "Pleated Skirt" still
   has to establish `midi`, on its title or on its own page, before it
   can be written. Casting wider costs nothing when the gate downstream
   is strict.

   A form that throws does not end the row — the next one is tried, and
   only a row where every form failed reports the source as failing. */
/* the spellings a shop in the US titles a garment with */
const AMERICAN = { colour: 'color', colours: 'colors', grey: 'gray', favourite: 'favorite', jewellery: 'jewelry', tyre: 'tire' };

/* The words that make one descriptor between them — "colour block",
   "wide leg" — so a widening query drops the whole phrase or none of it,
   and the one-word spellings shops also use for them ("colorblock"). */
const PHRASES = new Set(DESCRIPTORS.flatMap((entry) => entry.terms).filter((term) => /\s/.test(term)).map((term) => term.toLowerCase()));
const JOINED = new Set(DESCRIPTORS.flatMap((entry) => entry.terms).filter((term) => !/\s/.test(term)).map((term) => term.toLowerCase()));
const MAX_QUERY_FORMS = 8;
const ENOUGH_FOUND = 4;       // title-passing listings that let the ladder stop after two searches   // every query costs a search; the ladder stops early when it can

function phrasesOf(words) {
  const units = [];
  for (let i = 0; i < words.length;) {
    const three = words.slice(i, i + 3).join(' ').toLowerCase();
    const two = words.slice(i, i + 2).join(' ').toLowerCase();
    const size = words.length - i >= 3 && PHRASES.has(three) ? 3 : words.length - i >= 2 && PHRASES.has(two) ? 2 : 1;
    units.push(words.slice(i, i + size).join(' '));
    i += size;
  }
  return units;
}

function queryForms(row) {
  const name = String(row.name || '').trim();
  const forms = [];
  const add = (how, keywords, extra) => {
    const query = String(keywords || '').trim().replace(/\s+/g, ' ');
    if (!query) return;
    if (forms.some((form) => form.query.toLowerCase() === query.toLowerCase())) return;
    forms.push({ how, query, intent: Object.assign({
      keywords: [query], brands: [], categories: [], colors: [], occasions: [],
      fits: [], styles: [], maxPrice: null, minPrice: null, season: null, gender: null
    }, extra || {}) });
  };

  const words = name.split(/\s+/).filter(Boolean);
  const head = words[words.length - 1] || '';
  const titled = (word) => (/^[A-Z]/.test(head) ? word[0].toUpperCase() + word.slice(1) : word);
  const american = words.map((word) => {
    const us = AMERICAN[word.toLowerCase()];
    return us ? (/^[A-Z]/.test(word) ? us[0].toUpperCase() + us.slice(1) : us) : word;
  }).join(' ');

  /* The garment as shops title it, asked FIRST when the row names it by
     a word shops do not lead with. "Knit" is how a knitting pattern is
     titled and a sweater is how a shop titles the garment, so a row
     called "Colour Block Knit" is asked, in order, as
       Color Block Knit Sweater     its name, with the garment it means
       Colour Block Knit Sweater    the same, as the row spells it
       Color Block Sweater          the garment by its descriptors
       Colorblock Sweater           the one-word spelling shops use
     — four at most, from the semantic gate's own vocabulary, never a
     hand list. A row whose name already says its garment gains none. */
  const garment = readGarment(name, { fallback: row.category }).type;
  const says = (word) => { const low = word.toLowerCase(); return low === garment || low === `${garment}s` || low === `${garment}es`; };
  const renamed = garment && head && !words.some(says) && readGarment(head).type === garment;
  if (renamed) {
    const noun = titled(garment);
    const describing = american.split(/\s+/).slice(0, -1).join(' ');
    add(`its name, with the garment it means (${garment})`, `${american} ${noun}`);
    if (american.toLowerCase() !== name.toLowerCase()) add(`its name as spelled, with the garment it means (${garment})`, `${name} ${noun}`);
    add(`its garment, as a ${garment}`, `${describing} ${noun}`);
    const joined = phrasesOf(describing.split(/\s+/).filter(Boolean)).map((unit) => {
      const one = unit.toLowerCase().replace(/\s+/g, '');
      return /\s/.test(unit) && JOINED.has(one) ? unit.replace(/\s+/g, '').replace(/^./, (c) => c.toUpperCase()).replace(/(?<=.)[A-Z]/g, (c) => c.toLowerCase()) : unit;
    }).join(' ');
    if (joined.toLowerCase() !== describing.toLowerCase()) add(`its garment, as a ${garment}, in one-word spelling`, `${joined} ${noun}`);
  }

  /* then the row as written, and in American spelling */
  add('its name', name);
  if (american.toLowerCase() !== name.toLowerCase()) add('its name, in American spelling', american);
  if (head && !/s$/i.test(head)) add('its name, pluralised', [...words.slice(0, -1), `${head}s`].join(' '));

  const category = String(row.category || '').trim();
  if (category && !name.toLowerCase().includes(category.toLowerCase().replace(/s$/, ''))) {
    add('its name and category', `${name} ${category}`);
  }

  /* One descriptor at a time, widening — a whole phrase ("colour
     block"), never half of one — and never down to the bare garment.
     The gate downstream still has to see what was dropped established. */
  const units = phrasesOf(words.slice(0, -1));
  if (units.length >= 2) {
    for (const unit of units) {
      const rest = units.filter((one) => one !== unit);
      add(`without "${unit}"`, `${rest.join(' ')} ${head}`);
    }
  }

  forms.splice(MAX_QUERY_FORMS - 1);
  if (name) forms.push({ how: 'everything the row knows', query: null, intent: intentFor(row) });
  return forms;
}

/* ---------- when the primary source runs out of searches ----------

   SerpApi sells a monthly allowance, and a catalogue run is the thing
   most likely to spend it. When it goes, every remaining row gets the
   same 429 and a run that was working stops working for a reason that
   has nothing to do with the catalogue.

   So discovery carries a second source. SerpApi stays primary and is
   asked first for every row; Serper is asked only after SerpApi says it
   has no searches left, and only if SERPER_API_KEY is set. Nothing else
   promotes it — an ordinary failure, a timeout, a form that returns
   nothing, none of them reach for it, because none of them are fixed by
   asking somebody else the same question.

   A listing that arrives this way is not privileged in any direction.
   It goes through the link rule, the semantic gate on its title, the
   semantic gate on its page, and the four image gates, in that order,
   exactly as a SerpApi listing does. Where a candidate came from is not
   evidence about the garment, and it is never recorded as though it
   were: the row that gets written carries productUrl, imageUrl and
   imageEvidence, the same three fields, proved the same way. */

/* A ceiling over work this script does not own. The product source is
   the adapter /api/search uses and is not changed from here, so its
   request cannot be handed an abort signal — the only thing available
   is to stop waiting for it. What is left behind is one HTTP request
   finishing into nothing, which is the cheap kind of orphan; the
   expensive kind, a Chromium nobody closes, is never raced. */
function withCeiling(promise, ms, why) {
  let timer = null;
  const ceiling = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(why)), Math.max(1, ms));
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

/* The fallback rule is the product source's own, shared with
   /api/search, so a catalogue run and a shopper's search fall back the
   same way on the same failure. */
function outOfSearches(err) {
  return require(path.join(__dirname, '..', 'api', '_providers', 'product-source.js')).outOfSearches(err);
}

function linklessBatch(records) {
  return require(path.join(__dirname, '..', 'api', '_providers', 'product-source.js')).linkless(records);
}

/* the sources discovery may ask, primary first. The fallback is only
   ever appended — it never displaces what PRODUCT_SOURCE chose. */
function providerChain(source) {
  return require(path.join(__dirname, '..', 'api', '_providers', 'product-source.js')).providerChain(source.getProvider());
}

/* ---------- a product page before a page ABOUT products ----------

   The organic fallback asks the open web, and the open web answers with
   everything that mentions the words: a shop's category page, a
   magazine's round-up, a Reddit thread, a Pinterest board, a YouTube
   haul. Each is semantically related — the title really does say "Wide
   Leg Trousers" — and not one of them is a listing a row can link to.
   They went through the whole page stage anyway, in whatever order the
   search engine liked, spending the row's two minutes on pages that
   could never have been the answer while an actual product page waited
   behind them.

   This decides nothing a gate decides. It sorts, and it drops only the
   hosts that sell nothing at all — a forum, a pinboard, a video site, a
   social network — whose pages are never a retailer's listing whatever
   they are titled. Everything else still goes through every gate it went
   through before, in this order:

     product      the URL is shaped like one product: /products/<handle>,
                  /p/<code>, /dp/<asin>, or it carries a product code
     unknown      nothing either way
     listing      a category, collection, search or sale page
     editorial    a blog, a journal, a guide, a round-up, a magazine

   The sort is stable, so within a tier the source's own ranking holds. */
const NOT_A_SHOP = /(^|\.)(reddit\.com|redd\.it|pinterest\.[a-z.]+|pin\.it|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.com|twitter\.com|x\.com|threads\.net|quora\.com|tumblr\.com|linkedin\.com|wikipedia\.org|vimeo\.com|snapchat\.com)$/i;
const EDITORIAL_HOST = /(^|\.)(vogue\.[a-z.]+|gq\.com|esquire\.com|harpersbazaar\.com|elle\.com|whowhatwear\.com|refinery29\.com|nytimes\.com|businessinsider\.com|insider\.com|buzzfeed\.com|cosmopolitan\.com|glamour\.com|instyle\.com|thecut\.com|nymag\.com|theguardian\.com|forbes\.com|allure\.com|popsugar\.com|marieclaire\.com|byrdie\.com|wikihow\.com|medium\.com|substack\.com|thestrategist\.co\.uk|goodhousekeeping\.com|realsimple\.com|people\.com|today\.com|usatoday\.com|ravelry\.com)$/i;
const EDITORIAL_SEGMENT = /^(blogs?|articles?|news|journal|stories|story|editorial|editorials|magazine|mag|guides?|style-guide|lookbook|lookbooks|inspiration|features?|the-edit|trends?|forum|forums|community|reviews?|wiki|advice|how-to|best|gift-guide|gift-guides|tutorials?|patterns|free-patterns?|knitting-patterns?|sewing-patterns?|crochet-patterns?)$/i;
const EDITORIAL_TITLE = /\b(best|top \d+|\d+ (best|ways|ideas|outfits)|how to|guide|review|reviews|vs\.?|versus|what to wear|outfit ideas|ideas|trends?|lookbook|reddit|pinterest|youtube|haul|blog|tutorials?|(knitting|sewing|crochet) patterns?|patterns? by)\b/i;
const LISTING_SEGMENT = /^(collections?|category|categories|cat|c|browse|catalog|catalogue|department|dept|departments|shop-all|all|plp|search|s|sale|clearance|new-arrivals|new-in|whats-new|bestsellers|best-sellers|brands?|designers?)$/i;
const LISTING_PARAMS = /^(q|query|search|keyword|keywords|searchterm|cgid|category|categoryid|cat|dept|department|collection|sort|srule|filter)$/i;
const LISTING_TITLE = /\b(shop (all|now|the|our|women|men)|collection|new arrivals|results for|search results|all products|for (women|men)\b.*\|)|\(\d+\)|\b\d+ (items|products|results|styles)\b/i;
const PRODUCT_SEGMENT = /^(p|product|products|prod|pd|pdp|prd|item|items|dp|gp|sku)$/i;
/* a category's own id as a path segment: cat210019, cata000013, cid-45 */
const CATEGORY_ID = /^(cat[a-z]?|cid|cgid)[-_]?\d+$/i;
/* a category named, then numbered after a double hyphen, with no file
   ending: Abercrombie's /shop/us/womens-dresses-and-jumpsuits--20266 */
const NAMED_CATEGORY_ID = /^[a-z][a-z0-9-]*[a-z]--\d+$/i;

function listingShape(productUrl, title) {
  let url;
  try { url = new URL(String(productUrl)); } catch (err) { return { kind: 'unknown', why: 'not a URL' }; }
  const host = url.hostname.toLowerCase();
  if (NOT_A_SHOP.test(host)) return { kind: 'not-a-shop', why: `${host} is a forum, pinboard, video or social site, which sells nothing` };

  const segments = url.pathname.split('/').filter(Boolean).map((one) => { try { return decodeURIComponent(one); } catch (err) { return one; } });
  const heading = String(title || '');

  if (EDITORIAL_HOST.test(host)) return { kind: 'editorial', why: `${host} is a publication, not a shop` };
  const editorialAt = segments.find((segment) => EDITORIAL_SEGMENT.test(segment));
  if (editorialAt) return { kind: 'editorial', why: `its path sits under /${editorialAt}/` };

  /* a product segment followed by something to name: /products/<handle>,
     /p/<code>. Shopify nests a product under a collection —
     /collections/trousers/products/wide-leg — and that is a product.
     A product segment with a whole path after it names one product only
     if that path carries a code: /p/womens/pants/BX123 does, and H&M's
     /products/skirts/pleated-skirts.html is a category. */
  const codes = identifiersFrom(url.href);
  const productAt = segments.findIndex((segment) => PRODUCT_SEGMENT.test(segment));
  if (productAt >= 0 && productAt < segments.length - 1) {
    const after = segments.slice(productAt + 1).map((segment) => segment.toLowerCase());
    if (after.length === 1 || codes.some((id) => after.some((segment) => containsCode(segment, id)))) {
      return { kind: 'product', why: `its path names one product under /${segments[productAt]}/` };
    }
  }

  /* the last segment carrying the product's code, and not as the id of
     a category it sits under: /c/12345, /category/pants/cat210019,
     /wide-leg-pants/cat4700001 — wide-leg-trouser-12345.html is a code */
  const last = String(segments[segments.length - 1] || '').toLowerCase();
  const bareId = CATEGORY_ID.test(last) || NAMED_CATEGORY_ID.test(last)
    || (/^[a-z]{0,3}\d+$/.test(last) && segments.slice(0, -1).some((segment) => LISTING_SEGMENT.test(segment)));
  if (last && codes.some((id) => containsCode(last, id)) && !bareId) {
    return { kind: 'product', why: 'its last path segment carries a product code' };
  }

  if (EDITORIAL_TITLE.test(heading) && !codes.length) {
    return { kind: 'editorial', why: `its title reads as an article: "${heading.slice(0, 60)}"` };
  }

  /* a product page named by a parameter rather than a path: Gap's
     /browse/product.do?pid=791234022 — under /browse/, but one product */
  if (/^(product|productpage|pdp|item)(\.(do|html?|aspx|jsp|php))?$/i.test(last)
      && [...url.searchParams.keys()].some((key) => PRODUCT_ID_PARAM.test(key))) {
    return { kind: 'product', why: `its ${last} page names one product by parameter` };
  }

  const listingAt = segments.find((segment) => LISTING_SEGMENT.test(segment));
  if (listingAt) return { kind: 'listing', why: `its path sits under /${listingAt}/` };
  for (const key of url.searchParams.keys()) {
    if (LISTING_PARAMS.test(key)) return { kind: 'listing', why: `it carries a ${key}= parameter, which filters a listing` };
  }
  if (LISTING_TITLE.test(heading)) return { kind: 'listing', why: `its title reads as a listing: "${heading.slice(0, 60)}"` };

  /* a category's own id is not a product's code */
  if (codes.some((id) => !(bareId && containsCode(last, id)))) return { kind: 'product', why: 'its URL carries a product code' };
  if (bareId) return { kind: 'listing', why: `its last segment ${last} is a category's id` };
  return { kind: 'unknown', why: 'nothing in its URL or title says either way' };
}

const SHAPE_ORDER = { product: 0, unknown: 1, listing: 2, editorial: 3 };

/* products first, then the rest in the source's own order within each
   tier; a host that sells nothing is set aside with its reason */
function rankListings(products) {
  const kept = [];
  const dropped = [];
  products.forEach((product, at) => {
    const shape = listingShape(product.productUrl, product.title);
    if (shape.kind === 'not-a-shop') { dropped.push(Object.assign({}, product, { shape })); return; }
    kept.push({ product: Object.assign({}, product, { shape }), at });
  });
  kept.sort((a, b) => (SHAPE_ORDER[a.product.shape.kind] - SHAPE_ORDER[b.product.shape.kind]) || (a.at - b.at));
  return { ranked: kept.map((one) => one.product), dropped };
}

/* ---------- a category page's own products, as candidates ----------

   The open web answers a garment's name with category pages, and a
   category page is never the answer: it sells many things, its URL
   names none of them, and nothing on it can be tied to one product. But
   the shop's own page data often lists the products it is showing — in
   a JSON-LD ItemList, or in the state a framework hydrates from
   (__NEXT_DATA__ and its kin) — each with its own product page.

   Those product pages are offered as candidates of their own, and
   nothing else about them is taken on trust. A tile counts only when
   the shop's data names, for one product, all of: its own page's URL,
   a name, an id or sku, and an image — a record that says less than
   that does not identify one product. Anything under a recommendation,
   a recently-viewed list, a carousel, navigation or an ad is not what
   the page is listing and is never read. The tile's image is never a
   candidate photo: the product's own page is read, and every gate —
   the title, the page, host, artwork, identity, loadable, the
   product-page rule, a Shopify record — decides it exactly as it would
   a product page the search had returned. The category page itself is
   still refused as it always was.

   This function runs INSIDE the page too (page.evaluate), so it must
   not reach for anything outside itself. */
function embeddedProductTiles(data, source, most, stats) {
  /* Field names are matched lowercased and without punctuation, so
     pdpUrl, pdpURL and pdp_url are one name. Each list names exactly
     that field — never "anything with a url". */
  const URL_KEYS = ['pdpurl', 'producturl', 'productpageurl', 'pdplink', 'productlink', 'pdppath', 'productpath', 'pdpuri', 'producturi',
    'detailurl', 'detailpageurl', 'canonicalurl', 'seourl', 'seopath', 'relativeurl', 'url', 'href', 'link', 'uri'];
  const NAME_KEYS = ['name', 'productname', 'displayname', 'producttitle', 'productdisplayname', 'title', 'productdescription'];
  const ID_KEYS = ['sku', 'skuid', 'productid', 'prodid', 'productcode', 'prodcode', 'productnumber', 'productno', 'pid', 'stylenumber', 'stylenum',
    'styleno', 'styleid', 'stylecode', 'itemid', 'itemnumber', 'itemcode', 'partnumber', 'catentryid', 'articlenumber', 'articlecode', 'webid',
    'mpn', 'masterid', 'masterproductid', 'code', 'id'];
  /* outside a sku or variant, a bare id or code names too many things */
  const PRODUCT_ID_KEYS = ID_KEYS.filter((key) => key !== 'id' && key !== 'code');
  const IMAGE_KEYS = ['image', 'images', 'imageurl', 'imagesrc', 'imagepath', 'img', 'thumbnail', 'thumbnailurl', 'primaryimage',
    'primaryimageurl', 'defaultimage', 'productimage', 'productimages', 'featuredimage', 'heroimage', 'mainimage', 'imageset', 'imagedata',
    'picture', 'pictures', 'photo', 'photos', 'assets', 'media'];
  /* Where a record keeps what belongs to it, one level down: the offer
     that links its page, the sku that numbers it, the colour that
     pictures it. Read only for the record's own missing field, and only
     on the terms each reader below sets. */
  const OWNED_LINKS = ['offers', 'offer', 'seo', 'urls', 'links', 'pdp', 'routes', 'item', 'product'];
  const CONTAINED_URL_KEYS = URL_KEYS.concat(['pdp', 'self', 'product', 'canonical', 'web', 'desktop']);
  const SKU_HOLDERS = ['skus', 'sku', 'variants', 'variant', 'defaultsku', 'defaultvariant', 'selectedvariant'];
  const ID_HOLDERS = SKU_HOLDERS.concat(['identifiers', 'ids', 'attributes', 'analytics', 'productdata', 'productinfo', 'details', 'meta']);
  const OWNED_IMAGES = ['colors', 'colours', 'colorways', 'swatches', 'variants', 'variant', 'skus', 'tiles', 'defaultsku', 'defaultvariant',
    'selectedvariant', 'product', 'gallery', 'shots', 'views'];
  const IMAGE_ADDRESS = /\.(jpe?g|png|webp|avif|gif)(\?.*)?$|s7-img|scene7|\/is\/image\/|\/images?\/|\/img\/|\/photos?\/|\/media\/|cdn\.shopify\.com/i;
  const IMAGEISH_KEY = /image|img|photo|picture|src|url|shot|media|asset|swatch|thumb|zoom|hero|path/;
  const IMAGE_PARTS = ['url', 'src', 'href', 'contenturl', 'imageurl', 'path', 'image', 'images', 'featuredimage', 'node', 'nodes', 'edges',
    'primary', 'main', 'default', 'hero', 'front', 'large', 'medium', 'small', 'original', 'zoom'];
  /* a tile the data wraps: { product: {...}, image: {...} }, a GraphQL
     node, a JSON:API resource's attributes */
  const WRAPS = ['product', 'item', 'node', 'productdata', 'productinfo', 'attributes', 'tile'];
  const AWAY = /recommend|related|similar|recent|upsell|cross.?sell|also|trending|suggest|sponsor|complete.?the.?look|pairs?.?with|wear.?it.?with|carousel|promo|^ads?$|advert|^nav|menu|header|footer|breadcrumb/i;
  const SHOPIFY_PRODUCT = /^gid:\/\/shopify\/Product\/\d+$/;
  const VARIANT = /^(variants?|colou?rs?|colorways?|swatch(es)?|skus?|sizes?|images?|media|options?|pictures?|photos?|tiles?)$/;
  const limit = most || 200;
  const out = [];
  const st = stats || {};
  st.visits = st.visits || 0;
  st.opened = st.opened || 0;
  st.openedChars = st.openedChars || 0;
  st.misses = st.misses || {};
  const norm = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  const indexOf = (node) => {
    const keys = {};
    for (const key of Object.keys(node).slice(0, 500)) { const n = norm(key); if (!(n in keys)) keys[n] = key; }
    return keys;
  };
  const first = (node, keys, names, cap) => {
    for (const name of names) {
      if (!(name in keys)) continue;
      const value = node[keys[name]];
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, cap);
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
  };
  /* an image is an address: absolute, protocol-relative, rooted, or a
     file named as a picture */
  const address = (value) => {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (/^(https?:)?\/\/|^\/[^/]/i.test(text) || /^[\w./-]+\.(jpe?g|png|webp|avif|gif)(\?.*)?$/i.test(text)) return text.slice(0, 2000);
    return null;
  };
  const imageOf = (value, depth) => {
    if (depth > 4 || value === null || value === undefined) return null;
    if (typeof value === 'string') return address(value);
    if (Array.isArray(value)) {
      for (const one of value.slice(0, 5)) { const got = imageOf(one, depth + 1); if (got) return got; }
      return null;
    }
    if (typeof value === 'object') {
      const keys = indexOf(value);
      for (const name of IMAGE_PARTS) { if (name in keys) { const got = imageOf(value[keys[name]], depth + 1); if (got) return got; } }
    }
    return null;
  };
  /* a product link, never a picture: a url field holding an image
     address is skipped for the next one, and a link kept as an object
     ({ href }, { url }) is read through */
  const IMAGE_FILE = /\.(jpe?g|png|webp|avif|gif|svg)(\?.*)?$/i;
  const linkOf = (node, keys, names) => {
    for (const name of names || URL_KEYS) {
      if (!(name in keys)) continue;
      let value = node[keys[name]];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const inner = indexOf(value);
        value = ['href', 'url', 'path'].map((part) => value[inner[part]]).find((one) => typeof one === 'string');
      }
      if (typeof value === 'string' && value.trim() && !IMAGE_FILE.test(value.trim())) return value.trim().slice(0, 2000);
    }
    return null;
  };
  /* two links name one page when their path and any product-naming
     parameter agree */
  const pageOf = (link) => {
    const [path, query] = String(link).split('#')[0].split('?');
    const ids = (query || '').split('&').filter((pair) => /^(pid|productid|product_id|itemid|styleid|skuid|sku)=/i.test(pair)).sort();
    return `${path.replace(/\/+$/, '')}?${ids.join('&')}`.toLowerCase();
  };
  /* the record's page, from the offer or link block it owns — one page,
     or none: offers that link different pages settle nothing */
  const nestedLink = (node, keys) => {
    for (const name of OWNED_LINKS) {
      if (!(name in keys)) continue;
      const value = node[keys[name]];
      const list = (Array.isArray(value) ? value.slice(0, 20) : [value]).filter((one) => one && typeof one === 'object' && !Array.isArray(one));
      const links = list.map((one) => linkOf(one, indexOf(one), CONTAINED_URL_KEYS)).filter(Boolean);
      if (!links.length) continue;
      return new Set(links.map(pageOf)).size === 1 ? links[0] : null;
    }
    return null;
  };
  /* the record's own sku or product id, from the sku, variant or
     identifier block it owns; a bare id or code counts only on a sku */
  const nestedId = (node, keys) => {
    const idIn = (value, names, depth) => {
      if (depth > 2 || !value || typeof value !== 'object') return null;
      if (Array.isArray(value)) {
        for (const one of value.slice(0, 5)) { const got = idIn(one, names, depth + 1); if (got) return got; }
        return null;
      }
      const inner = indexOf(value);
      const direct = first(value, inner, names, 120);
      if (direct) return direct;
      for (const key of Object.keys(value).slice(0, 50)) {
        if (AWAY.test(key) || !value[key] || typeof value[key] !== 'object') continue;
        const got = idIn(value[key], names, depth + 1);
        if (got) return got;
      }
      return null;
    };
    for (const name of ID_HOLDERS) {
      if (!(name in keys)) continue;
      const value = node[keys[name]];
      if (typeof value === 'string' && value.trim() && SKU_HOLDERS.includes(name)) return value.trim().slice(0, 120);
      const got = idIn(value, SKU_HOLDERS.includes(name) ? ID_KEYS : PRODUCT_ID_KEYS, 0);
      if (got) return got;
    }
    return null;
  };
  /* the record's own picture, from the colours, variants or tiles it
     owns — and only one that is plainly THIS product's: its address
     carries the product's id, or the object holding it names the same
     product id. A colour chip or a banner that says neither is not taken. */
  const tokensOf = (id) => {
    const text = norm(String(id || '').replace(/^gid:\/\/shopify\/\w+\//i, ''));
    return [...new Set([text, text.replace(/^0+/, '')])].filter((one) => one.length >= 4);
  };
  const ownedImage = (node, keys, id) => {
    const tokens = tokensOf(id);
    const search = (value, depth, same) => {
      if (depth > 4 || value === null || value === undefined) return null;
      if (typeof value === 'string') {
        const found = address(value);
        if (!found || !IMAGE_ADDRESS.test(found)) return null;
        return same || tokens.some((token) => norm(found).includes(token)) ? found : null;
      }
      if (Array.isArray(value)) {
        for (const one of value.slice(0, 10)) { const got = search(one, depth + 1, same); if (got) return got; }
        return null;
      }
      if (typeof value !== 'object') return null;
      const inner = indexOf(value);
      const itsId = first(value, inner, PRODUCT_ID_KEYS, 120);
      const mine = same || Boolean(itsId && id && norm(itsId) === norm(id));
      for (const key of Object.keys(value).slice(0, 50)) {
        if (AWAY.test(key) || !IMAGEISH_KEY.test(norm(key))) continue;
        const got = search(value[key], depth + 1, mine);
        if (got) return got;
      }
      for (const key of Object.keys(value).slice(0, 50)) {
        if (AWAY.test(key) || IMAGEISH_KEY.test(norm(key)) || !value[key] || typeof value[key] !== 'object') continue;
        const got = search(value[key], depth + 1, mine);
        if (got) return got;
      }
      return null;
    };
    if (!tokens.length && !id) return null;
    for (const name of OWNED_IMAGES) {
      if (!(name in keys)) continue;
      const got = search(node[keys[name]], 0, false);
      if (got) return got;
    }
    return null;
  };
  /* a name kept as an object: { value }, { text }, { en-US } */
  const nameOf = (node, keys) => {
    const direct = first(node, keys, NAME_KEYS, 300);
    if (direct) return direct;
    for (const name of NAME_KEYS) {
      const value = name in keys ? node[keys[name]] : null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const inner = indexOf(value);
      const got = first(value, inner, ['value', 'text', 'default', 'enus', 'en', 'engb', 'label'], 300);
      if (got) return got;
    }
    return null;
  };
  const roles = (node) => {
    const keys = indexOf(node);
    let url = linkOf(node, keys) || nestedLink(node, keys);
    const id = first(node, keys, ID_KEYS, 120) || nestedId(node, keys);
    let name = nameOf(node, keys);
    /* a product description is a name only when it is the length of one */
    if (name && 'productdescription' in keys && name === String(node[keys.productdescription]).trim().slice(0, 300) && name.length > 120) name = null;
    /* a headless Shopify product names its handle, not its URL */
    if (!url && typeof node[keys.handle] === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(node[keys.handle])
        && (SHOPIFY_PRODUCT.test(String(id || '')) || node[keys.typename] === 'Product')) {
      url = `/products/${node[keys.handle]}`;
    }
    let image = null;
    for (const key of IMAGE_KEYS) { if (key in keys) { image = imageOf(node[keys[key]], 0); if (image) break; } }
    /* a picture kept under a url field is still this record's picture */
    if (!image) {
      for (const name of URL_KEYS) {
        const value = name in keys ? node[keys[name]] : null;
        if (typeof value === 'string' && IMAGE_FILE.test(value.trim())) { image = address(value); if (image) break; }
      }
    }
    if (!image) image = ownedImage(node, keys, id);
    /* every name the record gives, so the title gate can read the one
       that names the garment rather than a colour or a line name */
    const names = [];
    for (const key of NAME_KEYS) {
      if (!(key in keys)) continue;
      let value = node[keys[key]];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const inner = indexOf(value);
        value = first(value, inner, ['value', 'text', 'default', 'enus', 'en', 'engb', 'label'], 300);
      }
      if (typeof value === 'string' && value.trim() && value.trim().length <= 120 && !names.includes(value.trim())) names.push(value.trim().slice(0, 300));
    }
    /* the record says what it is: a schema.org Product, a GraphQL Product */
    const declared = [node[keys.type], node[keys.typename]].flat().map((one) => String(one || ''));
    const typed = declared.some((one) => /^(product|productgroup|productmodel|individualproduct)$/i.test(one.replace(/^https?:\/\/schema\.org\//i, '')));
    return { keys, url, name, id, image, names, typed };
  };
  const opened = (value) => {
    if (typeof value !== 'string' || st.opened >= 20 || value.length < 20 || value.length > 5000000 || st.openedChars > 20000000) return null;
    const text = value.trim();
    if (!(text.startsWith('{') || text.startsWith('['))) return null;
    try { const got = JSON.parse(text); st.opened += 1; st.openedChars += text.length; return got; } catch (err) { return null; }
  };
  const miss = (found, keys) => {
    const present = ['url', 'name', 'id', 'image'].filter((role) => found[role]);
    if (present.length < 3 && !(found.url && found.name)) return;
    const signature = `has ${present.join('+')}; lacks ${['url', 'name', 'id', 'image'].filter((role) => !found[role]).join('+')}; keys ${Object.values(keys).slice(0, 12).join(',')}`;
    st.misses[signature] = (st.misses[signature] || 0) + 1;
  };
  const walk = (node, where, depth) => {
    if (out.length >= limit || st.visits > 200000 || depth > 24 || !node || typeof node !== 'object') return;
    st.visits += 1;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 1000; i += 1) walk(node[i], `${where}[${i}]`, depth + 1);
      return;
    }
    const found = roles(node);
    /* fill what the wrapper lacks from the one product it wraps; the
       wrapped record is then this one, and is not read a second time */
    const wrapped = new Set();
    for (const wrap of WRAPS) {
      if (found.url && found.name && found.id && found.image) break;
      const inner = wrap in found.keys ? node[found.keys[wrap]] : null;
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
      const got = roles(inner);
      let used = false;
      for (const role of ['url', 'name', 'id', 'image']) if (!found[role] && got[role]) { found[role] = got[role]; used = true; }
      if (used) {
        wrapped.add(found.keys[wrap]);
        for (const one of got.names) if (!found.names.includes(one)) found.names.push(one);
        found.typed = found.typed || got.typed;
      }
    }
    const complete = found.url && found.name && found.id && found.image && found.name.length >= 3;
    if (complete) {
      out.push({ url: found.url, name: found.name, names: found.names.length ? found.names : [found.name], id: found.id, image: found.image,
        typed: Boolean(found.typed), where: `${source}${where}`.slice(0, 300) });
    }
    else miss(found, found.keys);
    /* A complete record is read on through, because it may be a
       container — a category with its own name, id, url and banner, and
       the products inside it. Only its own variants are not: a colour or
       a size of this product is not another product. */
    for (const key of Object.keys(node).slice(0, 1000)) {
      if (AWAY.test(key)) continue;
      if (complete && (VARIANT.test(norm(key)) || wrapped.has(key))) continue;
      const value = node[key];
      if (value && typeof value === 'object') walk(value, `${where}.${key}`, depth + 1);
      else {
        const inner = opened(value);
        if (inner) walk(inner, `${where}.${key}(json)`, depth + 1);
      }
    }
  };
  try { walk(data, '', 0); } catch (err) { /* a structure that throws offers what it offered */ }
  return out;
}

/* A tile's own product page, held to the rules a tile has to meet on
   this side: on the listing's own site, shaped like one product, and
   not the listing page itself. Returns the candidates, first-come; what
   was dropped, and why, is counted into `stats` for the report. */
const MAX_TILES_PER_PAGE = 200;
const PRODUCT_ID_PARAM = /^(pid|productid|product_id|itemid|styleid|skuid|sku)$/i;

/* one product page's key: host, path, and the query parameter that names
   the product where the path does not (Gap's /browse/product.do?pid=) */
function productKey(href) {
  try {
    const url = new URL(String(href));
    const ids = [...url.searchParams.entries()].filter(([key]) => PRODUCT_ID_PARAM.test(key)).map(([key, value]) => `${key.toLowerCase()}=${value}`).sort();
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${ids.length ? `?${ids.join('&')}` : ''}`.toLowerCase();
  } catch (err) {
    return null;
  }
}

function listingProductLinks(listingUrl, tiles, stats) {
  const st = stats || {};
  const drop = (why, example) => {
    st.dropped = st.dropped || {};
    st.dropped[why] = (st.dropped[why] || 0) + 1;
    if (example) {
      st.examples = st.examples || {};
      st.examples[why] = st.examples[why] || [];
      if (st.examples[why].length < 3) st.examples[why].push(example);
    }
  };
  let listing;
  try { listing = new URL(String(listingUrl)); } catch (err) { return []; }
  const self = productKey(listing.href);
  const out = [];
  const seen = new Set();
  for (const tile of tiles || []) {
    if (out.length >= MAX_TILES_PER_PAGE) break;
    if (!tile || typeof tile.url !== 'string' || typeof tile.name !== 'string' || !tile.id || typeof tile.image !== 'string') { drop('incomplete'); continue; }
    let url;
    /* page data is not a document: a link with no leading slash is from
       the site's root, not from the category page's own path */
    const base = /^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(tile.url.trim()) ? listing : new URL('/', listing);
    try { url = new URL(tile.url.trim().replace(/^\.\//, ''), base); new URL(tile.image, listing); } catch (err) { drop('not a URL'); continue; }
    if (!/^https?:$/.test(url.protocol)) { drop('not a URL'); continue; }
    if (registrable(url.hostname) !== registrable(listing.hostname)) { drop('another site', url.hostname); continue; }
    url.hash = '';
    const key = productKey(url.href);
    if (key === self) { drop('the listing page itself'); continue; }
    const shape = listingShape(url.href, tile.name);
    /* An address that says nothing either way (/colour-block-jumper) is
       taken only from a record that declares itself a Product; the page
       still has to prove it is one at the product-page gate. A category,
       search or article address is never taken. */
    if (shape.kind !== 'product' && !(shape.kind === 'unknown' && tile.typed)) {
      drop(shape.kind === 'unknown' ? 'not shaped like one product (and not declared a Product)' : (shape.kind === 'editorial' ? 'an editorial page' : `a ${shape.kind} page`), `${url.pathname}${url.search}`.slice(0, 100));
      continue;
    }
    if (seen.has(key)) { drop('duplicate'); continue; }
    seen.add(key);
    out.push({ productUrl: url.href, title: tile.name.trim(), names: Array.isArray(tile.names) && tile.names.length ? tile.names : [tile.name.trim()],
      id: String(tile.id), where: tile.where || null });
  }
  return out;
}

/* diagnostics only: the tile pipeline's account of one page */
function tileReport(tiles, links, linkStats) {
  const stats = (tiles && tiles.stats) || {};
  const misses = {};
  for (const side of [stats.served, stats.rendered]) {
    for (const [signature, n] of Object.entries((side && side.misses) || {})) misses[signature] = (misses[signature] || 0) + n;
  }
  return {
    read: (tiles || []).length,
    offered: (links || []).length,
    from: [...new Set((tiles || []).map((one) => String(one.where || '').split(/[.[]/)[0]))],
    nextData: { served: (stats.served && stats.served.nextServed) || null, rendered: (stats.rendered && stats.rendered.next) || null },
    stateFailed: (stats.rendered && stats.rendered.failed) || null,
    collection: (stats.served && stats.served.collection) || (stats.rendered && stats.rendered.collection) || null,
    jsonStringsOpened: ((stats.served && stats.served.opened) || 0) + ((stats.rendered && stats.rendered.opened) || 0),
    dropped: linkStats.dropped || {},
    examples: linkStats.examples || {},
    nearMisses: Object.entries(misses).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([signature, n]) => ({ signature, n }))
  };
}

/* the tile report, as lines: printed under --diagnose and, in short,
   under each category candidate */
function tileLines(tiles) {
  if (!tiles) return [];
  const lines = [];
  const next = tiles.nextData || {};
  lines.push(`product tiles: ${tiles.read} complete tile${tiles.read === 1 ? '' : 's'} read${tiles.from.length ? ` (from ${tiles.from.join(', ')})` : ''}, ${tiles.offered} offered as product pages`
    + `; __NEXT_DATA__ served: ${next.served || 'not served'}, rendered: ${next.rendered || 'not rendered'}`
    + `${tiles.jsonStringsOpened ? `; ${tiles.jsonStringsOpened} JSON-string state${tiles.jsonStringsOpened === 1 ? '' : 's'} opened` : ''}`
    + `${tiles.stateFailed ? `; page state could not be read (${tiles.stateFailed})` : ''}`
    + `${tiles.collection ? `; Shopify collection products.json ${tiles.collection}` : ''}`);
  const dropped = Object.entries(tiles.dropped || {});
  if (dropped.length) {
    lines.push(`  dropped: ${dropped.map(([why, n]) => `${n} ${why}`).join(', ')}`);
    for (const [why, list] of Object.entries(tiles.examples || {})) lines.push(`    e.g. ${why}: ${list.join(' | ')}`);
  }
  for (const one of tiles.nearMisses || []) lines.push(`  near miss ×${one.n}: ${one.signature}`);
  return lines;
}

/* ---------- a Shopify collection's own product list ----------

   A Shopify collection page, /collections/<handle>, is backed by a list
   the store publishes at /collections/<handle>/products.json: each
   product's id, handle, title and images. It is to a collection what
   /products/<handle>.js is to a product, and a theme's JSON-LD often
   leaves out exactly what it carries. Its products are offered as
   /products/<handle> candidates like any other tile — never its images,
   and never the collection — and each is read and proved on its own
   page. It is asked for the way the page was got: by a plain request
   only when a plain request was served the page, otherwise by the
   browser that was, same-origin. */
const SHOPIFY_COLLECTION = /^((?:\/[a-z]{2}(?:-[a-z]{2})?)?\/collections\/[a-z0-9][a-z0-9_-]*)\/?$/i;
const SHOPIFY_PAGE = /cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.shop|ShopifyAnalytics/;

function shopifyCollection(listingUrl) {
  let url;
  try { url = new URL(String(listingUrl)); } catch (err) { return null; }
  const m = url.pathname.match(SHOPIFY_COLLECTION);
  if (!m || /\/collections\/(all-)?search$/i.test(m[1])) return null;
  return { origin: url.origin, url: `${url.origin}${m[1]}/products.json?limit=250` };
}

async function collectionTiles(listingUrl, fetcher, within, stats) {
  const st = stats || {};
  const target = shopifyCollection(listingUrl);
  if (!target || typeof fetcher !== 'function') return [];
  const got = await fetcher(target.url, { accept: 'application/json' }, within);
  if (!got.ok) { st.collection = `could not be read (${got.why})`; return []; }
  let data;
  try {
    const { response } = got;
    if (response.status !== 200) {
      if (response.body) await response.body.cancel().catch(() => {});
      st.collection = `answered ${response.status}`;
      return [];
    }
    data = JSON.parse(await response.text());
  } catch (err) {
    st.collection = 'not readable JSON';
    return [];
  } finally {
    got.release();
  }
  const products = data && Array.isArray(data.products) ? data.products.slice(0, 250) : [];
  const tiles = [];
  for (const product of products) {
    if (!product || typeof product !== 'object') continue;
    const handle = typeof product.handle === 'string' ? product.handle.trim() : '';
    const title = typeof product.title === 'string' ? product.title.trim() : '';
    const id = typeof product.id === 'number' || typeof product.id === 'string' ? String(product.id) : '';
    const images = Array.isArray(product.images) ? product.images : [];
    const image = images.map((one) => (one && typeof one === 'object' ? one.src : one)).find((one) => typeof one === 'string' && one.trim());
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(handle) || !title || !/^\d+$/.test(id) || !image) continue;
    tiles.push({ url: `/products/${handle}`, name: title, names: [title], id, image, typed: true, where: 'shopify collection products.json' });
  }
  st.collection = `read: ${tiles.length} of ${products.length} product${products.length === 1 ? '' : 's'} complete`;
  return tiles;
}

/* the served markup's tiles: its JSON-LD, and a Next.js page's data */
function tilesFromHtml(html, stats) {
  const st = stats || {};
  const tiles = embeddedProductTiles(jsonLdNodes(html), 'json-ld', 200, st);
  const next = String(html || '').match(/<script\b[^>]*\bid\s*=\s*["']?__NEXT_DATA__["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!next) st.nextServed = st.nextServed || 'absent';
  else if (next[1].length >= 8000000) st.nextServed = 'too large to read';
  else {
    try {
      tiles.push(...embeddedProductTiles(JSON.parse(next[1]), '__NEXT_DATA__', 200, st));
      st.nextServed = 'read';
    } catch (err) {
      st.nextServed = 'not readable JSON';
    }
  }
  return tiles;
}

/* the rendered page's framework state, read in the page, and only the
   tiles embeddedProductTiles takes — never the state itself */
function pageStateTiles(walker) {
  const out = [];
  const stats = { next: 'absent' };
  try {
    stats.shopify = Boolean(window.Shopify && window.Shopify.shop);
    const el = document.getElementById('__NEXT_DATA__');
    let next = null;
    if (el && el.textContent) {
      if (el.textContent.length >= 8000000) stats.next = 'too large to read';
      else { try { next = JSON.parse(el.textContent); stats.next = 'read'; } catch (err) { stats.next = 'not readable JSON'; } }
    }
    if (!next && window.__NEXT_DATA__ && typeof window.__NEXT_DATA__ === 'object') { next = window.__NEXT_DATA__; stats.next = 'read'; }
    const sources = [['__NEXT_DATA__', next]];
    for (const name of ['__NUXT__', '__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__']) sources.push([name, window[name]]);
    for (const [name, data] of sources) {
      if (data && typeof data === 'object') out.push(...walker(data, name, 200, stats));
      if (out.length >= 300) break;
    }
  } catch (err) { stats.failed = String(err && err.message ? err.message : err).slice(0, 200); }
  return { tiles: out.slice(0, 300), stats };
}

/* whether a raw record links to a host that sells nothing; read through
   a guard, because a record is whatever the source handed over */
function fromNoShop(record) {
  try {
    const link = record && typeof record === 'object' ? (record.productUrl || record.link || record.url) : null;
    return typeof link === 'string' && NOT_A_SHOP.test(new URL(link).hostname);
  } catch (err) {
    return false;
  }
}

/* a result counts as found only when the semantic gate reads the row's
   garment in its title: a page of patterns, tutorials or other garments
   does not end the search. It decides nothing about the result itself —
   every one is still ranked and put to every gate. */
function titleReads(row, record) {
  try {
    const title = record && typeof record === 'object' ? (record.title || record.name || '') : '';
    return readTitleSafely(row, { title }).ok;
  } catch (err) {
    return false;
  }
}

function fromEditorial(record) {
  try {
    const link = record && typeof record === 'object' ? (record.productUrl || record.link || record.url) : null;
    return typeof link === 'string' && listingShape(link, record.title || record.name || '').kind === 'editorial';
  } catch (err) {
    return false;
  }
}

async function listingsFor(row, limit, within) {
  const source = productSource();
  if (!source) return { failed: 'the product source adapter could not be loaded' };

  const provider = source.getProvider();
  if (!provider || provider.name === 'none') {
    return { failed: 'no product source is configured — set PRODUCT_SOURCE and its key (see .env.example)' };
  }
  if (typeof provider.configured === 'function' && !provider.configured()) {
    return { failed: `the ${provider.name} product source has no key configured (see .env.example)` };
  }

  const budget = within || budgetOf(ROW_BUDGET);
  const wanted = limit || 8;
  const forms = queryForms(row);
  const chain = providerChain(source);
  const attempts = [];
  const raw = [];
  const seenRaw = new Set();
  let failures = 0;
  let using = 0;
  let switched = null;

  /* A source whose product surface has already come back with no
     retailer link for THIS row. A live probe settled why that happens
     with Serper — its /shopping results are Google's own Shopping
     cards, forty of them, with no retailer URL anywhere in the
     response — and once a row has seen that, asking the same endpoint
     for the row's four other phrasings buys four more empty answers at
     four more requests. So the rest of the row goes straight to the
     endpoint that does carry a link. Per row, and per source: nothing
     is remembered across rows, so a surface that starts working is
     asked again on the next one. */
  const noLinksFrom = new Set();

  for (const form of forms) {
    /* A search costs money, so the ladder is climbed only as far as it
       has to be: it keeps going while nothing has been found, and stops
       once something has, after one more form to pad the shortlist. A
       row whose name works answers in two searches, not five. */
    /* a forum thread or a pinboard is not something found: it is
       dropped below, and a shortlist made of them is an empty one */
    /* an article about the garment is not something found: it is ranked
       last and never offers a product, so a first page of blog posts
       does not end the search before the next wording is asked */
    const shortlisted = raw.filter((record) => !fromNoShop(record) && !fromEditorial(record) && titleReads(row, record)).length;
    if (shortlisted >= wanted) break;
    /* Two searches are enough once they have found a real shortlist;
       one or two passable titles are not, because a page of tutorials
       with a stray match in it is exactly what a wrongly worded query
       returns, and the next wording may be the one shops use. */
    if (shortlisted >= ENOUGH_FOUND && attempts.length >= 2) break;
    /* and the ladder stops where the row's clock does: another query
       put to a source that is not answering buys nothing but the wait */
    if (budget.spent()) {
      attempts.push({ how: form.how, query: form.query, provider: chain[using].name, failed: 'the time for this row ran out' });
      break;
    }

    /* one form, asked of the source in use, and asked again of the next
       source only when this one says it has no searches left */
    let batch = null;
    let failed = null;
    let askedOrganic = false;
    while (using < chain.length) {
      const source = chain[using];
      /* only a source that HAS a discovery endpoint of its own, and
         only after its product surface came back linkless for this row */
      const organicOnly = noLinksFrom.has(source.name) && typeof source.searchOrganic === 'function';
      try {
        /* Which endpoint, and how long it may take. Those are two
           separate questions, and each side of this conflict answered
           one of them: the row decides WHICH surface to ask — the
           product one, or the organic one once this source's product
           surface has already come back linkless for this row — and the
           budget decides how long the answer is waited for, whichever
           was asked. A ceiling on the product endpoint alone would have
           left the escalation, which exists precisely because the first
           endpoint disappointed, as the one unbounded request in a run. */
        batch = await withCeiling(
          organicOnly
            ? source.searchOrganic(form.intent, { limit: wanted })
            : source.search(form.intent, { limit: wanted }),
          budget.cap(SEARCH_TIMEOUT),
          `the ${source.name} ${organicOnly ? 'organic' : 'product'} endpoint did not answer within ` +
            `${Math.round(budget.cap(SEARCH_TIMEOUT) / 1000)}s`
        );
        askedOrganic = organicOnly;
        failed = null;
        break;
      } catch (err) {
        const said = err && err.message ? String(err.message).split('\n')[0] : String(err);
        if (outOfSearches(err) && using + 1 < chain.length) {
          switched = { from: chain[using].name, to: chain[using + 1].name, why: said };
          attempts.push({
            how: form.how,
            query: form.query,
            provider: chain[using].name,
            failed: said,
            fellBackTo: chain[using + 1].name
          });
          using += 1;
          continue;
        }
        failed = said;
        break;
      }
    }

    if (failed !== null) {
      failures += 1;
      attempts.push({ how: form.how, query: form.query, provider: chain[using].name, failed });
      continue;
    }

    const offered = Array.isArray(batch) ? batch : [];
    /* An adapter may attach its own account of the search to the batch
       it returns — how many results the source sent, how many of them
       named a shop, which keys a URL arrived under. It was being
       dropped on the floor here, which is how a run could report "40
       offered" and then nothing, and leave no way to tell whether the
       adapter read the wrong field or the source sent no link at all.
       It is carried through and printed rather than acted on. */
    const said = batch && typeof batch === 'object' ? batch.diagnostics : null;

    /* ---- when the product surface carries no retailer URL ----

       Serper's /shopping answers with Google's own Shopping cards, so
       every record it maps arrives with no productUrl and the link rule
       drops all of them. Its /search endpoint answers the same question
       with ordinary web results, whose link IS the shop's own page.

       So: one more request, the same query, asked only when the batch
       just received carried no link at all. What comes back is a title
       and a URL and nothing else — no price, no photo, no retailer,
       because the endpoint supplies none of those and inventing them is
       the thing every gate here exists to prevent. Those candidates go
       through the link rule, the semantic gate, the page stage and the
       four image gates exactly as any other candidate does: the photo
       is read off the retailer's own page and proved to belong to the
       product, and the row keeps its own name, brand and price.

       Nothing else in the chain has a searchOrganic, so nothing else
       changes: SerpApi is asked the way it was always asked. */
    const source = chain[using];
    /* the product source's own rule, shared with /api/search, so a
       catalogue run and a shopper's search escalate on the same batch */
    const linked = !linklessBatch(offered);
    let organic = [];
    let organicSaid = null;
    let organicFailed = null;
    let organicAsked = false;

    if (!askedOrganic && !linked && typeof source.searchOrganic === 'function') {
      noLinksFrom.add(source.name);
      organicAsked = true;
      try {
        /* the same ceiling, for the same reason. Git merged this call
           cleanly only because 1e103da never touched it, which would
           have left the run's SECOND provider search — the one asked
           because the first came back linkless — as the only unbounded
           one. A spent budget now makes it reject at once instead of
           opening a request the row has no time left to read, and that
           refusal lands in organicFailed below, where the diagnostics
           already account for it. */
        const more = await withCeiling(
          source.searchOrganic(form.intent, { limit: wanted }),
          budget.cap(SEARCH_TIMEOUT),
          `the ${source.name} organic endpoint did not answer within ` +
            `${Math.round(budget.cap(SEARCH_TIMEOUT) / 1000)}s`
        );
        organic = Array.isArray(more) ? more : [];
        organicSaid = more && typeof more === 'object' && more.diagnostics ? more.diagnostics : null;
      } catch (err) {
        /* a failed escalation is one query form that found nothing, not
           a run that failed: the next form is still asked */
        organicFailed = err && err.message ? String(err.message).split('\n')[0] : String(err);
      }
    }

    attempts.push({
      how: form.how,
      query: form.query,
      provider: source.name,
      offered: offered.length + organic.length,
      diagnostics: said && typeof said === 'object' ? said : null,
      /* the second endpoint, named rather than hidden inside a total */
      escalated: askedOrganic
        ? { endpoint: 'organic', asked: 'directly', offered: offered.length, failed: null, diagnostics: null }
        /* recorded whenever it was ASKED, including when it came back
           with nothing: a request that bought nothing is the thing a
           cost report most needs to see */
        : organicAsked
          ? { endpoint: 'organic', asked: 'after a linkless batch', offered: organic.length, failed: organicFailed, diagnostics: organicSaid }
          : null
    });
    for (const record of organic.length ? offered.concat(organic) : offered) {
      let key;
      try {
        key = JSON.stringify([record && record.productUrl, record && record.title]);
      } catch (err) {
        /* a record that cannot even be keyed is kept rather than
           dropped: the gates downstream are what decide it, and they
           are guarded */
        raw.push(record);
        continue;
      }
      if (seenRaw.has(key)) continue;
      seenRaw.add(key);
      raw.push(record);
    }
  }

  if (failures === forms.length) {
    const first = attempts.find((attempt) => attempt.failed);
    const asked = [...new Set(chain.slice(0, using + 1).map((one) => one.name))].join(' then ');
    return {
      failed: `the ${asked} product source${using ? 's' : ''} failed on all ${forms.length} query forms (${first ? first.failed : 'unknown'})`,
      attempts,
      sourceFailed: true
    };
  }

  /* The display gate is not the right gate here. It exists to decide
     what may be SHOWN, so it insists on a price and a photo from the
     feed — and discovery wants neither: the photo is read off the
     page, and a listing with no price in the feed is still a page
     worth photographing. What does apply is the link rule, which is
     what refuses aggregators, search and category pages, and
     redirectors, so that is used on its own. */
  const URL_FIELDS = ['productUrl', 'product_url', 'url', 'link', 'product_link', 'offer_link', 'product_page_url'];
  const TITLE_FIELDS = ['title', 'name', 'product_title'];
  const BRAND_FIELDS = ['brand', 'brand_name', 'manufacturer'];

  const pick = (record, fields) => {
    for (const field of fields) {
      const value = record && record[field];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };

  const products = [];
  const rejected = {};
  const seen = new Set();

  for (const record of Array.isArray(raw) ? raw : []) {
    /* a record is whatever the source handed over, which is not
       necessarily an object that answers questions politely. One that
       throws on being read is one record dropped, not a run lost. */
    try {
      const url = pick(record, URL_FIELDS);
      if (!url) { rejected['no-product-url'] = (rejected['no-product-url'] || 0) + 1; continue; }

      const fault = source.linkFault(url);
      if (fault) { rejected[fault] = (rejected[fault] || 0) + 1; continue; }
      if (seen.has(url)) continue;
      seen.add(url);

      products.push({ productUrl: url, title: pick(record, TITLE_FIELDS), brand: pick(record, BRAND_FIELDS) });
    } catch (err) {
      rejected['unreadable-record'] = (rejected['unreadable-record'] || 0) + 1;
    }
  }

  /* the order the page stage reads them in: a product page before a
     category page, a category page before an article, and a forum
     thread or a pinboard not at all */
  const { ranked, dropped } = rankListings(products);
  if (dropped.length) rejected['not-a-shop'] = (rejected['not-a-shop'] || 0) + dropped.length;

  return {
    provider: chain[using].name,
    primary: provider.name,
    switched,
    products: ranked,
    rejected,
    attempts,
    searches: attempts.length
  };
}

/* the product pages the category pages among `tried` listed, in the
   order the pages were tried, less any the search already offered */
const MAX_TILES_PER_ROW = 8;
const MAX_REFUSED_TILES = 4;  // wrong-garment tiles kept for the report; they are refused before any request
const TILE_RESERVE = 45000;   // what a row keeps back for those products once a category page has listed some

function tilesOffered(row, tried, products) {
  const passing = [];
  const refused = [];
  const known = new Set((products || []).map((one) => one && productKey(one.productUrl)).filter(Boolean));
  for (const attempt of tried) {
    for (const link of attempt.productLinks || []) {
      const key = productKey(link.productUrl);
      if (!key || known.has(key)) continue;
      known.add(key);
      /* The record's own names, read by the same title gate every
         candidate meets: a full match first, then one that leaves
         something for the page to prove. A colour or a line name beside
         the garment's name does not get to speak for it. */
      let best = null;
      for (const name of (link.names && link.names.length ? link.names : [link.title])) {
        const verdict = readTitleSafely(row, { title: name });
        const rank = verdict.ok ? (verdict.kind === 'match' ? 0 : 1) : 2;
        if (!best || rank < best.rank) best = { name, rank };
        if (rank === 0) break;
      }
      const product = {
        productUrl: link.productUrl,
        title: best ? best.name : link.title,
        brand: null,
        shape: listingShape(link.productUrl, best ? best.name : link.title),
        foundOn: attempt.url,
        rank: best ? best.rank : 2
      };
      if (product.rank < 2) passing.push(product);
      else if (refused.length < MAX_REFUSED_TILES) refused.push(product);
    }
  }
  /* full matches before partial ones, each in the page's own order: the
     sort is stable, so the earliest valid candidate still wins its tier */
  passing.sort((a, b) => a.rank - b.rank);
  return passing.slice(0, MAX_TILES_PER_ROW).concat(refused);
}

/* The title stage, which cannot be allowed to throw: a candidate whose
   title breaks the reader is a candidate that failed, not a run that
   failed. */
function readTitleSafely(row, product) {
  try {
    return semanticMatch(row, { title: product && product.title });
  } catch (err) {
    const said = err && err.message ? String(err.message).split('\n')[0] : String(err);
    return { ok: false, kind: 'error', why: `its title could not be read (${said})`, pending: [] };
  }
}

/* One row, from "a name with nothing behind it" to a verified listing.
   `taken` maps an already-used photo to the row using it, because two
   rows wearing the same picture is the catalogue telling a lie about
   one of them.

   The semantic gate runs FIRST and for every candidate, before a single
   page is fetched: reading a title costs nothing, and a listing that
   sells the wrong garment is not made right by having a verifiable
   photo. Every candidate keeps its decision either way, so the report
   can say why each one passed or failed rather than only naming the
   winner. */
async function discoverRow(row, taken, limit, options) {
  /* One row's whole clock, shared by the search, every page read under
     it and every image checked on those pages. A row that spends it is
     a row that reports what it managed; it is never a row that stops
     the nineteen behind it. */
  const budget = (options && options.budget) || budgetOf(ROW_BUDGET);
  const found = await listingsFor(row, limit, budget);
  if (found.failed) {
    /* an unconfigured source and a source that answered with an error
       are different problems with different fixes, and calling both
       NO SOURCE is what made a run of them unreadable */
    return {
      id: row.id,
      verdict: found.sourceFailed ? 'SOURCE FAILED' : 'NO SOURCE',
      why: found.failed,
      attempts: found.attempts || [],
      switched: found.switched || null,
      tried: []
    };
  }

  /* Every candidate carries a verdict from here on, including one whose
     title could not be read at all. A tried entry without a `semantic`
     is a report that throws, and a report that throws takes the run
     with it — so the shape is guaranteed at the point it is built
     rather than hoped for at the point it is printed. */
  const tried = found.products.map((product) => ({
    url: product && product.productUrl,
    title: product && product.title,
    brand: product && product.brand,
    shape: product && product.shape ? product.shape.kind : null,
    semantic: readTitleSafely(row, product),
    why: null
  }));

  /* declared before the loop because the VERIFIED return inside it
     carries them out, and a reference into the temporal dead zone would
     be caught by the per-candidate guard below and reported as a
     candidate that could not be read */
  const searched = found.attempts || [];
  const switched = found.switched || null;

  /* One candidate is one candidate, and now several of them are read at
     once. The order is still the order: `raceInOrder` answers with the
     EARLIEST listing that cleared every gate, not the first to come
     back, so a fast shop further down the source's ranking cannot
     overtake a better match above it. What concurrency buys is that a
     retailer taking its twenty seconds does so while the others are
     being read, instead of in front of them. */
  const tryCandidate = async (attempt, at) => {
    const product = found.products[at] || {};

    /* A retailer that serves malformed markup, a page that blocks
       halfway through, a record in a shape nothing here expected — each
       is a fact about that listing, not a reason to abandon the other
       candidates for this row, let alone the twenty rows queued behind
       it. So the whole of a candidate's handling sits inside this try,
       and a throw becomes a failed candidate the report can show. */
    try {

    /* stage one, on the title alone: a contradiction ends it here and
       costs no request. A title that merely does not SAY something goes
       on to the page, which is where a specification lives. */
    if (!attempt.semantic.ok) {
      attempt.why = `the semantic gate refused it: ${attempt.semantic.why}`;
      return { ok: false };
    }

    /* the row's clock, checked before the request rather than during
       it: one unreachable shop takes its ceiling and no more, and the
       candidates behind it are refused for want of time rather than
       left queued behind a socket that will never answer */
    if (budget.spent()) {
      attempt.why = 'the time for this row ran out before this listing could be read';
      attempt.ranOut = true;
      return { ok: false };
    }

    /* Category pages rank last, so their listed products can only be
       read after them. Once one of them has listed some, the category
       pages still waiting do not get to spend the time that round needs. */
    if (!attempt.foundOn && attempt.shape !== 'product' && budget.left() < TILE_RESERVE
        && tried.some((one) => one.productLinks && one.productLinks.length)) {
      attempt.why = 'held back: the time left is kept for the products a category page already listed';
      attempt.ranOut = true;
      return { ok: false };
    }

    const result = await resolveRow({
      id: row.id,
      brand: product.brand || '—',
      name: product.title || row.name,
      productUrl: product.productUrl
    }, budget, { catalogRow: row });

    /* diagnostics */
    if (diagnosing) {
      attempt.imageDiagnosis = result.diagnosis;
      recordDiagnosis({ rowId: row.id, listing: product.productUrl, title: product.title, verdict: result.verdict, why: result.why, diagnosis: result.diagnosis });
    }

    if (result.verdict !== 'VERIFIED') {
      attempt.why = result.why;
      /* a category page's own products, offered below as candidates of
         their own; a candidate that came from one offers no more */
      if (!attempt.foundOn && (attempt.shape === 'listing' || attempt.shape === 'unknown')) {
        attempt.productLinks = result.productLinks || [];
        /* reported, never decided on */
        attempt.tileReport = result.diagnosis ? result.diagnosis.tiles || null : null;
      }
      return { ok: false };
    }

    /* the page's own name is the better description of what is for sale
       than the feed's title, so the gate is put to it again where the
       two differ. A feed that undersells a mismatch does not get to
       smuggle one in. */
    const facts = result.facts || {};
    let onPage = null;
    if (facts.name && facts.name.trim() && facts.name.trim() !== String(product.title || '').trim()) {
      onPage = semanticMatch(row, { title: facts.name.trim() });
      attempt.onPage = onPage;
      if (!onPage.ok) {
        attempt.why = `its own page calls it "${facts.name.trim()}" — ${onPage.why}`;
        return { ok: false };
      }
    }

    /* stage two: whatever the title left pending has to be established
       by the page itself. The page's own name may have settled some of
       it already, so the shorter of the two lists is what is still
       owed. Nothing waives this — a descriptor the row states and
       neither the title nor the page establishes is a candidate that
       was never shown to be the garment. */
    const pending = onPage && onPage.ok && (onPage.pending || []).length <= (attempt.semantic.pending || []).length
      ? onPage.pending || []
      : attempt.semantic.pending || [];

    if (pending.length) {
      const proof = proveOnPage(pending, result.evidence);
      attempt.proof = proof;
      if (proof.missing.length) {
        attempt.why = `its page never establishes ${proof.missing.map(nameOfPending).join(', ')} either` +
          `${proof.proved.length ? `, though it does establish ${proof.proved.map((one) => nameOfPending(one.item)).join(', ')}` : ''}`;
        return { ok: false };
      }
      attempt.provedOnPage = proof.proved;
    }

    /* A photo another row is already wearing. Rows are still taken one
       at a time, so this map cannot change underneath a lane — and if
       two candidates for THIS row were ever to land on one photo, the
       earlier of them is the one that wins, which is the same answer a
       serial run gave. */
    if (taken.has(result.url)) {
      attempt.why = `its photo is already on ${taken.get(result.url)}`;
      return { ok: false };
    }

    attempt.why = result.why;
    attempt.verified = true;
    return { ok: true, result, onPage, facts, product };

    } catch (err) {
      const said = err && err.message ? String(err.message).split('\n')[0] : String(err);
      attempt.failed = said;
      attempt.why = `this candidate could not be read: ${said}`;
      return { ok: false };
    }
  };

  const first = await raceInOrder(tried, LANES, tryCandidate);
  const results = first.results;
  let winner = first.winner;

  /* Nothing the search returned cleared every gate. A category page
     among them may list, in its own data, the products it shows: those
     product pages are tried now, in the page's own order, each exactly
     as a search result would be — title, page, photo, every gate. */
  if (winner < 0 && !budget.spent()) {
    const extras = tilesOffered(row, tried, found.products);
    if (extras.length) {
      const base = tried.length;
      for (const product of extras) {
        found.products.push(product);
        tried.push({
          url: product.productUrl,
          title: product.title,
          brand: null,
          shape: product.shape.kind,
          foundOn: product.foundOn,
          semantic: readTitleSafely(row, product),
          why: null
        });
      }
      const more = await raceInOrder(tried.slice(base), LANES, (attempt, at) => tryCandidate(attempt, base + at));
      more.results.forEach((one, at) => { results[base + at] = one; });
      if (more.winner >= 0) winner = base + more.winner;
    }
  }

  /* a candidate a lane never got to, because the answer was already
     found above it, says so rather than pretending to a verdict */
  tried.forEach((attempt, at) => {
    if (!results[at] && attempt.why === null) {
      attempt.why = 'a listing ranked above it cleared every gate first, so this one was not read';
    }
  });

  if (winner >= 0) {
    const attempt = tried[winner];
    const { result, onPage, facts, product } = results[winner];
    return {
      id: row.id,
      verdict: 'VERIFIED',
      why: result.why,
      tried,
      attempts: searched,
      switched,
      semantic: attempt.semantic,
      onPage,
      provedOnPage: attempt.provedOnPage || [],
      proposal: {
        productUrl: product.productUrl,
        imageUrl: result.url,
        /* what the gate established, carried through to the file so the
           written row accounts for its own photo */
        identity: result.identity,
        /* named listingName/listingBrand and NOT name/brand on purpose:
           they are what the shop calls it, reported so a run can be read,
           and the row keeps its own name and brand */
        listingName: facts.name || product.title || null,
        listingBrand: facts.brand || product.brand || null
      },
      identity: result.identity
    };
  }

  const refused = tried.filter((attempt) => !attempt.semantic.ok).length;
  const unproven = tried.filter((attempt) => attempt.proof && attempt.proof.missing.length).length;
  const broke = tried.filter((attempt) => attempt.failed).length;
  return {
    id: row.id,
    verdict: 'NO PRODUCT FOUND',
    why: found.products.length
      ? `${found.products.length} listing${found.products.length === 1 ? '' : 's'} offered over ${searched.length} quer${searched.length === 1 ? 'y' : 'ies'}, ` +
        `${refused} refused on the title as the wrong garment` +
        `${unproven ? `, ${unproven} read to the page and still unproven` : ''}` +
        `${broke ? `, ${broke} could not be read at all` : ''}` +
        `, none cleared every gate`
      /* which link fault dropped them is the whole diagnosis when a
         source offers listings and none survives, so it is named here
         rather than left in a tally nothing prints */
      : `the ${found.provider} source offered no listing that is a product page, over ${searched.length} quer${searched.length === 1 ? 'y' : 'ies'}`
        + (Object.keys(found.rejected || {}).length
          ? ` — ${Object.entries(found.rejected).map(([why, n]) => `${n} ${why}`).join(', ')}`
          : ''),
    attempts: searched,
    switched,
    tried
  };
}

/* ---------- re-proving an embedded record against its own page ----------

   A .js record's note can be re-proved from the row alone, the way a
   sku can. An embedded one cannot: what vouched for the photo was the
   page, so the page is read again. The row's own listing is rendered,
   its router's product is read by the same rules as discovery, and the
   row stands only if that product still has the recorded handle and id,
   its title still fully matches the row, its media still lists this
   photo, and the photo still clears the host, asset and load checks.
   The note is never believed on its own. */
async function reproveEmbeddedRecord(row) {
  const no = (why) => ({ ok: false, why });
  const structural = catalogRowIdentity(row);
  if (!structural.ok || !structural.needsLive) return structural;
  const evidence = row.imageEvidence;

  const rendered = await renderPage(row.productUrl, budgetOf(RENDER_BUDGET));
  if (rendered.failed) return no(`its page could not be read again to re-prove it — ${rendered.failed}`);
  try {
    const got = embeddedRecordFrom(rendered.seen.reactRouter, row.productUrl, row, rendered.seen.canonical);
    if (!got.record) return no(`its page no longer proves it — ${got.failed}`);
    if (got.record.id !== String(evidence.productId)) {
      return no(`its page now carries product ${got.record.id}, not the recorded ${evidence.productId}`);
    }
    let image;
    try { image = new URL(String(row.imageUrl), row.productUrl).href; } catch (err) { return no('its photo is not a URL'); }
    if (!got.record.images.includes(image)) {
      return no(`its page's product ${got.record.handle} no longer lists this photo in its media`);
    }
    const identity = productRecordEvidence({ url: image, from: 'product-record', record: got.record }, row.productUrl);
    if (!identity.ok) return no(identity.why);
    const unsound = soundness(image, row.productUrl);
    if (unsound) return no(unsound);
    const asset = siteAsset(image, row.productUrl);
    if (asset) return no(asset);
    const loads = await verifyImage(image, rendered.verify, IMAGE_TIMEOUT);
    if (!loads.ok) return no(`its photo does not load — ${loads.why}`);
    return {
      ok: true,
      via: 'product-record',
      source: 'embedded-react-router',
      how: `its page was read again: product ${got.record.handle} (${got.record.id}, "${got.record.title}") still lists this photo, and it loads`
    };
  } finally {
    await (rendered.close || (async () => {}))();
  }
}

/* ---------- what the catalogue looks like right now ---------- */
function coverage(rows) {
  const linked = rows.filter((row) => row && row.productUrl);
  const withPhoto = rows.filter((row) => row && row.imageUrl);
  const accounted = [];
  const unaccounted = [];

  const awaitingPage = [];
  for (const row of rows) {
    const checked = catalogRowIdentity(row);
    /* a note that says "the page listed it" is not counted until the
       page has said so again — coverageLive reads it */
    if (checked.ok && checked.needsLive) { awaitingPage.push(row.id); continue; }
    (checked.ok ? accounted : unaccounted).push({ id: row.id, why: checked.why || checked.how });
  }

  return {
    awaitingPage,
    rows: rows.length,
    linked: linked.length,
    withPhoto: withPhoto.length,
    missing: rows.filter((row) => row && !row.imageUrl).map((row) => row.id),
    accounted: accounted.length,
    unaccounted
  };
}

/* coverage(), with every row whose evidence is its page read again. Only
   those rows cost a page; every other row is decided from the file. */
async function coverageLive(rows) {
  const report = coverage(rows);
  if (report.awaitingPage.length) {
    console.log(`\n  Reading ${report.awaitingPage.length} product page${report.awaitingPage.length === 1 ? '' : 's'} again: ${report.awaitingPage.length === 1 ? 'its photo is' : 'their photos are'} vouched for by the page's own product record.`);
  }
  for (const id of report.awaitingPage) {
    const row = rows.find((one) => one && one.id === id);
    const proved = await reproveEmbeddedRecord(row);
    if (proved.ok) report.accounted += 1;
    else report.unaccounted.push({ id, why: proved.why });
  }
  report.awaitingPage = [];
  return report;
}

function printCoverage(report) {
  console.log(`\n  ${report.withPhoto} of ${report.rows} rows carry a photo, and ${report.linked} link to a listing.`);
  console.log(`  ${report.accounted} of ${report.rows} account for what they carry.`);
  if (report.awaitingPage && report.awaitingPage.length) {
    console.log(`  ${report.awaitingPage.length} more wait on their own page being read again: ${report.awaitingPage.join(', ')}`);
  }
  if (report.unaccounted.length) {
    console.log('\n  UNACCOUNTED:');
    for (const row of report.unaccounted) console.log(`     ${row.id} — ${row.why}`);
  }
  if (report.missing.length) {
    console.log(`\n  ${report.missing.length} row${report.missing.length === 1 ? '' : 's'} carry no photo:`);
    for (const id of report.missing.slice(0, 40)) console.log(`     ${id}`);
    console.log('\n  --discover asks the configured product source for a real listing for each,');
    console.log('  reads every one it offers as a garment, and puts what survives that');
    console.log('  through the same four gates.');
  }
  console.log('');
}

/* ---------- what a run proved, written down ----------

   Discovery is the expensive half: a live search for every row that has
   no photo, a page fetch for every listing it offers, and a real browser
   for the pages that refuse a bare client. Writing is the cheap half —
   three fields per row, decided entirely by what discovery established.

   They used to be the same command, which meant keeping a result cost
   the search twice: --discover to see what was found, --discover --write
   to keep it, and the second run re-derived from nothing what the first
   had already proved. Two searches for one result, and the second could
   disagree with the first because the shops had moved on in between.

   So a run that verifies anything writes it down here, and --write reads
   it back. The file holds only rows that cleared every gate, only the
   three fields discovery is allowed to fill, and what it took to prove
   them.

   Nothing in it is believed. Everything that can be decided without a
   retailer is decided AGAIN on the way back in: the host gate, the
   evidence that ties this photo to this listing, the title stage of the
   semantic gate, and whether the row still means what it meant when the
   listing was checked against it. What genuinely needed the page — the
   descriptors the title left pending — is carried with what the page
   said, because that is the one question this side cannot ask again,
   and an entry whose record does not cover it is refused.

   A report edited by hand therefore fails exactly the way a catalogue
   row edited by hand fails. What the file buys is the fact that
   verification happened, never permission to skip it. */

/* the report's path as a human typed it, for a line that has to be read */
function rel(file) {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith('..') ? relative : file;
}

/* Everything the write half needs, and nothing it does not. A row that
   did not clear every gate is in the run's printed output and nowhere
   else, because nothing downstream may write it. */
function reportFrom(found, rows, options) {
  const entries = [];
  for (const result of found) {
    if (!result || result.verdict !== 'VERIFIED' || !result.proposal) continue;
    const row = rows.find((one) => one && one.id === result.id) || {};
    entries.push({
      id: result.id,
      verified: true,

      /* the three fields discovery is allowed to fill, exactly as this
         run produced them */
      productUrl: result.proposal.productUrl,
      imageUrl: result.proposal.imageUrl,

      /* the note as it will appear in the file, verbatim, so what lands
         in the catalogue is what was proved rather than something
         re-derived later from a different reading */
      imageEvidence: evidenceNote(result.proposal.identity),

      /* the image gate's own finding, which is what re-proves the tie
         between photo and listing on the way back in */
      identity: result.proposal.identity || null,

      /* what the shop called it, so the semantic gate's title stage can
         be put to it again with no page in front of it */
      listingName: result.proposal.listingName || null,
      listingBrand: result.proposal.listingBrand || null,

      /* what the page settled of whatever the title left pending. Sets
         do not survive JSON and are not needed: the name is what a
         pending item is matched by. */
      provedOnPage: (result.provedOnPage || []).map((one) => ({
        kind: one && one.item ? one.item.kind : null,
        name: nameOfPending(one && one.item),
        where: one ? one.where : null,
        quote: one ? one.quote : null
      })),

      /* the row as it was when the listing was checked against it. A row
         renamed since is a row this listing was never checked against. */
      row: {
        name: row.name === undefined ? null : row.name,
        brand: row.brand === undefined ? null : row.brand,
        category: row.category === undefined ? null : row.category
      },

      why: result.why || null
    });
  }

  return {
    version: REPORT_VERSION,
    createdAt: new Date().toISOString(),
    catalog: path.relative(path.join(__dirname, '..'), CATALOG),
    options: options || {},
    /* set once these entries are in the catalogue, so the same report
       cannot be applied twice and a second --write cannot be mistaken
       for an instruction to go searching again */
    appliedAt: null,
    applied: [],
    entries
  };
}

function saveReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return file;
}

/* `spent` is whether the WHOLE report was considered. --only takes one
   row out of one, and the entries it did not look at have not been
   applied — marking the file spent would strand them, and the rows they
   belong to would never be written without a fresh search. So the ids
   are recorded either way, and the report is closed only when there is
   nothing left in it to apply. */
function markApplied(file, report, ids, spent) {
  const next = Object.assign({}, report, {
    appliedAt: spent === false ? report.appliedAt || null : new Date().toISOString(),
    applied: ids
  });
  saveReport(file, next);
  return next;
}

/* Whether the file is a report at all, and recent enough to stand for
   what the shops were selling. Nothing about the rows is judged here —
   that is per row, below, so one bad entry cannot take the others with
   it. A problem at THIS level is different: it means the file cannot be
   read as a report, and then there is nothing to write. */
function loadReport(file, now) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    /* nothing there is the ordinary case and means "go and find out".
       Something there that cannot be read is not the same thing, and
       silently starting a live search on the strength of it would be
       the expensive half running for the wrong reason. */
    if (err && err.code === 'ENOENT') {
      return { missing: true, why: `there is no discovery report at ${rel(file)}` };
    }
    return { unusable: true, why: `the discovery report at ${rel(file)} could not be read (${err && err.code})` };
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    return { unusable: true, why: `the discovery report at ${rel(file)} is not readable JSON` };
  }

  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { unusable: true, why: `${rel(file)} holds something that is not a discovery report` };
  }
  if (report.version !== REPORT_VERSION) {
    return {
      unusable: true,
      why: `the discovery report at ${rel(file)} was written by a different version of this script (${report.version})`
    };
  }
  if (!Array.isArray(report.entries)) {
    return { unusable: true, why: `the discovery report at ${rel(file)} records no rows` };
  }

  const written = Date.parse(report.createdAt);
  if (!Number.isFinite(written)) {
    return { unusable: true, why: `the discovery report at ${rel(file)} does not say when it was made` };
  }

  const age = (now === undefined ? Date.now() : now) - written;
  const hours = Math.round(Math.abs(age) / 3600000);
  if (age < 0) {
    return { unusable: true, why: `the discovery report at ${rel(file)} is dated ${hours} hours in the future` };
  }
  if (age > REPORT_TTL_MS) {
    return {
      unusable: true,
      why: `the discovery report at ${rel(file)} is ${hours} hours old, past the ` +
        `${Math.round(REPORT_TTL_MS / 3600000)}-hour limit — the listings behind it have had time to move`
    };
  }

  return { report, age };
}

/* One entry, put back through every gate that does not need a retailer.
   A refusal here leaves the row exactly as it was, and the other entries
   are unaffected — the same rule discovery itself runs on. */
function replayable(entry, rows, taken) {
  const no = (why) => ({ ok: false, why });

  if (!entry || typeof entry !== 'object') return no('the report holds something that is not a row');
  if (!entry.id) return no('the report holds a row with no id');
  if (entry.verified !== true) return no('it is not marked as having cleared the gates');
  if (!entry.productUrl || !entry.imageUrl) return no('it records no listing, or no photo');

  const row = rows.find((one) => one && one.id === entry.id);
  if (!row) return no('no catalogue row has this id any more');
  if (row.imageUrl) return no('the row already carries a photo, and a verified photo is never overwritten');

  /* the row still MEANS what it meant. Discovery found a listing to
     represent "Tailored Wool Coat" by Halden; a row renamed since is a
     row that listing was never held against. */
  const was = entry.row || {};
  for (const field of ['name', 'brand', 'category']) {
    const now = row[field] === undefined || row[field] === null ? '' : String(row[field]);
    const then = was[field] === undefined || was[field] === null ? '' : String(was[field]);
    if (now !== then) {
      return no(`the row's ${field} has changed since the run — it was "${then}" and is now "${now}"`);
    }
  }

  /* the soundness gate, run again on both URLs */
  const listing = soundness(entry.productUrl, entry.productUrl);
  if (listing) return no(`its listing is not sound: ${listing}`);
  const photo = soundness(entry.imageUrl, entry.productUrl);
  if (photo) return no(`its photo is not sound: ${photo}`);

  /* canonical evidence stood for a product page, and the listing as the
     run titled it has to still read as one: an article that declared
     itself canonical proved nothing about any product */
  if (entry.identity && entry.identity.via === 'canonical') {
    const shape = listingShape(entry.productUrl, entry.listingName || '');
    if (NOT_PRODUCT_SHAPES.has(shape.kind)) {
      return no(`its canonical evidence is for a page that is not a product page — ${shape.why}`);
    }
  }

  /* the note the file will carry has to be the one this finding
     produces. A report edited on one side and not the other no longer
     says what was proved, whichever side was edited. */
  const note = evidenceNote(entry.identity) || null;
  const recorded = entry.imageEvidence === undefined ? null : entry.imageEvidence;
  if (note !== recorded) return no('its recorded evidence is not what its identity finding produces');

  /* and the tie itself, re-proved rather than trusted: the same test a
     shipped row answers to --coverage, asked before it is shipped */
  const accounted = catalogRowIdentity({
    id: entry.id,
    name: row.name,
    brand: row.brand,
    category: row.category,
    productUrl: entry.productUrl,
    imageUrl: entry.imageUrl,
    imageEvidence: entry.identity
  });
  if (!accounted.ok) return no(accounted.why);

  /* the semantic gate's title stage needs no page, so it is asked again
     in full rather than taken from the record */
  if (!entry.listingName) return no('it records no listing title, so what it sells cannot be checked again');
  const verdict = semanticMatch(row, { title: entry.listingName });
  if (!verdict.ok) return no(`its listing is not the garment the row means: ${verdict.why}`);

  /* the page stage cannot be asked again from here, so what the page
     established has to be on the record — and it has to cover every
     descriptor the title still leaves pending. Nothing waives this. */
  const pending = verdict.pending || [];
  if (pending.length) {
    const proved = new Set((entry.provedOnPage || [])
      .filter((one) => one && one.name)
      .map((one) => `${one.kind}:${one.name}`));
    const missing = pending
      .filter((item) => !proved.has(`${item && item.kind}:${nameOfPending(item)}`))
      .map(nameOfPending);
    if (missing.length) {
      return no(`its page was never recorded as establishing ${missing.join(', ')}`);
    }
  }

  if (taken.has(entry.imageUrl)) return no(`its photo is already on ${taken.get(entry.imageUrl)}`);

  return { ok: true, how: accounted.how || verdict.why, needsLive: Boolean(accounted.needsLive) };
}

/* --write, where a --discover run has already proved something. Returns
   false only when there is no report at all, which is the one case where
   --discover --write still means "go and find out". Every other outcome
   is decided here, and none of them contacts a retailer. */
async function applySavedReport() {
  const loaded = loadReport(reportFile);

  if (loaded.missing) {
    console.log(`\nNo discovery report at ${rel(reportFile)}, so there is nothing saved to apply.`);
    console.log('Discovering now, and what clears every gate will be written down there.');
    return false;
  }

  /* Never a silent re-run. A report that cannot be trusted is refused
     here and the catalogue is left alone; making a fresh one costs a
     live search, and that is the operator's call rather than a thing
     this script does to them because a file was out of date. */
  if (loaded.unusable) {
    throw new Error(`${loaded.why}.\n  Nothing was written. Re-run --discover to make a fresh report.`);
  }

  const report = loaded.report;
  if (report.appliedAt) {
    console.log(`\nThe discovery report at ${rel(reportFile)} was already written into assets/catalog.js`);
    console.log(`at ${report.appliedAt}, so there is nothing to apply and nothing was searched.`);
    console.log('Re-run --discover to look for the rows that still carry no photo.\n');
    return true;
  }

  const { source, rows } = readCatalog();
  let entries = report.entries;
  if (only) entries = entries.filter((entry) => entry && entry.id === only);

  if (!entries.length) {
    console.log(only
      ? `\nThe discovery report at ${rel(reportFile)} records nothing for ${only}.\n`
      : `\nThe discovery report at ${rel(reportFile)} records no verified row.\n`);
    return true;
  }

  const onPage = entries.filter((entry) => entry && entry.identity && entry.identity.via === 'product-record' && entry.identity.source === 'embedded-react-router').length;
  console.log(`\nApplying ${entries.length} verified row${entries.length === 1 ? '' : 's'} from ${rel(reportFile)},`);
  console.log(`proved by the --discover run of ${report.createdAt}.`);
  if (onPage) {
    console.log('Nothing is searched: every gate that can be decided without a retailer is');
    console.log(`decided again here, and ${onPage} row${onPage === 1 ? ' whose photo was' : 's whose photos were'} vouched for by the page's own product`);
    console.log(`record ${onPage === 1 ? 'has its page' : 'have their pages'} read again — the note alone is never believed.\n`);
  } else {
    console.log('Nothing is searched, fetched or rendered: every gate that can be decided');
    console.log('without a retailer is decided again here, and the rest is on the record.\n');
  }

  /* no two rows wearing one picture, counting the ones already in the
     file as well as the ones this run is about to put there */
  const taken = new Map();
  for (const row of rows) if (row && row.imageUrl) taken.set(row.imageUrl, row.id);

  const usable = [];
  const refused = [];
  for (const entry of entries) {
    const id = (entry && entry.id) || '(no id)';
    let checked = replayable(entry, rows, taken);
    if (checked.ok && checked.needsLive) {
      const row = rows.find((one) => one && one.id === entry.id) || {};
      const live = await reproveEmbeddedRecord({
        id: entry.id,
        name: row.name,
        brand: row.brand,
        category: row.category,
        productUrl: entry.productUrl,
        imageUrl: entry.imageUrl,
        imageEvidence: entry.identity
      });
      checked = live.ok ? { ok: true, how: live.how } : live;
    }
    if (!checked.ok) {
      refused.push({ id, why: checked.why });
      console.log(`  ${'REFUSED'.padEnd(10)} ${id} — ${checked.why}`);
      console.log(`  ${''.padEnd(10)} the row is left as it was, and the others are unaffected`);
      console.log('');
      continue;
    }
    taken.set(entry.imageUrl, entry.id);
    usable.push(entry);
    console.log(`  ${'VERIFIED'.padEnd(10)} ${id} — ${checked.how}`);
    console.log(`  ${''.padEnd(10)} productUrl    ${short(entry.productUrl)}`);
    console.log(`  ${''.padEnd(10)} imageUrl      ${short(entry.imageUrl)}`);
    console.log(`  ${''.padEnd(10)} imageEvidence ${entry.imageEvidence || '(none needed — the URL carries the listing\'s code)'}`);
    console.log('');
  }

  if (!usable.length) {
    console.log('  Nothing in the report survived re-checking, so assets/catalog.js is left exactly as it was.\n');
    return true;
  }

  let next = source;
  for (const entry of usable) {
    next = linkRow(next, entry.id, {
      productUrl: entry.productUrl,
      imageUrl: entry.imageUrl,
      identity: entry.identity
    });
  }
  fs.writeFileSync(CATALOG, next);
  const already = Array.isArray(report.applied) ? report.applied : [];
  markApplied(reportFile, report, [...new Set([...already, ...usable.map((entry) => entry.id)])], !only);

  console.log(onPage
    ? `  Wrote ${usable.length} row${usable.length === 1 ? '' : 's'} into assets/catalog.js, searching nothing.`
    : `  Wrote ${usable.length} row${usable.length === 1 ? '' : 's'} into assets/catalog.js without contacting a retailer.`);
  if (refused.length) {
    console.log(`  ${refused.length} row${refused.length === 1 ? ' was' : 's were'} refused and left exactly as ${refused.length === 1 ? 'it was' : 'they were'}.`);
  }
  printCoverage(await coverageLive(readCatalog().rows));
  return true;
}

/* ---------- report ---------- */
async function main() {
  if (parsedArgs.errors.length) {
    for (const problem of parsedArgs.errors) console.error(`  ${problem}`);
    console.error(USAGE);
    throw new Error('nothing was run: the command line was not understood');
  }

  if (has('--help')) {
    console.log(USAGE);
    return;
  }

  /* --coverage : what the catalogue carries, without reading anything */
  if (has('--coverage')) {
    printCoverage(await coverageLive(readCatalog().rows));
    return;
  }

  /* --discover : find a real listing for every row that has no photo.
     A row that already carries one is never touched here — that is what
     keeps a verified photo verified. */
  if (has('--discover')) {
    /* The expensive half is the searching, and --write no longer pays
       for it. What the last --discover proved is on file, so this puts
       that into the catalogue and contacts nobody. It comes back false
       only when there is no report at all, and then this falls through
       to a live run exactly as it always did. */
    if (writing && await applySavedReport()) return;

    const { source, rows } = readCatalog();
    let targets = rows.filter((row) => row && !row.imageUrl);
    if (only) targets = targets.filter((row) => row.id === only);

    const kept = rows.filter((row) => row && row.imageUrl);
    const limit = Number(flag('--limit')) > 0 ? Number(flag('--limit')) : 8;

    console.log(`\nLooking for a real listing for ${targets.length} row${targets.length === 1 ? ' that carries' : 's that carry'} no photo.`);
    console.log(`${kept.length} row${kept.length === 1 ? '' : 's'} already carry one and are not touched.`);
    console.log(`Up to ${limit} listings are offered per row. Each is read as a garment first`);
    console.log('and only a listing that is the garment the row means has its page fetched.');
    console.log('A word the row states that the title does not is looked for on the page,');
    console.log('and a candidate passes only once every one of them is established.\n');
    console.log('A written row keeps its own id, name, brand, price and metadata.');
    console.log('Discovery fills productUrl, imageUrl and imageEvidence, and nothing else.\n');

    /* every photo already in use, so no two rows end up wearing the
       same picture */
    const taken = new Map();
    for (const row of kept) taken.set(row.imageUrl, row.id);

    const found = [];
    const broken = [];
    for (const row of targets) {
      /* The same rule one level up. discoverRow already contains a
         candidate's failure; this contains a row's — including a
         failure in the REPORTING, which is what a run was lost to once:
         a line of console.log reading a field off the wrong shape
         killed twenty-two rows that had nothing wrong with them. */
      try {
        await discoverOneRow(row);
      } catch (err) {
        const said = err && err.message ? String(err.message).split('\n')[0] : String(err);
        broken.push({ id: row.id, why: said });
        console.log(`  ${'ROW FAILED'.padEnd(17)} ${row.id} — ${said}`);
        console.log(`  ${''.padEnd(17)} the other rows are unaffected and the run continues`);
        console.log('');
      }
    }

    async function discoverOneRow(row) {
      /* a clock per row, not per run: a row that spends all of it is
         reported and the next one starts with a full one */
      const started = Date.now();
      const result = await discoverRow(row, taken, limit, { budget: budgetOf(ROW_BUDGET) });
      const took = Math.round((Date.now() - started) / 100) / 10;
      console.log(`  ${result.verdict.padEnd(17)} ${row.id} — wants "${row.name}" [${took}s]`);

      /* which ways the source was asked, and what each one came back
         with: a row that found nothing should say whether it was the
         query or the shops */
      for (const attempt of result.attempts || []) {
        const asked = attempt.query === null ? 'everything the row knows' : `"${attempt.query}"`;
        const who = attempt.provider ? ` [${attempt.provider}]` : '';
        console.log(`  ${''.padEnd(17)}   asked ${asked}${who} — ${attempt.failed ? `FAILED: ${attempt.failed}` : `${attempt.offered} offered`}`);
        /* what the source actually sent, in the adapter's own words:
           "40 offered" and nothing shown is not a diagnosis */
        if (attempt.diagnostics) {
          const d = attempt.diagnostics;
          const counted = ['withInlineLink', 'googleLinkedOnly', 'unlinked']
            .filter((key) => typeof d[key] === 'number')
            .map((key) => `${d[key]} ${key}`)
            .join(', ');
          if (counted) console.log(`  ${''.padEnd(17)}     ${counted}`);
          if (Array.isArray(d.urlFieldsSeen)) {
            console.log(`  ${''.padEnd(17)}     urls arrived under: ${d.urlFieldsSeen.join(', ') || '(no url-valued field at all)'}`);
          }
        }
        /* the second endpoint, when the first carried no retailer link */
        if (attempt.escalated) {
          const e = attempt.escalated;
          console.log(`  ${''.padEnd(17)}     ${e.asked === 'directly' ? 'asked the organic endpoint directly' : 'no retailer link in that batch — asked the organic endpoint'}`
            + ` — ${e.failed ? `FAILED: ${e.failed}` : `${e.offered} offered`}`);
          if (e.diagnostics && Array.isArray(e.diagnostics.urlFieldsSeen)) {
            console.log(`  ${''.padEnd(17)}       organic urls under: ${e.diagnostics.urlFieldsSeen.join(', ') || '(none)'}`);
          }
        }
        if (attempt.fellBackTo) {
          console.log(`  ${''.padEnd(17)}     out of searches — falling back to ${attempt.fellBackTo}, same gates, nothing relaxed`);
        }
      }

      /* every candidate, with the semantic gate's verdict on it, because
         a gate whose reasoning is invisible cannot be corrected */
      for (const attempt of result.tried || []) {
        const verdict = attempt.semantic || { ok: false, kind: 'error', why: 'no verdict was recorded for this candidate' };
        const stamp = verdict.ok
          ? `title  PASSED${verdict.kind === 'pending' ? ' (pending on the page)' : ''}`
          : `title  REFUSED (${verdict.kind === 'unreadable' ? 'unreadable' : verdict.kind === 'error' ? 'could not be read' : 'wrong garment'})`;
        console.log(`  ${''.padEnd(17)}   "${String(attempt.title || '(untitled)').slice(0, 64)}"${attempt.shape ? ` [${attempt.shape}]` : ''}`);
        if (attempt.foundOn) console.log(`  ${''.padEnd(17)}     listed in the page data of ${short(attempt.foundOn, 70)}`);
        if (attempt.productLinks) {
          const n = attempt.productLinks.length;
          console.log(`  ${''.padEnd(17)}     ${n ? `its page data listed ${n} product page${n === 1 ? '' : 's'} of its own, tried below` : 'its page data listed no product page that could be offered'}`);
          if (!n) for (const line of tileLines(attempt.tileReport).slice(0, 4)) console.log(`  ${''.padEnd(17)}       ${line}`);
        }
        console.log(`  ${''.padEnd(17)}     ${stamp} — ${verdict.why}`);
        if (attempt.failed) {
          console.log(`  ${''.padEnd(17)}     CANDIDATE FAILED — ${attempt.failed}`);
          console.log(`  ${''.padEnd(17)}     the remaining candidates for this row were still tried`);
        }
        if (attempt.onPage) {
          console.log(`  ${''.padEnd(17)}     page name — ${attempt.onPage.ok ? 'PASSED' : 'REFUSED'}: ${attempt.onPage.why}`);
        }
        if (attempt.proof) {
          for (const one of attempt.proof.proved) {
            console.log(`  ${''.padEnd(17)}     page   PROVED ${nameOfPending(one.item)} — ${one.where}: "${one.quote}"`);
          }
          /* proved entries are {item, where, quote}; missing entries are
             the pending items themselves. Reading .item off one of
             those is what aborted a whole run mid-report. */
          for (const one of attempt.proof.missing) {
            console.log(`  ${''.padEnd(17)}     page   UNPROVEN ${nameOfPending(one)} — nothing on the page says it`);
          }
        }
        if (verdict.ok) {
          console.log(`  ${''.padEnd(17)}     ${short(attempt.url, 70)}`);
          console.log(`  ${''.padEnd(17)}     ${attempt.verified ? 'photo verified' : 'no photo'} — ${attempt.why}`);
          /* diagnostics */
          if (diagnosing && attempt.imageDiagnosis && !attempt.verified) printImageDiagnosis(23, attempt.imageDiagnosis);
        }
      }

      if (result.proposal) {
        taken.set(result.proposal.imageUrl, row.id);
        found.push(result);
        const note = evidenceNote(result.proposal.identity);
        console.log(`  ${''.padEnd(17)} the shop calls it ${result.proposal.listingBrand || '(no brand named)'} — ${String(result.proposal.listingName || '').slice(0, 52)}`);
        console.log(`  ${''.padEnd(17)} the row keeps its own: ${row.brand} — ${row.name}`);
        console.log(`  ${''.padEnd(17)} productUrl    ${short(result.proposal.productUrl)}`);
        console.log(`  ${''.padEnd(17)} imageUrl      ${short(result.proposal.imageUrl)}`);
        console.log(`  ${''.padEnd(17)} imageEvidence ${note || '(none needed — the URL carries the listing\'s code)'}`);
        for (const one of result.provedOnPage || []) {
          console.log(`  ${''.padEnd(17)} proved on the page: ${nameOfPending(one.item)} — ${one.where}`);
        }
        console.log(`  ${''.padEnd(17)} ${result.why}`);
      } else {
        console.log(`  ${''.padEnd(17)} ${result.why}`);
      }
      console.log('');
    }

    console.log(`  ${found.length} of ${targets.length} row${targets.length === 1 ? '' : 's'} found a listing that cleared every gate.`);
    if (broken.length) {
      console.log(`  ${broken.length} row${broken.length === 1 ? '' : 's'} could not be read at all, and did not stop the rest:`);
      for (const one of broken) console.log(`     ${one.id} — ${one.why}`);
    }

    /* diagnostics */
    if (diagnosing) {
      console.log('');
      printDiagnosisRollup();
      const written = writeDiagnosisFile();
      console.log(`  Every refusal, with its gate and source, is in ${rel(written.file)}.\n`);
    }

    /* What this run proved, written down beside the catalogue, so that
       putting it into the file never costs the search a second time.
       Only the rows that cleared every gate go in. */
    const record = reportFrom(found, rows, { limit, only: only || null, site });
    if (found.length) {
      saveReport(reportFile, record);
      console.log(`  Saved ${found.length} verified row${found.length === 1 ? '' : 's'} to ${rel(reportFile)}.`);
    }

    if (!writing) {
      console.log(found.length
        ? `  Re-run with --write to put ${found.length} of them into assets/catalog.js — it reads that report and searches nothing.\n`
        : '  Nothing verified, so there is nothing to write.\n');
      return;
    }
    if (!found.length) {
      console.log('  Nothing verified — assets/catalog.js is left exactly as it was.\n');
      return;
    }

    let next = source;
    for (const result of found) next = linkRow(next, result.id, result.proposal);
    fs.writeFileSync(CATALOG, next);
    /* discovered and written in the one run: the report is marked spent
       here too, so a repeat of this command reads "already applied"
       rather than going out and searching all over again */
    markApplied(reportFile, record, found.map((result) => result.id));
    console.log(`  Wrote ${found.length} row${found.length === 1 ? '' : 's'} into assets/catalog.js.\n`);
    printCoverage(await coverageLive(readCatalog().rows));
    return;
  }

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

  /* This mode reads the pages rows already link to; a discovery report
     belongs to --discover --write. Said once here so a saved run is not
     quietly forgotten about, and nothing is applied on its behalf. */
  if (writing) {
    const waiting = loadReport(reportFile);
    if (waiting.report && !waiting.report.appliedAt && waiting.report.entries.length) {
      console.log(`\n  Note: ${rel(reportFile)} holds ${waiting.report.entries.length} verified row${waiting.report.entries.length === 1 ? '' : 's'} from a --discover run.`);
      console.log('  Run --discover --write to apply them. This mode reads the pages rows already link to.');
    }
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
    const result = await resolveRow(row, undefined, { catalogRow: row });
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
    replaceRow, linkRow, setField, indentOf, factsFromHtml, factsFromRendered, inspectCandidate,
    catalogRowIdentity, evidenceNote,
    /* a Shopify store's own product record, as identity evidence */
    shopifyHandle, recordImages, recordImageHost, productRecordFor, productRecordEvidence, shopifyCollection, collectionTiles,
    reactRouterProducts, embeddedRecordFrom, reproveEmbeddedRecord, coverageLive, browserRecordListing,
    /* whether a page is a product page, for the canonical rule */
    pageDeclarations, pageDeclarationsFromHtml, productPageVerdict,
    garmentsAgree, canonicalCorroborated, wordsInPath, wordsAboutImage, TRACKING_PARAMS,
    siteAsset, imageDimensions, listingShape, rankListings, embeddedProductTiles, listingProductLinks, tilesFromHtml, tilesOffered, productKey, tileReport, tileLines,
    parseArgs, OPTIONS, USAGE, intentFor, queryForms, listingsFor, discoverRow, coverage,
    providerChain, outOfSearches,
    /* the hand-off between the expensive half and the cheap one: what a
       run writes down, and every gate an entry answers on the way back
       in before a single field is written */
    reportFrom, saveReport, loadReport, markApplied, replayable,
    DEFAULT_REPORT, REPORT_VERSION, REPORT_TTL_MS,
    /* the semantic gate: what the listing SELLS, asked before any page
       is fetched, and decidable with no retailer at all */
    semanticMatch, readGarment, adultSizing, GARMENT_TYPES, DESCRIPTORS, MATERIALS,
    /* the product-page stage: what a page may be read for, and what it
       settles of whatever the title left pending */
    evidenceFromHtml, evidenceFromRendered, proveOnPage, nameOfPending, FIBRE_WITHIN,
    /* the parts that are about reading a retailer's page rather than
       about images, so the price reader shares one definition of a
       listing's code, one cookie-wall list and one way in */
    BROWSER, fetchPage, jsonLdNodes, parseLdBlock, metaContent, skuOf,
    loadPlaywright, dismissConsent, coaxLazyImages, rowEndsAt,
    /* the ceilings, and the two things that keep a slow shop from
       becoming a slow run: a clock a row carries, and a few candidates
       read at once that still answer in the order they were ranked */
    budgetOf, raceInOrder, withCeiling, request, imageFetcherFor, registrable,
    TIMEOUT, IMAGE_TIMEOUT, SEARCH_TIMEOUT, RENDER_BUDGET, ROW_BUDGET, LANES,
    /* TEMPORARY diagnostics: reporting only */
    refusalCategory, evidenceSource, tallyRefusals, pageFactsFromHtml, likelyProductRefusals
  };
}
