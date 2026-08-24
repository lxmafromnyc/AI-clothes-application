/* =========================================================
   Fynd — rendering and page behaviour

   Reads the canonical product shape from assets/products.js and nothing
   else. Swapping the data source changes what appears; it does not change
   this file.
   ========================================================= */

/* ---------- artwork ----------
   Drawn when a product has no usable photo. One neutral tile and a
   garment outline: the artwork stands in for a picture, it does not
   decorate the page, so it carries no colour of its own. */

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

const shapeOf = (item) => SILHOUETTES[item.category] || SILHOUETTES.tee;

/* ---------- rendering ----------
   Every card is built from the canonical fields only, so the same code
   renders three products or three thousand. */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

const artSvg = (item) =>
  `<svg class="silhouette" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">${shapeOf(item)}</svg>`;

/* photo when the product has one, drawn artwork otherwise. The tile is
   the same neutral either way, so replacing a failed photo with artwork
   needs no style changes. */
function media(item, badge) {
  const inner = item.imageUrl
    ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" loading="lazy" decoding="async" data-fallback="${esc(item.id)}">`
    : artSvg(item);
  return `<div class="item-media">${inner}${badge || ''}</div>`;
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

/* Money keeps its cents: 72.5 from a source must read $72.50, not $72.5.
   Whole amounts stay whole, matching how the catalogue rows read. */
function formatPrice(value) {
  if (value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
}

/* A product with no productUrl is not a real listing. It is marked on the
   card itself so a sample row can never read as something you can buy. */
const SAMPLE_BADGE = '<span class="item-badge">Sample</span>';

/* Shown once above any grid that contains placeholder rows. */
const SAMPLE_NOTE = 'Items marked <strong>Sample</strong> are placeholder data for the demo, not real listings.';
const sampleNote = (items) => (items.some((i) => !i.productUrl)
  ? `<p class="sample-note">${SAMPLE_NOTE}</p>` : '');

/* The short line under the price. Three attributes at most, in one
   order, from whichever of them the record actually carries — provider
   records bring colours and sizes, catalogue rows bring fits and styles,
   and both end up reading the same way. */
function attributes(item) {
  const sizes = (item.sizes || []).slice(0, 3).join(' / ');
  return [
    (item.colors || [])[0],
    (item.fits || [])[0],
    (item.styles || [])[0],
    sizes || null
  ].filter(Boolean).slice(0, 3).join(' \u00b7 ');
}

/* One card, one shape, everywhere it is used:

     image -> retailer -> name -> price -> attributes -> action

   Nothing on it is conditional on which page or which search produced
   it, so a grid always reads as one set of rows. The only variation is
   the action, which tells the truth about whether there is somewhere to
   go: a real listing links out, a placeholder says it is a placeholder. */
function productCard(item) {
  const linked = Boolean(item.productUrl);
  const tag = linked ? 'a' : 'article';
  const attrs = linked ? ` href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer"` : '';
  const seller = item.retailer || item.brand || '';
  const price = formatPrice(item.price);
  const attrLine = attributes(item);
  const action = linked
    ? `<span class="item-action">View item ${ARROW}<span class="sr-only">(opens in a new tab)</span></span>`
    : '<span class="item-action item-action--muted">Sample item</span>';

  return `<${tag} class="item-card"${attrs}>
    ${media(item, linked ? '' : SAMPLE_BADGE)}
    <div class="item-body">
      <p class="item-retailer">${esc(seller)}</p>
      <h3 class="item-name">${esc(item.name)}</h3>
      <p class="item-price${price ? '' : ' item-price--none'}">${price || 'Price at retailer'}</p>
      <p class="item-attrs">${esc(attrLine)}</p>
      ${action}
    </div>
  </${tag}>`;
}

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

/* ---------- brand ----------
   The logo is an ordinary <img> in the markup, so it renders with or
   without scripting. This only handles its absence: a source that will
   not load falls back to the sibling wordmark rather than leaving a
   broken image in the header, and an asset saved under the other
   extension is tried once before giving up.

   The favicon is swapped the same way — a <link rel="icon"> has no
   error event, so the mark is loaded first and the icon is only
   repointed once the file is known to be there. Until then the inline
   mark in each page's <head> stands. */
(function brand() {
  const LOGO = ['assets/fynd-logo.svg', 'assets/fynd-logo.png'];
  const MARK = ['assets/fynd-mark.svg', 'assets/fynd-mark.png'];

  document.querySelectorAll('.brand').forEach((mark) => {
    const logo = mark.querySelector('.brand-logo');
    if (!logo) return;

    let next = 1;
    logo.addEventListener('error', function retry() {
      if (next < LOGO.length) {
        logo.src = LOGO[next++];
        return;
      }
      logo.removeEventListener('error', retry);
      mark.classList.add('logo-missing');
    });

    /* an error that fired before this ran is not replayed, so a load
       that has already failed is caught here instead */
    if (logo.complete && logo.naturalWidth === 0) logo.dispatchEvent(new Event('error'));
  });

  const icon = document.querySelector('link[rel="icon"]');
  if (!icon) return;
  (function tryMark(i) {
    if (i >= MARK.length) return;
    const probe = new Image();
    probe.onload = () => { icon.setAttribute('href', MARK[i]); };
    probe.onerror = () => tryMark(i + 1);
    probe.src = MARK[i];
  })(0);
})();

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
  const status = document.getElementById('search-status');
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

  /* What the interpreter took from the request, said once above the grid.
     This is the only place Fynd claims to have understood anything: no
     card carries a match score or a reason of its own, so a row of
     results reads as products rather than as assertions about them. */
  function readback(prefs) {
    const chips = understood(prefs);
    if (!chips.length) return '';
    return `<p class="understood-label">Fynd understood</p>
      <div class="understood">${chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`;
  }

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
    const notice = outcome.source !== 'openai' && outcome.notice
      ? `<p class="notice" role="status">${esc(outcome.notice)}</p>` : '';

    results.innerHTML = `<div class="results-head">
        <h2>${found.products.length} ${found.products.length === 1 ? 'piece' : 'pieces'} found</h2>
        ${readback(outcome.preferences)}
      </div>
      ${notice}
      <div class="grid">${found.products.map(productCard).join('')}</div>`;
    bindImageFallback(results);
    announce(`${found.products.length} ${found.products.length === 1 ? 'piece' : 'pieces'} found.`);
  }

  /* A configured source that returned nothing. The request readback stays,
     so it is clear what was searched for, and the reason is stated plainly
     instead of being filled with placeholder products. */
  function renderNothing(found, outcome) {
    const heading = found.state === 'empty' ? 'No matches found' : 'Product search unavailable';
    const detail = found.state === 'empty'
      ? 'Nothing came back that could be verified for this request. Try describing it a little differently, or ask for something broader.'
      : 'This is a problem on our side, not with your request. Try again in a moment.';

    results.innerHTML = `<div class="results-head"><h2>${heading}</h2>${readback(outcome.preferences)}</div>
      ${found.notice ? `<p class="notice" role="status">${esc(found.notice)}</p>` : ''}
      <div class="empty">
        <h3>${heading}</h3>
        <p>${esc(detail)}</p>
      </div>`;
    announce(`${heading}. ${detail}`);
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
        const { ratio } = score(item, prefs);
        return { ...item, ratio };
      })
      .filter((item) => item.ratio > 0)
      .sort((a, b) => b.ratio - a.ratio || (a.price ?? Infinity) - (b.price ?? Infinity))
      .slice(0, 8);

    /* said plainly when the shown items are samples, not real listings */
    const sourceNotice = found && found.notice
      ? `<p class="notice" role="status">${esc(found.notice)}</p>` : '';

    /* never let a local keyword match read as an AI interpretation */
    const notice = outcome && outcome.source !== 'openai' && outcome.notice
      ? `<p class="notice" role="status">${esc(outcome.notice)}</p>` : '';

    if (!scored.length) {
      results.innerHTML = `<div class="results-head"><h2>No matches yet</h2>${readback(prefs)}</div>
        ${notice}
        ${sourceNotice}
        <div class="empty">
          <h3>Nothing in the catalogue fits that request</h3>
          <p>Try describing it a little differently, or ask for something broader.</p>
        </div>`;
      announce('No matches yet. Try describing it a little differently, or ask for something broader.');
      return;
    }

    results.innerHTML = `<div class="results-head">
        <h2>${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you</h2>
        ${readback(prefs)}
      </div>
      ${notice}
      ${sourceNotice}
      ${sampleNote(scored)}
      <div class="grid">${scored.map(productCard).join('')}</div>`;
    bindImageFallback(results);
    announce(`${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you.`);
  }

  /* One short line for anyone not looking at the grid. */
  function announce(text) {
    if (status) status.textContent = text;
  }

  async function search(query, attached) {
    error.classList.remove('show');
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    announce('Searching\u2026');
    results.hidden = false;
    results.innerHTML = '<p class="thinking"><span class="dot"></span>Reading your request…</p>';
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const outcome = await Interpreter.interpret(query, vocabulary());

    /* real products first; the sample catalogue only when no source answers */
    const found = typeof ProductSearch === 'undefined'
      ? { source: null, products: [], notice: null }
      : await ProductSearch.find(outcome.preferences, undefined, attached);

    if (found.products.length) renderProducts(found, outcome);
    /* The sample catalogue stands in only when nothing is connected. Once
       a product source IS configured, a failed or empty search says so —
       a deployment that can sell things must never pad the page with demo
       rows, however clearly they are labelled. */
    else if (found.state === 'not-configured') render(outcome.preferences, outcome, found);
    else renderNothing(found, outcome);
  }

  /* Files dropped on the card or chosen with the button. Held here
     until the search is submitted; the module never sends anything. */
  const attachments = typeof Attachments === 'undefined' ? null : Attachments.create({
    zone: form,
    input: document.getElementById('ask-files'),
    list: document.getElementById('attachments'),
    error: document.getElementById('attachment-error'),
    onChange: (files) => {
      const note = document.getElementById('attachment-note');
      if (note) note.hidden = files.length === 0;
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) {
      error.textContent = 'Tell Fynd what you\u2019re looking for first.';
      error.classList.add('show');
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    search(query, attachments ? attachments.manifest() : []);
  });

  /* Enter submits, Shift+Enter makes a new line */
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  /* The closing call to action points back at the search. Landing there
     with the cursor already in the box means the button does the whole
     job in one press rather than leaving the shopper to find the field. */
  document.querySelectorAll('a[href="#search"]').forEach((link) => {
    link.addEventListener('click', () => {
      window.setTimeout(() => input.focus({ preventScroll: true }), 400);
    });
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
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    announce('');
    /* starting over drops the attachments too, and hands back the
       object URLs their thumbnails were holding */
    if (attachments) attachments.clear();
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
    grid.innerHTML = items.map(productCard).join('');
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
