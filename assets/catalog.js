/* =========================================================
   FindWear — sample catalog + shared rendering helpers
   ========================================================= */

const STYLES = ['Minimal', 'Classic', 'Streetwear', 'Sporty', 'Bohemian', 'Bold'];
const OCCASIONS = ['Everyday', 'Work', 'Evening', 'Weekend', 'Active'];
const FITS = ['Slim', 'Regular', 'Relaxed', 'Oversized'];
const BRANDS = ['Northfold', 'Halden', 'Coveworks', 'Atlas Supply', 'Rue Nine', 'Terrace', 'Kinfield', 'Solstice'];

/* colour families drive the card artwork */
const COLORS = {
  Neutral: { dot: '#D7C9B6', from: '#F0E9DF', to: '#CDBCA6', dark: false },
  Black:   { dot: '#1E1E22', from: '#33333A', to: '#121216', dark: true },
  White:   { dot: '#F5F4F1', from: '#FFFFFF', to: '#E6E4DE', dark: false },
  Blue:    { dot: '#5B7FB9', from: '#D3E0F4', to: '#5B7FB9', dark: true },
  Green:   { dot: '#6F8F70', from: '#DCE7D8', to: '#6F8F70', dark: true },
  Earth:   { dot: '#A97B54', from: '#EFD9C4', to: '#A97B54', dark: true },
  Pastel:  { dot: '#E4C6E6', from: '#FBE6EE', to: '#D9C6F0', dark: false },
  Bright:  { dot: '#EF6F5B', from: '#FFD98A', to: '#EF6F5B', dark: true }
};

/* abstract garment silhouettes, 64x64 grid */
const SILHOUETTES = {
  tee: '<path d="M22 12 L12 17 L8 25 L15 29 L18 26 L18 54 L46 54 L46 26 L49 29 L56 25 L52 17 L42 12 C40 17 24 17 22 12 Z"/>',
  shirt: '<path d="M23 12 L13 17 L8 26 L15 30 L18 27 L18 55 L46 55 L46 27 L49 30 L56 26 L51 17 L41 12 L32 20 Z"/><path d="M31 21 h2 v34 h-2 z" opacity=".45"/>',
  knit: '<path d="M21 12 L8 18 L4 32 L12 36 L17 29 L17 51 L47 51 L47 29 L52 36 L60 32 L56 18 L43 12 C41 18 23 18 21 12 Z"/><path d="M17 51 h30 v5 h-30 z" opacity=".5"/>',
  jacket: '<path d="M23 11 L11 17 L6 28 L13 32 L16 28 L16 56 L30 56 L30 22 Z"/><path d="M41 11 L53 17 L58 28 L51 32 L48 28 L48 56 L34 56 L34 22 Z"/>',
  coat: '<path d="M23 9 L10 16 L5 31 L13 35 L16 29 L16 60 L48 60 L48 29 L51 35 L59 31 L54 16 L41 9 L32 20 Z"/><path d="M16 36 h32 v4 h-32 z" opacity=".45"/>',
  dress: '<path d="M24 11 L15 16 L19 26 L22 24 L12 57 L52 57 L42 24 L45 26 L49 16 L40 11 C38 17 26 17 24 11 Z"/>',
  trousers: '<path d="M17 9 h30 l2 48 h-13 l-4 -30 l-4 30 h-13 z"/>',
  skirt: '<path d="M20 14 h24 l9 38 h-42 z"/>',
  shorts: '<path d="M17 11 h30 l2 26 h-13 l-4 -14 l-4 14 h-13 z"/>',
  sneaker: '<path d="M9 44 L9 39 L20 35 L28 28 L33 28 L38 37 L46 39 L54 42 L54 47 L9 47 Z"/><path d="M7 47 h50 v5 h-50 z" opacity=".5"/>'
};

const CATALOG = [
  { id: 1,  name: 'Boxy Cotton Tee',        brand: 'Northfold',    price: 42,  type: 'tee',      color: 'White',   styles: ['Minimal', 'Sporty'],        occasions: ['Everyday', 'Weekend'], fits: ['Relaxed', 'Oversized'] },
  { id: 2,  name: 'Merino Crew Knit',       brand: 'Halden',       price: 128, type: 'knit',     color: 'Neutral', styles: ['Minimal', 'Classic'],       occasions: ['Work', 'Everyday'],    fits: ['Regular', 'Slim'] },
  { id: 3,  name: 'Wide Leg Trouser',       brand: 'Coveworks',    price: 96,  type: 'trousers', color: 'Black',   styles: ['Minimal', 'Classic'],       occasions: ['Work', 'Evening'],     fits: ['Relaxed'] },
  { id: 4,  name: 'Cropped Track Jacket',   brand: 'Atlas Supply', price: 88,  type: 'jacket',   color: 'Bright',  styles: ['Streetwear', 'Sporty'],     occasions: ['Weekend', 'Active'],   fits: ['Regular', 'Relaxed'] },
  { id: 5,  name: 'Slip Midi Dress',        brand: 'Rue Nine',     price: 145, type: 'dress',    color: 'Pastel',  styles: ['Bohemian', 'Classic'],      occasions: ['Evening', 'Weekend'],  fits: ['Slim', 'Regular'] },
  { id: 6,  name: 'Washed Denim Jacket',    brand: 'Terrace',      price: 118, type: 'jacket',   color: 'Blue',    styles: ['Classic', 'Streetwear'],    occasions: ['Everyday', 'Weekend'], fits: ['Regular', 'Oversized'] },
  { id: 7,  name: 'Poplin Shirt',           brand: 'Kinfield',     price: 74,  type: 'shirt',    color: 'White',   styles: ['Minimal', 'Classic'],       occasions: ['Work', 'Everyday'],    fits: ['Slim', 'Regular'] },
  { id: 8,  name: 'Ribbed Knit Skirt',      brand: 'Solstice',     price: 68,  type: 'skirt',    color: 'Earth',   styles: ['Minimal', 'Bohemian'],      occasions: ['Everyday', 'Work'],    fits: ['Slim', 'Regular'] },
  { id: 9,  name: 'Oversized Hoodie',       brand: 'Atlas Supply', price: 79,  type: 'knit',     color: 'Green',   styles: ['Streetwear', 'Sporty'],     occasions: ['Weekend', 'Active'],   fits: ['Oversized', 'Relaxed'] },
  { id: 10, name: 'Tailored Wool Coat',     brand: 'Halden',       price: 298, type: 'coat',     color: 'Neutral', styles: ['Classic', 'Minimal'],       occasions: ['Work', 'Evening'],     fits: ['Regular', 'Slim'] },
  { id: 11, name: 'Cargo Utility Pant',     brand: 'Coveworks',    price: 92,  type: 'trousers', color: 'Green',   styles: ['Streetwear', 'Sporty'],     occasions: ['Everyday', 'Weekend'], fits: ['Relaxed', 'Oversized'] },
  { id: 12, name: 'Silk Column Dress',      brand: 'Rue Nine',     price: 245, type: 'dress',    color: 'Black',   styles: ['Classic', 'Bold'],          occasions: ['Evening'],             fits: ['Slim'] },
  { id: 13, name: 'Court Sneaker',          brand: 'Northfold',    price: 110, type: 'sneaker',  color: 'White',   styles: ['Minimal', 'Sporty'],        occasions: ['Everyday', 'Active'],  fits: ['Regular'] },
  { id: 14, name: 'Linen Camp Shirt',       brand: 'Terrace',      price: 64,  type: 'shirt',    color: 'Blue',    styles: ['Bohemian', 'Classic'],      occasions: ['Weekend', 'Everyday'], fits: ['Relaxed'] },
  { id: 15, name: 'Performance Short',      brand: 'Atlas Supply', price: 48,  type: 'shorts',   color: 'Black',   styles: ['Sporty'],                   occasions: ['Active', 'Weekend'],   fits: ['Regular', 'Slim'] },
  { id: 16, name: 'Colour Block Knit',      brand: 'Solstice',     price: 132, type: 'knit',     color: 'Bright',  styles: ['Bold', 'Streetwear'],       occasions: ['Weekend', 'Everyday'], fits: ['Relaxed', 'Oversized'] },
  { id: 17, name: 'Pleated Midi Skirt',     brand: 'Kinfield',     price: 86,  type: 'skirt',    color: 'Pastel',  styles: ['Classic', 'Bohemian'],      occasions: ['Work', 'Evening'],     fits: ['Regular'] },
  { id: 18, name: 'Straight Leg Jean',      brand: 'Terrace',      price: 108, type: 'trousers', color: 'Blue',    styles: ['Classic', 'Streetwear'],    occasions: ['Everyday', 'Weekend'], fits: ['Regular', 'Slim'] },
  { id: 19, name: 'Cropped Puffer',         brand: 'Coveworks',    price: 189, type: 'jacket',   color: 'Bright',  styles: ['Bold', 'Sporty'],           occasions: ['Weekend', 'Active'],   fits: ['Regular', 'Oversized'] },
  { id: 20, name: 'Tencel Wrap Top',        brand: 'Rue Nine',     price: 58,  type: 'shirt',    color: 'Earth',   styles: ['Bohemian', 'Minimal'],      occasions: ['Everyday', 'Evening'], fits: ['Slim', 'Regular'] },
  { id: 21, name: 'Heavyweight Pocket Tee', brand: 'Northfold',    price: 38,  type: 'tee',      color: 'Neutral', styles: ['Minimal', 'Streetwear'],    occasions: ['Everyday', 'Weekend'], fits: ['Relaxed', 'Regular'] },
  { id: 22, name: 'Double Breasted Blazer', brand: 'Halden',       price: 210, type: 'jacket',   color: 'Neutral', styles: ['Classic', 'Bold'],          occasions: ['Work', 'Evening'],     fits: ['Regular', 'Oversized'] },
  { id: 23, name: 'Printed Maxi Dress',     brand: 'Solstice',     price: 156, type: 'dress',    color: 'Green',   styles: ['Bohemian', 'Bold'],         occasions: ['Weekend', 'Evening'],  fits: ['Relaxed'] },
  { id: 24, name: 'Fleece Sweatpant',       brand: 'Kinfield',     price: 72,  type: 'trousers', color: 'Earth',   styles: ['Sporty', 'Streetwear'],     occasions: ['Everyday', 'Active'],  fits: ['Relaxed', 'Oversized'] }
];

/* ---------- rendering ---------- */

function tileArt(item) {
  const c = COLORS[item.color];
  const ink = c.dark ? 'rgba(255,255,255,.44)' : 'rgba(22,23,28,.26)';
  return `<div class="item-media" style="background:linear-gradient(150deg, ${c.from}, ${c.to})">
      <svg class="silhouette" viewBox="0 0 64 64" fill="${ink}" aria-hidden="true">${SILHOUETTES[item.type]}</svg>`;
}

function miniArt(item) {
  const c = COLORS[item.color];
  const ink = c.dark ? 'rgba(255,255,255,.46)' : 'rgba(22,23,28,.26)';
  return `<div class="mini-thumb" style="background:linear-gradient(150deg, ${c.from}, ${c.to})">
      <svg viewBox="0 0 64 64" fill="${ink}" aria-hidden="true">${SILHOUETTES[item.type]}</svg></div>`;
}

const SPARK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"/></svg>';

/* card for the Find Clothes results (with match score + reason) */
function resultCard(item, index) {
  return `<article class="item-card" style="--i:${index}">
    ${tileArt(item)}
      <span class="item-badge">${item.score}% match</span>
    </div>
    <div class="item-body">
      <p class="item-brand">${item.brand}</p>
      <h3 class="item-name">${item.name}</h3>
      <div class="item-row">
        <span class="item-price">$${item.price}</span>
        <div class="item-tags"><span>${item.color}</span><span>${item.fits[0]}</span></div>
      </div>
      <p class="item-why">${SPARK}<span>${item.why}</span></p>
    </div>
  </article>`;
}

/* card for Discover (browsing, no score) */
function browseCard(item, index) {
  return `<article class="item-card" style="--i:${index}">
    ${tileArt(item)}
      <span class="item-badge">${item.styles[0]}</span>
    </div>
    <div class="item-body">
      <p class="item-brand">${item.brand}</p>
      <h3 class="item-name">${item.name}</h3>
      <div class="item-row">
        <span class="item-price">$${item.price}</span>
        <div class="item-tags"><span>${item.color}</span><span>${item.occasions[0]}</span></div>
      </div>
    </div>
  </article>`;
}
