/* =========================================================
   Fynd — pages of one product search ("Load more")

   A search asks the product source for its first page, and a shopper
   who wants more asks for the NEXT page from the same source — never a
   longer slice of something already fetched. This file holds the two
   things that needs on the server:

     cursors     what "the next page of THIS search" means, kept in the
                 store (api/_store.js) under a random id. The browser
                 holds only the id. What it points at — the shaped
                 intent, the page size, the source that answered page 1,
                 the next page number, and what has been shown — never
                 leaves the server, so a cursor cannot be edited into a
                 different search, a bigger page or another source.
     dedupe      every product shown on an earlier page is remembered by
                 its keys (its link without tracking parameters, and its
                 retailer + title), and a later page drops any product
                 sharing a key. Within a page the same rule applies, so
                 two listings of one product on one page show once.

   Cursors are
     * single use — taken with GETDEL (store.takeOnce), so two clicks on
       Load More cannot buy the same page twice. A cursor already taken
       is told apart from one that never existed or expired, for 2
       minutes, by a short-lived marker.
     * unguessable — 192 random bits; an id that was never issued, or
       has expired, is refused before any source is asked.
     * bounded — MAX_PAGES pages per paid search, and 30 minutes of life.
       Whoever holds a cursor, one paid search can never buy more than
       MAX_PAGES provider pages, because each page is taken once.

   A cursor is not tied to the caller's metering subject on purpose: an
   anonymous browser's first request is counted against its address
   (it has no device cookie yet) and the next against the device cookie
   it was just given (api/_auth.js), so a subject-bound cursor would
   expire on the very first Load more. Pacing per caller is
   api/search.js's `search:more` rate limit.

   What a cursor page costs the shopper is decided in api/search.js, not
   here. Nothing in this file reads a plan or an allowance.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const store = require('../_store');

/* How deep one search can be browsed: the first page, which is metered
   as one search, and up to four more on the same paid search. */
const MAX_PAGES = 5;
const CURSOR_TTL_SECONDS = 30 * 60;
const USED_TTL_SECONDS = 2 * 60;
/* enough for MAX_PAGES full pages, two keys each, with room to spare */
const MAX_SEEN = 400;

const cursorKey = (id) => `search:cursor:${id}`;
const usedKey = (id) => `search:cursor-used:${id}`;
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const short = (value) => crypto.createHash('sha256').update(value).digest('base64').slice(0, 16);

/* Query parameters that say how a shopper arrived, not which product the
   page is. Dropped before two links are compared; anything else in the
   query is kept, because some shops name the product there (?pid=). */
const TRACKING = /^(utm_[a-z_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|srsltid|_ga|_gl|mc_cid|mc_eid|irclickid|clickid|cjevent|ranmid|ransiteid|ranEAID|ranSiteID|affid|aff_id|ref|ref_|tag|camp|cmpid|source)$/i;

const fold = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function urlKey(href) {
  let u;
  try { u = new URL(String(href || '')); } catch (err) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\d?\./, '');
  const path = u.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = kept.map(([k, v]) => `${k}=${v}`).join('&');
  return `u:${host}${path}${query ? `?${query}` : ''}`;
}

function nameKey(product) {
  const name = fold(product && product.name);
  const where = fold(product && product.retailer);
  return name && where ? `n:${where}|${name}` : null;
}

/* the keys one product is remembered by, hashed: nothing readable kept */
const keysOf = (product) => [urlKey(product && product.productUrl), nameKey(product)].filter(Boolean).map(short);

/* The products not shown before, in their order, at most `limit` of them
   (the page actually sent), and the seen list with that page added. A
   product dropped by the limit is NOT marked seen. */
function unseen(products, seenBefore, limit) {
  const seen = new Set(Array.isArray(seenBefore) ? seenBefore.filter((k) => typeof k === 'string') : []);
  const cap = Number.isFinite(limit) && limit > 0 ? limit : Infinity;
  const out = [];
  let repeated = 0;
  for (const product of Array.isArray(products) ? products : []) {
    const keys = keysOf(product);
    if (keys.some((k) => seen.has(k))) { repeated += 1; continue; }
    if (out.length >= cap) continue;
    keys.forEach((k) => seen.add(k));
    out.push(product);
  }
  const list = [...seen];
  return { products: out, repeated, seen: list.length > MAX_SEEN ? list.slice(list.length - MAX_SEEN) : list };
}

/* Whether this adapter can be asked for page n of a search. Declared by
   the adapter itself (`paginates: true`); an adapter that says nothing
   is treated as one page only, so Load More is never offered over a
   source that would just answer page 1 again. */
const supports = (provider) => Boolean(provider && provider.paginates === true);

/* ---------- cursors ---------- */

async function issue(state) {
  const id = b64url(crypto.randomBytes(24));
  await store.set(cursorKey(id), Object.assign({ v: 1 }, state), { ttlSeconds: CURSOR_TTL_SECONDS });
  return id;
}

/* { state } for a live cursor, now taken; or
   { refused: 'expired' | 'in-use' } */
async function take(id) {
  if (typeof id !== 'string' || !CURSOR_SHAPE.test(id)) return { refused: 'expired' };
  const state = await store.takeOnce(cursorKey(id));
  if (!state) {
    const used = await store.get(usedKey(id)).catch(() => null);
    return { refused: used ? 'in-use' : 'expired' };
  }
  if (!state || state.v !== 1) return { refused: 'expired' };
  await store.set(usedKey(id), { at: Date.now() }, { ttlSeconds: USED_TTL_SECONDS }).catch(() => {});
  return { state };
}

/* A page that failed upstream gives its cursor back, so Load More can be
   tried again rather than the search having to be paid for twice. */
async function giveBack(id, state) {
  await store.set(cursorKey(id), state, { ttlSeconds: CURSOR_TTL_SECONDS });
  await store.remove(usedKey(id)).catch(() => {});
}

module.exports = {
  MAX_PAGES,
  CURSOR_TTL_SECONDS,
  MAX_SEEN,
  urlKey,
  nameKey,
  keysOf,
  unseen,
  supports,
  issue,
  take,
  giveBack
};
