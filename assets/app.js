/* =========================================================
   FindWear — shared behaviour
   ========================================================= */

/* ---------- product rendering ----------
   Every card is built from the product schema in catalog.js and nothing
   else, so the same code renders 3 products or 3000. A product with an
   imageUrl shows its photo; one without falls back to drawn artwork, and
   so does a photo that fails to load. A product with a productUrl renders
   as a link; one without renders as plain markup. */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SPARK = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5 13.9 11.4 12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z"/></svg>';

const EXTERNAL = '<svg class="ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

/* drawn garment artwork, used when there is no usable photo */
function artSvg(item) {
  const c = COLORS[item.color];
  const ink = c.dark ? 'rgba(255,255,255,.44)' : 'rgba(22,23,28,.26)';
  return `<svg class="silhouette" viewBox="0 0 64 64" fill="${ink}" aria-hidden="true">${SILHOUETTES[item.type]}</svg>`;
}

/* the media box: photo when the product has one, drawn art otherwise.
   The colour gradient sits on the container either way, so swapping a
   failed photo for artwork needs no style changes. */
function media(item, cls, badge) {
  const c = COLORS[item.color];
  const inner = item.imageUrl
    ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" loading="lazy" decoding="async" data-fallback="${item.id}">`
    : artSvg(item);
  return `<div class="${cls}" style="background:linear-gradient(150deg, ${c.from}, ${c.to})">${inner}${badge || ''}</div>`;
}

/* a dead image URL leaves the drawn artwork in its place rather than a
   broken-image icon, so a feed with stale photo links still renders. */
function bindImageFallback(root) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      const item = productById(Number(img.dataset.fallback));
      if (item) img.outerHTML = artSvg(item);
    }, { once: true });
  });
}

const priceLabel = (item) => (item.price == null ? '' : `$${item.price}`);

/* shared card body; `badge` sits on the media, `extra` appends to the body */
function productCard(item, index, badge, extra) {
  const linked = Boolean(item.productUrl);
  const tag = linked ? 'a' : 'article';
  const attrs = linked
    ? ` href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer"`
    : '';
  return `<${tag} class="item-card${linked ? ' item-card--linked' : ''}" style="--i:${index}"${attrs}>
    ${media(item, 'item-media', badge)}
    <div class="item-body">
      <p class="item-brand">${esc(item.brand)}${linked ? EXTERNAL : ''}</p>
      <h3 class="item-name">${esc(item.name)}</h3>
      <div class="item-row">
        <span class="item-price">${priceLabel(item)}</span>
        <div class="item-tags"><span>${item.color}</span><span>${item.fits[0]}</span></div>
      </div>
      ${extra || ''}
    </div>
  </${tag}>`;
}

/* card for the Find Clothes results (match score + reason) */
function resultCard(item, index) {
  return productCard(item, index,
    `<span class="item-badge">${item.score}% match</span>`,
    `<p class="item-why">${SPARK}<span>${esc(item.why)}</span></p>`);
}

/* card for Discover (browsing) */
function browseCard(item, index) {
  return productCard(item, index, `<span class="item-badge">${item.styles[0]}</span>`);
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
  if (!list || typeof HERO_PICKS === 'undefined') return;

  list.innerHTML = HERO_PICKS.map(({ id, score }) => {
    const item = productById(id);
    if (!item) return '';
    return `<a class="mini-item" href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer">
      ${media(item, 'mini-thumb')}
      <div class="mini-meta">
        <strong class="mini-name">${esc(item.name)}</strong>
        <span class="mini-retailer">${esc(item.brand)}${item.price == null ? '' : ` &middot; $${item.price}`}${EXTERNAL}</span>
      </div>
      <span class="match-pill">${score}%</span>
    </a>`;
  }).join('');

  bindImageFallback(list);
})();

/* ---------- find clothes ---------- */
(function finder() {
  const form = document.getElementById('pref-form');
  if (!form || typeof PRODUCTS === 'undefined') return;

  const budget = document.getElementById('budget');
  const budgetValue = document.getElementById('budget-value');
  const results = document.getElementById('results');
  const error = document.getElementById('form-error');
  const reset = document.getElementById('reset-form');
  const MAX_BUDGET = Number(budget.max);

  const budgetLabel = () => (Number(budget.value) >= MAX_BUDGET ? 'Any price' : `Up to $${budget.value}`);
  const syncBudget = () => {
    budgetValue.textContent = budgetLabel();
    const pct = ((budget.value - budget.min) / (budget.max - budget.min)) * 100;
    budget.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent-2) ${pct}%, var(--surface-2) ${pct}%)`;
  };
  budget.addEventListener('input', syncBudget);
  syncBudget();

  /* keep chip styling in sync with their checkbox */
  form.querySelectorAll('.chip input').forEach((input) => {
    const paint = () => input.closest('.chip').classList.toggle('is-checked', input.checked);
    input.addEventListener('change', paint);
    paint();
  });

  const picked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);

  function score(item, prefs) {
    const weights = { style: 3, color: 2.6, occasion: 2.6, fit: 2.2, brand: 3 };
    let earned = 0;
    let possible = 0;
    const hits = {};

    if (prefs.style.length) {
      possible += weights.style;
      const match = item.styles.filter((s) => prefs.style.includes(s));
      if (match.length) { earned += weights.style; hits.style = match[0]; }
    }
    if (prefs.color.length) {
      possible += weights.color;
      if (prefs.color.includes(item.color)) { earned += weights.color; hits.color = item.color; }
    }
    if (prefs.occasion.length) {
      possible += weights.occasion;
      const match = item.occasions.filter((o) => prefs.occasion.includes(o));
      if (match.length) { earned += weights.occasion; hits.occasion = match[0]; }
    }
    if (prefs.fit.length) {
      possible += weights.fit;
      const match = item.fits.filter((f) => prefs.fit.includes(f));
      if (match.length) { earned += weights.fit; hits.fit = match[0]; }
    }
    if (prefs.brand.length) {
      possible += weights.brand;
      if (prefs.brand.includes(item.brand)) { earned += weights.brand; hits.brand = item.brand; }
    }

    const ratio = possible ? earned / possible : 0;
    return { ratio, hits };
  }

  function reason(hits, prefs, item) {
    const parts = [];
    if (hits.style) parts.push(`${hits.style.toLowerCase()} cut`);
    if (hits.color) parts.push(`${hits.color.toLowerCase()} tones`);
    if (hits.occasion) parts.push(`made for ${hits.occasion.toLowerCase()}`);
    if (hits.fit) parts.push(`${hits.fit.toLowerCase()} fit`);
    if (hits.brand) parts.push(`by ${hits.brand}, a brand you picked`);
    if (prefs.budget < MAX_BUDGET) parts.push(`inside your $${prefs.budget} budget`);

    const text = parts.slice(0, 3).join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1) + '.';
  }

  function render(prefs) {
    const capped = prefs.budget < MAX_BUDGET;
    const scored = PRODUCTS
      .filter((item) => !capped || item.price <= prefs.budget)
      .map((item) => {
        const { ratio, hits } = score(item, prefs);
        return { ...item, ratio, score: Math.round(70 + ratio * 28), why: reason(hits, prefs, item) };
      })
      .filter((item) => item.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio || a.price - b.price)
      .slice(0, 8);

    const summary = [
      ...prefs.style, ...prefs.color, ...prefs.occasion, ...prefs.fit, ...prefs.brand
    ].slice(0, 4).join(' · ');

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
})();

/* ---------- discover ---------- */
(function discover() {
  const grid = document.getElementById('discover-grid');
  if (!grid || typeof PRODUCTS === 'undefined') return;

  const pills = [...document.querySelectorAll('.filter-pills .pill')];
  const count = document.getElementById('filter-count');

  function paint(style) {
    const items = style === 'All' ? PRODUCTS : PRODUCTS.filter((i) => i.styles.includes(style));
    count.textContent = `${items.length} ${items.length === 1 ? 'piece' : 'pieces'}`;
    grid.innerHTML = items.map(browseCard).join('');
    bindImageFallback(grid);
  }

  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
      paint(pill.dataset.style);
    });
  });

  paint('All');
})();
