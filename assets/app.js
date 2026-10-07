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
function bindImageFallback(root) {
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
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
  const seller = item.brand || item.retailer || '';
  const where = linked ? soldAt(item, seller) : '';
  const price = formatPrice(item.price);

  return `<${tag} class="item-card"${attrs}>
    ${media(item, linked ? '' : SAMPLE_BADGE)}
    <div class="item-body">
      <p class="item-retailer">${esc(seller)}</p>
      <h3 class="item-name">${esc(item.name)}</h3>
      <p class="item-price${price ? '' : ' item-price--none'}">${price || 'Price at retailer'}</p>
      ${where ? `<p class="item-seller">${esc(where)}</p>` : ''}
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

  function showProgress(query) {
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = `<div class="results-head search-progress" data-stage="understanding">
        <h2 class="thinking"></h2>
        <p class="results-query">Results for <q>${esc(query)}</q></p>
      </div>
      <div class="grid" aria-hidden="true">${SKELETON.repeat(4)}</div>`;
    showStage('understanding');
  }

  /* the search has answered, failed or been dropped: the box stops
     working at once */
  function endProgress() {
    results.removeAttribute('aria-busy');
    delete form.dataset.stage;
  }

  /* Smooth unless the shopper has asked for less motion. */
  const scrolling = () => (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  /* While a search runs, the box doing the work and the words saying what
     it is doing are both on screen: the page moves only as far as it must
     to bring the stage line up, and never so far that the box goes under
     the header. The results are brought up when they arrive. */
  const header = document.querySelector('.site-header');
  const MARGIN = 16;
  function keepBoxInView() {
    const head = results.querySelector('.search-progress');
    if (!head) return;
    const top = header ? header.getBoundingClientRect().bottom : 0;
    const room = form.getBoundingClientRect().top - top - MARGIN;
    const below = head.getBoundingClientRect().bottom + MARGIN - window.innerHeight;
    const by = Math.min(Math.max(below, 0), room);
    if (by) window.scrollBy({ top: by, behavior: scrolling() });
  }

  /* ---------- how many live searches are left ----------
     Said under the words in the box before anything is typed, exactly as
     /api/account last counted it: for the account, or signed out, for
     this browser. Nothing here knows a plan's limit or subtracts a
     search; when the account cannot be read the line says nothing rather
     than a guess.

     While a search runs the line is empty — the count it held is about
     to be out of date, and the hairline is what the box shows. When the
     search is over the account is read again and the new count takes its
     place, said once to screen readers after what the search found. */
  const usageLine = document.getElementById('ask-usage');
  const PERIOD_SAID = { day: 'today', month: 'this month' };
  let usageAsked = 0;
  let usageShown = false;
  let usageSaid = null;

  function usageText(account) {
    const searches = account && account.usage && account.usage.searches;
    const left = searches && searches.remaining;
    if (!Number.isInteger(left) || left < 0) return null;
    const period = PERIOD_SAID[searches.period] ? ` ${PERIOD_SAID[searches.period]}` : '';
    if (left === 0) return `No live searches left${period}`;
    return `${left.toLocaleString('en-US')} ${left === 1 ? 'search' : 'searches'} left${period}`;
  }

  function showUsage(text) {
    if (!usageLine) return;
    usageLine.textContent = text || '';
    if (text) usageShown = true;
    /* the row is held for a count; a box that never gets one goes back
       to its own size, and one that has had one keeps the room, so a
       failed re-read moves nothing */
    usageLine.hidden = !text && !usageShown;
  }

  /* the count on screen is about to be out of date: say nothing until
     the server has counted again, and drop any reading already asked for */
  function forgetUsage() {
    usageAsked += 1;
    if (usageLine) usageLine.textContent = '';
  }

  async function readUsage(afterSearch) {
    if (!usageLine) return;
    const ask = ++usageAsked;
    let text = null;
    try {
      const answer = typeof Account === 'undefined' ? null : await Account.load();
      text = answer && answer.ok ? usageText(answer.data) : null;
    } catch (err) { text = null; }
    if (ask !== usageAsked || form.dataset.stage) return;
    showUsage(text);
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
