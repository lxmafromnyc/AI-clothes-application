#!/usr/bin/env node
/* =========================================================
   Fynd — create or repair the Stripe webhook endpoint

     STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-webhook-setup.js \
       --url https://your-app.vercel.app/api/stripe-webhook

   Subscribes one Stripe webhook endpoint to exactly the events
   api/stripe-webhook.js has a handler for, and nothing else.

   ---------------------------------------------------------
   Why this exists
   ---------------------------------------------------------
   The dashboard's event picker is a view over an array. Stripe's own
   API takes that array directly — enabled_events on a webhook endpoint
   — and every event this code handles is a current, supported Stripe
   event type that the array accepts. When the picker will not offer one
   of the six, this writes the array Stripe would have written, with the
   same result and the same signing secret.

   It is also the safer way round even when the picker does work: the
   list comes from HANDLERS in api/stripe-webhook.js, so an endpoint
   configured by this script cannot be subscribed to an event nothing
   handles, or miss one that something does.

   ---------------------------------------------------------
   What it does, in order
   ---------------------------------------------------------
   1. Lists the account's webhook endpoints and looks for one whose URL
      matches --url.
   2. No match: creates it, subscribed to the six, and prints the
      signing secret.
   3. A match subscribed to the wrong events: updates enabled_events in
      place and says what changed. The endpoint keeps its id and its
      existing signing secret, so nothing already deployed breaks.
   4. A match already correct: says so and writes nothing.

   Nothing else in the account is touched. It creates no products, no
   prices and no customers, and it never deletes an endpoint unless
   --recreate says to.

   ---------------------------------------------------------
   Flags
   ---------------------------------------------------------
     --url <url>        the endpoint. Required, or set STRIPE_WEBHOOK_URL.
     --dry-run          print the plan and write nothing.
     --list             show every webhook endpoint on the account, then stop.
     --recreate         delete the matching endpoint and make a new one.
                        The only way to be given a signing secret for an
                        endpoint that already exists — Stripe returns it
                        once, at creation. Deliveries in flight are lost,
                        and the secret changes, so the deployment needs
                        the new one before it will accept anything.
     --api-version <v>  pin the delivered payload shape. Optional; the
                        account default is used when it is not given, and
                        api/stripe-webhook.js reads both the old and the
                        new subscription and invoice shapes either way.
     --allow-live       required before this will write with an sk_live_
                        key, so a live endpoint is never reconfigured by
                        a command meant for a sandbox.

   ---------------------------------------------------------
   The one secret it prints
   ---------------------------------------------------------
   Nothing else in this repository prints key material. This prints the
   whsec_ on creation, deliberately: Stripe returns it exactly once, and
   an endpoint whose secret nobody captured is an endpoint whose every
   delivery api/stripe-webhook.js will refuse. It goes straight into
   STRIPE_WEBHOOK_SECRET. The API key itself is never printed.
   ========================================================= */

'use strict';

const stripe = require('../api/_stripe');
const webhook = require('../api/stripe-webhook');

/* The handlers are the specification. Not a list typed out again here. */
const WANTED = webhook.HANDLED_EVENTS.slice().sort();

const DESCRIPTION = 'Fynd — subscription lifecycle (managed by scripts/stripe-webhook-setup.js)';

/* ---------------------------------------------------------
   Arguments
   --------------------------------------------------------- */

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { values[key] = next; i += 1; }
    else flags.add(key);
  }
  return { flags, values };
}

/* A trailing slash is the difference between finding the endpoint and
   creating a second one alongside it. */
const normalise = (url) => String(url || '').trim().replace(/\/+$/, '');

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const fail = (message, hint) => {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
};

/* ---------------------------------------------------------
   The Stripe calls
   ---------------------------------------------------------
   Through api/_stripe.js's request(), so this uses the same key
   handling, the same form encoding and the same pinned Stripe-Version
   as the rest of Fynd. */

const listEndpoints = () => stripe.request('GET', '/webhook_endpoints', { limit: 100 });

const createEndpoint = (params) => stripe.request('POST', '/webhook_endpoints', params);

const updateEndpoint = (id, params) =>
  stripe.request('POST', `/webhook_endpoints/${encodeURIComponent(id)}`, params);

const deleteEndpoint = (id) =>
  stripe.request('DELETE', `/webhook_endpoints/${encodeURIComponent(id)}`, null);

/* ---------------------------------------------------------
   Output
   --------------------------------------------------------- */

function describe(endpoint) {
  const events = (endpoint.enabled_events || []).slice().sort();
  console.log(`  ${endpoint.id}`);
  console.log(`    url        ${endpoint.url}`);
  console.log(`    status     ${endpoint.status || 'enabled'}`);
  console.log(`    version    ${endpoint.api_version || 'account default'}`);
  console.log(`    events     ${events.length === 1 && events[0] === '*' ? '* (all events)' : events.length}`);
  events.forEach((e) => console.log(`               ${WANTED.includes(e) ? ' ' : '~'} ${e}`));
}

function reportDifference(current) {
  const have = (current || []).slice().sort();
  const missing = WANTED.filter((e) => !have.includes(e));
  const extra = have.filter((e) => !WANTED.includes(e));

  if (missing.length) {
    console.log('\n  missing — nothing applies these today:');
    missing.forEach((e) => console.log(`    + ${e}`));
  }
  if (extra.length) {
    console.log('\n  subscribed but unhandled — every delivery claims a store key for four days:');
    extra.forEach((e) => console.log(`    - ${e}`));
  }
  return { missing, extra };
}

function printSecret(secret) {
  console.log('\n  ---------------------------------------------------------');
  console.log('  Signing secret — Stripe returns this once and never again');
  console.log('  ---------------------------------------------------------\n');
  console.log(`    ${secret}\n`);
  console.log('  Set it as STRIPE_WEBHOOK_SECRET on the deployment and redeploy.');
  console.log('  Until it is set, /api/stripe-webhook answers 503 and no plan');
  console.log('  can change. Environment variables only reach builds made');
  console.log('  after they were added, so the redeploy is not optional.');
}

/* ---------------------------------------------------------
   Main
   --------------------------------------------------------- */

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has('dry-run');

  if (!stripe.configured()) {
    fail('STRIPE_SECRET_KEY is not set.',
      'Run this with the key for the account you are configuring:\n' +
      '    STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-webhook-setup.js --url https://…/api/stripe-webhook');
  }

  const live = !stripe.testMode();
  console.log(`\n  Stripe account: ${live ? 'LIVE' : 'TEST'} key`);

  let endpoints;
  try {
    endpoints = await listEndpoints();
  } catch (err) {
    fail(`Stripe refused the request: ${err && err.message}`,
      'A restricted key needs write access to Webhook Endpoints. A secret key has it already.');
  }

  const all = (endpoints && endpoints.data) || [];

  if (flags.has('list')) {
    console.log(`\n  ${all.length} webhook endpoint${all.length === 1 ? '' : 's'} on this account:\n`);
    all.forEach((e) => { describe(e); console.log(''); });
    return;
  }

  const url = normalise(values.url || process.env.STRIPE_WEBHOOK_URL);
  if (!url) {
    fail('No endpoint URL.',
      'Pass --url https://your-app.vercel.app/api/stripe-webhook, or set STRIPE_WEBHOOK_URL.');
  }
  if (!/^https:\/\//i.test(url)) {
    fail(`The endpoint URL must be https: ${url}`,
      'Stripe will not deliver to http. For a local endpoint use: stripe listen --forward-to localhost:3000/api/stripe-webhook');
  }
  if (!/\/api\/stripe-webhook$/.test(url)) {
    console.log(`\n  note: ${url} does not end in /api/stripe-webhook, which is the`);
    console.log('        path this repository serves the handler at. Continuing anyway.');
  }

  if (live && !flags.has('allow-live') && !dryRun) {
    fail('That is a LIVE key, and this would reconfigure a live endpoint.',
      'Re-run with --allow-live if that is what you meant, or --dry-run to see the plan first.');
  }

  console.log(`  Endpoint URL:   ${url}`);
  console.log(`  Events wanted:  ${WANTED.length}, from HANDLERS in api/stripe-webhook.js\n`);
  WANTED.forEach((e) => console.log(`    ${e}`));

  const existing = all.filter((e) => normalise(e.url) === url);
  if (existing.length > 1) {
    console.log(`\n  note: ${existing.length} endpoints share this URL. Working on the first;`);
    console.log('        the others still receive deliveries. Remove them in the dashboard.');
  }
  const match = existing[0] || null;

  const params = { url, enabled_events: WANTED, description: DESCRIPTION };
  if (values['api-version']) params.api_version = values['api-version'];

  /* --------------------------------------------------- create */
  if (!match) {
    console.log('\n  No endpoint exists for that URL — it will be created.');
    if (dryRun) { console.log('\n  --dry-run: nothing was written.\n'); return; }

    const created = await createEndpoint(params);
    console.log(`\n  Created ${created.id}, subscribed to ${(created.enabled_events || []).length} events.`);
    printSecret(created.secret);
    console.log('');
    return;
  }

  console.log('\n  Found an endpoint for that URL:\n');
  describe(match);
  const { missing, extra } = reportDifference(match.enabled_events);

  /* --------------------------------------------------- recreate */
  if (flags.has('recreate')) {
    console.log('\n  --recreate: this endpoint will be DELETED and a new one created.');
    console.log('  Its signing secret will change, and the deployment will refuse every');
    console.log('  delivery until STRIPE_WEBHOOK_SECRET is updated to the new one.');
    if (dryRun) { console.log('\n  --dry-run: nothing was written.\n'); return; }

    await deleteEndpoint(match.id);
    console.log(`\n  Deleted ${match.id}.`);
    const created = await createEndpoint(params);
    console.log(`  Created ${created.id}, subscribed to ${(created.enabled_events || []).length} events.`);
    printSecret(created.secret);
    console.log('');
    return;
  }

  /* --------------------------------------------------- already right */
  if (!missing.length && !extra.length) {
    console.log('\n  Already subscribed to exactly the handled events. Nothing to do.');
    if (match.status && match.status !== 'enabled') {
      console.log(`\n  But its status is "${match.status}", so Stripe is not delivering to it.`);
      console.log('  Enable it in the dashboard, or re-run with --recreate.');
    }
    console.log('');
    return;
  }

  /* --------------------------------------------------- update */
  console.log('\n  enabled_events will be replaced with exactly the handled six.');
  console.log('  Nothing else about the endpoint is touched: it keeps its id, its');
  console.log('  signing secret, its name, its payload style and its API version.');
  if (dryRun) { console.log('\n  --dry-run: nothing was written.\n'); return; }

  /* enabled_events and nothing else. Not the url, not the api_version,
     not the description — an endpoint that already exists was named and
     configured by whoever made it, and the only thing wrong with it is
     which events it is subscribed to. */
  const updated = await updateEndpoint(match.id, { enabled_events: WANTED });
  const now = (updated.enabled_events || []).slice().sort();

  if (!same(now, WANTED)) {
    fail('Stripe stored a different set of events than was asked for.',
      `Wanted: ${WANTED.join(', ')}\n  Stored: ${now.join(', ')}`);
  }

  console.log(`\n  Updated ${updated.id}. Now subscribed to exactly:\n`);
  now.forEach((e) => console.log(`    ${e}`));
  console.log('\n  The signing secret did not change. If the deployment already has');
  console.log('  STRIPE_WEBHOOK_SECRET set for this endpoint, there is nothing more');
  console.log('  to do. If it does not, re-run with --recreate to be issued one.');
  console.log('');
}

main().catch((err) => {
  fail(`Failed: ${err && err.message}`, err && err.code ? `Stripe code: ${err.code}` : null);
});
