/* =========================================================
   Fynd — Gemini request interpreter (evaluation only)

   Reads a shopper's request with Google's Gemini API and hands back the
   SAME raw object the OpenAI path hands back, so api/interpret.js can
   run it through its own shapePreferences() and answer with the intent
   the frontend and /api/search already understand. There is no second
   schema here, and nothing downstream can tell which model was asked.

   It is registered but NOT the default: nothing selects it unless
   AI_PROVIDER=gemini names it, exactly as with the SerpApi product
   adapter. A deployment that never sets AI_PROVIDER calls OpenAI, on the
   code path it has always called it on.

   It exists to be measured against OpenAI on the four questions that
   decide whether a model can do this job: how often it returns usable
   structured output, how often the fields are right, what a search costs
   and how long a shopper waits. scripts/bench-interpreters.js asks all
   four; scripts/test-gemini.js holds this file to the contract offline.

   ---------------------------------------------------------
   The endpoint
   ---------------------------------------------------------
     POST https://generativelanguage.googleapis.com/v1beta/models/
          <model>:generateContent
     x-goog-api-key: <GEMINI_API_KEY>

   The key travels as a HEADER and never as a query parameter, so it
   cannot end up in a URL that something logs. Nothing in this file
   prints a request, and everything that could be printed — an upstream
   error, a failure message — goes through redact() first, which
   replaces the key with "***" whatever else it is carrying.

   ---------------------------------------------------------
   Which model, and why the request has two shapes
   ---------------------------------------------------------
   The default is gemini-3.6-flash. gemini-2.5-flash, which this adapter
   was first written against, answers a request for it with a 404: it is
   not available to accounts that had not already used it.

   The Gemini 3 family changed two things this adapter sends, so the
   request is built to match the model it is being sent to:

     temperature    ignored by Gemini 3 models. Google's guidance is to
                    leave it out and let the model use its own default,
                    so for a 3.x model it is not sent at all. A 2.5
                    model still gets temperature 0, which is what made
                    its output repeatable.

     thinking       thinkingBudget is the 2.5 field and is deprecated in
                    the 3 family, which takes thinkingLevel instead —
                    an enum, minimal through high. Sending BOTH in one
                    request is a 400, so exactly one is ever sent, chosen
                    by the model the request is going to.

   Everything else — the endpoint, the header the key rides in, the JSON
   mode, the response shape and the token accounting — is unchanged.

   ---------------------------------------------------------
   Why not the Interactions API
   ---------------------------------------------------------
   Google now recommends the Interactions API for new work and calls
   generateContent legacy, but recommends is all it does: generateContent
   remains fully supported, and gemini-3.6-flash is served on both. This
   adapter stays on generateContent because it is one stateless call in
   and one answer out, which is exactly what the OpenAI path does — so
   the benchmark compares two like things rather than a stateless call
   against a managed conversation. Moving to Interactions is a separate
   decision, and nothing here forecloses it.

   ---------------------------------------------------------
   Asking for JSON
   ---------------------------------------------------------
   responseMimeType: "application/json" is Gemini's counterpart to the
   OpenAI path's response_format: { type: 'json_object' }, and it is used
   the same way: the model is told the shape in the prompt and asked to
   answer in JSON. No responseSchema is sent. That is deliberate — a
   schema would constrain Gemini in a way OpenAI is not constrained
   here, and the benchmark's malformed-output rate would then be
   measuring the schema rather than the model. The reply is parsed with
   a plain JSON.parse, as the OpenAI reply is, and anything that does not
   parse counts as malformed rather than being repaired.

   ---------------------------------------------------------
   Thinking
   ---------------------------------------------------------
   These are thinking models, and thinking tokens are billed and waited
   for. This is a short extraction with a fixed output shape, so it is
   turned down as far as the model allows: it is the setting that makes
   the comparison against gpt-4o-mini a comparison of like work.

     3.x   thinkingLevel "minimal", overridable with
           GEMINI_THINKING_LEVEL (minimal, low, medium, high)
     2.5   thinkingBudget 0, overridable with GEMINI_THINKING_BUDGET
           (a token budget, or -1 to let the model decide)

   ---------------------------------------------------------
   Environment
   ---------------------------------------------------------
     GEMINI_API_KEY          required for this adapter. Read only inside
                             the serverless function; never returned in a
                             response and never logged.
     GEMINI_MODEL            optional, defaults to gemini-3.6-flash.
     GEMINI_THINKING_LEVEL   optional, 3.x models only. minimal, low,
                             medium or high; defaults to minimal.
     GEMINI_THINKING_BUDGET  optional, 2.5 models only. A token budget;
                             defaults to 0, and -1 lets the model choose.

   ---------------------------------------------------------
   Removing it
   ---------------------------------------------------------
   Delete api/_interpreters/ and the block it is used from in
   api/interpret.js, both marked. Nothing else refers to it: no page, no
   endpoint, and no production default.
   ========================================================= */

'use strict';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.6-flash';
const REQUEST_TIMEOUT = 15000;

/* Turned down as far as each family allows. See the header: this is an
   extraction, not a puzzle. */
const DEFAULT_THINKING_BUDGET = 0;
const DEFAULT_THINKING_LEVEL = 'minimal';
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

const apiKey = () => text(process.env.GEMINI_API_KEY);
const model = () => text(process.env.GEMINI_MODEL) || DEFAULT_MODEL;

/* Which set of rules the request follows. The 3 family ignores
   temperature and takes thinkingLevel; 2.5 takes temperature and
   thinkingBudget. Read off the model name because that is the only
   thing that decides it. */
const isGemini3 = (name) => /^gemini-3/i.test(text(name) || model());

function thinkingBudget() {
  const raw = text(process.env.GEMINI_THINKING_BUDGET);
  if (!raw) return DEFAULT_THINKING_BUDGET;
  const n = Number(raw);
  /* -1 is "decide for yourself"; anything below that is not a budget */
  return Number.isFinite(n) && n >= -1 ? Math.trunc(n) : DEFAULT_THINKING_BUDGET;
}

/* An unrecognised level falls back to the default rather than being
   forwarded: the field is an enum, and a typo would be a 400. */
function thinkingLevel() {
  const raw = text(process.env.GEMINI_THINKING_LEVEL).toLowerCase();
  return THINKING_LEVELS.includes(raw) ? raw : DEFAULT_THINKING_LEVEL;
}

/* Anything that might be printed — a log line, an error message, a
   benchmark's output — goes through this first. The key is sent as a
   header rather than in a URL, so this is a second line rather than the
   only one, and it is here because an upstream error body can echo back
   what was sent to it. */
function redact(value) {
  const key = apiKey();
  const raw = String(value === undefined || value === null ? '' : value);
  return key ? raw.split(key).join('***') : raw;
}

const configured = () => Boolean(apiKey());

/* Response headers a failure is allowed to carry back, for one question
   only: did this answer come from Google, or from something sitting in
   front of it? None of them can hold our key — they are the responder's
   own — and every value is redacted anyway, on principle. */
const REPORTED_HEADERS = ['content-type', 'server', 'via', 'www-authenticate', 'x-request-id', 'x-guploader-uploadid'];

/* The provider's own error envelope, read from the WHOLE body.

   This runs before the body is truncated for logging, and that order is
   the point: Google's error JSON carries a `details` array that pushes
   it well past any sensible log line, so truncating first leaves a
   fragment that cannot be parsed and a failure that cannot be named.
   Discovered by running the diagnostic against the live endpoint with a
   knowingly invalid key: the message was there and the tooling could
   not see it. */
function errorEnvelope(body) {
  if (typeof body !== 'string' || !body.trim().startsWith('{')) return null;
  let parsed;
  try { parsed = JSON.parse(body); } catch (err) { return null; }
  const error = parsed && parsed.error;
  if (!error || typeof error !== 'object' || typeof error.message !== 'string') return null;
  return {
    message: redact(error.message).slice(0, 300),
    code: error.code === undefined ? null : error.code,
    type: error.status || error.type || null
  };
}

function headersFrom(response) {
  const out = {};
  if (!response || !response.headers || typeof response.headers.get !== 'function') return out;
  REPORTED_HEADERS.forEach((name) => {
    const value = response.headers.get(name);
    if (value) out[name] = redact(value).slice(0, 200);
  });
  return out;
}

/* -----------------------------------------------------------
   The prompt
   -----------------------------------------------------------
   The system prompt is passed in by api/interpret.js, so both providers
   are given the same instructions from the same source of truth rather
   than from a copy that can drift.

   The user message is composed here in the shape the OpenAI path
   composes it — the catalogue's vocabulary, then the request. The test
   "both providers are sent the same prompt" in scripts/test-gemini.js
   captures what /api/interpret actually sends to OpenAI and asserts it
   is this exact string, so the two cannot drift apart unnoticed. */
const userPrompt = (query, vocabulary) =>
  `Vocabulary available in the catalogue:\n${JSON.stringify(vocabulary || {})}\n\nShopper's request:\n${query}`;

/* Returns { url, options } ready for fetch. `options.headers` carries
   the key, so this object must never be logged — redact() exists for
   the cases where something has to be.

   `thinking` defaults to the configured budget, which is what every
   caller uses. Passing null OMITS thinkingConfig from the request
   entirely: a model or API version that does not accept the field
   rejects the whole call with a 400, and the only way to tell that
   apart from a 400 about something else is to ask again without it.
   scripts/bench-interpreters.js --diagnose does exactly that, once. */
function buildRequest({ query, vocabulary, systemPrompt, thinking }) {
  const name = model();
  const three = isGemini3(name);

  const generationConfig = {
    /* Gemini's counterpart to OpenAI's json_object mode */
    responseMimeType: 'application/json'
  };

  /* Gemini 3 ignores temperature and Google's guidance is not to send
     it; 2.5 honours it, and 0 is what made its output repeatable. */
  if (!three) generationConfig.temperature = 0;

  /* Exactly one thinking field, chosen by the family. Sending both is a
     400 — the deprecated budget and the new level cannot travel
     together — so this is an if/else rather than two ifs. `thinking:
     null` omits the field entirely, which is how the diagnostic asks
     again without it. */
  if (thinking !== null) {
    generationConfig.thinkingConfig = three
      ? { thinkingLevel: thinking === undefined ? thinkingLevel() : thinking }
      : { thinkingBudget: thinking === undefined ? thinkingBudget() : thinking };
  }

  return {
    url: `${API_ROOT}/${encodeURIComponent(name)}:generateContent`,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey()
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: String(systemPrompt || '') }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt(query, vocabulary) }] }],
        generationConfig
      })
    }
  };
}

/* -----------------------------------------------------------
   Reading the reply
   ----------------------------------------------------------- */

/* A candidate's answer, joined across parts. A model that returns no
   candidate — blocked, filtered, or cut off — yields '' rather than
   something invented, and '' does not parse, so it is counted as
   malformed instead of being answered with an empty intent.

   A part marked `thought` is the model reasoning aloud, not its answer.
   Thinking is off by default and thought summaries are not asked for,
   so one should never arrive; if one does, it is left out rather than
   concatenated into the JSON, which would corrupt a good reply. */
function replyText(payload) {
  const candidate = payload && Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts : [];
  return parts
    .filter((part) => part && part.thought !== true)
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/* What the call actually cost, from Google's own accounting of it. A
   reply that reports no usage is counted as nothing rather than as a
   guess — the same rule api/interpret.js applies to OpenAI's usage. */
function usageFrom(payload) {
  const u = (payload && payload.usageMetadata) || {};
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input: n(u.promptTokenCount),
    output: n(u.candidatesTokenCount),
    thoughts: n(u.thoughtsTokenCount),
    total: n(u.totalTokenCount)
  };
}

/* { ok: true, raw, usage } or { ok: false, reason: 'unparseable' }.

   The parse is a plain JSON.parse, exactly as on the OpenAI path: a
   fenced block or a sentence of preamble is malformed output, and is
   reported as malformed rather than salvaged. Repairing it here would
   make the benchmark flatter this provider. */
function parseReply(payload) {
  const content = replyText(payload);
  let raw;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    return { ok: false, reason: 'unparseable', usage: usageFrom(payload) };
  }
  /* an array or a bare string parses but is not an intent */
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'unparseable', usage: usageFrom(payload) };
  }
  return { ok: true, raw, usage: usageFrom(payload) };
}

/* -----------------------------------------------------------
   The call
   -----------------------------------------------------------
   Never throws and never returns a partial reading. Every failure is
   named so the caller can answer with the right status and the log can
   say which of them happened:

     not-configured  no key in the environment
     upstream        Gemini answered, but not with a 200
     unreachable     nothing answered, or it timed out
     unparseable     it answered, and the answer was not JSON
   ----------------------------------------------------------- */
async function interpret({ query, vocabulary, systemPrompt, thinking }) {
  if (!configured()) return { ok: false, reason: 'not-configured' };

  const { url, options } = buildRequest({ query, vocabulary, systemPrompt, thinking });

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    response = await fetch(url, Object.assign({ signal: controller.signal }, options));
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: redact(err && err.message) };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    /* The upstream body is read only to log it, redacted and truncated,
       and it is never surfaced to the shopper: it can echo the request.
       It IS carried back to the caller, because a 403 with Google's own
       error envelope and a 403 from a proxy in the way are the same
       status and completely different problems, and a failure nobody
       can name is a failure nobody can fix. */
    let detail = '';
    try { detail = await response.text(); } catch (err) { detail = ''; }
    return {
      ok: false,
      reason: 'upstream',
      status: response.status,
      /* parsed from the whole body, then the body truncated — not the
         other way round, or a long error becomes an unnameable one */
      error: errorEnvelope(detail),
      detail: redact(detail).slice(0, 500),
      headers: headersFrom(response)
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { ok: false, reason: 'unparseable' };
  }

  const reading = parseReply(payload);
  if (!reading.ok) return reading;

  return {
    ok: true,
    raw: reading.raw,
    usage: reading.usage,
    /* what api/interpret.js meters the call at, on the same rule as
       OpenAI's total_tokens: reported, never estimated */
    tokens: reading.usage.total,
    model: model()
  };
}

/* -----------------------------------------------------------
   Which models this key can actually use
   -----------------------------------------------------------
   Diagnostics only, and never called by /api/interpret. A 404 on a
   model says "not this one" and nothing about what would work; this
   asks. It spends no tokens, and the answer is specific to the key,
   which is the whole point — model availability differs between
   accounts, and that is exactly how gemini-2.5-flash came to 404 here.
   ----------------------------------------------------------- */
async function listModels() {
  if (!configured()) return { ok: false, reason: 'not-configured' };

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    response = await fetch(API_ROOT, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey() },
      signal: controller.signal
    });
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: redact(err && err.message) };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch (err) { detail = ''; }
    return { ok: false, reason: 'upstream', status: response.status, error: errorEnvelope(detail), detail: redact(detail).slice(0, 300) };
  }

  let payload;
  try { payload = await response.json(); } catch (err) { return { ok: false, reason: 'unparseable' }; }

  const models = (Array.isArray(payload && payload.models) ? payload.models : []).map((m) => ({
    /* "models/gemini-3.6-flash" -> "gemini-3.6-flash" */
    id: text(m && m.name).replace(/^models\//, ''),
    methods: Array.isArray(m && m.supportedGenerationMethods) ? m.supportedGenerationMethods : []
  })).filter((m) => m.id);

  return { ok: true, models };
}

module.exports = {
  name: 'gemini',
  listModels,
  configured,
  interpret,
  /* exported for the tests and the benchmark, not used elsewhere */
  buildRequest,
  parseReply,
  replyText,
  usageFrom,
  userPrompt,
  headersFrom,
  errorEnvelope,
  REPORTED_HEADERS,
  redact,
  model,
  isGemini3,
  thinkingBudget,
  thinkingLevel,
  DEFAULT_MODEL,
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  API_ROOT,
  REQUEST_TIMEOUT
};
