/* The site header: the mark on the left; the navigation on a wide
   screen, the menu button on a phone. */
import React from 'react';
import { color, ui, type Layout } from '../styles/tokens';
import { BrandMark } from './BrandMark';

export const Header: React.FC<{ layout: Layout; opacity?: number }> = ({ layout, opacity = 1 }) => {
  const t = ui[layout];
  const W = layout === 'desktop' ? 1440 : 390;
  return (
    <div
      style={{
        position: 'absolute', left: 0, top: 0, width: W, height: t.header, opacity,
        borderBottom: `1px solid ${color.line}`, background: color.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `0 ${t.gutter}px`, boxSizing: 'border-box'
      }}
    >
      <BrandMark />
      {layout === 'desktop' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, fontSize: 15, fontWeight: 500 }}>
          <span style={{ borderBottom: `2px solid ${color.primary}`, paddingBottom: 3 }}>Search</span>
          <span style={{ color: color.muted }}>Discover</span>
          <span style={{ color: color.muted }}>Pricing</span>
          <span style={{ color: color.muted }}>About</span>
          <span style={{ width: 1, height: 26, background: color.line }} />
          <span style={{ color: color.muted }}>Account</span>
        </div>
      ) : (
        <div style={{ width: 22, height: 10, borderTop: `2px solid ${color.text}`, borderBottom: `2px solid ${color.text}` }} />
      )}
    </div>
  );
};
