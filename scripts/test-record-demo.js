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

const { ffprobeFor, durationCommand, planCut, SEARCHES } = require('./record-demo');

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

console.log('\nthe narration');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'demo', 'narration', 'manifest.json'), 'utf8'));

test('every line the searches use has been spoken, plus the retailer line', () => {
  const used = new Set(SEARCHES.flatMap((x) => [x.typing, x.before, x.results, x.browse]).filter(Boolean).concat('retailer'));
  for (const key of used) {
    assert.ok(manifest.lines[key], `no "${key}" line`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'assets', 'demo', 'narration', manifest.lines[key].file)), `${key}: file missing`);
  }
});

test('no line is read with recited pauses', () => {
  for (const [key, line] of Object.entries(manifest.lines)) {
    assert.ok(!/,/.test(line.text), `${key}: a comma inside the line makes the voice stop and restart`);
    assert.ok(line.longestGap != null && line.longestGap <= 0.3, `${key}: ${line.longestGap}s gap inside the line`);
  }
});

test('only the first search is named out loud; the others can change', () => {
  const first = SEARCHES[0];
  assert.strictEqual(first.queries.length, 1, 'the first query is said out loud, so it is fixed');
  const looking = manifest.lines[first.typing].text.toLowerCase();
  assert.ok(looking.includes('black oversized hoodie') && looking.includes('eighty dollars'), looking);
  for (const slot of SEARCHES.slice(1)) {
    for (const key of [slot.typing, slot.before, slot.results].filter(Boolean)) {
      const said = manifest.lines[key].text.toLowerCase();
      for (const q of slot.queries) {
        assert.ok(!said.includes(q.toLowerCase().split(' ').slice(-2).join(' ')), `"${key}" names the query "${q}"`);
      }
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
