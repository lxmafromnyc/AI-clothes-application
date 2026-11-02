/* =========================================================
   Fynd extension — talking to Fynd's server

   The only code in the extension that makes a request, and only to
   Fynd's own API (FYND_API, config.js; the one host the manifest grants).
   Four calls:

     savedGarments()   GET  /api/fit-profile — the garments saved on the
                       shopper's fit profile, read with their own Fynd
                       session (the cookie their browser already holds
                       for Fynd). Nothing is stored in the extension.
     compareChart(chart, referenceType)
                       POST /api/size-recommendation?compare=1&candidate=1
                       — the product's whole confirmed chart in one
                       request, set beside one saved garment by Fynd's
                       own engine and decision (api/_sizing/). The answer
                       is the server's: the extension never ranks, scores
                       or recommends.
     metrics(events)   POST /api/size-recommendation?metrics=1 — anonymous
                       counters of how much work a comparison took (event
                       names and two numbers; never under Do Not Track)
     interpretChart(request)
                       POST /api/size-recommendation?parse=1 — only when the deterministic
                       reading can't interpret a chart (extract.js
                       interpretationNeeds): the table's cell text, caption
                       and the words before it, for Fynd's server to ask
                       its AI for a proposal and check it against the page.
                       The extension never calls a model itself.

   Every answer is { ok, status, data } or { ok: false, problem }, where
   problem.kind is one of:
     sign-in      401: not signed in to Fynd in this browser
     not-found    404: that garment isn't saved (any more)
     rate-limited 429: too many comparisons; retryAfter in seconds
     invalid      400: the chart didn't read; the server's own messages
     too-large    413: the table is too large to send
     unsupported  415/422: not something the server can read as a chart
     unavailable  503: the AI reading isn't available (reason says why)
     timeout      no answer within TIMEOUT_MS
     offline      the request never reached Fynd
     server       Fynd answered 5xx, or something it doesn't understand
   ========================================================= */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  /* config.js's constants are global bindings, not properties of the window */
  else root.FyndApi = factory({ base: typeof FYND_API !== 'undefined' ? FYND_API : '', fetch: root.fetch.bind(root), timeoutMs: typeof FYND_API_TIMEOUT_MS !== 'undefined' ? FYND_API_TIMEOUT_MS : 0, aiTimeoutMs: typeof FYND_AI_TIMEOUT_MS !== 'undefined' ? FYND_AI_TIMEOUT_MS : 0 });
})(typeof self !== 'undefined' ? self : this, function (config) {
  'use strict';

  const TIMEOUT_MS = config.timeoutMs || 15000;
  const base = String(config.base || '').replace(/\/$/, '');
  const fetchFn = config.fetch;

  async function request(path, init, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
    let res;
    try {
      res = await fetchFn(`${base}${path}`, Object.assign({ credentials: 'include', cache: 'no-store', signal: controller.signal }, init || {}));
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err && (err.name === 'AbortError' || controller.signal.aborted);
      return { ok: false, status: 0, problem: { kind: timedOut ? 'timeout' : 'offline', message: timedOut ? 'Fynd didn’t answer in time.' : 'Fynd couldn’t be reached.', detail: String(err && err.message || err) } };
    }
    clearTimeout(timer);
    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    if (res.ok && data && typeof data === 'object') return { ok: true, status: res.status, data };
    const said = data && typeof data.error === 'string' ? data.error : null;
    const kind = res.status === 401 ? 'sign-in'
      : res.status === 404 ? 'not-found'
        : res.status === 429 ? 'rate-limited'
          : res.status === 400 ? 'invalid'
            : res.status === 413 ? 'too-large'
              : res.status === 415 || res.status === 422 ? 'unsupported'
                : res.status === 503 ? 'unavailable'
                  : res.status === 504 ? 'timeout'
                    : 'server';
    const retry = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
    return {
      ok: false,
      status: res.status,
      problem: {
        kind,
        message: said || (kind === 'server' ? 'Fynd couldn’t answer just now.' : 'Fynd couldn’t do that.'),
        reason: data && typeof data.reason === 'string' ? data.reason : null,
        errors: data && Array.isArray(data.errors) ? data.errors.filter((e) => e && typeof e.message === 'string') : [],
        retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null
      }
    };
  }

  const savedGarments = () => request('/api/fit-profile', { method: 'GET' });
  const compareChart = (chart, referenceType) => request('/api/size-recommendation?compare=1&candidate=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chart, referenceType })
  });

  /* the model has MODEL_TIMEOUT_MS on the server (api/_sizing/parse-chart.js); the panel waits a little longer */
  const AI_TIMEOUT_MS = Math.max(TIMEOUT_MS, config.aiTimeoutMs || 20000);
  const interpretChart = (body) => request('/api/size-recommendation?parse=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, AI_TIMEOUT_MS);

  /* anonymous product counters (api/_metrics.js): event names from a fixed list, two
     numbers, nothing identifying — and nothing at all under Do Not Track or Global
     Privacy Control. Fire and forget: a counter never holds up the panel */
  const nav = (typeof navigator !== 'undefined' && navigator) || {};
  const metricsOff = nav.doNotTrack === '1' || nav.globalPrivacyControl === true || config.metrics === false;
  const metrics = (events) => (metricsOff || !events.length ? Promise.resolve(null) : request('/api/size-recommendation?metrics=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: events.slice(0, 20).map((e) => Object.assign({ surface: 'extension' }, e)) })
  }).catch(() => null));

  return { request, savedGarments, compareChart, interpretChart, metrics, metricsOff, TIMEOUT_MS, AI_TIMEOUT_MS, base };
});
