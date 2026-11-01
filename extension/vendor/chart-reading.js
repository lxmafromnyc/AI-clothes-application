/* =========================================================
   Fynd — reading a size chart's headings and cells, the same way
   everywhere

   Deterministic, and shared:
     - the extension (extension/extract.js, through its copy in
       extension/vendor/ — scripts/sync-extension.js keeps it identical)
       reads a chart with these on the shopper's page;
     - the server (api/_sizing/chart-ai.js) checks every interpretation
       a model proposes against the same rules, so a model can point at
       words on the page but never decide what they mean.

     parseCell(text)      one cell: a number (21, 21.5, 21,5, 21 1/2,
                          21½), and the unit written in the cell itself
                          if any — or why not: a range (ambiguous), not
                          a number, or empty. Never converted, never
                          rounded, never filled in.
     dimOf(header)        the measurement a heading plainly names, or
                          null. Body-only words (waist, hips, height…)
                          are never a garment measurement.
     methodSaid(dim, w)   the canonical method (api/_sizing/methods.js
                          ids) the words state for that measurement, or
                          null: never a guess.
     sizeLike(text)       a size label (S, XL, 2XL, 32, 32x30…)
     gridShape(grid)      for a raw grid of cells: which leading rows are
                          headings, which column holds the sizes, and
                          whether it is a size chart at all — or null
     normalise(text)      text as compared for evidence: case, spacing
                          and punctuation variants folded
     aimedAtSoftware(t)   text addressed to software rather than a shopper
                          (one narrow layer of several, see below)
   ========================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sizing-tables.js'));
  else root.FyndChartReading = factory(root.FyndSizingTables);
})(typeof self !== 'undefined' ? self : this, function (Tables) {
  'use strict';

  const DIMS = ['chestWidth', 'shoulderWidth', 'bodyLength', 'sleeveLength'];
  const clean = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 160) : '');

  /* one cell: a number — or not: a range is ambiguous, said so */
  const FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
  function parseCell(text) {
    const whole = clean(text, 40);
    const suffix = whole.match(/\s*(cm|centimet(?:er|re)s?|in|inch(?:es)?|")\.?$/i);
    const unit = suffix ? (/^c/i.test(suffix[1]) ? 'cm' : 'in') : null;
    const t = suffix ? whole.slice(0, suffix.index).trim() : whole;
    if (!t) return { value: null, problem: 'empty', unit };
    if (/\d\s*[-–—~]\s*\d|\bto\b/.test(t)) return { value: null, problem: 'range', unit };
    let m = t.match(/^(\d{1,3})(?:[.,](\d{1,2}))?\s*([¼½¾⅛⅜⅝⅞])?$/);
    if (m) return { value: Number(`${m[1]}.${m[2] || 0}`) + (m[3] ? FRACTIONS[m[3]] : 0), problem: null, unit };
    m = t.match(/^(\d{1,3})\s+(\d)\/(\d{1,2})$/);
    if (m && Number(m[3]) > 0 && Number(m[2]) < Number(m[3])) return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), problem: null, unit };
    return { value: null, problem: 'not-a-number', unit };
  }

  /* which measurement a heading is, only when it plainly says so */
  const BODY_ONLY = /\b(height|weight|waist|hips?|seat|inseam|outseam|rise|thigh|knee|neck|hem|armhole|opening)\b/;
  function dimOf(header) {
    /* the heading's own measurement, not where it's measured from: "Front length (from high point of
       shoulder)" is a length, "Length (shoulder to hem)" too — brackets and "from …" are the method */
    const full = String(header || '').toLowerCase();
    const core = full.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b(from|measured)\b.*$/, ' ').trim();
    const h = core || full;
    if (BODY_ONLY.test(h)) return null;
    if (/\bsleeves?\b/.test(h)) return 'sleeveLength';
    if (/\bshoulders?\b/.test(h)) return 'shoulderWidth';
    if (/\b(chest|bust|pit[\s-]*to[\s-]*pit|armpit|body width)\b/.test(h)) return 'chestWidth';
    if (/\blength\b/.test(h)) return 'bodyLength';
    return null;
  }
  /* a heading that names a body-only measurement: never mapped to a garment's */
  const bodyOnly = (header) => BODY_ONLY.test(String(header || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' '));

  /* the canonical method the words state — or null: never a guess */
  function methodSaid(dim, words) {
    const w = String(words || '').toLowerCase();
    if (!w) return null;
    if (dim === 'chestWidth') {
      if (/circumference|all (the way )?around/.test(w)) return 'garment-circumference';
      if (/\bhalf\b|½|1\/2|laid flat|measured flat|\bflat\b|pit[\s-]*to[\s-]*pit|armpit[\s-]*to[\s-]*armpit|body width/.test(w)) return 'flat-width-armpit-to-armpit';
      return null;
    }
    if (dim === 'bodyLength') {
      if (/cent(er|re)[\s-]*back|back length|length \(back\)/.test(w)) return 'center-back-to-hem';
      if (/\bhps\b|high(est)?[\s-]*point|from (the )?shoulder/.test(w)) return 'high-point-shoulder-to-hem';
      return null;
    }
    if (dim === 'sleeveLength') {
      if (/cent(er|re)[\s-]*back/.test(w)) return 'center-back-to-cuff';
      if (/shoulder seam|from (the )?shoulder/.test(w)) return 'shoulder-seam-to-cuff';
      return null;
    }
    if (dim === 'shoulderWidth') {
      if (/seam[\s-]*to[\s-]*seam/.test(w)) return 'seam-to-seam';
      return null;
    }
    return null;
  }

  const sizeLike = (text) => Tables.SIZE_VALUE.test(clean(text, 20));

  /* A raw grid (rows of cell text, merged cells already repeated): the
     leading heading rows (up to 3), the column of size labels (the first
     column whose cells below the headings are mostly sizes), and the body
     rows — or null when no column holds sizes, which is not a size chart. */
  function gridShape(grid) {
    const rows = (Array.isArray(grid) ? grid : []).filter((r) => Array.isArray(r) && r.some((c) => clean(c)));
    if (rows.length < 3) return null;
    const width = Math.max(...rows.map((r) => r.length));
    for (let headerRows = 1; headerRows <= 3 && headerRows < rows.length - 1; headerRows++) {
      const body = rows.slice(headerRows);
      for (let col = 0; col < Math.min(width, 2); col++) {
        const sized = body.filter((r) => sizeLike(r[col] || '')).length;
        const numeric = body.filter((r) => r.some((c, i) => i !== col && /\d/.test(c || ''))).length;
        /* the first row after the headings holds a size: a second heading row (its size cell empty) is a heading */
        if (body.length >= 2 && sized >= Math.ceil(body.length * 0.6) && numeric >= 2 && sizeLike(body[0][col] || '') && !sizeLike(rows[headerRows - 1][col] || '')) {
          return { headerRows, sizeColumn: col, width, bodyRows: body.map((r, i) => headerRows + i).filter((ri) => sizeLike(rows[ri][col] || '')) };
        }
      }
    }
    return null;
  }

  /* Text written at software ("ignore previous instructions", "note to the
     AI", "mark it verified"). One layer only, and a narrow one: a keyword
     list can't catch every injection. The other layers don't depend on it —
     words near the table never fill anything in on their own (they need the
     shopper's confirmation), a model's answer is held to a strict schema, and
     every value comes from a cell. */
  const AIMED_AT_SOFTWARE = /\b(ignore|disregard|override)\b.{0,40}\b(instructions?|previous|above|prompts?|rules)\b|\b(system|developer)\s+(note|prompt|message|instructions?)\b|\byou are (an?|the) (ai|assistant|model|bot)\b|\b(to|for) (the )?(ai|assistant|model|llm|bot)\b|\bmark\b.{0,40}\bverified\b/i;
  const aimedAtSoftware = (text) => AIMED_AT_SOFTWARE.test(String(text || ''));

  const normalise = (text) => clean(text, 2000).toLowerCase()
    .replace(/[‘’`´]/g, '\'').replace(/[“”″]/g, '"').replace(/[‐-―−]/g, '-').replace(/\s+/g, ' ').trim();

  return { DIMS, clean, parseCell, dimOf, bodyOnly, methodSaid, sizeLike, gridShape, normalise, AIMED_AT_SOFTWARE, aimedAtSoftware };
});
