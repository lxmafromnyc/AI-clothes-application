/* =========================================================
   Fynd — the Stripe billing portal

   POST { returnPath }  ->  { url }

   Changing a card, changing plan, downloading an invoice and cancelling
   all happen on Stripe's own pages. Fynd builds none of that: a billing
   screen of its own would be a second place for a card to be typed, a
   second place for a subscription's state to be wrong, and a second
   thing to keep in step with Stripe.

   Whatever the shopper does in there comes back as a webhook, and the
   webhook is what changes the plan here.
   ========================================================= */

'use strict';

const { handledPreflight, returnUrl } = require('./_cors');
const { readJson } = require('./_body');
const { identify, csrfOk } = require('./_auth');
const users = require('./_users');
const stripe = require('./_stripe');

const RETURN_PATH = '/account.html';

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  if (!stripe.configured()) {
    return res.status(503).json({ error: 'Payments are not configured on this deployment.', reason: 'no-stripe-key' });
  }

  const identity = await identify(req, res, users);
  if (!identity.user) return res.status(401).json({ error: 'Sign in first.', reason: 'sign-in-required' });

  if (identity.sessionToken && !csrfOk(req, identity.sessionToken)) {
    return res.status(403).json({ error: 'Missing or invalid CSRF token.', reason: 'csrf' });
  }

  if (!identity.user.stripeCustomerId) {
    /* nothing has ever been bought on this account, so there is no
       billing history to manage */
    return res.status(409).json({ error: 'There is nothing to manage yet.', reason: 'no-customer' });
  }

  const body = await readJson(req);

  try {
    const session = await stripe.createPortalSession({
      customer: identity.user.stripeCustomerId,
      return_url: returnUrl(req, typeof body.returnPath === 'string' ? body.returnPath : '', RETURN_PATH)
    });

    res.setHeader('Cache-Control', 'no-store, private');
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Portal session failed', err && err.code, err && err.message);
    /* The portal has to be switched on once in the Stripe dashboard
       before it will open. That is the usual cause, and it is a
       configuration answer rather than an outage. */
    return res.status(502).json({
      error: 'Could not open the billing portal. Try again in a moment.',
      reason: err && err.code === 'resource_missing' ? 'portal-not-configured' : null
    });
  }
};
