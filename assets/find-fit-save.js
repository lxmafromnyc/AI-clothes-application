/* =========================================================
   Fynd — Find Fit: save this visit's garment, if the shopper wants to

   Offered only after a comparison has been tried with a garment
   described on Find Fit (FindFitReference.current()), beneath the
   result — never in its place, and never before. Every step is the
   shopper's choice:

     offer     signed out: "Save this garment for next time?" — Sign in
               to save, or Not now
     auth      signing in, or making a free account, right here
               (Account.login / Account.signup), so the page — the
               result and the garment — stays as it is
     confirm   signed in: the garment named, and whether it replaces one
               saved of the same kind — Save to my fit profile, or Not
               now. Signing in never saves anything by itself.
     saved     saved to the fit profile with the profile's own save
               (Account.fitProfile.answerGuide: that type only, the
               rest of the profile kept as it is)

   "Not now" closes the prompt and leaves the result; it isn't offered
   again for the same garment this visit. Who can read a saved profile:
   only its owner's signed-in session (api/fit-profile.js), which is
   what the prompt says.

     FindFitSave.offer()   after a comparison attempt
     FindFitSave.hide()    when a new one starts
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  const box = doc && doc.getElementById('ff-save');
  const Schema = global.FitProfileSchema;
  if (!box || !global.SizeChart || !Schema) return;
  const { el } = global.SizeChart;
  const DECLINED = 'fynd:find-fit:save-declined';

  const signature = (ref) => JSON.stringify(ref);
  function declined(ref) {
    try { return global.sessionStorage.getItem(DECLINED) === signature(ref); } catch (err) { return false; }
  }
  function decline(ref) {
    try { global.sessionStorage.setItem(DECLINED, signature(ref)); } catch (err) { /* this page only */ }
  }
  const signedIn = () => {
    const s = global.Account && global.Account.state();
    return Boolean(s && s.signedIn);
  };
  const named = (ref) => {
    const a = ref.garment.anchor || {};
    return `${a.brand || 'Your'} ${Schema.garmentOf(ref.type).one}${a.size ? ` in size ${a.size}` : ''}`;
  };

  function button(text, cls, fn) {
    const b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function draw(state, nodes) {
    box.replaceChildren(...nodes);
    box.dataset.state = state;
    box.hidden = false;
  }
  function hide() {
    box.replaceChildren();
    box.hidden = true;
    delete box.dataset.state;
  }
  const privacy = () => el('p', 'ff-save-privacy', 'Only your account can read your fit profile.');

  function notNow(ref) {
    decline(ref);
    hide();
    const title = doc.getElementById('fit-result-title');
    if (title) title.focus({ preventScroll: true });
  }

  /* signed out: the offer */
  function offer(ref) {
    const actions = el('div', 'ff-save-actions');
    actions.append(
      button('Sign in to save', 'btn btn-primary ff-save-signin', () => auth(ref, 'login')),
      button('Not now', 'btn btn-secondary ff-save-dismiss', () => notNow(ref))
    );
    draw('offer', [
      el('h3', 'ff-save-title', 'Save this garment for next time?'),
      el('p', null, 'Sign in to save it to your free fit profile, so you can compare future items against it.'),
      privacy(),
      actions
    ]);
  }

  /* signing in, or a free account, right here */
  function auth(ref, mode) {
    const signup = mode === 'signup';
    const nodes = [el('h3', 'ff-save-title', signup ? 'Create your free fit profile' : 'Sign in to save')];
    const fields = el('div', 'ff-save-fields');
    const field = (id, labelText, type, auto) => {
      const wrap = el('label', 'field');
      wrap.append(el('span', null, labelText));
      const i = el('input');
      i.id = id;
      i.type = type;
      i.autocomplete = auto;
      wrap.append(i);
      fields.append(wrap);
      return i;
    };
    const name = signup ? field('ffs-name', 'Name', 'text', 'name') : null;
    const email = field('ffs-email', 'Email', 'email', 'email');
    const password = field('ffs-password', 'Password', 'password', signup ? 'new-password' : 'current-password');
    const confirm = signup ? field('ffs-confirm', 'Confirm password', 'password', 'new-password') : null;
    const error = el('p', 'form-error');
    error.setAttribute('role', 'alert');
    const say = (t) => { error.textContent = t || ''; error.classList.toggle('show', Boolean(t)); };
    const submit = button(signup ? 'Create account' : 'Sign in', 'btn btn-primary ff-save-submit', async () => {
      say('');
      if (!email.value.trim()) return say('Enter your email address.');
      if (signup) {
        if (!name.value.trim()) return say('Tell us what to call you.');
        if (password.value.length < 10) return say('Use at least 10 characters for your password.');
        if (password.value !== confirm.value) return say('Those passwords do not match.');
      } else if (!password.value) return say('Enter your password.');
      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = signup ? 'Creating your account…' : 'Signing in…';
      const result = signup
        ? await global.Account.signup({ name: name.value, email: email.value, password: password.value, confirmPassword: confirm.value })
        : await global.Account.login(email.value, password.value);
      submit.disabled = false;
      submit.textContent = label;
      if (!result.ok) {
        if (result.status === 409 && signup) { auth(ref, 'login'); return undefined; }
        return say((result.data && result.data.error) || 'That didn’t work. Try again in a moment.');
      }
      /* passwords do not stay in the page a moment longer than needed */
      password.value = '';
      if (confirm) confirm.value = '';
      await global.Account.load();
      if (global.FindFitReference) await global.FindFitReference.refresh();
      return confirmSave(ref);
    });
    /* Enter signs in here, never submits the item's form around it */
    fields.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit.click(); } });
    const actions = el('div', 'ff-save-actions');
    actions.append(submit, button('Not now', 'btn btn-secondary ff-save-dismiss', () => notNow(ref)));
    const swap = el('p', 'ff-save-switch');
    swap.append(doc.createTextNode(signup ? 'Already have an account? ' : 'New to Fynd? '),
      button(signup ? 'Sign in' : 'Create a free account', 'link-btn ff-save-mode', () => auth(ref, signup ? 'login' : 'signup')));
    nodes.push(fields, error, actions, swap, privacy());
    draw('auth', nodes);
    (name || email).focus();
  }

  /* signed in: saving is its own, explicit step */
  function confirmSave(ref) {
    const profile = global.FindFitReference && global.FindFitReference.savedProfile();
    const existing = profile && profile.garments && profile.garments[ref.type];
    const g = Schema.garmentOf(ref.type);
    const nodes = [el('h3', 'ff-save-title', 'Save this garment for next time?'),
      el('p', null, `Save your ${named(ref)} to your free fit profile, so you can compare future items against it.`)];
    if (existing && existing.anchor) {
      const a = existing.anchor;
      nodes.push(el('p', 'ff-save-replace', `This replaces the ${g.one} saved on your fit profile${a.brand ? ` (${[a.brand, a.size].filter(Boolean).join(', ')})` : ''}.`));
    }
    const error = el('p', 'form-error');
    error.setAttribute('role', 'alert');
    const save = button('Save to my fit profile', 'btn btn-primary ff-save-confirm', async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      const got = await global.Account.fitProfile.answerGuide({ garments: { [ref.type]: ref.garment } });
      if (!got.ok) {
        save.disabled = false;
        save.textContent = 'Save to my fit profile';
        error.textContent = (got.data && got.data.error) || 'It couldn’t be saved just now. Try again in a moment.';
        error.classList.add('show');
        return;
      }
      const done = el('p');
      done.append(doc.createTextNode(`Saved your ${named(ref)} to your fit profile. `));
      const view = el('a', 'guide-link', 'View your fit profile');
      view.href = 'fit-profile.html?from=find-fit';
      done.append(view);
      draw('saved', [el('h3', 'ff-save-title', 'Saved'), done]);
      if (global.FindFitReference) {
        global.FindFitReference.forget();
        await global.FindFitReference.refresh();
      }
    });
    const actions = el('div', 'ff-save-actions');
    actions.append(save, button('Not now', 'btn btn-secondary ff-save-dismiss', () => notNow(ref)));
    nodes.push(error, actions, privacy());
    draw('confirm', nodes);
  }

  /* after a comparison attempt: offered when there is a garment from
     this visit, not turned down, and not already the saved one */
  function offerNow() {
    const ref = global.FindFitReference && global.FindFitReference.current();
    if (!ref || declined(ref)) { hide(); return; }
    const profile = global.FindFitReference.savedProfile();
    const same = profile && profile.garments && profile.garments[ref.type];
    if (same && JSON.stringify(same.anchor) === JSON.stringify(ref.garment.anchor)) { hide(); return; }
    if (signedIn()) confirmSave(ref);
    else offer(ref);
  }

  global.FindFitSave = { offer: offerNow, hide };
})(typeof window !== 'undefined' ? window : globalThis);
