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

   Which of those it is, is said first, above everything else in the
   section (#ff-ref-account): the saved garment in use; signed in with
   none saved yet; or signed out, with a way to sign in for one saved
   before. A returning shopper never has to wonder whether to type
   their garment again.

   The form is there from the start, beside the item: the two can be
   given in either order, and changing the item never takes away what
   was typed. Whether the two can be compared is the server's to say,
   when Compare fit is pressed (assets/find-fit-manual.js).

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

   Search shops: the same box, with Search shops (or Enter when nothing
   on Fynd's list is offered), searches real listings across retailers
   through the item's own search (assets/find-fit-search.js:
   /api/search, 20 a page, Load more from the server, one live product
   search per new search and none per page; no AI). A listing is only a
   product's identity — never measurements. Picking one asks the server
   what it holds for that exact product (POST ?check=1 by its link):
   a checked record of it is used as any found product is; anything else
   is said plainly ("no verified measurements for this exact garment"),
   the hand measurements open, and the garment can't be used until they
   are entered — no brand chart, no other model's measurements, nothing
   guessed. The engine's own rule (engine.js prepare: an exact, verified
   record in the label's size, or the shopper's own measurements) is what
   any comparison then uses.

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
  /* how this visit's garment was found, for the anonymous counters: 'search' | 'link' | 'manual' */
  let pickedHow = null;
  let visitHow = null;
  /* a listing picked from the live search that Fynd holds no checked
     record of: usable only with the shopper's own measurements */
  let needsMeasures = false;
  /* the item's kind, once Find Fit knows it (assets/find-fit-item.js) */
  let itemType = null;
  const itemKind = () => itemType || (global.FindFitItem && global.FindFitItem.type ? global.FindFitItem.type() : null);
  /* the saved garment the shopper chose, or null for Fynd's own choice */
  let chosenKind = null;
  const FAMILY = { hoodies: 'fleece', sweatshirts: 'fleece', tshirts: 'tees' };

  /* ---------- the form ---------- */

  function field(labelText, control, hint) {
    const wrap = el('div', 'ffr-field');
    const label = el('label', 'profile-label', labelText);
    label.htmlFor = control.id;
    /* a select drawn as the site's own, its arrow in the palette — as the item's are */
    let shown = control;
    if (control.tagName === 'SELECT') {
      control.classList.add('profile-select');
      shown = el('span', 'select-wrap');
      shown.append(control);
    }
    wrap.append(label, shown);
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
  /* a short explanation behind a small, keyboard-reachable info button —
     opened and closed by assets/find-fit-manual.js, read by screen readers
     either way (the control points at it) */
  function info(id, label, text) {
    const b = el('button', 'ff-info', 'i');
    b.type = 'button';
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('aria-controls', id);
    b.setAttribute('aria-label', label);
    const p = el('p', 'ff-info-text', text);
    p.id = id;
    p.hidden = true;
    return [b, p];
  }
  /* what the shopper is shopping for, and the unit, chosen at the top of Find Fit */
  const topChoice = (name, fallback) => { const r = doc.querySelector(`input[name="${name}"]:checked`); return r ? r.value : fallback; };
  /* the kinds Find Fit compares for now — a garment kept as another keeps its own */
  const FIND_FIT_KINDS = ['hoodies', 'sweatshirts'].filter((k) => KINDS.includes(k));

  /* One measurement, as the item's are drawn beside it: its label and an
     info button, the value with its unit in the box, and — never hidden —
     how this form measures it (one way: GARMENT_MEASURES). */
  function measureRow(k, value) {
    const spec = Schema.GARMENT_MEASURES[k];
    const row = el('div', 'ff-mrow');
    row.dataset.dim = k;
    const id = `ffr-m-${k}`;
    const fieldBox = el('div', 'ff-mfield');
    const head = el('div', 'ff-mlabel');
    /* the item's own words for each, so both columns say the same */
    const label = el('label', 'profile-label', (global.FitCandidate && global.FitCandidate.LABELS[k]) || spec.label);
    label.htmlFor = id;
    const [button, text] = info(`${id}-info`, `How to measure: ${label.textContent.toLowerCase()}`, spec.how);
    head.append(label, button);
    const box = el('span', 'measure');
    const control = input(id, 'text', value, { inputmode: 'decimal', autocomplete: 'off', 'data-measure': '', 'aria-describedby': `${id}-method ${id}-info ${id}-error` });
    box.append(control, el('span', 'measure-unit', ''));
    box.lastChild.dataset.part = 'unit-label';
    const err = el('p', 'form-error ffr-error');
    err.id = `${id}-error`;
    err.setAttribute('role', 'alert');
    fieldBox.append(head, box, text, err);
    const method = el('div', 'ff-mmethod');
    const words = global.FitCandidate ? (global.FitCandidate.METHODS[k].find((m) => m.id === spec.method) || {}).label : null;
    method.append(el('p', 'profile-label', 'Measured'));
    const fixed = el('p', 'ff-method-fixed', words || spec.how);
    fixed.id = `${id}-method`;
    fixed.dataset.method = spec.method;
    method.append(fixed);
    row.append(fieldBox, method);
    return row;
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
    /* the column's own heading says what this is; this names the group for screen readers */
    const title = el('p', 'ffr-title sr-only', 'Describe a garment you own that fits the way you like. No account needed.');
    title.id = 'ffr-form-title';
    box.append(title, finder());

    /* the one question after a product is found: the size on its label. The
       kind of garment is asked only while nothing else says it */
    const row = el('div', 'ffr-row');
    /* the kind: from the garment kept, the item's own kind, or the kind chosen for the item by hand —
       otherwise the shopper's to choose, never assumed */
    const typeField = field('Type', select('ffr-type', [['', 'Choose…']].concat(FIND_FIT_KINDS.concat(from && from.type && !FIND_FIT_KINDS.includes(from.type) ? [from.type] : []).map((k) => [k, cap(Schema.garmentOf(k).one)])),
      from ? from.type : (itemKind() && FIND_FIT_KINDS.includes(itemKind()) ? itemKind() : FIND_FIT_KINDS.includes(topChoice('ff-type', null)) ? topChoice('ff-type', null) : '')));
    typeField.id = 'ffr-type-field';
    row.append(
      typeField,
      field('Size on its label', select('ffr-size', [['', 'Choose…']].concat(Schema.LETTER_SIZES.map((s) => [s, s])), a.size || ''))
    );
    box.append(row);
    const brand = input('ffr-brand', 'text', a.brand, { maxlength: String(Schema.LIMITS.brandLength), autocomplete: 'off', list: 'ffr-brands', spellcheck: 'false' });
    const brands = el('datalist');
    brands.id = 'ffr-brands';
    Schema.ANCHOR_BRANDS.forEach((b) => { const o = el('option'); o.value = b; brands.append(o); });
    /* the rest is optional, and folded away: filled in from a product found, or left at its default —
       the brand too, which only a garment with neither a product nor measurements needs */
    const details = el('details', 'ffr-more');
    details.id = 'ffr-details';
    if (a.product || (a.brand && !a.measurements) || (g && (g.line || g.favorite === 'close'))) details.open = true;
    details.append(el('summary', 'ffr-more-summary', 'Brand, product, and how it fits (optional)'));
    details.append(field('Brand', brand), brands);
    const product = a.product ? (a.product.url || a.product.name || '') : '';
    const productField = field('Product name or link (optional)', input('ffr-product', 'text', product, { maxlength: '2000', autocomplete: 'off', spellcheck: 'false' }));
    const [productInfo, productText] = info('ffr-product-info', 'About the product name or link', 'If Fynd holds checked measurements for this exact product, it uses them for your garment.');
    /* the label and its information button on one line */
    const productLabel = productField.querySelector('label');
    const productHead = el('div', 'ff-mlabel');
    productLabel.before(productHead);
    productHead.append(productLabel, productInfo);
    productField.querySelector('input').after(productText);
    productField.querySelector('input').setAttribute('aria-describedby', 'ffr-product-info');
    details.append(productField);
    const row2 = el('div', 'ffr-row');
    row2.append(
      field('Sold as', select('ffr-line', [['not-sure', 'Not sure'], ['men', 'Men’s'], ['women', 'Women’s'], ['unisex', 'Unisex']], (g && g.line) || 'not-sure')),
      field('How it fits', select('ffr-favorite', [['perfect', 'Just how I like'], ['close', 'Close to how I like']], (g && g.favorite) || 'perfect'))
    );
    details.append(row2);
    box.append(details);

    /* the four measurements, laid flat, in the unit chosen at the top of
       Find Fit (kept in step by assets/find-fit-manual.js); any can be left
       blank — nothing is filled in */
    /* the fallback: its measurements, taken at home — open only when they're already there */
    const more = el('details', 'ffr-measure');
    more.id = 'ffr-manual';
    if (a.measurements) more.open = true;
    more.append(el('summary', 'ffr-more-summary', 'Or enter its measurements, laid flat'));
    const moreHead = el('div', 'ff-mlabel ffr-measure-head');
    const [measureInfo, measureText] = info('ffr-measure-info', 'About measuring your garment', 'Lay it flat and measure it as each line says. Leave blank any you can’t take: Fynd compares only what both garments share, and needs at least three including the chest.');
    /* the disclosure's own summary names it; here, only how to take them */
    moreHead.append(el('p', 'ffr-measure-how', 'Lay it flat and measure it as each line says.'), measureInfo);
    more.append(moreHead, measureText);
    /* the unit: the garment's own, or the one chosen at the top — never assumed */
    const unit = input('ffr-unit', 'hidden', m.unit || topChoice('ff-unit', ''));
    more.append(unit);
    const grid = el('div', 'ff-measures');
    /* in the item's order, row for row */
    const order = global.FitCandidate ? global.FitCandidate.DIMS.filter((k) => Schema.GARMENT_MEASURE_KEYS.includes(k)) : Schema.GARMENT_MEASURE_KEYS;
    order.forEach((k) => grid.append(measureRow(k, m[k])));
    more.append(grid);
    box.append(more);

    const actions = el('div', 'ffr-actions');
    /* secondary: Compare fit keeps a garment typed here by itself, so it is the page's one primary action */
    const use = el('button', 'btn btn-secondary ffr-use', 'Use this garment');
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
      placeholder: 'Brand and product — e.g. Uniqlo hoodie M', maxlength: '2000', autocomplete: 'off', spellcheck: 'false',
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
    /* the live search across shops: the item's own search, used for this garment */
    const row = el('div', 'ffr-find-row');
    const go = el('button', 'btn btn-secondary ffr-live-go', 'Search shops');
    go.type = 'button';
    go.id = 'ffr-live-go';
    row.append(smart, go);
    const hint = el('p', 'ffr-hint', 'Pick it from Fynd’s list as you type, or press Search shops. Can’t find it? Enter its measurements below.');
    hint.id = 'ffr-search-hint';
    const held = el('div', 'ffr-held');
    held.id = 'ffr-held';
    held.setAttribute('role', 'status');
    held.setAttribute('aria-live', 'polite');
    held.hidden = true;
    const liveBox = el('div', 'ffs ffr-live');
    liveBox.id = 'ffr-live';
    const liveStatus = el('p', 'ffs-status');
    liveStatus.id = 'ffr-live-status';
    liveStatus.setAttribute('role', 'status');
    liveStatus.setAttribute('aria-live', 'polite');
    const liveList = el('ul', 'ffs-results');
    liveList.id = 'ffr-live-results';
    liveList.setAttribute('aria-label', 'Products found across shops');
    const liveMore = el('button', 'btn btn-secondary ffs-more', 'Load more');
    liveMore.type = 'button';
    liveMore.id = 'ffr-live-more';
    liveMore.hidden = true;
    const liveNote = el('p', 'ffr-hint ffs-note');
    liveNote.id = 'ffr-live-note';
    liveBox.append(liveStatus, liveList, liveMore, liveNote);
    wrap.append(label, row, hint, held, liveBox);
    if (!global.FyndSuggest) { wrap.hidden = true; return wrap; }
    /* made on first use: the search module loads after this one */
    let live = null;
    let liveSize = null;
    const liveSearch = () => {
      const Live = global.FyndLiveSearch;
      if (!Live) return;
      if (!live) {
        live = Live.create({
          input: search, go: null, list: liveList, status: liveStatus, more: liveMore, note: liveNote, box: liveBox,
          enterSearches: false,
          pickLabel: 'This is mine',
          fallback: 'Enter its measurements below',
          coverageTail: 'A listing is only the product: Fynd uses measurements for your garment only when it holds verified ones for that exact product, or you enter your own.',
          onPick: (picked) => {
            if (picked.from === 'catalogue') {
              const p = picked.product;
              pickedHow = 'search';
              usePicked({ brand: { id: p.brandId || null, name: p.brandName }, product: p }, liveSize, search, held, null, true);
            } else useListing(picked.product, liveSize, search, held);
          }
        });
      }
      suggest.close();
      /* a size typed with the words is read apart, as Fynd's list reads it */
      const parsed = global.FyndSuggest.parseQuery(search.value);
      liveSize = parsed.size;
      live.submit(parsed.words);
    };
    go.addEventListener('click', liveSearch);
    const suggest = global.FyndSuggest.attach({
      input: search, box, list, status, idPrefix: 'ffr-suggest', anchors: true,
      onPick: (f, size) => usePicked(f, size, search, held),
      say: {
        unavailable: 'Fynd’s list isn’t available right now. Press Search shops, or enter its measurements below.',
        empty: (words) => `Nothing on Fynd’s list matches “${words}”. Press Search shops (or Enter) to look across retailers, or enter its measurements below.`,
        ready: (n) => `${n} on Fynd’s list. Not listed? Press Search shops, or enter its measurements below.`
      }
    });
    search.addEventListener('input', () => {
      pickAsk += 1;
      needsMeasures = false;
      held.hidden = true;
      /* a new search: what the last product said about its kind no longer stands */
      const tf = doc.getElementById('ffr-type-field');
      if (tf) tf.hidden = false;
      pickedHow = null;
      if (/^https?:\/\//i.test(search.value.trim())) { suggest.soon(''); return; }
      suggest.soon(search.value);
    });
    search.addEventListener('keydown', (e) => {
      /* a link: Fynd looks the product up itself */
      if (e.key === 'Enter' && /^https?:\/\//i.test(search.value.trim())) { e.preventDefault(); useLink(search.value.trim(), search, held); return; }
      if (suggest.key(e)) return;
      /* Enter with nothing on Fynd's list offered: search the shops */
      if (e.key === 'Enter' && search.value.trim().length >= 2) { e.preventDefault(); liveSearch(); }
    });
    search.addEventListener('paste', () => global.setTimeout(() => { if (/^https?:\/\/\S+\.\S+/i.test(search.value.trim())) useLink(search.value.trim(), search, held); }, 0));
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
  /* a link pasted: the server says which product it is (POST ?check=1 —
     nothing is fetched to answer), and that is used as a pick */
  async function useLink(url, search, held) {
    const mine = ++pickAsk;
    held.dataset.status = 'checking';
    held.replaceChildren(el('p', null, 'Looking up that link…'));
    held.hidden = false;
    const sizing = global.Account && global.Account.sizing;
    const got = sizing && sizing.check ? await sizing.check({ url }, null) : null;
    if (mine !== pickAsk) return;
    const t = got && got.ok && got.data && got.data.check && got.data.check.target;
    if (!t || t.status === 'invalid-url' || t.status === 'blocked-address') {
      held.dataset.status = 'none';
      held.replaceChildren(el('p', null, 'That doesn’t look like a product page’s address.'));
      return;
    }
    if (t.status === 'record') {
      pickedHow = 'link';
      await usePicked({ brand: { id: null, name: t.brand }, product: { name: t.name, url: t.url, category: t.category, line: t.line, code: null } }, null, search, held, got);
      return;
    }
    /* not a product Fynd knows: kept as the product, and its measurements are the way on */
    const set = (id, value) => { const n = doc.getElementById(id); if (n) n.value = value; };
    set('ffr-product', t.url || url);
    if (t.brand) set('ffr-brand', t.brand);
    pickedHow = 'link';
    held.dataset.status = 'none';
    held.replaceChildren(el('p', null, `Fynd holds no measurements for this product${t.brand ? ` from ${t.brand}` : ''}. Choose the size on its label and, if you can, enter its measurements below.`));
    const manualBox = doc.getElementById('ffr-manual');
    if (manualBox) manualBox.open = true;
  }

  /* a match picked: the fields filled from what the server listed, then the server asked what it holds */
  async function usePicked(f, size, search, held, already, fromLive) {
    if (!already) pickedHow = 'search';
    needsMeasures = false;
    const set = (id, value) => { const n = doc.getElementById(id); if (n && value !== null && value !== undefined) n.value = value; };
    if (KINDS.includes(f.product.category)) {
      set('ffr-type', f.product.category);
      /* the product says what kind it is: not asked */
      const tf = doc.getElementById('ffr-type-field');
      if (tf) tf.hidden = true;
    }
    const details = doc.getElementById('ffr-details');
    if (details) details.open = false;
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
    const got = already || (sizing && sizing.check ? await sizing.check(target, null) : null);
    if (mine !== pickAsk) return;
    const check = got && got.ok && got.data && got.data.check;
    const [status, text] = check && typeof check === 'object' ? heldSay(check)
      : ['unknown', 'What Fynd holds for this product couldn’t be checked just now. You can still use it — Fynd checks again when it compares.'];
    held.dataset.status = status;
    held.replaceChildren(el('p', null, text), ...lines);
    /* nothing Fynd can stand in with: its measurements are the way on —
       and, for a pick from the live search, the only way on */
    if (status !== 'checked') {
      const manualBox = doc.getElementById('ffr-manual');
      if (manualBox) manualBox.open = true;
      if (fromLive) needsMeasures = true;
    }
    const next = doc.getElementById('ffr-size');
    if (next && !next.value) next.focus();
  }

  /* the kind of garment, only from a listing's own name */
  function kindFromName(name) {
    const n = String(name || '').toLowerCase();
    if (/\bhood(ie|y|ed)\b/.test(n)) return 'hoodies';
    if (/\bsweat ?shirt\b|\bcrew ?neck\b/.test(n)) return 'sweatshirts';
    if (/\bt-?shirt\b|\btee\b/.test(n)) return 'tshirts';
    return null;
  }

  /* A listing picked from the live search: who sells it and what it's
     called — nothing about its measurements. Fynd asks its own records
     about that exact product (POST ?check=1, by its link; nothing is
     fetched). A record of it is used as any found product is. Anything
     else keeps the listing as the product and needs the shopper's own
     measurements: no brand chart, no other model's numbers. */
  async function useListing(p, size, search, held) {
    const mine = ++pickAsk;
    pickedHow = 'search';
    needsMeasures = false;
    held.dataset.status = 'checking';
    held.replaceChildren(el('p', null, 'Checking what Fynd holds for this exact product…'));
    held.hidden = false;
    const sizing = global.Account && global.Account.sizing;
    const got = sizing && sizing.check ? await sizing.check({ url: p.productUrl }, null) : null;
    if (mine !== pickAsk) return;
    const t = got && got.ok && got.data && got.data.check && got.data.check.target;
    if (t && t.status === 'record') {
      await usePicked({ brand: { id: null, name: t.brand }, product: { name: t.name, url: t.url, category: t.category, line: t.line, code: null } }, size, search, held, got, true);
      return;
    }
    const set = (id, value) => { const n = doc.getElementById(id); if (n && value !== null && value !== undefined) n.value = value; };
    set('ffr-product', p.productUrl);
    /* the brand only when the listing names one: a shop is not a brand */
    set('ffr-brand', p.brand || '');
    const kind = kindFromName(p.name);
    if (kind && FIND_FIT_KINDS.includes(kind)) set('ffr-type', kind);
    if (size && size.kind === 'letter' && Schema.LETTER_SIZES.includes(size.letter)) set('ffr-size', size.letter);
    search.value = [p.brand, p.name].filter(Boolean).join(' · ');
    needsMeasures = true;
    held.dataset.status = 'listing';
    const brandWords = p.brand ? `a general ${p.brand} size chart` : 'a general size chart';
    held.replaceChildren(
      el('p', null, `Fynd doesn’t have verified measurements for this exact garment yet, so the listing can’t stand in for yours — and Fynd won’t use ${brandWords} or another model’s measurements instead.`),
      el('p', null, 'To use it as your garment, measure it laid flat below: the chest and at least two more. (The Fynd extension reads size charts for the item you’re buying, not for a garment you already own.)')
    );
    const manualBox = doc.getElementById('ffr-manual');
    if (manualBox) manualBox.open = true;
    const first = doc.querySelector('#ffr-manual input[data-measure]');
    if (first) first.focus();
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
    const a2 = said.garment.anchor;
    if (needsMeasures && !a2.measurements) {
      const manualBox = doc.getElementById('ffr-manual');
      if (manualBox) manualBox.open = true;
      missing.push({ id: 'ffr-m-chestWidth', message: 'Fynd has no verified measurements for this exact garment. Enter its measurements, laid flat, to use it as yours.' });
    }
    /* measurements of its own need nothing else; a product needs the size on its
       label; with neither, the brand and size are all Fynd has to go on */
    if (!a2.measurements) {
      if (!a2.size) missing.push({ id: 'ffr-size', message: 'Choose the size on its label.' });
      if (!a2.brand && !a2.product) {
        missing.push({ id: 'ffr-brand', message: 'Enter the brand on its label, find the product above, or enter its measurements.' });
        /* the brand is folded with the optional details: shown where its problem is said */
        const d = doc.getElementById('ffr-details');
        if (d) d.open = true;
      }
    }
    if (!said.type) missing.unshift({ id: 'ffr-type', message: 'Choose whether it’s a hoodie or a sweatshirt.' });
    if (missing.length) { showErrors(missing); return; }
    /* measurements need the unit they were taken in: chosen at the top, never assumed */
    if (a2.measurements && !a2.measurements.unit) {
      const err = doc.getElementById('ff-unit-error');
      if (err) { err.textContent = 'Choose cm or in for the measurements you typed.'; err.classList.add('show'); }
      const radio = doc.querySelector('input[name="ff-unit"]');
      if (radio) radio.focus();
      return;
    }
    const { errors } = Schema.normaliseGuide({ garments: { [said.type]: said.garment } });
    if (errors.length) {
      showErrors(errors.map((e) => ({ id: FIELD_IDS[e.field.replace(/^garments\.[a-z]+\.(anchor\.)?/, '')] || 'ffr-brand', message: e.message })));
      return;
    }
    visitHow = pickedHow || 'manual';
    needsMeasures = false;
    keep(checked(said), 'shopper');
    editing = false;
    prefill = null;
    redraw();
    /* on to the item, when it hasn't been given yet */
    const next = doc.getElementById('ffi-link');
    if (next && !next.value && !(global.FindFitItem && global.FindFitItem.state() !== 'none')) next.focus();
  }

  /* ---------- drawing ---------- */

  /* what the reference garment is missing, said as dimensions — never as
     if the shopper had nothing of their own to give */
  function missingDimensions(hasProduct) {
    return hasProduct
      ? 'No measurements of your own yet. We’ll use this product’s measurements if we have them — or edit it to add any you can measure, laid flat.'
      : 'No measurements yet. Edit it to add any you can measure, laid flat.';
  }

  /* a small drawing of the garment's kind, for its card: decoration only */
  const GLYPH = {
    hoodies: 'M12 9c0-3 2.5-5 6-5s6 2 6 5l7 3 3 9-5 2-2-5v17H11V18l-2 5-5-2 3-9 7-3Zm3 0c0 2 1.5 4 3 4s3-2 3-4',
    sweatshirts: 'M13 6h10l8 4 3 11-5 2-2-6v19H11V17l-2 6-5-2 3-11 6-4Zm0 0c1 3 3 4 5 4s4-1 5-4',
    tshirts: 'M13 6h10l9 5-3 6-4-2v21H11V15l-4 2-3-6 9-5Zm0 0c1 3 3 4 5 4s4-1 5-4'
  };
  function glyph(kind) {
    const wrap = el('span', 'ff-ref-icon');
    wrap.setAttribute('aria-hidden', 'true');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 36 40');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', GLYPH[kind] || GLYPH.sweatshirts);
    svg.append(path);
    wrap.append(svg);
    return wrap;
  }

  function visitCard(value) {
    const g = Schema.garmentOf(value.type);
    const a = value.garment.anchor;
    const said = Schema.describeFavorite(value.garment) || {};
    const card = el('div', 'ff-ref ff-ref--visit');
    card.dataset.kind = value.type;
    card.append(glyph(value.type));
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

  /* ---------- the account line, atop the section ---------- */
  const accountBox = doc.getElementById('ff-ref-account');
  function drawAccount(state) {
    if (!accountBox) return;
    accountBox.dataset.state = state;
    if (state === 'signed-out') {
      accountBox.replaceChildren(el('span', null, 'Saved a garment with Fynd before?'), link(setupHref(null), 'Sign in to use it', 'guide-link ff-ref-signin'));
    } else if (state === 'none') {
      accountBox.replaceChildren(el('span', null, visit
        ? 'No garment saved on your fit profile yet. After comparing, you can save this one for next time.'
        : 'No garment saved on your fit profile yet. Add one below — after comparing, you can save it for next time.'));
    } else { accountBox.hidden = true; accountBox.replaceChildren(); return; }
    accountBox.hidden = false;
  }

  /* the wardrobe anchors live with the form they fill: put back in their
     own place before the section is redrawn, so a redraw never loses them */
  const anchorsHome = doc.getElementById('ff-anchors');
  const anchorsAfter = anchorsHome ? anchorsHome.nextSibling : null;
  function homeAnchors() {
    if (anchorsHome && anchorsAfter && anchorsHome.nextSibling !== anchorsAfter) anchorsAfter.before(anchorsHome);
  }
  /* "Add a garment you love": the one way in when there is none yet;
     the form, the anchors and every detail behind it */
  let addOpen = false;
  function addGarment(content) {
    const add = el('details', 'ffr-add');
    add.id = 'ffr-add';
    add.open = addOpen || editing || Boolean(prefill);
    const summary = el('summary', 'ffr-add-summary');
    summary.append(el('span', 'ffr-add-plus', '+'), el('span', null, 'Add a garment you love'));
    add.append(summary);
    if (anchorsHome) add.append(anchorsHome);
    add.append(content);
    add.addEventListener('toggle', () => { addOpen = add.open; });
    return add;
  }

  let signedIn = false;
  function unsavedState() {
    homeAnchors();
    const nodes = [];
    if (visit && !editing) nodes.push(visitCard(visit));
    else if (editing) nodes.push(form(prefill || visit));
    else nodes.push(addGarment(form(prefill)));
    root.dataset.locked = 'false';
    drawAccount(signedIn ? 'none' : 'signed-out');
    root.replaceChildren(...nodes);
    root.dataset.state = signedIn ? 'none' : 'signed-out';
    root.dataset.visit = visit ? 'set' : 'empty';
    drawAnchors();
  }

  /* the saved garment Fynd would choose for the item: the same kind, else the
     same family (a hoodie for a sweatshirt) — never one of another family */
  function autoKind(profile) {
    const kinds = savedKinds(profile || lastProfile || {});
    const want = itemKind();
    if (!want) return kinds[0] || null;
    return kinds.find((k) => k === want) || kinds.find((k) => FAMILY[k] === FAMILY[want]) || null;
  }
  const chosen = () => (chosenKind && lastProfile && savedKinds(lastProfile).includes(chosenKind) ? chosenKind : autoKind());

  /* one kind's saved reference, as the shopper saved it — a choice when there are several */
  function referenceCard(kind, entry, readiness, many) {
    const g = Schema.garmentOf(kind);
    const a = entry.anchor || {};
    const said = Schema.describeFavorite(entry) || {};
    const card = el('li', `ff-ref ff-ref--${readiness.level}`);
    card.dataset.kind = kind;
    card.append(glyph(kind));
    const want = itemKind();
    const other = Boolean(want) && FAMILY[want] !== FAMILY[kind];
    card.dataset.chosen = String(chosen() === kind);
    if (other) card.dataset.other = 'true';
    const top = el('div', 'ff-ref-top');
    if (many) {
      const label = el('label', 'ff-ref-pick');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'ffr-saved';
      radio.value = kind;
      radio.checked = chosen() === kind;
      radio.disabled = other;
      radio.addEventListener('change', () => { chosenKind = kind; if (global.FyndMetrics) global.FyndMetrics.manualInput('ffr-saved'); redraw(); changed('shopper'); });
      label.append(radio, el('span', 'ff-ref-kind', cap(g.one)));
      top.append(label);
    } else top.append(el('span', 'ff-ref-kind', cap(g.one)));
    top.append(link(setupHref(kind), 'Change', 'guide-link ff-ref-change'));
    card.append(top);
    const label = [a.brand, a.size ? `size ${a.size}` : null, entry.line ? LINE_WORDS[entry.line] : null].filter(Boolean).join(' · ');
    card.append(el('p', 'ff-ref-name', label || `Your ${g.one}`));
    if (said.product) card.append(el('p', 'ff-ref-detail', said.product));
    card.append(el('p', 'ff-ref-detail', said.measurements ? `Measured: ${said.measurements}` : missingDimensions(Boolean(said.product))));
    const status = el('p', 'ff-ref-status');
    status.textContent = other
      ? `A different kind of garment from the ${Schema.garmentOf(want).one} you’re considering: not compared with it.`
      : chosen() === kind && want ? 'Compared with the item.'
        : readiness.level === 'compare' ? 'Ready to compare.' : (readiness.improve[0] || readiness.label);
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
    listed.forEach((kind) => list.append(referenceCard(kind, profile.garments[kind], Schema.readiness(profile, kind), listed.length > 1)));
    const note = el('p', 'ff-muted', listed.length > 1
      ? 'Fynd uses the one that matches the item’s kind (a hoodie and a sweatshirt can stand in for each other). Choose another if you like.'
      : 'A hoodie and a sweatshirt can stand in for each other; the result says when one does.');
    const missing = KINDS.filter((k) => !listed.includes(k));
    const more = el('p', 'ff-muted');
    if (missing.length) {
      more.append(doc.createTextNode('Add another: '));
      missing.forEach((kind, i) => {
        if (i) more.append(doc.createTextNode(' · '));
        more.append(link(setupHref(kind), Schema.garmentOf(kind).one));
      });
    }
    homeAnchors();
    root.replaceChildren(list, ...(listed.length > 1 ? [note] : []), ...(missing.length ? [more] : []));
    drawAccount('saved');
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
    homeAnchors();
    root.replaceChildren(p);
    drawAccount('error');
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
    /* the header's account link, where a shopper looks for it: "Sign in" while signed out */
    const navAccount = doc.querySelector('.nav-links a[href="account.html"]');
    if (navAccount) navAccount.textContent = signedIn ? 'Account' : 'Sign in';
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

  /* the item's kind known or changed: the matching saved garment is chosen, unless the shopper chose */
  doc.addEventListener('fynd:item-change', (event) => {
    const t = event && event.detail ? event.detail.type : null;
    if (t === itemType) return;
    itemType = t;
    if (lastProfile && savedKinds(lastProfile).length) saved(lastProfile);
    else { const tf = doc.getElementById('ffr-type'); if (tf && t && !visit && [...tf.options].some((o) => o.value === t) && !(doc.getElementById('ffr-held') && !doc.getElementById('ffr-held').hidden)) tf.value = t; }
  });
  /* the first time the shopper touches the garment half */
  let startedOnce = false;
  root.addEventListener('input', () => { if (!startedOnce && global.FyndMetrics) { startedOnce = true; global.FyndMetrics.event('reference_started'); } });

  refresh();
  loadAnchors();
  global.FindFitReference = {
    /* the garment a comparison uses: { source: 'saved', type, garment, isDefault } or { source: 'visit', type, garment, how } */
    choice: () => {
      if (savedInUse && lastProfile) {
        const kind = chosen();
        return kind ? { source: 'saved', type: kind, garment: lastProfile.garments[kind], isDefault: kind === autoKind() } : null;
      }
      return visit ? { source: 'visit', type: visit.type, garment: visit.garment, how: visitHow || 'manual' } : null;
    },
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
