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

const BRANDS = [require('./uniqlo')];

const get = (id) => (typeof id === 'string' ? BRANDS.find((b) => b.id === id) || null : null);

/* what the brand menu shows */
const list = () => BRANDS.map((b) => ({ id: b.id, name: b.name, market: b.market, count: b.products().length, coverage: b.coverage }));

/* the fields a card may carry to the browser; bookkeeping stays here */
const CARD = ['code', 'name', 'url', 'category', 'group', 'categoryLabel', 'line', 'imageUrl', 'holds', 'holdsText', 'price', 'availability'];
const pick = (p) => Object.fromEntries(CARD.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

/* One page of a brand's products for Find Fit: the brand's own search
   where it has one, else its whole list, paged the same way. */
function browse(brand, query) {
  const found = typeof brand.search === 'function' ? brand.search(query || {}) : createIndex(brand.products()).search(query || {});
  return {
    brand: { id: brand.id, name: brand.name, market: brand.market, coverage: brand.coverage, notice: brand.notice || null, catalogue: typeof brand.catalogue === 'function' ? brand.catalogue() : null },
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
