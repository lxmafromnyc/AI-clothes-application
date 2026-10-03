/* The close (30.0–32.0s): a quiet mosaic of real products from all three
   searches, then the line and the mark. */
import React from 'react';
import { Img, staticFile } from 'remotion';
import { color, type Layout } from '../styles/tokens';
import { BEAT } from '../data/timeline';
import { ease, uiSpring } from '../lib/motion';
import { BrandMark } from '../components/BrandMark';
import type { Product } from '../data/types';

export const Finale: React.FC<{ layout: Layout; frame: number; mosaic: Product[] }> = ({ layout, frame, mosaic }) => {
  if (frame < BEAT.mosaic - 4) return null;
  const desktop = layout === 'desktop';
  const W = desktop ? 1440 : 390;
  const H = desktop ? 810 : 1920 / (1080 / 390);
  const tileW = desktop ? 128 : 108;
  const tileH = tileW * 1.25;
  const gap = desktop ? 14 : 10;
  const cols = desktop ? mosaic.length : 3;
  const rows = Math.ceil(mosaic.length / cols);
  const x0 = (W - (cols * tileW + (cols - 1) * gap)) / 2;
  const y0 = (H - (rows * tileH + (rows - 1) * gap)) / 2;
  const out = ease(frame, BEAT.finalText - 10, BEAT.finalText + 2);
  const text = uiSpring(frame, BEAT.finalText - 2, 14);
  const mark = uiSpring(frame, BEAT.finalText + 4, 14);
  return (
    <>
      {mosaic.map((p, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const s = uiSpring(frame, BEAT.mosaic + i * 2, 16);
        return (
          <div
            key={p.id}
            style={{
              position: 'absolute', left: x0 + col * (tileW + gap), top: y0 + row * (tileH + gap), width: tileW, height: tileH,
              borderRadius: 10, overflow: 'hidden', background: color.tile,
              opacity: s * (1 - out), transform: `translateY(${(1 - s) * 10 - out * 12}px) scale(${0.97 + 0.03 * s})`
            }}
          >
            <Img src={staticFile(p.image)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: 0, top: H / 2 - (desktop ? 62 : 76), width: W, textAlign: 'center', opacity: text, transform: `translateY(${(1 - text) * 8}px)` }}>
        <div style={{ fontSize: desktop ? 54 : 32, lineHeight: 1.08, fontWeight: 700, letterSpacing: desktop ? -2.16 : -1.28 }}>
          Search naturally.{desktop ? ' ' : <br />}Find what you want.
        </div>
      </div>
      <div style={{ position: 'absolute', left: 0, top: H / 2 + (desktop ? 34 : 24), width: W, display: 'flex', justifyContent: 'center', opacity: mark, transform: `translateY(${(1 - mark) * 6}px)` }}>
        <BrandMark size={desktop ? 1.3 : 1.2} />
      </div>
    </>
  );
};
