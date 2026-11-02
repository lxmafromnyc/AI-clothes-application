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

/* OpenWeb Ninja counts as configured only on a subscription marked
   active; these tests stand it in, so they mark it so */
process.env.OPENWEBNINJA_SUBSCRIPTION = 'active';

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..');
const PORT = 8901;
const ORIGIN = `http://127.0.0.1:${PORT}`;
/* The pages alone, on an origin of their own — the way GitHub Pages
   serves them apart from the functions on Vercel. Same host, another
   port: a different origin, so CORS and its preflight apply in full, but
   the same site, so the cookie still travels. See the cross-origin test
   for what that does and does not prove. */
const PAGE_PORT = 8902;
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;
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
/* Find Fit's UNIQLO list: the products Fynd holds, plus a FIXTURE
   snapshot in the shape scripts/fetch-uniqlo-catalog.js writes — every
   code from E900001 and every "FIXTURE" name is invented */
process.env.FYND_UNIQLO_CATALOG = path.join(__dirname, 'fixtures/uniqlo-catalog-fixture.json');
process.env.ALLOWED_ORIGIN = `${ORIGIN},${PAGE_ORIGIN}`;
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
const auth = require('../api/_auth');
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

/* Product pages read for their sizing charts (api/_sizing/chart.js),
   answered in-process: invented pages in the shapes shops publish, a
   site that refuses automated readers, and nothing else — every other
   address is unreachable, so no test can reach a real shop. */
const charts = require('../api/_sizing/chart');
const transportAsked = [];
const SHOP_FILLER = '<p>' + 'An illustrative product page, invented for these tests, with enough words to read as a page. '.repeat(6) + '</p>';
const shopPage = (title, inner, head) => `<!doctype html><html><head><title>${title}</title><meta property="og:site_name" content="Illustrative Shop">${head || ''}</head><body>${SHOP_FILLER}${inner}</body></html>`;
const SHOP_PAGES = {
  'https://shop.example.test/products/garment-tee': shopPage('Illustrative Garment Tee | Illustrative Shop',
    '<h2>Garment measurements, laid flat (cm)</h2><table><tr><th>Size</th><th>Chest width</th><th>Body length</th></tr><tr><td>S</td><td>51</td><td>70</td></tr><tr><td>M</td><td>54</td><td>72</td></tr></table>',
    `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Illustrative Garment Tee', brand: { name: 'Illustrative Brand' } })}</script>`),
  'https://shop.example.test/products/guide-tee': shopPage('Illustrative Guide Tee', '<a href="/pages/size-guide">Size guide</a>'),
  'https://shop.example.test/pages/size-guide': shopPage('Size guide | Illustrative Shop', '<h1>Tops size guide</h1><p>Body measurements in inches.</p><table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>34-36</td></tr><tr><td>M</td><td>38-40</td></tr></table>'),
  'https://shop.example.test/products/script-tee': '<!doctype html><html><head><title>Shop</title></head><body><div id="root"></div></body></html>',
  'https://shop.example.test/products/labels-tee': shopPage('Illustrative Labels Tee', '<p>Choose a size.</p>',
    `<script type="application/ld+json">${JSON.stringify({ '@type': 'ProductGroup', name: 'Illustrative Labels Tee', hasVariant: ['S', 'M', 'L'].map((size) => ({ size })) })}</script>`),
  /* FIXTURE: a listed product with no record whose own page has both
     tabs' tables, the garment's laid out after the body's; and a product
     whose record holds only the body chart, its page the garment's.
     Every value invented. */
  'https://www.uniqlo.com/us/en/products/E900002-000/00': shopPage('FIXTURE Men’s Sweat Hoodie 02 | UNIQLO US',
    '<h3>Body Size</h3><p>The dimensions shown below are body size measurements that correspond with a product’s size. Inches</p><table><tr><th>Size</th><th>Chest</th></tr><tr><td>S</td><td>34 - 37</td></tr><tr><td>M</td><td>37 - 40</td></tr></table>'
    + '<h3>Product Size</h3><p>The dimensions shown below are the actual measurements of the product. Inches</p><table><tr><th>Size</th><th>Length (back)</th><th>Shoulder width (seam to seam)</th><th>Chest</th><th>Sleeve Length (center back)</th></tr><tr><td>S</td><td>26</td><td>21</td><td>23</td><td>33</td></tr><tr><td>M</td><td>27</td><td>22</td><td>24</td><td>34</td></tr></table>'),
  'https://www.nike.com/t/club-mens-fleece-crew-RU1Il4yl/FN3886-010': shopPage('FIXTURE Club Fleece Crew page',
    '<h3>Product measurements</h3><p>Garment measurements, laid flat, in inches.</p><table><tr><th>Size</th><th>Chest width</th><th>Body length</th><th>Sleeve length (center back)</th></tr><tr><td>S</td><td>20</td><td>26</td><td>33</td></tr><tr><td>M</td><td>21.5</td><td>27</td><td></td></tr></table>'),
  /* the shape of the first real failure: the page loads, names the
     product, its fit and fabric, and carries no chart at all */
  'https://shop.example.test/products/details-shorts': shopPage('Illustrative Sweat Shorts', '<p>Pick a size.</p>',
    `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Illustrative Sweat Shorts', brand: { name: 'Illustrative Brand' }, material: '100% Cotton', additionalProperty: [{ '@type': 'PropertyValue', name: 'Fit', value: 'Relaxed' }] })}</script>`)
};
/* What Find Fit draws from a page it may read: these stubbed shops are
   marked permitted for this suite only (api/_sizing/page-access.js). As
   deployed, no domain is; scripts/test-page-access.js and
   scripts/test-provider-unavailable.js hold that. None has a robots.txt. */
require('../api/_sizing/page-access').setPolicy(Object.fromEntries(['example.test', 'uniqlo.com', 'nike.com', 'zara.com', 'carhartt.com', 'hm.com']
  .map((d) => [d, { access: 'permitted', basis: 'this test suite only; stubbed pages, never fetched' }])));
charts.setTransport(async (url) => {
  if (/\/robots\.txt$/.test(url)) return { status: 404, ok: false, headers: { get: () => null }, text: async () => '' };
  transportAsked.push(url);
  const html = (u) => ({ status: 200, ok: true, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) }, text: async () => u });
  if (url.startsWith('https://www.zara.com/')) return { status: 403, ok: false, headers: { get: () => null }, text: async () => 'Access denied' };
  /* a shop that never starts answering: the request is given up */
  if (url.startsWith('https://silent.example.test/')) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  /* as the deployed site sees uniqlo.com: these product pages never answer */
  if (/^https:\/\/www\.uniqlo\.com\/us\/en\/products\/(E471808|E900001)-000\//.test(url)) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (SHOP_PAGES[url]) return html(SHOP_PAGES[url]);
  throw new Error('unreachable');
});

/* ---------------------------------------------------------
   The server: real handlers, real HTTP
   --------------------------------------------------------- */

/* the UNIQLO pair, marked checked in memory for a test of the comparison on their real numbers */
const { asChecked, UQ_PAIR } = require('./fixtures/as-checked');
const Schema = require('../assets/fit-profile-schema.js');
const HANDLERS = {
  '/api/auth': require('../api/auth'),
  '/api/account': require('../api/account'),
  '/api/verify-email': require('../api/verify-email'),
  '/api/google-start': require('../api/google-start'),
  '/api/google-callback': require('../api/google-callback'),
  '/api/checkout': require('../api/checkout'),
  '/api/portal': require('../api/portal'),
  '/api/fit-profile': require('../api/fit-profile'),
  '/api/size-recommendation': require('../api/size-recommendation'),
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

/* every request a handler answered, with what CORS looks at, so the
   cross-origin test can show its requests really came from elsewhere */
const apiRequests = [];

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

  /* Find Fit's brand menu and product list are counted apart from
     sizing-chart lookups, so a count of lookups means lookups */
  const browsing = url.pathname === '/api/size-recommendation' && (url.searchParams.has('brands') || (url.searchParams.has('brand') && !url.searchParams.has('item')));
  /* checking an item before comparing reads nothing; counted apart too */
  const checking = url.pathname === '/api/size-recommendation' && url.searchParams.get('check') === '1';
  const anchoring = url.pathname === '/api/size-recommendation' && url.searchParams.has('anchors');
  /* an item entered by hand, compared */
  const byHand = url.pathname === '/api/size-recommendation' && url.searchParams.get('candidate') === '1';
  /* the anonymous product counters (api/_metrics.js), named apart from every lookup and comparison */
  const counting = url.pathname === '/api/size-recommendation' && url.searchParams.get('metrics') === '1';
  if (url.pathname.startsWith('/api/')) apiHits.push(browsing ? '/api/size-recommendation (browse)' : checking ? '/api/size-recommendation (check)' : anchoring ? '/api/size-recommendation (anchors)' : byHand ? '/api/size-recommendation (candidate)' : counting ? '/api/size-recommendation (metrics)' : url.pathname);
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
    apiRequests.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      origin: req.headers.origin || null,
      csrf: Boolean(req.headers[auth.CSRF_HEADER]),
      status: res.statusCode
    });
    return;
  }

  /* the interpreter and the product search are not what this suite is
     about; answered so the pages behave normally */
  if (url.pathname === '/api/interpret' || url.pathname === '/api/search') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ source: null, products: [], preferences: {} }));
  }

  return serveFile(url, res);
});

function serveFile(url, res) {
  const file = path.join(REPO, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
}

/* The pages and nothing else, as a static host serves them: /api/ is a
   404 here, the answer assets/account.js reads as "no API on this
   origin". */
const pageServer = http.createServer((req, res) => {
  const url = new URL(req.url, PAGE_ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    res.statusCode = 404;
    return res.end('not found');
  }
  return serveFile(url, res);
});

const closeServers = () => { server.close(); pageServer.close(); };

/* ---------------------------------------------------------
   Runner
   --------------------------------------------------------- */

let passed = 0;
const failures = [];

/* FYND_TEST_ONLY=<regex>: run only the tests whose names match — for
   working on one; unset (as CI runs it), every test runs */
const ONLY = process.env.FYND_TEST_ONLY ? new RegExp(process.env.FYND_TEST_ONLY) : null;
async function test(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
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
  await new Promise((r) => pageServer.listen(PAGE_PORT, r));

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME,
      /* No hostname resolves; 127.0.0.1 is all there is. The same rule
         the route in openContext() enforces, at a level that intercepts
         nothing — which a context opened without that route relies on. */
      args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
    });
  } catch (err) {
    console.log('Chromium could not launch here — skipping end-to-end tests.');
    closeServers();
    process.exit(0);
  }

  /* A fresh browser context per test: its own cookie jar, so one test's
     session cannot be another's. */
  async function openContext(options) {
    const context = await browser.newContext({ baseURL: ORIGIN });

    /* The pages carry a meta tag pointing at the production deployment,
       because that is what the published site needs. Here the endpoints
       are this test server, and the same window override the site
       documents is how that is said. */
    await context.addInitScript((origin) => {
      window.FINDWEAR_API = `${origin}/api/interpret`;
      window.FINDWEAR_SEARCH_API = `${origin}/api/search`;
    }, ORIGIN);

    /* Find Fit's hand-entry fallbacks — the item's one-size form, your
       garment's measurements and its optional details — are folded away
       until a shopper wants them. The tests of what those forms do open
       them first, as a shopper would, each the first time it appears
       (byHand: false leaves the page as a shopper first sees it). */
    if (!options || options.byHand !== false) {
      await context.addInitScript(() => {
        const open = () => ['ff-manual', 'ffr-manual', 'ffr-details'].forEach((id) => {
          const d = document.getElementById(id);
          if (d && !d.dataset.testOpened) { d.dataset.testOpened = '1'; d.open = true; }
        });
        document.addEventListener('DOMContentLoaded', () => {
          open();
          new MutationObserver(open).observe(document.body, { childList: true, subtree: true });
        });
      });
    }

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
       everything else makes the pages deterministic.

       But while any route is installed, Playwright answers every CORS
       preflight itself, with a 204 allowing whatever was asked, and the
       server never sees it. A test about the server's own preflight
       answer opens its context with { intercept: false } and leaves the
       cutting to the launch flag above. */
    if (!(options && options.intercept === false)) {
      await context.route((url) => !String(url).includes('127.0.0.1'), (route) => route.abort());
    }

    return context;
  }

  const open = async (page, file, origin) => {
    await page.goto(`${origin || ORIGIN}/${file}`, { waitUntil: 'domcontentloaded' });
    return page;
  };

  /* Fills and submits the email form, from the front door each time. */
  async function signUpThroughTheUI(page, { name, email, password, confirm }, origin) {
    await open(page, 'account.html', origin);
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
    for (const file of ['index.html', 'find-clothes.html', 'fit-profile.html', 'pricing.html', 'about.html']) {
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

  await test('Discover and the fit guide are retired: no page links to either, and their old addresses land on Find Fit and the fit profile', async () => {
    const context = await openContext();
    const page = await context.newPage();
    const PAGES = ['index.html', 'find-clothes.html', 'fit-profile.html', 'compare.html', 'pricing.html', 'about.html', 'account.html'];
    for (const file of PAGES) {
      await open(page, file);
      assert.deepStrictEqual(await page.$$eval('a[href*="discover"]', (ns) => ns.map((n) => n.getAttribute('href'))), [], `${file} still links to Discover`);
      assert.ok(!/\bDiscover\b/.test(await page.textContent('body')), `${file} still says Discover`);
      /* shopping first, and the fit profile the one place for sizing; no fit guide anywhere */
      assert.deepStrictEqual(await page.$$eval('.nav-links a', (ns) => ns.map((n) => n.textContent.trim())),
        ['Find Fit', 'Compare', 'Fit profile', 'Pricing', 'About', 'Account'], `${file}: main navigation`);
      /* the Search page is reached from shopping and the footer, not the main navigation */
      assert.ok(await page.$('.footer-links a[href="find-clothes.html"]'), `${file}: the footer still links to Search`);
      assert.ok(!/fit guide/i.test(await page.textContent('body')), `${file} still mentions the fit guide`);
      assert.deepStrictEqual(await page.$$eval('a[href*="#guide"]', (ns) => ns.map((n) => n.getAttribute('href'))), [], `${file} links to the old guide`);
      assert.ok(await page.$('.footer-links a[href="compare.html"]'), `${file}: the footer links to Compare`);
      assert.ok(await page.$('.footer-links a[href="fit-profile.html"]'), `${file}: the footer links to the fit profile`);
    }
    await open(page, 'fit-profile.html');
    assert.strictEqual((await page.textContent('.nav-links a[aria-current="page"]')).trim(), 'Fit profile');
    await page.click('.nav-links a[href="fit-profile.html"]');
    await page.waitForSelector('#profile-signed-out:not([hidden])');

    /* an old link or bookmark: lands on shopping, and nothing on the
       way searches, reads with the AI, or reaches a product source */
    apiHits.length = 0;
    providerCalls.length = 0;
    await open(page, 'discover.html');
    await page.waitForURL(/\/index\.html$/);
    await page.waitForSelector('#ff-form #ffi-link');
    assert.strictEqual((await page.textContent('.nav-links a[aria-current="page"]')).trim(), 'Find Fit');
    assert.deepStrictEqual(apiHits.filter((p) => p === '/api/search' || p === '/api/interpret'), [], 'the old address reached a search endpoint');
    assert.deepStrictEqual(providerCalls, [], 'the old address reached a product source or AI provider');

    /* the old fit guide's address lands on the fit profile, where it now lives */
    await page.goto(`${ORIGIN}/index.html#guide`);
    await page.waitForURL(/\/fit-profile\.html$/);
    await page.waitForSelector('#profile-signed-out:not([hidden])');
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

  const waitForDeleted = (page) => page.waitForFunction(() => {
    const note = document.getElementById('profile-note');
    return !note.hidden && /deleted/.test(note.textContent);
  });

  await test('signed out, the fit profile page asks you to sign in and never asks for the profile', async () => {
    const context = await openContext();
    const page = await context.newPage();
    apiHits.length = 0;
    await open(page, 'fit-profile.html');
    await page.waitForSelector('#profile-signed-out:not([hidden])');
    assert.strictEqual(await page.$eval('#profile-form', (n) => n.hidden), true, 'no form for somebody signed out');
    assert.ok(await page.isVisible('#profile-account #pa-email'), 'an account can be made, or signed into, right here');
    assert.match(await page.textContent('#profile-signed-out'), /searching never needs an account/);
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
    assert.strictEqual(await page.textContent('#profile-save-state'), 'Unsaved changes');
    await saveAndWait(page);

    const stored = await savedProfile('ada@e2e.test');
    assert.deepStrictEqual(stored.measurements, { unit: 'in', height: 70, chest: 40, waist: null, hip: null });
    assert.deepStrictEqual(stored.brandSizes, [
      { brand: 'Uniqlo', category: 'hoodies', size: 'M', fit: 'about-right' },
      { brand: 'Champion', category: 'sweatshirts', size: null, fit: null }
    ]);
    assert.deepStrictEqual(stored.fitPreferences, {});
    assert.strictEqual(await page.$eval('#brand-list .brand-row [data-part="size"] input', (n) => n.value), 'M',
      'the page shows what the server kept');

    await page.reload();
    await page.waitForSelector('#profile-form:not([hidden])');
    assert.strictEqual(await page.$eval('#height-ft', (n) => n.value), '5');
    assert.strictEqual(await page.$eval('#height-in', (n) => n.value), '10');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '40');
    assert.strictEqual(await page.locator('#brand-list > .brand-row').count(), 2);
    assert.strictEqual(await page.isVisible('#section-fit'), false, 'how a type should fit is asked on its own card, not twice');
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

  await test('usual sizes and one type’s fit alone save, with no measurement at all', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    await addBrand(page, { brand: 'Gap', category: 'hoodies', size: 'S', fit: 'too-small' });
    await page.selectOption('#garment-add-select', 'sweatshirts');
    await page.click('#garment-add');
    await page.check('input[name="g-sweatshirts-goal"][value="oversized"]');
    await saveAndWait(page);

    const stored = await savedProfile('ada@e2e.test');
    assert.deepStrictEqual([stored.measurements.height, stored.measurements.chest], [null, null]);
    assert.deepStrictEqual(stored.brandSizes, [{ brand: 'Gap', category: 'hoodies', size: 'S', fit: 'too-small' }]);
    assert.strictEqual(stored.garments.sweatshirts.fitGoal, 'oversized');
    assert.strictEqual(stored.garments.sweatshirts.anchor, null, 'nothing else had to be answered');
    await context.close();
  });

  await test('an earlier per-category preferred fit is shown only to a profile that has one, kept, and can be cleared', async () => {
    const context = await openContext();
    const page = await profilePage(context, 'ada@e2e.test');
    assert.strictEqual(await page.isVisible('#section-fit'), false);
    const user = await users.byEmail('ada@e2e.test');
    await fitProfiles.save(user.id, { schemaVersion: 5, fitPreferences: { hoodies: 'relaxed' } });
    await page.reload();
    await page.waitForSelector('#profile-form:not([hidden])');
    assert.strictEqual(await page.isVisible('#section-fit'), true);
    assert.strictEqual(await page.$eval('input[name="pref-hoodies"][value="relaxed"]', (n) => n.checked), true);
    await page.fill('#measure-chest', '40');
    await saveAndWait(page);
    assert.deepStrictEqual((await savedProfile('ada@e2e.test')).fitPreferences, { hoodies: 'relaxed' }, 'kept through a save');
    await page.check('input[name="pref-hoodies"][value=""]');
    await saveAndWait(page);
    assert.deepStrictEqual((await savedProfile('ada@e2e.test')).fitPreferences, {});
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
    /* the note may already be on screen saying the store is not durable,
       so wait for what it says, not for it to appear */
    await waitForDeleted(page);
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

  /* =========================================================
     Shopping first, and the fit profile as the one place for sizing
     ========================================================= */

  console.log('\nshopping, and the fit profile it uses');

  /* Listings the stand-in product search answers with: one UNIQLO hoodie
     whose link carries its product code (so Fynd has its sizing), and
     two pieces Fynd has no measurements for. */
  const UQ_HOODIE_LISTING = { id: 'uq-hoodie', name: 'Sweat Pullover Hoodie', brand: 'UNIQLO', retailer: 'UNIQLO', price: 39.9, currency: 'USD',
    productUrl: 'https://www.uniqlo.com/us/en/products/E475378-000/00?colorDisplayCode=09', imageUrl: null };
  const LISTINGS = [
    UQ_HOODIE_LISTING,
    { id: 'gap-hoodie', name: 'Arch Logo Hoodie', brand: 'Gap', retailer: 'Gap', price: 49.95, currency: 'USD', productUrl: 'https://www.gap.com/browse/product.do?pid=1', imageUrl: null },
    { id: 'zara-tee', name: 'Boxy T-shirt', brand: 'Zara', retailer: 'Zara', price: 19.9, currency: 'USD', productUrl: 'https://www.zara.com/us/en/boxy-t-shirt-p1.html', imageUrl: null }
  ];

  /* The product search, answering with these listings, for this page:
     what the search finds is not what these tests are about, and the
     listings have to be ones whose links name a product. */
  const listingsFor = async (page) => {
    await page.route(`${ORIGIN}/api/search`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ source: 'openwebninja', products: LISTINGS }) }));
  };

  /* Signed in through the real account page. */
  async function signedIn(context, email) {
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email, password: PASSWORD });
    await page.waitForSelector('#panel-account:not([hidden])');
    return page;
  }

  /* the results on screen now, not the ones fading out from the search before */
  const NOW = '.results-body:not(.results-leaving)';
  const panelState = async (page) => {
    await page.waitForSelector(`${NOW} .fit-panel:not([data-state="loading"])`);
    return page.$eval(`${NOW} .fit-panel`, (n) => n.dataset.state);
  };











  /* a garment described on Find Fit, in the form's own fields */
  const describe = async (page, g) => {
    await page.waitForSelector('#ff-reference .ffr-form');
    await page.selectOption('#ffr-type', g.type);
    await page.selectOption('#ffr-size', g.size);
    await page.fill('#ffr-brand', g.brand);
    if (g.product) { await page.evaluate(() => { document.getElementById('ffr-details').open = true; }); await page.fill('#ffr-product', g.product); }
    if (g.measurements) {
      /* the unit is chosen once, at the top, before the values are typed: switching after would convert them */
      await page.check(`input[name="ff-unit"][value="${g.measurements.unit}"]`);
      for (const [k, v] of Object.entries(g.measurements)) if (k !== 'unit') await page.fill(`#ffr-m-${k}`, String(v));
    }
    await page.click('#ffr-use');
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
  };
  /* ---------- Find Fit with the item entered by hand ---------- */
  /* the form's own method for each measurement */
  const FORM_HOW = { chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };
  const MINE_CM = { unit: 'cm', chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 };
  const MY_HOODIE = { type: 'hoodies', size: 'L', brand: 'Carhartt', measurements: MINE_CM };
  /* the item, typed into its own form: only the values given, each with how the chart measures it */
  const enterItem = async (page, it) => {
    await page.waitForSelector('#ffc-form');
    if (it.type) await page.check(`input[name="ff-type"][value="${it.type}"]`);
    if (it.brand !== undefined) await page.fill('#ffc-brand', it.brand);
    if (it.name !== undefined) await page.fill('#ffc-name', it.name);
    if (it.size !== undefined) await page.fill('#ffc-size', it.size);
    if (it.unit) await page.check(`input[name="ff-unit"][value="${it.unit}"]`);
    for (const [k, v] of Object.entries(it.measurements || {})) {
      await page.fill(`#ffc-m-${k}`, String(v));
      const how = (it.how && it.how[k]) || FORM_HOW[k];
      if (how) await page.selectOption(`#ffc-how-${k}`, how);
    }
  };
  const compareByHand = async (page) => {
    await page.click('#ff-submit');
    await page.waitForSelector('#fit-compare:not([hidden]):not([data-verdict="loading"]) .fit-compare-title');
  };
  const byHandAsked = () => apiHits.filter((p) => p === '/api/size-recommendation (candidate)').length;
  const SAME_ITEM = { type: 'hoodies', brand: 'AnyBrand', name: 'Heavy Hood', size: 'L', unit: 'cm', measurements: { chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 } };

  await test('Find Fit, two questions: which clothes fit you, and what you’re buying — side by side, the item by its link first, every hand-entry form folded away until wanted, and one Compare button', async () => {
    const context = await openContext({ byHand: false });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="signed-out"] .ffr-form');
    assert.strictEqual((await page.textContent('#find-fit-title')).trim(), 'Find the size that fits like your favorite clothes.');
    /* the two questions */
    assert.deepStrictEqual(await page.$$eval('.ff-col .ff-step-title', (hs) => hs.map((h) => h.textContent.replace(/\s+/g, ' ').trim())), ['01 · Which clothes already fit you the way you like?', '02 · What are you thinking of buying?']);
    /* what a shopper sees first: the garment's search, its type and size, its brand — and the item's link. Nothing else */
    /* Playwright's own visibility: a closed <details> keeps its content's boxes in some Chromium builds */
    const visible = [];
    for (const handle of await page.$$('#ff-form input:not([type=hidden]), #ff-form select')) {
      if (await handle.isVisible()) visible.push(await handle.getAttribute('id'));
    }
    assert.deepStrictEqual(visible, ['ffr-search', 'ffr-type', 'ffr-size', 'ffr-brand', 'ffi-link']);
    assert.strictEqual(await page.isVisible('#ffi-link-go'), true);
    assert.match(await page.textContent('#ffi-ext-tip'), /Fynd Chrome extension reads it in your browser/);
    /* the fallbacks: folded, one click away — the unit only while something is typed by hand */
    assert.deepStrictEqual(await page.$$eval('#ff-manual, #ffr-details, #ffr-manual', (ds) => ds.map((d) => [d.id, d.open])), [['ffr-details', false], ['ffr-manual', false], ['ff-manual', false]]);
    assert.strictEqual(await page.isHidden('#ff-units-strip'), true);
    await page.click('#ff-manual > summary');
    /* the unit, for what is typed: shown once the fallback is open */
    await page.waitForSelector('#ff-units-strip:not([hidden])');
    assert.deepStrictEqual(await page.$$eval('input[name="ff-unit"]', (rs) => rs.map((r) => [r.value, r.checked])), [['cm', true], ['in', false]]);
    assert.deepStrictEqual(await page.$$eval('input[name="ff-type"]', (rs) => rs.map((r) => [r.value, r.checked, r.closest('label').querySelector('.ff-type-name').textContent])), [['hoodies', true, 'Hoodie'], ['sweatshirts', false, 'Sweatshirt']]);
    /* balanced, side by side, within a comfortable width, nothing sideways */
    const box = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { ref: r('ff-step-reference'), item: r('ff-step-target'), flow: r('ff-form'), scroll: document.documentElement.scrollWidth - window.innerWidth };
    });
    assert.strictEqual(Math.round(box.ref.top), Math.round(box.item.top), 'side by side');
    assert.ok(box.ref.right < box.item.left, 'garment left, item right');
    assert.ok(Math.abs(box.ref.width - box.item.width) <= 2, `balanced (${box.ref.width} vs ${box.item.width})`);
    assert.ok(box.flow.width <= 1120 && box.flow.width >= 900, `a comfortable width (${box.flow.width})`);
    assert.ok(box.scroll <= 0, 'no sideways scroll');
    /* the item by hand, opened: each field labelled; units in the boxes; how each is measured beside it */
    const labels = await page.$$eval('#ffc-form label.profile-label', (ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
    assert.deepStrictEqual(labels, ['Brand optional', 'Product name optional', 'Size being considered',
      'Chest width', 'How the chart measures it', 'Shoulder width', 'How the chart measures it', 'Body length', 'How the chart measures it', 'Sleeve length', 'How the chart measures it']);
    assert.deepStrictEqual(await page.$$eval('#ffc-form .measure-unit', (ns) => ns.map((n) => n.textContent)), ['cm', 'cm', 'cm', 'cm']);
    assert.ok(await page.$$eval('#ffc-form select[id^="ffc-how-"]', (ss) => ss.length === 4 && ss.every((x) => x.offsetParent)), 'every method selector visible');
    assert.ok(await page.evaluate(() => window.FitCandidate.DIMS.every((d) => JSON.stringify([...document.querySelectorAll(`#ffc-how-${d} option`)].slice(1).map((o) => [o.value, o.textContent])) === JSON.stringify(window.FitCandidate.METHODS[d].map((m) => [m.id, m.label])))), 'the page and assets/fit-candidate.js say the same');
    /* your garment's measurements, opened: the item's rows, row for row, its fixed method beside each */
    await page.click('#ffr-manual > summary');
    assert.deepStrictEqual(await page.$$eval('#ff-reference .ff-mrow', (rs) => rs.map((r) => [r.dataset.dim, r.querySelector('label').textContent, r.querySelector('.ff-method-fixed').dataset.method])), [
      ['chestWidth', 'Chest width', 'flat-width-armpit-to-armpit'], ['shoulderWidth', 'Shoulder width', 'seam-to-seam'],
      ['bodyLength', 'Body length', 'high-point-shoulder-to-hem'], ['sleeveLength', 'Sleeve length', 'shoulder-seam-to-cuff']]);
    const rowHeights = await page.$$eval('.ff-mrow .profile-input', (is) => [...new Set(is.map((i) => Math.round(i.getBoundingClientRect().height)))]);
    assert.deepStrictEqual(rowHeights, [44], 'one input height in both forms');
    /* the garment's type follows the item's, while it is being filled in */
    assert.strictEqual(await page.inputValue('#ffr-type'), 'hoodies');
    await page.check('input[name="ff-type"][value="sweatshirts"]');
    assert.strictEqual(await page.inputValue('#ffr-type'), 'sweatshirts');
    /* one Compare button: never looking available while something it needs is missing, and saying what */
    assert.deepStrictEqual(await page.$$eval('#find-fit button[type="submit"]', (bs) => bs.map((b) => b.textContent.trim())), ['Compare fit']);
    assert.strictEqual(await page.getAttribute('#ff-submit', 'aria-disabled'), 'true');
    assert.strictEqual(await page.textContent('#ff-submit-note'), 'Choose your garment, and paste the item’s link — or enter it by hand.');
    const geo = await page.evaluate(() => ({ button: document.getElementById('ff-submit').getBoundingClientRect(), cols: document.querySelector('.ff-columns').getBoundingClientRect() }));
    assert.ok(geo.button.top > geo.cols.bottom && geo.button.width >= 480, 'one wide button beneath both forms');
    /* no brand browser or catalogue on the page */
    assert.strictEqual(await page.$('#fit-url, #fit-browser, #fit-brands, #fit-brand-dialog, #ff-suggest, #ff-check, #ff-picked, #fit-link-alt, #ffc-type'), null);
    assert.deepStrictEqual(await page.evaluate(() => [typeof window.FindFit, typeof window.BrandBrowser]), ['undefined', 'undefined']);
    assert.ok(!apiHits.includes('/api/size-recommendation (browse)'), 'no brand list asked for');
    assert.deepStrictEqual(await page.$$eval('#ff-progress .ff-progress-text', (ns) => ns.map((n) => n.textContent)), ['Your garment: not added yet', 'Item: not entered yet']);
    assert.strictEqual(await page.isHidden('#fit-result'), true);
    await context.close();
  });

  /* ---------- the redesigned flow: Fynd does the measuring ---------- */
  const ZARA_HOODIE = 'https://www.zara.com/us/en/basic-heavyweight-hoodie-p00761810.html';
  const UQ_HOODIE_LINK = 'https://www.uniqlo.com/us/en/products/E475378-000/00';
  const SHOULDER_WAY = { registry: 1, chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };
  const itemFound = (page) => page.waitForSelector('#ffi-found[data-state]:not([data-state="loading"])');
  const resultDone = (page) => page.waitForFunction(() => document.getElementById('fit-result').dataset.state === 'done', null, { timeout: 15000 });
  /* only the shopper's own changes count as manual inputs (assets/fit-metrics.js) */
  const lastEffort = (page) => page.evaluate(() => window.FyndMetrics.last());

  await test('a returning shopper: the saved hoodie is chosen for a hoodie, the T-shirt marked a different kind; a pasted link finds every size and the measurements, one tick confirms them, and every size is compared in one request — two manual inputs in all', async () => {
    const context = await openContext({ byHand: false });
    const page = await signedIn(context, 'returning@e2e.test');
    const p = Schema.empty();
    p.garments = {
      hoodies: Object.assign(Schema.emptyGarment('hoodies'), { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'L', measurements: { unit: 'cm', chestWidth: 63, bodyLength: 70.5, shoulderWidth: 54, sleeveLength: 65 }, methods: SHOULDER_WAY } }),
      tshirts: Object.assign(Schema.emptyGarment('tshirts'), { favorite: 'perfect', anchor: { brand: 'Gap', size: 'M', measurements: { unit: 'in', chestWidth: 21, bodyLength: 28 }, methods: { registry: 1, chestWidth: SHOULDER_WAY.chestWidth, bodyLength: SHOULDER_WAY.bodyLength } } })
    };
    await fitProfiles.save((await users.byEmail('returning@e2e.test')).id, p);
    const posted = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /candidate=1/.test(r.url())) posted.push(r.postDataJSON()); });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="saved"]');
    assert.strictEqual(await page.isVisible('#ffr-search'), false, 'a saved garment: no form to fill');
    await page.fill('#ffi-link', ZARA_HOODIE);
    await page.click('#ffi-link-go');
    await itemFound(page);
    /* found: the product, its sizes, Fynd's unchecked copy said so, the kind from its record — the one thing asked is the check */
    assert.strictEqual(await page.getAttribute('#ffi-found', 'data-state'), 'assisted');
    assert.match(await page.textContent('#ffi-found .ffi-name'), /Zara · BASIC HEAVYWEIGHT HOODIE/);
    assert.deepStrictEqual(await page.$$eval('#ffi-found .ffi-sizes li', (ls) => ls.map((l) => l.textContent)), ['S', 'M', 'L', 'XL', 'XXL']);
    assert.match(await page.textContent('#ffi-found .ffi-status'), /from its own copy of the product page — not yet checked by Fynd\. Check them against the chart/);
    assert.strictEqual(await page.$('#ffi-type'), null, 'the kind is not asked: Fynd’s record says it');
    /* the saved hoodie chosen for it; the T-shirt can't be */
    assert.deepStrictEqual(await page.$$eval('#ff-reference .ff-ref', (ns) => ns.map((n) => [n.dataset.kind, n.dataset.chosen, n.dataset.other || ''])), [['hoodies', 'true', ''], ['tshirts', 'false', 'true']]);
    assert.strictEqual(await page.isDisabled('#ff-reference input[value="tshirts"]'), true);
    assert.strictEqual(posted.length, 0, 'nothing compared before the check');
    assert.strictEqual(await page.getAttribute('#ff-submit', 'aria-disabled'), 'true');
    /* the check, and nothing else: compared at once */
    await page.check('#ffi-confirm');
    await resultDone(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), 'Recommended size: M');
    /* one request: every size, the saved garment named by its kind — never sent */
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(Object.keys(posted[0]).sort(), ['chart', 'referenceType']);
    assert.strictEqual(posted[0].referenceType, 'hoodies');
    assert.deepStrictEqual(posted[0].chart.sizes.map((x) => x.size), ['S', 'M', 'L', 'XL', 'XXL']);
    assert.strictEqual(posted[0].chart.sizes[1].provenance.chestWidth.source, 'fynd-record');
    /* the result: the size, why, each measurement — and every size folded beneath it */
    assert.match(await page.textContent('#fit-compare'), /Fynd’s own copy of the product page, which you checked/);
    assert.match(await page.textContent('#fit-compare .ff-every summary'), /Every size beside your garment \(5\)/);
    assert.strictEqual(await page.$$eval('#fit-compare .ff-every tbody tr', (rs) => rs.length), 5);
    assert.deepStrictEqual(await lastEffort(page).then((x) => x.manualInputs), 2, 'the link and the check');
    await context.close();
  });

  await test('a product Fynd holds checked measurements for: found from its link and compared at once — nothing to check, nothing to type for the item — through the record path, every size', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext({ byHand: false });
    const page = await context.newPage();
    const posted = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /size-recommendation\?product=/.test(r.url())) posted.push({ url: r.url(), body: r.postDataJSON() }); });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    /* a guest: their garment by its measurements (the fallback), kept for this visit */
    await page.click('#ffr-manual > summary');
    for (const [k, v] of Object.entries({ chestWidth: 59, bodyLength: 68, shoulderWidth: 51, sleeveLength: 62 })) await page.fill(`#ffr-m-${k}`, String(v));
    await page.click('#ffr-use');
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
    await page.fill('#ffi-link', UQ_HOODIE_LINK);
    await page.click('#ffi-link-go');
    await itemFound(page);
    assert.strictEqual(await page.getAttribute('#ffi-found', 'data-state'), 'automatic');
    assert.match(await page.textContent('#ffi-found .ffi-status'), /checked garment measurements for every size\. Nothing to enter/);
    assert.strictEqual(await page.$('#ffi-confirm'), null, 'nothing to check');
    await resultDone(page);
    assert.strictEqual(posted.length, 1, 'compared at once, once');
    assert.match(posted[0].url, /\?product=uniqlo-e475378-sweat-pullover-hoodie-us&compare=1$/);
    assert.strictEqual(posted[0].body.reference.type, 'hoodies');
    assert.ok(['recommended', 'too-few', 'closest-mismatch', 'no-recommendation', 'methods'].includes(await page.getAttribute('#fit-compare', 'data-verdict')));
    await context.close();
  }));

  await test('a guest finds their own garment by pasting its link: the product named, its kind and brand filled, the size on its label the only question — and the item by its link', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext({ byHand: false });
    const page = await context.newPage();
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    await page.fill('#ffr-search', UQ_HOODIE_LINK);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#ffr-held:not([hidden]):not([data-status="checking"])');
    assert.strictEqual(await page.getAttribute('#ffr-held', 'data-status'), 'checked');
    assert.strictEqual(await page.isHidden('#ffr-type-field'), true, 'the kind isn’t asked');
    assert.strictEqual(await page.inputValue('#ffr-brand'), 'UNIQLO');
    await page.selectOption('#ffr-size', 'M');
    await page.click('#ffr-use');
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
    assert.match(await page.textContent('.ff-ref--visit'), /UNIQLO · size M/);
    await context.close();
  }));

  await test('a link Fynd can’t read: an unreviewed retailer, or a body-only chart — said so, with the extension and hand entry as the ways on; nothing compared, no size made up', () => asChecked([], async () => {
    const context = await openContext({ byHand: false });
    const page = await context.newPage();
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    await page.fill('#ffi-link', 'https://shop.example.com/products/plain-hoodie');
    await page.click('#ffi-link-go');
    await itemFound(page);
    assert.strictEqual(await page.getAttribute('#ffi-found', 'data-state'), 'unavailable');
    assert.match(await page.textContent('#ffi-found .ffi-ways'), /Use the Fynd extension on the product page/);
    assert.match(await page.textContent('#ff-progress'), /can’t be read from its link/);
    await page.click('#ffi-found .ffi-ways button');
    assert.strictEqual(await page.$eval('#ff-manual', (d) => d.open), true, 'hand entry, one click away');
    await page.click('#ff-manual > summary');
    await page.fill('#ffi-link', 'https://www.carhartt.com/product/K121/loose-fit-midweight-sweatshirt');
    await page.click('#ffi-link-go');
    await itemFound(page);
    assert.strictEqual(await page.getAttribute('#ffi-found', 'data-state'), 'body-only');
    assert.match(await page.textContent('#ffi-found .ffi-status'), /only a body-size chart/);
    assert.strictEqual(await page.isHidden('#fit-result'), true);
    await context.close();
  }));

  await test('the anonymous counters: only names from a fixed list and two numbers reach Fynd, kept as daily totals — and a comparison’s manual inputs are among them', async () => {
    const before = await require('../api/_metrics').summary(require('../api/_metrics').day());
    const done = (before.site.comparison_completed || { count: 0 }).count;
    const context = await openContext({ byHand: false });
    const page = await signedIn(context, 'counted@e2e.test');
    const p = Schema.empty();
    p.garments = { hoodies: Object.assign(Schema.emptyGarment('hoodies'), { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'L', measurements: { unit: 'cm', chestWidth: 63, bodyLength: 70.5, shoulderWidth: 54, sleeveLength: 65 }, methods: SHOULDER_WAY } }) };
    await fitProfiles.save((await users.byEmail('counted@e2e.test')).id, p);
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="saved"]');
    await page.fill('#ffi-link', ZARA_HOODIE);
    await page.click('#ffi-link-go');
    await itemFound(page);
    await page.check('#ffi-confirm');
    await resultDone(page);
    await page.waitForTimeout(1200);
    const after = await require('../api/_metrics').summary(require('../api/_metrics').day());
    assert.strictEqual(after.site.comparison_completed.count, done + 1);
    assert.ok(after.site.manual_inputs.count >= 1 && after.site.reference_ready_saved.count >= 1 && after.site.extraction_assisted.count >= 1);
    /* the endpoint refuses anything else */
    const bad = await context.request.post(`${ORIGIN}/api/size-recommendation?metrics=1`, { data: { events: [{ name: 'comparison_completed', url: 'https://x' }] } });
    assert.strictEqual(bad.status(), 400);
    const unknown = await context.request.post(`${ORIGIN}/api/size-recommendation?metrics=1`, { data: { events: [{ name: 'shopper_email' }] } });
    assert.strictEqual(unknown.status(), 400);
    await context.close();
  });

  await test('the redesigned flow on a 360px phone: one column, the link and what was found readable, the result fits — nothing sideways', async () => {
    const context = await openContext({ byHand: false });
    const page = await signedIn(context, 'phone-returning@e2e.test');
    const p = Schema.empty();
    p.garments = { hoodies: Object.assign(Schema.emptyGarment('hoodies'), { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'L', measurements: { unit: 'cm', chestWidth: 63, bodyLength: 70.5, shoulderWidth: 54, sleeveLength: 65 }, methods: SHOULDER_WAY } }) };
    await fitProfiles.save((await users.byEmail('phone-returning@e2e.test')).id, p);
    await page.setViewportSize({ width: 360, height: 780 });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="saved"]');
    await page.fill('#ffi-link', ZARA_HOODIE);
    await page.click('#ffi-link-go');
    await itemFound(page);
    await page.check('#ffi-confirm');
    await resultDone(page);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(scroll <= 0, `no sideways scroll (${scroll})`);
    const cols = await page.evaluate(() => [document.getElementById('ff-step-reference').getBoundingClientRect(), document.getElementById('ff-step-target').getBoundingClientRect()]);
    assert.ok(cols[0].bottom <= cols[1].top + 1, 'garment, then item');
    await context.close();
  });

  await test('Find Fit’s information buttons work by keyboard and touch, not hover: Enter or a tap opens the full explanation, Escape or a click elsewhere closes it, focus comes back, and each field points at its explanation all along', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    const info = 'button[aria-controls="ffc-m-chestWidth-info"]';
    assert.strictEqual(await page.isHidden('#ffc-m-chestWidth-info'), true, 'closed to begin with');
    assert.ok((await page.getAttribute('#ffc-m-chestWidth', 'aria-describedby')).split(' ').includes('ffc-m-chestWidth-info'), 'read with the field, open or not');
    /* hover alone opens nothing */
    await page.hover(info);
    assert.strictEqual(await page.isHidden('#ffc-m-chestWidth-info'), true);
    /* by keyboard: reached by Tab from the label's field before it, opened with Enter, closed with Escape */
    await page.focus('#ffc-size');
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('aria-controls')), 'ffc-m-chestWidth-info', 'the information button is in the tab order');
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.getAttribute(info, 'aria-expanded'), 'true');
    assert.match(await page.textContent('#ffc-m-chestWidth-info'), /Usually “chest” or “½ chest” on the chart\. Flat means straight across, half the way around/);
    await page.keyboard.press('Escape');
    assert.deepStrictEqual([await page.getAttribute(info, 'aria-expanded'), await page.isHidden('#ffc-m-chestWidth-info')], ['false', true]);
    assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('aria-controls')), 'ffc-m-chestWidth-info', 'focus back on its button');
    /* Space too */
    await page.keyboard.press('Space');
    assert.strictEqual(await page.isVisible('#ffc-m-chestWidth-info'), true);
    /* a tap on another opens it and closes the first; a tap elsewhere closes it */
    await page.tap('button[aria-controls="ffc-help"]').catch(() => page.click('button[aria-controls="ffc-help"]'));
    assert.deepStrictEqual([await page.isHidden('#ffc-m-chestWidth-info'), await page.isVisible('#ffc-help')], [true, true]);
    assert.match(await page.textContent('#ffc-help'), /Not a body-size chart: that says who a size is made for/);
    await page.click('#find-fit-title');
    assert.strictEqual(await page.isHidden('#ffc-help'), true);
    /* your garment's: the same */
    await page.click('button[aria-controls="ffr-m-sleeveLength-info"]');
    assert.match(await page.textContent('#ffr-m-sleeveLength-info'), /From the shoulder seam to the end of the sleeve/);
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.isHidden('#ffr-m-sleeveLength-info'), true);
    await context.close();
  });

  await test('Find Fit by hand, signed out: a garment described here and an item from its chart, compared on the server — OK, the size, each measurement side by side, and the item said to be the shopper’s own numbers', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    await enterItem(page, SAME_ITEM);
    assert.strictEqual(await page.textContent('#ff-submit-note'), 'Ready to compare.');
    const before = byHandAsked();
    let sent = null;
    page.on('request', (r) => { if (r.url().includes('candidate=1')) sent = JSON.parse(r.postData() || 'null'); });
    await compareByHand(page);
    assert.strictEqual(byHandAsked(), before + 1, 'one request to the server');
    assert.deepStrictEqual(sent.candidate, { type: 'hoodies', brand: 'AnyBrand', name: 'Heavy Hood', size: 'L', unit: 'cm', measurements: SAME_ITEM.measurements, methods: Object.assign({ registry: 1 }, FORM_HOW) });
    assert.strictEqual(sent.reference.type, 'hoodies', 'the garment described here, in the body');
    assert.ok(!page.url().includes('58'), 'nothing in the address');
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), 'Recommended size: L');
    assert.strictEqual(await page.textContent('#fit-result-product'), 'AnyBrand · Heavy Hood — size L');
    /* the two garments side by side, measurement by measurement */
    const rows = await page.$$eval('#fit-compare .ff-scale-row', (ls) => ls.map((l) => [l.dataset.dim, [...l.querySelectorAll('.ff-bar-line')].map((b) => `${b.querySelector('.ff-bar-label').textContent} ${b.querySelector('.ff-bar-value').textContent}`), l.querySelector('.ff-diff').textContent]));
    assert.deepStrictEqual(rows, [
      ['chestWidth', ['Your garment 58 cm', 'Size L 58 cm'], 'The same: 0.0 cm'],
      ['bodyLength', ['Your garment 68 cm', 'Size L 68 cm'], 'The same: 0.0 cm'],
      ['shoulderWidth', ['Your garment 50 cm', 'Size L 50 cm'], 'The same: 0.0 cm'],
      ['sleeveLength', ['Your garment 62 cm', 'Size L 62 cm'], 'The same: 0.0 cm']
    ]);
    assert.match(await page.textContent('#fit-compare .ff-sources'), /^Sources: the measurements you entered from this item’s chart, which Fynd hasn’t checked; the measurements you took of your garment at home\.$/);
    const limits = await page.textContent('#fit-compare .ff-limits');
    assert.match(limits, /Reliability: medium\./, 'held to medium: neither side was checked by Fynd');
    assert.match(limits, /The item's measurements are the ones you entered from its chart; Fynd hasn't checked them against the brand\./);
    assert.match(await page.textContent('#fit-compare .ff-garment-caption'), /Matching measurements don’t guarantee the same fit/);
    assert.strictEqual(await page.$$eval('#fit-compare a[href="compare.html"]', (as) => as.length), 0, 'one size entered: no other to see');
    /* the offer to save the garment described here, after the result */
    await page.waitForSelector('#ff-save:not([hidden])');
    /* changing the item retires the result */
    await page.fill('#ffc-m-chestWidth', '59');
    assert.strictEqual(await page.isHidden('#fit-result'), true, 'no result left for numbers no longer there');
    await context.close();
  });

  await test('Find Fit by hand: the item is checked on the page before anything is sent — each problem beside its own field, nothing compared', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    const before = byHandAsked();
    /* nothing entered */
    await page.click('#ff-submit', { force: true });
    await page.waitForSelector('#ffc-size-error.show');
    assert.strictEqual(await page.textContent('#ffc-size-error'), 'Enter the size you’re considering, as the chart labels it (like M or 42).');
    assert.match(await page.textContent('#ffc-measurements-error'), /^Enter at least one measurement from the product’s chart/);
    /* a negative value, words, and a value with no method */
    await page.fill('#ffc-size', 'L');
    await page.fill('#ffc-m-chestWidth', '-3');
    await page.fill('#ffc-m-bodyLength', 'long');
    await page.fill('#ffc-m-shoulderWidth', '50');
    await page.click('#ff-submit', { force: true });
    await page.waitForSelector('#ffc-m-chestWidth-error.show');
    assert.strictEqual(await page.textContent('#ffc-m-chestWidth-error'), 'Enter the chest width as a number above zero, like 56 or 22.5.');
    assert.strictEqual(await page.textContent('#ffc-m-bodyLength-error'), 'Enter the body length as a number above zero, like 56 or 22.5.');
    assert.strictEqual(await page.textContent('#ffc-how-shoulderWidth-error'), 'Choose how the chart measures the shoulder width — or “The chart doesn’t say”.');
    assert.strictEqual(await page.getAttribute('#ffc-m-chestWidth', 'aria-invalid'), 'true');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ffc-m-chestWidth', 'focus on the first problem');
    /* a flat chest past what a hoodie measures: the likely mix-up said */
    await page.fill('#ffc-m-chestWidth', '118');
    await page.selectOption('#ffc-how-chestWidth', 'flat-width-armpit-to-armpit');
    await page.fill('#ffc-m-bodyLength', '');
    await page.selectOption('#ffc-how-shoulderWidth', 'seam-to-seam');
    await page.click('#ff-submit', { force: true });
    await page.waitForSelector('#ffc-m-chestWidth-error.show');
    assert.match(await page.textContent('#ffc-m-chestWidth-error'), /should be between 40 and 102 cm for a hoodie\. If the chart gives the chest all the way around, choose that method\./);
    assert.strictEqual(byHandAsked(), before, 'nothing sent while the item doesn’t read');
    assert.strictEqual(await page.isHidden('#fit-result'), true);
    await context.close();
  });

  await test('Find Fit by hand, units: switching converts each number once from what was typed — back and forth never drifts — and what is sent is what is shown, in the unit chosen', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    await enterItem(page, Object.assign({}, SAME_ITEM, { measurements: { chestWidth: 56, bodyLength: 68.5, shoulderWidth: 50 } }));
    const shown = () => page.$$eval('#ffc-form input[inputmode="decimal"]', (is) => is.map((i) => i.value));
    await page.check('input[name="ff-unit"][value="in"]');
    assert.deepStrictEqual(await shown(), ['22.05', '19.69', '26.97', '']);
    assert.deepStrictEqual(await page.$$eval('#ffc-form .measure-unit', (ns) => ns.map((n) => n.textContent)), ['in', 'in', 'in', 'in'], 'the unit in every box');
    for (let i = 0; i < 5; i += 1) {
      await page.check('input[name="ff-unit"][value="cm"]');
      await page.check('input[name="ff-unit"][value="in"]');
    }
    await page.check('input[name="ff-unit"][value="cm"]');
    assert.deepStrictEqual(await shown(), ['56', '50', '68.5', ''], 'back to exactly what was typed');
    /* typed in inches, with a quarter: kept exactly */
    await page.check('input[name="ff-unit"][value="in"]');
    await page.fill('#ffc-m-sleeveLength', '24.25');
    await page.selectOption('#ffc-how-sleeveLength', 'shoulder-seam-to-cuff');
    await page.check('input[name="ff-unit"][value="cm"]');
    assert.strictEqual(await page.inputValue('#ffc-m-sleeveLength'), '61.6');
    await page.check('input[name="ff-unit"][value="in"]');
    assert.strictEqual(await page.inputValue('#ffc-m-sleeveLength'), '24.25');
    let sent = null;
    page.on('request', (r) => { if (r.url().includes('candidate=1')) sent = JSON.parse(r.postData() || 'null'); });
    await compareByHand(page);
    assert.deepStrictEqual([sent.candidate.unit, sent.candidate.measurements], ['in', { chestWidth: 22.05, shoulderWidth: 19.69, bodyLength: 26.97, sleeveLength: 24.25 }]);
    /* the same garment in inches against a reference in centimetres: the server converts, and the size is the same */
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), 'Recommended size: L');
    await context.close();
  });

  await test('Find Fit, one unit for both garments: your garment’s boxes convert with the item’s, from what was typed and without drift; a kept garment opened again in the other unit is shown converted, and keeps its meaning', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    /* typed in centimetres on both sides */
    await page.fill('#ffr-m-chestWidth', '58');
    await page.fill('#ffr-m-bodyLength', '68');
    await page.fill('#ffc-m-chestWidth', '56');
    await page.check('input[name="ff-unit"][value="in"]');
    assert.deepStrictEqual([await page.inputValue('#ffr-m-chestWidth'), await page.inputValue('#ffr-m-bodyLength'), await page.inputValue('#ffc-m-chestWidth')], ['22.83', '26.77', '22.05']);
    assert.strictEqual(await page.inputValue('#ffr-unit'), 'in', 'the garment is read in the unit shown');
    assert.deepStrictEqual(await page.$$eval('#ff-reference .measure-unit', (ns) => ns.map((n) => n.textContent)), ['in', 'in', 'in', 'in']);
    for (let i = 0; i < 6; i += 1) await page.check(`input[name="ff-unit"][value="${i % 2 ? 'in' : 'cm'}"]`);
    await page.check('input[name="ff-unit"][value="cm"]');
    assert.deepStrictEqual([await page.inputValue('#ffr-m-chestWidth'), await page.inputValue('#ffr-m-bodyLength'), await page.inputValue('#ffc-m-chestWidth')], ['58', '68', '56'], 'exactly what was typed');
    /* kept in centimetres, then opened again with inches chosen: shown converted, the stored value unchanged until saved again */
    await page.selectOption('#ffr-size', 'L');
    await page.fill('#ffr-brand', 'Carhartt');
    await page.click('#ffr-use');
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
    const kept = await page.evaluate(() => JSON.parse(sessionStorage.getItem('fynd:find-fit:reference')).garment.anchor.measurements);
    assert.deepStrictEqual([kept.unit, kept.chestWidth, kept.bodyLength], ['cm', 58, 68]);
    await page.check('input[name="ff-unit"][value="in"]');
    await page.click('#ff-reference .ff-ref-edit, #ff-reference [data-edit], #ff-reference .ff-ref-change');
    await page.waitForSelector('#ffr-m-chestWidth');
    assert.deepStrictEqual([await page.inputValue('#ffr-unit'), await page.inputValue('#ffr-m-chestWidth')], ['in', '22.83'], 'shown in the unit chosen');
    await page.check('input[name="ff-unit"][value="cm"]');
    assert.strictEqual(await page.inputValue('#ffr-m-chestWidth'), '58', 'its own value, back exactly');
    await context.close();
  });

  await test('Compare fit while it runs: busy, said so, and sent once however often it is pressed — then ready again, with the result beneath the forms and as wide as them', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    await enterItem(page, SAME_ITEM);
    assert.strictEqual(await page.getAttribute('#ff-submit', 'aria-disabled'), 'false', 'ready: it looks available');
    let sent = 0;
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/api/size-recommendation?compare=1&candidate=1', async (route) => { sent += 1; await held; await route.continue(); });
    await page.click('#ff-submit');
    await page.waitForSelector('#ff-submit[aria-busy="true"]');
    assert.deepStrictEqual(await page.evaluate(() => { const b = document.getElementById('ff-submit'); return [b.textContent, b.disabled, document.getElementById('ff-submit-note').textContent, document.getElementById('fit-compare').dataset.verdict]; }), ['Comparing…', true, 'Comparing…', 'loading']);
    /* pressed again, and by keyboard: nothing more is sent */
    await page.click('#ff-submit', { force: true });
    await page.evaluate(() => document.getElementById('ff-form').requestSubmit());
    await page.waitForTimeout(200);
    assert.strictEqual(sent, 1, 'one request');
    release();
    await page.waitForSelector('#fit-compare[data-verdict="recommended"]');
    assert.deepStrictEqual(await page.evaluate(() => { const b = document.getElementById('ff-submit'); return [b.textContent, b.disabled, b.hasAttribute('aria-busy'), document.getElementById('ff-submit-note').textContent]; }), ['Compare fit', false, false, 'Your comparison is below.']);
    assert.strictEqual(sent, 1);
    /* the result beneath both forms, aligned with them */
    const geo = await page.evaluate(() => { const r = (sel) => document.querySelector(sel).getBoundingClientRect(); return { cols: r('.ff-columns'), card: r('#fit-result-card'), button: r('#ff-submit') }; });
    assert.ok(geo.card.top > geo.button.bottom, 'below the forms and the button');
    assert.ok(Math.abs(geo.card.left - geo.cols.left) <= 2 && Math.abs(geo.card.right - geo.cols.right) <= 2, `as wide as the forms (${geo.card.left}–${geo.card.right} vs ${geo.cols.left}–${geo.cols.right})`);
    await context.close();
  });

  await test('Compare fit with your garment typed in but not yet kept: it is kept by the form’s own checks first, then compared — and a garment that doesn’t read is said beside its fields, with nothing sent', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    await enterItem(page, SAME_ITEM);
    /* typed, not kept: a garment whose chest isn't a number doesn't read (its own measurements need no size) */
    await page.fill('#ffr-brand', 'Carhartt');
    for (const [k, v] of Object.entries({ chestWidth: 'wide', bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 })) await page.fill(`#ffr-m-${k}`, String(v));
    assert.strictEqual(await page.getAttribute('#ff-submit', 'aria-disabled'), 'false', 'a garment being entered can be compared');
    const asked = byHandAsked();
    await page.click('#ff-submit');
    await page.waitForSelector('#ffr-m-chestWidth-error.show');
    assert.strictEqual(byHandAsked(), asked, 'nothing sent');
    assert.strictEqual(await page.isHidden('#fit-result'), true);
    /* corrected, with its size: kept, then compared, with nothing else pressed */
    await page.fill('#ffr-m-chestWidth', '58');
    await page.selectOption('#ffr-size', 'L');
    await compareByHand(page);
    assert.strictEqual(byHandAsked(), asked + 1);
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), 'Recommended size: L');
    await context.close();
  });

  await test('Find Fit by hand, partial and too few: three measurements with chest are compared; two are too few — no size, and each measurement says why it was or wasn’t compared', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    await enterItem(page, Object.assign({}, SAME_ITEM, { measurements: { chestWidth: 58, bodyLength: 68, shoulderWidth: 50 } }));
    await compareByHand(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
    assert.deepStrictEqual(await page.$$eval('#fit-compare .ff-scale-row', (ls) => ls.map((l) => l.dataset.dim)), ['chestWidth', 'bodyLength', 'shoulderWidth']);
    assert.deepStrictEqual(await page.$$eval('#fit-compare .ff-scale-skip', (ls) => ls.map((l) => [l.dataset.dim, l.dataset.status, l.querySelector('.ff-skip-why').textContent])), [['sleeveLength', 'missing-target', 'Sleeves: not entered for this item, so it isn’t compared.']]);
    /* one fewer: too few */
    await page.fill('#ffc-m-shoulderWidth', '');
    await compareByHand(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'too-few');
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-title'), 'Too few measurements in common to compare');
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest, #fit-compare .ff-scale', (ns) => ns.length), 0, 'no size, no closest, no figure');
    assert.match(await page.textContent('#fit-compare'), /Fynd needs at least three measurements taken the same way on both garments, including the chest, to compare them\. Enter more from the product’s chart\./);
    assert.deepStrictEqual(await page.$$eval('#fit-compare .ff-dim', (ls) => ls.map((l) => [l.dataset.dim, l.dataset.status])), [['chestWidth', 'compatible'], ['bodyLength', 'compatible'], ['shoulderWidth', 'missing-target'], ['sleeveLength', 'missing-target']]);
    assert.doesNotMatch(await page.textContent('#fit-compare'), /Reliability|Recommended/);
    await context.close();
  });

  await test('Find Fit by hand, methods: a chart measuring the sleeve and length from the centre back, or not saying how it measures the chest, is never set beside yours — said to be unreliable, no size', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    await enterItem(page, Object.assign({}, SAME_ITEM, { measurements: { chestWidth: 58, bodyLength: 75, shoulderWidth: 50, sleeveLength: 86 }, how: { bodyLength: 'center-back-to-hem', sleeveLength: 'center-back-to-cuff' } }));
    await compareByHand(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'too-few');
    assert.deepStrictEqual(await page.$$eval('#fit-compare .ff-dim', (ls) => ls.map((l) => [l.dataset.dim, l.dataset.status])), [['chestWidth', 'compatible'], ['bodyLength', 'incompatible-method'], ['shoulderWidth', 'compatible'], ['sleeveLength', 'incompatible-method']]);
    assert.match(await page.textContent('#fit-compare .ff-dim[data-dim="sleeveLength"]'), /from the shoulder seam to the cuff on your garment and from the centre of the back of the neck to the cuff on this one — not the same measurement, so not compared\./);
    assert.match(await page.textContent('#fit-compare'), /can’t be compared reliably/);
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest', (ns) => ns.length), 0);
    /* the chart doesn't say how the chest is measured: never compared */
    await enterItem(page, { measurements: { chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 }, how: { chestWidth: 'not-stated', bodyLength: FORM_HOW.bodyLength, sleeveLength: FORM_HOW.sleeveLength } });
    await compareByHand(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'too-few');
    assert.match(await page.textContent('#fit-compare .ff-dim[data-dim="chestWidth"]'), /isn’t said how it was measured, so it can’t be compared reliably/);
    await context.close();
  });

  await test('Find Fit by hand, NO_MATCH: the one size entered, 8 cm wider through the chest, is said not to meet the comparison criteria — never recommended, never called "the closest"', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    await enterItem(page, Object.assign({}, SAME_ITEM, { measurements: { chestWidth: 66, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 } }));
    await compareByHand(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'no-match');
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-title'), 'Size L doesn’t match your garment');
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-mismatch'), 'Size L doesn’t meet the comparison criteria — not recommended');
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest', (ns) => ns.length), 0);
    assert.match(await page.textContent('#fit-compare'), /Size L would be much roomier through the chest than your garment — more than Fynd’s comparison allows — so it isn’t recommended\./);
    assert.doesNotMatch(await page.textContent('#fit-compare'), /closest/i, 'one size entered: no "closest"');
    assert.strictEqual(await page.textContent('#fit-compare .ff-scale-row[data-dim="chestWidth"] .ff-diff'), 'Wider: +8.0 cm');
    assert.doesNotMatch(await page.textContent('#fit-compare'), /Reliability/);
    await context.close();
  });

  await test('Find Fit by hand: the server’s decision is the only authority — an answer saying "ok, L" beside an INSUFFICIENT_DATA decision, or with no decision, shows no size; with no garment of yours, the way to add one', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    /* no garment yet: Compare fit looks unavailable and says why; pressed anyway, the page says so beside your garment and sends nothing */
    await enterItem(page, SAME_ITEM);
    assert.strictEqual(await page.getAttribute('#ff-submit', 'aria-disabled'), 'true');
    assert.strictEqual(await page.textContent('#ff-submit-note'), 'Next: add a garment you own that fits well.');
    const asked = byHandAsked();
    await page.click('#ff-submit', { force: true });
    await page.waitForSelector('#ff-garment-error.show');
    assert.match(await page.textContent('#ff-garment-error'), /^Choose a garment you own first/);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ffr-brand', 'focus on your garment’s form');
    assert.strictEqual(byHandAsked(), asked, 'nothing sent');
    assert.strictEqual(await page.isHidden('#fit-result'), true);
    /* an answer whose comparison names a size its decision doesn't give */
    await describe(page, MY_HOODIE);
    const real = (await (await fetch(`${ORIGIN}/api/size-recommendation?compare=1&candidate=1`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ candidate: Object.assign({}, SAME_ITEM, { methods: Object.assign({ registry: 1 }, FORM_HOW) }), reference: { type: 'hoodies', garment: { favorite: 'perfect', anchor: { brand: 'Carhartt', size: 'L', measurements: { unit: 'cm', chestWidth: '58', bodyLength: '68', shoulderWidth: '50', sleeveLength: '62' } } } } }) })).json());
    assert.deepStrictEqual([real.decision.outcome, real.comparison.recommended], ['OK', 'L']);
    const overruled = Object.assign({}, real, { decision: Object.assign({}, real.decision, { outcome: 'INSUFFICIENT_DATA', size: null, confidence: null, reasons: [{ code: 'missing-required-measurement', dim: 'chestWidth', side: 'target', required: true }], messages: ['Every comparison needs the chest width.'] }) });
    for (const body of [overruled, Object.assign({}, real, { decision: null }), Object.assign({}, real, { decision: Object.assign({}, real.decision, { outcome: 'OK', size: 'XXXL' }) })]) {
      await page.unroute('**/api/size-recommendation?compare=1&candidate=1').catch(() => {});
      await page.route('**/api/size-recommendation?compare=1&candidate=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
      await page.fill('#ffc-size', 'L ');
      await compareByHand(page);
      assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended', (ns) => ns.length), 0, 'no size the decision didn’t give');
      assert.doesNotMatch(await page.textContent('#fit-compare'), /Recommended size|Reliability/);
    }
    await context.close();
  });

  await test('Find Fit by hand, signed in with a saved hoodie: the saved garment is used, never sent — the same engine, the same answer', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await signedIn(context, 'mae@e2e.test');
    const user = await users.byEmail('mae@e2e.test');
    await fitProfiles.saveGuide(user.id, { garments: { hoodies: { favorite: 'perfect', anchor: { brand: 'Carhartt', size: 'L', measurements: { unit: 'cm', chestWidth: '58', bodyLength: '68', shoulderWidth: '50', sleeveLength: '62' } } } } });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="saved"]');
    assert.match(await page.textContent('#ff-reference'), /Carhartt/);
    await enterItem(page, SAME_ITEM);
    assert.deepStrictEqual(await page.$$eval('#ff-progress .ff-progress-text', (ns) => ns.map((n) => n.textContent)), ['Your garment: from your fit profile', 'Item: ready']);
    let sent = null;
    page.on('request', (r) => { if (r.url().includes('candidate=1')) sent = JSON.parse(r.postData() || 'null'); });
    await compareByHand(page);
    assert.ok(sent && !('reference' in sent), 'the saved garment stays on the server');
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), 'Recommended size: L');
    assert.match(await page.textContent('#fit-compare .fit-compare-reference'), /Carhartt L/);
    await context.close();
  }));

  await test('Find Fit by hand on a 360px phone: one column, garment then item, no sideways scroll, and the result readable', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, 'index.html');
    await describe(page, MY_HOODIE);
    await enterItem(page, SAME_ITEM);
    await compareByHand(page);
    const geometry = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth - window.innerWidth,
      ref: document.getElementById('ff-step-reference').getBoundingClientRect().top,
      item: document.getElementById('ff-step-target').getBoundingClientRect().top,
      width: document.getElementById('ff-step-target').getBoundingClientRect().width
    }));
    assert.ok(geometry.scroll <= 0, `no sideways scroll (${geometry.scroll}px)`);
    assert.ok(geometry.ref < geometry.item, 'your garment first');
    assert.ok(geometry.width <= 360);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
    await context.close();
  });

  /* The item, entered by hand: one size of a real product, its published
     finished-garment measurements and the methods its chart states, read
     from Fynd's own record — never invented — as a shopper would copy
     them from UNIQLO's Size Guide */
  const byHandFrom = (id, size) => {
    const record = require('../api/_sizing/records').byId(id);
    const g = record.charts.garment;
    const measurements = Object.fromEntries(Object.keys(g.dimensions).map((d) => [d, g.sizes[size][d].value]));
    const how = Object.fromEntries(Object.keys(g.dimensions).map((d) => [d, g.dimensions[d].method]));
    return { type: record.category, brand: record.brand, name: record.product.name, size, unit: record.units, measurements, how };
  };
  const UQ_HOODIE_URL = 'https://www.uniqlo.com/us/en/products/E475378-000/00';
  const UQ_HOODIE_L = byHandFrom('uniqlo-e475378-sweat-pullover-hoodie-us', 'L');
  const UQ_HOODIE_M = byHandFrom('uniqlo-e475378-sweat-pullover-hoodie-us', 'M');
  /* an item as the page sends it, and as the engine reads it */
  const asCandidate = (it) => ({ type: it.type, brand: it.brand, name: it.name, size: it.size, unit: it.unit, measurements: it.measurements, methods: Object.assign({ registry: 1 }, it.how) });
  const candidateRecordOf = (it) => require('../api/_sizing/engine').candidateRecord(require('../assets/fit-candidate.js').readCandidate(asCandidate(it)).candidate);
  /* compared: the item entered (UNIQLO's hoodie in L by default), then Compare fit */
  const compareItem = async (page, item) => {
    await enterItem(page, typeof item === 'object' && item ? item : UQ_HOODIE_L);
    await compareByHand(page);
  };
  const CARHARTT = { type: 'hoodies', size: 'L', brand: 'Carhartt', measurements: { unit: 'cm', chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 } };
  /* the garment's form is never locked: it's there from the start */
  const unlockWith = async (page) => {
    await page.waitForSelector('#ff-reference[data-locked="false"]');
  };


  await test('a guest checks an item first (UNIQLO pair checked in memory), describes a garment without signing in, and gets the honest answer — then, only then, the offer to save; "Not now" leaves the result, and the garment stays for the visit', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="signed-out"][data-locked="false"] .ffr-form');
    await unlockWith(page);
    /* the form says what's wrong, in the profile's own words, and keeps nothing until it reads */
    await page.click('#ffr-use');
    assert.strictEqual(await page.textContent('#ffr-brand-error'), 'Enter the brand on its label, find the product above, or enter its measurements.');
    assert.strictEqual(await page.getAttribute('#ffr-brand', 'aria-invalid'), 'true');
    await page.selectOption('#ffr-size', 'L');
    await page.fill('#ffr-brand', 'Carhartt');
    await page.fill('#ffr-m-chestWidth', '120');
    await page.click('#ffr-use');
    await page.waitForSelector('#ffr-m-chestWidth-error.show');
    assert.match(await page.textContent('#ffr-m-chestWidth-error'), /Chest, flat should be between .* Measure it laid flat, armpit to armpit/);
    assert.strictEqual(await page.$('#ff-reference .ff-ref--visit'), null, 'nothing kept while a value is wrong');
    await page.fill('#ffr-m-chestWidth', '');
    /* reloaded, nothing kept: the form again, empty */
    await page.reload();
    await page.waitForSelector('#ff-reference[data-visit="empty"] .ffr-form');
    await unlockWith(page);
    await describe(page, CARHARTT);
    assert.match(await page.textContent('.ff-ref--visit'), /Hoodie · this visit[\s\S]*Carhartt · size L[\s\S]*Measured: Chest, flat 58 cm[\s\S]*Kept for this visit\. Not saved to an account\./);
    assert.strictEqual(await page.isHidden('#ff-save'), true, 'still no offer: nothing compared yet');
    /* measured from the shoulder, UNIQLO from the centre back: too few in common, so no size — and said */
    await compareItem(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'too-few');
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-title'), 'Too few measurements in common to compare');
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest', (ns) => ns.length), 0, 'no size invented for a guest');
    /* after the result: the offer, beneath it */
    await page.waitForSelector('#ff-save[data-state="offer"]');
    assert.strictEqual(await page.textContent('#ff-save .ff-save-title'), 'Save this garment for next time?');
    assert.match(await page.textContent('#ff-save'), /Sign in to save it to your free fit profile, so you can compare future items against it\.[\s\S]*Only your account can read your fit profile\./);
    assert.deepStrictEqual(await page.$$eval('#ff-save button', (bs) => bs.map((b) => b.textContent)), ['Sign in to save', 'Not now']);
    assert.ok(await page.$eval('#fit-compare', (v) => Boolean(v.compareDocumentPosition(document.getElementById('ff-save')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'after the result, never in its place');
    const before = await page.textContent('#fit-compare');
    await page.click('#ff-save .ff-save-dismiss');
    assert.strictEqual(await page.isHidden('#ff-save'), true);
    assert.strictEqual(await page.textContent('#fit-compare'), before, 'the result is still there, unchanged');
    assert.strictEqual(await page.isVisible('#fit-compare'), true);
    /* nothing about the garment in any address, and nothing stored for a guest */
    assert.ok(!/Carhartt|chestWidth|58/.test(page.url()));
    assert.ok(!apiRequests.some((r) => /Carhartt|chestWidth/.test(r.search || '')));
    /* the garment stays for the visit; turned down once, the offer isn't repeated for it */
    await page.reload();
    await page.waitForSelector('#ff-reference .ff-ref--visit');
    await compareItem(page);
    assert.strictEqual(await page.isHidden('#ff-save'), true, 'not offered again for the same garment');
    /* removed: back to an empty form — the item compared again was checked again, so the garment is still asked for */
    await page.click('.ff-ref-remove');
    await page.waitForSelector('#ff-reference[data-visit="empty"][data-locked="false"] .ffr-form');
    await context.close();
  }));

  await test('a guest\'s garment is compared through the real engine (UNIQLO pair checked in memory): sent in the body, never the address — then signing in keeps it and the result, and saving waits for an explicit yes', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await context.newPage();
    const posted = [];
    const counters = [];
    page.on('request', (r) => {
      if (r.method() !== 'POST' || !/size-recommendation/.test(r.url())) return;
      /* the anonymous counters go apart: they must carry nothing of the shopper's */
      (/[?&]metrics=1$/.test(r.url()) ? counters : posted).push({ url: r.url(), body: r.postDataJSON() });
    });
    await open(page, 'index.html');
    await unlockWith(page);
    await describe(page, { type: 'sweatshirts', size: 'M', brand: 'UNIQLO', product: 'https://www.uniqlo.com/us/en/products/E475377-000/00?colorDisplayCode=09' });
    /* the item, entered by hand from UNIQLO's chart: compared when Compare fit is pressed */
    await compareItem(page, UQ_HOODIE_M);
    const expected = require('../api/_sizing/engine').compare(
      Object.assign(Schema.empty(), { garments: { sweatshirts: Object.assign(Schema.emptyGarment('sweatshirts'), { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { name: null, url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } }) } }),
      candidateRecordOf(UQ_HOODIE_M));
    assert.strictEqual(expected.status, 'ok');
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), `Recommended size: ${expected.recommended}`, 'the engine\'s own answer');
    /* the one comparison that carried the garment: a POST, the garment and the item in its body, nothing in the address */
    assert.strictEqual(posted.length, 1);
    /* and the counters: event names and two numbers, nothing else — no garment, product, size or link */
    counters.forEach((c) => {
      assert.deepStrictEqual(Object.keys(c.body), ['events']);
      c.body.events.forEach((e) => assert.ok(Object.keys(e).every((k) => ['name', 'surface', 'value'].includes(k)) && (e.value === undefined || typeof e.value === 'number'), JSON.stringify(e)));
      assert.doesNotMatch(JSON.stringify(c.body), /UNIQLO|uniqlo|sweatshirt|"M"/);
    });
    assert.match(posted[0].url, /\/api\/size-recommendation\?compare=1&candidate=1$/);
    assert.deepStrictEqual(posted[0].body.reference.type, 'sweatshirts');
    assert.strictEqual(posted[0].body.reference.garment.anchor.product.url, 'https://www.uniqlo.com/us/en/products/E475377-000/00', 'the link kept without its tracking');
    assert.deepStrictEqual(posted[0].body.candidate, asCandidate(UQ_HOODIE_M));
    const result = await page.textContent('#fit-compare');
    /* sign in to save: an account made right here, the page and the result kept */
    await page.waitForSelector('#ff-save[data-state="offer"]');
    await page.click('#ff-save .ff-save-signin');
    await page.waitForSelector('#ff-save[data-state="auth"]');
    await page.click('#ff-save .ff-save-mode');
    await page.fill('#ffs-name', 'Vera');
    await page.fill('#ffs-email', 'vera@e2e.test');
    await page.fill('#ffs-password', PASSWORD);
    await page.fill('#ffs-confirm', PASSWORD);
    await page.click('#ff-save .ff-save-submit');
    await page.waitForSelector('#ff-save[data-state="confirm"]');
    assert.ok(/index\.html$/.test(page.url()), 'still on Find Fit');
    assert.strictEqual(await page.textContent('#fit-compare'), result, 'the result untouched');
    assert.match(await page.textContent('#ff-save'), /Save your UNIQLO sweatshirt in size M to your free fit profile, so you can compare future items against it\./);
    /* signed in, and still nothing saved: saving is its own yes */
    assert.strictEqual(await savedProfile('vera@e2e.test'), null, 'signing in saved nothing');
    assert.match(await page.textContent('.ff-ref--visit'), /UNIQLO · size M/, 'the garment kept across signing in');
    await page.click('#ff-save .ff-save-confirm');
    await page.waitForSelector('#ff-save[data-state="saved"]');
    const stored = (await savedProfile('vera@e2e.test')).garments.sweatshirts;
    assert.deepStrictEqual([stored.favorite, stored.anchor.brand, stored.anchor.size, stored.anchor.product.url], ['perfect', 'UNIQLO', 'M', 'https://www.uniqlo.com/us/en/products/E475377-000/00']);
    /* now the saved one is the reference, and the visit's is cleared */
    await page.waitForSelector('#ff-reference[data-state="saved"] .ff-ref[data-kind="sweatshirts"]');
    assert.strictEqual(await page.evaluate(() => sessionStorage.getItem('fynd:find-fit:reference')), null);
    await context.close();
  }));

  await test('a guest\'s garment with only a brand and a size: Fynd says it compares measurements, not labels — no size — and offers to save it all the same', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await unlockWith(page);
    await describe(page, { type: 'hoodies', size: 'L', brand: 'Champion' });
    await compareItem(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'needs-measurements');
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-title'), 'Fynd needs this garment’s measurements');
    assert.match(await page.textContent('#fit-compare'), /Fynd compares measurements, not size labels/);
    assert.deepStrictEqual(await page.$$eval('#fit-compare a', (as) => as.map((a) => a.getAttribute('href'))), ['#ff-step-reference']);
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest', (ns) => ns.length), 0);
    await page.waitForSelector('#ff-save[data-state="offer"]');
    await context.close();
  }));

  await test('signing in to an account that already holds a garment of that kind: the offer says it would replace it, and "Not now" saves nothing', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const setup = await signedIn(context, 'wren@e2e.test');
    await fitProfiles.saveGuide((await users.byEmail('wren@e2e.test')).id, { garments: { hoodies: { favorite: 'perfect', anchor: { brand: 'Nike', size: 'M' } } } });
    await setup.evaluate(() => window.Account.logout());
    const page = await context.newPage();
    await open(page, 'index.html');
    await unlockWith(page);
    await describe(page, CARHARTT);
    await compareItem(page);
    await page.waitForSelector('#ff-save[data-state="offer"]');
    await page.click('#ff-save .ff-save-signin');
    await page.fill('#ffs-email', 'wren@e2e.test');
    await page.fill('#ffs-password', 'wrong-password-here');
    await page.click('#ff-save .ff-save-submit');
    await page.waitForSelector('#ff-save .form-error.show');
    assert.strictEqual(await page.getAttribute('#ff-save', 'data-state'), 'auth', 'a wrong password keeps the form');
    await page.fill('#ffs-password', PASSWORD);
    await page.click('#ff-save .ff-save-submit');
    await page.waitForSelector('#ff-save[data-state="confirm"]');
    assert.match(await page.textContent('#ff-save .ff-save-replace'), /This replaces the hoodie saved on your fit profile \(Nike, M\)\./);
    await page.click('#ff-save .ff-save-dismiss');
    assert.strictEqual(await page.isHidden('#ff-save'), true);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'too-few', 'the result stays');
    const stored = (await savedProfile('wren@e2e.test')).garments.hoodies;
    assert.deepStrictEqual([stored.anchor.brand, stored.anchor.size], ['Nike', 'M'], 'nothing replaced without a yes');
    await context.close();
  }));

  await test('signed in with a saved reference: Find Fit uses it as before — no form, no offer to save', async () => {
    const context = await openContext();
    const page = await signedIn(context, 'xia@e2e.test');
    await fitProfiles.saveGuide((await users.byEmail('xia@e2e.test')).id, { garments: { hoodies: { favorite: 'perfect', anchor: { brand: 'Carhartt', size: 'L', measurements: { unit: 'cm', chestWidth: 58, bodyLength: 68, shoulderWidth: 50, sleeveLength: 62 } } } } });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="saved"] .ff-ref[data-kind="hoodies"]');
    assert.strictEqual(await page.$('#ff-reference .ffr-form'), null);
    assert.strictEqual(await page.getAttribute('.ff-ref[data-kind="hoodies"] .ff-ref-change', 'href'), 'fit-profile.html?for=hoodies&from=find-fit');
    /* measured at home from the shoulder, UNIQLO's chart from the centre back: too few in common — the saved garment used, nothing to save */
    await compareItem(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'too-few');
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest', (ns) => ns.length), 0);
    assert.strictEqual(await page.isHidden('#ff-save'), true, 'nothing to save');
    await context.close();
  });

  await test('signed in with nothing saved: the same form, from the start; after a comparison the offer asks only for the yes, and saving keeps every other garment', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await signedIn(context, 'yael@e2e.test');
    await fitProfiles.saveGuide((await users.byEmail('yael@e2e.test')).id, { garments: { jeans: { anchor: { brand: 'Levi’s', size: '32', length: '32' } } } });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="none"][data-locked="false"] .ffr-form');
    await unlockWith(page);
    await describe(page, CARHARTT);
    await compareItem(page);
    await page.waitForSelector('#ff-save[data-state="confirm"]');
    assert.deepStrictEqual(await page.$$eval('#ff-save button', (bs) => bs.map((b) => b.textContent)), ['Save to my fit profile', 'Not now']);
    await page.click('#ff-save .ff-save-confirm');
    await page.waitForSelector('#ff-save[data-state="saved"]');
    const stored = await savedProfile('yael@e2e.test');
    assert.deepStrictEqual(stored.garments.hoodies.anchor.measurements, { unit: 'cm', chestWidth: 58, shoulderWidth: 50, sleeveLength: 62, bodyLength: 68 });
    assert.strictEqual(stored.garments.jeans.anchor.brand, 'Levi’s', 'the rest of the profile kept');
    await page.waitForSelector('#ff-reference[data-state="saved"] .ff-ref[data-kind="hoodies"]');
    await context.close();
  }));










  /* Find your garment: the garment form's own search, from Fynd's catalogue */
  const refSettled = (page) => page.waitForSelector('#ffr-suggest-box:is([data-state="ready"], [data-state="empty"], [data-state="error"])');
  const refOptions = (page) => page.$$eval('#ffr-suggest .ff-suggest-option .ff-suggest-name', (ns) => ns.map((n) => n.textContent));
  const held = async (page) => {
    await page.waitForSelector('#ffr-held:not([hidden]):not([data-status="checking"])');
    return page.getAttribute('#ffr-held', 'data-status');
  };

  await test('Find your garment: "Uniqlo hoodie M" searches Fynd’s catalogue for UNIQLO hoodies with the size read apart, a match picked by keyboard fills the form, and what Fynd holds for it is the server’s check — not checked, for production’s records — with nothing compared and nothing claimed', async () => {
    const context = await openContext();
    const page = await context.newPage();
    const searches = [];
    const checks = [];
    const compares = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.pathname === '/api/size-recommendation' && u.searchParams.has('brand') && u.searchParams.has('q')) searches.push(`${u.searchParams.get('brand')}:${u.searchParams.get('q')}`);
      if (/[?&]check=1$/.test(r.url())) checks.push(r.postDataJSON());
      if (/[?&]compare=1/.test(r.url())) compares.push(r.url());
    });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="signed-out"] .ffr-form #ffr-search');
    assert.strictEqual(await page.getAttribute('#ffr-search', 'role'), 'combobox');
    assert.strictEqual(await page.isHidden('#ffr-held'), true, 'nothing said before anything is picked');
    await page.click('#ffr-search');
    await page.keyboard.type('Uniqlo hoodie M', { delay: 30 });
    await refSettled(page);
    assert.deepStrictEqual(searches, ['uniqlo:hoodie'], 'one search, the brand named and the size read apart — neither searched as a word');
    const offered = await refOptions(page);
    assert.ok(offered.length > 0 && offered.every((n) => /hoodie|sweat/i.test(n)), offered.join(' | '));
    assert.ok((await page.$$eval('#ffr-suggest .ff-suggest-meta', (ns) => ns.map((n) => n.textContent))).every((t) => t.startsWith('UNIQLO · ')), 'each says its brand, as the server listed it');
    /* and what the catalogue says it holds, as the server said it — never more */
    const listed = await page.evaluate(async () => Object.fromEntries((await (await fetch('/api/size-recommendation?brand=uniqlo&q=hoodie&limit=6')).json()).products.map((p) => [p.code, p.holdsText])));
    assert.deepStrictEqual(await page.$$eval('#ffr-suggest .ff-suggest-option', (ns) => ns.map((n) => [n.dataset.code, n.querySelector('.ff-suggest-holds').textContent])),
      Object.entries(listed).filter(([code]) => code).slice(0, offered.length));
    assert.match(await page.textContent('#ffr-suggest-status'), /Size M read apart from the product’s name\. Fynd’s list: .*not UNIQLO’s full range\./);
    assert.deepStrictEqual(checks, [], 'nothing checked before a pick');
    /* picked by keyboard: the form filled from the server's listing */
    const pickAt = offered.indexOf('Sweat Pullover Hoodie');
    assert.ok(pickAt >= 0, offered.join(' | '));
    for (let i = 0; i <= pickAt; i += 1) await page.keyboard.press('ArrowDown');
    assert.strictEqual(await page.getAttribute('#ffr-search', 'aria-activedescendant'), `ffr-suggest-${pickAt}`);
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.isHidden('#ffr-suggest-box'), true);
    assert.strictEqual(await page.$('#ff-reference .ff-ref--visit'), null, 'Enter picks a match — it never keeps the garment by itself');
    assert.deepStrictEqual(await page.evaluate(() => ['ffr-search', 'ffr-type', 'ffr-brand', 'ffr-product', 'ffr-size', 'ffr-line'].map((id) => document.getElementById(id).value)),
      ['UNIQLO · Sweat Pullover Hoodie', 'hoodies', 'UNIQLO', 'https://www.uniqlo.com/us/en/products/E475378-000/00', 'M', 'unisex']);
    /* what Fynd holds for it: the server's check of that product, and nothing else */
    assert.strictEqual(await held(page), 'unchecked');
    assert.deepStrictEqual(checks, [{ target: { brand: 'uniqlo', code: 'E475378-000' } }], 'the product picked, by brand and code — no garment sent');
    assert.match(await page.textContent('#ffr-held'), /^Fynd has this product’s chart, but it hasn’t been checked, so it won’t stand in for your garment\. Add any measurements you can take, below\.Size M is from your search — check it’s the size on its label\.$/);
    assert.deepStrictEqual(compares, [], 'nothing compared');
    /* kept, then an item: this unchecked product's chart never stands in for the garment, so it has only its label — no size */
    await page.click('#ffr-use');
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
    assert.deepStrictEqual(compares, [], 'never compared on a pick');
    await compareItem(page);
    assert.strictEqual(compares.length, 1, 'compared only when asked');
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'needs-measurements');
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest', (ns) => ns.length), 0);
    await context.close();
  });

  await test('Find your garment: a brand alone lists its products for a click to choose between; "Levi’s 511 32x32" and "size 10" are read apart, unmatched, and said so — the details filled in by hand all the same', async () => {
    const context = await openContext();
    const page = await context.newPage();
    const checks = [];
    page.on('request', (r) => { if (/[?&]check=1$/.test(r.url())) checks.push(r.postDataJSON()); });
    await open(page, 'index.html');
    await page.waitForSelector('#ffr-search');
    /* ambiguous: the brand alone — several products, none chosen for the shopper */
    await page.fill('#ffr-search', 'uniqlo');
    await refSettled(page);
    const several = await refOptions(page);
    assert.ok(several.length > 1, several.join(' | '));
    assert.deepStrictEqual(checks, [], 'none picked for them');
    await page.click('#ffr-suggest .ff-suggest-option[data-code="E475377-000"]');
    assert.strictEqual(await page.inputValue('#ffr-search'), 'UNIQLO · Sweatshirt');
    assert.strictEqual(await page.inputValue('#ffr-type'), 'sweatshirts');
    assert.strictEqual(await page.inputValue('#ffr-size'), '', 'no size typed, none chosen');
    assert.strictEqual(await held(page), 'unchecked');
    assert.deepStrictEqual(checks, [{ target: { brand: 'uniqlo', code: 'E475377-000' } }]);
    /* jeans by waist and inseam: the size read apart, the model number kept as words, and nothing matched in Fynd's list */
    await page.fill('#ffr-search', 'Levi’s 511 32x32');
    assert.strictEqual(await page.isHidden('#ffr-held'), true, 'the last product’s answer goes once the search changes');
    await refSettled(page);
    assert.strictEqual(await page.getAttribute('#ffr-suggest-box', 'data-state'), 'empty');
    assert.deepStrictEqual(await refOptions(page), []);
    assert.match(await page.textContent('#ffr-suggest-status'), /^No products match “Levi’s 511”\. Fill in the details below instead\. Waist and inseam 32x32 read apart from the product’s name\. Fynd’s list: .*not UNIQLO’s full range\.$/);
    assert.strictEqual(await page.getAttribute('#ffr-suggest-box', 'data-size'), '32x32');
    /* a number after "size" is a size; a size the form doesn't take is said, never chosen */
    await page.fill('#ffr-search', 'supima tee size 10');
    await refSettled(page);
    assert.deepStrictEqual(await refOptions(page), ['SUPIMA® Cotton T-Shirt']);
    await page.keyboard.press('Enter');
    assert.strictEqual(await held(page), 'unchecked');
    assert.match(await page.textContent('#ffr-held'), /Size 10 isn’t one this form takes — choose the size on its label\./);
    assert.strictEqual(await page.inputValue('#ffr-size'), '', 'not chosen for them');
    /* nothing suitable: the details by hand, as ever */
    await page.fill('#ffr-search', 'zzqx nothing');
    await refSettled(page);
    assert.strictEqual(await page.getAttribute('#ffr-suggest-box', 'data-state'), 'empty');
    await page.keyboard.press('Escape');
    await page.selectOption('#ffr-type', 'hoodies');
    await page.selectOption('#ffr-size', 'L');
    await page.fill('#ffr-brand', 'Carhartt');
    await page.evaluate(() => { document.getElementById('ffr-details').open = true; });
    await page.fill('#ffr-product', '');
    await page.click('#ffr-use');
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
    assert.match(await page.textContent('.ff-ref--visit'), /Carhartt · size L/);
    await context.close();
  });

  await test('Find your garment when things fail: the catalogue unavailable and the brand list unreachable are said, with the details by hand as the way on; a product’s check that fails is said as unknown — never as checked; an older, slower search never overwrites a newer one', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await open(page, 'index.html');
    await page.waitForSelector('#ffr-search');
    /* the catalogue answering 503 */
    await page.route('**/api/size-recommendation?brand=uniqlo&q=*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'down' }) }));
    await page.fill('#ffr-search', 'hoodie');
    await page.waitForSelector('#ffr-suggest-box[data-state="error"]');
    assert.strictEqual(await page.textContent('#ffr-suggest-status'), 'Search isn’t available right now. Fill in the details below instead.');
    assert.deepStrictEqual(await refOptions(page), []);
    await page.unroute('**/api/size-recommendation?brand=uniqlo&q=*');
    /* a product's check that fails: said as not known — the fields stay, and nothing says checked */
    await page.route('**/api/size-recommendation?check=1', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.fill('#ffr-search', 'sweatshirt');
    await refSettled(page);
    await page.click('#ffr-suggest .ff-suggest-option[data-code="E475377-000"]');
    assert.strictEqual(await held(page), 'unknown');
    assert.strictEqual(await page.textContent('#ffr-held'), 'What Fynd holds for this product couldn’t be checked just now. You can still use it — Fynd checks again when it compares.');
    assert.strictEqual(await page.inputValue('#ffr-brand'), 'UNIQLO');
    await page.unroute('**/api/size-recommendation?check=1');
    /* two searches, the first answered last: only the newer is drawn */
    await page.route('**/api/size-recommendation?brand=uniqlo&q=sweat*', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
    const slow = page.waitForResponse((r) => /[?&]q=sweat(&|$)/.test(r.url()));
    await page.fill('#ffr-search', 'sweat');
    await page.waitForRequest((r) => /[?&]q=sweat(&|$)/.test(r.url()));
    await page.fill('#ffr-search', 'supima');
    await refSettled(page);
    assert.deepStrictEqual(await refOptions(page), ['SUPIMA® Cotton T-Shirt']);
    await slow;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.deepStrictEqual(await refOptions(page), ['SUPIMA® Cotton T-Shirt'], 'the older answer, arriving last, is dropped');
    await page.unroute('**/api/size-recommendation?brand=uniqlo&q=sweat*');
    await context.close();
    /* Fynd's brand list unreachable: no search to offer, said, and the form all the same */
    const context2 = await openContext();
    const fresh = await context2.newPage();
    await fresh.route('**/api/size-recommendation?brands=1', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await open(fresh, 'index.html');
    await fresh.waitForSelector('#ffr-search');
    await fresh.fill('#ffr-search', 'hoodie');
    await fresh.waitForSelector('#ffr-suggest-box[data-state="error"]');
    assert.strictEqual(await fresh.textContent('#ffr-suggest-status'), 'Search isn’t available right now. Fill in the details below instead.');
    assert.ok(await fresh.isEditable('#ffr-brand'));
    await context2.close();
  });

  await test('Find your garment with the UNIQLO pair checked in memory: the server says so for the product picked, and its checked measurements are compared with an item entered by hand — the engine’s own size', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await context.newPage();
    const compares = [];
    page.on('request', (r) => { if (/[?&]compare=1/.test(r.url())) compares.push(r.postDataJSON()); });
    await open(page, 'index.html');
    await page.waitForSelector('#ffr-search');
    await page.fill('#ffr-search', 'uniqlo sweatshirt M');
    await refSettled(page);
    await page.click('#ffr-suggest .ff-suggest-option[data-code="E475377-000"]');
    assert.strictEqual(await held(page), 'checked');
    assert.strictEqual((await page.textContent('#ffr-held')).split('Size')[0], 'Fynd holds checked garment measurements for this product. When it compares, it can use them for yours.');
    assert.strictEqual(await page.inputValue('#ffr-size'), 'M');
    await page.click('#ffr-use');
    await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
    /* the item: UNIQLO's hoodie in M, entered by hand from its chart */
    await compareItem(page, UQ_HOODIE_M);
    await page.waitForSelector('#fit-compare[data-verdict="recommended"]');
    assert.strictEqual(compares.length, 1);
    /* the garment sent as the shopper's fields — brand, size, product — with no verdict of its own */
    assert.deepStrictEqual(compares[0].reference, { type: 'sweatshirts', garment: { favorite: 'perfect', line: 'men', anchor: { brand: 'UNIQLO', size: 'M', product: { name: null, url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } });
    const expected = require('../api/_sizing/engine').compare(
      Object.assign(Schema.empty(), { garments: { sweatshirts: Object.assign(Schema.emptyGarment('sweatshirts'), compares[0].reference.garment) } }),
      candidateRecordOf(UQ_HOODIE_M));
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), `Recommended size: ${expected.recommended}`, 'the engine’s own answer');
    await context.close();
  }));

  await test('the page cannot make a product verified: a garment kept with "verified" flags of its own, on production’s unchecked records, still gets no size — the server and the engine decide', async () => {
    const context = await openContext();
    const page = await context.newPage();
    const compares = [];
    page.on('request', (r) => { if (/[?&]compare=1/.test(r.url())) compares.push(r.url()); });
    await open(page, 'index.html');
    await page.waitForSelector('#ffr-search');
    /* what a page could write for itself: flags no form sets */
    await page.evaluate(() => sessionStorage.setItem('fynd:find-fit:reference', JSON.stringify({
      type: 'sweatshirts', verified: true,
      garment: { favorite: 'perfect', verified: true, verification: { status: 'verified' }, anchor: { brand: 'UNIQLO', size: 'M', verified: true, product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00', verified: true } } }
    })));
    await page.reload();
    await page.waitForSelector('#ff-reference[data-state]');
    /* the badge is never drawn from what the page holds */
    assert.strictEqual(await page.isHidden('#ffr-held'), true);
    const sent = [];
    page.on('request', (r) => { if (/[?&]candidate=1/.test(r.url())) sent.push(r.postDataJSON()); });
    /* compared with an item by hand: the sweatshirt's chart is unchecked, so the garment is its label alone — no size */
    await compareItem(page, UQ_HOODIE_M);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'needs-measurements');
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest, #fit-compare .ff-scale', (ns) => ns.length), 0, 'no size');
    /* and whatever the page held, no flag of its own reached the server */
    assert.strictEqual(sent.length, 1);
    assert.ok(!JSON.stringify(sent[0].reference).includes('verified'), JSON.stringify(sent[0].reference));
    await context.close();
  });

  await test('either order: the item entered before any garment, then the garment — the line says what is next at each step, nothing is compared until Compare fit, and a garment changed afterwards retires the result', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await context.newPage();
    const compares = [];
    page.on('request', (r) => { if (/[?&]compare=1/.test(r.url())) compares.push(r.url()); });
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference .ffr-form');
    /* the item first */
    await enterItem(page, UQ_HOODIE_M);
    assert.deepStrictEqual(await page.$$eval('#ff-progress .ff-progress-text', (ns) => ns.map((n) => n.textContent)), ['Your garment: not added yet', 'Item: ready']);
    assert.strictEqual(await page.textContent('#ff-submit-note'), 'Next: add a garment you own that fits well.');
    /* then the garment */
    await describe(page, { type: 'sweatshirts', size: 'M', brand: 'UNIQLO', product: 'https://www.uniqlo.com/us/en/products/E475377-000/00' });
    await page.waitForSelector('#ff-progress[data-garment="ready"]');
    assert.strictEqual(await page.textContent('#ff-submit-note'), 'Ready to compare.');
    assert.deepStrictEqual(compares, [], 'nothing compared until asked');
    await compareByHand(page);
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
    assert.strictEqual(compares.length, 1, 'compared once');
    assert.strictEqual(await page.textContent('#ff-submit-note'), 'Your comparison is below.');
    /* the garment removed: the result for it goes */
    await page.click('.ff-ref-remove');
    await page.waitForSelector('#ff-reference[data-visit="empty"] .ffr-form');
    await page.waitForFunction(() => document.getElementById('fit-result').hidden);
    assert.strictEqual(await page.textContent('#ff-submit-note'), 'Next: add a garment you own that fits well.');
    await context.close();
  }));

  await test('Popular Wardrobe Anchors: only products whose checked records publish the finished garment\'s measurements — none from production\'s unchecked records, the UNIQLO pair when checked — and picking one fills the garment, with the size on its label still the shopper\'s to choose', async () => {
    const context = await openContext();
    const page = await context.newPage();
    const anchorsFrom = (p) => p.evaluate(async () => (await (await fetch('/api/size-recommendation?anchors=1')).json()).anchors);
    await open(page, 'index.html');
    await page.waitForSelector('#ff-anchors[data-state="ready"]', { state: 'attached' });
    /* production's records: none checked with a garment chart, so none offered */
    assert.deepStrictEqual(await anchorsFrom(page), []);
    assert.strictEqual(await page.isHidden('#ff-anchors'), true);
    const records = require('../api/_sizing/records');
    assert.deepStrictEqual(records.RECORDS.map(records.summary).filter((r) => r.comparable), [], 'the list is the records, not a guess');
    await asChecked(UQ_PAIR, async () => {
      const listed = await anchorsFrom(page);
      assert.deepStrictEqual(listed.map((a) => a.id).sort(), [...UQ_PAIR].sort(), 'exactly the records a comparison can use');
      assert.ok(listed.every((a) => a.url.startsWith('https://www.uniqlo.com/')));
      const compares = [];
      page.on('request', (r) => { if (/[?&]compare=1/.test(r.url())) compares.push(r.url()); });
      await page.reload();
      await page.waitForSelector('#ff-anchors:not([hidden]) .ff-anchor');
      assert.strictEqual(await page.textContent('#ff-anchors-title'), 'Popular Wardrobe Anchors');
      assert.deepStrictEqual((await page.$$eval('#ff-anchors .ff-anchor', (bs) => bs.map((b) => b.dataset.id))).sort(), [...UQ_PAIR].sort());
      assert.match(await page.textContent('#ff-anchors .ff-anchor[data-id="uniqlo-e475377-sweatshirt-us"]'), /Sweatshirt[\s\S]*UNIQLO[\s\S]*Sweatshirt/);
      /* picked: the form filled from the record — type, brand, product — and the size left to the shopper */
      await page.click('#ff-anchors .ff-anchor[data-id="uniqlo-e475377-sweatshirt-us"]');
      assert.strictEqual(await page.getAttribute('#ff-anchors .ff-anchor[data-id="uniqlo-e475377-sweatshirt-us"]', 'aria-pressed'), 'true');
      assert.strictEqual(await page.inputValue('#ffr-type'), 'sweatshirts');
      assert.strictEqual(await page.inputValue('#ffr-brand'), 'UNIQLO');
      assert.strictEqual(await page.inputValue('#ffr-product'), 'https://www.uniqlo.com/us/en/products/E475377-000/00');
      assert.strictEqual(await page.inputValue('#ffr-size'), '', 'no size chosen for them');
      assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ffr-size', 'the one thing left to say');
      await page.selectOption('#ffr-size', 'M');
      await page.click('#ffr-use');
      await page.waitForSelector('#ff-reference[data-visit="set"] .ff-ref--visit');
      /* then the item, entered by hand from UNIQLO's hoodie chart, and compared */
      await compareItem(page, UQ_HOODIE_M);
      await page.waitForSelector('#fit-compare[data-verdict="recommended"]');
      assert.strictEqual(compares.length, 1);
      assert.match(await page.textContent('#fit-compare'), /UNIQLO/);
    });
    /* signed in with garments saved: the anchors give way to them */
    const saved = await signedIn(context, 'anchors@e2e.test');
    await fitProfiles.saveGuide((await users.byEmail('anchors@e2e.test')).id, { garments: { hoodies: { favorite: 'perfect', anchor: { brand: 'Carhartt', size: 'L' } } } });
    await asChecked(UQ_PAIR, async () => {
      await open(saved, 'index.html');
      await saved.waitForSelector('#ff-reference[data-state="saved"]');
      await saved.waitForSelector('#ff-anchors[data-state="ready"]', { state: 'attached' });
      assert.strictEqual(await saved.isHidden('#ff-anchors'), true);
    });
    await context.close();
  });





  await test('the guest flow on a phone: the item checked, then the form in one column, the result and the offer fit, nothing sideways', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 760 });
    await open(page, 'index.html');
    await unlockWith(page);
    await page.waitForSelector('#ff-reference .ffr-form');
    const widths = await page.$$eval('#ff-reference .profile-input', (ns) => ns.filter((n) => n.offsetParent).map((n) => n.getBoundingClientRect().right));
    assert.ok(widths.every((r) => r <= 375), JSON.stringify(widths));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll with the form');
    await describe(page, CARHARTT);
    await compareItem(page);
    await page.waitForSelector('#ff-save[data-state="offer"]');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll with the result and the offer');
    const buttons = await page.$$eval('#ff-save button', (bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [r.height, r.right]; }));
    assert.ok(buttons.every(([h, r]) => h >= 44 && r <= 375), JSON.stringify(buttons));
    await page.click('#ff-save .ff-save-signin');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the sign-in fields fit');
    await context.close();
  }));



  await test('Find Fit with a checked reference product: the recommended size, the reference, how it differs, and signed differences folded away — the engine’s own, through the real endpoint', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await signedIn(context, 'ines@e2e.test');
    const user = await users.byEmail('ines@e2e.test');
    /* UNIQLO's checked Sweatshirt, size S, found by its link: its published garment measurements are the reference */
    await fitProfiles.saveGuide(user.id, { garments: { sweatshirts: { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'S', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } } });
    /* the item: UNIQLO's hoodie in S, entered by hand from its chart — the methods its chart states */
    const UQ_HOODIE_S = byHandFrom('uniqlo-e475378-sweat-pullover-hoodie-us', 'S');
    const expected = require('../api/_sizing/engine').compare((await fitProfiles.read(user.id)).profile, candidateRecordOf(UQ_HOODIE_S));
    assert.strictEqual(expected.status, 'ok');
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="saved"]');
    await compareItem(page, UQ_HOODIE_S);
    await page.waitForSelector('#fit-compare:not([hidden]) .fit-compare-recommended');
    assert.strictEqual((await page.textContent('#fit-compare .fit-compare-recommended')).trim(), `Recommended size: ${expected.recommended}`);
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-reference'), 'Compared with: UNIQLO Sweatshirt, size S (published measurements).');
    assert.match(await page.textContent('#fit-compare'), new RegExp(expected.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(await page.textContent('#fit-compare .fit-compare-differs'), new RegExp(`^Size ${expected.recommended} against your reference: chest width .+, garment length .+, shoulder width .+, sleeve length .+\\.$`));
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-fallback', (ns) => ns.length), 0);
    /* the verdict layout: a recommendation, a three-step scale drawn from the engine's own words, its sources and limits */
    assert.strictEqual(await page.getAttribute('#fit-compare', 'data-verdict'), 'recommended');
    assert.strictEqual(await page.textContent('#fit-compare .fit-compare-title'), 'Compared with your reference');
    /* the garment comparison: one row per compared measurement, the two
       garments' values side by side, which way the size differs and
       whether it is within the working tolerance — each the engine's own */
    const scale = await page.$$eval('#fit-compare .ff-garment .ff-scale-row', (ls) => ls.map((l) => ({
      dim: l.dataset.dim,
      direction: l.dataset.direction,
      similar: l.dataset.similar,
      bars: [...l.querySelectorAll('.ff-bar-line')].map((b) => [b.querySelector('.ff-bar-label').textContent, b.querySelector('.ff-bar-value').textContent, b.querySelector('.ff-bar').classList.contains('ff-bar--reference') ? 'reference' : b.querySelector('.ff-bar').classList.contains('ff-bar--candidate') ? 'candidate' : null]),
      diff: l.querySelector('.ff-diff').textContent,
      similarNote: l.querySelectorAll('.ff-similar').length
    })));
    const recRow = expected.sizes.find((x) => x.size === expected.recommended);
    assert.deepStrictEqual(scale.map((s) => s.dim), expected.dimensionsCompared, 'one row per compared measurement');
    /* the page's own formatting, restated: quarters of an inch; a signed tenth, a true minus, no sign on nothing */
    const quarterInches = (v) => { const q = Math.round(v * 4) / 4; const whole = Math.floor(q); const glyph = { 0: '', 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - whole) * 100) / 100]; return `${whole || !glyph ? whole : ''}${glyph} in`; };
    const signedDiff = (v) => { const t = Math.round(v * 10) / 10; return t === 0 ? '0.0 in' : `${t > 0 ? '+' : '−'}${Math.abs(t).toFixed(1)} in`; };
    const WORD = { girth: { less: 'Narrower', same: 'The same', more: 'Wider' }, length: { less: 'Shorter', same: 'The same', more: 'Longer' } };
    scale.forEach((s) => {
      const { words, withinTolerance, direction, difference, reference, candidate } = recRow.dimensions[s.dim];
      /* which way: the engine's own direction, and the same way its signed difference and its words go */
      assert.strictEqual(s.direction, direction, `${s.dim}: the engine's own direction`);
      const bySign = Math.round(difference * 10) / 10 === 0 ? 'same' : difference > 0 ? 'more' : 'less';
      assert.strictEqual(s.direction, bySign, `${s.dim}: the direction agrees with the signed difference ${difference}`);
      assert.match(words, { same: /the same/, more: /wider|longer/, less: /narrower|shorter/ }[s.direction], `${s.dim}: the direction agrees with the engine's words (${words})`);
      /* similar: exactly the engine's tolerance answer, said in words only when true */
      assert.strictEqual(s.similar, String(withinTolerance === true), `${s.dim}: similar is the engine's within-tolerance answer (${withinTolerance})`);
      assert.strictEqual(s.similarNote, withinTolerance === true ? 1 : 0);
      /* paired measurements: the reference garment's, then the size's, each the engine's own value */
      assert.deepStrictEqual(s.bars, [['Your garment', quarterInches(reference), 'reference'], [`Size ${expected.recommended}`, quarterInches(candidate), 'candidate']], `${s.dim}: both garments' measurements`);
      /* the exact signed difference, named the way it goes */
      const word = WORD[s.dim === 'chestWidth' || s.dim === 'shoulderWidth' ? 'girth' : 'length'][s.direction];
      assert.strictEqual(s.diff, `${word}: ${signedDiff(difference)}`, `${s.dim}: the engine's signed difference`);
    });
    /* nothing left out without its reason, and the drawing marks exactly what was compared */
    assert.strictEqual(await page.$$eval('#fit-compare .ff-scale-skip', (ns) => ns.length), 4 - expected.dimensionsCompared.length);
    assert.deepStrictEqual(await page.$$eval('#fit-compare .ff-garment-line.is-compared', (ns) => ns.map((n) => n.getAttribute('data-dim')).sort()), [...expected.dimensionsCompared].sort());
    assert.match(await page.textContent('#fit-compare .ff-garment-caption'), /not how either fits your body\. Matching measurements don’t guarantee the same fit/);
    /* the item is the shopper's own numbers from its chart; the reference, UNIQLO's checked record */
    assert.match(await page.textContent('#fit-compare .ff-sources'), /^Sources: the measurements you entered from this item’s chart, which Fynd hasn’t checked; your reference’s published measurements/);
    assert.strictEqual(await page.textContent('#fit-compare .ff-limits-title'), 'Limits of this comparison');
    assert.ok(!/%|confiden/i.test(await page.textContent('#fit-compare')), 'no percentage or confidence invented');
    /* folded away until asked for */
    assert.strictEqual(await page.$eval('#fit-compare .fit-compare-differences', (d) => d.open), false);
    await page.click('#fit-compare .fit-compare-differences > summary');
    const rows = await page.$$eval('#fit-compare .fit-compare-differences tbody tr', (trs) => trs.map((tr) => ({ dim: tr.dataset.dim, diff: Number(tr.children[1].dataset.difference), shown: tr.children[1].textContent })));
    const row = expected.sizes.find((x) => x.size === expected.recommended);
    assert.deepStrictEqual(rows.map((r) => r.dim), expected.dimensionsCompared);
    rows.forEach((r) => {
      const want = row.dimensions[r.dim].difference;
      assert.strictEqual(r.diff, want, `${r.dim}: the engine's own signed difference`);
      const tenth = Math.round(want * 10) / 10;
      assert.strictEqual(r.shown, tenth === 0 ? '0.0 in' : `${tenth > 0 ? '+' : '\u2212'}${Math.abs(tenth).toFixed(1)} in`);
    });
    assert.ok(!/UNIQLO|E475377|Sweatshirt/.test(page.url()), 'nothing from the profile in the address');
    /* real records, a real nonzero difference: the Sweatshirt in M beside the hoodie's L, on the product page's Size Guide */
    const mContext = await openContext();
    const mPage = await signedIn(mContext, 'kofi@e2e.test');
    await fitProfiles.saveGuide((await users.byEmail('kofi@e2e.test')).id, { garments: { sweatshirts: { favorite: 'perfect', anchor: { brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } } } } });
    await open(mPage, 'product.html?brand=uniqlo&item=E475378-000&size=L');
    await mPage.waitForSelector('#product[data-state="ready"]');
    await mPage.click('#pdp-size-guide');
    await mPage.waitForSelector('#pdp-guide-compare .fit-compare-size');
    assert.strictEqual((await mPage.textContent('#pdp-guide-compare .fit-compare-recommended')).trim(), 'Recommended size: M');
    const lTable = await mPage.$$eval('#pdp-guide-compare .fit-compare-size tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
    assert.deepStrictEqual(lTable, [
      ['Chest', '23½ in', '25 in', '1½ in wider'],
      ['Body length', '26¾ in', '28 in', '1¼ in longer'],
      ['Shoulders', '20 in', '20¾ in', '¾ in wider'],
      ['Sleeves', '34¾ in', '35¾ in', '1 in longer']
    ], 'UNIQLO’s published L beside its published M');
    await mPage.click('#pdp-guide-sizes .pdp-size[data-size="S"]');
    const sChest = await mPage.$eval('#pdp-guide-compare .fit-compare-size tbody tr', (tr) => [...tr.children].map((c) => c.textContent));
    assert.deepStrictEqual(sChest, ['Chest', '23½ in', '22¼ in', '1¼ in narrower']);
    await mContext.close();
    /* no reference saved: no size, and why */
    const bareContext = await openContext();
    const bare = await signedIn(bareContext, 'jude@e2e.test');
    await open(bare, 'index.html');
    await bare.waitForSelector('#ff-reference .ffr-form');
    await enterItem(bare, UQ_HOODIE_L);
    await bare.click('#ff-submit', { force: true });
    await bare.waitForSelector('#ff-garment-error.show');
    assert.match(await bare.textContent('#ff-garment-error'), /^Choose a garment you own first/);
    assert.strictEqual(await bare.isHidden('#fit-result'), true, 'no size, and no comparison asked for');
    await bareContext.close();
    await context.close();
  }));

  await test('signed out, a type on the Search page is searched across brands, browsed without any profile, and personalising is offered only on request', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await listingsFor(page);
    await open(page, 'find-clothes.html?shop=tshirts');
    await page.waitForSelector(`${NOW} .grid .item-card`);
    assert.strictEqual(await page.$eval('input[name="shop"][value="tshirts"]', (n) => n.checked), true, 'the type, chosen');
    assert.match(await page.textContent('.results-query'), /T-shirts/, 'the type alone is what was searched');
    assert.strictEqual(await page.locator(`${NOW} .grid .item-card`).count(), 3, 'every listing, with no account and no profile');
    assert.strictEqual(await panelState(page), 'no-profile');
    assert.strictEqual(await page.isVisible(`${NOW} .fit-panel-more`), false, 'no questionnaire in the way of shopping');
    assert.strictEqual(await page.locator(`${NOW} .item-fit`).count(), 0, 'no size is claimed for anyone signed out');

    await page.click(`${NOW} .fit-panel-ask`);
    assert.strictEqual((await page.textContent(`${NOW} .fit-panel-title`)).trim(), 'Get a more personalized fit recommendation.');
    assert.match(await page.textContent(`${NOW} .fit-panel-more`), /remember how you like T-shirts to fit/);
    assert.match(await page.textContent(`${NOW} .fit-panel-more`), /compare products against a T-shirt you already own/);
    const href = await page.getAttribute(`${NOW} #fit-panel-go`, 'href');
    assert.strictEqual(href, 'fit-profile.html?for=tshirts&from=search&q=T-shirts');
    await context.close();
  });

  await test('from the prompt to a saved T-shirt profile and back to the search: account made in place, partial answers enough, nothing private in the address', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await listingsFor(page);
    await open(page, 'find-clothes.html');
    await page.check('input[name="shop"][value="tshirts"]');
    await page.fill('#ask', 'white');
    await page.click('#ask-form button[type="submit"]');
    await page.waitForSelector(`${NOW} .fit-panel[data-state="no-profile"]`);
    await page.click(`${NOW} .fit-panel-ask`);
    await page.click(`${NOW} #fit-panel-go`);
    await page.waitForURL(/fit-profile\.html\?for=tshirts&from=search&q=white\+T-shirts/);

    /* signed out: an account right here, and the way back kept */
    await page.waitForSelector('#profile-signed-out:not([hidden])');
    assert.match(await page.textContent('#profile-return'), /your search for “white T-shirts”/);
    await page.fill('#pa-name', 'Tess');
    await page.fill('#pa-email', 'tess@e2e.test');
    await page.fill('#pa-password', PASSWORD);
    await page.fill('#pa-confirm', PASSWORD);
    await page.click('#pa-submit');
    await page.waitForSelector('#profile-form:not([hidden])');

    /* the T-shirt card is open and in view, ready to fill in, and leaving it empty is no "unsaved change" */
    assert.strictEqual(await page.isVisible('#card-tshirts'), true);
    assert.strictEqual(await page.evaluate(() => document.activeElement.closest('#card-tshirts') !== null), true);
    assert.strictEqual(await page.textContent('#profile-save-state'), '');
    /* the old guide's questions, in its words */
    assert.match(await page.textContent('#card-tshirts'), /Do you own a T-shirt that fits you exactly how you like\?/);
    assert.match(await page.textContent('#card-tshirts'), /How do you like your T-shirts to fit\?/);
    assert.match(await page.textContent('#card-tshirts'), /What usually gets the fit wrong\?/);

    /* one answer is a profile: nothing else has to be filled in */
    await page.check('input[name="g-tshirts-goal"][value="true-to-size"]');
    await saveAndWait(page);
    const stored = await savedProfile('tess@e2e.test');
    assert.strictEqual(stored.garments.tshirts.fitGoal, 'true-to-size');
    assert.strictEqual(stored.garments.tshirts.anchor, null);
    assert.match(await page.textContent('#profile-return'), /Saved\. Your search will use it for T-shirts/);
    assert.ok(!/true-to-size|Tess|tess@/i.test(page.url()), `the address carries an answer: ${page.url()}`);

    /* back: the same search, run again, now using the T-shirt profile */
    await page.click('#profile-return-link');
    await page.waitForURL(/find-clothes\.html/);
    await page.waitForSelector(`${NOW} .grid .item-card`);
    assert.strictEqual(await page.$eval('input[name="shop"][value="tshirts"]', (n) => n.checked), true);
    assert.strictEqual(await page.$eval('#ask', (n) => n.value), 'white T-shirts');
    assert.strictEqual(await panelState(page), 'using');
    assert.match(await page.textContent(`${NOW} .fit-panel-title`), /Using your T-shirt fit profile/);
    assert.match(await page.textContent(`${NOW} .fit-panel`), /True to Size/);
    assert.match(await page.textContent(`${NOW} .fit-panel`), /A reference garment with its measurements would let Fynd compare sizes/);
    /* none of these listings is a product Fynd has checked T-shirt sizing for: no size is made up */
    await page.waitForSelector(`${NOW} .fit-panel-matched`);
    assert.match(await page.textContent(`${NOW} .fit-panel-matched`), /None of these listings has measurements Fynd has checked/);
    assert.strictEqual(await page.locator(`${NOW} .item-fit`).count(), 0);
    const kept = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
    assert.ok(!/true-to-size|tshirts|garment|fit/i.test(kept), `found in browser storage: ${kept}`);
    await context.close();
  });

  await test('no size without the decision, on the real pages: a label-only hoodie is a body-size estimate on the search page, never "your size"; an exact product is; and Compare names an overruled size only as closest, with no reliability', () => asChecked(UQ_PAIR.concat(['zara-00761810-basic-heavyweight-hoodie-us']), async () => {
    const context = await openContext();
    const page = await signedIn(context, 'lena@e2e.test');
    const user = await users.byEmail('lena@e2e.test');
    const tagOf = async () => {
      await page.waitForSelector(`${NOW} .fit-panel-matched`);
      return page.$eval(`${NOW} .grid .item-card .item-fit`, (t) => ({ text: t.textContent, cls: t.className, result: t.dataset.result }));
    };
    const search = async () => {
      await listingsFor(page);
      await open(page, 'find-clothes.html');
      await page.fill('#ask', 'grey hoodie');
      await page.click('#ask-form button[type="submit"]');
    };
    /* a brand and size label alone: an estimate from body sizes and the brand's chart, said to be one */
    await fitProfiles.saveGuide(user.id, { garments: { hoodies: { favorite: 'perfect', line: 'men', fitGoal: 'true-to-size', anchor: { brand: 'UNIQLO', size: 'M' } } } });
    await search();
    let tag = await tagOf();
    assert.strictEqual(tag.result, 'body-estimate');
    assert.match(tag.cls, /\bitem-fit--estimate\b/);
    assert.match(tag.text, /^Body-size estimate: [A-Z0-9]+ · low confidence — from body sizes and the brand’s size chart, not compared with a garment of yours$/);
    assert.doesNotMatch(tag.text, /Your size|Recommended/);
    /* the garment comparison of the same profile abstains, on Find Fit with the item entered by hand */
    await open(page, 'index.html');
    await page.waitForSelector('#ff-reference[data-state="saved"]');
    await compareItem(page);
    assert.strictEqual(await page.$$eval('#fit-compare .fit-compare-recommended, #fit-compare .fit-compare-closest, #fit-compare .ff-scale', (ns) => ns.length), 0, 'no size from a label');
    assert.doesNotMatch(await page.textContent('#fit-compare'), /Recommended size|Body-size estimate/);

    /* the exact product, by its link: a garment comparison — "your size" */
    await fitProfiles.saveGuide(user.id, { garments: { hoodies: { favorite: 'perfect', line: 'men', fitGoal: 'true-to-size', anchor: { brand: 'UNIQLO', size: 'L', product: { url: 'https://www.uniqlo.com/us/en/products/E475378-000/00' } } } } });
    await search();
    tag = await tagOf();
    assert.deepStrictEqual([tag.result, tag.text.replace(/ · .*$/, '')], ['garment-comparison', 'Your size: L']);
    assert.match(tag.cls, /\bitem-fit--ok\b/);

    /* Compare: a measured reference the engine alone would call S, the decision NO_MATCH (the chest 7 cm narrower) */
    const zara = require('../api/_sizing/records').byId('zara-00761810-basic-heavyweight-hoodie-us');
    const s = zara.charts.garment.sizes.S;
    await fitProfiles.saveGuide(user.id, { garments: { hoodies: { favorite: 'perfect', anchor: { brand: null, size: null, measurements: { unit: 'cm', chestWidth: String(s.chestWidth.value - 7), bodyLength: String(s.bodyLength.value), shoulderWidth: String(s.shoulderWidth.value), sleeveLength: String(s.sleeveLength.value) } } } } });
    await open(page, 'compare.html');
    await page.waitForSelector('#ref-saved:not([hidden])');
    await page.click(`[data-product="${zara.id}"]`);
    await page.waitForSelector('#result-section:not([hidden]) .compare-tag');
    assert.deepStrictEqual(await page.$$eval('#result-section .compare-tag', (ts) => ts.map((t) => t.textContent)), ['Closest — not recommended']);
    assert.strictEqual(await page.isVisible('#result-reliability'), false, 'no reliability without a recommendation');
    const summary = await page.textContent('#result-summary');
    assert.doesNotMatch(summary, /\bS is the closest to your reference\b|Recommended/);
    assert.match(summary, /closest size, size S/i);
    await context.close();
  }));

  await test('a hoodie search uses the hoodie reference: the matched listing is compared, the rest say nothing, and a jeans search is never sized from it', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await signedIn(context, 'hugo@e2e.test');
    const user = await users.byEmail('hugo@e2e.test');
    await fitProfiles.saveGuide(user.id, { garments: {
      hoodies: { favorite: 'perfect', fitGoal: 'oversized', anchor: { brand: 'Carhartt', size: 'L', measurements: { unit: 'cm', chestWidth: '58', bodyLength: '68', shoulderWidth: '50', sleeveLength: '62' } } },
      jeans: { anchor: { brand: 'Levi’s', size: '32', length: '30' }, fitGoal: 'slim' }
    } });
    await listingsFor(page);
    await open(page, 'find-clothes.html');
    await page.fill('#ask', 'grey hoodie');
    await page.click('#ask-form button[type="submit"]');
    assert.strictEqual(await panelState(page), 'using');
    assert.match(await page.textContent(`${NOW} .fit-panel-title`), /Using your hoodie fit profile/);
    assert.match(await page.textContent(`${NOW} .fit-panel`), /Carhartt · L/);
    assert.match(await page.textContent(`${NOW} .fit-panel`), /Ready to compare sizes with your reference/);
    await page.waitForSelector(`${NOW} .fit-panel-matched`);
    assert.match(await page.textContent(`${NOW} .fit-panel-matched`), /1 of 3 listings matched a product Fynd has sizing for\. The other 2 get no size/);
    /* UNIQLO measures sleeve and length from the centre back: chest and shoulders only — too few, so no size at all, not even a closest */
    const tags = await page.$$eval(`${NOW} .grid .item-card`, (cards) => cards.map((c) => (c.querySelector('.item-fit') || {}).textContent || null));
    assert.match(tags[0], /^No size for you: Only chest and shoulders are measured the same way/);
    assert.doesNotMatch(tags[0], /Closest|Recommended|\bsize [A-Z]{1,3}\b/);
    assert.deepStrictEqual(tags.slice(1), [null, null], 'no size invented for listings Fynd has no measurements for');

    /* jeans: the jeans answers, said to be uncomparable, and no listing sized */
    await page.fill('#ask', 'blue jeans');
    await page.click('#ask-form button[type="submit"]');
    await page.waitForSelector(`${NOW} .fit-panel[data-state="using"][data-type="jeans"]`);
    assert.match(await page.textContent(`${NOW} .fit-panel-title`), /Using your jeans fit profile/);
    assert.match(await page.textContent(`${NOW} .fit-panel`), /Levi’s · 32 × 30/);
    assert.match(await page.textContent(`${NOW} .fit-panel`), /can’t compare jeans sizes yet/);
    assert.strictEqual(await page.locator(`${NOW} .item-fit`).count(), 0);
    assert.ok(!(await page.textContent(`${NOW} .fit-panel`)).includes('Carhartt'), 'nothing from the hoodie is read for jeans');

    /* a type with nothing saved is sent to its own card, not to start over */
    await page.fill('#ask', 'track pants');
    await page.click('#ask-form button[type="submit"]');
    await page.waitForSelector(`${NOW} .fit-panel[data-state="missing-type"]`);
    assert.match(await page.textContent(`${NOW} .fit-panel-line`), /nothing for sweatpants yet/);
    await page.click(`${NOW} .fit-panel-ask`);
    assert.strictEqual((await page.textContent(`${NOW} #fit-panel-go`)).trim(), 'Add sweatpants to your fit profile');
    assert.match(await page.getAttribute(`${NOW} #fit-panel-go`, 'href'), /^fit-profile\.html\?for=sweatpants&from=search/);
    /* a request with no type: the panel asks which, and sizes nothing */
    await page.fill('#ask', 'something warm');
    await page.check('input[name="shop"][value=""]');
    await page.click('#ask-form button[type="submit"]');
    await page.waitForSelector(`${NOW} .fit-panel[data-state="no-type"]`);
    await context.close();
  }));

  await test('"View sizing chart" on a result: fetched only when pressed, shown over the results, honest about what it is — signed out, with no profile', async () => {
    const context = await openContext();
    const page = await context.newPage();
    await listingsFor(page);
    await open(page, 'find-clothes.html');
    await page.fill('#ask', 'hoodie');
    await page.click('#ask-form button[type="submit"]');
    await page.waitForSelector(`${NOW} .item-chart`);
    assert.strictEqual(await page.locator(`${NOW} .item-chart`).count(), 3, 'every real listing has one');
    const chartsAsked = () => apiHits.filter((p) => p === '/api/size-recommendation').length;
    const before = chartsAsked();

    /* the UNIQLO listing: Fynd's record, pending review, body and garment kept apart, values as published */
    await page.click(`${NOW} .item-card:nth-child(1) .item-chart`);
    await page.waitForSelector('#size-chart[data-state="ok"]');
    assert.strictEqual(chartsAsked(), before + 1, 'one request, for this product only');
    assert.match(await page.textContent('#size-chart-product'), /UNIQLO · Sweat Pullover Hoodie/);
    const kinds = await page.$$eval('#size-chart .size-chart-kind', (ns) => ns.map((n) => n.textContent));
    assert.deepStrictEqual(kinds, ['Finished-garment measurements — the clothing itself', 'Body measurements — the body each size fits, not the garment'], 'the garment’s own first');
    assert.match(await page.textContent('#size-chart'), /Unverified — copied from the brand’s page, not yet checked/);
    assert.ok(!/Verified —/.test(await page.textContent('#size-chart')), 'never called verified while pending review');
    assert.match(await page.textContent('#size-chart'), /This product’s own chart/);
    assert.match(await page.textContent('#size-chart'), /Units: inches/);
    /* the body chart, now second, keeps its values as published */
    const mRow = await page.$$eval('#size-chart-t1 tbody tr', (rows) => rows.map((r) => r.textContent).find((t) => t.startsWith('M')));
    assert.strictEqual(mRow, 'M37 ¾ - 41');
    assert.strictEqual(await page.getAttribute('#size-chart .size-chart-details .size-chart-source a', 'href'), 'https://www.uniqlo.com/us/en/products/E475378-000/00');
    assert.ok(!/runs (small|large)|true to size/i.test(await page.textContent('#size-chart')), 'no claim about how it runs');
    assert.ok(page.url().includes('find-clothes.html'), 'still on the search');

    /* closed with Escape: focus goes back to the button that opened it */
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.$eval('#size-chart', (n) => n.open), false);
    assert.strictEqual(await page.evaluate(() => document.activeElement.classList.contains('item-chart')), true);

    /* any shop is tried; one that can't be reached says so, with nothing invented */
    await page.click(`${NOW} .item-card:nth-child(2) .item-chart`);
    await page.waitForSelector('#size-chart[data-state="unavailable"]');
    assert.strictEqual(await page.$$eval('#size-chart table', (ns) => ns.length), 0);
    /* a retailer whose terms Fynd hasn't reviewed: its page isn't fetched, and that is what is said */
    assert.strictEqual(await page.textContent('#size-chart .size-chart-note'), 'Fynd doesn’t read this retailer’s pages: it hasn’t confirmed their terms allow it.');
    assert.match(await page.textContent('#size-chart .size-chart-hint'), /open the product page/);
    await page.click('#size-chart-close');
    /* a brand page that refuses to be read: why, and the link, never a chart */
    await page.click(`${NOW} .item-card:nth-child(3) .item-chart`);
    await page.waitForSelector('#size-chart[data-state="unavailable"]');
    assert.strictEqual(await page.textContent('#size-chart .size-chart-note'), 'The retailer’s site doesn’t allow Fynd to read this page.');
    assert.strictEqual(await page.getAttribute('#size-chart .size-chart-hint a', 'href'), 'https://www.zara.com/us/en/boxy-t-shirt-p1.html', 'the page itself, to check by hand');
    assert.strictEqual(await page.$$eval('#size-chart table', (ns) => ns.length), 0);
    await context.close();
  });

  await test('everything the old guide saved is on the fit profile, filled in, and saving it changes nothing', async () => {
    const context = await openContext();
    const page = await signedIn(context, 'gwen@e2e.test');
    const user = await users.byEmail('gwen@e2e.test');
    await fitProfiles.save(user.id, { schemaVersion: 2, measurements: { unit: 'in', chest: 40 }, anchor: { brand: 'UNIQLO', size: 'M' }, fitGoal: 'slim', troubleZones: ['sleeves-short'] });
    await fitProfiles.saveGuide(user.id, { garments: {
      tshirts: { favorite: 'close', line: 'men', fitGoal: 'true-to-size', troubleZones: ['sleeves-short'],
        anchor: { brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E455365-000/00' }, likes: ['shoulders', 'length'],
          measurements: { unit: 'in', chestWidth: '20', shoulderWidth: '17', sleeveLength: '8', bodyLength: '28' }, notes: 'roomy in the body' } },
      jeans: { anchor: { brand: 'Levi’s', size: '32', length: '30' }, fitGoal: 'slim', troubleZones: [] },
      other: { name: 'Swim trunks', fitGoal: 'oversized' }
    } });
    const before = await savedProfile('gwen@e2e.test');
    await open(page, 'fit-profile.html');
    await page.waitForSelector('#profile-form:not([hidden])');
    const value = (sel) => page.$eval(sel, (n) => n.value);
    const checked = (sel) => page.$eval(sel, (n) => n.checked);
    assert.strictEqual(await checked('input[name="g-tshirts-favorite"][value="close"]'), true);
    assert.deepStrictEqual([await value('#g-tshirts-brand'), await value('#g-tshirts-size'), await value('#g-tshirts-line')], ['UNIQLO', 'M', 'men']);
    assert.strictEqual(await page.$eval('#card-tshirts [data-part="more"]', (n) => n.open), true, 'saved details are shown, not folded away');
    assert.strictEqual(await value('#g-tshirts-product'), 'https://www.uniqlo.com/us/en/products/E455365-000/00');
    assert.deepStrictEqual(await page.$$eval('input[name="g-tshirts-likes"]:checked', (ns) => ns.map((n) => n.value)), ['shoulders', 'length']);
    assert.deepStrictEqual(await Promise.all(['chestWidth', 'shoulderWidth', 'sleeveLength', 'bodyLength'].map((k) => value(`#g-tshirts-m-${k}`))), ['20', '17', '8', '28']);
    assert.strictEqual(await page.$$eval('#card-tshirts .compare-how', (ns) => ns.length), 4, 'each measurement says how to take it');
    assert.strictEqual(await value('#g-tshirts-notes'), 'roomy in the body');
    assert.strictEqual(await checked('input[name="g-tshirts-zones"][value="sleeves-short"]'), true);
    assert.match(await page.textContent('#card-tshirts .garment-status'), /Ready to compare sizes with your reference/);
    assert.deepStrictEqual([await value('#g-jeans-size'), await value('#g-jeans-length')], ['32', '30']);
    assert.strictEqual(await checked('input[name="g-jeans-zones"][value="none"]'), true);
    assert.strictEqual(await value('#g-other-name'), 'Swim trunks');
    assert.strictEqual(await page.isVisible('#legacy-guide'), true, 'the first questions’ answers about a top, as given');
    /* saved untouched, nothing is lost or changed */
    await page.fill('#measure-chest', '40.5');
    await saveAndWait(page);
    const after = await savedProfile('gwen@e2e.test');
    assert.deepStrictEqual(after.garments, before.garments);
    ['anchor', 'fitGoal', 'troubleZones'].forEach((k) => assert.deepStrictEqual(after[k], before[k], k));
    assert.strictEqual(after.measurements.chest, 40.5);
    await context.close();
  });

  await test('a reference garment is added with its measurements, checked, replaced and removed on its card; Compare reads it and links there', () => asChecked(UQ_PAIR, async () => {
    const fitFeedback = require('../api/_fit-feedback');
    const context = await openContext();
    /* signed out, Compare only says why it needs an account */
    const out = await context.newPage();
    await open(out, 'compare.html');
    await out.waitForSelector('#compare-signed-out:not([hidden])');
    await out.close();

    const page = await signedIn(context, 'cora@e2e.test');
    await open(page, 'compare.html');
    await page.waitForSelector('#compare-root[data-ready]');
    assert.strictEqual(await page.isVisible('#ref-empty'), true, 'no reference yet, and products can still be looked at');
    assert.strictEqual(await page.$('#ref-form'), null, 'references are not edited here any more');
    assert.strictEqual(await page.getAttribute('#ref-add', 'href'), 'fit-profile.html?for=hoodies');
    await page.click('#ref-add');
    await page.waitForURL(/fit-profile\.html\?for=hoodies/);
    await page.waitForSelector('#card-hoodies');

    /* the hoodie card: a favourite, then the piece, laid flat */
    await page.check('input[name="g-hoodies-favorite"][value="perfect"]');
    await page.selectOption('#g-hoodies-brand', 'Carhartt');
    await page.selectOption('#g-hoodies-size', 'L');
    await page.click('#card-hoodies .garment-more-summary');
    assert.match(await page.textContent('#card-hoodies'), /measure the garment — not yourself/);
    await page.check('input[name="g-hoodies-unit"][value="cm"]');
    assert.strictEqual((await page.textContent('#card-hoodies [data-part="unit-label"]')).trim(), 'cm');
    await page.fill('#g-hoodies-m-chestWidth', '120');
    await page.click('#profile-save');
    await page.waitForSelector('[data-field="garments.hoodies.anchor.measurements.chestWidth"] .profile-error:not(:empty)');
    assert.match(await page.textContent('[data-field="garments.hoodies.anchor.measurements.chestWidth"] .profile-error'), /laid flat, armpit to armpit/);
    assert.strictEqual(await savedProfile('cora@e2e.test'), null, 'nothing saved while a measurement is wrong');
    await page.fill('#g-hoodies-m-chestWidth', '58');
    await page.fill('#g-hoodies-m-bodyLength', '68');
    await page.fill('#g-hoodies-m-shoulderWidth', '50');
    await page.fill('#g-hoodies-m-sleeveLength', '62');
    await page.check('input[name="g-hoodies-likes"][value="chest"]');
    await page.fill('#g-hoodies-notes', 'Roomy but not baggy');
    await saveAndWait(page);
    let stored = (await savedProfile('cora@e2e.test')).garments.hoodies;
    /* version 6: saved with how each value was measured — the form's own method for each, under the registry it was named by */
    assert.deepStrictEqual(stored.anchor, {
      brand: 'Carhartt', size: 'L', likes: ['chest'], notes: 'Roomy but not baggy',
      measurements: { unit: 'cm', chestWidth: 58, shoulderWidth: 50, sleeveLength: 62, bodyLength: 68 },
      methods: { registry: 1, chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' }
    });
    assert.strictEqual((await savedProfile('cora@e2e.test')).schemaVersion, 6);
    assert.match(await page.textContent('#card-hoodies .garment-status'), /Ready to compare sizes with your reference/);

    /* Compare reads it, and compares a checked product */
    await open(page, 'compare.html');
    await page.waitForSelector('#ref-saved:not([hidden])');
    assert.match(await page.textContent('#ref-saved-list'), /Chest, flat\s*58 cm/);
    assert.strictEqual(await page.getAttribute('#ref-edit', 'href'), 'fit-profile.html?for=hoodies');
    await page.click('[data-product="uniqlo-e475378-sweat-pullover-hoodie-us"]');
    await page.waitForFunction(() => /Only chest and shoulders are measured the same way/.test(document.querySelector('#result-summary').textContent));
    assert.strictEqual(await page.isVisible('#result-table-wrap'), false, 'too few measured alike: no size table');
    assert.strictEqual(await page.locator('.compare-tag').count(), 0, 'neither "Recommended" nor "Closest" from too little');
    await page.click('[data-product="zara-00761810-basic-heavyweight-hoodie-us"]');
    await page.waitForFunction(() => /haven't been checked against Zara's own page yet/.test(document.querySelector('#result-summary').textContent));
    assert.strictEqual(await page.isVisible('#result-table-wrap'), false, 'an unchecked product shows no numbers');

    /* fit feedback, still on Compare, against the reference — once its answer is in, which redraws the form */
    await page.click('[data-product="uniqlo-e475378-sweat-pullover-hoodie-us"]');
    await page.waitForFunction(() => /Only chest and shoulders are measured the same way/.test(document.querySelector('#result-summary').textContent));
    await page.waitForSelector('#feedback-section:not([hidden])');
    await page.selectOption('#fb-size', 'M');
    await page.check('input[name="fbExpected"][value="yes"]');
    await page.check('#fb-consent');
    await page.click('#fb-save');
    await page.waitForSelector('.compare-feedback-entry');
    const user = await users.byEmail('cora@e2e.test');
    assert.strictEqual((await fitFeedback.read(user.id)).entries[0].reference.brand, 'Carhartt');

    /* replaced: another hoodie, and the measurements of the first cleared */
    await page.click('#ref-edit');
    await page.waitForSelector('#card-hoodies');
    await page.selectOption('#g-hoodies-brand', 'Nike');
    await page.selectOption('#g-hoodies-size', 'M');
    for (const k of ['chestWidth', 'bodyLength', 'shoulderWidth', 'sleeveLength']) await page.fill(`#g-hoodies-m-${k}`, '');
    await saveAndWait(page);
    stored = (await savedProfile('cora@e2e.test')).garments.hoodies;
    assert.deepStrictEqual(stored.anchor, { brand: 'Nike', size: 'M', likes: ['chest'], notes: 'Roomy but not baggy' });
    assert.match(await page.textContent('#card-hoodies .garment-status'), /Measure your reference hoodie laid flat/);

    /* removed: the piece goes, how hoodies should fit stays */
    await page.check('input[name="g-hoodies-goal"][value="oversized"]');
    await page.click('#card-hoodies [data-remove-reference]');
    await saveAndWait(page);
    stored = (await savedProfile('cora@e2e.test')).garments.hoodies;
    assert.deepStrictEqual([stored.anchor, stored.favorite, stored.fitGoal], [null, null, 'oversized']);
    await open(page, 'compare.html');
    await page.waitForSelector('#ref-empty:not([hidden])');
    await context.close();
  }));

  await test('a reference saved at version 5 reads as version 6 with every value as it was and the method its form measured each by; shown, re-saved from its card and compared by those methods', () => asChecked(UQ_PAIR, async () => {
    const context = await openContext();
    const page = await signedIn(context, 'mira@e2e.test');
    const user = await users.byEmail('mira@e2e.test');
    /* as version 5 stored it: three of four values measured on the form, no methods; a sweatshirt by label alone */
    const measurements = { unit: 'cm', chestWidth: 58, bodyLength: 68, sleeveLength: 62, shoulderWidth: null };
    await store.set(fitProfiles.profileKey(user.id), Object.assign(Schema.empty(), { schemaVersion: 5, garments: {
      hoodies: { favorite: 'perfect', line: null, anchor: { brand: 'Carhartt', size: 'L', measurements: Object.assign({}, measurements) } },
      sweatshirts: { favorite: 'perfect', line: null, anchor: { brand: 'UNIQLO', size: 'S' } }
    } }));
    /* the version 5 form measured each value one way: that method, named, for exactly the values held */
    const historical = { registry: 1, chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', sleeveLength: 'shoulder-seam-to-cuff' };
    let read = await savedProfile('mira@e2e.test');
    assert.strictEqual(read.schemaVersion, 6);
    assert.deepStrictEqual(read.garments.hoodies.anchor.measurements, measurements, 'every value as it was, the missing one still missing');
    assert.deepStrictEqual(read.garments.hoodies.anchor.methods, historical, 'the historical methods, only for the values held');
    assert.ok(!('methods' in read.garments.sweatshirts.anchor), 'a label is given no methods — it is never a measurement');

    /* Compare shows the migrated values */
    await open(page, 'compare.html');
    await page.waitForSelector('#ref-saved:not([hidden])');
    assert.match(await page.textContent('#ref-saved-list'), /Chest, flat\s*58 cm/);
    assert.match(await page.textContent('#ref-saved-list'), /Chest, flat58 cmBody length68 cmShouldersNot measuredSleeves62 cm/, 'every migrated value, and the missing one said so');

    /* the card holds them, and a save of something else keeps values and methods exactly */
    await open(page, 'fit-profile.html?for=hoodies');
    await page.waitForSelector('#card-hoodies');
    /* opened, not toggled: a card with a saved reference may already show its details */
    await page.$eval('#card-hoodies .garment-more-summary', (s) => { s.parentElement.open = true; });
    assert.deepStrictEqual(await Promise.all(['chestWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth'].map((k) => page.inputValue(`#g-hoodies-m-${k}`))), ['58', '68', '62', '']);
    await page.fill('#g-hoodies-notes', 'Saved before methods were recorded');
    await saveAndWait(page);
    read = await savedProfile('mira@e2e.test');
    assert.strictEqual(read.garments.hoodies.anchor.notes, 'Saved before methods were recorded');
    assert.deepStrictEqual(read.garments.hoodies.anchor.measurements, measurements);
    assert.deepStrictEqual(read.garments.hoodies.anchor.methods, historical);

    /* the decision reads each value by its saved method, never relabelled to suit the product: UNIQLO
       measures length and sleeve from the centre back, so only chest is comparable — too little, no size */
    const decided = require('../api/_sizing/decision').decide(read, require('../api/_sizing/records').byId('uniqlo-e475378-sweat-pullover-hoodie-us'), { via: 'compare' });
    const byDim = Object.fromEntries(decided.dimensions.map((d) => [d.dim, d]));
    ['chestWidth', 'bodyLength', 'sleeveLength'].forEach((d) => assert.strictEqual(byDim[d].reference.method, historical[d], `${d}: read as the saved method`));
    assert.deepStrictEqual(['chestWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth'].map((d) => byDim[d].status), ['compatible', 'incompatible-method', 'incompatible-method', 'missing-reference']);
    assert.strictEqual(decided.comparison, 'garment-to-garment');
    assert.strictEqual(decided.outcome, 'INSUFFICIENT_DATA');
    assert.strictEqual(decided.size, null);
    await context.close();
  }));

  await test('"Not really" hides the reference questions and saves no piece; a sweatshirt card is never filled from a hoodie', async () => {
    const context = await openContext();
    const page = await signedIn(context, 'nora@e2e.test');
    await open(page, 'fit-profile.html?for=sweatshirts');
    await page.waitForSelector('#card-sweatshirts');
    await page.check('input[name="g-sweatshirts-favorite"][value="none"]');
    assert.strictEqual(await page.isVisible('#card-sweatshirts [data-reference]'), false);
    await page.check('input[name="g-sweatshirts-zones"][value="sleeves-short"]');
    await page.check('input[name="g-sweatshirts-zones"][value="none"]');
    assert.strictEqual(await page.$eval('input[name="g-sweatshirts-zones"][value="sleeves-short"]', (n) => n.checked), false, '"None of these" and a spot rule each other out');
    await saveAndWait(page);
    const stored = await savedProfile('nora@e2e.test');
    assert.deepStrictEqual([stored.garments.sweatshirts.favorite, stored.garments.sweatshirts.anchor, stored.garments.sweatshirts.troubleZones], ['none', null, []]);
    assert.strictEqual(stored.garments.hoodies, undefined);
    /* each type's own lists: no waist sizes for a sweatshirt, no letters for jeans */
    await page.selectOption('#garment-add-select', 'jeans');
    await page.click('#garment-add');
    const sizes = await page.$$eval('#g-jeans-size option', (ns) => ns.map((n) => n.value));
    assert.ok(sizes.includes('32') && !sizes.includes('M'));
    assert.ok(!(await page.$$eval('#g-sweatshirts-size option', (ns) => ns.map((n) => n.value))).includes('32'));
    await context.close();
  });

  await test('the fit profile on a 360px phone, opened for a type: no sideways scroll, and every card control reachable', async () => {
    const context = await openContext();
    const page = await signedIn(context, 'pia@e2e.test');
    await page.setViewportSize({ width: 360, height: 740 });
    await open(page, 'fit-profile.html?for=tshirts&from=search&q=linen');
    await page.waitForSelector('#card-tshirts');
    await page.check('input[name="g-tshirts-favorite"][value="perfect"]');
    await page.click('#card-tshirts .garment-more-summary');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 360, `the page is ${width}px wide on a 360px screen`);
    const offscreen = await page.$$eval('#card-tshirts input:not([type="radio"]):not([type="checkbox"]), #card-tshirts select, #card-tshirts button, #card-tshirts .choice, #profile-return a',
      (ns) => ns.filter((n) => n.offsetParent && n.getBoundingClientRect().right > 360).map((n) => n.id || n.className));
    assert.deepStrictEqual(offscreen, []);
    await context.close();
  });

  console.log('\nfrom a page on another origin');

  /* The deployment this project runs: pages on GitHub Pages, functions
     on Vercel. Every test above is same-origin, and a same-origin
     request is never preflighted — which is how a preflight that refused
     the CSRF header went unnoticed while logout, checkout and the billing
     portal were blocked from the Pages copy.

     Here the page is on PAGE_ORIGIN and the API on ORIGIN, so each call
     is a real CORS request and the browser decides for itself whether
     to send it. What this cannot show is a cross-SITE cookie. Production
     needs SameSite=None, a browser accepts that only with Secure, and
     Secure needs https, so _auth.js gives plain-http localhost Lax
     instead; it travels here only because both origins are the same
     site, 127.0.0.1. Whether a browser that blocks third-party cookies
     sends production's at all is a separate question this cannot
     answer — see "Cross-origin access" in the README. */
  await test('a signed-in logout from another origin gets past the preflight and ends the session', async () => {
    apiRequests.length = 0;
    /* no route: with one installed, Playwright would answer the
       preflights itself and this would pass whatever _cors.js said */
    const context = await openContext({ intercept: false });
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD }, PAGE_ORIGIN);
    await page.waitForSelector('#panel-account:not([hidden])');

    assert.ok(apiRequests.some((r) => r.method === 'OPTIONS' && r.origin === PAGE_ORIGIN && r.status === 204),
      `no preflight from ${PAGE_ORIGIN} reached the server, so the browser was not asking it: ${JSON.stringify(apiRequests)}`);

    const session = (await context.cookies(ORIGIN)).find((c) => c.name === auth.SESSION_COOKIE && c.value);
    assert.ok(session, 'signing up from the other origin should have left the API a session cookie');
    assert.ok(await auth.readSession(session.value), 'and the server should hold that session');

    /* The note already says "check your email" from the sign-up; a
       failed logout turns it into a warning. */
    const WARNING = '#account-note.billing-note--warn:not([hidden])';
    assert.strictEqual(await page.$(WARNING), null, 'a warning was on screen before logging out');

    const before = apiRequests.length;
    await page.click('#signout-button');
    await page.waitForSelector(`#panel-choose:not([hidden]), ${WARNING}`);

    const said = await page.$eval('#account-note', (n) => (n.classList.contains('billing-note--warn') && !n.hidden ? n.textContent : ''));
    const logout = apiRequests.slice(before).find((r) => r.method === 'POST' && r.path === '/api/auth');
    assert.ok(!said && logout,
      `the logout never reached the API — the page said "${said}" and the API saw ${JSON.stringify(apiRequests.slice(before))}. ` +
      `The browser blocks a POST whose preflight does not allow ${auth.CSRF_HEADER}.`);
    assert.strictEqual(logout.origin, PAGE_ORIGIN, 'the logout has to come from the other origin, or this proves nothing');
    assert.strictEqual(logout.csrf, true, 'and has to carry the CSRF header');
    assert.strictEqual(logout.status, 200);

    assert.ok(page.url().startsWith(`${PAGE_ORIGIN}/`), `the page left its own origin: ${page.url()}`);
    assert.strictEqual(await auth.readSession(session.value), null,
      'the session must be dead on the server, not just forgotten by the browser');
    await context.close();
  });

  await test('a fit profile saved from another origin gets past the preflight, reads back after a reload, and deletes', async () => {
    apiRequests.length = 0;
    /* no route, for the same reason as the logout above */
    const context = await openContext({ intercept: false });
    const page = await context.newPage();
    await signUpThroughTheUI(page, { name: 'Ada', email: 'ada@e2e.test', password: PASSWORD }, PAGE_ORIGIN);
    await page.waitForSelector('#panel-account:not([hidden])');
    await page.click('#fit-profile-link');
    await page.waitForURL(`${PAGE_ORIGIN}/fit-profile.html`);
    await page.waitForSelector('#profile-form:not([hidden])');

    await page.fill('#measure-chest', '40');
    await addBrand(page, { brand: 'Uniqlo', category: 'hoodies', size: 'M' });
    await saveAndWait(page);

    const saved = apiRequests.filter((r) => r.method === 'POST' && r.path === '/api/fit-profile').pop();
    assert.ok(saved, `the save never reached the API: ${JSON.stringify(apiRequests)}`);
    assert.strictEqual(saved.origin, PAGE_ORIGIN, 'the save has to come from the other origin, or this proves nothing');
    assert.strictEqual(saved.csrf, true, 'and has to carry the CSRF header');
    assert.strictEqual(saved.status, 200);
    assert.strictEqual((await savedProfile('ada@e2e.test')).measurements.chest, 40);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-form:not([hidden])');
    assert.strictEqual(await page.$eval('#measure-chest', (n) => n.value), '40');
    assert.strictEqual(await page.locator('#brand-list > .brand-row').count(), 1);
    const read = apiRequests.filter((r) => r.method === 'GET' && r.path === '/api/fit-profile').pop();
    assert.ok(read && read.origin === PAGE_ORIGIN && read.status === 200, 'read back across origins');

    await page.click('#profile-delete');
    await page.click('#delete-confirm-yes');
    await waitForDeleted(page);
    assert.strictEqual(await savedProfile('ada@e2e.test'), null);
    const deleted = apiRequests.filter((r) => r.method === 'POST' && r.path === '/api/fit-profile').pop();
    assert.ok(deleted.origin === PAGE_ORIGIN && deleted.csrf && deleted.status === 200);
    await context.close();
  });

  await browser.close();
  closeServers();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); closeServers(); process.exit(1); });
