#!/usr/bin/env node
/* =========================================================
   Fynd — authentication and session test

   Drives the real endpoints — /api/auth, /api/account, /api/verify-email,
   /api/google-start, /api/google-callback, /api/checkout — with the
   network stubbed at the fetch boundary and the store on its memory
   driver. Runs offline with no key, no Google project and no mailbox:

     node scripts/test-auth.js

   ---------------------------------------------------------
   Google is stubbed; the verification is not
   ---------------------------------------------------------
   An RSA key pair is generated here, its public half is served as a
   JWKS, and ID tokens are signed with the private half. So every check
   in api/_google.js runs for real against a real RS256 signature —
   only Google's servers are replaced, not the code that decides whether
   to believe them. A token signed by the wrong key, or with `alg: none`,
   or for another audience, is refused by the actual production path.

   ---------------------------------------------------------
   What is asserted about logging
   ---------------------------------------------------------
   Console output is captured for the whole run and checked at the end:
   no password, session token, verification token, reset token, OAuth
   code, ID token, PKCE verifier, state value, API key or email body may
   appear in it. That test is at the bottom and it reads everything the
   other tests caused to be logged.
   ========================================================= */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

/* ---------------------------------------------------------
   Configuration, before anything is required
   --------------------------------------------------------- */

const AUTH_SECRET = 'test-auth-secret-of-sufficient-length';
process.env.AUTH_SECRET = AUTH_SECRET;
process.env.STRIPE_SECRET_KEY = 'sk_test_auth_suite';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_auth_suite';
process.env.STRIPE_PRICE_PRO = 'price_pro_test';
process.env.STRIPE_PRICE_MAX = 'price_max_test';
process.env.OPENWEBNINJA_API_KEY = 'test-product-source-key';

/* A fake Google, with a real key */
process.env.GOOGLE_CLIENT_ID = 'fynd-test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'google-client-secret-value';
process.env.GOOGLE_AUTH_URL = 'https://accounts.google.test/o/oauth2/v2/auth';
process.env.GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.test/token';
process.env.GOOGLE_JWKS_URL = 'https://www.googleapis.test/oauth2/v3/certs';
process.env.GOOGLE_ISSUER = 'https://accounts.google.test';

/* A fake Resend */
process.env.RESEND_API_KEY = 'test-resend-api-key';
process.env.EMAIL_FROM = 'Fynd <hello@fynd.test>';

const store = require('../api/_store');
const users = require('../api/_users');
const auth = require('../api/_auth');
const tokens = require('../api/_tokens');
const usage = require('../api/_usage');
const plans = require('../api/_plans');
const emailer = require('../api/_email');
const google = require('../api/_google');

const authEndpoint = require('../api/auth');
const accountEndpoint = require('../api/account');
const verifyEndpoint = require('../api/verify-email');
const googleStart = require('../api/google-start');
const googleCallback = require('../api/google-callback');
const checkoutEndpoint = require('../api/checkout');
const portalEndpoint = require('../api/portal');
const searchEndpoint = require('../api/search');
const webhookEndpoint = require('../api/stripe-webhook');

/* ---------------------------------------------------------
   Capturing what gets logged
   --------------------------------------------------------- */

const logged = [];
['log', 'warn', 'error'].forEach((level) => {
  const original = console[level];
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    if (process.env.SHOW_LOGS) original(...args);
  };
});

/* Every secret this suite creates, so the log check has something
   concrete to look for rather than a guess at a pattern. */
const SECRETS = new Set();
const secretly = (value) => { if (value) SECRETS.add(String(value)); return value; };

/* ---------------------------------------------------------
   The fake internet
   --------------------------------------------------------- */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'fynd-test-key', alg: 'RS256', use: 'sig' });

const sentEmails = [];
const stripeCalls = [];
const tokenExchanges = [];

/* What the fake Google will mint for the next code exchange. */
let nextIdToken = null;
let tokenEndpointFails = false;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mintIdToken(claims, options) {
  const o = options || {};
  const header = b64({ alg: o.alg || 'RS256', kid: o.kid || 'fynd-test-key', typ: 'JWT' });
  const body = b64(claims);
  if (o.alg === 'none') return `${header}.${body}.`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), o.key || privateKey);
  return `${header}.${body}.${signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/* Claims Google would send for a signed-in person. */
const googleClaims = (over) => Object.assign({
  iss: 'https://accounts.google.test',
  aud: process.env.GOOGLE_CLIENT_ID,
  azp: process.env.GOOGLE_CLIENT_ID,
  sub: '1098765432100',
  email: 'ada@gmail.test',
  email_verified: true,
  name: 'Ada Lovelace',
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000)
}, over);

global.fetch = async (url, options) => {
  const href = String(url);
  const body = (options && options.body) || '';
  const reply = (payload, ok) => ({ ok: ok !== false, status: ok === false ? 400 : 200, json: async () => payload });

  if (href.startsWith(process.env.GOOGLE_JWKS_URL)) return reply({ keys: [JWK] });

  if (href.startsWith(process.env.GOOGLE_TOKEN_URL)) {
    const params = new URLSearchParams(body);
    tokenExchanges.push(params);
    if (tokenEndpointFails) return reply({ error: 'invalid_grant' }, false);
    return reply({ access_token: secretly('google-access-token-value'), id_token: nextIdToken, token_type: 'Bearer' });
  }

  if (href.startsWith('https://api.resend.com/')) {
    sentEmails.push(JSON.parse(body));
    return reply({ id: 'email_1' });
  }

  if (href.startsWith('https://api.stripe.com/')) {
    const params = new URLSearchParams(body);
    stripeCalls.push({ href, params });
    if (href.endsWith('/v1/customers')) return reply({ id: `cus_${crypto.randomBytes(5).toString('hex')}` });
    if (href.endsWith('/v1/checkout/sessions')) return reply({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
    if (href.endsWith('/v1/billing_portal/sessions')) return reply({ id: 'bps_1', url: 'https://billing.stripe.com/p/1' });
    return reply({ error: { message: 'not stubbed' } }, false);
  }

  throw new Error(`unexpected outbound request to ${href}`);
};

/* ---------------------------------------------------------
   Requests and responses
   --------------------------------------------------------- */

function makeRes() {
  return {
    statusCode: 200, headers: {}, payload: null, ended: false,
    setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
    getHeader(n) { return this.headers[String(n).toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; this.ended = true; return this; },
    end() { this.ended = true; return this; },
    get location() { return this.getHeader('location'); }
  };
}

const makeReq = (over) => Object.assign({
  method: 'POST', url: '/', headers: { host: 'fynd.test' },
  socket: { remoteAddress: '203.0.113.5' }, on() { return this; }
}, over || {});

function cookiesFrom(res, existing) {
  const jar = Object.assign({}, existing || {});
  [].concat(res.getHeader('Set-Cookie') || []).forEach((line) => {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    const name = pair.slice(0, at).trim();
    const value = decodeURIComponent(pair.slice(at + 1).trim());
    if (value === '') delete jar[name];
    else jar[name] = value;
  });
  return jar;
}

const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');

async function call(endpoint, opts) {
  const o = opts || {};
  const res = makeRes();
  const jar = o.jar || {};
  const session = jar.fynd_session;
  const csrf = session && !o.omitCsrf ? { 'x-fynd-csrf': auth.csrfTokenFor(session) } : {};

  const req = makeReq({
    method: o.method || 'POST',
    url: o.url || '/',
    body: o.body,
    headers: Object.assign({ host: 'fynd.test' },
      Object.keys(jar).length ? { cookie: cookieHeader(jar) } : {}, csrf, o.headers || {})
  });

  await endpoint(req, res);

  /* Only what THIS response set counts as a secret. Reading it out of
     the merged jar would also sweep up the forged cookies the tests
     make up themselves — including ones made from a user id, which is
     not a secret and which the logs are supposed to carry. */
  const issued = cookiesFrom(res, {});
  if (issued.fynd_session) secretly(issued.fynd_session);

  return { res, jar: cookiesFrom(res, jar) };
}

/* ---------------------------------------------------------
   Fixtures
   --------------------------------------------------------- */

const PASSWORD = secretly('correct-horse-battery-staple');
const WRONG = secretly('not-the-right-password-at-all');

const signup = (over) => call(authEndpoint, {
  body: Object.assign({
    action: 'signup', name: 'Ada Lovelace', email: 'ada@example.test',
    password: PASSWORD, confirmPassword: PASSWORD
  }, over || {})
});

const login = (email, password, jar) => call(authEndpoint, {
  jar: jar || {}, body: { action: 'login', email, password }
});

/* The token from the most recent verification email, taken out of the
   link the way a person clicks it. */
function tokenFromLastEmail() {
  const last = sentEmails[sentEmails.length - 1];
  if (!last) return null;
  const match = /token=([A-Za-z0-9_-]+)/.exec(last.text || '');
  return match ? secretly(match[1]) : null;
}

function resetTokenFromLastEmail() {
  const last = sentEmails[sentEmails.length - 1];
  if (!last) return null;
  const match = /[?&]reset=([A-Za-z0-9_-]+)/.exec(last.text || '');
  return match ? secretly(match[1]) : null;
}

/* Signs up and confirms the address by following the emailed link. */
async function verifiedUser(over) {
  const created = await signup(over);
  const token = tokenFromLastEmail();
  await call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${token}` });
  const user = await users.byEmail((over && over.email) || 'ada@example.test');
  return { jar: created.jar, user, token };
}

/* Runs a whole Google sign-in and hands back the callback's response. */
async function googleSignIn(options) {
  const o = options || {};
  const started = await call(googleStart, { method: 'GET', url: '/api/google-start', jar: o.jar || {} });
  const location = started.res.location || '';
  const state = new URL(location).searchParams.get('state');
  const nonce = new URL(location).searchParams.get('nonce');
  secretly(state); secretly(nonce);

  nextIdToken = o.idToken !== undefined
    ? o.idToken
    : mintIdToken(googleClaims(Object.assign({ nonce }, o.claims)), o.tokenOptions);
  if (nextIdToken) secretly(nextIdToken);

  const jar = o.callbackJar || started.jar;
  const callbackUrl = `/api/google-callback?${new URLSearchParams(Object.assign({
    code: secretly('google-authorization-code'), state: o.state === undefined ? state : o.state
  }, o.extraParams || {})).toString()}`;

  const finished = await call(googleCallback, { method: 'GET', url: callbackUrl, jar });
  return { started, finished, state, nonce, location };
}

/* ---------------------------------------------------------
   Runner
   --------------------------------------------------------- */

let passed = 0;
const failures = [];

async function test(name, fn) {
  store.reset();
  google.resetJwksCache();
  sentEmails.length = 0;
  stripeCalls.length = 0;
  tokenExchanges.length = 0;
  tokenEndpointFails = false;
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
    if (process.env.SHOW_LOGS !== '1') process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name}\n        ${err && err.message}\n`);
  }
}

const section = (title) => process.stdout.write(`\n${title}\n`);

(async () => {

/* =========================================================
   Email sign-up
   ========================================================= */
section('email sign-up');

await test('creating an account stores a name, an address and no password', async () => {
  const { res } = await signup();
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.payload));
  assert.strictEqual(res.payload.signedIn, true);
  assert.strictEqual(res.payload.user.email, 'ada@example.test');
  assert.strictEqual(res.payload.user.name, 'Ada Lovelace');

  const stored = await users.byEmail('ada@example.test');
  assert.ok(stored.passwordHash.startsWith('scrypt$'), 'the password must be hashed with scrypt');
  assert.ok(!JSON.stringify(stored).includes(PASSWORD), 'the plaintext password must not be stored anywhere');
});

await test('a new account is unverified, and says so', async () => {
  const { res } = await signup();
  assert.strictEqual(res.payload.emailVerified, false);
  assert.strictEqual(res.payload.user.emailVerified, false);
  assert.strictEqual((await users.byEmail('ada@example.test')).emailVerified, false);
});

await test('signing up sends exactly one verification email, to that address', async () => {
  await signup();
  assert.strictEqual(sentEmails.length, 1);
  assert.strictEqual(sentEmails[0].to[0], 'ada@example.test');
  assert.ok(/confirm/i.test(sentEmails[0].subject), sentEmails[0].subject);
  assert.ok(/\/api\/verify-email\?token=/.test(sentEmails[0].text), 'the link must reach the endpoint');
  assert.ok(!sentEmails[0].text.includes(PASSWORD), 'no email may contain a password');
});

await test('the confirmation link carries a token and nothing else about the account', async () => {
  await signup();
  const url = /https?:\/\/\S+/.exec(sentEmails[0].text)[0];
  const parsed = new URL(url);
  assert.deepStrictEqual([...parsed.searchParams.keys()], ['token']);
  assert.ok(!/ada@example\.test/.test(url), 'the address must not be in the URL');
  assert.strictEqual(parsed.searchParams.get('token').length, 43);
});

await test('a mismatched confirmation is refused and no account is made', async () => {
  const { res } = await signup({ confirmPassword: 'something-else-entirely' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.field, 'confirmPassword');
  assert.strictEqual(await users.byEmail('ada@example.test'), null);
});

await test('a short password is refused and no account is made', async () => {
  const { res } = await signup({ password: 'short', confirmPassword: 'short' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.field, 'password');
  assert.strictEqual(await users.byEmail('ada@example.test'), null);
});

await test('a missing name is refused', async () => {
  const { res } = await signup({ name: '   ' });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.field, 'name');
});

await test('a duplicate address is refused, and the first account is untouched', async () => {
  await signup();
  const first = await users.byEmail('ada@example.test');

  const second = await signup({ name: 'Someone Else', password: WRONG, confirmPassword: WRONG });
  assert.strictEqual(second.res.statusCode, 409);
  assert.strictEqual(second.res.payload.reason, 'email-taken');

  const after = await users.byEmail('ada@example.test');
  assert.strictEqual(after.id, first.id);
  assert.strictEqual(after.name, 'Ada Lovelace', 'the second attempt must not overwrite the first');
  assert.strictEqual(after.passwordHash, first.passwordHash);
});

await test('five simultaneous sign-ups for one address make one account', async () => {
  const attempts = await Promise.all(Array.from({ length: 5 }, () => signup({ email: 'race@example.test' })));
  assert.strictEqual(attempts.filter((a) => a.res.statusCode === 200).length, 1);
});

/* =========================================================
   Verification
   ========================================================= */
section('email verification');

await test('following the link verifies the account', async () => {
  await signup();
  const token = tokenFromLastEmail();

  const { res } = await call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${token}` });
  assert.strictEqual(res.statusCode, 302);
  assert.ok(/verify=success/.test(res.location), res.location);
  assert.strictEqual((await users.byEmail('ada@example.test')).emailVerified, true);
});

await test('the link works once — a second click reports it used', async () => {
  await signup();
  const token = tokenFromLastEmail();

  const first = await call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${token}` });
  assert.ok(/verify=success/.test(first.res.location));

  const second = await call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${token}` });
  assert.ok(/verify=error/.test(second.res.location), second.res.location);
  assert.ok(/reason=invalid/.test(second.res.location), second.res.location);
});

await test('ten simultaneous clicks on one link are honoured once', async () => {
  await signup();
  const token = tokenFromLastEmail();
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${token}` })));
  const succeeded = results.filter((r) => /verify=success/.test(r.res.location));
  assert.strictEqual(succeeded.length, 1, `${succeeded.length} of ten clicks were honoured`);
});

await test('an expired link is refused, and says it expired', async () => {
  await signup();
  const user = await users.byEmail('ada@example.test');

  /* issued with a TTL that has already elapsed */
  const { token } = await tokens.issue(tokens.PURPOSE.VERIFY_EMAIL,
    { userId: user.id, email: user.email, site: 'https://fynd.test' }, { ttlSeconds: 1 });
  const key = `token:${tokens.PURPOSE.VERIFY_EMAIL}:${crypto.createHmac('sha256', AUTH_SECRET)
    .update(`${tokens.PURPOSE.VERIFY_EMAIL}:${token}`).digest('hex')}`;
  const record = await store.get(key);
  await store.set(key, Object.assign({}, record, { expiresAt: Date.now() - 1000 }));

  const { res } = await call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${token}` });
  assert.ok(/reason=expired/.test(res.location), res.location);
  assert.strictEqual((await users.byId(user.id)).emailVerified, false);
});

await test('an invented token is refused', async () => {
  await signup();
  for (const token of ['A'.repeat(43), 'nonsense', '', '../../etc/passwd']) {
    const { res } = await call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${encodeURIComponent(token)}` });
    assert.ok(/verify=error/.test(res.location), `${token} -> ${res.location}`);
  }
  assert.strictEqual((await users.byEmail('ada@example.test')).emailVerified, false);
});

await test('a verification token cannot be spent as a password reset', async () => {
  await signup();
  const token = tokenFromLastEmail();
  const { res } = await call(authEndpoint, {
    body: { action: 'reset-password', token, password: 'a-brand-new-password', confirmPassword: 'a-brand-new-password' }
  });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual((await users.byEmail('ada@example.test')).emailVerified, false, 'and it is not consumed either');
});

await test('a token for one account cannot verify another', async () => {
  await signup({ email: 'first@example.test' });
  const token = tokenFromLastEmail();
  await signup({ email: 'second@example.test' });

  await call(verifyEndpoint, { method: 'GET', url: `/api/verify-email?token=${token}` });
  assert.strictEqual((await users.byEmail('first@example.test')).emailVerified, true);
  assert.strictEqual((await users.byEmail('second@example.test')).emailVerified, false);
});

/* =========================================================
   Resending
   ========================================================= */
section('resending the confirmation');

/* Sign-up sends one and starts the cooldown, so a resend seconds later
   is meant to be refused. Clearing the gap is how these tests get to the
   state where a resend is legitimately due. */
async function clearResendCooldown(userId) {
  for (const subject of [userId, auth.addressSubject(makeReq({}))]) {
    await store.remove(`ratelimit:gap:auth:resend-verification:${subject}`);
  }
}

await test('a signed-in unverified user can ask for another link', async () => {
  const { jar } = await signup();
  const user = await users.byEmail('ada@example.test');
  sentEmails.length = 0;

  /* straight after sign-up, the cooldown holds it back */
  const tooSoon = await call(authEndpoint, { jar, body: { action: 'resend-verification' } });
  assert.strictEqual(tooSoon.res.statusCode, 429);
  assert.strictEqual(sentEmails.length, 0);

  await clearResendCooldown(user.id);
  const { res } = await call(authEndpoint, { jar, body: { action: 'resend-verification' } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload.verification.sent, true);
  assert.strictEqual(sentEmails.length, 1);

  /* and the new link works */
  const { res: verified } = await call(verifyEndpoint, {
    method: 'GET', url: `/api/verify-email?token=${tokenFromLastEmail()}`
  });
  assert.ok(/verify=success/.test(verified.location));
});

await test('resending is refused without a session', async () => {
  await signup();
  const { res } = await call(authEndpoint, { body: { action: 'resend-verification' } });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.payload.reason, 'sign-in-required');
});

await test('resending is refused without the CSRF token', async () => {
  const { jar } = await signup();
  const { res } = await call(authEndpoint, { jar, omitCsrf: true, body: { action: 'resend-verification' } });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.payload.reason, 'csrf');
});

await test('resending is rate limited, per account and per address', async () => {
  const { jar } = await signup();
  const user = await users.byEmail('ada@example.test');

  /* the cooldown stops the second one immediately */
  const immediate = await call(authEndpoint, { jar, body: { action: 'resend-verification' } });
  assert.strictEqual(immediate.res.statusCode, 429);
  assert.strictEqual(immediate.res.payload.reason, 'too-soon');
  assert.ok(immediate.res.payload.retryAfter > 0);

  /* past the cooldown, the hourly ceiling still applies — so somebody
     who waits out the gap each time still cannot use one mailbox as a
     mail relay */
  const sentBefore = sentEmails.length;
  let refused = null;
  for (let i = 0; i < 10; i += 1) {
    await clearResendCooldown(user.id);
    const attempt = await call(authEndpoint, { jar, body: { action: 'resend-verification' } });
    if (attempt.res.statusCode === 429) { refused = attempt.res.payload.reason; break; }
  }
  assert.strictEqual(refused, 'too-many', 'the hourly ceiling should stop this');
  assert.ok(sentEmails.length - sentBefore <= 5, 'no more than the ceiling may actually be sent');
});

await test('an already-verified account is told so rather than sent another', async () => {
  const { jar } = await verifiedUser();
  sentEmails.length = 0;
  const { res } = await call(authEndpoint, { jar, body: { action: 'resend-verification' } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload.verification.reason, 'already-verified');
  assert.strictEqual(sentEmails.length, 0);
});

await test('with no email provider, nothing pretends an email was sent', async () => {
  const wasKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    assert.strictEqual(emailer.configured(), false);
    const { res } = await signup();
    assert.strictEqual(res.statusCode, 200, 'the account is still created');
    assert.strictEqual(res.payload.verification.sent, false);
    assert.strictEqual(res.payload.verification.reason, 'no-provider');
    assert.strictEqual(sentEmails.length, 0);
    assert.strictEqual(res.payload.accounts.email.configured, false);
    assert.strictEqual((await users.byEmail('ada@example.test')).emailVerified, false,
      'and nobody is verified by the absence of a provider');
  } finally {
    process.env.RESEND_API_KEY = wasKey;
  }
});

/* =========================================================
   Logging in
   ========================================================= */
section('logging in');

await test('the right password signs you in', async () => {
  await signup();
  const { res, jar } = await login('ada@example.test', PASSWORD);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.payload.signedIn, true);
  assert.ok(jar.fynd_session, 'a session cookie should be set');
});

await test('the wrong password is refused', async () => {
  await signup();
  const { res, jar } = await login('ada@example.test', WRONG);
  assert.strictEqual(res.statusCode, 401);
  assert.ok(!jar.fynd_session, 'and no session is issued');
});

await test('a wrong password and an unknown address are indistinguishable', async () => {
  await signup();
  const wrong = await login('ada@example.test', WRONG);
  const unknown = await login('nobody@example.test', PASSWORD);

  assert.strictEqual(wrong.res.statusCode, unknown.res.statusCode);
  assert.deepStrictEqual(wrong.res.payload, unknown.res.payload);
});

await test('a Google-only account cannot be signed into with a password', async () => {
  await googleSignIn();
  const user = await users.byEmail('ada@gmail.test');
  assert.strictEqual(user.passwordHash, null);

  const { res } = await login('ada@gmail.test', PASSWORD);
  assert.strictEqual(res.statusCode, 401, 'and it says nothing about why');
});

await test('an unverified account can sign in, and is not treated as verified', async () => {
  await signup();
  const { res, jar } = await login('ada@example.test', PASSWORD);

  assert.strictEqual(res.statusCode, 200, 'they need to reach the page that explains how to verify');
  assert.strictEqual(res.payload.emailVerified, false);

  /* the concrete difference: they cannot start a subscription */
  const checkout = await call(checkoutEndpoint, { jar, body: { plan: 'pro' } });
  assert.strictEqual(checkout.res.statusCode, 403);
  assert.strictEqual(checkout.res.payload.reason, 'email-unverified');
  assert.ok(!stripeCalls.length, 'nothing may be created at Stripe for an unverified account');
});

await test('verifying then unlocks subscribing', async () => {
  const { jar } = await verifiedUser();
  const { res } = await call(checkoutEndpoint, { jar, body: { plan: 'pro' } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.payload));
  assert.ok(res.payload.url.startsWith('https://checkout.stripe.com/'));
});

await test('repeated wrong passwords are rate limited', async () => {
  await signup();
  let limited = false;
  for (let i = 0; i < 14; i += 1) {
    const { res } = await login('ada@example.test', WRONG);
    if (res.statusCode === 429) { limited = true; break; }
  }
  assert.ok(limited, 'guessing must be stopped before it gets far');
});

await test('a correct sign-in clears the failure count', async () => {
  await signup();
  for (let i = 0; i < 5; i += 1) await login('ada@example.test', WRONG);
  const good = await login('ada@example.test', PASSWORD);
  assert.strictEqual(good.res.statusCode, 200);
  const again = await login('ada@example.test', WRONG);
  assert.strictEqual(again.res.statusCode, 401, 'not 429 — the counter was reset');
});

/* =========================================================
   Sessions
   ========================================================= */
section('sessions');

await test('the session cookie is HttpOnly, SameSite and Secure', async () => {
  const { res } = await signup();
  const cookie = [].concat(res.getHeader('Set-Cookie')).find((c) => c.startsWith('fynd_session='));
  assert.ok(/HttpOnly/.test(cookie), cookie);
  assert.ok(/SameSite=/.test(cookie), cookie);
  assert.ok(/Secure/.test(cookie), cookie);
  assert.ok(/Max-Age=\d+/.test(cookie), cookie);
});

await test('the cookie is an opaque token that says nothing about the account', async () => {
  const { jar } = await signup();
  const user = await users.byEmail('ada@example.test');
  assert.match(jar.fynd_session, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!jar.fynd_session.includes(user.id));
  assert.ok(!jar.fynd_session.includes('ada'));
});

await test('the session token is not what is stored', async () => {
  const { jar } = await signup();
  /* the record is under an HMAC of the token, so a store dump is not a
     set of usable cookies */
  assert.strictEqual(await store.get(`session:${jar.fynd_session}`), null);
  assert.ok(await store.get(auth.sessionKey(jar.fynd_session)), 'the record exists under its fingerprint');
});

await test('a session survives across requests', async () => {
  const { jar } = await signup();
  for (let i = 0; i < 3; i += 1) {
    const { res } = await call(accountEndpoint, { method: 'GET', jar });
    assert.strictEqual(res.payload.signedIn, true, `request ${i + 1}`);
  }
});

await test('logging out ends the session everywhere, not just in the browser', async () => {
  const { jar } = await signup();
  const token = jar.fynd_session;

  const out = await call(authEndpoint, { jar, body: { action: 'logout' } });
  assert.strictEqual(out.res.payload.signedIn, false);
  assert.ok(!out.jar.fynd_session, 'the cookie is cleared');

  /* the important half: a kept copy of the old cookie is dead too */
  const replay = await call(accountEndpoint, { method: 'GET', jar: { fynd_session: token } });
  assert.strictEqual(replay.res.payload.signedIn, false, 'the record must be gone, not just the cookie');
  assert.strictEqual(await store.get(auth.sessionKey(token)), null);
});

await test('logging out is refused without the CSRF token', async () => {
  const { jar } = await signup();
  const { res } = await call(authEndpoint, { jar, omitCsrf: true, body: { action: 'logout' } });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.payload.reason, 'csrf');
  const still = await call(accountEndpoint, { method: 'GET', jar });
  assert.strictEqual(still.res.payload.signedIn, true, 'and the session is still alive');
});

await test('authenticating rotates the session', async () => {
  const { jar: before } = await signup();
  const planted = before.fynd_session;

  const after = await login('ada@example.test', PASSWORD, before);
  assert.notStrictEqual(after.jar.fynd_session, planted, 'a new token must be issued');
  assert.strictEqual(await store.get(auth.sessionKey(planted)), null, 'and the old record destroyed');

  const replay = await call(accountEndpoint, { method: 'GET', jar: { fynd_session: planted } });
  assert.strictEqual(replay.res.payload.signedIn, false);
});

await test('an expired session is refused and cleaned up', async () => {
  const { jar } = await signup();
  const key = auth.sessionKey(jar.fynd_session);
  const record = await store.get(key);
  await store.set(key, Object.assign({}, record, { expiresAt: Date.now() - 1000 }));

  const { res } = await call(accountEndpoint, { method: 'GET', jar });
  assert.strictEqual(res.payload.signedIn, false);
  assert.strictEqual(await store.get(key), null, 'the expired record is removed');
});

await test('a forged session is refused, in every shape', async () => {
  const { user } = await verifiedUser();
  const forgeries = ['A'.repeat(43), 'x', '', user.id, `${user.id}.0.0.0`, '../../session'];
  for (const token of forgeries) {
    const { res } = await call(accountEndpoint, { method: 'GET', jar: { fynd_session: token } });
    assert.strictEqual(res.payload.signedIn, false, `"${token.slice(0, 20)}" must not sign anybody in`);
    assert.strictEqual(res.payload.plan.id, 'free');
  }
});

await test('a session minted under a different secret is refused', async () => {
  const { user } = await signup().then(() => users.byEmail('ada@example.test')).then((u) => ({ user: u }));
  const was = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'a-completely-different-secret-here';
  const forged = await auth.issueSession(user.id, { epoch: 0 });
  process.env.AUTH_SECRET = was;

  const { res } = await call(accountEndpoint, { method: 'GET', jar: { fynd_session: forged } });
  assert.strictEqual(res.payload.signedIn, false);
});

await test('the CSRF token is useless without the session cookie', async () => {
  const { jar } = await verifiedUser();
  const csrf = auth.csrfTokenFor(jar.fynd_session);

  /* an attacker's page can send a header but cannot send the HttpOnly
     cookie from another origin — modelled here as the header alone */
  const { res } = await call(checkoutEndpoint, {
    body: { plan: 'pro' }, headers: { 'x-fynd-csrf': csrf }
  });
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.payload.reason, 'sign-in-required');
});

/* =========================================================
   Google
   ========================================================= */
section('Google sign-in');

await test('the start endpoint redirects to Google with state, nonce and PKCE', async () => {
  const { res, jar } = await call(googleStart, { method: 'GET', url: '/api/google-start' });
  assert.strictEqual(res.statusCode, 302);

  const url = new URL(res.location);
  assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.test/o/oauth2/v2/auth');
  assert.strictEqual(url.searchParams.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.strictEqual(url.searchParams.get('response_type'), 'code');
  assert.strictEqual(url.searchParams.get('scope'), 'openid email profile');
  assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'), 'a PKCE challenge is required');
  assert.ok(url.searchParams.get('state'), 'a state value is required');
  assert.ok(url.searchParams.get('nonce'), 'a nonce is required');
  assert.strictEqual(url.searchParams.get('redirect_uri'), 'https://fynd.test/api/google-callback');
  assert.ok(jar.fynd_oauth, 'the browser is bound to this flow with a cookie');

  /* the verifier itself must never leave the server */
  assert.ok(!res.location.includes('code_verifier'), res.location);
});

await test('a successful Google sign-in creates a verified account', async () => {
  const { finished } = await googleSignIn();
  assert.strictEqual(finished.res.statusCode, 302);
  assert.ok(/auth=signed-in/.test(finished.res.location), finished.res.location);

  const user = await users.byEmail('ada@gmail.test');
  assert.ok(user, 'an account should exist');
  assert.strictEqual(user.emailVerified, true, 'Google proved the address');
  assert.strictEqual(user.name, 'Ada Lovelace');
  assert.strictEqual(user.passwordHash, null, 'no password is invented for them');
  assert.strictEqual(user.googleSub, '1098765432100');
  assert.ok(finished.jar.fynd_session, 'and they are signed in');
});

await test('the code is exchanged server-side with the secret and the PKCE verifier', async () => {
  await googleSignIn();
  assert.strictEqual(tokenExchanges.length, 1);
  const sent = tokenExchanges[0];
  assert.strictEqual(sent.get('grant_type'), 'authorization_code');
  assert.strictEqual(sent.get('client_secret'), process.env.GOOGLE_CLIENT_SECRET);
  assert.ok(sent.get('code_verifier'), 'PKCE verifier must be sent');
  assert.strictEqual(sent.get('redirect_uri'), 'https://fynd.test/api/google-callback');
});

await test('signing in twice with Google reuses the one account', async () => {
  await googleSignIn();
  const first = await users.byEmail('ada@gmail.test');
  await googleSignIn();
  const second = await users.byEmail('ada@gmail.test');
  assert.strictEqual(first.id, second.id, 'a second sign-in must not make a second account');
});

await test('Google signs you into the password account with the same address', async () => {
  await signup({ email: 'ada@gmail.test' });
  const original = await users.byEmail('ada@gmail.test');

  const { finished } = await googleSignIn();
  assert.ok(/auth=signed-in/.test(finished.res.location));

  const after = await users.byEmail('ada@gmail.test');
  assert.strictEqual(after.id, original.id, 'one account, not two');
  assert.strictEqual(after.googleSub, '1098765432100', 'Google is attached to it');
  assert.ok(after.passwordHash, 'and the password still works');
  assert.strictEqual(after.emailVerified, true, 'Google proved the address');
});

await test('a Google address Google has not verified cannot take an existing account', async () => {
  await signup({ email: 'ada@gmail.test' });
  const original = await users.byEmail('ada@gmail.test');

  const { finished } = await googleSignIn({ claims: { email_verified: false } });
  assert.ok(/auth=error/.test(finished.res.location), finished.res.location);
  assert.ok(/google-email-unverified/.test(finished.res.location));
  assert.ok(!finished.jar.fynd_session, 'nobody is signed in');

  const after = await users.byId(original.id);
  assert.strictEqual(after.googleSub, null, 'and nothing was attached');
});

await test('a state value that was never issued is refused', async () => {
  const { finished } = await googleSignIn({ state: 'A'.repeat(43) });
  assert.ok(/auth=error/.test(finished.res.location), finished.res.location);
  assert.ok(/state-mismatch/.test(finished.res.location));
  assert.strictEqual(await users.byEmail('ada@gmail.test'), null);
});

await test('a state value cannot be replayed', async () => {
  const first = await googleSignIn();
  assert.ok(/auth=signed-in/.test(first.finished.res.location));

  /* the same state, a second time */
  nextIdToken = mintIdToken(googleClaims({ nonce: first.nonce }));
  const replay = await call(googleCallback, {
    method: 'GET',
    url: `/api/google-callback?code=another-code&state=${first.state}`,
    jar: first.started.jar
  });
  assert.ok(/auth=error/.test(replay.res.location), replay.res.location);
  assert.ok(/state-mismatch/.test(replay.res.location));
});

await test('the callback must reach the browser that started the flow', async () => {
  /* the state is genuine; the binding cookie is another browser's */
  const { finished } = await googleSignIn({ callbackJar: { fynd_oauth: 'some-other-browsers-binding' } });
  assert.ok(/state-mismatch/.test(finished.res.location), finished.res.location);
  assert.strictEqual(await users.byEmail('ada@gmail.test'), null);
});

await test('a callback with no binding cookie at all is refused', async () => {
  const { finished } = await googleSignIn({ callbackJar: {} });
  assert.ok(/state-mismatch/.test(finished.res.location), finished.res.location);
});

await test('an ID token signed by the wrong key is refused', async () => {
  const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const { finished } = await googleSignIn({ tokenOptions: { key: otherKey } });
  assert.ok(/verification-failed/.test(finished.res.location), finished.res.location);
  assert.strictEqual(await users.byEmail('ada@gmail.test'), null);
});

await test('an unsigned ID token is refused', async () => {
  const { finished } = await googleSignIn({ tokenOptions: { alg: 'none' } });
  assert.ok(/verification-failed/.test(finished.res.location), finished.res.location);
  assert.strictEqual(await users.byEmail('ada@gmail.test'), null);
});

await test('an ID token for another application is refused', async () => {
  const { finished } = await googleSignIn({
    claims: { aud: 'someone-else.apps.googleusercontent.com', azp: 'someone-else.apps.googleusercontent.com' }
  });
  assert.ok(/verification-failed/.test(finished.res.location), finished.res.location);
  assert.strictEqual(await users.byEmail('ada@gmail.test'), null);
});

await test('an ID token from another issuer is refused', async () => {
  const { finished } = await googleSignIn({ claims: { iss: 'https://accounts.evil.test' } });
  assert.ok(/verification-failed/.test(finished.res.location), finished.res.location);
});

await test('an expired ID token is refused', async () => {
  const { finished } = await googleSignIn({ claims: { exp: Math.floor(Date.now() / 1000) - 60 } });
  assert.ok(/verification-failed/.test(finished.res.location), finished.res.location);
});

await test('an ID token minted for a different sign-in is refused', async () => {
  const { finished } = await googleSignIn({ claims: { nonce: 'a-nonce-from-somewhere-else' } });
  assert.ok(/verification-failed/.test(finished.res.location), finished.res.location);
  assert.strictEqual(await users.byEmail('ada@gmail.test'), null);
});

await test('a tampered ID token is refused', async () => {
  const started = await call(googleStart, { method: 'GET', url: '/api/google-start' });
  const url = new URL(started.res.location);
  const honest = mintIdToken(googleClaims({ nonce: url.searchParams.get('nonce') }));
  const parts = honest.split('.');
  parts[1] = b64(googleClaims({ nonce: url.searchParams.get('nonce'), email: 'attacker@evil.test' }));
  nextIdToken = parts.join('.');

  const { res } = await call(googleCallback, {
    method: 'GET',
    url: `/api/google-callback?code=c&state=${url.searchParams.get('state')}`,
    jar: started.jar
  });
  assert.ok(/verification-failed/.test(res.location), res.location);
  assert.strictEqual(await users.byEmail('attacker@evil.test'), null);
});

await test('a refused code exchange does not sign anybody in', async () => {
  tokenEndpointFails = true;
  const { finished } = await googleSignIn();
  assert.ok(/verification-failed/.test(finished.res.location), finished.res.location);
  assert.ok(!finished.jar.fynd_session);
});

await test('cancelling at Google is reported as a cancellation, not a failure', async () => {
  const started = await call(googleStart, { method: 'GET', url: '/api/google-start' });
  const { res } = await call(googleCallback, {
    method: 'GET', url: '/api/google-callback?error=access_denied&state=x', jar: started.jar
  });
  assert.ok(/reason=cancelled/.test(res.location), res.location);
});

await test('a callback with no code is refused', async () => {
  const started = await call(googleStart, { method: 'GET', url: '/api/google-start' });
  const url = new URL(started.res.location);
  const { res } = await call(googleCallback, {
    method: 'GET', url: `/api/google-callback?state=${url.searchParams.get('state')}`, jar: started.jar
  });
  assert.ok(/incomplete-callback/.test(res.location), res.location);
});

await test('the callback cannot be redirected off-site by its own query string', async () => {
  const { finished } = await googleSignIn({
    extraParams: { returnPath: 'https://evil.test/steal', site: 'https://evil.test', redirect_uri: 'https://evil.test' }
  });
  assert.ok(finished.res.location.startsWith('https://fynd.test/'), finished.res.location);
  assert.ok(!finished.res.location.includes('evil.test'), finished.res.location);
});

await test('with no Google client configured, the button is not offered and the endpoint declines', async () => {
  const wasId = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  try {
    const { res } = await call(accountEndpoint, { method: 'GET' });
    assert.strictEqual(res.payload.accounts.google, false);

    const started = await call(googleStart, { method: 'GET', url: '/api/google-start' });
    assert.ok(/google-not-configured/.test(started.res.location), started.res.location);
  } finally {
    process.env.GOOGLE_CLIENT_ID = wasId;
  }
});

/* =========================================================
   Password reset
   ========================================================= */
section('password reset');

await test('a reset link is sent, and changes the password', async () => {
  await verifiedUser();
  sentEmails.length = 0;

  const asked = await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  assert.strictEqual(asked.res.statusCode, 200);
  assert.strictEqual(sentEmails.length, 1);
  assert.ok(/reset/i.test(sentEmails[0].subject));

  const token = resetTokenFromLastEmail();
  const NEW = 'a-completely-new-password';
  const done = await call(authEndpoint, {
    body: { action: 'reset-password', token, password: NEW, confirmPassword: NEW }
  });
  assert.strictEqual(done.res.statusCode, 200, JSON.stringify(done.res.payload));

  assert.strictEqual((await login('ada@example.test', NEW)).res.statusCode, 200);
  assert.strictEqual((await login('ada@example.test', PASSWORD)).res.statusCode, 401, 'the old one stops working');
});

await test('resetting a password signs out every other device', async () => {
  const { jar: phone } = await verifiedUser();
  const laptop = (await login('ada@example.test', PASSWORD)).jar;

  await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  const NEW = 'another-brand-new-password';
  await call(authEndpoint, {
    body: { action: 'reset-password', token: resetTokenFromLastEmail(), password: NEW, confirmPassword: NEW }
  });

  for (const [label, jar] of [['phone', phone], ['laptop', laptop]]) {
    const { res } = await call(accountEndpoint, { method: 'GET', jar });
    assert.strictEqual(res.payload.signedIn, false, `${label} should have been signed out`);
  }
});

await test('a reset link works once', async () => {
  await verifiedUser();
  await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  const token = resetTokenFromLastEmail();

  const NEW = 'first-new-password-here';
  const first = await call(authEndpoint, { body: { action: 'reset-password', token, password: NEW, confirmPassword: NEW } });
  assert.strictEqual(first.res.statusCode, 200);

  const AGAIN = 'second-new-password-here';
  const second = await call(authEndpoint, { body: { action: 'reset-password', token, password: AGAIN, confirmPassword: AGAIN } });
  assert.strictEqual(second.res.statusCode, 400);
  assert.strictEqual((await login('ada@example.test', AGAIN)).res.statusCode, 401);
});

await test('an expired reset link is refused', async () => {
  const { user } = await verifiedUser();
  const { token } = await tokens.issue(tokens.PURPOSE.RESET_PASSWORD,
    { userId: user.id, email: user.email, epoch: 0 }, { ttlSeconds: 1 });
  const key = `token:${tokens.PURPOSE.RESET_PASSWORD}:${crypto.createHmac('sha256', AUTH_SECRET)
    .update(`${tokens.PURPOSE.RESET_PASSWORD}:${token}`).digest('hex')}`;
  await store.set(key, Object.assign({}, await store.get(key), { expiresAt: Date.now() - 1000 }));

  const NEW = 'should-not-be-accepted';
  const { res } = await call(authEndpoint, { body: { action: 'reset-password', token, password: NEW, confirmPassword: NEW } });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.payload.reason, 'expired');
});

await test('an older reset link stops working once a newer one is used', async () => {
  await verifiedUser();
  await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  const older = resetTokenFromLastEmail();

  await store.remove('ratelimit:gap:auth:forgot-password:ada@example.test');
  await store.remove(`ratelimit:gap:auth:forgot-password:${auth.addressSubject(makeReq({}))}`);
  await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  const newer = resetTokenFromLastEmail();
  assert.notStrictEqual(older, newer);

  const A = 'newer-link-password-value';
  assert.strictEqual((await call(authEndpoint, {
    body: { action: 'reset-password', token: newer, password: A, confirmPassword: A }
  })).res.statusCode, 200);

  const B = 'older-link-password-value';
  const stale = await call(authEndpoint, { body: { action: 'reset-password', token: older, password: B, confirmPassword: B } });
  assert.strictEqual(stale.res.statusCode, 400);
  assert.strictEqual(stale.res.payload.reason, 'superseded');
});

await test('forgot-password answers the same for a real address and an invented one', async () => {
  await verifiedUser();

  /* The per-address cooldown is shared by both attempts and would
     otherwise be the thing that made the two answers differ — which
     would hide the property actually under test. It has its own test
     below. */
  const clearGap = () => store.remove(`ratelimit:gap:auth:forgot-password:${auth.addressSubject(makeReq({}))}`);

  const known = await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  await clearGap();
  const unknown = await call(authEndpoint, { body: { action: 'forgot-password', email: 'nobody@example.test' } });

  assert.strictEqual(known.res.statusCode, 200);
  assert.strictEqual(known.res.statusCode, unknown.res.statusCode);
  assert.deepStrictEqual(known.res.payload, unknown.res.payload);
  assert.ok(!JSON.stringify(known.res.payload).includes('ada'), 'the reply must not echo the address either');
});

await test('no reset link is sent for an account that has no password', async () => {
  await googleSignIn();
  sentEmails.length = 0;
  const { res } = await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@gmail.test' } });
  assert.strictEqual(res.statusCode, 200, 'and it still says the same thing');
  assert.strictEqual(sentEmails.length, 0, 'a reset would set a password the owner never had');
});

await test('forgot-password is rate limited', async () => {
  await verifiedUser();
  const first = await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  assert.strictEqual(first.res.statusCode, 200);
  const second = await call(authEndpoint, { body: { action: 'forgot-password', email: 'ada@example.test' } });
  assert.strictEqual(second.res.statusCode, 429);
});

/* =========================================================
   Account data
   ========================================================= */
section('account data');

await test('a signed-out caller gets no account data at all', async () => {
  await verifiedUser();
  const { res } = await call(accountEndpoint, { method: 'GET' });

  assert.strictEqual(res.payload.signedIn, false);
  assert.strictEqual(res.payload.user, null);
  const body = JSON.stringify(res.payload);
  assert.ok(!body.includes('ada@example.test'), 'no address may leak to an anonymous caller');
  assert.ok(!body.includes('Ada Lovelace'));
});

await test('one account cannot read another', async () => {
  await verifiedUser({ email: 'first@example.test' });
  const second = await verifiedUser({ email: 'second@example.test', name: 'Second Person' });

  const { res } = await call(accountEndpoint, { method: 'GET', jar: second.jar });
  assert.strictEqual(res.payload.user.email, 'second@example.test');
  assert.ok(!JSON.stringify(res.payload).includes('first@example.test'));
});

await test('the account reply never carries a hash, a token or a Stripe id', async () => {
  const { jar } = await verifiedUser();
  await call(checkoutEndpoint, { jar, body: { plan: 'pro' } });

  const { res } = await call(accountEndpoint, { method: 'GET', jar });
  const body = JSON.stringify(res.payload);
  const stored = await users.byEmail('ada@example.test');

  assert.ok(!/scrypt\$/.test(body), 'no password hash');
  assert.ok(!body.includes(stored.passwordHash), 'no password hash');
  assert.ok(!body.includes(stored.stripeCustomerId), 'no Stripe customer id');
  assert.ok(!body.includes(jar.fynd_session), 'no session token');
  assert.ok(!/sk_test_|whsec_|price_|RESEND|GOOGLE_CLIENT_SECRET/.test(body), 'no key material');
  assert.ok(!body.includes(process.env.GOOGLE_CLIENT_SECRET), 'no Google secret');
});

await test('/api/account is GET-only, so there is no way to write anything', async () => {
  const { jar } = await verifiedUser();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { res } = await call(accountEndpoint, { method, jar, body: { emailVerified: true, plan: 'max' } });
    assert.strictEqual(res.statusCode, 405, method);
  }
});

await test('nobody can verify their own address by asking', async () => {
  const { jar } = await signup();
  for (const body of [{ emailVerified: true }, { user: { emailVerified: true } }, { action: 'verify' }]) {
    await call(authEndpoint, { jar, body });
  }
  assert.strictEqual((await users.byEmail('ada@example.test')).emailVerified, false);
});

await test('a request from an origin that is not allowed is refused', async () => {
  const { jar } = await verifiedUser();
  const hostile = { origin: 'https://evil.test' };
  for (const [name, endpoint, body] of [
    ['auth', authEndpoint, { action: 'logout' }],
    ['checkout', checkoutEndpoint, { plan: 'pro' }],
    ['portal', portalEndpoint, {}],
    ['search', searchEndpoint, { intent: {} }]
  ]) {
    const { res } = await call(endpoint, { jar, headers: hostile, body });
    assert.strictEqual(res.statusCode, 403, `${name} should refuse a hostile origin`);
  }
  const account = await call(accountEndpoint, { method: 'GET', jar, headers: hostile });
  assert.strictEqual(account.res.statusCode, 403);
});

/* =========================================================
   The account is the identity behind billing and usage
   ========================================================= */
section('subscription and usage follow the account');

const stripeSub = (customer, priceId) => ({
  id: 'sub_test', customer, status: 'active', cancel_at_period_end: false,
  current_period_end: 1893456000, metadata: {},
  items: { data: [{ id: 'si_1', price: { id: priceId } }] }
});

async function deliverSubscription(customer, priceId, type) {
  const event = {
    id: `evt_${crypto.randomBytes(4).toString('hex')}`, created: Math.floor(Date.now() / 1000),
    type: type || 'customer.subscription.created', data: { object: stripeSub(customer, priceId) }
  };
  const raw = JSON.stringify(event);
  const t = event.created;
  const sig = `t=${t},v1=${crypto.createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex')}`;
  const res = makeRes();
  await webhookEndpoint(makeReq({ body: Buffer.from(raw), headers: { host: 'fynd.test', 'stripe-signature': sig } }), res);
  return res;
}

await test('a subscription lands on the account that bought it, not another', async () => {
  const buyer = await verifiedUser({ email: 'buyer@example.test' });
  const bystander = await verifiedUser({ email: 'bystander@example.test' });

  await call(checkoutEndpoint, { jar: buyer.jar, body: { plan: 'pro' } });
  const buyerRecord = await users.byEmail('buyer@example.test');
  assert.ok(buyerRecord.stripeCustomerId);

  const res = await deliverSubscription(buyerRecord.stripeCustomerId, 'price_pro_test');
  assert.strictEqual(res.statusCode, 200);

  assert.strictEqual((await users.byEmail('buyer@example.test')).plan, 'pro');
  assert.strictEqual((await users.byEmail('bystander@example.test')).plan, 'free');

  const seen = await call(accountEndpoint, { method: 'GET', jar: bystander.jar });
  assert.strictEqual(seen.res.payload.plan.id, 'free', 'the bystander sees their own plan');
});

await test('a Google account carries a subscription the same way', async () => {
  await googleSignIn();
  const signedIn = await googleSignIn();
  const user = await users.byEmail('ada@gmail.test');

  await call(checkoutEndpoint, { jar: signedIn.finished.jar, body: { plan: 'max' } });
  const withCustomer = await users.byId(user.id);
  await deliverSubscription(withCustomer.stripeCustomerId, 'price_max_test');

  const { res } = await call(accountEndpoint, { method: 'GET', jar: signedIn.finished.jar });
  assert.strictEqual(res.payload.plan.id, 'max');
  assert.strictEqual(res.payload.usage.searches.limit, 400);
});

await test('usage is counted against the account, and follows it across sign-ins', async () => {
  const { user } = await verifiedUser();
  await usage.record(`user:${user.id}`, 'free', plans.SEARCHES, 2);

  const again = await login('ada@example.test', PASSWORD);
  const { res } = await call(accountEndpoint, { method: 'GET', jar: again.jar });
  assert.strictEqual(res.payload.usage.searches.used, 2, 'a new session sees the same counter');
  assert.strictEqual(res.payload.usage.searches.remaining, 1);
});

await test('two accounts are metered separately', async () => {
  const a = await verifiedUser({ email: 'a@example.test' });
  const b = await verifiedUser({ email: 'b@example.test' });

  await usage.record(`user:${a.user.id}`, 'free', plans.SEARCHES, 3);

  const seenA = await call(accountEndpoint, { method: 'GET', jar: a.jar });
  const seenB = await call(accountEndpoint, { method: 'GET', jar: b.jar });
  assert.strictEqual(seenA.res.payload.usage.searches.remaining, 0);
  assert.strictEqual(seenB.res.payload.usage.searches.remaining, 3);

  const blocked = await call(searchEndpoint, { jar: a.jar, body: { intent: {} } });
  assert.strictEqual(blocked.res.statusCode, 429);
  const allowed = await call(searchEndpoint, { jar: b.jar, body: { intent: {} } });
  assert.notStrictEqual(allowed.res.statusCode, 429);
});

await test('signing out drops back to the anonymous free allowance, not the account’s', async () => {
  const { jar, user } = await verifiedUser();
  await usage.record(`user:${user.id}`, 'free', plans.SEARCHES, 3);

  const out = await call(authEndpoint, { jar, body: { action: 'logout' } });
  const anonymous = await call(accountEndpoint, { method: 'GET', jar: out.jar });
  assert.strictEqual(anonymous.res.payload.signedIn, false);
  assert.strictEqual(anonymous.res.payload.usage.searches.used, 0, 'a different subject entirely');
});

/* =========================================================
   Nothing sensitive is written down
   ========================================================= */
section('what gets logged');

await test('no password, token, code or key appears anywhere in the logs', () => {
  const all = logged.join('\n');

  /* Account ids are deliberately NOT on this list. They are opaque,
     internal, and the one handle that makes a log line diagnosable —
     "verification email for usr_… : sent" is exactly what an operator
     needs, and it identifies nobody outside this system. */
  const named = [...SECRETS].filter((s) => s && s.length >= 8);
  const found = named.filter((secret) => all.includes(secret));
  assert.deepStrictEqual(found.map((f) => `${f.slice(0, 6)}…`), [],
    `these secrets were logged: ${found.map((f) => `${f.slice(0, 6)}…`).join(', ')}`);

  /* and nothing key-shaped, whether or not this suite minted it */
  [
    ['a Stripe secret key', /sk_(test|live)_[A-Za-z0-9]{6,}/],
    ['a Stripe webhook secret', /whsec_[A-Za-z0-9]{6,}/],
    ['a Resend key', /re_[A-Za-z0-9]{10,}/],
    ['the Google client secret', /google-client-secret-value/],
    ['a scrypt hash', /scrypt\$\d+/],
    ['a bearer token', /Bearer\s+\S{8,}/]
  ].forEach(([label, pattern]) => {
    assert.ok(!pattern.test(all), `${label} appears in the logs`);
  });

  assert.ok(all.length > 0, 'the suite should have logged something, or this proves nothing');
});

await test('the logs do say enough to diagnose a failure', () => {
  const all = logged.join('\n');
  assert.ok(/Rejected a Google callback: state-invalid|state-mismatch|binding-mismatch/.test(all),
    'a refused callback should be traceable');
  assert.ok(/Google sign-in failed: (bad-signature|wrong-audience|nonce-mismatch|expired-token|exchange-failed)/.test(all),
    'a refused token should say which check failed');
  assert.ok(/Email verification refused: (invalid|expired)/.test(all));
});

/* ------------------------------------------------------- */

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n\n`);
process.exit(failures.length ? 1 : 0);
})().catch((err) => { process.stdout.write(`${err && err.stack}\n`); process.exit(1); });
