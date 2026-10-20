/* =========================================================
   Fynd — UNIQLO US products found live, through Fynd's product source

   Until an authorized UNIQLO catalogue feed is connected (./sync.js),
   Find Fit can search the rest of UNIQLO's US range the way Fynd's own
   Search page does: one query to the product source Fynd already uses
   (api/search.js → api/_providers/openwebninja.js, which searches the
   listings UNIQLO publishes to Google Shopping), through the same
   request budget, cache, verification gate and per-shopper allowance.

   Nothing found this way is stored in the catalogue or indexed: each
   search is answered from the source (or its 30-minute search cache,
   as on the Search page) and drawn once. Only a result that is a UNIQLO
   US product page is kept, identified by the product code in its own
   link and rebuilt as that product's canonical page — so its chart is
   looked up by Fynd's sizing pipeline exactly as a pasted link is, and
   never borrowed from another product. What the source doesn't carry
   (colours and sizes, mostly) is said to be missing, never filled in.
   ========================================================= */

'use strict';

const { text, httpsOn } = require('./product');

/* the product sources a live search may run on: one that searches the
   listings shops publish to Google Shopping, and reads no shop's pages.
   Serper's organic path reads retailers' own pages, so it never runs here. */
const LIVE_SOURCES = ['openwebninja'];
const MAX_QUERY = 120;
const MAX_WORDS = 8;
/* the product source's own thumbnails, and UNIQLO's image host */
const THUMB_HOSTS = Array.from({ length: 10 }, (v, i) => `encrypted-tbn${i}.gstatic.com`);
const CODE_IN_PATH = /\/us\/en\/products\/(E\d{6}-\d{3})(?:\/|$)/;

/* The shopper's words, held to their limits, as the search the route runs:
   UNIQLO named as the brand, the words as typed. Null for nothing to search. */
function searchBody(raw, limit) {
  const q = raw && typeof raw.q === 'string' ? raw.q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) : '';
  const words = q.split(' ').map((w) => w.replace(/[^\p{L}\p{N}'’$&.-]/gu, '')).filter((w) => w && !/^uniqlo$/i.test(w)).slice(0, MAX_WORDS);
  if (!words.length) return null;
  return { q: words.join(' '), body: { intent: { brands: ['UNIQLO'], keywords: words }, limit } };
}

function image(url, adapter, code) {
  if (typeof url !== 'string') return null;
  const own = adapter.image(url, code);
  if (own) return own;
  const thumb = httpsOn(url, THUMB_HOSTS);
  return thumb && new URL(thumb).pathname === '/shopping' ? thumb : null;
}

/* The verified products of one search → the UNIQLO US products among
   them, once each, and a count of everything left out and why. `listed`
   says whether Fynd already lists a code (the brand module's find). */
function cards(products, adapter, listed) {
  const kept = [];
  const seen = new Set();
  const dropped = {};
  const missing = { image: 0, price: 0, colours: 0, sizes: 0 };
  const drop = (why) => { dropped[why] = (dropped[why] || 0) + 1; };
  (Array.isArray(products) ? products : []).forEach((p) => {
    let path = '';
    try { path = new URL(p.productUrl).pathname; } catch (err) { /* not a link */ }
    const code = adapter.code((CODE_IN_PATH.exec(path) || [])[1]);
    const url = code ? adapter.canonicalUrl(p.productUrl, code) : null;
    if (!url) return drop('not-a-uniqlo-us-product-page');
    if (seen.has(code)) return drop('same-product-twice');
    const name = text(p.name, 160);
    if (!name) return drop('no-plain-text-name');
    seen.add(code);
    let colour = null;
    try { colour = new URL(p.productUrl).searchParams.get('colorDisplayCode'); } catch (err) { /* checked above */ }
    const amount = typeof p.price === 'number' && Number.isFinite(p.price) && p.price > 0 && p.price < 100000 && (p.currency || 'USD') === 'USD' ? Math.round(p.price * 100) : null;
    const known = listed(code);
    const card = {
      code,
      name: known ? known.name : name,
      url,
      imageUrl: image(p.imageUrl, adapter, code),
      price: amount ? { currency: 'USD', amount, was: null } : null,
      colourCode: /^\d{2}$/.test(colour || '') ? colour : null,
      listed: Boolean(known),
      holds: known ? known.holds : 'live-only',
      holdsText: known ? known.holdsText : 'Not in Fynd’s list — its chart is looked up from UNIQLO’s page when you ask'
    };
    if (!card.imageUrl) missing.image += 1;
    if (!card.price) missing.price += 1;
    /* the source carries neither for a search result */
    missing.colours += 1;
    missing.sizes += 1;
    kept.push(card);
  });
  return { products: kept, dropped, missing };
}

module.exports = { searchBody, cards, LIVE_SOURCES, THUMB_HOSTS, MAX_QUERY };
