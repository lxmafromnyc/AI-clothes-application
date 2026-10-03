/* The film's few sound effects, synthesized — no samples, no licences,
   and the same bytes on every run (the noise is seeded).

   Restrained on purpose: soft keys, a trackpad click, a two-note
   confirmation when Fynd has read the request, a breath of air as
   results arrive, a tick for a hover, a firmer click to choose.

   npm run sfx   →   public/audio/sfx/*.wav (48 kHz, mono, 16-bit) */
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC } from './shared.mjs';

const RATE = 48000;
const OUT = path.join(PUBLIC, 'audio', 'sfx');
fs.mkdirSync(OUT, { recursive: true });

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const buffer = (seconds) => new Float32Array(Math.round(seconds * RATE));
const env = (t, attack, decay) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/* a one-pole filter pair, for shaping noise */
function lowpass(x, hz) {
  const a = Math.exp((-2 * Math.PI * hz) / RATE);
  let y = 0;
  return x.map((v) => (y = (1 - a) * v + a * y));
}
const highpass = (x, hz) => { const lp = lowpass(x, hz); return x.map((v, i) => v - lp[i]); };

function noise(seconds, seed) {
  const r = rng(seed);
  return buffer(seconds).map(() => r());
}

function tone(out, at, hz, seconds, gain, attack = 0.004, decay = 0.08) {
  const start = Math.round(at * RATE);
  const n = Math.round(seconds * RATE);
  for (let i = 0; i < n && start + i < out.length; i += 1) {
    const t = i / RATE;
    out[start + i] += Math.sin(2 * Math.PI * hz * t) * env(t, attack, decay) * gain;
  }
}

function mixInto(out, src, at = 0, gain = 1) {
  const start = Math.round(at * RATE);
  for (let i = 0; i < src.length && start + i < out.length; i += 1) out[start + i] += src[i] * gain;
}

function enveloped(x, attack, decay) {
  return x.map((v, i) => v * env(i / RATE, attack, decay));
}

function write(name, x, peak = 0.7) {
  const max = Math.max(...x.map(Math.abs)) || 1;
  /* a short fade at the end so nothing clicks off */
  const fade = Math.round(0.004 * RATE);
  const pcm = Buffer.alloc(44 + x.length * 2);
  pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + x.length * 2, 4); pcm.write('WAVE', 8);
  pcm.write('fmt ', 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(RATE, 24); pcm.writeUInt32LE(RATE * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36); pcm.writeUInt32LE(x.length * 2, 40);
  x.forEach((v, i) => {
    const tail = i > x.length - fade ? (x.length - i) / fade : 1;
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, (v / max) * peak * tail)) * 32767), 44 + i * 2);
  });
  fs.writeFileSync(path.join(OUT, `${name}.wav`), pcm);
}

/* keys: a soft tick of filtered noise and a little body, four slightly
   different ones so a run of typing never repeats */
for (let k = 0; k < 4; k += 1) {
  const x = buffer(0.09);
  mixInto(x, enveloped(highpass(lowpass(noise(0.09, 11 + k), 5200 - k * 400), 1400 + k * 150), 0.0008, 0.010 + k * 0.002), 0, 1);
  tone(x, 0, 150 + k * 12, 0.05, 0.35, 0.001, 0.012);
  write(`key-${k}`, x, 0.55);
}

/* a trackpad click */
{
  const x = buffer(0.08);
  mixInto(x, enveloped(highpass(noise(0.08, 3), 2500), 0.0004, 0.004), 0, 1);
  tone(x, 0, 1900, 0.05, 0.25, 0.0005, 0.008);
  write('click', x, 0.6);
}

/* Fynd has read the request: two soft notes, a fifth apart */
{
  const x = buffer(0.6);
  tone(x, 0, 784, 0.5, 0.5, 0.006, 0.16);
  tone(x, 0.09, 1175, 0.5, 0.42, 0.006, 0.2);
  tone(x, 0, 1568, 0.3, 0.06, 0.004, 0.06);
  write('confirm', x, 0.5);
}

/* results arrive: a breath of air, rising and falling */
{
  const n = noise(0.5, 7);
  const air = lowpass(highpass(n, 500), 3200);
  const x = air.map((v, i) => { const t = i / RATE; return v * Math.sin(Math.PI * Math.min(1, t / 0.5)) ** 2; });
  write('arrive', x, 0.45);
}

/* a hover: the lightest tick */
{
  const x = buffer(0.05);
  tone(x, 0, 2600, 0.04, 0.6, 0.0008, 0.006);
  mixInto(x, enveloped(highpass(noise(0.05, 5), 3000), 0.0003, 0.003), 0, 0.3);
  write('hover', x, 0.4);
}

/* choosing: a firmer click with a low note under it */
{
  const x = buffer(0.25);
  mixInto(x, enveloped(highpass(noise(0.08, 9), 2000), 0.0004, 0.005), 0, 1);
  tone(x, 0, 1700, 0.05, 0.25, 0.0005, 0.01);
  tone(x, 0.005, 523, 0.22, 0.35, 0.004, 0.07);
  write('select', x, 0.6);
}

console.log(`Sound effects written to ${path.relative(process.cwd(), OUT)}: ${fs.readdirSync(OUT).join(', ')}`);
