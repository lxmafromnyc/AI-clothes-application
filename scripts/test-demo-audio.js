#!/usr/bin/env node
/* =========================================================
   Fynd — the demo video's sound

   What the mix has to be, checked with numbers rather than taste:

     the meter reads loudness the way the standard does;
     every narration line is the same loudness, its peaks held, and fits
       the moment it is said in both committed videos;
     the voice lands at -16 LUFS and nothing comes near clipping;
     the music sits well under the voice while it speaks, and moves out
       of the way smoothly — no pumping — and comes back between lines;
     it starts from silence and ends in silence;
     the captions follow the voice and never overlap;
     the same timeline gives the same sound, bit for bit.

   Offline, no ffmpeg:  node scripts/test-demo-audio.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const A = require('./demo-audio');

const DEMO = path.join(__dirname, '..', 'assets', 'demo');
const NARRATION = path.join(DEMO, 'narration');
const manifest = JSON.parse(fs.readFileSync(path.join(NARRATION, 'manifest.json'), 'utf8'));

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const sineWave = (hz, amp, seconds, phase = 0) => {
  const x = new Float32Array(Math.round(seconds * A.SR));
  for (let i = 0; i < x.length; i += 1) x[i] = amp * Math.sin(2 * Math.PI * hz * i / A.SR + phase);
  return x;
};
const rmsDb = (x, from, to) => {
  const a = Math.round(from);
  const b = Math.round(to);
  let s = 0;
  for (let i = a; i < b; i += 1) s += x[i] * x[i];
  return 10 * Math.log10(s / (b - a) + 1e-20);
};

console.log('\nthe meter');

test('a full-scale 997 Hz sine on one channel reads -3.01 LUFS (ITU-R BS.1770)', () => {
  near(A.integratedLoudness([sineWave(997, 1, 5)]), -3.01, 0.05, 'loudness');
});

test('the same sine at -20 dBFS on two channels reads -20 LUFS', () => {
  const x = sineWave(997, 0.1, 5);
  near(A.integratedLoudness([x, x]), -20, 0.05, 'loudness');
});

test('silence is below the absolute gate', () => {
  assert.strictEqual(A.integratedLoudness([new Float32Array(A.SR * 2)]), -Infinity);
});

test('true peak sees the peak between the samples', () => {
  /* a quarter-rate sine sampled 45 degrees off its crest: every sample is
     0.707, the wave itself reaches 1.0 */
  const x = sineWave(A.SR / 4, 1, 1, Math.PI / 4);
  near(A.truePeak([x]), 0, 0.3, 'true peak');
});

console.log('\nthe narration');

test('every line is at -19 LUFS, its peaks held at least 12 dB under full scale', () => {
  for (const [key, line] of Object.entries(manifest.lines)) {
    const clip = A.readWav(path.join(NARRATION, line.file));
    near(A.integratedLoudness([clip]), -19, 0.3, `${key} loudness`);
    let peak = 0;
    for (const v of clip) peak = Math.max(peak, Math.abs(v));
    assert.ok(20 * Math.log10(peak) <= -4, `${key} peaks at ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
  }
});

const wordsOf = (text) => (text.match(/[A-Za-z’'$0-9]+/g) || []).map((w) => w.toLowerCase().replace(/’/g, "'"));

test('each line keeps its caption word for word, and says "Fynd" as "Find"', () => {
  for (const [key, line] of Object.entries(manifest.lines)) {
    assert.ok(line.text && line.spoken, key);
    /* the words, not the punctuation: a pause can be written one way
       for the voice and another for the reader */
    assert.deepStrictEqual(wordsOf(line.spoken.replace(/\bFind\b/g, 'Fynd')), wordsOf(line.text), key);
  }
});

test('every line given a delivery is still heard back word for word', () => {
  const delivered = Object.entries(manifest.lines).filter(([, l]) => l.delivery);
  assert.ok(delivered.length >= 9, 'the film\'s lines are there');
  for (const [key, line] of delivered) {
    const said = wordsOf(line.spoken).flatMap((w) => (w === 'okay' ? ['o', 'k'] : [w]));
    assert.deepStrictEqual(wordsOf(line.heard), said, `${key} was heard as "${line.heard}"`);
  }
});

test('every delivered line knows where each of its words is, in order, inside the clip', () => {
  for (const [key, line] of Object.entries(manifest.lines).filter(([, l]) => l.delivery)) {
    assert.ok(line.onset >= 0 && line.onset < 0.6, `${key} onset ${line.onset}`);
    assert.strictEqual(line.words.length, wordsOf(line.spoken).length, key);
    line.words.forEach((w, i) => {
      assert.ok(w.at >= line.onset - 0.05 && w.at < line.duration, `${key}: "${w.word}" at ${w.at}`);
      if (i) assert.ok(w.at >= line.words[i - 1].at, `${key}: "${w.word}" before the word ahead of it`);
    });
    if (line.parts.length > 1) line.parts.forEach((p, i) => i && assert.ok(p.at >= line.parts[i - 1].end, `${key}: parts overlap`));
  }
});

for (const name of ['fynd-demo', 'fynd-demo-mobile']) {
  test(`${name}: every line ends before the next begins, and the last before the video does`, () => {
    const tl = JSON.parse(fs.readFileSync(path.join(DEMO, `${name}.timeline.json`), 'utf8'));
    const starts = tl.lines.map((l) => ({ key: l.key, at: l.key === 'close' ? A.closeAt(tl) : l.at }));
    starts.forEach((l, i) => {
      const end = l.at + manifest.lines[l.key].duration;
      const next = starts[i + 1];
      if (next) assert.ok(end <= next.at - 0.1, `${l.key} ends at ${end.toFixed(2)}s, ${next.key} starts at ${next.at.toFixed(2)}s`);
      else assert.ok(end <= tl.duration - 0.5, `${l.key} ends ${(tl.duration - end).toFixed(2)}s before the end`);
    });
  });
}

console.log('\nthe mix');

/* one search's worth of video, with real narration clips */
const timeline = {
  video: 'test', duration: 20,
  lines: [{ key: 'looking', at: 1.5 }, { key: 'found', at: 9 }, { key: 'close', at: 15.2 }],
  searches: [{ typing: 0.8, searched: 6, results: 7.6, retailer: [12.2, 14] }]
};
const mix = A.render(timeline, manifest);
const L = mix.left;
const music = mix.stems.music[0];
const SR = A.SR;

test('the voice is at -16 LUFS', () => {
  near(mix.report.voiceLufs, A.TARGET_LUFS, 0.1, 'voice');
});

test('nothing comes near clipping: true peak at or under -2 dBTP', () => {
  assert.ok(A.truePeak([mix.left, mix.right]) <= A.CEILING_DBTP + 0.05, `true peak ${A.truePeak([mix.left, mix.right]).toFixed(2)} dBTP`);
});

test('it starts from silence and ends in silence', () => {
  assert.ok(rmsDb(L, 0, 480) < -80, `start ${rmsDb(L, 0, 480).toFixed(1)} dB`);
  assert.ok(rmsDb(L, L.length - 480, L.length) < -60, `end ${rmsDb(L, L.length - 480, L.length).toFixed(1)} dB`);
});

test('the music is well under the voice while it speaks', () => {
  /* during "found" (9 s to 12 s), voice against music */
  const voice = mix.stems.voice[0];
  const gap = rmsDb(voice, 9.3 * SR, 11.5 * SR) - rmsDb(music, 9.3 * SR, 11.5 * SR);
  assert.ok(gap >= 12, `voice only ${gap.toFixed(1)} dB over the music`);
});

test('the music moves out of the way for a line and comes back after it', () => {
  const before = rmsDb(music, 7.9 * SR, 8.5 * SR);
  const under = rmsDb(music, 9.6 * SR, 10.2 * SR);
  const after = rmsDb(music, 13.2 * SR, 13.8 * SR);
  assert.ok(before - under >= 5, `only ${(before - under).toFixed(1)} dB down under the voice`);
  assert.ok(after - under >= 4, `only ${(after - under).toFixed(1)} dB back after the line`);
});

test('the ducking never moves faster than a fade: no pumping', () => {
  const spans = timeline.lines.map((l) => ({ at: l.at, end: l.at + manifest.lines[l.key].duration }));
  const d = A.duckCurve(spans, timeline.duration * SR);
  const step = Math.round(0.01 * SR);
  let fastest = 0;
  for (let i = step; i < d.length; i += step) fastest = Math.max(fastest, Math.abs(d[i] - d[i - step]));
  /* the whole move takes at least a third of a second, so no 10 ms step
     covers more than about a twentieth of it */
  assert.ok(fastest <= 0.06, `the duck moved ${(fastest * 100).toFixed(1)}% of its depth in 10 ms`);
  assert.ok(Object.values(A.DUCK_DB).every((db) => db <= -5 && db >= -14), 'duck depths are moderate');
});

test('the music is set under the voice, not on top of it', () => {
  assert.ok(A.MUSIC_BELOW_VOICE_LU >= 8 && A.MUSIC_BELOW_VOICE_LU <= 14);
});

test('the score follows the timeline: a chord at every moment, every note inside the video', () => {
  const p = A.plan(timeline);
  for (let t = 0; t < timeline.duration; t += 0.25) {
    assert.ok(p.chords.some((c) => c.from - 0.2 <= t && t <= c.to + 0.01), `no chord at ${t}s`);
  }
  assert.ok(p.notes.every((nt) => nt.at >= 0 && nt.at < timeline.duration), 'a note outside the video');
  /* the lift on results, and the note at the retailer */
  assert.ok(p.notes.some((nt) => nt.at > 7.6 && nt.at < 8.5), 'no lift when the results arrive');
  assert.ok(p.notes.some((nt) => nt.at >= 12.2 && nt.at < 12.5), 'no note at the retailer');
});

test('the captions follow the voice, in order, never overlapping', () => {
  const vtt = A.captions(mix.spans, timeline.duration);
  const times = [...vtt.matchAll(/(\d\d):(\d\d):(\d\d)\.(\d\d\d) --> (\d\d):(\d\d):(\d\d)\.(\d\d\d)/g)]
    .map((m) => [(+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000, (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000]);
  /* the closing line is two sentences, and gets a cue for each */
  assert.strictEqual(times.length, 4);
  times.forEach(([s, e], i) => {
    assert.ok(e > s, `cue ${i + 1} ends before it starts`);
    if (times[i + 1]) assert.ok(e <= times[i + 1][0], `cue ${i + 1} overlaps the next`);
  });
  assert.ok(vtt.includes('Fynd finds matching products from different retailers.'));
  assert.ok(vtt.includes('No more searching store after store.\n') && vtt.includes('Describe it, and Fynd finds it.\n'));
  near(times[2][0], 15.2 - A.CLOSE_LEAD_S, 0.002, 'the last line is laid in just before the cut');
});

test('a line of two sentences is captioned sentence by sentence, each where it is heard', () => {
  const clip = A.readWav(path.join(NARRATION, manifest.lines.finale.file));
  const parts = A.sentencesOf(manifest.lines.finale.text, clip, 10);
  assert.deepStrictEqual(parts.map((p) => p.text), ['Describe what you want.', 'Fynd finds it.']);
  const [pause] = A.pausesIn(clip);
  assert.ok(pause.to - pause.from >= 0.3, 'the pause between them');
  assert.ok(parts[0].end <= parts[1].at && parts[1].at >= 10 + pause.from, 'the second waits for the pause');
  /* a one-sentence line stays whole */
  assert.strictEqual(A.sentencesOf('Pick one.', A.readWav(path.join(NARRATION, manifest.lines.pick.file)), 0), null);
});

test('caption times never round up into the next second wrongly', () => {
  const vtt = A.captions([{ text: 'x', at: 1.9996, end: 2.5 }], 10);
  assert.ok(vtt.includes('00:00:02.000 -->'), vtt);
});

test('the same timeline gives the same sound, bit for bit', () => {
  const again = A.render(timeline, manifest);
  const hash = (x) => crypto.createHash('sha256').update(Buffer.from(x.buffer)).digest('hex');
  assert.strictEqual(hash(again.left), hash(mix.left));
  assert.strictEqual(hash(again.right), hash(mix.right));
});

test('the mix is stereo: the music is wide, the voice is centred', () => {
  const [vl, vr] = mix.stems.voice;
  let diff = 0;
  for (let i = 0; i < vl.length; i += 97) diff = Math.max(diff, Math.abs(vl[i] - vr[i]));
  assert.ok(diff < 0.05, 'the voice is off centre');
  const [ml, mr] = mix.stems.music;
  let same = true;
  for (let i = 5 * SR; i < 6 * SR; i += 101) if (Math.abs(ml[i] - mr[i]) > 1e-4) { same = false; break; }
  assert.ok(!same, 'the music is mono');
});

console.log('\nthe film\'s score');

const Film = require('./demo-film');
const Score = require('./demo-score');
const films = ['desktop', 'mobile'].map((k) => Film.filmTimeline(new Film.Film(k, Film.facts())));

for (const tl of films) {
  const p = Score.planScore(tl);
  const m = tl.marks;
  const cueAt = (anchor, what) => p.cues.filter((c) => c.anchor === anchor && (!what || c.what.startsWith(what)));

  test(`${tl.video}: every musical event is placed on a named moment of the picture`, () => {
    assert.ok(p.cues.length >= 40, `${p.cues.length} cues`);
    for (const c of p.cues) {
      assert.ok(c.anchor && Number.isFinite(c.anchorAt), JSON.stringify(c));
      assert.ok(c.at >= 0 && c.at <= tl.duration, `${c.what} at ${c.at}`);
      /* on the moment, or (a swell) cresting on it, never seconds off */
      assert.ok(Math.abs(c.at - c.anchorAt) <= 0.25, `${c.what} is ${(c.at - c.anchorAt).toFixed(2)} s from "${c.anchor}"`);
    }
  });

  test(`${tl.video}: Search, the results, the choice and the store each have their musical moment, on the frame`, () => {
    m.searches.forEach((s, k) => {
      const n = k + 1;
      const search = cueAt(`search ${n}: Search pressed`);
      assert.ok(search.length && Math.abs(search[0].at - s.submit) < 0.001, `search ${n}: nothing on Search`);
      const lift = cueAt(`search ${n}: results appear`, 'chord');
      assert.ok(lift.length && Math.abs(lift[0].at - s.results) < 0.001, `search ${n}: the lift is not on the results`);
      const chosen = cueAt(`search ${n}: product chosen`);
      assert.ok(chosen.length && chosen[0].at - s.select >= 0 && chosen[0].at - s.select <= 0.03, `search ${n}: the choice`);
      const store = cueAt(`search ${n}: the store's page opens`, 'chord');
      assert.ok(store.length && Math.abs(store[0].at - s.handoff) < 0.001, `search ${n}: the store`);
    });
  });

  test(`${tl.video}: it goes quiet while each search runs, and BAPE is its one high point`, () => {
    const level = (t) => {
      let k = 0;
      while (k < p.level.length - 2 && p.level[k + 1][0] <= t) k += 1;
      return p.level[k][1];
    };
    m.searches.forEach((s, k) => {
      /* a search that takes a moment is waited for in near-silence */
      if (k !== 2 && s.results - s.submit >= 0.45) assert.ok(level(s.results - 0.1) <= 0.25, `search ${k + 1} is not hushed before its results`);
    });
    const peak = Math.max(...p.level.map((x) => x[1]));
    const at = p.level.find((x) => x[1] === peak)[0];
    const bape = m.searches[2];
    assert.ok(at >= bape.results && at <= bape.select, `the high point is at ${at}`);
    assert.ok(level(bape.submit - 0.2) <= 0.25, 'BAPE is not hushed while it is typed');
  });

  test(`${tl.video}: under the last line it is one quiet chord; it comes home as the last word is said`, () => {
    const close = p.chords.find((c) => c.name === 'Dclose');
    const home = p.chords.find((c) => c.name === 'Dhome');
    const finale = tl.lines.find((l) => l.key === 'finale');
    assert.ok(close && Math.abs(close.from - m.close.start) < 0.001);
    assert.ok(home && home.from - finale.ends >= 0 && home.from - finale.ends <= 0.15, 'the resolution is not on the last word');
    const last = p.glass.filter((g) => g.at > finale.ends).pop();
    assert.ok(Math.abs(last.at - m.close.mark) < 0.001, 'the last note is not on the mark');
  });
}

test('the film’s mix: from silence, back to silence on the last frame, the voice clear over the score', () => {
  const tl = films[0];
  const mixed = A.render(tl, manifest);
  const L = mixed.left;
  assert.ok(rmsDb(L, 0, 0.15 * SR) < -80, 'it does not start from silence');
  assert.ok(rmsDb(L, L.length - 0.02 * SR, L.length) < -60, `the last frame is not silent: ${rmsDb(L, L.length - 0.02 * SR, L.length).toFixed(1)} dB`);
  near(mixed.report.voiceLufs, A.TARGET_LUFS, 0.1, 'voice');
  assert.ok(A.truePeak([mixed.left, mixed.right]) <= A.CEILING_DBTP + 0.05);
  /* during every line, the voice well over the music — weighted the way
     loudness is (BS.1770), so a low pad is not counted as masking */
  const voice = A.kWeight(mixed.stems.voice[0]);
  const music = A.kWeight(mixed.stems.music[0]);
  for (const l of tl.lines) {
    const a = (l.speech + 0.3) * SR;
    const b = (l.ends - 0.1) * SR;
    const gap = rmsDb(voice, a, b) - rmsDb(music, a, b);
    assert.ok(gap >= 12, `${l.key}: the voice only ${gap.toFixed(1)} dB over the music`);
  }
  assert.ok(mixed.cues.length >= 40, 'the cues come back with the mix');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
