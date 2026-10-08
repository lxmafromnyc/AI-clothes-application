#!/usr/bin/env node
/* =========================================================
   Fynd — the live messy benchmark, checked offline

   scripts/bench-messy-live.js spends real searches and real tokens, so
   it had better grade correctly and run end to end the first time it is
   pointed at the real keys. This checks both without either:

     grading   the rules it judges a reading and a product by
     the run   two workers, the page's own reader, the served
               interpreter, /api/search's intent and the whole search,
               with OpenAI and OpenWeb Ninja answered by stand-ins
               loaded into each worker — nothing else is stubbed

   The numbers a stand-in run produces mean nothing; that it produces
   them, one provider search per request, is what is checked.

   Usage: node scripts/test-bench-messy-live.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const bench = require('./bench-messy-live.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`); }
}

const caseFor = (q) => bench.CASES.find((c) => c.q === q);

/* stand-ins for OpenAI and OpenWeb Ninja, loaded into each worker with -r */
const STAND_IN = `
process.env.OPENAI_API_KEY = 'sk-stand-in';
process.env.OPENWEBNINJA_API_KEY = 'stand-in';
const ok = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body, text: async () => JSON.stringify(body) });
global.fetch = async (input) => {
  const u = new URL(String(input && input.url ? input.url : input));
  if (u.hostname === 'api.openai.com') return ok({ choices: [{ message: { content: JSON.stringify({ reading: {} }) } }], usage: { total_tokens: 10 } });
  if (u.hostname !== 'api.openwebninja.com') throw new Error('unexpected request ' + u.hostname);
  if (u.pathname.endsWith('/product-offers')) {
    return ok({ status: 'OK', data: [{ store_name: 'Arket', price: '$70.00', offer_page_url: 'https://www.arket.com/en/product/' + u.searchParams.get('product_id'), product_condition: 'NEW' }] });
  }
  const q = u.searchParams.get('q') || 'thing';
  const data = Array.from({ length: 6 }, (x, n) => Object.assign({
    product_id: 'p' + n + '-' + q.length,
    product_title: (n === 5 ? 'Skinny ' : '') + 'Black ' + q + ' ' + n,
    product_photos: ['https://img.example-cdn.com/p/' + n + '.jpg'],
    product_page_url: 'https://www.google.com/shopping/product/1'
  }, n % 2 ? { price: '$70.00', store_name: 'arket.com' } : { offer: { store_name: 'Nordstrom', price: '$' + (40 + n) + '.00', offer_page_url: 'https://www.nordstrom.com/s/item/' + n + '-' + q.length } }));
  return ok({ status: 'OK', request_id: 'r', data });
};
`;

async function main() {
  console.log('\ngrading');

  await test('a reading is right only with the target, the exclusions and the stated constraints, and nothing invented', () => {
    const c = caseFor('black pants but not skinny');
    const good = bench.gradeReading(c, { asked: 'black straight leg pants', intent: { colors: ['Black'], concepts: { without: ['skinny'] } } });
    assert.ok(good.correct, good.notes.join('; '));
    const searchedOut = bench.gradeReading(c, { asked: 'black skinny pants', intent: { colors: ['Black'], concepts: { without: ['skinny'] } } });
    assert.ok(!searchedOut.correct && !searchedOut.exclusionOk);
    const lostColour = bench.gradeReading(c, { asked: 'straight leg pants', intent: { colors: [], concepts: { without: ['skinny'] } } });
    assert.ok(!lostColour.constraintsOk, 'the stated black was not searched');
    const invented = bench.gradeReading(caseFor('something nice for dinner'), { asked: 'black dress', intent: { colors: ['Black'] } });
    assert.ok(!invented.correct && !invented.constraintsOk && !invented.targetOk);
  });

  await test('a catalogue family stands for the colours it covers, and is invented only when it covers none', () => {
    const c = caseFor('loose black pants that look nice');
    assert.ok(bench.gradeReading(c, { asked: 'black wide leg trousers', intent: { colors: ['Black', 'Neutral'] } }).constraintsOk);
    const bright = bench.gradeReading(c, { asked: 'black wide leg trousers', intent: { colors: ['Bright'] } });
    assert.ok(!bright.constraintsOk, bright.notes.join('; '));
  });

  await test('what it is worn with is not a target; a stated budget must be kept; a gender never stated is invented', () => {
    assert.ok(!bench.gradeReading(caseFor('something cozy to wear with jeans'), { asked: 'cozy jeans', intent: {} }).targetOk);
    assert.ok(!bench.gradeReading(caseFor('tshirt under 30 bucks black'), { asked: 'black t-shirt', intent: { colors: ['Black'], maxPrice: null } }).constraintsOk);
    assert.ok(!bench.gradeReading(caseFor('blak hoddie'), { asked: 'women black hoodie', intent: { colors: ['Black'], gender: 'women' } }).constraintsOk);
    assert.ok(bench.gradeReading(caseFor('women black thing long sleeve cheap'), { asked: 'women black long sleeve top', intent: { colors: ['Black'], gender: 'women' } }).correct);
  });

  await test('a product is wrong for another garment, another colour, the other gender, or anything ruled out', () => {
    const c = caseFor('black pants but not skinny');
    assert.ok(bench.gradeProduct(c, { name: 'Black Wide Leg Pants', price: 50 }).relevant);
    const skinny = bench.gradeProduct(c, { name: 'Black Skinny Pants', price: 50 });
    assert.ok(skinny.wrong && skinny.excluded && skinny.hard.includes('ruled out'));
    const navy = bench.gradeProduct(c, { name: 'Navy Wide Leg Pants', price: 50 });
    assert.ok(navy.wrong && navy.hard.includes('another colour'));
    /* a title that names no colour is counted neither way */
    assert.deepStrictEqual(bench.gradeProduct(c, { name: 'Wide Leg Pants', price: 50 }).hard, []);
    const mens = bench.gradeProduct(caseFor('women black thing long sleeve cheap'), { name: "Men's Black Long Sleeve Tee", price: 20 });
    assert.ok(mens.wrong && mens.hard.includes('the other gender'));
    assert.ok(bench.gradeProduct(caseFor('tshirt under 30 bucks black'), { name: 'Black T-Shirt', price: 35 }).hard.some((h) => /over the stated \$30/.test(h)));
  });

  await test('relevant@k counts an empty slot as not relevant; wrongly removed counts only what was plainly asked', () => {
    const c = caseFor('black pants but not skinny');
    const g = bench.grade(c, {
      asked: 'black straight leg pants', intent: { colors: ['Black'], concepts: { without: ['skinny'] } },
      products: [{ name: 'Black Straight Leg Pants', price: 40 }, { name: 'Black Skinny Jeans', price: 40 }],
      removed: [{ name: 'Black Wide Leg Trousers' }, { name: 'Black Skinny Pants' }]
    });
    assert.strictEqual(g.relevantAt4, 0.25);
    assert.strictEqual(g.relevantAt8, 0.125);
    assert.strictEqual(g.wrongAt8, 1);
    assert.strictEqual(g.exclusionViolations, 1);
    assert.strictEqual(g.wronglyRemoved, 1);
  });

  await test('there are at least fifty messy requests, the brief\'s fifteen among them, and every one is graded', () => {
    const messy = bench.CASES.filter((c) => (c.set || 'messy') === 'messy');
    assert.ok(messy.length >= 50, `${messy.length}`);
    for (const q of ['hoodie but nicer', 'something warm but not a coat', 'that jacket shirt thing', 'shirt but heavier', 'something cozy to wear with jeans', 'something skaters would wear', 'women black thing long sleeve cheap']) {
      assert.ok(caseFor(q), q);
    }
    for (const c of bench.CASES) assert.ok(c.target && c.relevant, c.q);
  });

  console.log('\nthe run, end to end, with stand-ins for the two services');

  await test('two checkouts answer the same requests, one provider search each, every product graded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-bench-live-'));
    const standIn = path.join(dir, 'stand-in.js');
    const out = path.join(dir, 'out.json');
    fs.writeFileSync(standIn, STAND_IN);
    const repo = path.join(__dirname, '..');
    try {
      execFileSync(process.execPath, ['-r', standIn, path.join(__dirname, 'bench-messy-live.js'),
        '--roots', `one=${repo},two=${repo}`, '--only', 'black pants but not skinny|something cozy to wear with jeans|red dress', '--json', '--out', out],
      { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { OPENAI_API_KEY: '', OPENWEBNINJA_API_KEY: '' }) });
    } catch (err) {
      /* exit 1 is the benchmark judging the results, which a stand-in
         answering "Skinny ..." for a request that ruled skinny out earns */
      if (err.status !== 1) throw new Error(String(err.stderr || err.message));
    }
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const name of ['one', 'two']) {
      const rows = result.byRoot[name];
      assert.strictEqual(rows.length, 3);
      for (const row of rows) {
        assert.ok(row.observed, row.error);
        assert.strictEqual(row.observed.interpreter, 'openai');
        assert.strictEqual(row.observed.providerSearches, 1, row.case.q);
        assert.strictEqual(row.observed.interpreterCalls, 1, row.case.q);
        assert.ok(row.observed.verified > 0, row.case.q);
        assert.ok(row.graded && typeof row.graded.relevantAt8 === 'number');
      }
      assert.strictEqual(result.summary[name].providerSearchesMax, 1);
    }
    /* the same checkout twice asks the same thing */
    assert.deepStrictEqual(result.compared.map((d) => d.sameQuery), [true, true, true]);
    /* and the skinny listing the stand-in sent was taken out by the filter, not shown */
    const skinny = result.byRoot.one[0];
    assert.ok(!skinny.observed.products.some((p) => /skinny/i.test(p.name)), skinny.observed.products.map((p) => p.name).join(' | '));
    assert.ok(skinny.observed.removed.some((r) => /skinny/i.test(r.name)));
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
