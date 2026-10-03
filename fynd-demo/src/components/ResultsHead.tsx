/* The results heading as the site writes it: how many pieces came back,
   then the request it answers in smaller type. */
import React from 'react';
import { color, ui, type Layout } from '../styles/tokens';
import { resultsLayout } from '../lib/layout';

export const ResultsHead: React.FC<{ layout: Layout; count: number; query: string; headOpacity?: number; queryOpacity?: number }> = ({ layout, count, query, headOpacity = 1, queryOpacity = 1 }) => {
  const r = resultsLayout(layout);
  const t = ui[layout].results;
  return (
    <>
      <div style={{ position: 'absolute', left: r.h2.x, top: r.h2.y, fontSize: t.h2, fontWeight: 600, letterSpacing: t.h2 * -0.025, lineHeight: 1.2, opacity: headOpacity, whiteSpace: 'nowrap' }}>
        {count} {count === 1 ? 'piece' : 'pieces'} found
      </div>
      <ResultsQuery x={r.query.x} y={r.query.y} query={query} opacity={queryOpacity} width={r.query.w} />
    </>
  );
};

export const ResultsQuery: React.FC<{ x: number; y: number; query: string; opacity: number; width: number }> = ({ x, y, query, opacity, width }) => (
  <div style={{ position: 'absolute', left: x, top: y, width, fontSize: 16, lineHeight: 1.5, color: color.muted, opacity }}>
    Results for <span style={{ color: color.text2 }}>“{query}”</span>
  </div>
);
