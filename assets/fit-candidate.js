/* =========================================================
   Fynd — the item being considered, entered by hand

   The shopper copies one size's finished-garment measurements from the
   product's own measurement chart: the measurements the garment itself
   has, laid flat — never a body chart, which says who a size is cut for.
   Each value says how the chart measures it, in plain words: one of the
   canonical methods (api/_sizing/methods.js, kept equal to this list by
   scripts/test-find-fit-manual.js), or "the chart doesn't say", which is
   never compared.

   readCandidate(raw) → { candidate, errors } — the one reader, shared by
   the page (assets/find-fit-manual.js) and the server
   (api/size-recommendation.js): a candidate is
     { type, brand, name, size, unit, measurements: { chestWidth, … },
       methods: { registry, chestWidth, … } }
   with only the values given. Nothing is filled in: a value left blank
   stays missing.

   Plausible values: where a value is measured the way the reference form
   measures it, it must fall in that form's own range for the type
   (FitProfileSchema.measureRange); a chest all the way around, in twice
   that range — the registry's stated factor. Any other method is checked
   only as a positive number: Fynd has no range of its own for it.
   ========================================================= */

(function (global) {
  'use strict';

  const Schema = global.FitProfileSchema || (typeof require === 'function' ? require('./fit-profile-schema.js') : null);

  const REGISTRY = 1;
  const NOT_STATED = 'not-stated';
  /* how a chart may measure each one, in plain words; the form's own
     method first */
  const METHODS = {
    chestWidth: [
      { id: 'flat-width-armpit-to-armpit', label: 'Flat, armpit to armpit' },
      { id: 'garment-circumference', label: 'All the way around' },
      { id: NOT_STATED, label: 'The chart doesn’t say' }
    ],
    shoulderWidth: [
      { id: 'seam-to-seam', label: 'Seam to seam' },
      { id: 'broadest-part-of-shoulders', label: 'Broadest part of the shoulders' },
      { id: NOT_STATED, label: 'The chart doesn’t say' }
    ],
    bodyLength: [
      { id: 'high-point-shoulder-to-hem', label: 'Top of the shoulder to hem' },
      { id: 'center-back-to-hem', label: 'Centre back of the neck to hem' },
      { id: NOT_STATED, label: 'The chart doesn’t say' }
    ],
    sleeveLength: [
      { id: 'shoulder-seam-to-cuff', label: 'Shoulder seam to cuff' },
      { id: 'center-back-to-cuff', label: 'Centre back of the neck to cuff' },
      { id: NOT_STATED, label: 'The chart doesn’t say' }
    ]
  };
  const DIMS = ['chestWidth', 'shoulderWidth', 'bodyLength', 'sleeveLength'];
  const LABELS = { chestWidth: 'Chest width', shoulderWidth: 'Shoulder width', bodyLength: 'Body length', sleeveLength: 'Sleeve length' };
  const TYPES = ['hoodies', 'sweatshirts', 'tshirts'];
  const TYPE_LABELS = { hoodies: 'Hoodie', sweatshirts: 'Sweatshirt', tshirts: 'T-shirt' };
  const LIMITS = { brand: 80, name: 80, size: 20 };

  const blank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
  const clean = (v) => String(v).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const isMethod = (dim, id) => Boolean(METHODS[dim] && METHODS[dim].some((m) => m.id === id));

  /* the plausible range for one value as its method measures it, or null:
     the reference form's own range where the method is the form's, twice
     it for a chest all the way around, none otherwise */
  function rangeFor(type, dim, method, unit) {
    const form = Schema.GARMENT_MEASURES[dim].method;
    const r = Schema.measureRange(type, dim, unit);
    if (!r) return null;
    if (method === form) return r;
    if (dim === 'chestWidth' && method === 'garment-circumference') return [r[0] * 2, r[1] * 2];
    return null;
  }

  function readCandidate(raw) {
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const type = typeof r.type === 'string' ? r.type : '';
    if (!TYPES.includes(type)) fail('type', 'Choose the type of garment: a hoodie, a sweatshirt or a T-shirt.');
    const text = (key, label, required) => {
      if (blank(r[key])) { if (required) fail(key, `Enter the ${label}.`); return null; }
      if (typeof r[key] !== 'string') { fail(key, `Enter the ${label} as text.`); return null; }
      const t = clean(r[key]);
      if (t.length > LIMITS[key]) { fail(key, `Keep the ${label} to ${LIMITS[key]} characters.`); return null; }
      return t || null;
    };
    const brand = text('brand', 'brand', false);
    const name = text('name', 'product name', false);
    const size = text('size', 'size you’re considering, as the chart labels it (like M or 42)', true);

    const unit = blank(r.unit) ? null : String(r.unit).trim().toLowerCase();
    const given = r.measurements && typeof r.measurements === 'object' ? r.measurements : {};
    const how = r.methods && typeof r.methods === 'object' ? r.methods : {};
    const measurements = {};
    const methods = { registry: REGISTRY };
    let any = false;
    DIMS.forEach((dim) => {
      const read = Schema.readNumber(given[dim]);
      if (read.blank) return;
      if (!read.ok || !(read.value > 0)) { fail(`measurements.${dim}`, `Enter the ${LABELS[dim].toLowerCase()} as a number above zero, like 56 or 22.5.`); return; }
      any = true;
      const method = how[dim];
      if (!isMethod(dim, method)) { fail(`methods.${dim}`, `Choose how the chart measures the ${LABELS[dim].toLowerCase()} — or “The chart doesn’t say”.`); return; }
      measurements[dim] = Math.round(read.value * 100) / 100;
      methods[dim] = method;
    });
    if (!any && !errors.some((e) => e.field.startsWith('measurements.'))) fail('measurements', 'Enter at least one measurement from the product’s chart — the chest width first, which every comparison needs.');
    if (any && unit !== 'in' && unit !== 'cm') fail('unit', 'Choose centimetres or inches, so the measurements mean what the chart says.');
    if (!errors.length && TYPES.includes(type)) {
      Object.keys(measurements).forEach((dim) => {
        const range = rangeFor(type, dim, methods[dim], unit);
        if (range && (measurements[dim] < range[0] || measurements[dim] > range[1])) {
          let message = `${LABELS[dim]} measured this way should be between ${range[0]} and ${range[1]} ${unit} for a ${TYPE_LABELS[type].toLowerCase()}.`;
          if (dim === 'chestWidth' && methods[dim] !== 'garment-circumference' && measurements[dim] > range[1]) message += ' If the chart gives the chest all the way around, choose that method.';
          fail(`measurements.${dim}`, message);
        }
      });
    }
    if (errors.length) return { candidate: null, errors };
    return { candidate: { type, brand, name, size, unit, measurements, methods }, errors: [] };
  }

  /* one value in the other unit, converted once from what was typed:
     centimetres to a tenth, inches to a hundredth (a quarter inch is
     kept exactly) */
  const CM_PER_INCH = 2.54;
  function convertValue(value, from, to) {
    if (from === to) return value;
    return from === 'in' ? Math.round(value * CM_PER_INCH * 10) / 10 : Math.round((value / CM_PER_INCH) * 100) / 100;
  }

  const FitCandidate = { readCandidate, convertValue, rangeFor, METHODS, DIMS, LABELS, TYPES, TYPE_LABELS, LIMITS, REGISTRY, NOT_STATED };
  global.FitCandidate = FitCandidate;
  if (typeof module !== 'undefined' && module.exports) module.exports = FitCandidate;
})(typeof window !== 'undefined' ? window : globalThis);
