/* Collects everything the film is made of, from real Fynd searches.
   Run it on your own machine: it needs the network to reach the shops.

   Reads ../assets/demo/demo-search.json — the three real searches the
   recorder made (npm run demo:record at the repo root), each with the
   API's own reply, the reading of the request, the products in grid
   order and which shops answered — and from it:

     - downloads each product photo the film shows, exactly as the page
       showed it (the same URL), refusing anything that is not a real
       image or is too small to stay sharp at film size;
     - writes each card's lines the way the site writes them (brand,
       name, price, where the link goes — scripts/shared.mjs mirrors
       assets/app.js);
     - takes what Fynd read from the hoodie request from the saved
       /api/interpret reply, or, when the page read it locally, from the
       site's own local interpreter;
     - chooses A, B and C from the first two rows, from three different
       shops, and opens C's real product page: if it loads (judged by the
       recorder's own classifyPage — a block page is not a shop) it is
       captured at desktop and phone width; if not, the next candidate is
       tried; if none loads, nothing is captured and the film shows the
       handoff with the real address. A retailer page is never drawn.

   → public/data/captured.json, public/products/, public/retailer/

   npm run collect                      (uses ../assets/demo/demo-search.json)
   npm run collect -- --search=path/to/demo-search.json */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { PUBLIC as DEFAULT_PUBLIC, REPO, SLOTS, attributesFrom, cardLines, formatPrice, localInterpreter, writeJson } from './shared.mjs';
import { MIN_WIDTH, photoProblem } from './photos.mjs';
import { listedCandidates, listingPagePhotos, pageCandidates } from './photo-source.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };
/* where it all goes: public/, or another folder for the collector's test */
const PUBLIC = args.public ? path.resolve(String(args.public)) : DEFAULT_PUBLIC;
const require = createRequire(path.join(REPO, 'package.json'));
const { classifyPage, hostOf } = require(path.join(REPO, 'scripts', 'demo-retailer-visit.js'));

/* how many photos per search the film can show */
const NEED = { hoodie: 12, dress: 7, bag: 7 };
/* the fewest the film can be made with: two hoodie rows (A, B, C come
   from them), and a row of four for each of the other searches */
const LEAST = { hoodie: 8, dress: 4, bag: 4 };
/* a result is only used if it is what the search asked for by name: the
   Prada search shows Prada and nothing else */
const MUST_SAY = { bag: /\bprada\b/i };
/* film size: a grid card is 376px wide in the 1920 frame and grows to
   about 470 in scene 3; under MIN_WIDTH (photos.mjs) a photo is refused,
   under SHARP it is kept with a note that it will be a little soft */
const SHARP_WIDTH = 470;
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, file))).digest('hex');
const ROWS_FOR_CHOICE = 8;

function playwright() {
  for (const name of [process.env.PLAYWRIGHT_PATH, 'playwright', '@playwright/test'].filter(Boolean)) {
    try { return require(name).chromium; } catch (err) { /* next */ }
  }
  return fail('Playwright is not installed at the repo root. Run there: npm i -D playwright && npx playwright install chromium');
}

const searchFile = path.resolve(args.search || path.join(REPO, 'assets', 'demo', 'demo-search.json'));
if (!fs.existsSync(searchFile)) {
  fail(`No saved search at ${path.relative(process.cwd(), searchFile)}.\n  Run the real searches first, at the repo root: npm run demo:record`);
}
const saved = JSON.parse(fs.readFileSync(searchFile, 'utf8'));
if (!saved.searches) fail('This saved search is from before there were three searches. Run npm run demo:record again.');

/* the three searches, with each card matched to the API's own record */
const Interpreter = localInterpreter();
const found = {};
for (const x of saved.searches) {
  const id = SLOTS[x.slot];
  if (!id) continue;
  const records = (x.search && x.search.response && x.search.response.products) || [];
  if (!records.length) fail(`The "${x.query}" search has no API reply saved with it. Run npm run demo:record again.`);
  const shown = x.shown.map((s, i) => {
    const rec = records.find((r) => r.productUrl === s.href);
    if (!rec) fail(`"${x.query}" card ${i + 1} (${s.href}) is not in the API reply it came from.`);
    return { ...s, rec, index: i };
  });
  const prefs = (x.interpret && x.interpret.response && x.interpret.response.preferences) || Interpreter.localInterpret(x.query, {});
  found[id] = { query: x.query, count: records.length, shown, prefs, readBy: x.interpret && x.interpret.response && x.interpret.response.preferences ? 'api' : 'local' };
}
for (const id of Object.values(SLOTS)) if (!found[id]) fail(`The saved searches have no "${id}" search. The film needs all three; run npm run demo:record again.`);

const chromium = playwright();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

/* fresh folders: nothing from an earlier run can leak into this one */
for (const dir of ['products', 'retailer']) {
  fs.rmSync(path.join(PUBLIC, dir), { recursive: true, force: true });
  fs.mkdirSync(path.join(PUBLIC, dir), { recursive: true });
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' };
async function download(url, base, referer) {
  const headers = { Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*', ...(referer ? { Referer: referer } : {}) };
  const res = await desktop.request.get(url, { timeout: 20000, headers }).catch((e) => ({ ok: () => false, status: () => e.message }));
  if (!res.ok()) return { problem: `could not be downloaded (${res.status()})` };
  const type = (res.headers()['content-type'] || '').split(';')[0].trim();
  if (!EXT[type]) return { problem: `is not an image (${type || 'no type'})` };
  const body = await res.body();
  if (body.length < 2048) return { problem: `is too small a file to be a photo (${body.length} bytes)` };
  const file = `products/${base}.${EXT[type]}`;
  fs.writeFileSync(path.join(PUBLIC, file), body);
  return { file, size: sizeOf(body) };
}

/* width and height from the file itself, where the format makes it easy */
function sizeOf(b) {
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const m = b[i + 1];
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

const warnings = [];
const skipped = [];
const gone = (file) => fs.rmSync(path.join(PUBLIC, file), { force: true });

/* a candidate address the film may download from: https, or (only for
   the collector's own test) the loopback test server */
const fetchable = (url) => /^https:\/\//.test(url) || (args['allow-loopback'] && /^http:\/\/127\.0\.0\.1[:/]/.test(url));

/* The product's real photograph, from its own listing only (see
   photo-source.mjs for the order). Each candidate goes through the same
   real-photo test as every other photo; the first that passes is kept.
   Returns null — and the product is left out — when none does. */
async function photoFor(item, base, who) {
  const tried = [];
  const attempt = async (candidates) => {
    for (const cand of candidates) {
      if (!fetchable(cand.url)) { tried.push(`${cand.url}: not https`); continue; }
      const got = await download(cand.url, base, cand.referer);
      if (got.problem) { tried.push(`${cand.source}: ${got.problem}`); continue; }
      const problem = photoProblem(path.join(PUBLIC, got.file));
      if (problem) { gone(got.file); tried.push(`${cand.source}: ${problem}`); continue; }
      return { ...got, url: cand.url, source: cand.source };
    }
    return null;
  };
  let found = await attempt(listedCandidates(item));
  if (!found) {
    /* the listing's own page, read for the photos it declares as this product's */
    const listing = await readListing(item.href);
    if (listing.problem) tried.push(`the listing page: ${listing.problem}`);
    else {
      const { photos, refused } = listingPagePhotos(listing.html, item.href, listing.landed);
      for (const r of refused) tried.push(`the listing page offered ${r}`);
      found = await attempt(pageCandidates(photos).map((c) => ({ ...c, referer: listing.landed })));
    }
  }
  if (!found) console.log(`    ${who}: no real photograph of at least ${MIN_WIDTH}px from its listing — left out\n      ${tried.slice(0, 6).join('\n      ')}`);
  else if (found.url !== item.photo) console.log(`    ${who}: the card's photo is too small; using ${found.source}\n      ${found.url}`);
  return found ? { ...found, tried } : { tried };
}

async function readListing(url) {
  const page = await desktop.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load', { timeout: 6000 }).catch(() => {});
    const verdict = await classifyPage(page);
    if (verdict.kind !== 'loaded' || (res && res.status() >= 400)) return { problem: `${verdict.kind}${verdict.reason ? ` (${verdict.reason})` : ''}${res ? `, HTTP ${res.status()}` : ''}` };
    return { html: await page.content(), landed: page.url() };
  } catch (err) {
    return { problem: err.message.split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

const searches = [];
for (const id of ['hoodie', 'dress', 'bag']) {
  const s = found[id];
  const products = [];
  /* grid order; a result is used only if it passes every gate, and the
     next result takes the place of one that does not */
  for (const item of s.shown) {
    if (products.length >= NEED[id]) break;
    const who = `"${s.query}" #${item.index + 1}`;
    const name = String(item.rec.name || item.name).trim();
    const lines = cardLines(item.rec);
    if (MUST_SAY[id] && !MUST_SAY[id].test(`${lines.top} ${name}`)) {
      skipped.push({ search: id, index: item.index + 1, name, url: item.href, why: `not a ${MUST_SAY[id].source.replace(/\\b/g, '')} product` });
      console.log(`    ${who}: "${name}" does not say ${MUST_SAY[id].source.replace(/\\b/g, '')} — left out`);
      continue;
    }
    const photo = await photoFor(item, `${id}-${item.index + 1}`, who);
    if (!photo.file) {
      skipped.push({ search: id, index: item.index + 1, name, url: item.href, why: `no real photograph of at least ${MIN_WIDTH}px from its listing`, tried: photo.tried });
      continue;
    }
    const w = photo.size ? photo.size.w : item.width;
    const h = photo.size ? photo.size.h : item.height;
    if (w < SHARP_WIDTH) warnings.push(`${who}: photo ${w}px wide; it will be slightly soft at full size`);
    products.push({
      id: `${id}-${item.index + 1}`,
      /* the listing's own lines, as the card shows them: never changed */
      brand: lines.top,
      name,
      price: formatPrice(item.rec.price) || 'Price at retailer',
      retailer: lines.where,
      url: item.href,
      image: photo.file,
      imageWidth: w,
      imageHeight: h,
      photoUrl: photo.url,
      listedPhotoUrl: item.photo,
      photoSource: photo.source,
      sha256: sha256(photo.file),
      check: item.check ? item.check.kind : null
    });
  }
  if (products.length < LEAST[id]) {
    fail(`"${s.query}" has only ${products.length} result(s) with a real photograph of at least ${MIN_WIDTH}px from its own listing${MUST_SAY[id] ? ` that ${MUST_SAY[id].source.replace(/\\b/g, '')} names` : ''}; the film needs ${LEAST[id]}.\n  Run npm run demo:record again for fresh results.`);
  }
  searches.push({ id, query: s.query, count: s.count, attributes: attributesFrom(s.prefs), readBy: s.readBy, products });
  const out = skipped.filter((x) => x.search === id).length;
  console.log(`  ${id}: "${s.query}" — ${products.length} real photographs of ${s.count} results${out ? ` (${out} left out)` : ''}`);
}

/* A, B, C: from the first two rows, three different shops; C is the one
   whose page really loads now */
const hoodie = searches[0];
const pool = hoodie.products.slice(0, ROWS_FOR_CHOICE);
const firstOfShop = pool.filter((p, i) => pool.findIndex((q) => q.retailer === p.retailer) === i);
if (firstOfShop.length < 3) fail(`The first ${ROWS_FOR_CHOICE} hoodie results come from fewer than three shops (${firstOfShop.map((p) => p.retailer).join(', ')}).`);
const candidates = firstOfShop.filter((p) => p.check !== 'blocked' && p.check !== 'unusable');
candidates.sort((a, b) => (b.check === 'loaded') - (a.check === 'loaded'));

async function capture(product) {
  const shots = {};
  const shapes = [
    ['desktop', desktop],
    ['mobile', await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })]
  ];
  for (const [shape, context] of shapes) {
    const page = await context.newPage();
    try {
      const res = await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1500);
      let verdict = await classifyPage(page);
      if (verdict.kind === 'loaded' && res && res.status() >= 400) verdict = { kind: [401, 403, 429].includes(res.status()) ? 'blocked' : 'unusable', reason: `HTTP ${res.status()}` };
      if (verdict.kind !== 'loaded') return { kind: verdict.kind, reason: verdict.reason || '' };
      const file = `retailer/${shape}.png`;
      await page.screenshot({ path: path.join(PUBLIC, file) });
      shots[shape] = file;
    } catch (err) {
      return { kind: 'slow', reason: err.message.split('\n')[0] };
    } finally {
      await page.close().catch(() => {});
    }
  }
  return { kind: 'loaded', shots };
}

let c = null;
const refused = new Set();   /* shops whose page did not load just now */
let page = null;
for (const p of candidates) {
  console.log(`  opening ${p.url}`);
  const r = await capture(p);
  console.log(`    ${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  if (r.kind !== 'loaded') refused.add(p.retailer);
  if (r.kind === 'loaded') { c = p; page = r; break; }
}
if (!c) {
  /* half a capture (one shape loaded, the other not) is not kept */
  for (const f of fs.readdirSync(path.join(PUBLIC, 'retailer'))) fs.rmSync(path.join(PUBLIC, 'retailer', f));
  c = candidates[0] || firstOfShop[0];
  warnings.push(`no retailer page loaded; the film will show the handoff to ${c.url}`);
}
/* A and B are only looked at, but still from shops that answered where possible */
const others = [...new Set([...candidates.filter((p) => !refused.has(p.retailer)), ...firstOfShop])].filter((p) => p.retailer !== c.retailer).slice(0, 2)
  .sort((a, b) => hoodie.products.indexOf(a) - hoodie.products.indexOf(b));
await browser.close();

/* the closing mosaic: three from each search, past the ones already seen */
const mosaic = searches.flatMap((s) => {
  const seen = new Set([c.id, ...others.map((p) => p.id)]);
  const rest = s.products.slice(4).filter((p) => !seen.has(p.id));
  return (rest.length >= 3 ? rest : s.products).slice(0, 3).map((p) => p.id);
});

const data = {
  source: 'real',
  capturedAt: new Date().toISOString(),
  searchedAt: saved.searchedAt,
  productSource: saved.productSource || null,
  searches,
  choose: [others[0].id, others[1].id, c.id],
  retailer: {
    productId: c.id,
    url: c.url,
    host: hostOf(c.url),
    name: c.retailer,
    screenshots: { desktop: page ? page.shots.desktop || null : null, mobile: page ? page.shots.mobile || null : null },
    loaded: Boolean(page),
    outcome: page ? 'loaded' : 'not loaded',
    ...(page ? { sha256: Object.fromEntries(Object.values(page.shots).map((f) => [f, sha256(f)])) } : {}),
    checkedAt: new Date().toISOString()
  },
  mosaic,
  /* results left out, and why: none of them is in the film */
  skipped
};
writeJson(path.join(PUBLIC, 'data', 'captured.json'), data);
console.log(`\nWrote public/data/captured.json`);
console.log(`  A ${others[0].retailer}, B ${others[1].retailer}, C ${c.retailer} → ${page ? 'retailer page captured' : 'handoff (no page loaded)'}`);
console.log(`  "${hoodie.query}" reads as ${hoodie.attributes.map((a) => `${a.label} ${a.value}`).join(' · ')} (${hoodie.readBy === 'api' ? 'Fynd’s interpreter' : 'the site’s local interpreter'})`);
for (const w of warnings) console.log(`  note: ${w}`);
