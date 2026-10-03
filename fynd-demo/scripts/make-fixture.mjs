/* A preview fixture: the shape of the real data, made of nothing real.

   For working on the film where the real searches cannot be run (no
   product source, no network to the shops). Every photo is a labelled
   card that says FIXTURE, every name says it, every link goes to
   example.com, `source` is 'fixture' — and src/data/load.ts refuses to
   render it as a final. The film also stamps PREVIEW · FIXTURE DATA on
   every frame made from it.

   The one real thing in it is the reading of the request: the site's own
   local interpreter is run on the real query.

   npm run fixture   →   public/data/captured.fixture.json, public/fixture/ */
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC, attributesFrom, localInterpreter, writeJson } from './shared.mjs';

const OUT = path.join(PUBLIC, 'fixture');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const QUERIES = {
  hoodie: 'black oversized hoodie under $80',
  dress: 'cream linen midi dress for summer',
  bag: 'vintage Prada bag under $500'
};
const TONES = {
  hoodie: [['#2B2B2E', '#4A4A50'], ['#1F2226', '#3A3F46'], ['#33302E', '#57514C'], ['#26282B', '#45484D']],
  dress: [['#E9E2D3', '#D8CDB8'], ['#EFE8DA', '#DCD2BE'], ['#E4DCCB', '#CFC3AA'], ['#F1EBDF', '#DED4C2']],
  bag: [['#3B2F2A', '#6A5548'], ['#1E1C1B', '#45403C'], ['#5A4636', '#86705C'], ['#2E2A28', '#58504A']]
};

function photo(file, label, [a, b], dark) {
  const ink = dark ? '#FFFFFF' : '#2B2B2B';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
  <rect width="800" height="1000" fill="url(#g)"/>
  <rect x="40" y="40" width="720" height="920" fill="none" stroke="${ink}" stroke-opacity=".35" stroke-width="4" stroke-dasharray="18 14"/>
  <text x="400" y="480" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="64" font-weight="700" fill="${ink}" fill-opacity=".8">FIXTURE</text>
  <text x="400" y="550" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="34" fill="${ink}" fill-opacity=".7">${label}</text>
  <text x="400" y="600" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="26" fill="${ink}" fill-opacity=".55">not a product photo</text>
</svg>`;
  fs.writeFileSync(path.join(OUT, file), svg);
  return `fixture/${file}`;
}

function page(file, width, height, url) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#FAFAF8"/>
  <rect x="24" y="24" width="${width - 48}" height="${height - 48}" fill="none" stroke="#B42318" stroke-width="4" stroke-dasharray="20 14"/>
  <text x="${width / 2}" y="${height / 2 - 30}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${Math.round(width / 16)}" font-weight="700" fill="#B42318">FIXTURE</text>
  <text x="${width / 2}" y="${height / 2 + 20}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${Math.round(width / 40)}" fill="#6B6B6B">stands in for the retailer page captured by npm run collect</text>
  <text x="${width / 2}" y="${height / 2 + 60}" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="${Math.round(width / 48)}" fill="#6B6B6B">${url}</text>
</svg>`;
  fs.writeFileSync(path.join(OUT, file), svg);
  return `fixture/${file}`;
}

const Interpreter = localInterpreter();
const shops = ['shop-a', 'shop-b', 'shop-c', 'shop-d', 'shop-e', 'shop-f'];
const searches = Object.entries(QUERIES).map(([id, query]) => {
  const n = id === 'hoodie' ? 12 : 6;
  const products = Array.from({ length: n }, (_, i) => {
    const shop = shops[i % shops.length];
    const tones = TONES[id][i % 4];
    return {
      id: `${id}-${i + 1}`,
      brand: `Fixture Brand ${String.fromCharCode(65 + (i % 6))}`,
      name: `Fixture ${id} ${i + 1} — not a real listing`,
      price: '$00',
      retailer: `${shop}.example.com`,
      image: photo(`${id}-${i + 1}.svg`, `${id} ${i + 1}`, tones, id !== 'dress'),
      imageWidth: 800,
      imageHeight: 1000,
      url: `https://${shop}.example.com/products/fixture-${id}-${i + 1}`
    };
  });
  return {
    id, query, count: id === 'hoodie' ? 24 : 18,
    attributes: attributesFrom(Interpreter.localInterpret(query, {})),
    products
  };
});

const hoodie = searches[0];
const c = hoodie.products[3];
const data = {
  source: 'fixture',
  capturedAt: new Date(0).toISOString(),
  searches,
  choose: [hoodie.products[1].id, hoodie.products[2].id, c.id],
  retailer: {
    productId: c.id, url: c.url, host: c.retailer, name: 'Fixture Shop',
    screenshots: { desktop: page('retailer-desktop.svg', 1280, 800, c.url), mobile: page('retailer-mobile.svg', 390, 844, c.url) },
    loaded: true, outcome: 'loaded', checkedAt: new Date(0).toISOString()
  },
  mosaic: searches.flatMap((s) => s.products.slice(4, 7).map((p) => p.id))
};
writeJson(path.join(PUBLIC, 'data', 'captured.fixture.json'), data);
console.log(`Fixture written: ${searches.map((s) => `${s.id} ${s.products.length}`).join(', ')}; hoodie reads as ${hoodie.attributes.map((a) => a.value).join(' · ')}`);
