/* =========================================================
   Fynd — Find Fit: a product in, its sizing chart out

   A product comes from the brand browser (findItem, below) or as a link
   pasted under "Have a link…". When a whole link is pasted, or Enter or
   "Find sizing chart" is pressed —
   never on each keystroke — the link goes to the server
   (Account.sizing.chart: /api/size-recommendation?chart=, which reads
   only public pages, on its own side; see api/_sizing/chart.js) and the
   answer is drawn here by assets/size-chart.js: the product's name, the
   chart as published and what it measures, or briefly why there isn't
   one; where it came from is under "Source details". The product's own
   page stays a click away ("View product"), without tracking parameters.

   From the Fynd browser extension (extension/), the address arrives
   carrying either a chart it read in the shopper's own browser
   (#fynd-chart=…, checked by assets/fynd-payload.js before anything is
   drawn) or just a product's address (#fynd-url=…, looked up as if it
   had been pasted). The fragment never reaches a server, and it is
   cleared from the address as soon as it is read. A chart from the
   extension is shown as read from the browser and not checked — never
   verified, never comparable — with a way to look the product up in
   Fynd's catalog of checked charts.

   The home page's main path is the brand browser (assets/brand-browser.js):
   a product picked there comes to findItem with its brand and code, and
   the server finds its address. A link pasted under "Have a link…" comes
   to find. Both end in the same result.

   No account is needed. Signed in, a chart Fynd has checked
   finished-garment measurements for is also set beside the shopper's
   saved reference garment (Account.sizing.compare: the engine's own
   comparison, read from their own profile on the server — nothing from
   the profile travels in any address). Any other chart says why it
   can't be compared; a chart is never a recommendation by itself.
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
  const { el, safeLink, render, renderFailure, headingFor, cleanUrl } = global.SizeChart;

  let latest = 0;
  let lastAsked = '';

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
    compare.hidden = true;
    compare.replaceChildren();
    productLink(cleanUrl(url));
    $('fit-result-title').textContent = title;
    body.replaceChildren(el('p', 'size-chart-loading', waiting));
    $('fit-url-submit').disabled = true;
    if (product) result.scrollIntoView({ block: 'start', behavior: 'auto' });

    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await request(sizing) : { ok: false, unreachable: true };
    if (ask !== latest) return;
    $('fit-url-submit').disabled = false;

    if (!(answer.ok && answer.data && answer.data.chart)) {
      result.dataset.state = 'error';
      $('fit-result-title').textContent = product ? product.named : 'Sizing chart unavailable';
      body.replaceChildren(...renderFailure(answer, url, { linked: true }));
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
    body.replaceChildren(...render(chart, url, { linked: true }));
    $('fit-result-title').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: 'auto' });
    /* a fallback says why it can't be compared, like any body chart */
    if (chart.status === 'ok' || chart.status === 'fallback') compareWith(chart, ask);
  }

  /* The fit profile's part, only where the chart supports it: drawn by
     assets/fit-compare.js, shared with the product page's Size Guide. */
  function compareWith(chart, ask) {
    return global.FitCompare.show(chart, compare, () => ask === latest);
  }

  function submit() {
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
  input.addEventListener('input', () => { if (error.textContent) say(''); });

  /* A chart the Fynd extension read in this browser: checked, drawn as
     read from the browser and unverified, never compared. */
  function showExtensionChart(payload) {
    const ask = ++latest;
    const url = payload.page.url;
    lastAsked = url;
    input.value = url;
    say('');
    const chart = global.FyndPayload.toChart(payload);
    result.hidden = false;
    result.dataset.state = chart.status;
    result.dataset.from = 'extension';
    compare.hidden = true;
    compare.replaceChildren();
    $('fit-result-title').textContent = headingFor(chart);
    productLink(url);
    const lookup = el('button', 'btn btn-secondary fit-catalog', 'Check Fynd’s catalog for this product');
    lookup.type = 'button';
    lookup.addEventListener('click', () => find(url));
    const offer = el('p', 'fit-catalog-line');
    offer.append(el('span', null, 'Fynd may have a checked chart for this product. '), lookup);
    body.replaceChildren(...render(chart, url, { linked: true }), offer);
    $('fit-result-title').focus({ preventScroll: true });
    result.scrollIntoView({ block: 'start', behavior: 'auto' });
    if (chart.status === 'ok') compareWith(chart, ask);
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
      $('fit-link-alt').open = true;
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
      body.replaceChildren(el('p', 'size-chart-note', 'The link from the Fynd extension wasn’t a chart Fynd could read, so nothing from it is shown. Check the product page again with the extension, or paste the product’s link above.'));
      return;
    }
    showExtensionChart(got.payload);
  }
  fromExtension();
  global.addEventListener('hashchange', fromExtension);

  global.FindFit = { readLink, find, findItem, fromExtension };
})(typeof window !== 'undefined' ? window : globalThis);
