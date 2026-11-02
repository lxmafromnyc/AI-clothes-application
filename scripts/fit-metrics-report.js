#!/usr/bin/env node
/* =========================================================
   Fynd — how much work a size comparison takes, from the counters

     node scripts/fit-metrics-report.js [days]      (default 7)

   Reads the anonymous daily counters api/_metrics.js keeps, from the
   store the deployment uses (KV/Upstash when its environment is set;
   otherwise this process's memory, which holds nothing). Prints the
   key product metric — manual inputs per successful comparison — and
   the rest, per surface.
   ========================================================= */
'use strict';
const metrics = require('../api/_metrics');
const days = Math.max(1, Math.min(90, Number(process.argv[2]) || 7));
(async () => {
  const total = {};
  for (let i = 0; i < days; i += 1) {
    const d = metrics.day(Date.now() - i * 86400000);
    const s = await metrics.summary(d);
    for (const [surface, names] of Object.entries(s)) {
      total[surface] = total[surface] || {};
      for (const [name, e] of Object.entries(names)) {
        const t = total[surface][name] = total[surface][name] || { count: 0, sum: 0 };
        t.count += e.count; t.sum += e.sum || 0;
      }
    }
  }
  const n = (surface, name) => (total[surface] && total[surface][name] ? total[surface][name].count : 0);
  const sum = (surface, name) => (total[surface] && total[surface][name] ? total[surface][name].sum : 0);
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
  console.log(`Fynd product metrics, last ${days} day(s)`);
  for (const surface of metrics.SURFACES) {
    const done = n(surface, 'comparison_completed');
    console.log(`\n${surface}`);
    console.log(`  manual inputs per successful comparison: ${done ? (sum(surface, 'manual_inputs') / done).toFixed(2) : '—'}`);
    console.log(`  mean seconds from opening to a result:    ${n(surface, 'seconds_to_result') ? (sum(surface, 'seconds_to_result') / n(surface, 'seconds_to_result')).toFixed(1) : '—'}`);
    console.log(`  comparison completion:                    ${pct(done, n(surface, 'comparison_started'))}`);
    console.log(`  reference set-up abandonment:             ${pct(n(surface, 'reference_started') - n(surface, 'reference_ready'), n(surface, 'reference_started'))}`);
    console.log(`  candidate set-up abandonment:             ${pct(n(surface, 'candidate_started') - n(surface, 'candidate_ready'), n(surface, 'candidate_started'))}`);
    const ex = ['extraction_automatic', 'extraction_assisted', 'extraction_ai_assisted', 'extraction_unavailable', 'extraction_body_only'];
    const exAll = ex.reduce((a, k) => a + n(surface, k), 0);
    console.log(`  automatic extraction success:             ${pct(n(surface, 'extraction_automatic'), exAll)} (assisted ${pct(n(surface, 'extraction_assisted') + n(surface, 'extraction_ai_assisted'), exAll)}, unavailable ${pct(n(surface, 'extraction_unavailable') + n(surface, 'extraction_body_only'), exAll)})`);
    const res = ['result_ok', 'result_no_match', 'result_insufficient'].reduce((a, k) => a + n(surface, k), 0);
    console.log(`  results with no reliable size:            ${pct(n(surface, 'result_insufficient'), res)}`);
    console.log(`  saved-reference reuse:                    ${pct(n(surface, 'reference_ready_saved'), n(surface, 'reference_ready'))}`);
  }
})();
