/* =========================================================
   Fynd — the fit guide on the home page

   Three short questions, answered with two dropdowns and some taps,
   saved to the shopper's fit profile:

     1  a top they own that fits perfectly    anchor: brand and size
     2  how they like clothes to sit          fitGoal
     3  where clothes usually go wrong        troubleZones

   The words and the allowed values are assets/fit-profile-schema.js's;
   the server checks every answer again (api/fit-profile.js, "guide").

   ---------------------------------------------------------
   Nothing is lost
   ---------------------------------------------------------
   Every step is optional. Continue reads "Skip" until something is
   chosen, and a skipped step is not sent at all — the server keeps
   whatever was saved for it before. Only the guide's three answers
   travel; measurements, usual sizes and per-category fits stay on the
   server as they are. Leaving the page saves and changes nothing.

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
  const otherField = $('anchor-other-field');
  const other = $('anchor-other');
  const none = $('zone-none');
  const zones = () => Array.from(form.querySelectorAll('input[name="troubleZones"]'));

  const back = $('guide-back');
  const next = $('guide-next');
  const error = $('guide-error');

  let step = 1;
  let busy = false;
  /* "signup" or "login", for the account form at the end */
  let accountMode = 'signup';

  /* ---------- reading the answers ---------- */

  /* Only what was answered. A field left out keeps its saved value on
     the server; that is what makes a skipped step safe. */
  function answers() {
    const out = {};

    const chosenBrand = brand.value === 'other' ? (other.value.trim() || null) : (brand.value || null);
    const chosenSize = size.value && size.value !== 'not-sure' ? size.value : null;
    if (chosenBrand || chosenSize) out.anchor = { brand: chosenBrand, size: chosenSize };

    const goal = form.querySelector('input[name="fitGoal"]:checked');
    if (goal) out.fitGoal = goal.value;

    const picked = zones().filter((z) => z.checked).map((z) => z.value);
    if (picked.length) out.troubleZones = picked;
    else if (none.checked) out.troubleZones = [];

    return out;
  }

  const answered = (n) => {
    const a = answers();
    return n === 1 ? Boolean(a.anchor) : n === 2 ? Boolean(a.fitGoal) : Array.isArray(a.troubleZones);
  };

  /* ---------- showing a step ---------- */

  function paint() {
    steps.forEach((fieldset) => { fieldset.hidden = Number(fieldset.dataset.step) !== step; });
    $('guide-count').textContent = `${step} of ${LAST}`;
    form.querySelectorAll('.guide-bar li').forEach((bar, i) => {
      bar.classList.toggle('is-done', i + 1 < step);
      bar.classList.toggle('is-current', i + 1 === step);
    });
    back.hidden = step === 1;
    next.textContent = step === LAST ? 'Save' : (answered(step) ? 'Continue' : 'Skip');
    otherField.hidden = brand.value !== 'other';
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

  /* ---------- filling in what was saved ---------- */

  function fill(profile) {
    if (!profile) return false;
    let any = false;

    const anchor = profile.anchor;
    if (anchor && (anchor.brand || anchor.size)) {
      const listed = anchor.brand && Array.from(brand.options).find((o) => o.value && o.value !== 'other' && o.value === anchor.brand);
      if (listed) brand.value = anchor.brand;
      else if (anchor.brand) { brand.value = 'other'; other.value = anchor.brand; }
      /* a size saved from somewhere that offers more than this list is
         shown as itself, so saving again cannot quietly drop it */
      if (anchor.size && !Array.from(size.options).some((o) => o.value === anchor.size)) {
        size.insertBefore(new Option(anchor.size, anchor.size), size.querySelector('option[value="not-sure"]'));
      }
      size.value = anchor.size || (anchor.brand ? 'not-sure' : '');
      any = true;
    }

    if (profile.fitGoal) {
      const radio = form.querySelector(`input[name="fitGoal"][value="${profile.fitGoal}"]`);
      if (radio) { radio.checked = true; any = true; }
    }

    if (Array.isArray(profile.troubleZones)) {
      zones().forEach((z) => { z.checked = profile.troubleZones.includes(z.value); });
      none.checked = profile.troubleZones.length === 0;
      any = true;
    }
    return any;
  }

  /* ---------- the confirmation ---------- */

  function summarise(profile) {
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
    const said = Schema.describeGuide(profile);
    add('A top that fits', said.anchor);
    add('How you like clothes to sit', said.fitGoal);
    add('Where clothes go wrong', said.troubleZones);
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
    if (!signedIn()) {
      showPanel('account');
      return;
    }

    busy = true;
    next.disabled = true;
    next.textContent = 'Saving…';
    error.textContent = '';
    const result = await global.Account.fitProfile.answerGuide(answers());
    busy = false;
    next.disabled = false;

    if (result.ok && result.data && result.data.saved) {
      summarise(result.data.profile);
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
    if (step < LAST) goTo(step + 1);
    else save();
  });

  back.addEventListener('click', () => goTo(step - 1));

  form.addEventListener('change', (event) => {
    const target = event.target;
    if (target === brand) {
      otherField.hidden = brand.value !== 'other';
      if (brand.value === 'other') other.focus();
    }
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
    goTo(1);
  });

  /* ---------- start ---------- */

  async function start() {
    setAccountMode('signup');
    paint();

    if (global.Account) {
      await global.Account.load();
      const state = global.Account.state();
      $('guide-google').hidden = !(state && state.accounts && state.accounts.google);
      /* signed in: what was saved is filled in, so finishing the guide
         again changes only what is changed. A profile that cannot be
         read is no reason to stop — the server merges, so saving can
         never drop what it holds. */
      if (signedIn() && global.Account.fitProfile) {
        const read = await global.Account.fitProfile.read();
        if (read.ok && read.data && fill(read.data.profile)) {
          $('guide-saved-note').hidden = false;
          paint();
        }
      }
    }
    root.dataset.ready = 'true';
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
