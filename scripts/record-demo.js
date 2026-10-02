#!/usr/bin/env node
/* =========================================================
   Fynd — records the landing page demo video

   One idea, in about eighteen seconds: describe clothes the way you
   would say them, and Fynd finds matching products.

     1. Describe   a request is typed into the real search field
     2. Search     Find it is pressed
     3. Results    the real results page; the grid is the picture
     4. Retailer   one product is pointed at, and it goes to its retailer
     5. End        back to the clean results, and the closing line

   Everything on screen is the site itself, driven in a real browser.
   The only thing standing in is the product source, which answers here
   from a fixed set of records instead of a paid API, so the recording is
   identical every time it is made.

   What the camera adds is deliberately small: a pointer, and one short
   caption at a time in the site's own type. No badges, arrows, zooms,
   highlights or numbered steps — the interface carries the video.

   Usage:
     node scripts/record-demo.js            record, then encode
     node scripts/record-demo.js --raw      record only, leave the WebM
     node scripts/record-demo.js --stills   no video: a PNG at every beat,
                                            for checking the framing

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

const STILLS = process.argv.includes('--stills');
const RAW = process.argv.includes('--raw');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = ['/opt/pw-browsers'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; /* Playwright's own */
}

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
  chromium = require(process.env.PLAYWRIGHT_PATH || 'playwright').chromium;
} catch (err) {
  try {
    chromium = require('/opt/node22/lib/node_modules/playwright').chromium;
  } catch (err2) {
    console.log('Playwright is not available here — cannot record the demo.');
    process.exit(0);
  }
}

/* ---------------------------------------------------------
   The garment artwork

   A product tile needs a photograph, and there is no photograph of a
   real listing this repository may carry. So the demo draws its own:
   flat-lay artwork on a white ground, one drawing per row. The card
   lays a photo onto its own warm tile, so the white takes the tile's
   tone exactly as a retailer's packshot does. They read as product
   imagery without standing in for anybody's photograph.
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

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 640" width="480" height="640" role="img">
  <defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.14"/>
  </filter></defs>
  <rect width="480" height="640" fill="#FFFFFF"/>
  <g transform="translate(0 20)">
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
   invented to look convincing. All of them sit under the $80 asked for.
   --------------------------------------------------------- */

const DEMO_PRODUCTS = [
  { id: 'd1', name: 'Oversized Heavyweight Fleece Hoodie', retailer: 'H&M', price: 34.99, tone: 'black', cut: 'pullover',
    productUrl: 'https://www2.hm.com/en_us/search-results.html?q=oversized%20black%20hoodie',
    colors: ['Black'], fits: ['Oversized'], styles: ['Streetwear'], sizes: ['S', 'M', 'L'] },
  { id: 'd2', name: 'Boxy Brushed-Back Hooded Sweatshirt', retailer: 'UNIQLO', price: 49.9, tone: 'charcoal', cut: 'pullover',
    productUrl: 'https://www.uniqlo.com/us/en/search?q=oversized%20black%20hoodie',
    colors: ['Black'], fits: ['Oversized'], styles: ['Minimal'], sizes: ['XS', 'S', 'M'] },
  { id: 'd3', name: 'Relaxed Cotton-Blend Zip Hoodie', retailer: 'GAP', price: 64.95, tone: 'ink', cut: 'zip',
    productUrl: 'https://www.gap.com/browse/search.do?searchText=black%20oversized%20hoodie',
    colors: ['Black'], fits: ['Relaxed'], styles: ['Classic'], sizes: ['S', 'M', 'L'] },
  { id: 'd4', name: 'Washed Black Drop-Shoulder Hoodie', retailer: 'ASOS', price: 45.0, tone: 'washed', cut: 'pullover',
    productUrl: 'https://www.asos.com/us/search/?q=black%20oversized%20hoodie',
    colors: ['Washed black'], fits: ['Oversized'], styles: ['Streetwear'], sizes: ['M', 'L', 'XL'] },
  { id: 'd5', name: 'Reverse Weave Pullover Hoodie', retailer: 'CHAMPION', price: 70.0, tone: 'black', cut: 'pullover',
    productUrl: 'https://www.champion.com/search?q=black%20hoodie',
    colors: ['Black'], fits: ['Regular'], styles: ['Sporty'], sizes: ['S', 'M', 'L'] },
  { id: 'd6', name: 'Loose Fit Hooded Sweatshirt', retailer: 'ZARA', price: 45.9, tone: 'charcoal', cut: 'zip',
    productUrl: 'https://www.zara.com/us/en/search?searchTerm=black%20hoodie',
    colors: ['Black'], fits: ['Loose'], styles: ['Minimal'], sizes: ['S', 'M'] },
  { id: 'd7', name: 'Garment-Dyed Oversized Hoodie', retailer: 'URBAN OUTFITTERS', price: 69.0, tone: 'washed', cut: 'pullover',
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
  maxPrice: 80,
  minPrice: null,
  season: null,
  gender: null
};

const QUERY = 'black oversized hoodie under $80';

/* Long enough for the page's own waiting state to register as a moment,
   short enough that it never reads as a loading screen. */
const INTERPRET_DELAY = 450;
const SEARCH_DELAY = 450;

/* The four lines the video says, one at a time and never two at once. */
const CAPTIONS = {
  describe: 'Describe what you want',
  results: 'Fynd finds matching products',
  retailer: 'Open the product at the retailer',
  end: 'Describe it. Find it.'
};

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

   Inter and Fragment Mono. The recording browser is cut off from
   everything except this origin, and a demo set in a different typeface
   than the site is a demo of something else. So the face is fetched once
   here, in Node, and served back at the address the page already asks
   for. Only the Latin subsets are kept: the recording has no other
   alphabet in it.

   If the fetch does not work — no network, or Google Fonts moved — the
   recording still happens in the stack the site itself falls back to,
   with a line saying so.
   --------------------------------------------------------- */

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Fragment+Mono&family=Inter:ital,opsz,wght@0,14..32,300..700;1,14..32,300..500&display=swap';
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fontFiles = new Map();

async function loadFonts() {
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
   What the camera changes about the page

   Kept to the least that makes the recording quiet and true:

   - The demo section is removed, so the video never shows itself.
   - The page's reading decoration — the brackets drawn under words as
     they are typed and in the echoed request, the "Read as" line under
     the field, and the printer's crop marks around frames — is turned
     off. On the live page it is the site's voice; in an eighteen-second
     clip it is motion competing with the one thing the video says.
   - The field starts empty. Its placeholder is the very sentence the
     video types, and it types itself in on arrival; left on, the request
     would be on screen before anybody had asked for anything.
   - The stand-in source is marked as what it is. The page labels rows
     from a product source "Live listings"; these are not live stock, so
     the recording swaps that marker for the page's own "Sample data"
     one, in the same place and the same style.

   Nothing else is restyled: type, colour, spacing, the field, the
   buttons and the cards are the site's own.
   --------------------------------------------------------- */

const QUIET_CSS = `
  #demo { display: none !important; }
  .read::after, .read::before { display: none !important; }
  #readout { visibility: hidden !important; }
  :root, * { --crop-ink: transparent !important; }
`;

/* ---------------------------------------------------------
   The layer that only exists for the camera

   A pointer and one caption. Injected into the page rather than
   composited afterwards so it moves with the interface at the same frame
   rate, and drawn from the site's own tokens so it belongs to the same
   design as everything under it.
   --------------------------------------------------------- */

const OVERLAY = (compact) => {
  const css = `
    #demo-layer { position: fixed; inset: 0; z-index: 9999; pointer-events: none;
      font-family: var(--font-sans, 'Inter'), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }

    /* a plain system pointer; a click is the pointer pressing, nothing more */
    #demo-cursor { position: absolute; top: 0; left: 0; width: 22px; height: 22px;
      margin: -2px 0 0 -4px; opacity: 0; transform: translate(70vw, 85vh);
      transition: transform .7s cubic-bezier(.3,.7,.25,1), opacity .3s ease; will-change: transform; }
    #demo-cursor.on { opacity: 1; }
    #demo-cursor svg { width: 22px; height: 22px; display: block; transition: transform .12s ease;
      filter: drop-shadow(0 1px 2px rgba(0,0,0,.28)); }
    #demo-cursor.down svg { transform: scale(.86); }

    /* One short line at a time, in a quiet strip along the bottom edge
       of the frame. The strip is there from the first frame to the last,
       so a caption arriving never moves anything, and it sits below the
       interface rather than on it: no product or control is ever under
       the words. Ink on the page's own paper, in the page's own face. */
    #demo-strip { position: absolute; left: 0; right: 0; bottom: 0; height: ${compact ? 44 : 48}px;
      display: flex; align-items: center; justify-content: center;
      background: var(--color-bg); border-top: 1px solid var(--color-border); }
    #demo-caption { color: var(--color-text);
      font-size: ${compact ? 13.5 : 14}px; font-weight: 500; letter-spacing: -.005em; line-height: 1;
      white-space: nowrap; opacity: 0; transition: opacity .35s ease; }
    #demo-caption.on { opacity: 1; }

    /* Where a pointed-at link goes, shown the way a desktop browser
       shows it: the real address, small, in the bottom corner. */
    #demo-status { position: absolute; left: 0; bottom: ${compact ? 44 : 48}px; max-width: 60%;
      padding: 4px 10px; background: #F1F1F1; color: #3C3C3C;
      border: 1px solid #D6D6D6; border-left: 0; border-bottom: 0; border-top-right-radius: 4px;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      opacity: 0; transition: opacity .15s ease; }
    #demo-status.on { opacity: 1; }

    /* The screencast a recording is made from only sends a frame when
       something repaints. A still page sends none, so what appears
       during a pause reaches the video late, bunched into its last
       moments. One pixel that never stops repainting keeps the frames
       coming at an even rate, so every beat lands when it happened. */
    #demo-tick { position: absolute; left: 0; top: 0; width: 1px; height: 1px;
      background: var(--color-bg); animation: demo-tick .2s steps(2) infinite; }
    @keyframes demo-tick { to { background: var(--color-surface); } }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const layer = document.createElement('div');
  layer.id = 'demo-layer';
  layer.innerHTML = `
    <div id="demo-cursor"><svg viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.6-4.3 2.9 6.6 2.9-1.3-2.9-6.5h6.3z"
      fill="#111" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg></div>
    <div id="demo-strip"><div id="demo-caption"></div></div>
    <div id="demo-status"></div>
    <div id="demo-tick"></div>`;
  document.body.appendChild(layer);

  const cursor = layer.querySelector('#demo-cursor');
  const caption = layer.querySelector('#demo-caption');
  const status = layer.querySelector('#demo-status');

  window.demo = {
    show: () => cursor.classList.add('on'),
    hide: () => cursor.classList.remove('on'),
    move: (x, y) => { cursor.style.transform = `translate(${x}px, ${y}px)`; },
    press: (down) => cursor.classList.toggle('down', down),
    say: (text) => { caption.textContent = text; caption.classList.add('on'); },
    hush: () => caption.classList.remove('on'),
    status: (text) => { if (text) status.textContent = text; status.classList.toggle('on', Boolean(text)); }
  };

  /* Following the link would end the recording on somebody else's page,
     and this environment cannot reach one anyway. The click still
     happens, on the real anchor, with the real href — it is only the
     navigation that is held back. */
  document.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('a.item-card');
    if (!card) return;
    e.preventDefault();
    window.demo.clicked = card.getAttribute('href');
  }, true);

  /* the page's own sample marker, in place of the live one: see above */
  new MutationObserver(() => {
    document.querySelectorAll('#results .status--live').forEach((el) => {
      el.className = 'status status--sample';
      el.textContent = 'Sample data';
    });
  }).observe(document.getElementById('results'), { childList: true, subtree: true });
};

/* ---------------------------------------------------------
   The recording itself
   --------------------------------------------------------- */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Two recordings, not one. An interface shot for a 1280-wide window is
   unreadable on a phone — the type in it lands at about six pixels — and
   a crop of it is not what a phone shows anyway. So the same walkthrough
   is driven twice, once in each shape, and the narrow one is the site's
   real mobile layout. The page picks the one that fits the screen.

   The narrow one is captured at two device pixels per CSS pixel so that
   a phone, which has at least that many, is not shown an upscale.

   h264 and vp9 are the quality settings for the two encodes, tuned per
   shape and per codec so the WebM the page offers first is never the
   bigger of the two files. */
const SHOTS = [
  { name: 'fynd-demo', width: 1280, height: 800, dpr: 1, compact: false, h264: 30, vp9: 38 },
  { name: 'fynd-demo-mobile', width: 400, height: 720, dpr: 2, compact: true, h264: 33, vp9: 45 }
];

async function record(shot, fontCss, rawDir, stillsDir) {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    args: shot.dpr > 1 ? [`--force-device-scale-factor=${shot.dpr}`] : []
  });

  const context = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: shot.dpr,
    isMobile: shot.compact,
    hasTouch: shot.compact,
    reducedMotion: 'no-preference',
    ...(stillsDir ? {} : {
      recordVideo: { dir: rawDir, size: { width: shot.width * shot.dpr, height: shot.height * shot.dpr } }
    })
  });

  const page = await context.newPage();

  /* Every caption is timed against one clock that starts with the page,
     and written out as a captions track afterwards: burned-in text is
     not text, and somebody reading captions rather than watching them
     needs the words. */
  const startedAt = Date.now();
  const now = () => (Date.now() - startedAt) / 1000;
  const cues = [];
  let stillN = 0;
  const still = async (label) => {
    if (!stillsDir) return;
    stillN += 1;
    await page.screenshot({ path: path.join(stillsDir, `${shot.name}-${String(stillN).padStart(2, '0')}-${label}.png`) });
  };
  const say = async (text) => {
    cues.push({ text, start: now(), end: null });
    await page.evaluate((t) => window.demo.say(t), text);
  };
  const hush = async () => {
    const open = cues[cues.length - 1];
    if (open && open.end === null) open.end = now();
    await page.evaluate(() => window.demo.hush());
  };

  await page.addInitScript(() => {
    window.FINDWEAR_API = `${location.origin}/api/interpret`;
    window.FINDWEAR_SEARCH_API = `${location.origin}/api/search`;
  });
  await page.addInitScript((css) => {
    /* before assets/reading.js runs, which is what animates it */
    const blank = new MutationObserver(() => {
      const field = document.getElementById('ask');
      if (!field) return;
      field.setAttribute('placeholder', '');
      blank.disconnect();
    });
    blank.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.createElement('style');
      s.textContent = css;
      document.head.appendChild(s);
    });
  }, QUIET_CSS);

  /* The page's own stylesheet link is answered from the cache above, so
     the recording is set in the face the site is set in. Everything else
     off this origin is unreachable here anyway, and cutting it keeps the
     recording identical from one run to the next. */
  await page.route((url) => !String(url).includes(`127.0.0.1:${PORT}`), (route) => {
    if (fontCss && String(route.request().url()).startsWith('https://fonts.googleapis.com/css2')) {
      return route.fulfill({ status: 200, contentType: 'text/css', body: fontCss });
    }
    return route.abort();
  });

  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#ask-form');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(OVERLAY, shot.compact);

  const rect = async (selector) => {
    const b = await page.locator(selector).first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  const moveTo = async (x, y, settle = 720) => {
    await page.evaluate(([px, py]) => window.demo.move(px, py), [x, y]);
    await wait(settle);
  };
  const press = async () => {
    await page.evaluate(() => window.demo.press(true));
    await wait(110);
    await page.evaluate(() => window.demo.press(false));
  };
  const scrollTo = (y) => page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
  /* the page's y for an element, under the sticky header */
  const topOf = (selector, gap) => page.evaluate(([sel, g]) => {
    const el = document.querySelector(sel);
    const header = document.querySelector('.site-header');
    const h = header ? header.getBoundingClientRect().height : 0;
    return Math.max(0, el.getBoundingClientRect().top + window.scrollY - h - g);
  }, [selector, gap]);

  /* On a phone the field sits under the headline; bring it up the way a
     shopper would, before anything starts. Not part of the recording's
     story, so it happens while the first frames are still empty. */
  if (shot.compact) {
    await page.evaluate((y) => window.scrollTo(0, y), await topOf('.hero h1', 4));
  }
  await wait(400);

  /* Everything before this moment is the page loading, which the video
     does not need: the encode starts here. */
  const startAt = now();

  /* --- 1. Describe ------------------------------------------------- */

  const field = await rect('#ask');
  const fieldStart = { x: field.b.x + Math.min(70, field.b.width * 0.2), y: field.y };
  await page.evaluate(([x, y]) => window.demo.move(x, y), [fieldStart.x + 60, fieldStart.y + 120]);
  await page.evaluate(() => window.demo.show());
  await say(CAPTIONS.describe);
  await moveTo(fieldStart.x, fieldStart.y, 650);
  await press();
  await page.focus('#ask');
  await wait(150);
  await page.keyboard.type(QUERY, { delay: 62 });
  await still('typed');
  await wait(650);

  /* --- 2. Search --------------------------------------------------- */

  await hush();
  const go = await rect('#ask-form button[type=submit]');
  await moveTo(go.x, go.y, 680);
  await press();
  await page.click('#ask-form button[type=submit]');
  /* the real pointer is parked off the page, so no card under where it
     clicked is left showing a hover the drawn pointer is not making */
  await page.mouse.move(1, 1);
  await page.evaluate(() => window.demo.hide());

  /* --- 3. Results -------------------------------------------------- */

  await page.waitForSelector('#results .item-card', { timeout: 20000 });
  /* the page scrolls itself to the results; let it land and the grid
     develop before anything is said about it */
  await wait(700);
  const resultsTop = await topOf('#results', 8);
  await scrollTo(resultsTop);
  await wait(300);
  await say(CAPTIONS.results);
  await still('results');
  await wait(2000);

  /* one easy look further down the grid, the way a shopper would */
  const gridTop = await topOf('#results .grid', shot.compact ? 12 : 20);
  await scrollTo(gridTop);
  await wait(2000);
  await still('grid');
  await hush();

  /* --- 4. Retailer ------------------------------------------------- */

  /* the second card: in the wide frame it sits beside the lead one, in
     the narrow frame it is the next one down */
  const target = '#results .grid .item-card:nth-child(2)';
  if (shot.compact) {
    await scrollTo(await topOf(target, 12));
    await wait(700);
  }
  const action = await rect(`${target} .item-action`);
  await page.evaluate(() => window.demo.show());
  await say(CAPTIONS.retailer);
  await moveTo(action.x, action.y, 700);
  await page.hover(`${target} .item-action`);
  const href = await page.locator(target).getAttribute('href');
  if (!shot.compact && href) {
    await page.evaluate((h) => window.demo.status(h.replace(/^https?:\/\//, '')), href);
  }
  await wait(900);
  await still('retailer');
  await press();
  await page.click(`${target} .item-action`);
  await wait(1300);
  await page.evaluate(() => window.demo.status(''));
  await hush();

  /* --- 5. End ------------------------------------------------------ */

  await page.mouse.move(1, 1);
  await page.evaluate(() => window.demo.hide());
  await scrollTo(resultsTop);
  await wait(800);
  await say(CAPTIONS.end);
  await still('end');
  await wait(2400);
  await hush();
  await wait(450);

  const length = now();
  const video = stillsDir ? null : page.video();
  await context.close();
  await browser.close();

  if (!video) {
    console.log(`  ${shot.name}: ${(length - startAt).toFixed(1)}s walkthrough, stills written`);
    return { cues, length, startAt };
  }
  const source = await video.path();
  console.log(`  ${shot.name}: ${(length - startAt).toFixed(1)}s, ${(fs.statSync(source).size / 1e6).toFixed(2)} MB raw`);
  return { source, cues, length, startAt };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-demo-'));
  const stillsDir = STILLS ? fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-stills-')) : null;

  await new Promise((r) => server.listen(PORT, r));

  let fontCss = '';
  try {
    fontCss = await loadFonts();
    console.log(`Fonts: ${fontFiles.size} files cached for the recording`);
  } catch (err) {
    console.log('Inter could not be fetched — recording in the fallback stack.');
  }

  console.log(STILLS ? 'walking through for stills…' : 'recording…');
  const takes = [];
  try {
    for (const shot of SHOTS) takes.push([shot, await record(shot, fontCss, rawDir, stillsDir)]);
  } catch (err) {
    server.close();
    if (/executable|launch|ENOENT/i.test(String(err && err.message))) {
      console.log('Chromium could not launch here — cannot record the demo.');
      process.exit(0);
    }
    throw err;
  }
  server.close();

  if (STILLS) {
    console.log(`stills in ${stillsDir}`);
    return;
  }

  for (const [shot, take] of takes) {
    /* The recorder falls behind the wall clock while it works, so the
       video can run a little longer than the walkthrough took. The cues
       were timed on the wall clock, so they are stretched to the video's
       own length, or the captions track would run ahead of the frames. */
    const actual = videoLength(take.source);
    if (actual && actual > take.length) {
      const stretch = actual / take.length;
      take.cues.forEach((cue) => {
        cue.start *= stretch;
        if (cue.end != null) cue.end *= stretch;
      });
      take.startAt *= stretch;
      take.length = actual;
    }
    /* and every time is then counted from where the encode starts */
    take.cues.forEach((cue) => {
      cue.start -= take.startAt;
      if (cue.end != null) cue.end -= take.startAt;
    });
    take.length -= take.startAt;
    writeTrack(shot.name, take.cues, take.length);

    if (RAW) {
      const kept = path.join(OUT, `${shot.name}.source.webm`);
      fs.copyFileSync(take.source, kept);
      console.log(`  (the video proper starts ${take.startAt.toFixed(2)}s in)`);
      console.log(`kept the raw recording at ${path.relative(REPO, kept)}`);
      continue;
    }

    /* the poster is what the section shows before anything plays: the
       results, framed whole, with the line that says what they are */
    const results = take.cues.find((c) => c.text === CAPTIONS.results);
    encode(shot, take.source, take.startAt, results ? results.start + 1.6 : 9);
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

   The same lines the frame carries, as text, timed against the recording
   that just happened. They are placed at the top of the frame so that
   turning them on does not stack them over the ones drawn into it.
   --------------------------------------------------------- */

function writeTrack(name, cues, length) {
  const clock = (s) => {
    const t = Math.max(0, s);
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, '0');
    return `00:${mm}:${ss}.${ms}`;
  };

  const body = cues.map(({ text, start, end }, i) =>
    `${i + 1}\n${clock(start)} --> ${clock(end == null ? length : end)} line:8%\n${text}`).join('\n\n');

  const file = path.join(OUT, `${name}.vtt`);
  fs.writeFileSync(file, `WEBVTT\n\n${body}\n`);
  console.log(`wrote ${path.relative(REPO, file)} (${cues.length} cues)`);
}

/* ---------------------------------------------------------
   The encode

   Two codecs per shape, because neither one alone reaches every
   browser. H.264 is the format nobody has to be asked about — except
   that a Chromium built without proprietary codecs, which is what most
   Linux distributions ship and what this repository's own test browser
   is, cannot play it at all. VP9 covers those and is the smaller file
   besides; Safari takes the H.264. The page lists the WebM first.
   --------------------------------------------------------- */

function encode(shot, source, startAt, stillAt) {
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

  /* Kept at the size it was recorded at, and at a steady 30 frames a
     second. -an because the demo is silent: there is no soundtrack to
     carry, and even a muted track costs bytes. +faststart so the file
     can start playing before it has finished arriving. -ss before -i
     drops the page load, which is not part of the demo. */
  const common = ['-ss', startAt.toFixed(3), '-i', source, '-an', '-vf', 'fps=30', '-pix_fmt', 'yuv420p'];

  console.log(`encoding ${name}.mp4…`);
  run([...common, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow',
    '-crf', String(shot.h264), '-g', '60', '-movflags', '+faststart', mp4]);

  console.log(`encoding ${name}.webm…`);
  run([...common, '-c:v', 'libvpx-vp9', '-crf', String(shot.vp9), '-b:v', '0',
    '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', webm]);

  run(['-ss', (startAt + stillAt).toFixed(3), '-i', source, '-frames:v', '1', '-q:v', '4', poster]);

  const size = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`  ${path.relative(REPO, mp4)}  ${size(mp4)}`);
  console.log(`  ${path.relative(REPO, webm)}  ${size(webm)}`);
  console.log(`  ${path.relative(REPO, poster)}  ${size(poster)}`);
}
