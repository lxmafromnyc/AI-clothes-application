/* =========================================================
   Fynd — searching one brand's catalogue

   An index built once, when the brand's products load, so a typed
   query is answered from it and never by scanning every name:

     words      name, category, line and colour names, lower-cased,
                accents and ®/™ dropped, simple plurals folded
                ("hoodies" → "hoodie"), and a few shop words made one
                ("tee", "t-shirt", "t shirt" → "tshirt"; "hoody" →
                "hoodie"). The product's ID is a word too.
     matching   every word of the query must match a word of the
                product — exactly, or as its start for the word being
                typed (and any word of four letters or more). When no
                product matches every word, the products matching the
                most words are returned instead, and the words nothing
                matched are named (`unmatched`), so "black oversized
                hoodie" on a catalogue with no colour names says that
                "black" matched nothing rather than pretending it did.
     filters    category, line (a unisex product is in both men's and
                women's) and, where stock is known, in stock only
     pages      offset and limit (at most MAX_LIMIT), so a catalogue of
                thousands is never sent, or drawn, all at once

   Pure: no network, no clock, nothing from the request but the query.
   ========================================================= */

'use strict';

const MAX_QUERY = 120;
const MAX_TERMS = 8;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
const MAX_OFFSET = 50000;

const STOP = new Set(['a', 'an', 'the', 'for', 'with', 'and', 'or', 'in', 'of', 'to', 'on', 'my', 'i', 'want', 'need', 'looking', 'some', 'any']);
const SAME = { hoody: 'hoodie', hoodi: 'hoodie', tee: 'tshirt', jumper: 'sweater', trouser: 'pant', mens: 'men', womens: 'women', ladie: 'women', unisex: 'unisex' };

function stem(w) {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -1);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !/^\d+$/.test(w)) return w.slice(0, -1);
  return w;
}

/* text → [{ raw, term }], in order, without stop words */
function words(value) {
  if (typeof value !== 'string') return [];
  const s = value.slice(0, 400).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\bt[\s-]?shirts?\b/g, ' tshirt ')
    .replace(/\b(wo)?men['’]s\b/g, (m, wo) => (wo ? ' women ' : ' men '));
  const out = [];
  s.split(/[^a-z0-9]+/).forEach((raw) => {
    if (!raw || STOP.has(raw)) return;
    const st = stem(raw);
    out.push({ raw, term: SAME[st] || SAME[raw] || st });
  });
  return out;
}

const LINE_WORDS = { men: ['men'], women: ['women'], unisex: ['unisex', 'men', 'women'], kids: ['kid', 'kids'], baby: ['baby'] };

/* the words one product is found by */
function productWords(p) {
  const name = new Set(words(p.name).map((w) => w.term));
  const all = new Set(name);
  words(p.categoryLabel || '').forEach((w) => all.add(w.term));
  (LINE_WORDS[p.line] || []).forEach((w) => all.add(w));
  (p.colours || (p.catalogue && p.catalogue.colours) || []).forEach((c) => words(c && c.name ? c.name : '').forEach((w) => all.add(w.term)));
  if (typeof p.code === 'string') {
    const code = p.code.toLowerCase();
    all.add(code.replace(/[^a-z0-9]/g, ''));
    code.split(/[^a-z0-9]+/).filter(Boolean).forEach((w) => all.add(w));
    const digits = /\d{6}/.exec(code);
    if (digits) all.add(digits[0]);
  }
  return { name, all };
}

const groupOf = (p) => p.group || p.category;
const inLine = (p, line) => line === 'all' || p.line === line || (p.line === 'unisex' && (line === 'men' || line === 'women'));
const IN_STOCK = new Set(['in_stock', 'limited']);

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

/* the request's own words, held to their limits */
function readQuery(raw) {
  const q = raw && typeof raw.q === 'string' ? raw.q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) : '';
  const word = (v) => (typeof v === 'string' && /^[a-z0-9-]{1,40}$/.test(v) ? v : 'all');
  return {
    q,
    category: word(raw && raw.category),
    line: word(raw && raw.line),
    inStock: Boolean(raw && (raw.inStock === '1' || raw.inStock === true)),
    offset: clampInt(raw && raw.offset, 0, MAX_OFFSET, 0),
    limit: clampInt(raw && raw.limit, 1, MAX_LIMIT, DEFAULT_LIMIT)
  };
}

function createIndex(products, options) {
  const opts = options || {};
  const list = products.slice();
  const order = opts.categoryOrder || [];
  const bag = list.map(productWords);
  const postings = new Map();
  bag.forEach((b, i) => b.all.forEach((w) => {
    if (!postings.has(w)) postings.set(w, []);
    postings.get(w).push(i);
  }));
  const vocabulary = [...postings.keys()].sort();

  /* the words of the vocabulary starting with `prefix`, by binary search */
  function startingWith(prefix) {
    let lo = 0;
    let hi = vocabulary.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (vocabulary[mid] < prefix) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < vocabulary.length && vocabulary[i].startsWith(prefix); i += 1) out.push(vocabulary[i]);
    return out;
  }

  function matchesFor(term, prefix) {
    const hits = new Set(postings.get(term) || []);
    if (prefix) startingWith(term).forEach((w) => (postings.get(w) || []).forEach((i) => hits.add(i)));
    return hits;
  }

  /* the filters' choices across the whole catalogue, so they stay put as
     a query narrows */
  const facets = (() => {
    const cats = new Map();
    const lines = new Map();
    list.forEach((p) => {
      const g = groupOf(p);
      if (!cats.has(g)) cats.set(g, { value: g, label: p.categoryLabel || g, count: 0 });
      cats.get(g).count += 1;
      lines.set(p.line, (lines.get(p.line) || 0) + 1);
    });
    const rank = (v) => { const i = order.indexOf(v); return i >= 0 ? i : order.length; };
    return {
      categories: [...cats.values()].sort((a, b) => rank(a.value) - rank(b.value)),
      lines: [...lines.entries()].map(([value, count]) => ({ value, count }))
    };
  })();

  function search(raw, settings) {
    const query = readQuery(raw);
    const stockKnown = Boolean(settings && settings.stockKnown);
    const keep = list.map((p) => (query.category === 'all' || groupOf(p) === query.category)
      && inLine(p, query.line)
      && (!query.inStock || !stockKnown || IN_STOCK.has(p.availability || (p.catalogue && p.catalogue.availability))));
    const parsed = words(query.q).slice(0, MAX_TERMS);
    let picked;
    let partial = false;
    let unmatched = [];
    if (!parsed.length) {
      picked = list.map((p, i) => i).filter((i) => keep[i]);
    } else {
      const prefixed = parsed.map((w, n) => w.term.length >= 4 || (n === parsed.length - 1 && w.term.length >= 2));
      const sets = parsed.map((w, n) => matchesFor(w.term, prefixed[n]));
      const inName = (i, n) => bag[i].name.has(parsed[n].term) || (prefixed[n] && [...bag[i].name].some((t) => t.startsWith(parsed[n].term)));
      const score = new Map();
      sets.forEach((set, n) => set.forEach((i) => {
        if (!keep[i]) return;
        const s = score.get(i) || { matched: 0, inName: 0, at: i };
        s.matched += 1;
        if (inName(i, n)) s.inName += 1;
        score.set(i, s);
      }));
      const scored = [...score.values()];
      const best = scored.reduce((m, s) => Math.max(m, s.matched), 0);
      partial = best > 0 && best < parsed.length;
      unmatched = parsed.filter((w, n) => ![...sets[n]].some((i) => keep[i])).map((w) => w.raw);
      picked = scored.filter((s) => s.matched === best && best > 0)
        .sort((a, b) => (b.inName - a.inName) || (a.at - b.at))
        .map((s) => s.at);
    }
    const total = picked.length;
    const offset = Math.min(query.offset, total);
    return {
      query,
      total,
      offset,
      limit: query.limit,
      items: picked.slice(offset, offset + query.limit).map((i) => list[i]),
      partial,
      unmatched: parsed.length ? unmatched : [],
      facets
    };
  }

  return { search, facets, size: list.length };
}

module.exports = { createIndex, words, readQuery, DEFAULT_LIMIT, MAX_LIMIT, MAX_QUERY };
