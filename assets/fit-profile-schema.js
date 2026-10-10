/* =========================================================
   Fynd — the Shopper Fit Profile: its shape, and what it may hold

   The foundation brand-specific size recommendations will be built on.
   Every part of it is optional:

     measurements     height and chest for tops; waist and hip kept for
                      bottoms. One unit for all of them, chosen by the
                      shopper: inches or centimetres.
     brandSizes       the size somebody usually buys in a brand, for a
                      category, and how it fits them.
     fitPreferences   fitted, regular, relaxed or oversized — per
                      category, so a hoodie and a sweatshirt can differ.

   From version 3, the fit guide on the home page (assets/guide.js)
   answers per type of clothing — T-shirts, hoodies, sweatshirts, pants,
   sweatpants, jeans, or something else:

     garments         { <type>: { anchor, fitGoal, troubleZones } }, one
                      entry for each type the shopper has answered, keyed
                      by its id in GARMENTS. Nothing answered for one
                      type is ever read as an answer for another: a
                      T-shirt that fits is not a pair of jeans that fits.

       anchor         a piece of that type the shopper owns that fits
                      perfectly: its brand and its size, and for jeans
                      and pants sized by the waist, its length. A
                      reference point, not a measurement — nothing here
                      turns "Levi's 32 × 32" into a waist. That needs the
                      brand's verified size chart, which recommendation
                      code will have to look up before it estimates
                      anything.
       fitGoal        how they like that type to fit: slim, true to size,
                      or relaxed/oversized. Oversized hoodies and
                      regular jeans are two answers, not one.
       troubleZones   where that type usually goes wrong on them, from
                      that type's own list — sleeves for tops, legs and
                      seat for jeans. About garments, not bodies. An
                      empty list means "none of these"; null means the
                      question was not answered.

     Each of the three is null until it is answered, and a type with all
     three unanswered is not kept at all.

   And, kept from version 2, the first guide's three answers, which were
   about "a top", not about any one type:

     anchor, fitGoal, troubleZones   at the top level, exactly as saved.
                      Version 3 never moves them into a type — the shopper
                      never said whether that top was a T-shirt or a
                      hoodie — and the new guide never writes them. The
                      fit profile page shows them, in the words they were
                      asked in, and can clear them.

   One file, loaded by the page and required by api/fit-profile.js, so
   the rules the page checks while somebody types are the rules the
   server enforces. The page's check is a courtesy; the server's is the
   one that decides, and it runs every save through normalise() below.

   ---------------------------------------------------------
   Units are never guessed
   ---------------------------------------------------------
   A measurement is stored exactly as entered, beside the unit the
   shopper said it was in. Nothing here converts on the way in, and a
   value with no unit is refused rather than given a default: "40" is a
   chest in inches or a mistake in centimetres, and only the shopper
   knows which. The ranges below are stated separately for each unit, so
   a value that is only plausible in the other one is refused with a
   message that says so — it is never quietly read as the other unit.

   ---------------------------------------------------------
   Growing without breaking anybody
   ---------------------------------------------------------
   Every stored profile carries `schemaVersion`. upgrade() reads any
   version this file knows and returns the current shape, filling what
   an older profile never had with "not said". A new version adds a step
   to UPGRADES; a new type of clothing is a row in GARMENTS. Neither
   touches a profile already saved: a version 1 or 2 profile reads as
   version 3 with no types answered, and its measurements, usual sizes,
   per-category fits and version 2 answers exactly as they were.

   A save that leaves out a field added after version 1 keeps the stored
   value (api/_fit-profile.js), so a page that predates the field cannot
   erase it. A profile written by a later version than this file knows
   is never read as this one, and never saved over.

   Nothing else is collected. There is no weight, no photograph and no
   free-text note here, and a field this file does not name is dropped
   rather than stored.
   ========================================================= */

(function (global) {
  'use strict';

  const SCHEMA_VERSION = 3;

  const UNITS = ['in', 'cm'];
  const UNIT_NAME = { in: 'inches', cm: 'centimetres' };
  const CM_PER_INCH = 2.54;

  /* What is plausible for an adult, in each unit, stated rather than
     converted so each bound is a round number somebody can read. The
     ranges overlap a little at the edges (a 60 cm chest and a 60 in
     chest are both possible), which is exactly why the unit is asked
     for rather than inferred. */
  const MEASUREMENTS = {
    height: { label: 'Height', tops: true, range: { in: [48, 90], cm: [120, 230] } },
    chest: { label: 'Chest', tops: true, range: { in: [24, 67], cm: [60, 170] } },
    waist: { label: 'Waist', tops: false, range: { in: [20, 67], cm: [50, 170] } },
    hip: { label: 'Hip', tops: false, range: { in: [24, 71], cm: [60, 180] } }
  };
  const MEASUREMENT_KEYS = Object.keys(MEASUREMENTS);

  /* The categories the fit profile page's usual sizes and preferred fit
     cover: tops, hoodies and sweatshirts. The guide's types of clothing
     are GARMENTS below; bringing these two lists together is later work,
     and until then neither is read as the other. */
  const CATEGORIES = [
    { id: 'hoodies', label: 'Hoodies', group: 'tops' },
    { id: 'sweatshirts', label: 'Sweatshirts', group: 'tops' }
  ];
  const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

  const FIT_FEEDBACK = [
    { id: 'too-small', label: 'Too small' },
    { id: 'about-right', label: 'About right' },
    { id: 'too-large', label: 'Too large' }
  ];
  const FIT_FEEDBACK_IDS = FIT_FEEDBACK.map((f) => f.id);

  const FIT_PREFERENCES = [
    { id: 'fitted', label: 'Fitted' },
    { id: 'regular', label: 'Regular' },
    { id: 'relaxed', label: 'Relaxed' },
    { id: 'oversized', label: 'Oversized' }
  ];
  const FIT_PREFERENCE_IDS = FIT_PREFERENCES.map((f) => f.id);

  /* Offered as suggestions. A brand's own label — 38, M Tall, 2XL — is
     accepted as typed. */
  const COMMON_SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL'];

  const LIMITS = { brands: 50, brandLength: 60, sizeLength: 16 };

  /* ---------- the fit guide: types of clothing (version 3) ----------
     `label` is the card; `one` and `many` are the words a question uses
     ("What brand and size of T-shirt…", "How do you like your jeans…").
     Only the id is ever stored, so no stored answer depends on how a
     label is spelled or pluralised.

     `group` picks the trouble spots, the brands offered and the fit
     cards' wording; `sizes` the sizes offered; `lengths` whether a waist
     size can carry a length, as jeans and pants are sold. "Other" is
     something the guide does not cover by name, so it is asked about in
     words that fit any garment. */
  const GARMENTS = [
    { id: 'tshirts', label: 'T-shirts', one: 'T-shirt', many: 'T-shirts', group: 'tops', sizes: 'letter' },
    { id: 'hoodies', label: 'Hoodies', one: 'hoodie', many: 'hoodies', group: 'tops', sizes: 'letter' },
    { id: 'sweatshirts', label: 'Sweatshirts', one: 'sweatshirt', many: 'sweatshirts', group: 'tops', sizes: 'letter' },
    { id: 'pants', label: 'Pants', one: 'pants', many: 'pants', group: 'trousers', sizes: 'waist-or-letter', lengths: true },
    { id: 'sweatpants', label: 'Sweatpants', one: 'sweatpants', many: 'sweatpants', group: 'sweatpants', sizes: 'letter' },
    { id: 'jeans', label: 'Jeans', one: 'jeans', many: 'jeans', group: 'trousers', sizes: 'waist', lengths: true },
    { id: 'other', label: 'Other', one: null, many: 'clothes', group: 'other', sizes: 'letter' }
  ];
  const GARMENT_IDS = GARMENTS.map((g) => g.id);

  /* The sizes the guide offers. "Not sure" is stored as null, never as a
     size. Letter sizes from COMMON_SIZES and any whole waist in
     WAIST_RANGE are accepted too, for a later editor that offers more. */
  const LETTER_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
  const WAIST_SIZES = ['26', '27', '28', '29', '30', '31', '32', '33', '34', '36', '38', '40', '42'];
  const LENGTHS = ['28', '29', '30', '31', '32', '33', '34', '36'];
  const WAIST_RANGE = [24, 50];
  const LENGTH_RANGE = [26, 38];

  /* Offered in the guide's brand list for each group; anything else is
     typed under "Other brand", with BRAND_SUGGESTIONS to pick from. Any
     of these typed in any case is stored as spelled here. */
  const BRANDS = {
    tops: ['Nike', 'UNIQLO', 'Zara', 'H&M', 'Carhartt'],
    trousers: ['Levi’s', 'UNIQLO', 'Zara', 'Gap', 'Carhartt'],
    sweatpants: ['Nike', 'Adidas', 'UNIQLO', 'Champion', 'Lululemon'],
    other: ['Nike', 'UNIQLO', 'Zara', 'H&M', 'Gap']
  };
  const ANCHOR_BRANDS = Object.keys(BRANDS).reduce((all, group) => all.concat(BRANDS[group].filter((b) => !all.includes(b))), []);
  const BRAND_SUGGESTIONS = ['Abercrombie & Fitch', 'Adidas', 'American Eagle', 'Banana Republic', 'Champion', 'Dickies',
    'Everlane', 'Gap', 'H&M', 'J.Crew', 'Lacoste', 'Lee', 'Levi’s', 'Lululemon', 'Madewell', 'Old Navy', 'Patagonia',
    'Puma', 'Ralph Lauren', 'The North Face', 'Under Armour', 'Wrangler'];

  /* `nearest` is the per-category fit each goal sits closest to, for
     code that has to read the two together. Relaxed/oversized spans two
     of them, and is kept as one answer rather than forced into either.
     `hint` is the card's second line, in words for the group. */
  const FIT_GOALS = [
    {
      id: 'slim', label: 'Tight / Slim', nearest: ['fitted'],
      hint: { tops: 'Close to the body', trousers: 'Slim or skinny leg', sweatpants: 'Tapered and close', other: 'Close to the body' }
    },
    {
      id: 'true-to-size', label: 'True to Size', nearest: ['regular'],
      hint: { tops: 'Just as it’s labelled', trousers: 'Regular, straight leg', sweatpants: 'Regular, not baggy', other: 'Just as it’s labelled' }
    },
    {
      id: 'oversized', label: 'Relaxed / Oversized', nearest: ['relaxed', 'oversized'],
      hint: { tops: 'Room to move', trousers: 'Loose or baggy leg', sweatpants: 'Baggy and roomy', other: 'Room to move' }
    }
  ];
  const FIT_GOAL_IDS = FIT_GOALS.map((g) => g.id);

  /* Each group's own list. A spot from one list is refused for a type
     in another: legs are not a T-shirt's problem. */
  const TROUBLE_ZONES = {
    tops: [
      { id: 'sleeves-short', label: 'Sleeves are too short' },
      { id: 'torso-short', label: 'Torso is too short' },
      { id: 'neckline-tight', label: 'Neckline is too tight' },
      { id: 'chest-tight', label: 'Too tight across the chest' },
      { id: 'waist-loose', label: 'Fits my chest but is too loose around the waist' }
    ],
    trousers: [
      { id: 'legs-short', label: 'Legs are too short' },
      { id: 'legs-long', label: 'Legs are too long' },
      { id: 'waist-tight', label: 'Too tight around the waist' },
      { id: 'hips-tight', label: 'Too tight around the hips or seat' },
      { id: 'thighs-tight', label: 'Too tight around the thighs' },
      { id: 'legs-loose', label: 'Waist fits but legs are too loose' }
    ],
    sweatpants: [
      { id: 'legs-length', label: 'Legs are too short or too long' },
      { id: 'waist-fit', label: 'Waist is too tight or too loose' },
      { id: 'thighs-tight', label: 'Too tight around the thighs' },
      { id: 'legs-baggy', label: 'Too baggy through the legs' }
    ],
    other: [
      { id: 'too-short', label: 'Too short' },
      { id: 'too-long', label: 'Too long' },
      { id: 'too-tight', label: 'Too tight' },
      { id: 'too-loose', label: 'Too loose' }
    ]
  };

  /* The version 2 guide asked about "a top", in these words. Its answers
     are kept and shown as they were asked, never re-read through the
     lists above. */
  const LEGACY_GUIDE = {
    fitGoals: { slim: 'Tight / Slim Fit', 'true-to-size': 'True to Size', oversized: 'Cozy / Oversized' },
    troubleZones: [
      { id: 'sleeves-short', label: 'Sleeves are always too short' },
      { id: 'torso-short', label: 'Torso is always too short' },
      { id: 'neckline-tight', label: 'Necklines are too tight' },
      { id: 'waist-loose', label: 'Fits my chest but bags out at my waist' }
    ]
  };
  const LEGACY_ZONE_IDS = LEGACY_GUIDE.troubleZones.map((z) => z.id);
  /* The version 2 sizes, for its anchor; still accepted from a page
     loaded before version 3. */
  const ANCHOR_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

  /* The fields added after version 1. A save that leaves one out keeps
     what is stored (see the header). */
  const LEGACY_FIELDS = ['anchor', 'fitGoal', 'troubleZones'];
  const GUIDE_FIELDS = LEGACY_FIELDS.concat('garments');

  /* What somebody types when they do not know their size. Each is read
     as "unknown" — never as a size. */
  const UNKNOWN_SIZE = new Set(['unknown', 'not sure', 'not-sure', 'unsure', 'dont know', 'don’t know', "don't know", 'idk', '?', 'n/a', 'na', '-']);
  const LETTER_SIZE = /^(?:[2-6]?x{0,4}[sl]|m|[2-6]x)$/i;
  const SIZE_CHARACTERS = /^[\p{L}\p{N} ./+\-()]+$/u;

  /* ---------- small helpers ---------- */

  const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const round1 = (value) => Math.round(value * 10) / 10;
  const blank = (value) => value === null || value === undefined || (typeof value === 'string' && !value.trim());

  const cleanText = (raw) => String(raw).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  /* One brand however it is typed: "H&M", "h & m" and "H & M " are the
     same brand, so they share a key and cannot be listed twice. */
  const brandKey = (name) => cleanText(name || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

  const rangeOf = (key, unit) => (MEASUREMENTS[key] && MEASUREMENTS[key].range[unit]) || null;

  const garmentOf = (id) => GARMENTS.find((g) => g.id === id) || null;
  const zonesFor = (id) => { const g = garmentOf(id); return g ? TROUBLE_ZONES[g.group] : []; };
  const brandsFor = (id) => { const g = garmentOf(id); return g ? BRANDS[g.group] : []; };
  const isWaistSize = (size) => typeof size === 'string' && /^\d{2}$/.test(size);
  const inRange = (text, [min, max]) => /^\d{2}$/.test(text) && Number(text) >= min && Number(text) <= max;

  /* The sizes the guide offers for a type: letter sizes, waist sizes,
     or both (pants come either way), and lengths where a waist can
     carry one. */
  function sizesFor(id) {
    const g = garmentOf(id);
    if (!g) return null;
    return {
      letter: g.sizes === 'waist' ? null : LETTER_SIZES,
      waist: g.sizes === 'letter' ? null : WAIST_SIZES,
      lengths: g.lengths ? LENGTHS : null
    };
  }

  /* A converted value, shown as such. Used by the page when the shopper
     switches unit, never by normalise(). */
  function convert(value, from, to) {
    if (from === to) return value;
    return round1(from === 'in' ? value * CM_PER_INCH : value / CM_PER_INCH);
  }

  /* 70 -> { feet: 5, inches: 10 }. Rounded once, so 71.96 is 6 ft 0 in
     and never 5 ft 12 in. */
  function feetAndInches(totalInches) {
    const total = round1(totalInches);
    const feet = Math.floor(total / 12);
    const inches = round1(total - feet * 12);
    return inches >= 12 ? { feet: feet + 1, inches: 0 } : { feet, inches };
  }

  const formatNumber = (value) => String(round1(value));

  const formatHeightInches = (value) => {
    const { feet, inches } = feetAndInches(value);
    return `${feet} ft ${formatNumber(inches)} in`;
  };

  /* A number, as JSON sends it or a form field holds it. Anything else —
     "5'10", "40in", "1e2", true — is not read at all. */
  function readNumber(raw) {
    if (blank(raw)) return { blank: true };
    if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false };
    if (typeof raw === 'string') {
      const text = raw.trim();
      return /^\d{1,4}(\.\d+)?$/.test(text) ? { ok: true, value: Number(text) } : { ok: false };
    }
    return { ok: false };
  }

  function rangeMessage(key, value, unit) {
    const { label } = MEASUREMENTS[key];
    const [min, max] = rangeOf(key, unit);
    const other = unit === 'in' ? 'cm' : 'in';
    const [otherMin, otherMax] = rangeOf(key, other);

    const span = key === 'height' && unit === 'in'
      ? `${formatHeightInches(min)} and ${formatHeightInches(max)} (${min}–${max} in)`
      : `${min} and ${max} ${unit}`;
    let message = `${label} should be between ${span}.`;

    /* Said, never done: a value that fits the other unit is pointed out
       so the shopper can change the unit themselves. */
    if (value >= otherMin && value <= otherMax) {
      message += ` ${formatNumber(value)} looks like ${UNIT_NAME[other]} — if that is how you measured, switch the unit to ${UNIT_NAME[other]}.`;
    }
    return message;
  }

  /* ---------- the empty profile, and reading a stored one ---------- */

  function empty() {
    const measurements = { unit: null };
    MEASUREMENT_KEYS.forEach((key) => { measurements[key] = null; });
    return {
      schemaVersion: SCHEMA_VERSION,
      measurements,
      brandSizes: [],
      fitPreferences: {},
      anchor: null,
      fitGoal: null,
      troubleZones: null,
      garments: {}
    };
  }

  const emptyGarment = () => ({ anchor: null, fitGoal: null, troubleZones: null });

  /* Nothing said about this type. "None of these" is an answer, so an
     empty list of trouble spots is not empty. */
  const garmentIsEmpty = (entry) => !entry || (!entry.anchor && !entry.fitGoal && !Array.isArray(entry.troubleZones));

  /* Each step takes a profile of version N and returns version N + 1.
     Version 1 had no guide; version 2's guide asked about "a top". Each
     step adds what is new, unanswered, and touches nothing older. */
  const UPGRADES = {
    1: (profile) => Object.assign({}, profile, { schemaVersion: 2, anchor: null, fitGoal: null, troubleZones: null }),
    2: (profile) => Object.assign({}, profile, { schemaVersion: 3, garments: {} })
  };

  /* A stored anchor in its shape for the type: a length only where the
     type has lengths. Null when nothing in it was said. */
  function shapeAnchor(garment, raw) {
    if (!isPlainObject(raw)) return null;
    const brand = typeof raw.brand === 'string' ? raw.brand : null;
    const size = typeof raw.size === 'string' ? raw.size : null;
    const length = garment && garment.lengths && typeof raw.length === 'string' ? raw.length : null;
    if (!brand && !size && !length) return null;
    return garment && garment.lengths ? { brand, size, length } : { brand, size };
  }

  /* The current shape of whatever was stored, or null for something
     this version cannot read (a later schema, or not a profile at all).
     It re-shapes rather than re-validates: a profile was validated when
     it was saved, and tightening a range later must not make somebody's
     saved profile unreadable. Only named fields survive. */
  function upgrade(record) {
    if (!isPlainObject(record)) return null;
    const version = record.schemaVersion === undefined ? 1 : record.schemaVersion;
    if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) return null;

    let current = record;
    for (let v = version; v < SCHEMA_VERSION; v += 1) current = UPGRADES[v](current);

    const shaped = empty();
    const m = isPlainObject(current.measurements) ? current.measurements : {};
    shaped.measurements.unit = UNITS.includes(m.unit) ? m.unit : null;
    MEASUREMENT_KEYS.forEach((key) => {
      shaped.measurements[key] = typeof m[key] === 'number' && Number.isFinite(m[key]) ? m[key] : null;
    });

    shaped.brandSizes = (Array.isArray(current.brandSizes) ? current.brandSizes : [])
      .filter(isPlainObject)
      .map((entry) => ({
        brand: typeof entry.brand === 'string' ? entry.brand : '',
        category: typeof entry.category === 'string' ? entry.category : '',
        size: typeof entry.size === 'string' ? entry.size : null,
        fit: typeof entry.fit === 'string' ? entry.fit : null
      }));

    const prefs = isPlainObject(current.fitPreferences) ? current.fitPreferences : {};
    Object.keys(prefs).forEach((category) => {
      if (typeof prefs[category] === 'string') shaped.fitPreferences[category] = prefs[category];
    });

    /* version 2's answers about a top: as stored, where they were */
    shaped.anchor = shapeAnchor(null, current.anchor);
    shaped.fitGoal = typeof current.fitGoal === 'string' ? current.fitGoal : null;
    shaped.troubleZones = Array.isArray(current.troubleZones)
      ? current.troubleZones.filter((zone) => typeof zone === 'string')
      : null;

    /* version 3's answers, type by type, in GARMENTS order */
    const garments = isPlainObject(current.garments) ? current.garments : {};
    GARMENTS.forEach((garment) => {
      const raw = garments[garment.id];
      if (!isPlainObject(raw)) return;
      const entry = {
        anchor: shapeAnchor(garment, raw.anchor),
        fitGoal: typeof raw.fitGoal === 'string' ? raw.fitGoal : null,
        troubleZones: Array.isArray(raw.troubleZones) ? raw.troubleZones.filter((zone) => typeof zone === 'string') : null
      };
      if (!garmentIsEmpty(entry)) shaped.garments[garment.id] = entry;
    });

    if (typeof current.createdAt === 'string') shaped.createdAt = current.createdAt;
    if (typeof current.updatedAt === 'string') shaped.updatedAt = current.updatedAt;
    return shaped;
  }

  /* Whether version 2's answers about a top are there at all. */
  const hasLegacyGuide = (profile) => Boolean(profile)
    && Boolean(profile.anchor || profile.fitGoal || Array.isArray(profile.troubleZones));

  /* Whether anything has been said at all. */
  function isEmpty(profile) {
    if (!profile) return true;
    const m = profile.measurements || {};
    return MEASUREMENT_KEYS.every((key) => m[key] === null || m[key] === undefined)
      && !(profile.brandSizes || []).length
      && !Object.keys(profile.fitPreferences || {}).length
      && !hasLegacyGuide(profile)
      && !Object.keys(profile.garments || {}).length;
  }

  /* ---------- saying the answers in words ----------
     For every page that shows them. Never a size suggestion: only what
     the shopper said. */

  /* Version 2's answers about a top, in the words it asked them in. */
  function describeGuide(profile) {
    const p = profile || {};
    const a = p.anchor;
    const goal = LEGACY_GUIDE.fitGoals[p.fitGoal];
    const zones = Array.isArray(p.troubleZones)
      ? p.troubleZones.map((id) => (LEGACY_GUIDE.troubleZones.find((z) => z.id === id) || {}).label).filter(Boolean)
      : null;
    return {
      anchor: a && (a.brand || a.size) ? `${a.brand || 'Brand not said'} · ${a.size || 'size not sure'}` : 'Not answered',
      fitGoal: goal || 'Not answered',
      troubleZones: zones === null ? 'Not answered' : (zones.length ? zones.join('; ') : 'None of these')
    };
  }

  /* One type's size, as somebody would say it: "M", "32 × 32",
     "waist 32", "size not sure". */
  function describeSize(anchor) {
    if (anchor.size && anchor.length) return `${anchor.size} × ${anchor.length}`;
    if (anchor.size) return isWaistSize(anchor.size) ? `waist ${anchor.size}` : anchor.size;
    if (anchor.length) return `length ${anchor.length}, waist not sure`;
    return 'size not sure';
  }

  /* One type's answers, in the words its own questions use. */
  function describeGarment(id, entry) {
    const garment = garmentOf(id);
    const e = entry || {};
    const a = e.anchor;
    const goal = FIT_GOALS.find((g) => g.id === e.fitGoal);
    const zones = Array.isArray(e.troubleZones)
      ? e.troubleZones.map((zone) => (zonesFor(id).find((z) => z.id === zone) || {}).label).filter(Boolean)
      : null;
    return {
      garment: garment ? garment.label : id,
      anchor: a && (a.brand || a.size || a.length) ? `${a.brand || 'Brand not said'} · ${describeSize(a)}` : 'Not answered',
      fitGoal: goal ? goal.label : 'Not answered',
      troubleZones: zones === null ? 'Not answered' : (zones.length ? zones.join('; ') : 'None of these')
    };
  }

  /* ---------- checking the guide's answers ---------- */

  const isUnknown = (text) => UNKNOWN_SIZE.has(text.toLowerCase());

  function readBrand(raw, field, fail) {
    if (blank(raw)) return { ok: true, brand: null };
    const text = typeof raw === 'string' ? cleanText(raw) : '';
    if (!text || !brandKey(text)) { fail(field, 'Use letters or numbers for the brand name.'); return { ok: false }; }
    if (text.length > LIMITS.brandLength) { fail(field, `Brand names can be up to ${LIMITS.brandLength} characters.`); return { ok: false }; }
    return { ok: true, brand: ANCHOR_BRANDS.find((b) => brandKey(b) === brandKey(text)) || text };
  }

  function sizeMessage(garment) {
    const letters = `a size from ${LETTER_SIZES[0]} to ${LETTER_SIZES[LETTER_SIZES.length - 1]}`;
    if (garment.sizes === 'waist') return `Choose a waist size for ${garment.many}, like 32, or Not sure.`;
    if (garment.sizes === 'waist-or-letter') return `Choose a waist size, like 32, or ${letters}, or Not sure.`;
    return `Choose ${letters}, or Not sure.`;
  }

  /* One type's anchor: brand, a size from that type's own sizes, and a
     length only where the type has lengths and the size is a waist. */
  function readGarmentAnchor(garment, raw, at, fail) {
    if (raw === null) return { ok: true, anchor: null };
    if (!isPlainObject(raw)) { fail(at, 'Send the piece that fits as a brand and a size.'); return { ok: false }; }
    let ok = true;

    const brand = readBrand(raw.brand, `${at}.brand`, fail);
    if (!brand.ok) ok = false;

    const sizes = sizesFor(garment.id);
    let size = null;
    if (!blank(raw.size)) {
      const text = typeof raw.size === 'string' || typeof raw.size === 'number' ? cleanText(raw.size) : '';
      if (text && isUnknown(text)) size = null;
      else if (sizes.letter && COMMON_SIZES.includes(text.toUpperCase())) size = text.toUpperCase();
      else if (sizes.waist && inRange(text, WAIST_RANGE)) size = text;
      else { fail(`${at}.size`, sizeMessage(garment)); ok = false; }
    }

    let length = null;
    if (!blank(raw.length)) {
      const text = typeof raw.length === 'string' || typeof raw.length === 'number' ? cleanText(raw.length) : '';
      if (!sizes.lengths) { fail(`${at}.length`, `${garment.label} are not sized by length.`); ok = false; }
      else if (text && isUnknown(text)) length = null;
      else if (!inRange(text, LENGTH_RANGE)) { fail(`${at}.length`, `Choose a length from ${LENGTHS[0]} to ${LENGTHS[LENGTHS.length - 1]}, or Not sure.`); ok = false; }
      else if (size !== null && !isWaistSize(size)) { fail(`${at}.length`, 'A length goes with a waist size, like 32 × 32.'); ok = false; }
      else length = text;
    }

    if (!ok) return { ok: false };
    if (!brand.brand && !size && !length) return { ok: true, anchor: null };
    return { ok: true, anchor: garment.lengths ? { brand: brand.brand, size, length } : { brand: brand.brand, size } };
  }

  /* One type's answers: only the fields that were sent, so a skipped
     step stays out and keeps its saved value. Null clears the whole
     type. Undefined when anything in it was wrong. */
  function readGarment(garment, raw, report) {
    const at = `garments.${garment.id}`;
    if (raw === null) return null;
    let failed = false;
    const fail = (field, message) => { failed = true; report(field, message); };
    if (!isPlainObject(raw)) { fail(at, `Send the answers for ${garment.many} as an object.`); return undefined; }
    const out = {};

    if (raw.anchor !== undefined) {
      const read = readGarmentAnchor(garment, raw.anchor, `${at}.anchor`, fail);
      if (read.ok) out.anchor = read.anchor;
    }

    if (raw.fitGoal !== undefined) {
      if (blank(raw.fitGoal)) out.fitGoal = null;
      else if (FIT_GOAL_IDS.includes(raw.fitGoal)) out.fitGoal = raw.fitGoal;
      else fail(`${at}.fitGoal`, `Choose how you like ${garment.many} to fit: ${FIT_GOALS.map((g) => g.label).join(', ')}.`);
    }

    if (raw.troubleZones !== undefined) {
      const list = zonesFor(garment.id).map((z) => z.id);
      const zones = raw.troubleZones;
      if (zones === null) out.troubleZones = null;
      else if (!Array.isArray(zones)) fail(`${at}.troubleZones`, 'Send the trouble spots as a list.');
      else if (zones.some((zone) => !list.includes(zone))) {
        fail(`${at}.troubleZones`, `Choose from the trouble spots listed for ${garment.id === 'other' ? 'this clothing' : garment.many}, or None of these.`);
      } else out.troubleZones = list.filter((id) => zones.includes(id));
    }

    return failed ? undefined : out;
  }

  /* ---------- the guide's answers ----------
     Takes any of:

       garments                     { <type>: { anchor, fitGoal, troubleZones } }
       anchor, fitGoal, troubleZones   version 2's answers about a top

     and returns { answers, errors }, with only what was sent in
     `answers` — per type, only the fields sent. A field sent as null
     clears the answer; a field not sent is not in `answers` at all,
     which is how a skipped step leaves a saved answer alone. Errors are
     named like the rest: "garments.jeans.anchor.size", "fitGoal". */
  function normaliseGuide(input) {
    const errors = [];
    const answers = {};
    const fail = (field, message) => errors.push({ field, message });
    const source = isPlainObject(input) ? input : {};

    /* ---- version 3: per type of clothing ---- */
    if (source.garments !== undefined) {
      const raw = source.garments;
      if (raw === null) {
        answers.garments = null;
      } else if (!isPlainObject(raw)) {
        fail('garments', 'Send the answers for each type of clothing as an object.');
      } else {
        const out = {};
        let unknown = false;
        Object.keys(raw).forEach((id) => {
          const garment = garmentOf(id);
          if (!garment) { unknown = true; return; }
          const entry = readGarment(garment, raw[id], fail);
          if (entry !== undefined) out[id] = entry;
        });
        if (unknown) fail('garments', `Choose a type of clothing: ${GARMENTS.map((g) => g.label).join(', ')}.`);
        answers.garments = out;
      }
    }

    /* ---- version 2: about a top, from a page loaded before version 3 ---- */
    if (source.anchor !== undefined) {
      const raw = source.anchor;
      if (raw === null) {
        answers.anchor = null;
      } else if (!isPlainObject(raw)) {
        fail('anchor', 'Send the top that fits as a brand and a size.');
      } else {
        const before = errors.length;
        const brand = readBrand(raw.brand, 'anchor.brand', fail);
        let size = null;
        if (!blank(raw.size)) {
          const text = typeof raw.size === 'string' ? cleanText(raw.size) : '';
          if (text && isUnknown(text)) size = null;
          else if (COMMON_SIZES.includes(text.toUpperCase())) size = text.toUpperCase();
          else fail('anchor.size', `Choose a size from ${ANCHOR_SIZES[0]} to ${ANCHOR_SIZES[ANCHOR_SIZES.length - 1]}, or Not sure.`);
        }
        if (errors.length === before) answers.anchor = brand.brand || size ? { brand: brand.brand, size } : null;
      }
    }

    if (source.fitGoal !== undefined) {
      if (blank(source.fitGoal)) answers.fitGoal = null;
      else if (FIT_GOAL_IDS.includes(source.fitGoal)) answers.fitGoal = source.fitGoal;
      else fail('fitGoal', `Choose how you like clothes to sit: ${FIT_GOAL_IDS.map((id) => LEGACY_GUIDE.fitGoals[id]).join(', ')}.`);
    }

    if (source.troubleZones !== undefined) {
      const raw = source.troubleZones;
      if (raw === null) {
        answers.troubleZones = null;
      } else if (!Array.isArray(raw)) {
        fail('troubleZones', 'Send the trouble spots as a list.');
      } else if (raw.some((zone) => !LEGACY_ZONE_IDS.includes(zone))) {
        fail('troubleZones', 'Choose from the trouble spots listed, or None of these.');
      } else {
        /* the listed order, each once */
        answers.troubleZones = LEGACY_ZONE_IDS.filter((id) => raw.includes(id));
      }
    }

    return { answers: errors.length ? {} : answers, errors };
  }

  /* A whole map of types, as a save sends it: what is not said in an
     entry is null, and a type with nothing said is left out. */
  function fullGarments(partial) {
    const out = {};
    if (!partial) return out;
    GARMENT_IDS.forEach((id) => {
      if (!partial[id]) return;
      const entry = Object.assign(emptyGarment(), partial[id]);
      if (!garmentIsEmpty(entry)) out[id] = entry;
    });
    return out;
  }

  /* What the guide sent, merged into what was stored: per type, a field
     sent replaces the stored one, a field not sent keeps it, and a type
     sent as null is removed. Types not sent are not touched. */
  function mergeGarments(stored, partial) {
    if (partial === null) return {};
    const out = {};
    GARMENT_IDS.forEach((id) => {
      let entry = stored && stored[id] ? Object.assign(emptyGarment(), stored[id]) : null;
      if (partial && has(partial, id)) {
        entry = partial[id] === null ? null : Object.assign(entry || emptyGarment(), partial[id]);
      }
      if (entry && !garmentIsEmpty(entry)) out[id] = entry;
    });
    return out;
  }

  /* ---------- the one validator ----------
     Takes what a page sent and returns { profile, errors }. Every error
     names its field the way the page names its inputs —
     "measurements.chest", "brandSizes.2.brand", "fitPreferences.hoodies",
     "garments.jeans.anchor.size" — and says what to do about it. With
     any error, profile is null and nothing should be saved. */

  function normalise(input) {
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });

    if (!isPlainObject(input)) {
      fail('profile', 'Send the fit profile as an object.');
      return { profile: null, errors };
    }

    let source = input;
    if (input.schemaVersion !== undefined) {
      const version = input.schemaVersion;
      if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
        fail('schemaVersion', 'This page is out of date. Reload it and try again.');
        return { profile: null, errors };
      }
      for (let v = version; v < SCHEMA_VERSION; v += 1) source = UPGRADES[v](source);
    }

    const profile = empty();

    /* ---- measurements ---- */
    const m = source.measurements === undefined || source.measurements === null ? {} : source.measurements;
    if (!isPlainObject(m)) {
      fail('measurements', 'Send measurements as an object.');
    } else {
      let unit = null;
      if (!blank(m.unit)) {
        const said = String(m.unit).trim().toLowerCase();
        if (UNITS.includes(said)) unit = said;
        else fail('measurements.unit', 'Measurements are in inches (in) or centimetres (cm).');
      }
      profile.measurements.unit = unit;

      let askedForUnit = errors.some((e) => e.field === 'measurements.unit');
      MEASUREMENT_KEYS.forEach((key) => {
        const read = readNumber(m[key]);
        if (read.blank) return;
        const { label } = MEASUREMENTS[key];
        if (!read.ok) {
          fail(`measurements.${key}`, `Enter your ${label.toLowerCase()} as a number, like ${key === 'height' ? '70' : '40'} or ${key === 'height' ? '70.5' : '40.5'}.`);
          return;
        }
        if (!unit) {
          if (!askedForUnit) fail('measurements.unit', 'Choose inches or centimetres, so your measurements mean what you meant.');
          askedForUnit = true;
          return;
        }
        const value = round1(read.value);
        const [min, max] = rangeOf(key, unit);
        if (value < min || value > max) {
          fail(`measurements.${key}`, rangeMessage(key, value, unit));
          return;
        }
        profile.measurements[key] = value;
      });
    }

    /* ---- usual sizes by brand ---- */
    const list = source.brandSizes === undefined || source.brandSizes === null ? [] : source.brandSizes;
    if (!Array.isArray(list)) {
      fail('brandSizes', 'Send usual sizes as a list.');
    } else if (list.length > LIMITS.brands) {
      fail('brandSizes', `You can list up to ${LIMITS.brands} brands.`);
    } else {
      const seen = new Map();
      list.forEach((entry, i) => {
        const at = `brandSizes.${i}`;
        if (!isPlainObject(entry)) {
          fail(at, 'Each usual size needs a brand and a category.');
          return;
        }
        let ok = true;

        const brand = typeof entry.brand === 'string' ? cleanText(entry.brand) : '';
        if (!brand) {
          fail(`${at}.brand`, 'Name the brand, or remove this row.');
          ok = false;
        } else if (brand.length > LIMITS.brandLength) {
          fail(`${at}.brand`, `Brand names can be up to ${LIMITS.brandLength} characters.`);
          ok = false;
        } else if (!brandKey(brand)) {
          fail(`${at}.brand`, 'Use letters or numbers for the brand name.');
          ok = false;
        }

        const category = typeof entry.category === 'string' ? entry.category.trim().toLowerCase() : '';
        if (!CATEGORY_IDS.includes(category)) {
          fail(`${at}.category`, `Choose a category: ${CATEGORIES.map((c) => c.label.toLowerCase()).join(' or ')}.`);
          ok = false;
        }

        /* Unknown stays unknown: blank, or any of the ways of saying "not
           sure", is stored as null and never as a guess. */
        let size = null;
        if (!blank(entry.size) && (typeof entry.size === 'string' || typeof entry.size === 'number')) {
          const text = cleanText(entry.size);
          if (UNKNOWN_SIZE.has(text.toLowerCase())) {
            size = null;
          } else if (text.length > LIMITS.sizeLength) {
            fail(`${at}.size`, `Sizes can be up to ${LIMITS.sizeLength} characters.`);
            ok = false;
          } else if (!SIZE_CHARACTERS.test(text)) {
            fail(`${at}.size`, 'Write the size the way the brand labels it, like M or 38.');
            ok = false;
          } else {
            size = LETTER_SIZE.test(text) ? text.toUpperCase() : text;
          }
        } else if (!blank(entry.size)) {
          fail(`${at}.size`, 'Write the size the way the brand labels it, like M or 38.');
          ok = false;
        }

        let fit = null;
        if (!blank(entry.fit)) {
          if (FIT_FEEDBACK_IDS.includes(entry.fit)) fit = entry.fit;
          else {
            fail(`${at}.fit`, 'Fit is too small, about right or too large.');
            ok = false;
          }
        }

        if (!ok) return;

        /* the same brand and category twice is a mistake, not two facts */
        const key = `${brandKey(brand)}|${category}`;
        if (seen.has(key)) {
          const label = CATEGORIES.find((c) => c.id === category).label.toLowerCase();
          fail(`${at}.brand`, `${seen.get(key)} ${label} are already listed above. Change that row instead.`);
          return;
        }
        seen.set(key, brand);
        profile.brandSizes.push({ brand, category, size, fit });
      });
    }

    /* ---- preferred fit, per category ---- */
    const prefs = source.fitPreferences === undefined || source.fitPreferences === null ? {} : source.fitPreferences;
    if (!isPlainObject(prefs)) {
      fail('fitPreferences', 'Send fit preferences as an object.');
    } else {
      Object.keys(prefs).forEach((category) => {
        if (!CATEGORY_IDS.includes(category)) {
          fail('fitPreferences', `Fit preferences are for ${CATEGORIES.map((c) => c.label.toLowerCase()).join(' and ')}.`);
          return;
        }
        const value = prefs[category];
        if (blank(value)) return;
        if (!FIT_PREFERENCE_IDS.includes(value)) {
          fail(`fitPreferences.${category}`, 'Preferred fit is fitted, regular, relaxed or oversized.');
          return;
        }
        profile.fitPreferences[category] = value;
      });
    }

    /* ---- the guide's answers ----
       Validated by the same rules the guide's own save uses. A field not
       sent stays empty here; api/_fit-profile.js keeps the stored value
       for it, so leaving it out never erases it. Sent, `garments` is the
       whole map: a type left out of it is removed. */
    const guide = normaliseGuide(source);
    guide.errors.forEach((e) => errors.push(e));
    LEGACY_FIELDS.forEach((field) => {
      if (has(guide.answers, field)) profile[field] = guide.answers[field];
    });
    if (has(guide.answers, 'garments')) profile.garments = fullGarments(guide.answers.garments);

    return errors.length ? { profile: null, errors } : { profile, errors };
  }

  const FitProfileSchema = {
    SCHEMA_VERSION,
    UNITS,
    UNIT_NAME,
    MEASUREMENTS,
    MEASUREMENT_KEYS,
    CATEGORIES,
    FIT_FEEDBACK,
    FIT_PREFERENCES,
    COMMON_SIZES,
    LIMITS,
    GARMENTS,
    LETTER_SIZES,
    WAIST_SIZES,
    LENGTHS,
    BRANDS,
    ANCHOR_BRANDS,
    BRAND_SUGGESTIONS,
    ANCHOR_SIZES,
    FIT_GOALS,
    TROUBLE_ZONES,
    LEGACY_GUIDE,
    LEGACY_FIELDS,
    GUIDE_FIELDS,
    normalise,
    normaliseGuide,
    mergeGarments,
    describeGuide,
    describeGarment,
    upgrade,
    empty,
    emptyGarment,
    garmentIsEmpty,
    hasLegacyGuide,
    isEmpty,
    garmentOf,
    zonesFor,
    brandsFor,
    sizesFor,
    isWaistSize,
    brandKey,
    rangeOf,
    readNumber,
    convert,
    feetAndInches
  };

  global.FitProfileSchema = FitProfileSchema;
  if (typeof module !== 'undefined' && module.exports) module.exports = FitProfileSchema;
})(typeof window !== 'undefined' ? window : globalThis);
