/* The film's TypeScript modules, loaded from Node: src/data/timeline.ts
   and the data validation are compiled on the spot (esbuild) so scripts
   use the very same timing and checks the film does — never a copy. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { ROOT } from './shared.mjs';

export async function loadTs(rel) {
  /* inside the project, so the compiled module resolves its packages here */
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const out = path.join(fs.mkdtempSync(path.join(ROOT, 'out', '.ts-')), 'mod.mjs');
  buildSync({
    entryPoints: [path.join(ROOT, rel)], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
    /* load.ts asks remotion for staticFile; the validation used here needs none of it */
    external: ['remotion']
  });
  const mod = await import(pathToFileURL(out).href);
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  return mod;
}

/* "00:00:01.000" */
export const vttTime = (seconds) => {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

/* the captions, from the voice as the film places it: each cue starts
   with its line and stays a little after it, never into the next */
export function vtt(beats, fps) {
  const cues = beats.map((b, i) => {
    const start = b.startFrame / fps;
    const next = beats[i + 1] ? beats[i + 1].startFrame / fps : Infinity;
    const end = Math.min((b.startFrame + b.durationInFrames) / fps + 0.6, next - 0.1);
    return `${i + 1}\n${vttTime(start)} --> ${vttTime(end)}\n${b.caption}`;
  });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
