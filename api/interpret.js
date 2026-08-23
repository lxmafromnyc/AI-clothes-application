/* =========================================================
   Fynd — natural-language request interpreter

   Turns "a black shirt for school under $50" into structured preferences
   the catalogue can be matched against.

   This runs on the server so OPENAI_API_KEY is never sent to a browser.
   Deploy it anywhere that runs Node serverless functions; the handler
   below uses the Vercel/Next signature, which Netlify also accepts via
   its Next.js runtime. See README.md for the Cloudflare Pages variant.

   Environment
     OPENAI_API_KEY   required. Without it the endpoint replies 503 and
                      the frontend falls back to its local interpreter.
     OPENAI_MODEL     optional, defaults below. Set it to whichever model
                      your account has access to.
     ALLOWED_ORIGIN   origins allowed to call this from a browser, beyond
                      the deployment's own, which is always allowed.
                      Comma-separated. Anything else is refused with 403,
                      because this endpoint spends your OpenAI credit.
                      See api/_cors.js.

   ---------------------------------------------------------
   Token metering
   ---------------------------------------------------------
   This endpoint spends AI tokens, so it is metered against the caller's
   account before it is allowed to call OpenAI at all. See api/_usage.js
   for why the allowance is taken first and corrected afterwards.

   The exact cost is not knowable until OpenAI answers, so a ceiling is
   reserved up front and settled to the real figure from the response's
   own usage block. Reserving the ceiling is the point: an account with
   200 tokens left must not be able to start a call that will spend
   2,000.

   Two caps keep a single call from being large in the first place — a
   hard max_completion_tokens, and a limit on how much catalogue
   vocabulary may be sent. Without them the prompt grows with the
   catalogue and the bill grows with it.
   ========================================================= */

const { handledPreflight } = require('./_cors');
const { envReport } = require('./_env-report');
const { requireAccount } = require('./_accounts');
const usage = require('./_usage');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_QUERY = 400;

/* ---------------------------------------------------------
   Per-call safety caps
   ---------------------------------------------------------
   The answer is a small JSON object, so a large completion means
   something has gone wrong — and an uncapped one is billed all the same.
   The vocabulary cap bounds the other half: the prompt would otherwise
   grow with the catalogue, so every request would get more expensive as
   the product source got bigger, without anyone changing anything. */
const MAX_COMPLETION_TOKENS = 400;
const MAX_VOCABULARY_CHARS = 4000;

/* Reserved before the call and settled to the true figure after it.
   Comfortably above a full-size request: system prompt, a capped
   vocabulary, a 400-character query and the completion cap. */
const TOKEN_RESERVATION = 2600;

/* The model is told to answer with this shape and nothing else. Values are
   constrained to the vocabulary the catalogue actually uses, which is sent
   with the request, so the interpretation can be matched directly. */
const SYSTEM_PROMPT = `You interpret shopping requests for a clothing finder.

Read the shopper's request and return ONLY a JSON object with these keys:
  categories  array of garment kinds, e.g. ["shirt"]
  colors      array of colour families
  occasions   array of occasions
  fits        array of fits
  brands      array of brand names
  styles      array of style descriptors
  maxPrice    number or null, the most they want to spend per item
  minPrice    number or null
  season      string or null, e.g. "fall"
  gender      string or null, e.g. "women"
  keywords    array of any other meaningful words from the request

Rules:
- Where a vocabulary list is supplied for a field, choose only from that
  list, picking the closest match. "loose" maps to a relaxed or oversized
  fit; "school" maps to an everyday occasion; "grey" maps to the nearest
  colour family present.
- Leave an array empty and a value null when the request does not say.
  Never guess a budget that was not stated.
- "under $50" means maxPrice 50. "$50-$80" means minPrice 50, maxPrice 80.
- Return the JSON object only, with no explanation.`;

/* the model is asked for arrays, but tolerate a bare string too */
function asArray(v) {
  if (typeof v === 'string') v = v.split(/\s*,\s*/);
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

function asNumber(v) {
  const n = typeof v === 'string' ? Number(v.replace(/[^0-9.]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

const asText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/* never trust the model's output shape */
function shapePreferences(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    categories: asArray(p.categories),
    colors: asArray(p.colors),
    occasions: asArray(p.occasions),
    fits: asArray(p.fits),
    brands: asArray(p.brands),
    styles: asArray(p.styles),
    maxPrice: asNumber(p.maxPrice),
    minPrice: asNumber(p.minPrice),
    season: asText(p.season),
    gender: asText(p.gender),
    keywords: asArray(p.keywords)
  };
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  /* answers the preflight, and refuses an origin that is not allowed */
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  /* who is spending. A missing credential is an anonymous Free caller; a
     credential that does not verify is refused outright. */
  const account = requireAccount(req, res);
  if (!account) return;

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    /* the frontend treats this as "interpret it locally instead".
       States only — never values. See api/_env-report.js. */
    console.warn('Interpreter not configured. env:', envReport());
    return res.status(503).json({ error: 'Interpreter is not configured.' });
  }

  const body = await readBody(req);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY) : '';
  if (!query) return res.status(400).json({ error: 'Say what you are looking for.' });

  /* the catalogue tells the model which values it can actually match,
     truncated so the prompt cannot grow without bound as the catalogue
     does. A cut list still constrains the model; an uncapped one is a
     bill that rises on its own. */
  const vocabulary = body.vocabulary && typeof body.vocabulary === 'object' ? body.vocabulary : {};
  const vocabularyText = JSON.stringify(vocabulary).slice(0, MAX_VOCABULARY_CHARS);

  /* Reserve the ceiling BEFORE calling OpenAI. An account near its limit
     must not be able to start a call it cannot afford, and the true cost
     is not known until the answer comes back. */
  const taken = await usage.reserve(account, 'tokens', TOKEN_RESERVATION);
  if (!taken.ok) {
    return res.status(429).json(Object.assign({ source: 'usage-limit' }, taken.limit));
  }

  /* From here every exit must either settle the reservation to what was
     really spent or hand all of it back. Nothing may return without one. */
  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        temperature: 0,
        /* the hard ceiling on one call. The answer is a small object, so
           anything approaching this has already gone wrong — and would
           be billed regardless. */
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Vocabulary available in the catalogue:\n${vocabularyText}\n\nShopper's request:\n${query}`
          }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('OpenAI request failed', response.status, detail.slice(0, 500));
      /* refused upstream, so nothing was generated and nothing is owed */
      await usage.refund(taken.reservation);
      /* never surface the upstream body: it can echo request details */
      return res.status(502).json({ error: 'The interpreter is unavailable right now.' });
    }

    const payload = await response.json();

    /* OpenAI's own count of what this call cost. Taken from the response
       rather than estimated: an estimate that drifts low is a bill that
       drifts high, and there is no reason to guess when the true figure
       is right here. A response without it is charged the full
       reservation instead of nothing. */
    const spent = payload.usage && Number.isFinite(Number(payload.usage.total_tokens))
      ? Number(payload.usage.total_tokens)
      : TOKEN_RESERVATION;
    await usage.settle(taken.reservation, spent);

    const content = payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : '';

    /* the model ran and was billed either way, so this is reported with
       the tokens already settled, not refunded */
    const meters = await usage.snapshot(account);

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error('Model returned unparseable JSON');
      return res.status(502).json({ error: 'The interpreter returned an unexpected answer.', usage: meters });
    }

    return res.status(200).json({
      source: 'openai',
      query,
      preferences: shapePreferences(parsed),
      /* the browser renders its meter from this and never computes it
         itself, so the number on screen is the number enforced against */
      usage: meters
    });
  } catch (err) {
    console.error('Interpreter error', err && err.message);
    /* the call never completed: the whole reservation goes back */
    await usage.refund(taken.reservation);
    return res.status(502).json({ error: 'The interpreter is unavailable right now.' });
  }
};

module.exports.shapePreferences = shapePreferences;
