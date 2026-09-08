/* =========================================================
   Fynd — naming an upstream failure, safely

   TEMPORARY. This exists to answer one question that the logs would
   normally answer and, on this deployment, currently do not: when
   /api/search returns 502, what did the product source actually say?
   401, 403, 429 and 503 all reach a shopper as the same sentence, and
   they have four different fixes.

   Remove this file, and the two blocks in api/search.js that call it,
   once that question is answered.

   ---------------------------------------------------------
   Where it is allowed to appear
   ---------------------------------------------------------
   Everywhere but production, by default. A preview deployment exists to
   be inspected, and now that the frontend calls its own origin (see
   "Which host answers" in assets/interpret.js) a preview is where this
   gets used. Production is a shopper's site: it has no reason to
   publish which vendor answered what, and a temporary diagnostic left
   switched on there is how temporary becomes permanent.

     FYND_DIAGNOSTIC unset   on everywhere except VERCEL_ENV=production
     FYND_DIAGNOSTIC=on      on, production included — for an incident,
                             then unset it again
     FYND_DIAGNOSTIC=off     off everywhere

   /api/search omits both blocks entirely when this says no; it does not
   send an empty one.

   ---------------------------------------------------------
   The rule this module is built on
   ---------------------------------------------------------
   It cannot emit a string it was given. Every word it can produce is
   written below: the category names, the message table, and the signal
   tokens. The upstream body is READ — matched against fixed patterns —
   and never echoed, not whole, not truncated, not scrubbed.

   That is the same guarantee _env-report.js makes about environment
   values, and it is made the same way, because "we removed the secret
   from the string" depends on a regex being right about a body nobody
   has seen. "The string never came from there" does not.

   So none of these can appear in a reply, by construction rather than
   by filtering:

     API keys, of any provider          the body is never echoed
     request or response headers        never read except retry-after
                                        and the two rate-limit counters,
                                        each coerced to a number
     cache keys and digests             never passed in
     Redis / KV URLs or tokens          never read
     raw request bodies                 never passed in
     the shopper's intent               never passed in

   What it does emit: a provider name that came from the adapter
   registry, an HTTP status as an integer, one category name from a
   fixed list, one sentence from a fixed table, and zero or more tokens
   from a fixed list.
   ========================================================= */

'use strict';

const cache = require('./_cache');
const store = require('./_store');

/* ---------------------------------------------------------
   Categories
   --------------------------------------------------------- */

/* Whether a reply may carry any of this at all. */
function exposed() {
  const flag = String(process.env.FYND_DIAGNOSTIC || '').trim().toLowerCase();
  if (flag === 'on') return true;
  if (flag === 'off') return false;
  return String(process.env.VERCEL_ENV || '').trim().toLowerCase() !== 'production';
}

const CATEGORY = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate-limited',
  SERVER_ERROR: 'server-error',
  CLIENT_ERROR: 'client-error',
  TIMEOUT: 'timeout',
  NETWORK: 'network',
  NOT_CONFIGURED: 'not-configured',
  UNKNOWN: 'unknown'
};

/* One sentence each, written here rather than taken from the provider.
   These are the only messages this module can return. */
const MESSAGE = {
  [CATEGORY.UNAUTHORIZED]: 'The provider rejected the credential as missing, invalid or revoked.',
  [CATEGORY.FORBIDDEN]: 'The provider refused the request: the credential is not entitled to this endpoint, or the plan does not cover it.',
  [CATEGORY.RATE_LIMITED]: 'The provider refused the request for exceeding a rate limit or a quota.',
  [CATEGORY.SERVER_ERROR]: 'The provider failed on its own side.',
  [CATEGORY.CLIENT_ERROR]: 'The provider rejected the request as malformed or unsupported.',
  [CATEGORY.TIMEOUT]: 'The provider did not answer before the request timeout expired.',
  [CATEGORY.NETWORK]: 'The provider could not be reached at the network level.',
  [CATEGORY.NOT_CONFIGURED]: 'No credential is set for the provider in this environment.',
  [CATEGORY.UNKNOWN]: 'The provider call failed for a reason this diagnostic does not recognise.'
};

/* Read from the error when the adapter attached one, otherwise parsed
   out of the message it threw — so an adapter that has not been taught
   to carry the status is still reported rather than reduced to
   "unknown". Only the three digits are taken from the message. */
function statusOf(err) {
  const attached = err && err.upstream && Number(err.upstream.status);
  if (Number.isInteger(attached) && attached >= 100 && attached <= 599) return attached;

  const match = /\bresponded\s+(\d{3})\b/.exec((err && err.message) || '');
  if (!match) return null;
  const parsed = Number(match[1]);
  return parsed >= 100 && parsed <= 599 ? parsed : null;
}

function categoryOf(status, err) {
  if (status === 401) return CATEGORY.UNAUTHORIZED;
  if (status === 403) return CATEGORY.FORBIDDEN;
  if (status === 429) return CATEGORY.RATE_LIMITED;
  if (status >= 500 && status <= 599) return CATEGORY.SERVER_ERROR;
  if (status >= 400 && status <= 499) return CATEGORY.CLIENT_ERROR;

  /* no HTTP answer at all: the request never completed */
  const name = (err && err.name) || '';
  const message = (err && err.message) || '';
  if (name === 'AbortError' || /abort|timed?\s*out/i.test(name + ' ' + message)) return CATEGORY.TIMEOUT;
  if (/is not set|no api key|missing credential/i.test(message)) return CATEGORY.NOT_CONFIGURED;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket|network|certificate|TLS|SSL/i.test(message)) {
    return CATEGORY.NETWORK;
  }
  return CATEGORY.UNKNOWN;
}

/* ---------------------------------------------------------
   Signals
   ---------------------------------------------------------
   A 429 for "you have used this month's requests" and a 429 for "slow
   down" are the same status and different problems — one is answered by
   a plan, the other by a pause. These say which, WITHOUT quoting the
   provider: the pattern is matched against its body, and the token
   emitted is the fixed string on the left.
   --------------------------------------------------------- */

const SIGNALS = [
  ['quota', /\bquota\b/i],
  ['rate-limit', /rate[\s_-]?limit/i],
  ['monthly-window', /\bmonth(ly)?\b/i],
  ['daily-window', /\bdai?ly\b/i],
  ['hourly-window', /\bhour(ly)?\b/i],
  ['invalid-key', /\b(invalid|bad|unknown|incorrect)\b[\s\S]{0,20}\b(key|token|credential)\b/i],
  ['missing-key', /\b(missing|absent|no)\b[\s\S]{0,20}\b(key|token|credential)\b/i],
  ['expired', /\bexpir\w*/i],
  ['suspended', /\b(suspend\w*|disabled|deactivat\w*|blocked)\b/i],
  ['subscription', /\bsubscri\w*/i],
  ['plan', /\bplan\b/i],
  ['upgrade', /\bupgrade\b/i],
  ['not-found', /\bnot\s*found\b/i],
  ['unauthorized', /\bunauthoriz\w*/i],
  ['forbidden', /\bforbidden\b/i]
];

function signalsIn(body) {
  const text = typeof body === 'string' ? body : '';
  if (!text) return [];
  const found = [];
  for (const [token, pattern] of SIGNALS) {
    if (pattern.test(text) && !found.includes(token)) found.push(token);
  }
  /* bounded, so a hostile body cannot make the reply grow */
  return found.slice(0, 6);
}

/* Rate-limit hints, as numbers only. A header that is not a number is
   dropped rather than passed through, so no header value can become a
   string in the reply. */
function counterOf(value) {
  const n = Number(String(value === undefined || value === null ? '' : value).trim());
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? n : null;
}

/* ---------------------------------------------------------
   What /api/search reports
   --------------------------------------------------------- */

/* Never throws: it runs on the failure path, and a diagnostic that
   turned a 502 into a 500 would destroy the thing it is here to
   explain. */
function providerFailure(providerName, err) {
  try {
    const status = statusOf(err);
    const category = categoryOf(status, err);
    const upstream = (err && err.upstream) || {};
    const body = typeof upstream.body === 'string' ? upstream.body : ((err && err.message) || '');

    const report = {
      /* from the adapter registry, not from any request */
      provider: typeof providerName === 'string' ? providerName.slice(0, 40) : null,
      status,
      category,
      message: MESSAGE[category] || MESSAGE[CATEGORY.UNKNOWN],
      signals: signalsIn(body),
      /* that there WAS a body, and roughly how much of one — a number,
         so it can carry nothing */
      bodyBytes: typeof upstream.body === 'string' ? upstream.body.length : null,
      at: new Date().toISOString()
    };

    const retryAfter = counterOf(upstream.retryAfter);
    const remaining = counterOf(upstream.remaining);
    const reset = counterOf(upstream.reset);
    if (retryAfter !== null) report.retryAfterSeconds = retryAfter;
    if (remaining !== null) report.rateLimitRemaining = remaining;
    if (reset !== null) report.rateLimitReset = reset;

    return report;
  } catch (failure) {
    return { provider: null, status: null, category: CATEGORY.UNKNOWN, message: MESSAGE[CATEGORY.UNKNOWN], signals: [] };
  }
}

/* Which build answered, so "is production running the commit I merged"
   is a fact rather than an assumption.

   VERCEL_GIT_COMMIT_SHA and VERCEL_GIT_COMMIT_REF are system variables
   Vercel sets itself; nothing has to be configured for them, unless the
   project has "Automatically expose System Environment Variables"
   switched off, in which case they read null and the cache fingerprint
   below is what identifies the build instead. A commit SHA of a public
   repository is not a secret. */
function build() {
  try {
    const sha = String(process.env.VERCEL_GIT_COMMIT_SHA || '').trim();
    return {
      commit: sha ? sha.slice(0, 7) : null,
      ref: String(process.env.VERCEL_GIT_COMMIT_REF || '').trim().slice(0, 80) || null,
      env: String(process.env.VERCEL_ENV || '').trim().slice(0, 20) || null,
      /* present only in a build that carries api/_cache.js, so it tells
         a pre-cache deployment from this one even with no git variables */
      cacheVersion: cache.CACHE_VERSION,
      cacheEnabled: cache.enabled(),
      /* 'redis' or 'memory' — which driver, never which URL or token */
      storeDriver: store.driver()
    };
  } catch (failure) {
    return { commit: null, ref: null, env: null, cacheVersion: null, cacheEnabled: null, storeDriver: null };
  }
}

module.exports = { exposed, providerFailure, build, statusOf, categoryOf, signalsIn, CATEGORY, MESSAGE, SIGNALS };
