/* 1 — Describe (0.0–5.0s)

   The hook first, alone on white: "Looking for something specific?"
   (0.0–1.2s). Then straight into the Fynd homepage as it is, the camera
   settling onto the box; a pointer clicks into it, hides while the
   request is typed (as a real one does) — "Just describe it." comes up
   quietly above the heading — comes back and presses Search. On a phone
   there is no pointer: two taps. */
import React from 'react';
import { color, ui, type Layout } from '../styles/tokens';
import { BEAT } from '../data/timeline';
import { ease, fadeInOut, mix } from '../lib/motion';
import { centre, homeLayout } from '../lib/layout';
import { typedCount } from '../lib/typing';
import { toScreen, viewTransform, zoomAbout, type View } from '../lib/camera';
import { FyndSearch } from '../components/FyndSearch';
import { Pointer, TouchDot, pathPoint, type PointerShape } from '../components/Pointer';
import { SceneLabel } from '../components/SceneLabel';

const EXAMPLES = ['linen shirt for a summer wedding', 'white sneakers under $120', 'wool coat for winter'];
const PLACEHOLDER = 'black oversized hoodie under $80'; /* the site's own placeholder */

/* the camera for this scene: the page arrives a touch close on the box
   and settles, then a slow lean */
export function describeView(layout: Layout, frame: number): View {
  const L = homeLayout(layout);
  const s = frame < 70 ? mix(1.06, 1.025, ease(frame, BEAT.pageIn, 70)) : mix(1.025, 1.035, ease(frame, 70, 150));
  return zoomAbout(layout, centre(L.card), s);
}

/* how far the homepage has come up under the hook */
export const pageIn = (frame: number) => ease(frame, BEAT.pageIn, BEAT.pageIn + 9);

/* the hook: the film's first words, on their own */
const Hook: React.FC<{ layout: Layout; frame: number }> = ({ layout, frame }) => {
  if (frame >= BEAT.pageIn) return null;
  const desktop = layout === 'desktop';
  const L = homeLayout(layout);
  const inn = ease(frame, 0, 8);
  const out = ease(frame, BEAT.hookOut, BEAT.pageIn);
  return (
    <div
      style={{
        position: 'absolute', left: 0, width: L.W, top: L.H * (desktop ? 0.45 : 0.42), textAlign: 'center',
        transform: `translateY(calc(-50% + ${(1 - inn) * 6 - out * 10}px))`, opacity: inn * (1 - out),
        fontSize: desktop ? 40 : 28, lineHeight: 1.15, fontWeight: 600, letterSpacing: desktop ? -1.0 : -0.6, color: color.text
      }}
    >
      {desktop ? 'Looking for something specific?' : <>Looking for<br />something specific?</>}
    </div>
  );
};

export const Hero: React.FC<{ layout: Layout; text: string; caret: boolean; focus: number; pressed: number; heroOpacity?: number; cardOpacity?: number; textOpacity?: number }> = ({ layout, text, caret, focus, pressed, heroOpacity = 1, cardOpacity = 1, textOpacity = 1 }) => {
  const L = homeLayout(layout);
  const t = ui[layout];
  const desktop = layout === 'desktop';
  const examples = desktop ? EXAMPLES : EXAMPLES.slice(0, 2);
  return (
    <>
      <div style={{ opacity: heroOpacity }}>
        <div
          style={{
            position: 'absolute', left: L.h1.x, top: L.h1.y, width: L.h1.w, textAlign: 'center',
            fontSize: t.h1.size, lineHeight: `${t.h1.line}px`, fontWeight: 700, letterSpacing: t.h1.track
          }}
        >
          {desktop ? 'Find what you’re looking for.' : <>Find what you’re<br />looking for.</>}
        </div>
        <div style={{ position: 'absolute', left: L.lead.x, top: L.lead.y, width: L.lead.w, textAlign: 'center', fontSize: t.lead.size, lineHeight: `${t.lead.line}px`, color: color.muted }}>
          Describe any clothing item naturally and Fynd will find matching products.
        </div>
        <div style={{ position: 'absolute', left: desktop ? 0 : 16, top: L.chips.y, width: desktop ? L.W : 358, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, color: color.muted, marginRight: 2, width: desktop ? undefined : '100%', textAlign: 'center' }}>Try</span>
          {examples.map((e) => (
            <span key={e} style={{ height: 36, padding: '0 14px', display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', border: `1px solid ${color.line}`, borderRadius: 999, background: color.surface, fontSize: 14, color: color.accentInk, whiteSpace: 'nowrap' }}>
              {e}
            </span>
          ))}
        </div>
      </div>
      <div style={{ opacity: cardOpacity }}>
        <FyndSearch layout={layout} card={L.card} text={text} caret={caret} focus={focus} pressed={pressed} placeholder={PLACEHOLDER} textOpacity={textOpacity} />
      </div>
    </>
  );
};

export const Describe: React.FC<{ layout: Layout; frame: number; query: string; typed: number[] }> = ({ layout, frame, query, typed }) => {
  if (frame >= 166) return null;
  const L = homeLayout(layout);
  const view = describeView(layout, Math.min(frame, 150));
  const desktop = layout === 'desktop';

  const count = typedCount(typed, frame);
  const typing = count > 0 && count < query.length;
  const focused = frame >= BEAT.fieldClick && frame < BEAT.searchClick + 4;
  const idleBlink = Math.floor((frame - BEAT.fieldClick) / 15) % 2 === 0;
  const caret = focused && (typing || idleBlink);
  const focus = ease(frame, BEAT.fieldClick, BEAT.fieldClick + 12) * (1 - ease(frame, BEAT.searchClick + 2, BEAT.searchClick + 12));
  const pressed = Math.max(0, 1 - Math.abs(frame - (BEAT.searchClick + 1)) / 4);

  /* the scene hands over to Understand: the page goes, the request stays */
  const arrive = pageIn(frame);
  const heroOpacity = arrive * (1 - ease(frame, 145, 154));
  const cardOpacity = arrive * (1 - ease(frame, 148, 157));

  /* the film's label, in the open space above the heading */
  const labelOpacity = fadeInOut(frame, BEAT.labelIn, BEAT.labelIn + 14, 126, 140);
  const labelY = desktop ? Math.round((ui.desktop.header + L.h1.y) / 2) - 10 : Math.round((ui.mobile.header + L.h1.y) / 2) - 10;

  /* the pointer, in screen space through the same camera */
  const field = toScreen(view, layout, { x: L.field.x + (desktop ? 210 : 150), y: centre(L.field).y });
  const button = toScreen(view, layout, centre(L.button));
  const enter = { x: L.W * (desktop ? 0.78 : 0.8), y: L.H * 0.98 };
  let p = enter;
  let shape: PointerShape = 'arrow';
  let pOpacity = 0;
  if (frame >= BEAT.cursorIn && frame < BEAT.fieldClick + 10) {
    const t = ease(frame, BEAT.cursorIn, BEAT.fieldClick - 1);
    p = pathPoint(enter, field, t);
    shape = t > 0.85 ? 'text' : 'arrow';
    pOpacity = arrive * (1 - ease(frame, BEAT.fieldClick + 4, BEAT.fieldClick + 10));
  } else if (frame >= BEAT.toSearch - 4) {
    const t = ease(frame, BEAT.toSearch, BEAT.searchClick - 3);
    const rest = { x: field.x + 40, y: field.y + 26 };
    p = pathPoint(rest, button, t, -0.1);
    shape = t > 0.8 ? 'hand' : 'arrow';
    pOpacity = ease(frame, BEAT.toSearch - 4, BEAT.toSearch + 2) * (1 - ease(frame, 145, 151));
  }
  const clickPress = Math.max(0, 1 - Math.abs(frame - BEAT.fieldClick) / 3) + pressed;

  /* a phone: a touch where a finger would land */
  const tapField = desktop ? 0 : fadeInOut(frame, BEAT.fieldClick - 3, BEAT.fieldClick, BEAT.fieldClick + 4, BEAT.fieldClick + 10);
  const tapSearch = desktop ? 0 : fadeInOut(frame, BEAT.searchClick - 3, BEAT.searchClick, BEAT.searchClick + 4, BEAT.searchClick + 10);

  return (
    <>
      <div style={{ position: 'absolute', inset: 0, transform: viewTransform(view, layout), transformOrigin: '0 0' }}>
        <Hero layout={layout} text={query.slice(0, count)} caret={caret} focus={focus} pressed={pressed} heroOpacity={heroOpacity} cardOpacity={cardOpacity} textOpacity={frame >= 150 ? 0 : 1} />
        {/* from 5.0s the request is carried by Understand, from this exact spot */}
      </div>
      <Hook layout={layout} frame={frame} />
      <SceneLabel text="Just describe it." x={L.W / 2} y={labelY} opacity={labelOpacity} size={desktop ? 15 : 14} />
      {desktop ? (
        <Pointer x={p.x} y={p.y} shape={shape} opacity={pOpacity} pressed={Math.min(1, clickPress)} />
      ) : (
        <>
          <TouchDot x={field.x} y={field.y} opacity={tapField} />
          <TouchDot x={button.x} y={button.y} opacity={tapSearch} />
        </>
      )}
    </>
  );
};
