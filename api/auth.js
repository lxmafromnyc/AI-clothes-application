/* =========================================================
   Fynd — sign up, sign in, sign out, verify, reset

   POST /api/auth  { action, … }

     signup               name, email, password, confirmPassword
     login                email, password
     logout               —                        (session + CSRF)
     resend-verification  —                        (session + CSRF)
     forgot-password      email
     reset-password       token, password, confirmPassword

   An account exists so a subscription has somewhere to live and a
   Stripe webhook has somebody to find. Searching still needs none: the
   Free plan is metered per browser and the pages say what they always
   said.

   ---------------------------------------------------------
   What this endpoint will not tell you
   ---------------------------------------------------------
   Whether an address has an account.

     - a wrong password and an unknown address give the same 401, in the
       same time, because the password is hashed either way — against a
       decoy when there is no user, so the two cannot be told apart by
       how long they took.
     - "forgot password" always answers the same way, whether or not
       anything was sent.

   Sign-up is the one place that cannot hide it: the address either gets
   an account or it does not. So it says so plainly and points at
   signing in, rather than pretending to have worked and leaving
   somebody waiting for an email that was never coming.

   ---------------------------------------------------------
   What it will not accept
   ---------------------------------------------------------
   A plan, a subscription, a verification state, a role, an id. The only
   fields read are the ones listed above. `emailVerified: true` in a
   sign-up body is not read, and could not do anything if it were:
   verification is set by following a link sent to the address, and by
   Google having already proved it.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const { handledPreflight, siteOrigin, deploymentOrigin } = require('./_cors');
const { readJson } = require('./_body');
const store = require('./_store');
const users = require('./_users');
const auth = require('./_auth');
const tokens = require('./_tokens');
const email = require('./_email');
const limits = require('./_ratelimit');
const google = require('./_google');
const { accountPayload } = require('./_billing');

/* Hashing a password against this costs the same as hashing against a
   real one, so "no such account" takes as long as "wrong password". */
const DECOY = auth.hashPassword(crypto.randomBytes(24).toString('hex'));

const MAX_NAME = 80;

/* ---------------------------------------------------------
   Sending the two links
   ---------------------------------------------------------
   The link has to be handled by a function, so it addresses the host
   these functions run on. Where it finally lands the reader is the site
   they were on, which is recorded in the token and used by
   /api/verify-email. On the all-on-Vercel deployment the two are the
   same host; on the Pages-plus-Vercel one they are not. */

async function sendVerification(req, user) {
  if (!email.configured()) {
    return { sent: false, reason: email.unconfiguredReason() };
  }

  const hours = Math.round(tokens.TTL[tokens.PURPOSE.VERIFY_EMAIL] / 3600);
  const { token } = await tokens.issue(tokens.PURPOSE.VERIFY_EMAIL, {
    userId: user.id,
    /* pinned to the address it was sent to, so a link stays valid only
       for the address that received it even if the account's changes */
    email: user.email,
    site: siteOrigin(req)
  });

  const url = `${deploymentOrigin(req)}/api/verify-email?token=${encodeURIComponent(token)}`;
  const result = await email.send(email.verificationMessage({
    to: user.email, name: user.name, url, hours
  }));

  /* the outcome, never the link */
  console.log(`Verification email for ${user.id}: ${result.sent ? 'sent' : `not sent (${result.reason})`}`);
  return result;
}

async function sendPasswordReset(req, user) {
  if (!email.configured()) return { sent: false, reason: email.unconfiguredReason() };

  const hours = Math.round(tokens.TTL[tokens.PURPOSE.RESET_PASSWORD] / 3600);
  const { token } = await tokens.issue(tokens.PURPOSE.RESET_PASSWORD, {
    userId: user.id,
    email: user.email,
    /* the epoch at issue: a reset link stops working the moment any
       other reset succeeds, so two links in one inbox cannot both be
       spent */
    epoch: Number(user.sessionEpoch || 0)
  });

  /* Lands on the page, not on an endpoint: the page takes the token out
     of the URL immediately and holds it in memory, so it does not stay
     in history or get bookmarked. */
  const url = `${siteOrigin(req)}/account.html?reset=${encodeURIComponent(token)}`;
  const result = await email.send(email.passwordResetMessage({
    to: user.email, name: user.name, url, hours
  }));

  console.log(`Password reset email for ${user.id}: ${result.sent ? 'sent' : `not sent (${result.reason})`}`);
  return result;
}

/* ---------------------------------------------------------
   Replies
   --------------------------------------------------------- */

/* The reply a signed-in caller gets, including the CSRF token for the
   session that was just issued.

   Getting this wrong is quiet and expensive: without the token here,
   the page has no way to make its FIRST state-changing request — the
   logout button, the resend button and the upgrade button would each
   fail once, and only once, until something else re-read /api/account.
   So the session token is threaded through from startSession rather
   than left for the next request to discover. */
async function answer(req, res, user, extra, sessionToken) {
  const token = sessionToken || auth.parseCookies(req)[auth.SESSION_COOKIE] || null;

  const identity = {
    user,
    subject: `user:${user.id}`,
    plan: user.plan,
    emailVerified: Boolean(user.emailVerified),
    anonymous: false,
    sessionToken: token,
    csrfToken: token ? auth.csrfTokenFor(token) : null
  };

  const payload = await accountPayload(identity);
  res.setHeader('Cache-Control', 'no-store, private');
  return res.status(200).json(Object.assign(payload, extra || {}));
}

const rateLimited = (res, result) => res.status(429).json({
  error: result.reason === 'too-soon'
    ? `Give it ${result.retryAfter} more second${result.retryAfter === 1 ? '' : 's'} before trying again.`
    : 'Too many attempts. Try again later.',
  reason: result.reason,
  retryAfter: result.retryAfter
});

/* ---------------------------------------------------------
   The handler
   --------------------------------------------------------- */

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const body = await readJson(req);
  const action = String(body.action || '').trim();
  const address = auth.addressSubject(req);

  /* --------------------------------------------------- logout */
  if (action === 'logout') {
    /* CSRF: a session-bearing state change. A cross-site page cannot
       read the HttpOnly cookie, so it cannot compute this header. */
    const current = auth.parseCookies(req)[auth.SESSION_COOKIE];
    if (current && !auth.csrfOk(req, current)) {
      return res.status(403).json({ error: 'Missing or invalid CSRF token.', reason: 'csrf' });
    }
    await auth.endSession(req, res);
    res.setHeader('Cache-Control', 'no-store, private');
    return res.status(200).json(await accountPayload({
      user: null, subject: 'signed-out', plan: 'free', anonymous: true, emailVerified: false
    }));
  }

  if (!auth.accountsEnabled()) {
    console.warn('Accounts are disabled: AUTH_SECRET is missing or too short.');
    return res.status(503).json({ error: 'Accounts are not configured on this deployment.', reason: 'no-auth-secret' });
  }

  /* --------------------------------------------------- resend verification */
  if (action === 'resend-verification') {
    const identity = await auth.identify(req, res, users);
    if (!identity.user) return res.status(401).json({ error: 'Sign in first.', reason: 'sign-in-required' });
    if (identity.sessionToken && !auth.csrfOk(req, identity.sessionToken)) {
      return res.status(403).json({ error: 'Missing or invalid CSRF token.', reason: 'csrf' });
    }
    if (identity.user.emailVerified) {
      return answer(req, res, identity.user,
        { verification: { sent: false, reason: 'already-verified' } }, identity.sessionToken);
    }

    const gate = await limits.checkAll('auth:resend-verification', [identity.user.id, address]);
    if (!gate.allowed) return rateLimited(res, gate);

    const result = await sendVerification(req, identity.user);
    await limits.noteAll('auth:resend-verification', [identity.user.id, address]);
    return answer(req, res, identity.user, { verification: result }, identity.sessionToken);
  }

  /* --------------------------------------------------- reset password */
  if (action === 'reset-password') {
    const gate = await limits.check('auth:reset-password', address);
    if (!gate.allowed) return rateLimited(res, gate);
    await limits.note('auth:reset-password', address);

    const password = typeof body.password === 'string' ? body.password : '';
    const confirm = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

    if (password.length < auth.MIN_PASSWORD) {
      return res.status(400).json({ error: `Use at least ${auth.MIN_PASSWORD} characters for your password.` });
    }
    if (password !== confirm) {
      return res.status(400).json({ error: 'Those passwords do not match.' });
    }

    /* Spent here — a reset link works once, whether or not the new
       password turns out to be acceptable is checked first so a typo
       does not burn the link. */
    const spent = await tokens.consume(tokens.PURPOSE.RESET_PASSWORD, body.token);
    if (!spent.ok) {
      return res.status(400).json({
        error: spent.reason === 'expired'
          ? 'That reset link has expired. Ask for a new one.'
          : 'That reset link is not valid. It may already have been used.',
        reason: spent.reason
      });
    }

    const user = await users.byId(spent.payload.userId);
    if (!user) return res.status(400).json({ error: 'That reset link is not valid.', reason: 'invalid' });
    /* a link issued before another reset succeeded is stale */
    if (Number(spent.payload.epoch || 0) !== Number(user.sessionEpoch || 0)) {
      return res.status(400).json({ error: 'That reset link is no longer valid.', reason: 'superseded' });
    }

    /* setPassword raises the session epoch, which signs out every
       device this account was signed in on — including whoever prompted
       the reset, if it was not the owner. */
    const updated = await users.setPassword(user, auth.hashPassword(password));

    /* Reaching the inbox proved the address, so an account that was
       waiting on verification no longer is. */
    const verified = await users.markVerified(updated);

    const token = await auth.startSession(req, res, verified, { method: 'password' });
    return answer(req, res, verified, { passwordReset: true }, token);
  }

  /* everything below needs a well-formed address */
  const emailAddress = users.normaliseEmail(body.email);

  /* --------------------------------------------------- forgot password */
  if (action === 'forgot-password') {
    /* One answer, always. Whether an account exists, whether it has a
       password at all, and whether the email provider is configured are
       all invisible from here — the only thing that varies is whether
       an email actually arrives. */
    const same = () => res.status(200).json({
      ok: true,
      message: 'If there is a Fynd account for that address, a reset link is on its way.',
      /* the deployment's own configuration is not a secret, and hiding
         it would leave somebody waiting forever for an email that
         nothing was ever going to send */
      emailConfigured: email.configured()
    });

    if (!users.looksLikeEmail(emailAddress)) return same();

    const gate = await limits.checkAll('auth:forgot-password', [emailAddress, address]);
    if (!gate.allowed) return rateLimited(res, gate);
    await limits.noteAll('auth:forgot-password', [emailAddress, address]);

    const user = await users.byEmail(emailAddress);
    /* No password on the account means it is a Google sign-in, and a
       reset link would set one where the owner never had one. Silent by
       design: saying so would answer "does this address have an
       account", which is the question this whole branch refuses. */
    if (user && user.passwordHash) await sendPasswordReset(req, user);

    return same();
  }

  if (!users.looksLikeEmail(emailAddress)) {
    return res.status(400).json({ error: 'That does not look like an email address.' });
  }

  const password = typeof body.password === 'string' ? body.password : '';

  /* --------------------------------------------------- sign up */
  if (action === 'signup') {
    const gate = await limits.check('auth:signup', address);
    if (!gate.allowed) return rateLimited(res, gate);

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, MAX_NAME) : '';
    const confirm = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';

    if (!name) return res.status(400).json({ error: 'Tell us what to call you.', field: 'name' });
    if (password.length < auth.MIN_PASSWORD) {
      return res.status(400).json({ error: `Use at least ${auth.MIN_PASSWORD} characters for your password.`, field: 'password' });
    }
    if (password !== confirm) {
      return res.status(400).json({ error: 'Those passwords do not match.', field: 'confirmPassword' });
    }

    const { user, reason } = await users.create({
      email: emailAddress,
      name,
      passwordHash: auth.hashPassword(password),
      /* Never from the request. An account made here is unverified, and
         becomes verified by somebody following a link sent to the
         address — which is the only evidence that anybody owns it. */
      emailVerified: false
    });

    if (!user) {
      return res.status(409).json({
        error: 'There is already an account for that address. Try signing in.',
        reason
      });
    }

    await limits.note('auth:signup', address);

    const verification = await sendVerification(req, user);
    await limits.noteAll('auth:resend-verification', [user.id, address]);

    const token = await auth.startSession(req, res, user, { method: 'password' });
    return answer(req, res, user, { verification, created: true }, token);
  }

  /* --------------------------------------------------- log in */
  if (action === 'login') {
    const gate = await limits.checkAll('auth:login', [address]);
    if (!gate.allowed) return rateLimited(res, gate);

    const user = await users.byEmail(emailAddress);
    /* Hashed either way, so the two failures take the same time. */
    const ok = auth.verifyPassword(password, (user && user.passwordHash) || DECOY);

    if (!user || !user.passwordHash || !ok) {
      await limits.note('auth:login', address);
      /* One sentence for all three. Which of them it was is exactly the
         thing this must not reveal. */
      return res.status(401).json({ error: 'That email and password do not match.' });
    }

    await limits.clear('auth:login', address);

    /* Signing in is allowed while unverified — the alternative is
       somebody locked out of the page that explains how to get
       verified. What is NOT allowed is an unverified account quietly
       behaving like a verified one: the reply says so, the page says
       so, and /api/checkout refuses. */
    const token = await auth.startSession(req, res, user, { method: 'password' });
    return answer(req, res, user, null, token);
  }

  return res.status(400).json({ error: 'Unknown action.' });
};

module.exports.sendVerification = sendVerification;
module.exports.sendPasswordReset = sendPasswordReset;
