/* =========================================================
   FindWear — natural-language request interpreter

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
   ========================================================= */

const { handledPreflight } = require('./_cors');
const { envReport } = require('./_env-report');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_QUERY = 400;

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
- categories must be the garment the shopper actually named — "hoodie",
  "jeans", "sneakers", "button-up shirt". Never substitute a different
  garment for it. A vocabulary list, if one is supplied, describes one
  local catalogue; the search runs against real shops, and a shopper who
  asked for a hoodie must not be sent to look for a knit.
- Where a vocabulary list is supplied for colors, occasions or fits,
  choose the closest value from it. "loose" maps to a relaxed or
  oversized fit; "school" maps to an everyday occasion; "grey" maps to
  the nearest colour family present.
- keywords is for meaningful words the other fields did not capture —
  a fabric, a cut, a detail. Leave out words about price ("under",
  "$80", "cheap"), and leave out anything already in another field.
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
    let done = false;
    /* every path answers exactly once. Destroying the stream on an
       oversized body does not emit 'end', so a promise waiting only for
       that would never settle and the function would sit there until the
       platform killed it. */
    const settle = (value) => { if (!done) { done = true; resolve(value); } };
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10000) { req.destroy(); settle({}); }
    });
    req.on('end', () => { try { settle(JSON.parse(data)); } catch (e) { settle({}); } });
    req.on('error', () => settle({}));
    req.on('close', () => settle({}));
  });
}

module.exports = async function handler(req, res) {
  /* answers the preflight, and refuses an origin that is not allowed */
  if (handledPreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

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

  /* the catalogue tells the model which values it can actually match */
  const vocabulary = body.vocabulary && typeof body.vocabulary === 'object' ? body.vocabulary : {};

  const started = Date.now();
  /* One line per interpretation, so a deployment can be read from its
     logs. Counts and outcomes only: never the key, never the shopper's
     words, never the model's answer. */
  const record = (outcome, extra) => console.log('interpret', JSON.stringify(Object.assign({
    outcome,
    queryChars: query.length,
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    elapsedMs: Date.now() - started
  }, extra || {})));

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
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Vocabulary available in the catalogue:\n${JSON.stringify(vocabulary)}\n\nShopper's request:\n${query}`
          }
        ]
      })
    });

    if (!response.ok) {
      /* The body is read so the socket is not left open, and discarded:
         it can echo request details, and it is never logged or returned.
         The status alone says what happened, and 429 says it precisely —
         a quota that has run out looks exactly like this. */
      await response.text().catch(() => '');
      record('upstream-error', { status: response.status });
      return res.status(502).json({
        error: response.status === 429
          ? 'The interpreter has reached its rate limit. Fynd read your request itself instead.'
          : 'The interpreter is unavailable right now.',
        reason: response.status === 429 ? 'rate-limited' : 'upstream'
      });
    }

    const payload = await response.json();
    const content = payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      record('unparseable-answer');
      return res.status(502).json({ error: 'The interpreter returned an unexpected answer.', reason: 'unparseable' });
    }

    const preferences = shapePreferences(parsed);
    /* how much was actually understood, as counts — enough to see an
       interpreter quietly returning nothing useful */
    record('ok', {
      fields: {
        categories: preferences.categories.length,
        colors: preferences.colors.length,
        fits: preferences.fits.length,
        occasions: preferences.occasions.length,
        keywords: preferences.keywords.length,
        hasBudget: Boolean(preferences.maxPrice || preferences.minPrice)
      }
    });
    return res.status(200).json({ source: 'openai', query, preferences });
  } catch (err) {
    /* a timeout, a DNS failure, a socket reset: the kind matters, the
       message may carry a URL and does not travel */
    record('unreachable', { kind: err && err.name === 'AbortError' ? 'timeout' : 'failed' });
    return res.status(502).json({ error: 'The interpreter is unavailable right now.', reason: 'unreachable' });
  }
};

module.exports.shapePreferences = shapePreferences;
