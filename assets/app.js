/* =========================================================
   Wove — shared behaviour
   ========================================================= */

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
  if (!list || typeof CATALOG === 'undefined') return;

  const picks = [[2, 96], [7, 93], [3, 91]];
  list.innerHTML = picks.map(([id, score]) => {
    const item = CATALOG.find((i) => i.id === id);
    return `<div class="mini-item">
      ${miniArt(item)}
      <div class="mini-meta">
        <strong>${item.name}</strong>
        <span>${item.brand} &middot; $${item.price}</span>
      </div>
      <span class="match-pill">${score}%</span>
    </div>`;
  }).join('');
})();

/* ---------- find clothes ---------- */
(function finder() {
  const form = document.getElementById('pref-form');
  if (!form || typeof CATALOG === 'undefined') return;

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
    const scored = CATALOG
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
  if (!grid || typeof CATALOG === 'undefined') return;

  const pills = [...document.querySelectorAll('.filter-pills .pill')];
  const count = document.getElementById('filter-count');

  function paint(style) {
    const items = style === 'All' ? CATALOG : CATALOG.filter((i) => i.styles.includes(style));
    count.textContent = `${items.length} ${items.length === 1 ? 'piece' : 'pieces'}`;
    grid.innerHTML = items.map(browseCard).join('');
  }

  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.setAttribute('aria-pressed', String(p === pill)));
      paint(pill.dataset.style);
    });
  });

  paint('All');
})();
