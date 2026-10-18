/* =========================================================
   Fynd — one product's page

   product.html?brand=uniqlo&item=E475378-000[&colour=09&size=M]

   Laid out the way a shop lays out a product: photos, the product's
   name and facts, its colours, its sizes and — beside the sizes —
   Fynd's Size Guide, which opens the product's real chart (the server's
   own lookup, Account.sizing.item; drawn by assets/size-chart.js) in a
   dialog, with what a saved fit profile can say about it
   (assets/fit-compare.js). The chosen colour and size stay in the
   address and are carried into the Size Guide, where the chosen size's
   row is marked.

   Everything shown is what Fynd holds for the product
   (Account.sizing.detail; api/_sizing/brands): photos only from the
   brand's image host, sizes, fabric and fit only from Fynd's record,
   each with its source. What Fynd doesn't hold — price, description,
   care, reviews, stock — is said in its place, and the retailer's own
   page is one click away. Nothing is filled in to complete the layout.
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
    if (!url || !IMAGE_HOST.test(url)) return null;
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
    thumbs.replaceChildren(...urls.filter((u) => IMAGE_HOST.test(u.url)).map((u) => {
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
    $('pdp-photo-note').textContent = product.imagesFrom ? `Photos from ${product.imagesFrom}.` : 'Fynd holds no photo of this product.';
  }

  function chooseColour(c, quiet) {
    colour = c;
    $('pdp-colour-name').textContent = c ? c.label : '—';
    $('pdp-colours').querySelectorAll('.pdp-swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.code === (c && c.code))));
    if (c) showImage(c.image, `${product.name}, ${c.label}`);
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
    $('pdp-colours-note').textContent = product.coloursNote;
  }

  function chooseSize(s, quiet) {
    size = s;
    $('pdp-size-name').textContent = s || 'Choose a size';
    $('pdp-sizes').querySelectorAll('.pdp-size').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.size === s)));
    if (!quiet) remember();
  }

  function drawSizes() {
    const box = $('pdp-sizes');
    if (!product.sizes) {
      box.replaceChildren();
      $('pdp-sizes-note').textContent = 'Fynd doesn’t hold this product’s size list — it’s on UNIQLO’s page. The Size Guide shows what Fynd does hold.';
      return;
    }
    box.replaceChildren(...product.sizes.list.map((s) => {
      const b = el('button', 'pdp-size', s);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.size = s;
      b.addEventListener('click', () => chooseSize(s));
      return b;
    }));
    $('pdp-sizes-note').textContent = `Sizes from ${product.sizes.source}. Fynd doesn’t know which sizes are in stock.`;
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
    const retailer = el('a', 'guide-link', 'Read it on UNIQLO');
    retailer.href = product.url;
    retailer.target = '_blank';
    retailer.rel = 'noopener noreferrer';
    const describe = p('Fynd doesn’t hold UNIQLO’s description or feature list for this product. ');
    describe.append(retailer);

    const fitNodes = [];
    if (product.fit) fitNodes.push(sourced(`Fit: ${product.fit.words}`, product.fit.source));
    fitNodes.push(p(product.holdsText ? `${product.holdsText}.` : ''));
    const guide = el('button', 'btn btn-secondary pdp-section-guide', 'Open the Size Guide');
    guide.type = 'button';
    guide.addEventListener('click', openGuide);
    fitNodes.push(guide);

    const materials = [];
    if (product.material) materials.push(sourced(product.material.text, product.material.source));
    else materials.push(p('Fynd doesn’t hold this product’s fabric composition.'));
    materials.push(p('Care instructions aren’t held by Fynd — they’re on UNIQLO’s page.'));

    const about = [
      p(`Product ID ${product.code.slice(1, 7)} (${product.code}), UNIQLO ${product.market}.`),
      p(product.recordedAt ? `Sizes, fabric and fit are from Fynd’s saved record, copied from UNIQLO’s page on ${product.recordedAt} — not read live.` : 'Fynd has no saved record of this product’s details; only its listing and photos.'),
      p(`Not held by Fynd: ${product.missing.join(', ')}.`)
    ];

    $('pdp-sections').replaceChildren(
      section('Description & features', [describe], true),
      section('Materials & care', materials),
      section('Fit & sizing', fitNodes),
      section('Availability & shipping', [p('Fynd doesn’t hold stock, delivery or returns information for this product. UNIQLO’s page has them.')]),
      section('About this information', about)
    );
  }

  function draw() {
    const retailerName = RETAILERS[brandId] || product.brand;
    doc.title = `${product.brand} ${product.name} — Fynd`;
    $('pdp-crumb-brand').textContent = retailerName;
    $('pdp-crumb-category').textContent = product.categoryLabel || '';
    $('pdp-brand').textContent = product.brand;
    $('pdp-name').textContent = product.name;
    $('pdp-meta').textContent = [`Product ID ${product.code.slice(1, 7)}`, product.categoryLabel, LINES[product.line]].filter(Boolean).join(' · ');
    $('pdp-price').textContent = 'Price isn’t held by Fynd — see it on UNIQLO.';
    $('pdp-holds').textContent = product.holdsText ? `Size Guide — ${product.holdsText}.` : '';
    const link = $('pdp-retailer');
    link.href = product.url;
    link.textContent = `View on ${retailerName}`;
    drawGallery();
    drawColours();
    drawSizes();
    drawSections();
    const wantColour = params.get('colour');
    chooseColour(product.colours.find((c) => c.code === wantColour) || product.colours.find((c) => c.code === product.defaultColour) || product.colours[0] || null, true);
    const wantSize = params.get('size');
    if (product.sizes && product.sizes.list.includes(wantSize)) chooseSize(wantSize, true);
    $('pdp-grid').hidden = false;
    status('', 'ready');
  }

  /* ---------- the Size Guide ---------- */

  function selectedLine() {
    const bits = [];
    if (colour) bits.push(colour.label);
    bits.push(size ? `Size ${size}` : 'No size chosen yet');
    return `Selected: ${bits.join(' · ')}`;
  }

  /* the chosen size's row, marked in every table that has it */
  function markSize(body) {
    if (!size) return;
    body.querySelectorAll('tbody tr').forEach((tr) => {
      const th = tr.querySelector('th');
      const on = Boolean(th && th.textContent.trim() === size);
      tr.classList.toggle('is-chosen', on);
      if (on) tr.setAttribute('aria-current', 'true');
      else tr.removeAttribute('aria-current');
    });
  }

  async function openGuide() {
    const dialog = $('pdp-guide');
    const body = $('pdp-guide-body');
    const compare = $('pdp-guide-compare');
    $('pdp-guide-product').textContent = `${product.brand} · ${product.name}`;
    $('pdp-guide-selected').textContent = selectedLine();
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
    body.replaceChildren(...render(chart, product.url, { linked: false }));
    markSize(body);
    if ((chart.status === 'ok' || chart.status === 'fallback') && global.FitCompare) {
      global.FitCompare.show(chart, compare, () => dialog.open);
    } else {
      compare.hidden = true;
    }
  }

  $('pdp-size-guide').addEventListener('click', openGuide);
  $('pdp-guide-close').addEventListener('click', () => $('pdp-guide').close());
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
