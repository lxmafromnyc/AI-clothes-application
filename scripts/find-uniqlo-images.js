#!/usr/bin/env node
/* =========================================================
   Fynd — which colours and photos UNIQLO's image host holds for each
   listed product

     node scripts/find-uniqlo-images.js

   image.uniqlo.com keeps each product's photos at addresses carrying
   the product's own code and a two-digit colour code:
     …/imagesgoods/<code>/item/goods_<colour>_<code>_3x4.jpg   main photo
     …/imagesgoods/<code>/chip/goods_<colour>_<code>_chip.jpg   colour chip
     …/imagesgoods/<code>/sub/goods_<code>_sub<n>_3x4.jpg        more photos
   An address that answers with an image is that product's photo, in
   that colour. This asks every colour code (00–99) once per product,
   with a pause, plus the chip for each colour found and the first sub
   photos. It prints what answered; nothing is written. A colour found
   here is one UNIQLO has photographed — not proof it is on sale now.

   Run where image.uniqlo.com answers (GitHub's runners do).
   ========================================================= */

'use strict';

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'image-check-secret-of-sufficient-length';
const brand = require('../api/_sizing/brands/uniqlo');

const UA = 'Mozilla/5.0 (compatible; FyndCatalog/1.0; +https://ai-clothes-application.vercel.app/about.html)';
const BASE = 'https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isImage(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
    return res.ok && /^image\//.test(res.headers.get('content-type') || '');
  } catch (err) {
    return false;
  }
}

(async () => {
  const out = {};
  for (const p of brand.products()) {
    const code = p.code.slice(1, 7);
    const found = { colours: [], chips: {}, subs: [] };
    for (let c = 0; c < 100; c += 1) {
      const colour = String(c).padStart(2, '0');
      if (await isImage(`${BASE}/${code}/item/goods_${colour}_${code}_3x4.jpg`)) found.colours.push(colour);
      await sleep(120);
    }
    for (const colour of found.colours) {
      const chip = `${BASE}/${code}/chip/goods_${colour}_${code}_chip.jpg`;
      if (await isImage(chip)) found.chips[colour] = chip;
      await sleep(120);
    }
    for (let n = 1; n <= 12; n += 1) {
      const sub = `${BASE}/${code}/sub/goods_${code}_sub${n}_3x4.jpg`;
      if (await isImage(sub)) found.subs.push(sub); else if (n > 3 && !found.subs.length) break;
      await sleep(120);
    }
    out[p.code] = found;
    console.log(`${p.code} ${p.name}: colours ${found.colours.join(', ') || 'none'} · chips ${Object.keys(found.chips).length} · more photos ${found.subs.length}`);
  }
  console.log(`---8<--- images\n${JSON.stringify(out)}\n---8<---`);
})();
