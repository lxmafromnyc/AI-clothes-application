/* =========================================================
   Fynd — the Shopper Fit Profile: its shape, and what it may hold

   The foundation brand-specific size recommendations will be built on.
   Three groups, every part of each optional:

     measurements     height and chest for tops; waist and hip kept for
                      the categories that come later. One unit for all
                      of them, chosen by the shopper: inches or
                      centimetres.
     brandSizes       the size somebody usually buys in a brand, for a
                      category, and how it fits them.
     fitPreferences   fitted, regular, relaxed or oversized — per
                      category, so a hoodie and a future t-shirt can
                      differ.

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
   to UPGRADES; a new category is a row in CATEGORIES. Neither touches a
   profile already saved.

   Nothing else is collected. There is no weight, no photograph and no
   free-text note here, and a field this file does not name is dropped
   rather than stored.
   ========================================================= */

(function (global) {
  'use strict';

  const SCHEMA_VERSION = 1;

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

  /* Tops first: hoodies and sweatshirts. A later category is one more
     row here, and its fit preference and brand sizes need nothing else. */
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

  /* What somebody types when they do not know their size. Each is read
     as "unknown" — never as a size. */
  const UNKNOWN_SIZE = new Set(['unknown', 'not sure', 'unsure', 'dont know', 'don’t know', "don't know", 'idk', '?', 'n/a', 'na', '-']);
  const LETTER_SIZE = /^(?:[2-6]?x{0,4}[sl]|m|[2-6]x)$/i;
  const SIZE_CHARACTERS = /^[\p{L}\p{N} ./+\-()]+$/u;

  /* ---------- small helpers ---------- */

  const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
    return { schemaVersion: SCHEMA_VERSION, measurements, brandSizes: [], fitPreferences: {} };
  }

  /* Each step takes a profile of version N and returns version N + 1.
     Empty while there is only one version; the loop in upgrade() is
     already in place for the first one that is added. */
  const UPGRADES = {};

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

    if (typeof current.createdAt === 'string') shaped.createdAt = current.createdAt;
    if (typeof current.updatedAt === 'string') shaped.updatedAt = current.updatedAt;
    return shaped;
  }

  /* Whether anything has been said at all. */
  function isEmpty(profile) {
    if (!profile) return true;
    const m = profile.measurements || {};
    return MEASUREMENT_KEYS.every((key) => m[key] === null || m[key] === undefined)
      && !(profile.brandSizes || []).length
      && !Object.keys(profile.fitPreferences || {}).length;
  }

  /* ---------- the one validator ----------
     Takes what a page sent and returns { profile, errors }. Every error
     names its field the way the page names its inputs —
     "measurements.chest", "brandSizes.2.brand", "fitPreferences.hoodies"
     — and says what to do about it. With any error, profile is null and
     nothing should be saved. */

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
    normalise,
    upgrade,
    empty,
    isEmpty,
    brandKey,
    rangeOf,
    readNumber,
    convert,
    feetAndInches
  };

  global.FitProfileSchema = FitProfileSchema;
  if (typeof module !== 'undefined' && module.exports) module.exports = FitProfileSchema;
})(typeof window !== 'undefined' ? window : globalThis);
