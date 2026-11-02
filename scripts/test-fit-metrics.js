#!/usr/bin/env node
/* =========================================================
   Fynd — the anonymous product counters (api/_metrics.js)

     node scripts/test-fit-metrics.js

   Through the real /api/size-recommendation handler (?metrics=1):
   only event names from a fixed list, a surface, and a number for the
   two valued events; anything else refused whole; kept as daily totals
   and coarse buckets, with nothing identifying stored anywhere.
   ========================================================= */

'use strict';

const assert = require('assert');
process.env.AUTH_SECRET = 'metrics-test-secret-of-sufficient-length';
['log', 'warn', 'error'].forEach((level) => { const o = console[level]; console[level] = (...a) => { if (process.env.SHOW_LOGS) o(...a); }; });

const store = require('../api/_store');
const metrics = require('../api/_metrics');
const endpoint = require('../api/size-recommendation');

const out = (t) => process.stdout.write(t);
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; out(`  ok    ${name}\n`); }
  catch (err) { failures.push(name); out(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n        ')}\n`); }
}
let n = 0;
function post(body, ip) {
  n += 1;
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); return this; }, end() { resolve({ status: this.statusCode, body: null }); return this; } };
    endpoint({ method: 'POST', url: '/api/size-recommendation?metrics=1', query: { metrics: '1' }, body, headers: { host: 'fynd.test', 'content-type': 'application/json' }, socket: { remoteAddress: ip || `198.51.100.${n % 250}` }, on() { return this; } }, res);
  });
}

(async () => {
  store.reset();
  out('\nthe anonymous counters\n');

  await test('named events from the list are counted as daily totals; the two valued ones as a sum and a coarse bucket', async () => {
    const r = await post({ events: [{ name: 'comparison_started' }, { name: 'comparison_completed' }, { name: 'manual_inputs', value: 2 }, { name: 'seconds_to_result', value: 45 }, { name: 'extraction_assisted', surface: 'extension' }] });
    assert.deepStrictEqual([r.status, r.body], [200, { ok: true }]);
    const s = await metrics.summary(metrics.day());
    assert.deepStrictEqual([s.site.comparison_completed.count, s.site.manual_inputs.sum, s.site.manual_inputs.buckets, s.site.seconds_to_result.buckets, s.extension.extraction_assisted.count], [1, 2, { le2: 1 }, { le60: 1 }, 1]);
  });

  await test('anything else is refused whole: an unknown name, an extra field (a link, a product), a value where none belongs, too many events', async () => {
    for (const body of [
      { events: [{ name: 'shopper_email' }] },
      { events: [{ name: 'comparison_completed', url: 'https://shop.example/p' }] },
      { events: [{ name: 'comparison_completed', product: 'Hoodie' }] },
      { events: [{ name: 'comparison_completed', value: 3 }] },
      { events: [{ name: 'manual_inputs', value: 'two' }] },
      { events: [{ name: 'manual_inputs', value: -1 }] },
      { events: [{ name: 'comparison_completed', surface: 'email' }] },
      { events: Array.from({ length: 21 }, () => ({ name: 'session_start' })) },
      { events: [] },
      {}
    ]) {
      const r = await post(body);
      assert.deepStrictEqual([r.status, r.body.reason], [400, 'invalid-events'], JSON.stringify(body).slice(0, 80));
    }
  });

  await test('nothing identifying is kept: every stored key is a day, a surface, an event name and a bucket — no address, no session', async () => {
    const keys = [];
    const realAdd = store.add;
    store.add = async (k, ...rest) => { keys.push(k); return realAdd.call(store, k, ...rest); };
    await post({ events: [{ name: 'reference_ready_saved' }, { name: 'manual_inputs', value: 7 }] }, '203.0.113.77');
    store.add = realAdd;
    const counters = keys.filter((k) => k.startsWith('metrics:'));
    assert.ok(counters.length >= 3);
    counters.forEach((k) => assert.match(k, /^metrics:\d{4}-\d{2}-\d{2}:(site|extension):[a-z_]+(:(sum|le\d+|gt\d+))?$/, k));
    assert.ok(!keys.some((k) => k.includes('203.0.113.77')), 'the address never stored as given');
  });

  await test('paced per address: 120 posts in ten minutes, then 429', async () => {
    for (let i = 0; i < 120; i += 1) assert.strictEqual((await post({ events: [{ name: 'session_start' }] }, '192.0.2.9')).status, 200);
    assert.strictEqual((await post({ events: [{ name: 'session_start' }] }, '192.0.2.9')).status, 429);
  });

  out(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exit(1);
})();
