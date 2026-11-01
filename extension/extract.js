/* =========================================================
   Fynd extension — from what was read on the page to what the shopper
   confirms

   Plain functions over what collect.js read (`raw`) and the tables
   FyndPayload labelled (vendor/fynd-payload.js, the same labelling Fynd's
   server uses). No browser API, no network: the panel calls them, and
   scripts/test-extension-extract.js runs them in Node on fixtures.

     detectProduct(raw)    the product: name, brand, address, code, SKU,
                           colour, sizes (with whether each is on offer),
                           where each part came from, and what is missing
     guessType(name)       hoodie / sweatshirt / T-shirt from the product's
                           own name — a suggestion the shopper confirms,
                           null when the name doesn't say
     charts(raw)           every size table on the page, labelled: what it
                           measures (finished garment, body, not stated),
                           its unit, its columns and rows
     planColumns(chart)    each column: the measurement it is, if its
                           heading says so plainly, and the method its
                           words state — never a method the page doesn't
                           state, and never a body column as a garment's
     parseValue(text)      one cell: a number, a fraction, ½ — or not a
                           number (a range "56-58" is ambiguous, said so)
     buildChart(review)    the request body's `chart` (assets/
                           fit-candidate.js readChart): only what the
                           shopper confirmed, each value with where it
                           came from and whether they corrected it

   Fynd never calls a page's chart "verified": it is read, then confirmed
   by the shopper, and the server compares it as their own numbers. The
   comparison itself is the server's (api/_sizing/engine.js); nothing here
   ranks, scores or recommends.
   ========================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/fynd-payload.js'));
  else root.FyndExtract = factory(root.FyndPayload);
})(typeof self !== 'undefined' ? self : this, function (Payload) {
  'use strict';

  const DIMS = ['chestWidth', 'shoulderWidth', 'bodyLength', 'sleeveLength'];
  const LABELS = { chestWidth: 'Chest width', shoulderWidth: 'Shoulder width', bodyLength: 'Body length', sleeveLength: 'Sleeve length' };
  const TYPES = { hoodies: 'Hoodie', sweatshirts: 'Sweatshirt', tshirts: 'T-shirt' };
  const clean = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 160) : '');

  /* a plain web page's address, without its fragment or tracking */
  const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref|ref_src|_ga|igshid|srsltid)$/i;
  function pageUrl(raw) {
    if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
    let u;
    try { u = new URL(raw); } catch (err) { return null; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return null;
    [...u.searchParams.keys()].forEach((k) => { if (TRACKING.test(k)) u.searchParams.delete(k); });
    u.hash = '';
    return u.href;
  }

  /* ---------- the product ---------- */
  function detectProduct(raw) {
    const r = raw || {};
    const p = r.product || {};
    const from = p.from || {};
    const offered = Array.isArray(p.pageSizes) ? p.pageSizes : [];
    const variants = Array.isArray(p.variants) ? p.variants : [];
    /* each size once, with whether it is on offer: the page's picker first, else its variants, else not known */
    const sizes = (Array.isArray(p.sizes) ? p.sizes : []).map((s) => clean(s, 20)).filter(Boolean).map((size) => {
      const onPage = offered.find((x) => x.size === size);
      const inVariants = variants.filter((v) => v.size === size && typeof v.available === 'boolean');
      const available = onPage ? onPage.available : inVariants.length ? inVariants.some((v) => v.available) : null;
      return { size, available };
    });
    const out = {
      name: clean(p.name) || null,
      brand: clean(p.brand, 80) || null,
      url: pageUrl(r.canonical) || pageUrl(p.url) || pageUrl(r.url),
      code: clean(p.code, 60) || null,
      sku: clean(p.sku, 60) || null,
      color: clean(p.color, 40) || null,
      sizes,
      variants: variants.slice(0, 60).map((v) => ({ sku: clean(v.sku, 60) || null, size: clean(v.size, 20) || null, color: clean(v.color, 40) || null, available: typeof v.available === 'boolean' ? v.available : null })),
      retailer: clean(r.retailer, 60) || null,
      from: { name: from.name || null, brand: from.brand || null, sizes: from.sizes || null, color: from.color || null, code: from.code || null }
    };
    out.missing = ['name', 'brand', 'sizes'].filter((k) => (k === 'sizes' ? !sizes.length : !out[k]));
    /* a page with no product name, no structured data and no sizes is not a product page Fynd can read */
    out.found = Boolean(out.name && (from.name === 'json-ld' || sizes.length || out.brand));
    out.type = guessType(out.name);
    return out;
  }

  /* the kind of garment, only from the product's own words */
  function guessType(name) {
    const n = String(name || '').toLowerCase();
    if (/\bhood(ie|y|ed)\b/.test(n)) return 'hoodies';
    if (/\bsweat ?shirt\b|\bcrew ?neck sweat/.test(n)) return 'sweatshirts';
    if (/\bt-?shirt\b|\btee\b/.test(n)) return 'tshirts';
    return null;
  }

  /* ---------- the size tables ---------- */
  function charts(raw) {
    const found = Payload.candidates(raw || {});
    return {
      confident: found.confident,
      list: found.list.map((c, i) => ({
        index: i,
        measures: c.chart.measures,
        unit: c.chart.unit,
        title: c.chart.title || c.heading || null,
        tab: c.tab,
        inDialog: c.inDialog,
        visible: c.visible,
        columns: c.chart.columns,
        methodsSaid: c.chart.methods || null,
        rows: c.chart.rows
      }))
    };
  }

  /* which measurement a column is, only when its heading plainly says so */
  function dimOf(header) {
    /* the heading's own measurement, not where it's measured from: "Front length (from high point of
       shoulder)" is a length, "Length (shoulder to hem)" too — brackets and "from …" are the method */
    const full = String(header || '').toLowerCase();
    const core = full.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b(from|measured)\b.*$/, ' ').trim();
    const h = core || full;
    if (/\b(height|weight|waist|hips?|seat|inseam|outseam|rise|thigh|knee|neck|hem|armhole|opening)\b/.test(h)) return null;
    if (/\bsleeves?\b/.test(h)) return 'sleeveLength';
    if (/\bshoulders?\b/.test(h)) return 'shoulderWidth';
    if (/\b(chest|bust|pit[\s-]*to[\s-]*pit|armpit|body width)\b/.test(h)) return 'chestWidth';
    if (/\blength\b/.test(h)) return 'bodyLength';
    return null;
  }

  /* the canonical method a column's own words state — or null: never a guess */
  function methodSaid(dim, words) {
    const w = String(words || '').toLowerCase();
    if (!w) return null;
    if (dim === 'chestWidth') {
      if (/circumference|all (the way )?around/.test(w)) return 'garment-circumference';
      if (/\bhalf\b|½|1\/2|laid flat|measured flat|\bflat\b|pit[\s-]*to[\s-]*pit|armpit[\s-]*to[\s-]*armpit|body width/.test(w)) return 'flat-width-armpit-to-armpit';
      return null;
    }
    if (dim === 'bodyLength') {
      if (/cent(er|re)[\s-]*back|back length|length \(back\)/.test(w)) return 'center-back-to-hem';
      if (/\bhps\b|high(est)?[\s-]*point|from (the )?shoulder/.test(w)) return 'high-point-shoulder-to-hem';
      return null;
    }
    if (dim === 'sleeveLength') {
      if (/cent(er|re)[\s-]*back/.test(w)) return 'center-back-to-cuff';
      if (/shoulder seam|from (the )?shoulder/.test(w)) return 'shoulder-seam-to-cuff';
      return null;
    }
    if (dim === 'shoulderWidth') {
      if (/seam[\s-]*to[\s-]*seam/.test(w)) return 'seam-to-seam';
      return null;
    }
    return null;
  }

  function planColumns(chart) {
    const used = new Set();
    return (chart.columns || []).map((header, i) => {
      let dim = chart.measures === 'body' ? null : dimOf(header);
      /* a measurement named twice: the first column only; the shopper can move it */
      if (dim && used.has(dim)) dim = null;
      if (dim) used.add(dim);
      const words = `${header} ${(chart.methodsSaid && chart.methodsSaid[i]) || ''}`;
      return { index: i, header, dim, method: dim ? methodSaid(dim, words) : null, said: (chart.methodsSaid && chart.methodsSaid[i]) || null };
    });
  }

  /* one cell: a number (21, 21.5, 21,5, 21 1/2, 21½) — or not: a range is ambiguous */
  const FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
  function parseValue(text) {
    const t = clean(text, 40).replace(/\s*(cm|in|inches|")\.?$/i, '').trim();
    if (!t) return { value: null, problem: 'empty' };
    if (/\d\s*[-–—~]\s*\d|\bto\b/.test(t)) return { value: null, problem: 'range' };
    let m = t.match(/^(\d{1,3})(?:[.,](\d{1,2}))?\s*([¼½¾⅛⅜⅝⅞])?$/);
    if (m) return { value: Number(`${m[1]}.${m[2] || 0}`) + (m[3] ? FRACTIONS[m[3]] : 0), problem: null };
    m = t.match(/^(\d{1,3})\s+(\d)\/(\d{1,2})$/);
    if (m && Number(m[3]) > 0 && Number(m[2]) < Number(m[3])) return { value: Number(m[1]) + Number(m[2]) / Number(m[3]), problem: null };
    return { value: null, problem: 'not-a-number' };
  }

  /* ---------- the review: what the shopper sees and corrects ---------- */
  /* from one labelled chart: each size's cell for each mapped column */
  function startReview(chart, product) {
    const plan = planColumns(chart);
    const rows = (chart.rows || []).map((row) => {
      const cells = {};
      plan.forEach((col) => {
        const raw = row.values[col.index];
        const parsed = parseValue(raw);
        cells[col.index] = { raw: clean(raw, 40), value: parsed.value, problem: parsed.problem, corrected: false };
      });
      const offered = product && product.sizes ? product.sizes.find((s) => s.size === row.size) : null;
      return { size: clean(row.size, 20), cells, available: offered ? offered.available : null };
    });
    return {
      source: 'page-table',
      measures: chart.measures,
      measuresConfirmed: chart.measures === 'finished-garment',
      unit: chart.unit === 'in' || chart.unit === 'cm' ? chart.unit : null,
      unitSaid: chart.unit,
      columns: plan,
      rows
    };
  }

  /* no table on the page: the product's sizes, every value to be typed in */
  function emptyReview(product) {
    const plan = DIMS.map((dim, i) => ({ index: i, header: LABELS[dim], dim, method: null, said: null }));
    const sizes = product && product.sizes && product.sizes.length ? product.sizes : [];
    return {
      source: 'shopper',
      measures: 'not-stated',
      measuresConfirmed: false,
      unit: null,
      unitSaid: null,
      columns: plan,
      rows: sizes.map((s) => ({ size: s.size, available: s.available, cells: Object.fromEntries(plan.map((c) => [c.index, { raw: '', value: null, problem: 'empty', corrected: false }])) }))
    };
  }

  /* the request's `chart`: the confirmed columns, the readable values, and where each came from */
  function buildChart(review, product, type) {
    const methods = { registry: 1 };
    const cols = review.columns.filter((c) => c.dim);
    cols.forEach((c) => { methods[c.dim] = c.method || 'not-stated'; });
    return {
      measures: review.measuresConfirmed ? 'finished-garment' : review.measures,
      type,
      brand: product && product.brand ? product.brand : null,
      name: product && product.name ? product.name : null,
      url: product && product.url ? product.url : null,
      unit: review.unit,
      methods,
      sizes: review.rows.map((row) => {
        const measurements = {};
        const provenance = {};
        cols.forEach((c) => {
          const cell = row.cells[c.index];
          if (!cell || typeof cell.value !== 'number') return;
          measurements[c.dim] = cell.value;
          provenance[c.dim] = { source: review.source === 'shopper' || (cell.corrected && !cell.raw) ? 'shopper' : 'page-table', header: c.header, corrected: Boolean(cell.corrected) };
        });
        return { size: row.size, measurements, provenance };
      }).filter((s) => Object.keys(s.measurements).length)
    };
  }

  /* what is still missing before the chart can be sent, in the shopper's words */
  function reviewProblems(review, type) {
    const out = [];
    if (!type) out.push('Choose what kind of garment this is.');
    if (review.measures === 'body') out.push('This chart measures the body, not the garment: Fynd can’t compare it with your garment.');
    else if (!review.measuresConfirmed) out.push('Confirm these are the garment’s own measurements (laid flat or around the garment), not body sizes.');
    if (!review.unit) out.push('Say whether the chart is in centimetres or inches.');
    const cols = review.columns.filter((c) => c.dim);
    if (!cols.some((c) => c.dim === 'chestWidth')) out.push('Every comparison needs the chest: say which column is the chest width.');
    cols.filter((c) => !c.method).forEach((c) => out.push(`Choose how the chart measures the ${LABELS[c.dim].toLowerCase()} — or “The chart doesn’t say”.`));
    const unreadable = review.rows.filter((r) => cols.some((c) => r.cells[c.index] && r.cells[c.index].problem && r.cells[c.index].problem !== 'empty'));
    const measured = review.rows.filter((r) => cols.some((c) => r.cells[c.index] && typeof r.cells[c.index].value === 'number'));
    if (measured.some((r) => !r.size)) out.push('Give every size with measurements its label (S, M, L…).');
    const labels = measured.map((r) => r.size.toLowerCase()).filter(Boolean);
    if (new Set(labels).size !== labels.length) out.push('Each size can be listed once only.');
    if (measured.length > 30) out.push('Fynd compares up to 30 sizes at once.');
    if (unreadable.length) out.push(`Some values aren’t single numbers (sizes ${unreadable.map((r) => r.size).join(', ')}): correct them or leave them out.`);
    if (!review.rows.some((r) => cols.some((c) => r.cells[c.index] && typeof r.cells[c.index].value === 'number'))) out.push('There are no measurements to compare yet.');
    return out;
  }

  return { DIMS, LABELS, TYPES, pageUrl, detectProduct, guessType, charts, dimOf, methodSaid, planColumns, parseValue, startReview, emptyReview, buildChart, reviewProblems };
});
