/* =========================================================
   Fynd — the search phrase a provider is asked

   One function for every adapter, so SerpApi, Serper and OpenWeb Ninja
   are asked the same question for the same intent.

   Only terms the shopper's own request produced are used. Nothing is
   added, and `season` is left out on purpose: it reads as a keyword to
   the search engine ("fall hoodie") and would narrow results on a word
   the shopper used descriptively rather than as a product attribute.
   No Google search operator is added either: a quoted phrase or a site:
   filter would be Fynd deciding what the shopper meant.

   Two things an intent can carry are the CATALOGUE's words rather than
   the shopper's, and a shop has never titled anything with them:

     categories   the catalogue's filing — a hoodie is filed under
                  "knit", a blazer under "jacket". When the intent names
                  the garment itself, the filing is left out: "green
                  oversized hoodie" is asked, not "green oversized knit
                  hoodie".
     colour       the catalogue's colour families — "earth" for brown,
     families     "neutral" for beige. When the shopper's own words came
                  with the intent, those carry the colour they used, and
                  the family is left out.
   ========================================================= */

'use strict';

const TERM_ORDER = ['gender', 'colors', 'fits', 'styles', 'brands', 'descriptors', 'garments', 'categories', 'occasions', 'keywords'];
const MAX_TERMS = 12;
const COLOUR_FAMILIES = new Set(['neutral', 'earth', 'pastel', 'bright']);

const text = (value) => (value === undefined || value === null ? '' : String(value).trim());
const listOf = (value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value : []);
const said = (value) => listOf(value).some((one) => text(one));

function queryFrom(intent) {
  const i = intent && typeof intent === 'object' ? intent : {};
  const named = said(i.garments);
  const ownWords = said(i.keywords);

  const parts = [];
  for (const field of TERM_ORDER) {
    if (field === 'categories' && named) continue;
    for (const value of listOf(i[field])) {
      if (field === 'colors' && ownWords && COLOUR_FAMILIES.has(text(value).toLowerCase())) continue;
      parts.push(value);
    }
  }

  /* a term whose every word the phrase already has adds nothing: the
     shopper's "double breasted" after the descriptor "double-breasted" */
  const words = new Set();
  const wordsOf = (term) => term.split(/[^a-z0-9$]+/).filter(Boolean);
  const terms = [];
  for (const part of parts) {
    const term = text(part).toLowerCase();
    if (!term || term.length < 2) continue;
    const own = wordsOf(term);
    if (own.length && own.every((word) => words.has(word))) continue;
    own.forEach((word) => words.add(word));
    terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms.join(' ');
}

module.exports = { queryFrom, TERM_ORDER, MAX_TERMS, COLOUR_FAMILIES };
