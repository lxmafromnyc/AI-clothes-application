/* =========================================================
   Fynd — Find Fit, step 1: the garment that fits

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

   Which reference a comparison uses is the size engine's to decide
   (api/_sizing/engine.js referenceEntry): the one of the item's own
   kind, or for a hoodie or sweatshirt the other fleece top's. A saved
   one is used whenever the shopper has one; otherwise this visit's.

     FindFitReference.refresh()   read the profile again and redraw
     FindFitReference.unsaved()   this visit's garment, { type, garment },
                                  when no saved reference is in use
     FindFitReference.current()   this visit's garment, saved or not in use
     FindFitReference.forget()    clear this visit's garment
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
  /* Find Fit checks the item again whenever the reference changes */
  const changed = () => { try { doc.dispatchEvent(new global.CustomEvent('fynd:reference-change')); } catch (err) { /* no events here */ } };
  function keep(value) {
    visit = value;
    global.setTimeout(changed, 0);
    try {
      if (value) global.sessionStorage.setItem(KEY, JSON.stringify(value));
      else global.sessionStorage.removeItem(KEY);
    } catch (err) { /* kept in this page only */ }
  }

  /* the shopper's state, as last read: whether a saved reference is in use */
  let savedInUse = false;
  let editing = false;

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
    box.append(title);

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
      'If Fynd holds that product’s checked measurements, it uses them.'));
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
      cancel.addEventListener('click', () => { editing = false; redraw(); });
      actions.append(cancel);
    }
    box.append(actions);
    /* Enter applies the garment here, never the item's form around it */
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); apply(); }
    });
    return box;
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
    keep(checked(said));
    editing = false;
    redraw();
    const next = doc.getElementById('fit-url');
    if (next) next.focus();
  }

  /* ---------- drawing ---------- */

  /* what the reference garment is missing, said as dimensions — never as
     if the shopper had nothing of their own to give */
  function missingDimensions(hasProduct) {
    return hasProduct
      ? 'Reference garment dimensions (chest, length, shoulders, sleeve): none measured. Fynd can use this product’s published measurements only if it has a checked record for this exact product; otherwise, edit this garment to add any dimensions you can measure, laid flat.'
      : 'No measurements entered. Edit this garment to add any dimensions you can measure, laid flat, so Fynd has a reference to compare.';
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
    remove.addEventListener('click', () => { keep(null); redraw(); const f = doc.getElementById('ffr-brand'); if (f) f.focus(); });
    actions.append(edit, remove);
    top.append(actions);
    card.append(top);
    card.append(el('p', 'ff-ref-name', [a.brand, a.size ? `size ${a.size}` : null, value.garment.line ? LINE_WORDS[value.garment.line] : null].filter(Boolean).join(' · ')));
    if (said.product) card.append(el('p', 'ff-ref-detail', said.product));
    card.append(el('p', 'ff-ref-detail', said.measurements ? `Measured: ${said.measurements}` : missingDimensions(Boolean(said.product))));
    card.append(el('p', 'ff-ref-status', 'Not saved — kept in this tab until you close it.'));
    return card;
  }

  let signedIn = false;
  function unsavedState() {
    const nodes = [];
    if (visit && !editing) nodes.push(visitCard(visit));
    else nodes.push(form(editing ? visit : null));
    if (!signedIn) {
      const already = el('p', 'ff-muted');
      already.append(doc.createTextNode('Saved one already? '), link(setupHref(null), 'Sign in to your fit profile'), doc.createTextNode('.'));
      nodes.push(already);
    }
    root.replaceChildren(...nodes);
    root.dataset.state = signedIn ? 'none' : 'signed-out';
    root.dataset.visit = visit ? 'set' : 'empty';
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
      ? 'Ready to compare, wherever Fynd holds an item’s checked measurements.'
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
    root.dataset.visit = visit ? 'set' : 'empty';
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
  global.FindFitReference = {
    refresh,
    unsaved: () => (savedInUse ? null : visit),
    current: () => visit,
    forget: () => { keep(null); redraw(); },
    savedProfile: () => lastProfile
  };
})(typeof window !== 'undefined' ? window : globalThis);
