/* =========================================================
   Fynd — reading a retailer's own listing page, for /api/search

   Serper's /shopping answers with Google's own Shopping cards: forty
   results a query, every link a google.com page, no retailer URL
   anywhere. The live benchmark put 1,292 of them to the gate and the
   gate refused every one as missing-product-url, which is right — a
   Google card is not a shop's listing, and nothing here changes that.

   Serper's /search answers the same query with ordinary web results,
   whose link IS the shop's own page — and with a title and nothing
   else. No price, no photo, no seller. The gate wants all of those
   from the source, and an organic result is not a source for any of
   them. The retailer's page is.

   Catalogue discovery already reads that page, and has gates for
   exactly this: scripts/fetch-catalog-images.js proves a photo is this
   product's, and scripts/fetch-catalog-prices.js proves a figure is
   this product's charged price. This module runs a listing through
   those gates, as they are, and does not decide anything itself:

     the link        the organic URL has already survived retailerUrl()
                     in the Serper adapter (Google's hosts refused, a
                     forwarder unwrapped to the destination it carries)
                     and must pass the gate's link rule. It is not read
                     when its ADDRESS alone says it is a forum, an
                     article or a category page (listingShape()); the
                     search result's title is no reason to skip a page,
                     only to read it later. The page is used only if it
                     was served from the shop the URL named — a redirect
                     to another site is refused.
     which product   the code in the listing's URL, when it has one.
                     When it has none — a Shopify /products/<handle>, a
                     descriptive slug — the page has to say, by
                     pageIdentity() in the image script: its canonical
                     address on this shop (which the gates then run on
                     and which is shown), that it is a product page, and
                     — where that address names no code either — which
                     ONE product record is its own. A page that cannot
                     is refused as no-identity; the gates below run on
                     what the page proved, never on nothing.
     the price       pricesFromHtml() + decide(), the price reader's own
                     four gates: an amount in a named currency, on an
                     offer whose record, or which itself, names THIS
                     listing's code — or that belongs to the one record
                     the page named as its own — that is the amount
                     charged, and failing closed when two figures both
                     claim it.
     the photo       candidatesFrom() + firstVerifiable(), the image
                     script's gates in their order: the host, the site-
                     asset rule, identity (the listing's code in the
                     image URL, the record's sku, or a canonical PRODUCT
                     page vouching for a photo of the same garment), and
                     loadable, plainly and with a Referer. On a code the
                     page proved, the record's sku is not accepted: the
                     code came off that record, so the photo has to carry
                     the code or pass the canonical rule instead.
     the title       the name of the product record the price came from,
                     so the name, the price and the photo answer to the
                     same product; the result's own title otherwise.
     the retailer    the name the site gives itself — og:site_name, its
                     JSON-LD WebSite or single Organization, the seller
                     on that same offer, its application-name. Never a
                     hostname, never a brand:
                     "shop.madewell.com" is a domain, not a shop's name.
     the brand       the product record's own brand, when it has one.

   What comes out is a raw record like any other adapter's, holding only
   what was established, and it goes to verifyAll() — the same gate,
   untouched, that every other live result goes through. A listing whose
   page gave no provable price is handed over without one and the gate
   drops it as missing-price; one with a price and no provable photo is
   dropped as missing-image-url. Running out of time is the same: a page
   not read is a record without a price. Nothing here fills a gap.

   A category page is never a result. It is read — last, and only a few
   per search — for the products it lists in its own data, each of which
   has to be the garment the shopper asked for by discovery's title gate
   and then proves itself on its own page like any other listing (see
   readCategory below).

   No page is rendered in a browser here. A page that refuses a plain
   request (most often a 403 from a bot check) is left unread: the
   browser path discovery has launches Chromium with automation hidden,
   which against a refusal is getting round an access control, and it
   does not run in the deployed function or fit the request's clock.

   The Shopify product-record path is NOT used. It holds the record's
   title against a catalogue row, and a live search has no row — holding
   it against the listing's own title would be the record vouching for
   itself. Those listings are left to the gates above.

   Everything runs on the request's clock: a few pages at once — those
   whose URL names a product first, then the rest, each tier in the
   engine's order — and whatever finishes inside the budget is what
   comes back, in the ENGINE's order, whatever order the pages were read
   or answered in.
   ========================================================= */

'use strict';

const { linkFault, toProduct } = require('./product-source');

/* How many listing pages one search may read, how many at once, and
   the least time worth starting one with. Each read is a page and then
   up to a few image checks, so this bounds what a single shopper's
   search can ask of retailers' servers. */
const MAX_PAGES = 20;
const PAGE_LANES = 6;
const MIN_PAGE_WINDOW_MS = 1000;
/* kept back from a page read for proving its photo afterwards */
const IMAGE_RESERVE_MS = 1500;
/* A category page is never a result, but the products it lists can be
   candidates: at most this many category pages read per search, and
   this many of each one's products offered — each read and proved on
   its own page like any other listing. */
const MAX_CATEGORY_PAGES = 3;
const MAX_TILES_PER_CATEGORY = 4;
/* kept back from the whole stage for the answer to leave the server */
const ANSWER_MARGIN_MS = 300;
/* when no deadline is given at all */
const DEFAULT_BUDGET_MS = 8000;

/* the listing shapes discovery says are never a product page, whatever
   they declare (productPageVerdict in scripts/fetch-catalog-images.js),
   each counted under its own name */
const NOT_A_PRODUCT_PAGE = { 'not-a-shop': 'not-a-shop', editorial: 'editorial-page', listing: 'category-page' };

/* Discovery's gates, loaded on first use. They live beside the scripts
   that run them on the catalogue; this is the same code, not a copy. */
let gates = null;
function discovery() {
  if (!gates) {
    gates = {
      images: require('../../scripts/fetch-catalog-images.js'),
      prices: require('../../scripts/fetch-catalog-prices.js')
    };
  }
  return gates;
}

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

const decodeEntities = (value) => text(value)
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch (err) { return null; }
}

/* The product record, and the offer, the decided price came from: the
   one whose sku the price gate matched, carrying that amount. */
function pricedRecord(candidates, decided, images, proven) {
  const sku = decided.identity && decided.identity.sku ? String(decided.identity.sku).toLowerCase() : null;
  /* the page's named record, only when it — not a matched sku — is what
     tied the price to this listing */
  const own = !sku && proven && proven.record ? new Set([proven.record].concat(proven.members || [])) : null;
  for (const candidate of candidates) {
    if (!candidate.node || candidate.amount !== decided.price) continue;
    if (own && !own.has(images.recordFingerprint(candidate.node)) && !(candidate.group && own.has(images.recordFingerprint(candidate.group)))) continue;
    if (!own && sku && !images.skuOf(candidate.node).concat(candidate.offer ? images.skuOf(candidate.offer) : []).includes(sku)) continue;
    /* a variant is named by its group when it has no name of its own */
    const node = candidate.group && !text(candidate.node.name) ? Object.assign({}, candidate.group, candidate.node, { name: candidate.group.name }) : candidate.node;
    return { node, offer: candidate.offer || null };
  }
  return { node: null, offer: null };
}

function brandOf(node) {
  const brand = node && node.brand;
  if (typeof brand === 'string') return text(brand);
  if (brand && typeof brand === 'object' && typeof brand.name === 'string') return text(brand.name);
  return '';
}

/* The name the SITE gives itself, wherever it says it: og:site_name,
   the JSON-LD WebSite's name, the one Organization or store the page
   describes, the application-name a browser shows. Every one is the
   shop naming itself; none is read off a hostname, and a brand is never
   one of them — a Brand record names the maker, not the shop. Several
   organisations naming different things say nothing. */
const SITE_TYPES = /^(website|organization|corporation|store|onlinestore|onlinebusiness|clothingstore|shoestore|departmentstore)$/i;

function siteNameOf(html, images) {
  const meta = decodeEntities(images.metaContent(html, 'og:site_name'));
  if (meta) return meta;
  const nodes = images.jsonLdNodes(html);
  const named = (pattern) => [...new Set(nodes
    .filter((node) => [].concat(node['@type'] || []).some((type) => pattern.test(String(type).replace(/^.*[/#]/, ''))))
    .map((node) => decodeEntities(typeof node.name === 'string' ? node.name : ''))
    .filter(Boolean))];
  const site = named(/^website$/i);
  if (site.length === 1) return site[0];
  const shop = named(SITE_TYPES);
  if (shop.length === 1) return shop[0];
  return '';
}

function appNameOf(html, images) {
  return decodeEntities(images.metaContent(html, 'application-name') || images.metaContent(html, 'apple-mobile-web-app-title'));
}

function sellerOf(offer) {
  const seller = offer && offer.seller;
  if (seller && typeof seller === 'object' && typeof seller.name === 'string') return text(seller.name);
  return '';
}

/* What can be decided about a listing without asking its shop: the
   gate's link rule, and whether the listing's ADDRESS says it is a
   forum, an article or a category page. Null when the page is worth
   reading.

   Only the address. The search result's title can make discovery call a
   code-less listing an article or a category ("…for Women | Shop",
   "best…"), and that is a guess about a page nobody has read yet — so
   such a listing stays pending and is read (after the likelier ones),
   and its own page decides. A listing with no product code in its URL
   stays pending too: its page may prove which product it is
   (pageIdentity in scripts/fetch-catalog-images.js). */
function precheck(record) {
  const { images } = discovery();
  const given = record && typeof record === 'object' ? record : {};
  const productUrl = text(given.productUrl);
  if (!productUrl) return { outcome: 'refused-link', why: 'no link' };
  const fault = linkFault(productUrl);
  if (fault) return { outcome: 'refused-link', why: fault };
  const shape = images.listingShape(productUrl, '');
  if (NOT_A_PRODUCT_PAGE[shape.kind]) return { outcome: NOT_A_PRODUCT_PAGE[shape.kind], why: shape.why };
  return null;
}

/* Why a page that was read proved no price, as one of the four answers a
   person investigating it would reach — read off the price reader's own
   refusals and off what the served page carries. It decides nothing: it
   is reported, so a benchmark run says which of these it was without
   anyone opening the page.

     1  no usable price     nothing in the served markup the reader
                            could ever take: no priced product record, a
                            record with no offers, or a price only in the
                            page's meta tags, which describe the PAGE
     2  reader gap          the page carries a price the reader does not
                            read: JSON-LD it could not parse, microdata,
                            or a framework's embedded state
     3  refused, rightly    two or more figures claim to be the price, or
                            only a range is published
     4  identity / variant  a priced record is there, but it names another
                            product, or nothing ties it to this listing, or
                            its figure is not marked as the amount charged */
const PRICE_CLASSES = {
  'no-price-in-served-markup': '1-no-usable-price',
  'record-publishes-no-offers': '1-no-usable-price',
  'price-only-in-page-metadata': '1-no-usable-price',
  'json-ld-not-readable': '2-reader-gap',
  'microdata-price-not-read': '2-reader-gap',
  'price-only-in-embedded-data': '2-reader-gap',
  'several-prices': '3-refused-rightly',
  'range-only': '3-refused-rightly',
  'record-names-another-product': '4-identity-or-variant',
  'record-not-tied-to-listing': '4-identity-or-variant',
  'not-the-amount-charged': '4-identity-or-variant'
};

function priceDiagnosis(html, read, decided, images) {
  if (decided.ambiguous) return 'several-prices';
  const refusals = decided.refusals || [];
  /* a structured offer or served microdata: both were READ, and what
     they came to is the reader's verdict, not a gap */
  const structured = read.candidates.filter((one) => one.node || (one.dom && one.dom.served));
  if (structured.length) {
    if (structured.every((one) => one.kind === 'range')) return 'range-only';
    const identity = refusals.filter((one) => one.gate === 'this' && /^(json-ld|microdata)/.test(String(one.from)));
    if (identity.length) {
      /* microdata that named its product scope's sku, and it was not
         this listing's, names another product as surely as JSON-LD does */
      const namedOther = structured.some((one) => one.dom && one.dom.served && (one.dom.scopeSkus || []).length);
      return namedOther || identity.some((one) => /names (a different|[^,]*, which is not this listing)/.test(one.why) && !/names no sku/.test(one.why))
        ? 'record-names-another-product' : 'record-not-tied-to-listing';
    }
    return 'not-the-amount-charged';
  }
  const page = String(html || '');
  const blocks = (page.match(/<script[^>]+type=["']application\/ld\+json["']/gi) || []).length;
  if (blocks && !images.jsonLdNodes(page).length) return 'json-ld-not-readable';
  if (/itemprop\s*=\s*["']?(price|lowPrice)["'\s>]/i.test(page)) return 'microdata-price-not-read';
  if (read.empties && read.empties.length) return 'record-publishes-no-offers';
  if (/["'](price|salePrice|currentPrice|finalPrice|priceValue)["']\s*:\s*["']?\$?\d/i.test(page)) return 'price-only-in-embedded-data';
  if (read.candidates.some((one) => one.kind === 'meta')) return 'price-only-in-page-metadata';
  return 'no-price-in-served-markup';
}

/* the outcomes of a page that was fetched and still proved nothing */
const READ_FAILURES = new Set(['unreadable', 'left-the-retailer', 'no-identity', 'no-price', 'no-photo']);

function reasonKey(why) {
  /* an HTTP status says what kind of refusal it was, so it is kept */
  const statuses = [];
  return text(why)
    .replace(/\b(answered|responded) (\d{3})\b/g, (all, verb, code) => `${verb} §${String.fromCharCode(97 + statuses.push(code) - 1)}§`)
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\([^)]*\)/g, '')
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/gi, '<host>')
    .replace(/[$£€]?\b[A-Za-z_-]*\d[\w.-]*/g, '#')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\s+/g, ' ')
    .replace(/§([a-z])§/g, (all, letter) => statuses[letter.charCodeAt(0) - 97])
    .trim()
    .slice(0, 110) || 'unstated';
}

/* Which listings are read first when the clock cannot cover them all:
   a URL that names its product, then a product-shaped address with no
   code, then the rest. This orders the READING only — what is shown
   keeps the engine's order, and a stable sort keeps the engine's order
   within each tier. */
function readTier(record) {
  const { images } = discovery();
  const productUrl = text(record && record.productUrl);
  if (images.identifiersFrom(productUrl).length) return 0;
  const shape = images.listingShape(productUrl, text(record && record.title));
  return shape.kind === 'product' ? 1 : 2;
}

/* One listing, read. Returns the record to put to the gate — the one it
   was given, or that one with what its own page proved — and what
   happened, as one word the diagnostics can count. */
async function readListing(record, budget) {
  const { images, prices } = discovery();
  const given = record && typeof record === 'object' ? record : {};
  const productUrl = text(given.productUrl);
  const title = text(given.title);
  const done = (outcome, why, out) => ({ record: out || given, outcome, why: why || null });

  const refused = precheck(given);
  if (refused) return done(refused.outcome, refused.why);
  if (budget.left() < MIN_PAGE_WINDOW_MS) return done('no-time', 'the search ran out of time before this page was read');

  /* ---- the page, from the shop it names ---- */
  const pageWindow = Math.max(MIN_PAGE_WINDOW_MS, budget.left() - IMAGE_RESERVE_MS);
  const page = await images.fetchPage(productUrl, budget.cap(Math.min(images.TIMEOUT, pageWindow)));
  if (!page.html) return done('unreadable', page.failed);

  const asked = hostOf(productUrl);
  const landed = hostOf(page.url || productUrl);
  if (!landed || images.registrable(landed) !== images.registrable(asked)) {
    return done('left-the-retailer', `the listing redirected from ${asked} to ${landed || 'nowhere readable'}`);
  }

  /* ---- which product, when the URL does not say ----

     The page's own canonical address, when it gives one on this shop,
     is the listing from here on: the gates run on it and it is what is
     shown. Where that address names no product either, the page's own
     product record is the identity the gates hold figures and photos
     to. */
  let listingUrl = productUrl;
  let proven = null;
  if (images.identifiersFrom(productUrl).length) {
    /* A coded listing is priced by its code. Its page is asked only which
       of its records is the product, for a record that names no
       identifier at all; a page that cannot say leaves the code to do
       all the work, exactly as before. */
    const own = images.pageIdentity(page.html, productUrl, page.url || productUrl, { coded: true });
    if (own.ok && own.record) proven = own;
  } else {
    const identity = images.pageIdentity(page.html, productUrl, page.url || productUrl);
    if (!identity.ok) return done('no-identity', identity.why);
    if (identity.url && identity.url !== productUrl) {
      const fault = linkFault(identity.url);
      if (fault) return done('no-identity', `the page's canonical address is refused by the link rule (${fault})`);
      listingUrl = identity.url;
    }
    if (!images.identifiersFrom(listingUrl).length) proven = identity;
  }

  /* ---- the price, by the price reader's gates ---- */
  const read = prices.pricesFromHtml(page.html);
  for (const candidate of read.candidates) candidate.canonical = read.canonical;
  const decided = read.candidates.length ? prices.decide(read.candidates, listingUrl, proven) : { refusals: [] };
  if (!decided.price) {
    const first = (decided.refusals || [])[0];
    const result = done('no-price', decided.why || (first ? `${first.from}: ${first.why}` : 'the page publishes no price candidate'));
    result.priceCategory = priceDiagnosis(page.html, read, decided, images);
    return result;
  }

  const { node, offer } = pricedRecord(read.candidates, decided, images, proven);
  /* the product the page named, by its own name: a group, not one size */
  const byRecord = !(decided.identity && decided.identity.sku);
  const name = (byRecord && text(proven && proven.name)) || text(node && node.name) || title;
  const retailer = siteNameOf(page.html, images) || sellerOf(offer) || appNameOf(page.html, images);
  const brand = brandOf(node);

  const priced = { title: decodeEntities(name), productUrl: listingUrl, price: decided.price, currency: decided.currency };
  if (retailer) priced.retailer = retailer;
  if (brand) priced.brand = brand;
  if (decided.identity && decided.identity.sku) priced.sku = String(decided.identity.sku);

  /* ---- the photo, by the image gates ---- */
  if (budget.spent()) return done('no-photo', 'the search ran out of time before the photo was checked', priced);
  const offered = images.candidatesFrom(page.html, page.url || productUrl);
  const row = { id: listingUrl, productUrl: listingUrl, name: priced.title, proven };
  const found = offered.length ? await images.firstVerifiable(offered, row, null, budget) : { refusals: [] };
  if (!found.url) {
    const first = (found.refusals || []).find(Boolean);
    return done('no-photo', first ? `${first.gate}: ${first.why}` : 'the page publishes no image candidate', priced);
  }

  /* the gate's own verdict on what was proved — reported, never acted
     on here: the record goes to verifyAll() exactly as it is */
  const proved = Object.assign({}, priced, { imageUrl: found.url });
  const result = done('photographed', found.why, proved);
  const verdict = toProduct(proved, { retailer: null });
  if (!verdict.ok) result.gateRefusal = verdict.reason;
  return result;
}

/* A category page, read only for the products it lists — never as a
   result. Discovery's own readers find them: the page's JSON-LD and
   framework data (tilesFromHtml), a Shopify collection's product list
   (collectionTiles), each kept only when it names its own product page
   on this shop, shaped like one product (listingProductLinks), and then
   only when its name is, by discovery's title gate, the garment the
   shopper asked for (tilesOffered, held to the shopper's own words
   instead of a catalogue row). A tile is a lead and nothing more: its
   own page has to prove the price, the product and the photo. */
async function readCategory(record, budget, query, known) {
  const { images } = discovery();
  const given = record && typeof record === 'object' ? record : {};
  const categoryUrl = text(given.productUrl);
  const done = (why, tiles) => ({ record: given, outcome: 'category-page', why, tiles: tiles || [] });
  if (!query) return done('no shopper phrase to hold its products to');
  if (budget.left() < MIN_PAGE_WINDOW_MS) return done('the search ran out of time before this page was read');

  const page = await images.fetchPage(categoryUrl, budget.cap(Math.min(images.TIMEOUT, Math.max(MIN_PAGE_WINDOW_MS, budget.left() - IMAGE_RESERVE_MS))));
  if (!page.html) return done(`not read: ${page.failed}`);
  const landedUrl = page.url || categoryUrl;
  if (images.registrable(hostOf(landedUrl) || '') !== images.registrable(hostOf(categoryUrl) || '')) return done('it redirected to another site');

  const stats = {};
  const tiles = images.tilesFromHtml(page.html, stats);
  if (images.shopifyCollection(landedUrl) && images.SHOPIFY_PAGE.test(page.html) && budget.left() >= MIN_PAGE_WINDOW_MS) {
    tiles.push(...await images.collectionTiles(landedUrl, images.request, budget.cap(Math.min(images.TIMEOUT, Math.max(MIN_PAGE_WINDOW_MS, budget.left() - IMAGE_RESERVE_MS))), stats));
  }
  const links = images.listingProductLinks(landedUrl, tiles, stats);
  const offered = images.tilesOffered({ id: 'query', name: query }, [{ url: landedUrl, productLinks: links }], known)
    .filter((one) => one.rank < 2)
    .slice(0, MAX_TILES_PER_CATEGORY)
    .map((one) => ({ title: one.title, productUrl: one.productUrl }));
  return done(`${links.length} product${links.length === 1 ? '' : 's'} listed, ${offered.length} the garment asked for`, offered);
}

/* Every listing, read a few at a time, likeliest first, and answered in
   the ENGINE's order: the organic listings as they came, then each
   category page's products, grouped by the category page they came from
   in the order it came. Stops starting new reads when the clock is nearly
   out, when MAX_PAGES have been started, or when as many listings have
   been photographed as the page can show. */
async function readListings(records, options) {
  const opts = options || {};
  const { images } = discovery();
  const list = Array.from(records || []);
  const deadline = Number(opts.deadline) || 0;
  const budget = images.budgetOf(deadline ? deadline - Date.now() - ANSWER_MARGIN_MS : DEFAULT_BUDGET_MS);
  const wanted = Math.max(1, Number(opts.limit) || 12);
  const query = text(opts.query);

  /* every listing, organic or from a category page, as one entry */
  const entries = list.map((record, at) => ({ record, from: at, seq: 0, tile: false }));
  const known = new Set(list.map((one) => images.productKey(one && one.productUrl)).filter(Boolean));
  /* the reading order: likeliest first, then the category pages; the
     engine's order within each tier */
  const tierOf = (entry) => {
    if (entry.tile) return readTier(entry.record);
    const refused = precheck(entry.record);
    if (refused) return refused.outcome === 'category-page' ? 4 : -1;
    return readTier(entry.record);
  };
  const byTier = (a, b) => a.tier - b.tier || a.entry.from - b.entry.from || a.entry.seq - b.entry.seq;
  let queue = entries.map((entry) => ({ entry, tier: tierOf(entry) })).sort(byTier);

  let started = 0;
  let categories = 0;
  let tilesOffered = 0;
  let photographed = 0;

  const lane = async () => {
    while (queue.length) {
      if (photographed >= wanted || budget.left() < MIN_PAGE_WINDOW_MS) return;
      const { entry } = queue.shift();
      const one = entry.record;
      /* a listing that will not be fetched costs no page and no wait */
      const refused = precheck(one);
      if (refused && !(refused.outcome === 'category-page' && !entry.tile)) { entry.result = Object.assign({ record: one }, refused); continue; }
      if (refused) {
        /* a category page, for its products only */
        if (!query || categories >= MAX_CATEGORY_PAGES || started >= MAX_PAGES) { entry.result = Object.assign({ record: one }, refused); continue; }
        categories += 1;
        started += 1;
        let read;
        try {
          read = await readCategory(one, budget, query, [...known].map((key) => ({ productUrl: `https://${key}` })));
        } catch (err) {
          read = { record: one, outcome: 'category-page', why: err && err.message ? String(err.message).split('\n')[0] : String(err), tiles: [] };
        }
        entry.result = { record: one, outcome: 'category-page', why: read.why };
        read.tiles.forEach((tile, seq) => {
          const key = images.productKey(tile.productUrl);
          if (!key || known.has(key)) return;
          known.add(key);
          tilesOffered += 1;
          const added = { record: tile, from: entry.from, seq: seq + 1, tile: true };
          entries.push(added);
          queue.push({ entry: added, tier: tierOf(added) });
        });
        queue = queue.sort(byTier);
        continue;
      }
      if (started >= MAX_PAGES) return;
      started += 1;
      try {
        entry.result = await readListing(one, budget);
      } catch (err) {
        entry.result = { record: one, outcome: 'unreadable', why: err && err.message ? String(err.message).split('\n')[0] : String(err) };
      }
      if (entry.result.outcome === 'photographed') photographed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_LANES, Math.max(1, entries.length)) }, lane));

  const outcomes = {};
  const reasons = {};
  const priceCategories = {};
  const gateRefusals = {};
  const ordered = entries.filter((entry) => !entry.tile).concat(
    entries.filter((entry) => entry.tile).sort((a, b) => a.from - b.from || a.seq - b.seq)
  );
  const out = ordered.map((entry) => {
    const result = entry.result || { record: entry.record, outcome: 'not-reached' };
    const outcome = entry.tile ? `tile:${result.outcome}` : result.outcome;
    outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    if (result.priceCategory) priceCategories[result.priceCategory] = (priceCategories[result.priceCategory] || 0) + 1;
    if (result.gateRefusal) gateRefusals[result.gateRefusal] = (gateRefusals[result.gateRefusal] || 0) + 1;
    if (READ_FAILURES.has(result.outcome)) {
      const group = reasons[result.outcome] || (reasons[result.outcome] = {});
      const why = reasonKey(result.why);
      group[why] = (group[why] || 0) + 1;
    }
    entry.final = result;
    return result.record;
  });

  return {
    records: out,
    diagnostics: {
      offered: list.length,
      pagesRead: started,
      categoryPagesRead: categories,
      tilesOffered,
      outcomes,
      /* why each page that WAS read proved nothing, grouped: which gate,
         in its own words, with codes, figures, hosts and URLs taken out
         so the same reason counts as one across listings */
      reasons,
      /* each no-price page, by which of the four answers it was */
      priceCategories,
      /* listings whose page proved a price and a photo and that the gate
         still refused, by the gate's own reason */
      gateRefusals,
      samples: ordered.map((entry) => entry.final).filter((one) => one && READ_FAILURES.has(one.outcome)).slice(0, 8)
        .map((one) => Object.assign({ host: hostOf(one.record && one.record.productUrl), outcome: one.outcome, why: text(one.why).slice(0, 160) },
          one.priceCategory ? { priceCategory: one.priceCategory, priceClass: PRICE_CLASSES[one.priceCategory] } : {}))
    }
  };
}

module.exports = {
  priceDiagnosis,
  PRICE_CLASSES,
  precheck,
  readCategory,
  readTier,
  reasonKey,
  readListing,
  readListings,
  MAX_PAGES,
  PAGE_LANES,
  MIN_PAGE_WINDOW_MS,
  NOT_A_PRODUCT_PAGE
};
