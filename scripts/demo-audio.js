#!/usr/bin/env node
/* =========================================================
   Fynd — the demo video's sound

   The narration, and a score written for this video and no other,
   mixed the way a product film is mixed:

     the voice first, close and clear, every line at one loudness;
     under it, a quiet, warm, airy bed — soft pads in D, a felt-like
     glass note now and then, a little air — that follows what the
     screen does rather than looping underneath it:

       opening          a soft entrance under the first line
       searching        a little more texture: air, a brighter pad
       results          a lift: the chord opens, three quiet notes
       retailer         the smallest rise, one note
       the last line    the music comes home to D and lets go

     no drums, no lead melody, no build, no vocals.

   The music moves under the voice on its own: it starts to fall just
   before each line, sits lower — brighter parts lower still, so the
   words have the presence range to themselves — and comes back slowly
   after. The fall is drawn from where the lines are, not from a
   compressor listening to them, so nothing pumps.

   The finished mix is measured the way broadcasters measure it (ITU
   BS.1770): the voice is set to -16 LUFS — the level web video and
   podcasts are made to, measured on the voice the way dialogue is — and
   the music is set against it. A true-peak ceiling of -2 dBTP keeps the
   AAC and Opus encodes clear of clipping; with the narration's own peaks
   already held (scripts/demo-narration.py) the limiter rarely has
   anything to do.

   Everything is computed here: no samples, no loops, no libraries.
   The same timeline gives the same sound, bit for bit.

   Used two ways:

     by scripts/record-demo.js, which hands it the timeline of each
     recording it makes;

     on its own, to give the committed videos new sound without
     touching a frame of them:

       node scripts/demo-audio.js --remix              both
       node scripts/demo-audio.js --remix --only=mobile
       node scripts/demo-audio.js --stems=DIR          also write the
                                                        voice and music
                                                        stems, to listen

   It reads assets/demo/<video>.timeline.json — when each line is said,
   and when each search is made, answered and opened — and the narration
   clips in assets/demo/narration/.

   The homepage film (scripts/demo-film.js) has a score of its own,
   written to the film's marks: scripts/demo-score.js. This file mixes
   it — the voice, its ducking, the sound design, the level and the
   ceiling — exactly as it mixes the recorder's.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DEMO = path.join(REPO, 'assets', 'demo');
const NARRATION = path.join(DEMO, 'narration');
const SR = 48000;

/* the finished mix: the voice's loudness, measured on the voice */
const TARGET_LUFS = -16;
const CEILING_DBTP = -2;
/* the music, relative to the voice: its level between lines, and how far
   it moves under them (the brighter layers further) */
const MUSIC_BELOW_VOICE_LU = 10;
const DUCK_DB = { body: -7, bright: -11, notes: -6, air: -10 };
/* the last line is laid in a moment before the cut back to Fynd, the way
   an editor lets sound lead picture */
const CLOSE_LEAD_S = 0.4;

/* ---------------------------------------------------------
   Small pieces
   --------------------------------------------------------- */

const dbToGain = (db) => Math.pow(10, db / 20);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* a seeded generator, so the air is the same air every time */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* raised-cosine step from 0 to 1 over [a, b] */
function smoothstep(t, a, b) {
  if (t <= a) return 0;
  if (t >= b) return 1;
  return 0.5 - 0.5 * Math.cos(Math.PI * (t - a) / (b - a));
}

const SINE = (() => {
  const n = 8192;
  const t = new Float64Array(n + 1);
  for (let i = 0; i <= n; i += 1) t[i] = Math.sin((2 * Math.PI * i) / n);
  return t;
})();
function sine(phase) {
  const x = (phase - Math.floor(phase)) * 8192;
  const i = x | 0;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i);
}

/* ---------------------------------------------------------
   WAV in and out
   --------------------------------------------------------- */

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV file`);
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
      if (fmt.format === 0xFFFE) fmt.format = b.readUInt16LE(body + 24);
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${file}: data before fmt`);
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c += 1) {
          const at = body + (i * fmt.channels + c) * bytes;
          let v;
          if (fmt.format === 3) v = bytes === 4 ? b.readFloatLE(at) : b.readDoubleLE(at);
          else if (bytes === 2) v = b.readInt16LE(at) / 32768;
          else if (bytes === 3) v = (b.readIntLE(at, 3)) / 8388608;
          else if (bytes === 4) v = b.readInt32LE(at) / 2147483648;
          else throw new Error(`${file}: ${fmt.bits}-bit audio is not read here`);
          sum += v;
        }
        out[i] = sum / fmt.channels;
      }
      if (fmt.rate !== SR) throw new Error(`${file} is ${fmt.rate} Hz; the narration is made at ${SR} Hz`);
      return out;
    }
    pos = body + size + (size % 2);
  }
  throw new Error(`${file} has no audio`);
}

/* 24-bit stereo PCM */
function writeWav(file, left, right) {
  const frames = left.length;
  const data = Buffer.alloc(frames * 6);
  for (let i = 0; i < frames; i += 1) {
    data.writeIntLE(Math.round(clamp(left[i], -1, 1 - 1 / 8388608) * 8388607), i * 6, 3);
    data.writeIntLE(Math.round(clamp(right[i], -1, 1 - 1 / 8388608) * 8388607), i * 6 + 3, 3);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 6, 28); head.writeUInt16LE(6, 32); head.writeUInt16LE(24, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

/* ---------------------------------------------------------
   Measuring: ITU-R BS.1770-4 integrated loudness, and true peak
   --------------------------------------------------------- */

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float64Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/* RBJ cookbook filters, for shaping the music bus */
function peaking(x, f0, q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha / A;
  return biquad(x, (1 + alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha * A) / a0, (-2 * Math.cos(w)) / a0, (1 - alpha / A) / a0);
}
function highShelf(x, f0, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / SR;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / 2 * Math.SQRT2;
  const r = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cos + r;
  return biquad(x,
    (A * ((A + 1) + (A - 1) * cos + r)) / a0, (-2 * A * ((A - 1) + (A + 1) * cos)) / a0, (A * ((A + 1) + (A - 1) * cos - r)) / a0,
    (2 * ((A - 1) - (A + 1) * cos)) / a0, ((A + 1) - (A - 1) * cos - r) / a0);
}

/* K-weighting at 48 kHz: the standard's own coefficients */
const kWeight = (x) => biquad(
  biquad(x, 1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585),
  1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621);

/* integrated loudness of one or more channels, gated (-70 LUFS absolute,
   -10 LU relative), 400 ms blocks with 75% overlap */
function integratedLoudness(channels) {
  const weighted = channels.map(kWeight);
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const n = weighted[0].length;
  const powers = [];
  for (let start = 0; start + block <= n; start += hop) {
    let p = 0;
    for (const ch of weighted) {
      let s = 0;
      for (let i = start; i < start + block; i += 1) s += ch[i] * ch[i];
      p += s / block;
    }
    powers.push(p);
  }
  const lufs = (p) => -0.691 + 10 * Math.log10(p);
  const loud = powers.filter((p) => p > 0 && lufs(p) > -70);
  if (!loud.length) return -Infinity;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const gate = lufs(mean(loud)) - 10;
  const kept = loud.filter((p) => lufs(p) > gate);
  return lufs(mean(kept));
}

/* peak between the samples, estimated at 4x with a short windowed sinc */
function truePeak(channels) {
  const taps = 12;
  const kernel = [];
  for (let phase = 1; phase < 4; phase += 1) {
    const k = [];
    for (let j = -taps + 1; j <= taps; j += 1) {
      const x = j - phase / 4;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / taps);
      k.push(sinc * w);
    }
    kernel.push(k);
  }
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
    for (let i = taps; i < ch.length - taps; i += 1) {
      if (Math.abs(ch[i]) < peak * 0.5) continue;
      for (const k of kernel) {
        let v = 0;
        for (let j = 0; j < k.length; j += 1) v += k[j] * ch[i - taps + 1 + j];
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/* ---------------------------------------------------------
   A plate-like reverb (Freeverb's comb and all-pass network)
   --------------------------------------------------------- */

function reverb(inL, inR, { room = 0.86, damp = 0.4, predelay = 0.022 } = {}) {
  const scale = SR / 44100;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round(n * scale));
  const alls = [556, 441, 341, 225].map((n) => Math.round(n * scale));
  const spread = Math.round(23 * scale);
  const feedback = room * 0.28 + 0.7;
  const pre = Math.round(predelay * SR);
  const run = (input, offset) => {
    const n = input.length;
    const out = new Float32Array(n);
    const cb = combs.map((len) => ({ buf: new Float32Array(len + offset), i: 0, store: 0 }));
    const ab = alls.map((len) => ({ buf: new Float32Array(len + offset), i: 0 }));
    for (let t = 0; t < n; t += 1) {
      const x = (t >= pre ? input[t - pre] : 0) * 0.015;
      let sum = 0;
      for (const c of cb) {
        const y = c.buf[c.i];
        c.store = y * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * feedback;
        c.i = (c.i + 1) % c.buf.length;
        sum += y;
      }
      for (const a of ab) {
        const y = a.buf[a.i];
        a.buf[a.i] = sum + y * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        sum = y - sum;
      }
      out[t] = sum;
    }
    return out;
  };
  return [run(inL, 0), run(inR, spread)];
}

/* ---------------------------------------------------------
   The score
   --------------------------------------------------------- */

/* Voicings in D. The lowest note of each goes to the sub; the rest to
   the pads. Close, warm voicings in the middle of the keyboard — where
   a phone speaker can still carry them — with the ninths and elevenths
   that make a chord feel open rather than resolved. */
const CHORDS = {
  I: [38, 50, 57, 61, 64, 66],      /* Dmaj9 */
  Ia: [38, 50, 57, 62, 64, 69],     /* D(add9), A on top */
  vi: [35, 47, 54, 57, 62, 64],     /* Bm11 */
  iii: [42, 54, 57, 61, 64, 66],    /* F#m7(add11) */
  IV: [43, 50, 54, 57, 59, 64],     /* Gmaj9(13) */
  V: [45, 52, 57, 59, 62, 64],      /* A sus, add9 */
  home: [38, 50, 54, 57, 61, 64, 69] /* Dmaj9, spread: the last chord */
};

/* Each search goes round its own short cycle — typing, searching,
   results, retailer — so the harmony moves with the interface and the
   four searches are never quite the same. */
const CYCLES = [
  ['I', 'vi', 'IV', 'V'],
  ['Ia', 'iii', 'IV', 'V'],
  ['vi', 'iii', 'IV', 'V'],
  ['IV', 'vi', 'Ia', 'V']
];

/* what the music does when, from the timeline: chord regions, the notes
   it plays, and how much it is doing (0 to 1) at every moment */
function plan(timeline) {
  const end = timeline.duration;
  const chords = [];
  const notes = [];
  const searches = timeline.searches;
  searches.forEach((s, i) => {
    const cycle = CYCLES[i % CYCLES.length];
    const next = searches[i + 1] ? searches[i + 1].typing : closeAt(timeline);
    const from = i === 0 ? 0 : s.typing;
    chords.push({ name: cycle[0], from, to: s.searched });
    chords.push({ name: cycle[1], from: s.searched, to: s.results });
    chords.push({ name: cycle[2], from: s.results, to: s.retailer ? s.retailer[0] : next });
    if (s.retailer) chords.push({ name: cycle[3], from: s.retailer[0], to: next });

    /* results: three quiet notes, rising, from the chord that arrives */
    const lift = CHORDS[cycle[2]];
    [lift[3] + 12, lift[4] + 12, lift[5] + 12].forEach((m, k) => notes.push({ midi: m, at: s.results + 0.18 + k * 0.24 + k * k * 0.02, vel: 0.55 - k * 0.08, pan: [-0.35, 0.3, -0.1][k] }));
    /* the retailer: one note, higher, a touch of light */
    if (s.retailer) notes.push({ midi: CHORDS[cycle[3]][4] + 24, at: s.retailer[0] + 0.05, vel: 0.38, pan: 0.4 });
  });
  const close = closeAt(timeline);
  chords.push({ name: 'home', from: close - 0.6, to: end + 4 });
  /* the end: four notes coming down onto D, unhurried */
  [[78, 0.0, 0.42], [76, 0.62, 0.36], [73, 1.32, 0.33], [74, 2.15, 0.4]].forEach(([m, dt, v], k) => notes.push({ midi: m, at: close + 0.15 + dt, vel: v, pan: [0.3, -0.25, 0.2, 0][k] }));

  /* how much the music is doing: quiet while typing, a little more while
     it searches, a lift on results, the smallest rise at the retailer,
     settling for the last line */
  const points = [[0, 0.32]];
  searches.forEach((s) => {
    points.push([s.typing, 0.32], [s.searched, 0.45], [s.results - 0.05, 0.52], [s.results + 0.6, 0.72]);
    if (s.retailer) points.push([s.retailer[0], 0.8], [s.retailer[1], 0.6]);
  });
  points.push([close, 0.6], [end, 0.4]);
  points.sort((a, b) => a[0] - b[0]);
  const searching = searches.map((s) => [s.searched, s.results]);
  return { chords, notes, points, searching, close, end };
}

const closeAt = (timeline) => {
  if (timeline.close !== undefined) return timeline.close;
  const line = timeline.lines.find((l) => l.key === 'close');
  return line ? Math.max(0, line.at - CLOSE_LEAD_S) : timeline.duration - 4.5;
};

/* a value that moves between the plan's points over about half a second,
   never faster */
function curve(points, n, smoothing = 0.45) {
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    while (k < points.length - 2 && points[k + 1][0] <= t) k += 1;
    const [t0, v0] = points[k];
    const [t1, v1] = points[Math.min(k + 1, points.length - 1)];
    out[i] = t >= t1 ? v1 : t <= t0 ? v0 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
  }
  const a = Math.exp(-1 / (smoothing * SR));
  let y = out[0];
  for (let i = 0; i < n; i += 1) { y = a * y + (1 - a) * out[i]; out[i] = y; }
  return out;
}

/* One chord region of pad: every note as three slightly detuned voices
   spread across the stereo field. Each is a fundamental with a soft
   second harmonic ('body'), and a little of the third to fifth
   ('bright') that the music opens up as it lifts — so the brightness can
   rise and fall without a filter sweeping. The overtones fall away
   steeply (about 1/k^2.5): the pad's weight sits between 150 and 600 Hz,
   warm, below the voice rather than in front of it. Slow, slightly
   different drifts on every voice keep it breathing. */
function padRegion(region, buses, n, rand) {
  const notes = CHORDS[region.name].slice(1);
  const attack = 1.6;
  const release = 2.6;
  const start = Math.max(0, Math.floor((region.from - 0.15) * SR));
  const stop = Math.min(n, Math.ceil((region.to + release) * SR));
  const voices = [];
  notes.forEach((m, j) => {
    const height = (m - 54) / 18;
    const level = 0.11 * (1 - 0.25 * clamp(height, -1, 1)) / Math.sqrt(notes.length);
    for (const [cents, pan] of [[-5, -0.55], [0, 0], [6, 0.55]]) {
      voices.push({
        hz: midiHz(m) * Math.pow(2, cents / 1200),
        pan: clamp(pan + (j - notes.length / 2) * 0.06, -0.8, 0.8),
        level: level * (cents === 0 ? 1 : 0.8),
        drift: 0.05 + rand() * 0.06,
        driftPhase: rand(),
        swell: 0.04 + rand() * 0.05,
        swellPhase: rand(),
        phase: rand()
      });
    }
  });
  const harmonics = [1, 0.2, 0.065, 0.032, 0.018];
  for (const v of voices) {
    const gl = Math.cos((v.pan + 1) * Math.PI / 4);
    const gr = Math.sin((v.pan + 1) * Math.PI / 4);
    let phase = v.phase;
    for (let i = start; i < stop; i += 1) {
      const t = i / SR;
      const env = smoothstep(t, region.from - 0.15, region.from - 0.15 + attack) * (1 - smoothstep(t, region.to, region.to + release));
      if (env <= 0) { phase += v.hz / SR; continue; }
      const wobble = 1 + 0.0012 * sine(v.driftPhase + t * v.drift);
      phase += (v.hz * wobble) / SR;
      const amp = v.level * env * (1 + 0.12 * sine(v.swellPhase + t * v.swell));
      let body = 0;
      for (let h = 0; h < 2; h += 1) body += harmonics[h] * sine(phase * (h + 1));
      let bright = 0;
      for (let h = 2; h < 5; h += 1) bright += harmonics[h] * sine(phase * (h + 1) + h * 0.13);
      buses.bodyL[i] += amp * body * gl; buses.bodyR[i] += amp * body * gr;
      buses.brightL[i] += amp * bright * 1.5 * gl; buses.brightR[i] += amp * bright * 1.5 * gr;
    }
  }
  /* the sub: the chord's root, two octaves down, barely there — felt on
     headphones, absent on a phone, never missed */
  const root = midiHz(CHORDS[region.name][0]);
  let ph = 0;
  for (let i = start; i < stop; i += 1) {
    const t = i / SR;
    const env = smoothstep(t, region.from, region.from + attack * 1.4) * (1 - smoothstep(t, region.to, region.to + release * 0.8));
    ph += root / SR;
    const v = 0.035 * env * sine(ph);
    buses.bodyL[i] += v; buses.bodyR[i] += v;
  }
}

/* A soft struck note: felt on glass — a sine with a little second and
   third harmonic and the faintest bell partial, each dying away at its
   own rate. Quiet; it is punctuation, not a tune. */
function note(nt, buses, n) {
  const hz = midiHz(nt.midi);
  const parts = [[1, 1, 2.6], [2, 0.22, 1.2], [3, 0.07, 0.6], [4.07, 0.025, 0.35]];
  const start = Math.floor(nt.at * SR);
  const len = Math.min(n - start, Math.round(3.5 * SR));
  const gl = Math.cos((nt.pan + 1) * Math.PI / 4);
  const gr = Math.sin((nt.pan + 1) * Math.PI / 4);
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    const attack = smoothstep(t, 0, 0.012);
    let v = 0;
    for (const [ratio, amp, decay] of parts) v += amp * Math.exp(-t / decay) * sine(hz * ratio * t);
    v *= 0.05 * nt.vel * attack;
    buses.notesL[start + i] += v * gl;
    buses.notesR[start + i] += v * gr;
  }
}

/* Air: decorrelated noise, kept between about 2.5 and 9 kHz and very
   low, rising while a search is running. */
function air(p, buses, n, rand) {
  const lp = (hz) => Math.exp(-2 * Math.PI * hz / SR);
  const filt = () => ({ h: 0, l1: 0, l2: 0 });
  const fl = filt(); const fr = filt();
  const hp = lp(2500); const lo = lp(9000);
  const amount = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    let a = 0.25;
    for (const [s, e] of p.searching) a = Math.max(a, smoothstep(t, s - 0.2, s + 0.5) * (1 - smoothstep(t, e, e + 1.4)));
    amount[i] = a;
  }
  const run = (f, x) => {
    f.h = hp * f.h + (1 - hp) * x;
    const high = x - f.h;
    f.l1 = lo * f.l1 + (1 - lo) * high;
    f.l2 = lo * f.l2 + (1 - lo) * f.l1;
    return f.l2;
  };
  for (let i = 0; i < n; i += 1) {
    const l = run(fl, rand() * 2 - 1);
    const r = run(fr, rand() * 2 - 1);
    buses.airL[i] += 0.012 * amount[i] * l;
    buses.airR[i] += 0.012 * amount[i] * r;
  }
}

/* ---------------------------------------------------------
   Sound design, for the film: almost not there
   --------------------------------------------------------- */

/* A soft key: a few milliseconds of filtered noise and the faintest
   thump, each a little different. Placed on the frames where the typed
   text actually grows. */
function keyTick(out, at, amp, rand, pan) {
  const start = Math.round(at * SR);
  const len = Math.round(0.03 * SR);
  let hp = 0; let lp = 0; let lp2 = 0;
  const a = Math.exp(-2 * Math.PI * 1200 / SR);
  const b = Math.exp(-2 * Math.PI * (3200 + rand() * 1200) / SR);
  const body = 150 + rand() * 60;
  const gl = Math.cos((pan + 1) * Math.PI / 4); const gr = Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < len && start + i < out[0].length; i += 1) {
    const t = i / SR;
    const n = rand() * 2 - 1;
    hp = a * hp + (1 - a) * n;
    lp = b * lp + (1 - b) * (n - hp);
    lp2 = b * lp2 + (1 - b) * lp;
    const v = amp * (lp2 * 2.6 * Math.exp(-t / 0.0045) + 0.35 * Math.sin(2 * Math.PI * body * t) * Math.exp(-t / 0.009));
    out[0][start + i] += v * gl; out[1][start + i] += v * gr;
  }
}

/* Search pressed: a small, rounded tock */
function tock(out, at, amp) {
  const start = Math.round(at * SR);
  const len = Math.round(0.09 * SR);
  for (let i = 0; i < len && start + i < out[0].length; i += 1) {
    const t = i / SR;
    const f = 760 * (1 - 0.12 * Math.min(1, t / 0.03));
    const v = amp * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.018) * Math.min(1, t / 0.0015);
    out[0][start + i] += v; out[1][start + i] += v;
  }
}

/* A moment moving: a breath of air under a transition, rising and falling */
function airSwell(out, from, dur, amp, rand) {
  const start = Math.round(from * SR);
  const len = Math.round(dur * SR);
  const hp = Math.exp(-2 * Math.PI * 1800 / SR); const lo = Math.exp(-2 * Math.PI * 6500 / SR);
  const st = [{ h: 0, l: 0, l2: 0 }, { h: 0, l: 0, l2: 0 }];
  for (let i = 0; i < len && start + i < out[0].length; i += 1) {
    const e = Math.sin(Math.PI * i / len) ** 2;
    for (let c = 0; c < 2; c += 1) {
      const n = rand() * 2 - 1;
      const f = st[c];
      f.h = hp * f.h + (1 - hp) * n;
      f.l = lo * f.l + (1 - lo) * (n - f.h);
      f.l2 = lo * f.l2 + (1 - lo) * f.l;
      out[c][start + i] += amp * e * f.l2 * 3;
    }
  }
}

function sfx(tl, n, rand) {
  const out = [new Float32Array(n), new Float32Array(n)];
  for (const s of tl.searches) {
    /* the keys: there, but only just */
    for (const k of s.keys || []) keyTick(out, k, 0.075 * (0.7 + rand() * 0.45), rand, (rand() - 0.5) * 0.3);
    /* Search pressed: a small, rounded tock */
    tock(out, s.searched, 0.08);
    /* the choice: a click — down, and a softer up */
    keyTick(out, s.select, 0.17, rand, 0.05);
    keyTick(out, s.select + 0.085, 0.09, rand, 0.05);
    /* the store's page opening: a breath of air as the frame opens */
    airSwell(out, s.retailer[0] - 0.05, 0.95, 0.012, rand);
  }
  return out;
}

/* ---------------------------------------------------------
   The voice
   --------------------------------------------------------- */

function placeVoice(timeline, manifest, n) {
  const voice = new Float32Array(n);
  const spans = [];
  for (const line of timeline.lines) {
    const meta = manifest.lines[line.key];
    if (!meta) throw new Error(`The narration has no line "${line.key}".`);
    const clip = readWav(path.join(NARRATION, meta.file));
    const at = line.key === 'close' ? closeAt(timeline) : line.at;
    const start = Math.round(at * SR);
    for (let i = 0; i < clip.length && start + i < n; i += 1) voice[start + i] += clip[i];
    /* a line with a breath before it is said from its onset; a line
       recorded in parts knows where each part is */
    const said = at + (meta.onset || 0);
    const parts = meta.parts && meta.parts.length > 1
      ? meta.parts.map((p) => ({ text: p.text, at: at + p.at, end: at + p.end }))
      : sentencesOf(meta.text, clip, at);
    spans.push({ key: line.key, text: meta.text, at: said, end: at + clip.length / SR, parts });
  }
  return { voice, spans };
}

/* Where, in a clip, each pause between sentences ends: the voice going
   quiet for 0.3 s or more, after its first 0.6 s. */
function pausesIn(clip) {
  const win = Math.round(0.02 * SR);
  const ends = [];
  let quietFrom = -1;
  for (let i = Math.round(0.6 * SR); i + win < clip.length; i += win) {
    let e = 0;
    for (let j = i; j < i + win; j += 1) e += clip[j] * clip[j];
    const quiet = Math.sqrt(e / win) < 0.004;
    if (quiet && quietFrom < 0) quietFrom = i;
    if (!quiet && quietFrom >= 0) {
      if ((i - quietFrom) / SR >= 0.3) ends.push({ from: quietFrom / SR, to: i / SR });
      quietFrom = -1;
    }
  }
  return ends;
}

/* a line of more than one sentence, timed sentence by sentence when its
   pauses can be heard; otherwise as one */
function sentencesOf(text, clip, at) {
  const sentences = text.match(/[^.?!]+[.?!]+/g) || [text];
  const pauses = pausesIn(clip);
  if (sentences.length < 2 || pauses.length !== sentences.length - 1) return null;
  return sentences.map((sentence, i) => ({
    text: sentence.trim(),
    at: at + (i ? pauses[i - 1].to - 0.05 : 0),
    end: at + (i < pauses.length ? pauses[i].from : clip.length / SR)
  }));
}

/* How far the music sits down at every moment: falling over 0.35 s
   starting just before a line, staying down through it — and through
   any gap too short to come back in — and rising over a second after.
   Drawn from the lines' positions, so there is no detector to pump. */
function duckCurve(spans, n) {
  const merged = [];
  for (const s of [...spans].sort((a, b) => a.at - b.at)) {
    const last = merged[merged.length - 1];
    if (last && s.at - last.end < 1.2) last.end = Math.max(last.end, s.end);
    else merged.push({ at: s.at, end: s.end });
  }
  const down = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    let d = 0;
    for (const m of merged) {
      d = Math.max(d, smoothstep(t, m.at - 0.4, m.at - 0.05) * (1 - smoothstep(t, m.end + 0.15, m.end + 1.15)));
    }
    down[i] = d;
  }
  return down;
}

/* ---------------------------------------------------------
   The mix
   --------------------------------------------------------- */

function render(timeline, manifest) {
  const n = Math.round(timeline.duration * SR);
  const rand = seeded(20261003);
  const p = plan(timeline);
  const buf = () => new Float32Array(n);
  const buses = {
    bodyL: buf(), bodyR: buf(), brightL: buf(), brightR: buf(),
    notesL: buf(), notesR: buf(), airL: buf(), airR: buf()
  };
  const scored = Boolean(timeline.film && timeline.marks);
  if (!scored) {
    for (const region of p.chords) padRegion(region, buses, n, rand);
    for (const nt of p.notes) note(nt, buses, n);
    air(p, buses, n, rand);
  }

  const intensity = curve(p.points, n);
  const { voice, spans } = placeVoice(timeline, manifest, n);
  const duck = duckCurve(spans, n);
  /* the film: its own score, written to its marks (scripts/demo-score.js) */
  const film = scored ? require('./demo-score').scoreFilm(timeline, duck, { reverb }) : null;

  /* the music's shape over the whole video: in softly from silence over
     the first 1.8 s, out to silence over the last 2.4 s */
  const shape = (i) => {
    const t = i / SR;
    return smoothstep(t, 0, 1.8) * (1 - smoothstep(t, p.end - 2.4, p.end - 0.02));
  };

  const musicL = buf(); const musicR = buf();
  const sendL = buf(); const sendR = buf();
  const g = {
    body: dbToGain(DUCK_DB.body), bright: dbToGain(DUCK_DB.bright),
    notes: dbToGain(DUCK_DB.notes), air: dbToGain(DUCK_DB.air)
  };
  for (let i = 0; i < n; i += 1) {
    const d = duck[i];
    const s = shape(i);
    const lift = intensity[i];
    const body = (0.78 + 0.32 * lift) * (1 + d * (g.body - 1));
    const bright = (0.2 + 0.95 * lift) * (1 + d * (g.bright - 1));
    const notes = 1 + d * (g.notes - 1);
    const airy = 1 + d * (g.air - 1);
    const l = buses.bodyL[i] * body + buses.brightL[i] * bright + buses.notesL[i] * notes + buses.airL[i] * airy;
    const r = buses.bodyR[i] * body + buses.brightR[i] * bright + buses.notesR[i] * notes + buses.airR[i] * airy;
    musicL[i] = l * s; musicR[i] = r * s;
    /* the notes go to the reverb hardest; the pads a little; the air barely */
    sendL[i] = (buses.bodyL[i] * body * 0.55 + buses.brightL[i] * bright * 0.6 + buses.notesL[i] * notes * 1.6 + buses.airL[i] * airy * 0.3) * s;
    sendR[i] = (buses.bodyR[i] * body * 0.55 + buses.brightR[i] * bright * 0.6 + buses.notesR[i] * notes * 1.6 + buses.airR[i] * airy * 0.3) * s;
  }
  if (film) {
    musicL.set(film.L);
    musicR.set(film.R);
  } else {
    const [wetL, wetR] = reverb(sendL, sendR, { room: 0.88, damp: 0.5, predelay: 0.028 });
    for (let i = 0; i < n; i += 1) {
      /* the reverb tail is shaped with everything else, so the end is silence */
      const s = 1 - smoothstep(i / SR, p.end - 1.2, p.end - 0.02);
      musicL[i] += wetL[i] * 0.9 * s;
      musicR[i] += wetR[i] * 0.9 * s;
    }
  }

  /* room for the words: the music, and only the music, a little lower
     where speech is understood (-3.5 dB around 2.5 kHz, broad), and
     softened above 7 kHz so its air never hisses */
  for (const ch of [musicL, musicR]) {
    ch.set(peaking(ch, 2500, 0.7, -3.5));
    ch.set(highShelf(ch, 7000, -4));
  }

  /* the voice: centred, dry but for the faintest small room, so it sits
     in a space rather than in a box */
  const [roomL, roomR] = reverb(voice, voice, { room: 0.35, damp: 0.6, predelay: 0.008 });
  const voiceL = buf(); const voiceR = buf();
  for (let i = 0; i < n; i += 1) {
    voiceL[i] = voice[i] + roomL[i] * 0.12;
    voiceR[i] = voice[i] + roomR[i] * 0.12;
  }

  /* levels: the music set by ear-equivalent loudness against the voice,
     measured the way the finished mix is */
  const voiceLufs = integratedLoudness([voiceL, voiceR]);
  const undocked = integratedLoudness([musicL, musicR]);
  const musicGain = dbToGain((voiceLufs - MUSIC_BELOW_VOICE_LU) - undocked);
  const outL = buf(); const outR = buf();
  for (let i = 0; i < n; i += 1) {
    outL[i] = voiceL[i] + musicL[i] * musicGain;
    outR[i] = voiceR[i] + musicR[i] * musicGain;
  }
  /* the film's sound design, a few dB lower again under the voice */
  const fx = timeline.film ? sfx(timeline, n, seeded(4242)) : [buf(), buf()];
  if (timeline.film) {
    const under = dbToGain(-4);
    for (let i = 0; i < n; i += 1) {
      const g = 1 + duck[i] * (under - 1);
      fx[0][i] *= g; fx[1][i] *= g;
      outL[i] += fx[0][i];
      outR[i] += fx[1][i];
    }
  }

  /* the master: the voice to -16 LUFS, then a true-peak ceiling */
  const gain = dbToGain(TARGET_LUFS - voiceLufs);
  for (let i = 0; i < n; i += 1) { outL[i] *= gain; outR[i] *= gain; }
  const reduction = limit(outL, outR, dbToGain(CEILING_DBTP - 0.3));

  return {
    left: outL, right: outR, spans,
    stems: {
      voice: [voiceL.map((v) => v * gain), voiceR.map((v) => v * gain)],
      music: [musicL.map((v) => v * musicGain * gain), musicR.map((v) => v * musicGain * gain)],
      sfx: [fx[0].map((v) => v * gain), fx[1].map((v) => v * gain)]
    },
    cues: film ? film.cues : [],
    report: {
      voiceLufs: round(voiceLufs + 20 * Math.log10(gain)),
      musicBelowVoiceLU: MUSIC_BELOW_VOICE_LU,
      limiterMaxReductionDb: round(reduction),
      lufs: round(integratedLoudness([outL, outR])),
      truePeakDbtp: round(truePeak([outL, outR]))
    }
  };
}

const round = (x) => Math.round(x * 100) / 100;

/* A look-ahead peak limiter on both channels together: 4 ms look-ahead,
   gain falls only as far as a peak needs and comes back over 120 ms.
   With this mix it rarely does anything; it is there so nothing can
   clip. Returns the most it reduced, in dB. */
function limit(L, R, ceiling) {
  const n = L.length;
  const ahead = Math.round(0.004 * SR);
  const need = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    need[i] = peak > ceiling ? ceiling / peak : 1;
  }
  /* the lowest gain needed anywhere in the next 4 ms */
  const target = new Float32Array(n);
  const window = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    window.push(need[i]);
    if (window.length > ahead) window.shift();
    target[i] = Math.min(...window);
  }
  const rel = Math.exp(-1 / (0.12 * SR));
  let gain = 1;
  let most = 0;
  for (let i = 0; i < n; i += 1) {
    gain = target[i] < gain ? target[i] : rel * gain + (1 - rel) * Math.min(1, target[i]);
    L[i] *= gain; R[i] *= gain;
    if (gain < 1) most = Math.min(most, 20 * Math.log10(gain));
  }
  return most;
}

/* ---------------------------------------------------------
   Captions, from where each line is actually spoken
   --------------------------------------------------------- */

function captions(spans, length) {
  const clock = (s) => {
    const total = Math.round(clamp(s, 0, length) * 1000);
    const mm = String(Math.floor(total / 60000)).padStart(2, '0');
    const ss = String(Math.floor(total / 1000) % 60).padStart(2, '0');
    const ms = String(total % 1000).padStart(3, '0');
    return `00:${mm}:${ss}.${ms}`;
  };
  const sorted = [...spans].flatMap((s) => s.parts || [s]).sort((a, b) => a.at - b.at);
  const cues = sorted.map((s, i) => {
    const next = sorted[i + 1];
    const end = Math.min(s.end + 0.3, next ? next.at - 0.05 : length);
    return `${i + 1}\n${clock(s.at)} --> ${clock(end)} line:8%\n${s.text}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/* ---------------------------------------------------------
   For the recorder, and on its own
   --------------------------------------------------------- */

function manifestOf() {
  return JSON.parse(fs.readFileSync(path.join(NARRATION, 'manifest.json'), 'utf8'));
}

/* the mix for one timeline, written to `file`; returns what it measured */
function renderTo(timeline, file, { stemsDir = null } = {}) {
  const mix = render(timeline, manifestOf());
  writeWav(file, mix.left, mix.right);
  if (stemsDir) {
    fs.mkdirSync(stemsDir, { recursive: true });
    writeWav(path.join(stemsDir, `${timeline.video}-voice.wav`), ...mix.stems.voice);
    writeWav(path.join(stemsDir, `${timeline.video}-music.wav`), ...mix.stems.music);
    writeWav(path.join(stemsDir, `${timeline.video}-sfx.wav`), ...mix.stems.sfx);
  }
  return { ...mix.report, cues: mix.cues, captions: captions(mix.spans, timeline.duration) };
}

/* the encodes for the web: AAC stereo 160 kb/s in the MP4, Opus stereo
   128 kb/s in the WebM — the video streams copied, not re-encoded */
function remux({ ffmpeg = 'ffmpeg', video, audio, mp4, webm }) {
  const run = (args) => execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  run(['-i', video.mp4, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', mp4]);
  run(['-i', video.webm, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', webm]);
}

function main() {
  const arg = (name) => {
    const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return null;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  if (!arg('remix')) {
    console.log('Usage: node scripts/demo-audio.js --remix [--only=desktop|mobile] [--stems=DIR] [--out=DIR]');
    process.exit(1);
  }
  const only = arg('only');
  const out = path.resolve(arg('out') || DEMO);
  const stems = typeof arg('stems') === 'string' ? path.resolve(arg('stems')) : null;
  const shapes = [['desktop', 'fynd-demo'], ['mobile', 'fynd-demo-mobile']].filter(([k]) => !only || k === only);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fynd-demo-audio-'));
  for (const [, name] of shapes) {
    const timeline = JSON.parse(fs.readFileSync(path.join(DEMO, `${name}.timeline.json`), 'utf8'));
    console.log(`${name}: composing and mixing ${timeline.duration.toFixed(1)}s…`);
    const wav = path.join(stage, `${name}.wav`);
    const result = renderTo(timeline, wav, { stemsDir: stems });
    /* from the committed encodes, video copied as it is */
    const src = { mp4: path.join(stage, `${name}.src.mp4`), webm: path.join(stage, `${name}.src.webm`) };
    fs.copyFileSync(path.join(DEMO, `${name}.mp4`), src.mp4);
    fs.copyFileSync(path.join(DEMO, `${name}.webm`), src.webm);
    remux({ video: src, audio: wav, mp4: path.join(stage, `${name}.mp4`), webm: path.join(stage, `${name}.webm`) });
    fs.writeFileSync(path.join(stage, `${name}.vtt`), result.captions);
    console.log(`  mix: ${result.lufs} LUFS integrated, true peak ${result.truePeakDbtp} dBTP, voice ${result.voiceLufs} LUFS, limiter ${result.limiterMaxReductionDb} dB at most`);
  }
  for (const [, name] of shapes) {
    for (const ext of ['mp4', 'webm', 'vtt']) fs.copyFileSync(path.join(stage, `${name}.${ext}`), path.join(out, `${name}.${ext}`));
  }
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`Wrote to ${path.relative(REPO, out) || '.'}`);
}

if (require.main === module) main();

module.exports = {
  reverb, SR, TARGET_LUFS, CEILING_DBTP, CLOSE_LEAD_S, MUSIC_BELOW_VOICE_LU, DUCK_DB,
  render, renderTo, remux, captions, plan, duckCurve, pausesIn, sentencesOf, integratedLoudness, truePeak, limit, readWav, writeWav, closeAt, kWeight
};
