/* =========================================================
   Fynd — a sizing record from a product page's own text

   recordFromReport(report, options) → {
     status: 'complete' | 'incomplete' | 'refused',
     record,          a sizingVersion 2 record (schema.js), or null
     missing,         what the page didn't give, as { field, why }
     notRecorded,     what the page gave that a record has no place for
     errors           schema.validate(record): empty only when complete
   }

   The input is the Fit panel's test report ("Copy test report",
   extension/sidepanel.js): the page's address and title, the product's
   name, brand, code and sizes from its structured data, and every size
   chart it found, with each cell exactly as the page wrote it. Text
   only: no image is read, kept or linked.

   What it will not do:
     - fill a gap with a guess. A field the page doesn't give is left
       out and listed in `missing`; the record then fails validation
       ('incomplete') and can't be loaded until a person supplies it
       from the page.
     - call a measurement's method anything the page (or the brand's own
       measuring guide, cited below) doesn't say.
     - turn a body chart into garment measurements, or the reverse. A
       chart that doesn't say which it measures isn't recorded.
     - mark anything verified. A record from a page is 'unverified',
       captured by the browser extension, with its review pending.

   Values are kept in the chart's own unit, with the text they were read
   from; scripts/build-fit-references.js converts to inches for the
   comparison, as for every other record.
   ========================================================= */

'use strict';

const schema = require('./schema');
const F = require('../../assets/fit-anchor');

/* the brands a record may hold (schema.js), by their site */
const BRANDS = { 'www.uniqlo.com': 'UNIQLO', 'www.nike.com': 'Nike', 'www.carhartt.com': 'Carhartt', 'www2.hm.com': 'H&M', 'www.zara.com': 'Zara' };

/* A brand's own published measuring guide, for columns its tables name
   without saying how they're measured. Quoted from the sources already
   cited in Fynd's UNIQLO records (api/_sizing/records/uniqlo-*.json):
   UNIQLO's "How to Measure Clothing" page, linked from each product's
   size guide. Nothing here is a value: only how a column is measured. */
const UNIQLO_GUIDE = 'https://faq-us.uniqlo.com/articles/en_US/FAQ/How-to-Measure';
const BRAND_METHODS = {
  UNIQLO: [
    { dim: 'chestWidth', header: /^chest$/i, method: 'flat-width-armpit-to-armpit', source: { url: UNIQLO_GUIDE, says: 'How to Measure Clothing, Tops: "B. Body Width: The length from armpit to armpit."' } },
    { dim: 'bodyLength', header: /length \(back\)/i, method: 'center-back-to-hem', source: { url: UNIQLO_GUIDE, says: 'How to Measure Clothing, Tops: "C. Body Length: The length in the back of the garment in the center to the bottom (hem)."' } },
    { dim: 'shoulderWidth', header: /^shoulder width$/i, method: 'broadest-part-of-shoulders', source: { url: UNIQLO_GUIDE, says: 'How to Measure Clothing, Tops: "A. Shoulder Width: The length between the broadest part of the shoulders."' } }
  ]
};

/* the length and width methods the chart reader takes from a column's
   own words → the record's names for them */
const STATED = {
  chestWidth: { around: 'garment-circumference' },
  bodyLength: { back: 'center-back-to-hem', hps: 'high-point-shoulder-to-hem' },
  sleeveLength: { 'center-back': 'center-back-to-cuff', 'shoulder-seam': 'shoulder-seam-to-cuff' },
  shoulderWidth: { 'seam-to-seam': 'seam-to-seam', broadest: 'broadest-part-of-shoulders' }
};
/* a flat chest is "armpit to armpit" only when the column says so */
const ARMPIT = /\b(armpit|pit[\s-]*to[\s-]*pit|underarm)\b/i;

const FLAT_DERIVATION = 'Published as a flat width, armpit to armpit, not a circumference. Where Fynd needs the garment\'s chest around, it takes 2 × the published flat width and labels the result estimated: it assumes the front and back are the same width and ignores fabric give. The derived value is never stored here.';

/* the product's kind, from its own name and title, as the schema names them */
function categoryOf(words) {
  const s = String(words || '');
  if (/\bhoodie\b|\bhooded\b/i.test(s)) return 'hoodies';
  if (/\bsweatshirt\b|\bcrew\s*neck\s+sweat\b|\bsweat\s+crew\b/i.test(s)) return 'sweatshirts';
  if (/\bt-?shirt\b|\btee\b/i.test(s)) return 'tshirts';
  return null;
}
const ANCHOR_KIND = { hoodies: 'sweatshirt', sweatshirts: 'sweatshirt', tshirts: 'tshirt' };
const GARMENT_TYPE = { hoodies: 'pullover-hoodie', sweatshirts: 'crewneck-sweatshirt', tshirts: 'crewneck-tshirt' };

const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const dateOf = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || '')) ? String(iso).slice(0, 10) : null);

function recordFromReport(report, options) {
  const o = options || {};
  const r = report && typeof report === 'object' ? report : {};
  const missing = [];
  const notRecorded = [];
  const miss = (field, why) => missing.push({ field, why });
  const refuse = (why) => ({ status: 'refused', record: null, missing: [{ field: 'record', why }], notRecorded, errors: [] });

  const page = r.page || {};
  const id = r.identified || {};
  let url;
  try { url = new URL(page.canonical || page.address); } catch (err) { return refuse('The report has no page address.'); }
  url = new URL(`${url.origin}${url.pathname}`);
  const brand = BRANDS[url.hostname];
  if (!brand) return refuse(`${url.hostname} isn't a site Fynd's record schema knows as a brand's own (schema.js OFFICIAL_HOSTS).`);
  const at = dateOf(r.fynd && r.fynd.at);
  if (!at) return refuse('The report doesn\'t say when the page was read.');

  /* the charts the page itself showed: never Fynd's own data */
  const pageCharts = (Array.isArray(r.charts) ? r.charts : []).filter((c) => c && c.source === 'retailer-page' && Array.isArray(c.rows) && Array.isArray(c.columns));
  if (!pageCharts.length) return refuse('The report holds no size chart read from the page.');

  const name = id.name || null;
  if (!name) miss('product.name', 'The page gave no product name.');
  const code = id.code || (id.retailerModule && id.retailerModule.product && id.retailerModule.product.code) || null;
  if (!code) miss('product.code', 'The page gave no product code.');
  const category = categoryOf(`${name || ''} ${page.title || ''}`);
  if (!category) miss('category', 'The product\'s name doesn\'t say it is a T-shirt, sweatshirt or hoodie (the kinds a record holds).');
  const region = (/^\/(us|ca|gb|uk)\//i.exec(url.pathname) || /\/en_(us|gb|ca)\//i.exec(url.pathname) || [])[1];
  if (!region) miss('region', 'The address doesn\'t name the country.');
  const words = `${name || ''} ${page.title || ''}`;
  const line = /\bunisex\b/i.test(words) ? 'unisex' : /\bwomen'?s?\b/i.test(words) ? 'women' : /\bmen'?s?\b/i.test(words) ? 'men' : null;
  if (!line) miss('line', 'The name and title don\'t say men, women or unisex.');
  const sizeScale = line === 'men' || line === 'women' ? line : null;
  if (!sizeScale) miss('sizeScale', line === 'unisex' ? 'A unisex product\'s size scale (men\'s or women\'s) isn\'t stated by the page.' : 'Follows from the line, which isn\'t known.');
  const fitWords = typeof id.fit === 'string' && id.fit.trim() ? id.fit.trim() : null;
  const fitClass = fitWords ? (schema.FIT_CLASSES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(fitWords)) || null) : null;
  if (!fitClass) miss('fit', fitWords ? `The page's fit words ("${fitWords}") aren't one of ${schema.FIT_CLASSES.join(', ')}.` : 'The page states no fit.');
  miss('material', 'Fabric and stretch aren\'t read from the page.');

  /* the sizes: the product's own list, then any the charts add, smallest first */
  const listed = (Array.isArray(id.sizesListed) ? id.sizesListed : []).map(String);
  const all = listed.slice();
  pageCharts.forEach((c) => c.rows.forEach((row) => { if (!all.includes(row.size)) all.push(row.size); }));
  const ranked = all.every((z) => F.sizeRank(z) !== null);
  const sizes = ranked ? all.slice().sort((a, b) => F.sizeRank(a) - F.sizeRank(b)) : all;
  if (!ranked) notRecorded.push(`Sizes kept in the page's order (${all.join(', ')}): not all are letter or number sizes Fynd can order.`);

  const charts = {};
  let units = null;
  const kind = ANCHOR_KIND[category] || 'tshirt';
  pageCharts.forEach((c) => {
    const label = c.title || c.label || 'size chart';
    if (c.measures !== 'finished-garment' && c.measures !== 'body') {
      notRecorded.push(`"${label}": it doesn't say whether it measures the garment or the body, so it isn't recorded. A person who can see the page may confirm it.`);
      return;
    }
    const which = c.measures === 'body' ? 'body' : 'garment';
    if (charts[which]) { notRecorded.push(`"${label}": a second ${which} chart on the page; only the first is recorded.`); return; }
    if (c.unit !== 'in' && c.unit !== 'cm') { notRecorded.push(`"${label}": its unit isn't stated as inches or centimetres, so its values aren't recorded.`); miss(`charts.${which}.units`, `"${label}" doesn't state its unit.`); return; }
    if (units && units !== c.unit) { notRecorded.push(`"${label}": in ${c.unit}, while the other chart is in ${units}; a record holds one unit.`); return; }
    const read = F.readChart({ measures: c.measures, unit: c.unit, columns: c.columns, rows: c.rows, methods: c.methods }, kind);
    const dims = {};
    const rows = {};
    Object.entries(read.columns).forEach(([dim, col]) => {
      if (which === 'body') {
        if (dim !== 'chestWidth') { notRecorded.push(`"${label}", column "${col.header}": a record's body chart holds the chest only.`); return; }
        dims.chest = { label: col.header, method: 'body-circumference', methodSource: { url: url.href, says: `Size chart "${label}", column "${col.header}", read as body measurements by the page's own words.` } };
      } else {
        const rule = (BRAND_METHODS[brand] || []).find((m) => m.dim === dim && m.header.test(col.header.trim()));
        let method = null;
        let methodSource = null;
        if (rule) { method = rule.method; methodSource = rule.source; }
        else if (col.methodBy !== 'inferred' && STATED[dim] && STATED[dim][col.method]) {
          method = STATED[dim][col.method];
          methodSource = { url: url.href, says: `Product table header: "${col.header}".` };
        } else if (dim === 'chestWidth' && col.method === 'flat' && col.methodBy !== 'inferred' && ARMPIT.test(col.header)) {
          method = 'flat-width-armpit-to-armpit';
          methodSource = { url: url.href, says: `Product table header: "${col.header}".` };
        }
        if (!method) miss(`charts.garment.dimensions.${dim}.method`, `Column "${col.header}" doesn't say how it is measured, and the brand's guide isn't on file for it.`);
        dims[dim] = Object.assign({ label: col.header, method }, method === 'flat-width-armpit-to-armpit' ? { derivedCircumference: { status: 'estimated', factor: 2, derivation: FLAT_DERIVATION } } : {}, { methodSource });
      }
    });
    const key = (dim) => (which === 'body' && dim === 'chestWidth' ? 'chest' : dim);
    c.rows.forEach((row) => {
      Object.entries(read.columns).forEach(([dim, col]) => {
        if (!dims[key(dim)]) return;
        const text = String(row.values[col.index] == null ? '' : row.values[col.index]).trim();
        if (!text || /^[-–—]$/.test(text)) return;       /* not published for this size: unknown */
        const p = F.parseCell(text);
        if (!p || (p.unit && p.unit !== c.unit)) { notRecorded.push(`"${label}", size ${row.size}, "${col.header}": "${text}" isn't a value in ${c.unit}.`); return; }
        const cell = which === 'body'
          ? (p.range ? { min: p.range[0], max: p.range[1], text } : { value: p.value, text })
          : (p.range ? null : { value: p.value, text });
        if (!cell) { notRecorded.push(`"${label}", size ${row.size}, "${col.header}": a range ("${text}") where a garment measurement is one value.`); return; }
        (rows[row.size] = rows[row.size] || {})[key(dim)] = cell;
      });
    });
    if (which === 'body' && dims.chest) {
      const kinds = Object.values(rows).map((x) => (x.chest && x.chest.min !== undefined ? 'range' : 'point'));
      dims.chest.kind = kinds.every((k) => k === 'range') ? 'range' : kinds.every((k) => k === 'point') ? 'point' : null;
      if (!dims.chest.kind) miss('charts.body.dimensions.chest.kind', 'The body chest mixes ranges and single values.');
    }
    if (!Object.keys(dims).length) { notRecorded.push(`"${label}": none of its columns is a dimension a record holds.`); return; }
    units = c.unit;
    charts[which] = { measures: c.measures, label, source: url.href, retrievedAt: at, dimensions: dims, sizes: rows };
  });
  if (!charts.garment) notRecorded.push('No garment measurements: the page showed none that could be recorded. None is worked out from a body chart.');

  const record = {
    sizingVersion: schema.SIZING_VERSION,
    id: [brand, code, name, region].every(Boolean) ? `${slug(brand)}-${slug(String(code).split('-')[0])}-${slug(name)}-${slug(region)}` : null,
    brand,
    product: Object.assign({ name, url: url.href, code, garmentType: category ? GARMENT_TYPE[category] : null }, page.title ? { pageTitle: page.title } : {}),
    category,
    region: region ? region.toUpperCase() : null,
    line,
    sizeScale,
    units,
    sizes,
    fit: fitClass ? { brandWords: fitWords, fitClass, source: 'product page, read by the Fynd extension' } : null,
    material: null,
    charts,
    sources: [{ url: url.href, what: `product page and its size charts (${pageCharts.map((c) => c.title || c.label).join('; ')}), read by the Fynd extension`, retrievedAt: at }]
      .concat(Object.values(charts).some((ch) => Object.values(ch.dimensions).some((d) => d.methodSource && d.methodSource.url === UNIQLO_GUIDE)) ? [{ url: UNIQLO_GUIDE, what: 'How to Measure Clothing, Tops: how each column is measured', retrievedAt: at }] : []),
    retrievedAt: at,
    capture: { how: 'browser-extension', at, by: o.by || 'Fynd extension test report' },
    review: { status: 'pending', needs: `Check every value against the page; supply ${missing.map((m) => m.field).filter((f, i, a) => a.indexOf(f) === i).join(', ') || 'nothing missing'}.` },
    verification: { status: 'unverified', checkedBy: null, checkedAt: null },
    notes: notRecorded.slice()
  };
  const errors = schema.validate(record);
  return { status: errors.length ? 'incomplete' : 'complete', record, missing, notRecorded, errors };
}

module.exports = { recordFromReport, categoryOf, BRAND_METHODS };
