/* =========================================================
   FindWear — configuration report for the logs

   Both endpoints answer 503 when the credential they need is not in the
   environment. That answer is correct, but it is silent: the log records
   the status and nothing else, so a deployment whose variables never
   arrived looks exactly like one that was never configured. Telling
   those apart from outside took several rounds of guessing.

   This reports, to the server log only, which of the expected variables
   the running function can see.

   ---------------------------------------------------------
   What it may print, and what it may never print
   ---------------------------------------------------------
   For each name in REPORTED, one word:

     present   the variable exists and is not blank
     empty     the variable exists but its value is blank — the state
               that looks configured in a dashboard and is not
     absent    the variable is not in the environment at all

   Values never leave this file. Not whole, not truncated, not hashed,
   not their length. The only strings this module can emit are the fixed
   names in REPORTED and the three words above, so there is no input
   that could make it print a secret. Request contents are not read here
   at all — nothing is passed in.
   ========================================================= */

'use strict';

/* The variables whose absence explains a 503, and nothing else. Adding a
   name here makes its STATE loggable; it never makes its value loggable. */
const REPORTED = [
  'OPENAI_API_KEY', 'OPENWEBNINJA_API_KEY', 'ALLOWED_ORIGIN', 'VERCEL_ENV',
  /* billing. A 503 from /api/checkout or /api/stripe-webhook has exactly
     one of these behind it, and knowing which turns a guess into a fix. */
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_MAX',
  'AUTH_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'
];

function stateOf(name) {
  const value = process.env[name];
  if (value === undefined || value === null) return 'absent';
  return String(value).trim() === '' ? 'empty' : 'present';
}

/* e.g. "OPENAI_API_KEY=absent OPENWEBNINJA_API_KEY=absent
         ALLOWED_ORIGIN=absent VERCEL_ENV=present" */
const envReport = () => REPORTED.map((name) => `${name}=${stateOf(name)}`).join(' ');

module.exports = { envReport, stateOf, REPORTED };
