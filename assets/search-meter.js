/* =========================================================
   Fynd — the search meter under the search box

   One quiet line: how many live searches the plan has used, how many
   are left, and a hairline bar of the same. It is the server's count,
   drawn — never a count kept here.

   ---------------------------------------------------------
   Where the numbers come from
   ---------------------------------------------------------
   Two places, both the server's usage counters (api/_usage.js):

     /api/account   read when the page opens, through assets/account.js,
                    for whoever is asking — an account, or the anonymous
                    visitor the server counts the free allowance against
     /api/search    every answer that counted or refused a search says
                    where the counter stands after it: a 200 carries the
                    count after the search, a 429 the count that refused
                    it. The meter moves to that, without a reload.

   An answer that carries no count — the product source failed (502),
   none is connected (503), the request never arrived — is followed by a
   fresh read of /api/account instead. Whether such a search cost
   anything is the server's rule, not this file's, so the meter asks
   rather than guesses. Today the answer is that it cost nothing.

   ---------------------------------------------------------
   What it never does
   ---------------------------------------------------------
   Subtract one on its own, assume a reset, or invent a total. Until the
   server has answered the meter is not drawn, and on a copy of the site
   with no API it never is: the box works exactly as it did, and the
   server still enforces the allowance whatever this file believes.

   At zero, the box is disabled, because the server would refuse the
   search anyway. That is a courtesy, not the limit: re-enabling the
   button in the console buys nothing but a 429.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc) return;

  /* The share left at which the remainder is set in stronger type. A
     fifth: on Pro that is the last twenty searches of a hundred. Free's
     single search is never "low" — it is there or it is spent. */
  const LOW_SHARE = 0.2;

  /* setTimeout cannot wait a month, and a laptop that slept through a
     reset should notice without waiting for one either */
  const LONGEST_WAIT = 6 * 60 * 60 * 1000;
  /* and never sooner than this: a visitor whose clock runs ahead of the
     server's sees the reset as already past, and must not be sent back
     to ask every second until the server agrees */
  const SHORTEST_WAIT = 60 * 1000;
  /* a tab coming back into view re-reads, at most this often */
  const REFRESH_GAP = 15 * 1000;

  let shown = null;        /* the last searches counter the server sent */
  let searchesSeen = 0;    /* bumped each time a search reply is applied */
  let resetTimer = null;
  let lastPull = 0;

  const $ = (id) => doc.getElementById(id);

  const plural = (n, one, many) => (n === 1 ? one : many);

  const dateOf = (iso) => {
    const when = new Date(iso);
    return Number.isNaN(when.getTime()) ? null : when;
  };

  /* Written in the shopper's own locale from the instant the server
     sent; the same words the results page uses when a search is refused. */
  function resetWords(usage) {
    const when = dateOf(usage.resetsAt);
    if (!when) return '';
    return usage.period === 'month'
      ? `Resets on ${when.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
      : `Resets at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }

  /* Only a counter shaped like the server's searches counter is drawn. */
  function valid(usage) {
    return Boolean(usage && typeof usage === 'object'
      && (usage.metric === undefined || usage.metric === 'searches')
      && Number.isFinite(Number(usage.limit)) && Number(usage.limit) > 0
      && Number.isFinite(Number(usage.used)) && Number(usage.used) >= 0);
  }

  /* used and left, as the server reported them. `used` is capped at the
     limit for display only: two searches racing for the last one can
     both be counted, and "2 / 1" says nothing the shopper can act on. */
  function figures(usage) {
    const limit = Number(usage.limit);
    const used = Math.min(Number(usage.used), limit);
    const remaining = Number.isFinite(Number(usage.remaining))
      ? Math.max(0, Number(usage.remaining))
      : Math.max(0, limit - used);
    return { limit, used, remaining };
  }

  function stateOf(usage) {
    const { limit, remaining } = figures(usage);
    if (remaining <= 0) return 'empty';
    if (limit > 1 && remaining / limit <= LOW_SHARE) return 'low';
    return 'normal';
  }

  /* ---------- drawing ---------- */

  function draw() {
    const root = $('search-meter');
    if (!root) return;

    if (!shown) {
      root.dataset.state = 'pending';
      lock(false);
      return;
    }

    const { limit, used, remaining } = figures(shown);
    const state = stateOf(shown);
    const period = shown.period === 'month' ? 'this month' : 'today';

    root.dataset.state = state;
    root.querySelector('.search-meter-count').textContent =
      `${used.toLocaleString()} / ${limit.toLocaleString()} ${plural(limit, 'search', 'searches')} used ${period}`;

    const left = root.querySelector('.search-meter-left');
    left.textContent = `${remaining.toLocaleString()} left`;
    left.hidden = state === 'empty';

    root.querySelector('.search-meter-fill').style.width = `${Math.round((used / limit) * 100)}%`;

    /* At zero: what happened, when it comes back, and — only when a
       bigger plan exists to move to — the way to it. The pricing page
       is the existing path: it signs a visitor in first, sends a Free
       account to Checkout and a subscriber to the billing portal. */
    const out = root.querySelector('.search-meter-out');
    if (state === 'empty') {
      const reset = resetWords(shown);
      out.innerHTML = '';
      out.append(`No searches remaining${reset ? `. ${reset}` : ''}.`);
      if (shown.plan !== 'max') {
        const link = doc.createElement('a');
        link.href = 'pricing.html';
        link.textContent = 'See plans';
        out.append(' ', link);
      }
      out.hidden = false;
    } else {
      out.hidden = true;
      out.textContent = '';
    }

    lock(state === 'empty');
  }

  /* The box, disabled at zero and given back the moment the server says
     there is a search again. Nothing here stops a search the server
     would allow: it only ever follows what the server last said. */
  function lock(spent) {
    const form = $('ask-form');
    if (!form) return;
    form.classList.toggle('is-spent', spent);

    const input = $('ask');
    const submit = form.querySelector('button[type="submit"]');
    const files = $('ask-files');
    [input, submit, files].forEach((el) => { if (el) el.disabled = spent; });
    doc.querySelectorAll('#ask-examples .example').forEach((button) => { button.disabled = spent; });

    if (input) {
      if (spent) input.setAttribute('aria-describedby', 'search-meter');
      else input.removeAttribute('aria-describedby');
    }
  }

  /* ---------- keeping it current ---------- */

  function apply(usage) {
    if (!valid(usage)) return;
    shown = {
      plan: usage.plan || null,
      period: usage.period === 'month' ? 'month' : 'day',
      limit: Number(usage.limit),
      used: Number(usage.used),
      remaining: usage.remaining,
      resetsAt: usage.resetsAt || null
    };
    draw();
    scheduleReset();
  }

  /* Re-reads the account. A search reply that lands while this read is
     in flight is newer than whatever the read returns — the read may
     have been answered before that search was counted — so the read is
     dropped rather than allowed to wind the meter back. */
  async function pull() {
    if (!global.Account) return;
    lastPull = Date.now();
    const before = searchesSeen;
    await global.Account.load();
    if (searchesSeen !== before) return;
    const state = global.Account.state();
    if (state && state.usage && state.usage.searches) apply(state.usage.searches);
  }

  /* When the window the server is counting in ends, the counter it
     reports changes with it — so the meter asks again then, rather than
     holding a "0 left" that has stopped being true. */
  function scheduleReset() {
    if (resetTimer) global.clearTimeout(resetTimer);
    resetTimer = null;
    const when = shown && dateOf(shown.resetsAt);
    if (!when) return;
    const wait = Math.max(SHORTEST_WAIT, Math.min(when.getTime() - Date.now() + 1000, LONGEST_WAIT));
    resetTimer = global.setTimeout(pull, wait);
  }

  /* What app.js hands over once a search has an outcome (assets/search.js
     shapes it). */
  function afterSearch(found) {
    if (found && valid(found.usage)) {
      searchesSeen += 1;
      apply(found.usage);
      return;
    }
    pull();
  }

  /* True only when the server's last word was that nothing is left. */
  const exhausted = () => Boolean(shown && stateOf(shown) === 'empty');

  function start() {
    if (!$('search-meter') || !global.Account) return;
    draw();
    pull();

    /* another tab may have searched, signed in or upgraded */
    const refresh = () => {
      if (doc.visibilityState === 'hidden') return;
      if (Date.now() - lastPull < REFRESH_GAP) return;
      pull();
    };
    doc.addEventListener('visibilitychange', refresh);
    global.addEventListener('pageshow', (event) => { if (event.persisted) pull(); });
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();

  global.SearchMeter = { afterSearch, exhausted, refresh: pull, state: () => (shown ? Object.assign({}, shown) : null) };
})(typeof window !== 'undefined' ? window : globalThis);
