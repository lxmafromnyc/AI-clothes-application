/* =========================================================
   FindWear — cross-origin access control

   Shared by /api/interpret and /api/search. Both endpoints spend money —
   one on OpenAI credit, the other on product-search quota — so who may
   call them from a browser is decided here, in one place, rather than
   twice with a chance of drifting apart.

   ---------------------------------------------------------
   Which origins are allowed
   ---------------------------------------------------------
   Four sources, in order of how much configuration they need:

     1. FindWear's own published site, listed in SITE_ORIGINS below. This
        project has a known front door — the GitHub Pages site — and it
        is a fact about the project, not a deployment setting. Keeping it
        in code means the site cannot be locked out of its own API by a
        missing or mistyped environment variable, which is exactly what
        happened: every request from the Pages site was refused 403
        because ALLOWED_ORIGIN never reached the running function.

        Nothing is weakened by this. These are public origins, not
        secrets, and the same hostname is already in the meta tag of
        every page. It removes a whole class of configuration error.

     2. The deployment's own origin, matched against the request's Host
        header. A page served from the same host as the function is
        same-origin by definition, so this needs no configuration and
        keeps working on production, preview and custom domains alike.

     3. The deployment's Vercel hostnames, read from the system
        environment variables Vercel injects at runtime
        (VERCEL_PROJECT_PRODUCTION_URL, VERCEL_BRANCH_URL, VERCEL_URL).
        These need "Automatically expose System Environment Variables"
        left enabled in the project settings, which is the default.

     4. ALLOWED_ORIGIN, for anything the first three do not cover. It
        ADDS to the list; it can no longer remove from it. One origin, or
        several separated by commas:

          ALLOWED_ORIGIN=https://lxmafromnyc.github.io
          ALLOWED_ORIGIN=https://lxmafromnyc.github.io,https://findwear.example

        A trailing slash is tolerated here and stripped, because pasting
        a URL out of a browser's address bar brings one along and the
        resulting mismatch is invisible in a dashboard.

   There is deliberately no wildcard, and no blanket *.vercel.app rule:
   that would let anybody's Vercel deployment spend this project's API
   credit.

   ---------------------------------------------------------
   What a rejected origin gets
   ---------------------------------------------------------
   A 403 that says so, including for the preflight.

   Answering a preflight 204 without the headers is what a browser sees
   as a rejection, but a log only records the 204 — so a misconfigured
   deployment reads as a working one, and the failure looks like it is
   somewhere else entirely. A 403 puts the reason in the log where it
   can be found.
   ========================================================= */

'use strict';

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

/* FindWear's published front ends. A property of the project rather than
   of any one deployment, so they belong in the repository where they
   cannot go missing. Add an origin here when the site gains a new home;
   use ALLOWED_ORIGIN for anything deployment-specific. */
const SITE_ORIGINS = [
  'https://lxmafromnyc.github.io'
];

/* Origins named in configuration, plus the ones Vercel tells us about. */
function configuredOrigins() {
  const origins = new Set(SITE_ORIGINS);

  String(process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(trimSlash)
    .filter(Boolean)
    .forEach((origin) => origins.add(origin));

  /* Vercel supplies these as bare hostnames, without a scheme. */
  ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL', 'VERCEL_URL'].forEach((key) => {
    const host = trimSlash(process.env[key]).replace(/^https?:\/\//, '');
    if (host) origins.add(`https://${host}`);
  });

  return origins;
}

/* A page served from the same host as this function. The browser still
   sends an Origin header on a same-origin POST, so this case has to be
   allowed explicitly even though it is not really cross-origin. */
function isSameOrigin(req, origin) {
  const host = req.headers && req.headers.host;
  if (!host) return false;
  return origin === `https://${host}` || origin === `http://${host}`;
}

/* The request's Origin is compared exactly, without normalisation. A
   browser never sends a trailing slash, so anything carrying one did not
   come from one — and since the value is echoed straight back into
   Access-Control-Allow-Origin, only a value we would be willing to echo
   may pass. Slash-tolerance belongs on the configuration side, where a
   human pastes a URL, not on the request side. */
function isAllowed(req, origin) {
  return isSameOrigin(req, origin) || configuredOrigins().has(origin);
}

/* Applies the rules to one request.

   Returns true when the request may proceed and false when it may not,
   having set the response headers either way. A request with no Origin
   header is not a browser cross-origin request at all — curl, a
   server-to-server call — and is left alone. */
function applyCors(req, res) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;

  if (!isAllowed(req, origin)) return false;

  /* Echo the caller's own origin. A list is not a legal value here, and
     Vary tells caches that the answer depends on who asked. */
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  /* The session cookie has to travel for /api/account and the billing
     endpoints to know who is asking. This is only ever sent alongside a
     single named origin from the list above — never a wildcard, which a
     browser refuses to combine with credentials anyway — so it widens
     nothing: an origin that may not call these endpoints still may not,
     and one that may was always going to be answered. */
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  /* Five minutes: long enough to save a preflight per search, short
     enough that a corrected configuration takes effect while someone is
     still looking at it. */
  res.setHeader('Access-Control-Max-Age', '300');
  return true;
}

/* The whole preamble both endpoints share. Returns true when the handler
   should stop, having already answered. */
function handledPreflight(req, res) {
  if (!applyCors(req, res)) {
    res.status(403).json({ error: 'Origin not allowed.' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

/* Where to send a shopper back to after Stripe.

   A checkout's success and cancel URLs, and the billing portal's return
   URL, are addresses Fynd hands to Stripe and Stripe redirects a
   browser to. Taking one from the request body would make this endpoint
   an open redirect with a payment page in front of it, so the origin is
   never taken from the request: it is the caller's Origin only if the
   list above already allows it, and the deployment's own host
   otherwise.

   A relative path may come from the caller, because the site is not
   always at the root of its origin — the Pages copy lives under a
   repository name. It is accepted only if it is genuinely relative: one
   leading slash, no scheme, no authority. "//evil.example/x" is a
   protocol-relative URL wearing a path's clothes, and is refused. */
function siteOrigin(req) {
  const origin = trimSlash((req.headers && req.headers.origin) || '');
  if (origin && isAllowed(req, origin)) return origin;
  const host = (req.headers && req.headers.host) || '';
  if (!host) return '';
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https';
  return `${scheme}://${host}`;
}

/* Where this function is actually running, which is not always where
   the site is. The Pages copy of Fynd calls functions on Vercel, so a
   link that has to be handled by a function — an email verification
   link — must address the Vercel host, while the page it finally lands
   the reader on is the site's. */
function deploymentOrigin(req) {
  const host = (req.headers && req.headers.host) || '';
  if (!host) return '';
  const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? 'http' : 'https';
  return `${scheme}://${host}`;
}

function returnUrl(req, path, fallback) {
  const origin = siteOrigin(req);
  const wanted = String(path == null ? '' : path);
  const safe = /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(wanted) ? wanted : String(fallback || '/');
  return `${origin}${safe}`;
}

module.exports = { applyCors, handledPreflight, configuredOrigins, isSameOrigin, isAllowed, siteOrigin, deploymentOrigin, returnUrl, SITE_ORIGINS };
