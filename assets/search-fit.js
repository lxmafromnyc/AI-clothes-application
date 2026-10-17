/* =========================================================
   Fynd — search results, with the shopper's Fit Guide beside them

   Listens for the results assets/app.js has just put on screen
   ("fynd:results") and, for a signed-in shopper, asks the server to read
   each one against their own saved Fit Guide (POST
   /api/size-recommendation, action "personalize";
   api/_sizing/personalize.js). Then adds, under each card, what Fynd can
   honestly say about its size:

     strong    a suggested size, from checked garment measurements set
               against the shopper's own reference, with the differences
     partial   the closest size on too few measurements, a likely size
               from a brand's body-size chart, or the shopper's own usual
               size in that brand — each labelled as less certain
     none      a plain line saying Fynd can't suggest a size yet; the
               product and its link to the shop are untouched

   Nothing about the results changes: not their order, not which are
   shown, not where they link. If the reading fails, or the shopper is
   signed out, the results stay exactly as they are, with at most one
   line after them saying how to personalise them. Nothing here works
   out a size; it only says what came back, as text (never as markup).
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc) return;

  const WORDS = { tshirts: 'T-shirt', hoodies: 'hoodie', sweatshirts: 'sweatshirt', pants: 'pants', sweatpants: 'sweatpants', jeans: 'jeans' };
  const COMPARABLE = { tshirts: true, hoodies: true, sweatshirts: true };
  const BADGE = { strong: 'Fit Guide', partial: 'Less certain', none: '' };

  let last = null;

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };
  const link = (href, text, cls) => { const a = el('a', cls || 'guide-link', text); a.href = href; return a; };

  /* the one line about the results — after them, so nothing already on
     screen moves when it arrives */
  function notice(body, build) {
    const old = body.querySelector('.fit-notice');
    if (old) old.remove();
    if (!build) return;
    const p = el('p', 'fit-notice');
    p.setAttribute('role', 'status');
    build(p);
    const grid = body.querySelector('.grid');
    if (grid) grid.after(p);
  }

  /* the card for a listing, by its own address */
  function cardFor(body, url) {
    return Array.from(body.querySelectorAll('.grid > .item-card, .grid > .item-slot > .item-card')).find((c) => c.getAttribute('href') === url) || null;
  }

  function fitBlock(r) {
    const box = el('div', `item-fit item-fit--${r.level}`);
    box.dataset.level = r.level;
    if (BADGE[r.level]) box.append(el('span', 'item-fit-badge', BADGE[r.level]));
    box.append(el('p', 'item-fit-label', r.label));
    box.append(el('p', 'item-fit-detail', r.detail));
    if (r.differences && r.differences.length) {
      const ul = el('ul', 'item-fit-diffs');
      r.differences.forEach((d) => ul.append(el('li', null, d)));
      box.append(ul);
    }
    if (r.productId && (r.evidence === 'verified-garment' || r.evidence === 'body-chart')) {
      box.append(link(`compare.html?product=${encodeURIComponent(r.productId)}&type=${encodeURIComponent(r.category || '')}`,
        r.action === 'add-reference' ? `Add your ${WORDS[r.category] || 'reference'} and compare` : 'See every size compared'));
    }
    return box;
  }

  function decorate(body, data) {
    data.results.forEach((r) => {
      const card = cardFor(body, r.productUrl);
      if (!card) return;
      let slot = card.parentElement.classList.contains('item-slot') ? card.parentElement : null;
      if (!slot) {
        slot = el('div', 'item-slot');
        card.replaceWith(slot);
        slot.append(card);
      }
      const old = slot.querySelector('.item-fit');
      if (old) old.remove();
      slot.append(fitBlock(r));
    });
  }

  function summary(body, data, products, query) {
    const word = data.category ? WORDS[data.category] : null;
    notice(body, (p) => {
      if (data.category && !data.fitGuide && !data.references.length) {
        p.append(`Sizes here aren’t personalised yet: tell the `);
        p.append(link(COMPARABLE[data.category] ? `compare.html?type=${data.category}` : 'index.html', 'Fit Guide'));
        p.append(` about ${word === 'jeans' || word === 'pants' || word === 'sweatpants' ? `${word}` : `a ${word}`} that fits you.`);
        return;
      }
      const c = data.counts;
      const parts = [];
      if (c.strong) parts.push(`${c.strong} with a suggested size`);
      if (c.partial) parts.push(`${c.partial} less certain`);
      if (c.none) parts.push(`${c.none} without reliable sizing yet`);
      p.append(`Read against your Fit Guide${word ? ` for ${word === 'jeans' ? 'jeans' : `${word}s`}` : ''}: ${parts.join(', ')}.`);
      /* more than one reference could apply: let the shopper choose */
      if (data.references.length > 1) {
        const wrap = el('span', 'fit-switch');
        wrap.append(' Compare with your ');
        data.references.forEach((ref, i) => {
          const b = el('button', 'link-btn', `${WORDS[ref.category]}${ref.brand ? ` (${ref.brand}${ref.size ? ` ${ref.size}` : ''})` : ''}`);
          b.type = 'button';
          b.dataset.reference = ref.category;
          b.setAttribute('aria-pressed', String((data.referenceCategory || data.references[0].category) === ref.category));
          b.addEventListener('click', () => run(body, products, query, ref.category));
          if (i) wrap.append(' or ');
          wrap.append(b);
        });
        p.append(wrap);
      }
    });
  }

  async function run(body, products, query, referenceCategory) {
    const ticket = {};
    last = ticket;
    const result = await global.Account.sizing.personalize(products, query, referenceCategory);
    if (last !== ticket || !body.isConnected) return;
    if (!result.ok || !result.data || !result.data.personalized) {
      notice(body, (p) => { p.append('Your Fit Guide couldn’t be read against these results just now. The results themselves are unaffected.'); });
      return;
    }
    const data = result.data.personalized;
    decorate(body, data);
    summary(body, data, products, query);
    body.dataset.fit = 'ready';
  }

  doc.addEventListener('fynd:results', async (event) => {
    const body = event.target;
    const { products, query } = event.detail || {};
    if (!global.Account || !global.Account.sizing || !Array.isArray(products) || !products.length) return;
    /* the account the page already read for the search allowance; nothing
       is asked again here, and before it has arrived nothing is said */
    const state = global.Account.state();
    if (!state) return;
    if (!state.signedIn) {
      notice(body, (p) => {
        p.append(link('account.html', 'Sign in'));
        p.append(' to see sizes from your Fit Guide — where Fynd has the evidence to suggest one.');
      });
      body.dataset.fit = 'signed-out';
      return;
    }
    run(body, products, query, null);
  });
})(typeof window !== 'undefined' ? window : globalThis);
