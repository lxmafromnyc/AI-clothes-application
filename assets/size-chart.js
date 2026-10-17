/* =========================================================
   Fynd — drawing a product’s sizing chart

   The drawing of one sizing-chart answer, shared by Find Fit
   (index.html, assets/find-fit.js) and the search page.

   Each real search listing carries a "View sizing chart" button (drawn by
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
  if (!doc) return;

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  /* only plain web pages are ever linked */
  const safeLink = (url, text) => {
    const a = el('a', 'guide-link', text);
    if (/^https?:\/\/[^\s"'<>]+$/i.test(String(url || ''))) {
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
    'product-page': 'Published on this product’s page',
    'linked-size-guide': 'The retailer’s size guide linked from the product page — possibly a general chart, not this product’s own',
    'brand-general': 'The brand’s general chart for this kind of product — a fallback, not this product’s own'
  };
  const STATUS = {
    verified: 'Verified — checked by a person against the brand’s page',
    unverified: 'Unverified — copied from the brand’s page, not yet checked',
    'not-verified': 'Not verified — read automatically just now',
    'official-general': 'Official values, copied from the brand’s own pages — not read from this product’s page'
  };
  const UNIT = { in: 'inches, as published', cm: 'centimetres, as published', both: 'inches and centimetres, as published', null: 'not stated — check the source' };
  const LINE = { men: 'men’s', women: 'women’s', unisex: 'unisex' };

  /* The nodes for one answer from /api/size-recommendation?chart=:
     what the server said, drawn as text. `asked` is the link the
     shopper gave, kept beside the answer it produced. */
  function render(chart, asked) {
    const out = [];
    const notes = el('ul', 'size-chart-notes');
    (chart.note || []).forEach((line) => notes.append(el('li', null, line)));
    out.push(notes);

    const facts = el('dl', 'size-chart-facts');
    const fact = (label, value) => { if (value) facts.append(el('dt', null, label), el('dd', null, value)); };
    if (chart.retailer) fact('Retailer', chart.retailer);
    /* what the page did say about the product, when it gave no chart —
       or, for a fallback, the product as Fynd knows it */
    if ((chart.status === 'unavailable' || chart.status === 'fallback') && chart.product && chart.product.name) {
      fact('Product', [chart.product.brand, chart.product.name].filter(Boolean).join(' · '));
    }
    const details = chart.details || {};
    if (details.fit) fact('Fit, as the page says', details.fit);
    if (details.material) fact('Fabric, as the page says', details.material);
    if (chart.status !== 'unavailable') {
      fact('Market', chart.market ? `${chart.market}${chart.line && LINE[chart.line] ? ` · ${LINE[chart.line]} sizing` : ''}` : 'Not stated');
      fact('Chart', SCOPE[chart.scope]);
      fact('Status', STATUS[chart.verification]);
    }
    if (facts.childNodes.length) out.push(facts);

    const main = (chart.source && chart.source.url) || asked;
    (chart.charts || []).forEach((c, i) => {
      const section = el('section', 'size-chart-table');
      if (c.label) section.append(el('p', 'size-chart-label', c.label));
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
      /* a table read from another page than the product's says which */
      if (c.source && c.source.url && c.source.url !== main) {
        const from = el('p', 'size-chart-source');
        from.append(el('span', null, 'From: '), safeLink(c.source.url, c.source.title || c.source.url));
        section.append(from);
      }
      out.push(section);
    });

    if (chart.status === 'labels-only' && chart.sizes.length) {
      out.push(el('p', 'size-chart-labels', `Sizes listed: ${chart.sizes.join(', ')} (labels only — no measurements).`));
    }

    const src = chart.source || {};
    const source = el('p', 'size-chart-source');
    /* with no chart, the page is a place to look, not a source */
    source.append(el('span', null, chart.status === 'unavailable' || chart.status === 'fallback' ? 'Product page: ' : 'Source: '), safeLink(src.url || asked, src.title || src.url || asked));
    if (src.retrievedAt) source.append(el('span', null, ` · read ${src.retrievedAt}`));
    out.push(source);
    (chart.guides || []).filter((g) => !g.read).forEach((g) => {
      const p = el('p', 'size-chart-source');
      p.append(el('span', null, 'Size guide (couldn’t be read): '), safeLink(g.url, g.url));
      out.push(p);
    });
    (chart.otherSources || []).forEach((s2) => {
      const p = el('p', 'size-chart-source');
      p.append(el('span', null, 'Also: '), safeLink(s2.url, s2.what || s2.url));
      out.push(p);
    });
    if ((chart.trace || []).length) out.push(traceOf(chart.trace));
    return out;
  }

  /* What Fynd asked for and what came back, step by step — so a failure
     can be told apart from a missing chart. */
  const STEP = { connect: 'no answer', body: 'the page was still arriving', done: 'read' };
  function traceOf(trace) {
    const box = el('details', 'size-chart-trace');
    box.append(el('summary', null, 'What Fynd tried'));
    const list = el('ul');
    trace.forEach((t) => {
      const bits = [];
      bits.push(t.status ? `answered ${t.status}` : STEP[t.phase] || 'no answer');
      if (t.contentType) bits.push(t.contentType.split(';')[0]);
      if (typeof t.bytes === 'number') bits.push(`${Math.round(t.bytes / 1024)} KB`);
      if (t.phase === 'body') bits.push('stopped while the page was arriving');
      if (typeof t.ms === 'number') bits.push(`${(t.ms / 1000).toFixed(1)} s`);
      const li = el('li', null, `${t.url}: ${bits.join(' · ')}`);
      (t.redirects || []).forEach((r) => li.append(el('span', 'size-chart-hop', ` → redirected (${r.status}) to ${r.to}`)));
      list.append(li);
    });
    box.append(list);
    return box;
  }

  /* When the server's own call failed: why, and the page itself. */
  function renderFailure(result, asked) {
    const why = result.status === 429 ? 'Fynd has been asked for a lot of sizing charts just now. Try again in a few minutes.'
      : result.unreachable ? 'Fynd’s sizing service couldn’t be reached, so no chart could be read.'
        : 'Fynd couldn’t read a sizing chart for this product just now.';
    const p = el('p', 'size-chart-source');
    p.append(safeLink(asked, 'Open the original product page'));
    return [el('p', 'size-chart-note', why), p];
  }

  /* The heading for an answer: a chart's product, or which kind of
     failure — the page couldn't be read, or it was read and held no
     chart. */
  const PAGE_READ = ['no-chart', 'needs-script', 'guide-unreadable'];
  function headingFor(chart) {
    if (chart.status !== 'unavailable') {
      const p = chart.product || {};
      return [p.brand, p.name].filter(Boolean).join(' · ') || 'Sizing chart';
    }
    if (chart.reason === 'guide-unreadable') return 'Page read — its size guide couldn’t be';
    return PAGE_READ.includes(chart.reason) ? 'Page read — no sizing chart found' : 'We couldn’t read the product page';
  }

  global.SizeChart = { render, renderFailure, headingFor, el, safeLink };

  /* ---------- the search page's dialog ---------- */

  const dialog = doc.getElementById('size-chart');
  if (!dialog) return;
  const body = doc.getElementById('size-chart-body');
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
      if (result.ok && result.data && result.data.chart) {
        const chart = result.data.chart;
        dialog.dataset.state = chart.status;
        const product = chart.product || {};
        doc.getElementById('size-chart-product').textContent = [product.brand || button.dataset.brand, product.name || button.dataset.name].filter(Boolean).join(' · ');
        const nodes = render(chart, button.dataset.chart);
        /* a chart isn't a recommendation: only a checked garment chart can
           be set beside a reference, and that is the fit profile's job */
        if (chart.comparable) nodes.push(el('p', 'size-chart-fit', 'These finished-garment measurements are checked, so Fynd can compare this product with a reference garment saved on your fit profile. A size from that comparison shows on the product’s card.'));
        body.replaceChildren(...nodes);
      } else {
        dialog.dataset.state = 'error';
        body.replaceChildren(...renderFailure(result, button.dataset.chart));
      }
    });
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

  global.SizeChart.open = open;
})(typeof window !== 'undefined' ? window : globalThis);
