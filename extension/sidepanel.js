/* =========================================================
   Fynd extension — the Fit panel

   A garment the shopper already owns (a Fit Anchor) beside the product
   they're looking at, compared by measurement (vendor/fit-anchor.js).

     1  References. "Which clothes already fit you the way you like?" —
        brand, kind, size label, and how it fits (tight / right / loose,
        short / right / long). Its measurements come, strongest first:
          its own product in Fynd's records (a link the shopper gives;
            GET /api/size-recommendation?chart=<link>)
          its own product's chart, read on its page in this browser
            ("This fits me — use as a reference")
          the shopper's own measurements, typed
          a similar product Fynd has measured (same brand, kind, size;
            ?reference=…) — offered, labelled an estimate, never assumed
        A brand and a label alone give no measurements.
     2  The product in view. The page is read only after the shopper
        presses the toolbar button on it (activeTab), or — for a
        supported retailer (retailers.js) — if they chose to let Fynd
        read that retailer's pages. Its size tables are read and labelled
        exactly as the popup does (collect.js, vendor/fynd-payload.js);
        on a supported retailer, Fynd's own record of the product is
        looked up by its canonical address too.
     3  The comparison: FyndFitAnchor.recommend, shown with its
        confidence and the reasons for it. The shopper can confirm what
        an unlabelled chart measures, correct any value, and say how a
        purchase fit — which narrows their reference's preferred ranges.

   References and outcomes are kept in chrome.storage.local only. The
   panel's only requests go to FYND_SITE, carrying a product address or
   a brand / kind / size label — never anything about the shopper.

   For tests only, ?tab=<id> names the tab to read (it reaches nothing
   the extension isn't already allowed to read).
   ========================================================= */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const F = window.FyndFitAnchor;
  const { candidates } = window.FyndPayload;
  const { el } = window.SizeChart;
  const API_TIMEOUT = 10000;
  const fixedTab = Number(new URLSearchParams(location.search).get('tab')) || null;

  const state = {
    anchors: [],
    settings: { unit: 'in' },
    pending: null,          /* an anchor being created */
    page: null,             /* what was read: { tab, collected, match, category, options, chosen } */
    corrected: null,        /* the shopper's corrected chart */
    confirmedGarment: false,
    lastResult: null,
    editing: false
  };

  /* ---------- storage: this browser only ---------- */

  async function load() {
    const got = await chrome.storage.local.get(['fyndAnchors', 'fyndSettings']);
    state.anchors = (Array.isArray(got.fyndAnchors) ? got.fyndAnchors : []).map((a) => F.makeAnchor(a).anchor).filter(Boolean);
    state.settings = Object.assign({ unit: 'in' }, got.fyndSettings && typeof got.fyndSettings === 'object' ? got.fyndSettings : {});
    if (!['in', 'cm'].includes(state.settings.unit)) state.settings.unit = 'in';
  }
  const saveAnchors = () => chrome.storage.local.set({ fyndAnchors: state.anchors });
  const saveSettings = () => chrome.storage.local.set({ fyndSettings: state.settings });

  /* ---------- Fynd's server: product addresses and size labels only ---------- */

  async function api(params) {
    const url = `${FYND_SITE.replace(/\/$/, '')}/api/size-recommendation?${new URLSearchParams(params)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT);
    try {
      const res = await fetch(url, { credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* Fynd's own record of a product, by its page: its garment chart and
     whether Fynd has checked it, or null */
  async function recordChart(pageUrl) {
    const answer = await api({ chart: pageUrl });
    const chart = answer && answer.chart;
    if (!chart || chart.from !== 'fynd-record') return null;
    const garment = (chart.charts || []).find((c) => c.measures === 'finished-garment' && c.origin === 'fynd-record');
    if (!garment) return null;
    return {
      chart: { measures: 'finished-garment', unit: garment.unit, columns: garment.columns, rows: garment.rows, methods: garment.methods || null },
      verified: garment.verification === 'verified',
      name: chart.product && chart.product.name,
      brand: chart.product && chart.product.brand
    };
  }

  /* ---------- small view helpers ---------- */

  const SECTIONS = ['onboard', 'resolve', 'product', 'rec', 'feedback', 'anchors'];
  function show(ids) {
    SECTIONS.forEach((s) => { $(s).hidden = !ids.includes(s); });
    document.body.dataset.view = ids[0] || 'none';
  }
  function status(text) {
    $('status').textContent = text || '';
    $('status').hidden = !text;
  }
  const kindLabel = (c) => (F.CATEGORIES[c] ? F.CATEGORIES[c].label : c);
  const kindLower = (c) => { const l = kindLabel(c); return /^T-/.test(l) ? l : l.toLowerCase(); };
  /* "T-shirts", "jeans" */
  const kindPlural = (c) => (/s$/.test(c) ? kindLower(c) : `${kindLower(c)}s`);
  const fmt = (inches) => F.format(inches, state.settings.unit);
  function fillCategories(select, chosen) {
    select.replaceChildren(...Object.keys(F.CATEGORIES).map((id) => {
      const o = el('option', null, F.CATEGORIES[id].label);
      o.value = id;
      return o;
    }));
    if (chosen) select.value = chosen;
  }

  /* ---------- references ---------- */

  function anchorSummary(a) {
    const dims = Object.entries(a.dims);
    const sources = [...new Set(dims.map(([, m]) => (m.source === 'fynd-record' && !m.verified ? 'fynd-record-unverified' : m.source)))];
    const feel = [a.feel.fit === 'right' ? 'fits just right' : `feels ${a.feel.fit}`, a.feel.length === 'right' ? null : `feels ${a.feel.length}`].filter(Boolean).join(', ');
    const measures = dims.length
      ? `${dims.map(([id, m]) => `${F.DIMENSIONS[id].phrase} ${fmt(m.value)}`).join(' · ')} (${sources.map((s) => F.SOURCE_WORDS[s] || s).join('; ')})`
      : 'No measurements yet — only a label, so Fynd can only match sizes by name in the same brand.';
    return { title: `${a.brand} ${kindLower(a.category)}, size ${a.size}`, feel, measures, outcomes: a.feedback.length };
  }

  function drawAnchors() {
    const list = $('anchor-list');
    list.replaceChildren(...state.anchors.map((a) => {
      const s = anchorSummary(a);
      const li = el('li', 'fp-anchor');
      li.dataset.id = a.id;
      li.append(el('span', 'fp-anchor-name', s.title), el('span', 'pop-small', `${s.feel}${s.outcomes ? ` · ${s.outcomes} outcome${s.outcomes === 1 ? '' : 's'} recorded` : ''}`), el('span', 'fp-anchor-dims', s.measures));
      const actions = el('span', 'fp-anchor-actions');
      const remove = el('button', 'link-button', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        state.anchors = state.anchors.filter((x) => x.id !== a.id);
        await saveAnchors();
        refresh();
      });
      actions.append(remove);
      li.append(actions);
      return li;
    }));
  }

  /* the form, empty or filled from a product the shopper is looking at */
  function openForm(prefill) {
    const p = prefill || {};
    $('a-brand').value = p.brand || '';
    fillCategories($('a-category'), p.category || 'tshirt');
    $('a-size').value = p.size || '';
    const sizes = $('sizes');
    if (p.sizes && p.sizes.length) sizes.replaceChildren(...p.sizes.map((z) => { const o = el('option'); o.value = z; return o; }));
    $('a-url').value = p.url || '';
    $('a-name').value = p.name || '';
    $('anchor-error').textContent = '';
    document.querySelectorAll('input[name="a-fit"]').forEach((r) => { r.checked = r.value === 'right'; });
    document.querySelectorAll('input[name="a-length"]').forEach((r) => { r.checked = r.value === 'right'; });
    $('anchor-cancel').hidden = !state.anchors.length;
    state.pending = { fromChart: p.fromChart || null };
    show(['onboard']);
    status('');
    $('a-brand').focus();
  }

  async function submitForm(event) {
    event.preventDefault();
    const radio = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;
    const url = $('a-url').value.trim();
    const made = F.makeAnchor({
      brand: $('a-brand').value,
      category: $('a-category').value,
      size: $('a-size').value,
      feel: { fit: radio('a-fit'), length: radio('a-length') },
      product: { url: /^https:\/\//.test(url) ? url : null, name: $('a-name').value || null }
    });
    if (made.error) { $('anchor-error').textContent = made.error; return; }
    if (url && !/^https:\/\//.test(url)) { $('anchor-error').textContent = 'A product link starts with https://'; return; }
    const anchor = made.anchor;
    const fromChart = state.pending && state.pending.fromChart;
    /* from the product in view: its own chart, in the size on its label */
    if (fromChart) {
      const got = F.dimsFromChart(fromChart.chart, anchor.category, anchor.size, fromChart.source);
      if (got.error) { $('anchor-error').textContent = got.error; return; }
      Object.entries(got.dims).forEach(([id, m]) => { m.verified = fromChart.verified === true; });
      await keep(Object.assign(anchor, { dims: F.makeAnchor(Object.assign({}, anchor, { dims: got.dims })).anchor.dims }));
      return;
    }
    await resolve(anchor);
  }

  async function keep(anchor) {
    state.anchors = state.anchors.filter((a) => a.id !== anchor.id).concat([anchor]);
    await saveAnchors();
    state.pending = null;
    refresh();
    read();
  }

  /* where the new reference's measurements come from */
  async function resolve(anchor) {
    state.pending = { anchor };
    show(['resolve']);
    $('resolve-options').replaceChildren();
    $('manual').open = false;
    drawManual(anchor.category);
    if (anchor.product && anchor.product.url) {
      $('resolve-text').textContent = 'Looking for this product in Fynd’s records…';
      const found = await recordChart(anchor.product.url);
      if (found) {
        const got = F.dimsFromChart(found.chart, anchor.category, anchor.size, 'fynd-record');
        if (!got.error) {
          Object.values(got.dims).forEach((m) => { m.verified = found.verified; });
          const dims = F.makeAnchor(Object.assign({}, anchor, { dims: got.dims })).anchor.dims;
          status(`Found ${found.name || 'this product'} in Fynd’s records (${found.verified ? 'checked by Fynd' : 'not yet checked'}).`);
          await keep(Object.assign(anchor, { dims }));
          return;
        }
      }
      $('resolve-text').textContent = 'Fynd has no record of that product’s garment measurements. Open its product page and press “This fits me — use as a reference” there, or enter its measurements below.';
    } else {
      $('resolve-text').textContent = `Looking for ${anchor.brand} ${kindLower(anchor.category)} measurements in size ${anchor.size}…`;
    }
    const answer = await api({ reference: '1', rbrand: anchor.brand, rcategory: anchor.category, rsize: anchor.size });
    const refs = answer && Array.isArray(answer.references) ? answer.references : [];
    const options = refs.map((r) => {
      const got = F.dimsFromChart(r.chart, anchor.category, anchor.size, 'similar-product');
      return got.error ? null : { r, dims: got.dims };
    }).filter(Boolean);
    if (options.length) {
      $('resolve-text').textContent = `Fynd has measured ${options.length === 1 ? 'a similar product' : 'similar products'} — the same brand, kind and size, but not your garment. Using one gives an estimate, and Fynd will say so.`;
      $('resolve-options').replaceChildren(...options.map(({ r, dims }) => {
        const b = el('button', 'pop-choice');
        b.type = 'button';
        b.append(el('span', 'pop-choice-name', `${r.brand} ${r.name}, size ${anchor.size}`),
          el('span', 'pop-choice-cols', `${Object.entries(dims).map(([id, m]) => `${F.DIMENSIONS[id].phrase} ${fmt(m.value)}`).join(' · ')} · ${r.verification === 'verified' ? 'checked by Fynd' : 'not yet checked'} · an estimate for yours`));
        b.addEventListener('click', () => keep(Object.assign(anchor, { dims: F.makeAnchor(Object.assign({}, anchor, { dims })).anchor.dims })));
        const li = el('li');
        li.append(b);
        return li;
      }));
    } else if (!(anchor.product && anchor.product.url)) {
      $('resolve-text').textContent = `Fynd has no measurements for ${anchor.brand} ${kindPlural(anchor.category)} in ${anchor.size}. Open your garment’s product page and press “This fits me — use as a reference” there, or enter its measurements below. Without them, Fynd can only match size labels in the same brand.`;
    }
  }

  /* typed measurements: laid flat, with the method each is taken by */
  const MANUAL_METHOD = { sleeveLength: 'shoulder-seam', bodyLength: 'hps', shoulderWidth: 'seam-to-seam' };
  const MANUAL_HINT = { chestWidth: 'armpit to armpit, flat', bodyLength: 'top of shoulder to hem', sleeveLength: 'shoulder seam to cuff', shoulderWidth: 'seam to seam', waist: 'edge to edge, flat', hip: 'widest, flat', thigh: 'below the crotch, flat', rise: 'crotch to waistband', inseam: 'crotch to hem', legOpening: 'hem, flat' };
  function drawManual(category) {
    const box = $('manual-fields');
    box.replaceChildren(...F.CATEGORIES[category].dims.flatMap((id) => {
      const label = el('label', null, `${F.DIMENSIONS[id].phrase} (${MANUAL_HINT[id]}), ${state.settings.unit}`);
      label.htmlFor = `m-${id}`;
      const input = el('input', 'fp-input');
      input.id = `m-${id}`;
      input.inputMode = 'decimal';
      input.dataset.dim = id;
      return [label, input];
    }));
  }
  async function saveManual() {
    const anchor = state.pending && state.pending.anchor;
    if (!anchor) return;
    const dims = {};
    $('manual-fields').querySelectorAll('input').forEach((i) => {
      const p = F.parseCell(i.value);
      if (!p) return;
      const unit = p.unit || state.settings.unit;
      dims[i.dataset.dim] = { value: unit === 'cm' ? p.value / 2.54 : p.value, source: 'shopper', method: MANUAL_METHOD[i.dataset.dim] || null };
    });
    if (!Object.keys(dims).length) { $('resolve-text').textContent = 'Enter at least one measurement, or continue without.'; return; }
    await keep(Object.assign(anchor, { dims: F.makeAnchor(Object.assign({}, anchor, { dims })).anchor.dims }));
  }

  /* ---------- the product in view ---------- */

  async function targetTab() {
    if (fixedTab) return chrome.tabs.get(fixedTab);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function read() {
    if (!state.anchors.length) return;
    state.corrected = null;
    state.confirmedGarment = false;
    state.editing = false;
    $('grant').hidden = true;
    $('confirm-kind').hidden = true;
    let tab;
    try { tab = await targetTab(); } catch (err) { tab = null; }
    /* Chrome shows a tab's address only where Fynd may read it, so an
       unknown address isn't "not a product page": try, and explain */
    if (!tab || (tab.url && !/^https?:\/\//i.test(tab.url))) {
      productProblem('Open a clothing product page in this window to compare it with your references.');
      return;
    }
    const match = tab.url ? FyndRetailers.match(tab.url) : null;
    let results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fyndCollect });
    } catch (err) {
      results = null;
    }
    const collected = results && results[0] && results[0].result;
    if (!collected || typeof collected !== 'object') {
      productProblem('Press the Fynd button in Chrome’s toolbar on this page so Fynd may read it, then press Read this page.');
      /* a supported retailer the shopper hasn't let Fynd read: offer it */
      const retailer = match && match.retailer ? match.retailer : await ungranted();
      if (retailer) {
        $('grant-text').textContent = match && match.retailer
          ? `Fynd supports ${retailer.name}. Let it read ${retailer.name} product pages while you shop, instead of pressing the toolbar button on each page.`
          : `Shopping at ${retailer.name}? Fynd supports it: let it read ${retailer.name} product pages while you shop, instead of pressing the toolbar button on each page.`;
        $('grant').hidden = false;
        state.grantFor = retailer;
      }
      return;
    }
    const found = candidates(collected);
    const options = found.list.map((c, i) => ({ key: `page-${i}`, chart: c.chart, label: c.heading || c.chart.title || `Table ${i + 1} on the page`, source: 'retailer-page', where: c.inDialog ? 'in the open size guide' : 'on the page' }));
    /* a supported retailer: Fynd's own record of the product too */
    if (match && match.product) {
      const rec = await recordChart(match.product.canonical);
      if (rec) options.unshift({ key: 'fynd', chart: rec.chart, label: `Fynd’s record of this product (${rec.verified ? 'checked by Fynd' : 'not yet checked'})`, source: rec.verified ? 'fynd-record' : 'fynd-record-unverified', where: 'Fynd' });
    }
    const name = collected.product && collected.product.name || collected.title || '';
    const category = F.categoryOf(`${name} ${collected.title || ''}`);
    state.page = { tab, collected, match, category, options, chosen: pickChart(options) };
    drawProduct();
    recommendNow();
  }

  /* the first supported retailer the shopper hasn't let Fynd read */
  async function ungranted() {
    for (const r of FyndRetailers.RETAILERS) {
      let has = false;
      try { has = await chrome.permissions.contains({ origins: r.origins }); } catch (err) { has = false; }
      if (!has) return r;
    }
    return null;
  }

  /* the chart to compare with, strongest first: a checked Fynd record,
     the page's own garment chart, an unchecked record, then the rest */
  function pickChart(options) {
    const rank = (o) => (o.source === 'fynd-record' ? 0 : o.chart.measures === 'finished-garment' && o.source === 'retailer-page' ? 1 : o.source === 'fynd-record-unverified' ? 2 : o.chart.measures === 'not-stated' ? 3 : 4);
    const sorted = options.slice().sort((a, b) => rank(a) - rank(b));
    return sorted.length ? sorted[0].key : null;
  }

  function productProblem(text) {
    state.page = null;
    show(['product', 'anchors']);
    $('product-name').textContent = '';
    $('product-meta').textContent = text;
    $('chart-area').replaceChildren();
    $('chart-choices').hidden = true;
    $('chart-actions').hidden = true;
    $('rec').hidden = true;
    $('feedback').hidden = true;
  }

  const chosenOption = () => state.page && state.page.options.find((o) => o.key === state.page.chosen) || null;
  const currentChart = () => state.corrected || (chosenOption() ? chosenOption().chart : null);
  const currentSource = () => (state.corrected ? 'shopper' : chosenOption() ? chosenOption().source : null);

  function drawProduct() {
    const p = state.page;
    const c = p.collected;
    show(['product', 'rec', 'feedback', 'anchors']);
    $('product-name').textContent = c.product && c.product.name ? c.product.name : (c.title || 'This page');
    const bits = [c.retailer, p.match && p.match.product ? `supported: ${p.match.retailer.name}` : p.match && p.match.retailer ? `a ${p.match.retailer.name} page, but not a product page Fynd recognises` : 'not a supported retailer — reading what the page shows'];
    if (p.match && p.match.product) bits.push(`product ${p.match.product.code}`);
    $('product-meta').textContent = bits.filter(Boolean).join(' · ');
    const fallback = F.anchorFor(state.anchors, p.category) ? p.category : (state.anchors[0] && state.anchors[0].category);
    fillCategories($('p-category'), p.category || fallback || 'tshirt');
    if (!p.category) p.category = $('p-category').value;
    drawChart();
  }

  function drawChart() {
    const p = state.page;
    const area = $('chart-area');
    const opt = chosenOption();
    const chart = currentChart();
    $('chart-choices').hidden = p.options.length < 2;
    $('chart-choices').replaceChildren(...p.options.map((o) => {
      const b = el('button', 'pop-choice');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(o.key === p.chosen));
      b.append(el('span', 'pop-choice-name', o.label), el('span', 'pop-choice-cols', `${MEASURES[o.chart.measures]} · ${o.chart.rows.length} sizes · ${o.where}`));
      b.addEventListener('click', () => { p.chosen = o.key; state.corrected = null; state.confirmedGarment = false; drawChart(); recommendNow(); });
      const li = el('li');
      li.append(b);
      return li;
    }));
    if (!chart) {
      const hint = p.match && p.match.retailer ? p.match.retailer.chartHint : 'If the page shows its size chart in a size guide, open the guide, then press Read this page.';
      area.replaceChildren(el('p', 'fp-note', `No size chart found on this page. ${hint}`));
      $('chart-actions').hidden = true;
      $('confirm-kind').hidden = true;
      return;
    }
    const head = el('p', 'pop-small', `${MEASURES[chart.measures]} · ${chart.unit ? `in ${chart.unit === 'cm' ? 'centimetres' : chart.unit === 'in' ? 'inches' : 'inches and centimetres'}` : 'unit not stated'} · ${SOURCE_LINE[currentSource()] || ''}`);
    area.replaceChildren(head, chartTable(chart));
    $('chart-actions').hidden = false;
    $('use-as-anchor').hidden = chart.measures !== 'finished-garment';
    $('confirm-kind').hidden = !(chart.measures === 'not-stated' && !state.confirmedGarment);
    $('correct').textContent = state.editing ? 'Save corrections' : 'Correct a measurement';
    if (opt) area.dataset.source = currentSource();
  }
  const MEASURES = { 'finished-garment': 'Garment measurements', body: 'Body measurements', 'not-stated': 'Garment or body not stated' };
  const SOURCE_LINE = { 'fynd-record': 'from Fynd’s record, checked by Fynd', 'fynd-record-unverified': 'from Fynd’s record, not yet checked', 'retailer-page': 'read from this page in your browser', shopper: 'as you corrected it' };

  function chartTable(chart) {
    const table = el('table', `size-chart-table fp-compare${state.editing ? ' fp-edit-table' : ''}`);
    const thead = el('thead');
    const hr = el('tr');
    hr.append(el('th', null, 'Size'), ...chart.columns.map((c) => el('th', null, c)));
    thead.append(hr);
    const tbody = el('tbody');
    chart.rows.forEach((r, ri) => {
      const tr = el('tr');
      tr.append(el('th', null, r.size));
      r.values.forEach((v, ci) => {
        const td = el('td');
        if (state.editing) {
          const input = el('input');
          input.value = v;
          input.dataset.row = String(ri);
          input.dataset.col = String(ci);
          input.setAttribute('aria-label', `${r.size}, ${chart.columns[ci]}`);
          td.append(input);
        } else td.textContent = v;
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    return table;
  }

  function toggleCorrect() {
    const chart = currentChart();
    if (!chart) return;
    if (!state.editing) { state.editing = true; drawChart(); return; }
    const copy = JSON.parse(JSON.stringify(chart));
    let changed = 0;
    $('chart-area').querySelectorAll('input[data-row]').forEach((i) => {
      const r = Number(i.dataset.row);
      const c = Number(i.dataset.col);
      const v = i.value.trim().slice(0, 20);
      if (copy.rows[r] && copy.rows[r].values[c] !== v) { copy.rows[r].values[c] = v; changed += 1; }
    });
    state.editing = false;
    if (changed) { state.corrected = copy; status(`${changed} value${changed === 1 ? '' : 's'} corrected. Fynd now treats this chart as yours to vouch for.`); }
    drawChart();
    recommendNow();
  }

  /* ---------- the recommendation ---------- */

  function recommendNow() {
    const p = state.page;
    if (!p) return;
    const category = $('p-category').value || p.category;
    const anchor = F.anchorFor(state.anchors, category);
    const rec = $('rec');
    rec.hidden = false;
    $('rec-details').hidden = true;
    $('rec-table').replaceChildren();
    $('rec-why').replaceChildren();
    $('rec-notes').replaceChildren();
    if (!anchor) {
      $('rec-title').textContent = 'Add a reference first';
      setConfidence(null);
      $('rec-explain').replaceChildren(el('p', null, `None of your references is ${/s$/.test(category) ? '' : 'a '}${kindLower(category)} or cut like ${/s$/.test(category) ? 'them' : 'one'}. Add ${/s$/.test(category) ? '' : 'a '}${kindLower(category)} that fit${/s$/.test(category) ? '' : 's'} you well to compare.`));
      $('rec-anchor').textContent = '';
      $('feedback').hidden = true;
      return;
    }
    const chart = currentChart();
    const result = F.recommend(anchor, chart, {
      unit: state.settings.unit,
      category,
      targetSource: currentSource(),
      brand: (p.collected.product && p.collected.product.brand) || (p.match && p.match.retailer ? p.match.retailer.brand : null),
      sizes: p.collected.product ? p.collected.product.sizes : [],
      allowNotStated: state.confirmedGarment
    });
    state.lastResult = result;
    $('rec-anchor').textContent = `Compared with your ${anchor.brand} ${kindLower(anchor.category)} in ${anchor.size}.`;
    if (result.status === 'ok') {
      $('rec-title').textContent = result.size;
      setConfidence(result.confidence);
      $('rec-explain').replaceChildren(...result.explanation.map((t) => el('p', null, t)), ...(result.alternative ? [el('p', 'pop-small', `${result.alternative} is close too — check the table below.`)] : []));
      $('rec-details').hidden = false;
      $('rec-table').replaceChildren(compareTable(result));
      $('rec-why').replaceChildren(...result.confidenceWhy.map((t) => el('li', null, `Confidence: ${t}.`)));
      $('rec-notes').replaceChildren(...result.notCompared.map((n) => el('li', null, `Not compared — ${n.label}: ${n.why}.`)), ...result.uncertain.map((t) => el('li', null, t)));
      drawFeedback(result);
    } else {
      $('rec-title').textContent = result.labelMatch ? `${result.labelMatch.size}?` : 'Not enough to compare';
      setConfidence(result.labelMatch ? 'label' : null);
      $('rec-explain').replaceChildren(...result.explanation.map((t) => el('p', null, t)));
      $('feedback').hidden = true;
    }
  }

  function setConfidence(level) {
    const c = $('rec-confidence');
    c.dataset.level = level || '';
    c.textContent = level === 'label' ? 'Label match only — low confidence' : level ? `${level[0].toUpperCase()}${level.slice(1)} confidence` : '';
    c.hidden = !level;
  }

  function compareTable(result) {
    const dims = result.compared;
    const table = el('table', 'fp-compare');
    const hr = el('tr');
    hr.append(el('th', null, 'Size'), ...dims.map((d) => el('th', null, F.DIMENSIONS[d].phrase)));
    const thead = el('thead');
    thead.append(hr);
    const tbody = el('tbody');
    result.ranked.forEach((r, i) => {
      const tr = el('tr', i === 0 ? 'is-best' : null);
      tr.append(el('th', null, r.size));
      dims.forEach((d) => {
        const diff = r.diffs.find((x) => x.dim === d);
        tr.append(el('td', null, diff ? `${fmt(diff.target)} — ${diff.verdict}` : '—'));
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    return table;
  }

  /* ---------- outcomes ---------- */

  function drawFeedback(result) {
    $('feedback').hidden = false;
    const sizes = result.chart.sizes.map((s) => s.size);
    $('f-size').replaceChildren(...sizes.map((s) => { const o = el('option', null, s); o.value = s; return o; }));
    $('f-size').value = result.size;
    $('feedback-saved').textContent = '';
  }
  async function recordOutcome(kind) {
    const p = state.page;
    const result = state.lastResult;
    if (!p || !result || result.status !== 'ok') return;
    const category = $('p-category').value || p.category;
    const anchor = F.anchorFor(state.anchors, category);
    const entry = result.chart.sizes.find((s) => s.size === $('f-size').value);
    const o = anchor && entry ? F.outcome(anchor, kind, entry, { product: p.collected.product && p.collected.product.name }) : null;
    if (!o) { $('feedback-saved').textContent = 'That size has no measurements to learn from.'; return; }
    anchor.feedback = anchor.feedback.concat([o]).slice(-50);
    await saveAnchors();
    recommendNow();
    $('feedback-saved').textContent = `Saved on this device: ${entry.size} was ${kind.replace('-', ' ')}. Your ${anchor.brand} reference’s preferred ranges are updated.`;
  }

  /* ---------- wiring ---------- */

  function refresh() {
    drawAnchors();
    document.querySelectorAll('.fp-unit .fp-chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === state.settings.unit)));
    if (!state.anchors.length) { openForm(); return; }
    show(['product', 'anchors']);
    if (state.page) { drawProduct(); recommendNow(); }
  }

  $('anchor-form').addEventListener('submit', submitForm);
  $('anchor-cancel').addEventListener('click', () => { state.pending = null; refresh(); });
  $('manual-save').addEventListener('click', saveManual);
  $('resolve-skip').addEventListener('click', () => state.pending && state.pending.anchor && keep(state.pending.anchor));
  $('add-anchor').addEventListener('click', () => openForm());
  $('read').addEventListener('click', () => { status(''); read(); });
  $('p-category').addEventListener('change', () => { if (state.page) { state.page.category = $('p-category').value; recommendNow(); } });
  $('correct').addEventListener('click', toggleCorrect);
  $('confirm-garment').addEventListener('click', () => { state.confirmedGarment = true; drawChart(); recommendNow(); });
  $('use-as-anchor').addEventListener('click', () => {
    const p = state.page;
    const chart = currentChart();
    if (!p || !chart) return;
    const source = currentSource();
    openForm({
      brand: (p.collected.product && p.collected.product.brand) || (p.match && p.match.retailer ? p.match.retailer.brand : ''),
      category: $('p-category').value,
      url: p.match && p.match.product ? p.match.product.canonical : (p.collected.canonical || ''),
      name: p.collected.product && p.collected.product.name,
      sizes: chart.rows.map((r) => r.size),
      fromChart: { chart: state.confirmedGarment ? Object.assign({}, chart, { measures: 'finished-garment' }) : chart, source: source === 'fynd-record' || source === 'fynd-record-unverified' ? 'fynd-record' : source, verified: source === 'fynd-record' }
    });
  });
  $('grant-button').addEventListener('click', async () => {
    const r = state.grantFor;
    if (!r) return;
    const ok = await chrome.permissions.request({ origins: r.origins });
    status(ok ? `Fynd may now read ${r.name} product pages while this panel is open. You can turn this off on chrome://extensions.` : 'Not allowed — press the Fynd button in the toolbar on each page instead.');
    if (ok) read();
  });
  document.querySelectorAll('[data-outcome]').forEach((b) => b.addEventListener('click', () => recordOutcome(b.dataset.outcome)));
  document.querySelectorAll('.fp-unit .fp-chip').forEach((b) => b.addEventListener('click', async () => {
    state.settings.unit = b.dataset.unit;
    await saveSettings();
    refresh();
  }));

  /* follow the shopper: a new page in the tab, or another tab */
  if (!fixedTab && chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.status === 'complete' && tab.active) read(); });
    chrome.tabs.onActivated.addListener(() => read());
  }

  (async () => {
    await load();
    refresh();
    if (state.anchors.length) read();
  })();
})();
