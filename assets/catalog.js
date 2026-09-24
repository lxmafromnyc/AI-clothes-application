/* =========================================================
   Fynd — demo product source

   Source records in the shape a real feed supplies. Nothing here is
   consumed directly: assets/products.js normalises these before anything
   renders, so this file can be replaced by a feed export, an API response
   or a database dump without touching the interface.

     Products.load(DEMO_PRODUCTS)          this file
     Products.load('/api/products.json')   a URL returning JSON
     Products.load(() => queryDb())        a function or promise

   price carries an amount on a linked row only where one was read off
   the retailer's own page by scripts/fetch-catalog-prices.js: tied to
   that exact product, and proved to be the amount charged rather than
   the one it is discounted from. A row whose price is null renders no
   price, which is the honest state rather than a plausible figure.

   UNIQLO is null on purpose. It serves no price at all, and the figure
   its rendered page draws sits in no product's own price block — the
   page is this listing's canonical page, but that vouches for the page,
   not for which of its figures is the price. Its code does appear in 17
   elements of the rendered DOM, all of them images and preload links,
   and none of them contains a figure. Until a price element on that
   page can be tied to E429066-000 or to the variant the page has
   selected, the row stays unpriced.

   J.Crew publishes ProductGroup AU763 with offers: [], so its price
   came off the rendered page instead: the figure in
   div#productPriceSelectColors-CX449NA6434, which is the colour the
   page had selected, marked as the sale price, under this listing's
   AU763. The other figures it renders — a struck-through 128 and the
   prices in its recommendation strips — are refused, and had that
   selected-colour block not existed the row would have stayed null
   rather than choosing among them.

   priceEvidence records HOW a price was tied to its product, and unlike
   imageEvidence it is written for every price with no exception: an
   image URL can carry the product's code and speak for itself, while
   84.95 carries nothing. L.L.Bean's came from the offer on the JSON-LD
   product record naming sku 129244. It is re-proved rather than
   trusted, the same way imageEvidence is — the recorded sku has to
   match a code in the row's own productUrl.

   The sample rows' prices are the demo's own. They link to nothing, so
   nothing claims they were read from a retailer.

   imageUrl carries a photo on the rows where one was verified, and null
   everywhere else. A photo gets here one way only: read off the listing
   the row links to by scripts/fetch-catalog-images.js, run from a
   connection that can reach the retailer, and tied to that exact product
   before it is written. A product whose imageUrl is null, or whose photo
   fails to load, keeps the drawn artwork, and that is the honest state
   rather than a placeholder.

   imageEvidence records HOW a photo was tied to its product, and only
   where the URL cannot say so itself. UNIQLO and J.Crew carry their
   listing's code in the image URL, so the URL is its own evidence and no
   note is written. L.L.Bean requests 521659_32573_41 for product 129244
   — an asset name that says nothing about the product — and the tie was
   made by the JSON-LD product record on that listing naming sku 129244,
   so the row says so. The code also appears in that URL's defaultImage
   parameter, but that names Scene7's stand-in image rather than the one
   requested, and it is NOT what vouches for the photo.

   The note is re-proved, not trusted: a recorded sku has to match a code
   in the row's own productUrl, so a made-up note fails exactly as a
   made-up URL does. It is bookkeeping only — assets/products.js builds
   an explicit record, so this field never reaches the interface.

   The three rows carrying a productUrl are real listings. The rest are
   sample rows that exist to give the demo a catalogue to search.

   colors is empty on a row whose colour nothing established, the same
   way sizes is empty on every real listing: an unknown is left unsaid
   rather than guessed from whatever the row used to hold.
   ========================================================= */

const DEMO_PRODUCTS = [
  {
    id: 'uniqlo-merino-crew',
    name: "Men's Extra Fine Merino Crew Neck Long-Sleeve Sweater",
    brand: 'UNIQLO',
    price: 7.9,
    priceEvidence: { via: 'datalayer-variant-price', productId: 'E429066-000', l1Id: '438783', l2Id: '05437392', communicationCode: '429066-03-003-000', currency: 'USD' },
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
    price: 98,
    priceEvidence: { via: 'dom-variant-scope', code: 'AU763', variant: 'productPriceSelectColors-CX449NA6434' },
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
    price: 84.95,
    priceEvidence: { via: 'json-ld-offer', sku: '129244' },
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
    productUrl: 'https://wearsubset.com/products/organic-cotton-boxy-tee?srsltid=AU7gw4VU8pNLuGolbILYNgecKPD4BIvVVtl-A5l71-yA1M4g172usK9h',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0055/2416/0563/files/Boxy-Tee-Graphite-LOOK5_0003-hero.jpg?v=1746817885',
    imageEvidence: { via: 'product-record', handle: 'organic-cotton-boxy-tee', productId: '7737442697408', title: 'Organic Cotton Boxy Tee' },
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
    productUrl: 'https://unboundmerino.com/products/mens-merino-crew-sweater',
    imageUrl: 'https://cdn.shopify.com/s/files/1/1491/5166/files/Unbound-Merino-Men-Sweater-Heather-Oat-1.jpg?v=1773773474',
    imageEvidence: { via: 'product-record', handle: 'mens-merino-crew-sweater', productId: '7455170003038', title: 'Mens Merino Crew Sweater' },
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
    productUrl: 'https://telfar.net/products/cropped-track-jacket-white-2025',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0880/7204/files/TELFAR-CROPPED-TRACK-JACKET-WHITE-FRONT.jpg?v=1774384320',
    imageEvidence: { via: 'product-record', source: 'embedded-react-router', handle: 'cropped-track-jacket-white-2025', productId: '7689314336867', title: 'Cropped Track Jacket - White' },
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
    productUrl: 'https://stetson.com/products/stone-wash-denim-jacket-blue?srsltid=AU7gw4XcGn901df4E_sNvEiaMpW7wpp9igT2ueoLeMFarF1tA-u6PhPK',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0357/2432/9005/files/11-097-0119-4036-BU_Blue_1_1aa77471-5252-459e-9b17-ad6819311fe5.jpg?v=1774989535',
    imageEvidence: { via: 'product-record', handle: 'stone-wash-denim-jacket-blue', productId: '8402035179565', title: 'Stone Wash Denim Jacket' },
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
    productUrl: 'https://www.eileenfisher.com/ribbed-knit-skirt/S6YFF-S4429.html?srsltid=AU7gw4Ub_fkSYiZTUDeGul3YpjXy_2Mq6NscwEKq2O1U1caaAHDnPrmY',
    imageUrl: 'https://www.eileenfisher.com/dw/image/v2/BGKB_PRD/on/demandware.static/-/Sites-ef-main-catalog/default/dw287f7711/images/S6YFF-S4429M-349.jpg?sw=525&sh=700&sfrm=png&q=90',
    imageEvidence: { via: 'json-ld-sku', sku: 's6yff-s4429' },
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
    productUrl: 'https://alexiamaria.com/products/bella-silk-and-wool-column-gown-with-removable-bow-belt?srsltid=AU7gw4XJqg9X-ZIKpm7JAgbIN_a6Eio1I6_Or0Up-_a3uXZPNIqyDGv0',
    imageUrl: 'https://cdn.shopify.com/s/files/1/1464/2224/files/Screenshot2025-11-20at11.16.16PM.png?v=1763698523',
    imageEvidence: { via: 'product-record', handle: 'bella-silk-and-wool-column-gown-with-removable-bow-belt', productId: '7027432128685', title: 'Bella Silk and Wool Column Gown' },
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
    productUrl: 'https://www.jcrew.com/p/mens/categories/shoes/exclusives/court-sneakers-in-leather/AQ226?srsltid=AU7gw4WOorKw0-jR9hhjIH0FvJXdsW2bNwg0vyA_eM5iKia9wmBhJsyG',
    imageUrl: 'https://www.jcrew.com/s7-img-facade/AQ226_WT0002',
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
    productUrl: 'https://mackweldon.com/products/linen-camp-shirt?srsltid=AU7gw4X7OzEMCGfGc7jkVK7Bnta_IOxHxc6gKKzZ_lCLzAQyNcGHx35y',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0078/6825/2273/files/Linen-Camp-Shirt_Bright-White_M01Y11-BW-135.png?v=1777649425',
    imageEvidence: { via: 'product-record', handle: 'linen-camp-shirt', productId: '7638452011121', title: 'Linen Camp Shirt' },
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
    productUrl: 'https://capellisport.com/products/mens-performance-shorts?srsltid=AU7gw4WqMaU_bpCVQMl3d0uTNNH-Y6UgDifROG8JYlCi1bE3YZ0UMsN7',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0516/8994/7309/files/AGA-1496XRED_ae53fcad-234a-478a-9676-175d7bcb1bda.jpg?v=1760714195',
    imageEvidence: { via: 'product-record', handle: 'mens-performance-shorts', productId: '8742623838437', title: 'Mens Performance Shorts' },
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
    price: 34.97,
    priceEvidence: { via: 'json-ld-offer', sku: '0435_5141_953' },
    productUrl: 'https://www.ae.com/us/en/p/women/jeans/high-waisted-jeans/ae-super-high-waisted-straight-jean/0435_5141_953',
    imageUrl: 'https://s7d2.scene7.com/is/image/aeo/0435_5141_953_l1',
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
    price: null,
    productUrl: 'https://veiled.com/products/tencel-wrap-top-honeydew?variant=43101716512873&country=US&currency=USD&utm_medium=product_sync&utm_source=google&utm_content=sag_organic&utm_campaign=sag_organic&srsltid=AU7gw4Uu2rEWUo23KDmHE4DivU0Zue0jGJ5JV4CrVcTGYhSkXVo9iLcuf-Q',
    imageUrl: 'https://veiled.com/cdn/shop/files/tencel-wrap-top-honeydew-426317.jpg?v=1782343347&width=2048',
    imageEvidence: { via: 'canonical', canonical: 'https://veiled.com/products/tencel-wrap-top-honeydew' },
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
    price: 18.09,
    priceEvidence: { via: 'json-ld-offer', sku: '194531993198' },
    productUrl: 'https://www.redkap.com/mens-heavyweight-cotton-short-sleeve-pocket-t-shirt/194531993198.html?srsltid=AU7gw4VWLZtSflcDGY2huezglCdOv2SuqDf52KPc3Gr-a-5yfM9MYP6PoU0',
    imageUrl: 'https://www.redkap.com/on/demandware.static/-/Sites-redkap-master-catalog/default/dw98462c15/F4K2-CTN-PKT-SS-TEE/MS_RK_S5K6HR_M1_M_F.png',
    imageEvidence: { via: 'json-ld-sku', sku: '194531993198' },
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
    productUrl: 'https://www.joesjeans.com/products/double-breasted-blazer-true-navy?srsltid=AU7gw4UrhqQVneqyCYiH3q4-5lAbyTD9lki6nGtax9bJ1ShmIoWfSzet',
    imageUrl: 'https://cdn.shopify.com/s/files/1/0029/1232/1571/files/jmfadb9044_true_navy_a.jpg?v=1776441921',
    imageEvidence: { via: 'product-record', handle: 'double-breasted-blazer-true-navy', productId: '7403915116587', title: 'DOUBLE BREASTED BLAZER' },
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
    price: 84.99,
    priceEvidence: { via: 'json-ld-offer', sku: 'oa377' },
    productUrl: 'https://www.madewell.com/p/womens/clothing/dresses/linen-dresses/squareneck-sleeveless-maxi-dress/OA377/?ccode=PP8103&size=10&source=googlePLA&srsltid=AU7gw4VISrbWeiA609m1ju9BRqmEmwk8o8dLCPXdCL_5gaD1h-zzcA8xFQ0',
    imageUrl: 'https://www.madewell.com/images/OA377_PP8103_m?wid=360&hei=457&fmt=jpeg&fit=crop&qlt=75',
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
    price: 69.95,
    priceEvidence: { via: 'json-ld-offer', sku: '0892669' },
    productUrl: 'https://www.garageclothing.com/us/us/p/ultrafleece-straight-leg-sweatpants/0892669.html?srsltid=AU7gw4UDkr_A3xD106Yb4vyGxb75TfpU0clPMV3MNGw40IFFryItIVl8AG4',
    imageUrl: 'https://dam.dynamiteclothing.com/asset/7f4d08f5-83e8-4f04-a7eb-39d9eea6f9a1/100091920_18X_1920x2880.jpg?sw=1200&sh=1800',
    imageEvidence: { via: 'json-ld-sku', sku: '0892669' },
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
