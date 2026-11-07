/* =========================================================
   Fynd — "Bought it? Tell Fynd how it fit", after a comparison

   One small form under a comparison's result, on Find Fit (index.html,
   assets/find-fit-manual.js) and in the extension's Fit panel
   (extension/sidepanel.js, which carries a copy in extension/vendor/).
   It saves through the fit profile's existing feedback
   (api/_fit-feedback.js, POST /api/fit-profile "feedback-add"): no new
   endpoint, no new store, nothing sent anywhere else.

   What the shopper says, in their words, and what is kept:

     Just right    asExpected: true
     Too tight     issues: too-narrow
     Too loose     issues: too-wide
     Too short     issues: too-short
     Too long      issues: too-long        (any of the four together)

   Kept with exactly what was compared:
     the product   a product Fynd holds a record for, by its id; any other
                   by its own link (the server cleans it and names it
                   "url:<hash>"), with its kind of garment
     the size      the label the shopper bought, one of the sizes compared
     the garment   the saved garment the comparison used (referenceType),
                   which the server copies from the shopper's own profile
                   — never sent from here. A garment described only for
                   this visit isn't on the profile, so none is kept.

   This file makes no request of its own. The page hands it an adapter:

     api.read()          -> { ok, data: { feedback }, problem? }
     api.consent()       -> { ok, data: { feedback } }   (keep my feedback)
     api.add(entry)      -> { ok, data: { entry, updated }, problem? }
     api.signedIn()      -> true | false (a promise)

     FitFeedbackForm.mount(box, context, api, { signInHref })
     FitFeedbackForm.target(context)        what the entry names, or null
     FitFeedbackForm.entryOf(context, size, picks)  -> { entry } | { error }

   context: { productId?, product?: { url, brand, name }, category,
              sizes: [labels compared], recommendedSize?, referenceType? }
   ========================================================= */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FitFeedbackForm = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHOICES = [
    { id: 'just-right', label: 'Just right' },
    { id: 'too-narrow', label: 'Too tight' },
    { id: 'too-wide', label: 'Too loose' },
    { id: 'too-short', label: 'Too short' },
    { id: 'too-long', label: 'Too long' }
  ];
  const ISSUES = CHOICES.map((c) => c.id).filter((id) => id !== 'just-right');
  const CATEGORIES = ['hoodies', 'sweatshirts', 'tshirts'];

  /* What an entry names: a product Fynd holds a record for, or any other
     product by its own link. Null when there is neither (an item typed by
     hand with no link): nothing to tie the feedback to. */
  function target(ctx) {
    const c = ctx || {};
    if (typeof c.productId === 'string' && c.productId && c.productId !== 'your-candidate' && !c.productId.startsWith('url:')) return { productId: c.productId };
    const p = c.product || {};
    if (typeof p.url === 'string' && /^https?:\/\//i.test(p.url) && CATEGORIES.includes(c.category)) {
      const product = { url: p.url };
      if (typeof p.brand === 'string' && p.brand.trim()) product.brand = p.brand.trim().slice(0, 120);
      if (typeof p.name === 'string' && p.name.trim()) product.name = p.name.trim().slice(0, 120);
      return { product, category: c.category };
    }
    return null;
  }

  const sizesOf = (ctx) => (Array.isArray(ctx && ctx.sizes) ? ctx.sizes.filter((s) => typeof s === 'string' && s) : []);

  function entryOf(ctx, size, picks) {
    const t = target(ctx);
    if (!t) return { error: 'Fynd can only keep feedback for a product it knows by its link.' };
    const sizes = sizesOf(ctx);
    if (!sizes.includes(size)) return { error: 'Choose the size you bought.' };
    const chosen = Array.isArray(picks) ? picks : [];
    if (!chosen.length) return { error: 'Say how it fit: just right, or what was off.' };
    const right = chosen.includes('just-right');
    const issues = ISSUES.filter((x) => chosen.includes(x));
    if (right && issues.length) return { error: 'It can’t be just right and too tight, loose, short or long. Choose one or the other.' };
    const entry = Object.assign({}, t, { sizeTried: size, asExpected: right, issues });
    if (typeof ctx.recommendedSize === 'string' && sizes.includes(ctx.recommendedSize)) entry.recommendedSize = ctx.recommendedSize;
    if (CATEGORIES.includes(ctx.referenceType)) Object.assign(entry, { referenceType: ctx.referenceType, withReference: true });
    return { entry };
  }

  /* ---------- the form ---------- */
  function mount(box, ctx, api, opts) {
    const doc = box.ownerDocument;
    const o = opts || {};
    const el = (tag, cls, text) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    box.replaceChildren();
    const sizes = sizesOf(ctx);
    if (!target(ctx) || !sizes.length) { box.hidden = true; return null; }
    const uid = `fyf-${Math.random().toString(36).slice(2, 8)}`;

    const details = el('details', 'fyf');
    details.append(el('summary', 'fyf-summary', 'Bought it? Tell Fynd how it fit'));
    const body = el('div', 'fyf-body');
    details.append(body);
    box.append(details);
    box.hidden = false;

    let consented = null;
    let loaded = false;
    async function open() {
      if (loaded) return;
      loaded = true;
      body.replaceChildren(el('p', 'fyf-note', 'Loading…'));
      let signed = false;
      try { signed = await api.signedIn(); } catch (err) { signed = false; }
      if (!signed) return signedOut();
      let got = null;
      try { got = await api.read(); } catch (err) { got = null; }
      if (!got || !got.ok) {
        if (got && got.problem && got.problem.kind === 'sign-in') return signedOut();
        loaded = false;
        body.replaceChildren(el('p', 'fyf-error', 'Fynd couldn’t load your fit feedback just now. Close this and open it again to retry.'));
        return;
      }
      const fb = got.data && got.data.feedback;
      consented = Boolean(fb && fb.consent && fb.consent.store);
      const t = target(ctx);
      const id = t.productId || null;
      const before = id && fb && Array.isArray(fb.entries) ? fb.entries.filter((e) => e.productId === id) : [];
      form(before);
    }
    function signedOut() {
      const p = el('p', 'fyf-note', 'Sign in to Fynd to keep how it fit on your account, beside this product and size. ');
      if (o.signInHref) {
        const a = el('a', null, 'Sign in');
        a.href = o.signInHref;
        if (o.newTab) { a.target = '_blank'; a.rel = 'noopener'; }
        p.append(a);
      }
      body.replaceChildren(p);
      loaded = false;
    }
    function form(before) {
      const f = el('form', 'fyf-form');
      f.noValidate = true;
      f.append(el('p', 'fyf-note', 'Once you’ve worn it, say how it fit. Fynd keeps it with this product, the size you bought and the garment you compared it with — only you can see it.'));
      const sizeLabel = el('label', 'fyf-label', 'Size you bought');
      sizeLabel.htmlFor = `${uid}-size`;
      const select = el('select', 'fyf-select');
      select.id = `${uid}-size`;
      const dflt = typeof ctx.recommendedSize === 'string' && sizes.includes(ctx.recommendedSize) ? ctx.recommendedSize : sizes.length === 1 ? sizes[0] : '';
      if (!dflt) select.append(Object.assign(el('option', null, 'Choose…'), { value: '' }));
      sizes.forEach((s) => { const op = el('option', null, s); op.value = s; if (s === dflt) op.selected = true; select.append(op); });
      f.append(sizeLabel, select);
      const set = el('fieldset', 'fyf-choices');
      set.append(el('legend', 'fyf-label', 'How did it fit?'));
      CHOICES.forEach((c) => {
        const lab = el('label', 'fyf-choice');
        const box2 = el('input');
        box2.type = 'checkbox';
        box2.name = `${uid}-fit`;
        box2.value = c.id;
        lab.append(box2, el('span', null, c.label));
        set.append(lab);
      });
      /* "Just right" and the four problems exclude each other */
      set.addEventListener('change', (e) => {
        const t = e.target;
        if (!t || t.type !== 'checkbox' || !t.checked) return;
        set.querySelectorAll('input[type=checkbox]').forEach((x) => {
          if (x !== t && ((t.value === 'just-right') || x.value === 'just-right')) x.checked = false;
        });
      });
      f.append(set);
      let consentBox = null;
      if (!consented) {
        const lab = el('label', 'fyf-consent');
        consentBox = el('input');
        consentBox.type = 'checkbox';
        lab.append(consentBox, el('span', null, 'Keep my fit feedback on my Fynd account (only you can see it; turn it off any time on Compare, which deletes it)'));
        f.append(lab);
      }
      const save = el('button', 'btn btn-primary fyf-save', 'Save how it fit');
      save.type = 'submit';
      const status = el('p', 'fyf-status');
      status.setAttribute('role', 'status');
      f.append(save, status);
      const said = (s) => before.find((e) => e.sizeTried === s);
      const showBefore = () => {
        const e = said(select.value);
        status.className = 'fyf-status';
        status.textContent = e ? `You said how size ${e.sizeTried} fit before. Saving again replaces it.` : '';
      };
      select.addEventListener('change', showBefore);
      showBefore();
      f.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (save.disabled) return;
        const picks = [...set.querySelectorAll('input[type=checkbox]:checked')].map((x) => x.value);
        const made = entryOf(ctx, select.value, picks);
        const fail = (text) => { status.className = 'fyf-status fyf-error'; status.textContent = text; };
        if (made.error) return fail(made.error);
        if (!consented && !(consentBox && consentBox.checked)) return fail('Tick “Keep my fit feedback on my Fynd account” to save it.');
        save.disabled = true;
        save.setAttribute('aria-busy', 'true');
        try {
          if (!consented) {
            const c = await api.consent();
            if (!c || !c.ok) return fail('Your feedback wasn’t saved. Try again in a moment.');
            consented = true;
            if (consentBox) consentBox.closest('label').remove();
          }
          const r = await api.add(made.entry);
          if (!r || !r.ok) {
            const p = r && r.problem;
            return fail(p && p.kind === 'sign-in' ? 'Your Fynd sign-in has ended. Sign in, then save again.'
              : p && p.errors && p.errors.length ? p.errors.map((x) => x.message).join(' ') : 'Your feedback wasn’t saved. Try again in a moment.');
          }
          const e = r.data && r.data.entry;
          if (e) { before = before.filter((x) => x.sizeTried !== e.sizeTried).concat([e]); }
          status.className = 'fyf-status fyf-done';
          status.textContent = r.data && r.data.updated ? `Updated: how size ${select.value} fit. Thank you.` : `Saved: how size ${select.value} fit. Thank you.`;
        } finally {
          save.disabled = false;
          save.removeAttribute('aria-busy');
        }
      });
      body.replaceChildren(f);
    }
    details.addEventListener('toggle', () => { if (details.open) open(); });
    return details;
  }

  return { CHOICES, ISSUES, target, entryOf, mount };
});
