/* The stage: the site's own CSS width, zoomed up to the frame. Inside it
   everything is laid out in the site's pixels; `zoom` (not a transform)
   keeps type and edges crisp at any size.

   The camera sits inside the stage: a scale and a translation around a
   point, for the slow moves the film is allowed. */
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { color, font, stage, stageHeight, zoomFor, type Layout } from '../styles/tokens';

export const Stage: React.FC<{ layout: Layout; background?: string; children: React.ReactNode }> = ({ layout, background, children }) => (
  <AbsoluteFill style={{ backgroundColor: background || color.bg }}>
    <div
      style={{
        position: 'absolute', left: 0, top: 0,
        width: stage[layout].width, height: stageHeight(layout),
        zoom: zoomFor(layout),
        fontFamily: font.family, color: color.text,
        WebkitFontSmoothing: 'antialiased',
        overflow: 'hidden'
      }}
    >
      {children}
    </div>
  </AbsoluteFill>
);

export const Camera: React.FC<{
  scale?: number; x?: number; y?: number; originX?: number; originY?: number; opacity?: number;
  children: React.ReactNode;
}> = ({ scale = 1, x = 0, y = 0, originX = 50, originY = 50, opacity = 1, children }) => (
  <div
    style={{
      position: 'absolute', inset: 0, opacity,
      transform: `translate(${x}px, ${y}px) scale(${scale})`,
      transformOrigin: `${originX}% ${originY}%`
    }}
  >
    {children}
  </div>
);

/* anything placed by a rectangle in stage pixels */
export const At: React.FC<{ x: number; y: number; w?: number; h?: number; style?: React.CSSProperties; children?: React.ReactNode }> = ({ x, y, w, h, style, children }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, ...style }}>{children}</div>
);
