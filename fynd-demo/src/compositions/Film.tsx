/* The film, for one layout. Every layer reads the same absolute frame
   from the locked timeline; `offset` lets a scene be previewed on its
   own without retiming anything. */
import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { color, type Layout } from '../styles/tokens';
import { BEAT, soundCues } from '../data/timeline';
import { placeVoice } from '../data/timeline';
import { productById, type FilmProps } from '../data/load';
import { typedFrames } from '../lib/typing';
import { ease } from '../lib/motion';
import { Stage } from '../components/Stage';
import { Header } from '../components/Header';
import { BurnedCaption, Soundtrack } from '../components/Soundtrack';
import { Describe, pageIn } from '../scenes/Describe';
import { Understand } from '../scenes/Understand';
import { Products } from '../scenes/Products';
import { Vignettes } from '../scenes/Vignettes';
import { Retailer } from '../scenes/Retailer';
import { Finale } from '../scenes/Finale';

export type FilmLayoutProps = FilmProps & { layout: Layout; offset?: number; forceHandoff?: boolean };

/* the keystrokes of the request: the same list draws the text and
   places the key sounds */
export const keystrokes = (query: string) => typedFrames(query, BEAT.typeFrom + 3, BEAT.typeTo - 2);

export const Film: React.FC<FilmLayoutProps> = ({ layout, offset = 0, data, voice, burnCaptions, forceHandoff }) => {
  const frame = useCurrentFrame() + offset;
  if (!data || !voice) throw new Error('The film was rendered without its data. calculateMetadata should have loaded it.');
  const hoodie = data.searches.find((s) => s.id === 'hoodie')!;
  const dress = data.searches.find((s) => s.id === 'dress')!;
  const bag = data.searches.find((s) => s.id === 'bag')!;
  const typed = useMemo(() => keystrokes(hoodie.query), [hoodie.query]);
  const beats = useMemo(() => placeVoice(voice), [voice]);
  const cues = useMemo(() => soundCues(typed, layout), [typed, layout]);
  const chosen = data.choose;
  const mosaic = useMemo(() => data.mosaic.map((id) => productById(data, id)), [data]);
  const product = productById(data, chosen[2]);

  const headerOpacity = pageIn(frame) * (1 - ease(frame, BEAT.frameIn, BEAT.frameIn + 16));
  const caption = beats.find((b) => frame >= b.startFrame && frame < b.startFrame + b.durationInFrames + 8);

  return (
    <AbsoluteFill style={{ backgroundColor: color.bg }}>
      <Stage layout={layout}>
        <Products layout={layout} frame={frame} search={hoodie} chosen={chosen} />
        <Vignettes layout={layout} frame={frame} dress={dress} bag={bag} />
        <Describe layout={layout} frame={frame} query={hoodie.query} typed={typed} />
        <Understand layout={layout} frame={frame} query={hoodie.query} attributes={hoodie.attributes} />
        {headerOpacity > 0 && <Header layout={layout} opacity={headerOpacity} />}
        <Retailer layout={layout} frame={frame} product={product} retailer={data.retailer} forceHandoff={forceHandoff} />
        <Finale layout={layout} frame={frame} mosaic={mosaic} />
      </Stage>
      {data.source === 'fixture' && <FixtureMark layout={layout} />}
      {burnCaptions && <BurnedCaption text={caption ? caption.caption : null} frameWidth={layout === 'desktop' ? 1920 : 1080} />}
      <Soundtrack voice={beats} cues={cues} offset={offset} />
    </AbsoluteFill>
  );
};

/* a preview made from the fixture says so in every frame */
const FixtureMark: React.FC<{ layout: Layout }> = ({ layout }) => (
  <div
    style={{
      position: 'absolute', right: layout === 'desktop' ? 24 : 24, bottom: layout === 'desktop' ? 20 : 28,
      fontFamily: 'Inter, sans-serif', fontSize: layout === 'desktop' ? 18 : 26, fontWeight: 600, letterSpacing: 1,
      color: '#B42318', background: 'rgba(255,255,255,.9)', border: '2px solid #B42318', borderRadius: 8, padding: '4px 10px'
    }}
  >
    PREVIEW · FIXTURE DATA
  </div>
);
