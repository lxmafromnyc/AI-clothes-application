/* Where else a product's own photograph can come from, when the one its
   card showed is too small for the film.

   Only from the same real listing, and only in this order:

     1. the photo the card showed, as listed
     2. that same photo at its full size, from the same server: the size
        a CDN was asked to shrink it to is taken out of its address
        (?width=194, Shopify's _200x, Amazon's ._AC_SX200_, eBay's
        s-l225, Cloudinary's w_200). Only a constraint is removed, never
        a bigger size asked for, so nothing is upscaled — the server
        sends the photo as it was uploaded, or the address is refused.
     3. the product record's own imageUrl, when it differs, and its full size
     4. the photos the listing's own page declares for itself (JSON-LD,
        og:image, preload) — and only those Fynd's own catalogue gates
        accept, unchanged (scripts/fetch-catalog-images.js): served over
        https from a sound host, not a logo or share card, and proven to
        be THIS product's (the listing's code in the image's address, the
        page's product record naming it, or the page's canonical identity).

   Every candidate then has to pass the same real-photo test as any
   other (photos.mjs: a raster photograph, at least 320px wide, real
   detail). The first that passes is used. If none does, there is no
   photo for this product, and the caller leaves the product out.

   Nothing here draws, resizes or substitutes: the name, price, link and
   shop always stay the listing's, and the photo is a file a real server
   sent for that listing. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO } from './shared.mjs';

const require = createRequire(path.join(REPO, 'package.json'));
const gates = require(path.join(REPO, 'scripts', 'fetch-catalog-images.js'));

/* query parameters that only ask a CDN for a smaller or cropped copy */
const SIZE_PARAMS = new Set(['w', 'h', 'width', 'height', 'wid', 'hei', 'sw', 'sh', 'size', 'resize', 'imwidth', 'imheight',
  'maxwidth', 'maxheight', 'mw', 'mh', 'odnwidth', 'odnheight', 'odnbg', 'fit', 'crop', 'dpr', 'scale', 'sz']);

/* the same photo with the size it was shrunk to taken out of its
   address; [] when its address names no size */
export function fullSizeRenditions(url) {
  let u;
  try { u = new URL(url); } catch (err) { return []; }
  const out = new Set();
  const add = (next) => {
    if (next.hostname !== u.hostname || next.protocol !== u.protocol) return;
    if (next.href !== u.href) out.add(next.href);
  };

  /* ?width=194&height=243 and the like */
  const sized = [...u.searchParams.keys()].filter((k) => SIZE_PARAMS.has(k.toLowerCase()));
  if (sized.length) {
    const next = new URL(u.href);
    for (const k of sized) next.searchParams.delete(k);
    add(next);
  }
  const file = (pattern, replacement) => {
    const next = new URL(u.href);
    const p = next.pathname.replace(pattern, replacement);
    if (p !== next.pathname) { next.pathname = p; add(next); }
  };
  /* Shopify: name_200x.jpg, name_200x300.jpg, name_x300@2x.jpg */
  file(/_(?:\d+x\d*|x\d+)(?:_crop_[a-z]+)?(?:@\dx)?(?=\.[a-z0-9]+$)/i, '');
  /* Amazon: name._AC_SX200_.jpg */
  file(/\._[A-Z0-9_,]+_(?=\.[a-z0-9]+$)/, '');
  /* eBay: /s-l225.jpg — s-l1600 is its largest, served no bigger than uploaded */
  file(/\/s-l\d+(?=\.[a-z0-9]+$)/i, '/s-l1600');
  /* Cloudinary: /image/upload/w_200,h_250,c_fill/… */
  if (/\/image\/upload\//.test(u.pathname)) {
    file(/\/(?:[a-z]{1,2}_[^/,]+,)*(?:w|h)_\d+(?:,[a-z]{1,2}_[^/,]+)*(?=\/)/, '');
  }
  return [...out];
}

/* The photos the listing's own page offers that Fynd's catalogue gates
   accept as this product's. `html` is the page as it loaded at
   `landedUrl`. Each: { url, from, how }. */
export function listingPagePhotos(html, productUrl, landedUrl) {
  /* a page that went somewhere else (a home page, a search) is not the listing */
  if (!sameListing(productUrl, landedUrl)) return { photos: [], refused: [`the page moved to ${landedUrl}`] };
  const codes = gates.identifiersFrom(productUrl);
  const proven = codes.length ? null : gates.pageIdentity(html, productUrl, landedUrl);
  if (proven && proven.ok === false) return { photos: [], refused: [`the page does not prove it is this listing: ${proven.why}`] };
  const photos = [];
  const refused = [];
  for (const candidate of gates.candidatesFrom(html, landedUrl || productUrl)) {
    const unsound = gates.soundness(candidate, productUrl);
    if (unsound) { refused.push(`${candidate.url}: ${unsound}`); continue; }
    const asset = gates.siteAsset(candidate, productUrl);
    if (asset) { refused.push(`${candidate.url}: ${asset}`); continue; }
    const identity = gates.identityEvidence(candidate, productUrl, proven);
    if (!identity.ok) { refused.push(`${candidate.url}: ${identity.why}`); continue; }
    photos.push({ url: candidate.url, from: candidate.from, how: identity.how });
  }
  return { photos, refused };
}

function sameListing(productUrl, landedUrl) {
  if (!landedUrl) return true;
  try {
    const a = new URL(productUrl);
    const b = new URL(landedUrl);
    const host = (h) => h.replace(/^www\d?\./, '');
    return host(a.hostname) === host(b.hostname) && b.pathname !== '/' && (a.pathname === b.pathname || gates.samePage(productUrl, landedUrl));
  } catch (err) {
    return false;
  }
}

/* The candidates in the order they are tried, before the listing's page
   is read: the listed photo, its full size, the record's own photo. */
export function listedCandidates(item) {
  const out = [{ url: item.photo, source: 'the photo the card showed' }];
  for (const url of fullSizeRenditions(item.photo)) out.push({ url, source: 'the photo the card showed, at its full size' });
  const own = item.rec && item.rec.imageUrl;
  if (own && own !== item.photo) {
    out.push({ url: own, source: 'the product record\'s own photo' });
    for (const url of fullSizeRenditions(own)) out.push({ url, source: 'the product record\'s own photo, at its full size' });
  }
  return dedupe(out);
}

export function pageCandidates(photos) {
  const out = [];
  for (const p of photos) {
    out.push({ url: p.url, source: `the listing page's own photo (${p.from}; ${p.how})` });
    for (const url of fullSizeRenditions(p.url)) out.push({ url, source: `the listing page's own photo at its full size (${p.from}; ${p.how})` });
  }
  return dedupe(out);
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url));
}
