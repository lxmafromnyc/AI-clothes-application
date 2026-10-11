/* =========================================================
   Fynd — which size of a product to suggest, and how sure to be

   recommend(profile, record) takes a shopper's fit profile (the shape
   assets/fit-profile-schema.js gives it) and one product sizing record
   (api/_sizing/schema.js), and returns either

     { status: "ok", leading, alternative, confidence, reasons, ... }

   or, when the data cannot support an answer,

     { status: "insufficient", missing: [...], next: [...] }

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

   ---------------------------------------------------------
   Three ways to score, by what the product publishes
   ---------------------------------------------------------
     reference-garment   the product has garment measurements, and so
                         does a garment the shopper says fits: compare
                         garment with garment, on the same basis
     body-plus-ease      the product has garment measurements, the
                         shopper has only a body range: aim for the
                         body plus the room their fit wants (EASE)
     body-chart          the product has only a body chart: compare the
                         shopper's body with the chart, moved a size
                         when the brand's own fit words and the
                         shopper's fit goal are far apart

   A body measurement is never compared directly with a garment
   measurement, and two garment measurements are only compared when
   their basis (flat or around; centre back or shoulder seam) is the
   same.

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
  }
};
const CATEGORY_PARAMS = { hoodies: TOPS, sweatshirts: TOPS };

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

const toUnits = (value, from, to) => (from === to ? value : (from === 'in' ? value * IN_TO_CM : value / IN_TO_CM));

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
  if (m && typeof m.chest === 'number' && (m.unit === 'in' || m.unit === 'cm')) {
    const chest = toUnits(m.chest, m.unit, units);
    const slack = toUnits(0.5, 'in', units);
    measured = { lo: chest - slack, hi: chest + slack, value: chest, said: inches(m.chest, m.unit) };
  }

  /* sizes the shopper says fit: the type's anchor, and usual sizes by
     brand marked "about right", for either kind of top */
  const claims = [];
  if (entry.anchor && entry.anchor.brand && entry.anchor.size) claims.push({ brand: entry.anchor.brand, size: entry.anchor.size, category, from: 'anchor' });
  ((profile && profile.brandSizes) || []).forEach((b) => {
    if (b && b.fit === 'about-right' && b.size && CATEGORY_PARAMS[b.category]) claims.push({ brand: b.brand, size: b.size, category: b.category, from: 'usual size' });
  });

  const usable = (r) => (sizingSchema.isVerified(r) || options.includeUnverified) && CATEGORY_PARAMS[r.category] && r.sizeScale === scale;
  const references = [];
  claims.forEach((claim) => {
    const candidates = pool.filter((r) => brandKey(r.brand) === brandKey(claim.brand));
    if (!candidates.length) {
      notes.push(`${claim.brand} ${claim.size} isn't used: Fynd has no ${claim.brand} size chart, and a letter size alone isn't a measurement.`);
      return;
    }
    if (!scale) {
      notes.push(`${claim.brand} ${claim.size} isn't used: without knowing whether it's a men's, women's or unisex size, Fynd can't read it.`);
      return;
    }
    /* prefer the same kind of top, and a record with garment measurements */
    const ranked = candidates.filter(usable).filter((r) => sizeIn(r, claim.size))
      .sort((a, b) => (Number(b.category === claim.category) - Number(a.category === claim.category))
        || (Number(Boolean(b.charts.garment)) - Number(Boolean(a.charts.garment))));
    if (!ranked.length) {
      notes.push(`${claim.brand} ${claim.size} isn't used: Fynd has no checked ${claim.brand} chart for that size and sizing line.`);
      return;
    }
    const ref = ranked[0];
    references.push({ claim, record: ref, size: sizeIn(ref, claim.size) });
  });

  /* the garment that fits: the first reference whose record publishes
     garment measurements for that size */
  const garmentRef = references.find((r) => garmentRow(r.record, r.size)) || null;

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
  return { entry, goal, goalSource, line, scale, measured, references, garmentRef, body, conflict, troubles, notes, params };
}

/* ---------------------------------------------------------
   Scoring
   --------------------------------------------------------- */

/* garment against a garment known to fit, dimension by dimension */
function scoreReferenceGarment(record, shopper) {
  const ref = shopper.garmentRef;
  const refRow = garmentRow(ref.record, ref.size);
  const refDims = ref.record.charts.garment.dimensions;
  const dims = record.charts.garment.dimensions;
  const used = Object.keys(shopper.params.garment).filter((d) => dims[d] && refDims[d] && dims[d].basis === refDims[d].basis && refRow[d]);
  const trouble = troubleSides(shopper);
  return record.sizes.map((size) => {
    const row = garmentRow(record, size);
    if (!row) return null;
    let cost = 0;
    const parts = [];
    used.forEach((d) => {
      if (!row[d]) return;
      const { weight, tol } = shopper.params.garment[d];
      const target = toUnits(refRow[d].value, ref.record.units, record.units);
      const diff = row[d].value - target;
      let c = weight * (diff / toUnits(tol, 'in', record.units)) ** 2;
      if (trouble[d] && diff < 0) c *= TROUBLE_FACTOR;
      cost += c;
      parts.push({ dim: d, value: row[d].value, target, diff });
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
  const flat = dims.chestWidth && dims.chestWidth.basis === 'flat';
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
  if (method === 'body-plus-ease') out.estimated.push('room around the chest for your fit (a starting assumption)');
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
    out.push(same
      ? `You said ${ref.claim.brand} ${ref.size} fits you, and this is that product: its ${leading.size} has the same published measurements.`
      : `Compared with the ${ref.record.brand} ${ref.record.product.name} in ${ref.size}, which you said fits, using both products' published garment measurements.`);
    leading.parts.forEach((p) => {
      const word = DIM_WORDS[p.dim];
      if (Math.abs(p.diff) < 0.13) out.push(`${word}: ${leading.size} measures ${inches(p.value, u)}, the same as the one that fits.`);
      else out.push(`${word}: ${leading.size} measures ${inches(p.value, u)}, ${inches(Math.abs(p.diff), u)} ${p.diff > 0 ? 'more' : 'less'} than the one that fits.`);
    });
  } else if (method === 'body-plus-ease') {
    const p = leading.parts.find((x) => x.dim === 'chestWidth');
    const from = shopper.body.source === 'measured' ? `your ${shopper.body.said} chest` : `a ${inches(shopper.body.lo, u)}–${inches(shopper.body.hi, u)} chest (from the chart for a size you wear)`;
    const [e0, e1] = shopper.params.ease[shopper.goal];
    out.push(`For a ${GOAL_WORDS[shopper.goal]} fit Fynd aims for ${e0}–${e1} in of room around ${from} — a starting assumption, not a rule: ${inches(p.band[0], u)}–${inches(p.band[1], u)} around.`);
    const flat = record.charts.garment.dimensions.chestWidth.basis === 'flat';
    out.push(`Chest: ${leading.size} measures ${inches(p.value, u)}${flat ? ` flat, about ${inches(p.around, u)} around` : ' around'} — ${p.inside ? 'inside' : 'outside'} that range.`);
    leading.parts.filter((x) => x.dim !== 'chestWidth').forEach((x) => {
      out.push(`${DIM_WORDS[x.dim]}: you said they run short, so Fynd looked for more length — ${leading.size} measures ${inches(x.value, u)}.`);
    });
  } else {
    const p = leading.parts[0];
    const from = shopper.body.source === 'measured' ? `your ${shopper.body.said} chest` : `a ${inches(shopper.body.lo, u)}–${inches(shopper.body.hi, u)} chest (from the chart for a size you wear)`;
    out.push(`${record.brand}'s body chart puts ${p.range.estimated ? `about ${inches(p.range.lo, u)}–${inches(p.range.hi, u)} (its chart gives ${p.range.text} in)` : `${p.range.text} in`} in ${p.aim}; Fynd compared that with ${from}.`);
    const offset = sizeOffset(record, shopper.goal);
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

function insufficient(record, missing, next) {
  return { status: 'insufficient', productId: record ? record.id : null, missing, next };
}

function recommend(profile, record, opts) {
  const options = Object.assign({ includeUnverified: false, records: RECORDS }, opts || {});
  const pool = options.records;
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
    return insufficient(record, [{ code: 'category-not-covered', message: 'Size suggestions cover hoodies and sweatshirts so far.' }], []);
  }

  const shopper = readShopper(profile, record, pool, options);
  if (shopper.line === 'women' || (shopper.scale && shopper.scale !== record.sizeScale)) {
    return insufficient(record, [{ code: 'line-not-covered', message: `Fynd has no women's sizing for this ${record.brand} product yet, and won't read a men's chart as a women's one.` }], []);
  }

  const hasGarment = Boolean(record.charts.garment && record.charts.garment.dimensions.chestWidth);
  const hasBody = Boolean(record.charts.body);
  let method = null;
  if (hasGarment && shopper.garmentRef) method = 'reference-garment';
  else if (hasGarment && shopper.body) method = 'body-plus-ease';
  else if (hasBody && shopper.body) method = 'body-chart';

  if (!method) {
    const missing = [];
    const next = [];
    if (shopper.references.length === 0 && !shopper.measured) {
      const lineUnknown = !shopper.scale && shopper.entry.anchor && shopper.entry.anchor.size;
      if (lineUnknown) {
        missing.push({ code: 'line-needed', message: 'Your size can only be read once Fynd knows whether it\'s men\'s, women\'s or unisex.' });
        next.push('Choose Men’s, Women’s or Unisex beside the size that fits, in the fit guide.');
      }
      missing.push({ code: 'no-evidence', message: 'Fynd has nothing it can measure against: no chest measurement, and no size in a brand it has a size chart for.' });
      const brands = [...new Set(pool.filter((r) => sizingSchema.isVerified(r) || options.includeUnverified).map((r) => r.brand))];
      next.push('Add your chest measurement on your fit profile.');
      if (brands.length) next.push(`Or tell the fit guide a size that fits you in ${brands.join(', ')}.`);
    } else {
      missing.push({ code: 'incompatible-measurements', message: 'What Fynd knows about you is a garment measurement, and this product publishes only body measurements; the two can\'t be compared.' });
      next.push('Add your chest measurement on your fit profile.');
    }
    return Object.assign(insufficient(record, missing, next), { notes: shopper.notes });
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
  const shifted = method === 'body-chart' && sizeOffset(record, shopper.goal) !== 0;
  if (shifted) {
    const unmoved = scoreBodyChart(record, Object.assign({}, shopper, { goal: null, unmoved: true })).sort((a, b) => a.cost - b.cost)[0];
    if (unmoved && unmoved.size !== leading.size) {
      alternative = { size: unmoved.size, why: `the size ${record.brand}'s chart gives before allowing for its "${record.fit.brandWords}" cut`, parts: unmoved.parts };
    }
  }

  /* confidence: from the data */
  let confidence = method === 'reference-garment' ? 'high' : (shopper.body.source === 'measured' ? 'medium' : 'low');
  const caveats = [];
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
  if (shopper.goalSource === 'assumed') {
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
  caveats.push('This is a suggestion from published measurements, not a promise of fit.');

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
    fitGoal: { goal: shopper.goal, from: shopper.goalSource },
    dataQuality: dataQuality(record, method, shopper),
    dataStatus: sizingSchema.isVerified(record) ? 'verified' : 'unverified',
    caveats,
    notes: shopper.notes
  };
}

module.exports = { recommend, CATEGORY_PARAMS, TROUBLE_FACTOR, ALTERNATIVE_MARGIN, sizeOffset, bodyRange };
