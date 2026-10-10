/* =========================================================
   Fynd — where a shopper's fit profile is kept

   One record per account, in the same store as the account itself:

     fitprofile:<user id>     the profile, as assets/fit-profile-schema.js
                              shapes it, plus when it was made and changed

   Every function here takes the user id of the account a request was
   authenticated as, and nothing else names a profile. There is no way
   to ask for "the profile of user X": the id comes from the session, in
   api/fit-profile.js, and never from the request.

   No new storage: on a deployment with Vercel KV or Upstash this is
   durable; on the memory driver it lasts as long as the account does,
   which is to say one warm instance, and the endpoint says so.
   ========================================================= */

'use strict';

const store = require('./_store');
const Schema = require('../assets/fit-profile-schema.js');

const profileKey = (userId) => `fitprofile:${userId}`;

/* { profile, reason }. A profile that exists but was written by a later
   schema than this deployment knows is reported, not replaced: saving
   over it would throw away whatever the later version added. */
async function read(userId) {
  if (!userId) return { profile: null, reason: 'no-user' };
  const record = await store.get(profileKey(userId));
  if (!record) return { profile: null, reason: null };
  const profile = Schema.upgrade(record);
  return profile ? { profile, reason: null } : { profile: null, reason: 'unsupported-version' };
}

/* Validates, then replaces the whole profile. { profile, errors }: with
   any error nothing is written. */
async function save(userId, input) {
  if (!userId) return { profile: null, errors: [{ field: 'profile', message: 'Sign in first.' }] };

  const { profile, errors } = Schema.normalise(input);
  if (errors.length) return { profile: null, errors };

  const existing = await store.get(profileKey(userId));
  if (existing && Number.isInteger(existing.schemaVersion) && existing.schemaVersion > Schema.SCHEMA_VERSION) {
    return { profile: null, errors: [{ field: 'schemaVersion', message: 'Your fit profile was saved by a newer version of Fynd. Reload the page and try again.' }] };
  }
  const now = new Date().toISOString();
  const record = Object.assign(profile, {
    createdAt: (existing && typeof existing.createdAt === 'string') ? existing.createdAt : now,
    updatedAt: now
  });

  await store.set(profileKey(userId), record);
  return { profile: record, errors: [] };
}

async function remove(userId) {
  if (!userId) return false;
  await store.remove(profileKey(userId));
  return true;
}

module.exports = { read, save, remove, profileKey };
