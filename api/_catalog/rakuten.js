/* =========================================================
   Fynd — reading a Rakuten Advertising Product Catalog file

   The format an advertiser's catalogue reaches an approved publisher in,
   as Rakuten's "Product Catalog Data Feed Implementation Guidelines for
   Publishers" (December 2023) defines it: a pipe-delimited text file,
   delivered gzipped over SFTP as MID_SID_mp.txt.gz (full) or
   MID_SID_mp_delta.txt.gz (changes only).

     HDR|<MID>|<advertiser name>|<mm/dd/yyyy hh:mm:ss, UTC>
     <one product per line: 38 fields; a delta file adds a 39th>
     TRL|<number of product lines>

   A field containing a pipe is enclosed in double quotes. The fields
   read here, by position (Appendix A):

      2 Product Name        6 Product URL      7 Product Image URL
      3 SKU Number          4 Primary Category 5 Secondary Category (~~)
      9 Short Description  10 Long Description 13 Sale Price
     14 Retail Price       16 End Date        17 Brand
     23 Availability       25 Class ID        26 Currency
     29–38 attributes — for Class 60, Clothing & Accessories (Appendix B):
       30 Product Type 31 Size 32 Material 33 Color 34 Gender 35 Style 36 Age
     39 Modification (delta files only): I insert, U update, D delete

   Each line becomes one product-feed row (the shape ./import.js already
   groups into products), so the same checks, licence narrowing and sync
   apply to this source as to every other:

   - The Product URL is Rakuten's tracking link, carrying the advertiser's
     own page in its `murl` parameter. The product's page is read from
     there (or taken as it stands when the field is already the
     advertiser's page); the adapter then accepts it only on the brand's
     own host with the product's own code in its path. The tracking link
     itself is kept, only on Rakuten's click host and only when its
     `murl` is that same page, as the product's affiliate link.
   - A file whose trailer count doesn't match its product lines, or with
     no header or trailer, is refused whole: it was cut off or isn't
     this format. A full file is the advertiser's whole catalogue, so a
     product it no longer lists is removed by the sync; a delta file
     removes only what it marks D.
   - A product whose End Date has passed is read as discontinued.
   - Prices may use a decimal comma (a publisher dashboard setting).

   Nothing here fetches anything: the file arrives through the sync
   workflow's SFTP step. Every value is still checked by ./product.js.
   ========================================================= */

'use strict';

const CLICK_HOSTS = ['click.linksynergy.com'];
const CLOTHING_CLASS = '60';
const FIELDS = { full: 38, delta: 39 };

class RakutenError extends Error {
  constructor(message, reason) { super(message); this.reason = reason || 'invalid-feed'; }
}

const isRakuten = (body) => typeof body === 'string' && /^﻿?HDR\|/.test(body);

/* one line → its fields: split on pipes outside double quotes */
function fields(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === '|') { out.push(field); field = ''; } else field += ch;
  }
  if (quoted) throw new RakutenError('A product line ends inside a quoted field.', 'bad-delimited');
  out.push(field);
  return out;
}

/* "mm/dd/yyyy hh:mm:ss" (or "mm/dd/yyyy/hh:mm:ss", as the guide's own sample writes it), UTC */
function stamp(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})[ /](\d{2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]));
  return Number.isNaN(d.getTime()) || d.getUTCMonth() !== +m[1] - 1 ? null : d.toISOString();
}

/* a decimal point or a decimal comma, never a thousands separator */
function amount(value) {
  const s = String(value || '').trim();
  if (!/^\d{1,6}([.,]\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return n > 0 ? n.toFixed(2) : null;
}

/* the advertiser's own page behind a tracking link, and the link itself
   when it is Rakuten's and points there */
function pages(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch (err) { return { page: null, tracking: null }; }
  if (CLICK_HOSTS.includes(u.hostname)) {
    const murl = u.searchParams.get('murl');
    if (!murl) return { page: null, tracking: null };
    u.protocol = 'https:';
    /* Rakuten's own samples write the destination as http://; UNIQLO's
       page is served over https, which is the only form the adapter accepts */
    return { page: murl.replace(/^http:\/\/www\.uniqlo\.com\//i, 'https://www.uniqlo.com/'), tracking: u.href };
  }
  return { page: u.href, tracking: null };
}

const AVAILABILITY = { 'in-stock': 'in stock', 'out-of-stock': 'out of stock', preorder: 'preorder', backorder: 'backorder' };

/* A whole file → { header, rows, delta }. `rows` are product-feed rows
   (id, item_group_id, title, link, image_link, product_type, gender,
   age_group, color, size, price, sale_price, availability, description,
   status, affiliate_link) with the item_group_id left for the adapter to
   find in the product's page. options.mid: the advertiser ID the file
   must be from; options.now: for End Dates. */
function read(body, adapter, options) {
  const opts = options || {};
  if (!isRakuten(body)) throw new RakutenError('This isn’t a Rakuten Product Catalog file: it doesn’t start with an HDR record.', 'unknown-format');
  const lines = body.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = fields(lines[0]);
  const tail = lines.length > 1 ? fields(lines[lines.length - 1]) : [];
  if (tail[0] !== 'TRL' || !/^\d+$/.test(tail[1] || '')) throw new RakutenError('The file has no trailer (TRL) record, so it may have been cut off. Nothing was read.', 'truncated');
  const products = lines.slice(1, -1);
  if (Number(tail[1]) !== products.length) throw new RakutenError(`The trailer says ${tail[1]} products, but the file holds ${products.length}: it was cut off or altered. Nothing was read.`, 'truncated');
  const mid = (head[1] || '').trim();
  if (!/^\d+$/.test(mid)) throw new RakutenError('The header carries no numeric advertiser ID (MID).', 'bad-header');
  if (opts.mid && String(opts.mid) !== mid) throw new RakutenError(`This file is advertiser ${mid}'s catalogue, not advertiser ${opts.mid}'s (RAKUTEN_UNIQLO_MID).`, 'wrong-advertiser');
  const generatedAt = stamp(head[3]);
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();

  let delta = null;
  const rows = [];
  const rejected = [];
  products.forEach((line, i) => {
    let f;
    try { f = fields(line); } catch (err) { rejected.push({ row: i + 1, error: err.message }); return; }
    const kind = f.length === FIELDS.delta ? 'delta' : f.length === FIELDS.full ? 'full' : null;
    if (!kind) { rejected.push({ row: i + 1, error: `${f.length} fields; a product line has ${FIELDS.full} (${FIELDS.delta} in a delta file)` }); return; }
    if (delta === null) delta = kind === 'delta';
    if ((kind === 'delta') !== delta) { rejected.push({ row: i + 1, error: 'full and delta lines mixed in one file' }); return; }
    const at = (n) => (f[n - 1] || '').trim();
    const { page, tracking } = pages(at(6));
    const code = page ? adapter.codeFromUrl(page) : null;
    const clothing = at(25) === CLOTHING_CLASS;
    const ended = stamp(at(16));
    const modification = delta ? at(39).toUpperCase() : null;
    if (delta && !['I', 'U', 'D'].includes(modification)) { rejected.push({ row: i + 1, error: 'a delta line whose Modification isn’t I, U or D' }); return; }
    const retail = amount(at(14));
    const sale = amount(at(13));
    const currency = at(26) || 'USD';
    rows.push({
      id: at(3) || null,
      item_group_id: code,
      title: at(2),
      link: page,
      affiliate_link: tracking,
      image_link: at(7),
      /* the advertiser's categories, then the clothing class's own product type */
      product_type: [at(4), ...at(5).split('~~'), clothing ? at(30) : ''].map((s) => s.trim()).filter(Boolean).join(' > '),
      gender: clothing ? at(34) : '',
      age_group: clothing ? at(36) : '',
      color: clothing ? at(33) : '',
      size: clothing ? at(31) : '',
      price: retail ? `${retail} ${currency}` : null,
      sale_price: sale && retail && Number(sale) < Number(retail) ? `${sale} ${currency}` : null,
      availability: AVAILABILITY[at(23).toLowerCase()] || (at(23) || undefined),
      description: at(10) || at(9) || undefined,
      status: modification === 'D' || (ended && Date.parse(ended) <= now) ? 'discontinued' : 'active'
    });
  });
  return {
    header: { mid, name: (head[2] || '').trim(), generatedAt, declared: Number(tail[1]), delta: Boolean(delta), fixture: /FIXTURE/.test(head[2] || '') },
    rows,
    rejected
  };
}

module.exports = { read, isRakuten, fields, stamp, amount, pages, RakutenError, CLICK_HOSTS };
