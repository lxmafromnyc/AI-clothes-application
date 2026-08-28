/* =========================================================
   Fynd — what the browser is told about a subscription

   /api/account, /api/auth and /api/checkout all answer with the same
   picture of who somebody is and what they are entitled to, so the
   interface has one shape to render and one place to look for the
   truth. It is built here, once.

   Everything in it is derived on the server from the stored user
   record and the usage counters. Nothing in it is echoed back from the
   request. The browser cannot send a plan and be told it has one.
   ========================================================= */

'use strict';

const store = require('./_store');
const usage = require('./_usage');
const stripe = require('./_stripe');
const auth = require('./_auth');
const email = require('./_email');
const google = require('./_google');
const { publicPlans, AI_TOKENS, SEARCHES, DEFAULT_PLAN } = require('./_plans');
const { publicUser } = require('./_users');

const METRICS = [AI_TOKENS, SEARCHES];

/* The subscription, as far as the browser needs it: enough to say
   "Pro, renews on the 3rd", or "your payment failed", and nothing that
   identifies the Stripe objects behind it. */
function publicSubscription(user) {
  const sub = user && user.subscription;
  if (!sub) return null;
  return {
    status: sub.status,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    currentPeriodEnd: sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd * 1000).toISOString()
      : null,
    latestInvoiceStatus: sub.latestInvoiceStatus || null
  };
}

async function accountPayload(identity) {
  const user = identity.user;
  const planId = user ? (user.plan || DEFAULT_PLAN) : DEFAULT_PLAN;
  const catalogue = publicPlans();

  return {
    signedIn: Boolean(user),
    user: publicUser(user),
    /* the plan the server holds, spelled out — the interface renders
       this, it does not decide it. Taken from the published catalogue
       rather than the internal table, so the name of the variable a
       price id lives in does not travel with it. */
    plan: catalogue.find((plan) => plan.id === planId) || catalogue[0],
    plans: catalogue,
    subscription: publicSubscription(user),
    usage: await usage.summary(identity.subject, planId, METRICS),
    billing: {
      /* whether this deployment can sell anything at all, and whether
         what it would sell is real money */
      enabled: stripe.configured(),
      testMode: stripe.testMode(),
      webhookConfigured: stripe.webhookConfigured(),
      portal: Boolean(user && user.stripeCustomerId)
    },
    /* Everything the account page needs to draw itself honestly:
       whether it can offer each way in, and whether the verification
       link it is about to promise can actually be sent. A page that
       offered "Continue with Google" on a deployment with no client id
       would be a button that goes nowhere. */
    accounts: {
      enabled: auth.accountsEnabled(),
      google: google.configured(),
      email: email.state()
    },
    /* Verification is reported here and enforced at the endpoints that
       care. The page shows the state; it does not decide it. */
    emailVerified: Boolean(user && user.emailVerified),
    signedInWith: identity.method || null,
    /* Echoed back for the page to send on state-changing requests. Safe
       to read from script — that is the point — and useless without the
       HttpOnly session cookie it is derived from. */
    csrfToken: identity.csrfToken || null,
    /* said plainly rather than discovered later: on the memory driver a
       subscription is forgotten when the function instance is recycled */
    storage: { durable: store.durable() }
  };
}

module.exports = { accountPayload, publicSubscription, METRICS };
