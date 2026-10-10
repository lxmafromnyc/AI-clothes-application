#!/usr/bin/env node
/* =========================================================
   Fynd — records the demo video on the Search page

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
     node scripts/record-demo.js --env=FILE read FILE instead of .env.local / .env

   Every run ends with a report — for each search, the request typed,
   whether it needed a retry or an equivalent wording, and the product
   and retailer opened in each recording — printed and written to
   demo-report.json beside the videos.

   Needs:
     - Playwright with Chromium (npx playwright install chromium)
     - ffmpeg with libx264, libvpx-vp9, aac and libopus
     - network access to your product source, OpenAI, and the retailers'
       image hosts and pages — the same access a visitor's browser has
     - .env.local or .env with PRODUCT_SOURCE and that source's key; OPENAI_API_KEY for
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
     demo-search.json                     the real searches both were made from,
                                          with every attempt each one took
     demo-report.json                     what happened: attempts, products opened, lengths

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
const demoAudio = require('./demo-audio');
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

/* The page the film is recorded on and shown on: the Search page, where
   the search box is. It was the home page until the fit guide took the
   home page's first screen. The note under the video is written here. */
const DEMO_PAGE = 'find-clothes.html';

/* The searches, in the order they are made: four different shopping
   problems — an everyday piece, another category altogether, a specific
   thing that is a chore to track down across shops, and a particular
   style and colour. `line` is the narration said while it is typed.

   How each slot gets a real answer, in order:

     1. its request, exactly as written;
     2. the same request again, once or twice after a short pause, but
        only when it came up short because the product source was
        unsteady — offer lookups aborted or failed, the search out of
        time — never because the products were not there;
     3. its `equivalents`: the same shopping intent in other words ("a
        black oversized pullover hoodie" for "a black oversized hoodie"),
        each given the same retries. These exist only to get round a
        provider having a bad minute; the narration stays as it is;
     4. then, for the later slots only, an `alternative` — a different
        piece that is the same kind of problem — with its own retries.

   Every attempt is held to every check; nothing is relaxed along the
   way. `mention` is a brand the request names: a request for a brand is
   only used when at least MIN_PRODUCTS of its results are that brand,
   and only one of those is clicked — a search for BAPE that comes back
   with other people's shark hoodies is not shown. The first slot has no
   alternative because its narration names its request. */
const SEARCHES = [
  { slot: 'everyday', line: 'looking', candidates: [
    { query: 'black oversized hoodie under $80', equivalents: [
      'black oversized pullover hoodie under $80',
      'black oversized hooded sweatshirt under $80',
      'black baggy hoodie under $80'
    ] }
  ] },
  { slot: 'category', line: 'different', candidates: [
    { query: 'lightweight jacket for fall under $150', equivalents: [
      'lightweight fall jacket under $150',
      'light jacket for fall under $150'
    ] }
  ] },
  { slot: 'hard-to-find', line: 'specific', candidates: [
    { query: 'BAPE shark hoodie under $400', mention: 'bape|bathing ape', equivalents: [
      'A Bathing Ape shark hoodie under $400',
      'BAPE shark full zip hoodie under $400'
    ] },
    { query: "Levi's 501 '90s jeans in light wash under $100", mention: 'levi' },
    { query: 'Ralph Lauren cable knit sweater in cream under $200', mention: 'ralph lauren|polo' }
  ] },
  { slot: 'particular', line: 'particular', candidates: [
    { query: 'sage green linen midi dress under $120', equivalents: [
      'linen midi dress in sage green under $120',
      'sage linen midi dress under $120'
    ] },
    { query: 'black satin slip dress under $100' },
    { query: 'vintage Burberry trench coat under $500', mention: 'burberry' }
  ] }
];

/* Every request a slot may make, in the order it makes them. */
function requestsFor(slot) {
  return slot.candidates.flatMap((c, i) => {
    const kind = i === 0 ? 'exact' : 'alternative';
    return [{ query: c.query, mention: c.mention || null, kind, of: c.query },
      ...(c.equivalents || []).map((q) => ({ query: q, mention: c.mention || null, kind: 'equivalent', of: c.query }))];
  });
}

/* the pauses before the second and third try of one request */
const RETRY_DELAYS_MS = [3000, 7000];
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
/* how much of that hold the video shows: the page is still checked at
   the end of the whole hold, after the video has moved on, so nothing
   shown can be a page that failed */
const RETAILER_SHOWN_MS = 1800;

/* The one test a retailer page is held to, off camera and on alike: it
   arrives within RETAILER_LOAD_MS, is itself RETAILER_SETTLE_MS later,
   and is still itself after being held for RETAILER_MS. A check looser
   than the camera's lets through a page the camera then cannot show. */
const RETAILER_LOAD_MS = 6000;
const RETAILER_SETTLE_MS = 250;

/* how many products one search may try to hand off on camera before
   the recording gives up and writes nothing */
const MAX_HANDOFFS = 3;

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

/* The env files are read the way the deployment would read its
   variables: each KEY=value line, without overriding anything already in
   the environment. --env=FILE names one; otherwise .env.local, then .env,
   so a value in .env.local wins. Values are never printed; the names of
   the files read are. */
function loadEnv(only = arg('env')) {
  const files = typeof only === 'string' ? [path.resolve(only)] : ['.env.local', '.env'].map((f) => path.join(REPO, f));
  if (typeof only === 'string' && !fs.existsSync(files[0])) fail(`No env file at ${only}.`);
  const read = [];
  for (const file of files.filter((f) => fs.existsSync(f))) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let value = m[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
    read.push(path.relative(REPO, file) || file);
  }
  return read;
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
async function checkResults(page, { settle = true } = {}) {
  return page.evaluate(async (waitForPhotos) => {
    const deadline = waitForPhotos ? Date.now() + 25000 : 0;
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
  }, settle);
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





/* ---------------------------------------------------------
   Nothing about a retailer page may wait for ever

   A page can stall any step: a navigation that never finishes, a page
   whose script keeps its main thread busy so nothing can be read from
   it, a tab that will not open or close. Each step is given its own hard
   limit, each whole check another, and a whole run of checks a third;
   whatever runs out is a failed retailer, left out, and the run goes on
   to the next. The limits are the camera's own, not looser.
   --------------------------------------------------------- */

const LIMITS = {
  load: RETAILER_LOAD_MS,      /* the page must arrive within this */
  settle: RETAILER_SETTLE_MS,  /* then be itself this soon after */
  hold: RETAILER_MS,           /* and still be itself after this */
  step: 2500,                  /* any one read of the page, or opening or closing a tab */
  check: 12000                 /* one whole check, from navigation to the read after the hold */
};

/* `promise`, or a rejection once `ms` have passed, whichever comes first.
   The rejection carries timedOut so a caller can say which it was. */
function withDeadline(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} did not finish within ${(ms / 1000).toFixed(1)}s`);
      err.timedOut = true;
      reject(err);
    }, ms);
  });
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}

/* closing a stuck tab can itself get stuck; it is asked, not waited on */
const closeQuietly = (target, ms = LIMITS.step) => withDeadline(
  Promise.resolve().then(() => target.close({ runBeforeUnload: false })), ms, 'closing').catch(() => {});

/* Whether an open tab is the retailer's page, and not a block page, an
   error or a blank: the same test on the first pass, in the preflight
   and on camera. A read that does not come back in time reads as
   nothing, which fails. */
/* A bot check, a block or a challenge, by its title or by what it says
   at the top of the page. Walmart's reads "Robot or human? … Press &
   Hold" under a plain title and has enough footer text not to look
   blank, which is how one reached a recording: the words matter as much
   as the title. Returns the words that gave it away, or ''. */
const CHALLENGE_TITLE = /access denied|forbidden|captcha|just a moment|attention required|are you a robot|robot or human|are you (a )?human|human verification|verify(ing)? (you are|you're|that you are) (a )?human|security check|pardon our interruption|request unsuccessful|request blocked|blocked|bot detect|please wait|checking your browser|one more step/i;
const CHALLENGE_TEXT = /robot or human|are you a robot|are you (a )?human|press (&|and) hold|verify (you are|you're|that you are) (a )?human|confirm (you are|you're|that you are) (a )?human|human verification|complete the security check|checking (if the site connection is secure|your browser)|unusual (traffic|activity) from your|enable (javascript|js) and cookies to continue|pardon our interruption|access to this page has been denied|request (un)?successful\. incapsula|why have i been blocked|you have been blocked|cf-chl|px-captcha|g-recaptcha/i;

function challengeIn(title, text) {
  const t = CHALLENGE_TITLE.exec(title || '');
  if (t) return title.slice(0, 40);
  const b = CHALLENGE_TEXT.exec(text || '');
  return b ? b[0] : '';
}

async function retailerShows(tab, status, limits = LIMITS) {
  let stalled = false;
  const read = (fn, fallback) => withDeadline(Promise.resolve().then(fn), limits.step, 'reading the page')
    .catch((err) => { if (err && err.timedOut) stalled = true; return fallback; });
  const code = status || await read(() => tab.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return nav && nav.responseStatus ? nav.responseStatus : 200;
  }), 0);
  const title = await read(() => tab.title(), '');
  /* the page's visible words: how many, and the first few hundred, where
     a challenge says what it is */
  const body = await read(() => tab.evaluate(() => {
    const words = (document.body && document.body.innerText) || '';
    return { length: words.length, head: words.slice(0, 1500) };
  }), { length: 0, head: '' });
  const url = await read(() => tab.url(), '');
  const challenge = challengeIn(title, body.head);
  const ok = !stalled && code > 0 && code < 400 && !challenge && body.length > 200 && /^https?:/.test(url);
  const why = ok ? '' : stalled ? `the page stopped responding (a read took over ${limits.step / 1000}s)`
    : challenge ? `blocked ("${challenge}")` : code >= 400 ? `HTTP ${code}` : body.length <= 200 ? 'blank page' : 'no page';
  return { ok, why, timedOut: stalled };
}

/* Opens a retailer page — `href` in this tab, or whatever the tab is
   already loading when the link opened it — and puts it through the one
   test. Returns { ok, why, timedOut, shownAt } with shownAt the moment it
   arrived (Date.now()), so the camera can start showing it from there.
   Always returns, within limits.check. */
async function visitRetailer(tab, href, limits = LIMITS) {
  const run = async () => {
    let status = 0;
    try {
      if (href) {
        const response = await withDeadline(tab.goto(href, { waitUntil: 'domcontentloaded', timeout: limits.load }), limits.load + limits.step, 'navigation');
        status = response ? response.status() : 0;
      } else {
        await withDeadline(tab.waitForLoadState('domcontentloaded', { timeout: limits.load }), limits.load + limits.step, 'the page appearing');
      }
    } catch (err) {
      return { ok: false, why: `did not arrive within ${limits.load / 1000}s`, timedOut: true, shownAt: 0 };
    }
    const shownAt = Date.now();
    await wait(limits.settle);
    const first = await retailerShows(tab, status, limits);
    if (!first.ok) return { ...first, shownAt };
    await wait(Math.max(0, limits.hold - (Date.now() - shownAt)));
    const held = await retailerShows(tab, status, limits);
    if (!held.ok) return { ok: false, why: `${held.why} once held`, timedOut: held.timedOut, shownAt };
    return { ok: true, why: '', timedOut: false, shownAt };
  };
  try {
    return await withDeadline(run(), limits.check, 'the retailer check');
  } catch (err) {
    return err && err.timedOut
      ? { ok: false, why: `timed out after ${limits.check / 1000}s`, timedOut: true, shownAt: 0 }
      : { ok: false, why: 'did not load', timedOut: false, shownAt: 0 };
  }
}

/* Opens each product's retailer page, as a click on camera would, three
   at a time, and notes which ones show themselves. Only those are ever
   clicked. Every product gets an answer — a tab that would not open, a
   check that ran out of time, or the whole run running out of time all
   count as failed — and the function always returns. `log` hears each
   one by number: "3/16: checking …", "3/16: timed out — excluded". */
async function probeRetailers(context, products, { limit = PROBE_PRODUCTS, limits = LIMITS, log = null } = {}) {
  const out = {};
  const list = products.slice(0, limit);
  const total = list.length;
  const say = (i, text) => { if (log) log(`${i + 1}/${total}: ${text}`); };
  let next = 0;
  let stopped = false;

  const worker = async () => {
    while (!stopped && next < total) {
      const i = next;
      next += 1;
      const { href } = list[i];
      const where = hostOf(href) || href;
      say(i, `checking ${where}`);
      let tab = null;
      let result;
      try {
        tab = await withDeadline(context.newPage(), limits.step, 'opening a tab');
        result = await visitRetailer(tab, href, limits);
      } catch (err) {
        result = { ok: false, why: 'a tab could not be opened in time', timedOut: true };
      }
      if (tab) await closeQuietly(tab, limits.step);
      if (stopped) return;
      out[href] = result;
      say(i, result.ok ? `passed — ${where}` : `${result.timedOut ? 'timed out' : 'failed'} — excluded: ${where} (${result.why})`);
    }
  };

  /* the whole run: as long as its checks could take one after another
     three abreast, and not a moment more */
  const cap = Math.ceil(total / 3) * (limits.check + 2 * limits.step) + limits.step;
  await withDeadline(Promise.all([worker(), worker(), worker()]), cap, 'the retailer checks').catch(() => { stopped = true; });
  list.forEach(({ href }, i) => {
    if (out[href]) return;
    out[href] = { ok: false, why: 'the checks ran out of time', timedOut: true };
    say(i, `timed out — excluded: ${hostOf(href) || href} (the checks ran out of time)`);
  });
  return out;
}

/* Right before a recording: every product the first pass saw open is
   opened again, in a tab shaped like the recording's own (a phone's for
   the phone layout), because a page that opened an hour ago, or for a
   desktop browser, may not open now on this one. Off camera, and never
   for longer than its checks are allowed. */
async function preflightRetailers(browser, shot, searches, limits = LIMITS) {
  const hrefs = [...new Set(searches.flatMap((s) => s.shown.filter((p) => p.retailerOk === true).map((p) => p.href)))];
  const log = (line) => console.log(`  ${shot.kind} preflight ${line}`);
  let context;
  try {
    context = await withDeadline(browser.newContext({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: shot.dpr, isMobile: shot.touch, hasTouch: shot.touch
    }), limits.check, 'opening the preflight browser');
  } catch (err) {
    log(`could not start (${err.message}); every retailer is excluded`);
    return Object.fromEntries(hrefs.map((href) => [href, { ok: false, why: 'the preflight could not start', timedOut: true }]));
  }
  try {
    return await probeRetailers(context, hrefs.map((href) => ({ href })), { limit: Infinity, limits, log });
  } finally {
    await closeQuietly(context, limits.check);
  }
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

/* May this card be the one clicked on camera? Seen to open in the first
   pass, seen to open again in the preflight just before filming, and at
   a shop that has not already failed to show its page on camera. */
const handoffAllowed = (card, verified, preflight, failedHosts) => verified.get(card.href) === true
  && Boolean(preflight[card.href] && preflight[card.href].ok)
  && !failedHosts.has(hostOf(card.href));

/* shops whose page did not show on camera, kept across both recordings
   of one run, so a shop known to fail is never clicked again */
const failedHosts = new Set();

const pickedOf = (c) => ({ brand: c.brand, name: c.name, price: c.price, retailer: hostOf(c.href), href: c.href });

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

/* Whether a search came up short because the product source was having
   a bad moment rather than because the products were not there: what
   the search endpoint's own diagnostics say about its offer and seller
   lookups and its time budget. Returns the reason in words, or ''. */
function instability(search, outcome) {
  if (outcome === 'timeout') return 'the search did not answer within 45 s';
  if (!search) return '';
  if ([500, 502, 503, 504].includes(search.status)) return `the product source failed (HTTP ${search.status})`;
  const d = (search.response && search.response.diagnostics) || {};
  const reasons = [];
  for (const [name, t] of [['offer', d.offers], ['seller', d.sellers]]) {
    if (!t || typeof t !== 'object') continue;
    if (Number(t.lookupsFailed) > 0) reasons.push(`${t.lookupsFailed} ${name} lookup(s) aborted or failed`);
    if (t.budgetExpired) reasons.push(`the ${name} lookups ran out of time`);
    if (t.halted) reasons.push(`the ${name} lookups were halted (${t.halted})`);
  }
  if (d.timing && d.timing.deadlineExpired && !reasons.length) reasons.push('the search ran out of time');
  return reasons.join('; ');
}

/* One request, made the way a visitor makes it, and everything about its
   answer that decides whether it can be shown. */
async function searchOnce(browser, request) {
  api.mode = 'live';
  api.exchanges = {};
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(pagePrep, ORIGIN);
    await page.goto(`${ORIGIN}/${DEMO_PAGE}`, { waitUntil: 'load' });
    await page.fill('#ask', request.query);
    await page.click('#ask-form button[type=submit]');

    const outcome = await Promise.race([
      page.waitForSelector('#results .grid .item-card', { timeout: 45000 }).then(() => 'cards'),
      page.waitForSelector('#results .empty', { timeout: 45000 }).then(() => 'empty')
    ]).catch(() => 'timeout');

    const search = api.exchanges.search;
    const unsteady = instability(search, outcome);
    if (!search) return { verified: 0, unsteady, problems: ['the page never reached /api/search'] };
    if (search.status !== 200 || outcome !== 'cards') {
      const why = search.response && (search.response.error || search.response.notice || search.response.state);
      return { verified: 0, unsteady, problems: [`the real search did not return products (HTTP ${search.status}${why ? `: ${why}` : ''})`] };
    }

    const found = await checkResults(page);
    const opened = verdict(found).length ? {} : await probeRetailers(context, found, {
      log: (line) => { if (!/: checking |: passed — /.test(line)) console.log(`    retailer ${line}`); }
    });
    found.forEach((p) => { p.retailerOk = Boolean(opened[p.href] && opened[p.href].ok); p.retailerWhy = opened[p.href] ? opened[p.href].why : 'not opened'; });
    return { found, search, interpret: api.exchanges.interpret || null, verified: found.length, unsteady, problems: fitness(found, request) };
  } finally {
    await closeQuietly(context, LIMITS.check);
  }
}

/* A slot's requests, each tried — and tried again only when the source
   was unsteady — until one passes every check. Returns the one that
   passed, and every attempt along the way. */
async function searchSlot(browser, store, slot) {
  const attempts = [];
  /* a new slot starts from nothing; a later attempt at the same slot
     forgets the cached searches (or it would be handed the same short
     page back) and the usage counters, and keeps the offers the
     provider really answered, so its time goes on the ones it did not */
  store.reset();
  let fresh = true;
  for (const request of requestsFor(slot)) {
    for (let n = 0; n <= RETRY_DELAYS_MS.length; n += 1) {
      if (n > 0) await wait(RETRY_DELAYS_MS[n - 1]);
      if (!fresh) store.forget((key) => key.includes(':search:') || key.startsWith('usage:'));
      fresh = false;
      const label = n === 0 ? request.kind : `${request.kind}, try ${n + 1}`;
      console.log(`  "${request.query}" (${label})`);
      const result = await searchOnce(browser, request);
      attempts.push({
        query: request.query, kind: request.kind, of: request.of, try: n + 1,
        verified: result.verified, passed: !result.problems.length,
        ...(result.unsteady ? { unsteady: result.unsteady } : {}),
        ...(result.problems.length ? { problems: result.problems } : {})
      });
      if (!result.problems.length) return { request, attempts, ...result };
      console.log(`    not used:\n      - ${result.problems.join('\n      - ')}`);
      if (!result.unsteady) break;
      console.log(`    the product source was unsteady: ${result.unsteady}`);
      if (n < RETRY_DELAYS_MS.length) console.log(`    trying the same request again in ${RETRY_DELAYS_MS[n] / 1000}s`);
    }
  }
  return { request: null, attempts };
}

/* In a few words, what it took to get a slot's answer. */
function howFound(attempts) {
  const passed = attempts.find((a) => a.passed);
  if (!passed) return 'no request passed';
  const before = attempts.slice(0, attempts.indexOf(passed));
  const retries = attempts.filter((a) => a.try > 1 && attempts.indexOf(a) <= attempts.indexOf(passed)).length;
  if (!before.length) return 'passed first time';
  const parts = [];
  if (retries) parts.push(`${retries} retr${retries === 1 ? 'y' : 'ies'} after an unsteady product source`);
  if (passed.kind === 'equivalent') parts.push(`an equivalent wording, "${passed.query}", in place of "${passed.of}"`);
  if (passed.kind === 'alternative') parts.push(`the alternative request "${passed.query}"`);
  return `needed ${parts.join(' and ') || 'another attempt'}`;
}

async function realSearches(chromium) {
  const store = checkSetup();
  const browser = await chromium.launch({ executablePath: chromePath() });
  const searches = [];
  try {
    for (const slot of SEARCHES) {
      const chosen = await searchSlot(browser, store, slot);
      if (!chosen.request) {
        fail(`No request for the "${slot.slot}" search came back fit to record. Tried:\n${chosen.attempts.map((a) => `  "${a.query}" (${a.kind}, try ${a.try}): ${a.verified} verified${a.unsteady ? `; unsteady source: ${a.unsteady}` : ''}\n    - ${(a.problems || []).join('\n    - ')}`).join('\n')}\nNothing was lowered to make it pass. Try again later, or add another request to that slot in SEARCHES.`);
      }
      const { request, attempts, found, search, interpret } = chosen;
      const hosts = new Set(found.map((f) => hostOf(f.href)).filter(Boolean));
      console.log(`    used: ${found.length} real products from ${hosts.size} retailer(s); every photo loaded; ${found.filter((f) => f.retailerOk).length} retailer page(s) opened — ${howFound(attempts)}`);
      searches.push({
        slot: slot.slot,
        line: slot.line,
        intended: slot.candidates[0].query,
        query: request.query,
        kind: request.kind,
        mention: request.mention,
        howFound: howFound(attempts),
        attempts,
        interpret: interpret ? { ...interpret } : null,
        search,
        shown: found.map(({ name, brand, price, retailer, href, src, width, height, retailerOk, retailerWhy }) => ({
          name, brand, price, retailer, href, photo: src, width, height, retailerOk, ...(retailerOk ? {} : { retailerWhy })
        }))
      });
    }
  } finally {
    await withDeadline(browser.close(), 30000, 'closing the browser').catch(() => {});
  }
  return {
    version: 3,
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
  await warm.goto(`${ORIGIN}/${DEMO_PAGE}`, { waitUntil: 'load' });
  /* a photo host that never answers costs this step, not the run: the
     photos are checked again, loaded, on camera */
  await withDeadline(warm.evaluate((urls) => Promise.all(urls.map((u) => new Promise((r) => {
    const img = new Image(); img.referrerPolicy = 'no-referrer';
    img.onload = img.onerror = r; img.src = u;
  }))), photos), 30000, 'fetching the photos').catch(() => {});
  await closeQuietly(warm);

  /* every candidate retailer page, opened again now, off camera */
  console.log(`  ${shot.name}: checking the retailer pages before filming (each one at most ${LIMITS.check / 1000}s)…`);
  const preflight = await preflightRetailers(browser, shot, api.saved.searches);
  const refused = Object.entries(preflight).filter(([, r]) => !r.ok);
  console.log(`  ${shot.name}: ${Object.keys(preflight).length - refused.length} of ${Object.keys(preflight).length} retailer pages showed themselves`
    + (refused.length ? `; left out: ${[...refused.reduce((m, [href, r]) => {
      const k = `${hostOf(href)} (${r.why})`; return m.set(k, (m.get(k) || 0) + 1);
    }, new Map())].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)).join(', ')}` : ''));

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
  /* which product each search opened, the ones whose page did not show
     on camera and were cut, and the ones the preflight left out */
  const picks = [];
  const retakes = [];
  const leftOut = [];
  let stillN = 0;

  const still = async (label, target = page) => {
    if (!stillsDir) return;
    stillN += 1;
    await withDeadline(target.screenshot({ path: path.join(stillsDir, `${shot.name}-${String(stillN).padStart(2, '0')}-${label}.png`) }), LIMITS.check, 'a still').catch(() => {});
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

  await page.goto(`${ORIGIN}/${DEMO_PAGE}`, { waitUntil: 'load' });
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
    await wait(300);
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
    marks[`typing${n}`] = now();
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
    /* The check that every product on camera is real and every photo
       loaded runs while the results are looked at and the retailer's
       page is open, rather than holding the camera on a still page: it
       is answered below, off camera, and a failure stops the run with
       nothing written, exactly as before. */
    const proof = checkResults(page).catch((err) => ({ error: err }));
    const onScreen = await checkResults(page, { settle: false });
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

    /* Only a product whose retailer page was seen to open in the first
       pass AND again in the preflight just now, at a shop that has not
       failed on camera in this run, of the brand asked for; at a shop
       not yet shown if there is one, within the budget, and already on
       screen if possible. If its page still does not show when it is
       clicked, the click is cut from the video and the next one is
       taken: the video never shows a click that goes nowhere. */
    const verified = new Map(s.shown.map((p) => [p.href, p.retailerOk === true]));
    for (const p of onScreen) {
      if (verified.get(p.href) && preflight[p.href] && !preflight[p.href].ok) {
        leftOut.push({ search: n + 1, ...pickedOf(p), why: preflight[p.href].why });
      }
    }
    /* on screen: its photo, which is what is pressed, wholly in view
       above the caption strip */
    const inView = async () => new Set(await page.evaluate((limit) => [...document.querySelectorAll('#results .grid .item-card')]
      .map((c, i) => ({ i, r: (c.querySelector('.item-media') || c).getBoundingClientRect() }))
      .filter(({ r }) => r.top >= 60 && r.bottom <= limit - 12).map(({ i }) => i), viewH));

    let handed = false;
    for (let attempt = 1; !handed; attempt += 1) {
      const cards = onScreen.map((p) => ({ ...p, retailerOk: handoffAllowed(p, verified, preflight, failedHosts) }));
      const pick = pickProduct(cards, { used, mention: mentionOf(s), budget: budgetOf(s.query), visible: await inView() });
      if (pick < 0 || attempt > MAX_HANDOFFS) {
        fail(`No product in "${s.query}" reached its retailer page on camera (${shot.name}). Tried: ${retakes.filter((r) => r.search === n + 1).map((r) => `${r.retailer} (${r.why})`).join(', ') || 'none left after the preflight'}. Nothing is recorded with a click that goes nowhere.`);
      }
      const aimFrom = now();
      const voiceMark = voice.length;
      const cueMark = cues.length;

      const card = `#results .grid .item-card:nth-child(${pick + 1})`;
      if (!(await inView()).has(pick)) {
        const r = await page.locator(`${card} .item-media`).boundingBox();
        await scrollBy(Math.max(80, r.y + r.height - viewH + 60));
        await wait(rand.between(150, 250));
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
        await wait(rand.between(500, 650));
      } else {
        await moveTo(cardSpot);
        await wait(rand.between(150, 260));
      }
      await still(`${tag}-chosen${attempt > 1 ? `-${attempt}` : ''}`);

      const chosen = cards[pick];
      const popupPromise = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
      const clickedAt = now();
      if (shot.touch) await tap(cardSpot);
      else await click();
      const popup = await popupPromise;
      await hush();

      /* The retailer's own page, in the new tab the link opens — the real
         page at the real address, put through the same test as the
         preflight and held for a moment once it has arrived. The wait
         for it to arrive is not shown. */
      let result = { ok: false, why: 'the link opened no new tab' };
      let born = clickedAt;
      let video = null;
      if (popup) {
        born = now();
        result = await visitRetailer(popup, null);
        if (stillsDir && result.ok) await still(`${tag}-retailer`, popup);
        video = stillsDir ? null : popup.video();
      }
      const gone = now();
      const landed = popup ? popup.url() : null;
      if (popup) await closeQuietly(popup);
      await page.bringToFront();

      if (result.ok) {
        cut.push({ src: 'main', from: segFrom, to: clickedAt + 0.25 });
        const arrived = (result.shownAt - pageBorn) / 1000;
        cut.push({ src: 'tab', tab: tabs.length, search: n, born, gone, from: Math.max(born, arrived - 0.15), to: Math.min(gone, arrived + RETAILER_SHOWN_MS / 1000) });
        tabs.push(video);
        used.add(hostOf(landed) || hostOf(chosen.href));
        picks.push({ search: n + 1, query: s.query, ...pickedOf(chosen), opened: landed, shown: true, attempt });
        handed = true;
      } else {
        /* cut from the moment the hand set off for it; the line said on
           the way is said again on the next one */
        cut.push({ src: 'main', from: segFrom, to: aimFrom });
        voice.splice(voiceMark);
        cues.splice(cueMark);
        failedHosts.add(hostOf(chosen.href));
        retakes.push({ search: n + 1, ...pickedOf(chosen), why: result.why });
        console.log(`  ${shot.name}: ${hostOf(chosen.href)} did not show its page on camera (${result.why}); that click is cut, and another product is taken`);
        await wait(250);
        segFrom = now();
      }
    }

    /* --- the photo check's answer, off camera ------------------------- */

    const waitedFrom = Date.now();
    const proved = await proof;
    if (proved.error) fail(`On camera, the results for "${s.query}" could not be checked: ${proved.error.message}`);
    const problems = verdict(proved);
    if (process.env.DEMO_DEBUG) console.log(`  ${shot.name} search ${n + 1}: the photo check answered ${Date.now() - waitedFrom}ms after the retailer's page`);
    if (problems.length) fail(`On camera, the results for "${s.query}" were not all real and loaded:\n  - ${problems.join('\n  - ')}`);

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
  /* closing the context is what finishes writing the videos: given
     its time, but not for ever */
  await withDeadline(context.close(), 60000, 'finishing the recording').catch((err) => fail(`${shot.name}: ${err.message}.`));
  await withDeadline(browser.close(), 30000, 'closing the browser').catch(() => {});

  if (process.env.DEMO_DEBUG) {
    console.log('  marks', JSON.stringify(Object.fromEntries(Object.entries(marks).map(([k, t]) => [k, Number(t.toFixed(2))]))));
    console.log('  cut', cut.map((c) => `${c.src} ${(c.to - c.from).toFixed(2)}s`).join(', '));
  }
  if (stillsDir) return { marks, picks, retakes, leftOut };
  return {
    marks, cues, voice, cut, picks, retakes, leftOut,
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
    /* the tab's video runs from `born` to `gone`; the piece shown may
       end before it does */
    const tabWall = Math.max(0.01, (c.gone || c.to) - c.born);
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

/* What happened when, in the finished video: where each line is said,
   and when each search was typed, made, answered and opened at its
   retailer. The score is written to this (scripts/demo-audio.js), and it
   is saved beside the video so the sound can be made again without
   recording again. */
function timelineOf(shot, take, total, pieces, at) {
  const searches = [];
  for (let n = 0; take.marks[`searched${n}`] !== undefined; n += 1) {
    let offset = 0;
    let retailer = null;
    for (const piece of pieces) {
      const len = piece.end - piece.start;
      if (piece.src === 'tab' && piece.search === n) retailer = [offset, offset + len];
      offset += len;
    }
    searches.push({
      typing: Number(at(take.marks[`typing${n}`] !== undefined ? take.marks[`typing${n}`] : take.marks.start).toFixed(3)),
      searched: Number(at(take.marks[`searched${n}`]).toFixed(3)),
      results: Number(at(take.marks[`results${n}`]).toFixed(3)),
      retailer: retailer && retailer.map((t) => Number(t.toFixed(3)))
    });
  }
  return {
    video: shot.name,
    duration: Number(total.toFixed(3)),
    source: 'Written by scripts/record-demo.js as it made the recording.',
    lines: take.voice.map((line) => ({ key: line.key, at: Number(at(line.start).toFixed(3)) })),
    searches
  };
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

  const vf = pieces.map((s, i) => `[${s.input}:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS,`
    + `fps=30,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:white,setsar=1[s${i}]`).join(';');
  const concat = `${pieces.map((_, i) => `[s${i}]`).join('')}concat=n=${pieces.length}:v=1:a=0[v]`;

  const master = path.join(os.tmpdir(), `${shot.name}-master.mkv`);
  run([...inputs, '-filter_complex', `${vf};${concat}`, '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'yuv420p', master]);

  /* the sound: the narration and its score, mixed to the timeline of
     this very cut (scripts/demo-audio.js) */
  const timeline = timelineOf(shot, take, total, pieces, at);
  fs.writeFileSync(path.join(outDir, `${shot.name}.timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);
  const sound = path.join(os.tmpdir(), `${shot.name}-sound.wav`);
  console.log(`  composing and mixing the sound for ${shot.name}…`);
  const mixed = demoAudio.renderTo(timeline, sound);
  console.log(`  sound: voice ${mixed.voiceLufs} LUFS, ${mixed.lufs} LUFS integrated, true peak ${mixed.truePeakDbtp} dBTP`);

  const mp4 = path.join(outDir, `${shot.name}.mp4`);
  const webm = path.join(outDir, `${shot.name}.webm`);
  const poster = path.join(outDir, `${shot.name}-poster.jpg`);
  console.log(`  encoding ${shot.name}.mp4…`);
  run(['-i', master, '-i', sound, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow', '-crf', String(shot.h264),
    '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', mp4]);
  console.log(`  encoding ${shot.name}.webm…`);
  run(['-i', master, '-i', sound, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libvpx-vp9', '-crf', String(shot.vp9), '-b:v', '0', '-row-mt', '1',
    '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', webm]);
  /* the poster: the first search's real results, a moment after they arrive */
  run(['-ss', (at(take.marks.results0) + 1.2).toFixed(3), '-i', master, '-frames:v', '1', '-q:v', '3', poster]);
  fs.unlinkSync(master);
  fs.unlinkSync(sound);

  /* the captions, from where each line is actually spoken in the mix */
  fs.writeFileSync(path.join(outDir, `${shot.name}.vtt`), mixed.captions);
  const size = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`  ${shot.name}: ${total.toFixed(1)}s — mp4 ${size(mp4)}, webm ${size(webm)}, poster ${size(poster)}`);
  if (total < TARGET.min || total > TARGET.max) {
    console.log(`  note: ${shot.name} is ${total.toFixed(1)}s, outside the ${TARGET.min}–${TARGET.max}s it is meant to be`);
  }
  return total;
}

/* The note under the video says what it is: real searches, which ones,
   and when they were made, because prices and stock move on after a
   recording. The video's own label says the same for anyone not seeing
   it. Only the text between the markers, and those two labels, are
   replaced in DEMO_PAGE. */
const attr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const listed = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/* DEMO_PAGE's markup with the note and the labels describing `saved`; null when
   the note's markers are missing. The new text goes in through replacer
   functions, never replacement strings: the requests carry prices, and
   "$150" in a replacement string would be read as "$1" and "50". */
function pageWithDemo(html, saved) {
  const when = new Date(saved.searchedAt);
  const date = Number.isNaN(when.getTime()) ? 'recently'
    : when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const queries = saved.searches.map((s) => s.query);
  const count = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'][queries.length] || String(queries.length);
  const note = `<!-- demo-note -->
          <span class="status status--live">Real search</span>
          ${count} real searches, recorded on Fynd on ${date}. Prices and availability may have changed since. Turn the sound on for the narration.
          <!-- /demo-note -->`;
  const markers = /<!-- demo-note -->[\s\S]*?<!-- \/demo-note -->/;
  if (!markers.test(html)) return null;
  const label = `A film of a real Fynd session: ${count.toLowerCase()} different requests are typed into the search box in turn — ${listed(queries.map((q) => `“${q}”`))}. Each time, real products come back with their photos, prices and retailers, and one of them is opened on its retailer’s own page.`;
  return html
    .replace(markers, () => note)
    .replace(/(<video class="demo-video" id="demo-video"[^>]*?aria-label=")[^"]*(")/, (m, open, close) => `${open}${attr(label)}${close}`)
    .replace(/(<section class="section section--flush demo" id="demo" aria-label=")[^"]*(")/, (m, open, close) => `${open}Demo: ${count.toLowerCase()} real searches, start to finish${close}`);
}

function describeOnPage(saved) {
  const file = path.join(REPO, DEMO_PAGE);
  const next = pageWithDemo(fs.readFileSync(file, 'utf8'), saved);
  if (next === null) {
    console.log(`  note: the demo-note markers were not found in ${DEMO_PAGE}; update the note under the video by hand`);
    return;
  }
  fs.writeFileSync(file, next);
  console.log(`  updated the note and the video's label in ${DEMO_PAGE}`);
}

/* ---------------------------------------------------------
   The run
   --------------------------------------------------------- */

/* What happened, search by search: what was meant, what was typed,
   every attempt it took, and what each recording opened. */
function recordingReport(saved, takes, lengths) {
  return {
    searchedAt: saved.searchedAt,
    productSource: saved.productSource || null,
    searches: saved.searches.map((s, i) => ({
      search: i + 1,
      slot: s.slot,
      intended: s.intended || s.query,
      typed: s.query,
      kind: s.kind || 'exact',
      howFound: s.howFound || (s.attempts ? howFound(s.attempts) : 'passed first time'),
      attempts: s.attempts || [],
      products: s.shown.length,
      retailers: [...new Set(s.shown.map((p) => hostOf(p.href)).filter(Boolean))],
      opened: Object.fromEntries(takes.map(([shot, take]) => [shot.kind, (take.picks || []).find((p) => p.search === i + 1) || null])),
      /* clicked on camera, page did not show, click cut from the video */
      cut: Object.fromEntries(takes.map(([shot, take]) => [shot.kind, (take.retakes || []).filter((p) => p.search === i + 1)])),
      /* passed the first pass, failed the preflight just before filming */
      leftOut: Object.fromEntries(takes.map(([shot, take]) => [shot.kind, (take.leftOut || []).filter((p) => p.search === i + 1)]))
    })),
    everyHandoffShown: takes.every(([, take]) => (take.picks || []).length === saved.searches.length
      && take.picks.every((p) => p.shown)),
    seconds: Object.fromEntries(Object.entries(lengths).map(([k, v]) => [k, Number(v.toFixed(1))]))
  };
}

function printReport(r) {
  console.log('\nRecording report');
  for (const s of r.searches) {
    console.log(`  ${s.search}. ${s.slot}: "${s.typed}"${s.typed !== s.intended ? ` (meant: "${s.intended}")` : ''}`);
    console.log(`     ${s.howFound}; ${s.products} products from ${s.retailers.length} retailer(s)`);
    for (const a of s.attempts.filter((x) => !x.passed)) {
      console.log(`     - "${a.query}" (${a.kind}, try ${a.try}): ${a.verified} verified${a.unsteady ? `; unsteady: ${a.unsteady}` : ''}`);
    }
    for (const [kind, p] of Object.entries(s.opened)) {
      console.log(`     ${kind}: ${p ? `${p.brand ? `${p.brand} — ` : ''}${p.name}, ${p.price}, at ${p.retailer}${p.shown ? ' — retailer page shown on camera' : ' — RETAILER PAGE NOT SHOWN'}` : 'nothing opened'}`);
      for (const x of (s.leftOut && s.leftOut[kind]) || []) console.log(`       left out before filming: ${x.retailer} — ${x.name} (${x.why})`);
      for (const x of (s.cut && s.cut[kind]) || []) console.log(`       click cut, page did not show on camera: ${x.retailer} — ${x.name} (${x.why})`);
    }
  }
  if (r.everyHandoffShown !== undefined) console.log(`  every click reached its retailer on camera: ${r.everyHandoffShown ? 'yes' : 'NO'}`);
  for (const [name, sec] of Object.entries(r.seconds)) console.log(`  ${name}: ${sec}s`);
}

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
    if (!requestsFor(SEARCHES[i]).some((c) => c.query === s.query)) return `holds "${s.query}", which is no longer one of the "${s.slot}" requests`;
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
      console.log(`Searching for real${hadEnv.length ? ` with ${hadEnv.join(' and ')}` : ''}:`);
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
      printReport(recordingReport(api.saved, takes, {}));
      console.log(`Stills in ${stillsDir}`);
      return;
    }

    const lengths = {};
    for (const [shot, take] of takes) lengths[shot.name] = build(shot, take, stage);
    const summary = recordingReport(api.saved, takes, lengths);
    fs.writeFileSync(path.join(stage, 'demo-report.json'), `${JSON.stringify(summary, null, 2)}\n`);
    printReport(summary);
    /* nothing is written unless every click in both videos reached its
       retailer's page on camera */
    if (!summary.everyHandoffShown) fail('Not every click in the videos reached its retailer page on camera.');

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

module.exports = { challengeIn, timelineOf, RETAILER_MS, RETAILER_SHOWN_MS, LIMITS, withDeadline, probeRetailers, preflightRetailers, retailerShows, handoffAllowed, visitRetailer, RETAILER_LOAD_MS, RETAILER_SETTLE_MS, MAX_HANDOFFS, ffprobeFor, durationCommand, SEARCHES, requestsFor, instability, howFound, recordingReport, RETRY_DELAYS_MS, loadEnv, MIN_PRODUCTS, verdict, fitness, pickProduct, budgetOf, priceOf, mentionOf, cutMap, savedProblem, narrationNeeded, pageWithDemo, DEMO_PAGE };

