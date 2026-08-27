/* =========================================================
   Fynd — the account, as the browser sees it

   One place that talks to /api/account, /api/auth, /api/checkout and
   /api/portal, and one copy of whatever they last said. The pages read
   from it; they do not each keep their own idea of who is signed in.

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
   Derived from the interpreter endpoint, the same way the search client
   derives its own, so one meta tag in the page configures all of them.

   Requests are sent with credentials, because the session lives in an
   HttpOnly cookie this file cannot read — which is why it cannot leak
   one either.
   ========================================================= */

(function (global) {
  'use strict';

  const REQUEST_TIMEOUT = 15000;

  function base() {
    if (global.FINDWEAR_API) return String(global.FINDWEAR_API);
    const tag = global.document && global.document.querySelector('meta[name="findwear-api"]');
    const href = tag && tag.getAttribute('content');
    return href ? href.trim() : '/api/interpret';
  }

  const endpoint = (name) => base().replace(/\/interpret(\/)?$/, `/${name}`);

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    let response;
    try {
      response = await fetch(endpoint(name), {
        method: settings.body ? 'POST' : 'GET',
        headers: settings.body ? { 'Content-Type': 'application/json' } : undefined,
        credentials: 'include',
        body: settings.body ? JSON.stringify(settings.body) : undefined,
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timer);
      /* no endpoint deployed, offline, or blocked. The pages treat this
         as "billing is not available here" and say so, rather than
         showing controls that cannot work. */
      return { ok: false, unreachable: true, status: 0, data: null };
    }
    clearTimeout(timer);

    const data = await response.json().catch(() => null);
    return { ok: response.ok, unreachable: false, status: response.status, data };
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

  async function auth(action, email, password) {
    const result = await call('auth', { body: { action, email, password } });
    if (result.ok && result.data) {
      current = result.data;
      notify();
    }
    return result;
  }

  const signup = (email, password) => auth('signup', email, password);
  const login = (email, password) => auth('login', email, password);
  const logout = () => auth('logout');

  /* Asks the server to open a Checkout Session and hands back its URL.

     The plan is sent as a name — "pro" or "max" — and nothing else. No
     price, no amount, no interval: the server looks those up. */
  const checkout = (plan) => call('checkout', {
    body: { plan: String(plan || ''), returnPath: returnPath('pricing.html') }
  });

  const portal = () => call('portal', { body: { returnPath: returnPath('account.html') } });

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
    load, signup, login, logout, checkout, portal,
    awaitPlanChange, subscribe, endpoint, returnPath,
    state: () => current
  };
})(typeof window !== 'undefined' ? window : globalThis);
