/* =========================================================
   FindWear — request interpretation (client side)

   Sends what the shopper typed to /api/interpret, which calls OpenAI
   server-side so the API key never reaches the browser.

   If that endpoint is absent or unconfigured — a plain static host has no
   server — the same request is interpreted locally instead, so the page
   still returns results rather than an error. The local reading is
   deliberately simple; the served endpoint is the real one.
   ========================================================= */

(function (global) {
  'use strict';

  const ENDPOINT = '/api/interpret';
  const REQUEST_TIMEOUT = 12000;

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

  async function interpret(query, vocabulary) {
    const text = String(query || '').trim();
    if (!text) return { preferences: EMPTY(), source: 'empty' };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text, vocabulary: vocabulary || {} }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (response.ok) {
        const data = await response.json();
        if (data && data.preferences) {
          return { preferences: shape(data.preferences), source: 'openai' };
        }
      }
    } catch (err) {
      /* no endpoint, offline, or it timed out — read it here instead */
    }
    return { preferences: localInterpret(text, vocabulary), source: 'local' };
  }

  global.Interpreter = { interpret, localInterpret, shape, EMPTY };
})(typeof window !== 'undefined' ? window : globalThis);
