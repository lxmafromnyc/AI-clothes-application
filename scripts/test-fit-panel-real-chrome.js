#!/usr/bin/env node
/* =========================================================
   Fynd — the Fit panel end to end, in a real, visible Chrome

     node scripts/test-fit-panel-real-chrome.js
     node scripts/test-fit-panel-real-chrome.js --live URL [URL ...]

   What this does that the other browser suites can't:

     - Chromium runs headed, on a virtual display (Xvfb), with the
       extension loaded exactly as shipped from extension/ — no test copy,
       no extra host permission, no ?tab= hook, its config.js unchanged.
     - Fynd's toolbar button is clicked with a real X11 mouse click
       (scripts/real-chrome/xinput.py, via XTEST). That click is what
       Chrome turns into activeTab access and what opens the side panel;
       nothing else can stand in for it.
     - Fynd's API is reached at its production address,
       https://ai-clothes-application.vercel.app — Chrome is told to
       resolve that name to this machine, where Fynd's own handlers
       (/api/auth, /api/fit-profile, /api/size-recommendation) answer
       over TLS with a throwaway certificate. The shopper signs in on
       that origin as on the site, so the panel's requests carry the
       real session cookie (SameSite=Lax; Secure), from the extension's
       real origin, through api/_cors.js's own allow-list. Nothing
       reaches the real Vercel deployment.
     - The panel is then driven like a shopper would: open a product
       page, click Fynd, confirm the product, open the page's size guide,
       read it again, check the measurements, choose a saved garment,
       compare every size; then other pages, a page on another site, a
       page Chrome won't let any extension read, and signing out. Every
       request the panel makes and every console error is recorded.

   The shop pages (scripts/fixtures/fit-panel/shop/) are served from this
   machine. They are built like shop pages — structured product data,
   size buttons, a size guide that is a closed <dialog> with Body and
   Product tabs — but they are invented, and passing here says nothing
   about any real retailer.

   --live: opens each URL given, clicks Fynd, and reports what the panel
   read (the product, the tables and what each measures), with a
   screenshot. That is the check against real retailer pages; it needs
   network access to them, compares nothing, and makes no assertions
   about their content.

   Needs: Xvfb and ImageMagick's `import`, python3 with python-xlib and
   Pillow, openssl, Playwright, and Chromium (CHROME_PATH). Screenshots
   go to FYND_SHOTS (default: a temporary folder, printed at the end).
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync, spawnSync } = require('child_process');

process.env.AUTH_SECRET = 'real-chrome-secret-of-sufficient-length';
delete process.env.ALLOWED_ORIGIN;
delete process.env.RESEND_API_KEY;
delete process.env.POSTMARK_SERVER_TOKEN;
['warn', 'error'].forEach((level) => { const o = console[level]; console[level] = (...a) => { if (process.env.SHOW_LOGS) o(...a); }; });
const API_HOST = 'ai-clothes-application.vercel.app';
const API = `https://${API_HOST}`;
const HANDLERS = {
  '/api/auth': require('../api/auth'),
  '/api/fit-profile': require('../api/fit-profile'),
  '/api/size-recommendation': require('../api/size-recommendation')
};
const Schema = require('../assets/fit-profile-schema.js');
const users = require('../api/_users');
const fitProfiles = require('../api/_fit-profile');

const REPO = path.join(__dirname, '..');
const EXT = path.join(REPO, 'extension');
const SHOP = path.join(__dirname, 'fixtures/fit-panel/shop');
const XINPUT = path.join(__dirname, 'real-chrome/xinput.py');
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIVE = process.argv.includes('--live') ? process.argv.slice(process.argv.indexOf('--live') + 1) : null;
const SHOTS = process.env.FYND_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-real-chrome-'));
let chromium;
try { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')); } catch (err) { chromium = null; }

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err && err.stack || err).split('\n').slice(0, 10).join('\n        ')}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let chromeLog = '';
const chromeTail = () => chromeLog.split('\n').filter(Boolean).slice(-15).join('\n          ');

/* ---------- prerequisites: say what's missing, never pass silently ---------- */

function missing() {
  const need = [];
  if (!chromium) need.push('Playwright (npm i -g playwright, or PLAYWRIGHT_PATH)');
  if (!fs.existsSync(CHROME)) need.push(`Chromium at ${CHROME} (CHROME_PATH)`);
  for (const bin of ['Xvfb', 'import', 'openssl']) { try { execFileSync('which', [bin], { stdio: 'ignore' }); } catch (err) { need.push(bin); } }
  try { execFileSync('python3', ['-c', 'import Xlib.ext.xtest, PIL'], { stdio: 'ignore' }); } catch (err) { need.push('python3 with python-xlib and Pillow (pip install python-xlib pillow)'); }
  return need;
}

/* ---------- the machinery ---------- */

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

/* the extension's id: its manifest key, hashed, in a–p (the key pins it, wherever it is loaded from) */
const extensionId = () => {
  const key = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).key;
  return [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
};

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const file = u.pathname.startsWith('/shop/') ? path.join(SHOP, path.basename(u.pathname)) : null;
    if (!file || !fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/* Fynd's API under its production name, over TLS, on this machine */
function certificate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=fynd-real-chrome-test', '-addext', `subjectAltName=DNS:${API_HOST}`], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`openssl could not make a test certificate: ${made.error ? made.error.message : made.stderr}`);
  const pair = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return pair;
}
const apiHits = [];
function serveApi() {
  const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => resolve(d)); req.on('error', () => resolve('')); });
  const server = https.createServer(certificate(), async (req, res) => {
    const u = new URL(req.url, API);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (p) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(p)); return res; };
    /* the site's sign-in, standing in for account.html: the same /api/auth, same origin */
    if (u.pathname === '/__test/signin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>Sign in (test)</title><p id="s">signing in…</p><script>
        fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'signup', name: 'Shopper', email: ${JSON.stringify('EMAIL')}.replace('EMAIL', new URLSearchParams(location.search).get('email')), password: 'correct-horse-battery-staple', confirmPassword: 'correct-horse-battery-staple' }) })
          .then((r) => { document.getElementById('s').textContent = 'status ' + r.status; });
      </script>`);
    }
    const handler = HANDLERS[u.pathname];
    if (!handler) { res.statusCode = 404; return res.end('{}'); }
    const raw = req.method === 'POST' ? await readBody(req) : '';
    if (raw) { try { req.body = JSON.parse(raw); } catch (err) { req.body = raw; } }
    req.query = Object.fromEntries(u.searchParams);
    const hit = { method: req.method, path: u.pathname + u.search, origin: req.headers.origin || null, cookie: /fynd_session=/.test(req.headers.cookie || ''), body: req.body || null, status: null };
    apiHits.push(hit);
    try { await handler(req, res); } catch (err) { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
    if (!res.writableEnded) res.end();
    hit.status = res.statusCode;
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function xinput(display, ...args) {
  return execFileSync('python3', [XINPUT, display, ...args], { encoding: 'utf8' }).trim();
}

async function launch(display, port, apiPort) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-profile-'));
  const id = extensionId();
  /* pinned, so its button is on the toolbar as a shopper would pin it */
  fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { pinned_extensions: [id] } }));
  const debug = await freePort();
  const args = [
    '--no-sandbox', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    /* DisableLoadExtensionCommandLineSwitch: newer Chrome builds (137+)
       ignore --load-extension unless this is switched back off */
    '--disable-features=Translate,OptimizationHints,MediaRouter,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,DisableLoadExtensionCommandLineSwitch', '--password-store=basic',
    '--window-position=0,0', '--window-size=1400,900', `--remote-debugging-port=${debug}`,
    /* draw on the X display, never another backend */
    '--ozone-platform=x11',
    `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
    /* Fynd's production API name, answered here; the throwaway certificate accepted */
    `--host-resolver-rules=MAP ${API_HOST}:443 127.0.0.1:${apiPort}, MAP localhost:${port} 127.0.0.1:${port}`,
    '--ignore-certificate-errors',
    /* and never through a proxy: nothing here leaves this machine */
    '--no-proxy-server',
    'about:blank'
  ];
  const proc = spawn(CHROME, args, { env: Object.assign({}, process.env, { DISPLAY: display }), stdio: ['ignore', 'ignore', 'pipe'] });
  /* Chrome's own complaints, for when something goes wrong */
  proc.stderr.on('data', (d) => { chromeLog = (chromeLog + d).slice(-20000); });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${debug}/json/version`); if (r.ok) break; } catch (err) { /* starting */ }
    await sleep(250);
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
  /* the extension must actually be running before anything is clicked:
     its background worker is the proof */
  let targets = [];
  let loaded = false;
  for (let i = 0; i < 40 && !loaded; i++) {
    targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
    loaded = targets.some((t) => t.url === `chrome-extension://${id}/background.js`);
    if (!loaded) await sleep(250);
  }
  if (!loaded) {
    const version = await browser.version();
    proc.kill();
    console.log(`Chrome’s last output:\n          ${chromeTail()}`);
    throw new Error(`the extension did not load in ${version} (no chrome-extension://${id}/background.js worker; targets: ${targets.map((t) => `${t.type} ${t.url}`).join(', ') || 'none'})`);
  }
  /* and Chrome must have drawn its window: it maps the window seconds
     before it paints into it, and the extension's worker can be running
     long before that. Until then the display is one flat colour — CI saw
     "2 colours, (246, 245, 244)" and found no toolbar button to click. */
  try { xinput(display, 'painted'); } catch (err) {
    proc.kill();
    throw new Error(`Chrome never drew its window (${String(err.stdout || '').trim() || err.message})\n        Chrome’s last output:\n          ${chromeTail() || '(none)'}`);
  }
  return { proc, browser, id, profile, debug };
}

/* ---------- the run ---------- */

(async () => {
  const need = missing();
  if (need.length) {
    console.log(`Real-Chrome test NOT RUN — missing: ${need.join('; ')}`);
    process.exit(2);
  }
  const display = `:${90 + Math.floor(Math.random() * 9)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  /* Chrome must not start before the display accepts it */
  try { xinput(display, 'ready'); } catch (err) {
    console.log(`  FAIL  the virtual display ${display} starts\n        it never accepted a connection\n\n0 passed, 1 failed`);
    xvfb.kill();
    process.exit(1);
  }
  const server = await serve();
  const port = server.address().port;
  const local = (p) => `http://127.0.0.1:${port}${p}`;
  const otherSite = (p) => `http://localhost:${port}${p}`;
  let apiServer;
  try { apiServer = await serveApi(); } catch (err) {
    console.log(`  FAIL  Fynd’s API starts on this machine\n        ${err.message}\n\n0 passed, 1 failed`);
    xvfb.kill(); server.close();
    process.exit(1);
  }
  let launched;
  try { launched = await launch(display, port, apiServer.address().port); } catch (err) {
    console.log(`  FAIL  Chromium starts with the extension loaded\n        ${err.message}\n\n0 passed, 1 failed`);
    xvfb.kill(); server.close(); apiServer.close();
    process.exit(1);
  }
  const { proc, browser, id, debug } = launched;
  const context = browser.contexts()[0];
  const shot = (name) => { const file = path.join(SHOTS, `${name}.png`); xinput(display, 'shot', file); return file; };

  /* everything the panel asks the network for, and every console error */
  const requests = [];
  const errors = [];
  /* everything the panel says in its console, every level, with when:
     its note() logs each problem as console.warn('[Fynd]', step, …) */
  const panelLog = [];
  const watch = (page) => {
    page.on('console', (m) => panelLog.push(`${new Date().toISOString().slice(11, 23)} ${m.type()}: ${m.text()}`));
    page.on('request', (r) => { if (!/^(chrome-extension|data|blob):/.test(r.url())) requests.push(r.url()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  };
  /* Playwright doesn't surface a side panel that opens after it
     connected: once Chrome lists the panel's target, connect again */
  const panelUrl = `chrome-extension://${id}/sidepanel.html`;
  const panelPage = async () => {
    if (panel) return panel;
    for (let i = 0; i < 40; i++) {
      const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
      if (targets.some((t) => t.url.startsWith(panelUrl))) {
        const again = await chromium.connectOverCDP(`http://127.0.0.1:${debug}`);
        const p = again.contexts()[0].pages().find((x) => x.url().startsWith(panelUrl));
        if (p) return p;
      }
      await sleep(250);
    }
    const file = shot(`no-panel-${Date.now()}`);
    const targets = context.pages().map((x) => x.url()).concat(context.serviceWorkers().map((w) => `worker ${w.url()}`));
    throw new Error(`the side panel never opened (screen: ${file}; targets: ${targets.join(', ')})`);
  };
  let panel = null;
  let watched = false;
  /* when the extension last received a press on its toolbar button:
     background.js keeps it in session storage on every action.onClicked */
  const pressedAt = async () => (panel ? panel.evaluate(async () => {
    const got = await chrome.storage.session.get('fyndPressed');
    return got.fyndPressed && got.fyndPressed.at ? got.fyndPressed.at : 0;
  }) : 0);
  /* the shop tab has finished loading, as Chrome itself reports it (an
     error page too, which Playwright's goto doesn't wait for): a click
     made before a navigation commits grants access to the page being
     left, and the commit takes it away again */
  const tabSettled = async (label) => {
    if (!panel) { await shop.waitForLoadState('load').catch(() => {}); return; }
    const until = Date.now() + 15000;
    let calm = 0;
    let last = null;
    while (Date.now() < until) {
      last = await panel.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t ? t.status : null; });
      calm = last === 'complete' ? calm + 1 : 0;
      if (calm >= 2) return;
      await sleep(100);
    }
    throw new Error(`the shop tab never finished loading ${label || ''} (Chrome says: ${last})`);
  };
  const clickFynd = async () => {
    const before = await pressedAt();
    let at = 'none';
    try { at = xinput(display, 'click-fynd'); } catch (err) { at = String(err.stdout || '').trim() || 'none'; }
    if (at === 'none') {
      let screen = '';
      try { screen = xinput(display, 'describe'); } catch (err) { screen = `couldn’t describe it: ${err.message}`; }
      throw new Error(`Fynd’s toolbar button wasn’t found on screen (${screen}; saved: ${shot(`no-button-${Date.now()}`)})\n        Chrome’s last output:\n          ${chromeTail() || '(none)'}`);
    }
    panel = await panelPage();
    if (!watched) { watch(panel); watched = true; }
    /* the press reached Fynd: not a fixed wait, the extension's own record */
    const until = Date.now() + 10000;
    let received = await pressedAt();
    while (received <= before && Date.now() < until) { await sleep(100); received = await pressedAt(); }
    if (received <= before) throw new Error(`Fynd never received the toolbar click at ${at} (fyndPressed unchanged since ${before || 'never'})\n        ${await diagnose('click')}`);
    return at;
  };
  const text = (sel) => panel.locator(sel).innerText();
  const shop = context.pages()[0];

  /* What the panel and the page actually show, for a failure message:
     the panel's visible sections, its status and problem, the product it
     identified, its references (drawn, and in chrome.storage), the
     shop page's own state, the panel's console, and a screenshot. */
  const diagnose = async (label) => {
    const out = { at: new Date().toISOString() };
    try {
      out.panel = await panel.evaluate(async () => {
        const el = (id) => document.getElementById(id);
        const session = await chrome.storage.session.get(null).catch(() => ({}));
        return {
          view: document.body.dataset.view,
          problem: document.body.dataset.view === 'problem' ? { title: el('problem-title').textContent, details: el('problem-diag').textContent } : null,
          product: { name: el('p-name').value, brand: el('p-brand').value, type: el('p-type').value },
          charts: Array.from(document.querySelectorAll('#charts .fp-option')).map((x) => x.innerText.replace(/\s+/g, ' ').slice(0, 160)),
          reviewProblems: Array.from(document.querySelectorAll('#review-problems li')).map((x) => x.textContent),
          pressed: session.fyndPressed ? Object.assign({}, session.fyndPressed, { ageMs: Date.now() - session.fyndPressed.at }) : null,
          text: document.body.innerText.slice(0, 1200)
        };
      });
    } catch (err) { out.panel = `couldn’t read the panel: ${err.message}`; }
    try {
      out.shop = await shop.evaluate(() => ({ url: location.href, ready: document.readyState, guideOpen: Boolean(document.querySelector('dialog[open]')) }));
    } catch (err) { out.shop = `couldn’t read the page: ${err.message}`; }
    out.panelConsole = panelLog.slice(-25);
    try { out.screenshot = shot(`diagnose-${label}-${Date.now()}`); } catch (err) { out.screenshot = `none: ${err.message}`; }
    return JSON.stringify(out, null, 2).split('\n').join('\n        ');
  };

  console.log(`Chromium ${(await browser.version())}, headed on Xvfb ${display}; extension ${id} loaded unpacked from extension/ as shipped; Fynd’s API at ${API}, answered on this machine.`);

  const view = (v, ms) => panel.waitForFunction((want) => document.body.dataset.view === want, v, { timeout: ms || 10000 }).catch(async (err) => { throw new Error(`the panel never showed “${v}” (${err.message.split('\n')[0]})\n        ${await diagnose(v)}`); });
  const texts = (sel) => panel.$$eval(sel, (ns) => ns.map((x) => x.textContent.trim()));

  if (LIVE) {
    for (const url of LIVE) {
      console.log(`\n--- ${url}`);
      try {
        await shop.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(3000);
        await clickFynd();
        await panel.waitForFunction(() => !['start', 'reading'].includes(document.body.dataset.view), null, { timeout: 15000 });
        if (await panel.evaluate(() => document.body.dataset.view === 'product')) { await panel.selectOption('#p-type', (await panel.inputValue('#p-type')) || 'tshirts'); await panel.click('#confirm-product'); await sleep(500); }
        const report = await panel.evaluate(() => ({
          view: document.body.dataset.view,
          problem: document.body.dataset.view === 'problem' ? `${document.getElementById('problem-title').textContent} — ${document.getElementById('problem-text').textContent}` : null,
          product: { name: document.getElementById('p-name').value, brand: document.getElementById('p-brand').value, type: document.getElementById('p-type').value, found: document.getElementById('product-found').textContent, sizes: [...document.querySelectorAll('#p-sizes li')].map((x) => `${x.textContent}${x.dataset.available === 'false' ? ' (not on offer)' : ''}`) },
          measurements: document.getElementById('measure-text').textContent,
          tables: [...document.querySelectorAll('#charts .fp-option')].map((x) => x.innerText.replace(/\s+/g, ' ').slice(0, 200))
        }));
        console.log(JSON.stringify(report, null, 2));
        console.log(`screenshot: ${shot(`live-${LIVE.indexOf(url) + 1}`)}`);
      } catch (err) {
        console.log(`could not check: ${err.message}`);
        console.log(`screenshot: ${shot(`live-${LIVE.indexOf(url) + 1}-failed`)}`);
      }
    }
    console.log(`\nrequests from the panel: ${requests.length ? requests.join(', ') : 'none'}`);
    console.log(`console errors: ${errors.length ? errors.join(' | ') : 'none'}`);
    await browser.close().catch(() => {});
    proc.kill(); xvfb.kill(); server.close(); apiServer.close();
    return;
  }

  /* the shopper's saved T-shirt (invented), measured flat in inches, each method stated */
  const TEE = { unit: 'in', chestWidth: 22, bodyLength: 28.75, shoulderWidth: 18.75, sleeveLength: 8.25 };
  const METHODS = { registry: 1, chestWidth: 'flat-width-armpit-to-armpit', bodyLength: 'high-point-shoulder-to-hem', shoulderWidth: 'seam-to-seam', sleeveLength: 'shoulder-seam-to-cuff' };

  console.log('\nsigning in to Fynd, as on the site');

  await test('the shopper signs in on Fynd’s own origin: the session cookie is set in this Chrome, and a T-shirt is saved on their fit profile', async () => {
    const email = 'real.chrome.shopper@example.test';
    await shop.goto(`${API}/__test/signin?email=${encodeURIComponent(email)}`);
    await shop.waitForFunction(() => /^status /.test(document.getElementById('s').textContent), null, { timeout: 10000 });
    assert.strictEqual(await shop.textContent('#s'), 'status 200');
    const cookies = await context.cookies(API);
    const session = cookies.find((c) => c.name === 'fynd_session');
    assert.ok(session, `no session cookie: ${cookies.map((c) => c.name).join(', ')}`);
    assert.deepStrictEqual([session.sameSite, session.secure, session.httpOnly], ['Lax', true, true]);
    const user = await users.byEmail(email);
    const p = Schema.empty();
    p.garments = { tshirts: Object.assign(Schema.emptyGarment('tshirts'), { favorite: 'perfect', anchor: { brand: 'Owned Brand', size: 'L', measurements: TEE, methods: METHODS } }) };
    await fitProfiles.save(user.id, p);
  });

  console.log('\nthe workflow, with a real toolbar click');

  await test('a product page, a real click on Fynd’s toolbar button: the side panel opens beside the page and reads the product', async () => {
    await shop.goto(local('/shop/tee.html'));
    await shop.bringToFront();
    shot('00-shop-before-click');
    await clickFynd();
    await view('product');
    assert.strictEqual(await panel.inputValue('#p-name'), 'Everyday Crew Tee');
    assert.strictEqual(await panel.inputValue('#p-brand'), 'Northwind');
    assert.strictEqual(await panel.inputValue('#p-type'), 'tshirts');
    assert.deepStrictEqual(await texts('#p-sizes li'), ['XS', 'S', 'M', 'L', 'XL', 'XXL']);
    /* one click, straight to the panel: no popup in between */
    const targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
    assert.ok(!targets.some((t) => /popup\.html/.test(t.url)), `a popup opened: ${targets.map((t) => t.url).join(', ')}`);
    shot('01-panel-product');
  });

  await test('the size guide is closed: no chart found, and the panel says to open it on the page', async () => {
    await panel.click('#confirm-product');
    await view('measure');
    assert.match(await panel.textContent('#measure-text'), /No size chart found on this page\. If the shop keeps its chart in a size guide, open the guide on the page and read it again\./);
    shot('02-guide-closed');
  });

  await test('the shopper opens the size guide and reads the page again: the product table is offered, the body table shown but not choosable', async () => {
    await shop.click('#open-guide');
    await panel.click('#measure-reread');
    await view('product');
    await panel.click('#confirm-product');
    await view('measure');
    const options = await panel.$$eval('#charts .fp-option', (ns) => ns.map((x) => ({ kind: x.querySelector('.fp-kind').dataset.kind, disabled: x.querySelector('input').disabled, checked: x.querySelector('input').checked })));
    assert.deepStrictEqual(options.map((o) => o.kind).sort(), ['body', 'finished-garment']);
    assert.ok(options.every((o) => (o.kind === 'body') === o.disabled), JSON.stringify(options));
    assert.ok(options.find((o) => o.kind === 'finished-garment').checked);
    shot('03-guide-read');
  });

  await test('the measurements to check: inches, each method read from the headings, nothing left to fix', async () => {
    await panel.click('#use-chart');
    await view('review');
    assert.strictEqual(await panel.inputValue('#review-unit'), 'in');
    const dims = await panel.$$eval('select[data-role="dim"]', (ns) => ns.map((s) => s.value));
    const how = await panel.$$eval('select[data-role="method"]', (ns) => ns.map((s) => s.value));
    assert.deepStrictEqual(dims, ['chestWidth', 'bodyLength', 'sleeveLength', 'shoulderWidth']);
    assert.deepStrictEqual(how, [METHODS.chestWidth, METHODS.bodyLength, METHODS.sleeveLength, METHODS.shoulderWidth]);
    assert.deepStrictEqual(await texts('#review-problems li'), []);
    shot('04-review');
  });

  await test('the shopper’s saved garment, read from Fynd with their own session; one request compares every size; the server’s decision is shown as it is', async () => {
    const before = apiHits.length;
    await panel.click('#to-reference');
    await panel.waitForSelector('input[name="reference"][value="tshirts"]', { timeout: 10000 }).catch(async (err) => { throw new Error(`no saved garment listed: ${err.message.split('\n')[0]}\n        ${await diagnose('reference')}`); });
    assert.match(await panel.$eval('input[name="reference"][value="tshirts"]', (r) => r.closest('label').textContent), /Owned Brand t-shirt, size L/);
    shot('05-garment');
    await panel.click('#compare');
    await view('results');
    assert.strictEqual(await panel.textContent('#result-size'), 'L');
    assert.strictEqual(await panel.textContent('#result-title'), 'The size that meets Fynd’s comparison criteria');
    assert.deepStrictEqual(await panel.$$eval('#result-table tr[data-size]', (ns) => ns.map((r) => r.dataset.size)), ['XS', 'S', 'M', 'L', 'XL', 'XXL']);
    assert.match(await panel.textContent('#result-source'), /read from 127\.0\.0\.1|read from the page/);
    assert.match(await panel.textContent('#result-source'), /Not verified by Fynd/);
    const mine = apiHits.slice(before).filter((h) => h.method !== 'OPTIONS');
    assert.deepStrictEqual(mine.map((h) => [h.method, h.path, h.status]), [['GET', '/api/fit-profile', 200], ['POST', '/api/size-recommendation?compare=1&candidate=1', 200]]);
    assert.ok(mine.every((h) => h.cookie), 'the session cookie went with both requests');
    assert.strictEqual(mine[1].origin, `chrome-extension://${id}`);
    assert.strictEqual(mine[1].body.chart.sizes.length, 6);
    shot('06-results');
  });

  await test('another page on the same site: Read another page needs no second click — and a body chart is never offered as the garment’s', async () => {
    await shop.goto(local('/shop/body-only.html'));
    await tabSettled('body-only');
    await panel.click('#result-reread');
    await view('product');
    assert.strictEqual(await panel.inputValue('#p-name'), 'Relaxed Tee');
    await panel.click('#confirm-product');
    await view('measure');
    assert.strictEqual(await panel.isHidden('#use-chart'), true);
    assert.match(await panel.textContent('#measure-text'), /measures the body each size is for, not the garment/);
    shot('07-body-only');
  });

  await test('a page on another site: access doesn’t carry over, and the panel says to click Fynd — with technical details kept', async () => {
    await shop.goto(otherSite('/shop/no-chart.html'));
    await tabSettled('another site');
    await panel.click('#measure-reread');
    await view('problem');
    assert.strictEqual(await panel.textContent('#problem-title'), 'Click Fynd to read this page');
    assert.match(await panel.textContent('#problem-diag'), /"kind": "no-access"/);
    shot('08-other-site');
  });

  await test('a click on Fynd there: the product read, its sizes listed, no chart — and the measurements can be entered by hand', async () => {
    await clickFynd();
    await view('product');
    assert.strictEqual(await panel.inputValue('#p-name'), 'Pocket Tee');
    await panel.click('#confirm-product');
    await view('measure');
    assert.match(await panel.textContent('#measure-text'), /No size chart found/);
    assert.strictEqual(await panel.isHidden('#manual-entry'), false);
    shot('09-no-chart');
  });

  await test('a page Chrome won’t let any extension read: an explanation, not an empty panel', async () => {
    await shop.goto('chrome://version');
    await tabSettled('chrome://version');
    await clickFynd();
    await view('problem');
    assert.strictEqual(await panel.textContent('#problem-title'), 'Chrome doesn’t let extensions read this page');
    shot('10-restricted');
  });

  await test('signed out of Fynd: the panel says to sign in, with a link to Fynd — never a garment made up', async () => {
    await context.clearCookies();
    await shop.goto(local('/shop/tee.html'));
    await tabSettled('tee again');
    await clickFynd();
    await view('product');
    await panel.click('#confirm-product');
    await view('measure');
    await shop.click('#open-guide');
    await panel.click('#measure-reread');
    await view('product');
    await panel.click('#confirm-product');
    await view('measure');
    await panel.click('#use-chart');
    await view('review');
    await panel.click('#to-reference');
    await panel.waitForFunction(() => /Sign in to Fynd/.test(document.getElementById('reference-text').textContent), null, { timeout: 10000 });
    assert.strictEqual(await panel.getAttribute('#reference-links a', 'href'), `${API}/account.html`);
    assert.strictEqual(await panel.$$eval('input[name="reference"]', (ns) => ns.length), 0);
    shot('11-signed-out');
  });

  await test('the panel asked nothing of any host but Fynd’s API, and nothing failed in the console', async () => {
    const off = requests.filter((u) => !u.startsWith(`${API}/api/fit-profile`) && !u.startsWith(`${API}/api/size-recommendation?compare=1&candidate=1`));
    assert.deepStrictEqual(off, [], `the panel made other requests: ${off.join(', ')}`);
    assert.ok(requests.length >= 3);
    assert.deepStrictEqual(errors.filter((e) => !/Receiving end does not exist|401 \(Unauthorized\)/.test(e)), []);
  });

  await browser.close().catch(() => {});
  proc.kill();
  xvfb.kill();
  server.close();
  apiServer.close();
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log('These pages are invented and served from this machine, and Fynd’s API answers here under its production name: this shows the extension’s own workflow in a real Chrome, not compatibility with any real retailer or the live deployment.');
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
