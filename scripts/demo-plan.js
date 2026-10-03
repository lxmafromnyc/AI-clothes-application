/* =========================================================
   Fynd demo recorder — what is searched, and what may be shown

   The plan of scripts/record-demo.js, kept apart so it can be tested
   without a browser (scripts/test-record-demo.js):

     SEARCHES      the real searches, in the order a person makes them
     satisfies()   whether a product really is what its search asked for
     editFor()     how a person changes one detail of the last request
     changedEnough whether changing that detail really brought new products
     sameShop()    whether a retailer tab stayed on the product's own shop

   Nothing here draws, fakes or fills anything in. A query whose results
   do not pass is not used; a product that does not pass is never on
   camera; a slot with no usable query is left out, or, if it is
   required, the recording stops.
   ========================================================= */

'use strict';

/* What each search asks for, as a product has to show it: the garment in
   its name, the designer in its brand or name, a price at or under the
   budget. Colour, fit and season are left to the search itself: a
   listing rarely spells them out, and refusing it for that would refuse
   real matches. */
const HOODIE = /\bhood(?:ie|y|ed)s?\b|\bsweatshirts?\b/i;
const DRESS = /\bdress(?:es)?\b/i;
const BAG = /\bbags?\b|\btotes?\b|\bpurses?\b|\bclutch(?:es)?\b|\bhandbags?\b|\bpouch(?:es)?\b|\bsatchels?\b|\bhobos?\b|\bbaguettes?\b|\bcrossbody\b|\bshoulder\b/i;
const PRADA = /\bprada\b/i;

const q = (text, gate) => ({ text, ...gate });

/* The searches, in the order they are made. Each lists real queries to
   try in order; the first the product source answers with enough real
   products that all pass is the one recorded. A query that comes back
   thin is skipped, never padded.

     lines     narration: before   while the last search is put away
                          typing   while it is typed
                          results  while its results are looked through
     open      how many retailer pages it should show; one it cannot get
               (every shop blocked) is owed by the next search
     mode      'edit': the last request is changed by hand instead of
               cleared and retyped, and it must bring different products
     required  whether the recording stops if no query in the slot works

   Only the first query is said out loud, so it is fixed. The others are
   narrated without naming them, so any query here that fits can stand in. */
const SEARCHES = [
  { slot: 'everyday', required: true, open: 2,
    lines: { opening: ['hook', 'describe'], typing: 'hoodie', results: 'stores' },
    queries: [q('black oversized hoodie under $80', { garment: HOODIE, budget: 80 })] },
  { slot: 'refine', required: false, open: 0, mode: 'edit',
    lines: { before: 'refine' },
    queries: [q('black oversized hoodie under $120', { garment: HOODIE, budget: 120 })] },
  { slot: 'different', required: true, open: 1,
    lines: { before: 'different' },
    queries: [
      q('cream linen midi dress for summer', { garment: DRESS }),
      q('white linen midi dress for summer', { garment: DRESS }),
      q('linen midi dress', { garment: DRESS })
    ] },
  { slot: 'designer', required: true, open: 1,
    lines: { typing: 'designer' },
    queries: [
      q('vintage Prada bag under $500', { garment: BAG, brand: PRADA, budget: 500 }),
      q('vintage Prada shoulder bag under $500', { garment: BAG, brand: PRADA, budget: 500 }),
      q('vintage Prada handbag under $500', { garment: BAG, brand: PRADA, budget: 500 }),
      q('vintage Prada nylon bag under $500', { garment: BAG, brand: PRADA, budget: 500 })
    ] },
  { slot: 'sentence', required: true, open: 1,
    lines: { typing: 'sentence' },
    queries: [
      q('oversized cream knit sweater for fall under $100', { garment: /\bsweaters?\b|\bknit\b|\bjumpers?\b|\bpullovers?\b|\bcardigans?\b/i, budget: 100 }),
      q('black leather ankle boots under $150', { garment: /\bboots?\b|\bbooties?\b/i, budget: 150 }),
      q('white linen button down shirt for summer under $60', { garment: /\bshirts?\b/i, budget: 60 }),
      q('high waisted straight leg jeans under $90', { garment: /\bjeans?\b/i, budget: 90 })
    ] }
];

/* null if the product is what the search asked for, otherwise why not.
   `p` is the product as the API answered it: name, brand, price. */
function satisfies(p, gate) {
  const name = String((p && p.name) || '');
  const said = `${(p && p.brand) || ''} ${name}`;
  if (gate.garment && !gate.garment.test(name)) return `"${name}" is not the garment asked for`;
  if (gate.brand && !gate.brand.test(said)) return `"${name}" is not by the designer asked for`;
  if (gate.budget != null) {
    const price = Number(p && p.price);
    if (!Number.isFinite(price)) return `"${name}" has no price to hold against the $${gate.budget} budget`;
    if (price > gate.budget) return `"${name}" costs $${price}, over the $${gate.budget} budget`;
  }
  return null;
}

/* How a person changes the last request into the next: put the cursor at
   the end, delete back to where they differ, type the new ending.
   "…hoodie under $80" → "…hoodie under $120": two backspaces, "120". */
function editFor(from, to) {
  let same = 0;
  while (same < from.length && same < to.length && from[same] === to[same]) same += 1;
  return { keep: from.slice(0, same), erase: from.length - same, type: to.slice(same) };
}

/* Changing a detail is only worth showing if the products change: at
   least `need` of the products in view now (`next`) were not in view
   before (`prev`). Lists of product URLs, in grid order. */
function changedEnough(prev, next, { inView = 4, need = 2 } = {}) {
  const before = new Set(prev);
  const fresh = next.slice(0, inView).filter((u) => !before.has(u));
  return { ok: fresh.length >= need, fresh: fresh.length };
}

/* A retailer tab counts only if it is still on the product's own shop: a
   page that redirected to a different site — another shop, a sign-in
   wall, a regional chooser on another domain — is not the product the
   card linked to. */
function registrable(host) {
  const parts = String(host || '').toLowerCase().replace(/^www\d?\./, '').split('.');
  /* shop.co.uk, shop.com.au: the name is the label before the two-part suffix */
  const twoPart = parts.length > 2 && parts[parts.length - 1].length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(parts[parts.length - 2]);
  return parts.slice(twoPart ? -3 : -2).join('.');
}
function sameShop(href, landed) {
  try {
    return registrable(new URL(href).hostname) === registrable(new URL(landed).hostname);
  } catch (err) {
    return false;
  }
}

module.exports = { SEARCHES, satisfies, editFor, changedEnough, sameShop, registrable };
