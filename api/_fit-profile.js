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

const NEWER = [{ field: 'schemaVersion', message: 'Your fit profile was saved by a newer version of Fynd. Reload the page and try again.' }];
const isNewer = (record) => Boolean(record) && Number.isInteger(record.schemaVersion) && record.schemaVersion > Schema.SCHEMA_VERSION;

async function write(userId, profile, existing) {
  const now = new Date().toISOString();
  const record = Object.assign(profile, {
    createdAt: (existing && typeof existing.createdAt === 'string') ? existing.createdAt : now,
    updatedAt: now
  });
  await store.set(profileKey(userId), record);
  return record;
}

/* Validates, then replaces the profile. { profile, errors }: with any
   error nothing is written.

   Replaces it all except the guide's answers when a save leaves them
   out: a fit profile page loaded before a version that added them sends
   measurements, sizes and fits and nothing else, and must not erase
   what the guide saved. Sent as null, an answer is cleared; not sent,
   it is kept. Sent, `garments` is the whole map — the fit profile
   page's editor sends every type it shows, and a type it removed is
   gone. */
async function save(userId, input) {
  if (!userId) return { profile: null, errors: [{ field: 'profile', message: 'Sign in first.' }] };

  const { profile, errors } = Schema.normalise(input);
  if (errors.length) return { profile: null, errors };

  const existing = await store.get(profileKey(userId));
  if (isNewer(existing)) return { profile: null, errors: NEWER };

  const stored = existing ? Schema.upgrade(existing) : null;
  if (stored) {
    Schema.GUIDE_FIELDS.forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(input, field)) profile[field] = stored[field];
    });
    /* A page loaded before version 4 sends each type without its sizing
       line; the line the guide saved stays. */
    const sent = input.garments && typeof input.garments === 'object' ? input.garments : null;
    if (sent) {
      Object.keys(profile.garments).forEach((id) => {
        const entry = sent[id];
        const keep = stored.garments[id] && stored.garments[id].line;
        if (keep && entry && typeof entry === 'object' && !Object.prototype.hasOwnProperty.call(entry, 'line')) {
          profile.garments[id].line = keep;
        }
      });
    }
  }

  return { profile: await write(userId, profile, existing), errors: [] };
}

/* The fit guide's save: its answers for one type of clothing, merged
   into whatever is stored. Every other type, measurements, usual sizes
   and per-category fits are carried over as stored and not sent back
   and forth, so the guide cannot lose them. Within the type, an answer
   the guide did not send — a skipped step — keeps its saved value.

   A page loaded before version 3 sends version 2's answers about a top
   instead; they are kept where version 2 kept them, and no type is
   touched. { profile, errors }, as save(). */
async function saveGuide(userId, input) {
  if (!userId) return { profile: null, errors: [{ field: 'profile', message: 'Sign in first.' }] };

  const { answers, errors } = Schema.normaliseGuide(input);
  if (errors.length) return { profile: null, errors };

  const existing = await store.get(profileKey(userId));
  if (isNewer(existing)) return { profile: null, errors: NEWER };

  const profile = (existing && Schema.upgrade(existing)) || Schema.empty();
  delete profile.createdAt;
  delete profile.updatedAt;
  Schema.LEGACY_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(answers, field)) profile[field] = answers[field];
  });
  if (Object.prototype.hasOwnProperty.call(answers, 'garments')) {
    profile.garments = Schema.mergeGarments(profile.garments, answers.garments);
  }

  return { profile: await write(userId, profile, existing), errors: [] };
}

async function remove(userId) {
  if (!userId) return false;
  await store.remove(profileKey(userId));
  return true;
}

module.exports = { read, save, saveGuide, remove, profileKey };
