/* =========================================================
   Fynd — a product's sizing chart, read from its brand's own page

   The search page's "View sizing chart" asks for one listing's chart,
   by its link, on demand. This answers with what that product's brand
   actually publishes, or says why there is nothing to show:

     1  the address    only the brand's own site, by exact host
                       (OFFICIAL_HOSTS in ./schema.js), over https, no
                       credentials, no port, no address literal. Any
                       other shop is never fetched: Fynd can't say a
                       third-party page's chart is the brand's.
     2  Fynd's record  a sizing record for exactly this product (found
                       by its code in the link, as a favourite piece is)
                       is used as it stands: its body chart and its
                       finished-garment chart, its sources, and its own
                       verification status — verified only when a person
                       checked it against the brand, never because it was
                       read.
     3  the page       otherwise the page itself, read once: redirects
                       followed by hand, each hop held to the same
                       brand's hosts; a time limit; a size limit; HTML
                       only. Its size tables are read deterministically
                       (no model), from the markup the server sent: a
                       table counts only when it has a size column and
                       at least one measurement column. What a table
                       measures — the body it is cut for, or the garment
                       — is taken from the words around it, and is
                       "not stated" when they don't say. Values are kept
                       as the page wrote them, with their units. The
                       sizes the product is sold in come from its JSON-LD,
                       as labels only.

   Nothing read is ever run, and nothing is returned but short plain
   strings; the page draws them as text. A page that is refused, slow,
   too big, not HTML or drawn by script answers "unavailable" with the
   reason and a link to the page, never a chart from somewhere else.

   Results are cached by product page (host and path, no query): a chart
   for six hours, a failure for thirty minutes.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const store = require('../_store');
const sizingSchema = require('./schema');
const { RECORDS } = require('./records');
const engine = require('./engine');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1500000;
const MAX_REDIRECTS = 3;
const CACHE_OK_SECONDS = 6 * 60 * 60;
const CACHE_MISS_SECONDS = 30 * 60;
const CACHE_VERSION = 'v1';
const MAX_CELL = 60;
const MAX_ROWS = 40;
const MAX_COLUMNS = 12;

const UA = 'Mozilla/5.0 (compatible; FyndSizing/1.0; +https://ai-clothes-application.vercel.app/about.html)';

/* host -> brand, from the hosts the sizing records already trust */
const HOSTS = new Map();
Object.entries(sizingSchema.OFFICIAL_HOSTS).forEach(([brand, hosts]) => hosts.forEach((h) => HOSTS.set(h, brand)));
const SUPPORTED_BRANDS = Object.keys(sizingSchema.OFFICIAL_HOSTS);

/* ---------- the address ---------- */

/* { url, brand, market } or { error } for anything Fynd won't fetch. */
function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return { error: 'invalid-url' };
  let u;
  try { u = new URL(raw.trim()); } catch (err) { return { error: 'invalid-url' }; }
  if (u.protocol !== 'https:') return { error: 'invalid-url' };
  if (u.username || u.password || u.port) return { error: 'invalid-url' };
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(':')) return { error: 'invalid-url' };
  const brand = HOSTS.get(host);
  if (!brand) return { error: 'unsupported-retailer', host };
  return { url: `https://${host}${u.pathname}`, brand, host, market: marketOf(host, u.pathname) };
}

/* The market the address names, or null: "/us/en/…" and "/en_us/…" say
   it; an address that doesn't is not guessed. */
function marketOf(host, path) {
  const parts = path.split('/').filter(Boolean).slice(0, 2);
  for (const p of parts) {
    const pair = /^[a-z]{2}[_-]([a-z]{2})$/i.exec(p);
    if (pair) return pair[1].toUpperCase();
    if (/^[a-z]{2}$/i.test(p) && !/^(en|fr|es|de|it|ja|zh|ko|pt|nl|sv|da|pl|t)$/i.test(p)) return p.toUpperCase();
  }
  return null;
}

/* ---------- reading the page ---------- */

/* Reads a page from a checked address. Redirects are followed by hand
   so each hop is checked again: a page that sends Fynd anywhere but the
   same brand's own site is not read. */
async function fetchPage(checked, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  let url = checked.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response;
      try {
        response = await doFetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8' }
        });
      } catch (err) {
        return { failed: err && err.name === 'AbortError' ? 'timeout' : 'unreachable' };
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && response.headers.get && response.headers.get('location');
        if (!location) return { failed: 'bad-redirect' };
        const next = checkUrl(new URL(location, url).toString());
        if (next.error || next.brand !== checked.brand) return { failed: 'redirected-away' };
        url = next.url;
        continue;
      }
      if (response.status === 403 || response.status === 429) return { failed: 'refused', status: response.status };
      if (!response.ok) return { failed: 'http-error', status: response.status };
      const type = String((response.headers && response.headers.get && response.headers.get('content-type')) || '');
      if (type && !/html/i.test(type)) return { failed: 'not-html' };
      const body = await readCapped(response);
      if (body === null) return { failed: 'too-large' };
      return { html: body, url };
    }
    return { failed: 'too-many-redirects' };
  } catch (err) {
    return { failed: err && err.name === 'AbortError' ? 'timeout' : 'unreadable' };
  } finally {
    clearTimeout(timer);
  }
}

/* The body, or null when it passes MAX_BYTES. */
async function readCapped(response) {
  const length = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (length > MAX_BYTES) return null;
  if (!response.body || !response.body.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text) > MAX_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) { reader.cancel().catch(() => {}); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ---------- reading what the page says ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', times: '×', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', deg: '°' };
function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[code.toLowerCase()] !== undefined ? ENTITIES[code.toLowerCase()] : all;
  });
}

/* Plain text: tags gone, entities read, control characters and runs of
   space collapsed, and cut to a length a cell can hold. */
function plain(html, max) {
  const text = decode(String(html).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return max && text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* What a reader can see, roughly: scripts, styles and comments gone. */
const visible = (html) => String(html)
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');

function titleOf(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(html);
  const t = og ? og[1] : ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  return plain(t, 160) || null;
}

/* The product's own JSON-LD: its name, brand, code and the sizes it is
   sold in, as labels. Malformed blocks are skipped. */
function productData(html) {
  const out = { name: null, brand: null, sku: null, sizes: [] };
  const blocks = String(html).match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const nodes = [];
  blocks.slice(0, 20).forEach((block) => {
    const json = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let data;
    try { data = JSON.parse(json); } catch (err) { return; }
    const walk = (n, depth) => {
      if (!n || typeof n !== 'object' || depth > 4) return;
      if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
      nodes.push(n);
      if (n['@graph']) walk(n['@graph'], depth + 1);
    };
    walk(data, 0);
  });
  const isType = (n, t) => [].concat(n['@type'] || []).some((x) => String(x).replace(/^.*[/#]/, '') === t);
  const product = nodes.find((n) => isType(n, 'Product')) || nodes.find((n) => isType(n, 'ProductGroup'));
  if (!product) return out;
  const str = (v) => (typeof v === 'string' || typeof v === 'number' ? plain(String(v), 120) : null);
  out.name = str(product.name);
  out.brand = product.brand && typeof product.brand === 'object' ? str(product.brand.name) : str(product.brand);
  out.sku = str(product.sku || product.productID || product.productGroupID || product.mpn);
  const sizes = [];
  const add = (v) => { const s = str(v); if (s && s.length <= 16 && !sizes.includes(s)) sizes.push(s); };
  [].concat(product.size || []).forEach(add);
  [].concat(product.hasVariant || []).forEach((v) => v && typeof v === 'object' && [].concat(v.size || []).forEach(add));
  [].concat(product.offers || []).forEach((o) => o && typeof o === 'object' && [].concat(o.size || []).forEach(add));
  out.sizes = sizes.slice(0, 30);
  return out;
}

const SIZE_HEADER = /\b(size|sizes|us size|uk size|eu size|label)\b/i;
const SIZE_VALUE = /^(?:[2-6]?x{0,4}[sml]|xx?s|xx?l|[2-6]xl|one size|\d{1,2}(?:\s*[x/×]\s*\d{1,2})?|\d{2,3})$/i;
const MEASURE = /\b(chest|bust|waist|hips?|seat|length|sleeve|shoulders?|inseam|outseam|neck|height|thigh|rise|leg|width|body)\b/i;

/* Every table in the page, as rows of plain cells, with the words just
   before it (a heading, a tab's name) to say what it measures. */
function tablesOf(html) {
  const page = visible(html);
  const out = [];
  const re = /<table\b[\s\S]*?<\/table\s*>/gi;
  let m;
  while ((m = re.exec(page)) && out.length < 12) {
    const markup = m[0];
    const before = plain(page.slice(Math.max(0, m.index - 1500), m.index)).slice(-300);
    const caption = plain(((/<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(markup) || [])[1]) || '', 160);
    const rows = (markup.match(/<tr\b[\s\S]*?<\/tr\s*>/gi) || []).slice(0, MAX_ROWS + 1)
      .map((tr) => (tr.match(/<t[hd]\b[\s\S]*?<\/t[hd]\s*>/gi) || []).slice(0, MAX_COLUMNS).map((cell) => plain(cell, MAX_CELL)))
      .filter((cells) => cells.some(Boolean));
    if (rows.length) out.push({ rows, caption, before });
  }
  return out;
}

/* A size table, with sizes down the left: { columns, rows } or null.
   A table with sizes across the top is turned so they read down. */
function sizeTable(rows) {
  if (rows.length < 2) return null;
  const width = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] || ''));
  const asIs = readOriented(grid);
  if (asIs) return asIs;
  const turned = grid[0].map((_, c) => grid.map((r) => r[c]));
  return readOriented(turned);
}

function readOriented(grid) {
  const head = grid[0];
  if (head.length < 2) return null;
  const body = grid.slice(1).filter((r) => r[0]);
  const sizesDown = body.filter((r) => SIZE_VALUE.test(r[0].replace(/\s+/g, ' '))).length;
  const labelled = SIZE_HEADER.test(head[0]) || (!head[0] && sizesDown === body.length);
  if (!labelled || body.length < 2 || sizesDown < Math.ceil(body.length * 0.6)) return null;
  const measured = head.slice(1).map((h, i) => ({ h, i: i + 1 })).filter((c) => MEASURE.test(c.h));
  if (!measured.length) return null;
  const columns = measured.map((c) => c.h);
  const out = body.map((r) => ({ size: r[0], values: measured.map((c) => r[c.i] || '') }))
    .filter((r) => r.values.some((v) => /\d/.test(v)));
  if (out.length < 2) return null;
  return { columns, rows: out.slice(0, MAX_ROWS) };
}

/* Inches, centimetres, both, or not stated — from the table's own words. */
function unitOf(text) {
  const cm = /\b(cm|centimet(?:er|re)s?)\b/i.test(text);
  /* "in" alone is an ordinary word ("measured flat, in cm"): only an
     unmistakable inch counts — inch(es), "(in)", "in." or a ″ mark */
  const inch = /\binch(es)?\b|\(in\)|\bin\.(?!\w)|["″]/i.test(text);
  if (cm && inch) return 'both';
  return cm ? 'cm' : inch ? 'in' : null;
}

/* What the table measures, only when its words say so. */
const SAYS_GARMENT = /\b(garment|product|item|clothing)\s+(measurements?|size|dimensions?)\b|\blaid flat\b|\bmeasured flat\b|\bflat measurements?\b|\bfrom (the )?cent(?:er|re) back\b|\bbody width\b/i;
const SAYS_BODY = /\bbody (measurements?|size)\b|\byour (body|measurements)\b|\bmeasure (yourself|your body)\b|\bto fit\b|\bbody chart\b/i;
function kindOf(text) {
  const garment = SAYS_GARMENT.test(text);
  const body = SAYS_BODY.test(text);
  if (garment && !body) return 'finished-garment';
  if (body && !garment) return 'body';
  return 'not-stated';
}

/* ---------- the answer ---------- */

const unavailable = (checked, reason, extra) => Object.assign({
  status: 'unavailable',
  reason,
  product: checked && checked.brand ? { brand: checked.brand, name: null } : null,
  source: checked && checked.url ? { title: null, url: checked.url, kind: 'product-page' } : null,
  market: checked ? checked.market || null : null,
  charts: [],
  sizes: [],
  verification: 'not-verified'
}, extra || {});

const REASONS = {
  'invalid-url': 'That isn’t a product link Fynd can read.',
  'unsupported-retailer': `Fynd reads sizing only from the sites of brands it knows (${SUPPORTED_BRANDS.join(', ')}). It doesn’t read this site, so it has no chart for this listing — check the size guide on the listing’s own page.`,
  refused: 'The brand’s site refused Fynd’s request for this page.',
  timeout: 'The brand’s page took too long to answer.',
  unreachable: 'The brand’s page couldn’t be reached.',
  'http-error': 'The brand’s page answered with an error.',
  'redirected-away': 'The page sent Fynd somewhere other than the brand’s own site, so it wasn’t read.',
  'bad-redirect': 'The page sent Fynd to an address it couldn’t follow.',
  'too-many-redirects': 'The page redirected too many times.',
  'not-html': 'The link isn’t a web page.',
  'too-large': 'The page was too large to read.',
  unreadable: 'The page couldn’t be read.',
  'no-chart': 'The page Fynd received contains no size table it could read. Many brands draw their size guide with script after the page loads, which Fynd doesn’t run.'
};

/* A chart from Fynd's own record of this product: body and garment
   charts kept apart, each value as the brand wrote it. */
function fromRecord(record, checked) {
  const charts = [];
  const add = (chart, measures) => {
    if (!chart) return;
    const keys = Object.keys(chart.dimensions);
    charts.push({
      measures,
      title: chart.label || null,
      unit: record.units,
      columns: keys.map((k) => chart.dimensions[k].label || k),
      rows: record.sizes.filter((s) => chart.sizes[s]).map((s) => ({ size: s, values: keys.map((k) => (chart.sizes[s][k] ? String(chart.sizes[s][k].text) : '')) }))
    });
  };
  add(record.charts.body, 'body');
  add(record.charts.garment, 'finished-garment');
  return {
    status: 'ok',
    from: 'fynd-record',
    product: { brand: record.brand, name: record.product.name, code: record.product.code || null },
    source: { title: record.product.pageTitle || record.product.name, url: record.product.url, kind: 'product-page', retrievedAt: record.retrievedAt },
    otherSources: (record.sources || []).filter((s) => s.url !== record.product.url).map((s) => ({ url: s.url, what: plain(s.what || '', 160) })),
    scope: 'product-specific',
    market: record.region || (checked && checked.market) || null,
    line: record.line || null,
    charts,
    sizes: record.sizes.slice(),
    fit: record.fit && record.fit.brandWords ? { words: record.fit.brandWords, source: plain(record.fit.source || '', 160) } : null,
    verification: sizingSchema.isVerified(record) ? 'verified' : 'unverified',
    comparable: sizingSchema.isVerified(record) && Boolean(record.charts.garment)
  };
}

/* What the page itself gave. */
function fromPage(html, checked, landedUrl) {
  const data = productData(html);
  const charts = [];
  tablesOf(html).forEach((t) => {
    const table = sizeTable(t.rows);
    if (!table) return;
    const words = `${t.before} ${t.caption} ${table.columns.join(' ')}`;
    charts.push({
      measures: kindOf(words),
      title: t.caption || null,
      unit: unitOf(`${t.caption} ${table.columns.join(' ')} ${t.before.slice(-120)}`),
      columns: table.columns,
      rows: table.rows
    });
  });
  const base = {
    from: 'live-page',
    product: { brand: data.brand || checked.brand, name: data.name, code: data.sku },
    source: { title: titleOf(html), url: landedUrl || checked.url, kind: 'product-page', retrievedAt: new Date().toISOString().slice(0, 10) },
    scope: 'product-page',
    market: checked.market,
    sizes: data.sizes,
    fit: null,
    verification: 'not-verified',
    comparable: false
  };
  if (charts.length) return Object.assign(base, { status: 'ok', charts: charts.slice(0, 4) });
  if (data.sizes.length) return Object.assign(base, { status: 'labels-only', charts: [] });
  return Object.assign(unavailable(checked, 'no-chart'), { product: base.product, source: base.source });
}

/* The short note, built only from what was found. */
const KIND_WORDS = { body: 'body measurements — the body each size is cut for, not the garment', 'finished-garment': 'finished-garment measurements — the clothing itself', 'not-stated': 'measurements the page doesn’t label as body or garment' };
function noteFor(result) {
  const lines = [];
  if (result.status === 'unavailable') {
    lines.push(REASONS[result.reason] || REASONS.unreadable);
    if (result.source && result.source.url) lines.push('Check the size guide on the brand’s own page.');
    return lines;
  }
  if (result.status === 'labels-only') {
    lines.push(`The product page lists sizes ${result.sizes[0]}${result.sizes.length > 1 ? `–${result.sizes[result.sizes.length - 1]}` : ''} but Fynd found no measurements on it.`);
    return lines;
  }
  result.charts.forEach((c) => {
    const unit = c.unit === 'in' ? ', in inches' : c.unit === 'cm' ? ', in centimetres' : c.unit === 'both' ? ', in inches and centimetres' : ', with no unit stated — check the source';
    lines.push(`${c.title ? `“${c.title}”: ` : ''}${KIND_WORDS[c.measures]}${unit}. It gives ${listOf(c.columns)}.`);
  });
  const kinds = result.charts.map((c) => c.measures);
  if (kinds.includes('body') && !kinds.includes('finished-garment')) lines.push('There are no finished-garment measurements here, so this can’t be set beside a garment you own.');
  if (kinds.includes('not-stated')) lines.push('The page doesn’t say whether these are body or garment measurements, so Fynd doesn’t assume either.');
  if (result.fit) lines.push(`${result.product.brand} describes the fit as “${result.fit.words}” (${result.fit.source}).`);
  if (result.from === 'fynd-record') {
    lines.push(result.verification === 'verified'
      ? `From Fynd’s record of this product, copied from ${result.product.brand}’s page on ${result.source.retrievedAt} and checked against it.`
      : `From Fynd’s record of this product, copied from ${result.product.brand}’s page on ${result.source.retrievedAt} and not yet checked against it.`);
  } else {
    lines.push('Read just now from the product’s page and not checked by a person. Check the source for how each measurement is taken.');
  }
  return lines;
}
const listOf = (items) => {
  const xs = items.map((x) => x.toLowerCase());
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

const cacheKey = (checked) => `sizechart:${CACHE_VERSION}:${crypto.createHash('sha256').update(checked.url).digest('hex').slice(0, 32)}`;

/* The chart for one listing link: { chart } as the endpoint sends it. */
async function chartFor(rawUrl, options) {
  const opts = options || {};
  const checked = checkUrl(rawUrl);
  if (checked.error) {
    const result = unavailable(null, checked.error);
    return Object.assign(result, { note: noteFor(result) });
  }
  const match = recordFor(checked);
  if (match) {
    const result = fromRecord(match, checked);
    return Object.assign(result, { note: noteFor(result) });
  }

  const key = cacheKey(checked);
  if (!opts.noCache) {
    const cached = await store.get(key).catch(() => null);
    if (cached && cached.source && cached.source.url && checkUrl(cached.source.url).url === checked.url) return Object.assign(cached, { cached: true });
  }
  const page = await fetchPage(checked, opts.fetch);
  const result = page.failed ? unavailable(checked, page.failed, page.status ? { status: 'unavailable', httpStatus: page.status } : null) : fromPage(page.html, checked, page.url);
  result.note = noteFor(result);
  /* only kept under the address it was asked for */
  if (result.source) result.source.url = result.source.url || checked.url;
  const ttl = result.status === 'unavailable' ? CACHE_MISS_SECONDS : CACHE_OK_SECONDS;
  if (!opts.noCache) await store.set(key, Object.assign({}, result, { source: Object.assign({}, result.source, { url: checked.url }) }), { ttlSeconds: ttl }).catch(() => {});
  return result;
}

/* Fynd's record for exactly this product, by the code in its link, the
   way a favourite piece is found (engine.matchProduct, which looks in
   one category at a time; a chart is for any). */
function recordFor(checked) {
  for (const category of new Set(RECORDS.map((r) => r.category))) {
    const m = engine.matchProduct({ brand: checked.brand, product: { url: checked.url } }, RECORDS, category);
    if (m) return m.record;
  }
  return null;
}

module.exports = { chartFor, checkUrl, marketOf, fetchPage, productData, tablesOf, sizeTable, unitOf, kindOf, fromPage, fromRecord, noteFor, plain, SUPPORTED_BRANDS, MAX_BYTES };
