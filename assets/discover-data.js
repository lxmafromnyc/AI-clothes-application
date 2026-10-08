/* =========================================================
   Fynd — what Discover offers

   Data only. assets/app.js draws the Discover page from this object and
   holds no lists of its own.

   Discover is six kinds of clothing — Tops, Bottoms, Outerwear,
   One-Piece, Comfort and Shoes — and it filters the catalogue that is
   already on the page. Nothing in it searches: no part calls
   /api/search, the AI reader or any product source, and none spends a
   search from the shopper's plan.

   ---------------------------------------------------------
   How a product is placed
   ---------------------------------------------------------
   Only by words its own name states. Names are proved against their
   listings (scripts/audit-catalog.js), so a product is a T-shirt here
   because its retailer calls it one. Words match whole, with plurals:
   "shirts" is not "t-shirt" or "sweatshirt", and "=shorts" matches only
   "shorts", never "short sleeve". Nothing else on a row is read.

   A category's own `words` say what belongs to it at all; a
   subcategory's narrow it. A product can be in two categories when its
   name puts it in both (a hoodie is a top, and comfortwear).

   A subcategory is drawn only when the catalogue holds a product it
   matches. One that matches nothing today is left out of the page
   altogether — not shown disabled — and appears by itself the day a
   product it fits is added.
   ========================================================= */

const DISCOVER = {
  categories: [
    {
      id: 'tops',
      label: 'Tops',
      all: 'All tops',
      words: ['t-shirts', 'tee', 'shirts', 'tops', 'blouse', 'polo', 'tank', 'camisole', 'cami', 'hoodie', 'sweatshirt'],
      subcategories: [
        { label: 'T-shirts', words: ['t-shirts', 'tee'] },
        /* button-front by definition: an oxford shirt, a camp shirt */
        { label: 'Button-down shirts', words: ['button down', 'button up', 'button front', 'oxford shirt', 'camp shirt'] },
        { label: 'Tanks & camisoles', words: ['tank', 'tank top', 'camisole', 'cami'] }
      ]
    },
    {
      id: 'bottoms',
      label: 'Bottoms',
      all: 'All bottoms',
      words: ['jeans', 'trousers', 'chinos', 'pants', 'slacks', 'sweatpants', 'joggers', 'leggings', '=shorts', 'skirt'],
      subcategories: [
        { label: 'Jeans', words: ['jeans'] },
        { label: 'Trousers', words: ['trousers', 'chinos', 'pants', 'slacks'] },
        { label: 'Leggings & joggers', words: ['leggings', 'joggers'] }
      ]
    },
    {
      id: 'outerwear',
      label: 'Outerwear',
      all: 'All outerwear',
      words: ['jackets', 'coats', 'blazers', 'trench', 'parka', 'anorak', 'sweaters', 'cardigans'],
      subcategories: [
        { label: 'Blazers', words: ['blazers'] },
        { label: 'Trench coats', words: ['trench'] },
        { label: 'Jackets', words: ['jackets'] },
        { label: 'Sweaters & cardigans', words: ['sweaters', 'cardigans'] }
      ]
    },
    {
      id: 'one-piece',
      label: 'One-Piece',
      all: 'All one-pieces',
      words: ['dresses', 'gown', 'jumpsuit', 'romper', 'playsuit', 'overalls'],
      subcategories: [
        { label: 'Dresses', words: ['dresses', 'gown'] },
        { label: 'Jumpsuits', words: ['jumpsuit'] },
        { label: 'Rompers', words: ['romper', 'playsuit'] },
        { label: 'Overalls', words: ['overalls'] }
      ]
    },
    {
      id: 'comfort',
      label: 'Comfort',
      all: 'All comfort',
      words: ['underwear', 'boxers', 'briefs', 'bra', 'bralette', 'loungewear', 'lounge', 'pajamas', 'pyjamas',
        'sweat set', 'sweatsuit', 'sweatpants', 'joggers', 'hoodie', 'sweatshirt'],
      subcategories: [
        { label: 'Underwear', words: ['underwear', 'boxers', 'briefs'] },
        { label: 'Bras & bralettes', words: ['bra', 'bralette'] },
        { label: 'Loungewear', words: ['loungewear', 'lounge', 'pajamas', 'pyjamas'] },
        { label: 'Sweat sets', words: ['sweat set', 'sweatsuit'] }
      ]
    },
    {
      id: 'shoes',
      label: 'Shoes',
      all: 'All shoes',
      words: ['sneakers', 'trainers', 'loafers', 'flats', 'boots', 'shoes', 'sandals', 'heels', 'mules'],
      subcategories: [
        { label: 'Sneakers', words: ['sneakers', 'trainers'] },
        { label: 'Loafers & flats', words: ['loafers', 'flats'] },
        { label: 'Boots', words: ['boots'] }
      ]
    }
  ]
};
