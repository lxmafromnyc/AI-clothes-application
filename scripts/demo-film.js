#!/usr/bin/env node
/* =========================================================
   Fynd — the homepage film

   A product film cut from a real Fynd session. Everything in it that
   looks like Fynd is Fynd: the interface, the typing, the searches, the
   results, the product photographs, the prices and the retailer pages
   are the session's own frames (assets/demo/footage/), and the product
   facts set in type come from the search that session made
   (assets/demo/demo-search.json). The film adds what an editor and a
   motion designer add: where the camera looks, when things happen, how
   one moment becomes the next — and nothing that pretends to be the
   product.

     opening    a quiet field of the session's real product photographs;
                "Ever know exactly what you want, but not where to find it?";
                the real search field opens out of them and the camera
                draws back into the homepage
     hoodie     the request typed for real; its attributes lift out of the
                field as type and fold back in; the real results rise into
                place; one is chosen, becomes the subject, and its frame
                opens onto the real store
     jacket     the hoodie grid stays, ghosted; the real search field
                floats above it; on Search the grid re-forms as jackets
     BAPE       close on the field; a dark stage, BAPE; the real listing
                on black; its store
     dress      softer: the attributes in type, the results settling, the
                dress, its store
     close      "Describe what you want." over the four requests as they
                were typed; "Fynd finds it." as the four products they
                found rise in their place; the mark; white

   Rendered here, frame by frame, with a Skia canvas: easing, masks,
   layered depth and true motion blur (several sub-frame renders averaged
   while anything moves). Sound: scripts/demo-audio.js, from the film
   timeline this writes.

     node scripts/demo-film.js                    both films, finished, into
                                                  assets/demo: the MP4 and WebM
                                                  with their sound, captions,
                                                  poster and timeline
     node scripts/demo-film.js --only=desktop     one
     node scripts/demo-film.js --master=DIR       the picture only (lossless-ish
                                                  H.264) and its timeline, for review
     node scripts/demo-film.js --from-master=DIR  finish from a picture made with
                                                  --master, without drawing it again
     node scripts/demo-film.js --stills=1.2,9.5   PNG frames, for review
     node scripts/demo-film.js --range=10:20      part of the picture, with --master
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DEMO = path.join(REPO, 'assets', 'demo');
const FOOTAGE = path.join(DEMO, 'footage');
const FPS = 30;

let Canvas = null;
function canvasLib() {
  if (Canvas) return Canvas;
  Canvas = require('@napi-rs/canvas');
  const fonts = path.join(REPO, 'node_modules', '@fontsource', 'inter', 'files');
  for (const w of [400, 500, 600, 700]) Canvas.GlobalFonts.registerFromPath(path.join(fonts, `inter-latin-${w}-normal.woff2`), 'Inter');
  return Canvas;
}

/* ---------------------------------------------------------
   Time and easing
   --------------------------------------------------------- */

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

/* cubic-bezier easing, as CSS defines it */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const e = sx(t) - x;
      const d = dx(t);
      if (Math.abs(e) < 1e-6 || Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(clamp01(t));
  };
}
const EASE = {
  /* long, soft deceleration: things arriving */
  out: bezier(0.16, 1, 0.3, 1),
  /* even in and out: the camera, and things travelling */
  inOut: bezier(0.65, 0, 0.35, 1),
  /* gentle, for slow pushes */
  soft: bezier(0.4, 0, 0.2, 1),
  /* leaving */
  in: bezier(0.55, 0, 0.85, 0.35),
  linear: (x) => x
};
/* progress through [a, b] at time t, eased */
const at = (t, a, b, ease = EASE.inOut) => ease(clamp01((t - a) / Math.max(1e-6, b - a)));

/* ---------------------------------------------------------
   The two shapes, and what was measured in their footage
   --------------------------------------------------------- */

/* Geometry is in footage pixels, measured from the session's own frames
   (see the README's film section). `strip` is where the recording's own
   caption strip starts: the camera never shows it. */
const FORMATS = {
  desktop: {
    name: 'fynd-demo', W: 1280, H: 800, strip: 754, mask: 748,
    box: { x: 252, y: 484, w: 776, h: 81 },
    boxText: { x: 313, y: 524 },
    tileX: [40, 346, 652, 958], tileW: 282, tileH: 354, cardH: 482, tileY: [260, 260, 260, 260],
    header: { x: 30, y: 150, w: 820, h: 96 },
    view: { results: { z: 1, cx: 640, cy: 400 } },
    hero: { w: 420, h: 526 },
    /* the results' own header line, where a request's words come to rest */
    resultsLine: { x: 40, y: 206, w: 380, h: 28 },
    meta: { size: 1 },
    window: { x: 40, y: 34, w: 1200, h: 700 },
    labelY: 768,
    type: { caps: 58, capsLead: 70, title: 196, body: 62 },
    /* the session: when things happened, in its own seconds */
    searches: [
      { from: 0.3, lastKey: 6.367, press: 7.3, hold: { at: 6.6, dur: 0.9 }, liveFrom: 9.75, click: 13.638, retail: [13.888, 16.189], pick: 1, tileY: 260 },
      { from: 18.4, lastKey: 20.367, press: 20.77, liveFrom: 23.5, click: 24.388, retail: [24.638, 26.889], pick: 1, tileY: 260 },
      { from: 29.6, lastKey: 31.933, press: 32.3, liveFrom: 35.6, click: 36.404, retail: [36.654, 39.064], pick: 1, tileY: 260 },
      { from: 41.6, lastKey: 43.533, press: 43.8, hold: { at: 43.62, dur: 1.3 }, liveFrom: 46.9, click: 48.326, retail: [48.576, 51.006], pick: 3, tileY: 260 }
    ],
    /* the retailer pages: which footage, the region shown, and where the
       product photograph sits on the page (for the hand-off) */
    stores: [
      { footage: 'desktop', crop: { x: 0, y: 0, w: 1280, h: 800 }, photo: { x: 16, y: 52, w: 422, h: 562 }, until: 16.08 },
      { footage: 'desktop', crop: { x: 0, y: 0, w: 1280, h: 800 }, photo: { x: 16, y: 68, w: 422, h: 564 }, until: 26.73 },
      { footage: 'desktop', crop: { x: 0, y: 0, w: 1280, h: 800 }, photo: { x: 142, y: 146, w: 498, h: 498 }, until: 38.92 },
      { footage: 'desktop', crop: { x: 0, y: 50, w: 1280, h: 750 }, photo: { x: 82, y: 418, w: 272, h: 338 }, until: 50.87 }
    ]
  },
  mobile: {
    name: 'fynd-demo-mobile', W: 800, H: 1440, strip: 1352, mask: 1344,
    box: { x: 24, y: 682, w: 752, h: 246 },
    boxText: { x: 62, y: 748 },
    tileX: [32, 410], tileW: 358, tileH: 448, cardH: 640,
    header: { x: 20, y: 250, w: 760, h: 190 },
    view: { results: { z: 1, cx: 400, cy: 720 } },
    hero: { w: 452, h: 566 },
    resultsLine: { x: 32, y: 380, w: 520, h: 36 },
    meta: { size: 1 },
    window: { x: 40, y: 140, w: 720, h: 1110 },
    labelY: 1300,
    type: { caps: 76, capsLead: 90, title: 210, body: 74 },
    searches: [
      { from: 0.3, lastKey: 4.4, press: 4.97, hold: { at: 4.55, dur: 1.0 }, liveFrom: 7.6, click: 11.512, retail: [11.762, 13.933], pick: 1, tileY: 495 },
      { from: 16.4, lastKey: 18.0, press: 18.37, liveFrom: 20.95, click: 21.702, retail: [21.952, 24.506], pick: 1, tileY: 545 },
      { from: 25.5, lastKey: 27.5, press: 27.93, liveFrom: 30.6, click: 31.312, retail: [31.562, 34.107], pick: 1, tileY: 495 },
      { from: 35.7, lastKey: 37.667, press: 38.03, hold: { at: 37.8, dur: 1.3 }, liveFrom: 41.7, click: 43.599, retail: [43.849, 45.897], pick: 3, tileY: 813, row1Y: 120 }
    ],
    stores: [
      { footage: 'mobile', crop: { x: 60, y: 96, w: 740, h: 1140 }, photo: { x: 52, y: 104, w: 346, h: 458 } },
      { footage: 'mobile', crop: { x: 60, y: 118, w: 740, h: 986 }, photo: { x: 52, y: 136, w: 346, h: 458 }, until: 24.48 },
      { footage: 'mobile', crop: { x: 0, y: 0, w: 800, h: 1200 }, photo: { x: 106, y: 474, w: 646, h: 616 } },
      /* the phone's Target page was still loading when it was filmed; the
         same page, from the same session's desktop recording, is shown.
         Target's store-location bar (a delivery postcode) is left out of
         the frame, here and on the desktop */
      { footage: 'desktop', crop: { x: 0, y: 50, w: 500, h: 710 }, photo: { x: 82, y: 418, w: 272, h: 338 }, time: [48.576, 51.006], until: 50.87 }
    ]
  }
};

/* stores[k].until: the last frame, in the footage, of the store's own
   page; measured, because the session logs leaving a few frames after
   the page has already gone back to Fynd */

/* the hi-res source of each chosen product's photograph: the phone
   recording's tile (its pixels are twice the desktop's) */
const PHOTOS = [
  { f: 9.0, rect: { x: 410, y: 495, w: 358, h: 448 } },
  { f: 20.95, rect: { x: 405, y: 545, w: 362, h: 447 } },
  /* the card's selection bar runs across this one's top: the photograph
     is taken from just under it, keeping the tile's proportions */
  { f: 30.6, rect: { x: 410, y: 495, w: 358, h: 448 }, inset: 0.065 },
  { f: 42.4, rect: { x: 410, y: 814, w: 358, h: 448 } }
];

/* a tile rect, less the photo's inset (a fraction of its height off
   the top, and the same share off the sides, so the shape is kept) */
function insetRect(r, f = 0) {
  return { x: r.x + r.w * f / 2, y: r.y + r.h * f, w: r.w * (1 - f), h: r.h * (1 - f) };
}
const photoRect = (k) => insetRect(PHOTOS[k].rect, PHOTOS[k].inset);

/* the opening question, set where each part of it is said (seconds
   into the line) */
const HOOK = {
  wide: [['Ever know exactly what you want,', 0.05], ['but not where to find it?', 1.45]],
  portrait: [['Ever know exactly', 0.05], ['what you want,', 0.55], ['but not where', 1.45], ['to find it?', 1.85]]
};

/* the words each request is made of, for the type that lifts out of it */
const WORDS = [
  ['BLACK', 'OVERSIZED', 'HOODIE', 'UNDER $80'],
  null,
  { title: 'BAPE', sub: 'Shark hoodie  ·  under $400' },
  ['Sage green', 'Linen', 'Midi dress', 'Under $120']
];

/* ---------------------------------------------------------
   Footage: the session's frames, decoded once
   --------------------------------------------------------- */

class Footage {
  constructor(name) {
    this.name = name;
    this.video = path.join(FOOTAGE, `${name}.session.mp4`);
    this.dir = path.join(os.tmpdir(), `fynd-film-frames-${name}`);
    this.cache = new Map();
  }
  prepare() {
    const stamp = path.join(this.dir, '.source');
    const size = fs.statSync(this.video).size;
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === String(size)) return;
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    console.log(`  unpacking ${path.basename(this.video)}…`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', this.video, '-q:v', '1', '-start_number', '0', path.join(this.dir, '%05d.jpg')]);
    fs.writeFileSync(stamp, String(size));
    this.count = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jpg')).length;
  }
  get frames() {
    if (!this.count) this.count = fs.readdirSync(this.dir).filter((f) => f.endsWith('.jpg')).length;
    return this.count;
  }
  async at(seconds) {
    const i = Math.max(0, Math.min(this.frames - 1, Math.round(seconds * FPS)));
    if (this.cache.has(i)) {
      const img = this.cache.get(i);
      this.cache.delete(i); this.cache.set(i, img);
      return img;
    }
    const img = await canvasLib().loadImage(path.join(this.dir, `${String(i).padStart(5, '0')}.jpg`));
    this.cache.set(i, img);
    if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value);
    return img;
  }
}

/* ---------------------------------------------------------
   Drawing
   --------------------------------------------------------- */

function rr(ctx, r, radius) {
  const k = Math.min(radius, r.w / 2, r.h / 2);
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, k);
}

/* the camera on the footage: what part of the page fills the frame */
function viewOf(fmt, cam) {
  const w = fmt.W / cam.z;
  const h = fmt.H / cam.z;
  return {
    z: cam.z,
    x: Math.min(Math.max(0, cam.cx - w / 2), fmt.W - w),
    y: Math.min(Math.max(0, cam.cy - h / 2), fmt.H - h),
    w, h
  };
}
const toScreen = (v, r) => ({ x: (r.x - v.x) * v.z, y: (r.y - v.y) * v.z, w: r.w * v.z, h: r.h * v.z });

/* The footage, through the camera. The session's recording carries its
   own caption strip along the bottom; it is painted out — the pages are
   white there, so a soft white edge is invisible — rather than avoided,
   so the camera is free to frame the page as it likes. */
function drawView(ctx, fmt, img, v) {
  ctx.drawImage(img, v.x, v.y, v.w, v.h, 0, 0, fmt.W, fmt.H);
  const edge = (fmt.mask - v.y) * v.z;
  if (edge < fmt.H) {
    const soft = 10 * v.z;
    const g = ctx.createLinearGradient(0, edge - soft, 0, edge);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, edge - soft, fmt.W, soft);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, edge, fmt.W, fmt.H - edge);
  }
}

/* a camera path: keys of {t, z, cx, cy}, eased between */
function cameraAt(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]; const b = keys[i + 1];
    if (t <= b.t) {
      const e = at(t, a.t, b.t, b.ease || EASE.inOut);
      return { z: lerp(a.z, b.z, e), cx: lerp(a.cx, b.cx, e), cy: lerp(a.cy, b.cy, e) };
    }
  }
  return keys[keys.length - 1];
}

function setFont(ctx, size, weight, spacing = 0) {
  ctx.font = `${weight} ${size}px Inter`;
  ctx.letterSpacing = `${spacing}px`;
}

/* a line of type rising into place from behind its own baseline */
function rise(ctx, str, x, y, { size, weight = 600, color = '#111', spacing = 0, align = 'left', p, alpha = 1, travel = 1 }) {
  if (p <= 0 || alpha <= 0) return;
  ctx.save();
  setFont(ctx, size, weight, spacing);
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  const w = ctx.measureText(str).width;
  const left = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  ctx.beginPath();
  ctx.rect(left - size, y - size * 1.02, w + size * 2, size * 1.32);
  ctx.clip();
  ctx.globalAlpha = alpha * Math.min(1, p * 1.6);
  ctx.fillStyle = color;
  ctx.fillText(str, x, y + (1 - p) * size * 1.08 * travel);
  ctx.restore();
}

function wrap(ctx, str, maxW) {
  const words = str.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxW && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/* a picture in a rounded frame, with an optional soft shadow */
function framed(ctx, img, src, dst, { radius = 14, alpha = 1, shadow = 0, dark = false } = {}) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (shadow > 0) {
    ctx.save();
    ctx.shadowColor = dark ? `rgba(0,0,0,${0.5 * shadow})` : `rgba(17,17,17,${0.16 * shadow})`;
    ctx.shadowBlur = 48 * shadow;
    ctx.shadowOffsetY = 22 * shadow;
    rr(ctx, dst, radius);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
  }
  rr(ctx, dst, radius);
  ctx.clip();
  ctx.drawImage(img, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
  ctx.restore();
}

/* ---------------------------------------------------------
   The product facts set in type: the search's own record
   --------------------------------------------------------- */

function facts() {
  const search = JSON.parse(fs.readFileSync(path.join(DEMO, 'demo-search.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(path.join(DEMO, 'demo-report.json'), 'utf8'));
  return search.searches.map((s, i) => {
    const opened = report.searches[i].opened.desktop;
    const idx = s.shown.findIndex((p) => p.href === opened.href);
    const p = s.shown[idx];
    const host = new URL(p.href).hostname.replace(/^www\d?\./, '');
    /* the listing's name, less a leading repeat of the brand */
    let name = p.name.replace(new RegExp(`^${p.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '');
    if (name.length > 46) name = `${name.slice(0, 46).replace(/\s+\S*$/, '')}…`;
    return { query: s.query, index: idx, brand: p.brand, name, price: p.price, host, href: p.href };
  });
}

/* ---------------------------------------------------------
   The edit: every moment of the film, placed
   --------------------------------------------------------- */

const D = {
  open: 4.9,         /* the opening, up to the first frame of live footage */
  reveal: 1.0,       /* results rising into place */
  anticipate: 0.6,   /* the others stepping back before the click */
  heroIn: 0.9,       /* the chosen product becoming the subject */
  hold: [0.55, 0.45, 0.95, 0.55],
  handoff: 0.95,     /* the product's frame opening onto the store */
  exit: 0.5,
  close: 6.2
};

function plan(fmtKey) {
  const fmt = FORMATS[fmtKey];
  const shots = [];
  const vo = [];
  const events = [];
  let t = D.open;
  vo.push({ key: 'hook', at: 0.75 });
  events.push({ type: 'open', at: 0 }, { type: 'reveal', at: 3.5 });

  fmt.searches.forEach((s, k) => {
    const shot = { k, s };
    shot.start = t;
    shot.dType = shot.start - s.from;                 /* film = session + dType while typing */
    shot.lastKey = s.lastKey + shot.dType;
    /* a held moment after the last key, for the words to be read */
    shot.holdAt = s.hold ? s.hold.at + shot.dType : Infinity;
    shot.holdDur = s.hold ? s.hold.dur : 0;
    /* Search: the frame the page first moves, which is a little before
       the session's own record of it */
    shot.submit = s.press + shot.dType + shot.holdDur;
    /* what happens between Search and live results differs per search */
    const between = [0.75, 0.2, 2.3, 0.5][k];
    shot.revealStart = shot.submit + between;
    shot.liveStart = shot.revealStart + D.reveal;
    shot.dLive = shot.liveStart - s.liveFrom;
    shot.click = s.click + shot.dLive;
    shot.heroStart = shot.click + 0.05;
    shot.heroEnd = shot.heroStart + D.heroIn;
    shot.handoff = shot.heroEnd + D.hold[k];
    const store = fmt.stores[k];
    const r0 = (store.time || s.retail)[0] + 0.15;
    /* the last frame of the store's own page: the session's record of
       leaving comes a few frames after the page has already gone */
    const r1 = Math.min((store.time || s.retail)[1] - 0.05, store.until || Infinity);
    shot.dStore = shot.handoff - r0;
    shot.storeEnd = r1 + shot.dStore;
    shot.end = shot.storeEnd;
    shots.push(shot);

    events.push({ type: 'typing', at: shot.start }, { type: 'submit', at: shot.submit },
      { type: 'results', at: shot.revealStart }, { type: 'select', at: shot.click },
      { type: 'store', at: shot.handoff }, { type: 'return', at: shot.storeEnd }, { type: 'search', at: shot.start, k });
    if (k === 0) {
      vo.push({ key: 'describe', at: shot.start + 0.75 });
      vo.push({ key: 'results', at: shot.liveStart + 0.1 });
      vo.push({ key: 'pick', at: shot.click + 0.12 });
    }
    if (k === 2) vo.push({ key: 'rare', at: shot.submit + 0.45 });
    if (k === 3) vo.push({ key: 'exact', at: shot.revealStart + 0.25 });
    t = shot.end + 0.02;
  });
  const close = { start: t + 0.05 };
  close.end = close.start + D.close;
  vo.push({ key: 'finale', at: close.start + FINALE_LEAD });
  events.push({ type: 'close', at: close.start });
  return { fmt, shots, close, vo, events, finaleSplit: finaleSplit(), duration: Math.round(close.end * FPS) / FPS };
}

/* the closing line starts this long into the close */
const FINALE_LEAD = 0.25;

/* where, in the close, "Fynd finds it." begins: the end of the pause
   between the closing line's two sentences */
function finaleSplit() {
  try {
    const { readWav, pausesIn } = require('./demo-audio');
    const manifest = JSON.parse(fs.readFileSync(path.join(DEMO, 'narration', 'manifest.json'), 'utf8'));
    const pauses = pausesIn(readWav(path.join(DEMO, 'narration', manifest.lines.finale.file)));
    return (pauses.length ? pauses[0].to : 1.95) + FINALE_LEAD;
  } catch (err) {
    return 2.2;
  }
}

/* ---------------------------------------------------------
   The film
   --------------------------------------------------------- */

class Film {
  constructor(fmtKey, data) {
    this.key = fmtKey;
    this.edit = plan(fmtKey);
    this.fmt = this.edit.fmt;
    this.data = data;
    this.footage = { desktop: new Footage('fynd-demo'), mobile: new Footage('fynd-demo-mobile') };
    this.own = fmtKey === 'desktop' ? this.footage.desktop : this.footage.mobile;
    this.phone = this.footage.mobile;
    const { createCanvas } = canvasLib();
    this.canvas = createCanvas(this.fmt.W, this.fmt.H);
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingQuality = 'high';
  }

  prepare() { Object.values(this.footage).forEach((f) => f.prepare()); }

  /* the session's time for a moment of a search's typing, holds included */
  typed(shot, t) {
    if (t < shot.holdAt) return t - shot.dType;
    if (t < shot.holdAt + shot.holdDur) return shot.holdAt - shot.dType;
    return t - shot.dType - shot.holdDur;
  }

  /* How many sub-frame renders a frame is averaged from: one while
     nothing moves fast, more the faster things travel, so a move reads as
     motion rather than as a row of copies. */
  samples(t) {
    const e = this.edit;
    const near = (a, b) => t >= a && t <= b;
    let n = 1;
    const want = (a, b, k) => { if (near(a, b)) n = Math.max(n, k); };
    want(3.3, 4.5, 5);
    want(4.1, e.shots[0].start + 0.4, 5);
    for (const s of e.shots) {
      want(s.lastKey + 0.05, s.lastKey + 1.0, 5);
      want(s.submit - 0.05, s.revealStart + 0.1, 9);
      want(s.revealStart, s.liveStart + 0.05, 5);
      want(s.click - D.anticipate, s.click + 0.05, 3);
      want(s.heroStart, s.heroEnd + 0.05, 9);
      want(s.heroEnd, s.heroEnd + 0.9, 3);
      want(s.handoff - 0.05, s.handoff + D.handoff + 0.05, 11);
      want(s.storeEnd - D.exit - 0.05, s.storeEnd + 0.05, 5);
      want(s.start - 0.05, s.start + 0.7, 3);
    }
    want(e.close.start - 0.1, e.close.start + 1.3, 5);
    want(e.close.start + 1.8, e.close.start + 3.0, 5);
    want(e.close.end - 2.3, e.close.end, 5);
    return n;
  }

  /* one frame, averaged over the shutter while things move */
  async frame(t) {
    const samples = this.samples(t);
    if (samples === 1) {
      await this.draw(t);
      return this.canvas.data();
    }
    const n = this.fmt.W * this.fmt.H * 4;
    const acc = new Float32Array(n);
    for (let i = 0; i < samples; i += 1) {
      /* a 180-degree shutter: half a frame, centred on the frame */
      await this.draw(t + ((i + 0.5) / samples - 0.5) / FPS * 0.4);
      const d = this.canvas.data();
      for (let j = 0; j < n; j += 1) acc[j] += d[j];
    }
    const out = Buffer.alloc(n);
    for (let j = 0; j < n; j += 1) out[j] = Math.round(acc[j] / samples);
    return out;
  }

  async draw(t) {
    const { ctx, fmt } = this;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, fmt.W, fmt.H);
    const e = this.edit;
    if (t < e.shots[0].start + 1.2) await this.opening(t);
    for (const s of e.shots) {
      if (t >= s.start - 0.6 && t <= s.end + 0.6) await this.search(s, t);
    }
    if (t >= e.close.start - 0.1) {
      if (!this.photoCache) this.photoCache = await Promise.all(PHOTOS.map((p) => this.phone.at(p.f)));
      this.closing(t);
    }
    ctx.restore();
  }

  /* ---------- the opening ---------- */

  async tilesOf(k) {
    /* the session's real result tiles for search k, taken from the phone
       recording: its photographs have twice the pixels, and no pointer
       is drawn over them */
    const m = FORMATS.mobile;
    const s = m.searches[k];
    const img = await this.phone.at(PHOTOS[k].f);
    const out = [];
    for (const x of m.tileX) out.push({ img, rect: { x: x + 1, y: PHOTOS[k].rect.y + 1, w: m.tileW - 2, h: m.tileH - 2 } });
    if (s.row1Y !== undefined) for (const x of m.tileX) out.push({ img, rect: { x: x + 1, y: s.row1Y + 60, w: m.tileW - 2, h: m.tileH - 108 } });
    return out;
  }

  async opening(t) {
    const { ctx, fmt } = this;
    const e = this.edit;
    const s1 = e.shots[0];
    const W = fmt.W; const H = fmt.H;
    const portrait = H > W;
    if (!this.cloud) {
      /* The session's real product photographs, in three depths, on a
         slow sideways drift — far ones small, soft and slow, near ones
         larger, sharp and quicker — with the middle of the frame left
         open for what comes next. */
      const pool = [];
      for (let k = 0; k < 4; k += 1) pool.push(...(await this.tilesOf(k)));
      const pick = (i) => pool[(i * 7 + 2) % pool.length];
      const planes = portrait
        ? [
          { depth: 0, scale: 0.36, blur: 5, alpha: 0.42, speed: 14, spots: [[0.08, 0.06], [0.52, 0.04], [0.94, 0.14], [0.02, 0.52], [0.98, 0.58], [0.3, 0.94], [0.8, 0.96]] },
          { depth: 1, scale: 0.52, blur: 2, alpha: 0.72, speed: 26, spots: [[0.3, 0.16], [0.8, 0.3], [0.14, 0.76], [0.72, 0.82]] },
          { depth: 2, scale: 0.7, blur: 0, alpha: 1, speed: 44, spots: [[0.66, 0.1], [0.22, 0.32], [0.86, 0.7]] }
        ]
        : [
          { depth: 0, scale: 0.34, blur: 5, alpha: 0.42, speed: 16, spots: [[0.04, 0.16], [0.3, 0.06], [0.62, 0.1], [0.96, 0.22], [0.12, 0.88], [0.46, 0.94], [0.82, 0.9]] },
          { depth: 1, scale: 0.5, blur: 2, alpha: 0.74, speed: 30, spots: [[0.2, 0.3], [0.78, 0.28], [0.36, 0.84], [1.02, 0.74]] },
          { depth: 2, scale: 0.72, blur: 0, alpha: 1, speed: 52, spots: [[0.08, 0.6], [0.56, 0.22], [0.9, 0.52]] }
        ];
      let n = 0;
      this.cloud = [];
      for (const pl of planes) {
        for (const [x, y] of pl.spots) {
          this.cloud.push({ ...pl, tile: pick(n), x: x * W, y: y * H, wob: n * 1.7 });
          n += 1;
        }
      }
    }
    const fadeIn = at(t, 0.05, 1.6, EASE.soft);
    const away = at(t, 3.4, 4.75, EASE.inOut);
    /* while the question is asked, the field steps back behind it */
    const ask = this.edit.vo.find((l) => l.key === 'hook').at;
    const glow = at(t, ask - 0.3, ask + 0.5, EASE.soft) * (1 - at(t, 3.35, 3.9, EASE.inOut));
    for (const c of this.cloud) {
      const sc = (portrait ? 0.95 : 1) * c.scale * (1 + 0.04 * at(t, 0, 4.8, EASE.linear)) * (1 - 0.08 * away);
      const w = c.tile.rect.w * sc;
      const h = c.tile.rect.h * sc;
      /* the drift: a slow truck to the left, each depth at its own pace */
      const dx = -c.speed * t + 2.5 * Math.sin(t * 0.5 + c.wob);
      const dy = 3 * Math.cos(t * 0.4 + c.wob) * (c.depth + 1);
      /* receding: towards the centre, softening */
      const cx = W / 2 + (c.x + dx + c.speed * 2.4 - W / 2) * (1 + away * 0.12 * (c.depth + 1));
      const cy = H / 2 + (c.y + dy - H / 2) * (1 + away * 0.12 * (c.depth + 1));
      const blur = c.blur + away * (4 + c.depth * 3) + glow * 2.5;
      ctx.filter = blur > 0.3 ? `blur(${blur.toFixed(1)}px)` : 'none';
      framed(ctx, c.tile.img, c.tile.rect, { x: cx - w / 2, y: cy - h / 2, w, h }, { radius: 12 * sc, alpha: fadeIn * c.alpha * (1 - away) * (1 - 0.5 * glow) });
    }
    ctx.filter = 'none';

    /* The question, as it is asked — quiet type over a clearing in the
       field, for anyone watching with the sound off — lifting away as
       the search field opens */
    const lines = portrait ? HOOK.portrait : HOOK.wide;
    const size = portrait ? 60 : 44;
    const lead = size * 1.22;
    const leave = at(t, 3.3, 3.7, EASE.in);
    /* above where the search field will open */
    const top = H * (portrait ? 0.34 : 0.42) - ((lines.length - 1) * lead) / 2 + size * 0.35;
    if (glow > 0) {
      const r = portrait ? W * 0.6 : W * 0.36;
      const cyG = top - size * 0.35 + ((lines.length - 1) * lead) / 2;
      const g = ctx.createRadialGradient(W / 2, cyG, 0, W / 2, cyG, r);
      g.addColorStop(0, `rgba(255,255,255,${0.94 * glow})`);
      g.addColorStop(0.6, `rgba(255,255,255,${0.8 * glow})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      ctx.translate(W / 2, cyG); ctx.scale(1, portrait ? 0.62 : 0.3); ctx.translate(-W / 2, -cyG);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    lines.forEach(([text, from], i) => {
      const p = at(t, ask + from, ask + from + 0.7, EASE.out);
      if (p <= 0 || leave >= 1) return;
      rise(ctx, text, W / 2, top + i * lead - leave * 18, { size, weight: 600, spacing: -size * 0.02, align: 'center', p, alpha: 1 - leave, color: '#111' });
    });

    /* The real search field opens where it lives on the page, and the
       page comes up around it. */
    if (t >= 3.5) {
      const v = viewOf(fmt, cameraAt(this.typingCamera(s1), Math.max(t, s1.start)));
      const box = toScreen(v, fmt.box);
      const open = at(t, 3.55, 4.4, EASE.out);
      const page = at(t, 4.0, s1.start + 0.1, EASE.inOut);
      const src = await this.own.at(Math.max(0.1, t - s1.dType));
      if (page > 0) {
        ctx.save();
        ctx.globalAlpha = page;
        drawView(ctx, fmt, src, v);
        ctx.restore();
      }
      if (page < 1) {
        const w = box.w * open;
        const mask = { x: box.x + (box.w - w) / 2, y: box.y, w, h: box.h };
        ctx.save();
        ctx.globalAlpha = (1 - page) * Math.min(1, open * 2);
        ctx.shadowColor = 'rgba(17,17,17,0.10)';
        ctx.shadowBlur = 40;
        ctx.shadowOffsetY = 14;
        rr(ctx, { x: mask.x + 10 * v.z, y: mask.y + 10 * v.z, w: Math.max(0, mask.w - 20 * v.z), h: mask.h - 20 * v.z }, 14 * v.z);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = 1;
        rr(ctx, mask, 18 * v.z);
        ctx.clip();
        ctx.drawImage(src, fmt.box.x, fmt.box.y, fmt.box.w, fmt.box.h, box.x, box.y, box.w, box.h);
        ctx.restore();
      }
    }
  }

  typingCamera(shot) {
    const { fmt } = this;
    const k = shot.k;
    const desk = fmt.W > fmt.H;
    const bx = fmt.box.x + fmt.box.w / 2;
    const by = fmt.box.y + fmt.box.h / 2;
    if (desk) {
      if (k === 0) return [
        { t: shot.start, z: 1.08, cx: bx, cy: by - 150 },
        { t: shot.lastKey, z: 1.4, cx: bx, cy: by - 112, ease: EASE.soft }
      ];
      if (k === 2) return [
        { t: shot.start, z: 1.56, cx: bx, cy: by - 8 },
        { t: shot.submit, z: 1.62, cx: bx, cy: by - 8, ease: EASE.soft }
      ];
      if (k === 3) return [
        { t: shot.start, z: 1.26, cx: bx, cy: by - 120 },
        { t: shot.lastKey, z: 1.34, cx: bx, cy: by - 104, ease: EASE.soft }
      ];
      return [{ t: shot.start, z: 1.2, cx: bx, cy: by }, { t: shot.submit, z: 1.24, cx: bx, cy: by }];
    }
    if (k === 0) return [
      { t: shot.start, z: 1.0, cx: 400, cy: by - 160 },
      { t: shot.lastKey, z: 1.06, cx: 400, cy: by - 210, ease: EASE.soft }
    ];
    if (k === 2) return [
      { t: shot.start, z: 1.06, cx: 400, cy: by },
      { t: shot.submit, z: 1.08, cx: 400, cy: by, ease: EASE.soft }
    ];
    if (k === 3) return [
      { t: shot.start, z: 1.02, cx: 400, cy: by - 190 },
      { t: shot.lastKey, z: 1.05, cx: 400, cy: by - 200, ease: EASE.soft }
    ];
    return [{ t: shot.start, z: 1.04, cx: 400, cy: by }, { t: shot.submit, z: 1.06, cx: 400, cy: by }];
  }

  /* ---------- one search, start to store ---------- */

  /* the camera from the moment Search is pressed: it eases back to the
     results as the page goes to them (BAPE: it stays, the stage covers) */
  camAfterSubmit(shot, t) {
    const cam = cameraAt(this.typingCamera(shot), Math.min(t, shot.submit));
    if (shot.k === 2 || t <= shot.submit) return cam;
    const back = at(t, shot.submit, shot.revealStart, EASE.inOut);
    const r = this.fmt.view.results;
    return { z: lerp(cam.z, r.z, back), cx: lerp(cam.cx, r.cx, back), cy: lerp(cam.cy, r.cy, back) };
  }

  async search(shot, t) {
    const { ctx, fmt } = this;
    const k = shot.k;

    /* --- typing, and Search --- */
    if (t >= shot.start && t < shot.revealStart + 0.05) {
      if (k === 1) await this.commandBar(shot, t);
      else {
        const v = viewOf(fmt, this.camAfterSubmit(shot, t));
        /* BAPE: the stage comes up over the request as it was typed, not
           over the page already leaving for its results */
        const tt = k === 2 ? Math.min(t, shot.submit - 1 / FPS) : t;
        const img = await this.own.at(Math.max(shot.s.from, this.typed(shot, tt)));
        ctx.save();
        /* after a store, the next request comes up out of white */
        ctx.globalAlpha = k === 0 ? 1 : at(t, shot.start, shot.start + 0.35, EASE.soft);
        drawView(ctx, fmt, img, v);
        ctx.restore();
        /* BAPE's close framing would cut the page's headline at the top
           edge: the top of the frame softens to white instead */
        if (k === 2 && fmt.W > fmt.H) {
          const g = ctx.createLinearGradient(0, 0, 0, fmt.H * 0.34);
          g.addColorStop(0, 'rgba(255,255,255,1)');
          g.addColorStop(0.55, 'rgba(255,255,255,0.97)');
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, fmt.W, fmt.H * 0.34);
        }
        if (k === 0) this.kinetic(shot, t, v, 'stack');
        if (k === 3) this.kinetic(shot, t, v, 'soft');
      }
    }
    /* --- results rising into place --- */
    if (t >= shot.revealStart && t < shot.liveStart) await this.reveal(shot, t);
    /* BAPE's stage, over the typed request and then lifting off the
       results as they rise */
    if (k === 2 && t >= shot.submit - 0.05 && t < shot.liveStart + 0.6) this.darkTitle(shot, t);

    /* --- live results, the choice, the click --- */
    if (t >= shot.liveStart && t < shot.heroStart + D.heroIn * 0.7) {
      const img = await this.own.at(Math.min(t, shot.click) - shot.dLive);
      const v = viewOf(fmt, this.resultsCamera(shot, t));
      drawView(ctx, fmt, img, v);
      await this.choose(shot, t, img, v);
    }
    if (t >= shot.heroStart && t < shot.handoff + D.handoff + 0.05) await this.hero(shot, t);
    if (t >= shot.handoff && t <= shot.storeEnd + 0.05) await this.store(shot, t);
  }

  /* while results are on screen: an almost imperceptible push */
  resultsCamera(shot, t) {
    const r = this.fmt.view.results;
    const p = at(t, shot.liveStart, shot.click, EASE.soft);
    return { z: r.z * (1 + 0.025 * p), cx: r.cx, cy: r.cy };
  }

  /* The request's own words, lifted out of the field as type: the
     hoodie's as a stack of capitals, the dress's softer, from the left.
     On Search they fall into the line that answers them — the results'
     "Results for …". */
  kinetic(shot, t, v, style) {
    const { ctx, fmt } = this;
    const desk = fmt.W > fmt.H;
    const words = style === 'stack' ? WORDS[0] : WORDS[3];
    const t0 = shot.lastKey + 0.12;
    if (t < t0 - 0.2) return;
    /* the words wait for the field behind them to clear */
    const w0 = t0 + 0.12;
    const fold = at(t, shot.submit - 0.24, shot.submit + 0.3, EASE.inOut);
    const box = toScreen(v, fmt.box);
    const vStart = viewOf(fmt, cameraAt(this.typingCamera(shot), shot.submit));
    const boxAtSubmit = toScreen(vStart, fmt.box);
    const size = style === 'stack' ? fmt.type.caps : (desk ? 52 : 66);
    const lead = style === 'stack' ? fmt.type.capsLead : (desk ? 62 : 82);
    const left = (fmt.boxText.x - vStart.x) * vStart.z;
    const bottom = boxAtSubmit.y - (desk ? 44 : 60);
    /* a clean field behind the type: the page above the search box goes
       quietly white while the words are there */
    const veil = at(t, t0 - 0.2, t0 + 0.2, EASE.inOut) * (1 - at(t, shot.submit, shot.submit + 0.4, EASE.inOut));
    if (veil > 0) {
      const g = ctx.createLinearGradient(0, box.y - 26, 0, box.y + 6);
      ctx.save();
      ctx.globalAlpha = veil;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, fmt.W, Math.max(0, box.y - 26));
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, box.y - 26, fmt.W, 32);
      ctx.restore();
    }
    const colors = style === 'stack' ? ['#111', '#111', '#111', '#8A8A87'] : ['#5F7158', '#111', '#111', '#8A8A87'];
    words.forEach((w, i) => {
      const y = bottom - (words.length - 1 - i) * lead;
      if (fold <= 0) {
        if (style === 'stack') {
          const p = at(t, w0 + i * 0.1, w0 + i * 0.1 + 0.62, EASE.out);
          rise(ctx, w, left, y, { size, weight: 600, spacing: size * 0.015, p, color: colors[i] });
        } else {
          const p = at(t, w0 + i * 0.15, w0 + i * 0.15 + 0.8, EASE.out);
          if (p <= 0) return;
          ctx.save();
          ctx.globalAlpha = p;
          setFont(ctx, size, i === 0 ? 500 : 400, -size * 0.01);
          ctx.fillStyle = colors[i];
          ctx.fillText(w, left - (1 - p) * 28, y);
          ctx.restore();
        }
        return;
      }
      /* released: each word lifts a little and dissolves, in turn */
      const f = at(t, shot.submit - 0.24 + i * 0.035, shot.submit + 0.02 + i * 0.035, EASE.in);
      ctx.save();
      ctx.globalAlpha = 1 - f;
      setFont(ctx, size, style === 'stack' ? 600 : (i === 0 ? 500 : 400), style === 'stack' ? size * 0.015 : -size * 0.01);
      ctx.fillStyle = colors[i];
      ctx.fillText(w, left, y - f * size * 0.5);
      ctx.restore();
    });
  }

  /* the jacket: the hoodie grid stays, ghosted, and the real search
     field floats over it; on Search the field becomes the results'
     heading and the grid re-forms */
  async commandBar(shot, t) {
    const { ctx, fmt } = this;
    const prev = this.edit.shots[0];
    const desk = fmt.W > fmt.H;
    const v = viewOf(fmt, fmt.view.results);
    const ghostIn = at(t, shot.start, shot.start + 0.5, EASE.out);
    const old = await this.own.at(prev.s.liveFrom + 0.3);
    this.tileRects(prev.s, true).forEach((tr, i) => {
      const sr = toScreen(v, { ...tr, h: Math.min(tr.h, fmt.mask - tr.y) });
      const d = at(t, shot.submit + i * 0.06, shot.submit + i * 0.06 + 0.5, EASE.in);
      const dst = { ...sr, y: sr.y + d * (desk ? 46 : 66) };
      framed(ctx, old, { ...tr, h: Math.min(tr.h, fmt.mask - tr.y) }, dst, { radius: 0, alpha: 0.18 * ghostIn * (1 - d) });
    });
    const live = await this.own.at(this.typed(shot, Math.min(t, shot.submit - 0.04)));
    const scale = desk ? 1.08 : 1;
    const w = fmt.box.w * scale; const h = fmt.box.h * scale;
    const appear = at(t, shot.start + 0.1, shot.start + 0.65, EASE.out);
    const header = toScreen(v, fmt.header);
    const leave = at(t, shot.submit + 0.05, shot.revealStart + 0.3, EASE.inOut);
    const x = lerp(fmt.W / 2 - w / 2, header.x, leave);
    const y = lerp((desk ? 118 : 230) - 20 * (1 - appear), header.y, leave);
    const sc = lerp(1, 0.6, leave);
    const alpha = appear * (1 - at(t, shot.submit + 0.15, shot.revealStart + 0.25, EASE.inOut));
    if (alpha > 0) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = 'rgba(17,17,17,0.13)';
      ctx.shadowBlur = 46;
      ctx.shadowOffsetY = 18;
      rr(ctx, { x: x + 9 * sc, y: y + 9 * sc, w: (w - 18) * sc, h: (h - 18) * sc }, (desk ? 18 : 30) * sc);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(live, fmt.box.x, fmt.box.y, fmt.box.w, fmt.box.h, x, y, w * sc, h * sc);
      ctx.restore();
    }
  }

  tileRects(s, withText = false) {
    const fmt = this.fmt;
    const rows = this.key === 'mobile' && s.row1Y !== undefined ? [s.row1Y, s.tileY] : [s.tileY];
    const out = [];
    for (const y of rows) for (const x of fmt.tileX) out.push({ x, y, w: fmt.tileW, h: withText ? fmt.cardH : fmt.tileH });
    return out;
  }

  /* results: the real cards rise into their places, one after another */
  async reveal(shot, t) {
    const { ctx, fmt } = this;
    const k = shot.k;
    const s = shot.s;
    const desk = fmt.W > fmt.H;
    const v = viewOf(fmt, fmt.view.results);
    const still = await this.own.at(s.liveFrom);
    /* the page around the cards: for the jacket it comes up as the bar
       becomes its heading */
    ctx.save();
    ctx.globalAlpha = k === 1 ? at(t, shot.revealStart - 0.1, shot.revealStart + 0.35, EASE.inOut) : 1;
    drawView(ctx, fmt, still, v);
    ctx.restore();
    const cards = this.tileRects(s, true);
    for (const c of cards) {
      const sc = toScreen(v, c);
      ctx.fillStyle = '#fff';
      ctx.fillRect(sc.x - 6, sc.y - 6, sc.w + 12, sc.h + 12);
    }
    if (k === 1) {
      /* the hoodies leaving, under the jackets arriving */
      const prev = this.edit.shots[0];
      const old = await this.own.at(prev.s.liveFrom + 0.3);
      this.tileRects(prev.s, true).forEach((tr, i) => {
        const d = at(t, shot.submit + i * 0.06, shot.submit + i * 0.06 + 0.5, EASE.in);
        if (d >= 1) return;
        const src = { ...tr, h: Math.min(tr.h, fmt.mask - tr.y) };
        const sr = toScreen(v, src);
        framed(ctx, old, src, { ...sr, y: sr.y + d * (desk ? 46 : 66) }, { radius: 0, alpha: 0.18 * (1 - d) });
      });
    }
    cards.forEach((c, i) => {
      const order = desk ? i : (i % 2) + Math.floor(i / 2) * 1.4;
      const t0 = shot.revealStart + order * (k === 3 ? 0.11 : 0.08);
      const p = at(t, t0, t0 + D.reveal * 0.72, EASE.out);
      if (p <= 0) return;
      const src = { ...c, h: Math.min(c.h, fmt.mask - c.y) };
      const sc = toScreen(v, src);
      let dst;
      let alpha = Math.min(1, p * 1.5);
      if (k === 3) {
        const g = lerp(1.04, 1, p);
        dst = { x: sc.x + sc.w * (1 - g) / 2, y: sc.y + sc.h * (1 - g) / 2, w: sc.w * g, h: sc.h * g };
        alpha = p;
      } else if (k === 1) {
        dst = { ...sc, y: sc.y - (1 - p) * (desk ? 46 : 66) };
      } else {
        dst = { ...sc, y: sc.y + (1 - p) * (desk ? 42 : 62) };
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(still, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
      ctx.restore();
    });
  }

  /* BAPE: the request becomes a title on a dark stage */
  darkTitle(shot, t) {
    const { ctx, fmt } = this;
    const desk = fmt.W > fmt.H;
    const W = fmt.W; const H = fmt.H;
    const grow = at(t, shot.submit - 0.04, shot.submit + 0.46, EASE.inOut);
    const fade = at(t, shot.revealStart - 0.05, shot.revealStart + 0.5, EASE.inOut);
    if (grow <= 0 || fade >= 1) return;
    /* from the Search button, the stage comes up as a widening circle */
    const v = viewOf(fmt, cameraAt(this.typingCamera(shot), shot.submit));
    const btn = desk ? toScreen(v, { x: 911, y: 501, w: 99, h: 48 }) : toScreen(v, { x: 62, y: 804, w: 692, h: 100 });
    const ox = btn.x + btn.w / 2; const oy = btn.y + btn.h / 2;
    const rMax = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy)) + 4;
    ctx.save();
    ctx.globalAlpha = 1 - fade;
    ctx.beginPath();
    ctx.arc(ox, oy, Math.max(0.1, rMax * grow), 0, Math.PI * 2);
    ctx.fillStyle = '#0B0B0C';
    ctx.fill();
    ctx.restore();
    /* the title goes before the stage does, so it is never seen over
       the results */
    const out = at(t, shot.revealStart - 0.45, shot.revealStart, EASE.in);
    const size = fmt.type.title;
    const t0 = shot.submit + 0.4;
    const cx = W / 2;
    const cy = H / 2 + size * 0.3;
    setFont(ctx, size, 700, -size * 0.02);
    const title = WORDS[2].title;
    const total = ctx.measureText(title).width;
    let x = cx - total / 2;
    for (let i = 0; i < title.length; i += 1) {
      const ch = title[i];
      setFont(ctx, size, 700, -size * 0.02);
      const w = ctx.measureText(ch).width;
      const p = at(t, t0 + i * 0.07, t0 + i * 0.07 + 0.75, EASE.out);
      if (p > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - 6, cy - size * 1.02, w + 12, size * 1.2);
        ctx.clip();
        ctx.globalAlpha = (1 - out) * Math.min(1, p * 1.5);
        ctx.fillStyle = '#F4F4F2';
        ctx.fillText(ch, x, cy + (1 - p) * size * 1.05 - out * size * 0.12);
        ctx.restore();
      }
      x += w;
    }
    rise(ctx, WORDS[2].sub, cx, cy + (desk ? 66 : 92), { size: desk ? 24 : 34, weight: 500, color: '#9C9C99', align: 'center', p: at(t, t0 + 0.4, t0 + 1.05, EASE.out), alpha: 1 - out, spacing: 0.3 });
  }

  /* the others step back; the chosen card comes forward; the click */
  async choose(shot, t, img, v) {
    const { ctx, fmt } = this;
    const s = shot.s;
    const p = at(t, shot.click - D.anticipate, shot.click, EASE.inOut);
    const out = at(t, shot.heroStart, shot.heroStart + D.heroIn * 0.6, EASE.inOut);
    if (p <= 0 && out <= 0) return;
    const card = this.tileRects(s, true)[s.pick];
    const src = { ...card, h: Math.min(card.h, fmt.mask - card.y) };
    const sc = toScreen(v, src);
    ctx.save();
    ctx.fillStyle = `rgba(255,255,255,${0.66 * p + 0.34 * out})`;
    ctx.fillRect(0, 0, fmt.W, fmt.H);
    ctx.restore();
    const press = t > shot.click ? Math.sin(clamp01((t - shot.click) / 0.2) * Math.PI) * 0.012 : 0;
    const g = 1 + 0.03 * p - press;
    const dst = { x: sc.x + sc.w * (1 - g) / 2, y: sc.y + sc.h * (1 - g) / 2, w: sc.w * g, h: sc.h * g };
    framed(ctx, img, src, dst, { radius: 3, alpha: 1 - out, shadow: p * 0.75 });
  }

  /* where the chosen product and its facts sit: the two as one group,
     centred; alternate searches mirror it */
  heroLayout(k) {
    const { fmt } = this;
    const desk = fmt.W > fmt.H;
    const hw = fmt.hero.w; const hh = fmt.hero.h;
    if (!desk) {
      return { photo: { x: (fmt.W - hw) / 2, y: 170, w: hw, h: hh }, text: { x: fmt.W / 2, y: 170 + hh + 100, align: 'center', width: 640 } };
    }
    const col = 400; const gap = 72;
    const left = (fmt.W - (hw + gap + col)) / 2;
    const y = (fmt.H - hh) / 2;
    if (k % 2 === 1) return { photo: { x: left + col + gap, y, w: hw, h: hh }, text: { x: left, y: y + hh / 2, align: 'left', width: col } };
    return { photo: { x: left, y, w: hw, h: hh }, text: { x: left + hw + gap, y: y + hh / 2, align: 'left', width: col } };
  }

  /* the chosen product, as the subject: its photograph, and its facts */
  async hero(shot, t) {
    const { ctx, fmt } = this;
    const k = shot.k;
    const s = shot.s;
    const desk = fmt.W > fmt.H;
    const dark = k === 2;
    const f = this.data[k];
    const inP = at(t, shot.heroStart, shot.heroEnd, EASE.inOut);
    const hand = at(t, shot.handoff, shot.handoff + D.handoff, EASE.inOut);
    /* the stage: white, or for BAPE, going dark */
    const stage = at(t, shot.heroStart, shot.heroStart + 0.55, EASE.inOut);
    const L = this.heroLayout(k);
    ctx.save();
    ctx.globalAlpha = stage;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, fmt.W, fmt.H);
    ctx.restore();
    if (dark) {
      /* BAPE's stage opens out of the product, as its title did out of
         the Search button */
      const iris = at(t, shot.heroStart + 0.05, shot.heroStart + 0.75, EASE.inOut);
      const ox = L.photo.x + L.photo.w / 2; const oy = L.photo.y + L.photo.h / 2;
      const rMax = Math.hypot(Math.max(ox, fmt.W - ox), Math.max(oy, fmt.H - oy)) + 4;
      ctx.save();
      ctx.beginPath();
      ctx.arc(ox, oy, Math.max(0.1, rMax * iris), 0, Math.PI * 2);
      ctx.fillStyle = '#0B0B0C';
      ctx.fill();
      ctx.restore();
    }
    const from = insetRect(toScreen(viewOf(fmt, this.resultsCamera(shot, shot.click)), { x: fmt.tileX[s.pick % fmt.tileX.length], y: s.tileY, w: fmt.tileW, h: fmt.tileH }), PHOTOS[k].inset);
    const breathe = 1 + 0.02 * at(t, shot.heroEnd, shot.handoff + D.handoff, EASE.soft);
    let r = lerpRect(from, L.photo, inP);
    r = { x: r.x - r.w * (breathe - 1) / 2, y: r.y - r.h * (breathe - 1) / 2, w: r.w * breathe, h: r.h * breathe };
    shot.heroRect = r;
    if (hand <= 0) {
      const photo = await this.phone.at(PHOTOS[k].f);
      const low = await this.own.at(shot.click - shot.dLive);
      const lowRect = insetRect({ x: fmt.tileX[s.pick % fmt.tileX.length], y: s.tileY, w: fmt.tileW, h: fmt.tileH }, PHOTOS[k].inset);
      const crisp = desk ? at(t, shot.heroStart, shot.heroStart + 0.4, EASE.inOut) : 1;
      const radius = lerp(4, desk ? 18 : 26, inP);
      framed(ctx, low, lowRect, r, { radius, alpha: 1 - crisp, shadow: inP, dark });
      framed(ctx, photo, photoRect(k), r, { radius, alpha: crisp, shadow: crisp * inP, dark });
    }
    /* the facts */
    if (t < shot.handoff + 0.35) {
      const leave = at(t, shot.handoff - 0.05, shot.handoff + 0.3, EASE.in);
      const ink = dark ? '#F4F4F2' : '#111111';
      const mute = dark ? '#9C9C99' : '#6B6B6B';
      /* on the phone the facts sit under the photograph, so they wait
         for it to arrive */
      const t0 = shot.heroStart + (desk ? 0.45 : 0.62);
      const alpha = 1 - leave;
      const T = L.text;
      const sz = desk ? { brand: 20, name: 34, nameLead: 42, price: 44, host: 18 } : { brand: 30, name: 46, nameLead: 56, price: 60, host: 28 };
      setFont(ctx, sz.name, 600, -sz.name * 0.015);
      const lines = wrap(ctx, f.name, T.width).slice(0, 2);
      const blockH = sz.brand + 22 + lines.length * sz.nameLead + 30 + sz.price + 18 + sz.host;
      let y = desk ? T.y - blockH / 2 + sz.brand : T.y;
      const dx = -18 * leave;
      rise(ctx, f.brand, T.x + dx, y, { size: sz.brand, weight: 600, color: mute, align: T.align, p: at(t, t0, t0 + 0.6, EASE.out), alpha });
      y += 22 + sz.nameLead * 0.95;
      lines.forEach((ln, i) => {
        rise(ctx, ln, T.x + dx, y, { size: sz.name, weight: 600, color: ink, spacing: -sz.name * 0.015, align: T.align, p: at(t, t0 + 0.07 + i * 0.05, t0 + 0.7 + i * 0.05, EASE.out), alpha });
        y += sz.nameLead;
      });
      y += 30 + sz.price * 0.55;
      rise(ctx, f.price, T.x + dx, y, { size: sz.price, weight: 700, color: ink, spacing: -sz.price * 0.015, align: T.align, p: at(t, t0 + 0.18, t0 + 0.82, EASE.out), alpha });
      y += 18 + sz.host * 1.2;
      rise(ctx, f.host, T.x + dx, y, { size: sz.host, weight: 500, color: mute, align: T.align, p: at(t, t0 + 0.26, t0 + 0.9, EASE.out), alpha });
    }
  }

  /* the store: the product's frame opens onto its real page */
  async store(shot, t) {
    const { ctx, fmt } = this;
    const k = shot.k;
    const dark = k === 2;
    const desk = fmt.W > fmt.H;
    const st = fmt.stores[k];
    const footage = st.footage === 'desktop' ? this.footage.desktop : this.footage.mobile;
    const page = await footage.at(Math.min(t, shot.storeEnd) - shot.dStore);
    const open = at(t, shot.handoff, shot.handoff + D.handoff, EASE.inOut);
    const leave = at(t, shot.storeEnd - D.exit, shot.storeEnd, EASE.in);
    /* the window: its size depends on the page's own shape */
    let win = { ...fmt.window };
    const aspect = st.crop.w / st.crop.h;
    if (win.w / win.h < aspect) {
      const h = win.w / aspect;
      win = { x: win.x, y: win.y + (win.h - h) / 2, w: win.w, h };
    }
    const hero = shot.heroRect || win;
    const mask = lerpRect(hero, win, open);
    /* the page: from where its product photo lies on the hero, to the window */
    /* the page's own photograph laid over the hero's: same centre, same
       height, so the product stays where the eye already is */
    const s0 = hero.h / st.photo.h;
    const pcx = st.photo.x - st.crop.x + st.photo.w / 2;
    const pcy = st.photo.y - st.crop.y + st.photo.h / 2;
    const p0 = { x: hero.x + hero.w / 2 - pcx * s0, y: hero.y + hero.h / 2 - pcy * s0, s: s0 };
    const s1 = win.w / st.crop.w;
    const p1 = { x: win.x, y: win.y, s: s1 };
    const s = lerp(p0.s, p1.s, open);
    const px = lerp(p0.x, p1.x, open);
    const py = lerp(p0.y, p1.y, open);
    const g = 1 - 0.035 * leave;
    const cx = fmt.W / 2; const cy = win.y + win.h / 2;
    /* BAPE's store opens on the dark stage, which lifts as it leaves */
    if (dark) {
      ctx.save();
      ctx.globalAlpha = 1 - at(t, shot.storeEnd - D.exit * 0.8, shot.storeEnd, EASE.inOut);
      ctx.fillStyle = '#0B0B0C';
      ctx.fillRect(0, 0, fmt.W, fmt.H);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = 1 - leave;
    ctx.translate(cx, cy); ctx.scale(g, g); ctx.translate(-cx, -cy);
    /* the window's shadow and edge */
    ctx.save();
    ctx.shadowColor = dark ? 'rgba(0,0,0,0.6)' : 'rgba(17,17,17,0.16)';
    ctx.shadowBlur = 56;
    ctx.shadowOffsetY = 24;
    rr(ctx, mask, lerp(16, desk ? 18 : 28, open));
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
    ctx.save();
    rr(ctx, mask, lerp(16, desk ? 18 : 28, open));
    ctx.clip();
    ctx.drawImage(page, st.crop.x, st.crop.y, st.crop.w, st.crop.h, px, py, st.crop.w * s, st.crop.h * s);
    /* the hero's photograph dissolving into the page's own */
    const photoFade = 1 - at(t, shot.handoff, shot.handoff + D.handoff * 0.22, EASE.soft);
    if (photoFade > 0) {
      const photo = await this.phone.at(PHOTOS[k].f);
      const r = lerpRect(hero, { x: px + (st.photo.x - st.crop.x) * s, y: py + (st.photo.y - st.crop.y) * s, w: st.photo.w * s, h: st.photo.h * s }, open);
      ctx.globalAlpha = (1 - leave) * photoFade;
      const pr = photoRect(k);
      ctx.drawImage(photo, pr.x, pr.y, pr.w, pr.h, r.x, r.y, r.w, r.w * pr.h / pr.w);
    }
    ctx.restore();
    ctx.save();
    rr(ctx, mask, lerp(16, desk ? 18 : 28, open));
    ctx.lineWidth = 1;
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    ctx.stroke();
    ctx.restore();
    ctx.restore();
    /* where you are: the store's own address, quietly, under the window */
    const label = at(t, shot.handoff + D.handoff * 0.6, shot.handoff + D.handoff + 0.4, EASE.out) * (1 - leave);
    if (label > 0) {
      const y = desk ? Math.min(fmt.labelY, win.y + win.h + 34) : win.y + win.h + 62;
      rise(ctx, this.data[k].host, fmt.W / 2, y, { size: desk ? 17 : 28, weight: 500, color: dark ? '#9C9C99' : '#6B6B6B', align: 'center', p: label, spacing: 0.2 });
    }
  }

  /* ---------- the close ----------
     "Describe what you want." — under it, the four requests the film
     made, as they were typed. "Fynd finds it." — the requests give way
     to the four products they found. Then the mark, and white. */

  closing(t) {
    const { ctx, fmt } = this;
    const c = this.edit.close;
    const desk = fmt.W > fmt.H;
    const W = fmt.W; const H = fmt.H;
    const inP = at(t, c.start - 0.1, c.start + 0.3, EASE.inOut);
    ctx.save();
    ctx.globalAlpha = inP;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    const cx = W / 2;
    setFont(ctx, fmt.type.body, 600, -fmt.type.body * 0.02);
    const size = Math.min(fmt.type.body, fmt.type.body * (W * 0.86) / ctx.measureText('Describe what you want.').width);
    const t1 = c.start + 0.28;
    const t2 = c.start + this.edit.finaleSplit;
    const out = at(t, c.end - 2.15, c.end - 1.65, EASE.inOut);
    const lockIn = at(t, c.end - 1.78, c.end - 1.05, EASE.out);
    const gone = at(t, c.end - 0.6, c.end - 0.02, EASE.inOut);
    const lineY = desk ? H * 0.36 : H * 0.3;
    const settle = at(t, t2 - 0.3, t2 + 0.4, EASE.inOut);

    /* the first line, which steps back as the second arrives */
    rise(ctx, 'Describe what you want.', cx, lineY - settle * size * 0.25, {
      size, weight: 600, spacing: -size * 0.02, align: 'center', p: at(t, t1, t1 + 0.8, EASE.out),
      color: settle > 0.5 ? '#9A9A97' : '#111', alpha: 1 - out
    });
    /* the requests, as typed */
    const queries = this.data.map((d) => d.query);
    const qSize = desk ? 22 : 34;
    const qLead = desk ? 34 : 52;
    const qTop = lineY + (desk ? 70 : 110);
    const qLeave = at(t, t2 - 0.6, t2 - 0.1, EASE.inOut);
    queries.forEach((q, i) => {
      const p = at(t, t1 + 0.45 + i * 0.09, t1 + 1.1 + i * 0.09, EASE.out);
      rise(ctx, q, cx, qTop + i * qLead + qLeave * 14, { size: qSize, weight: 500, color: '#8A8A87', align: 'center', p, alpha: (1 - qLeave) * (1 - out) });
    });
    /* "Fynd finds it." */
    rise(ctx, 'Fynd finds it.', cx, lineY + size * 1.05 - settle * size * 0.25, {
      size, weight: 600, spacing: -size * 0.02, align: 'center', p: at(t, t2, t2 + 0.8, EASE.out), alpha: 1 - out
    });
    /* the four products those requests found */
    const n = 4;
    const pw = desk ? 150 : 220; const ph = pw * 1.25;
    const gap = desk ? 22 : 30;
    const cols = desk ? 4 : 2;
    const rowW = cols * pw + (cols - 1) * gap;
    const top = lineY + size * 1.05 + (desk ? 56 : 80);
    for (let i = 0; i < n; i += 1) {
      const p = at(t, t2 + 0.25 + i * 0.08, t2 + 1.0 + i * 0.08, EASE.out);
      if (p <= 0) continue;
      const col = i % cols; const row = Math.floor(i / cols);
      /* gathering towards the mark as the close resolves */
      const g = at(t, c.end - 2.2, c.end - 1.8, EASE.in);
      const x0 = cx - rowW / 2 + col * (pw + gap);
      const y0 = top + row * (ph + gap) + (1 - p) * 40;
      const dst = { x: lerp(x0, cx - pw * 0.2, g), y: lerp(y0, H / 2 - ph * 0.2, g), w: pw * lerp(1, 0.4, g), h: ph * lerp(1, 0.4, g) };
      const photo = this.photoCache && this.photoCache[i];
      if (photo) framed(ctx, photo, photoRect(i), dst, { radius: desk ? 10 : 16, alpha: Math.min(1, p * 1.4) * (1 - g) * (1 - g), shadow: 0.35 * (1 - g) });
    }
    /* the mark */
    if (lockIn > 0) {
      const m = desk ? 58 : 92;
      const word = desk ? 44 : 68;
      ctx.save();
      ctx.globalAlpha = lockIn * (1 - gone);
      setFont(ctx, word, 700, -word * 0.02);
      const ww = ctx.measureText('Fynd').width;
      const gp = m * 0.3;
      const total = m + gp + ww;
      const x0 = cx - total / 2;
      const s = lerp(0.94, 1, lockIn);
      ctx.translate(cx, H / 2); ctx.scale(s, s); ctx.translate(-cx, -H / 2);
      const y0 = H / 2 - m / 2;
      rr(ctx, { x: x0, y: y0, w: m, h: m }, m * 0.24);
      ctx.fillStyle = '#111';
      ctx.fill();
      setFont(ctx, m * 0.6, 700);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText('F', x0 + m / 2, y0 + m * 0.71);
      ctx.textAlign = 'left';
      setFont(ctx, word, 700, -word * 0.02);
      ctx.fillStyle = '#111';
      ctx.fillText('Fynd', x0 + m + gp, y0 + m * 0.74);
      ctx.restore();
    }
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------
   Rendering
   --------------------------------------------------------- */

async function renderStills(film, times, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of times) {
    const raw = await film.frame(t);
    const { createCanvas, ImageData } = canvasLib();
    const c = createCanvas(film.fmt.W, film.fmt.H);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), film.fmt.W, film.fmt.H), 0, 0);
    const file = path.join(dir, `${film.fmt.name}-${t.toFixed(2).padStart(6, '0')}.png`);
    fs.writeFileSync(file, c.toBuffer('image/png'));
  }
}

async function renderVideo(film, file, from = 0, to = film.edit.duration) {
  const { W, H } = film.fmt;
  const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ff.on('close', (code) => (code ? reject(new Error(`ffmpeg exited ${code}`)) : resolve())));
  const first = Math.round(from * FPS);
  const last = Math.round(to * FPS);
  const started = Date.now();
  for (let i = first; i < last; i += 1) {
    const buf = await film.frame(i / FPS);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if ((i - first) % 150 === 0) process.stdout.write(`  ${film.fmt.name}: ${(i / FPS).toFixed(1)}s of ${to.toFixed(1)}s (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
  }
  ff.stdin.end();
  await done;
}

/* what the sound is written to: the film's own timeline */
function filmTimeline(film) {
  const e = film.edit;
  const keysFile = path.join(FOOTAGE, `${film.fmt.name}.keys.json`);
  const sessionKeys = fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, 'utf8')).keys : [];
  /* each keystroke the film shows, at the moment it shows it */
  const keysOf = (shot) => (sessionKeys[shot.k] || [])
    .map((k) => k + shot.dType + (shot.s.hold && k >= shot.s.hold.at ? shot.holdDur : 0))
    .filter((t) => t >= shot.start && t < shot.submit)
    .map((t) => Number(t.toFixed(3)));
  return {
    video: film.fmt.name,
    duration: e.duration,
    source: 'Written by scripts/demo-film.js: the film cut from the session in assets/demo/footage/.',
    film: true,
    lines: e.vo.map((v) => ({ key: v.key, at: Number(v.at.toFixed(3)) })),
    events: e.events.map((ev) => ({ ...ev, at: Number(ev.at.toFixed(3)) })),
    searches: e.shots.map((s) => ({
      typing: Number(s.start.toFixed(3)),
      searched: Number(s.submit.toFixed(3)),
      results: Number(s.revealStart.toFixed(3)),
      select: Number(s.click.toFixed(3)),
      retailer: [Number(s.handoff.toFixed(3)), Number(s.storeEnd.toFixed(3))],
      hero: Number(s.heroStart.toFixed(3)),
      keys: keysOf(s),
      stage: s.k === 2 ? 'dark' : 'light'
    })),
    close: Number(e.close.start.toFixed(3))
  };
}

/* The finished film for the page: the picture, the sound composed and
   mixed to its timeline (scripts/demo-audio.js), H.264 + AAC in an MP4,
   VP9 + Opus in a WebM, the captions, a poster from the first results,
   and the timeline the sound was written to. */
function publish(film, master, out) {
  const audio = require('./demo-audio');
  const name = film.fmt.name;
  const timeline = filmTimeline(film);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `fynd-film-${name}-`));
  const wav = path.join(stage, `${name}.wav`);
  const mix = audio.renderTo(timeline, wav);
  const run = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  const files = {
    mp4: path.join(stage, `${name}.mp4`),
    webm: path.join(stage, `${name}.webm`),
    poster: path.join(stage, `${name}-poster.jpg`)
  };
  run(['-i', master, '-i', wav, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '60',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', files.mp4]);
  run(['-i', master, '-i', wav, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-g', '120', '-pix_fmt', 'yuv420p',
    '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-shortest', files.webm]);
  const first = film.edit.shots[0];
  run(['-ss', String((first.liveStart + 0.9).toFixed(3)), '-i', master, '-frames:v', '1', '-q:v', '3', files.poster]);
  fs.mkdirSync(out, { recursive: true });
  for (const f of Object.values(files)) fs.copyFileSync(f, path.join(out, path.basename(f)));
  fs.writeFileSync(path.join(out, `${name}.vtt`), mix.captions);
  fs.writeFileSync(path.join(out, `${name}.timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`  ${name}: ${mix.lufs} LUFS integrated, true peak ${mix.truePeakDbtp} dBTP, voice ${mix.voiceLufs} LUFS, limiter ${mix.limiterMaxReductionDb} dB at most`);
  return mix;
}

async function main() {
  const arg = (name) => {
    const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return null;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  const only = arg('only');
  const out = path.resolve(arg('out') || DEMO);
  const data = facts();
  for (const key of ['desktop', 'mobile'].filter((k) => !only || k === only)) {
    const film = new Film(key, data);
    film.prepare();
    const name = film.fmt.name;
    console.log(`${name}: ${film.edit.duration.toFixed(2)}s`);
    if (arg('stills')) {
      await renderStills(film, String(arg('stills')).split(',').map(Number), out);
      continue;
    }
    if (arg('from-master')) {
      publish(film, path.join(path.resolve(String(arg('from-master'))), `${name}.film.mp4`), out);
      continue;
    }
    const masterDir = arg('master') ? path.resolve(String(arg('master'))) : fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-film-master-'));
    fs.mkdirSync(masterDir, { recursive: true });
    const master = path.join(masterDir, `${name}.film.mp4`);
    const range = arg('range');
    const [from, to] = range ? String(range).split(':').map(Number) : [0, film.edit.duration];
    await renderVideo(film, master, from, to);
    if (arg('master')) {
      fs.writeFileSync(path.join(masterDir, `${name}.timeline.json`), `${JSON.stringify(filmTimeline(film), null, 2)}\n`);
      console.log(`  wrote ${master}`);
    } else {
      publish(film, master, out);
      fs.rmSync(masterDir, { recursive: true, force: true });
    }
  }
  if (!arg('stills') && !arg('master')) console.log(`Wrote to ${path.relative(REPO, out) || '.'}`);
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });

module.exports = { Footage, FORMATS, PHOTOS, WORDS, D, FPS, plan, facts, bezier, EASE, viewOf, filmTimeline, publish, finaleSplit, insetRect, Film };
