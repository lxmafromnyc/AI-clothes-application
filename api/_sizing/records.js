/* =========================================================
   Fynd — the sizing records this deployment knows

   Listed by name, so the bundler ships exactly these and nothing is read
   from the file system at run time. Each is validated as it loads; one
   that fails is left out and reported, never half-used.
   ========================================================= */

'use strict';

const schema = require('./schema');

const FILES = [
  require('./records/uniqlo-e475378-sweat-pullover-hoodie-us.json'),
  require('./records/uniqlo-e475377-sweatshirt-us.json'),
  require('./records/nike-fn3859-club-pullover-fleece-hoodie-us.json'),
  require('./records/nike-fn3886-club-fleece-crew-us.json'),
  require('./records/carhartt-k121-loose-fit-midweight-hoodie-us.json'),
  require('./records/carhartt-k124-loose-fit-midweight-crewneck-us.json'),
  require('./records/uniqlo-e455365-supima-cotton-tshirt-us.json'),
  require('./records/uniqlo-e471808-sweat-oversized-pullover-hoodie-us.json'),
  require('./records/nike-ih1121-premium-essentials-tshirt-us.json'),
  require('./records/hm-0685816-regular-fit-tshirt-us.json'),
  require('./records/zara-01887411-basic-medium-weight-tshirt-us.json'),
  require('./records/zara-00761350-basic-relaxed-fit-hoodie-us.json'),
  require('./records/zara-00761810-basic-heavyweight-hoodie-us.json'),
  require('./records/zara-08054370-compact-boxy-fit-hoodie-us.json'),
  require('./records/zara-08054350-relaxed-fit-hoodie-sweatshirt-us.json')
];

const problems = [];
const RECORDS = [];
FILES.forEach((record) => {
  const errors = schema.validate(record);
  if (errors.length) problems.push({ id: record && record.id, errors });
  else RECORDS.push(Object.freeze(record));
});

/* The shared catalogue is frozen: nothing — a request, a test — can add,
   remove, replace or change one of its records. */
Object.freeze(RECORDS);

/* The collection every reader uses (all(), byId()): the shared catalogue,
   unless a test runs inside withCollection(), which gives that callback an
   isolated collection of its own — the shared RECORDS is never touched.
   Production code never calls withCollection.

   Test-only, and for one test at a time. The active collection is a stack:
   a nested call sees its own collection and gives the outer one back when
   it ends — a throw and a rejection included. Two calls that overlap
   without nesting (two callbacks running at once) can't both be right
   about what every reader sees, so the one that ends out of turn is
   refused with an error, and the readers fall back to whatever is still
   genuinely open beneath it — never to a collection that has ended. While
   a callback awaits, anything else running in the same process reads its
   collection: tests run one after another, so nothing else is. */
const stack = [];
let active = RECORDS;
const all = () => active;
function withCollection(records, fn) {
  if (!Array.isArray(records)) throw new Error('withCollection: a list of records');
  const mine = Object.freeze(records.slice());
  stack.push(mine);
  active = mine;
  const restore = () => {
    const at = stack.lastIndexOf(mine);
    const inTurn = at === stack.length - 1;
    if (at >= 0) stack.splice(at, 1);
    active = stack.length ? stack[stack.length - 1] : RECORDS;
    if (!inTurn) throw new Error('withCollection: calls overlapped without nesting — each test needs its own turn');
  };
  let out;
  try { out = fn(); } catch (err) { try { restore(); } catch (e) { /* the callback's own error is the one to see */ } throw err; }
  if (out && typeof out.then === 'function') {
    return out.then((value) => { restore(); return value; }, (err) => { try { restore(); } catch (e) { /* as above */ } throw err; });
  }
  restore();
  return out;
}

const byId = (id) => active.find((r) => r.id === id) || null;

/* What a shopper may see about the records: what they are, and whether
   anybody has checked them. */
const COMPARE_DIMS = ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'];
const summary = (record) => {
  const g = record.charts.garment;
  /* the finished-garment dimensions published for every size, and how */
  const garment = g ? COMPARE_DIMS.filter((d) => g.dimensions[d] && record.sizes.every((s) => g.sizes[s] && g.sizes[s][d]))
    .map((d) => ({ dim: d, method: g.dimensions[d].method })) : [];
  return {
    id: record.id,
    brand: record.brand,
    name: record.product.name,
    category: record.category,
    line: record.line,
    region: record.region,
    sizes: record.sizes,
    url: record.product.url,
    verified: schema.isVerified(record),
    charts: Object.keys(record.charts),
    garmentDimensions: garment,
    garmentOrigin: g ? (g.origin || 'official-published') : null,
    /* a garment-to-garment comparison is possible only with a checked
       record that publishes finished-garment measurements, at least one
       of them eligible (schema.garmentEligibility) */
    comparable: schema.isVerified(record) && garment.some((g) => schema.measurementStatus(record, g.dim) === 'verified')
  };
};

/* How a record's values reached Fynd (schema.js, `capture`), in the
   words every place that shows the record uses. */
function recordFrom(record) {
  const how = (record.capture && record.capture.how) || 'copied-from-page';
  const at = (record.capture && record.capture.at) || record.retrievedAt;
  return {
    'copied-from-page': `copied from ${record.brand}’s page on ${at}`,
    'supplied-transcription': `transcribed from ${record.brand}’s official size guide and supplied to Fynd on ${at} — Fynd hasn’t read the page itself`,
    'browser-extension': `read by the Fynd extension from ${record.brand}’s page on ${at}`,
    'server-read': `read by Fynd from ${record.brand}’s page on ${at}`
  }[how];
}

module.exports = { RECORDS, all, withCollection, byId, summary, problems, recordFrom };
