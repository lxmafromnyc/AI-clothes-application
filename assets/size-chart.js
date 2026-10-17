/* =========================================================
   Fynd — "View sizing chart", on the search page

   Each real listing carries a "View sizing chart" button (drawn by
   productCard in assets/app.js). Pressed, it asks the server for that
   one product's chart — /api/size-recommendation?chart=<its link>, see
   api/_sizing/chart.js — and shows the answer in a dialog over the
   results, so the shopper never leaves them. Nothing is fetched until
   a button is pressed.

   What the dialog shows is what the server said, and only that: the
   product, the market, what each table measures (the body, the
   garment, or not stated), the values as the brand wrote them, the
   source with its link, whether the chart is this product's own or a
   page's, whether anybody has checked it, and a short note built from
   the same facts. When there is no chart, it says why, and links to the
   brand's page. Everything read from a page is drawn as text.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const dialog = doc && doc.getElementById('size-chart');
  if (!dialog) return;
  const body = doc.getElementById('size-chart-body');

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  /* only the brand's own https pages are ever linked */
  const safeLink = (url, text) => {
    const a = el('a', 'guide-link', text);
    if (/^https:\/\/[^\s"'<>]+$/i.test(String(url || ''))) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  };

  const KIND = {
    body: 'Body measurements — the body each size is cut for, not the garment',
    'finished-garment': 'Finished-garment measurements — the clothing itself',
    'not-stated': 'Not stated — the page doesn’t say whether these measure the body or the garment'
  };
  const SCOPE = {
    'product-specific': 'This product’s own chart',
    'product-page': 'Published on this product’s page'
  };
  const STATUS = {
    verified: 'Verified — checked by a person against the brand’s page',
    unverified: 'Unverified — copied from the brand’s page, not yet checked',
    'not-verified': 'Not verified — read automatically just now'
  };
  const UNIT = { in: 'inches', cm: 'centimetres', both: 'inches and centimetres', null: 'not stated' };

  let asking = 0;
  let opener = null;

  function open(button) {
    opener = button;
    const ask = ++asking;
    body.replaceChildren(el('p', 'size-chart-loading', 'Finding this product’s sizing…'));
    dialog.dataset.state = 'loading';
    doc.getElementById('size-chart-product').textContent = [button.dataset.brand, button.dataset.name].filter(Boolean).join(' · ');
    if (!dialog.open) dialog.showModal();
    const sizing = global.Account && global.Account.sizing;
    const request = sizing ? sizing.chart(button.dataset.chart) : Promise.resolve({ ok: false, unreachable: true });
    request.then((result) => {
      if (ask !== asking) return;
      if (result.ok && result.data && result.data.chart) render(result.data.chart, button);
      else failed(result, button);
    });
  }

  function failed(result, button) {
    dialog.dataset.state = 'error';
    const why = result.status === 429 ? 'Fynd has been asked for a lot of sizing charts just now. Try again in a few minutes.'
      : result.unreachable ? 'Fynd’s sizing service couldn’t be reached, so no chart could be read.'
        : 'Fynd couldn’t read a sizing chart for this product just now.';
    body.replaceChildren(el('p', 'size-chart-note', why), linkLine(button.dataset.chart, 'See the product’s own page'));
  }

  function linkLine(url, text) {
    const p = el('p', 'size-chart-source');
    p.append(safeLink(url, text));
    return p;
  }

  function render(chart, button) {
    dialog.dataset.state = chart.status;
    const out = [];
    const product = chart.product || {};
    const name = [product.brand || button.dataset.brand, product.name || button.dataset.name].filter(Boolean).join(' · ');
    doc.getElementById('size-chart-product').textContent = name;

    const notes = el('ul', 'size-chart-notes');
    (chart.note || []).forEach((line) => notes.append(el('li', null, line)));
    out.push(notes);

    if (chart.status !== 'unavailable') {
      const facts = el('dl', 'size-chart-facts');
      const fact = (label, value) => { if (value) facts.append(el('dt', null, label), el('dd', null, value)); };
      fact('Market', chart.market ? `${chart.market}${chart.line ? ` · ${chart.line === 'men' ? 'men’s' : chart.line === 'women' ? 'women’s' : chart.line} sizing` : ''}` : 'Not stated');
      fact('Chart', SCOPE[chart.scope]);
      fact('Status', STATUS[chart.verification]);
      out.push(facts);
    }

    (chart.charts || []).forEach((c, i) => {
      const section = el('section', 'size-chart-table');
      section.append(el('h3', 'size-chart-kind', KIND[c.measures] || KIND['not-stated']));
      if (c.title) section.append(el('p', 'size-chart-caption', c.title));
      section.append(el('p', 'size-chart-unit', `Units: ${UNIT[c.unit] || UNIT.null}`));
      const wrap = el('div', 'size-chart-scroll');
      const table = el('table', 'compare-table');
      table.id = `size-chart-t${i}`;
      const caption = el('caption', 'sr-only', `${KIND[c.measures] || ''}, by size`);
      const head = el('thead');
      const hr = el('tr');
      ['Size'].concat(c.columns).forEach((h) => { const th = el('th', null, h); th.scope = 'col'; hr.append(th); });
      head.append(hr);
      const tbody = el('tbody');
      c.rows.forEach((r) => {
        const tr = el('tr');
        const th = el('th', null, r.size);
        th.scope = 'row';
        tr.append(th, ...r.values.map((v) => el('td', null, v || '—')));
        tbody.append(tr);
      });
      table.append(caption, head, tbody);
      wrap.append(table);
      section.append(wrap);
      out.push(section);
    });

    if (chart.status === 'labels-only' && chart.sizes.length) {
      out.push(el('p', 'size-chart-labels', `Sizes listed: ${chart.sizes.join(', ')} (labels only — no measurements).`));
    }

    /* a chart isn't a recommendation: only a checked garment chart can
       be set beside a reference, and that is the fit profile's job */
    if (chart.comparable) {
      out.push(el('p', 'size-chart-fit', 'These finished-garment measurements are checked, so Fynd can compare this product with a reference garment saved on your fit profile. A size from that comparison shows on the product’s card.'));
    }

    const src = chart.source || {};
    const source = el('p', 'size-chart-source');
    /* with no chart, the page is a place to look, not a source */
    source.append(el('span', null, chart.status === 'unavailable' ? 'Product page: ' : 'Source: '), safeLink(src.url || button.dataset.chart, src.title || 'the product’s page'));
    if (src.retrievedAt) source.append(el('span', null, ` · read ${src.retrievedAt}`));
    out.push(source);
    (chart.otherSources || []).forEach((s) => {
      const p = el('p', 'size-chart-source');
      p.append(el('span', null, 'Also: '), safeLink(s.url, s.what || s.url));
      out.push(p);
    });
    body.replaceChildren(...out);
  }

  doc.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('.item-chart');
    if (button) { event.preventDefault(); open(button); return; }
    if (event.target === dialog) dialog.close();
  });
  doc.getElementById('size-chart-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    asking += 1;
    if (opener && opener.isConnected) opener.focus();
  });

  global.SizeChart = { open };
})(typeof window !== 'undefined' ? window : globalThis);
