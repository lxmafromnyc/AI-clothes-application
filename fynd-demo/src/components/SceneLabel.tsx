/* The film's own words — a scene's short title. Small, quiet, the
   site's type; a black dot ahead of it says it is the film talking, not
   the page. */
import React from 'react';
import { color } from '../styles/tokens';

export const SceneLabel: React.FC<{ text: string; x: number; y: number; align?: 'left' | 'center' | 'right'; opacity: number; size?: number }> = ({ text, x, y, align = 'center', opacity, size = 14 }) => {
  const shift = align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0';
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, transform: `translate(${shift}, ${(1 - opacity) * 6}px)`, opacity,
        display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
        fontSize: size, fontWeight: 500, color: color.text2, letterSpacing: -0.1
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 3, background: color.primary }} />
      {text}
    </div>
  );
};
