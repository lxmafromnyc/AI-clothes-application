#!/usr/bin/env node
/* =========================================================
   Fynd — the GitHub Pages copy, calling the API on Vercel

   The published site is two origins:

     https://lxmafromnyc.github.io/AI-clothes-application/   the pages
     https://ai-clothes-application.vercel.app/api/…          the API

   test-e2e.js drives the same pages same-origin, with the API beside
   them; this suite drives them the way a visitor to the Pages site
   reaches them, across origins, with the browser enforcing CORS and
   cross-site cookie rules for real:

     - both hostnames are served from this machine over TLS, through a
       local CONNECT proxy, so the page's origin and the API's are
       exactly the production ones and the session cookie really is a
       cross-site cookie (SameSite=None; Secure)
     - the pages find the API through their own meta tag; nothing
       overrides it
     - no Playwright request routing at all: routing makes Playwright
       answer CORS preflights itself, which would hide exactly the
       failures this suite exists to catch
     - the allow-list is the one built into api/_cors.js; ALLOWED_ORIGIN
       is unset

   Needs Chromium and openssl (for a throwaway certificate).
   Usage: node scripts/test-cross-origin.js
   ========================================================= */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — skipping cross-origin tests.');
  process.exit(0);
}

/* ---------------------------------------------------------
   The production origins, served here
   --------------------------------------------------------- */

const PAGES_HOST = 'lxmafromnyc.github.io';
const API_HOST = 'ai-clothes-application.vercel.app';
const STRIPE_HOST = 'checkout.stripe.com';
const HOSTILE_HOST = 'evil.example';
const HOSTS = [PAGES_HOST, API_HOST, STRIPE_HOST, HOSTILE_HOST];

const PAGES_ORIGIN = `https://${PAGES_HOST}`;
const SITE = `${PAGES_ORIGIN}/AI-clothes-application`;
const API_ORIGIN = `https://${API_HOST}`;
const HOSTILE_ORIGIN = `https://${HOSTILE_HOST}`;

const PROXY_PORT = 8921;
const TLS_PORT = 8922;

/* ---------------------------------------------------------
   Configuration: the deployment's, minus anything that would widen
   the allow-list beyond what is built in
   --------------------------------------------------------- */

process.env.AUTH_SECRET = 'cross-origin-secret-of-sufficient-length';
process.env.STRIPE_SECRET_KEY = 'sk_test_cross_origin';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_cross_origin';
process.env.STRIPE_PRICE_PRO = 'price_pro_cross_origin';
process.env.STRIPE_PRICE_MAX = 'price_max_cross_origin';
process.env.RESEND_API_KEY = 're_cross_origin_key';
process.env.EMAIL_FROM = 'Fynd <hello@fynd.test>';
['ALLOWED_ORIGIN', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']
  .forEach((key) => { delete process.env[key]; });

const store = require('../api/_store');
const users = require('../api/_users');
const auth = require('../api/_auth');

/* the mailbox and Stripe, answered in-process */
const inbox = [];
const stripeCalls = [];
global.fetch = async (url, options) => {
  const href = String(url);
  const body = (options && options.body) || '';
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (href.startsWith('https://api.resend.com/')) {
    inbox.push(JSON.parse(body));
    return reply({ id: `email_${inbox.length}` });
  }
  if (href.startsWith('https://api.stripe.com/')) {
    const params = new URLSearchParams(body);
    stripeCalls.push({ href, params });
    if (href.endsWith('/v1/customers')) return reply({ id: `cus_${crypto.randomBytes(5).toString('hex')}` });
    if (href.endsWith('/v1/checkout/sessions')) return reply({ id: 'cs_cross', url: `https://${STRIPE_HOST}/c/pay/cs_cross` });
  }
  throw new Error(`unexpected outbound request to ${href}`);
};

const HANDLERS = {
  '/api/account': require('../api/account'),
  '/api/auth': require('../api/auth'),
  '/api/checkout': require('../api/checkout'),
  '/api/portal': require('../api/portal'),
  '/api/verify-email': require('../api/verify-email')
};

/* ---------------------------------------------------------
   A throwaway certificate for the four hostnames
   --------------------------------------------------------- */

function certificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-cross-origin-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const made = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=fynd-cross-origin-test',
    '-addext', `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(',')}`
  ], { encoding: 'utf8' });
  if (made.status !== 0) {
    throw new Error(`openssl could not make a test certificate: ${made.error ? made.error.message : made.stderr}`);
  }
  const pair = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return pair;
}

/* ---------------------------------------------------------
   The four sites
   --------------------------------------------------------- */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };

/* every request any of the sites received, with what CORS said */
const requests = [];

function adapt(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
    return res;
  };
  return res;
}

/* A page on an origin the API has never heard of, with a session for
   the API sitting in the same browser. */
const HOSTILE_PAGE = '<!DOCTYPE html><meta charset="utf-8"><title>elsewhere</title><p>Somewhere else entirely.</p>';

async function site(req, res) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  const url = new URL(req.url, `https://${host}`);
  const seen = {
    host,
    method: req.method,
    path: url.pathname,
    origin: req.headers.origin || null,
    asked: req.headers['access-control-request-headers'] || null,
    withCsrf: Boolean(req.headers['x-fynd-csrf']),
    withSession: /(?:^|;\s*)fynd_session=/.test(String(req.headers.cookie || ''))
  };
  requests.push(seen);
  res.on('finish', () => {
    seen.status = res.statusCode;
    seen.allowOrigin = res.getHeader('Access-Control-Allow-Origin') || null;
    seen.allowHeaders = res.getHeader('Access-Control-Allow-Headers') || null;
    seen.allowCredentials = res.getHeader('Access-Control-Allow-Credentials') || null;
  });

  if (host === API_HOST) {
    const handler = HANDLERS[url.pathname];
    if (!handler) { res.statusCode = 404; return res.end('{}'); }
    adapt(res);
    req.query = Object.fromEntries(url.searchParams);
    try {
      await handler(req, res);
    } catch (err) {
      console.log(`      [handler threw] ${url.pathname}: ${err && err.message}`);
      if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); }
    }
    if (!res.writableEnded) res.end();
    return undefined;
  }

  if (host === PAGES_HOST) {
    /* a project site: everything lives under the repository's name, and
       there is no /api here at all — exactly what the page's first
       guess at its API finds */
    const prefix = '/AI-clothes-application/';
    if (!url.pathname.startsWith(prefix)) { res.statusCode = 404; return res.end('Not Found'); }
    const rel = url.pathname.slice(prefix.length) || 'index.html';
    const file = path.join(REPO, rel);
    if (!file.startsWith(REPO + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end('Not Found');
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    return res.end(fs.readFileSync(file));
  }

  if (host === STRIPE_HOST) {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!DOCTYPE html><title>Stripe Checkout</title><p>Stripe Checkout (stand-in)</p>');
  }

  if (host === HOSTILE_HOST) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(HOSTILE_PAGE);
  }

  res.statusCode = 421;
  return res.end();
}

/* The browser's only way out: CONNECT to one of the four hostnames on
   443 is tunnelled to the TLS server above; anything else is refused. */
function proxyServer() {
  const proxy = http.createServer((req, res) => { res.statusCode = 403; res.end(); });
  proxy.on('connect', (req, client, head) => {
    const [host, port] = String(req.url).split(':');
    if (!HOSTS.includes(host) || port !== '443') {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(TLS_PORT, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return proxy;
}

/* ---------------------------------------------------------
   Runner
   --------------------------------------------------------- */

let passed = 0;
const failures = [];

async function test(name, fn) {
  store.reset();
  inbox.length = 0;
  stripeCalls.length = 0;
  requests.length = 0;
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
    /* what the browser and the API actually said to each other */
    requests.filter((r) => r.host === API_HOST).forEach((r) => console.log(
      `        ${r.method} ${r.path} from ${r.origin || '-'}${r.asked ? ` asking [${r.asked}]` : ''} -> ${r.status}` +
      `${r.allowHeaders ? ` allow-headers [${r.allowHeaders}]` : ''}${r.withSession ? ' (with session)' : ''}`));
  }
}

const apiRequests = (method, pathname) => requests.filter((r) => r.host === API_HOST && r.method === method && r.path === pathname);
const headerList = (value) => String(value || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  const tls = https.createServer(certificate(), (req, res) => { site(req, res); });
  const proxy = proxyServer();
  await new Promise((r) => tls.listen(TLS_PORT, '127.0.0.1', r));
  await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));

  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME, proxy: { server: `http://127.0.0.1:${PROXY_PORT}` } });
  } catch (err) {
    console.log('Chromium could not launch here — skipping cross-origin tests.');
    tls.close(); proxy.close();
    process.exit(0);
  }

  async function openContext() {
    /* the certificate is this suite's own; nothing else about TLS or
       the browser's cookie and CORS rules is relaxed */
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    context.setDefaultTimeout(8000);
    context.setDefaultNavigationTimeout(8000);
    context.on('page', (page) => {
      page.on('pageerror', (err) => console.log(`      [page error] ${err && err.message}`));
    });
    return context;
  }

  const PASSWORD = 'cross-origin-password';

  async function signUpOnPages(page, email) {
    await page.goto(`${SITE}/account.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-choose:not([hidden])');
    await page.click('#email-button');
    await page.click('#auth-switch');
    await page.waitForSelector('#field-name:not([hidden])');
    await page.fill('#auth-name', 'Ada');
    await page.fill('#auth-email', email);
    await page.fill('#auth-password', PASSWORD);
    await page.fill('#auth-confirm', PASSWORD);
    await page.click('#auth-submit');
    await page.waitForSelector('#panel-account:not([hidden])');
  }

  const sessionCookie = async (context) => (await context.cookies(API_ORIGIN)).find((c) => c.name === 'fynd_session') || null;

  /* A signed-in POST from Pages: every preflight the browser sent for it
     was answered for this one origin, with credentials and the CSRF
     header allowed — and then the POST itself arrived carrying the
     token and the session. The browser caches a preflight for the
     Max-Age the API gives, so a second POST to the same path may not
     ask again; what it cannot do is reach the server without one
     having said yes. */
  function crossedWithToken(pathname) {
    const preflights = apiRequests('OPTIONS', pathname);
    assert.ok(preflights.length, `the browser sent no preflight for ${pathname}`);
    preflights.forEach((preflight) => {
      assert.strictEqual(preflight.origin, PAGES_ORIGIN);
      assert.strictEqual(preflight.status, 204);
      assert.strictEqual(preflight.allowOrigin, PAGES_ORIGIN, 'the one origin, echoed — never *');
      assert.strictEqual(preflight.allowCredentials, 'true');
      assert.ok(headerList(preflight.allowHeaders).includes('x-fynd-csrf'),
        `the API did not allow the CSRF header: Access-Control-Allow-Headers: ${preflight.allowHeaders}`);
    });
    const post = apiRequests('POST', pathname).filter((r) => r.withCsrf).pop();
    assert.ok(post, `no POST to ${pathname} carrying the CSRF token ever reached the API`);
    assert.strictEqual(post.origin, PAGES_ORIGIN);
    assert.ok(post.withSession, 'it carried the cross-site session cookie');
    assert.strictEqual(post.status, 200);
    return post;
  }

  console.log('\nthe Pages copy, across origins');

  await test('the pages name the production API in their meta tag, and nothing here overrides it', async () => {
    for (const file of ['index.html', 'find-clothes.html', 'account.html', 'pricing.html']) {
      const html = fs.readFileSync(path.join(REPO, file), 'utf8');
      const tag = /<meta name="findwear-api" content="([^"]+)">/.exec(html);
      assert.ok(tag, `${file} has no findwear-api meta tag`);
      assert.strictEqual(new URL(tag[1]).origin, API_ORIGIN, `${file} points at ${tag[1]}`);
    }
    const context = await openContext();
    const page = await context.newPage();
    await page.goto(`${SITE}/account.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-choose:not([hidden])');
    assert.strictEqual(await page.evaluate(() => window.FINDWEAR_API), undefined);

    /* its own origin has no API (as on Pages), so it asks the meta tag's */
    assert.ok(requests.some((r) => r.host === PAGES_HOST && r.path === '/api/account' && r.status === 404));
    const read = apiRequests('GET', '/api/account').pop();
    assert.ok(read, 'the page never reached the API');
    assert.strictEqual(read.origin, PAGES_ORIGIN);
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.allowOrigin, PAGES_ORIGIN);
    assert.ok(!(await page.textContent('#auth-note')).includes('not connected'));
    await context.close();
  });

  await test('signing up from Pages sets a cross-site session cookie, which every later read carries', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpOnPages(page, 'ada@cross.test');

    const cookie = await sessionCookie(context);
    assert.ok(cookie, 'the browser did not keep the session cookie');
    assert.strictEqual(cookie.sameSite, 'None');
    assert.strictEqual(cookie.secure, true);
    assert.strictEqual(cookie.httpOnly, true);
    assert.strictEqual(cookie.domain, API_HOST, 'the API’s cookie, not the page’s');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-account:not([hidden])');
    assert.ok((await page.textContent('#account-identity')).includes('ada@cross.test'));
    assert.ok(apiRequests('GET', '/api/account').pop().withSession, 'the read after a reload carried the session');
    await context.close();
  });

  await test('logging out from Pages: the CSRF header passes the preflight, and the session ends on the server', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpOnPages(page, 'ada@cross.test');
    const token = (await sessionCookie(context)).value;
    assert.ok(await auth.readSession(token), 'signed in to begin with');

    await page.click('#signout-button');
    await page.waitForURL(`${SITE}/account.html`);
    await page.waitForSelector('#panel-choose:not([hidden])');

    crossedWithToken('/api/auth');
    assert.strictEqual(await auth.readSession(token), null, 'the session record is gone');
    assert.strictEqual(await sessionCookie(context), null, 'and the browser no longer holds the cookie');
    await context.close();
  });

  await test('checkout from Pages: the CSRF header passes the preflight, and Stripe is told to return to Pages', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpOnPages(page, 'ada@cross.test');
    await users.markVerified(await users.byEmail('ada@cross.test'));

    await page.goto(`${SITE}/pricing.html`, { waitUntil: 'domcontentloaded' });
    const buy = page.locator('.plan-card[data-plan="pro"] [data-plan-action]');
    await page.waitForFunction(() => {
      const b = document.querySelector('.plan-card[data-plan="pro"] [data-plan-action]');
      return b && b.textContent.trim() === 'Get Pro' && !b.disabled;
    });
    await buy.click();
    await page.waitForURL(`https://${STRIPE_HOST}/c/pay/cs_cross`);

    const checkout = crossedWithToken('/api/checkout');
    assert.ok(headerList(apiRequests('OPTIONS', '/api/checkout')[0].asked).includes('x-fynd-csrf'),
      'the first checkout preflight asked for the CSRF header, and was allowed it');
    assert.ok(checkout);
    const session = stripeCalls.find((c) => c.href.endsWith('/v1/checkout/sessions'));
    assert.ok(session, 'Stripe was never asked for a checkout');
    assert.ok(session.params.get('success_url').startsWith(`${SITE}/pricing.html?checkout=success`), session.params.get('success_url'));
    assert.ok(session.params.get('cancel_url').startsWith(`${SITE}/pricing.html?checkout=cancelled`));
    await context.close();
  });

  await test('a page on an origin the API does not trust can neither read the account nor end its session', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await signUpOnPages(page, 'ada@cross.test');
    const token = (await sessionCookie(context)).value;

    const elsewhere = await context.newPage();
    await elsewhere.goto(`${HOSTILE_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    const tried = await elsewhere.evaluate(async (api) => {
      const out = {};
      try {
        const r = await fetch(`${api}/api/account`, { credentials: 'include' });
        out.read = `read ${r.status}: ${(await r.text()).slice(0, 40)}`;
      } catch (err) { out.read = 'blocked'; }
      try {
        const r = await fetch(`${api}/api/auth`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Fynd-CSRF': 'a-guess' },
          body: JSON.stringify({ action: 'logout' })
        });
        out.logout = `sent ${r.status}`;
      } catch (err) { out.logout = 'blocked'; }
      /* the one shape that needs no preflight: it reaches the server, and
         the server's own origin check has to be what stops it */
      try {
        await fetch(`${api}/api/auth`, {
          method: 'POST', mode: 'no-cors', credentials: 'include',
          headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'logout' })
        });
        out.simple = 'sent';
      } catch (err) { out.simple = 'blocked'; }
      return out;
    }, API_ORIGIN);

    assert.strictEqual(tried.read, 'blocked', `another origin read the account: ${tried.read}`);
    assert.strictEqual(tried.logout, 'blocked', `another origin's preflighted logout went through: ${tried.logout}`);
    const hostilePreflight = requests.find((r) => r.host === API_HOST && r.method === 'OPTIONS' && r.origin === HOSTILE_ORIGIN);
    assert.ok(hostilePreflight && hostilePreflight.status === 403 && !hostilePreflight.allowOrigin, 'its preflight is refused outright');
    const simple = requests.find((r) => r.host === API_HOST && r.method === 'POST' && r.origin === HOSTILE_ORIGIN);
    assert.ok(simple && simple.status === 403, 'the unpreflighted POST is refused by the server');

    assert.ok(await auth.readSession(token), 'the session survives all three');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#panel-account:not([hidden])');
    await context.close();
  });

  await browser.close();
  tls.close();
  proxy.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
