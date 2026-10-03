/* The locked timeline: 32.0 seconds, 30 fps, 960 frames.

   Every scene and every beat inside it is a frame number here; scenes
   read their beats from this file and nothing else, so the timing lives
   in one place. Voice lines are placed against these beats, and
   placeVoice() refuses a line that would spill out of its scene — the
   film is never silently re-timed around the narration. */
import type { VoiceBeat, VoiceLine } from './types';

export const FPS = 30;
export const TOTAL = 960;

export const SCENES = {
  describe: { from: 0, to: 150 },      /* 0.0–5.0s */
  understand: { from: 150, to: 255 },  /* 5.0–8.5s */
  results: { from: 255, to: 495 },     /* 8.5–16.5s */
  choose: { from: 495, to: 765 },      /* 16.5–25.5s */
  retailer: { from: 765, to: 960 }     /* 25.5–32.0s */
} as const;
export type SceneId = keyof typeof SCENES;

/* frames are absolute (from the start of the film) */
export const BEAT = {
  /* 1 — Describe */
  hookOut: 30,              /* 0.0–1.2s "Looking for something specific?" alone, gone by 1.2s */
  pageIn: 36,               /* 1.2–1.47s then the homepage, never under the hook */
  cursorIn: 30,             /* 1.0s  cursor enters */
  fieldClick: 42,           /* 1.4s  straight into the box */
  typeFrom: 42,             /* 1.4–4.0s */
  labelIn: 50,              /* 1.7s  "Just describe it." */
  typeTo: 120,
  toSearch: 120,            /* 4.0s  cursor to Search */
  searchClick: 138,         /* 4.6s */
  loadingFrom: 141,         /* 4.7–5.0s the site's own searching state */

  /* 2 — Understand */
  queryLift: 150,           /* 5.0–5.5s query to the centre */
  attrsFrom: 165,           /* 5.5–6.8s four attributes, one after another */
  attrStagger: 9,
  compressFrom: 204,        /* 6.8–7.6s into one quiet line */
  compressTo: 228,
  resultsIn: 228,           /* 7.6–8.5s first products arrive */

  /* 3 — Matching products */
  gridFull: 255,            /* 8.5s */
  labelFrom: 258,           /* "Matching products" */
  labelTo: 330,
  driftFrom: 285,           /* 9.5–12.0s camera along the first row */
  driftTo: 360,
  emphasisA: 360,           /* 12.0–13.5s A, B, C */
  emphasisB: 375,
  emphasisC: 390,
  emphasisEnd: 405,
  dressFrom: 405,           /* 13.5–15.0s */
  bagFrom: 450,             /* 15.0–16.5s */

  /* 4 — Compare and choose */
  returnTo: 495,            /* 16.5–17.3s back to the hoodies */
  aMove: 519, aHover: 555,  /* 17.3–19.2s */
  bMove: 576, bHover: 600,  /* 19.2–20.8s */
  cMove: 624, cHover: 648,  /* 20.8–22.4s */
  click: 672,               /* 22.4–23.0s */
  handoff: 690,             /* 23.0–25.5s C expands */

  /* 5 — Retailer */
  frameIn: 765,             /* 25.5–27.0s into the browser frame */
  page: 810,                /* 27.0–29.0s the retailer page or the handoff */
  frameOut: 870,            /* 29.0–30.0s back toward Fynd */
  mosaic: 900,              /* 30.0–31.2s */
  finalText: 936,           /* 31.2–32.0s */
  end: 960
} as const;

/* where each line is said: inside its scene, after what it describes has
   started on screen */
export const VOICE_AT: Record<string, { scene: SceneId; frame: number }> = {
  looking: { scene: 'describe', frame: 40 },      /* as the request is typed */
  understands: { scene: 'understand', frame: 160 },
  brings: { scene: 'results', frame: 262 },
  compare: { scene: 'choose', frame: 522 },
  straight: { scene: 'retailer', frame: 790 }
};

export function placeVoice(lines: VoiceLine[]): VoiceBeat[] {
  return Object.entries(VOICE_AT).map(([id, at]) => {
    const line = lines.find((l) => l.id === id);
    if (!line) throw new Error(`No narration for "${id}". Run npm run narration.`);
    const scene = SCENES[at.scene];
    const end = at.frame + line.durationInFrames;
    if (at.frame < scene.from || end > scene.to) {
      throw new Error(`"${id}" (${line.durationInFrames} frames) runs ${at.frame}–${end}, outside the ${at.scene} scene (${scene.from}–${scene.to}).`);
    }
    return { id, audio: line.file, startFrame: at.frame, durationInFrames: line.durationInFrames, caption: line.caption };
  });
}

/* the sound effects, on the same clock */
export type Cue = { at: number; sound: string; volume: number };
/* a phone has no hover, so no hover ticks */
export function soundCues(typedFrames: number[], layout: 'desktop' | 'mobile' = 'desktop'): Cue[] {
  const cues: Cue[] = [
    ...typedFrames.map((at, i) => ({ at, sound: `key-${i % 4}`, volume: 0.13 })),
    { at: BEAT.fieldClick, sound: 'click', volume: 0.24 },
    { at: BEAT.searchClick, sound: 'click', volume: 0.30 },
    { at: BEAT.attrsFrom + 12, sound: 'confirm', volume: 0.18 },
    { at: BEAT.gridFull, sound: 'arrive', volume: 0.16 },
    { at: BEAT.dressFrom, sound: 'arrive', volume: 0.09 },
    { at: BEAT.bagFrom, sound: 'arrive', volume: 0.09 },
    { at: BEAT.aHover, sound: 'hover', volume: 0.10 },
    { at: BEAT.bHover, sound: 'hover', volume: 0.10 },
    { at: BEAT.cHover, sound: 'hover', volume: 0.10 },
    { at: BEAT.click, sound: 'select', volume: 0.28 }
  ];
  return layout === 'mobile' ? cues.filter((c) => c.sound !== 'hover') : cues;
}

/* The music bed: in softly under the hook, ducked about 6 dB whenever a
   line is being said (eased in just ahead of the voice, eased out after
   it), and faded to nothing by the last frame. The bed file itself is
   made at -29 LUFS (scripts/music.py), so it sits around -29 between
   lines and around -35 under them; the voice is at -18. */
export const MUSIC = { file: 'audio/music/bed.wav', duck: 0.5, attack: 8, release: 14, fadeIn: 24, fadeOutFrom: 900 } as const;

export function musicVolume(frame: number, beats: VoiceBeat[]): number {
  const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
  let duck = 0;
  for (const b of beats) {
    const end = b.startFrame + b.durationInFrames;
    const into = smooth((frame - (b.startFrame - MUSIC.attack)) / MUSIC.attack);
    const out = 1 - smooth((frame - end) / MUSIC.release);
    duck = Math.max(duck, Math.min(into, out));
  }
  const fadeIn = smooth(frame / MUSIC.fadeIn);
  const fadeOut = 1 - smooth((frame - MUSIC.fadeOutFrom) / (TOTAL - MUSIC.fadeOutFrom));
  return (1 - (1 - MUSIC.duck) * duck) * fadeIn * fadeOut;
}
