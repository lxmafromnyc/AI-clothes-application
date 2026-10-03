/* What the film is made from. Every field here comes from a real Fynd
   search captured by scripts/collect-assets.mjs — nothing is written for
   the video. A preview fixture (scripts/make-fixture.mjs) has the same
   shape, says so in `source`, and can never be rendered as a final. */

export type Product = {
  id: string;
  brand: string;        /* as the card shows it */
  name: string;
  price: string;        /* formatted the way the site formats it */
  retailer: string;     /* the shop's host, as the card's seller line */
  image: string;        /* path under public/ */
  imageWidth: number;
  imageHeight: number;
  url: string;          /* the real product link */
};

export type Attribute = { label: string; value: string };

export type Search = {
  id: 'hoodie' | 'dress' | 'bag';
  query: string;
  count: number;        /* how many results the real search returned */
  attributes: Attribute[];   /* what Fynd read from the query */
  products: Product[];
};

export type Retailer = {
  productId: string;
  url: string;
  host: string;
  name: string;         /* the shop, as a person would say it */
  /* the real page as it loaded, captured at each shape's width; null
     when it did not load (the film then shows the handoff, never a
     page of its own) */
  screenshots: { desktop: string | null; mobile: string | null };
  loaded: boolean;
  outcome: string;      /* 'loaded', 'blocked', 'slow', … */
  checkedAt: string;
};

export type Captured = {
  source: 'real' | 'fixture';
  capturedAt: string;
  searches: Search[];
  choose: [string, string, string];   /* products A, B, C, from the hoodie search */
  retailer: Retailer;
  mosaic: string[];     /* product ids, from all three searches */
};

export type VoiceLine = {
  id: string;
  file: string;         /* path under public/ */
  durationInFrames: number;
  caption: string;
};

/* a spoken line, placed */
export type VoiceBeat = {
  id: string;
  audio: string;
  startFrame: number;
  durationInFrames: number;
  caption: string;
};
