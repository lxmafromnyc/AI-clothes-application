/* Where everything sits, in the site's own CSS pixels (the stage), for
   each layout. Components draw from these rectangles and the pointer aims
   at them, so a hover always lands on the card it means. */
import { ui, stageHeight, type Layout } from '../styles/tokens';

export type Rect = { x: number; y: number; w: number; h: number };
export const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function homeLayout(layout: Layout) {
  const t = ui[layout];
  const H = stageHeight(layout);
  const W = layout === 'desktop' ? 1440 : 390;
  if (layout === 'desktop') {
    const h1Top = Math.round((H - 366) / 2) + 24;
    const card: Rect = { x: (W - t.search.width) / 2, y: h1Top + 246, w: t.search.width, h: t.search.height };
    return {
      W, H,
      h1: { x: 0, y: h1Top, w: W, h: 134 } as Rect,
      lead: { x: (W - 560) / 2, y: h1Top + 153, w: 560, h: 57 } as Rect,
      card,
      field: { x: card.x + 53, y: card.y + 9, w: 542, h: 48 } as Rect,
      clear: { x: card.x + 591, y: card.y + 15, w: 36, h: 36 } as Rect,
      button: { x: card.x + card.w - 8 - t.search.button.w, y: card.y + 9, w: t.search.button.w, h: t.search.button.h } as Rect,
      chips: { x: 0, y: card.y + card.h + 18, w: W, h: 36 } as Rect
    };
  }
  const h1Top = 150;
  const card: Rect = { x: 16, y: h1Top + 164, w: t.search.width, h: t.search.height };
  return {
    W, H,
    h1: { x: 16, y: h1Top, w: 358, h: 73 } as Rect,
    lead: { x: 16, y: h1Top + 88, w: 358, h: 48 } as Rect,
    card,
    field: { x: card.x + 15, y: card.y + 5, w: 276, h: 48 } as Rect,
    clear: { x: card.x + 280, y: card.y + 11, w: 36, h: 36 } as Rect,
    button: { x: card.x + 15, y: card.y + 57, w: t.search.button.w, h: t.search.button.h } as Rect,
    chips: { x: 0, y: card.y + card.h + 16, w: W, h: 80 } as Rect
  };
}

export function resultsLayout(layout: Layout) {
  const t = ui[layout];
  const W = layout === 'desktop' ? 1440 : 390;
  const top = t.header + (layout === 'desktop' ? 40 : 28);
  const h2: Rect = { x: t.gutter, y: top, w: W - 2 * t.gutter, h: t.results.h2 * 1.2 };
  const query: Rect = { x: t.gutter, y: h2.y + h2.h + 6, w: h2.w, h: 25 };
  const gridTop = query.y + query.h + 28;
  const mediaH = t.card.width * 1.25;
  const cardH = mediaH + (layout === 'desktop' ? 105 : 119);
  const cardRect = (i: number): Rect => {
    const col = i % t.columns;
    const row = Math.floor(i / t.columns);
    return { x: t.gutter + col * (t.card.width + t.card.gapX), y: gridTop + row * (cardH + t.card.gapY), w: t.card.width, h: cardH };
  };
  const mediaRect = (i: number): Rect => ({ ...cardRect(i), h: mediaH });
  return { W, top, h2, query, gridTop, mediaH, cardH, cardRect, mediaRect, columns: t.columns };
}
