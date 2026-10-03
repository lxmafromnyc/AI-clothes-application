/* 2 — Understand (5.0–8.5s)

   Short on purpose. The request lifts out of the box to the middle of
   the frame; what Fynd read from it arrives beneath, one attribute after
   another (the real reading: the interpreter's own colour, fit, garment
   and budget); then the attributes fold into one quiet line, which
   travels up into the results heading as the products arrive. */
import React from 'react';
import { color, ui, type Layout } from '../styles/tokens';
import { BEAT } from '../data/timeline';
import { ease, mix, uiSpring } from '../lib/motion';
import { centre, homeLayout, resultsLayout } from '../lib/layout';
import { toScreen } from '../lib/camera';
import { describeView } from './Describe';
import type { Attribute } from '../data/types';

export const Understand: React.FC<{ layout: Layout; frame: number; query: string; attributes: Attribute[] }> = ({ layout, frame, query, attributes }) => {
  if (frame < 148 || frame >= 242) return null;
  const desktop = layout === 'desktop';
  const L = homeLayout(layout);
  const R = resultsLayout(layout);
  const W = L.W;

  /* the request, from where it was typed to the middle */
  const from = toScreen(describeView(layout, 150), layout, { x: L.field.x, y: centre(L.field).y });
  const fromSize = ui[layout].search.field * describeView(layout, 150).s;
  const lift = ease(frame, BEAT.queryLift, BEAT.queryLift + 15);
  const midY = desktop ? 300 : 210;
  const qSize = mix(fromSize, desktop ? 36 : 21, lift);
  const qLeft = mix(from.x, W / 2, lift);
  const qTop = mix(from.y, midY, lift) - ease(frame, BEAT.compressFrom, BEAT.compressFrom + 12) * 12;
  const qOpacity = 1 - ease(frame, BEAT.compressFrom, BEAT.compressFrom + 12);

  /* the attributes */
  const chipW = desktop ? 156 : 171;
  const chipH = desktop ? 66 : 62;
  const gap = 12;
  const rowY = desktop ? 368 : 262;
  const cols = desktop ? attributes.length : 2;
  const rowW = cols * chipW + (cols - 1) * gap;
  const chips = attributes.map((a, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return { a, x: (W - rowW) / 2 + col * (chipW + gap), y: rowY + row * (chipH + gap) };
  });
  const rowsH = Math.ceil(attributes.length / cols) * (chipH + gap) - gap;
  const fold = ease(frame, BEAT.compressFrom, BEAT.compressFrom + 9);
  /* they settle in place and go: the labels never pass over one another */
  const foldOut = ease(frame, BEAT.compressFrom, BEAT.compressFrom + 5);

  /* the one line they fold into, then up into the results heading */
  const summary = attributes.map((a) => a.value).join(' · ');
  const sumIn = ease(frame, BEAT.compressFrom + 8, BEAT.compressFrom + 16);
  const travel = ease(frame, BEAT.compressFrom + 16, BEAT.resultsIn + 8);
  const sumOut = 1 - ease(frame, BEAT.resultsIn, BEAT.resultsIn + 8);
  const sumLeft = mix(W / 2, R.query.x, travel);
  const sumTop = mix(rowY + rowsH / 2 - 13, R.query.y, travel);
  const sumShift = mix(-50, 0, travel);
  const sumSize = mix(desktop ? 18 : 16, 16, travel);

  return (
    <>
      {qOpacity > 0 && (
        <div
          style={{
            position: 'absolute', left: qLeft, top: qTop, transform: `translate(${-50 * lift}%, -50%)`, opacity: qOpacity,
            fontSize: qSize, fontWeight: lift > 0.5 ? 500 : 400, letterSpacing: mix(-0.19, desktop ? -0.9 : -0.5, lift), whiteSpace: 'nowrap', textAlign: lift > 0.5 ? 'center' : 'left', lineHeight: 1.25
          }}
        >
          {query}
        </div>
      )}
      {chips.map(({ a, x, y }, i) => {
        const s = uiSpring(frame, BEAT.attrsFrom + i * BEAT.attrStagger, 16);
        const dx = (W / 2 - (x + chipW / 2)) * fold * 0.08;
        const dy = (rowY + rowsH / 2 - (y + chipH / 2)) * fold * 0.08;
        return (
          <div
            key={a.label}
            style={{
              position: 'absolute', left: x, top: y, width: chipW, height: chipH, boxSizing: 'border-box',
              transform: `translate(${dx}px, ${dy + (1 - s) * 10}px) scale(${1 - 0.04 * fold})`, opacity: s * (1 - foldOut),
              border: `1px solid ${color.line}`, borderRadius: 14, background: color.surface,
              boxShadow: '0 1px 2px rgba(0,0,0,.04), 0 6px 18px -10px rgba(0,0,0,.12)',
              padding: desktop ? '11px 16px' : '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: color.muted, lineHeight: 1.2 }}>{a.label}</div>
            <div style={{ fontSize: desktop ? 18 : 17, fontWeight: 600, letterSpacing: -0.3, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.value}</div>
          </div>
        );
      })}
      {sumIn > 0 && (
        <div
          style={{
            position: 'absolute', left: sumLeft, top: sumTop, transform: `translateX(${sumShift}%)`, opacity: Math.min(sumIn, sumOut),
            fontSize: sumSize, fontWeight: 500, lineHeight: 1.5, color: color.text2, whiteSpace: 'nowrap'
          }}
        >
          {summary}
        </div>
      )}
    </>
  );
};
