/* =========================================================
   Fynd — the fit guide on the home page

   Four short questions, answered with taps and two dropdowns, saved to
   the shopper's fit profile:

     1  what we are sizing                    a type of clothing, and
                                              for "Something else", what
                                              it is in their words
     2  one of that type that fits perfectly  anchor: brand and size
     3  how they like that type to fit        fitGoal
     4  what usually gets the fit wrong       troubleZones, from that
                                              type's own list

   Steps 2 to 4 are asked about the type chosen in step 1, in its words,
   with its brands, its sizes (letters for tops, waist and length for
   jeans) and its trouble spots, and saved under that type alone:
   { garments: { jeans: { anchor, fitGoal, troubleZones } } }. The
   words and the allowed values are assets/fit-profile-schema.js's; the
   server checks every answer again (api/fit-profile.js, "guide").

   ---------------------------------------------------------
   One type at a time, and nothing lent between them
   ---------------------------------------------------------
   Switching type in step 1 puts the answers given so far aside for the
   type they were given for, and shows the new type's own: what was
   given for it earlier in this visit, or what is saved for it, or
   nothing. A T-shirt size is never left standing in a jeans question.
   Only the chosen type is saved; the others stay in this page's memory
   until it is closed.

   ---------------------------------------------------------
   Nothing is lost
   ---------------------------------------------------------
   Steps 2 to 4 are optional. Continue reads "Skip" until something is
   chosen, and a skipped step is not sent at all — the server keeps
   whatever was saved for it before. Every other type, measurements,
   usual sizes and per-category fits stay on the server as they are.
   Leaving the page saves and changes nothing.

   Signed out, the last step offers an account right here, so the
   answers never have to be kept anywhere but this page's memory: no
   localStorage, no sessionStorage, nothing in the URL. A save is only
   called a success once the server has said so; a failed one keeps
   every answer on screen with a way to try again.

   Google sign-in is offered too, where it is set up, but it is a
   full-page trip to Google that ends on the account page, so this
   page's memory does not survive it. The button says so before it is
   pressed: the answers are not saved, and the guide is tapped through
   again afterwards.

   No size is suggested and no measurement is estimated here. A brand
   and a size are a reference point, not a body; turning one into the
   other needs that brand's verified size chart, which this page does
   not have.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const root = doc && doc.getElementById('guide');
  if (!root) return;

  const Schema = global.FitProfileSchema;
  const $ = (id) => doc.getElementById(id);

  const form = $('guide-form');
  const accountForm = $('guide-account');
  const done = $('guide-done');
  const steps = Array.from(form.querySelectorAll('.guide-step'));
  const LAST = steps.length;

  const brand = $('anchor-brand');
  const size = $('anchor-size');
  const length = $('anchor-length');
  const otherField = $('anchor-other-field');
  const other = $('anchor-other');
  const lengthField = $('anchor-length-field');
  const garmentName = $('garment-name');
  const garmentNameField = $('garment-name-field');
  const none = $('zone-none');
  const zoneItems = $('zone-items');
  const zones = () => Array.from(zoneItems.querySelectorAll('input[name="troubleZones"]'));
  const garmentRadios = () => Array.from(form.querySelectorAll('input[name="garment"]'));

  const back = $('guide-back');
  const next = $('guide-next');
  const error = $('guide-error');

  let step = 1;
  let busy = false;
  /* "signup" or "login", for the account form at the end */
  let accountMode = 'signup';
  /* the type of clothing steps 2 to 4 are about, once chosen */
  let garment = null;
  /* what is saved, per type, as the server last returned it */
  let saved = {};
  /* answers given in this visit for types not on screen, so switching
     type and back loses nothing and lends nothing */
  const drafts = {};
  /* whether the account holds version 2's answers about a top */
  let legacy = false;

  const current = () => (garment && Schema.garmentOf(garment)) || null;

  /* ---------- the words, for the type chosen ---------- */

  const plural = (g) => g.one === g.many;   /* "jeans", "pants": one pair, a plural noun */
  const words = {
    anchorQuestion: (g) => (g.one ? `What brand and size of ${g.one} fits you perfectly?` : 'What brand and size fits you perfectly?'),
    anchorHint: (g) => (g.group === 'tops' ? 'Think of one you own right now.'
      : g.group === 'other' ? 'Think of something you own right now.' : 'Think of a pair you own right now.'),
    fitQuestion: (g) => `How do you like your ${g.many} to fit?`,
    zoneHint: (g) => (g.id === 'other' ? 'Pick any that apply — it’s about the clothes, not you.'
      : `With ${g.many}, pick any that apply — it’s about the clothes, not you.`),
    anchorLabel: (g) => (g.id === 'other' ? 'Something that fits' : plural(g) ? `${g.label} that fit` : `A ${g.one} that fits`),
    fitLabel: (g) => `How you like ${g.id === 'other' ? 'it' : g.many} to fit`,
    nothing: (g) => `Answer at least one question about ${g.id === 'other' ? 'it' : `your ${g.many}`} to save.`
  };

  /* The fit cards' pictures: a top for tops and anything else, a pair of
     trousers for bottoms. */
  const TOP_ART = {
    slim: ['M19 9 L12 13.5 L14.5 19 L17.5 17.5 V40 H30.5 V17.5 L33.5 19 L36 13.5 L29 9 C27 11.5 21 11.5 19 9 Z'],
    'true-to-size': ['M17 9 L9 14 L12 20 L15 18.5 V40 H33 V18.5 L36 20 L39 14 L31 9 C29 12 19 12 17 9 Z'],
    oversized: ['M15 8 L5 15.5 L9 22.5 L13 20 V42 H35 V20 L39 22.5 L43 15.5 L33 8 C30 11.5 18 11.5 15 8 Z']
  };
  const BOTTOM_ART = {
    slim: ['M18 8 H30 L30.5 41 H25.5 L24 18.5 L22.5 41 H17.5 Z', 'M18 12 H30'],
    'true-to-size': ['M16 8 H32 L33.5 41 H26 L24 18.5 L22 41 H14.5 Z', 'M16 12 H32'],
    oversized: ['M14 8 H34 L38 41 H27.5 L24 19 L20.5 41 H10 Z', 'M14 12 H34']
  };

  /* ---------- the questions, for the type chosen ---------- */

  const option = (value, text) => new Option(text, value);

  function optionGroup(label, values) {
    const group = doc.createElement('optgroup');
    group.label = label;
    values.forEach((v) => group.append(option(v, v)));
    return group;
  }

  function zoneRow(zone) {
    const label = doc.createElement('label');
    label.className = 'zone';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.name = 'troubleZones';
    input.value = zone.id;
    const text = doc.createElement('span');
    text.textContent = zone.label;
    label.append(input, text);
    return label;
  }

  function render(g) {
    form.dataset.garment = g.id;
    $('anchor-question').textContent = words.anchorQuestion(g);
    $('anchor-hint').textContent = words.anchorHint(g);

    brand.replaceChildren(option('', 'Choose'), ...Schema.brandsFor(g.id).map((b) => option(b, b)), option('other', 'Other brand'));

    const sizes = Schema.sizesFor(g.id);
    $('anchor-size-label').textContent = g.sizes === 'waist' ? 'Waist' : 'Size';
    const sizeOptions = [option('', 'Choose')];
    if (sizes.waist && sizes.letter) sizeOptions.push(optionGroup('Waist', sizes.waist), optionGroup('Letter size', sizes.letter));
    else (sizes.waist || sizes.letter).forEach((s) => sizeOptions.push(option(s, s)));
    sizeOptions.push(option('not-sure', 'Not sure'));
    size.replaceChildren(...sizeOptions);
    length.replaceChildren(option('', 'Choose'), ...(sizes.lengths || []).map((l) => option(l, l)), option('not-sure', 'Not sure'));

    $('fit-question').textContent = words.fitQuestion(g);
    const art = g.group === 'trousers' || g.group === 'sweatpants' ? BOTTOM_ART : TOP_ART;
    Schema.FIT_GOALS.forEach((goal) => {
      const card = form.querySelector(`input[name="fitGoal"][value="${goal.id}"]`).closest('.fit-card');
      card.querySelector('.fit-card-title').textContent = goal.label;
      card.querySelector('.fit-card-hint').textContent = goal.hint[g.group];
      card.querySelector('.fit-card-art').innerHTML = art[goal.id].map((d) => `<path d="${d}"/>`).join('');
    });

    zoneItems.replaceChildren(...Schema.zonesFor(g.id).map(zoneRow));
    $('zone-hint').textContent = words.zoneHint(g);
  }

  /* ---------- a type's answers on screen, and set aside ---------- */

  const BLANK = () => ({ name: '', brand: '', other: '', size: '', length: '', goal: '', zones: [], none: false });

  function readDraft() {
    const goal = form.querySelector('input[name="fitGoal"]:checked');
    return {
      name: garmentName.value,
      brand: brand.value,
      other: other.value,
      size: size.value,
      length: length.value,
      goal: goal ? goal.value : '',
      zones: zones().filter((z) => z.checked).map((z) => z.value),
      none: none.checked
    };
  }

  const isBlank = (d) => !d.name.trim() && !d.brand && !d.other.trim() && !d.size && !d.length && !d.goal && !d.zones.length && !d.none;

  /* What is saved for a type, as the form shows it. */
  function draftFromSaved(g, entry) {
    const d = BLANK();
    if (!entry) return d;
    d.name = entry.name || '';
    const a = entry.anchor;
    if (a && (a.brand || a.size || a.length)) {
      if (a.brand && Schema.brandsFor(g.id).includes(a.brand)) d.brand = a.brand;
      else if (a.brand) { d.brand = 'other'; d.other = a.brand; }
      d.size = a.size || 'not-sure';
      d.length = a.length || '';
    }
    d.goal = entry.fitGoal || '';
    if (Array.isArray(entry.troubleZones)) {
      d.zones = entry.troubleZones.slice();
      d.none = entry.troubleZones.length === 0;
    }
    return d;
  }

  /* A size saved from somewhere that offers more than these lists is
     shown as itself, so saving again cannot quietly drop it. */
  function ensureOption(select, value) {
    if (!value || Array.from(select.options).some((o) => o.value === value)) return;
    select.insertBefore(option(value, value), select.querySelector('option[value="not-sure"]'));
  }

  function applyDraft(d) {
    garmentName.value = d.name;
    brand.value = d.brand;
    other.value = d.other;
    ensureOption(size, d.size);
    size.value = d.size;
    ensureOption(length, d.length);
    length.value = d.length;
    form.querySelectorAll('input[name="fitGoal"]').forEach((r) => { r.checked = r.value === d.goal; });
    zones().forEach((z) => { z.checked = d.zones.includes(z.value); });
    none.checked = d.none;
  }

  /* Puts the type on screen aside, and brings this one's own answers. */
  function selectGarment(id) {
    if (id === garment) return;
    if (garment) drafts[garment] = readDraft();
    garment = id;
    const g = current();
    render(g);
    applyDraft(drafts[id] || draftFromSaved(g, saved[id]));
    paint();
  }

  /* ---------- reading the answers ---------- */

  const lengthShown = () => {
    const g = current();
    return Boolean(g && g.lengths && (g.sizes === 'waist' || Schema.isWaistSize(size.value)));
  };

  /* Only what was answered, for the type on screen. A field left out
     keeps its saved value on the server; that is what makes a skipped
     step safe. */
  function answers() {
    const out = {};
    const g = current();
    if (!g) return out;

    const chosenBrand = brand.value === 'other' ? (other.value.trim() || null) : (brand.value || null);
    const chosenSize = size.value && size.value !== 'not-sure' ? size.value : null;
    const chosenLength = lengthShown() && length.value && length.value !== 'not-sure' ? length.value : null;
    if (chosenBrand || chosenSize || chosenLength) {
      out.anchor = { brand: chosenBrand, size: chosenSize };
      if (g.lengths) out.anchor.length = chosenLength;
    }

    const goal = form.querySelector('input[name="fitGoal"]:checked');
    if (goal) out.fitGoal = goal.value;

    /* what "Something else" is: a label beside the answers, sent as
       it stands so clearing the box clears it */
    if (g.named) out.name = garmentName.value.trim() || null;

    const picked = zones().filter((z) => z.checked).map((z) => z.value);
    if (picked.length) out.troubleZones = picked;
    else if (none.checked) out.troubleZones = [];

    return out;
  }

  const answered = (n) => {
    if (n === 1) return Boolean(garment);
    const a = answers();
    return n === 2 ? Boolean(a.anchor) : n === 3 ? Boolean(a.fitGoal) : Array.isArray(a.troubleZones);
  };

  /* ---------- showing a step ---------- */

  function paint() {
    steps.forEach((fieldset) => { fieldset.hidden = Number(fieldset.dataset.step) !== step; });
    $('guide-count').textContent = `Step ${step} of ${LAST}`;
    $('guide-bar-fill').style.width = `${(step / LAST) * 100}%`;
    garmentNameField.hidden = !(current() && current().named);
    back.hidden = step === 1;
    next.textContent = step === 1 ? 'Continue' : step === LAST ? 'Save' : (answered(step) ? 'Continue' : 'Skip');
    otherField.hidden = brand.value !== 'other';
    lengthField.hidden = !lengthShown();
    /* what is already saved is said where the type is chosen */
    $('guide-saved-note').hidden = !(step === 1 && Object.keys(saved).length);
    $('guide-legacy-note').hidden = !(step === 1 && legacy);
  }

  /* "Saved" on each type that has answers on the server. */
  function paintSaved() {
    garmentRadios().forEach((radio) => {
      const mark = radio.closest('.garment-card').querySelector('.garment-saved');
      if (mark) mark.hidden = !saved[radio.value];
    });
  }

  function goTo(n, options) {
    step = Math.min(Math.max(n, 1), LAST);
    error.textContent = '';
    paint();
    /* the question, said and in view, without scrolling the page away
       from it */
    if (!(options && options.quiet)) {
      const heading = steps[step - 1].querySelector('.guide-question');
      if (heading) heading.focus({ preventScroll: true });
    }
  }

  /* One panel of the card at a time: the questions, the account, or the
     confirmation. */
  function showPanel(which, focus) {
    form.hidden = which !== 'questions';
    accountForm.hidden = which !== 'account';
    done.hidden = which !== 'done';
    const heading = which === 'account' ? $('guide-account-title') : which === 'done' ? $('guide-done-title') : null;
    if (heading && focus !== false) heading.focus({ preventScroll: true });
    if (heading) heading.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- the confirmation ---------- */

  function summarise(id, entry) {
    const g = Schema.garmentOf(id);
    const list = $('guide-summary');
    list.innerHTML = '';
    const add = (label, value) => {
      const item = doc.createElement('li');
      const name = doc.createElement('span');
      name.className = 'guide-summary-label';
      name.textContent = label;
      const said = doc.createElement('span');
      said.className = 'guide-summary-value';
      said.textContent = value;
      item.append(name, said);
      list.append(item);
    };
    const said = Schema.describeGarment(id, entry);
    add('Type of clothing', said.garment);
    add(words.anchorLabel(g), said.anchor);
    add(words.fitLabel(g), said.fitGoal);
    add('What gets the fit wrong', said.troubleZones);
  }

  /* ---------- saving ---------- */

  const signedIn = () => {
    const state = global.Account && global.Account.state();
    return Boolean(state && state.signedIn);
  };

  function failure(result, fallback) {
    if (result.unreachable) return 'Fynd could not be reached. Check your connection and try again.';
    return (result.data && result.data.error) || fallback;
  }

  async function save() {
    if (busy) return;
    if (!global.Account || !global.Account.fitProfile) {
      error.textContent = 'This page did not load completely. Reload it to try again — your answers are still here until you do.';
      return;
    }
    const g = current();
    if (!g) {
      goTo(1);
      error.textContent = 'Pick a type of clothing to start.';
      return;
    }
    const sending = answers();
    /* a type with nothing said is not kept — a name alone is a label,
       not an answer — so there is nothing to save, and no account to
       make for it */
    if (!['anchor', 'fitGoal', 'troubleZones'].some((k) => k in sending) && !saved[garment]) {
      error.textContent = words.nothing(g);
      return;
    }
    if (!signedIn()) {
      showPanel('account');
      return;
    }

    busy = true;
    next.disabled = true;
    next.textContent = 'Saving…';
    error.textContent = '';
    const result = await global.Account.fitProfile.answerGuide({ garments: { [garment]: sending } });
    busy = false;
    next.disabled = false;

    if (result.ok && result.data && result.data.saved) {
      saved = (result.data.profile && result.data.profile.garments) || {};
      paintSaved();
      summarise(garment, saved[garment]);
      showPanel('done');
      return;
    }

    /* the session ended somewhere along the way: sign in again, and the
       answers are still here to save */
    if (result.status === 401) {
      setAccountMode('login');
      showPanel('account');
      $('guide-account-error').textContent = 'You are signed out, so nothing was saved yet. Sign in to save your answers.';
      return;
    }

    showPanel('questions', false);
    goTo(LAST, { quiet: true });
    next.textContent = 'Try again';
    error.textContent = `Your fit profile was not saved. ${failure(result, 'Try again in a moment.')} Your answers are still here.`;
    next.focus();
  }

  /* ---------- the account, at the end, when signed out ---------- */

  function setAccountMode(mode) {
    accountMode = mode;
    const signup = mode === 'signup';
    $('guide-field-name').hidden = !signup;
    $('guide-field-confirm').hidden = !signup;
    $('guide-account-intro').textContent = signup
      ? 'Create a free account to keep your answers. Only you can see them.'
      : 'Sign in, and your answers are saved to your fit profile.';
    $('guide-account-submit').textContent = signup ? 'Create account and save' : 'Sign in and save';
    $('guide-switch-text').textContent = signup ? 'Already have an account?' : 'New to Fynd?';
    $('guide-switch').textContent = signup ? 'Sign in' : 'Create an account';
    $('guide-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('guide-account-error').textContent = '';
  }

  async function submitAccount() {
    if (busy) return;
    const say = (text) => { $('guide-account-error').textContent = text; };
    const value = (id) => $(id).value;
    say('');

    if (!value('guide-email').trim()) return say('Enter your email address.');
    if (accountMode === 'signup') {
      if (!value('guide-name').trim()) return say('Tell us what to call you.');
      if (value('guide-password').length < 10) return say('Use at least 10 characters for your password.');
      if (value('guide-password') !== value('guide-confirm')) return say('Those passwords do not match.');
    } else if (!value('guide-password')) {
      return say('Enter your password.');
    }

    const submit = $('guide-account-submit');
    const label = submit.textContent;
    busy = true;
    submit.disabled = true;
    submit.textContent = accountMode === 'signup' ? 'Creating your account…' : 'Signing in…';

    const result = accountMode === 'signup'
      ? await global.Account.signup({
        name: value('guide-name'),
        email: value('guide-email'),
        password: value('guide-password'),
        confirmPassword: value('guide-confirm')
      })
      : await global.Account.login(value('guide-email'), value('guide-password'));

    busy = false;
    submit.disabled = false;
    submit.textContent = label;

    if (!result.ok) {
      if (result.status === 409 && accountMode === 'signup') {
        setAccountMode('login');
        return say('There is already an account for that address. Sign in to save your answers.');
      }
      return say(failure(result, 'That did not work. Try again in a moment.'));
    }

    /* passwords do not stay in the page a moment longer than needed */
    $('guide-password').value = '';
    $('guide-confirm').value = '';
    showPanel('questions', false);
    goTo(LAST, { quiet: true });
    await save();
  }

  /* ---------- wiring ---------- */

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (step === 1 && !garment) {
      error.textContent = 'Pick a type of clothing to start.';
      garmentRadios()[0].focus();
      return;
    }
    if (step < LAST) goTo(step + 1);
    else save();
  });

  back.addEventListener('click', () => goTo(step - 1));

  form.addEventListener('change', (event) => {
    const target = event.target;
    if (target.name === 'garment') selectGarment(target.value);
    if (target === brand) {
      otherField.hidden = brand.value !== 'other';
      if (brand.value === 'other') other.focus();
    }
    /* a length goes with a waist, never with a letter size */
    if (target === size && !lengthShown()) length.value = '';
    /* "None of these" and a trouble spot cannot both be true */
    if (target === none && none.checked) zones().forEach((z) => { z.checked = false; });
    if (target.name === 'troubleZones' && target.checked) none.checked = false;
    error.textContent = '';
    paint();
  });
  other.addEventListener('input', paint);

  accountForm.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAccount();
  });
  $('guide-switch').addEventListener('click', () => setAccountMode(accountMode === 'signup' ? 'login' : 'signup'));
  $('guide-account-back').addEventListener('click', () => {
    showPanel('questions', false);
    goTo(LAST);
  });

  /* Google: a full-page trip that ends on the account page. Nothing is
     saved first and nothing claims to be — the note beside the button
     says the answers will need tapping through again. */
  $('guide-google-button').addEventListener('click', () => {
    global.location.href = global.Account.googleStartUrl();
  });

  $('guide-edit').addEventListener('click', () => {
    showPanel('questions', false);
    goTo(2);
  });

  /* Another type: the one just saved is put aside as saved, and step 1
     starts with nothing chosen. */
  $('guide-another').addEventListener('click', () => {
    delete drafts[garment];
    garment = null;
    garmentRadios().forEach((radio) => { radio.checked = false; });
    showPanel('questions', false);
    goTo(1);
  });

  /* ---------- start ---------- */

  async function start() {
    setAccountMode('signup');
    $('guide-brands').replaceChildren(...Schema.BRAND_SUGGESTIONS.map((b) => option(b, '')));
    /* a type already chosen (the browser restoring the form) is shown */
    const restored = garmentRadios().find((r) => r.checked);
    if (restored) selectGarment(restored.value);
    paint();

    if (global.Account) {
      await global.Account.load();
      const state = global.Account.state();
      $('guide-google').hidden = !(state && state.accounts && state.accounts.google);
      /* Signed in: each type with saved answers is marked, and choosing
         it fills them in, so finishing again changes only what is
         changed. A profile that cannot be read is no reason to stop —
         the server merges, so saving can never drop what it holds. */
      if (signedIn() && global.Account.fitProfile) {
        const read = await global.Account.fitProfile.read();
        const profile = read.ok && read.data && read.data.profile;
        if (profile) {
          saved = profile.garments || {};
          legacy = Schema.hasLegacyGuide(profile);
          paintSaved();
          /* chosen while the profile was on its way, and not yet touched */
          if (garment && saved[garment] && !drafts[garment] && isBlank(readDraft())) {
            applyDraft(draftFromSaved(current(), saved[garment]));
          }
          paint();
        }
      }
    }
    root.dataset.ready = 'true';
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
