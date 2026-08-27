/* =========================================================
   Fynd — Stripe webhook

   POST /api/stripe-webhook

   The only thing in Fynd that can raise or lower a plan. Not the
   checkout endpoint, not the page the shopper lands on afterwards, not
   anything a browser sends: a plan changes here, from an event signed
   by Stripe, or it does not change.

   Handled:

     checkout.session.completed      a checkout finished. Attaches the
                                     Stripe customer to the Fynd account
                                     and applies the new subscription.
     customer.subscription.created   the subscription exists
     customer.subscription.updated   plan changed, renewed, went
                                     past_due, was set to cancel
     customer.subscription.deleted   it ended; access drops to Free
     invoice.paid                    a period was paid for
     invoice.payment_failed          a card failed

   Anything else is acknowledged and ignored. Stripe sends whatever the
   endpoint is subscribed to, and a 200 for an event with no meaning
   here is better than a retry loop for one.

   ---------------------------------------------------------
   Three things have to be true, and each is enforced separately
   ---------------------------------------------------------
   1. The bytes came from Stripe. The signature is checked against the
      raw body with STRIPE_WEBHOOK_SECRET before the payload is parsed —
      so an unsigned request cannot even get as far as being read as an
      event. Body parsing is switched off at the bottom of this file for
      exactly that reason: a re-serialised body has different bytes and
      would fail a signature that was valid.

   2. The same delivery is applied once. Stripe delivers at least once
      and retries anything it did not hear a 2xx for, so the same event
      arrives twice often enough to plan for. The event id is claimed
      with a set-if-absent — an atomic write, not a read followed by a
      write — and the second delivery loses the claim and stops. The
      claim is released if handling then fails, so a genuine retry is
      still processed rather than being swallowed by its own first
      attempt.

   3. An older event cannot undo a newer one. Deliveries are not
      ordered: a `created` can land after the `deleted` that followed
      it. Every subscription carries the timestamp of the event it came
      from, and _users.applySubscription drops one that is older than
      what is already stored.

   ---------------------------------------------------------
   What a failure answers
   ---------------------------------------------------------
   A 500, deliberately. Stripe retries a 5xx with backoff for up to
   three days, which is the behaviour worth having when the store is
   briefly unreachable: the subscription is applied late rather than
   never. A 400 is reserved for a request that will never become valid,
   like a bad signature, where a retry is pointless.
   ========================================================= */

'use strict';

const store = require('./_store');
const stripe = require('./_stripe');
const users = require('./_users');
const { envReport } = require('./_env-report');

/* Long enough to cover Stripe's retry schedule, which gives up after
   about three days, and short enough that the store does not keep event
   ids for ever. */
const SEEN_TTL = 60 * 60 * 24 * 4;

const seenKey = (eventId) => `stripe:event:${eventId}`;

/* ---------------------------------------------------------
   Reading a Stripe subscription into Fynd's shape
   --------------------------------------------------------- */

/* The price is what decides the plan, so it is read from the
   subscription item rather than from anything the checkout said it
   would be. A subscription changed in the billing portal carries its
   new price here and nowhere else. */
function priceOf(subscription) {
  const item = subscription && subscription.items && Array.isArray(subscription.items.data)
    ? subscription.items.data[0]
    : null;
  if (!item) return null;
  if (item.price && item.price.id) return String(item.price.id);
  /* older shape, still returned by some endpoints */
  if (item.plan && item.plan.id) return String(item.plan.id);
  return null;
}

const periodEndOf = (subscription) => {
  const item = subscription && subscription.items && Array.isArray(subscription.items.data)
    ? subscription.items.data[0]
    : null;
  const value = subscription.current_period_end || (item && item.current_period_end);
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

const toFynd = (subscription, eventTime, overrides) => Object.assign({
  id: subscription.id,
  status: subscription.status,
  priceId: priceOf(subscription),
  currentPeriodEnd: periodEndOf(subscription),
  cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
  latestInvoiceStatus: null,
  updatedAt: eventTime
}, overrides || {});

/* ---------------------------------------------------------
   Finding the Fynd account an event is about
   ---------------------------------------------------------
   Three routes, tried in the order of how directly each names the
   account. The customer index is the one that always works for
   subscription and invoice events, which carry a customer and nothing
   else; the metadata routes exist so a checkout can be resolved before
   that index has been written. */
async function resolveUser({ userId, customerId }) {
  if (userId) {
    const byId = await users.byId(String(userId));
    if (byId) return byId;
  }
  if (customerId) {
    const byCustomer = await users.byCustomerId(String(customerId));
    if (byCustomer) return byCustomer;
  }
  return null;
}

/* Reads the subscription from Stripe rather than from the event.

   Only used where the event does not carry one — a completed checkout
   names a subscription id, an invoice names the subscription it paid.
   Where the event does carry the object, that object is used: it is
   signed, and refetching would only add a call that can fail. */
async function fetchSubscription(id) {
  if (!id || !stripe.configured()) return null;
  try {
    return await stripe.getSubscription(String(id));
  } catch (err) {
    console.error('Could not read subscription from Stripe', err && err.code);
    return null;
  }
}

/* ---------------------------------------------------------
   The handlers
   ---------------------------------------------------------
   Each returns a short outcome, which is logged and returned to Stripe.
   Nothing in an outcome is taken from the event's own strings, so the
   log cannot be written by whoever the customer is. */

async function onCheckoutCompleted(event) {
  const session = event.data.object;

  /* Fynd sells subscriptions and nothing else. A one-off payment
     session is not something this code should be applying. */
  if (session.mode && session.mode !== 'subscription') return { applied: false, reason: 'not-a-subscription' };

  const user = await resolveUser({
    userId: session.client_reference_id || (session.metadata && session.metadata.fyndUserId),
    customerId: session.customer
  });
  if (!user) return { applied: false, reason: 'no-matching-user' };

  /* The link first: subscription and invoice events name a customer and
     nothing more, so until this exists they cannot be resolved. */
  const linked = await users.linkCustomer(user, session.customer);

  const subscription = await fetchSubscription(session.subscription);
  if (!subscription) {
    /* customer.subscription.created carries the whole object and is
       sent for the same checkout, so the plan still lands — from that
       event rather than this one. Nothing is granted on a guess. */
    return { applied: false, reason: 'subscription-not-readable', linked: true };
  }

  const result = await users.applySubscription(linked, toFynd(subscription, event.created));
  return { applied: result.applied, reason: result.reason, plan: result.user.plan };
}

async function onSubscriptionEvent(event, { forceStatus }) {
  const subscription = event.data.object;

  const user = await resolveUser({
    userId: subscription.metadata && subscription.metadata.fyndUserId,
    customerId: subscription.customer
  });
  if (!user) return { applied: false, reason: 'no-matching-user' };

  const linked = await users.linkCustomer(user, subscription.customer);
  const shaped = toFynd(subscription, event.created, forceStatus ? { status: forceStatus } : null);

  const result = await users.applySubscription(linked, shaped);
  return { applied: result.applied, reason: result.reason, plan: result.user.plan };
}

async function onInvoice(event, { invoiceStatus }) {
  const invoice = event.data.object;
  const subscriptionId = invoice.subscription
    || (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);

  const user = await resolveUser({
    userId: invoice.metadata && invoice.metadata.fyndUserId,
    customerId: invoice.customer
  });
  if (!user) return { applied: false, reason: 'no-matching-user' };

  /* A failed payment does not itself decide the plan — Stripe moves the
     subscription to past_due and sends customer.subscription.updated
     saying so. Reading the subscription back keeps the two in step
     whichever arrives first, and records which invoice state the
     interface should explain. */
  const subscription = await fetchSubscription(subscriptionId);

  if (!subscription) {
    if (!user.subscription) return { applied: false, reason: 'no-subscription-to-update' };
    const result = await users.applySubscription(user, Object.assign({}, user.subscription, {
      latestInvoiceStatus: invoiceStatus,
      updatedAt: Math.max(event.created, user.subscription.updatedAt)
    }));
    return { applied: result.applied, reason: 'invoice-status-only', plan: result.user.plan };
  }

  const result = await users.applySubscription(user, toFynd(subscription, event.created, {
    latestInvoiceStatus: invoiceStatus
  }));
  return { applied: result.applied, reason: result.reason, plan: result.user.plan };
}

const HANDLERS = {
  'checkout.session.completed': (event) => onCheckoutCompleted(event),
  'customer.subscription.created': (event) => onSubscriptionEvent(event, {}),
  'customer.subscription.updated': (event) => onSubscriptionEvent(event, {}),
  /* the object in a deleted event still reads `active` in some flows;
     the event type is the fact, so it wins */
  'customer.subscription.deleted': (event) => onSubscriptionEvent(event, { forceStatus: 'canceled' }),
  'invoice.paid': (event) => onInvoice(event, { invoiceStatus: 'paid' }),
  'invoice.payment_failed': (event) => onInvoice(event, { invoiceStatus: 'payment_failed' })
};

async function applyEvent(event) {
  const handler = HANDLERS[event.type];
  if (!handler) return { applied: false, reason: 'ignored' };
  return handler(event);
}

/* ---------------------------------------------------------
   The endpoint
   --------------------------------------------------------- */

module.exports = async function handler(req, res) {
  /* No CORS preamble. This is called by Stripe, server to server, and
     never from a browser: there is no origin to allow, and adding one
     would only describe a caller that does not exist. */
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  if (!stripe.webhookConfigured()) {
    console.error('Webhook received but STRIPE_WEBHOOK_SECRET is not set. env:', envReport());
    return res.status(503).json({ error: 'Webhook is not configured.' });
  }

  const raw = await stripe.readRawBody(req);
  if (raw === null) {
    /* the body was parsed before it reached here, so the exact bytes
       Stripe signed are gone and no signature could ever verify */
    console.error('Webhook body was already parsed; raw bytes are required for signature verification.');
    return res.status(400).json({ error: 'Raw body unavailable.' });
  }

  let event;
  try {
    event = stripe.constructEvent(raw, req.headers['stripe-signature']);
  } catch (err) {
    /* 400, not 500: no retry will make an unsigned request signed */
    console.warn('Rejected a webhook delivery:', err && err.code);
    return res.status(400).json({ error: 'Signature verification failed.' });
  }

  if (!event || !event.id || !event.data || !event.data.object) {
    return res.status(400).json({ error: 'Malformed event.' });
  }

  /* Claimed, not checked: two deliveries arriving at once would both
     pass a read-then-write and both be applied. */
  const claimed = await store.setIfAbsent(seenKey(event.id), { type: event.type, at: Date.now() }, { ttlSeconds: SEEN_TTL });
  if (!claimed) {
    console.log(`Stripe event ${event.id} (${event.type}) already applied; ignoring the duplicate.`);
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    const outcome = await applyEvent(event);
    console.log(`Stripe event ${event.id} (${event.type}):`, JSON.stringify(outcome));
    return res.status(200).json(Object.assign({ received: true, duplicate: false }, outcome));
  } catch (err) {
    /* Release the claim so Stripe's retry is a real attempt rather than
       one this endpoint has already promised to have handled. */
    await store.remove(seenKey(event.id));
    console.error('Failed to apply Stripe event', event.id, event.type, err && err.message);
    return res.status(500).json({ error: 'Could not apply the event.' });
  }
};

/* Verifying a signature needs the bytes Stripe sent. Vercel's Node
   runtime parses a JSON body by default, which consumes the stream and
   leaves only a re-serialised object — different whitespace, different
   key order, a signature that cannot match. This turns that off for
   this function only; every other endpoint keeps the parsed body. */
module.exports.config = { api: { bodyParser: false } };

/* exported for the tests, which drive the handlers directly */
module.exports.applyEvent = applyEvent;
module.exports.priceOf = priceOf;
module.exports.toFynd = toFynd;
module.exports.seenKey = seenKey;
