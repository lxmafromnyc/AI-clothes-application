/* =========================================================
   Fynd — a merchant's own catalogue, from its config

   A participating merchant supplies its products directly: an
   authorized CSV or JSON export (api/_catalog/MERCHANTS.md), described
   by one reviewed config file (api/_catalog/merchants/<id>.json) that
   says who the merchant is, where its product pages and photos live,
   which brands it may list, and what it has authorized Fynd to show.
   createMerchantSource(config) turns that config into the same adapter
   the UNIQLO source is (./uniqlo-us.js), so the import (../import.js),
   the sync (../sync.js), the store (../store.js) and the search
   (../search.js) work for every merchant unchanged.

   No feed is fetched: a merchant's file arrives by hand and is imported
   by scripts/sync-catalog.js --merchant. Nothing here reads a website.

   ---------------------------------------------------------
   The config (validateConfig lists every problem)
   ---------------------------------------------------------
     format, version   "fynd-merchant", 1
     id                lower-case words joined by hyphens, 2–30
                       characters: the catalogue's file name and the
                       brand id Find Fit browses it by
     name              how the merchant is named to shoppers
     market, currency  "US", "USD" — two and three capital letters
     brands            the brand names the merchant may list (a
                       retailer may list several); a product names one
                       of them, or the only one there is
     productPages      { hosts: [...], codeInPath: true|false } — the
                       https hosts its product pages live on, and
                       whether each page's path carries the product code
     imageHosts        the https hosts its product photos are on
     categories        optional: the merchant's own category words → a
                       Fynd category (product.js CATEGORIES), checked
                       before the general rules below
     authorization     who granted Fynd the data and under what:
                         grantedBy, reference   who, and the agreement
                         grantedAt, expiresAt   YYYY-MM-DD; expiresAt
                                                null when open-ended
                         licensedFields         what may be shown beyond
                                                the core fields: images,
                                                colours, sizes, price,
                                                stock, description
     fixture           true only for a test merchant: never served
                       (merchants/index.js) and never written to the
                       customer-facing catalogue (sync-catalog.js)
   ========================================================= */

'use strict';

const { httpsOn, CATEGORIES, LICENSABLE, isPlain } = require('../product');

/* the same code shape Find Fit's product page accepts (assets/product-page.js) */
const CODE = /^[A-Z0-9][A-Z0-9-]{2,30}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v));
/* a host that could only be a private or local machine, never a merchant's site */
const LOCAL = /^(localhost|.*\.local|.*\.internal|\d+\.\d+\.\d+\.\d+)$/;

/* the general category words, after the merchant's own; first match wins.
   Read from the merchant's category path, never the product name. */
const CATEGORY_RULES = [
  [/hood|sweatshirt|sweat ?(top|pullover|full)|fleece/, 'sweatshirts-hoodies'],
  [/t-?shirt|\btees?\b|polo/, 'tshirts'],
  [/sweater|cardigan|knit/, 'knitwear'],
  [/jeans?\b|denim pants?/, 'jeans'],
  [/\bshorts\b/, 'shorts'],
  [/pants?\b|trousers?|joggers?|chinos?|leggings?|sweatpants?/, 'pants'],
  [/outer|jackets?|coats?|parkas?|blazers?|vests?|puffer/, 'outerwear'],
  [/dress|skirt/, 'dresses-skirts'],
  [/lounge|pajama|sleep/, 'loungewear'],
  [/underwear|bras?\b|briefs?|boxers?|socks?/, 'innerwear'],
  [/shirts?\b|blouses?/, 'shirts'],
  [/accessor|bags?\b|hats?\b|caps?\b|scarf|scarves|gloves?|belts?/, 'accessories']
];
const LINE_WORDS = [
  [/\bbab(y|ies)\b|\binfants?\b|toddler/, 'baby'],
  [/\bkids?\b|\bchild(ren)?\b|\bboys?\b|\bgirls?\b/, 'kids'],
  [/\bunisex\b/, 'unisex'],
  [/\bwomen'?s?\b|\bfemale\b|\bladies\b/, 'women'],
  [/\bmen'?s?\b|\bmale\b/, 'men']
];

const lower = (s) => String(s).trim().toLowerCase();

/* every problem with a config, in words; [] when it can be used */
function validateConfig(config) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  if (!isPlain(config)) return [{ field: 'config', message: 'A merchant config is a JSON object.' }];
  const c = config;
  if (c.format !== 'fynd-merchant' || c.version !== 1) fail('format', 'Expected format "fynd-merchant", version 1.');
  if (typeof c.id !== 'string' || !ID.test(c.id) || c.id.length < 2 || c.id.length > 30) fail('id', 'The id is lower-case words joined by hyphens, 2–30 characters.');
  if (c.id === 'uniqlo' || c.id === 'uniqlo-us') fail('id', 'That id is taken by an existing source.');
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) fail('name', 'Give the merchant\'s name as shoppers know it (up to 80 characters).');
  if (typeof c.market !== 'string' || !/^[A-Z]{2}$/.test(c.market)) fail('market', 'The market is a two-letter country code, e.g. "US".');
  if (typeof c.currency !== 'string' || !/^[A-Z]{3}$/.test(c.currency)) fail('currency', 'The currency is a three-letter code, e.g. "USD".');
  if (!Array.isArray(c.brands) || !c.brands.length || c.brands.some((b) => typeof b !== 'string' || !b.trim() || b.length > 60)
    || new Set(c.brands.map(lower)).size !== c.brands.length) fail('brands', 'List the brands the merchant may list, each once (up to 60 characters).');
  const hosts = (list, field) => {
    if (!Array.isArray(list) || !list.length || list.some((h) => typeof h !== 'string' || !HOST.test(h) || LOCAL.test(h))) fail(field, 'List public host names only (e.g. "www.example-shop.com"): no scheme, port, path, IP address or local name.');
  };
  const pages = isPlain(c.productPages) ? c.productPages : {};
  hosts(pages.hosts, 'productPages.hosts');
  if (typeof pages.codeInPath !== 'boolean') fail('productPages.codeInPath', 'Say whether each product page\'s path carries its product code (true or false).');
  hosts(c.imageHosts, 'imageHosts');
  if (c.categories !== undefined) {
    if (!isPlain(c.categories) || Object.entries(c.categories).some(([k, v]) => !k.trim() || !Object.prototype.hasOwnProperty.call(CATEGORIES, v))) {
      fail('categories', `Map the merchant's category words to one of ${Object.keys(CATEGORIES).join(', ')}.`);
    }
  }
  const a = isPlain(c.authorization) ? c.authorization : null;
  if (!a) fail('authorization', 'Record who authorized Fynd to use this data, and under what.');
  else {
    if (typeof a.grantedBy !== 'string' || !a.grantedBy.trim()) fail('authorization.grantedBy', 'Name who at the merchant granted the data.');
    if (typeof a.reference !== 'string' || !a.reference.trim()) fail('authorization.reference', 'Name the agreement or written permission it rests on.');
    if (!isDate(a.grantedAt)) fail('authorization.grantedAt', 'Give the date it was granted, as YYYY-MM-DD.');
    if (a.expiresAt !== null && !isDate(a.expiresAt)) fail('authorization.expiresAt', 'Give the date it ends, as YYYY-MM-DD, or null when it doesn\'t.');
    if (isDate(a.grantedAt) && isDate(a.expiresAt) && a.expiresAt <= a.grantedAt) fail('authorization.expiresAt', 'It ends after it was granted.');
    if (!Array.isArray(a.licensedFields) || a.licensedFields.some((f) => !LICENSABLE.includes(f)) || new Set(a.licensedFields).size !== a.licensedFields.length) {
      fail('authorization.licensedFields', `List what the merchant licensed beyond the core fields, each once, from ${LICENSABLE.join(', ')}.`);
    }
  }
  if (c.fixture !== undefined && typeof c.fixture !== 'boolean') fail('fixture', 'fixture is true (a test merchant) or absent.');
  return errors;
}

/* whether the authorization covers `now` */
function authorizedAt(config, now) {
  const a = config.authorization;
  const day = new Date(now || Date.now()).toISOString().slice(0, 10);
  return day >= a.grantedAt && (a.expiresAt === null || day <= a.expiresAt);
}

/* config → the adapter every catalogue component uses. options.committed:
   how the merchant's committed catalogue is read (merchants/index.js) */
function createMerchantSource(config, options) {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Merchant config ${config && config.id}: ${errors.map((e) => `${e.field}: ${e.message}`).join(' ')}`);
  const pageHosts = config.productPages.hosts.slice();
  const imageHosts = config.imageHosts.slice();
  const brandsByKey = new Map(config.brands.map((b) => [lower(b), b]));
  const ownCategories = new Map(Object.entries(config.categories || {}).map(([k, v]) => [lower(k), v]));
  const codeIn = (pathname, code) => pathname.split('/').some((seg) => {
    try { return decodeURIComponent(seg).toUpperCase() === code; } catch (err) { return false; }
  });
  const committed = options && typeof options.committed === 'function' ? options.committed
    : () => { const err = new Error('no committed catalogue'); err.code = 'MODULE_NOT_FOUND'; throw err; };

  return Object.freeze({
    id: config.id,
    merchant: true,
    brand: config.name,
    brands: config.brands.slice(),
    market: config.market,
    currency: config.currency,
    catalogFile: `${config.id}.json`,
    committed,
    fixture: config.fixture === true,
    config,
    /* nothing is fetched for a merchant: its file is imported by hand */
    FEED_HOSTS: [],
    LICENSED: config.authorization.licensedFields.slice(),
    env: { url: null, token: null, licensed: null, hosts: null },
    licensedFromEnv: () => [],
    authorizedAt: (now) => authorizedAt(config, now),
    /* a catalogue is served for 30 days, its prices and stock for 48 hours */
    maxAgeDays: 30,
    volatileMaxAgeHours: 48,
    pageHosts,
    imageHosts,

    code(value) {
      const s = typeof value === 'string' ? value.trim() : '';
      return CODE.test(s) ? s : null;
    },

    /* the product's page, on the merchant's own hosts, without query or
       fragment; carrying the code in its path when the config says so */
    canonicalUrl(value, code) {
      const url = httpsOn(typeof value === 'string' ? value.replace(/^http:\/\//i, 'https://') : value, pageHosts);
      if (!url) return null;
      const u = new URL(url);
      if (config.productPages.codeInPath && !codeIn(u.pathname, code)) return null;
      return `${u.origin}${u.pathname}`;
    },
    /* the code in a product page's path, when pages carry it */
    codeFromUrl(value) {
      if (!config.productPages.codeInPath) return null;
      const url = httpsOn(String(value || ''), pageHosts);
      if (!url) return null;
      const seg = new URL(url).pathname.split('/').map((s) => s.toUpperCase()).find((s) => CODE.test(s));
      return seg || null;
    },

    /* a photo only from the merchant's image hosts */
    image(value) {
      return httpsOn(value, imageHosts);
    },
    imageHostsList: imageHosts,

    /* the merchant's own words first, then the general rules */
    category(value) {
      const path = Array.isArray(value) ? value : typeof value === 'string' ? value.split('>') : [];
      const segments = path.map(lower).filter(Boolean);
      if (!segments.length) return null;
      const own = segments.map((s) => ownCategories.get(s)).find(Boolean);
      if (own) return own;
      const s = segments.join(' > ');
      const rule = CATEGORY_RULES.find(([re]) => re.test(s));
      return rule ? rule[1] : 'other';
    },

    line(gender, categoryPath) {
      const words = [gender, Array.isArray(categoryPath) ? categoryPath.join(' ') : categoryPath].filter((w) => typeof w === 'string').join(' ').toLowerCase();
      const found = LINE_WORDS.find(([re]) => re.test(words));
      return found ? found[1] : null;
    },

    /* the brand a product names, as the merchant may list it: one of its
       brands, or its only one when the product names none; null otherwise */
    brandOf(value) {
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return config.brands.length === 1 ? config.brands[0] : null;
      return typeof value === 'string' ? brandsByKey.get(lower(value)) || null : null;
    }
  });
}

module.exports = { createMerchantSource, validateConfig, authorizedAt, CODE };
