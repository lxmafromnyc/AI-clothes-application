/* The Fynd mark as the site draws it: a black rounded tile with the F,
   and the word beside it. */
import React from 'react';
import { color } from '../styles/tokens';

export const BrandMark: React.FC<{ size?: number }> = ({ size = 1 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 9 * size }}>
    <div
      style={{
        width: 26 * size, height: 26 * size, borderRadius: 7 * size, background: color.primary,
        color: color.invert, fontSize: 15 * size, fontWeight: 700, lineHeight: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
    >
      F
    </div>
    <div style={{ fontSize: 20 * size, fontWeight: 700, letterSpacing: -0.7 * size, lineHeight: 1 }}>Fynd</div>
  </div>
);
