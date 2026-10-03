/* The pointer, the size of a real one, in the shape the page would give
   it: an arrow, a text cursor over the box, a hand over a link. On a
   phone there is no pointer — a touch is a small soft dot. */
import React from 'react';

export type PointerShape = 'arrow' | 'hand' | 'text';

export const Pointer: React.FC<{ x: number; y: number; shape: PointerShape; pressed?: number; opacity?: number }> = ({ x, y, shape, pressed = 0, opacity = 1 }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, transform: `translate(${x}px, ${y}px) scale(${1 - 0.1 * pressed})`, opacity, transformOrigin: '0 0' }}>
    {shape === 'arrow' && (
      <svg width="17" height="25" viewBox="0 0 17 25" style={{ position: 'absolute', left: -1, top: -1, filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.25))' }}>
        <path d="M1.5 1.5v19.2l4.6-4.4 3.2 7.2 3-1.3-3.1-7h6.4z" fill="#000" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    )}
    {shape === 'hand' && (
      <svg width="22" height="25" viewBox="0 0 22 25" style={{ position: 'absolute', left: -7, top: -1, filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.25))' }}>
        <path d="M8.2 1.4c-1 0-1.8.8-1.8 1.8v9.3l-1.3-1.4c-.8-.8-2-.9-2.8-.2-.8.7-.8 1.9-.1 2.7l4.9 6.1c1.3 1.6 3.2 2.6 5.3 2.6h1.7c3.3 0 6-2.7 6-6v-5.6c0-1-.8-1.8-1.8-1.8s-1.7.7-1.7 1.6V9.9c0-1-.8-1.8-1.8-1.8s-1.8.8-1.8 1.8V9c0-1-.8-1.8-1.8-1.8S11.5 8 11.5 9V3.2c0-1-.8-1.8-1.8-1.8z"
          fill="#fff" stroke="#000" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    )}
    {shape === 'text' && (
      <svg width="9" height="20" viewBox="0 0 9 20" style={{ position: 'absolute', left: -4, top: -10 }}>
        <path d="M1 1.5c1.6 0 2.6.4 3.5 1.3.9-.9 1.9-1.3 3.5-1.3M4.5 2.8v14.4M1 18.5c1.6 0 2.6-.4 3.5-1.3.9.9 1.9 1.3 3.5 1.3" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        <path d="M1 1.5c1.6 0 2.6.4 3.5 1.3.9-.9 1.9-1.3 3.5-1.3M4.5 2.8v14.4M1 18.5c1.6 0 2.6-.4 3.5-1.3.9.9 1.9 1.3 3.5 1.3" fill="none" stroke="#000" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    )}
  </div>
);

export const TouchDot: React.FC<{ x: number; y: number; opacity: number }> = ({ x, y, opacity }) => (
  <div
    style={{
      position: 'absolute', left: x - 15, top: y - 15, width: 30, height: 30, borderRadius: 15,
      background: 'rgba(60,60,60,.22)', border: '1px solid rgba(255,255,255,.75)', opacity
    }}
  />
);

/* a hand's path: a gentle curve, slow at both ends */
export function pathPoint(from: { x: number; y: number }, to: { x: number; y: number }, t: number, bend = 0.12) {
  const e = t * t * t * (10 - 15 * t + 6 * t * t);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const nx = -dy / d;
  const ny = dx / d;
  const c = { x: from.x + dx * 0.5 + nx * d * bend, y: from.y + dy * 0.5 + ny * d * bend };
  const u = 1 - e;
  return { x: u * u * from.x + 2 * u * e * c.x + e * e * to.x, y: u * u * from.y + 2 * u * e * c.y + e * e * to.y };
}
