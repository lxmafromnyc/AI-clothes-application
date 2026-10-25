/* =========================================================
   Fynd — Find Fit: which size of an item is most likely to fit like a
   garment the shopper already owns

     1  the reference — the garments saved on the fit profile
        (assets/find-fit-reference.js)
     2  the item — a pasted product link, or a product picked in the
        brand browser (assets/brand-browser.js calls FindFit.select)
     →  "Compare fit" (or Enter, or a whole link pasted): the item's
        sizing chart, from Fynd's records or the product's own page
        (Account.sizing.chart: /api/size-recommendation?chart=, or
        ?brand=&item= for a picked product — the server finds its
        address itself; api/_sizing/chart.js), then the engine's own
        comparison with the shopper's reference (assets/fit-compare.js,
        verdict layout: /api/size-recommendation?product=&compare=1)

   The result leads with the verdict: a size only where the engine
   recommends one, or a heading that says there is none and exactly why
   — a chart nobody has checked, a body chart, no reference saved, too
   few measurements taken the same way. The chart as published, and
   where it came from, sit folded under "Size chart and source". Nothing
   from the profile travels in any address; the product page stays a
   click away, without tracking parameters.

   From the Fynd browser extension (extension/), the address arrives
   carrying either a chart it read in the shopper's own browser
   (#fynd-chart=…, checked by assets/fynd-payload.js before anything is
   drawn) or just a product's address (#fynd-url=…, looked up as if it
   had been pasted). The fragment never reaches a server, and it is
   cleared from the address as soon as it is read. A chart from the
   extension is shown as read from the browser and not checked — never
   verified, never compared — with a way to look the product up in
   Fynd's catalog of checked charts.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const form = doc && doc.getElementById('fit-url-form');
  if (!form || !global.SizeChart) return;

  const $ = (id) => doc.getElementById(id);
  const input = $('fit-url');
  const error = $('fit-url-error');
  const result = $('fit-result');
  const body = $('fit-result-body');
  const compare = $('fit-compare');
  const chartBox = $('fit-chart-details');
  const picked = $('ff-picked');
  const { el, safeLink, render, renderFailure, headingFor, cleanUrl } = global.SizeChart;

  let latest = 0;
  let lastAsked = '';
  /* a product picked in the brand browser: { brand, product }, until the link changes */
  let choice = null;

  /* ---------- checking first ----------
     As soon as there is an item and a reference, Find Fit asks whether
     they can be compared at all (Account.sizing.check: Fynd's records
     and the engine's own preconditions, engine.validate — nothing
     fetched). When the answer confirms a comparison can't happen, it is
     said right under the item, before anything is compared, and
     Compare fit is turned off; viewing the chart, opening the product
     page and editing the reference stay. Any doubt — no answer, an
     error — leaves Compare fit as it was. */
  const checkBox = $('ff-check');
  const submitButton = $('fit-url-submit');
  let blocked = false;
  /* a link the Fynd extension handed over: nothing about it is sent
     anywhere until the shopper asks (Check Fynd's catalog) or edits it */
  let quietUrl = null;
  let checkAsk = 0;
  let checkTimer = null;
  const CHECK_HEADING = {
    'invalid-url': 'That isn’t a product link Fynd can use',
    'blocked-address': 'Fynd doesn’t look up that address',
    'unsupported-retailer': 'Fynd doesn’t support this shop yet',
    'missing-target': 'No checked measurements for this item',
    unverified: 'This item’s measurements aren’t verified yet',
    'body-only': 'Only body measurements for this item',
    methods: 'Measured differently from your garment',
    'missing-reference': 'Your garment’s measurements are missing'
  };
  function setBlocked(on) {
    blocked = on;
    submitButton.disabled = on;
    if (on) submitButton.setAttribute('aria-describedby', 'ff-check');
    else submitButton.removeAttribute('aria-describedby');
  }
  function clearCheck() {
    checkAsk += 1;
    checkBox.replaceChildren();
    checkBox.hidden = true;
    delete checkBox.dataset.status;
    setBlocked(false);
  }
  /* the item as it stands: a picked product, or a whole link — or none */
  function targetNow() {
    if (quietUrl && input.value === quietUrl) return null;
    if (choice && input.value.trim() === (choice.product.url || '')) return { brand: choice.brand.id, code: choice.product.code };
    const link = readLink(input.value);
    return link.error ? null : { url: link.url };
  }
  /* a new item or reference makes the last answer stale: it goes at
     once, and Compare fit is back until the new one says otherwise */
  function scheduleCheck(now) {
    clearCheck();
    global.clearTimeout(checkTimer);
    checkTimer = global.setTimeout(runCheck, now ? 0 : 400);
  }
  async function runCheck() {
    const target = targetNow();
    if (!target) { clearCheck(); return; }
    const sizing = global.Account && global.Account.sizing;
    if (!sizing || !sizing.check) return;
    const ask = ++checkAsk;
    const reference = global.FindFitReference ? global.FindFitReference.unsaved() : null;
    const got = await sizing.check(target, reference);
    if (ask !== checkAsk) return;
    const check = got && got.ok && got.data && got.data.check;
    if (!check || typeof check !== 'object') { clearCheck(); return; }
    drawCheck(check, target);
  }
  function drawCheck(check, target) {
    const v = check.validation && typeof check.validation === 'object' ? check.validation : null;
    const t = check.target || {};
    const status = ['invalid-url', 'blocked-address', 'unsupported-retailer'].includes(t.status) ? t.status : (v && v.status) || 'missing-target';
    if (check.comparable && v && v.ready) {
      setBlocked(false);
      const lines = [el('p', 'ff-check-ok', v.explanation)];
      checkBox.replaceChildren(...lines);
      checkBox.dataset.status = 'ready';
      checkBox.hidden = false;
      return;
    }
    const nodes = [el('p', 'ff-check-title', CHECK_HEADING[status] || CHECK_HEADING['missing-target'])];
    if (v && typeof v.explanation === 'string') nodes.push(el('p', null, v.explanation));
    else if (status === 'invalid-url') nodes.push(el('p', null, 'Paste the full address of a clothing product’s page.'));
    else if (status === 'blocked-address') nodes.push(el('p', null, 'Fynd only looks up public product pages.'));
    /* which retailer can't be read is not the same as which measurements are missing */
    if (t.pages && t.pages !== 'readable' && status !== 'invalid-url' && status !== 'blocked-address') {
      nodes.push(el('p', 'ff-check-access', t.pages === 'not-permitted'
        ? `${t.host || 'This shop'}’s terms don’t allow Fynd to read its pages.`
        : `Fynd doesn’t read ${t.host || 'this shop'}’s pages: it hasn’t confirmed their terms allow it.`));
    }
    const dims = v && Array.isArray(v.dimensions) ? v.dimensions.filter((d) => d && !d.compared && typeof d.why === 'string') : [];
    if (status === 'methods' && dims.length) {
      const ul = el('ul', 'ff-check-dims');
      dims.forEach((d) => { const li = el('li', null, `${DIM_WORDS[d.dim] || d.dim}: ${d.why}`); li.dataset.dim = d.dim; ul.append(li); });
      nodes.push(ul);
    }
    if (v && Array.isArray(v.next) && typeof v.next[0] === 'string') nodes.push(el('p', 'ff-check-next', v.next[v.next.length - 1]));
    /* what can still be done */
    const actions = el('p', 'ff-check-actions');
    if (check.chart && check.chart !== 'none') {
      const view = el('button', 'btn btn-secondary ff-check-view', 'View size chart');
      view.type = 'button';
      view.addEventListener('click', () => lookupTarget(target));
      actions.append(view);
    }
    if (t.url && /^https:\/\//.test(t.url)) {
      const open = safeLink(t.url, 'Open product page');
      open.classList.add('ff-check-open');
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      actions.append(open);
    }
    if (status === 'missing-reference' || status === 'methods') {
      const edit = el('a', 'guide-link ff-check-edit', 'Edit your garment');
      edit.href = '#ff-step-reference';
      actions.append(edit);
    }
    if (actions.childNodes.length) nodes.push(actions);
    checkBox.replaceChildren(...nodes);
    checkBox.dataset.status = status;
    checkBox.hidden = false;
    setBlocked(true);
  }
  const DIM_WORDS = { chestWidth: 'Chest', bodyLength: 'Length', shoulderWidth: 'Shoulders', sleeveLength: 'Sleeves' };
  /* the chart, looked up as Compare fit would, even while comparing is off */
  function lookupTarget(target) {
    if (target.brand && choice) return findItem(choice.brand, choice.product);
    return target.url ? find(target.url) : undefined;
  }

  /* no checked garment measurements to compare: Find Fit's own heading for it */
  const UNSUPPORTED = 'Fynd can’t compare this item yet';

  /* The result's lead: the verdict — what was found out, or why nothing
     could be — in the place a shopper looks first. */
  function verdict(title, nodes, state) {
    compare.replaceChildren(el('h3', 'fit-compare-title', title), ...nodes);
    compare.dataset.verdict = state;
    compare.hidden = false;
  }
  /* the item's chart as published, and where it came from: there to
     check, folded away under the verdict */
  function showChart(nodes) {
    body.replaceChildren(...nodes);
    chartBox.open = false;
    chartBox.hidden = false;
  }
  function hideChart() {
    body.replaceChildren();
    chartBox.hidden = true;
  }

  /* A whole http(s) link to somewhere with a name, or why not. */
  function readLink(raw) {
    const text = String(raw || '').trim();
    if (!text) return { error: 'Paste a link to a clothing product’s page first.' };
    let u;
    try { u = new URL(text); } catch (err) {
      return { error: 'That isn’t a valid product link. Paste the full address of a product page, starting with https://.' };
    }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) {
      return { error: 'That isn’t a product page link. Paste an address starting with https:// from a clothing shop.' };
    }
    return { url: u.href };
  }

  /* "View product", and the shop it is on */
  function productLink(url) {
    const line = $('fit-result-product');
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (err) { /* shown without */ }
    line.replaceChildren(safeLink(url, 'View product'));
    if (host) line.append(el('span', 'fit-result-host', ` · ${host}`));
  }

  function say(text) {
    error.textContent = text || '';
    error.classList.toggle('show', Boolean(text));
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  /* A pasted link: its chart, looked up by its address. */
  function find(url) {
    lastAsked = url;
    return lookup(url, null, 'Finding this product’s sizing chart…', 'Reading the product’s page and any size guide it links to…',
      (sizing) => sizing.chart(url));
  }

  /* A product picked in the brand browser (assets/brand-browser.js):
     its chart, asked for by the brand and the product's code. The
     server finds the product's address itself. */
  function findItem(brand, product) {
    const named = `${brand.name} · ${product.name}`;
    return lookup(product.url, Object.assign({ named }, product), named, 'Looking up this product’s sizing chart. Reading the brand’s page can take a few seconds…',
      (sizing) => sizing.item(brand.id, product.code));
  }

  async function lookup(url, product, title, waiting, request) {
    const ask = ++latest;
    say('');
    result.hidden = false;
    result.dataset.state = 'loading';
    delete result.dataset.from;
    if (product) result.dataset.item = product.code;
    else delete result.dataset.item;
    hideChart();
    if (global.FindFitSave) global.FindFitSave.hide();
    verdict('Comparing…', [el('p', 'size-chart-loading', waiting)], 'loading');
    productLink(cleanUrl(url));
    $('fit-result-title').textContent = title;
    submitButton.disabled = true;
    if (product) result.scrollIntoView({ block: 'start', behavior: 'auto' });

    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await request(sizing) : { ok: false, unreachable: true };
    if (ask !== latest) return;
    submitButton.disabled = blocked;

    if (!(answer.ok && answer.data && answer.data.chart)) {
      result.dataset.state = 'error';
      $('fit-result-title').textContent = product ? product.named : 'Sizing chart unavailable';
      verdict(UNSUPPORTED, renderFailure(answer, url, { linked: true }), 'unsupported');
      attempted(ask);
      return;
    }
    const chart = answer.data.chart;
    result.dataset.state = chart.status;
    /* a picked product keeps the name its brand listing gave, when its
       page couldn't say */
    $('fit-result-title').textContent = product && !(chart.product && chart.product.name) ? product.named : headingFor(chart);
    /* the server's canonical page for it, when it gave one */
    const page = chart.source && chart.source.url;
    if (page && /^https?:\/\//.test(page)) productLink(page);
    const drawn = render(chart, url, { linked: true });
    /* a chart to compare: the verdict leads, the chart folds away. No
       chart: what was found out is the verdict itself. */
    if (chart.status === 'ok' || chart.status === 'fallback') {
      showChart(drawn);
      verdict('Comparing…', [el('p', 'size-chart-loading', 'Setting this item beside your reference…')], 'loading');
    } else {
      hideChart();
      verdict(UNSUPPORTED, drawn, 'unsupported');
    }
    $('fit-result-title').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: 'auto' });
    /* a fallback says why it can't be compared, like any body chart */
    if (chart.status === 'ok' || chart.status === 'fallback') await compareWith(chart, ask);
    attempted(ask);
  }

  /* The comparison, only where the chart supports it: the engine's own,
     drawn by assets/fit-compare.js in Find Fit's verdict layout — with
     the saved reference, or else the garment described this visit
     (sent in the request body, kept nowhere). */
  function compareWith(chart, ask) {
    const reference = global.FindFitReference ? global.FindFitReference.unsaved() : null;
    return global.FitCompare.show(chart, compare, () => ask === latest, Object.assign({ verdict: true }, reference ? { reference } : {}));
  }

  /* once the result of a comparison is on screen, and only then: the
     offer to save this visit's garment (assets/find-fit-save.js) */
  function attempted(ask) {
    if (ask === latest && global.FindFitSave) global.FindFitSave.offer();
  }

  /* A product picked in the brand browser becomes the item: named, with
     what Fynd holds for its sizing, its own page a click away, and its
     link in the box — until the link is changed. */
  function select(brand, product) {
    choice = { brand, product };
    input.value = product.url || '';
    say('');
    const line = el('p', 'ff-picked-name');
    line.append(el('strong', null, `${brand.name} · ${product.name}`));
    const page = el('a', 'guide-link ff-picked-page', 'View its page');
    page.href = `product.html?${new URLSearchParams({ brand: brand.id, item: product.code })}`;
    const clear = el('button', 'ff-picked-clear', 'Clear');
    clear.type = 'button';
    clear.addEventListener('click', () => { unselect(); input.value = ''; input.focus(); });
    const actions = el('p', 'ff-picked-actions');
    actions.append(page, clear);
    picked.replaceChildren(line, el('p', 'ff-picked-holds', product.holdsText || ''), actions);
    picked.hidden = false;
    scheduleCheck(true);
    $('fit-url-submit').focus();
  }
  function unselect() {
    choice = null;
    picked.replaceChildren();
    picked.hidden = true;
    scheduleCheck();
  }

  function submit() {
    /* known not to be comparable: Enter shows what can still be shown —
       the item's chart, with why it isn't compared — never a comparison */
    if (blocked) {
      const target = targetNow();
      if (target) lookupTarget(target);
      return;
    }
    if (choice && input.value.trim() === (choice.product.url || '')) { findItem(choice.brand, choice.product); return; }
    const link = readLink(input.value);
    if (link.error) { say(link.error); input.focus(); return; }
    find(link.url);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  /* a whole link pasted is a request; typing one is not, until Enter */
  input.addEventListener('paste', () => {
    global.setTimeout(() => {
      const link = readLink(input.value);
      if (!link.error && link.url !== lastAsked) find(link.url);
    }, 0);
  });
  input.addEventListener('input', () => {
    quietUrl = null;
    if (error.textContent) say('');
    if (choice && input.value.trim() !== (choice.product.url || '')) unselect();
    scheduleCheck();
  });
  doc.addEventListener('fynd:reference-change', () => scheduleCheck(true));

  /* A chart the Fynd extension read in this browser: checked, drawn as
     read from the browser and unverified, never compared. */
  function showExtensionChart(payload) {
    ++latest;
    const url = payload.page.url;
    lastAsked = url;
    quietUrl = url;
    clearCheck();
    input.value = url;
    say('');
    const chart = global.FyndPayload.toChart(payload);
    result.hidden = false;
    result.dataset.state = chart.status;
    result.dataset.from = 'extension';
    $('fit-result-title').textContent = headingFor(chart);
    productLink(url);
    const lookup = el('button', 'btn btn-secondary fit-catalog', 'Check Fynd’s catalog for this product');
    lookup.type = 'button';
    lookup.addEventListener('click', () => find(url));
    const offer = el('p', 'fit-catalog-line');
    offer.append(el('span', null, 'Fynd may have a checked chart for this product. '), lookup);
    showChart(render(chart, url, { linked: true }));
    /* what the chart itself is — body only, measured how it doesn't say,
       or not checked — with the same reasons a pasted link's would give */
    const state = global.FitCompare ? global.FitCompare.chartState(chart) : 'unsupported';
    verdict(global.FitCompare ? global.FitCompare.HEADING[state] : UNSUPPORTED, [
      el('p', null, 'This chart was read from the page open in your browser and hasn’t been checked, so Fynd won’t compare it with a garment you own.'),
      ...(global.FitCompare ? global.FitCompare.whyNot(chart, true) : []).map((t) => el('p', null, t)),
      offer
    ], state);
    $('fit-result-title').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  /* #fynd-chart=… or #fynd-url=…, from the extension: read once, then
     cleared from the address */
  function fromExtension() {
    const hash = global.location.hash || '';
    const chartIn = /^#fynd-chart=([A-Za-z0-9_-]{1,30000})$/.exec(hash);
    const urlIn = /^#fynd-url=([^#]{1,4000})$/.exec(hash);
    if (!chartIn && !urlIn && !/^#fynd-(chart|url)=/.test(hash)) return;
    global.history.replaceState(null, '', global.location.pathname + global.location.search);
    if (urlIn) {
      let raw = '';
      try { raw = decodeURIComponent(urlIn[1]); } catch (err) { /* refused below */ }
      const link = readLink(raw);
      if (link.error) { say(link.error); return; }
      /* the extension asked for one lookup of this product: that, and nothing more */
      quietUrl = link.url;
      input.value = link.url;
      find(link.url);
      return;
    }
    const got = chartIn && global.FyndPayload ? global.FyndPayload.decode(chartIn[1]) : { error: 'unreadable' };
    if (got.error) {
      result.hidden = false;
      result.dataset.state = 'error';
      result.dataset.from = 'extension';
      $('fit-result-title').textContent = 'This chart couldn’t be opened';
      $('fit-result-product').replaceChildren();
      hideChart();
      verdict(UNSUPPORTED, [el('p', 'size-chart-note', 'The link from the Fynd extension wasn’t a chart Fynd could read, so nothing from it is shown. Check the product page again with the extension, or paste the product’s link above.')], 'unsupported');
      return;
    }
    showExtensionChart(got.payload);
  }
  fromExtension();
  global.addEventListener('hashchange', fromExtension);

  global.FindFit = { readLink, find, findItem, select, fromExtension };
})(typeof window !== 'undefined' ? window : globalThis);
