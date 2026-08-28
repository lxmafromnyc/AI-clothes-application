/* =========================================================
   Fynd — who is making this request

   Fynd had no accounts before billing: the site's own copy says "no
   filters, no account", and that stays true for searching. An account
   exists for one reason — a subscription has to belong to somebody, and
   a webhook arriving from Stripe has to be able to find them.

   So a request carries one of two identities:

     a signed-in user      a real account, with a Stripe customer and a
                           subscription behind it. The only identity a
                           paid plan can attach to.

     an anonymous visitor  no account. Always on the Free plan, metered
                           so the free allowance means something.

   ---------------------------------------------------------
   The session cookie
   ---------------------------------------------------------
   `fynd_session` holds 32 random bytes and nothing else. It is not a
   signed claim about who you are — it is a lookup key for a record the
   server keeps, and everything about the session lives in that record.

   That matters for four things a stateless token cannot do:

     logging out      really ends the session, because the record is
                      deleted. A cookie-clearing logout leaves a token
                      that still works if anybody kept a copy.
     rotation         a new token is issued the moment authentication
                      succeeds, and the pre-login one is deleted, so a
                      session id an attacker planted before sign-in is
                      not the session id afterwards.
     expiry           enforced on the record, not on a number the
                      holder of the token also holds.
     revocation       every session for a user can be dropped at once
                      by bumping `sessionEpoch` on the account, which is
                      what a password reset does.

   The store never holds the token itself: the key is
   `session:<HMAC(token)>` under AUTH_SECRET. A dump of the store is
   therefore not a set of usable cookies. Lookups are constant work and
   a token that does not resolve is simply absent — there is nothing to
   compare byte by byte.

   HttpOnly, so no script on the page can read it — including a script
   that got onto the page by accident. Secure and SameSite=None when the
   site and the functions are on different origins, which is this
   project's deployment (GitHub Pages calling Vercel) and the only way a
   cookie survives that trip; Lax when they share an origin, which is
   stricter and is what the all-on-Vercel deployment gets.

   AUTH_SECRET is required for accounts. Without it, sign-in and
   sign-up answer 503 and say so — a session signed with a default
   secret is a session anybody with the source can mint.

   ---------------------------------------------------------
   The anonymous id, and why it is not signed
   ---------------------------------------------------------
   `fynd_device` is an opaque random id with no signature. It is not a
   credential: forging one gets you a fresh Free allowance, which is
   also what clearing your cookies gets you. Signing it would imply it
   was worth more than it is.

   A caller that sends no cookies at all — curl, a script — is metered
   on a hash of its address and user agent instead, so the free
   allowance is not simply bypassed by ignoring Set-Cookie. Neither is
   airtight, and neither is asked to be: metering the free tier is about
   the API bill, and the paid tiers rest on a real account and a real
   subscription.

   ---------------------------------------------------------
   Passwords
   ---------------------------------------------------------
   scrypt, from node's own crypto — the repository has no dependencies
   and this needs none. Per-password salt, parameters stored alongside
   the hash so they can be raised later without invalidating anyone, and
   a timing-safe comparison.
   ========================================================= */

'use strict';

const crypto = require('crypto');

const store = require('./_store');
const { b64url } = require('./_tokens');

const SESSION_COOKIE = 'fynd_session';
const DEVICE_COOKIE = 'fynd_device';
/* Fourteen days, absolute. Not extended on use: a sliding window means
   a stolen cookie stays good for as long as the thief keeps using it,
   which is exactly the case the expiry exists for. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 14;
const DEVICE_MAX_AGE = 60 * 60 * 24 * 400;   /* long enough to outlive a period */

/* Sent to the page and required back as a header on any authenticated
   request that changes something. See csrfTokenFor() below. */
const CSRF_HEADER = 'x-fynd-csrf';

/* scrypt parameters. N=16384 keeps a sign-in comfortably under the
   time a serverless function has, and is far past what a stolen
   database can be run through at speed. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const secret = () => String(process.env.AUTH_SECRET || '').trim();
const accountsEnabled = () => secret().length >= 16;

/* ---------------------------------------------------------
   Passwords
   --------------------------------------------------------- */

const MIN_PASSWORD = 10;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/* False for anything that does not verify, including a stored value
   this function does not recognise. It never throws: a malformed hash
   is a failed sign-in, not a 500 that says the account exists. */
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, salt, expected] = parts;
  try {
    const hash = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), SCRYPT.keylen, {
      N: Number(n), r: Number(r), p: Number(p)
    });
    const want = Buffer.from(expected, 'base64');
    return hash.length === want.length && crypto.timingSafeEqual(hash, want);
  } catch (err) {
    return false;
  }
}

/* ---------------------------------------------------------
   Cookies
   --------------------------------------------------------- */

function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) || '';
  const out = {};
  String(header).split(';').forEach((pair) => {
    const at = pair.indexOf('=');
    if (at < 1) return;
    const name = pair.slice(0, at).trim();
    if (!name) return;
    try { out[name] = decodeURIComponent(pair.slice(at + 1).trim()); }
    catch (err) { out[name] = pair.slice(at + 1).trim(); }
  });
  return out;
}

/* A cookie has to survive the trip the deployment actually makes.

   Same-origin (everything on Vercel) gets SameSite=Lax, which is the
   stricter choice and enough. A page on another origin — the Pages site
   calling the Vercel functions — needs SameSite=None, and a browser
   only accepts None together with Secure. Deciding per request means
   neither deployment has a setting to get wrong. */
function cookieAttributes(req, options) {
  const origin = (req && req.headers && req.headers.origin) || '';
  const host = (req && req.headers && req.headers.host) || '';
  /* localhost over http cannot set a Secure cookie, and does not need
     to: nothing crosses a network there. */
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);

  /* An OAuth callback is a top-level navigation from Google and carries
     no Origin header, so the request itself cannot say whether the site
     that will read this cookie is on another host. The caller knows —
     it stored the origin the flow began at — and says so here. */
  const forced = options && typeof options.crossSite === 'boolean' ? options.crossSite : null;
  const crossSite = forced !== null
    ? forced
    : (Boolean(origin) && origin !== `https://${host}` && origin !== `http://${host}`);

  /* A browser only accepts SameSite=None together with Secure, so on
     plain-http localhost there is no cross-site cookie to be had; Lax
     is the honest answer rather than one the browser will discard. */
  if (crossSite && !local) return 'SameSite=None; Secure';
  return local ? 'SameSite=Lax' : 'SameSite=Lax; Secure';
}

/* Appends rather than replaces: a request may set both the session and
   the device cookie, and assigning Set-Cookie twice would lose one. */
function appendCookie(res, value) {
  const existing = res.getHeader ? res.getHeader('Set-Cookie') : null;
  const list = existing ? (Array.isArray(existing) ? existing.slice() : [existing]) : [];
  list.push(value);
  res.setHeader('Set-Cookie', list);
}

const setCookie = (req, res, name, value, maxAge, options) =>
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; ${cookieAttributes(req, options)}`);

const clearCookie = (req, res, name, options) =>
  appendCookie(res, `${name}=; Path=/; Max-Age=0; HttpOnly; ${cookieAttributes(req, options)}`);

/* ---------------------------------------------------------
   Sessions
   --------------------------------------------------------- */

const sessionKey = (token) => `session:${crypto
  .createHmac('sha256', secret()).update(`session:${token}`).digest('hex')}`;

/* The CSRF token is derived from the session token rather than stored
   beside it, so it cannot drift out of step with the session and is
   invalidated by the same rotation.

   It works because of what each side can see. The session cookie is
   HttpOnly, so a page on another origin cannot read it and therefore
   cannot compute this value; Fynd's own page is handed the value by
   /api/account and echoes it in a header. A cross-site form post — the
   one request shape that reaches a server without a preflight — cannot
   set a header at all. */
const csrfTokenFor = (sessionToken) => b64url(crypto
  .createHmac('sha256', secret()).update(`csrf:${sessionToken}`).digest());

/* Creates the record and returns the raw token for the cookie. */
async function issueSession(userId, options) {
  if (!accountsEnabled()) return null;
  const token = b64url(crypto.randomBytes(32));
  const now = Date.now();

  await store.set(sessionKey(token), {
    userId,
    /* the account's session epoch at the moment this was issued; a
       password reset raises the account's and orphans every session
       carrying the old one */
    epoch: Number((options && options.epoch) || 0),
    /* how the person proved who they were, so the interface can say
       "signed in with Google" without guessing */
    method: (options && options.method) || 'password',
    issuedAt: now,
    expiresAt: now + SESSION_MAX_AGE * 1000
  }, { ttlSeconds: SESSION_MAX_AGE });

  return token;
}

/* Resolves a cookie to a session record, or null.

   Every reason to refuse returns null and deletes nothing a legitimate
   holder would miss: no secret, a token that was never minted here, no
   record, an expired record, or a record from before the account's
   current epoch. A caller cannot tell them apart and does not need to. */
async function readSession(token) {
  if (!accountsEnabled()) return null;
  const raw = String(token || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;

  const record = await store.get(sessionKey(raw));
  if (!record || !record.userId) return null;

  if (!record.expiresAt || record.expiresAt <= Date.now()) {
    /* tidy up rather than leaving it to the TTL, so a store whose TTLs
       were misconfigured still cannot serve an expired session twice */
    await store.remove(sessionKey(raw));
    return null;
  }

  return record;
}

async function destroySession(token) {
  if (!accountsEnabled()) return false;
  const raw = String(token || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return false;
  await store.remove(sessionKey(raw));
  return true;
}

/* Signs somebody in, and rotates.

   The cookie the request arrived with — whatever it was, whoever set it
   — is destroyed before the new one is issued. That is the whole of
   session fixation defence: an attacker who managed to plant a known
   session id in somebody's browser does not hold the id that browser
   uses once the person authenticates. */
async function startSession(req, res, user, options) {
  const previous = parseCookies(req)[SESSION_COOKIE];
  if (previous) await destroySession(previous);

  const token = await issueSession(user.id, Object.assign({
    epoch: Number(user.sessionEpoch || 0)
  }, options || {}));

  if (!token) return null;
  setCookie(req, res, SESSION_COOKIE, token, SESSION_MAX_AGE, options);
  return token;
}

/* Ends it at both ends: the record is deleted so the token is dead
   everywhere, and the cookie is cleared so the browser stops sending
   one. Deleting only the cookie would leave a working session behind. */
async function endSession(req, res, options) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) await destroySession(token);
  clearCookie(req, res, SESSION_COOKIE, options);
  return true;
}

/* Does this request carry the CSRF token for its own session?

   Only asked of authenticated requests that change something. A request
   with no session has no session to forge against, and is already held
   to the Origin allow-list in _cors.js. */
function csrfOk(req, sessionToken) {
  if (!sessionToken) return true;
  const provided = String((req.headers && req.headers[CSRF_HEADER]) || '');
  const expected = csrfTokenFor(sessionToken);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------
   The anonymous subject
   --------------------------------------------------------- */

function clientAddress(req) {
  const forwarded = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/* Stable for one caller, and not reversible into an address: the
   fallback exists to meter a client that ignores cookies, not to keep
   a record of who it was. */
const addressSubject = (req) => 'ip_' + crypto.createHash('sha256')
  .update(`${clientAddress(req)}|${(req.headers && req.headers['user-agent']) || ''}`)
  .digest('hex').slice(0, 24);

function deviceSubject(req, res) {
  const existing = parseCookies(req)[DEVICE_COOKIE];
  if (existing && /^[a-f0-9]{24,64}$/.test(existing)) return `dev_${existing}`;
  const id = crypto.randomBytes(16).toString('hex');
  if (res) setCookie(req, res, DEVICE_COOKIE, id, DEVICE_MAX_AGE);
  return `dev_${id}`;
}

/* ---------------------------------------------------------
   The one call a handler makes
   --------------------------------------------------------- */

/* Resolves the request to a subject that usage is counted against and,
   when there is one, the account behind it.

   `plan` comes from the stored user record, which `_users.save` derives
   from the subscription. There is no branch here that reads a plan out
   of the request: a header, a cookie value or a body field naming a
   plan is not consulted, because a plan somebody can type is not a plan
   anybody has to pay for. */
async function identify(req, res, users) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  const session = await readSession(token);

  if (session) {
    const user = await users.byId(session.userId);

    /* Two ways a resolvable session still names nobody: the account was
       deleted, or its epoch has moved on because the password was
       reset. Both end the session rather than half-honouring it. */
    const stale = user && Number(user.sessionEpoch || 0) !== Number(session.epoch || 0);

    if (user && !stale) {
      return {
        user,
        session,
        sessionToken: token,
        csrfToken: csrfTokenFor(token),
        subject: `user:${user.id}`,
        plan: user.plan || 'free',
        /* Verification is reported, never enforced here. What an
           unverified account may and may not do is a decision each
           endpoint makes out loud — see api/checkout.js — rather than
           something this function quietly applies to all of them. */
        emailVerified: Boolean(user.emailVerified),
        method: session.method || 'password',
        anonymous: false
      };
    }

    if (res) await endSession(req, res);
  }

  /* No cookies at all means no Set-Cookie will be honoured either, so
     the address hash is the only stable thing on offer. */
  const subject = Object.keys(cookies).length || res
    ? deviceSubject(req, res)
    : addressSubject(req);

  return {
    user: null,
    session: null,
    sessionToken: null,
    csrfToken: null,
    subject,
    plan: 'free',
    emailVerified: false,
    method: null,
    anonymous: true
  };
}

module.exports = {
  SESSION_COOKIE,
  DEVICE_COOKIE,
  SESSION_MAX_AGE,
  CSRF_HEADER,
  MIN_PASSWORD,
  accountsEnabled,
  hashPassword,
  verifyPassword,
  parseCookies,
  cookieAttributes,
  setCookie,
  clearCookie,
  issueSession,
  readSession,
  destroySession,
  startSession,
  endSession,
  csrfTokenFor,
  csrfOk,
  identify,
  addressSubject,
  sessionKey
};
