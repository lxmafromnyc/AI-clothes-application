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
  const MEASURE = /\b(chest|bust|waist|hips?|seat|length|sleeve|shoulders?|inseam|outseam|neck|height|thigh|rise|leg|width|body)\b/i;


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

  /* What the table measures, only when its words say so. */
  const SAYS_GARMENT = /\b(garment|product|item|clothing)\s+(measurements?|size|dimensions?)\b|\blaid flat\b|\bmeasured flat\b|\bflat measurements?\b|\bfrom (the )?cent(?:er|re) back\b|\bbody width\b/i;
  const SAYS_BODY = /\bbody (measurements?|size)\b|\byour (body|measurements)\b|\bmeasure (yourself|your body)\b|\bto fit\b|\bbody chart\b/i;
  function kindOf(text) {
    const garment = SAYS_GARMENT.test(text);
    const body = SAYS_BODY.test(text);
    if (garment && !body) return 'finished-garment';
    if (body && !garment) return 'body';
    return 'not-stated';
  }

  /* One table, labelled: its chart, or null when it isn't a size table.
     `before` is the text just before it (a heading, a tab's name);
     `caption` its own caption. */
  function labelTable(t) {
    const table = sizeTable(t.rows || []);
    if (!table) return null;
    const caption = t.caption || '';
    const before = t.before || '';
    return {
      measures: kindOf(`${before} ${caption} ${table.columns.join(' ')}`),
      title: caption || null,
      unit: unitOf(`${caption} ${table.columns.join(' ')} ${before.slice(-120)}`),
      columns: table.columns,
      rows: table.rows
    };
  }

  return { MAX_CELL, MAX_ROWS, MAX_COLUMNS, GUIDE_WORDS, SIZE_HEADER, SIZE_VALUE, MEASURE, sizeTable, unitOf, kindOf, labelTable };
});
