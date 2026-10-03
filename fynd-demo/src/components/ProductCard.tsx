/* A product card as the site draws it: the real photo on its warm tile,
   then the brand, the name, the price and the shop.

   `lift` (0–1) is a hover: the card rises a little with a soft shadow
   under the photo and its shop line comes forward. The photo itself is
   never altered. */
import React from 'react';
import { Img, staticFile } from 'remotion';
import { color, shadow, ui, type Layout } from '../styles/tokens';
import { mix } from '../lib/motion';
import type { Product } from '../data/types';

export const ProductCard: React.FC<{
  product: Product; layout: Layout; width?: number; lift?: number; opacity?: number; scale?: number;
  details?: boolean;
}> = ({ product, layout, width, lift = 0, opacity = 1, scale = 1, details = true }) => {
  const t = ui[layout].card;
  const w = width || t.width;
  const k = w / t.width; /* text scales with the card when it is drawn larger */
  return (
    <div style={{ width: w, opacity, transform: `translateY(${-6 * lift}px) scale(${scale})`, transformOrigin: '50% 40%' }}>
      <div
        style={{
          width: w, aspectRatio: '4 / 5', borderRadius: t.radius, background: color.tile, overflow: 'hidden',
          boxShadow: lift > 0 ? shadow.lift.replace('.28', (0.28 * lift).toFixed(3)) : 'none'
        }}
      >
        <Img src={staticFile(product.image)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
      {details && (
        <div style={{ paddingTop: 12 * k }}>
          <div style={{ fontSize: t.retailer * k, fontWeight: 600, color: color.primary, lineHeight: 1.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {product.brand}
          </div>
          <div style={{ fontSize: t.name * k, color: color.text2, lineHeight: 1.4, marginTop: 2 * k, height: t.name * 1.4 * 2 * k, overflow: 'hidden' }}>
            {product.name}
          </div>
          <div style={{ fontSize: t.price * k, fontWeight: 600, lineHeight: 1.55, marginTop: 4 * k, fontVariantNumeric: 'tabular-nums' }}>
            {product.price}
          </div>
          <div style={{ fontSize: t.seller * k, lineHeight: 1.55, color: lift > 0 ? mixHex(color.muted, color.text2, lift) : color.muted }}>
            {product.retailer}
          </div>
        </div>
      )}
    </div>
  );
};

function mixHex(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(mix(v, pb[i], t))).join(',')})`;
}
