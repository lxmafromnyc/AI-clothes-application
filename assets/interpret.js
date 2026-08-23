/* =========================================================
   FindWear — request interpretation (client side)

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
    maxPrice: null, minPrice: null, season: null, gender: null, keywords: []
  });

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
      shirt: ['shirt', 'button-up', 'button up', 'button-down', 'oxford', 'blouse'],
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

    const collect = (group, target) => {
      Object.keys(group).forEach((value) => {
        if (group[value].some((word) => has(text, word))) target.push(value);
      });
    };
    collect(HINTS.fits, prefs.fits);
    collect(HINTS.occasions, prefs.occasions);
    collect(HINTS.colors, prefs.colors);
    collect(HINTS.categories, prefs.categories);

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
    ['categories', 'colors', 'occasions', 'fits', 'brands', 'styles', 'keywords'].forEach((key) => {
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
    'over-limit': 'Your AI token allowance is used up, so this request was read by a basic local keyword match instead.'
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
        /* the account's credential travels with the request, because the
           tokens this spends are metered against it */
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          (global.Usage && global.Usage.authHeaders) ? global.Usage.authHeaders() : {}
        ),
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

    /* The AI token allowance is gone. The local parser still reads the
       request, so the shopper is not stopped dead — but the reply says
       plainly that this was a keyword match, never that it was the AI. */
    if (response.status === 429) {
      const limit = await response.json().catch(() => null);
      if (limit && global.Usage) global.Usage.refresh();
      const fallback = local('over-limit');
      if (limit) {
        fallback.limit = limit;
        if (global.Usage) fallback.notice = `${global.Usage.limitMessage(limit)} This request was read by a basic local keyword match instead.`;
      }
      return fallback;
    }

    if (!response.ok) return local('unreachable');

    try {
      const data = await response.json();
      if (!data || !data.preferences) return local('bad-reply');
      /* the meter travels with the answer, so the page updates without a
         second round trip */
      if (data.usage && global.Usage) global.Usage.absorb(data.usage);
      return { preferences: shape(data.preferences), source: 'openai', reason: null, notice: null };
    } catch (err) {
      return local('bad-reply');
    }
  }

  global.Interpreter = { interpret, localInterpret, shape, EMPTY, endpoint, FALLBACK_REASON };
})(typeof window !== 'undefined' ? window : globalThis);
