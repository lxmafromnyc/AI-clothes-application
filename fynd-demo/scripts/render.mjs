/* Renders the film.

   npm run render              the finals, from the real captured data:
                                 out/fynd-demo.{mp4,webm}, out/fynd-demo-poster.jpg,
                                 out/fynd-demo-mobile.{mp4,webm}, out/fynd-demo-mobile-poster.jpg,
                                 out/fynd-demo.vtt, out/fynd-demo-mobile.vtt
                               Refuses to run on the fixture.
   npm run render -- --publish also copies them into ../assets/demo/, where
                               the site's demo section plays them
   npm run preview             half-size MP4s from the fixture, in out/preview/,
                               stamped PREVIEW · FIXTURE DATA
   options: --only=desktop|mobile  --scale=0.5  --frames=0-149  --burn-captions

   The same bundle, props and settings every time: the output depends on
   the data, the narration and the code, nothing else. */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { REPO, ROOT, writeJson } from './shared.mjs';
import { loadTs, vtt } from './timeline.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const preview = Boolean(args.preview);
const dataset = preview ? 'fixture' : (args.dataset || 'real');
const scale = Number(args.scale || (preview ? 0.5 : 1));
const OUT = path.join(ROOT, 'out', preview ? 'preview' : '');
const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

if (!preview && dataset !== 'real') fail('A final is rendered from the real captured data only. Use npm run preview for the fixture.');
if (!preview && scale !== 1) fail('A final is rendered at full size.');

/* the data is checked here too, before minutes of rendering */
const dataFile = path.join(ROOT, 'public', 'data', dataset === 'real' ? 'captured.json' : 'captured.fixture.json');
if (!fs.existsSync(dataFile)) fail(dataset === 'real' ? 'public/data/captured.json is missing. Run npm run collect.' : 'Run npm run fixture first.');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const { validate } = await loadTs('src/data/load.ts');
const problems = validate(data, dataset);
if (problems.length) fail(`The data is not fit to render:\n  - ${problems.join('\n  - ')}`);
if (dataset === 'real') {
  const missing = data.searches.flatMap((s) => s.products).map((p) => p.image)
    .concat(Object.values(data.retailer.screenshots).filter(Boolean))
    .filter((f) => !fs.existsSync(path.join(ROOT, 'public', f)));
  if (missing.length) fail(`Files the data names are missing from public/: ${missing.slice(0, 5).join(', ')}`);
}
const voiceFile = path.join(ROOT, 'public', 'audio', 'narration', 'voice.json');
if (!fs.existsSync(voiceFile)) fail('Run npm run narration first.');
const voice = JSON.parse(fs.readFileSync(voiceFile, 'utf8'));
const { placeVoice, FPS, BEAT } = await loadTs('src/data/timeline.ts');
const beats = placeVoice(voice);

function browser() {
  if (process.env.REMOTION_BROWSER) return process.env.REMOTION_BROWSER;
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return null; /* Remotion's own */
  const dir = fs.readdirSync(root).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse()[0];
  const p = dir && path.join(root, dir, 'chrome-linux', 'headless_shell');
  return p && fs.existsSync(p) ? p : null;
}

fs.mkdirSync(OUT, { recursive: true });
console.log(`Bundling… (${dataset} data${preview ? ', preview' : ''})`);
const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), publicDir: path.join(ROOT, 'public') });
const common = {
  serveUrl,
  browserExecutable: browser(),
  chromiumOptions: { gl: 'swangle' },
  concurrency: Number(process.env.REMOTION_CONCURRENCY || 2),
  logLevel: 'warn'
};

const SHAPES = [
  { id: 'FyndDemo', name: 'fynd-demo', layout: 'desktop' },
  { id: 'FyndDemoMobile', name: 'fynd-demo-mobile', layout: 'mobile' }
].filter((s) => !args.only || s.layout === args.only);

const frameRange = args.frames ? args.frames.split('-').map(Number) : undefined;
const report = { dataset, capturedAt: data.capturedAt, renderedAt: new Date().toISOString(), outputs: [] };
for (const shape of SHAPES) {
  const inputProps = { dataset, burnCaptions: Boolean(args['burn-captions']), layout: shape.layout };
  const composition = await selectComposition({ ...common, id: shape.id, inputProps });
  const encodes = preview ? [['mp4', 'h264']] : [['mp4', 'h264'], ['webm', 'vp9']];
  for (const [ext, codec] of encodes) {
    const file = path.join(OUT, `${shape.name}.${ext}`);
    let last = -1;
    console.log(`Rendering ${path.relative(ROOT, file)}…`);
    await renderMedia({
      ...common, composition, inputProps, codec, outputLocation: file, scale, frameRange,
      ...(codec === 'h264' ? { crf: 18, pixelFormat: 'yuv420p', audioCodec: 'aac', audioBitrate: '192k', x264Preset: 'slow' } : { crf: 30, pixelFormat: 'yuv420p', audioCodec: 'opus' }),
      onProgress: ({ progress }) => {
        const p = Math.floor(progress * 10);
        if (p !== last) { last = p; process.stdout.write(`  ${p * 10}%\r`); }
      }
    });
    report.outputs.push(path.basename(file));
  }
  if (!preview) {
    /* the poster: the hoodie results with A, B and C marked */
    const poster = path.join(OUT, `${shape.name}-poster.jpg`);
    await renderStill({ ...common, composition, inputProps, frame: BEAT.emphasisC + 12, output: poster, imageFormat: 'jpeg', jpegQuality: 92 });
    report.outputs.push(path.basename(poster));
  }
  const captions = path.join(OUT, `${shape.name}.vtt`);
  fs.writeFileSync(captions, vtt(beats, FPS));
  report.outputs.push(path.basename(captions));
}
writeJson(path.join(OUT, 'render.json'), report);

if (args.publish && !preview) {
  const dest = path.join(REPO, 'assets', 'demo');
  for (const f of report.outputs) fs.copyFileSync(path.join(OUT, f), path.join(dest, f));
  console.log(`Copied into ${path.relative(process.cwd(), dest)}: ${report.outputs.join(', ')}`);
}
console.log(`\nDone: ${report.outputs.map((f) => path.relative(process.cwd(), path.join(OUT, f))).join(', ')}`);
