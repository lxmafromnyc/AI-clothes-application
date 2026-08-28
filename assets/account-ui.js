/* =========================================================
   Fynd — the account page

   Signed out, it asks one question with two answers: Google, or email.
   Signed in, it shows the account and gets out of the way.

   ---------------------------------------------------------
   What this file is allowed to decide
   ---------------------------------------------------------
   Which panel is on screen, and what the copy says. Nothing else.

   Whether somebody is signed in, whether their address is verified,
   what plan they are on and what they have used all arrive from
   /api/account, which read them from the server's own store. Editing
   anything here — in the console, in a copy of the file, in an
   extension — changes what this page draws and changes nothing about
   what the account is. `signedIn = true` in a debugger renders a
   dashboard with no data in it, because the data was never here.

   Passwords exist for the length of one submit handler and are never
   copied, stored or logged. Nothing is written to localStorage.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc || doc.body.dataset.page !== 'account') return;

  const $ = (id) => doc.getElementById(id);
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- one place for every message on the page ---------- */

  function note(id, text, tone) {
    const el = $(id);
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.className = `billing-note${tone ? ` billing-note--${tone}` : ''}`;
    el.textContent = text;
    el.hidden = false;
  }

  function fieldError(text) {
    const el = $('auth-error');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('show', Boolean(text));
  }

  /* What the browser was told on the way back from an email link or
     from Google. Read once, then wiped out of the URL so a reload does
     not replay it and a bookmark does not keep it. */
  function landing() {
    const params = new URLSearchParams(global.location.search || '');
    const read = {
      verify: params.get('verify'),
      auth: params.get('auth'),
      reason: params.get('reason'),
      reset: params.get('reset')
    };
    if (read.verify || read.auth || read.reset) {
      const clean = global.location.pathname + (params.get('checkout') ? `?checkout=${params.get('checkout')}` : '');
      global.history.replaceState({}, '', clean);
    }
    return read;
  }

  const ARRIVAL = landing();

  /* A reset token is held here and nowhere else: never in the URL after
     the line above, never in storage, never in a form's markup. */
  let resetToken = ARRIVAL.reset || null;

  const VERIFY_MESSAGE = {
    success: ['Your email is confirmed. Sign in and everything is ready.', 'good'],
    already: ['That address was already confirmed. You can sign in.', null],
    expired: ['That confirmation link has expired. Sign in and send yourself a new one.', 'warn'],
    invalid: ['That confirmation link is not valid — it may already have been used. Sign in and send yourself a new one.', 'warn'],
    'address-changed': ['That link was for a different address than the account now uses.', 'warn'],
    'accounts-not-configured': ['Accounts are not configured on this deployment yet.', 'warn'],
    'server-error': ['Something went wrong confirming that link. Try it again.', 'warn']
  };

  const GOOGLE_MESSAGE = {
    cancelled: ['Google sign-in was cancelled. Nothing has changed.', null],
    'state-mismatch': ['That sign-in could not be verified, so it was stopped. Please start again.', 'warn'],
    'sign-in-expired': ['That sign-in took too long and expired. Please start again.', 'warn'],
    'verification-failed': ['Google’s response could not be verified, so the sign-in was refused.', 'warn'],
    'google-refused': ['Google refused the sign-in. Please try again.', 'warn'],
    'google-email-unverified': ['Google has not confirmed that email address, so it cannot be used to sign in to an existing Fynd account.', 'warn'],
    'google-not-configured': ['Google sign-in is not configured on this deployment yet.', 'warn'],
    'accounts-not-configured': ['Accounts are not configured on this deployment yet.', 'warn'],
    'incomplete-callback': ['That sign-in did not complete. Please start again.', 'warn'],
    'could-not-start': ['Google sign-in could not be started. Please try again.', 'warn'],
    'could-not-sign-in': ['Something went wrong signing you in. Please try again.', 'warn'],
    'could-not-create-account': ['Your Google account could not be connected. Please try again.', 'warn']
  };

  function announceArrival() {
    if (ARRIVAL.verify) {
      const [text, tone] = VERIFY_MESSAGE[ARRIVAL.verify === 'error' ? (ARRIVAL.reason || 'invalid') : ARRIVAL.verify]
        || VERIFY_MESSAGE.invalid;
      note('auth-note', text, tone);
      return;
    }
    if (ARRIVAL.auth === 'error') {
      const [text, tone] = GOOGLE_MESSAGE[ARRIVAL.reason] || ['That sign-in did not finish. Please try again.', 'warn'];
      note('auth-note', text, tone);
    }
  }

  /* ---------- the panels ----------
     Exactly one of these is on screen at a time. `choose` is the front
     door: two buttons and nothing else, so the first thing anybody sees
     is a decision they can make rather than a form they have to read. */

  const PANELS = ['panel-choose', 'panel-email', 'panel-reset', 'panel-account'];

  let panel = 'panel-choose';

  function showPanel(name) {
    panel = name;
    PANELS.forEach((id) => show(id, id === name));
  }

  /* ---------- the email form ---------- */

  let mode = 'login';

  const MODE = {
    login: {
      title: 'Sign in',
      intro: 'Welcome back.',
      submit: 'Sign in',
      switchText: 'New to Fynd?',
      switchAction: 'Create an account',
      autocomplete: 'current-password',
      placeholder: 'Your password'
    },
    signup: {
      title: 'Create your account',
      intro: 'Card details are only ever typed on Stripe, never here.',
      submit: 'Create account',
      switchText: 'Already have an account?',
      switchAction: 'Sign in',
      autocomplete: 'new-password',
      placeholder: 'At least 10 characters'
    }
  };

  function paintMode() {
    const copy = MODE[mode];
    const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
    set('auth-title', copy.title);
    set('auth-intro', copy.intro);
    set('auth-submit', copy.submit);
    set('auth-switch-text', copy.switchText);
    set('auth-switch', copy.switchAction);

    /* Name and confirmation are only asked for when creating an
       account. Signing in is two fields, because that is all it needs. */
    show('field-name', mode === 'signup');
    show('field-confirm', mode === 'signup');
    show('forgot-row', mode === 'login');

    const password = $('auth-password');
    if (password) {
      password.setAttribute('autocomplete', copy.autocomplete);
      password.setAttribute('placeholder', copy.placeholder);
    }
    ['auth-name', 'auth-confirm'].forEach((id) => {
      const el = $(id);
      if (el) el.required = mode === 'signup';
    });
    fieldError('');
  }

  const busy = (button, on, label) => {
    if (!button) return;
    button.disabled = on;
    if (on) {
      button.dataset.label = button.textContent;
      button.textContent = label || 'One moment…';
    } else if (button.dataset.label) {
      button.textContent = button.dataset.label;
    }
  };

  /* ---------- the signed-in view ---------- */

  const VERIFICATION_UNSENT = {
    'no-provider': 'No email provider is configured on this deployment, so the confirmation email could not be sent. Until one is set up, accounts cannot be confirmed.',
    'no-from-address': 'This deployment has an email provider but no sender address, so the confirmation email could not be sent.',
    'provider-refused': 'The email provider refused to send the confirmation email. Try again in a moment.',
    'provider-unreachable': 'The email provider could not be reached, so the confirmation email has not gone out yet.',
    'already-verified': 'That address is already confirmed.'
  };

  function verificationBanner(state) {
    if (!state || !state.signedIn) return;

    if (state.emailVerified) {
      note('verify-note', '', null);
      return;
    }

    const provider = state.accounts && state.accounts.email;
    if (provider && !provider.configured) {
      note('verify-note',
        'Your email address is not confirmed yet, and this deployment has no email provider configured — so no confirmation link can be sent. Subscribing stays unavailable until an address is confirmed.',
        'warn');
      const resend = $('resend-button');
      if (resend) resend.disabled = true;
      return;
    }

    note('verify-note',
      'Confirm your email address to finish setting up your account. Subscribing needs a confirmed address, because that is where the receipt goes.',
      'warn');
  }

  function identityRows(state) {
    const wrap = $('account-identity');
    if (!wrap) return;

    const user = state.user || {};
    const verified = state.emailVerified;
    const methods = (user.signInMethods || []).map((m) => (m === 'google' ? 'Google' : 'Password')).join(' and ');

    wrap.innerHTML = `
      <div class="detail-row">
        <span class="detail-label">Signed in as</span>
        <span class="detail-value">${esc(user.email || '')}</span>
      </div>
      ${user.name ? `<div class="detail-row">
        <span class="detail-label">Name</span>
        <span class="detail-value">${esc(user.name)}</span>
      </div>` : ''}
      <div class="detail-row">
        <span class="detail-label">Email status</span>
        <span class="detail-value">
          <span class="status ${verified ? 'status--live' : 'status--sample'}">${verified ? 'Confirmed' : 'Not confirmed'}</span>
        </span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Sign in with</span>
        <span class="detail-value">${esc(methods || 'Password')}</span>
      </div>`;

    show('resend-row', !verified);
  }

  /* ---------- drawing ---------- */

  function draw(state) {
    /* No API at all: say so rather than showing controls that cannot
       work. This is the GitHub Pages copy with no functions behind it. */
    if (!state) {
      showPanel('panel-choose');
      note('auth-note', 'Accounts are not connected to this copy of the site, so signing in is unavailable here.', 'warn');
      ['google-button', 'email-button'].forEach((id) => { const el = $(id); if (el) el.disabled = true; });
      return;
    }

    const accounts = state.accounts || {};

    if (state.signedIn) {
      showPanel('panel-account');
      identityRows(state);
      verificationBanner(state);
      return;
    }

    /* A reset link takes priority over everything else on the page:
       somebody who followed one is here to do one thing. */
    if (resetToken) {
      showPanel('panel-reset');
      return;
    }

    if (panel === 'panel-account') showPanel('panel-choose');

    /* Google is offered only where it can actually work. */
    const googleButton = $('google-button');
    if (googleButton) {
      googleButton.hidden = !accounts.google;
      googleButton.disabled = !accounts.google;
    }
    show('google-unavailable', accounts.enabled && !accounts.google);

    if (!accounts.enabled) {
      note('auth-note', 'Accounts are not configured on this deployment yet, so signing in is unavailable.', 'warn');
      ['google-button', 'email-button'].forEach((id) => { const el = $(id); if (el) el.disabled = true; });
      const submit = $('auth-submit');
      if (submit) submit.disabled = true;
    }
  }

  /* ---------- wiring ---------- */

  function wire() {
    const googleButton = $('google-button');
    if (googleButton) {
      googleButton.addEventListener('click', () => {
        /* A full-page navigation to our own endpoint, which redirects
           to Google. Not a popup and not an iframe: the person should
           see accounts.google.com in the address bar, because that is
           the only way they can tell it is really Google. */
        global.location.href = global.Account.googleStartUrl();
      });
    }

    const emailButton = $('email-button');
    if (emailButton) {
      emailButton.addEventListener('click', () => {
        showPanel('panel-email');
        paintMode();
        const field = $('auth-email');
        if (field) field.focus();
      });
    }

    doc.querySelectorAll('[data-back]').forEach((button) => {
      button.addEventListener('click', () => {
        resetToken = null;
        note('auth-note', '', null);
        showPanel('panel-choose');
      });
    });

    const toggle = $('auth-switch');
    if (toggle) {
      toggle.addEventListener('click', () => {
        mode = mode === 'login' ? 'signup' : 'login';
        paintMode();
      });
    }

    /* ---- create account / sign in ---- */
    const form = $('auth-form');
    if (form) {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        fieldError('');
        note('auth-note', '', null);

        const value = (id) => (($(id) || {}).value || '');
        const submit = $('auth-submit');

        /* Checked here for the sake of a fast, clear message. The
           server checks all of it again and is the one that decides —
           this is a courtesy, not a gate. */
        if (mode === 'signup') {
          if (!value('auth-name').trim()) return fieldError('Tell us what to call you.');
          if (value('auth-password').length < 10) return fieldError('Use at least 10 characters for your password.');
          if (value('auth-password') !== value('auth-confirm')) return fieldError('Those passwords do not match.');
        }

        busy(submit, true);
        const result = mode === 'signup'
          ? await global.Account.signup({
            name: value('auth-name'),
            email: value('auth-email'),
            password: value('auth-password'),
            confirmPassword: value('auth-confirm')
          })
          : await global.Account.login(value('auth-email'), value('auth-password'));
        busy(submit, false);

        if (result.ok) {
          /* the password field is cleared the moment it is no longer
             needed, so it is not sitting in the DOM afterwards */
          ['auth-password', 'auth-confirm'].forEach((id) => { const el = $(id); if (el) el.value = ''; });

          const verification = result.data && result.data.verification;
          if (verification && !verification.sent && verification.reason) {
            note('account-note', VERIFICATION_UNSENT[verification.reason] || 'The confirmation email could not be sent.', 'warn');
          } else if (result.data && result.data.created) {
            note('account-note', `Check ${value('auth-email')} for a link to confirm your address.`, 'good');
          }
          return;
        }

        fieldError((result.data && result.data.error)
          || (result.unreachable ? 'Could not reach the server. Try again in a moment.' : 'That did not work.'));
      });
    }

    /* ---- forgot password ---- */
    const forgot = $('forgot-button');
    if (forgot) {
      forgot.addEventListener('click', async () => {
        const address = (($('auth-email') || {}).value || '').trim();
        if (!address) return fieldError('Type your email address first, then press this.');

        busy(forgot, true, 'Sending…');
        const result = await global.Account.forgotPassword(address);
        busy(forgot, false);

        /* Deliberately the same message whether or not an account
           exists. The page does not know, and must not appear to. */
        if (result.data && result.data.emailConfigured === false) {
          note('auth-note', 'Password reset is unavailable: this deployment has no email provider configured.', 'warn');
          return;
        }
        note('auth-note', (result.data && result.data.message)
          || 'If there is a Fynd account for that address, a reset link is on its way.', 'good');
      });
    }

    /* ---- choose a new password ---- */
    const resetForm = $('reset-form');
    if (resetForm) {
      resetForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const el = $('reset-error');
        if (el) { el.textContent = ''; el.classList.remove('show'); }

        const password = (($('reset-password') || {}).value || '');
        const confirm = (($('reset-confirm') || {}).value || '');
        const submit = $('reset-submit');

        const fail = (message) => {
          if (el) { el.textContent = message; el.classList.add('show'); }
        };
        if (password.length < 10) return fail('Use at least 10 characters for your password.');
        if (password !== confirm) return fail('Those passwords do not match.');

        busy(submit, true);
        const result = await global.Account.resetPassword({ token: resetToken, password, confirmPassword: confirm });
        busy(submit, false);

        ['reset-password', 'reset-confirm'].forEach((id) => { const f = $(id); if (f) f.value = ''; });

        if (result.ok) {
          resetToken = null;
          note('account-note', 'Your password is changed, and you are signed in. Any other devices have been signed out.', 'good');
          return;
        }
        fail((result.data && result.data.error) || 'That did not work.');
      });
    }

    /* ---- resend the confirmation email ---- */
    const resend = $('resend-button');
    if (resend) {
      resend.addEventListener('click', async () => {
        busy(resend, true, 'Sending…');
        const result = await global.Account.resendVerification();
        busy(resend, false);

        if (result.ok) {
          const verification = result.data && result.data.verification;
          if (verification && verification.sent) {
            note('account-note', 'Sent. Check your inbox for the confirmation link.', 'good');
          } else {
            note('account-note',
              VERIFICATION_UNSENT[(verification && verification.reason) || ''] || 'The confirmation email could not be sent.',
              'warn');
          }
          return;
        }
        note('account-note', (result.data && result.data.error) || 'That did not work. Try again in a moment.', 'warn');
      });
    }

    /* ---- log out ---- */
    const signOut = $('signout-button');
    if (signOut) {
      signOut.addEventListener('click', async () => {
        busy(signOut, true, 'Signing out…');
        const result = await global.Account.logout();
        busy(signOut, false);

        /* Only claim it if it happened. Navigating away regardless would
           show the signed-out page while the session was still alive,
           which is the one thing a log-out button must never do. */
        if (!result.ok) {
          note('account-note', (result.data && result.data.error)
            || 'Could not sign you out. Try again in a moment.', 'warn');
          return;
        }
        global.location.href = 'account.html';
      });
    }
  }

  /* ---------- start ---------- */

  async function start() {
    wire();
    paintMode();
    announceArrival();

    if (!global.Account) return draw(null);

    global.Account.subscribe((state) => {
      draw(state);
      if (global.BillingUI) global.BillingUI.draw(state);
    });

    await global.Account.load();
    const state = global.Account.state();
    draw(state);
    if (global.BillingUI) {
      global.BillingUI.draw(state);
      await global.BillingUI.handleReturn(state);
    }
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  global.AccountUI = { draw, showPanel, note };
})(typeof window !== 'undefined' ? window : globalThis);
