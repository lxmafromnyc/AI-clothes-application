/* =========================================================
   Fynd — single-use, expiring, unguessable tokens

   Three things need one: an email verification link, a password reset
   link, and the state parameter that ties an OAuth redirect back to the
   browser that started it. All three have exactly the same
   requirements, so they share one implementation rather than three that
   drift apart and are secure to three different degrees.

   Every token here is:

     unguessable   32 bytes from crypto.randomBytes, base64url. Not a
                   uuid, not a timestamp, not a counter, not anything
                   derived from the account it belongs to.

     single-use    consumed with the store's GETDEL, so the read and the
                   delete are one operation. Two requests carrying the
                   same link cannot both be honoured — and they do
                   arrive: mail scanners follow links before the person
                   does, and a double-click is two requests.

     expiring      a TTL on the stored record, so an old link in an old
                   inbox stops working whether or not anyone consumes it.
                   The expiry is also written into the record and checked
                   on use, so a store that ignores TTLs cannot quietly
                   extend one.

   ---------------------------------------------------------
   The token is not what is stored
   ---------------------------------------------------------
   The store holds `token:<purpose>:<HMAC(token)>`, keyed by AUTH_SECRET.
   The raw token exists in the email and in the URL the user clicks, and
   nowhere else — not in the database, not in a log, not in an error.

   So a dump of the store is not a set of working links: an attacker
   would have the hashes and not the secret, and cannot run the hash
   backwards or forwards without it. This is the same reason passwords
   are not stored either.

   ---------------------------------------------------------
   What must never happen to a token
   ---------------------------------------------------------
   It is never logged, never included in an error message, never put in
   an API response, and never attached to anything that gets reported.
   The only two places a raw token may appear are the email being sent
   and the link the user clicks. `describe()` exists so that logging
   something about a token is possible without logging the token.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const store = require('./_store');

/* What a token is for. The purpose is part of the stored key, so a
   verification token cannot be presented as a password reset: they are
   different keyspaces, and looking one up under the other purpose
   simply finds nothing. */
const PURPOSE = {
  VERIFY_EMAIL: 'verify-email',
  RESET_PASSWORD: 'reset-password',
  OAUTH_STATE: 'oauth-state'
};

/* How long each kind is good for. Short where the user is expected to
   be sitting in front of the browser, longer where they have to go and
   find an email. */
const TTL = {
  [PURPOSE.VERIFY_EMAIL]: 60 * 60 * 24,   /* a day */
  [PURPOSE.RESET_PASSWORD]: 60 * 60,      /* an hour — it changes a password */
  [PURPOSE.OAUTH_STATE]: 60 * 10          /* ten minutes to finish a sign-in */
};

const secret = () => String(process.env.AUTH_SECRET || '').trim();

const b64url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* 32 bytes. Long enough that guessing is not a strategy at any rate a
   network allows, and short enough to sit in a URL without wrapping. */
const mint = () => b64url(crypto.randomBytes(32));

/* Keyed, so the stored value cannot be computed from a leaked token
   list alone, and constant work regardless of the token's contents. */
const fingerprint = (purpose, token) => crypto
  .createHmac('sha256', secret())
  .update(`${purpose}:${token}`)
  .digest('hex');

const keyFor = (purpose, token) => `token:${purpose}:${fingerprint(purpose, token)}`;

/* Enough to identify a token in a log line without being the token: the
   purpose, and the first eight characters of its HMAC — which is not
   the token and cannot be turned back into one. */
const describe = (purpose, token) => `${purpose}/${fingerprint(purpose, token).slice(0, 8)}`;

/* Creates one and stores what is needed to honour it later.

   Returns the raw token, which the caller puts in exactly one place —
   an email, or a redirect it is about to make — and then forgets. */
async function issue(purpose, payload, options) {
  if (!secret()) throw new Error('AUTH_SECRET is required to issue tokens.');

  const ttlSeconds = Math.floor(Number((options && options.ttlSeconds) || TTL[purpose] || 3600));
  const token = mint();

  await store.set(keyFor(purpose, token), Object.assign({}, payload, {
    purpose,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000
  }), { ttlSeconds });

  return { token, expiresAt: Date.now() + ttlSeconds * 1000, ttlSeconds };
}

/* Spends a token, and says why if it could not be spent.

   The three failures are told apart on purpose — they are three
   different sentences on screen, and none of them tells an attacker
   anything they did not already know by holding the token:

     invalid   no such token. Never existed, already used, or made up.
     expired   it existed and its time is past.
     purpose   the record is not for what it is being used for.

   `used` and `invalid` are deliberately the same answer: after GETDEL
   there is no record left to distinguish them, which is the property
   that makes reuse impossible rather than merely detected. */
async function consume(purpose, token) {
  const raw = String(token || '');
  if (!secret()) return { ok: false, reason: 'not-configured', payload: null };
  /* base64url of 32 bytes is 43 characters; anything else was not minted
     here and is refused without touching the store */
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return { ok: false, reason: 'invalid', payload: null };

  const record = await store.takeOnce(keyFor(purpose, raw));
  if (!record) return { ok: false, reason: 'invalid', payload: null };

  /* the record is gone either way now — an expired token is spent by
     being presented, so it cannot be retried while the clock is argued
     about */
  if (record.purpose !== purpose) return { ok: false, reason: 'invalid', payload: null };
  if (!record.expiresAt || record.expiresAt <= Date.now()) {
    return { ok: false, reason: 'expired', payload: null };
  }

  return { ok: true, reason: null, payload: record };
}

/* Reads without spending. Only for the OAuth state, where the caller
   needs to know whether to expect a callback at all. Nothing that
   grants anything uses this. */
async function peek(purpose, token) {
  if (!secret()) return null;
  const record = await store.get(keyFor(purpose, String(token || '')));
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}

module.exports = { PURPOSE, TTL, issue, consume, peek, describe, mint, b64url };
