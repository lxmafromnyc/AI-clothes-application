/* Rendering settings for the Fynd film.

   The browser: Remotion downloads its own headless Chrome the first time
   it renders. Where that download is not possible, REMOTION_BROWSER (or
   a Playwright Chromium found on the machine) is used instead. */
import { Config } from '@remotion/cli/config';
import fs from 'fs';
import path from 'path';

Config.setVideoImageFormat('png');
Config.setPixelFormat('yuv420p');
Config.setCodec('h264');
Config.setCrf(18);
Config.setConcurrency(Number(process.env.REMOTION_CONCURRENCY || 2));
Config.setChromiumOpenGlRenderer('swangle');

const browser = (() => {
  if (process.env.REMOTION_BROWSER) return process.env.REMOTION_BROWSER;
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return null;
  const dir = fs.readdirSync(root).filter((d) => /^chromium_headless_shell-\d+$/.test(d)).sort().reverse()[0];
  const p = dir && path.join(root, dir, 'chrome-linux', 'headless_shell');
  return p && fs.existsSync(p) ? p : null;
})();
if (browser) Config.setBrowserExecutable(browser);
