/* =========================================================
   Fynd — the fit profile page

   Shows the signed-in shopper's fit profile as a form, checks it as
   they type, and saves or deletes it through /api/fit-profile.

   The fit guide's answers are a card per type of clothing, each built
   from that type's own brands, sizes and trouble spots, and saved as the
   whole map: a card removed here is a type removed. Version 2's answers
   about a top are shown as given and only ever removed, never edited
   into any one type.

   ---------------------------------------------------------
   What this file is allowed to decide
   ---------------------------------------------------------
   What the form shows, and when a message appears. The rules — which
   numbers are plausible, which categories exist, what counts as the
   same brand twice — are assets/fit-profile-schema.js, the same file
   the server checks every save against. A check here is a courtesy so
   a mistake is pointed out before anything is sent; the server's is
   the one that decides.

   ---------------------------------------------------------
   Units
   ---------------------------------------------------------
   The unit is chosen, visibly, and every field shows it. Switching it
   converts each measurement that was valid in the old unit, leaves one
   that was not exactly as typed (it was probably typed in the new unit,
   which is what the error message suggested), and says which was which.
   Nothing is ever relabelled silently.

   Nothing is written to localStorage. The profile lives on the server,
   and in this page for as long as it is open.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc || doc.body.dataset.page !== 'fit-profile') return;

  const Schema = global.FitProfileSchema;
  const $ = (id) => doc.getElementById(id);
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };

  /* ---------- messages ---------- */

  function note(id, text, tone) {
    const el = $(id);
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.className = `billing-note${tone ? ` billing-note--${tone}` : ''}`;
    el.textContent = text;
    el.hidden = false;
  }

  function formError(text) {
    const el = $('profile-form-error');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('show', Boolean(text));
  }

  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text || ''; };

  /* ---------- panels ----------
     One of these is on screen at a time. The form only ever appears
     once the saved profile has been read: showing it empty after a
     failed read would invite somebody to save over what they had. */

  const PANELS = ['profile-loading', 'profile-signed-out', 'profile-load-failed', 'profile-form'];
  const showPanel = (name) => PANELS.forEach((id) => show(id, id === name));

  /* ---------- state ---------- */

  let unit = 'in';
  let saved = null;          /* the profile as the server last returned it */
  let snapshot = '';         /* the form as it was when last read or saved */
  let attempted = false;     /* once a save is tried, every error shows */
  let justSaved = false;
  let working = false;
  let rowSeq = 0;

  const MEASURE_KEYS = Schema ? Schema.MEASUREMENT_KEYS.filter((key) => key !== 'height') : [];
  const UNIT_NAME = Schema ? Schema.UNIT_NAME : {};

  const round1 = (value) => Math.round(value * 10) / 10;
  const inRange = (key, value, inUnit) => {
    const [min, max] = Schema.rangeOf(key, inUnit);
    const rounded = round1(value);
    return rounded >= min && rounded <= max;
  };
  const numberIn = (raw) => {
    const read = Schema.readNumber(raw);
    return read.ok ? read.value : null;
  };

  /* ---------- height in feet and inches ----------
     Kept as one number of inches on the server; split here because
     nobody thinks of themselves as 70 inches tall. Inches alone, with
     feet left empty, is read as inches — never as anything else. */

  function readImperialHeight(ftRaw, inRaw) {
    const ft = String(ftRaw || '').trim();
    const inch = String(inRaw || '').trim();
    if (!ft && !inch) return { value: null };

    let feet = 0;
    let inches = 0;
    if (ft) {
      if (!/^\d{1,3}$/.test(ft)) return { error: 'Feet should be a whole number, like 5.' };
      feet = Number(ft);
      if (feet < 4 || feet > 7) {
        let message = 'Feet should be a whole number from 4 to 7.';
        if (!inch && inRange('height', feet, 'cm')) {
          message += ` ${feet} looks like centimetres — if that is how you measured, switch the unit to centimetres.`;
        } else if (!inch && inRange('height', feet, 'in')) {
          message += ` If you meant ${feet} inches, leave feet empty and put ${feet} in the inches box.`;
        }
        return { error: message };
      }
    }
    if (inch) {
      const read = Schema.readNumber(inch);
      if (!read.ok) return { error: 'Enter inches as a number, like 10 or 10.5.' };
      inches = read.value;
      if (ft && inches >= 12) return { error: 'With feet filled in, inches should be from 0 to 11.9.' };
    }
    return { value: round1(feet * 12 + inches) };
  }

  const heightText = (totalInches) => {
    const { feet, inches } = Schema.feetAndInches(totalInches);
    return `${feet} ft ${inches} in`;
  };

  /* ---------- brand rows ---------- */

  const rows = () => Array.from(doc.querySelectorAll('#brand-list > .brand-row'));
  const part = (row, name) => row.querySelector(`[data-part="${name}"] input, [data-part="${name}"] select`);

  function options(list, first) {
    return [`<option value="">${first}</option>`]
      .concat(list.map((item) => `<option value="${item.id}">${item.label}</option>`))
      .join('');
  }

  function addRow(entry, settings) {
    const list = $('brand-list');
    if (!list) return null;
    rowSeq += 1;
    const id = `brand-${rowSeq}`;
    const row = doc.createElement('li');
    row.className = 'brand-row';
    row.innerHTML = `
      <div class="brand-row-grid">
        <div class="profile-field" data-part="brand">
          <label class="profile-label" for="${id}-brand">Brand</label>
          <input class="profile-input" type="text" id="${id}-brand" maxlength="${Schema.LIMITS.brandLength}" autocomplete="off" placeholder="e.g. Uniqlo" aria-describedby="${id}-brand-error">
          <p class="profile-error" id="${id}-brand-error"></p>
        </div>
        <div class="profile-field" data-part="category">
          <label class="profile-label" for="${id}-category">Category</label>
          <span class="select-wrap"><select class="profile-select" id="${id}-category" aria-describedby="${id}-category-error">${options(Schema.CATEGORIES, 'Choose…')}</select></span>
          <p class="profile-error" id="${id}-category-error"></p>
        </div>
        <div class="profile-field" data-part="size">
          <label class="profile-label" for="${id}-size">Usual size</label>
          <input class="profile-input" type="text" id="${id}-size" list="size-options" maxlength="${Schema.LIMITS.sizeLength}" autocomplete="off" placeholder="Not sure" aria-describedby="${id}-size-error">
          <p class="profile-error" id="${id}-size-error"></p>
        </div>
        <div class="profile-field" data-part="fit">
          <label class="profile-label" for="${id}-fit">How it fits</label>
          <span class="select-wrap"><select class="profile-select" id="${id}-fit" aria-describedby="${id}-fit-error">${options(Schema.FIT_FEEDBACK, 'Not said')}</select></span>
          <p class="profile-error" id="${id}-fit-error"></p>
        </div>
      </div>
      <div class="brand-row-foot">
        <button class="link-btn" type="button" data-remove>Remove</button>
      </div>`;

    /* values go in as properties, never as markup */
    const e = entry || {};
    part(row, 'brand').value = e.brand || '';
    part(row, 'category').value = e.category || '';
    part(row, 'size').value = e.size || '';
    part(row, 'fit').value = e.fit || '';
    list.appendChild(row);
    labelRemove(row);

    if (settings && settings.focus) part(row, 'brand').focus();
    afterRowsChange();
    return row;
  }

  /* "Remove Uniqlo", so a list of identical Remove buttons is not what a
     screen reader reads out */
  function labelRemove(row) {
    const button = row.querySelector('[data-remove]');
    const brand = part(row, 'brand').value.trim();
    if (button) button.setAttribute('aria-label', brand ? `Remove ${brand}` : 'Remove this brand');
  }

  function afterRowsChange() {
    const count = rows().length;
    show('brand-empty', count === 0);
    const add = $('add-brand');
    if (add) add.disabled = count >= Schema.LIMITS.brands;
  }

  /* ---------- preferred fit ---------- */

  function renderPreferences() {
    const wrap = $('pref-groups');
    if (!wrap) return;
    const choice = (category, id, label) => `<label class="choice"><input type="radio" name="pref-${category}" value="${id}"><span>${label}</span></label>`;
    wrap.innerHTML = Schema.CATEGORIES.map((category) => `
      <fieldset class="pref-group" data-field="fitPreferences.${category.id}">
        <legend>${category.label}</legend>
        <div class="choices">
          ${Schema.FIT_PREFERENCES.map((pref) => choice(category.id, pref.id, pref.label)).join('')}
          ${choice(category.id, '', 'No preference')}
        </div>
        <p class="profile-error"></p>
      </fieldset>`).join('');
  }

  function renderSizes() {
    const list = $('size-options');
    if (list) list.innerHTML = Schema.COMMON_SIZES.map((size) => `<option value="${size}"></option>`).join('');
    const brands = $('garment-brands');
    if (brands) brands.replaceChildren(...Schema.BRAND_SUGGESTIONS.map((b) => new Option('', b)));
  }

  /* ---------- the fit guide's answers, one card per type ----------
     Each card is built from that type's own lists — its brands, its
     sizes, its trouble spots — so a value only one type has cannot be
     chosen for another. Values go in as properties, never as markup. */

  const editors = () => Array.from(doc.querySelectorAll('#garment-list > .garment-editor'));
  const piece = (editor, name) => editor.querySelector(`[data-part="${name}"]`);

  /* the length shows with a waist size: always for jeans, and for pants
     once a waist is chosen */
  function lengthVisible(editor) {
    const g = Schema.garmentOf(editor.dataset.garment);
    return Boolean(g.lengths && (g.sizes === 'waist' || Schema.isWaistSize(piece(editor, 'size').value)));
  }

  function paintEditor(editor) {
    piece(editor, 'other').hidden = piece(editor, 'brand').value !== 'other';
    const length = editor.querySelector('[data-length]');
    if (length) length.hidden = !lengthVisible(editor);
  }

  function addGarment(id, entry, settings) {
    const list = $('garment-list');
    const g = Schema.garmentOf(id);
    if (!list || !g) return null;
    const sizes = Schema.sizesFor(id);
    const at = `garments.${id}`;
    const p = `g-${id}`;
    const opts = (values) => values.map((v) => `<option value="${v}">${v}</option>`).join('');
    const sizeOptions = sizes.waist && sizes.letter
      ? `<optgroup label="Waist">${opts(sizes.waist)}</optgroup><optgroup label="Letter size">${opts(sizes.letter)}</optgroup>`
      : opts(sizes.waist || sizes.letter);
    const noun = g.id === 'other' ? 'it' : g.many;

    const editor = doc.createElement('fieldset');
    editor.className = 'garment-editor';
    editor.dataset.garment = id;
    editor.innerHTML = `
      <legend class="garment-editor-title">${g.label}</legend>
      <div class="profile-grid">
        <div class="profile-field" data-field="${at}.anchor.brand">
          <label class="profile-label" for="${p}-brand">Brand</label>
          <span class="select-wrap"><select class="profile-select" id="${p}-brand" data-part="brand" aria-describedby="${p}-brand-error">
            <option value="">Not said</option>${opts(Schema.brandsFor(id))}<option value="other">Other brand</option>
          </select></span>
          <input class="profile-input garment-other" type="text" id="${p}-other" data-part="other" list="garment-brands" maxlength="${Schema.LIMITS.brandLength}" autocomplete="off" placeholder="Which brand?" aria-label="${g.label}: which brand?" aria-describedby="${p}-brand-error" hidden>
          <p class="profile-error" id="${p}-brand-error"></p>
        </div>
        <div class="profile-field" data-field="${at}.anchor.size">
          <label class="profile-label" for="${p}-size">${g.sizes === 'waist' ? 'Waist' : 'Size'}</label>
          <span class="select-wrap"><select class="profile-select" id="${p}-size" data-part="size" aria-describedby="${p}-size-error">
            <option value="">Not said</option>${sizeOptions}<option value="not-sure">Not sure</option>
          </select></span>
          <p class="profile-error" id="${p}-size-error"></p>
        </div>
        ${g.lengths ? `<div class="profile-field" data-field="${at}.anchor.length" data-length>
          <label class="profile-label" for="${p}-length">Length</label>
          <span class="select-wrap"><select class="profile-select" id="${p}-length" data-part="length" aria-describedby="${p}-length-error">
            <option value="">Not said</option>${opts(sizes.lengths)}<option value="not-sure">Not sure</option>
          </select></span>
          <p class="profile-error" id="${p}-length-error"></p>
        </div>` : ''}
      </div>
      <fieldset class="pref-group" data-field="${at}.fitGoal">
        <legend>How you like ${noun} to fit</legend>
        <div class="choices">
          ${Schema.FIT_GOALS.map((goal) => `<label class="choice"><input type="radio" name="${p}-goal" value="${goal.id}"><span>${goal.label}</span></label>`).join('')}
          <label class="choice"><input type="radio" name="${p}-goal" value=""><span>Not said</span></label>
        </div>
        <p class="profile-error"></p>
      </fieldset>
      <fieldset class="pref-group" data-field="${at}.troubleZones">
        <legend>What gets the fit wrong</legend>
        <div class="choices zone-choices">
          ${Schema.zonesFor(id).map((zone) => `<label class="choice"><input type="checkbox" name="${p}-zones" value="${zone.id}"><span>${zone.label}</span></label>`).join('')}
          <label class="choice"><input type="checkbox" name="${p}-zones" value="none" data-none><span>None of these</span></label>
        </div>
        <p class="profile-error"></p>
      </fieldset>
      <div class="brand-row-foot">
        <button class="link-btn" type="button" data-remove-garment aria-label="Remove the answers for ${g.label}">Remove these answers</button>
      </div>`;

    const e = entry || {};
    const a = e.anchor;
    if (a && (a.brand || a.size || a.length)) {
      if (a.brand && Schema.brandsFor(id).includes(a.brand)) piece(editor, 'brand').value = a.brand;
      else if (a.brand) { piece(editor, 'brand').value = 'other'; piece(editor, 'other').value = a.brand; }
      /* a size saved from somewhere that offers more is shown as itself */
      ['size', 'length'].forEach((name) => {
        const select = piece(editor, name);
        const value = a[name];
        if (!select || !value) return;
        if (!Array.from(select.options).some((o) => o.value === value)) {
          select.insertBefore(new Option(value, value), select.querySelector('option[value="not-sure"]'));
        }
        select.value = value;
      });
      if (!a.size) piece(editor, 'size').value = 'not-sure';
    }
    editor.querySelectorAll(`input[name="${p}-goal"]`).forEach((r) => { r.checked = r.value === (e.fitGoal || ''); });
    if (Array.isArray(e.troubleZones)) {
      editor.querySelectorAll(`input[name="${p}-zones"]`).forEach((c) => {
        c.checked = c.dataset.none !== undefined ? e.troubleZones.length === 0 : e.troubleZones.includes(c.value);
      });
    }

    list.appendChild(editor);
    paintEditor(editor);
    afterGarmentsChange();
    if (settings && settings.focus) piece(editor, 'brand').focus();
    return editor;
  }

  /* "Add a type" offers only the types without a card yet. */
  function afterGarmentsChange() {
    const shown = editors().map((el) => el.dataset.garment);
    show('garment-empty', shown.length === 0);
    const select = $('garment-add-select');
    if (!select) return;
    const left = Schema.GARMENTS.filter((g) => !shown.includes(g.id));
    select.replaceChildren(new Option('Choose…', ''), ...left.map((g) => new Option(g.label, g.id)));
    show('garment-add-area', left.length > 0);
  }

  /* One card's answers, as the schema takes them. */
  function readGarment(editor) {
    const g = Schema.garmentOf(editor.dataset.garment);
    const p = `g-${g.id}`;
    const choice = piece(editor, 'brand').value;
    const brand = choice === 'other' ? piece(editor, 'other').value : choice;
    const size = piece(editor, 'size').value;
    const length = g.lengths && lengthVisible(editor) ? piece(editor, 'length').value : '';
    const known = (value) => (value && value !== 'not-sure' ? value : null);

    let anchor = null;
    if (brand.trim() || size || length) {
      anchor = { brand, size: known(size) };
      if (g.lengths) anchor.length = known(length);
    }
    const goal = editor.querySelector(`input[name="${p}-goal"]:checked`);
    const ticked = Array.from(editor.querySelectorAll(`input[name="${p}-zones"]:checked`));
    let troubleZones = null;
    if (ticked.some((c) => c.dataset.none !== undefined)) troubleZones = [];
    else if (ticked.length) troubleZones = ticked.map((c) => c.value);
    return { anchor, fitGoal: goal && goal.value ? goal.value : null, troubleZones };
  }

  function garmentChanged(editor, target) {
    const part = target.dataset.part;
    if (part === 'brand') {
      paintEditor(editor);
      if (target.value === 'other') piece(editor, 'other').focus();
    }
    /* a length goes with a waist, never with a letter size */
    if (part === 'size' && piece(editor, 'length') && !lengthVisible(editor)) piece(editor, 'length').value = '';
    /* "None of these" and a trouble spot cannot both be true */
    if (target.type === 'checkbox' && target.checked) {
      const isNone = target.dataset.none !== undefined;
      editor.querySelectorAll(`input[name="${target.name}"]`).forEach((box) => {
        if (box !== target && (isNone || box.dataset.none !== undefined)) box.checked = false;
      });
    }
    paintEditor(editor);
  }

  /* ---------- version 2's answers about a top ----------
     Shown as given. Removing them takes effect on save, like every
     other change here, and can be taken back until then. */

  let legacyRemoved = false;

  function paintLegacy() {
    show('legacy-summary', !legacyRemoved);
    setText('legacy-note', legacyRemoved ? 'These answers will be removed when you save.' : '');
    setText('legacy-remove', legacyRemoved ? 'Keep them' : 'Remove these answers');
  }

  /* ---------- units ---------- */

  function paintUnit() {
    doc.querySelectorAll('input[name="unit"]').forEach((radio) => { radio.checked = radio.value === unit; });
    doc.querySelectorAll('#profile-form [data-unit]').forEach((el) => { el.hidden = el.dataset.unit !== unit; });
    doc.querySelectorAll('#profile-form [data-unit-label]').forEach((el) => { el.textContent = unit; });
    doc.querySelectorAll('#profile-form [data-unit-name]').forEach((el) => { el.textContent = `in ${UNIT_NAME[unit]}`; });
  }

  /* The one number somebody typed into the height boxes, when it was
     not a valid height: carried to the other unit as it stands. */
  function typedHeight(ft, inch) {
    if (ft && !inch) return ft;
    if (inch && !ft) return inch;
    const feet = numberIn(ft);
    const inches = numberIn(inch);
    return feet !== null && inches !== null ? String(round1(feet * 12 + inches)) : ft;
  }

  /* Converts what was valid, keeps what was not, and reports both. */
  function switchUnit(next) {
    if (next === unit || !Schema.UNITS.includes(next)) return;
    const from = unit;
    const converted = [];
    const kept = [];

    const ft = $('height-ft');
    const inch = $('height-in');
    const cm = $('height-cm');
    if (from === 'in') {
      const ftRaw = ft.value.trim();
      const inRaw = inch.value.trim();
      if (ftRaw || inRaw) {
        const read = readImperialHeight(ftRaw, inRaw);
        if (!read.error && read.value !== null && inRange('height', read.value, 'in')) {
          cm.value = String(Schema.convert(read.value, 'in', 'cm'));
          converted.push(`height ${heightText(read.value)} to ${cm.value} cm`);
        } else {
          cm.value = typedHeight(ftRaw, inRaw);
          kept.push('height');
        }
        ft.value = '';
        inch.value = '';
      }
    } else {
      const raw = cm.value.trim();
      if (raw) {
        const value = numberIn(raw);
        if (value !== null && inRange('height', value, 'cm')) {
          const total = Schema.convert(value, 'cm', 'in');
          const split = Schema.feetAndInches(total);
          ft.value = String(split.feet);
          inch.value = String(split.inches);
          converted.push(`height ${round1(value)} cm to ${heightText(total)}`);
        } else {
          ft.value = '';
          inch.value = raw;
          kept.push('height');
        }
        cm.value = '';
      }
    }

    MEASURE_KEYS.forEach((key) => {
      const field = $(`measure-${key}`);
      const raw = field.value.trim();
      if (!raw) return;
      const value = numberIn(raw);
      if (value !== null && inRange(key, value, from)) {
        field.value = String(Schema.convert(value, from, next));
        converted.push(`${key} ${round1(value)} ${from} to ${field.value} ${next}`);
      } else {
        kept.push(key);
      }
    });

    unit = next;
    paintUnit();

    let message = `Measurements are now in ${UNIT_NAME[next]}.`;
    if (converted.length) message += ` Converted ${converted.join(', ')}.`;
    if (kept.length) message += ` Left as you typed ${kept.length === 1 ? 'it' : 'them'}: ${kept.join(', ')}.`;
    setText('unit-note', message);
    refresh();
  }

  /* ---------- reading the form ---------- */

  function readForm() {
    const local = [];
    const measurements = { unit };

    if (unit === 'in') {
      const height = readImperialHeight($('height-ft').value, $('height-in').value);
      if (height.error) local.push({ field: 'measurements.height', message: height.error });
      else measurements.height = height.value;
    } else {
      measurements.height = $('height-cm').value;
    }
    MEASURE_KEYS.forEach((key) => { measurements[key] = $(`measure-${key}`).value; });

    /* each row is told its index now, so an error the server or the
       schema reports against "brandSizes.2.size" lands on the right box */
    const brandSizes = rows().map((row, i) => {
      ['brand', 'category', 'size', 'fit'].forEach((name) => {
        row.querySelector(`[data-part="${name}"]`).dataset.field = `brandSizes.${i}.${name}`;
      });
      return {
        brand: part(row, 'brand').value,
        category: part(row, 'category').value,
        size: part(row, 'size').value,
        fit: part(row, 'fit').value
      };
    });

    const fitPreferences = {};
    Schema.CATEGORIES.forEach((category) => {
      const checked = doc.querySelector(`input[name="pref-${category.id}"]:checked`);
      if (checked && checked.value) fitPreferences[category.id] = checked.value;
    });

    /* every card on the page, as the whole map: a card removed is a
       type removed */
    const garments = {};
    editors().forEach((editor) => { garments[editor.dataset.garment] = readGarment(editor); });

    return {
      payload: { schemaVersion: Schema.SCHEMA_VERSION, measurements, brandSizes, fitPreferences, garments },
      local
    };
  }

  function check() {
    const { payload, local } = readForm();
    const result = Schema.normalise(payload);
    const errors = local.concat(result.errors.filter((e) => !local.some((l) => l.field === e.field)));
    return { errors, profile: errors.length ? null : result.profile };
  }

  /* Everything the shopper could have changed, as typed — what "unsaved
     changes" is measured against. */
  function snapshotOf() {
    const values = Array.from(doc.querySelectorAll('#profile-form input:not([type="radio"]):not([type="checkbox"]), #profile-form select:not([data-ignore])'))
      .map((el) => (el.closest('.brand-row') ? `row:${el.value}` : `${el.id}:${el.value}`));
    const radios = Array.from(doc.querySelectorAll('#profile-form input[type="radio"]:checked, #profile-form input[type="checkbox"]:checked'))
      .map((el) => `${el.name}:${el.value}`);
    return JSON.stringify([unit, values, radios, legacyRemoved]);
  }

  /* ---------- showing errors ---------- */

  const controlsOf = (wrap) => Array.from(wrap.querySelectorAll('input, select'));

  function paintErrors(errors) {
    const placed = new Set();
    doc.querySelectorAll('#profile-form [data-field]').forEach((wrap) => {
      const error = errors.find((e) => e.field === wrap.dataset.field);
      const visible = Boolean(error) && (attempted || controlsOf(wrap).some((c) => c.dataset.touched));
      const out = wrap.classList.contains('profile-error') ? wrap : wrap.querySelector('.profile-error');
      if (out) out.textContent = visible ? error.message : '';
      controlsOf(wrap).filter((c) => c.type !== 'radio' && c.type !== 'checkbox').forEach((c) => {
        if (visible) c.setAttribute('aria-invalid', 'true');
        else c.removeAttribute('aria-invalid');
      });
      if (error) placed.add(error.field);
    });
    /* anything with no box of its own is said in the form's own line */
    return errors.filter((e) => !placed.has(e.field));
  }

  function refresh() {
    const { errors } = check();
    const unplaced = paintErrors(errors);
    if (attempted) {
      if (!errors.length) formError('');
      else if (unplaced.length) formError(unplaced.map((e) => e.message).join(' '));
    }
    const dirty = snapshotOf() !== snapshot;
    if (dirty) justSaved = false;
    setText('profile-save-state', dirty ? 'Unsaved changes' : (justSaved ? 'Saved' : ''));
  }

  function markClean() {
    snapshot = snapshotOf();
    attempted = false;
    doc.querySelectorAll('#profile-form [data-touched]').forEach((el) => { delete el.dataset.touched; });
    formError('');
    refresh();
  }

  const isDirty = () => !$('profile-form').hidden && snapshotOf() !== snapshot;

  /* ---------- filling the form from a profile ---------- */

  function fill(profile) {
    const p = profile || Schema.empty();
    const m = p.measurements || {};

    /* the guide's answers, a card per type, in the guide's order */
    $('garment-list').innerHTML = '';
    Schema.GARMENTS.forEach((g) => { if (p.garments && p.garments[g.id]) addGarment(g.id, p.garments[g.id]); });
    afterGarmentsChange();

    /* version 2's answers about a top, shown as given; sent only to
       remove them */
    const said = Schema.describeGuide(p);
    setText('guide-answer-anchor', said.anchor);
    setText('guide-answer-goal', said.fitGoal);
    setText('guide-answer-zones', said.troubleZones);
    legacyRemoved = false;
    show('legacy-guide', Schema.hasLegacyGuide(p));
    paintLegacy();

    if (Schema.UNITS.includes(m.unit)) unit = m.unit;
    paintUnit();

    ['height-ft', 'height-in', 'height-cm'].forEach((id) => { $(id).value = ''; });
    if (typeof m.height === 'number') {
      if (unit === 'in') {
        const split = Schema.feetAndInches(m.height);
        $('height-ft').value = String(split.feet);
        $('height-in').value = String(split.inches);
      } else {
        $('height-cm').value = String(m.height);
      }
    }
    MEASURE_KEYS.forEach((key) => {
      $(`measure-${key}`).value = typeof m[key] === 'number' ? String(m[key]) : '';
    });

    $('brand-list').innerHTML = '';
    (p.brandSizes || []).forEach((entry) => addRow(entry));
    afterRowsChange();

    Schema.CATEGORIES.forEach((category) => {
      const wanted = (p.fitPreferences || {})[category.id] || '';
      doc.querySelectorAll(`input[name="pref-${category.id}"]`).forEach((radio) => { radio.checked = radio.value === wanted; });
    });

    setText('unit-note', '');
    show('profile-delete-area', Boolean(saved));
    show('delete-confirm', false);
  }

  /* ---------- talking to the server ---------- */

  function busy(on, label) {
    working = on;
    const save = $('profile-save');
    if (save) {
      save.disabled = on;
      if (on) { save.dataset.label = save.textContent; save.textContent = label || 'Saving…'; }
      else if (save.dataset.label) save.textContent = save.dataset.label;
    }
    ['profile-delete', 'delete-confirm-yes'].forEach((id) => { const el = $(id); if (el) el.disabled = on; });
  }

  function storageNote(storage) {
    if (storage && storage.durable === false) {
      note('profile-note', 'This deployment has no durable storage yet, so a saved fit profile can be forgotten when the server restarts.', 'warn');
    }
  }

  const failure = (result, fallback) => (result.data && result.data.error)
    || (result.unreachable ? 'Fynd could not be reached. Check your connection and try again.' : fallback);

  async function save() {
    if (working) return;
    attempted = true;
    note('profile-note', '', null);
    const { errors, profile } = check();
    const unplaced = paintErrors(errors);

    if (errors.length) {
      const count = errors.length - unplaced.length;
      const where = count ? ` Fix the ${count === 1 ? 'highlighted field' : `${count} highlighted fields`}.` : '';
      formError(`Nothing was saved.${where}${unplaced.length ? ` ${unplaced.map((e) => e.message).join(' ')}` : ''}`);
      const first = doc.querySelector('#profile-form [aria-invalid="true"]');
      if (first) first.focus();
      return;
    }

    formError('');
    busy(true, 'Saving…');
    /* Every type's card goes, as the whole map. Version 2's answers about
       a top are not this form's to change, only to remove: normalise()
       fills them with null, and a null sent is an answer cleared, so they
       are left out — the server keeps them — unless Remove was pressed. */
    const body = Object.assign({}, profile);
    Schema.LEGACY_FIELDS.forEach((field) => {
      if (legacyRemoved) body[field] = null;
      else delete body[field];
    });
    const result = await global.Account.fitProfile.save(body);
    busy(false);

    if (result.ok && result.data) {
      saved = result.data.profile;
      fill(saved);
      justSaved = true;
      markClean();
      storageNote(result.data.storage);
      return;
    }

    if (result.status === 400 && result.data && Array.isArray(result.data.errors)) {
      const unplacedServer = paintErrors(result.data.errors);
      formError(`Nothing was saved. ${unplacedServer.length ? unplacedServer.map((e) => e.message).join(' ') : 'Fix the highlighted fields.'}`);
      return;
    }
    if (result.status === 401) {
      formError('You are signed out, so nothing was saved. Sign in again on the account page, then come back and save — your changes stay on this page while it is open.');
      return;
    }
    formError(`Nothing was saved — your changes are still here. ${failure(result, 'Try again in a moment.')}`);
  }

  async function removeProfile() {
    if (working) return;
    busy(true);
    const result = await global.Account.fitProfile.remove();
    busy(false);

    if (result.ok) {
      saved = null;
      fill(null);
      markClean();
      note('profile-note', 'Your fit profile is deleted.', 'good');
      const add = $('add-brand');
      if (add) add.focus();
      return;
    }
    show('delete-confirm', false);
    note('profile-note', result.status === 401
      ? 'You are signed out, so nothing was deleted. Sign in again and try once more.'
      : `Nothing was deleted. ${failure(result, 'Try again in a moment.')}`, 'warn');
  }

  async function readProfile() {
    showPanel('profile-loading');
    const result = await global.Account.fitProfile.read();

    if (result.ok && result.data) {
      saved = result.data.profile || null;
      fill(saved);
      showPanel('profile-form');
      justSaved = false;
      markClean();
      storageNote(result.data.storage);
      return;
    }
    if (result.status === 401) {
      showPanel('profile-signed-out');
      return;
    }
    setText('profile-load-error', failure(result, 'Something went wrong reading it. Your saved profile has not been changed.'));
    showPanel('profile-load-failed');
  }

  /* ---------- wiring ---------- */

  function wire() {
    const form = $('profile-form');
    if (!form) return;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      save();
    });

    form.addEventListener('change', (event) => {
      const target = event.target;
      if (target.name === 'unit') {
        switchUnit(target.value);
        return;
      }
      if (target.matches('input, select')) target.dataset.touched = '1';
      const row = target.closest('.brand-row');
      if (row) labelRemove(row);
      const editor = target.closest('.garment-editor');
      if (editor) garmentChanged(editor, target);
      refresh();
    });

    /* "unsaved changes" as soon as something is typed; errors wait for
       the field to be left, so nobody is told off mid-word */
    form.addEventListener('input', () => {
      const dirty = snapshotOf() !== snapshot;
      if (dirty) justSaved = false;
      setText('profile-save-state', dirty ? 'Unsaved changes' : (justSaved ? 'Saved' : ''));
    });

    $('add-brand').addEventListener('click', () => {
      if (rows().length >= Schema.LIMITS.brands) return;
      addRow({}, { focus: true });
      refresh();
    });

    $('brand-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove]');
      if (!button) return;
      const row = button.closest('.brand-row');
      const all = rows();
      const at = all.indexOf(row);
      row.remove();
      afterRowsChange();
      refresh();
      const next = rows()[Math.min(at, rows().length - 1)];
      if (next) part(next, 'brand').focus();
      else $('add-brand').focus();
    });

    $('garment-add').addEventListener('click', () => {
      const id = $('garment-add-select').value;
      if (!id) {
        $('garment-add-select').focus();
        return;
      }
      addGarment(id, null, { focus: true });
      refresh();
    });

    $('garment-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-remove-garment]');
      if (!button) return;
      const editor = button.closest('.garment-editor');
      const at = editors().indexOf(editor);
      editor.remove();
      afterGarmentsChange();
      refresh();
      const next = editors()[Math.min(at, editors().length - 1)];
      if (next) piece(next, 'brand').focus();
      else $('garment-add-select').focus();
    });

    $('legacy-remove').addEventListener('click', () => {
      legacyRemoved = !legacyRemoved;
      paintLegacy();
      refresh();
    });

    $('profile-delete').addEventListener('click', () => {
      show('delete-confirm', true);
      $('delete-confirm-yes').focus();
    });
    $('delete-cancel').addEventListener('click', () => {
      show('delete-confirm', false);
      $('profile-delete').focus();
    });
    $('delete-confirm-yes').addEventListener('click', removeProfile);

    $('profile-retry').addEventListener('click', start);

    global.addEventListener('beforeunload', (event) => {
      if (!isDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  /* ---------- start ---------- */

  async function start() {
    note('profile-note', '', null);
    if (!global.Account || !Schema) {
      setText('profile-load-error', 'This page did not load completely. Reload it to try again.');
      showPanel('profile-load-failed');
      return;
    }

    showPanel('profile-loading');
    const account = await global.Account.load();
    const state = global.Account.state();

    if (!state) {
      if (account.unreachable || account.status === 404) {
        showPanel(null);
        note('profile-note', 'Accounts are not connected to this copy of the site, so a fit profile cannot be kept here.', 'warn');
        return;
      }
      setText('profile-load-error', failure(account, 'Your account could not be read. Try again in a moment.'));
      showPanel('profile-load-failed');
      return;
    }

    if (!state.signedIn) {
      showPanel('profile-signed-out');
      return;
    }

    await readProfile();
  }

  if (Schema) {
    renderPreferences();
    renderSizes();
    paintUnit();
    wire();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  global.FitProfileUI = { readImperialHeight };
})(typeof window !== 'undefined' ? window : globalThis);
