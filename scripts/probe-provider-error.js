#!/usr/bin/env node
/* =========================================================
   Fynd — why is a product source refusing?

   The smallest live check that names a provider's own error. It makes,
   for SerpApi:

     1. one call to the account endpoint — free, it spends no search —
        and prints the plan's standing: searches left, this hour's
        usage against the hourly limit, and the account's status
     2. ONE search request, exactly as /api/search makes it (same
        adapter, same engine, num=1, no seller lookups). A spent plan or
        a bad key refuses it without charge; if it succeeds it costs one
        search.

   and, with --serper, one Serper /shopping request the same way.

   Each outcome is printed with its HTTP status (read off the adapter's
   own message), the provider's own words, and the kind of failure they
   describe (failureKind in api/_providers/product-source.js). Nothing
   is changed and nothing is written. No key is ever printed: every
   line goes through the adapter's redaction, and the account endpoint's
   answer — which includes the key and the account e-mail — is read
   field by field, never printed whole.

   Usage
     node --env-file=.env.local scripts/probe-provider-error.js
     node --env-file=.env.local scripts/probe-provider-error.js --serper
   ========================================================= */

'use strict';

const serpapi = require('../api/_providers/serpapi');
const serper = require('../api/_providers/serper');
const { failureKind, outOfSearches } = require('../api/_providers/product-source');

/* what each kind of failure means for configuration */
const MEANS = {
  'credits-exhausted': 'the key is valid, but the plan has no searches/credits left — top up or upgrade the plan, or wait for the monthly reset',
  'rate-limited': 'the key is valid, but the hourly throughput limit was hit — wait for the hour to roll over, or raise the plan limit',
  'rate-limited-or-credits': 'HTTP 429 with no message — either the plan is spent or the hourly limit was hit; the account figures above say which',
  'blocked-by-network': 'a proxy or egress rule in front of this machine refused the request before it reached the provider — not the key or the plan',
  'invalid-key': 'the key is wrong, revoked, or the account is disabled — replace the key in .env.local',
  'not-configured': 'no key is set in this environment — check the variable name in .env.local and that --env-file was passed',
  timeout: 'the provider did not answer in time — a network or provider-side delay, not a key or plan problem',
  'bad-request': 'the provider refused the request itself (engine or parameters) — a code/config issue such as SERPAPI_ENGINE, not the key',
  'server-error': 'the provider failed on its side — retry later',
  network: 'the request never reached the provider — DNS, proxy or connectivity',
  other: 'unrecognised — read the provider\'s own words above'
};

const statusOf = (message) => { const m = /responded (\d{3})/.exec(message); return m ? Number(m[1]) : null; };

function report(who, err) {
  const message = String(err && err.message ? err.message : err).split('\n')[0];
  const kind = failureKind(message);
  console.log(`  status   : ${statusOf(message) || (/^SerpApi error:/.test(message) ? '200 with an error payload' : 'no HTTP response')}`);
  console.log(`  error    : ${who.redact ? who.redact(message) : message}`);
  console.log(`  kind     : ${kind}`);
  console.log(`  fallback : ${outOfSearches(message) ? 'yes — /api/search would pass this over to the fallback' : 'no — /api/search would answer 502 with this'}`);
  console.log(`  means    : ${MEANS[kind]}`);
}

/* only these fields of the account answer are ever read out */
const ACCOUNT_FIELDS = ['account_status', 'plan_name', 'searches_per_month', 'plan_searches_left', 'extra_credits',
  'total_searches_left', 'this_month_usage', 'this_hour_searches', 'last_hour_searches', 'account_rate_limit_per_hour'];

async function probeSerpApi() {
  console.log(`\nSerpApi  (key ${serpapi.configured() ? 'set' : 'NOT set'}, engine ${serpapi.engine()})`);
  console.log('account (free):');
  try {
    const account = await serpapi.account();
    for (const field of ACCOUNT_FIELDS) {
      if (account && account[field] !== undefined) console.log(`  ${field.padEnd(28)}: ${serpapi.redact(String(account[field]))}`);
    }
  } catch (err) {
    report(serpapi, err);
  }

  console.log('one search (num=1, no seller lookups):');
  try {
    const payload = await serpapi.apiGet({ engine: serpapi.engine(), q: 'black hoodie', gl: 'us', hl: 'en', num: '1' }, null, 'search', 8000);
    const results = serpapi.resultsFrom(payload);
    console.log(`  ok       : answered with ${results.length} result(s) — SerpApi is NOT failing right now (this cost one search)`);
  } catch (err) {
    report(serpapi, err);
  }
}

async function probeSerper() {
  console.log(`\nSerper  (key ${serper.configured() ? 'set' : 'NOT set'})`);
  console.log('one /shopping search:');
  try {
    const found = await serper.search({ garments: ['hoodie'], colors: ['black'] }, { limit: 1 });
    console.log(`  ok       : answered with ${found.length} record(s) (this cost one credit)`);
  } catch (err) {
    report(serper, err);
  }
}

(async () => {
  await probeSerpApi();
  if (process.argv.includes('--serper')) await probeSerper();
  console.log('');
})().catch((err) => {
  console.error(serpapi.redact(String(err && err.message ? err.message : err)));
  process.exit(1);
});
