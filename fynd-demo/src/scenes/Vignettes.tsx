/* Breadth, inside scene 3: the two other real searches, cut in for a
   moment each — the dress (13.5–15.0s), then the Prada bag (15.0–16.5s).
   Each is its own results page as the site draws it: its heading, the
   request it answers, and its first real products. */
import React from 'react';
import { color, ui, type Layout } from '../styles/tokens';
import { BEAT } from '../data/timeline';
import { ease, mix, uiSpring } from '../lib/motion';
import { resultsLayout } from '../lib/layout';
import { clampView, placeY, restView, viewTransform, zoomAbout } from '../lib/camera';
import { ProductCard } from '../components/ProductCard';
import { ResultsHead } from '../components/ResultsHead';
import type { Search } from '../data/types';

const Vignette: React.FC<{ layout: Layout; frame: number; from: number; to: number; search: Search; exit: boolean }> = ({ layout, frame, from, to, search, exit }) => {
  if (frame < from || frame >= to + 12) return null;
  const R = resultsLayout(layout);
  const rest = restView(layout);
  /* close on the photographs, the heading kept just under the site header */
  const view = layout === 'desktop'
    ? placeY(layout, clampView(layout, { s: mix(1.12, 1.16, ease(frame, from, to)), cx: rest.cx, cy: 0 }), R.h2.y, ui.desktop.header + 16)
    : zoomAbout(layout, { x: rest.cx, y: R.gridTop + 120 }, mix(1, 1.03, ease(frame, from, to)));
  const out = exit ? 1 - ease(frame, to, to + 8) : 1;
  const ground = ease(frame, from, from + 5) * out;
  const content = ease(frame, from + 3, from + 9) * (exit ? 1 - ease(frame, to - 2, to + 3) : 1);
  return (
    <div style={{ position: 'absolute', inset: 0, background: color.bg, opacity: ground }}>
      <div style={{ position: 'absolute', inset: 0, transform: viewTransform(view, layout), transformOrigin: '0 0', opacity: content }}>
        <ResultsHead layout={layout} count={search.count} query={search.query} />
        {search.products.slice(0, 4).map((p, i) => {
          const r = R.cardRect(i);
          const s = uiSpring(frame, from + 2 + i * 2, 16);
          return (
            <div key={p.id} style={{ position: 'absolute', left: r.x, top: r.y + (1 - s) * 12, opacity: s }}>
              <ProductCard product={p} layout={layout} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const Vignettes: React.FC<{ layout: Layout; frame: number; dress: Search; bag: Search }> = ({ layout, frame, dress, bag }) => (
  <>
    <Vignette layout={layout} frame={frame} from={BEAT.dressFrom} to={BEAT.bagFrom} search={dress} exit={false} />
    <Vignette layout={layout} frame={frame} from={BEAT.bagFrom} to={BEAT.returnTo} search={bag} exit />
  </>
);
