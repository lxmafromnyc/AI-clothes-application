/* =========================================================
   Fynd — how much work a size comparison takes: anonymous counters

     POST /api/size-recommendation?metrics=1
     { "events": [ { "name": "comparison_completed", "surface": "site",
                     "value": 3 }, … ] }

   Product metrics for Find Fit and the extension, kept as daily
   counters and nothing else:

     - no identifier of any kind: no user id, no session, no cookie read,
       no address kept (the rate limit hashes it, for ten minutes)
     - no page address, product, brand, size or measurement: only an
       event's name from the list below, which surface sent it, and for
       the two timed or counted events a number — added to a daily sum
       and a coarse bucket, never stored as it was sent
     - the browser sends nothing when it says Do Not Track or Global
       Privacy Control (assets/fit-metrics.js, extension/api.js)

   What the counters answer (scripts/fit-metrics-report.js):
     manual inputs per successful comparison   manual_inputs ÷ comparison_completed
     time from opening to a result             seconds_to_result
     reference set-up abandonment              reference_started − reference_ready
     candidate set-up abandonment              candidate_started − candidate_ready
     automatic extraction success              extraction_* by kind
     unavailable results                       result_* by outcome
     comparison completion                     comparison_completed ÷ comparison_started
     saved-reference reuse                     reference_ready_saved ÷ reference_ready
   ========================================================= */

'use strict';

const store = require('./_store');
const limits = require('./_ratelimit');
const auth = require('./_auth');
const { readJson } = require('./_body');

const EVENTS = [
  'session_start',
  'reference_started', 'reference_ready', 'reference_ready_saved', 'reference_ready_search', 'reference_ready_link', 'reference_ready_manual',
  'candidate_started', 'candidate_ready', 'candidate_ready_link', 'candidate_ready_extension', 'candidate_ready_manual',
  'extraction_automatic', 'extraction_assisted', 'extraction_ai_assisted', 'extraction_unavailable', 'extraction_body_only',
  'comparison_started', 'comparison_completed',
  'result_ok', 'result_no_match', 'result_insufficient', 'result_error',
  'manual_inputs', 'seconds_to_result'
];
/* the two that carry a number, and the buckets it is counted in */
const VALUED = {
  manual_inputs: [0, 2, 5, 10, 20],
  seconds_to_result: [30, 60, 120, 300, 600]
};
const SURFACES = ['site', 'extension'];
const MAX_EVENTS = 20;
const TTL_SECONDS = 400 * 24 * 60 * 60;

const day = (at) => new Date(at || Date.now()).toISOString().slice(0, 10);
const key = (d, surface, name, part) => `metrics:${d}:${surface}:${name}${part ? `:${part}` : ''}`;
const bucketOf = (name, v) => { const edges = VALUED[name]; const i = edges.findIndex((e) => v <= e); return i < 0 ? `gt${edges[edges.length - 1]}` : `le${edges[i]}`; };

/* [] when the events are acceptable, else what is wrong — anything outside the list is refused whole */
function read(body) {
  const events = body && Array.isArray(body.events) ? body.events : null;
  if (!events || !events.length || events.length > MAX_EVENTS) return { events: null, error: 'Send 1 to 20 events.' };
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { events: null, error: 'Each event is an object.' };
    if (Object.keys(e).some((k) => !['name', 'surface', 'value'].includes(k))) return { events: null, error: 'Unexpected field.' };
    if (!EVENTS.includes(e.name)) return { events: null, error: 'Unknown event.' };
    const surface = e.surface === undefined ? 'site' : e.surface;
    if (!SURFACES.includes(surface)) return { events: null, error: 'Unknown surface.' };
    let value = null;
    if (VALUED[e.name]) {
      if (!Number.isFinite(e.value) || e.value < 0 || e.value > 100000) return { events: null, error: 'A number between 0 and 100000.' };
      value = Math.round(e.value);
    } else if (e.value !== undefined) return { events: null, error: 'Only manual_inputs and seconds_to_result carry a value.' };
    out.push({ name: e.name, surface, value });
  }
  return { events: out, error: null };
}

async function record(events, at) {
  const d = day(at);
  for (const e of events) {
    await store.add(key(d, e.surface, e.name), 1, { ttlSeconds: TTL_SECONDS });
    if (e.value !== null) {
      await store.add(key(d, e.surface, e.name, 'sum'), e.value, { ttlSeconds: TTL_SECONDS });
      await store.add(key(d, e.surface, e.name, bucketOf(e.name, e.value)), 1, { ttlSeconds: TTL_SECONDS });
    }
  }
}

/* one day's counters, by surface (for the report script) */
async function summary(d) {
  const out = {};
  for (const surface of SURFACES) {
    out[surface] = {};
    for (const name of EVENTS) {
      const n = await store.readNumber(key(d, surface, name));
      if (!n) continue;
      const entry = { count: n };
      if (VALUED[name]) {
        entry.sum = await store.readNumber(key(d, surface, name, 'sum'));
        entry.buckets = {};
        for (const b of VALUED[name].map((e) => `le${e}`).concat(`gt${VALUED[name][VALUED[name].length - 1]}`)) {
          const c = await store.readNumber(key(d, surface, name, b));
          if (c) entry.buckets[b] = c;
        }
      }
      out[surface][name] = entry;
    }
  }
  return out;
}

async function handler(req, res) {
  const address = auth.addressSubject(req);
  const gate = await limits.check('metrics', address);
  if (!gate.allowed) return res.status(429).json({ error: 'Too many.', reason: 'rate-limited' });
  await limits.note('metrics', address);
  const got = read(await readJson(req));
  if (got.error) return res.status(400).json({ error: got.error, reason: 'invalid-events' });
  try { await record(got.events); } catch (err) { console.error('Could not record metrics.', err && err.message); }
  return res.status(200).json({ ok: true });
}

module.exports = { handler, read, record, summary, day, EVENTS, VALUED, SURFACES, MAX_EVENTS };
