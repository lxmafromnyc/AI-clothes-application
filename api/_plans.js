/* =========================================================
   Fynd — the plans, and what each one entitles you to

   One definition of Free, Pro and Max, read by the endpoint that meters
   usage, by the endpoint that starts a checkout, by the webhook that
   applies a subscription change, and — over /api/account — by the
   pricing page. The browser is never the authority on any of it: it is
   sent this table, it does not hold one.

   ---------------------------------------------------------
   Prices live in Stripe; limits live here
   ---------------------------------------------------------
   The amounts below are display copy. What a shopper is actually
   charged is whatever the Stripe Price says, and the Price is named by
   an environment variable rather than written here, so test mode and
   live mode are a configuration change and not a code change:

     STRIPE_PRICE_PRO   price_… for Pro,  $14.99/month recurring
     STRIPE_PRICE_MAX   price_… for Max,  $39.99/month recurring

   A plan whose price id is not configured cannot be bought — checkout
   answers 503 and says which variable is missing — rather than falling
   back to some other price.

   ---------------------------------------------------------
   Which subscription statuses are worth paying attention to
   ---------------------------------------------------------
   Stripe reports a subscription's status; Fynd decides what that status
   entitles you to, and only these two entitle you to anything:

     active     paid and current
     trialing   inside a trial Stripe is honouring

   Everything else — past_due, unpaid, incomplete, incomplete_expired,
   paused, canceled — is Free. That is deliberately strict: a card that
   stopped working should stop the paid allowance rather than run it on
   credit, and `past_due` is exactly that state. The status is kept and
   shown, so the interface can say "your payment failed, update your
   card" instead of a silent downgrade.

   A subscription set to cancel at period end stays `active` until the
   period actually ends, which is what the shopper paid for. The plan
   drops when Stripe says `canceled`, not when they press the button.
   ========================================================= */

'use strict';

/* Metered resources. Both are counted per period; the period a plan
   counts in is part of the plan, not a property of the resource. */
const AI_TOKENS = 'aiTokens';
const SEARCHES = 'searches';

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    /* dollars, for display only — Stripe holds the real amount */
    amount: 0,
    interval: null,
    /* Free is counted daily: a small allowance that comes back tomorrow
       reads as a trial of the product, where a monthly one reads as a
       wall you hit on the 3rd. */
    period: 'day',
    limits: { [AI_TOKENS]: 20000, [SEARCHES]: 1 },
    priceEnv: null,
    tagline: 'Try it out, every day.',
    features: [
      '1 live product search a day',
      '20,000 AI tokens a day',
      'Real listings, prices and retailer links',
      'No card required'
    ]
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    amount: 14.99,
    interval: 'month',
    period: 'month',
    limits: { [AI_TOKENS]: 1000000, [SEARCHES]: 100 },
    priceEnv: 'STRIPE_PRICE_PRO',
    tagline: 'For shopping properly.',
    features: [
      '100 live product searches a month',
      '1,000,000 AI tokens a month',
      'Everything in Free',
      "Cancel any time in Stripe's billing portal"
    ]
  },
  max: {
    id: 'max',
    name: 'Max',
    amount: 39.99,
    interval: 'month',
    period: 'month',
    limits: { [AI_TOKENS]: 5000000, [SEARCHES]: 500 },
    priceEnv: 'STRIPE_PRICE_MAX',
    tagline: 'For searching all day.',
    features: [
      '500 live product searches a month',
      '5,000,000 AI tokens a month',
      'Everything in Pro',
      "Cancel any time in Stripe's billing portal"
    ]
  }
};

const DEFAULT_PLAN = 'free';
const PAID_PLANS = ['pro', 'max'];

/* The statuses that entitle. Read the comment at the top before adding
   one: every name here is an allowance somebody is being given. */
const ENTITLING_STATUSES = ['active', 'trialing'];

const isPlanId = (id) => Object.prototype.hasOwnProperty.call(PLANS, String(id || ''));

/* Never throws and never returns undefined: an unrecognised name is
   Free, because the alternative is a request with no limits at all. */
const planOf = (id) => (isPlanId(id) ? PLANS[String(id)] : PLANS[DEFAULT_PLAN]);

const limitFor = (planId, metric) => {
  const limits = planOf(planId).limits;
  return Object.prototype.hasOwnProperty.call(limits, metric) ? limits[metric] : 0;
};

/* The Stripe Price a plan is sold at, or null when the variable naming
   it is not set in this environment. */
function priceIdFor(planId) {
  const plan = planOf(planId);
  if (!plan.priceEnv) return null;
  const value = String(process.env[plan.priceEnv] || '').trim();
  return value || null;
}

/* The reverse: which plan a Stripe Price belongs to. This is how a
   subscription becomes a plan — the webhook reads the price id off the
   subscription item and looks it up here. A price nobody configured
   maps to nothing, and a subscription for it entitles you to nothing,
   which is the safe direction to fail in. */
function planForPriceId(priceId) {
  const wanted = String(priceId || '').trim();
  if (!wanted) return null;
  return PAID_PLANS.find((id) => priceIdFor(id) === wanted) || null;
}

/* The one place that turns "what Stripe says" into "what they get".

   Both halves have to agree: a subscription for a price that is no
   longer sold, or in a status that is not entitling, is Free. */
function planFromSubscription(subscription) {
  const sub = subscription && typeof subscription === 'object' ? subscription : null;
  if (!sub) return DEFAULT_PLAN;
  if (!ENTITLING_STATUSES.includes(String(sub.status || ''))) return DEFAULT_PLAN;
  return planForPriceId(sub.priceId) || DEFAULT_PLAN;
}

/* What the browser is allowed to know: the copy, the limits, and
   whether the plan can be bought in this deployment. No price ids —
   they are not secret, but the browser has no use for one, and a
   checkout that took a price id from the page would be a checkout
   anybody could re-price. */
const publicPlans = () => Object.values(PLANS).map((plan) => ({
  id: plan.id,
  name: plan.name,
  amount: plan.amount,
  interval: plan.interval,
  period: plan.period,
  limits: Object.assign({}, plan.limits),
  tagline: plan.tagline,
  features: plan.features.slice(),
  purchasable: plan.id !== DEFAULT_PLAN && Boolean(priceIdFor(plan.id))
}));

module.exports = {
  PLANS,
  PAID_PLANS,
  DEFAULT_PLAN,
  ENTITLING_STATUSES,
  AI_TOKENS,
  SEARCHES,
  isPlanId,
  planOf,
  limitFor,
  priceIdFor,
  planForPriceId,
  planFromSubscription,
  publicPlans
};
