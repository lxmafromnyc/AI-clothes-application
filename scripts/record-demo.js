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
   flat-lay artwork on a white ground, one drawing per row. The card
   lays a photo onto its own warm tile, so the white takes the tile's
   tone exactly as a retailer's packshot does. They read as
   product imagery without standing in for anybody's photograph.
   --------------------------------------------------------- */

const FABRIC = {
  black:    { body: '#222223', light: '#3A3A3C', dark: '#0E0E0F', rib: '#1A1A1B', cord: '#ECEAE4', tip: '#9A9A98' },
  washed:   { body: '#3A3937', light: '#56544F', dark: '#22211F', rib: '#302F2D', cord: '#E6E3DB', tip: '#A09D96' },
  charcoal: { body: '#3B3E42', light: '#565A5F', dark: '#23252A', rib: '#33363A', cord: '#E3E5E8', tip: '#9EA1A5' },
  ink:      { body: '#1C1F27', light: '#343947', dark: '#0C0E13', rib: '#171A21', cord: '#E4E6EB', tip: '#9A9DA4' }
};

/* A flat-lay packshot, drawn: the garment laid on white under soft top
   light, with the cloth's grain, its folds, ribbed cuffs and hem, and
   metal-tipped cords. */
function hoodieArt(tone, cut) {
  const c = FABRIC[tone] || FABRIC.black;
  const id = `${tone}-${cut}`;
  /* the left half, mirrored: a dropped shoulder, a long sleeve laid
     along the body, and the gap between them below the arm */
  const half = [[186, 132], [128, 150], [104, 160], [96, 186], [60, 418], [110, 432], [148, 238], [152, 462]];
  const mirror = (pts) => pts.map(([x, y]) => [480 - x, y]).reverse();
  const pts = [...half, [164, 474], [316, 474], ...mirror(half)];
  const BODY = 'M' + pts.map(([x, y]) => `${x} ${y}`).join(' L') + ' C282 168 198 168 186 132 Z';
  const HOOD = 'M166 150 C170 80 310 80 314 150 C316 196 284 222 240 222 C196 222 164 196 166 150 Z';
  const front = cut === 'zip'
    ? `<path d="M240 204 L240 440" stroke="${c.dark}" stroke-width="7" stroke-linecap="round"/>
       <path d="M240 204 L240 440" stroke="${c.tip}" stroke-width="2" stroke-dasharray="2 3" opacity=".75"/>
       <rect x="234" y="206" width="12" height="20" rx="2" fill="${c.tip}"/>
       <path d="M196 340 Q208 346 226 344 M254 344 Q272 346 284 340" stroke="${c.dark}" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>`
    : `<path d="M184 336 L296 336 L306 414 L174 414 Z" fill="url(#pk-${id})" stroke="${c.dark}" stroke-width="2.5" stroke-linejoin="round" opacity=".95"/>
       <path d="M184 336 L174 414 M296 336 L306 414" stroke="${c.light}" stroke-width="1.2" opacity=".5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 640" width="480" height="640" role="img">
  <defs>
    <linearGradient id="side-${id}" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${c.dark}"/><stop offset=".3" stop-color="${c.body}"/>
      <stop offset=".46" stop-color="${c.light}"/><stop offset=".7" stop-color="${c.body}"/>
      <stop offset="1" stop-color="${c.dark}"/>
    </linearGradient>
    <linearGradient id="top-${id}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity=".22"/>
    </linearGradient>
    <linearGradient id="pk-${id}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${c.light}"/><stop offset="1" stop-color="${c.body}"/>
    </linearGradient>
    <radialGradient id="in-${id}" cx=".5" cy=".38" r=".62">
      <stop offset="0" stop-color="#000" stop-opacity=".95"/><stop offset="1" stop-color="${c.dark}"/>
    </radialGradient>
    <pattern id="rib-${id}" width="5" height="10" patternUnits="userSpaceOnUse">
      <rect width="5" height="10" fill="${c.rib}"/><rect width="1.6" height="10" fill="${c.light}" opacity=".35"/>
    </pattern>
    <filter id="grain-${id}" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="4"/>
      <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .09 0"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="soft-${id}"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="drop-${id}" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="12" stdDeviation="13" flood-color="#000" flood-opacity=".18"/>
    </filter>
    <clipPath id="clip-${id}"><path d="${BODY}"/><path d="${HOOD}"/></clipPath>
  </defs>
  <rect width="480" height="640" fill="#FFFFFF"/>
  <g transform="translate(240 320) scale(1.12) translate(-240 -290)">
    <ellipse cx="240" cy="488" rx="190" ry="14" fill="#000" opacity=".07" filter="url(#soft-${id})"/>
    <g filter="url(#drop-${id})">
      <path d="${HOOD}" fill="url(#side-${id})"/>
      <path d="${BODY}" fill="url(#side-${id})"/>
    </g>
    <g clip-path="url(#clip-${id})">
      <rect width="480" height="530" fill="url(#top-${id})"/>
      <!-- folds: soft light and shade where cloth creases -->
      <g filter="url(#soft-${id})" fill="none" stroke-linecap="round">
        <path d="M106 200 Q100 300 84 380" stroke="${c.light}" stroke-width="9" opacity=".55"/>
        <path d="M374 200 Q380 300 396 380" stroke="${c.dark}" stroke-width="11" opacity=".7"/>
        <path d="M90 300 Q110 296 126 306 M354 306 Q370 296 390 300" stroke="${c.dark}" stroke-width="6" opacity=".5"/>
        <path d="M176 260 Q190 330 182 430" stroke="${c.dark}" stroke-width="10" opacity=".5"/>
        <path d="M300 250 Q288 340 298 430" stroke="${c.dark}" stroke-width="10" opacity=".45"/>
        <path d="M214 232 Q232 300 222 330" stroke="${c.light}" stroke-width="12" opacity=".4"/>
        <path d="M158 300 L322 296" stroke="${c.dark}" stroke-width="6" opacity=".35"/>
      </g>
      <!-- ribbed cuffs and hem -->
      <path d="M65 384 L117 398 L110 432 L60 418 Z" fill="url(#rib-${id})"/>
      <path d="M415 384 L363 398 L370 432 L420 418 Z" fill="url(#rib-${id})"/>
      <path d="M65 384 L117 398 M415 384 L363 398" stroke="${c.dark}" stroke-width="3" opacity=".8"/>
      <rect x="150" y="436" width="180" height="40" fill="url(#rib-${id})"/>
      <path d="M152 436 L328 436" stroke="${c.dark}" stroke-width="3" opacity=".8"/>
      <!-- the hood's lining and its seams -->
      <path d="M190 146 C198 102 282 102 290 146 C290 182 268 204 240 204 C212 204 190 182 190 146 Z" fill="url(#in-${id})"/>
      <path d="M182 134 L204 202 M298 134 L276 202" stroke="${c.dark}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M128 150 Q140 190 148 238 M352 150 Q340 190 332 238" stroke="${c.dark}" stroke-width="2.5" opacity=".55" fill="none"/>
      ${front}
      <rect width="480" height="530" filter="url(#grain-${id})"/>
    </g>
    <!-- cords, with metal tips -->
    <path d="M221 204 C219 230 214 250 216 276 M259 204 C261 230 266 250 264 276" stroke="${c.cord}" stroke-width="5" fill="none" stroke-linecap="round"/>
    <rect x="212.5" y="272" width="7" height="16" rx="2" fill="${c.tip}"/>
    <rect x="260.5" y="272" width="7" height="16" rx="2" fill="${c.tip}"/>
    <circle cx="221" cy="204" r="4.5" fill="${c.tip}"/><circle cx="259" cy="204" r="4.5" fill="${c.tip}"/>
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

/* Four, so the answer lands as one even row on a wide screen and two on
   a phone: every card in it whole, none promoted over the others. Prices
   sit where these retailers actually price a hoodie, all under the $80
   the request names. */
const DEMO_PRODUCTS = [
  { id: 'd1', name: 'Oversized Heavyweight Hoodie', retailer: 'H&M', price: 34.99, tone: 'black', cut: 'pullover',
    productUrl: 'https://www2.hm.com/en_us/search-results.html?q=oversized%20black%20hoodie',
    colors: ['Black'], fits: ['Oversized'], styles: ['Streetwear'], sizes: ['S', 'M', 'L'] },
  { id: 'd2', name: 'Boxy Brushed-Back Oversized Hoodie', retailer: 'UNIQLO', price: 49.9, tone: 'charcoal', cut: 'pullover',
    productUrl: 'https://www.uniqlo.com/us/en/search?q=oversized%20black%20hoodie',
    colors: ['Black'], fits: ['Oversized'], styles: ['Minimal'], sizes: ['XS', 'S', 'M'] },
  { id: 'd3', name: 'Washed Black Oversized Zip Hoodie', retailer: 'ASOS', price: 56.0, tone: 'washed', cut: 'zip',
    productUrl: 'https://www.asos.com/us/search/?q=black%20oversized%20hoodie',
    colors: ['Washed black'], fits: ['Oversized'], styles: ['Streetwear'], sizes: ['M', 'L', 'XL'] },
  { id: 'd4', name: 'Garment-Dyed Oversized Hoodie', retailer: 'URBAN OUTFITTERS', price: 69.0, tone: 'ink', cut: 'pullover',
    productUrl: 'https://www.urbanoutfitters.com/search?q=black+oversized+hoodie',
    colors: ['Black'], fits: ['Oversized'], styles: ['Classic'], sizes: ['M', 'L'] }
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
  maxPrice: 80,
  minPrice: null,
  season: null,
  gender: null
};

const QUERY = 'black oversized hoodie under $80';

/* What the "understands" step shows: the interpreter's own answer above,
   said back as the attributes in it, so the frame never claims more than
   the stubbed reply contains. */
const READING = [
  ...DEMO_INTENT.colors, ...DEMO_INTENT.fits,
  ...DEMO_INTENT.categories.map((c) => c[0].toUpperCase() + c.slice(1)),
  `Under $${DEMO_INTENT.maxPrice}`
];

/* the source is slower than a local file, and the video should show the
   waiting state the shopper actually sees rather than an instant grid */
const INTERPRET_DELAY = 800;
const SEARCH_DELAY = 1000;

/* ---------------------------------------------------------
   The origin everything is served from
   --------------------------------------------------------- */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.vtt': 'text/vtt'
};

/* ---------------------------------------------------------
   The site's faces, served locally

   Inter, the site's one face. The recording browser is cut off from
   everything except this origin, and a demo set in a different typeface
   than the site is a demo of something else. So the face is fetched once here, in Node, and served
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

   A pointer, one short line per step, the attributes Fynd read, the tab
   the retailer opens in, the closing line, and the badge that says what
   this recording is. It is injected into the page rather than
   composited afterwards so it moves with the interface at the same frame
   rate, and it is drawn from the site's own tokens — the same Inter, the
   same black, the same pills — so it belongs to the design under it.
   Nothing in it is louder than the interface, and every change is a fade.
   --------------------------------------------------------- */

const OVERLAY = ([compact, reading]) => {
  const u = compact ? .86 : 1;   /* the narrow frame is shown near its own size, the wide one scaled down */
  const css = `
    /* The page being recorded is the page the recording is shown on, and
       its player sits straight under the search. Filmed, it would be a
       video of the video; the recording leaves it out of the frame. */
    #demo { display: none !important; }

    #demo-layer { position: fixed; inset: 0; z-index: 9999; pointer-events: none; }

    #demo-cursor { position: absolute; top: 0; left: 0; z-index: 5; width: ${26 * u}px; height: ${26 * u}px;
      margin: -3px 0 0 -3px; transform: translate(50vw, 92vh);
      transition: transform .62s cubic-bezier(.32,.72,.24,1), opacity .3s ease; will-change: transform; }
    #demo-cursor svg { width: ${26 * u}px; height: ${26 * u}px; filter: drop-shadow(0 2px 5px rgba(0,0,0,.3)); }
    #demo-cursor::after { content: ''; position: absolute; inset: -9px; border-radius: 50%;
      background: var(--color-accent); opacity: 0; transform: scale(.4); }
    #demo-cursor.tap::after { animation: demo-tap .5s ease-out; }
    @keyframes demo-tap { 0% { opacity: .3; transform: scale(.4); } 100% { opacity: 0; transform: scale(1.5); } }

    /* on screen for the whole recording: what it says has to be true of
       every frame, not only of the frames somebody happens to pause on.
       It sits in the header, between the logo and the navigation, where
       it covers no content in any scene. The site's own Sample marker. */
    #demo-badge { position: absolute; z-index: 6; top: ${compact ? 17 : 19}px;
      ${compact ? 'right: 70px' : 'left: 50%; transform: translateX(-50%)'};
      display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--r-pill);
      background: var(--color-warning-soft); color: var(--color-warning-ink);
      font-size: ${compact ? 12 : 12.5}px; font-weight: 500; white-space: nowrap; }
    #demo-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning); }

    /* one short line per step, numbered the way the page numbers its
       steps, on the site's black */
    #demo-caption { position: absolute; z-index: 4; left: 50%; bottom: ${compact ? 22 : 32}px;
      transform: translate(-50%, 10px);
      display: flex; align-items: center; gap: ${10 * u}px; white-space: nowrap;
      padding: ${10 * u}px ${22 * u}px ${10 * u}px ${10 * u}px; border-radius: var(--r-pill);
      background: var(--color-primary); color: var(--color-text-on-primary); box-shadow: var(--shadow);
      font-size: ${compact ? 18 : 21}px; font-weight: 600; letter-spacing: -.02em; line-height: 1.2;
      opacity: 0; transition: opacity .3s ease, transform .3s cubic-bezier(.2,.7,.1,1); }
    #demo-caption.on { opacity: 1; transform: translate(-50%, 0); }
    #demo-caption b { display: grid; place-items: center; flex: none; width: ${28 * u}px; height: ${28 * u}px;
      border-radius: 50%; background: var(--color-text-on-primary); color: var(--color-primary);
      font-size: ${14 * u}px; font-weight: 600; letter-spacing: 0; }

    /* What the interpreter took from the sentence, in the page's own pill,
       laid over the example searches under the box for a moment. */
    #demo-read { position: absolute; z-index: 3; display: flex; flex-wrap: wrap; align-items: center;
      justify-content: center; gap: 8px; background: var(--color-bg);
      opacity: 0; transform: translateY(6px); transition: opacity .35s ease, transform .35s ease; }
    #demo-read.on { opacity: 1; transform: none; }
    /* narrow, the label takes its own line, as the page's own Try does */
    #demo-read .label { font-size: 14px; color: var(--color-text-muted); margin-right: 2px; ${compact ? 'width: 100%; text-align: center;' : ''} }
    #demo-read .chip { display: inline-flex; align-items: center; height: ${compact ? 32 : 36}px; padding: 0 ${compact ? 11 : 14}px;
      border: 1px solid var(--color-accent-soft); border-radius: var(--r-pill);
      background: var(--color-accent-soft); color: var(--color-accent-ink); font-size: ${compact ? 13 : 14}px; font-weight: 500; }

    /* The retailer's page, opening in its own tab. The recording cannot
       reach a retailer, and a drawing of one retailer's page would be
       putting words in its mouth, so this is the tab as it opens: the
       real host the card links to, and the page arriving. */
    #demo-tab { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
      background: var(--color-surface);
      opacity: 0; transform: translateY(14px); transition: opacity .4s ease, transform .4s cubic-bezier(.2,.7,.1,1); }
    #demo-tab.on { opacity: 1; transform: none; }
    #demo-tab .strip { display: flex; align-items: flex-end; gap: 2px; height: ${40 * u}px; padding: 0 ${14 * u}px;
      background: var(--color-surface-3); }
    #demo-tab .tab { display: flex; align-items: center; gap: 8px; height: ${31 * u}px; padding: 0 ${14 * u}px;
      border-radius: var(--r-sm) var(--r-sm) 0 0; font-size: ${13 * u}px; color: var(--color-text-muted); white-space: nowrap; }
    #demo-tab .tab.cur { background: var(--color-surface); color: var(--color-text); min-width: ${compact ? 0 : 220}px; }
    #demo-tab .tab i { width: ${11 * u}px; height: ${11 * u}px; flex: none; border: 1.5px solid currentColor; border-radius: 50%;
      border-right-color: transparent; animation: demo-spin .8s linear infinite; }
    @keyframes demo-spin { to { transform: rotate(360deg); } }
    #demo-tab .bar { display: flex; align-items: center; height: ${52 * u}px; padding: 0 ${16 * u}px;
      border-bottom: 1px solid var(--color-border); }
    #demo-tab .url { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; height: ${34 * u}px; padding: 0 ${14 * u}px;
      background: var(--color-bg-subtle); border-radius: var(--r-pill); font-size: ${compact ? 14 : 15}px; font-weight: 500;
      color: var(--color-text); overflow: hidden; white-space: nowrap; }
    #demo-tab .url svg { flex: none; width: 13px; height: 13px; color: var(--color-text-muted); }
    #demo-tab .load { height: 2px; background: var(--color-accent); width: 0; transition: width 2.4s cubic-bezier(.2,.6,.3,1); }
    #demo-tab.on .load { width: 82%; }
    #demo-tab .page { flex: 1; display: grid; grid-template-columns: ${compact ? '1fr' : '1.1fr 1fr'}; gap: ${compact ? 20 : 48}px;
      align-content: start; padding: ${compact ? '20px 18px' : '44px 72px'}; }
    #demo-tab .shot { aspect-ratio: ${compact ? '4 / 3.3' : '4 / 4.2'}; border-radius: var(--r); background: var(--color-surface-2);
      overflow: hidden; display: grid; place-items: center; }
    #demo-tab .shot img { width: ${compact ? '62%' : '92%'}; mix-blend-mode: multiply; }
    #demo-tab .lines { display: grid; gap: ${14 * u}px; align-content: start; padding-top: ${compact ? 0 : 10}px; }
    #demo-tab .lines span { display: block; height: ${12 * u}px; border-radius: 6px; background: var(--color-surface-3); }
    #demo-tab .lines .btn-line { height: ${48 * u}px; margin-top: ${14 * u}px; border-radius: var(--r); }

    /* the last frame: what to take away, and nothing else */
    #demo-end { position: absolute; inset: 0; z-index: 3; display: grid; place-content: center; justify-items: center;
      gap: ${22 * u}px; padding: 0 24px; text-align: center; background: var(--color-bg);
      opacity: 0; transition: opacity .5s ease; }
    #demo-end.on { opacity: 1; }
    #demo-end .brand { display: inline-flex; align-items: center; gap: 10px; }
    #demo-end p { margin: 0; font-size: ${compact ? 30 : 44}px; font-weight: 700; letter-spacing: -.04em; line-height: 1.1; }
    #demo-end p span { display: block; color: var(--color-text-muted); }

    /* The screencast a recording is made from only sends a frame when
       something repaints. A still page sends none, so what appears
       during a pause reaches the video seconds late, bunched into its
       last moments. One pixel that never stops repainting keeps the
       frames coming at an even rate, so every beat lands in the video
       when it happened. */
    #demo-tick { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px;
      background: var(--color-bg); animation: demo-tick .2s steps(2) infinite; }
    @keyframes demo-tick { to { background: var(--color-bg-subtle); } }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const layer = document.createElement('div');
  layer.id = 'demo-layer';
  layer.innerHTML = `
    <div id="demo-cursor"><svg viewBox="0 0 24 24" fill="#fff" stroke="#111" stroke-width="1.4"
      stroke-linejoin="round"><path d="M5 3l14 8.4-6.1 1.2-2.6 5.9z"/></svg></div>
    <div id="demo-read"><span class="label">Fynd read</span>${reading.map((r) => `<span class="chip">${esc(r)}</span>`).join('')}</div>
    <div id="demo-tab">
      <div class="strip">${compact ? '' : '<div class="tab">Fynd</div>'}<div class="tab cur"><i></i><span class="title"></span></div></div>
      <div class="bar"><div class="url"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/></svg><span class="addr"></span></div></div>
      <div class="load"></div>
      <div class="page"><div class="shot"><img alt=""></div>
        <div class="lines"><span style="width:28%"></span><span style="width:86%;height:${22 * u}px"></span>
          <span style="width:22%;height:${18 * u}px"></span><span style="width:64%"></span><span class="btn-line"></span></div></div>
    </div>
    <div id="demo-end"><span class="brand"><span class="brand-mark">F</span><span class="brand-word">Fynd</span></span>
      <p>Search naturally.<span>Find the right clothes.</span></p></div>
    <div id="demo-badge">Product demo · sample data</div>
    <div id="demo-caption"><b>1</b><span>caption</span></div>
    <div id="demo-tick"></div>`;
  document.body.appendChild(layer);

  const $ = (s) => layer.querySelector(s);
  const cursor = $('#demo-cursor');
  const caption = $('#demo-caption');
  const read = $('#demo-read');
  const tab = $('#demo-tab');

  window.demo = {
    move: (x, y) => { cursor.style.transform = `translate(${x}px, ${y}px)`; },
    tap: () => { cursor.classList.remove('tap'); void cursor.offsetWidth; cursor.classList.add('tap'); },
    say: (n, text) => {
      caption.querySelector('b').textContent = String(n);
      caption.querySelector('span').textContent = text;
      caption.classList.add('on');
    },
    hush: () => caption.classList.remove('on'),
    /* laid exactly over the example searches, so nothing under it moves */
    read: (on) => {
      if (!on) { read.classList.remove('on'); return; }
      const r = document.querySelector('#ask-examples').getBoundingClientRect();
      const box = document.querySelector('#ask-form').getBoundingClientRect();
      Object.assign(read.style, { left: `${box.left}px`, width: `${box.width}px`,
        top: `${r.top - 4}px`, minHeight: `${r.height + 8}px` });
      read.classList.add('on');
    },
    /* the host is the card's own link, the picture the card's own */
    open: (href, image, title) => {
      const host = new URL(href).host.replace(/^www\d?\./, '');
      $('#demo-tab .addr').textContent = host;
      $('#demo-tab .title').textContent = host;
      $('#demo-tab img').src = image;
      $('#demo-tab img').alt = title;
      tab.classList.add('on');
      cursor.style.opacity = '0';
    },
    end: () => { $('#demo-end').classList.add('on'); }
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
  { name: 'fynd-demo', width: 1280, height: 800, dpr: 1, compact: false, h264: 34, vp9: 43 },
  /* the narrow frame carries more pixels than the wide one once it is
     doubled, so it is compressed harder to land in the same place */
  { name: 'fynd-demo-mobile', width: 400, height: 720, dpr: 2, compact: true, h264: 37, vp9: 48 }
];

/* The four steps, and the line the recording closes on. The same words
   are the captions track, so a reader who never sees a frame gets the
   same account of what Fynd does. */
const STEPS = {
  describe: 'Describe it.',
  understand: 'Fynd understands it.',
  find: 'Fynd finds it.',
  open: 'Open it at the retailer.',
  close: 'Search naturally. Find the right clothes.'
};

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
  const now = () => (Date.now() - startedAt) / 1000;
  const cues = [];
  const close = () => {
    if (cues.length && cues[cues.length - 1].end === null) cues[cues.length - 1].end = now();
  };
  const say = async (n, text) => {
    close();
    cues.push({ n, text, start: now(), end: null });
    await page.evaluate(([i, t]) => window.demo.say(i, t), [n, text]);
  };
  const hush = async () => { close(); await page.evaluate(() => window.demo.hush()); };

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
  await page.evaluate(OVERLAY, [shot.compact, READING]);
  /* The first screen is the headline and the search box, whichever
     shape the frame is, so it opens where the page opens. */
  await wait(250);

  const box = async (selector) => {
    const b = await page.locator(selector).first().boundingBox();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, b } : null;
  };
  const point = async (selector, ms) => {
    const p = await box(selector);
    await page.evaluate(([x, y]) => window.demo.move(x, y), [p.x, p.y]);
    await wait(ms || 620);
    return p;
  };
  const tap = async () => { await page.evaluate(() => window.demo.tap()); await wait(200); };

  /* --- 1. the request ---------------------------------------------- */

  await say(1, STEPS.describe);
  await wait(400);
  await point('#ask', 520);
  await tap();
  await page.click('#ask');
  await page.type('#ask', QUERY, { delay: 78 });
  await wait(600);

  /* --- 2. what Fynd took from it ----------------------------------- */

  await say(2, STEPS.understand);
  await page.evaluate(() => window.demo.read(true));
  await wait(2600);

  /* --- 3. the search ------------------------------------------------ */

  await point('#ask-form button[type=submit]', 560);
  await tap();
  await hush();
  await page.click('#ask-form button[type=submit]');
  await page.evaluate(() => window.demo.read(false));
  await page.waitForSelector('#results .grid .item-card', { timeout: 20000 });

  /* --- 4. what came back -------------------------------------------- */

  /* the whole answer in one frame: the count, the request it answers,
     and every card with its picture, maker, price and retailer */
  await page.evaluate(() => {
    const head = document.querySelector('#results .results-head');
    const top = head.getBoundingClientRect().top + window.scrollY;
    const header = document.querySelector('.site-header').getBoundingClientRect().height;
    window.scrollTo({ top: top - header - 20, behavior: 'smooth' });
  });
  await wait(500);
  await say(3, STEPS.find);
  await point('.grid .item-card:nth-child(1) .item-media', 900);
  await wait(900);
  await point('.grid .item-card:nth-child(2) .item-media', 900);
  await wait(1000);

  /* --- 5. out to the retailer --------------------------------------- */

  await say(4, STEPS.open);
  await point('.grid .item-card:nth-child(2) .item-name', 520);
  await page.hover('.grid .item-card:nth-child(2)');
  await wait(650);
  await tap();
  await page.click('.grid .item-card:nth-child(2) .item-name');
  await wait(250);

  const opened = await page.evaluate(() => {
    const card = document.querySelectorAll('.grid .item-card')[1];
    return { href: window.demo.__clicked || card.getAttribute('href'),
      image: card.querySelector('img').src, title: card.querySelector('.item-name').textContent };
  });
  await page.evaluate(([h, i, t]) => window.demo.open(h, i, t), [opened.href, opened.image, opened.title]);
  await wait(2900);

  /* --- the line it closes on ---------------------------------------- */

  await hush();
  await page.evaluate(() => window.demo.end());
  cues.push({ n: 5, text: STEPS.close, start: now() + 0.2, end: null });
  await wait(3300);
  close();

  const video = page.video();
  const length = now();
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
    console.log(`Fonts: ${fontFiles.size} files cached for the recording`);
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
    /* The recorder falls behind the wall clock while it works, so the
       video runs longer than the walkthrough took — about a tenth, and
       more towards the end. The cues were timed on the wall clock, so
       they are stretched to the video's own length, or the captions
       track would run ahead of the frames it describes. */
    const actual = videoLength(take.source);
    if (actual && actual > take.length) {
      const stretch = actual / take.length;
      take.cues.forEach((cue) => {
        cue.start *= stretch;
        if (cue.end != null) cue.end *= stretch;
      });
      take.length = actual;
    }
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

/* How long a recording actually runs, read off the file. ffmpeg -i with
   no output exits with an error and prints what it found on stderr, so
   the answer comes from the error. Null when there is no ffmpeg to ask. */
function videoLength(file) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  let text = '';
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    text = String(err.stderr || '');
  }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

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
