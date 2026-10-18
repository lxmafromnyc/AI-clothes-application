#!/usr/bin/env node
/* =========================================================
   Fynd — a snapshot of UNIQLO US products, read off uniqlo.com

     node scripts/fetch-uniqlo-catalog.js [--out <file>] [--max <n>] [--print]

   UNIQLO publishes no product API, feed or affiliate catalogue that
   Fynd can use (see api/_sizing/brands/uniqlo.js). What it does publish
   is its own site. This reads it the way a shopper's browser does — its
   public category pages, rendered in Chromium — and keeps, for each
   product listed there, only what the page shows: the product's code
   (from its own link), its name, its photo on UNIQLO's image host, and
   the category page it was listed on. Nothing is guessed: a tile with
   no code in its link, no name or a photo elsewhere is left out.

   Politely, and within UNIQLO's own rules:
     * robots.txt is read first, and any path it disallows is skipped;
       if it can't be read, nothing is fetched
     * an honest user agent naming Fynd, one page at a time, a pause
       between pages, a fixed cap on pages and products
     * nothing is clicked, no form is filled, no protection is worked
       around: a page that is refused or never answers is reported, not
       retried another way

   Then, to show what a pick in Find Fit would actually get, a few of
   the products found are opened on their own pages to confirm the name
   and code, one is looked up through Fynd's own chart pipeline
   (api/_sizing/chart.js) as the deployed server would, and the
   framing headers are reported (could Find Fit show the page itself?).

   Run from a machine that can reach uniqlo.com — the GitHub workflow
   .github/workflows/uniqlo-catalog.yml does — and commit the file it
   writes (api/_sizing/brands/uniqlo-catalog.json) after reading it.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const ORIGIN = 'https://www.uniqlo.com';
const UA = 'Mozilla/5.0 (compatible; FyndCatalog/1.0; +https://ai-clothes-application.vercel.app/about.html)';
const CODE = /\/products\/(E\d{6}-\d{3})(?:\/|$)/;
const IMAGE_HOST = /^https:\/\/image\.uniqlo\.com\//;
const PAUSE_MS = 2500;

/* UNIQLO US category pages for the clothing Find Fit sizes: tried in
   order, each only if robots.txt allows it; one that doesn't exist is
   reported and passed over */
const CATEGORIES = [
  { path: '/us/en/men/tops/sweatshirts-and-hoodies', category: 'sweatshirts-hoodies', label: 'Sweatshirts & Hoodies', line: 'men' },
  { path: '/us/en/men/tops/t-shirts', category: 'tshirts', label: 'T-shirts', line: 'men' },
  { path: '/us/en/men/tops/sweaters-and-cardigans', category: 'knitwear', label: 'Sweaters & Cardigans', line: 'men' },
  { path: '/us/en/men/tops/casual-shirts', category: 'shirts', label: 'Shirts', line: 'men' },
  { path: '/us/en/women/tops/sweatshirts-and-hoodies', category: 'sweatshirts-hoodies', label: 'Sweatshirts & Hoodies', line: 'women' },
  { path: '/us/en/women/tops/t-shirts', category: 'tshirts', label: 'T-shirts', line: 'women' },
  { path: '/us/en/women/tops/sweaters-and-cardigans', category: 'knitwear', label: 'Sweaters & Cardigans', line: 'women' }
];

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const OUT = path.resolve(REPO, opt('--out', 'api/_sizing/brands/uniqlo-catalog.json'));
const MAX = Math.min(Number(opt('--max', 240)) || 240, 400);
const PRINT = args.includes('--print');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

/* ---------- robots.txt ---------- */

function rulesFor(text) {
  const groups = [];
  let current = null;
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  });
  const mine = groups.find((g) => g.agents.some((a) => a !== '*' && 'fyndcatalog'.includes(a))) || groups.find((g) => g.agents.includes('*'));
  return (mine && mine.rules) || [];
}
/* the longest matching rule wins; an empty Disallow allows */
function allowed(rules, pathname) {
  let best = null;
  rules.forEach((r) => {
    if (!r.path) return;
    const pattern = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`);
    if (pattern.test(pathname) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  });
  return !best || best.allow;
}

/* ---------- reading a category page ---------- */

async function tilesOn(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/products/"]').forEach((a) => {
      const m = /\/products\/(E\d{6}-\d{3})(?:\/|$)/.exec(a.getAttribute('href') || '');
      if (!m || seen.has(m[1])) return;
      const img = a.querySelector('img');
      const name = ((img && img.getAttribute('alt')) || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const src = img ? (img.currentSrc || img.getAttribute('src') || '') : '';
      seen.add(m[1]);
      out.push({ code: m[1], name, imageUrl: src, href: a.href });
    });
    return out;
  });
}

async function main() {
  const report = { ok: false, fetchedAt: new Date().toISOString(), robots: null, categories: [], products: [], checks: {} };

  /* robots.txt first: no rules, no reading */
  let rules;
  try {
    const res = await fetch(`${ORIGIN}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    report.robots = { status: res.status, bytes: text.length, sitemaps: (text.match(/^sitemap:\s*(\S+)/gim) || []).map((s) => s.split(/:\s*/).slice(1).join(':')) };
    if (!res.ok) throw new Error(`robots.txt answered ${res.status}`);
    rules = rulesFor(text);
    report.robots.rules = rules.length;
  } catch (err) {
    report.robots = Object.assign(report.robots || {}, { error: err.message });
    log(`robots.txt could not be read (${err.message}); nothing else is fetched.`);
    return finish(report);
  }

  let chromium;
  try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (err) { chromium = null; }
  if (!chromium) { report.error = 'Playwright is not installed'; return finish(report); }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 1600 } });
  const page = await context.newPage();
  const byCode = new Map();

  try {
    for (const cat of CATEGORIES) {
      if (byCode.size >= MAX) break;
      const entry = { path: cat.path, allowed: allowed(rules, cat.path) };
      report.categories.push(entry);
      if (!entry.allowed) { log(`${cat.path}: disallowed by robots.txt — skipped`); continue; }
      const started = Date.now();
      try {
        const res = await page.goto(`${ORIGIN}${cat.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        entry.status = res ? res.status() : null;
        await page.waitForSelector('a[href*="/products/E"]', { timeout: 20000 }).catch(() => {});
        /* the page loads more tiles as it is scrolled, as it does for a shopper */
        for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, 2400); await sleep(700); }
        const tiles = await tilesOn(page);
        entry.tiles = tiles.length;
        let kept = 0;
        tiles.forEach((t) => {
          if (byCode.size >= MAX || byCode.has(t.code)) return;
          if (!t.name || t.name.length > 160) return;
          const url = `${ORIGIN}/us/en/products/${t.code}/00`;
          byCode.set(t.code, {
            code: t.code,
            name: t.name,
            url,
            imageUrl: IMAGE_HOST.test(t.imageUrl) && t.imageUrl.includes(t.code.slice(1, 7)) ? t.imageUrl.split('?')[0] : null,
            category: cat.category,
            categoryLabel: cat.label,
            line: cat.line,
            listedOn: `${ORIGIN}${cat.path}`
          });
          kept += 1;
        });
        entry.kept = kept;
      } catch (err) {
        entry.error = err.message.split('\n')[0];
      }
      entry.ms = Date.now() - started;
      log(`${cat.path}: ${entry.status || 'no answer'} · ${entry.tiles || 0} tiles · ${entry.kept || 0} kept${entry.error ? ` · ${entry.error}` : ''}`);
      await sleep(PAUSE_MS);
    }

    /* a few products opened on their own pages: do the name and code hold? */
    const sample = [...byCode.values()].slice(0, 3);
    report.checks.productPages = [];
    for (const p of sample) {
      if (!allowed(rules, new URL(p.url).pathname)) continue;
      try {
        const res = await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);
        const seen = await page.evaluate(() => {
          const out = { title: document.title, ld: [] };
          document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { out.ld.push(JSON.parse(s.textContent)); } catch (e) { /* not data */ } });
          out.hasSizeTable = Boolean(document.querySelector('table'));
          return out;
        });
        const product = [].concat(...seen.ld.map((d) => [].concat(d['@graph'] || d))).find((d) => /Product/.test([].concat(d['@type'] || []).join(' ')));
        report.checks.productPages.push({ code: p.code, status: res && res.status(), title: seen.title.slice(0, 120), ldName: product ? product.name : null, ldSku: product ? (product.sku || product.productID || null) : null, nameMatches: Boolean(product && product.name && p.name.toLowerCase().includes(String(product.name).toLowerCase().slice(0, 12))) });
      } catch (err) {
        report.checks.productPages.push({ code: p.code, error: err.message.split('\n')[0] });
      }
      await sleep(PAUSE_MS);
    }
  } finally {
    await browser.close();
  }

  report.products = [...byCode.values()];

  /* one product through Fynd's own chart pipeline, as the server reads it */
  const first = report.products.find((p) => /sweat|hoodie|t-shirt/i.test(p.name)) || report.products[0];
  if (first) {
    try {
      process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'catalog-snapshot-secret-of-sufficient-length';
      const chart = await require('../api/_sizing/chart').chartFor(first.url, { noCache: true });
      report.checks.chart = { code: first.code, status: chart.status, from: chart.from, reason: chart.reason || null, measures: (chart.charts || []).map((c) => c.measures), trace: (chart.trace || []).map((t) => ({ status: t.status, phase: t.phase, ms: t.ms, contentType: t.contentType })) };
    } catch (err) {
      report.checks.chart = { code: first.code, error: err.message };
    }
  }

  /* could Find Fit frame the page itself? */
  try {
    const res = await fetch(`${ORIGIN}/us/en/`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    const csp = res.headers.get('content-security-policy') || '';
    report.checks.framing = { status: res.status, xFrameOptions: res.headers.get('x-frame-options'), frameAncestors: (/frame-ancestors[^;]*/i.exec(csp) || [null])[0] };
  } catch (err) {
    report.checks.framing = { error: err.message };
  }

  report.ok = report.products.length > 0;
  return finish(report);
}

function finish(report) {
  log(`\n${report.products.length} products from ${report.categories.filter((c) => c.kept).length} category pages.`);
  log(JSON.stringify({ robots: report.robots, categories: report.categories, checks: report.checks }, null, 2));
  if (report.ok) {
    const snapshot = {
      about: 'UNIQLO US products as listed on uniqlo.com category pages, read by scripts/fetch-uniqlo-catalog.js. Each keeps only its code (from its own link), its name, its photo on image.uniqlo.com, and the page it was listed on.',
      source: ORIGIN,
      fetchedAt: report.fetchedAt,
      products: report.products
    };
    fs.writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
    log(`Wrote ${path.relative(REPO, OUT)}.`);
    if (PRINT) console.log(`---8<--- uniqlo-catalog.json\n${JSON.stringify(snapshot)}\n---8<---`);
  }
  process.exitCode = report.ok ? 0 : 2;
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { rulesFor, allowed, CATEGORIES };
