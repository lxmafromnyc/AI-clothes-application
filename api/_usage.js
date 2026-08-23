/* =========================================================
   Fynd — usage metering and enforcement

   Everything that decides whether a request may spend money, and records
   that it did. Both paid endpoints go through here and nothing else is
   allowed to touch a counter.

   ---------------------------------------------------------
   Reserve first, refund on failure
   ---------------------------------------------------------
   The obvious design is to do the work and then add up what it cost.
   It does not survive concurrency: ten simultaneous requests from an
   account with one search left all check "0 of 3 used", all pass, and
   all run. The limit is discovered afterwards, when the money is spent.

   So the allowance is taken BEFORE the upstream call, with the atomic
   increment the store guarantees. Of ten concurrent requests exactly
   three are told they landed within the limit; the other seven are told
   they went over and hand the slot straight back. Nothing runs that was
   not paid for first.

   The cost is that a reservation can outlive a request that failed, so
   every path that does not complete gives it back:

     reserve()  take the allowance, atomically
     settle()   the work succeeded; correct the amount to what it
                actually cost, which for tokens is only known afterwards
     refund()   the work did not happen; return the whole reservation

   A live search that never reached the provider, or whose provider call
   threw, is refunded in full. That is the rule that "a failed request
   must not consume a live-search allowance" turns into.

   ---------------------------------------------------------
   Repeat submissions
   ---------------------------------------------------------
   A double-click, an impatient retry and a flaky connection all produce
   the same request twice. Each one would otherwise take its own slot.

   The browser stamps a submission with an idempotency key; the first
   request to claim that key owns it, and a later one carrying the same
   key is a repeat. A repeat that arrives after the first finished is
   answered with the stored result and charged nothing. A repeat that
   arrives while the first is still running is told so, and charged
   nothing. The key is namespaced per account, so one account can neither
   read nor collide with another's.
   ========================================================= */

'use strict';

const { getStore } = require('./_store');
const {
  planOf, limitFor, periodKey, resetAt, secondsUntilReset, counterTtl, METERS
} = require('./_plans');

/* How long a finished submission stays replayable. Long enough to cover
   a retry, a reload and a flaky connection; short enough that the store
   does not accumulate a day's traffic forever. */
const IDEMPOTENCY_TTL = 60 * 60 * 24;

/* The marker a claim holds while its request is still running. Not valid
   JSON, so it can never be mistaken for a stored result. */
const IN_PROGRESS = '@running';

/* A stored result larger than this is not worth replaying — the repeat
   is told the original succeeded rather than being handed a payload that
   would bloat every write. */
const MAX_STORED_RESULT = 60000;

const counterKey = (accountId, meter, period, now) =>
  `u:${meter}:${accountId}:${periodKey(period, now)}`;

const idempotencyKey = (accountId, key) => `idem:${accountId}:${key}`;

/* ---------------------------------------------------------
   The shape a blocked caller receives
   --------------------------------------------------------- */

/* Everything the interface needs to explain the block and everything a
   retry needs to know when to come back. No credential, no billing
   identity, no other account's numbers. */
function limitPayload(account, meter, usage, now) {
  const plan = planOf(account.plan);
  const limit = limitFor(plan.id, meter);
  return {
    error: 'usage_limit_reached',
    limitType: meter,
    usage: Math.min(usage, limit),
    limit,
    remaining: 0,
    plan: plan.id,
    planName: plan.name,
    period: plan.period,
    periodLabel: plan.periodLabel,
    usageWindow: plan.usageWindow,
    resetAt: resetAt(plan.period, now),
    resetInSeconds: secondsUntilReset(plan.period, now),
    authenticated: Boolean(account.authenticated)
  };
}

/* ---------------------------------------------------------
   Taking and giving back
   --------------------------------------------------------- */

/* Take `amount` from a meter.

     { ok: true,  reservation }
     { ok: false, limit }

   A limit of zero blocks without touching the store: there is no
   allowance to take and no reason to write. */
async function reserve(account, meter, amount, options) {
  const opts = options || {};
  const now = opts.now || new Date();
  const plan = planOf(account.plan);
  const limit = limitFor(plan.id, meter);
  const take = Math.max(0, Math.ceil(Number(amount) || 0));

  if (limit <= 0) return { ok: false, limit: limitPayload(account, meter, 0, now) };
  if (take === 0) {
    return { ok: true, reservation: { key: null, meter, amount: 0, accountId: account.id, plan: plan.id } };
  }

  const store = getStore();
  const key = counterKey(account.id, meter, plan.period, now);
  const after = await store.incrBy(key, take, counterTtl(plan.period, now));

  if (after > limit) {
    /* over the line: hand back exactly what was taken, so a request that
       was refused costs the account nothing */
    await store.decrBy(key, take);
    return { ok: false, limit: limitPayload(account, meter, after - take, now) };
  }

  return {
    ok: true,
    reservation: { key, meter, amount: take, accountId: account.id, plan: plan.id, period: plan.period },
    usage: after,
    limit,
    remaining: limit - after
  };
}

/* The work did not happen. Give the whole reservation back. */
async function refund(reservation) {
  if (!reservation || !reservation.key || !reservation.amount) return;
  await getStore().decrBy(reservation.key, reservation.amount);
}

/* The work happened and cost `actual`. Corrects the reservation, which
   for tokens is always an over-estimate made before the call.

   Settling ABOVE the reservation is allowed to exceed the limit rather
   than being refused: the tokens are already spent, and refusing to
   record them would make the meter lie. The next request is the one that
   gets blocked. */
async function settle(reservation, actual) {
  if (!reservation || !reservation.key) return { adjusted: 0 };
  const spent = Math.max(0, Math.ceil(Number(actual) || 0));
  const delta = spent - reservation.amount;
  if (delta === 0) return { adjusted: 0 };
  const store = getStore();
  if (delta < 0) await store.decrBy(reservation.key, -delta);
  else await store.incrBy(reservation.key, delta, counterTtl(reservation.period, new Date()));
  return { adjusted: delta };
}

/* ---------------------------------------------------------
   Reading the meters
   --------------------------------------------------------- */

/* What the usage meter renders. The browser is never told to compute
   this: it is the server's own numbers, so what a shopper reads and what
   the next request will be judged against cannot disagree. */
async function snapshot(account, options) {
  const now = (options && options.now) || new Date();
  const plan = planOf(account.plan);
  const store = getStore();

  const meters = {};
  for (const meter of METERS) {
    /* eslint-disable-next-line no-await-in-loop */
    const used = Math.max(0, await store.get(counterKey(account.id, meter, plan.period, now)));
    const limit = limitFor(plan.id, meter);
    meters[meter] = {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      exhausted: used >= limit
    };
  }

  return {
    plan: plan.id,
    planName: plan.name,
    priceLabel: plan.priceLabel,
    cadence: plan.cadence,
    period: plan.period,
    periodLabel: plan.periodLabel,
    usageWindow: plan.usageWindow,
    resetAt: resetAt(plan.period, now),
    resetInSeconds: secondsUntilReset(plan.period, now),
    authenticated: Boolean(account.authenticated),
    meters
  };
}

/* ---------------------------------------------------------
   Repeat submissions
   --------------------------------------------------------- */

/* Only what a browser could plausibly have generated, and short enough
   that it cannot be used to write a large key into the store. */
const validIdempotencyKey = (key) =>
  typeof key === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(key);

/* Claim a submission.

     { state: 'new' }                  first arrival — proceed
     { state: 'replay',  result }      the original finished — reuse it
     { state: 'in-flight' }            the original is still running
     { state: 'unkeyed' }              no key supplied — nothing to dedupe

   `unkeyed` is deliberately permissive. A request without a key is not
   refused, it simply gets no protection from its own retries. */
async function claimSubmission(account, key) {
  if (!validIdempotencyKey(key)) return { state: 'unkeyed' };
  const store = getStore();
  const full = idempotencyKey(account.id, key);

  const won = await store.claim(full, IN_PROGRESS, IDEMPOTENCY_TTL);
  if (won) return { state: 'new', key: full };

  const held = await store.read(full);
  if (held == null) {
    /* it expired between the claim and the read: treat as a fresh one */
    return { state: 'new', key: full };
  }
  if (held === IN_PROGRESS) return { state: 'in-flight', key: full };

  try {
    return { state: 'replay', key: full, result: JSON.parse(held) };
  } catch (err) {
    /* unreadable record: better to run again than to fail the shopper */
    return { state: 'new', key: full };
  }
}

/* Store what the first request answered, so a repeat can be given the
   same thing without spending anything. */
async function recordSubmission(claim, payload) {
  if (!claim || !claim.key) return;
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (err) {
    body = null;
  }
  if (!body || body.length > MAX_STORED_RESULT) {
    /* nothing replayable, but the work DID happen — so the claim is kept
       rather than released, and a repeat is told so instead of being
       allowed to spend a second allowance */
    await getStore().write(
      claim.key,
      JSON.stringify({ replayed: true, note: 'The original search completed; its result was not stored.' }),
      IDEMPOTENCY_TTL
    );
    return;
  }
  await getStore().write(claim.key, body, IDEMPOTENCY_TTL);
}

/* The first request failed. The claim is REMOVED, not expired: a retry
   arriving a moment later must be able to run, and a marker with a short
   TTL would still answer it "already running" for as long as it lived.
   Nothing was charged, so there is nothing to protect. */
async function releaseSubmission(claim) {
  if (!claim || !claim.key) return;
  await getStore().del(claim.key);
}

module.exports = {
  reserve,
  refund,
  settle,
  snapshot,
  limitPayload,
  claimSubmission,
  recordSubmission,
  releaseSubmission,
  validIdempotencyKey,
  counterKey,
  idempotencyKey,
  IDEMPOTENCY_TTL,
  IN_PROGRESS
};
