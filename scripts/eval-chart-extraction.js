#!/usr/bin/env node
/* =========================================================
   Fynd — how accurately each reading interprets size charts

     node scripts/eval-chart-extraction.js            deterministic, and the
                                                      validator on scripted
                                                      answers
     node scripts/eval-chart-extraction.js --live     also the AI-assisted
                                                      reading with the real
                                                      model (GEMINI_API_KEY)
     … --json FILE                                    the full report as JSON

   Every chart in scripts/fixtures/chart-ai/cases.js has a `truth`: the
   reading a careful person makes from the page alone, checked by hand.
   Each reading is scored field by field against it:

     what the table measures · its unit · each column's measurement and
     method · each size's value for each measurement

   and each field is one of:
     correct      matches the truth (including "not stated" when the page
                  doesn't state it)
     wrong        an answer that differs from the truth
     unresolved   left for the shopper (the truth says something; the
                  reading didn't claim it)

   and every reading is either
     AUTOMATIC    nothing uncertain: the shopper isn't asked to check it
                  (extract.js isAutomatic). A wrong automatic field is the
                  failure that matters most, and must be zero.
     CONFIRM      the shopper must check it before going on (an AI-assisted
                  reading always; a deterministic one with anything taken
                  from near the table, rows out of line, or a part it
                  couldn't read)

   Three readings, reported apart:
     1. DETERMINISTIC — the extension's own reading
        (sizing-tables.js, chart-reading.js, extract.js), as the shopper
        would see it with no AI.
     2. AI-ASSISTED (live) — the full system: the deterministic reading
        where it is enough, and the real model's answer, checked by
        api/_sizing/chart-ai.js, where the extension would ask for it.
        Only with --live and a key; otherwise reported as not measured.
     3. VALIDATOR ON SCRIPTED ANSWERS — the same system with the fixtures'
        hand-written model answers (some deliberately wrong). This tests
        Fynd's checks, NOT any model's accuracy, and is labelled so.

   Twelve invented charts are a test set, not a benchmark: these numbers
   say nothing about real retailers' pages.
   ========================================================= */

'use strict';

const fs = require('fs');
const X = require('../extension/extract.js');
const ChartAI = require('../api/_sizing/chart-ai');
const gemini = require('../api/_interpreters/gemini');
const { CASES } = require('./fixtures/chart-ai/cases.js');

const LIVE = process.argv.includes('--live');
const JSON_OUT = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

/* ---------- each reading, in one shape: { path, measures, unit, columns: {gridCol: [dim, method]}, values: {size: {dim: value}} } ---------- */
/* as extension/collect.js returns it: merged cells expanded */
function rawTable(c) {
  return { rows: c.table.grid, grid: c.table.grid, caption: c.table.caption, before: c.table.before, visible: true };
}
function fromReview(review, c, headerOf) {
  const columns = {};
  const values = {};
  review.columns.forEach((rc) => {
    const g = headerOf(rc);
    if (g === null) return;
    columns[g] = [rc.dim || null, rc.dim ? rc.method || null : null];
  });
  review.rows.forEach((row) => {
    values[row.size] = {};
    review.columns.filter((rc) => rc.dim).forEach((rc) => { const cell = row.cells[rc.index]; values[row.size][rc.dim] = cell && typeof cell.value === 'number' ? cell.value : null; });
  });
  return { measures: review.measures, unit: review.unit || null, columns, values };
}
/* the deterministic reading: what the extension shows with no AI */
function deterministic(c) {
  const t = rawTable(c);
  const ch = X.charts({ tables: [t] });
  if (!ch.list.length) return { path: ch.unread.length ? 'unread' : 'nothing', measures: null, unit: null, columns: {}, values: {} };
  const chart = ch.list[0];
  const review = X.startReview(chart, null, t);
  const used = new Set();
  /* a review column is the grid column whose first heading cell it is (the first not yet used) */
  const headerOf = (rc) => { const g = c.table.grid[0].findIndex((h, i) => h === rc.header && !used.has(i)); if (g < 0) return null; used.add(g); return g; };
  const needs = chart.measures === 'body' ? [] : X.interpretationNeeds(review, t);
  /* asked to check: anything uncertain, or a part Fynd couldn't read (the AI path's fallback carries that check) */
  const automatic = chart.measures !== 'body' && !needs.length && X.isAutomatic(review);
  return Object.assign({ path: chart.measures === 'body' ? 'none' : needs.length ? 'ai' : 'deterministic', automatic }, fromReview(review, c, headerOf));
}
/* the AI-assisted system: deterministic where it is enough; else the checked proposal */
async function assisted(c, answer) {
  const det = deterministic(c);
  if (det.path !== 'ai' && det.path !== 'unread') return Object.assign(det, { asked: false });
  const table = ChartAI.readTableInput({ table: { grid: c.table.grid, caption: c.table.caption, before: c.table.before }, type: c.type }).table;
  const own = ChartAI.context(table, (require('../assets/chart-reading.js').gridShape(table.grid) || { headerRows: 1 }).headerRows);
  if (own.kind === 'body') return Object.assign(det, { asked: false, path: 'none' });
  const got = await answer(c, table);
  if (!got.ok) return Object.assign(det, { asked: true, failed: got.reason, automatic: false });
  const v = ChartAI.validate(got.raw, table);
  if (!v.ok) return Object.assign(det, { asked: true, failed: 'invalid-response', automatic: false });
  const review = X.reviewFromInterpretation(v.result, null);
  /* an AI-assisted reading is never automatic */
  return Object.assign({ path: 'ai', asked: true, automatic: false, status: v.result.status, tokens: got.tokens || 0 }, fromReview(review, c, (rc) => rc.index));
}

/* ---------- scoring ---------- */
function score(c, reading) {
  const t = c.truth;
  const fields = [];
  const judge = (field, truth, got) => fields.push({ field, truth, got, verdict: truth === got ? 'correct' : got === null || got === undefined ? 'unresolved' : 'wrong' });
  judge('measures', t.measures, reading.measures === 'body' || reading.measures === 'finished-garment' ? reading.measures : (reading.measures === 'not-stated' ? null : reading.measures));
  if (t.measures !== 'body') {
    judge('unit', t.unit, reading.unit);
    Object.entries(t.columns).forEach(([g, [dim, method]]) => {
      const got = reading.columns[g] || [null, null];
      judge(`column ${g} measurement`, dim, got[0]);
      if (dim) judge(`column ${g} method`, method, got[0] === dim ? got[1] : null);
    });
    Object.entries(t.values).forEach(([size, dims]) => Object.entries(dims).forEach(([dim, v]) => {
      const got = reading.values[size] ? reading.values[size][dim] : undefined;
      judge(`${size} ${dim}`, v, got === undefined ? null : got);
    }));
  }
  /* a truth of null ("the page doesn't state it") answered with null is correct, not unresolved */
  fields.forEach((f) => { if (f.truth === null && (f.got === null || f.got === undefined)) f.verdict = 'correct'; });
  return fields;
}
const tally = (fields) => fields.reduce((a, f) => { a[f.verdict] += 1; a.total += 1; return a; }, { correct: 0, wrong: 0, unresolved: 0, total: 0 });
const split = (rows, automatic) => tally(rows.filter((r) => r.automatic === automatic).flatMap((r) => r.fields));
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');

function report(title, note, rows) {
  const all = tally(rows.flatMap((r) => r.fields));
  const auto = split(rows, true);
  const confirm = split(rows, false);
  console.log(`\n${title}`);
  if (note) console.log(note);
  console.log('  case                    path                        mode       correct  wrong  unresolved');
  rows.forEach((r) => { const t = tally(r.fields); console.log(`  ${r.id.padEnd(23)} ${String(r.path).padEnd(27)} ${(r.automatic ? 'automatic' : 'confirm').padEnd(9)} ${String(t.correct).padStart(4)}/${String(t.total).padEnd(4)} ${String(t.wrong).padStart(4)}  ${String(t.unresolved).padStart(6)}${r.failed ? `   (AI: ${r.failed})` : ''}`); });
  console.log(`  AUTOMATIC (no shopper check): ${auto.correct}/${auto.total} correct, ${auto.wrong} WRONG`);
  console.log(`  NEEDS CONFIRMATION:           ${confirm.correct}/${confirm.total} correct, ${confirm.wrong} wrong, ${confirm.unresolved} left for the shopper`);
  console.log(`  ALL: ${all.correct}/${all.total} correct (${pct(all.correct, all.total)}), ${all.wrong} wrong (${pct(all.wrong, all.total)}), ${all.unresolved} unresolved (${pct(all.unresolved, all.total)})`);
  return { all, automatic: auto, confirm };
}

(async () => {
  if (process.argv.includes('--check')) {
    /* CI: no automatic reading may be wrong (the deterministic evaluation, no model) */
    const wrong = CASES.map((c) => ({ c, r: deterministic(c) })).filter(({ r }) => r.automatic).flatMap(({ c, r }) => score(c, r).filter((f) => f.verdict === 'wrong').map((f) => `${c.id}: ${f.field}`));
    console.log(wrong.length ? `automatic readings with wrong fields: ${wrong.join(', ')}` : 'no automatic reading has a wrong field');
    process.exit(wrong.length ? 1 : 0);
  }
  console.log(`Chart reading accuracy on ${CASES.length} invented charts (scripts/fixtures/chart-ai/cases.js), against hand-checked readings.`);
  console.log('A test set, not a benchmark: it says nothing about any real retailer’s pages.');

  const det = CASES.map((c) => { const r = deterministic(c); return { id: c.id, path: r.path, automatic: r.automatic, fields: score(c, r) }; });
  const detAll = report('1. DETERMINISTIC (the extension’s own reading, no AI)', null, det);

  let live = null;
  if (LIVE && gemini.configured()) {
    const rows = [];
    let tokens = 0;
    for (const c of CASES) {
      const r = await assisted(c, async (cc, table) => gemini.generateJson({ systemPrompt: ChartAI.SYSTEM_PROMPT, userText: ChartAI.userText(table), timeoutMs: 20000, maxOutputTokens: 2048 }));
      tokens += r.tokens || 0;
      rows.push({ id: c.id, path: r.asked ? `ai${r.status ? ` (${r.status})` : ''}` : r.path, automatic: Boolean(r.automatic), failed: r.failed || null, fields: score(c, r) });
    }
    live = report(`2. AI-ASSISTED, LIVE GEMINI MEASUREMENT (${gemini.model()}; ${tokens} tokens)`, 'The deterministic reading where it is enough; the real model’s answer, checked by Fynd, where the extension asks.', rows);
  } else {
    console.log(`\n2. AI-ASSISTED, LIVE GEMINI MEASUREMENT: NOT MEASURED — ${LIVE ? 'GEMINI_API_KEY is not set' : 'run with --live and GEMINI_API_KEY'}. No AI accuracy figure exists until it is run.`);
  }

  const scripted = [];
  for (const c of CASES) {
    const r = await assisted(c, async (cc) => (cc.model ? { ok: true, raw: cc.model } : { ok: false, reason: 'no-scripted-answer' }));
    scripted.push({ id: c.id, path: r.asked ? `ai${r.status ? ` (${r.status})` : ''}` : r.path, automatic: Boolean(r.automatic), failed: r.failed || null, fields: score(c, r) });
  }
  const scriptedAll = report('3. VALIDATOR CHECK WITH SCRIPTED ANSWERS — NOT A MEASUREMENT OF GEMINI OR ANY MODEL', 'The same system with the fixtures’ hand-written model answers, several deliberately wrong: it shows what Fynd’s checks keep and refuse.', scripted);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ cases: CASES.length, deterministic: { total: detAll, cases: det }, live: live ? { total: live } : 'not measured', scriptedValidatorCheck: { note: 'scripted answers: not a model measurement', total: scriptedAll, cases: scripted } }, null, 2));
    console.log(`\nreport: ${JSON_OUT}`);
  }
})();
