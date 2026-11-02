/* =========================================================
   Fynd — Find Fit: does one size of an item fit like a garment the
   shopper already owns?

     top            what they're shopping for (a hoodie or a sweatshirt),
                    and the unit both garments are entered in
     01  your garment   saved on the fit profile, or described for this
                        visit (assets/find-fit-reference.js)
     02  the item       one size of any product: its finished-garment
                        measurements, copied by hand from the product's own
                        chart, each with how the chart measures it — or
                        "the chart doesn't say", never compared
     →  Compare fit     both go to the server (Account.sizing
                        .compareCandidate), and the answer is drawn below
                        by assets/fit-compare.js: a size only when the
                        server's decision is OK; otherwise why not,
                        measurement by measurement

   The item is read by assets/fit-candidate.js, the same reader the server
   uses: what is wrong is said beside the field it is about, and nothing is
   sent until it reads. A blank measurement stays blank — nothing is filled
   in. Compare fit says what is still missing and looks unavailable until
   both garments are there; pressed anyway, it shows where, and sends
   nothing. While a comparison runs it is busy, so it can't be sent twice.

   Units: one choice, at the top, for both garments. Each measurement
   remembers what was typed and in which unit; switching shows each one
   converted once from what was typed (centimetres to a tenth, inches to a
   hundredth), never converted again from a converted value, so switching
   back and forth never drifts and a value never silently changes its
   meaning. A garment's form drawn in another unit — a kept garment opened
   to edit — is shown converted the same way. What is sent is what is
   shown, in the unit chosen.

   Information buttons (.ff-info): a short explanation behind each, opened
   by click, tap, Enter or Space, closed by the same, Escape or a click
   elsewhere — never on hover alone. The field points at the explanation,
   so a screen reader hears it either way.

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
  const note = $('ff-submit-note');
  const refArea = $('ff-reference');
  const DIMS = Candidate.DIMS;
  const measureInput = (d) => $(`ffc-m-${d}`);
  const checked = (name) => { const r = form.querySelector(`input[name="${name}"]:checked`); return r ? r.value : null; };
  const metrics = global.FyndMetrics || { event: () => {}, completed: () => {}, manualInput: () => {} };
  /* the item from its link (assets/find-fit-item.js), when that is the way it's given */
  const Item = () => global.FindFitItem || null;
  const linkState = () => (Item() ? Item().state() : 'none');
  const usingLink = () => !['none', 'manual'].includes(linkState());
  const unitNow = () => checked('ff-unit');
  const typeNow = () => checked('ff-type');
  const BUTTON_TEXT = submit.textContent;

  /* ---------- what's being shopped for ---------- */
  /* the measurements each type is compared on: the four, for both today */
  const TYPE_DIMS = { hoodies: DIMS, sweatshirts: DIMS };
  function applyType() {
    const type = typeNow();
    const shown = TYPE_DIMS[type] || DIMS;
    form.querySelectorAll('#ff-step-target .ff-mrow').forEach((row) => { row.hidden = !shown.includes(row.dataset.dim); });
    /* the garment's form follows, while it's being filled in */
    const refType = $('ffr-type');
    if (refType && [...refType.options].some((o) => o.value === type)) refType.value = type;
  }
  form.querySelectorAll('input[name="ff-type"]').forEach((r) => r.addEventListener('change', () => { applyType(); stale(); }));

  /* ---------- units, for both garments ---------- */
  /* what was typed in each measurement box, and in which unit */
  const typed = new WeakMap();
  const NUMBER = /^\s*\d{1,4}(\.\d+)?\s*$/;
  const display = (v) => String(Number(v.toFixed(2)));
  const measures = () => [...form.querySelectorAll('input[data-measure]')];
  /* the unit a box's value is in now: the garment's form records its own */
  const unitOf = (input) => (input.closest('#ff-reference') && $('ffr-unit') ? $('ffr-unit').value : shownUnit);
  let shownUnit = unitNow();
  form.addEventListener('input', (event) => {
    const t = event.target;
    if (t && t.matches && t.matches('input[data-measure]')) typed.set(t, NUMBER.test(t.value) ? { value: Number(t.value), unit: unitNow() } : null);
  });
  /* each box shown in `to`, converted once from what was typed */
  function convertBoxes(boxes, to) {
    boxes.forEach((input) => {
      let source = typed.get(input);
      if (source === undefined && NUMBER.test(input.value)) {
        /* a value drawn into the box (a garment opened to edit): its own unit is its source */
        source = { value: Number(input.value), unit: unitOf(input) };
        typed.set(input, source);
      }
      /* a value that isn't a number yet is left exactly as typed */
      if (source && source.unit && to) input.value = display(Candidate.convertValue(source.value, source.unit, to));
    });
  }
  function labelUnits() {
    const u = unitNow();
    /* written only when it changes: the garment's form is watched for changes, and this is inside it */
    form.querySelectorAll('[data-part="unit-label"]').forEach((n) => { if (n.textContent !== (u || '')) n.textContent = u || ''; });
  }
  /* the garment's form, drawn or redrawn: shown in the chosen unit */
  function syncReferenceUnit() {
    const hidden = $('ffr-unit');
    const to = unitNow();
    if (hidden && to && hidden.value !== to) {
      convertBoxes([...refArea.querySelectorAll('input[data-measure]')], to);
      hidden.value = to;
    }
    labelUnits();
  }
  form.querySelectorAll('input[name="ff-unit"]').forEach((r) => r.addEventListener('change', () => {
    const to = unitNow();
    convertBoxes(measures(), to);
    if ($('ffr-unit')) $('ffr-unit').value = to;
    shownUnit = to;
    labelUnits();
    stale();
  }));
  if (refArea && global.MutationObserver) {
    /* the unit only: the form takes the top choice of type as its own default when drawn, and the shopper may change it */
    new global.MutationObserver(() => { syncReferenceUnit(); progress(); }).observe(refArea, { childList: true, subtree: true });
  }
  labelUnits();

  /* ---------- information buttons ---------- */
  const panelOf = (button) => $(button.getAttribute('aria-controls'));
  function setOpen(button, open) {
    const panel = panelOf(button);
    if (!panel) return;
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }
  const openButtons = () => [...doc.querySelectorAll('#ff-form .ff-info[aria-expanded="true"]')];
  doc.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('#ff-form .ff-info') : null;
    if (button) {
      event.preventDefault();
      const open = button.getAttribute('aria-expanded') !== 'true';
      openButtons().forEach((b) => { if (b !== button) setOpen(b, false); });
      setOpen(button, open);
      return;
    }
    /* a click anywhere but an open explanation closes it */
    openButtons().forEach((b) => { const p = panelOf(b); if (!(p && p.contains(event.target))) setOpen(b, false); });
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const open = openButtons();
    if (!open.length) return;
    const focusIn = open.find((b) => b === doc.activeElement || (panelOf(b) && panelOf(b).contains(doc.activeElement)));
    open.forEach((b) => setOpen(b, false));
    if (focusIn) focusIn.focus();
  });

  /* ---------- reading the item ---------- */
  function raw() {
    const v = (id) => $(id).value;
    const measurements = {};
    const methods = { registry: Candidate.REGISTRY };
    DIMS.forEach((d) => { measurements[d] = v(`ffc-m-${d}`); methods[d] = v(`ffc-how-${d}`) || null; });
    return { type: typeNow(), brand: v('ffc-brand'), name: v('ffc-name'), size: v('ffc-size'), unit: unitNow(), measurements, methods };
  }
  const FIELD = (field) => {
    if (field.startsWith('measurements.')) return `ffc-m-${field.slice(13)}`;
    if (field.startsWith('methods.')) return `ffc-how-${field.slice(8)}`;
    return { type: 'ff-type', brand: 'ffc-brand', name: 'ffc-name', size: 'ffc-size', unit: 'ff-unit', measurements: 'ffc-measurements' }[field] || 'ffc-measurements';
  };
  function clearErrors() {
    form.querySelectorAll('#ff-step-target .ffr-error, .ff-setup .ffr-error, #ff-garment-error').forEach((n) => { n.textContent = ''; n.classList.remove('show'); });
    form.querySelectorAll('#ff-step-target [aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
  }
  /* each problem beside its field; focus on the first */
  function showErrors(errors, garmentMissing) {
    clearErrors();
    let first = null;
    if (garmentMissing) {
      const err = $('ff-garment-error');
      err.textContent = 'Choose a garment you own first: find it by name or link and choose its size, or enter its measurements — then “Use this garment”.';
      err.classList.add('show');
      first = $('ffr-brand') || $('ff-step-reference');
    }
    errors.forEach(({ field, message }) => {
      const id = FIELD(field);
      const err = $(`${id}-error`);
      if (err && !err.textContent) { err.textContent = message; err.classList.add('show'); }
      const control = id === 'ff-unit' || id === 'ff-type' ? form.querySelector(`input[name="${id}"]`) : $(id);
      if (control && control.setAttribute && id !== 'ffc-measurements') control.setAttribute('aria-invalid', 'true');
      if (!first && control && control.focus) first = control;
    });
    if (first && first.focus) first.focus();
  }

  /* ---------- where the two halves stand ---------- */
  const progressBox = $('ff-progress');
  function setPill(id, text) {
    const t = $(id) && $(id).querySelector('.ff-progress-text');
    if (t) t.textContent = text;
  }
  function itemState() {
    if (usingLink()) {
      const st = linkState();
      if (st === 'loading') return 'looking';
      if (st === 'automatic' || st === 'assisted') return Item().ready() ? 'ready' : !Item().type() ? 'needs-type' : 'needs-check';
      return 'cannot';
    }
    const r = raw();
    const anyValue = DIMS.some((d) => r.measurements[d] && r.measurements[d].trim());
    if (!anyValue && !(r.size || '').trim()) return 'empty';
    const read = Candidate.readCandidate(r);
    if (read.errors.length) return 'incomplete';
    /* every comparison needs the chest: without it the item can't be compared */
    return read.candidate.measurements.chestWidth ? 'ready' : 'no-chest';
  }
  /* the garment form, filled in but not yet kept: Compare fit uses it */
  /* anything typed that could make a garment: a brand, a size, a product, or a measurement */
  const formFilled = () => Boolean($('ffr-use')) && ['ffr-brand', 'ffr-size', 'ffr-product', 'ffr-m-chestWidth', 'ffr-m-shoulderWidth', 'ffr-m-bodyLength', 'ffr-m-sleeveLength'].some((id) => $(id) && $(id).value.trim());
  function garmentState() {
    const ref = global.FindFitReference;
    if (refArea && refArea.dataset.state === 'saved') return ref && ref.choice && !ref.choice() ? 'mismatch' : 'saved';
    if (ref && ref.current && ref.current()) return 'ready';
    return formFilled() ? 'filled' : 'empty';
  }
  let busy = false;
  function progress() {
    if (!progressBox) return;
    const item = itemState();
    const garment = garmentState();
    progressBox.dataset.item = item;
    progressBox.dataset.garment = garment === 'empty' ? 'empty' : 'ready';
    setPill('ff-progress-garment', garment === 'saved' ? 'Your garment: from your fit profile' : garment === 'mismatch' ? 'Your garment: none of this kind saved' : garment === 'ready' ? 'Your garment: added' : garment === 'filled' ? 'Your garment: being entered' : 'Your garment: not added yet');
    setPill('ff-progress-item', { empty: 'Item: not entered yet', incomplete: 'Item: still being entered', 'no-chest': 'Item: chest width needed', ready: usingLink() ? 'Item: every size found' : 'Item: ready', looking: 'Item: looking it up', 'needs-check': 'Item: check the measurements', 'needs-type': 'Item: say what kind it is', cannot: 'Item: can’t be read from its link' }[item]);
    const ready = garment !== 'empty' && garment !== 'mismatch' && item === 'ready';
    submit.textContent = busy ? submit.textContent : usingLink() ? 'Compare every size' : BUTTON_TEXT;
    let next;
    if (busy) next = 'Comparing…';
    else if (garment === 'mismatch') next = 'Your saved garments are a different kind from this item. Add one of its kind on your fit profile.';
    else if (item === 'looking') next = 'Looking up the product…';
    else if (item === 'needs-check') next = 'Check the measurements Fynd found against the product page’s chart.';
    else if (item === 'needs-type') next = 'Say what kind of garment the item is.';
    else if (item === 'cannot') next = 'Fynd couldn’t read this item from its link: use the Fynd extension on its page, or enter one size by hand.';
    else if (ready) next = !result.hidden && result.dataset.state === 'done' ? 'Your comparison is below.' : 'Ready to compare.';
    else if (garment === 'empty' && item !== 'ready') next = 'Choose your garment, and paste the item’s link — or enter it by hand.';
    else if (garment === 'empty') next = 'Next: add a garment you own that fits well.';
    else if (item === 'no-chest') next = 'Enter the item’s chest width — every comparison needs it.';
    else if (item === 'incomplete') next = 'Finish the item’s details: each value needs how the chart measures it.';
    else next = 'Next: paste the item’s link — or enter its measurements by hand.';
    note.textContent = next;
    /* never looking available while something it needs is missing */
    submit.setAttribute('aria-disabled', String(!ready || busy));
    submit.classList.toggle('is-waiting', !ready && !busy);
  }

  /* ---------- the comparison ---------- */
  let latest = 0;
  /* anything changed: a result for what was there before goes */
  function stale() {
    latest += 1;
    if (!result.hidden && !busy) {
      result.hidden = true;
      if (global.FindFitSave) global.FindFitSave.hide();
    }
    progress();
  }
  form.addEventListener('input', (event) => { if (event.target.closest('#ff-step-target')) stale(); else progress(); });
  form.addEventListener('change', (event) => { if (event.target.closest('#ff-step-target')) stale(); else progress(); });
  /* the shopper changed their garment: a result for the old one goes. A
     change the page made itself — the account read after signing in, say
     — leaves the result, and any offer to save, where they are */
  doc.addEventListener('fynd:reference-change', (event) => {
    if (event && event.detail && event.detail.by === 'shopper') stale();
    else progress();
    maybeCompare();
  });
  doc.addEventListener('fynd:item-change', (event) => {
    if (event && event.detail && event.detail.by === 'shopper') stale(); else progress();
    maybeCompare();
  });
  /* Fynd did the work, or the shopper confirmed what it found: compare at once,
     once for each item and garment — by hand, Compare fit is still the shopper's */
  let autoDone = '';
  function maybeCompare() {
    if (busy || !usingLink() || itemState() !== 'ready') return;
    /* a garment typed but not yet kept counts: comparing keeps it first, by the form's own checks */
    const g = garmentState();
    if (g !== 'saved' && g !== 'ready' && g !== 'filled') return;
    const ref = global.FindFitReference && global.FindFitReference.choice ? global.FindFitReference.choice() : null;
    const sig = JSON.stringify([Item().source(), Item().type(), ref && ref.type, ref && ref.source]);
    if (sig === autoDone) return;
    autoDone = sig;
    global.setTimeout(() => { if (form.requestSubmit) form.requestSubmit(); else submit.click(); }, 0);
  }

  function itemWords(c) {
    const type = Candidate.TYPE_LABELS[c.type].toLowerCase();
    const named = [c.brand, c.name].filter(Boolean).join(' · ');
    return named ? `${named} — size ${c.size}` : `The ${type} you’re considering — size ${c.size}`;
  }

  /* the garment typed in but not yet kept: kept now, by the form's own
     button, so its own checks run; resolves once it is kept, or not */
  function keepTypedGarment() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; doc.removeEventListener('fynd:reference-change', onChange); resolve(garmentState() === 'ready' || garmentState() === 'saved'); } };
      const onChange = () => global.setTimeout(finish, 0);
      doc.addEventListener('fynd:reference-change', onChange);
      $('ffr-use').click();
      /* a form that didn't read says so beside its fields, and keeps nothing */
      global.setTimeout(finish, 400);
    });
  }

  function outcomeOf(verdict) {
    return verdict === 'recommended' ? 'ok' : verdict === 'closest-mismatch' || verdict === 'no-match' ? 'no_match' : verdict === 'error' ? 'error' : 'insufficient';
  }
  function noteReference(ref) {
    metrics.event('reference_ready');
    metrics.event(ref && ref.source === 'saved' ? 'reference_ready_saved' : `reference_ready_${(ref && ref.how) || 'manual'}`);
  }

  /* the item from its link: every size, one request */
  async function compareLink() {
    const garment = garmentState();
    if (garment === 'empty' || garment === 'mismatch' || itemState() !== 'ready') { progress(); if (garment === 'empty') showErrors([], true); return; }
    clearErrors();
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Comparing…';
    submit.setAttribute('aria-busy', 'true');
    try {
      if (garment === 'filled' && !(await keepTypedGarment())) {
        /* the garment didn't read: its own fields say why; the shopper fixes it and compares */
        autoDone = '';
        return;
      }
      const ref = global.FindFitReference.choice();
      if (!ref) return;
      const ask = ++latest;
      const item = Item();
      const product = item.product() || {};
      if (global.FindFitSave) global.FindFitSave.hide();
      result.hidden = false;
      result.dataset.state = 'loading';
      $('fit-result-product').textContent = `${[product.brand, product.name].filter(Boolean).join(' · ') || 'The item'} — every size`;
      compare.hidden = false;
      compare.dataset.verdict = 'loading';
      compare.replaceChildren(el('h3', 'fit-compare-title', 'Comparing…'), el('p', 'size-chart-loading', 'Setting every size beside your garment…'));
      progress();
      metrics.event('comparison_started');
      noteReference(ref);
      $('fit-result-title').focus({ preventScroll: true });
      result.scrollIntoView({ block: 'start', behavior: 'auto' });
      const sizing = global.Account.sizing;
      const src = item.source();
      const reference = { type: ref.type, garment: ref.garment };
      let got;
      if (src.mode === 'record') {
        got = ref.source === 'saved' && ref.isDefault ? await sizing.compare(src.productId) : await sizing.compareWith(src.productId, reference);
      } else {
        got = await sizing.compareChart(Object.assign({}, src.chart, { type: item.type() }), ref.source === 'saved' ? { referenceType: ref.type } : { reference });
      }
      if (ask !== latest) return;
      global.FitCompare.showAnswer(got, compare, { unsaved: ref.source === 'visit' ? reference : null });
      result.dataset.state = 'done';
      metrics.completed(outcomeOf(compare.dataset.verdict));
      if (global.FindFitSave) global.FindFitSave.offer();
    } finally {
      busy = false;
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      progress();
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if (usingLink()) { await compareLink(); return; }
    const read = Candidate.readCandidate(raw());
    const garment = garmentState();
    if (read.errors.length || garment === 'empty') { showErrors(read.errors, garment === 'empty'); progress(); return; }
    clearErrors();
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Comparing…';
    submit.setAttribute('aria-busy', 'true');
    try {
      if (garment === 'filled' && !(await keepTypedGarment())) {
        const first = refArea.querySelector('.ffr-error.show');
        const control = first && $(first.id.replace(/-error$/, ''));
        if (control && control.focus) control.focus();
        return;
      }
      const ask = ++latest;
      const candidate = read.candidate;
      if (global.FindFitSave) global.FindFitSave.hide();
      result.hidden = false;
      result.dataset.state = 'loading';
      $('fit-result-product').textContent = itemWords(candidate);
      compare.hidden = false;
      compare.dataset.verdict = 'loading';
      compare.replaceChildren(el('h3', 'fit-compare-title', 'Comparing…'), el('p', 'size-chart-loading', 'Setting this item beside your garment…'));
      progress();
      $('fit-result-title').focus({ preventScroll: true });
      result.scrollIntoView({ block: 'start', behavior: 'auto' });
      const reference = global.FindFitReference ? global.FindFitReference.unsaved() : null;
      metrics.event('comparison_started');
      metrics.event('candidate_ready_manual');
      noteReference(global.FindFitReference && global.FindFitReference.choice ? global.FindFitReference.choice() : null);
      await global.FitCompare.showCandidate(candidate, compare, () => ask === latest, reference ? { reference } : {});
      if (ask === latest) {
        metrics.completed(outcomeOf(compare.dataset.verdict));
        result.dataset.state = 'done';
        if (global.FindFitSave) global.FindFitSave.offer();
      }
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = BUTTON_TEXT;
      submit.removeAttribute('aria-busy');
      progress();
    }
  });

  applyType();
  progress();
  /* the first time the shopper types the item by hand */
  let candidateOnce = false;
  form.addEventListener('input', (e) => { if (!candidateOnce && e.target && e.target.closest && e.target.closest('#ff-manual')) { candidateOnce = true; metrics.event('candidate_started'); } });
  global.FindFitManual = { read: () => Candidate.readCandidate(raw()), progress };
})(typeof window !== 'undefined' ? window : globalThis);
