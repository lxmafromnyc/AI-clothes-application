/* =========================================================
   Fynd — Fit Anchor: a garment that already fits, and the size of a
   new one that should fit the same way

   One shared, dependency-free module (the browser extension carries an
   identical copy in extension/vendor/; scripts/sync-extension.js keeps
   it and test-extension fails if the two differ). Pure functions only:
   nothing here reads a page, stores anything or makes a request.

   ---------------------------------------------------------
   What a Fit Anchor is
   ---------------------------------------------------------
   A garment the shopper already owns and how it fits them:

     { id, brand, category, size,              what it is
       feel: { fit: 'tight'|'right'|'loose',   how it feels on them today
               length: 'short'|'right'|'long' },
       product: { name, url, code } | null,     the exact product, if known
       dims: { chestWidth: Measurement, ... },  its known garment dimensions
       feedback: [Outcome, ...] }               how recommendations turned out

   A Measurement always carries where it came from:

     { value, unit: 'in', method: 'flat'|'around'|'length',
       source: 'fynd-record'     Fynd's own checked record of this product
             | 'retailer-page'   the product's own published garment chart,
                                 read in the shopper's browser
             | 'shopper'         typed or corrected by the shopper
             | 'similar-product' another product's checked measurements in
                                 the same brand, category and size —
                                 a stand-in, never the garment itself,
       verified: boolean,        true only for a 'fynd-record' Fynd has
                                 checked against its source
       note }

   A brand and a size label alone give NO dimensions: a letter is not a
   measurement. Such an anchor can still steer a same-brand label match,
   at low confidence, and says so.

   ---------------------------------------------------------
   Known dimensions, reported feel, inferred preference, confidence
   ---------------------------------------------------------
   Kept apart throughout:

     known       anchor.dims — the reference garment's measurements
     reported    anchor.feel — how the shopper says it fits
     inferred    preferred(anchor) — for each dimension, a RANGE the
                 shopper probably likes: the known value moved by the
                 reported feel (HEURISTICS.feel: "feels tight" means the
                 preferred chest width is somewhere above the garment's,
                 by between `min` and `max`), then narrowed by every
                 recorded outcome ("L was too tight" puts the preferred
                 width above L's). One answer never becomes a point.
     confidence  from the data alone: where each measurement came from,
                 how the target chart was read, how many dimensions could
                 be compared, how far apart the best two sizes are, and
                 whether the evidence agrees

   Every number in HEURISTICS is a starting hypothesis, exported and
   overridable, to be corrected by measured outcomes — not a fact of
   tailoring.

   ---------------------------------------------------------
   Comparing with a target chart
   ---------------------------------------------------------
   recommend(anchor, chart) takes a chart as assets/sizing-tables.js
   labels it ({ measures, unit, columns, rows, methods }) and:

     1  refuses a body chart for a garment comparison (a body is not a
        garment), and a chart that says neither, unless allowed
     2  maps each column to a dimension of the anchor's category
        (DIMENSIONS[*].match), and reads each value in inches — a stated
        unit first, else the column's own words, else inferred from the
        values' size and marked inferred
     3  puts widths on one scale (half the way around: a flat width),
        from the column's words, else from the values' size, marked
     4  checks the chart: sizes in order, widths growing with size, no
        step wildly out of line — a problem lowers confidence, a broken
        main dimension makes it unusable
     5  scores each size: for each dimension both sides have, how far it
        sits outside the preferred range, in that dimension's tolerance,
        weighted (category weight × the shopper's own priority)
     6  ranks the sizes, says how each dimension differs, and how sure

   It never recommends from a single dimension silently, never states
   an exact difference against an estimate, and says "insufficient"
   with what is missing when the data can't carry an answer.
   ========================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FyndFitAnchor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CM_PER_IN = 2.54;

  /* ---------- what is measured, per kind of garment ---------- */

  /* axis: which of the shopper's two answers speaks to it ('fit' for
     widths, 'length' for lengths). kind: 'width' values may be given
     flat or all the way around; 'length' values are as they are.
     flatMax / aroundMin (inches): a width whose every value sits at or
     under flatMax can only be flat, at or over aroundMin only all the
     way around, for this dimension on an adult garment — used only when
     the chart's words don't say, and marked inferred. */
  const DIMENSIONS = {
    chestWidth: { label: 'chest', phrase: 'chest width', axis: 'fit', kind: 'width', match: /\b(chest|bust|pit[\s-]*to[\s-]*pit|armpit[\s-]*to[\s-]*armpit|body width)\b/i, flatMax: 31, aroundMin: 33 },
    shoulderWidth: { label: 'shoulders', phrase: 'shoulder width', axis: 'fit', kind: 'length', match: /\bshoulders?\b/i, plausible: [12, 26] },
    bodyLength: { label: 'length', phrase: 'body length', axis: 'length', kind: 'length', match: /\b(body length|back length|total length|garment length|front length|length)\b/i, not: /\b(sleeve|inseam|outseam|rise|leg|arm)\b/i, plausible: [17, 48] },
    sleeveLength: { label: 'sleeve', phrase: 'sleeve length', axis: 'length', kind: 'length', match: /\b(sleeves?|arm length)\b/i, plausible: [3, 38] },
    waist: { label: 'waist', phrase: 'waist', axis: 'fit', kind: 'width', match: /\bwaist\b/i, flatMax: 23, aroundMin: 24 },
    hip: { label: 'hips', phrase: 'hip', axis: 'fit', kind: 'width', match: /\b(hips?|seat)\b/i, flatMax: 27, aroundMin: 30 },
    thigh: { label: 'thigh', phrase: 'thigh', axis: 'fit', kind: 'width', match: /\bthigh\b/i, flatMax: 16, aroundMin: 18 },
    rise: { label: 'rise', phrase: 'rise', axis: 'length', kind: 'length', match: /\brise\b/i, plausible: [6, 17] },
    inseam: { label: 'inseam', phrase: 'inseam', axis: 'length', kind: 'length', match: /\b(inseam|inside leg|inner leg)\b/i, plausible: [3, 38] },
    legOpening: { label: 'leg opening', phrase: 'leg opening', axis: 'fit', kind: 'width', match: /\b(leg opening|hem width|bottom opening|leg width|hem)\b/i, flatMax: 11, aroundMin: 12 }
  };

  const TOP_DIMS = ['chestWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth'];
  const BOTTOM_DIMS = ['waist', 'hip', 'thigh', 'rise', 'inseam', 'legOpening'];

  /* family: which categories may stand in for each other (at lower
     confidence); main: the dimension a comparison can't go without */
  const CATEGORIES = {
    tshirt: { label: 'T-shirt', family: 'tops', dims: TOP_DIMS, main: 'chestWidth' },
    shirt: { label: 'Shirt', family: 'tops', dims: TOP_DIMS, main: 'chestWidth' },
    sweatshirt: { label: 'Sweatshirt or hoodie', family: 'tops', dims: TOP_DIMS, main: 'chestWidth' },
    sweater: { label: 'Sweater', family: 'tops', dims: TOP_DIMS, main: 'chestWidth' },
    jacket: { label: 'Jacket or coat', family: 'outerwear', dims: TOP_DIMS, main: 'chestWidth' },
    jeans: { label: 'Jeans', family: 'bottoms', dims: BOTTOM_DIMS, main: 'waist' },
    pants: { label: 'Pants', family: 'bottoms', dims: BOTTOM_DIMS, main: 'waist' },
    shorts: { label: 'Shorts', family: 'bottoms', dims: ['waist', 'hip', 'thigh', 'rise', 'inseam', 'legOpening'], main: 'waist' }
  };

  /* ---------- the tunable part: hypotheses, not facts ----------
     weight     how much a miss on this dimension counts
     tol        inches (flat, for widths) that count as one unit of miss
     about      half-width of "about right" around a garment that fits
     feel       how far the preferred value moves from the reference
                garment for each answer: [min, max] inches, added */
  const TOP_PARAMS = {
    chestWidth: { weight: 1, tol: 0.75, about: 0.5, feel: { tight: [0.25, 1.5], loose: [-1.5, -0.25] } },
    bodyLength: { weight: 0.6, tol: 1, about: 0.5, feel: { short: [0.5, 2], long: [-2, -0.5] } },
    sleeveLength: { weight: 0.5, tol: 0.75, about: 0.5, feel: { short: [0.5, 1.5], long: [-1.5, -0.5] } },
    shoulderWidth: { weight: 0.3, tol: 0.5, about: 0.375, feel: { tight: [0.125, 0.75], loose: [-0.75, -0.125] } }
  };
  const BOTTOM_PARAMS = {
    waist: { weight: 1, tol: 0.5, about: 0.25, feel: { tight: [0.25, 1], loose: [-1, -0.25] } },
    hip: { weight: 0.6, tol: 0.75, about: 0.5, feel: { tight: [0.25, 1], loose: [-1, -0.25] } },
    thigh: { weight: 0.4, tol: 0.5, about: 0.375, feel: { tight: [0.125, 0.75], loose: [-0.75, -0.125] } },
    rise: { weight: 0.3, tol: 0.5, about: 0.375, feel: {} },
    inseam: { weight: 0.8, tol: 0.75, about: 0.5, feel: { short: [0.5, 2], long: [-2, -0.5] } },
    legOpening: { weight: 0.2, tol: 0.5, about: 0.5, feel: { tight: [0.125, 0.75], loose: [-0.75, -0.125] } }
  };
  const HEURISTICS = {
    params: { tops: TOP_PARAMS, outerwear: TOP_PARAMS, bottoms: BOTTOM_PARAMS },
    /* inside the preferred range, a size nearer its middle wins a tie */
    centring: 0.1,
    /* the best two this close (in score) is a near tie */
    tieMargin: 0.25,
    /* high confidence needs the runner-up at least this far behind */
    clearMargin: 0.75,
    /* an outcome on one size puts the preferred range past that size's
       value by the dimension's "about right" band, and at least this
       (inches) */
    outcomeStep: 0.125,
    /* a dimension on an axis the shopper said was off ("feels tight")
       weighs this much more: they told us it matters */
    reportedBoost: 1.5,
    /* a size no bigger (or no longer) than the reference the shopper said
       feels tight (or short) repeats their complaint: this much is added
       to its miss on that dimension, until a measured outcome speaks */
    repeatPenalty: 1,
    /* a step between neighbouring sizes this many times the chart's
       typical step is out of line */
    stepOutlier: 4
  };

  /* ---------- small helpers ---------- */

  /* "T-shirt" keeps its capital in a sentence; other kinds don't need one */
  const noun = (category) => { const l = CATEGORIES[category].label; return /^T-/.test(l) ? l : l.toLowerCase(); };
  /* "a T-shirt", "a jacket or coat", but "jeans": pairs take no article */
  const PAIRS = { jeans: true, pants: true, shorts: true };
  const aNoun = (category) => (PAIRS[category] ? noun(category) : `a ${noun(category)}`);

  const LEVELS = ['low', 'medium', 'high'];
  const cap = (level, at) => LEVELS[Math.min(LEVELS.indexOf(level), LEVELS.indexOf(at))];
  const lower = (level) => LEVELS[Math.max(0, LEVELS.indexOf(level) - 1)];
  const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  /* 22.5 → "22½ in"; 20.125 → "20⅛ in"; in cm, one decimal */
  const FRACTIONS = { 0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.75: '¾', 0.875: '⅞' };
  function format(inches, unit) {
    if (!isNum(inches)) return '';
    if (unit === 'cm') return `${round(inches * CM_PER_IN, 1)} cm`;
    const eighths = Math.round(Math.abs(inches) * 8) / 8;
    const whole = Math.floor(eighths);
    const frac = round(eighths - whole, 3);
    const sign = inches < 0 ? '−' : '';
    return `${sign}${whole || !FRACTIONS[frac] ? whole : ''}${FRACTIONS[frac] || ''} in`.replace(/^0(?=[⅛¼⅜½⅝¾⅞])/, '');
  }

  /* the order sizes are worn in: letters, then numbers, then "32x30" */
  const LETTERS = ['XXXS', '3XS', 'XXS', '2XS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
  const LETTER_RANK = { XXXS: 0, '3XS': 0, XXS: 1, '2XS': 1, XS: 2, S: 3, M: 4, L: 5, XL: 6, XXL: 7, '2XL': 7, XXXL: 8, '3XL': 8, '4XL': 9, '5XL': 10, '6XL': 11 };
  function sizeRank(label) {
    const s = String(label || '').trim().toUpperCase().replace(/\s+/g, '');
    if (Object.prototype.hasOwnProperty.call(LETTER_RANK, s)) return LETTER_RANK[s];
    const pair = /^(\d{1,3})[X/×](\d{1,3})$/.exec(s);
    if (pair) return 100 + Number(pair[1]) + Number(pair[2]) / 1000;
    const n = /^(\d{1,3}(?:\.\d)?)$/.exec(s);
    if (n) return 100 + Number(n[1]);
    return null;
  }
  const sameSize = (a, b) => String(a || '').trim().toUpperCase().replace(/\s+/g, '') === String(b || '').trim().toUpperCase().replace(/\s+/g, '');

  /* "20", "20.5", "20,5", "20 1/2", "20½", "51–53", "51 cm", 20" → { value, unit, range } */
  const UNICODE_FRAC = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
  function parseNumber(s) {
    const m = /^(\d{1,3})(?:[.,](\d{1,2}))?(?:\s*(?:(\d)\/(\d{1,2})|([¼½¾⅛⅜⅝⅞])))?$/.exec(s.trim());
    if (!m) return null;
    let v = Number(m[1]) + (m[2] ? Number(`0.${m[2]}`) : 0);
    if (m[3] && m[4] && Number(m[4]) > 0) v += Number(m[3]) / Number(m[4]);
    if (m[5]) v += UNICODE_FRAC[m[5]];
    return v;
  }
  function parseCell(cell) {
    let s = String(cell || '').replace(/ /g, ' ').trim();
    if (!s) return null;
    let unit = null;
    if (/\bcm\b/i.test(s)) unit = 'cm';
    else if (/["″]|\binch(es)?\b|\bin\.?$/i.test(s)) unit = 'in';
    s = s.replace(/\s*(cm|inch(es)?|in\.?|["″])\s*/gi, ' ').trim();
    const parts = s.split(/\s*(?:[-–—]|to)\s*/i);
    if (parts.length === 2) {
      const a = parseNumber(parts[0]);
      const b = parseNumber(parts[1]);
      if (isNum(a) && isNum(b) && b >= a) return { value: (a + b) / 2, unit, range: [a, b] };
      return null;
    }
    const v = parseNumber(s);
    return isNum(v) ? { value: v, unit, range: null } : null;
  }

  /* the unit a column's own heading names */
  function headerUnit(header) {
    const cm = /\b(cm|centimet(?:er|re)s?)\b/i.test(header);
    const inch = /\binch(es)?\b|\(in\)|["″]/i.test(header);
    return cm && !inch ? 'cm' : inch && !cm ? 'in' : null;
  }

  /* how a width column was measured, from its own words (or the chart's) */
  function headerMethod(header, said) {
    const words = `${header} ${said || ''}`;
    if (/\b(circumference|all (the way )?around|around)\b/i.test(words)) return 'around';
    if (/\b(width|flat|half|across|pit[\s-]*to[\s-]*pit|armpit[\s-]*to[\s-]*armpit|laid flat|measured flat)\b/i.test(words)) return 'flat';
    return null;
  }

  /* How a length was measured, from the chart's own words. Two lengths
     measured from different points aren't the same quantity: a sleeve
     from the centre back includes half the shoulders; a front length
     isn't a back length. null: not said. */
  const LENGTH_METHODS = {
    sleeveLength: [[/cent(?:er|re)[\s-]*back|\bCB\b/i, 'center-back'], [/shoulder|seam/i, 'shoulder-seam']],
    bodyLength: [[/\bfront\b/i, 'front'], [/\bHPS\b|high(?:est)?[\s-]*point|from (?:the )?shoulder/i, 'hps'], [/\bback\b|cent(?:er|re)[\s-]*back/i, 'back']],
    shoulderWidth: [[/seam[\s-]*to[\s-]*seam/i, 'seam-to-seam'], [/broadest/i, 'broadest']],
    inseam: [], rise: [[/\bfront\b/i, 'front'], [/\bback\b/i, 'back']]
  };
  /* sleeves differ by inches between methods: compared only when both say the same */
  const METHOD_REQUIRED = { sleeveLength: true };
  function lengthMethod(dim, words) {
    const rules = LENGTH_METHODS[dim] || [];
    const hit = rules.find(([re]) => re.test(words || ''));
    return hit ? hit[1] : null;
  }
  const METHOD_LABELS = { 'center-back': 'from the centre back', 'shoulder-seam': 'from the shoulder seam', front: 'front length', back: 'back length', hps: 'from the top of the shoulder', 'seam-to-seam': 'seam to seam', broadest: 'at the broadest point' };

  function dimensionOf(header, allowed) {
    for (const id of allowed) {
      const d = DIMENSIONS[id];
      if (d.match.test(header) && !(d.not && d.not.test(header))) return id;
    }
    return null;
  }

  /* ---------- reading a target chart ---------- */

  /* A chart (assets/sizing-tables.js shape) → for one category:
       { measures, sizes: [{ size, rank, dims: { id: { value (in, flat for
         widths), raw, method, methodBy, unit, unitBy, range } } }],
         columns: { id: { header, method, methodBy, unit, unitBy } },
         issues: [{ dim, kind, severity, text }] }
     unitBy / methodBy: 'stated' (the chart's or column's words) or
     'inferred' (from the values' size). Nothing missing is filled in. */
  function readChart(chart, category) {
    const cat = CATEGORIES[category];
    const out = { measures: chart && chart.measures || 'not-stated', sizes: [], columns: {}, issues: [] };
    if (!cat || !chart || !Array.isArray(chart.columns) || !Array.isArray(chart.rows)) return out;
    const tableUnit = chart.unit === 'in' || chart.unit === 'cm' ? chart.unit : null;
    const methods = Array.isArray(chart.methods) ? chart.methods : [];
    const map = chart.columns.map((h, i) => ({ i, header: String(h || ''), dim: dimensionOf(String(h || ''), cat.dims) }));
    const seen = new Set();
    map.forEach((c) => {
      if (!c.dim) return;
      /* two columns for one dimension: the one in the stated unit or flat, else the first */
      if (seen.has(c.dim)) {
        const prev = out.columns[c.dim];
        const better = headerUnit(c.header) === 'in' && prev.unit !== 'in';
        if (!better) { c.dim = null; return; }
        map.find((m) => m.i === prev.index).dim = null;
      }
      seen.add(c.dim);
      out.columns[c.dim] = { index: c.i, header: c.header, unit: headerUnit(c.header), method: DIMENSIONS[c.dim].kind === 'width' ? headerMethod(c.header, methods[c.i]) : lengthMethod(c.dim, `${c.header} ${methods[c.i] || ''}`) };
    });

    const rows = chart.rows.filter((r) => r && typeof r.size === 'string' && Array.isArray(r.values));
    const labels = new Set();
    rows.forEach((r) => {
      const key = r.size.trim().toUpperCase();
      if (labels.has(key)) out.issues.push({ dim: null, kind: 'duplicate-size', severity: 'minor', text: `Size ${r.size} appears twice in the chart; the first is used.` });
      labels.add(key);
    });

    Object.keys(out.columns).forEach((dim) => {
      const col = out.columns[dim];
      const parsed = rows.map((r) => parseCell(r.values[col.index]));
      const cellUnits = new Set(parsed.filter((p) => p && p.unit).map((p) => p.unit));
      /* the unit: the column's words, the cells', the chart's — else the values' size */
      let unit = col.unit || (cellUnits.size === 1 ? [...cellUnits][0] : null) || tableUnit;
      col.unitBy = unit ? 'stated' : null;
      const values = parsed.filter(Boolean).map((p) => p.value);
      if (!unit && values.length) {
        unit = inferUnit(dim, values, col.method);
        col.unitBy = unit ? 'inferred' : null;
      }
      col.unit = unit;
      if (!unit) out.issues.push({ dim, kind: 'unknown-unit', severity: 'blocking', text: `The chart doesn’t say whether its ${DIMENSIONS[dim].label} is in inches or centimetres, and the values could be either.` });
      /* a width: flat or all the way around */
      if (DIMENSIONS[dim].kind === 'width') {
        col.methodBy = col.method ? 'stated' : null;
        if (!col.method && unit) {
          const inches = values.map((v) => (unit === 'cm' ? v / CM_PER_IN : v));
          col.method = inferMethod(dim, inches);
          col.methodBy = col.method ? 'inferred' : null;
          if (!col.method) out.issues.push({ dim, kind: 'unknown-method', severity: 'blocking', text: `The chart doesn’t say whether its ${DIMENSIONS[dim].label} is measured flat or all the way around, and the values could be either.` });
        }
      }
    });

    rows.forEach((r, n) => {
      if (out.sizes.some((s) => s.size.trim().toUpperCase() === r.size.trim().toUpperCase())) return;
      const entry = { size: r.size.trim(), rank: sizeRank(r.size), order: n, dims: {} };
      Object.keys(out.columns).forEach((dim) => {
        const col = out.columns[dim];
        const p = parseCell(r.values[col.index]);
        if (!p || !col.unit || (DIMENSIONS[dim].kind === 'width' && !col.method)) return;
        const isWidth = DIMENSIONS[dim].kind === 'width';
        let v = (p.unit || col.unit) === 'cm' ? p.value / CM_PER_IN : p.value;
        if (DIMENSIONS[dim].kind === 'width' && col.method === 'around') v /= 2;
        entry.dims[dim] = { value: round(v, 3), raw: String(r.values[col.index]), unit: p.unit || col.unit, unitBy: p.unit ? 'stated' : col.unitBy, method: isWidth ? 'flat' : col.method, methodBy: isWidth ? (col.methodBy || 'stated') : (col.method ? 'stated' : null), range: Boolean(p.range) };
        if (p.range) out.issues.push({ dim, kind: 'range', severity: 'minor', text: `Size ${entry.size}’s ${DIMENSIONS[dim].label} is a range (${String(r.values[col.index]).trim()}); its middle is used.` });
      });
      out.sizes.push(entry);
    });
    checkChart(out);
    return out;
  }

  /* inches or cm, from what the values could be for this dimension (an
     adult garment's plausible range, DIMENSIONS[*].plausible / flatMax /
     aroundMin): only when exactly one reading fits */
  function inferUnit(dim, values, method) {
    const d = DIMENSIONS[dim];
    const fits = (vs) => {
      if (d.kind === 'width') {
        const flat = vs.every((v) => v >= d.flatMax * 0.45 && v <= d.flatMax);
        const around = vs.every((v) => v >= d.aroundMin && v <= d.aroundMin * 2.4);
        return method === 'flat' ? flat : method === 'around' ? around : flat || around;
      }
      const [lo, hi] = d.plausible || [3, 48];
      return vs.every((v) => v >= lo && v <= hi);
    };
    const asIn = fits(values);
    const asCm = fits(values.map((v) => v / CM_PER_IN));
    if (asIn && !asCm) return 'in';
    if (asCm && !asIn) return 'cm';
    return null;
  }
  function inferMethod(dim, inches) {
    const d = DIMENSIONS[dim];
    if (!inches.length) return null;
    if (inches.every((v) => v <= d.flatMax)) return 'flat';
    if (inches.every((v) => v >= d.aroundMin)) return 'around';
    return null;
  }

  /* widths and lengths grow with the size; a step far out of line is suspect */
  function checkChart(out) {
    const ordered = out.sizes.filter((s) => s.rank !== null).sort((a, b) => a.rank - b.rank);
    if (ordered.length < out.sizes.length) out.issues.push({ dim: null, kind: 'unknown-size-order', severity: 'minor', text: 'Some size labels aren’t ones Fynd can put in order, so the chart’s own order is assumed for them.' });
    Object.keys(out.columns).forEach((dim) => {
      const vals = ordered.filter((s) => s.dims[dim]).map((s) => ({ size: s.size, v: s.dims[dim].value }));
      if (vals.length < 2) return;
      const steps = vals.slice(1).map((x, i) => x.v - vals[i].v);
      const drops = steps.map((st, i) => ({ st, from: vals[i].size, to: vals[i + 1].size })).filter((x) => x.st < -0.05);
      if (drops.length) {
        out.issues.push({ dim, kind: 'not-increasing', severity: drops.length > 1 || dim === 'chestWidth' || dim === 'waist' ? 'blocking' : 'major', text: `The chart’s ${DIMENSIONS[dim].label} gets smaller from ${drops[0].from} to ${drops[0].to}, which a size chart shouldn’t do — it may be misread or wrong.` });
        out.columns[dim].suspect = true;
      }
      const positive = steps.filter((st) => st > 0).sort((a, b) => a - b);
      if (positive.length >= 2) {
        const median = positive[Math.floor(positive.length / 2)];
        const big = steps.findIndex((st) => st > median * HEURISTICS.stepOutlier && st > 1);
        if (big >= 0) {
          out.issues.push({ dim, kind: 'step-outlier', severity: 'major', text: `The chart’s ${DIMENSIONS[dim].label} jumps unusually between ${vals[big].size} and ${vals[big + 1].size}; check it against the retailer’s page.` });
          out.columns[dim].suspect = true;
        }
      }
    });
  }

  /* ---------- the anchor ---------- */

  const FEEL_FIT = ['tight', 'right', 'loose'];
  const FEEL_LENGTH = ['short', 'right', 'long'];
  const SOURCES = ['fynd-record', 'retailer-page', 'shopper', 'similar-product'];

  /* A plain object → a checked anchor, or { error }. Only known fields
     survive; every measurement keeps its source. */
  function makeAnchor(input) {
    const o = input && typeof input === 'object' ? input : {};
    const text = (v, max) => (typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : null);
    const category = Object.prototype.hasOwnProperty.call(CATEGORIES, o.category) ? o.category : null;
    if (!category) return { error: 'Choose what kind of garment it is.' };
    const size = text(o.size, 16);
    if (!size) return { error: 'Choose the size on its label.' };
    const brand = text(o.brand, 60);
    if (!brand) return { error: 'Choose or type the brand.' };
    const feel = {
      fit: FEEL_FIT.includes(o.feel && o.feel.fit) ? o.feel.fit : 'right',
      length: FEEL_LENGTH.includes(o.feel && o.feel.length) ? o.feel.length : 'right'
    };
    const dims = {};
    const allowed = CATEGORIES[category].dims;
    Object.entries(o.dims && typeof o.dims === 'object' ? o.dims : {}).forEach(([id, m]) => {
      if (!allowed.includes(id) || !m || !isNum(m.value) || m.value <= 0 || m.value > 80 || !SOURCES.includes(m.source)) return;
      dims[id] = {
        value: round(m.value, 3),
        unit: 'in',
        method: DIMENSIONS[id].kind === 'width' ? 'flat' : (Object.prototype.hasOwnProperty.call(METHOD_LABELS, m.method) ? m.method : null),
        source: m.source,
        verified: m.source === 'fynd-record' && m.verified === true,
        note: text(m.note, 200)
      };
    });
    const product = o.product && typeof o.product === 'object'
      ? { name: text(o.product.name, 160), url: /^https:\/\//.test(o.product.url || '') && o.product.url.length < 600 ? o.product.url : null, code: text(o.product.code, 40) }
      : null;
    const feedback = Array.isArray(o.feedback) ? o.feedback.filter(validOutcome).slice(-50) : [];
    const priority = o.priority && typeof o.priority === 'object' ? { fit: clampPriority(o.priority.fit), length: clampPriority(o.priority.length) } : { fit: 1, length: 1 };
    return {
      anchor: {
        id: text(o.id, 40) || `a${Date.now().toString(36)}`,
        brand, category, size, feel, priority,
        product: product && (product.name || product.url || product.code) ? product : null,
        dims,
        feedback,
        createdAt: text(o.createdAt, 40) || new Date().toISOString()
      }
    };
  }
  function clampPriority(v) { return isNum(v) ? Math.min(2, Math.max(0.25, v)) : 1; }

  /* how sure a measurement is, by where it came from (a Fynd record
     nobody has checked against its source is only as good as a typed one) */
  const SOURCE_TRUST = { 'fynd-record': 'high', 'fynd-record-unverified': 'medium', 'retailer-page': 'high', shopper: 'medium', 'similar-product': 'low' };
  const trustKey = (m) => (m.source === 'fynd-record' && !m.verified ? 'fynd-record-unverified' : m.source);
  const SOURCE_WORDS = {
    'fynd-record': 'verified by Fynd',
    'fynd-record-unverified': 'from Fynd’s record, not yet checked',
    'retailer-page': 'from the retailer’s published chart',
    shopper: 'as you entered or corrected it',
    'similar-product': 'estimated from a similar product'
  };

  /* ---------- outcomes ---------- */

  const OUTCOMES = { 'too-tight': 'fit', 'about-right': null, 'too-loose': 'fit', 'too-short': 'length', 'too-long': 'length' };
  function validOutcome(f) {
    return f && typeof f === 'object' && Object.prototype.hasOwnProperty.call(OUTCOMES, f.outcome) && f.dims && typeof f.dims === 'object'
      && Object.values(f.dims).every(isNum);
  }
  /* An outcome for a size the shopper bought: its own dimensions travel
     with it, so it can narrow the preferred ranges later. */
  function outcome(anchor, outcomeKind, targetSize, extra) {
    if (!Object.prototype.hasOwnProperty.call(OUTCOMES, outcomeKind)) return null;
    const dims = {};
    Object.entries(targetSize && targetSize.dims || {}).forEach(([id, m]) => { if (m && isNum(m.value)) dims[id] = round(m.value, 3); });
    if (!Object.keys(dims).length) return null;
    const e = extra || {};
    return { outcome: outcomeKind, size: String(targetSize.size || ''), dims, product: typeof e.product === 'string' ? e.product.slice(0, 160) : null, at: e.at || new Date().toISOString() };
  }

  /* ---------- inferred preference ---------- */

  /* For each dimension the anchor knows: the range the shopper probably
     prefers, and what it rests on. */
  function preferred(anchor, opts) {
    const H = Object.assign({}, HEURISTICS, opts && opts.heuristics);
    const cat = CATEGORIES[anchor.category];
    const params = H.params[cat.family];
    const out = {};
    Object.entries(anchor.dims || {}).forEach(([id, m]) => {
      const p = params[id];
      if (!p) return;
      const axis = DIMENSIONS[id].axis;
      const said = axis === 'fit' ? anchor.feel.fit : anchor.feel.length;
      const shift = said === 'right' ? null : p.feel[said];
      let low;
      let high;
      const basis = [];
      if (shift) {
        low = m.value + shift[0];
        high = m.value + shift[1];
        basis.push(`your ${noun(anchor.category)} feels ${said}, so somewhere ${shift[0] > 0 ? 'above' : 'below'} its ${DIMENSIONS[id].label}`);
      } else {
        low = m.value - p.about;
        high = m.value + p.about;
        basis.push(said === 'right' ? 'about the same as the garment that fits' : 'about the same (no adjustment known for this dimension)');
      }
      /* outcomes are measured evidence: where they speak, they replace
         the one-answer guess. Only outcomes that disagree with each
         other are a conflict. */
      const step = Math.max(H.outcomeStep, p.about);
      let oLow = -Infinity;
      let oHigh = Infinity;
      let conflict = false;
      let latest = null;
      (anchor.feedback || []).forEach((f) => {
        const v = f.dims[id];
        if (!isNum(v)) return;
        const fAxis = OUTCOMES[f.outcome];
        if (f.outcome !== 'about-right' && fAxis !== axis) return;
        if (f.outcome === 'about-right') { oLow = Math.max(oLow, v - p.about); oHigh = Math.min(oHigh, v + p.about); }
        else if (f.outcome === 'too-tight' || f.outcome === 'too-short') oLow = Math.max(oLow, v + step);
        else oHigh = Math.min(oHigh, v - step);
        latest = { f, v };
        basis.push(`size ${f.size} was ${f.outcome.replace('-', ' ')}`);
      });
      if (oLow > oHigh && latest) {
        /* the outcomes disagree: the newest one stands, and it is said */
        conflict = true;
        const { f, v } = latest;
        if (f.outcome === 'about-right') { oLow = v - p.about; oHigh = v + p.about; }
        else if (f.outcome === 'too-tight' || f.outcome === 'too-short') { oLow = v + step; oHigh = Infinity; }
        else { oHigh = v - step; oLow = -Infinity; }
      }
      /* a measured outcome replaces the one-answer guess on the side it
         speaks to, keeping the guess's width beyond it */
      const width = high - low;
      if (Number.isFinite(oLow) && Number.isFinite(oHigh)) { low = oLow; high = oHigh; }
      else if (Number.isFinite(oLow)) { low = oLow; high = Math.max(high, oLow + width); }
      else if (Number.isFinite(oHigh)) { high = oHigh; low = Math.min(low, oHigh - width); }
      out[id] = { low: round(low, 3), high: round(high, 3), center: round((low + high) / 2, 3), reference: m.value, method: m.method, source: trustKey(m), adjusted: Boolean(shift), toward: shift ? Math.sign(shift[0]) : 0, outcomes: (anchor.feedback || []).filter((f) => isNum(f.dims[id])).length, conflict, basis };
    });
    return out;
  }

  /* ---------- the recommendation ---------- */

  /* recommend(anchor, chart, opts) →
       { status: 'ok', size, confidence, ranked, explanation, uncertain, chart }
     | { status: 'insufficient' | 'body-chart' | 'labels-only', reason, missing, explanation, labelMatch? }
     opts.unit: 'in' | 'cm' for the words; opts.category: the target's
     category, when known; opts.targetSource: where the target chart came
     from (it caps confidence); opts.brand / opts.sizes: for a same-brand
     label match; opts.heuristics: overrides for testing */
  function recommend(anchor, chart, opts) {
    const o = opts || {};
    const unit = o.unit === 'cm' ? 'cm' : 'in';
    const targetCategory = o.category && CATEGORIES[o.category] ? o.category : anchor.category;
    const cat = CATEGORIES[anchor.category];
    const tcat = CATEGORIES[targetCategory];
    const crossCategory = targetCategory !== anchor.category;
    const labelMatch = labelFallback(anchor, chart, o);

    if (tcat.family !== cat.family) {
      return { status: 'insufficient', reason: 'different-kind', missing: [], labelMatch: null, explanation: [`Your reference is ${aNoun(anchor.category)}; this is ${aNoun(targetCategory)}. Add ${aNoun(targetCategory)} that fit${PAIRS[targetCategory] ? '' : 's'} you well as another reference to compare them.`] };
    }
    if (!chart || !Array.isArray(chart.rows) || !chart.rows.length) {
      return { status: 'labels-only', reason: 'no-chart', missing: ['measurements'], labelMatch, explanation: ['This page shows no size chart with measurements, so Fynd can’t compare it with your reference.'].concat(labelMatch ? [labelMatch.text] : []) };
    }
    if (chart.measures === 'body') {
      return { status: 'body-chart', reason: 'body-chart', missing: ['garment measurements'], labelMatch, explanation: ['This chart gives body measurements (the body each size is meant for), not the garment’s own. Your reference is a garment, so they can’t be compared directly.'].concat(labelMatch ? [labelMatch.text] : []) };
    }
    if (chart.measures === 'not-stated' && !o.allowNotStated) {
      return { status: 'insufficient', reason: 'not-stated', missing: ['whether the chart measures the garment or the body'], labelMatch, explanation: ['The chart doesn’t say whether it measures the garment or the body. If it measures the garment, confirm that and Fynd will compare it.'].concat(labelMatch ? [labelMatch.text] : []) };
    }

    const read = readChart(chart, targetCategory);
    const pref = preferred(anchor, o);
    const blocking = new Set(read.issues.filter((i) => i.severity === 'blocking' && i.dim).map((i) => i.dim));
    /* lengths measured from different points are different quantities */
    const methodClash = {};
    tcat.dims.forEach((id) => {
      if (DIMENSIONS[id].kind === 'width' || !pref[id] || !read.columns[id]) return;
      const a = pref[id].method;
      const t = read.columns[id].method;
      if (a && t && a !== t) methodClash[id] = `your reference’s ${DIMENSIONS[id].label} is measured ${METHOD_LABELS[a]}, this chart’s ${METHOD_LABELS[t]}`;
      else if (METHOD_REQUIRED[id] && !(a && t)) methodClash[id] = `the ${DIMENSIONS[id].label} can’t be compared unless both charts say where it’s measured from`;
    });
    const usable = tcat.dims.filter((id) => pref[id] && read.columns[id] && !blocking.has(id) && !methodClash[id] && read.sizes.some((s) => s.dims[id]));
    const missing = [];
    if (!Object.keys(anchor.dims || {}).length) missing.push('your reference garment’s measurements');
    if (!Object.keys(read.columns).length) missing.push(`the ${noun(targetCategory)}’s garment measurements in this chart`);
    if (!usable.length) {
      const why = [];
      if (!Object.keys(anchor.dims || {}).length) why.push('Fynd has no measurements for your reference garment yet — open its product page and use its chart, or enter them.');
      else if (!Object.keys(read.columns).length) why.push('This chart has no columns Fynd can match to your reference’s measurements.');
      else why.push(`Your reference and this chart share no measurement Fynd can compare${blocking.size ? ` (${[...blocking].map((d) => DIMENSIONS[d].label).join(', ')} couldn’t be read reliably)` : ''}.`);
      read.issues.filter((i) => i.severity === 'blocking').forEach((i) => why.push(i.text));
      return { status: 'insufficient', reason: 'no-shared-measurement', missing: missing.length ? missing : ['a measurement both garments publish'], labelMatch, explanation: why.concat(labelMatch ? [labelMatch.text] : []), chart: read };
    }

    const params = HEURISTICS.params[cat.family];
    const H = Object.assign({}, HEURISTICS, o.heuristics);
    const reported = (id) => (DIMENSIONS[id].axis === 'fit' ? anchor.feel.fit : anchor.feel.length) !== 'right';
    const weightOf = (id) => params[id].weight * (DIMENSIONS[id].axis === 'fit' ? anchor.priority.fit : anchor.priority.length) * (reported(id) ? H.reportedBoost : 1);
    const scored = read.sizes.map((s) => {
      let sum = 0;
      let wsum = 0;
      const diffs = [];
      usable.forEach((id) => {
        const t = s.dims[id];
        if (!t) return;
        const p = pref[id];
        const tol = params[id].tol;
        const outside = t.value < p.low ? p.low - t.value : t.value > p.high ? t.value - p.high : 0;
        const repeats = p.toward && !p.outcomes && (t.value - p.reference) * p.toward <= 0;
        const miss = outside / tol + H.centring * Math.abs(t.value - p.center) / tol + (repeats ? H.repeatPenalty : 0);
        const w = weightOf(id) * (read.columns[id].suspect ? 0.5 : 1);
        sum += w * miss * miss;
        wsum += w;
        diffs.push({ dim: id, label: DIMENSIONS[id].label, target: t.value, reference: p.reference, preferredLow: p.low, preferredHigh: p.high, diff: round(t.value - p.reference, 3), verdict: verdictOf(id, t.value, p), source: p.source, targetUnitBy: t.unitBy, targetMethodBy: t.methodBy, referenceMethod: p.method, targetMethod: t.method });
      });
      const covered = diffs.length;
      return { size: s.size, rank: s.rank, score: covered ? round(Math.sqrt(sum / wsum), 3) : null, covered, diffs, dims: s.dims };
    }).filter((s) => s.score !== null);

    if (!scored.length) return { status: 'insufficient', reason: 'no-scored-size', missing: ['a size with the measurements your reference has'], labelMatch, explanation: ['No size in this chart has the measurements your reference has.'], chart: read };
    /* a size missing the main dimension can't win over one that has it */
    const main = tcat.main;
    const ranked = scored.slice().sort((a, b) => {
      const am = a.diffs.some((d) => d.dim === main) ? 0 : 1;
      const bm = b.diffs.some((d) => d.dim === main) ? 0 : 1;
      return am - bm || a.score - b.score || (a.rank !== null && b.rank !== null ? a.rank - b.rank : 0);
    });
    const best = ranked[0];
    const second = ranked[1] || null;

    /* ---- confidence: from the data, never from the score ---- */
    let confidence = 'high';
    const why = [];
    const usedSources = new Set(best.diffs.map((d) => d.source));
    usedSources.forEach((src) => { const c = SOURCE_TRUST[src]; if (LEVELS.indexOf(c) < LEVELS.indexOf(confidence)) { confidence = c; why.push(`your reference’s measurements are ${SOURCE_WORDS[src]}`); } });
    if (!best.diffs.some((d) => d.dim === main)) { confidence = cap(confidence, 'low'); why.push(`the ${DIMENSIONS[main].label} couldn’t be compared`); }
    if (best.covered < 2) { confidence = cap(confidence, 'medium'); why.push('only one measurement could be compared'); }
    if (chart.measures === 'not-stated') { confidence = cap(confidence, 'low'); why.push('the chart doesn’t say it measures the garment (you confirmed it)'); }
    /* where the target chart came from caps it too (opts.targetSource:
       'fynd-record' | 'fynd-record-unverified' | 'retailer-page' | 'shopper') */
    if (o.targetSource && SOURCE_TRUST[o.targetSource] && LEVELS.indexOf(SOURCE_TRUST[o.targetSource]) < LEVELS.indexOf(confidence)) {
      confidence = SOURCE_TRUST[o.targetSource];
      why.push(`this product’s chart is ${SOURCE_WORDS[o.targetSource]}`);
    }
    if (best.diffs.some((d) => d.targetUnitBy === 'inferred' || d.targetMethodBy === 'inferred')) { confidence = lower(confidence); why.push('the chart’s units or how it measures widths had to be inferred from the numbers'); }
    if (read.issues.some((i) => i.severity === 'major' || (i.severity === 'blocking' && i.dim))) { confidence = lower(confidence); why.push('part of the chart looks inconsistent'); }
    if (best.diffs.some((d) => DIMENSIONS[d.dim].kind === 'length' && !(d.referenceMethod && d.targetMethod))) { confidence = lower(confidence); why.push('a length is compared without both charts saying where it’s measured from'); }
    if (crossCategory) { confidence = cap(confidence, 'low'); why.push(`your reference is ${aNoun(anchor.category)}, and ${aNoun(targetCategory)} is cut differently`); }
    const adjusted = usable.some((id) => pref[id].adjusted && !pref[id].outcomes);
    if (adjusted) { confidence = cap(confidence, 'medium'); why.push('how much tighter or looser you like it is estimated from one answer'); }
    if (usable.some((id) => pref[id].conflict)) { confidence = lower(confidence); why.push('your past outcomes disagree with each other'); }
    if (second && second.score - best.score < H.tieMargin) { confidence = lower(confidence); why.push(`${second.size} is nearly as close`); }
    else if (second && second.score - best.score < H.clearMargin && LEVELS.indexOf(confidence) > 1) { confidence = 'medium'; why.push(`${second.size} isn’t far behind`); }
    if (best.score > 3) { confidence = cap(confidence, 'low'); why.push('even the closest size is well outside what you prefer'); }

    return {
      status: 'ok',
      size: best.size,
      confidence,
      confidenceWhy: why,
      ranked: ranked.map((r) => ({ size: r.size, score: r.score, covered: r.covered, diffs: r.diffs })),
      alternative: second && second.score - best.score < H.clearMargin ? second.size : null,
      explanation: explain(anchor, best, second, pref, unit, crossCategory, targetCategory),
      uncertain: read.issues.map((i) => i.text),
      compared: usable,
      notCompared: tcat.dims.filter((id) => read.columns[id] && !usable.includes(id)).map((id) => ({ dim: id, label: DIMENSIONS[id].label, why: methodClash[id] || (blocking.has(id) ? 'couldn’t be read reliably' : !pref[id] ? 'your reference has no measurement for it' : 'not in this chart') })),
      labelMatch,
      chart: read
    };
  }

  function verdictOf(id, v, p) {
    const fit = DIMENSIONS[id].axis === 'fit';
    if (v < p.low) return fit ? 'tighter than you like' : 'shorter than you like';
    if (v > p.high) return fit ? 'looser than you like' : 'longer than you like';
    return 'about what you like';
  }

  /* The words: exact numbers only for measurements that are verified or
     the retailer's own published ones; "about" for anything estimated. */
  function explain(anchor, best, second, pref, unit, crossCategory, targetCategory) {
    const lines = [];
    const kind = noun(anchor.category);
    const sorted = best.diffs.slice().sort((a, b) => (DIMENSIONS[a.dim].axis === 'fit' ? 0 : 1) - (DIMENSIONS[b.dim].axis === 'fit' ? 0 : 1));
    const exact = (d) => d.source !== 'similar-product';
    const lead = sorted[0];
    const ref = (d) => `${exact(d) ? '' : 'about '}${format(d.reference, unit)}`;
    const targetWords = (d) => `${d.targetUnitBy === 'inferred' || d.targetMethodBy === 'inferred' ? 'about ' : ''}${format(d.target, unit)}`;
    const flat = (d) => (DIMENSIONS[d.dim].kind === 'width' ? 'flat ' : '');
    lines.push(`Your reference ${kind} (${anchor.brand} ${anchor.size}) has a ${flat(lead)}${DIMENSIONS[lead.dim].phrase} of ${ref(lead)} (${SOURCE_WORDS[lead.source]}). This ${best.size} measures ${targetWords(lead)} — ${lead.verdict}.`);
    sorted.slice(1).forEach((d) => {
      const amount = Math.abs(d.target - d.reference);
      const more = d.target > d.reference;
      const word = DIMENSIONS[d.dim].axis === 'length' ? (more ? 'longer' : 'shorter') : (more ? 'wider' : 'narrower');
      lines.push(amount < 0.125
        ? `Its ${DIMENSIONS[d.dim].phrase} matches your reference${exact(d) ? '' : ' (approximately)'} — ${d.verdict}.`
        : `Its ${DIMENSIONS[d.dim].phrase} is ${exact(d) && d.targetUnitBy !== 'inferred' ? '' : 'about '}${format(amount, unit)} ${word} than your reference — ${d.verdict}.`);
    });
    if (second) lines.push(`Next closest: ${second.size}.`);
    if (crossCategory) lines.push(`Your reference is ${aNoun(anchor.category)}; this is ${aNoun(targetCategory)}, which is usually cut differently — treat this as a rough guide.`);
    return lines;
  }

  /* Without comparable measurements: the same label in the same brand,
     at low confidence, said as exactly that */
  function labelFallback(anchor, chart, opts) {
    const brand = (opts && opts.brand) || '';
    const sizes = (opts && Array.isArray(opts.sizes) ? opts.sizes : []).concat(chart && Array.isArray(chart.rows) ? chart.rows.map((r) => r.size) : []);
    if (!brand || brand.trim().toLowerCase() !== anchor.brand.trim().toLowerCase()) return null;
    const hit = sizes.find((s) => sameSize(s, anchor.size));
    return hit ? { size: hit, confidence: 'low', text: `Same brand: your ${anchor.brand} ${noun(anchor.category)} is a ${anchor.size}, and this product comes in ${hit}. That is a label match, not a measurement match — sizing can differ between products.` } : null;
  }

  /* The anchor's dimensions from one chart row (its own product's chart,
     in the size on its label): what "use this product as my reference"
     stores. Only a garment chart counts. */
  function dimsFromChart(chart, category, size, source) {
    if (!chart || chart.measures !== 'finished-garment') return { error: 'Only a chart of the garment’s own measurements can describe your reference garment.' };
    const read = readChart(chart, category);
    const row = read.sizes.find((s) => sameSize(s.size, size));
    if (!row) return { error: `This chart has no size ${size}.`, sizes: read.sizes.map((s) => s.size) };
    const dims = {};
    const blocked = new Set(read.issues.filter((i) => i.severity === 'blocking').map((i) => i.dim));
    Object.entries(row.dims).forEach(([id, m]) => {
      if (blocked.has(id)) return;
      dims[id] = { value: m.value, method: m.method, source: source || 'retailer-page', note: m.unitBy === 'inferred' || (m.methodBy === 'inferred' && DIMENSIONS[id].kind === 'width') ? 'unit or method inferred from the values' : null };
    });
    if (!Object.keys(dims).length) return { error: 'No measurement in this chart could be read reliably.', issues: read.issues };
    return { dims, issues: read.issues };
  }

  /* Which saved anchor speaks to a target category: the same category
     first, then the same family; none across families. */
  function anchorFor(anchors, category) {
    const list = Array.isArray(anchors) ? anchors : [];
    const c = CATEGORIES[category];
    if (!c) return null;
    const withDims = (a) => Object.keys(a.dims || {}).length;
    const same = list.filter((a) => a.category === category).sort((a, b) => withDims(b) - withDims(a));
    if (same.length) return same[0];
    const family = list.filter((a) => CATEGORIES[a.category] && CATEGORIES[a.category].family === c.family).sort((a, b) => withDims(b) - withDims(a));
    return family[0] || null;
  }

  /* A product's kind, from its own words (name, breadcrumb): or null */
  const KIND_WORDS = [
    [/\b(jeans|denim pants?)\b/i, 'jeans'],
    [/\bshorts\b/i, 'shorts'],
    [/\b(pants|trousers|chinos|joggers|sweatpants)\b/i, 'pants'],
    [/\b(jacket|coat|parka|blazer|blouson|anorak)\b/i, 'jacket'],
    [/\b(hoodie|sweatshirt|pullover hoodie|sweat pullover)\b/i, 'sweatshirt'],
    [/\b(sweater|cardigan|knit)\b/i, 'sweater'],
    [/\b(t-?shirt|tee)\b/i, 'tshirt'],
    [/\b(shirt|oxford|button[- ]down|polo)\b/i, 'shirt']
  ];
  function categoryOf(words) {
    const s = String(words || '');
    const hit = KIND_WORDS.find(([re]) => re.test(s));
    return hit ? hit[1] : null;
  }

  return { SOURCE_TRUST, METHOD_LABELS, CATEGORIES, DIMENSIONS, HEURISTICS, FEEL_FIT, FEEL_LENGTH, SOURCES, SOURCE_WORDS, OUTCOMES, format, parseCell, sizeRank, readChart, makeAnchor, preferred, recommend, outcome, dimsFromChart, anchorFor, categoryOf };
});
