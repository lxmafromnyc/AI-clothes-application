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
                     descriptive slug — the page has to say: canonical
                     for this listing, a product page, one product
                     record, naming a code (pageIdentity() in the image
                     script). A page that cannot is refused as
                     no-identity, and the gates below run on the code
                     the page proved, never on nothing.
     the price       pricesFromHtml() + decide(), the price reader's own
                     four gates: an amount in a named currency, on an
                     offer whose record, or which itself, names THIS
                     listing's code, that is the amount charged — and
                     failing closed when two figures both claim it.
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
     the retailer    the name the site gives itself (og:site_name), or
                     the seller on that same offer. Never a hostname:
                     "shop.madewell.com" is a domain, not a shop's name.
     the brand       the product record's own brand, when it has one.

   What comes out is a raw record like any other adapter's, holding only
   what was established, and it goes to verifyAll() — the same gate,
   untouched, that every other live result goes through. A listing whose
   page gave no provable price is handed over without one and the gate
   drops it as missing-price; one with a price and no provable photo is
   dropped as missing-image-url. Running out of time is the same: a page
   not read is a record without a price. Nothing here fills a gap.

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

const { linkFault } = require('./product-source');

/* How many listing pages one search may read, how many at once, and
   the least time worth starting one with. Each read is a page and then
   up to a few image checks, so this bounds what a single shopper's
   search can ask of retailers' servers. */
const MAX_PAGES = 20;
const PAGE_LANES = 6;
const MIN_PAGE_WINDOW_MS = 1000;
/* kept back from a page read for proving its photo afterwards */
const IMAGE_RESERVE_MS = 1500;
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
function pricedRecord(candidates, decided, skuOf) {
  const sku = decided.identity && decided.identity.sku ? String(decided.identity.sku).toLowerCase() : null;
  for (const candidate of candidates) {
    if (!candidate.node || candidate.amount !== decided.price) continue;
    if (sku && !skuOf(candidate.node).concat(candidate.offer ? skuOf(candidate.offer) : []).includes(sku)) continue;
    return { node: candidate.node, offer: candidate.offer || null };
  }
  return { node: null, offer: null };
}

function brandOf(node) {
  const brand = node && node.brand;
  if (typeof brand === 'string') return text(brand);
  if (brand && typeof brand === 'object' && typeof brand.name === 'string') return text(brand.name);
  return '';
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

  /* ---- which product, when the URL does not say ---- */
  let proven = null;
  if (!images.identifiersFrom(productUrl).length) {
    const identity = images.pageIdentity(page.html, productUrl, page.url || productUrl);
    if (!identity.ok) return done('no-identity', identity.why);
    proven = identity;
  }

  /* ---- the price, by the price reader's gates ---- */
  const read = prices.pricesFromHtml(page.html);
  for (const candidate of read.candidates) candidate.canonical = read.canonical;
  const decided = read.candidates.length ? prices.decide(read.candidates, productUrl, proven) : { refusals: [] };
  if (!decided.price) {
    const first = (decided.refusals || [])[0];
    return done('no-price', decided.why || (first ? `${first.from}: ${first.why}` : 'the page publishes no price candidate'));
  }

  const { node, offer } = pricedRecord(read.candidates, decided, images.skuOf);
  const name = text(node && node.name) || title;
  const retailer = decodeEntities(images.metaContent(page.html, 'og:site_name')) || sellerOf(offer);
  const brand = brandOf(node);

  const priced = { title: decodeEntities(name), productUrl, price: decided.price, currency: decided.currency };
  if (retailer) priced.retailer = retailer;
  if (brand) priced.brand = brand;
  if (decided.identity && decided.identity.sku) priced.sku = String(decided.identity.sku);

  /* ---- the photo, by the image gates ---- */
  if (budget.spent()) return done('no-photo', 'the search ran out of time before the photo was checked', priced);
  const offered = images.candidatesFrom(page.html, productUrl);
  const row = { id: productUrl, productUrl, name: priced.title, proven };
  const found = offered.length ? await images.firstVerifiable(offered, row, null, budget) : { refusals: [] };
  if (!found.url) {
    const first = (found.refusals || []).find(Boolean);
    return done('no-photo', first ? `${first.gate}: ${first.why}` : 'the page publishes no image candidate', priced);
  }

  return done('photographed', found.why, Object.assign({}, priced, { imageUrl: found.url }));
}

/* Every listing, read a few at a time, in the order given and answered
   in that order. Stops starting new reads when the clock is nearly out,
   when MAX_PAGES have been started, or when as many listings have been
   photographed as the page can show. */
async function readListings(records, options) {
  const opts = options || {};
  const { images } = discovery();
  const list = Array.from(records || []);
  const deadline = Number(opts.deadline) || 0;
  const budget = images.budgetOf(deadline ? deadline - Date.now() - ANSWER_MARGIN_MS : DEFAULT_BUDGET_MS);
  const wanted = Math.max(1, Number(opts.limit) || 12);

  const results = new Array(list.length);
  const order = list.map((one, at) => ({ at, tier: readTier(one) })).sort((a, b) => a.tier - b.tier || a.at - b.at).map((one) => one.at);
  let next = 0;
  let started = 0;
  let photographed = 0;

  const lane = async () => {
    while (next < order.length) {
      if (photographed >= wanted || budget.left() < MIN_PAGE_WINDOW_MS) return;
      const at = order[next];
      next += 1;
      const one = list[at];
      /* a listing that will not be fetched costs no page and no wait */
      const refused = precheck(one);
      if (refused) { results[at] = Object.assign({ record: one }, refused); continue; }
      if (started >= MAX_PAGES) return;
      started += 1;
      try {
        results[at] = await readListing(one, budget);
      } catch (err) {
        results[at] = { record: one, outcome: 'unreadable', why: err && err.message ? String(err.message).split('\n')[0] : String(err) };
      }
      if (results[at].outcome === 'photographed') photographed += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_LANES, list.length) }, lane));

  const outcomes = {};
  const reasons = {};
  const out = list.map((one, at) => {
    const result = results[at] || { record: one, outcome: 'not-reached' };
    outcomes[result.outcome] = (outcomes[result.outcome] || 0) + 1;
    if (READ_FAILURES.has(result.outcome)) {
      const group = reasons[result.outcome] || (reasons[result.outcome] = {});
      const why = reasonKey(result.why);
      group[why] = (group[why] || 0) + 1;
    }
    return result.record;
  });

  return {
    records: out,
    diagnostics: {
      offered: list.length,
      pagesRead: started,
      outcomes,
      /* the first few refusals, by outcome and reason, so a search that
         proved nothing says which gate stopped it — never a record's
         contents beyond its host */
      /* why each page that WAS read proved nothing, grouped: which gate,
         in its own words, with codes, figures, hosts and URLs taken out
         so the same reason counts as one across listings */
      reasons,
      samples: results.filter((one) => one && READ_FAILURES.has(one.outcome)).slice(0, 8)
        .map((one) => ({ host: hostOf(one.record && one.record.productUrl), outcome: one.outcome, why: text(one.why).slice(0, 160) }))
    }
  };
}

module.exports = {
  precheck,
  readTier,
  reasonKey,
  readListing,
  readListings,
  MAX_PAGES,
  PAGE_LANES,
  MIN_PAGE_WINDOW_MS,
  NOT_A_PRODUCT_PAGE
};
