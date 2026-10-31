#!/usr/bin/env node
/* =========================================================
   Fynd — validate a sample of a Rakuten Product Catalog file

   Before the first sync: does what Rakuten delivers for UNIQLO USA pass
   the import's own checks, and what does it actually carry? Reads a
   whole file or only its first bytes (scripts/rakuten-sftp.sh fetch …
   <max bytes>), gzipped or not, through the same reader and import the
   sync uses (api/_catalog/rakuten.js, import.js), and reports:

     the header     advertiser ID (checked against RAKUTEN_UNIQLO_MID),
                    name, date, full or delta
     the lines      how many, field counts, and how far each field the
                    import relies on is filled: SKU, a product URL leading
                    to a UNIQLO US page with a product code, a photo on
                    image.uniqlo.com, Class 60 (clothing), size, colour,
                    gender, age, retail price; the categories used; SKUs
                    per product (whether a line is one variant)
     the import     products, rows rejected and why, products by Fynd
                    category and line, and the share with photos, sizes,
                    colours and a price under the licence given
     a verdict      whether a sync of a file like this would be refused,
                    and why

   A sample is cut off: its last partial line is dropped, and — since it
   has no trailer — one counting the lines kept is added for parsing only.
   A trailer is checked for real only on a whole file. It writes nothing,
   imports nothing, and says nothing about how much of UNIQLO's range the
   feed covers: only a synced, reviewed catalogue can say that.

   Usage:
     node scripts/rakuten-sample.js --file <MID_SID_mp.txt[.gz]> [--lines 2000]
       [--licensed images,colours,…] [--mid <MID>] [--examples 3] [--json]
   (--licensed and --mid default to UNIQLO_FEED_LICENSED_FIELDS and
   RAKUTEN_UNIQLO_MID.) Exit 0 when a sync would accept it, 1 when it
   would be refused, 2 on a usage error.
   ========================================================= */

'use strict';

const fs = require('fs');
const zlib = require('zlib');
const rakuten = require('../api/_catalog/rakuten');
const { read, FeedError, LIMITS } = require('../api/_catalog/import');
const adapter = require('../api/_catalog/sources/uniqlo-us');

const MAX_REJECT_RATIO = 0.1; /* the sync's own (api/_catalog/sync.js) */

function args(argv) {
  const out = { lines: 2000, examples: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (!['--file', '--lines', '--licensed', '--mid', '--examples', '--now'].includes(a) || argv[i + 1] === undefined) throw new Error(`Unexpected argument ${a}`);
    out[a.slice(2)] = argv[i += 1];
  }
  if (!out.file) throw new Error('--file is required');
  out.lines = Number(out.lines);
  out.examples = Number(out.examples);
  if (!Number.isInteger(out.lines) || out.lines < 1 || out.lines > LIMITS.rows) throw new Error(`--lines must be 1 to ${LIMITS.rows}`);
  if (!Number.isInteger(out.examples) || out.examples < 0 || out.examples > 20) throw new Error('--examples must be 0 to 20');
  return out;
}

/* the file's text: gunzipped if it is gzip, as far as it goes when cut off */
function textOf(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return { text: zlib.gunzipSync(buf).toString('utf8'), gzip: 'whole' }; } catch (err) {
      return { text: zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8'), gzip: 'cut off' };
    }
  }
  return { text: buf.toString('utf8'), gzip: null };
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function validate(buf, options) {
  const opts = options || {};
  const { text, gzip } = textOf(buf);
  let lines = text.replace(/^﻿/, '').split(/\r?\n/);
  /* the line a cut fell in: always, for a cut-off gzip; otherwise a last
     line with no line break after it, unless it is a whole trailer */
  const last = lines[lines.length - 1];
  if (gzip === 'cut off' || (!/\n$/.test(text) && !/^TRL\|\d+\s*$/.test(last))) lines.pop();
  lines = lines.filter((l) => l.trim() !== '');
  const blockers = [];
  const warnings = [];
  if (!lines.length || !/^HDR\|/.test(lines[0])) {
    return { verdict: 'refused', blockers: ['It doesn’t start with an HDR record: not a Rakuten Product Catalog file (or not gunzipped).'], warnings, gzip };
  }
  const hasTrailer = /^TRL\|/.test(lines[lines.length - 1]);
  const body = lines.slice(1, hasTrailer ? -1 : undefined);
  const kept = body.slice(0, opts.lines);
  const mode = hasTrailer && kept.length === body.length ? 'whole file' : 'sample';
  const head = rakuten.fields(lines[0]);
  const header = { mid: head[1] || null, name: head[2] || null, generatedAt: rakuten.stamp(head[3]), declared: hasTrailer ? Number(rakuten.fields(lines[lines.length - 1])[1]) : null };
  if (opts.mid && header.mid !== String(opts.mid)) blockers.push(`The header’s advertiser ID is ${header.mid}, not RAKUTEN_UNIQLO_MID (${opts.mid}): this isn’t UNIQLO USA’s file, or the variable is wrong.`);
  if (!opts.mid) warnings.push('RAKUTEN_UNIQLO_MID isn’t set, so the advertiser ID wasn’t checked.');
  if (!header.generatedAt) warnings.push('The header’s date isn’t in Rakuten’s documented form (mm/dd/yyyy hh:mm:ss).');

  /* what each line carries, field by field */
  const fill = { sku: 0, productPage: 0, uniqloCode: 0, trackingLink: 0, imageOnUniqloHost: 0, clothingClass: 0, size: 0, colour: 0, gender: 0, age: 0, retailPrice: 0 };
  const fieldCounts = {};
  const primary = new Map();
  const classes = new Map();
  const skus = new Set();
  const codes = new Map();
  let duplicateSkus = 0;
  let unreadable = 0;
  kept.forEach((line) => {
    let f;
    try { f = rakuten.fields(line); } catch (err) { unreadable += 1; return; }
    fieldCounts[f.length] = (fieldCounts[f.length] || 0) + 1;
    const at = (n) => (f[n - 1] || '').trim();
    if (at(3)) { if (skus.has(at(3))) duplicateSkus += 1; skus.add(at(3)); fill.sku += 1; }
    const { page, tracking } = rakuten.pages(at(6));
    if (page) fill.productPage += 1;
    if (tracking) fill.trackingLink += 1;
    const code = page ? adapter.codeFromUrl(page) : null;
    if (code) { fill.uniqloCode += 1; codes.set(code, (codes.get(code) || 0) + 1); }
    if (adapter.image(at(7), code)) fill.imageOnUniqloHost += 1;
    if (at(25) === '60') fill.clothingClass += 1;
    classes.set(at(25) || '(none)', (classes.get(at(25) || '(none)') || 0) + 1);
    if (at(31)) fill.size += 1;
    if (at(33)) fill.colour += 1;
    if (at(34)) fill.gender += 1;
    if (at(36)) fill.age += 1;
    if (rakuten.amount(at(14))) fill.retailPrice += 1;
    primary.set(at(4) || '(none)', (primary.get(at(4) || '(none)') || 0) + 1);
  });
  const n = kept.length;
  const lineReport = {
    read: n,
    unreadable,
    fieldCounts,
    filled: Object.fromEntries(Object.entries(fill).map(([k, v]) => [k, { lines: v, percent: pct(v, n) }])),
    skus: skus.size,
    duplicateSkus,
    productCodes: codes.size,
    skusPerProduct: codes.size ? Math.round((fill.uniqloCode / codes.size) * 10) / 10 : null,
    classes: [...classes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })),
    primaryCategories: [...primary.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value, count }))
  };
  if (n && !fill.uniqloCode) blockers.push('No line’s Product URL leads to a UNIQLO US product page with a product code (www.uniqlo.com/us/en/products/E######-###): the adapter would reject every row.');
  else if (n && fill.uniqloCode < n) warnings.push(`Only ${pct(fill.uniqloCode, n)}% of lines lead to a UNIQLO US product page with a code; the rest will be rejected.`);
  if (n && pct(fill.imageOnUniqloHost, n) < 90) warnings.push(`${pct(fill.imageOnUniqloHost, n)}% of lines have a photo on image.uniqlo.com at an address with the product’s code; other photos are dropped (the product is kept).`);
  if (n && pct(fill.clothingClass, n) < 50) warnings.push(`Only ${pct(fill.clothingClass, n)}% of lines are Class 60 (clothing), so size, colour, gender and age are read from few of them.`);
  if (Object.keys(fieldCounts).some((k) => k !== '38' && k !== '39')) warnings.push(`Some lines don’t have 38 (or 39, delta) fields: ${JSON.stringify(fieldCounts)}. Those are rejected.`);

  /* the import itself, exactly as a sync runs it */
  const parsed = [lines[0], ...kept, mode === 'whole file' ? lines[lines.length - 1] : `TRL|${kept.length}`].join('\n');
  let imported = null;
  try {
    imported = read(parsed, adapter, { licensed: opts.licensed || [], mid: opts.mid || null, now: opts.now || new Date().toISOString() });
  } catch (err) {
    blockers.push(err instanceof FeedError ? `The import refused it (${err.reason}): ${err.message}` : `The import failed: ${err && err.message}`);
  }
  let importReport = null;
  if (imported) {
    const products = imported.products;
    const rows = imported.header.rows;
    const reasons = new Map();
    imported.rejected.forEach((r) => reasons.set(r.error, (reasons.get(r.error) || 0) + 1));
    const by = (key) => products.reduce((m, p) => { m[p[key] || '(none)'] = (m[p[key] || '(none)'] || 0) + 1; return m; }, {});
    const share = (test) => ({ products: products.filter(test).length, percent: pct(products.filter(test).length, products.length) });
    importReport = {
      format: imported.header.format,
      licensed: imported.header.licensed,
      rows,
      products: products.length,
      rejected: imported.rejected.length,
      rejectedPercent: pct(imported.rejected.length, rows),
      rejectedReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
      discontinued: imported.discontinued.length,
      byCategory: by('category'),
      byLine: by('line'),
      withPhotos: share((p) => Array.isArray(p.images) && p.images.length > 0),
      withSizes: share((p) => Array.isArray(p.sizes) && p.sizes.length > 0),
      withColours: share((p) => Array.isArray(p.colours) && p.colours.length > 0),
      withPrice: share((p) => Boolean(p.price)),
      examples: products.slice(0, opts.examples).map((p) => ({ code: p.code, name: p.name, category: p.category, line: p.line, url: p.url }))
    };
    if (!products.length) blockers.push('No product passed the import’s checks.');
    if (rows && imported.rejected.length / rows > MAX_REJECT_RATIO) blockers.push(`${importReport.rejectedPercent}% of rows were rejected; a sync refuses a feed with more than ${MAX_REJECT_RATIO * 100}%.`);
    if (!importReport.licensed.length) warnings.push('No licensed fields were given, so photos, colours, sizes, price, stock and descriptions were all dropped. Set UNIQLO_FEED_LICENSED_FIELDS (or --licensed) to what the agreement covers.');
    if (mode === 'sample' && imported.header.complete) warnings.push('This is a sample: a sync of the whole file would treat it as UNIQLO’s complete catalogue (its trailer checked) and remove anything it no longer lists.');
  }
  if (mode === 'sample') warnings.push(`A sample of ${kept.length} product lines${gzip === 'cut off' ? ' from a cut-off download' : ''}: its trailer was added for parsing only, and nothing here says how many products the whole file holds.`);
  return { verdict: blockers.length ? 'refused' : 'accepted', mode, gzip, header, lines: lineReport, import: importReport, blockers, warnings };
}

function print(r, log) {
  log('Rakuten Product Catalog — sample validation (nothing imported or written)\n');
  if (r.header) log(`  header: MID ${r.header.mid} · ${r.header.name} · ${r.header.generatedAt || 'date unreadable'}${r.header.declared !== null ? ` · trailer: ${r.header.declared} lines` : ''}`);
  if (r.mode) log(`  read as: ${r.mode}${r.gzip ? ` (gzip ${r.gzip})` : ''}`);
  if (r.lines) {
    log(`  lines: ${r.lines.read} · field counts ${JSON.stringify(r.lines.fieldCounts)} · ${r.lines.productCodes} product codes, ${r.lines.skus} SKUs (${r.lines.skusPerProduct || '–'} per product)${r.lines.duplicateSkus ? ` · ${r.lines.duplicateSkus} repeated SKUs` : ''}`);
    log('  filled, by line:');
    Object.entries(r.lines.filled).forEach(([k, v]) => log(`    ${k.padEnd(18)} ${String(v.percent).padStart(5)}%  (${v.lines})`));
    log(`  classes: ${r.lines.classes.map((c) => `${c.value} ×${c.count}`).join(', ')}`);
    log(`  primary categories: ${r.lines.primaryCategories.map((c) => `${c.value} ×${c.count}`).join(', ')}`);
  }
  if (r.import) {
    const i = r.import;
    log(`\n  import (${i.format}; licensed: ${i.licensed.join(', ') || 'none'}): ${i.products} products from ${i.rows} rows · ${i.rejected} rejected (${i.rejectedPercent}%) · ${i.discontinued} discontinued`);
    i.rejectedReasons.forEach((x) => log(`    rejected ×${x.count}: ${x.reason}`));
    log(`  by category: ${JSON.stringify(i.byCategory)}`);
    log(`  by line: ${JSON.stringify(i.byLine)}`);
    log(`  with photos ${i.withPhotos.percent}% · sizes ${i.withSizes.percent}% · colours ${i.withColours.percent}% · price ${i.withPrice.percent}%`);
    i.examples.forEach((p) => log(`    e.g. ${p.code}  ${p.name}  (${p.category}, ${p.line})`));
  }
  r.warnings.forEach((w) => log(`\n  warn  ${w}`));
  r.blockers.forEach((b) => log(`\n  FAIL  ${b}`));
  log(`\n${r.verdict === 'accepted' ? 'A sync would accept a file like this sample. Run the sync by hand and review its report before committing anything.' : 'A sync would refuse a file like this: fix each FAIL above first.'}`);
  log('This is a check of the file’s shape, not an import: no catalogue is connected until one has been synced, reviewed and committed.');
}

function main(argv, deps) {
  const d = Object.assign({ env: process.env, log: console.log, error: console.error }, deps || {});
  let o;
  try { o = args(argv); } catch (err) { d.error(`${err.message}\nUsage: rakuten-sample.js --file <file> [--lines N] [--licensed …] [--mid MID] [--examples N] [--json]`); return 2; }
  let buf;
  try { buf = fs.readFileSync(o.file); } catch (err) { d.error(`Can’t read ${o.file}: ${err.code || err.message}`); return 2; }
  const licensed = (o.licensed !== undefined ? o.licensed : d.env.UNIQLO_FEED_LICENSED_FIELDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const r = validate(buf, { lines: o.lines, licensed, mid: o.mid || d.env.RAKUTEN_UNIQLO_MID || null, examples: o.examples, now: o.now });
  if (o.json) d.log(JSON.stringify(r, null, 2)); else print(r, d.log);
  return r.verdict === 'accepted' ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { validate, main };
