#!/usr/bin/env node
/* =========================================================
   Fynd — records the landing page demo video

   A screen recording of a person using Fynd for four genuinely different
   shopping problems, one after another, in about fifty-five seconds:

     an everyday request      "black oversized hoodie under $80"
       "I'm looking for a black oversized hoodie, under eighty dollars."
       real products come back: photos, brands, names, prices, retailers
       "Fynd finds matching products from different retailers."
       one is clicked: "And I can open the product directly at the retailer."
       the retailer's own page opens in a new tab, as it does for anyone
     a different category    "lightweight jacket for fall under $150"
       "Something completely different works the same way."
     something hard to find   "BAPE shark hoodie under $400"
       "Even something specific that's hard to find."
     a particular style       "sage green linen midi dress under $120"
       "Or the exact style and color I have in mind."
     each one: the results, and one product opened at its own retailer —
       a different retailer each time wherever the results allow
     back on Fynd: "No more searching store after store. Describe it, and
       Fynd finds it."

   The later searches each have fall-backs (SEARCHES, below). A request is
   only used if its real answer passes every check — enough different
   products, every one a real listing with a photograph that loaded, the
   brand it names actually in the results, and at least one retailer page
   that really opens. If not, the next request for that slot is tried; if
   none passes, nothing is written. Credibility comes before any one brand.

   Nothing on screen is made for the camera. The page is the site as
   visitors get it, the searches are the real Fynd search — the real
   /api/interpret and /api/search handlers from this repository, run with
   your own .env — and the products are the real listings it returns, with
   their real photographs, prices and retailer links. If any product comes
   back without a real photograph, or a photograph does not load, the
   request is not used: the script never falls back to drawings or
   placeholders.

   It runs in two passes:

     1. The searches. Each request is typed into the page, off camera, and
        the real search answers it. Every photo is checked loaded, and
        each product's retailer page is opened to see that it shows
        itself. What each search answered — every product, exactly as the
        page received it, and which retailer pages opened — is saved to
        assets/demo/demo-search.json.
     2. The recordings. Desktop, then the phone layout, each driven like a
        person would drive it. Both ask the same real answers back from
        the saved searches, so the two show the same products, and a
        re-recording shows the same products as the last one.

   The edit: the video cuts to the retailer's tab while it is open, and
   cuts from it straight to the search box for the next request, so the
   scroll back up the page is not watched four times.

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

   The narration is committed clips in assets/demo/narration/, made by
   scripts/demo-narration.py. Nothing here needs a speech model.

   Writes, into assets/demo/:
     fynd-demo.mp4 / .webm                desktop, 1280 x 800, with narration
     fynd-demo-mobile.mp4 / .webm         phone layout, 800 x 1440 (400 x 720 @2x)
     fynd-demo-poster.jpg, fynd-demo-mobile-poster.jpg
     fynd-demo.vtt, fynd-demo-mobile.vtt  captions, timed to the narration
     demo-search.json                     the real searches both were made from

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

/* The searches, in the order they are made: four different shopping
   problems — an everyday piece, another category altogether, a specific
   thing that is a chore to track down across shops, and a particular
   style and colour. `line` is the narration said while it is typed.

   Each slot lists the request it would rather make first, then its
   fall-backs. `mention` is a brand the request names: a request for a
   brand is only used when at least MIN_PRODUCTS of its results are that
   brand, and only one of those is clicked — a search for BAPE that
   comes back with other people's shark hoodies is not shown. The first
   slot has no fall-back because its narration names its request. */
const SEARCHES = [
  { slot: 'everyday', line: 'looking', candidates: [
    { query: 'black oversized hoodie under $80' }
  ] },
  { slot: 'category', line: 'different', candidates: [
    { query: 'lightweight jacket for fall under $150' },
    { query: 'light fall jacket under $150' }
  ] },
  { slot: 'hard-to-find', line: 'specific', candidates: [
    { query: 'BAPE shark hoodie under $400', mention: 'bape|bathing ape' },
    { query: "Levi's 501 '90s jeans in light wash under $100", mention: 'levi' },
    { query: 'Ralph Lauren cable knit sweater in cream under $200', mention: 'ralph lauren|polo' }
  ] },
  { slot: 'particular', line: 'particular', candidates: [
    { query: 'sage green linen midi dress under $120' },
    { query: 'black satin slip dress under $100' },
    { query: 'vintage Burberry trench coat under $500', mention: 'burberry' }
  ] }
];
const SEED = 20261002;

/* the fewest products worth showing, and the longest the page's own
   "Searching…" state is allowed to run on camera: the real search can
   take several seconds, and a recording of a spinner is not the point */
const MIN_PRODUCTS = 4;
const MAX_LOADING_MS = 1100;
const MIN_LOADING_MS = 700;

/* how many of a search's products have their retailer page opened in
   the first pass, and how long the retailer's tab stays on camera */
const PROBE_PRODUCTS = 8;
const RETAILER_MS = 2100;

/* the finished length being aimed for, in seconds */
const TARGET = { min: 50, max: 60 };

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
/* ffprobe reads durations; ffmpeg only encodes. ffprobe ships beside
   ffmpeg, so unless FFPROBE_PATH names it outright, it is looked for in
   the same folder under the same naming: C:\ffmpeg\bin\ffmpeg.exe gives
   C:\ffmpeg\bin\ffprobe.exe, /usr/bin/ffmpeg gives /usr/bin/ffprobe, and
   a bare "ffmpeg" on the PATH gives a bare "ffprobe". Windows paths are
   read as Windows paths whatever machine this runs on. */
function ffprobeFor(ffmpegPath, env = process.env, platform = process.platform) {
  if (env.FFPROBE_PATH) return env.FFPROBE_PATH;
  const windows = platform === 'win32' || /^[a-z]:[\\/]|\\/i.test(ffmpegPath);
  const p = windows ? path.win32 : path.posix;
  const dir = p.dirname(ffmpegPath);
  const base = p.basename(ffmpegPath);
  const ext = /\.exe$/i.test(base) ? base.slice(-4) : (windows ? '.exe' : '');
  const name = /ffmpeg/i.test(base)
    ? base.replace(/\.exe$/i, '').replace(/ffmpeg/i, (m) => (m === 'FFMPEG' ? 'FFPROBE' : 'ffprobe')) + ext
    : `ffprobe${ext}`;
  return dir === '.' && !/[\\/]/.test(ffmpegPath) ? name : p.join(dir, name);
}

/* resolved again once .env is read, so FFMPEG_PATH / FFPROBE_PATH set
   there count as much as ones set in the shell */
let FFMPEG = findFfmpeg();
let FFPROBE = ffprobeFor(FFMPEG);

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
   they answered; 'replay' gives that same answer back — the answer of
   saved search number `current`, which the recording sets before it
   submits each request */
const api = { mode: 'live', exchanges: {}, saved: null, current: 0 };

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
  const one = api.saved && api.saved.searches && api.saved.searches[api.current];
  const saved = one && one[route];
  if (!saved) { res.statusCode = 503; return res.end('{}'); }
  const delay = route === 'search'
    ? Math.min(MAX_LOADING_MS, Math.max(MIN_LOADING_MS, saved.ms))
    : Math.min(300, Math.max(150, saved.ms));
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
     typed first in the video; left on, the request would be on screen
     before anybody asked for it.
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
   Pass 1: the real searches
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
    const text = (c, sel) => ((c.querySelector(sel) || {}).textContent || '').trim();
    return cards().map((c, i) => {
      const img = c.querySelector('.item-media img');
      return {
        i,
        name: text(c, '.item-name'),
        brand: text(c, '.item-retailer'),
        price: text(c, '.item-price'),
        href: c.getAttribute('href') || '',
        retailer: text(c, '.item-seller') || text(c, '.item-retailer'),
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
  /* several products, not one product several times */
  const distinct = new Set(found.map((p) => `${p.name.trim().toLowerCase()}|${p.src}`)).size;
  const photos = new Set(found.map((p) => p.src).filter(Boolean)).size;
  if (found.length >= MIN_PRODUCTS && Math.min(distinct, photos) < MIN_PRODUCTS) {
    problems.push(`only ${Math.min(distinct, photos)} different product(s) among ${found.length}; the rest repeat`);
  }
  return problems;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\d?\./, ''); } catch (err) { return ''; } };
const mentionOf = (candidate) => (candidate && candidate.mention ? new RegExp(`\\b(?:${candidate.mention})`, 'i') : null);
const mentions = (re, p) => !re || re.test(`${p.brand || ''} ${p.name || ''}`);
/* "under $150" → 150; a request without a budget has none */
const budgetOf = (query) => { const m = /\bunder \$\s?([\d,]+)/i.exec(query || ''); return m ? Number(m[1].replace(/,/g, '')) : null; };
const priceOf = (text) => { const m = /\$\s?([\d,]+(?:\.\d+)?)/.exec(text || ''); return m ? Number(m[1].replace(/,/g, '')) : null; };

/* Whether an open tab is the retailer's page, and not a block page, an
   error or a blank: the same test on the first pass and on camera. */
async function retailerShows(tab, status) {
  const code = status || await tab.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav && nav.responseStatus ? nav.responseStatus : 200;
  }).catch(() => 0);
  const title = await tab.title().catch(() => '');
  const blocked = /access denied|forbidden|captcha|just a moment|attention required|are you a robot|blocked/i.test(title);
  const text = await tab.evaluate(() => (document.body && document.body.innerText || '').length).catch(() => 0);
  const ok = code > 0 && code < 400 && !blocked && text > 200 && /^https?:/.test(tab.url());
  const why = ok ? '' : blocked ? `blocked ("${title.slice(0, 40)}")` : code >= 400 ? `HTTP ${code}` : text <= 200 ? 'blank page' : 'no page';
  return { ok, why };
}

/* Opens each product's retailer page, as a click on camera would, and
   notes which ones show themselves. Only those are ever clicked. */
async function probeRetailers(context, found) {
  const out = {};
  const queue = found.slice(0, PROBE_PRODUCTS);
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const tab = await context.newPage();
      let result = { ok: false, why: 'did not load' };
      try {
        const response = await tab.goto(p.href, { waitUntil: 'domcontentloaded', timeout: 9000 });
        await wait(800);
        result = await retailerShows(tab, response ? response.status() : 0);
      } catch (err) { /* did not arrive in time */ }
      out[p.href] = result;
      await tab.close().catch(() => {});
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

/* Is this candidate's real answer fit to be one of the demo's searches?
   The plain checks every recording makes, and on top: the brand it names
   is really in the results, and at least one product that may be clicked
   has a retailer page that opens. */
function fitness(found, candidate) {
  const base = verdict(found);
  const problems = [...base];
  const re = mentionOf(candidate);
  if (re) {
    const named = found.filter((p) => mentions(re, p)).length;
    if (named < MIN_PRODUCTS) problems.push(`only ${named} of ${found.length} results are actually ${candidate.mention.split('|')[0].toUpperCase()}; need at least ${MIN_PRODUCTS}`);
  }
  if (!base.length && !found.some((p) => p.retailerOk && mentions(re, p))) {
    problems.push('no product it may click has a retailer page that opens (blocked, blank, or too slow)');
  }
  return problems;
}

/* Which product to open, among the cards on screen: one whose retailer
   page was seen to open, of the brand asked for, ideally at a retailer
   not already shown in this video, within the budget asked for, and
   already in view. Returns the card's index, or -1 if none may be. */
function pickProduct(cards, { used = new Set(), mention = null, budget = null, visible = null } = {}) {
  let best = -1;
  let bestScore = -1;
  cards.forEach((c, i) => {
    if (!c.retailerOk || !mentions(mention, c)) return;
    const price = priceOf(c.price);
    const score = (used.has(hostOf(c.href)) ? 0 : 8)
      + (budget && price !== null && price <= budget ? 4 : 0)
      + (visible && visible.has(i) ? 2 : 0)
      + (i % 2 === 1 ? 1 : 0); /* off the first column, where a hand goes */
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

function checkSetup() {
  const missing = [];
  if (!process.env.PRODUCT_SOURCE) missing.push('PRODUCT_SOURCE');
  if (missing.length) fail(`.env does not configure a product source (${missing.join(', ')}). The demo is a real search; set PRODUCT_SOURCE and its API key.`);
  if (!process.env.OPENAI_API_KEY && !process.env.AI_PROVIDER) {
    console.log('  note: no OPENAI_API_KEY — the page will read the request with its local interpreter, as the live site does without one');
  }
  /* every request starts with an untouched allowance. Only ever the
     in-memory store: the KV settings were dropped from this process */
  const store = require(path.join(REPO, 'api', '_store.js'));
  if (store.driver() !== 'memory') fail('The usage store is not the in-memory one; refusing to search against production state.');
  return store;
}

/* One request, made the way a visitor makes it, and everything about its
   answer that decides whether it can be shown. */
async function searchOnce(browser, store, candidate) {
  store.reset();
  api.mode = 'live';
  api.exchanges = {};
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(pagePrep, ORIGIN);
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
    await page.fill('#ask', candidate.query);
    await page.click('#ask-form button[type=submit]');

    const outcome = await Promise.race([
      page.waitForSelector('#results .grid .item-card', { timeout: 45000 }).then(() => 'cards'),
      page.waitForSelector('#results .empty', { timeout: 45000 }).then(() => 'empty')
    ]).catch(() => 'timeout');

    const search = api.exchanges.search;
    if (!search) return { problems: ['the page never reached /api/search'] };
    if (search.status !== 200 || outcome !== 'cards') {
      const why = search.response && (search.response.error || search.response.notice || search.response.state);
      return { problems: [`the real search did not return products (HTTP ${search.status}${why ? `: ${why}` : ''})`] };
    }

    const found = await checkResults(page);
    const opened = verdict(found).length ? {} : await probeRetailers(context, found);
    found.forEach((p) => { p.retailerOk = Boolean(opened[p.href] && opened[p.href].ok); p.retailerWhy = opened[p.href] ? opened[p.href].why : 'not opened'; });
    return { found, search, interpret: api.exchanges.interpret || null, problems: fitness(found, candidate) };
  } finally {
    await context.close();
  }
}

async function realSearches(chromium) {
  const store = checkSetup();
  const browser = await chromium.launch({ executablePath: chromePath() });
  const searches = [];
  try {
    for (const slot of SEARCHES) {
      const passedOver = [];
      let chosen = null;
      for (const candidate of slot.candidates) {
        console.log(`  "${candidate.query}"`);
        const result = await searchOnce(browser, store, candidate);
        if (!result.problems.length) { chosen = { candidate, ...result }; break; }
        console.log(`    not used:\n      - ${result.problems.join('\n      - ')}`);
        passedOver.push({ query: candidate.query, problems: result.problems });
      }
      if (!chosen) {
        fail(`No request for the "${slot.slot}" search came back fit to record. Tried:\n${passedOver.map((p) => `  "${p.query}"\n    - ${p.problems.join('\n    - ')}`).join('\n')}\nAdd another request to that slot in SEARCHES, or try again later.`);
      }
      const { candidate, found, search, interpret } = chosen;
      const hosts = new Set(found.map((f) => hostOf(f.href)).filter(Boolean));
      console.log(`    used: ${found.length} real products from ${hosts.size} retailer(s); every photo loaded; ${found.filter((f) => f.retailerOk).length} retailer page(s) opened`);
      searches.push({
        slot: slot.slot,
        line: slot.line,
        query: candidate.query,
        mention: candidate.mention || null,
        passedOver,
        interpret: interpret ? { ...interpret } : null,
        search,
        shown: found.map(({ name, brand, price, retailer, href, src, width, height, retailerOk, retailerWhy }) => ({
          name, brand, price, retailer, href, photo: src, width, height, retailerOk, ...(retailerOk ? {} : { retailerWhy })
        }))
      });
    }
  } finally {
    await browser.close();
  }
  return {
    version: 2,
    searchedAt: new Date().toISOString(),
    productSource: process.env.PRODUCT_SOURCE,
    searches
  };
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
     page open a moment — so each grid appears with its photos rather than
     with a row of empty frames filling in. */
  const photos = api.saved.searches.flatMap((s) => s.shown.map((p) => p.photo)).filter(Boolean);
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
  /* the edit, in wall-clock seconds: stretches of this tab, and the
     retailer tabs in between */
  const cut = [];
  const tabs = [];
  let stillN = 0;

  const still = async (label, target = page) => {
    if (!stillsDir) return;
    stillN += 1;
    await target.screenshot({ path: path.join(stillsDir, `${shot.name}-${String(stillN).padStart(2, '0')}-${label}.png`) }).catch(() => {});
  };
  /* a narrated line: the clip starts now, and its words stay in the strip
     for as long as it is spoken */
  const speak = async (key) => {
    const line = NARRATION_LINES[key];
    const start = now();
    voice.push({ key, start });
    cues.push({ text: line.text, start, end: start + line.duration + 0.35 });
    await page.evaluate((t) => window.demo.say(t), line.text);
    return line.duration * 1000;
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
     the shift for "$" taking its moment. `pace` is how familiar the box
     has become: a little quicker by the second request, never a blur. */
  async function typeLikeAPerson(text, pace = 1) {
    const words = text.split(' ');
    for (let w = 0; w < words.length; w += 1) {
      for (const ch of words[w]) {
        let gap = rand.around(96, 30) * pace;
        if (ch === '$') gap += rand.between(90, 160);
        await page.keyboard.type(ch);
        await wait(Math.max(48, gap));
      }
      if (w < words.length - 1) {
        await page.keyboard.type(' ');
        await wait(rand.around(140, 38) * pace + (rand.next() < 0.18 ? rand.between(110, 240) : 0));
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

  async function press(point) {
    if (shot.touch) await tap(point);
    else { await moveTo(point); await wait(rand.between(110, 200)); await click(); }
  }

  /* --- the homepage -------------------------------------------------- */

  if (!shot.touch) await page.mouse.move(at.x, at.y);
  await wait(450);
  marks.start = now();
  let segFrom = marks.start;
  await wait(rand.between(400, 550));

  const used = new Set();
  const searches = api.saved.searches;

  for (let n = 0; n < searches.length; n += 1) {
    const s = searches[n];
    const first = n === 0;
    const tag = `${n + 1}-${s.slot}`;

    /* --- into the box, and the request ------------------------------- */

    const field = await box('#ask');
    const fieldSpot = { x: field.x + Math.min(160, field.width * 0.3) + rand.between(-20, 20), y: field.y + field.height / 2 };
    /* the first line waits for the box to be clicked; later ones start as
       the hand sets off for it, so the words cover the move */
    let said = first ? 0 : await speak(s.line);
    const saidFrom = Date.now();
    await press(fieldSpot);
    await page.focus('#ask');
    if (first) {
      await wait(rand.between(300, 450));
      said = await speak(s.line);
    } else {
      /* the last request is still in the box: select it all, and the
         first key typed replaces it */
      await wait(rand.between(90, 150));
      await page.keyboard.press('ControlOrMeta+A');
      await wait(rand.between(110, 170));
    }
    const typedFrom = first ? Date.now() : saidFrom;
    await typeLikeAPerson(s.query, first ? 1 : 0.82);
    await still(`${tag}-typed`);
    /* let the line finish before the hand moves on */
    await wait(Math.max(rand.between(first ? 250 : 200, first ? 400 : 320), said - (Date.now() - typedFrom) + 200));
    await hush();

    /* --- search -------------------------------------------------------- */

    api.current = n;
    if (first) {
      await press(spotIn(await box('#ask-form button[type=submit]')));
    } else {
      /* by now the person knows Enter searches */
      await page.keyboard.press('Enter');
    }
    marks[`searched${n}`] = now();
    /* while it searches, the hand drifts down towards where the results
       will be, as a hand does */
    if (!shot.touch) await moveTo({ x: shot.width * rand.between(0.42, 0.58), y: viewH * rand.between(0.55, 0.68) });

    /* --- the results --------------------------------------------------- */

    await page.waitForFunction(() => !document.querySelector('#results .thinking')
      && document.querySelector('#results .grid .item-card'), null, { timeout: 20000 });
    /* the page scrolls itself to the results; let that land */
    await wait(first ? 500 : 400);
    const onScreen = await checkResults(page);
    const problems = verdict(onScreen);
    if (problems.length) fail(`On camera, the results for "${s.query}" were not all real and loaded:\n  - ${problems.join('\n  - ')}`);
    marks[`results${n}`] = now();

    if (first) {
      /* "from different retailers" is only said when the links really do
         go to more than one shop */
      const retailers = new Set(onScreen.map((p) => hostOf(p.href)).filter(Boolean));
      const found = await speak(retailers.size > 1 ? 'found' : 'found-one');
      await still(`${tag}-results`);
      /* the pointer rests while the products are looked at */
      await wait(found + rand.between(80, 160));
      await hush();
    } else {
      await still(`${tag}-results`);
      await wait(rand.between(300, 450));
    }

    /* --- one product, out to its retailer ------------------------------ */

    /* only a product whose retailer page was seen to open in the first
       pass, of the brand asked for; at a shop not yet shown if there is
       one, within the budget, and already on screen if possible */
    const verified = new Map(s.shown.map((p) => [p.href, p.retailerOk === true]));
    const cards = onScreen.map((p) => ({ ...p, retailerOk: verified.get(p.href) === true }));
    /* on screen: its photo, which is what is pressed, wholly in view
       above the caption strip */
    const inView = async () => new Set(await page.evaluate((limit) => [...document.querySelectorAll('#results .grid .item-card')]
      .map((c, i) => ({ i, r: (c.querySelector('.item-media') || c).getBoundingClientRect() }))
      .filter(({ r }) => r.top >= 60 && r.bottom <= limit - 12).map(({ i }) => i), viewH));
    const pick = pickProduct(cards, { used, mention: mentionOf(s), budget: budgetOf(s.query), visible: await inView() });
    if (pick < 0) fail(`No product in "${s.query}" has a retailer page that was seen to open. Search again without --replay.`);

    const card = `#results .grid .item-card:nth-child(${pick + 1})`;
    if (!(await inView()).has(pick)) {
      const r = await page.locator(`${card} .item-media`).boundingBox();
      await scrollBy(Math.max(80, r.y + r.height - viewH + 60));
      await wait(rand.between(250, 400));
    }
    const media = await box(`${card} .item-media`);
    const cardSpot = spotIn(media, 0.5, 0.45);

    if (first) {
      /* the click lands on "open", and the rest of the line is said over
         the retailer's page */
      await speak('open');
      if (shot.touch) await wait(rand.between(800, 950));
      else {
        await moveTo(cardSpot);
        await wait(rand.between(180, 280));
      }
    } else if (shot.touch) {
      /* no pointer to watch travel on a phone: the look before the tap
         is the beat that shows the choice */
      await wait(rand.between(650, 850));
    } else {
      await moveTo(cardSpot);
      await wait(rand.between(150, 260));
    }
    await still(`${tag}-chosen`);

    const href = cards[pick].href;
    const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
    const clickedAt = now();
    if (shot.touch) await tap(cardSpot);
    else await click();
    const popup = await popupPromise;
    await hush();
    cut.push({ src: 'main', from: segFrom, to: clickedAt + 0.25 });

    /* The retailer's own page, in the new tab the link opens — the real
       page at the real address, held for a moment once it has arrived.
       A page that refuses a robot, or does not arrive within a few
       seconds, is not shown at all: a blank or a block page is not the
       retailer. The wait for it to arrive is not shown either. */
    if (popup) {
      const born = now();
      let ok = false;
      let shownAt = born;
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 6000 });
        shownAt = now();
        await wait(250);
        ok = (await retailerShows(popup)).ok;
        if (ok) await wait(Math.max(0, RETAILER_MS - (now() - shownAt) * 1000));
      } catch (err) { ok = false; }
      const gone = now();
      if (stillsDir && ok) await still(`${tag}-retailer`, popup);
      const video = stillsDir ? null : popup.video();
      await popup.close();
      if (ok) {
        used.add(hostOf(popup.url()) || hostOf(href));
        cut.push({ src: 'tab', tab: tabs.length, born, from: Math.max(born, shownAt - 0.15), to: gone });
        tabs.push(video);
      } else {
        console.log(`  ${shot.name}: the retailer page (${href}) did not show itself in time; the video stays on Fynd`);
      }
    } else {
      console.log(`  ${shot.name}: the link opened no new tab; the video stays on Fynd`);
    }
    await page.bringToFront();

    /* --- back to the top of Fynd, off camera --------------------------- */

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await wait(350);
    segFrom = now();
    if (n < searches.length - 1) await wait(rand.between(100, 160));
  }

  /* --- the close ------------------------------------------------------ */

  const close = await speak('close');
  await still('end');
  await wait(close + 300);
  await hush();
  await wait(150);
  marks.end = now();
  cut.push({ src: 'main', from: segFrom, to: marks.end });

  const mainVideo = stillsDir ? null : page.video();
  await context.close();
  await browser.close();

  if (process.env.DEMO_DEBUG) {
    console.log('  marks', JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, t]) => [k, Number(t.toFixed(2))]))));
    console.log('  cut', cut.map((c) => `${c.src} ${(c.to - c.from).toFixed(2)}s`).join(', '));
  }
  if (stillsDir) return { marks };
  return {
    marks, cues, voice, cut,
    main: await mainVideo.path(),
    tabs: await Promise.all(tabs.map((v) => v.path()))
  };
}

/* ---------------------------------------------------------
   Putting it together: the cut, the narration, the encode
   --------------------------------------------------------- */

const run = (args) => execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

/* The one command that reads a duration. It goes to ffprobe and nowhere
   else: -show_entries is an ffprobe option, and ffmpeg given it fails
   with "Unrecognized option 'show_entries'". */
function durationCommand(file, probe = FFPROBE) {
  if (/^ffmpeg(\.exe)?$/i.test(path.win32.basename(probe))) {
    throw new Error(`Durations are read with ffprobe, not ffmpeg (was asked to run ${probe}). Set FFPROBE_PATH to ffprobe.`);
  }
  return [probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]];
}

function lengthOf(file) {
  const [bin, args] = durationCommand(file);
  const out = execFileSync(bin, args).toString();
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe could not read a duration from ${file}`);
  return seconds;
}

/* The edit, worked out from the wall clock. `cut` is what the recording
   noted: stretches of the Fynd tab ({src: 'main', from, to}) and the
   retailer tabs between them ({src: 'tab', tab, born, from, to}), in
   seconds since the Fynd tab opened. `k` scales the Fynd tab's wall
   clock to its video, which the recorder runs a little behind; each
   retailer tab's video is scaled to its own length the same way.
   Returns each piece's place in its input video, the finished length,
   and `at`, which says where a wall-clock moment lands in the finished
   video — a moment that fell in a cut lands where the next piece starts. */
function cutMap(cut, k, tabLens = []) {
  const pieces = cut.map((c) => {
    if (c.src === 'main') return { ...c, input: 0, start: c.from * k, end: c.to * k };
    const tabWall = Math.max(0.01, c.to - c.born);
    const kt = (tabLens[c.tab] || tabWall) / tabWall;
    return { ...c, input: 1 + c.tab, start: (c.from - c.born) * kt, end: Math.min(tabLens[c.tab] || Infinity, (c.to - c.born) * kt) };
  }).filter((p) => p.end > p.start);
  const total = pieces.reduce((sum, p) => sum + (p.end - p.start), 0);
  const at = (t) => {
    let offset = 0;
    for (const p of pieces) {
      const len = p.end - p.start;
      if (t < p.from) return offset;
      if (t <= p.to) return offset + len * ((t - p.from) / Math.max(0.001, p.to - p.from));
      offset += len;
    }
    return total;
  };
  return { pieces, total, at };
}

function build(shot, take, outDir) {
  const W = shot.width * shot.dpr;
  const H = shot.height * shot.dpr;

  /* The recorder runs a little behind the wall clock, so the wall-clock
     marks are scaled to the video's own length before they cut it. */
  const k = lengthOf(take.main) / take.marks.end;
  const { pieces, total, at } = cutMap(take.cut, k, take.tabs.map(lengthOf));

  const inputs = ['-i', take.main];
  take.tabs.forEach((f) => inputs.push('-i', f));
  const voiceInputs = take.voice.map((line) => path.join(NARRATION, NARRATION_LINES[line.key].file));
  voiceInputs.forEach((f) => inputs.push('-i', f));
  const firstVoice = 1 + take.tabs.length;

  const vf = pieces.map((s, i) => `[${s.input}:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,`
    + `fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:white,setsar=1[s${i}]`).join(';');
  const concat = `${pieces.map((_, i) => `[s${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0[v]`;
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
  /* the poster: the first search's real results, a moment after they arrive */
  run(['-ss', (at(take.marks.results0) + 1.2).toFixed(3), '-i', master, '-frames:v', '1', '-q:v', '3', poster]);
  fs.unlinkSync(master);

  writeTrack(path.join(outDir, `${shot.name}.vtt`), take.cues.map((c) => ({ ...c, start: at(c.start), end: Math.min(total, at(c.end)) })), total);
  const size = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`  ${shot.name}: ${total.toFixed(1)}s — mp4 ${size(mp4)}, webm ${size(webm)}, poster ${size(poster)}`);
  if (total < TARGET.min || total > TARGET.max) {
    console.log(`  note: ${shot.name} is ${total.toFixed(1)}s, outside the ${TARGET.min}–${TARGET.max}s it is meant to be`);
  }
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

/* The note under the video says what it is: real searches, which ones,
   and when they were made, because prices and stock move on after a
   recording. The video's own label says the same for anyone not seeing
   it. Only the text between the markers, and those two labels, are
   replaced in index.html. */
const attr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const listed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function describeOnPage(saved) {
  const file = path.join(REPO, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const when = new Date(saved.searchedAt);
  const date = Number.isNaN(when.getTime()) ? 'recently'
    : when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const queries = saved.searches.map((s) => s.query);
  const count = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][queries.length] || String(queries.length);
  const note = `<!-- demo-note -->
          <span class="status status--live">Real search</span>
          ${count} real searches, recorded on Fynd on ${date}. Prices and availability may have changed since. Turn the sound on for the narration.
          <!-- /demo-note -->`;
  let next = html.replace(/<!-- demo-note -->[\s\S]*?<!-- \/demo-note -->/, note);
  if (next === html && !html.includes(note)) {
    console.log('  note: the demo-note markers were not found in index.html; update the note under the video by hand');
    return;
  }
  const label = `Screen recording of Fynd: ${count.toLowerCase()} different requests are typed into the search box in turn — ${listed(queries.map((q) => `“${q}”`))}. Each time, real products come back with their photos, prices and retailers, and one of them is opened at its retailer.`;
  next = next
    .replace(/(<video class="demo-video" id="demo-video"[^>]*?aria-label=")[^"]*(")/, `$1${attr(label)}$2`)
    .replace(/(<section class="section section--flush demo" id="demo" aria-label=")[^"]*(")/, `$1Demo: ${count.toLowerCase()} real searches, start to finish$2`);
  fs.writeFileSync(file, next);
  console.log('  updated the note and the video\'s label in index.html');
}

/* ---------------------------------------------------------
   The run
   --------------------------------------------------------- */

/* every narration clip the recording can ask for */
const narrationNeeded = () => [...new Set([...SEARCHES.map((s) => s.line), 'found', 'found-one', 'open', 'close'])];

/* A saved file is only replayed if it is the whole of a run of this
   script: one search per slot, in order, each with its products and with
   which retailer pages were seen to open. */
function savedProblem(saved) {
  if (!saved || !Array.isArray(saved.searches)) return 'is from an older, one-search version of the demo';
  if (saved.searches.length !== SEARCHES.length) return `holds ${saved.searches.length} searches; the demo makes ${SEARCHES.length}`;
  for (let i = 0; i < SEARCHES.length; i += 1) {
    const s = saved.searches[i];
    if (!s || s.slot !== SEARCHES[i].slot) return `does not hold the "${SEARCHES[i].slot}" search in place ${i + 1}`;
    if (!SEARCHES[i].candidates.some((c) => c.query === s.query)) return `holds "${s.query}", which is no longer one of the "${s.slot}" requests`;
    if (!s.search || !Array.isArray(s.shown) || !s.shown.length) return `has no products for "${s.query}"`;
    if (!s.shown.some((p) => p.retailerOk === true)) return `has no retailer page seen to open for "${s.query}"`;
  }
  return '';
}

async function main() {
  const hadEnv = loadEnv();
  FFMPEG = findFfmpeg();
  FFPROBE = ffprobeFor(FFMPEG);
  /* in-memory metering only: never production KV */
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
    .forEach((k) => { delete process.env[k]; });

  if (!NARRATION_LINES) fail('assets/demo/narration/manifest.json is missing. Run scripts/demo-narration.py.');
  const unspoken = narrationNeeded().filter((key) => !NARRATION_LINES[key]
    || !fs.existsSync(path.join(NARRATION, NARRATION_LINES[key].file)));
  if (unspoken.length) fail(`The narration has no clip for: ${unspoken.join(', ')}. Run scripts/demo-narration.py.`);
  if (!STILLS) {
    try { execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch (err) { fail(`ffmpeg was not found at ${FFMPEG}. Install it, or set FFMPEG_PATH.`); }
    /* checked now, not after two recordings: the encode needs it */
    try { execFileSync(FFPROBE, ['-hide_banner', '-version'], { stdio: 'ignore' }); } catch (err) { fail(`ffprobe was not found at ${FFPROBE}. It ships beside ffmpeg; set FFPROBE_PATH if it lives elsewhere.`); }
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
      const problem = savedProblem(api.saved);
      if (problem) fail(`${path.relative(REPO, file)} ${problem}. Run without --replay to search again.`);
      console.log(`Replaying the real searches of ${api.saved.searchedAt}:`);
      for (const s of api.saved.searches) console.log(`  "${s.query}" (${s.shown.length} products)`);
    } else {
      console.log(`Searching for real${hadEnv ? ' with .env' : ''}:`);
      api.saved = await realSearches(chromium);
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
}

/* run when invoked; importable (for scripts/test-record-demo.js) without
   starting anything */
if (require.main === module) main();

module.exports = { ffprobeFor, durationCommand, SEARCHES, MIN_PRODUCTS, verdict, fitness, pickProduct, budgetOf, priceOf, mentionOf, cutMap, savedProblem, narrationNeeded };

