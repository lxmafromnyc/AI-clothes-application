/* =========================================================
   Fynd — demo product source

   Source records in the shape a real feed supplies. Nothing here is
   consumed directly: assets/products.js normalises these before anything
   renders, so this file can be replaced by a feed export, an API response
   or a database dump without touching the interface.

     Products.load(DEMO_PRODUCTS)          this file
     Products.load('/api/products.json')   a URL returning JSON
     Products.load(() => queryDb())        a function or promise

   ---------------------------------------------------------
   How a row gets its photo and its price
   ---------------------------------------------------------
   One way only: scripts/hydrate-catalog.js reads them off the listing
   the row links to, from a connection that can reach the retailer, and
   ties both to that exact product before either is written. The photo
   and the price come out of the SAME load of that page, which is what
   makes them the same product's.

   A row takes both or neither. A card showing a real photo beside a
   price read from somewhere else would be a worse lie than an empty
   tile, because it looks finished.

   imageUrl carries a photo on the rows where one was verified, and null
   everywhere else. A product whose imageUrl is null, or whose photo
   fails to load, keeps the drawn artwork, and that is the honest state
   rather than a placeholder.

   price is null on every row that links to a listing, because no
   retailer domain was reachable from the environment this was built in,
   so no price could be read off one. It is an ordinary field: run the
   hydrator from an ordinary connection and it fills in.

   ---------------------------------------------------------
   Provenance
   ---------------------------------------------------------
   imageEvidence records HOW a photo was tied to its product, and only
   where the URL cannot say so itself. UNIQLO and J.Crew carry their
   listing's code in the image URL, so the URL is its own evidence and no
   note is written. L.L.Bean requests 521659_32573_41 for product 129244
   — an asset name that says nothing about the product — and the tie was
   made by the JSON-LD product record on that listing naming sku 129244,
   so the row says so. The code also appears in that URL's defaultImage
   parameter, but that names Scene7's stand-in image rather than the one
   requested, and it is NOT what vouches for the photo.

   priceEvidence is the same idea, and it is never optional. A price is a
   bare number: 89 is 89 whatever product it belongs to, which day it was
   true and whichever currency it was quoted in. So a priced row records
   how the figure was obtained, the sku or canonical page that ties it to
   this listing, the currency it was quoted in, the amount that was read,
   and the day it was read.

   Both notes are re-proved, not trusted. A recorded sku has to match a
   code in the row's own productUrl, a recorded canonical has to be that
   same listing, and a recorded amount has to equal the price the row
   actually carries — so a price typed in by hand fails for having no
   note, and a price edited afterwards fails because the note still names
   the number that came off the page. A made-up note fails exactly as a
   made-up URL does.

   Both are bookkeeping only — assets/products.js builds an explicit
   record, so neither field ever reaches the interface.

   ---------------------------------------------------------
   The sample rows
   ---------------------------------------------------------
   The rows carrying a productUrl are real listings. The rest are sample
   rows that exist to give the demo a catalogue to search, and their
   prices are demo data: a figure for a garment nobody sells. They carry
   no priceEvidence and never may, because there is no page they came
   off — that absence is what keeps "sample" and "verified" from blurring
   together, and the interface badges them Sample on the card itself.

   scripts/hydrate-catalog.js --discover replaces a sample row with a
   real product, but only when the listing, the name, the brand, the
   photo and the price all verify together.

   colors is empty on a row whose colour nothing established, the same
   way sizes is empty on every real listing: an unknown is left unsaid
   rather than guessed from whatever the row used to hold.
   ========================================================= */

const DEMO_PRODUCTS = [
  {
    id: 'uniqlo-merino-crew',
    name: "Men's Extra Fine Merino Crew Neck Long-Sleeve Sweater",
    brand: 'UNIQLO',
    price: null,
    productUrl: 'https://www.uniqlo.com/us/en/products/E429066-000/00',
    imageUrl: 'https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/429066/item/goods_03_429066_3x4.jpg',
    category: 'knit',
    style: ['Minimal', 'Classic'],
    occasion: ['Work', 'Everyday'],
    fit: ['Regular', 'Slim'],
    colors: ['Neutral'],
    sizes: []
  },
  {
    id: 'jcrew-broken-in-oxford',
    name: 'Broken-in organic cotton oxford shirt',
    brand: 'J.Crew',
    price: null,
    productUrl: 'https://www.jcrew.com/p/mens/categories/clothing/shirts/broken-in-oxford/broken-in-organic-cotton-oxford-shirt/AU763',
    imageUrl: 'https://www.jcrew.com/s7-img-facade/AU763_WT0002',
    category: 'shirt',
    style: ['Classic', 'Minimal'],
    occasion: ['Work', 'Everyday'],
    fit: ['Regular'],
    colors: ['White'],
    sizes: []
  },
  {
    id: 'llbean-venturestretch-chino',
    name: "Men's VentureStretch Commuter Chinos",
    brand: 'L.L.Bean',
    price: null,
    productUrl: 'https://www.llbean.com/llb/shop/129244',
    imageUrl: 'https://cdni.llbean.net/is/image/wim/521659_32573_41?hei=1095&wid=950&resMode=sharp2&defaultImage=llbprod/129244_0_44',
    imageEvidence: { via: 'json-ld-sku', sku: '129244' },
    category: 'trousers',
    style: ['Minimal', 'Classic'],
    occasion: ['Work', 'Everyday'],
    fit: ['Slim', 'Regular'],
    colors: [],
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
  { id: 'jcrew-broken-in-oxford', score: 93 },
  { id: 'llbean-venturestretch-chino', score: 91 }
];
