/* =========================================================
   Fynd — finish a Google sign-in

   GET /api/google-callback?code=…&state=…

   This is the redirect URI registered in the Google console. It has no
   query string of its own for exactly that reason: Google matches the
   registered URI character for character, and a parameter added here
   later would break every sign-in at once.

   ---------------------------------------------------------
   Nothing in this request is believed
   ---------------------------------------------------------
   The browser arrives carrying a `code` and a `state`, and neither is
   evidence of anything on its own. In order:

     1. `state` is spent — single-use, via the store's GETDEL — and must
        resolve to a record this server wrote ten minutes ago. A made-up
        or already-used state resolves to nothing and stops here.
     2. the binding cookie in this browser must match the binding in
        that record. A captured callback URL replayed from another
        browser has the state and not the cookie.
     3. `code` is exchanged with Google directly, server to server, with
        the client secret and the PKCE verifier that never left here.
     4. the ID token that comes back is verified — signature against
        Google's published keys, issuer, audience, expiry, nonce —
        before a single claim in it is read.

   Only then is there an identity, and it came from Google over TLS,
   not from the browser. There is no parameter on this URL that says who
   somebody is, and no branch below that would read one if there were.

   ---------------------------------------------------------
   Which account it becomes
   ---------------------------------------------------------
     a known Google subject   -> that account
     a known email address    -> that account, with Google attached
     neither                  -> a new account, already verified,
                                 because Google proved the address

   The second case is the one worth stating plainly: signing in with
   Google using an address that already has a password account signs
   you into that account. It does not make a second one, and it does not
   fork your subscription or your usage away from the account you had.

   Google's `email_verified` is honoured rather than assumed. Where
   Google has not proved the address, Fynd does not treat it as proved
   and the account goes through email verification like any other.
   ========================================================= */

'use strict';

const { siteOrigin } = require('./_cors');
const auth = require('./_auth');
const tokens = require('./_tokens');
const users = require('./_users');
const google = require('./_google');
const { BINDING_COOKIE } = require('./google-start');

/* Every exit from this handler is a redirect: the browser navigated
   here and has to end up somewhere. `reason` is always one of the fixed
   words below — never Google's text, never anything from the query
   string, so nothing a caller writes can be reflected onto the page. */
function bounce(res, site, path, params) {
  const query = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', `${site}${path}${query ? `?${query}` : ''}`);
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

const failed = (res, site, reason) =>
  bounce(res, site, '/account.html', { auth: 'error', reason });

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });

  const url = new URL(req.url, `https://${(req.headers && req.headers.host) || 'localhost'}`);
  const fallbackSite = siteOrigin(req);

  if (!google.configured() || !auth.accountsEnabled()) {
    return failed(res, fallbackSite, 'google-not-configured');
  }

  /* The person pressed "cancel" on Google's screen, or Google refused.
     Google's own error word is not echoed: it goes in the log, and the
     browser is told, in Fynd's words, that the sign-in did not finish. */
  const googleError = url.searchParams.get('error');
  if (googleError) {
    console.warn('Google returned an error for a sign-in:', String(googleError).slice(0, 40));
    return failed(res, fallbackSite, googleError === 'access_denied' ? 'cancelled' : 'google-refused');
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return failed(res, fallbackSite, 'incomplete-callback');

  /* 1. Spend the state. Single-use: a second callback carrying the same
        value finds nothing, which is what stops a replay. */
  const spent = await tokens.consume(tokens.PURPOSE.OAUTH_STATE, state);
  if (!spent.ok) {
    console.warn('Rejected a Google callback:', spent.reason === 'expired' ? 'state-expired' : 'state-invalid');
    return failed(res, fallbackSite, spent.reason === 'expired' ? 'sign-in-expired' : 'state-mismatch');
  }

  const flow = spent.payload;
  const site = flow.site || fallbackSite;

  /* 2. And it has to be the browser that started. */
  const binding = auth.parseCookies(req)[BINDING_COOKIE];
  if (!binding || binding !== flow.binding) {
    console.warn('Rejected a Google callback: binding-mismatch');
    return failed(res, site, 'state-mismatch');
  }
  auth.clearCookie(req, res, BINDING_COOKIE);

  /* 3 and 4. Exchange and verify. Reasons are logged as single words;
     no token, code or claim is written anywhere. */
  let identity;
  try {
    identity = await google.completeFlow({
      code,
      verifier: flow.verifier,
      nonce: flow.nonce,
      redirect: flow.redirectUri
    });
  } catch (err) {
    console.error('Google sign-in failed:', (err && err.reason) || 'unknown');
    return failed(res, site, 'verification-failed');
  }

  /* The cookie has to reach whichever origin the person is browsing.
     When the site and these functions share a host that is Lax; when
     the site is elsewhere — the Pages copy calling Vercel — it has to
     be None, and only the flow's own record knows which. */
  const crossSite = site !== siteOrigin(req);

  try {
    /* a known Google subject */
    let user = await users.byGoogleSub(identity.sub);

    if (!user) {
      /* the same person, already here with a password */
      const existing = await users.byEmail(identity.email);
      if (existing) {
        user = identity.emailVerified
          ? await users.linkGoogle(existing, identity.sub, identity.name)
          : existing;
        if (!identity.emailVerified) {
          /* Google has not proved this address, so it is not proof of
             ownership of an account that already exists under it.
             Signing in would be taking somebody's account on the word
             of an unverified address. */
          console.warn('Refused to link an unverified Google address to an existing account.');
          return failed(res, site, 'google-email-unverified');
        }
      }
    }

    if (!user) {
      const created = await users.create({
        email: identity.email,
        name: identity.name,
        passwordHash: null,
        emailVerified: identity.emailVerified,
        googleSub: identity.sub
      });
      /* Somebody signed up with this address in the moment between the
         lookup above and here. Retry the lookup rather than losing the
         sign-in; the address is unique, so one of them is the account. */
      user = created.user || await users.byEmail(identity.email);
      if (!user) return failed(res, site, 'could-not-create-account');
      if (!created.user && identity.emailVerified) {
        user = await users.linkGoogle(user, identity.sub, identity.name);
      }
    }

    /* Rotates: whatever session this browser had is destroyed and a new
       one issued, so a session id planted before sign-in is not the
       session id after it. */
    await auth.startSession(req, res, user, { method: 'google', crossSite });

    return bounce(res, site, flow.returnPath || '/account.html', { auth: 'signed-in' });
  } catch (err) {
    console.error('Could not complete a Google sign-in:', err && err.message);
    return failed(res, site, 'could-not-sign-in');
  }
};
