/* =========================================================
   Fynd — the film's score

   Music written to one film and no other: every chord change, every
   note, every swell and every silence is placed on a moment the picture
   makes, by name (the marks scripts/demo-film.js writes into the film's
   timeline). Nothing moves because a bar line came round; it moves
   because the screen did.

   The sound: warm and quiet, a little futuristic.

     pad      an analog-style pad: three detuned saws per note through a
              soft low-pass that opens as the film lifts and closes when
              it settles — the "brightness" is the score's main gesture
     glass    soft FM tones, glassy rather than bell-like, into a
              ping-pong echo and a long, dark space: the accents
     sub      a sine under the bigger moments, felt more than heard
     air      high, slow, filtered noise, under the reveals
     pulse    soft plucks, for the jacket search only: the one moment
              the film gets a little playful

   No drums, no beat, no melody to follow, no loop, no vocals.

   Its shape follows the film:

     before the question       nothing, then the faintest pad
     the question              low, closed, waiting
     Fynd appears              the chord opens (a Lydian colour) and
                               three glass notes as the field opens
     the first request         a cooler chord on the first key; a soft
                               low note as each word is typed, and the
                               same figure an octave up as the words
                               lift out as type
     Search                    a soft low pulse on the press, then
                               near-silence while it searches
     results                   the harmony lifts with the cards, a note
                               on each card as it lands
     the choice                one small high note, on the press
     the store                 the chord turns as the page opens
     the jacket                brighter, a soft pluck pulse while it
                               is typed, stopping on Search
     BAPE                      almost silent and dark under "actually
                               hard to find"; a deep swell as the dark
                               stage opens; the score's one high point
                               as the listings rise out of it
     the dress                 calm and open, notes on its words
     the close                 down to one quiet chord under "Describe
                               what you want."; after "Fynd finds it."
                               it comes home — the last note on the
                               mark — and is silent by the last frame

   Every musical event is returned as a cue naming the mark it belongs
   to, so the sync can be checked rather than trusted
   (scripts/test-demo-audio.js).
   ========================================================= */

'use strict';

const SR = 48000;
const TAU = Math.PI * 2;
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function smooth(t, a, b) {
  if (t <= a) return 0;
  if (t >= b) return 1;
  return 0.5 - 0.5 * Math.cos(Math.PI * (t - a) / (b - a));
}
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

/* Voicings, low to high. The first note goes to the sub as well. */
const V = {
  Dmaj9:     [38, 50, 57, 61, 64, 66],      /* D  A C# E F#: home */
  Dhome:     [38, 50, 57, 62, 64, 66, 69],  /* D(add9), open: the last chord */
  Dopen:     [38, 50, 57, 64, 66],          /* D, no third: the beginning */
  Glyd:      [43, 50, 54, 57, 61],          /* Gmaj9(#11): Fynd appears */
  G9:        [43, 50, 54, 57, 59, 62],      /* Gmaj9: the store */
  Bm11:      [35, 50, 54, 57, 61, 64],      /* Bm11: a request being typed */
  Asus:      [45, 52, 57, 59, 62, 64],      /* Asus(add9): the jacket */
  Aadd9:     [45, 52, 57, 59, 61, 64],      /* A(add9): its results */
  DF:        [42, 50, 54, 57, 61, 64],      /* D/F#: its store */
  Bdark:     [35, 47, 54, 57, 61],          /* Bm(add9), low: BAPE, waiting */
  Gbig:      [31, 43, 50, 54, 57, 61, 66],  /* Gmaj9(#11), wide: BAPE found */
  Aopen:     [33, 45, 52, 57, 59, 64],      /* A(add9): BAPE's store */
  Gsoft:     [43, 50, 54, 59, 62],          /* Gmaj7: the dress */
  Dmaj9b:    [38, 50, 54, 57, 61, 64, 69],  /* Dmaj9: the dress found */
  Em9:       [40, 50, 55, 59, 62, 66],      /* Em9: its store */
  Dclose:    [38, 50, 57, 62, 64]           /* D(add9), quiet: the last line */
};

/* ---------------------------------------------------------
   The plan: what happens when, every event on a mark
   --------------------------------------------------------- */

function planScore(tl) {
  const m = tl.marks;
  const S = m.searches;
  const end = tl.duration;
  const cues = [];
  const chords = [];
  const glass = [];
  const subs = [];
  const swells = [];
  const pulses = [];
  /* brightness of the pad (0 closed .. 1 open) and the score's level,
     as points in time; moved between smoothly */
  const bright = [];
  const level = [];
  const cue = (at, what, anchor, anchorAt) => cues.push({ at: Number(at.toFixed(3)), what, anchor, anchorAt: Number(anchorAt.toFixed(3)) });
  const chord = (name, from, anchor, attack = 0.6) => {
    if (chords.length) chords[chords.length - 1].to = from;
    chords.push({ name, from, to: end, attack });
    cue(from, `chord ${name}`, anchor, from);
  };
  const note = (midi, at, vel, anchor, anchorAt, pan = 0, opts = {}) => {
    glass.push({ midi, at, vel, pan, ...opts });
    cue(at, `glass ${midi}`, anchor, anchorAt);
  };

  /* the beginning: silence, then a closed, low chord */
  const open = 0.22;
  chords.push({ name: 'Dopen', from: open, to: end, attack: 2.2 });
  cue(open, 'chord Dopen, from silence', 'film start', 0);
  bright.push([0, 0.05], [m.hook, 0.12]);
  level.push([0, 0], [open, 0.0], [m.hook, 0.36], [m.reveal - 0.3, 0.42]);

  /* Fynd appears: the field opens and the chord with it */
  chord('Glyd', m.reveal, 'search field opens', 0.35);
  note(81, m.reveal, 0.36, 'search field opens', m.reveal, -0.3);
  note(85, m.page, 0.3, 'the homepage appears around it', m.page, 0.25);
  subs.push({ midi: 43, at: m.reveal, len: 2.2, vel: 0.35 });
  cue(m.reveal, 'sub swell', 'search field opens', m.reveal);
  swells.push({ to: m.reveal, len: 0.7, amp: 0.5 });
  cue(m.reveal, 'air swell peaks', 'search field opens', m.reveal);
  bright.push([m.reveal - 0.05, 0.14], [m.reveal + 0.5, 0.55], [m.page + 0.8, 0.4]);
  level.push([m.reveal, 0.62], [m.page + 1, 0.55]);

  S.forEach((s, k) => {
    const bape = k === 2;
    /* the request being typed */
    if (k === 0) {
      chord('Bm11', s.firstKey, 'first request: the first key', 0.6);
      bright.push([s.firstKey, 0.32], [s.lastKey, 0.42]);
      level.push([s.firstKey, 0.5]);
      /* each word of the request, as it is completed in the box: a soft
         note, low in the pad — the figure the lifted words restate an
         octave up */
      [66, 69, 71, 74, 76].forEach((n, i) => {
        if (s.typedWords[i] !== undefined) note(n, s.typedWords[i] + 0.02, 0.13, `first request: word ${i + 1} typed`, s.typedWords[i], [-0.2, 0.15, -0.1, 0.2, 0][i], { soft: true });
      });
    } else if (k === 1) {
      chord('Asus', s.start, 'the jacket: typing starts', 0.25);
      bright.push([s.start, 0.5], [s.submit, 0.55]);
      level.push([s.start - 0.02, 0.56]);
      /* the playful pulse, while the jacket is typed, stopping on Search */
      const step = 0.27;
      const notes = [76, 81, 83, 86, 81, 88, 83, 81];
      let i = 0;
      for (let at = s.start + 0.12; at < s.submit - 0.05; at += step, i += 1) pulses.push({ midi: notes[i % notes.length], at, vel: 0.5 + 0.04 * Math.sin(i * 1.7) });
      cue(s.start + 0.12, 'pluck pulse begins', 'the jacket: typing starts', s.start);
      cue(s.submit - 0.05, 'pluck pulse stops', 'the jacket: Search', s.submit);
    } else if (bape) {
      /* almost nothing: dark, low, waiting */
      chord('Bdark', s.start, 'BAPE: typing starts', 0.3);
      bright.push([s.start, 0.08], [s.submit - 0.1, 0.1]);
      level.push([s.start - 0.05, 0.18], [s.submit - 0.08, 0.2]);
    } else {
      chord('Gsoft', s.start, 'the dress: typing starts', 0.3);
      bright.push([s.start, 0.35]);
      level.push([s.start, 0.46]);
    }
    /* the request's words lifting out as type: one glass note each */
    const wordNotes = k === 0 ? [78, 81, 83, 86] : [83, 86, 88, 90];
    s.words.forEach((at, i) => note(wordNotes[i], at, k === 0 ? 0.24 : 0.2, `${k === 0 ? 'hoodie' : 'dress'} word "${i + 1}" lifts out`, at, [-0.35, 0.3, -0.15, 0.2][i]));

    /* Search: a soft low pulse on the press, then near-silence */
    subs.push({ midi: bape ? 35 : 38, at: s.submit, len: bape ? 1.8 : 0.5, vel: bape ? 0.6 : 0.45, thump: !bape });
    cue(s.submit, bape ? 'deep swell: the dark stage opens' : 'low pulse on Search', `search ${k + 1}: Search pressed`, s.submit);
    if (!bape && s.results - s.submit >= 0.45) {
      level.push([s.submit, 0.5], [s.submit + 0.18, 0.2], [s.results - 0.08, 0.2]);
      cue(s.submit + 0.18, 'near-silence while it searches', `search ${k + 1}: Search pressed`, s.submit);
    } else if (!bape) {
      /* the grid re-forms almost at once: no time to fall silent, only
         to draw breath */
      level.push([s.submit, 0.5], [s.results, 0.42]);
    } else {
      level.push([s.submit, 0.26], [s.submit + 0.5, 0.4], [s.stage.out, 0.38], [s.results - 0.1, 0.24]);
      bright.push([s.submit + 0.4, 0.18], [s.results - 0.1, 0.16]);
      /* the title: one high note as its last letter lands */
      note(90, s.stage.letters[s.stage.letters.length - 1] + 0.12, 0.2, 'BAPE title complete', s.stage.letters[s.stage.letters.length - 1] + 0.12, 0.2);
      /* and silence for the beat between the title leaving and the listings */
      cue(s.stage.out, 'drops back as the title leaves', 'BAPE title leaves', s.stage.out);
    }

    /* results: the lift, starting with the cards */
    const lift = ['Dmaj9', 'Aadd9', 'Gbig', 'Dmaj9b'][k];
    chord(lift, s.results, `search ${k + 1}: results appear`, bape ? 0.35 : 0.45);
    bright.push([s.results, bape ? 0.3 : 0.25], [s.results + 0.7, bape ? 1 : [0.85, 0.75, 1, 0.7][k]], [s.select, bape ? 0.85 : 0.65]);
    level.push([s.results, bape ? 0.5 : 0.4], [s.results + (bape ? 0.45 : 0.6), bape ? 1 : [0.82, 0.74, 1, 0.72][k]], [s.select - 0.3, bape ? 0.8 : 0.66]);
    /* BAPE: the bloom crests with the listings, then makes room for the
       voice's reaction to them */
    if (bape) level.push([s.results + 0.85, 0.66]);
    swells.push({ to: s.results + 0.25, len: 0.6, amp: bape ? 0.8 : 0.45 });
    cue(s.results + 0.25, 'air swell peaks', `search ${k + 1}: results appear`, s.results);
    /* the root, between 55 and 110 Hz — low enough to be felt, high
       enough for a laptop to carry */
    const root = V[lift][0] + (V[lift][0] < 33 ? 12 : 0);
    subs.push({ midi: root, at: s.results, len: bape ? 1.6 : 2.0, vel: bape ? 0.45 : 0.35 });
    cue(s.results, 'sub under the lift', `search ${k + 1}: results appear`, s.results);
    /* a note on each card as it lands — the first results and BAPE;
       the jacket and the dress lift on the chord alone */
    if (k === 0 || bape) {
      const cardNotes = bape ? [79, 83, 86, 90] : [81, 85, 88, 90];
      s.cards.slice(0, 4).forEach((at, i) => note(cardNotes[i], at + 0.04, (bape ? 0.4 : 0.32) - i * 0.03, `search ${k + 1}: card ${i + 1} lands`, at, [-0.4, 0.35, -0.15, 0.25][i]));
    }

    /* the choice: one small high note, on the press */
    note([93, 93, 95, 93][k], s.select + 0.01, 0.3, `search ${k + 1}: product chosen`, s.select, 0.15, { short: true });

    /* the store: the chord turns as its page opens */
    const store = ['G9', 'DF', 'Aopen', 'Em9'][k];
    chord(store, s.handoff, `search ${k + 1}: the store's page opens`, 0.5);
    swells.push({ to: s.storeOpen, len: s.storeOpen - s.handoff, amp: bape ? 0.55 : 0.4 });
    cue(s.storeOpen, 'air swell crests as the page finishes opening', `search ${k + 1}: the store's page is open`, s.storeOpen);
    note([74, 76, 74, 76][k], s.handoff + 0.02, 0.26, `search ${k + 1}: the store's page opens`, s.handoff, -0.2);
    bright.push([s.handoff, 0.62], [s.storeOpen, bape ? 0.7 : 0.55], [s.storeEnd - 0.4, 0.45]);
    level.push([s.handoff, bape ? 0.8 : 0.66], [s.storeEnd - 0.5, bape ? 0.62 : 0.55]);
    /* between searches: let it breathe out with the store */
    level.push([s.storeEnd - 0.12, k === 1 ? 0.32 : 0.42]);
  });

  /* the close: one quiet chord under the last line */
  const c = m.close;
  chord('Dclose', c.start, 'the close begins', 0.5);
  level.push([c.start - 0.06, 0.22], [c.start + 0.15, 0.2], [c.line1, 0.3]);
  bright.push([c.start, 0.18]);
  cue(c.start, 'music simplifies under the last line', 'the close begins', c.start);
  /* when the last word is said, it comes home */
  const said = tl.lines.find((l) => l.key === 'finale').ends;
  chord('Dhome', said + 0.06, 'the last word is said', 0.5);
  bright.push([said, 0.2], [said + 0.6, 0.42], [c.mark + 0.4, 0.3]);
  level.push([said, 0.32], [said + 0.4, 0.55], [c.mark + 0.3, 0.5], [c.white, 0.3], [end - 0.05, 0]);
  [[81, said + 0.08, 'the last word is said', said], [78, c.gather + 0.1, 'the products gather to the mark', c.gather], [74, c.mark, 'the mark appears', c.mark]]
    .forEach(([n, at, anchor, aAt], i) => note(n, at, [0.32, 0.28, 0.36][i], anchor, aAt, [0.25, -0.2, 0][i]));
  subs.push({ midi: 38, at: said + 0.06, len: end - said - 0.2, vel: 0.3 });
  cue(said + 0.06, 'sub: home', 'the last word is said', said);
  cue(Math.floor(end * 1000) / 1000, 'silence', 'last frame', Math.floor(end * 1000) / 1000);

  bright.sort((a, b) => a[0] - b[0]);
  level.sort((a, b) => a[0] - b[0]);
  cues.sort((a, b) => a.at - b.at);
  return { end, chords, glass, subs, swells, pulses, bright, level, cues };
}

/* a value moving between points, eased: each move takes the time
   between its two points, along a cosine, so nothing jumps */
function automation(points, n, floor = 0) {
  const out = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    while (k < points.length - 2 && points[k + 1][0] <= t) k += 1;
    const [t0, v0] = points[k];
    const [t1, v1] = points[Math.min(k + 1, points.length - 1)];
    const p = t <= t0 ? 0 : t >= t1 ? 1 : smooth(t, t0, t1);
    out[i] = Math.max(floor, v0 + (v1 - v0) * p);
  }
  return out;
}

/* ---------------------------------------------------------
   The instruments
   --------------------------------------------------------- */

/* band-limited saw (PolyBLEP) */
function polyblep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}

/* The pad: three detuned saws a note, each pair of notes through a
   two-pole low-pass (state-variable, gentle resonance) whose cutoff
   follows the brightness; slow, different drifts keep it alive. */
function pad(p, brightness, n, rand) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const ch of p.chords) {
    const notes = V[ch.name];
    const start = Math.max(0, Math.floor((ch.from - 0.05) * SR));
    const release = 1.6;
    const stop = Math.min(n, Math.ceil((ch.to + release) * SR));
    notes.forEach((root, j) => {
      /* a root below the pad's range is played an octave up, softly:
         the sub gives the depth, at the moments that want it */
      const low = j === 0 && root < 40;
      const midi = low ? root + 12 : root;
      const height = clamp((midi - 57) / 15, -1, 1);
      const gain = (low ? 0.7 : 1) * 0.05 * (1 - 0.3 * height) / Math.sqrt(notes.length);
      for (const [cents, pan] of [[-8, -0.6], [0, 0], [7, 0.6]]) {
        const hz = midiHz(midi) * Math.pow(2, cents / 1200);
        const pp = clamp(pan + (j - notes.length / 2) * 0.05, -0.85, 0.85);
        const gl = Math.cos((pp + 1) * Math.PI / 4);
        const gr = Math.sin((pp + 1) * Math.PI / 4);
        let ph = rand();
        const drift = 0.07 + rand() * 0.08;
        const dph = rand();
        let s1 = 0; let s2 = 0;
        for (let i = start; i < stop; i += 1) {
          const t = i / SR;
          const env = smooth(t, ch.from - 0.05, ch.from - 0.05 + ch.attack) * (1 - smooth(t, ch.to, ch.to + release));
          const f = hz * (1 + 0.0015 * Math.sin(TAU * (dph + t * drift)));
          const dt = f / SR;
          ph += dt;
          if (ph >= 1) ph -= 1;
          const saw = 2 * ph - 1 - polyblep(ph, dt);
          /* cutoff: from just above the note to well into the brights */
          const b = brightness[i];
          const fc = Math.min(9000, f * 1.2 + 180 + 3200 * b * b);
          /* zero-delay-feedback state-variable low-pass, Q about 0.8 */
          const g = Math.tan(Math.PI * fc / SR);
          const k = 1.25;
          const hp = (saw - (k + g) * s1 - s2) / (1 + g * (k + g));
          const bp = g * hp + s1;
          const lp = g * bp + s2;
          s1 = g * hp + bp;
          s2 = g * bp + lp;
          const v = lp * env * gain * (cents === 0 ? 1 : 0.8);
          L[i] += v * gl; R[i] += v * gr;
        }
      }
    });
  }
  return [L, R];
}

/* A glass tone: a sine, frequency-modulated by another at twice its
   frequency, the modulation dying away fast — the attack has a little
   shimmer, then it is nearly pure. */
function glassTones(p, n) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const g of p.glass) {
    const hz = midiHz(g.midi);
    const start = Math.round(g.at * SR);
    const len = Math.min(n - start, Math.round((g.short ? 1.4 : 3.2) * SR));
    const decay = g.short ? 0.45 : 1.25;
    const gl = Math.cos((g.pan + 1) * Math.PI / 4);
    const gr = Math.sin((g.pan + 1) * Math.PI / 4);
    for (let i = 0; i < len; i += 1) {
      const t = i / SR;
      const index = (g.soft ? 0.5 : 1.6) * Math.exp(-t / 0.09) + 0.25 * Math.exp(-t / 0.6);
      const mod = Math.sin(TAU * hz * 2 * t) * index;
      const v = 0.06 * g.vel * Math.min(1, t / 0.004) * Math.exp(-t / decay) * Math.sin(TAU * hz * t + mod);
      L[start + i] += v * gl; R[start + i] += v * gr;
    }
  }
  return [L, R];
}

/* the sub: a sine with a slow bloom; on Search, a short round pulse */
function sub(p, n) {
  const out = new Float32Array(n);
  for (const s of p.subs) {
    const hz = midiHz(s.midi);
    const start = Math.round(s.at * SR);
    const len = Math.min(n - start, Math.round((s.len + 1) * SR));
    for (let i = 0; i < len; i += 1) {
      const t = i / SR;
      const env = s.thump
        ? Math.min(1, t / 0.006) * Math.exp(-t / 0.16)
        : smooth(t, 0, 0.35) * (1 - smooth(t, s.len, s.len + 1));
      const f = s.thump ? hz * (1 + 0.6 * Math.exp(-t / 0.03)) : hz;
      out[start + i] += 0.11 * s.vel * env * Math.sin(TAU * f * t);
    }
  }
  return out;
}

/* soft plucks: a triangle with a fast-closing low-pass */
function plucks(p, n) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  p.pulses.forEach((pl, j) => {
    const hz = midiHz(pl.midi);
    const start = Math.round(pl.at * SR);
    const len = Math.min(n - start, Math.round(0.6 * SR));
    const pan = j % 2 ? 0.3 : -0.3;
    const gl = Math.cos((pan + 1) * Math.PI / 4);
    const gr = Math.sin((pan + 1) * Math.PI / 4);
    let lo = 0;
    for (let i = 0; i < len; i += 1) {
      const t = i / SR;
      const ph = (hz * t) % 1;
      const tri = 1 - 4 * Math.abs(ph - 0.5);
      const fc = 400 + 2600 * Math.exp(-t / 0.05);
      const a = 1 - Math.exp(-TAU * fc / SR);
      lo += a * (tri - lo);
      const v = 0.03 * pl.vel * Math.min(1, t / 0.003) * Math.exp(-t / 0.16) * lo;
      L[start + i] += v * gl; R[start + i] += v * gr;
    }
  });
  return [L, R];
}

/* air: high, soft noise; a constant thread, and swells that crest on
   their moment */
function air(p, n, rand) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const amount = new Float32Array(n);
  for (const s of p.swells) {
    const a = Math.max(0, Math.floor((s.to - s.len) * SR));
    const b = Math.min(n, Math.ceil((s.to + s.len * 1.6) * SR));
    for (let i = a; i < b; i += 1) {
      const t = i / SR;
      const rise = smooth(t, s.to - s.len, s.to);
      const fall = 1 - smooth(t, s.to, s.to + s.len * 1.6);
      amount[i] = Math.max(amount[i], s.amp * rise * fall);
    }
  }
  const st = [{ h: 0, l: 0, l2: 0 }, { h: 0, l: 0, l2: 0 }];
  const hp = Math.exp(-TAU * 3000 / SR);
  const lp = Math.exp(-TAU * 9000 / SR);
  for (let i = 0; i < n; i += 1) {
    const a = 0.06 + amount[i];
    for (let c = 0; c < 2; c += 1) {
      const x = rand() * 2 - 1;
      const f = st[c];
      f.h = hp * f.h + (1 - hp) * x;
      f.l = lp * f.l + (1 - lp) * (x - f.h);
      f.l2 = lp * f.l2 + (1 - lp) * f.l;
      (c ? R : L)[i] += 0.02 * a * f.l2;
    }
  }
  return [L, R];
}

/* a ping-pong echo, darker each time round */
function echo(L, R, delay, feedback, mix) {
  const d = Math.round(delay * SR);
  const n = L.length;
  const oL = new Float32Array(n);
  const oR = new Float32Array(n);
  let lpL = 0; let lpR = 0;
  const a = Math.exp(-TAU * 3500 / SR);
  for (let i = 0; i < n; i += 1) {
    const inL = i >= d ? L[i - d] + oR[i - d] * feedback : 0;
    const inR = i >= d ? R[i - d] + oL[i - d] * feedback : 0;
    lpL = a * lpL + (1 - a) * inL;
    lpR = a * lpR + (1 - a) * inR;
    oL[i] = lpL; oR[i] = lpR;
  }
  for (let i = 0; i < n; i += 1) { L[i] += oL[i] * mix; R[i] += oR[i] * mix; }
}

/* ---------------------------------------------------------
   The score, mixed: returns the music's stereo stems before its level
   against the voice is set, and the cues
   --------------------------------------------------------- */

function scoreFilm(tl, duck, { reverb }) {
  const n = Math.round(tl.duration * SR);
  const p = planScore(tl);
  const rand = seeded(5150);
  const brightness = automation(p.bright, n);
  const level = automation(p.level, n);
  const [padL, padR] = pad(p, brightness, n, rand);
  const [gL, gR] = glassTones(p, n);
  echo(gL, gR, 0.36, 0.28, 0.16);
  const lowSub = sub(p, n);
  const [pL, pR] = plucks(p, n);
  echo(pL, pR, 0.27 * 1.5, 0.22, 0.14);
  const [aL, aR] = air(p, n, rand);

  /* under the voice: the pad and air step back furthest, the glass
     less, the sub barely — and smoothly, from the drawn duck curve */
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const sendL = new Float32Array(n);
  const sendR = new Float32Array(n);
  const under = { pad: Math.pow(10, -11 / 20), glass: Math.pow(10, -7 / 20), sub: Math.pow(10, -11 / 20), air: Math.pow(10, -12 / 20), pluck: Math.pow(10, -8 / 20) };
  for (let i = 0; i < n; i += 1) {
    const d = duck[i];
    const lv = level[i];
    const gp = lv * (1 + d * (under.pad - 1));
    const gg = (0.45 + 0.55 * lv) * (1 + d * (under.glass - 1));
    const gs = lv * (1 + d * (under.sub - 1));
    const ga = lv * (1 + d * (under.air - 1));
    const gk = (1 + d * (under.pluck - 1));
    const l = padL[i] * gp + gL[i] * gg + lowSub[i] * gs + aL[i] * ga + pL[i] * gk;
    const r = padR[i] * gp + gR[i] * gg + lowSub[i] * gs + aR[i] * ga + pR[i] * gk;
    L[i] = l; R[i] = r;
    sendL[i] = padL[i] * gp * 0.7 + gL[i] * gg * 1.4 + aL[i] * ga * 0.4 + pL[i] * gk * 0.8;
    sendR[i] = padR[i] * gp * 0.7 + gR[i] * gg * 1.4 + aR[i] * ga * 0.4 + pR[i] * gk * 0.8;
  }
  const [wL, wR] = reverb(sendL, sendR, { room: 0.9, damp: 0.55, predelay: 0.03 });
  /* the end is silence: the last frame has no tail running past it */
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    const out = 1 - smooth(t, tl.duration - 0.9, tl.duration - 0.02);
    L[i] = (L[i] + wL[i] * 0.85) * out;
    R[i] = (R[i] + wR[i] * 0.85) * out;
  }
  return { L, R, cues: p.cues, plan: p };
}

module.exports = { planScore, scoreFilm, VOICINGS: V };
