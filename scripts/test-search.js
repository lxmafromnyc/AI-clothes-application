#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue search tests

   The real assets/products.js, assets/interpret.js and assets/catalog.js,
   run the way a page runs them, reading requests the way the page reads
   them when no AI interpreter answers and ranking the verified catalogue
   with the function the page ranks it with. scripts/bench-search.js
   drives the same path through a real browser; this is its fast,
   dependency-free floor.

   Usage: node scripts/test-search.js
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const context = { console, URL };
context.window = context;
vm.createContext(context);
for (const file of ['products.js', 'interpret.js', 'catalog.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, 'assets', file), 'utf8'), context, { filename: file });
}
vm.runInContext('this.__rows = DEMO_PRODUCTS;', context);
const { Products, Interpreter } = context;
const catalogue = Products.normalizeAll(context.__rows);
const { QUERIES, BRAND_QUERIES } = require('./bench-search.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); } catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`); }
}

/* what the page does: read the request against the catalogue's own
   vocabulary, rank the catalogue, show eight */
function vocabulary() {
  return {
    categories: [...new Set(catalogue.map((p) => p.category))],
    colors: [...new Set(catalogue.flatMap((p) => p.colors))],
    occasions: [...new Set(catalogue.flatMap((p) => p.occasions))],
    fits: [...new Set(catalogue.flatMap((p) => p.fits))],
    brands: [...new Set(catalogue.map((p) => p.brand))],
    styles: [...new Set(catalogue.flatMap((p) => p.styles))]
  };
}
const VOCAB = vocabulary();
const search = (query) => Products.rank(catalogue, Interpreter.localInterpret(query, VOCAB)).slice(0, 8);
const names = (list) => list.map((one) => one.name);
const idOf = (row) => row.id.replace(/^sample-/, '');
const rankOf = (query, id) => search(query).findIndex((one) => idOf(one) === id) + 1;

console.log('\n  — descriptors decide between garments of one kind\n');

test('"cropped puffer jacket" is the cropped puffer, not the cheaper cropped track jacket', () => {
  const shown = names(search('cropped puffer jacket'));
  assert.strictEqual(shown[0], 'Cropped Puffer', shown.join(' | '));
  assert.ok(shown.indexOf('Cropped Track Jacket') > 0);
});

test('a full match on the request’s own words is not capped level with a bare category match', () => {
  /* two jackets that both match "jacket": the one the words describe wins,
     whatever the price */
  const prefs = Object.assign(Interpreter.EMPTY(), { categories: ['jacket'], keywords: ['double', 'breasted', 'blazer'] });
  const blazer = { name: 'Double Breasted Blazer', brand: 'A', category: 'jacket', price: 500, colors: [], occasions: [], fits: [], styles: [] };
  const cheap = { name: 'Washed Denim Jacket', brand: 'B', category: 'jacket', price: 20, colors: [], occasions: [], fits: [], styles: [] };
  const ranked = Products.rank([cheap, blazer], prefs);
  assert.deepStrictEqual(names(ranked), ['Double Breasted Blazer', 'Washed Denim Jacket']);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('pleated, midi, chinos and double-breasted are all kept', () => {
  assert.strictEqual(search("women's pleated midi skirt")[0].name, 'Pleated Midi Skirt');
  assert.strictEqual(search('stretchy chinos for commuting')[0].name, "Men's VentureStretch Commuter Chinos");
  assert.strictEqual(search('double breasted blazer')[0].name, 'Double Breasted Blazer');
});

console.log('\n  — what the local interpreter reads\n');

test('a t-shirt is a tee, not a tee and a shirt', () => {
  const read = Interpreter.localInterpret('white boxy t-shirt', VOCAB);
  assert.deepStrictEqual([...read.categories], ['tee']);
  assert.deepStrictEqual([...Interpreter.localInterpret('heavyweight pocket tshirt', VOCAB).categories], ['tee']);
  /* and a shirt is still a shirt */
  assert.deepStrictEqual([...Interpreter.localInterpret('white oxford shirt', VOCAB).categories], ['shirt']);
});

test('a top may be a shirt-cut top as well as a tee', () => {
  assert.deepStrictEqual([...Interpreter.localInterpret('tencel wrap top', VOCAB).categories].sort(), ['shirt', 'tee']);
  assert.strictEqual(search('tencel wrap top')[0].name, 'Tencel Wrap Top');
});

console.log('\n  — garments and descriptors, as the shopper said them\n');

const readOf = (query) => {
  const read = Interpreter.localInterpret(query, VOCAB);
  return { garments: [...read.garments], descriptors: [...read.descriptors], categories: [...read.categories] };
};

test('each garment is read as itself, with its descriptors, and filed where the catalogue files it', () => {
  const expected = {
    'green oversized hoodie': { garments: ['hoodie'], descriptors: [], categories: ['knit'] },
    'fleece sweatpants': { garments: ['sweatpants'], descriptors: ['fleece'], categories: ['trousers'] },
    "women's pleated midi skirt": { garments: ['skirt'], descriptors: ['pleated', 'midi'], categories: ['skirt'] },
    'cropped puffer jacket': { garments: ['puffer'], descriptors: ['cropped'], categories: ['jacket'] },
    'double breasted blazer': { garments: ['blazer'], descriptors: ['double-breasted'], categories: ['jacket'] },
    'colour block knit sweater': { garments: ['sweater'], descriptors: ['colour block'], categories: ['knit'] }
  };
  for (const [query, want] of Object.entries(expected)) assert.deepStrictEqual(readOf(query), want, query);
});

test('a "puffy jacket" is read as the puffer it is, and filed as a jacket', () => {
  assert.deepStrictEqual(readOf('short puffy jacket').garments, ['puffer']);
  assert.deepStrictEqual(readOf('short puffy jacket').categories, ['jacket']);
});

test('spellings and hyphenations of one descriptor are one descriptor', () => {
  for (const query of ['double-breasted blazer', 'Double Breasted Blazer']) assert.deepStrictEqual(readOf(query).descriptors, ['double-breasted'], query);
  for (const query of ['color block sweater', 'colour-block sweater', 'colorblock sweater']) assert.deepStrictEqual(readOf(query).descriptors, ['colour block'], query);
  for (const query of ['wide leg trousers', 'wide-leg trousers']) assert.deepStrictEqual(readOf(query).descriptors, ['wide-leg'], query);
  assert.deepStrictEqual(readOf('crewneck jumper'), { garments: ['sweater'], descriptors: ['crew neck'], categories: ['knit'] });
});

test('the longest garment wins, and is not read twice', () => {
  assert.deepStrictEqual(readOf('grey sweatpants').garments, ['sweatpants'], 'the "pants" inside sweatpants is not a second garment');
  assert.deepStrictEqual(readOf('track pants').garments, ['sweatpants']);
  assert.deepStrictEqual(readOf('black puffer jacket').garments, ['puffer'], 'a puffer jacket is one puffer, not also a jacket');
  assert.deepStrictEqual(readOf('navy polo shirt').garments, ['polo']);
  assert.deepStrictEqual(readOf('white t-shirt').garments, ['t-shirt']);
  assert.deepStrictEqual(readOf('hooded sweatshirt').garments, ['hoodie']);
});

test('"knit" and "oxford" describe a garment beside one, and are the garment alone', () => {
  assert.deepStrictEqual(readOf('brown ribbed knit skirt'), { garments: ['skirt'], descriptors: ['ribbed', 'knit'], categories: ['skirt'] });
  assert.deepStrictEqual(readOf('merino knit'), { garments: ['sweater'], descriptors: ['merino'], categories: ['knit'] });
  assert.deepStrictEqual(readOf('white oxford shirt'), { garments: ['shirt'], descriptors: ['oxford'], categories: ['shirt'] });
  assert.deepStrictEqual(readOf('white oxford'), { garments: ['shirt'], descriptors: [], categories: ['shirt'] });
});

test('a request that names no garment names none, and a server reply without them carries empty lists', () => {
  assert.deepStrictEqual(readOf('something for a wedding under $200'), { garments: [], descriptors: [], categories: [] });
  const shaped = Interpreter.shape({ categories: ['knit'], keywords: ['hoodie'] });
  assert.strictEqual(shaped.garments.length, 0);
  assert.strictEqual(shaped.descriptors.length, 0);
  assert.deepStrictEqual([...Interpreter.shape({ garments: ['hoodie'], descriptors: ['cropped'] }).garments], ['hoodie']);
});

console.log('\n  — what the live search is asked\n');

const { queryFrom } = require('../api/_providers/query');
const { shapeIntent } = require('../api/search');
const cache = require('../api/_cache');
/* the local read, through /api/search's own whitelist, into the phrase
   every provider adapter asks */
const askedFor = (query) => queryFrom(shapeIntent(JSON.parse(JSON.stringify(Interpreter.localInterpret(query, VOCAB)))));

test('a garment the shopper named is asked for by name, not by the catalogue’s filing', () => {
  assert.strictEqual(askedFor('green oversized hoodie'), 'green oversized hoodie');
  assert.ok(!/\bknit\b/.test(askedFor('green oversized hoodie')));
  assert.strictEqual(askedFor('double breasted blazer'), 'double-breasted blazer');
  assert.strictEqual(askedFor('cropped puffer jacket'), 'cropped puffer jacket');
  assert.strictEqual(askedFor("women's pleated midi skirt"), 'women pleated midi skirt');
});

test('a catalogue colour family is not sent in place of the shopper’s own colour', () => {
  const asked = askedFor('brown ribbed knit skirt');
  assert.ok(!/\bearth\b/.test(asked), asked);
  assert.ok(/\bbrown\b/.test(asked), asked);
  /* a real colour word is sent as it always was */
  assert.ok(/\bblack\b/.test(askedFor('black wide leg trousers')));
  /* and an intent with no words of the shopper's own keeps its family */
  assert.strictEqual(queryFrom({ colors: ['Earth'], categories: ['skirt'] }), 'earth skirt');
});

test('an intent without garments is asked exactly as before', () => {
  assert.strictEqual(queryFrom({ gender: 'women', colors: ['black'], fits: ['oversized'], brands: ['nike'], categories: ['hoodie'] }), 'women black oversized nike hoodie');
  for (const name of ['serpapi', 'serper', 'openwebninja']) {
    assert.strictEqual(require(`../api/_providers/${name}`).queryFrom, queryFrom, `${name} asks its own question`);
  }
});

test('garments and descriptors pass /api/search’s whitelist and key its cache', () => {
  const shaped = shapeIntent({ garments: ['hoodie', 7], descriptors: ['cropped'], smuggled: 'x' });
  assert.deepStrictEqual(shaped.garments, ['hoodie']);
  assert.deepStrictEqual(shaped.descriptors, ['cropped']);
  assert.strictEqual(shaped.smuggled, undefined);
  const key = (intent) => cache.searchKey({ provider: 'serper', limit: 12, intent: shapeIntent(intent) });
  assert.notStrictEqual(key({ categories: ['jacket'], garments: ['puffer'] }), key({ categories: ['jacket'], garments: ['blazer'] }));
});

console.log('\n  — brands, ties and nothing\n');

test('a brand the shopper names is weighed once, and cannot outrank the garment', () => {
  const shown = names(search('coveworks wide leg trousers'));
  assert.strictEqual(shown[0], 'Wide Leg Trouser', shown.join(' | '));
  assert.ok(shown.indexOf('Cargo Utility Pant') > 0, 'the brand’s other trousers are still shown, below');
});

test('ties keep the lower price first, and the same request always gives the same order', () => {
  const prefs = Object.assign(Interpreter.EMPTY(), { categories: ['trousers'] });
  const first = names(Products.rank(catalogue, prefs));
  assert.deepStrictEqual(names(Products.rank(catalogue, prefs)), first);
  const trousers = Products.rank(catalogue, prefs);
  for (let i = 1; i < trousers.length; i += 1) {
    if (trousers[i].score === trousers[i - 1].score) assert.ok((trousers[i - 1].price ?? Infinity) <= (trousers[i].price ?? Infinity));
  }
});

test('a request the catalogue answers nothing of shows nothing', () => {
  assert.strictEqual(search('swimsuit').length, 0);
});

console.log('\n  — the benchmark, as a floor\n');

test('each of the 27 verified rows is in the top three for its own shopper query, and 26 are first', () => {
  const ranks = QUERIES.map(([id, query]) => [id, query, rankOf(query, id)]);
  const missing = ranks.filter(([, , rank]) => !rank || rank > 3);
  assert.deepStrictEqual(missing, [], 'rows outside the top three');
  const first = ranks.filter(([, , rank]) => rank === 1).length;
  assert.ok(first >= 26, `${first}/27 first: ${ranks.filter(([, , rank]) => rank !== 1).map(([, q, r]) => `${q} → ${r}`).join('; ')}`);
});

test('every brand query puts the named garment first', () => {
  for (const [id, query] of BRAND_QUERIES) assert.strictEqual(rankOf(query, id), 1, query);
});

async function testAsync(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); } catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`); }
}

(async () => {
  console.log('\n  — the AI reading, and the live benchmark’s own plumbing\n');

  await testAsync('an AI reading carries the garment and descriptors the shopper said, whatever the model filed them under', async () => {
    const { interpretQuery } = require('../api/interpret');
    const saved = { fetch: global.fetch, key: process.env.OPENAI_API_KEY, ai: process.env.AI_PROVIDER };
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.AI_PROVIDER;
    /* a model constrained to the catalogue's filing says "knit" */
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({
      choices: [{ message: { content: JSON.stringify({ categories: ['knit'], colors: ['Green'], fits: ['Oversized'], keywords: [] }) } }],
      usage: { total_tokens: 120 }
    }) });
    try {
      const reading = await interpretQuery({ query: 'green oversized cropped hoodie', vocabulary: VOCAB });
      assert.strictEqual(reading.ok, true);
      assert.deepStrictEqual([...reading.preferences.garments], ['hoodie']);
      assert.deepStrictEqual([...reading.preferences.descriptors], ['cropped']);
      assert.strictEqual(reading.tokens, 120);
      assert.strictEqual(queryFrom(shapeIntent(reading.preferences)), 'green oversized cropped hoodie');
    } finally {
      global.fetch = saved.fetch;
      if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
      if (saved.ai !== undefined) process.env.AI_PROVIDER = saved.ai;
    }
  });

  await testAsync('the live benchmark measures a stand-in provider end to end (a harness check, not a live result)', async () => {
    const productSource = require('../api/_providers/product-source');
    const asked = [];
    productSource.registerProvider({
      name: 'bench-standin',
      configured: () => true,
      search: async (intent) => {
        asked.push(queryFrom(intent));
        const listing = (title, url) => ({ title, price: 60, imageUrl: 'https://shop.example.com/img/a.jpg', productUrl: url, retailer: 'Example' });
        return [
          listing('Chunky Knit Beanie', 'https://shop.example.com/p/beanie-1'),
          listing('Green Oversized Hoodie', 'https://shop.example.com/p/hoodie-2'),
          listing('Green Oversized Hoodie', 'https://www.shop.example.com/p/hoodie-2/')
        ];
      }
    });
    const saved = { source: process.env.PRODUCT_SOURCE, key: process.env.OPENAI_API_KEY, ai: process.env.AI_PROVIDER };
    process.env.PRODUCT_SOURCE = 'bench-standin';
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER;
    try {
      const out = await require('./bench-live').run({ max: 12 });
      const hoodie = out.results.find((r) => r.id === 'atlas-supply-oversized-hoodie');
      assert.strictEqual(hoodie.asked, 'green oversized hoodie');
      assert.ok(asked.includes('green oversized hoodie'), 'the provider was not asked what the benchmark reports');
      assert.strictEqual(hoodie.interpreter, 'local');
      assert.strictEqual(hoodie.interpreterFailure, 'not-configured');
      /* the beanie is plainly another garment: the live filter removes it,
         and the benchmark says so rather than counting it shown */
      assert.strictEqual(hoodie.garmentRank, 1);
      assert.strictEqual(hoodie.wrongAbove, 0, 'the beanie was shown above the hoodie');
      assert.deepStrictEqual(hoodie.semanticRemoved.map((one) => [one.name, one.position, one.judge]), [['Chunky Knit Beanie', 1, 'contradiction']]);
      assert.deepStrictEqual(hoodie.rejectedWrongAbove.map((one) => [one.name, one.rejectionReason, one.providerPosition]),
        [['Chunky Knit Beanie', 'contradicts-the-requested-garment', 1]]);
      assert.deepStrictEqual(out.summary.semanticContradictionsRemoved.removedCorrectGarments, []);
      assert.strictEqual(hoodie.duplicates, 1, 'the same listing twice');
      const puffer = out.results.find((r) => r.id === 'coveworks-cropped-puffer');
      assert.ok(!puffer || puffer.survived.every((d) => d.inQuery));
      assert.strictEqual(out.summary.interpreterFailures, 0, 'an unconfigured interpreter is a fallback, not a failure');
    } finally {
      for (const [name, value] of [['PRODUCT_SOURCE', saved.source], ['OPENAI_API_KEY', saved.key], ['AI_PROVIDER', saved.ai]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });

  console.log('\n  — the live search falls back the way discovery does\n');

  const productSource = require('../api/_providers/product-source');
  const { searchWithFallback, findProducts } = require('../api/search');
  const QUOTA = 'SerpApi responded 429: Your account has run out of searches.';
  const listing = (title, n) => ({ title, price: 60, imageUrl: `https://shop.example.com/img/${n}.jpg`, productUrl: `https://shop.example.com/p/${n}`, retailer: 'Example' });

  /* a primary and a stand-in registered under Serper's own name, so the
     chain the endpoint builds is the one under test; restored after */
  async function withSources({ primary, fallback, fallbackConfigured = true }, fn) {
    const asked = { primary: 0, fallback: 0 };
    const realSerper = productSource.PROVIDERS.serper;
    const savedSource = process.env.PRODUCT_SOURCE;
    productSource.registerProvider({ name: 'fallback-test-primary', configured: () => true,
      search: async () => { asked.primary += 1; return primary(); } });
    productSource.registerProvider({ name: 'serper', configured: () => fallbackConfigured,
      search: async () => { asked.fallback += 1; return fallback(); } });
    process.env.PRODUCT_SOURCE = 'fallback-test-primary';
    try {
      await fn(asked, productSource.getProvider());
    } finally {
      productSource.PROVIDERS.serper = realSerper;
      if (savedSource === undefined) delete process.env.PRODUCT_SOURCE; else process.env.PRODUCT_SOURCE = savedSource;
    }
  }
  const stats = () => cache.counters();

  await testAsync('a primary out of searches falls back to Serper, and the answer says so', async () => {
    await withSources({
      primary: () => { throw new Error(QUOTA); },
      /* the fallback's records meet the same gate: the linkless one is dropped */
      fallback: () => [listing('Green Oversized Hoodie', 1), { title: 'Hoodie, Google card only', price: 40, imageUrl: 'https://shop.example.com/img/2.jpg', retailer: 'Example' }]
    }, async (asked, primary) => {
      const found = await searchWithFallback(primary, { garments: ['hoodie'], keywords: ['hoodie'] }, 12, stats());
      assert.strictEqual(found.provider, 'serper');
      assert.deepStrictEqual({ provider: found.fellBackFrom.provider, quota: /429/.test(found.fellBackFrom.reason) }, { provider: 'fallback-test-primary', quota: true });
      assert.deepStrictEqual(found.products.map((one) => one.name), ['Green Oversized Hoodie']);
      assert.ok(Object.values(found.rejected).reduce((a, b) => a + b, 0) >= 1, 'the fallback’s linkless record was not put to the gate');
      assert.deepStrictEqual(asked, { primary: 1, fallback: 1 });
    });
  });

  await testAsync('a primary that answers is never replaced', async () => {
    await withSources({ primary: () => [listing('Green Oversized Hoodie', 3)], fallback: () => [listing('Other Hoodie', 4)] }, async (asked, primary) => {
      const found = await searchWithFallback(primary, { keywords: ['green', 'hoodie', 'answers'] }, 12, stats());
      assert.strictEqual(found.provider, 'fallback-test-primary');
      assert.strictEqual(found.fellBackFrom, null);
      assert.deepStrictEqual(asked, { primary: 1, fallback: 0 });
    });
  });

  await testAsync('any other failure is thrown, not handed to someone else', async () => {
    await withSources({ primary: () => { throw new Error('SerpApi responded 500: boom'); }, fallback: () => [listing('Hoodie', 5)] }, async (asked, primary) => {
      await assert.rejects(() => searchWithFallback(primary, { keywords: ['hoodie', 'fivehundred'] }, 12, stats()), /500/);
      assert.deepStrictEqual(asked, { primary: 1, fallback: 0 });
    });
  });

  await testAsync('with no Serper key there is nothing to fall back to, and the refusal stands', async () => {
    await withSources({ primary: () => { throw new Error(QUOTA); }, fallback: () => [listing('Hoodie', 6)], fallbackConfigured: false }, async (asked, primary) => {
      await assert.rejects(() => searchWithFallback(primary, { keywords: ['hoodie', 'nokey'] }, 12, stats()), /429/);
      assert.deepStrictEqual(asked, { primary: 1, fallback: 0 });
    });
  });

  await testAsync('when the fallback fails too, its error stands and still says why the primary was passed over', async () => {
    const SERPER_SPENT = 'Serper responded 400: {"message":"Not enough credits","statusCode":400}';
    await withSources({ primary: () => { throw new Error(QUOTA); }, fallback: () => { throw new Error(SERPER_SPENT); } }, async (asked, primary) => {
      let caught = null;
      try { await searchWithFallback(primary, { keywords: ['hoodie', 'bothspent'] }, 12, stats()); } catch (err) { caught = err; }
      assert.ok(caught, 'the search did not fail');
      /* the message is exactly the fallback's, as before */
      assert.strictEqual(caught.message, SERPER_SPENT);
      assert.deepStrictEqual(caught.fellBackFrom, { provider: 'fallback-test-primary', reason: QUOTA });
      assert.deepStrictEqual(asked, { primary: 1, fallback: 1 });
    });
  });

  test('a provider error is sorted by what it says, not by its status alone', () => {
    const kinds = [
      ['SerpApi responded 429 (SerpApi search allowance exhausted): {"error":"Your account has run out of searches."}', 'credits-exhausted'],
      ['SerpApi error: Your account has run out of searches.', 'credits-exhausted'],
      ['SerpApi responded 429 (SerpApi search allowance exhausted): {"error":"You have exceeded the hourly throughput limit."}', 'rate-limited'],
      ['SerpApi responded 429 (SerpApi search allowance exhausted): ', 'rate-limited-or-credits'],
      ['SerpApi responded 401: {"error":"Invalid API key. Your API key should be here: https://serpapi.com/manage-api-key"}', 'invalid-key'],
      ['SerpApi responded 403: Host not in allowlist: serpapi.com.', 'blocked-by-network'],
      ['Serper responded 400: {"message":"Not enough credits","statusCode":400}', 'credits-exhausted'],
      ['SerpApi did not answer within 4000ms (timed out)', 'timeout'],
      ['SerpApi responded 400: {"error":"Unsupported `foo` engine."}', 'bad-request'],
      ['SerpApi responded 503: ', 'server-error'],
      ['SERPAPI_API_KEY is not set', 'not-configured']
    ];
    assert.deepStrictEqual(kinds.map(([said]) => productSource.failureKind(new Error(said))), kinds.map(([, kind]) => kind));
  });

  await testAsync('/api/search answers from the fallback, and names it as the source', async () => {
    await withSources({ primary: () => { throw new Error(QUOTA); }, fallback: () => [listing('Green Oversized Hoodie', 7)] }, async () => {
      const handler = require('../api/search');
      const res = { statusCode: null, body: null, headers: {} };
      res.setHeader = (k, v) => { res.headers[k] = v; };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (payload) => { res.body = payload; return res; };
      res.end = () => res;
      await handler({ method: 'POST', headers: {}, body: { intent: { garments: ['hoodie'], keywords: ['hoodie', 'handler'] }, limit: 12 }, on: () => {} }, res);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.source, 'serper');
      assert.deepStrictEqual(res.body.products.map((one) => one.name), ['Green Oversized Hoodie']);
    });
  });

  test('discovery and the live search fall back on exactly the same rule', () => {
    const extractor = require('./fetch-catalog-images.js');
    for (const said of [QUOTA, 'Serper responded 429', 'quota exceeded', 'rate limit reached', 'SerpApi responded 500: boom', 'fetch failed', 'SERPAPI_API_KEY is not set']) {
      assert.strictEqual(extractor.outOfSearches(new Error(said)), productSource.outOfSearches(new Error(said)), said);
    }
  });

  console.log('\n  — a verified product that is plainly another garment is not shown\n');

  const filter = require('../api/_providers/garment-filter');
  const titles = (list) => list.map((one) => one.name);
  /* a product as the gate hands it on */
  const verified = (name, n) => ({ name, price: 60, imageUrl: `https://shop.example.com/img/${n}.jpg`, productUrl: `https://shop.example.com/p/${n}`, retailer: 'Example' });
  /* a stand-in source answering every search with one batch, in order */
  const answering = (name, batch) => ({ name, configured: () => true, search: async () => batch.map((one) => Object.assign({}, one)) });
  const TRACK = { garments: ['jacket'], descriptors: ['cropped', 'track'], keywords: ['cropped', 'track', 'jacket'] };

  await testAsync('the live search drops a verified top for a track jacket, and keeps the provider’s order otherwise', async () => {
    cache.reset();
    const source = answering('filter-test-track', [listing("adidas Women's Originals Superstar Cropped Track Top", 31), listing('Cropped Track Jacket', 32),
      listing('Superstar Track Jacket', 33), listing('Longline Denim Jacket', 34)]);
    const found = await findProducts(source, TRACK, 12, stats());
    assert.deepStrictEqual(titles(found.products), ['Cropped Track Jacket', 'Superstar Track Jacket', 'Longline Denim Jacket']);
    assert.deepStrictEqual(found.semanticRemoved.map((one) => [one.name, one.position, one.productUrl]),
      [["adidas Women's Originals Superstar Cropped Track Top", 1, 'https://shop.example.com/p/31']]);
    assert.match(found.semanticRemoved[0].why, /outerwear against top/);
    /* counted with the gate's own refusals */
    assert.strictEqual(found.rejected['contradicts-the-requested-garment'], 1);
    cache.reset();
  });

  await testAsync('an unproven, unreadable or detail-only disagreement is never removed', async () => {
    const keep = (intent, list) => filter.withoutContradictions(list.map((name, n) => verified(name, 40 + n)), intent);
    /* a bare jacket for a puffer is unproven, not another garment */
    const puffer = keep({ garments: ['puffer'], keywords: ['short', 'puffy', 'jacket'] }, ["The North Face Women's Short Jacket Nuptse", 'The Super Puff Shorty Jacket', 'Wool Trench Coat']);
    assert.deepStrictEqual(titles(puffer.products), ["The North Face Women's Short Jacket Nuptse", 'The Super Puff Shorty Jacket']);
    assert.deepStrictEqual(titles(puffer.removed), ['Wool Trench Coat']);
    /* a length that disagrees is a detail of the same garment */
    assert.deepStrictEqual(keep(TRACK, ['Longline Denim Jacket']).removed, []);
    /* a title the reader cannot read stays */
    assert.deepStrictEqual(keep(TRACK, ['Adidas Firebird Tracktop', 'Classic Pocket Crew 6-Pack']).removed, []);
    /* a category or a fabric word is not a garment the shopper named: a
       knit cardigan stays for "black oversized knit" */
    const knit = keep({ categories: ['knit'], colors: ['Black'], fits: ['Oversized'], keywords: ['knit'] }, ['Black Oversized Knit Cardigan', 'Black Knit Beanie']);
    assert.deepStrictEqual([knit.removed.length, knit.checked], [0, false]);
    /* and a request that names no garment removes nothing */
    const none = keep({ keywords: ['something', 'for', 'a', 'wedding'] }, ['Floral Midi Dress', 'Navy Suit Jacket']);
    assert.deepStrictEqual([none.removed.length, none.checked], [0, false]);
  });

  await testAsync('hoodie, sweater, puffer and crew readings carry into the live filter unchanged', async () => {
    const run = (intent, list) => filter.withoutContradictions(list.map((name, n) => verified(name, 50 + n)), intent);
    const hoodie = run({ garments: ['hoodie'], keywords: ['green', 'oversized', 'hoodie'] },
      ['Crew Neck Fleece Sweatshirt', "Zeagoo Women's Oversized Hoodies Fleece Sweatshirts Long Sleeve Pullover", 'Oversized Hooded Sweatshirt']);
    assert.deepStrictEqual(titles(hoodie.removed), ['Crew Neck Fleece Sweatshirt']);
    const sweater = run({ garments: ['sweater'], keywords: ['merino', 'sweater'] }, ['Merino Crewneck Sweater', 'Merino Crew', 'Classic Pocket Crew 6-Pack']);
    assert.deepStrictEqual(sweater.removed, []);
    /* a kind of the garment asked for is that garment: puffers stay for a jacket, hoodies for a sweatshirt */
    assert.deepStrictEqual(run({ garments: ['jacket'], keywords: ['black', 'jacket'] }, ['Black Puffer Jacket', 'Black Denim Jacket']).removed, []);
    assert.deepStrictEqual(run({ garments: ['sweatshirt'], keywords: ['crewneck', 'sweatshirt'] }, ['Oversized Hoodie', 'Crewneck Sweatshirt']).removed, []);
    /* a type the reader inferred from the fibre is not the title's word */
    assert.deepStrictEqual(run({ garments: ['sweatshirt'], keywords: ['sweatshirt'] }, ['Merino Crew Sweatshirt']).removed, []);
  });

  await testAsync('a result is removed only when it contradicts every garment the request names', async () => {
    const run = (intent, list) => filter.withoutContradictions(list.map((name, n) => verified(name, 60 + n)), intent);
    /* the interpreter's "trousers" and the shopper's own "pants" */
    const cargo = run({ garments: ['trousers'], descriptors: ['cargo'], keywords: ['olive', 'cargo', 'pants'] }, ['Cargo Jogger Pants', 'Olive Cargo Trousers']);
    assert.deepStrictEqual(cargo.removed, []);
    /* two garments asked for: either answers */
    const both = run({ garments: ['hoodie', 'jacket'] }, ['Denim Jacket', 'Zip Hoodie', 'Cargo Pants']);
    assert.deepStrictEqual(titles(both.removed), ['Cargo Pants']);
    /* a shopper's descriptor the reader knows as a garment ("short") is not a garment asked for */
    assert.deepStrictEqual(filter.requestedGarments({ garments: ['puffer'], keywords: ['short', 'puffy', 'jacket'] }).includes('short'), false);
  });

  await testAsync('/api/search reports how many it removed, and never what', async () => {
    cache.reset();
    await withSources({ primary: () => [listing('Cropped Track Top', 71), listing('Cropped Track Jacket', 72)], fallback: () => [] }, async () => {
      const handler = require('../api/search');
      const res = { statusCode: null, body: null, headers: {} };
      res.setHeader = (k, v) => { res.headers[k] = v; };
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (payload) => { res.body = payload; return res; };
      res.end = () => res;
      await handler({ method: 'POST', headers: {}, body: { intent: TRACK, limit: 12 }, on: () => {} }, res);
      assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
      assert.deepStrictEqual(titles(res.body.products), ['Cropped Track Jacket']);
      assert.strictEqual(res.body.diagnostics.removedAsAnotherGarment, 1);
      assert.strictEqual(res.body.rejected['contradicts-the-requested-garment'], 1);
      assert.ok(!JSON.stringify(res.body).includes('Cropped Track Top'), 'a removed title reached the browser');
    });
    cache.reset();
  });

  await testAsync('the live benchmark tells a wrong garment Fynd showed from one its gate refused', async () => {
    const saved = { key: process.env.OPENAI_API_KEY, ai: process.env.AI_PROVIDER };
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER;
    const noImage = (title, n) => Object.assign(listing(title, n), { imageUrl: null });
    const noPrice = (title, n) => Object.assign(listing(title, n), { price: null });
    /* the benchmark's queries are the next test's too: neither may be
       answered from the other's cache */
    cache.reset();
    try {
      await withSources({
        /* the provider's raw order: a wrong garment the gate refuses, one
           the live filter removes as another garment, another the gate
           refuses, a hoodie the judge refuses on a DETAIL (slim for
           oversized) that is shown, a duplicate of it, the correct one,
           and a wrong one after it that is above nothing */
        primary: () => [noImage('Slim Chino Trousers', 21), listing('Pleated Midi Skirt', 22), noPrice('Denim Jacket', 23),
          listing('Slim Fit Green Hoodie', 26), listing('Slim Fit Green Hoodie', 26), listing('Green Oversized Hoodie', 24), listing('Wool Trench Coat', 25)],
        fallback: () => []
      }, async () => {
        const out = await require('./bench-live').run({ max: 12 });
        const hoodie = out.results.find((r) => r.id === 'atlas-supply-oversized-hoodie');
        assert.strictEqual(hoodie.garmentRank, 2);
        assert.strictEqual(hoodie.firstCorrectProviderPosition, 6);
        assert.deepStrictEqual(hoodie.acceptedWrongAbove.map((one) => [one.name, one.status, one.rejectionReason, one.providerPosition, one.shownPosition]),
          [['Slim Fit Green Hoodie', 'accepted', null, 4, 1]]);
        assert.deepStrictEqual(hoodie.rejectedWrongAbove.map((one) => [one.name, one.status, one.rejectionReason, one.providerPosition, one.shownPosition]),
          [['Slim Chino Trousers', 'rejected', 'missing-image-url', 1, null], ['Pleated Midi Skirt', 'rejected', 'contradicts-the-requested-garment', 2, null],
            ['Denim Jacket', 'rejected', 'missing-price', 3, null], ['Slim Fit Green Hoodie', 'rejected', 'duplicate-of-an-earlier-listing', 5, null]]);
        const shown = hoodie.acceptedWrongAbove[0];
        assert.strictEqual(shown.retailer, 'Example');
        assert.strictEqual(shown.productUrl, 'https://shop.example.com/p/26');
        assert.match(shown.wrongBecause, /slim/);
        /* the skirt and the coat were removed as other garments; the judge agrees they were wrong */
        assert.deepStrictEqual(hoodie.semanticRemoved.map((one) => [one.name, one.judge]), [['Pleated Midi Skirt', 'contradiction'], ['Wool Trench Coat', 'contradiction']]);
        /* the old count is kept, and agrees with what was shown */
        assert.strictEqual(hoodie.wrongAbove, 1);
        const accepted = out.summary.acceptedWrongGarmentsAbove.cases.filter((one) => one.query === hoodie.query);
        const rejected = out.summary.rejectedWrongCandidatesAbove.cases.filter((one) => one.query === hoodie.query);
        assert.deepStrictEqual(accepted.map((one) => one.name), ['Slim Fit Green Hoodie']);
        assert.deepStrictEqual(rejected.map((one) => one.providerPosition), [1, 2, 3, 5]);
        assert.ok(out.summary.wrongGarmentsAbove.some((one) => one.query === hoodie.query));
      });
    } finally {
      cache.reset();
      if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
      if (saved.ai !== undefined) process.env.AI_PROVIDER = saved.ai;
    }
  });

  await testAsync('the live benchmark reports the provider that answered, and when it was the fallback', async () => {
    const saved = { key: process.env.OPENAI_API_KEY, ai: process.env.AI_PROVIDER };
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_PROVIDER;
    try {
      await withSources({ primary: () => { throw new Error(QUOTA); }, fallback: () => [listing('Green Oversized Hoodie', 8)] }, async () => {
        const out = await require('./bench-live').run({ max: 12 });
        const hoodie = out.results.find((r) => r.id === 'atlas-supply-oversized-hoodie');
        assert.strictEqual(hoodie.providerFailure, null);
        assert.strictEqual(hoodie.provider, 'serper');
        assert.strictEqual(hoodie.usedFallback, true);
        assert.strictEqual(hoodie.fellBackFrom.provider, 'fallback-test-primary');
        assert.deepStrictEqual({ provider: hoodie.primaryFailure.provider, kind: hoodie.primaryFailure.kind }, { provider: 'fallback-test-primary', kind: 'credits-exhausted' });
        assert.deepStrictEqual(Object.keys(out.summary.primaryProviderFailures), ['credits-exhausted']);
        assert.strictEqual(out.summary.primaryProviderFailures['credits-exhausted'].queries, 12);
        assert.strictEqual(hoodie.garmentRank, 1);
        assert.deepStrictEqual(out.summary.answeredBy, { 'serper (fallback)': 12 });
        assert.deepStrictEqual(out.sources.map((one) => [one.name, one.role, one.configured, one.inChain]),
          [['fallback-test-primary', 'primary', true, true], ['serper', 'fallback', true, true]]);
      });
    } finally {
      if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
      if (saved.ai !== undefined) process.env.AI_PROVIDER = saved.ai;
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
