/* =========================================================
   Fynd — the fit profile, used while shopping

   Under the search page's results, one panel says how the shopper's
   fit profile is being used for this search, and nothing more.
   Shopping never waits on it, and never needs it: results are on
   screen before it is asked anything, and it sits after them so their
   arrival never moves (a size is added to a matched listing's own
   card).

     which type      the "Shopping for" choice, or a type the request
                     itself names ("black hoodie"), or none — two types
                     named at once are none, never a guess
     signed out,     a closed line; asked for, "Get a more personalized
     or nothing      fit recommendation." and the way to that type's card
     for the type    on the fit profile page — which comes back here
     saved           with the type and the search, and nothing else, in
                     the address
     saved           "Using your T-shirt fit profile", what it holds, and
                     what it can support (FitProfileSchema.readiness);
                     then each listing that matches a record Fynd has
                     sizing for (/api/size-recommendation?fit=) is marked
                     with its size, or why there is none. A listing that
                     matches nothing is not marked: Fynd has no
                     measurements for it, and the panel says so once,
                     rather than inventing a size

   Only the type being shopped for is read from the profile: a jeans
   search is never sized from a hoodie. Nothing is written to browser
   storage.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const Schema = global.FitProfileSchema;

  /* the words that name each type in a request, and the word a search
     for the type alone is made of */
  const TYPES = {
    tshirts: { word: 'T-shirts', pattern: /\b(?:t[\s-]?shirts?|tees?)\b/i },
    hoodies: { word: 'hoodies', pattern: /\bhood(?:ie|y|ies)s?\b/i },
    sweatshirts: { word: 'sweatshirts', pattern: /\b(?:sweat[\s-]?shirts?|crew[\s-]?necks?)\b/i },
    jeans: { word: 'jeans', pattern: /\bjeans?\b/i },
    sweatpants: { word: 'sweatpants', pattern: /\b(?:sweat[\s-]?pants|joggers?|track[\s-]?pants)\b/i },
    pants: { word: 'pants', pattern: /\b(?:pants|trousers|chinos?|slacks)\b/i }
  };
  /* "hoodie sweatshirt" is a hoodie; "sweat pants" are sweatpants */
  const OUTRANKS = { hoodies: 'sweatshirts', sweatpants: 'pants' };

  /* The one type a request names, or null. */
  function detect(text) {
    const said = String(text || '');
    let found = Object.keys(TYPES).filter((id) => TYPES[id].pattern.test(said));
    Object.keys(OUTRANKS).forEach((id) => { if (found.includes(id)) found = found.filter((f) => f !== OUTRANKS[id]); });
    return found.length === 1 ? found[0] : null;
  }

  /* The request to search for: as typed when it names a type, with the
     chosen type's word added when it names none, or the word alone. */
  function compose(text, type) {
    const said = String(text || '').trim();
    if (!type || !TYPES[type] || detect(said)) return said;
    return said ? `${said} ${TYPES[type].word}` : TYPES[type].word;
  }

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  /* fit-profile.html, open at this type's card, with the way back here */
  function profileLink(type, query) {
    const params = new URLSearchParams();
    if (type) params.set('for', type);
    params.set('from', 'search');
    if (query) params.set('q', query);
    return `fit-profile.html?${params}`;
  }

  /* ---------- the panel ---------- */

  function panel() {
    const box = el('section', 'fit-panel');
    box.setAttribute('aria-label', 'Sizing for you');
    return box;
  }

  /* No profile for this type: one closed line, opened on request. */
  function offer(box, type, query, signedIn) {
    const g = type ? Schema.garmentOf(type) : null;
    box.dataset.state = signedIn ? 'missing-type' : 'no-profile';
    const line = el('p', 'fit-panel-line', signedIn && g
      ? `Your fit profile has nothing for ${g.many} yet, so these sizes aren’t personalised.`
      : 'These sizes aren’t personalised for you.');
    const ask = el('button', 'btn btn-secondary fit-panel-ask', 'Personalise my size');
    ask.type = 'button';
    ask.setAttribute('aria-expanded', 'false');
    const more = el('div', 'fit-panel-more');
    more.id = `fit-panel-more-${Math.random().toString(36).slice(2, 8)}`;
    ask.setAttribute('aria-controls', more.id);
    more.hidden = true;
    more.append(
      el('h3', 'fit-panel-title', 'Get a more personalized fit recommendation.'),
      el('p', 'fit-panel-text', `A fit profile lets Fynd remember how you like ${g ? g.many : 'clothes'} to fit and, where it’s supported, compare products against ${g && g.one ? `a ${g.one}` : 'clothes'} you already own. Save as much or as little as you like — and keep browsing either way.`)
    );
    const go = el('a', 'btn btn-primary', signedIn && g ? `Add ${g.many} to your fit profile` : 'Create your fit profile');
    go.href = profileLink(type, query);
    go.id = 'fit-panel-go';
    more.append(el('p', 'fit-panel-actions'));
    more.lastChild.append(go);
    ask.addEventListener('click', () => {
      more.hidden = false;
      ask.setAttribute('aria-expanded', 'true');
      ask.hidden = true;
      go.focus();
    });
    const row = el('div', 'fit-panel-row');
    row.append(line, ask);
    box.append(row, more);
  }

  /* A saved profile for this type: what is used, and what it can do. */
  function using(box, type, query, entry, ready) {
    const g = Schema.garmentOf(type);
    const said = Schema.describeGarment(type, entry);
    box.dataset.state = 'using';
    box.dataset.level = ready.level;
    const head = el('div', 'fit-panel-row');
    head.append(el('h3', 'fit-panel-title', `Using your ${g.id === 'other' ? '' : `${g.one} `}fit profile`));
    const edit = el('a', 'guide-link fit-panel-edit', `Edit ${g.many}`);
    edit.href = profileLink(type, query);
    head.append(edit);
    const facts = [said.anchor !== 'Not answered' && said.anchor, said.fitGoal !== 'Not answered' && said.fitGoal,
      said.favorite && said.favorite.measurements ? 'reference measured' : null].filter(Boolean);
    box.append(head);
    if (facts.length) box.append(el('p', 'fit-panel-facts', facts.join(' · ')));
    box.append(el('p', 'fit-panel-text', ready.label));
    if (ready.improve.length) box.append(el('p', 'fit-panel-hint', ready.improve[0]));
  }

  /* Each matched listing marked with its size, or why there is none. */
  function markListings(body, items, total) {
    const cards = Array.from(body.querySelectorAll('.grid > .item-card'));
    items.forEach((item) => {
      const card = cards[item.index];
      if (!card) return;
      const tag = el('p', `item-fit item-fit--${item.status}`);
      /* a size set beside the shopper's own garment, only when the server's decision says OK */
      const decided = item.decision && typeof item.decision === 'object' ? item.decision : null;
      if (item.status === 'ok' && decided && decided.outcome === 'OK' && item.resultType === 'garment-comparison' && item.size === decided.size) tag.textContent = `Your size: ${item.size}${item.alternative ? ` (or ${item.alternative})` : ''} · ${item.reliability} confidence`;
      /* a body estimate: a separate kind of result, said to be one — never "your size" */
      else if (item.status === 'estimate' && decided && decided.outcome === 'OK' && item.resultType === 'body-estimate' && item.estimate === decided.size) {
        tag.textContent = `Body-size estimate: ${item.estimate} · ${item.reliability} confidence — from body sizes and the brand’s size chart, not compared with a garment of yours`;
      }
      else if (item.status === 'partial' && item.closest) tag.textContent = `Closest to your reference: ${item.closest} — not enough measurements to recommend`;
      else tag.textContent = `No size for you: ${(item.missing && item.missing[0]) || 'not enough data'}`;
      tag.dataset.result = tag.textContent.startsWith('Your size') ? 'garment-comparison' : tag.textContent.startsWith('Body-size estimate') ? 'body-estimate' : 'none';
      if (item.summary) tag.title = item.summary;
      const bodyEl = card.querySelector('.item-body');
      (bodyEl || card).append(tag);
    });
    const unmatched = total - items.length;
    if (!items.length) return 'None of these listings has measurements Fynd has checked, so no personalised size is shown — Fynd won’t guess one.';
    return unmatched
      ? `${items.length} of ${total} listings matched a product Fynd has sizing for. The other ${unmatched} get no size: Fynd has no checked measurements for them.`
      : 'Every listing here matched a product Fynd has sizing for.';
  }

  /* Starts the panel at the foot of a results body. Never throws, and
     never holds the results up. */
  async function show(body, context) {
    if (!body || !Schema || !global.Account) return null;
    const ctx = context || {};
    const type = ctx.type && Schema.garmentOf(ctx.type) ? ctx.type : null;
    const box = panel();
    box.dataset.state = 'loading';
    if (type) box.dataset.type = type;
    body.append(box);

    try {
      let state = global.Account.state();
      if (!state) { await global.Account.load(); state = global.Account.state(); }
      /* no accounts on this copy of the site: no profile to use, and
         nothing to offer */
      if (!state) { box.remove(); return null; }

      if (!type) {
        box.dataset.state = 'no-type';
        box.append(el('p', 'fit-panel-line', 'Choose what you’re shopping for above, and Fynd will use that part of your fit profile for sizing.'));
        return box;
      }
      if (!state.signedIn) { offer(box, type, ctx.query, false); return box; }

      const read = await global.Account.fitProfile.read();
      if (read.status === 401) { offer(box, type, ctx.query, false); return box; }
      if (!read.ok || !read.data) {
        box.dataset.state = 'unreadable';
        box.append(el('p', 'fit-panel-line', 'Your fit profile couldn’t be read just now, so these sizes aren’t personalised.'));
        return box;
      }
      const profile = read.data.profile || null;
      const ready = Schema.readiness(profile, type);
      if (!ready || ready.level === 'empty') { offer(box, type, ctx.query, true); return box; }
      using(box, type, ctx.query, profile.garments[type], ready);

      const products = (ctx.products || []).slice(0, 24);
      if (!ready.sized || !products.length) return box;
      const items = products.map((p) => ({ brand: p.brand || null, name: p.name || null, url: p.productUrl || null }));
      const fit = await global.Account.sizing.fit(type, items);
      if (!fit.ok || !fit.data || !fit.data.fit) {
        box.append(el('p', 'fit-panel-hint', 'Sizes couldn’t be worked out just now.'));
        return box;
      }
      box.append(el('p', 'fit-panel-hint fit-panel-matched', markListings(body, fit.data.fit.items, products.length)));
      return box;
    } catch (err) {
      box.remove();
      return null;
    }
  }

  global.FitForYou = { detect, compose, show, profileLink, TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
