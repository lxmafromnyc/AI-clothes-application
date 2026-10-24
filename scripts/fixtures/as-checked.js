/* =========================================================
   Fynd — test helper: the UNIQLO pair, marked checked in memory

   UNIQLO's Sweat Pullover Hoodie (E475378) and Sweatshirt (E475377) are
   pending review (each record's review.needs), so production compares
   none of their garment measurements. A test of the engine's, the
   endpoint's or the interface's own logic on their real published
   numbers marks the live records verified for its own duration only —
   in that process's memory, never on disk — and puts them back however
   it ends, a thrown error or a rejected promise included.

     asChecked(ids, fn)   runs fn (sync or async) with those records
                          verified and their review done, then restores
     UQ_PAIR              the two record ids

   Each loaded record is frozen; its verification and review objects are
   not, so they are changed in place.
   ========================================================= */

'use strict';

const sizing = require('../../api/_sizing/records');

const UQ_PAIR = ['uniqlo-e475378-sweat-pullover-hoodie-us', 'uniqlo-e475377-sweatshirt-us'];

function asChecked(ids, fn) {
  const live = ids.map((id) => sizing.byId(id));
  const saved = live.map((r) => ({ verification: Object.assign({}, r.verification), review: r.review ? Object.assign({}, r.review) : null }));
  live.forEach((r) => {
    Object.assign(r.verification, { status: 'verified', checkedBy: 'Test checker', checkedAt: '2026-10-24' });
    if (r.review) r.review.status = 'done';
  });
  const restore = () => live.forEach((r, i) => {
    Object.keys(r.verification).forEach((k) => delete r.verification[k]);
    Object.assign(r.verification, saved[i].verification);
    if (r.review) { Object.keys(r.review).forEach((k) => delete r.review[k]); Object.assign(r.review, saved[i].review); }
  });
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

module.exports = { asChecked, UQ_PAIR };
