/* =========================================================
   Fynd — what Discover offers

   Data only. assets/app.js draws the Discover page from this object and
   holds no lists of its own, so a new way to browse is a new entry here
   and nothing else.

   Discover filters the catalogue the site already holds, in the page.
   Nothing in it searches: no entry calls /api/search, the AI reader or
   any product source, and none spends a search from the shopper's plan.

   ---------------------------------------------------------
   Filters, and what they are allowed to read
   ---------------------------------------------------------
   An entry's filter says what a catalogue product must have for the
   entry to match it. It may only read fields that are proved, or that
   are the catalogue's own filing:

     words      phrases the product's own name contains, word for word
                (a plural matches its singular; "=shorts" matches only
                "shorts", so it is not "short sleeve"). Names are proved
                against their listings: see scripts/audit-catalog.js.
     brands     the product's brand — only ever a proved one
     maxPrice   the product's price — only ever a proved one; a product
     minPrice   with no price never matches a price
     styles     Fynd's own catalogue style tags (assets/catalog.js)
     occasions  Fynd's own catalogue occasion tags

   Everything in one filter must hold. Of several entries chosen in one
   direction, any may hold (Hoodies or Sweaters); across directions,
   all must (Sweaters, and under $100).

   The catalogue's colour tags are not read: they were drafted with the
   sample rows and some contradict the products' own photos. A colour
   filter matches only a colour the product's name states.

   An entry with no filter is an idea, not a filter: the catalogue has
   nothing that could truthfully answer it (no season data, no weather
   data, no jewelry). An entry whose filter matches nothing in today's
   catalogue is shown as unavailable. Neither ever pretends to filter.

   ---------------------------------------------------------
   The shapes
   ---------------------------------------------------------
     dimensions   the "Browse by" index: an id, a tab label, a `match`
                  saying how a plain label becomes a filter ('words',
                  'styles', 'occasions', 'brands', or null for none), a
                  `note` saying what it matches on, and groups of
                  entries. An entry is a label, or [label, filter], or
                  [label, filter, chip] when the label needs its group to
                  make sense on its own ("T-shirts" → "T-shirts under
                  $50"). `catalogueBrands` adds a group of the proved
                  brands the catalogue holds.

     ideas        "Try asking": a phrase, or { text, filters } where
                  filters name index entries as "Direction/Entry". Only
                  a phrase every word of which the filters answer has
                  them.

     edits        "Ways in": a kicker, a title, a note, the filters the
                  title applies (if any), and `more` — phrases, or
                  [phrase, filters].

     shelves      the catalogue's own rows, grouped: a kicker, a title
                  and the index entries the shelf is made of.
   ========================================================= */

const DISCOVER = {
  dimensions: [
    {
      id: 'category',
      label: 'Category',
      match: 'words',
      note: 'Matched on the product’s own name.',
      groups: [
        {
          label: 'Clothing',
          entries: ['Hoodies', 'Sweatshirts', ['T-shirts', { words: ['t-shirts', 'tee'] }], 'Shirts', 'Polo shirts', 'Sweaters',
            'Cardigans', 'Jackets', 'Coats', 'Blazers', 'Suits', 'Jeans',
            ['Trousers', { words: ['trousers', 'chinos', 'pants', 'sweatpants'] }], ['Shorts', { words: ['=shorts'] }],
            ['Dresses', { words: ['dresses', 'gown'] }], 'Skirts', 'Jumpsuits', 'Activewear', 'Swimwear', 'Loungewear']
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
      match: 'styles',
      note: 'Matched on Fynd’s own catalogue style tags.',
      groups: [
        {
          label: 'Everyday',
          entries: ['Minimal', 'Classic', ['Casual', null], ['Relaxed', null], ['Preppy', null], ['Coastal', null], ['Scandi', null]]
        },
        {
          label: 'Street and sport',
          entries: ['Streetwear', 'Sporty', ['Techwear', null], ['Utility', null], ['Gorpcore', null], ['Skater', null]]
        },
        {
          label: 'With a past',
          entries: [['Vintage', null], ['Y2K', null], ['Workwear', null], ['Western', null], 'Bohemian', ['Grunge', null]]
        },
        {
          label: 'Dressed up',
          entries: [['Statement', { styles: ['Bold'] }], ['Formal', null], ['Contemporary', null], ['Luxury', null],
            ['Quiet luxury', null], ['Avant-garde', null]]
        }
      ]
    },
    {
      id: 'occasion',
      label: 'Occasion',
      match: 'occasions',
      note: 'Matched on Fynd’s own catalogue occasion tags.',
      groups: [
        {
          label: 'Day to day',
          entries: ['Everyday', 'Weekend', ['Office', { occasions: ['Work'] }], ['Back to school', null],
            ['Gym', { occasions: ['Active'] }], ['Lounging', null]]
        },
        {
          label: 'Evenings',
          entries: [['Going out', { occasions: ['Evening'] }], ['Dinner', null], ['First date', null], ['Date night', null], ['Concert', null]]
        },
        {
          label: 'Big days',
          entries: [['Wedding guest', null], ['Interview', null], ['Graduation', null], ['Black tie', null], ['Party', null]]
        },
        {
          label: 'Away',
          entries: [['Travel', null], ['Vacation', null], ['Festival', null], ['Hiking', null], ['Ski trip', null], ['Beach', null]]
        }
      ]
    },
    {
      id: 'season',
      label: 'Season',
      match: null,
      note: 'The catalogue holds no season or weather data yet, so these are ideas rather than filters.',
      groups: [
        {
          label: 'Season',
          entries: ['Spring', 'Summer', 'Autumn', 'Winter', 'Transitional', 'Holiday', 'Resort']
        },
        {
          label: 'Weather',
          entries: ['Cold weather', 'Rain', 'Heat', 'Snow', 'Wind', 'Layering', 'Strong sun', 'Freezing']
        }
      ]
    },
    {
      id: 'price',
      label: 'Price',
      match: null,
      note: 'Matched on prices read off each listing. A product whose price is not proved is not counted.',
      groups: [
        {
          label: 'Under $50',
          entries: [['Anything under $50', { maxPrice: 50 }],
            ['T-shirts', { words: ['t-shirts', 'tee'], maxPrice: 50 }, 'T-shirts under $50'],
            ['Jeans', { words: ['jeans'], maxPrice: 50 }, 'Jeans under $50'],
            ['Hats', { words: ['hats'], maxPrice: 50 }, 'Hats under $50'],
            ['Earrings', { words: ['earrings'], maxPrice: 50 }, 'Earrings under $50'],
            ['Swimwear', { words: ['swimwear', 'swimsuit'], maxPrice: 50 }, 'Swimwear under $50'],
            ['Socks', { words: ['socks'], maxPrice: 50 }, 'Socks under $50']]
        },
        {
          label: 'Under $100',
          entries: [['Anything under $100', { maxPrice: 100 }],
            ['Jackets', { words: ['jackets'], maxPrice: 100 }, 'Jackets under $100'],
            ['Sneakers', { words: ['sneakers'], maxPrice: 100 }, 'Sneakers under $100'],
            ['Dresses', { words: ['dresses', 'gown'], maxPrice: 100 }, 'Dresses under $100'],
            ['Sweaters', { words: ['sweaters'], maxPrice: 100 }, 'Sweaters under $100'],
            ['Bags', { words: ['bags'], maxPrice: 100 }, 'Bags under $100'],
            ['Streetwear', { styles: ['Streetwear'], maxPrice: 100 }, 'Streetwear under $100']]
        },
        {
          label: 'Under $200',
          entries: [['Anything under $200', { maxPrice: 200 }],
            ['Boots', { words: ['boots'], maxPrice: 200 }, 'Boots under $200'],
            ['Coats', { words: ['coats'], maxPrice: 200 }, 'Coats under $200'],
            ['Leather jackets', { words: ['leather jacket'], maxPrice: 200 }, 'Leather jackets under $200'],
            ['Watches', { words: ['watches'], maxPrice: 200 }, 'Watches under $200'],
            ['Suits', { words: ['suits'], maxPrice: 200 }, 'Suits under $200']]
        },
        {
          label: 'Worth saving for',
          entries: [['Anything $300 and up', { minPrice: 300 }],
            ['Designer bags', null], ['Wool coats', { words: ['wool coat'], minPrice: 300 }, 'Wool coats, $300 and up'],
            ['Leather boots', { words: ['leather boots'], minPrice: 300 }, 'Leather boots, $300 and up'],
            ['Luxury watches', null], ['Cashmere', { words: ['cashmere'], minPrice: 300 }, 'Cashmere, $300 and up']]
        }
      ]
    },
    {
      id: 'colour',
      label: 'Colour',
      match: 'words',
      note: 'Matched on a colour the product’s own name states.',
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
          entries: ['Metallic', ['Print', { words: ['print', 'printed', 'floral'] }], ['Stripes', { words: ['stripe', 'striped'] }],
            ['Leopard', { words: ['leopard'] }]]
        }
      ]
    },
    {
      id: 'material',
      label: 'Material',
      match: 'words',
      note: 'Matched on a material the product’s own name states.',
      groups: [
        {
          label: 'Natural',
          entries: ['Linen', 'Cotton', 'Wool', 'Cashmere', 'Merino', 'Silk', 'Hemp']
        },
        {
          label: 'Textured',
          entries: ['Denim', 'Corduroy', 'Tweed', 'Velvet', 'Knit', ['Fleece', { words: ['fleece', 'ultrafleece'] }], 'Shearling']
        },
        {
          label: 'Hard-wearing',
          entries: ['Leather', 'Suede', 'Canvas', 'Nylon', 'Waterproof', 'Waxed cotton']
        },
        {
          label: 'Fine',
          entries: ['Satin', 'Gold', 'Silver', 'Pearl']
        }
      ]
    },
    {
      id: 'fit',
      label: 'Fit',
      match: 'words',
      note: 'Matched on a fit the product’s own name states.',
      groups: [
        {
          label: 'Silhouette',
          entries: ['Oversized', 'Relaxed', 'Slim', 'Straight leg', 'Wide leg', 'Cropped', 'Boxy', 'Tailored', 'Baggy',
            ['High rise', { words: ['high rise', 'high waisted'] }]]
        },
        {
          label: 'Size and cut',
          entries: ['Unisex', ['Gender-neutral', { words: ['gender neutral'] }], 'Petite', 'Tall', ['Plus size', { words: ['plus size'] }],
            ['Big and tall', { words: ['big and tall'] }]]
        }
      ]
    },
    {
      id: 'trend',
      label: 'Trends',
      match: 'words',
      note: 'Matched on the product’s own name.',
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
          entries: ['Burgundy', 'Butter yellow', 'Chocolate brown', ['Polka dots', { words: ['polka dot'] }], ['Leopard print', { words: ['leopard'] }]]
        }
      ]
    },
    {
      id: 'brand',
      label: 'Brands',
      match: 'brands',
      note: 'Matched on brands proved from each listing. A product whose maker is not proved has no brand to match.',
      catalogueBrands: 'In the catalogue',
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
    /* answered entirely by the catalogue's own fields */
    { text: 'streetwear under $100', filters: ['Price/Streetwear'] },
    { text: 'anything under $50', filters: ['Price/Anything under $50'] },
    { text: 'merino sweaters', filters: ['Material/Merino', 'Category/Sweaters'] },
    { text: 'linen shirts', filters: ['Material/Linen', 'Category/Shirts'] },
    { text: 'cotton tees', filters: ['Material/Cotton', 'Category/T-shirts'] },
    { text: 'cropped jackets', filters: ['Fit/Cropped', 'Category/Jackets'] },
    { text: 'dresses for going out', filters: ['Category/Dresses', 'Occasion/Going out'] },
    { text: 'denim jackets', filters: ['Material/Denim', 'Category/Jackets'] },
    { text: 'wool coats', filters: ['Material/Wool', 'Category/Coats'] },
    { text: 'shirts for the office', filters: ['Category/Shirts', 'Occasion/Office'] },
    { text: 'sweaters under $100', filters: ['Price/Sweaters'] },
    { text: 'minimal everyday pieces', filters: ['Style/Minimal', 'Occasion/Everyday'] },
    { text: 'statement pieces for going out', filters: ['Style/Statement', 'Occasion/Going out'] },
    { text: 'sporty kit for the gym', filters: ['Style/Sporty', 'Occasion/Gym'] },
    /* ideas the catalogue cannot answer yet: shown as words, not filters */
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
    { kicker: 'Price', title: 'Under $100', note: 'Good pieces at honest prices.', filters: ['Price/Anything under $100'],
      more: ['denim jacket under $100', 'leather belt under $100', 'gold hoops under $100'] },
    { kicker: 'Weather', title: 'For colder weather', note: 'Layers that keep the cold out.',
      more: ['wool overcoat', 'shearling boots', 'cashmere scarf'] },
    { kicker: 'Era', title: 'Vintage finds', note: 'Pieces with some history in them.',
      more: ['vintage denim jacket', '90s leather bomber', 'vintage band tee'] },
    { kicker: 'Style', title: 'Minimal essentials', note: 'Plain, well made, worn constantly.', filters: ['Style/Minimal'],
      more: [['cotton tees', ['Material/Cotton', 'Category/T-shirts']], 'white oxford shirt', 'black straight trousers'] },
    { kicker: 'Tier', title: 'Designer pieces', note: 'The ones worth saving for.',
      more: ['designer shoulder bag', 'designer sunglasses', 'designer loafers'] },
    { kicker: 'Style', title: 'Streetwear', note: 'Loose, graphic, built on sneakers.', filters: ['Style/Streetwear'],
      more: [['streetwear under $100', ['Price/Streetwear']], 'graphic hoodie', 'cargo pants'] },
    { kicker: 'Wildcard', title: 'Unexpected finds', note: 'Things you did not know to look for.',
      more: ['crochet bucket hat', 'embroidered western shirt', 'silk bandana'] },
    { kicker: 'Colour', title: 'Brown', note: 'Chocolate, tobacco, camel and rust.', filters: ['Colour/Brown'],
      more: ['brown suede jacket', 'chocolate knit sweater', 'brown leather belt'] },
    { kicker: 'Material', title: 'Linen', note: 'Breathes in the heat, softens with wear.', filters: ['Material/Linen'],
      more: [['linen shirt', ['Material/Linen', 'Category/Shirts']], 'linen trousers', 'linen dress'] },
    { kicker: 'Fit', title: 'Oversized', note: 'Room to move, on purpose.', filters: ['Fit/Oversized'],
      more: ['oversized blazer', 'oversized knit sweater', 'oversized tee'] },
    { kicker: 'Trip', title: 'For travel', note: 'Packs small and does not crease.',
      more: ['packable rain jacket', 'wrinkle-free trousers', 'weekender bag'] },
    { kicker: 'Daily', title: 'For everyday', note: 'What you reach for without thinking.', filters: ['Occasion/Everyday'],
      more: [['straight leg sweatpants', ['Fit/Straight leg', 'Category/Trousers']], 'grey crewneck sweatshirt', 'white leather sneakers'] },
    { kicker: 'Mood', title: 'Statement pieces', note: 'One piece, the whole outfit.', filters: ['Style/Statement'],
      more: ['sequin top', 'leopard print coat', 'chunky gold necklace'] },
    { kicker: 'Style', title: 'Quiet luxury', note: 'Fine fabric, no logos.',
      more: ['cashmere crewneck', 'suede loafers', 'leather tote'] },
    { kicker: 'Season', title: 'Summer', note: 'Light layers and warm-weather shoes.',
      more: ['linen shorts', 'espadrilles', 'straw hat'] },
    { kicker: 'For anyone', title: 'Gender-neutral', note: 'Cut to suit whoever wears it.', filters: ['Fit/Gender-neutral'],
      more: ['unisex hoodie', 'unisex sneakers', 'unisex chore coat'] },
    { kicker: 'Accessories', title: 'Finishing touches', note: 'The small things that finish it.',
      more: ['minimal watch', 'gold chain necklace', 'silver signet ring'] },
    { kicker: 'Footwear', title: 'Shoes for every step', note: 'From trail to dance floor.',
      filters: ['Category/Sneakers', 'Category/Boots', 'Category/Loafers', 'Category/Sandals', 'Category/Heels', 'Category/Flats', 'Category/Running shoes', 'Category/Mules'],
      more: [['leather sneakers', ['Material/Leather', 'Category/Sneakers']], 'chelsea boots', 'running shoes'] },
    { kicker: 'Bags', title: 'Something to carry', note: 'For a laptop, a weekend or just keys.',
      filters: ['Category/Tote bags', 'Category/Backpacks', 'Category/Crossbody bags', 'Category/Shoulder bags', 'Category/Weekend bags'],
      more: ['canvas tote', 'leather backpack', 'crossbody bag'] },
    { kicker: 'Occasion', title: 'Wedding guest', note: 'Dressed up without upstaging anyone.',
      more: ['wedding guest dress', 'linen suit', 'heeled sandals'] },
    { kicker: 'Active', title: 'For the gym', note: 'Kit that moves and dries fast.', filters: ['Occasion/Gym'],
      more: [['shorts', ['Category/Shorts']], 'sports bra', 'running shoes'] },
    { kicker: 'Weather', title: 'For the rain', note: 'Stays dry on the way there.',
      more: ['technical rain jacket', 'rain boots', 'waterproof backpack'] },
    { kicker: 'Work', title: 'For the office', note: 'Sharp enough, comfortable all day.', filters: ['Occasion/Office'],
      more: [['blazers', ['Category/Blazers']], ['chinos', ['Category/Trousers', 'Occasion/Office']], 'leather loafers'] },
    { kicker: 'Night', title: 'Going out', note: 'From dinner to the last train.', filters: ['Occasion/Going out'],
      more: [['dresses', ['Category/Dresses', 'Occasion/Going out']], 'black satin shirt', 'heeled boots'] }
  ],

  shelves: [
    { kicker: 'Price', title: 'Under $100', filters: ['Price/Anything under $100'] },
    { kicker: 'Category', title: 'Jackets and coats', filters: ['Category/Jackets', 'Category/Coats', 'Category/Blazers'] },
    { kicker: 'Style', title: 'Minimal essentials', filters: ['Style/Minimal'] },
    { kicker: 'Style', title: 'Streetwear', filters: ['Style/Streetwear'] },
    { kicker: 'Occasion', title: 'For the evening', filters: ['Occasion/Going out'] },
    { kicker: 'Fit', title: 'Relaxed and oversized', filters: ['Fit/Relaxed', 'Fit/Oversized', 'Fit/Boxy'] },
    { kicker: 'Colour', title: 'Earth tones', filters: ['Colour/Brown', 'Colour/Camel', 'Colour/Olive', 'Colour/Rust', 'Colour/Khaki'] },
    { kicker: 'Occasion', title: 'Made to move', filters: ['Occasion/Gym'] },
    { kicker: 'Mood', title: 'Statement pieces', filters: ['Style/Statement'] },
    { kicker: 'Occasion', title: 'For the office', filters: ['Occasion/Office'] }
  ]
};
