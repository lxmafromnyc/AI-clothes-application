/* =========================================================
   Fynd — Find Fit: measure your garment another way, when it helps

   After a comparison, and only when the server asks
   (api/size-recommendation.js `measurementRequest`, worked out by
   api/_sizing/select-measurements.js): the product's chart measures a
   dimension by a method the garment wasn't measured by — length or
   sleeve from the centre back of the neck, shoulders at their broadest —
   and adding those would let the engine compare at all. Each is asked
   for with how to measure it; the values go to the garment compared
   (the saved one, through the fit profile; or this visit's), and the
   comparison runs again. Nothing is asked otherwise, and nothing is
   converted or estimated here.

     FindFitMeasureMore.show(data)  after a comparison's answer
     FindFitMeasureMore.hide()      when a new comparison starts
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const box = doc && doc.getElementById('ff-measure-more');
  if (!box || !global.SizeChart) return;
  const { el } = global.SizeChart;
  const WORDS = { 'center-back-to-hem': 'length from the centre back', 'center-back-to-cuff': 'sleeve from the centre back', 'broadest-part-of-shoulders': 'shoulders at the broadest point' };

  function hide() { box.replaceChildren(); box.hidden = true; }

  function rerun() {
    const form = doc.getElementById('ff-form');
    if (form && form.requestSubmit) form.requestSubmit(); else if (doc.getElementById('ff-submit')) doc.getElementById('ff-submit').click();
  }

  async function saveTo(type, list) {
    const ref = global.FindFitReference && global.FindFitReference.choice ? global.FindFitReference.choice() : null;
    if (ref && ref.source === 'saved') {
      const got = await global.Account.fitProfile.addAlternates(type, list);
      if (!got || !got.ok) return { ok: false, message: (got && got.data && got.data.error) || 'Fynd couldn’t save that just now. Try again in a moment.' };
      if (global.FindFitReference.refresh) await global.FindFitReference.refresh();
      return { ok: true };
    }
    const kept = global.FindFitReference && global.FindFitReference.addAlternates ? global.FindFitReference.addAlternates(type, list) : { ok: false, errors: [] };
    return kept.ok ? { ok: true } : { ok: false, message: (kept.errors[0] && kept.errors[0].message) || 'That couldn’t be kept.' };
  }

  function show(data) {
    hide();
    const ask = data && data.measurementRequest;
    const used = data && Array.isArray(data.alternatesUsed) ? data.alternatesUsed : [];
    if (!ask || !Array.isArray(ask.dimensions) || !ask.dimensions.length) {
      if (used.length) {
        box.append(el('p', 'ff-more-used', `Compared using your ${used.map((u) => WORDS[u.method] || u.dimension).join(' and ')} — measured the way this chart measures.`));
        box.hidden = false;
      }
      return;
    }
    const unit = ask.unit === 'cm' ? 'cm' : 'in';
    const n = ask.dimensions.length;
    const form = el('div', 'ff-more-form');
    form.setAttribute('role', 'group');
    form.setAttribute('aria-labelledby', 'ff-more-title');
    const title = el('p', 'ff-more-title', `Measure ${n === 1 ? 'one more thing' : `${n} more things`} to compare`);
    title.id = 'ff-more-title';
    form.append(title, el('p', 'ff-more-why', `${ask.retailer || 'This shop'} measures ${n === 1 ? 'this' : 'these'} differently from the way your garment was measured. Lay your garment flat and measure:`));
    ask.dimensions.forEach((x) => {
      const id = `ff-more-${x.dimension}`;
      const field = el('div', 'ff-more-field');
      const label = el('label', 'profile-label', x.label);
      label.htmlFor = id;
      const how = el('p', 'ffr-hint', x.how);
      how.id = `${id}-how`;
      const wrap = el('span', 'measure');
      const input = el('input', 'profile-input');
      Object.assign(input, { id, type: 'text', inputMode: 'decimal', autocomplete: 'off' });
      input.dataset.dimension = x.dimension;
      input.setAttribute('aria-describedby', `${id}-how ${id}-error`);
      wrap.append(input, el('span', 'measure-unit', unit));
      const error = el('p', 'form-error ffr-error');
      error.id = `${id}-error`;
      error.setAttribute('role', 'alert');
      field.append(label, how, wrap, error);
      form.append(field);
    });
    const failed = el('p', 'form-error ffr-error ff-more-error');
    failed.setAttribute('role', 'alert');
    const go = el('button', 'btn btn-primary ff-more-save', 'Save and compare again');
    go.type = 'button';
    go.addEventListener('click', async () => {
      failed.textContent = '';
      const list = [];
      let first = null;
      ask.dimensions.forEach((x) => {
        const input = doc.getElementById(`ff-more-${x.dimension}`);
        const error = doc.getElementById(`ff-more-${x.dimension}-error`);
        error.textContent = '';
        error.classList.remove('show');
        const v = Number(String(input.value).trim());
        const bad = !String(input.value).trim() || !Number.isFinite(v) || v <= 0 || (Array.isArray(x.range) && (v < x.range[0] || v > x.range[1]));
        if (bad) {
          error.textContent = `${x.label} should be a number${Array.isArray(x.range) ? ` between ${x.range[0]} and ${x.range[1]} ${unit}` : ''}.`;
          error.classList.add('show');
          if (!first) first = input;
          return;
        }
        list.push({ dimension: x.dimension, value: v });
      });
      if (first) { first.focus(); return; }
      go.disabled = true;
      go.textContent = 'Saving…';
      const saved = await saveTo(ask.garmentType, list);
      go.disabled = false;
      go.textContent = 'Save and compare again';
      if (!saved.ok) { failed.textContent = saved.message; failed.classList.add('show'); return; }
      rerun();
    });
    form.append(failed, go);
    box.append(form);
    box.hidden = false;
  }

  global.FindFitMeasureMore = { show, hide };
})(typeof window !== 'undefined' ? window : globalThis);
