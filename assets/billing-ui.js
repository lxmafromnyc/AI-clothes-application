/* =========================================================
   Fynd — the billing interface

   Draws what /api/account said, on the pricing page and on the account
   page. It renders state; it never decides it. Every plan name, limit,
   price and subscription status on screen arrived from the server in
   one reply, and the buttons only ever ask the server to do something.

   The plan cards are already in the HTML, with the same copy the
   server holds. That is on purpose: the page tells a shopper what the
   plans are before any script has run, and on a deployment with no API
   at all it still does. This file marks which one they are on, sets
   what each button says, and wires it up.

   ---------------------------------------------------------
   What happens after Stripe
   ---------------------------------------------------------
   The shopper comes back to ?checkout=success. That parameter is worth
   exactly one sentence on screen — "we are confirming your payment" —
   and nothing else: the plan changes when Stripe's webhook reaches the
   server, so this page re-reads /api/account until the server says the
   plan changed. Loading the success URL by hand does the same thing and
   finds the same answer, which is the plan you actually have.
   ========================================================= */

(function (global) {
  'use strict';

  const doc = global.document;
  if (!doc) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const $ = (id) => doc.getElementById(id);

  /* ---------- words for a state ----------
     Written out rather than assembled, so each one reads as a sentence
     somebody wrote and not as a template that happened to fill. */

  const STATUS_NOTE = {
    past_due: 'Your last payment failed, so your plan has dropped back to Free. Update your card in the billing portal to restore it.',
    unpaid: 'Your subscription has unpaid invoices, so your plan has dropped back to Free. Settle them in the billing portal to restore it.',
    incomplete: 'Your subscription has not finished being set up, so it is not active yet.',
    incomplete_expired: 'That subscription was never completed, so it has expired. You can start again below.',
    paused: 'Your subscription is paused, so your plan is Free until it resumes.',
    canceled: 'Your subscription has ended, so you are on the Free plan.'
  };

  const money = (amount) => (Number(amount) === 0
    ? '$0'
    : `$${Number(amount).toFixed(2)}`);

  const number = (value) => Number(value).toLocaleString();

  const METRIC_LABEL = { aiTokens: 'AI tokens', searches: 'Live product searches' };

  const dateOf = (iso) => {
    const when = new Date(iso);
    return Number.isNaN(when.getTime()) ? null : when;
  };

  const longDate = (iso) => {
    const when = dateOf(iso);
    return when ? when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  };

  const resetWords = (usage) => {
    const when = dateOf(usage.resetsAt);
    if (!when) return '';
    return usage.period === 'month'
      ? `Resets on ${when.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`
      : `Resets at ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  };

  /* ---------- notes ---------- */

  function note(id, text, tone) {
    const el = $(id);
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.className = `billing-note${tone ? ` billing-note--${tone}` : ''}`;
    el.textContent = text;
    el.hidden = false;
  }

  /* Two things a deployment can be wrong about that a shopper deserves
     to be told before they type a card number, and one an operator
     deserves to be told before they trust what they are looking at. */
  /* Read straight off what /api/account said, and only that. "Not
     connected" is said only when there was no answer at all; an answer
     that leaves a field out is not a reason to claim more than it says,
     and never a reason to stop drawing the rest of the page. */
  const billingOf = (state) => (state && state.billing && typeof state.billing === 'object' ? state.billing : {});

  function deploymentNote(state) {
    if (!state) {
      return { text: 'Billing is not connected to this copy of the site, so plans cannot be changed here.', tone: 'warn' };
    }
    const billing = billingOf(state);
    if (billing.enabled !== true) {
      return { text: 'This deployment has no payment provider configured, so the paid plans cannot be bought here yet.', tone: 'warn' };
    }
    if (billing.testMode === true) {
      return { text: 'Stripe is in test mode on this deployment. Checkout works end to end, no real card is charged, and no money moves.', tone: null };
    }
    /* warned only when the server SAYS storage is not durable */
    if (state.storage && state.storage.durable === false) {
      return { text: 'This deployment has no database configured, so accounts and subscriptions are held in memory and will not survive a restart.', tone: 'warn' };
    }
    return { text: '', tone: null };
  }

  /* ---------- the plan cards ---------- */

  function planCards(state) {
    const cards = Array.from(doc.querySelectorAll('.plan-card[data-plan]'));
    if (!cards.length) return;

    const currentId = state && state.plan && state.plan.id ? state.plan.id : 'free';
    const signedIn = Boolean(state && state.signedIn);
    const canBuy = billingOf(state).enabled === true;
    const plans = state && Array.isArray(state.plans) ? state.plans : [];
    const holdsSubscription = Boolean(state && state.subscription
      && ['active', 'trialing'].indexOf(state.subscription.status) >= 0);

    cards.forEach((card) => {
      const planId = card.dataset.plan;
      const known = plans.find((p) => p && p.id === planId) || null;
      /* the server's name for the plan, or the card's own heading */
      const heading = card.querySelector('.plan-name');
      const name = (known && known.name) || (heading ? heading.textContent.trim() : planId);
      const isCurrent = planId === currentId;

      card.classList.toggle('plan-card--current', isCurrent);
      const tag = card.querySelector('[data-current-tag]');
      if (tag) tag.hidden = !isCurrent;

      const button = card.querySelector('[data-plan-action]');
      if (!button) return;

      if (planId === 'free') {
        button.disabled = true;
        button.className = 'btn btn-secondary';
        button.textContent = isCurrent ? 'Your plan' : 'Included in every plan';
        return;
      }

      if (isCurrent) {
        button.disabled = true;
        button.className = 'btn btn-secondary';
        button.textContent = 'Your plan';
        return;
      }

      /* the server's word on each plan decides: purchasable is buyable */
      if (!canBuy || !known || known.purchasable !== true) {
        button.disabled = true;
        button.className = 'btn btn-secondary';
        button.textContent = 'Not available yet';
        return;
      }

      /* Somebody already paying changes plan in the billing portal:
         a second checkout would open a second subscription beside the
         first, and they would be charged for both. */
      if (holdsSubscription) {
        button.disabled = false;
        button.className = 'btn btn-secondary';
        button.textContent = `Switch to ${name}`;
        button.dataset.action = 'portal';
        return;
      }

      button.disabled = false;
      button.className = 'btn btn-primary';
      /* "Get" for somebody on Free, "Upgrade" once there is something
         to upgrade from */
      button.textContent = `${currentId === 'free' ? 'Get' : 'Upgrade to'} ${name}`;
      button.dataset.action = signedIn ? 'checkout' : 'sign-in-first';
    });
  }

  /* ---------- the banner ---------- */

  function banner(state) {
    const wrap = $('plan-banner');
    if (!wrap) return;

    const planName = $('banner-plan');
    const detail = $('banner-detail');
    const actions = $('banner-actions');
    if (!planName || !detail || !actions) return;

    wrap.hidden = false;
    planName.textContent = state && state.plan && state.plan.name ? state.plan.name : 'Free';

    const lines = [];
    if (!state || !state.signedIn) {
      lines.push('You are not signed in. Free is metered per browser; an account is what a subscription attaches to.');
    } else {
      if (state.user && state.user.email) lines.push(state.user.email);
      const sub = state.subscription;
      if (sub && sub.cancelAtPeriodEnd && sub.currentPeriodEnd) {
        lines.push(`Cancels on ${longDate(sub.currentPeriodEnd)}. You keep ${state.plan && state.plan.name ? state.plan.name : 'your plan'} until then.`);
      } else if (sub && sub.status === 'active' && sub.currentPeriodEnd) {
        lines.push(`Renews on ${longDate(sub.currentPeriodEnd)}.`);
      } else if (sub && sub.status === 'trialing' && sub.currentPeriodEnd) {
        lines.push(`Trial ends on ${longDate(sub.currentPeriodEnd)}.`);
      }
    }
    detail.textContent = lines.join(' · ');

    /* Manage subscription is the one control this project deliberately
       does not build: it opens Stripe's billing portal, where the card,
       the plan, the invoices and the cancellation already live. */
    const page = doc.body.dataset.page || '';
    const buttons = [];
    if (billingOf(state).portal) {
      buttons.push('<button class="btn btn-secondary" type="button" data-action="portal">Manage subscription</button>');
    }
    if (state && !state.signedIn && page !== 'account') {
      buttons.push('<a class="btn btn-primary" href="account.html">Sign in</a>');
    } else if (state && state.signedIn && page !== 'account') {
      buttons.push('<a class="btn btn-secondary" href="account.html">Your account</a>');
    } else if (state && state.signedIn && (!state.plan || state.plan.id === 'free')) {
      buttons.push('<a class="btn btn-primary" href="pricing.html">See plans</a>');
    }
    actions.innerHTML = buttons.join('');
  }

  /* ---------- the meters ---------- */

  function meters(state) {
    const wrap = $('usage-meters');
    if (!wrap) return;

    const usageOf = state && state.usage && typeof state.usage === 'object' ? state.usage : null;
    if (!usageOf || !Object.keys(usageOf).length) {
      wrap.innerHTML = '<p class="plan-banner-detail">Usage is not available on this copy of the site.</p>';
      return;
    }

    wrap.innerHTML = Object.keys(usageOf).map((metric) => {
      const usage = usageOf[metric];
      const share = usage.limit > 0 ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;
      const spent = usage.remaining === 0;
      return `<div class="meter">
        <div class="meter-head">
          <span class="meter-label">${esc(METRIC_LABEL[metric] || metric)}</span>
          <span class="meter-value">${esc(number(usage.used))} of ${esc(number(usage.limit))} used</span>
        </div>
        <div class="meter-track">
          <div class="meter-fill${spent ? ' meter-fill--spent' : ''}" style="width: ${share}%"></div>
        </div>
        <p class="meter-reset">${esc(resetWords(usage))}</p>
      </div>`;
    }).join('');
  }

  /* ---------- actions ---------- */

  let busy = false;

  async function go(button, action, plan) {
    if (busy) return;
    busy = true;
    const wasText = button.textContent;
    button.disabled = true;
    button.textContent = 'One moment…';

    const result = action === 'portal'
      ? await global.Account.portal()
      : await global.Account.checkout(plan);

    if (result.ok && result.data && result.data.url) {
      /* Stripe's own page, on Stripe's own domain. No card field has
         ever existed on a Fynd page and none is being created here. */
      global.location.href = result.data.url;
      return;
    }

    busy = false;
    button.disabled = false;
    button.textContent = wasText;

    const message = (result.data && result.data.error)
      || 'That did not work. Try again in a moment.';
    note('billing-note', message, 'warn');

    if (result.data && result.data.reason === 'sign-in-required') {
      note('billing-note', 'Sign in first — a subscription has to belong to an account.', 'warn');
    }
  }

  function wireActions() {
    doc.addEventListener('click', (event) => {
      const target = event.target;
      const button = target && target.closest ? target.closest('[data-action]') : null;
      if (!button || !global.Account) return;
      const action = button.dataset.action;

      if (action === 'sign-in-first') {
        const card = button.closest('.plan-card');
        const plan = card ? card.dataset.plan : '';
        global.location.href = `account.html?plan=${encodeURIComponent(plan || '')}`;
        return;
      }

      if (action === 'checkout') {
        const card = button.closest('.plan-card');
        return go(button, 'checkout', card ? card.dataset.plan : '');
      }

      if (action === 'portal') return go(button, 'portal');

      if (action === 'sign-out') {
        return global.Account.logout().then(() => global.location.reload());
      }
    });
  }

  /* ---------- coming back from Stripe ---------- */

  async function handleReturn(state) {
    const params = new URLSearchParams(global.location.search || '');
    const outcome = params.get('checkout');
    if (!outcome) return;

    if (outcome === 'cancelled') {
      note('checkout-note', 'Checkout was cancelled. Nothing was charged and your plan has not changed.', null);
      return;
    }
    if (outcome !== 'success') return;

    const wasPlan = state && state.plan ? state.plan.id : 'free';
    if (wasPlan !== 'free') {
      note('checkout-note', `Payment received. You are on ${state.plan.name}.`, 'good');
      return;
    }

    /* The redirect is not the grant. This waits for the server. */
    note('checkout-note', 'Payment received. Confirming it with Stripe — this usually takes a few seconds…', null);
    const after = await global.Account.awaitPlanChange(wasPlan);

    if (after && after.plan && after.plan.id !== wasPlan) {
      note('checkout-note', `Payment confirmed. You are on ${after.plan.name}.`, 'good');
    } else {
      note('checkout-note', 'Stripe has your payment, but the confirmation has not reached Fynd yet. Reload this page in a moment — your plan changes as soon as it arrives.', 'warn');
    }
  }

  /* ---------- putting it together ---------- */

  function draw(state) {
    const deployment = deploymentNote(state);
    note('deployment-note', deployment.text, deployment.tone);
    banner(state);
    planCards(state);
    meters(state);
  }

  async function start() {
    if (!global.Account) return;
    global.Account.subscribe(draw);
    await global.Account.load();
    draw(global.Account.state());
    await handleReturn(global.Account.state());
  }

  wireActions();

  /* The account page decides its own shell first — signed in or not is
     what determines whether any of this is even on screen there — so it
     loads the state and calls draw() itself. Every other page starts
     here. */
  if (doc.body.dataset.page !== 'account') {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
    else start();
  }

  global.BillingUI = { draw, note, resetWords, money, number, deploymentNote, banner, meters, planCards, handleReturn, start };
})(typeof window !== 'undefined' ? window : globalThis);
