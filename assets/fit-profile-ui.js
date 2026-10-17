/* =========================================================
   Fynd — the fit profile page

   Shows the signed-in shopper's fit profile as a form, checks it as
   they type, and saves or deletes it through /api/fit-profile.

   This is the one place a shopper manages how clothes fit them. Each
   type of clothing is a card, built from that type's own brands, sizes
   and trouble spots, asking what the old four-step fit guide asked, in
   its words: one that fits (for tops, first whether they own a
   favourite, then that reference piece — its product, what makes its
   fit good, and its measurements laid flat, each with how to take it),
   how that type should fit, and what gets its fit wrong. Everything is
   optional, and each card says what its answers can support so far
   (FitProfileSchema.readiness). Cards are saved as the whole map: a
   card removed here is a type removed. Version 2's answers about a top
   are shown as given and only ever removed, never edited into any one
   type.

   ---------------------------------------------------------
   Arriving from a search
   ---------------------------------------------------------
   find-clothes.html links here as fit-profile.html?for=<type>&from=
   search&q=<the search>. `for` opens that type's card (adding an empty
   one when there is none yet, so nothing has to start over); `from`
   and `q` build the way back to the search. Only the type and the
   shopper's own search words are ever in the address — nothing from
   the profile. Signed out, an account is made right here, so the page
   — and the way back — are not lost.

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

  const favoriteOf = (editor) => {
    const r = editor.querySelector(`input[name="g-${editor.dataset.garment}-favorite"]:checked`);
    return r ? r.value : '';
  };

  function paintEditor(editor) {
    piece(editor, 'other').hidden = piece(editor, 'brand').value !== 'other';
    const length = editor.querySelector('[data-length]');
    if (length) length.hidden = !lengthVisible(editor);
    /* "Not really": there is no piece to describe, so its questions go */
    const reference = editor.querySelector('[data-reference]');
    if (reference) reference.hidden = favoriteOf(editor) === 'none';
  }

  /* The guide's questions, worded for the type, as each card's headings. */
  const plural = (g) => g.one === g.many;
  const words = {
    favorite: (g) => `Do you own a ${g.one} that fits you exactly how you like?`,
    anchor: (g) => (g.favorite ? `Which ${g.one} is it?`
      : g.one ? `What brand and size of ${g.one} ${plural(g) ? 'fit' : 'fits'} you perfectly?` : 'What brand and size fits you perfectly?'),
    fit: (g) => `How do you like your ${g.id === 'other' ? 'clothes' : g.many} to fit?`,
    zones: () => 'What usually gets the fit wrong?'
  };

  /* The diagram the old compare page drew: where each of the four
     measurements is taken on a top laid flat. */
  const DIAGRAM = `<figure class="compare-diagram profile-diagram">
      <svg viewBox="0 0 240 200" aria-hidden="true" focusable="false">
        <path class="diagram-garment" d="M88 22 Q120 40 152 22 L196 40 L226 150 L202 158 L176 78 L176 186 L64 186 L64 78 L38 158 L14 150 L44 40 Z"/>
        <g class="diagram-line"><line x1="66" y1="86" x2="174" y2="86"/><text x="120" y="80">A</text></g>
        <g class="diagram-line"><line x1="100" y1="30" x2="100" y2="184"/><text x="108" y="140">B</text></g>
        <g class="diagram-line"><line x1="46" y1="44" x2="194" y2="44"/><text x="120" y="58">C</text></g>
        <g class="diagram-line"><line x1="196" y1="42" x2="224" y2="150"/><text x="218" y="92">D</text></g>
      </svg>
      <figcaption>A chest, armpit to armpit · B length, top of the shoulder to the hem · C shoulders, seam to seam · D sleeve, shoulder seam to cuff</figcaption>
    </figure>`;
  const DIAGRAM_LETTER = { chestWidth: 'A', bodyLength: 'B', shoulderWidth: 'C', sleeveLength: 'D' };

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
    const group = g.group;
    const radio = (name, value, label, extra) => `<label class="choice"><input type="radio" name="${name}" value="${value}"${extra || ''}><span>${label}</span></label>`;

    const editor = doc.createElement('fieldset');
    editor.className = 'garment-editor';
    editor.id = `card-${id}`;
    editor.dataset.garment = id;
    editor.innerHTML = `
      <legend class="garment-editor-title">${g.label}</legend>
      <div class="garment-status" data-part="status" role="status">
        <p class="garment-status-line" data-part="status-line"></p>
        <ul class="garment-improve" data-part="improve"></ul>
      </div>
      ${g.named ? `<div class="profile-field" data-field="${at}.name">
        <label class="profile-label" for="${p}-name">What is it?</label>
        <input class="profile-input" type="text" id="${p}-name" data-part="name" maxlength="${Schema.LIMITS.garmentNameLength}" autocomplete="off" placeholder="Like shorts or a jacket" aria-describedby="${p}-name-error">
        <p class="profile-error" id="${p}-name-error"></p>
      </div>` : ''}
      ${g.favorite ? `<fieldset class="pref-group" data-field="${at}.favorite">
        <legend>${words.favorite(g)}</legend>
        <div class="choices">
          ${Schema.FAVORITE_ANSWERS.map((a) => radio(`${p}-favorite`, a.id, a.label)).join('')}
          ${radio(`${p}-favorite`, '', 'Not said')}
        </div>
        <p class="profile-hint">No measuring needed to start — it helps Fynd compare other ${g.many} with it.</p>
        <p class="profile-error"></p>
      </fieldset>` : ''}
      <div class="garment-reference" data-reference>
        <p class="profile-label garment-question">${words.anchor(g)}</p>
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
          <div class="profile-field garment-line" data-field="${at}.line">
            <label class="profile-label" for="${p}-line">Sized as</label>
            <span class="select-wrap"><select class="profile-select" id="${p}-line" data-part="line" aria-describedby="${p}-line-error">
              <option value="">Not said</option>${Schema.SIZING_LINES.map((l) => `<option value="${l.id}">${l.label}</option>`).join('')}
            </select></span>
            <p class="profile-error" id="${p}-line-error"></p>
          </div>
        </div>
        ${g.favorite ? `<details class="garment-more" data-part="more">
          <summary class="garment-more-summary">Its product and measurements <span class="guide-optional">optional</span></summary>
          <div class="profile-field" data-field="${at}.anchor.product" data-prefix>
            <label class="profile-label" for="${p}-product">Product name or link</label>
            <input class="profile-input" type="text" id="${p}-product" data-part="product" maxlength="300" autocomplete="off" placeholder="Its name, or paste a link" aria-describedby="${p}-product-note ${p}-product-error">
            <p class="profile-hint" id="${p}-product-note">If Fynd has that product’s checked measurements, it uses them instead of yours.</p>
            <p class="profile-error" id="${p}-product-error"></p>
          </div>
          <fieldset class="pref-group" data-field="${at}.anchor.likes">
            <legend>What makes the fit good?</legend>
            <div class="choices">${Schema.FAVORITE_LIKES.map((l) => `<label class="choice"><input type="checkbox" name="${p}-likes" value="${l.id}"><span>${l.label}</span></label>`).join('')}</div>
            <p class="profile-error"></p>
          </fieldset>
          <fieldset class="pref-group garment-measure" data-field="${at}.anchor.measurements.unit">
            <legend>Its measurements, laid flat</legend>
            <p class="profile-hint">Lay it flat on a table, smooth it out, and measure the garment — not yourself. Only if you have a tape measure handy; you can add them any time.</p>
            ${DIAGRAM}
            <div class="choices">
              ${radio(`${p}-unit`, 'in', 'Inches')}
              ${radio(`${p}-unit`, 'cm', 'Centimetres')}
            </div>
            <p class="profile-error"></p>
          </fieldset>
          <div class="compare-measure-grid">
            ${Schema.GARMENT_MEASURE_KEYS.map((key) => {
              const m = Schema.GARMENT_MEASURES[key];
              return `<div class="profile-field" data-field="${at}.anchor.measurements.${key}">
                <label class="profile-label" for="${p}-m-${key}">${DIAGRAM_LETTER[key]} · ${m.label} <span class="sr-only" data-part="unit-name"></span></label>
                <span class="measure">
                  <input class="profile-input" type="text" id="${p}-m-${key}" data-measure-key="${key}" inputmode="decimal" maxlength="6" autocomplete="off" aria-describedby="${p}-m-${key}-how ${p}-m-${key}-error">
                  <span class="measure-unit" data-part="unit-label" aria-hidden="true">in</span>
                </span>
                <p class="compare-how" id="${p}-m-${key}-how">${m.how}</p>
                <p class="profile-error" id="${p}-m-${key}-error"></p>
              </div>`;
            }).join('')}
          </div>
          <div class="profile-field" data-field="${at}.anchor.notes">
            <label class="profile-label" for="${p}-notes">Notes on the fit you like</label>
            <textarea class="profile-input compare-notes" id="${p}-notes" data-part="notes" maxlength="200" rows="2" placeholder="Like: roomy in the body, sleeves just past the wrist" aria-describedby="${p}-notes-error"></textarea>
            <p class="profile-error" id="${p}-notes-error"></p>
          </div>
        </details>
        <button class="link-btn garment-remove-ref" type="button" data-remove-reference aria-label="Remove your reference ${g.one}">Remove this reference</button>` : ''}
      </div>
      <fieldset class="pref-group" data-field="${at}.fitGoal">
        <legend>${words.fit(g)}</legend>
        <p class="profile-hint garment-goal-hints">${Schema.FIT_GOALS.map((goal) => `<span id="${p}-goal-${goal.id}">${goal.label}: ${goal.hint[group].toLowerCase()}</span>`).join(' · ')}</p>
        <div class="choices">
          ${Schema.FIT_GOALS.map((goal) => radio(`${p}-goal`, goal.id, goal.label, ` aria-describedby="${p}-goal-${goal.id}"`)).join('')}
          ${radio(`${p}-goal`, '', 'Not said')}
        </div>
        <p class="profile-error"></p>
      </fieldset>
      <fieldset class="pref-group" data-field="${at}.troubleZones">
        <legend>${words.zones(g)}</legend>
        <p class="profile-hint">Pick any that apply — it’s about the clothes, not you.</p>
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
    if (g.named) piece(editor, 'name').value = e.name || '';
    piece(editor, 'line').value = e.line || '';
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
      if (!a.size && (a.brand || a.length)) piece(editor, 'size').value = 'not-sure';
    }
    if (g.favorite) {
      editor.querySelectorAll(`input[name="${p}-favorite"]`).forEach((r) => { r.checked = r.value === (e.favorite || ''); });
      fillReference(editor, a || {});
    }
    editor.querySelectorAll(`input[name="${p}-goal"]`).forEach((r) => { r.checked = r.value === (e.fitGoal || ''); });
    if (Array.isArray(e.troubleZones)) {
      editor.querySelectorAll(`input[name="${p}-zones"]`).forEach((c) => {
        c.checked = c.dataset.none !== undefined ? e.troubleZones.length === 0 : e.troubleZones.includes(c.value);
      });
    }

    list.appendChild(editor);
    paintEditor(editor);
    paintReadiness(editor, Schema.readiness({ garments: entry ? { [id]: entry } : {} }, id));
    afterGarmentsChange();
    if (settings && settings.focus) {
      const first = editor.querySelector('input, select');
      if (first) first.focus();
    }
    return editor;
  }

  /* The reference piece's details, as saved: shown in their own boxes,
     and opened when there is anything in them. */
  function fillReference(editor, a) {
    const p = `g-${editor.dataset.garment}`;
    const product = a.product || null;
    editor.savedProduct = product;
    piece(editor, 'product').value = product ? (product.url || product.name || '') : '';
    editor.querySelectorAll(`input[name="${p}-likes"]`).forEach((c) => { c.checked = Boolean(a.likes && a.likes.includes(c.value)); });
    const m = a.measurements || null;
    const refUnit = (m && m.unit) || unit;
    editor.querySelectorAll(`input[name="${p}-unit"]`).forEach((r) => { r.checked = r.value === refUnit; });
    Schema.GARMENT_MEASURE_KEYS.forEach((key) => {
      editor.querySelector(`[data-measure-key="${key}"]`).value = m && typeof m[key] === 'number' ? String(m[key]) : '';
    });
    piece(editor, 'notes').value = a.notes || '';
    piece(editor, 'more').open = Boolean(product || (a.likes && a.likes.length) || m || a.notes);
    paintReferenceUnit(editor);
  }

  function paintReferenceUnit(editor) {
    const r = editor.querySelector(`input[name="g-${editor.dataset.garment}-unit"]:checked`);
    const u = r ? r.value : unit;
    editor.querySelectorAll('[data-part="unit-label"]').forEach((el) => { el.textContent = u; });
    editor.querySelectorAll('[data-part="unit-name"]').forEach((el) => { el.textContent = `in ${UNIT_NAME[u]}`; });
  }

  /* What this card's answers can support so far, in words. */
  function paintReadiness(editor, ready) {
    if (!ready) return;
    const box = piece(editor, 'status');
    box.dataset.level = ready.level;
    piece(editor, 'status-line').textContent = ready.level === 'empty' ? 'Nothing saved for this type yet — answer what you know.' : ready.label;
    piece(editor, 'improve').replaceChildren(...ready.improve.map((text) => {
      const li = doc.createElement('li');
      li.textContent = text;
      return li;
    }));
  }

  /* Removing the reference: the piece, its answer and its details go
     on save; how the type should fit and what goes wrong stay. */
  function clearReference(editor) {
    const p = `g-${editor.dataset.garment}`;
    editor.querySelectorAll(`input[name="${p}-favorite"]`).forEach((r) => { r.checked = r.value === ''; });
    ['brand', 'size', 'length'].forEach((name) => { const el = piece(editor, name); if (el) el.value = ''; });
    piece(editor, 'other').value = '';
    fillReference(editor, {});
    paintEditor(editor);
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

  /* One card's answers, as the schema takes them. For a type with a
     favourite, every detail is sent as it stands on screen — a box
     cleared is a detail cleared — and "Not really" sends no piece. */
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
    const out = { anchor, fitGoal: goal && goal.value ? goal.value : null, troubleZones };

    if (g.favorite) {
      const answer = favoriteOf(editor);
      out.favorite = answer || null;
      if (answer === 'none') {
        out.anchor = null;
      } else {
        const details = readReference(editor);
        if (anchor || Object.values(details).some(Boolean)) out.anchor = Object.assign(anchor || { brand: null, size: null }, details);
      }
    }
    if (g.named) out.name = piece(editor, 'name').value;
    out.line = piece(editor, 'line').value || null;
    return out;
  }

  /* The reference's details, each null when not said. A product saved
     with both a name and a link is kept whole while its box still shows
     it. */
  function readReference(editor) {
    const p = `g-${editor.dataset.garment}`;
    const said = piece(editor, 'product').value.trim();
    const saved = editor.savedProduct;
    let product = null;
    if (said) {
      if (saved && (said === saved.url || said === saved.name)) product = saved;
      else product = /^https?:\/\//i.test(said) ? { url: said } : { name: said };
    }
    const likes = Array.from(editor.querySelectorAll(`input[name="${p}-likes"]:checked`)).map((c) => c.value);
    const measures = {};
    Schema.GARMENT_MEASURE_KEYS.forEach((key) => {
      const v = editor.querySelector(`[data-measure-key="${key}"]`).value.trim();
      if (v) measures[key] = v;
    });
    const unitChoice = editor.querySelector(`input[name="${p}-unit"]:checked`);
    const notes = piece(editor, 'notes').value.trim();
    return {
      product,
      likes: likes.length ? likes : null,
      measurements: Object.keys(measures).length ? Object.assign({ unit: unitChoice ? unitChoice.value : null }, measures) : null,
      notes: notes || null
    };
  }

  function garmentChanged(editor, target) {
    const part = target.dataset.part;
    if (part === 'brand') {
      paintEditor(editor);
      if (target.value === 'other') piece(editor, 'other').focus();
    }
    /* a length goes with a waist, never with a letter size */
    if (part === 'size' && piece(editor, 'length') && !lengthVisible(editor)) piece(editor, 'length').value = '';
    if (target.name === `g-${editor.dataset.garment}-unit`) paintReferenceUnit(editor);
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
    const values = Array.from(doc.querySelectorAll('#profile-form input:not([type="radio"]):not([type="checkbox"]), #profile-form select:not([data-ignore]), #profile-form textarea'))
      .map((el) => (el.closest('.brand-row') ? `row:${el.value}` : `${el.id}:${el.value}`));
    const radios = Array.from(doc.querySelectorAll('#profile-form input[type="radio"]:checked, #profile-form input[type="checkbox"]:checked'))
      .map((el) => `${el.name}:${el.value}`);
    /* which cards are on the page: a card added and left empty is not a change */
    return JSON.stringify([unit, values, radios, legacyRemoved]);
  }

  /* ---------- showing errors ---------- */

  const controlsOf = (wrap) => Array.from(wrap.querySelectorAll('input, select, textarea'));

  function paintErrors(errors) {
    const placed = new Set();
    doc.querySelectorAll('#profile-form [data-field]').forEach((wrap) => {
      /* a box that takes a name or a link answers for both */
      const own = (field) => field === wrap.dataset.field || (wrap.dataset.prefix !== undefined && field.startsWith(`${wrap.dataset.field}.`));
      const error = errors.find((e) => own(e.field));
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
    const { errors, profile } = check();
    const unplaced = paintErrors(errors);
    /* each card says what it can support as it stands on screen; while
       something on it is wrong, what it last said stays */
    if (profile) editors().forEach((editor) => paintReadiness(editor, Schema.readiness(profile, editor.dataset.garment)));
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

    if (Schema.UNITS.includes(m.unit)) unit = m.unit;

    /* a card per type, in the schema's order */
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
    /* the earlier per-category fit is shown only where one is saved:
       how a type should fit is asked on its own card */
    show('section-fit', Object.keys(p.fitPreferences || {}).length > 0);

    setText('unit-note', '');
    show('profile-delete-area', Boolean(saved));
    show('delete-confirm', false);
  }

  /* ---------- arriving from a search ----------
     Read once from the address: the type to open, and the search to go
     back to. Nothing is written to the address, and nothing from the
     profile is ever read into it. */

  const arrival = (() => {
    const params = new URLSearchParams(global.location.search);
    const type = Schema && Schema.garmentOf(params.get('for')) ? params.get('for') : null;
    const fromSearch = params.get('from') === 'search';
    const q = fromSearch ? String(params.get('q') || '').trim().slice(0, 400) : '';
    return { type, fromSearch, q };
  })();

  /* The way back: the search page, with its own type and words, which it
     runs again exactly as if they had been typed. */
  function paintReturn(afterSave) {
    if (!arrival.fromSearch) return;
    const back = new URLSearchParams();
    if (arrival.type) back.set('shop', arrival.type);
    if (arrival.q) back.set('q', arrival.q);
    const link = $('profile-return-link');
    link.href = `find-clothes.html${back.toString() ? `?${back}` : ''}`;
    link.textContent = arrival.q ? 'Back to your search' : 'Back to shopping';
    const g = arrival.type && Schema.garmentOf(arrival.type);
    setText('profile-return-text', afterSave
      ? `Saved. Your search will use it${g ? ` for ${g.many}` : ''}.`
      : arrival.q ? `You came here from your search for “${arrival.q}”.` : 'You came here while shopping.');
    $('profile-return').classList.toggle('profile-return--saved', Boolean(afterSave));
    show('profile-return', true);
  }

  /* The type the search was for: its card, opened and in view — added
     when there is none yet, so a profile is only ever added to. */
  function openArrivalCard() {
    if (!arrival.type) return;
    let editor = $(`card-${arrival.type}`);
    if (!editor) editor = addGarment(arrival.type, null);
    if (!editor) return;
    editor.classList.add('garment-editor--focus');
    editor.scrollIntoView({ block: 'start' });
    const first = editor.querySelector('input, select');
    if (first) first.focus({ preventScroll: true });
  }

  /* ---------- an account, right here, when signed out ---------- */

  let accountMode = 'signup';

  function setAccountMode(mode) {
    accountMode = mode;
    const signup = mode === 'signup';
    show('pa-field-name', signup);
    show('pa-field-confirm', signup);
    setText('pa-title', signup ? 'Create your fit profile' : 'Sign in to your fit profile');
    setText('pa-intro', signup
      ? 'A free account keeps your fit profile, and only you can see it. Fynd then uses it whenever you shop — searching never needs an account.'
      : 'Sign in, and your fit profile opens here.');
    setText('pa-submit', signup ? 'Create account' : 'Sign in');
    setText('pa-switch-text', signup ? 'Already have an account?' : 'New to Fynd?');
    setText('pa-switch', signup ? 'Sign in' : 'Create an account');
    $('pa-password').autocomplete = signup ? 'new-password' : 'current-password';
    setText('pa-error', '');
    $('pa-error').classList.remove('show');
  }

  async function submitAccount() {
    if (working) return;
    const say = (text) => {
      setText('pa-error', text);
      $('pa-error').classList.toggle('show', Boolean(text));
    };
    const value = (id) => $(id).value;
    say('');
    if (!value('pa-email').trim()) return say('Enter your email address.');
    if (accountMode === 'signup') {
      if (!value('pa-name').trim()) return say('Tell us what to call you.');
      if (value('pa-password').length < 10) return say('Use at least 10 characters for your password.');
      if (value('pa-password') !== value('pa-confirm')) return say('Those passwords do not match.');
    } else if (!value('pa-password')) {
      return say('Enter your password.');
    }
    const submit = $('pa-submit');
    const label = submit.textContent;
    working = true;
    submit.disabled = true;
    submit.textContent = accountMode === 'signup' ? 'Creating your account…' : 'Signing in…';
    const result = accountMode === 'signup'
      ? await global.Account.signup({ name: value('pa-name'), email: value('pa-email'), password: value('pa-password'), confirmPassword: value('pa-confirm') })
      : await global.Account.login(value('pa-email'), value('pa-password'));
    working = false;
    submit.disabled = false;
    submit.textContent = label;
    if (!result.ok) {
      if (result.status === 409 && accountMode === 'signup') {
        setAccountMode('login');
        return say('There is already an account for that address. Sign in to open your fit profile.');
      }
      return say(failure(result, 'That did not work. Try again in a moment.'));
    }
    /* passwords do not stay in the page a moment longer than needed */
    $('pa-password').value = '';
    $('pa-confirm').value = '';
    await readProfile();
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
    /* Likewise a reference's details: normalise() leaves out what isn't
       there, and what isn't sent the server keeps — but every detail is
       on this page, so one not said here was cleared here, and is sent
       as null. */
    editors().forEach((editor) => {
      const g = Schema.garmentOf(editor.dataset.garment);
      const entry = g.favorite && body.garments[g.id];
      if (entry && entry.anchor) ['product', 'likes', 'measurements', 'notes'].forEach((k) => { if (!entry.anchor[k]) entry.anchor[k] = null; });
    });
    const result = await global.Account.fitProfile.save(body);
    busy(false);

    if (result.ok && result.data) {
      saved = result.data.profile;
      fill(saved);
      justSaved = true;
      markClean();
      storageNote(result.data.storage);
      paintReturn(true);
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

  function showSignedOut() {
    setAccountMode(accountMode);
    const state = global.Account.state();
    show('pa-google', Boolean(state && state.accounts && state.accounts.google));
    const google = $('pa-google-button');
    if (google) google.href = global.Account.googleStartUrl();
    showPanel('profile-signed-out');
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
      /* a card opened for the search is a card to fill in, not a change
         to warn about leaving */
      openArrivalCard();
      snapshot = snapshotOf();
      refresh();
      return;
    }
    if (result.status === 401) {
      showSignedOut();
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
      /* the reference goes on save; how the type should fit stays */
      const reference = event.target.closest('[data-remove-reference]');
      if (reference) {
        const editor = reference.closest('.garment-editor');
        clearReference(editor);
        refresh();
        const first = editor.querySelector(`input[name="g-${editor.dataset.garment}-favorite"]`);
        if (first) first.focus();
        return;
      }
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

    $('profile-account').addEventListener('submit', (event) => {
      event.preventDefault();
      submitAccount();
    });
    $('pa-switch').addEventListener('click', () => setAccountMode(accountMode === 'signup' ? 'login' : 'signup'));

    global.addEventListener('beforeunload', (event) => {
      if (!isDirty()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  /* ---------- start ---------- */

  async function start() {
    note('profile-note', '', null);
    paintReturn(false);
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
      showSignedOut();
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
