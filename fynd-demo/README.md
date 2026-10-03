# The Fynd film

A 32-second product film, made in code with [Remotion](https://www.remotion.dev).
It is not a screen recording. The Fynd interface is rebuilt here from the site's
own measured styles, and its products, prices, shops, links and retailer page
come from **real Fynd searches**.

| Composition | Size | Length |
|---|---|---|
| `FyndDemo` | 1920×1080 (16:9) | 960 frames at 30 fps (32.0s) |
| `FyndDemoMobile` | 1080×1920 (9:16) | 960 frames at 30 fps (32.0s) |
| `Scene-<scene>-<shape>` | either size | one scene, for review |

Nothing here changes the site. The Fynd UI, API, search provider, auth and billing
are untouched: this folder only reads `../assets/` and `../scripts/`.

## Making the real film (on your own machine)

The shops and their photo servers have to be reachable, so collecting runs locally.

```sh
# 1. at the repo root: the three real searches (uses your .env), if
#    assets/demo/demo-search.json is not already there from an earlier run
npm run demo:record

# 2. here: photos, card lines and the retailer page, from those searches
cd fynd-demo
npm install
npm run collect

# 3. check, then render
npm test
npm run render                 # → out/fynd-demo.{mp4,webm,vtt}, out/fynd-demo-poster.jpg, and the -mobile set
npm run render -- --publish    # the same, then copied into ../assets/demo/ for the site
```

On Windows PowerShell the commands are the same. The voice and sound effects are
already committed, so the film renders without Python. `npm run narration` is needed
only when a line changes (see below).

## How it is made

```
src/
  data/timeline.ts     the locked timeline: scenes, beats, where each line is said, sound cues
  data/load.ts         loads public/data/*.json and refuses anything not fit to render
  data/types.ts        the shape of the captured data
  styles/tokens.ts     the site's colours, type and measured sizes (1440px and 390px)
  lib/                 motion curves, camera, layout, the seeded typing rhythm
  components/          the site's pieces: header, search box, product card; pointer, browser window
  scenes/              Describe, Understand, Products (3 + 4), Vignettes, Retailer, Finale
  compositions/Film.tsx  one film per shape; every layer reads the same absolute frame
scripts/
  collect-assets.mjs   real data → public/data/captured.json, public/products/, public/retailer/
  make-fixture.mjs     a clearly labelled stand-in, for previews only
  narration.py         the voice (Kokoro, the recorder's settings) → public/audio/narration/
  sfx.mjs              synthesized effects → public/audio/sfx/
  music.py             the music bed → public/audio/music/bed.wav
  photos.mjs           is this file a real product photograph?
  verify.py            checks a rendered film: sync, levels
  render.mjs           finals (real data only) and previews
  stills.mjs           full-size frames at every beat, with a contact sheet
  check.mjs            npm test
```

The UI is laid out at the site's real CSS width (1440 or 390) and zoomed to the frame
(×1.333 or ×2.769), so its proportions are the site's and text stays sharp.

### The timeline (locked)

| Scene | Time | Frames | Voice |
|---|---|---|---|
| 1 Describe | 0.0–5.0s | 0–150 | "Looking for a black oversized hoodie under eighty dollars?" |
| 2 Understand | 5.0–8.5s | 150–255 | "Fynd understands what you're looking for." |
| 3 Matching products | 8.5–16.5s | 255–495 | "And it brings back matching products from different retailers." |
| 4 Compare and choose | 16.5–25.5s | 495–765 | "I can compare them and open the one I like." |
| 5 Retailer | 25.5–32.0s | 765–960 | "And that takes me straight to the retailer." |

The film opens on its hook, alone on white: **"Looking for something specific?"**
(0.0–1.2s). Then it goes straight into the Fynd homepage and the search box. As the
request is typed, **"Just describe it."** comes up quietly above the heading.

In scene 3 the photographs are the hero. The camera holds the whole grid for a
moment, then moves in slowly until the products fill most of the frame. The two
other searches (the linen dress, the Prada bag) are cut in for 1.5s each, framed
just as close.

Every beat is a frame number in `src/data/timeline.ts`. The narration is placed
against those beats; it never moves them. If a line is too long for its scene,
`npm run narration` fails, and so does the render.

### Real data only

- `npm run collect` takes every product field from the API reply the real search
  got, and writes it the way the site writes it (`assets/app.js`).
- Photos are downloaded from the exact URLs the page showed, and each one must be a
  real photograph (`scripts/photos.mjs`). That means a raster photo, decodable,
  at least 320px wide, with real detail in it. SVG, drawn artwork, flat colour tiles,
  gradients and thumbnails are refused, and the collection stops.
- Each photo's SHA-256 is recorded. A final render re-checks every product photo,
  and refuses to render if any fails the photo check or has changed since collection.
  The same applies to the retailer screenshots.
- What Fynd read from the request comes from the saved `/api/interpret` reply. If the
  page read it locally, it comes from the site's own local interpreter instead.
- A, B and C come from the first two rows, from three different shops. C's page is
  opened for real. If the recorder's `classifyPage` says it loaded (not a block or a
  bot check), it is captured at desktop and phone width.
- If no page loads, the film shows the handoff: the product, "Opening", and the real
  host and path. **A retailer page is never drawn.**
- `src/data/load.ts` refuses to render a final in any of these cases:
  - the data is not marked real;
  - a product is missing a price, photo, https link or shop;
  - a photo has no source URL or fingerprint;
  - A, B and C are not from three different shops;
  - the retailer URL is not the one Fynd returned for C;
  - the host shown is not that URL's own;
  - the page is shown as loaded when it did not load, or the other way round.
- The preview fixture says FIXTURE on every photo, and the film stamps
  PREVIEW · FIXTURE DATA on every frame made from it.

### Sound

Three layers, at three levels:

| Layer | Level | Source |
|---|---|---|
| Voice | about −18 LUFS | `npm run narration` |
| Music | about −27 LUFS between lines, about −33 under them | `npm run music` |
| Effects | very quiet | `npm run sfx` |

**Voice.** The five lines (Kokoro v1.0 `af_heart`) are made the way the recorder's
are, at −18 LUFS:
- no commas inside a line;
- no pause over 0.25s (none after "Looking for");
- each one transcribed back with Whisper and required to match.

"Fynd" is spelled "Find" for the voice only. The first line is a question, and its
pitch rises at the end.

**Music.** A calm, warm instrumental bed, written and synthesized in
`scripts/music.py`, so there is no licence to clear and it is identical on every run:
- 90 BPM, 12 bars = exactly 32.0s;
- a soft pad, a light electric-piano pattern, a round low bass, a brushed shaker;
- no drums, no vocals, no lead.

The film ducks it about 6 dB under every line, eased in just ahead of the voice
(`musicVolume` in `src/data/timeline.ts`). It comes in softly under the hook and
fades to nothing by the last frame.

**Effects.** Synthesized and seeded, and kept very quiet:
- soft keys, one per typed character, from the same schedule that draws the text;
- a click, a two-note confirm, a breath of air as results arrive;
- a hover tick (desktop only) and a choosing click.

```sh
KOKORO_DIR=/path/to/kokoro-multi-lang-v1_0 WHISPER_DIR=/path/to/sherpa-onnx-whisper-base.en npm run narration
npm run music
```

After a render, `npm run verify -- out/fynd-demo.mp4` checks the result:
- the length and frame rate;
- that each line is heard on its caption's frame;
- the voice level;
- the music level on its own;
- that every line is at least 8 LU over the music.

## Reviewing

```sh
npm run studio                          # Remotion Studio, scene compositions included
npm run stills                          # every beat as a full-size PNG + contact sheet (fixture)
npm run stills -- --dataset=real --only=mobile --frames=0,400,820
npm run preview                         # half-size MP4s from the fixture
```

## Before publishing

The film shows retailers' product photos and a retailer's page. Make sure you have
the right to use them in marketing.
