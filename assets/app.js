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

function productCard(item, index, badge, extra) {
  const linked = Boolean(item.productUrl);
  const tag = linked ? 'a' : 'article';
  const attrs = linked ? ` href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer"` : '';
  const tags = [item.colors[0], item.fits[0]].filter(Boolean)
    .map((t) => `<span>${esc(t)}</span>`).join('');
  return `<${tag} class="item-card" style="--i:${index}"${attrs}>
    ${media(item, 'item-media', badge)}
    <div class="item-body">
      <p class="item-brand">${esc(item.brand)}${linked ? EXTERNAL : ''}</p>
      <h3 class="item-name">${esc(item.name)}</h3>
      <div class="item-row">
        <span class="item-price">${item.price == null ? '' : `$${item.price}`}</span>
        <div class="item-tags">${tags}</div>
      </div>
      ${extra || ''}
    </div>
  </${tag}>`;
}

const resultCard = (item, index) => productCard(item, index,
  `<span class="item-badge">${item.score}% match</span>`,
  `<p class="item-why">${SPARK}<span>${esc(item.why)}</span></p>`);

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

function chipHtml(name, value, swatch) {
  const dot = swatch ? `<span class="swatch" style="background:${(COLORS[value] || FALLBACK_COLOR).dot}"></span>` : '';
  return `<label class="chip"><input type="checkbox" name="${name}" value="${esc(value)}">${dot}${esc(value)}</label>`;
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
        ${media(item, 'mini-thumb')}
        <div class="mini-meta">
          <strong class="mini-name">${esc(item.name)}</strong>
          <span class="mini-retailer">${esc(item.brand)}${item.price == null ? '' : ` &middot; $${item.price}`}${linked ? EXTERNAL : ''}</span>
        </div>
        <span class="match-pill">${score}%</span>
      </${tag}>`;
    }).join('');

    bindImageFallback(list);
  });
})();

/* ---------- find clothes ---------- */
(function finder() {
  const form = document.getElementById('pref-form');
  if (!form || typeof Products === 'undefined') return;

  const budget = document.getElementById('budget');
  const budgetValue = document.getElementById('budget-value');
  const results = document.getElementById('results');
  const error = document.getElementById('form-error');
  const reset = document.getElementById('reset-form');
  let maxBudget = Number(budget.max);

  const syncBudget = () => {
    budgetValue.textContent = Number(budget.value) >= maxBudget ? 'Any price' : `Up to $${budget.value}`;
    const pct = ((budget.value - budget.min) / (budget.max - budget.min)) * 100;
    budget.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent-2) ${pct}%, var(--surface-2) ${pct}%)`;
  };
  budget.addEventListener('input', syncBudget);

  /* chip styling is delegated so it survives the controls being rebuilt
     whenever the data source changes */
  form.addEventListener('change', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) chip.classList.toggle('is-checked', e.target.checked);
  });

  const picked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const overlap = (a, b) => a.filter((v) => b.includes(v));

  function score(item, prefs) {
    const weights = { style: 3, color: 2.6, occasion: 2.6, fit: 2.2, brand: 3 };
    let earned = 0;
    let possible = 0;
    const hits = {};
    const take = (key, weight, matches) => {
      if (!prefs[key].length) return;
      possible += weight;
      if (matches.length) { earned += weight; hits[key] = matches[0]; }
    };

    take('style', weights.style, overlap(item.styles, prefs.style));
    take('color', weights.color, overlap(item.colors, prefs.color));
    take('occasion', weights.occasion, overlap(item.occasions, prefs.occasion));
    take('fit', weights.fit, overlap(item.fits, prefs.fit));
    take('brand', weights.brand, prefs.brand.includes(item.brand) ? [item.brand] : []);

    return { ratio: possible ? earned / possible : 0, hits };
  }

  function reason(hits, prefs, item) {
    const parts = [];
    if (hits.style) parts.push(`${hits.style.toLowerCase()} cut`);
    if (hits.color) parts.push(`${hits.color.toLowerCase()} tones`);
    if (hits.occasion) parts.push(`made for ${hits.occasion.toLowerCase()}`);
    if (hits.fit) parts.push(`${hits.fit.toLowerCase()} fit`);
    if (hits.brand) parts.push(`by ${hits.brand}, a brand you picked`);
    /* only claim the budget when the product actually has a price */
    if (prefs.budget < maxBudget && item.price != null) parts.push(`inside your $${prefs.budget} budget`);

    const text = parts.slice(0, 3).join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1) + '.';
  }

  function render(prefs) {
    const capped = prefs.budget < maxBudget;
    const scored = Products.all()
      /* a product with no price cannot be ruled out by a budget */
      .filter((item) => !capped || item.price == null || item.price <= prefs.budget)
      .map((item) => {
        const { ratio, hits } = score(item, prefs);
        return { ...item, ratio, score: Math.round(70 + ratio * 28), why: reason(hits, prefs, item) };
      })
      .filter((item) => item.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio || (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, 8);

    const summary = [...prefs.style, ...prefs.color, ...prefs.occasion, ...prefs.fit, ...prefs.brand]
      .slice(0, 4).join(' · ');

    if (!scored.length) {
      results.innerHTML = `<div class="results-head"><div><h2>No matches yet</h2></div></div>
        <div class="empty">
          <h3>Nothing in the catalogue fits all of that</h3>
          <p>Try raising the budget or picking a second style — the results widen straight away.</p>
        </div>`;
      return;
    }

    results.innerHTML = `<div class="results-head">
        <div>
          <h2>${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you</h2>
          <p>Matched on ${summary}${capped ? ` · under $${prefs.budget}` : ''}</p>
        </div>
      </div>
      <div class="grid">${scored.map(resultCard).join('')}</div>`;
    bindImageFallback(results);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const prefs = {
      style: picked('style'),
      color: picked('color'),
      occasion: picked('occasion'),
      fit: picked('fit'),
      brand: picked('brand'),
      budget: Number(budget.value)
    };

    const total = prefs.style.length + prefs.color.length + prefs.occasion.length + prefs.fit.length + prefs.brand.length;
    if (!total) {
      error.classList.add('show');
      return;
    }
    error.classList.remove('show');

    results.hidden = false;
    results.innerHTML = `<p class="thinking">
      <span class="spark"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z"/></svg></span>
      Reading your preferences and matching pieces…</p>`;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    window.setTimeout(() => render(prefs), 650);
  });

  reset.addEventListener('click', () => {
    form.reset();
    form.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('is-checked'));
    syncBudget();
    error.classList.remove('show');
    results.hidden = true;
    results.innerHTML = '';
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  /* the preference controls are rebuilt from whatever the data contains */
  Products.subscribe((items) => {
    const f = Products.facets();
    const fill = (facetKey, inputName, swatch) => {
      const holder = form.querySelector(`.chips[data-facet="${facetKey}"]`);
      if (holder) holder.innerHTML = orderFacet(f[facetKey], facetKey).map((v) => chipHtml(inputName, v, swatch)).join('');
    };
    fill('styles', 'style');
    fill('colors', 'color', true);
    fill('occasions', 'occasion');
    fill('fits', 'fit');

    const brands = form.querySelector('.chips[data-facet="brands"]');
    if (brands) brands.innerHTML = [...f.brands.keys()].sort((a, b) => a.localeCompare(b))
      .map((v) => chipHtml('brand', v)).join('');

    /* keep the slider able to reach the most expensive product on offer */
    maxBudget = Math.max(400, Math.ceil(f.maxPrice / 50) * 50);
    budget.max = String(maxBudget);
    if (Number(budget.value) > maxBudget) budget.value = String(maxBudget);
    syncBudget();
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
