/* =========================================================
   Fynd — the listing pool scripts/bench-concepts.js searches

   A fixed stand-in for the provider's index: listings written the way
   shops title them, with a price, a brand and a shop each. It holds the
   garments descriptive requests are most likely to mean (quarter-zips,
   overshirts, wide-leg trousers, shift dresses, vintage-style bags) AND
   the traps a careless reading falls into: graphic hoodies for
   "cleaner", bombers and puffers for "a shirt that looks like a
   jacket", jeans for "something to wear with jeans", gowns for "not too
   formal", and genuinely vintage designer bags at designer prices.

   It is not a sample of any real index, and nothing in it is shown to a
   shopper. It exists so a change to how requests are read and searched
   can be measured the same way twice.
   ========================================================= */

'use strict';

/* [id, title, price, brand] */
const ROWS = [
  /* hoodies */
  ['h01', 'Essential Fleece Pullover Hoodie Black', 58, 'Everlane'],
  ['h02', 'Oversized Heavyweight Hoodie Black', 72, 'Champion'],
  ['h03', 'Graphic Print Skull Hoodie Black', 45, 'Hot Topic'],
  ['h04', 'Minimal Organic Cotton Hoodie Grey', 64, 'Pact'],
  ['h05', 'Zip Up Hoodie Navy', 50, 'Gap'],
  ['h06', 'Tie Dye Oversized Hoodie', 39, 'Urban Outfitters'],
  ['h07', 'Logo Print Hoodie Red', 55, 'Tommy Hilfiger'],
  ['h08', "Men's Oversized Hoodie Black", 79, 'Carhartt WIP'],
  ['h09', "Women's Cropped Hoodie Cream", 42, 'Aerie'],
  ['h10', 'Plain Hoodie Heather Grey', 35, 'Hanes'],
  ['h11', 'Oversized Hoodie Black Distressed', 88, 'Fear of God Essentials'],
  ['h12', 'Sherpa Lined Hoodie Brown', 70, 'Abercrombie'],
  ['h13', 'Black Oversized Hoodie Heavyweight Fleece', 98, 'Represent'],
  /* sweatshirts */
  ['s01', 'Crewneck Sweatshirt Heather Grey', 48, 'J.Crew'],
  ['s02', 'Black Crewneck Sweatshirt Organic Cotton', 55, 'Everlane'],
  ['s03', 'Graphic College Crewneck Sweatshirt', 40, 'Champion'],
  ['s04', 'Oversized Sweatshirt Cream', 52, 'Aritzia'],
  ['s05', 'Vintage Wash Sweatshirt Faded Black', 60, 'Madewell'],
  ['s06', 'Cartoon Print Sweatshirt Pink', 30, 'Shein'],
  /* quarter zips */
  ['q01', 'Quarter Zip Pullover Navy', 68, 'J.Crew'],
  ['q02', 'Merino Quarter Zip Sweater Charcoal', 95, 'Banana Republic'],
  ['q03', 'Half Zip Fleece Pullover Black', 59, 'Patagonia'],
  ['q04', 'Quarter-Zip Cotton Sweatshirt Grey', 54, 'Uniqlo'],
  ['q05', 'Waffle Knit Quarter Zip Cream', 62, 'Abercrombie'],
  /* knit pullovers and sweaters */
  ['k01', 'Knit Pullover Sweater Oatmeal', 78, 'Everlane'],
  ['k02', 'Fine Knit Crewneck Sweater Navy', 89, 'COS'],
  ['k03', 'Chunky Cable Knit Sweater Cream', 98, 'Madewell'],
  ['k04', 'Crewneck Sweater Black Cotton', 60, 'Uniqlo'],
  ['k05', 'Fair Isle Christmas Sweater', 45, 'Old Navy'],
  ['k06', 'Mock Neck Knit Pullover Black', 74, 'Banana Republic'],
  ['k07', 'Chunky Knit Oversized Sweater Brown', 85, 'Free People'],
  ['k08', 'Soft Brushed Knit Sweater Grey', 66, 'Aritzia'],
  /* cardigans */
  ['c01', 'Chunky Knit Cardigan Cream', 88, 'Madewell'],
  ['c02', 'Cotton Cardigan Navy', 59, 'J.Crew'],
  ['c03', 'Cropped Cardigan Black', 48, 'Reformation'],
  ['c04', 'Cashmere Cardigan Camel', 180, 'Naadam'],
  /* overshirts, shirt jackets, chore jackets */
  ['o01', 'Wool Blend Overshirt Charcoal', 98, 'COS'],
  ['o02', 'Cotton Twill Overshirt Olive', 79, 'Uniqlo'],
  ['o03', 'Corduroy Shirt Jacket Brown', 88, 'J.Crew'],
  ['o04', 'Plaid Shacket Grey', 65, 'Abercrombie'],
  ['o05', 'Canvas Chore Jacket Navy', 128, 'Carhartt WIP'],
  ['o06', 'Cotton Chore Coat Ecru', 110, 'Madewell'],
  ['o07', 'Flannel Overshirt Black', 70, 'Everlane'],
  ['o08', 'Heavy Twill Shirt Jacket Black', 95, 'Banana Republic'],
  /* cropped and other jackets */
  ['j01', 'Cropped Denim Jacket Light Wash', 78, "Levi's"],
  ['j02', 'Cropped Trucker Jacket Black', 89, "Levi's"],
  ['j03', 'Boxy Cropped Jacket Cream', 98, 'Aritzia'],
  ['j04', 'Cropped Utility Jacket Khaki', 85, 'Madewell'],
  ['j05', 'Nylon Bomber Jacket Black', 120, 'Alpha Industries'],
  ['j06', 'Satin Bomber Jacket Olive', 95, 'Urban Outfitters'],
  ['j07', 'Packable Puffer Jacket Black', 130, 'Uniqlo'],
  ['j08', 'Down Puffer Jacket Navy', 220, 'The North Face'],
  ['j09', 'Faux Leather Moto Jacket Black', 110, 'Blank NYC'],
  ['j10', 'Leather Biker Jacket Brown', 450, 'AllSaints'],
  ['j11', 'Hooded Parka Olive', 260, 'Canada Goose'],
  ['j12', 'Windbreaker Jacket Blue', 70, 'Nike'],
  ['j13', 'Classic Denim Jacket Medium Wash', 98, "Levi's"],
  ['j14', 'Polar Fleece Jacket Cream', 89, 'Patagonia'],
  ['j15', 'Sherpa Jacket Brown', 110, "Levi's"],
  ['j16', 'Varsity Jacket Green', 140, 'Abercrombie'],
  ['j17', 'Quilted Jacket Black', 120, 'Barbour'],
  ['j18', 'Rain Jacket Yellow', 95, 'Patagonia'],
  ['j19', 'Lightweight Jacket Stone', 88, 'Everlane'],
  /* blazers */
  ['b01', 'Tailored Wool Blazer Navy', 198, 'Banana Republic'],
  ['b02', 'Oversized Blazer Black', 148, 'Aritzia'],
  ['b03', 'Unstructured Knit Blazer Grey', 168, 'J.Crew'],
  ['b04', 'Linen Blazer Beige', 130, 'Mango'],
  /* shirts and tops */
  ['t01', 'Oxford Shirt White', 55, 'J.Crew'],
  ['t02', 'Button Down Shirt Light Blue', 49, 'Uniqlo'],
  ['t03', 'Flannel Shirt Red Plaid', 45, 'L.L.Bean'],
  ['t04', 'Graphic Tee Band Print', 28, 'Urban Outfitters'],
  ['t05', 'Essential Crew Tee White', 25, 'Everlane'],
  ['t06', 'Heavyweight Tee Black', 38, 'Carhartt WIP'],
  ['t07', 'Knit Polo Navy', 78, 'Todd Snyder'],
  ['t08', 'Silk Blouse Ivory', 120, 'Reformation'],
  ['t09', 'Ribbed Knit Top Black', 35, 'Aritzia'],
  ['t10', 'Fitted Tee Black', 22, 'Uniqlo'],
  ['t11', 'Tank Top White Ribbed', 18, 'Gap'],
  ['t12', 'Linen Button Down Shirt White', 60, 'Everlane'],
  ['t13', 'Satin Camisole Black', 45, 'Reformation'],
  ['t14', 'White T-Shirt Organic Cotton', 24, 'Pact'],
  ['t15', 'Mock Neck Tee Black', 32, 'COS'],
  /* trousers and bottoms */
  ['p01', 'Wide Leg Trousers Black', 79, 'Aritzia'],
  ['p02', 'Pleated Wide Leg Pants Black', 88, 'COS'],
  ['p03', 'Relaxed Fit Trousers Charcoal', 70, 'Uniqlo'],
  ['p04', 'Tailored Trousers Navy', 98, 'Banana Republic'],
  ['p05', 'Pleated Trousers Black Wool Blend', 120, 'J.Crew'],
  ['p06', 'Skinny Pants Black Stretch', 40, 'Old Navy'],
  ['p07', 'Black Joggers Fleece', 45, 'Nike'],
  ['p08', 'Cargo Pants Black', 60, 'Carhartt WIP'],
  ['p09', 'Slim Fit Chinos Khaki', 50, 'Dockers'],
  ['p10', 'Black Leggings High Waisted', 35, 'Lululemon'],
  ['p11', 'Black Straight Leg Jeans', 70, "Levi's"],
  ['p12', 'Skinny Jeans Black', 60, 'Topshop'],
  ['p13', 'Wide Leg Jeans Light Wash', 88, 'Madewell'],
  ['p14', 'Fleece Lined Jeans Blue', 55, 'Wrangler'],
  ['p15', 'Palazzo Pants Black Crepe', 65, 'Mango'],
  ['p16', 'Baggy Sweatpants Grey', 48, 'Champion'],
  ['p17', 'Relaxed Trousers Beige Linen', 75, 'Everlane'],
  ['p18', 'Black Trousers Slim Fit', 58, 'Zara'],
  ['p19', 'Lounge Pants Knit Grey', 52, 'Aerie'],
  ['p20', 'Tailored Joggers Black', 68, 'Lululemon'],
  /* dresses */
  ['d01', 'Shift Dress Black Crepe', 89, 'COS'],
  ['d02', 'Cotton T-Shirt Dress Grey', 45, 'Everlane'],
  ['d03', 'Shirt Dress Blue Stripe', 78, 'J.Crew'],
  ['d04', 'Knit Sweater Dress Oatmeal', 98, 'Madewell'],
  ['d05', 'Satin Slip Dress Champagne', 110, 'Reformation'],
  ['d06', 'Sequin Gown Silver', 320, 'Adrianna Papell'],
  ['d07', 'Cocktail Dress Black Beaded', 240, 'Badgley Mischka'],
  ['d08', 'Cream Linen Midi Dress', 128, 'Reformation'],
  ['d09', 'Linen Midi Dress Ivory', 98, 'Faithfull the Brand'],
  ['d10', 'Formal Evening Maxi Dress Navy', 180, 'Lulus'],
  ['d11', 'Bodycon Dress Red', 40, 'Fashion Nova'],
  ['d12', 'Wrap Dress Floral', 88, 'DVF'],
  ['d13', 'Simple Cotton Midi Dress Black', 65, 'Uniqlo'],
  ['d14', 'White Linen Mini Dress', 79, 'Abercrombie'],
  ['d15', 'Cream Midi Dress Linen Blend Summer', 70, 'Mango'],
  ['d16', 'Casual Jersey Dress Navy', 50, 'Gap'],
  /* bags */
  ['g01', 'Vintage Prada Nylon Shoulder Bag', 480, 'Prada'],
  ['g02', 'Prada Re-Edition Nylon Bag', 1350, 'Prada'],
  ['g03', 'Vintage Prada Leather Tote Bag Black', 420, 'Prada'],
  ['g04', 'Prada Saffiano Leather Bag', 2100, 'Prada'],
  ['g05', 'Vintage Style Shoulder Bag Brown', 48, 'Mango'],
  ['g06', 'Retro Top Handle Bag Burgundy', 55, 'Zara'],
  ['g07', 'Leather Shoulder Bag Tan', 195, 'Madewell'],
  ['g08', 'Vintage Inspired Saddle Bag Brown', 62, 'Urban Outfitters'],
  ['g09', 'Canvas Tote Bag Natural', 30, 'L.L.Bean'],
  ['g10', 'Nylon Crossbody Bag Black', 45, 'Baggu'],
  ['g11', 'Vintage Gucci Jackie Bag', 1600, 'Gucci'],
  ['g12', 'Top Handle Bag Black Structured', 89, 'Charles & Keith'],
  ['g13', 'Backpack Black', 60, 'Herschel'],
  ['g14', 'Vintage Prada Mini Bag', 390, 'Prada'],
  /* footwear and the rest */
  ['f01', 'Leather Low Top Sneakers White', 98, 'Common Projects'],
  ['f02', 'Chunky Running Sneakers', 120, 'New Balance'],
  ['f03', 'Chelsea Boots Black Leather', 180, 'Blundstone'],
  ['f04', 'Strappy Heels Black', 90, 'Steve Madden'],
  ['f05', 'Comfortable Running Shoes Grey', 130, 'Brooks']
];

const STORES = ['nordstrom.com', 'macys.com', 'asos.com', 'target.com', 'ssense.com', 'revolve.com', 'shopbop.com', 'zappos.com'];

const POOL = ROWS.map(([id, title, price, brand], at) => ({ id, title, price, brand, store: STORES[at % STORES.length] }));

module.exports = { POOL };
