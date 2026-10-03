/* When each character of the request appears: a person's rhythm, seeded
   so every render is the same. Used for the text on screen and for the key
   sounds, so the two can never drift apart. */

function generator(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* frame (absolute) at which character i appears, spread across [from, to]
   with uneven gaps and a small beat at each space */
export function typedFrames(text: string, from: number, to: number, seed = 20261003): number[] {
  const rand = generator(seed);
  const weights = [...text].map((ch, i) => {
    let w = 0.75 + rand() * 0.6;
    if (ch === ' ') w += 0.5 + rand() * 0.4;
    if (ch === '$') w += 0.4;
    if (i > 0 && text[i - 1] === ' ') w += 0.15;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const span = to - from;
  let acc = 0;
  return weights.map((w) => {
    acc += w;
    return Math.round(from + (acc / total) * span);
  });
}

export function typedCount(frames: number[], frame: number): number {
  let n = 0;
  for (const f of frames) if (frame >= f) n += 1;
  return n;
}
