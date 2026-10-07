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
    ['scarf', ['scarf', 'scarves']]
  ];

  const FAMILY = {
    hoodie: 'top', sweatshirt: 'top', cardigan: 'top', sweater: 'top', 't-shirt': 'top', 'tank top': 'top',
    polo: 'top', blouse: 'top', shirt: 'top', top: 'top',
    blazer: 'outer', puffer: 'outer', bomber: 'outer', jacket: 'outer', 'trench coat': 'outer', parka: 'outer', coat: 'outer',
    dress: 'dress',
    skirt: 'bottom', jeans: 'bottom', chinos: 'bottom', sweatpants: 'bottom', leggings: 'bottom', trousers: 'bottom', shorts: 'bottom',
    sneakers: 'shoe', boots: 'shoe', heels: 'shoe', sandals: 'shoe', loafers: 'shoe',
    bag: 'accessory', hat: 'accessory', scarf: 'accessory'
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
    { anchor: 'trousers', signals: ['relaxed', 'polished'], concepts: ['wide leg trousers', 'relaxed trousers', 'pleated trousers'], style: null },
    { anchor: 'trousers', signals: ['relaxed'], concepts: ['wide leg trousers', 'relaxed trousers'], style: null },
    { anchor: 'trousers', signals: ['polished'], concepts: ['tailored trousers', 'pleated trousers'], style: null },
    { anchor: 'trousers', signals: ['cozy'], concepts: ['lounge pants', 'knit pants', 'sweatpants'], style: 'cozy' },
    { anchor: 'shorts', signals: ['polished'], concepts: ['tailored shorts', 'pleated shorts'], style: null },
    { anchor: 'dress', signals: ['minimal', 'casual'], concepts: ['shift dress', 't-shirt dress', 'shirt dress'], style: 'casual', avoid: ['gown', 'sequin dress', 'cocktail dress'] },
    { anchor: 'dress', signals: ['casual'], concepts: ['t-shirt dress', 'shirt dress', 'knit dress'], style: 'casual', avoid: ['gown', 'sequin dress', 'cocktail dress'] },
    { anchor: 'dress', signals: ['minimal'], concepts: ['shift dress', 'column dress', 'slip dress'], style: 'simple' },
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
    jacket: ['overshirt', 'light jacket'],
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
    { relation: 'over', family: 'top', concepts: ['overshirt', 'shirt jacket', 'cardigan', 'light jacket'] },
    { relation: 'over', family: 'dress', concepts: ['cardigan', 'cropped jacket', 'shrug'] },
    { relation: 'under', family: 'outer', concepts: ['knit top', 'fitted tee'] },
    { relation: 'under', family: 'top', concepts: ['fitted tee', 'tank top'] },
    { relation: 'with', family: 'bottom', signal: 'cozy', concepts: ['sweater', 'sweatshirt', 'cardigan'], style: 'cozy' },
    { relation: 'with', family: 'bottom', signal: 'polished', concepts: ['blouse', 'knit top', 'button down shirt'] },
    { relation: 'with', family: 'bottom', concepts: ['top', 'sweater', 'shirt'] },
    { relation: 'with', family: 'top', concepts: ['trousers', 'jeans', 'skirt'] },
    { relation: 'with', family: 'dress', concepts: ['cardigan', 'cropped jacket'] }
  ];

  /* A request that names no garment at all, only a signal. Only the
     signals that point at a kind of garment by themselves are here:
     "cozy" is knitwear and fleece far more often than not. "Nice",
     "polished" and "casual" point at nothing in particular, so they get
     no garment — the request stays as broad as it was asked. */
  const OPEN = [
    { signal: 'cozy', concepts: ['sweater', 'sweatshirt', 'cardigan'], style: 'cozy' }
  ];

  /* What the garment should be like. `vague` marks the words that say
     the shopper is describing rather than naming — a shop never titles
     anything "cleaner" or "comfy" — and only those make a request
     descriptive. "Vintage", "minimal", "loose" and "casual" are words a
     shop does use, so on their own they leave the request on the path
     it always took. Longest phrase first, so "looks vintage" is read
     before "vintage". */
  const SIGNALS = [
    ['polished', true, ['look nice', 'looks nice', 'look good', 'looks good', 'put together', 'grown up', 'more polished', 'polished', 'nicer', 'nice', 'elevated', 'dressier', 'dressy', 'smarter', 'refined', 'classy', 'classier', 'sharper', 'sophisticated', 'elegant', 'fancier', 'more formal', 'less sloppy']],
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
    formal: ['casual'], dressy: ['casual'], fancy: ['casual'], stuffy: ['casual'], fussy: ['casual'],
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
  const STYLE_WORD = { polished: 'dressy', minimal: 'minimal', cozy: 'cozy', casual: 'casual', vintage: 'vintage style' };

  const COLOUR_WORDS = ['off white', 'black', 'white', 'cream', 'ivory', 'beige', 'tan', 'camel', 'brown', 'chocolate', 'khaki', 'olive', 'green', 'sage', 'navy', 'blue', 'grey', 'gray', 'charcoal', 'red', 'burgundy', 'maroon', 'pink', 'purple', 'lilac', 'lavender', 'yellow', 'orange', 'rust', 'gold', 'silver'];

  /* the words of a request that carry nothing a search engine could use */
  const FILLER = new Set(('a an the and or but that thats this those these it its i im ive me my mine you your we us our for to of in on at by from with over under into onto as is are was be been being can could would should will want wanna need needs looking look looks like kind sort kinda sorta something anything thing things stuff item items piece pieces people person wear wearing worn go goes going get got find show some any more less much very really too so just not no also maybe perhaps similar type vibe vibes ish one ones what which who where when how they them their there here have has had do does did feel feels still yet bit little lot pretty quite other else own put together way kinda lowkey honestly please help idea ideas sth outfit outfits fit fits wardrobe clothes clothing everyone everybody usually always often around about than then them those guys girls folks underneath beneath alongside match matches matching pair dollars dollar bucks usd budget price under below above over up to max least between and').split(' '));
  const VAGUE_NOUN = /\b(something|anything|thing|things|stuff|item|piece|outfit|whatever|sth)\b/;
  const THING = new Set(['thing', 'things', 'piece', 'style', 'type', 'vibe', 'situation']);
  const DETERMINER = new Set(['a', 'an', 'the', 'my', 'your', 'his', 'her', 'their', 'our', 'some', 'one', 'of', 'those', 'these', 'them', 'it', 'nice', 'regular', 'normal', 'plain', 'basic', 'simple', 'classic']);
  const ADJECTIVES = new Set(['favorite', 'favourite', 'fav', 'old', 'new', 'dark', 'light', 'wash', 'washed', 'high', 'rise', 'waisted', 'leg', 'mom', 'dad', 'ripped', 'straight', 'wide', 'skinny', 'baggy', 'loose', 'cropped', 'long', 'short', 'denim', 'white', 'black', 'blue', 'grey', 'gray', 'navy', 'cream', 'beige', 'brown', 'tan', 'khaki', 'olive', 'green', 'red', 'pink']);
  const PASSED_OVER = (token) => DETERMINER.has(token) || ADJECTIVES.has(token);
  const RELATION = { with: 'with', match: 'with', matches: 'with', matching: 'with', alongside: 'with', pair: 'with', over: 'over', under: 'under', underneath: 'under', beneath: 'under' };
  const REFERENCE = [['kind', 'of', 'like'], ['sort', 'of', 'like'], ['similar', 'to'], ['like'], ['resembles'], ['resembling'], ['alternative', 'to'], ['instead', 'of'], ['version', 'of'], ['between'], ['and']];
  const GENDER_WORDS = new Set(['men', 'mens', 'man', 'women', 'womens', 'woman', 'ladies', 'lady', 'unisex', 'girls', 'boys', 'guy', 'guys']);

  const GARMENT_PHRASES = [
    ...GARMENTS.flatMap(([name, words]) => words.map((word) => ({ word, name }))),
    ...EXTRA_ANCHORS.flatMap(([name, words]) => words.map((word) => ({ word, name })))
  ].sort((a, b) => b.word.split(' ').length - a.word.split(' ').length || b.word.length - a.word.length);

  const DESCRIPTOR_WORDS = new Set(DESCRIPTORS.flatMap(([name, words]) => [name, ...words]).flatMap((w) => w.split(/[\s-]+/)));

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

  function readConcepts(query) {
    let text = ` ${String(query || '').toLowerCase()
      .replace(/\b1\s*\/\s*4\b/g, 'quarter').replace(/\b1\s*\/\s*2\b/g, 'half')
      .replace(/[‘’']/g, '')
      .replace(/[‐-―-]+/g, ' ')
      .replace(/[^a-z0-9$\s]+/g, ' ')
      .replace(/\bon top of\b/g, 'over')
      .replace(/\s+/g, ' ')
      .trim()} `;
    if (!text.trim()) return null;
    const consumed = new Set();
    const tokens = words(text);
    const markWords = (phrase) => words(phrase).forEach((w) => consumed.add(w));

    /* the garments, where each stands, and how each is named */
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
    mentions.sort((a, b) => a.at - b.at);

    let vague = false;
    const settingWords = new Set();
    for (const mention of mentions) {
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
          mention.role = 'reference';
          break;
        }
      }
      if (THING.has(tokens[mention.end])) { mention.thing = true; vague = true; }
      for (let k = mention.at; k < mention.end; k += 1) consumed.add(tokens[k]);
    }
    /* a garment named both as the thing and as the setting stays the thing */
    const targets = unique(mentions.filter((m) => m.role === 'target').map((m) => m.name));
    const references = unique(mentions.filter((m) => m.role === 'reference').map((m) => m.name)).filter((n) => !targets.includes(n));
    const settings = mentions.filter((m) => m.role === 'context' && !targets.includes(m.name) && !references.includes(m.name));
    if (references.length || settings.length) vague = true;

    /* what it should be like — read with the settings taken out, since
       "baggy" in "with my baggy jeans" describes the jeans */
    if (settingWords.size) text = ` ${tokens.map((token, at) => (settingWords.has(at) ? '|' : token)).join(' ')} `;
    /* the ruled-out first, then the rest */
    const signals = [];
    const fit = [];
    const add = (signal) => { if (!signals.includes(signal)) signals.push(signal); };
    text = text.replace(NEGATION, (whole, intensifiers, word) => {
      if (!Object.prototype.hasOwnProperty.call(NEGATED, word)) return whole;
      NEGATED[word].forEach(add);
      if (NEGATED[word].length) vague = true;
      markWords(whole);
      return ' ';
    });
    const entries = SIGNALS.flatMap(([signal, isVague, phrases]) => phrases.map((phrase) => ({ signal, isVague, phrase })))
      .sort((a, b) => b.phrase.length - a.phrase.length);
    const hit = new Set();
    for (const { signal, isVague, phrase } of entries) {
      const pattern = new RegExp(`(^|\\s)${phrase}(?=\\s|$)`);
      if (!pattern.test(text)) continue;
      /* "short sleeve" is a sleeve, not a short garment; "soft pink" is a colour */
      if (signal === 'short' && new RegExp(`\\b${phrase} sleeve`).test(text)) continue;
      if (phrase === 'soft' && new RegExp(`\\bsoft (${COLOUR_WORDS.join('|')})\\b`).test(text)) continue;
      add(signal);
      if (isVague) vague = true;
      if (signal === 'relaxed' || signal === 'fitted') fit.push(FIT_WORD[phrase] || phrase);
      markWords(phrase);
      hit.add(phrase);
    }
    /* each phrase read once, after every signal it carries is counted:
       "cleaner" is both polished and minimal */
    hit.forEach((phrase) => { text = text.replace(new RegExp(`(^|\\s)${phrase}(?=\\s|$)`, 'g'), '$1 '); });

    const colors = [];
    tokens.forEach((token, at) => {
      const colour = token === 'off' && tokens[at + 1] === 'white' ? 'off white' : token;
      if (!COLOUR_WORDS.includes(colour) || settingWords.has(at) || colors.includes(colour)) return;
      colors.push(colour);
      markWords(colour);
    });

    const named = targets.concat(references);
    if (!named.length && VAGUE_NOUN.test(text) && signals.length) vague = true;
    if (!vague) return null;

    /* ---- the concepts ---- */
    let mode = null;
    let anchor = null;
    let alternatives = [];
    let avoid = [];
    let style;
    const fits = (entry) => entry.signals.every((s) => signals.includes(s));
    const described = (garment) => DESCRIBED.filter((entry) => entry.anchor === garment && fits(entry))
      .sort((a, b) => b.signals.length - a.signals.length)[0];

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
      if (entry) {
        alternatives = entry.concepts.slice();
        avoid = (entry.avoid || []).slice();
        /* an entry may say "no style word": its concepts already carry it */
        style = 'style' in entry ? entry.style : undefined;
      } else if ((!targets.length || narrowed) && NEIGHBOURS[anchor]) {
        alternatives = NEIGHBOURS[anchor].slice();
      }
      for (const setting of settings) {
        const rule = SETTINGS.find((one) => one.relation === setting.relation && one.family === FAMILY[setting.name] && one.anchor === anchor);
        if (rule) alternatives = alternatives.concat(rule.concepts);
      }
      /* Nothing known about this garment described this way, and nothing
         worn with it to take out of the search: there is no concept to
         offer, so the request goes the way it always went rather than
         being rewritten on a guess. */
      if (!alternatives.length && !settings.length) return null;
      /* the garment asked for stays a concept: a minimal hoodie answers
         "like a hoodie but cleaner", only after what it was compared to */
      if (!alternatives.includes(anchor)) alternatives.push(anchor);
      /* a request that NAMES its garment is held to it: what is a kind of
         that garment comes first, everything else after */
      if (mode === 'described') {
        alternatives = alternatives.filter((name) => kindOf(name, anchor)).concat(alternatives.filter((name) => !kindOf(name, anchor)));
      }
    } else if (settings.length) {
      mode = 'context';
      const setting = settings[0];
      const rule = SETTINGS.find((one) => !one.anchor && one.relation === setting.relation && one.family === FAMILY[setting.name] && (!one.signal || signals.includes(one.signal)));
      if (rule) { alternatives = rule.concepts.slice(); if ('style' in rule) style = rule.style; }
    } else {
      mode = 'open';
      const rule = OPEN.find((one) => signals.includes(one.signal));
      /* "something nice for dinner": no garment, and no signal that
         points at one. Broad was what was asked, so broad is what is
         searched — the request goes the way it always went, with no
         garment, colour or occasion added to it. */
      if (!rule) return null;
      alternatives = rule.concepts.slice();
      if ('style' in rule) style = rule.style;
    }
    if (style === undefined) {
      const signal = signals.find((s) => STYLE_WORD[s]);
      style = signal ? STYLE_WORD[signal] : null;
    }

    /* what is left of the request that a search engine could still use:
       "dinner", "festival", a word nothing above knows */
    const extra = [];
    tokens.forEach((token, at) => {
      if (settingWords.has(at) || consumed.has(token) || FILLER.has(token) || GENDER_WORDS.has(token) || DESCRIPTOR_WORDS.has(token)) return;
      if (token.length < 3 || /\d/.test(token) || token.includes('$')) return;
      if (!extra.includes(token)) extra.push(token);
    });

    alternatives = unique(alternatives.map(concept)).slice(0, 6);
    /* what goes into the search phrase: for a request that named its
       garment, only the kinds of it — "a hoodie but cleaner" is searched
       as a hoodie, and a quarter-zip only ranks — and for any other, the
       strongest concepts */
    const search = mode === 'described'
      ? alternatives.filter((name) => kindOf(name, anchor)).slice(0, 3)
      : alternatives.slice(0, 3);

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
      extra: extra.slice(0, 3)
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
  function conceptsSaid(names) {
    const said = names.map((name) => SAID_AS[name] || name);
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
    if (c && list(c.alternatives).length) {
      const names = list(c.search).length ? list(c.search) : list(c.alternatives).slice(0, 3);
      thing = conceptsSaid(names);
      const style = c.style ? (SAID_AS[c.style] || c.style) : '';
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
    if (!thing) {
      /* nothing about WHAT: only say what is known about it, if anything */
      if (!parts.length && !price) return null;
      thing = 'pieces';
    }
    let sentence = `Looking for ${unique(parts).concat(thing).join(' ')}`;
    if (price) sentence += ` ${price}`;
    if (c && list(c.context).length) {
      const relations = list(c.relations);
      const settings = list(c.context).map((name, at) => `to wear ${relations[at] || 'with'} ${plural(name)}`);
      sentence += ` ${settings.join(' and ')}`;
    }
    return sentence;
  }

  /* The garments a request is ABOUT: the ones it names, less the ones it
     names only as what they are worn with ("with jeans"), which are not
     what the shopper is buying. With no concepts, exactly readGarments. */
  function garmentsWanted(query) {
    const read = readGarments(query);
    const concepts = readConcepts(query);
    if (!concepts || !concepts.context.length) return Object.assign(read, { concepts });
    const keep = read.garments.filter((g) => !concepts.context.includes(g));
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
      Blue: ['blue', 'navy', 'denim', 'indigo'],
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
       formal" is not an evening occasion, and "nothing tight" is not a
       slim fit */
    const asked = text.replace(NEGATION, (whole, intensifiers, word) => (Object.prototype.hasOwnProperty.call(NEGATED, word) ? ' ' : whole));
    const collect = (group, target, within) => {
      Object.keys(group).forEach((value) => {
        if (group[value].some((word) => has(within || asked, word))) target.push(value);
      });
    };
    collect(HINTS.fits, prefs.fits);
    collect(HINTS.occasions, prefs.occasions);
    collect(HINTS.colors, prefs.colors);
    const read = garmentsWanted(query);
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

    /* brands the catalogue carries, matched by name */
    (vocab.brands || []).forEach((brand) => {
      if (text.includes(String(brand).toLowerCase())) prefs.brands.push(brand);
    });

    HINTS.seasons.forEach((s) => { if (has(text, s)) prefs.season = s; });
    HINTS.genders.forEach((g) => { if (has(text, g) && !prefs.gender) prefs.gender = g; });

    prefs.keywords = String(query).toLowerCase()
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
  const lexicon = Object.freeze({ GARMENTS, DESCRIPTORS, HINTS, EXTRA_ANCHORS, COLOUR_WORDS });

  global.Interpreter = { interpret, localInterpret, readGarments, readConcepts, garmentsWanted, describe, shape, EMPTY, endpoint, FALLBACK_REASON, lexicon };
})(typeof window !== 'undefined' ? window : globalThis);
