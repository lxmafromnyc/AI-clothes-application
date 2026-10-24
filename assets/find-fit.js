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
    verdict('Comparing…', [el('p', 'size-chart-loading', waiting)], 'loading');
    productLink(cleanUrl(url));
    $('fit-result-title').textContent = title;
    $('fit-url-submit').disabled = true;
    if (product) result.scrollIntoView({ block: 'start', behavior: 'auto' });

    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await request(sizing) : { ok: false, unreachable: true };
    if (ask !== latest) return;
    $('fit-url-submit').disabled = false;

    if (!(answer.ok && answer.data && answer.data.chart)) {
      result.dataset.state = 'error';
      $('fit-result-title').textContent = product ? product.named : 'Sizing chart unavailable';
      verdict(UNSUPPORTED, renderFailure(answer, url, { linked: true }), 'unsupported');
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
    if (chart.status === 'ok' || chart.status === 'fallback') compareWith(chart, ask);
  }

  /* The comparison, only where the chart supports it: the engine's own,
     drawn by assets/fit-compare.js in Find Fit's verdict layout. */
  function compareWith(chart, ask) {
    return global.FitCompare.show(chart, compare, () => ask === latest, { verdict: true });
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
    $('fit-url-submit').focus();
  }
  function unselect() {
    choice = null;
    picked.replaceChildren();
    picked.hidden = true;
  }

  function submit() {
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
    if (error.textContent) say('');
    if (choice && input.value.trim() !== (choice.product.url || '')) unselect();
  });

  /* A chart the Fynd extension read in this browser: checked, drawn as
     read from the browser and unverified, never compared. */
  function showExtensionChart(payload) {
    ++latest;
    const url = payload.page.url;
    lastAsked = url;
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
