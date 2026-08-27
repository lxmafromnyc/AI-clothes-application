/* =========================================================
   Fynd — user records, and the Stripe identities attached to them

   One record per account, plus two indexes that let a request find it
   from the two directions it ever arrives from:

     user:<id>                the record
     user:email:<email>       -> id     a sign-in, by what was typed
     user:customer:<cus_…>    -> id     a webhook, by who Stripe billed

   The second index is the whole of the customer/account mapping. A
   Stripe webhook knows a customer id and nothing about Fynd, so without
   it a subscription could not be attached to anybody. It is written the
   moment a Stripe customer is created for a user, before checkout is
   started, so the webhook can never arrive before the mapping exists.

   ---------------------------------------------------------
   The plan is stored, and it is derived
   ---------------------------------------------------------
   `plan` on the record is a cache of planFromSubscription(subscription),
   never something a caller may set. Every write recomputes it from the
   subscription, so there is no path — no endpoint, no request body, no
   frontend — that can raise somebody's plan without a subscription in
   an entitling status underneath it. `save()` enforces that, so the
   rule cannot be forgotten at one call site.
   ========================================================= */

'use strict';

const crypto = require('crypto');
const store = require('./_store');
const { planFromSubscription, DEFAULT_PLAN } = require('./_plans');

const userKey = (id) => `user:${id}`;
const emailKey = (email) => `user:email:${normaliseEmail(email)}`;
const customerKey = (customerId) => `user:customer:${String(customerId || '').trim()}`;

/* Addresses are compared case-insensitively, so they are stored that
   way too. Nothing else is normalised: the local part of an address is
   the mail server's business, not ours. */
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

/* RFC-perfect validation is not possible and not useful; this rejects
   what is obviously not an address and leaves the rest to Stripe, which
   will refuse to bill an address it cannot reach. */
const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normaliseEmail(email));

const newId = () => `usr_${crypto.randomBytes(12).toString('hex')}`;

/* The subscription fields Fynd keeps. Stripe's object is large and most
   of it is Stripe's business; these are the parts an entitlement or a
   piece of interface copy is decided from.

   `updatedAt` is the event's own timestamp, not the time we processed
   it. Webhook deliveries are not ordered, so a `created` event can
   arrive after the `deleted` that followed it; comparing event
   timestamps is what stops the older one winning. */
function shapeSubscription(raw) {
  const sub = raw && typeof raw === 'object' ? raw : null;
  if (!sub) return null;
  return {
    id: sub.id ? String(sub.id) : null,
    status: sub.status ? String(sub.status) : 'incomplete',
    priceId: sub.priceId ? String(sub.priceId) : null,
    currentPeriodEnd: Number.isFinite(Number(sub.currentPeriodEnd)) ? Number(sub.currentPeriodEnd) : null,
    cancelAtPeriodEnd: Boolean(sub.cancelAtPeriodEnd),
    /* Stripe's own words for why a payment is not going through, kept
       so the interface can say which of them it is */
    latestInvoiceStatus: sub.latestInvoiceStatus ? String(sub.latestInvoiceStatus) : null,
    updatedAt: Number.isFinite(Number(sub.updatedAt)) ? Number(sub.updatedAt) : 0
  };
}

/* The one writer. Recomputes the plan from the subscription every time,
   so `plan` cannot drift from what was actually paid for. */
async function save(user) {
  const record = Object.assign({}, user);
  record.subscription = shapeSubscription(record.subscription);
  record.plan = planFromSubscription(record.subscription);
  await store.set(userKey(record.id), record);
  return record;
}

const byId = (id) => (id ? store.get(userKey(id)) : Promise.resolve(null));

async function byEmail(email) {
  if (!normaliseEmail(email)) return null;
  const id = await store.get(emailKey(email));
  return id ? byId(id) : null;
}

async function byCustomerId(customerId) {
  if (!String(customerId || '').trim()) return null;
  const id = await store.get(customerKey(customerId));
  return id ? byId(id) : null;
}

/* Creates the account, or reports that the address is taken.

   The email index is claimed with a set-if-absent before the record is
   written, so two simultaneous sign-ups for one address cannot both
   succeed — the loser is told the address is taken rather than
   overwriting the winner's account. */
async function create({ email, passwordHash }) {
  const address = normaliseEmail(email);
  const id = newId();

  const claimed = await store.setIfAbsent(emailKey(address), id);
  if (!claimed) return { user: null, reason: 'email-taken' };

  const user = await save({
    id,
    email: address,
    passwordHash,
    createdAt: new Date().toISOString(),
    stripeCustomerId: null,
    subscription: null,
    plan: DEFAULT_PLAN
  });

  return { user, reason: null };
}

/* Attaches a Stripe customer to a user, in both directions, and refuses
   to move one that is already attached: a user whose customer id
   changed would leave the old customer's subscription pointing at an
   account nothing would ever update again. */
async function linkCustomer(user, customerId) {
  const id = String(customerId || '').trim();
  if (!id) return user;
  if (user.stripeCustomerId && user.stripeCustomerId !== id) {
    console.warn('Refusing to relink a Stripe customer for a user that already has one.');
    return user;
  }
  await store.set(customerKey(id), user.id);
  return save(Object.assign({}, user, { stripeCustomerId: id }));
}

/* Applies a subscription to a user, unless a newer one already has.

   Same-timestamp events are allowed through: Stripe stamps several
   events from one action with the same second, and dropping them would
   lose the last word on a change. Strictly older ones are dropped. */
async function applySubscription(user, subscription) {
  const next = shapeSubscription(subscription);
  const current = user.subscription;

  if (current && next && current.updatedAt > next.updatedAt) {
    return { user, applied: false, reason: 'stale' };
  }

  const saved = await save(Object.assign({}, user, { subscription: next }));
  return { user: saved, applied: true, reason: null };
}

/* What /api/account may say about a user. No password hash, and no
   Stripe ids: the browser has no use for either, and a customer id in a
   page is a customer id in somebody's browser history. */
const publicUser = (user) => (user ? {
  id: user.id,
  email: user.email,
  createdAt: user.createdAt,
  hasBilling: Boolean(user.stripeCustomerId)
} : null);

module.exports = {
  normaliseEmail,
  looksLikeEmail,
  shapeSubscription,
  save,
  byId,
  byEmail,
  byCustomerId,
  create,
  linkCustomer,
  applySubscription,
  publicUser,
  userKey,
  emailKey,
  customerKey
};
