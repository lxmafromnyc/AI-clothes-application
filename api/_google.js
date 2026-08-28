/* =========================================================
   Fynd — Sign in with Google

   The authorization code flow with PKCE, run entirely server-side. The
   browser's only part is following two redirects; it never holds the
   client secret, never handles a Google password, and never tells Fynd
   who it is.

     1. /api/google-start   mints state, nonce and a PKCE verifier,
                            stores them, and redirects to Google.
     2. Google               authenticates the person. Fynd never sees
                            their password and never asks for it.
     3. /api/google-callback exchanges the code for tokens over TLS,
                            server to server, using the client secret.
     4. the ID token         is verified — signature, issuer, audience,
                            expiry, nonce — before a word of it is read.

   ---------------------------------------------------------
   Why every one of those checks is there
   ---------------------------------------------------------
   state     ties the callback to the browser that started the flow.
             Single-use and short-lived, and additionally bound to a
             cookie that only that browser has, so a callback replayed
             from anywhere else fails both halves. This is the CSRF
             defence: without it, an attacker can make somebody's
             browser complete *the attacker's* sign-in and quietly land
             them in the attacker's account.

   PKCE      the code is useless to anyone who did not start the flow.
             Google requires the verifier that matches the challenge,
             and the verifier never left this server.

   nonce     ties the ID token to this particular request, so a token
             minted for some other session cannot be presented here.

   signature the ID token is checked against Google's published keys
             before any claim in it is believed. The token does arrive
             over a direct TLS connection to Google, which is already
             strong — but "we fetched it from the right host" and "this
             document is authentic" are different statements, and only
             the second one survives a mistake in the first.

   aud       the token must be for THIS client id. A valid Google token
             minted for somebody else's app is still a valid Google
             token, and accepting one would let any app's users sign in
             as Fynd users.

   email_verified   Google says whether it has proved the address.
             Where it has not, Fynd does not treat the address as
             proved either, and the account goes through email
             verification like any other.

   ---------------------------------------------------------
   What is never logged
   ---------------------------------------------------------
   Not the code, the access token, the ID token, the refresh token, the
   client secret, the state, the nonce or the PKCE verifier. Failures
   log a reason word — "state-mismatch", "bad-signature" — and nothing
   else. The reason words are also all this module returns to a browser.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const tokens = require('./_tokens');

/* Overridable so the tests can stand up a fake issuer with a real key
   and exercise the actual verification code. Production never sets
   these, and there is no path by which a request can change them. */
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const JWKS_URL = () => process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = () => (process.env.GOOGLE_ISSUER
  ? [process.env.GOOGLE_ISSUER]
  : ['https://accounts.google.com', 'accounts.google.com']);

const clientId = () => String(process.env.GOOGLE_CLIENT_ID || '').trim();
const clientSecret = () => String(process.env.GOOGLE_CLIENT_SECRET || '').trim();

const configured = () => Boolean(clientId() && clientSecret());

/* The redirect URI has to be identical here and in the Google console,
   character for character, so it is built from one function. No query
   string: Google matches the whole thing, and a parameter added later
   would silently break every sign-in. */
const redirectUri = (origin) => `${String(origin || '').replace(/\/+$/, '')}/api/google-callback`;

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (value) => Buffer.from(
  String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ---------------------------------------------------------
   Starting the flow
   --------------------------------------------------------- */

/* PKCE, S256. The verifier stays on the server; only its hash travels
   with the redirect the browser follows. */
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/* Everything the callback will need to check, stored under the state
   token and nowhere else. The browser carries the state value; it does
   not carry the verifier or the nonce. */
async function beginFlow({ origin, returnPath, site }) {
  const { verifier, challenge } = pkce();
  const nonce = b64url(crypto.randomBytes(16));
  /* proves the callback reached the same browser that started, even if
     the state value itself were somehow observed */
  const binding = b64url(crypto.randomBytes(16));

  const { token: state } = await tokens.issue(tokens.PURPOSE.OAUTH_STATE, {
    verifier,
    nonce,
    binding,
    redirectUri: redirectUri(origin),
    /* Where to send the browser at the end. Recorded at the start, from
       an origin the allow-list already accepted, so the callback never
       has to take a destination from its own query string — which is
       how an OAuth callback becomes an open redirect. */
    site: typeof site === 'string' ? site : '',
    returnPath: typeof returnPath === 'string' ? returnPath : '/account.html'
  });

  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    /* asks Google to show the account chooser rather than silently
       reusing whichever account the browser last used */
    prompt: 'select_account'
  });

  return { url: `${AUTH_URL()}?${params.toString()}`, state, binding };
}

/* ---------------------------------------------------------
   Verifying the ID token
   --------------------------------------------------------- */

/* Google's signing keys, cached for an hour. Fetched over TLS from
   Google's published JWKS endpoint; a key id the set does not contain
   is a token this code refuses rather than a key it goes looking for
   somewhere else. */
let jwksCache = { fetchedAt: 0, keys: [] };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function signingKeys(force) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const response = await fetch(JWKS_URL());
  if (!response.ok) throw Object.assign(new Error('jwks-unavailable'), { reason: 'jwks-unavailable' });
  const payload = await response.json();
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  jwksCache = { fetchedAt: Date.now(), keys };
  return keys;
}

const resetJwksCache = () => { jwksCache = { fetchedAt: 0, keys: [] }; };

function decodeSegment(segment) {
  try { return JSON.parse(fromB64url(segment).toString('utf8')); }
  catch (err) { return null; }
}

/* Returns the claims, or throws with a one-word reason.

   Nothing is read out of the token until after the signature check —
   the header's `kid` and `alg` are the only fields touched first, and
   both are used to choose a key rather than to decide anything. */
async function verifyIdToken(idToken, { nonce, now }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('malformed'), { reason: 'malformed-token' });

  const header = decodeSegment(parts[0]);
  if (!header) throw Object.assign(new Error('malformed'), { reason: 'malformed-token' });

  /* RS256 only. "alg": "none" and a symmetric algorithm keyed by the
     public key are the two classic ways to forge a JWT, and naming the
     one algorithm we accept closes both. */
  if (header.alg !== 'RS256') throw Object.assign(new Error('alg'), { reason: 'unsupported-algorithm' });

  const signed = `${parts[0]}.${parts[1]}`;
  const signature = fromB64url(parts[2]);

  const matches = async (force) => {
    const keys = await signingKeys(force);
    return keys.filter((key) => !header.kid || key.kid === header.kid);
  };

  /* A key id that is not in the cached set is usually Google having
     rotated, so the set is fetched once more before the token is
     refused. */
  let candidates = await matches(false);
  if (!candidates.length) candidates = await matches(true);
  if (!candidates.length) throw Object.assign(new Error('kid'), { reason: 'unknown-key' });

  const verified = candidates.some((jwk) => {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      return crypto.verify('RSA-SHA256', Buffer.from(signed), key, signature);
    } catch (err) {
      return false;
    }
  });
  if (!verified) throw Object.assign(new Error('signature'), { reason: 'bad-signature' });

  const claims = decodeSegment(parts[1]);
  if (!claims) throw Object.assign(new Error('claims'), { reason: 'malformed-token' });

  const seconds = Math.floor((now || Date.now()) / 1000);

  if (!ISSUERS().includes(String(claims.iss))) {
    throw Object.assign(new Error('iss'), { reason: 'wrong-issuer' });
  }
  /* aud may be a string or an array; ours must be in it */
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId())) {
    throw Object.assign(new Error('aud'), { reason: 'wrong-audience' });
  }
  /* when azp is present it must also be us, which is what stops a token
     minted for another client that merely lists us as an audience */
  if (claims.azp && claims.azp !== clientId()) {
    throw Object.assign(new Error('azp'), { reason: 'wrong-audience' });
  }
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= seconds) {
    throw Object.assign(new Error('exp'), { reason: 'expired-token' });
  }
  /* a small allowance for clock skew, in one direction only */
  if (Number.isFinite(Number(claims.iat)) && Number(claims.iat) > seconds + 300) {
    throw Object.assign(new Error('iat'), { reason: 'token-from-the-future' });
  }
  if (nonce && claims.nonce !== nonce) {
    throw Object.assign(new Error('nonce'), { reason: 'nonce-mismatch' });
  }
  if (!claims.sub) throw Object.assign(new Error('sub'), { reason: 'no-subject' });
  if (!claims.email) throw Object.assign(new Error('email'), { reason: 'no-email' });

  return claims;
}

/* ---------------------------------------------------------
   Exchanging the code
   --------------------------------------------------------- */

/* Server to server, over TLS, carrying the client secret and the PKCE
   verifier. The browser is not involved and never sees either. */
async function exchangeCode({ code, verifier, redirect }) {
  const response = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirect,
      grant_type: 'authorization_code',
      code_verifier: verifier
    }).toString()
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    /* Google's error CODE only — never its description, which quotes
       the request and can carry the code back into a log line. */
    console.error('Google token exchange refused:', response.status, payload.error || 'unknown');
    throw Object.assign(new Error('exchange'), { reason: 'exchange-failed' });
  }
  if (!payload.id_token) {
    throw Object.assign(new Error('no-id-token'), { reason: 'no-id-token' });
  }

  return payload;
}

/* The whole callback half: exchange, verify, and hand back only the
   four fields Fynd has any use for. The tokens themselves are not
   returned, stored or logged — Fynd needs an identity, not an ongoing
   authorisation to act as this person at Google. */
async function completeFlow({ code, verifier, nonce, redirect, now }) {
  const bundle = await exchangeCode({ code, verifier, redirect });
  const claims = await verifyIdToken(bundle.id_token, { nonce, now });

  return {
    sub: String(claims.sub),
    email: String(claims.email).trim().toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name.trim().slice(0, 80) : ''
  };
}

const state = () => ({
  configured: configured(),
  clientId: clientId() ? `${clientId().slice(0, 12)}…` : null
});

module.exports = {
  configured,
  redirectUri,
  beginFlow,
  completeFlow,
  exchangeCode,
  verifyIdToken,
  signingKeys,
  resetJwksCache,
  state,
  b64url,
  AUTH_URL,
  TOKEN_URL,
  JWKS_URL
};
