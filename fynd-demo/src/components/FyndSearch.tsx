/* The search box as the site draws it, holding whatever has been typed so
   far. `focus` (0–1) is how far the box has come forward as the request
   is entered: a firmer border and a deeper shadow, never a glow. */
import React from 'react';
import { color, shadow, ui, type Layout } from '../styles/tokens';
import { mix } from '../lib/motion';
import type { Rect } from '../lib/layout';

const SearchIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={color.muted} strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.8-3.8" />
  </svg>
);
const ClipIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color.muted} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.4 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.2 9.19a2 2 0 01-2.82-2.83l8.49-8.48" />
  </svg>
);
const ClearIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={color.muted} strokeWidth="2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const FyndSearch: React.FC<{
  layout: Layout; card: Rect; text: string; caret: boolean; focus: number; pressed?: number; textOpacity?: number; placeholder?: string;
}> = ({ layout, card, text, caret, focus, pressed = 0, textOpacity = 1, placeholder = '' }) => {
  const t = ui[layout];
  const desktop = layout === 'desktop';
  const button = (
    <div
      style={{
        width: t.search.button.w, height: t.search.button.h, borderRadius: t.search.button.radius,
        background: color.primary, color: color.invert, fontSize: 15, fontWeight: 600, letterSpacing: -0.075,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        transform: `scale(${1 - 0.02 * pressed})`, opacity: 1 - 0.12 * pressed
      }}
    >
      Search
    </div>
  );
  const field = (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0, height: 48 }}>
      <div style={{ position: 'relative', fontSize: t.search.field, letterSpacing: desktop ? -0.19 : -0.16, whiteSpace: 'nowrap', overflow: 'hidden', opacity: textOpacity, display: 'flex', alignItems: 'center' }}>
        {/* the caret sits before the placeholder, as in a real empty box */}
        {text}
        <span style={{ display: 'inline-block', width: 1.5, height: t.search.field * 1.2, background: color.text, marginLeft: text ? 1 : 0, opacity: caret ? 1 : 0, flex: 'none' }} />
        {!text && placeholder && <span style={{ color: color.muted, marginLeft: -1.5 }}>{placeholder}</span>}
      </div>
    </div>
  );
  const icons = (
    <div style={{ display: text ? 'flex' : 'none', alignItems: 'center', gap: 10, padding: '0 10px' }}>
      <ClearIcon />
    </div>
  );
  return (
    <div
      style={{
        position: 'absolute', left: card.x, top: card.y, width: card.w, height: card.h, boxSizing: 'border-box',
        borderRadius: t.search.radius, background: color.surface,
        border: `1px solid ${color.lineStrong}`,
        boxShadow: focus > 0 ? mixShadow(focus) : shadow.search,
        transform: `scale(${1 + 0.015 * focus})`, transformOrigin: '50% 50%',
        display: 'flex', flexDirection: desktop ? 'row' : 'column', alignItems: desktop ? 'center' : 'stretch',
        padding: desktop ? '8px 8px 8px 20px' : '4px 6px 8px 14px', gap: desktop ? 12 : 4
      }}
    >
      {desktop ? (
        <>
          <SearchIcon />
          {field}
          {icons}
          <ClipIcon />
          <div style={{ width: 4 }} />
          {button}
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {field}
            {icons}
            <div style={{ padding: '0 6px' }}><ClipIcon /></div>
          </div>
          {button}
        </>
      )}
    </div>
  );
};

/* the resting shadow deepening toward the focused one */
function mixShadow(t: number) {
  const a = mix(0.14, 0.22, t);
  const blur = mix(28, 36, t);
  const y = mix(8, 14, t);
  return `0 1px 2px rgba(0,0,0,.04), 0 ${y}px ${blur}px -${mix(12, 14, t)}px rgba(0,0,0,${a.toFixed(3)})`;
}
