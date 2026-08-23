/* =========================================================
   Fynd — demo product source

   Source records in the shape a real feed supplies. Nothing here is
   consumed directly: assets/products.js normalises these before anything
   renders, so this file can be replaced by a feed export, an API response
   or a database dump without touching the interface.

     Products.load(DEMO_PRODUCTS)          this file
     Products.load('/api/products.json')   a URL returning JSON
     Products.load(() => queryDb())        a function or promise

   price and imageUrl are null on every row because no retailer domain or
   image host is reachable from the build environment, so neither could be
   read from the source. Both are ordinary fields: fill them in and the
   interface renders them, with no local image files involved. A product
   whose imageUrl is missing or fails to load keeps the drawn artwork.

   The three rows carrying a productUrl are real listings. The rest are
   sample rows that exist to give the demo a catalogue to search.
   ========================================================= */

const DEMO_PRODUCTS = [
  {
    id: 'uniqlo-merino-crew',
    name: "Men's Extra Fine Merino Crew Neck Long-Sleeve Sweater",
    brand: 'UNIQLO',
    price: null,
    productUrl: 'https://www.uniqlo.com/us/en/products/E429066-000/00',
    imageUrl: null,
    category: 'knit',
    style: ['Minimal', 'Classic'],
    occasion: ['Work', 'Everyday'],
    fit: ['Regular', 'Slim'],
    colors: ['Neutral'],
    sizes: []
  },
  {
    id: 'zara-oxford-shirt',
    name: 'Oxford Shirt — White',
    brand: 'ZARA',
    price: null,
    productUrl: 'https://www.zara.com/us/en/oxford-shirt-p06887613.html',
    imageUrl: null,
    category: 'shirt',
    style: ['Classic', 'Minimal'],
    occasion: ['Work', 'Everyday'],
    fit: ['Regular'],
    colors: ['White'],
    sizes: []
  },
  {
    id: 'levis-xx-chino-taper',
    name: "XX Chino Standard Taper Fit Men's Pants — Black",
    brand: "LEVI'S",
    price: null,
    productUrl: 'https://www.levi.com/US/en_US/chino-pants/levis-chino-pants-for-men/levis-xx-chino-standard-taper-fit-mens-pants/p/171960005',
    imageUrl: null,
    category: 'trousers',
    style: ['Minimal', 'Classic'],
    occasion: ['Work', 'Everyday'],
    fit: ['Slim', 'Regular'],
    colors: ['Black'],
    sizes: []
  },
  {
    id: 'sample-northfold-boxy-cotton-tee',
    name: 'Boxy Cotton Tee',
    brand: 'Northfold',
    price: 42,
    productUrl: null,
    imageUrl: null,
    category: 'tee',
    style: ['Minimal', 'Sporty'],
    occasion: ['Everyday', 'Weekend'],
    fit: ['Relaxed', 'Oversized'],
    colors: ['White'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-halden-merino-crew-knit',
    name: 'Merino Crew Knit',
    brand: 'Halden',
    price: 128,
    productUrl: null,
    imageUrl: null,
    category: 'knit',
    style: ['Minimal', 'Classic'],
    occasion: ['Work', 'Everyday'],
    fit: ['Regular', 'Slim'],
    colors: ['Neutral'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-coveworks-wide-leg-trouser',
    name: 'Wide Leg Trouser',
    brand: 'Coveworks',
    price: 96,
    productUrl: null,
    imageUrl: null,
    category: 'trousers',
    style: ['Minimal', 'Classic'],
    occasion: ['Work', 'Evening'],
    fit: ['Relaxed'],
    colors: ['Black'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-atlas-supply-cropped-track-jacket',
    name: 'Cropped Track Jacket',
    brand: 'Atlas Supply',
    price: 88,
    productUrl: null,
    imageUrl: null,
    category: 'jacket',
    style: ['Streetwear', 'Sporty'],
    occasion: ['Weekend', 'Active'],
    fit: ['Regular', 'Relaxed'],
    colors: ['Bright'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-rue-nine-slip-midi-dress',
    name: 'Slip Midi Dress',
    brand: 'Rue Nine',
    price: 145,
    productUrl: null,
    imageUrl: null,
    category: 'dress',
    style: ['Bohemian', 'Classic'],
    occasion: ['Evening', 'Weekend'],
    fit: ['Slim', 'Regular'],
    colors: ['Pastel'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-terrace-washed-denim-jacket',
    name: 'Washed Denim Jacket',
    brand: 'Terrace',
    price: 118,
    productUrl: null,
    imageUrl: null,
    category: 'jacket',
    style: ['Classic', 'Streetwear'],
    occasion: ['Everyday', 'Weekend'],
    fit: ['Regular', 'Oversized'],
    colors: ['Blue'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-kinfield-poplin-shirt',
    name: 'Poplin Shirt',
    brand: 'Kinfield',
    price: 74,
    productUrl: null,
    imageUrl: null,
    category: 'shirt',
    style: ['Minimal', 'Classic'],
    occasion: ['Work', 'Everyday'],
    fit: ['Slim', 'Regular'],
    colors: ['White'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-solstice-ribbed-knit-skirt',
    name: 'Ribbed Knit Skirt',
    brand: 'Solstice',
    price: 68,
    productUrl: null,
    imageUrl: null,
    category: 'skirt',
    style: ['Minimal', 'Bohemian'],
    occasion: ['Everyday', 'Work'],
    fit: ['Slim', 'Regular'],
    colors: ['Earth'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-atlas-supply-oversized-hoodie',
    name: 'Oversized Hoodie',
    brand: 'Atlas Supply',
    price: 79,
    productUrl: null,
    imageUrl: null,
    category: 'knit',
    style: ['Streetwear', 'Sporty'],
    occasion: ['Weekend', 'Active'],
    fit: ['Oversized', 'Relaxed'],
    colors: ['Green'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-halden-tailored-wool-coat',
    name: 'Tailored Wool Coat',
    brand: 'Halden',
    price: 298,
    productUrl: null,
    imageUrl: null,
    category: 'coat',
    style: ['Classic', 'Minimal'],
    occasion: ['Work', 'Evening'],
    fit: ['Regular', 'Slim'],
    colors: ['Neutral'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-coveworks-cargo-utility-pant',
    name: 'Cargo Utility Pant',
    brand: 'Coveworks',
    price: 92,
    productUrl: null,
    imageUrl: null,
    category: 'trousers',
    style: ['Streetwear', 'Sporty'],
    occasion: ['Everyday', 'Weekend'],
    fit: ['Relaxed', 'Oversized'],
    colors: ['Green'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-rue-nine-silk-column-dress',
    name: 'Silk Column Dress',
    brand: 'Rue Nine',
    price: 245,
    productUrl: null,
    imageUrl: null,
    category: 'dress',
    style: ['Classic', 'Bold'],
    occasion: ['Evening'],
    fit: ['Slim'],
    colors: ['Black'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-northfold-court-sneaker',
    name: 'Court Sneaker',
    brand: 'Northfold',
    price: 110,
    productUrl: null,
    imageUrl: null,
    category: 'sneaker',
    style: ['Minimal', 'Sporty'],
    occasion: ['Everyday', 'Active'],
    fit: ['Regular'],
    colors: ['White'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-terrace-linen-camp-shirt',
    name: 'Linen Camp Shirt',
    brand: 'Terrace',
    price: 64,
    productUrl: null,
    imageUrl: null,
    category: 'shirt',
    style: ['Bohemian', 'Classic'],
    occasion: ['Weekend', 'Everyday'],
    fit: ['Relaxed'],
    colors: ['Blue'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-atlas-supply-performance-short',
    name: 'Performance Short',
    brand: 'Atlas Supply',
    price: 48,
    productUrl: null,
    imageUrl: null,
    category: 'shorts',
    style: ['Sporty'],
    occasion: ['Active', 'Weekend'],
    fit: ['Regular', 'Slim'],
    colors: ['Black'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-solstice-colour-block-knit',
    name: 'Colour Block Knit',
    brand: 'Solstice',
    price: 132,
    productUrl: null,
    imageUrl: null,
    category: 'knit',
    style: ['Bold', 'Streetwear'],
    occasion: ['Weekend', 'Everyday'],
    fit: ['Relaxed', 'Oversized'],
    colors: ['Bright'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-kinfield-pleated-midi-skirt',
    name: 'Pleated Midi Skirt',
    brand: 'Kinfield',
    price: 86,
    productUrl: null,
    imageUrl: null,
    category: 'skirt',
    style: ['Classic', 'Bohemian'],
    occasion: ['Work', 'Evening'],
    fit: ['Regular'],
    colors: ['Pastel'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-terrace-straight-leg-jean',
    name: 'Straight Leg Jean',
    brand: 'Terrace',
    price: 108,
    productUrl: null,
    imageUrl: null,
    category: 'trousers',
    style: ['Classic', 'Streetwear'],
    occasion: ['Everyday', 'Weekend'],
    fit: ['Regular', 'Slim'],
    colors: ['Blue'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-coveworks-cropped-puffer',
    name: 'Cropped Puffer',
    brand: 'Coveworks',
    price: 189,
    productUrl: null,
    imageUrl: null,
    category: 'jacket',
    style: ['Bold', 'Sporty'],
    occasion: ['Weekend', 'Active'],
    fit: ['Regular', 'Oversized'],
    colors: ['Bright'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-rue-nine-tencel-wrap-top',
    name: 'Tencel Wrap Top',
    brand: 'Rue Nine',
    price: 58,
    productUrl: null,
    imageUrl: null,
    category: 'shirt',
    style: ['Bohemian', 'Minimal'],
    occasion: ['Everyday', 'Evening'],
    fit: ['Slim', 'Regular'],
    colors: ['Earth'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-northfold-heavyweight-pocket-tee',
    name: 'Heavyweight Pocket Tee',
    brand: 'Northfold',
    price: 38,
    productUrl: null,
    imageUrl: null,
    category: 'tee',
    style: ['Minimal', 'Streetwear'],
    occasion: ['Everyday', 'Weekend'],
    fit: ['Relaxed', 'Regular'],
    colors: ['Neutral'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-halden-double-breasted-blazer',
    name: 'Double Breasted Blazer',
    brand: 'Halden',
    price: 210,
    productUrl: null,
    imageUrl: null,
    category: 'jacket',
    style: ['Classic', 'Bold'],
    occasion: ['Work', 'Evening'],
    fit: ['Regular', 'Oversized'],
    colors: ['Neutral'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-solstice-printed-maxi-dress',
    name: 'Printed Maxi Dress',
    brand: 'Solstice',
    price: 156,
    productUrl: null,
    imageUrl: null,
    category: 'dress',
    style: ['Bohemian', 'Bold'],
    occasion: ['Weekend', 'Evening'],
    fit: ['Relaxed'],
    colors: ['Green'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  },
  {
    id: 'sample-kinfield-fleece-sweatpant',
    name: 'Fleece Sweatpant',
    brand: 'Kinfield',
    price: 72,
    productUrl: null,
    imageUrl: null,
    category: 'trousers',
    style: ['Sporty', 'Streetwear'],
    occasion: ['Everyday', 'Active'],
    fit: ['Relaxed', 'Oversized'],
    colors: ['Earth'],
    sizes: ['XS', 'S', 'M', 'L', 'XL']
  }
];

/* The homepage demo panel: product ids and the match score shown. */
const HERO_PICKS = [
  { id: 'uniqlo-merino-crew', score: 96 },
  { id: 'zara-oxford-shirt', score: 93 },
  { id: 'levis-xx-chino-taper', score: 91 }
];
