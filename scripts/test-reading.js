#!/usr/bin/env node
/* =========================================================
   Fynd — a model's reading, held to what the shopper said

   Offline tests of api/_reading.js through the real interpreter path:
   each request goes through interpretQuery() with OpenAI answered by a
   stand-in — the kind of answer a real model gives, mistakes included —
   and then through /api/search's own intent shaping and query builder,
   so what is checked is the phrase OpenWeb Ninja would actually be
   asked, not an intermediate object.

     inventions     a colour, brand, budget, gender, season, style,
                    occasion or garment nobody said is never kept
     roles          what the shopper wants is told apart from what they
                    compare it to, wear it with, and rule out
     understanding  where the page's tables are blind, the model's
                    checked reading is what is searched
     exact          a request that named its garment in shop words is
                    answered exactly as it was before any of this
     cost           one request is still one provider search

   Usage: node scripts/test-reading.js
   ========================================================= */

'use strict';

const assert = require('assert');
const path = require('path');

process.env.AUTH_SECRET = 'reading-test-secret-of-sufficient-length';
const interpret = require('../api/interpret');
const reading = require('../api/_reading');
const { shapeIntent, searchWithFallback, requestBudget } = require('../api/search');
const { queryFrom } = require('../api/_providers/query');
const cache = require('../api/_cache');

require(path.join(__dirname, '..', 'assets', 'interpret.js'));
const Interpreter = globalThis.Interpreter;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`); }
}

/* the catalogue's filing, as the page sends it */
const VOCABULARY = {
  categories: ['knit', 'tee', 'shirt', 'jacket', 'coat', 'dress', 'skirt', 'trousers', 'shoes'],
  colors: ['Black', 'White', 'Neutral', 'Green', 'Earth', 'Bright', 'Blue', 'Pastel'],
  occasions: ['Everyday', 'Work', 'Evening', 'Wedding', 'Vacation'],
  fits: ['Relaxed', 'Oversized', 'Slim', 'Regular'],
  brands: ['UNIQLO', 'ZARA', 'Nike'],
  styles: ['Minimal', 'Classic', 'Streetwear', 'Formal', 'Casual', 'Vintage']
};

const EMPTY = { categories: [], colors: [], occasions: [], fits: [], brands: [], styles: [], maxPrice: null, minPrice: null, season: null, gender: null, keywords: [] };
const NO_READING = { want: null, alternatives: [], comparedTo: null, wornWith: [], avoid: [], fit: [], material: [], style: [], occasion: null };
const answer = (flat, read) => Object.assign({}, EMPTY, flat, { reading: Object.assign({}, NO_READING, read || {}) });

/* one request through the real interpreter, OpenAI answered with `raw` */
async function readWith(query, raw) {
  const realFetch = global.fetch;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-not-real';
  global.fetch = async (url) => {
    if (!String(url).startsWith('https://api.openai.com/')) throw new Error(`unexpected request ${url}`);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(raw) } }], usage: { total_tokens: 900 } }), text: async () => '' };
  };
  try {
    const read = await interpret.interpretQuery({ query, vocabulary: VOCABULARY });
    assert.ok(read.ok, `the interpreter failed: ${read.reason}`);
    const intent = shapeIntent(read.preferences);
    return { prefs: read.preferences, understood: read.understood, intent, asked: queryFrom(intent) };
  } finally {
    global.fetch = realFetch;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  }
}

const words = (phrase) => new Set(String(phrase).toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean));
const asks = (phrase, word) => words(phrase).has(word);

async function main() {
  console.log('\nthe reading is held to its shape');

  await test('unknown keys, non-strings, blanks and overlong values are dropped; lists are capped', () => {
    const shaped = reading.shapeReading({
      want: '  Hoodie ', alternatives: ['a', 'b', 'c', 'd', 42, ''], comparedTo: { x: 1 }, wornWith: 'jeans',
      avoid: ['coat', 'x'.repeat(80)], fit: [], material: null, style: ['skate', 'vintage', 'boho'], occasion: 7, hallucinated: 'yes'
    });
    assert.deepStrictEqual(shaped, {
      want: 'hoodie', comparedTo: null, occasion: null,
      alternatives: ['a', 'b', 'c'], wornWith: ['jeans'], avoid: ['coat'], fit: [], material: [], style: ['skate', 'vintage']
    });
    assert.strictEqual(reading.shapeReading({}), null);
    assert.strictEqual(reading.shapeReading('hoodie'), null);
  });

  await test('the reading never reaches the browser: only checked concepts do', async () => {
    const r = await readWith('black oversized hoodie under $80', answer({ categories: ['knit'], colors: ['Black'], fits: ['Oversized'], keywords: ['hoodie'] }, { want: 'hoodie' }));
    assert.strictEqual(r.prefs.reading, undefined);
    assert.ok(!('hallucinated' in r.prefs));
  });

  console.log('\nnothing is kept that was not said');

  await test('"something nice for dinner": no dress, no black, no heels, no "women" — the search stays broad', async () => {
    const r = await readWith('something nice for dinner', answer(
      { categories: ['dress'], colors: ['Black'], styles: ['Formal'], occasions: ['Evening'], gender: 'women', keywords: ['nice', 'dinner', 'dress'] },
      { want: 'dress', alternatives: ['dress', 'heels', 'blouse'], occasion: 'dinner', style: ['elevated'] }
    ));
    for (const invented of ['dress', 'heels', 'heel', 'black', 'women', 'blouse', 'formal']) assert.ok(!asks(r.asked, invented), `asked "${r.asked}"`);
    assert.deepStrictEqual([r.prefs.colors, r.prefs.gender, r.prefs.categories], [[], null, []]);
    assert.ok(r.understood.rejected.some((why) => /garment the words do not point at/.test(why)), r.understood.rejected.join(' | '));
    /* what was said stands: the occasion */
    assert.deepStrictEqual(r.prefs.occasions, ['Evening']);
  });

  await test('a brand nobody typed is dropped; one typed, even misspelled, is kept', async () => {
    const invented = await readWith('running shoes for a marathon', answer({ brands: ['Nike'], keywords: ['running', 'shoes'] }));
    assert.deepStrictEqual(invented.prefs.brands, []);
    assert.ok(!asks(invented.asked, 'nike'), invented.asked);
    const typed = await readWith('uniqllo fleece hoodie', answer({ brands: ['UNIQLO'], keywords: ['fleece', 'hoodie'] }));
    assert.deepStrictEqual(typed.prefs.brands, ['UNIQLO']);
  });

  await test('gender only when the words say so — "for my girlfriend" does, "black hoodie" does not', async () => {
    const said = await readWith('hoodie for my girlfriend', answer({ gender: 'women', keywords: ['hoodie'] }));
    assert.strictEqual(said.prefs.gender, 'women');
    const unsaid = await readWith('black hoodie', answer({ gender: 'women', colors: ['Black'], keywords: ['black', 'hoodie'] }));
    assert.strictEqual(unsaid.prefs.gender, null);
    assert.ok(!asks(unsaid.asked, 'women'), unsaid.asked);
  });

  await test('a budget only when a number was given: "cheap" is not $50, "eighty bucks" is $80', async () => {
    const cheap = await readWith('cheap hoodie', answer({ maxPrice: 50, keywords: ['cheap', 'hoodie'] }));
    assert.strictEqual(cheap.prefs.maxPrice, null);
    const words80 = await readWith('a hoodie for eighty bucks or less', answer({ maxPrice: 80, keywords: ['hoodie'] }));
    assert.strictEqual(words80.prefs.maxPrice, 80);
    const typed = await readWith('hoodie under $80', answer({ maxPrice: 80, keywords: ['hoodie'] }));
    assert.strictEqual(typed.prefs.maxPrice, 80);
  });

  await test('a colour, style or occasion nobody mentioned is dropped; one mentioned stands', async () => {
    const r = await readWith('green oversized hoodie', answer({ colors: ['Green', 'Black'], styles: ['Minimal'], occasions: ['Everyday'], season: 'fall', fits: ['Oversized'], keywords: ['hoodie'] }));
    assert.deepStrictEqual([r.prefs.colors, r.prefs.styles, r.prefs.occasions, r.prefs.season, r.prefs.fits], [['Green'], [], [], null, ['Oversized']]);
    const said = await readWith('simple grey hoodie for school this fall', answer({ colors: ['Neutral'], styles: ['Minimal'], occasions: ['Everyday'], season: 'fall', keywords: ['hoodie'] }));
    assert.deepStrictEqual([said.prefs.colors, said.prefs.styles, said.prefs.occasions, said.prefs.season], [['Neutral'], ['Minimal'], ['Everyday'], 'fall']);
  });

  console.log('\nwhat is wanted, compared to, worn with and ruled out');

  await test('"something cozy to wear with jeans": jeans is the setting, never the search', async () => {
    const r = await readWith('something cozy to wear with jeans', answer(
      { categories: ['trousers'], keywords: ['cozy', 'jeans'] },
      { want: 'jeans', alternatives: ['sweater', 'sweatshirt', 'cardigan'], wornWith: ['jeans'], style: ['cozy'] }
    ));
    assert.ok(!asks(r.asked, 'jeans') && !asks(r.asked, 'jean'), `asked "${r.asked}"`);
    assert.ok(asks(r.asked, 'sweater'), r.asked);
    assert.ok(!r.prefs.garments.includes('jeans'));
    assert.ok(r.intent.concepts.context.includes('jeans'));
    assert.deepStrictEqual(r.prefs.categories, [], 'jeans\' filing was kept for a setting');
  });

  await test('"pants that aren\'t skinny": skinny is never asked for, and is held as an exclusion', async () => {
    const r = await readWith("pants that aren't skinny", answer(
      { fits: ['Slim'], keywords: ['pants', 'skinny'] },
      { want: 'skinny pants', alternatives: ['skinny jeans', 'straight leg pants', 'wide leg pants'], avoid: ['skinny'] }
    ));
    assert.ok(!asks(r.asked, 'skinny'), `asked "${r.asked}"`);
    assert.deepStrictEqual(r.prefs.fits, []);
    assert.ok(!r.prefs.keywords.includes('skinny'));
    assert.ok(r.intent.concepts.without.includes('skinny'));
  });

  await test('"something like a hoodie without the hood": a hood is never asked for', async () => {
    const r = await readWith('something like a hoodie without the hood', answer(
      { keywords: ['hoodie', 'hood'] },
      { want: 'hooded sweatshirt', alternatives: ['crewneck sweatshirt', 'zip hoodie'], comparedTo: 'hoodie', avoid: ['hood'] }
    ));
    assert.ok(!asks(r.asked, 'hood') && !asks(r.asked, 'hooded'), `asked "${r.asked}"`);
    assert.ok(r.intent.concepts.without.some((w) => /hood/.test(w)));
  });

  await test('"something warm but not a coat": no coat is asked for, and coats are ruled out', async () => {
    const r = await readWith('something warm but not a coat', answer(
      { categories: ['coat'], keywords: ['warm', 'coat'] },
      { alternatives: ['wool coat', 'sweater', 'fleece jacket'], avoid: ['coat'] }
    ));
    assert.ok(!asks(r.asked, 'coat'), `asked "${r.asked}"`);
    assert.ok(r.intent.concepts.drop.includes('coat'));
    assert.deepStrictEqual(r.prefs.categories, []);
  });

  await test('a setting the tables took for the thing is moved out of the search when the model saw it', () => {
    /* a stand-in table that read the setting as the target */
    const table = {
      garments: ['jeans'], descriptors: [],
      concepts: {
        mode: 'described', anchor: 'jeans', alternatives: ['jeans', 'sweater'], search: ['jeans', 'sweater'], signals: [], fit: [], style: null,
        context: [], relations: [], beside: [], avoid: [], colors: [], extra: [], excluded: [], without: [], drop: [], properties: [],
        occasion: null, gender: null, ambiguous: [], terms: []
      }
    };
    const out = reading.reconcile('a sweater that goes with my jeans', Object.assign({}, EMPTY), Object.assign({}, NO_READING, { want: 'sweater', wornWith: ['jeans'] }), table);
    assert.deepStrictEqual(out.preferences.concepts.search, ['sweater']);
    assert.strictEqual(out.preferences.concepts.anchor, null);
    assert.ok(out.preferences.concepts.context.includes('jeans'));
    assert.ok(!out.preferences.garments.includes('jeans'));
  });

  await test('an exclusion needs a negation in the words: the model cannot rule out what was not ruled out', async () => {
    const r = await readWith('black hoodie', answer({ colors: ['Black'], keywords: ['hoodie'] }, { want: 'hoodie', avoid: ['zip', 'grey'] }));
    assert.strictEqual(r.prefs.concepts, undefined);
    const vague = await readWith('idk something cozy', answer({ keywords: ['cozy'] }, { avoid: ['wool'] }));
    assert.ok(!vague.intent.concepts || !vague.intent.concepts.without.includes('wool'));
  });

  console.log('\nwhere the tables are blind, the checked model reading is searched');

  await test('"a hoodie but more tailored": the comparison the tables could not read is searched', async () => {
    const r = await readWith('a hoodie but more tailored', answer(
      { keywords: ['hoodie', 'tailored'] },
      { want: 'tailored zip jacket', alternatives: ['knit zip jacket', 'quarter zip sweater', 'tailored track jacket'], comparedTo: 'hoodie' }
    ));
    assert.strictEqual(r.intent.concepts.mode, 'comparative');
    assert.ok(asks(r.asked, 'zip'), `asked "${r.asked}"`);
    assert.strictEqual(r.understood.by, 'reader+model');
  });

  await test('"a top that shows my shoulders": a kind of the named garment the words point at', async () => {
    const r = await readWith('a top that shows my shoulders', answer({ keywords: ['top', 'shoulders'] }, { want: 'off shoulder top', alternatives: ['off shoulder top', 'one shoulder top'] }));
    assert.ok(asks(r.asked, 'shoulder') && asks(r.asked, 'top'), `asked "${r.asked}"`);
  });

  await test('a kind the words do not point at is not taken: "a dress that isn\'t black" is not narrowed to midi', async () => {
    const r = await readWith("a dress that isn't black", answer({ colors: ['Black'], keywords: ['dress'] }, { want: 'midi dress', alternatives: ['midi dress', 'maxi dress'], avoid: ['black'] }));
    assert.ok(!asks(r.asked, 'midi') && !asks(r.asked, 'maxi') && !asks(r.asked, 'black'), `asked "${r.asked}"`);
    assert.deepStrictEqual(r.prefs.colors, [], 'a ruled-out colour was kept as wanted');
    assert.ok(r.intent.concepts.without.includes('black'));
  });

  await test('"something skaters would wear": the style points at clothes, so the model may name them', async () => {
    const r = await readWith('something skaters would wear', answer(
      { styles: ['Streetwear'], keywords: ['skaters'] },
      { alternatives: ['graphic tee', 'baggy jeans', 'skate shoes'], style: ['skate'] }
    ));
    assert.ok(asks(r.asked, 'tee') || asks(r.asked, 'jeans'), `asked "${r.asked}"`);
    assert.ok(!asks(r.asked, 'outfit'), r.asked);
    assert.strictEqual(r.understood.by, 'model');
  });

  await test('"something to keep my neck warm": the garment the words point at beats the broad "warm" guess', async () => {
    const r = await readWith('something to keep my neck warm', answer({ keywords: ['neck', 'warm'] }, { want: 'scarf', alternatives: ['scarf', 'turtleneck'] }));
    assert.ok(asks(r.asked, 'scarf'), `asked "${r.asked}"`);
  });

  await test('alternatives that are not garments are refused, and never more than three are searched', async () => {
    const r = await readWith('that jacket shirt thing', answer({ keywords: ['jacket', 'shirt'] }, { want: 'vibe', alternatives: ['overshirt', 'outfit', 'shirt jacket', 'chore jacket', 'shacket'] }));
    assert.ok(!asks(r.asked, 'vibe') && !asks(r.asked, 'outfit'), r.asked);
    assert.ok(r.intent.concepts.search.length <= 3);
    assert.ok(r.asked.split(' ').length <= 12, r.asked);
  });

  console.log('\nexact searches are answered exactly as before');

  /* the path before any of this: the model's flat answer, the page's
     garments, the budget from the words */
  const before = (query, raw) => {
    const table = Interpreter.garmentsWanted(query);
    const prefs = Object.assign(interpret.shapePreferences(raw), table.concepts ? { garments: table.garments, descriptors: table.descriptors, concepts: table.concepts } : { garments: table.garments, descriptors: table.descriptors }, interpret.pricesIn(query));
    return { prefs, asked: queryFrom(shapeIntent(prefs)) };
  };
  const EXACT = [
    ['black oversized hoodie under $80', { categories: ['knit'], colors: ['Black'], fits: ['Oversized'], maxPrice: 80, keywords: ['black', 'oversized', 'hoodie'] }, { want: 'oversized hoodie' }],
    ['white sneakers under $120', { categories: ['shoes'], colors: ['White'], maxPrice: 120, keywords: ['white', 'sneakers'] }, { want: 'sneakers' }],
    ['linen shirt for a summer wedding', { categories: ['shirt'], occasions: ['Wedding'], season: 'summer', keywords: ['linen', 'shirt', 'wedding'] }, { want: 'linen shirt', occasion: 'wedding guest' }],
    ['wool coat for winter', { categories: ['coat'], season: 'winter', keywords: ['wool', 'coat'] }, { want: 'wool coat', material: ['wool'] }],
    ['navy slim chinos', { categories: ['trousers'], colors: ['Blue'], fits: ['Slim'], keywords: ['navy', 'chinos'] }, { want: 'chinos', fit: ['slim'] }],
    ['uniqlo green oversized hoodie', { categories: ['knit'], colors: ['Green'], fits: ['Oversized'], brands: ['UNIQLO'], keywords: ['green', 'oversized', 'hoodie'] }, { want: 'hoodie' }]
  ];
  for (const [query, flat, read] of EXACT) {
    await test(`"${query}" is asked exactly as before, with no concepts`, async () => {
      const raw = answer(flat, read);
      const now = await readWith(query, raw);
      const then = before(query, raw);
      assert.strictEqual(now.prefs.concepts, undefined);
      assert.strictEqual(now.asked, then.asked);
      assert.deepStrictEqual(now.prefs, then.prefs);
      assert.strictEqual(now.understood.by, 'exact');
    });
  }

  console.log('\none request is one provider search');

  await test('a messy, model-read request still makes exactly one provider search', async () => {
    for (const [query, raw] of [
      ['something skaters would wear', answer({ keywords: ['skaters'] }, { alternatives: ['graphic tee', 'baggy jeans', 'skate shoes'] })],
      ['something cozy to wear with jeans', answer({ keywords: ['cozy', 'jeans'] }, { alternatives: ['sweater', 'sweatshirt'], wornWith: ['jeans'] })],
      ['that jacket shirt thing', answer({ keywords: ['jacket', 'shirt'] }, { alternatives: ['overshirt', 'shirt jacket', 'chore jacket'] })]
    ]) {
      const r = await readWith(query, raw);
      const realFetch = global.fetch;
      const saved = process.env.OPENWEBNINJA_API_KEY;
      process.env.OPENWEBNINJA_API_KEY = 'own-test-not-real';
      let searches = 0;
      global.fetch = async (url) => {
        if (/\/search\?/.test(String(url))) searches += 1;
        const body = { status: 'OK', data: [] };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      };
      try {
        cache.reset();
        const { getProvider } = require('../api/_providers/product-source');
        await searchWithFallback(getProvider(), r.intent, 12, cache.counters(), Date.now() + requestBudget());
      } finally {
        global.fetch = realFetch;
        if (saved === undefined) delete process.env.OPENWEBNINJA_API_KEY; else process.env.OPENWEBNINJA_API_KEY = saved;
      }
      assert.strictEqual(searches, 1, `${query}: ${searches} provider searches`);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
