#!/usr/bin/env node
/* =========================================================
   Fynd — Discover, with the retailers' real photographs

   The interface tests stand a local file in for every retailer photo,
   because they must run anywhere. This does the opposite: it opens the
   real Discover page, lets the browser reach the retailers' own image
   hosts, and checks what a shopper would actually see.

   1. Every product that CAN appear on a shelf — every row the audit
      (scripts/audit-catalog.js) proves and the page itself marks
      `identified` — has its photo loaded by the page, the way the card
      loads it. Each one either loads as a real product photo (at least
      200px each way) or is reported as failed. A failed photo is not
      worked around: Discover keeps that product off its shelves, and
      this checks that it did.

   2. At every width, every shelf card shown:
        - is a proved row, whose photo passed step 1
        - shows the row's own verified photo, loaded, not broken
        - no drawn artwork stands in for it
        - the photo fills its 4:5 tile, cropped by object-fit: cover,
          never stretched or letterboxed
        - brand (or the store's address), name, price and store line
          are the row's corrected values
      and the page never scrolls sideways.

   Screenshots, written only when every check passes:
     <out>/discover-real-<width>.png   the whole page at each width
     <out>/discover-real-photos.png    every checked photo beside the
                                       product it belongs to, for a
                                       person to confirm they match
     <out>/discover-real-photos.json   the full report (always written)

   Usage:
     npx vercel dev            # in one terminal, with .env.local
     node scripts/validate-discover-photos.js --url=http://localhost:3000

     node scripts/validate-discover-photos.js    # serves this checkout itself
     node scripts/validate-discover-photos.js --widths=1440,390 --out=some/dir

   Where the retailers' hosts cannot be reached — a sandbox with an
   egress policy — no shelf is drawn, and this fails and names the hosts
   rather than passing.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const audit = require('./audit-catalog');

const REPO = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const WIDTHS = arg('widths', '1440,1024,768,390,375,360').split(',').map(Number);
const OUT = path.resolve(REPO, arg('out', 'artifacts/ui-validation'));
const URL_GIVEN = arg('url', null);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const MIN_PHOTO = 200;

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  try { chromium = require('playwright').chromium; } catch (e) {
    console.error('Playwright is not available: npm install, then run this again.');
    process.exit(2);
  }
}

const rows = audit.readCatalogue();
const rowFor = (href) => rows.find((r) => r.productUrl === href);
const hostOf = (url) => new URL(url).hostname.replace(/^www\d?\./, '');
/* as the card writes it: see formatPrice in assets/app.js */
const priceText = (price) => (price == null ? 'Price at retailer'
  : '$' + (Number.isInteger(price) ? String(price) : price.toFixed(2)));

/* Without --url, the site is answered from this checkout by the
   browser's own request routing, on an origin of its own, so the only
   traffic that leaves is the retailers' photos. */
const ORIGIN = URL_GIVEN ? URL_GIVEN.replace(/\/+$/, '') : 'http://fynd.validate';
async function openDiscover(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  if (!URL_GIVEN) {
    await page.route(`${ORIGIN}/**`, (route) => {
      const url = new URL(route.request().url());
      const file = path.join(REPO, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
      if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    });
  }
  const refused = new Set();
  page.on('requestfailed', (req) => {
    if (req.resourceType() === 'image') refused.add(new URL(req.url()).hostname);
  });
  await page.goto(`${ORIGIN}/discover.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Products && Products.all().length > 0, null, { timeout: 15000 });
  return { page, refused };
}

(async () => {
  /* A sandbox's traffic leaves through its proxy, and the browser has
     to use it too — except for a local `vercel dev`, which a proxy
     cannot reach. */
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const loopback = URL_GIVEN && /^https?:\/\/(localhost|127\.|\[::1\])/.test(URL_GIVEN);
  const browser = await chromium.launch(Object.assign(
    fs.existsSync(CHROME) ? { executablePath: CHROME } : {},
    proxy && !loopback ? { proxy: { server: proxy } } : {}));

  const report = { site: ORIGIN, checked: 0, valid: [], failed: [], widths: {}, refusedHosts: [], problems: [] };
  const problems = report.problems;
  const refusedAll = new Set();

  /* ---------- 1. every product that can appear on a shelf ---------- */
  const first = await openDiscover(browser, WIDTHS[0]);
  const candidates = await first.page.evaluate(() =>
    Products.all().filter((p) => p.identified && p.productUrl && p.imageUrl).map((p) => ({ id: p.id, imageUrl: p.imageUrl })));
  const proved = new Set(rows.filter((r) => audit.auditRow(r).shelvable).map((r) => r.id));
  for (const c of candidates) {
    if (!proved.has(c.id)) problems.push(`${c.id}: the page would shelve it, but it fails the audit`);
  }
  const photos = await first.page.evaluate(async ({ list, min }) => Promise.all(list.map((c) => new Promise((resolve) => {
    const probe = new Image();
    const done = (why) => {
      clearTimeout(timer);
      resolve({ id: c.id, imageUrl: c.imageUrl, width: probe.naturalWidth, height: probe.naturalHeight,
        ok: !why && probe.naturalWidth >= min && probe.naturalHeight >= min,
        why: why || (probe.naturalWidth >= min && probe.naturalHeight >= min ? null : `only ${probe.naturalWidth}×${probe.naturalHeight}`) });
    };
    const timer = setTimeout(() => done('timed out'), 15000);
    probe.referrerPolicy = 'no-referrer';
    probe.onload = () => done(null);
    probe.onerror = () => done('did not load');
    probe.src = c.imageUrl;
  }))), { list: candidates, min: MIN_PHOTO });
  first.refused.forEach((h) => refusedAll.add(h));
  await first.page.close();

  report.checked = photos.length;
  report.valid = photos.filter((p) => p.ok).map((p) => ({ id: p.id, size: `${p.width}×${p.height}`, imageUrl: p.imageUrl }));
  report.failed = photos.filter((p) => !p.ok).map((p) => ({ id: p.id, why: p.why, imageUrl: p.imageUrl }));
  const good = new Set(report.valid.map((p) => p.id));

  /* ---------- 2. what each width actually shows ---------- */
  for (const width of WIDTHS) {
    const { page, refused } = await openDiscover(browser, width);
    await page.waitForSelector('.shelf .item-card', { timeout: 20000 }).catch(() => {});
    /* bring every lazy photo in, and wait for each to finish */
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 80)); }
      window.scrollTo(0, 0);
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.shelf .item-media img')].every((i) => i.complete),
      null, { timeout: 20000 }).catch(() => {});

    const seen = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      artwork: document.querySelectorAll('.shelf svg.silhouette').length,
      shelves: document.querySelectorAll('.shelf').length,
      cards: [...document.querySelectorAll('.shelf .item-card')].filter((c) => c.offsetParent).map((c) => {
        const img = c.querySelector('.item-media img');
        const box = img ? img.getBoundingClientRect() : null;
        const tile = c.querySelector('.item-media').getBoundingClientRect();
        const text = (sel) => (c.querySelector(sel) ? c.querySelector(sel).textContent.trim() : null);
        return {
          href: c.getAttribute('href'),
          seller: text('.item-retailer'),
          name: text('.item-name'),
          price: text('.item-price'),
          where: text('.item-seller'),
          src: img ? img.getAttribute('src') : null,
          loaded: Boolean(img && img.complete && img.naturalWidth > 0),
          natural: img ? [img.naturalWidth, img.naturalHeight] : null,
          fit: img ? getComputedStyle(img).objectFit : null,
          fills: Boolean(box && Math.abs(box.width - tile.width) < 1 && Math.abs(box.height - tile.height) < 1),
          tile: tile.width / tile.height
        };
      })
    }));

    const at = (why) => problems.push(`${width}px: ${why}`);
    if (seen.overflow > 0) at(`the page scrolls sideways by ${seen.overflow}px`);
    if (seen.artwork) at(`${seen.artwork} drawn artwork tile(s) on a shelf`);
    if (!seen.cards.length) at('no shelf was drawn — no catalogue photo could be loaded');

    for (const card of seen.cards) {
      const row = rowFor(card.href);
      if (!row) { at(`${card.href} is not a catalogue listing`); continue; }
      const verdict = audit.auditRow(row);
      const id = row.id;
      if (!verdict.shelvable) at(`${id} is shelved but fails its audit: ${verdict.problems.join('; ')}`);
      if (!good.has(id)) at(`${id} is shelved though its photo failed`);
      if (card.src !== row.imageUrl) at(`${id} shows ${card.src}, not its own photo`);
      if (!card.loaded) at(`${id}'s photo is broken`);
      else if (Math.min(...card.natural) < MIN_PHOTO) at(`${id}'s photo is ${card.natural.join('×')}, too small to be a product photo`);
      if (card.fit !== 'cover' || !card.fills) at(`${id}'s photo does not fill its tile by cropping`);
      if (Math.abs(card.tile - 0.8) > 0.02) at(`${id}'s tile is ${card.tile.toFixed(3)}, not 4:5`);
      const brand = verdict.checks.brand.shown ? row.brand : hostOf(row.productUrl);
      if (card.seller !== brand) at(`${id} is labelled "${card.seller}", expected "${brand}"`);
      if (card.name !== row.name) at(`${id} is named "${card.name}", expected "${row.name}"`);
      if (card.price !== priceText(row.price)) at(`${id} is priced "${card.price}", expected "${priceText(row.price)}"`);
      const where = verdict.checks.brand.shown ? hostOf(row.productUrl) : null;
      if (card.where !== where) at(`${id}'s store line is "${card.where}", expected "${where}"`);
    }

    report.widths[width] = { shelves: seen.shelves, cards: seen.cards.length, overflow: seen.overflow, artwork: seen.artwork };
    refused.forEach((h) => refusedAll.add(h));
    await page.screenshot({ path: path.join(OUT, `.discover-real-${width}.pending.png`), fullPage: true });
    await page.close();
  }

  /* ---------- 3. every checked photo beside its product ----------
     The checks above prove each photo is the row's own and loads at
     product size; whether it shows that product is for a person to
     see, so they are laid out together for one look. */
  const sheet = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  await sheet.setContent(`<!doctype html><meta charset="utf-8"><style>
      body{font:13px/1.4 -apple-system,Helvetica,Arial,sans-serif;margin:24px;color:#111}
      h1{font-size:18px;margin:0 0 16px} .g{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}
      .t{aspect-ratio:4/5;background:#f2f2ef;border-radius:8px;overflow:hidden;position:relative}
      .t img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
      .x{color:#a00;font-weight:600} b{display:block;margin-top:6px}</style>
    <h1>Discover shelf candidates — ${photos.filter((p) => p.ok).length} of ${photos.length} real photos loaded</h1>
    <div class="g">${photos.map((p) => {
      const row = rows.find((r) => r.id === p.id) || {};
      return `<div><div class="t">${p.ok ? `<img referrerpolicy="no-referrer" src="${esc(p.imageUrl)}">` : ''}</div>
        <b>${esc(row.brand || hostOf(row.productUrl))}</b>${esc(row.name)}
        ${p.ok ? `<div>${p.width}×${p.height}</div>` : `<div class="x">photo failed: ${esc(p.why)} — kept off Discover</div>`}</div>`;
    }).join('')}</div>`, { waitUntil: 'load' });
  await sheet.screenshot({ path: path.join(OUT, '.discover-real-photos.pending.png'), fullPage: true });
  await sheet.close();
  await browser.close();

  report.refusedHosts = [...refusedAll].sort();
  report.ok = problems.length === 0;

  /* screenshots are kept only when they show what was asked for */
  for (const name of WIDTHS.map((w) => `discover-real-${w}`).concat('discover-real-photos')) {
    const pending = path.join(OUT, `.${name}.pending.png`);
    if (report.ok) fs.renameSync(pending, path.join(OUT, `${name}.png`));
    else fs.rmSync(pending, { force: true });
  }
  fs.writeFileSync(path.join(OUT, 'discover-real-photos.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`${report.checked} products can appear on a shelf; ${report.valid.length} real photos loaded, ${report.failed.length} failed.`);
  report.failed.forEach((f) => console.log(`  kept off Discover: ${f.id} — ${f.why}`));
  if (report.ok) {
    console.log(`Every shelf card passed at ${WIDTHS.join(', ')}px. Screenshots are in ${path.relative(REPO, OUT)}/.`);
    process.exit(0);
  }
  console.log('\nDiscover could not be validated with real photos:');
  problems.slice(0, 40).forEach((p) => console.log(`  - ${p}`));
  if (report.refusedHosts.length) {
    console.log('\nImage hosts the browser could not reach:');
    report.refusedHosts.forEach((h) => console.log(`  ${h}`));
  }
  process.exit(1);
})().catch((err) => { console.error(err); process.exit(2); });
