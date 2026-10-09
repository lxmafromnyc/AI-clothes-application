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
    /* strong: relevant and saying the stated black */
    assert.strictEqual(g.strongAt8, 1);
    assert.ok(!bench.gradeProduct(c, { name: 'Wide Leg Pants', price: 40 }).strong, 'a title that does not say black is not a strong match');
    assert.ok(bench.gradeProduct(caseFor('shirt but heavier'), { name: 'Heavyweight Flannel Shirt', price: 40 }).strong);
    assert.ok(!bench.gradeProduct(caseFor('shirt but heavier'), { name: 'Oxford Shirt', price: 40 }).strong);
    assert.strictEqual(g.relevantAt8, 0.125);
    assert.strictEqual(g.wrongAt8, 1);
    assert.strictEqual(g.exclusionViolations, 1);
    assert.strictEqual(g.wronglyRemoved, 1);
  });

  console.log('\nthe requests');

  await test('every request has a stable id, a type and an intent; at least fifty distinct messy ones, and the plain control group', () => {
    const { QUERIES, TYPES } = require('./bench-messy-queries');
    const ids = QUERIES.map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'an id is used twice');
    assert.ok(ids.every((id) => /^[MP]\d{3}$/.test(id)), 'an id is not M### or P###');
    const texts = QUERIES.map((c) => c.q.trim().toLowerCase());
    assert.strictEqual(new Set(texts).size, texts.length, 'a request is in twice');
    const messy = QUERIES.filter((c) => c.set === 'messy');
    const plain = QUERIES.filter((c) => c.set === 'plain');
    assert.ok(messy.length >= 50, `${messy.length} messy`);
    assert.strictEqual(plain.length, 8);
    assert.ok(messy.every((c) => c.id.startsWith('M')) && plain.every((c) => c.id.startsWith('P') && c.type === 'plain'));
    for (const c of QUERIES) {
      assert.ok(TYPES.includes(c.type), `${c.id}: type ${c.type}`);
      assert.ok(typeof c.intent === 'string' && c.intent.length > 3, `${c.id}: no intent`);
      assert.ok(c.target instanceof RegExp && (c.relevant instanceof RegExp || Array.isArray(c.relevant) || typeof c.relevant === 'function'), `${c.id}: no criteria`);
    }
    /* what the brief asked the set to cover */
    for (const type of ['misspelling', 'merged-words', 'abbreviation', 'fragment', 'natural-language', 'multi-attribute', 'synonym', 'contradiction', 'size', 'no-result', 'negation', 'worn-with', 'comparison']) {
      assert.ok(messy.some((c) => c.type === type), `no ${type} request`);
    }
    for (const q of ['hoodie but nicer', 'something warm but not a coat', 'that jacket shirt thing', 'shirt but heavier', 'something cozy to wear with jeans', 'something skaters would wear', 'women black thing long sleeve cheap']) {
      assert.ok(caseFor(q), q);
    }
  });

  await test('a request nothing honest can answer is right only when nothing is shown', () => {
    const c = bench.CASES.find((x) => x.id === 'M097');
    assert.strictEqual(bench.grade(c, { asked: 'cashmere sweater', intent: { maxPrice: 5 }, products: [] }).noneCorrect, true);
    const shown = bench.grade(c, { asked: 'cashmere sweater', intent: { maxPrice: 5 }, products: [{ name: 'Cashmere Sweater', price: 89 }] });
    assert.strictEqual(shown.noneCorrect, false);
    assert.ok(shown.hardViolations >= 1, 'an $89 sweater for "under $5" is not a violation');
    /* and a request that should find things is not judged on that */
    assert.strictEqual(bench.grade(caseFor('blak hoddie'), { asked: 'black hoodie', intent: { colors: ['Black'] }, products: [] }).noneCorrect, null);
  });

  console.log('\nthe run, end to end, with stand-ins for the two services');

  const repo = path.join(__dirname, '..');
  const runBench = (dir, args, env) => {
    try {
      execFileSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { OPENAI_API_KEY: '', OPENWEBNINJA_API_KEY: '' }, env || {}) });
    } catch (err) {
      /* exit 1 is the benchmark judging the results, which a stand-in
         answering "Skinny ..." for a request that ruled skinny out earns */
      if (err.status !== 1) throw new Error(String(err.stderr || err.message));
    }
    return {
      results: JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')),
      summary: fs.readFileSync(path.join(dir, 'summary.md'), 'utf8')
    };
  };

  await test('in process: each request goes through the real /api/interpret and /api/search handlers, and is recorded with its HTTP status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-bench-live-'));
    const standIn = path.join(dir, 'stand-in.js');
    fs.writeFileSync(standIn, STAND_IN);
    const out = path.join(dir, 'out');
    const { results, summary } = runBench(out, ['-r', standIn, path.join(__dirname, 'bench-messy-live.js'),
      '--roots', `one=${repo},two=${repo}`, '--only', 'M005|M007|P001', '--out-dir', out, '--json']);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(results.mode, 'in-process');
    assert.strictEqual(results.store, 'memory');
    assert.deepStrictEqual(results.results.map((r) => r.id), ['M005', 'M007', 'P001']);
    for (const name of ['one', 'two']) {
      for (const row of results.results) {
        const o = row[name];
        assert.ok(!o.crashed, `${row.id}: ${o.crashed}`);
        assert.strictEqual(o.status, 200, `${row.id}: HTTP ${o.status}`);
        assert.strictEqual(o.interpretStatus, 200, `${row.id}: /api/interpret ${o.interpretStatus}`);
        assert.strictEqual(o.interpreter, 'openai');
        assert.strictEqual(o.providerSearches, 1, row.id);
        assert.strictEqual(o.interpreterCalls, 1, row.id);
        assert.strictEqual(o.askedFrom, 'wire');
        assert.ok(o.verified > 0, row.id);
        assert.ok(typeof o.totalMs === 'number' && typeof o.searchMs === 'number');
        assert.ok(o.graded && typeof o.graded.relevantAt8 === 'number');
      }
      assert.strictEqual(results.summary[name].providerSearchesMax, 1);
      assert.deepStrictEqual(results.summary[name].httpStatuses, { 200: 3 });
    }
    /* the same checkout twice asks the same thing */
    assert.deepStrictEqual(results.compared.map((d) => d.sameQuery), [true, true, true]);
    /* the skinny listing the stand-in sent was removed by the filter, not shown — and the record says so */
    const skinny = results.results[0].one;
    assert.ok(!skinny.products.some((p) => /skinny/i.test(p.name)), skinny.products.map((p) => p.name).join(' | '));
    assert.ok(skinny.removed.some((r) => /skinny/i.test(r.name)));
    /* and nothing secret was written */
    assert.ok(!/sk-stand-in|stand-in-key/.test(JSON.stringify(results)), 'a key reached the record');
    assert.ok(/## Every request — one/.test(summary) && /\| M005 \|/.test(summary), 'the summary has no per-request table');
  });

  await test('against a running server: the page\'s two requests go over HTTP, and its answer is recorded as it came', async () => {
    const http = require('http');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-bench-server-'));
    const standIn = path.join(dir, 'stand-in.js');
    fs.writeFileSync(standIn, STAND_IN);
    /* the server is this process: the real handlers, behind the stand-ins */
    const saved = { fetch: global.fetch, openai: process.env.OPENAI_API_KEY, own: process.env.OPENWEBNINJA_API_KEY };
    require(standIn);
    const handlers = { '/api/search': require('../api/search'), '/api/interpret': require('../api/interpret') };
    const server = http.createServer((req, res) => {
      const handler = handlers[new URL(req.url, 'http://x').pathname];
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (body) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
      if (!handler) return res.status(404).json({ error: 'not found' });
      Promise.resolve(handler(req, res)).catch((err) => res.status(500).json({ error: String(err && err.message) }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const out = path.join(dir, 'out');
    try {
      const run = () => new Promise((resolve, reject) => {
        const child = require('child_process').execFile(process.execPath, [path.join(__dirname, 'bench-messy-live.js'),
          '--servers', `local=http://127.0.0.1:${server.address().port}`, '--only', 'M005|P001', '--out-dir', out, '--json'],
        { env: Object.assign({}, process.env, { OPENAI_API_KEY: '', OPENWEBNINJA_API_KEY: '' }) }, (err) => (err && err.code !== 1 ? reject(err) : resolve()));
        child.stdin && child.stdin.end();
      });
      await run();
    } finally {
      server.close();
      global.fetch = saved.fetch;
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
      if (saved.own === undefined) delete process.env.OPENWEBNINJA_API_KEY; else process.env.OPENWEBNINJA_API_KEY = saved.own;
    }
    const results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(results.mode, 'servers');
    for (const row of results.results) {
      const o = row.local;
      assert.ok(!o.crashed, `${row.id}: ${o.crashed}`);
      assert.strictEqual(o.status, 200, `${row.id}: HTTP ${o.status}`);
      assert.strictEqual(o.interpretStatus, 200);
      assert.strictEqual(o.providerCallsSeenBy, "the server's diagnostics");
      assert.strictEqual(o.providerSearches, 1);
      assert.strictEqual(o.askedFrom, 'built from the posted body');
      assert.strictEqual(o.removed, null);
      assert.ok(o.verified > 0, row.id);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
