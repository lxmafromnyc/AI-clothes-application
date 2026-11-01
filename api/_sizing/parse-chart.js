/* =========================================================
   Fynd — AI-assisted reading of one size chart (a proposal, checked)

     POST /api/size-recommendation?parse=1
     Content-Type: application/json

   Served by api/size-recommendation.js, not a function of its own: the
   deployment's plan allows twelve routed functions, and
   scripts/test-pipeline.js holds it to that.
     { "table": { "grid": [[cell, …], …], "caption": "…", "before": "…" },
       "type": "hoodies" | "sweatshirts" | "tshirts" | null }

   The extension calls this only when its own deterministic reading
   can't interpret a chart that is plainly a size chart. Gemini proposes
   how to read the table; api/_sizing/chart-ai.js checks every part of
   the proposal against the page with Fynd's own readers and recovers
   every value from the original cells. The answer is a proposal for the
   shopper to confirm — never verified, never a fit decision. The
   comparison later reads the confirmed chart exactly as any other
   (assets/fit-candidate.js readChart → engine → decision).

   Who may call it, and how much
     - signed in: the shopper's own Fynd session (401 sign-in-required)
     - JSON only: a cross-site form can't post here (415), and a
       cross-site JSON post is preflighted and refused by api/_cors.js
     - the body at most MAX_REQUEST_CHARS (413 too-large)
     - 20 per 10 minutes per shopper and per address
       (429 rate-limited, Retry-After)
     - at most PARSE_CHART_DAILY_MODEL_CALLS model calls a day across every
       shopper (default 1,000; 503 ai-capacity past it)
     - one model call per request: no retries, at most MAX_OUTPUT_TOKENS out
       and MAX_REQUEST_CHARS in
     - each model call counts against the plan's existing AI allowance
       (api/_meter.js, the same "aiTokens" /api/interpret uses; 429
       over-limit when it's spent). A cached answer spends nothing.
       Plans, prices and Stripe are untouched.

   The model
     Google Gemini through the existing adapter
     (api/_interpreters/gemini.js generateJson): GEMINI_API_KEY stays on
     the server, in a header, redacted from anything logged. GEMINI_MODEL
     chooses the model (the adapter's default otherwise). One call,
     MODEL_TIMEOUT_MS at most, MAX_OUTPUT_TOKENS at most.

   Answers
     200 { status: 'proposed' | 'insufficient-evidence' | 'body-chart', … }
         see chart-ai.js validate(); `cached` says whether the model was
         asked this time
     400 invalid-table      the table didn't read
     422 unsupported-chart  no column of size labels: not a size chart
     503 ai-unavailable     no model configured
     503 ai-rate-limited    the provider is limiting us (Retry-After)
     504 ai-timeout         no answer in time
     502 ai-failed          the provider failed
     502 ai-invalid-response  the answer broke the schema
   On every failure the extension keeps its own reading: nothing here is
   needed for the ordinary deterministic path.

   Cache
     A schema-valid proposal is kept for CACHE_TTL_SECONDS under a hash of
     the table, the garment type, the prompt version, the answer schema's
     version and the model — never the shopper —
     and is checked again on every use, so a changed validator applies at
     once. FYND_CACHE=off turns it off with the rest of Fynd's caches.
   ========================================================= */

'use strict';

const { handledPreflight } = require('../_cors');
const { readJson } = require('../_body');
const auth = require('../_auth');
const meter = require('../_meter');
const { AI_TOKENS } = require('../_plans');
const limits = require('../_ratelimit');
const store = require('../_store');
const cache = require('../_cache');
const gemini = require('../_interpreters/gemini');
const ChartAI = require('./chart-ai');
const Reading = require('../../assets/chart-reading.js');

const MODEL_TIMEOUT_MS = 12000;
const MAX_OUTPUT_TOKENS = 2048;
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const LIMIT = 'sizing:parse-chart';
/* read at call time, so a test can shorten the wait without a real 12 s timeout */
const settings = {
  modelTimeoutMs: MODEL_TIMEOUT_MS,
  /* every shopper together: a ceiling on model calls a day, whatever each one's allowance */
  dailyModelCalls: Number(process.env.PARSE_CHART_DAILY_MODEL_CALLS) > 0 ? Math.floor(Number(process.env.PARSE_CHART_DAILY_MODEL_CALLS)) : 1000
};
const dayKey = () => `chart-ai:model-calls:${new Date().toISOString().slice(0, 10)}`;

async function handler(req, res) {
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  res.setHeader('Cache-Control', 'no-store, private');

  if (!/^application\/json\b/i.test(String((req.headers && req.headers['content-type']) || ''))) {
    return res.status(415).json({ error: 'Send JSON.', reason: 'unsupported-media-type' });
  }
  const declared = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(declared) && declared > ChartAI.MAX_REQUEST_CHARS) {
    return res.status(413).json({ error: 'This table is too large to interpret.', reason: 'too-large' });
  }

  /* who, and is there AI allowance left (the plan's existing meter) */
  const { identity, state, blocked } = await meter.guard(req, res, AI_TOKENS);
  if (!identity || !identity.user) return res.status(401).json({ error: 'Sign in to Fynd to use its AI chart reading.', reason: 'sign-in-required' });
  if (blocked) return meter.overLimit(res, state);

  const subjects = [`user:${identity.user.id}`, auth.addressSubject(req)];
  const gate = await limits.checkAll(LIMIT, subjects);
  if (!gate.allowed) {
    res.setHeader('Retry-After', String(gate.retryAfter || 60));
    return res.status(429).json({ error: 'Too many chart readings at once. Try again in a few minutes.', reason: 'rate-limited' });
  }

  const body = await readJson(req);
  let size = 0;
  try { size = JSON.stringify(body || {}).length; } catch (err) { size = Infinity; }
  if (size > ChartAI.MAX_REQUEST_CHARS) return res.status(413).json({ error: 'This table is too large to interpret.', reason: 'too-large' });
  const read = ChartAI.readTableInput(body);
  if (read.errors.length) return res.status(400).json({ error: read.errors[0].message, reason: 'invalid-table', errors: read.errors });
  const table = read.table;
  if (!Reading.gridShape(table.grid)) return res.status(422).json({ error: 'Fynd can’t find a column of sizes in this table.', reason: 'unsupported-chart' });
  await limits.noteAll(LIMIT, subjects);

  /* a body chart, by the page's own words, is never sent to a model: it can't become the garment's */
  const own = ChartAI.context(table, Reading.gridShape(table.grid).headerRows);
  if (own.kind === 'body') {
    return res.status(200).json({ status: 'body-chart', source: 'deterministic', verified: false, measures: 'body', columns: [], rows: [], unresolved: [], rejected: [], ambiguities: [], cached: false, model: null });
  }

  const key = ChartAI.cacheKey(table, gemini.model());
  let proposal = null;
  let cached = false;
  if (cache.enabled()) {
    try {
      const hit = await store.get(key);
      if (hit && hit.proposal && Number(hit.expiresAt) > Date.now()) { proposal = hit.proposal; cached = true; }
    } catch (err) { console.warn('Chart cache read failed; asking the model.', err && err.message); }
  }

  let tokens = 0;
  if (!proposal) {
    if (!gemini.configured()) return res.status(503).json({ error: 'AI chart reading isn’t available right now.', reason: 'ai-unavailable' });
    /* the day's ceiling for every shopper together (a cached answer doesn't count) */
    try {
      if (await store.readNumber(dayKey()) >= settings.dailyModelCalls) return res.status(503).json({ error: 'AI chart reading has reached today’s limit. Try again tomorrow.', reason: 'ai-capacity' });
      await store.add(dayKey(), 1, { ttlSeconds: 2 * 24 * 60 * 60 });
    } catch (err) { console.error('Could not check the daily AI ceiling; asking anyway.', err && err.message); }
    const got = await gemini.generateJson({ systemPrompt: ChartAI.SYSTEM_PROMPT, userText: ChartAI.userText(table), timeoutMs: settings.modelTimeoutMs, maxOutputTokens: MAX_OUTPUT_TOKENS });
    tokens = Number(got.tokens) || 0;
    if (tokens) await meter.spend(identity, AI_TOKENS, tokens);
    if (!got.ok) {
      console.warn('Chart reading failed', got.reason, got.status || '', gemini.redact(got.detail || ''));
      if (got.reason === 'timeout') return res.status(504).json({ error: 'The AI chart reading took too long.', reason: 'ai-timeout' });
      if (got.reason === 'rate-limited') {
        res.setHeader('Retry-After', String(got.retryAfter || 60));
        return res.status(503).json({ error: 'The AI chart reading is busy. Try again shortly.', reason: 'ai-rate-limited' });
      }
      if (got.reason === 'not-configured') return res.status(503).json({ error: 'AI chart reading isn’t available right now.', reason: 'ai-unavailable' });
      if (got.reason === 'unparseable') return res.status(502).json({ error: 'The AI’s answer couldn’t be read.', reason: 'ai-invalid-response' });
      return res.status(502).json({ error: 'The AI chart reading failed.', reason: 'ai-failed' });
    }
    proposal = got.raw;
  }

  const checked = ChartAI.validate(proposal, table);
  if (!checked.ok) {
    console.warn('Chart reading refused: the answer broke the schema', checked.errors.join('; '));
    return res.status(502).json({ error: 'The AI’s answer didn’t follow the rules, so Fynd ignored it.', reason: 'ai-invalid-response' });
  }
  if (!cached && cache.enabled()) {
    try { await store.set(key, { proposal, storedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 }, { ttlSeconds: CACHE_TTL_SECONDS }); }
    catch (err) { console.warn('Chart cache write failed.', err && err.message); }
  }
  return res.status(200).json(Object.assign(checked.result, { cached, model: cached ? null : gemini.model(), usage: meter.report(state) }));
}

module.exports = handler;
module.exports.MODEL_TIMEOUT_MS = MODEL_TIMEOUT_MS;
module.exports.CACHE_TTL_SECONDS = CACHE_TTL_SECONDS;
module.exports.settings = settings;
