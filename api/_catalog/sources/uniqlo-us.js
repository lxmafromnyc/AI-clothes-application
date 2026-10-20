/* =========================================================
   Fynd — the UNIQLO US catalogue source

   Everything about UNIQLO that the catalogue import needs to know, and
   nothing else: its product IDs, where its product pages and photos
   live, how its own category names map onto Fynd's, and where an
   authorized feed may be fetched from. The import (../import.js), the
   sync (../sync.js) and the search (../search.js) are the same for
   every source; Find Fit's pages never see this file.

   No feed has been authorized yet. Until UNIQLO (or a licensed
   distributor) grants access:

     FEED_HOSTS is empty, so an API sync refuses every address — the
     authorized host is added here, in a reviewed change, once there is
     an agreement naming it
     LICENSED is empty, so price, stock, sizes, colours and photos are
     dropped from any feed until the licence covering them is recorded
     in UNIQLO_FEED_LICENSED_FIELDS (or --licensed) at sync time

   Fynd never reads UNIQLO's website to build this catalogue.
   ========================================================= */

'use strict';

const { httpsOn } = require('../product');

const CODE = /^E\d{6}-\d{3}$/;
const PAGE = /^\/us\/en\/products\/(E\d{6}-\d{3})(?:\/\d{2})?\/?$/;
const IMAGE_HOSTS = ['image.uniqlo.com'];

/* UNIQLO's own category words → Fynd's categories, first match wins.
   Read from the source's category path, never the product's name, so
   "Short-Sleeve T-Shirt" is a T-shirt and not shorts. */
const CATEGORY_RULES = [
  [/hood|sweatshirt|sweat ?(top|pullover|full)/, 'sweatshirts-hoodies'],
  [/t-?shirt|\btees?\b|polo/, 'tshirts'],
  [/sweater|cardigan|knit/, 'knitwear'],
  [/jeans?\b|denim pants?/, 'jeans'],
  [/\bshorts\b/, 'shorts'],
  [/pants?\b|trousers?|joggers?|chinos?|leggings?|sweatpants?/, 'pants'],
  [/outer|jackets?|coats?|parkas?|blazers?|vests?|blousons?|down (jackets?|coats?|vests?)|ultra light down|puffer/, 'outerwear'],
  [/dress|skirt/, 'dresses-skirts'],
  [/lounge|pajama|sleep|relaco/, 'loungewear'],
  [/inner|underwear|bra\b|bras\b|briefs?|boxers?|socks?|heattech|airism/, 'innerwear'],
  [/shirts?\b|blouses?/, 'shirts'],
  [/accessor|bags?\b|hats?\b|caps?\b|scarf|scarves|gloves?|belts?|umbrella/, 'accessories']
];

const LINE_WORDS = [
  [/\bbab(y|ies)\b|\binfants?\b|toddler/, 'baby'],
  [/\bkids?\b|\bchild(ren)?\b|\bboys?\b|\bgirls?\b/, 'kids'],
  [/\bunisex\b/, 'unisex'],
  [/\bwomen'?s?\b|\bfemale\b|\bladies\b/, 'women'],
  [/\bmen'?s?\b|\bmale\b/, 'men']
];

const listFromEnv = (name) => (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  id: 'uniqlo-us',
  brand: 'UNIQLO',
  brandId: 'uniqlo',
  market: 'US',
  currency: 'USD',
  /* the committed, validated catalogue (api/_catalog/data), when there is one */
  catalogFile: 'uniqlo-us.json',
  committed: () => require('../data/uniqlo-us.json'),
  /* the only hosts an API sync may fetch from — none until one is authorized */
  FEED_HOSTS: [],
  /* the fields the licence covers beyond the core ones — none until recorded */
  LICENSED: [],
  env: { url: 'UNIQLO_FEED_URL', token: 'UNIQLO_FEED_TOKEN', licensed: 'UNIQLO_FEED_LICENSED_FIELDS', hosts: null },
  licensedFromEnv: () => listFromEnv('UNIQLO_FEED_LICENSED_FIELDS'),

  /* how long a catalogue may be served, and how long its prices and stock */
  maxAgeDays: 30,
  volatileMaxAgeHours: 48,

  code(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    return CODE.test(s) ? s : null;
  },

  /* the product's page on uniqlo.com, rebuilt from the code — only when
     the address the source gave is that product's own page */
  canonicalUrl(value, code) {
    const url = httpsOn(value, ['www.uniqlo.com']);
    if (!url) return null;
    const m = PAGE.exec(new URL(url).pathname);
    return m && m[1] === code ? `https://www.uniqlo.com/us/en/products/${code}/00` : null;
  },

  /* a photo only from UNIQLO's image host, at an address carrying the
     product's own code */
  image(value, code) {
    const url = httpsOn(value, IMAGE_HOSTS);
    return url && code && url.includes(`/${code.slice(1, 7)}/`) ? url : null;
  },
  imageHosts: IMAGE_HOSTS,

  category(value) {
    const s = (Array.isArray(value) ? value.join(' > ') : typeof value === 'string' ? value : '').toLowerCase();
    if (!s) return null;
    const rule = CATEGORY_RULES.find(([re]) => re.test(s));
    return rule ? rule[1] : 'other';
  },

  /* the line from the source's own gender field, else its category path */
  line(gender, categoryPath) {
    const words = [gender, Array.isArray(categoryPath) ? categoryPath.join(' ') : categoryPath].filter((w) => typeof w === 'string').join(' ').toLowerCase();
    const found = LINE_WORDS.find(([re]) => re.test(words));
    return found ? found[1] : null;
  }
};
