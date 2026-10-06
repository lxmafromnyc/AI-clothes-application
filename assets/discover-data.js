/* =========================================================
   Fynd — what Discover offers

   Data only. assets/app.js draws the Discover page from this object and
   holds no lists of its own, so a new way to browse is a new entry here
   and nothing else.

   Nothing in this file is a product. Every entry is a starting point —
   a label and the request it stands for — and choosing one runs that
   request through the same search the home page uses
   (find-clothes.html?q=…). What comes back is whatever the product
   source returns and verifies, exactly as if it had been typed.

   The one place real products appear on Discover is `shelves`, and a
   shelf holds no products either: it describes which catalogue rows
   belong on it, and the rows themselves come from the Products store.

   ---------------------------------------------------------
   The shapes
   ---------------------------------------------------------
     dimensions   the "Browse by" index. Each has an id, a tab label and
                  groups of entries. An entry is either a label, or a
                  [label, query] pair when the request should say more
                  than the label does. A plain label is turned into a
                  request by the dimension's `query` template, where
                  {label} is the label in lower case.

     ideas        whole requests, worded the way people actually ask.
                  A handful are shown at a time, from the whole pool.

     edits        a mixed set of ways in — a price, a colour, a fabric,
                  a trip, a mood — each with a request of its own and a
                  few more specific ones underneath.

     shelves      real catalogue rows, grouped by what they genuinely
                  are. `match` is read against the canonical product
                  (see assets/products.js): categories, styles,
                  occasions, fits and colours match any listed value;
                  maxPrice and minPrice need a known price. A shelf is
                  only drawn when enough rows really match it.

   Every request must name something to look for. A price on its own
   ("under $100") gives the product source no phrase to search with,
   so price entries always name a piece as well.
   ========================================================= */

const DISCOVER = {
  dimensions: [
    {
      id: 'category',
      label: 'Category',
      query: '{label}',
      groups: [
        {
          label: 'Clothing',
          entries: ['Hoodies', 'Sweatshirts', 'T-shirts', 'Shirts', 'Polo shirts', 'Sweaters', 'Cardigans',
            'Jackets', 'Coats', 'Blazers', 'Suits', 'Jeans', 'Trousers', 'Shorts', 'Dresses', 'Skirts',
            'Jumpsuits', 'Activewear', 'Swimwear', 'Loungewear']
        },
        {
          label: 'Shoes',
          entries: ['Sneakers', 'Boots', 'Loafers', 'Sandals', 'Heels', 'Flats', 'Running shoes', 'Mules']
        },
        {
          label: 'Bags',
          entries: ['Tote bags', 'Backpacks', 'Crossbody bags', 'Shoulder bags', 'Weekend bags', 'Wallets']
        },
        {
          label: 'Accessories',
          entries: ['Hats', 'Caps', 'Beanies', 'Belts', 'Scarves', 'Sunglasses', 'Gloves', 'Ties', 'Socks']
        },
        {
          label: 'Jewelry and watches',
          entries: ['Necklaces', 'Rings', 'Earrings', 'Bracelets', 'Watches']
        }
      ]
    },
    {
      id: 'style',
      label: 'Style',
      query: '{label} clothing',
      groups: [
        {
          label: 'Everyday',
          entries: [['Minimal', 'minimal essentials'], ['Classic', 'classic wardrobe staples'],
            ['Casual', 'casual everyday clothing'], ['Relaxed', 'relaxed fit clothing'], 'Preppy', 'Coastal',
            ['Scandi', 'scandinavian minimalist clothing']]
        },
        {
          label: 'Street and sport',
          entries: [['Streetwear', 'streetwear'], ['Sporty', 'sporty athleisure'], ['Techwear', 'techwear'],
            'Utility', ['Gorpcore', 'gorpcore outdoor clothing'], 'Skater']
        },
        {
          label: 'With a past',
          entries: ['Vintage', ['Y2K', 'y2k fashion'], 'Workwear', ['Western', 'western wear'], 'Bohemian', 'Grunge']
        },
        {
          label: 'Dressed up',
          entries: [['Formal', 'formal wear'], ['Contemporary', 'contemporary designer clothing'],
            ['Luxury', 'luxury fashion'], ['Quiet luxury', 'quiet luxury essentials'],
            ['Avant-garde', 'avant-garde fashion']]
        }
      ]
    },
    {
      id: 'occasion',
      label: 'Occasion',
      query: '{label} outfit',
      groups: [
        {
          label: 'Day to day',
          entries: ['Everyday', 'Weekend', 'Office', 'Back to school', ['Gym', 'gym clothes'],
            ['Lounging', 'loungewear for home']]
        },
        {
          label: 'Evenings',
          entries: ['Going out', 'Dinner', 'First date', 'Date night', 'Concert']
        },
        {
          label: 'Big days',
          entries: ['Wedding guest', ['Interview', 'interview outfit'], 'Graduation', ['Black tie', 'black tie formal wear'],
            'Party']
        },
        {
          label: 'Away',
          entries: [['Travel', 'travel clothing'], ['Vacation', 'vacation clothes'], 'Festival',
            ['Hiking', 'hiking clothing'], ['Ski trip', 'ski clothing'], ['Beach', 'beach clothes']]
        }
      ]
    },
    {
      id: 'season',
      label: 'Season',
      query: '{label} clothing',
      groups: [
        {
          label: 'Season',
          entries: ['Spring', 'Summer', ['Autumn', 'fall clothing'], 'Winter', ['Transitional', 'transitional layers'],
            ['Holiday', 'holiday party outfit'], ['Resort', 'resort wear']]
        },
        {
          label: 'Weather',
          entries: [['Cold weather', 'cold weather clothing'], ['Rain', 'rain jacket'], ['Heat', 'lightweight summer clothing'],
            ['Snow', 'snow boots'], ['Wind', 'windbreaker'], ['Layering', 'layering pieces'],
            ['Strong sun', 'sun protective clothing'], ['Freezing', 'thermal base layer']]
        }
      ]
    },
    {
      id: 'price',
      label: 'Price',
      query: '{label}',
      groups: [
        {
          label: 'Under $50',
          entries: [['T-shirts', 't-shirts under $50'], ['Jeans', 'jeans under $50'], ['Hats', 'hats under $50'],
            ['Earrings', 'earrings under $50'], ['Swimwear', 'swimwear under $50'], ['Socks', 'socks under $50']]
        },
        {
          label: 'Under $100',
          entries: [['Jackets', 'jackets under $100'], ['Sneakers', 'sneakers under $100'], ['Dresses', 'dresses under $100'],
            ['Sweaters', 'sweaters under $100'], ['Bags', 'bags under $100'], ['Gold jewelry', 'gold jewelry under $100'],
            ['Streetwear', 'streetwear under $100']]
        },
        {
          label: 'Under $200',
          entries: [['Boots', 'boots under $200'], ['Coats', 'coats under $200'], ['Leather jackets', 'leather jacket under $200'],
            ['Watches', 'watches under $200'], ['Suits', 'suits under $200']]
        },
        {
          label: 'Worth saving for',
          entries: [['Designer bags', 'designer bags'], ['Wool coats', 'wool coat over $300'],
            ['Leather boots', 'leather boots over $300'], ['Luxury watches', 'luxury watches'],
            ['Cashmere', 'cashmere sweater over $300']]
        }
      ]
    },
    {
      id: 'colour',
      label: 'Colour',
      query: '{label} clothing',
      groups: [
        {
          label: 'Neutrals',
          entries: ['Black', 'White', 'Cream', 'Grey', 'Navy', 'Beige']
        },
        {
          label: 'Earth',
          entries: ['Brown', 'Camel', 'Olive', 'Rust', 'Khaki']
        },
        {
          label: 'Colour',
          entries: ['Burgundy', 'Red', 'Pink', 'Blue', 'Green', 'Yellow', 'Lilac', 'Orange']
        },
        {
          label: 'Finish',
          entries: [['Metallic', 'metallic'], ['Print', 'printed clothing'], ['Stripes', 'striped clothing'],
            ['Leopard', 'leopard print']]
        }
      ]
    },
    {
      id: 'material',
      label: 'Material',
      query: '{label} clothing',
      groups: [
        {
          label: 'Natural',
          entries: ['Linen', 'Cotton', 'Wool', 'Cashmere', 'Merino', 'Silk', 'Hemp']
        },
        {
          label: 'Textured',
          entries: ['Denim', 'Corduroy', 'Tweed', 'Velvet', 'Knit', 'Fleece', ['Shearling', 'shearling jacket']]
        },
        {
          label: 'Hard-wearing',
          entries: [['Leather', 'leather jacket'], ['Suede', 'suede'], ['Canvas', 'canvas'], ['Nylon', 'nylon jacket'],
            ['Waterproof', 'waterproof jacket'], ['Waxed cotton', 'waxed cotton jacket']]
        },
        {
          label: 'Fine',
          entries: [['Satin', 'satin'], ['Gold', 'gold jewelry'], ['Silver', 'silver jewelry'], ['Pearl', 'pearl jewelry']]
        }
      ]
    },
    {
      id: 'fit',
      label: 'Fit',
      query: '{label}',
      groups: [
        {
          label: 'Silhouette',
          entries: [['Oversized', 'oversized clothing'], ['Relaxed', 'relaxed fit clothing'], ['Slim', 'slim fit clothing'],
            ['Straight leg', 'straight leg jeans'], ['Wide leg', 'wide leg trousers'], ['Cropped', 'cropped jacket'],
            ['Boxy', 'boxy tee'], ['Tailored', 'tailored trousers'], ['Baggy', 'baggy jeans'], ['High rise', 'high rise jeans']]
        },
        {
          label: 'Size and cut',
          entries: [['Unisex', 'unisex clothing'], ['Gender-neutral', 'gender neutral clothing'], ['Petite', 'petite clothing'],
            ['Tall', 'tall sizes clothing'], ['Plus size', 'plus size clothing'], ['Big and tall', 'big and tall clothing']]
        }
      ]
    },
    {
      id: 'trend',
      label: 'Trends',
      query: '{label}',
      groups: [
        {
          label: 'Clothing',
          entries: ['Barrel leg jeans', 'Suede jackets', 'Track jackets', 'Fisherman sweaters', 'Chore coats',
            'Bomber jackets', 'Sheer tops', 'Jorts', 'Polo sweaters']
        },
        {
          label: 'Shoes and accessories',
          entries: ['Ballet flats', 'Boat shoes', 'Western boots', 'Mesh flats', 'Bag charms', 'Oval sunglasses',
            'Chunky gold jewelry']
        },
        {
          label: 'Colour and print',
          entries: [['Burgundy', 'burgundy clothing'], ['Butter yellow', 'butter yellow clothing'],
            ['Chocolate brown', 'chocolate brown clothing'], ['Polka dots', 'polka dot'], ['Leopard print', 'leopard print']]
        }
      ]
    },
    {
      id: 'brand',
      label: 'Brands',
      query: '{label}',
      groups: [
        {
          label: 'Denim and workwear',
          entries: ["Levi's", 'Carhartt', 'Dickies', 'Wrangler']
        },
        {
          label: 'Outdoor',
          entries: ['Patagonia', 'The North Face', "Arc'teryx", 'Barbour']
        },
        {
          label: 'Shoes',
          entries: ['Nike', 'Adidas', 'New Balance', 'Converse', 'Dr. Martens', 'Birkenstock']
        },
        {
          label: 'Essentials',
          entries: ['UNIQLO', 'COS', 'Everlane', 'J.Crew', 'L.L.Bean', 'Gap']
        },
        {
          label: 'Designer',
          entries: ['Acne Studios', 'A.P.C.', 'Ralph Lauren', 'Coach']
        },
        {
          label: 'Eyewear and watches',
          entries: ['Ray-Ban', 'Seiko', 'Casio', 'Timex']
        }
      ]
    }
  ],

  ideas: [
    'cream linen shirt for summer',
    'black leather jacket under $200',
    'wide leg jeans for everyday wear',
    'minimal sneakers under $120',
    'vintage denim jacket',
    'brown suede boots',
    'oversized knit sweater',
    'gold jewelry under $100',
    'designer shoulder bag',
    'wedding guest dress under $150',
    'technical jacket for rain',
    'neutral basics',
    'retro sunglasses',
    'relaxed trousers',
    'preppy cardigan',
    'streetwear under $100',
    'waterproof hiking boots',
    'silver hoop earrings',
    'leather belt with a brass buckle',
    'chunky loafers',
    'canvas tote bag for work',
    'merino base layer for skiing',
    'white tennis skirt',
    'pleated wool trousers',
    'satin slip skirt',
    'cashmere beanie',
    'steel watch under $300',
    'linen shorts for vacation',
    'black one-piece swimsuit',
    'running shoes for long distances',
    'quilted vest',
    'barn jacket with a corduroy collar',
    'graphic tee under $40',
    'crossbody bag for travel',
    'chelsea boots',
    'silk scarf',
    'washed baseball cap',
    'pearl necklace',
    'fleece jacket for camping',
    'high waisted jeans under $80',
    'beige trench coat',
    'knit polo shirt',
    'suede loafers',
    'unisex hoodie',
    'lightweight puffer for travel',
    'sandals for the beach',
    'corduroy jacket',
    'tailored blazer for an interview',
    'gym shorts with pockets',
    'leather weekender bag',
    'chunky gold chain',
    'slim leather wallet',
    'wool scarf',
    'olive cargo pants',
    'western boots',
    'maxi dress for a summer wedding',
    'rain boots',
    'black turtleneck',
    'sports bra for running',
    'denim overshirt',
    'puffer jacket for snow',
    'ballet flats',
    'leather backpack',
    'navy suit for a wedding',
    'striped breton shirt',
    'heeled sandals under $100',
    'fair isle sweater',
    'bucket hat',
    'grey sweatpants',
    'velvet blazer for the holidays'
  ],

  edits: [
    { kicker: 'Price', title: 'Under $100', note: 'Good pieces at honest prices.', query: 'clothes under $100',
      more: ['denim jacket under $100', 'leather belt under $100', 'gold hoops under $100'] },
    { kicker: 'Weather', title: 'For colder weather', note: 'Layers that keep the cold out.', query: 'cold weather clothing',
      more: ['wool overcoat', 'shearling boots', 'cashmere scarf'] },
    { kicker: 'Era', title: 'Vintage finds', note: 'Pieces with some history in them.', query: 'vintage clothing',
      more: ['vintage denim jacket', '90s leather bomber', 'vintage band tee'] },
    { kicker: 'Style', title: 'Minimal essentials', note: 'Plain, well made, worn constantly.', query: 'minimal essentials',
      more: ['white oxford shirt', 'black straight trousers', 'plain crewneck tee'] },
    { kicker: 'Tier', title: 'Designer pieces', note: 'The ones worth saving for.', query: 'designer clothing',
      more: ['designer shoulder bag', 'designer sunglasses', 'designer loafers'] },
    { kicker: 'Style', title: 'Streetwear', note: 'Loose, graphic, built on sneakers.', query: 'streetwear',
      more: ['graphic hoodie', 'cargo pants', 'chunky sneakers'] },
    { kicker: 'Wildcard', title: 'Unexpected finds', note: 'Things you did not know to look for.', query: 'unusual statement accessories',
      more: ['crochet bucket hat', 'embroidered western shirt', 'silk bandana'] },
    { kicker: 'Colour', title: 'Brown', note: 'Chocolate, tobacco, camel and rust.', query: 'brown clothing',
      more: ['brown suede jacket', 'chocolate knit sweater', 'brown leather belt'] },
    { kicker: 'Material', title: 'Linen', note: 'Breathes in the heat, softens with wear.', query: 'linen clothing',
      more: ['linen shirt', 'linen trousers', 'linen dress'] },
    { kicker: 'Fit', title: 'Oversized', note: 'Room to move, on purpose.', query: 'oversized clothing',
      more: ['oversized blazer', 'oversized knit sweater', 'oversized tee'] },
    { kicker: 'Trip', title: 'For travel', note: 'Packs small and does not crease.', query: 'travel clothing',
      more: ['packable rain jacket', 'wrinkle-free trousers', 'weekender bag'] },
    { kicker: 'Daily', title: 'For everyday', note: 'What you reach for without thinking.', query: 'everyday clothing',
      more: ['straight leg jeans', 'grey crewneck sweatshirt', 'white leather sneakers'] },
    { kicker: 'Mood', title: 'Statement pieces', note: 'One piece, the whole outfit.', query: 'statement pieces',
      more: ['sequin top', 'leopard print coat', 'chunky gold necklace'] },
    { kicker: 'Style', title: 'Quiet luxury', note: 'Fine fabric, no logos.', query: 'quiet luxury essentials',
      more: ['cashmere crewneck', 'suede loafers', 'leather tote'] },
    { kicker: 'Season', title: 'Summer', note: 'Light layers and warm-weather shoes.', query: 'summer clothing',
      more: ['linen shorts', 'espadrilles', 'straw hat'] },
    { kicker: 'For anyone', title: 'Gender-neutral', note: 'Cut to suit whoever wears it.', query: 'unisex clothing',
      more: ['unisex hoodie', 'unisex sneakers', 'unisex chore coat'] },
    { kicker: 'Accessories', title: 'Finishing touches', note: 'The small things that finish it.', query: 'accessories',
      more: ['minimal watch', 'gold chain necklace', 'silver signet ring'] },
    { kicker: 'Footwear', title: 'Shoes for every step', note: 'From trail to dance floor.', query: 'shoes',
      more: ['chelsea boots', 'running shoes', 'leather sandals'] },
    { kicker: 'Bags', title: 'Something to carry', note: 'For a laptop, a weekend or just keys.', query: 'bags',
      more: ['canvas tote', 'leather backpack', 'crossbody bag'] },
    { kicker: 'Occasion', title: 'Wedding guest', note: 'Dressed up without upstaging anyone.', query: 'wedding guest outfit',
      more: ['wedding guest dress', 'linen suit', 'heeled sandals'] },
    { kicker: 'Active', title: 'For the gym', note: 'Kit that moves and dries fast.', query: 'gym clothes',
      more: ['training shorts', 'sports bra', 'running shoes'] },
    { kicker: 'Weather', title: 'For the rain', note: 'Stays dry on the way there.', query: 'rain gear',
      more: ['technical rain jacket', 'rain boots', 'waterproof backpack'] },
    { kicker: 'Work', title: 'For the office', note: 'Sharp enough, comfortable all day.', query: 'office outfit',
      more: ['tailored trousers', 'merino polo', 'leather loafers'] },
    { kicker: 'Night', title: 'Going out', note: 'From dinner to the last train.', query: 'going out outfit',
      more: ['black satin shirt', 'slip dress', 'heeled boots'] }
  ],

  shelves: [
    { kicker: 'Price', title: 'Under $100', query: 'clothes under $100', match: { maxPrice: 100 } },
    { kicker: 'Category', title: 'Jackets and coats', query: 'jackets and coats', match: { categories: ['jacket', 'coat'] } },
    { kicker: 'Style', title: 'Minimal essentials', query: 'minimal essentials', match: { styles: ['Minimal'] } },
    { kicker: 'Style', title: 'Streetwear', query: 'streetwear', match: { styles: ['Streetwear'] } },
    { kicker: 'Occasion', title: 'For the evening', query: 'going out outfit', match: { occasions: ['Evening'] } },
    { kicker: 'Fit', title: 'Relaxed and oversized', query: 'oversized relaxed fit clothing', match: { fits: ['Oversized'] } },
    { kicker: 'Colour', title: 'Earth tones', query: 'earth tone clothing', match: { colors: ['Earth', 'Green'] } },
    { kicker: 'Occasion', title: 'Made to move', query: 'activewear', match: { occasions: ['Active'] } },
    { kicker: 'Mood', title: 'Statement pieces', query: 'statement pieces', match: { styles: ['Bold'] } },
    { kicker: 'Occasion', title: 'For the office', query: 'office outfit', match: { occasions: ['Work'] } }
  ]
};
