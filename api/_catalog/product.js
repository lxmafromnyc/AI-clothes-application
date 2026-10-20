/* =========================================================
   Fynd — one catalogue product, as Fynd keeps it

   Every source (an authorized API, a product-feed file) is turned into
   this one shape by its own adapter (api/_catalog/sources), so nothing
   after the import knows where a product came from:

     code            the brand's own product ID, exactly as the adapter's
                     pattern allows ("E475378-000")
     name            plain text, ≤ 160 characters, no markup
     url             the product's canonical page on the brand's own
                     site, rebuilt by the adapter from the code
     affiliateUrl    optional: the affiliate network's tracking link to
                     that same page, when the source is an affiliate feed
                     (only on the network's click host, and only when it
                     leads to `url`)
     category        one of CATEGORIES (the adapter maps the source's own)
     line            one of LINES
     — and only when the source supplies it AND the licence covers it:
     images          photos on the adapter's image host only     'images'
     colours         [{ code, name, image }]                     'colours'
     sizes           size labels, smallest first                 'sizes'
     price           { currency, amount, was } in minor units    'price'
     availability    the product's, and per size and variant     'stock'
     description     plain text, ≤ 2,000 characters              'description'

   A field the licence doesn't cover is dropped as the product is read —
   never kept and hidden later. Catalogue records hold no garment
   measurements: those come only from Fynd's sizing pipeline
   (api/_sizing), matched by the product's exact code.

   Every string is checked here, not trusted: control characters and
   markup are refused, lengths are capped, URLs must be https on the
   adapter's own hosts. Nothing from a feed is ever evaluated or
   rendered as markup — the pages draw it as text.
   ========================================================= */

'use strict';

/* the categories a product can sit under, with the label Find Fit shows */
const CATEGORIES = {
  tshirts: 'T-shirts',
  'sweatshirts-hoodies': 'Sweatshirts & Hoodies',
  knitwear: 'Sweaters & Cardigans',
  shirts: 'Shirts',
  outerwear: 'Outerwear',
  pants: 'Pants',
  jeans: 'Jeans',
  shorts: 'Shorts',
  'dresses-skirts': 'Dresses & Skirts',
  innerwear: 'Innerwear',
  loungewear: 'Loungewear & Sleepwear',
  accessories: 'Accessories',
  other: 'Other'
};
const LINES = ['men', 'women', 'unisex', 'kids', 'baby'];
/* what a licence may cover beyond the core fields */
const LICENSABLE = ['images', 'colours', 'sizes', 'price', 'stock', 'description'];
const AVAILABILITY = ['in_stock', 'limited', 'out_of_stock', 'preorder'];

const LIMITS = { name: 160, colourName: 40, size: 12, images: 12, colours: 60, sizes: 40, variants: 2400, description: 2000 };

/* The colour a shopper filters by, from the source's own colour name:
   "09 BLACK", "Dark Gray", "Off White" → black, gray, white. A name no
   word here matches has no family, and is found only by searching for
   it — never guessed into one. */
const FAMILIES = [
  ['white', /\b(white|off[ -]?white|ivory|cream|ecru)\b/],
  ['black', /\bblack\b/],
  ['gray', /\b(gr[ae]y|charcoal|heather)\b/],
  ['navy', /\bnavy\b/],
  ['blue', /\b(blue|indigo|denim|sky)\b/],
  ['green', /\b(green|olive|khaki|sage|mint)\b/],
  ['beige', /\b(beige|natural|sand|camel|oatmeal|taupe)\b/],
  ['brown', /\b(brown|chocolate|mocha|tan)\b/],
  ['red', /\b(red|wine|burgundy|maroon)\b/],
  ['pink', /\b(pink|rose|coral)\b/],
  ['purple', /\b(purple|lavender|lilac|violet)\b/],
  ['yellow', /\b(yellow|mustard)\b/],
  ['orange', /\borange\b/]
];
const COLOUR_FAMILIES = FAMILIES.map(([f]) => f);
function colourFamily(name) {
  if (typeof name !== 'string') return null;
  const s = name.toLowerCase();
  const hit = FAMILIES.find(([, re]) => re.test(s));
  return hit ? hit[0] : null;
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/* Plain text, or null: no control characters, no markup, within a cap. */
function text(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).normalize('NFC').replace(/\s+/g, ' ').trim();
  /* eslint-disable-next-line no-control-regex */
  if (!s || s.length > max || /[\u0000-\u001f\u007f-\u009f<>`\u2028\u2029]/.test(s)) return null;
  return s;
}

/* An https address on one of the given hosts, with no credentials, port
   or fragment, or null. */
function httpsOn(value, hosts) {
  if (typeof value !== 'string' || value.length > 600 || /[\s"'<>\\]/.test(value)) return null;
  let u;
  try { u = new URL(value); } catch (err) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !hosts.includes(u.hostname)) return null;
  return u.href;
}

/* "39.90", 39.9, "39.90 USD", { value, currency } → minor units, or null */
function money(value, fallbackCurrency) {
  let amount = value;
  let currency = fallbackCurrency || null;
  if (isPlain(value)) {
    amount = own(value, 'amount') ? value.amount : value.value;
    if (typeof value.currency === 'string') currency = value.currency;
  } else if (typeof value === 'string') {
    const m = /^\s*(\d{1,6}(?:\.\d{1,2})?)\s*([A-Z]{3})?\s*$/.exec(value);
    if (!m) return null;
    amount = m[1];
    if (m[2]) currency = m[2];
  }
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' && /^\d{1,6}(?:\.\d{1,2})?$/.test(amount) ? Number(amount) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100000 || !/^[A-Z]{3}$/.test(currency || '')) return null;
  return { currency, amount: Math.round(n * 100) };
}

function availability(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const alias = { instock: 'in_stock', available: 'in_stock', outofstock: 'out_of_stock', sold_out: 'out_of_stock', soldout: 'out_of_stock', unavailable: 'out_of_stock', low_stock: 'limited', backorder: 'preorder', pre_order: 'preorder' };
  const out = alias[v] || v;
  return AVAILABILITY.includes(out) ? out : null;
}

/* What each licensed field may be dropped to: the product stays. */
function optional(raw, adapter, code, licensed, problems, stored) {
  const out = {};
  if (licensed.has('images') && Array.isArray(raw.images)) {
    const images = [...new Set(raw.images.map((u) => adapter.image(u, code)).filter(Boolean))].slice(0, LIMITS.images);
    if (images.length < raw.images.length) problems.push('an image off the brand’s image host, or not this product’s, was dropped');
    if (images.length) out.images = images;
  }
  if (licensed.has('colours') && Array.isArray(raw.colours)) {
    const seen = new Set();
    const colours = [];
    raw.colours.slice(0, LIMITS.colours).forEach((c) => {
      if (!isPlain(c)) return;
      const ccode = text(c.code, 8);
      if (!ccode || !/^[A-Za-z0-9]{1,8}$/.test(ccode) || seen.has(ccode)) return;
      seen.add(ccode);
      colours.push({ code: ccode, name: text(c.name, LIMITS.colourName), image: licensed.has('images') ? adapter.image(c.image, code) : null });
    });
    if (colours.length) out.colours = colours;
  }
  if (licensed.has('sizes') && Array.isArray(raw.sizes)) {
    const sizes = [...new Set(raw.sizes.map((s) => text(isPlain(s) ? s.label : s, LIMITS.size)).filter(Boolean))].slice(0, LIMITS.sizes);
    if (sizes.length) out.sizes = sizes;
  }
  if (licensed.has('description') && raw.description !== undefined && raw.description !== null) {
    const d = text(raw.description, LIMITS.description);
    if (d) out.description = d;
    else problems.push('a description with markup, control characters or over 2,000 characters was dropped');
  }
  if (licensed.has('price') && stored && raw.price !== undefined && raw.price !== null) {
    /* a catalogue Fynd wrote: minor units already, checked as such */
    const p = raw.price;
    const minor = (n) => Number.isInteger(n) && n > 0 && n <= 10000000;
    if (isPlain(p) && p.currency === adapter.currency && minor(p.amount)) {
      out.price = { currency: p.currency, amount: p.amount, was: minor(p.was) && p.was > p.amount ? p.was : null };
      if (p.varies === true) out.price.varies = true;
    } else problems.push('a stored price that isn’t whole minor units in the market’s currency was dropped');
  } else if (licensed.has('price') && raw.price !== undefined && raw.price !== null) {
    const price = money(raw.price, adapter.currency);
    const was = raw.wasPrice !== undefined && raw.wasPrice !== null ? money(raw.wasPrice, adapter.currency) : null;
    if (!price || price.currency !== adapter.currency) problems.push('a price that isn’t a plain amount in the market’s currency was dropped');
    else out.price = { currency: price.currency, amount: price.amount, was: was && was.currency === price.currency && was.amount > price.amount ? was.amount : null };
  }
  if (licensed.has('stock')) {
    const overall = availability(raw.availability);
    if (overall) out.availability = overall;
    if (isPlain(raw.sizeAvailability) && out.sizes) {
      const bySize = {};
      out.sizes.forEach((s) => { if (own(raw.sizeAvailability, s)) { const a = availability(raw.sizeAvailability[s]); if (a) bySize[s] = a; } });
      if (Object.keys(bySize).length) out.sizeAvailability = bySize;
    }
    if (Array.isArray(raw.variants)) {
      const colours = new Set((out.colours || []).map((c) => c.code));
      const sizes = new Set(out.sizes || []);
      const seen = new Set();
      const variants = [];
      raw.variants.slice(0, LIMITS.variants).forEach((v) => {
        if (!isPlain(v)) return;
        const colour = text(v.colour, 8);
        const size = text(v.size, LIMITS.size);
        const a = availability(v.availability);
        const key = `${colour}|${size}`;
        if (!colour || !size || !a || !colours.has(colour) || !sizes.has(size) || seen.has(key)) return;
        seen.add(key);
        variants.push({ colour, size, availability: a });
      });
      if (variants.length) out.variants = variants;
    }
  }
  return out;
}

/* A tracking link on an affiliate network's click host whose
   destination (murl) is this product's canonical page, or null. */
const AFFILIATE_HOSTS = ['click.linksynergy.com'];
function affiliateLink(value, canonical, adapter) {
  const link = httpsOn(value, AFFILIATE_HOSTS);
  if (!link) return null;
  /* the destination as the network wrote it, compared over https (the
     only form the brand's page is accepted in) */
  const murl = (new URL(link).searchParams.get('murl') || '').replace(/^http:\/\//i, 'https://');
  if (!murl || typeof adapter.codeFromUrl !== 'function') return null;
  const code = adapter.codeFromUrl(murl);
  return code && adapter.canonicalUrl(murl, code) === canonical ? link : null;
}

/* One source record → { product } or { error }. `raw` is the adapter's
   already-mapped record ({ code, name, url, category, line, … }); the
   rules here are the same for every source. { stored: true } when it is
   a product Fynd's own sync wrote, whose price is already minor units. */
function normalise(raw, adapter, licensed, options) {
  const stored = Boolean(options && options.stored);
  if (!isPlain(raw)) return { error: 'not an object' };
  const code = adapter.code(raw.code);
  if (!code) return { error: 'no product ID in the brand’s own format' };
  const name = text(raw.name, LIMITS.name);
  if (!name) return { error: 'no plain-text name (≤ 160 characters, no markup or control characters)', code };
  const url = adapter.canonicalUrl(raw.url, code);
  if (!url) return { error: 'no product page on the brand’s own site carrying this product’s ID', code };
  const category = own(CATEGORIES, raw.category) ? raw.category : null;
  if (!category) return { error: 'no category the adapter could map', code };
  if (!LINES.includes(raw.line)) return { error: 'no line (men, women, unisex, kids or baby)', code };
  const problems = [];
  const product = Object.assign({ code, name, url, category, line: raw.line }, optional(raw, adapter, code, licensed, problems, stored));
  if (raw.affiliateUrl !== undefined && raw.affiliateUrl !== null) {
    const link = affiliateLink(raw.affiliateUrl, url, adapter);
    if (link) product.affiliateUrl = link;
    else problems.push('an affiliate link off the network’s click host, or not leading to this product’s page, was dropped');
  }
  return { product, problems };
}

module.exports = { CATEGORIES, LINES, LICENSABLE, AVAILABILITY, LIMITS, COLOUR_FAMILIES, colourFamily, normalise, text, httpsOn, money, availability, isPlain };
