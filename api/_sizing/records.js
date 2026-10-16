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

const byId = (id) => RECORDS.find((r) => r.id === id) || null;

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
       record that publishes finished-garment measurements */
    comparable: schema.isVerified(record) && garment.length > 0
  };
};

module.exports = { RECORDS, byId, summary, problems };
