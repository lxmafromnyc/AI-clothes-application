/* npm test — the film's rules, checked without rendering.

   - the locked timeline: five scenes, end to end, 960 frames; every beat
     inside its scene and in order
   - the voice: every line placed inside its scene; captions never overlap
   - real data only: the fixture passes as a preview and is refused as a
     final; broken real data is refused with a reason
   - the typing: deterministic, inside its window, one sound per key
   - the site's own wording: prices, card lines and the reading of the
     request match assets/app.js and assets/interpret.js */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { PUBLIC, REPO, attributesFrom, cardLines, formatPrice, localInterpreter } from './shared.mjs';
import { loadTs, vtt } from './timeline.mjs';

const { SCENES, BEAT, TOTAL, FPS, VOICE_AT, placeVoice, soundCues } = await loadTs('src/data/timeline.ts');
const { validate } = await loadTs('src/data/load.ts');
const { typedFrames, typedCount } = await loadTs('src/lib/typing.ts');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

console.log('timeline');
test('32.0 seconds at 30 fps: 960 frames', () => { assert.equal(FPS, 30); assert.equal(TOTAL, 960); });
test('five scenes, end to end, as locked', () => {
  assert.deepEqual(Object.entries(SCENES).map(([k, s]) => [k, s.from, s.to]), [
    ['describe', 0, 150], ['understand', 150, 255], ['results', 255, 495], ['choose', 495, 765], ['retailer', 765, 960]
  ]);
});
test('every beat in order (one may start as another ends), inside the film', () => {
  const order = ['labelIn', 'fieldClick', 'typeTo', 'searchClick', 'loadingFrom', 'queryLift', 'attrsFrom', 'compressFrom', 'compressTo', 'gridFull',
    'labelFrom', 'driftFrom', 'driftTo', 'emphasisA', 'emphasisB', 'emphasisC', 'emphasisEnd', 'bagFrom', 'returnTo', 'aMove', 'aHover', 'bMove', 'bHover',
    'cMove', 'cHover', 'click', 'handoff', 'frameIn', 'page', 'frameOut', 'mosaic', 'finalText', 'end'];
  for (let i = 1; i < order.length; i += 1) assert.ok(BEAT[order[i - 1]] <= BEAT[order[i]], `${order[i - 1]} (${BEAT[order[i - 1]]}) before ${order[i]} (${BEAT[order[i]]})`);
  assert.equal(BEAT.end, TOTAL);
});
test('beats land where the locked timeline puts them', () => {
  const at = (s) => Math.round(s * FPS);
  assert.equal(BEAT.labelIn, at(0.5)); assert.equal(BEAT.fieldClick, at(1.2)); assert.equal(BEAT.typeTo, at(4.0)); assert.equal(BEAT.searchClick, at(4.6));
  assert.equal(BEAT.attrsFrom, at(5.5)); assert.equal(BEAT.compressFrom, at(6.8)); assert.equal(BEAT.resultsIn, at(7.6));
  assert.equal(BEAT.driftFrom, at(9.5)); assert.equal(BEAT.emphasisA, at(12.0)); assert.equal(BEAT.dressFrom, at(13.5)); assert.equal(BEAT.bagFrom, at(15.0));
  assert.equal(BEAT.aMove, at(17.3)); assert.equal(BEAT.bMove, at(19.2)); assert.equal(BEAT.cMove, at(20.8)); assert.equal(BEAT.click, at(22.4)); assert.equal(BEAT.handoff, at(23.0));
  assert.equal(BEAT.page, at(27.0)); assert.equal(BEAT.frameOut, at(29.0)); assert.equal(BEAT.mosaic, at(30.0)); assert.equal(BEAT.finalText, at(31.2));
});

console.log('voice and captions');
const voiceFile = path.join(PUBLIC, 'audio', 'narration', 'voice.json');
const voice = fs.existsSync(voiceFile) ? JSON.parse(fs.readFileSync(voiceFile, 'utf8')) : null;
test('narration exists for all five lines', () => {
  assert.ok(voice, 'public/audio/narration/voice.json is missing (npm run narration)');
  assert.deepEqual(voice.map((v) => v.id).sort(), Object.keys(VOICE_AT).sort());
  for (const v of voice) assert.ok(fs.existsSync(path.join(PUBLIC, v.file)), `${v.file} missing`);
});
test('each line fits inside its scene', () => { placeVoice(voice); });
test('a line too long for its scene is refused', () => {
  const long = clone(voice);
  long.find((v) => v.id === 'understands').durationInFrames = 120;
  assert.throws(() => placeVoice(long), /outside the understand scene/);
});
test('no line is said before what it describes is on screen', () => {
  const beats = placeVoice(voice);
  const at = Object.fromEntries(beats.map((b) => [b.id, b.startFrame]));
  assert.ok(at.looking >= BEAT.labelIn && at.looking < BEAT.typeTo);
  assert.ok(at.understands >= BEAT.queryLift);
  assert.ok(at.brings >= BEAT.gridFull);
  assert.ok(at.compare >= BEAT.returnTo);
  assert.ok(at.straight >= BEAT.frameIn);
});
test('captions follow the voice and never overlap', () => {
  const text = vtt(placeVoice(voice), FPS);
  const cues = [...text.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)\n(.+)/g)]
    .map((m) => ({ start: +m[2] * 60 + +m[3] + +m[4] / 1000, end: +m[6] * 60 + +m[7] + +m[8] / 1000, text: m[9] }));
  assert.equal(cues.length, 5);
  const beats = placeVoice(voice);
  cues.forEach((c, i) => {
    assert.ok(Math.abs(c.start - beats[i].startFrame / FPS) < 0.002, `cue ${i + 1} starts with its line`);
    assert.ok(c.end >= (beats[i].startFrame + beats[i].durationInFrames) / FPS, `cue ${i + 1} lasts as long as its line`);
    if (cues[i + 1]) assert.ok(c.end <= cues[i + 1].start, `cue ${i + 1} ends before the next`);
    assert.equal(c.text, beats[i].caption);
  });
  assert.ok(cues[cues.length - 1].end <= TOTAL / FPS);
});
test('captions name Fynd as it is written; the voice is given "Find"', () => {
  for (const v of voice) assert.ok(!/\bFind\b/.test(v.caption), v.caption);
  assert.ok(voice.some((v) => /Fynd/.test(v.caption)));
});
test('no commas inside a spoken line', () => { for (const v of voice) assert.ok(!v.spoken.includes(','), v.spoken); });

console.log('real data only');
const fixture = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data', 'captured.fixture.json'), 'utf8'));
test('the fixture is fine for a preview', () => assert.deepEqual(validate(fixture, 'fixture'), []));
test('the fixture is refused as a final', () => assert.match(validate(fixture, 'real').join('\n'), /not real/));
const real = (() => {
  const d = clone(fixture);
  d.source = 'real';
  for (const s of d.searches) for (const p of s.products) p.url = p.url.replace('http:', 'https:');
  d.retailer.url = d.retailer.url.replace('http:', 'https:');
  return d;
})();
test('well-formed real data passes', () => assert.deepEqual(validate(real, 'real'), []));
const refuses = (what, change, pattern) => test(`refuses ${what}`, () => {
  const d = clone(real);
  change(d);
  assert.match(validate(d, 'real').join('\n'), pattern);
});
refuses('a product with no price', (d) => { d.searches[0].products[0].price = ''; }, /no price/);
refuses('a product with no photo', (d) => { d.searches[1].products[0].image = ''; }, /no photo/);
refuses('a product link that is not https', (d) => { d.searches[2].products[0].url = 'http://shop.example.com/p/1'; }, /no real product link/);
refuses('A, B and C from fewer than three shops', (d) => { const h = d.searches[0].products; h.find((p) => p.id === d.choose[1]).retailer = h.find((p) => p.id === d.choose[0]).retailer; }, /three different retailers/);
refuses('a retailer page that is not C\'s', (d) => { d.retailer.productId = d.choose[0]; }, /not product C/);
refuses('a chosen product that is not a hoodie result', (d) => { d.choose[0] = d.searches[1].products[0].id; }, /not a hoodie result/);
refuses('a missing search', (d) => { d.searches = d.searches.filter((s) => s.id !== 'bag'); }, /no "bag" search/);
refuses('a mosaic product from nowhere', (d) => { d.mosaic.push('made-up'); }, /mosaic product made-up/);

console.log('typing and sound');
const query = fixture.searches[0].query;
const typed = typedFrames(query, BEAT.typeFrom + 3, BEAT.typeTo - 2);
test('the same keystrokes every time', () => assert.deepEqual(typed, typedFrames(query, BEAT.typeFrom + 3, BEAT.typeTo - 2)));
test('typing starts after the click and is done before the pointer leaves', () => {
  assert.ok(typed[0] > BEAT.fieldClick); assert.ok(typed[typed.length - 1] <= BEAT.typeTo);
  for (let i = 1; i < typed.length; i += 1) assert.ok(typed[i] >= typed[i - 1]);
  assert.equal(typedCount(typed, BEAT.typeTo), query.length);
});
test('one key sound per character, each cue a file', () => {
  const cues = soundCues(typed);
  assert.equal(cues.filter((c) => c.sound.startsWith('key-')).length, query.length);
  for (const c of cues) assert.ok(fs.existsSync(path.join(PUBLIC, 'audio', 'sfx', `${c.sound}.wav`)), `${c.sound}.wav (npm run sfx)`);
  for (const c of cues) assert.ok(c.at >= 0 && c.at < TOTAL && c.volume <= 0.5);
});
test('no hover ticks on the phone, where nothing hovers', () => {
  assert.ok(soundCues(typed, 'desktop').some((c) => c.sound === 'hover'));
  assert.ok(!soundCues(typed, 'mobile').some((c) => c.sound === 'hover'));
});

console.log('the site’s own wording');
const app = fs.readFileSync(path.join(REPO, 'assets', 'app.js'), 'utf8');
const siteFormat = (() => {
  const src = /function formatPrice\(value\) \{[\s\S]*?\n\}/.exec(app)[0];
  return vm.runInNewContext(`(${src.replace('function formatPrice', 'function')})`);
})();
test('prices are written as the site writes them', () => {
  for (const v of [72.5, 80, '49.99', 0.5, null, 'n/a', 120]) assert.equal(formatPrice(v), siteFormat(v), String(v));
});
test('card lines follow the site: brand first, then where the link goes', () => {
  assert.deepEqual(cardLines({ brand: 'Nike', retailer: 'Foot Locker', productUrl: 'https://www.footlocker.com/p/1' }), { top: 'Nike', where: 'Foot Locker' });
  assert.deepEqual(cardLines({ retailer: 'ASOS', productUrl: 'https://www.asos.com/p/1' }), { top: 'ASOS', where: 'asos.com' });
});
test('the hoodie request reads as the site reads it', () => {
  const attrs = attributesFrom(localInterpreter().localInterpret('black oversized hoodie under $80', {}));
  assert.deepEqual(attrs, [
    { label: 'Colour', value: 'Black' }, { label: 'Fit', value: 'Oversized' }, { label: 'Garment', value: 'Hoodie' }, { label: 'Budget', value: 'Under $80' }
  ]);
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed` : ''}`);
if (failures.length) process.exit(1);
