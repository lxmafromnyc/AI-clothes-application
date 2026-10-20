/* =========================================================
   Fynd extension — the Fit panel

   A garment the shopper already owns (a Fit Anchor) beside the product
   they're looking at, compared by measurement (vendor/fit-anchor.js).

     1  The reference. "Which clothes already fit you the way you like?" —
        brand, kind, size label, optionally its cut, and how it fits
        (tight / right / loose, short / right / long). Fynd looks up what
        it can in vendor/fit-reference-data.js (measurements read off
        brands' own pages, with their sources) and saves the reference
        straight away, saying exactly what its numbers rest on:
          the exact product, if the shopper names it or picks it
          the same brand's other products of that kind, in that size
          the brand's body chart plus the room such garments have
          the range across brands, in that size label
          nothing — said so; the shopper can add measurements later
        No tape measure, no link and no network are needed to start.
     2  The product in view. Clicking Fynd's toolbar button on a page
        opens this panel (background.js) and lets it read that tab
        (activeTab). On a site the shopper chose to let Fynd read, the
        panel also follows them from page to page. Its size tables are
        read and labelled as the popup does (collect.js,
        vendor/fynd-payload.js); a product Fynd holds measurements for
        (retailers.js recognises its address) is compared from those.
     3  The comparison: FyndFitAnchor.recommend, with its confidence and
        the reasons for it. The shopper can confirm what an unlabelled
        chart measures, correct a value, and say how a purchase fit —
        which narrows their reference's preferred ranges.

   Everything stays in this browser: references and outcomes in
   chrome.storage.local, and the panel makes no network request. When a
   page can't be read, the panel says why and what to do, and keeps the
   technical detail under "Technical details" and in the console.

   For tests only, ?tab=<id> names the tab to read (it reaches nothing
   the extension isn't already allowed to read).
   ========================================================= */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const F = window.FyndFitAnchor;
  const DATA = window.FyndReferenceData;
  const { candidates, build, encode } = window.FyndPayload;
  const { el } = window.SizeChart;
  const fixedTab = Number(new URLSearchParams(location.search).get('tab')) || null;

  const state = {
    anchors: [],
    settings: { unit: 'in' },
    pending: null,          /* a reference being created or refined */
    page: null,             /* what was read: { tab, collected, match, category, options, chosen } */
    corrected: null,        /* the shopper's corrected chart */
    confirmedGarment: false,
    lastResult: null,
    editing: false,
    reading: 0,             /* the latest read wins */
    log: [],                /* recent problems, for "Technical details" */
    lastRead: null          /* how and when the page was last read, and any problem */
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

  /* ---------- problems: said to the shopper, kept for whoever debugs ---------- */

  function note(step, err, extra) {
    const entry = { at: new Date().toISOString(), step, message: String(err && err.message || err || ''), extra: extra || null };
    state.log = state.log.concat([entry]).slice(-20);
    console.warn('[Fynd]', step, entry.message, extra || '');
    return entry;
  }

  /* why Chrome wouldn't let Fynd read a tab, from its own error text */
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
    unknown: ['Fynd couldn’t read this page', 'Reload the page and click Fynd again. If it keeps happening, the technical details below say what Chrome reported.'],
    'empty-result': ['Fynd couldn’t read this page', 'The page didn’t answer. It may still be loading: wait a moment and press Read this page.']
  };

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
  const fmt = (inches) => F.format(inches, state.settings.unit);
  function fillCategories(select, chosen) {
    select.replaceChildren(...Object.keys(F.CATEGORIES).map((id) => {
      const o = el('option', null, F.CATEGORIES[id].label);
      o.value = id;
      return o;
    }));
    if (chosen) select.value = chosen;
  }
  const TIER_WORDS = {
    exact: 'Its own published measurements',
    'same-brand': 'Estimated from the same brand’s products',
    'brand-body-chart': 'Estimated from the brand’s size chart — chest only',
    category: 'Rough estimate from other brands',
    none: 'No measurements yet',
    page: 'Read from its product page',
    shopper: 'Your own measurements'
  };
  const dimWords = (id, m) => `${F.DIMENSIONS[id].phrase}: ${m.source === 'similar-product' || m.source === 'estimate' ? 'about ' : ''}${fmt(m.value)}${typeof m.low === 'number' && typeof m.high === 'number' ? ` (somewhere ${fmt(m.low)}–${fmt(m.high)})` : ''}${m.method && m.method !== 'flat' && F.METHOD_LABELS[m.method] ? `, ${F.METHOD_LABELS[m.method]}` : m.method === 'flat' ? ', laid flat' : ''}`;

  /* ---------- references ---------- */

  function anchorSummary(a) {
    const dims = Object.entries(a.dims);
    const feel = [a.feel.fit === 'right' ? 'fits just right' : `feels ${a.feel.fit}`, a.feel.length === 'right' ? null : `feels ${a.feel.length}`].filter(Boolean).join(', ');
    const tier = a.reference ? a.reference.tier : (dims.length ? (dims[0][1].source === 'shopper' ? 'shopper' : dims[0][1].source === 'retailer-page' ? 'page' : 'exact') : 'none');
    const measures = dims.length
      ? dims.map(([id, m]) => dimWords(id, m)).join(' · ')
      : 'No measurements yet — Fynd can only match size labels in the same brand.';
    return { title: `${a.brand} ${kindLower(a.category)}, size ${a.size}${a.cut ? ` (${a.cut})` : ''}`, feel, tier: TIER_WORDS[tier] || '', measures, outcomes: a.feedback.length };
  }

  function drawAnchors() {
    const list = $('anchor-list');
    list.replaceChildren(...state.anchors.map((a) => {
      const s = anchorSummary(a);
      const li = el('li', 'fp-anchor');
      li.dataset.id = a.id;
      li.append(el('span', 'fp-anchor-name', s.title), el('span', 'pop-small', `${s.feel}${s.outcomes ? ` · ${s.outcomes} outcome${s.outcomes === 1 ? '' : 's'} recorded` : ''} · ${s.tier}`), el('span', 'fp-anchor-dims', s.measures));
      const actions = el('span', 'fp-anchor-actions');
      const details = el('button', 'link-button', 'Details');
      details.type = 'button';
      details.addEventListener('click', () => showReference(a));
      const remove = el('button', 'link-button', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        state.anchors = state.anchors.filter((x) => x.id !== a.id);
        await saveAnchors();
        refresh();
      });
      actions.append(details, remove);
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
    $('a-cut').value = '';
    const sizes = $('sizes');
    if (p.sizes && p.sizes.length) sizes.replaceChildren(...p.sizes.map((z) => { const o = el('option'); o.value = z; return o; }));
    $('a-url').value = p.url || '';
    $('anchor-error').textContent = '';
    document.querySelectorAll('input[name="a-fit"]').forEach((r) => { r.checked = r.value === 'right'; });
    document.querySelectorAll('input[name="a-length"]').forEach((r) => { r.checked = r.value === 'right'; });
    $('anchor-cancel').hidden = !state.anchors.length;
    state.pending = { fromChart: p.fromChart || null, name: p.name || null };
    show(['onboard']);
    status('');
    $('a-brand').focus();
  }

  /* brand, kind and size → a saved reference, at once, with whatever
     measurements the data supports; the shopper refines it after */
  async function submitForm(event) {
    event.preventDefault();
    const radio = (name) => (document.querySelector(`input[name="${name}"]:checked`) || {}).value;
    const url = $('a-url').value.trim();
    if (url && !/^https:\/\//.test(url)) { $('anchor-error').textContent = 'A product link starts with https://'; return; }
    const input = {
      brand: $('a-brand').value,
      category: $('a-category').value,
      size: $('a-size').value,
      cut: $('a-cut').value || null,
      feel: { fit: radio('a-fit'), length: radio('a-length') },
      product: url || (state.pending && state.pending.name) ? { url: url || null, name: state.pending && state.pending.name } : null
    };
    const made = F.makeAnchor(input);
    if (made.error) { $('anchor-error').textContent = made.error; return; }
    const fromChart = state.pending && state.pending.fromChart;
    /* from the product in view: its own chart, in the size on its label */
    if (fromChart) {
      const got = F.dimsFromChart(fromChart.chart, made.anchor.category, made.anchor.size, fromChart.source);
      if (got.error) { $('anchor-error').textContent = got.error; return; }
      Object.values(got.dims).forEach((m) => { m.verified = fromChart.verified === true; });
      const anchor = F.makeAnchor(Object.assign({}, input, { dims: got.dims, reference: { tier: 'page', summary: `Measurements of ${state.pending.name || 'this product'} in ${made.anchor.size}, from its product page.` } })).anchor;
      await keep(anchor);
      showReference(anchor);
      return;
    }
    const linked = url ? F.referenceProductFor(DATA, { url }) : null;
    if (url && !linked) status('Fynd has no measurements for that exact product, so it used what it has for the brand and size instead.');
    const anchor = estimated(input, linked ? linked.id : null);
    await keep(anchor);
    showReference(anchor);
  }

  /* a reference from the data: the anchor with its measurements and what they rest on */
  function estimated(input, productId) {
    const est = F.estimateReference(DATA, { brand: input.brand, category: input.category, size: input.size, cut: input.cut, productId });
    const product = est.tier === 'exact' && est.basis[0] ? { name: est.basis[0].name, url: est.basis[0].url } : input.product;
    const made = F.makeAnchor(Object.assign({}, input, { product, dims: est.dims, reference: { tier: est.tier, summary: est.summary, basis: est.basis } }));
    const anchor = made.anchor;
    state.pending = { anchor, estimate: est };
    return anchor;
  }

  async function keep(anchor) {
    state.anchors = state.anchors.filter((a) => a.id !== anchor.id).concat([anchor]);
    await saveAnchors();
    drawAnchors();
  }

  /* what a reference's numbers rest on, and how to make them better */
  function showReference(anchor) {
    const est = F.estimateReference(DATA, { brand: anchor.brand, category: anchor.category, size: anchor.size, cut: anchor.cut });
    state.pending = { anchor };
    show(['resolve', 'anchors']);
    const tier = anchor.reference ? anchor.reference.tier : (Object.keys(anchor.dims).length ? 'shopper' : 'none');
    $('ref-name').textContent = `${anchor.brand} ${kindLower(anchor.category)}, size ${anchor.size}`;
    $('ref-tier').textContent = TIER_WORDS[tier] || '';
    $('ref-tier').dataset.level = tier === 'exact' || tier === 'page' ? 'high' : tier === 'same-brand' || tier === 'shopper' ? 'medium' : 'low';
    $('resolve-text').textContent = anchor.reference && anchor.reference.summary
      ? anchor.reference.summary
      : Object.keys(anchor.dims).length ? 'Measurements you entered or corrected.' : 'Fynd has no measurements for this garment yet.';
    $('ref-dims').replaceChildren(...Object.entries(anchor.dims).map(([id, m]) => el('li', null, dimWords(id, m))));
    const basis = anchor.reference ? anchor.reference.basis : [];
    $('ref-sources-box').hidden = !basis.length;
    $('ref-sources').replaceChildren(...basis.map((b) => {
      const li = el('li');
      const words = `${b.brand} — ${b.name}${b.verification === 'verified' ? ' (checked by Fynd' : ' (as published, not yet checked by Fynd'}${b.retrievedAt ? `; read ${b.retrievedAt})` : ')'}`;
      if (b.url) {
        const a = el('a', null, words);
        a.href = b.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.append(a);
      } else li.textContent = words;
      return li;
    }));
    /* the brand's products in this size: "mine is this one" */
    const picks = est.candidates.filter((c) => !(tier === 'exact' && anchor.product && c.url === anchor.product.url));
    $('ref-pick').hidden = !picks.length;
    $('resolve-options').replaceChildren(...picks.map((c) => {
      const b = el('button', 'pop-choice');
      b.type = 'button';
      b.append(el('span', 'pop-choice-name', `${c.brand} ${c.name}`), el('span', 'pop-choice-cols', `${c.fit ? `${c.fit} fit · ` : ''}${c.verification === 'verified' ? 'checked by Fynd' : 'as published, not yet checked'}`));
      b.addEventListener('click', async () => {
        const next = estimated({ id: anchor.id, brand: anchor.brand, category: anchor.category, size: anchor.size, cut: anchor.cut, feel: anchor.feel, priority: anchor.priority, feedback: anchor.feedback, createdAt: anchor.createdAt }, c.id);
        await keep(next);
        status(`Using ${c.brand} ${c.name}’s own measurements.`);
        showReference(next);
      });
      const li = el('li');
      li.append(b);
      return li;
    }));
    $('manual').open = !Object.keys(anchor.dims).length && tier === 'none';
    drawManual(anchor.category);
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
    if (!Object.keys(dims).length) { status('Enter at least one measurement, or keep what Fynd found.'); return; }
    /* typed values replace the estimate where given; the rest stays */
    const merged = Object.assign({}, anchor.dims, dims);
    const next = F.makeAnchor(Object.assign({}, anchor, { dims: merged, reference: { tier: 'shopper', summary: 'Measurements you entered, with Fynd’s estimate for any you left out.', basis: anchor.reference ? anchor.reference.basis : [] } })).anchor;
    await keep(next);
    showReference(next);
  }

  /* ---------- the product in view ---------- */

  async function targetTab(tabId) {
    const id = fixedTab || tabId;
    if (id) return chrome.tabs.get(id);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  /* read the page: on a toolbar press (pressed), a "Read this page"
     click, or quietly as the shopper moves between pages */
  async function read(opts) {
    const o = opts || {};
    if (!state.anchors.length) return;
    const ticket = ++state.reading;
    state.lastRead = { how: o.how || 'auto', at: new Date().toISOString(), problem: null };
    state.corrected = null;
    state.confirmedGarment = false;
    state.editing = false;
    $('grant').hidden = true;
    $('confirm-kind').hidden = true;
    let tab = null;
    try { tab = await targetTab(o.tabId); } catch (err) { note('find the tab', err, { tabId: o.tabId || null }); }
    if (ticket !== state.reading) return;
    if (!tab) { productProblem('no-tab'); return; }
    const match = tab.url ? FyndRetailers.match(tab.url) : null;
    let results = null;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: fyndCollect });
    } catch (err) {
      if (ticket !== state.reading) return;
      const kind = classify(err, tab);
      /* moving between pages Fynd may not read isn't an error, just a wait */
      const entry = note('read the page', err, { kind, host: tab.url ? safeHost(tab.url) : 'hidden by Chrome until Fynd is clicked', how: o.how || 'auto' });
      productProblem(kind, entry);
      return;
    }
    if (ticket !== state.reading) return;
    const collected = results && results[0] && results[0].result;
    if (!collected || typeof collected !== 'object') {
      productProblem('empty-result', note('read the page', 'the page returned nothing', { host: safeHost(tab.url) }));
      return;
    }
    const found = candidates(collected);
    const options = found.list.map((c, i) => ({ key: `page-${i}`, chart: c.chart, label: c.heading || c.chart.title || `Table ${i + 1} on the page`, source: 'retailer-page', where: c.inDialog ? 'in the open size guide' : 'on the page' }));
    /* measurements Fynd holds for exactly this product */
    const ref = F.referenceProductFor(DATA, {
      url: tab.url || collected.url,
      canonical: collected.canonical || (match && match.product ? match.product.canonical : null),
      code: match && match.product ? match.product.code : null,
      brand: match && match.retailer ? match.retailer.brand : null
    });
    const refChart = ref ? F.chartFromReference(ref) : null;
    if (refChart) options.unshift({ key: 'fynd', chart: refChart, label: `${ref.brand}’s published measurements for this product, in Fynd’s data (${ref.verification === 'verified' ? 'checked by Fynd' : 'not yet checked by Fynd'})`, source: ref.verification === 'verified' ? 'fynd-record' : 'fynd-record-unverified', where: `Fynd’s data, read from ${ref.brand} ${ref.retrievedAt}` });
    const name = collected.product && collected.product.name || collected.title || '';
    const category = F.categoryOf(`${name} ${collected.title || ''}`) || (ref ? ref.category : null);
    state.page = { tab, collected, match, ref, category, options, chosen: pickChart(options) };
    drawProduct();
    recommendNow();
    offerSite(tab);
  }
  const safeHost = (u) => { try { return new URL(u).host; } catch (err) { return null; } };

  /* after a read: offer to keep reading this site's pages as the shopper
     moves between them — one site, asked for, revocable in Chrome */
  async function offerSite(tab) {
    if (fixedTab || !tab.url || !/^https:\/\//.test(tab.url)) return;
    const origin = `${new URL(tab.url).origin}/*`;
    let has = false;
    try { has = await chrome.permissions.contains({ origins: [origin] }); } catch (err) { note('check site access', err, { origin }); }
    if (has) return;
    state.grantFor = origin;
    $('grant-text').textContent = `Shopping on ${new URL(tab.url).host}? Fynd can read its product pages as you open them, so you don’t have to click Fynd on each one. Only this site, and you can turn it off in Chrome’s extension settings.`;
    $('grant-button').textContent = `Read ${new URL(tab.url).host} pages as I shop`;
    $('grant').hidden = false;
  }

  /* the chart to compare with, strongest first: a checked Fynd record,
     the page's own garment chart, an unchecked record, then the rest */
  function pickChart(options) {
    const rank = (o) => (o.source === 'fynd-record' ? 0 : o.chart.measures === 'finished-garment' && o.source === 'retailer-page' ? 1 : o.source === 'fynd-record-unverified' ? 2 : o.chart.measures === 'not-stated' ? 3 : 4);
    const sorted = options.slice().sort((a, b) => rank(a) - rank(b));
    return sorted.length ? sorted[0].key : null;
  }

  function productProblem(kind, entry) {
    const [title, text] = PROBLEMS[kind] || PROBLEMS.unknown;
    state.page = null;
    state.lastResult = null;
    if (state.lastRead) state.lastRead.problem = kind;
    show(['product', 'anchors']);
    $('product-name').textContent = '';
    $('product-meta').textContent = '';
    $('problem').hidden = false;
    $('problem').dataset.kind = kind;
    $('problem-title').textContent = title;
    $('problem-text').textContent = text;
    $('diag').hidden = !entry;
    $('diag-text').textContent = entry ? JSON.stringify(entry, null, 2) : '';
    $('chart-area').replaceChildren();
    $('chart-choices').hidden = true;
    $('chart-actions').hidden = true;
    $('open-fynd-note').textContent = '';
    kindPicker(false);
    $('rec').hidden = true;
    $('feedback').hidden = true;
  }

  const kindPicker = (on) => { $('p-category').hidden = !on; document.querySelector('label[for="p-category"]').hidden = !on; };

  const chosenOption = () => state.page && state.page.options.find((o) => o.key === state.page.chosen) || null;
  const currentChart = () => state.corrected || (chosenOption() ? chosenOption().chart : null);
  const currentSource = () => (state.corrected ? 'shopper' : chosenOption() ? chosenOption().source : null);

  function drawProduct() {
    const p = state.page;
    const c = p.collected;
    show(['product', 'rec', 'feedback', 'anchors']);
    $('problem').hidden = true;
    kindPicker(true);
    $('product-name').textContent = c.product && c.product.name ? c.product.name : (c.title || 'This page');
    const brand = c.product && c.product.brand || (p.match && p.match.retailer ? p.match.retailer.brand : null);
    const bits = [brand, safeHost(p.tab.url || c.url) || c.retailer];
    if (p.match && p.match.product) bits.push(`${p.match.retailer.name} product ${p.match.product.code}`);
    if (p.ref) bits.push('Fynd holds this product’s measurements');
    $('product-meta').textContent = bits.filter(Boolean).join(' · ');
    const fallback = F.anchorFor(state.anchors, p.category) ? p.category : (state.anchors[0] && state.anchors[0].category);
    fillCategories($('p-category'), p.category || fallback || 'tshirt');
    if (!p.category) p.category = $('p-category').value;
    drawChart();
  }

  function drawChart() {
    const p = state.page;
    const area = $('chart-area');
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
      const c = p.collected;
      const guides = [...new Set((c.guides || []).filter((g) => g && g.text).map((g) => g.text).concat(Array.isArray(c.guideButtons) ? c.guideButtons : []))].map((t) => `“${t}”`);
      const hint = p.match && p.match.retailer ? p.match.retailer.chartHint
        : guides.length ? `The page has a size guide (${guides.slice(0, 2).join(', ')}): open it on the page, then press Read this page.`
          : 'If the page shows its size chart in a size guide or a pop-up, open it, then press Read this page.';
      const sizes = c.product && c.product.sizes && c.product.sizes.length ? ` The page lists sizes ${c.product.sizes.slice(0, 10).join(', ')}, but no measurements.` : '';
      area.replaceChildren(el('p', 'fp-note', `No size chart found on this page.${sizes} ${hint}`));
      $('chart-actions').hidden = true;
      $('open-fynd-note').textContent = '';
      $('confirm-kind').hidden = true;
      return;
    }
    const head = el('p', 'pop-small', `${MEASURES[chart.measures]} · ${chart.unit ? `in ${chart.unit === 'cm' ? 'centimetres' : chart.unit === 'in' ? 'inches' : 'inches and centimetres'}` : 'unit not stated'} · ${SOURCE_LINE[currentSource()] || ''}`);
    area.replaceChildren(head, chartTable(chart));
    $('chart-actions').hidden = false;
    drawHandover();
    $('use-as-anchor').hidden = chart.measures !== 'finished-garment' && !state.confirmedGarment;
    $('confirm-kind').hidden = !(chart.measures === 'not-stated' && !state.confirmedGarment);
    $('correct').textContent = state.editing ? 'Save corrections' : 'Correct a measurement';
    area.dataset.source = currentSource() || '';
  }
  const MEASURES = { 'finished-garment': 'Garment measurements', body: 'Body measurements', 'not-stated': 'Garment or body not stated' };
  const SOURCE_LINE = { 'fynd-record': 'Fynd’s data, checked by Fynd', 'fynd-record-unverified': 'Fynd’s data, as published — not yet checked', 'retailer-page': 'read from this page in your browser', shopper: 'as you corrected it' };

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

  /* the chart in view, to Find Fit: in the address fragment only */
  /* What "Open in Find Fit" hands over, and so what Fynd's server sees:
       a table read from this page  → #fynd-chart=… : the chart stays in
                                      the address fragment, never sent
       Fynd's own data for it       → #fynd-url=…   : Find Fit looks the
                                      product's address up on Fynd's server
                                      (/api/size-recommendation?chart=)
     Either way, opening Fynd's site is a visit like any other: the page
     loads and asks Fynd's server for the visitor's account. */
  function handover() {
    const p = state.page;
    if (!p) return null;
    const base = `${FYND_SITE.replace(/\/$/, '')}/index.html`;
    const pageIndex = p.chosen && p.chosen.startsWith('page-') ? Number(p.chosen.slice(5)) : null;
    if (pageIndex !== null) {
      const payload = build(p.collected, pageIndex);
      if (payload.chart) return { url: `${base}#fynd-chart=${encode(payload)}`, sends: false };
    }
    const address = p.match && p.match.product ? p.match.product.canonical : (p.ref ? p.ref.url : build(p.collected, null).page.url);
    return address ? { url: `${base}#fynd-url=${encodeURIComponent(address)}`, sends: true, address } : null;
  }
  function openInFynd() {
    const h = handover();
    if (h) chrome.tabs.create({ url: h.url });
  }
  function drawHandover() {
    const h = handover();
    $('open-fynd').hidden = !h;
    $('open-fynd-note').textContent = !h ? ''
      : h.sends
        ? `Open in Find Fit opens Fynd’s website in a new tab and sends this product’s address (${h.address.replace(/^https?:\/\//, '')}) to Fynd’s server, to show Fynd’s record of it.`
        : 'Open in Find Fit opens Fynd’s website in a new tab with this chart in the address after “#”, which browsers don’t send to the server. The site loads as on any visit (with your Fynd account, if you’re signed in).';
  }

  /* ---------- the test report: what was read and how it compared ----------

     For checking a live page by hand, or reporting a problem: plain
     data, copied to the clipboard when the shopper presses the button,
     never sent. The page's address without its query string. */
  function report() {
    const p = state.page;
    const out = {
      fynd: { version: chrome.runtime.getManifest().version, at: new Date().toISOString(), userAgent: navigator.userAgent },
      read: state.lastRead,
      problems: state.log
    };
    if (p) {
      const c = p.collected;
      let address = null;
      try { const u = new URL(p.tab.url || c.url); address = `${u.origin}${u.pathname}`; } catch (err) { address = null; }
      const category = $('p-category').value || p.category;
      out.page = { address, title: c.title, dialogOpen: c.dialogOpen, guideLinks: (c.guides || []).map((g) => g.text), guideButtons: c.guideButtons || [] };
      out.identified = {
        name: c.product && c.product.name, brand: c.product && c.product.brand, code: c.product && c.product.code,
        sizesListed: c.product ? c.product.sizes : [], fit: c.fit,
        retailerModule: p.match && p.match.retailer ? { id: p.match.retailer.id, product: p.match.product } : null,
        kindGuessed: p.category, kindUsed: category,
        fyndHolds: p.ref ? { id: p.ref.id, verification: p.ref.verification } : null
      };
      out.tablesFound = (c.tables || []).length;
      out.charts = p.options.map((o) => ({ key: o.key, label: o.label, source: o.source, where: o.where, measures: o.chart.measures, unit: o.chart.unit || null, columns: o.chart.columns, sizes: o.chart.rows.map((r) => r.size) }));
      out.chosen = p.chosen;
      out.corrected = Boolean(state.corrected);
      const chart = currentChart();
      if (chart) {
        const read = F.readChart(chart, category);
        out.normalised = {
          columns: read.columns,
          issues: read.issues,
          sizes: read.sizes.map((z) => ({ size: z.size, dims: Object.fromEntries(Object.entries(z.dims).map(([id, m]) => [id, { inches: m.value, raw: m.raw, method: m.method, unitBy: m.unitBy, methodBy: m.methodBy }])) }))
        };
      }
      const anchor = F.anchorFor(state.anchors, category);
      out.reference = anchor ? { brand: anchor.brand, category: anchor.category, size: anchor.size, cut: anchor.cut, feel: anchor.feel, tier: anchor.reference ? anchor.reference.tier : null, dims: anchor.dims, outcomes: anchor.feedback.length } : null;
      const r = state.lastResult;
      out.recommendation = r ? { status: r.status, size: r.size || null, confidence: r.confidence || null, confidenceWhy: r.confidenceWhy || [], alternative: r.alternative || null, compared: r.compared || [], notCompared: r.notCompared || [], labelMatch: r.labelMatch || null, explanation: r.explanation, reason: r.reason || null, missing: r.missing || [] } : null;
    }
    return JSON.stringify(out, null, 2);
  }
  async function copyReport() {
    const text = report();
    const box = $('report-text');
    box.value = text;
    try {
      await navigator.clipboard.writeText(text);
      box.hidden = true;
      status('Test report copied. Paste it wherever you’re reporting the result.');
    } catch (err) {
      note('copy the test report', err);
      box.hidden = false;
      box.focus();
      box.select();
      status('Couldn’t copy automatically: the report is below, selected — press Ctrl+C (⌘C on a Mac).');
    }
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
      const add = el('button', 'btn btn-secondary', `Add ${F.CATEGORIES[category] && ['jeans', 'pants', 'shorts'].includes(category) ? '' : 'a '}${kindLower(category)} that fits you`);
      add.type = 'button';
      add.addEventListener('click', () => openForm({ category }));
      $('rec-explain').replaceChildren(el('p', null, `None of your references is cut like this ${kindLower(category)}: tops aren’t compared with bottoms.`), add);
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
    $('rec-anchor').textContent = `Compared with your ${anchor.brand} ${kindLower(anchor.category)} in ${anchor.size}${anchor.reference && anchor.reference.tier !== 'exact' && anchor.reference.tier !== 'page' ? ` (${(TIER_WORDS[anchor.reference.tier] || '').toLowerCase()})` : ''}.`;
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
      const extra = [];
      if (!Object.keys(anchor.dims).length) {
        const fix = el('button', 'btn btn-secondary', 'Add measurements to your reference');
        fix.type = 'button';
        fix.addEventListener('click', () => showReference(anchor));
        extra.push(fix);
      }
      $('rec-explain').replaceChildren(...result.explanation.map((t) => el('p', null, t)), ...extra);
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

  $('anchor-form').addEventListener('submit', (e) => { submitForm(e).catch((err) => { note('save the reference', err); $('anchor-error').textContent = `Fynd couldn’t save this reference: ${err && err.message || err}`; }); });
  $('anchor-cancel').addEventListener('click', () => { state.pending = null; refresh(); });
  $('manual-save').addEventListener('click', () => saveManual().catch((err) => { note('save measurements', err); status('Fynd couldn’t save those measurements.'); }));
  $('resolve-skip').addEventListener('click', () => { state.pending = null; status(''); refresh(); read({ how: 'after-reference' }); });
  $('add-anchor').addEventListener('click', () => openForm());
  $('read').addEventListener('click', () => { status(''); read({ how: 'button' }); });
  $('p-category').addEventListener('change', () => { if (state.page) { state.page.category = $('p-category').value; recommendNow(); } });
  $('correct').addEventListener('click', toggleCorrect);
  $('open-fynd').addEventListener('click', openInFynd);
  $('copy-report').addEventListener('click', copyReport);
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
    const origin = state.grantFor;
    if (!origin) return;
    let ok = false;
    try { ok = await chrome.permissions.request({ origins: [origin] }); } catch (err) { note('ask for site access', err, { origin }); }
    $('grant').hidden = true;
    status(ok ? `Fynd will read ${origin.replace(/^https:\/\/|\/\*$/g, '')} product pages as you open them. Turn it off any time in Chrome’s extension settings.` : 'Not allowed — click Fynd in the toolbar on each page instead.');
  });
  document.querySelectorAll('[data-outcome]').forEach((b) => b.addEventListener('click', () => recordOutcome(b.dataset.outcome)));
  document.querySelectorAll('.fp-unit .fp-chip').forEach((b) => b.addEventListener('click', async () => {
    state.settings.unit = b.dataset.unit;
    await saveSettings();
    refresh();
  }));

  /* a press on the toolbar button (background.js) */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'fynd:read' && typeof msg.tabId === 'number') { status(''); read({ tabId: msg.tabId, how: 'toolbar' }); }
  });

  /* follow the shopper: a new page in the tab, or another tab. Pages
     Fynd may not read say "click Fynd", nothing more. */
  if (!fixedTab && chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, info, tab) => { if (info.status === 'complete' && tab.active) read({ how: 'navigated' }); });
    chrome.tabs.onActivated.addListener(() => read({ how: 'switched-tab' }));
  }

  (async () => {
    try {
      await load();
    } catch (err) {
      note('load your references', err);
      status('Fynd couldn’t load your saved references from Chrome’s storage. Reload the panel; if it persists, see the console.');
    }
    if (!DATA || !Array.isArray(DATA.products)) { note('load reference data', 'vendor/fit-reference-data.js is missing'); status('Fynd’s reference data is missing from this copy of the extension.'); }
    refresh();
    /* opened by a toolbar press: read the tab it was pressed on */
    let pressed = null;
    try { pressed = (await chrome.storage.session.get('fyndPressed')).fyndPressed; } catch (err) { note('read the toolbar press', err); }
    if (state.anchors.length) read({ tabId: pressed && Date.now() - pressed.at < 60000 ? pressed.tabId : null, how: pressed ? 'toolbar' : 'opened' });
  })();
})();
