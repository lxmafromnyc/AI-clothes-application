/* =========================================================
   Fynd — the fit decision: one answer, one contract

   decide(profile, target) is the single server-side place a size is
   decided. It does no scoring of its own: it asks the engine's existing
   methods (./engine.js — compare() for a garment the shopper owns,
   recommend() for the rest of the fit profile), each with its own inputs
   and mathematics unchanged, and then holds what they found to one
   policy, the same whichever method answered:

     OK                 the evidence supports a size
     INSUFFICIENT_DATA  something required is missing, incompatible,
                        unverified or unreliable: no size
     NO_MATCH           the evidence is sufficient and comparable, but
                        even the closest size is outside what the
                        engine's own classes call acceptable: no size,
                        the closest named only as explanation

   Every answer carries machine-readable reason codes (REASONS), so no
   page has to read the engine's sentences to know what happened.

   ---------------------------------------------------------
   What "acceptable" means here
   ---------------------------------------------------------
   No new threshold is introduced. A size is unacceptable when the
   engine's own fit classes or tolerances already say so:

     garment vs garment   the chest of the closest size falls outside
                          the "slightly" band of the engine's reference
                          classes (CATEGORY_PARAMS.fitBands.reference:
                          beyond it is "too tight"/"too loose"), or every
                          compared measurement misses its tolerance
                          (compare()'s own "outside-tolerance")
     body plus room       the leading size's chest class is "too tight"
                          or "too loose" at every reading of the
                          shopper's chest range (engine fitBySize)
     body chart           the shopper's chest range reaches no size's own
                          range in the brand's chart — they are beyond
                          its smallest or largest size. Eligibility is
                          the chart's, unmoved; the engine's fit-word
                          shift (sizeOffset) only chooses among the sizes
                          the shopper is eligible for, and is reported as
                          "fit-preference-shift", never as no match. A
                          shopper who reaches the chart only through the
                          mirrored, estimated half of an end size is
                          eligible at low confidence, and said so.

   Those bands are the engine's starting hypotheses, not validated fit
   limits; they are used as the line between a size and no size only
   because they are the classes the engine already shows shoppers. The
   confidence labels are the engine's (low / medium / high): ordinal,
   not calibrated probabilities.

   ---------------------------------------------------------
   Required measurements, by category and method
   ---------------------------------------------------------
   REQUIREMENTS lists, for each category the server holds sizing data
   for, what each method needs. Only hoodies, sweatshirts and T-shirts
   are listed because only they have records and engine parameters
   (schema.js CATEGORIES); any other category — pants, jeans, shorts,
   jackets — is INSUFFICIENT_DATA "category-not-supported" rather than
   held to requirements no data stands behind. A category added later
   adds its own entry.

   ---------------------------------------------------------
   Targets
   ---------------------------------------------------------
     a sizing record (api/_sizing/records)   decided as above
     { chart } as a browser or page read it  (fynd-payload toChart's
       chart, or sizing-tables' shape) never decides a size: it is
       unverified by nature, and its unit or method may be unstated.
       INSUFFICIENT_DATA, with each reason.

   Unverified records never give a decision other than
   INSUFFICIENT_DATA "unverified-data": the evaluation suite's
   includeUnverified is the engine's, not this policy's.
   ========================================================= */

'use strict';

const engine = require('./engine');
const sizingSchema = require('./schema');
const methods = require('./methods');
const ProfileSchema = require('../../assets/fit-profile-schema.js');

const CONTRACT = 'fynd-fit-decision/1';
const OUTCOMES = { OK: 'OK', INSUFFICIENT_DATA: 'INSUFFICIENT_DATA', NO_MATCH: 'NO_MATCH' };
const IN_PER_CM = 1 / 2.54;
const EPS = 1e-9;

/* Every code a decision can carry. `outcome` is the outcome a code
   decides on its own; qualifiers (outcome null) describe the evidence
   behind any answer. */
const REASONS = {
  /* INSUFFICIENT_DATA */
  'no-record': { outcome: 'INSUFFICIENT_DATA', about: 'Fynd holds no valid sizing record for this product.' },
  'category-not-supported': { outcome: 'INSUFFICIENT_DATA', about: 'Fynd holds no sizing data or requirements for this kind of garment.' },
  'unverified-data': { outcome: 'INSUFFICIENT_DATA', about: 'The product\'s (or the reference\'s) measurements haven\'t been checked against their source.' },
  'crowdsourced-data': { outcome: 'INSUFFICIENT_DATA', about: 'The product\'s garment measurements were gathered from shoppers, not the brand.' },
  'unverified-source': { outcome: 'INSUFFICIENT_DATA', about: 'The chart was read from a page and hasn\'t been checked.' },
  'invalid-measurement': { outcome: 'INSUFFICIENT_DATA', about: 'A measurement given isn\'t a number above zero in inches or centimetres.' },
  'measurement-out-of-supported-range': { outcome: 'INSUFFICIENT_DATA', about: 'A measurement given is outside the range Fynd accepts for an adult, in its unit.' },
  'missing-required-measurement': { outcome: 'INSUFFICIENT_DATA', about: 'A measurement the method requires is missing on one side.' },
  'missing-sizing-line': { outcome: 'INSUFFICIENT_DATA', about: 'A size label can\'t be read without knowing men\'s, women\'s or unisex.' },
  'incompatible-methods': { outcome: 'INSUFFICIENT_DATA', about: 'The two sides measured the same dimension differently, with no stated rule between them.' },
  'method-not-stated': { outcome: 'INSUFFICIENT_DATA', about: 'A source doesn\'t say how a measurement was taken.' },
  'unit-not-stated': { outcome: 'INSUFFICIENT_DATA', about: 'A source doesn\'t say whether it is in inches or centimetres; Fynd won\'t infer it for a decision.' },
  'measurement-kind-not-stated': { outcome: 'INSUFFICIENT_DATA', about: 'A chart doesn\'t say whether it measures the body or the garment.' },
  'body-vs-garment': { outcome: 'INSUFFICIENT_DATA', about: 'One side is a body measurement and the other a garment measurement; they aren\'t compared.' },
  'line-not-covered': { outcome: 'INSUFFICIENT_DATA', about: 'Fynd has no sizing for this sizing line on this product.' },
  'conflicting-references': { outcome: 'INSUFFICIENT_DATA', about: 'The shopper\'s measurements and the sizes they said fit point to different sizes.' },
  'incomplete-size-rows': { outcome: 'INSUFFICIENT_DATA', about: 'No size of the product publishes every measurement the comparison needs.' },
  'reference-range-too-wide': { outcome: 'INSUFFICIENT_DATA', about: 'What Fynd knows of the shopper\'s chest is too wide a range to say how the leading size fits.' },
  /* NO_MATCH */
  'outside-size-range': { outcome: 'NO_MATCH', about: 'The shopper is beyond the smallest or largest size\'s chart range.' },
  'chest-outside-acceptable-range': { outcome: 'NO_MATCH', about: 'Even the closest size is too tight or too loose through the chest, by the engine\'s own fit classes.' },
  'all-compared-outside-tolerance': { outcome: 'NO_MATCH', about: 'Every compared measurement of the closest size misses its tolerance.' },
  /* qualifiers */
  'estimated-conversion': { outcome: null, about: 'A circumference was worked out as twice a flat width: an estimate, by the stated rule.' },
  'estimated-chart-range': { outcome: null, about: 'The brand gives one value per size; each size\'s range is Fynd\'s estimate. `mirroredEdge`: the shopper reaches the chart only through the estimated outer half of its smallest or largest size, so confidence is low.' },
  'fit-preference-shift': { outcome: null, about: 'The brand\'s fit words and the shopper\'s fit goal moved the suggestion away from the size the chart puts them in (`chartSizes`); a preference, not an eligibility rule.' },
  'evidence-from-size-label': { outcome: null, about: 'The shopper\'s chest comes from a brand chart for a size they wear, not a measurement.' },
  'fit-goal-assumed': { outcome: null, about: 'The shopper hasn\'t said how they like it to fit; true to size was assumed.' },
  'optional-measurement-not-compared': { outcome: null, about: 'An optional measurement couldn\'t be compared; the required ones were.' },
  'sizes-excluded-incomplete': { outcome: null, about: 'Some sizes publish too few measurements and were left out of the ranking.' },
  'reference-not-comparable': { outcome: null, about: 'The shopper\'s reference garment couldn\'t be compared; the rest of the profile was used.' }
};

/* ---------- what a shopper reads ----------
   REASONS[*].about is for developers. A page that shows a refusal shows
   customerMessage(): words chosen from the reason's code and its data
   (the closest size, which side, which way), never parsed back. */
const sizeWord = (s) => (s ? `size ${s}` : 'any size');
function customerMessage(r, context) {
  const brand = (context && context.brand) || 'this brand';
  switch (r.code) {
    case 'outside-size-range':
      return r.side === 'above-largest'
        ? `Your chest measurement is larger than ${brand}’s largest size (${r.size}) is made for, so Fynd isn’t suggesting a size for this product.`
        : `Your chest measurement is smaller than ${brand}’s smallest size (${r.size}) is made for, so Fynd isn’t suggesting a size for this product.`;
    case 'chest-outside-acceptable-range': {
      const roomier = r.class ? r.class === 'too-loose' : r.differenceAroundIn > 0;
      const against = r.class ? 'the fit you asked for' : 'the garment you compared it with';
      return `Even the closest size, ${sizeWord(r.size)}, would be much ${roomier ? 'roomier' : 'tighter'} through the chest than ${against}, so Fynd isn’t suggesting a size for this product.`;
    }
    case 'all-compared-outside-tolerance':
      return `Even the closest size, ${sizeWord(r.size)}, is noticeably different from the garment you compared it with on every measurement Fynd could check, so Fynd isn’t suggesting a size for this product.`;
    case 'conflicting-references':
      return 'Your chest measurement and the sizes you said fit you point to different sizes. Check them on your fit profile, and Fynd can suggest a size once they agree.';
    case 'measurement-out-of-supported-range':
      return 'One of your measurements is outside the range Fynd can use. Check it, and its unit, on your fit profile.';
    case 'reference-range-too-wide':
      return 'Fynd can’t tell how this product will fit from what it knows about your chest. Adding your chest measurement to your fit profile would let it suggest a size.';
    default:
      return 'Fynd doesn’t have enough reliable sizing information to suggest a size for this product.';
  }
}
const customerMessages = (decision, context) => [...new Set((decision.reasons || []).map((r) => customerMessage(r, context)))];

/* What each method needs, for each category Fynd holds sizing data for.
   `required` must be present on both sides for the method to run;
   `optional` is compared where both sides have it the same way.
   `minimumCompared` is the engine's existing rule (enoughToRecommend:
   three of the four, chest among them) — kept as it stands, not a new
   requirement, and like the bands not yet validated. */
const TOP_REQUIREMENTS = {
  'reference-garment': {
    required: { shopper: ['reference.chestWidth'], target: ['garment.chestWidth'] },
    optional: { shopper: ['reference.bodyLength', 'reference.sleeveLength', 'reference.shoulderWidth'], target: ['garment.bodyLength', 'garment.sleeveLength', 'garment.shoulderWidth'] },
    minimumCompared: 3
  },
  'body-plus-ease': {
    required: { shopper: ['body.chest'], target: ['garment.chestWidth'] },
    /* lengths count only for a "runs short" trouble spot, and only when every size publishes them */
    optional: { shopper: [], target: ['garment.bodyLength', 'garment.sleeveLength'] }
  },
  'body-chart': {
    required: { shopper: ['body.chest'], target: ['body.chest'] },
    optional: { shopper: [], target: [] }
  }
};
const REQUIREMENTS = { hoodies: TOP_REQUIREMENTS, sweatshirts: TOP_REQUIREMENTS, tshirts: TOP_REQUIREMENTS };
const requirementsFor = (category) => (typeof category === 'string' && REQUIREMENTS[category]) || null;

/* ---------- small helpers ---------- */

const reason = (code, extra) => Object.assign({ code }, extra || {});
function uniqueReasons(list) {
  const seen = new Set();
  return list.filter((r) => {
    const key = JSON.stringify(r);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const toInches = (v, unit) => (unit === 'cm' ? v * IN_PER_CM : v);

function result(outcome, fields) {
  const f = fields || {};
  const reasons = uniqueReasons(f.reasons || []);
  const qualifiers = uniqueReasons(f.qualifiers || []);
  return {
    contract: CONTRACT,
    outcome,
    /* only an OK answer names a size */
    size: outcome === OUTCOMES.OK ? f.size || null : null,
    alternative: outcome === OUTCOMES.OK ? f.alternative || null : null,
    /* NO_MATCH: the nearest size, as explanation only — never a recommendation */
    closest: outcome === OUTCOMES.NO_MATCH ? f.closest || null : null,
    /* the engine's ordinal label, not a calibrated probability */
    confidence: outcome === OUTCOMES.OK ? f.confidence || null : null,
    method: f.method || null,
    via: f.via || null,
    category: f.category || null,
    productId: f.productId || null,
    reasons,
    qualifiers,
    /* what was set beside what: "garment-to-garment" (the shopper's own
       garment), "body-to-body-chart", "body-plus-assumed-room", or null */
    comparison: f.comparison || null,
    /* garment to garment: every dimension, compared or not, and why */
    dimensions: f.dimensions || [],
    /* what the method that answered requires, for this category */
    requirements: (requirementsFor(f.category) && f.method && requirementsFor(f.category)[f.method]) || null
  };
}

/* ---------- the shopper's measurements: in the range Fynd accepts ---------- */

/* The engine refuses malformed values itself (invalid-measurements);
   this adds the plausible range the fit profile's validator holds typed
   values to, which a direct call or an old saved profile could miss. */
function outOfRange(profile, category) {
  const out = [];
  const physical = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const m = profile && profile.measurements;
  if (m && physical(m.chest) && (m.unit === 'in' || m.unit === 'cm')) {
    const range = ProfileSchema.rangeOf('chest', m.unit);
    if (range && (m.chest < range[0] || m.chest > range[1])) out.push(reason('measurement-out-of-supported-range', { side: 'shopper', measurement: 'body.chest', value: m.chest, unit: m.unit, range }));
  }
  /* the garments a comparison for this category may read: its own, and
     a sibling fleece top's (engine compare() falls back to it) */
  const family = Object.keys(engine.FAMILY).filter((c) => engine.FAMILY[c] === engine.FAMILY[category]);
  family.forEach((type) => {
    const entry = profile && profile.garments && profile.garments[type];
    const a = entry && entry.anchor && entry.anchor.measurements;
    if (!a || (a.unit !== 'in' && a.unit !== 'cm')) return;
    ProfileSchema.GARMENT_MEASURE_KEYS.forEach((k) => {
      if (!physical(a[k])) return;
      const range = ProfileSchema.measureRange(type, k, a.unit);
      if (range && (a[k] < range[0] || a[k] > range[1])) out.push(reason('measurement-out-of-supported-range', { side: 'shopper', measurement: `reference.${k}`, garment: type, value: a[k], unit: a.unit, range }));
    });
  });
  return out;
}

/* ---------- the engine's codes, as the contract's ---------- */

/* one skipped dimension (engine comparable()) as a reason */
function skippedReason(x) {
  const dim = x.dim;
  switch (x.code) {
    case 'method-mismatch': return reason('incompatible-methods', { dim });
    case 'method-unknown': return reason('method-not-stated', { dim });
    case 'reference-missing': return reason('missing-required-measurement', { dim, side: 'shopper', required: dim === 'chestWidth' });
    case 'target-missing': return reason('missing-required-measurement', { dim, side: 'target', required: dim === 'chestWidth' });
    case 'target-unverified': return reason('unverified-data', { dim, side: 'target' });
    case 'reference-unverified': return reason('unverified-data', { dim, side: 'shopper' });
    default: return null;
  }
}

/* What a compare() that couldn't run says, as reasons. `hasReference`:
   the shopper has a reference at all (so its failure is worth naming). */
function compareReasons(c) {
  const code = c.missing && c.missing[0] && c.missing[0].code;
  const skipped = (c.notCompared || []).map(skippedReason).filter(Boolean);
  switch (code) {
    case 'no-record': return [reason('no-record')];
    case 'category-not-covered': return [reason('category-not-supported')];
    case 'unverified-data': return [reason('unverified-data', { side: 'target' })];
    case 'crowdsourced-data': return [reason('crowdsourced-data', { side: 'target' })];
    case 'invalid-measurements': return [reason('invalid-measurement', { side: 'shopper' })];
    case 'body-chart-only': return [reason('body-vs-garment', { side: 'target' })];
    case 'no-reference': return [reason('missing-required-measurement', { side: 'shopper', measurement: 'reference garment' })];
    case 'no-reference-measurements': return [reason('missing-required-measurement', { side: 'shopper', measurement: 'reference.chestWidth' })];
    case 'too-few-dimensions':
    case 'nothing-comparable': {
      /* enough shared, but no size publishes them all */
      if (Array.isArray(c.unranked) && c.unranked.length) return [reason('incomplete-size-rows', { side: 'target', sizes: c.unranked, dims: c.dimensionsShared || [] })];
      const shared = c.dimensionsShared || [];
      const out = skipped.length ? skipped : [reason('missing-required-measurement', { side: 'shopper' })];
      if (!shared.includes('chestWidth') && !out.some((r) => r.dim === 'chestWidth')) out.push(reason('missing-required-measurement', { dim: 'chestWidth', required: true }));
      return out;
    }
    default: return [];
  }
}

/* Whether the shopper has a reference garment compare() could use for
   this category: its own type's, or a sibling fleece top's — the same
   test as the engine's referenceEntry() */
function hasReference(profile, category) {
  const garments = (profile && profile.garments) || {};
  const usable = (e) => Boolean(e && e.favorite !== 'none' && e.anchor && (e.anchor.measurements || e.anchor.product));
  return Object.keys(engine.FAMILY).some((c) => engine.FAMILY[c] === engine.FAMILY[category] && usable(garments[c]));
}

/* `explained`: compare() has already said why the reference couldn't be
   used, so recommend()'s own word for the same thing isn't repeated */
function recommendReasons(r, explained) {
  return (r.missing || []).map((m) => {
    if (explained && m.code === 'too-few-dimensions') return null;
    switch (m.code) {
      case 'no-record': return reason('no-record');
      case 'unverified-data': return reason('unverified-data', { side: 'target' });
      case 'category-not-covered': return reason('category-not-supported');
      case 'invalid-measurements': return reason('invalid-measurement', { side: 'shopper' });
      case 'line-not-covered': return reason('line-not-covered');
      case 'line-needed': return reason('missing-sizing-line', { side: 'shopper' });
      case 'incompatible-measurements': return reason('body-vs-garment');
      case 'anchor-unmeasured': return reason('missing-required-measurement', { side: 'shopper', measurement: 'reference garment measurements' });
      case 'no-evidence': return reason('missing-required-measurement', { side: 'shopper', measurement: 'body.chest or a reference' });
      case 'no-candidates': return reason('incomplete-size-rows', { side: 'target' });
      case 'too-few-dimensions': return reason('missing-required-measurement', { side: 'shopper', measurement: 'reference measurements taken the same way' });
      default: return null;
    }
  }).filter(Boolean);
}

/* ---------- each dimension, compared or not, and why ---------- */

/* What one dimension's comparison is, from the engine's own check
   (engine.validate, the same rules compare() uses):
     compatible             both sides measured it the same way
     convertible-estimated  chest only: a flat width and a circumference,
                            by the stated factor — an estimate
     incompatible-method    measured from different points; never converted
     method-not-stated      a side doesn't say how it was taken
     missing-reference      the shopper's reference has no such measurement
     missing-target         the product publishes none
     unverified             a side's measurement isn't checked
     body-vs-garment        the product publishes only who each size is
                            cut for: a body, never set beside a garment */
const DIMENSION_STATUSES = ['compatible', 'convertible-estimated', 'incompatible-method', 'method-not-stated', 'missing-reference', 'missing-target', 'unverified', 'body-vs-garment'];
const SKIP_STATUS = {
  'method-mismatch': 'incompatible-method',
  'method-unknown': 'method-not-stated',
  'reference-missing': 'missing-reference',
  'target-missing': 'missing-target',
  'target-unverified': 'unverified',
  'reference-unverified': 'unverified'
};
const DIMS = ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'];
const requiredDims = (category) => {
  const req = requirementsFor(category);
  return req ? req['reference-garment'].required.target.map((t) => t.replace(/^garment\./, '')) : [];
};
function dimensionsFor(profile, record) {
  const v = engine.validate(profile || null, record);
  const required = requiredDims(record.category);
  const side = (dim, x) => (x ? { method: x.method, kind: x.kind, status: x.status, words: methods.methodWords(dim, x.method) } : null);
  if (v.status === 'body-only') return DIMS.map((dim) => Object.assign({ dim, required: required.includes(dim), status: 'body-vs-garment', reference: null, target: null, conversion: null }, { message: dimensionMessage({ dim, status: 'body-vs-garment' }) }));
  const said = (d) => Object.assign(d, { message: dimensionMessage(d) });
  return (v.dimensions || []).map((x) => said({
    dim: x.dim,
    required: required.includes(x.dim),
    status: x.compared ? (x.derived ? 'convertible-estimated' : 'compatible') : SKIP_STATUS[x.code] || 'missing-target',
    reference: side(x.dim, x.reference),
    target: side(x.dim, x.target),
    conversion: x.derived ? x.derived.rule : null
  }));
}

/* one dimension's status in a shopper's words */
const DIM_WORDS = { chestWidth: 'chest', bodyLength: 'length', shoulderWidth: 'shoulders', sleeveLength: 'sleeves' };
function dimensionMessage(d) {
  const name = DIM_WORDS[d.dim] || 'measurement';
  const Name = name[0].toUpperCase() + name.slice(1);
  switch (d.status) {
    case 'compatible': return `${Name}: measured the same way on both, so compared.`;
    case 'convertible-estimated': return `${Name}: measured flat on one and all the way around on the other, so compared as an estimate (twice the flat width).`;
    case 'incompatible-method': return `${Name}: measured ${d.reference && d.reference.words ? d.reference.words : 'one way'} on your garment and ${d.target && d.target.words ? d.target.words : 'another way'} on this one — not the same measurement, so not compared.`;
    case 'method-not-stated': return `${Name}: not compared, because it isn’t said how it was measured.`;
    case 'missing-reference': return `${Name}: your garment has no ${name} measurement, so it isn’t compared.`;
    case 'missing-target': return `${Name}: this product’s ${name} isn’t published, so it isn’t compared.`;
    case 'unverified': return `${Name}: not compared, because the measurement hasn’t been checked.`;
    case 'body-vs-garment': return `${Name}: this product’s chart describes the body each size is for, not the garment, so it can’t be set beside your garment.`;
    default: return `${Name}: not compared.`;
  }
}

/* ---------- a compare() answer, held to the policy ---------- */

function fromCompare(c, record) {
  const params = engine.CATEGORY_PARAMS[record.category];
  const base = { method: 'reference-garment', via: 'compare', category: record.category, productId: record.id };
  const qualifiers = [];
  const compared = c.dimensionsCompared || [];
  (c.notCompared || []).forEach((x) => qualifiers.push(reason('optional-measurement-not-compared', { dim: x.dim, because: x.code })));
  if (compared.some((d) => c.sizes.some((s) => s.dimensions[d] && s.dimensions[d].estimated))) qualifiers.push(reason('estimated-conversion', { dim: 'chestWidth' }));
  const unranked = c.sizes.filter((s) => s.unranked).map((s) => s.size);
  if (unranked.length) qualifiers.push(reason('sizes-excluded-incomplete', { sizes: unranked }));

  if (c.withheld === 'unverified') return result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { reasons: [reason('unverified-data', { side: 'target' })], qualifiers }));

  /* the chest of the closest size against the engine's reference classes */
  const closest = c.sizes.find((s) => s.size === c.closest);
  const chest = closest && closest.dimensions.chestWidth;
  const reasons = [];
  if (chest && chest.compared) {
    const flat = record.charts.garment.dimensions.chestWidth.method === 'flat-width-armpit-to-armpit';
    const aroundIn = toInches(chest.difference, c.unit) * (flat ? 2 : 1);
    const slight = params.fitBands.reference.chestWidth.slight;
    if (Math.abs(aroundIn) > slight + EPS) reasons.push(reason('chest-outside-acceptable-range', { size: c.closest, differenceAroundIn: Math.round(aroundIn * 100) / 100, acceptableWithinIn: slight }));
  }
  if (c.withheld === 'outside-tolerance') reasons.push(reason('all-compared-outside-tolerance', { size: c.closest }));
  if (reasons.length) return result(OUTCOMES.NO_MATCH, Object.assign(base, { closest: c.closest, reasons, qualifiers }));
  return result(OUTCOMES.OK, Object.assign(base, { size: c.recommended, alternative: c.alternative, confidence: c.reliability, qualifiers }));
}

/* ---------- a recommend() answer, held to the policy ---------- */

const TOO = new Set(['too-tight', 'too-loose']);

/* Each size's chest range in the record's body chart, unmoved, smallest
   first (engine bodyRange: a published range, or — one value per size —
   halfway to each neighbour, marked estimated) */
function rawChartRanges(record) {
  return record.sizes.map((size) => ({ size, range: engine.bodyRange(record, size) })).filter((x) => x.range);
}

/* Where the shopper reaches a one-value-per-size chart only past the end
   size's published value — inside the half of its range Fynd mirrored
   from its neighbour — that end: { size, published, side }, else null */
function mirroredEdge(record, raw, body) {
  const chest = record.charts.body && record.charts.body.dimensions.chest;
  if (!chest || chest.kind !== 'point' || !raw.length) return null;
  const first = raw[0];
  const last = raw[raw.length - 1];
  const value = (x) => record.charts.body.sizes[x.size].chest.value;
  if (body.hi < value(first) - EPS) return { size: first.size, published: value(first), side: 'below' };
  if (body.lo > value(last) + EPS) return { size: last.size, published: value(last), side: 'above' };
  return null;
}

function fromRecommend(r, record) {
  const base = { method: r.method, via: 'recommend', category: record.category, productId: record.id };
  const ev = r.evidence || {};
  const qualifiers = [];
  if (ev.body && ev.body.source === 'reference') qualifiers.push(reason('evidence-from-size-label'));
  if (r.fitGoal && r.fitGoal.from === 'assumed') qualifiers.push(reason('fit-goal-assumed'));
  if (r.dataQuality && (r.dataQuality.estimated || []).some((e) => /2 × its published flat width/.test(e))) qualifiers.push(reason('estimated-conversion', { dim: 'chestWidth' }));
  if (r.anchor && Array.isArray(r.anchor.notCompared)) r.anchor.notCompared.forEach((x) => qualifiers.push(reason('optional-measurement-not-compared', { dim: x.dim, because: x.code })));

  if (ev.conflict) return result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { reasons: [reason('conflicting-references')], qualifiers }));

  if (r.method === 'body-chart') {
    const body = ev.body;
    const aim = ev.aim;
    if (!body || !aim) return result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { reasons: [reason('missing-required-measurement', { side: 'shopper', measurement: 'body.chest' })], qualifiers }));
    /* Eligibility is read from the chart as the brand gives it — each
       size's own range, never moved — apart from the fit preference.
       The engine may score a size against its neighbour's range when the
       brand's fit words and the shopper's goal are far apart
       (sizeOffset); that is a preference among sizes the shopper fits,
       and it never makes a shopper the chart covers "outside" it. */
    const raw = rawChartRanges(record);
    const eligible = raw.filter((x) => body.hi >= x.range.lo - EPS && body.lo <= x.range.hi + EPS);
    if (!eligible.length) {
      const above = body.lo > raw[raw.length - 1].range.hi;
      const edge = above ? raw[raw.length - 1] : raw[0];
      return result(OUTCOMES.NO_MATCH, Object.assign(base, {
        closest: edge.size,
        reasons: [reason('outside-size-range', { size: edge.size, chart: { size: edge.size, lo: edge.range.lo, hi: edge.range.hi, estimated: edge.range.estimated }, shopper: { lo: body.lo, hi: body.hi }, unit: ev.units, side: above ? 'above-largest' : 'below-smallest' })],
        qualifiers
      }));
    }
    const sizes = eligible.map((x) => x.size);
    /* the preference, kept apart and said: which size the chart puts
       them in, and which the fit goal moved them to */
    if (!sizes.includes(r.leading)) qualifiers.push(reason('fit-preference-shift', { size: r.leading, chartSizes: sizes, fitClass: record.fit.fitClass, goal: r.fitGoal ? r.fitGoal.goal : null }));
    /* the estimate stays an estimate: a range worked out from one value
       per size is said, and where the shopper reaches the chart only
       through the half of an end size that is mirrored, not published,
       the answer can be no more than low confidence */
    const estimated = eligible.filter((x) => x.range.estimated);
    let confidence = r.confidence;
    if (estimated.length) {
      const edge = mirroredEdge(record, raw, body);
      qualifiers.push(reason('estimated-chart-range', Object.assign({ sizes: estimated.map((x) => x.size) }, edge ? { mirroredEdge: edge } : {})));
      if (edge) confidence = 'low';
    }
    return result(OUTCOMES.OK, Object.assign(base, { size: r.leading, alternative: r.alternative ? r.alternative.size : null, confidence, qualifiers }));
  } else {
    /* body-plus-ease and reference-garment: the leading size's own chest class */
    const lead = (r.fitBySize || []).find((f) => f.size === r.leading);
    const chest = lead && lead.dimensions && lead.dimensions.chestWidth;
    if (!chest || !chest.class) {
      return result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { reasons: [chest && chest.ease ? reason('reference-range-too-wide') : reason('missing-required-measurement', { dim: 'chestWidth' })], qualifiers }));
    }
    /* poor at every reading of the shopper's range: no "could be" better */
    if (TOO.has(chest.class) && (!chest.couldBe || TOO.has(chest.couldBe))) {
      return result(OUTCOMES.NO_MATCH, Object.assign(base, { closest: r.leading, reasons: [reason('chest-outside-acceptable-range', { size: r.leading, class: chest.class })], qualifiers }));
    }
  }
  return result(OUTCOMES.OK, Object.assign(base, { size: r.leading, alternative: r.alternative ? r.alternative.size : null, confidence: r.confidence, qualifiers }));
}

/* ---------- a chart read from a page: never a decision ---------- */

function fromChart(chart) {
  const reasons = [reason('unverified-source')];
  if (chart.unit !== 'in' && chart.unit !== 'cm') reasons.push(reason('unit-not-stated'));
  if (chart.measures === 'body') reasons.push(reason('body-vs-garment', { side: 'target' }));
  else if (chart.measures !== 'finished-garment') reasons.push(reason('measurement-kind-not-stated'));
  if (!Array.isArray(chart.methods) || !chart.methods.some(Boolean)) reasons.push(reason('method-not-stated'));
  return result(OUTCOMES.INSUFFICIENT_DATA, { reasons });
}

/* ---------- the decision ---------- */

/* decide(profile, target, opts) → the decision, plus (detail: true) the
   engine answers it rests on. target: a sizing record, { record }, or
   { chart } (a chart read from a page). opts.via: 'compare' (the
   shopper's reference garment only), 'recommend' (the rest of the
   profile only) or omitted (the reference first, then the rest — as the
   search page's listings always have). */
function decideWithDetail(profile, target, opts) {
  const o = opts || {};
  const detail = { compare: null, recommend: null };
  /* every answer also says, in a shopper's words, why it is what it is
     (customerMessage, from the codes): what a page shows for a refusal */
  const done = (decision) => ({ decision: Object.assign(decision, { messages: decision.outcome === OUTCOMES.OK ? [] : customerMessages(decision, { brand: target && target.brand }) }), detail });

  if (target && target.chart && !target.charts) return done(fromChart(target.chart));
  const record = target && target.record && !target.charts ? target.record : target;
  if (!record || typeof record !== 'object' || sizingSchema.validate(record).length) {
    const category = record && typeof record.category === 'string' ? record.category : null;
    const code = category && !requirementsFor(category) ? 'category-not-supported' : 'no-record';
    return done(result(OUTCOMES.INSUFFICIENT_DATA, { category, reasons: [reason(code)] }));
  }
  const base = { category: record.category, productId: record.id };
  if (!requirementsFor(record.category) || !engine.CATEGORY_PARAMS[record.category]) {
    return done(result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { reasons: [reason('category-not-supported')] })));
  }
  /* verification first: an unverified record gives no decision, whatever its numbers say */
  if (!sizingSchema.isVerified(record)) {
    return done(result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { reasons: [reason('unverified-data', { side: 'target' })] })));
  }
  const range = outOfRange(profile, record.category);
  if (range.length) return done(result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { reasons: range })));

  /* The shopper's reference garment, compared garment with garment —
     and, when they have one for this kind of top, nothing else: if it
     can't be compared on enough measurements taken the same way, the
     answer is INSUFFICIENT_DATA, never a size from their body and an
     assumed room instead. */
  if (o.via === 'compare' || hasReference(profile, record.category)) {
    const c = engine.compare(profile || null, record, { unit: o.unit });
    detail.compare = c;
    const dimensions = dimensionsFor(profile, record);
    const decided = c.status === 'ok' || c.status === 'partial' ? fromCompare(c, record)
      : result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { method: 'reference-garment', via: 'compare', reasons: compareReasons(c) }));
    return done(Object.assign(decided, { comparison: 'garment-to-garment', dimensions }));
  }
  /* no reference garment: the rest of the profile — a chest measurement,
     or a size label read only as its brand chart's chest range */
  const r = engine.recommend(profile || null, record);
  detail.recommend = r;
  if (r.status === 'ok') return done(Object.assign(fromRecommend(r, record), { comparison: r.method === 'body-chart' ? 'body-to-body-chart' : 'body-plus-assumed-room', dimensions: [] }));
  return done(result(OUTCOMES.INSUFFICIENT_DATA, Object.assign(base, { via: o.via || null, reasons: recommendReasons(r, false) })));
}

const decide = (profile, target, opts) => decideWithDetail(profile, target, opts).decision;

/* ---------------------------------------------------------
   What a result is, and every field held to the decision
   ---------------------------------------------------------
   A result is one of two kinds, never presented as the other:
     garment-comparison  the product's own finished-garment measurements
                         set beside the shopper's reference garment's
     body-estimate       an estimate from body measurements, or the body
                         range a brand's chart gives a size label, plus
                         the room a fit is assumed to need — no garment
                         of the shopper's is measured in it
   An answer sent beside a decision (the engine's comparison or
   recommendation) keeps its per-size detail, but no field of it may name
   a size as recommended, or rank a leader, that the decision didn't give:
   with any outcome but OK, its recommended, alternative and leading size
   are withheld, and its summary is the decision's own words. */
const RESULT_TYPES = { 'garment-to-garment': 'garment-comparison', 'body-plus-assumed-room': 'body-estimate', 'body-to-body-chart': 'body-estimate' };
const resultTypeOf = (d) => (d && RESULT_TYPES[d.comparison]) || null;
const withheldWords = (d) => (d && Array.isArray(d.messages) && d.messages.length ? d.messages.join(' ') : 'No size is recommended for this item.');

/* engine.compare()'s answer, held to its decision */
function heldComparison(c, d) {
  if (!c || typeof c !== 'object' || !d || d.outcome === OUTCOMES.OK) return c;
  if (c.recommended == null && c.alternative == null) return c;
  return Object.assign({}, c, {
    /* still each size beside the reference — never one called recommended */
    status: c.status === 'insufficient' ? c.status : 'partial',
    recommended: null,
    alternative: null,
    closest: d.outcome === OUTCOMES.NO_MATCH ? d.closest : null,
    withheld: 'decision',
    summary: withheldWords(d)
  });
}

/* engine.recommend()'s answer, held to its decision */
function heldRecommendation(r, d) {
  if (!r || typeof r !== 'object' || !d || d.outcome === OUTCOMES.OK || r.status !== 'ok') return r;
  return Object.assign({}, r, {
    status: d.outcome === OUTCOMES.NO_MATCH ? 'no-match' : 'insufficient',
    leading: null,
    alternative: null,
    /* each ranks, or names, a leading size */
    ranking: [],
    fitBySize: [],
    tradeoffs: [],
    reasons: [],
    withheld: 'decision',
    missing: d.reasons.map((x) => ({ code: x.code, message: customerMessage(x) }))
  });
}

module.exports = { decide, decideWithDetail, customerMessage, customerMessages, dimensionMessage, DIMENSION_STATUSES, requirementsFor, REQUIREMENTS, REASONS, OUTCOMES, CONTRACT, RESULT_TYPES, resultTypeOf, heldComparison, heldRecommendation };
