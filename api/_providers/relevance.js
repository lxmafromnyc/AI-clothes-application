/* =========================================================
   Fynd — the order a descriptive request's results are shown in

   A request that names its garment in shop words ("black oversized
   hoodie under $80") is shown in the provider's own order, as it always
   was: the provider was asked for exactly that, and its order is its
   answer. Nothing here runs for it.

   A DESCRIPTIVE request ("something like a hoodie but cleaner") was
   searched with concepts the shopper never typed, so the provider's
   order is its order for OUR phrase, not for what the shopper meant.
   Its verified products are put in order of how plainly each one is
   what the request most likely means, by what each one's own verified
   title, brand and price say:

     1. the hard constraints the shopper stated: colour, gender, brand
     2. the concept: the strongest concept first, the garment the request
        named, then the rest in the reader's order
     3. the silhouette the shopper asked for ("loose")
     4. the style signals ("cleaner", "cozy", "not too formal") — and,
        held below everything that matches, a title that says the
        opposite ("graphic" for cleaner, "gown" for not too formal), or
        names a garment the request gave no evidence for (a bomber for
        "a shirt that looks like a jacket")
     5. price, only when the shopper said it should not be expensive

   What this does, and only this: it SORTS. The sort is stable, so
   products the request says nothing to tell apart keep the provider's
   order. Nothing is removed, nothing is added, no field of any product
   is read from anywhere but the product, and none is written. The score
   is internal: it is never put on a product, never sent to the browser,
   and never shown as a match percentage, because it is a ranking, not a
   measurement of anything a shopper could check.
   ========================================================= */

'use strict';

let lexicon = null;
function words() {
  if (lexicon) return lexicon;
  require('../../assets/interpret.js');
  lexicon = (globalThis.Interpreter && globalThis.Interpreter.lexicon) || { GARMENTS: [], EXTRA_ANCHORS: [], COLOUR_WORDS: [] };
  return lexicon;
}

/* What a concept is called on a shop's listing, beyond its own name.
   Matched as a SET of words, so "Cropped Denim Jacket" is a cropped
   jacket and "Pullover Knit Sweater" a knit pullover. */
const CONCEPT_TITLES = {
  'quarter zip pullover': ['quarter zip', 'half zip', 'quarterzip', 'qtr zip', '1 4 zip'],
  'crewneck sweatshirt': ['crewneck sweatshirt', 'crew neck sweatshirt', 'crew sweatshirt', 'crewneck sweat'],
  'knit pullover': ['knit pullover', 'knit sweater', 'pullover sweater', 'jumper'],
  'crewneck sweater': ['crewneck sweater', 'crew neck sweater', 'crew sweater'],
  sweatshirt: ['sweatshirt', 'crewneck'],
  sweater: ['sweater', 'jumper', 'knit pullover'],
  cardigan: ['cardigan'],
  'zip up hoodie': ['zip hoodie', 'zip up hoodie', 'full zip hoodie', 'zip hooded'],
  overshirt: ['overshirt', 'over shirt', 'shacket', 'shirt jacket'],
  'shirt jacket': ['shirt jacket', 'shacket', 'overshirt'],
  'chore jacket': ['chore jacket', 'chore coat', 'work jacket', 'cpo'],
  'cropped jacket': ['cropped jacket', 'crop jacket', 'short jacket'],
  'light jacket': ['light jacket', 'lightweight jacket'],
  'wide leg trousers': ['wide leg trouser', 'wide leg pant', 'wide trouser', 'wide pant', 'palazzo', 'wide leg slack'],
  'relaxed trousers': ['relaxed trouser', 'relaxed pant', 'loose trouser', 'loose pant', 'baggy trouser', 'relaxed fit pant', 'relaxed fit trouser'],
  'pleated trousers': ['pleated trouser', 'pleated pant', 'pleat front trouser', 'pleat front pant'],
  'tailored trousers': ['tailored trouser', 'tailored pant', 'dress pant', 'dress trouser', 'suit trouser'],
  'trouser jeans': ['trouser jean', 'tailored jean'],
  'tailored joggers': ['tailored jogger', 'tailored sweatpant'],
  'heavyweight tee': ['heavyweight tee', 'heavyweight t shirt', 'heavy weight tee'],
  'knit polo': ['knit polo', 'sweater polo', 'polo sweater'],
  'mock neck tee': ['mock neck tee', 'mock neck t shirt', 'mock neck top'],
  'shift dress': ['shift dress'],
  't-shirt dress': ['t shirt dress', 'tee dress', 'tshirt dress'],
  'shirt dress': ['shirt dress', 'shirtdress'],
  'knit dress': ['knit dress', 'sweater dress'],
  'sweater dress': ['sweater dress', 'knit dress'],
  'fleece jacket': ['fleece jacket', 'fleece zip', 'polar fleece'],
  'sherpa jacket': ['sherpa jacket', 'teddy jacket', 'borg jacket'],
  'knit blazer': ['knit blazer', 'jersey blazer', 'cardigan blazer'],
  'sweater jacket': ['sweater jacket', 'knit jacket', 'sweater coat'],
  'knit jacket': ['knit jacket', 'sweater jacket'],
  'chunky sweater': ['chunky sweater', 'chunky knit', 'cable knit sweater'],
  'fine knit sweater': ['fine knit', 'fine gauge', 'lightweight sweater'],
  'button down shirt': ['button down', 'button up', 'button front shirt'],
  'flannel shirt': ['flannel shirt', 'flannel'],
  'knit top': ['knit top', 'sweater top', 'ribbed top'],
  'fitted tee': ['fitted tee', 'fitted t shirt', 'slim tee', 'baby tee'],
  tee: ['tee', 't shirt', 'tshirt'],
  't-shirt': ['tee', 't shirt', 'tshirt'],
  trousers: ['trouser', 'pant', 'slack', 'chino'],
  jeans: ['jean'],
  'shoulder bag': ['shoulder bag', 'hobo bag', 'baguette bag', 'shoulder handbag'],
  'top handle bag': ['top handle', 'satchel'],
  'structured bag': ['structured bag', 'top handle', 'satchel'],
  'tote bag': ['tote'],
  'minimal sneakers': ['minimal sneaker', 'low top sneaker', 'court sneaker'],
  'low top sneakers': ['low top', 'court sneaker'],
  'teddy coat': ['teddy coat', 'sherpa coat', 'borg coat'],
  'lounge pants': ['lounge pant', 'lounge trouser'],
  sweatpants: ['sweatpant', 'jogger'],
  shrug: ['shrug', 'bolero']
};

/* What a title says about each signal: words that show it, and words
   that say the opposite. Only words a shop writes in a title. */
const SIGNAL_TITLES = {
  polished: { yes: ['tailored', 'pleated', 'refined', 'smart', 'structured', 'elevated', 'dressy', 'quarter zip', 'half zip', 'fine knit', 'merino'], no: ['graphic', 'distressed', 'ripped', 'destroyed', 'slogan', 'tie dye', 'cartoon', 'logo print', 'acid wash'] },
  minimal: { yes: ['minimal', 'minimalist', 'essential', 'plain', 'basic', 'clean', 'classic', 'solid'], no: ['graphic', 'print', 'printed', 'logo', 'slogan', 'embroidered', 'tie dye', 'camo', 'sequin', 'distressed', 'ripped', 'patchwork'] },
  cozy: { yes: ['fleece', 'sherpa', 'soft', 'brushed', 'plush', 'cozy', 'cosy', 'chunky', 'teddy', 'waffle', 'cable', 'knit', 'cashmere', 'fuzzy', 'lined', 'borg'], no: ['mesh', 'sheer', 'compression'] },
  casual: { yes: ['casual', 'everyday', 'jersey', 't shirt dress', 'tee dress', 'cotton'], no: ['gown', 'formal', 'evening', 'sequin', 'bridal', 'prom', 'cocktail', 'ball', 'beaded', 'tuxedo', 'wedding'] },
  vintage: { yes: ['vintage', 'retro', 'vintage style', 'vintage inspired'], no: [] },
  relaxed: { yes: ['relaxed', 'wide', 'loose', 'baggy', 'oversized', 'barrel', 'palazzo', 'slouchy', 'flowy', 'boxy'], no: ['skinny', 'slim', 'fitted', 'bodycon', 'tight', 'compression', 'legging'] },
  fitted: { yes: ['slim', 'skinny', 'fitted', 'bodycon'], no: ['oversized', 'baggy', 'relaxed', 'loose'] },
  short: { yes: ['cropped', 'crop', 'short'], no: ['longline', 'long line', 'maxi'] },
  /* what "not skinny" and "not too baggy" leave */
  straight: { yes: ['straight', 'relaxed', 'wide', 'regular'], no: ['skinny', 'legging', 'bodycon', 'slim'] },
  regular: { yes: ['straight', 'regular', 'tailored'], no: ['baggy', 'palazzo', 'wide', 'oversized', 'skinny'] },
  warm: { yes: ['fleece', 'sherpa', 'wool', 'insulated', 'lined', 'quilted', 'knit', 'thermal', 'cashmere', 'puffer', 'teddy'], no: ['linen', 'mesh', 'sheer', 'tank', 'camisole'] }
};

/* what a listing says about how heavy it is */
const PROPERTY_TITLES = {
  heavyweight: { yes: ['heavyweight', 'heavy', 'thick', 'chunky', 'heavy twill'], no: ['lightweight', 'thin', 'sheer'] },
  lightweight: { yes: ['lightweight', 'light', 'thin', 'french terry', 'fine knit', 'long sleeve tee'], no: ['heavyweight', 'heavy', 'sherpa', 'fleece', 'puffer', 'padded', 'insulated', 'chunky'] },
  warm: { yes: ['fleece', 'sherpa', 'wool', 'insulated', 'lined', 'quilted', 'knit', 'thermal', 'cashmere', 'puffer', 'teddy'], no: ['linen', 'mesh', 'sheer', 'tank', 'camisole'] }
};

/* what a listing for an occasion is called */
const OCCASION_TITLES = {
  'going out': ['going out', 'satin', 'mini', 'party', 'corset'],
  'date night': ['satin', 'slip', 'going out'],
  'wedding guest': ['wedding', 'guest'],
  office: ['tailored', 'trouser', 'blazer', 'oxford', 'button down', 'pleated', 'straight leg'],
  workout: ['performance', 'athletic', 'legging', 'jogger', 'track'],
  vacation: ['linen', 'sundress', 'swim']
};

const GENDER_TITLES = {
  men: ['men', 'man', 'mens', 'male'],
  women: ['women', 'woman', 'womens', 'ladies', 'lady', 'female']
};

/* the same plural rule discovery reads titles with, so "Trousers" is
   trouser and "Pants" is pant */
function singular(word) {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (/ss$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

const tokens = (value) => String(value || '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(singular);

/* a phrase is in a title when every one of its words is */
function says(titleWords, phrase) {
  const own = tokens(phrase);
  return own.length > 0 && own.every((word) => titleWords.has(word));
}

const listOf = (value) => (Array.isArray(value) ? value.filter((one) => typeof one === 'string' && one.trim()) : []);

function anchorTitles(anchor) {
  const { GARMENTS, EXTRA_ANCHORS } = words();
  const entry = (GARMENTS || []).find(([name]) => name === anchor) || (EXTRA_ANCHORS || []).find(([name]) => name === anchor);
  return entry ? entry[1] : [anchor];
}

const conceptTitles = (name) => [name].concat(CONCEPT_TITLES[name] || []);

/* How plainly one verified product is what the request most likely
   means. Internal: compared, never shown. */
function scoreOf(product, intent, prepared) {
  const title = String((product && product.name) || '');
  const titleWords = new Set(tokens(`${title} ${(product && product.category) || ''}`));
  let score = 0;

  /* 0. what the request ruled out. Said by the shopper, so it outweighs
     everything else: a "not skinny" request never shows skinny jeans
     above anything it does want */
  if (prepared.without.some((phrase) => says(titleWords, phrase))) score -= 60;

  /* 1. hard constraints, as the product's own fields state them */
  const colours = prepared.colours;
  if (colours.length && !prepared.ambiguous.includes('colour')) {
    const shown = new Set(tokens(`${title} ${listOf(product.colors).join(' ')}`));
    /* matched on the colour itself: "light grey" asked, "Heather Grey" shown */
    if (colours.some((c) => says(shown, tokens(c).slice(-1).join(' ')))) score += 40;
    else if (prepared.otherColours.some((c) => says(shown, c))) score -= 40;
  }
  if (prepared.gender) {
    const other = prepared.gender === 'men' ? GENDER_TITLES.women : GENDER_TITLES.men;
    if (other.some((word) => titleWords.has(word))) score -= 40;
  }
  if (prepared.brands.length) {
    const brand = new Set(tokens(`${product.brand || ''} ${title}`));
    if (prepared.brands.some((b) => says(brand, b))) score += 40;
  }

  /* 2. the concept */
  let matched = -1;
  prepared.concepts.forEach((name, at) => {
    if (matched !== -1) return;
    if (conceptTitles(name).some((phrase) => says(titleWords, phrase))) matched = at;
  });
  if (matched !== -1) score += Math.max(30 - 4 * matched, 12);
  if (prepared.anchorIsTarget && anchorTitles(prepared.anchor).some((phrase) => says(titleWords, phrase))) score += 10;
  /* a plain reading has no concepts: its own words are the evidence, and
     a listing that carries none of them but a colour is another thing
     entirely — a black backpack for "black thing long sleeve" */
  if (prepared.terms.length) {
    const own = prepared.terms.filter((term) => !prepared.colours.includes(term) && !/^(women|men|womens|mens)$/.test(term));
    const hits = own.filter((term) => says(titleWords, term)).length;
    if (own.length) score += hits ? Math.min(hits * 10, 30) : -45;
  }
  /* a garment named only as the setting, shown as if it were the thing:
     jeans for "something to wear with jeans" */
  if (matched === -1 && prepared.context.some((name) => anchorTitles(name).some((phrase) => says(titleWords, phrase)))) score -= 30;
  if (matched === -1 && prepared.avoid.some((phrase) => says(titleWords, phrase))) score -= 30;

  /* 3 and 4. silhouette, then style, then what it is like and for */
  for (const property of prepared.properties) {
    const evidence = PROPERTY_TITLES[property];
    if (!evidence) continue;
    if (evidence.yes.some((phrase) => says(titleWords, phrase))) score += 8;
    if (evidence.no.some((phrase) => says(titleWords, phrase))) score -= 10;
  }
  if (prepared.occasion && (OCCASION_TITLES[prepared.occasion] || []).some((phrase) => says(titleWords, phrase))) score += 6;
  /* a style named by who wears it ("skater style") shows in the word
     itself; "vintage style" only in a listing that says it is a style,
     not in one that IS vintage */
  if (prepared.style) {
    const styleSaid = prepared.style === 'vintage style' ? ['vintage style', 'vintage inspired', 'retro'] : [prepared.style, prepared.style.replace(/ style$/, '')];
    if (styleSaid.some((phrase) => says(titleWords, phrase))) score += 4;
  }
  for (const signal of prepared.signals) {
    const evidence = SIGNAL_TITLES[signal];
    if (!evidence) continue;
    /* "oversized but fitted": neither fit is held to */
    if (prepared.ambiguous.includes('fit') && /^(relaxed|fitted|straight|regular)$/.test(signal)) continue;
    const weight = signal === 'relaxed' || signal === 'fitted' || signal === 'short' ? 12 : 6;
    if (evidence.yes.some((phrase) => says(titleWords, phrase))) score += weight;
    if (evidence.no.some((phrase) => says(titleWords, phrase))) score -= weight === 12 ? 12 : 15;
  }

  /* 5. price, only when asked: up to 5, cheapest of the set highest, and
     held down when it costs more than twice what this set typically does.
     "Not crazy expensive" states no number, so none is invented: the
     comparison is with the other listings the same search found. */
  if (prepared.affordable && typeof product.price === 'number' && prepared.priceSpan > 0) {
    score += 5 * (1 - (product.price - prepared.minPrice) / prepared.priceSpan);
    if (prepared.medianPrice && product.price > 2 * prepared.medianPrice) score -= 25;
  }
  return score;
}

function prepare(intent, products) {
  const c = intent.concepts;
  const { COLOUR_WORDS } = words();
  const beside = listOf(c.beside);
  const colours = listOf(c.colors).length
    ? listOf(c.colors)
    : listOf(intent.colors).map((one) => one.toLowerCase()).filter((one) => (COLOUR_WORDS || []).includes(one) && !beside.includes(one) && !listOf(c.without).includes(one));
  const said = intent.gender || c.gender || '';
  const gender = /\bwom[ae]n|\bladies|\bfemale/i.test(said) ? 'women' : /\bm[ae]n\b|\bmens\b|\bmale\b/i.test(said) ? 'men' : null;
  const concepts = listOf(c.alternatives);
  const prices = products.map((p) => p && p.price).filter((n) => typeof n === 'number' && Number.isFinite(n));
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const sorted = prices.slice().sort((a, b) => a - b);
  const medianPrice = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  return {
    colours,
    otherColours: (COLOUR_WORDS || []).filter((one) => !colours.includes(one) && !colours.some((c2) => one.includes(c2) || c2.includes(one))),
    gender,
    brands: listOf(intent.brands),
    concepts,
    anchor: c.anchor || null,
    /* a garment the shopper named as what they want is itself the
       strongest evidence; one they compared against is only a concept */
    anchorIsTarget: (c.mode === 'described' || c.mode === 'plain') && Boolean(c.anchor),
    avoid: listOf(c.avoid),
    signals: listOf(c.signals),
    without: listOf(c.without),
    context: listOf(c.context),
    properties: listOf(c.properties),
    occasion: typeof c.occasion === 'string' ? c.occasion : null,
    style: typeof c.style === 'string' ? c.style : null,
    terms: listOf(c.terms),
    ambiguous: listOf(c.ambiguous),
    affordable: listOf(c.signals).includes('affordable'),
    minPrice,
    medianPrice,
    priceSpan: maxPrice - minPrice
  };
}

/* `products` in order of how plainly each is what a descriptive request
   most likely means, or exactly as given for any other request. Returns
   the same product objects; `applied` says whether a sort ran. */
function rankByIntent(products, intent) {
  const list = Array.isArray(products) ? products : [];
  const i = intent && typeof intent === 'object' ? intent : {};
  if (!i.concepts || typeof i.concepts !== 'object' || list.length < 2) return { products: list, applied: false };
  let prepared;
  try {
    prepared = prepare(i, list);
  } catch (err) {
    return { products: list, applied: false };
  }
  const scored = list.map((product, at) => {
    let score = 0;
    try { score = scoreOf(product, i, prepared); } catch (err) { score = 0; }
    return { product, at, score };
  });
  /* stable: equal scores keep the provider's order */
  scored.sort((a, b) => (b.score - a.score) || (a.at - b.at));
  return { products: scored.map((one) => one.product), applied: true };
}

/* The order in which a source's capped offer lookups should be spent on
   search records, for a descriptive request: the records whose own
   titles most plainly are what it means, first. Same records, same
   number of lookups, same ceiling — only which ones are bought first.
   Any other request: exactly the order given. */
function lookupOrder(records, intent) {
  const list = Array.isArray(records) ? records : [];
  const as = list.map((record) => ({ name: record && record.title, brand: record && record.brand }));
  const ranked = rankByIntent(as, intent);
  if (!ranked.applied) return list;
  /* and a record the garment filter would remove once it had a link — a
     hoodie for "oversized shirt", a coat for "not a coat" — is looked up
     last: a lookup spent on it is a product that could never be shown */
  let removable = new Set();
  try {
    removable = new Set(require('./garment-filter').withoutContradictions(as, intent).removed.map((one) => as[one.position - 1]));
  } catch (err) { /* no filter, no reordering for it */ }
  const order = ranked.products.filter((one) => !removable.has(one)).concat(ranked.products.filter((one) => removable.has(one)));
  return order.map((one) => list[as.indexOf(one)]);
}

/* one product's score, for a test or a probe; 0 for a request without concepts */
const scoreOne = (product, intent) => (intent && intent.concepts && typeof intent.concepts === 'object' ? scoreOf(product, intent, prepare(intent, [product])) : 0);

module.exports = { rankByIntent, lookupOrder, scoreOf: scoreOne, CONCEPT_TITLES, SIGNAL_TITLES };
