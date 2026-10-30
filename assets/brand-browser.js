/* =========================================================
   Fynd — Find Fit's brand menu and product browser

   The home page starts here: choose a brand (UNIQLO first — only brands
   with a working way to pick a product are offered), and its products
   open in a popup over the page (a modal <dialog>: Escape, the close
   button or a click outside closes it, and focus goes back to the brand
   chosen). Browse them as cards, and pick one: on Find Fit, picking a
   card makes it the item to compare (FindFit.select, assets/find-fit.js)
   and closes the popup. Each card is still a link to the product's own
   page (product.html, assets/product-page.js) by its brand and code, so
   opening it in a new tab still works; the server looks the product up
   itself (api/_sizing/brands), so nothing the page holds is trusted for
   it.

   The products are the brand's real ones that Fynd has sourced — and,
   once one is connected, its authorized catalogue — with the brand's
   own names and photos (or drawn artwork where no photo was verified),
   and each card says what Fynd holds for its sizing — never that a
   chart was read before it was. Four facts are kept apart on every
   card, from the server's own `status`: whether the product is in an
   authorized catalogue, whether Fynd holds a sizing chart for it,
   whether that chart's garment measurements are verified, and whether
   it can be compared at all — so being listed is never read as being
   sized. The list says how much of the brand's
   range it covers, and while that is only a few products, says so
   above the list.

   Searching and filtering are the server's (api/_catalog/search.js):
   what is typed is sent once typing pauses, and one page of matches
   comes back; "Show more" asks for the next page. Filters — type, who
   it's for, colour, size, in stock — and the orders it can be sorted in
   (price only while prices are current) are offered only where the data
   has them. Only the newest
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
  const brandList = $('fit-brands');
  const dialog = $('fit-brand-dialog');
  const dialogTitle = $('fit-brand-dialog-title');
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

  /* the brand chosen, and the brand whose products the popup holds */
  let current = 'uniqlo';
  let loadedFor = null;
  let opener = null;
  let brand = null;
  let items = [];
  let total = 0;
  let listed = 0;
  let facets = null;
  let category = 'all';
  let line = 'all';
  let colour = 'all';
  let size = 'all';
  let inStock = false;
  let sort = 'featured';
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
  const count = $('fit-browser-count');
  /* each fact the server states about a product, in words; `yes`, `part`
     and `no` say how far it goes. Nothing unknown is drawn as known. */
  const FACTS = [
    ['catalogue', { authorized: ['yes', 'In UNIQLO’s catalogue'], 'fynd-list': ['no', 'Not from a catalogue feed'] }],
    ['chart', { own: ['yes', 'Sizing chart'], general: ['part', 'General chart only'], none: ['no', 'No sizing chart saved'] }],
    ['garment', { verified: ['yes', 'Garment measurements verified'], unverified: ['part', 'Garment measurements not verified'], none: ['no', 'No garment measurements'] }],
    ['comparable', { true: ['yes', 'Can be compared'], false: ['no', 'Can’t be compared yet'] }]
  ];
  function facts(status) {
    const box = el('span', 'fit-product-facts');
    if (!status || typeof status !== 'object') return box;
    FACTS.forEach(([fact, words]) => {
      const said = words[String(status[fact])];
      if (!said) return;
      const f = el('span', `fit-product-fact fit-product-fact--${said[0]}`, said[1]);
      f.dataset.fact = fact;
      f.dataset.value = String(status[fact]);
      box.append(f);
    });
    return box;
  }

  function money(price) {
    if (!price || !Number.isInteger(price.amount) || !/^[A-Z]{3}$/.test(price.currency || '')) return '';
    const f = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: price.currency }).format(n / 100);
    return `${price.varies ? 'From ' : ''}${f(price.amount)}${Number.isInteger(price.was) && price.was > price.amount ? ` (was ${f(price.was)})` : ''}`;
  }

  /* a product is a link to its own page (product.html), as a shop's grid
     is; a plain click on Find Fit makes it the item to compare instead */
  function card(p) {
    const b = el('a', 'fit-product');
    b.href = `product.html?${new URLSearchParams({ brand: brand.id, item: p.code })}`;
    b.dataset.code = p.code;
    if (p.status && typeof p.status === 'object') b.dataset.comparable = String(p.status.comparable === true);
    const chosenBrand = brand;
    b.addEventListener('click', (event) => {
      if (!global.FindFit || typeof global.FindFit.select !== 'function') return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      close();
      global.FindFit.select(chosenBrand, p);
    });
    const media = el('span', 'fit-product-media');
    if (p.imageUrl && IMAGE_HOSTS.test(p.imageUrl)) {
      const img = el('img');
      img.src = p.imageUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { media.dataset.image = 'failed'; img.replaceWith(art(p.category)); }, { once: true });
      media.dataset.image = 'photo';
      media.append(img);
    } else {
      /* no photo from UNIQLO's image host: drawn artwork, never another photo */
      media.dataset.image = 'none';
      media.append(art(p.category));
    }
    const text = el('span', 'fit-product-text');
    text.append(el('span', 'fit-product-kind', [p.kindLabel || p.categoryLabel, LINE_LABELS[p.line] || ''].filter(Boolean).join(' · ')),
      el('span', 'fit-product-name', p.name));
    const price = money(p.price);
    if (price) text.append(el('span', 'fit-product-price', price));
    /* the size labels it is sold in — not measurements */
    const range = p.sizeRange;
    if (range && typeof range.first === 'string' && typeof range.last === 'string') {
      text.append(el('span', 'fit-product-sizes', range.count > 1 && range.first !== range.last ? `Sizes ${range.first}–${range.last}` : `Size ${range.first}`));
    }
    if (p.availability === 'out_of_stock') text.append(el('span', 'fit-product-stock', 'Out of stock'));
    text.append(el('span', `fit-product-holds fit-product-holds--${p.holds}`, p.holdsText), facts(p.status),
      el('span', 'fit-product-code', `Product ID ${p.code}`));
    b.append(media, text);
    return b;
  }

  function say(text, state) {
    status.textContent = text;
    status.hidden = !text;
    root.dataset.state = state || (text ? 'empty' : 'ready');
    dialog.dataset.state = root.dataset.state;
  }

  const quote = (words) => words.map((w) => `“${w}”`).join(', ');

  /* what came back, drawn: the cards, how many there are, and why */
  function draw(answer) {
    grid.replaceChildren(...items.map(card));
    more.hidden = items.length >= total;
    more.disabled = false;
    more.textContent = `Show more (${total - items.length} more)`;
    root.dataset.matching = String(total);
    root.dataset.listed = String(listed);
    /* how many came back, of how many match, of how many are listed */
    count.textContent = listed
      ? `${items.length} shown · ${total} matching · ${listed} listed in all`
      : '';
    root.dataset.query = answer.query ? answer.query.q : '';
    const filtered = category !== 'all' || line !== 'all' || colour !== 'all' || size !== 'all' || inStock || Boolean(answer.query && answer.query.q);
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
    /* a group, then the narrower types the server names inside it
       (Hoodies apart from Sweatshirts) */
    const setKind = (v) => { category = v; };
    kindRow.append(chip('kind', 'all', 'All', setKind), ...kinds.flatMap((k) => [chip('kind', k.value, k.label, setKind)]
      .concat((Array.isArray(k.kinds) && k.kinds.length > 1 ? k.kinds : []).map((sub) => chip('kind', sub.value, sub.label, setKind)))));
    const rows = [kindRow];
    if (lines.length > 1) {
      const lineRow = el('div', 'fit-filter-row');
      lineRow.setAttribute('role', 'group');
      lineRow.setAttribute('aria-label', 'Who it’s for');
      lineRow.append(chip('line', 'all', 'Everyone', (v) => { line = v; }), ...lines.map((l) => chip('line', l, LINE_LABELS[l], (v) => { line = v; })));
      rows.push(lineRow);
    }
    /* colour and size only where the data has them: a catalogue's colour
       names and size labels, or Fynd's records' sizes */
    const row = (label, group, values, set, name) => {
      const r = el('div', 'fit-filter-row');
      r.setAttribute('role', 'group');
      r.setAttribute('aria-label', label);
      r.append(chip(group, 'all', 'Any', set), ...values.map((v) => chip(group, v, name(v), set)));
      return r;
    };
    const colours = ((facets && facets.colours) || []).map((c) => c.value);
    const sizes = ((facets && facets.sizes) || []).map((c) => c.value);
    if (colours.length > 1) rows.push(row('Colour', 'colour', colours, (v) => { colour = v; }, (v) => v[0].toUpperCase() + v.slice(1)));
    if (sizes.length > 1) rows.push(row('Size', 'size', sizes, (v) => { size = v; }, (v) => v));
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
    /* the orders the server offers for this data: price only while
       prices are current */
    const sorts = ((facets && facets.sorts) || []).filter((v) => SORT_LABELS[v]);
    if (sorts.length > 1) {
      const r = el('div', 'fit-filter-row fit-sort-row');
      const label = el('label', 'fit-sort-label', 'Sort by');
      label.htmlFor = 'fit-product-sort';
      const select = el('select', 'profile-input fit-sort');
      select.id = 'fit-product-sort';
      sorts.forEach((v) => { const o = el('option', null, SORT_LABELS[v]); o.value = v; select.append(o); });
      select.value = sort;
      select.addEventListener('change', () => { sort = select.value; ask(false); });
      r.append(label, select);
      rows.push(r);
    }
    filters.replaceChildren(...rows);
  }
  const SORT_LABELS = { featured: 'Featured', name: 'Name: A–Z', 'price-asc': 'Price: low to high', 'price-desc': 'Price: high to low' };

  /* one page from the server: the first for a new search, or the next */
  async function ask(append) {
    const mine = ++asking;
    clearTimeout(typing);
    const sizing = global.Account && global.Account.sizing;
    if (append) { more.disabled = true; } else { root.dataset.state = 'loading'; dialog.dataset.state = 'loading'; }
    const query = { q: search.value.trim(), category, line, colour, size, inStock, sort: sort === 'featured' ? 'all' : sort, offset: append ? items.length : 0 };
    const answer = sizing ? await sizing.catalog(current, query) : { ok: false };
    if (mine !== asking) return;
    if (!(answer.ok && answer.data && Array.isArray(answer.data.products) && answer.data.brand)) {
      if (append) {
        more.disabled = false;
        say('More products couldn’t be loaded just now. Try “Show more” again in a moment.', 'ready');
        return done();
      }
      items = [];
      total = 0;
      listed = 0;
      count.textContent = '';
      grid.replaceChildren();
      more.hidden = true;
      loadedFor = null;
      say('This brand’s products couldn’t be loaded just now. Try again in a moment, or close this and paste a product’s link instead.', 'unavailable');
      return done();
    }
    const data = answer.data;
    brand = data.brand;
    dialogTitle.textContent = brand.name;
    total = Number.isInteger(data.total) ? data.total : data.products.length;
    listed = Number.isInteger(data.listed) ? data.listed : 0;
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
    loadedFor = current;
    brand = null;
    facets = null;
    items = [];
    total = 0;
    listed = 0;
    count.textContent = '';
    category = 'all';
    line = 'all';
    colour = 'all';
    size = 'all';
    inStock = false;
    sort = 'featured';
    grid.replaceChildren();
    filters.replaceChildren();
    coverage.textContent = '';
    note.hidden = true;
    say('Loading products…', 'loading');
    await ask(false);
  }

  /* the popup, for one brand: its products are asked for the first time
     it opens (or when another brand is chosen), and kept while it's
     closed, with the search and filters as they were */
  function open(id, from) {
    if (id) current = id;
    opener = from || null;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    }
    if (loadedFor !== current) { search.value = ''; load(); }
    search.focus();
  }
  function close() {
    if (typeof dialog.close === 'function') dialog.close(); else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
  }
  dialog.addEventListener('close', () => { if (opener && doc.contains(opener)) opener.focus(); });
  $('fit-brand-dialog-close').addEventListener('click', close);
  /* a click on the backdrop — the dialog itself, outside its content — closes it */
  dialog.addEventListener('click', (event) => { if (event.target === dialog) close(); });

  function brandButton(b) {
    const button = el('button', 'fit-brand-choice');
    button.type = 'button';
    button.dataset.brand = b.id;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', 'fit-brand-dialog');
    button.append(el('span', 'fit-brand-name', b.name),
      el('span', 'fit-brand-meta', Number.isInteger(b.count) ? `${b.count} product${b.count === 1 ? '' : 's'} · Browse` : 'Browse products'));
    return button;
  }
  brandList.addEventListener('click', (event) => {
    const button = event.target.closest('.fit-brand-choice');
    if (button && brandList.contains(button)) open(button.dataset.brand, button);
  });

  /* the brands the server offers; until it answers (or if it can't), the
     UNIQLO button in the page opens the popup all the same */
  async function start() {
    const sizing = global.Account && global.Account.sizing;
    const answer = sizing ? await sizing.brands() : { ok: false };
    if (answer.ok && answer.data && Array.isArray(answer.data.brands) && answer.data.brands.length) {
      brandList.replaceChildren(...answer.data.brands.map(brandButton));
      if (!answer.data.brands.some((b) => b.id === current)) current = answer.data.brands[0].id;
      const later = (answer.data.planned || []).filter((name) => !answer.data.brands.some((b) => b.name === name));
      planned.textContent = later.length ? `${later.join(', ')} — coming later.` : '';
    }
    root.dataset.brands = 'ready';
  }

  /* Fynd's own list, filtered on the server once typing pauses (free: no
     product source is asked); Enter sends it at once */
  search.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => ask(false), 220); });
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); ask(false); } });
  start();

  global.BrandBrowser = { load, open, close, facts };
})(typeof window !== 'undefined' ? window : globalThis);
