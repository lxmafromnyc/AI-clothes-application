#!/usr/bin/env node
/* =========================================================
   Fynd — messy input: regression tests

   People describe clothes badly: misspelled, in slang, in fragments,
   with "not this" and "like that but", around a garment they only mean
   as the setting. Each test below is a way that used to go wrong, held
   to what it must do now:

     * the request is put in one plain form first — contractions opened,
       slang and plain misspellings fixed — without changing a word that
       only looks like a misspelling
     * what is ruled out stays ruled out: never searched, never a target,
       a listing that IS it removed, one that merely has its fit or
       colour ranked last
     * "like" compares only when it compares; "isn't really a jacket"
       compares with a jacket rather than ruling it out
     * the talk comes out of the search; nothing is added that was not
       said
     * a request in shop words is read exactly as before

   No network. Usage: node scripts/test-messy.js
   ========================================================= */

'use strict';

const assert = require('assert');

process.env.FYND_CACHE = 'off';
['PRODUCT_SOURCE', 'SERPER_API_KEY', 'SERPAPI_API_KEY', 'AI_PROVIDER'].forEach((key) => { delete process.env[key]; });

require('../assets/interpret.js');
const I = globalThis.Interpreter;
const { shapeIntent, searchWithFallback } = require('../api/search');
const { interpretQuery } = require('../api/interpret');
const { queryFrom } = require('../api/_providers/query');
const { withoutContradictions } = require('../api/_providers/garment-filter');
const { rankByIntent } = require('../api/_providers/relevance');
const productSource = require('../api/_providers/product-source');
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

const read = (query) => I.readConcepts(query);
const local = (query) => shapeIntent(I.localInterpret(query, {}));
const phrase = (query) => queryFrom(local(query));
const says = (query) => I.describe(I.localInterpret(query, {}), query);
const filtered = (query, titles) => withoutContradictions(titles.map((name) => ({ name })), local(query));
const ranked = (query, titles) => rankByIntent(titles.map((name) => ({ name, price: 50 })), local(query)).products.map((p) => p.name);

/* the served reading, with the model answering whatever a model might —
   including the very words the shopper ruled out */
async function served(query, model) {
  const saved = { fetch: global.fetch, key: process.env.OPENAI_API_KEY };
  process.env.OPENAI_API_KEY = 'sk-test';
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(model || {}) } }], usage: { total_tokens: 10 } }) });
  try {
    const reading = await interpretQuery({ query, vocabulary: {} });
    return shapeIntent(reading.preferences);
  } finally {
    global.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.key;
  }
}

/* the provider, stubbed with the benchmark's pool */
function provider() {
  const calls = { search: [], offers: [], other: [] };
  const byId = new Map(POOL.map((item) => [item.id, item]));
  const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  const fetch = async (input) => {
    const url = new URL(String(input && input.url ? input.url : input));
    if (url.pathname.endsWith('/search')) {
      calls.search.push(url.searchParams.get('q'));
      return reply({ status: 'OK', data: searchPool(url.searchParams.get('q'), { limit: 24, max: Number(url.searchParams.get('max_price')) || 0 }) });
    }
    if (url.pathname.endsWith('/product-offers')) {
      const item = byId.get(url.searchParams.get('product_id'));
      calls.offers.push(item && item.id);
      return reply({ status: 'OK', data: { offers: item ? [{ store_name: item.store, price: `$${item.price}`, offer_page_url: `https://www.${item.store}/products/${item.id}` }] : [] } });
    }
    calls.other.push(url.href);
    throw new Error(`no stand-in for ${url.href}`);
  };
  return { fetch, calls };
}
async function search(query) {
  const stub = provider();
  const saved = { fetch: global.fetch, key: process.env.OPENWEBNINJA_API_KEY };
  global.fetch = stub.fetch;
  process.env.OPENWEBNINJA_API_KEY = 'test-key';
  try {
    const found = await searchWithFallback(productSource.getProvider(), local(query), 12, cache.counters(), Date.now() + 60000);
    return { found, calls: stub.calls };
  } finally {
    global.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.OPENWEBNINJA_API_KEY; else process.env.OPENWEBNINJA_API_KEY = saved.key;
  }
}

async function main() {
  console.log('\n  — what was typed, made readable\n');

  await test('contractions are opened, so the "not" in them can be seen', () => {
    assert.strictEqual(I.normalize("pants that aren't skinny").text, 'pants that are not skinny');
    assert.strictEqual(I.normalize('jacket that isnt really a jacket').text, 'jacket that is not really a jacket');
    assert.strictEqual(I.normalize("i don't want a coat").text, 'i do not want a coat');
  });

  await test('plain misspellings of known words are corrected', () => {
    const fixes = { 'blak hoddie': 'black hoodie', 'oversize sweter': 'oversize sweater', 'lether jaket': 'leather jacket', cardigen: 'cardigan', 'sneekers white': 'sneakers white', 'grey sweatshrit': 'grey sweatshirt', 'jeens': 'jeans', 'pnats loose': 'pants loose', 'womens dres for a weding': 'womens dress for a wedding' };
    for (const [typed, meant] of Object.entries(fixes)) assert.strictEqual(I.normalize(typed).text, meant, typed);
  });

  await test('a word that only looks like a misspelling is left alone', () => {
    for (const fine of ['heather grey tee', 'dressed up', 'a boat neck top', 'pocket tee', 'sweeter than', 'cotton button down', 'shift dress', 'wedding guest dress', 'skater jeans']) {
      assert.strictEqual(I.normalize(fine).text, fine, fine);
    }
  });

  await test('slang and shorthand are said in shop words', () => {
    assert.strictEqual(I.normalize('trackies').text, 'track pants');
    assert.strictEqual(I.normalize('kicks for school').text, 'sneakers for school');
    assert.strictEqual(I.normalize('a top w/o sleeves').text, 'a top without sleeves');
    assert.strictEqual(I.normalize('idk like a loose clean jacket').text, 'like a loose clean jacket');
  });

  await test('how a request is asked comes off the front; what it asks for stays', () => {
    assert.strictEqual(I.normalize('find me a green oversized hoodie under $80').text, 'a green oversized hoodie under $80');
    assert.strictEqual(I.normalize("i'm looking for black jeans").text, 'black jeans');
    assert.strictEqual(I.normalize('can you show me a linen shirt').text, 'a linen shirt');
    assert.strictEqual(read('find me a green oversized hoodie under $80'), null, 'a shop-word request behind a preamble is still a shop-word request');
  });

  console.log('\n  — what is ruled out stays ruled out\n');

  await test('a fit ruled out is never searched, and leaves what it leaves', () => {
    const skinny = read('pants that arent skinny');
    assert.deepStrictEqual(skinny.without, ['skinny']);
    assert.deepStrictEqual(skinny.search, ['straight leg pants', 'relaxed trousers', 'wide leg pants']);
    assert.ok(!/skinny|slim/.test(phrase('pants that arent skinny')));
    const baggy = read('not too baggy black pants');
    assert.deepStrictEqual(baggy.without, ['baggy']);
    assert.ok(!/baggy|wide|palazzo/.test(phrase('not too baggy black pants')), phrase('not too baggy black pants'));
    assert.ok(/^black /.test(phrase('not too baggy black pants')));
  });

  await test('a garment ruled out is never the target, never searched, and its listings are removed', () => {
    const c = read('something warm but not a coat');
    assert.deepStrictEqual(c.excluded, ['coat']);
    assert.deepStrictEqual(local('something warm but not a coat').garments, []);
    assert.ok(!/coat/.test(phrase('something warm but not a coat')));
    const r = filtered('something warm but not a coat', ['Wool Overcoat Camel', 'Long Puffer Coat Black', 'Hooded Parka Olive', 'Quilted Jacket Black', 'Crewneck Sweatshirt Grey', 'Fleece Pullover Grey']);
    assert.deepStrictEqual(r.removed.map((x) => x.name), ['Wool Overcoat Camel', 'Long Puffer Coat Black', 'Hooded Parka Olive']);
    assert.ok(r.removed.every((x) => x.kind === 'ruled-out'));
    assert.deepStrictEqual(filtered('pants not jeans', ['Black Straight Leg Jeans', 'Straight Leg Trousers Black']).removed.map((x) => x.name), ['Black Straight Leg Jeans']);
  });

  await test('"a hoodie without the hood" is a sweatshirt, and no hoodie is searched or shown', () => {
    const c = read('something like a hoodie without the hood');
    assert.deepStrictEqual(c.search, ['crewneck sweatshirt', 'pullover sweatshirt', 'knit pullover']);
    assert.ok(!/hood|without/.test(phrase('something like a hoodie without the hood')));
    const r = filtered('something like a hoodie without the hood', ['Hooded Sweatshirt Grey', 'Black Hoodie Pullover', 'Grey Crewneck Sweatshirt']);
    assert.deepStrictEqual(r.products.map((p) => p.name), ['Grey Crewneck Sweatshirt']);
  });

  await test('a colour, material or logo ruled out is never searched, and those listings rank last', () => {
    assert.ok(!/black/.test(phrase('a dress that isnt black')));
    assert.deepStrictEqual(ranked('a dress that isnt black', ['Black Shift Dress', 'Navy Shift Dress']), ['Navy Shift Dress', 'Black Shift Dress']);
    assert.ok(!/leather/.test(phrase('a jacket thats not leather')));
    assert.deepStrictEqual(ranked('a jacket thats not leather', ['Leather Biker Jacket', 'Denim Jacket']), ['Denim Jacket', 'Leather Biker Jacket']);
    assert.deepStrictEqual(ranked('my boyfriend wants a hoodie but he hates logos', ['Logo Print Hoodie', 'Essential Hoodie']), ['Essential Hoodie', 'Logo Print Hoodie']);
  });

  await test('nothing ruled out reaches the provider, whatever the model read', async () => {
    const asked = queryFrom(await served('pants that arent skinny', { categories: ['trousers'], fits: ['Slim'], keywords: ['skinny'] }));
    assert.ok(!/skinny|slim/.test(asked), asked);
    const coat = queryFrom(await served('something warm but not a coat', { categories: ['coat'], keywords: ['warm', 'not a coat'] }));
    assert.ok(!/coat/.test(coat), coat);
    const black = queryFrom(await served('a dress that isnt black', { colors: ['Black'], categories: ['dress'] }));
    assert.ok(!/black/.test(black), black);
  });

  await test('"less loud" is quieter, never "loud"; "less than $50" rules nothing out', () => {
    assert.ok(read('a jacket like a bomber but less loud').signals.includes('minimal'));
    assert.ok(!/loud/.test(phrase('a jacket like a bomber but less loud')), phrase('a jacket like a bomber but less loud'));
    assert.deepStrictEqual((read('something cozy for less than $50') || { without: [] }).without, []);
  });

  await test('"isn\'t really a jacket" compares with a jacket rather than ruling one out', () => {
    const c = read('jacket that isnt really a jacket');
    assert.strictEqual(c.mode, 'comparative');
    assert.deepStrictEqual(c.excluded, []);
    assert.ok(c.alternatives.includes('overshirt') && c.alternatives.includes('shirt jacket'));
  });

  await test('"don\'t want to look too dressed up" reads as casual, not as dressy', () => {
    const c = read('i need a shirt for a wedding but i dont want to look too dressed up');
    assert.ok(c.signals.includes('casual'));
    assert.ok(!/dressed|dressy/.test(phrase('i need a shirt for a wedding but i dont want to look too dressed up')));
  });

  console.log('\n  — comparing, describing, and the talk around it\n');

  await test('"like" compares only when it compares', () => {
    assert.strictEqual(read('something like a hoodie but cleaner').mode, 'comparative');
    assert.strictEqual(read('like a cardigan but more structured').anchor, 'cardigan');
    /* a pause, not a comparison: the jacket is what is wanted */
    const filler = read('idk like a loose clean jacket');
    assert.strictEqual(filler.mode, 'described');
    assert.strictEqual(filler.anchor, 'jacket');
    assert.ok(!/tailored|blazer/.test(phrase('idk like a loose clean jacket')), 'a loose jacket is not a tailored one');
  });

  await test('"the same vibe as" compares, and "but thinner" says how', () => {
    const c = read('i want the same vibe as a sweatshirt but thinner');
    assert.strictEqual(c.anchor, 'sweatshirt');
    assert.deepStrictEqual(c.properties, ['lightweight']);
    assert.ok(/^lightweight sweatshirt/.test(phrase('i want the same vibe as a sweatshirt but thinner')));
  });

  await test('"a shirt but heavier" is a heavyweight shirt, and a heavyweight tee is not removed as another garment', () => {
    assert.strictEqual(phrase('a shirt but heavier'), 'heavyweight shirt');
    const r = filtered('a shirt but heavier', ['Heavyweight Tee Black', 'Heavyweight Cotton Shirt Ecru', 'Wool Overcoat Camel']);
    assert.deepStrictEqual(r.products.map((p) => p.name), ['Heavyweight Tee Black', 'Heavyweight Cotton Shirt Ecru']);
  });

  await test('"warm weather" is a season and "light blue" a colour, not how heavy a thing is', () => {
    assert.deepStrictEqual((read('a dress for warm weather') || { properties: [] }).properties, []);
    assert.ok(!/lightweight/.test(phrase('i want a light blue shirt thats kinda oversized')));
  });

  await test('"fitted arms" is a sleeve, not a fit', () => {
    const c = read('oversized tee but fitted arms');
    assert.deepStrictEqual(c.fit, ['oversized']);
    assert.strictEqual(phrase('oversized tee but fitted arms'), 'oversized tee');
  });

  await test('a contradiction is not settled by picking a side', () => {
    const fit = read('oversized but fitted shirt');
    assert.deepStrictEqual(fit.ambiguous, ['fit']);
    assert.ok(!/oversized|fitted|slim/.test(phrase('oversized but fitted shirt')), phrase('oversized but fitted shirt'));
    const colour = read('black but not too dark jacket');
    assert.deepStrictEqual(colour.ambiguous, ['colour']);
    assert.ok(/black jacket/.test(phrase('black but not too dark jacket')));
  });

  await test('how a thing should LOOK is never what it costs', () => {
    const c = read('old looking bag but expensive looking');
    assert.ok(c.signals.includes('vintage') && c.signals.includes('polished'));
    assert.ok(!c.signals.includes('affordable'));
    assert.strictEqual(local('old looking bag but expensive looking').maxPrice, null);
    assert.ok(!/expensive|old|looking/.test(phrase('old looking bag but expensive looking')));
    const both = read('cheap but expensive looking bag');
    assert.ok(both.signals.includes('affordable') && both.signals.includes('polished'));
  });

  await test('the talk comes out of the search, and nothing is added that was not said', () => {
    const cases = {
      'i want a shirt thats kinda oversized': 'oversized shirt',
      'women black thing long sleeve cheap': 'women black long-sleeve',
      /* a style is worn as clothing: "skater style outfit" finds costumes */
      'something like what skaters wear': 'skater style clothing',
      'dress for going out but casual': 'going out casual dress',
      'gift for my dad': 'men gift'
    };
    for (const [query, asked] of Object.entries(cases)) assert.strictEqual(phrase(query), asked, query);
  });

  await test('who it is for is read only when the request says so', () => {
    assert.strictEqual(read('gift for my dad').gender, 'men');
    assert.strictEqual(read('my boyfriend wants a hoodie but he hates logos').gender, 'men');
    assert.strictEqual(read('something like what my mom wears').gender, null, 'a style reference is not a recipient');
  });

  await test('all talk and nothing to search: a broad search, never the talk', () => {
    assert.strictEqual(phrase('something like what my mom wears'), '');
    assert.strictEqual(phrase('anything under $30'), '');
    assert.strictEqual(local('anything under $30').maxPrice, 30);
    for (const query of ['something nice for dinner', 'something for a party', 'outfit for a date']) {
      assert.ok(!/\bdress(es)?\b|\bblack\b|\bheels?\b/.test(phrase(query)), `${query}: ${phrase(query)}`);
    }
  });

  console.log('\n  — what the page says, and what the search costs\n');

  await test('what the page says never states a ruled-out thing as wanted', () => {
    assert.strictEqual(says('pants that arent skinny'), 'Looking for straight-leg pants, relaxed trousers or wide-leg pants, not skinny');
    assert.strictEqual(says('not too baggy black pants'), 'Looking for black straight-leg pants or tailored trousers, not baggy');
    assert.strictEqual(says('something warm but not a coat'), 'Looking for warm sweaters, fleece jackets or overshirts, not coats');
    assert.strictEqual(says('something like a hoodie without the hood'), 'Looking for crewneck sweatshirts, pullover sweatshirts or knit pullovers, without hoods');
    assert.strictEqual(says('blak hoddie'), 'Looking for black hoodies');
  });

  await test('every messy request is still one provider search, its lookups inside the existing ceiling', async () => {
    for (const query of ['pants that arent skinny', 'something warm but not a coat', 'blak hoddie', 'i want a shirt thats kinda oversized', 'something like what my mom wears']) {
      cache.reset();
      const { calls } = await search(query);
      assert.strictEqual(calls.search.length, 1, query);
      assert.ok(calls.offers.length <= 20, `${query}: ${calls.offers.length} lookups`);
      assert.deepStrictEqual(calls.other, []);
    }
  });

  await test('a ruled-out listing never reaches the page, and a ruled-out fit is never above a wanted one', async () => {
    /* a provider that offers coats anyway: they pass the gate, and are
       removed after it, counted as ruled out by the request */
    const listing = (title, slug) => ({ title, price: 90, imageUrl: `https://img.example.com/${slug}.jpg`, productUrl: `https://shop.example.com/products/${slug}`, retailer: 'Example' });
    productSource.registerProvider({
      name: 'coat-offering-stand-in',
      configured: () => true,
      search: async () => [listing('Wool Overcoat Camel', 'overcoat'), listing('Fleece Pullover Grey', 'fleece'), listing('Long Puffer Coat Black', 'puffer-coat'), listing('Chunky Knit Sweater', 'sweater')]
    });
    const coat = await searchWithFallback(productSource.PROVIDERS['coat-offering-stand-in'], local('something warm but not a coat'), 12, cache.counters(), Date.now() + 60000);
    assert.deepStrictEqual(coat.products.map((p) => p.name).sort(), ['Chunky Knit Sweater', 'Fleece Pullover Grey']);
    assert.strictEqual(coat.rejected['ruled-out-by-the-request'], 2);
    const skinny = await search('jeans but not skinny');
    const names = skinny.found.products.map((p) => p.name);
    const firstSkinny = names.findIndex((n) => /skinny/i.test(n));
    assert.ok(firstSkinny === -1 || names.slice(firstSkinny).every((n) => /skinny/i.test(n)), names.join(' | '));
  });

  console.log('\n  — a request in shop words is read exactly as before\n');

  await test('exact requests are not messy, and ask what they always asked', async () => {
    const before = {
      'black oversized hoodie under $80': 'black oversized hoodie under $80',
      'cream linen midi dress for summer': 'white linen midi dress cream for summer',
      'vintage Prada bag under $500': 'vintage prada bag under $500',
      'brown pants under 100': 'trousers brown pants under 100',
      'black pants loose': 'black relaxed trousers pants loose',
      'navy quarter zip pullover': 'blue sweater navy quarter zip pullover'
    };
    for (const [query, asked] of Object.entries(before)) {
      assert.strictEqual(read(query), null, query);
      assert.strictEqual(phrase(query), asked, query);
      assert.ok(!('concepts' in (await served(query, {})) && (await served(query, {})).concepts), query);
    }
  });

  await test('the exact path\'s filter is untouched: no new removals, no widening', () => {
    const titles = ['Chunky Knit Beanie', 'Black Oversized Hoodie', 'Crewneck Sweatshirt'];
    assert.deepStrictEqual(filtered('black oversized hoodie', titles).products.map((p) => p.name), ['Black Oversized Hoodie']);
    assert.deepStrictEqual(filtered('linen shirt for summer', ['Linen Shirt White', 'Linen Tee White']).products.map((p) => p.name), ['Linen Shirt White']);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
