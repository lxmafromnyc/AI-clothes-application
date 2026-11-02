/* =========================================================
   Fynd — Find Fit: the item, from its link

   The shopper pastes the product's link; Fynd does the rest where it can
   (Account.sizing.chart: the server's own lookup, api/_sizing/chart.js),
   and asks only for what it can't establish:

     automatic   Fynd holds checked garment measurements for this exact
                 product: every size is compared at once, nothing to check
                 (Account.sizing.compare / compareWith — the record path)
     assisted    Fynd found the product's garment chart — its own unchecked
                 copy of the brand's page, or the page itself — with every
                 column's measurement, method and unit known: shown as a
                 short summary for one confirmation ("these match the chart
                 on the product page"), every value one click away; then
                 every size in one request (Account.sizing.compareChart, the
                 extension's batch comparison), compared as the shopper's
                 confirmed numbers, never "verified"
     incomplete  a chart, but a method, the unit or the chest isn't known
                 from it: said so, with the extension and hand entry as the
                 ways on — nothing guessed
     body-only   only a body-size chart: never compared with a garment
     unavailable the page can't be read from Fynd's server (no record, and
                 the retailer isn't cleared for reading): the extension,
                 which reads it in the shopper's own browser, or hand entry

   The kind of garment comes from Fynd's record or the product's own name;
   it is asked only when neither says. Units come with the chart. Nothing
   is typed that Fynd already knows.

     FindFitItem.state()    'none' | 'loading' | one of the above | 'error'
     FindFitItem.ready()    true when the item can be compared now
     FindFitItem.source()   { mode: 'record', productId } | { mode: 'chart', chart }
     FindFitItem.type()     the kind of garment, once known
     FindFitItem.product()  { brand, name } as Fynd read them
     FindFitItem.automatic() true for the automatic path (no check needed)
   Fires "fynd:item-change" (detail: { type, state, by }) whenever any of
   that changes, so the reference half can pick the matching garment and
   the controller (assets/find-fit-manual.js) can compare.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const box = doc && doc.getElementById('ffi-found');
  const linkInput = doc && doc.getElementById('ffi-link');
  const go = doc && doc.getElementById('ffi-link-go');
  const Candidate = global.FitCandidate;
  const Reading = global.FyndChartReading;
  if (!box || !linkInput || !go || !Candidate || !Reading || !global.SizeChart) return;
  const { el } = global.SizeChart;
  const $ = (id) => doc.getElementById(id);
  const manual = $('ff-manual');
  const metrics = global.FyndMetrics || { event: () => {}, manualInput: () => {} };

  const TYPE_WORDS = Candidate.TYPE_LABELS || { hoodies: 'Hoodie', sweatshirts: 'Sweatshirt', tshirts: 'T-shirt' };
  const TYPES = Object.keys(TYPE_WORDS);
  const METHOD_WORDS = Object.fromEntries(Object.entries(Candidate.METHODS).flatMap(([, list]) => list.map((m) => [m.id, m.label])));

  let state = 'none';
  let item = null;     /* { product, sizes, type, typeFrom, source, unit, summary, checked } */
  let ask = 0;

  /* the kind of garment, only from the product's own name (as the extension reads it) */
  function guessType(name) {
    const n = String(name || '').toLowerCase();
    if (/\bhood(ie|y|ed)\b/.test(n)) return 'hoodies';
    if (/\bsweat ?shirt\b|\bcrew ?neck sweat/.test(n)) return 'sweatshirts';
    if (/\bt-?shirt\b|\btee\b/.test(n)) return 'tshirts';
    return null;
  }

  function changed(by) {
    try { doc.dispatchEvent(new global.CustomEvent('fynd:item-change', { detail: { type: item ? item.type : null, state, by: by || 'page' } })); } catch (err) { /* no events here */ }
  }
  function set(next, by) { state = next; draw(); changed(by); }

  /* ---------- from the server's chart answer to what can be compared ---------- */
  function fromAnswer(c, url) {
    const product = { brand: (c.product && c.product.brand) || c.retailer || null, name: (c.product && c.product.name) || null, url };
    const charts = Array.isArray(c.charts) ? c.charts : [];
    const garment = charts.find((x) => x.measures === 'finished-garment');
    const type = TYPES.includes(c.category) ? c.category : guessType(product.name);
    const base = { product, sizes: Array.isArray(c.sizes) ? c.sizes : [], type, typeFrom: TYPES.includes(c.category) ? 'record' : type ? 'name' : null, checked: false };
    if (c.status === 'unavailable' || !charts.length) return Object.assign(base, { state: 'unavailable', note: c.note || null });
    if (!garment) return Object.assign(base, { state: charts.some((x) => x.measures === 'not-stated') ? 'incomplete' : 'body-only', why: charts.some((x) => x.measures === 'not-stated') ? ['The page’s chart doesn’t say whether it measures the garment or the body.'] : [] });
    /* the record path: checked measurements for this exact product */
    if (c.from === 'fynd-record' && c.comparable && c.productId) {
      return Object.assign(base, { state: 'automatic', source: { mode: 'record', productId: c.productId }, unit: garment.unit, summary: summarise(garment) });
    }
    /* a chart to compare as the shopper's confirmed numbers: every column read, or none */
    const unit = garment.unit === 'cm' || garment.unit === 'in' ? garment.unit : null;
    const columns = (garment.columns || []).map((header, i) => {
      const dim = Array.isArray(garment.dims) && Candidate.DIMS.includes(garment.dims[i]) ? garment.dims[i] : Reading.dimOf(header);
      const fromRecord = Array.isArray(garment.methodIds) ? garment.methodIds[i] : null;
      const method = dim ? (Candidate.METHODS[dim].some((m) => m.id === fromRecord) ? fromRecord : Reading.methodSaid(dim, `${header} ${(garment.methods && garment.methods[i]) || ''}`)) : null;
      return { i, header, dim, method };
    }).filter((x) => x.dim);
    const why = [];
    if (!unit) why.push('The chart doesn’t say whether it is in centimetres or inches.');
    columns.filter((x) => !x.method || x.method === 'not-stated').forEach((x) => why.push(`The chart doesn’t say how “${x.header}” is measured.`));
    if (!columns.some((x) => x.dim === 'chestWidth')) why.push('The chart has no chest measurement, which every comparison needs.');
    if (new Set(columns.map((x) => x.dim)).size !== columns.length) why.push('The chart names a measurement twice.');
    if (why.length) return Object.assign(base, { state: 'incomplete', why });
    const origin = c.from === 'fynd-record' ? 'fynd-record' : 'page-table';
    const methods = Object.assign({ registry: Candidate.REGISTRY }, Object.fromEntries(columns.map((x) => [x.dim, x.method])));
    const sizes = (garment.rows || []).map((row) => {
      const measurements = {};
      const provenance = {};
      columns.forEach((x) => {
        const parsed = Reading.parseCell(row.values[x.i]);
        if (typeof parsed.value !== 'number') return;
        measurements[x.dim] = parsed.value;
        provenance[x.dim] = { source: origin, header: String(x.header).slice(0, 60), corrected: false };
      });
      return { size: String(row.size).slice(0, 20), measurements, provenance };
    }).filter((s) => Object.keys(s.measurements).length);
    if (!sizes.length) return Object.assign(base, { state: 'incomplete', why: ['No size in the chart has a measurement Fynd can read.'] });
    const chart = { measures: 'finished-garment', brand: product.brand, name: product.name, url: /^https?:/.test(url) ? url : null, unit, methods, sizes };
    return Object.assign(base, { state: 'assisted', origin, source: { mode: 'chart', chart }, unit, summary: summarise(garment, columns), retrievedAt: garment.retrievedAt || null });
  }
  /* what was found, in a line: the measurements and how each is taken */
  function summarise(garment, columns) {
    const cols = columns || (garment.dims || []).map((dim, i) => ({ i, dim, header: garment.columns[i], method: garment.methodIds ? garment.methodIds[i] : null }));
    return { columns: cols, rows: garment.rows || [], unit: garment.unit };
  }

  /* ---------- drawing ---------- */
  function chips(sizes) {
    const ul = el('ul', 'ffi-sizes');
    ul.setAttribute('aria-label', 'Sizes');
    sizes.slice(0, 30).forEach((s) => ul.append(el('li', null, s)));
    return ul;
  }
  function valuesTable(summary) {
    const t = el('table', 'ffi-values');
    const cap = el('caption', null, `In ${summary.unit === 'in' ? 'inches' : 'centimetres'}, each measured as the chart says`);
    const head = el('tr');
    head.append(el('th', null, 'Size'), ...summary.columns.map((x) => {
      const th = el('th', null, Candidate.LABELS[x.dim] || x.header);
      if (x.method && METHOD_WORDS[x.method]) th.append(el('span', 'ffi-method', METHOD_WORDS[x.method]));
      return th;
    }));
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    summary.rows.forEach((r) => {
      const tr = el('tr');
      tr.append(el('th', null, r.size), ...summary.columns.map((x) => el('td', null, r.values[x.i] || '—')));
      tbody.append(tr);
    });
    t.append(cap, thead, tbody);
    return t;
  }
  function typeChooser() {
    const wrap = el('div', 'ffi-type');
    const label = el('label', 'profile-label', 'What kind of garment is it?');
    label.htmlFor = 'ffi-type';
    const s = el('select', 'profile-input profile-select');
    s.id = 'ffi-type';
    [['', 'Choose…']].concat(TYPES.map((t) => [t, TYPE_WORDS[t]])).forEach(([v, t]) => { const o = el('option', null, t); o.value = v; if (v === (item.type || '')) o.selected = true; s.append(o); });
    s.addEventListener('change', () => { item.type = s.value || null; item.typeFrom = s.value ? 'shopper' : null; metrics.manualInput('ffi-type'); draw(); changed('shopper'); });
    const w = el('span', 'select-wrap');
    w.append(s);
    wrap.append(label, w);
    return wrap;
  }
  function ways() {
    const p = el('p', 'ffi-ways');
    const open = el('button', 'link-btn', 'enter one size by hand');
    open.type = 'button';
    open.addEventListener('click', () => { if (manual) { manual.open = true; const f = $('ffc-size'); if (f) f.focus(); } });
    p.append(doc.createTextNode('Use the Fynd extension on the product page — it reads the page in your browser — or '), open, doc.createTextNode('.'));
    return p;
  }

  function draw() {
    if (state === 'none') { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    box.dataset.state = state;
    if (state === 'loading') { box.replaceChildren(el('p', 'ffi-status', 'Looking up the product…')); return; }
    if (state === 'error') { box.replaceChildren(el('p', 'ffi-status', 'Fynd couldn’t look up that link just now. Try again in a moment.'), ways()); return; }
    const card = [];
    const name = [item.product.brand, item.product.name].filter(Boolean).join(' · ');
    const head = el('div', 'ffi-head');
    head.append(el('p', 'ffi-name', name || 'This product'));
    const clear = el('button', 'link-btn ffi-clear', 'Not this one');
    clear.type = 'button';
    clear.addEventListener('click', () => { reset('shopper'); linkInput.value = ''; linkInput.focus(); });
    head.append(clear);
    card.push(head);
    if (item.sizes.length) card.push(chips(item.sizes));
    const status = el('p', 'ffi-status');
    if (state === 'automatic') {
      status.textContent = 'Fynd holds this product’s checked garment measurements for every size. Nothing to enter: it compares every size with your garment.';
    } else if (state === 'assisted') {
      status.textContent = item.origin === 'fynd-record'
        ? `Fynd found ${item.product.brand || 'the brand'}’s published garment measurements for every size, from its own copy of the product page — not yet checked by Fynd. Check them against the chart on the product page, then compare.`
        : 'Fynd read the garment measurements for every size from the product page. Check them against the chart there, then compare.';
    } else if (state === 'body-only') {
      status.textContent = 'Fynd holds only a body-size chart for this product — who each size is made for, not the garment’s own measurements — so it can’t compare it with your garment.';
    } else if (state === 'incomplete') {
      status.textContent = 'Fynd found a chart for this product, but can’t read it reliably enough to compare:';
    } else {
      status.textContent = item.note || 'Fynd can’t read this product’s page from its server.';
    }
    status.dataset.state = state;
    card.push(status);
    if (state === 'incomplete') {
      const ul = el('ul', 'ffi-why');
      (item.why || []).forEach((t) => ul.append(el('li', null, t)));
      card.push(ul);
    }
    if ((state === 'automatic' || state === 'assisted') && item.summary) {
      const d = el('details', 'ffi-details');
      d.id = 'ffi-details';
      if (state === 'assisted' && item.detailsOpen) d.open = true;
      d.addEventListener('toggle', () => { item.detailsOpen = d.open; });
      const words = item.summary.columns.map((x) => (Candidate.LABELS[x.dim] || x.header).toLowerCase()).join(', ');
      d.append(el('summary', null, `The measurements: ${words}, in ${item.summary.unit === 'in' ? 'inches' : 'centimetres'}`), valuesTable(item.summary));
      card.push(d);
    }
    if ((state === 'automatic' || state === 'assisted') && (!item.type || item.typeFrom === 'shopper')) card.push(typeChooser());
    else if (item.type && (state === 'automatic' || state === 'assisted')) card.push(el('p', 'ffr-hint ffi-kind', `Kind: ${TYPE_WORDS[item.type].toLowerCase()} — ${item.typeFrom === 'name' ? 'from its name' : 'from Fynd’s record'}.`));
    if (state === 'assisted') {
      const label = el('label', 'fp-check ffi-confirm');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.id = 'ffi-confirm';
      cb.checked = item.checked;
      cb.addEventListener('change', () => { item.checked = cb.checked; metrics.manualInput('ffi-confirm'); changed('shopper'); });
      label.append(cb, doc.createTextNode(' These match the size chart on the product page'));
      card.push(label);
    }
    if (['unavailable', 'body-only', 'incomplete'].includes(state)) card.push(ways());
    box.replaceChildren(...card.filter(Boolean));
  }

  function reset(by) { ask += 1; item = null; set('none', by); }

  /* ---------- the lookup ---------- */
  const URLISH = /^https?:\/\/[^\s]+\.[^\s]+/i;
  async function lookUp() {
    const url = linkInput.value.trim();
    const err = $('ffi-link-error');
    err.textContent = '';
    err.classList.remove('show');
    if (!URLISH.test(url)) {
      err.textContent = 'Paste the product page’s full address, starting https://';
      err.classList.add('show');
      linkInput.setAttribute('aria-invalid', 'true');
      linkInput.focus();
      return;
    }
    linkInput.removeAttribute('aria-invalid');
    metrics.event('candidate_started');
    const mine = ++ask;
    item = null;
    set('loading', 'shopper');
    const sizing = global.Account && global.Account.sizing;
    const got = sizing ? await sizing.chart(url) : null;
    if (mine !== ask) return;
    const c = got && got.ok && got.data && got.data.chart;
    if (!c || typeof c !== 'object') { set('error', 'shopper'); metrics.event('extraction_unavailable'); return; }
    item = fromAnswer(c, url);
    metrics.event({ automatic: 'extraction_automatic', assisted: 'extraction_assisted', 'body-only': 'extraction_body_only' }[item.state] || 'extraction_unavailable');
    if (item.state === 'automatic' || item.state === 'assisted') metrics.event('candidate_ready_link');
    set(item.state, 'shopper');
  }
  go.addEventListener('click', lookUp);
  linkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookUp(); } });
  linkInput.addEventListener('input', () => { metrics.manualInput('ffi-link'); if (state !== 'none' && state !== 'loading') reset('shopper'); });
  linkInput.addEventListener('paste', () => global.setTimeout(() => { if (URLISH.test(linkInput.value.trim())) lookUp(); }, 0));

  /* the unit strip: only while something is typed by hand (here, or the garment's measurements) */
  const strip = $('ff-units-strip');
  function syncStrip() {
    if (!strip) return;
    strip.hidden = !((manual && manual.open) || Boolean(doc.querySelector('#ffr-manual[open]')));
  }
  doc.addEventListener('toggle', (e) => {
    if (!e.target) return;
    if (e.target.id === 'ffr-manual') syncStrip();
    /* the item's own hand entry opened or closed: which item is compared changes */
    if (e.target.id === 'ff-manual') { syncStrip(); changed('shopper'); }
  }, true);
  syncStrip();

  const ready = () => {
    if (manual && manual.open) return false;
    if (!item || !item.type) return false;
    return item.state === 'automatic' || (item.state === 'assisted' && item.checked);
  };
  global.FindFitItem = {
    state: () => (manual && manual.open ? 'manual' : state),
    ready,
    automatic: () => Boolean(item && item.state === 'automatic'),
    source: () => (item ? item.source : null),
    type: () => (item ? item.type : null),
    product: () => (item ? item.product : null),
    sizes: () => (item ? item.sizes : []),
    lookUp,
    syncStrip
  };
})(typeof window !== 'undefined' ? window : globalThis);
