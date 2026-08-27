/* =========================================================
   Fynd — start a Stripe Checkout

   POST { plan: "pro" | "max", returnPath }  ->  { url }

   The browser sends a plan name and gets back a Stripe-hosted URL to
   send the shopper to. It does not send a price, an amount, a currency
   or an interval, and none would be read if it did: the Price is looked
   up from STRIPE_PRICE_PRO or STRIPE_PRICE_MAX on the server. A
   checkout whose price came from the page is a checkout anybody could
   re-price to a cent.

   No card details touch Fynd. The page never sees a card field; the
   shopper types their card on Stripe's own domain, and this deployment
   never receives, handles or stores a card number.

   ---------------------------------------------------------
   Why this endpoint grants nothing
   ---------------------------------------------------------
   It creates a session and returns a URL. It does not change a plan,
   and neither does the page the shopper lands back on. The plan changes
   when Stripe tells the webhook the money moved. A shopper who closes
   the Stripe page, or who edits the success URL and loads it by hand,
   has changed nothing.

   ---------------------------------------------------------
   Duplicate subscriptions
   ---------------------------------------------------------
   A user who already has an entitling subscription is not sent to
   checkout again — they are told to change plan in the billing portal,
   which moves the existing subscription rather than opening a second
   one alongside it. Two subscriptions would be two charges a month for
   one account.
   ========================================================= */

'use strict';

const { handledPreflight, returnUrl } = require('./_cors');
const { readJson } = require('./_body');
const { identify } = require('./_auth');
const users = require('./_users');
const stripe = require('./_stripe');
const { envReport } = require('./_env-report');
const { isPlanId, planOf, priceIdFor, PAID_PLANS, ENTITLING_STATUSES } = require('./_plans');

/* Where Stripe sends the browser back to. The origin is decided by the
   allow-list in _cors.js and the path is checked to be relative, so
   neither can be pointed somewhere else by the request. */
const SUCCESS_PATH = '/pricing.html';
const CANCEL_PATH = '/pricing.html';

function landingPaths(req, body) {
  const wanted = typeof body.returnPath === 'string' ? body.returnPath : '';
  const base = returnUrl(req, wanted, SUCCESS_PATH);
  const join = (query) => `${base}${base.includes('?') ? '&' : '?'}${query}`;
  return {
    /* the session id lets the page say "we are confirming your payment"
       — it is never used to grant anything */
    success: join('checkout=success&session_id={CHECKOUT_SESSION_ID}'),
    cancel: join('checkout=cancelled')
  };
}

/* The Stripe customer for this user, created once and remembered.

   Created before the checkout rather than by it, so the mapping from
   customer id back to the Fynd account exists before any webhook about
   that customer can arrive. A checkout that created the customer would
   leave a window where an event names a customer nothing can resolve. */
async function customerFor(user) {
  if (user.stripeCustomerId) return { user, customerId: user.stripeCustomerId };

  const customer = await stripe.createCustomer({
    email: user.email,
    metadata: { fyndUserId: user.id }
  }, { idempotencyKey: `fynd-customer-${user.id}` });

  const linked = await users.linkCustomer(user, customer.id);
  return { user: linked, customerId: customer.id };
}

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  if (!stripe.configured()) {
    console.warn('Checkout unavailable: no Stripe key. env:', envReport());
    return res.status(503).json({ error: 'Payments are not configured on this deployment.', reason: 'no-stripe-key' });
  }

  const body = await readJson(req);
  const planId = String(body.plan || '').trim().toLowerCase();

  if (!isPlanId(planId) || !PAID_PLANS.includes(planId)) {
    return res.status(400).json({ error: 'Choose the Pro or Max plan.' });
  }

  const priceId = priceIdFor(planId);
  if (!priceId) {
    console.warn(`Checkout unavailable: ${planOf(planId).priceEnv} is not set.`);
    return res.status(503).json({
      error: 'That plan is not available on this deployment yet.',
      reason: 'no-price-id'
    });
  }

  const identity = await identify(req, res, users);
  if (!identity.user) {
    /* A subscription has to belong to somebody a webhook can find
       later, so this is where an account stops being optional. */
    return res.status(401).json({ error: 'Sign in to subscribe.', reason: 'sign-in-required' });
  }

  const existing = identity.user.subscription;
  if (existing && ENTITLING_STATUSES.includes(existing.status)) {
    return res.status(409).json({
      error: 'You already have a subscription. Change plan in the billing portal.',
      reason: 'already-subscribed',
      plan: identity.user.plan
    });
  }

  try {
    const { user, customerId } = await customerFor(identity.user);
    const paths = landingPaths(req, body);

    const session = await stripe.createCheckoutSession({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: paths.success,
      cancel_url: paths.cancel,
      /* three ways back to the same account, so the webhook can resolve
         it from the session, from the subscription, or from the
         customer index — whichever event arrives first */
      client_reference_id: user.id,
      metadata: { fyndUserId: user.id, fyndPlan: planId },
      subscription_data: { metadata: { fyndUserId: user.id, fyndPlan: planId } },
      allow_promotion_codes: true
    });

    res.setHeader('Cache-Control', 'no-store, private');
    return res.status(200).json({ url: session.url, plan: planId, testMode: stripe.testMode() });
  } catch (err) {
    /* Stripe's message can quote the request; it is logged and not
       returned, the same rule the OpenAI and provider calls follow. */
    console.error('Checkout session failed', err && err.code, err && err.message);
    return res.status(502).json({ error: 'Could not start checkout. Try again in a moment.' });
  }
};
