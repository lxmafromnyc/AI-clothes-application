/* =========================================================
   Fynd — which of a saved garment's measurements a comparison uses

   A garment the shopper owns may keep, beside the form's own
   measurement of a dimension, one taken another legitimate way
   (assets/fit-profile-schema.js ALTERNATE_MEASURES): length or sleeve
   from the centre back of the neck, shoulders at their broadest. Retailers
   publish one or the other. Before any comparison, select() looks at the
   product's own garment chart and, dimension by dimension, hands the
   engine the measurement taken exactly the way that chart measures:

     the chart's method is the garment's own   the garment's own (unchanged)
     the chart's method is a kept alternate's  that alternate, with its method
     anything else                             the garment's own (unchanged)

   Nothing is converted, estimated or filled in; a value is only ever
   one the shopper measured, with the method they measured it by. The
   engine and the decision (./engine.js compare, ./decision.js decide)
   are unchanged and receive the same selected profile. With no
   alternates, select() returns the very profile it was given.

   request(compared, selected, record) says which alternates to ask for,
   and only when they would help: the comparison stopped at
   "too-few-dimensions", the reference is the shopper's own measurements,
   each asked-for dimension was skipped because the chart measures it by
   that alternate's method, and with them the engine's own eligibility
   rule (enoughToRecommend: three, the chest among them) would be met.
   Otherwise null — nothing that cannot improve the comparison is asked.
   ========================================================= */

'use strict';

const engine = require('./engine');
const methods = require('./methods');
const ProfileSchema = require('../../assets/fit-profile-schema.js');

const chartMethod = (record, d) => {
  const g = record && record.charts && record.charts.garment;
  return g && g.dimensions && g.dimensions[d] ? g.dimensions[d].method : null;
};
/* the method each of the garment's own measurements was taken by, as the engine reads it */
const ownMethod = (anchor, d) => (anchor.methods && typeof anchor.methods[d] === 'string' ? anchor.methods[d] : ProfileSchema.GARMENT_MEASURES[d].method);

function select(profile, record) {
  const none = { profile, used: [], category: null };
  if (!record || !record.charts || !record.charts.garment) return none;
  const found = engine.referenceEntry(profile, record.category);
  const anchor = found && found.entry.anchor;
  const alternates = anchor && anchor.measurements && Array.isArray(anchor.alternates) ? anchor.alternates : [];
  if (!alternates.length) return Object.assign(none, { category: found ? found.category : null });
  const chosen = alternates.filter((a) => {
    const spec = ProfileSchema.ALTERNATE_MEASURES[a.dimension];
    return spec && a.method === spec.method && typeof a.value === 'number'
      && chartMethod(record, a.dimension) === a.method && ownMethod(anchor, a.dimension) !== a.method;
  });
  if (!chosen.length) return Object.assign(none, { category: found.category });
  const measurements = Object.assign({}, anchor.measurements);
  /* every measurement given keeps a named method; the chosen ones take their own */
  const named = { registry: (anchor.methods && Number.isInteger(anchor.methods.registry)) ? anchor.methods.registry : methods.REGISTRY_VERSION };
  ProfileSchema.GARMENT_MEASURE_KEYS.forEach((d) => { if (typeof measurements[d] === 'number') named[d] = ownMethod(anchor, d); });
  chosen.forEach((a) => { measurements[a.dimension] = a.value; named[a.dimension] = a.method; });
  const entry = Object.assign({}, found.entry, { anchor: Object.assign({}, anchor, { measurements, methods: named }) });
  return {
    profile: Object.assign({}, profile, { garments: Object.assign({}, profile.garments, { [found.category]: entry }) }),
    used: chosen.map((a) => ({ dimension: a.dimension, method: a.method })),
    category: found.category
  };
}

function request(compared, selected, record) {
  if (!compared || compared.status !== 'insufficient' || !Array.isArray(compared.missing) || !compared.missing[0] || compared.missing[0].code !== 'too-few-dimensions') return null;
  const profile = selected && selected.profile;
  const found = engine.referenceEntry(profile, record.category);
  const anchor = found && found.entry.anchor;
  if (!anchor || !anchor.measurements) return null;
  /* a reference Fynd reads from its own checked record of the product named, not the shopper's measurements: alternates can't help */
  const match = engine.matchProduct(anchor, require('./records').RECORDS, found.category, { exact: true });
  if (match && require('./schema').isVerified(match.record)) return null;
  const shared = Array.isArray(compared.dimensionsShared) ? compared.dimensionsShared : [];
  const skipped = Array.isArray(compared.notCompared) ? compared.notCompared : [];
  const have = new Set((anchor.alternates || []).map((a) => `${a.dimension}>${a.method}`));
  const wanted = skipped.filter((s) => {
    const spec = ProfileSchema.ALTERNATE_MEASURES[s.dim];
    return spec && (s.code === 'method-mismatch' || s.code === 'reference-missing')
      && chartMethod(record, s.dim) === spec.method && !have.has(`${s.dim}>${spec.method}`);
  }).map((s) => s.dim);
  if (!wanted.length || !engine.enoughToRecommend(shared.concat(wanted))) return null;
  const unit = anchor.measurements.unit;
  return {
    garmentType: found.category,
    unit,
    retailer: record.brand || null,
    dimensions: wanted.map((d) => {
      const spec = ProfileSchema.ALTERNATE_MEASURES[d];
      return { dimension: d, method: spec.method, label: spec.label, how: spec.how, range: ProfileSchema.methodRange(found.category, d, spec.method, unit) };
    })
  };
}

module.exports = { select, request };
