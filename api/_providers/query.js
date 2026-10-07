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

   A DESCRIPTIVE request is asked differently. "Something like a hoodie
   but cleaner" carries `concepts` (assets/interpret.js, readConcepts):
   the names shops use for what it most likely means. Its words —
   "something", "like", "but", "cleaner" — are not asked at all, because
   no shop titles anything with them. What is asked is, in order:

     1. the hard constraints: gender, colour in the shopper's own words,
        brand, and the garment descriptors the shopper said ("linen")
     2. their fit word, if they said one ("relaxed" for "loose")
     3. at most one style word ("minimal", "cozy", "vintage style")
     4. the strongest concept and at most two more, strongest first —
        and for a request that NAMED its garment ("a hoodie but
        cleaner"), only kinds of that garment
     5. at most one word left over that nothing above understood

   — one readable phrase, for one search. Never every synonym: a search
   engine asked for twelve garments at once answers with none of them.
   An intent without concepts gets exactly the phrase it always got.
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
  const concepts = shapeConcepts(i.concepts);
  if (concepts) return conceptQuery(i, concepts);
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

/* ---------- the concepts of a descriptive request ----------

   Read by assets/interpret.js and carried through the browser, so what
   arrives here is held to the shape it was sent in: strings only, a few
   of each, and short. A caller can already put any word it likes in
   `keywords`, so nothing here is new reach — but nothing here grows the
   search phrase without bound either. */
const CONCEPT_MODES = new Set(['comparative', 'hybrid', 'described', 'context', 'open']);
const CONCEPT_SIGNALS = new Set(['polished', 'minimal', 'cozy', 'casual', 'vintage', 'affordable', 'relaxed', 'fitted', 'short']);
const CONCEPT_LISTS = { alternatives: 6, search: 3, signals: 9, fit: 3, context: 4, beside: 12, avoid: 12, colors: 4, extra: 3 };
const MAX_CONCEPT_CHARS = 40;
const MAX_CONCEPT_WORDS = 12;
const QUERY_CONCEPTS = 3;

const shortText = (value) => {
  if (typeof value !== 'string') return '';
  const one = text(value).toLowerCase().replace(/\s+/g, ' ');
  return one && one.length <= MAX_CONCEPT_CHARS ? one : '';
};

function shapeConcepts(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {
    mode: CONCEPT_MODES.has(text(raw.mode)) ? text(raw.mode) : null,
    anchor: shortText(raw.anchor) || null,
    style: shortText(raw.style) || null
  };
  for (const [field, most] of Object.entries(CONCEPT_LISTS)) {
    const seen = [];
    for (const value of listOf(raw[field])) {
      const one = shortText(value);
      if (!one || seen.includes(one)) continue;
      if (field === 'signals' && !CONCEPT_SIGNALS.has(one)) continue;
      seen.push(one);
      if (seen.length >= most) break;
    }
    out[field] = seen;
  }
  /* a reading with nothing in it to search for or to take out is no reading */
  if (!out.mode || !(out.alternatives.length || out.context.length)) return null;
  return out;
}

/* a term that only describes the setting: "black" or "wide-leg" when
   what the shopper said was "with my black wide leg jeans" */
const describesSetting = (term, concepts) => {
  const own = text(term).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return own.length > 0 && own.every((word) => concepts.beside.includes(word));
};

function conceptQuery(i, concepts) {
  const parts = [];
  if (text(i.gender)) parts.push(i.gender);
  /* colour: the shopper's own words when the reader found them, else the
     interpreter's colours less the catalogue's families — and never a
     colour that belongs to the garment it is worn with */
  const colours = concepts.colors.length
    ? concepts.colors
    : listOf(i.colors).filter((c) => !COLOUR_FAMILIES.has(text(c).toLowerCase()) && !describesSetting(c, concepts));
  const descriptors = listOf(i.descriptors).filter((d) => !describesSetting(d, concepts));
  parts.push(...colours, ...listOf(i.brands), ...descriptors, ...concepts.fit);
  if (concepts.style) parts.push(concepts.style);

  /* a garment the shopper named as the thing, and the kinds of it the
     reader put first, go in; garments named only as a setting never do */
  const searched = concepts.search.length ? concepts.search : concepts.alternatives;
  parts.push(...searched.slice(0, QUERY_CONCEPTS));
  if (!searched.length) parts.push(...listOf(i.garments));
  parts.push(...concepts.extra.slice(0, 1));

  const words = new Set();
  const terms = [];
  const context = new Set(concepts.context);
  for (const part of parts) {
    const term = text(part).toLowerCase();
    if (!term || term.length < 2 || context.has(term)) continue;
    const own = term.split(/[^a-z0-9$]+/).filter(Boolean);
    if (own.length && own.every((word) => words.has(word))) continue;
    if (terms.length && words.size + own.length > MAX_CONCEPT_WORDS) break;
    own.forEach((word) => words.add(word));
    terms.push(term);
  }
  return terms.join(' ');
}

module.exports = { queryFrom, shapeConcepts, conceptQuery, describesSetting, TERM_ORDER, MAX_TERMS, COLOUR_FAMILIES, QUERY_CONCEPTS };
