#!/usr/bin/env node
/* =========================================================
   Fynd — the demo recorder's tool paths

   The recorder encodes with ffmpeg and reads durations with ffprobe.
   Those are two programs, and -show_entries is an ffprobe option: handed
   to ffmpeg it fails with "Unrecognized option 'show_entries'", which is
   what a Windows run did when ffprobe was derived from
   FFMPEG_PATH=...\ffmpeg.exe by a pattern that only matched a path
   ending in "ffmpeg". These checks hold that line.

   And the demo's own rules, which decide what may be shown: four
   different searches, results that are real and loaded and not one
   product repeated, a brand search that really returns the brand, only
   retailer pages seen to open ever clicked, and an edit that places
   every line where it was said.

   Offline, no browser, no ffmpeg needed:  node scripts/test-record-demo.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const os = require('os');
const {
  ffprobeFor, durationCommand, SEARCHES, MIN_PRODUCTS, verdict, fitness, pickProduct,
  budgetOf, priceOf, mentionOf, cutMap, savedProblem, narrationNeeded,
  requestsFor, instability, howFound, recordingReport, RETRY_DELAYS_MS, loadEnv
} = require('./record-demo');
const store = require('../api/_store');

let passed = 0;
let failed = 0;
/* run in order, one at a time, each awaited: some read the store */
const queue = [];
function test(name, fn) {
  queue.push(async () => {
    try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
    catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
  });
}
const section = (title) => queue.push(async () => console.log(title));

const none = {};

section('\nwhere ffprobe is found');

test('Windows: ffprobe.exe beside ffmpeg.exe', () => {
  assert.strictEqual(ffprobeFor('C:\\ffmpeg\\bin\\ffmpeg.exe', none, 'win32'), 'C:\\ffmpeg\\bin\\ffprobe.exe');
});

test('Windows: a folder with spaces and upper-case EXE', () => {
  assert.strictEqual(ffprobeFor('C:\\Program Files\\FFmpeg\\bin\\ffmpeg.EXE', none, 'win32'),
    'C:\\Program Files\\FFmpeg\\bin\\ffprobe.EXE');
});

test('Windows: FFMPEG_PATH without .exe still finds ffprobe.exe', () => {
  assert.strictEqual(ffprobeFor('C:\\tools\\ffmpeg', none, 'win32'), 'C:\\tools\\ffprobe.exe');
});

test('Windows: forward slashes are a Windows path too', () => {
  assert.strictEqual(ffprobeFor('C:/ffmpeg/bin/ffmpeg.exe', none, 'win32'), 'C:\\ffmpeg\\bin\\ffprobe.exe');
});

test('Windows: a Windows path is read as one even off Windows', () => {
  assert.strictEqual(ffprobeFor('D:\\media\\ffmpeg.exe', none, 'linux'), 'D:\\media\\ffprobe.exe');
});

test('Windows: bare ffmpeg.exe on the PATH gives bare ffprobe.exe', () => {
  assert.strictEqual(ffprobeFor('ffmpeg.exe', none, 'win32'), 'ffprobe.exe');
});

test('Linux: /usr/bin/ffmpeg gives /usr/bin/ffprobe (unchanged)', () => {
  assert.strictEqual(ffprobeFor('/usr/bin/ffmpeg', none, 'linux'), '/usr/bin/ffprobe');
});

test('macOS: Homebrew ffmpeg gives Homebrew ffprobe (unchanged)', () => {
  assert.strictEqual(ffprobeFor('/opt/homebrew/bin/ffmpeg', none, 'darwin'), '/opt/homebrew/bin/ffprobe');
});

test('bare ffmpeg on the PATH gives bare ffprobe (unchanged)', () => {
  assert.strictEqual(ffprobeFor('ffmpeg', none, 'linux'), 'ffprobe');
  assert.strictEqual(ffprobeFor('ffmpeg', none, 'darwin'), 'ffprobe');
});

test('a renamed binary still looks for ffprobe in its folder', () => {
  assert.strictEqual(ffprobeFor('/opt/tools/ff6', none, 'linux'), '/opt/tools/ffprobe');
});

test('FFPROBE_PATH wins over anything derived', () => {
  assert.strictEqual(ffprobeFor('C:\\ffmpeg\\bin\\ffmpeg.exe', { FFPROBE_PATH: 'E:\\probe\\ffprobe.exe' }, 'win32'),
    'E:\\probe\\ffprobe.exe');
  assert.strictEqual(ffprobeFor('/usr/bin/ffmpeg', { FFPROBE_PATH: '/custom/ffprobe' }, 'linux'), '/custom/ffprobe');
});

test('nothing derived from an ffmpeg path is ffmpeg itself', () => {
  const inputs = [['C:\\ffmpeg\\bin\\ffmpeg.exe', 'win32'], ['C:\\ffmpeg\\bin\\ffmpeg', 'win32'],
    ['ffmpeg.exe', 'win32'], ['/usr/bin/ffmpeg', 'linux'], ['/usr/local/bin/ffmpeg', 'darwin'], ['ffmpeg', 'linux']];
  for (const [p, platform] of inputs) {
    const probe = ffprobeFor(p, none, platform);
    assert.ok(!/^ffmpeg(\.exe)?$/i.test(path.win32.basename(probe)), `${p} gave ${probe}`);
  }
});

section('\nthe duration command');

test('-show_entries goes to ffprobe', () => {
  const [bin, args] = durationCommand('clip.webm', 'C:\\ffmpeg\\bin\\ffprobe.exe');
  assert.strictEqual(bin, 'C:\\ffmpeg\\bin\\ffprobe.exe');
  assert.ok(args.includes('-show_entries'));
  assert.strictEqual(args[args.length - 1], 'clip.webm');
});

test('asked to read a duration with ffmpeg, it refuses instead of failing obscurely', () => {
  for (const probe of ['ffmpeg', 'ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe', '/usr/bin/ffmpeg', 'FFMPEG.EXE']) {
    assert.throws(() => durationCommand('clip.webm', probe), /ffprobe, not ffmpeg/, probe);
  }
});

test('-show_entries appears once in the recorder, in the duration command, and never beside FFMPEG', () => {
  const src = fs.readFileSync(path.join(__dirname, 'record-demo.js'), 'utf8');
  const hits = [...src.matchAll(/'-show_entries'/g)].map((m) => m.index);
  assert.strictEqual(hits.length, 1, `found ${hits.length} uses of '-show_entries'`);
  const body = src.indexOf('function durationCommand(');
  const end = src.indexOf('\n}\n', body);
  assert.ok(body > 0 && hits[0] > body && hits[0] < end, "'-show_entries' is outside durationCommand");
  /* every ffmpeg invocation: execFileSync(FFMPEG, …) and the run([…]) helper */
  const calls = [...src.matchAll(/execFileSync\(FFMPEG,[^)]*\)|\brun\(\[[\s\S]*?\]\)/g)].map((m) => m[0]);
  assert.ok(calls.length > 0, 'found no ffmpeg calls to check');
  for (const c of calls) assert.ok(!c.includes('show_entries') && !c.includes('lengthOf'), `ffmpeg call carries a probe option: ${c.slice(0, 80)}`);
});

test('lengthOf reads through durationCommand', () => {
  const src = fs.readFileSync(path.join(__dirname, 'record-demo.js'), 'utf8');
  const body = src.slice(src.indexOf('function lengthOf('), src.indexOf('\n}\n', src.indexOf('function lengthOf(')));
  assert.ok(body.includes('durationCommand('), 'lengthOf no longer goes through durationCommand');
  assert.ok(!/FFMPEG/.test(body), 'lengthOf mentions FFMPEG');
});

section('\nthe searches');

test('four searches, each a different slot with its own narration line', () => {
  assert.strictEqual(SEARCHES.length, 4);
  assert.strictEqual(new Set(SEARCHES.map((s) => s.slot)).size, 4);
  assert.strictEqual(new Set(SEARCHES.map((s) => s.line)).size, 4);
});

test('no request appears twice, and every one has a budget', () => {
  const all = SEARCHES.flatMap((s) => requestsFor(s).map((c) => c.query));
  assert.strictEqual(new Set(all.map((q) => q.toLowerCase())).size, all.length);
  for (const q of all) assert.ok(budgetOf(q) > 0, `"${q}" names no budget`);
});

test('the first choices span different budgets', () => {
  const budgets = SEARCHES.map((s) => budgetOf(s.candidates[0].query));
  assert.strictEqual(new Set(budgets).size, budgets.length, budgets.join(', '));
});

test('the opening request is the one its narration names, with no alternative', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'demo', 'narration', 'manifest.json'), 'utf8'));
  const first = SEARCHES[0];
  assert.strictEqual(first.candidates.length, 1);
  assert.ok(!requestsFor(first).some((r) => r.kind === 'alternative'));
  assert.strictEqual(first.candidates[0].query, 'black oversized hoodie under $80');
  assert.ok(/black oversized hoodie/i.test(manifest.lines[first.line].text) && /eighty/.test(manifest.lines[first.line].text));
});

test('the hoodie equivalent wordings keep the exact intent: black, oversized, a hoodie, under $80', () => {
  const eq = requestsFor(SEARCHES[0]).filter((r) => r.kind === 'equivalent').map((r) => r.query);
  assert.deepStrictEqual(eq, ['black oversized pullover hoodie under $80', 'black oversized hooded sweatshirt under $80', 'black baggy hoodie under $80']);
  for (const q of eq) {
    assert.ok(/\bblack\b/.test(q) && /\b(oversized|baggy)\b/.test(q) && /\b(hoodie|hooded sweatshirt)\b/.test(q), q);
    assert.strictEqual(budgetOf(q), 80, q);
  }
});

test('every equivalent keeps the budget and brand of its request', () => {
  for (const slot of SEARCHES) {
    for (const r of requestsFor(slot).filter((x) => x.kind === 'equivalent')) {
      assert.strictEqual(budgetOf(r.query), budgetOf(r.of), r.query);
      const parent = slot.candidates.find((c) => c.query === r.of);
      assert.strictEqual(r.mention, parent.mention || null, r.query);
      if (r.mention) assert.ok(mentionOf(r).test(r.query), `"${r.query}" drops the brand`);
    }
  }
});

test('a slot tries its request, then its equivalents, then any alternative', () => {
  const order = requestsFor(SEARCHES[2]).map((r) => r.kind);
  assert.deepStrictEqual(order, ['exact', 'equivalent', 'equivalent', 'alternative', 'alternative']);
  assert.strictEqual(requestsFor(SEARCHES[2])[0].query, 'BAPE shark hoodie under $400');
});

test('the later lines name no request, since those slots can fall back', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'demo', 'narration', 'manifest.json'), 'utf8'));
  for (const s of SEARCHES.slice(1)) {
    const said = manifest.lines[s.line].text.toLowerCase();
    for (const c of requestsFor(s)) {
      for (const word of c.query.toLowerCase().split(/\W+/).filter((w) => w.length > 4 && w !== 'under')) {
        assert.ok(!said.includes(word), `"${s.line}" says "${word}" from "${c.query}"`);
      }
    }
  }
});

test('every narration line the recording can ask for has its clip', () => {
  const dir = path.join(__dirname, '..', 'assets', 'demo', 'narration');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const key of narrationNeeded()) {
    assert.ok(manifest.lines[key], `no line "${key}" in the manifest`);
    assert.ok(fs.existsSync(path.join(dir, manifest.lines[key].file)), `no clip for "${key}"`);
    assert.ok(manifest.lines[key].duration > 0.5 && manifest.lines[key].duration < 6, `"${key}" is ${manifest.lines[key].duration}s`);
  }
});

section('\nwhat may be shown');

const product = (i, extra = {}) => ({
  i, name: `Product ${i}`, brand: 'Brand', price: '$60', href: `https://shop${i}.example/p/${i}`,
  retailer: `shop${i}.example`, drawn: false, sample: false, src: `https://img.example/${i}.jpg`,
  width: 600, height: 800, loaded: true, retailerOk: true, ...extra
});
const grid = (n, extra) => Array.from({ length: n }, (_, i) => product(i, typeof extra === 'function' ? extra(i) : extra));

test('real, loaded, different products pass', () => {
  assert.deepStrictEqual(verdict(grid(6)), []);
});

test('too few products, a sample row, a drawing, no link, a failed or tiny photo are each refused', () => {
  assert.ok(verdict(grid(MIN_PRODUCTS - 1)).some((p) => /only 3/.test(p)));
  assert.ok(verdict(grid(5, (i) => (i === 2 ? { sample: true } : {}))).some((p) => /sample row/.test(p)));
  assert.ok(verdict(grid(5, (i) => (i === 2 ? { drawn: true, loaded: false } : {}))).some((p) => /placeholder/.test(p)));
  assert.ok(verdict(grid(5, (i) => (i === 2 ? { href: '' } : {}))).some((p) => /no retailer link/.test(p)));
  assert.ok(verdict(grid(5, (i) => (i === 2 ? { loaded: false } : {}))).some((p) => /did not load/.test(p)));
  assert.ok(verdict(grid(5, (i) => (i === 2 ? { width: 90, height: 90 } : {}))).some((p) => /too small/.test(p)));
});

test('one product shown several times is not several products', () => {
  const same = grid(6, (i) => (i > 1 ? { name: 'Product 1', src: 'https://img.example/1.jpg' } : {}));
  assert.ok(verdict(same).some((p) => /different product/.test(p)));
});

test('a brand search is only used when the results are really that brand', () => {
  const bape = SEARCHES.flatMap((s) => s.candidates).find((c) => /BAPE/.test(c.query));
  assert.ok(bape && bape.mention, 'the BAPE request names its brand');
  const mostlyOthers = grid(8, (i) => (i < 2 ? { brand: 'A Bathing Ape', name: 'Shark Full Zip Hoodie' } : { name: 'Shark Hoodie' }));
  assert.ok(fitness(mostlyOthers, bape).some((p) => /actually BAPE/.test(p)));
  const real = grid(8, (i) => (i < 5 ? { brand: 'BAPE', name: `Shark Full Zip Hoodie ${i}` } : {}));
  assert.deepStrictEqual(fitness(real, bape), []);
});

test('a search with no retailer page that opens is not used', () => {
  assert.ok(fitness(grid(6, { retailerOk: false }), { query: 'x under $10' }).some((p) => /retailer page/.test(p)));
  /* nor one whose only opening pages are not the brand asked for */
  const offBrand = grid(8, (i) => (i < 5 ? { brand: 'BAPE', name: `Shark ${i}`, retailerOk: false } : {}));
  assert.ok(fitness(offBrand, { query: 'BAPE shark hoodie under $400', mention: 'bape' }).some((p) => /retailer page/.test(p)));
});

section('\nwhich product is opened');

test('never a product whose retailer page was not seen to open', () => {
  const cards = grid(4, (i) => ({ retailerOk: i === 3 }));
  assert.strictEqual(pickProduct(cards), 3);
  assert.strictEqual(pickProduct(grid(4, { retailerOk: false })), -1);
});

test('a retailer not yet shown in the video beats one already shown', () => {
  const cards = grid(4);
  const used = new Set(['shop0.example', 'shop1.example', 'shop3.example']);
  assert.strictEqual(pickProduct(cards, { used }), 2);
});

test('the same shop twice only when no other shop opens', () => {
  const cards = grid(3, (i) => ({ retailerOk: i === 1 }));
  assert.strictEqual(pickProduct(cards, { used: new Set(['shop1.example']) }), 1);
});

test('only the brand asked for, within budget, and on screen are preferred', () => {
  const cards = grid(6, (i) => ({ brand: i >= 3 ? 'BAPE' : 'Other', price: i === 3 ? '$520' : '$300' }));
  const pick = pickProduct(cards, { mention: mentionOf({ mention: 'bape|bathing ape' }), budget: 400, visible: new Set([0, 1, 2, 3, 4]) });
  assert.strictEqual(pick, 4);
});

test('budgets and prices are read the way the page writes them', () => {
  assert.strictEqual(budgetOf('lightweight jacket for fall under $150'), 150);
  assert.strictEqual(budgetOf('BAPE shark hoodie under $1,200'), 1200);
  assert.strictEqual(budgetOf('a wool coat'), null);
  assert.strictEqual(priceOf('$64.99'), 64.99);
  assert.strictEqual(priceOf('$1,250'), 1250);
  assert.strictEqual(priceOf('Price at retailer'), null);
});

section('\nthe edit');

test('Fynd, retailer, Fynd: lengths add up and lines land where they were said', () => {
  const cut = [
    { src: 'main', from: 1, to: 11 },
    { src: 'tab', tab: 0, born: 11.2, from: 12.2, to: 14.2 },
    { src: 'main', from: 15, to: 25 }
  ];
  /* the Fynd tab's video runs at 0.9 of the wall clock; the tab's video is 2.7s for 3s of wall clock */
  const { pieces, total, at } = cutMap(cut, 0.9, [2.7]);
  assert.strictEqual(pieces.length, 3);
  assert.strictEqual(pieces[1].input, 1);
  assert.ok(Math.abs(pieces[1].start - 0.9) < 1e-9 && Math.abs(pieces[1].end - 2.7) < 1e-9);
  assert.ok(Math.abs(total - (9 + 1.8 + 9)) < 1e-9, `total ${total}`);
  assert.ok(Math.abs(at(1) - 0) < 1e-9);
  assert.ok(Math.abs(at(6) - 4.5) < 1e-9);
  assert.ok(Math.abs(at(13.2) - (9 + 0.9)) < 1e-9);
  /* a moment in a cut lands where the next piece starts */
  assert.ok(Math.abs(at(14.6) - 10.8) < 1e-9);
  assert.ok(Math.abs(at(20) - (10.8 + 4.5)) < 1e-9);
  assert.ok(Math.abs(at(99) - total) < 1e-9);
});

test('a retailer tab that was not shown leaves a plain cut between two Fynd pieces', () => {
  const { pieces, total } = cutMap([{ src: 'main', from: 0, to: 10 }, { src: 'main', from: 16, to: 20 }], 1, []);
  assert.strictEqual(pieces.length, 2);
  assert.ok(Math.abs(total - 14) < 1e-9);
});

section('\nan unsteady product source');

const exchange = (diagnostics, status = 200) => ({ status, response: { diagnostics } });

test('aborted or failed offer lookups are the source being unsteady', () => {
  assert.ok(/3 offer lookup\(s\) aborted or failed/.test(instability(exchange({ offers: { lookupsFailed: 3, budgetExpired: false } }), 'cards')));
  assert.ok(/ran out of time/.test(instability(exchange({ offers: { lookupsFailed: 0, budgetExpired: true } }), 'cards')));
  assert.ok(/seller lookup/.test(instability(exchange({ sellers: { lookupsFailed: 2 } }), 'cards')));
  assert.ok(/ran out of time/.test(instability(exchange({ timing: { deadlineExpired: true } }), 'cards')));
  assert.ok(/HTTP 502/.test(instability(exchange({}, 502), 'empty')));
  assert.ok(/45 s/.test(instability(null, 'timeout')));
});

test('a search that simply found few products is not unsteady, and is not retried', () => {
  assert.strictEqual(instability(exchange({ offers: { lookupsFailed: 0, budgetExpired: false }, timing: { deadlineExpired: false } }), 'cards'), '');
  assert.strictEqual(instability(exchange({}), 'empty'), '');
  assert.strictEqual(instability(exchange(undefined), 'cards'), '');
});

test('the same request is tried at most twice more, after a short pause', () => {
  assert.ok(RETRY_DELAYS_MS.length >= 1 && RETRY_DELAYS_MS.length <= 2);
  for (const ms of RETRY_DELAYS_MS) assert.ok(ms >= 1000 && ms <= 10000, `${ms}ms`);
});

test('the minimum stays at four, and three verified products still fail', () => {
  assert.strictEqual(MIN_PRODUCTS, 4);
  assert.ok(verdict(grid(3)).some((p) => /only 3 product/.test(p)));
});

test('a retry forgets the cached search and the allowance, and keeps the offers', () => {
  store.reset();
  return Promise.all([
    store.set('fynd:cache:v1:search:abc', { records: [] }),
    store.set('fynd:cache:v1:offer:def', { commerce: {} }),
    store.add('usage:anon:searches:day:2026-10-03', 1)
  ]).then(async () => {
    store.forget((key) => key.includes(':search:') || key.startsWith('usage:'));
    assert.strictEqual(await store.get('fynd:cache:v1:search:abc'), null);
    assert.ok(await store.get('fynd:cache:v1:offer:def'));
    assert.strictEqual(await store.readNumber('usage:anon:searches:day:2026-10-03'), 0);
    store.reset();
  });
});

section('\nthe report');

const tried = (extra) => ({ query: 'black oversized hoodie under $80', kind: 'exact', of: 'black oversized hoodie under $80', verified: 3, passed: false, unsteady: '4 offer lookup(s) aborted or failed', ...extra });

test('it says when a search passed first time', () => {
  assert.strictEqual(howFound([tried({ try: 1, verified: 8, passed: true, unsteady: undefined })]), 'passed first time');
});

test('it says when a retry was needed', () => {
  assert.ok(/1 retry after an unsteady product source/.test(howFound([tried({ try: 1 }), tried({ try: 2, verified: 7, passed: true })])));
});

test('it says when an equivalent wording was used, and which', () => {
  const said = howFound([tried({ try: 1 }), tried({ try: 2 }), tried({ try: 3 }),
    tried({ query: 'black oversized pullover hoodie under $80', kind: 'equivalent', try: 1, verified: 6, passed: true })]);
  assert.ok(/2 retries/.test(said) && /equivalent wording, "black oversized pullover hoodie under \$80"/.test(said), said);
});

test('the report names what was meant, what was typed, and what each recording opened', () => {
  const saved = { searchedAt: 'x', searches: [{ slot: 'everyday', intended: 'black oversized hoodie under $80', query: 'black baggy hoodie under $80', kind: 'equivalent',
    attempts: [tried({ try: 1 }), tried({ query: 'black baggy hoodie under $80', kind: 'equivalent', try: 1, verified: 5, passed: true })],
    shown: [{ href: 'https://www.a.example/1' }, { href: 'https://b.example/2' }] }] };
  const pick = { search: 1, brand: 'B', name: 'Hoodie', price: '$60', retailer: 'a.example', href: 'https://www.a.example/1', shown: true };
  const r = recordingReport(saved, [[{ kind: 'desktop' }, { picks: [pick] }], [{ kind: 'mobile' }, { picks: [] }]], { 'fynd-demo': 55.61 });
  const s = r.searches[0];
  assert.strictEqual(s.intended, 'black oversized hoodie under $80');
  assert.strictEqual(s.typed, 'black baggy hoodie under $80');
  assert.ok(/equivalent wording/.test(s.howFound));
  assert.deepStrictEqual(s.retailers, ['a.example', 'b.example']);
  assert.strictEqual(s.opened.desktop.retailer, 'a.example');
  assert.strictEqual(s.opened.mobile, null);
  assert.strictEqual(r.seconds['fynd-demo'], 55.6);
});

test('.env.local is read, and nothing already set is overridden', () => {
  const file = path.join(os.tmpdir(), `fynd-env-${process.pid}.local`);
  fs.writeFileSync(file, 'FYND_TEST_A=from-file\nexport FYND_TEST_B="quoted"\n# FYND_TEST_C=commented\n');
  process.env.FYND_TEST_A = 'already';
  try {
    assert.deepStrictEqual(loadEnv(file).length, 1);
    assert.strictEqual(process.env.FYND_TEST_A, 'already');
    assert.strictEqual(process.env.FYND_TEST_B, 'quoted');
    assert.strictEqual(process.env.FYND_TEST_C, undefined);
  } finally {
    fs.unlinkSync(file);
    delete process.env.FYND_TEST_A; delete process.env.FYND_TEST_B;
  }
});

section('\nreplaying a saved search');

const savedRun = () => ({
  version: 2,
  searchedAt: '2026-10-03T12:00:00.000Z',
  searches: SEARCHES.map((s) => ({
    slot: s.slot, line: s.line, query: s.candidates[s.candidates.length - 1].query, search: { status: 200 },
    shown: [{ href: 'https://shop.example/p', retailerOk: true }]
  }))
});

test('a whole run replays, including one that used an equivalent wording', () => {
  assert.strictEqual(savedProblem(savedRun()), '');
  const eq = savedRun(); eq.searches[0].query = 'black baggy hoodie under $80';
  assert.strictEqual(savedProblem(eq), '');
});

test('the old one-search file, a short run, a stale request or no opened page is refused', () => {
  assert.ok(/older/.test(savedProblem({ query: 'black oversized hoodie under $80', shown: [] })));
  const short = savedRun(); short.searches.pop();
  assert.ok(/holds 3 searches/.test(savedProblem(short)));
  const stale = savedRun(); stale.searches[2].query = 'something else under $10';
  assert.ok(/no longer/.test(savedProblem(stale)));
  const closed = savedRun(); closed.searches[1].shown[0].retailerOk = false;
  assert.ok(/no retailer page/.test(savedProblem(closed)));
});

(async () => {
  for (const run of queue) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
