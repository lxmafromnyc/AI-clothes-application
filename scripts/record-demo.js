#!/usr/bin/env node
/* =========================================================
   Fynd — records the landing page demo video

   A screen recording of a person using Fynd for the first time:

     the homepage, a moment to look at it
     the pointer goes to the search box, clicks, and the request is typed
       "I'm looking for a black oversized hoodie, under eighty dollars."
     Search is clicked; the site's own searching state runs
     real products come back: photos, brands, names, prices, retailers
       "Fynd finds matching products from different retailers."
     a small scroll, a product is pointed at, and clicked
       "And I can open the product directly at the retailer."
     the retailer's own page opens in a new tab, as it does for anyone
     back on Fynd: "Describe what you want. Fynd finds it."

   Nothing on screen is made for the camera. The page is the site as
   visitors get it, the search is the real Fynd search — the real
   /api/interpret and /api/search handlers from this repository, run with
   your own .env — and the products are the real listings it returns, with
   their real photographs, prices and retailer links. If any product comes
   back without a real photograph, or a photograph does not load, the
   script stops and writes nothing: it never falls back to drawings or
   placeholders.

   It runs in two passes:

     1. The search. The request is typed into the page once, off camera,
        and the real search answers it. What it answered — every product,
        exactly as the page received it — is saved to
        assets/demo/demo-search.json, and every photo is checked loaded.
     2. The recordings. Desktop, then the phone layout, each driven like a
        person would drive it. Both ask the same real answer back from
        the saved search, so the two show the same products, and a
        re-recording shows the same products as the last one.

   Usage (from the repository root, with your .env in place):

     node scripts/record-demo.js            search for real, then record both
     node scripts/record-demo.js --replay   record again from the saved search
     node scripts/record-demo.js --stills   a PNG at every beat, no video
     node scripts/record-demo.js --only=desktop   (or --only=mobile)
     node scripts/record-demo.js --out=DIR  write somewhere other than assets/demo

   Needs:
     - Playwright with Chromium (npx playwright install chromium)
     - ffmpeg with libx264, libvpx-vp9, aac and libopus
     - network access to your product source, OpenAI, and the retailers'
       image hosts and pages — the same access a visitor's browser has
     - .env with PRODUCT_SOURCE and that source's key; OPENAI_API_KEY for
       the AI interpreter (without it the page reads the request with its
       local interpreter, exactly as the live site would)

   The recording never touches production state: KV / Upstash settings are
   dropped from this process, so the one search it makes is metered in
   memory, not against anybody's real allowance.

   The narration is three committed clips in assets/demo/narration/, made
   by scripts/demo-narration.py. Nothing here needs a speech model.

   Writes, into assets/demo/:
     fynd-demo.mp4 / .webm                desktop, 1280 x 800, with narration
     fynd-demo-mobile.mp4 / .webm         phone layout, 800 x 1440 (400 x 720 @2x)
     fynd-demo-poster.jpg, fynd-demo-mobile-poster.jpg
     fynd-demo.vtt, fynd-demo-mobile.vtt  captions, timed to the narration
     demo-search.json                     the real search both were made from

   Determinism: the pointer paths, typing rhythm and pauses come from a
   seeded generator, the narration is fixed, and --replay reuses the saved
   search, so the same inputs make the same video.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const arg = (name) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

const OUT = path.resolve(arg('out') || path.join(REPO, 'assets', 'demo'));
const NARRATION = path.join(REPO, 'assets', 'demo', 'narration');
const SEARCH_FILE = path.join(OUT, 'demo-search.json');
const STILLS = Boolean(arg('stills'));
const REPLAY = arg('replay');
const ONLY = arg('only');
const PORT = Number(process.env.DEMO_PORT || 8917);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const QUERY = 'black oversized hoodie under $80';
const SEED = 20261002;

/* the fewest products worth showing, and the longest the page's own
   "Searching…" state is allowed to run on camera: the real search can
   take several seconds, and a recording of a spinner is not the point */
const MIN_PRODUCTS = 4;
const MAX_LOADING_MS = 1800;
const MIN_LOADING_MS = 900;

const CAPTION_END = 'Describe what you want. Fynd finds it.';

const SHOTS = [
  { name: 'fynd-demo', kind: 'desktop', width: 1280, height: 800, dpr: 1, touch: false, h264: 28, vp9: 37 },
  { name: 'fynd-demo-mobile', kind: 'mobile', width: 400, height: 720, dpr: 2, touch: true, h264: 31, vp9: 41 }
].filter((s) => !ONLY || s.kind === ONLY);

/* ---------------------------------------------------------
   Setup
   --------------------------------------------------------- */

function fail(message) {
  console.error(`\n✗ ${message}\n\nNothing was written.`);
  process.exit(1);
}

/* .env is read the way the deployment would read its variables: each
   KEY=value line, without overriding anything already in the environment.
   Values are never printed. */
function loadEnv() {
  const file = path.join(REPO, '.env');
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const candidates = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg',
    path.join(REPO, 'node_modules', 'ffmpeg-static', 'ffmpeg')];
  return candidates.find((p) => fs.existsSync(p)) || 'ffmpeg';
}
const FFMPEG = findFfmpeg();
const FFPROBE = process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg$/, 'ffprobe');

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright', '@playwright/test',
    '/opt/node-tools/node_modules/playwright', '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const t of tries) {
    try { return require(t).chromium; } catch (err) { /* next */ }
  }
  return fail('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = '/opt/pw-browsers';
  if (fs.existsSync(root)) {
    const dir = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()[0];
    const p = dir && path.join(root, dir, 'chrome-linux', 'chrome');
    if (p && fs.existsSync(p)) return p;
  }
  return undefined; /* Playwright's own */
}

/* ---------------------------------------------------------
   A seeded hand: every pause, path and keystroke comes from here, so a
   run is repeatable and still never perfectly even.
   --------------------------------------------------------- */

function generator(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (lo, hi) => lo + (hi - lo) * next(),
    /* roughly normal, from the sum of three uniforms */
    around: (mean, spread) => mean + spread * ((next() + next() + next()) / 1.5 - 1)
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/* ---------------------------------------------------------
   The local origin: the repository's files as they are, and the two API
   routes answered by the repository's own handlers.
   --------------------------------------------------------- */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt', '.wav': 'audio/wav'
};

/* what the API routes do: 'live' runs the real handlers and keeps what
   they answered; 'replay' gives that same answer back */
const api = { mode: 'live', exchanges: {}, saved: null };

function vercelRes(res) {
  const out = {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) {
      res.statusCode = code;
      return {
        json: (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); },
        end: () => res.end()
      };
    }
  };
  return out;
}

/* runs a real handler and keeps the request and its answer */
async function live(route, req, res) {
  const handler = require(path.join(REPO, 'api', `${route}.js`));
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  await new Promise((r) => req.on('end', r));
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (err) { body = {}; }

  const started = Date.now();
  let status = 200;
  let answer = null;
  const fake = {
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) {
      status = code;
      return {
        json: (payload) => { answer = payload; },
        end: () => {}
      };
    }
  };
  await handler({ method: req.method, headers: req.headers, body, socket: req.socket,
    on: () => {}, destroy: () => {} }, fake);
  const ms = Date.now() - started;
  api.exchanges[route] = { request: body, status, ms, response: answer };

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(answer));
}

function replay(route, res) {
  const saved = api.saved && api.saved[route];
  if (!saved) { res.statusCode = 503; return res.end('{}'); }
  const delay = route === 'search'
    ? Math.min(MAX_LOADING_MS, Math.max(MIN_LOADING_MS, saved.ms))
    : Math.min(700, Math.max(250, saved.ms));
  setTimeout(() => {
    res.statusCode = saved.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(saved.response));
  }, delay);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const route = /^\/api\/(interpret|search)\/?$/.exec(url.pathname);
  if (route) {
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (api.mode === 'live') {
      return live(route[1], req, res).catch((err) => {
        console.error(`  /api/${route[1]} threw:`, err && err.message);
        res.statusCode = 500; res.end('{}');
      });
    }
    return replay(route[1], res);
  }
  if (url.pathname.startsWith('/api/')) { res.statusCode = 404; return res.end('{}'); }

  const file = path.join(REPO, decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html');
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

/* ---------------------------------------------------------
   What the camera changes about the page

   - The demo section is hidden, so the video never contains itself.
   - The search box starts empty. Its placeholder is the very sentence
     typed in the video; left on, the request would be on screen before
     anybody asked for it.
   - The page asks this machine's API instead of the production one, so
     the search runs with your .env, not the deployment's.

   Nothing else: type, colour, layout, the box, the button, the cards and
   the photos are the site's own.
   --------------------------------------------------------- */

function pagePrep(origin) {
  window.FINDWEAR_API = `${origin}/api/interpret`;
  window.FINDWEAR_SEARCH_API = `${origin}/api/search`;
  const blank = new MutationObserver(() => {
    const field = document.getElementById('ask');
    if (!field) return;
    field.setAttribute('placeholder', '');
    blank.disconnect();
  });
  blank.observe(document, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style');
    s.textContent = '#demo { display: none !important; }';
    document.head.appendChild(s);
  });
}

/* ---------------------------------------------------------
   The layer that only exists for the camera

   A headless browser draws no pointer, so the pointer is drawn here —
   the size of a real one, following the real mouse events the page
   receives, and taking the shape the page asks for: an arrow, a text
   cursor over the box, a hand over a link. On a phone there is no
   pointer; a touch shows as a small soft dot, the way a phone's own
   screen recording shows touches.

   The caption sits in a thin strip along the bottom edge, never over a
   product or a control, and shows the words being spoken.
   --------------------------------------------------------- */

function overlay(touch) {
  const install = () => {
    if (document.getElementById('demo-layer')) return;
    const style = document.createElement('style');
    style.textContent = `
      #demo-layer { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      #demo-pointer { position: absolute; left: 0; top: 0; width: 24px; height: 24px; display: none; will-change: transform; }
      #demo-pointer.on { display: block; }
      #demo-pointer svg { display: none; position: absolute; left: 0; top: 0; overflow: visible; }
      #demo-pointer[data-shape="arrow"] .arrow, #demo-pointer[data-shape="hand"] .hand,
      #demo-pointer[data-shape="text"] .text { display: block; }
      #demo-touch { position: absolute; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
        border-radius: 50%; background: rgba(60,60,60,.22); border: 1px solid rgba(255,255,255,.7);
        opacity: 0; transition: opacity .18s ease; }
      #demo-touch.on { opacity: 1; transition: opacity .06s ease; }
      #demo-strip { position: absolute; left: 0; right: 0; bottom: 0; height: ${touch ? 44 : 46}px;
        display: flex; align-items: center; justify-content: center; padding: 0 16px;
        background: #fff; border-top: 1px solid #E7E7E3; }
      #demo-caption { color: #111; font-size: ${touch ? 13.5 : 14}px; font-weight: 500; letter-spacing: -.005em;
        line-height: 1.25; text-align: center; opacity: 0; transition: opacity .3s ease; }
      #demo-caption.on { opacity: 1; }
      /* the screencast only sends a frame when something repaints; one
         pixel that keeps repainting keeps the frame rate even */
      #demo-tick { position: absolute; right: 0; top: 0; width: 1px; height: 1px; background: #fff;
        animation: demo-tick .2s steps(2) infinite; }
      @keyframes demo-tick { to { background: #fefefe; } }
    `;
    document.head.appendChild(style);
    const layer = document.createElement('div');
    layer.id = 'demo-layer';
    layer.innerHTML = `
      <div id="demo-pointer" data-shape="arrow">
        <svg class="arrow" width="17" height="25" viewBox="0 0 17 25"><path d="M1.5 1.5v19.2l4.6-4.4 3.2 7.2 3-1.3-3.1-7h6.4z"
          fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>
        <svg class="hand" width="22" height="25" viewBox="0 0 22 25" style="left:-6px;top:-1px"><path d="M8.2 1.4c-1 0-1.8.8-1.8 1.8v9.3l-1.3-1.4c-.8-.8-2-.9-2.8-.2-.8.7-.8 1.9-.1 2.7l4.9 6.1c1.3 1.6 3.2 2.6 5.3 2.6h1.7c3.3 0 6-2.7 6-6v-5.6c0-1-.8-1.8-1.8-1.8s-1.7.7-1.7 1.6V9.9c0-1-.8-1.8-1.8-1.8s-1.8.8-1.8 1.8V9c0-1-.8-1.8-1.8-1.8S11.5 8 11.5 9V3.2c0-1-.8-1.8-1.8-1.8z"
          fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>
        <svg class="text" width="9" height="20" viewBox="0 0 9 20" style="left:-4px;top:-10px"><path d="M1 1.5c1.6 0 2.6.4 3.5 1.3.9-.9 1.9-1.3 3.5-1.3M4.5 2.8v14.4M1 18.5c1.6 0 2.6-.4 3.5-1.3.9.9 1.9 1.3 3.5 1.3"
          fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M1 1.5c1.6 0 2.6.4 3.5 1.3.9-.9 1.9-1.3 3.5-1.3M4.5 2.8v14.4M1 18.5c1.6 0 2.6-.4 3.5-1.3.9.9 1.9 1.3 3.5 1.3"
          fill="none" stroke="#000" stroke-width="1.2" stroke-linecap="round"/></svg>
      </div>
      <div id="demo-touch"></div>
      <div id="demo-strip"><div id="demo-caption"></div></div>
      <div id="demo-tick"></div>`;
    document.body.appendChild(layer);

    const pointer = layer.querySelector('#demo-pointer');
    const dot = layer.querySelector('#demo-touch');
    const caption = layer.querySelector('#demo-caption');

    /* the shape a real pointer would take over whatever is under it */
    const shapeAt = (x, y) => {
      pointer.style.visibility = 'hidden';
      const el = document.elementFromPoint(x, y);
      pointer.style.visibility = '';
      if (!el) return 'arrow';
      const c = getComputedStyle(el).cursor;
      if (c === 'pointer') return 'hand';
      if (c === 'text' || ((c === 'auto') && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /text|search/.test(el.type))))) return 'text';
      return 'arrow';
    };
    if (!touch) {
      window.addEventListener('mousemove', (e) => {
        pointer.classList.add('on');
        pointer.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        pointer.dataset.shape = shapeAt(e.clientX, e.clientY);
      }, { capture: true, passive: true });
      window.addEventListener('scroll', () => {
        const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(pointer.style.transform);
        if (m) pointer.dataset.shape = shapeAt(Number(m[1]), Number(m[2]));
      }, { passive: true });
    }

    window.demo = {
      say: (text) => { caption.textContent = text; caption.classList.add('on'); },
      hush: () => caption.classList.remove('on'),
      touchAt: (x, y, on) => {
        dot.style.transform = `translate(${x}px, ${y}px)`;
        dot.classList.toggle('on', on);
      }
    };
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
}

/* ---------------------------------------------------------
   Pass 1: the real search
   --------------------------------------------------------- */

/* Everything a recording needs to be true of the results, checked in the
   page itself: enough products, every one a real listing, every photo a
   real photograph that actually loaded. Returns what it found, so a
   failure can say exactly which product it was. */
async function checkResults(page) {
  return page.evaluate(async () => {
    const deadline = Date.now() + 25000;
    const cards = () => [...document.querySelectorAll('#results .grid .item-card')];
    const settled = () => cards().every((c) => {
      const img = c.querySelector('.item-media img');
      return !img || (img.complete && img.naturalWidth > 0);
    });
    /* lazy images below the fold load as they near the viewport; ask for
       every one now so the check covers the whole grid */
    cards().forEach((c) => { const img = c.querySelector('img'); if (img) img.loading = 'eager'; });
    while (Date.now() < deadline && !settled()) await new Promise((r) => setTimeout(r, 250));
    return cards().map((c, i) => {
      const img = c.querySelector('.item-media img');
      return {
        i,
        name: (c.querySelector('.item-name') || {}).textContent || '',
        href: c.getAttribute('href') || '',
        retailer: ((c.querySelector('.item-seller') || c.querySelector('.item-retailer') || {}).textContent || '').trim(),
        drawn: Boolean(c.querySelector('.item-media svg')),
        sample: Boolean(c.querySelector('.item-badge')),
        src: img ? img.currentSrc || img.src : '',
        width: img ? img.naturalWidth : 0,
        height: img ? img.naturalHeight : 0,
        loaded: Boolean(img && img.complete && img.naturalWidth > 0)
      };
    });
  });
}

function verdict(found) {
  const problems = [];
  if (found.length < MIN_PRODUCTS) problems.push(`only ${found.length} product(s) came back; need at least ${MIN_PRODUCTS}`);
  for (const p of found) {
    const who = `#${p.i + 1} "${p.name.trim().slice(0, 60)}"`;
    if (p.sample) problems.push(`${who} is a sample row, not a real listing`);
    if (p.drawn) problems.push(`${who} shows drawn placeholder artwork instead of a photo`);
    if (!/^https?:\/\//.test(p.href)) problems.push(`${who} has no retailer link`);
    if (!p.drawn && !p.loaded) problems.push(`${who} photo did not load: ${p.src}`);
    if (p.loaded && (p.width < 150 || p.height < 150)) problems.push(`${who} photo is too small to be a product photo (${p.width}x${p.height})`);
  }
  return problems;
}

async function realSearch(chromium) {
  const missing = [];
  if (!process.env.PRODUCT_SOURCE) missing.push('PRODUCT_SOURCE');
  if (missing.length) fail(`.env does not configure a product source (${missing.join(', ')}). The demo is a real search; set PRODUCT_SOURCE and its API key.`);
  if (!process.env.OPENAI_API_KEY && !process.env.AI_PROVIDER) {
    console.log('  note: no OPENAI_API_KEY — the page will read the request with its local interpreter, as the live site does without one');
  }

  api.mode = 'live';
  const browser = await chromium.launch({ executablePath: chromePath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(pagePrep, ORIGIN);
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  await page.fill('#ask', QUERY);
  await page.click('#ask-form button[type=submit]');

  const outcome = await Promise.race([
    page.waitForSelector('#results .grid .item-card', { timeout: 45000 }).then(() => 'cards'),
    page.waitForSelector('#results .empty', { timeout: 45000 }).then(() => 'empty')
  ]).catch(() => 'timeout');

  const search = api.exchanges.search;
  if (!search) fail('The page never reached /api/search.');
  if (search.status !== 200 || outcome !== 'cards') {
    const why = search.response && (search.response.error || search.response.notice || search.response.state);
    fail(`The real search did not return products (HTTP ${search.status}${why ? `: ${why}` : ''}). Check PRODUCT_SOURCE and its key in .env.`);
  }

  const found = await checkResults(page);
  await browser.close();
  const problems = verdict(found);
  if (problems.length) fail(`The real results are not fit to record:\n  - ${problems.join('\n  - ')}`);

  const products = (search.response && search.response.products) || [];
  const record = {
    query: QUERY,
    searchedAt: new Date().toISOString(),
    productSource: process.env.PRODUCT_SOURCE,
    interpreter: api.exchanges.interpret ? { status: api.exchanges.interpret.status, ms: api.exchanges.interpret.ms } : null,
    interpret: api.exchanges.interpret || null,
    search,
    shown: found.map(({ name, retailer, href, src, width, height }) => ({ name: name.trim(), retailer, href, photo: src, width, height }))
  };
  console.log(`  ${products.length} real products from ${new Set(found.map((f) => f.retailer)).size} retailer(s); every photo loaded`);
  return record;
}

/* ---------------------------------------------------------
   Pass 2: a person using the page
   --------------------------------------------------------- */

const NARRATION_LINES = (() => {
  const file = path.join(NARRATION, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')).lines;
})();

async function record(chromium, shot, rawDir, stillsDir) {
  const rand = generator(SEED + (shot.touch ? 7 : 0));
  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: shot.dpr > 1 ? [`--force-device-scale-factor=${shot.dpr}`] : []
  });
  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: shot.dpr,
    isMobile: shot.touch,
    hasTouch: shot.touch,
    reducedMotion: 'no-preference',
    ...(stillsDir ? {} : { recordVideo: { dir: rawDir, size: { width: shot.width * shot.dpr, height: shot.height * shot.dpr } } })
  });
  await context.addInitScript(pagePrep, ORIGIN);
  await context.addInitScript(overlay, shot.touch);

  /* The product photos are fetched once before the camera starts, into
     this browser's own cache — as they would be for anybody who had the
     page open a moment — so the grid appears with its photos rather than
     with a row of empty frames filling in. */
  const photos = api.saved.shown.map((s) => s.photo).filter(Boolean);
  const warm = await context.newPage();
  await warm.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  await warm.evaluate((urls) => Promise.all(urls.map((u) => new Promise((r) => {
    const img = new Image(); img.referrerPolicy = 'no-referrer';
    img.onload = img.onerror = r; img.src = u;
  }))), photos);
  await warm.close();

  const pageBorn = Date.now();
  const page = await context.newPage();
  const now = () => (Date.now() - pageBorn) / 1000;
  const marks = {};
  const cues = [];
  const voice = [];
  let stillN = 0;

  const still = async (label) => {
    if (!stillsDir) return;
    stillN += 1;
    await page.screenshot({ path: path.join(stillsDir, `${shot.name}-${String(stillN).padStart(2, '0')}-${label}.png`) });
  };
  /* a narrated line: the clip starts now, and its words stay in the strip
     for as long as it is spoken */
  const speak = async (key) => {
    const line = NARRATION_LINES && NARRATION_LINES[key];
    const text = line ? line.text : key;
    const start = now();
    voice.push({ key, start });
    cues.push({ text, start, end: start + (line ? line.duration + 0.35 : 2.5) });
    await page.evaluate((t) => window.demo.say(t), text);
    return line ? line.duration * 1000 : 2500;
  };
  const caption = async (text, ms) => {
    cues.push({ text, start: now(), end: now() + ms / 1000 });
    await page.evaluate((t) => window.demo.say(t), text);
  };
  const hush = () => page.evaluate(() => window.demo.hush());

  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#ask-form');
  await page.evaluate(() => document.fonts.ready);

  /* --- the hand ------------------------------------------------------ */

  const viewH = shot.height - (shot.touch ? 44 : 46);
  let at = { x: shot.width * 0.74, y: shot.height * 0.78 };

  const box = async (selector) => {
    const b = await page.locator(selector).first().boundingBox();
    if (!b) fail(`Could not find ${selector} on the page.`);
    return b;
  };
  /* somewhere natural inside a box: not its exact centre */
  const spotIn = (b, fx = 0.5, fy = 0.5) => ({
    x: b.x + b.width * (fx + rand.between(-0.08, 0.08)),
    y: b.y + b.height * (fy + rand.between(-0.12, 0.12))
  });

  /* A hand moves on a gentle curve, fast in the middle and slow at both
     ends, and a long move overshoots a little and settles back. */
  async function moveTo(target, ms) {
    const from = { ...at };
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return;
    const duration = ms || Math.min(1100, 380 + dist * 0.9) * rand.between(0.9, 1.12);
    const bend = rand.between(-0.18, 0.18) * dist;
    const nx = -dy / dist;
    const ny = dx / dist;
    const c1 = { x: from.x + dx * 0.3 + nx * bend, y: from.y + dy * 0.3 + ny * bend };
    const c2 = { x: from.x + dx * 0.75 + nx * bend * 0.4, y: from.y + dy * 0.75 + ny * bend * 0.4 };
    const over = dist > 220 ? rand.between(3, 7) : 0;
    const end = { x: target.x + (dx / dist) * over, y: target.y + (dy / dist) * over };
    /* paced by the clock, not by a step count: however long the browser
       takes to take each position, the move lasts as long as it should */
    const began = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - began) / duration);
      const e = t * t * t * (10 - 15 * t + 6 * t * t);
      const u = 1 - e;
      const x = u * u * u * from.x + 3 * u * u * e * c1.x + 3 * u * e * e * c2.x + e * e * e * end.x;
      const y = u * u * u * from.y + 3 * u * u * e * c1.y + 3 * u * e * e * c2.y + e * e * e * end.y;
      await page.mouse.move(x + (t < 1 ? rand.between(-0.4, 0.4) : 0), y + (t < 1 ? rand.between(-0.4, 0.4) : 0));
      if (t >= 1) break;
      await wait(12);
    }
    if (over) {
      await wait(rand.between(40, 90));
      for (let i = 1; i <= 6; i += 1) {
        await page.mouse.move(end.x + (target.x - end.x) * (i / 6), end.y + (target.y - end.y) * (i / 6));
        await wait(18);
      }
    }
    at = { ...target };
  }

  async function click() {
    await page.mouse.down();
    await wait(rand.between(70, 120));
    await page.mouse.up();
  }

  async function tap(point) {
    await page.evaluate(([x, y]) => window.demo.touchAt(x, y, true), [point.x, point.y]);
    await wait(rand.between(60, 100));
    await page.touchscreen.tap(point.x, point.y);
    await wait(rand.between(90, 140));
    await page.evaluate(([x, y]) => window.demo.touchAt(x, y, false), [point.x, point.y]);
  }

  /* Typing with a person's rhythm: no two keys the same distance apart,
     a beat at each space, a longer one now and then between words, and
     the shift for "$" taking its moment. */
  async function typeLikeAPerson(text) {
    const words = text.split(' ');
    for (let w = 0; w < words.length; w += 1) {
      for (const ch of words[w]) {
        let gap = rand.around(96, 30);
        if (ch === '$') gap += rand.between(90, 160);
        await page.keyboard.type(ch);
        await wait(Math.max(48, gap));
      }
      if (w < words.length - 1) {
        await page.keyboard.type(' ');
        await wait(rand.around(140, 38) + (rand.next() < 0.18 ? rand.between(110, 240) : 0));
      }
    }
  }

  /* A real scroll: the wheel on a desktop, through the browser's own
     scroll gesture; on a phone, a finger's swipe as real touch events,
     quick in the middle and easing off, the way a thumb moves. */
  const cdp = await context.newCDPSession(page);
  async function scrollBy(pixels, point) {
    const p = point || { x: shot.width * rand.between(0.45, 0.6), y: viewH * 0.68 };
    if (!shot.touch) {
      await cdp.send('Input.synthesizeScrollGesture', {
        x: Math.round(p.x), y: Math.round(p.y), yDistance: -Math.round(pixels),
        speed: 900, gestureSourceType: 'mouse', preventFling: true
      });
      return;
    }
    const steps = 22;
    const drift = rand.between(-10, 10);
    await page.evaluate(([x, y]) => window.demo.touchAt(x, y, true), [p.x, p.y]);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const e = 1 - Math.pow(1 - t, 2.2);
      const x = p.x + drift * e;
      const y = p.y - pixels * e;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await page.evaluate(([px, py]) => window.demo.touchAt(px, py, true), [x, y]);
      await wait(17);
    }
    await wait(50);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.evaluate(([x, y]) => window.demo.touchAt(x, y, false), [p.x + drift, p.y - pixels]);
    await wait(500);
  }

  /* --- 1. The homepage ----------------------------------------------- */

  if (!shot.touch) await page.mouse.move(at.x, at.y);
  await wait(450);
  marks.start = now();
  await wait(rand.between(1100, 1400));

  /* --- 2. Into the box, and the request ------------------------------- */

  const field = await box('#ask');
  const fieldSpot = { x: field.x + Math.min(160, field.width * 0.3) + rand.between(-20, 20), y: field.y + field.height / 2 };
  if (shot.touch) {
    await wait(rand.between(200, 400));
    await tap(fieldSpot);
  } else {
    await moveTo(fieldSpot);
    await wait(rand.between(120, 220));
    await click();
  }
  await page.focus('#ask');
  await wait(rand.between(350, 520));
  const looking = await speak('looking');
  const typedFrom = Date.now();
  await typeLikeAPerson(QUERY);
  await still('typed');
  /* let the line finish before the hand moves on */
  await wait(Math.max(rand.between(450, 700), looking - (Date.now() - typedFrom) + 250));
  await hush();

  /* --- 3. Search ------------------------------------------------------ */

  const go = await box('#ask-form button[type=submit]');
  const goSpot = spotIn(go);
  if (shot.touch) {
    await wait(rand.between(250, 400));
    await tap(goSpot);
  } else {
    await moveTo(goSpot);
    await wait(rand.between(140, 260));
    await click();
  }
  marks.searched = now();

  /* --- 4. The results ------------------------------------------------- */

  await page.waitForSelector('#results .grid .item-card', { timeout: 20000 });
  /* the page scrolls itself to the results; let that land */
  await wait(700);
  const shown = await checkResults(page);
  const problems = verdict(shown);
  if (problems.length) fail(`On camera, the results were not all real and loaded:\n  - ${problems.join('\n  - ')}`);
  marks.results = now();

  /* "from different retailers" is only said when the links really do
     go to more than one shop */
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\d?\./, ''); } catch (err) { return ''; } };
  const retailers = new Set(shown.map((s) => host(s.href)).filter(Boolean));
  const found = await speak(retailers.size > 1 ? 'found' : 'found-one');
  await still('results');
  /* the pointer rests while the products are looked at */
  await wait(found + rand.between(300, 500));
  await hush();

  /* a small scroll, to see a little more */
  await scrollBy(viewH * rand.between(0.28, 0.36));
  await wait(rand.between(900, 1200));
  await still('scrolled');

  /* --- 5. One product, out to its retailer ---------------------------- */

  /* the first card wholly on screen after the scroll, on the second
     column where there is one — where a hand would naturally go */
  const targetIndex = await page.evaluate((limit) => {
    const cards = [...document.querySelectorAll('#results .grid .item-card')];
    const whole = cards.map((c, i) => ({ i, r: c.getBoundingClientRect() }))
      .filter(({ r }) => r.top >= 60 && r.bottom <= limit);
    const pick = whole.find(({ i }) => i % 2 === 1) || whole[0];
    return pick ? pick.i : 1;
  }, viewH);
  const card = `#results .grid .item-card:nth-child(${targetIndex + 1})`;
  const media = await box(`${card} .item-media`);
  const cardSpot = spotIn(media, 0.5, 0.45);

  const open = await speak('open');
  const openedFrom = Date.now();
  if (shot.touch) {
    await wait(Math.max(900, open - 700));
  } else {
    await moveTo(cardSpot);
    await wait(Math.max(500, open - (Date.now() - openedFrom) - 400));
  }
  await still('chosen');

  const href = await page.locator(card).getAttribute('href');
  const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  marks.click = now();
  if (shot.touch) await tap(cardSpot);
  else await click();
  const popup = await popupPromise;
  await hush();

  /* The retailer's own page, in the new tab the link opens — the real
     page at the real address, for as long as it takes to show itself.
     A page that refuses a robot, or does not arrive within a few
     seconds, is not shown at all: a blank or a block page is not the
     retailer. */
  let retailer = null;
  if (popup) {
    const opened = Date.now();
    marks.popup = now();
    let ok = false;
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 6000 });
      const status = await popup.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0];
        return nav && nav.responseStatus ? nav.responseStatus : 200;
      }).catch(() => 0);
      const title = await popup.title().catch(() => '');
      const blocked = /access denied|forbidden|captcha|just a moment|attention required|are you a robot|blocked/i.test(title);
      const text = await popup.evaluate(() => (document.body && document.body.innerText || '').length).catch(() => 0);
      ok = status < 400 && !blocked && text > 200 && /^https?:/.test(popup.url());
      if (ok) await wait(Math.max(0, 2800 - (Date.now() - opened)));
    } catch (err) { ok = false; }
    marks.popupEnd = now();
    retailer = { ok, url: popup.url(), video: stillsDir ? null : popup.video() };
    if (stillsDir && ok) await popup.screenshot({ path: path.join(stillsDir, `${shot.name}-retailer.png`) }).catch(() => {});
    await popup.close();
    await page.bringToFront();
    if (!ok) console.log(`  ${shot.name}: the retailer page (${href}) did not show itself in time; the video stays on Fynd`);
  } else {
    console.log(`  ${shot.name}: the link opened no new tab; the video stays on Fynd`);
  }
  marks.back = now();

  /* --- 6. Back on Fynd ------------------------------------------------ */

  await wait(350);
  await caption(CAPTION_END, 2400);
  await still('end');
  await wait(2400);
  await hush();
  await wait(300);
  marks.end = now();

  const mainVideo = stillsDir ? null : page.video();
  await context.close();
  await browser.close();

  if (process.env.DEMO_DEBUG) console.log('  marks', JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, t]) => [k, Number(t.toFixed(2))]))));
  if (stillsDir) return { marks };
  return {
    marks, cues, voice,
    main: await mainVideo.path(),
    retailer: retailer && retailer.ok ? { ...retailer, file: await retailer.video.path() } : null
  };
}

/* ---------------------------------------------------------
   Putting it together: the cut, the narration, the encode
   --------------------------------------------------------- */

const run = (args) => execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

function lengthOf(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString();
  return Number(out.trim());
}

function build(shot, take, outDir) {
  const W = shot.width * shot.dpr;
  const H = shot.height * shot.dpr;
  const m = take.marks;

  /* The recorder runs a little behind the wall clock, so the wall-clock
     marks are scaled to the video's own length before they cut it. */
  const mainLen = lengthOf(take.main);
  const k = mainLen / m.end;
  const v = (t) => t * k;

  /* the cut: Fynd up to the click, the retailer's tab while it is open,
     then Fynd again */
  const segments = [];
  if (take.retailer) {
    const popLen = lengthOf(take.retailer.file);
    const popWall = m.popupEnd - m.popup;
    const kp = popWall > 0 ? popLen / popWall : 1;
    segments.push({ input: 0, from: v(m.start), to: v(m.click + 0.25) });
    segments.push({ input: 1, from: 0, to: Math.min(popLen, popWall * kp) });
    segments.push({ input: 0, from: v(m.back), to: v(m.end) });
  } else {
    segments.push({ input: 0, from: v(m.start), to: v(m.end) });
  }
  const lens = segments.map((s) => s.to - s.from);
  const total = lens.reduce((a, b) => a + b, 0);

  /* where a wall-clock moment lands in the finished video */
  const at = (t) => {
    if (!take.retailer) return v(t) - v(m.start);
    if (t <= m.click + 0.25) return v(t) - v(m.start);
    if (t < m.back) return lens[0] + Math.min(lens[1], (t - m.popup) * (lens[1] / Math.max(0.01, m.popupEnd - m.popup)));
    return lens[0] + lens[1] + (v(t) - v(m.back));
  };

  const inputs = ['-i', take.main];
  if (take.retailer) inputs.push('-i', take.retailer.file);
  const voiceInputs = take.voice.map((line) => path.join(NARRATION, NARRATION_LINES[line.key].file));
  voiceInputs.forEach((f) => inputs.push('-i', f));
  const firstVoice = take.retailer ? 2 : 1;

  const vf = segments.map((s, i) => `[${s.input}:v]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=PTS-STARTPTS,`
    + `fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:white,setsar=1[s${i}]`).join(';');
  const concat = `${segments.map((_, i) => `[s${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[v]`;
  const af = take.voice.map((line, i) => `[${firstVoice + i}:a]adelay=${Math.round(at(line.start) * 1000)}:all=1[a${i}]`).join(';');
  const mix = take.voice.length
    ? `;${af};${take.voice.map((_, i) => `[a${i}]`).join('')}amix=inputs=${take.voice.length}:normalize=0,apad,atrim=end=${total.toFixed(3)}[a]`
    : `;anullsrc=r=48000:cl=mono,atrim=end=${total.toFixed(3)}[a]`;

  const master = path.join(os.tmpdir(), `${shot.name}-master.mkv`);
  run([...inputs, '-filter_complex', `${vf};${concat}${mix}`, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', master]);

  const mp4 = path.join(outDir, `${shot.name}.mp4`);
  const webm = path.join(outDir, `${shot.name}.webm`);
  const poster = path.join(outDir, `${shot.name}-poster.jpg`);
  console.log(`  encoding ${shot.name}.mp4…`);
  run(['-i', master, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow', '-crf', String(shot.h264),
    '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-ac', '1', '-movflags', '+faststart', mp4]);
  console.log(`  encoding ${shot.name}.webm…`);
  run(['-i', master, '-c:v', 'libvpx-vp9', '-crf', String(shot.vp9), '-b:v', '0', '-row-mt', '1',
    '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', webm]);
  /* the poster: the real results, a moment after they arrive */
  run(['-ss', (at(m.results) + 1.2).toFixed(3), '-i', master, '-frames:v', '1', '-q:v', '3', poster]);
  fs.unlinkSync(master);

  writeTrack(path.join(outDir, `${shot.name}.vtt`), take.cues.map((c) => ({ ...c, start: at(c.start), end: Math.min(total, at(c.end)) })), total);
  const size = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`  ${shot.name}: ${total.toFixed(1)}s — mp4 ${size(mp4)}, webm ${size(webm)}, poster ${size(poster)}`);
  return total;
}

/* The captions track: the narration, word for word, and the closing
   line, timed to the finished video. Placed at the top of the frame when
   turned on, so they never stack on the strip drawn into it. */
function writeTrack(file, cues, length) {
  const clock = (s) => {
    const t = Math.max(0, Math.min(length, s));
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0').slice(0, 3);
    return `00:${mm}:${ss}.${ms}`;
  };
  const body = cues.map(({ text, start, end }, i) => `${i + 1}\n${clock(start)} --> ${clock(end)} line:8%\n${text}`).join('\n\n');
  fs.writeFileSync(file, `WEBVTT\n\n${body}\n`);
}

/* The note under the video says what it is: a real search, and when it
   was made, because prices and stock move on after a recording. Only the
   text between the markers in index.html is replaced. */
function describeOnPage(saved) {
  const file = path.join(REPO, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const when = new Date(saved.searchedAt);
  const date = Number.isNaN(when.getTime()) ? 'recently'
    : when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const note = `<!-- demo-note -->
          <span class="status status--live">Real search</span>
          Recorded on Fynd on ${date}. Prices and availability may have changed since. Turn the sound on for the narration.
          <!-- /demo-note -->`;
  const next = html.replace(/<!-- demo-note -->[\s\S]*?<!-- \/demo-note -->/, note);
  if (next === html && !html.includes(note)) {
    console.log('  note: the demo-note markers were not found in index.html; update the note under the video by hand');
    return;
  }
  fs.writeFileSync(file, next);
  console.log('  updated the note under the video in index.html');
}

/* ---------------------------------------------------------
   The run
   --------------------------------------------------------- */

(async () => {
  const hadEnv = loadEnv();
  /* in-memory metering only: never production KV */
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
    .forEach((k) => { delete process.env[k]; });

  if (!NARRATION_LINES) fail('assets/demo/narration/manifest.json is missing. Run scripts/demo-narration.py.');
  if (!STILLS) {
    try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch (err) { fail('ffmpeg was not found. Install it, or set FFMPEG_PATH.'); }
  }
  const chromium = loadPlaywright();
  fs.mkdirSync(OUT, { recursive: true });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  try {
    /* pass 1 */
    if (REPLAY) {
      const file = typeof REPLAY === 'string' ? path.resolve(REPLAY) : SEARCH_FILE;
      if (!fs.existsSync(file)) fail(`No saved search at ${path.relative(REPO, file)}. Run without --replay first.`);
      api.saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log(`Replaying the real search of ${api.saved.searchedAt} (${api.saved.shown.length} products)`);
    } else {
      console.log(`Searching for real${hadEnv ? ' with .env' : ''}: "${QUERY}"`);
      api.saved = await realSearch(chromium);
    }
    api.mode = 'replay';

    /* pass 2, into a scratch folder: nothing reaches the output folder
       unless every shape made it through */
    const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-demo-raw-'));
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-demo-out-'));
    const stillsDir = STILLS ? fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-demo-stills-')) : null;
    const takes = [];
    for (const shot of SHOTS) {
      console.log(`Recording ${shot.kind}…`);
      takes.push([shot, await record(chromium, shot, rawDir, stillsDir)]);
    }
    server.close();

    if (STILLS) {
      console.log(`Stills in ${stillsDir}`);
      return;
    }

    const lengths = {};
    for (const [shot, take] of takes) lengths[shot.name] = build(shot, take, stage);

    for (const f of fs.readdirSync(stage)) fs.copyFileSync(path.join(stage, f), path.join(OUT, f));
    if (!REPLAY) fs.writeFileSync(SEARCH_FILE, `${JSON.stringify(api.saved, null, 2)}\n`);
    if (OUT === path.join(REPO, 'assets', 'demo')) describeOnPage(api.saved);
    console.log(`\nWrote to ${path.relative(REPO, OUT) || '.'}:`);
    for (const [name, len] of Object.entries(lengths)) console.log(`  ${name}.mp4 / .webm  ${len.toFixed(1)}s`);
    console.log('Watch both, with sound and without, before committing.');
  } catch (err) {
    server.close();
    console.error(err);
    fail('The recording stopped with an error.');
  }
})();
