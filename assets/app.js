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
   grid arrives in place instead of appearing out of nothing. It is built
   from the card's own parts — the 4:5 picture, then the brand, a name of
   two lines, the price and where it is sold — so every line sits where
   the real one will, at every width the card is drawn at. It carries no
   text: there is nothing true to say yet. The lines are as long as real
   ones tend to be, and no two cards are alike; the lengths come from a
   fixed table, so the same grid is drawn the same way every time. */
const PLACEHOLDER_LINES = [
  [46, 94, 58, 24, 42], [34, 88, 71, 21, 30], [52, 97, 44, 27, 38], [40, 83, 66, 23, 46],
  [30, 91, 52, 26, 34], [48, 86, 74, 22, 40], [38, 95, 49, 25, 28], [44, 80, 62, 28, 36]
];
function skeletons(count) {
  const bar = (width) => `<span class="skeleton-bar" style="--w:${width}%"></span>`;
  return Array.from({ length: count }, (_, i) => {
    const [brand, name, rest, price, seller] = PLACEHOLDER_LINES[i % PLACEHOLDER_LINES.length];
    return `<div class="skeleton-card" style="--i:${i}">
      <div class="item-media skeleton-media"></div>
      <div class="item-body">
        <p class="item-retailer">${bar(brand)}</p>
        <p class="item-name">${bar(name)}${bar(rest)}</p>
        <p class="item-price">${bar(price)}</p>
        <p class="item-seller">${bar(seller)}</p>
      </div>
    </div>`;
  }).join('');
}

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
    const body = paint(resultsHead(count), `${notice}
      <div class="grid">${found.products.map(productCard).join('')}</div>`, 'products');
    arrive(body);
    bindImageFallback(body);
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

    paint(resultsHead(heading), `<div class="empty">
        <h3>${esc(next)}</h3>
        <p>${esc(detail)}</p>
        ${action}
      </div>`, 'nothing');
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
      paint(resultsHead('No matches yet'), `${notice}
        ${sourceNotice}
        <div class="empty">
          <h3>Try describing it a little differently</h3>
          <p>Nothing in the catalogue fits that request. Asking for something broader usually helps.</p>
          <p class="empty-action"><a class="btn btn-secondary" href="#search">Try another search</a></p>
        </div>`, 'nothing');
      announce('No matches yet. Try describing it a little differently, or ask for something broader.');
      return;
    }

    const picked = `${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you`;
    /* these rows are the demo catalogue; it is only called sample data
       when placeholder rows are actually among them */
    const status = scored.some((item) => !item.productUrl) ? SAMPLE_STATUS : '';
    const body = paint(resultsHead(picked, status), `${notice}
      ${sourceNotice}
      ${sampleNote(scored)}
      <div class="grid">${scored.map(productCard).join('')}</div>`, 'catalogue');
    arrive(body);
    bindImageFallback(body);
    announce(`${scored.length} ${scored.length === 1 ? 'piece' : 'pieces'} picked for you.`);
  }

  /* One short line for anyone not looking at the grid. */
  function announce(text) {
    if (status) status.textContent = text;
  }

  /* ---------- while a search runs ----------
     What the page says while it waits is what is actually happening, and
     it changes only when something actually happened:

       understanding   from the moment the search is sent until the
                       request has been read (/api/interpret, or the
                       local reader when that cannot answer)
       searching       from the moment the reading is back and the
                       product search is sent, until it answers. That
                       one request finds the products AND checks each
                       one through the verification gate, so it is one
                       stage: the page cannot see where one ends and the
                       other begins, and does not pretend to.

     There is no timer anywhere in this. A stage lasts exactly as long as
     the request behind it, so a fast or cached search goes straight to
     its results, and a slow one keeps its current line on screen, with
     a hairline quietly pulsing along the bottom of the search box — never
     a new message invented to fill the wait. Results, an empty answer or
     an error replace all of it the moment they arrive.

     The words are under the box, where the results will be; the hairline
     is in the box, marked by the stage on the form. Both keep their size
     from one stage to the next, so nothing on the page moves while it
     changes. */
  const STAGES = {
    understanding: 'Understanding your request',
    searching: 'Finding matching products'
  };

  function showStage(stage, detail) {
    const head = results.querySelector('.search-progress');
    if (!head) return;
    head.dataset.stage = stage;
    form.dataset.stage = stage;
    const line = document.createElement('span');
    line.className = 'stage-text';
    line.textContent = STAGES[stage];
    head.querySelector('h2').replaceChildren(line);
    /* what Fynd understood, once it has understood something; the
       request as typed until then */
    if (detail) {
      const said = head.querySelector('.results-query');
      const words = document.createElement('span');
      words.className = 'stage-text';
      words.textContent = detail;
      said.replaceChildren(words);
    }
    announce(detail ? `${detail}. ${STAGES[stage]}.` : `${STAGES[stage]}.`);
  }

  /* Smooth unless the shopper has asked for less motion. */
  const still = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const scrolling = () => (still() ? 'auto' : 'smooth');

  /* The two timings the stylesheet sets and this code has to agree with:
     how long a search may take before placeholders are worth showing,
     and the period of the light that passes over them. Read from the
     stylesheet, so they are written once. */
  const timings = getComputedStyle(document.documentElement);
  const ms = (name, fallback) => {
    const value = parseFloat(timings.getPropertyValue(name));
    return Number.isFinite(value) ? value * 1000 : fallback;
  };
  const PLACEHOLDER_WAIT = ms('--placeholder-wait', 160);
  const SWEEP = ms('--sweep', 2400);
  let searchStarted = 0;
  let placeholdersSince = 0;

  /* ---------- painting the results area ----------
     A head — the outcome, and the request it answers — and under it a
     body: placeholders, products, or the reason there are none. A new
     body never simply replaces the one on screen. The old one stays
     exactly where it is, is marked hidden and inert, its cards renamed so
     nothing can take them for results, and fades out under the new one
     — placeholders slot by slot as each product arrives over them, old
     results all at once — and is gone when its fade ends. So nothing
     flashes blank between the two, and the light on the placeholders
     never restarts. Anyone who asks for reduced motion gets the new body
     at once, with nothing leaving. */
  function paintHead(head) {
    const old = results.querySelector(':scope > .results-head');
    const holder = document.createElement('div');
    holder.innerHTML = head;
    if (old) old.replaceWith(...holder.childNodes);
    else results.prepend(...holder.childNodes);
  }

  function paint(head, html, kind) {
    let stage = results.querySelector(':scope > .results-stage');
    if (!stage) {
      results.innerHTML = '<div class="results-stage"></div>';
      stage = results.firstElementChild;
    }
    paintHead(head);
    const before = stage.querySelector(':scope > .results-body:not(.results-leaving)');
    const body = document.createElement('div');
    body.className = 'results-body';
    body.dataset.kind = kind;
    body.innerHTML = html;
    stage.prepend(body);
    /* what the stage now holds: an answer with no products is shorter
       than the placeholders were, and what leaves is kept inside it */
    stage.dataset.kind = kind;
    if (before) retire(before, body);
    return body;
  }

  function retire(old, next) {
    /* placeholders that never got as far as fading in have nothing to
       leave from */
    const unseen = old.dataset.kind === 'placeholders' && performance.now() - placeholdersSince < PLACEHOLDER_WAIT;
    if (still() || unseen) { old.remove(); return; }
    /* each card leaves from wherever its own arrival had got to */
    const cards = old.querySelectorAll('.skeleton-card, .item-card');
    const opacities = Array.from(cards, (card) => getComputedStyle(card).opacity);
    cards.forEach((card, i) => {
      card.style.setProperty('--from', opacities[i]);
      if (card.classList.contains('item-card')) card.classList.replace('item-card', 'item-ghost');
    });
    old.querySelectorAll('[role], [aria-live]').forEach((el) => { el.removeAttribute('role'); el.removeAttribute('aria-live'); });
    /* placeholders stand in the very places the products arrive in;
       anything else fades where it stood */
    const from = old.dataset.kind === 'placeholders' && old.querySelector('.grid');
    const to = next.querySelector('.grid');
    old.style.top = `${from && to ? to.offsetTop - from.offsetTop : 0}px`;
    old.setAttribute('aria-hidden', 'true');
    old.inert = true;
    old.classList.add('results-leaving');
    old.addEventListener('animationend', (e) => { if (e.target === old) old.remove(); });
  }

  /* What arrives comes in composed: the cards in reading order, a beat
     apart, each rising a few pixels as it fades in over the placeholder
     that stood in its place. An answer that came back before any
     placeholder was shown comes in quicker still, so a fast or cached
     search reads as instant. Nothing is held back — every card is in the
     page from the first frame; only its fade is staggered. */
  function arrive(body) {
    const grid = body.querySelector('.grid');
    if (!grid) return;
    Array.from(grid.children).forEach((card, i) => card.style.setProperty('--i', Math.min(i, 9)));
    /* the light on a photo still on its way carries on in step with the
       light that was passing over the placeholders */
    grid.style.setProperty('--phase', `${Math.round((performance.now() - placeholdersSince) % SWEEP)}ms`);
    grid.classList.add('is-revealing');
    if (performance.now() - searchStarted < PLACEHOLDER_WAIT) grid.classList.add('is-quick');
    awaitPhotos(grid);
  }

  /* A photo still downloading keeps the placeholder's light on its tile,
     because it is still on its way; when it arrives it fades in and the
     light fades out under it. A photo the browser already has is shown
     as it is, and one that fails becomes the drawn artwork as before. */
  const AT_ONCE = 120;
  function awaitPhotos(root) {
    const asked = performance.now();
    root.querySelectorAll('.item-media > img').forEach((img) => {
      if (img.complete && img.naturalWidth > 0) return;
      const tile = img.parentElement;
      tile.classList.add('is-pending');
      img.addEventListener('load', () => {
        /* a photo that was there almost at once — the browser had it —
           is simply shown; only one that kept the shopper waiting fades */
        if (performance.now() - asked < AT_ONCE) {
          tile.classList.add('is-at-once');
          tile.classList.remove('is-pending');
          return;
        }
        tile.classList.replace('is-pending', 'is-arriving');
        tile.addEventListener('transitionend', function settled(e) {
          if (e.pseudoElement !== '::after' || e.propertyName !== 'opacity') return;
          tile.removeEventListener('transitionend', settled);
          tile.classList.remove('is-arriving');
        });
      }, { once: true });
      img.addEventListener('error', () => tile.classList.remove('is-pending'), { once: true });
    });
  }

  function showProgress(query) {
    searchStarted = performance.now();
    results.setAttribute('aria-busy', 'true');
    form.classList.remove('is-settling');
    const head = `<div class="results-head search-progress" data-stage="understanding">
        <h2 class="thinking"></h2>
        <p class="results-query">Results for <q>${esc(query)}</q></p>
      </div>`;
    /* a search replaced while it was still running: the placeholders and
       the light carry on exactly as they were, and only the words change */
    if (results.querySelector(':scope > .results-stage > .results-body[data-kind="placeholders"]:not(.results-leaving)')) {
      paintHead(head);
    } else {
      paint(head, `<div class="grid" aria-hidden="true">${skeletons(8)}</div>`, 'placeholders');
      placeholdersSince = searchStarted;
    }
    showStage('understanding');
  }

  /* The search has answered, failed or been dropped: the box stops
     working at once. Its light does not snap off — it keeps moving while
     it fades, and is put to rest when the fade has ended. */
  function endProgress() {
    results.removeAttribute('aria-busy');
    const light = form.querySelector('.ask-progress');
    /* a light that never got as far as showing has nothing to fade */
    if (form.dataset.stage && light && Number(getComputedStyle(light).opacity) > 0) {
      form.classList.add('is-settling');
      const rest = (e) => {
        if (e.target !== light || e.propertyName !== 'opacity') return;
        light.removeEventListener('transitionend', rest);
        light.removeEventListener('transitioncancel', rest);
        if (!form.dataset.stage) form.classList.remove('is-settling');
      };
      light.addEventListener('transitionend', rest);
      light.addEventListener('transitioncancel', rest);
    }
    delete form.dataset.stage;
  }

  /* While a search runs, the box doing the work, the words saying what
     it is doing, and the placeholders where the products will land are
     all on screen as far as the page allows: it moves far enough to bring
     the stage line up and the first row of placeholders into view, and
     never so far that the box goes under the header. The results are
     brought up when they arrive. */
  const header = document.querySelector('.site-header');
  const MARGIN = 16;
  function keepBoxInView() {
    const head = results.querySelector('.search-progress');
    if (!head) return;
    const top = header ? header.getBoundingClientRect().bottom : 0;
    const room = form.getBoundingClientRect().top - top - MARGIN;
    const below = head.getBoundingClientRect().bottom + MARGIN - window.innerHeight;
    const first = results.querySelector('.results-body .skeleton-card');
    const glimpse = first ? first.getBoundingClientRect().top + first.offsetHeight * 0.55 + MARGIN - window.innerHeight : below;
    const by = Math.min(Math.max(below, glimpse, 0), room);
    if (by) window.scrollBy({ top: by, behavior: scrolling() });
  }

  /* ---------- how many live searches are left ----------
     Shown at the bottom of the box before anything is typed, exactly as
     /api/account last counted it: for the account, or signed out, for
     this browser. A bar shows what remains of the allowance — the
     server's remaining over the server's limit — and the words under it
     say the count. Nothing here knows a plan's limit or subtracts a
     search; when the account cannot be read, neither is shown rather
     than a guess.

     While a search runs both are empty — the count they held is about to
     be out of date, and the hairline is what the box shows. When the
     search is over the account is read again and the new count takes its
     place, said once to screen readers after what the search found. */
  const allowance = document.getElementById('ask-allowance');
  const usageLine = document.getElementById('ask-usage');
  const meter = document.getElementById('ask-meter');
  const PERIOD_SAID = { day: 'today', month: 'this month' };
  /* an allowance this small is drawn a step a search; a larger one is one
     smooth fill, never a row of slivers */
  const STEPS_UP_TO = 10;
  let usageAsked = 0;
  let allowanceShown = false;
  let usageSaid = null;

  function allowanceOf(account) {
    const searches = account && account.usage && account.usage.searches;
    const left = searches && searches.remaining;
    if (!Number.isInteger(left) || left < 0) return null;
    const period = PERIOD_SAID[searches.period] ? ` ${PERIOD_SAID[searches.period]}` : '';
    const text = left === 0
      ? `No live searches left${period}`
      : `${left.toLocaleString('en-US')} ${left === 1 ? 'search' : 'searches'} left${period}`;
    /* the bar is a share of the allowance; without one, the words stand alone */
    const limit = Number.isInteger(searches.limit) && searches.limit > 0 ? searches.limit : null;
    return { text, left, limit };
  }

  function drawMeter(reading) {
    if (!meter) return;
    meter.replaceChildren();
    if (!reading || !reading.limit) return;
    const share = Math.min(1, reading.left / reading.limit);
    if (reading.limit <= STEPS_UP_TO) {
      for (let step = 0; step < reading.limit; step += 1) {
        const piece = document.createElement('span');
        piece.className = step < reading.left ? 'ask-meter-step is-left' : 'ask-meter-step';
        meter.appendChild(piece);
      }
      return;
    }
    const track = document.createElement('span');
    track.className = 'ask-meter-track';
    if (share > 0) {
      const fill = document.createElement('span');
      fill.className = 'ask-meter-fill';
      fill.style.setProperty('--share', share);
      track.appendChild(fill);
    }
    meter.appendChild(track);
  }

  function showAllowance(reading) {
    if (!allowance) return;
    usageLine.textContent = reading ? reading.text : '';
    drawMeter(reading);
    allowance.classList.toggle('is-shown', Boolean(reading));
    if (reading) allowanceShown = true;
    /* the space is held for a count; a box that never gets one goes back
       to its own size, and one that has had one keeps the room, so a
       failed re-read moves nothing */
    allowance.hidden = !reading && !allowanceShown;
  }

  /* the count on screen is about to be out of date: show nothing until
     the server has counted again, and drop any reading already asked for */
  function forgetUsage() {
    usageAsked += 1;
    if (!allowance) return;
    usageLine.textContent = '';
    drawMeter(null);
    allowance.classList.remove('is-shown');
  }

  async function readUsage(afterSearch) {
    if (!allowance) return;
    const ask = ++usageAsked;
    let reading = null;
    try {
      const answer = typeof Account === 'undefined' ? null : await Account.load();
      reading = answer && answer.ok ? allowanceOf(answer.data) : null;
    } catch (err) { reading = null; }
    if (ask !== usageAsked || form.dataset.stage) return;
    showAllowance(reading);
    const text = reading && reading.text;
    if (afterSearch && text && usageSaid && text !== usageSaid) announce(`${status ? status.textContent : ''} ${text}.`.trim());
    if (text) usageSaid = text;
  }

  /* a search that was replaced or dropped may still have been counted;
     once nothing else is running, the count is read again, quietly */
  function readUsageIfIdle() {
    if (!form.dataset.stage) readUsage(false);
  }

  /* the search a newer one has replaced, or "Start over" has dropped,
     answers into nothing: it never paints over what is on screen now */
  let latest = 0;

  async function search(query, attached) {
    const run = ++latest;
    error.classList.remove('show');
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    /* the sample row on the home page steps aside: once a real search is
       running, the page has something better to put in that space */
    if (preview) preview.hidden = true;
    if (demo) demo.hidden = true;
    results.hidden = false;
    asked = query;
    showProgress(query);
    forgetUsage();
    keepBoxInView();

    let outcome = null;
    let found;
    try {
      outcome = await Interpreter.interpret(query, vocabulary());
      if (run !== latest) return readUsageIfIdle();

      /* real products first; the sample catalogue only when no source answers */
      if (typeof ProductSearch === 'undefined') {
        found = { source: null, products: [], notice: null };
      } else {
        showStage('searching', Interpreter.describe ? Interpreter.describe(outcome.preferences, query) : null);
        found = await ProductSearch.find(outcome.preferences, undefined, attached);
      }
    } catch (err) {
      /* neither call is meant to throw — each answers with a state — but
         if something does, the search is over and says so, rather than
         leaving the last stage on screen */
      found = { state: 'unavailable', source: null, products: [], notice: null };
    }
    if (run !== latest) return readUsageIfIdle();
    endProgress();
    outcome = outcome || { source: 'local', notice: null, preferences: Interpreter.EMPTY() };

    if (found.products.length) renderProducts(found, outcome);
    /* The sample catalogue stands in only when nothing is connected. Once
       a product source IS configured, a failed or empty search says so —
       a deployment that can sell things must never pad the page with demo
       rows, however clearly they are labelled. */
    else if (found.state === 'not-configured') render(outcome.preferences, outcome, found);
    else renderNothing(found, outcome);
    results.scrollIntoView({ behavior: scrolling(), block: 'start' });
    readUsage(true);
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
    /* a search still running when the shopper starts over answers into
       nothing */
    latest += 1;
    endProgress();
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

  /* what is left, before anything is typed */
  readUsage(false);
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
   Six kinds of clothing, drawn from DISCOVER in assets/discover-data.js:
   choose one and the catalogue already on the page is filtered to it;
   choose a subcategory, or several, and it narrows to those.

   Nothing here searches. Discover never calls /api/search, the AI
   reader or any product source, never builds a query, never opens the
   search page, and never spends a search from the shopper's plan.

   Only a catalogue row whose card is true in every field, and whose
   photograph really arrives, is ever shown: `identified` says its name
   and brand were tied to its listing (scripts/audit-catalog.js re-proves
   every such note), and its photo is asked of the browser exactly as
   the card asks for it. Drawn artwork never stands in for a photo here. */
(function discover() {
  const row = document.getElementById('discover-tabs');
  if (!row || typeof DISCOVER === 'undefined' || typeof Products === 'undefined') return;

  const panel = document.getElementById('discover-panel');
  const status = document.getElementById('discover-status');
  const count = document.getElementById('index-count');
  const results = document.getElementById('discover-results');
  const resultsCount = document.getElementById('results-count');
  const resultsBody = document.getElementById('results-body');
  const activeList = document.getElementById('active-filters');
  const shelves = document.getElementById('discover-shelves');
  const categories = DISCOVER.categories;

  const announce = (text) => { if (status) status.textContent = text; };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /* ---------- matching, on the product's own proved name ----------
     Words are matched whole, so "shirt" is not "t-shirt" or
     "sweatshirt", and a plural finds its singular; "=shorts" matches
     only "shorts", never "short sleeve". */
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

  const tokenCache = new Map();
  const nameTokens = (item) => {
    if (!tokenCache.has(item.id)) tokenCache.set(item.id, tokensOf(item.name));
    return tokenCache.get(item.id);
  };
  const says = (item, words) => (words || []).some((w) => nameSays(nameTokens(item), w));

  /* the rows Discover may show: proved, linked and photographed, and —
     once their photos have answered — only those whose photo arrived */
  let provable = [];
  let pool = null;
  const rows = () => pool || provable;

  const inCategory = (category) => rows().filter((item) => says(item, category.words));
  const inSub = (category, sub) => inCategory(category).filter((item) => says(item, sub.words));
  /* a subcategory is offered only when the catalogue holds something it
     matches; one that matches nothing is not drawn at all */
  const offered = (category) => category.subcategories.filter((sub) => inSub(category, sub).length > 0);

  /* ---------- what is chosen: one category, and any of its subcategories ---------- */
  let chosen = null;
  const subs = new Set();
  const categoryOf = (id) => categories.find((c) => c.id === id) || null;

  function filtered() {
    const category = categoryOf(chosen);
    if (!category) return [];
    if (!subs.size) return inCategory(category);
    const picked = category.subcategories.filter((sub) => subs.has(sub.label));
    /* several subcategories are alternatives: T-shirts or button-downs */
    return inCategory(category).filter((item) => picked.some((sub) => says(item, sub.words)));
  }

  function choose(id, reveal) {
    chosen = chosen === id ? null : id;
    subs.clear();
    paintFilters();
    if (reveal && chosen && results && !results.hidden) results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toggleSub(label) {
    if (label === '') subs.clear();
    else if (subs.has(label)) subs.delete(label);
    else subs.add(label);
    paintFilters();
  }

  function clearAll() {
    chosen = null;
    subs.clear();
    paintFilters();
  }

  /* ---------- the six categories ---------- */
  function paintRow() {
    row.innerHTML = categories.map((category) => {
      const n = inCategory(category).length;
      return n || !pool
        ? `<button class="tab" type="button" data-category="${esc(category.id)}" aria-pressed="${chosen === category.id}">${esc(category.label)}</button>`
        : `<span class="tab tab--empty" title="Nothing in the catalogue yet">${esc(category.label)}<span class="sr-only"> (nothing in the catalogue yet)</span></span>`;
    }).join('');
  }

  function paintPanel() {
    const category = categoryOf(chosen);
    const list = category ? offered(category) : [];
    panel.hidden = !category || !list.length;
    if (panel.hidden) { panel.innerHTML = ''; return; }
    const all = `<li><button class="pill" type="button" data-sub="" aria-pressed="${subs.size === 0}">${esc(category.all || `All ${category.label.toLowerCase()}`)}</button></li>`;
    panel.innerHTML = `<ul class="index-pills">${all}${list.map((sub) =>
      `<li><button class="pill" type="button" data-sub="${esc(sub.label)}" aria-pressed="${subs.has(sub.label)}">${esc(sub.label)}</button></li>`).join('')}</ul>`;
  }

  function paintCount() {
    if (!count || !pool) return;
    count.textContent = `${plural(pool.length, 'product', 'products')} in Fynd’s catalogue across six categories. Choose one to filter it instantly.`;
  }

  row.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-category]');
    if (button) choose(button.dataset.category, false);
  });
  panel.addEventListener('click', (e) => {
    const pill = e.target.closest('button[data-sub]');
    if (pill) toggleSub(pill.dataset.sub);
  });

  /* ---------- the filtered catalogue ---------- */
  function paintResults() {
    const on = Boolean(chosen);
    results.hidden = !on;
    /* the shelves are the page unfiltered; a filter replaces them */
    if (shelves) shelves.hidden = on;
    if (!on) {
      activeList.innerHTML = '';
      resultsBody.innerHTML = '';
      resultsCount.textContent = '';
      return;
    }
    const category = categoryOf(chosen);
    activeList.innerHTML = [`<li><button class="pill" type="button" aria-pressed="true" data-remove-category>${esc(category.label)}<span aria-hidden="true"> ×</span><span class="sr-only"> (remove)</span></button></li>`]
      .concat([...subs].map((label) =>
        `<li><button class="pill" type="button" aria-pressed="true" data-remove="${esc(label)}">${esc(label)}<span aria-hidden="true"> ×</span><span class="sr-only"> (remove)</span></button></li>`)).join('');

    if (!pool) {
      resultsCount.textContent = 'Checking the catalogue…';
      resultsBody.innerHTML = `<div class="grid">${skeletons(4)}</div>`;
      return;
    }
    const found = filtered();
    resultsCount.textContent = found.length ? plural(found.length, 'result', 'results') : 'No matching products';
    resultsBody.innerHTML = found.length
      ? `${sampleNote(found)}<div class="grid">${found.map(productCard).join('')}</div>`
      : `<div class="empty">
          <h3>Nothing in the catalogue is in ${esc(category.label.toLowerCase())} yet</h3>
          <p>Choose another category, or clear the filter.</p>
        </div>`;
    bindImageFallback(resultsBody, lostPhoto);
    announce(resultsCount.textContent + '.');
  }

  activeList.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove-category]')) { clearAll(); return; }
    const chip = e.target.closest('[data-remove]');
    if (chip) toggleSub(chip.dataset.remove);
  });
  document.getElementById('results-clear').addEventListener('click', clearAll);

  /* ---------- shelves: a few of each kind, before any filter ---------- */
  const SHELF_SIZE = 4;

  /* who a piece is from, for variety's sake: its brand, or the store it
     is sold at when no brand is known */
  const maker = (item) => item.brand || soldAt(item, '');

  /* Fills one shelf, best first: a row no other shelf shows, of a kind
     and from a maker this shelf does not have yet. */
  function fill(candidates, shown) {
    const picked = [];
    const kinds = new Set();
    const makers = new Set();
    const cost = (item) => (shown.has(item.id) ? 4 : 0) + (kinds.has(item.category) ? 2 : 0) + (makers.has(maker(item)) ? 1 : 0);
    const left = candidates.slice();
    while (picked.length < SHELF_SIZE && left.length) {
      let best = 0;
      for (let i = 1; i < left.length; i++) if (cost(left[i]) < cost(left[best])) best = i;
      const [item] = left.splice(best, 1);
      picked.push(item);
      kinds.add(item.category);
      makers.add(maker(item));
    }
    return picked;
  }

  const shelfHtml = ({ category, total, picked }, n) => `<section class="discover-block shelf" aria-labelledby="shelf-${n}">
      <div class="section-head">
        <div>
          <h2 id="shelf-${n}">${esc(category.label)}</h2>
        </div>
        <button class="link-btn head-link" type="button" data-category="${esc(category.id)}">See all ${total}<span class="sr-only">: ${esc(category.label)}</span></button>
      </div>
      ${sampleNote(picked)}
      <div class="grid shelf-grid">${picked.map(productCard).join('')}</div>
    </section>`;

  /* a shelf per category the catalogue can fill with four, in the
     categories' own order; a piece on one shelf is not repeated on the
     next unless that shelf cannot be filled without it */
  function paintShelves() {
    if (!shelves) return;
    if (!pool) { shelves.innerHTML = ''; return; }
    const shown = new Set();
    const drawn = categories
      .map((category) => ({ category, candidates: inCategory(category) }))
      .filter((one) => one.candidates.length >= SHELF_SIZE)
      .map((one) => {
        const picked = fill(one.candidates, shown);
        picked.forEach((item) => shown.add(item.id));
        return { category: one.category, total: one.candidates.length, picked };
      });
    shelves.innerHTML = drawn.map(shelfHtml).join('');
    bindImageFallback(shelves, lostPhoto);
  }
  if (shelves) {
    shelves.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-category]');
      if (button) choose(button.dataset.category, true);
    });
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
      photos.set(item.id, new Promise((resolve) => {
        const probe = new Image();
        const settle = (ok) => {
          clearTimeout(timer);
          probe.onload = probe.onerror = null;
          resolve(ok);
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
    paintRow();
    paintPanel();
    paintResults();
  }

  function paintAll() {
    paintCount();
    paintShelves();
    paintFilters();
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
