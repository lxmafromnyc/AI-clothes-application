#!/usr/bin/env node
/* =========================================================
   Fynd — descriptive requests: regression tests

   People describe clothes they cannot name: "something like a hoodie
   but cleaner", "a shirt that looks like a jacket", "something cozy I
   can wear with jeans". This holds the whole path those requests take
   to what it must do and what it must never do:

     * read what they most likely mean, from tables, and nothing more
     * keep what the shopper stated (colour, budget, brand, gender)
       strict, and keep a garment named only as a setting ("with jeans")
       out of the search
     * ask the provider ONE readable phrase, once
     * show the closest matches first, by the products' own titles, and
       never put anything on a product that its source did not supply
     * leave every request that named its garment in shop words exactly
       as it was, and every gate exactly as it was

   No network: the provider is stubbed with the pool and the word-match
   search scripts/bench-concepts.js measures with.

   Usage: node scripts/test-concepts.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.FYND_CACHE = 'off';
['PRODUCT_SOURCE', 'SERPER_API_KEY', 'SERPAPI_API_KEY', 'AI_PROVIDER'].forEach((key) => { delete process.env[key]; });

require('../assets/interpret.js');
const Interpreter = globalThis.Interpreter;
const { interpretQuery } = require('../api/interpret');
const searchApi = require('../api/search');
const { shapeIntent, searchWithFallback } = searchApi;
const { queryFrom, shapeConcepts } = require('../api/_providers/query');
const productSource = require('../api/_providers/product-source');
const { withoutContradictions } = require('../api/_providers/garment-filter');
const { rankByIntent, lookupOrder } = require('../api/_providers/relevance');
const cache = require('../api/_cache');
const { searchPool } = require('./bench-concepts.js');
const { POOL } = require('./bench-concepts-pool.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    cache.reset();
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
  }
}

const read = (query) => Interpreter.readConcepts(query);
const local = (query) => shapeIntent(Interpreter.localInterpret(query, {}));
const phrase = (query) => queryFrom(local(query));

/* ---------- a stubbed provider: the pool, word-matched ---------- */

const byId = new Map(POOL.map((item) => [item.id, item]));
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function provider(options) {
  const o = options || {};
  const calls = { search: [], offers: [], model: 0, other: [] };
  const fetch = async (input) => {
    const url = new URL(String(input && input.url ? input.url : input));
    if (url.hostname === 'api.openai.com') {
      calls.model += 1;
      return reply(200, { choices: [{ message: { content: JSON.stringify(o.model || {}) } }], usage: { total_tokens: 10 } });
    }
    if (url.pathname.endsWith('/search')) {
      calls.search.push(Object.fromEntries(url.searchParams.entries()));
      if (o.searchStatus) return reply(o.searchStatus, { message: 'Too many requests' });
      const data = o.records ? o.records : searchPool(url.searchParams.get('q'), {
        limit: Number(url.searchParams.get('limit')) || 24,
        min: Number(url.searchParams.get('min_price')) || 0,
        max: Number(url.searchParams.get('max_price')) || 0
      });
      return reply(200, { status: 'OK', data });
    }
    if (url.pathname.endsWith('/product-offers')) {
      const id = url.searchParams.get('product_id');
      calls.offers.push(id);
      const item = byId.get(id);
      const offer = (o.offerFor && o.offerFor(id)) || (item ? { store_name: item.store, price: `$${item.price}.00`, offer_page_url: `https://www.${item.store}/products/${item.id}` } : null);
      return reply(200, { status: 'OK', data: { offers: offer ? [offer] : [] } });
    }
    calls.other.push(url.href);
    throw new Error(`no stand-in for ${url.href}`);
  };
  return { fetch, calls };
}

async function withProvider(stub, fn) {
  const saved = { fetch: global.fetch, key: process.env.OPENWEBNINJA_API_KEY, openai: process.env.OPENAI_API_KEY };
  global.fetch = stub.fetch;
  process.env.OPENWEBNINJA_API_KEY = 'test-key';
  process.env.OPENAI_API_KEY = 'sk-test';
  try {
    return await fn();
  } finally {
    global.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.OPENWEBNINJA_API_KEY; else process.env.OPENWEBNINJA_API_KEY = saved.key;
    if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
  }
}

const search = (intent, limit) => searchWithFallback(productSource.getProvider(), intent, limit || 12, cache.counters(), Date.now() + 60000);

/* the fields the verification gate builds a product from, and nothing else */
const GATE_FIELDS = new Set(['id', 'name', 'price', 'currency', 'imageUrl', 'productUrl', 'retailer', 'category', 'colors', 'sizes', 'brand']);

const anyOf = (list, pattern) => list.some((one) => pattern.test(one));

async function main() {
  console.log('\n  — vague descriptions are read for what they most likely mean\n');

  await test('"something like a hoodie but cleaner" expands to hoodie / sweatshirt / pullover / quarter-zip, not one keyword', () => {
    const c = read('something like a hoodie but cleaner');
    assert.strictEqual(c.mode, 'comparative');
    assert.strictEqual(c.anchor, 'hoodie');
    for (const name of ['quarter zip pullover', 'crewneck sweatshirt', 'knit pullover', 'hoodie']) assert.ok(c.alternatives.includes(name), name);
    assert.ok(c.alternatives.length >= 3, 'collapsed to one concept');
    assert.ok(c.signals.includes('polished') || c.signals.includes('minimal'));
  });

  await test('"something like a hoodie but more polished" reads the same comparison', () => {
    const c = read('something like a hoodie but more polished');
    assert.deepStrictEqual(c.alternatives.slice(0, 3), ['quarter zip pullover', 'crewneck sweatshirt', 'knit pullover']);
  });

  await test('"a shirt that looks like a jacket" is an overshirt, a shirt jacket or a chore jacket — and not a bomber, leather jacket or puffer', () => {
    const c = read('a shirt that looks like a jacket');
    assert.strictEqual(c.mode, 'hybrid');
    assert.deepStrictEqual(c.alternatives, ['overshirt', 'shirt jacket', 'chore jacket']);
    for (const wrong of ['bomber', 'leather jacket', 'puffer']) {
      assert.ok(!c.alternatives.includes(wrong), `${wrong} offered without evidence`);
      assert.ok(c.avoid.includes(wrong), `${wrong} not held down`);
    }
  });

  await test('"between a shirt and a jacket" and "jacket thing thats kinda like a shirt" read as the same crossing', () => {
    assert.deepStrictEqual(read('between a shirt and a jacket').alternatives, ['overshirt', 'shirt jacket', 'chore jacket']);
    assert.deepStrictEqual(read('jacket thing thats kinda like a shirt').alternatives, ['overshirt', 'shirt jacket', 'chore jacket']);
  });

  await test('"loose black pants that look nice": black, a relaxed silhouette, trousers, and polish as a soft signal', () => {
    const c = read('loose black pants that look nice');
    assert.deepStrictEqual(c.colors, ['black']);
    assert.deepStrictEqual(c.fit, ['relaxed']);
    assert.ok(c.signals.includes('polished'));
    assert.ok(c.alternatives.slice(0, 2).every((name) => /trousers/.test(name)), c.alternatives.join(', '));
    assert.ok(c.alternatives.includes('wide leg trousers'));
    const intent = local('loose black pants that look nice');
    assert.deepStrictEqual(intent.garments, ['trousers']);
    /* soft: nothing about polish became a filter or a stated attribute */
    assert.deepStrictEqual(intent.styles, []);
    assert.strictEqual(intent.maxPrice, null);
  });

  await test('"something cozy to wear with jeans": tops and layers, cozy as the style, jeans only the setting', () => {
    const c = read('something cozy I can wear with jeans');
    assert.strictEqual(c.mode, 'context');
    assert.deepStrictEqual(c.context, ['jeans']);
    assert.ok(c.signals.includes('cozy'));
    assert.deepStrictEqual(c.alternatives, ['sweater', 'sweatshirt', 'cardigan']);
    const intent = local('something cozy I can wear with jeans');
    assert.deepStrictEqual(intent.garments, [], 'jeans became the garment asked for');
    assert.ok(!intent.categories.includes('trousers'), 'jeans became the category asked for');
    assert.ok(!/jean/.test(queryFrom(intent)), queryFrom(intent));
  });

  await test('"that short jacket thing people wear over shirts": cropped jacket, overshirt, shirt jacket', () => {
    const c = read('that short jacket thing people wear over shirts');
    for (const name of ['cropped jacket', 'overshirt', 'shirt jacket']) assert.ok(c.alternatives.includes(name), name);
    assert.deepStrictEqual(c.context, ['shirt']);
    assert.deepStrictEqual(local('that short jacket thing people wear over shirts').garments, ['jacket']);
  });

  await test('a setting keeps its own colour and fit: "baggy black jeans" says nothing about the top', () => {
    const c = read('something comfy to wear with my baggy black jeans');
    assert.deepStrictEqual(c.colors, []);
    assert.deepStrictEqual(c.fit, []);
    assert.deepStrictEqual(c.extra, []);
    /* the page's own reader still files "black" as a colour; the phrase
       does not take it, because the reading says whose colour it is */
    assert.ok(!/black|baggy|jean/.test(phrase('something comfy to wear with my baggy black jeans')), phrase('something comfy to wear with my baggy black jeans'));
    assert.ok(!/wide|jean/.test(phrase('something cozy to wear with wide leg jeans')), phrase('something cozy to wear with wide leg jeans'));
    /* and a colour the shopper gave the thing they want is kept */
    assert.ok(/^cream /.test(phrase('something cream and cozy to wear with black jeans')), phrase('something cream and cozy to wear with black jeans'));
  });

  await test('what was ruled out is not what was asked for: "not too formal" is casual, never an evening occasion', () => {
    const c = read("a dress that's simple but not too formal");
    assert.ok(c.signals.includes('casual') && c.signals.includes('minimal'));
    assert.deepStrictEqual(c.alternatives.slice(0, 3), ['shift dress', 't-shirt dress', 'shirt dress']);
    assert.ok(c.avoid.includes('gown'));
    assert.ok(!local("a dress that's simple but not too formal").occasions.includes('Evening'));
  });

  await test('"not crazy expensive" is a preference about price, never an invented budget', () => {
    const c = read('a bag that looks vintage but not crazy expensive');
    assert.ok(c.signals.includes('affordable'));
    assert.strictEqual(c.style, 'vintage style', 'looks vintage is vintage STYLE');
    const intent = local('a bag that looks vintage but not crazy expensive');
    assert.strictEqual(intent.maxPrice, null);
    assert.strictEqual(intent.minPrice, null);
    assert.ok(!/cheap|expensive|crazy/.test(queryFrom(intent)));
  });

  await test('informal words are read: "comfy", "lowkey", "not as sloppy"', () => {
    assert.ok(read('comfy fit to wear with my baggy jeans').signals.includes('cozy'));
    const lowkey = read('lowkey hoodie but not as sloppy');
    assert.ok(lowkey.signals.includes('casual') && lowkey.signals.includes('polished'));
    assert.strictEqual(lowkey.mode, 'described');
    assert.deepStrictEqual(lowkey.search, ['hoodie'], 'a hoodie the shopper named is searched as a hoodie');
  });

  console.log('\n  — ambiguity is not turned into certainty\n');

  await test('"something nice for dinner" gets no garment, colour or shoe it did not ask for', () => {
    const c = read('something nice for dinner');
    /* read as what it says — a dressy something for dinner — and nothing more */
    assert.strictEqual(c.mode, 'plain');
    assert.deepStrictEqual(c.alternatives, []);
    assert.ok(!/dress\b|black|heel/.test(JSON.stringify(c)), JSON.stringify(c));
    const intent = local('something nice for dinner');
    const said = JSON.stringify(intent).toLowerCase();
    /* a word, not a substring: "dressy" — read from "nice" — is a style, not a dress */
    for (const stereotype of [/\bdress(es)?\b/, /\bblack\b/, /\bheels?\b/]) assert.ok(!stereotype.test(said), `${stereotype} was invented`);
    assert.ok(!/\bdress(es)?\b|\bblack\b|\bheels?\b/.test(queryFrom(intent)), queryFrom(intent));
  });

  await test('a description no table covers is searched as what it says, never rewritten into a garment it did not name', () => {
    /* in shop words already: left exactly as it was */
    assert.strictEqual(read('a dress for warm weather'), null);
    /* described, but nothing tabled: the talk comes out, nothing goes in */
    const cases = { 'comfortable running shoes': 'comfortable running shoes', 'chill pants for lounging': 'lounging pants', 'black thing for the office': 'black office outfit' };
    for (const [query, asked] of Object.entries(cases)) {
      const c = read(query);
      assert.strictEqual(c.mode, 'plain', query);
      assert.deepStrictEqual(c.alternatives, [], `${query} was given a garment it did not name`);
      assert.strictEqual(phrase(query), asked, query);
    }
  });

  console.log('\n  — exact requests behave exactly as before\n');

  /* what the base commit asked for these, captured before the change */
  const EXACT = {
    /* served by a model that answered nothing: the colour the shopper
       typed is still searched (api/_reading.js), and nothing else is added */
    'black oversized hoodie under $80': { local: 'black oversized hoodie under $80', served: 'black hoodie' },
    'cream linen midi dress for summer': { local: 'white linen midi dress cream for summer', served: 'cream linen midi dress' },
    'vintage Prada bag under $500': { local: 'vintage prada bag under $500', served: '' }
  };

  await test('the three exact requests are not descriptive, and ask the provider the same phrase as before', async () => {
    for (const [query, was] of Object.entries(EXACT)) {
      assert.strictEqual(read(query), null, query);
      assert.strictEqual(phrase(query), was.local, query);
      const stub = provider();
      const served = await withProvider(stub, () => interpretQuery({ query, vocabulary: {} }));
      assert.strictEqual(queryFrom(shapeIntent(served.preferences)), was.served, query);
      assert.ok(!('concepts' in served.preferences), 'an exact reply grew a field');
    }
  });

  await test('more exact requests in shop words stay on the old path', () => {
    for (const query of ['navy quarter zip pullover', 'cropped denim jacket', 'black wide leg trousers', 'minimal white sneakers', 'vintage leather jacket', 'oversized hoodie', 'linen shirt for summer', "women's black blazer under $150"]) {
      assert.strictEqual(read(query), null, query);
      assert.strictEqual(local(query).concepts, null, query);
    }
  });

  await test('an exact request is shown in the provider\'s order, through the same gate, with nothing reordered', async () => {
    const stub = provider();
    const found = await withProvider(stub, () => search(local('black oversized hoodie under $80')));
    assert.strictEqual(found.reordered, false);
    const ids = found.products.map((p) => p.productUrl.split('/').pop());
    const providerOrder = stub.calls.search[0] && searchPool(stub.calls.search[0].q, { limit: 24, max: 80 }).map((r) => r.product_id);
    assert.deepStrictEqual(ids, providerOrder.filter((id) => ids.includes(id)), 'the provider\'s order was changed');
    assert.ok(found.products.every((p) => p.price <= 80));
  });

  await test('the search cache keys an exact request exactly as it did before concepts existed', () => {
    const intent = local('black oversized hoodie under $80');
    const without = Object.assign({}, intent);
    delete without.concepts;
    assert.strictEqual(cache.searchKey({ provider: 'openwebninja', intent, limit: 12 }), cache.searchKey({ provider: 'openwebninja', intent: without, limit: 12 }));
    const vague = local('something like a hoodie but cleaner');
    const bare = Object.assign({}, vague);
    delete bare.concepts;
    assert.notStrictEqual(cache.searchKey({ provider: 'openwebninja', intent: vague, limit: 12 }), cache.searchKey({ provider: 'openwebninja', intent: bare, limit: 12 }));
  });

  console.log('\n  — the phrase the provider is asked\n');

  await test('a comparison is asked as concepts, not as the shopper\'s filler words', () => {
    const q = phrase('something like a hoodie but cleaner');
    assert.ok(/quarter zip/.test(q) && /sweatshirt/.test(q), q);
    for (const filler of ['something', 'like', 'but', 'cleaner']) assert.ok(!q.split(' ').includes(filler), `${filler} in ${q}`);
  });

  await test('the phrase stays readable: a few concepts, never every synonym', () => {
    for (const query of ['something like a hoodie but cleaner', 'a shirt that looks like a jacket', 'loose black pants that look nice', 'something cozy I can wear with jeans', 'that short jacket thing people wear over shirts', 'a bag that looks vintage but not crazy expensive']) {
      const intent = local(query);
      const q = queryFrom(intent);
      assert.ok(q.split(' ').length <= 12, `${q} is a keyword dump`);
      const asked = intent.concepts.search.filter((name) => q.includes(name));
      assert.ok(asked.length >= 1 && asked.length <= 3, `${q}: ${asked.length} concepts`);
      assert.ok(intent.concepts.alternatives.length >= asked.length);
    }
  });

  await test('stated constraints stay in a descriptive request\'s phrase and intent: gender, colour, brand, budget', () => {
    const raw = Interpreter.localInterpret("women's black Nike hoodie but cleaner under $70", { brands: ['Nike'] });
    const intent = shapeIntent(raw);
    assert.ok(intent.concepts, 'not read as descriptive');
    const q = queryFrom(intent);
    for (const word of ['women', 'black', 'nike']) assert.ok(q.includes(word), `${word} missing from ${q}`);
    assert.strictEqual(intent.maxPrice, 70);
    assert.deepStrictEqual(intent.brands, ['Nike']);
  });

  await test('a garment named only as the setting is never in the phrase', () => {
    for (const query of ['something cozy I can wear with jeans', 'something to wear over a dress', 'a white tee to wear under a blazer']) {
      const intent = local(query);
      for (const setting of intent.concepts.context) assert.ok(!queryFrom(intent).includes(setting), `${setting} in ${queryFrom(intent)}`);
    }
    assert.strictEqual(phrase('a white tee to wear under a blazer'), 'white t-shirt');
  });

  await test('concepts arriving at /api/search are held to their shape', () => {
    assert.strictEqual(shapeConcepts(null), null);
    assert.strictEqual(shapeConcepts('overshirt'), null);
    assert.strictEqual(shapeConcepts({ mode: 'made-up', alternatives: ['overshirt'] }), null);
    assert.strictEqual(shapeConcepts({ mode: 'hybrid', alternatives: [] }), null);
    const shaped = shapeConcepts({
      mode: 'hybrid',
      alternatives: ['overshirt', 42, '', 'x'.repeat(200), 'shirt jacket', 'a', 'b', 'c', 'd', 'e', 'f'],
      signals: ['cozy', 'free shipping', 'polished'],
      colors: [{}, 'black'],
      injected: 'ignored'
    });
    assert.deepStrictEqual(shaped.alternatives, ['overshirt', 'shirt jacket', 'a', 'b', 'c', 'd'], 'a non-string or an overlong concept was kept');
    assert.deepStrictEqual(shaped.signals, ['cozy', 'polished']);
    assert.deepStrictEqual(shaped.colors, ['black']);
    assert.ok(!('injected' in shaped));
    assert.strictEqual(shapeIntent({ concepts: { mode: 'hybrid', alternatives: ['overshirt'] } }).concepts.alternatives[0], 'overshirt');
  });

  await test('the served interpreter attaches the same concepts the page reads, whatever the model said', async () => {
    const stub = provider({ model: { categories: ['trousers'], keywords: ['cozy', 'jeans'], colors: ['Blue'] } });
    const served = await withProvider(stub, () => interpretQuery({ query: 'something cozy I can wear with jeans', vocabulary: {} }));
    assert.ok(served.ok);
    assert.deepStrictEqual(served.preferences.concepts, read('something cozy I can wear with jeans'));
    assert.deepStrictEqual(served.preferences.garments, []);
    /* the model filed the request under the jeans it is worn with; a
       filing for a garment named only as the setting is not kept
       (api/_reading.js), and the phrase is built from the concepts, so
       neither "trousers" nor "jeans" is searched */
    assert.deepStrictEqual(served.preferences.categories, []);
    const q = queryFrom(shapeIntent(served.preferences));
    assert.ok(!/jean|trouser/.test(q), q);
  });

  await test('the page passes the concepts on to /api/search unchanged', () => {
    const c = read('a shirt that looks like a jacket');
    const shaped = Interpreter.shape({ garments: ['shirt'], concepts: c });
    assert.deepStrictEqual(shaped.concepts.alternatives, c.alternatives);
    assert.strictEqual(Interpreter.shape({ garments: ['shirt'] }).concepts, null);
  });

  console.log('\n  — one Fynd search is one provider search\n');

  const DESCRIPTIVE = ['something like a hoodie but cleaner', 'a shirt that looks like a jacket', 'loose black pants that look nice', "a dress that's simple but not too formal", 'something cozy I can wear with jeans', 'that short jacket thing people wear over shirts', 'a bag that looks vintage but not crazy expensive'];

  await test('every descriptive request makes exactly one search request, its lookups inside the existing ceiling, and nothing else', async () => {
    for (const query of DESCRIPTIVE) {
      cache.reset();
      const stub = provider();
      await withProvider(stub, () => search(local(query), 12));
      assert.strictEqual(stub.calls.search.length, 1, `${query}: ${stub.calls.search.length} searches`);
      assert.ok(stub.calls.offers.length <= 12 + 8, `${query}: ${stub.calls.offers.length} lookups`);
      assert.strictEqual(new Set(stub.calls.offers).size, stub.calls.offers.length, 'a product looked up twice');
      assert.strictEqual(stub.calls.model, 0, 'the search called a model');
      assert.deepStrictEqual(stub.calls.other, []);
    }
  });

  await test('a descriptive request costs no more lookups than an exact one on the same pool', async () => {
    const cost = async (query) => { cache.reset(); const stub = provider(); await withProvider(stub, () => search(local(query), 12)); return stub.calls.offers.length; };
    assert.ok(await cost('something like a hoodie but cleaner') <= Math.max(await cost('black oversized hoodie'), 12));
  });

  await test('the budget still goes to the provider and is still enforced on a descriptive request', async () => {
    const stub = provider({ offerFor: (id) => (id === 'q01' ? { store_name: 'jcrew.com', price: '$140.00', offer_page_url: 'https://www.jcrew.com/p/q01' } : null) });
    const found = await withProvider(stub, () => search(local('something like a hoodie but cleaner under $60'), 12));
    assert.strictEqual(stub.calls.search[0].max_price, '60');
    assert.ok(found.products.length > 0);
    assert.ok(found.products.every((p) => p.price <= 60), 'an over-budget offer was shown');
  });

  console.log('\n  — closest matches first, by verified titles only\n');

  await test('"something like a hoodie but cleaner": concepts first, and no graphic hoodie above any of them', async () => {
    const stub = provider();
    const found = await withProvider(stub, () => search(local('something like a hoodie but cleaner'), 12));
    const names = found.products.map((p) => p.name);
    assert.ok(found.reordered);
    assert.ok(/quarter.?zip|half zip|crewneck sweatshirt|knit pullover|pullover|sweater/i.test(names[0]), names[0]);
    const lastGood = Math.max(...names.map((n, at) => (/quarter.?zip|half zip|sweatshirt|pullover|sweater/i.test(n) ? at : -1)));
    const firstLoud = names.findIndex((n) => /graphic|tie dye|skull|logo|cartoon/i.test(n));
    assert.ok(firstLoud === -1 || firstLoud > lastGood, names.join(' | '));
  });

  await test('"a shirt that looks like a jacket": overshirts and shirt jackets above any bomber, puffer or leather jacket', async () => {
    const stub = provider();
    const found = await withProvider(stub, () => search(local('a shirt that looks like a jacket'), 12));
    const names = found.products.map((p) => p.name);
    assert.ok(/overshirt|shirt jacket|shacket|chore/i.test(names[0]), names[0]);
    const wrong = names.findIndex((n) => /bomber|puffer|leather|parka/i.test(n));
    const right = Math.max(...names.map((n, at) => (/overshirt|shirt jacket|shacket|chore/i.test(n) ? at : -1)));
    assert.ok(wrong === -1 || wrong > right, names.join(' | '));
  });

  await test('the stated colour outranks every soft signal', async () => {
    const products = [
      { name: 'Relaxed Wide Leg Trousers Navy', price: 70 },
      { name: 'Black Trousers', price: 70 },
      { name: 'Wide Leg Trousers Black', price: 70 }
    ];
    const ranked = rankByIntent(products, local('loose black pants that look nice')).products.map((p) => p.name);
    assert.deepStrictEqual(ranked, ['Wide Leg Trousers Black', 'Black Trousers', 'Relaxed Wide Leg Trousers Navy']);
  });

  await test('"not crazy expensive" holds a listing far above the rest of its results below the ones that are not', () => {
    const products = [
      { name: 'Vintage Prada Nylon Shoulder Bag', price: 480 },
      { name: 'Vintage Style Shoulder Bag Brown', price: 48 },
      { name: 'Retro Top Handle Bag', price: 55 },
      { name: 'Leather Shoulder Bag Tan', price: 95 }
    ];
    const ranked = rankByIntent(products, local('a bag that looks vintage but not crazy expensive')).products.map((p) => p.name);
    assert.strictEqual(ranked[ranked.length - 1], 'Vintage Prada Nylon Shoulder Bag', ranked.join(' | '));
  });

  await test('ranking reorders the same products and invents nothing: no new field, no score, no changed value', async () => {
    const stub = provider();
    const intent = local('something like a hoodie but cleaner');
    const found = await withProvider(stub, () => search(intent, 12));
    for (const product of found.products) {
      for (const key of Object.keys(product)) assert.ok(GATE_FIELDS.has(key), `a product grew "${key}"`);
      const item = byId.get(product.productUrl.split('/').pop());
      assert.strictEqual(product.name, item.title, 'the title is not the source\'s');
      assert.strictEqual(product.price, item.price, 'the price is not the offer\'s');
      assert.ok(product.productUrl.startsWith(`https://www.${item.store}/`), 'the link is not the offer\'s');
    }
    assert.ok(!/score|match|percent/i.test(JSON.stringify(found.products)));
    const again = rankByIntent(found.products, intent);
    assert.deepStrictEqual(new Set(again.products), new Set(found.products), 'the ranking added or dropped a product');
  });

  await test('ties keep the provider\'s order, and a request without concepts is never sorted', () => {
    const products = [{ name: 'Item A', price: 1 }, { name: 'Item B', price: 1 }, { name: 'Item C', price: 1 }];
    assert.deepStrictEqual(rankByIntent(products, local('a shirt that looks like a jacket')).products, products);
    const exact = rankByIntent(products.slice().reverse(), local('black oversized hoodie'));
    assert.strictEqual(exact.applied, false);
    assert.deepStrictEqual(exact.products.map((p) => p.name), ['Item C', 'Item B', 'Item A']);
    assert.strictEqual(lookupOrder(products, local('black oversized hoodie')), products);
  });

  console.log('\n  — the garment filter: widened by what was meant, unchanged otherwise\n');

  await test('a crewneck sweatshirt is what "like a hoodie but cleaner" asked for, so it is not removed as another garment', () => {
    const products = [{ name: 'Crewneck Sweatshirt Heather Grey' }, { name: 'Knit Pullover Sweater Oatmeal' }, { name: 'Nylon Bomber Jacket Black' }];
    const intent = local('something like a hoodie but cleaner');
    const kept = withoutContradictions(products, intent).products.map((p) => p.name);
    assert.ok(kept.includes('Crewneck Sweatshirt Heather Grey') && kept.includes('Knit Pullover Sweater Oatmeal'), kept.join(' | '));
    assert.ok(!kept.includes('Nylon Bomber Jacket Black'), 'a bomber is still another garment');
    const bare = Object.assign({}, intent, { concepts: null });
    assert.ok(!withoutContradictions(products, bare).products.some((p) => /Crewneck Sweatshirt/.test(p.name)), 'the check this widens is not the one it replaced');
  });

  await test('an exact request is filtered exactly as before', () => {
    const products = [{ name: 'Chunky Knit Beanie' }, { name: 'Black Oversized Hoodie' }, { name: 'Crewneck Sweatshirt' }];
    const intent = local('black oversized hoodie');
    const result = withoutContradictions(products, intent);
    assert.deepStrictEqual(result.products.map((p) => p.name), ['Black Oversized Hoodie']);
  });

  await test('with jeans only the setting, a sweater is no longer removed for not being jeans', async () => {
    const stub = provider();
    const found = await withProvider(stub, () => search(local('something cozy I can wear with jeans'), 12));
    assert.ok(found.products.length >= 8, `${found.products.length} shown`);
    assert.ok(!anyOf(found.products.map((p) => p.name), /jean/i), 'jeans were shown');
    assert.strictEqual(found.rejected['contradicts-the-requested-garment'] || 0, 0);
  });

  console.log('\n  — fallback and gates are untouched\n');

  await test('OpenWeb Ninja out of searches still falls back to Serper, once, asked the same concept phrase', async () => {
    const asked = [];
    const realSerper = productSource.PROVIDERS.serper;
    productSource.registerProvider({
      name: 'serper',
      configured: () => true,
      search: async (intent) => {
        asked.push(queryFrom(intent));
        const listing = (title, slug) => ({ title, price: 80, imageUrl: `https://img.example.com/${slug}.jpg`, productUrl: `https://shop.example.com/products/${slug}`, retailer: 'Example' });
        return [listing('Nylon Bomber Jacket', 'bomber'), listing('Cotton Twill Overshirt', 'overshirt'), listing('Canvas Chore Jacket', 'chore')];
      }
    });
    try {
      const stub = provider({ searchStatus: 429 });
      const intent = local('a shirt that looks like a jacket');
      const found = await withProvider(stub, () => search(intent, 12));
      assert.strictEqual(found.provider, 'serper');
      assert.strictEqual(found.fellBackFrom.provider, 'openwebninja');
      assert.strictEqual(stub.calls.search.length, 1, 'the primary was asked more than once');
      assert.deepStrictEqual(asked, [queryFrom(intent)], 'the fallback was not asked the same phrase, once');
      assert.deepStrictEqual(found.products.map((p) => p.name), ['Cotton Twill Overshirt', 'Canvas Chore Jacket', 'Nylon Bomber Jacket']);
    } finally {
      productSource.registerProvider(realSerper);
    }
  });

  await test('a quota refusal without a fallback still fails the search, with no second request', async () => {
    const stub = provider({ searchStatus: 429 });
    await assert.rejects(withProvider(stub, () => search(local('something like a hoodie but cleaner'), 12)), /429/);
    assert.strictEqual(stub.calls.search.length, 1);
  });

  await test('a record that best matches the concepts is still refused by every gate it fails', async () => {
    const record = (id, title, photo) => ({ product_id: id, product_title: title, product_photos: [photo || `https://img.example-cdn.com/${id}.jpg`], product_page_url: `https://www.google.com/shopping/product/${id}` });
    const records = [
      record('r-http', 'Cotton Twill Overshirt Olive', 'http://img.example-cdn.com/insecure.jpg'),
      record('r-google', 'Wool Overshirt Charcoal'),
      record('r-redirect', 'Canvas Chore Jacket Navy'),
      record('r-noprice', 'Corduroy Shirt Jacket Brown'),
      record('r-good', 'Heavy Twill Shirt Jacket Black')
    ];
    const offers = {
      'r-http': { store_name: 'a.com', price: '$80', offer_page_url: 'https://www.a.com/products/r-http' },
      'r-google': { store_name: 'google', price: '$80', offer_page_url: 'https://www.google.com/shopping/product/1' },
      'r-redirect': { store_name: 'b.com', price: '$80', offer_page_url: 'https://www.b.com/redirect?url=https://elsewhere.com/x' },
      'r-noprice': { store_name: 'c.com', offer_page_url: 'https://www.c.com/products/r-noprice' },
      'r-good': { store_name: 'e.com', price: '$95', offer_page_url: 'https://www.e.com/products/r-good' }
    };
    const stub = provider({ records, offerFor: (id) => offers[id] });
    const found = await withProvider(stub, () => search(local('a shirt that looks like a jacket'), 12));
    assert.deepStrictEqual(found.products.map((p) => p.name), ['Heavy Twill Shirt Jacket Black']);
    /* the http photo is refused before a lookup is spent on it, by the
       gate's own reason, and so reaches the gate with no price at all */
    assert.strictEqual(found.funnel.offers.skippedUnfit['image-url-not-https'], 1, JSON.stringify(found.funnel.offers.skippedUnfit));
    assert.ok(found.rejected['missing-price'] >= 1, JSON.stringify(found.rejected));
    /* the Google and redirect links never become a link at all */
    const refused = Object.values(found.rejected).reduce((sum, n) => sum + n, 0);
    assert.strictEqual(refused, 4, JSON.stringify(found.rejected));
  });

  await test('stock is still the gate\'s to judge: an out-of-stock record that best matches is refused, then nothing is reordered back in', () => {
    const intent = local('a shirt that looks like a jacket');
    const records = [
      { title: 'Flannel Overshirt Black', price: 70, imageUrl: 'https://img.example.com/a.jpg', productUrl: 'https://shop.example.com/products/a', retailer: 'x', availability: 'out of stock' },
      { title: 'Nylon Bomber Jacket', price: 70, imageUrl: 'https://img.example.com/b.jpg', productUrl: 'https://shop.example.com/products/b', retailer: 'x' }
    ];
    const { products, rejected } = productSource.verifyAll(records, {});
    assert.strictEqual(rejected['out-of-stock'], 1);
    assert.deepStrictEqual(rankByIntent(products, intent).products.map((p) => p.name), ['Nylon Bomber Jacket']);
  });

  await test('the gate is the gate for both kinds of request: the same records verify the same way', () => {
    const records = POOL.slice(0, 20).map((item) => ({ title: item.title, price: item.price, imageUrl: `https://img.example.com/${item.id}.jpg`, productUrl: `https://www.${item.store}/products/${item.id}`, retailer: item.store }));
    records.push({ title: 'No Photo Overshirt', price: 50, productUrl: 'https://shop.example.com/products/x', retailer: 'x' });
    const a = productSource.verifyAll(records, {});
    const b = productSource.verifyAll(records, {});
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.rejected['missing-image-url'], 1);
  });

  console.log('\n  — what the page says it is looking for while a search runs\n');

  const says = (query, vocab) => Interpreter.describe(Interpreter.localInterpret(query, vocab || {}), query);

  await test('an exact request is said back in the shopper\'s own words, budget included', () => {
    assert.strictEqual(says('black oversized hoodie under $80'), 'Looking for black oversized hoodies under $80');
    assert.strictEqual(says('cream linen midi dress for summer'), 'Looking for cream linen midi dresses');
    assert.strictEqual(says('vintage Prada bag under $500', { brands: ['Prada'] }), 'Looking for vintage Prada bags under $500');
    assert.strictEqual(says('loose black pants'), 'Looking for loose black pants');
    assert.strictEqual(says("women's black blazer under $150"), 'Looking for women\u2019s black blazers under $150');
    assert.strictEqual(says('$50-$100 jeans'), 'Looking for jeans between $50 and $100');
  });

  await test('a descriptive request is said as the concepts it was read as', () => {
    assert.strictEqual(says('something like a hoodie but cleaner'), 'Looking for minimal quarter-zips, crewneck sweatshirts or knit pullovers');
    assert.strictEqual(says('a shirt that looks like a jacket'), 'Looking for overshirts, shirt jackets or chore jackets');
    assert.strictEqual(says('loose black pants that look nice'), 'Looking for black wide-leg, relaxed or pleated trousers');
    assert.strictEqual(says('a bag that looks vintage but not crazy expensive'), 'Looking for vintage-style shoulder or top-handle bags');
  });

  await test('a garment named only as the setting is said as the setting, never as the thing looked for', () => {
    assert.strictEqual(says('something cozy I can wear with jeans'), 'Looking for cozy sweaters, sweatshirts or cardigans to wear with jeans');
    assert.strictEqual(says('that short jacket thing people wear over shirts'), 'Looking for cropped jackets, overshirts or shirt jackets to wear over shirts');
    assert.strictEqual(says('something comfy to wear with my baggy black jeans'), 'Looking for cozy sweaters, sweatshirts or cardigans to wear with jeans');
    assert.strictEqual(says('a white tee to wear under a blazer'), 'Looking for white tees to wear under blazers');
  });

  await test('a request with nothing understood about it gets nothing said about it', () => {
    /* "nice" and "dinner" are understood, and said as they were meant */
    assert.strictEqual(says('something nice for dinner'), 'Looking for dressy dinner pieces');
    assert.strictEqual(says('something like what my mom wears'), null);
    assert.strictEqual(Interpreter.describe(null, ''), null);
    assert.strictEqual(Interpreter.describe(Interpreter.EMPTY(), 'anything'), null);
  });

  await test('what is said is never more than was read: no counts, no internals, no invented budget', () => {
    for (const query of ['black oversized hoodie under $80', 'something like a hoodie but cleaner', 'something cozy I can wear with jeans', 'a bag that looks vintage but not crazy expensive', 'a dress that\'s simple but not too formal', 'navy quarter zip pullover']) {
      const line = says(query) || '';
      assert.ok(!/[{}[\]]|concept|intent|undefined|null|neutral|earth|pastel/i.test(line), line);
      assert.ok(!/\d/.test(line.replace(/\$\d+(\.\d+)?/g, '')), `a number that is not a price: ${line}`);
      const prices = (line.match(/\$\d+/g) || []);
      prices.forEach((price) => assert.ok(query.includes(price), `${price} was never stated`));
    }
    /* a colour family the catalogue files under is never said as a
       colour: the shopper's own word is, when they used one */
    assert.strictEqual(Interpreter.describe({ colors: ['Neutral'], garments: ['coat'] }, 'a beige coat'), 'Looking for beige coats');
    assert.strictEqual(Interpreter.describe({ colors: ['Neutral'], garments: ['coat'] }, 'a coat in a muted tone'), 'Looking for coats');
  });

  console.log('\n  — the response, and what stays out of scope\n');

  await test('/api/search answers a descriptive request with verified products only, says it reordered, and meters one search', async () => {
    const meter = require('../api/_meter');
    const realSpend = meter.spend;
    const spends = [];
    meter.spend = async (identity, metric, amount) => { spends.push([metric, amount]); return realSpend(identity, metric, amount); };
    const res = { statusCode: null, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.end = () => res;
    try {
      const stub = provider();
      const intent = Interpreter.localInterpret('something like a hoodie but cleaner', {});
      await withProvider(stub, () => searchApi({ method: 'POST', headers: {}, body: { intent, limit: 12 }, on: () => {} }, res));
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.products.length > 0);
      for (const product of res.body.products) for (const key of Object.keys(product)) assert.ok(GATE_FIELDS.has(key), key);
      assert.strictEqual(res.body.diagnostics.reorderedByIntent, true);
      assert.ok(!/"score"|percent/i.test(JSON.stringify(res.body)));
      assert.deepStrictEqual(spends, [['searches', 1]]);
      assert.strictEqual(stub.calls.search.length, 1);
    } finally {
      meter.spend = realSpend;
    }
  });

  await test('Discover still loads neither the interpreter nor the search, so nothing here can reach it', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'discover.html'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(!scripts.some((src) => /interpret|search/.test(src)), scripts.join(', '));
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
