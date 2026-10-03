/* The sound: every voice line where the timeline puts it, and the few
   quiet effects on the same clock. Nothing else — no music. */
import React from 'react';
import { Audio, Sequence, staticFile } from 'remotion';
import type { VoiceBeat } from '../data/types';
import type { Cue } from '../data/timeline';

export const Soundtrack: React.FC<{ voice: VoiceBeat[]; cues: Cue[]; offset?: number }> = ({ voice, cues, offset = 0 }) => (
  <>
    {voice.map((v) => (
      <Sequence key={v.id} from={v.startFrame - offset} durationInFrames={v.durationInFrames + 6} layout="none">
        <Audio src={staticFile(v.audio)} />
      </Sequence>
    ))}
    {cues.map((c, i) => (
      <Sequence key={`${c.sound}-${i}`} from={c.at - offset} durationInFrames={30} layout="none">
        <Audio src={staticFile(`audio/sfx/${c.sound}.wav`)} volume={c.volume} />
      </Sequence>
    ))}
  </>
);

/* the spoken words on screen, only when asked for (the captions track
   carries them otherwise) */
export const BurnedCaption: React.FC<{ text: string | null; frameWidth: number }> = ({ text, frameWidth }) =>
  text ? (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, bottom: frameWidth > 1200 ? 48 : 170, display: 'flex', justifyContent: 'center'
      }}
    >
      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: frameWidth > 1200 ? 30 : 40, fontWeight: 500, color: '#111', background: 'rgba(255,255,255,.92)', padding: '10px 20px', borderRadius: 10 }}>
        {text}
      </div>
    </div>
  ) : null;
