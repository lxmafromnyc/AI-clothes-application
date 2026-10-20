/* =========================================================
   Fynd — a sizing chart read by the browser extension

   The Fynd extension (extension/) reads the product page open in the
   shopper's own browser, when they ask it to. This module turns what it
   collected into one small, bounded, plainly structured payload, and
   back into the chart Find Fit and the extension's popup both draw
   (assets/size-chart.js):

     candidates(raw)   the size tables on the page, labelled and ranked,
                       and whether one of them is clearly the chart
     build(raw, i)     the payload for table i (or for none)
     validate(p)       a payload that came from anywhere, checked: every
                       string bounded, every link a plain web page, a
                       chart's rows as wide as its columns, at least one
                       number in each row. Anything else is refused, never
                       repaired
     encode / decode   base64url JSON, for Find Fit's address fragment
                       (#fynd-chart=…), which never reaches a server
     toChart(p)        the chart to draw: from the browser, its own words
                       for what it measures and its unit, and never
                       verified or comparable — reading is not checking

   Nothing here fetches, stores or runs anything. Used by Find Fit
   (index.html) and by the extension, which carries an identical copy in
   extension/vendor/ (scripts/sync-extension.js; test-extension fails if
   the two differ).
   ========================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sizing-tables'));
  else root.FyndPayload = factory(root.FyndSizingTables);
})(typeof self !== 'undefined' ? self : this, function (Tables) {
  'use strict';

  const VERSION = 1;
  const KIND = 'fynd-extension-chart';
  const MAX_TEXT = 160;
  const MAX_URL = 2000;
  const MAX_SIZES = 30;
  const MAX_ENCODED = 24000;
  const MEASURES = ['body', 'finished-garment', 'not-stated'];
  const UNITS = ['in', 'cm', 'both', null];
  const WHERE = ['product-page', 'size-guide-dialog'];
  const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref|ref_src|_ga|igshid|srsltid)$/i;
  const SIZE_WORDS = /\bsize|sizing|measurement|fit guide\b/i;

  /* plain text: no control characters, spaces folded, bounded */
  const clean = (v, max) => (typeof v === 'string' || typeof v === 'number'
    ? String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || MAX_TEXT)
    : '');
  const textOrNull = (v, max) => clean(v, max) || null;

  /* a plain public web page's address, without tracking or fragment */
  function pageUrl(raw) {
    if (typeof raw !== 'string' || raw.length > MAX_URL) return null;
    let u;
    try { u = new URL(raw); } catch (err) { return null; }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname.includes('.')) return null;
    [...u.searchParams.keys()].forEach((k) => { if (TRACKING.test(k)) u.searchParams.delete(k); });
    u.hash = '';
    return u.href;
  }

  /* ---------- the tables on the page ---------- */

  /* Every size table the extension saw, labelled the way the server
     labels one, best first; and whether the best is clearly the chart
     (the only one, or the only one in view, or the only one in an open
     size guide). Otherwise the shopper chooses.

     Within one size guide — both tables in the open dialog, or in
     sibling tab panels — the garment's own measurements come first,
     even when the guide opened on its body-size tab: a shop's "Body
     size" tab is often the one in view, its "Product size" tab beside
     it. The garment table is then clearly the chart when no other
     garment table shares that guide. Nothing is promoted across guides,
     so a hidden garment table elsewhere never displaces the one open. */
  function candidates(raw) {
    const list = [];
    ((raw && raw.tables) || []).slice(0, 12).forEach((t, index) => {
      const chart = Tables.labelTable({ rows: t.rows, caption: clean(t.caption), before: clean(t.before, 300) });
      if (!chart) return;
      const words = `${t.caption || ''} ${t.before || ''}`;
      const score = (t.visible ? 4 : 0) + (t.inDialog ? 3 : 0) + (SIZE_WORDS.test(words) ? 2 : 0) + Math.min(chart.columns.length, 4) * 0.5;
      list.push({ index, chart, visible: Boolean(t.visible), inDialog: Boolean(t.inDialog), tab: clean(t.tab, 60) || null, heading: clean(t.heading || t.caption || t.before, 80) || null, score });
    });
    list.sort((a, b) => b.score - a.score || a.index - b.index);
    const garment = (c) => c.chart.measures === 'finished-garment';
    const sameGuide = (a, b) => (a.inDialog && b.inDialog) || Boolean(a.tab && b.tab);
    const top = list[0];
    const own = top && !garment(top) ? list.find((c) => garment(c) && sameGuide(c, top)) : null;
    if (own) list.splice(0, list.length, own, ...list.filter((c) => c !== own));
    const [first, second] = list;
    const onlyGarment = (c) => garment(c) && list.filter((x) => garment(x) && sameGuide(x, c)).length === 1;
    const confident = list.length === 1 || Boolean(first && second && (
      (first.visible && !second.visible) || (first.inDialog && !second.inDialog) ||
      (onlyGarment(first) && !garment(second) && sameGuide(first, second))));
    return { list, confident };
  }

  /* The payload for one candidate (its position in candidates().list),
     or for none: the page's product facts and its size-guide link. */
  function build(raw, pick) {
    const found = candidates(raw);
    const c = typeof pick === 'number' ? found.list[pick] : null;
    const r = raw || {};
    const url = pageUrl(r.canonical) || pageUrl(r.url);
    const guide = (r.guides || []).map((g) => ({ url: pageUrl(g && g.url), text: textOrNull(g && g.text, 80) })).find((g) => g.url) || null;
    return {
      v: VERSION,
      kind: KIND,
      readAt: new Date().toISOString().slice(0, 10),
      page: { url, title: textOrNull(r.title) },
      product: { name: textOrNull(r.product && r.product.name), brand: textOrNull(r.product && r.product.brand, 60), code: textOrNull(r.product && r.product.code, 60) },
      retailer: textOrNull(r.retailer, 60),
      fit: textOrNull(r.fit, 60),
      sizes: ((r.product && r.product.sizes) || []).map((s) => clean(s, 20)).filter(Boolean).slice(0, MAX_SIZES),
      guide,
      chart: c ? Object.assign({
        where: c.inDialog ? 'size-guide-dialog' : 'product-page',
        measures: c.chart.measures,
        unit: c.chart.unit,
        title: textOrNull(c.chart.title || c.heading),
        columns: c.chart.columns.slice(),
        rows: c.chart.rows.map((row) => ({ size: row.size, values: row.values.slice() }))
      }, c.chart.methods ? { methods: c.chart.methods.slice() } : {}) : null
    };
  }

  /* ---------- checking a payload from anywhere ---------- */

  function validate(p) {
    const fail = (why) => ({ error: why });
    if (!p || typeof p !== 'object' || Array.isArray(p)) return fail('not an object');
    if (p.v !== VERSION || p.kind !== KIND) return fail('not a Fynd extension chart');
    const url = pageUrl(p.page && p.page.url);
    if (!url) return fail('no product page address');
    if (p.readAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.readAt))) return fail('bad date');
    const str = (v, max) => (v === null || v === undefined ? null : typeof v === 'string' && v.length <= max * 2 ? textOrNull(v, max) : undefined);
    const out = {
      v: VERSION,
      kind: KIND,
      readAt: p.readAt || null,
      page: { url, title: str(p.page.title, MAX_TEXT) },
      product: { name: str((p.product || {}).name, MAX_TEXT), brand: str((p.product || {}).brand, 60), code: str((p.product || {}).code, 60) },
      retailer: str(p.retailer, 60),
      fit: str(p.fit, 60),
      sizes: [],
      guide: null,
      chart: null
    };
    if ([out.page.title, out.product.name, out.product.brand, out.product.code, out.retailer, out.fit].includes(undefined)) return fail('a text field is not text, or too long');
    if (p.sizes !== undefined) {
      if (!Array.isArray(p.sizes) || p.sizes.length > MAX_SIZES || p.sizes.some((s) => typeof s !== 'string' || !clean(s, 20) || s.length > 20)) return fail('bad sizes');
      out.sizes = p.sizes.map((s) => clean(s, 20));
    }
    if (p.guide) {
      const g = pageUrl(p.guide.url);
      if (!g) return fail('bad size-guide link');
      out.guide = { url: g, text: str(p.guide.text, 80) || null };
    }
    if (p.chart) {
      const c = p.chart;
      if (!WHERE.includes(c.where) || !MEASURES.includes(c.measures) || !UNITS.includes(c.unit === undefined ? null : c.unit)) return fail('bad chart labels');
      if (!Array.isArray(c.columns) || !c.columns.length || c.columns.length > Tables.MAX_COLUMNS) return fail('bad columns');
      if (!Array.isArray(c.rows) || c.rows.length < 2 || c.rows.length > Tables.MAX_ROWS) return fail('bad rows');
      const cell = (v) => typeof v === 'string' && v.length <= Tables.MAX_CELL;
      if (!c.columns.every((h) => cell(h) && clean(h))) return fail('bad column name');
      for (const row of c.rows) {
        if (!row || !cell(row.size) || !clean(row.size)) return fail('bad size label');
        if (!Array.isArray(row.values) || row.values.length !== c.columns.length || !row.values.every(cell)) return fail('a row is not as wide as the columns');
        if (!row.values.some((v) => /\d/.test(v))) return fail('a row has no measurement');
      }
      const title = str(c.title, MAX_TEXT);
      if (title === undefined) return fail('bad chart title');
      /* how each column was measured, in the page's words: optional, one
         per column, only for a garment chart */
      if (c.methods !== undefined && (c.measures !== 'finished-garment' || !Array.isArray(c.methods) || c.methods.length !== c.columns.length
        || !c.methods.every((m) => m === null || (cell(m) && clean(m))))) return fail('bad methods');
      out.chart = {
        where: c.where, measures: c.measures, unit: c.unit === undefined ? null : c.unit, title,
        columns: c.columns.map((h) => clean(h, Tables.MAX_CELL)),
        rows: c.rows.map((row) => ({ size: clean(row.size, Tables.MAX_CELL), values: row.values.map((v) => clean(v, Tables.MAX_CELL)) }))
      };
      if (c.methods) out.chart.methods = c.methods.map((m) => (m === null ? null : clean(m, Tables.MAX_CELL)));
    }
    return { payload: out };
  }

  /* ---------- carrying it in an address fragment ---------- */

  function toBase64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromBase64Url(text) {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  }
  const encode = (payload) => toBase64Url(JSON.stringify(payload));
  function decode(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_ENCODED || !/^[A-Za-z0-9_-]+$/.test(text)) return { error: 'not a Fynd chart link' };
    let parsed;
    try { parsed = JSON.parse(fromBase64Url(text)); } catch (err) { return { error: 'not a Fynd chart link' }; }
    return validate(parsed);
  }

  /* ---------- the chart to draw ---------- */

  const listOf = (items) => {
    const xs = items.map((x) => x.toLowerCase());
    return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  };

  /* The brief note: what the chart is, in the page's own terms. */
  function notesFor(p) {
    const lines = [`Read by the Fynd extension from the page open in your browser${p.readAt ? ` on ${p.readAt}` : ''}. Not checked by Fynd.`];
    const c = p.chart;
    if (c) {
      if (c.where === 'size-guide-dialog') lines.push('Read from the retailer’s size guide open on the page — it may be a general chart, not one for this product only.');
      if (c.measures === 'body') lines.push('This is a body-size chart, not the physical dimensions of the garment.');
      else if (c.measures === 'finished-garment') lines.push(`Finished-garment measurements are available for ${listOf(c.columns)} only.`);
      else lines.push('The table’s measurement type could not be established from the page.');
      if (!c.unit) lines.push('The page doesn’t state the unit for these values — check the product page.');
    } else if (p.sizes.length) {
      lines.push(`The page lists sizes ${p.sizes[0]}${p.sizes.length > 1 ? `–${p.sizes[p.sizes.length - 1]}` : ''}, but no measurements were found on it.`);
    } else {
      lines.push('No sizing table was found on the page.');
    }
    return lines;
  }

  function toChart(p) {
    const c = p.chart;
    return {
      status: c ? 'ok' : p.sizes.length ? 'labels-only' : 'unavailable',
      reason: c || p.sizes.length ? undefined : (p.guide ? 'guide-not-open' : 'no-chart'),
      from: 'browser-extension',
      product: { brand: p.product.brand, name: p.product.name, code: p.product.code },
      details: { fit: p.fit, material: null },
      retailer: p.retailer,
      source: { title: p.page.title || p.page.url, url: p.page.url, kind: 'product-page', retrievedAt: p.readAt },
      scope: c && c.where === 'size-guide-dialog' ? 'browser-size-guide' : 'browser-page',
      market: null,
      line: null,
      charts: c ? [Object.assign({ measures: c.measures, origin: c.where === 'size-guide-dialog' ? 'browser-size-guide' : 'browser-page', verification: 'not-verified', title: c.title, unit: c.unit, source: { url: p.page.url, title: p.page.title }, columns: c.columns, rows: c.rows }, c.methods ? { methods: c.methods } : {})] : [],
      /* a table read without the garment's own measurements: said, and
         where else they may be (another tab of the same guide) */
      productSize: c && c.measures !== 'finished-garment' ? { status: 'not-in-browser', checkedAt: p.readAt } : undefined,
      sizes: p.sizes,
      otherSources: p.guide ? [{ url: p.guide.url, what: `The page’s size guide link${p.guide.text ? ` (“${p.guide.text}”)` : ''}` }] : [],
      verification: 'not-verified',
      comparable: false,
      note: notesFor(p)
    };
  }

  return { VERSION, KIND, MAX_ENCODED, pageUrl, candidates, build, validate, encode, decode, toChart, notesFor };
});
