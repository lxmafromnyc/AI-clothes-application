/* =========================================================
   Fynd — test helper: records marked checked and approved, in memory

   No production record is both verified and approved (api/_sizing/
   approvals.json is empty), so production compares none of their
   garment measurements. A test of the engine's, the endpoint's or the
   interface's own logic on real published numbers stands in an approved
   copy of the live record for its own duration only — in that
   process's memory, never on disk — and puts the original back however
   it ends, a thrown error or a rejected promise included.

     asChecked(ids, fn)   runs fn (sync or async) with those records
                          replaced by approved copies, then restores
     approvedCopy(r)      a copy of r, verified, its review done, and an
                          in-memory approval for it (approveInMemory)
     approveInMemory(r)   adds an approval for r to the schema's list in
                          this process's memory; returns a function that
                          takes it out again
     UQ_PAIR              the two UNIQLO record ids

   Nothing is assumed: a copy keeps the record's own construction, so a
   record that doesn't say how its sleeves are attached (UNIQLO's, Zara's)
   still has its seam measurements left out (schema.garmentEligibility).

   Isolation: asChecked never touches the shared catalogue, sizing.RECORDS
   (frozen: no entry can be added, removed, replaced or changed). It builds
   an isolated collection — the catalogue's records with the named ones
   replaced by approved copies — and runs the callback inside
   sizing.withCollection(), so the engine, the decision and the endpoints,
   which read sizing.all() and sizing.byId(), see that collection for the
   callback's duration. Nothing is written to a file; test-sizing proves
   the shared list and every production record are unchanged throughout.

   The approval's approver names a fixture, and its evidence points at no
   archive: it exists only so a test can reach the logic past the gate.
   test-sizing proves the committed approvals list holds no such entry.
   ========================================================= */

'use strict';

const sizing = require('../../api/_sizing/records');
const schema = require('../../api/_sizing/schema');

const UQ_PAIR = ['uniqlo-e475378-sweat-pullover-hoodie-us', 'uniqlo-e475377-sweatshirt-us'];
const FIXTURE_APPROVER = 'Fixture reviewer (in-memory, test only)';

function approveInMemory(record) {
  const entry = {
    recordId: record.id,
    contentHash: schema.contentHash(record),
    approvedBy: FIXTURE_APPROVER,
    approvedAt: '2026-11-26',
    evidence: schema.citedUrls(record).map((url) => ({ url, archive: 'none: in-memory test fixture', sha256: '0'.repeat(64) }))
  };
  schema.APPROVALS.push(entry);
  return () => { const i = schema.APPROVALS.indexOf(entry); if (i >= 0) schema.APPROVALS.splice(i, 1); };
}

/* How a test states a garment's sleeves, when its subject needs seam measurements compared: test
   data, named as such in its own source — never the brand's word, never applied unless a test asks. */
const FIXTURE_CONSTRUCTION = (sleeve) => ({ sleeve, notes: null, source: `TEST FIXTURE: ${sleeve} stated for this test; not the brand's word` });

/* a copy with its approval; `release` takes the approval out again. opts.construction states the
   copy's sleeves as test data (FIXTURE_CONSTRUCTION) — only when the test asks */
function approvedCopy(record, opts) {
  const copy = JSON.parse(JSON.stringify(record));
  if (opts && opts.construction) copy.construction = FIXTURE_CONSTRUCTION(opts.construction);
  if (copy.review) copy.review.status = 'done';
  copy.verification = { status: 'verified', checkedBy: FIXTURE_APPROVER, checkedAt: '2026-11-26' };
  const release = approveInMemory(copy);
  Object.defineProperty(copy, 'release', { value: release, enumerable: false });
  return copy;
}

function asChecked(ids, fn, opts) {
  /* built on the collection readers see now: the shared catalogue, or — called inside another asChecked — that one's
     isolated collection, so a nested call keeps the outer call's approved copies */
  const current = sizing.all();
  ids.forEach((id) => { if (!current.some((r) => r.id === id)) throw new Error(`asChecked: no record ${id}`); });
  const copies = ids.map((id) => Object.freeze(approvedCopy(current.find((r) => r.id === id), opts)));
  /* an isolated collection: the current records, the named ones as their approved copies */
  const isolated = current.map((r) => copies.find((c) => c.id === r.id) || r);
  const release = () => copies.forEach((c) => c.release());
  let out;
  try { out = sizing.withCollection(isolated, fn); } catch (err) { release(); throw err; }
  if (out && typeof out.then === 'function') return out.finally(release);
  release();
  return out;
}

module.exports = { asChecked, approvedCopy, approveInMemory, UQ_PAIR, FIXTURE_APPROVER, FIXTURE_CONSTRUCTION };
