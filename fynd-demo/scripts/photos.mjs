/* Is this file a real product photograph?

   Used twice: by npm run collect on every photo it downloads, and by the
   final render on every photo the data names, so a placeholder can never
   reach a finished film however it got into public/.

   A photo passes when it is
     - a raster photo format (JPEG, PNG, WebP, AVIF) — never SVG, which is
       what the site's own drawn garment artwork and the preview fixture are
     - a real file (over 4 KB), decodable, at least MIN_WIDTH wide
     - a picture with detail in it: drawn placeholders, flat colour fields
       and smooth gradients have next to no edges; a product photograph has
       a silhouette, folds, seams, a background.
   The image is decoded with ffmpeg (FFMPEG_PATH, or ffmpeg on the PATH),
   scaled to 48×60 grey, and its contrast and edge energy measured. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MIN_WIDTH = 320;
const RASTER = /\.(jpe?g|png|webp|avif)$/i;
const MIN_BYTES = 4096;
/* measured on 48×60 greyscale (0–255) */
const MIN_CONTRAST = 6;     /* standard deviation */
const MIN_DETAIL = 1.5;     /* mean absolute difference between neighbours */

const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';

export function measure(file) {
  let size = null;
  try {
    execFileSync(ffmpeg(), ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    /* ffmpeg -i with no output always "fails"; the stream line is in stderr */
    const m = /Video:.*?,\s(\d{2,5})x(\d{2,5})/.exec(String(err.stderr || ''));
    if (m) size = { w: Number(m[1]), h: Number(m[2]) };
  }
  const W = 48;
  const H = 60;
  const raw = execFileSync(ffmpeg(), ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
  if (raw.length < W * H) throw new Error('could not be decoded');
  const px = raw.subarray(0, W * H);
  let sum = 0;
  for (const v of px) sum += v;
  const mean = sum / px.length;
  let sq = 0;
  for (const v of px) sq += (v - mean) ** 2;
  let diff = 0;
  let n = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = px[y * W + x];
      if (x + 1 < W) { diff += Math.abs(v - px[y * W + x + 1]); n += 1; }
      if (y + 1 < H) { diff += Math.abs(v - px[(y + 1) * W + x]); n += 1; }
    }
  }
  return { size, contrast: Math.sqrt(sq / px.length), detail: diff / n };
}

/* null when the file is a usable product photo, otherwise why not */
export function photoProblem(file) {
  if (!fs.existsSync(file)) return 'is missing';
  if (!RASTER.test(file)) return `is not a photograph (${path.extname(file) || 'no extension'}): drawn artwork and placeholders are never used`;
  const bytes = fs.statSync(file).size;
  if (bytes < MIN_BYTES) return `is too small a file to be a photograph (${bytes} bytes)`;
  let m;
  try { m = measure(file); } catch (err) { return `could not be read as an image (${err.message.split('\n')[0]})`; }
  if (m.size && m.size.w < MIN_WIDTH) return `is ${m.size.w}px wide — too small to stay sharp (needs ${MIN_WIDTH}+)`;
  if (m.contrast < MIN_CONTRAST || m.detail < MIN_DETAIL) {
    return `looks like a placeholder, not a photograph (contrast ${m.contrast.toFixed(1)}, detail ${m.detail.toFixed(2)})`;
  }
  return null;
}
