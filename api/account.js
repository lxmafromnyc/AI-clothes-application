/* =========================================================
   Fynd — who am I, and what am I entitled to

   The one endpoint the interface asks. It answers with the plan the
   server holds for this request, the usage counted against it, and the
   plan catalogue to render — so a page never has to work out an
   entitlement, and never has one to disagree with.

   GET only, and never cached: the answer is about the caller.

   This endpoint is the reason the frontend cannot grant itself
   anything. It reads. There is no request shape that changes a plan
   here, and the two endpoints that do change one — Stripe's webhook,
   and nothing else — do not take instructions from a browser.
   ========================================================= */

'use strict';

const { handledPreflight } = require('./_cors');
const { identify } = require('./_auth');
const users = require('./_users');
const { accountPayload } = require('./_billing');

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });

  /* an anonymous caller is given a device id here, so the free
     allowance is counted per visitor rather than per request */
  const identity = await identify(req, res, users);

  res.setHeader('Cache-Control', 'no-store, private');

  try {
    return res.status(200).json(await accountPayload(identity));
  } catch (err) {
    console.error('Account lookup failed', err && err.message);
    return res.status(500).json({ error: 'Could not read your account.' });
  }
};
