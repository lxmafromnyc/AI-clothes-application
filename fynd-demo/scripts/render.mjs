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
            --check   only check the data and photos; render nothing

   The same bundle, props and settings every time: the output depends on
   the data, the narration and the code, nothing else. */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { createHash } from 'node:crypto';
import { REPO, ROOT, writeJson } from './shared.mjs';
import { photoProblem } from './photos.mjs';
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
  /* every product photo must be the real photograph collected for it:
     a raster photo with real detail, unchanged since npm run collect */
  const fingerprint = (f) => createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public', f))).digest('hex');
  const bad = [];
  for (const s of data.searches) {
    for (const p of s.products) {
      const file = path.join(ROOT, 'public', p.image);
      const problem = photoProblem(file);
      if (problem) bad.push(`"${s.query}" ${p.name}: photo ${problem}`);
      else if (fingerprint(p.image) !== p.sha256) bad.push(`"${s.query}" ${p.name}: photo ${p.image} has changed since it was collected`);
    }
  }
  /* the retailer page, if one is shown, is the page that was captured */
  for (const f of Object.values(data.retailer.screenshots).filter(Boolean)) {
    if (!fs.existsSync(path.join(ROOT, 'public', f))) bad.push(`retailer screenshot ${f} is missing`);
    else if (!data.retailer.sha256 || fingerprint(f) !== data.retailer.sha256[f]) bad.push(`retailer screenshot ${f} has changed since it was captured`);
  }
  if (bad.length) fail(`Not everything in the film is the real material as collected; nothing was rendered:\n  - ${bad.join('\n  - ')}`);
  console.log(`Checked ${data.searches.reduce((n, s) => n + s.products.length, 0)} product photos: all real, all as collected.`);
  console.log(`Retailer: ${data.retailer.loaded ? `page captured from ${data.retailer.url}` : `page did not load; the film shows the handoff to ${data.retailer.url}`}`);
}
if (args.check) { console.log('\nThe data is fit to render.'); process.exit(0); }
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
