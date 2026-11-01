/* =========================================================
   Fynd — which size of a product to suggest, and how sure to be

   recommend(profile, record) takes a shopper's fit profile (the shape
   assets/fit-profile-schema.js gives it) and one product sizing record
   (api/_sizing/schema.js), and returns either

     { status: "ok", leading, alternative, confidence, reasons, ... }

   or, when the data cannot support an answer,

     { status: "insufficient", missing: [...], next: [...] }

   Every "ok" answer also says, for each size, how its chest, length,
   sleeves and shoulders may feel (fitBySize), where the evidence
   reaches; see "How each size may feel" below.

   It never says a size will fit, and it never shows a number the record
   or the shopper did not give it, except where it says how it worked
   one out.

   ---------------------------------------------------------
   What it knows about the shopper
   ---------------------------------------------------------
   Never an exact body. Each piece of the profile becomes a range, or a
   garment that is known to fit:

     a chest measurement        the chest, ± ½ in for measuring at home
     a size that fits, in a     that size's chest range in the brand's
       brand we have a record   body chart (estimated — a size is worn
       for                      by a range of bodies)
                                and, when the brand publishes garment
                                measurements, the garment itself: the
                                strongest evidence there is, because it
                                is known to fit the way they like
     a size in any other brand  nothing: a letter is not a measurement
     the sizing line            whether a letter size can be read at all
     how it should fit          the room to aim for (see EASE)
     trouble spots              which measurements matter more, and in
                                which direction

     a favourite T-shirt        (T-shirts) the piece the shopper says
                                fits perfectly, or close — read in this
                                order, strongest first:
                                  product   its product, found in
                                            Fynd's own sizing records by
                                            link or name: that product's
                                            published garment measurements
                                            in the size on its label
                                  measured  the measurements the shopper
                                            took of it, laid flat, each
                                            by a named method
                                  brand and size only: never another
                                            product's garment
                                            measurements, only the chest
                                            range that brand's chart puts
                                            in that size — a weaker,
                                            estimated reference
                                What makes it fit well (likes) weighs
                                those measurements more; "close" rather
                                than perfect lowers confidence.

   ---------------------------------------------------------
   Three ways to score, by what the product publishes
   ---------------------------------------------------------
     reference-garment   the product has garment measurements, and so
                         does a garment the shopper says fits: compare
                         garment with garment, by the same method
     body-plus-ease      the product has garment measurements, the
                         shopper has only a body range: aim for the
                         body plus the room their fit wants (EASE)
     body-chart          the product has only a body chart: compare the
                         shopper's body with the chart, moved a size
                         when the brand's own fit words and the
                         shopper's fit goal are far apart

   A body measurement is never compared directly with a garment
   measurement, and two garment measurements are only compared when
   their method (a flat width or a circumference; from the centre back
   or the shoulder seam) is the same — or when one can be worked out
   from the other by a stated rule, and is then called estimated:

     chest       a flat width is half the way around (× 2)
     sleeve      from the centre back and from the shoulder seam: not
                 convertible (where the seam sits is not published), so
                 not compared
     length      from the centre back and from the top of the shoulder:
                 not convertible, not compared

   ---------------------------------------------------------
   Confidence
   ---------------------------------------------------------
   From the data, never from the score: high only when a garment the
   shopper says fits is compared with this product's own published
   garment measurements and the next size is clearly worse. Estimates,
   a close second size, an assumed fit goal or evidence that disagrees
   each lower it. A record nobody has checked against its source gives
   no recommendation at all (unless the caller is the evaluation suite,
   which asks for that explicitly and says so in the result).
   ========================================================= */

'use strict';

const sizingSchema = require('./schema');
const methodRegistry = require('./methods');
const { RECORDS } = require('./records');
const ProfileSchema = require('../../assets/fit-profile-schema.js');

const IN_TO_CM = 2.54;

/* ---------------------------------------------------------
   The tunable part. Starting values, not facts: every number here is
   a hypothesis the evaluation suite and, later, shoppers' feedback are
   meant to correct. Each category names its own dimensions.
   --------------------------------------------------------- */
const TOPS = {
  /* weight: how much a miss counts; tol: how far off (in inches) counts
     as one unit of miss */
  garment: {
    chestWidth: { weight: 1, tol: 1 },
    bodyLength: { weight: 0.6, tol: 1 },
    sleeveLength: { weight: 0.6, tol: 0.75 },
    shoulderWidth: { weight: 0.3, tol: 0.75 }
  },
  /* EASE: room around the chest, garment minus body, in inches of
     circumference, for each fit goal. A hypothesis about how hoodies
     and sweatshirts are worn — not a rule, and not the brand's. */
  ease: { slim: [2, 5], 'true-to-size': [5, 9], oversized: [10, 16] },
  /* how far (in inches) a body may sit outside a chart range before it
     counts as one unit of miss */
  bodyTol: 1.5,
  /* trouble spots, and the measurement each one is about */
  trouble: {
    'sleeves-short': { dim: 'sleeveLength', side: 'short' },
    'torso-short': { dim: 'bodyLength', side: 'short' },
    'chest-tight': { dim: 'chestWidth', side: 'tight' }
  },
  /* trouble spots no published measurement for these products speaks to */
  unassessable: {
    'neckline-tight': 'neck openings are not published',
    'waist-loose': 'hem and waist widths are not published'
  },
  /* FIT BANDS: how far from the aim each class starts, in inches. Like
     EASE, hypotheses to be calibrated against real fit outcomes, not
     constants of tailoring.
       ease        around the chest, against the room the fit goal wants
                   (EASE): inside it is about right; up to `slight`
                   outside it is slightly tight or loose; beyond, too
       reference   against a garment the shopper says fits: up to
                   `about` either way is about right; up to `slight` is
                   slightly; beyond, too. Chest is around (twice a flat
                   width). */
  fitBands: {
    ease: { slight: 2 },
    reference: {
      chestWidth: { about: 1, slight: 3 },
      bodyLength: { about: 0.5, slight: 1.5 },
      sleeveLength: { about: 0.5, slight: 1.5 },
      shoulderWidth: { about: 0.375, slight: 1 }
    }
  }
};
/* T-shirts: the same dimensions and bands, with less room around the
   chest for each fit goal than a fleece top — again a hypothesis, to be
   corrected by fit feedback. */
const TEES = Object.assign({}, TOPS, { ease: { slim: [1, 4], 'true-to-size': [4, 8], oversized: [9, 16] } });
const CATEGORY_PARAMS = { hoodies: TOPS, sweatshirts: TOPS, tshirts: TEES };
/* the categories where a brand and size alone, with no product or
   measurements, are read only as a chest range from the brand's chart —
   every category: a size label is never another product's garment
   measurements, and never the shopper's reference garment's */
const STRICT_ANCHOR = { hoodies: true, sweatshirts: true, tshirts: true };
/* which categories' charts may stand in for each other */
const FAMILY = { hoodies: 'fleece', sweatshirts: 'fleece', tshirts: 'tees' };
const CATEGORY_WORDS = { hoodies: 'hoodie', sweatshirts: 'sweatshirt', tshirts: 'T-shirt' };

const TROUBLE_FACTOR = 2.5;     /* a miss in the direction a trouble spot names counts this much more */
const ALTERNATIVE_MARGIN = 0.75; /* a second size this close behind is offered as the alternative */
const TIE_MARGIN = 0.2;         /* this close is a near tie, and lowers confidence */
const CLEAR_MARGIN = 1.5;       /* high confidence needs the next size at least this far behind */
const SHORT_EXTRA = 1;          /* "runs short": aim this many inches longer than the chest pick */

/* The brand's fit words against the shopper's goal, on one scale. Two
   or more apart moves the aim one size (body-chart method). */
const FIT_RANK = { slim: 0, regular: 1, relaxed: 2, loose: 3, oversized: 3 };
const GOAL_RANK = { slim: 0, 'true-to-size': 1, oversized: 3 };
/* the fit profile page's per-category fits, read only when the guide
   has no fit goal for the type */
const PREFERENCE_TO_GOAL = { fitted: 'slim', regular: 'true-to-size', relaxed: 'oversized', oversized: 'oversized' };

const LEVELS = ['low', 'medium', 'high'];
const lower = (level, steps) => LEVELS[Math.max(0, LEVELS.indexOf(level) - (steps || 1))];
const capAt = (level, cap) => LEVELS[Math.min(LEVELS.indexOf(level), LEVELS.indexOf(cap))];

/* ---------- small helpers ---------- */

const brandKey = (name) => ProfileSchema.brandKey(name || '');
const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;

/* 23.5 -> "23½ in"; anything not a quarter keeps one decimal */
function inches(v, units) {
  if (units === 'cm') return `${round(v, 1)} cm`;
  const whole = Math.floor(v + 1e-9);
  const frac = round(v - whole, 2);
  const glyph = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[frac];
  return glyph !== undefined ? `${whole}${glyph} in` : `${round(v, 1)} in`;
}

const LABEL_ALIASES = { XXL: '2XL', '2XL': 'XXL', XXXL: '3XL', '3XL': 'XXXL' };
/* the record's own spelling of a size label, or null */
function sizeIn(record, size) {
  if (!size) return null;
  const s = String(size).toUpperCase();
  if (record.sizes.includes(s)) return s;
  const alias = LABEL_ALIASES[s];
  return alias && record.sizes.includes(alias) ? alias : null;
}

const scaleOf = (line) => (line === 'men' || line === 'unisex' ? 'men' : line === 'women' ? 'women' : null);

/* A size's chest range in a body chart, in the record's units. A brand
   that publishes one value per size gives a point; the range is then
   worked out as halfway to each neighbour — an estimate, and said so. */
function bodyRange(record, size) {
  const chart = record.charts.body;
  if (!chart || !chart.dimensions.chest || !chart.sizes[size] || !chart.sizes[size].chest) return null;
  const cell = chart.sizes[size].chest;
  if (chart.dimensions.chest.kind === 'range') {
    return { lo: cell.min, hi: cell.max, estimated: false, text: cell.text };
  }
  const listed = record.sizes.filter((s) => chart.sizes[s] && chart.sizes[s].chest);
  const at = listed.indexOf(size);
  const value = (s) => chart.sizes[s].chest.value;
  const prev = at > 0 ? value(listed[at - 1]) : null;
  const next = at < listed.length - 1 ? value(listed[at + 1]) : null;
  const halfDown = prev !== null ? (cell.value - prev) / 2 : (next - cell.value) / 2;
  const halfUp = next !== null ? (next - cell.value) / 2 : (cell.value - prev) / 2;
  return { lo: cell.value - halfDown, hi: cell.value + halfUp, estimated: true, text: cell.text };
}

function garmentRow(record, size) {
  const chart = record.charts.garment;
  return chart && chart.sizes[size] ? chart.sizes[size] : null;
}

const MEASURE_UNITS = ['in', 'cm'];
/* Only inches and centimetres, both ways: anything else is a fault
   upstream (measurementProblems and the record schema let nothing else
   through), never read as one or the other. */
function toUnits(value, from, to) {
  if (!MEASURE_UNITS.includes(from) || !MEASURE_UNITS.includes(to)) throw new Error(`No conversion from "${from}" to "${to}".`);
  return from === to ? value : (from === 'in' ? value * IN_TO_CM : value / IN_TO_CM);
}

/* ---------------------------------------------------------
   The shopper's own measurements, checked before anything is worked
   out from them

   The fit profile's validator (normaliseGuide) checks what a shopper
   types; a stored profile is only re-shaped when read (upgrade); a
   direct call to the engine passes neither. So whatever reaches here is
   checked again, raw, before any conversion, eligibility or difference:

     not given     null, undefined or absent: missing, and the usual
                   rules for missing measurements apply
     malformed     anything else that isn't a finite number above zero
                   (NaN, ±Infinity, "24", 0, -5, true), or a unit that
                   isn't exactly "in" or "cm" — the form the validator
                   stores — beside a value or on its own

   Malformed is never dropped and worked around: the answer is
   insufficient ("invalid-measurements"), before any number is worked
   out. Plausibility ranges stay the validator's: a saved profile isn't
   made unreadable by a range tightened later (upgrade).
   --------------------------------------------------------- */
const BODY_MEASURE_KEYS = Object.keys(ProfileSchema.empty().measurements).filter((k) => k !== 'unit');
const givenValue = (v) => v !== null && v !== undefined;
const physical = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/* each problem with one block of measurements, in words */
function blockProblems(m, keys, whose, labelOf) {
  if (!givenValue(m)) return [];
  if (typeof m !== 'object' || Array.isArray(m)) return [`${whose} measurements aren't a set of measurements`];
  const said = keys.filter((k) => givenValue(m[k]));
  const out = said.filter((k) => !physical(m[k])).map((k) => `${whose} ${labelOf(k)} isn't a number above zero`);
  if ((said.length || givenValue(m.unit)) && !MEASURE_UNITS.includes(m.unit)) {
    out.push(givenValue(m.unit) ? `${whose} measurements are in a unit Fynd doesn't read` : `${whose} measurements don't say inches or centimetres`);
  }
  return out;
}

/* The shopper's body measurements, and the reference garment's own:
   the product's own type's, and any other anchor that will be read in
   its place (a sibling type's), so a malformed one can't be stepped
   over. [] when every given value is usable. */
function measurementProblems(profile, category, anchor) {
  const garmentLabel = (k) => ProfileSchema.GARMENT_MEASURES[k].label.toLowerCase();
  const own = profile && profile.garments && profile.garments[category] ? profile.garments[category].anchor : null;
  const anchors = [...new Set([own, anchor].filter(Boolean))];
  return blockProblems(profile && profile.measurements, BODY_MEASURE_KEYS, 'Your', (k) => k)
    .concat(...anchors.map((a) => blockProblems(a.measurements, ProfileSchema.GARMENT_MEASURE_KEYS, 'Your reference garment’s', garmentLabel)));
}
const INVALID_NEXT = ['Check the measurements on your fit profile: each a number above zero, in inches or centimetres.'];
const invalidMessage = (problems) => `Some measurements can’t be used: ${problems.join('; ')}. Fynd compares only numbers above zero in inches or centimetres, so it hasn’t worked anything out from them.`;

/* A pool of records a caller supplies is held to what records.js holds
   the catalogue to: a record that fails its schema is left out, never
   half-used. The catalogue itself was checked as it loaded. */
const checkedPool = (records) => (records === RECORDS ? RECORDS
  : (Array.isArray(records) ? records : []).filter((r) => sizingSchema.validate(r).length === 0));

/* ---------------------------------------------------------
   The favourite piece: finding its product, and its own measurements
   --------------------------------------------------------- */

/* what each "what makes it fit well" answer is about */
const LIKE_DIMS = { shoulders: 'shoulderWidth', chest: 'chestWidth', looseness: 'chestWidth', sleeves: 'sleeveLength', length: 'bodyLength' };
const LIKED_WEIGHT = 2;       /* a measurement the shopper says is right counts this much more */
const UNLIKED_CLOSE = 0.5;    /* on a piece that is only close, one they didn't name counts this much */
const SHOPPER_MEASURED = 'shopper-measured';

/* The record for the product the shopper named, by its link (the
   brand's own site, with the product's code in the address) or, failing
   that, by its name — only when exactly one record answers to it.
   { record, by } or null. Never a guess between two products. */
function matchProduct(anchor, pool, category, opts) {
  /* exact: the shopper's own garment as their reference — its link, or
     its whole name; never a name that only contains another's */
  const exact = Boolean(opts && opts.exact);
  const product = anchor && anchor.product;
  if (!product) return null;
  const same = pool.filter((r) => r.category === category && (!anchor.brand || brandKey(r.brand) === brandKey(anchor.brand)));
  if (product.url) {
    let u = null;
    try { u = new URL(product.url); } catch (err) { u = null; }
    if (u) {
      const path = u.pathname.toLowerCase();
      /* a link to another market's page is not this region's product */
      const market = sizingSchema.marketOf(u.pathname);
      const byUrl = same.filter((r) => (sizingSchema.OFFICIAL_HOSTS[r.brand] || []).includes(u.hostname)
        && r.product.code && sizingSchema.codeIn(path, r.brand, r.product.code) && (!market || r.region === market));
      if (byUrl.length === 1) return { record: byUrl[0], by: 'link' };
    }
  }
  if (product.name) {
    const key = brandKey(product.name);
    const named = same.filter((r) => {
      const own = brandKey(r.product.name);
      return own === key || (!exact && ((key.length >= 8 && own.includes(key)) || (own.length >= 8 && key.includes(own))));
    });
    if (named.length === 1) return { record: named[0], by: 'name' };
  }
  return null;
}

/* The shopper's own measurements of the piece, as a garment chart Fynd
   can set beside a product's: one row, labelled with the size on its
   label (or "yours"), each dimension by the method the guide asked for.
   Taken as given, like a chest measurement — never called verified,
   never estimated. */
function measuredRecord(anchor, category) {
  const m = anchor && anchor.measurements;
  if (!m || (m.unit !== 'in' && m.unit !== 'cm')) return null;
  const dims = {};
  const row = {};
  /* each value's method as saved with it (anchor.methods, fit profile v6),
     named under a registry version this code knows; a value whose saved
     method isn't a canonical one for its dimension is "not stated" and
     never compared. A reference saved before methods were recorded was
     measured by the form's own methods, so those stand for it. */
  const saved = anchor.methods && typeof anchor.methods === 'object' && !Array.isArray(anchor.methods) ? anchor.methods : null;
  const knownVersion = saved && Number.isInteger(saved.registry) && saved.registry >= 1 && saved.registry <= methodRegistry.REGISTRY_VERSION;
  ProfileSchema.GARMENT_MEASURE_KEYS.forEach((d) => {
    if (!physical(m[d])) return;
    const method = !saved ? ProfileSchema.GARMENT_MEASURES[d].method
      : knownVersion && methodRegistry.isMethod(d, saved[d]) ? saved[d] : methodRegistry.NOT_STATED;
    dims[d] = { method };
    row[d] = { value: m[d], text: String(m[d]) };
  });
  if (!Object.keys(row).length) return null;
  const size = anchor.size || 'yours';
  return {
    id: 'your-measurements',
    brand: anchor.brand || 'Your',
    /* named by what it is: a measured hoodie is not "the T-shirt you measured" */
    product: { name: `${CATEGORY_WORDS[category] || 'garment'} you measured` },
    category,
    units: m.unit,
    sizes: [size],
    charts: { garment: { dimensions: dims, sizes: { [size]: row } } },
    verification: { status: SHOPPER_MEASURED }
  };
}
const isShopperMeasured = (record) => Boolean(record && record.verification && record.verification.status === SHOPPER_MEASURED);

/* Whether one garment dimension of a record may be compared at all: a
   verified measurement (sizingSchema.measurementStatus), or the
   shopper's own; an unverified one only for the evaluation suite.
   Crowdsourced measurements never. */
function usableDim(record, d, includeUnverified) {
  if (isShopperMeasured(record)) return true;
  const status = sizingSchema.measurementStatus(record, d);
  return status === 'verified' || (Boolean(includeUnverified) && status === 'unverified');
}
const STATUS_WHY = {
  crowdsourced: 'gathered from shoppers, not checked against the brand',
  unverified: 'not yet checked against the brand'
};

/* One garment dimension of a reference, in the method another record
   uses for it: { value, estimated } in the reference's units, or null
   when the two can't be compared. */
function inMethodOf(d, refRecord, refRow, method) {
  const own = refRecord.charts.garment.dimensions[d];
  if (!own || !refRow[d]) return null;
  /* the canonical rule (./methods.js): the same method, or chest's stated
     flat ↔ around conversion, called estimated. A sleeve from the centre
     back and one from the shoulder seam differ by where the seam sits,
     which no chart publishes: never converted. */
  const r = methodRegistry.relation(d, own.method, method);
  if (!r) return null;
  if (r.relation === 'same') return { value: refRow[d].value, estimated: null };
  return { value: refRow[d].value * r.factor, estimated: r.estimated };
}

/* One dimension's tolerance for this record, in its units. The chest's
   is stated as a flat width (TOPS.garment); a chest the product
   publishes all the way around is twice as far for the same cut, so its
   tolerance is twice as wide — otherwise the same garment would rank
   differently depending only on how its chart is written. */
function toleranceOf(d, record, params) {
  const around = d === 'chestWidth' && record.charts.garment.dimensions.chestWidth
    && record.charts.garment.dimensions.chestWidth.method === 'garment-circumference';
  return toUnits(params.garment[d].tol * (around ? 2 : 1), 'in', record.units);
}

/* the canonical methods' short words (./methods.js) */
const METHOD_WORDS = methodRegistry.SHORT_WORDS;

/* How much each dimension counts, from what the shopper said about the
   piece they compare with: what makes its fit good counts more; on a
   piece that is only close, what they didn't name counts less. */
function dimWeights(shopper) {
  const out = {};
  Object.keys(shopper.params.garment).forEach((d) => { out[d] = 1; });
  const fav = shopper.favorite;
  if (!fav || !shopper.garmentRef || !shopper.garmentRef.claim.favorite) return out;
  const liked = new Set((fav.likes || []).map((l) => LIKE_DIMS[l]).filter(Boolean));
  Object.keys(out).forEach((d) => {
    if (liked.has(d)) out[d] = LIKED_WEIGHT;
    else if (fav.answer === 'close' && liked.size) out[d] = UNLIKED_CLOSE;
  });
  return out;
}

/* ---------------------------------------------------------
   What the profile says about this shopper, for this product
   --------------------------------------------------------- */

function readShopper(profile, record, pool, options) {
  const units = record.units;
  const category = record.category;
  const params = CATEGORY_PARAMS[category];
  const entry = (profile && profile.garments && profile.garments[category]) || {};
  const notes = [];

  /* the fit goal: the guide's, else the fit profile page's per-category
     preference, else assumed true to size — and said */
  let goal = entry.fitGoal || null;
  let goalSource = goal ? 'guide' : null;
  if (!goal && profile && profile.fitPreferences && PREFERENCE_TO_GOAL[profile.fitPreferences[category]]) {
    goal = PREFERENCE_TO_GOAL[profile.fitPreferences[category]];
    goalSource = 'preferred-fit';
  }
  if (!goal) { goal = 'true-to-size'; goalSource = 'assumed'; }

  const line = entry.line || null;
  const scale = scaleOf(line);

  /* a chest measurement, in the record's units */
  let measured = null;
  const m = profile && profile.measurements;
  if (m && physical(m.chest) && (m.unit === 'in' || m.unit === 'cm')) {
    const chest = toUnits(m.chest, m.unit, units);
    const slack = toUnits(0.5, 'in', units);
    measured = { lo: chest - slack, hi: chest + slack, value: chest, said: inches(m.chest, m.unit) };
  }

  /* sizes the shopper says fit: the type's anchor, and usual sizes by
     brand marked "about right", for either kind of top */
  const claims = [];
  const garmentType = ProfileSchema.garmentOf(category);
  const favoriteType = Boolean(garmentType && garmentType.favorite);
  const anchor = entry.anchor || null;
  /* the favourite piece (T-shirts): its product, else its own
     measurements, else brand and size only — see the header */
  let favorite = null;
  let favoriteRef = null;
  if (favoriteType && anchor && entry.favorite !== 'none') {
    favorite = { answer: entry.favorite || null, likes: anchor.likes || null, brand: anchor.brand || null, size: anchor.size || null, source: null, match: null };
    /* only this exact product's own measurements: by its link, or its whole name */
    const match = matchProduct(anchor, pool, category, { exact: true });
    const matchedUsable = Boolean(match) && (sizingSchema.isVerified(match.record) || options.includeUnverified);
    const matchedSize = match ? sizeIn(match.record, anchor.size) : null;
    if (match && !matchedUsable) {
      notes.push(`Fynd has ${match.record.brand}'s ${match.record.product.name} on file, but its sizing hasn't been checked against ${match.record.brand}'s chart yet, so it isn't used.`);
    } else if (match && !anchor.size) {
      notes.push(`Fynd found your ${match.record.brand} ${match.record.product.name}, but without the size on its label it can't tell which of its measurements are yours.`);
    } else if (match && !matchedSize) {
      notes.push(`Fynd found your ${match.record.brand} ${match.record.product.name}, but it isn't sold in ${anchor.size}.`);
    }
    if (match && matchedUsable && matchedSize && garmentRow(match.record, matchedSize)) {
      favorite.source = 'product';
      favorite.match = { id: match.record.id, by: match.by, name: match.record.product.name, size: matchedSize };
      favoriteRef = { claim: { brand: match.record.brand, size: matchedSize, category, from: 'favorite', favorite: true }, record: match.record, size: matchedSize, product: true };
    } else {
      const measured = measuredRecord(anchor, category);
      if (measured) {
        favorite.source = 'measured';
        favoriteRef = { claim: { brand: measured.brand, size: measured.sizes[0], category, from: 'favorite', favorite: true }, record: measured, size: measured.sizes[0], measured: true };
      } else {
        favorite.source = anchor.brand && anchor.size ? 'brand-size' : 'not-enough';
        if (anchor.product && !match) notes.push(`Fynd has no sizing for the product you named, so your${anchor.brand ? ` ${anchor.brand}` : ''} T-shirt is kept as your reference without its exact measurements.`);
      }
    }
    /* its brand's chart for that size, for a chest range only — never
       another product's garment measurements */
    if (favorite.source !== 'product' && anchor.brand && anchor.size) {
      /* brand and size alone: only the chest range the brand's chart
         gives that size, never a product's garment measurements */
      claims.push({ brand: anchor.brand, size: anchor.size, category, from: 'anchor', bodyOnly: true });
    }
  } else if (anchor && anchor.brand && anchor.size) claims.push({ brand: anchor.brand, size: anchor.size, category, from: 'anchor', bodyOnly: true });
  ((profile && profile.brandSizes) || []).forEach((b) => {
    /* a usual size in a brand is a label: a chest range from the brand's
       chart, never another product's garment measurements */
    if (b && b.fit === 'about-right' && b.size && CATEGORY_PARAMS[b.category]) claims.push({ brand: b.brand, size: b.size, category: b.category, from: 'usual size', bodyOnly: true });
  });

  const usable = (r) => (sizingSchema.isVerified(r) || options.includeUnverified) && CATEGORY_PARAMS[r.category] && r.sizeScale === scale;
  const references = [];
  claims.forEach((claim) => {
    /* fleece tops are read against fleece tops, T-shirts against
       T-shirts: a T-shirt chart says nothing about a hoodie's size */
    const candidates = pool.filter((r) => brandKey(r.brand) === brandKey(claim.brand) && FAMILY[r.category] === FAMILY[category]);
    if (!candidates.length) {
      notes.push(`${claim.brand} ${claim.size} isn't used: Fynd has no ${claim.brand} size chart for ${category === 'tshirts' ? 'T-shirts' : 'hoodies or sweatshirts'}, and a letter size alone isn't a measurement.`);
      return;
    }
    if (!scale) {
      notes.push(`${claim.brand} ${claim.size} isn't used: without knowing whether it's a men's, women's or unisex size, Fynd can't read it.`);
      return;
    }
    /* prefer the same kind of top, and a record with garment measurements */
    const ranked = candidates.filter(usable).filter((r) => sizeIn(r, claim.size)).filter((r) => !claim.bodyOnly || r.charts.body)
      .sort((a, b) => (Number(b.category === claim.category) - Number(a.category === claim.category))
        || (claim.bodyOnly ? 0 : Number(Boolean(b.charts.garment)) - Number(Boolean(a.charts.garment))));
    if (!ranked.length) {
      notes.push(`${claim.brand} ${claim.size} isn't used: Fynd has no checked ${claim.brand} chart for that size and sizing line.`);
      return;
    }
    const ref = ranked[0];
    references.push({ claim, record: ref, size: sizeIn(ref, claim.size) });
  });

  /* the garment that fits: the first reference whose record publishes
     garment measurements for that size */
  const garmentRef = favoriteRef || references.find((r) => !r.claim.bodyOnly && garmentRow(r.record, r.size)) || null;
  /* the favourite's own product says who it is cut for, too */
  if (favoriteRef && favoriteRef.product) references.push(favoriteRef);

  /* body ranges from references' charts (estimated), combined */
  const refBodies = references.map((r) => ({ ref: r, range: bodyRange(r.record, r.size) })).filter((x) => x.range)
    .map((x) => ({ lo: toUnits(x.range.lo, x.ref.record.units, units), hi: toUnits(x.range.hi, x.ref.record.units, units), ref: x.ref, estimatedPoint: x.range.estimated }));
  let refBody = null;
  if (refBodies.length) {
    const lo = Math.max(...refBodies.map((b) => b.lo));
    const hi = Math.min(...refBodies.map((b) => b.hi));
    refBody = lo <= hi ? { lo, hi, from: refBodies } : { lo: Math.min(...refBodies.map((b) => b.lo)), hi: Math.max(...refBodies.map((b) => b.hi)), from: refBodies, conflict: true };
  }

  let body = null;
  let conflict = Boolean(refBody && refBody.conflict);
  if (measured) {
    body = { lo: measured.lo, hi: measured.hi, source: 'measured', said: measured.said };
    if (refBody && (refBody.hi < measured.lo || refBody.lo > measured.hi)) conflict = true;
  } else if (refBody) {
    body = { lo: refBody.lo, hi: refBody.hi, source: 'reference', from: refBody.from };
  }

  const troubles = Array.isArray(entry.troubleZones) ? entry.troubleZones : [];
  /* a favourite piece is how they like it to fit: with no goal said, the
     brand's fit words don't move the chart a size on an assumed one */
  const unmoved = Boolean(favorite) && goalSource === 'assumed' && (Boolean(STRICT_ANCHOR[category]) || favorite.source !== 'brand-size');
  return {
    unmoved, entry, goal, goalSource, line, scale, measured, references, garmentRef, body, conflict, troubles, notes, params, favorite,
    includeUnverified: Boolean(options.includeUnverified) };
}

/* ---------------------------------------------------------
   Scoring
   --------------------------------------------------------- */

/* garment against a garment known to fit, dimension by dimension */
/* Which dimensions a product and the garment that fits can be set side
   by side on: `used`, { <dim>: { value, estimated } } with the
   reference's value in its own units and the product's method; and
   `skipped`, each dimension left out and why. */
function comparable(record, shopper) {
  const ref = shopper.garmentRef;
  const refRow = garmentRow(ref.record, ref.size);
  const dims = record.charts.garment.dimensions;
  const refDims = ref.record.charts.garment.dimensions;
  const used = {};
  const skipped = [];
  Object.keys(shopper.params.garment).forEach((d) => {
    if (!dims[d]) { skipped.push({ dim: d, code: 'target-missing', why: `${record.brand} doesn't publish it` }); return; }
    if (!refDims[d] || !refRow[d]) { skipped.push({ dim: d, code: 'reference-missing', why: ref.measured ? 'you didn\'t measure it' : `${ref.record.brand} doesn't publish it for ${ref.size}` }); return; }
    if (!usableDim(record, d, shopper.includeUnverified)) { skipped.push({ dim: d, code: 'target-unverified', why: `${record.brand}'s ${DIM_NAMES[d]} is ${STATUS_WHY[sizingSchema.measurementStatus(record, d)]}` }); return; }
    if (!usableDim(ref.record, d, shopper.includeUnverified)) { skipped.push({ dim: d, code: 'reference-unverified', why: `your ${ref.record.brand} reference's ${DIM_NAMES[d]} is ${STATUS_WHY[sizingSchema.measurementStatus(ref.record, d)]}` }); return; }
    /* a value published without its method is never compared — not even
       with another whose method is also unstated: two unknowns need not
       be the same method */
    if (dims[d].method === 'not-stated') { skipped.push({ dim: d, code: 'method-unknown', why: `${record.brand} doesn't say how its ${DIM_NAMES[d]} ${d === 'sleeveLength' || d === 'shoulderWidth' ? 'are' : 'is'} measured` }); return; }
    if (refDims[d].method === 'not-stated') { skipped.push({ dim: d, code: 'method-unknown', why: `${ref.measured ? 'your' : `${ref.record.brand}'s`} ${DIM_NAMES[d]} ${d === 'sleeveLength' || d === 'shoulderWidth' ? 'have' : 'has'} no stated method` }); return; }
    const v = inMethodOf(d, ref.record, refRow, dims[d].method);
    if (!v) {
      skipped.push({ dim: d, code: 'method-mismatch', why: `measured differently — ${record.brand}'s ${METHOD_WORDS[dims[d].method] || dims[d].method}, ${ref.measured ? 'yours' : `${ref.record.brand}'s`} ${METHOD_WORDS[refDims[d].method] || refDims[d].method}` });
      return;
    }
    used[d] = v;
  });
  return { used, skipped };
}

function scoreReferenceGarment(record, shopper) {
  const ref = shopper.garmentRef;
  const { used } = comparable(record, shopper);
  const weights = dimWeights(shopper);
  const trouble = troubleSides(shopper);
  const dims = Object.keys(used);
  return record.sizes.map((size) => {
    const row = garmentRow(record, size);
    if (!row) return null;
    /* a size missing a measurement the others are compared on is left
       out of the ranking, never ranked on less: a missing measurement
       would otherwise add nothing to its cost and lift it above sizes
       that publish it (compare() leaves the same size unranked) */
    if (dims.some((d) => !row[d])) return null;
    let cost = 0;
    const parts = [];
    dims.forEach((d) => {
      const { weight } = shopper.params.garment[d];
      const target = toUnits(used[d].value, ref.record.units, record.units);
      const diff = row[d].value - target;
      let c = weight * weights[d] * (diff / toleranceOf(d, record, shopper.params)) ** 2;
      if (trouble[d] && diff < 0) c *= TROUBLE_FACTOR;
      cost += c;
      parts.push({ dim: d, value: row[d].value, target, diff, estimated: used[d].estimated });
    });
    return { size, cost, parts };
  }).filter(Boolean);
}

/* garment against the shopper's body plus the room their fit wants */
function scoreBodyPlusEase(record, shopper) {
  const dims = record.charts.garment.dimensions;
  const units = record.units;
  const [e0, e1] = shopper.params.ease[shopper.goal].map((e) => toUnits(e, 'in', units));
  const lo = shopper.body.lo + e0;
  const hi = shopper.body.hi + e1;
  const centre = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  /* a flat width is a width, not a circumference: the garment's way
     around is taken as twice it (and said, in the data quality), and
     only that is set against the body plus room */
  const flat = dims.chestWidth && dims.chestWidth.method === 'flat-width-armpit-to-armpit';
  const trouble = troubleSides(shopper);
  const { weight, tol } = shopper.params.garment.chestWidth;
  const tolAround = toUnits(tol, 'in', units) * 2;

  const rows = record.sizes.map((size) => ({ size, row: garmentRow(record, size) })).filter((x) => x.row && x.row.chestWidth);
  const scored = rows.map(({ size, row }) => {
    const around = flat ? row.chestWidth.value * 2 : row.chestWidth.value;
    const inside = around >= lo && around <= hi;
    const dist = inside ? 0 : (around < lo ? lo - around : around - hi);
    let c = weight * (inside ? 0.25 * ((around - centre) / half) ** 2 : 0.25 + (dist / tolAround) ** 2);
    if (trouble.chestWidth && around < centre) c *= TROUBLE_FACTOR;
    return { size, cost: c, parts: [{ dim: 'chestWidth', value: row.chestWidth.value, around, band: [lo, hi], inside }] };
  });

  /* lengths have no reference here, except a trouble spot: "runs short"
     aims a little longer than the size the chest alone picks */
  const byChest = scored.slice().sort((a, b) => a.cost - b.cost)[0];
  ['sleeveLength', 'bodyLength'].forEach((d) => {
    if (trouble[d] !== 'short' || !dims[d] || !byChest) return;
    const pickRow = garmentRow(record, byChest.size);
    if (!pickRow[d]) return;
    /* an optional length is used only when every ranked size publishes
       it: a size without it would otherwise escape the penalty and rank
       higher for missing data. Left out for all, and said. */
    const lacking = scored.filter((s) => !garmentRow(record, s.size)[d]).map((s) => s.size);
    if (lacking.length) {
      shopper.notes.push(`${DIM_NAMES[d] === 'sleeves' ? 'Sleeve' : 'Body'} length wasn't used to look for more length: ${record.brand} publishes none for ${lacking.join(', ')}.`);
      return;
    }
    const target = pickRow[d].value + toUnits(SHORT_EXTRA, 'in', units);
    const { weight: w, tol: t } = shopper.params.garment[d];
    scored.forEach((s) => {
      const row = garmentRow(record, s.size);
      if (!row[d]) return;
      const short = Math.max(0, target - row[d].value);
      s.cost += w * TROUBLE_FACTOR * 0.5 * (short / toUnits(t, 'in', units)) ** 2;
      s.parts.push({ dim: d, value: row[d].value, target, diff: row[d].value - target });
    });
  });
  return scored;
}

/* the shopper's body against a body chart, moved a size when the
   brand's fit and the shopper's goal are far apart */
function scoreBodyChart(record, shopper) {
  const offset = shopper.unmoved ? 0 : sizeOffset(record, shopper.goal);
  const tol = toUnits(shopper.params.bodyTol, 'in', record.units);
  const centreB = (shopper.body.lo + shopper.body.hi) / 2;
  const trouble = troubleSides(shopper);
  return record.sizes.map((size, i) => {
    const aim = record.sizes[i - offset];
    const range = aim && bodyRange(record, aim);
    if (!range) return null;
    const centre = (range.lo + range.hi) / 2;
    const half = (range.hi - range.lo) / 2;
    const inside = centreB >= range.lo && centreB <= range.hi;
    const dist = inside ? 0 : (centreB < range.lo ? range.lo - centreB : centreB - range.hi);
    let c = inside ? 0.25 * ((centreB - centre) / half) ** 2 : 0.25 + (dist / tol) ** 2;
    if (trouble.chestWidth && centreB > centre) c *= TROUBLE_FACTOR;
    return { size, cost: c, parts: [{ dim: 'chest', aim, range, inside }] };
  }).filter(Boolean);
}

function sizeOffset(record, goal) {
  const diff = GOAL_RANK[goal] - FIT_RANK[record.fit.fitClass];
  return diff >= 2 ? 1 : diff <= -2 ? -1 : 0;
}

function troubleSides(shopper) {
  const out = {};
  shopper.troubles.forEach((zone) => {
    const t = shopper.params.trouble[zone];
    if (t) out[t.dim] = t.side;
  });
  return out;
}

/* ---------------------------------------------------------
   How each size may feel, dimension by dimension

   For every size of the product, each dimension the category cares
   about gets a class on a five-step scale, relative to the fit the
   shopper asked for (or to the garment they said fits), or no class and
   the reason why. A class is given only when the evidence supports it:

     garment-vs-body       the product's garment chest (around: twice a
                           flat width, an estimate) minus the shopper's
                           chest is the ease, set against the room the
                           fit goal wants. The shopper's chest is a
                           range, so the ease is too: when its two ends
                           land in neighbouring classes the nearer one
                           is named with the other as `couldBe`; when
                           they are further apart, no class is given.
                           Lengths and shoulders: Fynd has no body
                           measurement for them, so no class.
     garment-vs-reference  each published garment measurement against
                           the same measurement, by the same method, of
                           the garment the shopper says fits.
     body-chart            the product publishes no garment
                           measurements, so how a size will feel can't
                           be known: only where the shopper's chest
                           falls in the brand's chart for that size.

   Each dimension also says what its class rests on (`measurements`):
     verified     published values from verified records only (and the
                  shopper's own measurement, taken as given)
     unverified   the same, from a record nobody has checked
     estimated    at least one value was worked out, not published (a
                  circumference from a flat width, a chest from another
                  brand's chart); `estimated` lists which
     unknown      no class: the data doesn't reach that far
   The bands between classes are hypotheses whatever the measurements.

   Stretch would change all of this; no record states it, so none is
   applied. The ranking itself stays the scoring above.
   --------------------------------------------------------- */

const GIRTH_CLASSES = ['too-tight', 'slightly-tight', 'about-right', 'slightly-loose', 'too-loose'];
const LENGTH_CLASSES = ['too-short', 'slightly-short', 'about-right', 'slightly-long', 'too-long'];
const LENGTH_DIMS = ['bodyLength', 'sleeveLength'];
const DIM_NAMES = { chestWidth: 'chest', bodyLength: 'length', sleeveLength: 'sleeves', shoulderWidth: 'shoulders' };
const classesOf = (dim) => (LENGTH_DIMS.includes(dim) ? LENGTH_CLASSES : GIRTH_CLASSES);
const EPS = 1e-9;

/* -2 .. 2: below the about-right band by more than `slight`, below it,
   inside it, above it, above it by more than `slight` */
function step(v, lo, hi, slight) {
  if (v < lo - slight - EPS) return -2;
  if (v < lo - EPS) return -1;
  if (v <= hi + EPS) return 0;
  if (v <= hi + slight + EPS) return 1;
  return 2;
}

function assessSizes(record, method, shopper, scored) {
  const units = record.units;
  const bands = shopper.params.fitBands;
  const inU = (v) => toUnits(v, 'in', units);
  const rankOf = Object.fromEntries(scored.map((s, i) => [s.size, i + 1]));
  const dims = Object.keys(shopper.params.garment);
  const garmentDims = record.charts.garment ? record.charts.garment.dimensions : {};
  const flat = garmentDims.chestWidth && garmentDims.chestWidth.method === 'flat-width-armpit-to-armpit';
  const unclassed = (reason, extra) => Object.assign({ class: null, measurements: 'unknown', reason }, extra || {});
  /* what a class rests on, given the records it read and what was worked
     out: a garment the shopper measured themselves is "shopper-measured",
     never verified, however well the product's own side is checked */
  const basisOf = (records, estimated) => (estimated.length ? 'estimated'
    : !records.filter((r) => !isShopperMeasured(r)).every((r) => sizingSchema.isVerified(r)) ? 'unverified'
      : records.some(isShopperMeasured) ? SHOPPER_MEASURED : 'verified');
  const compare = method === 'reference-garment' ? comparable(record, shopper) : null;

  const forSize = (size) => {
    const row = garmentRow(record, size);
    const out = {};
    if (method === 'body-chart') {
      const range = bodyRange(record, size);
      const centre = (shopper.body.lo + shopper.body.hi) / 2;
      const position = !range ? null : centre < range.lo - EPS ? 'below' : centre > range.hi + EPS ? 'above' : 'inside';
      out.chestWidth = unclassed(`${record.brand} publishes who each size is cut for, not what the garment measures, so how much room ${size} has is unknown.`,
        range ? { chart: { text: range.text, lo: round(range.lo, 2), hi: round(range.hi, 2), estimated: range.estimated, yourChest: position } } : {});
      dims.filter((d) => d !== 'chestWidth').forEach((d) => { out[d] = unclassed(`${record.brand} doesn't publish this product's ${DIM_NAMES[d]}.`); });
      return out;
    }
    dims.forEach((d) => {
      if (!garmentDims[d]) { out[d] = unclassed(`${record.brand} doesn't publish this product's ${DIM_NAMES[d]}.`); return; }
      if (!row || !row[d]) { out[d] = unclassed(`${record.brand} publishes no ${DIM_NAMES[d]} for ${size}.`); return; }
      const value = row[d].value;
      if (method === 'reference-garment') {
        const ref = shopper.garmentRef;
        const v = compare.used[d];
        if (!v) {
          const skip = compare.skipped.find((x) => x.dim === d);
          out[d] = unclassed(`The garment you said fits has no ${DIM_NAMES[d]} measured the same way${skip ? ` (${skip.why})` : ''}.`);
          return;
        }
        const scale = d === 'chestWidth' && flat ? 2 : 1;
        const diff = (value - toUnits(v.value, ref.record.units, units)) * scale;
        const b = bands.reference[d];
        const estimated = [scale === 2 ? 'difference around the chest, taken as twice the flat widths' : null, v.estimated].filter(Boolean);
        out[d] = {
          class: classesOf(d)[step(diff, -inU(b.about), inU(b.about), inU(b.slight - b.about)) + 2],
          measurements: basisOf([record, ref.record], estimated),
          against: ref.measured ? `the ${ref.record.product.name}` : `${ref.record.brand} ${ref.record.product.name} in ${ref.size}`,
          difference: round(diff, 2),
          estimated
        };
        return;
      }
      /* garment-vs-body: only the chest has a body measurement to meet */
      if (d !== 'chestWidth') {
        out[d] = unclassed(`Fynd has no measurement of your ${d === 'shoulderWidth' ? 'shoulders' : d === 'sleeveLength' ? 'arms' : 'torso'} and no garment you said fits to compare ${DIM_NAMES[d]} with.`,
          { garment: value });
        return;
      }
      const around = flat ? value * 2 : value;
      const [e0, e1] = shopper.params.ease[shopper.goal].map(inU);
      const slight = inU(bands.ease.slight);
      const at = (body) => {
        const ease = around - body;
        return ease <= EPS ? -2 : step(ease, e0, e1, slight);   /* no room at all is too tight, whatever the goal */
      };
      const centre = (shopper.body.lo + shopper.body.hi) / 2;
      const ends = [at(shopper.body.hi), at(shopper.body.lo)];
      const ease = { value: round(around - centre, 2), lo: round(around - shopper.body.hi, 2), hi: round(around - shopper.body.lo, 2), aim: [round(e0, 2), round(e1, 2)] };
      const estimated = [flat ? 'garment chest around, as twice its flat width' : null,
        shopper.body.source === 'reference' ? 'your chest, from the chart for a size you wear' : null].filter(Boolean);
      if (Math.abs(ends[1] - ends[0]) >= 2) {
        out[d] = unclassed('What Fynd knows about your chest is too wide a range to say how this size will feel.', { ease, estimated });
        return;
      }
      const mid = at(centre);
      const other = ends.find((e) => e !== mid);
      const refRecords = shopper.body.source === 'reference' ? shopper.body.from.map((x) => x.ref.record) : [];
      out[d] = Object.assign({ class: GIRTH_CLASSES[mid + 2] }, other !== undefined ? { couldBe: GIRTH_CLASSES[other + 2] } : {},
        { measurements: basisOf([record, ...refRecords], estimated), ease, estimated });
    });
    return out;
  };

  const sizes = record.sizes.filter((s) => rankOf[s]);
  const fitBySize = sizes.map((size) => {
    const dimensions = forSize(size);
    const assessed = dims.filter((d) => dimensions[d].class);
    return { size, rank: rankOf[size], dimensions, assessed, summary: summaryOf(size, dimensions, dims) };
  });
  return fitBySize;
}

const CLASS_WORDS = {
  'too-tight': 'too tight', 'slightly-tight': 'slightly tight', 'about-right': 'about right', 'slightly-loose': 'slightly loose', 'too-loose': 'too loose',
  'too-short': 'too short', 'slightly-short': 'slightly short', 'slightly-long': 'slightly long', 'too-long': 'too long'
};

function summaryOf(size, dimensions, dims) {
  const said = dims.filter((d) => dimensions[d].class)
    .map((d) => `${DIM_NAMES[d]} ${CLASS_WORDS[dimensions[d].class]}${dimensions[d].couldBe ? ` (could be ${CLASS_WORDS[dimensions[d].couldBe]})` : ''}`);
  const open = dims.filter((d) => !dimensions[d].class).map((d) => DIM_NAMES[d]);
  const parts = [];
  if (said.length) parts.push(said.join(', '));
  if (open.length) parts.push(`${open.join(', ')}: not enough data`);
  return `${size}: ${parts.join('; ')}.`;
}

/* ---------------------------------------------------------
   What the data is, attribute by attribute
   --------------------------------------------------------- */

function dataQuality(record, method, shopper) {
  const verified = sizingSchema.isVerified(record);
  const out = { verified: [], unverified: [], estimated: [], unknown: [] };
  const put = (name) => out[verified ? 'verified' : 'unverified'].push(name);
  if (record.charts.body) {
    if (record.charts.body.dimensions.chest.kind === 'point') {
      put('body chest (one value per size)');
      out.estimated.push('body chest ranges (halfway to the next size)');
    } else put('body chest ranges');
  }
  const garment = record.charts.garment ? record.charts.garment.dimensions : {};
  Object.keys(shopper.params.garment).forEach((d) => {
    const name = { chestWidth: 'garment chest', bodyLength: 'garment length', sleeveLength: 'sleeve length', shoulderWidth: 'shoulder width' }[d];
    if (garment[d]) put(name); else out.unknown.push(name);
  });
  if (!record.material || !record.material.stretch) out.unknown.push('stretch');
  if (!record.material || !record.material.composition) out.unknown.push('fabric blend');
  Object.values(shopper.params.unassessable).forEach((why) => { if (!out.unknown.includes(why.split(' are')[0])) out.unknown.push(why.split(' are')[0]); });
  if (method === 'body-plus-ease' || method === 'body-chart') {
    if (shopper.body.source === 'reference') out.estimated.push('your chest, from the chart for a size you wear');
  }
  if (method === 'body-plus-ease') {
    out.estimated.push('room around the chest for your fit (a starting assumption)');
    if (record.charts.garment.dimensions.chestWidth.method === 'flat-width-armpit-to-armpit') {
      out.estimated.push('garment chest circumference, estimated as 2 × its published flat width (armpit to armpit)');
    }
  }
  return out;
}

/* ---------------------------------------------------------
   The words
   --------------------------------------------------------- */

const DIM_WORDS = { chestWidth: 'Chest', bodyLength: 'Length', sleeveLength: 'Sleeves', shoulderWidth: 'Shoulders' };
const GOAL_WORDS = { slim: 'tight / slim', 'true-to-size': 'true to size', oversized: 'relaxed / oversized' };

function reasonsFor(method, record, shopper, leading, alternative) {
  const u = record.units;
  const out = [];
  const name = `${record.brand} ${record.product.name}`;
  if (method === 'reference-garment') {
    const ref = shopper.garmentRef;
    const same = ref.record.id === record.id;
    const fav = ref.claim.favorite ? shopper.favorite : null;
    const fits = fav && fav.answer === 'close' ? 'is close to the fit you like' : 'fits';
    if (ref.measured) {
      out.push(`Compared with the measurements you took of your ${fav.brand ? `${fav.brand} ` : ''}T-shirt${fav.size ? ` (${fav.size} on the label)` : ''}, against ${record.brand}'s published garment measurements.`);
    } else if (same) {
      out.push(`You said ${ref.claim.brand} ${ref.size} ${fits}, and this is that product: its ${leading.size} has the same published measurements.`);
    } else {
      out.push(`Compared with the ${ref.record.brand} ${ref.record.product.name} in ${ref.size}, which you said ${fits}, using both products' published garment measurements${fav && fav.match ? ` (Fynd found it in its catalogue by its ${fav.match.by})` : ''}.`);
    }
    leading.parts.forEach((p) => {
      const word = DIM_WORDS[p.dim];
      const est = p.estimated ? ` (its ${p.estimated}: an estimate)` : '';
      if (Math.abs(p.diff) < 0.13) out.push(`${word}: ${leading.size} measures ${inches(p.value, u)}, the same as the one that fits${est}.`);
      else out.push(`${word}: ${leading.size} measures ${inches(p.value, u)}, ${inches(Math.abs(p.diff), u)} ${p.diff > 0 ? 'more' : 'less'} than the one that fits${est}.`);
    });
    comparable(record, shopper).skipped.forEach((x) => out.push(`${DIM_WORDS[x.dim]}: not compared — ${x.why}.`));
  } else if (method === 'body-plus-ease') {
    const p = leading.parts.find((x) => x.dim === 'chestWidth');
    const from = shopper.body.source === 'measured' ? `your ${shopper.body.said} chest` : `a ${inches(shopper.body.lo, u)}–${inches(shopper.body.hi, u)} chest (from the chart for a size you wear)`;
    const [e0, e1] = shopper.params.ease[shopper.goal];
    out.push(`For a ${GOAL_WORDS[shopper.goal]} fit Fynd aims for ${e0}–${e1} in of room around ${from} — a starting assumption, not a rule: ${inches(p.band[0], u)}–${inches(p.band[1], u)} around.`);
    const flat = record.charts.garment.dimensions.chestWidth.method === 'flat-width-armpit-to-armpit';
    out.push(`Chest: ${leading.size} measures ${inches(p.value, u)}${flat ? ` flat, about ${inches(p.around, u)} around` : ' around'} — ${p.inside ? 'inside' : 'outside'} that range.`);
    leading.parts.filter((x) => x.dim !== 'chestWidth').forEach((x) => {
      out.push(`${DIM_WORDS[x.dim]}: you said they run short, so Fynd looked for more length — ${leading.size} measures ${inches(x.value, u)}.`);
    });
  } else {
    const p = leading.parts[0];
    const from = shopper.body.source === 'measured' ? `your ${shopper.body.said} chest` : `a ${inches(shopper.body.lo, u)}–${inches(shopper.body.hi, u)} chest (from the chart for a size you wear)`;
    out.push(`${record.brand}'s body chart puts ${p.range.estimated ? `about ${inches(p.range.lo, u)}–${inches(p.range.hi, u)} (its chart gives ${p.range.text} in)` : `${p.range.text} in`} in ${p.aim}; Fynd compared that with ${from}.`);
    const offset = shopper.unmoved ? 0 : sizeOffset(record, shopper.goal);
    if (offset !== 0) {
      out.push(`${record.brand} calls this "${record.fit.brandWords}", and you like ${GOAL_WORDS[shopper.goal]}, so Fynd aims one size ${offset > 0 ? 'up' : 'down'} from the chart: ${leading.size}.`);
    }
    out.push(`${record.brand} doesn't publish this product's garment measurements, so lengths and widths aren't compared.`);
  }
  if (alternative) {
    out.push(`${alternative.size} is close behind${alternative.why ? ` — ${alternative.why}` : ''}.`);
  }
  return out;
}

function alternativeWhy(method, record, leading, alt) {
  const u = record.units;
  if (method === 'body-chart') return `your chest is near the edge between ${leading.size} and ${alt.size} in ${record.brand}'s chart`;
  const parts = alt.parts.filter((p) => p.dim === 'sleeveLength' || p.dim === 'bodyLength');
  const lead = Object.fromEntries(leading.parts.map((p) => [p.dim, p]));
  const longer = parts.find((p) => lead[p.dim] && p.value > lead[p.dim].value);
  if (longer) return `its ${DIM_WORDS[longer.dim].toLowerCase()} are ${inches(longer.value - lead[longer.dim].value, u)} longer`;
  const chest = alt.parts.find((p) => p.dim === 'chestWidth');
  if (chest && lead.chestWidth) return `${chest.value > lead.chestWidth.value ? 'roomier' : 'closer'} through the chest`;
  return '';
}

/* ---------------------------------------------------------
   The answer
   --------------------------------------------------------- */

/* What the favourite piece gave this answer, for the page to say: where
   its evidence came from, how it was used, and which measurements were
   and weren't set against this product. Null without one. */
function anchorSummary(record, method, shopper) {
  const fav = shopper.favorite;
  if (!fav) return null;
  const asGarment = method === 'reference-garment' && shopper.garmentRef.claim.favorite;
  const compare = asGarment ? comparable(record, shopper) : null;
  const asChest = !asGarment && Boolean(shopper.body) && shopper.body.source === 'reference'
    && shopper.references.some((r) => r.claim.from === 'anchor' || r.claim.from === 'favorite');
  return {
    source: fav.source,
    answer: fav.answer,
    brand: fav.brand,
    size: fav.size,
    match: fav.match,
    likes: fav.likes,
    usedAs: asGarment ? 'garment' : asChest ? 'chest-range' : 'not-used',
    compared: compare ? Object.keys(compare.used).map((d) => ({ dim: d, estimated: compare.used[d].estimated })) : [],
    notCompared: compare ? compare.skipped : []
  };
}

function insufficient(record, missing, next) {
  return { status: 'insufficient', productId: record ? record.id : null, missing, next };
}

function recommend(profile, record, opts) {
  const options = Object.assign({ includeUnverified: false, records: RECORDS }, opts || {});
  const pool = checkedPool(options.records);
  const shown = record && record.id;

  if (!record || sizingSchema.validate(record).length) {
    return insufficient(record, [{ code: 'no-record', message: 'Fynd has no sizing data for this product.' }], []);
  }
  if (!sizingSchema.isVerified(record) && !options.includeUnverified) {
    return insufficient(record, [{
      code: 'unverified-data',
      message: `This product's sizing was copied from ${record.brand}'s own size chart but hasn't been checked against it yet, so Fynd won't suggest a size from it.`
    }], ['Check back once its sizing has been verified.']);
  }
  const params = CATEGORY_PARAMS[record.category];
  if (!params) {
    return insufficient(record, [{ code: 'category-not-covered', message: 'Size suggestions cover hoodies, sweatshirts and T-shirts so far.' }], []);
  }

  /* the shopper's own measurements, raw, before anything is read from them */
  const problems = measurementProblems(profile, record.category, null);
  if (problems.length) return insufficient(record, [{ code: 'invalid-measurements', message: invalidMessage(problems) }], INVALID_NEXT);

  const shopper = readShopper(profile, record, pool, options);

  /* a chest published without its method is neither a width nor a
     circumference Fynd can set against a body */
  const hasGarment = Boolean(record.charts.garment && record.charts.garment.dimensions.chestWidth
    && record.charts.garment.dimensions.chestWidth.method !== 'not-stated' && usableDim(record, 'chestWidth', options.includeUnverified));
  const hasBody = Boolean(record.charts.body);
  /* a garment that fits, sharing no measurement with this product (all
     measured differently), is no comparison at all */
  /* the same eligibility as compare(): a garment is set beside this one
     only on enough measurements taken the same way (enoughToRecommend) */
  const sharedDims = hasGarment && shopper.garmentRef ? COMPARE_DIMS.filter((d) => comparable(record, shopper).used[d]) : [];
  const shared = enoughToRecommend(sharedDims);
  if (hasGarment && shopper.garmentRef && !shared) {
    const named = shopper.garmentRef.measured ? shopper.garmentRef.record.product.name : `${shopper.garmentRef.record.brand} ${shopper.garmentRef.size} you said fits`;
    shopper.notes.push(sharedDims.length
      ? `The ${named} shares only ${listWords(sharedDims.map((d) => DIM_NAMES[d]))} measured the same way with this product — too few to compare, so it wasn't compared.`
      : `The ${named} shares no measurement taken the same way with this product, so it wasn't compared.`);
    /* garment against garment, or nothing: a reference that can't be
       compared is never replaced by the shopper's body and an assumed
       room around it */
    const few = sharedDims.length ? tooFew(sharedDims, []) : { message: shopper.notes[shopper.notes.length - 1] };
    return Object.assign(insufficient(record, [{ code: 'too-few-dimensions', message: few.message }], []), { notes: shopper.notes, anchor: anchorSummary(record, null, shopper) });
  }
  let method = null;
  if (shared) method = 'reference-garment';
  else if (hasGarment && shopper.body) method = 'body-plus-ease';
  else if (hasBody && shopper.body) method = 'body-chart';
  /* nothing else to size by: say the real reason, not a later one */
  if (!method && hasGarment && shopper.garmentRef) {
    const few = sharedDims.length ? tooFew(sharedDims, []) : { message: shopper.notes[shopper.notes.length - 1] };
    return insufficient(record, [{ code: 'too-few-dimensions', message: few.message }], []);
  }

  /* garment against garment needs no sizing line: a measurement is the
     same whoever the label was cut for. Anything read from a chart does. */
  const garmentOnly = method === 'reference-garment' && shopper.garmentRef.claim.favorite;
  if (!garmentOnly && (shopper.line === 'women' || (shopper.scale && shopper.scale !== record.sizeScale))) {
    return insufficient(record, [{ code: 'line-not-covered', message: `Fynd has no women's sizing for this ${record.brand} product yet, and won't read a men's chart as a women's one.` }], []);
  }

  if (!method) {
    const missing = [];
    const next = [];
    const fav = shopper.favorite;
    if (fav && fav.source === 'measured' && !record.charts.garment && !shopper.measured && !shopper.references.length) {
      missing.push({ code: 'incompatible-measurements', message: `You measured your T-shirt, but ${record.brand} publishes only who each size is cut for, not this product's measurements; the two can't be compared.` });
      next.push('Add your chest measurement on your fit profile.');
    } else if (shopper.references.length === 0 && !shopper.measured) {
      if (fav && (fav.source === 'brand-size' || fav.source === 'not-enough')) {
        missing.push({ code: 'anchor-unmeasured', message: `Your${fav.brand ? ` ${fav.brand}` : ''} T-shirt is kept as your reference, but Fynd has no measurements for it${fav.brand ? ` and no ${fav.brand} chart it can read for it` : ''} — the size on a label isn't a measurement.` });
        next.push('Measure your favourite T-shirt laid flat (chest, shoulders, sleeve, length) on your fit profile.');
      }
      const lineUnknown = !shopper.scale && shopper.entry.anchor && shopper.entry.anchor.size;
      if (lineUnknown) {
        missing.push({ code: 'line-needed', message: 'Your size can only be read once Fynd knows whether it\'s men\'s, women\'s or unisex.' });
        next.push('Choose Men’s, Women’s or Unisex beside the size that fits, on your fit profile.');
      }
      missing.push({ code: 'no-evidence', message: 'Fynd has nothing it can measure against: no chest measurement, and no size in a brand it has a size chart for.' });
      const brands = [...new Set(pool.filter((r) => (sizingSchema.isVerified(r) || options.includeUnverified) && (!shopper.favorite || r.category === record.category)).map((r) => r.brand))];
      next.push('Add your chest measurement on your fit profile.');
      if (brands.length) next.push(`Or add a size that fits you in ${brands.join(', ')} to your fit profile.`);
    } else {
      missing.push({ code: 'incompatible-measurements', message: 'What Fynd knows about you is a garment measurement, and this product publishes only body measurements; the two can\'t be compared.' });
      next.push('Add your chest measurement on your fit profile.');
    }
    return Object.assign(insufficient(record, missing, next), { notes: shopper.notes, anchor: anchorSummary(record, null, shopper) });
  }

  const scored = (method === 'reference-garment' ? scoreReferenceGarment(record, shopper)
    : method === 'body-plus-ease' ? scoreBodyPlusEase(record, shopper)
      : scoreBodyChart(record, shopper)).sort((a, b) => a.cost - b.cost);
  if (!scored.length) {
    return insufficient(record, [{ code: 'no-candidates', message: 'None of this product\'s sizes has the measurements needed.' }], []);
  }

  const leading = scored[0];
  const second = scored[1] || null;
  const gap = second ? second.cost - leading.cost : Infinity;
  let alternative = second && gap <= ALTERNATIVE_MARGIN
    ? { size: second.size, why: alternativeWhy(method, record, leading, second), parts: second.parts }
    : null;

  /* a brand's fit words moved the aim a size: that is a judgement, so
     the size its chart gives unmoved stays on offer */
  const shifted = method === 'body-chart' && !shopper.unmoved && sizeOffset(record, shopper.goal) !== 0;
  if (shifted) {
    const unmoved = scoreBodyChart(record, Object.assign({}, shopper, { goal: null, unmoved: true })).sort((a, b) => a.cost - b.cost)[0];
    if (unmoved && unmoved.size !== leading.size) {
      alternative = { size: unmoved.size, why: `the size ${record.brand}'s chart gives before allowing for its "${record.fit.brandWords}" cut`, parts: unmoved.parts };
    }
  }

  /* confidence: from the data */
  let confidence = method === 'reference-garment' ? 'high' : (shopper.body.source === 'measured' ? 'medium' : 'low');
  const caveats = [];
  const fav = shopper.favorite;
  const fromFavorite = method === 'reference-garment' && shopper.garmentRef.claim.favorite;
  if (fromFavorite) {
    const compared = leading.parts.map((p) => p.dim);
    if (shopper.garmentRef.measured) {
      confidence = capAt(confidence, 'medium');
      caveats.push('Your T-shirt was measured at home; a quarter inch either way changes what its measurements say.');
    } else if (!sizingSchema.isVerified(shopper.garmentRef.record)) {
      caveats.push(`The ${shopper.garmentRef.record.brand} measurements for your T-shirt haven't been checked against ${shopper.garmentRef.record.brand}'s chart yet.`);
    }
    if (leading.parts.some((p) => p.estimated)) {
      confidence = capAt(confidence, 'medium');
      caveats.push('Some of your T-shirt\'s measurements were worked out from others, not published (see the reasons).');
    }
    if (compared.length < 2) {
      confidence = capAt(confidence, 'low');
      caveats.push(`Only the ${DIM_NAMES[compared[0]]} could be compared.`);
    } else if (compared.length < 3) {
      confidence = capAt(confidence, 'medium');
    }
    if (fav.answer === 'close') {
      confidence = lower(confidence);
      caveats.push('You said your T-shirt is close to the fit you like, not exactly it, so this aims for close too.');
    }
  } else if (fav && fav.source === 'brand-size' && shopper.references.some((r) => r.claim.from === 'anchor')) {
    caveats.push(`Your ${fav.brand} ${fav.size} was read only as the chest range ${fav.brand}'s chart gives ${fav.size}: a size on a label is a weaker reference than the garment's measurements.`);
  }
  if (method === 'reference-garment' && shopper.garmentRef.record.category !== record.category) {
    confidence = capAt(confidence, 'medium');
    caveats.push(`The garment you compared with is a ${shopper.garmentRef.record.category === 'hoodies' ? 'hoodie' : 'sweatshirt'}, not a ${record.category === 'hoodies' ? 'hoodie' : 'sweatshirt'}.`);
  }
  if (method === 'body-chart' && record.charts.body.dimensions.chest.kind === 'point') {
    confidence = capAt(confidence, 'medium');
    caveats.push(`${record.brand} gives one chest value per size, so the range for each size is Fynd's estimate (halfway to the next size).`);
  }
  if (method === 'body-chart') confidence = capAt(confidence, 'medium');
  if (shopper.conflict) {
    confidence = 'low';
    caveats.push('Your chest measurement and the sizes you said fit point to different sizes.');
  }
  /* a favourite piece is the fit they like: no goal is assumed */
  if (shopper.goalSource === 'assumed' && !fromFavorite) {
    confidence = lower(confidence);
    caveats.push('You haven\'t said how you like this to fit, so Fynd assumed true to size.');
  }
  if (shifted) {
    confidence = lower(confidence);
  } else if (gap < TIE_MARGIN) {
    confidence = lower(confidence);
    caveats.push(`${leading.size} and ${second.size} are nearly level.`);
  } else if (confidence === 'high' && gap < CLEAR_MARGIN) confidence = 'medium';
  if (!shopper.scale && method !== 'reference-garment') {
    caveats.push(`You haven't said whether you shop men's, women's or unisex sizes; this reads ${record.brand}'s ${record.sizeScale === 'men' ? 'men’s' : 'women’s'} chart from your chest measurement.`);
  }

  shopper.troubles.forEach((zone) => {
    if (shopper.params.unassessable[zone]) caveats.push(`You said ${zone === 'neckline-tight' ? 'necklines run tight' : 'tops are loose at the waist'}, but ${shopper.params.unassessable[zone]}, so that wasn't compared.`);
  });
  if (method === 'body-chart' && shopper.troubles.some((z) => z === 'sleeves-short' || z === 'torso-short') && (record.lengthOptions || []).includes('tall')) {
    caveats.push(`${record.brand} publishes no lengths for this product, but sells it in Tall sizes, which may help with sleeves or a torso that run short.`);
  }
  if (!record.material || !record.material.stretch) caveats.push(`${record.brand} doesn't say how much this fabric stretches.`);

  const fitBySize = assessSizes(record, method, shopper, scored);
  const leadFit = fitBySize.find((f) => f.size === leading.size);
  const unassessed = Object.keys(params.garment).filter((d) => !leadFit.dimensions[d].class).map((d) => DIM_NAMES[d]);
  if (unassessed.length) {
    caveats.push(`How ${leading.size} will feel through the ${unassessed.join(', ')} can't be told from the data Fynd has.`);
  }
  caveats.push('This is a suggestion from published measurements, not a promise of fit.');
  const tradeoffs = [leadFit, alternative && fitBySize.find((f) => f.size === alternative.size)].filter(Boolean).map((f) => f.summary);

  return {
    status: 'ok',
    productId: shown,
    product: { brand: record.brand, name: record.product.name, category: record.category, url: record.product.url },
    method,
    leading: leading.size,
    alternative: alternative ? { size: alternative.size, why: alternative.why } : null,
    confidence,
    reasons: reasonsFor(method, record, shopper, leading, alternative),
    ranking: scored.map((s) => ({ size: s.size, score: round(s.cost, 3) })),
    fitBySize,
    fitScale: {
      basis: method === 'reference-garment' ? 'garment-vs-reference' : method === 'body-plus-ease' ? 'garment-vs-body' : 'body-chart',
      relativeTo: method === 'reference-garment' ? (shopper.garmentRef.measured ? `the ${shopper.garmentRef.record.product.name}` : `the ${shopper.garmentRef.record.brand} ${shopper.garmentRef.size} you said fits`)
        : method === 'body-plus-ease' ? `the ${GOAL_WORDS[shopper.goal]} fit you asked for` : null,
      classes: { girth: GIRTH_CLASSES, length: LENGTH_CLASSES },
      units: record.units,
      note: method === 'body-chart'
        ? `${record.brand} publishes only who each size is cut for. Fynd can say where your chest falls in each size's range; it can't say how much room any size has, or how long it is, without the product's finished measurements.`
        : 'The bands between classes are starting hypotheses, not measured facts; real fit feedback is needed to calibrate them.'
    },
    tradeoffs,
    fitGoal: { goal: shopper.goal, from: shopper.goalSource },
    anchor: anchorSummary(record, method, shopper),
    dataQuality: dataQuality(record, method, shopper),
    dataStatus: sizingSchema.isVerified(record) ? 'verified' : 'unverified',
    caveats,
    notes: shopper.notes,
    /* What the answer rests on, as data for the decision policy
       (./decision.js), in the record's units: the shopper's body range
       and where it came from, whether the evidence disagreed, and — for
       a body chart — the chart range the leading size was scored
       against (its own, or the size it was moved from). */
    evidence: {
      units: record.units,
      body: shopper.body ? { lo: round(shopper.body.lo, 3), hi: round(shopper.body.hi, 3), source: shopper.body.source } : null,
      conflict: Boolean(shopper.conflict),
      aim: method === 'body-chart' && leading.parts[0] && leading.parts[0].range
        ? { size: leading.parts[0].aim, lo: round(leading.parts[0].range.lo, 3), hi: round(leading.parts[0].range.hi, 3), estimated: Boolean(leading.parts[0].range.estimated) }
        : null
    }
  };
}

/* =========================================================
   Compare before buying

   compare(profile, record) sets the shopper's fit reference — a
   garment they own and like — beside every size of one product, and
   says, dimension by dimension, how much wider, narrower, longer or
   shorter each size is, in the reference's own unit.

   ---------------------------------------------------------
   What it compares
   ---------------------------------------------------------
   The reference is the product type's favourite piece (a hoodie's for
   a hoodie; failing that, the other fleece top's, and said so):

     measured   the four measurements the shopper took of it, laid flat
     product    its product, found in Fynd's records and checked, with
                that product's published garment measurements in the
                size on its label

   Brand and size alone are not a reference here: they give no
   dimensions to compare. Only finished-garment measurements are used,
   on both sides; a body chart is never compared with a garment. Two
   measurements are compared only when taken the same way (see
   comparable(); a flat chest and a circumference are related by × 2,
   and called estimated). Every other dimension is listed as not
   compared, with why.

   Every difference is signed, in the unit shown, after converting the
   reference into it: difference = this size − the reference, so a
   positive chest is wider and a negative one narrower. Each side's
   measurement is also given whole (value, unit, method, source and
   status: sizingSchema.measurementOf), and only verified ones — or the
   shopper's own — are compared; a crowdsourced or unchecked one is
   listed as not compared, with why.

   ---------------------------------------------------------
   How sizes are ranked
   ---------------------------------------------------------
   Deterministic: each size's distance from the reference is

     Σ  weight(d) × priority(d) × (difference(d) / tolerance(d))²

   over the dimensions both sides measured the same way, with the
   category's own weights and tolerances (CATEGORY_PARAMS.garment):
   chest counts most (weight 1, a 1 in flat tolerance — 2 in for a chest
   published all the way around: toleranceOf), because it sets
   how much room the whole top has; body and sleeve length next (0.6);
   shoulders least (0.3, but a tighter ¾ in tolerance), since a
   shoulder seam's place shifts with the cut. The shopper's "what
   matters most" doubles a dimension's priority. These numbers are
   hypotheses for fit feedback to correct, not tailoring constants.
   Fabric, stretch and construction are said beside the numbers and
   never turned into numbers.

   ---------------------------------------------------------
   When it recommends
   ---------------------------------------------------------
   Only with a verified product, a reference, and at least three of the
   four dimensions compared, the chest among them. With fewer, nothing
   is compared at all — "too-few-dimensions", with which are shared and
   why the rest aren't — so no difference is ever worked out on too
   little. An unverified product gives no numbers at all outside the
   evaluation suite.

   The closest size by the total can still miss on one measurement — a
   chest that matches beside a length 3 in longer. Each compared
   dimension says whether it is within its tolerance (withinTolerance,
   with the tolerance in the unit shown), and `tradeoffs` lists every
   one of the closest size's that isn't, with a caveat saying so. The
   ranking is unchanged; but when every compared measurement of the
   closest size is outside its tolerance, nothing is recommended: the
   comparison is partial, `withheld` says "outside-tolerance", and the
   size and its differences stay as explanation. (The tolerances are
   the scoring's own starting values, not validated limits.)

   A value published without its method ("not-stated") is never
   compared, with either side's reason given.
   ========================================================= */

const COMPARE_DIMS = ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'];
const COMPARE_WORDS = {
  chestWidth: { name: 'Chest', more: 'wider', less: 'narrower' },
  shoulderWidth: { name: 'Shoulders', more: 'wider', less: 'narrower' },
  bodyLength: { name: 'Body length', more: 'longer', less: 'shorter' },
  sleeveLength: { name: 'Sleeves', more: 'longer', less: 'shorter' }
};
const STRETCH_WORDS = { none: 'no stretch', low: 'a little stretch', moderate: 'moderate stretch', high: 'a lot of stretch' };
const SLEEVE_WORDS = { 'set-in': 'set-in sleeves', raglan: 'raglan sleeves', 'drop-shoulder': 'dropped shoulders' };

/* a length in the unit asked for, as a shopper reads it */
/* to the nearest millimetre, or the nearest quarter inch: "2 cm", "¾ in" */
function amount(v, unit) {
  const a = Math.abs(v);
  if (unit === 'cm') return `${round(a, 1)} cm`;
  const q = Math.round(a * 4) / 4;
  const whole = Math.floor(q);
  const glyph = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[round(q - whole, 2)];
  return `${whole ? whole : ''}${glyph}${whole || glyph ? '' : '0'} in`;
}
/* "the same" when the difference rounds to nothing in the unit shown */
/* the same difference as data, for a page to draw: "more" (this size is
   larger), "less" (smaller) or "same" — when it rounds to nothing in the
   unit shown, the rule differenceWords says "the same" by */
const roundsToNothing = (diff, unit) => (unit === 'cm' ? Math.abs(diff) < 0.05 : Math.round(Math.abs(diff) * 4) === 0);
const directionOf = (diff, unit) => (roundsToNothing(diff, unit) ? 'same' : diff > 0 ? 'more' : 'less');
function differenceWords(d, diff, unit) {
  const w = COMPARE_WORDS[d];
  const nothing = roundsToNothing(diff, unit);
  if (nothing) return `${w.name}: the same as your reference`;
  return `${w.name}: ${amount(diff, unit)} ${diff > 0 ? w.more : w.less}`;
}
const listWords = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/* What a record says about its fabric and making, in words, with
   "unknown" wherever it says nothing. Never a fit claim. */
function contextOf(record) {
  if (!record) return null;
  const c = record.construction || {};
  return {
    fit: record.fit ? record.fit.brandWords : null,
    fabric: record.material && record.material.composition ? record.material.composition : 'unknown',
    stretch: record.material && record.material.stretch ? STRETCH_WORDS[record.material.stretch] : 'unknown',
    construction: c.sleeve ? SLEEVE_WORDS[c.sleeve] : 'unknown',
    constructionNotes: c.notes || null
  };
}

/* the shopper's reference for this product's type, or the other
   fleece top's: { category, entry, crossCategory } or null */
function referenceEntry(profile, category) {
  const garments = (profile && profile.garments) || {};
  const usable = (e) => e && e.favorite !== 'none' && e.anchor && (e.anchor.measurements || e.anchor.product);
  if (usable(garments[category])) return { category, entry: garments[category], crossCategory: false };
  const sibling = Object.keys(FAMILY).find((c) => c !== category && FAMILY[c] === FAMILY[category] && usable(garments[c]));
  return sibling ? { category: sibling, entry: garments[sibling], crossCategory: true } : null;
}

/* A body-size chart, said the same way everywhere it can't be compared */
const BODY_ONLY = 'This chart measures the body, not the finished garment. Fynd cannot directly compare these measurements with your reference garment. No size recommendation is available from this chart alone.';

/* What a comparison needs before any size is scored, by the engine's
   own rules: a valid record of a covered kind, verified (unless the
   evaluation suite asks otherwise), with garment measurements not all
   crowdsourced; a reference of that kind or its sibling; and its
   measurements — the product's published ones, or the shopper's own.
   Then which dimensions both sides measured the same way. Shared by
   compare() and validate(), so the rules exist once.
   { fail: { code, message, next, extra } } or { ok: { ... } } */
function prepare(profile, record, options) {
  const pool = checkedPool(options.records);
  const no = (code, message, next, extra) => ({ fail: { code, message, next: next || [], extra: extra || {} } });

  if (!record || sizingSchema.validate(record).length) return no('no-record', 'Fynd has no sizing data for this product.');
  const params = CATEGORY_PARAMS[record.category];
  if (!params) return no('category-not-covered', 'Comparisons cover hoodies, sweatshirts and T-shirts so far.');
  const productContext = contextOf(record);
  if (!sizingSchema.isVerified(record) && !options.includeUnverified) {
    return no('unverified-data', `This product's measurements haven't been checked against ${record.brand}'s own page yet, so Fynd won't compare them.`,
      ['Check back once its sizing has been verified.'], { product: { brand: record.brand, name: record.product.name }, context: productContext, dataStatus: 'unverified' });
  }
  if (!record.charts.garment) {
    return no('body-chart-only', BODY_ONLY,
      ['You can still view the chart, or try a product Fynd holds garment measurements for.'], { product: { brand: record.brand, name: record.product.name }, context: productContext });
  }

  const garmentDimsOf = Object.keys(record.charts.garment.dimensions);
  if (garmentDimsOf.length && garmentDimsOf.every((d) => sizingSchema.measurementStatus(record, d) === 'crowdsourced')) {
    return no('crowdsourced-data', `This product's garment measurements were gathered from shoppers, not checked against ${record.brand}'s own page, so Fynd won't compare them.`,
      [], { product: { brand: record.brand, name: record.product.name }, context: productContext, dataStatus: 'crowdsourced' });
  }

  const found = referenceEntry(profile, record.category);
  /* the shopper's own measurements, raw, before anything is read from them */
  const problems = measurementProblems(profile, record.category, found && found.entry.anchor);
  if (problems.length) {
    return no('invalid-measurements', invalidMessage(problems), INVALID_NEXT, { product: { brand: record.brand, name: record.product.name }, context: productContext });
  }
  if (!found) {
    return no('no-reference', `Save a ${CATEGORY_WORDS[record.category]} that fits you well, with its measurements, to compare against.`,
      [`Measure a ${CATEGORY_WORDS[record.category]} you like, laid flat: chest, body length, shoulders and sleeves.`], { product: { brand: record.brand, name: record.product.name }, context: productContext });
  }
  const anchor = found.entry.anchor;
  const notes = [];
  let ref = null;
  const match = matchProduct(anchor, pool, found.category, { exact: true });
  const matchSize = match ? sizeIn(match.record, anchor.size) : null;
  if (match && matchSize && garmentRow(match.record, matchSize) && (sizingSchema.isVerified(match.record) || options.includeUnverified)) {
    ref = { record: match.record, size: matchSize, product: true, claim: { favorite: true } };
  } else {
    if (match && !matchSize) notes.push(`Fynd found your ${match.record.brand} ${match.record.product.name}, but ${anchor.size ? `not in ${anchor.size}` : 'not the size on its label'}, so its published measurements aren't used.`);
    const measured = measuredRecord(anchor, found.category);
    if (measured) ref = { record: measured, size: measured.sizes[0], measured: true, claim: { favorite: true } };
  }
  if (!ref) {
    return no('no-reference-measurements', 'Your saved reference has no measurements Fynd can compare, and its product isn\'t in Fynd\'s checked records.',
      ['Add your reference\'s four measurements, laid flat.'], { product: { brand: record.brand, name: record.product.name }, context: productContext, notes });
  }

  const favorite = { answer: found.entry.favorite || null, likes: anchor.likes || null };
  const shopper = { garmentRef: ref, params, favorite, includeUnverified: options.includeUnverified };
  const { used, skipped } = comparable(record, shopper);
  return { ok: { params, productContext, found, anchor, notes, ref, favorite, shopper, used, skipped, dims: COMPARE_DIMS.filter((d) => used[d]) } };
}

/* the evidence a recommendation needs: three of the four dimensions, the chest among them */
const enoughToRecommend = (dims) => dims.length >= 3 && dims.includes('chestWidth');
/* Too few measured the same way to compare at all: said with which ones
   are shared, and what would help. Shared by compare() and validate(),
   so no size or difference is ever worked out on less. */
function tooFew(dims, skipped) {
  const shared = listWords(dims.map((d) => DIM_NAMES[d]));
  return {
    message: `Only ${shared} ${dims.length === 1 ? 'is' : 'are'} measured the same way on your reference and this product. Fynd compares sizes only on at least three of chest, length, shoulders and sleeves, the chest among them, so it sets none side by side here.`,
    next: skipped.some((x) => x.code === 'reference-missing') ? ['Add the measurements your reference is missing, laid flat, as Fynd shows.'] : []
  };
}

function compare(profile, record, opts) {
  const options = Object.assign({ includeUnverified: false, records: RECORDS }, opts || {});
  const no = (code, message, next, extra) => Object.assign({ status: 'insufficient', productId: record ? record.id : null, missing: [{ code, message }], next: next || [] }, extra || {});
  const ready = prepare(profile, record, options);
  if (ready.fail) return no(ready.fail.code, ready.fail.message, ready.fail.next, ready.fail.extra);
  const { params, productContext, found, anchor, notes, ref, favorite, shopper, used, skipped, dims } = ready.ok;
  /* eligibility before any difference is worked out: enough measured the same way */
  if (dims.length && !enoughToRecommend(dims)) {
    const few = tooFew(dims, skipped);
    return no('too-few-dimensions', few.message, few.next, { product: { brand: record.brand, name: record.product.name }, context: productContext, dimensionsShared: dims, notCompared: skipped, notes });
  }
  const weights = dimWeights(shopper);
  const unit = options.unit === 'in' || options.unit === 'cm' ? options.unit
    : ref.measured ? ref.record.units : ((profile && profile.measurements && profile.measurements.unit) || record.units);
  const show = (v, from) => round(toUnits(v, from, unit), 2);

  /* the reference, in the unit shown */
  const refRow = garmentRow(ref.record, ref.size);
  const reference = {
    source: ref.measured ? 'measured' : 'product',
    category: found.category,
    crossCategory: found.crossCategory,
    brand: anchor.brand || null,
    size: anchor.size || null,
    product: ref.product ? { id: ref.record.id, name: ref.record.product.name, brand: ref.record.brand } : (anchor.product || null),
    answer: favorite.answer,
    unit,
    values: Object.fromEntries(COMPARE_DIMS.map((d) => [d, refRow[d] ? show(refRow[d].value, ref.record.units) : null])),
    /* each measurement as it was given: its own value and unit, method,
       source and status — the shopper's own are "shopper-measured" */
    measurements: Object.fromEntries(COMPARE_DIMS.map((d) => [d, !refRow[d] ? null : ref.measured
      ? { value: refRow[d].value, unit: ref.record.units, method: ref.record.charts.garment.dimensions[d].method, source: { origin: SHOPPER_MEASURED }, status: SHOPPER_MEASURED }
      : sizingSchema.measurementOf(ref.record, ref.size, d)])),
    methods: Object.fromEntries(COMPARE_DIMS.map((d) => [d, ref.record.charts.garment.dimensions[d] ? ref.record.charts.garment.dimensions[d].method : null])),
    context: ref.product ? contextOf(ref.record) : null
  };

  const sizes = record.sizes.map((size) => {
    const row = garmentRow(record, size);
    if (!row) return null;
    let score = 0;
    const out = {};
    COMPARE_DIMS.forEach((d) => {
      const v = used[d];
      if (!v || !row[d]) {
        const skip = skipped.find((x) => x.dim === d);
        out[d] = { compared: false, candidate: row[d] ? show(row[d].value, record.units) : null, measurement: sizingSchema.measurementOf(record, size, d), why: skip ? skip.why : `${record.brand} publishes no ${DIM_NAMES[d]} for ${size}` };
        return;
      }
      const target = toUnits(v.value, ref.record.units, record.units);
      const diffRecord = row[d].value - target;
      const { weight } = params.garment[d];
      const tol = toleranceOf(d, record, params);
      score += weight * weights[d] * (diffRecord / tol) ** 2;
      const difference = round(toUnits(diffRecord, record.units, unit), 2);
      out[d] = {
        compared: true,
        candidate: show(row[d].value, record.units),
        reference: show(target, record.units),
        /* signed: this size minus the reference, so positive is larger */
        difference,
        /* the miss the score counts as one unit (params.garment tol), in
           the unit shown; within it, the two are treated as similar */
        tolerance: show(tol, record.units),
        withinTolerance: Math.abs(diffRecord) <= tol + EPS,
        measurement: sizingSchema.measurementOf(record, size, d),
        words: differenceWords(d, difference, unit),
        direction: directionOf(difference, unit),
        estimated: v.estimated || null
      };
    });
    return { size, score: round(score, 3), dimensions: out };
  }).filter(Boolean);
  /* a size missing a measurement the others are compared on is shown,
     but not ranked against them — and said */
  const unranked = sizes.filter((s) => !dims.every((d) => s.dimensions[d].compared));
  unranked.forEach((s) => {
    s.score = null;
    s.unranked = `${s.size} isn't ranked: ${record.brand} publishes no ${dims.filter((d) => !s.dimensions[d].compared).map((d) => DIM_NAMES[d]).join(' or ')} for it.`;
    notes.push(s.unranked);
  });
  const rankable = sizes.filter((s) => s.score !== null);

  if (!dims.length || !rankable.length) {
    /* shared measurements, but no size publishes all of them: said as data too */
    const incomplete = dims.length ? unranked.map((s) => s.size) : [];
    return no('nothing-comparable', incomplete.length
      ? `No size of this product publishes every measurement your reference shares with it (${listWords(dims.map((d) => DIM_NAMES[d]))}), so none is ranked.`
      : `Your reference and this product share no measurement taken the same way, so no size can be set beside it.`,
    incomplete.length ? [] : ['Add measurements to your reference on your fit profile, taken as it shows.'],
    { product: { brand: record.brand, name: record.product.name }, context: productContext, reference, notCompared: skipped, notes, dimensionsShared: dims, unranked: incomplete });
  }

  const ranked = rankable.slice().sort((a, b) => a.score - b.score || record.sizes.indexOf(a.size) - record.sizes.indexOf(b.size));
  ranked.forEach((s, i) => { s.rank = i + 1; });
  const closest = ranked[0];
  const second = ranked[1] || null;
  const complete = dims.length === COMPARE_DIMS.length;
  const enough = enoughToRecommend(dims);

  /* how far to trust it, from the data alone */
  const caveats = [];
  let reliability = complete ? 'high' : enough ? 'medium' : 'low';
  if (!complete) caveats.push(`Compared on ${dims.map((d) => DIM_NAMES[d]).join(', ')} only — ${skipped.map((x) => `${DIM_NAMES[x.dim]}: ${x.why}`).join('; ')}.`);
  if (ref.measured) { reliability = capAt(reliability, 'medium'); caveats.push('Your reference was measured at home; a quarter inch either way changes the comparison.'); }
  if (dims.some((d) => used[d].estimated)) { reliability = capAt(reliability, 'medium'); caveats.push('Some differences rest on a worked-out value, not a published one.'); }
  if (found.crossCategory) { reliability = lower(reliability); caveats.push(`Your reference is a ${CATEGORY_WORDS[found.category]}, and this is a ${CATEGORY_WORDS[record.category]}.`); }
  if (favorite.answer === 'close') { reliability = lower(reliability); caveats.push('You said your reference is close to the fit you like, not exactly it.'); }
  const nearTie = second && second.score - closest.score < TIE_MARGIN;
  if (nearTie) { reliability = lower(reliability); caveats.push(`${closest.size} and ${second.size} are about as close as each other.`); }
  if (ref.product && !sizingSchema.isVerified(ref.record)) caveats.push(`The measurements used for your ${ref.record.brand} reference haven't been checked yet.`);
  /* the closest size by the total can still be off on a measurement: each
     one further than its tolerance is a trade-off, listed, never folded
     into the total unsaid */
  const tradeoffs = dims.filter((d) => !closest.dimensions[d].withinTolerance).map((d) => {
    const x = closest.dimensions[d];
    return { size: closest.size, dim: d, difference: x.difference, tolerance: x.tolerance, words: x.words };
  });
  if (tradeoffs.length) caveats.push(`${closest.size} differs from your reference by more than Fynd treats as similar on ${listWords(tradeoffs.map((t) => DIM_NAMES[t.dim]))}.`);
  caveats.push('Matching measurements don\'t guarantee the same fit or feel: fabric, stretch and cut change how a garment wears.');

  const verified = sizingSchema.isVerified(record);
  /* closest is not the same as close: when every measurement compared
     misses its tolerance, the size is shown, never recommended */
  const allOutside = tradeoffs.length === dims.length;
  /* (too few never reaches here: compare() stopped before any difference) */
  const withheld = !verified ? 'unverified' : allOutside ? 'outside-tolerance' : null;
  const recommended = withheld ? null : closest.size;
  const named = listWords(dims.map((d) => DIM_NAMES[d]));
  const summary = recommended
    ? `${recommended} is the closest to your reference across ${named}.`
    : withheld === 'unverified'
      ? `${closest.size} is the closest on ${named}, but this product's measurements haven't been checked, so it isn't a recommendation.`
      : `${closest.size} is the closest size, but its ${named} all differ from your reference by more than Fynd treats as similar, so it isn't a recommendation.`;

  return {
    status: recommended ? 'ok' : 'partial',
    productId: record.id,
    product: { brand: record.brand, name: record.product.name, category: record.category, url: record.product.url },
    unit,
    reference,
    recommended,
    /* why there is no recommendation: "unverified" (the evaluation suite
       only) or "outside-tolerance"; null when there is one */
    withheld,
    closest: closest.size,
    alternative: nearTie ? second.size : null,
    tradeoffs,
    summary,
    reliability,
    dimensionsCompared: dims,
    notCompared: skipped,
    sizes: record.sizes.map((s) => sizes.find((x) => x.size === s)).filter(Boolean),
    priorities: (favorite.likes || []).filter((l) => LIKE_DIMS[l]),
    context: { product: productContext, reference: reference.context },
    method: 'Each size is scored by how far its measurements are from your reference, dimension by dimension — chest counts most, then lengths, then shoulders, and whatever you said matters most counts double. Only measurements taken the same way are compared.',
    caveats,
    notes,
    dataStatus: sizingSchema.isVerified(record) ? 'verified' : 'unverified'
  };
}

/* ---------------------------------------------------------
   Can this product be compared with this reference — before any size
   is scored? The same preconditions compare() uses (prepare()), said as
   one of:

     ready              enough measurements taken the same way on both
                        sides (or convertible by a stated rule) — three of
                        the four, chest among them; compare() will set
                        them side by side, and may still recommend nothing
                        when every one is too far apart
     missing-reference  no reference of this kind, or none with
                        measurements Fynd can use
     missing-target     no record of this product, a kind not covered,
                        or none of its measurements published
     body-only          only who each size is cut for: body measurements,
                        never set beside a garment
     methods            measured in ways that can't be matched, or the
                        source doesn't say how
     unverified         measurements present but not verified (or
                        crowdsourced), never compared

   with an actionable explanation and, for every dimension, what each
   side holds: its method and the kind it measures (schema methodKind),
   its status, and whether a stated rule converts one to the other —
   the source value kept, the converted one named as derived. No
   tolerance or score is involved: those stay compare()'s.
   --------------------------------------------------------- */
const VALIDATION_OF = {
  'invalid-measurements': 'missing-reference',
  'no-record': 'missing-target',
  'category-not-covered': 'missing-target',
  'unverified-data': 'unverified',
  'crowdsourced-data': 'unverified',
  'body-chart-only': 'body-only',
  'no-reference': 'missing-reference',
  'no-reference-measurements': 'missing-reference'
};
const SKIP_OUTCOME = {
  'method-unknown': 'methods',
  'method-mismatch': 'methods',
  'target-unverified': 'unverified',
  'reference-unverified': 'unverified',
  'target-missing': 'missing-target',
  'reference-missing': 'missing-reference'
};
const OUTCOME_ORDER = ['methods', 'unverified', 'missing-reference', 'missing-target'];
const NEXT_STEP = {
  'missing-reference': 'Add your reference garment\'s measurements, laid flat — or name a product Fynd holds checked measurements for.',
  'missing-target': 'You can still view any size chart Fynd holds or can read for it, and the product\'s own page.',
  'body-only': 'You can still view the chart: it says which body each size is cut for.',
  methods: 'Measurements taken differently can\'t be set side by side; where yours are the ones missing, add them as Fynd shows.',
  unverified: 'You can still view the chart as published; Fynd compares it once its measurements are verified.'
};

function validate(profile, record, opts) {
  const options = Object.assign({ includeUnverified: false, records: RECORDS }, opts || {});
  const ready = prepare(profile, record, options);
  const product = record && record.brand && record.product ? { brand: record.brand, name: record.product.name } : null;
  if (ready.fail) {
    const status = VALIDATION_OF[ready.fail.code] || 'missing-target';
    return { status, ready: false, canRecommend: false, code: ready.fail.code, explanation: ready.fail.message, next: ready.fail.next.concat(NEXT_STEP[status] ? [NEXT_STEP[status]] : []), product, dimensions: [] };
  }
  const { ref, used, skipped, dims } = ready.ok;
  const refDims = ref.record.charts.garment.dimensions;
  const own = record.charts.garment.dimensions;
  const side = (rec, d, spec) => (spec ? { method: spec.method, kind: sizingSchema.methodKind(spec.method), status: isShopperMeasured(rec) ? SHOPPER_MEASURED : sizingSchema.measurementStatus(rec, d) } : null);
  const dimensions = COMPARE_DIMS.map((d) => {
    const skip = skipped.find((x) => x.dim === d);
    return {
      dim: d,
      compared: Boolean(used[d]),
      code: skip ? skip.code : null,
      why: skip ? skip.why : null,
      target: side(record, d, own[d]),
      reference: side(ref.record, d, refDims[d]),
      /* a value worked out by a stated rule: the source's own stays the reference's */
      derived: used[d] && used[d].estimated ? { rule: used[d].estimated, from: refDims[d].method, to: own[d].method } : null
    };
  });
  if (dims.length && enoughToRecommend(dims)) {
    return { status: 'ready', ready: true, code: null, canRecommend: true, explanation: `Ready to compare on ${listWords(dims.map((d) => DIM_NAMES[d]))}.`, next: [], product, dimensions };
  }
  if (dims.length) {
    /* some measured the same way, but too few to compare at all: said by why the rest aren't */
    const few = tooFew(dims, skipped);
    const outcomes = skipped.map((x) => SKIP_OUTCOME[x.code]).filter(Boolean);
    return { status: OUTCOME_ORDER.find((o) => outcomes.includes(o)) || 'missing-reference', ready: false, canRecommend: false, code: 'too-few-dimensions', explanation: few.message, next: few.next, product, dimensions };
  }
  const outcomes = skipped.map((x) => SKIP_OUTCOME[x.code]).filter(Boolean);
  const status = OUTCOME_ORDER.find((o) => outcomes.includes(o)) || 'missing-target';
  return {
    status,
    ready: false,
    canRecommend: false,
    code: 'nothing-comparable',
    explanation: `Your reference and this product share no measurement Fynd can set side by side: ${skipped.map((x) => `${DIM_NAMES[x.dim]} — ${x.why}`).join('; ')}.`,
    next: NEXT_STEP[status] ? [NEXT_STEP[status]] : [],
    product,
    dimensions
  };
}

module.exports = { recommend, compare, validate, matchProduct, CATEGORY_PARAMS, FAMILY, TROUBLE_FACTOR, ALTERNATIVE_MARGIN, METHOD_WORDS, sizeOffset, bodyRange, contextOf };
