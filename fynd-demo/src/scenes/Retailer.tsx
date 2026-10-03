/* 5 — Retailer (25.5–30.0s)

   C's photo opens out into a browser window with the real address in
   its bar. Inside: the retailer's page exactly as it was captured when
   it loaded. If it did not load, nothing is drawn in its place — the
   window shows the product and the real address it was opening (the
   handoff). Then the window draws back. */
import React from 'react';
import { Img, staticFile } from 'remotion';
import { color, type Layout } from '../styles/tokens';
import { BEAT } from '../data/timeline';
import { ease, mix } from '../lib/motion';
import { mixRect, type View } from '../lib/camera';
import type { Rect } from '../lib/layout';
import { BrowserFrame } from '../components/BrowserFrame';
import { ProductCard } from '../components/ProductCard';
import { displayUrl, heroMedia } from './Products';
import type { Product, Retailer as RetailerData } from '../data/types';

export const frameRectFor = (layout: Layout): Rect =>
  layout === 'desktop' ? { x: 150, y: 50, w: 1140, h: 710 } : { x: 14, y: 36, w: 362, h: 622 };

export const Retailer: React.FC<{ layout: Layout; frame: number; product: Product; retailer: RetailerData; forceHandoff?: boolean }> = ({ layout, frame, product, retailer, forceHandoff }) => {
  if (frame < BEAT.frameIn || frame >= BEAT.mosaic + 4) return null;
  const desktop = layout === 'desktop';
  const shot = forceHandoff ? null : retailer.screenshots[layout];
  const grow = ease(frame, BEAT.frameIn, BEAT.frameIn + 40);
  const rect = mixRect(heroMedia(layout), frameRectFor(layout), grow);
  const bg = ease(frame, BEAT.frameIn, BEAT.frameIn + 20) * (1 - ease(frame, BEAT.frameOut + 18, BEAT.mosaic));
  const photoOut = ease(frame, BEAT.frameIn + 26, BEAT.page);
  const push = mix(1, 1.03, ease(frame, BEAT.page, BEAT.frameOut + 10));
  const back = ease(frame, BEAT.frameOut, BEAT.mosaic - 2);
  const scale = mix(1, 0.72, back);
  const opacity = 1 - ease(frame, BEAT.frameOut + 12, BEAT.mosaic - 2);
  const chrome = ease(frame, BEAT.frameIn + 10, BEAT.frameIn + 28);

  return (
    <>
      <div style={{ position: 'absolute', inset: 0, background: color.bgSubtle, opacity: bg }} />
      <div
        style={{
          position: 'absolute', left: rect.x, top: rect.y, opacity,
          transform: `translateY(${-14 * back}px) scale(${scale})`, transformOrigin: '50% 45%'
        }}
      >
        <BrowserFrame width={rect.w} height={rect.h} address={displayUrl(retailer.url, desktop ? 90 : 34)} phone={!desktop} chrome={chrome}>
          {shot ? (
            <Img src={staticFile(shot)} style={{ position: 'absolute', left: 0, top: 0, width: '100%', transform: `scale(${push})`, transformOrigin: '50% 0', opacity: photoOut }} />
          ) : (
            <Handoff layout={layout} product={product} retailer={retailer} opacity={photoOut} />
          )}
          {photoOut < 1 && (
            <Img src={staticFile(product.image)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 1 - photoOut }} />
          )}
        </BrowserFrame>
      </div>
    </>
  );
};

/* when the shop's page did not load: the product, and where the link
   goes — nothing that pretends to be the shop */
const Handoff: React.FC<{ layout: Layout; product: Product; retailer: RetailerData; opacity: number }> = ({ layout, product, retailer, opacity }) => {
  const desktop = layout === 'desktop';
  return (
    <div style={{ position: 'absolute', inset: 0, opacity, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: desktop ? 22 : 18, background: color.surface }}>
      <ProductCard product={product} layout={layout} width={desktop ? 220 : 200} />
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: color.muted }}>Opening</div>
        <div style={{ fontSize: desktop ? 17 : 15, fontWeight: 600, color: color.text, marginTop: 2 }}>{retailer.host}</div>
        <div style={{ fontSize: 13, color: color.muted, marginTop: 2, maxWidth: desktop ? 700 : 300, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pathOf(retailer.url)}</div>
      </div>
    </div>
  );
};

const pathOf = (url: string) => {
  try { const u = new URL(url); return u.pathname + u.search; } catch (e) { return ''; }
};

export type { View };
