/* =========================================================
   Fynd — Stripe, over its REST API

   Everything Fynd asks Stripe for goes through here: creating a
   customer, opening a Checkout Session, opening the billing portal,
   and reading a subscription back. Verifying a webhook signature is
   here too, because it is the same secret material and the same rules
   about what may be trusted.

   ---------------------------------------------------------
   Why the API and not the SDK
   ---------------------------------------------------------
   This repository has no build step, no package.json and no
   node_modules: the site is files, and `node scripts/…` runs the tests
   with nothing installed. Adding the Stripe SDK would add all three,
   for two endpoints and one signature check. The API is stable,
   versioned, and reachable with the fetch that is already used to call
   OpenAI and the product source.

   What that costs: the request encoding and the signature scheme are
   written out below rather than imported. Both are small, both are
   specified, and both are covered by scripts/test-stripe.js — including
   against signatures produced independently of the code that checks
   them.

   ---------------------------------------------------------
   The key
   ---------------------------------------------------------
   STRIPE_SECRET_KEY is read here and nowhere else, is sent only as an
   Authorization header to api.stripe.com, and is never included in a
   response, an error or a log line. Nothing under assets/ imports this
   file; a browser has no path to it. Errors from Stripe are logged with
   their type and message and returned to the browser as a generic
   failure, the same way the OpenAI and product-source errors are.
   ========================================================= */

'use strict';

const crypto = require('crypto');

const API = 'https://api.stripe.com/v1';

/* Pinned so a future default version at Stripe cannot change the shape
   of an event this code reads. Raise it deliberately, with the
   changelog open. */
const API_VERSION = '2024-06-20';

const secretKey = () => String(process.env.STRIPE_SECRET_KEY || '').trim();
const webhookSecret = () => String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();

const configured = () => Boolean(secretKey());
const webhookConfigured = () => Boolean(webhookSecret());

/* Test keys and live keys are told apart by their prefix. Worth
   surfacing: a deployment that thinks it is in test mode and is not
   charges real cards. */
const testMode = () => /^sk_test_|^rk_test_/.test(secretKey());

/* ---------------------------------------------------------
   Request encoding
   ---------------------------------------------------------
   Stripe takes form-encoded bodies with bracketed paths for nested
   values, which is how a list of line items is expressed:

     line_items[0][price]=price_123&line_items[0][quantity]=1

   Undefined and null are dropped rather than sent as the strings
   "undefined" and "null", which Stripe would take literally. */
function encode(params, prefix, pairs) {
  const out = pairs || [];
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const path = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === 'object') encode(item, `${path}[${index}]`, out);
        else out.push([`${path}[${index}]`, String(item)]);
      });
    } else if (value && typeof value === 'object') {
      encode(value, path, out);
    } else {
      out.push([path, String(value)]);
    }
  });
  return out;
}

const formBody = (params) => encode(params).map(([k, v]) =>
  `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

/* One call. Throws a StripeError carrying the status and Stripe's own
   message, which callers log and never forward to a browser.

   `idempotencyKey` makes a retried POST safe: Stripe replays the
   original response instead of creating a second customer or a second
   checkout session. */
async function request(method, path, params, options) {
  if (!configured()) throw Object.assign(new Error('Stripe is not configured.'), { code: 'not-configured' });

  const opts = options || {};
  const headers = {
    Authorization: `Bearer ${secretKey()}`,
    'Stripe-Version': API_VERSION
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = String(opts.idempotencyKey);

  let url = `${API}${path}`;
  let body;
  if (method === 'GET') {
    const query = formBody(params);
    if (query) url += `?${query}`;
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = formBody(params);
  }

  const response = await fetch(url, { method, headers, body });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = (payload && payload.error) || {};
    throw Object.assign(new Error(detail.message || `Stripe ${method} ${path} failed`), {
      code: detail.code || 'stripe-error',
      type: detail.type || null,
      status: response.status
    });
  }

  return payload;
}

/* ---------------------------------------------------------
   Webhook signatures
   ---------------------------------------------------------
   The Stripe-Signature header is a comma-separated list:

     t=1699999999,v1=<hex hmac>,v1=<another during a secret rotation>

   The signed payload is `${t}.${rawBody}` and the MAC is HMAC-SHA256
   keyed by the endpoint's signing secret. Three things make this the
   only thing the webhook trusts:

     - the body must be the exact bytes Stripe sent. Re-serialising a
       parsed body changes whitespace and key order and the signature
       stops matching, which is why the handler reads the raw stream.
     - the comparison is timing-safe.
     - a timestamp outside the tolerance is refused even with a valid
       MAC, so a signed delivery captured once cannot be replayed later.

   Every v1 in the header is tried, because during a secret rotation two
   are sent and only one matches the secret this deployment holds. */
const TOLERANCE_SECONDS = 300;

function parseSignatureHeader(header) {
  const out = { timestamp: null, signatures: [] };
  String(header || '').split(',').forEach((part) => {
    const at = part.indexOf('=');
    if (at < 1) return;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') out.timestamp = Number(value);
    else if (key === 'v1') out.signatures.push(value);
  });
  return out;
}

const signPayload = (timestamp, payload, signingSecret) =>
  crypto.createHmac('sha256', signingSecret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');

function timingSafeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/* Returns the parsed event, or throws. Never returns a partially
   trusted result: either the bytes were signed by the secret and are
   recent, or there is no event. */
function constructEvent(rawBody, signatureHeader, signingSecret, options) {
  const secret = String(signingSecret || webhookSecret());
  if (!secret) throw Object.assign(new Error('No webhook signing secret.'), { code: 'no-secret' });

  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const { timestamp, signatures } = parseSignatureHeader(signatureHeader);

  if (!timestamp || !Number.isFinite(timestamp) || !signatures.length) {
    throw Object.assign(new Error('Malformed Stripe-Signature header.'), { code: 'bad-signature' });
  }

  const tolerance = Number((options && options.toleranceSeconds) || TOLERANCE_SECONDS);
  const nowSeconds = Math.floor(((options && options.now) || Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    throw Object.assign(new Error('Stripe-Signature timestamp outside tolerance.'), { code: 'stale-signature' });
  }

  const expected = signPayload(timestamp, payload, secret);
  if (!signatures.some((candidate) => timingSafeEqualHex(candidate, expected))) {
    throw Object.assign(new Error('Stripe-Signature does not match.'), { code: 'bad-signature' });
  }

  try {
    return JSON.parse(payload);
  } catch (err) {
    throw Object.assign(new Error('Signed payload is not JSON.'), { code: 'bad-payload' });
  }
}

/* ---------------------------------------------------------
   The raw body
   ---------------------------------------------------------
   Signature verification needs the bytes as sent. Vercel's Node runtime
   parses a JSON body into req.body by default, which consumes the
   stream — so the webhook function turns that off with the config
   export at the bottom of api/stripe-webhook.js.

   This reads whatever survived, in the order of how trustworthy it is,
   and returns null when only a parsed object is left. A null is a 400
   that names the cause, rather than a signature check that fails for a
   reason nobody can see. */
function readRawBody(req) {
  if (req.rawBody) return Promise.resolve(Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(String(req.rawBody)));
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body, 'utf8'));
  if (req.body && typeof req.body === 'object') return Promise.resolve(null);

  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      /* Stripe events are small; anything past this is not one */
      if (size > 1024 * 1024) { req.destroy(); return resolve(null); }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/* ---------------------------------------------------------
   The calls Fynd actually makes
   --------------------------------------------------------- */

const createCustomer = (params, options) => request('POST', '/customers', params, options);

const createCheckoutSession = (params, options) => request('POST', '/checkout/sessions', params, options);

const createPortalSession = (params, options) => request('POST', '/billing_portal/sessions', params, options);

const getSubscription = (id) => request('GET', `/subscriptions/${encodeURIComponent(id)}`, null);

const getCheckoutSession = (id) => request('GET', `/checkout/sessions/${encodeURIComponent(id)}`, null);

module.exports = {
  API_VERSION,
  TOLERANCE_SECONDS,
  configured,
  webhookConfigured,
  testMode,
  encode,
  formBody,
  request,
  parseSignatureHeader,
  signPayload,
  constructEvent,
  readRawBody,
  createCustomer,
  createCheckoutSession,
  createPortalSession,
  getSubscription,
  getCheckoutSession
};
