/* =========================================================
   Fynd — the brands Find Fit can browse

   Each brand is one module answering the same few questions:

     id, name, market   who it is
     coverage           one honest line on how much of its range is here
     products()         the products a shopper can pick from: { code,
                        name, url, category, categoryLabel, line,
                        imageUrl, holds, holdsText }
     find(code)         one product by its exact code, or null — the
                        product's address always comes from here

   The chart for a chosen product is then looked up exactly as a pasted
   link is (api/_sizing/chart.js: Fynd's record, the live page, an
   official fallback, or why there is none), from the address the brand
   module gives — never one the browser sent.

   Only brands with a working way to pick a product are listed. To add
   one (Nike, Zara, H&M…), write its module beside uniqlo.js and add it
   to BRANDS; Find Fit needs no change.
   ========================================================= */

'use strict';

const BRANDS = [require('./uniqlo')];

const get = (id) => BRANDS.find((b) => b.id === id) || null;

/* what the brand menu shows */
const list = () => BRANDS.map((b) => ({ id: b.id, name: b.name, market: b.market, count: b.products().length, coverage: b.coverage }));

/* the brands planned but not yet browsable, named so the page can say
   which are coming rather than offer choices that do nothing */
const PLANNED = ['Nike', 'Zara', 'H&M'];

module.exports = { BRANDS, get, list, PLANNED };
