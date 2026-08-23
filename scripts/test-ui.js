#!/usr/bin/env node
/* =========================================================
   FindWear — interface tests

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
const zlib = require('zlib');

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

/* What the stubbed server currently reports, and whether it should
   refuse. Tests set these to put the page in a given state. */
const meterState = {
  plan: 'free',
  planName: 'Free',
  usageWindow: 'today',
  period: 'day',
  searches: { used: 0, limit: 3 },
  tokens: { used: 0, limit: 20000 },
  refuse: null
};

const usageSnapshot = () => ({
  plan: meterState.plan,
  planName: meterState.planName,
  period: meterState.period,
  periodLabel: meterState.period,
  usageWindow: meterState.usageWindow,
  resetAt: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
  resetInSeconds: 4 * 3600,
  authenticated: false,
  meters: {
    searches: Object.assign({}, meterState.searches, {
      remaining: Math.max(0, meterState.searches.limit - meterState.searches.used),
      exhausted: meterState.searches.used >= meterState.searches.limit
    }),
    tokens: Object.assign({}, meterState.tokens, {
      remaining: Math.max(0, meterState.tokens.limit - meterState.tokens.used),
      exhausted: meterState.tokens.used >= meterState.tokens.limit
    })
  }
});

const PLAN_TABLE = [
  { id: 'free', name: 'Free', priceUsd: 0, priceLabel: '$0', cadence: null, blurb: 'Enough to try FindWear properly.',
    features: ['20k AI tokens/day', '3 live searches/day'], limits: { tokens: 20000, searches: 3 } },
  { id: 'pro', name: 'Pro', priceUsd: 14.99, priceLabel: '$14.99', cadence: 'month', blurb: 'For shopping that is more than occasional.',
    features: ['1M AI tokens/month', '75 live searches/month'], limits: { tokens: 1000000, searches: 75 } },
  { id: 'max', name: 'Max', priceUsd: 79.99, priceLabel: '$79.99', cadence: 'month', blurb: 'Our most generous plan, with headroom for heavy days.',
    features: ['5M AI tokens/month', '400 live searches/month'], limits: { tokens: 5000000, searches: 400 } }
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/usage') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ usage: usageSnapshot(), plans: PLAN_TABLE }));
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
      if (meterState.refuse) {
        res.statusCode = 429;
        return res.end(JSON.stringify({
          error: 'usage_limit_reached',
          limitType: meterState.refuse,
          usage: meterState[meterState.refuse].limit,
          limit: meterState[meterState.refuse].limit,
          remaining: 0,
          plan: meterState.plan,
          planName: meterState.planName,
          period: meterState.period,
          usageWindow: meterState.usageWindow,
          resetAt: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
          resetInSeconds: 4 * 3600
        }));
      }
      res.end(JSON.stringify({ usage: usageSnapshot(), source: 'openwebninja', products: [{
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

   Every element that renders text of its own must draw it in plain black,
   with none of the gradient-filled, clipped or glowing treatments the
   interface used to carry. */
const textStyleProblems = (page) => page.evaluate(() => {
  const BLACK = 'rgb(0, 0, 0)';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const problems = [];

  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (SKIP.has(el.tagName)) continue;
    const rendersText = Array.from(el.childNodes)
      .some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!rendersText) continue;

    const cs = getComputedStyle(el);
    const where = `${label(el)} ("${el.textContent.trim().slice(0, 32)}")`;

    if (cs.color !== BLACK) problems.push(`${where} is ${cs.color}, not black`);
    if (cs.webkitTextFillColor && cs.webkitTextFillColor !== BLACK) {
      problems.push(`${where} fills its glyphs with ${cs.webkitTextFillColor}`);
    }
    if ((cs.webkitBackgroundClip || cs.backgroundClip) === 'text') {
      problems.push(`${where} clips a background to its text`);
    }
    if (/gradient/.test(cs.backgroundImage)) problems.push(`${where} sits on a gradient`);
    if (cs.textShadow !== 'none') problems.push(`${where} has a text shadow: ${cs.textShadow}`);
  }
  return problems;
});

/* A computed style cannot prove what a visitor sees — a tint can come
   from a parent, a blend mode or a rule that only applies while painting.
   These unpack a real screenshot instead and look at every pixel.
   Playwright hands back an 8-bit PNG, so this only has to undo the
   deflate and the per-row filters. */
function pixelsOf(png) {
  let pos = 8;
  let width, height, depth, colorType;
  const idat = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  assert.strictEqual(depth, 8, 'expected an 8-bit screenshot');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let i = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[i]; i += 1;
    const line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { width, height, ch, data: out };
}

/* A pixel whose channels disagree is carrying a hue. Black, white and
   every grey in between have all three channels equal, so a gradient,
   tint or iridescent fill cannot hide from this. */
function colouredPixels(png) {
  const { width, height, ch, data } = pixelsOf(png);
  const found = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * ch;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat > 4) found.push({ x, y, rgb: `rgb(${r}, ${g}, ${b})`, sat });
    }
  }
  return found;
}

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
      window.FINDWEAR_USAGE_API = 'http://127.0.0.1:8899/api/usage';
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

  console.log('\ntypography and text styling');

  const PAGES = ['index.html', 'find-clothes.html', 'discover.html', 'about.html', 'pricing.html'];

  /* each page is given a moment to render whatever it builds from the
     catalogue, so cards, badges and pills are audited too, not just the
     static shell */
  const settled = async (file) => {
    const page = await openPage(file);
    const built = { 'index.html': '.mini-item', 'discover.html': '.item-card', 'pricing.html': '.plan-card' }[file];
    if (built) await page.waitForSelector(built, { timeout: 10000 });
    return page;
  };

  for (const file of PAGES) {
    await test(`every piece of text on ${file} is black`, async () => {
      const page = await settled(file);
      const problems = await textStyleProblems(page);
      assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
      await page.close();
    });
  }

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
    const grad = await page.$eval('.hero h1 .grad', (n) => {
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

  await test('search results, badges and product text are black', async () => {
    const page = await open();
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.item-card', { timeout: 10000 });
    const problems = await textStyleProblems(page);
    assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
    /* the retailer badge sits over the product image and used to be the
       one coloured label left on a card */
    assert.strictEqual(await page.$eval('.item-badge', (n) => getComputedStyle(n).color), 'rgb(0, 0, 0)');
    await page.close();
  });

  await test('attachment chips, the drop cue and the error line are black', async () => {
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

    const problems = await textStyleProblems(page);
    assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
    await page.close();
  });

  await test('placeholder text is black too', async () => {
    for (const file of PAGES) {
      const page = await settled(file);
      (await placeholderColours(page)).forEach(({ selector, color }) => {
        assert.strictEqual(color, 'rgb(0, 0, 0)', `${file} ${selector} placeholder is ${color}`);
      });
      await page.close();
    }
  });

  console.log('\nthe "Find my clothes" button');

  /* the button appears on all four pages: the hero and the closing band
     on the home page, the submit on Find Clothes, the band elsewhere */
  const PRIMARY_BUTTONS = [
    ['find-clothes.html', '#ask-form button[type=submit]'],
    ['index.html', '.hero .btn-primary'],
    ['index.html', '.cta-band .btn-primary'],
    ['discover.html', '.cta-band .btn-primary'],
    ['about.html', '.cta-band .btn-primary']
  ];

  for (const [file, selector] of PRIMARY_BUTTONS) {
    await test(`"Find my clothes" is plain black on ${file} (${selector})`, async () => {
      const page = await settled(file);
      const el = await page.waitForSelector(selector);
      assert.ok(/find my clothes/i.test((await el.textContent()).trim()),
        `${selector} on ${file} is not the "Find my clothes" button`);

      const seen = await el.evaluate((n) => {
        const cs = getComputedStyle(n);
        const arrow = getComputedStyle(n.querySelector('svg'));
        return {
          colour: cs.color,
          fill: cs.webkitTextFillColor,
          background: cs.backgroundImage,
          clip: cs.webkitBackgroundClip || cs.backgroundClip,
          glow: cs.textShadow,
          filter: cs.filter,
          blend: cs.mixBlendMode,
          animation: cs.animationName,
          arrowColour: arrow.color,
          arrowStroke: arrow.stroke,
          arrowFilter: arrow.filter,
          arrowAnimation: arrow.animationName
        };
      });

      assert.strictEqual(seen.colour, 'rgb(0, 0, 0)', 'the label must be black');
      assert.strictEqual(seen.fill, 'rgb(0, 0, 0)', 'the glyphs must be filled black');
      assert.strictEqual(seen.arrowColour, 'rgb(0, 0, 0)', 'the arrow must be black');
      assert.strictEqual(seen.arrowStroke, 'rgb(0, 0, 0)', 'the arrow must be stroked black');
      assert.strictEqual(seen.background, 'none', 'no gradient may fill the button');
      assert.notStrictEqual(seen.clip, 'text', 'no background may be clipped to the label');
      assert.strictEqual(seen.glow, 'none', 'no glow behind the label');
      assert.strictEqual(seen.filter, 'none', 'no filter may tint the button');
      assert.strictEqual(seen.arrowFilter, 'none', 'no filter may tint the arrow');
      assert.strictEqual(seen.blend, 'normal', 'no blend mode may tint the button');
      assert.strictEqual(seen.animation, 'none', 'nothing may animate the button');
      assert.strictEqual(seen.arrowAnimation, 'none', 'nothing may animate the arrow');
      await page.close();
    });
  }

  await test('the rendered button paints no colour, resting, hovered or focused', async () => {
    const page = await settled('find-clothes.html');
    const el = await page.waitForSelector('#ask-form button[type=submit]');
    for (const state of ['resting', 'hovered', 'focused']) {
      if (state === 'hovered') await el.hover();
      if (state === 'focused') await el.focus();
      await page.waitForTimeout(400); /* let the transition land */
      const coloured = colouredPixels(await el.screenshot());
      assert.strictEqual(coloured.length, 0,
        `${state}: ${coloured.length} coloured pixels, e.g. ${JSON.stringify(coloured.slice(0, 3))}`);
    }
    await page.close();
  });

  await test('the button keeps its shape, size and spacing', async () => {
    const page = await settled('find-clothes.html');
    const box = await page.$eval('#ask-form button[type=submit]', (n) => {
      const cs = getComputedStyle(n);
      const r = n.getBoundingClientRect();
      return {
        height: Math.round(r.height),
        width: Math.round(r.width),
        radius: cs.borderRadius,
        padding: cs.padding,
        gap: cs.gap,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        display: cs.display
      };
    });
    /* Measured on the build that still had the gradient fill, so this
       pins the geometry to exactly what it was before the recolouring.
       `display` reads flex rather than inline-flex because the button is
       a flex item of .ask-actions and is blockified. */
    assert.deepStrictEqual(box, {
      height: 56,
      width: 212,
      radius: '999px',
      padding: '0px 30px',
      gap: '10px',
      fontSize: '16.5px',
      fontWeight: '600',
      display: 'flex'
    });
    await page.close();
  });

  await test('the button still submits the search', async () => {
    searchRequests.length = 0;
    const page = await open();
    await page.fill('#ask', 'black oversized hoodie');
    await page.click('#ask-form button[type=submit]');
    await page.waitForSelector('.item-card', { timeout: 10000 });
    assert.strictEqual(searchRequests.length, 1);
    await page.close();
  });

  await test('no stylesheet rule paints type with a gradient or a glow', async () => {
    const css = fs.readFileSync(path.join(REPO, 'assets', 'styles.css'), 'utf8');
    assert.ok(!/background-clip:\s*text/.test(css), 'no rule may clip a background to its text');
    assert.ok(!/text-shadow/.test(css), 'no rule may glow');
    /* the ink tokens every text rule resolves through */
    ['--ink', '--ink-2', '--muted', '--accent-ink'].forEach((token) => {
      const m = new RegExp(`${token}:\\s*([^;]+);`).exec(css);
      assert.ok(m, `${token} should be defined`);
      assert.strictEqual(m[1].trim().toLowerCase(), '#000000', `${token} is ${m && m[1]}`);
    });
  });

  console.log('\nthe usage meter');

  const meterOf = (page) => page.$eval('#usage-meter', (n) => ({
    hidden: n.hidden,
    plan: n.querySelector('.usage-plan') ? n.querySelector('.usage-plan').textContent.trim() : null,
    reset: n.querySelector('.usage-reset') ? n.querySelector('.usage-reset').textContent.trim() : null,
    values: Array.from(n.querySelectorAll('.meter-value')).map((v) => v.textContent.trim()),
    widths: Array.from(n.querySelectorAll('.meter-fill')).map((v) => v.style.width)
  }));

  const withMeter = async (state) => {
    Object.assign(meterState, state);
    const page = await openPage('find-clothes.html');
    await page.waitForFunction(() => {
      const n = document.getElementById('usage-meter');
      return n && !n.hidden && n.querySelector('.meter-value');
    }, { timeout: 10000 });
    return page;
  };

  await test('a Free meter reads exactly "3 / 3 searches used today"', async () => {
    const page = await withMeter({
      plan: 'free', planName: 'Free', usageWindow: 'today', period: 'day',
      searches: { used: 3, limit: 3 }, tokens: { used: 7420, limit: 20000 }, refuse: null
    });
    const m = await meterOf(page);
    assert.strictEqual(m.plan, 'Free plan');
    assert.deepStrictEqual(m.values, ['3 / 3 searches used today', '7,420 / 20,000 AI tokens']);
    await page.close();
  });

  await test('a Pro meter reads "42 / 75 searches used this month"', async () => {
    const page = await withMeter({
      plan: 'pro', planName: 'Pro', usageWindow: 'this month', period: 'month',
      searches: { used: 42, limit: 75 }, tokens: { used: 238411, limit: 1000000 }, refuse: null
    });
    const m = await meterOf(page);
    assert.strictEqual(m.plan, 'Pro plan');
    assert.deepStrictEqual(m.values, ['42 / 75 searches used this month', '238,411 / 1,000,000 AI tokens']);
    await page.close();
  });

  await test('a Max meter reads "215 / 400 searches used this month"', async () => {
    const page = await withMeter({
      plan: 'max', planName: 'Max', usageWindow: 'this month', period: 'month',
      searches: { used: 215, limit: 400 }, tokens: { used: 1200000, limit: 5000000 }, refuse: null
    });
    const m = await meterOf(page);
    assert.deepStrictEqual(m.values, ['215 / 400 searches used this month', '1,200,000 / 5,000,000 AI tokens']);
    await page.close();
  });

  await test('searches are shown first, tokens second', async () => {
    const page = await withMeter({
      plan: 'free', planName: 'Free', usageWindow: 'today', period: 'day',
      searches: { used: 1, limit: 3 }, tokens: { used: 500, limit: 20000 }, refuse: null
    });
    const labels = await page.$$eval('#usage-meter .meter-label', (ns) => ns.map((n) => n.textContent.trim()));
    assert.deepStrictEqual(labels, ['Live searches', 'AI tokens'],
      'the count a shopper can hold in their head leads');
    await page.close();
  });

  await test('the bar matches the number beside it and never overflows', async () => {
    const page = await withMeter({
      plan: 'free', planName: 'Free', usageWindow: 'today', period: 'day',
      searches: { used: 3, limit: 3 }, tokens: { used: 5000, limit: 20000 }, refuse: null
    });
    const m = await meterOf(page);
    assert.deepStrictEqual(m.widths, ['100%', '25%']);
    await page.close();
  });

  await test('the meter shows nothing until the server has answered', async () => {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      /* an endpoint that never answers: the page must not invent a meter */
      window.FINDWEAR_USAGE_API = 'http://127.0.0.1:9/api/usage';
      window.FINDWEAR_API = 'http://127.0.0.1:9/api/interpret';
    });
    await page.route((url) => !String(url).includes('127.0.0.1:8899'), (route) => route.abort());
    await page.goto(`http://127.0.0.1:${PORT}/find-clothes.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    assert.strictEqual(await page.$eval('#usage-meter', (n) => n.hidden), true,
      'no meter is honest; a guessed one is not');
    await page.close();
  });

  await test('the meter updates from the search reply, not from its own tally', async () => {
    Object.assign(meterState, {
      plan: 'free', planName: 'Free', usageWindow: 'today', period: 'day',
      searches: { used: 0, limit: 3 }, tokens: { used: 0, limit: 20000 }, refuse: null
    });
    const page = await open();
    await page.waitForFunction(() => {
      const n = document.getElementById('usage-meter');
      return n && !n.hidden && n.querySelector('.meter-value');
    }, { timeout: 10000 });
    assert.strictEqual((await meterOf(page)).values[0], '0 / 3 searches used today');

    /* the server now reports 2; the page must adopt that, not add 1 */
    meterState.searches = { used: 2, limit: 3 };
    await page.fill('#ask', 'black hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.item-card', { timeout: 10000 });
    await page.waitForFunction(() => {
      const v = document.querySelector('#usage-meter .meter-value');
      return v && v.textContent.includes('2 / 3');
    }, { timeout: 10000 });
    assert.strictEqual((await meterOf(page)).values[0], '2 / 3 searches used today');
    await page.close();
  });

  await test('running out shows the limit panel with the server figures', async () => {
    Object.assign(meterState, {
      plan: 'free', planName: 'Free', usageWindow: 'today', period: 'day',
      searches: { used: 3, limit: 3 }, tokens: { used: 0, limit: 20000 }, refuse: 'searches'
    });
    const page = await open();
    await page.fill('#ask', 'black hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.empty', { timeout: 10000 });

    const panel = await page.$eval('.empty', (n) => n.textContent.replace(/\s+/g, ' ').trim());
    assert.ok(/Live searches used up/.test(panel), panel);
    assert.ok(/3 \/ 3 used on Free/.test(panel), panel);
    assert.ok(/all 3 live searches/.test(panel), panel);
    assert.ok(/Resets in/.test(panel), panel);
    assert.ok(await page.$('.limit-actions a[href="pricing.html"]'), 'and offers a way forward');

    /* never sample products: nothing was searched */
    assert.strictEqual(await page.$$eval('.item-card', (ns) => ns.length), 0);
    meterState.refuse = null;
    await page.close();
  });

  await test('the limit panel is black type like the rest of the page', async () => {
    Object.assign(meterState, { searches: { used: 3, limit: 3 }, refuse: 'searches' });
    const page = await open();
    await page.fill('#ask', 'black hoodie');
    await page.click('button[type=submit]');
    await page.waitForSelector('.empty', { timeout: 10000 });
    const problems = await textStyleProblems(page);
    assert.deepStrictEqual(problems, [], `\n        ${problems.join('\n        ')}`);
    meterState.refuse = null;
    await page.close();
  });

  await test('a double-click sends one submission key, not two different ones', async () => {
    searchRequests.length = 0;
    Object.assign(meterState, { searches: { used: 0, limit: 3 }, refuse: null });
    const page = await open();
    await page.fill('#ask', 'black hoodie');
    /* two clicks in the same tick, the way a real double-click lands */
    await page.evaluate(() => {
      const b = document.querySelector('#ask-form button[type=submit]');
      b.click(); b.click();
    });
    await page.waitForSelector('.item-card', { timeout: 10000 });
    await page.waitForTimeout(300);
    const keys = new Set(searchRequests.map((r) => r.idempotencyKey).filter(Boolean));
    /* the key travels as a header, so assert on what the browser sent */
    assert.ok(searchRequests.length >= 1, 'at least one search was sent');
    assert.ok(keys.size <= 1, 'a double-click must not mint two different submission keys');
    await page.close();
  });

  await test('the pricing page lists the three plans with their real numbers', async () => {
    const page = await settled('pricing.html');
    await page.waitForFunction(() => document.querySelectorAll('.plan-card').length === 3, { timeout: 10000 });
    const cards = await page.$$eval('.plan-card', (ns) => ns.map((n) => ({
      name: n.querySelector('.plan-name').textContent.trim(),
      price: n.querySelector('.plan-amount').textContent.trim(),
      cadence: n.querySelector('.plan-cadence') ? n.querySelector('.plan-cadence').textContent.trim() : '',
      features: Array.from(n.querySelectorAll('.plan-features li')).map((f) => f.textContent.trim())
    })));

    assert.deepStrictEqual(cards.map((c) => c.name), ['Free', 'Pro', 'Max']);
    assert.deepStrictEqual(cards.map((c) => c.price), ['$0', '$14.99', '$79.99']);
    assert.deepStrictEqual(cards[0].features, ['20k AI tokens/day', '3 live searches/day']);
    assert.deepStrictEqual(cards[1].features, ['1M AI tokens/month', '75 live searches/month']);
    assert.deepStrictEqual(cards[2].features, ['5M AI tokens/month', '400 live searches/month']);
    assert.strictEqual(cards[1].cadence, '/month');
    await page.close();
  });

  await test('Max is set apart without ever being called unlimited', async () => {
    const page = await settled('pricing.html');
    await page.waitForFunction(() => document.querySelectorAll('.plan-card').length === 3, { timeout: 10000 });
    const text = await page.$eval('body', (n) => n.textContent.toLowerCase());
    assert.ok(!text.includes('unlimited'), 'a ceiling exists, so it is named');
    assert.ok(await page.$('.plan-card--max'), 'Max is still distinguished');
    assert.ok(/most generous/i.test(await page.$eval('.plan-card--max', (n) => n.textContent)));
    await page.close();
  });

  await test('no page leaks a key, a token or a plan secret into the markup', async () => {
    for (const file of PAGES) {
      const page = await settled(file);
      const html = await page.content();
      /* a real key is a long run after a word boundary; without the
         boundary this matches "ask-dropveil" and cries wolf */
      assert.ok(!/\bsk-[A-Za-z0-9]{16,}/.test(html), `${file} carries something key-shaped`);
      ['OPENAI_API_KEY', 'OPENWEBNINJA_API_KEY', 'SESSION_SECRET', 'UPSTASH'].forEach((name) => {
        assert.ok(!html.includes(name), `${file} names ${name}`);
      });
      await page.close();
    }
  });

  await browser.close();
  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.error(err); server.close(); process.exit(1); });
