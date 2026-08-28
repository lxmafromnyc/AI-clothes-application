/* =========================================================
   Fynd — rate limits

   Four things here can be abused by repetition rather than by any one
   request being wrong: guessing a password, creating accounts in bulk,
   and asking Fynd to send verification or reset email to an address
   over and over. The last two matter most — they spend the email
   provider's reputation on somebody else's inbox, and a mail provider
   that starts refusing Fynd's mail breaks sign-up for everyone.

   Counted in the same store as everything else, with a TTL, so a window
   expires on its own and nothing has to be swept.

   ---------------------------------------------------------
   Two axes, and both have to pass
   ---------------------------------------------------------
   Per subject — a user id or an email address — stops one mailbox being
   flooded from many machines. Per address hash stops one machine
   working through many mailboxes. Either alone leaves the other open.

   Limits fail OPEN if the store cannot be reached: a rate limiter that
   errors closed turns a store outage into "nobody can sign in", which
   is a worse failure than a brief window with no ceiling. The store
   being down is logged where the metering logs it.
   ========================================================= */

'use strict';

const store = require('./_store');

/* name -> { max, windowSeconds, minGapSeconds }

   `minGapSeconds` is the cooldown between two of the same action, which
   is what actually stops a held-down button; `max` is the ceiling for
   the window. Resend has both: one every 60 seconds, five an hour. */
const LIMITS = {
  'auth:login': { max: 10, windowSeconds: 60 * 15 },
  'auth:signup': { max: 5, windowSeconds: 60 * 60 },
  'auth:resend-verification': { max: 5, windowSeconds: 60 * 60, minGapSeconds: 60 },
  'auth:forgot-password': { max: 5, windowSeconds: 60 * 60, minGapSeconds: 60 },
  'auth:reset-password': { max: 10, windowSeconds: 60 * 60 }
};

const countKey = (name, subject) => `ratelimit:${name}:${subject}`;
const gapKey = (name, subject) => `ratelimit:gap:${name}:${subject}`;

/* Has this subject used up the allowance, or acted too recently?

   Reports which, because they are different sentences: "wait a moment"
   and "you have asked for too many of these today" are not the same
   thing to somebody who is not attacking anything. */
async function check(name, subject) {
  const limit = LIMITS[name];
  if (!limit || !subject) return { allowed: true, reason: null, retryAfter: 0 };

  try {
    if (limit.minGapSeconds) {
      const recent = await store.get(gapKey(name, subject));
      if (recent && recent.at) {
        const elapsed = Math.floor((Date.now() - recent.at) / 1000);
        if (elapsed < limit.minGapSeconds) {
          return { allowed: false, reason: 'too-soon', retryAfter: limit.minGapSeconds - elapsed };
        }
      }
    }

    const used = await store.readNumber(countKey(name, subject));
    if (used >= limit.max) {
      return { allowed: false, reason: 'too-many', retryAfter: limit.windowSeconds };
    }

    return { allowed: true, reason: null, retryAfter: 0 };
  } catch (err) {
    console.error('Rate limit store unreachable; allowing the request.', err && err.message);
    return { allowed: true, reason: null, retryAfter: 0 };
  }
}

/* Records one use. Called when the action actually happens, so a
   refused request does not spend somebody's allowance. */
async function note(name, subject) {
  const limit = LIMITS[name];
  if (!limit || !subject) return;
  try {
    await store.add(countKey(name, subject), 1, { ttlSeconds: limit.windowSeconds });
    if (limit.minGapSeconds) {
      await store.set(gapKey(name, subject), { at: Date.now() }, { ttlSeconds: limit.minGapSeconds });
    }
  } catch (err) {
    console.error('Could not record a rate limit.', err && err.message);
  }
}

const clear = (name, subject) => Promise.all([
  store.remove(countKey(name, subject)),
  store.remove(gapKey(name, subject))
]).then(() => true).catch(() => false);

/* Both axes at once. The stricter answer wins, and the caller gets one
   result to act on rather than two to combine. */
async function checkAll(name, subjects) {
  for (const subject of subjects.filter(Boolean)) {
    const result = await check(name, subject);
    if (!result.allowed) return result;
  }
  return { allowed: true, reason: null, retryAfter: 0 };
}

const noteAll = (name, subjects) => Promise.all(subjects.filter(Boolean).map((s) => note(name, s)));

module.exports = { LIMITS, check, note, checkAll, noteAll, clear };
