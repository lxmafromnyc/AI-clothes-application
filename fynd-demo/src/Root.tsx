/* The compositions: the 16:9 master, the 9:16 phone film, and each
   scene of each on its own for review. All read the same data and the
   same locked timeline. */
import React, { useEffect, useState } from 'react';
import { Composition, continueRender, delayRender, type CalculateMetadataFunction } from 'remotion';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import { FPS, SCENES, TOTAL, type SceneId } from './data/timeline';
import { loadFilm, type FilmProps } from './data/load';
import { Film, type FilmLayoutProps } from './compositions/Film';
import { stage } from './styles/tokens';

/* nothing is drawn until Inter is ready, so no frame has the fallback
   font in it */
const FontGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [handle] = useState(() => delayRender('Loading Inter'));
  useEffect(() => {
    Promise.all(['400', '500', '600', '700'].map((w) => document.fonts.load(`${w} 16px Inter`)))
      .then(() => document.fonts.ready)
      .then(() => continueRender(handle))
      .catch((err) => { console.error(err); continueRender(handle); });
  }, [handle]);
  return <>{children}</>;
};

const Gated: React.FC<FilmLayoutProps> = (props) => (
  <FontGate>
    <Film {...props} />
  </FontGate>
);

const metadata: CalculateMetadataFunction<FilmLayoutProps> = async ({ props }) => ({ props: { ...props, ...(await loadFilm(props)) } });

const defaults: FilmProps = { dataset: 'fixture', burnCaptions: false };

export const Root: React.FC = () => (
  <>
    <Composition id="FyndDemo" component={Gated} durationInFrames={TOTAL} fps={FPS}
      width={stage.desktop.frameWidth} height={stage.desktop.frameHeight}
      defaultProps={{ ...defaults, layout: 'desktop' } as FilmLayoutProps} calculateMetadata={metadata} />
    <Composition id="FyndDemoMobile" component={Gated} durationInFrames={TOTAL} fps={FPS}
      width={stage.mobile.frameWidth} height={stage.mobile.frameHeight}
      defaultProps={{ ...defaults, layout: 'mobile' } as FilmLayoutProps} calculateMetadata={metadata} />
    {(Object.keys(SCENES) as SceneId[]).flatMap((id) => (['desktop', 'mobile'] as const).map((layout) => (
      <Composition key={`${id}-${layout}`} id={`Scene-${id}-${layout}`} component={Gated}
        durationInFrames={SCENES[id].to - SCENES[id].from} fps={FPS}
        width={stage[layout].frameWidth} height={stage[layout].frameHeight}
        defaultProps={{ ...defaults, layout, offset: SCENES[id].from } as FilmLayoutProps} calculateMetadata={metadata} />
    )))}
  </>
);
