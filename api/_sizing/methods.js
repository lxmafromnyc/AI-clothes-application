/* =========================================================
   Fynd — how a measurement was taken: the canonical methods

   The one list of measurement methods Fynd knows, and the one rule for
   when two measurements may be set beside each other. The sizing
   records' schema (./schema.js), the size engine (./engine.js), the
   decision (./decision.js) and the shopper's reference garment (the fit
   profile, assets/fit-profile-schema.js, whose form measures by the
   methods marked `reference` here) all read it.

   A method id never changes meaning. A new way of measuring gets a new
   id; REGISTRY_VERSION goes up when the list changes, and a saved
   reference records the version its methods were named under.

   ---------------------------------------------------------
   When two measurements are comparable (relation)
   ---------------------------------------------------------
     same          the same dimension, by the same method
     convertible   chest only: a flat width and a circumference, related
                   by a stated factor (× 2) — the result is an estimate,
                   and is always said to be one
     null          anything else: different points measured from (a
                   sleeve from the centre back is not one from the
                   shoulder seam; a length from the centre back is not
                   one from the top of the shoulder; the broadest part
                   of the shoulders need not be the seams), a method not
                   stated (never comparable, not even with another not
                   stated), or a body measurement beside a garment one

   Matching methods say two numbers measure the same thing. They don't
   say a garment will fit: fabric, stretch and cut aren't measured here.
   ========================================================= */

'use strict';

const REGISTRY_VERSION = 1;

/* per dimension: each method's kind, what it measures in words, and
   whether the shopper's reference form measures by it */
const METHODS = {
  chestWidth: {
    'flat-width-armpit-to-armpit': { kind: 'flat', words: 'flat, straight across from armpit to armpit', reference: true },
    'garment-circumference': { kind: 'circumference', words: 'all the way around the chest' },
    'not-stated': { kind: 'unknown', words: 'by a method the source doesn’t state' }
  },
  bodyLength: {
    'center-back-to-hem': { kind: 'length', words: 'from the centre of the back of the neck to the hem' },
    'high-point-shoulder-to-hem': { kind: 'length', words: 'from the top of the shoulder, beside the collar, to the hem', reference: true },
    'not-stated': { kind: 'unknown', words: 'by a method the source doesn’t state' }
  },
  sleeveLength: {
    'center-back-to-cuff': { kind: 'length', words: 'from the centre of the back of the neck to the cuff' },
    'shoulder-seam-to-cuff': { kind: 'length', words: 'from the shoulder seam to the cuff', reference: true },
    'not-stated': { kind: 'unknown', words: 'by a method the source doesn’t state' }
  },
  shoulderWidth: {
    'seam-to-seam': { kind: 'width', words: 'across the back, from one shoulder seam to the other', reference: true },
    'broadest-part-of-shoulders': { kind: 'width', words: 'across the broadest part of the shoulders' },
    'not-stated': { kind: 'unknown', words: 'by a method the source doesn’t state' }
  }
};
/* a body chart's own measurement: who a size is cut for, never a garment */
const BODY_METHODS = { chest: { 'body-circumference': { kind: 'body', words: 'around the body' } } };

const DIMENSIONS = Object.keys(METHODS);
const NOT_STATED = 'not-stated';

/* the stated conversions: chest flat width ↔ circumference, by 2 */
const CONVERSIONS = {
  chestWidth: {
    'flat-width-armpit-to-armpit>garment-circumference': { factor: 2, estimated: 'chest around, as twice its flat width' },
    'garment-circumference>flat-width-armpit-to-armpit': { factor: 0.5, estimated: 'chest flat width, as half its way around' }
  }
};

const methodsOf = (dim) => Object.keys(METHODS[dim] || {});
const isMethod = (dim, id) => Boolean(METHODS[dim] && Object.prototype.hasOwnProperty.call(METHODS[dim], id));
/* the method the shopper's reference form measures each dimension by */
const REFERENCE_METHODS = Object.fromEntries(DIMENSIONS.map((d) => [d, methodsOf(d).find((id) => METHODS[d][id].reference)]));

/* how a value measured `from` relates to one measured `to`, for one
   dimension: { relation: 'same' } | { relation: 'convertible', factor,
   estimated } | null — never comparable */
function relation(dim, from, to) {
  if (!isMethod(dim, from) || !isMethod(dim, to)) return null;
  if (from === NOT_STATED || to === NOT_STATED) return null;
  if (from === to) return { relation: 'same' };
  const c = CONVERSIONS[dim] && CONVERSIONS[dim][`${from}>${to}`];
  return c ? Object.assign({ relation: 'convertible' }, c) : null;
}

/* every method's kind, by id, across dimensions (ids are unique per kind) */
const METHOD_KINDS = Object.assign({}, ...DIMENSIONS.map((d) => Object.fromEntries(methodsOf(d).map((id) => [id, METHODS[d][id].kind]))),
  { 'body-circumference': 'body' });
const methodKind = (id) => METHOD_KINDS[id] || 'unknown';
/* each method in a few words, as the engine's reasons say it */
const SHORT_WORDS = {'flat-width-armpit-to-armpit': 'flat, armpit to armpit', 'garment-circumference': 'all the way around', 'center-back-to-hem': 'from the centre back', 'high-point-shoulder-to-hem': 'from the top of the shoulder', 'center-back-to-cuff': 'from the centre back', 'shoulder-seam-to-cuff': 'from the shoulder seam', 'seam-to-seam': 'seam to seam', 'broadest-part-of-shoulders': 'across the broadest part of the shoulders'};
SHORT_WORDS['body-circumference'] = 'around the body';
SHORT_WORDS['not-stated'] = 'by a method not stated';
/* each method in plain words, as the engine and the page say it */
const methodWords = (dim, id) => (isMethod(dim, id) ? METHODS[dim][id].words : (BODY_METHODS.chest[id] ? BODY_METHODS.chest[id].words : null));

module.exports = { SHORT_WORDS, REGISTRY_VERSION, METHODS, BODY_METHODS, DIMENSIONS, NOT_STATED, CONVERSIONS, REFERENCE_METHODS, methodsOf, isMethod, relation, METHOD_KINDS, methodKind, methodWords };
