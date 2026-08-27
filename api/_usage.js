/* =========================================================
   Fynd — metering

   Two things cost money on every request and are therefore counted:

     aiTokens   what /api/interpret spends at OpenAI, counted from the
                usage the model's own reply reports — not estimated
     searches   one per live call to the product source from /api/search

   Counted against a subject, which is a signed-in account or an
   anonymous visitor, and bounded by the plan that subject is on. The
   plan is passed in by the caller, which got it from the stored user
   record, which derived it from a Stripe subscription. Nothing in this
   file reads a plan from a request, so no request can raise its own
   limit by asking to.

   ---------------------------------------------------------
   Periods
   ---------------------------------------------------------
   Free counts by UTC day, Pro and Max by UTC calendar month, because
   that is how each plan is written. The period is part of the counter's
   key, so:

     - a day's count and a month's count never mix
     - upgrading mid-period starts the monthly counter at zero rather
       than inheriting a day's worth of use, and downgrading returns to
       a daily counter that owes nothing. Somebody who upgrades is
       buying the monthly allowance, not the remainder of one.

   The month is the calendar month, not the billing anniversary. A
   shopper can look at a calendar and know when their allowance comes
   back; an anniversary they would have to look up is worse for the
   person paying, and both are equally easy to count.

   Counters expire on their own — two days for a day, forty for a month
   — so nothing accumulates keys for visitors who never come back.
   ========================================================= */

'use strict';

const store = require('./_store');
const { planOf, limitFor } = require('./_plans');

const DAY_TTL = 60 * 60 * 24 * 2;
const MONTH_TTL = 60 * 60 * 24 * 40;

const pad = (n) => String(n).padStart(2, '0');

/* Which window a subject is being counted in, and when it ends. Both
   from the same Date, so a request that straddles midnight cannot be
   counted in one window and told it resets at the end of another. */
function windowFor(period, at) {
  const when = at instanceof Date ? at : new Date();
  const y = when.getUTCFullYear();
  const m = when.getUTCMonth();
  const d = when.getUTCDate();

  if (period === 'month') {
    return {
      key: `${y}-${pad(m + 1)}`,
      /* midnight UTC on the 1st of next month; month 12 rolls the year
         over on its own, which is what Date.UTC does with it */
      resetsAt: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
      ttlSeconds: MONTH_TTL
    };
  }

  return {
    key: `${y}-${pad(m + 1)}-${pad(d)}`,
    resetsAt: new Date(Date.UTC(y, m, d + 1)).toISOString(),
    ttlSeconds: DAY_TTL
  };
}

const counterKey = (subject, metric, period, windowKey) =>
  `usage:${subject}:${metric}:${period}:${windowKey}`;

/* What has been used, and what is left. Never negative: a request that
   overshot its last allowance — one interpretation can report more
   tokens than were left — reads as nothing remaining rather than as a
   debt carried into the next period. */
async function meter(subject, planId, metric, at) {
  const plan = planOf(planId);
  const limit = limitFor(plan.id, metric);
  const window = windowFor(plan.period, at);
  const used = await store.readNumber(counterKey(subject, metric, plan.period, window.key));

  return {
    metric,
    plan: plan.id,
    period: plan.period,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: window.resetsAt
  };
}

/* May this request go ahead?

   The test is "is there anything left", not "is there enough for what
   this will cost", because what an interpretation will cost is not
   knowable before the model answers. A request that starts inside the
   allowance is honoured in full and may overshoot it slightly; the next
   one is refused. Refusing on an estimate would mean refusing requests
   that would have fitted. */
async function check(subject, planId, metric, at) {
  const state = await meter(subject, planId, metric, at);
  return Object.assign({ allowed: state.remaining > 0 }, state);
}

/* Adds to the counter and reports the state after. Atomic, via the
   store: two requests in flight at once both count. */
async function record(subject, planId, metric, amount, at) {
  const step = Math.max(0, Math.floor(Number(amount) || 0));
  const plan = planOf(planId);
  const limit = limitFor(plan.id, metric);
  const window = windowFor(plan.period, at);

  const used = step
    ? await store.add(counterKey(subject, metric, plan.period, window.key), step, { ttlSeconds: window.ttlSeconds })
    : await store.readNumber(counterKey(subject, metric, plan.period, window.key));

  return {
    metric,
    plan: plan.id,
    period: plan.period,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: window.resetsAt
  };
}

/* Every metric at once, for /api/account and the meters on screen. */
async function summary(subject, planId, metrics, at) {
  const out = {};
  for (const metric of metrics) {
    out[metric] = await meter(subject, planId, metric, at);
  }
  return out;
}

module.exports = { windowFor, counterKey, meter, check, record, summary, DAY_TTL, MONTH_TTL };
