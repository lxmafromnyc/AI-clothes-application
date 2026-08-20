/* =========================================================
   FindWear — product data

   One shape for every product, whether it is a real listing or a sample
   row. Rendering never inspects anything else, so this array can be
   replaced wholesale by an export from a real product feed and the whole
   site keeps working.

     id          number        stable identifier
     name        string        product name as the retailer lists it
     brand       string        brand or retailer name
     price       number|null   listed price in USD; null hides the price
     productUrl  string|null   official product page; null renders no link
     imageUrl    string|null   product photo; null falls back to drawn art
     type        string        garment kind, selects the fallback artwork
     color       string        colour family, used for matching and art
     styles      string[]      matching vocabulary, see STYLES below
     occasions   string[]      matching vocabulary, see OCCASIONS below
     fits        string[]      matching vocabulary, see FITS below

   price and imageUrl are null on every row today because no retailer
   domain or image host is reachable from the build environment, so
   neither could be read from the source. Populating them is a data job,
   not a code change: set the fields and the frontend renders them. An
   imageUrl that fails to load falls back to the drawn tile, so a feed
   with some dead image links degrades cleanly rather than breaking.
   ========================================================= */

const STYLES = ['Minimal', 'Classic', 'Streetwear', 'Sporty', 'Bohemian', 'Bold'];
const OCCASIONS = ['Everyday', 'Work', 'Evening', 'Weekend', 'Active'];
const FITS = ['Slim', 'Regular', 'Relaxed', 'Oversized'];

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

const PRODUCTS = [
  {
    id: 101,
    name: "Men's Extra Fine Merino Crew Neck Long-Sleeve Sweater",
    brand: 'UNIQLO',
    price: null,
    productUrl: 'https://www.uniqlo.com/us/en/products/E429066-000/00',
    imageUrl: null,
    type: 'knit',
    color: 'Neutral',
    styles: ['Minimal', 'Classic'],
    occasions: ['Work', 'Everyday'],
    fits: ['Regular', 'Slim']
  },
  {
    id: 102,
    name: 'Oxford Shirt — White',
    brand: 'ZARA',
    price: null,
    productUrl: 'https://www.zara.com/us/en/oxford-shirt-p06887613.html',
    imageUrl: null,
    type: 'shirt',
    color: 'White',
    styles: ['Classic', 'Minimal'],
    occasions: ['Work', 'Everyday'],
    fits: ['Regular']
  },
  {
    id: 103,
    name: "XX Chino Standard Taper Fit Men's Pants — Black",
    brand: "LEVI'S",
    price: null,
    productUrl: 'https://www.levi.com/US/en_US/chino-pants/levis-chino-pants-for-men/levis-xx-chino-standard-taper-fit-mens-pants/p/171960005',
    imageUrl: null,
    type: 'trousers',
    color: 'Black',
    styles: ['Minimal', 'Classic'],
    occasions: ['Work', 'Everyday'],
    fits: ['Slim', 'Regular']
  },
  {
    id: 1,
    name: 'Boxy Cotton Tee',
    brand: 'Northfold',
    price: 42,
    productUrl: null,
    imageUrl: null,
    type: 'tee',
    color: 'White',
    styles: ['Minimal', 'Sporty'],
    occasions: ['Everyday', 'Weekend'],
    fits: ['Relaxed', 'Oversized']
  },
  {
    id: 2,
    name: 'Merino Crew Knit',
    brand: 'Halden',
    price: 128,
    productUrl: null,
    imageUrl: null,
    type: 'knit',
    color: 'Neutral',
    styles: ['Minimal', 'Classic'],
    occasions: ['Work', 'Everyday'],
    fits: ['Regular', 'Slim']
  },
  {
    id: 3,
    name: 'Wide Leg Trouser',
    brand: 'Coveworks',
    price: 96,
    productUrl: null,
    imageUrl: null,
    type: 'trousers',
    color: 'Black',
    styles: ['Minimal', 'Classic'],
    occasions: ['Work', 'Evening'],
    fits: ['Relaxed']
  },
  {
    id: 4,
    name: 'Cropped Track Jacket',
    brand: 'Atlas Supply',
    price: 88,
    productUrl: null,
    imageUrl: null,
    type: 'jacket',
    color: 'Bright',
    styles: ['Streetwear', 'Sporty'],
    occasions: ['Weekend', 'Active'],
    fits: ['Regular', 'Relaxed']
  },
  {
    id: 5,
    name: 'Slip Midi Dress',
    brand: 'Rue Nine',
    price: 145,
    productUrl: null,
    imageUrl: null,
    type: 'dress',
    color: 'Pastel',
    styles: ['Bohemian', 'Classic'],
    occasions: ['Evening', 'Weekend'],
    fits: ['Slim', 'Regular']
  },
  {
    id: 6,
    name: 'Washed Denim Jacket',
    brand: 'Terrace',
    price: 118,
    productUrl: null,
    imageUrl: null,
    type: 'jacket',
    color: 'Blue',
    styles: ['Classic', 'Streetwear'],
    occasions: ['Everyday', 'Weekend'],
    fits: ['Regular', 'Oversized']
  },
  {
    id: 7,
    name: 'Poplin Shirt',
    brand: 'Kinfield',
    price: 74,
    productUrl: null,
    imageUrl: null,
    type: 'shirt',
    color: 'White',
    styles: ['Minimal', 'Classic'],
    occasions: ['Work', 'Everyday'],
    fits: ['Slim', 'Regular']
  },
  {
    id: 8,
    name: 'Ribbed Knit Skirt',
    brand: 'Solstice',
    price: 68,
    productUrl: null,
    imageUrl: null,
    type: 'skirt',
    color: 'Earth',
    styles: ['Minimal', 'Bohemian'],
    occasions: ['Everyday', 'Work'],
    fits: ['Slim', 'Regular']
  },
  {
    id: 9,
    name: 'Oversized Hoodie',
    brand: 'Atlas Supply',
    price: 79,
    productUrl: null,
    imageUrl: null,
    type: 'knit',
    color: 'Green',
    styles: ['Streetwear', 'Sporty'],
    occasions: ['Weekend', 'Active'],
    fits: ['Oversized', 'Relaxed']
  },
  {
    id: 10,
    name: 'Tailored Wool Coat',
    brand: 'Halden',
    price: 298,
    productUrl: null,
    imageUrl: null,
    type: 'coat',
    color: 'Neutral',
    styles: ['Classic', 'Minimal'],
    occasions: ['Work', 'Evening'],
    fits: ['Regular', 'Slim']
  },
  {
    id: 11,
    name: 'Cargo Utility Pant',
    brand: 'Coveworks',
    price: 92,
    productUrl: null,
    imageUrl: null,
    type: 'trousers',
    color: 'Green',
    styles: ['Streetwear', 'Sporty'],
    occasions: ['Everyday', 'Weekend'],
    fits: ['Relaxed', 'Oversized']
  },
  {
    id: 12,
    name: 'Silk Column Dress',
    brand: 'Rue Nine',
    price: 245,
    productUrl: null,
    imageUrl: null,
    type: 'dress',
    color: 'Black',
    styles: ['Classic', 'Bold'],
    occasions: ['Evening'],
    fits: ['Slim']
  },
  {
    id: 13,
    name: 'Court Sneaker',
    brand: 'Northfold',
    price: 110,
    productUrl: null,
    imageUrl: null,
    type: 'sneaker',
    color: 'White',
    styles: ['Minimal', 'Sporty'],
    occasions: ['Everyday', 'Active'],
    fits: ['Regular']
  },
  {
    id: 14,
    name: 'Linen Camp Shirt',
    brand: 'Terrace',
    price: 64,
    productUrl: null,
    imageUrl: null,
    type: 'shirt',
    color: 'Blue',
    styles: ['Bohemian', 'Classic'],
    occasions: ['Weekend', 'Everyday'],
    fits: ['Relaxed']
  },
  {
    id: 15,
    name: 'Performance Short',
    brand: 'Atlas Supply',
    price: 48,
    productUrl: null,
    imageUrl: null,
    type: 'shorts',
    color: 'Black',
    styles: ['Sporty'],
    occasions: ['Active', 'Weekend'],
    fits: ['Regular', 'Slim']
  },
  {
    id: 16,
    name: 'Colour Block Knit',
    brand: 'Solstice',
    price: 132,
    productUrl: null,
    imageUrl: null,
    type: 'knit',
    color: 'Bright',
    styles: ['Bold', 'Streetwear'],
    occasions: ['Weekend', 'Everyday'],
    fits: ['Relaxed', 'Oversized']
  },
  {
    id: 17,
    name: 'Pleated Midi Skirt',
    brand: 'Kinfield',
    price: 86,
    productUrl: null,
    imageUrl: null,
    type: 'skirt',
    color: 'Pastel',
    styles: ['Classic', 'Bohemian'],
    occasions: ['Work', 'Evening'],
    fits: ['Regular']
  },
  {
    id: 18,
    name: 'Straight Leg Jean',
    brand: 'Terrace',
    price: 108,
    productUrl: null,
    imageUrl: null,
    type: 'trousers',
    color: 'Blue',
    styles: ['Classic', 'Streetwear'],
    occasions: ['Everyday', 'Weekend'],
    fits: ['Regular', 'Slim']
  },
  {
    id: 19,
    name: 'Cropped Puffer',
    brand: 'Coveworks',
    price: 189,
    productUrl: null,
    imageUrl: null,
    type: 'jacket',
    color: 'Bright',
    styles: ['Bold', 'Sporty'],
    occasions: ['Weekend', 'Active'],
    fits: ['Regular', 'Oversized']
  },
  {
    id: 20,
    name: 'Tencel Wrap Top',
    brand: 'Rue Nine',
    price: 58,
    productUrl: null,
    imageUrl: null,
    type: 'shirt',
    color: 'Earth',
    styles: ['Bohemian', 'Minimal'],
    occasions: ['Everyday', 'Evening'],
    fits: ['Slim', 'Regular']
  },
  {
    id: 21,
    name: 'Heavyweight Pocket Tee',
    brand: 'Northfold',
    price: 38,
    productUrl: null,
    imageUrl: null,
    type: 'tee',
    color: 'Neutral',
    styles: ['Minimal', 'Streetwear'],
    occasions: ['Everyday', 'Weekend'],
    fits: ['Relaxed', 'Regular']
  },
  {
    id: 22,
    name: 'Double Breasted Blazer',
    brand: 'Halden',
    price: 210,
    productUrl: null,
    imageUrl: null,
    type: 'jacket',
    color: 'Neutral',
    styles: ['Classic', 'Bold'],
    occasions: ['Work', 'Evening'],
    fits: ['Regular', 'Oversized']
  },
  {
    id: 23,
    name: 'Printed Maxi Dress',
    brand: 'Solstice',
    price: 156,
    productUrl: null,
    imageUrl: null,
    type: 'dress',
    color: 'Green',
    styles: ['Bohemian', 'Bold'],
    occasions: ['Weekend', 'Evening'],
    fits: ['Relaxed']
  },
  {
    id: 24,
    name: 'Fleece Sweatpant',
    brand: 'Kinfield',
    price: 72,
    productUrl: null,
    imageUrl: null,
    type: 'trousers',
    color: 'Earth',
    styles: ['Sporty', 'Streetwear'],
    occasions: ['Everyday', 'Active'],
    fits: ['Relaxed', 'Oversized']
  }
];

/* Brand list for the Find Clothes filter, derived from the data so it can
   never drift out of sync with the products actually present. */
const BRANDS = [...new Set(PRODUCTS.map((p) => p.brand))].sort();

/* The homepage demo panel: product ids plus the match score shown. */
const HERO_PICKS = [
  { id: 101, score: 96 },
  { id: 102, score: 93 },
  { id: 103, score: 91 }
];

const productById = (id) => PRODUCTS.find((p) => p.id === id);
