/* 3 — Matching products (8.5–16.5s) and 4 — Compare and choose
   (16.5–25.5s), on the hoodie results.

   One world for both: the real results grid, laid out as the site lays
   it out, seen through a camera. Scene 3 drifts along it and marks
   products A, B and C; the dress and bag searches (Vignettes) are cut
   in over it; scene 4 comes back to it, the pointer looks at A, B and C
   in turn — each lifts under the pointer as the site's cards do — and
   clicks C, which comes forward as everything else falls away. */
import React from 'react';
import { color, ui, type Layout } from '../styles/tokens';
import { BEAT } from '../data/timeline';
import { ease, fadeInOut, mix, uiSpring } from '../lib/motion';
import { resultsLayout, type Rect } from '../lib/layout';
import { cameraAt, clampView, frameRect, placeY, rectToScreen, restView, toScreen, union, viewTransform, type View } from '../lib/camera';
import { ProductCard } from '../components/ProductCard';
import { ResultsHead } from '../components/ResultsHead';
import { SceneLabel } from '../components/SceneLabel';
import { Pointer, TouchDot, pathPoint, type PointerShape } from '../components/Pointer';
import type { Product, Search } from '../data/types';

/* how many cards are laid out: more than the frame shows, so a camera
   move never runs off the end of the grid */
const LAID_OUT = 12;

/* where C ends up when it is chosen, in screen (stage) pixels */
export function heroRect(layout: Layout): Rect {
  const desktop = layout === 'desktop';
  const w = desktop ? 300 : 240;
  const media = w * 1.25;
  const h = media + (desktop ? 112 : 164);
  const W = desktop ? 1440 : 390;
  const H = desktop ? 810 : 1920 / (1080 / 390);
  return { x: (W - w) / 2, y: Math.round((H - h) / 2) - (desktop ? 26 : 34), w, h };
}
export const heroMedia = (layout: Layout): Rect => {
  const r = heroRect(layout);
  return { ...r, h: r.w * 1.25 };
};

/* the address as a person would read it: host and path, no www, cut
   short with an ellipsis — the real URL, never a made-up one */
export function displayUrl(url: string, max = 46) {
  try {
    const u = new URL(url);
    const s = u.hostname.replace(/^www\d?\./, '') + (u.pathname === '/' ? '' : u.pathname);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch (e) {
    return url;
  }
}

export function productsCamera(layout: Layout, frame: number, chosen: number[]): View {
  const R = resultsLayout(layout);
  const desktop = layout === 'desktop';
  const rest = restView(layout);
  const abc = union(chosen.map((i) => R.cardRect(i)));
  /* the photographs are the scene: the whole grid for a moment, then one
     slow, continuous move in until they fill most of the frame, drifting
     along the row */
  const drift: View = desktop
    ? clampView(layout, { s: 1.26, cx: 1440, cy: R.gridTop + R.mediaH * 0.58 })
    : clampView(layout, { s: 1.12, cx: 195, cy: rest.cy + 86 });
  const mark = frameRect(layout, abc, desktop ? { pad: 30, max: 1.26, min: 0.95 } : { pad: 14, max: 1.12, min: 0.82 });
  const keys: Array<[number, View]> = [
    [BEAT.driftFrom, rest],
    [BEAT.driftTo, drift],
    [BEAT.emphasisA + 18, mark],
    [BEAT.returnTo, mark]
  ];
  if (desktop) {
    /* the heading stays in view, just under the site header */
    keys.push([BEAT.aMove, placeY(layout, frameRect(layout, abc, { pad: 56, max: 1.08, min: 0.9 }), R.h2.y, ui.desktop.header + 18)]);
  } else {
    /* on a phone the person looks at each one close up */
    const close = (i: number) => frameRect(layout, R.cardRect(chosen[i]), { pad: 40, max: 1.6, min: 1 });
    keys.push([BEAT.aMove, mark], [BEAT.aHover, close(0)], [BEAT.bMove, close(0)], [BEAT.bHover, close(1)], [BEAT.cMove, close(1)], [BEAT.cHover, close(2)]);
  }
  return cameraAt(frame, keys);
}

export const Products: React.FC<{ layout: Layout; frame: number; search: Search; chosen: string[] }> = ({ layout, frame, search, chosen }) => {
  if (frame < BEAT.resultsIn - 2 || frame >= BEAT.frameIn + 22) return null;
  const desktop = layout === 'desktop';
  const R = resultsLayout(layout);
  const W = R.W;
  const products = search.products.slice(0, LAID_OUT);
  const idx = chosen.map((id) => products.findIndex((p) => p.id === id));
  const view = productsCamera(layout, frame, idx);

  /* scene 3: A, B and C marked in turn */
  const marks = [BEAT.emphasisA, BEAT.emphasisB, BEAT.emphasisC].map((f) => ease(frame, f, f + 8) * (1 - ease(frame, BEAT.emphasisEnd, BEAT.emphasisEnd + 10)));
  const anyMark = Math.max(...marks);

  /* scene 4: the pointer's hover, one card after another */
  const hover = desktop ? [
    ease(frame, BEAT.aHover - 8, BEAT.aHover + 2) * (1 - ease(frame, BEAT.bMove + 4, BEAT.bMove + 12)),
    ease(frame, BEAT.bHover - 8, BEAT.bHover + 2) * (1 - ease(frame, BEAT.cMove + 4, BEAT.cMove + 12)),
    ease(frame, BEAT.cHover - 8, BEAT.cHover + 2)
  ] : [0, 0, 0];

  /* the handoff: everything but C falls away; C comes forward */
  const away = ease(frame, BEAT.handoff, BEAT.handoff + 22);
  const forward = ease(frame, BEAT.handoff, BEAT.handoff + 40);
  const cFrom = rectToScreen(view, layout, R.cardRect(idx[2]));
  const cTo = heroRect(layout);
  const hero: Rect = { x: mix(cFrom.x, cTo.x, forward), y: mix(cFrom.y, cTo.y, forward), w: mix(cFrom.w, cTo.w, forward), h: 0 };
  const heroOut = 1 - ease(frame, BEAT.frameIn + 4, BEAT.frameIn + 18);
  const pill = fadeInOut(frame, BEAT.handoff + 34, BEAT.handoff + 46, BEAT.frameIn, BEAT.frameIn + 10);

  /* the heading goes rather than be cut by the header or the frame edge */
  const h2 = toScreen(view, layout, { x: R.h2.x, y: R.h2.y });
  const clip = Math.min(1, Math.max(0, (h2.y - ui[layout].header - 2) / 10)) * Math.min(1, Math.max(0, (h2.x + 2) / 10));
  const headIn = ease(frame, BEAT.resultsIn, BEAT.resultsIn + 12) * clip;
  const queryIn = ease(frame, BEAT.resultsIn, BEAT.resultsIn + 10) * clip;
  const label = fadeInOut(frame, BEAT.labelFrom, BEAT.labelFrom + 12, BEAT.labelTo - 12, BEAT.labelTo) * clip;

  return (
    <>
      <div style={{ position: 'absolute', inset: 0, transform: viewTransform(view, layout), transformOrigin: '0 0', opacity: 1 - away }}>
        <ResultsHead layout={layout} count={search.count} query={search.query} headOpacity={headIn} queryOpacity={queryIn} />
        <SceneLabel text="Matching products" x={W - ui[layout].gutter} y={R.h2.y + (desktop ? 8 : 6)} align="right" opacity={label} size={desktop ? 14 : 12} />
        {products.map((p, i) => {
          const r = R.cardRect(i);
          const order = i;
          const s = uiSpring(frame, BEAT.resultsIn + Math.min(order, 7) * 2, 16);
          const k = idx.indexOf(i);
          const m = k >= 0 ? marks[k] : 0;
          const h = k >= 0 ? hover[k] : 0;
          const dim = k >= 0 ? 0 : 0.08 * anyMark;
          const hidden = k === 2 && frame >= BEAT.handoff;
          return (
            <div key={p.id} style={{ position: 'absolute', left: r.x, top: r.y + (1 - s) * 14, opacity: hidden ? 0 : s * (1 - dim), zIndex: m > 0 || h > 0 ? 2 : 1 }}>
              <ProductCard product={p} layout={layout} lift={Math.max(m, h)} scale={1 + (desktop ? 0.04 : 0.02) * m} />
            </div>
          );
        })}
      </div>

      {frame >= BEAT.handoff && heroOut > 0 && (
        <>
          <div style={{ position: 'absolute', left: hero.x, top: hero.y, opacity: heroOut }}>
            <ProductCard product={products[idx[2]]} layout={layout} width={hero.w} lift={1 - forward * 0.4} />
          </div>
          <UrlPill url={products[idx[2]].url} x={W / 2} y={cTo.y + cTo.h + 16} opacity={pill} />
        </>
      )}

      <Hand layout={layout} frame={frame} view={view} cards={idx.map((i) => R.mediaRect(i))} />
    </>
  );
};

export const UrlPill: React.FC<{ url: string; x: number; y: number; opacity: number }> = ({ url, x, y, opacity }) => (
  <div
    style={{
      position: 'absolute', left: x, top: y, transform: `translate(-50%, ${(1 - opacity) * 6}px)`, opacity,
      display: 'flex', alignItems: 'center', gap: 7, height: 30, padding: '0 12px', borderRadius: 999,
      background: color.bgSubtle, border: `1px solid ${color.line}`, fontSize: 13, color: color.text2, whiteSpace: 'nowrap'
    }}
  >
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke={color.text2} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2h6v6M10 2L3 9" /></svg>
    {displayUrl(url)}
  </div>
);

/* the person's hand: a pointer on a computer, a touch on a phone */
const Hand: React.FC<{ layout: Layout; frame: number; view: View; cards: Rect[] }> = ({ layout, frame, view, cards }) => {
  const target = (i: number) => toScreen(view, layout, { x: cards[i].x + cards[i].w * 0.52, y: cards[i].y + cards[i].h * 0.56 });
  if (layout === 'mobile') {
    const c = target(2);
    return <TouchDot x={c.x} y={c.y} opacity={fadeInOut(frame, BEAT.click - 4, BEAT.click, BEAT.click + 5, BEAT.click + 12)} />;
  }
  if (frame < BEAT.aMove - 2 || frame > BEAT.handoff + 12) return null;
  const W = 1440;
  const start = { x: W * 0.72, y: 830 };
  const legs: Array<[number, number, { x: number; y: number }, { x: number; y: number }]> = [
    [BEAT.aMove, BEAT.aHover - 4, start, target(0)],
    [BEAT.bMove, BEAT.bHover - 4, target(0), target(1)],
    [BEAT.cMove, BEAT.cHover - 4, target(1), target(2)]
  ];
  let p = target(2);
  let shape: PointerShape = 'hand';
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const [f0, f1, a, b] = legs[i];
    if (frame >= f0) {
      const t = ease(frame, f0, f1);
      /* while the camera settles the held point moves with it */
      p = t >= 1 ? b : pathPoint(a, b, t, i % 2 ? -0.08 : 0.1);
      shape = t > 0.8 || t === 0 ? 'hand' : 'arrow';
      break;
    }
  }
  if (frame < BEAT.aMove) p = start;
  const pressed = Math.max(0, 1 - Math.abs(frame - BEAT.click) / 3);
  const opacity = ease(frame, BEAT.aMove - 2, BEAT.aMove + 4) * (1 - ease(frame, BEAT.handoff + 2, BEAT.handoff + 12));
  return <Pointer x={p.x} y={p.y} shape={shape} pressed={pressed} opacity={opacity} />;
};

export type { Product };
