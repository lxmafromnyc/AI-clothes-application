/* =========================================================
   Fynd — a product's sizing chart, from its link

   Find Fit (index.html) takes a link to a clothing product from any
   shop; the search page's "View sizing chart" asks the same question
   for one of its results. Both come here (GET /api/size-recommendation
   ?chart=<link>), and the answer is what the product's own pages
   actually publish, or why there is nothing to show. The UNIQLO browser
   and a product's own page ask by brand and code (?brand=&item=), which
   resolves to the product's address and comes here too; the browser
   extension reads the same tables with the same code
   (assets/sizing-tables.js). Every product is looked for its own
   finished-garment measurements first. In order:

     1  the address    http or https, no credentials, no unusual port,
                       a public host: never localhost, a private or
                       link-local network, a cloud metadata address or a
                       bare name. The host's addresses are checked when
                       the connection is made, so a name that resolves
                       somewhere private is refused even if it changed
                       its answer since the last look.
     2  Fynd's record  a sizing record for exactly this product (on its
                       brand's own site, by its whole code, in its own
                       market) that holds the garment's own measurements
                       is used as it stands: body and finished-garment
                       charts kept apart, values as the brand wrote them,
                       its own verification status, and no page read.
     3  the page       otherwise the product page — but only where
                       page-access.js permits it: the site's terms
                       reviewed and found to allow it, and its robots.txt
                       allowing the path, checked for every address
                       fetched. As deployed no domain is permitted, so
                       this step and step 4 fetch nothing and the answer
                       comes from steps 5–7 or says why there is none
                       ('unreviewed', 'not-permitted', 'robots-…').
                       Where permitted: read once, redirects
                       followed by hand, each new address checked again;
                       a time limit; a size limit; HTML only. Its size
                       tables are read deterministically (no model): a
                       table counts only with a size column and at least
                       one measurement column.
     4  its size guide when the page has no finished-garment table but
                       links to a size guide on the same site ("Size
                       guide", "Size chart", …), up to two such pages are
                       read the same way.
                       Their tables are labelled as the retailer's size
                       guide linked from the page — possibly a general
                       chart, never presented as this product's own.
     5  body record    a record of this product holding only the
                       brand's body chart joins what the page gave, after
                       any garment chart the page or its guide had; when
                       they had none, the record is the answer.
     6  labels         the sizes the product is sold in, from its JSON-LD,
                       when no table was found anywhere.
     7  fallback       when the page couldn't be read or held no chart, and
                       Fynd knows this exact product belongs to a category
                       its brand publishes one official chart for
                       (official-charts.js), that chart — labelled as the
                       brand's general chart and as a fallback, never as
                       the product's own or as read just now.

   Every chart says where it came from (`origin`: fynd-record,
   product-page, linked-size-guide, official-general) and its own
   `verification`, so a page's garment table and a record's body chart
   can stand in one answer without either borrowing the other's status.
   An answer with no finished-garment chart says so (`productSize`: not
   retrieved, the page couldn't be read; or not found, it was read and
   had none), with the date it was looked for — never filled in.

   What a table measures — the body, the finished garment, or "not
   stated" — and its unit come only from the page's own words. Values are
   kept as written; nothing missing is filled in, and nothing is
   converted. A page drawn by script, refused, slow, too big or not HTML
   answers "unavailable" with the reason, the page's link and any size
   guide link it had — never a chart from somewhere else. Nothing read is
   ever run; only short plain strings come back, drawn as text.

   The page's own answer is cached by address (without tracking
   parameters): a chart for six hours, a failure for thirty minutes.
   Records are joined to it afresh on every lookup.
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
const { RECORDS, recordFrom } = require('./records');
const officialCharts = require('./official-charts');
const engine = require('./engine');
const pageAccess = require('./page-access');

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
/* v5: pages are read only where page-access.js permits it, so nothing
   read before that rule is served */
const CACHE_VERSION = 'v5';
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

/* The market the address names, or null (schema.marketOf: the same
   rule the size engine matches a product's link by). */
function marketOf(host, path) {
  return sizingSchema.marketOf(path);
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
async function fetchPage(checked, fetchImpl, budget, options) {
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
      /* the site's terms reviewed and permitting it, and its robots.txt
         allowing this path — for every address, redirects included */
      const access = await pageAccess.check(url, doFetch, { 'User-Agent': UA }, clock, options);
      if (!access.allowed) { trace.access = access.reason; return finish({ failed: access.reason }); }
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
  'no-chart': 'The page Fynd received has no size table it could read, and no size guide it could read was linked from it.',
  unreviewed: 'Fynd hasn’t confirmed that this retailer allows its pages to be read automatically, so it didn’t fetch this one.',
  'not-permitted': 'This retailer’s terms don’t allow its pages to be read automatically, so Fynd didn’t fetch this one.',
  'robots-disallowed': 'This retailer’s robots.txt asks automated readers not to fetch this page, so Fynd didn’t.',
  'robots-unavailable': 'Fynd couldn’t read this retailer’s robots.txt, so it didn’t fetch the page.'
};
/* the page itself was read: what failed was finding a chart in it */
const PAGE_READ = ['no-chart', 'needs-script', 'guide-unreadable'];
/* the page was never asked for: page-access.js said not to */
const NOT_FETCHED = ['unreviewed', 'not-permitted', 'robots-disallowed', 'robots-unavailable'];
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
  const from = recordFrom(record);
  const add = (chart, measures) => {
    if (!chart) return;
    const keys = Object.keys(chart.dimensions);
    charts.push({
      measures,
      title: chart.label || null,
      unit: record.units,
      source: { url: /^https:/.test(chart.source || '') ? chart.source : record.product.url, title: null },
      origin: 'fynd-record',
      recordFrom: from,
      verification: sizingSchema.isVerified(record) ? 'verified' : 'unverified',
      retrievedAt: chart.retrievedAt || record.retrievedAt,
      columns: keys.map((k) => chart.dimensions[k].label || k),
      methods: keys.map((k) => engine.METHOD_WORDS[chart.dimensions[k].method] || null),
      /* each column's method as the record holds it (schema.js), so a
         reader can tell a flat width from a circumference, a body
         measurement, or one whose method the source doesn't state */
      methodIds: keys.map((k) => chart.dimensions[k].method),
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
    recordFrom: from,
    capture: (record.capture && record.capture.how) || 'copied-from-page',
    comparable: sizingSchema.isVerified(record) && Boolean(record.charts.garment)
  };
}

/* A brand's general official chart, used because the product's own
   page couldn't be read (`live` is what that attempt answered). Shown
   as the brand's chart for the category and as a fallback; a body chart,
   so never comparable with a garment. */
/* The general chart itself, as one chart of an answer. */
function officialChartOf(chart) {
  const first = chart.evidence[0];
  return {
    measures: 'body',
    origin: 'official-general',
    verification: 'official-general',
    label: chart.label,
    title: chart.title,
    unit: chart.units,
    source: { url: first.url, title: `${chart.brand}’s ${first.what}, read ${first.retrievedAt}` },
    columns: chart.columns.map((c) => c.label),
    rows: chart.sizes.map((s) => ({ size: s, values: chart.columns.map((c) => chart.values[s][c.key]) }))
  };
}
const officialSources = (chart) => chart.evidence.slice(1).map((e) => ({ url: e.url, what: `The same chart on ${chart.brand}’s ${e.what}, read ${e.retrievedAt}` }));

function fromOfficial(found, checked, live) {
  const { chart, product } = found;
  return {
    status: 'fallback',
    from: 'official-fallback',
    fallback: { reason: live.status === 'labels-only' ? 'labels-only' : live.reason, chartId: chart.id },
    product: { brand: chart.brand, name: product.name, code: product.code },
    details: live.details || null,
    retailer: chart.brand,
    source: { title: `${chart.brand} product page (not read)`, url: checked.url, kind: 'product-page', retrievedAt: null },
    otherSources: officialSources(chart),
    scope: 'brand-general',
    market: chart.market,
    line: product.line,
    charts: [officialChartOf(chart)],
    sizes: chart.sizes.slice(),
    fit: null,
    /* where else this product's own measurements were looked for, when
       Fynd recorded that (chartFor adds this attempt) */
    triedBefore: ((product.productSize && product.productSize.tried) || []).slice(),
    evidenceDate: chart.evidenceDate,
    provenance: chart.provenance,
    verification: 'official-general',
    comparable: false,
    guides: live.guides || []
  };
}

/* The size tables in one page, each labelled with where it came from. */
function chartsIn(html, pageUrl, title, origin) {
  const out = [];
  tablesOf(html).forEach((t) => {
    const chart = labelTable(t);
    if (chart) out.push(Object.assign(chart, { origin: origin || 'product-page', verification: 'not-verified', source: { url: pageUrl, title: title || null } }));
  });
  return out;
}
const isGarment = (c) => c.measures === 'finished-garment';

/* What the product page — and, failing that, the size guide it links
   to — gave. `guides` are the pages read: [{ url, html }]. */
function fromPage(html, checked, landedUrl, guides) {
  const data = productData(html);
  const pageUrl = landedUrl || checked.url;
  const pageTitle = titleOf(html);
  const own = chartsIn(html, pageUrl, pageTitle, 'product-page');
  let fromGuides = [];
  (guides || []).forEach((g) => { if (g.html) fromGuides = fromGuides.concat(chartsIn(g.html, g.url, titleOf(g.html), 'linked-size-guide')); });
  /* the page's own tables first; a guide's are read only when the page
     has no garment table, and only its garment tables join a page that
     already has a body one — a general guide's body chart adds nothing */
  const charts = own.length ? own.concat(fromGuides.filter(isGarment)) : fromGuides;
  /* the answer is named for its first chart: a guide's garment table
     leads a page that only had the body's */
  const scope = charts.length && byKind(charts)[0].origin === 'linked-size-guide' ? 'linked-size-guide' : 'product-page';
  const base = {
    from: 'live-page',
    product: { brand: data.brand || checked.brand || null, name: data.name, code: data.sku },
    details: { material: data.material, fit: data.fit },
    retailer: retailerOf(html, new URL(pageUrl).hostname),
    /* the moment it was read (ISO, UTC): the page shows its date in the viewer's time zone */
    source: { title: pageTitle, url: pageUrl, kind: 'product-page', retrievedAt: new Date().toISOString() },
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
    } else if (NOT_FETCHED.includes(why)) {
      lines.push(`Fynd didn’t read this product’s page. ${REASONS[why]}`);
    } else {
      lines.push(`${why === 'no-answer' || why === 'slow-page' ? 'Reading this product’s page directly timed out' : 'This product’s page couldn’t be read'}: ${said(REASONS[why] || REASONS.unreadable)}`);
    }
    const c = result.charts[0];
    lines.push(`So this is a fallback chart, not one extracted from the product’s page: ${result.product.brand}’s general Body Size chart for its ${c.title.replace(/ —.*$/, '').replace(`${result.product.brand} `, '')}, which this product is one of.`);
    lines.push(`${result.product.brand} publishes this same chart, value for value, on ${result.otherSources.length + 1} of those products; Fynd copied it from them by ${result.evidenceDate}. It hasn’t been confirmed on this product’s own page, and this product may be sold in fewer sizes.`);
    lines.push(`Units: ${c.unit === 'in' ? 'inches' : 'centimetres'}, as published. It gives ${listOf(c.columns)}.`);
    lines.push(productSizeLine(result));
    lines.push('There are no finished-garment measurements here, so this can’t be set beside a garment you own.');
    return lines;
  }
  if (result.status === 'labels-only') {
    lines.push(`The product page lists sizes ${result.sizes[0]}${result.sizes.length > 1 ? `–${result.sizes[result.sizes.length - 1]}` : ''}, but Fynd found no measurements on it${(result.guides || []).length ? ' or in the size guide it links to' : ''}.`);
    return lines;
  }
  if (result.scope === 'linked-size-guide') {
    lines.push(result.charts.some((c) => c.origin === 'product-page')
      ? 'The product page has no garment measurements of its own. The garment chart is from the retailer’s size guide linked from that page — it may be a general chart for the category, not one for this product only.'
      : 'The product page has no size table of its own. This chart is from the retailer’s size guide linked from that page — it may be a general chart for the category, not one for this product only.');
  }
  result.charts.forEach((c) => {
    const unit = c.unit === 'in' ? ', in inches' : c.unit === 'cm' ? ', in centimetres' : c.unit === 'both' ? ', in inches and centimetres' : ', with no unit stated — check the source';
    lines.push(`${c.title ? `“${c.title}”: ` : ''}${KIND_WORDS[c.measures]}${unit}. It gives ${listOf(c.columns)}.`);
  });
  const kinds = result.charts.map((c) => c.measures);
  if (!kinds.includes('finished-garment') && result.productSize) lines.push(productSizeLine(result));
  if (kinds.includes('body') && !kinds.includes('finished-garment')) lines.push('There are no finished-garment measurements here, so this can’t be set beside a garment you own.');
  const origins = new Set(result.charts.map((c) => c.origin));
  /* charts from different places: where each is from, chart by chart */
  const mixed = origins.size > 1;
  if (mixed) result.charts.forEach((c) => lines.push(originNote(c, result.product.brand)));
  if (kinds.includes('not-stated')) lines.push('The page doesn’t say whether these are body or garment measurements, so Fynd doesn’t assume either.');
  if (result.fit) lines.push(`${result.product.brand} describes the fit as “${result.fit.words}” (${result.fit.source}).`);
  if (mixed) {
    /* said above, chart by chart */
  } else if (result.from === 'fynd-record') {
    lines.push(result.verification === 'verified'
      ? `From Fynd’s record of this product, ${result.recordFrom}, and checked against it.`
      : `From Fynd’s record of this product, ${result.recordFrom}. Not yet checked against it, so it isn’t compared with a garment you own.`);
  } else {
    lines.push('Read just now from the retailer’s page and not checked by a person. Check the source for how each measurement is taken.');
  }
  return lines;
}
/* Where one chart of a mixed answer is from, for the notes. */
function originNote(c, brand) {
  const what = c.measures === 'finished-garment' ? 'garment' : c.measures === 'body' ? 'body' : 'unlabelled';
  if (c.origin === 'fynd-record') return `The ${what} chart is from Fynd’s record of this product, ${c.recordFrom}${c.verification === 'verified' ? ', and checked against it' : '; not yet checked'}.`;
  if (c.origin === 'official-general') return `The ${what} chart is ${brand}’s general chart for this kind of product, not this product’s own.`;
  if (c.origin === 'linked-size-guide') return `The ${what} chart is from the size guide the product’s page links to — possibly a general chart — read just now and not checked.`;
  return `The ${what} chart was read from the product’s page just now and isn’t checked.`;
}
const listOf = (items) => {
  const xs = items.map((x) => x.toLowerCase());
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

const cacheKey = (checked) => `sizechart:${CACHE_VERSION}:${crypto.createHash('sha256').update(checked.url).digest('hex').slice(0, 32)}`;

/* What the product's own page (and the size guide it links to) gave,
   read once and cached by address: the part of an answer that depends
   on the retailer, never on Fynd's records. */
async function liveFor(checked, opts) {
  /* a site whose terms haven't been reviewed and found to permit it is
     never fetched, and nothing read from it before is served */
  const may = pageAccess.permission(checked.host);
  if (!may.allowed) {
    const refused = unavailable(checked, may.reason);
    return Object.assign(refused, { trace: [], checkedAt: new Date().toISOString() });
  }
  const key = cacheKey(checked);
  if (!opts.noCache) {
    const cached = await store.get(key).catch(() => null);
    if (cached && cached.source && cached.source.url && checkUrl(cached.source.url).url === checked.url) return Object.assign(cached, { cached: true });
  }
  /* one deadline for the page, its redirects and its size guides */
  const budget = budgetOf(opts.deadlineMs || DEADLINE_MS);
  const page = await fetchPage(checked, opts.fetch, budget, opts);
  const traces = [page.trace];
  let result;
  if (page.failed) {
    result = unavailable(checked, page.failed, page.status ? { httpStatus: page.status } : null);
  } else {
    /* no garment table on the page: the size guide it links to, read
       the same way, in what is left of the deadline */
    let guides = [];
    if (!chartsIn(page.html, page.url).some(isGarment)) {
      guides = await Promise.all(guideLinks(page.html, page.url).slice(0, 2).map(async (url) => {
        const g = checkUrl(url);
        if (g.error) return { url, failed: g.error };
        const got = await fetchPage(g, opts.fetch, budget, opts);
        traces.push(got.trace);
        return got.failed ? { url, failed: got.failed } : { url: got.url, html: got.html };
      }));
    }
    result = fromPage(page.html, checked, page.url, guides);
  }
  result.trace = traces.filter(Boolean);
  result.checkedAt = new Date().toISOString();
  /* only kept under the address it was asked for */
  if (result.source) result.source.url = result.source.url || checked.url;
  const ttl = result.status === 'unavailable' ? CACHE_MISS_SECONDS : CACHE_OK_SECONDS;
  if (!opts.noCache) await store.set(key, Object.assign({}, result, { source: Object.assign({}, result.source, { url: checked.url }) }), { ttlSeconds: ttl }).catch(() => {});
  return result;
}

/* Whether this lookup found the product's own finished-garment
   measurements, and if not, why: the page couldn't be read
   ("not-retrieved") or it was read and had none ("not-found"). */
function productSizeOf(live) {
  const read = live.status !== 'unavailable' || PAGE_READ.includes(live.reason);
  return { status: read ? 'not-found' : 'not-retrieved', reason: live.status === 'unavailable' ? live.reason : live.status, checkedAt: live.checkedAt || null, guides: (live.guides || []).length > 0 };
}
function productSizeLine(result) {
  const ps = result.productSize || {};
  const brand = (result.product && result.product.brand) || 'the brand';
  /* when it was looked for is kept (checkedAt, a moment) and shown by
     the page in the viewer's own time zone; a note written here can't
     know that zone, so it names no date */
  if (ps.status === 'not-retrieved' && NOT_FETCHED.includes(ps.reason)) {
    return `This product’s own measurements — a Product Size chart, where ${brand} publishes one — weren’t looked for: Fynd doesn’t read ${brand}’s pages without confirmed permission. None are shown, and none are worked out from a body chart.`;
  }
  return ps.status === 'not-retrieved'
    ? `This product’s own measurements — a Product Size chart, where ${brand} publishes one — weren’t found: its page couldn’t be read. None are shown, and none are worked out from a body chart.`
    : `This product’s page${ps.guides ? ' and the size guide it links to' : ''} had no finished-garment measurements. None are shown, and none are worked out from a body chart.`;
}

/* A record of this product that holds only the brand's body chart,
   joined to the garment chart the page gave: the page's garment and
   unlabelled tables, then the record's body chart in place of the
   page's own (the record's is checked or dated; the same brand's). */
function withRecordBody(live, record, checked) {
  const rec = fromRecord(record, checked);
  return Object.assign({}, live, {
    product: rec.product,
    productId: record.id,
    line: rec.line,
    market: rec.market,
    sizes: record.sizes.slice(),
    fit: rec.fit,
    charts: live.charts.filter((c) => c.measures !== 'body').concat(rec.charts),
    otherSources: [{ url: record.product.url, what: `Fynd’s record of this product (body chart), copied ${record.retrievedAt}` }],
    comparable: false
  });
}

/* The chart for one listing link: { chart } as the endpoint sends it. */
async function chartFor(rawUrl, options) {
  const opts = options || {};
  const checked = checkUrl(rawUrl);
  if (checked.error) {
    const result = unavailable(null, checked.error);
    return Object.assign(result, { note: noteFor(result) });
  }
  const record = checked.brand ? recordFor(checked) : null;
  const finish = (result) => Object.assign(result, { note: noteFor(result) });
  /* 1: a record of exactly this product with the garment's own
     measurements answers without reading anything */
  if (record && record.charts.garment) {
    const result = fromRecord(record, checked);
    /* a record without the brand's body chart: a general one that
       applies to this exact product goes beside it, after the garment's
       and labelled general — never instead of it */
    const general = record.charts.body ? null : officialCharts.fallbackFor(checked);
    if (general) {
      result.charts.push(officialChartOf(general.chart));
      result.otherSources = result.otherSources.concat(officialSources(general.chart));
    }
    return finish(result);
  }

  /* 2: everything else is looked for on the product's own page first */
  const live = await liveFor(checked, opts);
  const liveGarment = live.status === 'ok' && live.charts.some(isGarment);
  let result;
  if (record) {
    result = liveGarment ? withRecordBody(live, record, checked)
      : Object.assign(fromRecord(record, checked), { trace: live.trace, guides: live.guides || [], productSize: productSizeOf(live) });
  } else {
    result = Object.assign({}, live);
    /* the page gave no chart: a general official chart, only for a
       product Fynd knows belongs to its category */
    if (result.status === 'unavailable' || result.status === 'labels-only') {
      const found = officialCharts.fallbackFor(checked);
      if (found) result = Object.assign(fromOfficial(found, checked, live), { trace: live.trace });
    }
    if (!liveGarment && result.status !== 'unavailable') {
      result.productSize = productSizeOf(live);
      if (result.triedBefore && result.triedBefore.length) result.productSize.tried = result.triedBefore;
    }
    delete result.triedBefore;
  }
  if (!result.charts.some(isGarment) && !result.productSize && result.status !== 'unavailable') result.productSize = productSizeOf(live);
  return finish(result);
}

/* Fynd's record for exactly this product: its brand's own site, its
   whole code in the link (engine.matchProduct, which looks in one
   category at a time; a chart is for any), and — when the link names a
   market — that market. A US record never answers for a UK page. */
function recordFor(checked) {
  for (const category of new Set(RECORDS.map((r) => r.category))) {
    const m = engine.matchProduct({ brand: checked.brand, product: { url: checked.url } }, RECORDS, category);
    if (m && m.by === 'link' && (!checked.market || m.record.region === checked.market)) return m.record;
  }
  return null;
}

module.exports = { request, liveFor, recordFor, productSizeLine, DEADLINE_MS, HEADERS_MS, PAGE_READ, chartFor, checkUrl, isPublicAddress, guardedLookup, marketOf, fetchPage, setTransport, productData, tablesOf, sizeTable, guideLinks, drawnByScript, unitOf, kindOf, fromPage, fromRecord, fromOfficial, noteFor, plain, SUPPORTED_BRANDS, MAX_BYTES, COULD_NOT, NOT_FETCHED };
