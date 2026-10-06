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


const artSvg = (item) =>
  `<svg class="silhouette" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapeOf(item)}</svg>`;

/* photo when the product has one, drawn artwork otherwise. The tile is
   the same neutral either way, so replacing a failed photo with artwork
   needs no style changes.

   referrerpolicy="no-referrer" because these photos are hosted by
   somebody else. A browser sends this site's origin with an image
   request by default, and a host that refuses foreign referrers answers
   that with a 403 the page cannot see — the photo simply never
   arrives. Sending no referrer removes the only thing such a host could
   object to, gains us nothing to lose, and tells a third-party CDN
   nothing about who is looking. It applies to the photo only: the
   card's LINK still carries a referrer, because that is a retailer we
   are sending a shopper to. */
function media(item, badge) {
  const inner = item.imageUrl
    ? `<img src="${esc(item.imageUrl)}" alt="${esc(item.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${esc(item.id)}">`
    : artSvg(item);
  return `<div class="item-media">${inner}${badge || ''}</div>`;
}

/* a dead image URL leaves drawn artwork in its place rather than a broken
   image icon, so a feed carrying stale photo links still renders.

   The store is asked for the item because a catalogue row knows its
   category, and the category chooses the garment that gets drawn. It is
   asked, not required: live search results are rendered straight from
   the API reply and never enter the store, so byId finds nothing for
   them. Standing on that lookup is what left a failed live photo as a
   blank tile — every product the search returns has an image URL, the
   gate drops the ones that do not, so this path only ever runs on live
   results. Without a category the drawn garment is the default one,
   which is the same artwork a category-less catalogue row would get. */
function bindImageFallback(root, onFail) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      /* a page that must never show artwork in place of a photo (the
         Discover shelves) takes the failure itself */
      if (onFail && onFail(img.dataset.fallback)) return;
      const item = Products.byId(img.dataset.fallback) || { category: '' };
      img.outerHTML = artSvg(item);
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

/* Where the piece is sold: the retailer when the source names one that
   is not already the top line, otherwise the site the link goes to. */
function soldAt(item, seller) {
  if (item.retailer && item.retailer !== seller) return item.retailer;
  try { return new URL(item.productUrl).hostname.replace(/^www\d?\./, ''); } catch (e) { return ''; }
}

/* One card, one shape, everywhere it is used:

     image -> brand -> name -> price -> retailer

   Nothing else. The top line is the name the piece is sold under — its
   brand where the source gives one, otherwise the retailer — and the
   last line says where the link goes. A placeholder row carries the
   Sample badge on its picture and links nowhere. */
function productCard(item) {
  const linked = Boolean(item.productUrl);
  const tag = linked ? 'a' : 'article';
  const attrs = linked ? ` href="${esc(item.productUrl)}" target="_blank" rel="noopener noreferrer"` : '';
  const named = item.brand || item.retailer || '';
  const where = linked ? soldAt(item, named) : '';
  /* a maker nobody established is left unsaid, never guessed: the top
     line then names where it is sold, and is not said twice */
  const seller = named || where;
  const price = formatPrice(item.price);

  return `<${tag} class="item-card"${attrs}>
    ${media(item, linked ? '' : SAMPLE_BADGE)}
    <div class="item-body">
      <p class="item-retailer">${esc(seller)}</p>
      <h3 class="item-name">${esc(item.name)}</h3>
      <p class="item-price${price ? '' : ' item-price--none'}">${price || 'Price at retailer'}</p>
      ${where && where !== seller ? `<p class="item-seller">${esc(where)}</p>` : ''}
      ${linked ? '<span class="sr-only">(opens in a new tab)</span>' : ''}
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

/* ---------- mobile navigation ---------- */
(function nav() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;

  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    links.classList.toggle('open', open);
  };

  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));

  document.addEventListener('click', (e) => {
    if (!links.classList.contains('open')) return;
    if (e.target.closest('.nav')) return;
    setOpen(false);
  });

  /* Escape closes the menu and hands focus back to the button that
     opened it, so a keyboard user is never left inside a closed panel */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !links.classList.contains('open')) return;
    setOpen(false);
    toggle.focus();
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
  /* the demo recording sits where the results will; it steps aside for them */
  const demo = document.getElementById('demo');
  /* the words the shopper used, echoed under the outcome so the answer
     is always read against the question */
  let asked = '';

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

  /* Rows from the demo catalogue are marked as such beside the count.
     Live rows need no marker: they are what a search is. */
  const SAMPLE_STATUS = '<span class="status status--sample">Sample data</span>';

  /* Every result state opens the same way: the outcome, then the
     request it answers in smaller type. */
  const resultsHead = (heading, status) => `<div class="results-head">
      <h2>${heading}${status ? ` ${status}` : ''}</h2>
      ${asked ? `<p class="results-query">Results for <q>${esc(asked)}</q></p>` : ''}
    </div>`;

  /* Verified records from the product source. Every field shown came from
     the source and passed the gate in api/_providers/product-source.js. */
  function renderProducts(found, outcome) {
    const notice = outcome.source !== 'openai' && outcome.notice
      ? `<p class="notice" role="status">${esc(outcome.notice)}</p>` : '';

    const count = `${found.products.length} ${found.products.length === 1 ? 'piece' : 'pieces'} found`;
    results.innerHTML = `${resultsHead(count)}
      ${notice}
      <div class="grid">${found.products.map(productCard).join('')}</div>`;
    bindImageFallback(results);
    announce(`${found.products.length} ${found.products.length === 1 ? 'piece' : 'pieces'} found.`);
  }

  /* When a plan's allowance is what ran out, the reset is the useful
     part of the answer: "tomorrow" is a wait, "the 1st" is a decision.
     Dates are written in the shopper's own locale; the server sends the
     instant, not a rendered string. */
  function resetsIn(usage) {
    if (!usage || !usage.resetsAt) return '';
    const when = new Date(usage.resetsAt);
    if (Number.isNaN(when.getTime())) return '';
    return usage.period === 'month'
      ? ` Your allowance resets on ${when.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.`
      : ` Your allowance resets at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`;
  }

  /* A configured source that returned nothing, or a plan with nothing
     left. The request stays at the top, so it is clear what was searched
     for, and the reason is stated plainly instead of being filled with
     placeholder products. */
  function renderNothing(found, outcome) {
    const empty = found.state === 'empty';
    const limited = found.state === 'limit';

    /* the heading names the outcome, the panel names the next move, and
       the reason is given once — no line on the page repeats another */
    const heading = limited ? 'No searches left' : empty ? 'No matches found' : 'Product search unavailable';
    const next = limited
      ? 'This is a limit on your plan, not a problem with your request'
      : empty ? 'Try describing it a little differently' : 'Try again in a moment';
    const detail = (found.notice || (empty
      ? 'Nothing came back that could be verified for this request.'
      : 'This is a problem on our side, not with your request.')) + (limited ? resetsIn(found.usage) : '');

    /* offered only when a bigger plan would actually help — the server
       says so; the page does not decide who should be sold to */
    const action = `<p class="empty-action">${limited && found.upgrade
      ? '<a class="btn btn-primary" href="pricing.html">See plans</a>' : ''}<a class="btn btn-secondary" href="#search">Try another search</a></p>`;

    results.innerHTML = `${resultsHead(heading)}
      <div class="empty">
        <h3>${esc(next)}</h3>
        <p>${esc(detail)}</p>
        ${action}
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

    /* ranked by the same function the tests and the search benchmark
       put to it: see Products.rank in products.js */
    const scored = Products.rank(Products.all().filter(withinBudget), prefs).slice(0, 8);

    /* said plainly when the shown items are samples, not real listings */
    const sourceNotice = found && found.notice
      ? `<p class="notice" role="status">${esc(found.notice)}</p>` : '';

    /* never let a local keyword match read as an AI interpretation */
    const notice = outcome && outcome.source !== 'openai' && outcome.notice
      ? `<p class="notice" role="status">${esc(outcome.notice)}</p>` : '';

    if (!scored.length) {
      results.innerHTML = `${resultsHead('No matches yet')}
        ${notice}
        ${sourceNotice}
        <div class="empty">
          <h3>Try describing it a little differently</h3>
          <p>Nothing in the catalogue fits that request. Asking for something broader usually helps.</p>
          <p class="empty-action"><a class="btn btn-secondary" href="#search">Try another search</a></p>
        </div>`;
      announce('No matches yet. Try describing it a little differently, or ask for something broader.');
      return;
    }

    const picked = `${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you`;
    /* these rows are the demo catalogue; it is only called sample data
       when placeholder rows are actually among them */
    const status = scored.some((item) => !item.productUrl) ? SAMPLE_STATUS : '';
    results.innerHTML = `${resultsHead(picked, status)}
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
    /* the sample row on the home page steps aside: once a real search is
       running, the page has something better to put in that space */
    if (preview) preview.hidden = true;
    if (demo) demo.hidden = true;
    results.hidden = false;
    asked = query;
    results.innerHTML = `<div class="results-head">
        <h2 class="thinking">Searching\u2026</h2>
        <p class="results-query">Results for <q>${esc(query)}</q></p>
      </div>
      <div class="grid">${SKELETON.repeat(4)}</div>`;
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
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('a[href="#search"], a[href="index.html#search"]')) return;
    window.setTimeout(() => input.focus({ preventScroll: true }), 400);
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

  /* A request handed over in the address — find-clothes.html?q=… — runs
     exactly as if it had been typed
     and submitted, once the catalogue is in the store (the interpreter
     is handed the catalogue's vocabulary), and is then taken out of the
     address so that reloading the page, or coming Back to it, does not
     spend another search from the shopper's allowance. */
  const handed = new URLSearchParams(window.location.search).get('q');
  if (handed && handed.trim()) {
    const address = new URL(window.location.href);
    address.searchParams.delete('q');
    window.history.replaceState(window.history.state, '', address.pathname + address.search + address.hash);
    let ran = false;
    Products.subscribe(() => {
      if (ran) return;
      ran = true;
      input.value = handed.trim().slice(0, Number(input.getAttribute('maxlength')) || 400);
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
    results.hidden = true;
    results.innerHTML = '';
    if (preview) preview.hidden = false;
    if (demo) demo.hidden = false;
    input.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
})();

/* ---------- what a result looks like ----------
   The home page carries two short rows of catalogue rows, so a first-time
   visitor can see the shape of an answer — retailer, name, price, link —
   before typing anything. It is never mistaken for the answer itself:
   the rows are labelled exactly as they are anywhere else, and the whole
   block steps aside the moment a real search runs. */
(function preview() {
  const grid = document.getElementById('preview-grid');
  if (!grid || typeof Products === 'undefined') return;
  const note = document.getElementById('preview-note');

  Products.subscribe(() => {
    const items = Products.all().slice(0, 8);
    if (note) note.innerHTML = sampleNote(items);
    grid.innerHTML = items.map(productCard).join('');
    bindImageFallback(grid);
  });
})();

/* ---------- discover ----------
   Drawn entirely from DISCOVER in assets/discover-data.js, so a new way
   to browse is a new entry there and no change here.

   Discover filters the catalogue that is already on the page, and
   nothing else. No part of it searches: it never calls /api/search, the
   AI reader or any product source, never builds a query, never opens
   the search page, and never spends a search from the shopper's plan.
   Every pill, idea, way in and shelf is a filter over Products.all().

   Only a catalogue row whose card is true in every field, and whose
   photograph really arrives, is ever shown: `identified` says its name
   and brand were tied to its listing (scripts/audit-catalog.js re-proves
   every such note), and its photo is asked of the browser exactly as
   the card asks for it. Drawn artwork never stands in for a photo here.

   What is offered changes from day to day — the ideas, the ways in and
   the shelves are each put in an order seeded by the date — and the two
   shuffle buttons page through the rest of each pool. Within a day the
   page is stable, so it reads the same on a second visit. */
(function discover() {
  const panel = document.getElementById('discover-panel');
  if (!panel || typeof DISCOVER === 'undefined' || typeof Products === 'undefined') return;

  const tabs = document.getElementById('discover-tabs');
  const ideas = document.getElementById('discover-ideas');
  const ideasCaption = document.getElementById('ideas-caption');
  const edits = document.getElementById('discover-edits');
  const status = document.getElementById('discover-status');
  const results = document.getElementById('discover-results');
  const resultsCount = document.getElementById('results-count');
  const resultsBody = document.getElementById('results-body');
  const activeList = document.getElementById('active-filters');
  const shelvesA = document.getElementById('discover-shelves-a');
  const shelvesB = document.getElementById('discover-shelves-b');
  const DAY = Math.floor(Date.now() / 864e5);

  /* a small seeded generator (mulberry32), so an order is the same all
     day and different the next */
  function seeded(seed) {
    let t = seed >>> 0;
    return () => {
      t = (t + 0x6D2B79F5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(list, seed) {
    const rand = seeded(seed);
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /* the turn-th run of `size` items through a pool, wrapping at the end,
     so pressing shuffle walks through everything before repeating */
  const windowOf = (pool, size, turn) => (pool.length
    ? Array.from({ length: Math.min(size, pool.length) }, (_, i) => pool[(turn * size + i) % pool.length]) : []);

  const announce = (text) => { if (status) status.textContent = text; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* ---------- matching, against the product's own proved fields ----------
     See the header of assets/discover-data.js for what each filter may
     read. Words are matched whole, against the product's own name, so
     "shirt" is not "t-shirt" or "sweatshirt", and a plural finds its
     singular; "=shorts" matches only "shorts", never "short sleeve". */
  const tokensOf = (text) => String(text || '').toLowerCase()
    .replace(/\bt[\s-]?shirt(s?)\b/g, 'tshirt$1')
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

  const sameWord = (have, want, exact) => have === want
    || (!exact && (have + 's' === want || have + 'es' === want || want + 's' === have || want + 'es' === have));

  function nameSays(tokens, phrase) {
    const exact = phrase.startsWith('=');
    const want = tokensOf(phrase);
    if (!want.length) return false;
    for (let i = 0; i + want.length <= tokens.length; i++) {
      if (want.every((w, k) => sameWord(tokens[i + k], w, exact))) return true;
    }
    return false;
  }

  const lower = (list) => (list || []).map((v) => String(v).toLowerCase());
  const tokenCache = new Map();
  const nameTokens = (item) => {
    if (!tokenCache.has(item.id)) tokenCache.set(item.id, tokensOf(item.name));
    return tokenCache.get(item.id);
  };

  /* everything in one filter must hold */
  function matches(item, spec) {
    if (!spec) return false;
    if (spec.maxPrice != null && !(item.price != null && item.price < spec.maxPrice)) return false;
    if (spec.minPrice != null && !(item.price != null && item.price >= spec.minPrice)) return false;
    if (spec.words && !spec.words.some((w) => nameSays(nameTokens(item), w))) return false;
    if (spec.brands && !(item.brand && lower(spec.brands).includes(item.brand.toLowerCase()))) return false;
    if (spec.styles && !lower(item.styles).some((v) => lower(spec.styles).includes(v))) return false;
    if (spec.occasions && !lower(item.occasions).some((v) => lower(spec.occasions).includes(v))) return false;
    return true;
  }

  /* ---------- the index: every entry, with the filter it stands for ---------- */
  const dimensions = DISCOVER.dimensions;
  const DEFAULT = {
    words: (label) => ({ words: [label] }),
    styles: (label) => ({ styles: [label] }),
    occasions: (label) => ({ occasions: [label] }),
    brands: (label) => ({ brands: [label] })
  };
  const entries = new Map();
  const byRef = new Map();
  function entryFor(dimension, group, raw) {
    const [label, given, chip] = Array.isArray(raw) ? raw : [raw];
    const spec = Array.isArray(raw) && raw.length > 1 ? given
      : (dimension.match && DEFAULT[dimension.match] ? DEFAULT[dimension.match](label) : null);
    const key = `${dimension.id}|${group}|${label}`;
    const entry = { key, dim: dimension.id, label, chip: chip || label, spec };
    entries.set(key, entry);
    if (!byRef.has(`${dimension.label}/${label}`)) byRef.set(`${dimension.label}/${label}`, entry);
    return entry;
  }
  const groupsOf = new Map(dimensions.map((d) => [d.id, d.groups.map((g) => ({
    label: g.label,
    entries: g.entries.map((raw) => entryFor(d, g.label, raw))
  }))]));

  /* the rows Discover may show: proved, linked and photographed, and —
     once their photos have answered — only those whose photo arrived */
  let provable = [];
  let pool = null;
  const rows = () => pool || provable;

  /* a brand dimension also offers every proved brand the catalogue
     holds, so a maker the editorial list does not name is still there */
  function brandGroup(dimension) {
    if (!dimension.catalogueBrands) return [];
    const listed = new Set(dimension.groups.flatMap((g) => g.entries.map((e) => String(Array.isArray(e) ? e[0] : e).toLowerCase())));
    const brands = [...new Set(rows().map((item) => item.brand).filter(Boolean))]
      .filter((b) => !listed.has(b.toLowerCase())).sort((a, b) => a.localeCompare(b));
    return brands.length ? [{ label: dimension.catalogueBrands, entries: brands.map((b) => entryFor(dimension, dimension.catalogueBrands, b)) }] : [];
  }

  /* entries chosen in one direction are alternatives; across directions,
     every direction must be met */
  function filterBy(keys) {
    const byDim = new Map();
    keys.forEach((key) => {
      const entry = entries.get(key);
      if (!entry || !entry.spec) return;
      if (!byDim.has(entry.dim)) byDim.set(entry.dim, []);
      byDim.get(entry.dim).push(entry.spec);
    });
    if (!byDim.size) return [];
    return rows().filter((item) => [...byDim.values()].every((specs) => specs.some((spec) => matches(item, spec))));
  }

  const available = (entry) => Boolean(entry && entry.spec) && rows().some((item) => matches(item, entry.spec));

  /* an idea, a way in or a shelf applies a set of index entries, and is
     offered as a filter only if every one of them exists and, together,
     they match something the catalogue holds */
  function resolve(refs) {
    const found = (refs || []).map((ref) => byRef.get(ref));
    return found.length && found.every(Boolean) ? found.map((entry) => entry.key) : null;
  }
  const answerable = (keys) => Boolean(keys) && filterBy(keys).length > 0;

  /* ---------- what is chosen ---------- */
  const active = new Set();

  function apply(keys, reveal) {
    active.clear();
    keys.forEach((key) => active.add(key));
    paintFilters();
    if (reveal && results && !results.hidden) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toggle(key) {
    if (active.has(key)) active.delete(key);
    else active.add(key);
    paintFilters();
  }

  /* ---------- try asking ---------- */
  const IDEAS_SHOWN = 12;
  const IDEAS_FILTERING = 8;
  const ideaPool = shuffled(DISCOVER.ideas.map((idea) => (typeof idea === 'string' ? { text: idea } : idea)), DAY);
  let ideaTurn = 0;
  function paintIdeas() {
    if (!ideas) return;
    const live = [];
    const words = [];
    ideaPool.forEach((idea) => {
      const keys = resolve(idea.filters);
      if (answerable(keys)) live.push({ text: idea.text, keys });
      else words.push(idea);
    });
    const shown = windowOf(live, IDEAS_FILTERING, ideaTurn);
    const rest = windowOf(words, IDEAS_SHOWN - shown.length, ideaTurn);
    ideas.innerHTML = shown.map((idea) =>
      `<button class="idea" type="button" data-apply="${esc(idea.keys.join('\n'))}">${esc(idea.text)}</button>`).join('')
      + rest.map((idea) => `<span class="idea idea--note">${esc(idea.text)}</span>`).join('');
    if (ideasCaption) {
      ideasCaption.textContent = live.length
        ? 'Outlined ideas filter the catalogue. The rest are ideas it does not hold yet.'
        : 'None of these are in the catalogue yet.';
    }
  }
  const ideasShuffle = document.getElementById('ideas-shuffle');
  if (ideasShuffle) {
    ideasShuffle.addEventListener('click', () => {
      ideaTurn += 1;
      paintIdeas();
      announce('Showing other ideas.');
    });
  }

  /* ---------- browse by ---------- */
  let current = dimensions[0].id;
  const count = document.getElementById('index-count');

  tabs.innerHTML = dimensions.map((d) =>
    `<button class="tab" type="button" role="tab" id="tab-${esc(d.id)}" aria-controls="discover-panel" data-dimension="${esc(d.id)}">${esc(d.label)}</button>`).join('');

  const pillHtml = (entry) => (available(entry)
    ? `<li><button class="pill" type="button" data-key="${esc(entry.key)}" aria-pressed="${active.has(entry.key)}">${esc(entry.label)}</button></li>`
    : `<li><span class="pill pill--unavailable" title="Nothing in the catalogue matches this yet">${esc(entry.label)}<span class="sr-only"> (nothing in the catalogue yet)</span></span></li>`);

  function paintPanel() {
    const dimension = dimensions.find((d) => d.id === current);
    tabs.querySelectorAll('.tab').forEach((tab) => {
      const on = tab.dataset.dimension === current;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `tab-${current}`);
    const groups = brandGroup(dimension).concat(groupsOf.get(dimension.id));
    panel.innerHTML = (dimension.note ? `<p class="discover-caption">${esc(dimension.note)}</p>` : '')
      + groups.map((group) => `<div class="index-group">
        <h3 class="index-label">${esc(group.label)}</h3>
        <ul class="index-pills">${group.entries.map(pillHtml).join('')}</ul>
      </div>`).join('');
  }

  function paintCount() {
    if (!count) return;
    const all = [...groupsOf.values()].flat().flatMap((g) => g.entries);
    const live = all.filter(available).length;
    count.textContent = `${live} of ${all.length} starting points match products in Fynd’s catalogue. Choose any to filter it instantly.`;
  }

  function choose(tab, focus) {
    if (!tab) return;
    current = tab.dataset.dimension;
    paintPanel();
    if (focus) tab.focus();
  }
  tabs.addEventListener('click', (e) => choose(e.target.closest('.tab')));

  /* the arrow keys move along the tabs, as a tab list is expected to */
  tabs.addEventListener('keydown', (e) => {
    const all = [...tabs.querySelectorAll('.tab')];
    const at = all.findIndex((t) => t.dataset.dimension === current);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    choose(all[(to + all.length) % all.length], true);
  });

  panel.addEventListener('click', (e) => {
    const pill = e.target.closest('button.pill[data-key]');
    if (pill) toggle(pill.dataset.key);
  });

  /* ---------- ways in ---------- */
  const EDITS_SHOWN = 8;
  const editPool = shuffled(DISCOVER.edits, DAY + 1);
  let editTurn = 0;
  function paintEdits() {
    if (!edits) return;
    edits.innerHTML = windowOf(editPool, EDITS_SHOWN, editTurn).map((edit) => {
      const keys = resolve(edit.filters);
      const title = answerable(keys)
        ? `<button class="edit-apply" type="button" data-apply="${esc(keys.join('\n'))}">${esc(edit.title)}</button>`
        : esc(edit.title);
      const more = (edit.more || []).map((item) => {
        const [text, refs] = Array.isArray(item) ? item : [item, null];
        const own = resolve(refs);
        return answerable(own)
          ? `<li><button class="edit-apply edit-apply--more" type="button" data-apply="${esc(own.join('\n'))}">${esc(text)}</button></li>`
          : `<li><span class="edit-idea">${esc(text)}</span></li>`;
      }).join('');
      return `<li class="edit-card">
        <p class="eyebrow">${esc(edit.kicker)}</p>
        <h3 class="edit-title">${title}</h3>
        ${edit.note ? `<p class="edit-note">${esc(edit.note)}</p>` : ''}
        <ul class="edit-more">${more}</ul>
      </li>`;
    }).join('');
  }
  const editsShuffle = document.getElementById('edits-shuffle');
  if (editsShuffle) {
    editsShuffle.addEventListener('click', () => {
      editTurn += 1;
      paintEdits();
      announce('Showing other ways in.');
    });
  }

  /* ideas, ways in and shelves all apply their filters the same way */
  document.getElementById('main').addEventListener('click', (e) => {
    const button = e.target.closest('[data-apply]');
    if (!button) return;
    apply(button.dataset.apply.split('\n'), true);
  });

  /* ---------- the filtered catalogue ---------- */
  function paintResults() {
    if (!results) return;
    const on = active.size > 0;
    results.hidden = !on;
    /* the shelves are the page unfiltered; a filter replaces them */
    if (shelvesA) shelvesA.hidden = on;
    if (shelvesB) shelvesB.hidden = on;
    if (!on) {
      activeList.innerHTML = '';
      resultsBody.innerHTML = '';
      resultsCount.textContent = '';
      return;
    }

    activeList.innerHTML = [...active].map((key) => entries.get(key)).filter(Boolean).map((entry) =>
      `<li><button class="pill" type="button" aria-pressed="true" data-remove="${esc(entry.key)}">${esc(entry.chip)}<span aria-hidden="true"> ×</span><span class="sr-only"> (remove)</span></button></li>`).join('');

    if (!pool) {
      resultsCount.textContent = 'Checking the catalogue…';
      resultsBody.innerHTML = `<div class="grid">${SKELETON.repeat(4)}</div>`;
      return;
    }
    const found = filterBy([...active]);
    resultsCount.textContent = found.length ? plural(found.length, 'result', 'results') : 'No matching products';
    resultsBody.innerHTML = found.length
      ? `${sampleNote(found)}<div class="grid">${found.map(productCard).join('')}</div>`
      : `<div class="empty">
          <h3>Nothing in the catalogue matches all of these</h3>
          <p>Remove a filter to see more.</p>
        </div>`;
    bindImageFallback(resultsBody, lostPhoto);
    announce(resultsCount.textContent + '.');
  }

  if (activeList) {
    activeList.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-remove]');
      if (chip) toggle(chip.dataset.remove);
    });
  }
  const clear = document.getElementById('results-clear');
  if (clear) clear.addEventListener('click', () => apply([], false));

  /* ---------- shelves of real catalogue rows ---------- */
  const SHELF_SIZE = 4;
  const SHELVES_SHOWN = 6;

  /* Fills one shelf, best first: a row no earlier shelf has shown, of a
     kind and from a brand this shelf does not have yet. Rows are only
     repeated when a shelf cannot be filled without them, so the page
     shows as much of the catalogue, and as many different things, as it
     can. */
  /* who a piece is from, for variety's sake: its brand, or the store it
     is sold at when no brand is known */
  const maker = (item) => item.brand || soldAt(item, '');

  function fill(candidates, shown) {
    const picked = [];
    const kinds = new Set();
    const brands = new Set();
    const cost = (item) => (shown.has(item.id) ? 4 : 0) + (kinds.has(item.category) ? 2 : 0) + (brands.has(maker(item)) ? 1 : 0);
    const left = candidates.slice();
    while (picked.length < SHELF_SIZE && left.length) {
      let best = 0;
      for (let i = 1; i < left.length; i++) if (cost(left[i]) < cost(left[best])) best = i;
      const [item] = left.splice(best, 1);
      picked.push(item);
      kinds.add(item.category);
      brands.add(maker(item));
    }
    return picked;
  }

  /* The most different pieces a set of shelves can show between them: a
     card slot per place on each shelf, and each row matched to at most
     one slot (augmenting paths; a few dozen of each, so it is instant).
     Rows are tried in today's order, so which of several equally good
     answers is shown changes from day to day. */
  function match(shelves) {
    const slots = shelves.flatMap((one, at) => Array.from({ length: SHELF_SIZE }, () => at));
    const holder = new Map();
    const placed = new Array(slots.length).fill(null);
    const place = (slot, tried) => shelves[slots[slot]].candidates.some((item) => {
      if (tried.has(item.id)) return false;
      tried.add(item.id);
      const other = holder.get(item.id);
      if (other !== undefined && !place(other, tried)) return false;
      placed[slot] = item;
      holder.set(item.id, slot);
      return true;
    });
    slots.forEach((_, slot) => place(slot, new Set()));
    return { distinct: holder.size, placed, slots };
  }

  /* every way of choosing k of the n shelves the catalogue can fill */
  function* choices(n, k, from = 0, taken = []) {
    if (taken.length === k) { yield taken; return; }
    for (let i = from; i <= n - (k - taken.length); i++) yield* choices(n, k, i + 1, taken.concat(i));
  }

  /* Today's shelves: of the sets of SHELVES_SHOWN the catalogue can fill,
     the one that shows the most different pieces, and among those the
     one nearest today's order. Each shelf gets its matched rows, is
     topped up (repeating only when it must) and put in an order that
     starts with different kinds from different makers, since a phone
     shows only the first two. */
  function arrange(fillable) {
    let best = null;
    for (const set of choices(fillable.length, Math.min(SHELVES_SHOWN, fillable.length))) {
      const shelves = set.map((i) => fillable[i]);
      const result = match(shelves);
      const rank = set.reduce((sum, i) => sum + i, 0);
      if (!best || result.distinct > best.result.distinct || (result.distinct === best.result.distinct && rank < best.rank)) {
        best = { shelves, result, rank };
      }
    }
    if (!best) return [];
    const shown = new Set(best.result.placed.filter(Boolean).map((item) => item.id));
    return best.shelves.map((one, at) => {
      const own = best.result.placed.filter((item, slot) => item && best.result.slots[slot] === at);
      const more = fill(one.candidates.filter((item) => !own.includes(item)), shown).slice(0, SHELF_SIZE - own.length);
      return { shelf: one.shelf, keys: one.keys, total: one.candidates.length, picked: fill(own.concat(more), new Set()) };
    });
  }

  const shelfHtml = ({ shelf, keys, total, picked }, n) => `<section class="discover-block shelf" aria-labelledby="shelf-${n}">
      <div class="section-head">
        <div>
          <p class="eyebrow">${esc(shelf.kicker)}</p>
          <h2 id="shelf-${n}">${esc(shelf.title)}</h2>
        </div>
        <button class="link-btn head-link" type="button" data-apply="${esc(keys.join('\n'))}">See all ${total}<span class="sr-only">: ${esc(shelf.title)}</span></button>
      </div>
      ${sampleNote(picked)}
      <div class="grid shelf-grid">${picked.map(productCard).join('')}</div>
    </section>`;

  function paintShelves() {
    if (!shelvesA || !shelvesB) return;
    if (!pool) { shelvesA.innerHTML = shelvesB.innerHTML = ''; return; }
    const ordered = shuffled(pool, DAY + 2);
    const today = shuffled(DISCOVER.shelves, DAY + 3)
      .map((shelf) => {
        const keys = resolve(shelf.filters);
        const found = keys ? new Set(filterBy(keys).map((item) => item.id)) : new Set();
        return { shelf, keys, candidates: ordered.filter((item) => found.has(item.id)) };
      })
      .filter((one) => one.keys && one.candidates.length >= SHELF_SIZE);
    const drawn = arrange(today);
    /* half the shelves before the ways in and half after, so the
       photographs and the words take turns down the page */
    const half = Math.ceil(drawn.length / 2);
    shelvesA.innerHTML = drawn.slice(0, half).map((one, i) => shelfHtml(one, i)).join('');
    shelvesB.innerHTML = drawn.slice(half).map((one, i) => shelfHtml(one, i + half)).join('');
    bindImageFallback(shelvesA, lostPhoto);
    bindImageFallback(shelvesB, lostPhoto);
  }

  /* ---------- photos, asked of the browser the way the card asks ----------
     A photo that fails, or comes back too small to be a product
     photograph (a tracking pixel, a "no image" stub), keeps its row off
     Discover entirely; if one fails after it was shown, everything is
     drawn again without it. */
  const MIN_PHOTO = 200;
  const PHOTO_WAIT = 10000;
  const photos = new Map();

  function photoArrives(item) {
    if (!photos.has(item.id)) {
      photos.set(item.id, new Promise((resolveIt) => {
        const probe = new Image();
        const settle = (ok) => {
          clearTimeout(timer);
          probe.onload = probe.onerror = null;
          resolveIt(ok);
        };
        const timer = setTimeout(() => settle(false), PHOTO_WAIT);
        probe.referrerPolicy = 'no-referrer';
        probe.onload = () => settle(probe.naturalWidth >= MIN_PHOTO && probe.naturalHeight >= MIN_PHOTO);
        probe.onerror = () => settle(false);
        probe.src = item.imageUrl;
      }));
    }
    return photos.get(item.id);
  }

  function lostPhoto(id) {
    photos.set(id, Promise.resolve(false));
    if (pool) pool = pool.filter((item) => item.id !== id);
    paintAll();
    return true;
  }

  function paintFilters() {
    paintPanel();
    paintResults();
  }

  function paintAll() {
    paintIdeas();
    paintCount();
    paintPanel();
    paintEdits();
    paintShelves();
    paintResults();
  }

  let settling = 0;
  async function settle() {
    const turn = ++settling;
    provable = Products.all().filter((item) => item.identified && item.productUrl && item.imageUrl);
    pool = null;
    paintAll();
    const arrived = await Promise.all(provable.map(photoArrives));
    /* the store changed while this one was waiting */
    if (turn !== settling) return;
    pool = provable.filter((_, i) => arrived[i]);
    paintAll();
  }

  paintAll();
  Products.subscribe(settle);
})();

/* ---------- data source ----------
   The one line to change when a real feed, API or database replaces the
   demo catalogue. Everything above renders whatever arrives. */
(function boot() {
  if (typeof Products === 'undefined') return;
  Products.load(typeof DEMO_PRODUCTS === 'undefined' ? [] : DEMO_PRODUCTS);
})();
