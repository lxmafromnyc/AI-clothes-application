/* The camera, as a view: the stage point at the centre of the frame and
   how far in it is. Views are interpolated, and the pointer is placed
   through the same view, so it stays on the thing it is pointing at
   however the camera moves. */
import { stage, stageHeight, type Layout } from '../styles/tokens';
import { ease, mix } from './motion';
import type { Rect } from './layout';

export type View = { cx: number; cy: number; s: number };

export const restView = (layout: Layout): View => ({ cx: stage[layout].width / 2, cy: stageHeight(layout) / 2, s: 1 });

export function viewTransform(view: View, layout: Layout) {
  const W = stage[layout].width;
  const H = stageHeight(layout);
  return `translate(${W / 2}px, ${H / 2}px) scale(${view.s}) translate(${-view.cx}px, ${-view.cy}px)`;
}

/* where a stage point lands on screen (in stage pixels) under a view */
export function toScreen(view: View, layout: Layout, p: { x: number; y: number }) {
  const W = stage[layout].width;
  const H = stageHeight(layout);
  return { x: W / 2 + view.s * (p.x - view.cx), y: H / 2 + view.s * (p.y - view.cy) };
}
export function rectToScreen(view: View, layout: Layout, r: Rect): Rect {
  const a = toScreen(view, layout, { x: r.x, y: r.y });
  return { x: a.x, y: a.y, w: r.w * view.s, h: r.h * view.s };
}

/* zoom in by s while keeping stage point p where it is on screen */
export function zoomAbout(layout: Layout, p: { x: number; y: number }, s: number): View {
  const W = stage[layout].width;
  const H = stageHeight(layout);
  return { s, cx: p.x - (p.x - W / 2) / s, cy: p.y - (p.y - H / 2) / s };
}

/* the view that frames a rectangle with some room around it, no closer
   than `max` and no further out than `min` */
export function frameRect(layout: Layout, r: Rect, { pad = 40, max = 1.18, min = 0.9, biasY = 0 } = {}): View {
  const W = stage[layout].width;
  const H = stageHeight(layout);
  const s = Math.max(min, Math.min(max, W / (r.w + 2 * pad), H / (r.h + 2 * pad)));
  return clampView(layout, { s, cx: r.x + r.w / 2, cy: r.y + r.h / 2 + biasY });
}

/* a view never shows past the page's left or right edge (when zoomed in) */
export function clampView(layout: Layout, v: View): View {
  const W = stage[layout].width;
  const half = W / (2 * v.s);
  if (half >= W / 2) return { ...v, cx: W / 2 };
  return { ...v, cx: Math.min(W - half, Math.max(half, v.cx)) };
}

/* the view with its stage point y placed at screen y */
export function placeY(layout: Layout, v: View, y: number, screenY: number): View {
  const H = stageHeight(layout);
  return { ...v, cy: y - (screenY - H / 2) / v.s };
}

export function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/* zoom is interpolated in log space so a push in reads as even speed */
export const mixView = (a: View, b: View, t: number): View => ({
  cx: mix(a.cx, b.cx, t), cy: mix(a.cy, b.cy, t), s: Math.exp(mix(Math.log(a.s), Math.log(b.s), t))
});

/* a camera path: views at frames, eased from one to the next, holding
   before the first and after the last */
export function cameraAt(frame: number, keys: Array<[number, View]>): View {
  if (frame <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i += 1) {
    const [f0, v0] = keys[i - 1];
    const [f1, v1] = keys[i];
    if (frame <= f1) return mixView(v0, v1, ease(frame, f0, f1));
  }
  return keys[keys.length - 1][1];
}

export const mixRect = (a: Rect, b: Rect, t: number): Rect => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), w: mix(a.w, b.w, t), h: mix(a.h, b.h, t) });
