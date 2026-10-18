#!/usr/bin/env node
/* =========================================================
   Fynd — a real photo for each UNIQLO product Fynd lists without one

     node scripts/find-uniqlo-photos.js

   UNIQLO's image host (image.uniqlo.com) serves each product's photos
   at an address carrying the product's own code and a colour code:
     …/imagesgoods/<code>/item/goods_<colour>_<code>_3x4.jpg
   so an image found there is that product's, in that colour — the same
   evidence assets/catalog.js accepts for its UNIQLO photo. This asks,
   for each listed product with no photo, the colours UNIQLO most often
   uses, one at a time, and stops at the first that answers with an
   image. It prints what it found; nothing is written. A product with
   no answer keeps its drawn artwork.
   ========================================================= */

'use strict';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'photo-check-secret-of-sufficient-length';
const brand = require('../api/_sizing/brands/uniqlo');

const COLOURS = ['09', '69', '01', '00', '03', '08', '02', '05', '06', '07', '11', '12', '15', '17', '30', '31', '32', '33', '34', '38', '56', '57', '58', '63', '65', '66', '67', '68'];
const UA = 'Mozilla/5.0 (compatible; FyndCatalog/1.0; +https://ai-clothes-application.vercel.app/about.html)';

(async () => {
  const found = {};
  for (const p of brand.products().filter((x) => !x.imageUrl)) {
    const code = p.code.slice(1, 7);
    for (const colour of COLOURS) {
      const url = `https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/${code}/item/goods_${colour}_${code}_3x4.jpg`;
      try {
        const res = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
        if (res.ok && /^image\//.test(res.headers.get('content-type') || '')) { found[p.code] = url; break; }
      } catch (err) { /* the next colour */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    console.log(`${p.code} ${p.name}: ${found[p.code] || 'no photo found'}`);
  }
  console.log(`---8<--- photos\n${JSON.stringify(found)}\n---8<---`);
})();
