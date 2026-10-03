/* The Fynd visual system, as the film uses it.

   Colours and type are the site's own (assets/styles.css). Sizes are the
   site's computed styles, measured from the live page at 1440px (desktop)
   and 390px (phone) — the film lays its UI out at those same CSS widths
   and zooms the whole stage up to the frame, so every proportion is the
   site's. */

export const color = {
  bg: '#FFFFFF',
  bgSubtle: '#F7F7F5',
  surface: '#FFFFFF',
  tile: '#F2F2EF',
  line: '#E7E7E3',
  lineStrong: '#D2D2CD',
  text: '#000000',
  text2: '#2B2B2B',
  muted: '#6B6B6B',
  primary: '#111111',
  invert: '#FFFFFF',
  accent: '#3E5BD8',
  accentInk: '#3553C6'
} as const;

export const font = {
  family: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
} as const;

export type Layout = 'desktop' | 'mobile';

/* the site's CSS width for each layout, and the zoom that brings it to
   the frame: 1440 → 1920, 390 → 1080 */
export const stage = {
  desktop: { width: 1440, frameWidth: 1920, frameHeight: 1080 },
  mobile: { width: 390, frameWidth: 1080, frameHeight: 1920 }
} as const;
export const zoomFor = (layout: Layout) => stage[layout].frameWidth / stage[layout].width;
export const stageHeight = (layout: Layout) => stage[layout].frameHeight / zoomFor(layout);

/* measured from the live site */
export const ui = {
  desktop: {
    header: 65, gutter: 120, brandMark: 26, brandWord: 20,
    h1: { size: 64, line: 67.2, track: -2.56 }, lead: { size: 19, line: 28.5 },
    search: { width: 760, height: 66, radius: 18, field: 19, button: { w: 100, h: 48, radius: 12 } },
    chip: 14,
    results: { h2: 28, query: 16 },
    card: { width: 282, gapX: 24, gapY: 40, radius: 12, retailer: 13, name: 14, price: 15, seller: 13 },
    columns: 4
  },
  mobile: {
    header: 61, gutter: 16, brandMark: 26, brandWord: 20,
    h1: { size: 34, line: 36.72, track: -1.36 }, lead: { size: 16, line: 24 },
    search: { width: 358, height: 116, radius: 18, field: 16, button: { w: 336, h: 50, radius: 12 } },
    chip: 14,
    results: { h2: 24, query: 16 },
    card: { width: 174, gapX: 10, gapY: 24, radius: 12, retailer: 12, name: 13.5, price: 14.5, seller: 12 },
    columns: 2
  }
} as const;

export const shadow = {
  search: '0 1px 2px rgba(0,0,0,.04), 0 8px 28px -12px rgba(0,0,0,.14)',
  searchFocus: '0 1px 2px rgba(0,0,0,.05), 0 14px 36px -14px rgba(0,0,0,.22)',
  lift: '0 18px 40px -18px rgba(0,0,0,.28)',
  frame: '0 30px 80px -30px rgba(0,0,0,.35)'
} as const;
