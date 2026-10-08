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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

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
        if (stub && stub.status) { res.statusCode = stub.status; return res.end(JSON.stringify({ error: 'stubbed failure' })); }
        /* an answered search is what the server counts */
        if (url.pathname === '/api/search' && stubs.charge) chargeSearch();
        if (stub && stub.reply) return res.end(JSON.stringify(stub.reply));
        return null;
      };
      if (url.pathname === '/api/interpret') {
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

  const file = path.join(REPO, url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
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

  const openPage = async (file) => {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      window.FINDWEAR_API = 'http://127.0.0.1:8899/api/interpret';
      window.FINDWEAR_SEARCH_API = 'http://127.0.0.1:8899/api/search';
    });
    /* Anything off this origin is unreachable in this environment, and a
       stylesheet still loading blocks the scripts under it from running.
       Cutting external requests makes the page deterministic. */
    await page.route((url) => !String(url).includes('127.0.0.1'), (route) => route.abort());
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

  /* the hairline in the search box: whether the shopper can see it, and
     the stage the box is marked with */
  const boxLine = (page) => page.evaluate(() => {
    const form = document.getElementById('ask-form');
    const line = form.querySelector('.ask-progress-line');
    const box = line.getBoundingClientRect();
    return {
      stage: form.dataset.stage || null,
      shown: getComputedStyle(form.querySelector('.ask-progress')).display !== 'none' && box.width > 0 && box.height > 0
    };
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
        display: getComputedStyle(form.querySelector('.ask-progress')).display
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
    /* gone from the box in the same moment the results replaced the
       placeholders, not a beat later */
    assert.deepStrictEqual(await boxAtEnd(page), { stage: null, display: 'none' }, 'the hairline outlived the search');
    assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false });
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
      assert.deepStrictEqual(await boxAtEnd(page), { stage: null, display: 'none' }, `${why}: the hairline outlived the failure`);
      assert.deepStrictEqual(await boxLine(page), { stage: null, shown: false }, why);
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
    /* the hairline goes with the placeholders, and nothing eases it out */
    assert.deepStrictEqual(await boxAtEnd(page), { stage: null, display: 'none' });
    const lingers = await page.evaluate(() => {
      const wrap = getComputedStyle(document.querySelector('#ask-form .ask-progress'));
      const line = getComputedStyle(document.querySelector('#ask-form .ask-progress-line'));
      return { transition: wrap.transitionDuration, delay: line.animationDelay };
    });
    assert.deepStrictEqual(lingers, { transition: '0s', delay: '0s' });
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
    const css = (sel) => getComputedStyle(document.querySelector(sel));
    return {
      bar: css('#ask-form .ask-progress-line').animationName,
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
    assert.strictEqual(normal.bar, 'pulse');
    assert.strictEqual(normal.line, 'stage-in');
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
    assert.deepStrictEqual(reduced, { bar: 'none', line: 'none', skeleton: 'none', opacity: '1' });
    /* still there, and still in the box: held still, not taken away */
    assert.deepStrictEqual(await boxLine(still), { stage: 'searching', shown: true });
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
      shown: getComputedStyle(form.querySelector('.ask-progress')).display !== 'none',
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
    const runs = SEARCH_WIDTHS.map((viewport) => ['find-clothes.html', viewport])
      .concat([['index.html', { width: 1280, height: 900 }], ['index.html', { width: 390, height: 844 }]]);
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
    for (const file of ['find-clothes.html', 'index.html']) {
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

  reset();

  console.log('\nlive searches left, in the search box');

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
      for (const file of ['find-clothes.html', 'index.html']) {
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

    const discover = await openPage('discover.html');
    await discover.waitForSelector('.filter-pills .pill');
    const pills = await discover.$$eval('.filter-pills .pill', (ns) => ns.map((n) => n.dataset.style));
    for (const style of pills.concat(['All'])) {
      await discover.click(`.filter-pills .pill[data-style="${style}"]`);
      await discover.waitForFunction((st) => document.querySelector(`.filter-pills .pill[data-style="${st}"]`).getAttribute('aria-pressed') === 'true', style);
    }
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
    const runs = widths.map((width) => ['find-clothes.html', width]).concat([['index.html', 1280], ['index.html', 390]]);
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
    searchPhoto = REAL_PHOTO;
    try {
      const page = await open();
      const sent = [];
      await page.route((url) => String(url).endsWith('fynd-demo-poster.jpg'), (route) => {
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
    const page = await openPage('discover.html');
    await page.waitForSelector('.filter-pills .pill');
    const pills = await page.$$eval('.filter-pills .pill', (ns) => ns.map((n) => n.dataset.style));
    assert.ok(pills.length > 1, 'no filters to try');
    for (const style of pills.concat(['All'])) {
      await page.click(`.filter-pills .pill[data-style="${style}"]`);
      await page.waitForFunction((s) => document.querySelector(`.filter-pills .pill[data-style="${s}"]`).getAttribute('aria-pressed') === 'true', style);
    }
    await page.waitForTimeout(300);
    assert.deepStrictEqual(stubs.log.filter((e) => e.path === '/api/search' || e.path === '/api/interpret'), [],
      'a Discover filter reached the search or the interpreter');
    assert.strictEqual(searchRequests.length, 0);
    assert.ok(await page.$$eval('#discover-grid .item-card', (ns) => ns.length) > 0, 'Discover shows nothing to browse');
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

  const PAGES = ['index.html', 'find-clothes.html', 'discover.html', 'about.html', 'pricing.html', 'account.html'];

  /* each page is given a moment to render whatever it builds from the
     catalogue, so cards, badges and pills are audited too, not just the
     static shell */
  const settled = async (file) => {
    const page = await openPage(file);
    const built = {
      'discover.html': '.item-card',
      /* the search pages read the live searches left from /api/account;
         the audit waits for the count so its ink is checked too */
      'index.html': '#ask-usage:not(:empty)',
      'find-clothes.html': '#ask-usage:not(:empty)',
      /* both billing pages draw themselves from /api/account, so the
         audit has to wait for the answer or it walks an empty shell */
      'pricing.html': '.plan-banner:not([hidden])',
      /* Signed out, the account page is the two choices; the dashboard
         behind it is hidden, so this waits for the shell that is
         actually on screen. The signed-in view is audited separately. */
      'account.html': '#panel-choose:not([hidden])'
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

  await test('no stylesheet rule paints type with a gradient or a glow', async () => {
    const css = fs.readFileSync(path.join(REPO, 'assets', 'styles.css'), 'utf8');
    assert.ok(!/background-clip:\s*text/.test(css), 'no rule may clip a background to its text');
    assert.ok(!/text-shadow/.test(css), 'no rule may glow');
    assert.ok(!/linear-gradient|radial-gradient|conic-gradient/.test(css), 'no rule may paint a gradient');
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
        example: getComputedStyle(document.querySelector('.example')).color === rgbOf('--color-accent-ink'),
        step: getComputedStyle(document.querySelector('.step-num')).color === rgbOf('--color-accent-ink'),
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
  });

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
