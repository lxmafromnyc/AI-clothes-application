#!/usr/bin/env node
/* =========================================================
   Fynd — a draft sizing record from the Fit panel's test report

     node scripts/record-from-report.js report.json [--write] [--by "Name"]

   report.json is what "Copy test report" puts on the clipboard, on a
   product page whose size guide was open and read. This prints what was
   extracted (product, sizes, each chart in its own unit and in inches)
   and what is missing, and with --write saves the draft record to
   api/_sizing/drafts/<id>.json.

   A draft is never loaded: Fynd reads only api/_sizing/records, listed
   in api/_sizing/records.js. To make it a record, a person checks every
   value against the page, supplies each missing field from the page,
   moves the file into records/, lists it in records.js, and runs
   node scripts/build-fit-references.js && node scripts/sync-extension.js.
   It stays "unverified" until someone checks it and says so.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { recordFromReport } = require('../api/_sizing/page-record');
const F = require('../assets/fit-anchor');

const DRAFTS = path.join(__dirname, '..', 'api', '_sizing', 'drafts');

function inches(value, unit) { return unit === 'cm' ? Math.round((value / 2.54) * 100) / 100 : value; }

function describe(out) {
  const lines = [];
  const r = out.record;
  lines.push(`status: ${out.status}`);
  if (!r) { out.missing.forEach((m) => lines.push(`  refused: ${m.why}`)); return lines.join('\n'); }
  lines.push(`brand: ${r.brand}`, `product_name: ${r.product.name}`, `product_url: ${r.product.url}`, `product_code: ${r.product.code}`,
    `category: ${r.category}`, `sizes: ${r.sizes.join(', ')}`, `units (as published): ${r.units}`, `retrieved: ${r.retrievedAt}`, `verification: ${r.verification.status}`);
  Object.entries(r.charts).forEach(([which, c]) => {
    lines.push('', `${which} chart — "${c.label}" (${c.measures === 'body' ? 'the person\'s body' : 'the garment itself'}), ${c.source}`);
    Object.entries(c.dimensions).forEach(([dim, d]) => lines.push(`  ${dim}: column "${d.label}", method ${d.method || 'NOT STATED'}`));
    r.sizes.forEach((size) => {
      const row = c.sizes[size];
      if (!row) { lines.push(`  ${size}: not in this chart`); return; }
      lines.push(`  ${size}: ${Object.entries(row).map(([dim, cell]) => (cell.min !== undefined
        ? `${dim} "${cell.text}" (${cell.min}–${cell.max} ${r.units})`
        : `${dim} "${cell.text}" = ${cell.value} ${r.units}${r.units === 'cm' ? ` = ${inches(cell.value, 'cm')} in` : ''}`)).join('; ')}`);
    });
  });
  if (!r.charts.garment) lines.push('', 'garment chart: none — no garment measurement is worked out from a body chart');
  if (out.missing.length) { lines.push('', 'missing (supply from the page before this can be a record):'); out.missing.forEach((m) => lines.push(`  ${m.field}: ${m.why}`)); }
  if (out.notRecorded.length) { lines.push('', 'not recorded:'); out.notRecorded.forEach((n) => lines.push(`  ${n}`)); }
  if (out.errors.length) { lines.push('', `schema: ${out.errors.length} problem(s) — the draft can't be loaded as it is`); out.errors.forEach((e) => lines.push(`  ${e.field}: ${e.message}`)); }
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--by');
  if (!file) { console.error('usage: node scripts/record-from-report.js report.json [--write] [--by "Name"]'); process.exit(2); }
  const by = args.includes('--by') ? args[args.indexOf('--by') + 1] : undefined;
  let report;
  try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { console.error(`Couldn't read ${file} as JSON: ${err.message}`); process.exit(2); }
  const out = recordFromReport(report, { by });
  console.log(describe(out));
  if (args.includes('--write') && out.record) {
    fs.mkdirSync(DRAFTS, { recursive: true });
    const name = out.record.id || `draft-${Date.now()}`;
    const target = path.join(DRAFTS, `${name}.json`);
    fs.writeFileSync(target, `${JSON.stringify(out.record, null, 2)}\n`);
    console.log(`\ndraft written: ${path.relative(process.cwd(), target)} (not loaded by Fynd)`);
  }
  /* the comparison can read what was extracted: shown, never stored */
  if (out.record && out.record.charts.garment) {
    const g = out.record.charts.garment;
    const kind = { hoodies: 'sweatshirt', sweatshirts: 'sweatshirt', tshirts: 'tshirt' }[out.record.category] || 'tshirt';
    const dims = Object.keys(g.dimensions);
    const chart = { measures: 'finished-garment', unit: out.record.units, columns: dims.map((d) => g.dimensions[d].label), rows: out.record.sizes.filter((z) => g.sizes[z]).map((z) => ({ size: z, values: dims.map((d) => (g.sizes[z][d] ? g.sizes[z][d].text : '')) })) };
    const read = F.readChart(chart, kind);
    console.log(`\nFynd's comparison reads it as: ${read.sizes.length} sizes, ${Object.keys(read.columns).join(', ')}; issues: ${read.issues.length ? read.issues.map((i) => i.text).join(' | ') : 'none'}`);
  }
  process.exit(out.status === 'refused' ? 1 : 0);
}

module.exports = { describe };
