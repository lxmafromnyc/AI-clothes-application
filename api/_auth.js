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
   `fynd_session` holds `<userId>.<issuedAt>.<nonce>` with an HMAC over
   it, keyed by AUTH_SECRET. Nothing in the cookie is trusted until the
   HMAC verifies, and the comparison is timing-safe, so a forged cookie
   cannot be searched for one byte at a time.

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

const SESSION_COOKIE = 'fynd_session';
const DEVICE_COOKIE = 'fynd_device';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;   /* 30 days */
const DEVICE_MAX_AGE = 60 * 60 * 24 * 400;   /* long enough to outlive a period */

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
function cookieAttributes(req) {
  const origin = (req && req.headers && req.headers.origin) || '';
  const host = (req && req.headers && req.headers.host) || '';
  const crossSite = Boolean(origin) && origin !== `https://${host}` && origin !== `http://${host}`;
  /* localhost over http cannot set a Secure cookie, and does not need
     to: nothing crosses a network there. */
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  if (crossSite) return 'SameSite=None; Secure';
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

const setCookie = (req, res, name, value, maxAge) =>
  appendCookie(res, `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; ${cookieAttributes(req)}`);

const clearCookie = (req, res, name) =>
  appendCookie(res, `${name}=; Path=/; Max-Age=0; HttpOnly; ${cookieAttributes(req)}`);

/* ---------------------------------------------------------
   Session tokens
   --------------------------------------------------------- */

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sign = (payload) => b64url(crypto.createHmac('sha256', secret()).update(payload).digest());

function issueSession(userId) {
  if (!accountsEnabled()) return null;
  const payload = `${userId}.${Math.floor(Date.now() / 1000)}.${crypto.randomBytes(9).toString('hex')}`;
  return `${payload}.${sign(payload)}`;
}

/* Returns the user id a token names, or null. Every reason to reject —
   no secret, wrong shape, bad signature, expired — returns null: a
   caller cannot tell them apart, and does not need to. */
function readSession(token) {
  if (!accountsEnabled()) return null;
  const raw = String(token || '');
  const cut = raw.lastIndexOf('.');
  if (cut < 1) return null;

  const payload = raw.slice(0, cut);
  const provided = Buffer.from(raw.slice(cut + 1));
  const expected = Buffer.from(sign(payload));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  const [userId, issued] = payload.split('.');
  if (!userId || !issued) return null;
  if (Math.floor(Date.now() / 1000) - Number(issued) > SESSION_MAX_AGE) return null;
  return userId;
}

const startSession = (req, res, userId) => {
  const token = issueSession(userId);
  if (token) setCookie(req, res, SESSION_COOKIE, token, SESSION_MAX_AGE);
  return Boolean(token);
};

const endSession = (req, res) => clearCookie(req, res, SESSION_COOKIE);

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
  const userId = readSession(cookies[SESSION_COOKIE]);

  if (userId) {
    const user = await users.byId(userId);
    if (user) {
      return { user, subject: `user:${user.id}`, plan: user.plan || 'free', anonymous: false };
    }
    /* the cookie verified but names an account that is gone */
    if (res) endSession(req, res);
  }

  /* No cookies at all means no Set-Cookie will be honoured either, so
     the address hash is the only stable thing on offer. */
  const subject = Object.keys(cookies).length || res
    ? deviceSubject(req, res)
    : addressSubject(req);

  return { user: null, subject, plan: 'free', anonymous: true };
}

module.exports = {
  SESSION_COOKIE,
  DEVICE_COOKIE,
  SESSION_MAX_AGE,
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
  startSession,
  endSession,
  identify,
  addressSubject
};
