/* =========================================================
   Fynd — how much work a comparison took, counted anonymously

   The key product metric: how many manual inputs a shopper needs for
   one successful size comparison. This counts the distinct controls the
   shopper changed themselves (typed in, chose, ticked — each once,
   however often it was changed), and the seconds from opening Find Fit
   to a result, and sends them with a few named events to Fynd's
   aggregate counters (Account.sizing.metrics → api/_metrics.js).

   Nothing identifying is sent: no address, product, brand, size,
   measurement, or anything typed — only event names from a fixed list,
   and those two numbers. Nothing is stored in the browser. A browser
   that says Do Not Track or Global Privacy Control sends nothing at all.

     FyndMetrics.event(name)          'reference_ready', 'extraction_assisted', …
     FyndMetrics.manualInput(key)     one control changed by the shopper
     FyndMetrics.completed(outcome)   a result shown: 'ok' | 'no_match' | 'insufficient' | 'error'
   ========================================================= */

(function (global) {
  'use strict';

  const nav = global.navigator || {};
  const off = nav.doNotTrack === '1' || global.doNotTrack === '1' || nav.globalPrivacyControl === true;
  const touched = new Set();
  let started = Date.now();
  let queue = [];
  let timer = null;

  function flush() {
    timer = null;
    if (off || !queue.length) { queue = []; return; }
    const events = queue.splice(0, 20);
    const sizing = global.Account && global.Account.sizing;
    if (sizing && sizing.metrics) sizing.metrics(events).catch(() => {});
    if (queue.length) timer = global.setTimeout(flush, 0);
  }
  function push(e) {
    if (off) return;
    queue.push(Object.assign({ surface: 'site' }, e));
    if (!timer) timer = global.setTimeout(flush, 800);
  }
  const event = (name) => push({ name });
  const manualInput = (key) => { if (key) touched.add(String(key)); };

  /* every control the shopper changes on Find Fit is one manual input, counted once */
  const form = global.document && global.document.getElementById('ff-form');
  if (form) {
    const count = (e) => {
      const t = e.target;
      if (!e.isTrusted || !t || !t.matches || !t.matches('input, select, textarea')) return;
      manualInput(t.id || t.name);
    };
    /* typing counts as it happens; a choice or a tick on change */
    form.addEventListener('input', count);
    form.addEventListener('change', count);
  }
  let last = null;

  function completed(outcome) {
    event('comparison_completed');
    event({ ok: 'result_ok', no_match: 'result_no_match', insufficient: 'result_insufficient' }[outcome] || 'result_error');
    last = { manualInputs: touched.size, seconds: Math.round((Date.now() - started) / 1000) };
    push({ name: 'manual_inputs', value: touched.size });
    push({ name: 'seconds_to_result', value: Math.round((Date.now() - started) / 1000) });
    /* the next comparison is counted from here */
    touched.clear();
    started = Date.now();
  }

  event('session_start');
  global.FyndMetrics = { event, manualInput, completed, enabled: !off, inputs: () => touched.size, last: () => last };
})(typeof window !== 'undefined' ? window : globalThis);
