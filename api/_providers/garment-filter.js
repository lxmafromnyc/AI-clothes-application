/* =========================================================
   Fynd — the one semantic check a live result must pass

   Every live result has already passed the verification gate
   (product-source.js): a title, a price, an https photo, the shop's own
   product page. None of that says it is the garment the shopper asked
   for, and the provider's order is not a promise that it is. A live run
   showed "adidas ... Cropped Track Top" first for "cropped track jacket"
   — a verified product, and a top.

   So the semantic reader catalogue discovery uses (semanticMatch in
   scripts/fetch-catalog-images.js) is asked about each result, and a
   result is removed only when it is plainly a different garment:

     * the reader says `contradiction`, ON THE GARMENT — a different
       family (a top for a jacket) or a different type (a sweatshirt for a
       hoodie). A disagreement over a detail — length, cut, colour,
       gender, fibre — is not a different garment, and is kept.
     * against EVERY garment the request names. The interpreter may file
       the shopper's "pants" as trousers; the shopper's own word still
       counts, and a jogger that contradicts "trouser" but not "pants" is
       kept. The more readings, the rarer a removal.
     * named, not inferred: a type the reader worked out from a fibre or
       a make ("Merino Crew Sweatshirt" read as a knit sweater) is its
       judgement, not the title's word, and removes nothing.
     * and not when the result is a KIND of the garment asked for. A
       puffer is a jacket and a hoodie is a sweatshirt (the `within` of
       each type), so "black jacket" never loses its puffers, though the
       reader, asked strictly, calls them a different type.

   * and not when it is one of the concepts a descriptive request most
     likely means (intent.concepts.alternatives): those are garments the
     request asked for in other words.

   And one removal of a different kind, before any of that: a listing
   that IS what the request ruled out is removed whatever else it is — a
   coat for "something warm but not a coat", a hoodie for "like a hoodie
   without the hood" (intent.concepts.drop), and a listing that carries a
   fit, colour, feature or material the request ruled out in so many
   words: "Skinny Jeans" for "pants that aren't skinny", "Big Logo Hoodie"
   for "hoodie with no logo", "Black Midi Dress" for "a dress that isn't
   black" (intent.concepts.without). An exclusion the shopper stated is a
   constraint, not a preference: ranked last, it would still be shown
   whenever the page is short. Only the words a listing would carry are
   ever in that list; "not too fancy" puts nothing there and removes
   nothing.

   Nothing else is removed. A listing the reader cannot read, one it
   calls unproven ("Short Jacket" for a puffer) and one that is only
   pending a detail all stay, where the provider put them. Nothing is
   reordered and nothing is added: the order is the provider's, less the
   removals.
   ========================================================= */

'use strict';

const { queryFrom } = require('./query');

let reader = null;
function semantics() {
  if (!reader) reader = require('../../scripts/fetch-catalog-images.js');
  return reader;
}

const listOf = (value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value : []);
const text = (value) => (value === undefined || value === null ? '' : String(value).trim());

/* the garments the request names, each as a phrase the reader can read:
   the whole search phrase (so "puffy jacket" is read as one garment),
   each garment the intent names, and each of the shopper's own words that
   names a garment of the same family as one of those ("pants" beside the
   interpreter's "trousers"). A word of another family is a descriptor the
   reader happens to know as a garment — the "short" of "short puffy
   jacket" — and is not a garment the shopper asked for. */
function requestedGarments(intent) {
  const { readGarment } = semantics();
  const i = intent && typeof intent === 'object' ? intent : {};
  /* only a request that NAMES a garment has one to contradict. A category
     is the catalogue's filing (a hoodie is filed under "knit") and a
     keyword may be a fabric ("knit"); neither is the shopper naming a
     garment, and neither alone removes anything */
  if (!listOf(i.garments).some((one) => text(one))) return [];
  const seen = new Set();
  const wanted = [];
  const families = new Set();
  const add = (phrase, test) => {
    const said = text(phrase);
    if (!said || seen.has(said.toLowerCase())) return;
    const read = readGarment(said, {});
    if (!read.type || (test && !test(read))) return;
    seen.add(said.toLowerCase());
    wanted.push(said);
    families.add(read.family);
  };
  add(queryFrom(i));
  listOf(i.garments).forEach((one) => add(one));
  listOf(i.keywords).forEach((one) => add(one, (read) => families.has(read.family)));
  /* and what a descriptive request most likely means: a crewneck
     sweatshirt is not a hoodie, but it is what "something like a hoodie
     but cleaner" asked for, so it is not removed as a different garment.
     Only ever widening — another garment to be measured against can only
     keep a result, never remove one. */
  const concepts = i.concepts && typeof i.concepts === 'object' ? i.concepts : null;
  if (concepts) {
    listOf(concepts.alternatives).forEach((one) => add(one));
    /* and the everyday words that cover more than the shop word they are
       filed under: a person asking for "a shirt" in their own words means
       a tee as often as a button-up, and a "pullover" is any top pulled
       over the head. Only for a request in a person's own words — one in
       shop words is held to them as it always was. */
    const said = listOf(i.keywords).concat(listOf(i.descriptors), listOf(concepts.terms), listOf(concepts.extra)).join(' ').toLowerCase();
    /* only when the reading chose no concept of its own: "a clean white
       shirt that looks expensive" was read as an oxford, not a tee */
    const chose = listOf(concepts.alternatives).some((one) => one !== 'shirt');
    if (listOf(i.garments).includes('shirt') && !chose && !/button|oxford|dress shirt|collar|flannel/.test(said)) add('t-shirt');
    if (listOf(i.garments).includes('sweater') && /pullover/.test(said)) add('sweatshirt');
  }
  return wanted;
}

/* what the request ruled out, as the words a listing that IS one would
   carry: "coat" and "parka" for "not a coat", "hood" and "hoodie" for
   "without the hood" */
function ruledOutWords(intent) {
  const concepts = intent && intent.concepts && typeof intent.concepts === 'object' ? intent.concepts : null;
  if (!concepts) return [];
  const words = listOf(concepts.drop).concat(listOf(concepts.without)).map((w) => text(w).toLowerCase()).filter(Boolean);
  return [...new Set(words)];
}

const titleWords = (title) => new Set(String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
  .map((w) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w)));
const names = (title, word) => { const own = titleWords(title); return word.split(' ').every((w) => own.has(w.replace(/s$/, '')) || own.has(w)); };

/* A type the result is a kind of: puffer within jacket and coat, hoodie
   within sweatshirt. */
function isKindOf(offeredType, wantedType) {
  const entry = semantics().GARMENT_TYPES.find((one) => one.type === offeredType);
  return Boolean(entry && (entry.within || []).includes(wantedType));
}

/* the verdict on one title against one requested garment: a reason to
   remove it, or null */
function contradiction(phrase, title) {
  let verdict;
  try {
    verdict = semantics().semanticMatch({ name: phrase }, { title });
  } catch (err) {
    return null;
  }
  if (!verdict || verdict.ok || verdict.kind !== 'contradiction' || verdict.on !== 'garment') return null;
  const { wanted, offered } = verdict;
  if (!wanted || !offered) return null;
  if (isKindOf(offered.type, wanted.type)) return null;
  /* explicit on both sides: the garment each NAMES, not one inferred from
     its fibre ("Merino Crew Sweatshirt" read as a sweater) or its make */
  if (wanted.madeAs || offered.madeAs || wanted.typeVia !== 'name' || offered.typeVia !== 'name') return null;
  return String(verdict.why || '').slice(0, 200);
}

/* `products` in the provider's order, less the ones plainly a different
   garment from every one the request names. `removed` says which, where
   each stood, and why. */
function withoutContradictions(products, intent) {
  const list = Array.isArray(products) ? products : [];
  let wanted;
  try {
    wanted = requestedGarments(intent);
  } catch (err) {
    wanted = [];
  }
  const ruledOut = ruledOutWords(intent);
  if (!wanted.length && !ruledOut.length) return { products: list, removed: [], checked: false };

  const kept = [];
  const removed = [];
  list.forEach((product, at) => {
    const title = text(product && product.name);
    const entry = (why, kind) => ({ name: title, retailer: product.retailer || product.brand || null, productUrl: product.productUrl, position: at + 1, why, kind });
    /* first what the shopper said they do not want: a listing that IS a
       garment they ruled out goes, whatever else it is */
    const named = title ? ruledOut.find((word) => names(title, word)) : null;
    if (named) { removed.push(entry(`the request ruled out "${named}"`, 'ruled-out')); return; }
    if (!wanted.length) { kept.push(product); return; }
    const reasons = title ? wanted.map((phrase) => contradiction(phrase, title)) : [null];
    if (reasons.every(Boolean)) removed.push(entry(reasons[0], 'contradiction'));
    else kept.push(product);
  });
  return { products: kept, removed, checked: true };
}

module.exports = { withoutContradictions, requestedGarments, isKindOf };
