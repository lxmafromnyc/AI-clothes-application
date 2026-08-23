/* =========================================================
   Fynd — Etsy product source

   Searches active Etsy listings through the Open API v3 and returns them
   in the shape api/providers/product-source.js verifies.

   ---------------------------------------------------------
   Field mapping, from the Open API v3 models
   ---------------------------------------------------------
     ShopListingWithAssociations
       title        -> title        the listing's own title, unmodified
       url          -> productUrl   "The full URL to the listing's page on
                                     Etsy" — the exact listing, not a search
       price        -> price        Money: amount / divisor
       images[]     -> imageUrl     ListingImage.url_570xN, taken from the
                                     SAME listing object
       shop         -> brand        Shop.shop_name, the maker
       quantity,
       state        -> availability

   The image correspondence this project requires is structural here: the
   `includes=Images` association nests each listing's own images inside
   that listing, so the photo cannot belong to a different product. If a
   listing arrives without images, no image is substituted from anywhere —
   the record is left without one and the gate drops it.

   ---------------------------------------------------------
   Credentials
   ---------------------------------------------------------
     ETSY_API_KEY       required. Sent as the x-api-key header. This is the
                        app keystring, and it authenticates the public,
                        app-level endpoints this adapter uses.
     ETSY_SHARED_SECRET deliberately NOT used. It exists for the OAuth 2.0
                        authorization-code flow, which is only needed for
                        endpoints acting on behalf of a signed-in Etsy user.
                        Searching public listings needs no user context, so
                        the secret is never read and never transmitted.

   Both live in the server environment. Neither reaches a browser: this
   file runs only inside the serverless function.
   ========================================================= */

'use strict';

const API_ROOT = 'https://openapi.etsy.com/v3/application';
const LISTINGS_ACTIVE = `${API_ROOT}/listings/active`;
const REQUEST_TIMEOUT = 12000;
const MAX_KEYWORDS = 12;

/* Etsy listing URLs live on etsy.com. Anything else in the url field means
   a malformed response, and a link we should not present as the product. */
const ETSY_HOST = /(^|\.)etsy\.com$/i;

/* Builds the keyword string from the interpreted intent. Only terms the
   shopper's request actually produced are used; nothing is added. */
function keywordsFrom(intent) {
  const parts = []
    .concat(intent.categories || [])
    .concat(intent.colors || [])
    .concat(intent.fits || [])
    .concat(intent.styles || [])
    .concat(intent.brands || [])
    .concat(intent.keywords || []);

  const seen = new Set();
  const terms = [];
  for (const part of parts) {
    const term = String(part).trim().toLowerCase();
    if (!term || term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_KEYWORDS) break;
  }
  return terms.join(' ');
}

/* Money -> a number. amount and divisor both come from the listing; if
   either is unusable the price is left out rather than guessed. */
function moneyToPrice(money) {
  if (!money || typeof money !== 'object') return null;
  const amount = Number(money.amount);
  const divisor = Number(money.divisor);
  if (!Number.isFinite(amount) || !Number.isFinite(divisor) || divisor <= 0) return null;
  const price = amount / divisor;
  return Number.isFinite(price) && price > 0 ? Number(price.toFixed(2)) : null;
}

/* The listing's own images, in rank order. Never another listing's. */
function imageFrom(listing) {
  const images = Array.isArray(listing.images) ? listing.images : [];
  if (!images.length) return null;
  const ranked = images
    .filter((img) => img && typeof img === 'object')
    .sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));
  const first = ranked[0];
  if (!first) return null;
  /* prefer a display-sized image, falling back to the full-size original */
  return first.url_570xN || first.url_fullxfull || first.url_170x135 || null;
}

function listingUrl(listing) {
  const raw = typeof listing.url === 'string' ? listing.url.trim() : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!ETSY_HOST.test(url.hostname)) return null;
    return url.href;
  } catch (err) {
    return null;
  }
}

/* Maps one listing. Every value comes from that listing; a field the
   listing does not carry is omitted so the gate can reject the record. */
function toRecord(listing) {
  if (!listing || typeof listing !== 'object') return null;

  const record = {
    title: typeof listing.title === 'string' ? listing.title.trim() : '',
    brand: listing.shop && typeof listing.shop.shop_name === 'string' ? listing.shop.shop_name.trim() : '',
    /* The product page is on Etsy; the maker is the shop. Both are real
       and neither is a stand-in for the other. */
    retailer: 'Etsy',
    price: moneyToPrice(listing.price),
    currency: listing.price && listing.price.currency_code ? listing.price.currency_code : undefined,
    imageUrl: imageFrom(listing),
    productUrl: listingUrl(listing),
    sku: listing.listing_id !== undefined ? String(listing.listing_id) : undefined,
    availability: listing.state === 'active' && Number(listing.quantity) > 0 ? 'in stock' : 'out of stock'
  };

  /* strip absent values so the gate sees a missing field, not an empty one */
  Object.keys(record).forEach((k) => {
    if (record[k] === null || record[k] === undefined || record[k] === '') delete record[k];
  });
  return record;
}

async function search(intent, options) {
  const key = process.env.ETSY_API_KEY;
  if (!key) throw new Error('ETSY_API_KEY is not set');

  const limit = Math.min(Math.max(Number(options && options.limit) || 12, 1), 100);
  const params = new URLSearchParams({
    limit: String(limit),
    /* nests each listing's own images and its shop inside the listing */
    includes: 'Images,Shop'
  });

  const keywords = keywordsFrom(intent || {});
  if (keywords) params.set('keywords', keywords);
  if (intent && intent.minPrice) params.set('min_price', String(intent.minPrice));
  if (intent && intent.maxPrice) params.set('max_price', String(intent.maxPrice));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(`${LISTINGS_ACTIVE}?${params.toString()}`, {
      headers: { 'x-api-key': key, Accept: 'application/json' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    /* logged server-side only; the endpoint returns a generic message */
    const detail = await response.text().catch(() => '');
    throw new Error(`Etsy responded ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const results = Array.isArray(payload && payload.results) ? payload.results : [];
  return results.map(toRecord).filter(Boolean);
}

module.exports = {
  name: 'etsy',
  defaultRetailer: 'Etsy',
  configured: () => Boolean(process.env.ETSY_API_KEY),
  search,
  /* exported for tests */
  toRecord,
  keywordsFrom,
  moneyToPrice,
  imageFrom,
  listingUrl
};
