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
     AI_PROVIDER      optional, and unset in production. Names an
                      alternative interpreter to run INSTEAD of OpenAI,
                      for benchmarking one against the other. Unset, or
                      "openai", is the OpenAI path below, unchanged. See
                      api/_interpreters/index.js.
     ALLOWED_ORIGIN   origins allowed to call this from a browser, beyond
                      the deployment's own, which is always allowed.
                      Comma-separated. Anything else is refused with 403,
                      because this endpoint spends your OpenAI credit.
                      See api/_cors.js.

   Metering
     Every interpretation spends OpenAI credit, so every one is counted
     against the caller's plan — 20,000 tokens a day on Free, a million
     a month on Pro, five million on Max. The count is the token usage
     OpenAI reports for the call, not an estimate, and the plan comes
     from the stored user record. A caller with nothing left gets a 429
     and the frontend reads their request locally instead, saying so.
     See api/_meter.js.
   ========================================================= */

const { handledPreflight } = require('./_cors');
/* Alternative interpreters, for benchmarking. Registers nothing that
   runs unless AI_PROVIDER names it, so production is unaffected. The
   whole experiment is this require, the block marked in the handler
   below, and api/_interpreters/. */
const interpreters = require('./_interpreters');
const { envReport } = require('./_env-report');
const meter = require('./_meter');
const { AI_TOKENS } = require('./_plans');
const { reconcile } = require('./_reading');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_QUERY = 400;

/* Models that reject the temperature parameter outright: OpenAI answers
   400 "Unsupported value: 'temperature' does not support 0 with this
   model". Requests to these leave the field out; every other model still
   gets temperature 0, which is what keeps a reading repeatable. Dated
   snapshots ("gpt-6-luna-2026-…") share their base model's limits. */
const NO_TEMPERATURE = ['gpt-6-luna'];
const acceptsTemperature = (model) =>
  !NO_TEMPERATURE.some((base) => model === base || model.startsWith(`${base}-`));

/* The model is told to answer with this shape and nothing else. Values are
   constrained to the vocabulary the catalogue actually uses, which is sent
   with the request, so the interpretation can be matched directly. */
const SYSTEM_PROMPT = `You interpret shopping requests for a clothing finder.
Shoppers write badly: misspelled, vague, chatty, comparing one thing to
another, saying what they do NOT want. Work out what they mean. Never add
a fact they did not give.

Return ONLY a JSON object with these keys:
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
  reading     object, what they mean:
    want          the garment they want, in plain shop words, or null
                  if they never say or clearly imply one
    alternatives  up to 3 plain shop names for what they most likely
                  mean, best first; only when the request is vague,
                  comparative or describes rather than names
    comparedTo    a garment they compare it to, or null
    wornWith      garments named only as what it is worn with, over or
                  under
    avoid         what they do NOT want: garments, fits, colours,
                  features, materials
    fit           fit or silhouette words they asked for
    material      materials they asked for
    style         at most 2 style words in shop terms
    occasion      what it is for, or null

Rules:
- Where a vocabulary list is supplied for a field, choose only from that
  list, picking the closest match. "loose" maps to a relaxed or oversized
  fit; "school" maps to an everyday occasion; "grey" maps to the nearest
  colour family present.
- Leave an array empty and a value null when the request does not say.
  Never add a colour, brand, budget, gender or size that was not stated.
  "cheap" is not a budget.
- "under $50" means maxPrice 50. "$50-$80" means minPrice 50, maxPrice 80.
- What they compare to, wear it with or rule out is never what they want:
  "something cozy to wear with jeans" wants a top, not jeans.
- Anything after "not", "no", "without", "isn't", "aren't" goes in avoid
  and nowhere else: "not skinny" is never a skinny fit.
- Read misspellings and slang as the words meant ("hoddie" is hoodie).
- Keep alternatives few and common. Do not list synonyms of one thing.

Example: "black pants but not skinny" ->
{"categories":["trousers"],"colors":["Black"],"occasions":[],"fits":[],
"brands":[],"styles":[],"maxPrice":null,"minPrice":null,"season":null,
"gender":null,"keywords":["black","pants"],"reading":{"want":"pants",
"alternatives":["straight leg pants","wide leg pants"],"comparedTo":null,
"wornWith":[],"avoid":["skinny"],"fit":[],"material":[],"style":[],
"occasion":null}}

Return the JSON object only, with no explanation.`;

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

  /* Which model reads this request. null — the production answer,
     because AI_PROVIDER is unset — means OpenAI, below. */
  const alternative = interpreters.getInterpreter();

  const key = process.env.OPENAI_API_KEY;
  if (alternative ? !alternative.configured() : !key) {
    /* the frontend treats this as "interpret it locally instead".
       States only — never values. See api/_env-report.js. */
    console.warn('Interpreter not configured. env:', envReport());
    return res.status(503).json({ error: 'Interpreter is not configured.' });
  }

  /* Who is asking, and is there any allowance left. Done before the
     body is read so a caller with nothing left is turned away without
     the request being shaped, and before the model is called so no
     credit is spent on it. */
  const { identity, state, blocked } = await meter.guard(req, res, AI_TOKENS);
  if (blocked) return meter.overLimit(res, state);

  const body = await readBody(req);
  const query = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY) : '';
  if (!query) return res.status(400).json({ error: 'Say what you are looking for.' });

  /* the catalogue tells the model which values it can actually match */
  const vocabulary = body.vocabulary && typeof body.vocabulary === 'object' ? body.vocabulary : {};

  const reading = await interpretQuery({ query, vocabulary });
  if (!reading.ok) {
    return res.status(502).json({
      error: reading.reason === 'unparseable'
        ? 'The interpreter returned an unexpected answer.'
        : 'The interpreter is unavailable right now.'
    });
  }

  /* What it actually cost, from the model's own accounting of the call.
     A model that reports no usage is counted as nothing rather than as
     a guess: an invented number in a meter is worse than a gap. */
  const after = await meter.spend(identity, AI_TOKENS, Number.isFinite(reading.tokens) ? reading.tokens : 0);
  return res.status(200).json({
    source: reading.source,
    query,
    preferences: reading.preferences,
    usage: meter.report(after || state)
  });
};

/* The reading itself, without the request around it: the model call,
   its failures, and the shaped preferences. The handler above meters
   and answers with it; scripts/bench-live.js asks it directly, so a
   benchmark reads requests exactly the way the site does without
   spending anyone's plan.

   The garment and what it is like are read from the shopper's own
   words by the same vocabulary the page's local reader uses, whichever
   model read the rest: a model constrained to the catalogue's filing
   says "knit" for a hoodie, and the shopper said "hoodie".

   So is what a DESCRIPTIVE request most likely means — "something like
   a hoodie but cleaner", "a shirt that looks like a jacket" — and which
   of the garments it names are only what it is worn with ("with
   jeans"), which are taken out of the garments it is about. That
   reading is deterministic and tabled (readConcepts in
   assets/interpret.js), so it is the same whichever model read the
   rest, the same on the page's local fallback, and it cannot add a
   colour, a budget or a brand the shopper did not state. A request that
   is not descriptive gets no `concepts` at all, and nothing downstream
   changes for it.

   So is a budget stated in so many words. The prompt says "under $50"
   means maxPrice 50, and gemini-3.6-flash at minimal thinking still
   answered "a green oversized hoodie under $80" with maxPrice null.
   A bound the shopper spelled out is not a judgement call, so it does
   not depend on which model was asked; anything vaguer is left to the
   model. */
async function interpretQuery({ query, vocabulary }) {
  const alternative = interpreters.getInterpreter();
  const key = process.env.OPENAI_API_KEY;
  /* every answer, whichever model gave it, is held to the shopper's own
     words and reconciled with the page's own reading (api/_reading.js);
     a budget spelled out in the request has the last word */
  const read = (raw) => {
    const checked = reconcile(query, shapePreferences(raw), raw && raw.reading, tableReading(query));
    lastUnderstood = checked.understood;
    return Object.assign(checked.preferences, pricesIn(query));
  };
  let lastUnderstood = null;
  try {
    if (alternative) {
      const reading = await alternative.interpret({ query, vocabulary, systemPrompt: SYSTEM_PROMPT });
      if (!reading.ok) {
        /* logged, never returned: an upstream body can echo the request */
        console.error(`Interpreter (${alternative.name}) failed:`, reading.reason, reading.status || '', reading.detail || '');
        return { ok: false, reason: reading.reason === 'unparseable' ? 'unparseable' : 'unavailable', source: alternative.name };
      }
      const preferences = read(reading.raw);
      return { ok: true, source: alternative.name, preferences, understood: lastUnderstood, tokens: reading.tokens };
    }

    const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        model,
        ...(acceptsTemperature(model) ? { temperature: 0 } : {}),
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
      return { ok: false, reason: 'unavailable', source: 'openai', status: response.status };
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
      return { ok: false, reason: 'unparseable', source: 'openai' };
    }

    const spent = payload.usage && Number(payload.usage.total_tokens);
    const preferences = read(parsed);
    return { ok: true, source: 'openai', preferences, understood: lastUnderstood, tokens: Number.isFinite(spent) ? spent : 0 };
  } catch (err) {
    console.error('Interpreter error', err && err.message);
    return { ok: false, reason: 'unavailable', source: alternative ? alternative.name : 'openai' };
  }
}

/* the page's own reading of the words: assets/interpret.js registers its
   reader on the global object, in a function exactly as in a browser.
   The garments are the ones the request is ABOUT — a garment it names
   only as what the wanted one is worn with is not one of them — and the
   concepts are what a descriptive request most likely means, absent when
   there are none: a request that named its garment in shop words is
   answered with exactly the object it always was. */
function tableReading(query) {
  require('../assets/interpret.js');
  const reader = globalThis.Interpreter && globalThis.Interpreter.garmentsWanted;
  if (typeof reader !== 'function') return { garments: [], descriptors: [] };
  return reader(query);
}

/* The budget a request states outright: "under $80", "below $80", "up
   to $80", "$80 or less", "over $50", "at least $50", "$50-$100",
   "between $50 and $100". Returns only the bounds it found, so a model's
   reading of anything else stands.

   A number is read as a price only when it carries a currency — "$",
   "dollars", "bucks" or "usd" — because "under 30" and "over 50" are an
   age as often as a budget, and "10-12" is a size. Those are left for
   the model to judge, as they always were. */
const MONEY = String.raw`(\$\s*)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*(?:dollars?|bucks|usd)\b)?`;
const PRICE_RANGE = [
  new RegExp(String.raw`\bbetween\s+${MONEY}\s+and\s+${MONEY}`),
  new RegExp(String.raw`(?:^|[^\w.,])${MONEY}\s*(?:-|to)\s*${MONEY}`)
];
const PRICE_MAX = [
  new RegExp(String.raw`\b(?:under|below|less than|up to|at most|no more than|max(?:imum)?|cheaper than)\s*${MONEY}`),
  new RegExp(String.raw`${MONEY}\s*(?:or less|or under|or below|max(?:imum)?\b)`)
];
const PRICE_MIN = [
  new RegExp(String.raw`\b(?:over|above|more than|at least|no less than|min(?:imum)?|starting at)\s*${MONEY}`),
  new RegExp(String.raw`${MONEY}\s*(?:or more|and up\b|and over\b|\+)`)
];

function pricesIn(query) {
  const text = String(query || '').toLowerCase().replace(/[\u2010-\u2015]/g, '-');
  /* groups come in threes per amount: currency sign, number, currency word */
  const amount = (m, at) => (m[at] || m[at + 2] ? Number(m[at + 1].replace(/,/g, '')) : null);
  const found = {};

  for (const pattern of PRICE_RANGE) {
    const m = text.match(pattern);
    if (!m || !(m[1] || m[3] || m[4] || m[6])) continue;
    const low = Number(m[2].replace(/,/g, ''));
    const high = Number(m[5].replace(/,/g, ''));
    if (low <= high) return { minPrice: low, maxPrice: high };
  }
  for (const pattern of PRICE_MAX) {
    const m = text.match(pattern);
    const n = m && amount(m, 1);
    if (n !== null) { found.maxPrice = n; break; }
  }
  for (const pattern of PRICE_MIN) {
    const m = text.match(pattern);
    const n = m && amount(m, 1);
    if (n !== null) { found.minPrice = n; break; }
  }
  return found;
}


module.exports.shapePreferences = shapePreferences;
module.exports.interpretQuery = interpretQuery;
module.exports.pricesIn = pricesIn;
/* the benchmark sends both providers this prompt, from here, so neither
   is measured against a copy of it that has drifted */
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.MAX_QUERY = MAX_QUERY;
module.exports.OPENAI_URL = OPENAI_URL;
module.exports.OPENAI_MODEL = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;
