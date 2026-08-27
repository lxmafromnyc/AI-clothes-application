/* =========================================================
   Fynd — metering, as the two spending endpoints see it

   /api/interpret spends OpenAI credit and /api/search spends product
   search quota. Both ask the same two questions in the same order —
   "who is this, and is there anything left" before, and "that cost
   this much" after — so both ask them through here.

   ---------------------------------------------------------
   What a shopper who has run out gets
   ---------------------------------------------------------
   429, with the plan, the limit, what has been used and when it comes
   back. Enough for the interface to say "you have used your 3 searches
   for today, they reset at midnight UTC" instead of "something went
   wrong", and enough to put an upgrade in front of somebody who wants
   one. The reply names the plan the server holds; the page renders it.

   ---------------------------------------------------------
   What happens when the store cannot be reached
   ---------------------------------------------------------
   The request is allowed, and the failure is logged loudly.

   Metering exists to bound an API bill. A store that is briefly
   unreachable should cost a few unmetered searches, not take down the
   product search on a site whose whole purpose is product search — and
   failing open grants nobody a plan: there is no feature behind a paid
   tier, only a larger allowance, so an uncounted request is a request
   that was free rather than one that was bought.
   ========================================================= */

'use strict';

const usage = require('./_usage');
const users = require('./_users');
const { identify } = require('./_auth');

/* Resolves the caller and decides whether the request may proceed.

   `identity.plan` comes from the stored user record. There is no
   parameter, header or body field on either endpoint that reaches it. */
async function guard(req, res, metric) {
  let identity;
  try {
    identity = await identify(req, res, users);
  } catch (err) {
    console.error('Could not identify the caller; treating as anonymous.', err && err.message);
    return { identity: { user: null, subject: 'unknown', plan: 'free', anonymous: true }, state: null, blocked: false };
  }

  try {
    const state = await usage.check(identity.subject, identity.plan, metric);
    return { identity, state, blocked: !state.allowed };
  } catch (err) {
    console.error('Usage store unreachable; allowing the request unmetered.', err && err.message);
    return { identity, state: null, blocked: false };
  }
}

/* Records what a request actually cost. Never throws: the work is
   already done and paid for, so a store that cannot record it must not
   turn a successful answer into an error. */
async function spend(identity, metric, amount) {
  try {
    return await usage.record(identity.subject, identity.plan, metric, amount);
  } catch (err) {
    console.error('Could not record usage.', err && err.message);
    return null;
  }
}

/* The 429. `upgrade` is true only for somebody a bigger plan would
   actually help — telling a Max subscriber to upgrade would be an
   advert, not an answer. */
function overLimit(res, state) {
  return res.status(429).json({
    error: state.plan === 'free'
      ? 'You have used your free allowance for now.'
      : 'You have used your plan’s allowance for this month.',
    reason: 'over-limit',
    usage: state,
    upgrade: state.plan !== 'max'
  });
}

/* What a successful reply carries, so the meters on screen move without
   a second round trip. */
const report = (state) => (state ? {
  plan: state.plan,
  metric: state.metric,
  limit: state.limit,
  used: state.used,
  remaining: state.remaining,
  period: state.period,
  resetsAt: state.resetsAt
} : null);

module.exports = { guard, spend, overLimit, report };
