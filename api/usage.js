/* =========================================================
   Fynd — usage and plans, for the meter

   Read-only. Answers with the caller's own current usage and the public
   plan table, which is everything the usage meter and the pricing page
   need and nothing else.

   ---------------------------------------------------------
   What this endpoint may not say
   ---------------------------------------------------------
   It reads an account, so it is worth being explicit about what never
   appears in the reply:

     * no API key, of any provider, in any form
     * no billing identity, customer id, card detail or invoice
     * no other account's usage, and no way to ask for one — the account
       is taken from the caller's own credential, never from a parameter
     * no raw network address; anonymous accounts are keyed on a digest

   The numbers here are the same ones the enforcement path reads, from
   the same store, so the meter on screen cannot drift away from what the
   next request will actually be judged against. That is the point of
   serving them from the server at all rather than counting in the page.
   ========================================================= */

'use strict';

const { handledPreflight } = require('./_cors');
const { requireAccount } = require('./_accounts');
const { publicPlans } = require('./_plans');
const usage = require('./_usage');

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Use GET.' });
  }

  /* an unverifiable credential is refused here too: a meter that
     answered anyway would be a way to test tokens quietly */
  const account = requireAccount(req, res);
  if (!account) return;

  let snapshot;
  try {
    snapshot = await usage.snapshot(account);
  } catch (err) {
    /* the store is unreachable. The meter is not important enough to
       fail a page over, so this says so plainly and the interface hides
       the meter rather than showing a figure it cannot stand behind. */
    console.error('Usage store unavailable', err && err.message);
    return res.status(503).json({ error: 'Usage is unavailable right now.', code: 'usage_unavailable' });
  }

  return res.status(200).json({
    usage: snapshot,
    plans: publicPlans()
  });
};
