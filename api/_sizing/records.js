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
  require('./records/carhartt-k124-loose-fit-midweight-crewneck-us.json')
];

const problems = [];
const RECORDS = [];
FILES.forEach((record) => {
  const errors = schema.validate(record);
  if (errors.length) problems.push({ id: record && record.id, errors });
  else RECORDS.push(Object.freeze(record));
});

const byId = (id) => RECORDS.find((r) => r.id === id) || null;

/* What a shopper may see about the records: what they are, and whether
   anybody has checked them. */
const summary = (record) => ({
  id: record.id,
  brand: record.brand,
  name: record.product.name,
  category: record.category,
  line: record.line,
  region: record.region,
  verified: schema.isVerified(record),
  charts: Object.keys(record.charts)
});

module.exports = { RECORDS, byId, summary, problems };
