#!/usr/bin/env node
/* =========================================================
   Fynd — records the landing page demo video

   Drives the real pages, in a real browser, through the real search
   flow: a request typed into the search card, the interpreter's
   read-back, product cards arriving from a source, and a click that
   leaves for the retailer. Nothing about the interface is mocked up for
   the camera — the only thing standing in is the product source, which
   answers here from a fixed set of records instead of a paid API, so the
   recording is identical every time it is made.

   Because those records are not live stock, the recording carries a
   badge saying so for its whole length. That is the rule the site
   already holds to for sample rows, applied to the video: anything the
   shopper cannot buy has to say it cannot be bought.

   Usage:
     node scripts/record-demo.js            record, then encode
     node scripts/record-demo.js --raw      record only, leave the WebM

   Needs Chromium for the recording and ffmpeg for the encode. Both are
   found from the environment; either missing is reported and skipped
   rather than failing the run, because neither is a dependency of the
   site itself.

     CHROME_PATH       chromium binary
     PLAYWRIGHT_PATH   the playwright module
     FFMPEG_PATH       ffmpeg binary

   Writes assets/demo/fynd-demo{,-mobile}.{mp4,webm}, a poster frame and
   a captions track for each. The files are committed: the site is
   static, so the video ships with it.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'assets', 'demo');
const PORT = 8917;

/* the frame. 16:10 holds the search card and the first row of results at
   once, which is the whole story the video has to tell. */
const WIDTH = 1280;
const HEIGHT = 800;

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const candidates = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    path.join(REPO, 'node_modules', 'ffmpeg-static', 'ffmpeg')
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

let chromium;
try {
  chromium = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright').chromium;
} catch (err) {
  console.log('Playwright is not available here — cannot record the demo.');
  process.exit(0);
}

/* ---------------------------------------------------------
   The garment artwork

   A product tile needs a photograph, and there is no photograph of a
   real listing this repository may carry. So the demo draws its own:
   flat-lay artwork in the same neutral tile the interface already uses
   for a product with no picture, one drawing per row. They read as
   product imagery without standing in for anybody's photograph.
   --------------------------------------------------------- */

const FABRIC = {
  black: { body: '#1E1E1E', hood: '#2E2E2E', trim: '#151515', seam: '#3A3A3A', cord: '#E8E8E4' },
  washed: { body: '#333331', hood: '#403F3C', trim: '#282826', seam: '#4E4D49', cord: '#E4E2DC' },
  charcoal: { body: '#26282B', hood: '#343739', trim: '#1D1F21', seam: '#43464A', cord: '#DFE1E3' },
  ink: { body: '#181B22', hood: '#262A33', trim: '#12141A', seam: '#343945', cord: '#E2E4E9' }
};

/* pullover and zip read differently enough at tile size to keep a grid
   of one garment from looking like one product repeated */
function hoodieArt(tone, cut) {
  const c = FABRIC[tone] || FABRIC.black;
  const front = cut === 'zip'
    ? `<path d="M240 196 L240 434" stroke="${c.seam}" stroke-width="4" stroke-linecap="round"/>
       <path d="M198 344 L232 344 M248 344 L292 344" stroke="${c.seam}" stroke-width="3.5" stroke-linecap="round"/>`
    : `<path d="M186 338 L294 338 L302 410 L178 410 Z" fill="none" stroke="${c.seam}" stroke-width="3.5" stroke-linejoin="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 600" width="480" height="600" role="img">
  <defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.14"/>
  </filter></defs>
  <rect width="480" height="600" fill="#F5F5F4"/>
  <ellipse cx="240" cy="486" rx="146" ry="15" fill="#000" opacity="0.06"/>
  <g filter="url(#s)">
    <path d="M168 148 C176 84 304 84 312 148 C312 190 282 214 240 214 C198 214 168 190 168 148 Z" fill="${c.hood}"/>
    <path d="M182 134 L96 178 L48 336 Q46 344 54 347 L118 370 Q126 373 129 365 L156 288
             L156 452 Q156 468 172 468 L308 468 Q324 468 324 452 L324 288
             L351 365 Q354 373 362 370 L426 347 Q434 344 432 336 L384 178 L298 134
             C286 170 194 170 182 134 Z" fill="${c.body}"/>
    <path d="M190 146 C198 100 282 100 290 146 C290 180 268 200 240 200 C212 200 190 180 190 146 Z" fill="${c.trim}"/>
    <path d="M182 134 L200 196 M298 134 L280 196" stroke="${c.seam}" stroke-width="3.5" fill="none" stroke-linecap="round"/>
    ${front}
    <path d="M48 336 L118 361 L108 396 L38 371 Z" fill="${c.trim}"/>
    <path d="M432 336 L362 361 L372 396 L442 371 Z" fill="${c.trim}"/>
    <path d="M156 434 L324 434 L324 452 Q324 468 308 468 L172 468 Q156 468 156 452 Z" fill="${c.trim}"/>
    <path d="M220 198 C218 224 217 240 217 258 M260 198 C262 224 263 240 263 258"
          stroke="${c.cord}" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  </g>
</svg>`;
}

/* ---------------------------------------------------------
   What the stand-in product source answers with

   Records in the shape api/_providers/product-source.js hands to the
   page, so the cards on screen are built by the real rendering code from
   fields in the real shape. Names describe the garment rather than
   quoting a listing, and every link goes to the retailer's own search
   for that garment — a page that exists, rather than a product id
   invented to look convincing.
   --------------------------------------------------------- */

const DEMO_PRODUCTS = [
  { id: 'd1', name: 'Oversized Heavyweight Fleece Hoodie', retailer: 'H&M', price: 34.99, tone: 'black', cut: 'pullover',
    productUrl: 'https://www2.hm.com/en_us/search-results.html?q=oversized%20black%20hoodie',
    colors: ['Black'], fits: ['Oversized'], styles: ['Streetwear'], sizes: ['S', 'M', 'L'] },
  { id: 'd2', name: 'Boxy Brushed-Back Hooded Sweatshirt', retailer: 'UNIQLO', price: 39.9, tone: 'charcoal', cut: 'pullover',
    productUrl: 'https://www.uniqlo.com/us/en/search?q=oversized%20black%20hoodie',
    colors: ['Black'], fits: ['Oversized'], styles: ['Minimal'], sizes: ['XS', 'S', 'M'] },
  { id: 'd3', name: 'Relaxed Cotton-Blend Zip Hoodie', retailer: 'GAP', price: 49.95, tone: 'ink', cut: 'zip',
    productUrl: 'https://www.gap.com/browse/search.do?searchText=black%20oversized%20hoodie',
    colors: ['Black'], fits: ['Relaxed'], styles: ['Classic'], sizes: ['S', 'M', 'L'] },
  { id: 'd4', name: 'Washed Black Drop-Shoulder Hoodie', retailer: 'ASOS', price: 45.0, tone: 'washed', cut: 'pullover',
    productUrl: 'https://www.asos.com/us/search/?q=black%20oversized%20hoodie',
    colors: ['Washed black'], fits: ['Oversized'], styles: ['Streetwear'], sizes: ['M', 'L', 'XL'] },
  { id: 'd5', name: 'Reverse Weave Pullover Hoodie', retailer: 'CHAMPION', price: 48.0, tone: 'black', cut: 'pullover',
    productUrl: 'https://www.champion.com/search?q=black%20hoodie',
    colors: ['Black'], fits: ['Regular'], styles: ['Sporty'], sizes: ['S', 'M', 'L'] },
  { id: 'd6', name: 'Loose Fit Hooded Sweatshirt', retailer: 'ZARA', price: 42.9, tone: 'charcoal', cut: 'zip',
    productUrl: 'https://www.zara.com/us/en/search?searchTerm=black%20hoodie',
    colors: ['Black'], fits: ['Loose'], styles: ['Minimal'], sizes: ['S', 'M'] },
  { id: 'd7', name: 'Garment-Dyed Oversized Hoodie', retailer: 'URBAN OUTFITTERS', price: 49.0, tone: 'washed', cut: 'pullover',
    productUrl: 'https://www.urbanoutfitters.com/search?q=black+oversized+hoodie',
    colors: ['Faded black'], fits: ['Oversized'], styles: ['Streetwear'], sizes: ['M', 'L'] },
  { id: 'd8', name: 'Everyday Fleece Hoodie', retailer: 'OLD NAVY', price: 29.99, tone: 'ink', cut: 'pullover',
    productUrl: 'https://oldnavy.gap.com/browse/search.do?searchText=black%20hoodie',
    colors: ['Black'], fits: ['Relaxed'], styles: ['Classic'], sizes: ['S', 'M', 'L', 'XL'] }
];

/* what the interpreter takes out of the sentence that gets typed */
const DEMO_INTENT = {
  categories: ['hoodie'],
  colors: ['Black'],
  fits: ['Oversized'],
  occasions: [],
  brands: [],
  styles: [],
  keywords: ['black', 'oversized', 'hoodie'],
  maxPrice: 50,
  minPrice: null,
  season: null,
  gender: null
};

const QUERY = 'black oversized hoodie under $50';

/* the source is slower than a local file, and the video should show the
   waiting state the shopper actually sees rather than an instant grid */
const INTERPRET_DELAY = 1100;
const SEARCH_DELAY = 1300;

/* ---------------------------------------------------------
   The origin everything is served from
   --------------------------------------------------------- */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.vtt': 'text/vtt'
};

/* ---------------------------------------------------------
   Inter, served locally

   The recording browser is cut off from everything except this origin,
   and a demo set in a different typeface than the site is a demo of
   something else. So the face is fetched once here, in Node, and served
   back at the address the page already asks for. Only the Latin subsets
   are kept: the recording has no other alphabet in it.

   If the fetch does not work — no network, or Google Fonts moved — the
   recording still happens in the stack the site itself falls back to,
   with a line saying so.
   --------------------------------------------------------- */

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fontFiles = new Map();

async function loadInter() {
  const css = await fetch(FONT_CSS, { headers: { 'User-Agent': CHROME_UA } }).then((r) => r.text());

  /* Google Fonts labels each block with the subset it covers, in a
     comment above it. Keeping the Latin ones drops about nine tenths of
     the bytes and loses nothing that appears on screen. */
  const blocks = [...css.matchAll(/\/\* ([\w-]+) \*\/\s*(@font-face\s*\{[^}]*\})/g)]
    .filter(([, subset]) => subset === 'latin' || subset === 'latin-ext');

  let out = '';
  for (const [, , face] of blocks) {
    const url = /url\((https:\/\/fonts\.gstatic\.com[^)]+)\)/.exec(face);
    if (!url) continue;
    const name = url[1].split('/').pop();
    if (!fontFiles.has(name)) {
      const bytes = await fetch(url[1], { headers: { 'User-Agent': CHROME_UA } })
        .then((r) => r.arrayBuffer());
      fontFiles.set(name, Buffer.from(bytes));
    }
    out += face.replace(url[1], `http://127.0.0.1:${PORT}/demo-fonts/${name}`) + '\n';
  }
  return out;
}

const json = (res, body, delay) => setTimeout(() => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}, delay || 0);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/interpret') {
    return json(res, { source: 'openai', query: QUERY, preferences: DEMO_INTENT }, INTERPRET_DELAY);
  }

  if (url.pathname === '/api/search') {
    const products = DEMO_PRODUCTS.map((p) => ({
      id: p.id, name: p.name, retailer: p.retailer, brand: p.retailer,
      price: p.price, currency: 'USD', productUrl: p.productUrl,
      imageUrl: `/demo-media/${p.id}.svg`,
      category: 'hoodie', colors: p.colors, fits: p.fits, styles: p.styles, sizes: p.sizes
    }));
    return json(res, { source: 'demo', products, returned: products.length, rejected: {} }, SEARCH_DELAY);
  }

  const font = /^\/demo-fonts\/(.+)$/.exec(url.pathname);
  if (font) {
    const bytes = fontFiles.get(font[1]);
    if (!bytes) { res.statusCode = 404; return res.end('no such face'); }
    res.setHeader('Content-Type', 'font/woff2');
    return res.end(bytes);
  }

  const media = /^\/demo-media\/(\w+)\.svg$/.exec(url.pathname);
  if (media) {
    const item = DEMO_PRODUCTS.find((p) => p.id === media[1]);
    if (!item) { res.statusCode = 404; return res.end('no such tile'); }
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.end(hoodieArt(item.tone, item.cut));
  }

  const file = path.join(REPO, url.pathname.replace(/^\/+/, ''));
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; return res.end('not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

/* ---------------------------------------------------------
   The layer that only exists for the camera

   A pointer, the step captions, and the badge that says what this
   recording is. It is injected into the page rather than composited
   afterwards so it moves with the interface at the same frame rate, and
   it is drawn from the site's own tokens so it belongs to the same
   design as everything under it.
   --------------------------------------------------------- */

const OVERLAY = (compact) => {
  const u = compact ? .74 : 1;   /* one frame is a third the width of the other */
  const css = `
    #demo-layer { position: fixed; inset: 0; z-index: 9999; pointer-events: none;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }

    #demo-cursor { position: absolute; top: 0; left: 0; width: ${26 * u}px; height: ${26 * u}px;
      margin: -3px 0 0 -3px; transform: translate(50vw, 90vh);
      transition: transform .62s cubic-bezier(.32,.72,.24,1); will-change: transform; }
    #demo-cursor svg { width: ${26 * u}px; height: ${26 * u}px; filter: drop-shadow(0 2px 5px rgba(0,0,0,.35)); }
    #demo-cursor::after { content: ''; position: absolute; inset: -9px; border-radius: 50%;
      background: var(--color-primary); opacity: 0; transform: scale(.4); }
    #demo-cursor.tap::after { animation: demo-tap .5s ease-out; }
    @keyframes demo-tap { 0% { opacity: .34; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.5); } }

    /* bottom right, clear of the site's own navigation, and on screen
       for the whole recording: what it says has to be true of every
       frame, not only of the frames somebody happens to pause on */
    /* in the narrow frame it goes up under the header instead, where
       the caption running the width of the screen cannot reach it */
    #demo-badge { position: absolute; right: ${compact ? 12 : 22}px;
      ${compact ? 'top: 74px' : 'bottom: 30px'};
      display: flex; align-items: center; gap: 9px;
      padding: ${10 * u}px ${16 * u}px; border-radius: 999px;
      background: var(--color-surface-invert); color: var(--color-text-invert);
      font-size: ${11 * u}px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase;
      opacity: 0; transition: opacity .5s ease; }
    #demo-badge.on { opacity: .93; }
    #demo-badge i { width: 7px; height: 7px; border-radius: 50%; background: var(--color-warning); }

    #demo-caption { position: absolute; left: ${compact ? 14 : 46}px; right: ${compact ? 14 : 'auto'};
      bottom: ${compact ? 22 : 30}px; transform: translate(0, 14px);
      display: flex; align-items: center; gap: ${12 * u}px;
      padding: ${13 * u}px ${22 * u}px ${13 * u}px ${16 * u}px; border-radius: 999px;
      background: var(--color-surface-invert); color: var(--color-text-invert);
      font-size: ${17 * u}px; font-weight: 600; letter-spacing: -.01em; line-height: 1.3;
      opacity: 0; transition: opacity .34s ease, transform .34s cubic-bezier(.2,.7,.2,1); }
    #demo-caption.on { opacity: .95; transform: translate(0, 0); }
    #demo-caption b { flex: none; display: grid; place-items: center;
      width: ${26 * u}px; height: ${26 * u}px; border-radius: 50%;
      background: var(--color-text-invert); color: var(--color-surface-invert);
      font-size: ${13 * u}px; font-weight: 700; }

    #demo-link { position: absolute; padding: ${11 * u}px ${18 * u}px; border-radius: 12px;
      background: var(--color-primary); color: #fff;
      font-size: ${15 * u}px; font-weight: 600; white-space: nowrap;
      box-shadow: 0 12px 30px -12px rgba(0,0,0,.55);
      opacity: 0; transform: translateY(8px); transition: opacity .28s ease, transform .28s ease; }
    #demo-link.on { opacity: 1; transform: translateY(0); }
    #demo-link small { display: block; font-size: ${12.5 * u}px; font-weight: 500; opacity: .8; margin-top: 2px; }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const layer = document.createElement('div');
  layer.id = 'demo-layer';
  layer.innerHTML = `
    <div id="demo-cursor"><svg viewBox="0 0 24 24" fill="#fff" stroke="#111" stroke-width="1.4"
      stroke-linejoin="round"><path d="M5 3l14 8.4-6.1 1.2-2.6 5.9z"/></svg></div>
    <div id="demo-badge"><i></i>Product demo · sample data</div>
    <div id="demo-caption"><b>1</b><span>caption</span></div>
    <div id="demo-link"></div>`;
  document.body.appendChild(layer);

  const cursor = layer.querySelector('#demo-cursor');
  const badge = layer.querySelector('#demo-badge');
  const caption = layer.querySelector('#demo-caption');
  const link = layer.querySelector('#demo-link');

  window.demo = {
    badge: (on) => badge.classList.toggle('on', on !== false),
    move: (x, y) => { cursor.style.transform = `translate(${x}px, ${y}px)`; },
    tap: () => { cursor.classList.remove('tap'); void cursor.offsetWidth; cursor.classList.add('tap'); },
    say: (n, text) => {
      caption.querySelector('b').textContent = n;
      caption.querySelector('span').textContent = text;
      caption.classList.add('on');
    },
    hush: () => caption.classList.remove('on'),
    /* the destination of the card that was clicked, shown where the
       click landed: the point of the product is that the link is real */
    linkAt: (x, y, host) => {
      link.innerHTML = `Opening ${host}<small>in a new tab</small>`;
      link.style.left = `${x}px`;
      link.style.top = `${y}px`;
      link.classList.add('on');
    },
    unlink: () => link.classList.remove('on')
  };

  /* Following the link would end the recording on somebody else's page,
     and this environment cannot reach one anyway. The click still
     happens, on the real anchor, with the real href — it is only the
     navigation that is held back. */
  document.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('a.item-card');
    if (!card) return;
    e.preventDefault();
    window.demo.__clicked = card.getAttribute('href');
  }, true);
};

/* ---------------------------------------------------------
   The recording itself
   --------------------------------------------------------- */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Two recordings, not one. The demo is a recording of an interface, and
   an interface shot for a 1280-wide window is unreadable on a phone —
   the type in it lands at about six pixels. So the same walkthrough is
   driven twice, once in each shape, and the page picks the one that fits
   the screen it is on.

   The narrow one is captured at two device pixels per CSS pixel so that
   a phone, which has at least that many, is not shown an upscale. */

/* h264 and vp9 are the quality settings for the two encodes. They are
   high — a screencast is mostly flat colour that barely moves, which is
   what these codecs are best at, and at 1:1 against the recording the
   type is still clean. They are also tuned per shape and per codec
   rather than by a formula, because the point is that the WebM the page
   offers first is never the bigger of the two files. */
const SHOTS = [
  { name: 'fynd-demo', width: 1280, height: 800, dpr: 1, compact: false, h264: 34, vp9: 42 },
  /* the narrow frame carries more pixels than the wide one once it is
     doubled, so it is compressed harder to land in the same place */
  { name: 'fynd-demo-mobile', width: 400, height: 720, dpr: 2, compact: true, h264: 37, vp9: 47 }
];

async function record(shot, interCss, raw) {
  /* The screencast a video is made from comes off the compositor at the
     browser's own scale, not the context's, so a narrow frame is
     captured at two device pixels per CSS pixel by launching for it.
     Without this the phone-shaped recording is 400 pixels wide and every
     phone has to double it. */
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: shot.dpr > 1 ? [`--force-device-scale-factor=${shot.dpr}`] : []
  });

  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: shot.dpr,
    reducedMotion: 'no-preference',
    recordVideo: { dir: raw, size: { width: shot.width * shot.dpr, height: shot.height * shot.dpr } }
  });

  const page = await context.newPage();

  /* The recording begins with the page, so every caption can be timed
     against that one clock and written out as a track afterwards. The
     captions are burned into the frame as well — they are part of how
     the video reads — but burned-in text is not text, and somebody
     reading captions rather than watching them needs the words. */
  const startedAt = Date.now();
  const cues = [];
  const say = async (n, text) => {
    if (cues.length) cues[cues.length - 1].end = (Date.now() - startedAt) / 1000;
    cues.push({ n, text, start: (Date.now() - startedAt) / 1000, end: null });
    await page.evaluate(([i, t]) => window.demo.say(i, t), [n, text]);
  };
  const hush = async () => {
    if (cues.length && cues[cues.length - 1].end === null) {
      cues[cues.length - 1].end = (Date.now() - startedAt) / 1000;
    }
    await page.evaluate(() => window.demo.hush());
  };

  await page.addInitScript(() => {
    window.FINDWEAR_API = `${location.origin}/api/interpret`;
    window.FINDWEAR_SEARCH_API = `${location.origin}/api/search`;
  });
  /* The page's own stylesheet link is answered from the cache above, so
     the recording is set in the face the site is set in. Everything else
     off this origin is unreachable here anyway, and cutting it keeps the
     recording identical from one run to the next. */
  await page.route((url) => !String(url).includes(`127.0.0.1:${PORT}`), (route) => {
    if (interCss && String(route.request().url()).startsWith('https://fonts.googleapis.com/css2')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: interCss });
    }
    return route.abort();
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ask-form');
  if (interCss) await page.evaluate(() => document.fonts.ready);
  await page.evaluate(OVERLAY, shot.compact);
  await wait(500);

  const box = async (selector) => {
    const b = await page.locator(selector).first().boundingBox();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, b } : null;
  };
  const point = async (selector) => {
    const p = await box(selector);
    await page.evaluate(([x, y]) => window.demo.move(x, y), [p.x, p.y]);
    await wait(680);
    return p;
  };
  const tap = async () => { await page.evaluate(() => window.demo.tap()); await wait(220); };
  /* a whole card, framed: its picture, its retailer, its price and the
     button out, all on screen at once, whichever shape the frame is */
  const centre = (n) => page.evaluate((i) => document.querySelectorAll('.grid .item-card')[i]
    .scrollIntoView({ behavior: 'smooth', block: 'center' }), n);
  /* scrolled in screenfuls rather than in pixels, so the same beat reads
     the same in a tall narrow frame as in a short wide one */
  const read = (screens) => page.evaluate((f) => window.scrollBy({
    top: window.innerHeight * f, behavior: 'smooth'
  }), screens);

  /* --- the request ------------------------------------------------ */

  await page.evaluate(() => window.demo.badge(true));
  await wait(700);
  await say(1, 'Say it the way you’d say it out loud');
  await wait(900);

  await point('#ask');
  await tap();
  await page.click('#ask');
  await page.type('#ask', QUERY, { delay: 62 });
  await wait(700);

  await point('#ask-form button[type=submit]');
  await tap();
  await hush();
  await page.click('#ask-form button[type=submit]');

  /* --- Fynd reads it ---------------------------------------------- */

  await wait(280);
  await say(2, 'Fynd reads it — colour, fit, garment, budget');
  await page.waitForSelector('.item-card', { timeout: 20000 });
  /* the read-back is the moment Fynd says what it understood, so it is
     given its own beat before the grid takes the frame */
  await wait(1900);

  /* --- what came back --------------------------------------------- */

  await say(3, 'Every piece comes back with its price and its retailer');
  await centre(0);
  await wait(2600);

  /* a slow read down the grid, the way somebody actually looks at it */
  await read(0.5);
  await wait(2200);
  await read(0.4);
  await wait(1800);

  /* --- and out to the retailer ------------------------------------ */

  await centre(1);
  await wait(1200);
  await say(4, 'One click and you’re at the retailer');
  await wait(500);

  const action = await point('.grid .item-card:nth-child(2) .item-action');
  await page.hover('.grid .item-card:nth-child(2)');
  await wait(1000);
  await tap();
  await page.click('.grid .item-card:nth-child(2) .item-action');

  const href = await page.evaluate(() => window.demo.__clicked || '');
  const host = href ? new URL(href).host.replace(/^www\d?\./, '') : 'the retailer';
  /* under the button it belongs to, and pinned inside the frame: in the
     narrow shape the button is nearly as wide as the screen */
  const chip = await page.evaluate(([x, y, h]) => {
    window.demo.linkAt(x, y, h);
    return null;
  }, [
    Math.max(12, Math.min(action.b.x + action.b.width - 34, shot.width - 210)),
    action.b.y + action.b.height + 14,
    host
  ]);
  void chip;
  await wait(2600);

  await hush();
  await page.evaluate(() => window.demo.unlink());
  await wait(900);

  const video = page.video();
  const length = (Date.now() - startedAt) / 1000;
  await context.close();
  await browser.close();

  const source = await video.path();
  console.log(`  ${shot.name}: ${length.toFixed(1)}s, ${(fs.statSync(source).size / 1e6).toFixed(2)} MB`);

  return { source, cues, length };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-demo-'));

  await new Promise((r) => server.listen(PORT, r));

  let interCss = '';
  try {
    interCss = await loadInter();
    console.log(`Inter: ${fontFiles.size} files cached for the recording`);
  } catch (err) {
    console.log('Inter could not be fetched — recording in the fallback stack.');
  }

  console.log('recording…');
  const takes = [];
  try {
    for (const shot of SHOTS) takes.push([shot, await record(shot, interCss, raw)]);
  } catch (err) {
    server.close();
    if (/executable|launch|ENOENT/i.test(String(err && err.message))) {
      console.log('Chromium could not launch here — cannot record the demo.');
      process.exit(0);
    }
    throw err;
  }

  server.close();

  for (const [shot, take] of takes) {
    writeTrack(shot.name, take.cues, take.length);

    if (process.argv.includes('--raw')) {
      const kept = path.join(OUT, `${shot.name}.source.webm`);
      fs.copyFileSync(take.source, kept);
      console.log(`kept the raw recording at ${path.relative(REPO, kept)}`);
      continue;
    }

    /* the poster is the frame the section shows before anything plays,
       so it is taken from the moment the grid is framed whole rather
       than from the first frame, which is an empty search box */
    const still = take.cues.length > 2 ? take.cues[2].start + 2.4 : 14;
    encode(shot, take.source, still);
  }
})().catch((err) => { console.error(err); process.exit(1); });

/* ---------------------------------------------------------
   The captions track

   The same four lines the frame carries, as text, timed against the
   recording that just happened rather than against a guess. They are
   placed at the top of the frame so that turning them on does not stack
   them over the ones drawn into it.
   --------------------------------------------------------- */

function writeTrack(name, cues, length) {
  const clock = (s) => {
    const t = Math.max(0, s);
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
    return `00:${mm}:${ss}.${ms}`;
  };

  const body = cues.map(({ n, text, start, end }) =>
    `${n}\n${clock(start)} --> ${clock(end == null ? length : end)} line:8%\n${text}`).join('\n\n');

  const file = path.join(OUT, `${name}.vtt`);
  fs.writeFileSync(file, `WEBVTT\n\n${body}\n`);
  console.log(`wrote ${path.relative(REPO, file)} (${cues.length} cues)`);
}

/* ---------------------------------------------------------
   The encode

   Two codecs per shape, because neither one alone reaches every
   browser. H.264 is the format nobody has to be asked about — except
   that it is patent-encumbered, so a Chromium built without proprietary
   codecs, which is what most Linux distributions ship and what this
   repository's own test browser is, cannot play it at all. VP9 covers
   those and is the smaller file besides; Safari takes the H.264. The
   page lists the WebM first, so the browsers that can take the smaller
   file do.
   --------------------------------------------------------- */

function encode(shot, source, still) {
  const name = shot.name;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.log('\nffmpeg was not found, so nothing was encoded.');
    console.log('Set FFMPEG_PATH, or `npm i ffmpeg-static`, and run again.');
    return;
  }

  const run = (args) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  const mp4 = path.join(OUT, `${name}.mp4`);
  const webm = path.join(OUT, `${name}.webm`);
  const poster = path.join(OUT, `${name}-poster.jpg`);

  /* Kept at the size it was recorded at: each shape is already the
     smallest frame its half of the breakpoint does not have to scale up,
     and interface type is the first thing a resize costs. -an because
     the demo is silent — there is no soundtrack to carry, and even a
     muted track costs bytes. +faststart so the file can start playing
     before it has finished arriving. */

  console.log(`encoding ${name}.mp4…`);
  run(['-i', source, '-an', '-c:v', 'libx264', '-profile:v', 'high',
    '-preset', 'veryslow', '-crf', String(shot.h264), '-pix_fmt', 'yuv420p', '-g', '50',
    '-movflags', '+faststart', mp4]);

  console.log(`encoding ${name}.webm…`);
  run(['-i', source, '-an', '-c:v', 'libvpx-vp9', '-crf', String(shot.vp9), '-b:v', '0',
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-pix_fmt', 'yuv420p', webm]);

  run(['-ss', String(still), '-i', source, '-frames:v', '1', '-q:v', '5', poster]);

  const size = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`  ${path.relative(REPO, mp4)}  ${size(mp4)}`);
  console.log(`  ${path.relative(REPO, webm)}  ${size(webm)}`);
  console.log(`  ${path.relative(REPO, poster)}  ${size(poster)}`);
}
