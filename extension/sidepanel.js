/* =========================================================
   Fynd extension — the Fit panel

   One product beside one garment the shopper already owns, compared by
   Fynd's own engine on Fynd's server. The panel reads and asks; it never
   compares, ranks or recommends.

     1  product     a press on Fynd's toolbar button opens this panel
                    (background.js) and lets it read that tab once
                    (activeTab). collect.js reads the page; extract.js
                    says what the product is and where each part came
                    from. The shopper confirms or corrects it.
     2  measure     the size tables on the page, each said to measure the
                    finished garment, the body, or not stated
                    (vendor/sizing-tables.js — the server's own labelling).
                    A body chart is never offered as the garment's. With
                    no chart, the measurements can be entered by hand.
     3  review      every value the chart gave, editable, with how the
                    chart measures each (the canonical methods; "the chart
                    doesn't say" is never compared), the unit, and — for a
                    chart that doesn't say what it measures — the
                    shopper's own confirmation that it is the garment.
     4  reference   the garments saved on the shopper's Fynd fit profile
                    (GET /api/fit-profile, with their own session). Not
                    signed in, none saved, or Fynd unreachable: said so,
                    with what to do — never a garment made up.
     5  results     one request for every size (api.js compareChart): the
                    server's comparison and decision, drawn as they are —
                    a recommended size only when the decision is OK, the
                    closest only when it is NO_MATCH, and for
                    INSUFFICIENT_DATA the reasons, measurement by
                    measurement.

   Nothing is stored in the extension: no garments, no measurements, no
   browsing. The tab Fynd was pressed on is kept in session memory only
   (background.js), so the panel can read it as it opens.

   For tests only, ?tab=<id> names the tab to read (it reaches nothing
   the extension isn't already allowed to read).
   ========================================================= */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const X = window.FyndExtract;
  const API = window.FyndApi;
  const SITE = String(typeof FYND_SITE !== 'undefined' ? FYND_SITE : '').replace(/\/$/, ''); // config.js: a global binding, not a window property
  const fixedTab = Number(new URLSearchParams(location.search).get('tab')) || null;

  const state = {
    view: 'start',
    reading: 0,
    tab: null,
    raw: null,
    product: null,
    type: null,
    charts: null,
    chartIndex: null,
    review: null,
    garments: null,
    referenceType: null,
    comparing: false,
    result: null,
    lastProblem: null,
    /* how the review in hand was read: 'deterministic', 'ai', 'ai-insufficient', 'ai-unavailable', 'skipped', 'manual' */
    path: null,
    aiProblem: null,
    interpreting: 0
  };

  /* ---------- how much work this took (anonymous counters, api.js metrics) ---------- */
  const touched = new Set();
  let openedAt = Date.now();
  const track = (...names) => { if (API.metrics) API.metrics(names.map((n) => (typeof n === 'string' ? { name: n } : n))); };
  ['v-product', 'v-review', 'v-reference', 'v-measure'].forEach((id) => {
    const view = document.getElementById(id);
    if (!view) return;
    const count = (e) => { const t = e.target; if (e.isTrusted && t && t.matches && t.matches('input, select, textarea')) touched.add(`${id}:${t.id || t.name || (t.dataset && `${t.dataset.role}-${t.dataset.row}-${t.dataset.col}`)}`); };
    view.addEventListener('input', count);
    view.addEventListener('change', count);
  });

  /* ---------- small helpers ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  const VIEWS = ['start', 'reading', 'problem', 'product', 'measure', 'interpreting', 'review', 'reference', 'comparing', 'results', 'error'];
  const STEP_OF = { product: 'product', measure: 'measure', interpreting: 'measure', review: 'measure', reference: 'reference', comparing: 'results', results: 'results', error: 'results' };
  const ORDER = ['product', 'measure', 'reference', 'results'];
  function show(view) {
    state.view = view;
    document.body.dataset.view = view;
    VIEWS.forEach((v) => { const n = $(`v-${v}`); if (n) n.hidden = v !== view; });
    const step = STEP_OF[view] || null;
    document.querySelectorAll('#steps li').forEach((li) => {
      if (li.dataset.step === step) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      li.dataset.done = String(Boolean(step) && ORDER.indexOf(li.dataset.step) < ORDER.indexOf(step));
    });
  }
  const safeHost = (u) => { try { return new URL(u).host; } catch (err) { return null; } };
  function note(step, err, extra) {
    const entry = { at: new Date().toISOString(), step, message: String(err && err.message || err || ''), extra: extra || null };
    console.warn('[Fynd]', step, entry.message, extra || '');
    return entry;
  }

  /* ---------- 1. reading the page ---------- */
  function classify(err, tab) {
    const m = String(err && err.message || err || '');
    if (/showing error page/i.test(m)) return 'error-page';
    if (/No tab with id|tab was closed/i.test(m)) return 'gone';
    if (/Cannot access a chrome|chrome:\/\/|extensions gallery|cannot be scripted|Cannot access contents of url "(?:chrome|edge|about|devtools|view-source|chrome-extension)/i.test(m)) return 'restricted';
    if (/Cannot access contents of|Missing host permission|must request permission|permission to access/i.test(m)) return 'no-access';
    if (tab && tab.url && !/^https?:/i.test(tab.url)) return 'restricted';
    return 'unknown';
  }
  const PROBLEMS = {
    'no-access': ['Click Fynd to read this page', 'Click the Fynd button in Chrome’s toolbar while this page is open. Chrome only lets Fynd read a page you choose, and a click on another page doesn’t count for this one.'],
    restricted: ['Chrome doesn’t let extensions read this page', 'Pages like Chrome’s settings, the Web Store and PDFs can’t be read by any extension. Open a clothing product page on a shop’s site.'],
    'error-page': ['This page didn’t load', 'The tab is showing an error page. Reload it, then click Fynd again.'],
    gone: ['That tab is closed', 'Open a clothing product page and click Fynd.'],
    'no-tab': ['No page to read', 'Open a clothing product page in this window and click Fynd.'],
    unknown: ['Fynd couldn’t read this page', 'Reload the page and click Fynd again. If it keeps happening, the technical details say what Chrome reported.'],
    'empty-result': ['Fynd couldn’t read this page', 'The page didn’t answer. It may still be loading: wait a moment and read it again.'],
    'no-product': ['No product found on this page', 'Fynd couldn’t find a product here — its name, brand or sizes. Open the product’s own page, or enter the product by hand.']
  };
  function problem(kind, entry) {
    const [title, text] = PROBLEMS[kind] || PROBLEMS.unknown;
    $('problem-title').textContent = title;
    $('problem-text').textContent = text;
    $('problem-manual').hidden = kind !== 'no-product';
    $('problem-details').hidden = !entry;
    $('problem-diag').textContent = entry ? JSON.stringify(entry, null, 2) : '';
    state.lastProblem = kind;
    show('problem');
  }
  async function targetTab(tabId) {
    const id = fixedTab || tabId;
    if (id) return chrome.tabs.get(id);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }
  async function read(opts) {
    const o = opts || {};
    const ticket = ++state.reading;
    if (o.how !== 'retry') { touched.clear(); openedAt = Date.now(); track('session_start', 'candidate_started'); }
    show('reading');
    let tab = null;
    try { tab = await targetTab(o.tabId); } catch (err) { note('find the tab', err); }
    if (ticket !== state.reading) return;
    if (!tab) { problem('no-tab'); return; }
    let results = null;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fyndCollect });
    } catch (err) {
      if (ticket !== state.reading) return;
      const kind = classify(err, tab);
      problem(kind, note('read the page', err, { kind, host: tab.url ? safeHost(tab.url) : 'hidden by Chrome until Fynd is clicked' }));
      return;
    }
    if (ticket !== state.reading) return;
    const raw = results && results[0] && results[0].result;
    if (!raw || typeof raw !== 'object') { problem('empty-result', note('read the page', 'the page returned nothing', { host: safeHost(tab.url) })); return; }
    state.tab = tab;
    state.raw = raw;
    const before = state.product;
    state.product = X.detectProduct(raw);
    /* another product: nothing chosen for the last one carries over (the same one, read again, keeps its kind) */
    if (!before || before.url !== state.product.url || before.name !== state.product.name) { state.type = null; state.referenceType = null; }
    state.review = null;
    state.chartIndex = null;
    state.path = null;
    state.aiProblem = null;
    state.aiBase = null;
    state.interpreting += 1;
    state.charts = X.charts(raw);
    state.result = null;
    if (!state.product.found) { problem('no-product'); return; }
    drawProduct();
  }

  /* ---------- 2. the product, to confirm ---------- */
  const FROM_WORDS = { 'json-ld': 'the page’s product data', meta: 'the page’s description tags', heading: 'the page’s heading', page: 'the page’s size picker' };
  function drawProduct() {
    const p = state.product;
    $('p-name').value = p.name || '';
    $('p-brand').value = p.brand || '';
    state.type = state.type || p.type;
    $('p-type').value = state.type || '';
    $('p-type-note').textContent = p.type ? 'Suggested from the product’s name — change it if it’s wrong.' : 'Fynd couldn’t tell from the product’s name: choose one.';
    const list = $('p-sizes');
    list.replaceChildren(...p.sizes.map((s) => {
      const li = el('li', null, s.size);
      li.dataset.available = s.available === false ? 'false' : s.available === true ? 'true' : 'unknown';
      if (s.available === false) li.title = 'Not on offer on the page';
      return li;
    }));
    const found = [];
    if (p.from.name) found.push(`name from ${FROM_WORDS[p.from.name] || p.from.name}`);
    if (p.from.brand) found.push(`brand from ${FROM_WORDS[p.from.brand] || p.from.brand}`);
    if (p.from.sizes) found.push(`sizes from ${FROM_WORDS[p.from.sizes] || p.from.sizes}`);
    const missing = p.missing.map((m) => ({ name: 'its name', brand: 'its brand', sizes: 'its sizes' }[m]));
    $('product-found').textContent = `Read ${found.join(', ') || 'from the page'}.${missing.length ? ` Not found on the page: ${missing.join(', ')}.` : ''}`;
    const meta = [p.color ? `Colour: ${p.color}` : null, p.code ? `Code: ${p.code}` : null, p.url ? `Page: ${safeHost(p.url)}` : null].filter(Boolean);
    $('p-meta').textContent = meta.join(' · ');
    $('product-error').textContent = '';
    show('product');
  }
  function confirmProduct(event) {
    event.preventDefault();
    const type = $('p-type').value;
    const name = $('p-name').value.trim();
    if (!type) { $('product-error').textContent = 'Choose what kind of garment this is: Fynd compares hoodies, sweatshirts and T-shirts.'; $('p-type').focus(); return; }
    state.type = type;
    state.product = Object.assign({}, state.product, { name: name || null, brand: $('p-brand').value.trim() || null });
    drawCharts();
  }

  /* ---------- 3. the size charts on the page ---------- */
  const KIND_WORDS = { 'finished-garment': 'Garment measurements', body: 'Body measurements', 'not-stated': 'Doesn’t say' };
  function drawCharts() {
    const list = state.charts ? state.charts.list : [];
    const unread = state.charts && state.charts.unread ? state.charts.unread : [];
    const box = $('charts');
    box.replaceChildren();
    /* where this retailer keeps its garment chart, if Fynd knows (retailers.js) */
    const known = state.tab && state.tab.url && window.FyndRetailers ? window.FyndRetailers.match(state.tab.url) : null;
    const hint = known && known.retailer && known.retailer.chartHint ? ` ${known.retailer.chartHint}` : '';
    if (!list.length && !unread.length) {
      track('extraction_unavailable');
      $('measure-text').textContent = `No size chart found on this page.${hint || ' If the shop keeps its chart in a size guide, open the guide on the page and read it again.'} Or enter the measurements by hand from the chart.`;
      $('use-chart').hidden = true;
      show('measure');
      return;
    }
    const usable = list.filter((c) => c.measures !== 'body');
    if (!usable.length && !unread.length) track('extraction_body_only');
    $('measure-text').textContent = usable.length
      ? (list.length + unread.length > 1 ? 'Fynd found more than one table. Choose the one with the garment’s own measurements.' : 'Fynd found this table on the page.')
      : unread.length
        ? 'Fynd found a table that looks like a size chart, but couldn’t read its headings on its own. It can ask its AI to suggest how to read it, for you to check.'
        : 'This page’s chart measures the body each size is for, not the garment, so Fynd can’t compare it with your garment. If the shop also has product (garment) measurements, open them on the page and read it again — or enter them by hand.';
    $('use-chart').hidden = !usable.length && !unread.length;
    const preferred = list.find((c) => c.measures === 'finished-garment') || usable[0] || null;
    list.forEach((c) => {
      const li = el('li');
      const label = el('label', 'fp-option');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'chart';
      radio.value = String(c.index);
      radio.disabled = c.measures === 'body';
      radio.checked = preferred === c;
      if (radio.disabled) label.dataset.disabled = 'true';
      const head = el('span', 'fp-option-head');
      const kind = el('span', 'fp-kind', KIND_WORDS[c.measures]);
      kind.dataset.kind = c.measures;
      head.append(radio, el('span', null, c.title || c.tab || `Table ${c.index + 1}`), kind);
      const detail = el('span', 'fp-option-detail', `${c.rows.length} sizes · ${c.columns.join(', ')} · ${c.unit === 'in' ? 'inches' : c.unit === 'cm' ? 'centimetres' : c.unit === 'both' ? 'inches and centimetres' : 'unit not stated'}${c.inDialog ? ' · in the open size guide' : ''}`);
      label.append(head, detail);
      if (c.measures === 'body') label.append(el('span', 'fp-option-detail', 'Body sizes — who each size is made for — can’t be compared with a garment.'));
      li.append(label);
      box.append(li);
    });
    /* tables shaped like a size chart that the deterministic reading couldn't label */
    unread.forEach((u, i) => {
      const li = el('li');
      const label = el('label', 'fp-option');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'chart';
      radio.value = `u${u.rawIndex}`;
      radio.checked = !preferred && i === 0;
      const head = el('span', 'fp-option-head');
      const kind = el('span', 'fp-kind', 'Not read automatically');
      kind.dataset.kind = 'unread';
      head.append(radio, el('span', null, u.title || `Table ${u.rawIndex + 1}`), kind);
      label.append(head, el('span', 'fp-option-detail', `${u.sizes} sizes · ${u.columns.join(', ')}${u.inDialog ? ' · in the open size guide' : ''} · Fynd can ask its AI how to read it`));
      li.append(label);
      box.append(li);
    });
    show('measure');
  }
  function useChart() {
    const picked = document.querySelector('input[name="chart"]:checked');
    if (!picked) return;
    const tables = (state.raw && state.raw.tables) || [];
    if (picked.value.startsWith('u')) {
      /* a table only the AI-assisted reading can try */
      const rawTable = tables[Number(picked.value.slice(1))];
      state.chartIndex = null;
      if (rawTable) interpret(rawTable, null, ['unread']);
      return;
    }
    const chart = state.charts.list[Number(picked.value)];
    if (!chart || chart.measures === 'body') return;
    state.chartIndex = chart.index;
    const review = X.startReview(chart, state.product, tables[chart.rawIndex]);
    /* the fast path: Fynd's own reading, when it is enough — no model is asked */
    const needs = X.interpretationNeeds(review, tables[chart.rawIndex]);
    if (needs.length && tables[chart.rawIndex]) { interpret(tables[chart.rawIndex], review, needs); return; }
    state.review = review;
    state.path = 'deterministic';
    state.aiProblem = null;
    track(X.isAutomatic(review) ? 'extraction_automatic' : 'extraction_assisted');
    drawReview();
  }
  function manualEntry() {
    state.chartIndex = null;
    state.path = 'manual';
    state.aiProblem = null;
    state.review = X.emptyReview(state.product);
    if (!state.review.rows.length) state.review.rows.push({ size: '', available: null, cells: Object.fromEntries(state.review.columns.map((c) => [c.index, { raw: '', value: null, problem: 'empty', corrected: false }])) });
    drawReview();
  }

  /* ---------- 3b. the AI-assisted reading, on Fynd's server ---------- */
  const NEED_WORDS = {
    unread: 'its headings aren’t ones Fynd knows',
    'heading-rows': 'its headings run over more than one row',
    column: 'a column’s heading isn’t one Fynd can name',
    method: 'how some measurements are taken is written outside the headings',
    unit: 'its unit isn’t stated where Fynd looks'
  };
  function aiProblemWords(p) {
    if (!p) return 'The AI reading didn’t answer.';
    const why = {
      'sign-in': 'Sign in to Fynd to use its AI chart reading.',
      'rate-limited': p.reason === 'over-limit' ? 'You’ve used your plan’s AI allowance for now.' : 'Too many chart readings just now — try again in a few minutes.',
      'too-large': 'This table is too large for the AI reading.',
      unsupported: 'Fynd’s AI reading can’t make out this table’s layout.',
      unavailable: p.reason === 'ai-rate-limited' ? 'The AI reading is busy right now.' : 'The AI reading isn’t available right now.',
      timeout: 'The AI reading took too long.',
      offline: 'Fynd couldn’t be reached.',
      invalid: 'Fynd couldn’t send this table.',
      server: p.reason === 'ai-invalid-response' ? 'The AI’s answer didn’t follow Fynd’s rules, so Fynd ignored it.' : 'The AI reading failed.'
    };
    return why[p.kind] || 'The AI reading failed.';
  }
  /* base: Fynd's own reading of the chart (kept on any failure), or null for a table it couldn't read */
  async function interpret(rawTable, base, needs) {
    const ticket = ++state.interpreting;
    state.aiBase = base;
    $('interpreting-text').textContent = `Fynd read what it could, but ${needs.map((n) => NEED_WORDS[n] || n).join(', and ')}. Asking Fynd’s AI to suggest how to read it…`;
    show('interpreting');
    const got = await API.interpretChart(X.aiRequest(rawTable, state.type));
    if (ticket !== state.interpreting) return;
    if (got.ok && got.data && (got.data.status === 'proposed' || (got.data.status === 'insufficient-evidence' && (got.data.rows || []).length))) {
      track('extraction_ai_assisted');
      state.review = X.reviewFromInterpretation(got.data, state.product);
      state.path = got.data.status === 'proposed' ? 'ai' : 'ai-insufficient';
      state.aiProblem = null;
      drawReview();
      return;
    }
    if (got.ok && got.data && got.data.status === 'body-chart') {
      /* the page's own words say body measurements: never compared, whatever anyone suggests */
      drawCharts();
      $('measure-text').textContent = 'This table gives body measurements — who each size is made for — not the garment’s own, so Fynd can’t compare it with your garment. Open the garment measurements on the page and read it again, or enter them by hand.';
      return;
    }
    track(state.aiBase ? 'extraction_assisted' : 'extraction_unavailable');
    /* any failure: Fynd's own reading is kept, for the shopper to correct — never a made-up one */
    state.aiProblem = got.ok ? { kind: 'unsupported', reason: got.data && got.data.status } : got.problem;
    keepOwnReading('ai-unavailable');
  }
  function keepOwnReading(path) {
    state.path = path;
    if (state.aiBase) {
      state.review = state.aiBase;
      /* what made Fynd ask is still unresolved: the shopper checks it */
      const why = 'Fynd couldn’t read part of this chart reliably on its own: check every column, method and the unit against the chart.';
      if (!state.review.checks.includes(why)) state.review.checks.unshift(why);
    }
    else { state.review = X.emptyReview(state.product); if (!state.review.rows.length) state.review.rows.push({ size: '', available: null, cells: Object.fromEntries(state.review.columns.map((c) => [c.index, { raw: '', value: null, problem: 'empty', corrected: false }])) }); }
    drawReview();
  }

  /* ---------- 4. review and correct ---------- */
  const METHOD_CHOICES = {
    chestWidth: [['flat-width-armpit-to-armpit', 'Flat, armpit to armpit'], ['garment-circumference', 'All the way around'], ['not-stated', 'The chart doesn’t say']],
    shoulderWidth: [['seam-to-seam', 'Seam to seam'], ['broadest-part-of-shoulders', 'Broadest part of the shoulders'], ['not-stated', 'The chart doesn’t say']],
    bodyLength: [['high-point-shoulder-to-hem', 'Top of the shoulder to hem'], ['center-back-to-hem', 'Centre back of the neck to hem'], ['not-stated', 'The chart doesn’t say']],
    sleeveLength: [['shoulder-seam-to-cuff', 'Shoulder seam to cuff'], ['center-back-to-cuff', 'Centre back of the neck to cuff'], ['not-stated', 'The chart doesn’t say']]
  };
  function select(options, value, label) {
    const s = el('select');
    s.setAttribute('aria-label', label);
    options.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; if (v === value) o.selected = true; s.append(o); });
    return s;
  }
  function drawReview() {
    const r = state.review;
    const manual = r.source === 'shopper';
    $('review-title').textContent = manual ? 'Enter the measurements' : 'Check the measurements';
    $('review-text').textContent = manual
      ? 'Enter each size’s finished-garment measurements from the product’s chart — not body sizes — and how the chart measures each. Leave blank any it doesn’t give.'
      : 'Fynd read these from the page. Correct anything it got wrong, and say how the chart measures each one: Fynd compares only measurements taken the same way as your garment’s.';
    $('review-kind').textContent = manual ? '' : r.measures === 'finished-garment' && r.nearbyMeasures
      ? 'Text near this table says it gives the garment’s own measurements; the chart itself doesn’t say.'
      : r.measures === 'finished-garment'
        ? 'The page says this table measures the garment itself.'
        : 'The page doesn’t say whether this table measures the garment or the body.';
    drawPath(r);
    $('review-confirm-row').hidden = r.measures === 'finished-garment' && !r.nearbyMeasures;
    $('review-confirm').checked = r.measuresConfirmed;
    $('review-unit').value = r.unit || '';
    const table = $('review-table');
    const head = el('tr');
    head.append(el('th', null, 'Size'));
    r.columns.forEach((c) => {
      const th = el('th');
      const box = el('div', 'fp-col-head');
      const dimChoices = [['', 'Not compared']].concat(X.DIMS.map((d) => [d, X.LABELS[d]]));
      const dimSel = select(dimChoices, c.dim || '', `What the “${c.header}” column measures`);
      dimSel.dataset.col = String(c.index);
      dimSel.dataset.role = 'dim';
      box.append(el('span', null, c.header), dimSel);
      if (c.dim) {
        const how = select([['', 'How is it measured?']].concat(METHOD_CHOICES[c.dim]), c.method || '', `How the chart measures the ${X.LABELS[c.dim].toLowerCase()}`);
        how.dataset.col = String(c.index);
        how.dataset.role = 'method';
        box.append(how);
      }
      if (c.said) box.append(el('span', 'fp-col-said', `The page says: ${c.said}`));
      if (c.nearby) { const n = el('span', 'fp-col-ai', 'Method from text near the table — check it'); n.dataset.status = 'unresolved'; box.append(n); }
      if (c.ai) {
        const note = el('span', 'fp-col-ai', c.ai.status === 'proposed'
          ? (c.ai.basis === 'ai-reading' ? 'Suggested by AI' : c.ai.evidence && c.ai.evidence.method ? 'Method found by AI' : 'Read from the heading')
          : c.ai.status === 'unresolved' ? `Not resolved: ${c.ai.reasons[0] || 'choose it yourself'}` : 'Not a measurement Fynd compares');
        note.dataset.status = c.ai.status;
        box.append(note);
      }
      th.append(box);
      head.append(th);
    });
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    r.rows.forEach((row, ri) => {
      const tr = el('tr');
      const th = el('th');
      if (manual) {
        const size = el('input');
        size.value = row.size;
        size.dataset.row = String(ri);
        size.dataset.role = 'size';
        size.setAttribute('aria-label', 'Size');
        th.append(size);
      } else th.textContent = row.size;
      tr.append(th);
      r.columns.forEach((c) => {
        const cell = row.cells[c.index];
        const td = el('td');
        const input = el('input');
        input.inputMode = 'decimal';
        input.value = typeof cell.value === 'number' ? String(cell.value) : cell.raw;
        input.dataset.row = String(ri);
        input.dataset.col = String(c.index);
        input.dataset.role = 'value';
        input.setAttribute('aria-label', `Size ${row.size || ri + 1}, ${c.header}`);
        if (cell.problem && cell.problem !== 'empty') input.dataset.problem = cell.problem;
        if (cell.corrected) input.dataset.corrected = 'true';
        if (cell.raw && typeof cell.value !== 'number') input.title = `The page says “${cell.raw}”, which isn’t a single number`;
        td.append(input);
        tr.append(td);
      });
      tbody.append(tr);
    });
    if (manual) {
      const tr = el('tr');
      const td = el('td');
      td.colSpan = r.columns.length + 1;
      const add = el('button', 'link-button', 'Add a size');
      add.type = 'button';
      add.id = 'review-add-size';
      td.append(add);
      tr.append(td);
      tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
    drawReviewProblems();
    show('review');
  }
  /* how this reading was made, and — for the AI-assisted one — each suggestion, its evidence, and what stays open */
  const PATH_WORDS = {
    deterministic: 'Read automatically from the page.',
    ai: 'Fynd’s AI suggested how to read this chart. Every value below is the page’s own; check each suggestion against the chart, then confirm.',
    'ai-insufficient': 'Fynd’s AI couldn’t find enough on the page to read this chart (no chest measurement it could show). Map the columns yourself, or enter the measurements by hand.',
    skipped: 'Fynd’s own reading, without the AI. Check and correct it.',
    manual: ''
  };
  function drawPath(r) {
    const path = state.path || (r.source === 'shopper' ? 'manual' : 'deterministic');
    const p = $('review-path');
    p.dataset.path = path;
    p.textContent = path === 'ai-unavailable'
      ? `${aiProblemWords(state.aiProblem)} Fynd kept its own reading${state.aiBase ? '' : ' — enter the measurements by hand'}; check and correct it.`
      : path === 'deterministic' && r.checks && r.checks.length
        ? 'Read from the page — but part of it is uncertain: check it below.'
        : (PATH_WORDS[path] || '');
    const ai = r.interpretedBy === 'ai';
    const items = [];
    const notes = (r.notes || []).slice();
    if (ai) {
      const label = (c) => (c.dim ? `${X.LABELS[c.dim]}${c.method ? `, ${(METHOD_CHOICES[c.dim].find(([v]) => v === c.method) || [null, c.method])[1].toLowerCase()}` : ''}` : 'not mapped');
      r.columns.filter((c) => c.ai && c.ai.status !== 'not-a-measurement').forEach((c) => {
        const quotes = [c.ai.evidence.header, c.ai.evidence.method].filter(Boolean).map((e) => `“${e.text}”`);
        items.push(`“${c.header}” → ${label(c)}${quotes.length ? ` (the page says ${quotes.join(' and ')})` : ''}`);
        if (c.ai.suggestion) notes.push(`“${c.header}”: text near the table says “${c.ai.suggestion.text}”. Choose that method yourself only if it applies to this chart.`);
      });
      if (r.ai.unit && r.ai.unit.status === 'conflicting') notes.push('The page gives more than one unit: choose the right one, or correct the values.');
      if (r.ai.unit && r.ai.unit.status === 'missing') notes.push('The chart doesn’t state its unit: choose it.');
      if (r.ai.unit && r.ai.unit.suggestion) notes.push(`Text near the table says “${r.ai.unit.suggestion.text}”. Choose that unit only if it applies to this chart.`);
      if (r.ai.aiSuggestsMeasures) notes.push('These may be the garment’s own measurements, but the chart doesn’t say so: confirm it below only if you’re sure.');
      r.columns.filter((c) => c.ai && c.ai.status === 'unresolved').forEach((c) => notes.push(`“${c.header}”: ${c.ai.reasons.join(' ')}`));
      r.ai.ambiguities.forEach((a) => notes.push(`The AI noted: ${a}`));
      if (r.ai.ignoredText) notes.push(r.ai.ignoredText);
    } else (r.checks || []).forEach((t) => items.push(t));
    const box = $('review-check');
    box.hidden = !ai && !items.length && !notes.length;
    $('review-check-title').textContent = ai ? 'Fynd’s AI suggests:' : items.length ? 'Check before going on:' : '';
    $('review-check-list').replaceChildren(...items.map((t) => el('li', null, t)));
    $('review-check-notes').replaceChildren(...notes.map((t) => el('li', null, t)));
    $('review-check-confirm-row').hidden = !ai && !items.length;
    $('review-check-confirm-text').textContent = ai ? 'I’ve checked these suggestions against the chart on the page' : 'I’ve checked these against the chart on the page';
    $('review-check-confirm').checked = Boolean(r.checked);
  }
  function drawReviewProblems() {
    const problems = X.reviewProblems(state.review, state.type);
    $('review-problems').replaceChildren(...problems.map((t) => el('li', null, t)));
    $('to-reference').disabled = problems.length > 0;
    return problems;
  }
  function onReviewChange(event) {
    const t = event.target;
    const r = state.review;
    if (!t || !r) return;
    if (t.id === 'review-unit') { r.unit = t.value || null; drawReviewProblems(); return; }
    if (t.id === 'review-confirm') { r.measuresConfirmed = t.checked; drawReviewProblems(); return; }
    if (t.id === 'review-check-confirm') { r.checked = t.checked; drawReviewProblems(); return; }
    const col = r.columns.find((c) => String(c.index) === t.dataset.col);
    if (t.dataset.role === 'dim' && col) {
      const dim = t.value || null;
      /* one column per measurement: a measurement moved here leaves the column it was in */
      if (dim) r.columns.forEach((c) => { if (c !== col && c.dim === dim) { c.dim = null; c.method = null; } });
      col.dim = dim;
      col.method = dim ? X.methodSaid(dim, `${col.header} ${col.said || ''}`) : null;
      drawReview();
      return;
    }
    if (t.dataset.role === 'method' && col) { col.method = t.value || null; drawReviewProblems(); return; }
    if (t.dataset.role === 'size') { r.rows[Number(t.dataset.row)].size = t.value.trim(); drawReviewProblems(); return; }
    if (t.dataset.role === 'value') {
      const cell = r.rows[Number(t.dataset.row)].cells[t.dataset.col];
      const parsed = X.parseValue(t.value);
      const was = cell.value;
      cell.value = parsed.value;
      cell.problem = t.value.trim() ? parsed.problem : 'empty';
      /* a value the shopper changed is theirs: marked, and sent as corrected */
      cell.corrected = r.source === 'shopper' ? false : (parsed.value !== was || Boolean(cell.corrected));
      if (r.source !== 'shopper') t.dataset.corrected = String(cell.corrected);
      if (cell.problem && cell.problem !== 'empty') t.dataset.problem = cell.problem; else delete t.dataset.problem;
      drawReviewProblems();
    }
  }

  /* ---------- 5. a garment from the Fynd profile ---------- */
  const TYPE_WORDS = { hoodies: 'Hoodie', sweatshirts: 'Sweatshirt', tshirts: 'T-shirt' };
  /* the engine's own families (api/_sizing/engine.js FAMILY; test-extension holds them equal) — a hint only: the server decides */
  const FAMILY = { hoodies: 'fleece', sweatshirts: 'fleece', tshirts: 'tees' };
  function link(text, path) {
    const a = el('a', null, text);
    a.href = `${SITE}${path}`;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }
  function referenceMessage(text, links, retry) {
    $('reference-text').textContent = text;
    $('references').replaceChildren();
    $('compare').hidden = true;
    $('reference-retry').hidden = !retry;
    $('reference-links').replaceChildren(...links);
  }
  async function loadGarments() {
    show('reference');
    $('reference-text').textContent = 'Loading the garments saved on your Fynd fit profile…';
    $('references').replaceChildren();
    $('compare').hidden = true;
    $('reference-retry').hidden = true;
    $('reference-links').replaceChildren();
    const got = await API.savedGarments();
    if (!got.ok) {
      const k = got.problem.kind;
      if (k === 'sign-in') return referenceMessage('Sign in to Fynd in this browser to use the garments saved on your fit profile, then try again.', [link('Sign in on Fynd', '/account.html')], true);
      if (k === 'rate-limited') return referenceMessage(`Fynd is busy with too many requests from here. Try again${got.problem.retryAfter ? ` in ${Math.ceil(got.problem.retryAfter / 60)} min` : ' in a few minutes'}.`, [], true);
      if (k === 'timeout') return referenceMessage('Fynd didn’t answer in time. Check your connection and try again.', [], true);
      if (k === 'offline') return referenceMessage('Fynd couldn’t be reached. Check your connection and try again.', [], true);
      return referenceMessage('Fynd couldn’t load your fit profile just now. Try again in a moment.', [], true);
    }
    const garments = (got.data.profile && got.data.profile.garments) || {};
    const kinds = Object.keys(TYPE_WORDS).filter((k) => garments[k] && garments[k].anchor);
    state.garments = garments;
    if (!kinds.length) return referenceMessage('Your fit profile has no saved garment yet. Add one you own — with its measurements — on Fynd, then try again.', [link('Add a garment on Fynd', '/fit-profile.html')], true);
    $('reference-text').textContent = 'Fynd compares every size with the garment you choose.';
    const box = $('references');
    const preferred = kinds.find((k) => k === state.type) || kinds.find((k) => FAMILY[k] === FAMILY[state.type]) || null;
    kinds.forEach((k) => {
      const a = garments[k].anchor;
      const m = a.measurements;
      const li = el('li');
      const label = el('label', 'fp-option');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'reference';
      radio.value = k;
      radio.checked = k === (state.referenceType || preferred);
      const head = el('span', 'fp-option-head');
      head.append(radio, el('span', null, `${[a.brand, TYPE_WORDS[k].toLowerCase()].filter(Boolean).join(' ')}${a.size ? `, size ${a.size}` : ''}`));
      const parts = m ? X.DIMS.filter((d) => typeof m[d] === 'number').map((d) => `${X.LABELS[d]} ${m[d]} ${m.unit}`) : [];
      label.append(head, el('span', 'fp-option-detail', parts.length ? `Measured: ${parts.join(' · ')}` : (a.product ? 'Its product’s published measurements, if Fynd holds them checked' : 'No measurements saved — Fynd compares measurements, not size labels')));
      if (FAMILY[k] !== FAMILY[state.type]) label.append(el('span', 'fp-option-detail', 'A different kind of garment from this product: Fynd may not be able to compare them.'));
      li.append(label);
      box.append(li);
    });
    $('compare').hidden = false;
    $('reference-links').replaceChildren(link('Edit your garments on Fynd', '/fit-profile.html'));
  }

  /* ---------- 6. the comparison: one request, every size ---------- */
  async function compare() {
    if (state.comparing) return;
    const picked = document.querySelector('input[name="reference"]:checked');
    if (!picked) { $('reference-text').textContent = 'Choose one of your garments to compare with.'; return; }
    state.referenceType = picked.value;
    const chart = X.buildChart(state.review, state.product, state.type);
    state.comparing = true;
    track('candidate_ready', 'candidate_ready_extension', 'comparison_started', 'reference_ready', 'reference_ready_saved');
    $('comparing-text').textContent = `Comparing ${chart.sizes.length} size${chart.sizes.length === 1 ? '' : 's'} with your ${TYPE_WORDS[state.referenceType].toLowerCase()} on Fynd…`;
    show('comparing');
    let got;
    try { got = await API.compareChart(chart, state.referenceType); } finally { state.comparing = false; }
    if (!got.ok) { compareError(got.problem); track('result_error'); return; }
    state.result = got.data;
    drawResults(got.data);
    const outcome = got.data.decision && got.data.decision.outcome;
    track('comparison_completed', outcome === 'OK' ? 'result_ok' : outcome === 'NO_MATCH' ? 'result_no_match' : 'result_insufficient',
      { name: 'manual_inputs', value: touched.size }, { name: 'seconds_to_result', value: Math.round((Date.now() - openedAt) / 1000) });
    touched.clear();
    openedAt = Date.now();
  }
  function compareError(p) {
    const say = {
      'sign-in': ['Sign in to Fynd', 'Your Fynd sign-in has ended in this browser. Sign in on Fynd, then try again.'],
      'not-found': ['That garment isn’t on your profile', 'It may have been changed or removed on Fynd. Choose your garment again.'],
      'rate-limited': ['Too many comparisons just now', `Fynd limits how often it compares, to keep the service fair. Try again${p.retryAfter ? ` in ${Math.ceil(p.retryAfter / 60)} min` : ' in a few minutes'}.`],
      invalid: ['Fynd couldn’t read these measurements', 'Fix what it says below, then try again.'],
      timeout: ['Fynd didn’t answer in time', 'Nothing was compared. Check your connection and try again.'],
      offline: ['Fynd couldn’t be reached', 'Nothing was compared. Check your connection and try again.'],
      server: ['Fynd couldn’t compare just now', 'Nothing was compared. Try again in a moment.']
    }[p.kind] || ['Fynd couldn’t compare just now', 'Try again in a moment.'];
    $('error-title').textContent = say[0];
    $('error-text').textContent = say[1];
    const items = p.kind === 'invalid' ? (p.errors.length ? p.errors.map((e) => e.message) : [p.message]) : [];
    $('error-list').replaceChildren(...items.map((t) => el('li', null, t)));
    $('error-retry').textContent = p.kind === 'sign-in' || p.kind === 'not-found' ? 'Choose your garment again' : 'Try again';
    $('error-retry').dataset.kind = p.kind;
    show('error');
  }

  /* ---------- 7. the results, as the server decided them ---------- */
  function drawResults(data) {
    const d = data.decision || {};
    const c = data.comparison || {};
    const sizes = Array.isArray(c.sizes) ? c.sizes : [];
    const held = (s) => typeof s === 'string' && sizes.some((x) => x.size === s);
    const ok = d.outcome === 'OK' && held(d.size);
    const noMatch = d.outcome === 'NO_MATCH' && held(d.closest);
    $('result-title').textContent = ok ? 'The size that meets Fynd’s comparison criteria'
      : noMatch ? 'No size meets Fynd’s comparison criteria'
        : 'Fynd can’t compare these sizes reliably';
    $('result-size').hidden = !(ok || noMatch);
    $('result-size').textContent = ok ? d.size : noMatch ? `Closest: ${d.closest} — not a recommendation` : '';
    const messages = ok ? [c.summary].filter((t) => typeof t === 'string') : (Array.isArray(d.messages) && d.messages.length ? d.messages : ['Fynd doesn’t have enough comparable measurements to suggest a size.']);
    $('result-messages').replaceChildren(...messages.map((t) => el('p', null, t)));
    /* every size, as the engine set it beside the garment: never a pick the decision didn't make */
    const table = $('result-table');
    if (sizes.length) {
      const dims = Array.isArray(c.dimensionsCompared) ? c.dimensionsCompared : [];
      const cap = el('caption', null, `Each size beside your garment, in ${c.unit === 'cm' ? 'centimetres' : 'inches'}`);
      const head = el('tr');
      head.append(el('th', null, 'Size'), ...dims.map((dim) => el('th', null, X.LABELS[dim] || dim)), el('th', null, 'Compared'));
      const rows = sizes.map((s) => {
        const tr = el('tr');
        tr.dataset.size = s.size;
        if (ok && s.size === d.size) tr.dataset.pick = 'recommended';
        if (noMatch && s.size === d.closest) tr.dataset.pick = 'closest';
        tr.append(el('th', null, s.size));
        dims.forEach((dim) => {
          const x = s.dimensions && s.dimensions[dim];
          /* rounded first, so a difference under 0.05 reads 0, never −0 */
          const r = x && typeof x.difference === 'number' ? Math.round(x.difference * 10) / 10 : null;
          const words = x && x.compared && r !== null
            ? `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}${x.withinTolerance ? ' · similar' : ''}`
            : '—';
          tr.append(el('td', null, words));
        });
        tr.append(el('td', null, s.unranked ? 'Not ranked: a measurement is missing' : typeof s.rank === 'number' ? `#${s.rank}` : '—'));
        return tr;
      });
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      tbody.append(...rows);
      table.replaceChildren(cap, thead, tbody);
      table.hidden = false;
    } else { table.replaceChildren(); table.hidden = true; }
    $('result-dims').replaceChildren(...(Array.isArray(d.dimensions) ? d.dimensions : []).filter((x) => x && typeof x.message === 'string').map((x) => {
      const li = el('li', null, x.message);
      li.dataset.dim = x.dim;
      li.dataset.status = x.status;
      return li;
    }));
    $('result-reliability').textContent = ok && c.reliability ? `Reliability: ${c.reliability} — the item’s measurements are the ones you confirmed from the page; Fynd hasn’t checked them.` : '';
    $('result-caveats').replaceChildren(...(ok && Array.isArray(c.caveats) ? c.caveats : []).map((t) => el('li', null, t)));
    $('result-source').textContent = state.review && state.review.interpretedBy === 'ai'
      ? `Measurements: read from ${state.product && state.product.url ? safeHost(state.product.url) : 'the page'}, interpreted with Fynd’s AI and confirmed by you${state.review.rows.some((r) => Object.values(r.cells).some((x) => x.corrected)) ? ', with your corrections' : ''}. Not verified by Fynd.`
      : state.review && state.review.source === 'shopper'
      ? 'Measurements: entered by you from the product’s chart.'
      : `Measurements: read from ${state.product && state.product.url ? safeHost(state.product.url) : 'the page'} and confirmed by you${state.review && state.review.rows.some((r) => Object.values(r.cells).some((x) => x.corrected)) ? ', with your corrections' : ''}. Not verified by Fynd.`;
    show('results');
  }

  /* ---------- wiring ---------- */
  $('read').addEventListener('click', () => read({ how: 'button' }));
  $('problem-retry').addEventListener('click', () => read({ how: 'retry' }));
  $('problem-manual').addEventListener('click', () => {
    state.type = null;
    state.product = Object.assign({ name: null, brand: null, url: state.raw ? X.pageUrl(state.raw.url) : null, code: null, sku: null, color: null, sizes: [], variants: [], from: {}, missing: ['name', 'brand', 'sizes'], found: false, type: null });
    drawProduct();
  });
  $('product-form').addEventListener('submit', confirmProduct);
  $('product-reread').addEventListener('click', () => read({ how: 'retry' }));
  $('use-chart').addEventListener('click', useChart);
  $('interpreting-skip').addEventListener('click', () => { state.interpreting += 1; state.aiProblem = null; keepOwnReading(state.aiBase ? 'skipped' : 'manual'); });
  $('measure-reread').addEventListener('click', () => read({ how: 'retry' }));
  $('manual-entry').addEventListener('click', manualEntry);
  $('v-review').addEventListener('change', onReviewChange);
  $('v-review').addEventListener('input', (e) => { if (e.target && e.target.dataset && (e.target.dataset.role === 'value' || e.target.dataset.role === 'size')) onReviewChange(e); });
  $('v-review').addEventListener('click', (e) => {
    if (!e.target || e.target.id !== 'review-add-size') return;
    state.review.rows.push({ size: '', available: null, cells: Object.fromEntries(state.review.columns.map((c) => [c.index, { raw: '', value: null, problem: 'empty', corrected: false }])) });
    drawReview();
  });
  $('to-reference').addEventListener('click', () => { if (!drawReviewProblems().length) loadGarments(); });
  $('review-back').addEventListener('click', drawCharts);
  $('reference-back').addEventListener('click', drawReview);
  $('reference-retry').addEventListener('click', loadGarments);
  $('compare').addEventListener('click', compare);
  $('result-measurements').addEventListener('click', drawReview);
  $('result-garment').addEventListener('click', loadGarments);
  $('result-reread').addEventListener('click', () => read({ how: 'retry' }));
  $('error-retry').addEventListener('click', () => {
    const kind = $('error-retry').dataset.kind;
    if (kind === 'sign-in' || kind === 'not-found') loadGarments(); else compare();
  });
  $('error-back').addEventListener('click', drawReview);

  /* a press on Fynd's toolbar button, with the panel already open */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'fynd:read' && !state.comparing) read({ tabId: msg.tabId, how: 'toolbar' });
  });

  (async () => {
    show('start');
    /* opened by a toolbar press: read the tab it was pressed on */
    let pressed = null;
    try { pressed = (await chrome.storage.session.get('fyndPressed')).fyndPressed; } catch (err) { note('read the toolbar press', err); }
    if (fixedTab || (pressed && Date.now() - pressed.at < 60000)) read({ tabId: pressed ? pressed.tabId : null, how: 'toolbar' });
  })();
})();
