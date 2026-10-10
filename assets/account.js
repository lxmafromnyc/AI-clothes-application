/* =========================================================
   Fynd — the account, as the browser sees it

   One place that talks to /api/account, /api/auth, /api/checkout,
   /api/portal and /api/fit-profile, and one copy of whatever the
   account endpoints last said. The pages read from it; they do not
   each keep their own idea of who is signed in.

   ---------------------------------------------------------
   This file decides nothing
   ---------------------------------------------------------
   It holds no plan, no limit and no entitlement of its own. Everything
   it exposes came down the wire from /api/account, which read it from
   the server's own store. Editing anything here — in the console, in a
   copy of the file, in a browser extension — changes what this page
   draws and changes nothing at all about what the shopper is entitled
   to: /api/search and /api/interpret ask the server, not the page.

   That is the point of the split, so it is worth being blunt about it:
   there is no value you can set in this file that buys anything.

   ---------------------------------------------------------
   Where the endpoints are
   ---------------------------------------------------------
   Beside the page first. A page served by the app itself — `vercel dev`
   on localhost, or the deployment — has /api on its own origin, and the
   session cookie belongs to that origin, so that is the account the
   page must ask about.

   The meta tag (findwear-api) names where the API lives for a copy of
   the pages served WITHOUT one, such as GitHub Pages. It is used only
   when the page's own origin has no account endpoint: a static host
   answers 404 to the GET, or 405 to a POST. Before this order existed,
   every page asked the meta tag's deployment unconditionally, so a page
   running under `vercel dev` ignored the backend right beside it, the
   cross-origin call failed, and the pricing page announced that billing
   was not connected while the local /api/account said it was.

   window.FINDWEAR_API, when set, overrides both — as it always has.

   Requests are sent with credentials, because the session lives in an
   HttpOnly cookie this file cannot read — which is why it cannot leak
   one either.

   ---------------------------------------------------------
   Nothing is kept anywhere a page can be read from
   ---------------------------------------------------------
   No token, no session, no password is written to localStorage,
   sessionStorage or a cookie this script can set. The session is the
   HttpOnly cookie the browser holds and this file never sees. The only
   credential-shaped thing here is the CSRF token, which /api/account
   hands over deliberately and which is worthless without that cookie.

   A password exists in this file for the length of one fetch, in the
   argument to a function, and is never copied anywhere else.
   ========================================================= */

(function (global) {
  'use strict';

  const REQUEST_TIMEOUT = 15000;

  /* Every base worth trying, in order, without repeats. */
  function bases() {
    if (global.FINDWEAR_API) return [String(global.FINDWEAR_API)];
    const loc = global.location;
    const own = loc && /^https?:$/.test(loc.protocol) ? `${loc.origin}/api/interpret` : null;
    const tag = global.document && global.document.querySelector('meta[name="findwear-api"]');
    const meta = tag && tag.getAttribute('content') ? tag.getAttribute('content').trim() : null;
    return [own, meta, '/api/interpret'].filter((b, i, all) => b && all.indexOf(b) === i);
  }

  /* the base that answered, once one has; asked again only on a reload */
  let resolved = null;

  const endpointFrom = (b, name) => b.replace(/\/interpret(\/)?$/, `/${name}`);
  const endpoint = (name) => endpointFrom(resolved || bases()[0], name);

  /* "This origin has no account API", as opposed to an API that answered:
     a static host's 404 for the GET, or its 405 for a POST. */
  const noApiHere = (status) => status === 404 || status === 405;

  /* Where Stripe should send the browser back to. A path, never a URL:
     the server pairs it with an origin it already trusts, so nothing
     here can redirect a shopper somewhere Fynd does not serve. */
  function returnPath(page) {
    const path = global.location ? global.location.pathname : '/';
    const at = path.lastIndexOf('/');
    return `${at >= 0 ? path.slice(0, at) : ''}/${page}`;
  }

  let current = null;
  const listeners = [];

  const notify = () => listeners.forEach((fn) => {
    try { fn(current); } catch (err) { /* one bad listener must not stop the rest */ }
  });

  async function call(name, options) {
    const settings = options || {};
    const headers = settings.body ? { 'Content-Type': 'application/json' } : undefined;

    /* The CSRF token the server handed us, echoed on anything that
       changes something. A page on another origin cannot obtain it: it
       is derived from the HttpOnly session cookie, which that page
       cannot read, and a cross-site form post cannot set a header at
       all. */
    if (headers && current && current.csrfToken) headers['X-Fynd-CSRF'] = current.csrfToken;

    const send = async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      try {
        return await fetch(url, {
          method: settings.body ? 'POST' : 'GET',
          headers,
          credentials: 'include',
          body: settings.body ? JSON.stringify(settings.body) : undefined,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    };

    /* Once a base has answered, it is the only one asked. Until then,
       each is tried in order: the next only when this one has no API at
       all (404/405) or — for a read, which changes nothing — could not
       be reached. A POST that could not be reached is not repeated
       elsewhere, since it may have arrived. */
    const order = resolved ? [resolved] : bases();
    let response = null;
    for (let at = 0; at < order.length; at += 1) {
      const last = at === order.length - 1;
      try {
        response = await send(endpointFrom(order[at], name));
      } catch (err) {
        response = null;
        if (resolved || last || settings.body) break;
        continue;
      }
      if (!resolved && noApiHere(response.status) && !last) continue;
      if (!noApiHere(response.status)) resolved = order[at];
      break;
    }
    if (!response) {
      /* no endpoint deployed, offline, or blocked. The pages treat this
         as "billing is not available here" and say so, rather than
         showing controls that cannot work. */
      return { ok: false, unreachable: true, status: 0, data: null };
    }

    const data = await response.json().catch(() => null);
    const result = { ok: response.ok, unreachable: false, status: response.status, data };

    /* A stale CSRF token means this page's copy of the session is out of
       date — most often because another tab signed in or out and rotated
       it. Re-reading /api/account gets the current one; one retry, so a
       genuinely refused request still fails rather than looping. */
    if (response.status === 403 && data && data.reason === 'csrf' && !settings.retried) {
      await load();
      return call(name, Object.assign({}, settings, { retried: true }));
    }

    return result;
  }

  /* The whole account picture, refreshed from the server. */
  async function load() {
    const result = await call('account');
    if (result.ok && result.data) {
      current = result.data;
      notify();
    } else if (result.unreachable || result.status === 404) {
      current = null;
      notify();
    }
    return result;
  }

  /* One shape for every auth action. The fields each one reads are
     decided by the server; sending a field an action does not use
     changes nothing, which is the property worth having. */
  async function auth(fields) {
    const result = await call('auth', { body: fields });
    if (result.ok && result.data && result.data.plan) {
      current = result.data;
      notify();
    }
    return result;
  }

  const signup = ({ name, email, password, confirmPassword }) =>
    auth({ action: 'signup', name, email, password, confirmPassword });

  const login = (email, password) => auth({ action: 'login', email, password });

  const logout = () => auth({ action: 'logout' });

  const resendVerification = () => auth({ action: 'resend-verification' });

  const forgotPassword = (email) => auth({ action: 'forgot-password', email });

  const resetPassword = ({ token, password, confirmPassword }) =>
    auth({ action: 'reset-password', token, password, confirmPassword });

  /* Where "Continue with Google" goes. A full-page navigation, not a
     fetch: the browser has to leave for Google's own domain, which is
     the whole point — Fynd never sees the password, and there is no
     popup or iframe pretending to be Google. */
  const googleStartUrl = () => endpoint('google-start');

  /* Asks the server to open a Checkout Session and hands back its URL.

     The plan is sent as a name — "pro" or "max" — and nothing else. No
     price, no amount, no interval: the server looks those up. */
  const checkout = (plan) => call('checkout', {
    body: { plan: String(plan || ''), returnPath: returnPath('pricing.html') }
  });

  const portal = () => call('portal', { body: { returnPath: returnPath('account.html') } });

  /* The signed-in shopper's fit profile. Nothing here says whose: the
     server reads the account from the session cookie and takes no id
     from the page. Saving and deleting carry the CSRF header like every
     other change. */
  const fitProfile = {
    read: () => call('fit-profile'),
    save: (profile) => call('fit-profile', { body: { action: 'save', profile } }),
    /* the home page's fit guide: { garments: { <type>: answers } } — only
       the answers for one type of clothing travel, and the server keeps
       everything else in the profile as it is */
    answerGuide: (answers) => call('fit-profile', { body: { action: 'guide', answers } }),
    remove: () => call('fit-profile', { body: { action: 'delete' } })
  };

  /* After a checkout the browser comes back before Stripe's webhook has
     necessarily arrived, so the plan on screen may still be the old one
     for a second or two. This re-reads the account a few times and
     stops as soon as the server reports a paid plan.

     It waits for the server to change its mind. It cannot change it. */
  async function awaitPlanChange(wasPlan, attempts, gapMs) {
    const tries = Number(attempts) || 8;
    const gap = Number(gapMs) || 1500;
    for (let i = 0; i < tries; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 400 : gap));
      await load();
      if (current && current.plan && current.plan.id !== wasPlan) return current;
    }
    return current;
  }

  function subscribe(fn) {
    listeners.push(fn);
    if (current) fn(current);
    return () => {
      const at = listeners.indexOf(fn);
      if (at >= 0) listeners.splice(at, 1);
    };
  }

  global.Account = {
    load, signup, login, logout, checkout, portal, fitProfile,
    resendVerification, forgotPassword, resetPassword, googleStartUrl,
    awaitPlanChange, subscribe, endpoint, returnPath,
    state: () => current
  };
})(typeof window !== 'undefined' ? window : globalThis);
