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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const searchRequests = [];
const billingRequests = [];

/* What the stub /api/account answers with. Shaped exactly like the real
   endpoint's reply, because the whole point of the billing interface is
   that it renders what the server said and decides nothing itself — so
   the test drives it the only way anything can: by changing the
   server's answer. */
const PLAN_LIMITS = {
  free: { aiTokens: 20000, searches: 3 },
  pro: { aiTokens: 1000000, searches: 75 },
  max: { aiTokens: 5000000, searches: 400 }
};

const planCatalogue = () => [
  { id: 'free', name: 'Free', amount: 0, interval: null, period: 'day', limits: PLAN_LIMITS.free, tagline: 'Try it out, every day.', features: [], purchasable: false },
  { id: 'pro', name: 'Pro', amount: 14.99, interval: 'month', period: 'month', limits: PLAN_LIMITS.pro, tagline: 'For shopping properly.', features: [], purchasable: true },
  { id: 'max', name: 'Max', amount: 79.99, interval: 'month', period: 'month', limits: PLAN_LIMITS.max, tagline: 'For searching all day.', features: [], purchasable: true }
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
    usage: { aiTokens: usageOf('aiTokens', 1200), searches: usageOf('searches', 1) },
    billing: { enabled: true, testMode: true, webhookConfigured: true, portal: false },
    accounts: { enabled: true },
    storage: { durable: true }
  }, (over && over.extra) || {});
};

let accountState = accountReply({});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (['/api/account', '/api/auth', '/api/checkout', '/api/portal'].includes(url.pathname)) {
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
      billingRequests.push({ path: url.pathname, body: parsed });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/checkout') return res.end(JSON.stringify({ url: 'https://checkout.stripe.test/session', plan: parsed.plan }));
      if (url.pathname === '/api/portal') return res.end(JSON.stringify({ url: 'https://billing.stripe.test/portal' }));
      return res.end(JSON.stringify(accountState));
    });
  }

  if (url.pathname === '/api/interpret' || url.pathname === '/api/search') {
    let body = '';
    req.on('data', (d) => { body += d; });
    return req.on('end', () => {
      const parsed = (() => { try { return JSON.parse(body); } catch (e) { return {}; } })();
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/interpret') {
        return res.end(JSON.stringify({ source: 'openai', query: 'q', preferences: {
          categories: ['hoodie'], colors: ['Black'], fits: [], occasions: [], brands: [], styles: [],
          keywords: [], maxPrice: null, minPrice: null, season: null, gender: null } }));
      }
      searchRequests.push(parsed);
      res.end(JSON.stringify({ source: 'openwebninja', products: [{
        id: '1', name: 'Champion Hoodie', price: 68, currency: 'USD',
        imageUrl: 'https://img.example/a.jpg', productUrl: 'https://www.nordstrom.com/s/hoodie/1',
        retailer: 'Nordstrom', category: '', colors: [], sizes: []
      }], returned: 1, rejected: {}, attachments: { received: (parsed.attachments || []).length, used: 0 } }));
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

const textStyleProblems = (page, inks) => page.evaluate((allowed) => {
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
}, inks);

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
    assert.deepStrictEqual(cards.map((c) => c.amount), ['$0', '$14.99', '$79.99']);
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
    assert.ok(!/price|amount|currency|interval|14\.99|79\.99/i.test(sent), sent);
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

  await test('the meters follow the plan: Pro shows the monthly allowance', async () => {
    const page = await openBilling('account.html', { planId: 'pro', extra: { signedIn: true, user: { email: 'a@b.co' } } });
    const values = await page.$$eval('.meter-value', (ns) => ns.map((n) => n.textContent.trim()));
    assert.ok(values[0].endsWith('of 1,000,000 used'), values[0]);
    assert.ok(values[1].endsWith('of 75 used'), values[1]);
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
