/* =========================================================
   Fynd — product suggestions as a shopper types, for Find Fit's garment
   owned (assets/find-fit-reference.js)

   Where the suggestions come from — only what Fynd's server lists:

     Fynd's catalogue   the brands Find Fit lists (GET ?brands=1) and,
                        for each, the products matching the words typed
                        (GET ?brand=&q=, api/_catalog/search.js): free,
                        unmetered, and no shopper data travels
     checked records    with `anchors`, the products whose records are
                        checked and publish finished-garment measurements
                        (GET ?anchors=1), matched against the words here

   Not the live product search (api/search.js): that takes the intent
   /api/interpret produces, spends product-search quota and is metered
   per shopper — three searches a day on Free — so a box that asks once
   typing pauses would spend a day's searches in a few words. What the
   catalogue covers is said with every answer, in the server's own words
   (brand.coverage): never a claim to the whole of a brand's range.

   A size in the words — "Uniqlo hoodie M", "Levi's 511 32x32", "W32
   L30", "size L" — is read apart from the product's words, so it is
   never searched as part of a name (parseQuery). It is only what was
   typed: nothing here says it is right, or that a product comes in it.

   Nothing here says whether a product can be compared. A suggestion is
   only a product's identity; whether Fynd holds a checked record for it
   is the server's to say (POST ?check=1), after it is picked.

   Every answer is tied to the words that asked for it: an older, slower
   one never draws over a newer one. One request per pause in typing.

     FyndSuggest.parseQuery(text)  { words, size }
     FyndSuggest.attach(options)   a box's suggestions: see attach()
   ========================================================= */

(function (global) {
  'use strict';

  /* ---------- a size in the words ---------- */

  const LETTERS = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL'];
  const LETTER_FORM = { XXXL: '3XL', '2XL': 'XXL' };
  /* The size typed, read apart from the product's words. Only shapes a
     size takes on a label: a letter size as the last word (or after
     "size"), a waist and inseam ("32x32", "32/34", "W32 L30"), or a
     number after "size". A number on its own — "511" — is a product's,
     never taken for a size. */
  function parseQuery(raw) {
    let text = String(raw || '').replace(/\s+/g, ' ').trim();
    let size = null;
    const take = (re, make) => {
      if (size) return;
      const m = re.exec(text);
      const made = m && make(m);
      if (!made) return;
      size = made;
      text = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    };
    take(/(?:^|\s)(?:size\s+)?w\s?(\d{2})\s*[x×/ ]?\s*l\s?(\d{2})(?=\s|$)/i, (m) => waistInseam(m[1], m[2]));
    take(/(?:^|\s)(?:size\s+)?(\d{2})\s*[x×/]\s*(\d{2})(?=\s|$)/i, (m) => waistInseam(m[1], m[2]));
    take(/(?:^|\s)size\s+([a-z0-9]{1,4})(?=\s|$)/i, (m) => letterOrNumber(m[1]));
    const words = text.split(' ');
    if (!size && words.length > 1) {
      const last = words[words.length - 1].toUpperCase();
      if (LETTERS.includes(last)) {
        size = letter(last);
        text = words.slice(0, -1).join(' ');
      }
    }
    return { words: text, size };
  }
  function waistInseam(w, l) {
    const waist = Number(w);
    const inseam = Number(l);
    if (waist < 22 || waist > 54 || inseam < 24 || inseam > 40) return null;
    return { kind: 'waist-inseam', waist, inseam, label: `${waist}x${inseam}` };
  }
  function letter(t) {
    const up = t.toUpperCase();
    return { kind: 'letter', letter: LETTER_FORM[up] || up, label: up };
  }
  function letterOrNumber(t) {
    if (LETTERS.includes(t.toUpperCase())) return letter(t);
    if (/^\d{1,3}$/.test(t)) return { kind: 'number', value: Number(t), label: t };
    return null;
  }
  const sizeWords = (size) => (size.kind === 'waist-inseam' ? `waist ${size.waist}, inseam ${size.inseam}` : `size ${size.label}`);

  /* ---------- what the server lists ---------- */

  const sizingApi = () => global.Account && global.Account.sizing;
  let brandsKnown = null;
  let anchorsKnown = null;
  async function brandsNow() {
    if (brandsKnown) return brandsKnown;
    const sizing = sizingApi();
    const got = sizing && sizing.brands ? await sizing.brands() : null;
    const list = got && got.ok && got.data && Array.isArray(got.data.brands)
      ? got.data.brands.filter((b) => b && typeof b.id === 'string' && typeof b.name === 'string' && b.name) : null;
    if (list) brandsKnown = list;
    return list || [];
  }
  async function anchorsNow() {
    if (anchorsKnown) return anchorsKnown;
    const sizing = sizingApi();
    const got = sizing && sizing.anchors ? await sizing.anchors() : null;
    const list = got && got.ok && got.data && Array.isArray(got.data.anchors)
      ? got.data.anchors.filter((a) => a && typeof a.id === 'string' && typeof a.brand === 'string' && typeof a.name === 'string'
        && typeof a.url === 'string' && /^https:\/\//.test(a.url)) : null;
    if (list) anchorsKnown = list;
    return list || [];
  }

  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fold = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '');
  const MAX = 6;

  /* The products matching the words: a brand named narrows it to that
     brand, and only products matching every word are offered — never
     the "closest". `failed` is true when no source answered at all. */
  async function search(words, withAnchors) {
    const sizing = sizingApi();
    const [brands, anchors] = await Promise.all([brandsNow(), withAnchors ? anchorsNow() : []]);
    if (!sizing || !sizing.catalog || !brands.length) return { found: [], failed: true, coverage: [] };
    const named = brands.filter((b) => new RegExp(`(^|\\s)${escapeRe(fold(b.name))}(\\s|$)`).test(fold(words)));
    let rest = fold(words);
    named.forEach((b) => { rest = rest.replace(new RegExp(escapeRe(fold(b.name)), 'g'), ' '); });
    rest = rest.replace(/\s+/g, ' ').trim();
    const answers = await Promise.all((named.length ? named : brands).map((b) => sizing.catalog(b.id, { q: rest, limit: MAX })));
    const found = [];
    const coverage = [];
    let failed = 0;
    answers.forEach((got) => {
      const data = got && got.ok && got.data;
      if (!data || !Array.isArray(data.products) || !data.brand) { failed += 1; return; }
      if (typeof data.brand.coverage === 'string' && data.brand.coverage) coverage.push(data.brand.coverage);
      if (data.partial) return;
      data.products.forEach((p) => {
        if (p && typeof p.code === 'string' && typeof p.name === 'string' && typeof p.url === 'string') found.push({ from: 'catalogue', brand: data.brand, product: p });
      });
    });
    /* the checked records, every word matched in their brand and name */
    const all = fold(words).split(' ').filter(Boolean);
    anchors.forEach((a) => {
      const hay = fold(`${a.brand} ${a.name}`);
      if (!all.length || !all.every((w) => hay.includes(w))) return;
      if (found.some((f) => f.product.url === a.url)) return;
      found.push({ from: 'record', brand: { id: null, name: a.brand }, product: { code: null, name: a.name, url: a.url, category: a.category, line: a.line } });
    });
    return { found: found.slice(0, MAX), failed: failed === answers.length && !found.length, coverage };
  }

  /* ---------- one box's suggestions ----------
     attach({ input, box, list, status, idPrefix, anchors, onPick,
              say: { unavailable, empty(text), ready(n) } })
     The box is a combobox (role, aria-expanded, aria-activedescendant);
     the host calls soon(text) as the words change and key(event) on
     keydown, which returns true when it used the key. A match is
     picked by click, tap, or the arrow keys and Enter; Escape closes. */
  const LINE_WORDS = { men: 'Men', women: 'Women', unisex: 'Unisex', kids: 'Kids', baby: 'Baby' };
  function attach(o) {
    const doc = global.document;
    const el = global.SizeChart.el;
    const WAIT = 250;
    let ask = 0;
    let timer = null;
    let shown = [];
    let active = -1;
    let parsed = { words: '', size: null };
    const isOpen = () => !o.box.hidden && shown.length > 0;
    function state(text, s) {
      o.status.textContent = text;
      o.box.dataset.state = s;
    }
    function close() {
      global.clearTimeout(timer);
      ask += 1;
      shown = [];
      active = -1;
      o.list.replaceChildren();
      o.status.textContent = '';
      o.box.hidden = true;
      delete o.box.dataset.state;
      delete o.box.dataset.size;
      o.input.setAttribute('aria-expanded', 'false');
      o.input.removeAttribute('aria-activedescendant');
    }
    function soon(text) {
      global.clearTimeout(timer);
      const mine = ++ask;
      parsed = parseQuery(text);
      if (parsed.words.length < 2) { close(); return; }
      shown = [];
      active = -1;
      o.list.replaceChildren();
      o.box.hidden = false;
      o.input.setAttribute('aria-expanded', 'false');
      if (parsed.size) o.box.dataset.size = parsed.size.label; else delete o.box.dataset.size;
      state('Searching…', 'loading');
      timer = global.setTimeout(() => run(parsed, mine), WAIT);
    }
    async function run(q, mine) {
      const got = await search(q.words, Boolean(o.anchors));
      if (mine !== ask) return;
      draw(got, q);
    }
    function draw(got, q) {
      shown = got.found;
      active = -1;
      o.input.removeAttribute('aria-activedescendant');
      o.list.replaceChildren(...shown.map((f, i) => {
        const li = el('li', 'ff-suggest-option');
        li.id = `${o.idPrefix}-${i}`;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        if (f.product.code) li.dataset.code = f.product.code;
        li.dataset.from = f.from;
        li.append(el('span', 'ff-suggest-name', f.product.name),
          el('span', 'ff-suggest-meta', [f.brand.name, f.product.categoryLabel, LINE_WORDS[f.product.line]].filter(Boolean).join(' · ')));
        if (f.from === 'catalogue' && typeof f.product.holdsText === 'string' && f.product.holdsText) li.append(el('span', 'ff-suggest-holds', f.product.holdsText));
        /* pressed, not clicked: the box keeps focus, so nothing closes first */
        li.addEventListener('mousedown', (event) => event.preventDefault());
        li.addEventListener('click', () => pick(i));
        return li;
      }));
      o.input.setAttribute('aria-expanded', String(shown.length > 0));
      const size = q.size ? ` ${q.size.kind === 'waist-inseam' ? 'Waist and inseam' : 'Size'} ${q.size.label} read apart from the product’s name.` : '';
      const covers = got.coverage.length ? ` Fynd’s list: ${got.coverage.join(' ')}` : '';
      if (got.failed) state(o.say.unavailable, 'error');
      else if (!shown.length) state(`${o.say.empty(q.words)}${size}${covers}`, 'empty');
      else state(`${o.say.ready(shown.length)}${size}${covers}`, 'ready');
    }
    function highlight(i) {
      active = i;
      o.list.querySelectorAll('.ff-suggest-option').forEach((li, n) => li.setAttribute('aria-selected', String(n === i)));
      if (i >= 0) {
        o.input.setAttribute('aria-activedescendant', `${o.idPrefix}-${i}`);
        const li = doc.getElementById(`${o.idPrefix}-${i}`);
        if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
      } else o.input.removeAttribute('aria-activedescendant');
    }
    function pick(i) {
      const f = shown[i];
      if (!f) return;
      const size = parsed.size;
      close();
      o.onPick(f, size);
    }
    function key(event) {
      if (event.key === 'ArrowDown' && isOpen()) { highlight(active < shown.length - 1 ? active + 1 : 0); }
      else if (event.key === 'ArrowUp' && isOpen()) { highlight(active > 0 ? active - 1 : shown.length - 1); }
      else if (event.key === 'Enter' && isOpen()) { pick(active >= 0 ? active : 0); }
      else if (event.key === 'Escape' && !o.box.hidden) { close(); }
      else return false;
      event.preventDefault();
      return true;
    }
    o.input.addEventListener('blur', () => { global.setTimeout(() => { if (doc.activeElement !== o.input) close(); }, 0); });
    return { soon, close, key, isOpen };
  }

  /* The engine's reasons that are about a product alone — decided before
     any reference is read (api/_sizing/engine.js prepare): with any
     other, the product holds checked garment measurements. Read from the
     server's answer (POST ?check=1), never worked out here. */
  const ITEM_GAPS = ['no-record', 'category-not-covered', 'unverified-data', 'crowdsourced-data', 'body-chart-only'];
  const heldChecked = (check) => Boolean(check && check.target && check.target.status === 'record' && check.validation
    && typeof check.validation.code !== 'undefined' && !ITEM_GAPS.includes(check.validation.code));

  global.FyndSuggest = { parseQuery, sizeWords, attach, ITEM_GAPS, heldChecked };
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseQuery, sizeWords, ITEM_GAPS, heldChecked };
})(typeof window !== 'undefined' ? window : globalThis);
