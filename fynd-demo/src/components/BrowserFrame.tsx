/* A plain browser window: a quiet top bar with the real address in it,
   and whatever is inside. It draws no site of its own — inside it goes
   the real retailer page as it was captured, or nothing. */
import React from 'react';
import { color, shadow } from '../styles/tokens';

export const BrowserFrame: React.FC<{
  width: number; height: number; address: string; children?: React.ReactNode; phone?: boolean; chrome?: number;
}> = ({ width, height, address, children, phone, chrome = 1 }) => (
  <div
    style={{
      width, height, borderRadius: phone ? 22 : 12, overflow: 'hidden', background: color.surface,
      boxShadow: shadow.frame.replace('.35', (0.35 * chrome).toFixed(3)), border: `1px solid ${color.line}`, display: 'flex', flexDirection: 'column'
    }}
  >
    <div style={{ height: phone ? 44 : 38, flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px', background: color.bgSubtle, borderBottom: `1px solid ${color.line}`, opacity: chrome }}>
      {!phone && (
        <div style={{ display: 'flex', gap: 6 }}>
          {[0, 1, 2].map((i) => <div key={i} style={{ width: 9, height: 9, borderRadius: 5, background: color.lineStrong }} />)}
        </div>
      )}
      <div
        style={{
          flex: 1, height: phone ? 28 : 24, borderRadius: 7, background: color.surface, border: `1px solid ${color.line}`,
          display: 'flex', alignItems: 'center', justifyContent: phone ? 'center' : 'flex-start', padding: '0 10px',
          fontSize: phone ? 12 : 12.5, color: color.text2, whiteSpace: 'nowrap', overflow: 'hidden'
        }}
      >
        <svg width="10" height="11" viewBox="0 0 10 11" style={{ marginRight: 6, flex: 'none' }}>
          <rect x="1" y="5" width="8" height="5.5" rx="1.2" fill={color.muted} />
          <path d="M2.8 5V3.6a2.2 2.2 0 014.4 0V5" fill="none" stroke={color.muted} strokeWidth="1.2" />
        </svg>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{address}</span>
      </div>
    </div>
    <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: color.surface }}>{children}</div>
  </div>
);
