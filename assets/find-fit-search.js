/* =========================================================
   Fynd — Find Fit: searching real listings, for either half

   One search, used twice (FyndLiveSearch.create): for the item the
   shopper is thinking of buying (step 02, below), and for the garment
   they already own (step 01, assets/find-fit-reference.js). Each use
   says what a pick does; the search, its pages and its costs are the
   same code either way.

   Step 02: the shopper types what they're thinking of buying — "Levi's 501
   jeans", "black oversized hoodie" — and picks it from real listings.
   Picking one hands its link to the existing lookup
   (FindFitItem.lookUp, assets/find-fit-item.js), so everything after
   that is the Find Fit flow as it was: Fynd's record, the product's
   chart, or an honest "can't be read" with the extension and hand
   entry as the ways on.

   Where results come from:

     live listings   /api/search (assets/search.js), 20 at a time from
                     the product source the deployment has connected.
                     "Load more" asks the server for that source's NEXT
                     page (a cursor the server holds), never a longer
                     slice of what is already on screen. Products shown
                     already are dropped by the server, and again here.
     Fynd's list     the catalogue Find Fit browses (GET ?brand=&q=,
                     free and unmetered): only products matching every
                     word, shown above the live listings with their own
                     label. Today that is a handful of UNIQLO products.

   The words are read by the page's own reader (Interpreter.localInterpret)
   — never sent to the AI interpreter, so searching spends no AI tokens.
   A NEW search is one of the plan's live product searches (as on the
   search page); Load more, opening a listing and picking one are not.
   Comparing is still only what Compare fit does.

   A pick is only a product's identity. What Fynd may compare it with is
   decided after it, by the existing checks: the item's chart lookup
   (step 02), and for a garment owned, POST ?check=1 and the engine's
   exact-record rule (step 01) — a listing never brings measurements.

   Every search, and every page, is tied to the search that asked for
   it: an answer to an older search never draws over a newer one, and
   Load more is ignored while a page is already on its way.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc) return;
  const $ = (id) => doc.getElementById(id);

  const PAGE_SIZE = 20;
  const CATALOGUE_MAX = 6;

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const isWebLink = (url) => /^https:\/\/[^\s"'<>]+$/i.test(String(url || ''));
  const money = (price, currency) => {
    if (typeof price !== 'number' || !Number.isFinite(price)) return null;
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(price); } catch (err) { return `$${price.toFixed(2)}`; }
  };
  /* the same rule the server dedupes by, less strictly: the link without
     its query's tracking, and the retailer with the name */
  const fold = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const linkKey = (url) => {
    try { const u = new URL(url); return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase(); } catch (err) { return null; }
  };

  const SOURCE_NAMES = { openwebninja: 'OpenWeb Ninja (Google Shopping listings)', serper: 'Serper (Google Shopping and web results)', serpapi: 'SerpApi (Google Shopping listings)', etsy: 'Etsy' };

  /* ---------- one search box and its results ----------
     create({ input, go, list, status, more, note, box, onPick,
              pickLabel, fallback, coverageTail, enterSearches })
     onPick({ from: 'live' | 'catalogue', product, url }, card) is the
     caller's: this module never decides what a pick means. */
  function create(o) {
    const { input, go, list, status, more, note, box, onPick } = o;
    const pickLabel = o.pickLabel || 'Choose';
    const fallback = o.fallback || 'Paste the product’s link';
    const fallbackLower = fallback.replace(/^./, (c) => c.toLowerCase());
    const coverageTail = o.coverageTail || '';
    /* one search, start to end */
    let run = 0;
    let cursor = null;
    let loading = false;
    let shownKeys = new Set();
    let shownCount = 0;
    let lastQuery = '';

    function say(text, state) {
      status.textContent = text || '';
      box.dataset.state = state || '';
    }
    function setMore(show, busy) {
      more.hidden = !show;
      more.disabled = Boolean(busy);
      more.setAttribute('aria-busy', busy ? 'true' : 'false');
      more.textContent = busy ? 'Loading more…' : 'Load more';
    }

    function remember(product) {
      const keys = [linkKey(product.productUrl || product.url), product.retailer ? `${fold(product.retailer)}|${fold(product.name)}` : null].filter(Boolean);
      if (keys.some((k) => shownKeys.has(k))) return false;
      keys.forEach((k) => shownKeys.add(k));
      return true;
    }

    /* ---------- a card ---------- */
    function card(p, from) {
      const url = from === 'catalogue' ? p.url : p.productUrl;
      const li = el('li', 'ffs-card');
      li.dataset.from = from;
      const media = el('div', 'ffs-media');
      if (isWebLink(p.imageUrl)) {
        const img = el('img');
        img.src = p.imageUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => { img.remove(); media.classList.add('is-empty'); });
        media.append(img);
      } else media.classList.add('is-empty');
      const body = el('div', 'ffs-body');
      const brand = from === 'catalogue' ? (p.brandName || null) : (p.brand || null);
      if (brand) body.append(el('span', 'ffs-brand', brand));
      body.append(el('span', 'ffs-name', p.name));
      const meta = [];
      const price = from === 'catalogue' ? null : money(p.price, p.currency);
      if (price) meta.push(price);
      if (from !== 'catalogue' && p.retailer) meta.push(`at ${p.retailer}`);
      if (from === 'catalogue') meta.push('Fynd’s list');
      body.append(el('span', 'ffs-meta', meta.join(' · ')));
      if (from === 'catalogue' && p.holdsText) body.append(el('span', 'ffs-holds', p.holdsText));
      const actions = el('div', 'ffs-actions');
      const pick = el('button', 'btn btn-primary btn-sm ffs-pick', pickLabel);
      pick.type = 'button';
      pick.setAttribute('aria-label', `${pickLabel}: ${p.name}`);
      pick.addEventListener('click', () => {
        list.querySelectorAll('.ffs-card.is-picked').forEach((n) => n.classList.remove('is-picked'));
        li.classList.add('is-picked');
        onPick({ from, product: p, url }, li);
      });
      actions.append(pick);
      if (isWebLink(url)) {
        const open = el('a', 'ffs-open', 'View product');
        open.href = url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.append(el('span', 'sr-only', ` ${p.name} (opens the retailer’s page)`));
        actions.append(open);
      }
      li.append(media, body, actions);
      return li;
    }

    /* ---------- Fynd's own list: matches for every word, free ---------- */
    async function catalogueMatches(words) {
      const sizing = global.Account && global.Account.sizing;
      if (!sizing || !sizing.brands || !sizing.catalog) return [];
      try {
        const got = await sizing.brands();
        const brands = got && got.ok && got.data && Array.isArray(got.data.brands) ? got.data.brands : [];
        /* a brand named in the words narrows to that brand, and its name is
           not one of the product's own words (as in catalog-suggest.js) */
        const said = fold(words);
        const named = brands.filter((b) => b && typeof b.name === 'string' && new RegExp(`(^| )${fold(b.name)}( |$)`).test(said));
        const asked = (named.length ? named : brands).map((b) => {
          const rest = named.includes(b) ? said.replace(new RegExp(`(^| )${fold(b.name)}( |$)`, 'g'), ' ').trim() : words;
          return rest ? sizing.catalog(b.id, { q: rest, limit: CATALOGUE_MAX }) : null;
        });
        const answers = await Promise.all(asked);
        const out = [];
        answers.forEach((a) => {
          const data = a && a.ok && a.data;
          /* "partial" means not every word matched: never offered as a match */
          if (!data || data.partial || !Array.isArray(data.products) || !data.brand) return;
          data.products.forEach((p) => {
            if (p && typeof p.name === 'string' && isWebLink(p.url)) out.push(Object.assign({}, p, { brandName: data.brand.name, brandId: data.brand.id }));
          });
        });
        return out.slice(0, CATALOGUE_MAX);
      } catch (err) { return []; }
    }

    function coverage(source) {
      const live = source ? `listings from ${SOURCE_NAMES[source] || 'Fynd’s connected product source'}` : null;
      const parts = [live, 'Fynd’s own product list'].filter(Boolean).join(' and ');
      return `Results are ${parts}. That covers many shops, not every retailer. ${coverageTail}`;
    }

    function usageLine(usage) {
      if (!usage || typeof usage.remaining !== 'number') return '';
      const left = usage.remaining === 1 ? '1 live search' : `${usage.remaining} live searches`;
      return ` Each new search uses one of your plan’s live product searches (${left} left${usage.period === 'day' ? ' today' : ''}); Load more and picking a product don’t.`;
    }

    /* ---------- a search ---------- */
    async function search(text) {
      const mine = ++run;
      cursor = null;
      loading = true;
      shownKeys = new Set();
      shownCount = 0;
      lastQuery = text;
      list.replaceChildren();
      setMore(false);
      if (note) note.textContent = '';
      say('Searching…', 'loading');

      const reader = global.Interpreter && global.Interpreter.localInterpret;
      const read = reader ? reader(text) : null;
      const intent = read && read.preferences ? read.preferences : read || { keywords: text.split(/\s+/) };
      const find = global.ProductSearch && global.ProductSearch.find;
      const [catalogue, live] = await Promise.all([
        catalogueMatches(text),
        find ? find(intent, PAGE_SIZE, [], { paginate: true }) : Promise.resolve({ state: 'unavailable', products: [] })
      ]);
      if (mine !== run) return;
      loading = false;

      const cards = [];
      catalogue.forEach((p) => { if (remember({ url: p.url, name: p.name })) cards.push(card(p, 'catalogue')); });
      const products = Array.isArray(live.products) ? live.products : [];
      products.forEach((p) => { if (remember(p)) cards.push(card(p, 'live')); });
      shownCount = cards.length;
      list.replaceChildren(...cards);
      cursor = live.hasMore ? live.nextCursor : null;
      setMore(Boolean(cursor));
      if (note) note.textContent = coverage(products.length ? live.source : null) + usageLine(live.usage);

      const n = shownCount;
      const found = `${n} ${n === 1 ? 'product' : 'products'} for “${text}”.`;
      if (live.state === 'ok') say(`${found}${cursor ? '' : ' That’s everything this search returned.'}`, 'ready');
      else if (live.state === 'limit') say(`${n ? found + ' ' : ''}${live.notice} ${fallback} instead, or wait for your searches to come back.`, n ? 'ready' : 'error');
      else if (live.state === 'not-configured') say(n ? `${found} Live product search isn’t connected here, so only Fynd’s own list was searched.` : `Live product search isn’t connected here, and Fynd’s own list has no match. ${fallback} instead.`, n ? 'ready' : 'empty');
      else if (live.state === 'empty') say(n ? found : `No products found for “${text}”. Try other words, or ${fallbackLower}.`, n ? 'ready' : 'empty');
      else say(`${n ? found + ' ' : ''}${live.notice || 'The product search failed.'} You can search again, or ${fallbackLower}.`, n ? 'ready' : 'error');
    }

    /* ---------- the next page, from the server ---------- */
    async function loadMore() {
      if (loading || !cursor) return;
      const mine = run;
      const asked = cursor;
      loading = true;
      setMore(true, true);
      say('Loading more…', 'loading-more');
      const got = await global.ProductSearch.find(null, null, null, { cursor: asked });
      if (mine !== run) return;
      loading = false;
      const added = [];
      (Array.isArray(got.products) ? got.products : []).forEach((p) => { if (remember(p)) added.push(card(p, 'live')); });
      list.append(...added);
      shownCount += added.length;
      const total = `${shownCount} products for “${lastQuery}”.`;
      if (got.state === 'ok' || got.state === 'empty') {
        cursor = got.hasMore ? got.nextCursor : null;
        setMore(Boolean(cursor));
        const end = cursor ? '' : ' That’s everything this search returned.';
        say(added.length ? `${added.length} more. ${total}${end}` : `No new products on that page. ${total}${end}`, 'ready');
        /* the first new card takes focus, so a keyboard shopper is where the list grew */
        const first = added[0] && added[0].querySelector('.ffs-pick');
        if (first) first.focus({ preventScroll: false });
      } else if (got.state === 'busy') {
        /* the same cursor is kept: nothing was shown */
        setMore(true);
        say(got.notice, 'ready');
      } else if (got.state === 'expired') {
        cursor = null;
        setMore(false);
        say(`${total} ${got.notice}`, 'ready');
      } else {
        /* the server gave the cursor back: the same page can be tried again */
        setMore(true);
        say(`${total} ${got.notice || 'More results could not be loaded.'} Try Load more again.`, 'ready');
      }
    }

    function submit(given) {
      const text = String(typeof given === 'string' ? given : input.value).replace(/\s+/g, ' ').trim();
      if (text.length < 2) {
        say('Type what you’re looking for — a name, a brand, or a description.', 'error');
        input.focus();
        return;
      }
      search(text);
    }
    if (go) go.addEventListener('click', () => submit());
    /* Enter searches here — it must never submit Find Fit's own form. A
       caller that keeps Enter for itself (step 01's box) says so. */
    if (o.enterSearches !== false) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    more.addEventListener('click', loadMore);

    return { search, submit, loadMore, state: () => ({ loading, hasMore: Boolean(cursor), shown: shownCount, query: lastQuery }) };
  }

  /* ---------- step 02: the item — a pick goes to the existing link lookup ---------- */
  function choose(url) {
    const link = $('ffi-link');
    const item = global.FindFitItem;
    if (!link || !item || typeof item.lookUp !== 'function' || !isWebLink(url)) return;
    link.value = url;
    item.lookUp();
    const found = $('ffi-found');
    if (found && found.scrollIntoView) found.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  global.FyndLiveSearch = { create };
  const itemBox = $('ffs');
  const itemSearch = itemBox && $('ffs-q') && $('ffs-results') && $('ffs-status') && $('ffs-more') ? create({
    input: $('ffs-q'), go: $('ffs-go'), list: $('ffs-results'), status: $('ffs-status'), more: $('ffs-more'), note: $('ffs-note'), box: itemBox,
    pickLabel: 'Check its fit',
    fallback: 'Paste the product’s link',
    coverageTail: 'Not every product can be fit-checked: Fynd says what it can read once you pick one.',
    onPick: (picked) => choose(picked.url)
  }) : null;
  if (itemSearch) global.FindFitSearch = itemSearch;
})(typeof window !== 'undefined' ? window : globalThis);
