/* =========================================================
   Fynd — one product's page

   product.html?brand=uniqlo&item=E475378-000[&colour=09&size=M]

   Laid out the way a shop lays out a product: photos, the product's
   name, its colours, its sizes and — right under the sizes — Fynd's
   Size Guide ("View size measurements"), which opens the product's real
   chart in a dialog: the same lookup Find Fit makes (Account.sizing.item)
   drawn by the same code (assets/size-chart.js), with what a saved fit
   profile can say about it (assets/fit-compare.js). The chosen colour
   and size stay in the address and are carried into the Size Guide,
   where the chosen size's row is marked and a size can be chosen too;
   closing it leaves the product as it was.

   The shopping part shows only what helps choose: name, colour, size,
   measurements, the retailer. Where each fact came from, and what Fynd
   doesn't hold, is under the closed "Source details".

   Everything shown is what Fynd holds for the product
   (Account.sizing.detail; api/_sizing/brands): photos only from the
   brand's image host, sizes, fabric and fit only from Fynd's record,
   each with its source. A product from the brand's authorized
   catalogue (api/_catalog) may add its colour names, size labels, and —
   only while the catalogue is current and its licence covers them — a
   price and which sizes are in stock, each said to be the catalogue's
   and dated. What Fynd doesn't hold — description, care, reviews, and
   otherwise price and stock — is said in its place, and the retailer's
   own page is one click away. Nothing is filled in to complete the
   layout.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const root = doc && doc.getElementById('product');
  if (!root || !global.SizeChart) return;

  const $ = (id) => doc.getElementById(id);
  const { el, render, renderFailure } = global.SizeChart;
  const IMAGE_HOST = /^https:\/\/image\.uniqlo\.com\//;
  const CODE = /^[A-Z0-9][A-Z0-9-]{2,30}$/;
  const BRAND = /^[a-z0-9-]{2,30}$/;
  const LINES = { men: 'Men', women: 'Women', unisex: 'Unisex' };
  const RETAILERS = { uniqlo: 'UNIQLO' };
  /* whose page this product is sold on: UNIQLO, or the merchant whose own catalogue lists it */
  const retailerOf = () => RETAILERS[brandId] || (product && (product.retailer || product.brand)) || 'the retailer';
  /* a photo from UNIQLO's image host, or from the hosts a merchant's
     catalogue names for this product (product.imageHosts, from the server) */
  const onHosts = (url, hosts) => {
    if (typeof url !== 'string' || !Array.isArray(hosts)) return false;
    try { const u = new URL(url); return u.protocol === 'https:' && hosts.includes(u.hostname); } catch (err) { return false; }
  };
  const photoOk = (url) => Boolean(url) && (IMAGE_HOST.test(url) || onHosts(url, product && product.imageHosts));

  const params = new URLSearchParams(global.location.search);
  const brandId = params.get('brand') || '';
  const code = params.get('item') || '';
  let product = null;
  let colour = null;
  let size = null;
  let chartAnswer = null;
  let guideAsk = 0;

  function status(text, state) {
    $('pdp-status').textContent = text;
    $('pdp-status').hidden = !text;
    root.dataset.state = state;
    root.setAttribute('aria-busy', String(state === 'loading'));
  }

  function photo(url, alt, missing) {
    if (!photoOk(url)) return null;
    const img = el('img');
    img.src = url;
    img.alt = alt || '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      const gone = el('span', missing ? 'pdp-swatch-code' : 'pdp-photo-missing', missing || 'Photo unavailable');
      img.replaceWith(gone);
    }, { once: true });
    return img;
  }

  /* the chosen colour and size, kept in the address */
  function remember() {
    const next = new URLSearchParams({ brand: brandId, item: code });
    if (colour && colour.code) next.set('colour', colour.code);
    if (size) next.set('size', size);
    global.history.replaceState(null, '', `${global.location.pathname}?${next}`);
  }

  function showImage(url, alt) {
    const main = $('pdp-main-image');
    main.dataset.src = url || '';
    const img = photo(url, alt);
    main.replaceChildren(img || el('span', 'pdp-photo-missing', 'No photo known to Fynd'));
    $('pdp-thumbs').querySelectorAll('.pdp-thumb').forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.src === url)));
  }

  function drawGallery() {
    const thumbs = $('pdp-thumbs');
    const urls = [];
    product.colours.forEach((c) => urls.push({ url: c.image, alt: `${product.name}, ${c.label}` }));
    product.gallery.forEach((u, i) => urls.push({ url: u, alt: `${product.name}, photo ${i + 1}` }));
    thumbs.replaceChildren(...urls.filter((u) => photoOk(u.url)).map((u) => {
      const b = el('button', 'pdp-thumb');
      b.type = 'button';
      b.dataset.src = u.url;
      b.setAttribute('aria-label', `Show ${u.alt}`);
      const img = photo(u.url, '');
      /* a thumbnail whose photo doesn't load isn't offered */
      if (img) { img.addEventListener('error', () => b.remove(), { once: true }); b.append(img); }
      b.addEventListener('click', () => showImage(u.url, u.alt));
      return b;
    }));
    thumbs.hidden = urls.length < 2;
  }

  function chooseColour(c, quiet) {
    colour = c;
    $('pdp-colour-name').textContent = c ? c.label : '—';
    const box = $('pdp-colours');
    box.querySelectorAll('.pdp-swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.code === (c && c.code))));
    /* on a phone the colours scroll in one row: keep the chosen one in it */
    const on = box.querySelector('.pdp-swatch[aria-checked="true"]');
    if (on && box.scrollWidth > box.clientWidth) {
      const r = on.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left - b.left - (b.width - r.width) / 2;
    }
    if (c) showImage(c.image, `${product.name}, ${c.label}`);
    /* stock is per colour where the catalogue says so */
    if (!quiet && product.sizes && Array.isArray(product.sizes.variants)) { drawSizes(); chooseSize(size, true); }
    if (!quiet) remember();
  }

  function drawColours() {
    const box = $('pdp-colours');
    if (!product.colours.length) {
      $('pdp-colours-block').hidden = true;
      return;
    }
    box.replaceChildren(...product.colours.map((c) => {
      const b = el('button', 'pdp-swatch');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.code = c.code || '';
      b.setAttribute('aria-label', c.label);
      b.title = c.label;
      const img = photo(c.chip || c.image, '', c.code || '?');
      if (img) b.append(img);
      else b.append(el('span', 'pdp-swatch-code', c.code || '?'));
      b.addEventListener('click', () => chooseColour(c));
      return b;
    }));
  }

  /* one size, chosen on the page or in the Size Guide: both show it */
  function chooseSize(s, quiet) {
    size = s;
    $('pdp-size-heading').textContent = s ? `Your size: ${s}` : (product.sizes ? 'Choose your size' : 'Size');
    doc.querySelectorAll('.pdp-size').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.size === s)));
    if ($('pdp-guide').open) {
      guideChoice();
      markSize($('pdp-guide-body'));
      if (global.FitCompare) global.FitCompare.focus($('pdp-guide-compare'), size);
    }
    if (!quiet) remember();
  }

  /* whether a size is out of stock in the chosen colour, as the
     catalogue last said — null when Fynd doesn't know */
  function sizeOut(s) {
    const sizes = product.sizes || {};
    if (Array.isArray(sizes.variants) && colour && colour.code) {
      const v = sizes.variants.find((x) => x.colour === colour.code && x.size === s);
      if (v) return v.availability === 'out_of_stock';
      if (sizes.variants.some((x) => x.colour === colour.code)) return true;
    }
    if (sizes.availability && sizes.availability[s]) return sizes.availability[s] === 'out_of_stock';
    return null;
  }

  /* the product's sizes as buttons — from Fynd's record, or the
     catalogue's size labels. One is marked out of stock only when the
     catalogue said so, and can still be chosen to read its chart. */
  function sizeButtons() {
    return product.sizes.list.map((s) => {
      const out = sizeOut(s);
      const b = el('button', `pdp-size${out ? ' is-out' : ''}`, s);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(s === size));
      if (out) { b.setAttribute('aria-label', `${s}, out of stock`); b.title = 'Out of stock'; }
      b.dataset.size = s;
      b.addEventListener('click', () => chooseSize(s));
      return b;
    });
  }

  function drawSizes() {
    const box = $('pdp-sizes');
    if (!product.sizes) {
      box.replaceChildren();
      box.hidden = true;
      $('pdp-sizes-note').textContent = `Fynd doesn’t hold this product’s size list — ${retailerOf()}’s page has it.`;
      return;
    }
    box.replaceChildren(...sizeButtons());
    const out = product.sizes.list.filter((s) => sizeOut(s));
    $('pdp-sizes-note').textContent = out.length ? `Out of stock${colour && Array.isArray(product.sizes.variants) ? ' in this colour' : ''}: ${out.join(', ')} (as of ${product.sizes.stockAsOf}).` : '';
    $('pdp-sizes-note').hidden = !out.length;
  }

  /* the expandable sections a shop's page has, each saying what Fynd holds */
  function drawSections() {
    const section = (title, nodes, open) => {
      const d = el('details', 'pdp-section');
      if (open) d.open = true;
      d.append(el('summary', null, title), ...nodes);
      return d;
    };
    const p = (text) => el('p', null, text);
    const sourced = (text, source) => {
      const wrap = el('div', 'pdp-fact');
      wrap.append(el('p', null, text), el('p', 'pdp-source', `Source: ${source}`));
      return wrap;
    };
    const retailer = el('a', 'guide-link', `Read it on ${retailerOf()}`);
    retailer.href = product.url;
    retailer.target = '_blank';
    retailer.rel = 'noopener noreferrer';
    let describe;
    if (product.description) {
      describe = sourced(product.description.text, product.description.source);
      const more = p('');
      more.append(retailer);
      describe.append(more);
    } else {
      describe = p(`Fynd doesn’t hold ${retailerOf()}’s description or feature list for this product. `);
      describe.append(retailer);
    }

    const fitNodes = [];
    if (product.fit) fitNodes.push(sourced(`Fit: ${product.fit.words}`, product.fit.source));
    else fitNodes.push(p(`Fynd doesn’t hold ${retailerOf()}’s fit description for this product.`));
    const guide = el('button', 'btn btn-secondary pdp-section-guide', 'View size measurements');
    guide.type = 'button';
    guide.addEventListener('click', openGuide);
    fitNodes.push(guide);

    const materials = [];
    if (product.material) materials.push(sourced(product.material.text, product.material.source));
    else materials.push(p('Fynd doesn’t hold this product’s fabric composition.'));
    materials.push(p(`Care instructions aren’t held by Fynd — they’re on ${retailerOf()}’s page.`));

    /* where everything on the page came from, and what Fynd doesn't hold */
    const sources = [
      p(brandId === 'uniqlo' ? `Product ID ${product.code.slice(1, 7)} (${product.code}), UNIQLO ${product.market}.` : `Product ID ${product.code}, ${retailerOf()} ${product.market}.`),
      p(product.recordedAt ? `Sizes, fabric and fit are from Fynd’s saved record, ${product.recordFrom || `copied from ${retailerOf()}’s page on ${product.recordedAt}`} — not read live${product.recordVerified === false ? ', and not yet checked' : ''}.` : 'Fynd has no saved record of this product’s details; only its listing and photos.'),
      product.sizes ? p(product.sizes.stockAsOf
        ? `Sizes from ${product.sizes.source}. Stock as the catalogue said on ${product.sizes.stockAsOf} — check ${retailerOf()}’s page before buying.`
        : `Sizes from ${product.sizes.source}. Fynd doesn’t know which sizes are in stock.`) : null,
      product.price ? p(`Price from ${product.price.source}.`) : null,
      product.catalogue ? p(product.catalogue.withheld
        ? `Listed in ${product.catalogue.name}, updated ${product.catalogue.updatedAt} — too long ago for its price and stock to be shown.`
        : `Listed in ${product.catalogue.name}, updated ${product.catalogue.updatedAt}.`) : null,
      p(product.coloursNote),
      p(product.imagesFrom ? `Photos from ${product.imagesFrom}.` : 'Fynd holds no photo of this product.'),
      p(`Not held by Fynd: ${product.missing.join(', ')}.`)
    ].filter(Boolean);

    $('pdp-sections').replaceChildren(
      section('Description & features', [describe]),
      section('Materials & care', materials),
      section('Fit & sizing', fitNodes),
      section('Source details', sources)
    );
  }

  function draw() {
    const retailerName = retailerOf();
    doc.title = `${product.brand} ${product.name} — Fynd`;
    $('pdp-crumb-brand').textContent = retailerName;
    $('pdp-crumb-category').textContent = product.categoryLabel || '';
    $('pdp-brand').textContent = product.brand;
    $('pdp-name').textContent = product.name;
    /* the sizing it is sold in; the ID and everything else are under Source details */
    $('pdp-meta').textContent = [LINES[product.line], `${product.market} sizes`].filter(Boolean).join(' · ');
    /* what Fynd holds for the measurements, said before anything is looked up */
    $('pdp-holds').textContent = product.holdsText || '';
    const link = $('pdp-retailer');
    /* the page itself, or the affiliate network's tracking link to it (the server checked it leads there) */
    link.href = /^https:\/\/(www\.uniqlo\.com|click\.linksynergy\.com)\//.test(product.buyUrl || '') || onHosts(product.buyUrl, product.pageHosts) ? product.buyUrl : product.url;
    link.textContent = `View on ${retailerName}`;
    /* a price only when the catalogue supplies a current one; otherwise
       none is held, so none is shown */
    const price = product.price && Number.isInteger(product.price.amount) && /^[A-Z]{3}$/.test(product.price.currency || '') ? product.price : null;
    /* the price line exists only when there is a price to put on it */
    const oldPrice = $('pdp-price');
    if (oldPrice) oldPrice.remove();
    if (price) {
      const f = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency }).format(n / 100);
      const priceEl = el('p', 'pdp-price', `${price.varies ? 'From ' : ''}${f(price.amount)}`);
      priceEl.id = 'pdp-price';
      if (Number.isInteger(price.was) && price.was > price.amount) priceEl.append(el('span', 'pdp-price-was', f(price.was)));
      $('pdp-meta').after(priceEl);
    }
    const stockKnown = Boolean(product.availability || (product.sizes && product.sizes.stockAsOf));
    $('pdp-retailer-note').textContent = price || stockKnown
      ? `${price ? (stockKnown ? 'Price and stock' : 'Price') : 'Stock'} as ${retailerName}’s catalogue said on ${(product.catalogue && product.catalogue.updatedAt) || 'its last update'} — checkout, and the current figures, are on ${retailerName}’s own page.`
      : `Price, stock and checkout are on ${retailerName}’s own page — Fynd doesn’t know which colours or sizes are in stock.`;
    drawGallery();
    drawColours();
    drawSizes();
    drawSections();
    $('pdp-grid').hidden = false;
    const wantColour = params.get('colour');
    chooseColour(product.colours.find((c) => c.code === wantColour) || product.colours.find((c) => c.code === product.defaultColour) || product.colours[0] || null, true);
    if (product.sizes && Array.isArray(product.sizes.variants)) drawSizes();
    const wantSize = params.get('size');
    chooseSize(product.sizes && product.sizes.list.includes(wantSize) ? wantSize : null, true);
    status('', 'ready');
  }

  /* ---------- the Size Guide ---------- */

  /* the Size Guide's own size choice: the heading, and what comes next —
     a prompt until a size is chosen, then a way back to the product */
  function guideChoice() {
    const next = $('pdp-guide-next');
    const done = $('pdp-guide-done');
    $('pdp-guide-foot').hidden = !product.sizes;
    if (!product.sizes) {
      $('pdp-guide-selected').textContent = 'Sizes';
      next.textContent = '';
      done.hidden = true;
      return;
    }
    $('pdp-guide-selected').textContent = size ? `Your size: ${size}` : 'Choose your size';
    next.textContent = size ? '' : 'Choose a size to continue.';
    done.hidden = !size;
    done.textContent = size ? `Continue with size ${size}` : '';
  }

  /* what the garment is, in a word, to say what a chart is not */
  function garmentWord() {
    const name = product.name || '';
    if (/hoodie/i.test(name)) return 'hoodie';
    if (/sweatshirt/i.test(name)) return 'sweatshirt';
    if (/t-shirt|\btee\b/i.test(name)) return 'T-shirt';
    if (/cardigan/i.test(name)) return 'cardigan';
    if (/sweater/i.test(name)) return 'sweater';
    if (/shirt/i.test(name)) return 'shirt';
    return 'garment';
  }

  /* the chosen size's row, marked in every table that has it — or, when
     no table has it, said */
  function markSize(body) {
    let found = 0;
    body.querySelectorAll('tbody tr').forEach((tr) => {
      const th = tr.querySelector('th');
      const on = Boolean(size && th && th.textContent.trim() === size);
      if (on) found += 1;
      tr.classList.toggle('is-chosen', on);
      if (on) tr.setAttribute('aria-current', 'true');
      else tr.removeAttribute('aria-current');
    });
    const tables = body.querySelectorAll('tbody tr').length > 0;
    let missing = body.querySelector('.pdp-guide-missing');
    if (size && tables && !found) {
      if (!missing) { missing = el('p', 'pdp-guide-missing'); body.prepend(missing); }
      missing.textContent = `Size ${size} isn’t listed in this chart.`;
    } else if (missing) {
      missing.remove();
    }
  }

  async function openGuide() {
    const dialog = $('pdp-guide');
    const body = $('pdp-guide-body');
    const compare = $('pdp-guide-compare');
    $('pdp-guide-product').textContent = [product.brand, product.name, colour && colour.label].filter(Boolean).join(' · ');
    /* the product's own sizes, to choose from beside the chart — and,
       when Fynd holds none, said: a chart's rows aren't the product's sizes */
    $('pdp-guide-sizes').replaceChildren(...(product.sizes ? sizeButtons() : []));
    $('pdp-guide-sizes').hidden = !product.sizes;
    $('pdp-guide-nosizes').hidden = Boolean(product.sizes);
    $('pdp-guide-nosizes').textContent = product.sizes ? '' : `Fynd doesn’t hold this product’s size list, so a size is chosen on ${retailerOf()}’s page.`;
    guideChoice();
    if (!dialog.open) dialog.showModal();
    if (chartAnswer) { show(chartAnswer); return; }
    const ask = ++guideAsk;
    dialog.dataset.state = 'loading';
    compare.hidden = true;
    body.replaceChildren(el('p', 'size-chart-loading', 'Looking up this product’s sizing chart. Reading the brand’s page can take a few seconds…'));
    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await sizing.item(brandId, product.code) : { ok: false, unreachable: true };
    if (ask !== guideAsk) return;
    if (answer.ok && answer.data && answer.data.chart) chartAnswer = answer;
    show(answer);
  }

  function show(answer) {
    const dialog = $('pdp-guide');
    const body = $('pdp-guide-body');
    const compare = $('pdp-guide-compare');
    if (!(answer.ok && answer.data && answer.data.chart)) {
      dialog.dataset.state = 'error';
      body.replaceChildren(...renderFailure(answer, product.url));
      return;
    }
    const chart = answer.data.chart;
    dialog.dataset.state = chart.status;
    body.replaceChildren(...render(chart, product.url, { linked: false, garment: garmentWord() }));
    markSize(body);
    /* Fynd's saved records are kept per product, never per colour: said,
       not assumed either way, with the chart's other sources. A general
       chart is no product's own. */
    const sources = body.querySelector('.size-chart-details');
    if (sources && chart.scope === 'product-specific' && (chart.charts || []).length && product.colours.length > 1) {
      sources.insertBefore(el('p', 'pdp-guide-variant', 'Fynd’s chart is recorded for this product, not for a particular colour.'), sources.children[1] || null);
    }
    /* a body chart is never set beside a garment: FitCompare says why.
       Last time's comparison goes first, so a reopened guide never shows
       another size's figures while this one loads. */
    compare.hidden = true;
    compare.replaceChildren();
    if ((chart.status === 'ok' || chart.status === 'fallback') && global.FitCompare) {
      /* the size being considered, once the comparison is in — whatever
         it is by then */
      global.FitCompare.show(chart, compare, () => dialog.open).then(() => global.FitCompare.focus(compare, size));
    } else {
      compare.hidden = true;
    }
  }

  $('pdp-size-guide').addEventListener('click', openGuide);
  $('pdp-guide-close').addEventListener('click', () => $('pdp-guide').close());
  $('pdp-guide-done').addEventListener('click', () => $('pdp-guide').close());
  $('pdp-guide').addEventListener('click', (event) => { if (event.target === $('pdp-guide')) $('pdp-guide').close(); });
  $('pdp-guide').addEventListener('close', () => { guideAsk += 1; $('pdp-size-guide').focus(); });

  async function load() {
    if (!BRAND.test(brandId) || !CODE.test(code)) {
      status('That isn’t a product Find Fit lists. Choose one from Find Fit.', 'unknown');
      return;
    }
    status('Loading the product…', 'loading');
    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await sizing.detail(brandId, code) : { ok: false };
    if (answer.ok && answer.data && answer.data.product) {
      product = answer.data.product;
      draw();
      return;
    }
    if (answer.status === 404) status('That isn’t a product Find Fit lists. Choose one from Find Fit.', 'unknown');
    else status('This product couldn’t be loaded just now. Try again in a moment.', 'unavailable');
  }

  load();
  global.ProductPage = { openGuide };
})(typeof window !== 'undefined' ? window : globalThis);
