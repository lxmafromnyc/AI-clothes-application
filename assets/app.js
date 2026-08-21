/* =========================================================
   FindWear — rendering and page behaviour

   Reads the canonical product shape from assets/products.js and nothing
   else. Swapping the data source changes what appears; it does not change
   this file.
   ========================================================= */

/* ---------- artwork ----------
   Used when a product has no usable photo. Colour families and garment
   kinds a feed may not know about fall back to a neutral tile and a
   generic garment, so unfamiliar data still renders. */

const COLORS = {
  Neutral: { dot: '#D7C9B6', from: '#F0E9DF', to: '#CDBCA6', dark: false },
  Black: { dot: '#1E1E22', from: '#33333A', to: '#121216', dark: true },
  White: { dot: '#F5F4F1', from: '#FFFFFF', to: '#E6E4DE', dark: false },
  Blue: { dot: '#5B7FB9', from: '#D3E0F4', to: '#5B7FB9', dark: true },
  Green: { dot: '#6F8F70', from: '#DCE7D8', to: '#6F8F70', dark: true },
  Earth: { dot: '#A97B54', from: '#EFD9C4', to: '#A97B54', dark: true },
  Pastel: { dot: '#E4C6E6', from: '#FBE6EE', to: '#D9C6F0', dark: false },
  Bright: { dot: '#EF6F5B', from: '#FFD98A', to: '#EF6F5B', dark: true }
};

const SILHOUETTES = {
  tee: '<path d="M22 12 L12 17 L8 25 L15 29 L18 26 L18 54 L46 54 L46 26 L49 29 L56 25 L52 17 L42 12 C40 17 24 17 22 12 Z"/>',
  shirt: '<path d="M23 12 L13 17 L8 26 L15 30 L18 27 L18 55 L46 55 L46 27 L49 30 L56 26 L51 17 L41 12 L32 20 Z"/><path d="M31 21 h2 v34 h-2 z" opacity=".45"/>',
  knit: '<path d="M21 12 L8 18 L4 32 L12 36 L17 29 L17 51 L47 51 L47 29 L52 36 L60 32 L56 18 L43 12 C41 18 23 18 21 12 Z"/><path d="M17 51 h30 v5 h-30 z" opacity=".5"/>',
  jacket: '<path d="M23 11 L11 17 L6 28 L13 32 L16 28 L16 56 L30 56 L30 22 Z"/><path d="M41 11 L53 17 L58 28 L51 32 L48 28 L48 56 L34 56 L34 22 Z"/>',
  coat: '<path d="M23 9 L10 16 L5 31 L13 35 L16 29 L16 60 L48 60 L48 29 L51 35 L59 31 L54 16 L41 9 L32 20 Z"/><path d="M16 36 h32 v4 h-32 z" opacity=".45"/>',
  dress: '<path d="M24 11 L15 16 L19 26 L22 24 L12 57 L52 57 L42 24 L45 26 L49 16 L40 11 C38 17 26 17 24 11 Z"/>',
  trousers: '<path d="M17 9 h30 l2 48 h-13 l-4 -30 l-4 30 h-13 z"/>',
  skirt: '<path d="M20 14 h24 l9 38 h-42 z"/>',
  shorts: '<path d="M17 11 h30 l2 26 h-13 l-4 -14 l-4 14 h-13 z"/>',
  sneaker: '<path d="M9 44 L9 39 L20 35 L28 28 L33 28 L38 37 L46 39 L54 42 L54 47 L9 47 Z"/><path d="M7 47 h50 v5 h-50 z" opacity=".5"/>'
};

const FALLBACK_COLOR = { dot: '#C9C6C0', from: '#EFEDE9', to: '#CFCBC4', dark: false };

const colorOf = (item) => COLORS[(item.colors && item.colors[0]) || ''] || FALLBACK_COLOR;
const shapeOf = (item) => SILHOUETTES[item.category] || SILHOUETTES.tee;

/* ---------- rendering ----------
   Every card is built from the canonical fields only, so the same code
   renders three products or three thousand. */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SPARK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"/></svg>';
const EXTERNAL = '<svg class="ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

function artSvg(item) {
  const c = colorOf(item);
  const ink = c.dark ? 'rgba(255,255,255,.44)' : 'rgba(22,23,28,.26)';
  return `<svg class="silhouette" viewBox="0 0 64 64" fill="${ink}" aria-hidden="true">${shapeOf(item)}</svg>`;
}

/* photo when the product has one, drawn artwork otherwise. The gradient
   sits on the container either way, so replacing a failed photo with
   artwork needs no style changes. */
function media(item, cls, badge) {
  const c = colorOf(item);
  const inner = item.imageUrl
    ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" loading="lazy" decoding="async" data-fallback="${esc(item.id)}">`
    : artSvg(item);
  return `<div class="${cls}" style="background:linear-gradient(150deg, ${c.from}, ${c.to})">${inner}${badge || ''}</div>`;
}

/* a dead image URL leaves drawn artwork in its place rather than a broken
   image icon, so a feed carrying stale photo links still renders */
function bindImageFallback(root) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      const item = Products.byId(img.dataset.fallback);
      if (item) img.outerHTML = artSvg(item);
    }, { once: true });
  });
}

/* A product with no productUrl is not a real listing. It is marked on the
   card itself so a sample row can never read as something you can buy. */
/* Money keeps its cents: 72.5 from a source must read $72.50, not $72.5.
   Whole amounts stay whole, matching how the catalogue rows read. */
function formatPrice(value) {
  if (value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
}

const SAMPLE_BADGE = '<span class="item-badge item-badge--sample">Sample</span>';

/* Shown once above any grid that contains placeholder rows. */
const SAMPLE_NOTE = 'Items marked <strong>Sample</strong> are placeholder data for the demo, not real listings.';
const sampleNote = (items) => (items.some((i) => !i.productUrl)
  ? `<p class="sample-note">${SAMPLE_NOTE}</p>` : '');

function productCard(item, index, badge, extra) {
  const linked = Boolean(item.productUrl);
  const tag = linked ? 'a' : 'article';
  const attrs = linked ? ` href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer"` : '';
  /* provider records carry colors and sizes; catalogue rows carry fits.
     Read both defensively so either shape renders. */
  const tags = [(item.colors || [])[0], (item.fits || [])[0] || (item.sizes || []).join(' / ')].filter(Boolean)
    .map((t) => `<span>${esc(t)}</span>`).join('');
  return `<${tag} class="item-card" style="--i:${index}"${attrs}>
    ${media(item, 'item-media', (badge || '') + (linked ? '' : SAMPLE_BADGE))}
    <div class="item-body">
      <p class="item-brand">${esc(item.brand)}${linked ? EXTERNAL : ''}</p>
      <h3 class="item-name">${esc(item.name)}</h3>
      <div class="item-row">
        <span class="item-price">${formatPrice(item.price)}</span>
        <div class="item-tags">${tags}</div>
      </div>
      ${extra || ''}
    </div>
  </${tag}>`;
}

const resultCard = (item, index) => productCard(item, index,
  `<span class="item-badge">${item.score}% match</span>`,
  `<p class="item-why">${SPARK}<span>${esc(item.why)}</span></p>`);

/* A verified record from the product source. The badge names the retailer
   rather than a match percentage: FindWear did not score these, the source
   returned them for the request, and showing a made-up score would be
   inventing information about a real product. */
const providerCard = (item, index) => productCard(item, index,
  `<span class="item-badge">${esc(item.retailer)}</span>`);

const browseCard = (item, index) => productCard(item, index,
  item.styles[0] ? `<span class="item-badge">${esc(item.styles[0])}</span>` : '');

/* ---------- filter controls ----------
   Built from the values present in the data, so a new source brings its
   own styles, colours and brands without any markup changes. Known values
   keep a deliberate order; anything unfamiliar is appended alphabetically. */

const FACET_ORDER = {
  styles: ['Minimal', 'Classic', 'Streetwear', 'Sporty', 'Bohemian', 'Bold'],
  colors: ['Neutral', 'Black', 'White', 'Blue', 'Green', 'Earth', 'Pastel', 'Bright'],
  occasions: ['Everyday', 'Work', 'Evening', 'Weekend', 'Active'],
  fits: ['Slim', 'Regular', 'Relaxed', 'Oversized']
};

function orderFacet(counts, key) {
  const preferred = FACET_ORDER[key] || [];
  const present = [...counts.keys()];
  const known = preferred.filter((v) => counts.has(v));
  const rest = present.filter((v) => !preferred.includes(v)).sort((a, b) => a.localeCompare(b));
  return known.concat(rest);
}

/* ---------- mobile navigation ---------- */
(function nav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
    links.classList.toggle('open', !open);
  });

  document.addEventListener('click', (e) => {
    if (!links.classList.contains('open')) return;
    if (e.target.closest('.nav')) return;
    links.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  });
})();

/* ---------- reveal sections on scroll ---------- */
(function reveal() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: .12 });

  items.forEach((el) => io.observe(el));
})();

/* ---------- home: preview panel ---------- */
(function heroPanel() {
  const list = document.getElementById('hero-picks');
  if (!list || typeof Products === 'undefined') return;

  Products.subscribe(() => {
    const picks = (typeof HERO_PICKS === 'undefined' ? [] : HERO_PICKS)
      .map(({ id, score }) => ({ item: Products.byId(id), score }))
      .filter((p) => p.item);

    list.innerHTML = picks.map(({ item, score }) => {
      const linked = Boolean(item.productUrl);
      const tag = linked ? 'a' : 'div';
      const attrs = linked ? ` href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer"` : '';
      return `<${tag} class="mini-item"${attrs}>
        ${media(item, 'mini-thumb', linked ? '' : '<span class="mini-sample">Sample</span>')}
        <div class="mini-meta">
          <strong class="mini-name">${esc(item.name)}</strong>
          <span class="mini-retailer">${esc(item.brand)}${item.price == null ? '' : ` &middot; ${formatPrice(item.price)}`}${linked ? EXTERNAL : ''}</span>
        </div>
        <span class="match-pill">${score}%</span>
      </${tag}>`;
    }).join('');

    bindImageFallback(list);
  });
})();

/* ---------- find clothes ----------
   One text box. What the shopper types goes to the interpreter, which
   returns structured preferences, and those are matched against whatever
   products the data source holds. */
(function finder() {
  const form = document.getElementById('ask-form');
  if (!form || typeof Products === 'undefined' || typeof Interpreter === 'undefined') return;

  const input = document.getElementById('ask');
  const results = document.getElementById('results');
  const error = document.getElementById('form-error');
  const reset = document.getElementById('reset-form');
  const examples = document.getElementById('ask-examples');

  /* the vocabulary the catalogue can actually match, handed to the
     interpreter so it maps a request onto values that exist */
  function vocabulary() {
    const f = Products.facets();
    return {
      categories: [...new Set(Products.all().map((p) => p.category).filter(Boolean))],
      colors: [...f.colors.keys()],
      occasions: [...f.occasions.keys()],
      fits: [...f.fits.keys()],
      brands: [...f.brands.keys()],
      styles: [...f.styles.keys()]
    };
  }

  const lower = (list) => list.map((v) => String(v).toLowerCase());
  const overlap = (values, wanted) => {
    const want = lower(wanted);
    return values.filter((v) => want.includes(String(v).toLowerCase()));
  };

  function score(item, prefs) {
    const weights = { category: 3.2, color: 2.6, occasion: 2.4, fit: 2.2, brand: 3, style: 2 };
    let earned = 0;
    let possible = 0;
    const hits = {};
    const take = (key, weight, matches) => {
      possible += weight;
      if (matches.length) { earned += weight; hits[key] = matches[0]; }
    };

    if (prefs.categories.length) take('category', weights.category, lower(prefs.categories).includes(String(item.category).toLowerCase()) ? [item.category] : []);
    if (prefs.colors.length) take('color', weights.color, overlap(item.colors, prefs.colors));
    if (prefs.occasions.length) take('occasion', weights.occasion, overlap(item.occasions, prefs.occasions));
    if (prefs.fits.length) take('fit', weights.fit, overlap(item.fits, prefs.fits));
    if (prefs.styles.length) take('style', weights.style, overlap(item.styles, prefs.styles));
    if (prefs.brands.length) take('brand', weights.brand, lower(prefs.brands).includes(item.brand.toLowerCase()) ? [item.brand] : []);

    /* a light nudge when words from the request appear in the product name */
    const name = item.name.toLowerCase();
    const wordHit = prefs.keywords.some((w) => w.length > 3 && name.includes(w));
    if (wordHit) earned += 0.6;

    return { ratio: possible ? Math.min(earned / possible, 1) : 0, hits };
  }

  function reason(hits, prefs, item) {
    const parts = [];
    if (hits.category) parts.push(`the ${String(hits.category).toLowerCase()} you asked for`);
    if (hits.color) parts.push(`${String(hits.color).toLowerCase()} tones`);
    if (hits.fit) parts.push(`${String(hits.fit).toLowerCase()} fit`);
    if (hits.occasion) parts.push(`made for ${String(hits.occasion).toLowerCase()}`);
    if (hits.brand) parts.push(`by ${hits.brand}`);
    if (hits.style) parts.push(`${String(hits.style).toLowerCase()} styling`);
    if (prefs.maxPrice && item.price != null) parts.push(`under $${prefs.maxPrice}`);

    const text = parts.slice(0, 3).join(', ');
    if (!text) return 'Close to what you described.';
    return text.charAt(0).toUpperCase() + text.slice(1) + '.';
  }

  /* what the interpreter took from the request, shown back to the shopper */
  function understood(prefs) {
    const chips = [
      ...prefs.categories, ...prefs.colors, ...prefs.fits, ...prefs.occasions,
      ...prefs.styles, ...prefs.brands
    ];
    if (prefs.gender) chips.unshift(prefs.gender);
    if (prefs.season) chips.push(prefs.season);
    if (prefs.maxPrice) chips.push(`under $${prefs.maxPrice}`);
    if (prefs.minPrice) chips.push(`over $${prefs.minPrice}`);
    return chips.slice(0, 7);
  }

  /* Verified records from the product source. Every field shown came from
     the source and passed the gate in api/providers/product-source.js. */
  function renderProducts(found, outcome) {
    const chips = understood(outcome.preferences);
    const readback = chips.length
      ? `<div class="understood">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`
      : '';
    const notice = outcome.source !== 'openai' && outcome.notice
      ? `<p class="notice" role="status"><span>${esc(outcome.notice)}</span></p>` : '';

    results.innerHTML = `<div class="results-head">
        <div>
          <h2>${found.products.length} ${found.products.length === 1 ? 'piece' : 'pieces'} found</h2>
          ${readback}
        </div>
      </div>
      ${notice}
      <div class="grid">${found.products.map(providerCard).join('')}</div>`;
    bindImageFallback(results);
  }

  function render(prefs, outcome, found) {
    const withinBudget = (item) => {
      if (item.price == null) return true; /* unknown price cannot be ruled out */
      if (prefs.maxPrice && item.price > prefs.maxPrice) return false;
      if (prefs.minPrice && item.price < prefs.minPrice) return false;
      return true;
    };

    const scored = Products.all()
      .filter(withinBudget)
      .map((item) => {
        const { ratio, hits } = score(item, prefs);
        return { ...item, ratio, score: Math.round(70 + ratio * 28), why: reason(hits, prefs, item) };
      })
      .filter((item) => item.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio || (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, 8);

    const chips = understood(prefs);
    const readback = chips.length
      ? `<div class="understood">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`
      : '';

    /* said plainly when the shown items are samples, not real listings */
    const sourceNotice = found && found.notice
      ? `<p class="notice" role="status"><span>${esc(found.notice)}</span></p>` : '';

    /* never let a local keyword match read as an AI interpretation */
    const notice = outcome && outcome.source !== 'openai' && outcome.notice
      ? `<p class="notice" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>
          <span>${esc(outcome.notice)}</span>
        </p>`
      : '';

    if (!scored.length) {
      results.innerHTML = `<div class="results-head"><div><h2>No matches yet</h2>${readback}</div></div>
        ${notice}
        ${sourceNotice}
        <div class="empty">
          <h3>Nothing in the catalogue fits that request</h3>
          <p>Try describing it a little differently, or ask for something broader.</p>
        </div>`;
      return;
    }

    results.innerHTML = `<div class="results-head">
        <div>
          <h2>${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you</h2>
          ${readback}
        </div>
      </div>
      ${notice}
      ${sourceNotice}
      ${sampleNote(scored)}
      <div class="grid">${scored.map(resultCard).join('')}</div>`;
    bindImageFallback(results);
  }

  async function search(query) {
    error.classList.remove('show');
    results.hidden = false;
    results.innerHTML = `<p class="thinking">
      <span class="spark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z"/></svg></span>
      Reading your request…</p>`;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const outcome = await Interpreter.interpret(query, vocabulary());

    /* real products first; the sample catalogue only when no source answers */
    const found = typeof ProductSearch === 'undefined'
      ? { source: null, products: [], notice: null }
      : await ProductSearch.find(outcome.preferences);

    if (found.products.length) renderProducts(found, outcome);
    else render(outcome.preferences, outcome, found);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) {
      error.classList.add('show');
      input.focus();
      return;
    }
    search(query);
  });

  /* Enter submits, Shift+Enter makes a new line */
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  if (examples) {
    examples.addEventListener('click', (e) => {
      const button = e.target.closest('.example');
      if (!button) return;
      input.value = button.textContent.trim();
      search(input.value);
    });
  }

  reset.addEventListener('click', () => {
    input.value = '';
    error.classList.remove('show');
    results.hidden = true;
    results.innerHTML = '';
    input.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
})();

/* ---------- discover ---------- */
(function discover() {
  const grid = document.getElementById('discover-grid');
  if (!grid || typeof Products === 'undefined') return;

  const pillBar = document.querySelector('.filter-pills');
  const count = document.getElementById('filter-count');
  let active = 'All';

  function paint() {
    const items = active === 'All'
      ? Products.all()
      : Products.all().filter((i) => i.styles.includes(active));
    count.textContent = `${items.length} ${items.length === 1 ? 'piece' : 'pieces'}`;
    const note = document.getElementById('discover-note');
    if (note) note.innerHTML = sampleNote(items);
    grid.innerHTML = items.map(browseCard).join('');
    bindImageFallback(grid);
  }

  if (pillBar) {
    pillBar.addEventListener('click', (e) => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      active = pill.dataset.style;
      pillBar.querySelectorAll('.pill').forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
      paint();
    });
  }

  Products.subscribe(() => {
    if (pillBar) {
      const styles = ['All'].concat(orderFacet(Products.facets().styles, 'styles'));
      if (!styles.includes(active)) active = 'All';
      pillBar.innerHTML = styles.map((s) =>
        `<button class="pill" type="button" data-style="${esc(s)}" aria-pressed="${s === active}">${esc(s)}</button>`).join('');
    }
    paint();
  });
})();

/* ---------- data source ----------
   The one line to change when a real feed, API or database replaces the
   demo catalogue. Everything above renders whatever arrives. */
(function boot() {
  if (typeof Products === 'undefined') return;
  Products.load(typeof DEMO_PRODUCTS === 'undefined' ? [] : DEMO_PRODUCTS);
})();
