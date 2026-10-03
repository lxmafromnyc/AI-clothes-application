/* Loads what the film is made from, and refuses anything that is not
   real when a final is being rendered.

   The data and the narration timings are read from public/ when the
   composition is set up (calculateMetadata), so a render always uses the
   files on disk — never something compiled in earlier. */
import { staticFile } from 'remotion';
import type { Captured, Product, VoiceLine } from './types';
import { placeVoice } from './timeline';

export type Dataset = 'real' | 'fixture';

export type FilmProps = {
  dataset: Dataset;
  burnCaptions: boolean;
  data?: Captured;
  voice?: VoiceLine[];
};

/* a fixture may link to http example pages; real products link to https */
const PHOTO = /^products\/[\w.-]+\.(jpe?g|png|webp|avif)$/i;
export const MIN_PHOTO_WIDTH = 320;
export const hostOf = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\d?\./, ''); } catch (e) { return ''; }
};
const LINK = /^https?:\/\//;
const HTTPS = /^https:\/\//;

export function validate(data: Captured, dataset: Dataset): string[] {
  const problems: string[] = [];
  if (dataset === 'real' && data.source !== 'real') problems.push(`the data says it is "${data.source}", not real`);
  const byId = new Map<string, Product>();
  for (const s of data.searches) {
    if (!s.products.length) problems.push(`"${s.query}" has no products`);
    for (const p of s.products) {
      byId.set(p.id, p);
      const who = `"${s.query}" → ${p.id}`;
      if (!p.name || !p.brand || !p.retailer) problems.push(`${who} is missing a name, brand or retailer`);
      if (!p.price) problems.push(`${who} has no price`);
      if (!(dataset === 'real' ? HTTPS : LINK).test(p.url)) problems.push(`${who} has no real product link`);
      if (!p.image) problems.push(`${who} has no photo`);
      if (dataset === 'real') {
        /* a real photo: downloaded by npm run collect from the URL the page
           showed, a raster photograph, big enough, with its fingerprint */
        if (!PHOTO.test(p.image)) problems.push(`${who}'s photo is not a downloaded product photograph (${p.image})`);
        if (!p.photoUrl || !HTTPS.test(p.photoUrl)) problems.push(`${who} has no record of where its photo came from`);
        if (!(p.imageWidth >= MIN_PHOTO_WIDTH)) problems.push(`${who}'s photo is ${p.imageWidth}px wide, under ${MIN_PHOTO_WIDTH}`);
        if (!p.sha256) problems.push(`${who}'s photo has no fingerprint; run npm run collect again`);
      }
    }
  }
  for (const id of ['hoodie', 'dress', 'bag']) if (!data.searches.some((s) => s.id === id)) problems.push(`no "${id}" search`);
  /* the Prada search shows Prada: every product in it says so itself */
  const bag = data.searches.find((s) => s.id === 'bag');
  if (dataset === 'real' && bag) {
    for (const p of bag.products) if (!/\bprada\b/i.test(`${p.brand} ${p.name}`)) problems.push(`"${bag.query}" → ${p.id} ("${p.name}") is not a Prada product`);
    if (bag.products.length < 4) problems.push(`"${bag.query}" has fewer than four products to show`);
  }
  const hoodie = data.searches.find((s) => s.id === 'hoodie');
  for (const id of data.choose) if (!hoodie || !hoodie.products.some((p) => p.id === id)) problems.push(`chosen product ${id} is not a hoodie result`);
  const hosts = new Set(data.choose.map((id) => byId.get(id)?.retailer));
  if (hosts.size < 3) problems.push('products A, B and C must come from three different retailers');
  if (!(dataset === 'real' ? HTTPS : LINK).test(data.retailer.url)) problems.push('the retailer has no real URL');
  if (data.retailer.productId !== data.choose[2]) problems.push('the retailer is not product C\'s');
  const c = byId.get(data.choose[2]);
  if (c && c.url !== data.retailer.url) problems.push('the retailer URL is not the one Fynd returned for product C');
  if (data.retailer.host !== hostOf(data.retailer.url)) problems.push(`the retailer host "${data.retailer.host}" is not the URL's own`);
  /* a page is shown only if it loaded, and a page that loaded is shown */
  const shots = Object.values(data.retailer.screenshots).filter(Boolean);
  if (data.retailer.loaded && shots.length < 2) problems.push('the retailer page is marked loaded but its screenshots are missing');
  if (!data.retailer.loaded && shots.length) problems.push('the retailer page did not load, yet screenshots are named for it');
  if (data.retailer.loaded !== (data.retailer.outcome === 'loaded')) problems.push('the retailer outcome and loaded flag disagree');
  if (dataset === 'real' && data.retailer.loaded) {
    for (const f of shots) if (!/^retailer\/[\w-]+\.png$/.test(f as string)) problems.push(`retailer screenshot ${f} was not captured by npm run collect`);
    if (!data.retailer.sha256) problems.push('the retailer screenshots have no fingerprints; run npm run collect again');
  }
  for (const id of data.mosaic) if (!byId.has(id)) problems.push(`mosaic product ${id} is not in any search`);
  return problems;
}

export async function loadFilm(props: FilmProps): Promise<FilmProps> {
  const file = props.dataset === 'real' ? 'data/captured.json' : 'data/captured.fixture.json';
  const res = await fetch(staticFile(file));
  if (!res.ok) {
    throw new Error(props.dataset === 'real'
      ? 'public/data/captured.json is missing. Run npm run collect (real searches) first.'
      : 'public/data/captured.fixture.json is missing. Run npm run fixture.');
  }
  const data = (await res.json()) as Captured;
  const problems = validate(data, props.dataset);
  if (problems.length) throw new Error(`The film's data is not fit to render:\n- ${problems.join('\n- ')}`);

  const vres = await fetch(staticFile('audio/narration/voice.json'));
  if (!vres.ok) throw new Error('public/audio/narration/voice.json is missing. Run npm run narration.');
  const voice = (await vres.json()) as VoiceLine[];
  placeVoice(voice); /* throws if a line does not fit its scene */
  return { ...props, data, voice };
}

export const productById = (data: Captured, id: string) => {
  for (const s of data.searches) {
    const p = s.products.find((x) => x.id === id);
    if (p) return p;
  }
  throw new Error(`No product ${id}`);
};
