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
  if (concepts) listOf(concepts.alternatives).forEach((one) => add(one));
  return wanted;
}

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
    return { products: list, removed: [], checked: false };
  }
  if (!wanted.length) return { products: list, removed: [], checked: false };

  const kept = [];
  const removed = [];
  list.forEach((product, at) => {
    const title = text(product && product.name);
    const reasons = title ? wanted.map((phrase) => contradiction(phrase, title)) : [null];
    if (reasons.every(Boolean)) {
      removed.push({ name: title, retailer: product.retailer || product.brand || null, productUrl: product.productUrl, position: at + 1, why: reasons[0] });
    } else {
      kept.push(product);
    }
  });
  return { products: kept, removed, checked: true };
}

module.exports = { withoutContradictions, requestedGarments, isKindOf };
