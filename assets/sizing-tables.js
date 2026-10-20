/* =========================================================
   Fynd — recognising a size table, the same way everywhere

   One table of plain cells in, and either nothing (it isn't a size
   table) or { columns, rows } with sizes down the left, what it
   measures (the body, the finished garment, or not stated) and its unit
   — each only from the table's own words. Nothing is converted, filled
   in or guessed.

   Used by the server, reading a product page it fetched
   (api/_sizing/chart.js), and by the Fynd browser extension, reading
   the page open in the shopper's own browser (extension/, which carries
   an identical copy in extension/vendor/ — scripts/sync-extension.js
   keeps it, and test-extension fails if the two differ).
   ========================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FyndSizingTables = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* how much of one table is read */
  const MAX_CELL = 60;
  const MAX_ROWS = 40;
  const MAX_COLUMNS = 12;

  /* the words a link to a size guide uses */
  const GUIDE_WORDS = /\bsize[\s_-]*(guide|chart|table|info|information)\b|\bsizing( guide| chart| info)?\b|\bmeasurement guide\b|\bfind your size\b/i;

  const SIZE_HEADER = /\b(size|sizes|us size|uk size|eu size|label)\b/i;
  const SIZE_VALUE = /^(?:[2-6]?x{0,4}[sml]|xx?s|xx?l|[2-6]xl|one size|\d{1,2}(?:\s*[x/×]\s*\d{1,2})?|\d{2,3})$/i;
  const MEASURE = /\b(chest|bust|waist|hips?|seat|length|sleeve|shoulders?|inseam|outseam|neck|height|thigh|rise|leg|width|body|hem|opening|across|armhole|knee)\b/i;


  /* A size table, with sizes down the left: { columns, rows } or null.
     A table with sizes across the top is turned so they read down. */
  function sizeTable(rows) {
    if (rows.length < 2) return null;
    const width = Math.max(...rows.map((r) => r.length));
    const grid = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] || ''));
    const asIs = readOriented(grid);
    if (asIs) return asIs;
    const turned = grid[0].map((_, c) => grid.map((r) => r[c]));
    return readOriented(turned);
  }

  function readOriented(grid) {
    const head = grid[0];
    if (head.length < 2) return null;
    const body = grid.slice(1).filter((r) => r[0]);
    const sizesDown = body.filter((r) => SIZE_VALUE.test(r[0].replace(/\s+/g, ' '))).length;
    const labelled = SIZE_HEADER.test(head[0]) || (!head[0] && sizesDown === body.length);
    if (!labelled || body.length < 2 || sizesDown < Math.ceil(body.length * 0.6)) return null;
    const measured = head.slice(1).map((h, i) => ({ h, i: i + 1 })).filter((c) => MEASURE.test(c.h));
    if (!measured.length) return null;
    const columns = measured.map((c) => c.h);
    const out = body.map((r) => ({ size: r[0], values: measured.map((c) => r[c.i] || '') }))
      .filter((r) => r.values.some((v) => /\d/.test(v)));
    if (out.length < 2) return null;
    return { columns, rows: out.slice(0, MAX_ROWS) };
  }

  /* Inches, centimetres, both, or not stated — from the table's own words. */
  function unitOf(text) {
    const cm = /\b(cm|centimet(?:er|re)s?)\b/i.test(text);
    /* "in" alone is an ordinary word ("measured flat, in cm"): only an
       unmistakable inch counts — inch(es), "(in)", "in." or a ″ mark */
    const inch = /\binch(es)?\b|\(in\)|\bin\.(?!\w)|["″]/i.test(text);
    if (cm && inch) return 'both';
    return cm ? 'cm' : inch ? 'in' : null;
  }

  /* What the table measures, only when its words say so — and, for a
     garment claim, only when its columns agree.

     How the garment was measured ("laid flat", "from the centre back",
     "body width", "garment measurements", UNIQLO's "the actual
     measurements of the product") says it is the garment. A
     bare label — "Product size", "Item measurements" — does not prove it
     alone: such a table counts as the garment only when its columns are
     the garment's own geometry (a length, a width, a sleeve, the
     shoulders, an inseam) and none could be the wearer's (height and
     weight; bust, hips or seat unless the column itself says width or
     flat). A stated garment table may have bust and hip columns —
     a dress's bust or a pair of jeans' hip, laid flat — but never height
     or weight. A garment claim that breaks these is "not stated": a size
     chart that mixes the two can't say which each value is. */
  const SAYS_GARMENT = /\bgarment\s+(measurements?|size|dimensions?)\b|\blaid flat\b|\bmeasured flat\b|\bflat measurements?\b|\bfrom (the )?cent(?:er|re) back\b|\bbody width\b|\bactual measurements of the (product|garment|item)\b/i;
  const LABELS_GARMENT = /\b(product|item|clothing)\s+(measurements?|size|dimensions?)\b/i;
  const SAYS_BODY = /\bbody (measurements?|size)\b|\byour (body|measurements)\b|\bmeasure (yourself|your body)\b|\bto fit\b|\bbody chart\b/i;
  const WEARER_COLUMN = /\b(height|weight)\b/i;
  const EITHER_COLUMN = /\b(bust|hips?|seat)\b/i;
  const FLAT_COLUMN = /\b(width|flat|half|across)\b/i;
  const GARMENT_COLUMN = /\b(length|width|sleeves?|shoulders?|hem|across|opening|rise|inseam|outseam|thigh|knee|armhole)\b/i;
  function kindOf(text, columns) {
    const cols = columns || [];
    const garmentSaid = SAYS_GARMENT.test(text);
    const garmentLabel = !garmentSaid && LABELS_GARMENT.test(text);
    const body = SAYS_BODY.test(text);
    const wearer = cols.some((c) => WEARER_COLUMN.test(c));
    const either = cols.some((c) => EITHER_COLUMN.test(c) && !FLAT_COLUMN.test(c));
    const garmentShaped = cols.some((c) => GARMENT_COLUMN.test(c));
    if ((garmentSaid || garmentLabel) && !body) {
      if (wearer) return 'not-stated';
      if (garmentLabel && (either || !garmentShaped)) return 'not-stated';
      return 'finished-garment';
    }
    if (body && !garmentSaid && !garmentLabel) return 'body';
    return 'not-stated';
  }

  /* How each column was measured, only in the page's own words: the
     words a column's heading carries ("Sleeve Length (center back)" →
     "center back"), or, for a width a table says it measured laid flat,
     "laid flat". Never mapped onto Fynd's own methods or used to
     compare: a page read is not checked. null where nothing is said. */
  const METHOD_WORDS = /\bcent(?:er|re)[\s-]+back\b|\bseam[\s-]+to[\s-]+seam\b|\barmpit[\s-]+to[\s-]+armpit\b|\bpit[\s-]+to[\s-]+pit\b|\bhigh(?:est)?[\s-]+point(?:\s+of)?(?:\s+the)?\s+shoulder\b|\bHPS\b|\bfrom\s+(?:the\s+)?shoulder(?:\s+seam)?\b|\blaid\s+flat\b|\bmeasured\s+flat\b|\bhalf\b|\bcircumference\b|\ball\s+(?:the\s+way\s+)?around\b|\bfrom\s+(?:the\s+)?crotch\b/gi;
  const TABLE_FLAT = /\blaid flat\b|\bmeasured flat\b|\bflat measurements?\b/i;
  const WIDTH_COLUMN = /\b(chest|bust|waist|hips?|seat|thigh|hem|width|across|opening|knee)\b/i;
  function methodsOf(columns, text) {
    const flat = TABLE_FLAT.test(text || '');
    const out = columns.map((c) => {
      const own = (c.match(METHOD_WORDS) || []).map((w) => w.replace(/\s+/g, ' '));
      if (own.length) return own.join(', ');
      return flat && WIDTH_COLUMN.test(c) ? 'laid flat (said of the whole table)' : null;
    });
    return out.some(Boolean) ? out : null;
  }

  /* One table, labelled: its chart, or null when it isn't a size table.
     `before` is the text just before it (a heading, a tab's name);
     `caption` its own caption. */
  function labelTable(t) {
    const table = sizeTable(t.rows || []);
    if (!table) return null;
    const caption = t.caption || '';
    const before = t.before || '';
    const measures = kindOf(`${before} ${caption} ${table.columns.join(' ')}`, table.columns);
    const out = {
      measures,
      title: caption || null,
      unit: unitOf(`${caption} ${table.columns.join(' ')} ${before.slice(-120)}`),
      columns: table.columns,
      rows: table.rows
    };
    /* a method is the garment's: a body chart's columns aren't measured "laid flat" */
    const methods = measures === 'finished-garment' ? methodsOf(table.columns, `${before} ${caption}`) : null;
    if (methods) out.methods = methods;
    return out;
  }

  return { MAX_CELL, MAX_ROWS, MAX_COLUMNS, GUIDE_WORDS, SIZE_HEADER, SIZE_VALUE, MEASURE, sizeTable, unitOf, kindOf, methodsOf, labelTable };
});
