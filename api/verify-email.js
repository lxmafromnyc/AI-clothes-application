/* =========================================================
   Fynd — confirm an email address

   GET /api/verify-email?token=…

   The link from the verification email. A top-level navigation, so
   every outcome is a redirect to the account page carrying one word
   about what happened — never a JSON body somebody has landed on, and
   never the token in the destination.

   ---------------------------------------------------------
   The token is spent here, exactly once
   ---------------------------------------------------------
   `tokens.consume` reads and deletes in one store operation, so a link
   opened twice — and they are, constantly: mail clients and security
   scanners follow links before the person does — succeeds once and then
   reports itself as used. There is no window in which two requests can
   both be honoured.

   Because the record is gone after the first use, "already used" and
   "never existed" are genuinely the same state rather than two states
   told apart by a flag. That is the property that makes reuse
   impossible rather than merely noticed.

   ---------------------------------------------------------
   What a valid token proves, and what it does not
   ---------------------------------------------------------
   It proves somebody read email sent to that address. So it marks the
   address verified — and nothing else. It does not sign anybody in:
   the person who clicks the link in the inbox may be on a different
   device from the one that signed up, and handing a session to whoever
   opens an email would make the link a credential rather than a
   confirmation. The account page asks them to sign in, and then works.
   ========================================================= */

'use strict';

const { siteOrigin } = require('./_cors');
const tokens = require('./_tokens');
const users = require('./_users');
const { accountsEnabled } = require('./_auth');

function bounce(res, site, params) {
  const query = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', `${site}/account.html?${query}`);
  /* the URL carries a token; nothing may keep a copy of it */
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.end();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });

  const url = new URL(req.url, `https://${(req.headers && req.headers.host) || 'localhost'}`);
  const token = url.searchParams.get('token');
  const fallbackSite = siteOrigin(req);

  if (!accountsEnabled()) {
    return bounce(res, fallbackSite, { verify: 'error', reason: 'accounts-not-configured' });
  }
  if (!token) {
    return bounce(res, fallbackSite, { verify: 'error', reason: 'invalid' });
  }

  const spent = await tokens.consume(tokens.PURPOSE.VERIFY_EMAIL, token);
  if (!spent.ok) {
    /* the reason word only — never the token, not even a fragment */
    console.log(`Email verification refused: ${spent.reason}`);
    return bounce(res, fallbackSite, {
      verify: 'error',
      reason: spent.reason === 'expired' ? 'expired' : 'invalid'
    });
  }

  /* The site the person was on when the link was sent, recorded at
     issue time from an origin the allow-list already accepted. Never
     taken from this request's query string, which is how a verification
     link becomes an open redirect. */
  const site = spent.payload.site || fallbackSite;

  try {
    const user = await users.byId(spent.payload.userId);
    if (!user) return bounce(res, site, { verify: 'error', reason: 'invalid' });

    /* The link was sent to one address. If the account's address has
       changed since, this link proves ownership of the old one and
       nothing about the new one. */
    if (spent.payload.email && spent.payload.email !== user.email) {
      console.log('Email verification refused: address-changed');
      return bounce(res, site, { verify: 'error', reason: 'address-changed' });
    }

    if (user.emailVerified) return bounce(res, site, { verify: 'already' });

    await users.markVerified(user);
    console.log(`Email verified for ${user.id}`);
    return bounce(res, site, { verify: 'success' });
  } catch (err) {
    console.error('Could not verify an email address:', err && err.message);
    return bounce(res, site, { verify: 'error', reason: 'server-error' });
  }
};
