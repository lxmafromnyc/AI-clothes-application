/* =========================================================
   FindWear — the usage meter (client side)

   Renders what the server says has been used. It does not count, does
   not estimate, and does not decide anything.

   ---------------------------------------------------------
   Why the page never keeps its own tally
   ---------------------------------------------------------
   A meter that counted in the browser would be a second opinion, and the
   two would drift apart the moment a search was made in another tab, on
   a phone, or by a retry the page never saw. Worse, a drifting meter
   reads as the authority — a shopper told "1 / 3 used" who is refused
   has been misled by their own interface.

   So every number on screen arrives from the server, from the same store
   the enforcement path reads. When they cannot be fetched the meter is
   hidden rather than guessed at: no meter is honest, a stale one is not.

   The limit itself is never enforced here. The button is not disabled
   when the allowance runs out — the server refuses the request and the
   page explains the refusal. A frontend check would only be a courtesy,
   and treating it as protection is how limits get bypassed.
   ========================================================= */

(function (global) {
  'use strict';

  const REQUEST_TIMEOUT = 8000;

  /* ---------------------------------------------------------
     Pure formatting — no DOM, so it can be tested directly
     --------------------------------------------------------- */

  const LOGIC = {};

  /* 7420 -> "7,420". Grouping matters here: a token allowance is the one
     number on the page with enough digits to be misread at a glance. */
  LOGIC.groupDigits = function groupDigits(value) {
    const n = Math.max(0, Math.round(Number(value) || 0));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  /* The line the interface leads with, because a count of searches is
     something a shopper can hold in their head:

       "3 / 3 searches used today"
       "42 / 75 searches used this month"  */
  LOGIC.searchLine = function searchLine(snapshot) {
    if (!snapshot || !snapshot.meters || !snapshot.meters.searches) return '';
    const m = snapshot.meters.searches;
    const window = snapshot.usageWindow || '';
    return `${LOGIC.groupDigits(m.used)} / ${LOGIC.groupDigits(m.limit)} searches used ${window}`.trim();
  };

  /* The second meter, shown separately rather than blended into the
     first: they run out independently and for different reasons.

       "7,420 / 20,000 AI tokens"  */
  LOGIC.tokenLine = function tokenLine(snapshot) {
    if (!snapshot || !snapshot.meters || !snapshot.meters.tokens) return '';
    const m = snapshot.meters.tokens;
    return `${LOGIC.groupDigits(m.used)} / ${LOGIC.groupDigits(m.limit)} AI tokens`;
  };

  /* 0..1, clamped. A meter that overflowed its own bar would be the one
     moment the drawing disagreed with the number beside it. */
  LOGIC.fraction = function fraction(meter) {
    if (!meter || !Number.isFinite(Number(meter.limit)) || Number(meter.limit) <= 0) return 0;
    return Math.min(1, Math.max(0, Number(meter.used) / Number(meter.limit)));
  };

  /* "Resets in 4 hours", "Resets in 12 days". Said in the units a person
     would use, from the server's own timestamp. */
  LOGIC.resetPhrase = function resetPhrase(snapshot, now) {
    if (!snapshot || !snapshot.resetAt) return '';
    const at = Date.parse(snapshot.resetAt);
    if (!Number.isFinite(at)) return '';
    const seconds = Math.max(0, Math.round((at - (now || Date.now())) / 1000));
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (seconds < 60) return 'Resets in under a minute';
    if (seconds < 3600) return `Resets in ${plural(Math.round(seconds / 60), 'minute')}`;
    if (seconds < 86400) return `Resets in ${plural(Math.round(seconds / 3600), 'hour')}`;
    return `Resets in ${plural(Math.round(seconds / 86400), 'day')}`;
  };

  /* What to say when the server refuses a request for being over a
     limit. Built from the structured payload it sent, so the wording
     always matches the meter that was actually hit. */
  LOGIC.limitMessage = function limitMessage(limit, now) {
    if (!limit) return '';
    const what = limit.limitType === 'tokens' ? 'AI tokens' : 'live searches';
    const window = limit.period === 'day' ? 'daily' : 'monthly';
    const reset = LOGIC.resetPhrase(limit, now);
    return `You have used all ${LOGIC.groupDigits(limit.limit)} ${what} in your ${window} ${limit.planName} allowance. ${reset}.`
      .replace(/\s+\./g, '.');
  };

  /* ---------------------------------------------------------
     Talking to the server
     --------------------------------------------------------- */

  function endpoint() {
    if (global.FINDWEAR_USAGE_API) return String(global.FINDWEAR_USAGE_API);
    const tag = global.document && global.document.querySelector('meta[name="findwear-usage-api"]');
    const explicit = tag && tag.getAttribute('content');
    if (explicit) return explicit.trim();
    const base = (global.Interpreter && global.Interpreter.endpoint)
      ? global.Interpreter.endpoint()
      : '/api/interpret';
    return base.replace(/\/interpret(\/)?$/, '/usage');
  }

  /* The account's credential, when it has one. Anonymous callers send
     nothing and the server meters them by other means — see
     api/_accounts.js. Read fresh each time so a sign-in mid-session is
     picked up without a reload. */
  function authHeaders() {
    let token = null;
    try {
      token = global.localStorage && global.localStorage.getItem('findwear.token');
    } catch (err) {
      /* storage blocked: an anonymous request is the correct fallback */
      token = null;
    }
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /* A per-submission key, so a double-click or a retry is recognised by
     the server as the same search rather than as a second one. */
  function newSubmissionKey() {
    try {
      if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    } catch (err) { /* fall through */ }
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }

  let current = null;
  const listeners = [];

  const notify = () => listeners.forEach((fn) => {
    try { fn(current); } catch (err) { /* one bad listener must not stop the rest */ }
  });

  /* Adopt a snapshot that arrived on some other response. Every metered
     endpoint returns one, so the meter updates from the search the
     shopper just ran rather than needing a second round trip. */
  function absorb(snapshot) {
    if (!snapshot || !snapshot.meters) return current;
    current = snapshot;
    notify();
    return current;
  }

  async function refresh() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const response = await fetch(endpoint(), {
        method: 'GET',
        headers: authHeaders(),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) return null;
      const data = await response.json();
      if (data && data.usage) {
        absorb(data.usage);
        if (data.plans) current.plans = data.plans;
      }
      return current;
    } catch (err) {
      /* unreachable: the meter stays hidden rather than inventing a
         figure it cannot stand behind */
      return null;
    }
  }

  const snapshot = () => current;
  const subscribe = (fn) => { listeners.push(fn); if (current) fn(current); };

  global.Usage = Object.assign({
    refresh,
    absorb,
    snapshot,
    subscribe,
    endpoint,
    authHeaders,
    newSubmissionKey
  }, LOGIC);

  if (typeof module !== 'undefined' && module.exports) module.exports = global.Usage;
})(typeof window !== 'undefined' ? window : globalThis);
