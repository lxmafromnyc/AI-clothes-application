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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/fynd-payload.js'), require('./vendor/chart-reading.js'), require('./vendor/sizing-tables.js'));
  else root.FyndExtract = factory(root.FyndPayload, root.FyndChartReading, root.FyndSizingTables);
})(typeof self !== 'undefined' ? self : this, function (Payload, Reading, Tables) {
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
    const read = new Set(found.list.map((c) => c.index));
    return {
      confident: found.confident,
      /* tables shaped like a size chart (a column of sizes, numbers beside
         it) that the deterministic reader couldn't label: unknown headings,
         headings over two rows. Only the AI-assisted reading is offered for them. */
      unread: ((raw && raw.tables) || []).slice(0, 12).map((t, rawIndex) => ({ t, rawIndex }))
        .filter(({ t, rawIndex }) => !read.has(rawIndex) && Reading.gridShape(t.grid || t.rows))
        .map(({ t, rawIndex }) => {
          const grid = t.grid || t.rows;
          const shape = Reading.gridShape(grid);
          return { rawIndex, title: clean(t.caption || t.heading || '', 80) || null, inDialog: Boolean(t.inDialog), visible: Boolean(t.visible), columns: grid[0].filter((h, i) => i !== shape.sizeColumn && h).map((h) => clean(h, 40)), sizes: shape.bodyRows.length };
        }),
      list: found.list.map((c, i) => ({
        index: i,
        rawIndex: c.index,
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

  /* which measurement a heading is, and the method its words state: the shared,
     deterministic readers (assets/chart-reading.js) — the server checks a model's
     proposals with the same ones */
  const dimOf = Reading.dimOf;
  const methodSaid = Reading.methodSaid;

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

  /* one cell: a number (21, 21.5, 21,5, 21 1/2, 21½) — or not: a range is ambiguous (assets/chart-reading.js) */
  function parseValue(text) {
    const p = Reading.parseCell(text);
    return { value: p.value, problem: p.problem };
  }

  /* ---------- the review: what the shopper sees and corrects ---------- */
  /* from one labelled chart: each size's cell for each mapped column */
  /* Where each part of Fynd's own reading came from. Only the chart itself —
     its caption and its headings — is ground for filling something in
     automatically. A unit, a method or a "garment measurements" claim that
     comes only from text near the table (a paragraph above it, which may be
     about something else, or written to mislead) is kept as a proposal the
     shopper confirms. Text addressed to software is not used at all. */
  function grounding(chart, plan, rawTable) {
    if (!rawTable) return null;
    const caption = String(rawTable.caption || '');
    const before = String(rawTable.before || '');
    const aimed = Reading.aimedAtSoftware(before) || Reading.aimedAtSoftware(caption);
    const chartWords = `${Reading.aimedAtSoftware(caption) ? '' : caption} ${(chart.columns || []).join(' ')}`;
    const ownMethods = chart.columns ? Tables.methodsOf(chart.columns, Reading.aimedAtSoftware(caption) ? '' : caption) : null;
    /* the rows the deterministic reading used */
    const grid = rawTable.rows || rawTable.grid || [];
    const shape = Reading.gridShape(grid);
    /* rows that don't line up with the headings: any heading row narrower than the data
       (a merged heading cell read once shifts every later column) */
    const extent = (r) => r.reduce((w, c, i) => (c ? i + 1 : w), 0);
    const dataWidth = shape ? Math.max(...shape.bodyRows.map((ri) => extent(grid[ri]))) : 0;
    const ragged = Boolean(shape) && grid.slice(0, shape.headerRows).some((r) => r.length < dataWidth || extent(r) < dataWidth);
    return {
      aimed,
      ragged,
      unit: chart.unit === 'cm' || chart.unit === 'in' ? (Tables.unitOf(chartWords) === chart.unit ? 'chart' : 'nearby') : null,
      measures: chart.measures === 'finished-garment' ? (Tables.kindOf(chartWords, chart.columns || []) === 'finished-garment' ? 'chart' : 'nearby') : null,
      methods: Object.fromEntries(plan.filter((c) => c.dim && c.method).map((c) => [c.index,
        methodSaid(c.dim, `${c.header} ${(ownMethods && ownMethods[c.index]) || ''}`) === c.method ? 'chart' : 'nearby']))
    };
  }

  function startReview(chart, product, rawTable) {
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
    const g = grounding(chart, plan, rawTable);
    const checks = [];
    const notes = [];
    let unit = chart.unit === 'in' || chart.unit === 'cm' ? chart.unit : null;
    let measuresConfirmed = chart.measures === 'finished-garment';
    let nearbyMeasures = false;
    if (g) {
      if (g.aimed) notes.push('Text near this table is addressed to software, not shoppers. Fynd didn’t use it.');
      if (g.unit === 'nearby') {
        if (g.aimed) unit = null;
        else checks.push(`The unit (${unit === 'cm' ? 'centimetres' : 'inches'}) comes from text near the table, not the chart itself.`);
      }
      /* "garment measurements" only from nearby text: the shopper confirms it, as for a chart that doesn't say */
      if (g.measures === 'nearby') { measuresConfirmed = false; nearbyMeasures = true; }
      plan.forEach((c) => {
        if (g.methods[c.index] !== 'nearby') return;
        if (g.aimed) { c.method = null; return; }
        c.nearby = true;
        checks.push(`How “${c.header}” is measured comes from text near the table, not the chart itself.`);
      });
      if (g.ragged) checks.push('The chart’s rows don’t line up with its headings: check that each column’s values are under the right heading.');
    }
    return {
      source: 'page-table',
      measures: chart.measures,
      measuresConfirmed,
      unit,
      unitSaid: chart.unit,
      columns: plan,
      rows,
      /* "garment measurements" said only near the table, not by the chart: the shopper confirms it */
      nearbyMeasures,
      /* anything uncertain, for the shopper to check before continuing; none: the automatic path */
      checks,
      checked: false,
      notes
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
          provenance[c.dim] = Object.assign({ source: review.source === 'shopper' || (cell.corrected && !cell.raw) ? 'shopper' : 'page-table', header: c.header, corrected: Boolean(cell.corrected) }, review.interpretedBy === 'ai' ? { interpretedBy: 'ai' } : {});
        });
        return { size: row.size, measurements, provenance };
      }).filter((s) => Object.keys(s.measurements).length)
    };
  }

  /* ---------- when the deterministic reading needs help ---------- */
  /* Why a chart Fynd read can't be interpreted reliably on its own: [] means
     the fast path — no model is asked. A body chart is never sent: no reading
     could make it the garment's. */
  const METHOD_HINT = /\b(flat|half|around|circumference|cent(?:er|re)|back|hps|high[\s-]*point|shoulder|seam|armpit|pit|cuff|hem)\b|½|1\/2/i;
  function interpretationNeeds(review, rawTable) {
    if (!review || review.measures === 'body') return [];
    const out = [];
    const grid = rawTable && (rawTable.grid || rawTable.rows);
    const shape = grid ? Reading.gridShape(grid) : null;
    const words = `${(rawTable && rawTable.caption) || ''} ${(rawTable && rawTable.before) || ''}`;
    const cols = review.columns.filter((c) => c.dim);
    /* a second heading row (its size cell empty) the deterministic reader skips */
    if (shape && shape.headerRows > 1) out.push('heading-rows');
    /* rows that don't line up with the headings */
    if (review.checks && review.checks.some((t) => /don’t line up/.test(t))) out.push('structure');
    /* a measurement-like column whose heading Fynd can't name */
    if (review.columns.some((c) => !c.dim && /\b(chest|pit|width|length|sleeve|shoulder|back|arm|body|across)\b/i.test(c.header))) out.push('column');
    /* a method the headings don't state, when the page's other words might */
    if (cols.some((c) => !c.method) && METHOD_HINT.test(words)) out.push('method');
    /* a unit only where Fynd's own reading didn't look: a later heading row, or earlier text */
    if (!review.unit && review.unitSaid !== 'both' && (out.includes('heading-rows') || String((rawTable && rawTable.before) || '').length > 120)) out.push('unit');
    return out;
  }

  /* what is sent to Fynd's server for the AI-assisted reading: the table's
     cell text, caption and the words before it — nothing else from the page,
     and nothing about the shopper */
  const MAX_AI_CHARS = 9000;
  function aiRequest(rawTable, type) {
    const grid = ((rawTable && (rawTable.grid || rawTable.rows)) || []).slice(0, 43).map((r) => r.slice(0, 12).map((c) => clean(c, 60)));
    const body = { table: { grid, caption: clean(rawTable && rawTable.caption, 160), before: clean(rawTable && rawTable.before, 300) }, type: type || null };
    while (JSON.stringify(body).length > MAX_AI_CHARS && body.table.grid.length > 4) body.table.grid.pop();
    return body;
  }

  /* The server's checked proposal (api/_sizing/parse-chart.js) as a review: every
     value is the page's own cell as Fynd parsed it; each mapping is a
     suggestion the shopper must confirm (checked); anything the server
     couldn't support stays unmapped, with its reason. */
  function reviewFromInterpretation(result, product) {
    const columns = (result.columns || []).map((c) => ({
      index: c.col,
      header: c.header,
      dim: c.dim || null,
      method: c.method || null,
      said: null,
      ai: { status: c.status, basis: c.basis, reasons: c.reasons || [], evidence: c.evidence || {}, uncertain: Boolean(c.uncertain), suggestion: c.suggestion || null }
    }));
    const rows = (result.rows || []).map((r) => {
      const offered = product && product.sizes ? product.sizes.find((s) => s.size === r.size) : null;
      const cells = {};
      columns.forEach((c) => {
        const x = r.cells && r.cells[c.index];
        cells[c.index] = x ? { raw: clean(x.raw, 40), value: typeof x.value === 'number' ? x.value : null, problem: x.problem || null, corrected: false } : { raw: '', value: null, problem: 'empty', corrected: false };
      });
      return { size: clean(r.size, 20), cells, available: offered ? offered.available : null };
    });
    return {
      source: 'page-table',
      interpretedBy: 'ai',
      measures: result.measures,
      measuresConfirmed: result.measures === 'finished-garment',
      unit: result.unit && (result.unit.value === 'cm' || result.unit.value === 'in') ? result.unit.value : null,
      unitSaid: result.unit ? result.unit.status : null,
      columns,
      rows,
      /* every AI suggestion is checked by the shopper: an AI-assisted reading is never automatic */
      checks: columns.filter((c) => c.ai.status === 'proposed' || c.ai.suggestion).map((c) => `“${c.header}”`).concat(result.unit && result.unit.suggestion ? ['the unit'] : []),
      checked: false,
      notes: [],
      ai: {
        status: result.status,
        cached: Boolean(result.cached),
        unit: result.unit || null,
        aiSuggestsMeasures: result.aiSuggestsMeasures || null,
        unresolved: result.unresolved || [],
        ambiguities: result.ambiguities || [],
        ignoredText: result.ignoredText || null
      }
    };
  }

  /* what is still missing before the chart can be sent, in the shopper's words */
  function reviewProblems(review, type) {
    const out = [];
    if (!type) out.push('Choose what kind of garment this is.');
    if (review.interpretedBy === 'ai' && !review.checked) out.push('Check the reading Fynd’s AI suggested, then confirm it.');
    else if (review.checks && review.checks.length && !review.checked) out.push('Check what Fynd marked as uncertain against the chart, then confirm it.');
    if (review.ai && review.ai.unit && review.ai.unit.status === 'conflicting' && !review.unit) out.push('The page gives more than one unit: say which these measurements are in.');
    /* values marked in the cells themselves ("56 cm", "22 in") in two units, or against the chart's: never converted */
    const marks = new Set();
    review.columns.filter((c) => c.dim).forEach((c) => review.rows.forEach((r) => { const cell = r.cells[c.index]; const u = cell && !cell.corrected ? Reading.parseCell(cell.raw).unit : null; if (u) marks.add(u); }));
    if (marks.size > 1 || (marks.size === 1 && review.unit && !marks.has(review.unit))) out.push('Some values are marked in centimetres and others in inches. Fynd never converts them: correct them, or enter the chart by hand in one unit.');
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

  /* an AI-assisted or uncertain reading is never automatic */
  /* automatic: read from the chart itself, complete, and nothing uncertain — the only reading that needs no check */
  const isAutomatic = (review) => Boolean(review) && review.source === 'page-table' && review.interpretedBy !== 'ai'
    && !(review.checks && review.checks.length) && review.measuresConfirmed && Boolean(review.unit)
    && review.columns.some((c) => c.dim) && review.columns.filter((c) => c.dim).every((c) => c.method);

  return { isAutomatic, DIMS, LABELS, TYPES, pageUrl, detectProduct, guessType, charts, dimOf, methodSaid, planColumns, parseValue, startReview, emptyReview, buildChart, reviewProblems, interpretationNeeds, aiRequest, reviewFromInterpretation, MAX_AI_CHARS };
});
