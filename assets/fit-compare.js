/* =========================================================
   Fynd — what a saved fit profile can say about a chart

   Shared by Find Fit (assets/find-fit.js) and the product page's Size
   Guide (assets/product-page.js). Only a chart Fynd has checked
   finished-garment measurements for is set beside the shopper's saved
   reference garment (Account.sizing.compare: the engine's own
   comparison, read from their own profile on the server — nothing from
   the profile travels in any address). Any other chart says why it
   can't be compared; a body chart never is.

     FitCompare.show(chart, container, stillCurrent?)   (a promise)
     FitCompare.focus(container, size)

   A comparison the engine can stand behind (status "ok") is drawn
   compactly: the size it recommends, the reference it was set beside
   (brand and the size on its label), how that size differs in plain
   words, and — folded away — each compared dimension's signed
   difference (this size minus the reference: "−1.0 in chest width" is
   an inch narrower). Every figure is the engine's own. Anything less
   (a partial comparison, or none) recommends nothing and says there
   isn't enough reliable measurement evidence, then the engine's reason.

   focus() adds, to a comparison already drawn, how one size differs
   from the reference, measurement by measurement — the engine's own
   figures for that size, nothing worked out here — and redraws only
   that when the size changes, without asking again. The product page's
   Size Guide uses it for the size being considered.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc || !global.SizeChart) return;
  const { el } = global.SizeChart;
  /* what each container last drew, so a new size redraws only its part */
  const drawn = new WeakMap();

  async function show(chart, compare, current) {
    const stillCurrent = current || (() => true);
    drawn.delete(compare);
    const lines = [];
    const kinds = (chart.charts || []).map((c) => c.measures);
    if (!chart.comparable) {
      if (kinds.includes('finished-garment') || kinds.includes('not-stated')) {
        lines.push(chart.verification === 'unverified'
          ? 'These measurements haven’t been checked against the brand yet, so Fynd won’t compare them with a garment you own.'
          : 'Fynd can’t compare this chart with a garment you own yet: it can’t confirm exactly how each measurement was taken, and two garments are only comparable when measured the same way.');
      } else {
        lines.push('This chart describes bodies, not garments, so it can’t be set beside a garment you own.');
      }
      put(compare, lines);
      return;
    }
    const account = global.Account;
    if (!account.state()) await account.load();
    if (!stillCurrent()) return;
    const state = account.state();
    if (!state || !state.signedIn) {
      const p = el('p', null, 'These finished-garment measurements are checked. With a reference garment saved on ');
      p.append(safeLinkLocal('fit-profile.html', 'your fit profile'), doc.createTextNode(', Fynd can compare every size with it.'));
      put(compare, [], [p]);
      return;
    }
    const got = await account.sizing.compare(chart.productId);
    if (!stillCurrent()) return;
    const c = got.ok && got.data && got.data.comparison;
    if (!c) { put(compare, ['The comparison with your fit profile couldn’t be worked out just now.']); return; }
    if (c.status === 'ok' || c.status === 'partial') {
      const lead = c.status === 'ok' && c.recommended ? recommendation(c) : [el('p', 'fit-compare-fallback', NOT_ENOUGH), el('p', null, c.summary)];
      const rest = [];
      if (c.reliability) rest.push(`Reliability: ${c.reliability}.`);
      (c.caveats || []).slice(0, 2).forEach((x) => rest.push(x));
      const more = el('p');
      more.append(safeLinkLocal('compare.html', 'See every size beside your reference on Compare'));
      drawn.set(compare, { comparison: c, lead, rest, extra: [more] });
      focus(compare, null);
      return;
    }
    lines.push(NOT_ENOUGH);
    (c.missing || []).slice(0, 1).forEach((m) => lines.push(m.message));
    (c.next || []).slice(0, 1).forEach((n) => lines.push(n));
    const fix = el('p');
    fix.append(safeLinkLocal('fit-profile.html', 'Open your fit profile'));
    put(compare, lines, [fix]);
  }

  /* A length as the Compare page shows it: centimetres to the
     millimetre, inches to the quarter. */
  function measure(v, unit) {
    if (typeof v !== 'number') return '—';
    if (unit === 'cm') return `${Math.round(v * 10) / 10} cm`;
    const q = Math.round(v * 4) / 4;
    const whole = Math.floor(q);
    const glyph = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - whole) * 100) / 100];
    return `${whole}${glyph} in`;
  }
  const DIM_LABEL = { chestWidth: 'Chest', bodyLength: 'Body length', shoulderWidth: 'Shoulders', sleeveLength: 'Sleeves' };
  const DIM_NAME = { chestWidth: 'chest width', bodyLength: 'garment length', shoulderWidth: 'shoulder width', sleeveLength: 'sleeve length' };
  const NOT_ENOUGH = 'No size recommendation: there isn’t enough reliable measurement evidence for this product and your reference.';

  /* The engine's signed difference, to a tenth: "+0.5 in", "−1.0 in"
     (a true minus sign), and "0.0 in" with no sign when it rounds to
     nothing. */
  function signed(v, unit) {
    const tenth = Math.round(v * 10) / 10;
    if (tenth === 0) return `0.0 ${unit}`;
    return `${tenth > 0 ? '+' : '\u2212'}${Math.abs(tenth).toFixed(1)} ${unit}`;
  }
  /* what one compared difference measures: a chest taken around the
     body is a circumference, not a width (twice as far for the same cut) */
  const nameOf = (d, x) => (d === 'chestWidth' && x.measurement && x.measurement.method === 'garment-circumference' ? 'chest circumference' : DIM_NAME[d]);
  /* the engine's words for one difference, without its dimension name */
  const meaning = (x) => x.words.replace(/^[^:]+: /, '');

  /* the reference, as the shopper knows it: its brand and the size on
     its label, and where its measurements came from */
  function referenceWords(ref) {
    if (ref.source === 'product' && ref.product) return `${ref.product.brand} ${ref.product.name}, size ${ref.size || '—'} (published measurements)`;
    const named = [ref.brand, ref.size].filter(Boolean).join(' ');
    return `${named || 'Your reference garment'} (measured at home)`;
  }

  /* An "ok" comparison: the size recommended, the reference, how that
     size differs in words, and its signed differences folded away. */
  function recommendation(c) {
    const size = c.recommended;
    const row = (c.sizes || []).find((s) => s.size === size);
    const compared = row ? (c.dimensionsCompared || []).filter((d) => row.dimensions[d] && row.dimensions[d].compared) : [];
    const nodes = [];
    const pick = el('p', 'fit-compare-recommended');
    pick.append(doc.createTextNode('Recommended size: '), el('strong', null, size));
    nodes.push(pick);
    nodes.push(el('p', 'fit-compare-reference', `Compared with: ${referenceWords(c.reference)}.`));
    nodes.push(el('p', null, c.summary));
    if (compared.length) {
      nodes.push(el('p', 'fit-compare-differs', `Size ${size} against your reference: ${compared.map((d) => `${nameOf(d, row.dimensions[d])} ${meaning(row.dimensions[d])}`).join(', ')}.`));
      const box = el('details', 'size-chart-details fit-compare-differences');
      box.append(el('summary', null, 'Measurement differences'));
      box.append(el('p', 'fit-compare-size-note', `Size ${size} minus your reference, in ${c.unit}: positive is larger, negative is smaller.`));
      const table = el('table', 'fit-compare-table');
      const head = el('tr');
      ['Measurement', 'Difference', 'Means'].forEach((h) => { const th = el('th', null, h); th.scope = 'col'; head.append(th); });
      const thead = el('thead');
      thead.append(head);
      const tbody = el('tbody');
      compared.forEach((d) => {
        const x = row.dimensions[d];
        const tr = el('tr');
        const th = el('th', null, nameOf(d, x).replace(/^./, (ch) => ch.toUpperCase()));
        th.scope = 'row';
        const diff = el('td', null, signed(x.difference, c.unit));
        diff.dataset.label = 'Difference';
        diff.dataset.difference = String(x.difference);
        const means = el('td', null, x.estimated ? `${meaning(x)} (estimated)` : meaning(x));
        means.dataset.label = 'Means';
        tr.dataset.dim = d;
        tr.append(th, diff, means);
        tbody.append(tr);
      });
      table.append(thead, tbody);
      const wrap = el('div', 'size-chart-scroll');
      wrap.append(table);
      box.append(wrap);
      nodes.push(box);
    }
    return nodes;
  }

  /* The chosen size beside the reference: for each dimension the
     engine compared, the reference's value, this size's and the
     difference — the engine's own figures, in the comparison's unit,
     nothing worked out here. A dimension it couldn't compare says why,
     and shows no difference. */
  function focus(compare, size) {
    const d = drawn.get(compare);
    if (!d) return;
    const nodes = [];
    if (size) {
      const row = (d.comparison.sizes || []).find((s) => s.size === size);
      const unit = d.comparison.unit;
      const box = el('div', 'fit-compare-size');
      box.append(el('p', 'fit-compare-size-title', `Size ${size} beside your reference`));
      if (row) {
        const table = el('table', 'fit-compare-table');
        const head = el('tr');
        ['', 'Yours', `Size ${size}`, 'Difference'].forEach((h) => { const th = el('th', null, h); th.scope = 'col'; head.append(th); });
        const thead = el('thead');
        thead.append(head);
        const tbody = el('tbody');
        const notes = [];
        const labels = ['Yours', `Size ${size}`, 'Difference'];
        Object.keys(DIM_LABEL).filter((k) => row.dimensions[k]).forEach((k) => {
          const x = row.dimensions[k];
          const tr = el('tr');
          const th = el('th', null, DIM_LABEL[k]);
          th.scope = 'row';
          if (x.compared) {
            tr.append(th, el('td', null, measure(x.reference, unit)), el('td', null, measure(x.candidate, unit)), el('td', null, x.words.replace(/^[^:]+: /, '')));
            if (x.estimated) notes.push(`${DIM_LABEL[k]}: yours is ${x.estimated}, estimated.`);
          } else {
            tr.classList.add('is-skipped');
            /* why is said once, in the engine's caveat under the table */
            tr.append(th, el('td', null, '—'), el('td', null, measure(x.candidate, unit)), el('td', null, 'Not compared'));
          }
          tbody.append(tr);
        });
        /* each value says what it is, for a phone, where the table reads as a list */
        tbody.querySelectorAll('tr').forEach((tr) => tr.querySelectorAll('td').forEach((td, i) => { td.dataset.label = labels[i]; }));
        table.append(thead, tbody);
        const wrap = el('div', 'size-chart-scroll');
        wrap.append(table);
        box.append(wrap);
        notes.forEach((t) => box.append(el('p', 'fit-compare-size-note', t)));
        if (row.unranked) box.append(el('p', null, row.unranked));
      } else {
        box.append(el('p', null, `Fynd has no garment measurements for size ${size} to set beside your reference.`));
      }
      nodes.push(box);
    }
    /* the summary (and, when recommended, the size and its differences),
       then the size being considered, then the caveats */
    put(compare, [], [...d.lead, ...nodes, ...d.rest.map((t) => el('p', null, t)), ...d.extra], 'Compared with your reference');
  }

  function safeLinkLocal(href, text) {
    const a = el('a', 'guide-link', text);
    a.href = href;
    return a;
  }

  function put(compare, lines, extra, title) {
    compare.replaceChildren(el('h3', 'fit-compare-title', title || 'Your fit profile'), ...lines.map((t) => el('p', null, t)), ...(extra || []));
    compare.hidden = false;
  }

  global.FitCompare = { show, focus };
})(typeof window !== 'undefined' ? window : globalThis);
