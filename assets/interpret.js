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
    maxPrice: null, minPrice: null, season: null, gender: null, keywords: []
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

    const collect = (group, target, within) => {
      Object.keys(group).forEach((value) => {
        if (group[value].some((word) => has(within || text, word))) target.push(value);
      });
    };
    collect(HINTS.fits, prefs.fits);
    collect(HINTS.occasions, prefs.occasions);
    collect(HINTS.colors, prefs.colors);
    const read = readGarments(query);
    prefs.garments = read.garments;
    prefs.descriptors = read.descriptors;
    prefs.categories = read.categories;

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

  global.Interpreter = { interpret, localInterpret, readGarments, shape, EMPTY, endpoint, FALLBACK_REASON };
})(typeof window !== 'undefined' ? window : globalThis);
