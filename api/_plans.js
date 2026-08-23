/* =========================================================
   FindWear — plan definitions and billing periods

   The single source of truth for what each plan costs and what it
   allows. The server enforces from here, the pricing page renders from
   here, and the usage meter labels itself from here, so a limit cannot
   read one way on screen and behave another way in the API.

   ---------------------------------------------------------
   Two meters, counted separately
   ---------------------------------------------------------
     tokens    AI tokens spent interpreting requests, as reported by
               OpenAI's own usage figures — prompt + completion.
     searches  live product searches that actually reached the provider
               and came back. A search that never ran is not counted.

   They are deliberately independent: reading a request is cheap and
   frequent, asking a paid product API is expensive and rare, and one
   running out must not silently disable the other.

   ---------------------------------------------------------
   Periods are UTC
   ---------------------------------------------------------
   Free resets daily, Pro and Max monthly. Every boundary is computed in
   UTC, never in the server's local zone and never in the shopper's:
   a serverless function can be scheduled in any region, and a limit
   that moved with the region would be impossible to reason about.

   A period is never reset by a job. The period key is part of the
   counter's key, so a new day or month simply addresses a counter that
   does not exist yet and reads as zero. There is nothing to run, nothing
   to miss, and no window where a reset half-happened.
   ========================================================= */

'use strict';

/* Order matters: it is the order the pricing page lists them in. */
const PLAN_IDS = ['free', 'pro', 'max'];

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    priceLabel: '$0',
    cadence: null,
    period: 'day',
    periodLabel: 'day',
    /* how the meter phrases itself on this plan */
    usageWindow: 'today',
    limits: { tokens: 20000, searches: 3 },
    blurb: 'Enough to try FindWear properly.',
    features: ['20k AI tokens/day', '3 live searches/day']
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 14.99,
    priceLabel: '$14.99',
    cadence: 'month',
    period: 'month',
    periodLabel: 'month',
    usageWindow: 'this month',
    limits: { tokens: 1000000, searches: 75 },
    blurb: 'For shopping that is more than occasional.',
    features: ['1M AI tokens/month', '75 live searches/month']
  },
  max: {
    id: 'max',
    name: 'Max',
    priceUsd: 79.99,
    priceLabel: '$79.99',
    cadence: 'month',
    period: 'month',
    periodLabel: 'month',
    usageWindow: 'this month',
    limits: { tokens: 5000000, searches: 400 },
    /* Generous, and said in plain numbers. Never "unlimited": there is a
       ceiling, and naming it is the difference between a promise that
       holds and one that has to be walked back. */
    blurb: 'Our most generous plan, with headroom for heavy days.',
    features: ['5M AI tokens/month', '400 live searches/month']
  }
};

const METERS = ['tokens', 'searches'];

const DEFAULT_PLAN = 'free';

/* An unknown plan id is never guessed at generously — it falls back to
   Free, the least costly thing to be wrong about. */
function planOf(id) {
  return PLANS[String(id || '').toLowerCase()] || PLANS[DEFAULT_PLAN];
}

const isPlanId = (id) => Object.prototype.hasOwnProperty.call(PLANS, String(id || '').toLowerCase());

function limitFor(planId, meter) {
  const plan = planOf(planId);
  const limit = plan.limits[meter];
  return Number.isFinite(limit) ? limit : 0;
}

/* ---------------------------------------------------------
   Period arithmetic, all in UTC
   --------------------------------------------------------- */

const pad = (n) => String(n).padStart(2, '0');

/* The string that identifies the current window. It is part of the
   counter key, which is what makes a reset free. */
function periodKey(period, now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  if (period === 'month') return `m:${y}-${m}`;
  return `d:${y}-${m}-${pad(d.getUTCDate())}`;
}

/* The instant the current window began. */
function periodStart(period, now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  if (period === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/* The instant the allowance comes back — the exclusive end of this
   window, which is the start of the next. Date.UTC rolls over for us, so
   31 December and a 29 February both land correctly without special
   cases. */
function periodEnd(period, now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  if (period === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

const resetAt = (period, now) => periodEnd(period, now).toISOString();

function secondsUntilReset(period, now) {
  const at = now instanceof Date ? now.getTime() : (now || Date.now());
  return Math.max(1, Math.ceil((periodEnd(period, now).getTime() - at) / 1000));
}

/* How long a counter should survive. One full extra window of slack, so
   a counter is never evicted while it still governs a live request, and
   never lingers long enough to matter. */
const counterTtl = (period, now) => secondsUntilReset(period, now) + (period === 'month' ? 172800 : 3600);

/* ---------------------------------------------------------
   What the browser may see
   --------------------------------------------------------- */

/* The pricing page and the meter are built from this. It carries prices
   and allowances — public facts — and nothing about billing identity,
   credentials or any other account. */
function publicPlans() {
  return PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return {
      id: p.id,
      name: p.name,
      priceUsd: p.priceUsd,
      priceLabel: p.priceLabel,
      cadence: p.cadence,
      period: p.period,
      periodLabel: p.periodLabel,
      blurb: p.blurb,
      features: p.features.slice(),
      limits: { tokens: p.limits.tokens, searches: p.limits.searches }
    };
  });
}

module.exports = {
  PLANS,
  PLAN_IDS,
  METERS,
  DEFAULT_PLAN,
  planOf,
  isPlanId,
  limitFor,
  periodKey,
  periodStart,
  periodEnd,
  resetAt,
  secondsUntilReset,
  counterTtl,
  publicPlans
};
