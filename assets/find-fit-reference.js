/* =========================================================
   Fynd — Find Fit: the garment that fits

   The reference the item is compared with, in one of two places:

     saved      the garments on the shopper's fit profile — read with
                their own session (Account.fitProfile.read: the server
                takes no id from the page) — each with a way to change it
     this visit a garment described right here, by anyone, account or
                not: kept in this tab's sessionStorage until the tab
                closes, and sent only in the body of a comparison
                (Account.sizing.compareWith), which keeps nothing.
                Saving it to a fit profile is a separate, explicit step
                (assets/find-fit-save.js)

   The form asks only for what the fit profile itself holds, in its own
   shape — one type's answers, { favorite, line, anchor: { brand, size,
   product, measurements } } — and checks it with the profile's own
   validator (FitProfileSchema.normaliseGuide), so there is one
   reference format. The four measurements are optional, each said how
   to take, and never asked for when the shopper can't take them; no
   value is filled in or suggested. Nothing invented is ever shown as
   theirs.

     signed-out / none   the form, or the garment described this visit
     saved               the saved garments, each with Change

   The form is there from the start, beside the item: the two can be
   given in either order, and changing the item never takes away what
   was typed. Whether the two can be compared is still the server's to
   say (assets/find-fit.js, checking first).

   Find your garment: a box at the top of the form searches Fynd's
   catalogue and its checked records as the shopper types
   (assets/catalog-suggest.js), a size typed with the words read apart.
   A product picked fills the fields below — type, brand, product, fit
   line, and a letter size the form takes — and is then checked on the
   server (POST ?check=1, the product as the item): what Fynd holds for
   it is said from that answer alone. Picking proves nothing: the fields
   stay the shopper's to change, "Use this garment" still keeps it, and
   whether a product's measurements stand in for theirs is the size
   engine's to decide when it compares (engine.js referenceEntry).

   Popular Wardrobe Anchors: products a shopper may own, offered as the
   garment in one click — only those Fynd's records hold checked
   finished-garment measurements for (GET ?anchors=1, records.summary
   comparable), so none is ever offered on data nobody checked. Picking
   one fills the form with its type, brand and product; the size on its
   label is still the shopper's to say.

   Which reference a comparison uses is the size engine's to decide
   (api/_sizing/engine.js referenceEntry): the one of the item's own
   kind, or for a hoodie or sweatshirt the other fleece top's. A saved
   one is used whenever the shopper has one; otherwise this visit's.

     FindFitReference.refresh()   read the profile again and redraw
     FindFitReference.unsaved()   this visit's garment, { type, garment },
                                  when no saved reference is in use
     FindFitReference.current()   this visit's garment, saved or not in use
     FindFitReference.forget()    clear this visit's garment
     FindFitReference.unlock()    kept for older callers: the form is always open
     FindFitReference.locked()    false: the garment never waits for the item
     FindFitReference.useAnchor(a)  the form, filled from one wardrobe anchor
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
  const KEY = 'fynd:find-fit:reference';
  const cap = (t) => t.replace(/^./, (c) => c.toUpperCase());

  const setupHref = (kind) => `fit-profile.html?${new URLSearchParams(Object.assign(kind ? { for: kind } : {}, { from: 'find-fit' }))}`;
  function link(href, text, cls) {
    const a = el('a', cls || 'guide-link', text);
    a.href = href;
    return a;
  }

  /* ---------- this visit's garment ---------- */

  /* { type, garment } as the profile's validator reads it, or null */
  function checked(value) {
    if (!value || typeof value !== 'object' || !KINDS.includes(value.type)) return null;
    const { answers, errors } = Schema.normaliseGuide({ garments: { [value.type]: value.garment } });
    const garment = !errors.length && answers.garments && answers.garments[value.type];
    return garment && garment.anchor ? { type: value.type, garment } : null;
  }
  function stored() {
    try { return checked(JSON.parse(global.sessionStorage.getItem(KEY) || 'null')); } catch (err) { return null; }
  }
  let visit = stored();
  /* Find Fit checks the item again whenever the reference changes; a
     change the shopper made says so (detail.by), so Find Fit may go on
     to compare — a profile read on its own never starts one */
  const changed = (by) => { try { doc.dispatchEvent(new global.CustomEvent('fynd:reference-change', { detail: { by: by || 'page' } })); } catch (err) { /* no events here */ } };
  function keep(value, by) {
    visit = value;
    global.setTimeout(() => changed(by), 0);
    try {
      if (value) global.sessionStorage.setItem(KEY, JSON.stringify(value));
      else global.sessionStorage.removeItem(KEY);
    } catch (err) { /* kept in this page only */ }
  }

  /* the shopper's state, as last read: whether a saved reference is in use */
  let savedInUse = false;
  let editing = false;
  /* a wardrobe anchor picked: the form's starting values, until used or cancelled */
  let prefill = null;

  /* ---------- the form ---------- */

  function field(labelText, control, hint) {
    const wrap = el('div', 'ffr-field');
    const label = el('label', 'profile-label', labelText);
    label.htmlFor = control.id;
    wrap.append(label, control);
    if (hint) {
      const p = el('p', 'ffr-hint', hint);
      p.id = `${control.id}-hint`;
      control.setAttribute('aria-describedby', p.id);
      wrap.append(p);
    }
    const err = el('p', 'form-error ffr-error');
    err.id = `${control.id}-error`;
    err.setAttribute('role', 'alert');
    wrap.append(err);
    return wrap;
  }
  function select(id, options, value) {
    const s = el('select', 'profile-input');
    s.id = id;
    options.forEach(([v, t]) => {
      const o = el('option', null, t);
      o.value = v;
      if (v === value) o.selected = true;
      s.append(o);
    });
    return s;
  }
  function input(id, type, value, attrs) {
    const i = el('input', 'profile-input');
    i.id = id;
    i.type = type;
    if (value !== undefined && value !== null) i.value = String(value);
    Object.entries(attrs || {}).forEach(([k, v]) => i.setAttribute(k, v));
    return i;
  }

  function form(from) {
    const g = from ? from.garment : {};
    const a = (g && g.anchor) || {};
    const m = a.measurements || {};
    const box = el('div', 'ffr-form');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-labelledby', 'ffr-form-title');
    const title = el('p', 'ffr-title', 'Describe a garment you own that fits the way you like. No account needed.');
    title.id = 'ffr-form-title';
    box.append(title, finder());

    const row = el('div', 'ffr-row');
    row.append(
      field('Type', select('ffr-type', KINDS.map((k) => [k, cap(Schema.garmentOf(k).one)]), from ? from.type : KINDS[0])),
      field('Size on its label', select('ffr-size', [['', 'Choose…']].concat(Schema.LETTER_SIZES.map((s) => [s, s])), a.size || ''))
    );
    box.append(row);
    const brand = input('ffr-brand', 'text', a.brand, { maxlength: String(Schema.LIMITS.brandLength), autocomplete: 'off', list: 'ffr-brands', spellcheck: 'false' });
    const brands = el('datalist');
    brands.id = 'ffr-brands';
    Schema.ANCHOR_BRANDS.forEach((b) => { const o = el('option'); o.value = b; brands.append(o); });
    box.append(field('Brand', brand), brands);
    const product = a.product ? (a.product.url || a.product.name || '') : '';
    box.append(field('Product name or link (optional)', input('ffr-product', 'text', product, { maxlength: '2000', autocomplete: 'off', spellcheck: 'false' }),
      'If we have this product’s measurements, we’ll use them.'));
    const row2 = el('div', 'ffr-row');
    row2.append(
      field('Sold as', select('ffr-line', [['not-sure', 'Not sure'], ['men', 'Men’s'], ['women', 'Women’s'], ['unisex', 'Unisex']], (g && g.line) || 'not-sure')),
      field('How it fits', select('ffr-favorite', [['perfect', 'Just how I like'], ['close', 'Close to how I like']], (g && g.favorite) || 'perfect'))
    );
    box.append(row2);

    /* the four measurements: only if the shopper can lay it flat and measure it */
    const more = el('details', 'ffr-measure');
    if (a.measurements) more.open = true;
    more.append(el('summary', null, 'Add its measurements (optional)'));
    more.append(el('p', 'ffr-hint', 'Only if you can lay it flat and measure it. Leave any you can’t take blank.'));
    more.append(field('Unit', select('ffr-unit', [['in', 'Inches'], ['cm', 'Centimetres']], m.unit || 'in')));
    const grid = el('div', 'ffr-grid');
    Schema.GARMENT_MEASURE_KEYS.forEach((k) => {
      const spec = Schema.GARMENT_MEASURES[k];
      grid.append(field(spec.label, input(`ffr-m-${k}`, 'text', m[k], { inputmode: 'decimal', autocomplete: 'off' }), spec.how));
    });
    more.append(grid);
    box.append(more);

    const actions = el('div', 'ffr-actions');
    const use = el('button', 'btn btn-primary ffr-use', 'Use this garment');
    use.type = 'button';
    use.id = 'ffr-use';
    use.addEventListener('click', apply);
    actions.append(use);
    if (from) {
      const cancel = el('button', 'btn btn-secondary', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', () => { editing = false; prefill = null; redraw(); });
      actions.append(cancel);
    }
    box.append(actions);
    /* Enter applies the garment here, never the item's form around it —
       except in the search box, where Enter picks a match */
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
        e.preventDefault();
        if (e.target.id !== 'ffr-search') apply();
      }
    });
    return box;
  }

  /* ---------- Find your garment ---------- */

  let pickAsk = 0;
  function finder() {
    const wrap = el('div', 'ffr-find');
    const label = el('label', 'profile-label', 'Find your garment');
    label.htmlFor = 'ffr-search';
    const smart = el('div', 'ff-smart');
    const search = input('ffr-search', 'text', '', {
      placeholder: 'Search brand, item and size — e.g. Uniqlo hoodie M', maxlength: '200', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'ffr-suggest', 'aria-describedby': 'ffr-search-hint'
    });
    const box = el('div', 'ff-suggest');
    box.id = 'ffr-suggest-box';
    box.hidden = true;
    const list = el('ul', 'ff-suggest-list');
    list.id = 'ffr-suggest';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Matching products');
    const status = el('p', 'ff-suggest-status');
    status.id = 'ffr-suggest-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    box.append(list, status);
    smart.append(search, box);
    const hint = el('p', 'ffr-hint', 'Not listed? Fill in the details below.');
    hint.id = 'ffr-search-hint';
    const held = el('div', 'ffr-held');
    held.id = 'ffr-held';
    held.setAttribute('role', 'status');
    held.setAttribute('aria-live', 'polite');
    held.hidden = true;
    wrap.append(label, smart, hint, held);
    if (!global.FyndSuggest) { wrap.hidden = true; return wrap; }
    const suggest = global.FyndSuggest.attach({
      input: search, box, list, status, idPrefix: 'ffr-suggest', anchors: true,
      onPick: (f, size) => usePicked(f, size, search, held),
      say: {
        unavailable: 'Search isn’t available right now. Fill in the details below instead.',
        empty: (words) => `No products match “${words}”. Fill in the details below instead.`,
        ready: (n) => `${n} matching product${n === 1 ? '' : 's'}. Not listed? Fill in the details below.`
      }
    });
    search.addEventListener('input', () => { pickAsk += 1; held.hidden = true; suggest.soon(search.value); });
    search.addEventListener('keydown', (e) => suggest.key(e));
    return wrap;
  }

  /* what the server holds for a product, said from its answer alone */
  function heldSay(check) {
    const v = (check && check.validation) || {};
    if (global.FyndSuggest.heldChecked(check)) return ['checked', 'Fynd holds checked garment measurements for this product. When it compares, it can use them for yours.'];
    if (v.code === 'unverified-data' || v.code === 'crowdsourced-data') return ['unchecked', 'Fynd has this product’s chart, but it hasn’t been checked, so it won’t stand in for your garment. Add any measurements you can take, below.'];
    if (v.code === 'body-chart-only') return ['body-only', 'Fynd holds only a body-size chart for this product, not the garment’s own measurements. Add any measurements you can take, below.'];
    if (v.code === 'category-not-covered') return ['not-covered', 'Fynd doesn’t compare this kind of garment yet.'];
    return ['none', 'Fynd holds no measurements for this product. Add any measurements you can take, below.'];
  }
  /* a match picked: the fields filled from what the server listed, then the server asked what it holds */
  async function usePicked(f, size, search, held) {
    const set = (id, value) => { const n = doc.getElementById(id); if (n && value !== null && value !== undefined) n.value = value; };
    if (KINDS.includes(f.product.category)) set('ffr-type', f.product.category);
    set('ffr-brand', f.brand.name);
    set('ffr-product', f.product.url);
    if (['men', 'women', 'unisex'].includes(f.product.line)) set('ffr-line', f.product.line);
    const lines = [];
    if (size && size.kind === 'letter' && Schema.LETTER_SIZES.includes(size.letter)) {
      set('ffr-size', size.letter);
      lines.push(el('p', 'ffr-held-size', `Size ${size.letter} is from your search — check it’s the size on its label.`));
    } else if (size) {
      lines.push(el('p', 'ffr-held-size', size.kind === 'waist-inseam'
        ? `${size.label} is a waist and inseam; here, choose the size on the label of a top.`
        : `Size ${size.label} isn’t one this form takes — choose the size on its label.`));
    }
    search.value = `${f.brand.name} · ${f.product.name}`;
    held.dataset.status = 'checking';
    held.replaceChildren(el('p', null, 'Checking what Fynd holds for this product…'), ...lines);
    held.hidden = false;
    const mine = ++pickAsk;
    const sizing = global.Account && global.Account.sizing;
    const target = f.brand.id && f.product.code ? { brand: f.brand.id, code: f.product.code } : { url: f.product.url };
    const got = sizing && sizing.check ? await sizing.check(target, null) : null;
    if (mine !== pickAsk) return;
    const check = got && got.ok && got.data && got.data.check;
    const [status, text] = check && typeof check === 'object' ? heldSay(check)
      : ['unknown', 'What Fynd holds for this product couldn’t be checked just now. You can still use it — Fynd checks again when it compares.'];
    held.dataset.status = status;
    held.replaceChildren(el('p', null, text), ...lines);
    const next = doc.getElementById('ffr-size');
    if (next && !next.value) next.focus();
  }

  /* what the form says, in the profile's own shape */
  function read() {
    const v = (id) => { const n = doc.getElementById(id); return n ? n.value.trim() : ''; };
    const type = v('ffr-type');
    const productText = v('ffr-product');
    const product = productText ? (/^https?:\/\//i.test(productText) ? { url: productText } : { name: productText }) : null;
    const measurements = {};
    let anyMeasure = false;
    Schema.GARMENT_MEASURE_KEYS.forEach((k) => { const t = v(`ffr-m-${k}`); measurements[k] = t || null; if (t) anyMeasure = true; });
    const anchor = { brand: v('ffr-brand') || null, size: v('ffr-size') || null };
    if (product) anchor.product = product;
    if (anyMeasure) anchor.measurements = Object.assign({ unit: v('ffr-unit') }, measurements);
    return { type, garment: { favorite: v('ffr-favorite') || 'perfect', line: v('ffr-line') || null, anchor } };
  }

  const FIELD_IDS = { brand: 'ffr-brand', size: 'ffr-size', 'product.name': 'ffr-product', 'product.url': 'ffr-product', 'measurements.unit': 'ffr-unit' };
  Schema.GARMENT_MEASURE_KEYS.forEach((k) => { FIELD_IDS[`measurements.${k}`] = `ffr-m-${k}`; });
  function showErrors(list) {
    root.querySelectorAll('.ffr-error').forEach((n) => { n.textContent = ''; n.classList.remove('show'); });
    root.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    let first = null;
    list.forEach(({ id, message }) => {
      const target = doc.getElementById(id) || doc.getElementById('ffr-brand');
      const err = doc.getElementById(`${target.id}-error`);
      if (err && !err.textContent) { err.textContent = message; err.classList.add('show'); }
      target.setAttribute('aria-invalid', 'true');
      if (!first) first = target;
    });
    if (first) {
      const details = first.closest('details');
      if (details) details.open = true;
      first.focus();
    }
  }

  function apply() {
    const said = read();
    const missing = [];
    if (!said.garment.anchor.brand) missing.push({ id: 'ffr-brand', message: 'Enter the brand on its label.' });
    if (!said.garment.anchor.size) missing.push({ id: 'ffr-size', message: 'Choose the size on its label.' });
    if (missing.length) { showErrors(missing); return; }
    const { errors } = Schema.normaliseGuide({ garments: { [said.type]: said.garment } });
    if (errors.length) {
      showErrors(errors.map((e) => ({ id: FIELD_IDS[e.field.replace(/^garments\.[a-z]+\.(anchor\.)?/, '')] || 'ffr-brand', message: e.message })));
      return;
    }
    keep(checked(said), 'shopper');
    editing = false;
    prefill = null;
    redraw();
    const next = doc.getElementById('fit-url');
    if (next) next.focus();
  }

  /* ---------- drawing ---------- */

  /* what the reference garment is missing, said as dimensions — never as
     if the shopper had nothing of their own to give */
  function missingDimensions(hasProduct) {
    return hasProduct
      ? 'No measurements of your own yet. We’ll use this product’s measurements if we have them — or edit it to add any you can measure, laid flat.'
      : 'No measurements yet. Edit it to add any you can measure, laid flat.';
  }

  function visitCard(value) {
    const g = Schema.garmentOf(value.type);
    const a = value.garment.anchor;
    const said = Schema.describeFavorite(value.garment) || {};
    const card = el('div', 'ff-ref ff-ref--visit');
    card.dataset.kind = value.type;
    const top = el('div', 'ff-ref-top');
    top.append(el('span', 'ff-ref-kind', `${cap(g.one)} · this visit`));
    const actions = el('span', 'ff-ref-actions');
    const edit = el('button', 'link-btn ff-ref-edit', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', () => { editing = true; redraw(); const f = doc.getElementById('ffr-brand'); if (f) f.focus(); });
    const remove = el('button', 'link-btn ff-ref-remove', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => { keep(null, 'shopper'); redraw(); const f = doc.getElementById('ffr-brand'); if (f) f.focus(); });
    actions.append(edit, remove);
    top.append(actions);
    card.append(top);
    card.append(el('p', 'ff-ref-name', [a.brand, a.size ? `size ${a.size}` : null, value.garment.line ? LINE_WORDS[value.garment.line] : null].filter(Boolean).join(' · ')));
    if (said.product) card.append(el('p', 'ff-ref-detail', said.product));
    card.append(el('p', 'ff-ref-detail', said.measurements ? `Measured: ${said.measurements}` : missingDimensions(Boolean(said.product))));
    card.append(el('p', 'ff-ref-status', 'Kept for this visit. Not saved to an account.'));
    return card;
  }

  let signedIn = false;
  function unsavedState() {
    const nodes = [];
    if (visit && !editing) nodes.push(visitCard(visit));
    else nodes.push(form(editing ? (prefill || visit) : prefill));
    root.dataset.locked = 'false';
    if (!signedIn) {
      const already = el('p', 'ff-muted');
      already.append(doc.createTextNode('Saved one already? '), link(setupHref(null), 'Sign in to your fit profile'), doc.createTextNode('.'));
      nodes.push(already);
    }
    root.replaceChildren(...nodes);
    root.dataset.state = signedIn ? 'none' : 'signed-out';
    root.dataset.visit = visit ? 'set' : 'empty';
    drawAnchors();
  }

  /* one kind's saved reference, as the shopper saved it */
  function referenceCard(kind, entry, readiness) {
    const g = Schema.garmentOf(kind);
    const a = entry.anchor || {};
    const said = Schema.describeFavorite(entry) || {};
    const card = el('li', `ff-ref ff-ref--${readiness.level}`);
    card.dataset.kind = kind;
    const top = el('div', 'ff-ref-top');
    top.append(el('span', 'ff-ref-kind', cap(g.one)));
    top.append(link(setupHref(kind), 'Change', 'guide-link ff-ref-change'));
    card.append(top);
    const label = [a.brand, a.size ? `size ${a.size}` : null, entry.line ? LINE_WORDS[entry.line] : null].filter(Boolean).join(' · ');
    card.append(el('p', 'ff-ref-name', label || `Your ${g.one}`));
    if (said.product) card.append(el('p', 'ff-ref-detail', said.product));
    card.append(el('p', 'ff-ref-detail', said.measurements ? `Measured: ${said.measurements}` : missingDimensions(Boolean(said.product))));
    const status = el('p', 'ff-ref-status');
    status.textContent = readiness.level === 'compare'
      ? 'Ready to compare.'
      : (readiness.improve[0] || readiness.label);
    card.append(status);
    return card;
  }

  let lastProfile = null;
  function redraw() {
    if (lastProfile && savedKinds(lastProfile).length) saved(lastProfile);
    else unsavedState();
  }
  const savedKinds = (profile) => KINDS.filter((kind) => {
    const entry = profile.garments && profile.garments[kind];
    return entry && entry.anchor && entry.favorite !== 'none';
  });

  function saved(profile) {
    const listed = savedKinds(profile);
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
    root.dataset.locked = 'false';
    root.dataset.visit = visit ? 'set' : 'empty';
    drawAnchors();
  }

  /* ---------- Popular Wardrobe Anchors ---------- */

  const anchorsBox = doc.getElementById('ff-anchors');
  const anchorList = anchorsBox && anchorsBox.querySelector('.ff-anchor-list');
  let anchors = [];
  /* only what the server listed, each with what a garment needs: a kind
     the form takes, a brand, a name and its brand's https page */
  const usable = (a) => a && typeof a.id === 'string' && KINDS.includes(a.category) && typeof a.brand === 'string' && a.brand
    && typeof a.name === 'string' && a.name && typeof a.url === 'string' && /^https:\/\//.test(a.url);
  function anchorCard(a) {
    const b = el('button', 'ff-anchor');
    b.type = 'button';
    b.dataset.id = a.id;
    b.append(el('span', 'ff-anchor-kind', cap(Schema.garmentOf(a.category).one)), el('span', 'ff-anchor-brand', a.brand), el('span', 'ff-anchor-name', a.name));
    b.addEventListener('click', () => useAnchor(a));
    return b;
  }
  /* shown wherever the form is the shopper's way in: not over saved garments */
  function drawAnchors() {
    if (!anchorsBox || !anchorList) return;
    const show = anchors.length > 0 && root.dataset.state !== 'saved' && root.dataset.state !== 'error';
    anchorsBox.hidden = !show;
    if (show && anchorList.childElementCount !== anchors.length) anchorList.replaceChildren(...anchors.map(anchorCard));
  }
  async function loadAnchors() {
    const sizing = global.Account && global.Account.sizing;
    const got = sizing && sizing.anchors ? await sizing.anchors() : null;
    anchors = got && got.ok && got.data && Array.isArray(got.data.anchors) ? got.data.anchors.filter(usable) : [];
    if (anchorsBox) anchorsBox.dataset.state = 'ready';
    drawAnchors();
  }
  /* one picked: the form, filled with what the record says — the size on
     its label is the shopper's to choose */
  function useAnchor(a) {
    const line = ['men', 'women', 'unisex'].includes(a.line) ? a.line : null;
    prefill = { type: a.category, garment: { favorite: 'perfect', line, anchor: { brand: a.brand, size: null, product: { url: a.url } } } };
    editing = true;
    redraw();
    if (anchorList) anchorList.querySelectorAll('.ff-anchor').forEach((n) => n.setAttribute('aria-pressed', String(n.dataset.id === a.id)));
    const size = doc.getElementById('ffr-size');
    if (size) size.focus();
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
    signedIn = false;
    savedInUse = false;
    lastProfile = null;
    if (account) {
      if (!account.state()) await account.load();
      if (ask !== asked) return;
      const state = account.state();
      signedIn = Boolean(state && state.signedIn);
    }
    if (!signedIn) { unsavedState(); changed(); return; }
    const got = await account.fitProfile.read();
    if (ask !== asked) return;
    if (!got.ok) { unavailable(); return; }
    /* the server keeps and returns the profile in its current shape */
    lastProfile = (got.data && got.data.profile) || Schema.empty();
    savedInUse = savedKinds(lastProfile).length > 0;
    redraw();
    changed();
  }

  refresh();
  loadAnchors();
  global.FindFitReference = {
    refresh,
    unsaved: () => (savedInUse ? null : visit),
    current: () => visit,
    forget: () => { keep(null); redraw(); },
    savedProfile: () => lastProfile,
    unlock: () => {},
    locked: () => false,
    useAnchor
  };
})(typeof window !== 'undefined' ? window : globalThis);
