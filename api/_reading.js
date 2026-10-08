/* =========================================================
   Fynd — what a model read, held to what the shopper said

   A model reads messy language far better than any table: "the shoes
   nurses wear", "pants with pockets on the sides", "a top that shows
   the shoulders". It also, now and then, adds what nobody said — a
   colour, a brand, a budget, "women's" — or files the thing worn
   alongside as the thing wanted. This file is where the two meet.

   The model answers with its usual flat fields and one more object,
   `reading`, that gives negative and relational meaning somewhere to
   live:

     want          the garment wanted, in shop words
     alternatives  up to three shop names for what it most likely is
     comparedTo    what it was compared to ("hoodie but nicer")
     wornWith      what it is worn with, over or under
     avoid         what was ruled out ("not a coat", "aren't skinny")
     fit, material, style, occasion

   Nothing the model says is taken on trust. Every claim is checked
   against the shopper's own words (normalized: contractions opened,
   clear misspellings mended — assets/interpret.js, normalize):

     colours, brands, gender, season   kept only if the words say so
     a budget                          kept only if the number was typed,
                                       and a budget spelled out in the
                                       request always wins
     fits, styles, occasions           dropped when the request rules
                                       them out ("not fancy" is never
                                       "formal")
     keywords                          only the shopper's own words
     want / alternatives               a garment a shop would title
                                       something with, never one the
                                       request rules out or names only
                                       as what it is worn with
     wornWith                          only garments the shopper named
     avoid                             only what the request rules out

   and then reconciled with the page's own deterministic reading
   (readConcepts). Where the tables recognised the request, they stand
   — they are exact, repeatable and cannot invent — and the model only
   adds what they missed: an exclusion, a garment named as the setting.
   Where the tables found no garment at all, the model's checked reading
   becomes the concepts, in the same shape, so the query builder, the
   garment filter and the ranking treat it exactly as they treat theirs.
   A request that named its garment in shop words ("black oversized
   hoodie under $80") gets no concepts and is answered as it always was.
   ========================================================= */

'use strict';

function reader() {
  require('../assets/interpret.js');
  return globalThis.Interpreter;
}

/* ---------- the reading, held to its shape ---------- */

const READING_TEXT = ['want', 'comparedTo', 'occasion'];
const READING_LISTS = { alternatives: 3, wornWith: 3, avoid: 8, fit: 3, material: 3, style: 2 };
const MAX_CHARS = 40;

const clean = (value) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z0-9$&' -]+/g, ' ').replace(/\s+/g, ' ').trim() : '');
const short = (value) => { const one = clean(value); return one && one.length <= MAX_CHARS ? one : ''; };

function shapeReading(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const field of READING_TEXT) out[field] = short(raw[field]) || null;
  for (const [field, most] of Object.entries(READING_LISTS)) {
    const list = typeof raw[field] === 'string' ? [raw[field]] : Array.isArray(raw[field]) ? raw[field] : [];
    const seen = [];
    for (const value of list) {
      const one = short(value);
      if (one && !seen.includes(one)) seen.push(one);
      if (seen.length >= most) break;
    }
    out[field] = seen;
  }
  const empty = !out.want && !out.comparedTo && !out.occasion && Object.keys(READING_LISTS).every((f) => !out[f].length);
  return empty ? null : out;
}

/* ---------- the shopper's own words ---------- */

const stem = (word) => {
  if (word.length > 4 && /(sses|shes|ches|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && /s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
};
const wordsOf = (value) => String(value || '').toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean);

/* words that say how, not what: never evidence of anything */
const GENERIC = new Set('style styles look looking type kind sort vibe vibes piece pieces item items thing things clothing clothes outfit outfits wear wearing worn one ones something anything stuff shop'.split(' '));

/* what rules out, and what carries a ruling-out on to the next word */
const NEGATORS = new Set(['not', 'no', 'without', 'never', 'nothing', 'except', 'minus', 'avoid', 'hate', 'hates', 'nor', 'neither', 'skip']);
const NEGATOR_PAIRS = [['other', 'than'], ['anything', 'but'], ['instead', 'of'], ['rather', 'than']];
const PASS = new Set('too so very super really overly crazy insanely that a an the any all quite kinda sorta like want wanna to be being look looking it its my your much way actually even exactly'.split(' '));
const BOUNDARY = new Set(['but', 'and', 'though', 'although', 'yet', 'so', 'because', 'cause', 'just', 'still', 'with', 'for', 'that', 'which', 'i', 'im', 'its']);
const SCOPE = 4;

/* what something is worn with, over or under */
const RELATIONS = new Set(['with', 'over', 'under', 'underneath', 'beneath', 'alongside', 'match', 'matches', 'matching', 'pair', 'pairs', 'goes']);
const RELATION_SKIP = new Set('a an the my your his her their some those these one of to go goes wear with nice regular normal plain basic old new favorite favourite fav dark light black white blue grey gray navy denim'.split(' '));

function evidence(query) {
  const I = reader();
  const raw = String(query || '').toLowerCase();
  /* Split where the shopper paused — a comma, a full stop, a question —
     but never inside a number ("$1,200", "$49.99"), then mend each piece
     (contractions, clear misspellings). A comma ends a ruling-out:
     "not black, under $80" rules out black, not the budget. */
  const tokens = [];
  for (const piece of raw.split(/(,(?!\d)|;|!|\?|\.(?!\d))/)) {
    if (/^[,;!?.]$/.test(piece)) { tokens.push(','); continue; }
    const normal = I.normalize(piece).text.toLowerCase();
    tokens.push(...normal.split(/\s+/).map((t) => t.replace(/[^a-z0-9$-]+/g, '')).filter(Boolean));
  }
  const words = tokens.filter((t) => t !== ',');
  const stems = new Set(words.map(stem));
  /* amounts as typed, read from the words before they were mended */
  const typed = (raw.match(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/,/g, '')));
  const negated = new Set();
  const related = new Set();
  for (let at = 0; at < tokens.length; at += 1) {
    const here = tokens[at];
    const pair = NEGATOR_PAIRS.some(([a, b]) => here === a && tokens[at + 1] === b);
    if (NEGATORS.has(here) || pair) {
      let taken = 0;
      for (let next = at + (pair ? 2 : 1); next < tokens.length && taken < SCOPE; next += 1) {
        const word = tokens[next];
        if (word === ',' || (BOUNDARY.has(word) && taken > 0)) break;
        if (word === 'or' || PASS.has(word)) continue;
        negated.add(stem(word));
        taken += 1;
      }
    }
    if (RELATIONS.has(here)) {
      let taken = 0;
      for (let next = at + 1; next < tokens.length && taken < 3; next += 1) {
        const word = tokens[next];
        if (word === ',' || NEGATORS.has(word)) break;
        if (RELATION_SKIP.has(word)) continue;
        related.add(stem(word));
        taken += 1;
      }
    }
  }
  return { text: words.join(' '), words, stems, negated, related, typed };
}

/* every content word of a term was said */
const said = (term, ev) => {
  const own = wordsOf(term).filter((w) => !GENERIC.has(w));
  return own.length > 0 && own.every((w) => ev.stems.has(stem(w)));
};
/* any word of a term was ruled out */
const ruledOut = (term, ev) => wordsOf(term).some((w) => ev.negated.has(stem(w)));

/* ---------- garments, as shops name them ----------

   What counts as a garment when a model names one: the page's own
   lexicon and concept tables, and the everyday garment nouns they do
   not happen to carry. This decides only whether a model's answer is a
   garment at all — "clogs" for "the shoes nurses wear" is, "vibe" is
   not. Nothing here is ever added to a search. */
const GARMENT_NOUNS = ('clog clogs mule mules shacket overshirt fleece gilet vest anorak windbreaker jumpsuit romper overalls ' +
  'dungarees skort jorts culottes kimono poncho cape tunic bodysuit corset tank henley turtleneck crewneck flannel raincoat ' +
  'balaclava espadrilles oxfords derbies moccasins slippers backpack gloves socks tights bra lingerie swimsuit bikini suit ' +
  'zip pullover tee jersey cardigan joggers trackpants sweatpants shirt top blouse camisole cami bralette sneakers trainers ' +
  'shoes boots flats pumps heels sandals slides loafers tote clutch purse wallet belt beanie cap hat scarf jacket coat dress ' +
  'skirt shorts jeans pants trousers chinos leggings hoodie sweatshirt sweater jumper polo blazer bomber puffer parka trench').split(' ');

let NOUNS = null;
const TWO = new Map();
function garmentNouns() {
  if (NOUNS) return NOUNS;
  const { lexicon } = reader();
  NOUNS = new Map();
  const add = (word, canonical) => { const s = stem(word); if (s && !NOUNS.has(s)) NOUNS.set(s, canonical); };
  const named = (lexicon.GARMENTS || []).concat(lexicon.EXTRA_ANCHORS || []);
  /* single words first — a garment's own name, then its one-word aliases
     ("pants" is trousers) — so a longer alias ending in the same word
     ("sweat pants", "tank top") never claims it */
  for (const [canonical] of named) if (wordsOf(canonical).length === 1) add(canonical, canonical);
  for (const [canonical, aliases] of named) for (const alias of aliases || []) if (wordsOf(alias).length === 1) add(alias, canonical);
  for (const [canonical, aliases] of named) {
    add(wordsOf(canonical).slice(-1)[0], canonical);
    for (const alias of aliases || []) add(wordsOf(alias).slice(-1)[0], canonical);
  }
  for (const term of lexicon.CONCEPT_TERMS || []) { const w = wordsOf(term); add(w[w.length - 1], w[w.length - 1]); }
  for (const noun of GARMENT_NOUNS) add(noun, noun);
  /* and two-word names whole, read before their last word: "t shirt"
     is a t-shirt, "tank top" a tank top */
  for (const [canonical, aliases] of named) {
    for (const alias of [canonical].concat(aliases || [])) {
      const w = wordsOf(alias);
      if (w.length >= 2) TWO.set(`${stem(w[w.length - 2])} ${stem(w[w.length - 1])}`, canonical);
    }
  }
  return NOUNS;
}

/* every way the request could have named a garment: "pants" for trousers */
const aliasStems = (canonical) => {
  const nouns = garmentNouns();
  const out = [...nouns.entries()].filter(([, c]) => c === canonical).map(([s]) => s);
  return out.length ? out : wordsOf(canonical).slice(-1).map(stem);
};
const garmentRuledOut = (canonical, ev) => aliasStems(canonical).some((s) => ev.negated.has(s));

/* the garment a term names, read from its last word: "wide leg trousers"
   is trousers, "quarter zip" is a quarter zip, "vibe" is nothing */
function garmentOf(term) {
  const w = wordsOf(term);
  if (!w.length) return null;
  const nouns = garmentNouns();
  if (w.length > 1) {
    const two = `${stem(w[w.length - 2])} ${stem(w[w.length - 1])}`;
    if (TWO.has(two)) return TWO.get(two);
  }
  const last = stem(w[w.length - 1]);
  return nouns.has(last) ? nouns.get(last) : null;
}

/* a garment named only as what it is worn with: whichever name the
   request used for it is in a relation's scope, and nowhere else */
const onlyAsSetting = (garment, ev) => {
  const named = aliasStems(garment).filter((s) => ev.stems.has(s));
  if (!named.length) return false;
  const count = (s) => ev.words.filter((x) => stem(x) === s).length;
  return named.every((s) => ev.related.has(s) && count(s) <= 1);
};

/* Words that point at a garment without naming one: a part of it ("the
   zip at the neck", "long sleeve"), a group whose clothes are a style of
   their own ("what skaters wear"), or a layer ("over shirts"). With one
   of these the model may say which garment is meant. Without any — "for
   dinner", "something cute" — it may not: an occasion or a mood is not a
   garment, and naming one ("a dress", "heels") would be inventing it. */
const GARMENT_CUES = new Set(('sleeve sleeves sleeveless collar collared neck neckline turtleneck zip zipper zipped hood hooded ' +
  'pocket pockets leg legs feet foot toe toes heel waist waistband shoulder shoulders arm arms button buttons lapel cuff ' +
  'cuffs hem strap straps strapless backless head ears hands wrist ankle ankles knee knees thigh ' +
  'skater skaters skate goth goths punk punks preppy hiker hikers runner runners nurse nurses chef chefs cowboy cowboys ' +
  'golfer golfers cyclist cyclists surfer surfers rapper rappers lumberjack lumberjacks gamer gamers ' +
  'over under underneath layer layering').split(' '));
const pointsAtGarment = (ev) => ev.words.some((w) => GARMENT_CUES.has(w)) || [...garmentNouns().keys()].some((n) => ev.stems.has(n));

/* ---------- the flat fields ---------- */

const COLOUR_EVIDENCE = {
  black: ['black', 'jet', 'onyx'],
  white: ['white', 'ivory', 'off'],
  neutral: ['grey', 'gray', 'charcoal', 'beige', 'cream', 'ivory', 'tan', 'khaki', 'oatmeal', 'ecru', 'stone', 'taupe', 'heather', 'neutral', 'nude', 'sand', 'camel', 'off', 'silver'],
  earth: ['brown', 'chocolate', 'camel', 'rust', 'olive', 'khaki', 'tan', 'earth', 'earthy', 'mocha', 'coffee', 'terracotta', 'mustard', 'burgundy', 'maroon'],
  green: ['green', 'sage', 'olive', 'forest', 'emerald', 'mint', 'khaki'],
  blue: ['blue', 'navy', 'cobalt', 'teal', 'turquoise', 'sky', 'indigo', 'denim'],
  pastel: ['pastel', 'lilac', 'lavender', 'mint', 'blush', 'peach', 'baby', 'pale', 'light'],
  bright: ['bright', 'red', 'pink', 'yellow', 'orange', 'purple', 'neon', 'fuchsia', 'magenta', 'coral', 'hot', 'gold'],
  red: ['red', 'burgundy', 'maroon', 'crimson', 'scarlet', 'wine'],
  pink: ['pink', 'blush', 'rose', 'fuchsia', 'magenta']
};
const FIT_EVIDENCE = {
  relaxed: ['loose', 'looser', 'relaxed', 'baggy', 'roomy', 'slouchy', 'wide', 'flowy', 'boxy'],
  oversized: ['oversized', 'oversize', 'huge', 'big', 'boxy', 'baggy', 'massive'],
  slim: ['slim', 'fitted', 'skinny', 'tight', 'form', 'bodycon', 'tailored'],
  regular: ['regular', 'normal', 'classic', 'straight', 'standard'],
  cropped: ['cropped', 'crop', 'short']
};
const STYLE_EVIDENCE = {
  formal: ['formal', 'fancy', 'dressy', 'dressed', 'elegant', 'black-tie', 'gala', 'smart'],
  casual: ['casual', 'everyday', 'chill', 'laid', 'lowkey', 'relaxed', 'easy'],
  minimal: ['minimal', 'minimalist', 'simple', 'plain', 'basic', 'clean', 'understated', 'subtle', 'logo'],
  vintage: ['vintage', 'retro', 'old', 'thrifted', 'throwback', '70s', '80s', '90s'],
  streetwear: ['streetwear', 'street', 'skater', 'skaters', 'skate', 'hype', 'urban'],
  sporty: ['sporty', 'athletic', 'gym', 'workout', 'running', 'sport', 'active'],
  classic: ['classic', 'timeless', 'traditional', 'preppy'],
  preppy: ['preppy', 'prep', 'collegiate'],
  edgy: ['edgy', 'punk', 'grunge', 'goth', 'rock'],
  romantic: ['romantic', 'feminine', 'floral', 'flowy', 'cute'],
  bohemian: ['boho', 'bohemian', 'hippie', 'festival'],
  elevated: ['nice', 'nicer', 'elevated', 'polished', 'expensive', 'luxe', 'premium', 'classy', 'sharp'],
  bold: ['bold', 'loud', 'bright', 'statement', 'colorful', 'colourful', 'flashy', 'vibrant']
};
/* what a request has to say for the model to file it under an occasion */
const OCCASION_EVIDENCE = {
  everyday: ['everyday', 'daily', 'school', 'errands', 'weekend', 'casual', 'campus'],
  weekend: ['weekend', 'weekends', 'saturday', 'sunday', 'brunch', 'errands'],
  active: ['gym', 'workout', 'running', 'run', 'hiking', 'hike', 'yoga', 'sport', 'sports', 'active', 'athletic', 'training', 'exercise'],
  work: ['work', 'office', 'job', 'interview', 'business', 'meeting', 'professional'],
  office: ['work', 'office', 'job', 'interview', 'business', 'meeting', 'professional'],
  evening: ['evening', 'dinner', 'night', 'date', 'going', 'party', 'club', 'drinks', 'clubbing'],
  'going out': ['going', 'night', 'party', 'club', 'clubbing', 'drinks'],
  'date night': ['date', 'dinner'],
  dinner: ['dinner', 'restaurant'],
  party: ['party', 'parties', 'celebration'],
  wedding: ['wedding', 'weddings', 'bridesmaid'],
  'wedding guest': ['wedding', 'weddings'],
  vacation: ['vacation', 'beach', 'holiday', 'travel', 'trip', 'resort', 'cruise'],
  beach: ['beach', 'pool', 'swim'],
  travel: ['travel', 'flight', 'flights', 'trip', 'airport'],
  workout: ['gym', 'workout', 'running', 'run', 'hiking', 'yoga', 'training', 'exercise'],
  sport: ['gym', 'workout', 'running', 'sport', 'sports', 'hiking', 'yoga'],
  lounge: ['lounge', 'lounging', 'home', 'sleep', 'couch', 'relaxing'],
  interview: ['interview'],
  school: ['school', 'class', 'campus', 'college', 'uni'],
  festival: ['festival', 'concert', 'rave']
};
const GENDER_EVIDENCE = {
  women: ['women', 'womens', 'woman', 'ladies', 'lady', 'girl', 'girls', 'female', 'her', 'she', 'mom', 'mum', 'mother', 'wife', 'girlfriend', 'sister', 'daughter', 'grandma'],
  men: ['men', 'mens', 'man', 'guy', 'guys', 'boy', 'boys', 'male', 'him', 'he', 'dad', 'father', 'husband', 'boyfriend', 'brother', 'son', 'grandpa'],
  unisex: ['unisex']
};
const SEASONS = { fall: ['fall', 'autumn'], autumn: ['fall', 'autumn'], winter: ['winter'], summer: ['summer'], spring: ['spring'] };

/* a family of words, some of which were said and none ruled out */
const evidenced = (family, table, ev) => {
  const words = table[String(family || '').toLowerCase()];
  if (!words) return said(family, ev) && !ruledOut(family, ev);
  const hits = words.filter((w) => ev.stems.has(stem(w)));
  return hits.length > 0 && hits.some((w) => !ev.negated.has(stem(w)));
};
/* ruled out by its own words: "not fancy" rules out "formal" */
const ruledOutFamily = (family, table, ev) => {
  const words = table[String(family || '').toLowerCase()] || [family];
  return words.some((w) => ev.negated.has(stem(w)));
};

const brandSaid = (brand, ev) => {
  const want = String(brand || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!want) return false;
  const text = ev.text.replace(/[^a-z0-9]+/g, '');
  if (text.includes(want)) return true;
  if (want.length < 5) return false;
  /* one slip in a long brand name: "uniqlo" typed "uniqo" */
  return ev.words.some((w) => w.length >= want.length - 1 && w.length <= want.length + 1 && oneEdit(w, want));
};
function oneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/* every amount the request states, in digits or in words: "eighty
   bucks", "a hundred and fifty", "$1,200" */
const UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function amountsSaid(ev) {
  const found = new Set(ev.typed);
  let current = null;
  const close = () => { if (current !== null) found.add(current); current = null; };
  for (const word of ev.words) {
    if (word in UNITS) current = (current || 0) + UNITS[word];
    else if (word in TENS) current = (current || 0) + TENS[word];
    else if (word === 'hundred') current = (current || 1) * 100;
    else if (word === 'thousand') current = (current || 1) * 1000;
    else if (word === 'and' && current !== null) continue;
    else if (word === 'a') continue;
    else close();
  }
  close();
  return found;
}
const numberSaid = (n, ev) => n !== null && n !== undefined && amountsSaid(ev).has(n);

/* the categories a request's garments are filed under, by the page's
   own lexicon: a category the request gives no garment for is not kept */
function categoriesSaid(ev) {
  const { lexicon } = reader();
  const out = new Set();
  for (const [canonical, aliases, categories] of lexicon.GARMENTS) {
    const names = [canonical].concat(aliases);
    /* a garment named only as what it is worn with is not filed for */
    if (onlyAsSetting(canonical, ev)) continue;
    if (names.some((name) => said(name, ev) && !ruledOut(name, ev))) (categories || []).forEach((c) => out.add(String(c).toLowerCase()));
  }
  return out;
}

/* ---------- reconcile ---------- */

const keep = (list, test, rejected, why) => list.filter((value) => {
  const ok = test(value);
  if (!ok) rejected.push(`${why}: ${value}`);
  return ok;
});

const FEATURES = new Set(['hood', 'hoods', 'logo', 'logos', 'graphic', 'graphics', 'print', 'prints', 'pattern', 'button', 'buttons', 'pocket', 'pockets', 'collar', 'zip', 'zipper', 'stripe', 'stripes', 'ruffle', 'ruffles', 'sequin', 'sequins', 'lace']);
const SHOP_STYLES = new Set(['vintage', 'minimal', 'casual', 'dressy', 'preppy', 'streetwear', 'skate', 'y2k', 'grunge', 'boho', 'athleisure', 'workwear', 'western', 'classic', 'sporty', 'techwear', 'gorpcore', 'cozy', 'elevated', 'retro', 'utility', 'smart casual']);
const OCCASIONS = new Set(['going out', 'date night', 'wedding guest', 'office', 'workout', 'vacation', 'dinner', 'party', 'interview', 'school', 'travel', 'beach', 'work', 'wedding', 'date', 'brunch', 'festival', 'hiking', 'lounging']);

/* a garment the request rules out, as listings name it */
const FAMILY_OUT = {
  coat: ['coat', 'overcoat', 'topcoat', 'peacoat', 'parka', 'trench', 'puffer'],
  jacket: ['jacket', 'blazer', 'bomber', 'windbreaker'],
  jeans: ['jean', 'jeans', 'denim'],
  hoodie: ['hoodie', 'hoody', 'hooded'],
  dress: ['dress', 'gown'],
  sneakers: ['sneaker', 'trainer'],
  boots: ['boot', 'booties']
};

/* The model's whole answer, checked and merged. `flat` is the shaped
   preferences (categories, colors, fits, ...), `raw` the model's
   `reading`, `table` the deterministic reading of the same words
   (garmentsWanted). Returns the preferences to answer with, and an
   account of what was kept and refused, for the benchmark. */
function reconcile(query, flat, rawReading, table) {
  const ev = evidence(query);
  const rejected = [];
  const out = Object.assign({}, flat);

  /* the flat fields: only what the words say */
  out.colors = keep(flat.colors || [], (c) => evidenced(c, COLOUR_EVIDENCE, ev), rejected, 'colour not said');
  out.brands = keep(flat.brands || [], (b) => brandSaid(b, ev) && !ruledOut(b, ev), rejected, 'brand not said');
  out.gender = flat.gender && evidenced(flat.gender, GENDER_EVIDENCE, ev) ? flat.gender : null;
  if (flat.gender && !out.gender) rejected.push(`gender not said: ${flat.gender}`);
  const season = flat.season ? String(flat.season).toLowerCase() : null;
  out.season = season && (SEASONS[season] || [season]).some((w) => ev.stems.has(stem(w))) ? flat.season : null;
  if (flat.season && !out.season) rejected.push(`season not said: ${flat.season}`);
  out.maxPrice = numberSaid(flat.maxPrice, ev) ? flat.maxPrice : null;
  out.minPrice = numberSaid(flat.minPrice, ev) ? flat.minPrice : null;
  if (flat.maxPrice !== null && flat.maxPrice !== undefined && out.maxPrice === null) rejected.push(`budget not said: ${flat.maxPrice}`);
  if (flat.minPrice !== null && flat.minPrice !== undefined && out.minPrice === null) rejected.push(`budget not said: ${flat.minPrice}`);
  out.fits = keep(flat.fits || [], (f) => evidenced(f, FIT_EVIDENCE, ev) && !ruledOutFamily(f, FIT_EVIDENCE, ev), rejected, 'fit not said or ruled out');
  out.styles = keep(flat.styles || [], (s) => evidenced(s, STYLE_EVIDENCE, ev) && !ruledOutFamily(s, STYLE_EVIDENCE, ev), rejected, 'style not said or ruled out');
  out.occasions = keep(flat.occasions || [], (o) => evidenced(o, OCCASION_EVIDENCE, ev) && !ruledOut(o, ev), rejected, 'occasion not said or ruled out');
  /* The catalogue's filing reaches the search only when the request names
     no garment (query.js); with one named, the model's filing of it
     stands as it always did. Without one, a filing is kept only for a
     garment the words gave — never "dress" for "something nice for
     dinner", never the jeans something is worn with. */
  const named = (table.garments || []).length > 0;
  const filed = named ? null : categoriesSaid(ev);
  out.categories = named ? (flat.categories || []) : keep(flat.categories || [], (c) => filed.has(String(c).toLowerCase()) || (said(c, ev) && !ruledOut(c, ev)), rejected, 'category not said');
  out.keywords = keep(flat.keywords || [], (k) => said(k, ev) && !ruledOut(k, ev), rejected, 'keyword not said or ruled out');

  /* the table's garments always: they are the shopper's own words */
  out.garments = table.garments || [];
  out.descriptors = table.descriptors || [];

  const reading = shapeReading(rawReading);
  const model = reading ? checkReading(reading, ev, rejected) : null;
  /* A request that named its garment in shop words and that the tables
     read without concepts is an exact search: it is answered exactly as
     it always was, whatever the model added. */
  const exact = !table.concepts && (table.garments || []).length > 0;
  const concepts = exact ? null : mergeConcepts(table.concepts || null, model, ev, out);
  if (model && model.rejectedGarments) rejected.push(`a garment the words do not point at: ${model.rejectedGarments.join(', ')}`);
  if (concepts) out.concepts = concepts;
  else delete out.concepts;
  if (concepts && concepts.fromModel && concepts.anchor && !out.garments.length) out.garments = [concepts.anchor];
  /* whose reading is searched: the model's, the tables' with the model's
     additions, the tables' alone, or none — an exact request */
  const by = !concepts ? 'exact' : concepts.fromModel ? 'model' : model && model.used ? 'reader+model' : 'reader';
  if (concepts) delete concepts.fromModel;

  return { preferences: out, understood: { by, rejected } };
}

/* each part of the model's reading, held to the words */
function checkReading(reading, ev, rejected) {
  const garmentTerm = (raw) => {
    if (!raw) return false;
    /* "skinny pants" for "pants that aren't skinny": what was ruled out
       comes off the term, and what is left is judged */
    const kept = wordsOf(raw).filter((w) => !ev.negated.has(stem(w)));
    const term = kept.join(' ');
    if (term !== raw) rejected.push(`ruled-out word taken off: ${raw} -> ${term || '(nothing)'}`);
    if (!term) return false;
    const garment = garmentOf(term);
    if (!garment) { rejected.push(`not a garment: ${term}`); return false; }
    if (garmentRuledOut(garment, ev)) { rejected.push(`ruled out, not wanted: ${term}`); return false; }
    if (onlyAsSetting(garment, ev)) { rejected.push(`worn with, not wanted: ${term}`); return false; }
    return term;
  };
  const want = reading.want ? garmentTerm(reading.want) || null : null;
  const alternatives = unique(reading.alternatives.map(garmentTerm).filter(Boolean));
  const comparedTo = reading.comparedTo && said(reading.comparedTo, ev) ? reading.comparedTo : null;
  if (reading.comparedTo && !comparedTo) rejected.push(`compared to something not said: ${reading.comparedTo}`);
  const wornWith = keep(reading.wornWith, (w) => said(w, ev) && garmentOf(w), rejected, 'worn with something not said');
  const avoid = keep(reading.avoid, (a) => ruledOut(a, ev) || (garmentOf(a) && garmentRuledOut(garmentOf(a), ev)), rejected, 'ruled out without a negation');
  const fit = keep(reading.fit, (f) => (evidenced(f, FIT_EVIDENCE, ev) || said(f, ev)) && !ruledOutFamily(f, FIT_EVIDENCE, ev), rejected, 'fit not said or ruled out');
  const material = keep(reading.material, (m) => said(m, ev) && !ruledOut(m, ev), rejected, 'material not said');
  const style = keep(reading.style, (s) => SHOP_STYLES.has(s) && (evidenced(s, STYLE_EVIDENCE, ev) || said(s, ev) || !STYLE_EVIDENCE[s]) && !ruledOutFamily(s, STYLE_EVIDENCE, ev), rejected, 'style not a shop word, not said or ruled out');
  const occasion = reading.occasion && OCCASIONS.has(reading.occasion) && evidenced(reading.occasion, OCCASION_EVIDENCE, ev) && !ruledOut(reading.occasion, ev) ? reading.occasion : null;
  if (reading.occasion && !occasion) rejected.push(`occasion not said: ${reading.occasion}`);
  return { want, alternatives, comparedTo, wornWith, avoid, fit, material, style, occasion };
}

const unique = (list) => [...new Set(list.filter(Boolean))];
const conceptWords = (term) => wordsOf(term).map(stem);

/* what the model read, put into the concepts the rest of the search
   already understands */
function mergeConcepts(table, model, ev, prefs) {
  /* An "open" reading named no garment: it is the tables' broad guess
     from a mood alone ("warm" -> sweater, fleece, overshirt). When the
     words point at a garment and the model named one — "something to
     keep my neck warm" is a scarf — the model's checked reading is the
     sharper one, and the tables' exclusions and colours stay with it. */
  const modelNames = model && (model.want || model.alternatives.length) && pointsAtGarment(ev);
  const tableKnows = table && (table.mode !== 'plain' || table.anchor || (table.search || []).length)
    && !(table.mode === 'open' && modelNames);

  /* exclusions the model found that the table did not: as words a
     listing would carry, so the filter and the ranking can act on them */
  const extraOut = { excluded: [], without: [], drop: [] };
  if (model) {
    for (const item of model.avoid) {
      const garment = garmentOf(item);
      const words = wordsOf(item).filter((w) => !GENERIC.has(w));
      if (garment && !FEATURES.has(stem(words[words.length - 1] || ''))) {
        const family = FAMILY_OUT[garment] || [garment];
        extraOut.excluded.push(garment);
        extraOut.without.push(...family);
        extraOut.drop.push(...family);
      } else {
        extraOut.without.push(...words);
      }
    }
  }

  /* a setting the model saw that the table took as the thing: "a jacket
     to wear over my hoodie" when the table kept "hoodie" */
  const settings = model ? model.wornWith.map((w) => garmentOf(w)).filter((g) => g && onlyAsSetting(g, ev)) : [];

  /* "a cardigan but more structured": the table knew the garment but not
     what the comparison asks for, and read it plainly. The model's
     alternatives say what it does ask for — kinds of it, or what it is
     compared into — so they are searched, and the garment filter
     measures listings against them too. Only when the model read the
     same garment as the one compared to. */
  const comparedHere = model && table && table.mode === 'plain' && table.anchor && model.comparedTo
    && garmentOf(model.comparedTo) === table.anchor && model.alternatives.length;
  /* "a sweater with the zip at the neck": the table knew the garment and
     read the rest plainly; a kind of that same garment the words point
     at — "quarter zip sweater", sharing "zip" — is the sharper search.
     A kind the words do not point at ("midi dress" for "a dress that
     isn't black") narrows the search on the model's say-so, and is not
     taken. */
  const sharper = model && table && table.mode === 'plain' && table.anchor && !comparedHere
    ? model.alternatives.concat(model.want ? [model.want] : []).filter((term) => garmentOf(term) === table.anchor
      && wordsOf(term).some((w) => !garmentNouns().has(stem(w)) && !GENERIC.has(w) && ev.stems.has(stem(w))))
    : [];
  if (comparedHere || sharper.length) {
    const kinds = comparedHere ? unique(model.alternatives.concat(model.want ? [model.want] : [])).slice(0, 4) : unique(sharper).slice(0, 3);
    model.used = true;
    return Object.assign({}, table, {
      mode: comparedHere ? 'comparative' : 'described',
      alternatives: unique(kinds.concat([table.anchor])).slice(0, 6),
      search: kinds.slice(0, 3),
      fit: unique((table.fit || []).concat(model.fit)).slice(0, 3),
      style: table.style || model.style[0] || null,
      excluded: unique(table.excluded.concat(extraOut.excluded)),
      without: unique(table.without.concat(extraOut.without)),
      drop: unique(table.drop.concat(extraOut.drop)),
      context: unique(table.context.concat(settings)),
      fromModel: false
    });
  }

  if (tableKnows) {
    const merged = Object.assign({}, table);
    merged.excluded = unique(table.excluded.concat(extraOut.excluded));
    merged.without = unique(table.without.concat(extraOut.without));
    merged.drop = unique(table.drop.concat(extraOut.drop));
    merged.context = unique(table.context.concat(settings));
    if (settings.length) {
      merged.beside = unique(table.beside.concat(settings.flatMap(conceptWords)));
      /* the setting is not the thing searched for */
      merged.search = table.search.filter((t) => !settings.includes(garmentOf(t)));
      merged.alternatives = table.alternatives.filter((t) => !settings.includes(garmentOf(t)));
      if (settings.includes(table.anchor)) merged.anchor = null;
      prefs.garments = prefs.garments.filter((g) => !settings.includes(g));
    }
    merged.fromModel = false;
    if (model) model.used = Boolean(extraOut.without.length || settings.length);
    return merged;
  }

  /* the tables found nothing to search for: the model's checked reading
     is the reading, if it has one — and names a garment only when the
     words point at one */
  const wanted = model && pointsAtGarment(ev) ? unique([model.want].concat(model.alternatives)) : [];
  if (model && !pointsAtGarment(ev) && (model.want || model.alternatives.length)) {
    model.rejectedGarments = unique([model.want].concat(model.alternatives));
  }
  if (!model || !wanted.length) {
    if (!table) return null;
    if (!extraOut.without.length) return table;
    return Object.assign({}, table, {
      excluded: unique(table.excluded.concat(extraOut.excluded)),
      without: unique(table.without.concat(extraOut.without)),
      drop: unique(table.drop.concat(extraOut.drop))
    });
  }
  model.used = true;
  const anchor = model.want ? garmentOf(model.want) : null;
  const base = table || {
    mode: 'described', anchor: null, alternatives: [], search: [], signals: [], fit: [], style: null, context: [], relations: [],
    beside: [], avoid: [], colors: [], extra: [], excluded: [], without: [], drop: [], properties: [], occasion: null, gender: null,
    ambiguous: [], terms: []
  };
  return {
    mode: model.wornWith.length && !model.want ? 'context' : model.comparedTo ? 'comparative' : 'described',
    anchor,
    alternatives: wanted.slice(0, 4),
    /* the strongest few, never a list of synonyms */
    search: wanted.slice(0, 3),
    signals: base.signals || [],
    fit: unique((base.fit || []).concat(model.fit)).slice(0, 3),
    style: model.style[0] || base.style || null,
    context: unique((base.context || []).concat(model.wornWith.map((w) => garmentOf(w)))),
    relations: base.relations || [],
    beside: unique((base.beside || []).concat(model.wornWith.flatMap(conceptWords))),
    avoid: base.avoid || [],
    colors: base.colors || [],
    extra: [],
    excluded: unique((base.excluded || []).concat(extraOut.excluded)),
    without: unique((base.without || []).concat(extraOut.without)),
    drop: unique((base.drop || []).concat(extraOut.drop)),
    properties: unique((base.properties || []).concat(model.material)).slice(0, 4),
    occasion: model.occasion || base.occasion || null,
    gender: base.gender || prefs.gender || null,
    ambiguous: [],
    terms: [],
    fromModel: true
  };
}

module.exports = { shapeReading, reconcile, evidence, garmentOf, checkReading };
