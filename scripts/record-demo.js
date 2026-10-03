#!/usr/bin/env node
/* =========================================================
   Fynd — records the landing page demo video

   A screen recording of a person using Fynd to solve real shopping
   problems — the time it saves over checking store after store, shown by
   doing it (the searches: scripts/demo-plan.js):

     the homepage, nothing typed yet
       "Ever know exactly what you want, but not where to find it?"
     the pointer goes to the box
       "Instead of checking a bunch of stores, I can just describe it."
     the first request is typed and searched
       "I need a black oversized hoodie, but I don't want to spend more than $80."
     real products come back; a look along them, a moment on one
       "And these are all coming from different stores."
     one is opened: the retailer's own page, in its own tab
       "Then I can open the exact product at the store selling it."
     back on Fynd; another product, another shop; back again
     the request is changed by hand — "$80" becomes "$120" — and searched
       "And I can change the details without rebuilding a bunch of filters."
     different products come forward
     cleared; a completely different garment
       "Or maybe I'm looking for something completely different."
     its results; one opened at its retailer; back
     cleared; a designer
       "I can even get more specific and search for a particular designer."
     real Prada results; one opened at its retailer; back
     cleared; one sentence with several details at once
       "I don't need any filters for this. I can say the whole thing in one sentence."
     its results; one opened at its retailer; back
     a closing card: "Describe what you want. Fynd finds it."  Fynd

   Five products are opened at five different shops where the shops allow
   it. A calm music bed plays underneath, ducked under the voice. Each
   line starts when what it describes is on screen, and the retailer line
   is said on the retailer's page itself.

   Nothing reaches the camera unchecked. Before recording, every product
   that can come into view is checked: it is what its search asked for
   (the garment, the designer, the budget), it links to an https product
   page, and its photo is a real photograph (fynd-demo/scripts/photos.mjs:
   a raster photo of at least 320px with real detail — never drawn
   artwork, a placeholder or a thumbnail). A query whose products do not
   all pass is not used. While recording, the page notes every card that
   comes into view, and the video is refused if any was not checked.

   A retailer that is slow, blocks robots, or opens no tab never stops the
   run or the next product: its tab is not shown, the strip says which
   address was opened, and the wait is cut out of the video.

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
     - .env.local / .env with PRODUCT_SOURCE and its key; OPENAI_API_KEY for
       the AI interpreter (without it the page reads the request with its
       local interpreter, exactly as the live site would)

   The recording never touches production state: KV / Upstash settings are
   dropped from this process, so the one search it makes is metered in
   memory, not against anybody's real allowance.

   The narration is four committed clips in assets/demo/narration/, made
   by scripts/demo-narration.py. Nothing here needs a speech model.

   Writes, into assets/demo/:
     fynd-demo.mp4 / .webm                desktop, 1280 x 800, with narration
     fynd-demo-mobile.mp4 / .webm         phone layout, 800 x 1440 (400 x 720 @2x)
     fynd-demo-poster.jpg, fynd-demo-mobile-poster.jpg
     fynd-demo.vtt, fynd-demo-mobile.vtt  captions, timed to the narration
     demo-search.json                     the real search both were made from
     demo-recording.json                  which products each video opened, and how

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
const { visitRetailer, checkRetailer, chooseNext, hostOf } = require('./demo-retailer-visit');
const PLAN = require('./demo-plan');
const { satisfies, editFor, changedEnough } = PLAN;

const REPO = path.join(__dirname, '..');
const arg = (name) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};

/* --no-refine leaves out changing "$80" to "$120": six or seven seconds
   shorter (about 62s instead of 66–69s), every other search the same */
const SEARCHES = PLAN.SEARCHES.filter((x) => !(arg('no-refine') && x.mode === 'edit'));
const OUT = path.resolve(arg('out') || path.join(REPO, 'assets', 'demo'));
const NARRATION = path.join(REPO, 'assets', 'demo', 'narration');
const SEARCH_FILE = path.join(OUT, 'demo-search.json');
const STILLS = Boolean(arg('stills'));
const REPLAY = arg('replay');
const ONLY = arg('only');
const PORT = Number(process.env.DEMO_PORT || 8917);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/* The searches, what each must show, and how a person moves from one to
   the next: scripts/demo-plan.js. */
const QUERY = SEARCHES[0].queries[0].text;
const slotOf = (name) => SEARCHES.find((x) => x.slot === name) || SEARCHES[0];
const SEED = 20261002;

/* the fewest products worth showing, and the longest the page's own
   "Searching…" state is allowed to run on camera: the real search can
   take several seconds, and a recording of a spinner is not the point */
const MIN_PRODUCTS = 4;
/* How long a finished video may run. Four or five real searches, each
   with its own typing, loading and results, and five to seven retailer
   pages, come to roughly 45–60 seconds. Outside MIN–MAX the video is
   refused and nothing is written; outside TARGET it is kept, with a
   note: a short one usually means a search or a visit was left out. */
const DURATION = { min: 15, targetMin: 45, targetMax: 60, max: 70 };
/* retailer visits: at least this many must load, or nothing is written;
   and no search tries more products than this */
const MIN_VISITS = 4;
/* how many of each search's first results are checked before anything
   is recorded — every one that can come into view on camera. A search
   is only used if all of them pass; afterwards, every card that really
   was on camera is checked against this list. */
const ON_CAMERA = 12;
const MAX_ATTEMPTS = 6;
/* off camera, per search: retailers checked until this many usable shops
   are known, trying at most CHECK_LIMIT products */
const CHECK_WANT = 4;
const CHECK_LIMIT = 10;
const MAX_LOADING_MS = 650;
const MIN_LOADING_MS = 500;

/* the closing card, after the last retailer and back on Fynd */
const END_LINE = 'Describe what you want. Fynd finds it.';
const END_SECONDS = 2.2;
const END_FADE = 0.5;
/* the music bed under the recording: made by fynd-demo/scripts/music.py
   (--bars=27), a calm, warm 72-second bed at -29 LUFS; trimmed to the
   film and faded out with the closing card */
const MUSIC = path.join(REPO, 'assets', 'demo', 'music', 'bed.opus');

/* the address a retailer tab is at, as a browser would show it: the shop
   and the start of the path, never the query string */
function displayUrl(url) {
  try {
    const u = new URL(url);
    const shown = u.hostname.replace(/^www\d?\./, '') + (u.pathname === '/' ? '' : u.pathname);
    return shown.length > 56 ? `${shown.slice(0, 55)}…` : shown;
  } catch (err) { return url; }
}

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
  /* .env.local first, so it wins over .env, as it does for the site */
  const files = ['.env.local', '.env'].map((f) => path.join(REPO, f)).filter((f) => fs.existsSync(f));
  for (const file of files) readEnvFile(file);
  return files.length ? files.map((f) => path.basename(f)).join(' + ') : false;
}

function readEnvFile(file) {
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

/* the saved search the page is in the middle of: chosen by the query
   it sends to /api/interpret, answered again by /api/search */
let replaying = null;
const sameQuery = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

function replay(route, res, body) {
  if (route === 'interpret') {
    replaying = (api.saved.searches || []).find((x) => sameQuery(x.query, body && body.query)) || null;
    if (!replaying) console.log(`  replay: no saved search for "${body && body.query}"`);
  }
  const saved = replaying && replaying[route];
  if (!saved) { res.statusCode = 503; return res.end('{}'); }
  const delay = route === 'search'
    ? Math.min(MAX_LOADING_MS, Math.max(MIN_LOADING_MS, saved.ms))
    : Math.min(260, Math.max(150, saved.ms));
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
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (err) { body = {}; }
      replay(route[1], res, body);
    });
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
  /* retailer tabs opened from the page are left exactly as they are */
  if (location.origin !== origin) return;
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

    /* every result card that comes into view (a third of it or more),
       by the product it links to: the recorder checks afterwards that each
       one was a product checked before recording. Nothing on the page is
       changed — the cards are only watched. */
    const seen = new Set();
    const watched = new WeakSet();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting && e.intersectionRatio >= 0.3) seen.add(e.target.getAttribute('href') || e.target.outerHTML.slice(0, 80));
    }, { threshold: [0.3] });
    const watch = () => document.querySelectorAll('#results .item-card').forEach((c) => {
      if (!watched.has(c)) { watched.add(c); io.observe(c); }
    });
    new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
    watch();
    window.demoSeen = () => [...seen];

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

/* One real search, made the way the page makes it: typed into the box on
   a fresh page, submitted, answered by the real handlers. Returns what it
   found, or why it is not fit to record. */
async function searchOnce(chromium, query) {
  api.mode = 'live';
  api.exchanges = {};
  /* the recorder's own metering starts empty for each search: the free
     allowance is one search a day, and these are the recorder's, not a
     visitor's. Memory only — production KV is never configured here. */
  require(path.join(REPO, 'api', '_store')).reset();

  const browser = await chromium.launch({ executablePath: chromePath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(pagePrep, ORIGIN);
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  await page.fill('#ask', query);
  await page.click('#ask-form button[type=submit]');

  const outcome = await Promise.race([
    page.waitForSelector('#results .grid .item-card', { timeout: 45000 }).then(() => 'cards'),
    page.waitForSelector('#results .empty', { timeout: 45000 }).then(() => 'empty')
  ]).catch(() => 'timeout');

  const search = api.exchanges.search;
  let problems = [];
  let found = [];
  if (!search) problems = ['the page never reached /api/search'];
  else if (search.status !== 200 || outcome !== 'cards') {
    const why = search.response && (search.response.error || search.response.notice || search.response.state);
    problems = [`no products (HTTP ${search.status}${why ? `: ${why}` : ''})`];
  } else {
    found = await checkResults(page);
    problems = verdict(found);
  }
  await browser.close();
  return { query, search, interpret: api.exchanges.interpret || null, found, problems };
}

async function realSearches(chromium) {
  if (!process.env.PRODUCT_SOURCE) {
    fail('.env.local / .env does not configure a product source (PRODUCT_SOURCE). The demo is a real search; set PRODUCT_SOURCE and its API key.');
  }
  if (!process.env.OPENAI_API_KEY && !process.env.AI_PROVIDER) {
    console.log('  note: no OPENAI_API_KEY — the page will read requests with its local interpreter, as the live site does without one');
  }

  const searches = [];
  const knownBad = new Set();
  for (const slot of SEARCHES) {
    let chosen = null;
    for (const query of slot.queries) {
      const r = await searchOnce(chromium, query.text);
      let entry = null;
      if (!r.problems.length) {
        entry = {
          slot: slot.slot,
          query: r.query,
          interpret: r.interpret,
          search: r.search,
          shown: r.found.map(({ name, retailer, href, src, width, height }) => ({ name: name.trim(), retailer, href, photo: src, width, height }))
        };
        r.problems = await vouch(chromium, entry, searches);
      }
      if (!r.problems.length) { chosen = entry; break; }
      console.log(`  "${query.text}": not used — ${r.problems.slice(0, 3).join('; ')}${r.problems.length > 3 ? ` (+${r.problems.length - 3} more)` : ''}`);
    }
    if (!chosen) {
      if (slot.required) fail(`No query for the "${slot.slot}" search returned enough real products that all pass. Try other queries in scripts/demo-plan.js.`);
      console.log(`  the "${slot.slot}" search is left out: none of its queries passed`);
      continue;
    }
    const hosts = new Set(chosen.shown.map((f) => hostOf(f.href)));
    console.log(`  "${chosen.query}": ${chosen.shown.length} real products from ${hosts.size} retailer(s); the first ${chosen.verified.length} all checked`);
    /* every search that opens products is checked: a later one may have
       to make up visits an earlier one could not get */
    if (slotOf(slot.slot).open) await checkRetailers(chromium, chosen, knownBad);
    searches.push(chosen);
  }
  return { searchedAt: new Date().toISOString(), productSource: process.env.PRODUCT_SOURCE, searches };
}

/* The gate a saved search answers to: its slot's query of the same words. */
function gateFor(entry) {
  const slot = SEARCHES.find((x) => x.slot === entry.slot);
  return slot && slot.queries.find((x) => sameQuery(x.text, entry.query));
}

/* Everything a recording needs to be true of the products that can come
   into view, checked before anything is recorded — live, and again on
   every replay, since a listing's photo can change after it was saved:

     - each is what its search asked for (demo-plan.js satisfies: the
       garment, the designer, the budget)
     - each links to an https product page and is one the API returned
     - each photo is a real photograph (fynd-demo/scripts/photos.mjs: a
       raster photo, at least 320px wide, with real detail — not drawn
       artwork, a placeholder or a thumbnail), downloaded from the very
       address the card showed
     - a changed request (mode 'edit') really brings different products

   Returns the problems; none, and `entry.verified` lists the products
   that may be on camera. */
async function vouch(chromium, entry, before) {
  const gate = gateFor(entry);
  if (!gate) return [`"${entry.query}" is not one of the searches in scripts/demo-plan.js`];
  const records = ((entry.search && entry.search.response) || {}).products || [];
  const problems = [];
  const browser = await chromium.launch({ executablePath: chromePath() });
  const context = await browser.newContext();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-demo-photo-'));
  try {
    for (const [i, card] of entry.shown.slice(0, ON_CAMERA).entries()) {
      const who = `#${i + 1} "${card.name.slice(0, 60)}"`;
      const rec = records.find((r) => r.productUrl === card.href);
      if (!rec) { problems.push(`${who} is not one of the products the search returned`); continue; }
      if (!secure(card.href)) problems.push(`${who} links to ${card.href}, not an https product page`);
      const unmet = satisfies(rec, gate);
      if (unmet) problems.push(`${who}: ${unmet}`);
      const photo = await photoProblemAt(context, card.photo, path.join(scratch, String(i)));
      if (photo) problems.push(`${who}: its photo ${photo}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const spec = slotOf(entry.slot);
  if (spec.mode === 'edit') {
    const prev = before[before.length - 1];
    if (!prev) problems.push('there is no earlier request to change');
    else {
      const change = changedEnough(prev.shown.slice(0, 8).map((x) => x.href), entry.shown.map((x) => x.href));
      if (!change.ok) problems.push(`changing "${prev.query}" to "${entry.query}" brought only ${change.fresh} new product(s) into view`);
      entry.editedFrom = prev.query;
    }
  }
  entry.verified = problems.length ? [] : entry.shown.slice(0, ON_CAMERA).map((x) => x.href);
  return problems;
}

/* https only. DEMO_TEST_ORIGIN names the one plain-http origin the
   recorder's own test serves its stand-in shop from; it is never set
   for a real recording. */
const secure = (u) => /^https:\/\//.test(String(u)) || Boolean(process.env.DEMO_TEST_ORIGIN && String(u).startsWith(process.env.DEMO_TEST_ORIGIN));

/* the real-photo test, on the file the card's own address serves */
let photosModule = null;
async function photoProblemAt(context, url, base) {
  if (!secure(url)) return `is not served over https (${url})`;
  if (!photosModule) photosModule = await import(require('url').pathToFileURL(path.join(REPO, 'fynd-demo', 'scripts', 'photos.mjs')).href);
  const res = await context.request.get(url, { timeout: 20000, headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' } })
    .catch((err) => ({ ok: () => false, status: () => err.message.split('\n')[0] }));
  if (!res.ok()) return `could not be downloaded (${res.status()})`;
  const type = (res.headers()['content-type'] || '').split(';')[0].trim();
  const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }[type];
  if (!ext) return `is not a photograph (${type || 'no type'})`;
  const file = `${base}${ext}`;
  fs.writeFileSync(file, await res.body());
  return photosModule.photoProblem(file);
}

/* Off camera: which of a search's products lead to a usable retailer
   page. Tried in the order they sit in the grid, one per shop, until
   CHECK_WANT usable shops are known or CHECK_LIMIT products are tried. A
   shop already known to block is not asked again. Each product's verdict
   is kept with the search, so the recording only reaches for products
   whose shop answered — and a blocked one is never clicked on camera. */
async function checkRetailers(chromium, search, knownBad) {
  const browser = await chromium.launch({ executablePath: chromePath() });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const usable = new Set();
  const asked = new Set();
  let tried = 0;
  /* only products that may be on camera are ever clicked */
  for (const item of search.shown.slice(0, ON_CAMERA)) {
    if (usable.size >= CHECK_WANT || tried >= CHECK_LIMIT) break;
    const host = hostOf(item.href);
    if (!/^https?:\/\//.test(item.href) || asked.has(host)) continue;
    asked.add(host);
    if (knownBad.has(host)) { item.check = { kind: 'blocked', reason: 'blocked in an earlier search' }; continue; }
    tried += 1;
    const verdict = await checkRetailer(context, item.href);
    item.check = { kind: verdict.kind, reason: verdict.reason, checkedAt: new Date().toISOString() };
    if (verdict.kind === 'loaded') usable.add(host);
    else knownBad.add(host);
  }
  /* a shop's verdict holds for its other products too */
  const byHost = {};
  for (const item of search.shown) if (item.check) byHost[hostOf(item.href)] = item.check;
  for (const item of search.shown) if (!item.check && byHost[hostOf(item.href)]) item.check = { ...byHost[hostOf(item.href)] };
  await browser.close();
  const said = search.shown.filter((x) => x.check).reduce((acc, x) => {
    const h = hostOf(x.href);
    if (!acc.some((a) => a.startsWith(`${h} `))) acc.push(`${h} ${x.check.kind === 'loaded' ? 'ok' : `${x.check.kind}${x.check.reason ? ` (${x.check.reason})` : ''}`}`);
    return acc;
  }, []);
  console.log(`  retailers for "${search.query}": ${said.join(', ') || 'none checked'}`);
  return usable.size;
}

/* a search saved before there were several: one search, the first slot */
function asSearches(saved) {
  if (saved.searches) return saved;
  return { searchedAt: saved.searchedAt, productSource: saved.productSource,
    searches: [{ slot: 'everyday', query: saved.query || QUERY, interpret: saved.interpret, search: saved.search, shown: saved.shown }] };
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
  const photos = api.saved.searches.flatMap((x) => x.shown.map((s) => s.photo)).filter(Boolean);
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
    const text = line ? line.caption || line.text : key;
    const start = now();
    voice.push({ key, start });
    cues.push({ text, start, end: start + (line ? line.duration + 0.35 : 2.5) });
    await page.evaluate((t) => window.demo.say(t), text);
    return line ? line.duration * 1000 : 2500;
  };
  /* a line said on a retailer's own page: placed against that tab in the
     finished video, its words in that page's strip */
  const speakOn = async (tab, key, visitIndex) => {
    const line = NARRATION_LINES[key];
    const text = line.caption || line.text;
    voice.push({ key, visit: visitIndex, offset: 0.15 });
    cues.push({ text, visit: visitIndex, offset: 0.15, length: line.duration + 0.3 });
    await tab.evaluate((t) => window.demo && window.demo.say(t), text).catch(() => {});
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
    const duration = ms || Math.min(950, 320 + dist * 0.75) * rand.between(0.9, 1.12);
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
  async function typeLikeAPerson(text, pace = 96) {
    const words = text.split(' ');
    for (let w = 0; w < words.length; w += 1) {
      /* each gap is measured from the last key, so the time the
         browser takes to take a key is part of the gap, not added to it */
      for (const ch of words[w]) {
        let gap = rand.around(pace, pace * 0.3);
        if (ch === '$') gap += rand.between(90, 160);
        const pressed = Date.now();
        await page.keyboard.type(ch);
        await wait(Math.max(48, gap) - (Date.now() - pressed));
      }
      if (w < words.length - 1) {
        const pressed = Date.now();
        await page.keyboard.type(' ');
        await wait(rand.around(pace * 1.45, 38) + (rand.next() < 0.18 ? rand.between(110, 240) : 0) - (Date.now() - pressed));
      }
    }
  }

  /* A real scroll: the wheel on a desktop, through the browser's own
     scroll gesture; on a phone, a finger's swipe as real touch events,
     quick in the middle and easing off, the way a thumb moves. */
  const cdp = await context.newCDPSession(page);
  /* a scroll is over when the page stops moving — a swipe keeps going
     after the finger lifts, and anything measured before it stops is
     measured in the wrong place */
  async function settle(quiet = 3) {
    let last = null;
    let still = 0;
    const until = Date.now() + 2500;
    while (Date.now() < until && still < quiet) {
      const y = await page.evaluate(() => window.scrollY);
      still = y === last ? still + 1 : 0;
      last = y;
      await wait(50);
    }
  }

  async function scrollBy(pixels, point) {
    /* on a phone, anything shorter than a real drag is read as a tap on
       whatever is under the finger — so it is not done at all */
    if (shot.touch && Math.abs(pixels) < 40) return;
    const flick = shot.touch && Math.abs(pixels) > viewH * 0.5;
    await scrollGesture(pixels, point);
    /* a flick glides on after the finger lifts; wait for the glide */
    if (flick) await wait(380);
    await settle(flick ? 5 : 3);
  }

  async function scrollGesture(pixels, point) {
    /* a swipe starts low to scroll down and high to scroll back up, so
       the finger stays on the screen */
    const p = point || { x: shot.width * rand.between(0.45, 0.6), y: viewH * (pixels < 0 ? 0.3 : 0.68) };
    if (!shot.touch) {
      await cdp.send('Input.synthesizeScrollGesture', {
        x: Math.round(p.x), y: Math.round(p.y), yDistance: -Math.round(pixels),
        speed: Math.abs(pixels) > 500 ? 1500 : 900, gestureSourceType: 'mouse', preventFling: true
      });
      return;
    }
    /* a long way on a phone is a flick: a quick swipe let go while still
       moving, and the page glides on by itself. The caller measures
       again afterwards and finishes with a short swipe if it needs to. */
    const most = viewH * 0.5;
    if (Math.abs(pixels) > most) {
      const dir = Math.sign(pixels);
      const fx = shot.width * rand.between(0.45, 0.6);
      const fy = viewH * (dir < 0 ? 0.3 : 0.7);
      const reach = most * rand.between(0.8, 0.95);
      await page.evaluate(([x, y]) => window.demo.touchAt(x, y, true), [fx, fy]);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fx, y: fy }] });
      for (let i = 1; i <= 8; i += 1) {
        const y = fy - dir * reach * (i / 8);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fx, y }] });
        await page.evaluate(([px, py]) => window.demo.touchAt(px, py, true), [fx, y]);
        await wait(12);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.evaluate(([x, y]) => window.demo.touchAt(x, y, false), [fx, fy - dir * reach]);
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

  /* --- choosing what to compare ------------------------------------ */

  const cardSel = (i) => `#results .grid .item-card:nth-child(${i + 1})`;

  /* the results as they sit on screen: index, link and row */
  async function cardsOnScreen() {
    const cards = await page.evaluate(() => [...document.querySelectorAll('#results .grid .item-card')].map((c, i) => {
      const r = c.getBoundingClientRect();
      return { i, href: c.getAttribute('href') || '', top: Math.round(r.top) };
    }));
    const rowTop = cards.length ? cards[0].top : 0;
    return cards.map((c) => ({ ...c, row: c.top > rowTop + 20 ? 1 : 0 }));
  }

  /* a card is scrolled to only if it is not already wholly in view */
  async function bringIntoView(sel) {
    const r = await page.evaluate((s2) => {
      const b = document.querySelector(s2).getBoundingClientRect();
      const header = document.querySelector('.site-header');
      return { top: b.top, bottom: b.bottom, head: header ? header.getBoundingClientRect().height : 0 };
    }, sel);
    const low = r.bottom - (viewH - 12);
    const high = r.top - (r.head + 12);
    const by = low > 0 ? Math.min(low + 24, high) : (high < 0 ? high - 24 : 0);
    if (Math.abs(by) < 6) return false;
    await scrollBy(by);
    /* a swipe can fall short: finish the job if it did */
    for (let i = 0; i < 3; i += 1) {
      const again = await page.evaluate((s2) => {
        const b = document.querySelector(s2).getBoundingClientRect();
        const header = document.querySelector('.site-header');
        return { top: b.top, bottom: b.bottom, head: header ? header.getBoundingClientRect().height : 0 };
      }, sel);
      const over = again.bottom - (viewH - 12);
      const under = again.top - (again.head + 12);
      const more = over > 0 ? Math.min(over + 24, under) : (under < 0 ? under - 24 : 0);
      if (Math.abs(more) < 6) break;
      await scrollBy(more);
    }
    await wait(rand.between(200, 350));
    return true;
  }

  /* a look at a product or two without opening it: the pointer rests on
     the photo, the way a person stops on something and moves on. On a
     phone, a pause and a small scroll. */
  async function lookAt(candidates, count) {
    for (let k = 0; k < count && candidates.length; k += 1) {
      const c = candidates[Math.floor(rand.next() * Math.min(candidates.length, 4))];
      const sel = cardSel(c.i);
      const r = await page.evaluate((s2) => {
        const el = document.querySelector(s2);
        const b = el && el.getBoundingClientRect();
        return b && { top: b.top, bottom: b.bottom };
      }, sel);
      /* only something already in view: looking is not scrolling */
      if (!r || r.top < 60 || r.bottom > viewH - 10) continue;
      if (shot.touch) {
        await wait(rand.between(500, 800));
      } else {
        await moveTo(spotIn(await box(`${sel} .item-media`), 0.5, 0.45));
        await wait(rand.between(400, 650));
      }
    }
  }

  /* --- the homepage --------------------------------------------------- */

  if (!shot.touch) await page.mouse.move(at.x, at.y);
  await wait(450);
  marks.start = now();
  await wait(rand.between(250, 400));

  /* DEMO_DEBUG=1 prints when each step happened, to find slack */
  const beat = (label) => { if (process.env.DEMO_DEBUG) (marks.beats = marks.beats || []).push(`${now().toFixed(1)} ${label}`); };
  const visits = [];
  const opened = new Set();       /* shops shown successfully */
  const bad = new Set();          /* shops that blocked or failed */
  let retailerSaid = false;
  /* successful retailer visits owed by the end of search n */
  const owed = (n) => api.saved.searches.slice(0, n + 1).reduce((sum, x) => sum + (slotOf(x.slot).open || 0), 0);
  marks.results = [];

  for (let n = 0; n < api.saved.searches.length; n += 1) {
    const saved = api.saved.searches[n];
    const spec = slotOf(saved.slot);
    let pending = 0;          /* a line still being said, in ms from pendingFrom */
    let pendingFrom = Date.now();
    const saying = async (key) => { pending = await speak(key); pendingFrom = Date.now(); };
    const finishLine = async (extra = 150) => {
      if (!pending) return;
      await wait(pending - (Date.now() - pendingFrom) + extra);
      await hush();
      pending = 0;
    };

    beat('box '+(n+1));
    /* --- into the box ------------------------------------------------- */

    /* back up to the box: a scroll can fall short, so it is measured
       again after each one, until the box sits in the upper part */
    const backToBox = async () => {
      const aim = rand.between(60, 110);
      for (let i = 0; i < 5; i += 1) {
        const form = await page.evaluate(() => {
          const f = document.getElementById('ask-form').getBoundingClientRect();
          const header = document.querySelector('.site-header');
          return { top: f.top, head: header ? header.getBoundingClientRect().height : 0 };
        });
        const up = form.top - (form.head + aim);
        if (form.top >= form.head + 8 && form.top <= viewH * 0.45) break;
        await scrollBy(up);
      }
      await wait(rand.between(100, 180));
    };
    const edit = spec.mode === 'edit' ? editFor(saved.editedFrom || api.saved.searches[n - 1].query, saved.query) : null;

    if (n === 0) {
      /* the question first, over the homepage; then into the box */
      const [hook, describe] = spec.lines.opening || [];
      if (hook) {
        await saying(hook);
        if (!shot.touch) {
          /* a hand resting on the mouse: a small drift while listening */
          await moveTo({ x: at.x - rand.between(40, 90), y: at.y - rand.between(20, 50) }, rand.between(1300, 1700));
        }
        await finishLine(rand.between(120, 220));
      }
      if (describe) await saying(describe);
      const field = await box('#ask');
      const spot = { x: field.x + Math.min(160, field.width * 0.3) + rand.between(-20, 20), y: field.y + field.height / 2 };
      if (shot.touch) {
        await wait(rand.between(500, 800));
        await tap(spot);
      } else {
        await moveTo(spot, rand.between(1000, 1300));
        await wait(rand.between(120, 220));
        await click();
      }
      await page.focus('#ask');
    } else if (edit) {
      /* changing one detail: back up to the request, a click at the end of
         it, the old ending deleted a key at a time, the new one typed */
      if (spec.lines.before) await saying(spec.lines.before);
      await backToBox();
      const end = await page.evaluate(() => {
        const el = document.getElementById('ask');
        const cs = getComputedStyle(el);
        const c = document.createElement('canvas').getContext('2d');
        c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const r = el.getBoundingClientRect();
        const x = r.left + parseFloat(cs.paddingLeft) + c.measureText(el.value).width;
        return { x: Math.min(x + 4, r.right - 8), y: r.top + Math.min(r.height / 2, parseFloat(cs.lineHeight) || 24) };
      });
      if (shot.touch) await tap(end);
      else {
        await moveTo(end);
        await wait(rand.between(120, 220));
        await click();
      }
      await page.focus('#ask');
      await page.keyboard.press('End');
      await wait(rand.between(250, 400));
      for (let i = 0; i < edit.erase; i += 1) {
        await page.keyboard.press('Backspace');
        await wait(rand.between(110, 170));
      }
      await wait(rand.between(150, 260));
    } else {
      /* starting again: back up to the box, and its own × clears it —
         the page hides the old results and puts the cursor in the box */
      if (spec.lines.before) await saying(spec.lines.before);
      await backToBox();
      /* the × that clears the box; measured once the page has stopped,
         and pressed again if the box did not empty */
      for (let tryClear = 0; ; tryClear += 1) {
        const clear = spotIn(await box('#reset-form'), 0.5, 0.5);
        if (shot.touch) await tap(clear);
        else {
          await moveTo(clear);
          await wait(rand.between(120, 220));
          await click();
        }
        await wait(rand.between(120, 200));
        await settle(2);
        const left2 = await page.evaluate(() => document.getElementById('ask').value);
        if (!left2) break;
        if (tryClear >= 1) {
          const under = await page.evaluate(([x, y]) => {
            const e = document.elementFromPoint(x, y);
            const r = document.getElementById('reset-form').getBoundingClientRect();
            return { el: e ? `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}.${String(e.className).slice(0, 40)}` : 'nothing',
              x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), shown: getComputedStyle(document.getElementById('reset-form')).display };
          }, [clear.x, clear.y]);
          const shotPath = path.join(os.tmpdir(), `${shot.name}-clear-failed.png`);
          await page.screenshot({ path: shotPath }).catch(() => {});
          fail(`The search box could not be cleared before "${saved.query}" (it still says "${left2}"). `
            + `Tapped (${Math.round(clear.x)}, ${Math.round(clear.y)}); there: ${under.el}; the × is at ${under.x},${under.y} ${under.w}x${under.h} (${under.shown}). Screenshot: ${shotPath}`);
        }
      }
      await page.focus('#ask');
    }
    await wait(rand.between(150, 280));

    beat('typing '+(n+1));
    /* --- the request --------------------------------------------------- */

    /* the line about the request starts the moment the one before it is
       over — part-way through the typing if need be, as a person talks
       while they type */
    const typedFrom = Date.now();
    const typing = typeLikeAPerson(edit ? edit.type : saved.query, n === 0 ? 80 : 58);
    if (spec.lines.typing) {
      await finishLine(0);
      await saying(spec.lines.typing);
    }
    await typing;
    /* what is in the box is exactly the request, nothing left over */
    const inBox = await page.evaluate(() => document.getElementById('ask').value);
    if (inBox !== saved.query) fail(`The search box says "${inBox}", not "${saved.query}".`);
    await still(`typed-${n + 1}`);
    /* a short pause after typing, longer only if a line is still going */
    const left = pending ? pending - (Date.now() - pendingFrom) : 0;
    await wait(Math.max(rand.between(350, 550), left + 200 - 300));
    void typedFrom;

    beat('search '+(n+1));
    /* --- search -------------------------------------------------------- */

    /* the first time, the Search button; after that, on a computer,
       Enter — the site submits on it, and someone who has searched once
       already knows. On a phone, a tap on Search every time. */
    if (shot.touch) {
      await wait(rand.between(150, 300));
      await tap(spotIn(await box('#ask-form button[type=submit]')));
    } else if (n === 0) {
      await moveTo(spotIn(await box('#ask-form button[type=submit]')));
      await wait(rand.between(120, 220));
      await click();
    } else {
      await wait(rand.between(120, 240));
      await page.keyboard.press('Enter');
    }
    await finishLine(0);

    beat('waiting '+(n+1));
    /* --- the results --------------------------------------------------- */

    await page.waitForSelector('#results .grid .item-card', { timeout: 20000 });
    /* the page scrolls itself to the results; let that land */
    await wait(120);
    const shown = await checkResults(page);
    const problems = verdict(shown);
    if (problems.length) fail(`On camera, the results for "${saved.query}" were not all real and loaded:\n  - ${problems.join('\n  - ')}`);
    marks.results.push(now());
    beat(`results ${n + 1}`);
    await still(`results-${n + 1}`);

    if (spec.lines.results) await saying(spec.lines.results);

    /* how many retailer visits this search still owes: its own share,
       plus whatever earlier searches could not get */
    const want = Math.max(0, owed(n) - opened.size);
    /* only products checked before recording are ever reached for */
    const verified = new Set(saved.verified || []);
    const cards = (await cardsOnScreen()).filter((c) => verified.has(c.href));
    const verdicts = Object.fromEntries(saved.shown.filter((x) => x.check).map((x) => [x.href, x.check.kind]));
    const firstChoice = want ? chooseNext(cards, { used: opened, bad, verdicts, row: 0 }) : null;

    if (firstChoice) {
      /* a look along the first row: the pointer drifts slowly over it,
         towards the first choice */
      if (!shot.touch) {
        const first = await box(`${cardSel(firstChoice.i)} .item-media`);
        await moveTo({ x: first.x + first.width * rand.between(0.7, 1.15), y: first.y + first.height * rand.between(0.55, 0.75) },
          rand.between(850, 1050));
      }
      await finishLine(rand.between(100, 200));
    } else if (!spec.lines.results && !spec.lines.before) {
      /* the last search: a look at one of the results, and that is all */
      if (!shot.touch) {
        const a = await box(`${cardSel(Math.min(1, cards.length - 1))} .item-media`);
        await moveTo(spotIn(a, 0.5, 0.5), rand.between(800, 1000));
      } else {
        await scrollBy(viewH * rand.between(0.14, 0.2));
      }
      await finishLine(100);
      await wait(rand.between(500, 700));
    } else {
      /* nothing to open this time: a look at what came back while the
         line is said — over one product, a slight scroll, over another */
      /* the new products first: the pointer goes to one that was not
         there before, rests, and on to another */
      if (!shot.touch) {
        const a = await box(`${cardSel(0)} .item-media`);
        await moveTo(spotIn(a, 0.5, 0.5), rand.between(600, 750));
        await wait(rand.between(200, 300));
        const other = await box(`${cardSel(Math.min(cards.length - 1, 2))} .item-media`);
        await moveTo(spotIn(other, 0.5, 0.5), rand.between(450, 600));
      } else {
        await wait(rand.between(500, 700));
        await scrollBy(viewH * rand.between(0.16, 0.24));
      }
      await finishLine(100);
      await wait(rand.between(100, 180));
    }

    /* --- products, at their retailers ---------------------------------

       One product at a time until this search has its visits: open it;
       a retailer page that loads is kept; one that blocks (Access
       Denied, a bot check, a CAPTCHA), shows nothing usable, is slow or
       opens no tab is skipped — the whole attempt is cut from the video
       — its shop is never tried again, and the next product is tried. */
    const tried = new Set();
    let got = 0;
    let attempts = 0;
    while (got < want && attempts < MAX_ATTEMPTS) {
      const pick = chooseNext(cards, { tried, used: opened, bad, verdicts, row: got === 0 ? 0 : 1 });
      if (!pick) break;
      tried.add(pick.i);
      attempts += 1;
      const sel = cardSel(pick.i);
      const approach = now();
      beat(`try ${pick.host}`);

      /* not straight to it: comparing, in the first search, a look at
         another product first, a moment on it, and then the one actually
         chosen; later, the person knows how this works */
      if (n === 0 && got === 0) await lookAt(cards.filter((c) => c.i !== pick.i), 1);
      await bringIntoView(sel);

      const media = await box(`${sel} .item-media`);
      const spot = spotIn(media, 0.5, 0.45);
      if (!shot.touch) {
        await moveTo(spot);
        await wait(rand.between(250, 450));       /* looking at it */
      } else {
        await wait(rand.between(400, 600));
      }
      await finishLine(100);
      await still(`product-${visits.length + 1}`);

      /* the card on screen is a product the search returned: same link —
         so what is opened is what was shown */
      const card = await page.evaluate((s2) => {
        const el = document.querySelector(s2);
        return el && { href: el.getAttribute('href') || '', name: (el.querySelector('.item-name') || {}).textContent || '' };
      }, sel);
      const listed = ((saved.search.response || {}).products || []).find((p2) => p2.productUrl === card.href);
      if (!card || !/^https?:\/\//.test(card.href) || !listed) {
        fail(`Card ${pick.i + 1} links to ${card && card.href} — not one of the products "${saved.query}" returned.`);
      }

      const index = visits.length;
      const narrate = !retailerSaid;
      const visit = await visitRetailer({
        context, page, href: card.href,
        /* long enough for the line, when this is the page it is said on */
        holdMs: narrate ? Math.max(2000, NARRATION_LINES.retailer.duration * 1000 + 300) : rand.between(1400, 1600),
        click: () => (shot.touch ? tap(spot) : click()),
        onLoaded: async (tab) => {
          if (narrate) {
            retailerSaid = true;
            await speakOn(tab, 'retailer', index);
          } else {
            await tab.evaluate((label) => window.demo && window.demo.say(label), displayUrl(tab.url())).catch(() => {});
          }
          if (stillsDir) await tab.screenshot({ path: path.join(stillsDir, `${shot.name}-retailer-${index + 1}.png`) }).catch(() => {});
        },
        log: (m) => console.log(`  ${shot.kind}:${m}`)
      });
      const t = (ms) => (ms == null ? null : (ms - pageBorn) / 1000);
      visits.push({
        search: saved.query, product: card.name.trim(), href: card.href, host: visit.host, kind: visit.kind,
        reason: visit.reason || null, url: visit.url, approach,
        click: t(visit.clickedAt), opened: t(visit.openedAt), pageAt: t(visit.pageAt),
        dom: t(visit.domAt), closed: t(visit.closedAt), video: visit.video
      });
      beat(`back ${visit.host} (${visit.kind})`);

      if (visit.kind === 'loaded') {
        opened.add(visit.host);
        got += 1;
        await wait(rand.between(200, 320));     /* back on Fynd, a beat */
      } else {
        bad.add(visit.host);
        await wait(rand.between(100, 200));
      }
    }
    if (got < want) console.log(`  ${shot.kind}: "${saved.query}" — ${got} of ${want} retailer visit(s) after ${attempts} attempt(s)`);
  }

  /* --- the end: back on Fynd's results; the closing card follows ------ */

  /* whatever is still being said is said to the end */
  const saidUntil = Math.max(0, ...voice.filter((x) => x.visit == null).map((x) => x.start + NARRATION_LINES[x.key].duration));
  await wait((saidUntil - now()) * 1000 + 200);
  await still('end');
  await wait(rand.between(600, 800));
  await hush();
  marks.end = now();

  /* Every product that was on camera has to be one checked before
     recording: the page itself noted each card that came into view. */
  const seen = await page.evaluate(() => (window.demoSeen ? window.demoSeen() : null));
  if (!seen) fail('The page did not report which products were on camera.');
  const vouched = new Set(api.saved.searches.flatMap((x) => x.verified || []));
  const unvouched = seen.filter((href) => !vouched.has(href));
  if (unvouched.length) {
    fail(`The ${shot.kind} recording showed ${unvouched.length} product(s) that were not checked before recording:\n  - ${unvouched.slice(0, 6).join('\n  - ')}`);
  }
  console.log(`  ${shot.kind}: ${seen.length} product(s) on camera, every one checked`);

  const mainVideo = stillsDir ? null : page.video();
  await context.close();
  await browser.close();

  if (process.env.DEMO_DEBUG) console.log(`  timeline: ${(marks.beats || []).join(' | ')}`);
  const kept = visits.filter((v) => v.kind === 'loaded');
  const skipped = visits.filter((v) => v.kind !== 'loaded');
  console.log(`  ${shot.kind}: ${api.saved.searches.length} search(es), opened ${kept.length} product(s): ${kept.map((v) => `${v.host} (loaded)`).join(', ') || 'none'}`);
  if (skipped.length) console.log(`  ${shot.kind}: skipped ${skipped.map((v) => `${v.host} (${v.kind}${v.reason ? `: ${v.reason}` : ''})`).join(', ')}`);
  if (kept.length < MIN_VISITS && !arg('allow-fewer')) {
    fail(`The ${shot.kind} recording reached only ${kept.length} retailer page(s); the demo needs at least ${MIN_VISITS}. Every retailer tried blocked or failed — see the skipped list above.`);
  }
  if (stillsDir) return { marks, visits };
  for (const v of visits) {
    v.file = v.kind === 'loaded' && v.video ? await v.video.path().catch(() => null) : null;
    delete v.video;
  }
  return { marks, cues, voice, visits, main: await mainVideo.path() };
}

/* ---------------------------------------------------------
   Putting it together: the cut, the narration, the encode
   --------------------------------------------------------- */

const run = (args) => execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

/* The one command that reads a duration. It goes to ffprobe and nowhere
   else: -show_entries is an ffprobe option, and ffmpeg given it fails
   with "Unrecognized option 'show_entries'". */
function probeCommand(file, entries, probe = FFPROBE) {
  if (/^ffmpeg(\.exe)?$/i.test(path.win32.basename(probe))) {
    throw new Error(`Durations are read with ffprobe, not ffmpeg (was asked to run ${probe}). Set FFPROBE_PATH to ffprobe.`);
  }
  return [probe, ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', file]];
}
const durationCommand = (file, probe = FFPROBE) => probeCommand(file, 'format=duration', probe);

/* the length check on its own, so it can be tested without a video */
function durationProblem(seconds) {
  if (!Number.isFinite(seconds)) return 'has no readable length';
  if (seconds < DURATION.min || seconds > DURATION.max) {
    return `runs ${seconds.toFixed(1)}s, outside the allowed ${DURATION.min}–${DURATION.max}s`
      + (seconds > DURATION.max ? ' (--no-refine leaves out the "$120" change, six or seven seconds)' : '');
  }
  return null;
}
function durationNote(seconds) {
  if (!Number.isFinite(seconds) || seconds < DURATION.min || seconds > DURATION.max) return null;
  if (seconds < DURATION.targetMin) return `runs ${seconds.toFixed(1)}s, under the usual ${DURATION.targetMin}–${DURATION.targetMax}s — was a search or a retailer visit left out?`;
  if (seconds > DURATION.targetMax) return `runs ${seconds.toFixed(1)}s, a little over the ${DURATION.targetMin}–${DURATION.targetMax}s target (kept: up to ${DURATION.max}s is allowed)`;
  return null;
}

/* a finished video is only kept if it really is one: picture at the
   expected size, a sound track, and a length in the expected range */
function checkVideo(file, width, height) {
  const [bin, args] = probeCommand(file, 'stream=codec_type,width,height');
  const rows = execFileSync(bin, args).toString().trim().split(/\r?\n/).map((r) => r.split(','));
  const video = rows.find((r) => r[0] === 'video');
  const audio = rows.find((r) => r[0] === 'audio');
  const seconds = lengthOf(file);
  const problems = [];
  if (!video) problems.push('no video stream');
  else if (Number(video[1]) !== width || Number(video[2]) !== height) problems.push(`video is ${video[1]}x${video[2]}, not ${width}x${height}`);
  if (!audio) problems.push('no audio stream');
  const long = durationProblem(seconds);
  if (long) problems.push(long);
  if (problems.length) throw new Error(`${path.basename(file)} is not a valid demo video: ${problems.join('; ')}`);
  const note = durationNote(seconds);
  if (note) console.log(`  warning: ${path.basename(file)} ${note}`);
}

function lengthOf(file) {
  const [bin, args] = durationCommand(file);
  const out = execFileSync(bin, args).toString();
  const seconds = Number(out.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe could not read a duration from ${file}`);
  return seconds;
}

/* The cut, worked out from the wall-clock marks of one recording.

   Fynd plays up to each click. A retailer tab that loaded is cut in from
   just before its page appears until it is closed, and Fynd resumes. A
   tab that was slow, a bot check, or a click that opened nothing shows
   no retailer at all: the seconds spent waiting on it are cut out, and
   Fynd simply carries on.

   marks    { start, end } on the Fynd page's clock, in seconds
   visits   [{ kind, click, pageAt, dom, closed, file }] on the same clock
   mainLen  the Fynd recording's real length (it runs behind the clock)
   popLen   (file) => a retailer recording's real length

   Returns the pieces to join, the finished length, and at(t): where a
   moment on the Fynd page's clock lands in the finished video. */
function planCut({ marks, visits, mainLen, popLen }) {
  const k = mainLen / marks.end;
  const v = (t) => t * k;
  const pieces = [];
  let cursor = marks.start;
  visits.forEach((vis, index) => {
    if (vis.kind === 'loaded' && vis.file && vis.pageAt != null && vis.dom != null) {
      pieces.push({ src: 'main', wallFrom: cursor, wallTo: vis.click + 0.25 });
      const len = popLen(vis.file);
      const wall = vis.closed - vis.pageAt;
      const kp = wall > 0 ? len / wall : 1;
      const from = Math.max(0, vis.dom - vis.pageAt - 0.25) * kp;
      const to = Math.min(len, wall * kp);
      if (to - from > 0.3) pieces.push({ src: vis.file, from, to, rate: kp, host: vis.host, visit: index });
      cursor = vis.closed + 0.05;
    } else {
      /* a skipped product is cut from where the hand set off for it, so
         the attempt is not in the video at all */
      pieces.push({ src: 'main', wallFrom: cursor, wallTo: vis.approach != null ? vis.approach : vis.click + 0.35 });
      cursor = vis.closed;
    }
  });
  pieces.push({ src: 'main', wallFrom: cursor, wallTo: marks.end });

  /* Each piece is played back at the pace it really happened: a
     recording that ran behind the clock (rate > 1) is brought back to
     real time, so the pointer, the typing and the voice keep together. */
  const segments = [];
  let out = 0;
  for (const piece of pieces) {
    const seg = piece.src === 'main' ? { ...piece, from: v(piece.wallFrom), to: v(piece.wallTo), rate: k } : { ...piece };
    if (seg.to - seg.from <= 0.02) continue;
    seg.outStart = out;
    seg.outLength = (seg.to - seg.from) / seg.rate;
    out += seg.outLength;
    segments.push(seg);
  }
  const total = out;
  const at = (t) => {
    for (const seg of segments) {
      if (seg.src !== 'main') continue;
      if (t < seg.wallFrom) return seg.outStart;          /* in a cut: where Fynd resumes */
      if (t <= seg.wallTo) return seg.outStart + (t - seg.wallFrom);
    }
    return total;
  };
  /* where a moment on a retailer tab lands: offset seconds into the piece
     that shows visit `index`, or null if that tab was not shown */
  const onVisit = (index, offset) => {
    const seg = segments.find((x) => x.visit === index);
    return seg ? seg.outStart + Math.min(offset, seg.outLength) : null;
  };
  return { segments, total, at, onVisit };
}

function build(shot, take, outDir) {
  const W = shot.width * shot.dpr;
  const H = shot.height * shot.dpr;
  const m = take.marks;

  /* The recorder runs a little behind the wall clock, so the wall-clock
     marks are scaled to each video's own length before they cut it. */
  const { segments, total, at, onVisit } = planCut({
    marks: m, visits: take.visits, mainLen: lengthOf(take.main), popLen: lengthOf
  });

  const files = [take.main];
  const inputFor = (src) => {
    const f = src === 'main' ? take.main : src;
    if (!files.includes(f)) files.push(f);
    return files.indexOf(f);
  };
  segments.forEach((seg) => { seg.input = inputFor(seg.src); });
  const inputs = files.flatMap((f) => ['-i', f]);
  /* every line, placed: against Fynd's clock, or against the retailer tab
     it was said on — a line whose tab was not shown is not placed at all */
  const placeOf = (x) => (x.visit != null ? onVisit(x.visit, x.offset || 0) : at(x.start));
  take.voice = take.voice.filter((line) => placeOf(line) != null);
  const voiceInputs = take.voice.map((line) => path.join(NARRATION, NARRATION_LINES[line.key].file));
  voiceInputs.forEach((f) => inputs.push('-i', f));
  const firstVoice = files.length;

  /* the closing card and the music bed */
  const cardInput = inputs.length / 2;
  inputs.push('-loop', '1', '-framerate', '30', '-t', String(END_SECONDS), '-i', take.card);
  const musicInput = cardInput + 1;
  inputs.push('-i', MUSIC);
  const fadeAt = total - END_FADE;
  const length = total + END_SECONDS - END_FADE;

  const vf = segments.map((s, i) => `[${s.input}:v]trim=start=${s.from.toFixed(3)}:end=${s.to.toFixed(3)},setpts=(PTS-STARTPTS)/${s.rate.toFixed(5)},`
    + `fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:white,setsar=1[s${i}]`).join(';');
  const concat = `${segments.map((_, i) => `[s${i}]`).join('')}concat=n=${segments.length}:v=1:a=0,format=yuv420p,settb=1/30[rec]`;
  /* Fynd's results dissolve into the closing card */
  const card = `[${cardInput}:v]scale=${W}:${H},fps=30,setsar=1,format=yuv420p,settb=1/30[card];`
    + `[rec][card]xfade=transition=fade:duration=${END_FADE}:offset=${fadeAt.toFixed(3)}[v]`;
  /* The voice, each line where it was said, in the middle of a stereo
     field (each side at -3 dB, so a -18 LUFS line stays -18). The music
     under it, trimmed to the film, in softly and faded out with the card,
     and ducked under the voice by the voice itself: a sidechain
     compressor pulls it down about 6–8 dB while anyone is speaking and
     lets it back up gently afterwards. */
  const af = take.voice.map((line, i) => `[${firstVoice + i}:a]pan=stereo|c0=0.7071*c0|c1=0.7071*c0,adelay=${Math.round(placeOf(line) * 1000)}:all=1[a${i}]`).join(';');
  const voiceBus = take.voice.length
    ? `${af};${take.voice.map((_, i) => `[a${i}]`).join('')}amix=inputs=${take.voice.length}:normalize=0,apad,atrim=end=${length.toFixed(3)},asplit=2[vox][key]`
    : `anullsrc=r=48000:cl=stereo,atrim=end=${length.toFixed(3)},asplit=2[vox][key]`;
  const music = `[${musicInput}:a]aresample=48000,atrim=end=${length.toFixed(3)},afade=t=in:d=1.2,`
    + `afade=t=out:st=${(length - 3).toFixed(3)}:d=3[bed];[bed][key]sidechaincompress=threshold=0.03:ratio=5:attack=25:release=450:knee=4[ducked]`;
  const mix = `;${voiceBus};${music};[vox][ducked]amix=inputs=2:normalize=0[a]`;

  const master = path.join(os.tmpdir(), `${shot.name}-master.mkv`);
  run([...inputs, '-filter_complex', `${vf};${concat};${card}${mix}`, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', master]);
  /* the music must never compete with the voice: measured on the mix */
  checkMix(master, take.voice.map((line) => [placeOf(line), placeOf(line) + NARRATION_LINES[line.key].duration]), length);

  const mp4 = path.join(outDir, `${shot.name}.mp4`);
  const webm = path.join(outDir, `${shot.name}.webm`);
  const poster = path.join(outDir, `${shot.name}-poster.jpg`);
  console.log(`  encoding ${shot.name}.mp4…`);
  run(['-i', master, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow', '-crf', String(shot.h264),
    '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', mp4]);
  console.log(`  encoding ${shot.name}.webm…`);
  run(['-i', master, '-c:v', 'libvpx-vp9', '-crf', String(shot.vp9), '-b:v', '0', '-row-mt', '1',
    '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '96k', '-ac', '2', webm]);
  /* the poster: the real results, a moment after they arrive */
  run(['-ss', (at([].concat(m.results)[0]) + 1.2).toFixed(3), '-i', master, '-frames:v', '1', '-q:v', '3', poster]);
  fs.unlinkSync(master);

  const cues = take.cues.map((c) => {
    if (c.visit == null) return { ...c, start: at(c.start), end: Math.min(total, at(c.end)) };
    const start = onVisit(c.visit, c.offset || 0);
    return start == null ? null : { ...c, start, end: Math.min(total, start + c.length) };
  }).filter(Boolean);
  cues.push({ text: END_LINE, start: fadeAt + END_FADE, end: length });
  writeTrack(path.join(outDir, `${shot.name}.vtt`), cues, length);
  for (const f of [mp4, webm]) checkVideo(f, W, H);
  const size = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`  ${shot.name}: ${length.toFixed(1)}s — mp4 ${size(mp4)}, webm ${size(webm)}, poster ${size(poster)}`);
  return length;
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
  /* one thought at a time: a cue never runs into the next one */
  const sorted = [...cues].sort((a, b) => a.start - b.start)
    .map((c, i, all) => ({ ...c, end: i + 1 < all.length ? Math.min(c.end, all[i + 1].start - 0.05) : c.end }));
  const body = sorted.map(({ text, start, end }, i) => `${i + 1}\n${clock(start)} --> ${clock(end)} line:8%\n${text}`).join('\n\n');
  fs.writeFileSync(file, `WEBVTT\n\n${body}\n`);
}

/* The voice over the music, measured on the finished mix: every line at
   about -18 LUFS and at least MIX.margin LU over the music on its own
   (the longest stretch where nobody speaks, before the closing fade). A
   mix where the music competes with the voice is refused. */
const MIX = { voice: -18, voiceRange: 3, margin: 8 };
function loudness(file, from, length) {
  const out = require('child_process').spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-ss', from.toFixed(3), '-t', length.toFixed(3), '-i', file,
    '-vn', '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const all = [...out.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
  return all.length ? Number(all[all.length - 1][1]) : NaN;
}
function quietestGap(spans, length) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let best = null;
  let from = 1.5;   /* after the music has come in */
  for (const [a, b] of sorted.concat([[length - 3.5, length]])) {
    const gap = [from + 0.6, a - 0.4];
    if (gap[1] - gap[0] > (best ? best[1] - best[0] : 0.8)) best = gap;
    from = Math.max(from, b);
  }
  return best;
}
function checkMix(file, spans, length) {
  const gap = quietestGap(spans, length);
  const problems = [];
  const music = gap ? loudness(file, gap[0], gap[1] - gap[0]) : NaN;
  for (const [a, b] of spans) {
    const voice = loudness(file, a, b - a);
    if (Math.abs(voice - MIX.voice) > MIX.voiceRange) problems.push(`a line at ${a.toFixed(1)}s is ${voice.toFixed(1)} LUFS, not about ${MIX.voice}`);
    if (Number.isFinite(music) && voice - music < MIX.margin) problems.push(`the music is within ${(voice - music).toFixed(1)} LU of the line at ${a.toFixed(1)}s`);
  }
  if (problems.length) throw new Error(`The mix is not right:\n  - ${problems.join('\n  - ')}`);
  console.log(`  mix: voice about ${MIX.voice} LUFS, music alone ${Number.isFinite(music) ? music.toFixed(1) : 'n/a'} LUFS — every line at least ${MIX.margin} LU over it`);
}

/* The closing card: the line and the Fynd mark, in the site's own type
   and the site's own mark (its stylesheet and font), on white. It is the
   film's, not the page's — a card, not a page dressed up. */
async function endCard(chromium, shot, dir) {
  const browser = await chromium.launch({ executablePath: chromePath() });
  const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: shot.dpr });
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'load' });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="${ORIGIN}/assets/styles.css">
    <style>html,body{margin:0;height:100%;background:#fff}
      .end{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${shot.touch ? 22 : 26}px;text-align:center;padding:0 24px}
      .end p{margin:0;font-family:Inter,-apple-system,sans-serif;font-weight:700;color:#111;letter-spacing:-.03em;line-height:1.12;font-size:${shot.touch ? 30 : 40}px}
      .end .brand{transform:scale(${shot.touch ? 1.25 : 1.35});pointer-events:none}</style></head>
    <body><div class="end"><p>${END_LINE.replace('. ', '.<br>')}</p>
    <span class="brand"><span class="brand-mark">F</span><span class="brand-word">Fynd</span></span></div></body></html>`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(dir, `${shot.name}-end.png`);
  await page.screenshot({ path: file });
  await browser.close();
  return file;
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
  const queries = saved.searches.map((x) => x.query.replace(/"/g, ''));
  const said = queries.length > 1 ? `${queries.slice(0, -1).join(', ')} and then ${queries[queries.length - 1]}` : queries[0];
  const label = `aria-label="Screen recording of Fynd: searches for ${said} are typed into the search box in plain words; real products come back for each, with their photos, prices and retailers, and some are opened at their retailers."`;
  const next = html.replace(/<!-- demo-note -->[\s\S]*?<!-- \/demo-note -->/, note)
    .replace(/aria-label="Screen recording of Fynd:[^"]*"/, label);
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

async function main() {
  const hadEnv = loadEnv();
  FFMPEG = findFfmpeg();
  FFPROBE = ffprobeFor(FFMPEG);
  /* the real-photo test decodes with the same ffmpeg */
  if (!process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = FFMPEG;
  /* in-memory metering only: never production KV */
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']
    .forEach((k) => { delete process.env[k]; });

  if (!NARRATION_LINES) fail('assets/demo/narration/manifest.json is missing. Run scripts/demo-narration.py.');
  const needed = [...new Set(SEARCHES.flatMap((x) => [...(x.lines.opening || []), x.lines.typing, x.lines.before, x.lines.results]).filter(Boolean).concat('retailer'))];
  const missingLines = needed.filter((k) => !NARRATION_LINES[k]);
  if (missingLines.length) fail(`The narration has no ${missingLines.join(', ')} line. Run scripts/demo-narration.py.`);
  if (!STILLS && !fs.existsSync(MUSIC)) fail(`The music bed is missing (${path.relative(REPO, MUSIC)}). Make it with fynd-demo/scripts/music.py --bars=27.`);
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
      api.saved = asSearches(JSON.parse(fs.readFileSync(file, 'utf8')));
      /* searches the plan leaves out this time (--no-refine) are not recorded */
      api.saved.searches = api.saved.searches.filter((x) => SEARCHES.some((y) => y.slot === x.slot));
      console.log(`Replaying the real searches of ${api.saved.searchedAt}: ${api.saved.searches.map((x) => `"${x.query}" (${x.shown.length})`).join(', ')}`);
      /* retailers change their minds: a saved search without checks, or
         --recheck, asks them again before recording */
      /* every product that may be on camera is checked again: listings
         change, and a saved search is only as good as it is today */
      const kept = [];
      for (const x of api.saved.searches) {
        const problems = await vouch(chromium, x, kept);
        if (problems.length) fail(`The saved search "${x.query}" no longer passes:\n  - ${problems.join('\n  - ')}\nRun without --replay for fresh results.`);
        kept.push(x);
      }
      if (!arg('no-check') && (arg('recheck') || api.saved.searches.some((x) => slotOf(x.slot).open && !x.shown.some((y) => y.check)))) {
        console.log('Checking which retailers answer…');
        const knownBad = new Set();
        for (const x of api.saved.searches) {
          if (!slotOf(x.slot).open) continue;
          x.shown.forEach((y) => { delete y.check; });
          await checkRetailers(chromium, x, knownBad);
        }
        if (file === SEARCH_FILE) fs.writeFileSync(SEARCH_FILE, `${JSON.stringify(api.saved, null, 2)}\n`);
      }
    } else {
      console.log(`Searching for real${hadEnv ? ` with ${hadEnv}` : ''}…`);
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
      const take = await record(chromium, shot, rawDir, stillsDir);
      take.card = await endCard(chromium, shot, stillsDir || rawDir);
      takes.push([shot, take]);
    }
    server.close();

    if (STILLS) {
      console.log(`Stills in ${stillsDir}`);
      return;
    }

    const lengths = {};
    for (const [shot, take] of takes) lengths[shot.name] = build(shot, take, stage);

    /* what each recording opened, for the record */
    const report = {
      searchedAt: api.saved.searchedAt,
      searches: api.saved.searches.map((x) => ({
        query: x.query,
        products: x.shown.length,
        retailers: [...new Set(x.shown.map((p2) => hostOf(p2.href)).filter(Boolean))]
      })),
      recordings: takes.map(([shot, take]) => ({
        file: `${shot.name}.mp4`,
        seconds: Number(lengths[shot.name].toFixed(1)),
        opened: take.visits.filter((vis) => vis.kind === 'loaded').map((vis) => ({ search: vis.search, product: vis.product, retailer: vis.host, url: vis.url })),
        skipped: take.visits.filter((vis) => vis.kind !== 'loaded').map((vis) => ({ search: vis.search, product: vis.product, retailer: vis.host, outcome: vis.kind, reason: vis.reason || null }))
      }))
    };
    fs.writeFileSync(path.join(stage, 'demo-recording.json'), `${JSON.stringify(report, null, 2)}\n`);

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

module.exports = { ffprobeFor, durationCommand, planCut, SEARCHES, DURATION, durationProblem, durationNote, quietestGap, MIN_VISITS, ON_CAMERA };

