#!/usr/bin/env node
/* =========================================================
   FindWear — usage metering and enforcement tests

   Drives the real handlers with the real metering code. Only the two
   paid upstreams — OpenAI and the product provider — are stubbed, at the
   network boundary, so what is under test is FindWear's own accounting:
   who is charged, when, how much, and what happens when something goes
   wrong halfway through.

   The store is the in-process adapter. It has exactly the semantics the
   Redis adapter is built on — atomic increment, set-if-absent, TTL — so
   the logic exercised here is the logic that runs in production.

   Usage: node scripts/test-usage.js
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.USAGE_STORE = 'memory';
process.env.SESSION_SECRET = 'usage-test-secret';
process.env.OPENWEBNINJA_API_KEY = 'test-key';
process.env.PRODUCT_SOURCE = 'openwebninja';
process.env.OPENAI_API_KEY = 'test-openai-key';

const plans = require('../api/_plans');
const accounts = require('../api/_accounts');
const usage = require('../api/_usage');
const { resetStore, getStore, createMemoryStore } = require('../api/_store');
const { createCallBudget } = require('../api/_call-budget');
const Meter = require('../assets/usage.js');

const searchHandler = require('../api/search');
const interpretHandler = require('../api/interpret');
const usageHandler = require('../api/usage');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    resetStore();
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

/* ---------------------------------------------------------
   Scaffolding
   --------------------------------------------------------- */

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
}

function withStubbedFetch(handler, run) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(run()).finally(() => { global.fetch = real; });
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

/* A product that verifies without needing an offers lookup, so a search
   costs exactly one upstream call unless a test wants more. */
const sellableProduct = (over) => Object.assign({
  product_id: 'p1',
  product_title: 'Champion Reverse Weave Oversized Hoodie, Black',
  product_photos: ['https://img.example-cdn.com/champion/hoodie-black-1.jpg'],
  product_page_url: 'https://www.google.com/shopping/product/111',
  product_attributes: { Brand: 'Champion' },
  offer: {
    store_name: 'Nordstrom',
    price: '$68.00',
    offer_page_url: 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321'
  }
}, over);

/* A product with no inline offer: it forces an offers lookup, which is
   how the per-search call cap gets exercised. */
const needsLookup = (id) => ({
  product_id: id,
  product_title: `Hoodie ${id}`,
  product_photos: [`https://img.example-cdn.com/${id}.jpg`],
  product_page_url: 'https://www.google.com/shopping/product/' + id,
  product_attributes: { Brand: 'Champion' }
});

const envelope = (products) => ({ status: 'OK', request_id: 'r', data: products });
const offersPayload = (offers) => ({ status: 'OK', request_id: 'ro', data: offers });

function providerStub(searchPayload, offersById) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/product-offers')) {
      const id = new URL(String(url)).searchParams.get('product_id');
      return okResponse(offersPayload((offersById || {})[id] || []));
    }
    return okResponse(searchPayload);
  };
  impl.calls = calls;
  return impl;
}

/* OpenAI, answering with a usage block the way the real API does. */
const openaiStub = (totalTokens, content) => async () => okResponse({
  choices: [{ message: { content: content || '{"categories":["hoodie"]}' } }],
  usage: { prompt_tokens: Math.round((totalTokens || 900) * 0.8), completion_tokens: Math.round((totalTokens || 900) * 0.2), total_tokens: totalTokens || 900 }
});

const intent = { categories: ['hoodie'], colors: ['Black'], keywords: ['hoodie'] };

/* One request from one shopper. `who` sets the address (anonymous) or a
   bearer token (authenticated). */
function request(who, over) {
  const headers = {};
  if (who && who.token) headers.authorization = `Bearer ${who.token}`;
  if (who && who.ip) headers['x-real-ip'] = who.ip;
  if (who && who.key) headers['idempotency-key'] = who.key;
  return Object.assign({ method: 'POST', headers, body: { intent, limit: 12 }, on: () => {} }, over || {});
}

const callSearch = (who, stub, over) => {
  const res = fakeRes();
  return withStubbedFetch(stub || providerStub(envelope([sellableProduct()])),
    () => searchHandler(request(who, over), res)).then(() => res);
};

const callInterpret = (who, stub, over) => {
  const res = fakeRes();
  const req = request(who, Object.assign({ body: { query: 'a black hoodie', vocabulary: {} } }, over || {}));
  return withStubbedFetch(stub || openaiStub(900), () => interpretHandler(req, res)).then(() => res);
};

const callUsage = (who) => {
  const res = fakeRes();
  return Promise.resolve(usageHandler(request(who, { method: 'GET' }), res)).then(() => res);
};

const tokenFor = (sub, plan) => accounts.issueToken({ sub, plan });
const anon = (ip) => ({ id: `anon:${accounts.addressDigest(ip)}`, plan: 'free', authenticated: false });
const user = (sub, plan) => ({ id: `user:${sub}`, plan, authenticated: true });

/* Everything below is awaited, so it runs inside one async body — the
   same shape scripts/test-pipeline.js uses. */
(async () => {

/* ---------------------------------------------------------
   1. Plan configuration
   --------------------------------------------------------- */

console.log('\nplan configuration');

await test('the three plans carry exactly the advertised prices and allowances', () => {
  assert.strictEqual(plans.PLANS.free.priceUsd, 0);
  assert.deepStrictEqual(plans.PLANS.free.limits, { tokens: 20000, searches: 3 });
  assert.strictEqual(plans.PLANS.free.period, 'day');

  assert.strictEqual(plans.PLANS.pro.priceUsd, 14.99);
  assert.deepStrictEqual(plans.PLANS.pro.limits, { tokens: 1000000, searches: 75 });
  assert.strictEqual(plans.PLANS.pro.period, 'month');

  assert.strictEqual(plans.PLANS.max.priceUsd, 79.99);
  assert.deepStrictEqual(plans.PLANS.max.limits, { tokens: 5000000, searches: 400 });
  assert.strictEqual(plans.PLANS.max.period, 'month');
});

await test('no plan is described as unlimited', () => {
  const words = JSON.stringify(plans.publicPlans()).toLowerCase();
  assert.ok(!words.includes('unlimited'), 'a ceiling exists, so it is always named');
  plans.PLAN_IDS.forEach((id) => {
    assert.ok(Number.isFinite(plans.PLANS[id].limits.tokens));
    assert.ok(Number.isFinite(plans.PLANS[id].limits.searches));
  });
});

await test('an unknown plan falls back to Free, never to something generous', () => {
  assert.strictEqual(plans.planOf('enterprise').id, 'free');
  assert.strictEqual(plans.planOf(null).id, 'free');
  assert.strictEqual(plans.planOf('MAX').id, 'max', 'a known id is still case-insensitive');
});

/* ---------------------------------------------------------
   2. Live search limits
   --------------------------------------------------------- */

console.log('\nlive search limits');

await test('Free allows exactly 3 live searches, then refuses', async () => {
  const who = { ip: '203.0.113.1' };
  for (let i = 1; i <= 3; i += 1) {
    const res = await callSearch(who);
    assert.strictEqual(res.statusCode, 200, `search ${i} should succeed`);
    assert.strictEqual(res.body.usage.meters.searches.used, i);
  }
  const refused = await callSearch(who);
  assert.strictEqual(refused.statusCode, 429);
  assert.strictEqual(refused.body.limitType, 'searches');
});

await test('Pro allows 75 and Max allows 400, counted per month', async () => {
  for (const [plan, limit] of [['pro', 75], ['max', 400]]) {
    resetStore();
    const account = user(`u_${plan}`, plan);
    for (let i = 0; i < limit; i += 1) {
      /* eslint-disable-next-line no-await-in-loop */
      const r = await usage.reserve(account, 'searches', 1);
      assert.ok(r.ok, `${plan} search ${i + 1} of ${limit} should be allowed`);
    }
    /* eslint-disable-next-line no-await-in-loop */
    const over = await usage.reserve(account, 'searches', 1);
    assert.ok(!over.ok, `${plan} must refuse search ${limit + 1}`);
    assert.strictEqual(over.limit.limit, limit);
    assert.strictEqual(over.limit.period, 'month');
  }
});

await test('the two meters are independent: spent searches do not block tokens', async () => {
  const account = anon('203.0.113.2');
  for (let i = 0; i < 3; i += 1) await usage.reserve(account, 'searches', 1);
  const blocked = await usage.reserve(account, 'searches', 1);
  assert.ok(!blocked.ok);

  const tokens = await usage.reserve(account, 'tokens', 500);
  assert.ok(tokens.ok, 'the token allowance is untouched by search usage');
  const snap = await usage.snapshot(account);
  assert.strictEqual(snap.meters.searches.used, 3);
  assert.strictEqual(snap.meters.tokens.used, 500);
});

/* ---------------------------------------------------------
   3. AI token limits
   --------------------------------------------------------- */

console.log('\nAI token limits');

await test('a Free account is cut off at 20,000 tokens', async () => {
  const account = anon('203.0.113.3');
  const first = await usage.reserve(account, 'tokens', 19000);
  assert.ok(first.ok);
  const second = await usage.reserve(account, 'tokens', 1500);
  assert.ok(!second.ok, '19,000 + 1,500 is over 20,000');
  assert.strictEqual(second.limit.limitType, 'tokens');
  assert.strictEqual(second.limit.limit, 20000);
  assert.strictEqual(second.limit.usage, 19000, 'the refused amount is not counted');
});

await test('the interpreter charges the tokens OpenAI reports, not the reservation', async () => {
  const who = { ip: '203.0.113.4' };
  const res = await callInterpret(who, openaiStub(1234));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.usage.meters.tokens.used, 1234,
    'the reservation is an estimate; the settled figure is the truth');
});

await test('the reservation is large enough to block a call an account cannot afford', async () => {
  const account = anon('203.0.113.5');
  /* leave less headroom than one call could possibly cost */
  await usage.reserve(account, 'tokens', 19900);
  const res = await callInterpret({ ip: '203.0.113.5' }, openaiStub(1500));
  assert.strictEqual(res.statusCode, 429, 'the call must be refused BEFORE it is made');
  assert.strictEqual(res.body.limitType, 'tokens');
});

await test('a response with no usage block is charged the full reservation, not zero', async () => {
  const who = { ip: '203.0.113.6' };
  const stub = async () => okResponse({ choices: [{ message: { content: '{}' } }] });
  const res = await callInterpret(who, stub);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.usage.meters.tokens.used >= 2000,
    `an unmeasurable call is charged, not waved through (got ${res.body.usage.meters.tokens.used})`);
});

/* ---------------------------------------------------------
   4. Per-search API-call safety caps
   --------------------------------------------------------- */

console.log('\nper-search API-call safety caps');

await test('a call budget refuses past its ceiling and cannot be disabled', () => {
  const b = createCallBudget(3);
  assert.ok(b.take() && b.take() && b.take());
  assert.strictEqual(b.take(), false, 'the fourth call is refused');
  assert.deepStrictEqual(b.report(), { max: 3, used: 3, refused: 1, exhausted: true });

  process.env.MAX_UPSTREAM_CALLS_PER_SEARCH = '99999';
  assert.ok(createCallBudget().max <= 40, 'configuration may tighten the cap, never remove it');
  process.env.MAX_UPSTREAM_CALLS_PER_SEARCH = '0';
  assert.ok(createCallBudget().max >= 1, 'a nonsense value falls back to the default, not to zero');
  delete process.env.MAX_UPSTREAM_CALLS_PER_SEARCH;
});

await test('one search cannot make unbounded provider calls', async () => {
  process.env.MAX_UPSTREAM_CALLS_PER_SEARCH = '5';
  /* 24 products, none with an inline offer: without a cap this is 1
     search call plus 24 offer lookups, every one of them billed */
  const many = Array.from({ length: 24 }, (_, i) => needsLookup(`x${i}`));
  const stub = providerStub(envelope(many), {});
  const res = await callSearch({ ip: '203.0.113.7' }, stub, { body: { intent, limit: 24 } });

  assert.strictEqual(res.statusCode, 200);
  assert.ok(stub.calls.length <= 5, `made ${stub.calls.length} upstream calls, cap was 5`);
  assert.strictEqual(res.body.upstreamCalls.max, 5);
  assert.ok(res.body.upstreamCalls.exhausted, 'the response says the cap was reached');
  delete process.env.MAX_UPSTREAM_CALLS_PER_SEARCH;
});

await test('reaching the cap returns fewer results rather than failing the search', async () => {
  process.env.MAX_UPSTREAM_CALLS_PER_SEARCH = '2';
  const many = Array.from({ length: 12 }, (_, i) => needsLookup(`y${i}`));
  const stub = providerStub(envelope(many), {});
  const res = await callSearch({ ip: '203.0.113.8' }, stub, { body: { intent, limit: 12 } });
  assert.strictEqual(res.statusCode, 200, 'a capped search still answers');
  assert.ok(Array.isArray(res.body.products));
  delete process.env.MAX_UPSTREAM_CALLS_PER_SEARCH;
});

await test('the interpreter caps one call in tokens and in prompt size', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'api', 'interpret.js'), 'utf8');
  assert.ok(/max_completion_tokens:\s*MAX_COMPLETION_TOKENS/.test(source), 'the completion is capped');
  assert.ok(/MAX_VOCABULARY_CHARS/.test(source), 'the prompt cannot grow with the catalogue');
  assert.ok(/vocabularyText/.test(source), 'the capped text is what is actually sent');
});

/* ---------------------------------------------------------
   5. Failed API requests
   --------------------------------------------------------- */

console.log('\nfailed API requests');

await test('a provider outage does not consume a live search', async () => {
  const who = { ip: '203.0.113.9' };
  const failing = async () => { throw new Error('provider is down'); };
  const res = await callSearch(who, failing);

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.charged, false);
  assert.strictEqual(res.body.usage.meters.searches.used, 0, 'the allowance was handed back');

  /* and the shopper still has all three */
  const after = await callUsage(who);
  assert.strictEqual(after.body.usage.meters.searches.remaining, 3);
});

await test('an outage mid-way still leaves the full allowance for a retry', async () => {
  const who = { ip: '203.0.113.10' };
  await callSearch(who);
  await callSearch(who, async () => { throw new Error('down'); });
  const snap = await callUsage(who);
  assert.strictEqual(snap.body.usage.meters.searches.used, 1, 'only the search that ran is charged');
});

await test('an OpenAI failure refunds the whole token reservation', async () => {
  const who = { ip: '203.0.113.11' };
  const failing = async () => ({ ok: false, status: 500, text: async () => 'upstream error', json: async () => ({}) });
  const res = await callInterpret(who, failing);
  assert.strictEqual(res.statusCode, 502);
  const snap = await callUsage(who);
  assert.strictEqual(snap.body.usage.meters.tokens.used, 0, 'nothing was generated, so nothing is owed');
});

await test('a search that verifies nothing is still charged: the call was billed upstream', async () => {
  const who = { ip: '203.0.113.12' };
  const stub = providerStub(envelope([]), {});
  const res = await callSearch(who, stub);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.products.length, 0);
  assert.strictEqual(res.body.usage.meters.searches.used, 1,
    'an empty result is not a free one — the provider ran and charged for it');
});

/* ---------------------------------------------------------
   6. Concurrent requests
   --------------------------------------------------------- */

console.log('\nconcurrent requests');

await test('ten simultaneous searches on Free yield exactly three', async () => {
  const who = { ip: '203.0.113.20' };
  const results = await Promise.all(Array.from({ length: 10 }, () => callSearch(who)));
  const ok = results.filter((r) => r.statusCode === 200);
  const refused = results.filter((r) => r.statusCode === 429);
  assert.strictEqual(ok.length, 3, `expected 3 to succeed, got ${ok.length}`);
  assert.strictEqual(refused.length, 7);

  const snap = await callUsage(who);
  assert.strictEqual(snap.body.usage.meters.searches.used, 3, 'the counter never overshot');
});

await test('a refused concurrent request leaves nothing behind on the counter', async () => {
  const account = anon('203.0.113.21');
  await Promise.all(Array.from({ length: 25 }, () => usage.reserve(account, 'searches', 1)));
  const snap = await usage.snapshot(account);
  assert.strictEqual(snap.meters.searches.used, 3, 'twenty-two refusals all handed their slot back');
});

await test('concurrency holds on a large monthly allowance too', async () => {
  const account = user('u_conc', 'pro');
  const results = await Promise.all(Array.from({ length: 100 }, () => usage.reserve(account, 'searches', 1)));
  assert.strictEqual(results.filter((r) => r.ok).length, 75);
  assert.strictEqual((await usage.snapshot(account)).meters.searches.used, 75);
});

/* ---------------------------------------------------------
   7. Duplicate submissions
   --------------------------------------------------------- */

console.log('\nduplicate submissions');

await test('the same submission key twice costs one search, not two', async () => {
  const who = { ip: '203.0.113.30', key: 'submission-abc-123' };
  const first = await callSearch(who);
  assert.strictEqual(first.statusCode, 200);
  assert.strictEqual(first.body.usage.meters.searches.used, 1);

  const repeat = await callSearch(who);
  assert.strictEqual(repeat.statusCode, 200);
  assert.strictEqual(repeat.body.duplicate, true);
  assert.strictEqual(repeat.body.usage.meters.searches.used, 1, 'the retry was not charged');
  assert.deepStrictEqual(repeat.body.products, first.body.products, 'and it got the same answer');
});

await test('a genuine second search with a new key IS charged', async () => {
  const ip = '203.0.113.31';
  await callSearch({ ip, key: 'key-one-aaaa' });
  const second = await callSearch({ ip, key: 'key-two-bbbb' });
  assert.strictEqual(second.body.usage.meters.searches.used, 2);
});

await test('a double-click that overlaps is refused rather than run twice', async () => {
  const who = { ip: '203.0.113.32', key: 'overlapping-click-1' };
  /* a provider that never settles until we let it: both requests are in
     flight at the same moment, which is what a double-click produces */
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async (url) => { await gate; return providerStub(envelope([sellableProduct()]))(url); };

  const a = callSearch(who, slow);
  const b = callSearch(who, slow);
  /* let the second reach the claim before the first finishes */
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [first, second] = await Promise.all([a, b]);

  const codes = [first.statusCode, second.statusCode].sort();
  assert.deepStrictEqual(codes, [200, 409], `expected one to run and one to be told it is already running, got ${codes}`);
  const conflicted = first.statusCode === 409 ? first : second;
  assert.strictEqual(conflicted.body.code, 'duplicate_in_flight');

  const snap = await callUsage(who);
  assert.strictEqual(snap.body.usage.meters.searches.used, 1, 'a double-click buys one search');
});

await test('a failed submission releases its key so a retry is a real attempt', async () => {
  const who = { ip: '203.0.113.33', key: 'retry-after-failure-1' };
  const failed = await callSearch(who, async () => { throw new Error('down'); });
  assert.strictEqual(failed.statusCode, 502);

  const retry = await callSearch(who);
  assert.strictEqual(retry.statusCode, 200, 'the retry must run, not replay the failure');
  assert.ok(!retry.body.duplicate);
  assert.strictEqual(retry.body.usage.meters.searches.used, 1);
});

await test('one account cannot replay or collide with another account key', async () => {
  const key = 'shared-key-value-1';
  const mine = await callSearch({ ip: '203.0.113.34', key });
  const theirs = await callSearch({ ip: '203.0.113.35', key });
  assert.strictEqual(mine.statusCode, 200);
  assert.strictEqual(theirs.statusCode, 200, "another account's key is not mine");
  assert.ok(!theirs.body.duplicate);
});

await test('a key too short or malformed simply gets no deduplication', async () => {
  assert.strictEqual(usage.validIdempotencyKey('short'), false);
  assert.strictEqual(usage.validIdempotencyKey('a'.repeat(200)), false);
  assert.strictEqual(usage.validIdempotencyKey('has spaces here'), false);
  assert.strictEqual(usage.validIdempotencyKey('perfectly-fine_key.1'), true);

  const claim = await usage.claimSubmission(anon('1.1.1.1'), 'bad');
  assert.strictEqual(claim.state, 'unkeyed', 'a bad key is ignored, not refused');
});

/* ---------------------------------------------------------
   8. Daily and monthly resets
   --------------------------------------------------------- */

console.log('\nresets');

await test('Free resets daily: a spent allowance is whole again the next day', async () => {
  const account = anon('203.0.113.40');
  const day1 = new Date('2026-08-23T18:00:00Z');
  for (let i = 0; i < 3; i += 1) await usage.reserve(account, 'searches', 1, { now: day1 });
  const blocked = await usage.reserve(account, 'searches', 1, { now: day1 });
  assert.ok(!blocked.ok);

  /* one minute past midnight UTC */
  const day2 = new Date('2026-08-24T00:01:00Z');
  const fresh = await usage.reserve(account, 'searches', 1, { now: day2 });
  assert.ok(fresh.ok, 'the new day starts at zero');
  assert.strictEqual((await usage.snapshot(account, { now: day2 })).meters.searches.used, 1);
  assert.strictEqual((await usage.snapshot(account, { now: day1 })).meters.searches.used, 3,
    "and yesterday's record is untouched, not overwritten");
});

await test('Free does NOT reset partway through a day', async () => {
  const account = anon('203.0.113.41');
  const morning = new Date('2026-08-23T00:30:00Z');
  const night = new Date('2026-08-23T23:30:00Z');
  for (let i = 0; i < 3; i += 1) await usage.reserve(account, 'searches', 1, { now: morning });
  const late = await usage.reserve(account, 'searches', 1, { now: night });
  assert.ok(!late.ok, 'same UTC day, same allowance');
});

await test('Pro resets monthly, not daily', async () => {
  const account = user('u_pro_reset', 'pro');
  const early = new Date('2026-08-02T10:00:00Z');
  for (let i = 0; i < 75; i += 1) await usage.reserve(account, 'searches', 1, { now: early });

  const nextDay = new Date('2026-08-03T10:00:00Z');
  assert.ok(!(await usage.reserve(account, 'searches', 1, { now: nextDay })).ok,
    'a new day must not refill a monthly plan');

  const lastDay = new Date('2026-08-31T23:59:00Z');
  assert.ok(!(await usage.reserve(account, 'searches', 1, { now: lastDay })).ok);

  const nextMonth = new Date('2026-09-01T00:00:01Z');
  assert.ok((await usage.reserve(account, 'searches', 1, { now: nextMonth })).ok, 'September starts at zero');
});

await test('Max resets monthly across a year boundary', async () => {
  const account = user('u_max_reset', 'max');
  const december = new Date('2026-12-20T12:00:00Z');
  for (let i = 0; i < 400; i += 1) await usage.reserve(account, 'searches', 1, { now: december });
  assert.ok(!(await usage.reserve(account, 'searches', 1, { now: december })).ok);

  const january = new Date('2027-01-01T00:00:30Z');
  const fresh = await usage.reserve(account, 'searches', 1, { now: january });
  assert.ok(fresh.ok, 'the new year is a new month');
  assert.strictEqual((await usage.snapshot(account, { now: january })).meters.searches.used, 1);
});

await test('the token meter resets on the same schedule as the plan', async () => {
  const free = anon('203.0.113.42');
  const d1 = new Date('2026-08-23T09:00:00Z');
  await usage.reserve(free, 'tokens', 20000, { now: d1 });
  assert.ok(!(await usage.reserve(free, 'tokens', 1, { now: d1 })).ok);
  assert.ok((await usage.reserve(free, 'tokens', 1, { now: new Date('2026-08-24T09:00:00Z') })).ok);

  const pro = user('u_pro_tokens', 'pro');
  const m1 = new Date('2026-08-10T09:00:00Z');
  await usage.reserve(pro, 'tokens', 1000000, { now: m1 });
  assert.ok(!(await usage.reserve(pro, 'tokens', 1, { now: new Date('2026-08-25T09:00:00Z') })).ok,
    'still August');
  assert.ok((await usage.reserve(pro, 'tokens', 1, { now: new Date('2026-09-01T00:00:01Z') })).ok);
});

/* ---------------------------------------------------------
   9. Reset timestamps
   --------------------------------------------------------- */

console.log('\nreset timestamps');

await test('a daily reset timestamp is the next UTC midnight', () => {
  assert.strictEqual(plans.resetAt('day', new Date('2026-08-23T13:45:00Z')), '2026-08-24T00:00:00.000Z');
  assert.strictEqual(plans.resetAt('day', new Date('2026-08-23T00:00:00Z')), '2026-08-24T00:00:00.000Z');
  assert.strictEqual(plans.resetAt('day', new Date('2026-12-31T23:59:59Z')), '2027-01-01T00:00:00.000Z');
});

await test('a monthly reset timestamp is the first of the next month, UTC', () => {
  assert.strictEqual(plans.resetAt('month', new Date('2026-08-23T13:45:00Z')), '2026-09-01T00:00:00.000Z');
  assert.strictEqual(plans.resetAt('month', new Date('2026-12-05T00:00:00Z')), '2027-01-01T00:00:00.000Z');
  assert.strictEqual(plans.resetAt('month', new Date('2028-02-11T00:00:00Z')), '2028-03-01T00:00:00.000Z',
    'a leap February still ends on the first of March');
});

await test('a refusal carries every field the interface needs to explain it', async () => {
  const who = { ip: '203.0.113.50' };
  for (let i = 0; i < 3; i += 1) await callSearch(who);
  const res = await callSearch(who);

  assert.strictEqual(res.statusCode, 429);
  const b = res.body;
  assert.strictEqual(b.error, 'usage_limit_reached');
  assert.strictEqual(b.limitType, 'searches');
  assert.strictEqual(b.usage, 3);
  assert.strictEqual(b.limit, 3);
  assert.strictEqual(b.remaining, 0);
  assert.strictEqual(b.plan, 'free');
  assert.strictEqual(b.planName, 'Free');
  assert.ok(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(b.resetAt), b.resetAt);
  assert.ok(b.resetInSeconds > 0 && b.resetInSeconds <= 86400);
});

await test('the reset timestamp is in the future and matches the countdown', async () => {
  const who = { ip: '203.0.113.51' };
  for (let i = 0; i < 3; i += 1) await callSearch(who);
  const res = await callSearch(who);
  const gap = Date.parse(res.body.resetAt) - Date.now();
  assert.ok(gap > 0, 'a reset that already happened would never unblock anyone');
  assert.ok(Math.abs(gap / 1000 - res.body.resetInSeconds) < 5, 'the two agree');
});

/* ---------------------------------------------------------
   10. Unauthorized usage attempts
   --------------------------------------------------------- */

console.log('\nunauthorized usage attempts');

await test('a forged token is refused, not quietly downgraded to Free', async () => {
  const res = await callSearch({ token: 'fw1.eyJzdWIiOiJhIiwicGxhbiI6Im1heCJ9.bm90YXNpZ25hdHVyZQ' });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.body.code, 'unauthorized');
});

await test('a token cannot be edited to grant a better plan', async () => {
  const real = tokenFor('u_edit', 'free');
  const [prefix, payload, sig] = real.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'u_edit', plan: 'max', exp: 4102444800 })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await callSearch({ token: `${prefix}.${forged}.${sig}` });
  assert.strictEqual(res.statusCode, 401, 'the signature no longer matches the payload');
});

await test('an expired token is refused', async () => {
  const stale = accounts.issueToken({ sub: 'u_old', plan: 'pro' }, { ttlSeconds: -1 });
  const res = await callSearch({ token: stale });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(accounts.verifyToken(stale).reason, 'expired');
});

await test('a token signed with another secret is refused', async () => {
  const token = tokenFor('u_other', 'max');
  process.env.SESSION_SECRET = 'a-different-secret';
  const res = await callSearch({ token });
  process.env.SESSION_SECRET = 'usage-test-secret';
  assert.strictEqual(res.statusCode, 401);
});

await test('a refused credential spends nothing', async () => {
  const res = await callSearch({ token: 'fw1.aaaa.bbbb' });
  assert.strictEqual(res.statusCode, 401);
  const store = getStore();
  assert.strictEqual(store._size(), 0, 'a rejected caller never reached the store');
});

await test('the plan cannot be set from the request body or a header', async () => {
  const who = { ip: '203.0.113.60' };
  const res = await callSearch(who, undefined, {
    body: { intent, limit: 12, plan: 'max', usage: { meters: { searches: { used: 0, limit: 9999 } } } },
    headers: { 'x-real-ip': '203.0.113.60', 'x-plan': 'max' }
  });
  assert.strictEqual(res.body.usage.plan, 'free', 'the plan comes from the credential, never from the caller');
  assert.strictEqual(res.body.usage.meters.searches.limit, 3);
});

await test('a client-supplied usage figure is ignored entirely', async () => {
  const who = { ip: '203.0.113.61' };
  for (let i = 0; i < 3; i += 1) await callSearch(who);
  const res = await callSearch(who, undefined, {
    body: { intent, limit: 12, usage: { meters: { searches: { used: 0 } } } },
    headers: { 'x-real-ip': '203.0.113.61' }
  });
  assert.strictEqual(res.statusCode, 429, 'the server counts, the browser does not');
});

await test('the usage endpoint will not report another account', async () => {
  const mine = { ip: '203.0.113.62' };
  await callSearch(mine);
  const res = await callUsage({ ip: '203.0.113.63' });
  assert.strictEqual(res.body.usage.meters.searches.used, 0,
    'usage is read from the caller credential, and there is no parameter to ask for anyone else');
});

/* ---------------------------------------------------------
   11. Plan switching
   --------------------------------------------------------- */

console.log('\nplan switching');

await test('upgrading raises the ceiling immediately', async () => {
  const free = user('u_switch', 'free');
  for (let i = 0; i < 3; i += 1) await usage.reserve(free, 'searches', 1);
  assert.ok(!(await usage.reserve(free, 'searches', 1)).ok);

  const upgraded = user('u_switch', 'pro');
  assert.ok((await usage.reserve(upgraded, 'searches', 1)).ok, 'Pro is not blocked by a Free limit');
  const snap = await usage.snapshot(upgraded);
  assert.strictEqual(snap.plan, 'pro');
  assert.strictEqual(snap.meters.searches.limit, 75);
});

await test('an upgrade takes effect through the token, not through a request field', async () => {
  const sub = 'u_upgrade_token';
  const freeToken = tokenFor(sub, 'free');
  const proToken = tokenFor(sub, 'pro');

  for (let i = 0; i < 3; i += 1) await callSearch({ token: freeToken });
  const blocked = await callSearch({ token: freeToken });
  assert.strictEqual(blocked.statusCode, 429);

  const after = await callSearch({ token: proToken });
  assert.strictEqual(after.statusCode, 200);
  assert.strictEqual(after.body.usage.plan, 'pro');
  assert.strictEqual(after.body.usage.meters.searches.limit, 75);
});

await test('daily and monthly usage are held separately, so a switch is not a reset', async () => {
  const sub = 'u_period_switch';
  const pro = user(sub, 'pro');
  for (let i = 0; i < 10; i += 1) await usage.reserve(pro, 'searches', 1);
  assert.strictEqual((await usage.snapshot(pro)).meters.searches.used, 10);

  /* a downgrade moves to the daily window and its own counter */
  const free = user(sub, 'free');
  assert.strictEqual((await usage.snapshot(free)).meters.searches.used, 0);

  /* and going back finds the monthly total still there, not lost */
  assert.strictEqual((await usage.snapshot(pro)).meters.searches.used, 10,
    'the monthly record survived the round trip');
});

await test('a downgrade is enforced at the lower ceiling straight away', async () => {
  const sub = 'u_downgrade';
  const max = user(sub, 'max');
  await usage.reserve(max, 'searches', 1);

  const free = user(sub, 'free');
  for (let i = 0; i < 3; i += 1) await usage.reserve(free, 'searches', 1);
  const over = await usage.reserve(free, 'searches', 1);
  assert.ok(!over.ok, 'the Free ceiling applies from the moment the plan does');
  assert.strictEqual(over.limit.plan, 'free');
  assert.strictEqual(over.limit.limit, 3);
});

/* ---------------------------------------------------------
   12. Frontend / backend usage consistency
   --------------------------------------------------------- */

console.log('\nfrontend and backend agree');

await test('the meter on a search reply matches the usage endpoint exactly', async () => {
  const who = { ip: '203.0.113.70' };
  const search = await callSearch(who);
  const meter = await callUsage(who);
  assert.deepStrictEqual(search.body.usage.meters, meter.body.usage.meters);
  assert.strictEqual(search.body.usage.plan, meter.body.usage.plan);
  assert.strictEqual(search.body.usage.resetAt, meter.body.usage.resetAt);
});

await test('the interpreter reply carries the same meters as the usage endpoint', async () => {
  const who = { ip: '203.0.113.71' };
  const interpreted = await callInterpret(who, openaiStub(1500));
  const meter = await callUsage(who);
  assert.deepStrictEqual(interpreted.body.usage.meters, meter.body.usage.meters);
});

await test('the client renders exactly the phrasing the plans specify', async () => {
  const free = (await callUsage({ ip: '203.0.113.72' })).body.usage;
  free.meters.searches.used = 3;
  assert.strictEqual(Meter.searchLine(free), '3 / 3 searches used today');
  free.meters.tokens.used = 7420;
  assert.strictEqual(Meter.tokenLine(free), '7,420 / 20,000 AI tokens');

  const pro = await usage.snapshot(user('u_copy_pro', 'pro'));
  pro.meters.searches.used = 42;
  assert.strictEqual(Meter.searchLine(pro), '42 / 75 searches used this month');

  const max = await usage.snapshot(user('u_copy_max', 'max'));
  max.meters.searches.used = 215;
  assert.strictEqual(Meter.searchLine(max), '215 / 400 searches used this month');
});

await test('the client never invents a number the server did not send', () => {
  assert.strictEqual(Meter.searchLine(null), '');
  assert.strictEqual(Meter.tokenLine({}), '');
  assert.strictEqual(Meter.resetPhrase({}), '');
  assert.strictEqual(Meter.snapshot(), null, 'nothing is assumed before the first reply');
});

await test('the meter bar never overflows its own number', () => {
  assert.strictEqual(Meter.fraction({ used: 5, limit: 3 }), 1);
  assert.strictEqual(Meter.fraction({ used: 0, limit: 3 }), 0);
  assert.strictEqual(Meter.fraction({ used: 42, limit: 75 }), 42 / 75);
  assert.strictEqual(Meter.fraction({ used: 1, limit: 0 }), 0, 'no limit, no bar');
});

await test('a limit reply is enough on its own to write the message shown', async () => {
  const who = { ip: '203.0.113.73' };
  for (let i = 0; i < 3; i += 1) await callSearch(who);
  const refused = await callSearch(who);
  const message = Meter.limitMessage(refused.body);
  assert.ok(/all 3 live searches/.test(message), message);
  assert.ok(/daily Free allowance/.test(message), message);
  assert.ok(/Resets in/.test(message), message);
});

/* ---------------------------------------------------------
   13. Nothing sensitive escapes
   --------------------------------------------------------- */

console.log('\nnothing sensitive reaches the browser');

await test('no reply carries a key, a token or an address', async () => {
  const who = { ip: '203.0.113.80' };
  const bodies = [
    (await callSearch(who)).body,
    (await callInterpret(who, openaiStub(800))).body,
    (await callUsage(who)).body
  ];
  bodies.forEach((body) => {
    const text = JSON.stringify(body);
    assert.ok(!text.includes('test-openai-key'), 'the OpenAI key');
    assert.ok(!text.includes('test-key'), 'the provider key');
    assert.ok(!text.includes('usage-test-secret'), 'the session secret');
    assert.ok(!text.includes('203.0.113.80'), 'the raw address');
    assert.ok(!/sk-[A-Za-z0-9]/.test(text), 'anything key-shaped');
  });
});

await test('an anonymous account id is a digest, never the address itself', () => {
  const id = accounts.resolveAccount({ headers: { 'x-real-ip': '198.51.100.77' } }).account.id;
  assert.ok(id.startsWith('anon:'));
  assert.ok(!id.includes('198.51.100.77'));
  assert.ok(id.length < 40);
});

await test('the plan table published to the browser carries no billing detail', () => {
  const text = JSON.stringify(plans.publicPlans()).toLowerCase();
  ['secret', 'key', 'customer', 'stripe', 'card', 'invoice'].forEach((word) => {
    assert.ok(!text.includes(word), `"${word}" must not appear in the public plan table`);
  });
});

/* ---------------------------------------------------------
   14. The store contract the whole thing rests on
   --------------------------------------------------------- */

console.log('\nstore contract');

await test('increments are atomic: concurrent callers get distinct values', async () => {
  const store = createMemoryStore();
  const values = await Promise.all(Array.from({ length: 50 }, () => store.incrBy('k', 1, 60)));
  assert.strictEqual(new Set(values).size, 50, 'no two callers may be told the same number');
  assert.strictEqual(Math.max(...values), 50);
});

await test('a claim is won by exactly one caller', async () => {
  const store = createMemoryStore();
  const results = await Promise.all(Array.from({ length: 20 }, () => store.claim('c', 'v', 60)));
  assert.strictEqual(results.filter(Boolean).length, 1);
});

await test('a counter expires so a stale period cannot be read back', async () => {
  const store = createMemoryStore();
  await store.incrBy('short', 5, 0.05);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(await store.get('short'), 0);
});

await test('the TTL outlives the window it governs', () => {
  const now = new Date('2026-08-23T23:59:00Z');
  assert.ok(plans.counterTtl('day', now) > plans.secondsUntilReset('day', now));
  assert.ok(plans.counterTtl('month', now) > plans.secondsUntilReset('month', now));
});

await test('production selects Redis when it is configured', () => {
  const { storeKind } = require('../api/_store');
  delete process.env.USAGE_STORE;
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  assert.strictEqual(storeKind(), 'redis');
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.strictEqual(storeKind(), 'memory', 'and falls back only when it is not');
  process.env.USAGE_STORE = 'memory';
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
