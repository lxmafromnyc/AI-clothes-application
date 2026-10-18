/* =========================================================
   Fynd — Find Fit's brand menu and product browser

   The home page starts here: choose a brand (UNIQLO first — only brands
   with a working way to pick a product are offered), browse its
   products as cards, and pick one. Each card opens the product's own
   page (product.html, assets/product-page.js) by its brand and code;
   the server looks the product up itself (api/_sizing/brands), so
   nothing the page holds is trusted for it.

   The products are the brand's real ones that Fynd has sourced, with
   the brand's own names and photos (or drawn artwork where no photo
   was verified), and each card says what Fynd holds for its sizing —
   never that a chart was read before it was. The list says how much of
   the brand's range it covers. When the list can't be fetched, it says
   so; when a filter matches nothing, it says that.

   Everything from the server is drawn as text; photos load with no
   referrer, from the brand's own image host only.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const root = doc && doc.getElementById('fit-browser');
  if (!root || !global.SizeChart) return;

  const $ = (id) => doc.getElementById(id);
  const { el } = global.SizeChart;
  const brandSelect = $('fit-brand');
  const grid = $('fit-products');
  const status = $('fit-browser-status');
  const coverage = $('fit-coverage');
  const search = $('fit-product-search');
  const filters = $('fit-product-filters');
  const planned = $('fit-brand-planned');

  const ART = {
    tshirts: '<path d="M22 13 11 18 7 27 15 31 18 27 18 53 46 53 46 27 49 31 57 27 53 18 42 13"/><path d="M22 13c3 5 17 5 20 0"/>',
    sweatshirts: '<path d="M22 13 8 20 5 33 13 37 17 30 17 50 47 50 47 30 51 37 59 33 56 20 42 13"/><path d="M22 13c4 5 16 5 20 0"/><path d="M17 50 17 55 47 55 47 50"/>',
    hoodies: '<path d="M22 15 8 21 5 34 13 38 17 31 17 51 47 51 47 31 51 38 59 34 56 21 42 15"/><path d="M22 15c0-6 4-9 10-9s10 3 10 9c-3 5-17 5-20 0"/><path d="M17 51 17 56 47 56 47 51"/>',
    knitwear: '<path d="M22 13 8 20 5 33 13 37 17 30 17 50 47 50 47 30 51 37 59 33 56 20 42 13"/><path d="M22 13c4 5 16 5 20 0"/><path d="M17 50 17 55 47 55 47 50"/><path d="M24 26 40 26M24 33 40 33M24 40 40 40"/>'
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  /* drawn artwork from fixed shapes only — nothing from the server */
  function art(category) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'silhouette');
    svg.setAttribute('viewBox', '0 0 64 64');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const shapes = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${ART[category] || ART.tshirts}</svg>`, 'image/svg+xml').documentElement;
    [...shapes.childNodes].forEach((n) => svg.append(doc.importNode(n, true)));
    return svg;
  }

  let brand = null;
  let products = [];
  let category = 'all';
  let line = 'all';
  let shownCount = 0;
  let asking = 0;
  const PAGE = 24;
  const groupOf = (p) => p.group || p.category;
  const more = $('fit-products-more');

  const IMAGE_HOSTS = /^https:\/\/image\.uniqlo\.com\//;

  /* a product opens its own page (product.html), as a shop's grid does */
  function card(p) {
    const b = el('a', 'fit-product');
    b.href = `product.html?${new URLSearchParams({ brand: brand.id, item: p.code })}`;
    b.dataset.code = p.code;
    const media = el('span', 'fit-product-media');
    if (p.imageUrl && IMAGE_HOSTS.test(p.imageUrl)) {
      const img = el('img');
      img.src = p.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.replaceWith(art(p.category)), { once: true });
      media.append(img);
    } else {
      media.append(art(p.category));
    }
    const text = el('span', 'fit-product-text');
    text.append(el('span', 'fit-product-kind', [p.categoryLabel, p.line === 'men' ? 'Men' : p.line === 'women' ? 'Women' : p.line === 'unisex' ? 'Unisex' : ''].filter(Boolean).join(' · ')),
      el('span', 'fit-product-name', p.name),
      el('span', `fit-product-holds fit-product-holds--${p.holds}`, p.holdsText));
    b.append(media, text);
    return b;
  }

  /* the products matching the filters, a page at a time */
  function draw(keep) {
    const words = search.value.trim().toLowerCase();
    const matching = products.filter((p) => (category === 'all' || groupOf(p) === category)
      && (line === 'all' || p.line === line || p.line === 'unisex')
      && (!words || p.name.toLowerCase().includes(words)));
    shownCount = keep ? Math.min(Math.max(shownCount, PAGE), matching.length) : Math.min(PAGE, matching.length);
    grid.replaceChildren(...matching.slice(0, shownCount).map(card));
    more.hidden = shownCount >= matching.length;
    more.textContent = `Show more (${matching.length - shownCount} more)`;
    root.dataset.matching = String(matching.length);
    if (!products.length) say('No products to show for this brand yet.');
    else if (!matching.length) say('No products match. Clear the search or choose another type.');
    else say(matching.length > shownCount ? `Showing ${shownCount} of ${matching.length}` : '', 'ready');
  }
  more.addEventListener('click', () => { shownCount += PAGE; draw(true); });

  function say(text, state) {
    status.textContent = text;
    status.hidden = !text;
    root.dataset.state = state || (text ? 'empty' : 'ready');
  }

  function drawFilters() {
    const kinds = [...new Map(products.map((p) => [groupOf(p), p.categoryLabel])).entries()];
    const lines = [...new Set(products.map((p) => p.line).filter((l) => l === 'men' || l === 'women'))];
    const chip = (group, value, label, set) => {
      const b = el('button', 'fit-filter', label);
      b.type = 'button';
      b.dataset.group = group;
      b.setAttribute('aria-pressed', String(value === 'all'));
      b.addEventListener('click', () => {
        set(value);
        filters.querySelectorAll(`.fit-filter[data-group="${group}"]`).forEach((f) => f.setAttribute('aria-pressed', String(f === b)));
        draw();
      });
      return b;
    };
    const setKind = (v) => { category = v; };
    const setLine = (v) => { line = v; };
    const kindRow = el('div', 'fit-filter-row');
    kindRow.setAttribute('role', 'group');
    kindRow.setAttribute('aria-label', 'Type of clothing');
    kindRow.append(chip('kind', 'all', 'All', setKind), ...kinds.map(([value, label]) => chip('kind', value, label, setKind)));
    const rows = [kindRow];
    if (lines.length > 1) {
      const lineRow = el('div', 'fit-filter-row');
      lineRow.setAttribute('role', 'group');
      lineRow.setAttribute('aria-label', 'Men or women');
      lineRow.append(chip('line', 'all', 'Everyone', setLine), ...lines.map((l) => chip('line', l, l === 'men' ? 'Men' : 'Women', setLine)));
      rows.push(lineRow);
    }
    filters.replaceChildren(...rows);
  }

  async function load(id) {
    const ask = ++asking;
    root.dataset.state = 'loading';
    grid.replaceChildren();
    filters.replaceChildren();
    coverage.textContent = '';
    say('Loading products…', 'loading');
    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await sizing.catalog(id) : { ok: false };
    if (ask !== asking) return;
    if (!(answer.ok && answer.data && Array.isArray(answer.data.products))) {
      products = [];
      say('This brand’s products couldn’t be loaded just now. Try again in a moment, or paste a product’s link below.', 'unavailable');
      return;
    }
    brand = answer.data.brand;
    products = answer.data.products;
    category = 'all';
    line = 'all';
    coverage.textContent = brand.coverage || '';
    drawFilters();
    draw();
  }

  async function start() {
    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await sizing.brands() : { ok: false };
    if (answer.ok && answer.data && Array.isArray(answer.data.brands) && answer.data.brands.length) {
      const current = brandSelect.value;
      brandSelect.replaceChildren(...answer.data.brands.map((b) => {
        const o = el('option', null, b.name);
        o.value = b.id;
        return o;
      }));
      brandSelect.value = answer.data.brands.some((b) => b.id === current) ? current : answer.data.brands[0].id;
      const later = (answer.data.planned || []).filter((name) => !answer.data.brands.some((b) => b.name === name));
      planned.textContent = later.length ? `${later.join(', ')} — coming later.` : '';
    }
    load(brandSelect.value);
  }

  brandSelect.addEventListener('change', () => load(brandSelect.value));
  search.addEventListener('input', () => draw());
  start();

  global.BrandBrowser = { load };
})(typeof window !== 'undefined' ? window : globalThis);
