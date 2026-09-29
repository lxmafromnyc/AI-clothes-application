/* =========================================================
   Fynd — the reading

   Marks, as the shopper types, the words in their sentence that say
   something a search can use: the garment, its colour, its fit, the
   fabric, the occasion, the budget. Each is bracketed underneath and
   named, and the whole sentence is restated as a line of attributes.

   This is a picture of the request, drawn from the local parser's own
   vocabulary (assets/interpret.js). It never decides anything: what is
   searched for is still read by the served interpreter when the search
   is submitted, and the results page shows that reading, not this one.

   The brackets sit in a mirror of the field — the same text, in the
   same face, at the same size, laid out behind it with the letters
   themselves hidden — so each bracket lands under its word however the
   sentence wraps.
   ========================================================= */

(function (global) {
  'use strict';

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const FABRICS = new Set(['wool', 'merino', 'cashmere', 'cotton', 'linen', 'silk', 'satin', 'denim', 'leather',
    'suede', 'fleece', 'corduroy', 'tencel', 'poplin', 'oxford', 'jersey', 'knit']);

  /* Every phrase the page can mark, longest first, each with the name of
     what it says and the value it says it with. Where two readings share
     a word — "denim" is a fabric and a blue, "boxy" a cut and a fit —
     the first kind listed wins. */
  function buildPhrases() {
    const lexicon = global.Interpreter && global.Interpreter.lexicon;
    if (!lexicon) return [];
    const out = [];
    const add = (word, kind, canonical) => out.push({ word: word.toLowerCase(), kind, canonical });

    lexicon.GARMENTS.forEach(([name, words]) => words.forEach((w) => add(w, 'Garment', name)));
    Object.entries(lexicon.HINTS.colors).forEach(([value, words]) => words.forEach((w) => add(w, 'Colour', value)));
    Object.entries(lexicon.HINTS.fits).forEach(([value, words]) => words.forEach((w) => add(w, 'Fit', value)));
    lexicon.DESCRIPTORS.forEach(([name, words]) => words.forEach((w) => add(w, FABRICS.has(name) ? 'Fabric' : 'Detail', name)));
    Object.entries(lexicon.HINTS.occasions).forEach(([value, words]) => words.forEach((w) => add(w, 'Occasion', value)));
    ['wedding', 'holiday', 'vacation', 'beach', 'festival', 'concert'].forEach((w) => add(w, 'Occasion', w));
    lexicon.HINTS.seasons.forEach((w) => add(w, 'Season', w));

    /* a word said twice keeps its first meaning */
    const seen = new Set();
    return out.filter((p) => (seen.has(p.word) ? false : seen.add(p.word)))
      .sort((a, b) => b.word.length - a.word.length);
  }

  let PHRASES = null;
  const phrases = () => PHRASES || (PHRASES = buildPhrases());

  const BUDGET = /(?:\b(?:under|below|less than|up to|max|cheaper than|around|about)\s*)?\$\s*\d+(?:\.\d+)?(?:\s*(?:-|to)\s*\$?\s*\d+(?:\.\d+)?)?|\b(?:under|below|less than|up to|cheaper than)\s+\d+(?:\.\d+)?\b/gi;

  /* The marked stretches of a sentence, in order, none overlapping:
     [{ start, end, kind, value, canonical }] — value is the words as
     typed, canonical what the vocabulary files them under ("navy" is a
     Blue, "loose" is Relaxed) */
  function read(text) {
    const source = String(text || '');
    const lower = source.toLowerCase();
    const taken = new Array(source.length).fill(false);
    const spans = [];
    const claim = (start, end, kind, value, canonical) => {
      for (let i = start; i < end; i += 1) if (taken[i]) return;
      for (let i = start; i < end; i += 1) taken[i] = true;
      spans.push({ start, end, kind, value, canonical: canonical || value });
    };

    let m;
    BUDGET.lastIndex = 0;
    while ((m = BUDGET.exec(source))) claim(m.index, m.index + m[0].length, 'Budget', m[0].trim());

    for (const p of phrases()) {
      const pattern = new RegExp(`(^|[^a-z0-9])(${escapeRe(p.word).replace(/\\?[ -]/g, '[ -]')})(?=[^a-z0-9]|$)`, 'g');
      while ((m = pattern.exec(lower))) {
        const start = m.index + m[1].length;
        claim(start, start + m[2].length, p.kind, source.slice(start, start + m[2].length), p.canonical);
      }
    }
    return spans.sort((a, b) => a.start - b.start);
  }

  /* the sentence as markup, each marked stretch wrapped so it can be
     bracketed; `fresh` names the ones to draw in rather than show */
  function annotate(text, spans, fresh) {
    const source = String(text || '');
    let at = 0;
    let html = '';
    spans.forEach((s, i) => {
      html += esc(source.slice(at, s.start));
      const isNew = !fresh || fresh.has(key(s));
      html += `<span class="read${isNew ? ' is-new' : ''}" data-kind="${esc(s.kind)}" style="--n:${i}">${esc(source.slice(s.start, s.end))}</span>`;
      at = s.end;
    });
    return html + esc(source.slice(at));
  }

  const key = (s) => `${s.start}:${s.end}:${s.kind}`;

  /* the attributes as a line: BLACK / OVERSIZED / HOODIE / UNDER $80 */
  const tokens = (values) => values.map((v) => `<span class="token">${esc(v)}</span>`).join('');

  /* ---------- the field ---------- */

  function mount(field) {
    const input = field && field.querySelector('textarea');
    const mirror = field && field.querySelector('.ask-mirror');
    const readout = document.getElementById('readout');
    if (!input || !mirror) return;

    let previous = new Set();

    function paint() {
      const text = input.value || input.getAttribute('placeholder') || '';
      const spans = read(text);
      const keys = new Set(spans.map(key));
      const fresh = new Set([...keys].filter((k) => !previous.has(k)));
      previous = keys;
      /* a trailing space keeps the mirror's last line as tall as the
         field's, so the last bracket is never clipped */
      mirror.innerHTML = annotate(text, spans, fresh) + ' ';
      mirror.scrollTop = input.scrollTop;
      if (readout) {
        readout.querySelector('.tokens').innerHTML = spans.length
          ? tokens(spans.map((s) => s.value))
          : '<span class="token token--hint">Colour · fit · garment · budget</span>';
      }
    }

    input.addEventListener('input', paint);
    input.addEventListener('scroll', () => { mirror.scrollTop = input.scrollTop; });
    /* the field changes size with its text and with the window */
    if (global.ResizeObserver) new ResizeObserver(paint).observe(input);
    /* the example buttons and Clear set the value without typing */
    input.addEventListener('fynd:set', paint);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(paint);

    /* On arrival the example request types itself into the empty field
       and is read as it goes — one sentence, once, about a second long.
       It is the placeholder that types, never the value, so it is gone
       the moment the shopper starts. */
    const full = input.getAttribute('placeholder') || '';
    const still = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!full || still || input.value) { paint(); return; }

    let i = 0;
    input.setAttribute('placeholder', '');
    paint();
    const finish = () => { clearInterval(timer); input.setAttribute('placeholder', full); paint(); };
    const timer = setInterval(() => {
      if (input.value || document.activeElement === input) return finish();
      i += 1;
      input.setAttribute('placeholder', full.slice(0, i));
      paint();
      if (i >= full.length) finish();
    }, 38);
    input.addEventListener('focus', finish, { once: true });
  }

  /* A sentence already on the page, read as it comes into view: its
     brackets are drawn in once, in order, the first time it is seen. */
  function readOnView(el) {
    const marks = el.querySelectorAll('.read');
    marks.forEach((m, i) => m.style.setProperty('--n', i));
    if (!('IntersectionObserver' in global)) return;
    el.classList.add('is-waiting');
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      marks.forEach((m) => m.classList.add('is-new'));
      el.classList.remove('is-waiting');
      seen.disconnect();
    }, { threshold: 0.6 });
    seen.observe(el);
  }

  function start() {
    document.querySelectorAll('.ask-input').forEach(mount);
    document.querySelectorAll('[data-read-on-view]').forEach(readOnView);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  global.Reading = { read, annotate, tokens };
})(typeof window !== 'undefined' ? window : globalThis);
