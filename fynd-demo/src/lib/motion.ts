/* The motion language: few curves, used the same way everywhere.

   - spring UI    entrances: a spring that settles with under 1% overshoot
   - ease         camera moves and handoffs: slow in, slow out
   - fade         opacity only, linear-ish

   Everything takes frames, never seconds, so it is exact at any fps. */
import { Easing, interpolate, spring } from 'remotion';

export const FPS = 30;

/* damping 200 keeps the overshoot under 1%: the element arrives, it
   does not bounce */
export const uiSpring = (frame: number, start: number, durationInFrames = 18) =>
  spring({ frame: frame - start, fps: FPS, durationInFrames, config: { damping: 200, stiffness: 120, mass: 1 } });

const easeInOut = Easing.bezier(0.45, 0, 0.2, 1);
const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

/* 0→1 between two frames, eased */
export const ease = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easeInOut });
export const easeOutBetween = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easeOut });

/* a value that fades in over [inFrom, inTo] and out over [outFrom, outTo] */
export const fadeInOut = (frame: number, inFrom: number, inTo: number, outFrom = Infinity, outTo = Infinity) =>
  Math.min(ease(frame, inFrom, inTo), 1 - ease(frame, outFrom, outTo));

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
