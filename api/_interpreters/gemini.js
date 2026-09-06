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
   gemini-2.5-flash is a thinking model, and thinking tokens are billed
   and waited for. This is a short extraction with a fixed output shape,
   so thinking is off by default: it is the setting that makes the
   comparison against gpt-4o-mini a comparison of like work. Set
   GEMINI_THINKING_BUDGET to a token budget to turn it on, or to -1 to
   let the model decide.

   ---------------------------------------------------------
   Environment
   ---------------------------------------------------------
     GEMINI_API_KEY          required for this adapter. Read only inside
                             the serverless function; never returned in a
                             response and never logged.
     GEMINI_MODEL            optional, defaults to gemini-2.5-flash.
     GEMINI_THINKING_BUDGET  optional, defaults to 0 (thinking off).
                             -1 lets the model choose its own budget.

   ---------------------------------------------------------
   Removing it
   ---------------------------------------------------------
   Delete api/_interpreters/ and the block it is used from in
   api/interpret.js, both marked. Nothing else refers to it: no page, no
   endpoint, and no production default.
   ========================================================= */

'use strict';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const REQUEST_TIMEOUT = 15000;

/* Thinking off. See the header: this is an extraction, not a puzzle. */
const DEFAULT_THINKING_BUDGET = 0;

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

const apiKey = () => text(process.env.GEMINI_API_KEY);
const model = () => text(process.env.GEMINI_MODEL) || DEFAULT_MODEL;

function thinkingBudget() {
  const raw = text(process.env.GEMINI_THINKING_BUDGET);
  if (!raw) return DEFAULT_THINKING_BUDGET;
  const n = Number(raw);
  /* -1 is "decide for yourself"; anything below that is not a budget */
  return Number.isFinite(n) && n >= -1 ? Math.trunc(n) : DEFAULT_THINKING_BUDGET;
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
   the cases where something has to be. */
function buildRequest({ query, vocabulary, systemPrompt }) {
  const budget = thinkingBudget();

  const generationConfig = {
    temperature: 0,
    /* Gemini's counterpart to OpenAI's json_object mode */
    responseMimeType: 'application/json',
    /* 0 turns thinking off, -1 asks the model to choose its own budget.
       Sending the field is what makes either happen. */
    thinkingConfig: { thinkingBudget: budget }
  };

  return {
    url: `${API_ROOT}/${encodeURIComponent(model())}:generateContent`,
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
async function interpret({ query, vocabulary, systemPrompt }) {
  if (!configured()) return { ok: false, reason: 'not-configured' };

  const { url, options } = buildRequest({ query, vocabulary, systemPrompt });

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
    /* the upstream body is read only to log it, redacted and truncated,
       and it is never surfaced to the caller: it can echo the request */
    let detail = '';
    try { detail = await response.text(); } catch (err) { detail = ''; }
    return { ok: false, reason: 'upstream', status: response.status, detail: redact(detail).slice(0, 500) };
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

module.exports = {
  name: 'gemini',
  configured,
  interpret,
  /* exported for the tests and the benchmark, not used elsewhere */
  buildRequest,
  parseReply,
  replyText,
  usageFrom,
  userPrompt,
  redact,
  model,
  thinkingBudget,
  DEFAULT_MODEL,
  API_ROOT,
  REQUEST_TIMEOUT
};
