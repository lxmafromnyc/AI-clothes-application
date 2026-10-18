/* =========================================================
   Fynd — a product's sizing chart, from its link

   Find Fit (index.html) takes a link to a clothing product from any
   shop; the search page's "View sizing chart" asks the same question
   for one of its results. Both come here (GET /api/size-recommendation
   ?chart=<link>), and the answer is what the product's own pages
   actually publish, or why there is nothing to show. In order:

     1  the address    http or https, no credentials, no unusual port,
                       a public host: never localhost, a private or
                       link-local network, a cloud metadata address or a
                       bare name. The host's addresses are checked when
                       the connection is made, so a name that resolves
                       somewhere private is refused even if it changed
                       its answer since the last look.
     2  Fynd's record  a sizing record for exactly this product (on its
                       brand's own site, by its code — as a favourite
                       piece is found) is used as it stands: body and
                       finished-garment charts kept apart, values as the
                       brand wrote them, and its own verification status.
     3  the page       otherwise the product page, read once: redirects
                       followed by hand, each new address checked again;
                       a time limit; a size limit; HTML only. Its size
                       tables are read deterministically (no model): a
                       table counts only with a size column and at least
                       one measurement column.
     4  its size guide when the page has no table but links to a size
                       guide on the same site ("Size guide", "Size chart",
                       …), up to two such pages are read the same way.
                       Their tables are labelled as the retailer's size
                       guide linked from the page — possibly a general
                       chart, never presented as this product's own.
     5  labels         the sizes the product is sold in, from its JSON-LD,
                       when no table was found anywhere.
     6  fallback       when the page couldn't be read or held no chart, and
                       Fynd knows this exact product belongs to a category
                       its brand publishes one official chart for
                       (official-charts.js), that chart — labelled as the
                       brand's general chart and as a fallback, never as
                       the product's own or as read just now.

   What a table measures — the body, the finished garment, or "not
   stated" — and its unit come only from the page's own words. Values are
   kept as written; nothing missing is filled in, and nothing is
   converted. A page drawn by script, refused, slow, too big or not HTML
   answers "unavailable" with the reason, the page's link and any size
   guide link it had — never a chart from somewhere else. Nothing read is
   ever run; only short plain strings come back, drawn as text.

   Results are cached by address (without tracking parameters): a chart
   for six hours, a failure for thirty minutes.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const store = require('../_store');
const sizingSchema = require('./schema');
const { RECORDS } = require('./records');
const officialCharts = require('./official-charts');
const engine = require('./engine');

/* One deadline for the whole lookup — the product page, its redirects
   and any size guide it links to — kept inside what a serverless
   function is given. The page must start answering within
   HEADERS_MS; what is left of the deadline is for its body and guides. */
const DEADLINE_MS = 9000;
const HEADERS_MS = 6000;
const TIMEOUT_MS = DEADLINE_MS;
const MAX_BYTES = 3000000;
const MAX_REDIRECTS = 3;
const CACHE_OK_SECONDS = 6 * 60 * 60;
const CACHE_MISS_SECONDS = 30 * 60;
const CACHE_VERSION = 'v2';
/* How a size table is recognised, read and labelled: shared with the
   Fynd browser extension, so a table reads the same either way. */
const { MAX_CELL, MAX_ROWS, MAX_COLUMNS, GUIDE_WORDS, sizeTable, unitOf, kindOf, labelTable } = require('../../assets/sizing-tables');

const UA = 'Mozilla/5.0 (compatible; FyndSizing/1.0; +https://ai-clothes-application.vercel.app/about.html)';

/* host -> brand, from the hosts the sizing records already trust */
const HOSTS = new Map();
Object.entries(sizingSchema.OFFICIAL_HOSTS).forEach(([brand, hosts]) => hosts.forEach((h) => HOSTS.set(h, brand)));
const SUPPORTED_BRANDS = Object.keys(sizingSchema.OFFICIAL_HOSTS);

/* ---------- the address ---------- */

/* Is this IP address on the public internet? Loopback, private,
   carrier-grade NAT, link-local (cloud metadata lives there),
   multicast, reserved and documentation ranges are not; nor are their
   IPv6 counterparts or IPv4 written inside IPv6. */
function isPublicAddress(ip) {
  const kind = net.isIP(String(ip || ''));
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if ((a === 198 && b === 51) || (a === 203 && b === 0)) return false;
    return true;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPublicAddress(mapped[1]);
    if (v === '::' || v === '::1') return false;
    if (/^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v)) return false;
    if (/^(64:ff9b|2001:db8|2001::|::ffff)/.test(v)) return false;
    return true;
  }
  return false;
}

const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|ref|ref_src|_ga|igshid)$/i;

/* { url, host, brand, market } or { error } for anything Fynd won't
   fetch. The address may name any shop; it may not name anything that
   isn't plainly a public web page. */
function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return { error: 'invalid-url' };
  let u;
  try { u = new URL(raw.trim()); } catch (err) { return { error: 'invalid-url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'invalid-url' };
  if (u.username || u.password) return { error: 'invalid-url' };
  if (u.port && !((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80'))) return { error: 'blocked-address' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  /* a product page has a name; a bare address, public or not, is refused */
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return { error: 'blocked-address' };
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/.test(host) || host === 'metadata.google.internal') {
    return { error: 'blocked-address' };
  }
  [...u.searchParams.keys()].forEach((k) => { if (TRACKING.test(k)) u.searchParams.delete(k); });
  /* A brand Fynd knows names the product in the path (UNIQLO's
     E471808-000/00, Nike's style code, Zara's p00761810): its query only
     picks a colour or size of that product (colorDisplayCode,
     sizeDisplayCode, v1=…), which no size chart depends on, so the
     product's canonical page is what is read. Any other shop keeps its
     query — gap.com's ?pid= is the product. */
  if (HOSTS.get(host)) [...u.searchParams.keys()].forEach((k) => u.searchParams.delete(k));
  const query = u.searchParams.toString();
  return {
    url: `${u.protocol}//${host}${u.pathname}${query ? `?${query}` : ''}`,
    host,
    brand: HOSTS.get(host) || null,
    market: marketOf(host, u.pathname)
  };
}

/* The market the address names, or null: "/us/en/…", "/en_us/…",
   "/en-gb/…" say it; an address that doesn't is not guessed. */
function marketOf(host, path) {
  const parts = path.split('/').filter(Boolean).slice(0, 2);
  for (const p of parts) {
    const pair = /^[a-z]{2}[_-]([a-z]{2})$/i.exec(p);
    if (pair) return pair[1].toUpperCase();
    if (/^[a-z]{2}$/i.test(p) && !/^(en|fr|es|de|it|ja|zh|ko|pt|nl|sv|da|pl|t|p)$/i.test(p)) return p.toUpperCase();
  }
  return null;
}

/* ---------- reading the page ---------- */

/* The default way pages are fetched: Node's own http(s), with a DNS
   lookup that refuses any non-public address for the connection itself
   (so a name can't be pointed somewhere private between a check and the
   request), and the body cut off past MAX_BYTES. Answers like fetch's
   Response, as far as fetchPage needs it. */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, Object.assign({}, options, { all: true }), (err, addresses) => {
    if (err) return callback(err);
    const list = [].concat(addresses || []);
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      const blocked = new Error('blocked-address');
      blocked.code = 'EBLOCKED';
      return callback(blocked);
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function request(url, init, lookup) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', headers: init.headers, lookup, signal: init.signal }, (res) => {
      /* answered: the headers are here. The body is read on request, and
         an abort from here on is the body being too slow, not the shop
         not answering. Compressed bodies are inflated as they arrive, and
         the size limit applies to what they inflate to. */
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const inflate = encoding === 'br' ? zlib.createBrotliDecompress() : encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : null;
      const stream = inflate ? res.pipe(inflate) : res;
      if (inflate) res.on('error', (err) => inflate.destroy(err));
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (name) => { const v = res.headers[String(name).toLowerCase()]; return Array.isArray(v) ? v.join(', ') : (v || null); } },
        /* null: the body ran past MAX_BYTES and was cut off */
        text: () => new Promise((done, fail) => {
          const chunks = [];
          let total = 0;
          let over = false;
          stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_BYTES) { over = true; res.destroy(); stream.destroy(); done(null); return; }
            chunks.push(chunk);
          });
          let ended = false;
          stream.on('end', () => { ended = true; if (!over) done(Buffer.concat(chunks).toString('utf8')); });
          stream.on('error', (err) => { if (!over) fail(err); });
          /* cut off part-way (an abort, a dropped connection) */
          stream.on('close', () => { if (!ended && !over) fail(Object.assign(new Error('the page stopped arriving'), { name: init.signal && init.signal.aborted ? 'AbortError' : 'Error' })); });
        }),
        /* nothing more is wanted from this answer */
        discard: () => { res.destroy(); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* every real request: through the lookup that refuses non-public addresses */
const guardedTransport = (url, init) => request(url, init, guardedLookup);

let transport = guardedTransport;
/* for the browser suites, whose servers answer in-process and must
   never reach out */
const setTransport = (fn) => { transport = fn || guardedTransport; };

/* A deadline a whole lookup shares. */
const budgetOf = (ms) => { const until = Date.now() + ms; return { left: () => Math.max(0, until - Date.now()) }; };

/* Reads a page from a checked address. Redirects are followed by hand
   so each new address is checked again before it is asked for. What
   happened is recorded either way — the status, how long it took, the
   redirects, the content type and how much arrived — and a failure
   says which step failed:

     no-answer   the shop didn't start answering within HEADERS_MS (or
                 the deadline): nothing came back at all
     slow-page   the shop answered, but the page hadn't finished arriving
                 by the deadline
     refused     401, 403 or 429 — said, never worked around
     …           and the rest below */
async function fetchPage(checked, fetchImpl, budget) {
  const doFetch = fetchImpl || transport;
  const clock = budget || budgetOf(DEADLINE_MS);
  const started = Date.now();
  const trace = { requested: checked.url, url: checked.url, redirects: [], status: null, contentType: null, bytes: null, ms: null, phase: 'connect' };
  const finish = (out) => Object.assign(out, { trace: Object.assign(trace, { ms: Date.now() - started }) });
  let url = checked.url;
  if (clock.left() <= 0) return finish({ failed: 'no-answer' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), clock.left());
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      trace.url = url;
      trace.phase = 'connect';
      const headersTimer = setTimeout(() => controller.abort(), Math.min(HEADERS_MS, clock.left()));
      let response;
      try {
        response = await doFetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' }
        });
      } catch (err) {
        if (err && (err.code === 'EBLOCKED' || err.message === 'blocked-address')) return finish({ failed: 'blocked-address' });
        return finish({ failed: (err && err.name === 'AbortError') || controller.signal.aborted ? 'no-answer' : 'unreachable' });
      } finally {
        clearTimeout(headersTimer);
      }
      trace.status = response.status;
      trace.contentType = (response.headers && response.headers.get && response.headers.get('content-type')) || null;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && response.headers.get && response.headers.get('location');
        if (response.discard) response.discard();
        if (!location) return finish({ failed: 'bad-redirect' });
        let next;
        try { next = checkUrl(new URL(location, url).toString()); } catch (err) { return finish({ failed: 'bad-redirect' }); }
        trace.redirects.push({ status: response.status, to: next.error ? String(location).slice(0, 200) : next.url });
        if (next.error) return finish({ failed: 'redirected-away' });
        url = next.url;
        continue;
      }
      if (response.status === 401 || response.status === 403 || response.status === 429) { if (response.discard) response.discard(); return finish({ failed: 'refused', status: response.status }); }
      if (!response.ok) { if (response.discard) response.discard(); return finish({ failed: 'http-error', status: response.status }); }
      if (trace.contentType && !/html/i.test(trace.contentType)) { if (response.discard) response.discard(); return finish({ failed: 'not-html' }); }
      trace.phase = 'body';
      let body;
      try {
        body = await readCapped(response);
      } catch (err) {
        return finish({ failed: (err && err.name === 'AbortError') || controller.signal.aborted ? 'slow-page' : 'unreadable' });
      }
      if (body === null) return finish({ failed: 'too-large' });
      trace.bytes = Buffer.byteLength(body);
      trace.phase = 'done';
      return finish({ html: body, url });
    }
    return finish({ failed: 'too-many-redirects' });
  } catch (err) {
    return finish({ failed: err && err.name === 'AbortError' ? (trace.phase === 'body' ? 'slow-page' : 'no-answer') : 'unreadable' });
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
    return text === null || Buffer.byteLength(text) > MAX_BYTES ? null : text;
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
  const out = { name: null, brand: null, sku: null, sizes: [], material: null, fit: null };
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
  /* fabric and fit only where the product's own data names them */
  const props = [].concat(product.additionalProperty || []).filter((x) => x && typeof x === 'object');
  const prop = (re) => { const hit = props.find((x) => re.test(String(x.name || ''))); return hit ? str(hit.value) : null; };
  out.material = str(Array.isArray(product.material) ? product.material.join(', ') : product.material) || prop(/^(material|fabric|composition)s?$/i);
  out.fit = prop(/^fit$/i);
  return out;
}

/* Every table in the page, as rows of plain cells, with the words just
   before it (a heading, a tab's name) to say what it measures — only
   words after the table before it, so a "Body size" heading over one
   table never speaks for the "Product size" table that follows. */
function tablesOf(html) {
  const page = visible(html);
  const out = [];
  const re = /<table\b[\s\S]*?<\/table\s*>/gi;
  let m;
  let lastEnd = 0;
  while ((m = re.exec(page)) && out.length < 12) {
    const markup = m[0];
    const before = plain(page.slice(Math.max(lastEnd, m.index - 1500), m.index)).slice(-300);
    lastEnd = m.index + markup.length;
    const caption = plain(((/<caption[^>]*>([\s\S]*?)<\/caption>/i.exec(markup) || [])[1]) || '', 160);
    const rows = (markup.match(/<tr\b[\s\S]*?<\/tr\s*>/gi) || []).slice(0, MAX_ROWS + 1)
      .map((tr) => (tr.match(/<t[hd]\b[\s\S]*?<\/t[hd]\s*>/gi) || []).slice(0, MAX_COLUMNS).map((cell) => plain(cell, MAX_CELL)))
      .filter((cells) => cells.some(Boolean));
    if (rows.length) out.push({ rows, caption, before });
  }
  return out;
}

/* The name the site gives itself, or its host. */
function retailerOf(html, host) {
  const m = /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(html)
    || /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i.exec(html);
  return (m && plain(m[1], 60)) || host.replace(/^www\d?\./, '');
}

/* The market the page states for itself (og:locale "en_US"), if any. */
function localeMarket(html) {
  const m = /<meta[^>]+property=["']og:locale["'][^>]*content=["'][a-z]{2}[_-]([a-z]{2})["']/i.exec(html)
    || /<meta[^>]+content=["'][a-z]{2}[_-]([a-z]{2})["'][^>]*property=["']og:locale["']/i.exec(html);
  return m ? m[1].toUpperCase() : null;
}

const registrable = (host) => host.split('.').slice(-2).join('.');

/* Links from the page to its own size guide: same site, said so by
   their words or their address. At most three, never the page itself. */
function guideLinks(html, pageUrl) {
  const out = [];
  const page = new URL(pageUrl);
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(visible(html))) && out.length < 3) {
    const href = (/\bhref=["']([^"']+)["']/i.exec(m[1]) || [])[1];
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    const words = `${plain(m[2], 80)} ${(/\b(?:aria-label|title)=["']([^"']+)["']/i.exec(m[1]) || [])[1] || ''}`;
    let target;
    try { target = new URL(decode(href), page); } catch (err) { continue; }
    if (!GUIDE_WORDS.test(words) && !GUIDE_WORDS.test(decodeURIComponent(target.pathname).replace(/[-_/]/g, ' '))) continue;
    if (registrable(target.hostname.toLowerCase()) !== registrable(page.hostname.toLowerCase())) continue;
    target.hash = '';
    if (target.href === page.href || out.includes(target.href)) continue;
    out.push(target.href);
  }
  return out;
}

/* A page whose content is drawn by script after it loads: next to no
   readable text, or an empty application root. */
function drawnByScript(html) {
  const text = plain(visible(html));
  return text.length < 400 || /<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(html);
}

/* ---------- the answer ---------- */

const unavailable = (checked, reason, extra) => Object.assign({
  status: 'unavailable',
  reason,
  product: checked && checked.brand ? { brand: checked.brand, name: null } : null,
  retailer: checked && checked.host ? checked.host.replace(/^www\d?\./, '') : null,
  source: checked && checked.url ? { title: null, url: checked.url, kind: 'product-page' } : null,
  guides: [],
  market: checked ? checked.market || null : null,
  charts: [],
  sizes: [],
  verification: 'not-verified'
}, extra || {});

const REASONS = {
  'invalid-url': 'That isn’t a valid product link. Paste the full address of a product page, starting with https://.',
  'blocked-address': 'Fynd only reads public web pages, and that address points somewhere it won’t go.',
  refused: 'The retailer’s site refused Fynd’s request for this page. Fynd doesn’t try to get around that.',
  timeout: 'The retailer’s page took too long to answer.',
  'no-answer': 'The retailer’s site didn’t start answering within a few seconds. Some shops hold back automated requests rather than refusing them; Fynd doesn’t try to get around that.',
  'slow-page': 'The retailer’s site answered, but the page hadn’t finished arriving in time.',
  'guide-unreadable': 'The product page loaded and links to a size guide, but that guide couldn’t be read.',
  unreachable: 'The retailer’s page couldn’t be reached.',
  'http-error': 'The retailer’s page answered with an error.',
  'redirected-away': 'The page redirected to an address Fynd won’t read.',
  'bad-redirect': 'The page redirected to an address Fynd couldn’t follow.',
  'too-many-redirects': 'The page redirected too many times.',
  'not-html': 'That link isn’t a web page.',
  'too-large': 'The page was too large to read.',
  unreadable: 'The page couldn’t be read.',
  'needs-script': 'This page builds its content with JavaScript after it loads, which Fynd doesn’t run, so no size table was in what it received.',
  'no-chart': 'The page Fynd received has no size table it could read, and no size guide it could read was linked from it.'
};
/* the page itself was read: what failed was finding a chart in it */
const PAGE_READ = ['no-chart', 'needs-script', 'guide-unreadable'];
const COULD_NOT = 'We couldn’t retrieve a usable sizing chart from this product page. You can open the original product page or try the retailer’s official size guide.';


/* What each kind of chart is worth to a shopper choosing this garment,
   most first: the garment's own measurements, then a table that doesn't
   say, then the body each size is cut for. Charts are answered in this
   order, so whatever draws them leads with the garment. */
const KIND_ORDER = { 'finished-garment': 0, 'not-stated': 1, body: 2 };
const byKind = (charts) => charts.map((c, i) => [c, i]).sort((a, b) => (KIND_ORDER[a[0].measures] - KIND_ORDER[b[0].measures]) || a[1] - b[1]).map(([c]) => c);

/* A chart from Fynd's own record of this product: body and garment
   charts kept apart, each value as the brand wrote it, the garment's
   first. Each column says how the brand measured it (`methods`, in the
   engine's words), so a flat width is never read as a circumference. */
function fromRecord(record, checked) {
  const charts = [];
  const add = (chart, measures) => {
    if (!chart) return;
    const keys = Object.keys(chart.dimensions);
    charts.push({
      measures,
      title: chart.label || null,
      unit: record.units,
      source: { url: chart.source && /^https:/.test(chart.source.url || '') ? chart.source.url : record.product.url, title: null },
      columns: keys.map((k) => chart.dimensions[k].label || k),
      methods: keys.map((k) => engine.METHOD_WORDS[chart.dimensions[k].method] || null),
      rows: record.sizes.filter((s) => chart.sizes[s]).map((s) => ({ size: s, values: keys.map((k) => (chart.sizes[s][k] ? String(chart.sizes[s][k].text) : '')) }))
    });
  };
  add(record.charts.garment, 'finished-garment');
  add(record.charts.body, 'body');
  return {
    status: 'ok',
    from: 'fynd-record',
    productId: record.id,
    product: { brand: record.brand, name: record.product.name, code: record.product.code || null },
    retailer: record.brand,
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

/* A brand's general official chart, used because the product's own
   page couldn't be read (`live` is what that attempt answered). Shown
   as the brand's chart for the category and as a fallback; a body chart,
   so never comparable with a garment. */
function fromOfficial(found, checked, live) {
  const { chart, product } = found;
  const [first, ...rest] = chart.evidence;
  return {
    status: 'fallback',
    from: 'official-fallback',
    fallback: { reason: live.status === 'labels-only' ? 'labels-only' : live.reason, chartId: chart.id },
    product: { brand: chart.brand, name: product.name, code: product.code },
    details: live.details || null,
    retailer: chart.brand,
    source: { title: `${chart.brand} product page (not read)`, url: checked.url, kind: 'product-page', retrievedAt: null },
    otherSources: rest.map((e) => ({ url: e.url, what: `The same chart on ${chart.brand}’s ${e.what}, read ${e.retrievedAt}` })),
    scope: 'brand-general',
    market: chart.market,
    line: product.line,
    charts: [{
      measures: 'body',
      label: chart.label,
      title: chart.title,
      unit: chart.units,
      source: { url: first.url, title: `${chart.brand}’s ${first.what}, read ${first.retrievedAt}` },
      columns: chart.columns.map((c) => c.label),
      rows: chart.sizes.map((s) => ({ size: s, values: chart.columns.map((c) => chart.values[s][c.key]) }))
    }],
    sizes: chart.sizes.slice(),
    fit: null,
    evidenceDate: chart.evidenceDate,
    provenance: chart.provenance,
    verification: 'official-general',
    comparable: false,
    guides: live.guides || []
  };
}

/* The size tables in one page, each labelled with where it came from. */
function chartsIn(html, pageUrl, title) {
  const out = [];
  tablesOf(html).forEach((t) => {
    const chart = labelTable(t);
    if (chart) out.push(Object.assign(chart, { source: { url: pageUrl, title: title || null } }));
  });
  return out;
}

/* What the product page — and, failing that, the size guide it links
   to — gave. `guides` are the pages read: [{ url, html }]. */
function fromPage(html, checked, landedUrl, guides) {
  const data = productData(html);
  const pageUrl = landedUrl || checked.url;
  const pageTitle = titleOf(html);
  let charts = chartsIn(html, pageUrl, pageTitle);
  let scope = 'product-page';
  if (!charts.length) {
    (guides || []).forEach((g) => { if (g.html) charts = charts.concat(chartsIn(g.html, g.url, titleOf(g.html))); });
    scope = 'linked-size-guide';
  }
  const base = {
    from: 'live-page',
    product: { brand: data.brand || checked.brand || null, name: data.name, code: data.sku },
    details: { material: data.material, fit: data.fit },
    retailer: retailerOf(html, new URL(pageUrl).hostname),
    source: { title: pageTitle, url: pageUrl, kind: 'product-page', retrievedAt: new Date().toISOString().slice(0, 10) },
    guides: (guides || []).map((g) => ({ url: g.url, read: Boolean(g.html), reason: g.failed || null })),
    scope,
    market: checked.market || localeMarket(html),
    sizes: data.sizes,
    fit: null,
    verification: 'not-verified',
    comparable: false
  };
  if (charts.length) return Object.assign(base, { status: 'ok', charts: byKind(charts).slice(0, 4) });
  if (data.sizes.length) return Object.assign(base, { status: 'labels-only', charts: [] });
  const triedGuides = (guides || []).length && (guides || []).every((g) => !g.html);
  const reason = triedGuides ? 'guide-unreadable' : drawnByScript(html) ? 'needs-script' : 'no-chart';
  return Object.assign(unavailable(checked, reason), { product: base.product, details: base.details, retailer: base.retailer, source: base.source, guides: base.guides, market: base.market, sizes: [] });
}

/* The short note, built only from what was found. */
const KIND_WORDS = { body: 'body measurements — the body each size is cut for, not the garment', 'finished-garment': 'finished-garment measurements — the clothing itself', 'not-stated': 'measurements the page doesn’t label as body or garment' };
function noteFor(result) {
  const lines = [];
  if (result.status === 'unavailable') {
    lines.push(REASONS[result.reason] || REASONS.unreadable);
    if (result.reason === 'guide-unreadable') {
      result.guides.forEach((g) => { if (g.reason) lines.push(`The size guide at ${g.url}: ${(REASONS[g.reason] || REASONS.unreadable).replace(/^The retailer’s (page|site)/, 'it')}`); });
    }
    if (PAGE_READ.includes(result.reason) && result.product && (result.product.name || (result.details && (result.details.material || result.details.fit)))) {
      lines.push('The product page itself did load; what it said about the product is shown below, without a measurement chart.');
    }
    if (result.source && result.source.url) lines.push(COULD_NOT);
    return lines;
  }
  if (result.status === 'fallback') {
    const why = result.fallback.reason;
    const said = (t) => t.charAt(0).toLowerCase() + t.slice(1);
    if (PAGE_READ.includes(why) || why === 'labels-only') {
      lines.push(`Fynd read this product’s page, but found no size chart in it: ${why === 'labels-only' ? 'only size labels.' : said(REASONS[why])}`);
    } else {
      lines.push(`${why === 'no-answer' || why === 'slow-page' ? 'Reading this product’s page directly timed out' : 'This product’s page couldn’t be read'}: ${said(REASONS[why] || REASONS.unreadable)}`);
    }
    const c = result.charts[0];
    lines.push(`So this is a fallback chart, not one extracted from the product’s page: ${result.product.brand}’s general Body Size chart for its ${c.title.replace(/ —.*$/, '').replace(`${result.product.brand} `, '')}, which this product is one of.`);
    lines.push(`${result.product.brand} publishes this same chart, value for value, on ${result.otherSources.length + 1} of those products; Fynd copied it from them by ${result.evidenceDate}. It hasn’t been confirmed on this product’s own page, and this product may be sold in fewer sizes.`);
    lines.push(`Units: ${c.unit === 'in' ? 'inches' : 'centimetres'}, as published. It gives ${listOf(c.columns)}.`);
    lines.push('There are no finished-garment measurements here, so this can’t be set beside a garment you own.');
    return lines;
  }
  if (result.status === 'labels-only') {
    lines.push(`The product page lists sizes ${result.sizes[0]}${result.sizes.length > 1 ? `–${result.sizes[result.sizes.length - 1]}` : ''}, but Fynd found no measurements on it${(result.guides || []).length ? ' or in the size guide it links to' : ''}.`);
    return lines;
  }
  if (result.scope === 'linked-size-guide') {
    lines.push('The product page has no size table of its own. This chart is from the retailer’s size guide linked from that page — it may be a general chart for the category, not one for this product only.');
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
    lines.push('Read just now from the retailer’s page and not checked by a person. Check the source for how each measurement is taken.');
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
  const match = checked.brand ? recordFor(checked) : null;
  if (match) {
    const result = fromRecord(match, checked);
    return Object.assign(result, { note: noteFor(result) });
  }

  const key = cacheKey(checked);
  if (!opts.noCache) {
    const cached = await store.get(key).catch(() => null);
    if (cached && cached.source && cached.source.url && checkUrl(cached.source.url).url === checked.url) return Object.assign(cached, { cached: true });
  }
  /* one deadline for the page, its redirects and its size guides */
  const budget = budgetOf(opts.deadlineMs || DEADLINE_MS);
  const page = await fetchPage(checked, opts.fetch, budget);
  const traces = [page.trace];
  let result;
  if (page.failed) {
    result = unavailable(checked, page.failed, page.status ? { httpStatus: page.status } : null);
  } else {
    /* no table on the page: the size guide it links to, read the same
       way, in what is left of the deadline */
    let guides = [];
    if (!chartsIn(page.html, page.url).length) {
      guides = await Promise.all(guideLinks(page.html, page.url).slice(0, 2).map(async (url) => {
        const g = checkUrl(url);
        if (g.error) return { url, failed: g.error };
        const got = await fetchPage(g, opts.fetch, budget);
        traces.push(got.trace);
        return got.failed ? { url, failed: got.failed } : { url: got.url, html: got.html };
      }));
    }
    result = fromPage(page.html, checked, page.url, guides);
  }
  /* the page gave no chart: a general official chart, only for a
     product Fynd knows belongs to its category */
  if (result.status === 'unavailable' || result.status === 'labels-only') {
    const found = officialCharts.fallbackFor(checked);
    if (found) result = fromOfficial(found, checked, result);
  }
  /* what was asked for, and what came back: no profile, nothing private */
  result.trace = traces.filter(Boolean);
  result.note = noteFor(result);
  /* only kept under the address it was asked for */
  if (result.source) result.source.url = result.source.url || checked.url;
  /* a fallback is kept only as long as a failure: the page may answer next time */
  const ttl = result.status === 'unavailable' || result.status === 'fallback' ? CACHE_MISS_SECONDS : CACHE_OK_SECONDS;
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

module.exports = { request, DEADLINE_MS, HEADERS_MS, PAGE_READ, chartFor, checkUrl, isPublicAddress, guardedLookup, marketOf, fetchPage, setTransport, productData, tablesOf, sizeTable, guideLinks, drawnByScript, unitOf, kindOf, fromPage, fromRecord, fromOfficial, noteFor, plain, SUPPORTED_BRANDS, MAX_BYTES, COULD_NOT };
