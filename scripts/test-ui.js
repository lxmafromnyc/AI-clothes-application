#!/usr/bin/env node
/* =========================================================
   Fynd — interface tests

   Drives the real page in a real browser: dragging files onto the
   search card, choosing them with the button, removing them, and
   submitting. The API is stubbed at the network boundary so the test is
   about the interface, not about a provider.

   Usage: node scripts/test-ui.js
   Needs Chromium; skips with a clear message if it is not present.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const REPO = path.join(__dirname, '..');
const PORT = 8899;
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — skipping interface tests.');
  process.exit(0);
}

/* the page, plus stub endpoints, on one origin so no CORS is involved */
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  /* the landing page's demo video, its poster and its captions */
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.vtt': 'text/vtt'
};
const searchRequests = [];
const interpretRequests = [];
const billingRequests = [];

/* The photo the stubbed /api/search hands back. Off-origin by default,
   which the page under test aborts, so the tests that are about a photo
   FAILING keep failing it. A test about a photo that loads points this
   at a real file on this origin — the same way a live provider points
   it at a real file on theirs. */
const DEAD_PROVIDER_PHOTO = 'https://img.example/a.jpg';
let searchPhoto = DEAD_PROVIDER_PHOTO;

/* What the stub /api/account answers with. Shaped exactly like the real
   endpoint's reply, because the whole point of the billing interface is
   that it renders what the server said and decides nothing itself — so
   the test drives it the only way anything can: by changing the
   server's answer. */
/* the limits come from the server's own plan table, so the stub can
   never promise an allowance the server does not give */
const PLAN_LIMITS = Object.fromEntries(Object.values(require('../api/_plans').PLANS).map((plan) => [plan.id, plan.limits]));

const planCatalogue = () => [
  { id: 'free', name: 'Free', amount: 0, interval: null, period: 'day', limits: PLAN_LIMITS.free, tagline: 'Try it out, every day.', features: [], purchasable: false },
  { id: 'pro', name: 'Pro', amount: 14.99, interval: 'month', period: 'month', limits: PLAN_LIMITS.pro, tagline: 'For shopping properly.', features: [], purchasable: true },
  { id: 'max', name: 'Max', amount: 39.99, interval: 'month', period: 'month', limits: PLAN_LIMITS.max, tagline: 'For searching all day.', features: [], purchasable: true }
];

const accountReply = (over) => {
  const planId = (over && over.planId) || 'free';
  const plan = planCatalogue().find((p) => p.id === planId);
  const period = planId === 'free' ? 'day' : 'month';
  const usageOf = (metric, used) => ({
    metric, plan: planId, period,
    limit: PLAN_LIMITS[planId][metric], used,
    remaining: Math.max(0, PLAN_LIMITS[planId][metric] - used),
    resetsAt: '2099-01-01T00:00:00.000Z'
  });
  return Object.assign({
    signedIn: false,
    user: null,
    plan: Object.assign({}, plan, { limits: PLAN_LIMITS[planId] }),
    plans: planCatalogue(),
    subscription: null,
    usage: { aiTokens: usageOf('aiTokens', 1200), searches: usageOf('searches', over && Number.isInteger(over.searchesUsed) ? over.searchesUsed : 1) },
    billing: { enabled: true, testMode: true, webhookConfigured: true, portal: false },
    accounts: { enabled: true },
    storage: { durable: true }
  }, (over && over.extra) || {});
};

let accountState = accountReply({});

/* What the stub /api/fit-profile answers: the signed-in shopper's own
   profile, or none. Only the design audits below read it. */
const fitProfileReply = (profile) => ({ profile: profile || null, storage: { durable: true } });
let fitProfileState = fitProfileReply(null);

/* What the search-progress tests do to the two endpoints. Each may HOLD
   its reply until the test releases it — so a stage can be looked at
   while the request behind it is really still open, rather than caught
   on a timer — answer with a reply of its own, fail with a status, or
   drop the connection. Unset, both answer at once, as they always have.
   `log` records when each request arrived and when its reply was sent. */
const stubs = { interpret: null, search: null, account: null, charge: false, log: [] };

/* The server's own meter, as /api/search keeps it: an answered search is
   counted against the account /api/account then reports. On only when a
   test turns it on, so every other test sees the account it set up. */
const chargeSearch = () => {
  const searches = accountState.usage.searches;
  searches.used += 1;
  searches.remaining = Math.max(0, searches.limit - searches.used);
};
const deferred = () => { let release; const held = new Promise((r) => { release = r; }); return { held, release }; };

/* the catalogue, as Discover shelves it, and what its photos are */
const audit = require('./audit-catalog');
const CATALOGUE_SOURCE = fs.readFileSync(path.join(REPO, 'assets', 'catalog.js'), 'utf8');
const CATALOGUE = audit.readCatalogue(CATALOGUE_SOURCE);
const CATALOGUE_PHOTOS = new Set(CATALOGUE.map((r) => r.imageUrl).filter(Boolean));
const STAND_IN_PHOTO = fs.readFileSync(path.join(REPO, 'assets', 'demo', 'fynd-demo-mobile-poster.jpg'));
const WIDE_PHOTO = fs.readFileSync(path.join(REPO, 'assets', 'demo', 'fynd-demo-poster.jpg'));
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/* the catalogue source with one row's field set to something else */
const withRowField = (id, field, value) => {
  const start = CATALOGUE_SOURCE.indexOf(`id: '${id}',`);
  const end = CATALOGUE_SOURCE.indexOf('\n  }', start);
  const block = CATALOGUE_SOURCE.slice(start, end)
    .replace(new RegExp(`(\\n\\s*)${field}: [^\\n]*,`), `$1${field}: ${JSON.stringify(value)},`);
  return CATALOGUE_SOURCE.slice(0, start) + block + CATALOGUE_SOURCE.slice(end);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/fit-profile') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(fitProfileState));
  }

  if (['/api/account', '/api/auth', '/api/checkout', '/api/portal'].includes(url.pathname)) {
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', async () => {
      const parsed = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
      billingRequests.push({ path: url.pathname, body: parsed });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/checkout') return res.end(JSON.stringify({ url: 'https://checkout.stripe.test/session', plan: parsed.plan }));
      if (url.pathname === '/api/portal') return res.end(JSON.stringify({ url: 'https://billing.stripe.test/portal' }));
      /* /api/account may be held, fail with a status, or drop, like the
         two search endpoints below */
      const stub = url.pathname === '/api/account' ? stubs.account : null;
      if (url.pathname === '/api/account') stubs.log.push({ path: url.pathname, event: 'request', at: Date.now() });
      if (stub && stub.hold) await stub.hold;
      if (url.pathname === '/api/account') stubs.log.push({ path: url.pathname, event: 'reply', at: Date.now() });
      if (stub && stub.drop) return res.destroy();
      if (stub && stub.status) { res.statusCode = stub.status; return res.end(JSON.stringify({ error: 'stubbed failure' })); }
      return res.end(JSON.stringify(accountState));
    });
  }

  if (url.pathname === '/api/interpret' || url.pathname === '/api/search') {
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
      res.setHeader('Content-Type', 'application/json');
      const stub = url.pathname === '/api/interpret' ? stubs.interpret : stubs.search;
      stubs.log.push({ path: url.pathname, event: 'request', at: Date.now() });
      if (url.pathname === '/api/search') searchRequests.push(parsed);
      const answer = async () => {
        if (stub && stub.hold) await stub.hold;
        stubs.log.push({ path: url.pathname, event: 'reply', at: Date.now() });
        if (stub && stub.drop) return res.destroy();
        /* a failure answers with its own body when the test gives one —
           the provider timeout names its stage — and a plain error if not */
        if (stub && stub.status) { res.statusCode = stub.status; return res.end(JSON.stringify(stub.reply || { error: 'stubbed failure' })); }
        /* an answered search is what the server counts */
        if (url.pathname === '/api/search' && stubs.charge) chargeSearch();
        if (stub && stub.reply) return res.end(JSON.stringify(stub.reply));
        return null;
      };
      if (url.pathname === '/api/interpret') {
        interpretRequests.push(parsed);
        return answer().then((done) => done || res.end(JSON.stringify({ source: 'openai', query: 'q', preferences: {
          categories: ['hoodie'], colors: ['Black'], fits: [], occasions: [], brands: [], styles: [],
          keywords: [], maxPrice: null, minPrice: null, season: null, gender: null } })));
      }
      return answer().then((done) => done || res.end(JSON.stringify({ source: 'openwebninja', products: [{
        id: '1', name: 'Champion Hoodie', price: 68, currency: 'USD',
        imageUrl: searchPhoto, productUrl: 'https://www.nordstrom.com/s/hoodie/1',
        retailer: 'Nordstrom', category: '', colors: [], sizes: []
      }], returned: 1, rejected: {}, attachments: { received: (parsed.attachments || []).length, used: 0 } })));
    });
  }

  /* /__slow/<ms>/<path> answers <path> that much later: a photo that is
     still on its way when the card it belongs to arrives */
  const slow = /^\/__slow\/(\d+)(\/.+)$/.exec(url.pathname);
  const file = path.join(REPO, (slow ? slow[2] : url.pathname).replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end('not found');
  }
  const send = () => {
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  };
  return slow ? setTimeout(send, Number(slow[1])) : send();
});

let passed = 0;
const failures = [];

async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message}`); }
}

/* A drop cannot be synthesised from outside the page — DataTransfer is
   only constructible in the document — so files are built in the page
   and dispatched as a real DragEvent. */
/* A drop cannot be synthesised from outside the page — DataTransfer is
   only constructible in the document — so the files are built inside the
   page and dispatched as real DragEvents. */
const dropInPage = ({ selector, files }) => {
  const dt = new DataTransfer();
  for (const f of files) {
    dt.items.add(new File([new Uint8Array(f.size || 8)], f.name, { type: f.type }));
  }
  const el = document.querySelector(selector);
  el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
};

const dragOverOnly = ({ selector }) => {
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array(4)], 'x.png', { type: 'image/png' }));
  const el = document.querySelector(selector);
  el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
};

/* Type styling is a rule about the whole interface, not about a handful
   of selectors, so this walks the rendered document instead of checking a
   fixed list: markup added later is covered the day it lands.

   The rule the interface holds to: every piece of type is set in one of
   the palette's declared inks, and every piece of type is legible on the
   ground it actually sits on.

   The inks are read from the stylesheet's own custom properties rather
   than hard-coded here, so changing the palette changes what the test
   allows — but a colour that was never named as an ink, or a hue applied
   straight to a rule, still fails. None of the gradient-filled, clipped
   or glowing treatments the interface used to carry may come back
   either. */
const INK_TOKENS = [
  '--color-text', '--color-text-2', '--color-text-muted', '--color-text-invert',
  '--color-text-on-primary', '--color-primary', '--color-primary-ink',
  '--color-accent-ink', '--color-success-ink', '--color-warning-ink'
];

/* Resolves a token to the same rgb() string getComputedStyle reports, by
   letting the browser do the conversion rather than parsing hex here. */
const resolveInks = (page) => page.evaluate((tokens) => {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const out = {};
  for (const token of tokens) {
    probe.style.color = `var(${token})`;
    out[getComputedStyle(probe).color] = token;
  }
  probe.remove();
  return out;
}, INK_TOKENS);

/* A fade still running is measured where it ends, not halfway: the audit
   waits for every finite animation and transition on the page to finish.
   Endless ones — a pulsing placeholder — are what they are at any moment. */
const finishedMoving = (page) => page.waitForFunction(() => document.getAnimations()
  .every((a) => a.playState !== 'running' || !a.effect || a.effect.getTiming().iterations === Infinity));

const textStyleProblems = async (page, inks) => { await finishedMoving(page); return page.evaluate((allowed) => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const problems = [];

  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const channels = (value) => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value || '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };

  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  /* the nearest ancestor that actually paints something behind the text */
  const groundOf = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(cs.backgroundColor);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) return channels(cs.backgroundColor);
      node = node.parentElement;
    }
    return [255, 255, 255];
  };

  /* type drawn at less than full opacity composites onto its ground, and
     the compositing happens in sRGB — mixing in linear light would report
     a contrast the eye never gets */
  const opacityOf = (el) => {
    let value = 1;
    let node = el;
    while (node && node !== document.body) {
      value *= Number(getComputedStyle(node).opacity);
      node = node.parentElement;
    }
    return value;
  };

  const contrast = (fg, bg, opacity) => {
    const front = opacity < 1 ? fg.map((v, i) => Math.round(v * opacity + bg[i] * (1 - opacity))) : fg;
    const [hi, lo] = [luminance(front), luminance(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  };

  for (const el of document.querySelectorAll('body *')) {
    if (SKIP.has(el.tagName)) continue;
    const rendersText = Array.from(el.childNodes)
      .some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!rendersText) continue;

    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const where = `${label(el)} ("${el.textContent.trim().slice(0, 32)}")`;

    if (!allowed[cs.color]) problems.push(`${where} is ${cs.color}, which is not one of the palette inks`);
    if (cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color) {
      problems.push(`${where} fills its glyphs with ${cs.webkitTextFillColor}`);
    }
    if ((cs.webkitBackgroundClip || cs.backgroundClip) === 'text') {
      problems.push(`${where} clips a background to its text`);
    }
    if (/gradient/.test(cs.backgroundImage)) problems.push(`${where} sits on a gradient`);
    if (cs.textShadow !== 'none') problems.push(`${where} has a text shadow: ${cs.textShadow}`);

    const fg = channels(cs.color);
    if (fg && el.getBoundingClientRect().width) {
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      const ratio = contrast(fg, groundOf(el), opacityOf(el));
      if (ratio < need) problems.push(`${where} is ${ratio.toFixed(2)}:1 on its ground, under ${need}`);
    }
  }
  return problems;
}, inks); };

/* Placeholders are not text nodes, so they are checked on their own. */
const placeholderColours = (page) => page.$$eval('[placeholder]', (ns) => ns.map((n) => {
  const cs = getComputedStyle(n, '::placeholder');
  return { selector: n.id ? `#${n.id}` : n.tagName.toLowerCase(), color: cs.color };
}));

const chips = (page) => page.$$eval('.attachment', (ns) => ns.map((n) => ({
  name: n.querySelector('.attachment-name').textContent,
  meta: n.querySelector('.attachment-size').textContent,
  hasThumb: Boolean(n.querySelector('img.attachment-thumb')),
  kindLabel: n.querySelector('.attachment-kind') ? n.querySelector('.attachment-kind').textContent : null
})));

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME });
  } catch (err) {
    console.log('Chromium could not launch here — skipping interface tests.');
    server.close();
    process.exit(0);
  }

  /* `photos` stands in for the retailers' image hosts, which this
     environment cannot reach. Each catalogue photo URL is answered with
     a real JPEG from this repository — what a working CDN does — unless
     the test names it in `fail` (the request errors) or `stub` (a 1×1
     image comes back, the shape of a tracking pixel or a "no image"
     placeholder). Everything else off this origin is still cut. */
  const openPage = async (file, options) => {
    const opts = options || {};
    const page = await browser.newPage();
    if (opts.viewport) await page.setViewportSize(opts.viewport);
    /* apiOverride: false leaves the page to find its API the way a real
       visitor's page does — from its own origin and its meta tag */
    if (opts.apiOverride !== false) {
      await page.addInitScript(() => {
        window.FINDWEAR_API = 'http://127.0.0.1:8899/api/interpret';
        window.FINDWEAR_SEARCH_API = 'http://127.0.0.1:8899/api/search';
      });
    }
    /* Anything off this origin is unreachable in this environment, and a
       stylesheet still loading blocks the scripts under it from running.
       Cutting external requests makes the page deterministic. */
    await page.route((url) => !String(url).includes('127.0.0.1'), (route) => {
      const url = route.request().url();
      /* a test may answer another origin itself (the meta tag's deployment) */
      if (opts.offOrigin && opts.offOrigin(route, url)) return undefined;
      if (opts.photos && CATALOGUE_PHOTOS.has(url)) {
        if ((opts.fail || []).includes(url)) return route.abort();
        if ((opts.stub || []).includes(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
        if ((opts.wide || []).includes(url)) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: WIDE_PHOTO });
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: STAND_IN_PHOTO });
      }
      return route.abort();
    });
    if (opts.catalogue) {
      /* a catalogue the test has altered, served in place of the real one */
      await page.route(/\/assets\/catalog\.js$/, (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript', body: opts.catalogue }));
    }
    await page.goto(`http://127.0.0.1:${PORT}/${file}`, { waitUntil: 'domcontentloaded' });
    return page;
  };

  const open = async () => {
    const page = await openPage('find-clothes.html');
    /* interact only once the control is actually wired */
    await page.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
    return page;
  };

  console.log('\ndrag and drop');

  await test('dragging a file over the card shows a drop state', async () => {
    const page = await open();
    assert.strictEqual(await page.$eval('#ask-form', (n) => n.classList.contains('is-dragover')), false);
    await page.evaluate(dragOverOnly, { selector: '#ask-form' });
    assert.strictEqual(await page.$eval('#ask-form', (n) => n.classList.contains('is-dragover')), true);
    assert.ok(await page.$eval('.ask-dropveil', (n) => getComputedStyle(n).display !== 'none'), 'the veil must be visible');
    await page.close();
  });

  await test('leaving without dropping clears the drop state', async () => {
    const page = await open();
    await page.evaluate(dragOverOnly, { selector: '#ask-form' });
    await page.evaluate(() => document.querySelector('#ask-form').dispatchEvent(new DragEvent('dragleave', { bubbles: true })));
    assert.strictEqual(await page.$eval('#ask-form', (n) => n.classList.contains('is-dragover')), false);
    await page.close();
  });

  await test('dropping an image attaches it and clears the drop state', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'hoodie.jpg', type: 'image/jpeg', size: 2048 }] });
    const list = await chips(page);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'hoodie.jpg');
    assert.strictEqual(await page.$eval('#ask-form', (n) => n.classList.contains('is-dragover')), false);
    await page.close();
  });

  await test('an image gets a thumbnail; a PDF gets its type instead', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [
      { name: 'hoodie.jpg', type: 'image/jpeg', size: 2048 },
      { name: 'sizing.pdf', type: 'application/pdf', size: 4096 }
    ] });
    const list = await chips(page);
    assert.strictEqual(list.length, 2);
    assert.ok(list[0].hasThumb, 'the image needs a thumbnail');
    assert.ok(!list[1].hasThumb, 'a PDF must not be rendered as a picture');
    assert.strictEqual(list[1].kindLabel, 'PDF');
    assert.ok(/PDF/.test(list[1].meta) && /KB/.test(list[1].meta), list[1].meta);
    await page.close();
  });

  await test('several files at once all attach', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [
      { name: 'a.png', type: 'image/png', size: 1024 },
      { name: 'b.webp', type: 'image/webp', size: 1024 },
      { name: 'c.gif', type: 'image/gif', size: 1024 },
      { name: 'd.pdf', type: 'application/pdf', size: 1024 }
    ] });
    assert.strictEqual((await chips(page)).length, 4);
    await page.close();
  });

  console.log('\nthe file picker');

  await test('choosing files with the button attaches them', async () => {
    const page = await open();
    await page.setInputFiles('#ask-files', [
      { name: 'picked.png', mimeType: 'image/png', buffer: Buffer.alloc(1024) },
      { name: 'picked.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2048) }
    ]);
    const list = await chips(page);
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual(list.map((c) => c.name), ['picked.png', 'picked.pdf']);
    await page.close();
  });

  await test('the picker accepts multiple files and offers the right types', async () => {
    const page = await open();
    assert.ok(await page.$eval('#ask-files', (n) => n.hasAttribute('multiple')));
    const accept = await page.$eval('#ask-files', (n) => n.getAttribute('accept'));
    ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'].forEach((t) => {
      assert.ok(accept.includes(t), `accept should offer ${t}`);
    });
    await page.close();
  });

  await test('picking the same file twice does not duplicate it', async () => {
    const page = await open();
    /* a real file on disk, so its modified time is stable — a buffer gets
       a fresh timestamp each time and is genuinely a different file */
    const onDisk = path.join(os.tmpdir(), 'findwear-same.png');
    fs.writeFileSync(onDisk, Buffer.alloc(512));
    await page.setInputFiles('#ask-files', [onDisk]);
    await page.setInputFiles('#ask-files', [onDisk]);
    assert.strictEqual((await chips(page)).length, 1);
    fs.unlinkSync(onDisk);
    await page.close();
  });

  console.log('\nrefusals');

  await test('an unsupported type is refused with a reason, and nothing is attached', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'movie.mp4', type: 'video/mp4', size: 2048 }] });
    assert.strictEqual((await chips(page)).length, 0);
    const message = await page.$eval('#attachment-error', (n) => n.textContent.trim());
    assert.ok(/movie\.mp4/.test(message) && /does not take/.test(message), message);
    await page.close();
  });

  await test('the good files in a mixed drop are kept', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [
      { name: 'keep.png', type: 'image/png', size: 1024 },
      { name: 'drop.exe', type: 'application/x-msdownload', size: 1024 }
    ] });
    const list = await chips(page);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, 'keep.png');
    await page.close();
  });

  await test('a file over the size limit is refused', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'huge.png', type: 'image/png', size: 11 * 1024 * 1024 }] });
    assert.strictEqual((await chips(page)).length, 0);
    assert.ok(/limit/.test(await page.$eval('#attachment-error', (n) => n.textContent)));
    await page.close();
  });

  console.log('\nremoval');

  await test('removing a chip removes that file and leaves the rest', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [
      { name: 'first.png', type: 'image/png', size: 1024 },
      { name: 'second.pdf', type: 'application/pdf', size: 1024 },
      { name: 'third.png', type: 'image/png', size: 1024 }
    ] });
    await page.click('.attachment:nth-child(2) .attachment-remove');
    const list = await chips(page);
    assert.deepStrictEqual(list.map((c) => c.name), ['first.png', 'third.png']);
    await page.close();
  });

  await test('removing the last file hides the list and the note', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'only.png', type: 'image/png', size: 1024 }] });
    assert.strictEqual(await page.$eval('#attachment-note', (n) => n.hidden), false);
    await page.click('.attachment-remove');
    assert.strictEqual((await chips(page)).length, 0);
    assert.strictEqual(await page.$eval('#attachments', (n) => n.hidden), true);
    assert.strictEqual(await page.$eval('#attachment-note', (n) => n.hidden), true);
    await page.close();
  });

  await test('"Start over" clears attachments as well as the text', async () => {
    const page = await open();
    await page.fill('#ask', 'black hoodie');
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'a.png', type: 'image/png', size: 1024 }] });
    await page.click('#reset-form');
    assert.strictEqual((await chips(page)).length, 0);
    assert.strictEqual(await page.$eval('#ask', (n) => n.value), '');
    await page.close();
  });

  console.log('\nsubmission');

  await test('nothing is sent until the search is submitted', async () => {
    searchRequests.length = 0;
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'held.png', type: 'image/png', size: 1024 }] });
    await page.waitForTimeout(300);
    assert.strictEqual(searchRequests.length, 0, 'attaching a file must not trigger a request');
    await page.close();
  });

  await test('submitting sends a manifest of names, types and sizes — and no content', async () => {
    searchRequests.length = 0;
    const page = await open();
    await page.fill('#ask', 'black oversized hoodie');
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [
      { name: 'inspo.jpg', type: 'image/jpeg', size: 2048 },
      { name: 'sizing.pdf', type: 'application/pdf', size: 4096 }
    ] });
    await page.click('button[type=submit]');
    await page.waitForSelector('.item-card', { timeout: 10000 });

    assert.strictEqual(searchRequests.length, 1);
    const sent = searchRequests[0].attachments;
    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(sent[0], { name: 'inspo.jpg', type: 'image/jpeg', size: 2048, kind: 'image' });
    assert.strictEqual(sent[1].kind, 'document');
    assert.ok(!/base64|data:|content/i.test(JSON.stringify(searchRequests[0])), 'no file content may be sent');
    await page.close();
  });

  await test('the text search still works with no attachments at all', async () => {
    searchRequests.length = 0;
    const page = await open();
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.item-card', { timeout: 10000 });
    assert.strictEqual(searchRequests.length, 1);
    assert.deepStrictEqual(searchRequests[0].attachments, []);
    assert.strictEqual(await page.$eval('.results-head h2', (n) => n.textContent.trim()), '1 piece found');
    await page.close();
  });

  await test('an empty query is still refused, attachments or not', async () => {
    searchRequests.length = 0;
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'a.png', type: 'image/png', size: 1024 }] });
    await page.click('button[type=submit]');
    await page.waitForTimeout(300);
    assert.strictEqual(searchRequests.length, 0, 'a file is not a substitute for saying what you want');
    assert.ok(await page.$eval('#form-error', (n) => n.classList.contains('show')));
    await page.close();
  });

  await test('the page never claims an attachment shaped the results', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [{ name: 'a.png', type: 'image/png', size: 1024 }] });
    const note = await page.$eval('#attachment-note', (n) => n.textContent.trim());
    assert.ok(/does not read attachments yet/i.test(note), note);
    assert.ok(/do not change your results/i.test(note), note);
    await page.close();
  });

  console.log('\na search in progress');

  /* The page's own reader, run here, is what the stubbed interpreter
     answers with: the preferences — concepts and all — a real reading of
     that request produces. */
  require(path.join(REPO, 'assets', 'interpret.js'));
  const reader = globalThis.Interpreter;
  const reading = (query) => ({ source: 'openai', query, preferences: reader.localInterpret(query, {}) });

  const STAGE_TEXT = ['Understanding your request', 'Finding matching products'];
  /* the kind of claim no stage may make, because the page cannot know it */
  const INVENTED = /\d+\s*(stores?|shops?|retailers?|sites?|sources?|products|listings|brands)|thousands|millions|hundreds|scanning|the (whole )?(internet|web)|comparing|analy[sz]ing|\d+%/i;

  const reset = () => { stubs.interpret = null; stubs.search = null; stubs.account = null; stubs.charge = false; stubs.log.length = 0; searchRequests.length = 0; };

  /* every line the progress area and the screen-reader status ever held,
     recorded as it changes, so a line shown for a moment is still seen */
  const recordLines = (page) => page.evaluate(() => {
    window.__lines = [];
    const note = () => {
      const h = document.querySelector('#results .search-progress h2');
      const q = document.querySelector('#results .search-progress .results-query');
      if (h) window.__lines.push({ where: 'heading', text: h.textContent.trim() });
      if (q) window.__lines.push({ where: 'detail', text: q.textContent.trim() });
      window.__lines.push({ where: 'status', text: document.getElementById('search-status').textContent.trim() });
    };
    new MutationObserver(note).observe(document.getElementById('results'), { subtree: true, childList: true, characterData: true, attributes: true });
    new MutationObserver(note).observe(document.getElementById('search-status'), { subtree: true, childList: true, characterData: true });
  });

  const stageOf = (page) => page.evaluate(() => {
    const head = document.querySelector('#results .search-progress');
    return head ? {
      stage: head.dataset.stage,
      heading: head.querySelector('h2').textContent.trim(),
      detail: head.querySelector('.results-query').textContent.trim(),
      busy: document.getElementById('results').getAttribute('aria-busy'),
      status: document.getElementById('search-status').textContent.trim()
    } : null;
  });

  const submit = async (page, query) => {
    await page.fill('#ask', query);
    await page.focus('#ask');
    await page.keyboard.press('Enter');
  };

  /* the light in the search box: whether the box is showing it as at
     work — marked with a stage, the light up and the hairline drawn — and
     the stage it is marked with. A light settling away after the answer
     is not shown: the box stopped working when the stage went. */
  const boxLine = (page) => page.evaluate(() => {
    const form = document.getElementById('ask-form');
    const line = form.querySelector('.ask-progress-line');
    const box = line.getBoundingClientRect();
    return {
      stage: form.dataset.stage || null,
      shown: Boolean(form.dataset.stage) && getComputedStyle(form.querySelector('.ask-progress')).visibility === 'visible' && box.width > 0 && box.height > 0
    };
  });

  /* once the answer is in, the light fades while still moving and is put
     to rest: invisible, and its animations paused, within the length of
     its fade — never lingering as if the box were still working */
  const lightRests = (page, where) => page.waitForFunction(() => {
    const form = document.getElementById('ask-form');
    const light = getComputedStyle(form.querySelector('.ask-progress'));
    const run = getComputedStyle(form.querySelector('.ask-progress-line'), '::after');
    return !form.dataset.stage && light.visibility === 'hidden' && light.opacity === '0'
      && !form.classList.contains('is-settling') && run.animationPlayState === 'paused';
  }, null, { timeout: 1500 }).catch(async () => {
    const state = await page.evaluate(() => {
      const form = document.getElementById('ask-form');
      const light = getComputedStyle(form.querySelector('.ask-progress'));
      return { stage: form.dataset.stage || null, classes: form.className, visibility: light.visibility, opacity: light.opacity,
        play: getComputedStyle(form.querySelector('.ask-progress-line'), '::after').animationPlayState };
    }).catch(() => null);
    throw new Error(`${where || 'the light'} did not come to rest within 1.5s of the answer: ${JSON.stringify(state)}`);
  });

  /* what the box looked like at the very moment the progress left the
     results area — caught by an observer, so a line that lingered after
     the answer, even briefly, is seen */
  const watchEnd = (page) => page.evaluate(() => {
    window.__boxAtEnd = undefined;
    new MutationObserver(() => {
      if (window.__boxAtEnd !== undefined || document.querySelector('#results .search-progress')) return;
      const form = document.getElementById('ask-form');
      window.__boxAtEnd = {
        stage: form.dataset.stage || null,
        busy: document.getElementById('results').getAttribute('aria-busy')
      };
    }).observe(document.getElementById('results'), { subtree: true, childList: true });
  });
  const boxAtEnd = (page) => page.evaluate(() => window.__boxAtEnd);

  await test('submitting shows the first stage at once, before anything has answered', async () => {
    reset();
    const interpret = deferred();
    stubs.interpret = { hold: interpret.held, reply: reading('black oversized hoodie under $80') };
    const page = await open();
    await submit(page, 'black oversized hoodie under $80');
    await page.waitForSelector('#results .search-progress[data-stage="understanding"]');
    const now = await stageOf(page);
    assert.strictEqual(now.heading, 'Understanding your request');
    assert.strictEqual(now.detail, 'Results for black oversized hoodie under $80', 'the request as typed, until it has been read (the quotes are the <q>\'s own)');
    assert.strictEqual(now.busy, 'true');
    assert.strictEqual(now.status, 'Understanding your request.');
    assert.deepStrictEqual(await boxLine(page), { stage: 'understanding', shown: true }, 'the search box shows no hairline');
    assert.ok(!(await page.$('#results .stage-bar')), 'a second hairline under the results heading');
    interpret.release();
    await page.waitForSelector('.item-card');
    await page.close();
  });

  await test('the second stage begins only when the reading is back and the product search is sent, and says what was understood', async () => {
    reset();
    const interpret = deferred();
    const search = deferred();
    stubs.interpret = { hold: interpret.held, reply: reading('black oversized hoodie under $80') };
    stubs.search = { hold: search.held };
    const page = await open();
    await submit(page, 'black oversized hoodie under $80');
    await page.waitForSelector('#results .search-progress');
    /* the interpreter has not answered: nothing may claim the search has started */
    await page.waitForTimeout(400);
    assert.strictEqual((await stageOf(page)).stage, 'understanding');
    assert.strictEqual(searchRequests.length, 0);
    interpret.release();
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    const now = await stageOf(page);
    assert.strictEqual(now.heading, 'Finding matching products');
    assert.strictEqual(now.detail, 'Looking for black oversized hoodies under $80');
    assert.strictEqual(now.status, 'Looking for black oversized hoodies under $80. Finding matching products.');
    assert.strictEqual(searchRequests.length, 1, 'the search stage is showing, so the search must have been sent');
    assert.deepStrictEqual(await boxLine(page), { stage: 'searching', shown: true }, 'the hairline left the box during the search');
    /* and it holds that line for as long as the search is open: no
       message is invented to fill the wait */
    await page.waitForTimeout(1200);
    assert.deepStrictEqual(await stageOf(page), now);
    search.release();
    await page.waitForSelector('.item-card');
    await page.close();
  });

  await test('a descriptive request shows the concepts Fynd took it to mean', async () => {
    reset();
    const search = deferred();
    stubs.interpret = { reply: reading('something like a hoodie but cleaner') };
    stubs.search = { hold: search.held };
    const page = await open();
    await submit(page, 'something like a hoodie but cleaner');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    assert.strictEqual((await stageOf(page)).detail, 'Looking for minimal quarter-zips, crewneck sweatshirts or knit pullovers');
    search.release();
    await page.waitForSelector('.item-card');
    await page.close();
  });

  await test('a garment named only as the setting is shown as the setting, never as what is searched for', async () => {
    reset();
    const search = deferred();
    stubs.interpret = { reply: reading('something cozy I can wear with jeans') };
    stubs.search = { hold: search.held };
    const page = await open();
    await submit(page, 'something cozy I can wear with jeans');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    const { detail } = await stageOf(page);
    assert.strictEqual(detail, 'Looking for cozy sweaters, sweatshirts or cardigans to wear with jeans');
    const target = detail.split(' to wear ')[0];
    assert.ok(!/jean/i.test(target), `jeans shown as the target: ${detail}`);
    /* and the search it is waiting on was not sent for jeans either */
    assert.deepStrictEqual(searchRequests[0].intent.garments, []);
    search.release();
    await page.waitForSelector('.item-card');
    await page.close();
  });

  await test('the progress is gone the moment results arrive', async () => {
    reset();
    const search = deferred();
    stubs.search = { hold: search.held };
    const page = await open();
    await submit(page, 'black oversized hoodie');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    await watchEnd(page);
    search.release();
    await page.waitForSelector('.item-card');
    /* the box stops working in the same moment the results replaced the
       placeholders, not a beat later, and its light settles away */
    assert.deepStrictEqual(await boxAtEnd(page), { stage: null, busy: null }, 'the box was still at work when the results came');
    assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false });
    await lightRests(page);
    /* the placeholders leave under the products, hidden and inert, and
       are gone once their fade is over */
    const leaving = await page.evaluate(() => Array.from(document.querySelectorAll('#results .skeleton-card'))
      .map((card) => { const layer = card.closest('.results-leaving'); return Boolean(layer && layer.inert && layer.getAttribute('aria-hidden') === 'true'); }));
    assert.ok(leaving.every(Boolean), 'a placeholder outside the leaving layer, or a leaving layer that is not hidden and inert');
    await page.waitForFunction(() => !document.querySelector('#results .skeleton-card, #results .results-leaving'), null, { timeout: 2000 });
    const after = await page.evaluate(() => ({
      progress: Boolean(document.querySelector('#results .search-progress, #results .stage-bar, #results .thinking, #results .skeleton-card')),
      busy: document.getElementById('results').hasAttribute('aria-busy'),
      heading: document.querySelector('.results-head h2').textContent.trim(),
      status: document.getElementById('search-status').textContent.trim()
    }));
    assert.deepStrictEqual(after, { progress: false, busy: false, heading: '1 piece found', status: '1 piece found.' });
    await page.close();
  });

  await test('a failed search replaces the progress with the existing error, and the way to try again', async () => {
    for (const [why, failure] of [['a 502', { status: 502 }], ['a dropped connection', { drop: true }], ['no service at all', { status: 404 }]]) {
      reset();
      const search = deferred();
      stubs.search = Object.assign({ hold: search.held }, failure);
      const page = await open();
      await submit(page, 'black oversized hoodie');
      await page.waitForSelector('#results .search-progress[data-stage="searching"]');
      await watchEnd(page);
      search.release();
      await page.waitForFunction(() => !document.querySelector('#results .search-progress'), null, { timeout: 10000 });
      assert.deepStrictEqual(await boxAtEnd(page), { stage: null, busy: null }, `${why}: the box was still at work after the failure`);
      assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false }, why);
      await lightRests(page, why);
      const after = await page.evaluate(() => ({
        stuck: Boolean(document.querySelector('#results .stage-bar, #results .thinking')),
        busy: document.getElementById('results').hasAttribute('aria-busy'),
        heading: document.querySelector('.results-head h2').textContent.trim(),
        again: Boolean(document.querySelector('#results a[href="#search"]'))
      }));
      assert.strictEqual(after.stuck, false, why);
      assert.strictEqual(after.busy, false, why);
      if (failure.status === 404) {
        /* nothing connected: the sample catalogue, labelled, as before */
        assert.ok(/picked for you|No matches yet/.test(after.heading), `${why}: ${after.heading}`);
      } else {
        assert.strictEqual(after.heading, 'Product search unavailable', why);
        assert.ok(after.again, `${why}: no way to try again`);
      }
      await page.close();
    }
  });

  await test('an interpreter that fails still moves on to the search, read locally, and says so', async () => {
    reset();
    const search = deferred();
    stubs.interpret = { status: 500 };
    stubs.search = { hold: search.held };
    const page = await open();
    await submit(page, 'loose black pants that look nice');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    assert.strictEqual((await stageOf(page)).detail, 'Looking for black wide-leg, relaxed or pleated trousers');
    search.release();
    await page.waitForSelector('.item-card');
    assert.ok(/local keyword match/.test(await page.$eval('#results .notice', (n) => n.textContent)));
    await page.close();
  });

  await test('no stage ever claims a count, a scale or work the page cannot see', async () => {
    const seen = [];
    for (const query of ['black oversized hoodie under $80', 'something like a hoodie but cleaner', 'something cozy I can wear with jeans', 'a bag that looks vintage but not crazy expensive', 'something nice for dinner']) {
      reset();
      const search = deferred();
      stubs.interpret = { reply: reading(query) };
      stubs.search = { hold: search.held };
      const page = await open();
      await recordLines(page);
      await submit(page, query);
      await page.waitForSelector('#results .search-progress[data-stage="searching"]');
      search.release();
      await page.waitForSelector('.item-card');
      seen.push(...(await page.evaluate(() => window.__lines)).map((line) => Object.assign(line, { query })));
      await page.close();
    }
    const progress = seen.filter((line) => line.where !== 'status' || !/found\.$/.test(line.text));
    for (const { where, text, query } of progress) {
      if (!text) continue;
      const own = text.replace(query, "");
      assert.ok(!INVENTED.test(own), `${where} said "${text}"`);
      /* a number is only ever a price the shopper gave */
      assert.ok(!/\d/.test(own.replace(/\$\d+(\.\d+)?/g, '')), `${where} said "${text}"`);
      if (where === 'heading') assert.ok(STAGE_TEXT.includes(text), `an unexpected stage: "${text}"`);
      if (where === 'detail') assert.ok(/^(Results for|Looking for) /.test(text), `an unexpected detail: "${text}"`);
      assert.ok(!/[{}[\]]|concept|intent|preferences|api\b|json/i.test(own), `${where} exposed internals: "${text}"`);
    }
    /* "something nice for dinner" names no garment, colour or shoe, so
       none is claimed: "dressy" — read from "nice" — is the most it says */
    const dinner = seen.filter((line) => line.query === 'something nice for dinner' && line.where === 'detail').map((line) => line.text);
    assert.ok(dinner.every((text) => !/\bdress(es)?\b|\bblack\b|\bheels?\b/i.test(text.replace('something nice for dinner', ''))), dinner.join(' | '));
  });

  await test('a fast or cached search goes straight to its results, held up by nothing', async () => {
    reset();
    const page = await open();
    await watchEnd(page);
    const started = Date.now();
    await submit(page, 'black oversized hoodie under $80');
    await page.waitForSelector('.item-card');
    const shown = Date.now();
    /* the box stops working with the answer; its light only fades */
    assert.deepStrictEqual(await boxAtEnd(page), { stage: null, busy: null });
    await lightRests(page);
    const reply = stubs.log.filter((e) => e.path === '/api/search' && e.event === 'reply').pop();
    assert.ok(reply, 'the search never answered');
    assert.ok(shown - reply.at < 400, `results took ${shown - reply.at}ms to appear after the search answered`);
    assert.ok(shown - started < 2000, `a search that answered at once took ${shown - started}ms`);
    /* and nothing in the page's progress code waits on a clock */
    const app = fs.readFileSync(path.join(REPO, 'assets', 'app.js'), 'utf8');
    const progressCode = app.slice(app.indexOf('while a search runs'), app.indexOf('Files dropped on the card'));
    assert.ok(progressCode.length > 500, 'the progress code moved');
    assert.ok(!/setTimeout|setInterval|requestAnimationFrame|\.sleep|delay\(/.test(progressCode), 'the progress code waits on a timer');
    await page.close();
  });

  await test('a search replaced by a newer one never paints over it', async () => {
    reset();
    const first = deferred();
    stubs.interpret = { hold: first.held, reply: reading('red dress') };
    const page = await open();
    await submit(page, 'red dress');
    await page.waitForSelector('#results .search-progress');
    stubs.interpret = { reply: reading('something cozy I can wear with jeans') };
    await submit(page, 'something cozy I can wear with jeans');
    await page.waitForSelector('.item-card');
    first.release();
    await page.waitForTimeout(500);
    assert.strictEqual(await page.$eval('.results-query', (n) => n.textContent.trim()), 'Results for something cozy I can wear with jeans');
    assert.ok(!(await page.$('#results .search-progress')));
    assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false }, 'the late answer brought the hairline back');
    await page.close();
  });

  await test('a replaced search that answers late leaves the running search\'s hairline alone', async () => {
    reset();
    const first = deferred();
    const second = deferred();
    stubs.interpret = { hold: first.held, reply: reading('red dress') };
    const page = await open();
    await submit(page, 'red dress');
    await page.waitForSelector('#ask-form[data-stage="understanding"]');
    stubs.interpret = { reply: reading('something cozy I can wear with jeans') };
    stubs.search = { hold: second.held };
    await submit(page, 'something cozy I can wear with jeans');
    await page.waitForSelector('#ask-form[data-stage="searching"]');
    /* the first search's reading comes back now, to nothing */
    first.release();
    await page.waitForTimeout(500);
    assert.deepStrictEqual(await boxLine(page), { stage: 'searching', shown: true }, 'the replaced search cleared the running one\'s hairline');
    assert.strictEqual((await stageOf(page)).detail, 'Looking for cozy sweaters, sweatshirts or cardigans to wear with jeans');
    second.release();
    await page.waitForSelector('.item-card');
    assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false });
    await page.close();
  });

  await test('keyboard focus stays where the shopper left it, through every stage and after', async () => {
    reset();
    const search = deferred();
    stubs.search = { hold: search.held };
    const page = await open();
    await submit(page, 'black oversized hoodie');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ask');
    search.release();
    await page.waitForSelector('.item-card');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ask');

    /* and from the Search button, pressed with the keyboard */
    reset();
    const again = deferred();
    stubs.search = { hold: again.held };
    await page.fill('#ask', 'black oversized hoodie');
    await page.focus('#ask-form button[type=submit]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    const onButton = () => page.evaluate(() => document.activeElement === document.querySelector('#ask-form button[type=submit]'));
    assert.ok(await onButton(), 'focus left the Search button while searching');
    again.release();
    await page.waitForSelector('.item-card');
    assert.ok(await onButton(), 'focus left the Search button when the results came');
    await page.close();
  });

  const motionOf = (page) => page.evaluate(() => {
    const css = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
    return {
      bar: css('#ask-form .ask-progress-line', '::after').animationName,
      line: css('#results .stage-text').animationName,
      skeleton: css('#results .skeleton-card').animationName,
      opacity: css('#ask-form .ask-progress-line').opacity
    };
  });

  await test('the progress moves quietly, and holds still for anyone who asks for reduced motion', async () => {
    reset();
    const search = deferred();
    stubs.search = { hold: search.held };
    const moving = await open();
    await submit(moving, 'black oversized hoodie');
    await moving.waitForSelector('#results .search-progress[data-stage="searching"]');
    const normal = await motionOf(moving);
    assert.strictEqual(normal.bar, 'sweep');
    assert.strictEqual(normal.line, 'stage-in');
    assert.strictEqual(normal.skeleton, 'placeholder-in');
    search.release();
    await moving.close();

    reset();
    const held = deferred();
    stubs.search = { hold: held.held };
    const still = await browser.newPage();
    await still.emulateMedia({ reducedMotion: 'reduce' });
    await still.addInitScript(() => {
      window.FINDWEAR_API = 'http://127.0.0.1:8899/api/interpret';
      window.FINDWEAR_SEARCH_API = 'http://127.0.0.1:8899/api/search';
    });
    await still.route((url) => !String(url).includes('127.0.0.1'), (route) => route.abort());
    await still.goto(`http://127.0.0.1:${PORT}/find-clothes.html`, { waitUntil: 'domcontentloaded' });
    await still.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
    await submit(still, 'black oversized hoodie');
    await still.waitForSelector('#results .search-progress[data-stage="searching"]');
    const reduced = await motionOf(still);
    assert.deepStrictEqual(reduced, { bar: 'none', line: 'none', skeleton: 'none', opacity: '1' }, `reduced motion still moves: ${JSON.stringify(reduced)}`);
    /* still there, and still in the box: held still, not taken away */
    await still.waitForFunction(() => getComputedStyle(document.querySelector('#ask-form .ask-progress')).visibility === 'visible', null, { timeout: 2000 }).catch(() => {});
    const line = await boxLine(still);
    assert.deepStrictEqual(line, { stage: 'searching', shown: true }, `the still line is not in the box: ${JSON.stringify(line)}`);
    /* still, and still legible: every line in a palette ink */
    const problems = await textStyleProblems(still, await resolveInks(still));
    assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
    held.release();
    await still.waitForSelector('.item-card');
    await still.close();
  });

  await test('changing stage moves nothing on the page, on a wide screen or a phone', async () => {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 800 }]) {
      reset();
      const interpret = deferred();
      const search = deferred();
      stubs.interpret = { hold: interpret.held, reply: reading('something cozy I can wear with jeans') };
      stubs.search = { hold: search.held };
      const page = await open();
      await page.setViewportSize(viewport);
      await submit(page, 'something cozy I can wear with jeans');
      await page.waitForSelector('#results .search-progress[data-stage="understanding"]');
      const gridTop = () => page.evaluate(() => Math.round(document.querySelector('#results .grid').getBoundingClientRect().top + window.scrollY));
      const before = await gridTop();
      interpret.release();
      await page.waitForSelector('#results .search-progress[data-stage="searching"]');
      assert.strictEqual(await gridTop(), before, `${viewport.width}px: the products' place moved when the stage changed`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.strictEqual(overflow, 0, `${viewport.width}px: the progress overflows the screen`);
      search.release();
      await page.waitForSelector('.item-card');
      if (viewport.width >= 768) assert.strictEqual(await gridTop(), before, 'on a wide screen the products arrive where the placeholders stood');
      await page.close();
    }
  });

  /* Where everything in the search box is, in page coordinates, so a
     scroll is not mistaken for something moving. */
  const boxGeometry = (page) => page.evaluate(() => {
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, left: r.left, right: r.right, width: r.width, height: r.height, viewTop: r.top, viewBottom: r.bottom };
    };
    const form = document.getElementById('ask-form');
    const head = document.querySelector('#results .search-progress');
    return {
      form: at(form),
      inner: form.clientWidth,
      border: parseFloat(getComputedStyle(form).borderBottomWidth),
      line: at(form.querySelector('.ask-progress-line')),
      shown: getComputedStyle(form.querySelector('.ask-progress')).visibility === 'visible',
      text: at(document.getElementById('ask')),
      button: at(form.querySelector('button[type=submit]')),
      clear: at(document.getElementById('reset-form')),
      attach: at(form.querySelector('.attach-btn')),
      header: document.querySelector('.site-header').getBoundingClientRect().bottom,
      stage: head ? at(head) : null,
      viewport: window.innerHeight,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });

  /* the page has finished bringing what it scrolls to into view: the
     scroll position has held still for a few frames' worth of time */
  const scrollSettled = (page) => page.evaluate(() => { window.__settle = null; }).then(() => page.waitForFunction(() => {
    const y = Math.round(window.scrollY);
    const now = performance.now();
    const last = window.__settle;
    if (!last || last.y !== y) { window.__settle = { y, since: now }; return false; }
    return now - last.since > 300;
  }, null, { polling: 50, timeout: 5000 }));

  const SEARCH_WIDTHS = [
    { width: 1440, height: 900 }, { width: 1280, height: 900 }, { width: 768, height: 1024 }, { width: 767, height: 1024 },
    { width: 480, height: 860 }, { width: 390, height: 844 }, { width: 375, height: 812 }
  ];

  await test('the hairline lies along the bottom edge of the search box, inside it, through both stages, at every width', async () => {
    /* long enough to wrap onto more lines on a phone, where the box stacks */
    const query = 'something cozy I can wear with jeans for a weekend away';
    /* the search box lives on the Search page only; the home page is the fit guide */
    const runs = SEARCH_WIDTHS.map((viewport) => ['find-clothes.html', viewport]);
    for (const [file, viewport] of runs) {
      const where = `${file} at ${viewport.width}px`;
      reset();
      const interpret = deferred();
      const search = deferred();
      stubs.interpret = { hold: interpret.held, reply: reading(query) };
      stubs.search = { hold: search.held };
      const page = file === 'find-clothes.html' ? await open() : await openPage(file);
      if (file !== 'find-clothes.html') await page.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
      await page.setViewportSize(viewport);
      await page.fill('#ask', query);
      const before = await boxGeometry(page);
      assert.strictEqual(before.shown, false, `${where}: a hairline before any search`);
      await page.focus('#ask');
      await page.keyboard.press('Enter');

      const lines = [];
      for (const stage of ['understanding', 'searching']) {
        if (stage === 'searching') interpret.release();
        await page.waitForSelector(`#results .search-progress[data-stage="${stage}"]`);
        await scrollSettled(page);
        const g = await boxGeometry(page);
        const at = `${where}, ${stage}`;
        assert.strictEqual(g.shown, true, `${at}: no hairline`);
        assert.deepStrictEqual(await boxLine(page), { stage, shown: true }, at);

        /* flush with the bottom edge, just inside the border */
        const gap = g.form.viewBottom - g.border - g.line.viewBottom;
        assert.ok(Math.abs(gap) <= 0.5, `${at}: the hairline is ${gap.toFixed(2)}px off the box's bottom edge`);
        assert.ok(g.line.height > 0 && g.line.height <= 2, `${at}: the hairline is ${g.line.height}px thick`);
        /* the usable width of the box, and not a pixel outside it */
        assert.ok(Math.abs(g.line.width - g.inner) <= 0.5, `${at}: the hairline is ${g.line.width}px across a ${g.inner}px box`);
        assert.ok(g.line.left >= g.form.left && g.line.right <= g.form.right, `${at}: the hairline sticks out of the box`);
        /* over nothing: the words, the Search button and the small buttons
           all end above it */
        for (const part of ['text', 'button', 'clear', 'attach']) {
          if (!g[part].height) continue;
          assert.ok(g[part].bottom <= g.line.top + 0.5, `${at}: the hairline overlaps the ${part} (${g[part].bottom} > ${g.line.top})`);
        }
        /* the box keeps its size and place, and so does its button */
        for (const part of ['form', 'button', 'text']) {
          for (const side of ['top', 'left', 'width', 'height']) {
            assert.ok(Math.abs(g[part][side] - before[part][side]) <= 0.5, `${at}: the ${part}'s ${side} moved from ${before[part][side]} to ${g[part][side]}`);
          }
        }
        if (viewport.width <= 767) assert.ok(g.button.top >= g.text.bottom, `${at}: the box did not stack`);
        assert.strictEqual(g.overflow, 0, `${at}: the page scrolls sideways`);
        /* on screen while it works: the box below the header, and the
           words saying what it is doing above the fold */
        assert.ok(g.form.viewTop >= g.header && g.line.viewBottom <= g.viewport, `${at}: the box is off screen (${g.form.viewTop}..${g.line.viewBottom}, header ${g.header}, viewport ${g.viewport})`);
        assert.ok(g.stage.viewTop >= g.header && g.stage.viewBottom <= g.viewport, `${at}: the stage line is off screen (${g.stage.viewTop}..${g.stage.viewBottom})`);
        lines.push(g.line.width);
      }
      /* the same full line at both stages: it says the box is working,
         not how far along it is */
      assert.strictEqual(lines[0], lines[1], `${where}: the hairline changed length between stages`);

      search.release();
      await page.waitForSelector('.item-card');
      await lightRests(page, where);
      const after = await boxGeometry(page);
      assert.strictEqual(after.shown, false, `${where}: the hairline stayed after the results`);
      for (const side of ['top', 'left', 'width', 'height']) {
        assert.ok(Math.abs(after.form[side] - before.form[side]) <= 0.5, `${where}: the box's ${side} changed after the search`);
      }
      assert.strictEqual(after.overflow, 0, `${where}: the results scroll sideways`);
      /* and the results are brought up, as they always were */
      await page.waitForFunction(() => {
        const card = document.querySelector('.item-card').getBoundingClientRect();
        return card.top >= 0 && card.top < window.innerHeight;
      }, null, { timeout: 5000 });
      await page.close();
    }
  });

  await test('the hairline is decoration: hidden from assistive technology, with the stage still said in words', async () => {
    for (const file of ['find-clothes.html']) {
      reset();
      const search = deferred();
      stubs.search = { hold: search.held };
      const page = await openPage(file);
      await page.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
      const markup = await page.evaluate(() => {
        const wrap = document.querySelector('#ask-form > .ask-progress');
        return wrap && {
          hidden: wrap.getAttribute('aria-hidden'),
          text: wrap.textContent.trim(),
          focusable: wrap.querySelectorAll('a, button, input, [tabindex]').length,
          role: wrap.getAttribute('role'),
          live: wrap.closest('[aria-live]') !== null
        };
      });
      assert.deepStrictEqual(markup, { hidden: 'true', text: '', focusable: 0, role: null, live: false }, file);
      await submit(page, 'black oversized hoodie');
      await page.waitForSelector('#ask-form[data-stage="searching"]');
      const said = await page.evaluate(() => ({
        status: document.getElementById('search-status').textContent.trim(),
        heading: document.querySelector('#results .search-progress h2').textContent.trim(),
        formBusy: document.getElementById('ask-form').getAttribute('aria-busy')
      }));
      assert.ok(/Finding matching products\.$/.test(said.status), `${file}: ${said.status}`);
      assert.strictEqual(said.heading, 'Finding matching products', file);
      /* the box stays usable while it works: nothing marks it busy */
      assert.strictEqual(said.formBusy, null, file);
      search.release();
      await page.waitForSelector('.item-card');
      await page.close();
    }
  });

  await test('"Start over" during a search leaves nothing behind', async () => {
    reset();
    const search = deferred();
    stubs.search = { hold: search.held };
    const page = await open();
    await submit(page, 'black oversized hoodie');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    await page.click('#reset-form');
    search.release();
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ hidden: document.getElementById('results').hidden, html: document.getElementById('results').innerHTML, busy: document.getElementById('results').hasAttribute('aria-busy') }));
    assert.deepStrictEqual(after, { hidden: true, html: '', busy: false });
    assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false }, 'the hairline stayed after "Start over"');
    await page.close();
  });

  console.log('\nthe loading experience');

  /* Live products that read like real ones: a brand, a name long enough
     to take its two lines, a price, and a shop that is not the brand, so
     every line a card can carry is drawn — the lines the placeholders
     stand in for. Their photos are on this origin, each at its own URL. */
  const POSTER = `http://127.0.0.1:${PORT}/assets/demo/fynd-demo-poster.jpg`;
  const livePiece = (i, photo) => ({
    id: `look-${i}`, name: `Relaxed Wool Overshirt in Heathered Charcoal, Style ${i + 1}`,
    brand: 'Arket', retailer: 'Arket Studio', price: 89 + i, currency: 'USD',
    imageUrl: photo || `${POSTER}?look=${i}`, productUrl: `https://www.arket.com/en/product/${i}`,
    category: '', colors: [], sizes: []
  });
  const answerWith = (products) => ({ source: 'openwebninja', products, returned: products.length, rejected: {} });
  const pieces = (n) => Array.from({ length: n }, (_, i) => livePiece(i));

  /* the placeholders the shopper can see, and where each part of each
     sits, measured from the top-left of its own grid */
  const cardShapes = (page, selector) => page.evaluate((sel) => {
    const cards = Array.from(document.querySelectorAll(sel)).filter((card) => getComputedStyle(card).display !== 'none');
    if (!cards.length) return [];
    const grid = cards[0].parentElement.getBoundingClientRect();
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left - grid.left, top: r.top - grid.top, width: r.width, height: r.height };
    };
    return cards.map((card) => ({
      card: box(card),
      media: box(card.querySelector('.item-media')),
      brand: box(card.querySelector('.item-retailer')),
      name: box(card.querySelector('.item-name')),
      price: box(card.querySelector('.item-price')),
      seller: box(card.querySelector('.item-seller'))
    }));
  }, selector);

  await test('placeholders take the real card\'s shape — its picture, its lines, its grid — at every width, and say nothing', async () => {
    for (const [viewport, columns] of [[{ width: 1280, height: 900 }, 4], [{ width: 820, height: 1000 }, 3], [{ width: 390, height: 844 }, 2]]) {
      const where = `${viewport.width}px`;
      reset();
      const search = deferred();
      stubs.search = { hold: search.held, reply: answerWith(pieces(8)) };
      const page = await open();
      await page.setViewportSize(viewport);
      await submit(page, 'an overshirt for the weekend');
      await page.waitForSelector('#results .search-progress[data-stage="searching"]');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#results .skeleton-card')).opacity === '1');
      const placeholders = await cardShapes(page, '#results .skeleton-card');
      /* two full rows, whatever the width */
      assert.strictEqual(placeholders.length, columns * 2, `${where}: ${placeholders.length} placeholders for ${columns} columns`);
      assert.strictEqual(new Set(placeholders.map((p) => Math.round(p.card.left))).size, columns, `${where}: placeholders not in ${columns} columns`);
      /* nothing true to say yet, so nothing is said or shown */
      const said = await page.evaluate(() => ({
        text: Array.from(document.querySelectorAll('#results .skeleton-card')).map((c) => c.textContent.trim()).join(''),
        photos: document.querySelectorAll('#results .skeleton-card img, #results .skeleton-card svg').length,
        hidden: document.querySelector('#results .skeleton-card').closest('[aria-hidden="true"]') !== null
      }));
      assert.deepStrictEqual(said, { text: '', photos: 0, hidden: true }, where);

      search.release();
      await page.waitForSelector('#results .grid .item-card');
      await finishedMoving(page);
      const cards = await cardShapes(page, '#results .grid .item-card');
      for (let i = 0; i < placeholders.length; i += 1) {
        for (const part of ['card', 'media', 'brand', 'name', 'price', 'seller']) {
          for (const side of ['left', 'top', 'width', 'height']) {
            const off = Math.abs(placeholders[i][part][side] - cards[i][part][side]);
            assert.ok(off <= 0.5, `${where}, card ${i + 1}: the placeholder's ${part} ${side} is ${placeholders[i][part][side]}, the card's ${cards[i][part][side]}`);
          }
        }
      }
      await page.close();
    }
  });

  /* every opacity a placeholder and a card were drawn at, frame by frame,
     from now until told to stop, with the time since the search was sent */
  const sampleFrames = (page) => page.evaluate(() => {
    window.__frames = [];
    window.__sentAt = null;
    document.getElementById('ask-form').addEventListener('submit', () => { window.__sentAt = performance.now(); }, { capture: true, once: true });
    const seen = (el) => {
      let value = 1;
      for (let node = el; node && node.id !== 'results'; node = node.parentElement) value *= Number(getComputedStyle(node).opacity);
      return value;
    };
    const tick = () => {
      if (window.__stopFrames) return;
      const placeholders = Array.from(document.querySelectorAll('#results .skeleton-card'));
      const cards = Array.from(document.querySelectorAll('#results .grid .item-card'));
      window.__frames.push({
        at: window.__sentAt === null ? null : performance.now() - window.__sentAt,
        placeholders: placeholders.map(seen),
        cards: cards.map(seen),
        quick: Boolean(document.querySelector('#results .grid.is-quick'))
      });
      requestAnimationFrame(tick);
    };
    window.__stopFrames = false;
    requestAnimationFrame(tick);
  });
  const stopFrames = (page) => page.evaluate(() => { window.__stopFrames = true; return window.__frames.filter((f) => f.at !== null); });

  await test('a fast or cached answer never shows a placeholder, and its cards come in quickly', async () => {
    reset();
    stubs.search = { reply: answerWith(pieces(8)) };
    const page = await open();
    await sampleFrames(page);
    await submit(page, 'an overshirt for the weekend');
    await page.waitForSelector('#results .grid .item-card');
    await page.waitForTimeout(400);
    const frames = await stopFrames(page);
    const wait = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--placeholder-wait')) * 1000);
    /* whatever the timing, no placeholder is visible before the wait */
    const early = frames.filter((f) => f.at < wait - 10).flatMap((f) => f.placeholders);
    assert.ok(early.every((o) => o === 0), `a placeholder showed ${Math.max(...early).toFixed(2)} before ${wait}ms`);
    /* and an answer that beat the wait shows none at all, and comes in quick */
    const answered = frames.find((f) => f.cards.length);
    assert.ok(answered, 'the cards never came');
    if (answered.at < wait) {
      assert.ok(frames.every((f) => f.placeholders.every((o) => o === 0)), 'a placeholder flashed before a fast answer');
      assert.ok(answered.quick, 'a fast answer came in at the slow pace');
    }
    /* every card is in the page at once: only its fade is staggered */
    assert.strictEqual(answered.cards.length, 8, `only ${answered.cards.length} of 8 cards were in the page when the answer came`);
    await page.close();
  });

  await test('a slow search fades its placeholders in after a beat, and one light moves through the box and over them in step', async () => {
    reset();
    const search = deferred();
    stubs.search = { hold: search.held, reply: answerWith(pieces(8)) };
    const page = await open();
    await submit(page, 'an overshirt for the weekend');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#results .skeleton-card')).slice(0, 4).every((c) => getComputedStyle(c).opacity === '1'));
    const light = await page.evaluate(() => {
      const css = (el, pseudo) => getComputedStyle(el, pseudo);
      const run = css(document.querySelector('#ask-form .ask-progress-line'), '::after');
      const cards = Array.from(document.querySelectorAll('#results .skeleton-card')).map((c) => css(c, '::after'));
      return {
        running: run.animationPlayState,
        box: [run.animationName, run.animationDuration, run.animationTimingFunction, run.animationIterationCount],
        tiles: cards.map((c) => [c.animationName, c.animationDuration, c.animationTimingFunction, c.animationIterationCount]),
        phases: cards.map((c) => c.animationDelay)
      };
    });
    assert.strictEqual(light.running, 'running', 'the light in the box is not moving');
    /* one pace and one curve for the box and every placeholder */
    light.tiles.forEach((tile) => {
      assert.strictEqual(tile[1], light.box[1], 'a placeholder moves at another pace than the box');
      assert.strictEqual(tile[2], light.box[2], 'a placeholder moves on another curve than the box');
      assert.strictEqual(tile[3], 'infinite');
    });
    /* and each placeholder a beat after the one before, never all at once */
    assert.strictEqual(new Set(light.phases).size, light.phases.length, `placeholders share a phase: ${light.phases.join(', ')}`);
    search.release();
    await page.waitForSelector('#results .grid .item-card');
    await page.close();
  });

  await test('placeholders give way to products slot by slot: every slot is covered throughout, nothing flashes blank', async () => {
    reset();
    const search = deferred();
    stubs.search = { hold: search.held, reply: answerWith(pieces(8)) };
    const page = await open();
    await submit(page, 'an overshirt for the weekend');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#results .skeleton-card')).slice(0, 4).every((c) => getComputedStyle(c).opacity === '1'));
    await sampleFrames(page);
    await page.evaluate(() => { window.__sentAt = performance.now(); });
    search.release();
    await page.waitForSelector('#results .grid .item-card');
    await page.waitForFunction(() => !document.querySelector('#results .results-leaving'), null, { timeout: 3000 });
    const frames = await stopFrames(page);
    /* a slot is covered by whatever stands in it: the placeholder, the
       card, or the two together while one fades into the other */
    let worst = 1;
    for (const f of frames) {
      for (let slot = 0; slot < 4; slot += 1) {
        const covered = 1 - (1 - (f.placeholders[slot] || 0)) * (1 - (f.cards[slot] || 0));
        worst = Math.min(worst, covered);
      }
    }
    assert.ok(frames.length > 10, `only ${frames.length} frames were sampled`);
    assert.ok(worst >= 0.6, `a slot fell to ${worst.toFixed(2)} coverage during the handoff`);
    /* the cards come in reading order, a beat apart */
    const delays = await page.evaluate(() => Array.from(document.querySelectorAll('#results .grid .item-card')).map((c) => parseFloat(getComputedStyle(c).animationDelay)));
    assert.ok(delays.every((d, i) => i === 0 || d > delays[i - 1]), `the cards do not come in reading order: ${delays.join(', ')}`);
    assert.ok(delays[delays.length - 1] <= 0.5, `the last card waits ${delays[delays.length - 1]}s to come in`);
    await page.close();
  });

  await test('a search replaced while it runs keeps its placeholders and its light; replaced results leave hidden and inert, never read as results', async () => {
    reset();
    const first = deferred();
    const second = deferred();
    const third = deferred();
    stubs.search = { hold: first.held, reply: answerWith(pieces(8).map((p) => Object.assign({}, p, { name: `First ${p.name}` }))) };
    const page = await open();
    await submit(page, 'a red dress');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    await page.evaluate(() => {
      document.querySelector('#results .skeleton-card').dataset.mark = 'first';
      document.querySelector('#results .search-progress').dataset.mark = 'first';
    });
    stubs.search = { hold: second.held, reply: answerWith(pieces(8)) };
    await submit(page, 'an overshirt for the weekend');
    /* the words are the new search's: its head replaced the first one's */
    await page.waitForFunction(() => {
      const head = document.querySelector('#results .search-progress');
      return head && !head.dataset.mark && head.dataset.stage === 'searching';
    });
    /* the same placeholders, never redrawn, and the light never stopped */
    const carried = await page.evaluate(() => ({
      same: Boolean(document.querySelector('#results .results-body:not(.results-leaving) .skeleton-card[data-mark="first"]')),
      leaving: document.querySelectorAll('#results .results-leaving').length,
      light: getComputedStyle(document.querySelector('#ask-form .ask-progress-line'), '::after').animationPlayState
    }));
    assert.deepStrictEqual(carried, { same: true, leaving: 0, light: 'running' }, 'the second search restarted the loading state');
    /* the first search's answer comes back now, to nothing */
    first.release();
    await page.waitForTimeout(300);
    assert.ok(await page.$('#results .skeleton-card[data-mark="first"]'), 'the replaced search painted over the running one');
    assert.strictEqual(await page.$('#results .grid .item-card'), null);
    second.release();
    await page.waitForSelector('#results .grid .item-card');
    assert.ok(!(await page.$$eval('#results .item-name', (ns) => ns.some((n) => /^First /.test(n.textContent)))), 'the replaced search\'s products were shown');

    /* a third search over real results: the old products leave, hidden,
       inert and renamed, and nothing can find them as results */
    await page.waitForFunction(() => !document.querySelector('#results .results-leaving'), null, { timeout: 3000 });
    stubs.search = { hold: third.held, reply: answerWith(pieces(4)) };
    await submit(page, 'a wool coat');
    await page.waitForSelector('#results .search-progress');
    const outgoing = await page.evaluate(() => {
      const layer = document.querySelector('#results .results-leaving');
      return {
        results: document.querySelectorAll('#results .grid .item-card').length,
        ghosts: layer ? layer.querySelectorAll('.item-ghost').length : 0,
        hidden: layer ? layer.getAttribute('aria-hidden') : null,
        inert: layer ? layer.inert : null,
        busy: document.getElementById('results').getAttribute('aria-busy')
      };
    });
    assert.deepStrictEqual(outgoing, { results: 0, ghosts: 8, hidden: 'true', inert: true, busy: 'true' });
    await page.waitForFunction(() => !document.querySelector('#results .item-ghost'), null, { timeout: 1500 });
    third.release();
    await page.waitForSelector('#results .grid .item-card');
    assert.strictEqual(await page.$$eval('#results .grid .item-card', (ns) => ns.length), 4);
    await page.close();
  });

  await test('no matches, a 502, a provider timeout and a dropped connection: the placeholders clear inside the results, the reason rises in, the light settles', async () => {
    const outcomes = [
      ['no matches', { reply: answerWith([]) }, 'No matches found', /could be verified/],
      ['a 502', { status: 502, reply: { error: 'failed', reason: 'failed' } }, 'Product search unavailable', /failed/],
      ['a provider timeout', { status: 502, reply: { error: 'timeout', reason: 'timeout', stage: 'offers' } }, 'Product search unavailable', /could not confirm their prices in time/],
      ['a dropped connection', { drop: true }, 'Product search unavailable', /could not be reached/]
    ];
    for (const [why, outcome, heading, detail] of outcomes) {
      reset();
      const search = deferred();
      stubs.search = Object.assign({ hold: search.held }, outcome);
      const page = await open();
      await submit(page, 'an overshirt for the weekend');
      await page.waitForSelector('#results .search-progress[data-stage="searching"]');
      await page.waitForFunction(() => getComputedStyle(document.querySelector('#results .skeleton-card')).opacity === '1');
      search.release();
      await page.waitForSelector('#results .results-body:not(.results-leaving) .empty', { timeout: 10000 });
      const now = await page.evaluate(() => ({
        heading: document.querySelector('.results-head h2').textContent.trim(),
        detail: document.querySelector('#results .results-body:not(.results-leaving) .empty p').textContent.trim(),
        kept: getComputedStyle(document.querySelector('#results .results-stage')).overflow,
        busy: document.getElementById('results').hasAttribute('aria-busy'),
        stage: document.getElementById('ask-form').dataset.stage || null
      }));
      assert.strictEqual(now.heading, heading, why);
      assert.ok(detail.test(now.detail), `${why}: "${now.detail}"`);
      /* what leaves stays within the answer, and never spills onto the page below */
      assert.strictEqual(now.kept, 'clip', `${why}: the leaving placeholders can spill past the answer`);
      assert.deepStrictEqual([now.busy, now.stage], [false, null], `${why}: still at work after the answer`);
      await page.waitForFunction(() => !document.querySelector('#results .skeleton-card'), null, { timeout: 1500 });
      await lightRests(page, why);
      assert.ok(await page.$('#results a[href="#search"]'), `${why}: no way to try again`);
      await page.close();
    }
  });

  await test('a photo still on its way keeps the light on its tile and fades in when it arrives; a photo already there is never faded', async () => {
    reset();
    const late = `http://127.0.0.1:${PORT}/__slow/900/assets/demo/fynd-demo-poster.jpg?late=${Date.now()}`;
    const ready = `${POSTER}?ready=${Date.now()}`;
    stubs.search = { reply: answerWith([livePiece(0, late), livePiece(1, ready)]) };
    const page = await open();
    /* the second photo is already in the browser's cache */
    await page.evaluate((url) => new Promise((resolve) => { const img = new Image(); img.onload = resolve; img.src = url; }), ready);
    await submit(page, 'an overshirt for the weekend');
    await page.waitForSelector('#results .grid .item-card');
    const tiles = () => page.evaluate(() => Array.from(document.querySelectorAll('#results .grid .item-card .item-media')).map((tile) => ({
      pending: tile.classList.contains('is-pending'),
      light: getComputedStyle(tile, '::after').animationName,
      photo: getComputedStyle(tile.querySelector('img')).opacity
    })));
    const waiting = await tiles();
    assert.deepStrictEqual(waiting[0], { pending: true, light: 'reflect', photo: '0' }, 'a photo still on its way is shown half-loaded, or without the light');
    /* the photo the browser already had is simply there: frame by frame
       it is never caught part-way through a fade */
    const cached = await page.evaluate(() => new Promise((resolve) => {
      const img = document.querySelectorAll('#results .grid .item-card .item-media img')[1];
      const seen = [];
      const start = performance.now();
      const tick = () => {
        seen.push(Number(getComputedStyle(img).opacity));
        if (performance.now() - start < 700) requestAnimationFrame(tick); else resolve(seen);
      };
      tick();
    }));
    assert.ok(cached.every((o) => o === 0 || o === 1), `a photo the browser already had faded in (${cached.filter((o) => o > 0 && o < 1).length} frames part-way)`);
    assert.strictEqual(cached[cached.length - 1], 1, 'a photo the browser already had never showed');
    await page.waitForFunction(() => {
      const tile = document.querySelector('#results .grid .item-card .item-media');
      return !tile.classList.contains('is-pending') && !tile.classList.contains('is-arriving') && getComputedStyle(tile.querySelector('img')).opacity === '1';
    }, null, { timeout: 4000 });
    assert.strictEqual(await page.$eval('#results .grid .item-card .item-media', (tile) => getComputedStyle(tile, '::after').animationName), 'none', 'the light stayed on a photo that had arrived');
    await page.close();
  });

  await test('while it works, the box, the words and the first row of placeholders are all on screen', async () => {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      reset();
      const search = deferred();
      stubs.search = { hold: search.held };
      const page = await open();
      await page.setViewportSize(viewport);
      await submit(page, 'an overshirt for the weekend');
      await page.waitForSelector('#results .search-progress[data-stage="searching"]');
      await scrollSettled(page);
      const g = await page.evaluate(() => ({
        header: document.querySelector('.site-header').getBoundingClientRect().bottom,
        box: document.getElementById('ask-form').getBoundingClientRect().top,
        words: document.querySelector('#results .search-progress').getBoundingClientRect().bottom,
        placeholder: document.querySelector('#results .skeleton-card').getBoundingClientRect().top,
        viewport: window.innerHeight
      }));
      assert.ok(g.box >= g.header, `${viewport.width}px: the box went under the header`);
      assert.ok(g.words <= g.viewport, `${viewport.width}px: the stage line is off screen`);
      assert.ok(g.placeholder < g.viewport - 100, `${viewport.width}px: the placeholders are off screen (${g.placeholder} of ${g.viewport})`);
      search.release();
      await page.waitForSelector('#results .grid .item-card');
      await page.close();
    }
  });

  await test('with reduced motion nothing travels or fades: a still line, still placeholders, and results that are simply there', async () => {
    reset();
    const search = deferred();
    stubs.search = { hold: search.held, reply: answerWith(pieces(8)) };
    const page = await browser.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      window.FINDWEAR_API = 'http://127.0.0.1:8899/api/interpret';
      window.FINDWEAR_SEARCH_API = 'http://127.0.0.1:8899/api/search';
    });
    await page.route((url) => !String(url).includes('127.0.0.1'), (route) => route.abort());
    await page.goto(`http://127.0.0.1:${PORT}/find-clothes.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
    await submit(page, 'an overshirt for the weekend');
    await page.waitForSelector('#results .search-progress[data-stage="searching"]');
    const still = await page.evaluate(() => {
      const css = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
      return {
        light: ['.ask-progress-line', '.ask-progress'].map((sel) => css(`#ask-form ${sel}`, '::after').animationName)
          .concat(css('#ask-form', '::after').animationName, css('#ask-form .ask-progress', '::before').animationName),
        placeholder: [css('#results .skeleton-card').animationName, css('#results .skeleton-card').opacity, css('#results .skeleton-card', '::after').animationName]
      };
    });
    assert.deepStrictEqual(still.light, ['none', 'none', 'none', 'none'], 'light still travels for someone who asked for less motion');
    assert.deepStrictEqual(still.placeholder, ['none', '1', 'none'], 'the placeholders move or fade');
    search.release();
    await page.waitForSelector('#results .grid .item-card');
    const arrived = await page.evaluate(() => ({
      leaving: document.querySelectorAll('#results .results-leaving').length,
      cards: Array.from(document.querySelectorAll('#results .grid .item-card')).map((c) => getComputedStyle(c).animationName),
      light: getComputedStyle(document.querySelector('#ask-form .ask-progress')).visibility
    }));
    assert.strictEqual(arrived.leaving, 0, 'something was left fading out');
    assert.ok(arrived.cards.every((name) => name === 'none'), 'the cards animate in');
    await page.close();
  });

  reset();

  console.log('\nlive searches left, in the search box');

  /* every category Discover offers and every subcategory under it, then
     back to the shelves: the whole of Discover, used once */
  const browseAllOfDiscover = async (page) => {
    await page.waitForSelector('.shelf .item-card', { timeout: 10000 });
    let used = 0;
    const tabs = await page.$$eval('#discover-tabs button', (ns) => ns.length);
    for (let c = 0; c < tabs; c++) {
      await page.click(`#discover-tabs button >> nth=${c}`); used += 1;
      const pills = await page.$$eval('#discover-panel button.pill', (ns) => ns.length);
      for (let p = 0; p < pills; p++) { await page.click(`#discover-panel button.pill >> nth=${p}`); used += 1; }
      while (await page.$('#active-filters [data-remove]')) await page.click('#active-filters [data-remove] >> nth=0');
    }
    await page.click('#results-clear');
    return used;
  };

  const SIGNED_IN = { signedIn: true, user: { id: 'usr_1', email: 'ada@example.test', name: 'Ada', emailVerified: true } };

  /* the count in words, and whether the allowance — words and bar — is
     on screen at all */
  const usageOf = (page) => page.evaluate(() => {
    const block = document.getElementById('ask-allowance');
    const el = document.getElementById('ask-usage');
    const css = getComputedStyle(block);
    return {
      text: el.textContent.trim(),
      hidden: block.hidden,
      visible: !block.hidden && css.display !== 'none' && css.visibility !== 'hidden' && el.getBoundingClientRect().height > 0 && el.textContent.trim() !== ''
    };
  });

  const usageSays = (page, text) => page.waitForFunction((t) => document.getElementById('ask-usage').textContent.trim() === t, text, { timeout: 5000 })
    .catch(async () => { throw new Error(`the box says "${(await usageOf(page)).text}", not "${text}"`); });

  const accountReads = () => stubs.log.filter((e) => e.path === '/api/account' && e.event === 'request').length;

  /* the allowance bar as drawn: how many steps, how much of its width is
     filled, in what colour, and what each colour is in the palette */
  const meterOf = (page) => page.evaluate(() => {
    const meter = document.getElementById('ask-meter');
    const box = meter.getBoundingClientRect();
    const steps = [...meter.querySelectorAll('.ask-meter-step')];
    const fill = meter.querySelector('.ask-meter-fill');
    const filled = steps.length ? steps.filter((n) => n.classList.contains('is-left')) : (fill ? [fill] : []);
    const probe = document.createElement('span');
    document.body.appendChild(probe);
    const token = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
    const palette = Object.fromEntries(['--color-accent', '--color-accent-ink', '--color-primary', '--color-surface-3', '--color-warning', '--color-success']
      .map((name) => [token(name), name]));
    probe.remove();
    const colour = (n) => palette[getComputedStyle(n).backgroundColor] || getComputedStyle(n).backgroundColor;
    return {
      steps: steps.length,
      smooth: Boolean(meter.querySelector('.ask-meter-track')),
      share: box.width ? filled.reduce((sum, n) => sum + n.getBoundingClientRect().width, 0) / box.width : 0,
      ink: filled.length ? [...new Set(filled.map(colour))] : [],
      track: [...new Set([...meter.querySelectorAll('.ask-meter-step:not(.is-left), .ask-meter-track')].map(colour))],
      width: box.width,
      ariaHidden: meter.getAttribute('aria-hidden'),
      text: meter.textContent,
      drawn: meter.children.length > 0
    };
  });

  await test('a Free shopper sees the live searches left before typing anything, in the box\'s quiet metadata', async () => {
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    const page = await open();
    await usageSays(page, '3 searches left today');
    const inks = await resolveInks(page);
    const shown = await page.evaluate(() => {
      const el = document.getElementById('ask-usage');
      const css = getComputedStyle(el);
      return {
        inBox: el.closest('#ask-form') !== null,
        typed: document.getElementById('ask').value,
        size: parseFloat(css.fontSize),
        field: parseFloat(getComputedStyle(document.getElementById('ask')).fontSize),
        weight: css.fontWeight,
        color: css.color,
        status: document.getElementById('search-status').textContent
      };
    });
    assert.ok(shown.inBox, 'the count is not in the search box');
    assert.strictEqual(shown.typed, '');
    assert.strictEqual(inks[shown.color], '--color-text-muted', `the count is set in ${shown.color}, not the muted ink`);
    assert.ok(shown.size <= 14 && shown.size < shown.field, `the count (${shown.size}px) competes with the field (${shown.field}px)`);
    assert.strictEqual(shown.weight, '400');
    /* read, not announced: nothing is said to a screen reader on arrival */
    assert.strictEqual(shown.status, '');
    /* and reading it spent nothing */
    assert.deepStrictEqual(stubs.log.filter((e) => e.path !== '/api/account'), []);
    assert.strictEqual(accountState.usage.searches.used, 0);
    await page.close();
  });

  await test('the bar shows what is left of the Free allowance, a step a search, in the accent blue, from the server\'s own count', async () => {
    /* the shrinking fill is the signal: whatever is left is the accent
       blue at every count, and nothing left is the bare grey track */
    const expected = [
      /* left, share of the bar filled, ink */
      [3, 1, '--color-accent'],
      [2, 2 / 3, '--color-accent'],
      [1, 1 / 3, '--color-accent'],
      [0, 0, null]
    ];
    const widths = [];
    for (const [left, share, ink] of expected) {
      reset();
      accountState = accountReply({ searchesUsed: 3 - left });
      const page = await open();
      await usageSays(page, left ? `${left} ${left === 1 ? 'search' : 'searches'} left today` : 'No live searches left today');
      const bar = await meterOf(page);
      assert.strictEqual(bar.steps, 3, `${left} left: ${bar.steps} steps for a three-search allowance`);
      /* the gaps between steps are the only thing between the fill and the share */
      assert.ok(Math.abs(bar.share - share) <= 0.03, `${left} left: ${bar.share.toFixed(3)} of the bar is filled, not ${share.toFixed(3)}`);
      assert.deepStrictEqual(bar.ink, ink ? [ink] : [], `${left} left: filled in ${bar.ink}`);
      assert.deepStrictEqual(bar.track, left === 3 ? [] : ['--color-surface-3'], `${left} left: the empty steps are ${bar.track}`);
      widths.push(bar.width);
      await page.close();
    }
    /* one bar, the same length at every count, so only its fill changes */
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 0.5, `the bar changes length with the count: ${widths.join(', ')}`);
    accountState = accountReply({});
  });

  await test('Pro and Max are one smooth fill of remaining over limit — and the bar follows the server\'s limit, not Free\'s', async () => {
    const cases = [
      /* state, smooth?, steps, share */
      [{ planId: 'pro', searchesUsed: 3, extra: SIGNED_IN }, true, 0, 97 / 100],
      [{ planId: 'max', searchesUsed: 3, extra: SIGNED_IN }, true, 0, 497 / 500],
      [{ planId: 'pro', searchesUsed: 50, extra: SIGNED_IN }, true, 0, 50 / 100],
      [{ planId: 'pro', searchesUsed: 80, extra: SIGNED_IN }, true, 0, 20 / 100],
      [{ planId: 'max', searchesUsed: 500, extra: SIGNED_IN }, true, 0, 0]
    ];
    for (const [state, smooth, steps, share] of cases) {
      reset();
      accountState = accountReply(state);
      const page = await open();
      await page.waitForFunction(() => document.getElementById('ask-usage').textContent.trim());
      const bar = await meterOf(page);
      const what = `${state.planId} with ${accountState.usage.searches.remaining} of ${accountState.usage.searches.limit}`;
      assert.strictEqual(bar.smooth, smooth, `${what}: not one smooth fill`);
      assert.strictEqual(bar.steps, steps, `${what}: drawn as ${bar.steps} slivers`);
      assert.ok(Math.abs(bar.share - share) <= 0.01, `${what}: ${bar.share.toFixed(3)} filled, not ${share.toFixed(3)}`);
      assert.deepStrictEqual(bar.ink, share ? ['--color-accent'] : [], `${what}: filled in ${bar.ink}`);
      assert.deepStrictEqual(bar.track, ['--color-surface-3'], what);
      await page.close();
    }
    /* whatever allowance the server reports is the one drawn: five
       searches are five steps, forty are a smooth fill */
    for (const [limit, remaining, steps, share] of [[5, 2, 5, 2 / 5], [40, 10, 0, 10 / 40]]) {
      reset();
      accountState = accountReply({ searchesUsed: 0 });
      accountState.usage.searches = Object.assign({}, accountState.usage.searches, { limit, used: limit - remaining, remaining });
      const page = await open();
      await usageSays(page, `${remaining} searches left today`);
      const bar = await meterOf(page);
      assert.strictEqual(bar.steps, steps, `${remaining} of ${limit}: ${bar.steps} steps`);
      assert.ok(Math.abs(bar.share - share) <= 0.03, `${remaining} of ${limit}: ${bar.share.toFixed(3)} filled`);
      await page.close();
    }
    accountState = accountReply({});
  });

  await test('the count is the account\'s own: signed-in Free, Pro and Max, in the period the server counts it', async () => {
    const cases = [
      [{ planId: 'free', searchesUsed: 1, extra: SIGNED_IN }, '2 searches left today'],
      [{ planId: 'free', searchesUsed: 2 }, '1 search left today'],
      [{ planId: 'pro', searchesUsed: 3, extra: SIGNED_IN }, '97 searches left this month'],
      [{ planId: 'max', searchesUsed: 3, extra: SIGNED_IN }, '497 searches left this month']
    ];
    for (const [state, said] of cases) {
      for (const file of ['find-clothes.html']) {
        reset();
        accountState = accountReply(state);
        const page = await openPage(file);
        await usageSays(page, said);
        await page.close();
      }
    }
    /* the page knows no plan's limit: whatever the server counts, in
       whatever period, is what it says */
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    accountState.usage.searches = Object.assign({}, accountState.usage.searches, { limit: 7, used: 2, remaining: 5, period: 'month' });
    const page = await open();
    await usageSays(page, '5 searches left this month');
    await page.close();
    accountState = accountReply({});
  });

  await test('starting a search hands the box to the hairline; the answer brings back the count the server now holds', async () => {
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    stubs.charge = true;
    const interpret = deferred();
    const search = deferred();
    stubs.interpret = { hold: interpret.held, reply: reading('black oversized hoodie under $80') };
    stubs.search = { hold: search.held };
    const page = await open();
    await usageSays(page, '3 searches left today');
    await submit(page, 'black oversized hoodie under $80');
    await page.waitForSelector('#ask-form[data-stage="understanding"]');
    assert.deepStrictEqual(await usageOf(page), { text: '', hidden: false, visible: false }, 'the count stayed beside the hairline');
    assert.strictEqual((await meterOf(page)).drawn, false, 'the allowance bar stayed beside the hairline');
    assert.deepStrictEqual(await boxLine(page), { stage: 'understanding', shown: true });
    stubs.interpret = null;
    interpret.release();
    await page.waitForSelector('#ask-form[data-stage="searching"]');
    assert.strictEqual((await usageOf(page)).visible, false);
    assert.deepStrictEqual(await boxLine(page), { stage: 'searching', shown: true });
    const readsBefore = accountReads();
    search.release();
    await page.waitForSelector('.item-card');
    await usageSays(page, '2 searches left today');
    assert.ok(accountReads() > readsBefore, 'the new count was not read from the account');
    assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false });
    const after = await meterOf(page);
    assert.ok(after.steps === 3 && Math.abs(after.share - 2 / 3) <= 0.03, `the bar came back at ${after.share.toFixed(3)}`);

    /* a search the server did not count leaves the count where it was:
       the page takes nothing off by itself */
    stubs.charge = false;
    await submit(page, 'white sneakers');
    await page.waitForFunction(() => !document.querySelector('#results .search-progress') && document.querySelector('.item-card'));
    await usageSays(page, '2 searches left today');
    assert.ok(Math.abs((await meterOf(page)).share - 2 / 3) <= 0.03, 'an uncounted search moved the bar');

    /* nor does a search that failed before it was counted */
    stubs.search = { status: 502 };
    await submit(page, 'grey hoodie');
    await page.waitForFunction(() => /unavailable/i.test((document.querySelector('.results-head h2') || {}).textContent || ''));
    await usageSays(page, '2 searches left today');
    assert.ok(Math.abs((await meterOf(page)).share - 2 / 3) <= 0.03, 'a failed search moved the bar');
    stubs.search = null;

    /* and a count that moved elsewhere — another tab, another device —
       is the one shown */
    const another = deferred();
    stubs.search = { hold: another.held };
    await submit(page, 'linen shirt');
    await page.waitForSelector('#ask-form[data-stage="searching"]');
    accountState.usage.searches.used = 2;
    accountState.usage.searches.remaining = 1;
    another.release();
    await page.waitForSelector('.item-card');
    await usageSays(page, '1 search left today');
    assert.ok(Math.abs((await meterOf(page)).share - 1 / 3) <= 0.03, 'the bar does not follow the server');
    await page.close();
    accountState = accountReply({});
  });

  await test('between the answer and the account\'s new count, the box shows no count at all, and keeps its size', async () => {
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    stubs.charge = true;
    const page = await open();
    await usageSays(page, '3 searches left today');
    const height = await page.$eval('#ask-form', (n) => n.getBoundingClientRect().height);
    const recount = deferred();
    stubs.account = { hold: recount.held };
    await submit(page, 'black oversized hoodie');
    await page.waitForSelector('.item-card');
    await page.waitForFunction(() => document.querySelector('#ask-form').dataset.stage === undefined);
    assert.deepStrictEqual(await usageOf(page), { text: '', hidden: false, visible: false }, 'the old count came back before the new one');
    assert.strictEqual(await page.$eval('#ask-form', (n) => n.getBoundingClientRect().height), height);
    recount.release();
    await usageSays(page, '2 searches left today');
    assert.strictEqual(await page.$eval('#ask-form', (n) => n.getBoundingClientRect().height), height);
    await page.close();
    accountState = accountReply({});
  });

  await test('Discover spends no live search and leaves the count where it was', async () => {
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    stubs.charge = true;
    const before = await open();
    await usageSays(before, '3 searches left today');
    await before.close();

    const discover = await openPage('discover.html', { photos: true });
    await browseAllOfDiscover(discover);
    await discover.close();
    assert.deepStrictEqual(stubs.log.filter((e) => e.path === '/api/search' || e.path === '/api/interpret'), [], 'Discover reached a live endpoint');
    assert.strictEqual(accountState.usage.searches.used, 0, 'Discover was counted as a search');

    const after = await open();
    await usageSays(after, '3 searches left today');
    assert.ok((await meterOf(after)).share > 0.95, 'Discover emptied the bar');
    await after.close();
    accountState = accountReply({});
  });

  await test('with no live searches left the box says so plainly, typing still works, and the limit answer is the existing one', async () => {
    reset();
    accountState = accountReply({ searchesUsed: 3 });
    const page = await open();
    await usageSays(page, 'No live searches left today');
    const inks = await resolveInks(page);
    const color = await page.$eval('#ask-usage', (n) => getComputedStyle(n).color);
    assert.strictEqual(inks[color], '--color-text-muted', 'the limit is shown as a warning');
    const control = await page.evaluate(() => ({
      disabled: document.getElementById('ask').disabled || document.getElementById('ask').readOnly,
      button: document.querySelector('#ask-form button[type=submit]').disabled
    }));
    assert.deepStrictEqual(control, { disabled: false, button: false }, 'the box was locked');
    stubs.search = { status: 429 };
    await submit(page, 'black oversized hoodie');
    await page.waitForFunction(() => /No searches left/.test((document.querySelector('.results-head h2') || {}).textContent || ''));
    await usageSays(page, 'No live searches left today');
    await page.close();

    reset();
    accountState = accountReply({ planId: 'pro', searchesUsed: 100, extra: SIGNED_IN });
    const pro = await open();
    await usageSays(pro, 'No live searches left this month');
    await pro.close();
    accountState = accountReply({});
  });

  await test('when the account cannot be read, no number is shown — never a guess', async () => {
    for (const [why, failure] of [['not deployed', { status: 404 }], ['a server error', { status: 500 }], ['a dropped connection', { drop: true }]]) {
      reset();
      accountState = accountReply({ searchesUsed: 0 });
      stubs.account = failure;
      const page = await open();
      await page.waitForFunction(() => document.getElementById('ask-allowance').hidden, null, { timeout: 5000 })
        .catch(() => { throw new Error(`${why}: the row was not given up`); });
      const shown = await usageOf(page);
      assert.deepStrictEqual(shown, { text: '', hidden: true, visible: false }, why);
      assert.strictEqual((await meterOf(page)).drawn, false, `${why}: a bar was drawn without a count`);
      await page.close();
    }

    /* a re-read that fails after a good one says nothing, rather than
       leaving the count from before the search on screen */
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    stubs.charge = true;
    const page = await open();
    await usageSays(page, '3 searches left today');
    const height = await page.$eval('#ask-form', (n) => n.getBoundingClientRect().height);
    stubs.account = { status: 500 };
    const answered = stubs.log.filter((e) => e.path === '/api/account' && e.event === 'reply').length;
    await submit(page, 'black oversized hoodie');
    await page.waitForSelector('.item-card');
    /* the re-read has been refused, and the page has had time to hear it */
    for (let i = 0; i < 50 && stubs.log.filter((e) => e.path === '/api/account' && e.event === 'reply').length === answered; i += 1) await page.waitForTimeout(50);
    assert.ok(stubs.log.filter((e) => e.path === '/api/account' && e.event === 'reply').length > answered, 'the account was not read again');
    await page.waitForTimeout(300);
    assert.deepStrictEqual(await usageOf(page), { text: '', hidden: false, visible: false }, 'a stale or guessed count after a failed re-read');
    assert.strictEqual((await meterOf(page)).drawn, false, 'a stale or guessed bar after a failed re-read');
    assert.strictEqual(await page.$eval('#ask-form', (n) => n.getBoundingClientRect().height), height, 'the box changed size');
    await page.close();
    accountState = accountReply({});
  });

  /* where the count's own words are, as drawn */
  const usageGeometry = (page) => page.evaluate(() => {
    const el = document.getElementById('ask-usage');
    const range = document.createRange();
    range.selectNodeContents(el);
    const words = range.getBoundingClientRect();
    const box = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    const form = document.getElementById('ask-form');
    const css = getComputedStyle(form);
    return {
      words: box({ getBoundingClientRect: () => words }),
      bar: box(document.getElementById('ask-meter')),
      button: box(form.querySelector('button[type=submit]')),
      content: { left: form.getBoundingClientRect().left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft) },
      row: box(el),
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      clipped: el.scrollWidth > el.clientWidth,
      form: box(form),
      border: parseFloat(getComputedStyle(form).borderBottomWidth),
      parts: ['ask', 'reset-form'].map((id) => document.getElementById(id))
        .concat([form.querySelector('.attach-btn'), form.querySelector('button[type=submit]')])
        .filter((node) => node.getBoundingClientRect().height > 0)
        .map((node) => Object.assign({ name: node.id || node.className || node.tagName }, box(node))),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

  await test('the count fits on one line in the box, beside nothing, at every width — and the box never changes size for it', async () => {
    const widths = [1440, 1280, 1024, 820, 768, 767, 480, 390, 375];
    const runs = widths.map((width) => ['find-clothes.html', width]);
    for (const [file, width] of runs) {
      const where = `${file} at ${width}px`;
      reset();
      /* the longest thing it says */
      accountState = accountReply({ planId: 'max', searchesUsed: 3, extra: SIGNED_IN });
      stubs.charge = true;
      const first = deferred();
      stubs.account = { hold: first.held };
      const search = deferred();
      stubs.search = { hold: search.held };
      const page = await openPage(file);
      await page.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
      await page.setViewportSize({ width, height: width < 768 ? 860 : 900 });
      await page.fill('#ask', 'black oversized hoodie under $80');
      const waiting = await boxGeometry(page);
      first.release();
      await usageSays(page, '497 searches left this month');
      const idle = await boxGeometry(page);
      for (const side of ['top', 'left', 'width', 'height']) {
        assert.ok(Math.abs(idle.form[side] - waiting.form[side]) <= 0.5, `${where}: the box's ${side} changed when the count arrived (${waiting.form[side]} → ${idle.form[side]})`);
      }
      const g = await usageGeometry(page);
      assert.ok(g.words.height <= g.lineHeight + 0.5 && g.row.height <= g.lineHeight + 0.5, `${where}: the count wraps (${g.row.height}px)`);
      assert.strictEqual(g.clipped, false, `${where}: the count is cut off`);
      assert.ok(g.words.left >= g.form.left && g.words.right <= g.form.right && g.words.bottom <= g.form.bottom - g.border, `${where}: the count is outside the box`);
      for (const part of g.parts) assert.ok(!overlap(g.words, part), `${where}: the count runs into ${part.name}`);
      assert.strictEqual(g.overflow, 0, `${where}: the page scrolls sideways`);
      /* the bar: thin, inside the box, over nothing, and clearly visible */
      assert.ok(g.bar.height >= 3 && g.bar.height <= 6, `${where}: the bar is ${g.bar.height}px thick`);
      assert.ok(g.bar.left >= g.form.left && g.bar.right <= g.form.right && g.bar.bottom <= g.form.bottom - g.border, `${where}: the bar is outside the box`);
      assert.ok(!overlap(g.bar, g.words), `${where}: the bar runs into the count`);
      for (const part of g.parts) assert.ok(!overlap(g.bar, part), `${where}: the bar runs into ${part.name}`);
      if (width <= 767) {
        /* stacked under the full-width button: as wide as it, the words
           under the bar */
        assert.ok(Math.abs(g.bar.left - g.button.left) <= 1 && Math.abs(g.bar.right - g.button.right) <= 1, `${where}: the bar runs ${g.bar.left}–${g.bar.right}, the button ${g.button.left}–${g.button.right}`);
        assert.ok(g.bar.bottom <= g.words.top, `${where}: the bar is not above the count`);
        /* the allowance adds a short band under the button, no more */
        assert.ok(g.form.bottom - g.button.bottom <= 50, `${where}: ${g.form.bottom - g.button.bottom}px of box under the button`);
      } else {
        /* a compact box, with one row for the allowance: the bar from the
           box's content edge, the words beside it ending under the Search
           button */
        assert.ok(g.form.height >= 80 && g.form.height <= 90, `${where}: the box is ${g.form.height}px tall`);
        assert.ok(Math.abs(g.bar.left - g.content.left) <= 1, `${where}: the bar starts at ${g.bar.left}, not ${g.content.left}`);
        assert.ok(Math.abs(g.words.right - g.button.right) <= 1, `${where}: the count ends at ${g.words.right}, the button at ${g.button.right}`);
        assert.ok(g.bar.right <= g.words.left - 8, `${where}: the bar runs up to the count`);
        const middle = (r) => (r.top + r.bottom) / 2;
        assert.ok(Math.abs(middle(g.bar) - middle(g.words)) <= 2, `${where}: the bar and the count are not on one row`);
        assert.ok(g.bar.width >= 0.5 * g.form.width, `${where}: the bar is ${g.bar.width}px of a ${g.form.width}px box`);
      }

      await page.focus('#ask');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#ask-form[data-stage="searching"]');
      const during = await boxGeometry(page);
      assert.strictEqual((await usageOf(page)).visible, false, `${where}: the count is on screen with the hairline`);
      assert.strictEqual(during.shown, true, `${where}: no hairline`);
      for (const side of ['top', 'left', 'width', 'height']) {
        assert.ok(Math.abs(during.form[side] - idle.form[side]) <= 0.5, `${where}: the box's ${side} changed when the search started`);
      }
      search.release();
      await page.waitForSelector('.item-card');
      await usageSays(page, '496 searches left this month');
      const after = await boxGeometry(page);
      for (const side of ['top', 'left', 'width', 'height']) {
        assert.ok(Math.abs(after.form[side] - idle.form[side]) <= 0.5, `${where}: the box's ${side} changed after the search`);
      }
      assert.strictEqual(after.overflow, 0, `${where}: the results scroll sideways`);
      await page.close();
    }
    accountState = accountReply({});
  });

  await test('screen readers hear the count with the field, and once more, briefly, when a search changes it', async () => {
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    stubs.charge = true;
    const page = await open();
    await usageSays(page, '3 searches left today');
    const wiring = await page.evaluate(() => {
      const field = document.getElementById('ask');
      const ids = (field.getAttribute('aria-describedby') || '').split(/\s+/);
      const el = document.getElementById('ask-usage');
      return {
        describes: ids.includes('ask-usage'),
        hidden: el.closest('[aria-hidden="true"]') !== null,
        live: el.getAttribute('aria-live') || el.getAttribute('role') || null
      };
    });
    /* part of the field's description, and not a live region of its own,
       so it is never said twice */
    assert.deepStrictEqual(wiring, { describes: true, hidden: false, live: null });
    /* the bar is a picture of those words: hidden from assistive
       technology, with nothing in it to read */
    const bar = await meterOf(page);
    assert.deepStrictEqual({ hidden: bar.ariaHidden, text: bar.text }, { hidden: 'true', text: '' });

    await submit(page, 'black oversized hoodie');
    await page.waitForSelector('.item-card');
    await usageSays(page, '2 searches left today');
    await page.waitForFunction(() => document.getElementById('search-status').textContent.trim() === '1 piece found. 2 searches left today.', null, { timeout: 5000 })
      .catch(async () => { throw new Error(`said "${await page.$eval('#search-status', (n) => n.textContent)}"`); });
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ask', 'focus moved');

    /* a search that was not counted changes nothing, so nothing more is said */
    stubs.search = { status: 502 };
    await submit(page, 'white sneakers');
    await page.waitForFunction(() => /unavailable/i.test((document.querySelector('.results-head h2') || {}).textContent || ''));
    await usageSays(page, '2 searches left today');
    await page.waitForTimeout(300);
    const said = await page.$eval('#search-status', (n) => n.textContent);
    assert.ok(!/searches? left/.test(said), `an unchanged count was announced: "${said}"`);
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'ask', 'focus moved');
    await page.close();
    accountState = accountReply({});
  });

  await test('the allowance comes back with a short fade, and at once for anyone who asks for reduced motion', async () => {
    const fadeOf = (page) => page.evaluate(() => {
      const css = getComputedStyle(document.getElementById('ask-allowance'));
      return { fade: parseFloat(css.transitionDuration), opacity: css.opacity, animated: [...document.querySelectorAll('#ask-meter *')].some((n) => getComputedStyle(n).animationName !== 'none') };
    });
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    const moving = await open();
    await usageSays(moving, '3 searches left today');
    const normal = await fadeOf(moving);
    assert.ok(normal.fade > 0 && normal.fade <= 0.3, `the allowance fades in over ${normal.fade}s`);
    /* the bar itself never moves: it is a level, not an activity */
    assert.strictEqual(normal.animated, false);
    await moving.close();

    reset();
    const still = await browser.newPage();
    await still.emulateMedia({ reducedMotion: 'reduce' });
    await still.addInitScript(() => {
      window.FINDWEAR_API = 'http://127.0.0.1:8899/api/interpret';
      window.FINDWEAR_SEARCH_API = 'http://127.0.0.1:8899/api/search';
    });
    await still.route((url) => !String(url).includes('127.0.0.1'), (route) => route.abort());
    await still.goto(`http://127.0.0.1:${PORT}/find-clothes.html`, { waitUntil: 'domcontentloaded' });
    await still.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
    await usageSays(still, '3 searches left today');
    const reduced = await fadeOf(still);
    assert.ok(reduced.fade < 0.001, `the allowance still fades: ${reduced.fade}s`);
    assert.strictEqual(reduced.opacity, '1');
    assert.strictEqual(reduced.animated, false);
    await still.close();
    accountState = accountReply({});
  });

  await test('the count waits on the account and nothing else: no timer, and no arithmetic of its own', async () => {
    reset();
    accountState = accountReply({ searchesUsed: 0 });
    const held = deferred();
    stubs.account = { hold: held.held };
    const page = await open();
    await page.waitForTimeout(300);
    assert.strictEqual((await usageOf(page)).text, '', 'a count before the account answered');
    held.release();
    await usageSays(page, '3 searches left today');
    const shown = Date.now();
    const reply = stubs.log.filter((e) => e.path === '/api/account' && e.event === 'reply').pop();
    assert.ok(shown - reply.at < 400, `the count took ${shown - reply.at}ms to appear after the account answered`);
    await page.close();

    const app = fs.readFileSync(path.join(REPO, 'assets', 'app.js'), 'utf8');
    const code = app.slice(app.indexOf('how many live searches are left'), app.indexOf('let latest = 0'));
    assert.ok(code.length > 400, 'the count\'s code moved');
    assert.ok(!/setTimeout|setInterval|requestAnimationFrame|\.sleep|delay\(/.test(code), 'the count waits on a timer');
    /* it repeats what the server counted; it never works a count out */
    assert.ok(!/\.used\b|\blimit\s*-|\b(left|remaining)\s*[-+]=?\s*[\w(]|\b(3|100|500)\b/.test(code), 'the page works out the count itself');
    /* the words are the server's remaining, and the bar is the server's
       remaining over the server's limit */
    assert.ok(/searches\.remaining/.test(code) && /searches\.limit/.test(code), 'the allowance is not read from the server');
    accountState = accountReply({});
  });

  reset();
  accountState = accountReply({});

  console.log('\nproduct photos');

  /* Both URLs are on this origin, because the page under test aborts
     every off-origin request: a photo has to really 404 or really load,
     not be cut off by the harness. */
  const DEAD_PHOTO = `http://127.0.0.1:${PORT}/assets/no-such-photo.jpg`;
  const REAL_PHOTO = `http://127.0.0.1:${PORT}/assets/demo/fynd-demo-poster.jpg`;

  /* Renders one card into a container of its own, so the assertions are
     about that card and not about whatever else the page has drawn. */
  const cardInPage = ({ id, product }) => {
    const box = document.createElement('div');
    box.id = id;
    box.innerHTML = productCard(product);
    document.body.appendChild(box);
    bindImageFallback(box);
  };

  await test('a live product whose photo fails draws artwork, not a blank tile', async () => {
    searchRequests.length = 0;
    const page = await open();
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.item-card', { timeout: 10000 });
    /* the API's product is not in the catalogue store, and never will be:
       that is exactly the case the fallback used to give up on */
    assert.strictEqual(await page.evaluate(() => Products.byId('1')), null,
      'a live result must not be in the store, or this proves nothing');
    await page.waitForSelector('.item-media svg.silhouette', { timeout: 10000 });
    assert.strictEqual(await page.$$eval('.item-media img', (n) => n.length), 0,
      'the dead photo must be replaced, not left in place');
    await page.close();
  });

  await test('a catalogue row whose photo fails still draws its own garment', async () => {
    const page = await open();
    /* the row goes into the store first, because that is what a catalogue
       row is: something the store can still name once its photo is gone */
    await page.evaluate(({ url }) => {
      Products.set([{ id: 'demo-jacket', name: 'Wool Coat', brand: 'Fynd', category: 'jacket',
        price: 120, imageUrl: url, productUrl: 'https://example.com/p/1' }]);
      const box = document.createElement('div');
      box.id = 'photo-demo';
      box.innerHTML = productCard(Products.byId('demo-jacket'));
      document.body.appendChild(box);
      bindImageFallback(box);
    }, { url: DEAD_PHOTO });
    await page.waitForSelector('#photo-demo svg.silhouette', { timeout: 10000 });
    /* both sides are read back out of the DOM, so the comparison is
       between drawings rather than between two spellings of one */
    const drawn = await page.evaluate(() => {
      const draw = (category) => {
        const box = document.createElement('div');
        box.innerHTML = artSvg({ category });
        return box.querySelector('svg').innerHTML;
      };
      return {
        got: document.querySelector('#photo-demo svg.silhouette').innerHTML,
        jacket: draw('jacket'),
        fallback: draw('')
      };
    });
    assert.strictEqual(drawn.got, drawn.jacket, 'a row the store knows keeps the garment its category names');
    assert.notStrictEqual(drawn.got, drawn.fallback, 'it must not collapse to the category-less default');
    await page.close();
  });

  await test('a photo that loads is left exactly as it was', async () => {
    const page = await open();
    await page.evaluate(cardInPage, {
      id: 'photo-ok',
      product: { id: 'live-ok', name: 'Champion Hoodie', retailer: 'Nordstrom', price: 68,
        imageUrl: REAL_PHOTO, productUrl: 'https://www.nordstrom.com/s/hoodie/1' }
    });
    await page.waitForFunction(() => {
      const img = document.querySelector('#photo-ok img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    }, { timeout: 10000 });
    /* long enough that a late replacement would have happened */
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => ({
      photos: document.querySelectorAll('#photo-ok img').length,
      artwork: document.querySelectorAll('#photo-ok svg.silhouette').length,
      src: document.querySelector('#photo-ok img').getAttribute('src')
    }));
    assert.deepStrictEqual(state, { photos: 1, artwork: 0, src: REAL_PHOTO });
    await page.close();
  });

  await test("a product's real photo reaches the card and is what renders", async () => {
    /* the whole path a live result takes: /api/search hands back a photo
       URL, the page builds the card, the browser fetches the picture and
       paints it. Nothing about the picture is stubbed except where it
       lives — naturalWidth is the browser saying it decoded real bytes. */
    searchPhoto = REAL_PHOTO;
    try {
      const page = await open();
      await page.fill('#ask', 'black oversized hoodie');
      await page.click('button[type=submit]');
      await page.waitForSelector('.item-card', { timeout: 10000 });
      await page.waitForFunction(() => {
        const img = document.querySelector('.item-media img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }, { timeout: 10000 });

      const card = await page.evaluate(() => {
        const img = document.querySelector('.item-media img');
        const box = img.getBoundingClientRect();
        return {
          src: img.getAttribute('src'),
          alt: img.getAttribute('alt'),
          referrerPolicy: img.getAttribute('referrerpolicy'),
          painted: img.naturalWidth > 0 && img.naturalHeight > 0,
          visible: box.width > 0 && box.height > 0 && getComputedStyle(img).visibility !== 'hidden',
          artwork: document.querySelectorAll('.item-media svg.silhouette').length
        };
      });

      assert.strictEqual(card.src, REAL_PHOTO, 'the card shows the URL the search returned, unchanged');
      assert.strictEqual(card.alt, 'Champion Hoodie', 'the photo is labelled with the product it belongs to');
      assert.strictEqual(card.painted, true, 'the browser decoded the image');
      assert.strictEqual(card.visible, true, 'and it occupies the tile');
      assert.strictEqual(card.artwork, 0, 'no artwork stands in for a photo that loaded');
      await page.close();
    } finally {
      searchPhoto = DEAD_PROVIDER_PHOTO;
    }
  });

  await test('a third-party photo is requested without a referrer', async () => {
    /* a host that refuses foreign referrers answers with a 403 the page
       cannot see, so the photo simply never arrives. This is the one
       thing the card can do about that. */
    /* an address of its own: the Search page's demo film uses this file as
       its poster, and a copy already in the browser's memory would answer
       the card without any request — and without a referrer to inspect */
    searchPhoto = `${REAL_PHOTO}?referrer=${Date.now()}`;
    try {
      const page = await open();
      const sent = [];
      await page.route((url) => String(url).includes('fynd-demo-poster.jpg?referrer='), (route) => {
        sent.push(route.request().headers().referer || null);
        return route.continue();
      });
      await page.fill('#ask', 'black oversized hoodie');
      await page.click('button[type=submit]');
      await page.waitForSelector('.item-media img', { timeout: 10000 });
      await page.waitForFunction(() => {
        const img = document.querySelector('.item-media img');
        return Boolean(img && img.complete);
      }, { timeout: 10000 });

      assert.strictEqual(await page.$eval('.item-media img', (n) => n.referrerPolicy), 'no-referrer');
      assert.ok(sent.length, 'the photo must actually have been requested');
      assert.deepStrictEqual(sent, sent.map(() => null), `no referrer may be sent, got ${JSON.stringify(sent)}`);
      await page.close();
    } finally {
      searchPhoto = DEAD_PROVIDER_PHOTO;
    }
  });

  await test('the fallback changes the picture and nothing else', async () => {
    searchRequests.length = 0;
    const page = await open();
    const before = await page.evaluate(() => Products.all().map((p) => p.id));
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.item-media svg.silhouette', { timeout: 10000 });

    assert.deepStrictEqual(await page.evaluate(() => Products.all().map((p) => p.id)), before,
      'a failed photo writes nothing to the product store');
    assert.strictEqual(searchRequests.length, 1, 'a failed photo does not re-run the search');
    assert.deepStrictEqual(await page.evaluate(() => ({
      retailer: document.querySelector('.item-retailer').textContent.trim(),
      name: document.querySelector('.item-name').textContent.trim(),
      price: document.querySelector('.item-price').textContent.trim(),
      href: document.querySelector('a.item-card').getAttribute('href')
    })), {
      retailer: 'Nordstrom',
      name: 'Champion Hoodie',
      price: '$68',
      href: 'https://www.nordstrom.com/s/hoodie/1'
    }, 'the card still says what the search returned');
    await page.close();
  });

  console.log('\ndiscover');

  /* Discover is a filter over the catalogue already on the page. These
     hold it to that: it offers a lot, across many directions; every
     filter answers from the catalogue's own proved fields, in place;
     and none of it — however much of it is used — searches, reads with
     the AI, calls a product source, spends a search, or leaves the page. */
  const openDiscover = async (width, options) => {
    const page = await openPage('discover.html', Object.assign({ photos: true }, options || {},
      width ? { viewport: { width, height: 900 } } : {}));
    await page.waitForSelector('.shelf .item-card', { timeout: 10000 });
    return page;
  };

  /* what each shelf card says, against the catalogue row it links to */
  const shelfCards = (page) => page.$$eval('.shelf .item-card', (cards) => cards.map((c) => ({
    href: c.getAttribute('href'),
    seller: c.querySelector('.item-retailer').textContent.trim(),
    name: c.querySelector('.item-name').textContent.trim(),
    where: c.querySelector('.item-seller') ? c.querySelector('.item-seller').textContent.trim() : null,
    img: c.querySelector('.item-media img') ? c.querySelector('.item-media img').getAttribute('src') : null,
    artwork: Boolean(c.querySelector('.item-media svg.silhouette'))
  })));
  const rowFor = (href) => CATALOGUE.find((r) => r.productUrl === href);
  const hostOf = (url) => new URL(url).hostname.replace(/^www\d?\./, '');

  /* what the filtered catalogue shows */
  const resultCards = (page) => page.$$eval('#results-body .item-card', (cards) => cards.map((c) => ({
    href: c.getAttribute('href'),
    seller: c.querySelector('.item-retailer').textContent.trim(),
    name: c.querySelector('.item-name').textContent.trim()
  })));
  const pickCategory = (page, label) => page.click(`#discover-tabs button:text-is("${label}")`);
  const pickSub = (page, label) => page.click(`#discover-panel button.pill:text-is("${label}")`);

  /* Discover's six categories, read from its own data file, and an
     independent reading of which proved rows each one holds: whole
     words of the product's own name, a plural matching its singular.
     The page has to agree with this, not with itself. */
  const DISCOVER_DATA = (() => {
    const sandbox = {};
    require('vm').runInNewContext(`${fs.readFileSync(path.join(REPO, 'assets', 'discover-data.js'), 'utf8')}\n;this.d = DISCOVER;`, sandbox);
    return JSON.parse(JSON.stringify(sandbox.d));
  })();
  const SHELVABLE = CATALOGUE.filter((r) => audit.auditRow(r).shelvable);
  const nameOf = (r) => ` ${String(r.name).toLowerCase().replace(/\bt[\s-]?shirt(s?)\b/g, 'tshirt$1').replace(/[^a-z0-9]+/g, ' ')} `;
  const wordRe = (word) => {
    const exact = word.startsWith('=');
    const parts = word.replace(/^=/, '').toLowerCase().replace(/\bt[\s-]?shirt(s?)\b/g, 'tshirt$1').split(/[^a-z0-9]+/).filter(Boolean)
      .map((w) => (exact ? w : `${w.replace(/(es|s)$/, '')}(?:s|es)?`));
    return new RegExp(` ${parts.join(' ')} `);
  };
  const says = (r, words) => words.some((w) => wordRe(w).test(nameOf(r)));
  /* copied out of the catalogue's own context, so the arrays compare */
  const expectedIn = (category, sub) => [...SHELVABLE
    .filter((r) => says(r, category.words) && (!sub || says(r, sub.words))).map((r) => r.productUrl)].sort();

  /* Every request a Discover page makes, sorted by what it would cost.
     A product source or an AI provider is never reached from a browser —
     those calls are made by /api/search and /api/interpret — but they are
     listed anyway, so a change that ever added one fails here too. */
  const COSTLY = {
    'OpenWeb Ninja': (u) => /openwebninja/i.test(u.hostname),
    OpenAI: (u) => /(^|\.)openai\.com$/i.test(u.hostname),
    Serper: (u) => /(^|\.)serper\.dev$/i.test(u.hostname),
    SerpApi: (u) => /(^|\.)serpapi\.com$/i.test(u.hostname),
    Gemini: (u) => /generativelanguage\.googleapis\.com$/i.test(u.hostname),
    '/api/search': (u) => u.pathname === '/api/search',
    '/api/interpret': (u) => u.pathname === '/api/interpret',
    'any other /api/': (u) => u.pathname.startsWith('/api/') && !['/api/search', '/api/interpret'].includes(u.pathname)
  };
  const watchRequests = (page) => {
    const tally = Object.fromEntries(Object.keys(COSTLY).map((k) => [k, 0]));
    const seen = [];
    page.on('request', (req) => {
      const u = new URL(req.url());
      for (const [name, is] of Object.entries(COSTLY)) {
        if (is(u)) { tally[name] += 1; seen.push(`${name}: ${req.url()}`); }
      }
    });
    return { tally, seen };
  };

  await test('Discover is six categories, and nothing else to navigate by', async () => {
    const page = await openDiscover();
    const shown = await page.$$eval('#discover-tabs > *', (ns) => ns.map((n) => n.textContent.trim()));
    assert.deepStrictEqual(shown, ['Tops', 'Bottoms', 'Outerwear', 'One-Piece', 'Comfort', 'Shoes']);
    assert.deepStrictEqual(DISCOVER_DATA.categories.map((c) => c.label), shown, 'the page draws the data file');
    /* the old directions, ideas and ways in are gone */
    for (const gone of ['Style', 'Occasion', 'Season', 'Weather', 'Price', 'Colour', 'Material', 'Fit', 'Trends', 'Brands']) {
      assert.ok(!shown.includes(gone), `${gone} is still a direction`);
    }
    for (const id of ['#discover-ideas', '#discover-edits', '#ideas-shuffle', '#edits-shuffle']) {
      assert.strictEqual(await page.$(id), null, `${id} is still on the page`);
    }
    /* nothing disabled is left behind, and no link goes to the search */
    assert.strictEqual(await page.$$eval('main [aria-disabled], main .pill--unavailable, main button[disabled]', (n) => n.length), 0);
    const links = await page.$$eval('main a[href]', (ns) => ns.map((n) => n.getAttribute('href')));
    links.forEach((h) => assert.ok(rowFor(h), `${h} is not a catalogue listing`));
    await page.close();
  });

  await test('each category filters to exactly the proved rows its name words place in it', async () => {
    const page = await openDiscover();
    for (const category of DISCOVER_DATA.categories) {
      await pickCategory(page, category.label);
      const got = [...(await resultCards(page)).map((c) => c.href)].sort();
      assert.deepStrictEqual(got, expectedIn(category), `${category.label} shows the wrong products`);
      const n = got.length;
      assert.strictEqual(await page.textContent('#results-count'), n ? `${n} ${n === 1 ? 'result' : 'results'}` : 'No matching products');
      assert.strictEqual(await page.$eval('#discover-tabs [aria-pressed="true"]', (b) => b.textContent.trim()), category.label);
      assert.strictEqual(await page.$eval('#discover-shelves', (n) => n.hidden), true, 'the shelves stay up under a filter');
    }
    /* the words are whole words: a short-sleeve tee is not shorts, and
       a t-shirt or sweatshirt is not a button-down shirt */
    await pickCategory(page, 'Bottoms');
    (await resultCards(page)).forEach((c) => assert.ok(!/t-shirt/i.test(c.name), `${c.name} is not a bottom`));
    await pickCategory(page, 'Tops');
    await pickSub(page, 'Button-down shirts');
    (await resultCards(page)).forEach((c) => assert.ok(!/t-shirt|sweatshirt|hoodie/i.test(c.name), `${c.name} is not a button-down`));
    await page.close();
  });

  await test('every supported subcategory filters locally to exactly its proved rows', async () => {
    const page = await openDiscover();
    let checked = 0;
    for (const category of DISCOVER_DATA.categories) {
      for (const sub of category.subcategories) {
        const want = expectedIn(category, sub);
        if (!want.length) continue;
        await page.click('#results-clear').catch(() => {});
        await pickCategory(page, category.label);
        await pickSub(page, sub.label);
        const got = [...(await resultCards(page)).map((c) => c.href)].sort();
        assert.deepStrictEqual(got, want, `${category.label} / ${sub.label}`);
        for (const href of got) assert.ok(audit.auditRow(rowFor(href)).shelvable, `${href} is not a proved row`);
        checked += 1;
      }
    }
    assert.ok(checked >= 6, `only ${checked} subcategories were supported`);
    await page.close();
  });

  await test('a subcategory the catalogue cannot support is not drawn at all, never falsely enabled', async () => {
    const page = await openDiscover();
    for (const category of DISCOVER_DATA.categories) {
      await pickCategory(page, category.label);
      const drawn = await page.$$eval('#discover-panel button.pill', (ns) => ns.map((n) => n.textContent.trim()));
      for (const sub of category.subcategories) {
        const supported = expectedIn(category, sub).length > 0;
        assert.strictEqual(drawn.includes(sub.label), supported,
          `${category.label} / ${sub.label} is ${supported ? 'missing' : 'drawn without a product to match'}`);
      }
      /* the panel is only its "All" pill and the supported ones */
      const extra = drawn.filter((d) => d !== category.all && !category.subcategories.some((s) => s.label === d));
      assert.deepStrictEqual(extra, [], `${category.label} draws ${extra.join(', ')}`);
    }
    /* the premise, so this test cannot pass vacuously */
    const unsupported = DISCOVER_DATA.categories.flatMap((c) => c.subcategories.filter((s) => !expectedIn(c, s).length).map((s) => s.label));
    assert.ok(unsupported.includes('Trench coats') && unsupported.includes('Boots'), `unsupported today: ${unsupported.join(', ')}`);
    await page.close();
  });

  await test('subcategories combine, chips remove one at a time, and clearing restores the catalogue', async () => {
    const page = await openDiscover();
    const tops = DISCOVER_DATA.categories.find((c) => c.id === 'tops');
    const tees = tops.subcategories.find((s) => s.label === 'T-shirts');
    const shirts = tops.subcategories.find((s) => s.label === 'Button-down shirts');
    await pickCategory(page, 'Tops');
    const all = (await resultCards(page)).length;
    await pickSub(page, 'T-shirts');
    assert.deepStrictEqual([...(await resultCards(page)).map((c) => c.href)].sort(), expectedIn(tops, tees));
    /* two subcategories are alternatives: either one */
    await pickSub(page, 'Button-down shirts');
    const both = [...new Set(expectedIn(tops, tees).concat(expectedIn(tops, shirts)))].sort();
    assert.deepStrictEqual([...(await resultCards(page)).map((c) => c.href)].sort(), both);
    assert.deepStrictEqual(await page.$$eval('#active-filters button', (n) => n.map((b) => b.textContent.replace('×', '').replace('(remove)', '').trim())),
      ['Tops', 'T-shirts', 'Button-down shirts']);
    /* a chip removed widens it again; "All tops" is the whole category */
    await page.click('#active-filters [data-remove="T-shirts"]');
    assert.deepStrictEqual([...(await resultCards(page)).map((c) => c.href)].sort(), expectedIn(tops, shirts));
    await pickSub(page, tops.all);
    assert.strictEqual((await resultCards(page)).length, all);
    /* choosing the chosen category again, or Clear all, restores the shelves */
    await pickCategory(page, 'Tops');
    assert.strictEqual(await page.$eval('#discover-results', (n) => n.hidden), true);
    await pickCategory(page, 'Outerwear');
    await pickSub(page, 'Jackets');
    await page.click('#results-clear');
    assert.strictEqual(await page.$eval('#discover-results', (n) => n.hidden), true);
    assert.strictEqual(await page.$eval('#discover-panel', (n) => n.hidden), true);
    assert.strictEqual(await page.$$eval('#discover-tabs [aria-pressed="true"]', (n) => n.length), 0);
    assert.ok(await page.$$eval('.shelf', (n) => n.filter((s) => s.offsetParent).length) > 0, 'the shelves did not come back');
    /* a shelf's See all is that shelf's category, and its count is true */
    const shelf = await page.$eval('.shelf', (n) => ({
      title: n.querySelector('h2').textContent.trim(),
      total: Number(n.querySelector('button[data-category]').textContent.replace(/\D+/g, ''))
    }));
    await page.click('.shelf button[data-category] >> nth=0');
    assert.ok(!(await page.$eval('#discover-results', (n) => n.hidden)), 'See all applied nothing');
    assert.strictEqual(await page.$eval('#discover-tabs [aria-pressed="true"]', (b) => b.textContent.trim()), shelf.title);
    assert.strictEqual((await resultCards(page)).length, shelf.total, 'See all promised a different number');
    await page.close();
  });

  await test('exploring every category and subcategory makes no product-search, AI or /api request and never leaves the page', async () => {
    searchRequests.length = 0;
    interpretRequests.length = 0;
    const page = await openDiscover();
    const { tally, seen } = watchRequests(page);
    const start = page.url();
    let navigations = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
    let clicks = 0;
    const press = async (selector) => { await page.click(selector); clicks += 1; };

    for (let round = 0; round < 3; round++) {
      for (let c = 0; c < DISCOVER_DATA.categories.length; c++) {
        await press(`#discover-tabs button >> nth=${c}`);
        const pills = await page.$$eval('#discover-panel button.pill', (ns) => ns.length);
        for (let p = 0; p < pills; p++) await press(`#discover-panel button.pill >> nth=${p}`);
        while (await page.$('#active-filters [data-remove]')) await press('#active-filters [data-remove] >> nth=0');
      }
      await press('#results-clear');
      const shelves = await page.$$eval('.shelf button[data-category]', (ns) => ns.length);
      for (let i = 0; i < shelves; i++) {
        await press(`.shelf button[data-category] >> nth=${i}`);
        await press('#results-clear');
      }
    }
    await page.waitForTimeout(300);

    assert.ok(clicks >= 60, `only ${clicks} interactions were made`);
    assert.deepStrictEqual(seen, [], `Discover made costly requests:\n${seen.join('\n')}`);
    Object.entries(tally).forEach(([name, n]) => assert.strictEqual(n, 0, `${name} requests = ${n}`));
    assert.strictEqual(searchRequests.length, 0, 'the search endpoint was reached');
    assert.strictEqual(interpretRequests.length, 0, 'the AI reader was reached');
    assert.strictEqual(page.url(), start, 'Discover left the page');
    assert.strictEqual(navigations, 0, 'Discover navigated');
    await page.close();
  });

  await test('the normal search still runs after Discover, and is the only thing that searches', async () => {
    searchRequests.length = 0;
    interpretRequests.length = 0;
    const page = await openDiscover();
    await pickCategory(page, 'Tops');
    await page.click('#results-clear');
    assert.strictEqual(searchRequests.length, 0);
    await page.goto(`http://127.0.0.1:${PORT}/find-clothes.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.Attachments && document.getElementById('attachments'));
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('#results .item-card', { timeout: 10000 });
    assert.strictEqual(searchRequests.length, 1, 'the search page did not search');
    assert.strictEqual(interpretRequests.length, 1, 'the search page did not read the request');
    await page.close();
  });

  await test('Discover shelves show catalogue rows only, without repeating themselves', async () => {
    const catalogue = await (async () => {
      const page = await openDiscover();
      const rows = await page.evaluate(() => Products.all().map((p) => ({ url: p.productUrl, name: p.name, category: p.category })));
      const shelves = await page.$$eval('.shelf', (ns) => ns.map((shelf) => ({
        title: shelf.querySelector('h2').textContent.trim(),
        cards: [...shelf.querySelectorAll('.item-card')].map((c) => ({
          href: c.getAttribute('href'), name: c.querySelector('.item-name').textContent.trim()
        }))
      })));
      await page.close();
      return { rows, shelves };
    })();
    const { rows, shelves } = catalogue;
    /* a shelf for exactly the categories that can fill a row of four,
       in their own order */
    const fillable = DISCOVER_DATA.categories.filter((c) => expectedIn(c).length >= 4).map((c) => c.label);
    assert.deepStrictEqual(shelves.map((one) => one.title), fillable, 'the wrong shelves are drawn');
    assert.ok(shelves.length >= 3, `${shelves.length} shelves drawn`);
    const everyCard = shelves.flatMap((s) => s.cards);
    everyCard.forEach((card) => {
      const row = rows.find((r) => r.url === card.href);
      assert.ok(row, `${card.name} (${card.href}) is not a catalogue row`);
      assert.strictEqual(row.name, card.name);
    });
    shelves.forEach((shelf) => {
      const names = shelf.cards.map((c) => c.href);
      assert.strictEqual(new Set(names).size, names.length, `${shelf.title} repeats a piece`);
      const kinds = new Set(shelf.cards.map((c) => rows.find((r) => r.url === c.href).category));
      assert.ok(kinds.size >= 2, `${shelf.title} is ${kinds.size} kind of thing`);
    });
    const distinct = new Set(everyCard.map((c) => c.href)).size;
    assert.ok(distinct >= Math.min(rows.length, everyCard.length) * 0.75, `${distinct} different pieces across ${everyCard.length} cards`);
  });

  await test('the categories and subcategories work from the keyboard', async () => {
    const page = await openDiscover();
    await page.focus('#discover-tabs button >> nth=0');
    await page.keyboard.press('Enter');
    assert.strictEqual(await page.$eval('#discover-tabs [aria-pressed="true"]', (b) => b.textContent.trim()), 'Tops');
    await page.focus('#discover-panel button.pill:text-is("T-shirts")');
    await page.keyboard.press(' ');
    assert.strictEqual(await page.$eval('#discover-panel button.pill:text-is("T-shirts")', (b) => b.getAttribute('aria-pressed')), 'true');
    assert.ok((await resultCards(page)).length > 0);
    await page.close();
  });

  await test('Discover fits every width without scrolling sideways', async () => {
    for (const width of [1440, 1280, 1024, 820, 768, 480, 390, 375, 360]) {
      const page = await openDiscover(width);
      const over = await page.evaluate(() => {
        const edge = document.documentElement.clientWidth;
        const wide = document.documentElement.scrollWidth > edge;
        const out = [...document.querySelectorAll('main *')]
          .filter((n) => getComputedStyle(n).display !== 'none')
          .filter((n) => { const r = n.getBoundingClientRect(); return r.width && (r.right > edge + 0.5 || r.left < -0.5); })
          .map((n) => n.className || n.tagName);
        return { wide, out: out.slice(0, 5) };
      });
      assert.ok(!over.wide && !over.out.length, `${width}px overflows: ${over.out.join(', ')}`);
      /* a shelf is one row at every width */
      const rows = await page.$$eval('.shelf-grid', (grids) => grids.map((g) =>
        new Set([...g.querySelectorAll('.item-card')].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().top))).size));
      rows.forEach((n) => assert.strictEqual(n, 1, `${width}px: a shelf runs to ${n} rows`));
      await page.close();
    }
  });

  console.log('\ndiscover shelves: every card is the product it links to');

  await test('every shelf card names the brand its row proves, or where it is sold — never an invented maker', async () => {
    const page = await openDiscover();
    const cards = await shelfCards(page);
    assert.ok(cards.length >= 12, `${cards.length} shelf cards`);
    for (const card of cards) {
      const row = rowFor(card.href);
      assert.ok(row, `${card.href} is not a catalogue listing`);
      const verdict = audit.auditRow(row);
      assert.ok(verdict.shelvable, `${row.id} is shelved but fails its audit: ${verdict.problems.join('; ')}`);
      if (verdict.checks.brand.shown) {
        assert.strictEqual(card.seller, row.brand, `${row.id} shows "${card.seller}"`);
      } else {
        assert.strictEqual(card.seller, hostOf(row.productUrl), `${row.id} has no proved brand, so the card names the store`);
        assert.strictEqual(card.where, null, `${row.id} names its store twice`);
      }
      assert.strictEqual(card.name, row.name);
    }
    /* none of the brands the rows were drafted with survives anywhere */
    const drafted = ['Northfold', 'Halden', 'Coveworks', 'Atlas Supply', 'Rue Nine', 'Terrace', 'Kinfield', 'Solstice'];
    const text = await page.$eval('main', (n) => n.textContent);
    drafted.forEach((name) => assert.ok(!text.includes(name), `"${name}" is still on Discover`));
    await page.close();
  });

  await test('a shelf product with a mismatched or unproved brand is kept off Discover', async () => {
    /* a brand nothing on the row proves */
    const unproved = withRowField('sample-rue-nine-slip-midi-dress', 'brand', 'Rue Nine');
    /* a brand whose cited evidence names someone else */
    const mismatched = withRowField('sample-halden-merino-crew-knit', 'brand', 'Halden');
    for (const [id, catalogue, label] of [
      ['sample-rue-nine-slip-midi-dress', unproved, 'unproved'],
      ['sample-halden-merino-crew-knit', mismatched, 'mismatched']
    ]) {
      const row = audit.readCatalogue(catalogue).find((r) => r.id === id);
      assert.strictEqual(audit.auditRow(row).shelvable, false, `the audit lets a ${label} brand through`);
      if (label === 'mismatched') {
        /* The row still cites evidence, so the browser — which reads the
           note, as it reads imageEvidence — would take it. What stops it
           shipping is the catalogue invariant in test-catalog-audit.js:
           every row the browser would shelve passes this audit. */
        assert.strictEqual(audit.claimsIdentity(row), true);
        continue;
      }
      const page = await openDiscover(null, { catalogue });
      const hrefs = (await shelfCards(page)).map((c) => c.href);
      assert.ok(!hrefs.includes(row.productUrl), `a row with a ${label} brand was shelved`);
      /* the browser makes the same call from the same note */
      assert.strictEqual(await page.evaluate((u) => Products.all().find((p) => p.productUrl === u).identified, row.productUrl), false);
      await page.close();
    }
  });

  await test('a row whose name is not tied to its listing is never shelved', async () => {
    const page = await openDiscover();
    const hrefs = (await shelfCards(page)).map((c) => c.href);
    const unnamed = CATALOGUE.filter((r) => !audit.auditName(r).ok);
    assert.ok(unnamed.length > 0, 'the catalogue is expected to hold rows whose names are unproved');
    unnamed.forEach((r) => assert.ok(!hrefs.includes(r.productUrl), `${r.id} was shelved`));
    await page.close();
  });

  await test('every shelf photo is its row’s own verified photo, really loaded, never artwork', async () => {
    /* half the photos come back tall and half wide, so a tile that only
       looked right for one shape would show it */
    const wide = [...CATALOGUE_PHOTOS].filter((_, i) => i % 2);
    const page = await openDiscover(null, { wide });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => [...document.querySelectorAll('.shelf .item-media img')]
      .every((i) => i.complete), null, { timeout: 10000 });
    const cards = await shelfCards(page);
    for (const card of cards) {
      const row = rowFor(card.href);
      assert.strictEqual(card.artwork, false, `${row.id} shows drawn artwork on a shelf`);
      assert.strictEqual(card.img, row.imageUrl, `${row.id} shows a photo that is not its own`);
      assert.ok(audit.auditPhoto(row).ok, `${row.id}'s photo is not tied to its listing`);
    }
    const shapes = await page.$$eval('.shelf .item-media img', (imgs) => imgs.map((i) => ({
      loaded: i.complete && i.naturalWidth > 0,
      fit: getComputedStyle(i).objectFit,
      box: i.getBoundingClientRect().width / i.getBoundingClientRect().height
    })));
    shapes.forEach((s) => {
      assert.ok(s.loaded, 'a shelf photo did not load');
      assert.strictEqual(s.fit, 'cover', 'a photo is stretched to its tile rather than cropped');
      assert.ok(Math.abs(s.box - 0.8) < 0.02, `a photo tile is ${s.box.toFixed(3)}, not 4:5`);
    });
    await page.close();
  });

  await test('a photo that fails, or is a 1×1 stub, keeps its row off the shelves — artwork does not count', async () => {
    const shelvable = CATALOGUE.filter((r) => audit.auditRow(r).shelvable);
    const failing = shelvable.slice(0, 4).map((r) => r.imageUrl);
    const stubbed = shelvable.slice(4, 7).map((r) => r.imageUrl);
    const page = await openDiscover(null, { fail: failing, stub: stubbed });
    await page.waitForTimeout(300);
    const cards = await shelfCards(page);
    assert.ok(cards.length > 0, 'the rows with working photos are still shelved');
    cards.forEach((c) => {
      assert.ok(!failing.includes(rowFor(c.href).imageUrl), `${rowFor(c.href).id} was shelved with a failed photo`);
      assert.ok(!stubbed.includes(rowFor(c.href).imageUrl), `${rowFor(c.href).id} was shelved with a stub for a photo`);
    });
    assert.strictEqual(await page.$$eval('.shelf svg.silhouette', (n) => n.length), 0, 'artwork stood in for a photo');
    await page.close();
  });

  await test('with no photos reachable at all, Discover shelves nothing rather than artwork', async () => {
    const page = await openPage('discover.html', { photos: true, fail: [...CATALOGUE_PHOTOS] });
    await page.waitForSelector('#discover-tabs > *');
    await page.waitForTimeout(1500);
    assert.strictEqual(await page.$$eval('.shelf', (n) => n.length), 0);
    assert.strictEqual(await page.$$eval('main svg.silhouette', (n) => n.length), 0);
    /* the six categories are still all there, each saying it holds nothing */
    assert.strictEqual(await page.$$eval('#discover-tabs > *', (n) => n.length), 6);
    assert.strictEqual(await page.$$eval('#discover-tabs button', (n) => n.length), 0, 'a category offers products it cannot show');
    await page.close();
  });

  await test('every shelf card links to its row’s own listing', async () => {
    const page = await openDiscover();
    const cards = await shelfCards(page);
    for (const card of cards) {
      const row = rowFor(card.href);
      assert.ok(row, `${card.href} is not a catalogue listing`);
      assert.ok(audit.auditLink(row).ok, `${row.id}: ${audit.auditLink(row).why}`);
      assert.ok(/^https:\/\//.test(card.href), `${card.href} is not a secure listing link`);
    }
    const targets = await page.$$eval('.shelf a.item-card', (as) => as.map((a) => [a.target, a.rel]));
    targets.forEach(([target, rel]) => {
      assert.strictEqual(target, '_blank');
      assert.ok(/noopener/.test(rel));
    });
    await page.close();
  });

  console.log('\nthe billing interface');

  /* Opens a billing page with the stub answering a particular account
     state, and waits for the interface to have drawn it. */
  const openBilling = async (file, state) => {
    accountState = accountReply(state || {});
    const page = await openPage(file);
    await page.waitForSelector(
      file.startsWith('account.html') ? '#panel-account:not([hidden]), #panel-choose:not([hidden])' : '.plan-banner:not([hidden])',
      { timeout: 10000 });
    return page;
  };

  /* What /api/account answers, cut down to the fields the billing
     state is about: the pricing page must read these and nothing else
     to decide whether plans can be bought. */
  const MINIMAL_BILLING_ON = () => ({
    signedIn: false,
    billing: { enabled: true, testMode: false, webhookConfigured: true },
    plans: [{ id: 'free', purchasable: false }, { id: 'pro', purchasable: true }, { id: 'max', purchasable: true }]
  });
  const pricingSays = (page) => page.evaluate(() => ({
    note: document.getElementById('deployment-note').hidden ? '' : document.getElementById('deployment-note').textContent.trim(),
    body: document.body.textContent,
    buttons: Object.fromEntries([...document.querySelectorAll('.plan-card[data-plan]')].map((card) => {
      const b = card.querySelector('[data-plan-action]');
      return [card.dataset.plan, { text: b.textContent.trim(), disabled: b.disabled, action: b.dataset.action || null }];
    })),
    current: [...document.querySelectorAll('.plan-card--current')].map((c) => c.dataset.plan)
  }));
  /* the page has drawn from the server's answer: the banner is up and
     the buttons are no longer the markup's own */
  const drawn = (page) => page.waitForFunction(() => !document.getElementById('plan-banner').hidden
    && document.querySelector('.plan-card[data-plan="free"] [data-plan-action]').textContent.trim() !== 'Always free', null, { timeout: 10000 });

  await test('billing enabled with Pro and Max purchasable: no "not connected", and both can be bought', async () => {
    accountState = MINIMAL_BILLING_ON();
    const page = await openPage('pricing.html');
    await drawn(page);
    const seen = await pricingSays(page);
    assert.ok(!/Billing is not connected to this copy of the site/.test(seen.body), `the page says billing is disconnected: ${seen.note}`);
    assert.ok(!/no payment provider configured/.test(seen.body), seen.note);
    for (const plan of ['pro', 'max']) {
      assert.notStrictEqual(seen.buttons[plan].text, 'Not available yet', `${plan} is marked unavailable`);
      assert.strictEqual(seen.buttons[plan].disabled, false, `${plan} cannot be pressed`);
    }
    assert.strictEqual(seen.buttons.pro.text, 'Get Pro');
    assert.strictEqual(seen.buttons.max.text, 'Get Max');
    /* signed out: buying still starts with an account, as the backend requires */
    assert.strictEqual(seen.buttons.pro.action, 'sign-in-first');
    assert.strictEqual(seen.buttons.max.action, 'sign-in-first');
    /* Free is still the current plan */
    assert.deepStrictEqual(seen.current, ['free']);
    assert.strictEqual(seen.buttons.free.text, 'Your plan');
    await page.close();
    accountState = accountReply({});
  });

  await test('billing truly off: the warning stays, and Pro and Max are not offered', async () => {
    accountState = Object.assign(MINIMAL_BILLING_ON(), { billing: { enabled: false, testMode: false, webhookConfigured: false } });
    const page = await openPage('pricing.html');
    await drawn(page);
    const seen = await pricingSays(page);
    assert.ok(/no payment provider configured/.test(seen.note), seen.note);
    for (const plan of ['pro', 'max']) {
      assert.strictEqual(seen.buttons[plan].text, 'Not available yet');
      assert.strictEqual(seen.buttons[plan].disabled, true);
    }
    await page.close();
    accountState = accountReply({});
  });

  await test('a plan the server marks not purchasable stays unavailable even with billing on', async () => {
    accountState = Object.assign(MINIMAL_BILLING_ON(), {
      plans: [{ id: 'free', purchasable: false }, { id: 'pro', purchasable: true }, { id: 'max', purchasable: false }]
    });
    const page = await openPage('pricing.html');
    await drawn(page);
    const seen = await pricingSays(page);
    assert.strictEqual(seen.buttons.pro.text, 'Get Pro');
    assert.strictEqual(seen.buttons.max.text, 'Not available yet');
    assert.ok(!/not connected/.test(seen.body));
    await page.close();
    accountState = accountReply({});
  });

  await test('the pricing page asks /api/account at its own origin, not the deployment its meta tag names', async () => {
    accountState = MINIMAL_BILLING_ON();
    billingRequests.length = 0;
    const remote = [];
    const page = await openPage('pricing.html', {
      apiOverride: false,
      offOrigin: (route, url) => {
        if (/vercel\.app\/api\//.test(url)) { remote.push(url); route.abort(); return true; }
        return false;
      }
    });
    await drawn(page);
    const seen = await pricingSays(page);
    /* counted by this origin's own server, so nothing can be missed */
    assert.ok(billingRequests.some((r) => r.path === '/api/account'), 'this origin\u2019s /api/account was not asked');
    assert.deepStrictEqual(remote, [], `the production deployment was asked: ${remote.join(', ')}`);
    assert.ok(!/not connected/.test(seen.body), seen.note);
    assert.strictEqual(seen.buttons.pro.text, 'Get Pro');
    await page.close();
    accountState = accountReply({});
  });

  await test('a copy of the pages with no API beside it still reaches the deployment its meta tag names', async () => {
    const remote = [];
    const page = await openPage('pricing.html', {
      apiOverride: false,
      offOrigin: (route, url) => {
        if (/^https:\/\/ai-clothes-application\.vercel\.app\/api\/account/.test(url)) {
          remote.push(url);
          route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': `http://127.0.0.1:${PORT}`, 'access-control-allow-credentials': 'true' }, body: JSON.stringify(MINIMAL_BILLING_ON()) });
          return true;
        }
        return false;
      }
    });
    /* this origin plays a static host: no /api here */
    await page.route(`http://127.0.0.1:${PORT}/api/**`, (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await drawn(page);
    const seen = await pricingSays(page);
    assert.strictEqual(remote.length >= 1, true, 'the meta tag’s deployment was not asked');
    assert.ok(!/not connected/.test(seen.body), seen.note);
    assert.strictEqual(seen.buttons.max.text, 'Get Max');
    await page.close();
  });

  await test('with no account API anywhere, the page still says billing is not connected', async () => {
    const page = await openPage('pricing.html', { apiOverride: false });
    await page.route(`http://127.0.0.1:${PORT}/api/**`, (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deployment-note:not([hidden])', { timeout: 10000 });
    const seen = await pricingSays(page);
    assert.ok(/Billing is not connected to this copy of the site/.test(seen.note), seen.note);
    assert.strictEqual(seen.buttons.pro.text, 'Not available yet');
    await page.close();
  });

  await test('the pricing page shows all three plans with their prices', async () => {
    const page = await openBilling('pricing.html');
    const cards = await page.$$eval('.plan-card', (ns) => ns.map((n) => ({
      plan: n.dataset.plan,
      name: n.querySelector('.plan-name').textContent.trim(),
      amount: n.querySelector('.plan-amount').textContent.trim()
    })));
    assert.deepStrictEqual(cards.map((c) => c.plan), ['free', 'pro', 'max']);
    assert.deepStrictEqual(cards.map((c) => c.amount), ['$0', '$14.99', '$39.99']);
    await page.close();
  });

  await test('the pricing page offers Free 3 live searches a day, and Pro and Max what they always did', async () => {
    const page = await openBilling('pricing.html');
    const features = await page.$$eval('.plan-card', (ns) => Object.fromEntries(ns.map((n) => [n.dataset.plan,
      Array.from(n.querySelectorAll('.plan-features li')).map((li) => li.textContent.trim())])));
    assert.ok(features.free.includes('3 live product searches a day'), features.free.join(' | '));
    assert.ok(!features.free.some((f) => /\b1 live product search\b/.test(f)), 'the old allowance is still on the page');
    assert.ok(features.pro.includes('100 live product searches a month'), features.pro.join(' | '));
    assert.ok(features.max.includes('500 live product searches a month'), features.max.join(' | '));
    await page.close();
  });

  await test('the plan the server named is the one marked current', async () => {
    const page = await openBilling('pricing.html', { planId: 'pro', extra: { signedIn: true, user: { email: 'a@b.co' } } });
    const current = await page.$$eval('.plan-card--current', (ns) => ns.map((n) => n.dataset.plan));
    assert.deepStrictEqual(current, ['pro'], 'exactly the server-named plan is marked');
    assert.strictEqual(await page.$eval('#banner-plan', (n) => n.textContent.trim()), 'Pro');
    await page.close();
  });

  await test('a signed-out visitor is asked to sign in rather than sent to Stripe', async () => {
    billingRequests.length = 0;
    const page = await openBilling('pricing.html');
    const label = await page.$eval('.plan-card[data-plan="pro"] [data-plan-action]', (n) => n.textContent.trim());
    assert.strictEqual(label, 'Get Pro');
    assert.strictEqual(await page.$eval('.plan-card[data-plan="pro"] [data-plan-action]', (n) => n.dataset.action), 'sign-in-first');
    assert.ok(!billingRequests.some((r) => r.path === '/api/checkout'), 'no checkout may be started without an account');
    await page.close();
  });

  await test('a signed-in shopper on Free gets Get Pro and Get Max, and clicking sends only the plan name', async () => {
    billingRequests.length = 0;
    const page = await openBilling('pricing.html', { extra: { signedIn: true, user: { email: 'a@b.co', hasBilling: false } } });
    assert.strictEqual(await page.$eval('.plan-card[data-plan="pro"] [data-plan-action]', (n) => n.textContent.trim()), 'Get Pro');
    assert.strictEqual(await page.$eval('.plan-card[data-plan="max"] [data-plan-action]', (n) => n.textContent.trim()), 'Get Max');

    await page.click('.plan-card[data-plan="max"] [data-plan-action]');
    await page.waitForTimeout(400);

    const started = billingRequests.filter((r) => r.path === '/api/checkout');
    assert.strictEqual(started.length, 1, 'one checkout, for one click');
    assert.strictEqual(started[0].body.plan, 'max');
    /* nothing that could re-price the checkout may be sent from a page */
    const sent = JSON.stringify(started[0].body);
    assert.ok(!/price|amount|currency|interval|14\.99|39\.99/i.test(sent), sent);
    await page.close();
  });

  await test('somebody already subscribed is sent to the portal, never to a second checkout', async () => {
    billingRequests.length = 0;
    const page = await openBilling('pricing.html', {
      planId: 'pro',
      extra: {
        signedIn: true,
        user: { email: 'a@b.co', hasBilling: true },
        subscription: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2099-01-01T00:00:00.000Z', latestInvoiceStatus: 'paid' },
        billing: { enabled: true, testMode: true, webhookConfigured: true, portal: true }
      }
    });
    assert.strictEqual(await page.$eval('.plan-card[data-plan="max"] [data-plan-action]', (n) => n.dataset.action), 'portal');
    await page.click('.plan-card[data-plan="max"] [data-plan-action]');
    await page.waitForTimeout(400);
    assert.ok(billingRequests.some((r) => r.path === '/api/portal'), 'the portal is what changes an existing subscription');
    assert.ok(!billingRequests.some((r) => r.path === '/api/checkout'), 'a second checkout would be a second monthly charge');
    await page.close();
  });

  await test('Manage subscription appears once there is a Stripe customer, and opens the portal', async () => {
    billingRequests.length = 0;
    const page = await openBilling('account.html', {
      planId: 'max',
      extra: {
        signedIn: true,
        user: { email: 'a@b.co', hasBilling: true },
        subscription: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2099-03-04T00:00:00.000Z', latestInvoiceStatus: 'paid' },
        billing: { enabled: true, testMode: true, webhookConfigured: true, portal: true }
      }
    });
    const button = await page.$('#banner-actions [data-action="portal"]');
    assert.ok(button, 'a subscriber needs a way to manage the subscription');
    assert.strictEqual((await button.textContent()).trim(), 'Manage subscription');
    await button.click();
    await page.waitForTimeout(400);
    assert.ok(billingRequests.some((r) => r.path === '/api/portal'));
    await page.close();
  });

  await test('the usage meters show the server’s counters, not the page’s own', async () => {
    const page = await openBilling('account.html');
    const meters = await page.$$eval('.meter', (ns) => ns.map((n) => ({
      label: n.querySelector('.meter-label').textContent.trim(),
      value: n.querySelector('.meter-value').textContent.trim()
    })));
    assert.strictEqual(meters.length, 2);
    assert.deepStrictEqual(meters.map((m) => m.label), ['AI tokens', 'Live product searches']);
    assert.strictEqual(meters[0].value, '1,200 of 20,000 used');
    assert.strictEqual(meters[1].value, '1 of 3 used');
    await page.close();
  });

  await test('the account page shows the Free allowance as 3 live searches a day', async () => {
    const page = await openBilling('account.html');
    const searches = await page.$$eval('.meter', (ns) => ns.map((n) => ({
      label: n.querySelector('.meter-label').textContent.trim(),
      value: n.querySelector('.meter-value').textContent.trim(),
      reset: n.querySelector('.meter-reset').textContent.trim()
    })).find((m) => m.label === 'Live product searches'));
    assert.ok(searches.value.endsWith('of 3 used'), searches.value);
    /* counted by the day: it comes back at a time, not on a date */
    assert.ok(/^Resets at /.test(searches.reset), searches.reset);
    await page.close();
  });

  await test('browsing and filtering Discover spends no live search', async () => {
    stubs.log.length = 0;
    searchRequests.length = 0;
    const page = await openPage('discover.html', { photos: true });
    const used = await browseAllOfDiscover(page);
    assert.ok(used > 1, 'no filters to try');
    await page.waitForTimeout(300);
    assert.deepStrictEqual(stubs.log.filter((e) => e.path === '/api/search' || e.path === '/api/interpret'), [],
      'a Discover filter reached the search or the interpreter');
    assert.strictEqual(searchRequests.length, 0);
    assert.ok(await page.$$eval('.shelf .item-card', (ns) => ns.length) > 0, 'Discover shows nothing to browse');
    await page.close();
  });

  await test('the meters follow the plan: Pro shows the monthly allowance', async () => {
    const page = await openBilling('account.html', { planId: 'pro', extra: { signedIn: true, user: { email: 'a@b.co' } } });
    const values = await page.$$eval('.meter-value', (ns) => ns.map((n) => n.textContent.trim()));
    assert.ok(values[0].endsWith('of 1,000,000 used'), values[0]);
    assert.ok(values[1].endsWith('of 100 used'), values[1]);
    await page.close();
  });

  await test('a failed payment is explained, not silently downgraded', async () => {
    const page = await openBilling('account.html', {
      planId: 'free',
      extra: {
        signedIn: true,
        user: { email: 'a@b.co', hasBilling: true },
        subscription: { status: 'past_due', cancelAtPeriodEnd: false, currentPeriodEnd: '2099-01-01T00:00:00.000Z', latestInvoiceStatus: 'payment_failed' },
        billing: { enabled: true, testMode: true, webhookConfigured: true, portal: true }
      }
    });
    assert.strictEqual(await page.$eval('#banner-plan', (n) => n.textContent.trim()), 'Free');
    assert.ok(await page.$('#banner-actions [data-action="portal"]'), 'they need a way to fix the card');
    await page.close();
  });

  await test('landing on ?checkout=success grants nothing on its own', async () => {
    accountState = accountReply({});
    const page = await openPage('pricing.html?checkout=success&session_id=cs_test_forged');
    await page.waitForSelector('#checkout-note:not([hidden])', { timeout: 10000 });
    /* the server still says Free, so the page still says Free */
    assert.strictEqual(await page.$eval('#banner-plan', (n) => n.textContent.trim()), 'Free');
    const current = await page.$$eval('.plan-card--current', (ns) => ns.map((n) => n.dataset.plan));
    assert.deepStrictEqual(current, ['free'], 'a redirect is not a payment');
    await page.close();
  });

  await test('a cancelled checkout says nothing was charged', async () => {
    accountState = accountReply({});
    const page = await openPage('pricing.html?checkout=cancelled');
    await page.waitForSelector('#checkout-note:not([hidden])', { timeout: 10000 });
    const text = await page.$eval('#checkout-note', (n) => n.textContent);
    assert.ok(/nothing was charged/i.test(text), text);
    assert.strictEqual(await page.$eval('#banner-plan', (n) => n.textContent.trim()), 'Free');
    await page.close();
  });

  await test('a deployment running in Stripe test mode says so before anyone types a card', async () => {
    const page = await openBilling('pricing.html');
    const note = await page.$eval('#deployment-note', (n) => n.textContent);
    assert.ok(/test mode/i.test(note), note);
    assert.ok(/no real card is charged/i.test(note), note);
    await page.close();
  });

  await test('the plan prices and limits on the pricing page match the server’s plan table', async () => {
    const plans = require('../api/_plans');
    const html = fs.readFileSync(path.join(REPO, 'pricing.html'), 'utf8');
    Object.values(plans.PLANS).forEach((plan) => {
      const money = plan.amount === 0 ? '$0' : `$${plan.amount.toFixed(2)}`;
      assert.ok(html.includes(`<span class="plan-amount">${money}</span>`), `${plan.name} should be priced ${money}`);
      plan.features.forEach((feature) => {
        assert.ok(html.includes(`<li>${feature}</li>`), `${plan.name} should list "${feature}"`);
      });
    });
  });

  await test('no page ships a Stripe key, and no page collects a card', async () => {
    const files = ['index.html', 'find-clothes.html', 'discover.html', 'about.html', 'pricing.html', 'account.html',
      'assets/account.js', 'assets/billing-ui.js', 'assets/app.js', 'assets/search.js', 'assets/interpret.js'];
    files.forEach((file) => {
      const text = fs.readFileSync(path.join(REPO, file), 'utf8');
      assert.ok(!/sk_live_|sk_test_|rk_live_|whsec_/.test(text), `${file} must not carry Stripe key material`);
      assert.ok(!/autocomplete="cc-|name="cardnumber"|id="card-number"/i.test(text), `${file} must not collect card details`);
    });
  });

  console.log('\ntypography and text styling');

  const PAGES = ['index.html', 'find-clothes.html', 'discover.html', 'about.html', 'pricing.html', 'account.html', 'fit-profile.html'];

  /* each page is given a moment to render whatever it builds from the
     catalogue, so cards, badges and pills are audited too, not just the
     static shell */
  const settled = async (file) => {
    /* Discover only shelves rows whose photos arrive */
    const page = await openPage(file, { photos: file === 'discover.html' });
    const built = {
      'discover.html': '.item-card',
      /* the home page is the fit guide, ready once /api/account has
         answered, over the catalogue preview; both are audited */
      'index.html': 'body:has(#guide[data-ready]):has(#preview-grid .item-card)',
      /* the search page reads the live searches left from /api/account;
         the audit waits for the count so its ink is checked too */
      'find-clothes.html': '#ask-usage:not(:empty)',
      /* both billing pages draw themselves from /api/account, so the
         audit has to wait for the answer or it walks an empty shell */
      'pricing.html': '.plan-banner:not([hidden])',
      /* Signed out, the account page is the two choices; the dashboard
         behind it is hidden, so this waits for the shell that is
         actually on screen. The signed-in view is audited separately. */
      'account.html': '#panel-choose:not([hidden])',
      /* signed out, the fit profile page is the way to sign in; the
         form is audited signed in, below */
      'fit-profile.html': '#profile-signed-out:not([hidden])'
    }[file];
    if (built) await page.waitForSelector(built, { timeout: 10000 });
    return page;
  };

  for (const file of PAGES) {
    await test(`every piece of text on ${file} is set in a palette ink, and is legible`, async () => {
      const page = await settled(file);
      const problems = await textStyleProblems(page, await resolveInks(page));
      assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
      await page.close();
    });
  }

  await test('every piece of text on the signed-in account page is set in a palette ink, and is legible', async () => {
    accountState = accountReply({
      planId: 'pro',
      extra: {
        signedIn: true,
        user: { id: 'usr_1', email: 'ada@example.test', name: 'Ada Lovelace', emailVerified: true, signInMethods: ['password'], hasBilling: true },
        emailVerified: true,
        subscription: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: '2099-03-04T00:00:00.000Z', latestInvoiceStatus: 'paid' },
        billing: { enabled: true, testMode: true, webhookConfigured: true, portal: true }
      }
    });
    const page = await openPage('account.html');
    await page.waitForSelector('#panel-account:not([hidden])', { timeout: 10000 });
    await page.waitForSelector('.meter');
    const problems = await textStyleProblems(page, await resolveInks(page));
    assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
    await page.close();
    accountState = accountReply({});
  });

  await test('every piece of text on the fit profile form is set in a palette ink, and is legible — errors, notes and the delete confirmation too', async () => {
    accountState = accountReply({
      extra: {
        signedIn: true,
        user: { id: 'usr_1', email: 'ada@example.test', name: 'Ada Lovelace', emailVerified: true, signInMethods: ['password'], hasBilling: false },
        emailVerified: true
      }
    });
    fitProfileState = fitProfileReply({
      schemaVersion: 1,
      measurements: { unit: 'in', height: 70, chest: 40, waist: null, hip: null },
      brandSizes: [{ brand: 'Uniqlo', category: 'hoodies', size: 'M', fit: 'about-right' }, { brand: 'Gap', category: 'sweatshirts', size: null, fit: null }],
      fitPreferences: { hoodies: 'relaxed' }
    });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await openPage('fit-profile.html', { viewport });
      await page.waitForSelector('#profile-form:not([hidden])', { timeout: 10000 });
      /* an error, a unit note, a form-level error and the confirmation,
         all on screen at once, so every ink the form uses is audited */
      await page.fill('#measure-waist', '500');
      await page.check('input[name="unit"][value="cm"]');
      await page.click('#profile-save');
      await page.waitForSelector('#profile-form-error.show');
      await page.click('#profile-delete');
      await page.waitForSelector('#delete-confirm:not([hidden])');

      const problems = await textStyleProblems(page, await resolveInks(page));
      assert.deepStrictEqual(problems, [], `${viewport.width}px:\n        ${problems.join('\n        ')}`);
      const inks = await resolveInks(page);
      (await placeholderColours(page)).forEach(({ selector, color }) => assert.ok(inks[color], `${selector} placeholder is ${color}`));
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(width <= viewport.width, `${width}px wide at ${viewport.width}px`);
      await page.close();
    }
    accountState = accountReply({});
    fitProfileState = fitProfileReply(null);
  });

  /* The fit guide on the home page shows one step at a time, so the page
     audit above only sees step 1. These walk every step and panel. */
  const guideAudit = (page, viewport) => async (where) => {
    const problems = await textStyleProblems(page, await resolveInks(page));
    assert.deepStrictEqual(problems, [], `${viewport.width}px, ${where}:\n        ${problems.join('\n        ')}`);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= viewport.width, `${where}: the page is ${width}px wide at ${viewport.width}px`);
  };

  await test('every step of the fit guide and its account step are set in a palette ink, legible, and fit a phone', async () => {
    accountState = accountReply({});
    fitProfileState = fitProfileReply(null);
    for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 740 }]) {
      const page = await openPage('index.html', { viewport });
      await page.waitForSelector('#guide[data-ready]', { timeout: 10000 });
      const audit = guideAudit(page, viewport);

      await page.selectOption('#anchor-brand', 'other');
      await page.fill('#anchor-other', 'Gap');
      await page.selectOption('#anchor-size', 'M');
      await audit('step 1, with a brand typed under Other');
      await page.click('#guide-next');
      await page.check('input[name="fitGoal"][value="oversized"]');
      await audit('step 2, with a card chosen');
      await page.click('#guide-next');
      await page.check('input[name="troubleZones"][value="torso-short"]');
      await audit('step 3, with a trouble spot ticked');

      /* signed out, saving asks for an account; an error puts the
         warning ink under audit too */
      await page.click('#guide-next');
      await page.waitForSelector('#guide-account:not([hidden])');
      await page.click('#guide-account-submit');
      await page.waitForSelector('#guide-account-error:not(:empty)');
      await audit('the account step, with an error');
      await page.close();
    }
  });

  await test('a failed save and the confirmation are legible, and a saved profile is filled in', async () => {
    const saved = {
      schemaVersion: 2,
      measurements: { unit: 'in', height: 70, chest: 40, waist: null, hip: null },
      brandSizes: [{ brand: 'Gap', category: 'hoodies', size: 'M', fit: 'about-right' }],
      fitPreferences: { hoodies: 'relaxed' },
      anchor: { brand: 'UNIQLO', size: 'L' },
      fitGoal: 'slim',
      troubleZones: []
    };
    accountState = accountReply({ extra: SIGNED_IN });
    for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 740 }]) {
      /* the stub answers every /api/fit-profile request with this: a save
         that does not say saved is a failed one */
      fitProfileState = fitProfileReply(saved);
      const page = await openPage('index.html', { viewport });
      await page.waitForSelector('#guide[data-ready]', { timeout: 10000 });
      const audit = guideAudit(page, viewport);

      assert.strictEqual(await page.isVisible('#guide-saved-note'), true, 'says the saved answers are filled in');
      assert.strictEqual(await page.$eval('#anchor-brand', (n) => n.value), 'UNIQLO');
      assert.strictEqual(await page.$eval('#anchor-size', (n) => n.value), 'L');
      await page.click('#guide-next');
      assert.strictEqual(await page.isChecked('input[name="fitGoal"][value="slim"]'), true);
      await page.click('#guide-next');
      assert.strictEqual(await page.isChecked('#zone-none'), true, 'an empty list is "None of these"');

      await page.click('#guide-next');
      await page.waitForSelector('#guide-error:not(:empty)');
      assert.strictEqual(await page.isVisible('#guide-done'), false, 'no confirmation for a save the server did not confirm');
      await audit('a failed save');

      fitProfileState = Object.assign(fitProfileReply(saved), { saved: true });
      await page.click('#guide-next');
      await page.waitForSelector('#guide-done:not([hidden])');
      await audit('the confirmation');
      await page.close();
    }
    accountState = accountReply({});
    fitProfileState = fitProfileReply(null);
  });

  await test('the fit guide holds still for reduced motion: a choice changes colour, and nothing animates', async () => {
    accountState = accountReply({});
    const page = await openPage('index.html');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForSelector('#guide[data-ready]', { timeout: 10000 });
    await page.click('#guide-next');
    await page.check('input[name="fitGoal"][value="slim"]');
    const moving = await page.evaluate(() => [...document.querySelectorAll('#guide *')]
      .filter((n) => n.offsetParent)
      .map((n) => ({ n, cs: getComputedStyle(n) }))
      .filter(({ cs }) => cs.animationName !== 'none'
        || cs.transitionDuration.split(',').some((d) => parseFloat(d) * (d.trim().endsWith('ms') ? 1 : 1000) > 1))
      .map(({ n, cs }) => `${n.tagName.toLowerCase()}.${n.className} ${cs.animationName} ${cs.transitionDuration}`));
    assert.deepStrictEqual(moving, []);
    await page.close();
  });

  await test('the email form is set in a palette ink, in both of its modes', async () => {
    accountState = accountReply({});
    const page = await openPage('account.html');
    await page.waitForSelector('#panel-choose:not([hidden])', { timeout: 10000 });
    await page.click('#email-button');
    await page.waitForSelector('#panel-email:not([hidden])');

    for (const mode of ['sign in', 'create an account']) {
      /* an error on screen puts the warning ink under audit too */
      await page.click('#auth-submit');
      await page.waitForTimeout(200);
      const problems = await textStyleProblems(page, await resolveInks(page));
      assert.deepStrictEqual(problems, [], `${mode}:\n        ${problems.join('\n        ')}`);
      await page.click('#auth-switch');
      await page.waitForTimeout(100);
    }
    await page.close();
  });

  await test('the pages keep one clean sans-serif face', async () => {
    for (const file of PAGES) {
      const page = await settled(file);
      const faces = await page.$$eval('body, h1, h2, h3, p, button, input, textarea, .item-name',
        (ns) => [...new Set(ns.map((n) => getComputedStyle(n).fontFamily))]);
      faces.forEach((f) => assert.ok(/^["']?Inter/.test(f), `${file} uses ${f}`));
      await page.close();
    }
  });

  await test('the headline is plain type, not a gradient fill', async () => {
    const page = await settled('index.html');
    const grad = await page.$eval('.hero h1', (n) => {
      const cs = getComputedStyle(n);
      return {
        color: cs.color,
        fill: cs.webkitTextFillColor,
        clip: cs.webkitBackgroundClip || cs.backgroundClip,
        image: cs.backgroundImage
      };
    });
    assert.strictEqual(grad.color, 'rgb(0, 0, 0)');
    assert.strictEqual(grad.fill, 'rgb(0, 0, 0)');
    assert.notStrictEqual(grad.clip, 'text');
    assert.strictEqual(grad.image, 'none');
    await page.close();
  });

  await test('search results, badges and product text are set in a palette ink', async () => {
    const page = await open();
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.item-card', { timeout: 10000 });
    const problems = await textStyleProblems(page, await resolveInks(page));
    assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
    await page.close();
  });

  await test('attachment chips, the drop cue and the error line are set in a palette ink', async () => {
    const page = await open();
    await page.evaluate(dropInPage, { selector: '#ask-form', files: [
      { name: 'inspo.png', type: 'image/png', size: 1024 },
      { name: 'sizing.pdf', type: 'application/pdf', size: 2048 }
    ] });
    /* an empty query with files attached puts the error line on screen */
    await page.click('button[type=submit]');
    await page.waitForSelector('#form-error.show');
    /* hold the card in its drop state so the veil is rendered too */
    await page.evaluate(dragOverOnly, { selector: '#ask-form' });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ask-dropveil')).display !== 'none');

    const problems = await textStyleProblems(page, await resolveInks(page));
    assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
    await page.close();
  });

  /* a placeholder is an example, not the value, so it is set in the
     muted ink — and, like every other piece of type, in a palette ink */
  await test('placeholder text is set in a palette ink', async () => {
    for (const file of PAGES) {
      const page = await settled(file);
      const inks = await resolveInks(page);
      (await placeholderColours(page)).forEach(({ selector, color }) => {
        assert.ok(inks[color], `${file} ${selector} placeholder is ${color}`);
      });
      await page.close();
    }
  });

  await test('no stylesheet rule paints type with a gradient or a glow, and light belongs only to a search at work', async () => {
    const css = fs.readFileSync(path.join(REPO, 'assets', 'styles.css'), 'utf8');
    assert.ok(!/background-clip:\s*text/.test(css), 'no rule may clip a background to its text');
    assert.ok(!/text-shadow/.test(css), 'no rule may glow');
    /* A gradient is light, and the only light is a search at work: the
       search box's light, the placeholders, and a photo still on its way.
       Nothing at rest, and no type, is ever gradient-filled. */
    const LIGHT = /^(\.ask-progress|\.ask-card::after|\.skeleton-|\.item-media::after)/;
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const painted = rules.filter(([, , body]) => /gradient\(/.test(body))
      .flatMap(([, selector]) => selector.split(',').map((one) => one.trim()));
    assert.ok(painted.length > 0, 'the loading light is drawn with gradients, and none were found: this test is reading the wrong file');
    painted.forEach((selector) => assert.ok(LIGHT.test(selector), `a gradient outside the loading light: ${selector}`));
    /* the neutral foundation the palette is built on: black type, one
       step down for prose, muted metadata, white on an inverted ground */
    const FOUNDATION = {
      '--color-text': '#000000', '--color-text-2': '#2b2b2b',
      '--color-text-muted': '#6b6b6b', '--color-text-invert': '#ffffff'
    };
    Object.entries(FOUNDATION).forEach(([token, expected]) => {
      const m = new RegExp(`${token}:\\s*([^;]+);`).exec(css);
      assert.ok(m, `${token} should be defined`);
      assert.strictEqual(m[1].trim().toLowerCase(), expected, `${token} is ${m && m[1]}`);
    });
  });

  /* The palette is a system or it is nothing: a hex dropped into a rule
     is a colour nobody can find later, and is how a design system turns
     back into a pile of one-off values. */
  await test('every colour in the stylesheet comes from a token', async () => {
    const css = fs.readFileSync(path.join(REPO, 'assets', 'styles.css'), 'utf8');
    const rules = css.slice(css.indexOf('*, *::before, *::after'));
    const raw = rules.match(/#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)/g) || [];
    assert.deepStrictEqual(raw, [], `raw colour values outside the token block: ${raw.join(', ')}`);

    /* and nothing the other way either: a token nothing reads is a
       colour that looks like part of the system but is not in it */
    const declared = new Set([...css.matchAll(/(--color-[a-z0-9-]+):/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--color-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    const dead = [...declared].filter((t) => !used.has(t));
    assert.deepStrictEqual(dead, [], `tokens nothing uses: ${dead.join(', ')}`);
  });

  /* Colour has to be doing a job. These are the jobs it was given; if a
     rule stops using the token, the interface has quietly lost a signal
     rather than merely changed shade. */
  await test('the palette is actually wired to the interface', async () => {
    const page = await settled('index.html');
    const wired = await page.evaluate(() => {
      const val = (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
      const probe = document.createElement('span');
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const rgbOf = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
      const primary = rgbOf('--color-primary');
      const out = {
        cta: getComputedStyle(document.querySelector('.btn-primary')).backgroundColor === primary,
        mark: getComputedStyle(document.querySelector('.brand-mark')).backgroundColor === primary,
        current: getComputedStyle(document.querySelector('.nav-links a[aria-current="page"]'), '::after').backgroundColor === primary,
        step: getComputedStyle(document.querySelector('.step-num')).color === rgbOf('--color-accent-ink'),
        /* the guide's "1 of 3" is a step number, so it takes the accent;
           the part of the bar already reached is the primary */
        guideCount: getComputedStyle(document.querySelector('.guide-count')).color === rgbOf('--color-accent-ink'),
        guideBar: getComputedStyle(document.querySelector('.guide-bar li.is-current')).backgroundColor === primary,
        retailer: getComputedStyle(document.querySelector('.item-retailer')).color === rgbOf('--color-primary-ink'),
        defined: ['--color-bg', '--color-surface', '--color-text', '--color-text-muted', '--color-border',
          '--color-primary', '--color-primary-hover', '--color-accent', '--color-success', '--color-warning']
          .every((t) => val(t) !== '')
      };
      probe.remove();
      return out;
    });
    Object.entries(wired).forEach(([what, ok]) => assert.ok(ok, `${what} does not use its token`));
    await page.close();

    /* the example searches live with the search box, on the Search page */
    const search = await settled('find-clothes.html');
    const example = await search.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-accent-ink)';
      document.body.appendChild(probe);
      const ok = getComputedStyle(document.querySelector('.example')).color === getComputedStyle(probe).color;
      probe.remove();
      return ok;
    });
    assert.ok(example, 'example does not use its token');
    await search.close();
  });

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
