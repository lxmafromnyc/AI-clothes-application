/* Single frames, for looking at the film closely: every beat of the
   timeline by default, or the frames asked for, at full size.

   npm run stills                       fixture data, both shapes
   npm run stills -- --dataset=real --frames=0,138,400 --only=mobile
   → out/stills/<shape>-<frame>.png and a contact sheet per shape */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';
import { ROOT } from './shared.mjs';
import { loadTs } from './timeline.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const dataset = args.dataset || 'fixture';
const OUT = path.join(ROOT, 'out', 'stills');
fs.mkdirSync(OUT, { recursive: true });

const { BEAT, TOTAL } = await loadTs('src/data/timeline.ts');
const frames = args.frames
  ? String(args.frames).split(',').map(Number)
  : [...new Set(Object.values(BEAT).map((f) => Math.min(TOTAL - 1, f + 6)))].sort((a, b) => a - b);

function browser() {
  if (process.env.REMOTION_BROWSER) return process.env.REMOTION_BROWSER;
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return null;
  const dir = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()[0];
  return dir ? path.join(root, dir, 'chrome-linux', 'headless_shell') : null;
}

const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), publicDir: path.join(ROOT, 'public') });
const common = { serveUrl, browserExecutable: browser(), chromiumOptions: { gl: 'swangle' }, logLevel: 'warn' };
for (const [id, name, layout] of [['FyndDemo', 'desktop', 'desktop'], ['FyndDemoMobile', 'mobile', 'mobile']]) {
  if (args.only && args.only !== layout) continue;
  const inputProps = { dataset, burnCaptions: Boolean(args['burn-captions']), layout, forceHandoff: Boolean(args.handoff) };
  const composition = await selectComposition({ ...common, id, inputProps });
  const files = [];
  for (const frame of frames) {
    const output = path.join(OUT, `${name}-${String(frame).padStart(3, '0')}.png`);
    await renderStill({ ...common, composition, inputProps, frame, output, scale: args.scale ? Number(args.scale) : 1 });
    files.push(output);
  }
  /* a contact sheet, each frame labelled with its number */
  try {
    const cols = layout === 'desktop' ? 4 : 6;
    const w = layout === 'desktop' ? 480 : 270;
    const inputs = files.flatMap((f) => ['-i', f]);
    const parts = files.map((f, i) => `[${i}:v]scale=${w}:-1,drawtext=text='${path.basename(f, '.png').split('-').pop()}':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6[v${i}]`);
    const rows = Math.ceil(files.length / cols);
    const layoutStr = files.map((_, i) => `${(i % cols) ? Array.from({ length: i % cols }, () => `w0`).join('+') : '0'}_${Math.floor(i / cols) ? Array.from({ length: Math.floor(i / cols) }, () => 'h0').join('+') : '0'}`).join('|');
    const filter = `${parts.join(';')};${files.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${files.length}:layout=${layoutStr}:fill=white[out]`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', path.join(OUT, `sheet-${name}.png`)]);
    console.log(`${name}: ${files.length} frames, sheet out/stills/sheet-${name}.png (${rows} rows)`);
  } catch (err) {
    console.log(`${name}: ${files.length} frames (no contact sheet: ${err.message.split('\n')[0]})`);
  }
}
