/* =========================================================
   Fynd — Find Fit, step 1: the garment that fits

   Shows the reference garments the shopper has saved on their fit
   profile — read with their own session (Account.fitProfile.read: the
   server takes no id from the page), never anything invented and never
   an example made to look like theirs — and how to add or change one.

     signed out       how to start: each kind Fynd can compare links to
                      that kind's card on the fit profile, which offers
                      a free account right there
     nothing saved    the same, signed in
     saved            each kind's reference as saved — brand, the size on
                      its label, the product, its measurements — what it
                      can support (FitProfileSchema.readiness), and a way
                      to change it

   Which reference a comparison uses is the size engine's to decide
   (api/_sizing/engine.js referenceEntry): the one of the item's own
   kind, or for a hoodie or sweatshirt the other fleece top's. The
   result names the one it used. The links carry only the kind and
   where to come back to (fit-profile.html?for=<kind>&from=find-fit),
   nothing from the profile.

     FindFitReference.refresh()   read the profile again and redraw
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const root = doc && doc.getElementById('ff-reference');
  const Schema = global.FitProfileSchema;
  if (!root || !global.SizeChart || !Schema) return;
  const { el } = global.SizeChart;

  /* the kinds the size engine can compare, in the order a shopper thinks of them */
  const KINDS = ['hoodies', 'sweatshirts', 'tshirts'].filter((id) => Schema.SIZED_TYPES.includes(id));
  const LINE_WORDS = { men: 'men’s', women: 'women’s', unisex: 'unisex' };

  const setupHref = (kind) => `fit-profile.html?${new URLSearchParams(Object.assign(kind ? { for: kind } : {}, { from: 'find-fit' }))}`;
  function link(href, text, cls) {
    const a = el('a', cls || 'guide-link', text);
    a.href = href;
    return a;
  }

  /* the ways to add a reference: one per kind Fynd can compare */
  function addLinks(label) {
    const wrap = el('div', 'ff-add');
    wrap.append(el('p', 'ff-add-label', label));
    const row = el('div', 'ff-add-row');
    KINDS.forEach((kind) => {
      const g = Schema.garmentOf(kind);
      row.append(link(setupHref(kind), `Add a ${g.one}`, 'btn btn-secondary ff-add-btn'));
    });
    wrap.append(row);
    return wrap;
  }

  function signedOut() {
    const intro = el('p', 'ff-reference-intro', 'Start with something you own that fits the way you like. Save it to a free fit profile — only you can see it — and Fynd compares new items with it.');
    const already = el('p', 'ff-muted');
    already.append(doc.createTextNode('Saved one already? '), link(setupHref(null), 'Sign in to your fit profile'), doc.createTextNode('.'));
    root.replaceChildren(intro, addLinks('Add the garment you’ll compare against:'), already);
    root.dataset.state = 'signed-out';
  }

  /* one kind's saved reference, as the shopper saved it */
  function referenceCard(kind, entry, readiness) {
    const g = Schema.garmentOf(kind);
    const a = entry.anchor || {};
    const said = Schema.describeFavorite(entry) || {};
    const card = el('li', `ff-ref ff-ref--${readiness.level}`);
    card.dataset.kind = kind;
    const top = el('div', 'ff-ref-top');
    top.append(el('span', 'ff-ref-kind', g.one.replace(/^./, (c) => c.toUpperCase())));
    top.append(link(setupHref(kind), 'Change', 'guide-link ff-ref-change'));
    card.append(top);
    const label = [a.brand, a.size ? `size ${a.size}` : null, entry.line ? LINE_WORDS[entry.line] : null].filter(Boolean).join(' · ');
    card.append(el('p', 'ff-ref-name', label || `Your ${g.one}`));
    if (said.product) card.append(el('p', 'ff-ref-detail', said.product));
    card.append(el('p', 'ff-ref-detail', said.measurements ? `Measured: ${said.measurements}`
      : said.product ? 'No measurements of your own: Fynd uses this product’s published ones, where it holds them.'
        : 'No measurements saved'));
    const status = el('p', 'ff-ref-status');
    status.textContent = readiness.level === 'compare'
      ? 'Ready to compare, wherever Fynd holds an item’s checked measurements.'
      : (readiness.improve[0] || readiness.label);
    card.append(status);
    return card;
  }

  function saved(profile) {
    const listed = KINDS.filter((kind) => {
      const entry = profile.garments && profile.garments[kind];
      return entry && entry.anchor && entry.favorite !== 'none';
    });
    if (!listed.length) {
      root.replaceChildren(el('p', 'ff-reference-intro', 'You haven’t saved a garment to compare against yet.'), addLinks('Add one that fits you well:'));
      root.dataset.state = 'none';
      return;
    }
    const list = el('ul', 'ff-refs');
    listed.forEach((kind) => list.append(referenceCard(kind, profile.garments[kind], Schema.readiness(profile, kind))));
    const note = el('p', 'ff-muted', 'Fynd compares an item with your reference of the same kind — for a hoodie or sweatshirt, the other can stand in, and the result says so.');
    const missing = KINDS.filter((k) => !listed.includes(k));
    const more = el('p', 'ff-muted');
    if (missing.length) {
      more.append(doc.createTextNode('Add another: '));
      missing.forEach((kind, i) => {
        if (i) more.append(doc.createTextNode(' · '));
        more.append(link(setupHref(kind), Schema.garmentOf(kind).one));
      });
    }
    root.replaceChildren(list, note, ...(missing.length ? [more] : []));
    root.dataset.state = 'saved';
  }

  function unavailable() {
    const p = el('p', 'ff-reference-intro');
    p.append(doc.createTextNode('Your saved garments couldn’t be loaded just now. '), link(setupHref(null), 'Open your fit profile'), doc.createTextNode('.'));
    root.replaceChildren(p);
    root.dataset.state = 'error';
  }

  let asked = 0;
  async function refresh() {
    const ask = ++asked;
    const account = global.Account;
    if (!account) { signedOut(); return; }
    if (!account.state()) await account.load();
    if (ask !== asked) return;
    const state = account.state();
    if (!state || !state.signedIn) { signedOut(); return; }
    const got = await account.fitProfile.read();
    if (ask !== asked) return;
    if (!got.ok) { unavailable(); return; }
    /* the server keeps and returns the profile in its current shape */
    saved((got.data && got.data.profile) || Schema.empty());
  }

  refresh();
  global.FindFitReference = { refresh };
})(typeof window !== 'undefined' ? window : globalThis);
