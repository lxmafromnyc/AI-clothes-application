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
    usage: { aiTokens: usageOf('aiTokens', 1200), searches: usageOf('searches', 1) },
    billing: { enabled: true, testMode: true, webhookConfigured: true, portal: false },
    accounts: { enabled: true },
    storage: { durable: true }
  }, (over && over.extra) || {});
};

let accountState = accountReply({});

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
        interpretRequests.push(parsed);
        return res.end(JSON.stringify({ source: 'openai', query: 'q', preferences: {
          categories: ['hoodie'], colors: ['Black'], fits: [], occasions: [], brands: [], styles: [],
          keywords: [], maxPrice: null, minPrice: null, season: null, gender: null } }));
      }
      searchRequests.push(parsed);
      res.end(JSON.stringify({ source: 'openwebninja', products: [{
        id: '1', name: 'Champion Hoodie', price: 68, currency: 'USD',
        imageUrl: searchPhoto, productUrl: 'https://www.nordstrom.com/s/hoodie/1',
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
    /* Discover only shelves rows whose photos arrive */
    const page = await openPage(file, { photos: file === 'discover.html' });
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
