/* =========================================================
   Fynd — request interpretation (client side)

   Sends what the shopper typed to the interpreter endpoint, which calls
   OpenAI server-side so the API key never reaches the browser. This is the
   real path and the one production should use.

   When that endpoint cannot answer, the request is read by a small local
   parser instead so the page still returns something. That result is
   always reported as `source: "local"` with the reason attached, and the
   interface says so plainly. A keyword match is never passed off as an AI
   reading.

   Endpoint location: same-origin /api/interpret by default. When the
   static site and the function live on different hosts — GitHub Pages
   cannot run a function — point at it with either:

     <meta name="findwear-api" content="https://your-app.vercel.app/api/interpret">
     window.FINDWEAR_API = 'https://your-app.vercel.app/api/interpret';
   ========================================================= */

(function (global) {
  'use strict';

  const DEFAULT_ENDPOINT = '/api/interpret';
  const REQUEST_TIMEOUT = 12000;

  function endpoint() {
    if (global.FINDWEAR_API) return String(global.FINDWEAR_API);
    const tag = global.document && global.document.querySelector('meta[name="findwear-api"]');
    const href = tag && tag.getAttribute('content');
    return href ? href.trim() : DEFAULT_ENDPOINT;
  }

  const EMPTY = () => ({
    categories: [], colors: [], occasions: [], fits: [], brands: [], styles: [],
    garments: [], descriptors: [],
    maxPrice: null, minPrice: null, season: null, gender: null, keywords: [],
    /* what a descriptive request most likely means: see readConcepts */
    concepts: null
  });

  /* The garment itself, in the words shoppers use for it, each with the
     catalogue category it is filed under. A hoodie is filed under "knit"
     in the catalogue, but the shopper asked for a hoodie, and that is
     what is kept — the filing is only how the catalogue matches it. */
  const GARMENTS = [
    ['hoodie', ['hooded sweatshirt', 'hoodie', 'hoodies', 'hoody'], ['knit']],
    ['sweatshirt', ['sweatshirt', 'sweatshirts'], ['knit']],
    ['cardigan', ['cardigan', 'cardigans'], ['knit']],
    ['sweater', ['knit sweater', 'sweater', 'sweaters', 'jumper', 'jumpers', 'pullover', 'pullovers', 'knitwear'], ['knit']],
    ['t-shirt', ['t shirt', 't shirts', 'tshirt', 'tshirts', 'tee', 'tees'], ['tee']],
    ['tank top', ['tank top', 'tank tops', 'camisole', 'cami'], ['tee']],
    ['polo', ['polo shirt', 'polo shirts', 'polo'], ['shirt']],
    ['blouse', ['blouse', 'blouses'], ['shirt']],
    ['shirt', ['button up', 'button down', 'shirt', 'shirts'], ['shirt']],
    /* a "top" is as often a blouse or a wrap top as a tee */
    ['top', ['top', 'tops'], ['shirt', 'tee']],
    ['blazer', ['sport coat', 'suit jacket', 'blazer', 'blazers'], ['jacket']],
    ['puffer', ['puffer jacket', 'puffer coat', 'puffy jacket', 'puffy jackets', 'puffy coat', 'down jacket', 'puffer', 'puffers'], ['jacket']],
    ['bomber', ['bomber jacket', 'bomber'], ['jacket']],
    ['jacket', ['jacket', 'jackets'], ['jacket']],
    ['trench coat', ['trench coat', 'trench'], ['coat']],
    ['parka', ['parka', 'parkas'], ['coat']],
    ['coat', ['overcoat', 'topcoat', 'peacoat', 'pea coat', 'coat', 'coats'], ['coat']],
    ['dress', ['dress', 'dresses', 'gown'], ['dress']],
    ['skirt', ['skirt', 'skirts'], ['skirt']],
    ['jeans', ['jeans', 'jean'], ['trousers']],
    ['chinos', ['chinos', 'chino'], ['trousers']],
    ['sweatpants', ['sweatpants', 'sweatpant', 'joggers', 'jogger', 'track pants', 'trackpants'], ['trousers']],
    ['leggings', ['leggings'], ['trousers']],
    ['trousers', ['trousers', 'trouser', 'pants', 'pant', 'slacks'], ['trousers']],
    ['shorts', ['shorts'], ['shorts']],
    ['sneakers', ['sneakers', 'sneaker', 'trainers', 'trainer', 'shoes'], ['sneaker']]
  ];

  /* What the garment is like, the way shops write it. Spellings and
     hyphenations of one descriptor are one descriptor: "double breasted"
     and "double-breasted", "colour block" and "colorblock". */
  const DESCRIPTORS = [
    ['double-breasted', ['double breasted']], ['single-breasted', ['single breasted']],
    ['colour block', ['colour block', 'color block', 'colourblock', 'colorblock']],
    ['wide-leg', ['wide leg']], ['straight-leg', ['straight leg']], ['high-waisted', ['high waisted', 'high waist', 'high rise']],
    ['crew neck', ['crew neck', 'crewneck']], ['v-neck', ['v neck', 'vneck']], ['turtleneck', ['turtleneck', 'roll neck', 'rollneck']],
    ['long-sleeve', ['long sleeve', 'long sleeved']], ['short-sleeve', ['short sleeve', 'short sleeved']],
    ['camp collar', ['camp collar']], ['cable-knit', ['cable knit']],
    ['pleated', ['pleated', 'pleats', 'pleat']], ['midi', ['midi']], ['maxi', ['maxi']], ['mini', ['mini']],
    ['cropped', ['cropped', 'crop']], ['ribbed', ['ribbed', 'rib knit']], ['quilted', ['quilted']],
    ['cargo', ['cargo']], ['utility', ['utility']], ['slip', ['slip']], ['wrap', ['wrap']], ['track', ['track']],
    ['tailored', ['tailored']], ['boxy', ['boxy']], ['washed', ['washed']], ['distressed', ['distressed', 'ripped']],
    ['printed', ['printed', 'print']], ['floral', ['floral']], ['striped', ['striped', 'stripes', 'stripe']], ['plaid', ['plaid', 'tartan']],
    ['heavyweight', ['heavyweight', 'heavy weight']], ['lightweight', ['lightweight', 'light weight']], ['pocket', ['pocket', 'pockets']],
    ['wool', ['wool', 'woollen', 'woolen']], ['merino', ['merino']], ['cashmere', ['cashmere']], ['cotton', ['cotton']],
    ['linen', ['linen']], ['silk', ['silk']], ['satin', ['satin']], ['denim', ['denim']], ['leather', ['leather']],
    ['suede', ['suede']], ['fleece', ['fleece']], ['corduroy', ['corduroy', 'cord']], ['tencel', ['tencel']],
    ['poplin', ['poplin']], ['oxford', ['oxford']], ['jersey', ['jersey']], ['knit', ['knit', 'knitted']]
  ];

  /* every phrase, longest first, so "puffer jacket" is one puffer and
     not also a jacket, "sweatpants" is not also "pants", and a t-shirt
     is not also a shirt */
  const PHRASES = [
    ...GARMENTS.flatMap(([name, words, categories]) => words.map((word) => ({ word, kind: 'garment', name, categories }))),
    ...DESCRIPTORS.flatMap(([name, words]) => words.map((word) => ({ word, kind: 'descriptor', name })))
  ].sort((a, b) => b.word.length - a.word.length);

  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* the garments and descriptors a request names, and the catalogue
     categories its garments are filed under */
  function readGarments(query) {
    let text = ` ${String(query || '').toLowerCase().replace(/[\u2010-\u2015-]+/g, ' ').replace(/[^a-z0-9$\s]+/g, ' ').replace(/\s+/g, ' ')} `;
    const garments = [];
    const descriptors = [];
    const categories = [];
    for (const phrase of PHRASES) {
      const pattern = new RegExp(`(^|\\s)${escape(phrase.word)}(?=\\s|$)`, 'g');
      if (!pattern.test(text)) continue;
      text = text.replace(pattern, '$1|');
      const into = phrase.kind === 'garment' ? garments : descriptors;
      if (!into.includes(phrase.name)) into.push(phrase.name);
      for (const category of phrase.categories || []) if (!categories.includes(category)) categories.push(category);
    }
    /* "knit" or "oxford" on its own is the garment; beside a garment it
       describes it */
    for (const [word, garment, category] of [['knit', 'sweater', 'knit'], ['oxford', 'shirt', 'shirt']]) {
      if (garments.length || !descriptors.includes(word)) continue;
      descriptors.splice(descriptors.indexOf(word), 1);
      garments.push(garment);
      categories.push(category);
    }
    return { garments, descriptors, categories };
  }

  /* ---------- requests that describe the garment rather than name it ----------

     "something like a hoodie but cleaner", "a shirt that looks like a
     jacket", "something cozy I can wear with jeans". The words above
     find a hoodie, a shirt and a jacket, and jeans, in those — and every
     one of them is the wrong thing to search for on its own. The shopper
     compared, described or set the scene; they did not name a product.

     So a request is read a second time, for HOW it names its garments:

       target      the thing wanted: the shirt of "a shirt that looks
                   like a jacket"
       reference   something it is compared with: "like a hoodie"
       context     something it is worn with, over or under — never the
                   thing to buy: the jeans of "to wear with jeans"

     and for what it says the garment should be like: the soft signals
     ("cleaner", "cozy", "not too formal"), the silhouette ("loose") and
     colour in the shopper's own words.

     Out of that come the likely product concepts — the names shops
     actually use — ranked, strongest first. They come from the tables
     below and nowhere else: nothing is inferred that a table does not
     say, and a table entry needs a garment, a comparison or a setting
     in the request to fire. "Something nice for dinner" names none, so
     it gets no garment at all — not a dress, and not black.

     null means the request was not descriptive: it named its garment
     and said what it is like in shop words ("black oversized hoodie
     under $80"), and everything downstream behaves exactly as it did
     before this reader existed. */

  /* Garments the clothing table above does not hold, which a request can
     still be ABOUT: what a shopper asks for when it is a bag or a boot. */
  const EXTRA_ANCHORS = [
    ['bag', ['bag', 'bags', 'purse', 'purses', 'handbag', 'handbags', 'tote', 'totes', 'crossbody', 'satchel', 'clutch']],
    ['boots', ['boots', 'boot', 'booties']],
    ['heels', ['heels', 'pumps']],
    ['sandals', ['sandals', 'sandal', 'slides']],
    ['loafers', ['loafers', 'loafer']],
    ['hat', ['hat', 'hats', 'cap', 'caps', 'beanie']],
    ['scarf', ['scarf', 'scarves']],
    /* named mostly as what something is worn with ("shoes to wear with a
       suit") or ruled out ("not a suit"); never read as an exact garment */
    ['suit', ['suit', 'suits', 'tuxedo', 'tuxedos']]
  ];

  const FAMILY = {
    hoodie: 'top', sweatshirt: 'top', cardigan: 'top', sweater: 'top', 't-shirt': 'top', 'tank top': 'top',
    polo: 'top', blouse: 'top', shirt: 'top', top: 'top',
    blazer: 'outer', puffer: 'outer', bomber: 'outer', jacket: 'outer', 'trench coat': 'outer', parka: 'outer', coat: 'outer',
    dress: 'dress',
    skirt: 'bottom', jeans: 'bottom', chinos: 'bottom', sweatpants: 'bottom', leggings: 'bottom', trousers: 'bottom', shorts: 'bottom',
    sneakers: 'shoe', boots: 'shoe', heels: 'shoe', sandals: 'shoe', loafers: 'shoe',
    bag: 'accessory', hat: 'accessory', scarf: 'accessory', suit: 'suit'
  };

  /* What a garment is called once the request says what it should be
     like. Each entry: the garment, the signals that must ALL be present,
     and the concepts, strongest first. The most specific entry wins.
     `style` is the one word that goes into the search phrase for it;
     `avoid` names concepts the request gives no evidence for, which the
     ranking holds below everything that does match. */
  const DESCRIBED = [
    { anchor: 'hoodie', signals: ['polished'], concepts: ['quarter zip pullover', 'crewneck sweatshirt', 'knit pullover'], style: 'minimal' },
    { anchor: 'hoodie', signals: ['minimal'], concepts: ['quarter zip pullover', 'crewneck sweatshirt', 'knit pullover'], style: 'minimal' },
    { anchor: 'hoodie', signals: ['cozy'], concepts: ['fleece hoodie', 'sherpa hoodie', 'sweatshirt'], style: 'cozy' },
    { anchor: 'sweatshirt', signals: ['polished'], concepts: ['quarter zip pullover', 'knit pullover', 'crewneck sweater'], style: 'minimal' },
    { anchor: 'sweatshirt', signals: ['minimal'], concepts: ['quarter zip pullover', 'knit pullover', 'crewneck sweater'], style: 'minimal' },
    { anchor: 't-shirt', signals: ['polished'], concepts: ['heavyweight tee', 'knit polo', 'mock neck tee'] },
    { anchor: 'sweatpants', signals: ['polished'], concepts: ['tailored joggers', 'pull on trousers', 'knit trousers'], style: null },
    { anchor: 'jeans', signals: ['polished'], concepts: ['trouser jeans', 'tailored jeans'], style: null },
    { anchor: 'trousers', signals: ['polished', 'cozy'], concepts: ['pull on trousers', 'stretch trousers', 'tailored trousers'], style: null },
    { anchor: 'trousers', signals: ['straight'], concepts: ['straight leg pants', 'relaxed trousers', 'wide leg pants'], style: null },
    { anchor: 'trousers', signals: ['regular'], concepts: ['straight leg pants', 'tailored trousers'], style: null },
    { anchor: 'jeans', signals: ['straight'], concepts: ['straight leg jeans', 'relaxed jeans', 'wide leg jeans'], style: null },
    { anchor: 'jeans', signals: ['regular'], concepts: ['straight leg jeans', 'slim jeans'], style: null },
    { anchor: 'jeans', signals: ['relaxed'], concepts: ['baggy jeans', 'relaxed jeans', 'wide leg jeans'], style: null },
    { anchor: 'jacket', signals: ['relaxed', 'minimal'], concepts: ['relaxed jacket', 'overshirt', 'chore jacket'], style: 'minimal' },
    { anchor: 'cardigan', signals: ['polished'], concepts: ['knit blazer', 'sweater jacket', 'structured cardigan'], style: null },
    { anchor: 'trousers', signals: ['relaxed', 'polished'], concepts: ['wide leg trousers', 'relaxed trousers', 'pleated trousers'], style: null },
    { anchor: 'trousers', signals: ['relaxed'], concepts: ['wide leg trousers', 'relaxed trousers'], style: null },
    { anchor: 'trousers', signals: ['polished'], concepts: ['tailored trousers', 'pleated trousers'], style: null },
    { anchor: 'trousers', signals: ['cozy'], concepts: ['lounge pants', 'knit pants', 'sweatpants'], style: 'cozy' },
    { anchor: 'shorts', signals: ['polished'], concepts: ['tailored shorts', 'pleated shorts'], style: null },
    { anchor: 'dress', signals: ['minimal', 'casual'], concepts: ['shift dress', 't-shirt dress', 'shirt dress'], style: 'casual', avoid: ['gown', 'sequin dress', 'cocktail dress'] },
    { anchor: 'dress', signals: ['casual'], concepts: ['t-shirt dress', 'shirt dress', 'knit dress'], style: 'casual', avoid: ['gown', 'sequin dress', 'cocktail dress'] },
    { anchor: 'dress', signals: ['minimal'], concepts: ['shift dress', 'sheath dress', 'column dress'], style: 'simple' },
    { anchor: 'dress', signals: ['cozy'], concepts: ['sweater dress', 'knit dress'], style: 'cozy' },
    { anchor: 'jacket', signals: ['short'], concepts: ['cropped jacket'] },
    { anchor: 'jacket', signals: ['polished'], concepts: ['tailored jacket', 'blazer'], style: null },
    { anchor: 'jacket', signals: ['cozy'], concepts: ['fleece jacket', 'sherpa jacket', 'quilted jacket'], style: 'cozy' },
    { anchor: 'coat', signals: ['cozy'], concepts: ['teddy coat', 'fleece coat'], style: 'cozy' },
    { anchor: 'sweater', signals: ['cozy'], concepts: ['chunky sweater', 'cardigan'], style: 'cozy' },
    { anchor: 'sweater', signals: ['polished'], concepts: ['fine knit sweater', 'knit polo'] },
    { anchor: 'shirt', signals: ['polished'], concepts: ['oxford shirt', 'button down shirt'], style: null },
    { anchor: 'shirt', signals: ['cozy'], concepts: ['flannel shirt', 'brushed shirt'], style: 'cozy' },
    { anchor: 'top', signals: ['polished'], concepts: ['blouse', 'knit top'] },
    { anchor: 'top', signals: ['cozy'], concepts: ['sweater', 'sweatshirt'], style: 'cozy' },
    { anchor: 'blazer', signals: ['casual'], concepts: ['unstructured blazer', 'knit blazer'] },
    { anchor: 'blazer', signals: ['cozy'], concepts: ['knit blazer'] },
    { anchor: 'sneakers', signals: ['polished'], concepts: ['minimal sneakers', 'low top sneakers'] },
    { anchor: 'sneakers', signals: ['minimal'], concepts: ['minimal sneakers', 'low top sneakers'] },
    { anchor: 'bag', signals: ['vintage'], concepts: ['shoulder bag', 'top handle bag'], style: 'vintage style' },
    { anchor: 'bag', signals: ['polished'], concepts: ['structured bag', 'top handle bag'], style: null },
    { anchor: 'bag', signals: ['minimal'], concepts: ['tote bag', 'shoulder bag'], style: 'minimal' },
    { anchor: 'boots', signals: ['polished'], concepts: ['chelsea boots', 'ankle boots'] }
  ];

  /* "Something like a X", with nothing more said: the garments nearest
     to X that are not X. Used only for a comparison no entry above
     covers. */
  const NEIGHBOURS = {
    hoodie: ['sweatshirt', 'zip up hoodie', 'quarter zip pullover'],
    sweatshirt: ['crewneck sweatshirt', 'hoodie'],
    sweater: ['knit pullover', 'cardigan'],
    cardigan: ['knit jacket', 'sweater'],
    jacket: ['overshirt', 'shirt jacket', 'light jacket'],
    blazer: ['tailored jacket', 'unstructured blazer'],
    bomber: ['varsity jacket', 'harrington jacket'],
    puffer: ['quilted jacket', 'padded jacket'],
    coat: ['overcoat', 'car coat'],
    'trench coat': ['mac coat', 'overcoat'],
    shirt: ['button down shirt', 'overshirt'],
    't-shirt': ['heavyweight tee', 'long sleeve tee'],
    polo: ['knit polo', 'rugby shirt'],
    jeans: ['denim trousers', 'chinos'],
    chinos: ['trousers', 'straight leg pants'],
    sweatpants: ['joggers', 'track pants'],
    leggings: ['flare leggings', 'yoga pants'],
    trousers: ['wide leg pants', 'chinos'],
    sneakers: ['trainers', 'low top sneakers']
  };

  /* Two garments a request crosses: "a shirt that looks like a jacket",
     "a sweater but like a jacket". What shops call the crossing. */
  const HYBRIDS = [
    { pair: ['shirt', 'jacket'], concepts: ['overshirt', 'shirt jacket', 'chore jacket'], avoid: ['bomber', 'puffer', 'leather jacket', 'parka', 'down jacket', 'blazer', 'windbreaker', 'rain jacket', 'varsity jacket'] },
    { pair: ['shirt', 'coat'], concepts: ['overshirt', 'shirt jacket', 'chore jacket'], avoid: ['puffer', 'parka', 'trench', 'overcoat'] },
    { pair: ['hoodie', 'jacket'], concepts: ['zip up hoodie', 'hooded jacket'] },
    { pair: ['sweatshirt', 'jacket'], concepts: ['zip up sweatshirt', 'sweat jacket'] },
    { pair: ['sweater', 'jacket'], concepts: ['sweater jacket', 'knit jacket', 'cardigan'] },
    { pair: ['cardigan', 'jacket'], concepts: ['sweater jacket', 'knit jacket'] },
    { pair: ['cardigan', 'blazer'], concepts: ['knit blazer', 'cardigan blazer'] },
    { pair: ['sweater', 'blazer'], concepts: ['knit blazer', 'cardigan blazer'] },
    { pair: ['shirt', 'dress'], concepts: ['shirt dress'] },
    { pair: ['t-shirt', 'dress'], concepts: ['t-shirt dress'] },
    { pair: ['sweater', 'dress'], concepts: ['sweater dress', 'knit dress'] },
    { pair: ['sweatshirt', 'dress'], concepts: ['sweatshirt dress'] },
    { pair: ['hoodie', 'dress'], concepts: ['hoodie dress'] },
    { pair: ['jeans', 'trousers'], concepts: ['trouser jeans', 'tailored jeans'] },
    { pair: ['sweatpants', 'trousers'], concepts: ['tailored joggers', 'knit trousers'] },
    { pair: ['sweatpants', 'jeans'], concepts: ['denim joggers'] },
    { pair: ['skirt', 'shorts'], concepts: ['skort'] },
    { pair: ['coat', 'blazer'], concepts: ['longline blazer', 'blazer coat'] },
    { pair: ['shirt', 'sweater'], concepts: ['knit shirt', 'sweater polo'] }
  ];

  /* A garment named only as what the wanted one goes with, over or under.
     Keyed by how it was named and the family of the garment named; an
     entry with an `anchor` applies only when the request also names that
     garment ("that short jacket thing people wear over shirts"). */
  const SETTINGS = [
    { relation: 'over', family: 'top', anchor: 'jacket', concepts: ['overshirt', 'shirt jacket'] },
    /* a hoodie is bulky: what goes over it is a roomy outer layer, not a cardigan */
    { relation: 'over', garment: ['hoodie', 'sweatshirt', 'sweater'], concepts: ['denim jacket', 'chore jacket', 'puffer vest'] },
    { relation: 'over', family: 'top', concepts: ['overshirt', 'shirt jacket', 'cardigan', 'light jacket'] },
    { relation: 'over', family: 'dress', concepts: ['cardigan', 'cropped jacket', 'shrug'] },
    { relation: 'under', family: 'outer', concepts: ['knit top', 'fitted tee'] },
    { relation: 'under', family: 'top', concepts: ['fitted tee', 'tank top'] },
    { relation: 'with', family: 'bottom', signal: 'cozy', concepts: ['sweater', 'sweatshirt', 'cardigan'], style: 'cozy' },
    { relation: 'with', family: 'bottom', signal: 'polished', concepts: ['blouse', 'knit top', 'button down shirt'] },
    { relation: 'with', family: 'bottom', concepts: ['top', 'sweater', 'shirt'] },
    { relation: 'with', family: 'top', concepts: ['trousers', 'jeans', 'skirt'] },
    { relation: 'with', family: 'dress', concepts: ['cardigan', 'cropped jacket'] },
    /* "the kind of shoes you wear with suits": shoes is read as sneakers,
       and a suit says which shoes */
    { relation: 'with', garment: ['suit'], anchor: 'sneakers', concepts: ['dress shoes', 'oxford shoes', 'derby shoes'] },
    { relation: 'under', family: 'suit', concepts: ['dress shirt', 'knit top', 'fitted tee'] }
  ];

  /* A request that names no garment at all, only a signal. Only the
     signals that point at a kind of garment by themselves are here:
     "cozy" is knitwear and fleece far more often than not. "Nice",
     "polished" and "casual" point at nothing in particular, so they get
     no garment — the request stays as broad as it was asked. */
  const OPEN = [
    { signal: 'cozy', concepts: ['sweater', 'sweatshirt', 'cardigan'], style: 'cozy' }
  ];

  /* What a garment is like compared with itself: "a shirt but heavier",
     "the same vibe as a sweatshirt but thinner", "not a hoodie, something
     warmer". The word a shop uses for the difference, and what it most
     likely makes of the garment. A garment no entry covers is searched
     as the shop word and the garment: "heavyweight cardigan". */
  const PROPERTY_WORDS = {
    heavier: 'heavyweight', thicker: 'heavyweight', heavy: 'heavyweight', thick: 'heavyweight', chunkier: 'chunky',
    thinner: 'lightweight', lighter: 'lightweight', thin: 'lightweight', lightweight: 'lightweight',
    warmer: 'warm', warm: 'warm', longer: 'longline', softer: 'soft', stretchier: 'stretch', stretchy: 'stretch',
    breathable: 'breathable'
  };
  /* the comparative forms: a request that says one is describing */
  const COMPARATIVE = new Set(['heavier', 'thicker', 'chunkier', 'thinner', 'lighter', 'warmer', 'longer', 'softer', 'stretchier', 'looser', 'tighter', 'shorter', 'nicer', 'cleaner', 'simpler', 'dressier', 'cheaper']);
  const PROPERTIES = [
    { anchor: ['shirt', 't-shirt'], property: 'heavyweight', concepts: ['heavyweight shirt', 'heavyweight tee', 'overshirt'] },
    { anchor: ['sweatshirt', 'hoodie'], property: 'lightweight', concepts: ['lightweight sweatshirt', 'long sleeve tee', 'french terry sweatshirt'] },
    { anchor: ['jacket'], property: 'lightweight', concepts: ['lightweight jacket', 'overshirt', 'shirt jacket'] },
    { anchor: ['jacket', 'coat'], property: 'warm', concepts: ['insulated jacket', 'fleece jacket', 'quilted jacket'] },
    { anchor: ['sweater', 'cardigan'], property: 'lightweight', concepts: ['fine knit sweater', 'lightweight sweater'] },
    { anchor: null, property: 'warm', concepts: ['sweater', 'fleece jacket', 'overshirt'], style: 'warm' }
  ];

  /* Parts of a garment a request can rule out. Ruling out the hood of a
     hoodie leaves a sweatshirt; ruling out sleeves leaves a tank. */
  const FEATURES = {
    hood: { without: ['hood', 'hooded', 'hoodie', 'hoody'], garment: 'hoodie', becomes: ['crewneck sweatshirt', 'pullover sweatshirt', 'knit pullover'] },
    hoods: 'hood',
    sleeves: { without: ['long sleeve', 'short sleeve', 'sleeve'], becomes: ['tank top', 'sleeveless top', 'camisole'] },
    sleeve: 'sleeves',
    logo: { without: ['logo', 'graphic', 'print', 'printed'], signal: 'minimal' },
    logos: 'logo', branding: 'logo', graphic: 'logo', graphics: 'logo', print: 'logo', prints: 'logo',
    zip: { without: ['zip', 'zip up', 'zipper'] }, zipper: 'zip',
    buttons: { without: ['button'] }, button: 'buttons',
    pockets: { without: ['pocket'] }, collar: { without: ['collar'] }
  };
  const feature = (word) => { const f = FEATURES[word]; return typeof f === 'string' ? FEATURES[f] : f; };

  /* a fit ruled out, and what that leaves: "not skinny" is straight or
     relaxed, "not too baggy" is a regular, straight fit */
  const NEGATED_FIT = { skinny: 'straight', slim: 'straight', tight: 'relaxed', fitted: 'relaxed', clingy: 'relaxed', bodycon: 'relaxed', baggy: 'regular', loose: 'regular', oversized: 'regular', wide: null, cropped: null, flared: null };
  /* how people say a size that shops call a fit: "not huge" rules out the
     oversized cut, not the word "huge", which no listing carries */
  const SIZE_FIT = { huge: 'oversized', massive: 'oversized', giant: 'oversized', enormous: 'oversized' };
  const MATERIAL_WORDS = ['faux leather', 'leather', 'wool', 'polyester', 'denim', 'silk', 'satin', 'linen', 'cotton', 'fleece', 'suede', 'velvet', 'nylon', 'cashmere', 'corduroy', 'fur', 'acrylic'];
  /* what a ruled-out garment or material is called on a listing */
  const RULED_OUT_AS = {
    coat: ['coat', 'overcoat', 'topcoat', 'peacoat', 'parka', 'trench'], jeans: ['jean', 'jeans'], hoodie: ['hoodie', 'hoody', 'hooded'],
    leather: ['leather', 'moto', 'biker'], 'faux leather': ['leather'], dress: ['dress', 'gown'], sneakers: ['sneaker', 'trainer']
  };
  const SHADES = new Set(['dark', 'light', 'bright', 'pale', 'muted', 'loud', 'neon']);
  const NEGATORS = new Set(['not', 'no', 'without', 'never', 'nothing', 'except', 'minus', 'hates', 'hate', 'less']);
  const NEGATOR_PAIRS = [['other', 'than'], ['anything', 'but'], ['instead', 'of'], ['rather', 'than']];
  /* passed over between "not" and what it rules out: "don't want to look
     too dressed up", "not really a jacket", "isn't super tight",
     "don't want an actual hood" */
  const PASS_NEGATED = new Set(['too', 'so', 'as', 'super', 'very', 'that', 'overly', 'crazy', 'really', 'insanely', 'ridiculously', 'all', 'quite', 'a', 'an', 'the', 'any', 'much', 'actually', 'actual', 'even', 'exactly', 'be', 'being', 'it', 'my', 'your', 'his', 'her', 'want', 'wanna', 'to', 'look', 'looking', 'seem', 'feel', 'for']);
  /* after "not", a word that says how sure or how keen, not what: "not
     sure", "not into", "not a fan of" rule nothing out */
  const NOT_RULED = new Set(('sure certain picky bothered fussed worried interested necessarily needed required ' +
    'important matter mind bad great good many lot something anything everything everyone yet').split(' '));
  /* "not into logos", "not a big fan of graphics": how keen, and then what */
  const KEEN = new Set(['into', 'big', 'huge', 'fan', 'of']);
  /* two words ruled out as one, and what else a listing calls them */
  const NEGATED_PHRASES = { 'see through': ['see through', 'sheer'], 'high waisted': ['high waisted', 'high waist'], 'low rise': ['low rise'], 'off shoulder': ['off shoulder'] };
  const UNSURE = new Set(['really', 'quite', 'exactly']);

  /* "fitted arms" is a sleeve, not a fit */
  const BODY_PARTS = new Set(['arm', 'arms', 'sleeve', 'sleeves', 'waist', 'waistband', 'cuff', 'cuffs', 'ankle', 'ankles', 'shoulder', 'shoulders', 'hips', 'chest', 'neck']);

  /* how a thing should LOOK, which is not what it costs or how old it is */
  const LOOKS = [
    ['old looking', 'vintage'], ['older looking', 'vintage'], ['looks old', 'vintage'], ['look old', 'vintage'],
    ['expensive looking', 'polished'], ['looks expensive', 'polished'], ['look expensive', 'polished'], ['pricey looking', 'polished'],
    ['high end', 'polished'], ['luxe', 'polished'], ['luxury looking', 'polished'], ['looks professional', 'polished'],
    ['look professional', 'polished'], ['professional', 'polished']
  ];
  /* what an occasion is called in a shop */
  const OCCASIONS = [
    ['going out', 'going out'], ['night out', 'going out'], ['clubbing', 'going out'], ['club', 'going out'], ['party', 'going out'],
    ['date night', 'date night'], ['date', 'date night'], ['wedding', 'wedding guest'], ['job interview', 'office'],
    ['interview', 'office'], ['work', 'office'], ['office', 'office'], ['gym', 'workout'], ['workout', 'workout'],
    ['vacation', 'vacation'], ['beach', 'vacation'], ['holiday', 'vacation']
  ];
  /* styles people name by who wears them */
  const TRIBES = {
    skater: 'skater style', skaters: 'skater style', skate: 'skate', streetwear: 'streetwear', preppy: 'preppy', y2k: 'y2k',
    grunge: 'grunge', boho: 'boho', bohemian: 'boho', athleisure: 'athleisure', workwear: 'workwear', gorpcore: 'gorpcore',
    techwear: 'techwear', western: 'western', coquette: 'coquette', cottagecore: 'cottagecore', '70s': '70s', '80s': '80s', '90s': '90s'
  };
  /* who it is for, when the request says so: "for my dad", "my boyfriend wants" */
  const RECIPIENTS = {
    dad: 'men', father: 'men', husband: 'men', boyfriend: 'men', brother: 'men', son: 'men', grandpa: 'men', him: 'men',
    mom: 'women', mum: 'women', mother: 'women', wife: 'women', girlfriend: 'women', sister: 'women', daughter: 'women', grandma: 'women', her: 'women'
  };
  const GENDER_OF = { men: 'men', mens: 'men', man: 'men', guy: 'men', guys: 'men', boys: 'men', women: 'women', womens: 'women', woman: 'women', ladies: 'women', lady: 'women', girls: 'women' };
  /* "i want like a jacket": a "like" that compares only after these */
  const LIKE_LEADS = new Set(['something', 'anything', 'one', 'look', 'looks', 'looking', 'feel', 'feels', 'is', 'thats', 'kinda', 'sorta', 'just', 'more', 'bit', 'similar', 'but', 'vibe', 'style']);
  /* words that say a person is talking, not naming a product */
  const CONVERSATIONAL = new Set(('want wanna need needs looking idk kinda sorta something anything thing things stuff really maybe same vibe vibes ' +
    'can could would please find show give help but thats which who people wear wears wearing goes im me my you your he she his ' +
    'her hey so um uh just like some outfit clothes kind sort basically honestly literally sure unsure ' +
    'cousin cousins friend friends family aunt uncle niece nephew coworker coworkers boss').split(' '));
  /* vague words a shop never titles anything with, dropped from a plain search */
  const UNSHOPPABLE = new Set(('nice nicer clean cleaner sloppy polished smarter refined sharper fancier chill lowkey easygoing laidback ' +
    'put together grown up look looks good').split(' '));


  /* What the garment should be like. `vague` marks the words that say
     the shopper is describing rather than naming — a shop never titles
     anything "cleaner" or "comfy" — and only those make a request
     descriptive. "Vintage", "minimal", "loose" and "casual" are words a
     shop does use, so on their own they leave the request on the path
     it always took. Longest phrase first, so "looks vintage" is read
     before "vintage". */
  const SIGNALS = [
    ['polished', true, ['look nice', 'looks nice', 'look good', 'looks good', 'put together', 'grown up', 'more polished', 'polished', 'nicer', 'nice', 'elevated', 'dressier', 'dressy', 'smarter', 'refined', 'classy', 'classier', 'sharper', 'sophisticated', 'elegant', 'fancier', 'more formal', 'less sloppy', 'more structured', 'structured']],
    ['polished', true, ['cleaner', 'clean']],
    ['minimal', true, ['cleaner', 'clean', 'simple', 'simpler', 'plain', 'basic', 'understated', 'subtle', 'no logo', 'no logos', 'without logos', 'without a logo']],
    ['minimal', false, ['minimal', 'minimalist']],
    ['cozy', true, ['cozy', 'cosy', 'comfy', 'comfortable', 'snug', 'snuggly', 'soft']],
    ['casual', true, ['laid back', 'laidback', 'chill', 'lowkey', 'low key', 'easygoing']],
    ['casual', false, ['casual', 'everyday']],
    ['vintage', true, ['looks vintage', 'look vintage', 'vintage looking', 'vintage look', 'vintage style', 'vintage inspired', 'retro', 'old school', 'oldschool', 'throwback', 'thrifted']],
    ['vintage', false, ['vintage']],
    ['affordable', true, ['affordable', 'cheap', 'cheaper', 'inexpensive', 'on a budget', 'low cost', 'reasonably priced']],
    ['relaxed', false, ['loose', 'looser', 'baggy', 'roomy', 'slouchy', 'oversized', 'oversize', 'flowy', 'relaxed', 'wide']],
    ['fitted', false, ['fitted', 'slim', 'skinny', 'tight', 'form fitting', 'bodycon']],
    ['short', false, ['short', 'shorter']]
  ];

  /* "not too formal", "not crazy expensive", "nothing too tight": what
     the shopper ruled out, read as what they want instead. A word with
     no opposite here is only taken out of the request. */
  const NEGATED = {
    formal: ['casual'], dressy: ['casual'], dressed: ['casual'], fancy: ['casual'], stuffy: ['casual'], fussy: ['casual'], overdressed: ['casual'],
    expensive: ['affordable'], pricey: ['affordable'], pricy: ['affordable'], costly: ['affordable'],
    tight: ['relaxed'], clingy: ['relaxed'], fitted: ['relaxed'], skinny: ['relaxed'],
    loud: ['minimal'], flashy: ['minimal'], busy: ['minimal'], extra: ['minimal'],
    casual: ['polished'], sloppy: ['polished'],
    baggy: [], loose: [], bulky: [], heavy: [], warm: [], short: [], long: []
  };
  const NEGATION = /\b(?:not|nothing|never|without|no|isnt|less)\s+((?:too|so|as|super|very|that|overly|crazy|really|insanely|ridiculously|all that)\s+)*([a-z]+)\b/g;

  /* the shopper's own fit word, as a shop would title it */
  const FIT_WORD = { loose: 'relaxed', looser: 'relaxed', roomy: 'relaxed', slouchy: 'relaxed', flowy: 'relaxed', wide: 'relaxed', relaxed: 'relaxed', baggy: 'baggy', oversized: 'oversized', oversize: 'oversized', fitted: 'slim', slim: 'slim', skinny: 'skinny', tight: 'slim', 'form fitting': 'slim', bodycon: 'bodycon' };

  /* the word a signal puts in the search phrase when no entry names one.
     "affordable" puts none: "cheap" in a search phrase brings back junk,
     and a budget the shopper did not state is not invented. */
  /* the signals whose plain word is itself what a shop titles things with */
  const SHOP_STYLE = new Set(['casual', 'minimal', 'vintage']);
  const STYLE_WORD = { polished: 'dressy', minimal: 'minimal', cozy: 'cozy', casual: 'casual', vintage: 'vintage style', warm: 'warm' };

  const COLOUR_WORDS = ['off white', 'black', 'white', 'cream', 'ivory', 'beige', 'tan', 'camel', 'brown', 'chocolate', 'khaki', 'olive', 'green', 'sage', 'navy', 'blue', 'grey', 'gray', 'charcoal', 'red', 'burgundy', 'maroon', 'pink', 'purple', 'lilac', 'lavender', 'yellow', 'orange', 'rust', 'gold', 'silver'];

  /* the words of a request that carry nothing a search engine could use */
  const FILLER = new Set(('a an the and or but that thats this those these it its i im ive me my mine you your we us our for to of in on at by from with over under into onto as is are was be been being can could would should will want wanna need needs looking look looks like kind sort kinda sorta something anything thing things stuff item items piece pieces people person wear wearing worn go goes going get got find show some any more less much very really too so just not no also maybe perhaps similar type vibe vibes ish one ones what which who where when how they them their there here have has had do does did feel feels still yet bit little lot pretty quite other else own put together way kinda lowkey honestly please help idea ideas sth outfit outfits fit fits wardrobe clothes clothing everyone everybody usually always often around about than then them those guys girls folks underneath beneath alongside match matches matching pair dollars dollar bucks usd budget price under below above over up to max least between and').split(' '));
  const VAGUE_NOUN = /\b(something|anything|thing|things|stuff|item|piece|outfit|whatever|sth)\b/;
  const THING = new Set(['thing', 'things', 'piece', 'style', 'type', 'vibe', 'situation']);
  const DETERMINER = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'their', 'our', 'some', 'one', 'of', 'those', 'these', 'them', 'it', 'nice', 'regular', 'normal', 'plain', 'basic', 'simple', 'classic']);
  const ADJECTIVES = new Set(['favorite', 'favourite', 'fav', 'old', 'new', 'dark', 'light', 'wash', 'washed', 'high', 'rise', 'waisted', 'leg', 'mom', 'dad', 'ripped', 'straight', 'wide', 'skinny', 'baggy', 'loose', 'cropped', 'long', 'short', 'denim', 'white', 'black', 'blue', 'grey', 'gray', 'navy', 'cream', 'beige', 'brown', 'tan', 'khaki', 'olive', 'green', 'red', 'pink']);
  const PASSED_OVER = (token) => DETERMINER.has(token) || ADJECTIVES.has(token);
  const RELATION = { with: 'with', match: 'with', matches: 'with', matching: 'with', alongside: 'with', pair: 'with', over: 'over', under: 'under', underneath: 'under', beneath: 'under' };
  const REFERENCE = [['kind', 'of', 'like'], ['sort', 'of', 'like'], ['same', 'vibe', 'as'], ['same', 'feel', 'as'], ['vibe', 'as'], ['same', 'as'], ['similar', 'to'], ['close', 'to'], ['inspired', 'by'], ['like'], ['resembles'], ['resembling'], ['alternative', 'to'], ['version', 'of'], ['between'], ['and']];
  const GENDER_WORDS = new Set(['men', 'mens', 'man', 'women', 'womens', 'woman', 'ladies', 'lady', 'unisex', 'girls', 'boys', 'guy', 'guys']);

  const GARMENT_PHRASES = [
    ...GARMENTS.flatMap(([name, words]) => words.map((word) => ({ word, name }))),
    ...EXTRA_ANCHORS.flatMap(([name, words]) => words.map((word) => ({ word, name })))
  ].sort((a, b) => b.word.split(' ').length - a.word.split(' ').length || b.word.length - a.word.length);

  const DESCRIPTOR_WORDS = new Set(DESCRIPTORS.flatMap(([name, words]) => [name, ...words]).flatMap((w) => w.split(/[\s-]+/)));

  /* ---------- what a person types, made readable ----------

     Before anything is read, the request is put into one plain form:
     contractions opened ("aren't" is "are not", so the "not" can be
     seen), shorthand and slang said in shop words ("trackies" are track
     pants, "kicks" are sneakers), and plain misspellings of the words
     this reader knows corrected ("hoddie", "sweter", "jeens").

     Corrections are conservative on purpose. A word is only corrected
     when it is a known misspelling, or when it is six letters or longer,
     is not a word this reader already knows, and is one edit away from
     exactly ONE garment, fit or material word. "Dressed" is not a typo
     of "dresses", "heather" grey is not "leather", and a short word is
     never guessed at: "boat" is not a coat. */

  const CONTRACTIONS = {
    arent: 'are not', isnt: 'is not', dont: 'do not', doesnt: 'does not', didnt: 'did not', wasnt: 'was not',
    werent: 'were not', wont: 'will not', cant: 'can not', couldnt: 'could not', wouldnt: 'would not',
    shouldnt: 'should not', aint: 'is not', havent: 'have not', hasnt: 'has not'
  };
  const SHORTHAND = {
    idk: '', tbh: '', ngl: '', imo: '', lol: '', rn: '', pls: 'please', plz: 'please', u: 'you', ur: 'your',
    sth: 'something', smth: 'something', smthn: 'something', somethin: 'something', bc: 'because', cuz: 'because',
    trackies: 'track pants', trackie: 'track pants', sweats: 'sweatpants', kicks: 'sneakers', sneaks: 'sneakers',
    jorts: 'denim shorts', shacket: 'shirt jacket', shackets: 'shirt jackets', quarterzip: 'quarter zip', qzip: 'quarter zip',
    halfzip: 'half zip', pjs: 'pajamas', tux: 'tuxedo', bf: 'boyfriend', gf: 'girlfriend', fav: 'favourite', fave: 'favourite',
    /* the sounds a person types while thinking, anywhere in the request */
    um: '', umm: '', ummm: '', uh: '', uhh: '', uhm: '', hmm: '', hmmm: '', fr: '', frfr: '',
    somthing: 'something', sumthing: 'something', smthing: 'something', somethng: 'something', someting: 'something',
    sumthin: 'something', rlly: 'really', tryna: 'trying to',
    /* how shops and shoppers shorten things */
    blk: 'black', wht: 'white', nvy: 'navy', brn: 'brown', gry: 'grey', wmns: 'womens', wmn: 'womens', womns: 'womens',
    mns: 'mens', lng: 'long', slv: 'sleeve', slvs: 'sleeves', sz: 'size', cardi: 'cardigan', cardis: 'cardigans', jkt: 'jacket'
  };
  const TYPOS = {
    hoddie: 'hoodie', hodie: 'hoodie', hoodi: 'hoodie', hooide: 'hoodie', hoodey: 'hoodie', hoodys: 'hoodies',
    sweter: 'sweater', sweatter: 'sweater', swetter: 'sweater', sweather: 'sweater', swaeter: 'sweater', sweaterr: 'sweater',
    sweatshrit: 'sweatshirt', sweatshrt: 'sweatshirt', swetshirt: 'sweatshirt', sweetshirt: 'sweatshirt', sweatshirtt: 'sweatshirt',
    jaket: 'jacket', jackit: 'jacket', jakcet: 'jacket', jacekt: 'jacket', jackt: 'jacket',
    jeens: 'jeans', jeanz: 'jeans', jenas: 'jeans', pnats: 'pants', pnts: 'pants', pantz: 'pants', pans: 'pants',
    trowsers: 'trousers', trousres: 'trousers', trouers: 'trousers', shrit: 'shirt', shirtt: 'shirt', sihrt: 'shirt', tshrit: 'tshirt',
    dres: 'dress', dresss: 'dress', dreess: 'dress', drss: 'dress', skrit: 'skirt', skirtt: 'skirt', sweaters: 'sweaters',
    blak: 'black', balck: 'black', blck: 'black', blakc: 'black', whte: 'white', wite: 'white', whtie: 'white', whit: 'white',
    gery: 'grey', gry: 'grey', navey: 'navy', beig: 'beige', biege: 'beige', brwon: 'brown', bronw: 'brown', burgandy: 'burgundy',
    cardigen: 'cardigan', cardigon: 'cardigan', cardign: 'cardigan', blazor: 'blazer', blaser: 'blazer',
    sneekers: 'sneakers', sneakrs: 'sneakers', snekers: 'sneakers', legings: 'leggings', leggins: 'leggings',
    ovesized: 'oversized', oversied: 'oversized', oversizd: 'oversized', baggie: 'baggy', bagy: 'baggy', skiny: 'skinny',
    skinnie: 'skinny', tite: 'tight', fited: 'fitted', croped: 'cropped', crooped: 'cropped', cozey: 'cozy', comfey: 'comfy',
    comfi: 'comfy', vintge: 'vintage', vintag: 'vintage', lether: 'leather', leathr: 'leather', denium: 'denim',
    cashmire: 'cashmere', corderoy: 'corduroy', courdoroy: 'corduroy', linnen: 'linen', pufer: 'puffer', weding: 'wedding',
    sleve: 'sleeve', sleves: 'sleeves', womans: 'womens', womens: 'womens',
    jumpr: 'jumper', jumpa: 'jumper', jumpper: 'jumper', cardagin: 'cardigan', cardigin: 'cardigan', cardagan: 'cardigan',
    cardgan: 'cardigan', carigan: 'cardigan', buton: 'button', butten: 'button', butons: 'buttons', tshrt: 'tshirt',
    teeshirt: 'tshirt', blazzer: 'blazer', blouce: 'blouse', sandles: 'sandals', sandels: 'sandals'
  };
  /* the words a misspelling may be corrected TO */
  const CORRECTABLE = [
    'hoodie', 'hoodies', 'sweater', 'sweaters', 'sweatshirt', 'sweatshirts', 'jacket', 'jackets', 'cardigan', 'cardigans',
    'blazer', 'blazers', 'puffer', 'bomber', 'trousers', 'leggings', 'sneakers', 'trainers', 'chinos', 'joggers', 'blouse',
    'blouses', 'jumper', 'pullover', 'overcoat', 'sandals', 'loafers', 'tshirt', 'dresses', 'skirts', 'shirts',
    'oversized', 'relaxed', 'skinny', 'fitted', 'cropped', 'leather', 'cotton', 'corduroy', 'cashmere', 'fleece', 'velvet',
    'vintage', 'wedding', 'turtleneck', 'crewneck'
  ];
  /* words that look like a misspelling of one of those, and are not */
  const NOT_A_TYPO = new Set(('dressed dresser heather feather weather packet racket pocket rocket socket locket buffer puffed ' +
    'bombed comber somber glazer blazed goodie goodies sweeter button bottom sitting fitting fitter knitted sleeve sleeves sleeved ' +
    'fleeced dropped chopped flamed loader loaders trainee vandal jumped bumper people shoots loggers logger dollar dollars collar ' +
    'popular skater skates slater hooded hooked hooped mellow fellow yellow sliver golden colder weeding sweats shirty shorts ' +
    'sports skirted blouson sneaky leathery cottony relaxing related fitness shifts trousered heathered cropper').split(' '));

  const PREAMBLE = /^(?:(?:hey|hi|hello|so|um|uh|ok|okay|yo|please|plz)\s+|(?:can|could|would) you (?:please )?(?:help me )?(?:find|show|get|recommend|suggest)(?: me)?\s+|(?:please )?(?:help me )?(?:find|show|get|give|recommend|suggest)(?: me)?\s+|(?:i am|im|i m|we are) (?:looking for|searching for|after|trying to find|shopping for)\s+|(?:looking for|searching for|shopping for)\s+|i (?:want|need|would like|wanna)(?: to (?:buy|find|get))?\s+)/;
  const PREAMBLE_SEEN = /^\s*(hey|hi|hello|so|um|uh|ok|okay|yo|please|plz|can you|could you|would you|help me|find|show|get|give|recommend|suggest|i am|i'm|im|we are|looking for|searching for|shopping for|i want|i need|i would like|i wanna)\b/;

  /* the optimal-string-alignment distance, capped: is `a` one edit from `b` */
  function oneEditApart(a, b) {
    if (a === b || Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    if (a.length === b.length) {
      if (a.slice(i + 1) === b.slice(i + 1)) return true;
      return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
    }
    const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
    return longer.slice(i + 1) === shorter.slice(i);
  }

  let knownWords = null;
  function known() {
    if (knownWords) return knownWords;
    knownWords = new Set([
      ...GARMENTS.flatMap(([, ws]) => ws.flatMap((w) => w.split(' '))),
      ...EXTRA_ANCHORS.flatMap(([, ws]) => ws),
      ...DESCRIPTORS.flatMap(([name, ws]) => [name, ...ws]).flatMap((w) => w.split(/[\s-]+/)),
      ...SIGNALS.flatMap(([, , phrases]) => phrases).flatMap((w) => w.split(' ')),
      ...COLOUR_WORDS.flatMap((w) => w.split(' ')),
      ...FILLER, ...CORRECTABLE, ...NOT_A_TYPO
    ]);
    return knownWords;
  }

  function correct(token) {
    if (Object.prototype.hasOwnProperty.call(TYPOS, token)) return TYPOS[token];
    if (token.length < 6 || /\d/.test(token) || known().has(token)) return token;
    const near = CORRECTABLE.filter((word) => oneEditApart(token, word));
    return near.length === 1 ? near[0] : unmerge(token);
  }

  /* "blackhoodie", "widelegjeans", "oversizedtee": words run together,
     split back into the words a shop titles things with — only when the
     whole is not a word the tables know, and every part is a garment,
     colour, fit, cut or cloth word. Never a filler or a relation word: a
     "overshirt" is not "over shirt". */
  let partWords = null;
  function unmerge(token) {
    /* a tracksuit, jumpsuit or playsuit is one garment, never a suit */
    if (token.length < 7 || !/^[a-z]+$/.test(token) || /suits?$/.test(token)) return token;
    if (!partWords) {
      partWords = new Set([
        ...GARMENTS.flatMap(([name, ws]) => [name, ...ws]),
        ...EXTRA_ANCHORS.flatMap(([name, ws]) => [name, ...ws]),
        ...DESCRIPTORS.flatMap(([name, ws]) => [name, ...ws]).flatMap((w) => w.split(/[\s-]+/)),
        ...COLOUR_WORDS, ...MATERIAL_WORDS, ...Object.keys(FIT_WORD), 'tee', 'tshirt'
      ].filter((w) => /^[a-z]{3,}$/.test(w) && !FILLER.has(w) && !RELATION[w]));
    }
    /* the fewest parts, at most three, each one a word above */
    const best = new Array(token.length + 1).fill(null);
    best[0] = [];
    for (let end = 3; end <= token.length; end += 1) {
      for (let start = Math.max(0, end - 12); start <= end - 3; start += 1) {
        const part = token.slice(start, end);
        if (!best[start] || !partWords.has(part)) continue;
        const parts = best[start].concat([part]);
        if (parts.length <= 3 && (!best[end] || parts.length < best[end].length)) best[end] = parts;
      }
    }
    const parts = best[token.length];
    return parts && parts.length > 1 ? parts.join(' ') : token;
  }

  /* the request in one plain form, and the words that were changed */
  function normalize(query) {
    const changed = [];
    let text = String(query || '').toLowerCase()
      .replace(/\bw\/o\b/g, ' without ').replace(/\bw\//g, ' with ').replace(/&/g, ' and ')
      .replace(/n['‘’]t\b/g, 'nt')
      .replace(/['‘’]/g, ' ')
      .replace(/\b1\s*\/\s*4\b/g, 'quarter').replace(/\b1\s*\/\s*2\b/g, 'half')
      .replace(/[^a-z0-9$\s-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    text = text.split(' ').map((token) => {
      const bare = token.replace(/^-+|-+$/g, '');
      let out = bare;
      if (Object.prototype.hasOwnProperty.call(CONTRACTIONS, bare)) out = CONTRACTIONS[bare];
      else if (Object.prototype.hasOwnProperty.call(SHORTHAND, bare)) out = SHORTHAND[bare];
      else if (/^[a-z]+$/.test(bare)) out = correct(bare);
      if (out !== bare) changed.push([bare, out]);
      return out;
    }).filter(Boolean).join(' ');
    /* "find me", "i'm looking for", "can you show me": how a request is
       asked, not what it asks for. Taken off the front, so a request in
       shop words behind them is read as exactly that */
    let before;
    do {
      before = text;
      text = text.replace(PREAMBLE, '').trim();
    } while (text !== before && text);
    if (!text) text = before;
    if (text.length < String(query || '').trim().length && !changed.length && PREAMBLE_SEEN.test(String(query || '').toLowerCase())) changed.push(['preamble', '']);
    return { text, changed };
  }

  const words = (text) => text.split(' ').filter(Boolean);
  const unique = (list) => list.filter((one, at) => one && list.indexOf(one) === at);
  const concept = (name) => String(name).toLowerCase();
  /* a concept that is a KIND of the garment: "wide leg trousers" is
     trousers, "quarter zip pullover" is not a hoodie */
  function kindOf(name, anchor) {
    const entry = GARMENTS.find(([one]) => one === anchor) || EXTRA_ANCHORS.find(([one]) => one === anchor);
    const own = entry ? entry[1] : [anchor];
    const said = ` ${name.replace(/-/g, ' ')} `;
    return own.some((word) => said.includes(` ${word.replace(/-/g, ' ')} `)) || said.includes(` ${anchor} `);
  }

  /* The words of a request that are ruled out, and what each rules out:
     "not skinny", "without the hood", "but not a coat", "isn't black",
     "he hates logos". A garment named after "not really" is not ruled out
     but compared with: "a jacket that isn't really a jacket". Shared by
     the concept reader and the page's local reader, so the two cannot
     disagree about what was ruled out. */
  function negationsIn(tokens, mentions) {
    const out = { at: new Set(), garments: [], unsure: [], features: [], fits: [], colors: [], materials: [], shades: [], signals: [], properties: [], words: [] };
    for (let i = 0; i < tokens.length; i += 1) {
      let after = -1;
      if (NEGATORS.has(tokens[i])) after = i + 1;
      else if (NEGATOR_PAIRS.some(([a, b]) => tokens[i] === a && tokens[i + 1] === b)) after = i + 2;
      if (after === -1) continue;
      /* "no" as a whole answer, "not sure": nothing is ruled out */
      let j = after;
      let unsure = false;
      while (j < tokens.length && j < after + 5 && (PASS_NEGATED.has(tokens[j]) || keen(j) || oneWith(j))) { if (UNSURE.has(tokens[j])) unsure = true; j += 1; }
      const span = (to) => { for (let k = i; k <= to; k += 1) out.at.add(k); };
      /* "not huge or sloppy", "no logos or graphics": what one "not"
         rules out runs on through an "or" */
      while (j < tokens.length) {
        const end = ruleOut(j, unsure);
        if (end === -1) break;
        span(end);
        if ((tokens[end + 1] === 'or' || tokens[end + 1] === 'nor') && tokens[end + 2]) {
          /* "not too long or too heavy": the "too" again is passed over */
          j = end + 2;
          while (j < tokens.length - 1 && PASS_NEGATED.has(tokens[j])) j += 1;
        } else break;
      }
    }
    return out;

    /* "don't want one with a hood": the one is the garment wanted, and
       what it comes with is what is ruled out */
    function oneWith(j) {
      if (tokens[j] === 'one' || tokens[j] === 'ones') return tokens[j + 1] === 'with';
      return tokens[j] === 'with' && (tokens[j - 1] === 'one' || tokens[j - 1] === 'ones');
    }

    /* "into" before what is ruled out, and "big fan of" / "huge fan of" —
       but "huge" alone is a size: "not huge or sloppy" */
    function keen(j) {
      const word = tokens[j];
      if (!KEEN.has(word) || !tokens[j + 1]) return false;
      if (word === 'big' || word === 'huge') return tokens[j + 1] === 'fan';
      if (word === 'fan') return tokens[j + 1] === 'of';
      if (word === 'of') return tokens[j - 1] === 'fan';
      return true;
    }

    /* one ruled-out thing starting at j: where it ends, or -1 */
    function ruleOut(j, unsure) {
      const word = tokens[j];
      if (!word) return -1;
      const mention = mentions.find((m) => m.at === j);
      if (mention) {
        if (unsure) { out.unsure.push(mention.name); mention.unsure = true; }
        else { out.garments.push(mention.name); mention.ruledOut = true; }
        return mention.end - 1;
      }
      const material = MATERIAL_WORDS.find((m) => tokens.slice(j, j + m.split(' ').length).join(' ') === m);
      if (feature(word)) { out.features.push(word); return j; }
      if (Object.prototype.hasOwnProperty.call(NEGATED_FIT, word)) { out.fits.push(word); if (NEGATED_FIT[word]) out.signals.push(NEGATED_FIT[word]); return j; }
      if (SIZE_FIT[word]) { out.fits.push(SIZE_FIT[word]); return j; }
      if (Object.prototype.hasOwnProperty.call(NEGATED, word)) { out.signals.push(...NEGATED[word]); if (/^(heavy|bulky|thick)$/.test(word)) out.properties.push('lightweight'); return j; }
      if (/^(heavy|thick|bulky)$/.test(word)) { out.properties.push('lightweight'); return j; }
      if (COLOUR_WORDS.includes(word)) { out.colors.push(word); return j; }
      if (SHADES.has(word)) { out.shades.push(word); return j; }
      if (material) { out.materials.push(material); return j + material.split(' ').length - 1; }
      /* Anything else a listing could be titled with — "not ripped", "no
         florals", "not see through", "aren't chunky" — is ruled out as
         itself, and as what the page's own descriptors call it: "ripped"
         is distressed. Never searched for, and a listing that says it is
         ranked down or removed. */
      const two = tokens.slice(j, j + 2).join(' ');
      if (NEGATED_PHRASES[two]) { out.words.push(...NEGATED_PHRASES[two]); return j + 1; }
      if (!/^[a-z][a-z-]{2,}$/.test(word) || FILLER.has(word) || CONVERSATIONAL.has(word) || UNSHOPPABLE.has(word)
        || NOT_RULED.has(word) || GENDER_OF[word] || RECIPIENTS[word]) return -1;
      const single = word.length > 4 && /s$/.test(word) && !/ss$/.test(word) ? word.slice(0, -1) : word;
      const entry = DESCRIPTORS.find(([name, ws]) => name === word || name === single || ws.includes(word) || ws.includes(single));
      out.words.push(word, single, ...(entry ? [entry[0], ...entry[1].filter((w) => !w.includes(' '))] : []));
      return j;
    }
  }

  /* the positions of a name the request points at, after "like the ones
     in", "like in", "like what they wear in", "as seen on" */
  const CITE_LEAD = new Set(['like', 'as']);
  const CITE_WHAT = new Set(['ones', 'one', 'those', 'that', 'what', 'kind', 'type', 'style', 'seen', 'worn']);
  const CITE_WHO = new Set(['they', 'he', 'she', 'people', 'someone', 'everyone', 'wear', 'wears', 'wore', 'wearing', 'worn', 'had', 'has', 'have', 'got']);
  const CITE_IN = new Set(['in', 'from', 'on']);
  const CITE_END = new Set(['but', 'and', 'with', 'for', 'that', 'under', 'not', 'no', 'without']);
  function citedIn(tokens) {
    const at = new Set();
    for (let i = 0; i < tokens.length; i += 1) {
      if (!CITE_LEAD.has(tokens[i])) continue;
      let j = i + 1;
      if (tokens[j] === 'the') j += 1;
      const pointed = CITE_WHAT.has(tokens[j]);
      if (pointed) j += 1;
      while (j < tokens.length && CITE_WHO.has(tokens[j])) j += 1;
      if (!CITE_IN.has(tokens[j]) || !(pointed || j === i + 1)) continue;
      for (let k = j + 1; k < tokens.length && !CITE_END.has(tokens[k]); k += 1) at.add(k);
    }
    return at;
  }

  function mentionsIn(tokens) {
    const taken = new Array(tokens.length).fill(false);
    const mentions = [];
    for (const phrase of GARMENT_PHRASES) {
      const size = words(phrase.word).length;
      for (let at = 0; at + size <= tokens.length; at += 1) {
        if (taken.slice(at, at + size).some(Boolean)) continue;
        if (tokens.slice(at, at + size).join(' ') !== phrase.word) continue;
        for (let k = at; k < at + size; k += 1) taken[k] = true;
        mentions.push({ name: phrase.name, at, end: at + size });
      }
    }
    return mentions.sort((a, b) => a.at - b.at);
  }

  function readConcepts(query) {
    const plainText = normalize(query).text.replace(/[‐-―-]+/g, ' ').replace(/\bon top of\b/g, 'over').replace(/\s+/g, ' ').trim();
    if (!plainText) return null;
    let text = ` ${plainText} `;
    const consumed = new Set();
    const tokens = words(plainText);
    const markWords = (phrase) => words(phrase).forEach((w) => consumed.add(w));
    const phraseAt = (phrase) => {
      const own = words(phrase);
      for (let at = 0; at + own.length <= tokens.length; at += 1) if (tokens.slice(at, at + own.length).join(' ') === phrase) return at;
      return -1;
    };

    /* "like the ones in top gun", "like what they wear in friends": a
       name the shopper points at. Its words are not garments ("top") and
       are not searched ("gun"); what it means is the model's to say, and
       the reading says there was one */
    const cited = citedIn(tokens);
    /* the garments, where each stands, and what was ruled out */
    const mentions = mentionsIn(tokens).filter((m) => !cited.has(m.at));
    const ruled = negationsIn(tokens, mentions);
    let vague = ruled.at.size > 0 || cited.size > 0;

    const settingWords = new Set();
    for (const mention of mentions) {
      for (let k = mention.at; k < mention.end; k += 1) consumed.add(tokens[k]);
      if (mention.ruledOut) { mention.role = 'ruled-out'; continue; }
      if (mention.unsure) { mention.role = 'reference'; continue; }
      let back = mention.at - 1;
      /* "with my favourite black jeans": what stands between the garment
         and the word that says how it is named is passed over */
      while (back >= 0 && back >= mention.at - 5 && PASSED_OVER(tokens[back])) back -= 1;
      const before = tokens[back];
      mention.role = 'target';
      if (before && RELATION[before]) {
        mention.role = 'context';
        mention.relation = RELATION[before];
        /* "black" in "with black jeans" is the jeans' colour */
        for (let k = back + 1; k < mention.at; k += 1) settingWords.add(k);
      } else {
        for (const phrase of REFERENCE) {
          const start = back - phrase.length + 1;
          if (start < 0 || tokens.slice(start, back + 1).join(' ') !== phrase.join(' ')) continue;
          /* "between a shirt and a jacket", "a shirt and jacket thing":
             the second of a pair crosses with the first rather than
             being compared with it, and only when a pair is being read */
          if (phrase[0] === 'and' && !mentions.some((m) => m !== mention && m.end <= mention.at)) break;
          if (phrase[0] === 'and' && !/\bbetween\b|\bthing\b|\bhalf\b|\bcross\b|\bhybrid\b|\bmix\b/.test(text)) break;
          /* "i want like a jacket", "idk like a loose clean jacket": a
             "like" that only fills a pause compares nothing. It compares
             after "something", "looks", "feels", after another garment,
             or opening a request that goes on to say how it differs */
          if (phrase.length === 1 && phrase[0] === 'like') {
            const lead = tokens[start - 1];
            const afterGarment = mentions.some((m) => m.end === start);
            const opening = start === 0 && /\b(but|more|less|without|except)\b/.test(text);
            if (!(LIKE_LEADS.has(lead) || afterGarment || opening)) break;
          }
          mention.role = 'reference';
          break;
        }
      }
      if (THING.has(tokens[mention.end])) { mention.thing = true; vague = true; }
    }
    const unsureNames = new Set(mentions.filter((m) => m.unsure).map((m) => m.name));
    /* a garment named both as the thing and as the setting stays the
       thing; one the shopper doubts ("isn't really a jacket") is only
       compared with */
    const targets = unique(mentions.filter((m) => m.role === 'target').map((m) => m.name)).filter((n) => !unsureNames.has(n));
    const references = unique(mentions.filter((m) => m.role === 'reference').map((m) => m.name)).filter((n) => !targets.includes(n));
    const settings = mentions.filter((m) => m.role === 'context' && !targets.includes(m.name) && !references.includes(m.name));
    if (references.length || settings.length) vague = true;

    /* everything below reads the request with the settings and the
       ruled-out words taken out: "baggy" in "with my baggy jeans"
       describes the jeans, and "skinny" in "not skinny" describes nothing
       the shopper wants */
    const blanked = new Set([...settingWords, ...ruled.at, ...cited]);
    /* "fitted arms" is a sleeve, not a fit */
    tokens.forEach((token, at) => { if (BODY_PARTS.has(token) && at > 0 && FIT_WORD[tokens[at - 1]]) { blanked.add(at - 1); blanked.add(at); } });
    text = ` ${tokens.map((token, at) => (blanked.has(at) ? '|' : token)).join(' ')} `;

    const signals = [];
    const vagueSignals = new Set();
    const fit = [];
    /* the signals the request states, as opposed to ones read only off
       what it rules out: "not sloppy" leans polished, but "dressy" is not
       something the shopper said, and is never their whole search */
    const stated = new Set();
    const add = (signal, isVague, fromNot) => { if (!signals.includes(signal)) signals.push(signal); if (isVague) vagueSignals.add(signal); if (!fromNot) stated.add(signal); };
    /* "skinny jeans but not too tight", "loose but not too baggy": a fit
       the request asks for, and the same side of it not overdone. That
       softens the fit; it does not turn it into the other one */
    const CLOSE_FIT = new Set(['skinny', 'slim', 'fitted', 'tight', 'bodycon', 'clingy']);
    const LOOSE_FIT = new Set(['loose', 'baggy', 'oversized', 'relaxed', 'wide', 'roomy', 'slouchy']);
    const statedFits = tokens.filter((token, at) => !ruled.at.has(at));
    const saysClose = statedFits.some((t) => CLOSE_FIT.has(t));
    const saysLoose = statedFits.some((t) => LOOSE_FIT.has(t));
    const softened = new Set(ruled.fits.filter((f) => (saysClose && CLOSE_FIT.has(f)) || (saysLoose && LOOSE_FIT.has(f)))
      .flatMap((f) => [NEGATED_FIT[f]].concat(NEGATED[f] || [])).filter(Boolean));
    ruled.signals.filter((signal) => !softened.has(signal)).forEach((signal) => add(signal, true, true));
    if (ruled.features.some((f) => feature(f).signal)) ruled.features.forEach((f) => { if (feature(f).signal) add(feature(f).signal, true); });

    /* how it should look, which is not what it costs */
    for (const [phrase, signal] of LOOKS) {
      if (!new RegExp(`(^|\\s)${phrase}(?=\\s|$)`).test(text)) continue;
      add(signal, true);
      vague = true;
      markWords(phrase);
      text = text.replace(new RegExp(`(^|\\s)${phrase}(?=\\s|$)`, 'g'), '$1 ');
    }
    let occasion = null;
    for (const [phrase, said] of OCCASIONS) {
      if (occasion || !new RegExp(`(^|\\s)${phrase}(?=\\s|$)`).test(text)) continue;
      occasion = said;
      markWords(phrase);
    }
    const tribe = tokens.map((token) => TRIBES[token]).find(Boolean) || null;
    if (tribe) tokens.forEach((token) => { if (TRIBES[token]) consumed.add(token); });

    const properties = [];
    tokens.forEach((token, at) => {
      if (blanked.has(at) || !PROPERTY_WORDS[token]) return;
      /* "warm weather" is a season, "light blue" a colour */
      if (/^(weather|days|climate|season|temps|temperatures|wash)$/.test(tokens[at + 1] || '')) return;
      if (token === 'heavy' && tokens[at + 1] === 'weight') return;
      properties.push(PROPERTY_WORDS[token]);
      consumed.add(token);
      if (COMPARATIVE.has(token)) vague = true;
    });
    ruled.properties.forEach((p) => properties.push(p));
    if (properties.includes('warm')) add('warm', false);

    const entries = SIGNALS.flatMap(([signal, isVague, phrases]) => phrases.map((phrase) => ({ signal, isVague, phrase })))
      .sort((a, b) => b.phrase.length - a.phrase.length);
    const hit = new Set();
    for (const { signal, isVague, phrase } of entries) {
      const pattern = new RegExp(`(^|\\s)${phrase}(?=\\s|$)`);
      if (!pattern.test(text)) continue;
      /* "short sleeve" is a sleeve, not a short garment; "soft pink" is a colour */
      if (signal === 'short' && new RegExp(`\\b${phrase} sleeve`).test(text)) continue;
      if (phrase === 'soft' && new RegExp(`\\bsoft (${COLOUR_WORDS.join('|')})\\b`).test(text)) continue;
      add(signal, isVague);
      if (isVague) vague = true;
      if (signal === 'relaxed' || signal === 'fitted') fit.push(FIT_WORD[phrase] || phrase);
      markWords(phrase);
      hit.add(phrase);
    }
    /* each phrase read once, after every signal it carries is counted:
       "cleaner" is both polished and minimal */
    hit.forEach((phrase) => { text = text.replace(new RegExp(`(^|\\s)${phrase}(?=\\s|$)`, 'g'), '$1 '); });

    /* "oversized but fitted": a contradiction is not settled by picking
       one; neither is searched, and the ranking does not hold to either */
    const ambiguous = cited.size ? ['reference'] : [];
    const loose = fit.some((f) => /relaxed|oversized|baggy/.test(f));
    const close = fit.some((f) => /slim|skinny|bodycon/.test(f));
    if (loose && close) { ambiguous.push('fit'); fit.length = 0; }

    const colors = [];
    tokens.forEach((token, at) => {
      const colour = token === 'off' && tokens[at + 1] === 'white' ? 'off white' : token;
      if (!COLOUR_WORDS.includes(colour) || blanked.has(at)) return;
      /* "light grey", "dark green": the shade is part of the colour asked
         for, and is said with it */
      const shade = at > 0 && SHADES.has(tokens[at - 1]) && !blanked.has(at - 1) ? `${tokens[at - 1]} ` : '';
      const named = `${shade}${colour}`;
      if (colors.includes(named) || colors.includes(colour)) return;
      colors.push(named);
      markWords(named);
    });
    /* "black but not too dark": the colour stands, but it is not held to */
    if (colors.length && ruled.shades.length) ambiguous.push('colour');

    /* who it is for */
    let gender = null;
    tokens.forEach((token, at) => {
      if (GENDER_OF[token] && !gender) gender = GENDER_OF[token];
      if (!RECIPIENTS[token] || gender) return;
      const said = tokens.slice(Math.max(0, at - 2), at).join(' ');
      if (/\bfor( my| our)?$/.test(said) || /^(wants|needs|likes|loves|would|hates)$/.test(tokens[at + 1] || '')) gender = RECIPIENTS[token];
    });

    const named = targets.concat(references);
    const talking = tokens.some((token, at) => !blanked.has(at) && CONVERSATIONAL.has(token));
    if (talking || ruled.at.size || properties.length && tokens.some((t) => COMPARATIVE.has(t))) vague = true;
    if (!named.length && VAGUE_NOUN.test(text) && signals.length) vague = true;
    if (!vague) return null;

    /* ---- the concepts ---- */
    let mode = null;
    let anchor = null;
    let alternatives = [];
    let avoid = [];
    let style;
    const fits = (entry) => entry.signals.every((sig) => signals.includes(sig))
      /* a rule is about how a thing was DESCRIBED: "casual" or "minimal"
         said in so many words is a shop word to search, not a reason to
         swap the garment */
      && !entry.signals.every((sig) => SHOP_STYLE.has(sig) && !vagueSignals.has(sig));
    const described = (garment) => DESCRIBED.filter((entry) => entry.anchor === garment && fits(entry))
      .sort((a, b) => b.signals.length - a.signals.length)[0];
    const property = properties[0] || null;
    const propertyRule = (garment) => (property ? PROPERTIES.find((rule) => rule.property === property && (rule.anchor ? rule.anchor.includes(garment) : !garment)) : null);
    const featureOut = ruled.features.map(feature).find((f) => f.becomes);

    const hybrid = named.length >= 2 && (references.length || mentions.some((m) => m.thing) || /\bbetween\b|\bhalf\b|\bcross\b|\bhybrid\b/.test(text))
      ? HYBRIDS.find((entry) => entry.pair.every((g) => named.includes(g)))
      : null;

    if (hybrid) {
      mode = 'hybrid';
      anchor = targets[0] || references[0];
      alternatives = hybrid.concepts.slice();
      avoid = (hybrid.avoid || []).slice();
    } else if (named.length) {
      /* "a jacket like a bomber": the jacket is only the family, and the
         bomber is what it is being compared with */
      const narrowed = targets.length && references.length && FAMILY[targets[0]] === FAMILY[references[0]];
      const uncertain = !targets.length || narrowed || mentions.some((m) => m.thing && m.role === 'target');
      anchor = narrowed ? references[0] : targets[0] || references[0];
      mode = uncertain ? 'comparative' : 'described';
      const entry = described(anchor);
      const byProperty = propertyRule(anchor);
      if (featureOut && (!featureOut.garment || featureOut.garment === anchor || !targets.length)) {
        /* "a hoodie without the hood" is a sweatshirt; what was ruled out
           is no longer the garment, even as a comparison */
        alternatives = featureOut.becomes.slice();
        if (featureOut.garment === anchor) { mode = 'comparative'; anchor = null; }
      } else if (byProperty) {
        alternatives = byProperty.concepts.slice();
      } else if (property && property !== 'warm') {
        alternatives = [`${property} ${anchor}`];
      } else if (entry) {
        alternatives = entry.concepts.slice();
        avoid = (entry.avoid || []).slice();
        /* an entry may say "no style word": its concepts already carry it */
        style = 'style' in entry ? entry.style : undefined;
      } else if ((!targets.length || narrowed) && NEIGHBOURS[anchor]) {
        alternatives = NEIGHBOURS[anchor].slice();
      }
      for (const setting of settings) {
        const rule = SETTINGS.find((one) => one.relation === setting.relation && one.anchor === anchor
          && (one.garment ? one.garment.includes(setting.name) : one.family === FAMILY[setting.name]));
        if (rule) alternatives = alternatives.concat(rule.concepts);
      }
      if (alternatives.length) {
        /* the garment asked for stays a concept: a minimal hoodie answers
           "like a hoodie but cleaner", only after what it was compared to */
        if (anchor && !alternatives.includes(anchor)) alternatives.push(anchor);
        /* a request that NAMES its garment is held to it: what is a kind of
           that garment comes first, everything else after */
        if (mode === 'described') {
          alternatives = alternatives.filter((name) => kindOf(name, anchor)).concat(alternatives.filter((name) => !kindOf(name, anchor)));
        }
      } else if (!settings.length) {
        /* nothing known about this garment described this way: it is
           searched as what it says, with the talking taken out */
        mode = 'plain';
      }
    } else if (settings.length) {
      mode = 'context';
      const setting = settings[0];
      const rule = SETTINGS.find((one) => !one.anchor && one.garment && one.relation === setting.relation && one.garment.includes(setting.name))
        || SETTINGS.find((one) => !one.anchor && !one.garment && one.relation === setting.relation && one.family === FAMILY[setting.name] && (!one.signal || signals.includes(one.signal)));
      if (rule) { alternatives = rule.concepts.slice(); if ('style' in rule) style = rule.style; }
    } else {
      mode = 'open';
      const byProperty = propertyRule(null);
      const rule = byProperty || OPEN.find((one) => signals.includes(one.signal));
      /* "something nice for dinner": no garment, and no signal that
         points at one. It is searched as what it says, with no garment,
         colour or shoe added to it. */
      if (rule) {
        alternatives = rule.concepts.slice();
        if ('style' in rule) style = rule.style;
      } else {
        mode = 'plain';
      }
    }
    if (style === undefined) {
      const signal = signals.find((sig) => STYLE_WORD[sig]);
      style = signal ? STYLE_WORD[signal] : null;
    }
    if (tribe && !style) style = tribe;

    /* what is left of the request that a search engine could still use:
       "dinner", "festival", a word nothing above knows */
    const extra = [];
    tokens.forEach((token, at) => {
      if (blanked.has(at) || consumed.has(token) || FILLER.has(token) || CONVERSATIONAL.has(token) || UNSHOPPABLE.has(token)) return;
      if (GENDER_OF[token] || RECIPIENTS[token] || DESCRIPTOR_WORDS.has(token)) return;
      if (token.length < 3 || /\d/.test(token) || token.includes('$')) return;
      if (!extra.includes(token)) extra.push(token);
    });

    /* A plain reading: the request as said, with the talking, the ruled
       out and the settings taken out, shop words for the rest ("heavier"
       is heavyweight, "skaters" is skater style), and the garment last:
       "i want a shirt thats kinda oversized" is "oversized shirt". */
    let terms = [];
    if (mode === 'plain') {
      const garmentAt = new Set(mentions.filter((m) => m.role === 'target' || m.role === 'reference').flatMap((m) => Array.from({ length: m.end - m.at }, (x, k) => m.at + k)));
      const kept = [];
      const garmentWords = [];
      const occasionAt = occasion ? OCCASIONS.filter(([, said]) => said === occasion).map(([phrase]) => phraseAt(phrase)).find((at) => at !== -1) : -1;
      /* "long sleeve", "wide leg", "high waisted" are one thing each */
      const joined = new Map();
      DESCRIPTORS.forEach(([name, ws]) => ws.filter((w) => w.includes(' ')).forEach((w) => {
        const at = phraseAt(w);
        if (at !== -1 && !blanked.has(at)) joined.set(at, { term: name, size: w.split(' ').length });
      }));
      let skipTo = -1;
      tokens.forEach((token, at) => {
        if (at < skipTo) return;
        if (joined.has(at)) { kept.push(joined.get(at).term); skipTo = at + joined.get(at).size; return; }
        if (blanked.has(at)) return;
        if (garmentAt.has(at)) { garmentWords.push(token); return; }
        if (at === occasionAt) { kept.push(occasion); return; }
        if (TRIBES[token]) { kept.push(TRIBES[token]); return; }
        if (PROPERTY_WORDS[token] && properties.length) { kept.push(PROPERTY_WORDS[token]); return; }
        if (FILLER.has(token) && !COLOUR_WORDS.includes(token) && !FIT_WORD[token]) return;
        if (CONVERSATIONAL.has(token) || UNSHOPPABLE.has(token) || GENDER_OF[token] || RECIPIENTS[token]) return;
        if (consumed.has(token) && !COLOUR_WORDS.includes(token) && !FIT_WORD[token] && !hit.has(token) && !DESCRIPTOR_WORDS.has(token)) return;
        if (hit.has(token) && !SIGNALS.some(([, isVague, phrases]) => !isVague && phrases.includes(token)) && !/^(comfy|comfortable|cozy|cosy|soft|simple|plain|basic|casual|cute|warm|elegant|dressy|classy|elevated)$/.test(token)) return;
        if (/\d/.test(token) || token.includes('$') || token.length < 2) return;
        /* "oversized but fitted": neither side of a contradiction is searched */
        if (ambiguous.includes('fit') && FIT_WORD[token]) return;
        kept.push(token);
      });
      ruled.properties.forEach((p) => kept.push(p));
      /* all talk and nothing to search ("something like what my mom
         wears"): the reading says so, and the search is as broad as the
         request — never the talk itself, which would find mom jeans */
      const lead = signals.find((sig) => STYLE_WORD[sig] && stated.has(sig));
      if (!garmentWords.length && lead && !kept.includes(STYLE_WORD[lead])) kept.unshift(STYLE_WORD[lead]);
      /* with no garment at all, the search stays on clothes: an occasion
         is dressed for with an outfit, but a style is worn as clothing —
         "skater style outfit" finds costumes, and a style word on its own
         ("minimal") is read by a shop as anything at all */
      if (!garmentWords.length && occasion) kept.push('outfit');
      else if (!garmentWords.length && (tribe || (kept.length && kept.every((term) => Object.values(STYLE_WORD).includes(term))))) kept.push('clothing');
      terms = unique(kept.concat(garmentWords)).slice(0, 10);
      anchor = targets[0] || null;
    }

    alternatives = unique(alternatives.map(concept)).slice(0, 6);
    /* what goes into the search phrase: for a request that named its
       garment, only the kinds of it — "a hoodie but cleaner" is searched
       as a hoodie, and a quarter-zip only ranks — and for any other, the
       strongest concepts */
    const search = mode === 'described'
      ? alternatives.filter((name) => kindOf(name, anchor)).slice(0, 3)
      : alternatives.slice(0, 3);

    /* what a listing must not be, in the words a listing would use */
    const ruledOutGarments = unique(ruled.garments.concat(featureOut && featureOut.garment ? [featureOut.garment] : []));
    const without = unique([
      ...ruledOutGarments.flatMap((g) => RULED_OUT_AS[g] || (GARMENTS.find(([n]) => n === g) || [null, [g]])[1].filter((w) => !w.includes(' '))),
      ...ruled.features.flatMap((f) => feature(f).without),
      ...ruled.fits.map((f) => (f === 'tight' ? 'tight' : f)),
      ...ruled.colors,
      ...ruled.materials.flatMap((m) => RULED_OUT_AS[m] || [m]),
      ...ruled.words
    ]);

    return {
      mode,
      anchor,
      alternatives,
      search,
      signals,
      fit: unique(fit).slice(0, 3),
      style,
      context: unique(settings.map((m) => m.name)),
      /* how each setting was named, in the same order: worn "with",
         "over" or "under" it */
      relations: unique(settings.map((m) => m.name)).map((name) => settings.find((m) => m.name === name).relation),
      /* the words that describe a setting rather than the thing wanted:
         "my baggy black jeans". Nothing downstream may take a colour, a
         fit or a descriptor from them. */
      beside: unique(settings.flatMap((m) => tokens.slice(m.at, m.end))
        .concat([...settingWords].map((at) => tokens[at]))
        .filter((word) => !DETERMINER.has(word))),
      avoid: unique(avoid.map(concept)),
      colors,
      extra: extra.slice(0, 3),
      /* what the request rules out: the garments, and every word a listing
         that is one of them, or has the feature, fit, colour or material
         ruled out, would carry */
      excluded: ruledOutGarments,
      without,
      /* the words that make a listing BE what was ruled out — a coat for
         "not a coat", a hoodie for "without the hood" — as opposed to
         only having a fit or colour that was: those are ranked down,
         these are removed */
      drop: unique(ruledOutGarments.flatMap((g) => RULED_OUT_AS[g] || (GARMENTS.find(([n]) => n === g) || [null, [g]])[1].filter((w) => !w.includes(' ')))),
      properties: unique(properties),
      occasion,
      gender,
      ambiguous,
      /* a plain reading's own search words, in order */
      terms
    };
  }

  /* ---------- what the page says it is looking for ----------

     While a search runs, the page says in plain words what Fynd took the
     request to mean: "Looking for black oversized hoodies under $80",
     "Looking for cozy sweaters, sweatshirts or cardigans to wear with
     jeans". It is read off the reading itself — the preferences the
     search is about to be sent with — so it can only ever say what was
     understood, never more: no field it does not have, no count of shops,
     nothing about how the search is carried out. A garment named only as
     the setting is said as the setting ("to wear with jeans"), never as
     the thing being looked for.

     null when the reading holds nothing worth saying ("something nice for
     dinner" names no garment, colour or budget): the page then says only
     what it is doing, not what it understood. */

  const ALREADY_PLURAL = new Set(['jeans', 'trousers', 'pants', 'shorts', 'leggings', 'sneakers', 'chinos', 'sweatpants', 'joggers', 'boots', 'heels', 'sandals', 'loafers', 'trainers', 'slacks']);
  /* how a concept reads in a sentence: "quarter zip pullover" is what a
     shop titles it, "quarter-zip" is what a person says */
  const SAID_AS = {
    'quarter zip pullover': 'quarter-zip', 'wide leg trousers': 'wide-leg trousers', 'wide leg pants': 'wide-leg pants',
    'top handle bag': 'top-handle bag', 'zip up hoodie': 'zip-up hoodie', 'zip up sweatshirt': 'zip-up sweatshirt',
    'pull on trousers': 'pull-on trousers', 'low top sneakers': 'low-top sneakers', 'mock neck tee': 'mock-neck tee',
    'straight leg pants': 'straight-leg pants', 'long sleeve tee': 'long-sleeve tee', 'vintage style': 'vintage-style'
  };
  const SAID_COLOUR = new Set(COLOUR_WORDS);
  const STYLE_SAID = ['vintage', 'retro', 'minimal', 'minimalist', 'casual'];
  const FIT_SAID = ['oversized', 'loose', 'baggy', 'relaxed', 'slim', 'fitted', 'skinny', 'cropped'];
  const QUALIFIER_SAID = [['quarter zip', 'quarter-zip'], ['half zip', 'half-zip'], ['zip up', 'zip-up'], ['crew neck', 'crew-neck'], ['crewneck', 'crewneck']];

  /* the garment in the shopper's own word: "pants" rather than the
     trousers it is filed as, "pullovers" rather than sweaters */
  function garmentSaid(name, spaced) {
    const entry = GARMENTS.find(([one]) => one === name);
    const words = entry ? entry[1] : [name];
    const word = words.slice().sort((a, b) => b.length - a.length).find((w) => spaced.includes(` ${w} `));
    if (!word) return plural(name);
    const shown = word === 't shirt' ? 't-shirt' : word === 't shirts' ? 't-shirts' : word;
    const last = word.split(' ').pop();
    const alreadyMany = ALREADY_PLURAL.has(last)
      || (/es$/.test(word) && words.includes(word.slice(0, -2)))
      || (/s$/.test(word) && words.includes(word.slice(0, -1)));
    return alreadyMany ? shown : plural(shown);
  }

  function plural(phrase) {
    const words = String(phrase).split(' ');
    const last = words.pop();
    let many = last;
    if (ALREADY_PLURAL.has(last)) many = last;
    else if (/(s|x|z|ch|sh)$/.test(last)) many = `${last}es`;
    else if (/[^aeiou]y$/.test(last)) many = `${last.slice(0, -1)}ies`;
    else if (/f$/.test(last)) many = `${last.slice(0, -1)}ves`;
    else many = `${last}s`;
    return words.concat(many).join(' ');
  }

  /* "a", "a or b", "a, b or c" */
  const either = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`);

  function priceSaid(prefs) {
    const money = (n) => `$${Number.isInteger(n) ? n : Number(n).toFixed(2)}`;
    if (prefs.minPrice && prefs.maxPrice) return `between ${money(prefs.minPrice)} and ${money(prefs.maxPrice)}`;
    if (prefs.maxPrice) return `under ${money(prefs.maxPrice)}`;
    if (prefs.minPrice) return `over ${money(prefs.minPrice)}`;
    return '';
  }

  function genderSaid(gender) {
    const g = String(gender || '').toLowerCase();
    if (/\bwom[ae]n|\bladies|\bgirls/.test(g)) return 'women\u2019s';
    if (/\bm[ae]n\b|\bmens\b|\bmen\u2019s|\bmen's|\bboys|\bguys/.test(g)) return 'men\u2019s';
    return '';
  }

  /* the concepts as one phrase: "wide-leg, relaxed or pleated trousers"
     when they share a garment, "overshirts, shirt jackets or chore
     jackets" when they do not */
  const COMPOUNDS = /\b(straight|wide|long|short|zip|pull|low|mock|top|crew|v|high|quarter|half) (leg|sleeve|up|on|top|neck|handle|waisted|zip)\b/g;
  const hyphenate = (phrase) => String(phrase).replace(COMPOUNDS, '$1-$2').replace(/\b(vintage|skater) style\b/g, '$1-style');
  const OCCASION_SAID = { 'going out': 'for going out', 'date night': 'for a date night', 'wedding guest': 'for a wedding', office: 'for work', workout: 'for working out', vacation: 'for a vacation' };

  function conceptsSaid(given) {
    /* the bare garment adds nothing beside kinds of it: not "tailored
       trousers or trousers" */
    const names = given.length > 1 ? given.filter((name) => !given.some((other) => other !== name && other.endsWith(` ${name}`))) : given;
    const said = names.map((name) => hyphenate(SAID_AS[name] || name));
    const heads = said.map((one) => one.split(' ').pop());
    if (said.length > 1 && heads.every((head) => head === heads[0])) {
      const kinds = unique(said.map((one) => one.split(' ').slice(0, -1).join(' ')).filter(Boolean));
      return kinds.length ? `${either(kinds)} ${plural(heads[0])}` : plural(heads[0]);
    }
    return either(said.map(plural));
  }

  function describe(prefs, query) {
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    const c = p.concepts && typeof p.concepts === 'object' ? p.concepts : null;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
    const text = ` ${String(query || '').toLowerCase().replace(/[^a-z0-9$\s-]+/g, ' ').replace(/\s+/g, ' ')} `;
    const spaced = text.replace(/-/g, ' ');
    const beside = new Set(c ? list(c.beside) : []);
    const inQuery = (word) => text.includes(` ${word} `) && !beside.has(word);

    /* colour in the shopper's own words where the reading has a colour */
    const colours = c && list(c.colors).length
      ? list(c.colors)
      : (list(p.colors).length ? COLOUR_WORDS.filter(inQuery) : []);
    const ownColours = colours.length ? colours
      : list(p.colors).map((x) => x.toLowerCase()).filter((x) => SAID_COLOUR.has(x) && !beside.has(x));

    const parts = [];
    const gender = genderSaid(p.gender);
    if (gender) parts.push(gender);
    parts.push(...ownColours);

    let thing;
    if (c && c.mode === 'plain') {
      /* a plain reading says what it will search, in the shopper's own
         words, with the garment — if there is one — said as many */
      const occasions = list(c.terms).filter((t) => OCCASION_SAID[t]);
      const terms = list(c.terms).filter((t) => t !== 'outfit' && !OCCASION_SAID[t]);
      if (!terms.length && !occasions.length && !priceSaid(p)) return null;
      const last = terms[terms.length - 1];
      const garment = last && (GARMENTS.some(([, ws]) => ws.includes(last)) || EXTRA_ANCHORS.some(([, ws]) => ws.includes(last)));
      const shown = terms.map((t) => hyphenate(SAID_AS[t] || t.replace(/-/g, ' ')));
      if (garment) shown[shown.length - 1] = garmentSaid(GARMENT_NAME[last] || last, ` ${last} `);
      if (last === 'gift') shown[shown.length - 1] = 'gifts';
      parts.splice(0);
      if (genderSaid(p.gender || c.gender)) parts.push(genderSaid(p.gender || c.gender));
      parts.push(...shown.filter((t) => !parts.includes(t)));
      thing = garment || last === 'gift' ? '' : 'pieces';
      if (occasions.length) thing = `${thing ? `${thing} ` : ''}${OCCASION_SAID[occasions[0]]}`.trim();
    } else if (c && list(c.alternatives).length) {
      const names = list(c.search).length ? list(c.search) : list(c.alternatives).slice(0, 3);
      thing = conceptsSaid(names);
      const style = c.style ? hyphenate(SAID_AS[c.style] || c.style) : '';
      if (style && !thing.includes(style)) parts.push(style);
      list(c.fit).forEach((word) => { if (!thing.includes(word)) parts.push(word); });
    } else {
      /* what it is like, in the order the shopper said it: "loose black
         pants", "black oversized hoodies" */
      const modifiers = [];
      parts.splice(gender ? 1 : 0);
      ownColours.forEach((word) => modifiers.push(word));
      FIT_SAID.filter(inQuery).forEach((word) => modifiers.push(word));
      if (!FIT_SAID.some(inQuery)) list(p.fits).map((x) => x.toLowerCase()).filter((x) => x !== 'regular').forEach((word) => modifiers.push(word));
      STYLE_SAID.filter(inQuery).forEach((word) => modifiers.push(word));
      list(p.brands).forEach((word) => modifiers.push(word));
      list(p.descriptors).filter((d) => !beside.has(d)).forEach((d) => modifiers.push(d));
      QUALIFIER_SAID.filter(([words]) => spaced.includes(` ${words} `)).forEach(([, shown]) => modifiers.push(shown));
      const at = (word) => { const i = spaced.indexOf(` ${word.toLowerCase().replace(/-/g, ' ')} `); return i === -1 ? Infinity : i; };
      unique(modifiers).map((word, order) => ({ word, order, where: at(word) }))
        .sort((a, b) => (a.where - b.where) || (a.order - b.order))
        .forEach(({ word }) => parts.push(word));
      const garments = list(p.garments);
      if (garments.length) {
        thing = either(garments.slice(0, 2).map((g) => garmentSaid(g, spaced)));
      } else {
        const anchor = EXTRA_ANCHORS.find(([, words]) => words.some(inQuery));
        thing = anchor ? plural(anchor[0]) : '';
      }
    }

    const price = priceSaid(p);
    if (!thing && !(c && c.mode === 'plain' && parts.length)) {
      /* nothing about WHAT: only say what is known about it, if anything */
      if (!parts.length && !price) return null;
      thing = 'pieces';
    }
    let sentence = `Looking for ${unique(parts).concat(thing ? [thing] : []).join(' ')}`;
    if (price) sentence += ` ${price}`;
    if (c && list(c.context).length) {
      const relations = list(c.relations);
      const settings = list(c.context).map((name, at) => `to wear ${relations[at] || 'with'} ${plural(name)}`);
      sentence += ` ${settings.join(' and ')}`;
    }
    /* and what was ruled out, said as ruled out — never as wanted */
    if (c) {
      const without = list(c.without);
      const hood = without.includes('hood');
      const not = list(c.excluded).filter((g) => !(hood && g === 'hoodie')).map(plural)
        .concat(without.filter((w) => /^(skinny|slim|tight|baggy|loose|oversized|cropped|fitted|bodycon)$/.test(w)))
        .concat(without.filter((w) => COLOUR_WORDS.includes(w)))
        .concat(without.filter((w) => /^(leather|wool|polyester|denim|silk|satin|linen|cotton|fleece|suede|velvet|nylon|fur)$/.test(w)));
      const lacking = (hood ? ['hoods'] : []).concat(without.includes('logo') ? ['logos'] : [])
        .concat(without.includes('sleeve') ? ['sleeves'] : []).concat(without.includes('zip') ? ['zips'] : []);
      if (not.length) sentence += `, not ${either(unique(not))}`;
      if (lacking.length) sentence += `${not.length ? ' and' : ','} without ${either(unique(lacking))}`;
    }
    return sentence;
  }

  /* each word a garment is said with, to the garment it names */
  const GARMENT_NAME = Object.fromEntries(GARMENTS.flatMap(([name, ws]) => ws.map((w) => [w, name])));

  /* The garments a request is ABOUT: the ones it names, less the ones it
     names only as what they are worn with ("with jeans"), which are not
     what the shopper is buying. With no concepts, exactly readGarments. */
  function garmentsWanted(query) {
    /* read as normalised — "hoddie" is a hoodie — which for a request in
       shop words changes nothing at all */
    let read = readGarments(normalize(query).text);
    const concepts = readConcepts(query);
    /* "jackets like the ones in top gun": the top of top gun is a name,
       not a garment wanted */
    if (concepts && concepts.ambiguous.includes('reference')) {
      const tokens = words(normalize(query).text.replace(/[\u2010-\u2015-]+/g, ' ').replace(/\bon top of\b/g, 'over').replace(/\s+/g, ' ').trim());
      const cited = citedIn(tokens);
      read = readGarments(tokens.filter((token, at) => !cited.has(at)).join(' '));
    }
    const notWanted = concepts ? concepts.context.concat(concepts.excluded || []) : [];
    /* "baggy jeans but not ripped": ripped is read as distressed, and was
       ruled out — it describes nothing the shopper wants */
    if (concepts && concepts.without.length) read.descriptors = read.descriptors.filter((d) => !concepts.without.includes(d));
    if (!concepts || !notWanted.length) return Object.assign(read, { concepts });
    const keep = read.garments.filter((g) => !notWanted.includes(g));
    const categories = [];
    GARMENTS.forEach(([name, , cats]) => { if (keep.includes(name)) cats.forEach((c) => { if (!categories.includes(c)) categories.push(c); }); });
    return { garments: keep, descriptors: read.descriptors, categories, concepts };
  }

  /* words a shopper is likely to use, mapped onto whatever vocabulary the
     catalogue actually holds. Only used by the local fallback: the served
     interpreter is given the vocabulary and does this far better. */
  const HINTS = {
    fits: {
      Relaxed: ['loose', 'relaxed', 'baggy', 'roomy', 'slouchy'],
      Oversized: ['oversized', 'oversize', 'boxy'],
      Slim: ['slim', 'fitted', 'tight', 'skinny', 'tailored'],
      Regular: ['regular', 'standard', 'classic fit']
    },
    occasions: {
      Work: ['work', 'office', 'interview', 'business', 'professional', 'smart'],
      Everyday: ['school', 'everyday', 'daily', 'casual', 'class', 'errands'],
      Evening: ['evening', 'night out', 'dinner', 'party', 'date', 'formal'],
      Weekend: ['weekend', 'brunch', 'travel', 'holiday'],
      Active: ['gym', 'running', 'workout', 'training', 'sport', 'athletic']
    },
    colors: {
      Black: ['black'],
      White: ['white', 'ivory', 'cream'],
      Neutral: ['neutral', 'beige', 'tan', 'grey', 'gray', 'stone', 'oatmeal', 'taupe'],
      /* not "denim": a denim jacket is a cloth, and comes in black */
      Blue: ['blue', 'navy', 'indigo'],
      Green: ['green', 'olive', 'sage', 'khaki'],
      Earth: ['earth', 'brown', 'rust', 'camel', 'chocolate'],
      Pastel: ['pastel', 'pink', 'lilac', 'lavender', 'baby blue'],
      Bright: ['bright', 'red', 'orange', 'yellow', 'neon', 'vivid']
    },
    categories: {
      /* a "top" is as often a blouse or a wrap top as a tee */
      shirt: ['shirt', 'button-up', 'button up', 'button-down', 'oxford', 'blouse', 'top'],
      tee: ['tee', 't-shirt', 'tshirt', 'top'],
      knit: ['knit', 'sweater', 'jumper', 'hoodie', 'sweatshirt', 'cardigan'],
      jacket: ['jacket', 'blazer', 'bomber', 'puffer'],
      coat: ['coat', 'overcoat', 'parka'],
      dress: ['dress', 'gown'],
      trousers: ['trousers', 'pants', 'jeans', 'chinos', 'slacks', 'sweatpants', 'joggers'],
      skirt: ['skirt'],
      shorts: ['shorts'],
      sneaker: ['sneaker', 'sneakers', 'trainers', 'shoes']
    },
    seasons: ['spring', 'summer', 'fall', 'autumn', 'winter'],
    genders: ['women', 'womens', "women's", 'men', 'mens', "men's", 'unisex', 'girls', 'boys']
  };

  const has = (text, word) => new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(text);

  /* keeps only values the catalogue can actually match */
  const keepKnown = (values, allowed) => {
    if (!allowed || !allowed.length) return values;
    const lower = allowed.map((a) => a.toLowerCase());
    return values.filter((v) => lower.includes(String(v).toLowerCase()));
  };

  function localInterpret(query, vocabulary) {
    const text = ' ' + String(query).toLowerCase() + ' ';
    const prefs = EMPTY();
    const vocab = vocabulary || {};

    /* what the shopper ruled out is not what they asked for: "not too
       formal" is not an evening occasion, "nothing tight" is not a slim
       fit, and "isn't black" is not black. Read from the same plain form
       and the same negation reader the concepts are. */
    const plain = normalize(query).text;
    const plainTokens = words(plain.replace(/[\u2010-\u2015-]+/g, ' '));
    const ruledOut = negationsIn(plainTokens, mentionsIn(plainTokens)).at;
    const asked = ` ${plainTokens.filter((token, at) => !ruledOut.has(at)).join(' ')} `;
    const collect = (group, target, within) => {
      Object.keys(group).forEach((value) => {
        if (group[value].some((word) => has(within || asked, word))) target.push(value);
      });
    };
    collect(HINTS.fits, prefs.fits);
    collect(HINTS.occasions, prefs.occasions);
    const read = garmentsWanted(query);
    /* the colour of what it is worn with is not the colour asked for:
       "a belt that goes with brown boots" is not a brown belt */
    const beside = new Set(read.concepts ? read.concepts.beside : []);
    collect(HINTS.colors, prefs.colors, ` ${plainTokens.filter((token, at) => !ruledOut.has(at) && !beside.has(token)).join(' ')} `);
    prefs.garments = read.garments;
    prefs.descriptors = read.descriptors;
    prefs.categories = read.categories;
    prefs.concepts = read.concepts;

    /* budget: "under $50", "below 80", "$50", "less than 120" */
    const under = text.match(/(?:under|below|less than|max|up to|cheaper than)\s*\$?\s*(\d+(?:\.\d+)?)/);
    const bare = text.match(/\$\s*(\d+(?:\.\d+)?)/);
    if (under) prefs.maxPrice = Number(under[1]);
    else if (bare) prefs.maxPrice = Number(bare[1]);

    const between = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:-|to)\s*\$?\s*(\d+(?:\.\d+)?)/);
    if (between) {
      prefs.minPrice = Number(between[1]);
      prefs.maxPrice = Number(between[2]);
    }

    /* brands the catalogue carries, matched by name — as a whole word:
       "AE" is not in "aesthetic" */
    (vocab.brands || []).forEach((brand) => {
      if (has(text, String(brand).toLowerCase())) prefs.brands.push(brand);
    });

    HINTS.seasons.forEach((s) => { if (has(text, s)) prefs.season = s; });
    /* read from the plain form, so "wmns" and "womans" say who it is for */
    HINTS.genders.forEach((g) => { if (has(` ${plain} `, g) && !prefs.gender) prefs.gender = g; });

    /* the words as typed, or as corrected when a word was corrected */
    const corrected = normalize(query).changed.length ? plain : String(query);
    prefs.keywords = corrected.toLowerCase()
      .replace(/[^a-z0-9\s$-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    prefs.colors = keepKnown(prefs.colors, vocab.colors);
    prefs.occasions = keepKnown(prefs.occasions, vocab.occasions);
    prefs.fits = keepKnown(prefs.fits, vocab.fits);
    return prefs;
  }

  /* merges whatever the server returned into a complete, safe shape */
  function shape(raw) {
    const prefs = EMPTY();
    if (!raw || typeof raw !== 'object') return prefs;
    ['categories', 'colors', 'occasions', 'fits', 'brands', 'styles', 'garments', 'descriptors', 'keywords'].forEach((key) => {
      const v = raw[key];
      if (Array.isArray(v)) prefs[key] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
      else if (typeof v === 'string' && v.trim()) prefs[key] = v.split(/\s*,\s*/).filter(Boolean);
    });
    ['maxPrice', 'minPrice'].forEach((key) => {
      const n = Number(raw[key]);
      prefs[key] = Number.isFinite(n) && n > 0 ? n : null;
    });
    ['season', 'gender'].forEach((key) => {
      prefs[key] = typeof raw[key] === 'string' && raw[key].trim() ? raw[key].trim() : null;
    });
    /* passed on as it came, strings only; /api/search shapes it again */
    const c = raw.concepts;
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const concepts = {};
      Object.keys(c).forEach((key) => {
        const v = c[key];
        if (Array.isArray(v)) concepts[key] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
        else if (typeof v === 'string') concepts[key] = v.trim() || null;
        else if (v === null) concepts[key] = null;
      });
      prefs.concepts = concepts;
    }
    return prefs;
  }

  /* why a request could not be read by the AI, in words the interface can
     show without dressing a keyword match up as something it is not */
  const FALLBACK_REASON = {
    'not-configured': 'The AI interpreter is deployed but has no OpenAI key set, so this request was read by a basic local keyword match instead.',
    unreachable: 'The AI interpreter could not be reached, so this request was read by a basic local keyword match instead.',
    'no-endpoint': 'No AI interpreter is connected to this site, so this request was read by a basic local keyword match instead.',
    'bad-reply': 'The AI interpreter returned something unusable, so this request was read by a basic local keyword match instead.',
    /* the endpoint answered 429: this request was inside the plan's
       allowance yesterday and is outside it now. The page still returns
       results, read locally, and says which of the two it was. */
    'over-limit': 'You have used your AI allowance for now, so this request was read by a basic local keyword match instead.'
  };

  async function interpret(query, vocabulary) {
    const text = String(query || '').trim();
    if (!text) return { preferences: EMPTY(), source: 'empty', reason: null, notice: null };

    const local = (reason) => ({
      preferences: localInterpret(text, vocabulary),
      source: 'local',
      reason,
      notice: FALLBACK_REASON[reason] || FALLBACK_REASON.unreachable
    });

    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      response = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* carries the session cookie, so the endpoint meters this
           request against the plan the shopper actually has rather than
           against an anonymous free allowance. Nothing about the plan
           is sent from here — only the cookie, which the server reads. */
        credentials: 'include',
        body: JSON.stringify({ query: text, vocabulary: vocabulary || {} }),
        signal: controller.signal
      });
      clearTimeout(timer);
    } catch (err) {
      /* nothing answered: no function deployed, offline, or timed out */
      return local('no-endpoint');
    }

    if (response.status === 404) return local('no-endpoint');
    if (response.status === 503) return local('not-configured');
    if (response.status === 429) {
      /* Out of AI allowance. The local parser is free, so the search
         still runs — but it is reported as the local read it is, with
         the usage the server sent so the page can say when it resets. */
      const spent = await response.json().catch(() => ({}));
      return Object.assign(local('over-limit'), { usage: spent.usage || null, upgrade: Boolean(spent.upgrade) });
    }
    if (!response.ok) return local('unreachable');

    try {
      const data = await response.json();
      if (!data || !data.preferences) return local('bad-reply');
      return {
        preferences: shape(data.preferences),
        source: 'openai',
        reason: null,
        notice: null,
        usage: data.usage || null
      };
    } catch (err) {
      return local('bad-reply');
    }
  }

  /* The words the local parser knows, handed out read-only so the page
     can mark them in the search field as they are typed. Marking is all
     it is used for: nothing here changes what a search sends or how the
     served interpreter reads it. */
  /* every shop term the concept tables can search for: what a garment
     is called on a listing, for the server to recognise one when a
     model names it (api/_reading.js) */
  const CONCEPT_TERMS = [...new Set([]
    .concat(...DESCRIBED.map((d) => d.concepts || []))
    .concat(...Object.values(NEIGHBOURS))
    .concat(...HYBRIDS.map((h) => h.concepts || []))
    .concat(...SETTINGS.map((s) => s.concepts || []))
    .concat(...OPEN.map((o) => o.concepts || [])))];
  const lexicon = Object.freeze({ GARMENTS, DESCRIPTORS, HINTS, EXTRA_ANCHORS, COLOUR_WORDS, CONCEPT_TERMS });

  global.Interpreter = { interpret, localInterpret, readGarments, readConcepts, garmentsWanted, normalize, describe, shape, EMPTY, endpoint, FALLBACK_REASON, lexicon };
})(typeof window !== 'undefined' ? window : globalThis);
