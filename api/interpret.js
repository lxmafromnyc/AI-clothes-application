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

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    /* the frontend treats this as "interpret it locally instead" */
    return res.status(503).json({ error: 'Interpreter is not configured.' });
  }

  const body = await readBody(req);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY) : '';
  if (!query) return res.status(400).json({ error: 'Say what you are looking for.' });

  /* the catalogue tells the model which values it can actually match */
  const vocabulary = body.vocabulary && typeof body.vocabulary === 'object' ? body.vocabulary : {};

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
      const detail = await response.text();
      console.error('OpenAI request failed', response.status, detail.slice(0, 500));
      /* never surface the upstream body: it can echo request details */
      return res.status(502).json({ error: 'The interpreter is unavailable right now.' });
    }

    const payload = await response.json();
    const content = payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : '';

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      console.error('Model returned unparseable JSON');
      return res.status(502).json({ error: 'The interpreter returned an unexpected answer.' });
    }

    return res.status(200).json({ source: 'openai', query, preferences: shapePreferences(parsed) });
  } catch (err) {
    console.error('Interpreter error', err && err.message);
    return res.status(502).json({ error: 'The interpreter is unavailable right now.' });
  }
};

module.exports.shapePreferences = shapePreferences;
