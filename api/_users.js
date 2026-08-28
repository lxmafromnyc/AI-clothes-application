/* =========================================================
   Fynd — user records, and the Stripe identities attached to them

   One record per account, plus two indexes that let a request find it
   from the two directions it ever arrives from:

     user:<id>                the record
     user:email:<email>       -> id     a sign-in, by what was typed
     user:google:<sub>        -> id     a Google sign-in, by Google's
                                        immutable subject id
     user:customer:<cus_…>    -> id     a webhook, by who Stripe billed

   One account, reachable four ways. Signing in with Google using the
   address an email account already uses finds that account and attaches
   Google to it — it does not make a second one. There is no separate
   "Google user" anywhere in this system: a subscription, a usage
   counter and a Stripe customer all hang off the same record however
   its owner proved who they were.

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
const googleKey = (sub) => `user:google:${String(sub || '').trim()}`;

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

  /* Normalised here rather than at each call site, so a record written
     from the OAuth callback and one written from the sign-up form have
     the same shape and the same defaults. */
  record.name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : '';
  record.emailVerified = Boolean(record.emailVerified);
  record.emailVerifiedAt = record.emailVerifiedAt || null;
  record.googleSub = record.googleSub ? String(record.googleSub) : null;
  record.passwordHash = record.passwordHash || null;
  /* Raised to invalidate every session this account has. Sessions store
     the epoch they were issued under, and _auth.identify drops any that
     no longer match — so a password reset logs out every device without
     needing a list of them. */
  record.sessionEpoch = Number.isFinite(Number(record.sessionEpoch)) ? Number(record.sessionEpoch) : 0;

  await store.set(userKey(record.id), record);
  return record;
}

const byId = (id) => (id ? store.get(userKey(id)) : Promise.resolve(null));

async function byEmail(email) {
  if (!normaliseEmail(email)) return null;
  const id = await store.get(emailKey(email));
  return id ? byId(id) : null;
}

async function byGoogleSub(sub) {
  if (!String(sub || '').trim()) return null;
  const id = await store.get(googleKey(sub));
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
async function create({ email, passwordHash, name, emailVerified, googleSub }) {
  const address = normaliseEmail(email);
  const id = newId();

  const claimed = await store.setIfAbsent(emailKey(address), id);
  if (!claimed) return { user: null, reason: 'email-taken' };

  const user = await save({
    id,
    email: address,
    name: name || '',
    passwordHash: passwordHash || null,
    /* Only ever true when somebody else already proved the address: an
       account created from the sign-up form is unverified until the
       person follows a link sent to that address. */
    emailVerified: Boolean(emailVerified),
    emailVerifiedAt: emailVerified ? new Date().toISOString() : null,
    googleSub: googleSub || null,
    sessionEpoch: 0,
    createdAt: new Date().toISOString(),
    stripeCustomerId: null,
    subscription: null,
    plan: DEFAULT_PLAN
  });

  if (googleSub) await store.set(googleKey(googleSub), id);

  return { user, reason: null };
}

/* Marks the address proved. Idempotent, so a link followed twice — or
   followed after a Google sign-in already proved the same address —
   is not an error. */
async function markVerified(user) {
  if (user.emailVerified) return user;
  return save(Object.assign({}, user, {
    emailVerified: true,
    emailVerifiedAt: new Date().toISOString()
  }));
}

/* Attaches a Google identity to an existing account, and refuses to
   move one that is already attached to a different Google subject —
   the same rule, and for the same reason, as linkCustomer below. */
async function linkGoogle(user, sub, name) {
  const subject = String(sub || '').trim();
  if (!subject) return user;
  if (user.googleSub && user.googleSub !== subject) {
    console.warn('Refusing to relink a Google identity for a user that already has one.');
    return user;
  }
  await store.set(googleKey(subject), user.id);
  return save(Object.assign({}, user, {
    googleSub: subject,
    /* Google has proved the address, so an account that was waiting on
       an email link no longer is. */
    emailVerified: true,
    emailVerifiedAt: user.emailVerifiedAt || new Date().toISOString(),
    name: user.name || (name || '')
  }));
}

/* Sets a new password and ends every existing session.

   Raising the epoch is the point: whoever prompted the reset — the
   owner, or somebody who had got into the account — is signed out
   everywhere by the change, including on devices nobody has a list of. */
async function setPassword(user, passwordHash) {
  return save(Object.assign({}, user, {
    passwordHash,
    sessionEpoch: Number(user.sessionEpoch || 0) + 1
  }));
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
  name: user.name || '',
  emailVerified: Boolean(user.emailVerified),
  createdAt: user.createdAt,
  /* how this account can be signed into, so the page can say "you
     signed up with Google" rather than offering a password reset for a
     password that does not exist */
  signInMethods: [
    user.passwordHash ? 'password' : null,
    user.googleSub ? 'google' : null
  ].filter(Boolean),
  hasBilling: Boolean(user.stripeCustomerId)
} : null);

module.exports = {
  normaliseEmail,
  looksLikeEmail,
  shapeSubscription,
  save,
  byId,
  byEmail,
  byGoogleSub,
  byCustomerId,
  create,
  markVerified,
  linkGoogle,
  setPassword,
  linkCustomer,
  applySubscription,
  publicUser,
  userKey,
  emailKey,
  googleKey,
  customerKey
};
