/* =========================================================
   Fynd — rendering and page behaviour

   Reads the canonical product shape from assets/products.js and nothing
   else. Swapping the data source changes what appears; it does not change
   this file.
   ========================================================= */

/* ---------- artwork ----------
   Drawn when a product has no usable photo. One neutral tile and a
   garment drawn as line work: the artwork stands in for a picture, it
   does not decorate the page, so it carries no colour of its own and no
   weight beyond a hairline. */

const SILHOUETTES = {
  tee: '<path d="M22 13 11 18 7 27 15 31 18 27 18 53 46 53 46 27 49 31 57 27 53 18 42 13"/><path d="M22 13c3 5 17 5 20 0"/>',
  shirt: '<path d="M23 13 12 18 8 28 15 32 18 28 18 54 46 54 46 28 49 32 56 28 52 18 41 13"/><path d="M23 13 27 13 32 19 37 13 41 13"/><path d="M32 19 32 54"/>',
  knit: '<path d="M22 13 8 20 5 33 13 37 17 30 17 50 47 50 47 30 51 37 59 33 56 20 42 13"/><path d="M22 13c4 5 16 5 20 0"/><path d="M17 50 17 55 47 55 47 50"/>',
  jacket: '<path d="M24 12 11 18 7 30 14 34 17 29 17 55 31 55 31 22Z"/><path d="M40 12 53 18 57 30 50 34 47 29 47 55 33 55 33 22Z"/>',
  coat: '<path d="M24 10 10 17 5 32 13 36 17 29 17 58 47 58 47 29 51 36 59 32 54 17 40 10"/><path d="M24 10 32 17 40 10"/><path d="M17 38 47 38"/>',
  dress: '<path d="M24 12 16 17 20 26 23 24 13 56 51 56 41 24 44 26 48 17 40 12"/><path d="M24 12c3 5 13 5 16 0"/>',
  trousers: '<path d="M18 11 46 11 48 56 36 56 32 29 28 56 16 56 18 11"/><path d="M18 17 46 17"/>',
  skirt: '<path d="M20 15 44 15 52 52 12 52 20 15"/><path d="M20 21 44 21"/>',
  shorts: '<path d="M18 12 46 12 48 39 36 39 32 25 28 39 16 39 18 12"/><path d="M18 18 46 18"/>',
  sneaker: '<path d="M8 45 8 35 22 30 31 20 36 20 42 32 52 35 58 39 58 45Z"/><path d="M8 41 58 41"/>'
};

const shapeOf = (item) => SILHOUETTES[item.category] || SILHOUETTES.tee;

/* ---------- rendering ----------
   Every card is built from the canonical fields only, so the same code
   renders three products or three thousand. */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

const artSvg = (item) =>
  `<svg class="silhouette" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapeOf(item)}</svg>`;

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

/* The shape of a card, drawn while the real one is on its way, so the
   grid arrives in place instead of appearing out of nothing. It carries
   no text: there is nothing true to say yet. */
const SKELETON = `<div class="skeleton-card">
  <div class="skeleton-media"></div>
  <div class="skeleton-line"></div>
  <div class="skeleton-line skeleton-line--short"></div>
</div>`;

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
  const preview = document.getElementById('preview');

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

    /* the shopper's garment word, mapped to whatever this catalogue calls
       it — "hoodie" and "sweater" both being knits here */
    const wantedCategories = prefs.categories.map((c) =>
      (typeof Interpreter.catalogueCategory === 'function' ? Interpreter.catalogueCategory(c) : c));
    if (wantedCategories.length) take('category', weights.category, lower(wantedCategories).includes(String(item.category).toLowerCase()) ? [item.category] : []);
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
    return `<div class="understood">
      <span class="understood-label">Fynd understood</span>
      ${chips.map((c) => `<span>${esc(c)}</span>`).join('')}
    </div>`;
  }

  /* Where the rows on screen came from, in one marker. Green is only
     ever used for rows a product source actually returned; amber marks
     the demo catalogue standing in. Anything else carries no marker at
     all rather than a reassuring one it has not earned. */
  const STATUS = {
    live: '<span class="status status--live">Live listings</span>',
    sample: '<span class="status status--sample">Sample data</span>'
  };

  /* Every result state opens the same way: a kicker and where the rows
     came from, then the outcome in one line, then what was understood
     beside it. The shopper reads the same shape whether eight things
     came back or none. */
  const resultsHead = (heading, prefs, status) => `<div class="results-head">
      <div>
        <div class="results-head-line">
          <p class="eyebrow">Results</p>
          ${status || ''}
        </div>
        <h2>${heading}</h2>
      </div>
      ${readback(prefs)}
    </div>`;

  function understood(prefs) {
    if (!prefs) return [];
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

    const count = `${found.products.length} ${found.products.length === 1 ? 'piece' : 'pieces'} found`;
    results.innerHTML = `${resultsHead(count, outcome.preferences, STATUS.live)}
      ${notice}
      <div class="grid">${found.products.map(productCard).join('')}</div>`;
    bindImageFallback(results);
    announce(`${found.products.length} ${found.products.length === 1 ? 'piece' : 'pieces'} found.`);
  }

  /* A configured source that returned nothing. The request readback stays,
     so it is clear what was searched for, and the reason is stated plainly
     instead of being filled with placeholder products. */
  function renderNothing(found, outcome) {
    const empty = found.state === 'empty';
    /* the heading names the outcome, the panel names the next move, and
       the reason is given once — no line on the page repeats another */
    const heading = empty ? 'No matches found' : 'Product search unavailable';
    const next = empty ? 'Try describing it a little differently' : 'Try again in a moment';
    const detail = found.notice || (empty
      ? 'Nothing came back that could be verified for this request.'
      : 'This is a problem on our side, not with your request.');

    results.innerHTML = `${resultsHead(heading, outcome.preferences)}
      <div class="empty">
        <h3>${esc(next)}</h3>
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
      results.innerHTML = `${resultsHead('No matches yet', prefs)}
        ${notice}
        ${sourceNotice}
        <div class="empty">
          <h3>Try describing it a little differently</h3>
          <p>Nothing in the catalogue fits that request. Asking for something broader usually helps.</p>
        </div>`;
      announce('No matches yet. Try describing it a little differently, or ask for something broader.');
      return;
    }

    const picked = `${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you`;
    /* these rows are the demo catalogue; it is only called sample data
       when placeholder rows are actually among them */
    const status = scored.some((item) => !item.productUrl) ? STATUS.sample : '';
    results.innerHTML = `${resultsHead(picked, prefs, status)}
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

  /* Every search gets a number. A reply may only paint the page if it
     belongs to the newest one — otherwise a slow first request can land
     after a fast second and overwrite the results the shopper is
     actually looking at. The button is held closed while a search runs,
     so a double click is one search rather than two. */
  let runId = 0;
  let running = false;

  function setBusy(state) {
    running = state;
    const submit = form.querySelector('button[type=submit]');
    if (!submit) return;
    submit.disabled = state;
    submit.setAttribute('aria-busy', String(state));
  }

  async function search(query, attached) {
    const id = ++runId;
    const current = () => id === runId;
    setBusy(true);
    error.classList.remove('show');
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    announce('Searching\u2026');
    /* the sample row on the home page steps aside: once a real search is
       running, the page has something better to put in that space */
    if (preview) preview.hidden = true;
    results.hidden = false;
    results.innerHTML = `<p class="thinking"><span class="dot"></span>Reading your request…</p>
      <div class="grid">${SKELETON.repeat(4)}</div>`;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const outcome = await Interpreter.interpret(query, vocabulary());
      if (!current()) return;

      /* real products first; the sample catalogue only when no source answers */
      const found = typeof ProductSearch === 'undefined'
        ? { source: null, products: [], notice: null }
        : await ProductSearch.find(outcome.preferences, undefined, attached, query);
      if (!current()) return;

      if (found.products.length) renderProducts(found, outcome);
      /* The sample catalogue stands in only when nothing is connected. Once
         a product source IS configured, a failed or empty search says so —
         a deployment that can sell things must never pad the page with demo
         rows, however clearly they are labelled. */
      else if (found.state === 'not-configured') render(outcome.preferences, outcome, found);
      else renderNothing(found, outcome);
    } catch (err) {
      /* Nothing above is expected to throw — both modules answer with a
         state rather than rejecting. If one ever does, the shopper gets a
         page that says so instead of a spinner that never stops. */
      if (!current()) return;
      results.innerHTML = `${resultsHead('Something went wrong', null)}
        <div class="empty">
          <h3>Try that again</h3>
          <p>Fynd could not finish that search. Nothing was wrong with your request.</p>
        </div>`;
      announce('Something went wrong. Try that again.');
    } finally {
      if (current()) setBusy(false);
    }
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
    /* a second press while the first search is still running is the same
       request arriving twice, not a new one */
    if (running) return;
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

  /* The box grows with the request up to a few lines, then scrolls, so a
     long description stays readable while it is being typed and the card
     never runs away down the page. */
  const GROW_LIMIT = 168;
  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, GROW_LIMIT) + 'px';
  }
  input.addEventListener('input', grow);

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
      grow();
      search(input.value);
    });
  }

  reset.addEventListener('click', () => {
    input.value = '';
    input.style.height = '';
    error.classList.remove('show');
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    announce('');
    /* starting over drops the attachments too, and hands back the
       object URLs their thumbnails were holding */
    if (attachments) attachments.clear();
    /* whatever is in flight no longer owns the page */
    runId += 1;
    setBusy(false);
    results.hidden = true;
    results.innerHTML = '';
    if (preview) preview.hidden = false;
    input.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
})();

/* ---------- what a result looks like ----------
   The home page carries a short row of catalogue rows, so a first-time
   visitor can see the shape of an answer — retailer, name, price, link —
   before typing anything. It is never mistaken for the answer itself:
   the rows are labelled exactly as they are anywhere else, and the whole
   block steps aside the moment a real search runs. */
(function preview() {
  const grid = document.getElementById('preview-grid');
  if (!grid || typeof Products === 'undefined') return;
  const note = document.getElementById('preview-note');

  Products.subscribe(() => {
    const items = Products.all().slice(0, 4);
    if (note) note.innerHTML = sampleNote(items);
    grid.innerHTML = items.map(productCard).join('');
    bindImageFallback(grid);
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
