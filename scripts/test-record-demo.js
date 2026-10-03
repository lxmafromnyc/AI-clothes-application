#!/usr/bin/env node
/* =========================================================
   Fynd — the demo recorder's tool paths

   The recorder encodes with ffmpeg and reads durations with ffprobe.
   Those are two programs, and -show_entries is an ffprobe option: handed
   to ffmpeg it fails with "Unrecognized option 'show_entries'", which is
   what a Windows run did when ffprobe was derived from
   FFMPEG_PATH=...\ffmpeg.exe by a pattern that only matched a path
   ending in "ffmpeg". These checks hold that line.

   Offline, no browser, no ffmpeg needed:  node scripts/test-record-demo.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { ffprobeFor, durationCommand, planCut, SEARCHES, DURATION, durationProblem, durationNote } = require('./record-demo');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const none = {};

console.log('\nwhere ffprobe is found');

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

console.log('\nthe duration command');

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

test('-show_entries appears once in the recorder, in the probe command, and never beside FFMPEG', () => {
  const src = fs.readFileSync(path.join(__dirname, 'record-demo.js'), 'utf8');
  const hits = [...src.matchAll(/'-show_entries'/g)].map((m) => m.index);
  assert.strictEqual(hits.length, 1, `found ${hits.length} uses of '-show_entries'`);
  const body = src.indexOf('function probeCommand(');
  const end = src.indexOf('\n}\n', body);
  assert.ok(body > 0 && hits[0] > body && hits[0] < end, "'-show_entries' is outside probeCommand");
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

console.log('\nthe cut, with three retailer visits');

/* a recording whose clock and video agree (k = 1), so the arithmetic is
   easy to read: Fynd from 1s to 30s, three products clicked at 10, 15, 20 */
const marks = { start: 1, end: 30 };
const loaded = (click, file) => ({ kind: 'loaded', click, pageAt: click + 0.2, dom: click + 0.7, closed: click + 3.4, file, host: file });
const popLen = () => 3.2;   /* each retailer recording runs pageAt → closed */

test('loaded tabs are cut in, Fynd resumes after each', () => {
  const plan = planCut({ marks, visits: [loaded(10, 'a'), loaded(15, 'b'), loaded(20, 'c')], mainLen: 30, popLen });
  assert.deepStrictEqual(plan.segments.map((s) => s.src), ['main', 'a', 'main', 'b', 'main', 'c', 'main']);
  /* each tab from just before its page appears (dom − 0.25s) to its close */
  const tab = plan.segments[1];
  assert.ok(Math.abs(tab.from - 0.25) < 1e-6 && Math.abs(tab.to - 3.2) < 1e-6, `${tab.from}→${tab.to}`);
});

test('a slow tab shows no retailer, and its waiting is cut out', () => {
  const slow = { kind: 'slow', click: 15, pageAt: null, dom: null, closed: 20.4, file: null };
  const plan = planCut({ marks, visits: [loaded(10, 'a'), slow, loaded(25, 'c')], mainLen: 30, popLen });
  assert.deepStrictEqual(plan.segments.map((s) => s.src), ['main', 'a', 'main', 'main', 'c', 'main']);
  const before = plan.segments[2];
  const after = plan.segments[3];
  assert.ok(Math.abs(before.wallTo - 15.35) < 1e-6, 'Fynd should run just past the click');
  assert.ok(Math.abs(after.wallFrom - 20.4) < 1e-6, 'Fynd should resume when the slow tab was given up');
  /* the next product still gets its turn */
  assert.strictEqual(plan.segments[4].src, 'c');
});

test('a click that opened no tab cuts its wait and carries on', () => {
  const none = { kind: 'no-tab', click: 15, pageAt: null, dom: null, closed: 18, file: null };
  const plan = planCut({ marks, visits: [none, loaded(20, 'b')], mainLen: 30, popLen });
  assert.deepStrictEqual(plan.segments.map((s) => s.src), ['main', 'main', 'b', 'main']);
  assert.ok(plan.total < 29 - 2.5, `the 3s wait was not cut (total ${plan.total})`);
});

test('a blocked page is never cut in', () => {
  const blocked = { kind: 'blocked', click: 15, pageAt: 15.2, dom: 15.6, closed: 15.9, file: 'x' };
  const plan = planCut({ marks, visits: [blocked], mainLen: 30, popLen });
  assert.ok(plan.segments.every((s) => s.src === 'main'));
});

test('at(): narration before, between and after the tabs lands on Fynd', () => {
  const plan = planCut({ marks, visits: [loaded(10, 'a'), loaded(15, 'b')], mainLen: 30, popLen });
  assert.ok(Math.abs(plan.at(5) - 4) < 1e-6);                           /* 5s on the clock, 1s trimmed */
  const resume = plan.segments[2];
  assert.ok(Math.abs(plan.at(14) - (resume.outStart + (14 - resume.wallFrom))) < 1e-6);
  assert.strictEqual(plan.at(12), resume.outStart, 'a moment inside a cut lands where Fynd resumes');
  assert.ok(Math.abs(plan.at(30) - plan.total) < 1e-6);
});

test('a recording that ran behind the clock is played back in real time', () => {
  /* 30s on the clock recorded as 33s of video: the finished piece is
     29s long again (1s trimmed at the start), played at 1.1× */
  const plan = planCut({ marks, visits: [], mainLen: 33, popLen });
  assert.ok(Math.abs(plan.total - 29) < 1e-6, `${plan.total}`);
  assert.ok(Math.abs(plan.segments[0].rate - 1.1) < 1e-6);
  assert.ok(Math.abs(plan.at(10) - 9) < 1e-6, 'moments land on the real clock');
});

test('a line said on a retailer tab lands inside that tab, or nowhere', () => {
  const slow = { kind: 'slow', click: 15, pageAt: null, dom: null, closed: 20.4, file: null };
  const plan = planCut({ marks, visits: [loaded(10, 'a'), slow], mainLen: 30, popLen });
  const tab = plan.segments.find((x) => x.visit === 0);
  assert.ok(Math.abs(plan.onVisit(0, 0.15) - (tab.outStart + 0.15)) < 1e-6);
  assert.strictEqual(plan.onVisit(1, 0.15), null, 'a slow tab is not shown, so nothing is said on it');
});

console.log('\nchoosing what to open');

const { chooseNext } = require('./demo-retailer-visit');
const grid = (hosts) => hosts.map((h, i) => ({ i, href: `https://www.${h}/p/${i}`, row: i < 4 ? 0 : 1 }));

/* the recorder's loop, without a browser: choose, open, keep or skip */
function run(cards, outcomes, want, verdicts = {}) {
  const tried = new Set();
  const used = new Set();
  const bad = new Set();
  const log = [];
  while (used.size < want) {
    const pick = chooseNext(cards, { tried, used, bad, verdicts, row: used.size ? 1 : 0 });
    if (!pick) break;
    tried.add(pick.i);
    const kind = outcomes[pick.host] || 'loaded';
    log.push(`${pick.host}:${kind}`);
    if (kind === 'loaded') used.add(pick.host); else bad.add(pick.host);
  }
  return { log, used: [...used] };
}

test('H&M blocks → it is skipped and the next shops are tried until enough load', () => {
  const r = run(grid(['hm.com', 'gap.com', 'hollisterco.com', 'uniqlo.com']), { 'hm.com': 'blocked' }, 3);
  assert.deepStrictEqual(r.log, ['hm.com:blocked', 'gap.com:loaded', 'hollisterco.com:loaded', 'uniqlo.com:loaded']);
  assert.deepStrictEqual(r.used, ['gap.com', 'hollisterco.com', 'uniqlo.com']);
});

test('a blocked shop is never tried again, even for its other products', () => {
  const r = run(grid(['hm.com', 'hm.com', 'hm.com', 'gap.com', 'hm.com', 'asos.com']), { 'hm.com': 'blocked' }, 2);
  assert.strictEqual(r.log.filter((x) => x.startsWith('hm.com')).length, 1, r.log.join(' '));
  assert.deepStrictEqual(r.used, ['gap.com', 'asos.com']);
});

test('a shop already opened is not opened again while another usable shop is left', () => {
  const cards = grid(['gap.com', 'gap.com', 'gap.com', 'asos.com']);
  const first = chooseNext(cards, { used: new Set(), row: 0 });
  const second = chooseNext(cards, { tried: new Set([first.i]), used: new Set(['gap.com']), row: 1 });
  assert.strictEqual(second.host, 'asos.com');
});

test('…and only when none is left does it go back to a shop it already opened', () => {
  const cards = grid(['gap.com', 'gap.com']);
  const second = chooseNext(cards, { tried: new Set([0]), used: new Set(['gap.com']) });
  assert.strictEqual(second.i, 1);
});

test('shops checked off camera: blocked ones never come up, usable ones come first', () => {
  const cards = grid(['hm.com', 'zara.com', 'gap.com', 'asos.com']);
  const verdicts = { [cards[0].href]: 'blocked', [cards[1].href]: 'slow', [cards[3].href]: 'loaded' };
  const first = chooseNext(cards, { verdicts, row: 0 });
  assert.strictEqual(first.host, 'asos.com', 'a shop checked usable comes before one not checked');
  const r = run(cards, {}, 3, verdicts);
  assert.ok(!r.log.some((x) => /hm\.com|zara\.com/.test(x)), r.log.join(' '));
});

test('when every shop fails, the loop ends instead of looping', () => {
  const r = run(grid(['a.com', 'b.com', 'c.com']), { 'a.com': 'blocked', 'b.com': 'slow', 'c.com': 'no-tab' }, 2);
  assert.strictEqual(r.used.length, 0);
  assert.strictEqual(r.log.length, 3);
});

test('a skipped attempt is cut from where the hand set off for it', () => {
  const skipped = { kind: 'blocked', approach: 13.2, click: 15, pageAt: 15.3, dom: 15.8, closed: 16.1, file: 'x' };
  const plan = planCut({ marks, visits: [skipped, loaded(20, 'b')], mainLen: 30, popLen });
  assert.ok(Math.abs(plan.segments[0].wallTo - 13.2) < 1e-6, 'Fynd runs only up to the approach');
  assert.ok(Math.abs(plan.segments[1].wallFrom - 16.1) < 1e-6, 'and resumes when the blocked tab is closed');
  assert.ok(plan.segments.every((x) => x.src !== 'x'), 'the blocked page is never in the video');
});

console.log('\nhow long a finished video may run');

test('the limit is 70 seconds, the target 45–60', () => {
  assert.strictEqual(DURATION.max, 70);
  assert.strictEqual(DURATION.targetMin, 45);
  assert.strictEqual(DURATION.targetMax, 60);
});

test('45–60 seconds is the target: valid, no note', () => {
  for (const s2 of [45, 52.5, 57, 60]) {
    assert.strictEqual(durationProblem(s2), null, `${s2}s was refused`);
    assert.strictEqual(durationNote(s2), null, `${s2}s was noted`);
  }
});

test('60–70 seconds is kept, with a note that it runs a little long (never trimmed)', () => {
  for (const s2 of [61, 64.5, 69.9, 70.0]) {
    assert.strictEqual(durationProblem(s2), null, `${s2}s was refused`);
    assert.ok(/a little over the 45–60s target/.test(durationNote(s2) || ''), `${s2}s: ${durationNote(s2)}`);
  }
});

test('over 70 seconds is still refused, and says why', () => {
  for (const s2 of [70.1, 75, 120]) {
    assert.ok(/outside the allowed 15–70s/.test(durationProblem(s2) || ''), `${s2}s was accepted`);
  }
});

test('too short or unreadable is refused; short but plausible is kept with a warning', () => {
  assert.ok(durationProblem(10));
  assert.ok(durationProblem(NaN));
  assert.strictEqual(durationProblem(40), null);
  assert.ok(/under the usual 45–60s/.test(durationNote(40) || ''));
});

test('the video check uses these limits, not a number of its own', () => {
  const src = fs.readFileSync(path.join(__dirname, 'record-demo.js'), 'utf8');
  const body = src.slice(src.indexOf('function checkVideo('), src.indexOf('\n}\n', src.indexOf('function checkVideo(')));
  assert.ok(body.includes('durationProblem(seconds)'), 'checkVideo no longer goes through durationProblem');
  assert.ok(!/seconds\s*[<>]\s*\d/.test(body), 'checkVideo compares seconds against a bare number');
});

console.log('\nthe narration');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'demo', 'narration', 'manifest.json'), 'utf8'));

const linesOf = (x) => [...(x.lines.opening || []), x.lines.typing, x.lines.before, x.lines.results].filter(Boolean);

test('every line the searches use has been spoken, plus the retailer line', () => {
  const used = new Set(SEARCHES.flatMap(linesOf).concat('retailer'));
  for (const key of used) {
    assert.ok(manifest.lines[key], `no "${key}" line`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'demo', 'narration', manifest.lines[key].file)), `${key}: file missing`);
  }
});

test('no line is read with recited pauses, and every line is at -18 LUFS', () => {
  for (const [key, line] of Object.entries(manifest.lines)) {
    assert.ok(!/,/.test(line.text), `${key}: a comma inside the spoken line makes the voice stop and restart`);
    assert.ok(line.longestGap != null && line.longestGap <= 0.25, `${key}: ${line.longestGap}s gap inside the line`);
    assert.ok(Math.abs(line.lufs + 18) <= 0.5, `${key}: ${line.lufs} LUFS`);
  }
});

test('it opens on the problem, then the request', () => {
  assert.deepStrictEqual(SEARCHES[0].lines.opening, ['hook', 'describe']);
  assert.strictEqual(manifest.lines.hook.caption, 'Ever know exactly what you want, but not where to find it?');
  assert.strictEqual(manifest.lines.describe.caption, 'Instead of checking a bunch of stores, I can just describe it.');
  assert.ok(/I need a black oversized hoodie/.test(manifest.lines.hoodie.caption));
});

test('only the first search is named out loud; the others can change', () => {
  const first = SEARCHES[0];
  assert.strictEqual(first.queries.length, 1, 'the first query is said out loud, so it is fixed');
  const said = manifest.lines[first.lines.typing].text.toLowerCase();
  assert.ok(said.includes('black oversized hoodie') && said.includes('eighty dollars'), said);
  for (const slot of SEARCHES.slice(1)) {
    for (const key of linesOf(slot)) {
      const line = manifest.lines[key].text.toLowerCase();
      for (const q of slot.queries) {
        assert.ok(!line.includes(q.text.toLowerCase().split(' ').slice(-2).join(' ')), `"${key}" names the query "${q.text}"`);
      }
    }
  }
});

console.log('\nthe searches');

const { satisfies, editFor, changedEnough, sameShop } = require('./demo-plan');
const { quietestGap, MIN_VISITS, ON_CAMERA } = require('./record-demo');
const slot = (name) => SEARCHES.find((x) => x.slot === name);

test('the story: a hoodie, the same hoodie with a bigger budget, a dress, a designer, a whole sentence', () => {
  assert.deepStrictEqual(SEARCHES.map((x) => x.slot), ['everyday', 'refine', 'different', 'designer', 'sentence']);
  assert.strictEqual(SEARCHES[0].queries[0].text, 'black oversized hoodie under $80');
  assert.strictEqual(slot('refine').queries[0].text, 'black oversized hoodie under $120');
  assert.strictEqual(slot('refine').mode, 'edit');
  assert.strictEqual(slot('different').queries[0].text, 'cream linen midi dress for summer');
  assert.strictEqual(slot('designer').queries[0].text, 'vintage Prada bag under $500');
});

test('five to seven products are opened at their retailers, spread across the searches', () => {
  const open = SEARCHES.reduce((n, x) => n + x.open, 0);
  assert.ok(open >= 5 && open <= 7, `${open} opened`);
  assert.ok(MIN_VISITS >= 4, 'fewer than four loaded retailer pages is refused');
  assert.ok(SEARCHES.filter((x) => x.open).length >= 4, 'visits are spread over at least four searches');
});

test('the designer search is Prada and only Prada', () => {
  for (const q of slot('designer').queries) {
    assert.ok(/prada/i.test(q.text), q.text);
    assert.ok(q.brand && q.brand.test('Prada'));
  }
});

test('the sentence search asks for several things at once, with a budget', () => {
  for (const q of slot('sentence').queries) {
    assert.ok(q.text.split(' ').length >= 5, q.text);
    assert.ok(/under \$\d+/.test(q.text) && q.budget, q.text);
  }
});

test('a product passes only if it is the garment, the designer and within the budget', () => {
  const hoodie = SEARCHES[0].queries[0];
  assert.strictEqual(satisfies({ name: 'Oversized Fleece Hoodie', price: 59.99 }, hoodie), null);
  assert.strictEqual(satisfies({ name: 'Relaxed Hooded Sweatshirt', price: 80 }, hoodie), null);
  assert.match(satisfies({ name: 'Oversized Hoodie', price: 89 }, hoodie), /over the \$80 budget/);
  assert.match(satisfies({ name: 'Crewneck Sweater', price: 40 }, hoodie), /not the garment/);
  assert.match(satisfies({ name: 'Oversized Hoodie' }, hoodie), /no price/);
  const prada = slot('designer').queries[0];
  assert.strictEqual(satisfies({ name: 'Vintage Re-Edition nylon shoulder bag', brand: 'Prada', price: 420 }, prada), null);
  assert.strictEqual(satisfies({ name: 'Prada Tessuto tote bag', price: 380 }, prada), null);
  assert.match(satisfies({ name: 'Jackie 1961 shoulder bag', brand: 'Gucci', price: 480 }, prada), /designer/);
  assert.match(satisfies({ name: 'Prada Saffiano bag', brand: 'Prada', price: 650 }, prada), /budget/);
  const dress = slot('different').queries[0];
  assert.strictEqual(satisfies({ name: 'Linen Midi Dress', price: 120 }, dress), null);
  assert.match(satisfies({ name: 'Linen Midi Skirt', price: 60 }, dress), /garment/);
});

test('changing a detail by hand: to the end, delete the old ending, type the new one', () => {
  assert.deepStrictEqual(editFor('black oversized hoodie under $80', 'black oversized hoodie under $120'),
    { keep: 'black oversized hoodie under $', erase: 2, type: '120' });
});

test('a changed request is shown only if it brings different products into view', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.ok(changedEnough(before, ['a', 'x', 'y', 'b']).ok);
  assert.ok(!changedEnough(before, ['a', 'b', 'c', 'x']).ok);
  assert.ok(!changedEnough(before, ['a', 'b', 'c', 'd', 'x', 'y']).ok, 'new products below the fold do not count');
});

test('a retailer page counts only on the product\'s own shop', () => {
  assert.ok(sameShop('https://www.gap.com/p/1', 'https://www.gap.com/browse/product.do?pid=1'));
  assert.ok(sameShop('https://www2.hm.com/en_us/p.1.html', 'https://hm.com/x'));
  assert.ok(sameShop('https://shop.asos.co.uk/p/1', 'https://www.asos.co.uk/p/1'));
  assert.ok(!sameShop('https://www.gap.com/p/1', 'https://www.oldnavy.com/'));
  assert.ok(!sameShop('https://shop-a.co.uk/p', 'https://shop-b.co.uk/p'));
});

test('every product that can come into view is checked before recording', () => {
  assert.ok(ON_CAMERA >= 8, 'two rows on a desktop at least');
  const src = fs.readFileSync(path.join(__dirname, 'record-demo.js'), 'utf8');
  assert.ok(/window\.demoSeen/.test(src) && /were not checked before recording/.test(src), 'the on-camera audit is gone');
  assert.ok(/photoProblem\(file\)/.test(src), 'the real-photo test is not run on the on-camera photos');
});

test('the music is measured where nobody speaks', () => {
  const g = quietestGap([[1, 4], [5, 8], [12, 14], [20, 22]], 40);
  assert.deepStrictEqual(g.map((x) => Number(x.toFixed(1))), [22.6, 36.1]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
