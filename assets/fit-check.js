/* =========================================================
   Fynd — Find Fit's Fit Check: one size, said plainly

   What Find Fit shows first for a product: the size the engine
   recommends against the shopper's saved reference garment, the
   reference it was set beside, and one line from tighter to roomier.
   Why is one click away, measurement by measurement. Everything shown
   is the engine's own answer (api/_sizing/engine.js compare(), through
   Account.sizing.compare, read from the shopper's own profile on the
   server): no size, difference or position is worked out here, and
   nothing is shown that the engine didn't say.

     FitCheck.show(chart, container, stillCurrent?)   (a promise)

   Where there is nothing honest to compare — a body chart, a chart
   nobody has checked, a chart whose methods aren't known, no saved
   reference, too few measurements taken the same way — it says so,
   and why, instead of a size. The product page's Size Guide keeps
   assets/fit-compare.js.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc || !global.SizeChart) return;
  const { el } = global.SizeChart;

  const NOT_ENOUGH = 'Not enough verified measurements to compare these items yet.';
  const DIMS = ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength'];
  const DIM_LABEL = { chestWidth: 'Chest', bodyLength: 'Body length', shoulderWidth: 'Shoulders', sleeveLength: 'Sleeves' };
  /* the engine's own words for each direction (COMPARE_WORDS) */
  const MEANING = {
    chestWidth: ['wider', 'narrower'], shoulderWidth: ['wider', 'narrower'],
    bodyLength: ['longer', 'shorter'], sleeveLength: ['longer', 'shorter']
  };
  const GAUGE_WORDS = { tighter: 'Tighter', similar: 'Similar', roomier: 'Roomier' };
  let uid = 0;

  async function show(chart, box, current) {
    const stillCurrent = current || (() => true);
    if (!chart.comparable) { fallback(box, [whyNotComparable(chart)]); return null; }
    const account = global.Account;
    if (!account.state()) await account.load();
    if (!stillCurrent()) return null;
    const state = account.state();
    if (!state || !state.signedIn) {
      fallback(box, ['A Fit Check sets this product beside a garment you own. Save one, with its measurements, to see which size is closest.'], true, 'Open your fit profile');
      return null;
    }
    const got = await account.sizing.compare(chart.productId);
    if (!stillCurrent()) return null;
    const c = got.ok && got.data && got.data.comparison;
    if (!c) { fallback(box, ['The Fit Check couldn’t be worked out just now. The size chart is below.'], false, null, false); return null; }
    if (c.status !== 'ok' && c.status !== 'partial') {
      const lines = [];
      (c.missing || []).slice(0, 1).forEach((m) => lines.push(m.message));
      (c.next || []).slice(0, 1).forEach((n) => lines.push(n));
      fallback(box, lines, true, 'Open your fit profile');
      return c;
    }
    draw(box, c);
    return c;
  }

  /* why a chart can't be set beside a garment at all */
  function whyNotComparable(chart) {
    const kinds = (chart.charts || []).map((c) => c.measures);
    if (kinds.includes('finished-garment') || kinds.includes('not-stated')) {
      return chart.verification === 'unverified'
        ? 'These measurements haven’t been checked against the brand yet, so Fynd won’t compare them with a garment you own.'
        : 'Fynd can’t confirm exactly how each measurement was taken, and two garments are only comparable when measured the same way.';
    }
    return 'This chart describes bodies, not garments: it says who each size is cut for, not what the garment measures, so it can’t be set beside a garment you own.';
  }

  function fallback(box, lines, profileLink, linkText, notEnough) {
    const nodes = [el('p', 'fit-check-eyebrow', 'Fynd Fit Check')];
    if (notEnough !== false) nodes.push(el('p', 'fit-check-none', NOT_ENOUGH));
    lines.filter(Boolean).forEach((t) => nodes.push(el('p', 'fit-check-reason', t)));
    if (profileLink) {
      const p = el('p', 'fit-check-reason');
      p.append(link('fit-profile.html', linkText || 'Open your fit profile'));
      nodes.push(p);
    }
    put(box, 'none', nodes);
  }

  /* "your UNIQLO M", "your Carhartt hoodie", "your reference" */
  function refShort(r) {
    const brand = r.brand || (r.product && r.product.brand) || null;
    if (brand && r.size) return `your ${brand} ${r.size}`;
    if (brand) return `your ${brand} reference`;
    return r.size ? `your reference, size ${r.size}` : 'your reference';
  }
  /* "your UNIQLO Sweat Hoodie, size M" */
  function refLong(r) {
    const brand = r.brand || (r.product && r.product.brand) || null;
    const name = r.product && r.product.name ? r.product.name : null;
    const what = [brand, name].filter(Boolean).join(' ') || (r.source === 'measured' ? 'measured reference' : 'reference');
    return `your ${what}${r.size ? `, size ${r.size}` : ''}`;
  }

  /* A difference as shown: signed, to the millimetre or the quarter
     inch — the precision the engine's own words use — and 0 when it
     rounds to nothing there. */
  function signed(v, unit) {
    if (unit === 'cm') {
      const r = Math.round(v * 10) / 10;
      if (r === 0) return '0 cm';
      return `${r > 0 ? '+' : '−'}${Math.abs(r)} cm`;
    }
    const q = Math.round(Math.abs(v) * 4) / 4;
    if (q === 0) return '0 in';
    const whole = Math.floor(q);
    const glyph = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - whole) * 100) / 100];
    return `${v > 0 ? '+' : '−'}${whole || ''}${glyph} in`;
  }
  const isZero = (s) => /^0 /.test(s);

  function draw(box, c) {
    const size = c.recommended || c.closest;
    const row = (c.sizes || []).find((s) => s.size === size);
    const ref = c.reference || {};
    const nodes = [el('p', 'fit-check-eyebrow', 'Fynd Fit Check')];

    const headline = el('p', 'fit-check-size');
    if (c.recommended) headline.append(doc.createTextNode('Get size '), el('strong', null, size));
    else headline.append(doc.createTextNode('Closest size '), el('strong', null, size));
    nodes.push(headline);
    if (!c.recommended) nodes.push(el('p', 'fit-check-caution', `Not a recommendation: ${c.summary}`));
    nodes.push(el('p', 'fit-check-like', `${c.recommended ? 'Fits most like' : 'Closest to'} ${refShort(ref)}`));

    if (c.fit && c.fit.size === size) nodes.push(gauge(c.fit, size));

    const details = el('details', 'fit-check-why');
    details.id = `fit-check-why-${++uid}`;
    const summary = el('summary', null, c.recommended ? 'See why this size is recommended' : 'See how this size compares');
    details.append(summary, explanation(c, row, size, ref));
    const hide = el('button', 'btn btn-secondary fit-check-hide', 'Hide details');
    hide.type = 'button';
    hide.setAttribute('aria-controls', details.id);
    hide.addEventListener('click', () => { details.open = false; summary.focus(); });
    details.append(hide);
    nodes.push(details);
    put(box, c.recommended ? 'recommended' : 'closest', nodes);
  }

  /* tighter ─ similar ─ roomier, the marker where the engine put it */
  function gauge(fit, size) {
    const named = fit.basis.map((d) => DIM_LABEL[d].toLowerCase()).join(' and ');
    const wrap = el('div', 'fit-check-gauge');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', `Size ${size} is ${fit.label === 'similar' ? 'similar to' : `${fit.label} than`} your reference, on ${named}`);
    wrap.dataset.label = fit.label;
    const track = el('div', 'fit-check-track');
    const marker = el('span', 'fit-check-marker');
    marker.style.left = `${((fit.position + fit.span) / (2 * fit.span)) * 100}%`;
    track.append(marker);
    const scale = el('div', 'fit-check-scale');
    ['tighter', 'similar', 'roomier'].forEach((k) => {
      const s = el('span', k === fit.label ? 'is-active' : null, GAUGE_WORDS[k]);
      s.setAttribute('aria-hidden', 'true');
      scale.append(s);
    });
    wrap.append(track, scale);
    return wrap;
  }

  function explanation(c, row, size, ref) {
    const unit = c.unit;
    const panel = el('div', 'fit-check-detail');
    panel.append(el('h3', 'fit-check-detail-title', `Compared with ${refLong(ref)}`));
    const table = el('table', 'fit-check-table');
    const caption = el('caption', 'sr-only', `Size ${size} minus your reference, measurement by measurement`);
    const head = el('tr');
    ['Measurement', 'Difference'].forEach((h) => { const th = el('th', null, h); th.scope = 'col'; head.append(th); });
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    const estimated = [];
    DIMS.filter((d) => row && row.dimensions[d]).forEach((d) => {
      const x = row.dimensions[d];
      const tr = el('tr');
      tr.dataset.dim = d;
      const th = el('th', null, DIM_LABEL[d]);
      th.scope = 'row';
      const td = el('td');
      if (x.compared) {
        const shown = signed(x.difference, unit);
        const meaning = isZero(shown) ? 'a match' : MEANING[d][x.difference > 0 ? 0 : 1];
        td.append(el('span', 'fit-check-delta', shown), el('span', 'fit-check-meaning', meaning));
        if (x.estimated) estimated.push(`${DIM_LABEL[d]}: yours is ${x.estimated}, an estimate.`);
      } else {
        tr.classList.add('is-skipped');
        td.append(el('span', 'fit-check-delta', 'Not compared'), el('span', 'fit-check-meaning', x.why || ''));
      }
      tr.append(th, td);
      tbody.append(tr);
    });
    table.append(caption, thead, tbody);
    panel.append(table);
    panel.append(el('p', 'fit-check-legend', `+ size ${size} is larger than yours · − smaller · 0 the same, to the nearest ${unit === 'cm' ? '0.1 cm' : '¼ in'}. Only measurements taken the same way are compared.`));
    if (c.fit && c.fit.size === size) {
      const bands = c.fit.basis.map((d) => {
        const w = c.fit.within[d];
        return `${w.value} ${unit} ${w.around ? 'around the chest' : `across the ${DIM_LABEL[d].toLowerCase()}`}`;
      });
      panel.append(el('p', 'fit-check-note', `Tighter, similar or roomier reads ${c.fit.basis.map((d) => DIM_LABEL[d].toLowerCase()).join(' and ')} only; “similar” is within about ${bands.join(' and ')}.`));
    }
    estimated.forEach((t) => panel.append(el('p', 'fit-check-note', t)));
    if (row && row.unranked) panel.append(el('p', 'fit-check-note', row.unranked));

    const facts = el('ul', 'fit-check-facts');
    const fact = (label, text) => { const li = el('li'); li.append(el('span', 'fit-check-fact-label', label), el('span', null, text)); facts.append(li); };
    fact('This product', `${c.product.brand}’s published finished-garment measurements, ${c.dataStatus === 'verified' ? 'checked by Fynd against the brand’s page' : 'not checked yet'}.`);
    fact('Your reference', ref.source === 'measured' ? 'Measured by you, from your fit profile.' : `${ref.product && ref.product.brand ? ref.product.brand : 'The brand'}’s published measurements for it${ref.size ? `, size ${ref.size}` : ''}.`);
    fact('Reliability', `${c.reliability}.`);
    panel.append(facts);
    if ((c.caveats || []).length) {
      const list = el('ul', 'fit-check-caveats');
      c.caveats.forEach((t) => list.append(el('li', null, t)));
      panel.append(list);
    }
    const more = el('p', 'fit-check-note');
    more.append(link('compare.html', 'See every size beside your reference on Compare'));
    panel.append(more);
    return panel;
  }

  function link(href, text) {
    const a = el('a', 'guide-link', text);
    a.href = href;
    return a;
  }

  function put(box, state, nodes) {
    box.replaceChildren(...nodes);
    box.dataset.state = state;
    box.hidden = false;
  }

  global.FitCheck = { show, signed };
})(typeof window !== 'undefined' ? window : globalThis);
