#!/usr/bin/env node
/* =========================================================
   Fynd — read each catalogue row's photo off the retailer's own page

   assets/catalog.js carries imageUrl: null on every row. The rows that
   name a productUrl point at a real listing, and that listing already
   publishes its main photo — in its JSON-LD, in its og:image, in the
   image it preloads. This reads that photo from the page the row already
   links to, so the URL written back is the retailer's own, not a guess.

   Nothing here invents a URL. A candidate has to survive three gates
   before it may be written:

     found    it appeared in the markup of the linked product page,
              never assembled from a product code or a CDN pattern
     sound    it is https, and its host belongs to the retailer or a
              CDN they publish through — aggregators, search-result
              thumbnails and stock libraries are refused by name
     loadable it answers 200 with an image content-type, plainly AND
              carrying the site's own Referer, so a hotlink block is
              caught here rather than on the page

   A row that fails any gate keeps imageUrl: null and keeps its drawn
   artwork. That is the honest outcome, and it is never overwritten with
   something that merely looks plausible.

   It reports by default and changes nothing. --write is what edits
   assets/catalog.js, and it only ever fills in rows that verified;
   productUrl, id and every other field are left exactly as they were.

   Run it from a machine with an ordinary internet connection. Behind a
   proxy that refuses retailer hosts every row comes back UNREACHABLE,
   and the report is about the proxy rather than about the catalogue.

   Usage
     node scripts/fetch-catalog-images.js
     node scripts/fetch-catalog-images.js --write
     node scripts/fetch-catalog-images.js --only uniqlo-merino-crew
     node scripts/fetch-catalog-images.js --site https://example.github.io
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CATALOG = path.join(__dirname, '..', 'assets', 'catalog.js');
const TIMEOUT = 20000;
const MIN_BYTES = 2000; // a 1x1 tracker is not a product photo
const DEFAULT_SITE = 'https://lxmafromnyc.github.io';

/* a browser's headers, because a product page served to a bare client is
   often a consent wall or a bot check with no product markup in it */
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

/* hosts that serve pictures of a product without being the retailer's
   own image host. A URL on one of these is refused even when the page
   itself handed it to us: the brief is the retailer's actual CDN. */
const NOT_THE_RETAILER = [
  'google.com', 'googleapis.com', 'googleusercontent.com', 'gstatic.com', 'ggpht.com',
  'shopping.google.com', 'bing.com', 'bing.net', 'yandex.net',
  'unsplash.com', 'pexels.com', 'pixabay.com', 'shutterstock.com', 'istockphoto.com',
  'gettyimages.com', 'adobestock.com', 'dreamstime.com', 'alamy.com',
  'placehold.co', 'placeholder.com', 'via.placeholder.com', 'dummyimage.com',
  'facebook.com', 'fbcdn.net', 'twitter.com', 'twimg.com', 'pinterest.com', 'pinimg.com',
  'doubleclick.net', 'scorecardresearch.com', 'google-analytics.com'
];

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const site = flag('--site') || DEFAULT_SITE;
const only = flag('--only');
const writing = has('--write');

/* ---------- reading the catalogue ----------

   The file is a script, not data, so it is evaluated rather than parsed:
   that way a row added in any shape the file already allows is read
   correctly, with no second grammar to keep in step. */
function readCatalog() {
  const source = fs.readFileSync(CATALOG, 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(source + ';this.__rows = DEMO_PRODUCTS;').runInContext(sandbox, { timeout: 5000 });
  const rows = sandbox.__rows;
  if (!Array.isArray(rows)) throw new Error('assets/catalog.js did not define DEMO_PRODUCTS as an array');
  return { source, rows };
}

/* ---------- finding the photo in the page ----------

   Priority order is how confidently a source names THE main product
   image: the structured record first, then the card the retailer
   publishes for sharing, then the image the page itself preloads. */

const decode = (text) => String(text)
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x2F;/gi, '/').replace(/&amp;/g, '&');

/* every <script type="application/ld+json"> block, parsed and flattened,
   so a Product inside @graph or inside an array is still found */
function jsonLdNodes(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(decode(m[1]).trim()); } catch (err) { continue; }
    const stack = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { stack.push(...node); continue; }
      out.push(node);
      if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
    }
  }
  return out;
}

function fromJsonLd(html) {
  const found = [];
  for (const node of jsonLdNodes(html)) {
    const type = String(node['@type'] || '');
    if (!/product/i.test(type)) continue;
    const image = node.image;
    const take = (v) => {
      if (typeof v === 'string') found.push(v);
      else if (v && typeof v === 'object' && typeof v.url === 'string') found.push(v.url);
    };
    if (Array.isArray(image)) image.forEach(take); else take(image);
  }
  return found;
}

/* a meta tag's content, whichever order the attributes are written in */
function metaContent(html, name) {
  const attr = `(?:property|name)=["']${name}["']`;
  const patterns = [
    new RegExp(`<meta[^>]+${attr}[^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function fromPreload(html) {
  const out = [];
  const re = /<link[^>]+rel=["']preload["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (!/as=["']image["']/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i);
    if (href) out.push(href[1]);
    const setAttr = tag.match(/imagesrcset=["']([^"']+)["']/i);
    if (setAttr) out.push(...largestFromSrcset(setAttr[1]));
  }
  return out;
}

/* a srcset's entries, widest first, so the candidate is the full-size
   photo rather than the thumbnail the browser would pick on a phone */
function largestFromSrcset(value) {
  return String(value).split(',')
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      const width = /^(\d+)w$/.exec(bits[1] || '');
      return { url: bits[0], width: width ? Number(width[1]) : 0 };
    })
    .filter((e) => e.url)
    .sort((a, b) => b.width - a.width)
    .map((e) => e.url);
}

/* candidates in the order they deserve to be tried, deduplicated */
function candidatesFrom(html, pageUrl) {
  const raw = [
    ...fromJsonLd(html),
    metaContent(html, 'og:image:secure_url'),
    metaContent(html, 'og:image'),
    metaContent(html, 'twitter:image'),
    metaContent(html, 'twitter:image:src'),
    ...fromPreload(html)
  ].filter(Boolean);

  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    let resolved;
    try { resolved = new URL(decode(entry).trim(), pageUrl).href; } catch (err) { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/* ---------- the gates ----------

   A host belongs to the retailer when it is the product page's own host
   or a parent of it — image.uniqlo.com for www.uniqlo.com — or when it
   is a CDN that is not on the refused list. The refused list is what
   keeps a Google Shopping thumbnail or a stock photo out even when the
   page links to one. */
function registrable(host) {
  const bits = String(host).toLowerCase().split('.');
  return bits.length <= 2 ? bits.join('.') : bits.slice(-2).join('.');
}

function soundness(candidate, pageUrl) {
  let url;
  try { url = new URL(candidate); } catch (err) { return 'not a URL'; }
  if (url.protocol !== 'https:') return `${url.protocol}// cannot load on an https page`;

  const host = url.hostname.toLowerCase();
  if (NOT_THE_RETAILER.some((bad) => host === bad || host.endsWith('.' + bad))) {
    return `${host} is an aggregator or stock host, not the retailer`;
  }
  /* a same-brand host needs no further argument; anything else is a CDN
     the retailer chose to publish through, which the refused list above
     has already had its say about */
  const pageHost = new URL(pageUrl).hostname.toLowerCase();
  if (registrable(host) === registrable(pageHost)) return null;
  return null;
}

/* ---------- the network ----------

   Two requests per candidate, the same pair probe-images.js makes: one
   plain, one carrying the Referer the live site would send. An image
   that is served plainly and refused for our Referer is hotlink blocked,
   and writing it would put a broken tile on the page. */
async function request(url, extra) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: Object.assign({}, BROWSER, extra || {})
    });
    return { ok: true, response };
  } catch (err) {
    const why = (err && err.name === 'AbortError') ? 'timed out'
      : (err && err.message) ? err.message : 'unreachable';
    return { ok: false, why };
  } finally {
    clearTimeout(timer);
  }
}

/* A sandbox that refuses the host answers in place of the retailer, and
   it answers 403 — the same status a retailer's bot check uses. Telling
   them apart decides what the reader should do about it, so the refusal
   is read rather than just counted: an egress denial names the host it
   refused, and the fix is an allowlist entry, not a different catalogue. */
const EGRESS_DENIAL = /not in allowlist|egress|proxy|blocked by/i;

async function fetchPage(url) {
  const got = await request(url, null);
  if (!got.ok) return { failed: got.why };
  const { response } = got;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 403 && EGRESS_DENIAL.test(body)) {
      return { failed: `this machine's network refuses ${new URL(url).hostname}`, blocked: true };
    }
    return { failed: `the page answered ${response.status}` };
  }
  return { html: await response.text() };
}

async function verifyImage(url) {
  const plain = await request(url, null);
  if (!plain.ok) return { ok: false, why: `image host ${plain.why}` };

  const type = plain.response.headers.get('content-type') || '';
  const status = plain.response.status;
  const bytes = (await plain.response.arrayBuffer()).byteLength;

  if (status !== 200) return { ok: false, why: `answered ${status}` };
  if (!/^image\//i.test(type)) return { ok: false, why: `answered 200 as ${type.split(';')[0] || 'no type'}` };
  if (bytes < MIN_BYTES) return { ok: false, why: `only ${bytes} bytes, too small to be a product photo` };

  const referred = await request(url, { Referer: site });
  if (!referred.ok) return { ok: false, why: `refused for ${site}: ${referred.why}` };
  if (referred.response.body) await referred.response.body.cancel();
  if (referred.response.status !== 200) {
    return { ok: false, why: `hotlink blocked — served plainly, ${referred.response.status} for ${site}` };
  }

  return { ok: true, why: `${type.split(';')[0]}, ${Math.round(bytes / 1024)}KB` };
}

/* ---------- one row ---------- */
async function resolveRow(row) {
  const page = await fetchPage(row.productUrl);
  if (page.failed) {
    return { id: row.id, verdict: page.blocked ? 'BLOCKED HERE' : 'UNREACHABLE', why: page.failed, url: null };
  }

  const candidates = candidatesFrom(page.html, row.productUrl);
  if (!candidates.length) {
    return { id: row.id, verdict: 'NO IMAGE FOUND', why: 'the page published no product image in its markup', url: null };
  }

  const refusals = [];
  for (const candidate of candidates) {
    const unsound = soundness(candidate, row.productUrl);
    if (unsound) { refusals.push(unsound); continue; }
    const check = await verifyImage(candidate);
    if (check.ok) {
      return { id: row.id, verdict: 'VERIFIED', why: check.why, url: candidate };
    }
    refusals.push(check.why);
  }
  return {
    id: row.id,
    verdict: 'UNVERIFIED',
    why: `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}, none loadable — ${refusals[0]}`,
    url: null
  };
}

/* ---------- writing it back ----------

   A targeted edit, not a re-serialisation: the file keeps its comments,
   its spacing and its row order, and only the imageUrl belonging to the
   row being filled is touched. The row is located by its id, and the
   first imageUrl after that id is the one it owns. */
function writeInto(source, id, url) {
  const idAt = source.indexOf(`id: '${id}'`);
  if (idAt === -1) throw new Error(`could not find the row for ${id}`);

  const field = /(\n\s*imageUrl:\s*)(null|'[^']*'|"[^"]*")/;
  const rest = source.slice(idAt);
  const m = rest.match(field);
  if (!m) throw new Error(`could not find an imageUrl for ${id}`);

  if (url.includes("'") || /[\r\n]/.test(url)) throw new Error(`refusing to write an unquotable URL for ${id}`);

  const at = idAt + m.index;
  return source.slice(0, at) + m[1] + `'${url}'` + source.slice(at + m[0].length);
}

/* ---------- report ---------- */
async function main() {
  const { source, rows } = readCatalog();

  let targets = rows.filter((r) => r && r.productUrl);
  if (only) targets = targets.filter((r) => r.id === only);

  if (!targets.length) {
    console.log(only
      ? `\nNo catalogue row with a productUrl has the id ${only}.\n`
      : '\nNo catalogue row carries a productUrl, so there is no page to read a photo from.\n');
    return;
  }

  console.log(`\nReading ${targets.length} linked product page${targets.length === 1 ? '' : 's'}${writing ? ', and writing what verifies' : ''}.\n`);

  const results = [];
  for (const row of targets) {
    /* one page at a time: these are retailer sites, and a burst of
       parallel requests is what gets a client bot-checked */
    const result = await resolveRow(row);
    results.push(result);
    console.log(`  ${result.verdict.padEnd(15)} ${row.brand} — ${String(row.name).slice(0, 44)}`);
    console.log(`  ${''.padEnd(15)} ${result.url || result.why}`);
    if (result.url) console.log(`  ${''.padEnd(15)} ${result.why}`);
  }

  const verified = results.filter((r) => r.verdict === 'VERIFIED');
  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', '));

  /* the one verdict that is not about the catalogue at all */
  if (tally['BLOCKED HERE']) {
    const hosts = [...new Set(targets.map((r) => new URL(r.productUrl).hostname))].join(', ');
    console.log('\n  BLOCKED HERE is this machine, not the listings. Nothing can be read');
    console.log('  until the retailer hosts are reachable — allow ' + hosts);
    console.log('  in the network egress settings, or run this from an ordinary connection.');
  }

  if (!writing) {
    console.log(verified.length
      ? `\n  Re-run with --write to put ${verified.length} verified URL${verified.length === 1 ? '' : 's'} into assets/catalog.js.\n`
      : '\n  Nothing verified, so there is nothing to write.\n');
    return;
  }

  if (!verified.length) {
    console.log('\n  Nothing verified — assets/catalog.js is left exactly as it was.');
    console.log('  A row only gets a photo it actually read off the retailer\'s page.\n');
    return;
  }

  let next = source;
  for (const r of verified) next = writeInto(next, r.id, r.url);
  fs.writeFileSync(CATALOG, next);
  console.log(`\n  Wrote ${verified.length} image URL${verified.length === 1 ? '' : 's'} into assets/catalog.js.\n`);
}

/* The gates are the part worth testing, and they are all decidable
   without a retailer: what the markup offers, which hosts are refused,
   and what the file looks like afterwards. Required as a module it hands
   those over and runs nothing. */
if (require.main === module) {
  main().catch((err) => { console.error(err && err.message); process.exit(1); });
} else {
  module.exports = { candidatesFrom, soundness, writeInto, verifyImage, largestFromSrcset, readCatalog };
}
