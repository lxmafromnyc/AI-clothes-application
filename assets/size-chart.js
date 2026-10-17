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

   What it shows is what the server said, and only that. In view: each
   table, what it measures (the body, the garment, or not stated), its
   unit, the values as the brand wrote them, and one line on where it is
   from (the product's own chart, a size guide, or the brand's general
   chart). When there is no chart, a short status and reason. Under
   "Source details", closed: the server's notes, the market, the chart's
   scope and status, every source link, and what was tried. Everything
   read from a page is drawn as text.
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

  /* what a chart measures: a short name, and the line under it */
  const KIND = {
    body: 'Body measurements — the body each size fits, not the garment',
    'finished-garment': 'Finished-garment measurements — the clothing itself',
    'not-stated': 'Not stated — the page doesn’t say whether these measure the body or the garment'
  };
  const KIND_NAME = { body: 'Body measurements', 'finished-garment': 'Finished-garment measurements', 'not-stated': 'Measurements' };
  const SCOPE = {
    'product-specific': 'This product’s own chart',
    'product-page': 'Published on this product’s page',
    'linked-size-guide': 'The retailer’s size guide linked from the product page — possibly a general chart, not this product’s own',
    'brand-general': 'The brand’s general chart for this kind of product — a fallback, not this product’s own',
    'browser-page': 'Read by the Fynd extension from the product page open in your browser',
    'browser-size-guide': 'Read by the Fynd extension from the retailer’s size guide open in your browser — possibly a general chart, not this product’s own'
  };
  const STATUS = {
    verified: 'Verified — checked by a person against the brand’s page',
    unverified: 'Unverified — copied from the brand’s page, not yet checked',
    'not-verified': 'Not verified — read automatically just now',
    'official-general': 'Official values, copied from the brand’s own pages — not read from this product’s page'
  };
  const UNIT = { in: 'inches, as published', cm: 'centimetres, as published', both: 'inches and centimetres, as published', null: 'not stated — check the source' };
  const LINE = { men: 'men’s', women: 'women’s', unisex: 'unisex' };

  /* The one line a shopper needs about where a chart is from — the rest
     is under "Source details". */
  function caveatOf(chart) {
    const brand = (chart.product && chart.product.brand) || chart.retailer || 'the brand';
    if (chart.scope === 'brand-general') return `A general ${brand} sizing guide — not measurements confirmed for this exact product.`;
    if (chart.scope === 'browser-size-guide') return 'Read from the retailer’s size guide open in your browser — possibly a general chart. Not checked by Fynd.';
    if (chart.scope === 'browser-page') return 'Read from the product page open in your browser. Not checked by Fynd.';
    if (chart.scope === 'linked-size-guide') return 'From the retailer’s size guide — possibly a general chart, not this product’s own.';
    if (chart.verification === 'verified') return `This product’s own chart, checked against ${brand}’s page.`;
    if (chart.verification === 'unverified') return `This product’s own chart, copied from ${brand}’s page — not yet checked.`;
    return 'Read from the product page just now — not checked by a person.';
  }

  /* An unavailable answer, said briefly: a status and one reason. */
  const SHORT = {
    'no-answer': 'The retailer’s site didn’t respond in time.',
    'slow-page': 'The retailer’s page didn’t finish loading in time.',
    refused: 'The retailer’s site doesn’t allow Fynd to read this page.',
    'http-error': 'The retailer’s page returned an error.',
    unreachable: 'The retailer’s site couldn’t be reached.',
    'not-html': 'This link doesn’t lead to a product page Fynd can read.',
    'too-large': 'This link doesn’t lead to a product page Fynd can read.',
    'bad-redirect': 'This link doesn’t lead to a product page Fynd can read.',
    'redirected-away': 'This link doesn’t lead to a product page Fynd can read.',
    'too-many-redirects': 'This link doesn’t lead to a product page Fynd can read.',
    'no-chart': 'The product page doesn’t include a sizing chart Fynd can read.',
    'needs-script': 'The product page loads its sizing with JavaScript, which Fynd doesn’t run.',
    'guide-unreadable': 'The product page links to a size guide, but that guide couldn’t be read.',
    'guide-not-open': 'The page links to a size guide, but it isn’t open. Open the retailer’s size guide on the page, then check again.'
  };
  const PAGE_READ = ['no-chart', 'needs-script', 'guide-unreadable', 'guide-not-open'];
  const statusOf = (chart) => (PAGE_READ.includes(chart.reason) ? 'No sizing chart found on this page' : 'Couldn’t read the product page');

  /* The nodes for one answer from /api/size-recommendation?chart=:
     what the server said, drawn as text. The visible part is the chart,
     what it measures, and one line on where it is from; everything else
     — the server's notes, sources, status and what was tried — is under
     "Source details", closed. `asked` is the link the shopper gave.
     `opts.linked`: the caller already shows a link to the product. */
  function render(chart, asked, opts) {
    const o = opts || {};
    const out = [];
    const src = chart.source || {};
    const pageUrl = src.url || asked;
    const unavailable = chart.status === 'unavailable';

    if (unavailable) {
      out.push(el('p', 'size-chart-status', statusOf(chart)));
      out.push(el('p', 'size-chart-note', SHORT[chart.reason] || (chart.note || [])[0] || 'Fynd couldn’t read a sizing chart for this product.'));
      if (chart.from === 'browser-extension') {
        if (chart.reason !== 'guide-not-open') out.push(el('p', 'size-chart-hint', 'If the retailer has a size guide button, open it on the page, then check again.'));
      } else if (src.url) {
        const hint = el('p', 'size-chart-hint');
        if (o.linked) hint.textContent = 'The product page may have its own size guide.';
        else hint.append(el('span', null, 'The product page may have its own size guide: '), safeLink(src.url, 'open the product page'));
        out.push(hint);
      }
    }

    const brand = (chart.product && chart.product.brand) || chart.retailer;
    (chart.charts || []).forEach((c, i) => {
      const section = el('section', 'size-chart-table');
      const general = chart.scope === 'brand-general';
      section.append(el('h3', 'size-chart-name', general ? `${[brand, chart.market].filter(Boolean).join(' ')} ${c.measures === 'body' ? 'body-size' : 'size'} chart` : KIND_NAME[c.measures] || KIND_NAME['not-stated']));
      section.append(el('p', 'size-chart-kind', general
        ? `General sizing guide · ${c.measures === 'body' ? 'Body measurements, not garment measurements' : KIND[c.measures]}`
        : KIND[c.measures] || KIND['not-stated']));
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
    if (!unavailable && (chart.charts || []).length) out.push(el('p', 'size-chart-caveat', caveatOf(chart)));
    if (chart.status === 'labels-only' && chart.sizes.length) {
      out.push(el('p', 'size-chart-labels', `Sizes listed: ${chart.sizes.join(', ')} — the page gives no measurements.`));
    }

    /* what the page said about the product, in its words */
    const details = chart.details || {};
    const said = el('dl', 'size-chart-facts');
    if (details.fit) said.append(el('dt', null, 'Fit, as the page says'), el('dd', null, details.fit));
    if (details.material) said.append(el('dt', null, 'Fabric, as the page says'), el('dd', null, details.material));
    if (said.childNodes.length) out.push(said);

    out.push(detailsOf(chart, pageUrl));
    return out;
  }

  /* "Source details": closed until asked for. Every note the server
     wrote, where each chart came from, its status, and what was tried. */
  function detailsOf(chart, pageUrl) {
    const box = el('details', 'size-chart-details');
    box.append(el('summary', null, 'Source details'));
    const notes = el('ul', 'size-chart-notes');
    (chart.note || []).forEach((line) => notes.append(el('li', null, line)));
    if (notes.childNodes.length) box.append(notes);

    const facts = el('dl', 'size-chart-facts');
    const fact = (label, value) => { if (value) facts.append(el('dt', null, label), el('dd', null, value)); };
    fact('Retailer', chart.retailer);
    if (chart.status !== 'unavailable') {
      fact('Market', chart.market ? `${chart.market}${chart.line && LINE[chart.line] ? ` · ${LINE[chart.line]} sizing` : ''}` : 'Not stated');
      fact('Chart', SCOPE[chart.scope]);
      fact('Status', STATUS[chart.verification]);
    }
    if (facts.childNodes.length) box.append(facts);

    const src = chart.source || {};
    const link = (label, url, text) => {
      const p = el('p', 'size-chart-source');
      p.append(el('span', null, label), safeLink(url, text || url));
      box.append(p);
    };
    /* the product page is a source only when a chart was read from it */
    const fromPage = chart.status === 'ok' || chart.status === 'labels-only';
    link(fromPage ? 'Source: ' : 'Product page: ', pageUrl, src.title || pageUrl);
    if (src.retrievedAt && fromPage) box.lastChild.append(el('span', null, ` · read ${src.retrievedAt}`));
    (chart.charts || []).forEach((c) => {
      if (c.source && c.source.url && c.source.url !== pageUrl) link('Chart from: ', c.source.url, c.source.title || c.source.url);
    });
    (chart.otherSources || []).forEach((s2) => link('Also: ', s2.url, s2.what || s2.url));
    (chart.guides || []).filter((g) => !g.read).forEach((g) => link('Size guide (couldn’t be read): ', g.url));
    if ((chart.trace || []).length) box.append(traceOf(chart.trace));
    return box;
  }

  /* What Fynd asked for and what came back, step by step — so a failure
     can be told apart from a missing chart. */
  const STEP = { connect: 'no answer', body: 'the page was still arriving', done: 'read' };
  function traceOf(trace) {
    const box = el('div', 'size-chart-trace');
    box.append(el('p', 'size-chart-trace-title', 'What Fynd tried'));
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
  function renderFailure(result, asked, opts) {
    const why = result.status === 429 ? 'Fynd has been asked for a lot of sizing charts just now. Try again in a few minutes.'
      : result.unreachable ? 'Fynd’s sizing service couldn’t be reached, so no chart could be read.'
        : 'Fynd couldn’t read a sizing chart for this product just now.';
    const out = [el('p', 'size-chart-note', why)];
    if (!(opts && opts.linked)) {
      const p = el('p', 'size-chart-source');
      p.append(safeLink(cleanUrl(asked), 'Open the product page'));
      out.push(p);
    }
    return out;
  }

  /* The heading for an answer: the product, when it is known, or that
     there is no chart. */
  function headingFor(chart) {
    const p = chart.product || {};
    const named = [p.brand, p.name].filter(Boolean).join(' · ');
    if (p.name) return named;
    return chart.status === 'unavailable' ? 'Sizing chart unavailable' : named || 'Sizing chart';
  }

  /* A link as shown: without tracking parameters or a fragment. */
  const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref|ref_src|_ga|igshid|srsltid)$/i;
  function cleanUrl(url) {
    try {
      const u = new URL(url);
      [...u.searchParams.keys()].forEach((k) => { if (TRACKING.test(k)) u.searchParams.delete(k); });
      u.hash = '';
      return u.href;
    } catch (err) {
      return url;
    }
  }

  global.SizeChart = { render, renderFailure, headingFor, cleanUrl, el, safeLink };

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
