#!/usr/bin/env node
/* =========================================================
   Fynd — how much of a brand's catalogue Fynd actually holds

   Measured, never assumed. From the committed catalogue
   (api/_catalog/data/<source>.json) and the last sync's record
   (<source>.status.json), it reports:

     products        how many the catalogue serves, by category and line
     against the feed
                     the rows the feed declared (a Rakuten trailer's count,
                     or the rows read), how many became products, and how
                     many were rejected and why
     fields          what share carry a photo, a price, colours, sizes,
                     stock and an affiliate link
     against a reference (--reference <file>)
                     given a list of the brand's product codes from an
                     independent count (one per line), what share the
                     catalogue holds, and which are missing

   Without a reference, coverage is reported against the feed only — the
   feed's own word for how many products the brand offers through it —
   and the report says so. It never prints "complete" without one.

   Usage:
     node scripts/catalog-coverage.js --source uniqlo-us
     node scripts/catalog-coverage.js --catalog <file> [--status <file>] [--reference <codes.txt>] [--json]
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '../api/_catalog/data');
const SOURCES = { 'uniqlo-us': 'uniqlo-us' };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (!['--source', '--catalog', '--status', '--reference'].includes(a) || i + 1 >= argv.length) throw new Error(`Unknown or incomplete option ${a}`);
    out[a.slice(2)] = argv[i += 1];
  }
  return out;
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; } };

/* the measurement, as data */
function measure(catalog, status, reference) {
  const products = catalog && Array.isArray(catalog.products) ? catalog.products : [];
  const n = products.length;
  const count = (key) => products.reduce((m, p) => Object.assign(m, { [p[key]]: (m[p[key]] || 0) + 1 }), {});
  const has = (fn) => products.filter(fn).length;
  const feed = status && status.feed ? status.feed : null;
  const out = {
    source: catalog ? catalog.source : null,
    sourceName: catalog && catalog.sourceName ? catalog.sourceName : null,
    lastSuccessfulSync: catalog ? catalog.lastSuccessfulSync || null : null,
    products: n,
    byCategory: count('category'),
    byLine: count('line'),
    fields: {
      photo: { n: has((p) => Array.isArray(p.images) && p.images.length), pct: 0 },
      price: { n: has((p) => p.price && Number.isInteger(p.price.amount)), pct: 0 },
      colours: { n: has((p) => Array.isArray(p.colours) && p.colours.length), pct: 0 },
      sizes: { n: has((p) => Array.isArray(p.sizes) && p.sizes.length), pct: 0 },
      stock: { n: has((p) => typeof p.availability === 'string'), pct: 0 },
      affiliateLink: { n: has((p) => typeof p.affiliateUrl === 'string'), pct: 0 }
    },
    againstFeed: feed ? { rows: feed.rows, read: feed.read, rejected: feed.rejected, duplicates: feed.duplicates, rejectedRows: feed.rejectedRows || [] } : null,
    againstReference: null
  };
  Object.values(out.fields).forEach((f) => { f.pct = pct(f.n, n); });
  if (reference) {
    const held = new Set(products.map((p) => p.code));
    const missing = reference.filter((c) => !held.has(c));
    out.againstReference = { reference: reference.length, held: reference.length - missing.length, pct: pct(reference.length - missing.length, reference.length), missing: missing.slice(0, 50), missingCount: missing.length };
  }
  return out;
}

function report(m) {
  const lines = [];
  lines.push(`Catalogue: ${m.products} products${m.sourceName ? ` from ${m.sourceName}` : ''}${m.lastSuccessfulSync ? `, synced ${m.lastSuccessfulSync}` : ''}.`);
  if (!m.products) lines.push('No catalogue is committed: Find Fit serves only the products Fynd sourced itself.');
  lines.push(`By category: ${Object.entries(m.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
  lines.push(`By line: ${Object.entries(m.byLine).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
  lines.push(`Fields: ${Object.entries(m.fields).map(([k, f]) => `${k} ${f.pct}% (${f.n})`).join(', ')}`);
  if (m.againstFeed) {
    lines.push(`Against the feed: ${m.againstFeed.rows} rows declared; ${m.againstFeed.read} products read, ${m.againstFeed.rejected} rows rejected, ${m.againstFeed.duplicates} duplicates.`);
    m.againstFeed.rejectedRows.slice(0, 10).forEach((r) => lines.push(`  rejected row ${r.row}${r.code ? ` (${r.code})` : ''}: ${r.error}`));
  } else lines.push('Against the feed: no sync has been recorded.');
  if (m.againstReference) {
    lines.push(`Against the reference list: ${m.againstReference.held} of ${m.againstReference.reference} products held (${m.againstReference.pct}%); ${m.againstReference.missingCount} missing${m.againstReference.missingCount ? `, e.g. ${m.againstReference.missing.slice(0, 10).join(', ')}` : ''}.`);
  } else {
    lines.push('Against the brand’s whole range: not measured — no independent list of its products was given (--reference). This is coverage of what the feed offers, not of everything the brand sells.');
  }
  return lines.join('\n');
}

function main(argv, log) {
  const say = log || console.log;
  let o;
  try { o = args(argv); } catch (err) { console.error(err.message); return 2; }
  const id = o.source ? SOURCES[o.source] : null;
  if (o.source && !id) { console.error(`--source must be one of ${Object.keys(SOURCES).join(', ')}`); return 2; }
  if (!id && !o.catalog) { console.error('Give --source <id> or --catalog <file>'); return 2; }
  const catalog = readJson(o.catalog ? path.resolve(o.catalog) : path.join(DATA, `${id}.json`));
  const status = readJson(o.status ? path.resolve(o.status) : path.join(DATA, `${id || (catalog && catalog.source) || 'none'}.status.json`));
  let reference = null;
  if (o.reference) {
    reference = [...new Set(fs.readFileSync(path.resolve(o.reference), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
  }
  const m = measure(catalog, status, reference);
  say(o.json ? JSON.stringify(m, null, 2) : report(m));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { measure, report, main };
