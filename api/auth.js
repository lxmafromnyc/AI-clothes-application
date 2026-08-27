/* =========================================================
   Fynd — sign up, sign in, sign out

   An account exists so a subscription has somewhere to live. Searching
   still needs none: the Free plan is metered per visitor and the pages
   say what they always said.

   POST { action: "signup" | "login" | "logout", email, password }

   ---------------------------------------------------------
   What this endpoint will not do
   ---------------------------------------------------------
   It will not tell an attacker which addresses have accounts. A wrong
   password and an address with no account give the same answer, in the
   same time — the password is hashed either way, against a decoy when
   there is no user, so the reply cannot be timed apart.

   It will not accept a plan. Nothing in the body but an address and a
   password is read; a `plan` field in a sign-up would be a paid plan
   anybody could ask for.

   ---------------------------------------------------------
   Rate limiting
   ---------------------------------------------------------
   Failed sign-ins are counted per address hash for fifteen minutes, and
   refused past a threshold. Counted on failure only, so somebody
   signing in correctly is never locked out, and the counter is cleared
   by a success.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const { handledPreflight } = require('./_cors');
const { readJson } = require('./_body');
const store = require('./_store');
const users = require('./_users');
const auth = require('./_auth');
const { accountPayload } = require('./_billing');

const ATTEMPT_WINDOW = 60 * 15;
const MAX_ATTEMPTS = 10;

/* Hashing a password against this costs the same as hashing against a
   real one, so "no such account" takes as long as "wrong password". */
const DECOY = auth.hashPassword(crypto.randomBytes(24).toString('hex'));

const attemptKey = (req) => `auth:attempts:${auth.addressSubject(req)}`;

async function tooManyAttempts(req) {
  return (await store.readNumber(attemptKey(req))) >= MAX_ATTEMPTS;
}

const noteFailure = (req) => store.add(attemptKey(req), 1, { ttlSeconds: ATTEMPT_WINDOW });
const clearFailures = (req) => store.remove(attemptKey(req));

async function answer(req, res, user) {
  const identity = { user, subject: `user:${user.id}`, plan: user.plan, anonymous: false };
  res.setHeader('Cache-Control', 'no-store, private');
  return res.status(200).json(await accountPayload(identity));
}

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const body = await readJson(req);
  const action = String(body.action || '').trim();

  if (action === 'logout') {
    auth.endSession(req, res);
    res.setHeader('Cache-Control', 'no-store, private');
    return res.status(200).json(await accountPayload({ user: null, subject: 'signed-out', plan: 'free', anonymous: true }));
  }

  if (!auth.accountsEnabled()) {
    /* A session signed with a guessable secret is not a session. Saying
       which variable is missing is safe — its absence is already
       obvious from here, and naming it is the difference between a
       fixable deployment and a mysterious one. */
    console.warn('Accounts are disabled: AUTH_SECRET is missing or too short.');
    return res.status(503).json({ error: 'Accounts are not configured on this deployment.', reason: 'no-auth-secret' });
  }

  const email = users.normaliseEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!users.looksLikeEmail(email)) {
    return res.status(400).json({ error: 'That does not look like an email address.' });
  }

  if (action === 'signup') {
    if (password.length < auth.MIN_PASSWORD) {
      return res.status(400).json({ error: `Use at least ${auth.MIN_PASSWORD} characters for your password.` });
    }

    const { user, reason } = await users.create({ email, passwordHash: auth.hashPassword(password) });
    if (!user) {
      /* the address is taken. Sign-up cannot hide that — the account
         either gets created or it does not — so it says so plainly and
         points at the sign-in rather than pretending to have worked. */
      return res.status(409).json({ error: 'There is already an account for that address.', reason });
    }

    auth.startSession(req, res, user.id);
    return answer(req, res, user);
  }

  if (action === 'login') {
    if (await tooManyAttempts(req)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }

    const user = await users.byEmail(email);
    const ok = auth.verifyPassword(password, user ? user.passwordHash : DECOY);

    if (!user || !ok) {
      await noteFailure(req);
      return res.status(401).json({ error: 'That email and password do not match.' });
    }

    await clearFailures(req);
    auth.startSession(req, res, user.id);
    return answer(req, res, user);
  }

  return res.status(400).json({ error: 'Unknown action.' });
};
