/* =========================================================
   Fynd — Find Fit: does one size of an item fit like a garment the
   shopper already owns?

     1  your garment   saved on the fit profile, or described for this
                       visit (assets/find-fit-reference.js)
     2  the item       one size of any product: its finished-garment
                       measurements, copied by hand from the product's own
                       measurement chart, each with how the chart measures
                       it — or "the chart doesn't say", never compared
     →  "Compare fit"  both go to the server (Account.sizing
                       .compareCandidate), and the answer is drawn by
                       assets/fit-compare.js: a size only when the
                       server's decision is OK; otherwise why not,
                       measurement by measurement

   The item is read by assets/fit-candidate.js, the same reader the
   server uses: what is wrong is said beside the field it is about, and
   nothing is sent until it reads. A blank measurement stays blank —
   nothing is filled in.

   Units: each measurement remembers what was typed and in which unit.
   Switching the unit shows each one converted once from what was typed
   (centimetres to a tenth, inches to a hundredth), never converted again
   from a converted value, so switching back and forth never drifts and
   a value never silently changes its meaning. What is sent is what is
   shown, in the unit chosen.

   Nothing here is saved, and nothing travels in the address.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const form = doc && doc.getElementById('ff-form');
  const Candidate = global.FitCandidate;
  if (!form || !Candidate || !global.FitCompare || !global.SizeChart) return;

  const $ = (id) => doc.getElementById(id);
  const { el } = global.SizeChart;
  const result = $('fit-result');
  const compare = $('fit-compare');
  const submit = $('ff-submit');
  const DIMS = Candidate.DIMS;
  const measureInput = (d) => $(`ffc-m-${d}`);
  const methodSelect = (d) => $(`ffc-how-${d}`);
  const unitNow = () => { const r = form.querySelector('input[name="ffc-unit"]:checked'); return r ? r.value : null; };

  /* ---------- units ---------- */
  /* what was typed, and in which unit: the source every shown value is converted from */
  const typed = {};
  const NUMBER = /^\s*\d{1,4}(\.\d+)?\s*$/;
  const show = (v) => String(Number(v.toFixed(2)));
  DIMS.forEach((d) => {
    measureInput(d).addEventListener('input', () => {
      const text = measureInput(d).value;
      typed[d] = NUMBER.test(text) ? { value: Number(text), unit: unitNow() } : null;
    });
  });
  function labelUnits() {
    const u = unitNow();
    form.querySelectorAll('[data-part="unit-label"]').forEach((n) => { n.textContent = u ? `(${u})` : ''; });
  }
  form.querySelectorAll('input[name="ffc-unit"]').forEach((r) => r.addEventListener('change', () => {
    const to = unitNow();
    DIMS.forEach((d) => {
      const t = typed[d];
      /* a value that isn't a number yet is left exactly as typed */
      if (t && t.unit && to) measureInput(d).value = show(Candidate.convertValue(t.value, t.unit, to));
    });
    labelUnits();
    stale();
  }));
  labelUnits();

  /* ---------- reading the item ---------- */
  function raw() {
    const v = (id) => $(id).value;
    const measurements = {};
    const methods = { registry: Candidate.REGISTRY };
    DIMS.forEach((d) => { measurements[d] = v(`ffc-m-${d}`); methods[d] = v(`ffc-how-${d}`) || null; });
    return { type: v('ffc-type'), brand: v('ffc-brand'), name: v('ffc-name'), size: v('ffc-size'), unit: unitNow(), measurements, methods };
  }
  const FIELD = (field) => {
    if (field.startsWith('measurements.')) return `ffc-m-${field.slice(13)}`;
    if (field.startsWith('methods.')) return `ffc-how-${field.slice(8)}`;
    return { type: 'ffc-type', brand: 'ffc-brand', name: 'ffc-name', size: 'ffc-size', unit: 'ffc-unit', measurements: 'ffc-measurements' }[field] || 'ffc-measurements';
  };
  function clearErrors() {
    form.querySelectorAll('#ff-step-target .ffr-error').forEach((n) => { n.textContent = ''; n.classList.remove('show'); });
    form.querySelectorAll('#ff-step-target [aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
  }
  function showErrors(errors) {
    clearErrors();
    let first = null;
    errors.forEach(({ field, message }) => {
      const id = FIELD(field);
      const err = $(`${id}-error`);
      if (err && !err.textContent) { err.textContent = message; err.classList.add('show'); }
      const control = id === 'ffc-unit' ? form.querySelector('input[name="ffc-unit"]') : $(id);
      if (control && control.setAttribute && id !== 'ffc-measurements') control.setAttribute('aria-invalid', 'true');
      if (!first && control && control.focus) first = control;
    });
    if (first) first.focus();
  }

  /* ---------- where the two halves stand ---------- */
  const progressBox = $('ff-progress');
  function setPill(id, text) {
    const t = $(id) && $(id).querySelector('.ff-progress-text');
    if (t) t.textContent = text;
  }
  function itemState() {
    const r = raw();
    const anyValue = DIMS.some((d) => r.measurements[d] && r.measurements[d].trim());
    if (!anyValue && !(r.size || '').trim()) return 'empty';
    return Candidate.readCandidate(r).errors.length ? 'incomplete' : 'ready';
  }
  function garmentState() {
    const ref = global.FindFitReference;
    const area = $('ff-reference');
    if (area && area.dataset.state === 'saved') return 'saved';
    return ref && ref.current && ref.current() ? 'ready' : 'empty';
  }
  function progress() {
    if (!progressBox) return;
    const item = itemState();
    const garment = garmentState();
    progressBox.dataset.item = item;
    progressBox.dataset.garment = garment === 'empty' ? 'empty' : 'ready';
    setPill('ff-progress-garment', garment === 'saved' ? 'Your garment: from your fit profile' : garment === 'ready' ? 'Your garment: added' : 'Your garment: not added yet');
    setPill('ff-progress-item', { empty: 'Item: not entered yet', incomplete: 'Item: still being entered', ready: 'Item: ready' }[item]);
    let next = 'Add your garment, then the item.';
    if (garment !== 'empty' && item === 'ready') next = !result.hidden ? (result.dataset.state === 'loading' ? 'Comparing…' : 'Your comparison is below.') : 'Ready to compare.';
    else if (garment !== 'empty') next = 'Next: enter the item’s measurements from its chart.';
    else if (item === 'ready') next = 'Next: add a garment you own that fits well.';
    $('ff-progress-next').textContent = next;
  }

  /* ---------- the comparison ---------- */
  let latest = 0;
  /* anything changed: a result for what was there before goes */
  function stale() {
    latest += 1;
    if (!result.hidden) {
      result.hidden = true;
      if (global.FindFitSave) global.FindFitSave.hide();
    }
    progress();
  }
  form.addEventListener('input', (event) => { if (event.target.closest('#ff-step-target')) stale(); });
  form.addEventListener('change', (event) => { if (event.target.closest('#ff-step-target') && event.target.name !== 'ffc-unit') stale(); });
  /* the shopper changed their garment: a result for the old one goes. A
     change the page made itself — the account read after signing in, say
     — leaves the result, and any offer to save, where they are */
  doc.addEventListener('fynd:reference-change', (event) => {
    if (event && event.detail && event.detail.by === 'shopper') stale();
    else progress();
  });

  function itemWords(c) {
    const type = Candidate.TYPE_LABELS[c.type].toLowerCase();
    const named = [c.brand, c.name].filter(Boolean).join(' · ');
    return named ? `${named} — size ${c.size}` : `The ${type} you’re considering — size ${c.size}`;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const read = Candidate.readCandidate(raw());
    if (read.errors.length) { showErrors(read.errors); progress(); return; }
    clearErrors();
    const ask = ++latest;
    const candidate = read.candidate;
    if (global.FindFitSave) global.FindFitSave.hide();
    result.hidden = false;
    result.dataset.state = 'loading';
    $('fit-result-product').textContent = itemWords(candidate);
    compare.hidden = false;
    compare.dataset.verdict = 'loading';
    compare.replaceChildren(el('h3', 'fit-compare-title', 'Comparing…'), el('p', 'size-chart-loading', 'Setting this item beside your garment…'));
    submit.disabled = true;
    progress();
    $('fit-result-title').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: 'auto' });
    try {
      const reference = global.FindFitReference ? global.FindFitReference.unsaved() : null;
      await global.FitCompare.showCandidate(candidate, compare, () => ask === latest, reference ? { reference } : {});
    } finally {
      submit.disabled = false;
      if (ask === latest) {
        result.dataset.state = 'done';
        if (global.FindFitSave) global.FindFitSave.offer();
      }
      progress();
    }
  });

  progress();
  global.FindFitManual = { read: () => Candidate.readCandidate(raw()), progress };
})(typeof window !== 'undefined' ? window : globalThis);
