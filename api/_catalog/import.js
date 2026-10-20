/* =========================================================
   Fynd — reading a catalogue feed

   One feed, from a file or an authorized API (./fetch.js), into
   products in Fynd's shape (./product.js), checked row by row. Two
   formats are read:

   1  Fynd catalogue feed, version 1 — one JSON object:

        { "format": "fynd-catalog-feed", "version": 1,
          "source": { "name": "…", "licence": "…", "licensedFields": ["price", …] },
          "generatedAt": "2026-10-20T06:00:00Z",
          "complete": true,            // every live product is listed
          "products": [ { "id", "name", "description", "url", "category", "gender",
                          "status": "active" | "discontinued",
                          "images", "colours": [{ "code", "name", "image" }],
                          "sizes", "price", "wasPrice", "availability",
                          "sizeAvailability": { "M": "in_stock" },
                          "variants": [{ "colour", "size", "availability" }] } ] }

   2  Product-feed rows, one per variant, in the field names shopping
      product feeds commonly use (Google Merchant Center's product data
      specification) — a JSON array, JSON Lines, or a tab- or
      comma-separated file with a header row:

        { "id", "item_group_id", "title", "description", "link", "image_link",
          "additional_image_link", "product_type", "gender", "age_group",
          "color", "color_code", "size", "price": "39.90 USD",
          "sale_price", "availability": "in stock" }

      Rows are grouped into one product by item_group_id (else id),
      which must be the brand's exact product ID. Such a file carries
      no header, so whether it is complete is said by whoever runs the
      sync (--complete); without that it is read as a partial update
      and removes nothing.

   The brand's own rules (IDs, hosts, categories) come from its adapter
   (./sources). A row that breaks a rule is rejected with the reason and
   never repaired; a licensed field that breaks one is dropped and the
   product kept. The feed is parsed as data only — never required,
   evaluated or templated — and its size, row count and nesting are
   capped before anything else is read.
   ========================================================= */

'use strict';

const { normalise, LICENSABLE, isPlain, text, money, availability } = require('./product');
const rakuten = require('./rakuten');

const LIMITS = { bytes: 64 * 1024 * 1024, products: 50000, rows: 400000 };
const SIZE_ORDER = ['XXXS', 'XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'];

class FeedError extends Error {
  constructor(message, reason) { super(message); this.reason = reason || 'invalid-feed'; }
}

/* no key that could reach an object's prototype survives parsing */
const reviver = (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v);

function parse(body) {
  if (typeof body !== 'string') throw new FeedError('The feed is not text.', 'not-text');
  if (Buffer.byteLength(body) > LIMITS.bytes) throw new FeedError(`The feed is larger than ${LIMITS.bytes / 1024 / 1024} MB.`, 'too-large');
  const trimmed = body.replace(/^﻿/, '').trim();
  if (!trimmed) throw new FeedError('The feed is empty.', 'empty');
  /* a delimited file keeps its trailing empty fields: only line breaks are trimmed */
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return delimited(body.replace(/^\uFEFF/, '').replace(/^[\r\n]+|[\r\n]+$/g, ''));
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try { return JSON.parse(trimmed, reviver); } catch (err) {
      /* a JSON Lines file starts with "{" too */
      if (trimmed[0] !== '{') throw new FeedError('The feed is not valid JSON.', 'bad-json');
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > LIMITS.rows) throw new FeedError(`The feed has more than ${LIMITS.rows} rows.`, 'too-many-rows');
  return lines.map((line, i) => {
    try { return JSON.parse(line, reviver); } catch (err) { throw new FeedError(`Line ${i + 1} is not valid JSON.`, 'bad-json'); }
  });
}

/* A delimited file — tab- or comma-separated, with a header row of the
   product-feed field names (id, item_group_id, title, link, …), as
   product feeds are commonly delivered — into rows. Quoted fields may hold
   the delimiter, doubled quotes and line breaks. Read as text only. */
function delimited(body) {
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) records.push(row);
      row = [];
      if (records.length > LIMITS.rows + 1) throw new FeedError(`The feed has more than ${LIMITS.rows} rows.`, 'too-many-rows');
    } else field += ch;
  }
  if (quoted) throw new FeedError('The feed ends inside a quoted field.', 'bad-delimited');
  row.push(field);
  if (row.some((f) => f !== '')) records.push(row);
  const header = (records.shift() || []).map((h) => h.trim().toLowerCase());
  if (!header.includes('id') || !header.includes('title') || !header.includes('link')) {
    throw new FeedError('This isn’t a feed this import reads: a delimited file needs a header row naming at least id, title and link.', 'unknown-format');
  }
  if (new Set(header).size !== header.length) throw new FeedError('The header row names a column twice.', 'bad-delimited');
  return records.map((r, n) => {
    if (r.length !== header.length) throw new FeedError(`Row ${n + 2} has ${r.length} columns; the header has ${header.length}.`, 'bad-delimited');
    const o = {};
    header.forEach((h, k) => { if (r[k] !== '' && h !== '__proto__' && h !== 'constructor' && h !== 'prototype') o[h] = r[k]; });
    return o;
  });
}

/* The fields the licence covers: those the operator recorded, narrowed
   to those the feed itself says it licenses, when it says. */
function licensedSet(operator, declared) {
  const ours = new Set((operator || []).filter((f) => LICENSABLE.includes(f)));
  if (!Array.isArray(declared)) return ours;
  return new Set([...ours].filter((f) => declared.includes(f)));
}

const sortSizes = (sizes) => {
  const rank = (s) => { const i = SIZE_ORDER.indexOf(s.toUpperCase()); return i >= 0 ? i : /^\d+(\.\d+)?$/.test(s) ? 100 + Number(s) : 10000; };
  return sizes.map((s, i) => [s, i]).sort((a, b) => (rank(a[0]) - rank(b[0])) || (a[1] - b[1])).map(([s]) => s);
};

/* a Fynd feed row → the adapter-mapped record ./product.js checks */
function fromFyndRow(row, adapter) {
  return {
    code: row.id,
    name: row.name,
    url: row.url,
    category: adapter.category(row.category),
    line: adapter.line(row.gender, row.category),
    description: row.description,
    images: row.images,
    colours: row.colours,
    sizes: Array.isArray(row.sizes) ? sortSizes(row.sizes.filter((s) => typeof s === 'string')) : row.sizes,
    price: row.price,
    wasPrice: row.wasPrice,
    availability: row.availability,
    sizeAvailability: row.sizeAvailability,
    variants: row.variants
  };
}

const slug = (s) => (text(s, 40) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const listOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()) : []);

/* product-feed rows → one adapter-mapped record per product */
function fromVariantRows(rows, adapter, rejected) {
  const groups = new Map();
  rows.forEach((row, index) => {
    if (!isPlain(row)) { rejected.push({ row: index + 1, error: 'not an object' }); return; }
    const code = adapter.code(row.item_group_id) || (row.item_group_id === undefined ? adapter.code(row.id) : null);
    if (!code) { rejected.push({ row: index + 1, error: 'item_group_id (or id) is not the brand’s exact product ID' }); return; }
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(row);
  });
  const out = [];
  groups.forEach((group, code) => {
    const first = group[0];
    const colours = new Map();
    const sizes = [];
    const variants = [];
    const prices = [];
    let was = null;
    const images = [];
    group.forEach((row) => {
      images.push(row.image_link, ...listOf(row.additional_image_link));
      const cname = text(row.color, 40);
      const ccode = text(row.color_code, 8) || (cname ? slug(cname) : null);
      if (ccode && !colours.has(ccode)) colours.set(ccode, { code: ccode, name: cname, image: row.image_link });
      const size = text(row.size, 12);
      if (size && !sizes.includes(size)) sizes.push(size);
      if (ccode && size && row.availability !== undefined) variants.push({ colour: ccode, size, availability: row.availability });
      const sale = row.sale_price ? money(row.sale_price, adapter.currency) : null;
      const list = row.price ? money(row.price, adapter.currency) : null;
      if (sale && list && sale.amount < list.amount) { prices.push(sale); was = Math.max(was || 0, list.amount); } else if (list) prices.push(list);
    });
    const sameCurrency = prices.every((p) => p.currency === adapter.currency);
    const low = prices.length && sameCurrency ? prices.reduce((a, b) => (b.amount < a.amount ? b : a)) : null;
    const states = variants.map((v) => availability(v.availability)).filter(Boolean);
    const discontinued = group.every((r) => typeof r.status === 'string' && r.status.toLowerCase() === 'discontinued');
    out.push({
      discontinued,
      record: {
        code,
        name: first.title,
        description: (group.find((r) => typeof r.description === 'string' && r.description.trim()) || {}).description,
        url: first.link,
        affiliateUrl: (group.find((r) => typeof r.affiliate_link === 'string' && r.affiliate_link) || {}).affiliate_link,
        category: adapter.category(first.product_type),
        line: adapter.line([first.gender, first.age_group].filter((g) => typeof g === 'string' && g !== 'adult').join(' '), first.product_type),
        images,
        colours: [...colours.values()],
        sizes: sortSizes(sizes),
        price: low ? { amount: (low.amount / 100).toFixed(2), currency: low.currency } : null,
        wasPrice: low && was && was > low.amount ? { amount: (was / 100).toFixed(2), currency: low.currency } : null,
        priceVaries: new Set(prices.map((p) => p.amount)).size > 1,
        availability: states.length ? (states.includes('in_stock') ? 'in_stock' : states.includes('limited') ? 'limited' : states.includes('preorder') ? 'preorder' : 'out_of_stock') : first.availability,
        variants
      }
    });
  });
  return out;
}

/* A whole feed → { header, products, discontinued, rejected, duplicates, notes }.
   options: { licensed: [...], complete, generatedAt } — the operator's word
   for what the file can't say about itself. */
function read(body, adapter, options) {
  const opts = options || {};
  const rejected = [];
  /* a Rakuten Advertising Product Catalog file: read into product-feed rows */
  let fromRakuten = null;
  if (rakuten.isRakuten(body)) {
    if (Buffer.byteLength(body) > LIMITS.bytes) throw new FeedError(`The feed is larger than ${LIMITS.bytes / 1024 / 1024} MB.`, 'too-large');
    try { fromRakuten = rakuten.read(body, adapter, { mid: opts.mid, now: opts.now }); } catch (err) {
      if (err instanceof rakuten.RakutenError) throw new FeedError(err.message, err.reason);
      throw err;
    }
    if (fromRakuten.rows.length > LIMITS.rows) throw new FeedError(`The feed has more than ${LIMITS.rows} rows.`, 'too-many-rows');
    fromRakuten.rejected.forEach((r) => rejected.push(r));
  }
  const data = fromRakuten ? fromRakuten.rows : typeof body === 'string' ? parse(body) : body;
  const duplicates = [];
  const notes = [];
  let header;
  let mapped;

  if (isPlain(data) && data.format === 'fynd-catalog-feed') {
    if (data.version !== 1) throw new FeedError(`Fynd catalogue feed version ${JSON.stringify(data.version)} isn’t one this import reads.`, 'unknown-version');
    if (!Array.isArray(data.products)) throw new FeedError('The feed has no products list.', 'no-products');
    if (data.products.length > LIMITS.products) throw new FeedError(`The feed lists more than ${LIMITS.products} products.`, 'too-many-products');
    const source = isPlain(data.source) ? data.source : {};
    header = {
      format: 'fynd-catalog-feed/1',
      sourceName: text(source.name, 120),
      licence: text(source.licence, 200),
      declaredLicensed: Array.isArray(source.licensedFields) ? source.licensedFields.filter((f) => typeof f === 'string') : null,
      generatedAt: typeof data.generatedAt === 'string' && !Number.isNaN(Date.parse(data.generatedAt)) ? new Date(data.generatedAt).toISOString() : null,
      complete: data.complete === true,
      fixture: data.fixture === true
    };
    header.rows = data.products.length;
    mapped = data.products.map((row, i) => (isPlain(row)
      ? { index: i + 1, discontinued: typeof row.status === 'string' && row.status.toLowerCase() === 'discontinued', record: fromFyndRow(row, adapter) }
      : { index: i + 1, invalid: true }));
  } else if (fromRakuten) {
    const h = fromRakuten.header;
    header = {
      format: h.delta ? 'rakuten-product-catalog/delta' : 'rakuten-product-catalog',
      sourceName: text(`Rakuten Advertising Product Catalog — ${h.name || 'advertiser'} (MID ${h.mid})`, 120),
      licence: null,
      declaredLicensed: null,
      generatedAt: h.generatedAt,
      /* a full file is the advertiser's whole catalogue (its trailer was checked); a delta isn't */
      complete: !h.delta,
      fixture: h.fixture,
      rows: data.length,
      advertiser: h.mid
    };
    mapped = fromVariantRows(data, adapter, rejected).map((m, i) => Object.assign({ index: i + 1 }, m));
    if (mapped.length > LIMITS.products) throw new FeedError(`The feed lists more than ${LIMITS.products} products.`, 'too-many-products');
  } else if (Array.isArray(data)) {
    header = {
      format: 'product-feed-rows',
      sourceName: null,
      licence: null,
      declaredLicensed: null,
      generatedAt: opts.generatedAt || null,
      complete: opts.complete === true,
      fixture: opts.fixture === true,
      rows: data.length
    };
    mapped = fromVariantRows(data, adapter, rejected).map((m, i) => Object.assign({ index: i + 1 }, m));
    if (mapped.length > LIMITS.products) throw new FeedError(`The feed lists more than ${LIMITS.products} products.`, 'too-many-products');
  } else {
    throw new FeedError('This isn’t a feed this import reads: a Fynd catalogue feed (format "fynd-catalog-feed") or product-feed rows.', 'unknown-format');
  }

  const licensed = licensedSet(opts.licensed, header.declaredLicensed);
  header.licensed = [...licensed].sort();
  const seen = new Set();
  const products = [];
  const discontinued = [];
  mapped.forEach((m) => {
    if (m.invalid) { rejected.push({ row: m.index, error: 'not an object' }); return; }
    const code = adapter.code(m.record.code);
    if (code && seen.has(code)) { duplicates.push(code); return; }
    if (m.discontinued) {
      if (code) { seen.add(code); discontinued.push(code); } else rejected.push({ row: m.index, error: 'a discontinued row with no valid product ID' });
      return;
    }
    const result = normalise(m.record, adapter, licensed);
    if (result.error) { rejected.push({ row: m.index, code: result.code || null, error: result.error }); return; }
    if (m.record.priceVaries && result.product.price) result.product.price.varies = true;
    seen.add(code);
    products.push(result.product);
    result.problems.forEach((p) => notes.push(`${code}: ${p}`));
  });
  return { header, products, discontinued, rejected, duplicates, notes };
}

module.exports = { read, parse, delimited, licensedSet, sortSizes, FeedError, LIMITS };
