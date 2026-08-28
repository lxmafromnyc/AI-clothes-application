/* =========================================================
   Fynd — begin a Google sign-in

   GET /api/google-start  ->  302 to Google

   A top-level navigation, not a fetch: the browser leaves Fynd, proves
   who it is to Google, and comes back to /api/google-callback. Nothing
   is posted here and nothing is returned but a redirect.

   Three secrets are minted and stored server-side before the redirect —
   a PKCE verifier, a nonce, and a browser binding — and only the state
   token that indexes them travels with the browser. See api/_google.js
   for what each one prevents.

   The binding is also set as a short-lived HttpOnly cookie. The
   callback requires both halves: the state token must resolve to a
   stored record, AND that record's binding must match the cookie in the
   browser presenting it. A callback URL captured in a log, a proxy or
   somebody's shoulder is therefore not enough to complete a sign-in
   somewhere else.
   ========================================================= */

'use strict';

const { isAllowed, siteOrigin } = require('./_cors');
const { setCookie } = require('./_auth');
const google = require('./_google');
const { envReport } = require('./_env-report');

const BINDING_COOKIE = 'fynd_oauth';
const BINDING_MAX_AGE = 60 * 10;   /* the same ten minutes the state lasts */

/* Where the person is standing when they press the button.

   Taken from the Referer only when the allow-list in _cors.js already
   accepts it, and from the deployment's own origin otherwise. A site
   origin that could be set by the request would be a way to point the
   end of this flow at somebody else's page. */
function originOfSite(req) {
  const referer = String((req.headers && req.headers.referer) || '');
  if (referer) {
    try {
      const parsed = new URL(referer);
      const candidate = `${parsed.protocol}//${parsed.host}`;
      if (isAllowed(req, candidate)) return candidate;
    } catch (err) { /* an unparseable Referer is simply not used */ }
  }
  return siteOrigin(req);
}

/* Errors are a redirect, not JSON: the browser got here by navigating,
   so it has to be given somewhere to be. The reason is a fixed word
   from this file — never a message from Google, and never anything
   taken from the request. */
function bounce(res, site, reason) {
  res.statusCode = 302;
  res.setHeader('Location', `${site}/account.html?auth=error&reason=${encodeURIComponent(reason)}`);
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });

  const site = originOfSite(req);

  if (!google.configured()) {
    console.warn('Google sign-in is not configured. env:', envReport());
    return bounce(res, site, 'google-not-configured');
  }
  /* No AUTH_SECRET means the state token cannot be stored or looked up,
     and a flow with no verifiable state is one this code will not run. */
  if (!require('./_auth').accountsEnabled()) {
    console.warn('Google sign-in unavailable: AUTH_SECRET is missing or too short.');
    return bounce(res, site, 'accounts-not-configured');
  }

  try {
    const { url, binding } = await google.beginFlow({
      origin: siteOrigin(req),
      returnPath: '/account.html',
      site
    });

    setCookie(req, res, BINDING_COOKIE, binding, BINDING_MAX_AGE);
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  } catch (err) {
    /* the message only — never the state, the nonce or the verifier */
    console.error('Could not start a Google sign-in:', err && err.message);
    return bounce(res, site, 'could-not-start');
  }
};

module.exports.BINDING_COOKIE = BINDING_COOKIE;
module.exports.originOfSite = originOfSite;
