/* =========================================================
   Fynd — the UNIQLO catalogue snapshot, checked as it loads

   A snapshot of UNIQLO's own US category pages, in the shape the
   retired scripts/fetch-uniqlo-catalog.js wrote. That reader has been
   removed: Fynd doesn't build its catalogue by reading uniqlo.com, and
   an authorized catalogue comes through api/_catalog instead. So no
   committed snapshot is read here, even if one is added — only a test's
   own fixture, named in FYND_UNIQLO_CATALOG. Each product in it keeps
   its code (from its own link), its name, its photo on image.uniqlo.com,
   its category and line, and the page it was listed on; one that breaks
   any of those rules is left out, never repaired. No fixture, no
   products: Find Fit then lists only the products Fynd has records or
   listings for.

   Read by the UNIQLO brand module (uniqlo.js) and by the official-chart
   fallback (../official-charts.js), which needs to know a product's
   category and line from UNIQLO's own page before its general chart can
   stand in for the product's own.
   ========================================================= */

'use strict';

const path = require('path');

const CODE = /^E\d{6}-\d{3}$/;
const CATEGORIES = ['sweatshirts-hoodies', 'tshirts', 'knitwear', 'shirts'];
const LINES = ['men', 'women'];
const LISTED = /^https:\/\/www\.uniqlo\.com\/us\/en\/(men|women)\/[a-z0-9/-]+$/;

function load() {
  let raw = null;
  try {
    /* only a test's own fixture: a snapshot read off uniqlo.com is never served */
    if (!process.env.FYND_UNIQLO_CATALOG) return { fetchedAt: null, products: [] };
    raw = require(path.resolve(process.env.FYND_UNIQLO_CATALOG));
  } catch (err) {
    return { fetchedAt: null, products: [] };
  }
  const products = [];
  const seen = new Set();
  [].concat((raw && raw.products) || []).slice(0, 1000).forEach((p) => {
    if (!p || typeof p !== 'object' || !CODE.test(p.code) || seen.has(p.code)) return;
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 160) return;
    if (p.url !== `https://www.uniqlo.com/us/en/products/${p.code}/00`) return;
    if (!CATEGORIES.includes(p.category) || !LINES.includes(p.line) || !LISTED.test(p.listedOn || '')) return;
    const image = typeof p.imageUrl === 'string' && /^https:\/\/image\.uniqlo\.com\/[^\s"'<>]+$/.test(p.imageUrl) && p.imageUrl.includes(p.code.slice(1, 7)) ? p.imageUrl : null;
    seen.add(p.code);
    products.push(Object.freeze({
      code: p.code, name: p.name.replace(/\s+/g, ' ').trim(), url: p.url, imageUrl: image,
      category: p.category, line: p.line, listedOn: p.listedOn, categoryLabel: typeof p.categoryLabel === 'string' ? p.categoryLabel.slice(0, 40) : null
    }));
  });
  return { fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt.slice(0, 10) : null, products };
}

const SNAPSHOT = load();
const byCode = (code) => SNAPSHOT.products.find((p) => p.code === code) || null;

module.exports = { SNAPSHOT, byCode, CATEGORIES };
