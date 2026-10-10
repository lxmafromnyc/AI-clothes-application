/* =========================================================
   Fynd — the shopper's fit profile

   GET                                 -> { profile, storage }
   POST { action: "save", profile }    -> { profile, storage, saved }
   POST { action: "delete" }           -> { profile: null, storage, deleted }

   Measurements, usual sizes by brand, and preferred fit — the shape is
   assets/fit-profile-schema.js, and every save goes through its
   normalise() here, whatever the page already checked.

   ---------------------------------------------------------
   Whose profile
   ---------------------------------------------------------
   Always the signed-in caller's own, and only theirs. The account is
   the one the session cookie resolves to; no id, email or key in the
   query or the body is read, so there is no request that names somebody
   else's profile. Signed out, every method answers 401.

   Saving and deleting change something on a session, so they carry the
   CSRF token /api/account handed the page, the same as logout and
   checkout. POST with an action, rather than PUT and DELETE, so the
   cross-origin rules in _cors.js already cover it.

   ---------------------------------------------------------
   What never leaves
   ---------------------------------------------------------
   A profile is answered to its owner with no-store, and appears in no
   other response: /api/account says nothing about it. Nothing here logs
   a measurement, a brand or a size — a failure logs the store's own
   message, which names the command and never its arguments.
   ========================================================= */

'use strict';

const { handledPreflight } = require('./_cors');
const { readJson } = require('./_body');
const { identify, csrfOk } = require('./_auth');
const users = require('./_users');
const store = require('./_store');
const fitProfiles = require('./_fit-profile');

const storage = () => ({ durable: store.durable() });

module.exports = async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Use GET or POST.' });

  res.setHeader('Cache-Control', 'no-store, private');

  const identity = await identify(req, res, users);
  if (!identity.user) {
    return res.status(401).json({ error: 'Sign in to see your fit profile.', reason: 'sign-in-required' });
  }
  const userId = identity.user.id;

  /* --------------------------------------------------- read */
  if (req.method === 'GET') {
    try {
      const { profile, reason } = await fitProfiles.read(userId);
      if (reason === 'unsupported-version') {
        return res.status(409).json({
          error: 'Your fit profile was saved by a newer version of Fynd. Reload the page.',
          reason
        });
      }
      return res.status(200).json({ profile, storage: storage() });
    } catch (err) {
      console.error('Fit profile read failed', err && err.message);
      return res.status(500).json({ error: 'Could not read your fit profile. Try again in a moment.' });
    }
  }

  /* --------------------------------------------------- change */
  if (identity.sessionToken && !csrfOk(req, identity.sessionToken)) {
    return res.status(403).json({ error: 'Missing or invalid CSRF token.', reason: 'csrf' });
  }

  const body = await readJson(req);
  const action = String((body && body.action) || '').trim();

  if (action === 'save') {
    try {
      const { profile, errors } = await fitProfiles.save(userId, body.profile);
      if (errors.length) {
        const stale = errors.some((e) => e.field === 'schemaVersion');
        return res.status(stale ? 409 : 400).json({
          error: errors.length === 1 ? errors[0].message : 'Some of that needs fixing before it can be saved.',
          reason: stale ? 'unsupported-version' : 'invalid',
          errors
        });
      }
      return res.status(200).json({ profile, storage: storage(), saved: true });
    } catch (err) {
      console.error('Fit profile save failed', err && err.message);
      return res.status(500).json({ error: 'Could not save your fit profile. Try again in a moment.' });
    }
  }

  if (action === 'delete') {
    try {
      await fitProfiles.remove(userId);
      return res.status(200).json({ profile: null, storage: storage(), deleted: true });
    } catch (err) {
      console.error('Fit profile delete failed', err && err.message);
      return res.status(500).json({ error: 'Could not delete your fit profile. Try again in a moment.' });
    }
  }

  return res.status(400).json({ error: 'Unknown action.', reason: 'unknown-action' });
};
