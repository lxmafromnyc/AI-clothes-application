/* =========================================================
   Fynd — the brands Find Fit can browse

   Each brand is one module answering the same few questions:

     id, name, market   who it is
     coverage           one honest line on how much of its range is here
     products()         the products a shopper can pick from: { code,
                        name, url, category, categoryLabel, line,
                        imageUrl, holds, holdsText }
     search(query)      optional: one page of them matching a query and
                        filters ({ q, category, line, inStock, offset,
                        limit } → { products, total, facets, … }); a
                        brand without it is paged from products()
     find(code)         one product by its exact code, or null — the
                        product's address always comes from here
     detail(code)       the product's page: photos by colour, sizes,
                        fabric, fit — each with its source — and a list
                        of what isn't known (price, reviews, stock…)

   The chart for a chosen product is then looked up exactly as a pasted
   link is (api/_sizing/chart.js: Fynd's record, the live page, an
   official fallback, or why there is none), from the address the brand
   module gives — never one the browser sent.

   Only brands with a working way to pick a product are listed. To add
   one (Nike, Zara, H&M…), write its module beside uniqlo.js and add it
   to BRANDS; Find Fit needs no change.
   ========================================================= */

'use strict';

const { createIndex } = require('../../_catalog/search');
const { getProvider } = require('../../_providers/product-source');
const { LIVE_SOURCES } = require('../../_catalog/live');

const BRANDS = [require('./uniqlo')];

const get = (id) => (typeof id === 'string' ? BRANDS.find((b) => b.id === id) || null : null);

/* what the brand menu shows */
const list = () => BRANDS.map((b) => ({ id: b.id, name: b.name, market: b.market, count: b.products().length, coverage: b.coverage }));

/* the fields a card may carry to the browser; bookkeeping stays here */
const CARD = ['code', 'name', 'url', 'category', 'group', 'categoryLabel', 'line', 'imageUrl', 'holds', 'holdsText', 'price', 'availability'];
const pick = (p) => Object.fromEntries(CARD.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

/* Whether Find Fit can search the rest of this brand live: UNIQLO only,
   and only when the deployment's product source is one a live search may
   run on (api/_catalog/live.js) and has its key. Said to the page, so the
   panel is offered only where pressing it can work. */
function liveSearch(brand) {
  if (!brand || brand.id !== 'uniqlo') return { available: false };
  try {
    const provider = getProvider();
    return { available: Boolean(provider && provider.configured() && LIVE_SOURCES.includes(provider.name)) };
  } catch (err) {
    return { available: false };
  }
}

/* One page of a brand's products for Find Fit: the brand's own search
   where it has one, else its whole list, paged the same way. */
function browse(brand, query) {
  const found = typeof brand.search === 'function' ? brand.search(query || {}) : createIndex(brand.products()).search(query || {});
  const live = liveSearch(brand);
  return {
    brand: {
      id: brand.id,
      name: brand.name,
      market: brand.market,
      coverage: brand.coverage,
      notice: (typeof brand.noticeAt === 'function' ? brand.noticeAt(undefined, { live: live.available }) : brand.notice) || null,
      catalogue: typeof brand.catalogue === 'function' ? brand.catalogue() : null,
      live
    },
    products: (found.products || found.items).map(pick),
    total: found.total,
    offset: found.offset,
    limit: found.limit,
    query: found.query,
    partial: found.partial,
    unmatched: found.unmatched,
    facets: found.facets
  };
}

/* the brands planned but not yet browsable, named so the page can say
   which are coming rather than offer choices that do nothing */
const PLANNED = ['Nike', 'Zara', 'H&M'];

module.exports = { BRANDS, get, list, browse, PLANNED };
