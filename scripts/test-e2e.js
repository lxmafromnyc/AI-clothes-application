#!/usr/bin/env node
/* =========================================================
   Fynd — end-to-end authentication test

   A real browser, driving the real pages, against the real serverless
   handlers over real HTTP. Nothing about Fynd is mocked here: the
   sign-up form posts to api/auth.js, the session is a real cookie the
   browser stores and re-sends, /api/account is the real endpoint, and
   the verification link is followed by actually navigating to it.

   Two things outside Fynd are stood in for, because they are not ours
   to run:

     Google      the authorize page is intercepted and answered with the
                 redirect Google would send. Everything after that — the
                 code exchange, the RS256 signature check against a JWKS,
                 the audience, issuer, expiry and nonce checks — is the
                 real code running against a real signature.

     the mailbox the email provider's HTTP API is answered locally, and
                 the message it was asked to send is kept so the test can
                 follow the link out of it, the way a person opens their
                 inbox and clicks.

   Usage: node scripts/test-e2e.js
   Needs Chromium; skips with a clear message if it is not present.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const PORT = 8901;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — skipping end-to-end tests.');
  process.exit(0);
}

/* ---------------------------------------------------------
   Configuration
   --------------------------------------------------------- */

process.env.AUTH_SECRET = 'end-to-end-secret-of-sufficient-length';
process.env.ALLOWED_ORIGIN = ORIGIN;
process.env.STRIPE_SECRET_KEY = 'sk_test_e2e';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_e2e';
process.env.STRIPE_PRICE_PRO = 'price_pro_e2e';
process.env.STRIPE_PRICE_MAX = 'price_max_e2e';
process.env.OPENWEBNINJA_API_KEY = 'e2e-product-source';

process.env.GOOGLE_CLIENT_ID = 'fynd-e2e.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'e2e-google-secret';
/* Google's authorize page is served by this test's own server (see
   /__google/authorize below), so the browser follows a real redirect
   chain rather than an intercepted one. Everything after it — the code
   exchange and the signature check — is the real code. */
process.env.GOOGLE_AUTH_URL = `http://127.0.0.1:${PORT}/__google/authorize`;
process.env.GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.e2e/token';
process.env.GOOGLE_JWKS_URL = 'https://www.googleapis.e2e/oauth2/v3/certs';
process.env.GOOGLE_ISSUER = 'https://accounts.google.e2e';

process.env.RESEND_API_KEY = 're_e2e_key';
process.env.EMAIL_FROM = 'Fynd <hello@fynd.e2e>';

const store = require('../api/_store');
const users = require('../api/_users');
const fitProfiles = require('../api/_fit-profile');

/* ---------------------------------------------------------
   Google and the mailbox, answered in-process
   --------------------------------------------------------- */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'e2e-key', alg: 'RS256', use: 'sig' });

const inbox = [];
const pendingCodes = new Map();   /* code -> the nonce it was minted for */

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function idTokenFor(nonce, claims) {
  const body = Object.assign({
    iss: process.env.GOOGLE_ISSUER,
    aud: process.env.GOOGLE_CLIENT_ID,
    azp: process.env.GOOGLE_CLIENT_ID,
    sub: '2200000000001',
    email: 'grace@gmail.e2e',
    email_verified: true,
    name: 'Grace Hopper',
    nonce,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000)
  }, claims || {});
  const header = b64({ alg: 'RS256', kid: 'e2e-key', typ: 'JWT' });
  const payload = b64(body);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

let googleClaims = {};

/* Every outbound call to a product source or an AI provider, so a test
   can say none was made. */
const PROVIDER = /openwebninja|openai\.com|serper\.dev|serpapi\.com|generativelanguage\.googleapis\.com|api\.etsy\.com/i;
const providerCalls = [];

const realFetch = global.fetch;
global.fetch = async (url, options) => {
  const href = String(url);
  if (PROVIDER.test(href)) providerCalls.push(href);
  /* the product source answers a real search, in-process, with nothing
     found — the search still happened, so it is still counted */
  if (href.startsWith('https://api.openwebninja.com/')) {
    return { ok: true, status: 200, json: async () => ({ status: 'OK', data: { products: [] } }), text: async () => '' };
  }
  const body = (options && options.body) || '';
  const reply = (payload, ok) => ({ ok: ok !== false, status: ok === false ? 400 : 200, json: async () => payload });

  if (href.startsWith(process.env.GOOGLE_JWKS_URL)) return reply({ keys: [JWK] });

  if (href.startsWith(process.env.GOOGLE_TOKEN_URL)) {
    const params = new URLSearchParams(body);
    const nonce = pendingCodes.get(params.get('code'));
    if (!nonce) return reply({ error: 'invalid_grant' }, false);
    return reply({ access_token: 'e2e-access', token_type: 'Bearer', id_token: idTokenFor(nonce, googleClaims) });
  }

  if (href.startsWith('https://api.resend.com/')) {
    inbox.push(JSON.parse(body));
    return reply({ id: `email_${inbox.length}` });
  }

  if (href.startsWith('https://api.stripe.com/')) {
    if (href.endsWith('/v1/customers')) return reply({ id: `cus_${crypto.randomBytes(5).toString('hex')}` });
    if (href.endsWith('/v1/checkout/sessions')) return reply({ id: 'cs_e2e', url: `${ORIGIN}/pricing.html?checkout=success` });
    if (href.endsWith('/v1/billing_portal/sessions')) return reply({ id: 'bps_e2e', url: `${ORIGIN}/account.html?portal=1` });
    return reply({ error: { message: 'not stubbed' } }, false);
  }

  if (realFetch) return realFetch(url, options);
  throw new Error(`unexpected request to ${href}`);
};

/* ---------------------------------------------------------
   The server: real handlers, real HTTP
   --------------------------------------------------------- */

const HANDLERS = {
  '/api/auth': require('../api/auth'),
  '/api/account': require('../api/account'),
  '/api/verify-email': require('../api/verify-email'),
  '/api/google-start': require('../api/google-start'),
  '/api/google-callback': require('../api/google-callback'),
  '/api/checkout': require('../api/checkout'),
  '/api/portal': require('../api/portal'),
  '/api/fit-profile': require('../api/fit-profile'),
  /* the search and the AI reader, so a search made in a test is a real,
     metered one — and so a page that should never make one is caught */
  '/api/search': require('../api/search'),
  '/api/interpret': require('../api/interpret')
};

/* Vercel's handlers answer with res.status().json(); a bare Node
   response has neither, so they are added here. This is the only
   adaptation between the test server and production. */
function adapt(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
    return res;
  };
  return res;
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/* every API endpoint the browser reached, in order */
const apiHits = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);

  /* Standing in for Google's authorize page: it does what Google does —
     reads the request, and redirects the browser back to the registered
     redirect_uri with a code and the state it was given. */
  if (url.pathname === '/__google/authorize') {
    const code = `e2e-code-${crypto.randomBytes(6).toString('hex')}`;
    pendingCodes.set(code, url.searchParams.get('nonce'));
    const back = new URL(url.searchParams.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state'));
    res.statusCode = 302;
    res.setHeader('Location', back.toString());
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) apiHits.push(url.pathname);
  const handler = HANDLERS[url.pathname];

  if (handler) {
    adapt(res);
    try {
      await handler(req, res);
    } catch (err) {
      console.error('handler threw', url.pathname, err && err.message);
      if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); }
    }
    if (!res.writableEnded) res.end();
    return;
  }

  /* the interpreter and the product search are not what this suite is
     about; answered so the pages behave normally */
  if (url.pathname === '/api/interpret' || url.pathname === '/api/search') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ source: null, products: [], preferences: {} }));
  }

  const file = path.join(REPO, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

/* ---------------------------------------------------------
   Runner
   --------------------------------------------------------- */

let passed = 0;
const failures = [];

async function test(name, fn) {
  store.reset();
  inbox.length = 0;
  pendingCodes.clear();
  googleClaims = {};
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

/* The link out of the most recent message, followed the way a person
   clicks it in their mail client. */
const linkFromInbox = (pattern) => {
  const message = [...inbox].reverse().find((m) => pattern.test(m.text));
  if (!message) return null;
  return (message.text.match(/https?:\/\/\S+/g) || []).find((u) => pattern.test(u)) || null;
};

(async () => {
  await new Promise((r) => server.listen(PORT, r));

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME });
  } catch (err) {
    console.log('Chromium could not launch here — skipping end-to-end tests.');
    server.close();
    process.exit(0);
  }

  /* A fresh browser context per test: its own cookie jar, so one test's
     session cannot be another's. */
  async function openContext() {
    const context = await browser.newContext({ baseURL: ORIGIN });

    /* The pages carry a meta tag pointing at the production deployment,
       because that is what the published site needs. Here the endpoints
       are this test server, and the same window override the site
       documents is how that is said. */
    await context.addInitScript((origin) => {
      window.FINDWEAR_API = `${origin}/api/interpret`;
      window.FINDWEAR_SEARCH_API = `${origin}/api/search`;
    }, ORIGIN);

    /* Short, so a selector that is never going to appear reports itself
       in seconds rather than after the default half-minute. */
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(8000);

    /* A script that threw is the usual reason a selector never appears,
       and without this the only symptom is a timeout that says nothing. */
    context.on('page', (page) => {
      page.on('pageerror', (err) => console.log(`      [page error] ${err && err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') console.log(`      [console] ${msg.text()}`);
      });
    });
    /* Nothing off this origin is reachable here — the whole flow,
       Google's stand-in included, is served locally — so cutting
       everything else makes the pages deterministic. */
    await context.route((url) => !String(url).includes('127.0.0.1'), (route) => route.abort());

    return context;
  }

  const open = async (page, file) => {
    await page.goto(`${ORIGIN}/${file}`, { waitUntil: 'domcontentloaded' });
    return page;
  };

  /* Fills and submits the email form, from the front door each time. */
  async function signUpThroughTheUI(page, { name, email, password, confirm }) {
    await open(page, 'account.html');
    await page.waitForSelector('#panel-choose:not([hidden])');
    await page.click('#email-button');
    await page.waitForSelector('#panel-email:not([hidden])');
    await page.click('#auth-switch');
    await page.waitForSelector('#field-name:not([hidden])');

    await page.fill('#auth-name', name);
    await page.fill('#auth-email', email);
    await page.fill('#auth-password', password);
    await page.fill('#auth-confirm', confirm === undefined ? password : confirm);
    await page.click('#auth-submit');
  }

  const PASSWORD = 'end-to-end-password';

  console.log('\nthe Account link');

  await test('every page has an Account link that opens account.html', async () => {
    const context = await openContext();
    const page = await context.newPage();
    for (const file of ['index.html', 'find-clothes.html', 'discover.html', 'pricing.html', 'about.html']) {
      await open(page, file);
      const link = await page.$('.nav-links a[href="account.html"]');
      assert.ok(link, `${file} should have an Account link in the main navigation`);
      assert.strictEqual((await link.textContent()).trim(), 'Account');
    }
    /* and it actually goes there */
    await open(page, 'index.html');
    await page.click('.nav-links a[href="account.html"]');
    await page.waitForURL(/account\.html/);
    assert.ok(await page.$('#panel-choose'), 'the account page should open');
    await context.close();
  });

  await test('the account page opens on two choices and nothing else', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'account.html');
    await page.waitForSelector('#panel-choose:not([hidden])');

    assert.strictEqual((await page.textContent('#google-button')).trim(), 'Continue with Google');
    assert.strictEqual((await page.textContent('#email-button')).trim(), 'Continue with Email');

    /* the forms are not on screen until one is chosen */
    assert.strictEqual(await page.$eval('#panel-email', (n) => n.hidden), true);
    assert.strictEqual(await page.$eval('#panel-account', (n) => n.hidden), true);
    await context.close();
  });

  console.log('\nsigning up with email');

  await test('signing up creates an unverified account and sends one email', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada Lovelace', email: 'ada@e2e.test', password: PASSWORD });

    await page.waitForSelector('#panel-account:not([hidden])');
    assert.ok((await page.textContent('#account-identity')).includes('ada@e2e.test'));
    assert.ok((await page.textContent('#account-identity')).includes('Not confirmed'));

    const stored = await users.byEmail('ada@e2e.test');
    assert.ok(stored, 'the account should exist on the server');
    assert.strictEqual(stored.emailVerified, false);
    assert.strictEqual(inbox.length, 1);
    assert.strictEqual(inbox[0].to[0], 'ada@e2e.test');
    await context.close();
  });

  await test('the form catches a mismatched confirmation before anything is sent', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD, confirm: 'different' });

    await page.waitForSelector('#auth-error.show');
    assert.ok(/do not match/i.test(await page.textContent('#auth-error')));
    assert.strictEqual(inbox.length, 0);
    assert.strictEqual(await users.byEmail('ada@e2e.test'), null);
    await context.close();
  });

  await test('the unverified banner is on screen, with a way to fix it', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });

    await page.waitForSelector('#verify-note:not([hidden])');
    const banner = await page.textContent('#verify-note');
    assert.ok(/confirm your email/i.test(banner), banner);
    assert.ok(/subscrib/i.test(banner), 'it should say what being unconfirmed costs them');
    /* and the row above states it flatly */
    assert.ok(/Not confirmed/.test(await page.textContent('#account-identity')));
    assert.ok(await page.$('#resend-button'), 'a resend button should be offered');
    await context.close();
  });

  console.log('\nconfirming the address');

  await test('following the emailed link verifies the account', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    const link = linkFromInbox(/verify-email/);
    assert.ok(link, 'the inbox should hold a confirmation link');

    /* opened the way a person opens it: a plain navigation */
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/account\.html/);

    assert.strictEqual((await users.byEmail('ada@e2e.test')).emailVerified, true);
    await page.waitForSelector('#panel-account:not([hidden])');
    assert.ok((await page.textContent('#account-identity')).includes('Confirmed'));
    await context.close();
  });

  await test('the same link a second time reports itself used', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    const link = linkFromInbox(/verify-email/);
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.goto(link, { waitUntil: 'domcontentloaded' });

    await page.waitForSelector('#auth-note:not([hidden]), #panel-account:not([hidden])');
    /* still verified from the first click, and the second said nothing
       that suggests it did anything */
    assert.strictEqual((await users.byEmail('ada@e2e.test')).emailVerified, true);
    await context.close();
  });

  await test('an invented confirmation link is refused on screen', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/api/verify-email?token=${'A'.repeat(43)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#auth-note:not([hidden])');
    assert.ok(/not valid|expired/i.test(await page.textContent('#auth-note')));
    await context.close();
  });

  console.log('\nsessions in a real browser');

  await test('the session survives a reload and a new tab', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-account:not([hidden])');

    const second = await context.newPage();
    await open(second, 'account.html');
    await second.waitForSelector('#panel-account:not([hidden])');
    assert.ok((await second.textContent('#account-identity')).includes('ada@e2e.test'));
    await context.close();
  });

  await test('the session cookie is HttpOnly, so no script on the page can read it', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    const visible = await page.evaluate(() => document.cookie);
    assert.ok(!/fynd_session/.test(visible), `document.cookie exposed the session: ${visible}`);

    const cookie = (await context.cookies()).find((c) => c.name === 'fynd_session');
    assert.ok(cookie, 'the browser should be holding one');
    assert.strictEqual(cookie.httpOnly, true);
    await context.close();
  });

  await test('nothing sensitive is written to browser storage', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    const stored = await page.evaluate(() => JSON.stringify({
      local: Object.entries(localStorage),
      session: Object.entries(sessionStorage)
    }));
    assert.ok(!stored.includes(PASSWORD), 'no password may be stored');
    assert.ok(!/fynd_session|token/i.test(stored), `storage held something credential-shaped: ${stored}`);
    await context.close();
  });

  await test('logging out ends the session and the page goes back to the choices', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    await page.click('#signout-button');
    await page.waitForSelector('#panel-choose:not([hidden])');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-choose:not([hidden])');
    assert.strictEqual(await page.$eval('#panel-account', (n) => n.hidden), true);

    const cookie = (await context.cookies()).find((c) => c.name === 'fynd_session' && c.value);
    assert.ok(!cookie, 'the session cookie should be gone');
    await context.close();
  });

  await test('logging back in works, and lands on the account', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    await page.click('#signout-button');
    await page.waitForSelector('#panel-choose:not([hidden])');

    await page.click('#email-button');
    await page.waitForSelector('#panel-email:not([hidden])');
    await page.fill('#auth-email', 'ada@e2e.test');
    await page.fill('#auth-password', PASSWORD);
    await page.click('#auth-submit');

    await page.waitForSelector('#panel-account:not([hidden])');
    assert.ok((await page.textContent('#account-identity')).includes('ada@e2e.test'));
    await context.close();
  });

  await test('the wrong password is refused without saying which part was wrong', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    await page.click('#signout-button');
    await page.waitForSelector('#panel-choose:not([hidden])');

    await page.click('#email-button');
    await page.fill('#auth-email', 'ada@e2e.test');
    await page.fill('#auth-password', 'not-the-password');
    await page.click('#auth-submit');

    await page.waitForSelector('#auth-error.show');
    const message = await page.textContent('#auth-error');
    assert.ok(/do not match/i.test(message), message);
    assert.ok(!/no account|does not exist|unknown/i.test(message), message);
    assert.strictEqual(await page.$eval('#panel-account', (n) => n.hidden), true);
    await context.close();
  });

  console.log('\nsigning in with Google');

  await test('Continue with Google runs the whole flow and signs you in', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'account.html');
    await page.waitForSelector('#panel-choose:not([hidden])');

    await page.click('#google-button');
    await page.waitForURL(/account\.html/, { timeout: 10000 });
    await page.waitForSelector('#panel-account:not([hidden])');

    assert.ok((await page.textContent('#account-identity')).includes('grace@gmail.e2e'));
    assert.ok((await page.textContent('#account-identity')).includes('Confirmed'),
      'Google proved the address, so it is confirmed');

    const stored = await users.byEmail('grace@gmail.e2e');
    assert.strictEqual(stored.googleSub, '2200000000001');
    assert.strictEqual(stored.passwordHash, null);
    assert.strictEqual(stored.emailVerified, true);
    await context.close();
  });

  await test('a Google sign-in whose token is for another app is refused on screen', async () => {
    googleClaims = { aud: 'someone-else.apps.googleusercontent.com', azp: 'someone-else.apps.googleusercontent.com' };
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'account.html');
    await page.waitForSelector('#panel-choose:not([hidden])');

    await page.click('#google-button');
    await page.waitForURL(/account\.html/, { timeout: 10000 });
    await page.waitForSelector('#auth-note:not([hidden])');

    assert.ok(/could not be verified|refused/i.test(await page.textContent('#auth-note')));
    assert.strictEqual(await page.$eval('#panel-account', (n) => n.hidden), true);
    assert.strictEqual(await users.byEmail('grace@gmail.e2e'), null, 'no account may be created');
    await context.close();
  });

  await test('a Google sign-in with a replayed state is refused', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'account.html');
    await page.waitForSelector('#panel-choose:not([hidden])');

    /* capture the callback URL of a real flow, then replay it */
    let callbackUrl = null;
    page.on('request', (request) => {
      if (request.url().includes('/api/google-callback')) callbackUrl = request.url();
    });
    await page.click('#google-button');
    await page.waitForURL(/account\.html/, { timeout: 10000 });
    await page.waitForSelector('#panel-account:not([hidden])');
    assert.ok(callbackUrl, 'the callback should have been observed');

    await page.goto(callbackUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/account\.html/);
    await page.waitForSelector('#auth-note:not([hidden])');
    assert.ok(/could not be verified|start again/i.test(await page.textContent('#auth-note')));
    await context.close();
  });

  console.log('\nthe account page shows what the server says');

  await test('an unverified account cannot start a checkout, and is told why', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    await open(page, 'pricing.html');
    await page.waitForSelector('.plan-banner:not([hidden])');
    await page.click('.plan-card[data-plan="pro"] [data-plan-action]');
    await page.waitForSelector('#billing-note:not([hidden])');

    assert.ok(/confirm your email/i.test(await page.textContent('#billing-note')));
    assert.ok(!page.url().includes('checkout.stripe.com'));
    await context.close();
  });

  await test('a verified account reaches Stripe Checkout', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    await page.goto(linkFromInbox(/verify-email/), { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/account\.html/);

    await open(page, 'pricing.html');
    await page.waitForSelector('.plan-banner:not([hidden])');
    await page.click('.plan-card[data-plan="pro"] [data-plan-action]');

    /* the stub sends the browser where Stripe would send it back to */
    await page.waitForURL(/checkout=success/, { timeout: 10000 });
    const stored = await users.byEmail('ada@e2e.test');
    assert.ok(stored.stripeCustomerId, 'a Stripe customer should have been created for them');
    await context.close();
  });

  await test('the plan and usage on screen are the ones the server holds', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    await page.waitForSelector('.meter');

    const meters = await page.$$eval('.meter', (ns) => ns.map((n) => ({
      label: n.querySelector('.meter-label').textContent.trim(),
      value: n.querySelector('.meter-value').textContent.trim()
    })));
    assert.deepStrictEqual(meters.map((m) => m.label), ['AI tokens', 'Live product searches']);
    assert.strictEqual(meters[0].value, '0 of 20,000 used');
    assert.strictEqual(meters[1].value, '0 of 3 used');
    assert.strictEqual((await page.textContent('#banner-plan')).trim(), 'Free');

    /* the server counts a search, and the page reflects it on reload */
    const user = await users.byEmail('ada@e2e.test');
    await require('../api/_usage').record(`user:${user.id}`, 'free', 'searches', 1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.meter');
    const after = await page.$$eval('.meter-value', (ns) => ns.map((n) => n.textContent.trim()));
    assert.strictEqual(after[1], '1 of 3 used');
    await context.close();
  });

  await test('exploring Discover end to end spends no search, no AI and no provider call', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    const user = await users.byEmail('ada@e2e.test');
    const usage = require('../api/_usage');
    const used = async () => {
      const now = await usage.summary(`user:${user.id}`, 'free', ['searches', 'aiTokens']);
      return { searches: now.searches.used, aiTokens: now.aiTokens.used };
    };
    assert.deepStrictEqual(await used(), { searches: 0, aiTokens: 0 });

    /* the retailers' photo hosts are not reachable from here; each
       catalogue photo is answered with a real JPEG, as a CDN would, so
       Discover has its proved rows to filter */
    const photos = new Set(require('./audit-catalog').readCatalogue().map((r) => r.imageUrl).filter(Boolean));
    const jpeg = fs.readFileSync(path.join(REPO, 'assets', 'demo', 'fynd-demo-mobile-poster.jpg'));
    await page.route((u) => photos.has(String(u)), (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpeg }));

    apiHits.length = 0;
    providerCalls.length = 0;
    await open(page, 'discover.html');
    await page.waitForSelector('.shelf .item-card', { timeout: 10000 });

    /* every category and every subcategory it offers, three times over */
    let clicks = 0;
    for (let round = 0; round < 3; round++) {
      const categories = await page.$$eval('#discover-tabs button', (ns) => ns.length);
      for (let c = 0; c < categories; c++) {
        await page.click(`#discover-tabs button >> nth=${c}`); clicks += 1;
        const pills = await page.$$eval('#discover-panel button.pill', (ns) => ns.length);
        for (let i = 0; i < pills; i++) { await page.click(`#discover-panel button.pill >> nth=${i}`); clicks += 1; }
      }
      await page.click('#results-clear');
      const shelves = await page.$$eval('.shelf button[data-category]', (ns) => ns.length);
      for (let i = 0; i < shelves; i++) {
        await page.click(`.shelf button[data-category] >> nth=${i}`); clicks += 1;
        await page.click('#results-clear');
      }
    }
    await page.waitForTimeout(300);

    assert.ok(clicks >= 50, `only ${clicks} filters were used`);
    assert.deepStrictEqual(apiHits.filter((p) => p === '/api/search' || p === '/api/interpret'), [], 'Discover reached a search endpoint');
    assert.deepStrictEqual(providerCalls, [], 'Discover reached a product source or AI provider');
    assert.ok(/discover\.html$/.test(page.url()), `Discover left the page for ${page.url()}`);
    assert.deepStrictEqual(await used(), { searches: 0, aiTokens: 0 }, 'Discover spent from the plan');

    /* The control: one real search from the search page is seen by the
       same counters and spends from the same meter — so the zeros above
       are Discover's, not blind instruments. */
    await open(page, 'find-clothes.html');
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('#results h2:not(.thinking)', { timeout: 15000 });
    assert.ok(apiHits.includes('/api/search'), 'the search page did not reach /api/search, so the check above proves nothing');
    assert.ok(providerCalls.length > 0, 'the search did not reach the product source');
    assert.strictEqual((await used()).searches, 1, 'a real search was not counted, so the zero above proves nothing');
    await context.close();
  });

  await test('a signed-out visitor sees no account information at all', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada Lovelace', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    await page.click('#signout-button');
    await page.waitForSelector('#panel-choose:not([hidden])');

    const text = await page.textContent('body');
    assert.ok(!text.includes('ada@e2e.test'), 'the address must not still be on the page');
    assert.ok(!text.includes('Ada Lovelace'));

    /* and the endpoint itself gives an anonymous caller nothing */
    const payload = await page.evaluate(async () => {
      const response = await fetch('/api/account', { credentials: 'include' });
      return response.json();
    });
    assert.strictEqual(payload.signedIn, false);
    assert.strictEqual(payload.user, null);
    await context.close();
  });

  await test('a page cannot grant itself a plan by editing what it holds', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');

    /* the page's own copy of the state is rewritten to Max */
    await page.evaluate(() => {
      const state = window.Account.state();
      state.plan = { id: 'max', name: 'Max', amount: 39.99, interval: 'month', period: 'month',
        limits: { aiTokens: 5000000, searches: 500 }, tagline: '', features: [], purchasable: true };
      state.emailVerified = true;
      window.BillingUI.draw(state);
    });

    /* the server is unmoved */
    assert.strictEqual((await users.byEmail('ada@e2e.test')).plan, 'free');
    const payload = await page.evaluate(async () => {
      const response = await fetch('/api/account', { credentials: 'include' });
      return response.json();
    });
    assert.strictEqual(payload.plan.id, 'free');
    assert.strictEqual(payload.emailVerified, false);
    await context.close();
  });

  console.log('\nforgotten passwords');

  await test('a reset link sets a new password and signs the old sessions out', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    await page.click('#signout-button');
    await page.waitForSelector('#panel-choose:not([hidden])');

    await page.click('#email-button');
    await page.fill('#auth-email', 'ada@e2e.test');
    await page.click('#forgot-button');
    await page.waitForSelector('#auth-note:not([hidden])');
    assert.ok(/on its way/i.test(await page.textContent('#auth-note')));

    const link = linkFromInbox(/reset=/);
    assert.ok(link, 'a reset link should have been sent');

    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-reset:not([hidden])');

    /* the token is taken straight out of the URL */
    assert.ok(!page.url().includes('reset='), `the token is still in the URL: ${page.url()}`);

    const NEW = 'a-brand-new-e2e-password';
    await page.fill('#reset-password', NEW);
    await page.fill('#reset-confirm', NEW);
    await page.click('#reset-submit');
    await page.waitForSelector('#panel-account:not([hidden])');

    /* the new password works and the old one does not */
    await page.click('#signout-button');
    await page.waitForSelector('#panel-choose:not([hidden])');
    await page.click('#email-button');
    await page.fill('#auth-email', 'ada@e2e.test');
    await page.fill('#auth-password', PASSWORD);
    await page.click('#auth-submit');
    await page.waitForSelector('#auth-error.show');

    await page.fill('#auth-password', NEW);
    await page.click('#auth-submit');
    await page.waitForSelector('#panel-account:not([hidden])');
    await context.close();
  });

  /* =========================================================
     The fit profile, through its page, against /api/fit-profile
     ========================================================= */

  console.log('\nthe fit profile');

  /* Signs up through the real form, then follows the account page's
     own link to the fit profile. */
  async function profilePage(context, email) {
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email, password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    await page.click('#fit-profile-link');
    await page.waitForURL(/fit-profile\.html/);
    await page.waitForSelector('#profile-form:not([hidden])');
    return page;
  }

  async function addBrand(page, { brand, category, size, fit }) {
    await page.click('#add-brand');
    const row = page.locator('#brand-list > .brand-row').last();
    await row.locator('[data-part="brand"] input').fill(brand);
    if (category) await row.locator('[data-part="category"] select').selectOption(category);
    if (size) await row.locator('[data-part="size"] input').fill(size);
    if (fit) await row.locator('[data-part="fit"] select').selectOption(fit);
  }

  const savedProfile = async (email) => (await fitProfiles.read((await users.byEmail(email)).id)).profile;

  const saveAndWait = async (page) => {
    await page.click('#profile-save');
    await page.waitForFunction(() => document.getElementById('profile-save-state').textContent === 'Saved');
  };

  await test('signed out, the fit profile page asks you to sign in and never asks for the profile', async () => {
    const context = await openContext();
    const page = await context.newPage();
    apiHits.length = 0;
    await open(page, 'fit-profile.html');
    await page.waitForSelector('#profile-signed-out:not([hidden])');
    assert.strictEqual(await page.$eval('#profile-form', (n) => n.hidden), true, 'no form for somebody signed out');
    assert.ok(await page.$('#profile-signed-out a[href="account.html"]'), 'a way to sign in');
    assert.ok(!apiHits.includes('/api/fit-profile'), 'nothing to ask for without an account');
    await context.close();
  });

  await test('the account page leads to an empty fit profile, every part marked optional', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');

    assert.strictEqual(await page.locator('.optional-tag').count(), 3);
    assert.ok(await page.isVisible('#brand-empty'));
    assert.strictEqual(await page.$eval('input[name="unit"][value="in"]', (n) => n.checked), true, 'the unit is visibly chosen');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '');
    assert.strictEqual(await page.isVisible('#profile-delete-area'), false, 'nothing saved, so nothing to delete');
    for (const id of ['height-ft', 'height-in', 'measure-chest', 'measure-waist', 'measure-hip']) {
      const named = await page.$eval(`#${id}`, (n) => Boolean(n.labels && n.labels.length && n.labels[0].textContent.trim()));
      assert.ok(named, `#${id} has a label`);
    }
    await context.close();
  });

  await test('a profile is saved, survives a reload, and can be edited', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');

    await page.fill('#height-ft', '5');
    await page.fill('#height-in', '10');
    await page.fill('#measure-chest', '40');
    await addBrand(page, { brand: 'Uniqlo', category: 'hoodies', size: 'm', fit: 'about-right' });
    await addBrand(page, { brand: 'Champion', category: 'sweatshirts' });
    await page.check('input[name="pref-hoodies"][value="relaxed"]');
    assert.strictEqual(await page.textContent('#profile-save-state'), 'Unsaved changes');
    await saveAndWait(page);

    const stored = await savedProfile('ada@e2e.test');
    assert.deepStrictEqual(stored.measurements, { unit: 'in', height: 70, chest: 40, waist: null, hip: null });
    assert.deepStrictEqual(stored.brandSizes, [
      { brand: 'Uniqlo', category: 'hoodies', size: 'M', fit: 'about-right' },
      { brand: 'Champion', category: 'sweatshirts', size: null, fit: null }
    ]);
    assert.deepStrictEqual(stored.fitPreferences, { hoodies: 'relaxed' });
    assert.strictEqual(await page.$eval('#brand-list .brand-row [data-part="size"] input', (n) => n.value), 'M',
      'the page shows what the server kept');

    await page.reload();
    await page.waitForSelector('#profile-form:not([hidden])');
    assert.strictEqual(await page.$eval('#height-ft', (n) => n.value), '5');
    assert.strictEqual(await page.$eval('#height-in', (n) => n.value), '10');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '40');
    assert.strictEqual(await page.locator('#brand-list > .brand-row').count(), 2);
    assert.strictEqual(await page.$eval('input[name="pref-hoodies"][value="relaxed"]', (n) => n.checked), true);
    assert.strictEqual(await page.$eval('input[name="pref-sweatshirts"][value=""]', (n) => n.checked), true, 'no preference, said as such');
    assert.ok(await page.isVisible('#profile-delete-area'));

    /* edit: a new chest, one brand fewer */
    await page.fill('#measure-chest', '41.5');
    await page.click('#brand-list > .brand-row:nth-child(2) [data-remove]');
    await saveAndWait(page);
    const edited = await savedProfile('ada@e2e.test');
    assert.strictEqual(edited.measurements.chest, 41.5);
    assert.deepStrictEqual(edited.brandSizes.map((e) => e.brand), ['Uniqlo']);
    await context.close();
  });

  await test('usual sizes and preferred fit alone save, with no measurement at all', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await addBrand(page, { brand: 'Gap', category: 'hoodies', size: 'S', fit: 'too-small' });
    await page.check('input[name="pref-sweatshirts"][value="oversized"]');
    await saveAndWait(page);

    const stored = await savedProfile('ada@e2e.test');
    assert.deepStrictEqual([stored.measurements.height, stored.measurements.chest], [null, null]);
    assert.deepStrictEqual(stored.brandSizes, [{ brand: 'Gap', category: 'hoodies', size: 'S', fit: 'too-small' }]);
    assert.deepStrictEqual(stored.fitPreferences, { sweatshirts: 'oversized' });
    await context.close();
  });

  await test('a value in the wrong unit is caught before it is sent, and nothing is saved', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');

    await page.fill('#measure-chest', '102');
    await page.locator('#measure-chest').blur();
    await page.waitForSelector('#error-measurements-chest:not(:empty)');
    assert.match(await page.textContent('#error-measurements-chest'), /102 looks like centimetres/);
    assert.strictEqual(await page.getAttribute('#measure-chest', 'aria-invalid'), 'true');

    await page.click('#profile-save');
    await page.waitForSelector('#profile-form-error.show');
    assert.match(await page.textContent('#profile-form-error'), /Nothing was saved/);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'measure-chest', 'focus goes to the problem');
    assert.strictEqual(await savedProfile('ada@e2e.test'), null);
    await context.close();
  });

  await test('switching unit converts what was valid, keeps what was typed for the other unit, and says which', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');

    await page.fill('#height-ft', '5');
    await page.fill('#height-in', '10');
    await page.fill('#measure-chest', '102');
    await page.locator('#measure-chest').blur();
    await page.check('input[name="unit"][value="cm"]');

    assert.strictEqual(await page.$eval('#height-cm', (n) => n.value), '177.8');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '102');
    const said = await page.textContent('#unit-note');
    assert.match(said, /now in centimetres/);
    assert.match(said, /height 5 ft 10 in to 177.8 cm/);
    assert.match(said, /Left as you typed it: chest/);
    assert.strictEqual(await page.textContent('#error-measurements-chest'), '', 'valid as centimetres');
    assert.strictEqual(await page.isVisible('#height-ft'), false);
    assert.strictEqual((await page.textContent('[data-field="measurements.chest"] .measure-unit')).trim(), 'cm');

    await saveAndWait(page);
    const stored = await savedProfile('ada@e2e.test');
    assert.deepStrictEqual(stored.measurements, { unit: 'cm', height: 177.8, chest: 102, waist: null, hip: null });

    /* and back: both convert now, because both are valid */
    await page.check('input[name="unit"][value="in"]');
    assert.strictEqual(await page.$eval('#height-ft', (n) => n.value), '5');
    assert.strictEqual(await page.$eval('#height-in', (n) => n.value), '10');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '40.2');
    assert.strictEqual(await page.textContent('#profile-save-state'), 'Unsaved changes');
    await context.close();
  });

  await test('the same brand and category twice is flagged on the second row and not saved', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await addBrand(page, { brand: 'Uniqlo', category: 'hoodies', size: 'M' });
    await addBrand(page, { brand: 'UNIQLO', category: 'hoodies', size: 'L' });
    await page.click('#profile-save');

    const second = page.locator('#brand-list > .brand-row').nth(1);
    await second.locator('[data-part="brand"] .profile-error:not(:empty)').waitFor();
    assert.match(await second.locator('[data-part="brand"] .profile-error').textContent(), /Uniqlo hoodies are already listed/);
    assert.strictEqual(await savedProfile('ada@e2e.test'), null);

    /* a different category is a different entry */
    await second.locator('[data-part="category"] select').selectOption('sweatshirts');
    await saveAndWait(page);
    assert.strictEqual((await savedProfile('ada@e2e.test')).brandSizes.length, 2);
    await context.close();
  });

  await test('deleting asks first, then removes the profile from the account', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await page.fill('#measure-chest', '40');
    await saveAndWait(page);

    await page.click('#profile-delete');
    await page.waitForSelector('#delete-confirm:not([hidden])');
    await page.click('#delete-cancel');
    assert.ok(await savedProfile('ada@e2e.test'), 'keeping it keeps it');

    await page.click('#profile-delete');
    await page.click('#delete-confirm-yes');
    await page.waitForSelector('#profile-note:not([hidden])');
    assert.match(await page.textContent('#profile-note'), /deleted/);
    assert.strictEqual(await savedProfile('ada@e2e.test'), null);
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '');
    assert.strictEqual(await page.isVisible('#profile-delete-area'), false);

    await page.reload();
    await page.waitForSelector('#profile-form:not([hidden])');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '');
    await context.close();
  });

  await test('a profile that cannot be read is never shown as an empty form, and Try again recovers it', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await page.fill('#measure-chest', '40');
    await saveAndWait(page);

    await page.route('**/api/fit-profile', (route) => (route.request().method() === 'GET'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not read your fit profile. Try again in a moment.' }) })
      : route.continue()));
    await page.reload();
    await page.waitForSelector('#profile-load-failed:not([hidden])');
    assert.strictEqual(await page.$eval('#profile-form', (n) => n.hidden), true, 'no empty form to save over the real one');
    assert.match(await page.textContent('#profile-load-error'), /Could not read/);

    await page.unroute('**/api/fit-profile');
    await page.click('#profile-retry');
    await page.waitForSelector('#profile-form:not([hidden])');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '40');
    await context.close();
  });

  await test('a save that fails keeps everything typed and says nothing was saved', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await page.route('**/api/fit-profile', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
    await page.fill('#measure-chest', '40');
    await addBrand(page, { brand: 'Uniqlo', category: 'hoodies', size: 'M' });
    await page.click('#profile-save');
    await page.waitForSelector('#profile-form-error.show');
    assert.match(await page.textContent('#profile-form-error'), /Nothing was saved/);
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '40');
    assert.strictEqual(await page.textContent('#profile-save-state'), 'Unsaved changes');
    assert.strictEqual(await page.$eval('#profile-save', (n) => n.disabled), false, 'the button comes back');

    await page.unroute('**/api/fit-profile');
    await saveAndWait(page);
    assert.strictEqual((await savedProfile('ada@e2e.test')).measurements.chest, 40);
    await context.close();
  });

  await test('another account opens its own empty profile, never the first one’s', async () => {
    const adaContext = await openContext();
    const ada = await profilePage(adaContext, 'ada@e2e.test');
    await ada.fill('#measure-chest', '40');
    await addBrand(ada, { brand: 'Uniqlo', category: 'hoodies', size: 'M' });
    await saveAndWait(ada);

    const bobContext = await openContext();
    const bob = await profilePage(bobContext, 'bob@e2e.test');
    assert.strictEqual(await bob.$eval('#measure-chest', (n) => n.value), '');
    assert.strictEqual(await bob.locator('#brand-list > .brand-row').count(), 0);
    await bob.fill('#measure-chest', '38');
    await saveAndWait(bob);

    assert.strictEqual((await savedProfile('ada@e2e.test')).measurements.chest, 40);
    assert.strictEqual((await savedProfile('bob@e2e.test')).measurements.chest, 38);
    await adaContext.close();
    await bobContext.close();
  });

  await test('nothing from the fit profile is kept in browser storage', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await page.fill('#measure-chest', '43.3');
    await addBrand(page, { brand: 'Quillborough', category: 'hoodies', size: 'M' });
    await saveAndWait(page);
    const kept = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
    assert.ok(!/43\.3|Quillborough/.test(kept), `found in browser storage: ${kept}`);
    await context.close();
  });

  await test('the fit profile fits a phone, with no sideways scroll, and every control is reachable', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await page.setViewportSize({ width: 360, height: 740 });
    await addBrand(page, { brand: 'Uniqlo', category: 'hoodies', size: 'M' });
    await page.fill('#measure-chest', '102');
    await page.locator('#measure-chest').blur();
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 360, `the page is ${width}px wide on a 360px screen`);
    const offscreen = await page.$$eval('#profile-form input:not([type="radio"]), #profile-form select, #profile-form button, #profile-form .choice',
      (ns) => ns.filter((n) => n.offsetParent && n.getBoundingClientRect().right > 360).map((n) => n.id || n.className));
    assert.deepStrictEqual(offscreen, []);
    await context.close();
  });

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
