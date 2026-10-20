/* =========================================================
   Fynd — Find Fit's brand menu and product browser

   The home page starts here: choose a brand (UNIQLO first — only brands
   with a working way to pick a product are offered), browse its
   products as cards, and pick one. Each card opens the product's own
   page (product.html, assets/product-page.js) by its brand and code;
   the server looks the product up itself (api/_sizing/brands), so
   nothing the page holds is trusted for it.

   The products are the brand's real ones that Fynd has sourced — and,
   once one is connected, its authorized catalogue — with the brand's
   own names and photos (or drawn artwork where no photo was verified),
   and each card says what Fynd holds for its sizing — never that a
   chart was read before it was. The list says how much of the brand's
   range it covers, and while that is only a few products, says so
   above the list.

   Searching and filtering are the server's (api/_catalog/search.js):
   what is typed is sent once typing pauses, and one page of matches
   comes back; "Show more" asks for the next page. Only the newest
   answer is drawn. When no product matches every word typed, the
   closest are shown and the words nothing matched are named. When the
   list can't be fetched, it says so; when nothing matches, it says that.

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
  let items = [];
  let total = 0;
  let facets = null;
  let category = 'all';
  let line = 'all';
  let inStock = false;
  let asking = 0;
  let typing = null;
  /* how many answers have been drawn, so a test (or anyone) can tell the
     newest one has arrived */
  let answered = 0;
  const done = () => { root.dataset.answers = String(answered += 1); };
  const more = $('fit-products-more');
  const note = $('fit-catalog-note');

  const IMAGE_HOSTS = /^https:\/\/image\.uniqlo\.com\//;
  const LINE_LABELS = { men: 'Men', women: 'Women', unisex: 'Unisex', kids: 'Kids', baby: 'Baby' };

  function money(price) {
    if (!price || !Number.isInteger(price.amount) || !/^[A-Z]{3}$/.test(price.currency || '')) return '';
    const f = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency }).format(n / 100);
    return `${price.varies ? 'From ' : ''}${f(price.amount)}${Number.isInteger(price.was) && price.was > price.amount ? ` (was ${f(price.was)})` : ''}`;
  }

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
    text.append(el('span', 'fit-product-kind', [p.categoryLabel, LINE_LABELS[p.line] || ''].filter(Boolean).join(' · ')),
      el('span', 'fit-product-name', p.name));
    const price = money(p.price);
    if (price) text.append(el('span', 'fit-product-price', price));
    if (p.availability === 'out_of_stock') text.append(el('span', 'fit-product-stock', 'Out of stock'));
    text.append(el('span', `fit-product-holds fit-product-holds--${p.holds}`, p.holdsText));
    b.append(media, text);
    return b;
  }

  function say(text, state) {
    status.textContent = text;
    status.hidden = !text;
    root.dataset.state = state || (text ? 'empty' : 'ready');
  }

  const quote = (words) => words.map((w) => `“${w}”`).join(', ');

  /* what came back, drawn: the cards, how many there are, and why */
  function draw(answer) {
    grid.replaceChildren(...items.map(card));
    more.hidden = items.length >= total;
    more.disabled = false;
    more.textContent = `Show more (${total - items.length} more)`;
    root.dataset.matching = String(total);
    root.dataset.query = answer.query ? answer.query.q : '';
    const filtered = category !== 'all' || line !== 'all' || inStock || Boolean(answer.query && answer.query.q);
    if (!total && !filtered) return say('No products to show for this brand yet.');
    if (!total) {
      return say(answer.unmatched && answer.unmatched.length && answer.query && answer.query.q
        ? `No products match. Nothing here matched ${quote(answer.unmatched)}. Clear the search or choose another type.`
        : 'No products match. Clear the search or choose another type.');
    }
    const parts = [];
    if (answer.partial) {
      parts.push(answer.unmatched && answer.unmatched.length
        ? `No product here matches every word — nothing matched ${quote(answer.unmatched)}, so the closest matches are shown.`
        : 'No product here matches every word, so the closest matches are shown.');
    }
    if (total > items.length) parts.push(`Showing ${items.length} of ${total}`);
    say(parts.join(' '), 'ready');
  }

  /* the filters, from the whole catalogue's choices: they stay put as a
     search narrows */
  function drawFilters() {
    const chip = (group, value, label, set) => {
      const b = el('button', 'fit-filter', label);
      b.type = 'button';
      b.dataset.group = group;
      b.dataset.value = value;
      b.setAttribute('aria-pressed', String(value === 'all'));
      b.addEventListener('click', () => {
        set(value);
        filters.querySelectorAll(`.fit-filter[data-group="${group}"]`).forEach((f) => f.setAttribute('aria-pressed', String(f === b)));
        ask(false);
      });
      return b;
    };
    const kinds = (facets && facets.categories) || [];
    const lines = ((facets && facets.lines) || []).map((l) => l.value).filter((l) => l !== 'unisex' && LINE_LABELS[l]);
    const kindRow = el('div', 'fit-filter-row');
    kindRow.setAttribute('role', 'group');
    kindRow.setAttribute('aria-label', 'Type of clothing');
    kindRow.append(chip('kind', 'all', 'All', (v) => { category = v; }), ...kinds.map((k) => chip('kind', k.value, k.label, (v) => { category = v; })));
    const rows = [kindRow];
    if (lines.length > 1) {
      const lineRow = el('div', 'fit-filter-row');
      lineRow.setAttribute('role', 'group');
      lineRow.setAttribute('aria-label', 'Who it’s for');
      lineRow.append(chip('line', 'all', 'Everyone', (v) => { line = v; }), ...lines.map((l) => chip('line', l, LINE_LABELS[l], (v) => { line = v; })));
      rows.push(lineRow);
    }
    if (facets && facets.inStock) {
      const stockRow = el('div', 'fit-filter-row');
      const b = el('button', 'fit-filter', 'In stock only');
      b.type = 'button';
      b.dataset.group = 'stock';
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => { inStock = !inStock; b.setAttribute('aria-pressed', String(inStock)); ask(false); });
      stockRow.append(b);
      rows.push(stockRow);
    }
    filters.replaceChildren(...rows);
  }

  /* one page from the server: the first for a new search, or the next */
  async function ask(append) {
    const mine = ++asking;
    clearTimeout(typing);
    const sizing = global.Account && global.Account.sizing;
    if (append) { more.disabled = true; } else { root.dataset.state = 'loading'; }
    const query = { q: search.value.trim(), category, line, inStock, offset: append ? items.length : 0 };
    const answer = sizing ? await sizing.catalog(brandSelect.value, query) : { ok: false };
    if (mine !== asking) return;
    if (!(answer.ok && answer.data && Array.isArray(answer.data.products) && answer.data.brand)) {
      if (append) {
        more.disabled = false;
        say('More products couldn’t be loaded just now. Try “Show more” again in a moment.', 'ready');
        return done();
      }
      items = [];
      total = 0;
      grid.replaceChildren();
      more.hidden = true;
      say('This brand’s products couldn’t be loaded just now. Try again in a moment, or paste a product’s link below.', 'unavailable');
      return done();
    }
    const data = answer.data;
    brand = data.brand;
    total = Number.isInteger(data.total) ? data.total : data.products.length;
    items = append ? items.concat(data.products) : data.products;
    coverage.textContent = brand.coverage || '';
    note.textContent = brand.notice || '';
    note.hidden = !brand.notice;
    if (!facets) { facets = data.facets || null; drawFilters(); }
    draw(data);
    done();
  }

  more.addEventListener('click', () => ask(true));

  async function load() {
    asking += 1;
    brand = null;
    facets = null;
    items = [];
    total = 0;
    category = 'all';
    line = 'all';
    inStock = false;
    grid.replaceChildren();
    filters.replaceChildren();
    coverage.textContent = '';
    note.hidden = true;
    say('Loading products…', 'loading');
    await ask(false);
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
    load();
  }

  brandSelect.addEventListener('change', () => load());
  /* sent once typing pauses; Enter sends it at once */
  search.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => ask(false), 220); });
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); ask(false); } });
  start();

  global.BrandBrowser = { load };
})(typeof window !== 'undefined' ? window : globalThis);
