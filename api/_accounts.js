/* =========================================================
   FindWear — who is being metered

   A limit needs someone to be a limit ON. FindWear has never had
   accounts, so this establishes the smallest identity that supports real
   enforcement without putting a login wall in front of a site that does
   not have logins yet.

   ---------------------------------------------------------
   Two kinds of caller
   ---------------------------------------------------------
   AUTHENTICATED — presents `Authorization: Bearer <token>`. The token is
   issued and signed by this server, so the plan inside it is a fact the
   server asserted, not a claim the browser made. Nothing a shopper can
   edit changes which plan they are on.

   ANONYMOUS — presents nothing. Gets the Free plan, metered against a
   key derived from their network address.

   ---------------------------------------------------------
   Why anonymous quota is keyed on the address, not on a cookie
   ---------------------------------------------------------
   A cookie or a localStorage id would be handed to the browser, and the
   browser is the thing being limited: clearing it would hand out a fresh
   allowance on demand and the daily limit would mean nothing. The
   address is not under the page's control, so the counter survives a
   cleared browser, an incognito window and a reinstall.

   The address is never stored. It is HMACed with a server secret and
   only the digest is used as a key, so the store holds no addresses and
   a leak of it reveals none.

   This is a floor, not a wall, and it is worth being exact about which:
   a new address — a VPN, a phone leaving wifi — is a new anonymous
   account, and everyone behind one office NAT shares a single Free
   allowance. Both are inherent to metering people who have not
   identified themselves. Real accounts are the fix, and the token path
   below is what they will arrive through.

   ---------------------------------------------------------
   A bad token is refused, not downgraded
   ---------------------------------------------------------
   No credential at all is anonymous. A credential that is present and
   does not verify — edited, expired, signed with another key — is 401.
   Quietly treating a forged token as an anonymous visitor would turn a
   break-in attempt into a normal page view and leave no trace of it.

   Environment
     SESSION_SECRET   required to issue or verify tokens, and used to
                      HMAC addresses. Without it no token verifies and
                      every caller is anonymous, keyed on a digest that
                      is still stable for this deployment.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const { planOf, isPlanId, DEFAULT_PLAN } = require('./_plans');

const TOKEN_PREFIX = 'fw1';
const DEFAULT_TOKEN_TTL = 60 * 60 * 24 * 30; /* 30 days */

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function secret() {
  const value = String(process.env.SESSION_SECRET || '').trim();
  return value || null;
}

/* Address digests still need a key when SESSION_SECRET is unset. This
   one is not secret and is not pretending to be: it keeps anonymous keys
   stable and unreadable, and it is the same on every instance, which is
   the property that matters. Tokens are a different matter and are
   refused outright without a real secret. */
const FALLBACK_SALT = 'findwear-anonymous-usage-v1';

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/* ---------------------------------------------------------
   Tokens
   --------------------------------------------------------- */

/* Issued by whatever eventually signs users in. Tests use it directly to
   put a caller on a plan. */
function issueToken(claims, options) {
  const key = secret();
  if (!key) throw new Error('SESSION_SECRET is required to issue a token.');
  const opts = options || {};
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String((claims && claims.sub) || '').trim(),
    plan: isPlanId(claims && claims.plan) ? String(claims.plan).toLowerCase() : DEFAULT_PLAN,
    iat: now,
    exp: now + (Number.isFinite(opts.ttlSeconds) ? opts.ttlSeconds : DEFAULT_TOKEN_TTL)
  };
  if (!payload.sub) throw new Error('A token needs a subject.');
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(hmac(key, `${TOKEN_PREFIX}.${body}`));
  return `${TOKEN_PREFIX}.${body}.${sig}`;
}

/* Returns the claims, or a reason it was refused. Never throws on bad
   input: every failure is a caller's failure, not the server's. */
function verifyToken(token) {
  const key = secret();
  if (!key) return { ok: false, reason: 'not_configured' };

  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };

  const expected = hmac(key, `${TOKEN_PREFIX}.${parts[1]}`);
  const given = unb64url(parts[2]);
  /* compared in constant time, and only when the lengths already match —
     timingSafeEqual throws on a length mismatch, which would itself be a
     signal */
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims;
  try {
    claims = JSON.parse(unb64url(parts[1]).toString('utf8'));
  } catch (err) {
    return { ok: false, reason: 'malformed' };
  }
  if (!claims || typeof claims !== 'object' || !claims.sub) return { ok: false, reason: 'malformed' };
  if (Number.isFinite(claims.exp) && claims.exp * 1000 <= Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, claims };
}

/* ---------------------------------------------------------
   The caller's address
   --------------------------------------------------------- */

/* Vercel replaces x-forwarded-for with the true client address and also
   supplies x-vercel-forwarded-for, so the platform headers are preferred
   over the general one. Where the general header is all there is, the
   first entry is the client. A caller can put anything in these; what
   they cannot do is make two different values collide with a third
   party's counter, so the worst case is that a determined visitor gets
   themselves a fresh Free allowance — which changing address already
   achieves. */
function clientAddress(req) {
  const headers = (req && req.headers) || {};
  const first = (value) => String(value || '').split(',')[0].trim();
  return first(headers['x-vercel-forwarded-for'])
    || first(headers['x-real-ip'])
    || first(headers['x-forwarded-for'])
    || (req && req.socket && req.socket.remoteAddress)
    || 'unknown';
}

const addressDigest = (address) =>
  b64url(hmac(secret() || FALLBACK_SALT, `addr:${address}`)).slice(0, 22);

/* ---------------------------------------------------------
   Resolution
   --------------------------------------------------------- */

function bearer(req) {
  const raw = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return match ? match[1].trim() : null;
}

/* The one function the handlers call.

   { ok: true,  account: { id, plan, authenticated, subject } }
   { ok: false, status, error, reason }                          */
function resolveAccount(req) {
  const token = bearer(req);

  if (token) {
    const result = verifyToken(token);
    if (!result.ok) {
      return {
        ok: false,
        status: 401,
        error: 'Sign-in could not be verified.',
        reason: result.reason
      };
    }
    return {
      ok: true,
      account: {
        id: `user:${result.claims.sub}`,
        subject: result.claims.sub,
        plan: planOf(result.claims.plan).id,
        authenticated: true
      }
    };
  }

  return {
    ok: true,
    account: {
      id: `anon:${addressDigest(clientAddress(req))}`,
      subject: null,
      plan: DEFAULT_PLAN,
      authenticated: false
    }
  };
}

/* The preamble both metered endpoints share: resolve the caller, or
   answer 401 and tell the handler to stop. Mirrors handledPreflight in
   _cors.js so a handler reads as a short list of gates. */
function requireAccount(req, res) {
  const resolved = resolveAccount(req);
  if (!resolved.ok) {
    /* the reason is logged, never returned: telling a caller whether a
       token was expired or forged helps only the forger */
    console.warn('Rejected credential:', resolved.reason);
    res.status(resolved.status).json({ error: resolved.error, code: 'unauthorized' });
    return null;
  }
  return resolved.account;
}

module.exports = {
  issueToken,
  requireAccount,
  verifyToken,
  resolveAccount,
  clientAddress,
  addressDigest,
  bearer,
  TOKEN_PREFIX,
  DEFAULT_TOKEN_TTL
};
