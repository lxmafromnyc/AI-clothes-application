#!/usr/bin/env node
/* =========================================================
   Fynd — payments and subscriptions test

   Drives the real endpoints — /api/auth, /api/account, /api/checkout,
   /api/portal, /api/stripe-webhook, /api/search — with Stripe's HTTP
   API stubbed at the fetch boundary and the store on its memory driver.
   Nothing here talks to Stripe, so it runs offline with no key, no
   account and no network:

     node scripts/test-stripe.js

   What it is actually asserting, in one sentence: a plan can only be
   raised by a signed Stripe event, and everything else that might look
   like it should raise one — a request body, a cookie, a success URL, a
   forged webhook, a replayed webhook — does not.

   Webhook payloads are signed here with node's own crypto rather than
   with the module that verifies them, so a bug that made both sides
   agree on the wrong scheme would still fail this file.
   ========================================================= */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

/* Configuration must exist before the endpoints are required: some of
   them read the environment at load time. Test keys only — the prefix
   is what puts the deployment in test mode. */
process.env.STRIPE_SECRET_KEY = 'sk_test_fynd_offline';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_offline_testing_secret';
process.env.STRIPE_PRICE_PRO = 'price_pro_test';
process.env.STRIPE_PRICE_MAX = 'price_max_test';
process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32';
process.env.OPENWEBNINJA_API_KEY = 'test-product-source-key';

const store = require('../api/_store');
const plans = require('../api/_plans');
const users = require('../api/_users');
const auth = require('../api/_auth');
const usage = require('../api/_usage');
const stripe = require('../api/_stripe');

const accountEndpoint = require('../api/account');
const authEndpoint = require('../api/auth');
const checkoutEndpoint = require('../api/checkout');
const portalEndpoint = require('../api/portal');
const webhookEndpoint = require('../api/stripe-webhook');
const searchEndpoint = require('../api/search');
const interpretEndpoint = require('../api/interpret');

let passed = 0;
const failures = [];

async function test(name, fn) {
  store.reset();
  stripeCalls.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err}`);
  }
}

/* ---------------------------------------------------------
   Stripe, stubbed at the fetch boundary
   ---------------------------------------------------------
   The adapter is exercised for real — the same form encoding, the same
   headers, the same parsing of the reply. Only the socket is missing. */

const stripeCalls = [];
const subscriptions = new Map();

/* /api/interpret is metered on the token usage OpenAI reports, so the
   model's reply is stubbed with a usage block the endpoint has to read
   rather than guess at. */
let openaiTokens = 0;
const openaiCalls = [];

const realFetch = global.fetch;

global.fetch = async (url, options) => {
  const href = String(url);

  if (href.startsWith('https://api.openai.com/')) {
    openaiCalls.push(href);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ categories: ['hoodie'], colors: ['Black'] }) } }],
        usage: { prompt_tokens: openaiTokens - 40, completion_tokens: 40, total_tokens: openaiTokens }
      })
    };
  }

  if (!href.startsWith('https://api.stripe.com/')) {
    /* nothing else in these tests is allowed to reach the network */
    throw new Error(`unexpected outbound request to ${href}`);
  }

  const method = (options && options.method) || 'GET';
  const body = (options && options.body) || '';
  const params = new URLSearchParams(body);
  stripeCalls.push({ href, method, params, headers: (options && options.headers) || {} });

  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload });

  if (href.endsWith('/v1/customers') && method === 'POST') {
    return reply({ id: `cus_${crypto.randomBytes(6).toString('hex')}`, email: params.get('email') });
  }
  if (href.endsWith('/v1/checkout/sessions') && method === 'POST') {
    return reply({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  }
  if (href.endsWith('/v1/billing_portal/sessions') && method === 'POST') {
    return reply({ id: 'bps_test_1', url: 'https://billing.stripe.com/p/session/test_1' });
  }
  if (href.includes('/v1/subscriptions/')) {
    const id = decodeURIComponent(href.split('/v1/subscriptions/')[1].split('?')[0]);
    const known = subscriptions.get(id);
    if (!known) return { ok: false, status: 404, json: async () => ({ error: { code: 'resource_missing' } }) };
    return reply(known);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: 'not stubbed' } }) };
};

/* A Stripe subscription object, in the shape the API returns. */
function stripeSubscription(over) {
  const sub = Object.assign({
    id: 'sub_test_1',
    object: 'subscription',
    customer: 'cus_test_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: 1893456000,
    metadata: {},
    items: { object: 'list', data: [{ id: 'si_1', price: { id: 'price_pro_test' } }] }
  }, over);
  subscriptions.set(sub.id, sub);
  return sub;
}

/* ---------------------------------------------------------
   Requests and responses
   --------------------------------------------------------- */

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    payload: null,
    ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[String(name).toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; this.ended = true; return this; },
    end() { this.ended = true; return this; }
  };
  return res;
}

function makeReq(over) {
  return Object.assign({
    method: 'POST',
    headers: { host: 'fynd.test' },
    socket: { remoteAddress: '203.0.113.9' },
    on() { return this; }
  }, over || {});
}

/* Carries cookies from one response into the next request, the way a
   browser does — the session is an HttpOnly cookie, so the tests have
   to hold one to be signed in at all. */
function cookiesFrom(res, existing) {
  const jar = Object.assign({}, existing || {});
  const set = res.getHeader('Set-Cookie');
  const list = Array.isArray(set) ? set : (set ? [set] : []);
  list.forEach((line) => {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (value === '') delete jar[name];
    else jar[name] = value;
  });
  return jar;
}

const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function callEndpoint(endpoint, { method, body, jar, headers }) {
  const res = makeRes();
  const req = makeReq({
    method: method || 'POST',
    body,
    headers: Object.assign(
      { host: 'fynd.test' },
      jar && Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {},
      headers || {}
    )
  });
  await endpoint(req, res);
  return { res, jar: cookiesFrom(res, jar) };
}

/* ---------------------------------------------------------
   Webhook deliveries, signed independently
   --------------------------------------------------------- */

let eventCounter = 0;

const stripeEvent = (type, object, over) => Object.assign({
  id: `evt_${++eventCounter}`,
  object: 'event',
  api_version: stripe.API_VERSION,
  created: Math.floor(Date.now() / 1000),
  type,
  data: { object }
}, over || {});

/* HMAC written out here on purpose: if _stripe.js ever signed and
   verified with the same wrong scheme, this file would still catch it. */
function signature(payload, timestamp, secret) {
  const mac = crypto.createHmac('sha256', secret || process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

async function deliver(event, options) {
  const opts = options || {};
  const payload = typeof opts.rawBody === 'string' ? opts.rawBody : JSON.stringify(event);
  const timestamp = opts.timestamp || Math.floor(Date.now() / 1000);
  /* an explicit header wins even when it is empty — "send nothing" is a
     case worth testing, and `||` would have quietly signed it properly */
  const header = Object.prototype.hasOwnProperty.call(opts, 'header')
    ? opts.header
    : signature(payload, timestamp, opts.secret);

  const res = makeRes();
  const req = makeReq({
    method: 'POST',
    body: Buffer.from(payload, 'utf8'),
    headers: { host: 'fynd.test', 'stripe-signature': header }
  });
  await webhookEndpoint(req, res);
  return res;
}

/* ---------------------------------------------------------
   Fixtures
   --------------------------------------------------------- */

const EMAIL = 'shopper@example.test';
const PASSWORD = 'a-long-enough-password';

/* Signs up, and returns the cookie jar plus the stored user. */
async function signedUpUser(email) {
  const { res, jar } = await callEndpoint(authEndpoint, {
    body: { action: 'signup', email: email || EMAIL, password: PASSWORD }
  });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.payload));
  const user = await users.byEmail(email || EMAIL);
  return { jar, user };
}

/* Everything a completed Pro checkout would leave behind, without
   going through Stripe: a customer id linked both ways. */
async function withCustomer(user, customerId) {
  return users.linkCustomer(user, customerId || 'cus_test_1');
}

const planOf = async (userId) => (await users.byId(userId)).plan;

(async () => {

  /* =========================================================
     1. The plan table
     ========================================================= */

  console.log('\nplans and entitlement');

  await test('the three plans carry the limits the pricing page promises', () => {
    assert.deepStrictEqual(plans.planOf('free').limits, { aiTokens: 20000, searches: 3 });
    assert.deepStrictEqual(plans.planOf('pro').limits, { aiTokens: 1000000, searches: 75 });
    assert.deepStrictEqual(plans.planOf('max').limits, { aiTokens: 5000000, searches: 400 });
    assert.strictEqual(plans.planOf('free').period, 'day');
    assert.strictEqual(plans.planOf('pro').period, 'month');
    assert.strictEqual(plans.planOf('max').period, 'month');
    assert.strictEqual(plans.planOf('pro').amount, 14.99);
    assert.strictEqual(plans.planOf('max').amount, 79.99);
  });

  await test('a price id maps to exactly one plan, and an unknown one to none', () => {
    assert.strictEqual(plans.planForPriceId('price_pro_test'), 'pro');
    assert.strictEqual(plans.planForPriceId('price_max_test'), 'max');
    assert.strictEqual(plans.planForPriceId('price_someone_elses'), null);
    assert.strictEqual(plans.planForPriceId(''), null);
  });

  await test('only active and trialing subscriptions entitle anything', () => {
    const at = (status) => plans.planFromSubscription({ status, priceId: 'price_pro_test' });
    assert.strictEqual(at('active'), 'pro');
    assert.strictEqual(at('trialing'), 'pro');
    ['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'canceled', 'nonsense'].forEach((status) => {
      assert.strictEqual(at(status), 'free', `${status} must not entitle a paid plan`);
    });
    assert.strictEqual(plans.planFromSubscription(null), 'free');
  });

  await test('an active subscription for a price this deployment does not sell entitles nothing', () => {
    assert.strictEqual(plans.planFromSubscription({ status: 'active', priceId: 'price_from_another_account' }), 'free');
  });

  await test('the plan catalogue sent to a browser carries no price ids', () => {
    const published = JSON.stringify(plans.publicPlans());
    assert.ok(!published.includes('price_pro_test'), published);
    assert.ok(!published.includes('price_max_test'), published);
    assert.ok(published.includes('"purchasable":true'));
  });

  /* =========================================================
     2. Signatures
     ========================================================= */

  console.log('\nwebhook signatures');

  await test('a correctly signed delivery is accepted', async () => {
    const res = await deliver(stripeEvent('customer.subscription.created', stripeSubscription()));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.received, true);
  });

  await test('an unsigned delivery is refused', async () => {
    const res = await deliver(stripeEvent('customer.subscription.created', stripeSubscription()), { header: '' });
    assert.strictEqual(res.statusCode, 400);
  });

  await test('a delivery signed with the wrong secret is refused', async () => {
    const res = await deliver(stripeEvent('customer.subscription.created', stripeSubscription()), { secret: 'whsec_not_ours' });
    assert.strictEqual(res.statusCode, 400);
  });

  await test('a body changed after signing is refused', async () => {
    const event = stripeEvent('customer.subscription.created', stripeSubscription());
    const honest = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signature(honest, timestamp);
    /* the attacker keeps the signature and edits the price */
    const tampered = honest.replace('price_pro_test', 'price_max_test');
    const res = await deliver(event, { rawBody: tampered, timestamp, header });
    assert.strictEqual(res.statusCode, 400);
  });

  await test('a valid delivery replayed long afterwards is refused', async () => {
    const event = stripeEvent('customer.subscription.created', stripeSubscription());
    const old = Math.floor(Date.now() / 1000) - (stripe.TOLERANCE_SECONDS + 60);
    const res = await deliver(event, { timestamp: old });
    assert.strictEqual(res.statusCode, 400);
  });

  await test('a header carrying two signatures — a secret rotation — is accepted on either', () => {
    const payload = JSON.stringify({ id: 'evt_rotate' });
    const timestamp = Math.floor(Date.now() / 1000);
    const ours = crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest('hex');
    const header = `t=${timestamp},v1=0000000000000000000000000000000000000000000000000000000000000000,v1=${ours}`;
    assert.deepStrictEqual(stripe.constructEvent(payload, header, process.env.STRIPE_WEBHOOK_SECRET), { id: 'evt_rotate' });
  });

  await test('a body that was parsed before the handler saw it is refused, and says why', async () => {
    const res = makeRes();
    const req = makeReq({
      method: 'POST',
      /* a plain object, as a host that parsed the JSON would leave it */
      body: { id: 'evt_parsed', type: 'customer.subscription.created', data: { object: {} } },
      headers: { host: 'fynd.test', 'stripe-signature': 't=1,v1=abc' }
    });
    await webhookEndpoint(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/raw body/i.test(res.payload.error), res.payload.error);
  });

  /* =========================================================
     3. Checkout
     ========================================================= */

  console.log('\nstarting a checkout');

  await test('a signed-out visitor cannot start a checkout', async () => {
    const { res } = await callEndpoint(checkoutEndpoint, { body: { plan: 'pro' } });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.payload.reason, 'sign-in-required');
    assert.ok(!stripeCalls.length, 'nothing may be created at Stripe for a caller with no account');
  });

  await test('a Pro checkout is created for the Pro price, in subscription mode', async () => {
    const { jar } = await signedUpUser();
    const { res } = await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'pro' } });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(/^https:\/\/checkout\.stripe\.com\//.test(res.payload.url), res.payload.url);
    assert.strictEqual(res.payload.plan, 'pro');
    assert.strictEqual(res.payload.testMode, true);

    const session = stripeCalls.find((c) => c.href.endsWith('/checkout/sessions'));
    assert.ok(session, 'a checkout session should have been created');
    assert.strictEqual(session.params.get('mode'), 'subscription');
    assert.strictEqual(session.params.get('line_items[0][price]'), 'price_pro_test');
    assert.strictEqual(session.params.get('line_items[0][quantity]'), '1');
    assert.ok(session.params.get('customer').startsWith('cus_'));
    assert.ok(/checkout=success/.test(session.params.get('success_url')));
    assert.ok(/checkout=cancelled/.test(session.params.get('cancel_url')));
  });

  await test('a Max checkout is created for the Max price', async () => {
    const { jar } = await signedUpUser();
    const { res } = await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'max' } });
    assert.strictEqual(res.statusCode, 200);
    const session = stripeCalls.find((c) => c.href.endsWith('/checkout/sessions'));
    assert.strictEqual(session.params.get('line_items[0][price]'), 'price_max_test');
    assert.strictEqual(session.params.get('mode'), 'subscription');
  });

  await test('the Stripe customer is created once and reused', async () => {
    const { jar } = await signedUpUser();
    await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'pro' } });
    const first = stripeCalls.filter((c) => c.href.endsWith('/v1/customers')).length;
    await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'max' } });
    const total = stripeCalls.filter((c) => c.href.endsWith('/v1/customers')).length;
    assert.strictEqual(first, 1);
    assert.strictEqual(total, 1, 'a second checkout must not create a second customer');
  });

  await test('the customer is mapped to the account in both directions before checkout returns', async () => {
    const { jar, user } = await signedUpUser();
    await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'pro' } });

    const stored = await users.byId(user.id);
    assert.ok(stored.stripeCustomerId, 'the account should carry its customer id');
    const back = await users.byCustomerId(stored.stripeCustomerId);
    assert.strictEqual(back.id, user.id, 'a webhook must be able to find the account from the customer');
  });

  await test('a checkout cannot be re-priced from the request body', async () => {
    const { jar } = await signedUpUser();
    const { res } = await callEndpoint(checkoutEndpoint, {
      jar,
      body: {
        plan: 'pro',
        /* everything a page might try to smuggle through */
        price: 'price_one_cent', priceId: 'price_one_cent', amount: 1,
        line_items: [{ price: 'price_one_cent', quantity: 1 }],
        unit_amount: 1, currency: 'xxx', mode: 'payment'
      }
    });
    assert.strictEqual(res.statusCode, 200);
    const session = stripeCalls.find((c) => c.href.endsWith('/checkout/sessions'));
    assert.strictEqual(session.params.get('line_items[0][price]'), 'price_pro_test');
    assert.strictEqual(session.params.get('mode'), 'subscription');
    assert.strictEqual(session.params.get('currency'), null);
    assert.strictEqual(session.params.get('unit_amount'), null);
  });

  await test('a plan that is not sold is refused', async () => {
    const { jar } = await signedUpUser();
    for (const plan of ['free', 'enterprise', '', 'plus', null, 42, { id: 'pro' }]) {
      const { res } = await callEndpoint(checkoutEndpoint, { jar, body: { plan } });
      assert.strictEqual(res.statusCode, 400, `plan ${JSON.stringify(plan)} should be refused`);
    }
    assert.ok(!stripeCalls.some((c) => c.href.endsWith('/checkout/sessions')));
  });

  await test('a plan name is matched on its meaning, not its typing', async () => {
    const { jar } = await signedUpUser();
    const { res } = await callEndpoint(checkoutEndpoint, { jar, body: { plan: '  PRO ' } });
    assert.strictEqual(res.statusCode, 200, 'case and stray spaces are not a different plan');
    const session = stripeCalls.find((c) => c.href.endsWith('/checkout/sessions'));
    assert.strictEqual(session.params.get('line_items[0][price]'), 'price_pro_test');
  });

  await test('the return URL cannot be pointed off-site', async () => {
    const { jar } = await signedUpUser();
    await callEndpoint(checkoutEndpoint, {
      jar,
      headers: { origin: 'https://fynd.test' },
      body: { plan: 'pro', returnPath: 'https://evil.example/steal' }
    });
    const session = stripeCalls.find((c) => c.href.endsWith('/checkout/sessions'));
    ['success_url', 'cancel_url'].forEach((field) => {
      assert.ok(session.params.get(field).startsWith('https://fynd.test/'), session.params.get(field));
      assert.ok(!session.params.get(field).includes('evil.example'), session.params.get(field));
    });
  });

  await test('a plan with no price configured cannot be bought, and says so', async () => {
    const was = process.env.STRIPE_PRICE_MAX;
    delete process.env.STRIPE_PRICE_MAX;
    try {
      const { jar } = await signedUpUser();
      const { res } = await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'max' } });
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.payload.reason, 'no-price-id');
      assert.ok(!stripeCalls.some((c) => c.href.endsWith('/checkout/sessions')));
    } finally {
      process.env.STRIPE_PRICE_MAX = was;
    }
  });

  await test('a cancelled checkout leaves the account exactly as it was', async () => {
    const { jar, user } = await signedUpUser();
    await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'pro' } });

    /* the shopper closes Stripe's page: no webhook is ever delivered,
       and they land back on the cancel URL */
    assert.strictEqual(await planOf(user.id), 'free');

    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.plan.id, 'free');
    assert.strictEqual(res.payload.subscription, null);
    assert.deepStrictEqual(res.payload.usage.searches.limit, 3);
  });

  /* =========================================================
     4. A checkout that completes
     ========================================================= */

  console.log('\na completed checkout');

  /* Signs up, starts a checkout, then delivers the two events Stripe
     sends when the payment goes through. */
  async function completeCheckout(planId, email) {
    const { jar, user } = await signedUpUser(email);
    await callEndpoint(checkoutEndpoint, { jar, body: { plan: planId } });
    const stored = await users.byId(user.id);

    const subscription = stripeSubscription({
      id: `sub_${planId}`,
      customer: stored.stripeCustomerId,
      items: { data: [{ id: 'si_1', price: { id: plans.priceIdFor(planId) } }] },
      metadata: { fyndUserId: user.id, fyndPlan: planId }
    });

    const completed = stripeEvent('checkout.session.completed', {
      id: 'cs_test_1',
      object: 'checkout_session',
      mode: 'subscription',
      customer: stored.stripeCustomerId,
      subscription: subscription.id,
      client_reference_id: user.id,
      payment_status: 'paid',
      metadata: { fyndUserId: user.id, fyndPlan: planId }
    });

    const created = stripeEvent('customer.subscription.created', subscription);

    return { jar, user, subscription, completed, created };
  }

  await test('a completed Pro checkout puts the account on Pro', async () => {
    const { jar, user, completed, created } = await completeCheckout('pro');

    assert.strictEqual((await deliver(completed)).statusCode, 200);
    assert.strictEqual((await deliver(created)).statusCode, 200);

    assert.strictEqual(await planOf(user.id), 'pro');

    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.plan.id, 'pro');
    assert.strictEqual(res.payload.plan.name, 'Pro');
    assert.strictEqual(res.payload.subscription.status, 'active');
    assert.strictEqual(res.payload.billing.portal, true, 'they can now manage the subscription');
  });

  await test('a completed Max checkout puts the account on Max', async () => {
    const { jar, user, completed, created } = await completeCheckout('max');
    await deliver(completed);
    await deliver(created);

    assert.strictEqual(await planOf(user.id), 'max');
    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.plan.id, 'max');
    assert.strictEqual(res.payload.usage.aiTokens.limit, 5000000);
    assert.strictEqual(res.payload.usage.searches.limit, 400);
  });

  await test('the usage limits move to the plan the subscription bought', async () => {
    const { jar, user, completed, created } = await completeCheckout('pro');

    const before = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(before.res.payload.usage.searches.limit, 3);
    assert.strictEqual(before.res.payload.usage.aiTokens.limit, 20000);
    assert.strictEqual(before.res.payload.usage.searches.period, 'day');

    await deliver(completed);
    await deliver(created);

    const after = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(after.res.payload.usage.searches.limit, 75);
    assert.strictEqual(after.res.payload.usage.aiTokens.limit, 1000000);
    assert.strictEqual(after.res.payload.usage.searches.period, 'month');
    assert.strictEqual(await planOf(user.id), 'pro');
  });

  await test('the subscription events alone are enough, even if the checkout event never lands', async () => {
    const { user, created } = await completeCheckout('pro');
    /* checkout.session.completed is dropped entirely */
    await deliver(created);
    assert.strictEqual(await planOf(user.id), 'pro');
  });

  await test('a checkout for a customer no account claims changes nothing', async () => {
    const orphan = stripeEvent('checkout.session.completed', {
      id: 'cs_test_orphan',
      mode: 'subscription',
      customer: 'cus_nobody',
      subscription: 'sub_nobody',
      client_reference_id: 'usr_does_not_exist'
    });
    const res = await deliver(orphan);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.reason, 'no-matching-user');
  });

  /* =========================================================
     5. Duplicate and out-of-order deliveries
     ========================================================= */

  console.log('\nduplicate and out-of-order deliveries');

  await test('the same delivery twice is applied once', async () => {
    const { user, completed, created } = await completeCheckout('pro');
    await deliver(completed);

    const first = await deliver(created);
    const second = await deliver(created);

    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(first.payload.duplicate, false);
    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.payload.duplicate, true, 'the second delivery must be recognised');
    assert.strictEqual(await planOf(user.id), 'pro');

    const stored = await users.byId(user.id);
    assert.strictEqual(stored.subscription.id, 'sub_pro', 'one subscription, not two');
  });

  await test('a duplicate delivery does not disturb the usage counters', async () => {
    const { user, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);

    const subject = `user:${user.id}`;
    await usage.record(subject, 'pro', plans.SEARCHES, 5);
    const before = await usage.meter(subject, 'pro', plans.SEARCHES);

    for (let i = 0; i < 4; i += 1) await deliver(created);

    const after = await usage.meter(subject, 'pro', plans.SEARCHES);
    assert.deepStrictEqual(after, before, 'replaying an event must not move a counter');
    assert.strictEqual(after.used, 5);
    assert.strictEqual(after.remaining, 70);
  });

  await test('ten simultaneous copies of one delivery are applied once', async () => {
    const { user, completed, created } = await completeCheckout('pro');
    await deliver(completed);

    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(created)));
    const applied = results.filter((r) => r.payload && r.payload.duplicate === false);

    assert.strictEqual(applied.length, 1, `exactly one delivery should win, ${applied.length} did`);
    assert.strictEqual(await planOf(user.id), 'pro');
  });

  await test('an older event cannot undo a newer one', async () => {
    const { user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);
    assert.strictEqual(await planOf(user.id), 'pro');

    /* the cancellation, then the creation event arriving late behind it */
    const deleted = stripeEvent('customer.subscription.deleted',
      Object.assign({}, subscription, { status: 'canceled' }),
      { created: created.created + 60 });
    await deliver(deleted);
    assert.strictEqual(await planOf(user.id), 'free');

    const late = stripeEvent('customer.subscription.created', subscription, { created: created.created });
    const res = await deliver(late);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.reason, 'stale', JSON.stringify(res.payload));
    assert.strictEqual(await planOf(user.id), 'free', 'a late create must not resurrect a cancelled plan');
  });

  await test('a delivery that fails to apply is left un-claimed so Stripe’s retry works', async () => {
    /* nothing is delivered yet, so the account is still on Free and the
       one event below is the only thing that could change that */
    const { user, created } = await completeCheckout('pro');
    assert.strictEqual(await planOf(user.id), 'free');

    /* the store goes down for exactly one delivery */
    const realSet = store.set;
    store.set = async () => { throw new Error('store unavailable'); };
    const failed = await deliver(created);
    store.set = realSet;

    assert.strictEqual(failed.statusCode, 500, 'a 5xx is what makes Stripe retry');
    assert.strictEqual(await planOf(user.id), 'free');

    const retry = await deliver(created);
    assert.strictEqual(retry.statusCode, 200);
    assert.strictEqual(retry.payload.duplicate, false, 'the retry must not be mistaken for a duplicate');
    assert.strictEqual(await planOf(user.id), 'pro');
  });

  /* =========================================================
     6. Cancellation, failure and renewal
     ========================================================= */

  console.log('\ncancellation, failed payments and renewal');

  await test('a cancelled subscription drops the account to Free', async () => {
    const { user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);
    assert.strictEqual(await planOf(user.id), 'pro');

    const deleted = stripeEvent('customer.subscription.deleted',
      Object.assign({}, subscription, { status: 'canceled' }),
      { created: created.created + 10 });
    assert.strictEqual((await deliver(deleted)).statusCode, 200);

    assert.strictEqual(await planOf(user.id), 'free');
    const stored = await users.byId(user.id);
    assert.strictEqual(stored.subscription.status, 'canceled');
  });

  await test('a deleted event still saying "active" is treated as the cancellation it is', async () => {
    const { user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);

    /* the object in the event has not been updated; the event type is
       the fact, and it wins */
    const deleted = stripeEvent('customer.subscription.deleted', subscription, { created: created.created + 10 });
    await deliver(deleted);
    assert.strictEqual(await planOf(user.id), 'free');
  });

  await test('cancelling at period end keeps the plan until the period ends', async () => {
    const { jar, user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);

    const updated = stripeEvent('customer.subscription.updated',
      Object.assign({}, subscription, { cancel_at_period_end: true, status: 'active' }),
      { created: created.created + 10 });
    await deliver(updated);

    assert.strictEqual(await planOf(user.id), 'pro', 'they paid for this period');
    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.subscription.cancelAtPeriodEnd, true);
    assert.strictEqual(res.payload.plan.id, 'pro');
  });

  await test('a failed payment drops the plan and records why', async () => {
    const { jar, user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);

    /* Stripe moves the subscription to past_due, then tells us the
       invoice failed. The refetch returns the past_due subscription. */
    const pastDue = stripeSubscription(Object.assign({}, subscription, { status: 'past_due' }));
    const failure = stripeEvent('invoice.payment_failed', {
      id: 'in_test_1',
      object: 'invoice',
      customer: subscription.customer,
      subscription: pastDue.id
    }, { created: created.created + 20 });

    assert.strictEqual((await deliver(failure)).statusCode, 200);
    assert.strictEqual(await planOf(user.id), 'free');

    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.plan.id, 'free', 'a card that stopped working stops the allowance');
    assert.strictEqual(res.payload.subscription.status, 'past_due');
    assert.strictEqual(res.payload.subscription.latestInvoiceStatus, 'payment_failed');
    assert.strictEqual(res.payload.usage.searches.limit, 3);
  });

  await test('a past_due subscription that is paid restores the plan', async () => {
    const { user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);

    stripeSubscription(Object.assign({}, subscription, { status: 'past_due' }));
    await deliver(stripeEvent('invoice.payment_failed', {
      id: 'in_test_2', customer: subscription.customer, subscription: subscription.id
    }, { created: created.created + 20 }));
    assert.strictEqual(await planOf(user.id), 'free');

    stripeSubscription(Object.assign({}, subscription, { status: 'active' }));
    await deliver(stripeEvent('invoice.paid', {
      id: 'in_test_3', customer: subscription.customer, subscription: subscription.id
    }, { created: created.created + 40 }));

    assert.strictEqual(await planOf(user.id), 'pro');
    const stored = await users.byId(user.id);
    assert.strictEqual(stored.subscription.latestInvoiceStatus, 'paid');
  });

  await test('a renewal invoice keeps the plan where it is', async () => {
    const { user, subscription, completed, created } = await completeCheckout('max');
    await deliver(completed);
    await deliver(created);
    assert.strictEqual(await planOf(user.id), 'max');

    await deliver(stripeEvent('invoice.paid', {
      id: 'in_renewal', customer: subscription.customer, subscription: subscription.id
    }, { created: created.created + 2592000 }));

    assert.strictEqual(await planOf(user.id), 'max');
  });

  await test('a plan change made in the billing portal is followed', async () => {
    const { user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);
    assert.strictEqual(await planOf(user.id), 'pro');

    const upgraded = stripeEvent('customer.subscription.updated', Object.assign({}, subscription, {
      items: { data: [{ id: 'si_1', price: { id: 'price_max_test' } }] }
    }), { created: created.created + 30 });
    await deliver(upgraded);

    assert.strictEqual(await planOf(user.id), 'max');
  });

  /* =========================================================
     7. The billing portal
     ========================================================= */

  console.log('\nthe billing portal');

  await test('the portal opens for a customer, and returns to the site', async () => {
    const { jar, user } = await signedUpUser();
    await withCustomer(user);

    const { res } = await callEndpoint(portalEndpoint, {
      jar, headers: { origin: 'https://fynd.test' }, body: { returnPath: '/account.html' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(/^https:\/\/billing\.stripe\.com\//.test(res.payload.url), res.payload.url);

    const call = stripeCalls.find((c) => c.href.endsWith('/billing_portal/sessions'));
    assert.strictEqual(call.params.get('customer'), 'cus_test_1');
    assert.strictEqual(call.params.get('return_url'), 'https://fynd.test/account.html');
  });

  await test('the portal refuses a caller with no account and one with no customer', async () => {
    const out = await callEndpoint(portalEndpoint, { body: {} });
    assert.strictEqual(out.res.statusCode, 401);

    const { jar } = await signedUpUser();
    const fresh = await callEndpoint(portalEndpoint, { jar, body: {} });
    assert.strictEqual(fresh.res.statusCode, 409);
    assert.strictEqual(fresh.res.payload.reason, 'no-customer');
  });

  await test('the portal return URL cannot be pointed off-site either', async () => {
    const { jar, user } = await signedUpUser();
    await withCustomer(user);
    await callEndpoint(portalEndpoint, {
      jar, headers: { origin: 'https://fynd.test' }, body: { returnPath: '//evil.example/x' }
    });
    const call = stripeCalls.find((c) => c.href.endsWith('/billing_portal/sessions'));
    assert.ok(call.params.get('return_url').startsWith('https://fynd.test/'), call.params.get('return_url'));
    assert.ok(!call.params.get('return_url').includes('evil.example'));
  });

  /* =========================================================
     8. Nothing a browser sends can buy anything
     ========================================================= */

  console.log('\nwhat a browser cannot do');

  await test('asking /api/account for a plan does not grant one', async () => {
    const { jar, user } = await signedUpUser();
    /* every shape a page might try */
    for (const body of [{ plan: 'max' }, { plan: { id: 'max' } }, { subscription: { status: 'active', priceId: 'price_max_test' } }]) {
      const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET', body });
      assert.strictEqual(res.payload.plan.id, 'free', JSON.stringify(body));
    }
    assert.strictEqual(await planOf(user.id), 'free');
  });

  await test('/api/account refuses anything but GET, so there is no write path at all', async () => {
    const { jar } = await signedUpUser();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { res } = await callEndpoint(accountEndpoint, { jar, method, body: { plan: 'max' } });
      assert.strictEqual(res.statusCode, 405, method);
    }
  });

  await test('signing up with a plan in the body creates a Free account', async () => {
    const { res } = await callEndpoint(authEndpoint, {
      body: { action: 'signup', email: 'sneaky@example.test', password: PASSWORD, plan: 'max', subscription: { status: 'active' } }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.plan.id, 'free');
    const stored = await users.byEmail('sneaky@example.test');
    assert.strictEqual(stored.plan, 'free');
    assert.strictEqual(stored.subscription, null);
  });

  await test('a forged session cookie is not a session', async () => {
    const { user } = await signedUpUser();
    const forgeries = [
      `${user.id}.${Math.floor(Date.now() / 1000)}.abc.notasignature`,
      `${user.id}.${Math.floor(Date.now() / 1000)}.abc.`,
      user.id,
      `usr_invented.${Math.floor(Date.now() / 1000)}.abc.${'0'.repeat(43)}`
    ];
    for (const token of forgeries) {
      const { res } = await callEndpoint(accountEndpoint, { method: 'GET', jar: { fynd_session: token } });
      assert.strictEqual(res.payload.signedIn, false, token);
      assert.strictEqual(res.payload.plan.id, 'free');
    }
  });

  await test('a session signed with a different secret is refused', async () => {
    const { user } = await signedUpUser();
    const was = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = 'a-completely-different-secret-32ch';
    const forged = auth.issueSession(user.id);
    process.env.AUTH_SECRET = was;

    const { res } = await callEndpoint(accountEndpoint, { method: 'GET', jar: { fynd_session: forged } });
    assert.strictEqual(res.payload.signedIn, false);
  });

  await test('a real session for a Pro account still reports Pro — the cookie names you, it does not rank you', async () => {
    const { jar, user, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);

    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.signedIn, true);
    assert.strictEqual(res.payload.plan.id, 'pro');

    /* the same cookie with the user id swapped for somebody else's */
    const other = await signedUpUser('other@example.test');
    const tampered = jar.fynd_session.replace(user.id, other.user.id);
    const swapped = await callEndpoint(accountEndpoint, { method: 'GET', jar: { fynd_session: tampered } });
    assert.strictEqual(swapped.res.payload.signedIn, false, 'editing the id breaks the signature');
  });

  await test('a plan written straight into the user record is recomputed from the subscription', async () => {
    const { user } = await signedUpUser();
    /* the shape a compromised call site, or a hand-edited row, might take */
    const saved = await users.save(Object.assign({}, user, { plan: 'max' }));
    assert.strictEqual(saved.plan, 'free', 'the stored plan is derived, never assigned');

    const stillFree = await users.save(Object.assign({}, user, {
      plan: 'max',
      subscription: { id: 'sub_x', status: 'canceled', priceId: 'price_max_test', updatedAt: 1 }
    }));
    assert.strictEqual(stillFree.plan, 'free');
  });

  await test('the account reply never carries a Stripe id or a password hash', async () => {
    const { jar, user, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);

    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    const body = JSON.stringify(res.payload);
    const stored = await users.byId(user.id);
    assert.ok(!body.includes(stored.stripeCustomerId), 'no customer id may reach a browser');
    assert.ok(!body.includes('sub_pro'), 'no subscription id may reach a browser');
    assert.ok(!/scrypt\$/.test(body), 'no password hash may reach a browser');
    assert.ok(!/sk_test_|whsec_|price_/.test(body), 'no key or price id may reach a browser');
  });

  await test('a request from an origin that is not allowed is refused before anything is read', async () => {
    /* This is what stops a cross-site request forgery, and it is checked
       on the request itself rather than only on the preflight: a "simple"
       POST that skips the preflight still carries an Origin header, and
       still gets a 403 here. */
    const { jar } = await signedUpUser();
    const hostile = { origin: 'https://evil.example' };

    for (const [name, endpoint, body] of [
      ['checkout', checkoutEndpoint, { plan: 'pro' }],
      ['portal', portalEndpoint, {}],
      ['auth', authEndpoint, { action: 'logout' }],
      ['search', searchEndpoint, { intent: {} }]
    ]) {
      const { res } = await callEndpoint(endpoint, { jar, headers: hostile, body });
      assert.strictEqual(res.statusCode, 403, `${name} should refuse a hostile origin`);
    }

    const account = await callEndpoint(accountEndpoint, { jar, method: 'GET', headers: hostile });
    assert.strictEqual(account.res.statusCode, 403);
    assert.ok(!stripeCalls.length, 'nothing may be created at Stripe for a request from an origin we refuse');
  });

  await test('the deployment’s own origin is allowed, and gets the credentials header it needs', async () => {
    const { jar } = await signedUpUser();
    const { res } = await callEndpoint(accountEndpoint, {
      jar, method: 'GET', headers: { origin: 'https://fynd.test' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.getHeader('access-control-allow-origin'), 'https://fynd.test');
    assert.strictEqual(res.getHeader('access-control-allow-credentials'), 'true');
    assert.strictEqual(res.getHeader('cache-control'), 'no-store, private');
  });

  await test('the session cookie is HttpOnly, so no script on the page can read it', async () => {
    const res = makeRes();
    const req = makeReq({ body: { action: 'signup', email: 'cookie@example.test', password: PASSWORD } });
    await authEndpoint(req, res);
    const set = [].concat(res.getHeader('Set-Cookie'));
    const session = set.find((line) => line.startsWith('fynd_session='));
    assert.ok(session, 'a session cookie should be set');
    assert.ok(/HttpOnly/.test(session), session);
    assert.ok(/SameSite=/.test(session), session);
  });

  /* =========================================================
     9. Metering follows the server's plan
     ========================================================= */

  console.log('\nusage limits follow the subscription');

  await test('the free allowance is three searches a day, and the fourth is refused', async () => {
    const { jar, user } = await signedUpUser();
    const subject = `user:${user.id}`;

    for (let i = 1; i <= 3; i += 1) {
      const state = await usage.check(subject, 'free', plans.SEARCHES);
      assert.strictEqual(state.allowed, true, `search ${i} should be allowed`);
      await usage.record(subject, 'free', plans.SEARCHES, 1);
    }

    assert.strictEqual((await usage.check(subject, 'free', plans.SEARCHES)).allowed, false);

    const { res } = await callEndpoint(searchEndpoint, { jar, body: { intent: { categories: ['hoodie'] } } });
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.payload.reason, 'over-limit');
    assert.strictEqual(res.payload.usage.limit, 3);
    assert.strictEqual(res.payload.upgrade, true);
  });

  await test('the same account on Pro is not refused at three', async () => {
    const { jar, user, completed, created } = await completeCheckout('pro');
    const subject = `user:${user.id}`;

    /* three searches spent while still on Free */
    for (let i = 0; i < 3; i += 1) await usage.record(subject, 'free', plans.SEARCHES, 1);
    const blocked = await callEndpoint(searchEndpoint, { jar, body: { intent: {} } });
    assert.strictEqual(blocked.res.statusCode, 429);

    await deliver(completed);
    await deliver(created);

    /* the subscription is what changed, and nothing else */
    const state = await usage.check(subject, 'pro', plans.SEARCHES);
    assert.strictEqual(state.allowed, true);
    assert.strictEqual(state.limit, 75);

    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.usage.searches.limit, 75);
    assert.strictEqual(res.payload.usage.searches.remaining, 75);
  });

  await test('an exhausted Max account is not told to upgrade to anything', async () => {
    const { user, completed, created } = await completeCheckout('max');
    await deliver(completed);
    await deliver(created);

    const subject = `user:${user.id}`;
    await usage.record(subject, 'max', plans.SEARCHES, 400);

    const state = await usage.check(subject, 'max', plans.SEARCHES);
    assert.strictEqual(state.allowed, false);
    assert.strictEqual(state.remaining, 0);
  });

  await test('cancelling puts the smaller allowance back', async () => {
    const { jar, user, subscription, completed, created } = await completeCheckout('pro');
    await deliver(completed);
    await deliver(created);
    assert.strictEqual((await callEndpoint(accountEndpoint, { jar, method: 'GET' })).res.payload.usage.searches.limit, 75);

    await deliver(stripeEvent('customer.subscription.deleted',
      Object.assign({}, subscription, { status: 'canceled' }), { created: created.created + 10 }));

    const { res } = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
    assert.strictEqual(res.payload.plan.id, 'free');
    assert.strictEqual(res.payload.usage.searches.limit, 3);
    assert.strictEqual(res.payload.usage.aiTokens.limit, 20000);
    assert.strictEqual(res.payload.usage.searches.period, 'day');
  });

  await test('two visitors are metered separately', async () => {
    const a = await signedUpUser('a@example.test');
    const b = await signedUpUser('b@example.test');

    await usage.record(`user:${a.user.id}`, 'free', plans.SEARCHES, 3);

    assert.strictEqual((await usage.check(`user:${a.user.id}`, 'free', plans.SEARCHES)).allowed, false);
    assert.strictEqual((await usage.check(`user:${b.user.id}`, 'free', plans.SEARCHES)).allowed, true);
  });

  await test('an anonymous visitor is metered per browser, and gets a device cookie to be metered by', async () => {
    const first = await callEndpoint(accountEndpoint, { method: 'GET' });
    assert.strictEqual(first.res.payload.signedIn, false);
    assert.strictEqual(first.res.payload.plan.id, 'free');
    assert.ok(first.jar.fynd_device, 'an anonymous visitor needs an id to count against');

    await usage.record(`dev_${first.jar.fynd_device}`, 'free', plans.SEARCHES, 3);

    const blocked = await callEndpoint(searchEndpoint, { jar: first.jar, body: { intent: {} } });
    assert.strictEqual(blocked.res.statusCode, 429);

    /* a different browser is a different count */
    const other = await callEndpoint(searchEndpoint, { jar: { fynd_device: 'f'.repeat(32) }, body: { intent: {} } });
    assert.notStrictEqual(other.res.statusCode, 429);
  });

  await test('a caller that ignores cookies is still metered', async () => {
    const req = makeReq({ headers: { host: 'fynd.test', 'user-agent': 'curl/8' } });
    const subject = auth.addressSubject(req);
    assert.ok(subject.startsWith('ip_'));

    await usage.record(subject, 'free', plans.SEARCHES, 3);
    assert.strictEqual((await usage.check(subject, 'free', plans.SEARCHES)).allowed, false);
  });

  await test('the daily and monthly counters are separate keys, so a plan change does not double-count', () => {
    const day = usage.counterKey('user:1', plans.SEARCHES, 'day', '2026-08-27');
    const month = usage.counterKey('user:1', plans.SEARCHES, 'month', '2026-08');
    assert.notStrictEqual(day, month);
    assert.strictEqual(usage.windowFor('day', new Date('2026-08-27T12:00:00Z')).key, '2026-08-27');
    assert.strictEqual(usage.windowFor('month', new Date('2026-08-27T12:00:00Z')).key, '2026-08');
    assert.strictEqual(usage.windowFor('day', new Date('2026-08-27T12:00:00Z')).resetsAt, '2026-08-28T00:00:00.000Z');
    assert.strictEqual(usage.windowFor('month', new Date('2026-12-27T12:00:00Z')).resetsAt, '2027-01-01T00:00:00.000Z');
  });

  await test('an interpretation is counted at the tokens OpenAI reported, not at a guess', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    openaiCalls.length = 0;
    openaiTokens = 1234;
    try {
      const { jar, user } = await signedUpUser();
      const { res } = await callEndpoint(interpretEndpoint, { jar, body: { query: 'a black hoodie' } });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.source, 'openai');
      assert.strictEqual(res.payload.usage.used, 1234);
      assert.strictEqual(res.payload.usage.limit, 20000);
      assert.strictEqual(res.payload.usage.remaining, 20000 - 1234);

      const counted = await usage.meter(`user:${user.id}`, 'free', plans.AI_TOKENS);
      assert.strictEqual(counted.used, 1234);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  await test('an account out of tokens is refused before OpenAI is called at all', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    openaiCalls.length = 0;
    try {
      const { jar, user } = await signedUpUser();
      await usage.record(`user:${user.id}`, 'free', plans.AI_TOKENS, 20000);

      const { res } = await callEndpoint(interpretEndpoint, { jar, body: { query: 'a black hoodie' } });
      assert.strictEqual(res.statusCode, 429);
      assert.strictEqual(res.payload.reason, 'over-limit');
      assert.strictEqual(res.payload.usage.plan, 'free');
      assert.strictEqual(openaiCalls.length, 0, 'no credit may be spent on a request that is over the limit');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  await test('the same account on Max has the larger token allowance, from the subscription alone', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-openai';
    openaiTokens = 500;
    try {
      const { jar, user, completed, created } = await completeCheckout('max');
      await usage.record(`user:${user.id}`, 'free', plans.AI_TOKENS, 20000);

      const blocked = await callEndpoint(interpretEndpoint, { jar, body: { query: 'a black hoodie' } });
      assert.strictEqual(blocked.res.statusCode, 429);

      await deliver(completed);
      await deliver(created);

      const { res } = await callEndpoint(interpretEndpoint, { jar, body: { query: 'a black hoodie' } });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.payload.usage.limit, 5000000);
      assert.strictEqual(res.payload.usage.plan, 'max');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  await test('a checkout session that was not for a subscription is ignored', async () => {
    const { user } = await signedUpUser();
    const linked = await withCustomer(user, 'cus_oneoff');
    const res = await deliver(stripeEvent('checkout.session.completed', {
      id: 'cs_oneoff', mode: 'payment', customer: linked.stripeCustomerId, client_reference_id: user.id
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.reason, 'not-a-subscription');
    assert.strictEqual(await planOf(user.id), 'free');
  });

  /* =========================================================
     10. Accounts
     ========================================================= */

  console.log('\naccounts');

  await test('signing up, signing out and signing back in keeps the same account', async () => {
    const { jar, user } = await signedUpUser();

    const out = await callEndpoint(authEndpoint, { jar, body: { action: 'logout' } });
    assert.strictEqual(out.res.payload.signedIn, false);
    assert.ok(!out.jar.fynd_session, 'the session cookie should be cleared');

    const back = await callEndpoint(authEndpoint, { body: { action: 'login', email: EMAIL, password: PASSWORD } });
    assert.strictEqual(back.res.statusCode, 200);
    assert.strictEqual(back.res.payload.user.email, EMAIL);
    assert.strictEqual(back.res.payload.user.id, user.id);
  });

  await test('a wrong password and an address with no account answer the same way', async () => {
    await signedUpUser();
    const wrong = await callEndpoint(authEndpoint, { body: { action: 'login', email: EMAIL, password: 'not-the-password' } });
    const missing = await callEndpoint(authEndpoint, { body: { action: 'login', email: 'nobody@example.test', password: PASSWORD } });
    assert.strictEqual(wrong.res.statusCode, 401);
    assert.strictEqual(missing.res.statusCode, 401);
    assert.strictEqual(wrong.res.payload.error, missing.res.payload.error);
  });

  await test('an address cannot be signed up twice', async () => {
    await signedUpUser();
    const { res } = await callEndpoint(authEndpoint, { body: { action: 'signup', email: EMAIL, password: PASSWORD } });
    assert.strictEqual(res.statusCode, 409);
  });

  await test('two simultaneous sign-ups for one address make one account', async () => {
    const attempts = await Promise.all(Array.from({ length: 5 }, () =>
      callEndpoint(authEndpoint, { body: { action: 'signup', email: 'race@example.test', password: PASSWORD } })));
    const created = attempts.filter((a) => a.res.statusCode === 200);
    assert.strictEqual(created.length, 1, `${created.length} accounts were created for one address`);
  });

  await test('a short password is refused', async () => {
    const { res } = await callEndpoint(authEndpoint, { body: { action: 'signup', email: 'short@example.test', password: 'short' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(await users.byEmail('short@example.test'), null);
  });

  await test('repeated failed sign-ins are rate limited', async () => {
    await signedUpUser();
    let limited = false;
    for (let i = 0; i < 12; i += 1) {
      const { res } = await callEndpoint(authEndpoint, { body: { action: 'login', email: EMAIL, password: 'wrong' } });
      if (res.statusCode === 429) { limited = true; break; }
    }
    assert.ok(limited, 'guessing should be stopped before it gets far');
  });

  await test('with no AUTH_SECRET, accounts are refused rather than faked', async () => {
    const was = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = '';
    try {
      const { res } = await callEndpoint(authEndpoint, { body: { action: 'signup', email: 'x@example.test', password: PASSWORD } });
      assert.strictEqual(res.statusCode, 503);
      assert.strictEqual(res.payload.reason, 'no-auth-secret');
    } finally {
      process.env.AUTH_SECRET = was;
    }
  });

  await test('a Stripe customer is never moved to a different account', async () => {
    const { user } = await signedUpUser();
    await users.linkCustomer(user, 'cus_first');
    const again = await users.linkCustomer(await users.byId(user.id), 'cus_second');
    assert.strictEqual(again.stripeCustomerId, 'cus_first');
  });

  /* =========================================================
     11. Configuration
     ========================================================= */

  console.log('\nconfiguration');

  await test('a test-mode key is reported as test mode', () => {
    assert.strictEqual(stripe.testMode(), true);
    assert.strictEqual(stripe.configured(), true);
    assert.strictEqual(stripe.webhookConfigured(), true);
  });

  await test('with no Stripe key, checkout and the portal say so instead of failing oddly', async () => {
    const was = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = '';
    try {
      const { jar } = await signedUpUser();
      const checkout = await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'pro' } });
      assert.strictEqual(checkout.res.statusCode, 503);
      assert.strictEqual(checkout.res.payload.reason, 'no-stripe-key');

      const portal = await callEndpoint(portalEndpoint, { jar, body: {} });
      assert.strictEqual(portal.res.statusCode, 503);

      const account = await callEndpoint(accountEndpoint, { jar, method: 'GET' });
      assert.strictEqual(account.res.payload.billing.enabled, false, 'the page is told it cannot sell anything');
    } finally {
      process.env.STRIPE_SECRET_KEY = was;
    }
  });

  await test('with no webhook secret, deliveries are refused rather than trusted', async () => {
    const was = process.env.STRIPE_WEBHOOK_SECRET;
    process.env.STRIPE_WEBHOOK_SECRET = '';
    try {
      const res = await deliver(stripeEvent('customer.subscription.created', stripeSubscription()), { secret: 'anything' });
      assert.strictEqual(res.statusCode, 503);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = was;
    }
  });

  await test('the Stripe key is sent as a header and never appears in a URL', async () => {
    const { jar } = await signedUpUser();
    await callEndpoint(checkoutEndpoint, { jar, body: { plan: 'pro' } });
    stripeCalls.forEach((call) => {
      assert.ok(!call.href.includes('sk_test_'), call.href);
      assert.strictEqual(call.headers.Authorization, `Bearer ${process.env.STRIPE_SECRET_KEY}`);
      assert.strictEqual(call.headers['Stripe-Version'], stripe.API_VERSION);
    });
  });

  await test('a memory-only deployment says its subscriptions are not durable', async () => {
    const { res } = await callEndpoint(accountEndpoint, { method: 'GET' });
    assert.strictEqual(res.payload.storage.durable, false);
    assert.strictEqual(store.driver(), 'memory');
  });

  await test('an event type Fynd does not handle is acknowledged, not retried forever', async () => {
    const res = await deliver(stripeEvent('customer.updated', { id: 'cus_test_1', object: 'customer' }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.payload.reason, 'ignored');
  });

  await test('the webhook refuses anything but POST', async () => {
    const res = makeRes();
    await webhookEndpoint(makeReq({ method: 'GET' }), res);
    assert.strictEqual(res.statusCode, 405);
  });

  await test('the webhook function turns off body parsing, so signatures can be checked at all', () => {
    assert.deepStrictEqual(webhookEndpoint.config, { api: { bodyParser: false } });
  });

  global.fetch = realFetch;
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
