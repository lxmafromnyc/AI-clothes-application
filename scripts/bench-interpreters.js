#!/usr/bin/env node
/* =========================================================
   Fynd — interpreter benchmark: OpenAI against Gemini

   Sends the SAME twenty shopper requests, with the same system prompt
   and the same catalogue vocabulary, to both models, and reports what
   each one actually did with them. Nothing here is estimated except the
   money, and the money is computed from token counts the providers
   themselves reported at unit prices you can override.

   What it reports, per provider:

     valid structured output   replies that parsed AND shaped into the
                               Fynd intent object
     malformed output          replies that did not parse, or parsed
                               into something that is not an object
     field accuracy            graded fields the reading got right, over
                               the graded fields asked, with a per-field
                               breakdown of where each model goes wrong
     latency                   wall clock per call: mean, p50, p95, max
     tokens                    input and output per search, as reported
     cost per 1,000 searches   those tokens at the unit prices below

   And, per query, where the two models actually disagree — on the
   budget, colour, category, fit, brand, occasion and style — with the
   reading that matches the rubric named, because two models can score
   the same and still be wrong in different places.

   ---------------------------------------------------------
   Why this is a fair comparison
   ---------------------------------------------------------
   Both providers are sent api/interpret.js's own SYSTEM_PROMPT, from
   that file, and the same user message, composed by the same function
   the Gemini adapter uses in production — scripts/test-gemini.js holds
   that message identical to the one the live OpenAI path sends. Both
   are asked for JSON with the provider's own JSON mode and neither is
   given a response schema. Both replies are parsed with a plain
   JSON.parse and shaped by api/interpret.js's own shapePreferences, so
   "valid" means the same thing on both sides: an object the frontend
   and /api/search could be handed unchanged.

   Gemini's thinking is off by default (see the adapter). Turn it on for
   a run with GEMINI_THINKING_BUDGET; thinking tokens are billed as
   output and are counted as output here.

   ---------------------------------------------------------
   Usage
   ---------------------------------------------------------
     OPENAI_API_KEY=... GEMINI_API_KEY=... node scripts/bench-interpreters.js

   Options
     --queries=N        run the first N of the 20 (default: all)
     --repeat=N         run the set N times, for a steadier latency
                        figure (default 1)
     --only=openai      run one side only. Also --only=gemini
     --openai-model=    override the model (default: OPENAI_MODEL, else
                        the endpoint's own gpt-4o-mini)
     --gemini-model=    override the model (default: GEMINI_MODEL, else
                        gemini-2.5-flash)
     --openai-in=0.15   $ per 1M input tokens, when the price has moved
     --openai-out=0.60  $ per 1M output tokens
     --gemini-in=0.30   $ per 1M input tokens
     --gemini-out=2.50  $ per 1M output tokens
     --out=path.json    write every reading and every number as JSON
     --compare=path.json  re-render the whole report from a file --out
                        wrote. Calls nothing and spends nothing, so a
                        run made on one machine can be read on another
     --diagnose         ONE call per provider, reporting exactly what
                        came back: HTTP status, the provider's own error
                        code and message, whether the request reached
                        the provider at all, whether authentication was
                        accepted, and whether the reply was shaped the
                        way the adapter expects. A 400 costs one more
                        call, asking again without the one field most
                        likely to have caused it. Exits non-zero unless
                        both returned a usable Fynd intent — run this
                        before trusting a benchmark.
     --dry-run          print the plan and the request shapes, call
                        nothing, spend nothing

   A run spends real credit on both accounts, so it says how many calls
   it is about to make before it makes any.

   Neither key is ever printed. Both are redacted out of anything this
   script logs, including an upstream error body.
   ========================================================= */

'use strict';

const fs = require('fs');
const interpret = require('../api/interpret');
const gemini = require('../api/_interpreters/gemini');

/* ---------------------------------------------------------
   Flags
   --------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const has = (name) => argv.includes(`--${name}`);
const num = (name, fallback) => {
  const value = Number(flag(name, NaN));
  return Number.isFinite(value) ? value : fallback;
};

/* Published list prices per 1M tokens at the time of writing. They move;
   every one of them is overridable, and the run prints which it used. */
const PRICES = {
  openai: { input: num('openai-in', 0.15), output: num('openai-out', 0.60) },
  gemini: { input: num('gemini-in', 0.30), output: num('gemini-out', 2.50) }
};

/* ---------------------------------------------------------
   The catalogue's vocabulary, as the page sends it
   ---------------------------------------------------------
   These are the values assets/catalog.js actually holds, which is what
   makes "picking the closest match" a real instruction rather than an
   invitation to invent a word the catalogue cannot match.
   --------------------------------------------------------- */

const VOCABULARY = {
  categories: ['knit', 'shirt', 'trousers', 'tee', 'jacket', 'dress', 'skirt', 'coat', 'sneaker', 'shorts'],
  colors: ['Neutral', 'White', 'Black', 'Bright', 'Pastel', 'Blue', 'Earth', 'Green'],
  occasions: ['Work', 'Everyday', 'Weekend', 'Evening', 'Active'],
  fits: ['Regular', 'Slim', 'Relaxed', 'Oversized'],
  brands: ['UNIQLO', 'ZARA', "LEVI'S", 'Northfold', 'Halden', 'Coveworks', 'Atlas Supply', 'Rue Nine', 'Terrace', 'Kinfield', 'Solstice'],
  styles: ['Minimal', 'Classic', 'Sporty', 'Streetwear', 'Bohemian', 'Bold']
};

/* ---------------------------------------------------------
   The twenty requests, and what a right answer looks like
   ---------------------------------------------------------
   `expect` names only the fields the request actually decides. A field
   left out is not graded, so a model is never marked down for putting
   sensible extra keywords in — but a field that IS named is graded
   strictly, including the ones expected to stay empty. Those are the
   interesting ones: "cheap" and "something warm" state no budget, and
   the prompt forbids inventing one.

   `oneOf` grades a field where the prompt itself allows two readings —
   "loose" is told to map to a relaxed OR an oversized fit — so a model
   is not penalised for taking the other one.
   --------------------------------------------------------- */

const QUERIES = [
  { query: 'a black oversized hoodie under $80',
    expect: { colors: ['Black'], fits: ['Oversized'], maxPrice: 80, minPrice: null } },
  { query: 'white oxford shirt for work',
    expect: { categories: ['shirt'], colors: ['White'], occasions: ['Work'], maxPrice: null } },
  { query: 'loose fit trousers for everyday wear',
    expect: { categories: ['trousers'], fits: { oneOf: [['Relaxed'], ['Oversized']] }, occasions: ['Everyday'] } },
  { query: 'black dress for an evening out',
    expect: { categories: ['dress'], colors: ['Black'], occasions: ['Evening'] } },
  { query: "men's slim jeans between $50 and $80",
    expect: { fits: ['Slim'], gender: 'men', minPrice: 50, maxPrice: 80 } },
  { query: 'something warm for winter',
    expect: { season: 'winter', maxPrice: null, minPrice: null } },
  { query: 'UNIQLO merino knit',
    expect: { brands: ['UNIQLO'], categories: ['knit'], maxPrice: null } },
  { query: 'green jacket under 120 dollars',
    expect: { categories: ['jacket'], colors: ['Green'], maxPrice: 120 } },
  { query: 'pastel skirt for a weekend brunch',
    expect: { categories: ['skirt'], colors: ['Pastel'], occasions: ['Weekend'] } },
  { query: 'sporty tee for the gym',
    expect: { categories: ['tee'], occasions: ['Active'], styles: ['Sporty'] } },
  { query: 'a minimal white tee, nothing over $30',
    expect: { categories: ['tee'], colors: ['White'], styles: ['Minimal'], maxPrice: 30 } },
  { query: 'blue denim jacket for the weekend',
    expect: { categories: ['jacket'], colors: ['Blue'], occasions: ['Weekend'] } },
  { query: "women's relaxed linen trousers for summer",
    expect: { categories: ['trousers'], fits: ['Relaxed'], gender: 'women', season: 'summer' } },
  { query: 'streetwear sneakers in bright colours',
    expect: { categories: ['sneaker'], colors: ['Bright'], styles: ['Streetwear'] } },
  { query: 'a smart black coat for work, $150-$300',
    expect: { categories: ['coat'], colors: ['Black'], occasions: ['Work'], minPrice: 150, maxPrice: 300 } },
  { query: 'earth tone shorts for the weekend',
    expect: { categories: ['shorts'], colors: ['Earth'], occasions: ['Weekend'] } },
  { query: 'ZARA oversized shirt',
    expect: { brands: ['ZARA'], categories: ['shirt'], fits: ['Oversized'] } },
  { query: "Levi's black trousers under 90",
    expect: { brands: ["LEVI'S"], colors: ['Black'], categories: ['trousers'], maxPrice: 90 } },
  { query: 'a neutral knit for the office',
    expect: { categories: ['knit'], colors: ['Neutral'], occasions: ['Work'] } },
  { query: 'cheap black tee',
    expect: { categories: ['tee'], colors: ['Black'], maxPrice: null, minPrice: null } }
];

/* ---------------------------------------------------------
   Grading
   --------------------------------------------------------- */

const GRADED_FIELDS = ['categories', 'colors', 'occasions', 'fits', 'brands', 'styles',
  'maxPrice', 'minPrice', 'season', 'gender'];

const sameSet = (got, want) => {
  if (!Array.isArray(got)) return false;
  const norm = (list) => [...new Set(list.map((v) => String(v).trim().toLowerCase()))].sort();
  const a = norm(got);
  const b = norm(want);
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

const sameScalar = (got, want) => {
  if (want === null) return got === null;
  if (typeof want === 'number') return got === want;
  return typeof got === 'string' && got.trim().toLowerCase() === String(want).trim().toLowerCase();
};

function fieldMatches(got, want) {
  if (want && typeof want === 'object' && !Array.isArray(want) && Array.isArray(want.oneOf)) {
    return want.oneOf.some((option) => fieldMatches(got, option));
  }
  return Array.isArray(want) ? sameSet(got, want) : sameScalar(got, want);
}

/* Grades one reading, and says which fields it got wrong, so a
   disagreement with the rubric is visible rather than just a lower
   score. */
function grade(preferences, expect) {
  const fields = Object.keys(expect).filter((f) => GRADED_FIELDS.includes(f));
  const wrong = fields.filter((field) => !fieldMatches(preferences[field], expect[field]));
  return {
    graded: fields.length,
    correct: fields.length - wrong.length,
    wrong: wrong.map((field) => ({ field, expected: expect[field], got: preferences[field] }))
  };
}

/* ---------------------------------------------------------
   The two calls
   ---------------------------------------------------------
   The OpenAI request is composed here in the shape api/interpret.js
   sends it — same URL, same model, same temperature, same JSON mode,
   same two messages. scripts/test-gemini.js captures the live handler's
   request and asserts this builder produces exactly it, so the
   benchmark cannot end up measuring a request production never makes.
   --------------------------------------------------------- */

const openaiModel = () => flag('openai-model', '') || interpret.OPENAI_MODEL();

function buildOpenAIRequest({ query, vocabulary, model, jsonMode }) {
  const body = {
    model: model || openaiModel(),
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: interpret.SYSTEM_PROMPT },
      { role: 'user', content: gemini.userPrompt(query, vocabulary) }
    ]
  };
  /* jsonMode:false drops response_format. A model that does not support
     it rejects the whole call with a 400, and asking again without it is
     the only way to tell that apart from a 400 about something else.
     Only --diagnose passes this, once. */
  if (jsonMode === false) delete body.response_format;

  return {
    url: interpret.OPENAI_URL,
    options: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY || ''}`
      },
      body: JSON.stringify(body)
    }
  };
}

/* The OpenAI key never reaches a log line either. */
function redactOpenAI(value) {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  const raw = String(value === undefined || value === null ? '' : value);
  return key ? raw.split(key).join('***') : raw;
}

/* Response headers a failure may carry back, for one question only: did
   this answer come from OpenAI, or from something in front of it. None
   can hold our key, and each is redacted anyway. */
const REPORTED_HEADERS = ['content-type', 'server', 'via', 'www-authenticate', 'x-request-id', 'openai-processing-ms'];

function headersFrom(response) {
  const out = {};
  if (!response || !response.headers || typeof response.headers.get !== 'function') return out;
  REPORTED_HEADERS.forEach((name) => {
    const value = response.headers.get(name);
    if (value) out[name] = redactOpenAI(value).slice(0, 200);
  });
  return out;
}

/* OpenAI's error envelope, read from the whole body before truncation.
   Same rule, same reason, as the adapter's. */
function openaiEnvelope(body) {
  const parsed = providerEnvelope(body);
  return parsed ? Object.assign({}, parsed, { message: redactOpenAI(parsed.message).slice(0, 300) }) : null;
}

async function callOpenAI(query, options) {
  const { url, options: request } = buildOpenAIRequest({
    query, vocabulary: VOCABULARY, jsonMode: options && options.jsonMode
  });
  let response;
  try {
    response = await fetch(url, request);
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: redactOpenAI(err && err.message) };
  }
  if (!response.ok) {
    let detail = '';
    try { detail = await response.text(); } catch (err) { detail = ''; }
    /* the body is carried back, redacted: a 401 from OpenAI and a 403
       from a proxy in the way are different problems, and a failure
       nobody can name is a failure nobody can fix. The envelope is
       parsed from the WHOLE body before the body is truncated — a long
       error must not become an unnameable one. */
    return {
      ok: false,
      reason: 'upstream',
      status: response.status,
      error: openaiEnvelope(detail),
      detail: redactOpenAI(detail).slice(0, 500),
      headers: headersFrom(response)
    };
  }

  let payload;
  try { payload = await response.json(); } catch (err) {
    return { ok: false, reason: 'unparseable', status: response.status, detail: 'the 200 body was not JSON', headers: headersFrom(response) };
  }

  const content = payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content : '';
  let raw;
  try { raw = JSON.parse(content); } catch (err) {
    return { ok: false, reason: 'unparseable', status: response.status, detail: redactOpenAI(content).slice(0, 300), headers: headersFrom(response) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'unparseable', status: response.status, detail: 'the reply parsed, but not into an object', headers: headersFrom(response) };
  }

  const u = payload.usage || {};
  return {
    ok: true,
    raw,
    status: response.status,
    headers: headersFrom(response),
    usage: {
      input: Number(u.prompt_tokens) || 0,
      output: Number(u.completion_tokens) || 0,
      thoughts: 0,
      total: Number(u.total_tokens) || 0
    }
  };
}

async function callGemini(query, options) {
  const override = flag('gemini-model', '');
  const previous = process.env.GEMINI_MODEL;
  if (override) process.env.GEMINI_MODEL = override;
  try {
    return await gemini.interpret({
      query,
      vocabulary: VOCABULARY,
      systemPrompt: interpret.SYSTEM_PROMPT,
      /* undefined keeps the configured budget; --diagnose passes null
         once, to ask again without the field at all */
      thinking: options && 'thinking' in options ? options.thinking : undefined
    });
  } finally {
    if (override) {
      if (previous === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = previous;
    }
  }
}

const PROVIDERS = {
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', model: openaiModel, call: callOpenAI, price: PRICES.openai },
  gemini: { label: 'Gemini', key: 'GEMINI_API_KEY', model: () => flag('gemini-model', '') || gemini.model(), call: callGemini, price: PRICES.gemini }
};

/* ---------------------------------------------------------
   Numbers
   --------------------------------------------------------- */

const round = (n, places = 2) => Number(Number(n).toFixed(places));
const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

function percentile(list, p) {
  if (!list.length) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/* Thinking tokens are billed as output, so they are costed as output. */
const costPerThousand = (usage, price) =>
  ((usage.input * price.input) + ((usage.output + usage.thoughts) * price.output)) / 1e6 * 1000;

function summarise(name, runs) {
  const provider = PROVIDERS[name];
  const valid = runs.filter((r) => r.ok);
  const malformed = runs.filter((r) => !r.ok && r.reason === 'unparseable');
  const errored = runs.filter((r) => !r.ok && r.reason !== 'unparseable');
  const latencies = runs.map((r) => r.ms);

  const graded = valid.reduce((sum, r) => sum + r.grade.graded, 0);
  const correct = valid.reduce((sum, r) => sum + r.grade.correct, 0);

  /* which field each model actually gets wrong, counted */
  const wrongByField = {};
  valid.forEach((r) => r.grade.wrong.forEach(({ field }) => {
    wrongByField[field] = (wrongByField[field] || 0) + 1;
  }));

  const usage = {
    input: mean(valid.map((r) => r.usage.input)),
    output: mean(valid.map((r) => r.usage.output)),
    thoughts: mean(valid.map((r) => r.usage.thoughts)),
    total: mean(valid.map((r) => r.usage.total))
  };
  const reported = valid.some((r) => r.usage.total > 0);

  return {
    provider: name,
    label: provider.label,
    model: provider.model(),
    calls: runs.length,
    validRate: runs.length ? valid.length / runs.length : 0,
    malformedRate: runs.length ? malformed.length / runs.length : 0,
    errorRate: runs.length ? errored.length / runs.length : 0,
    errors: errored.map((r) => ({
      query: r.query, reason: r.reason, status: r.status || null,
      detail: r.detail || null, reached: r.reached || null, authentication: r.authentication || null
    })),
    /* every distinct failure, counted: 20 identical ones are a single
       problem and should read as a single problem */
    errorsByKind: Object.entries(errored.reduce((acc, r) => {
      const key = `${r.reason}${r.status ? ` ${r.status}` : ''}`;
      (acc[key] = acc[key] || { count: 0, example: null }).count += 1;
      if (!acc[key].example && r.detail) acc[key].example = String(r.detail).slice(0, 200);
      return acc;
    }, {})).map(([kind, v]) => ({ kind, count: v.count, example: v.example })),
    fieldAccuracy: graded ? correct / graded : 0,
    fieldsGraded: graded,
    fieldsCorrect: correct,
    wrongByField,
    latencyMs: {
      mean: round(mean(latencies)), p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)), max: round(Math.max(0, ...latencies))
    },
    tokens: reported
      ? { input: round(usage.input, 1), output: round(usage.output, 1), thoughts: round(usage.thoughts, 1), total: round(usage.total, 1) }
      : null,
    costPer1000: reported ? round(costPerThousand(usage, provider.price), 4) : null,
    price: provider.price
  };
}

/* ---------------------------------------------------------
   The run
   --------------------------------------------------------- */

const pct = (n) => `${round(n * 100, 1)}%`;
const pad = (s, w) => String(s).padEnd(w);

function report(summary) {
  console.log(`\n${summary.label}  (${summary.model})`);
  console.log(`  valid structured output   ${pct(summary.validRate)}  (${summary.calls} calls)`);
  console.log(`  malformed output          ${pct(summary.malformedRate)}`);
  if (summary.errorRate) {
    console.log(`  API errors                ${pct(summary.errorRate)}`);
    (summary.errorsByKind || []).forEach(({ kind, count, example }) => {
      console.log(`    ${pad(kind, 22)}${count}${example ? `  ${String(example).slice(0, 90)}` : ''}`);
    });
    const reached = summary.errors && summary.errors[0];
    if (reached) console.log(`    ${pad('reached provider', 22)}${reached.reached}; authentication ${reached.authentication}`);
  }
  console.log(`  field accuracy            ${pct(summary.fieldAccuracy)}  (${summary.fieldsCorrect}/${summary.fieldsGraded} graded fields)`);
  console.log(`  latency                   mean ${summary.latencyMs.mean}ms  p50 ${summary.latencyMs.p50}ms  p95 ${summary.latencyMs.p95}ms  max ${summary.latencyMs.max}ms`);
  if (summary.tokens) {
    const thinking = summary.tokens.thoughts ? `  (+${summary.tokens.thoughts} thinking)` : '';
    console.log(`  tokens per search         ${summary.tokens.input} in, ${summary.tokens.output} out${thinking}`);
    console.log(`  cost per 1,000 searches   $${summary.costPer1000}  at $${summary.price.input}/$${summary.price.output} per 1M in/out`);
  } else {
    console.log('  tokens per search         not reported by the provider');
    console.log('  cost per 1,000 searches   not computable without token counts');
  }
  const wrong = Object.entries(summary.wrongByField).sort((a, b) => b[1] - a[1]);
  if (wrong.length) console.log(`  fields most often wrong   ${wrong.map(([f, n]) => `${f} (${n})`).join(', ')}`);
}

function compare(a, b) {
  console.log('\nhead to head\n');
  const rows = [
    ['valid structured output', pct(a.validRate), pct(b.validRate)],
    ['malformed output', pct(a.malformedRate), pct(b.malformedRate)],
    ['field accuracy', pct(a.fieldAccuracy), pct(b.fieldAccuracy)],
    ['latency p50', `${a.latencyMs.p50}ms`, `${b.latencyMs.p50}ms`],
    ['latency p95', `${a.latencyMs.p95}ms`, `${b.latencyMs.p95}ms`],
    ['tokens in/out', a.tokens ? `${a.tokens.input}/${a.tokens.output}` : '—', b.tokens ? `${b.tokens.input}/${b.tokens.output}` : '—'],
    ['cost per 1,000 searches', a.costPer1000 === null ? '—' : `$${a.costPer1000}`, b.costPer1000 === null ? '—' : `$${b.costPer1000}`]
  ];
  console.log(`  ${pad('', 26)}${pad(a.label, 14)}${b.label}`);
  rows.forEach(([label, left, right]) => console.log(`  ${pad(label, 26)}${pad(left, 14)}${right}`));
  console.log('\n  Neither column is a verdict on its own: read accuracy and');
  console.log('  malformed rate first, then cost, then latency.');
}

/* ---------------------------------------------------------
   Where the two models actually disagree
   ---------------------------------------------------------
   Two rates being close does not mean two models read a request the
   same way — they can be wrong in different places and score the same.
   This is the per-query difference, on the fields a shopper would
   notice: the budget, and the six attributes the catalogue matches on.

   Where the field is one the rubric grades, the reading that matches is
   named, so a disagreement is not just a difference but a right and a
   wrong answer. Where it is not graded, both are shown and neither is
   called correct — the rubric does not have an opinion, and inventing
   one here would be inventing a result.
   --------------------------------------------------------- */

const DISAGREEMENT_FIELDS = [
  { field: 'maxPrice', label: 'budget (max)' },
  { field: 'minPrice', label: 'budget (min)' },
  { field: 'colors', label: 'colour' },
  { field: 'categories', label: 'category' },
  { field: 'fits', label: 'fit' },
  { field: 'brands', label: 'brand' },
  { field: 'occasions', label: 'occasion' },
  { field: 'styles', label: 'style' }
];

const sameReading = (a, b) => (Array.isArray(a) || Array.isArray(b)
  ? sameSet(Array.isArray(a) ? a : [], Array.isArray(b) ? b : [])
  : a === b);

/* the first reading of each query, so --repeat does not multiply the
   report; a later pass differing from the first is a separate question */
function firstByQuery(runs) {
  const byQuery = new Map();
  (runs || []).forEach((run) => { if (!byQuery.has(run.query)) byQuery.set(run.query, run); });
  return byQuery;
}

function disagreements(leftName, leftRuns, rightName, rightRuns, queries) {
  const left = firstByQuery(leftRuns);
  const right = firstByQuery(rightRuns);
  const expectations = new Map((queries || QUERIES).map((q) => [q.query, q.expect]));
  const rows = [];

  for (const query of left.keys()) {
    const a = left.get(query);
    const b = right.get(query);
    if (!b) continue;

    /* a side that returned nothing usable is a difference of a
       different kind, and is reported as one rather than as a field */
    if (!a.ok || !b.ok) {
      rows.push({
        query,
        missing: [!a.ok ? { provider: leftName, reason: a.reason } : null,
          !b.ok ? { provider: rightName, reason: b.reason } : null].filter(Boolean),
        fields: []
      });
      continue;
    }

    const expect = expectations.get(query) || {};
    const fields = DISAGREEMENT_FIELDS
      .filter(({ field }) => !sameReading(a.preferences[field], b.preferences[field]))
      .map(({ field, label }) => {
        const want = expect[field];
        const graded = want !== undefined;
        return {
          field,
          label,
          [leftName]: a.preferences[field],
          [rightName]: b.preferences[field],
          graded,
          /* null where the rubric has no opinion, and where BOTH are
             wrong: a disagreement is not automatically a winner */
          matches: !graded ? null
            : (fieldMatches(a.preferences[field], want) ? leftName
              : (fieldMatches(b.preferences[field], want) ? rightName : null)),
          expected: graded ? want : undefined
        };
      });

    if (fields.length) rows.push({ query, missing: [], fields });
  }
  return rows;
}

function reportDisagreements(leftName, rightName, rows, labels) {
  const name = (key) => labels[key] || key;
  console.log('\nwhere they disagree\n');

  if (!rows.length) {
    console.log(`  On all of these requests ${name(leftName)} and ${name(rightName)} read every`);
    console.log('  budget, colour, category, fit, brand, occasion and style the same.');
    return;
  }

  const show = (v) => (v === null || v === undefined ? 'null' : JSON.stringify(v));

  rows.forEach(({ query, fields, missing }) => {
    console.log(`  ${query}`);
    missing.forEach(({ provider, reason }) => console.log(`    ${pad('', 14)}${name(provider)} returned nothing usable (${reason})`));
    fields.forEach((row) => {
      const verdict = row.matches === null
        ? (row.graded ? '  — neither matches the rubric' : '')
        : `  — ${name(row.matches)} matches the rubric`;
      console.log(`    ${pad(row.label, 14)}${pad(`${name(leftName)} ${show(row[leftName])}`, 30)}${pad(`${name(rightName)} ${show(row[rightName])}`, 30)}${verdict}`);
    });
    console.log('');
  });

  /* which field they disagree about most, and who is right when they do */
  const tally = {};
  rows.forEach(({ fields }) => fields.forEach((row) => {
    const t = tally[row.label] || (tally[row.label] = { total: 0, [leftName]: 0, [rightName]: 0, neither: 0 });
    t.total += 1;
    if (row.matches === leftName) t[leftName] += 1;
    else if (row.matches === rightName) t[rightName] += 1;
    else if (row.graded) t.neither += 1;
  }));

  const ordered = Object.entries(tally).sort((a, b) => b[1].total - a[1].total);
  if (ordered.length) {
    console.log(`  ${pad('field', 16)}${pad('disagreements', 16)}${pad(`${name(leftName)} right`, 16)}${pad(`${name(rightName)} right`, 16)}neither`);
    ordered.forEach(([label, t]) => {
      console.log(`  ${pad(label, 16)}${pad(t.total, 16)}${pad(t[leftName], 16)}${pad(t[rightName], 16)}${t.neither}`);
    });
    console.log('\n  "neither" and ungraded rows are differences the rubric does not');
    console.log('  settle. Read those queries above before trusting either column.');
  }
}

/* Renders the whole report from a saved run, calling nothing and
   spending nothing. --out writes the file this reads. */
function renderSaved(path) {
  const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
  const names = Object.keys(saved.providers || {});
  if (!names.length) throw new Error(`${path} holds no provider results`);

  console.log(`\nFynd — interpreter benchmark, from ${path}`);
  console.log(`  run at         ${saved.ranAt}`);
  console.log(`  queries        ${saved.queries}${saved.repeat > 1 ? ` x ${saved.repeat} runs` : ''}`);

  names.forEach((name) => report(saved.providers[name].summary));
  if (names.length === 2) {
    const [a, b] = names;
    compare(saved.providers[a].summary, saved.providers[b].summary);
    reportDisagreements(a, b,
      saved.disagreements || disagreements(a, saved.providers[a].runs, b, saved.providers[b].runs, saved.queriesAsked),
      { [a]: saved.providers[a].summary.label, [b]: saved.providers[b].summary.label });
  }
  console.log('');
}

/* ---------------------------------------------------------
   What actually came back
   ---------------------------------------------------------
   A run where every call fails with `upstream` says only that some
   server answered with a non-2xx. It does not say WHICH server: a 403
   carrying Google's own error envelope and a 403 from a proxy standing
   in front of it are the same status and completely different problems.

   These read the evidence a failure carries and say, in words that do
   not overstate what the evidence supports, whether the request reached
   the provider and whether it got past authentication. Where the
   evidence does not settle it, the answer is "unknown" — which is a
   finding, not a gap to be filled with a guess.
   --------------------------------------------------------- */

/* Both providers document the same error envelope shape:
     OpenAI  { error: { message, type, code, param } }
     Gemini  { error: { code, message, status } }
   Something else answering an API endpoint almost never produces it. */
function providerEnvelope(detail) {
  if (typeof detail !== 'string' || !detail.trim().startsWith('{')) return null;
  let body;
  try { body = JSON.parse(detail); } catch (err) { return null; }
  const error = body && body.error;
  if (!error || typeof error !== 'object') return null;
  if (typeof error.message !== 'string') return null;
  return {
    message: error.message,
    code: error.code !== undefined ? error.code : null,
    type: error.type || error.status || null
  };
}

const looksLikeHtml = (detail) => typeof detail === 'string' && /^\s*<(!doctype|html)/i.test(detail);

function classify(reading) {
  const status = reading.status === undefined ? null : reading.status;
  const headers = reading.headers || {};
  /* the envelope parsed at the source, from the untruncated body, is
     authoritative; parsing `detail` is only a fallback for a record
     written before that existed */
  const envelope = reading.error || providerEnvelope(reading.detail);
  const contentType = headers['content-type'] || '';

  /* did it get there */
  let reached = 'unknown';
  let responder = 'unidentified';
  if (reading.ok || (status !== null && status >= 200 && status < 300)) {
    reached = 'yes';
    responder = 'the provider';
  } else if (envelope) {
    reached = 'yes';
    responder = 'the provider (its own error envelope came back)';
  } else if (status === 407) {
    reached = 'no';
    responder = 'a proxy demanding its own authentication';
  } else if (reading.reason === 'unreachable') {
    reached = 'no';
    responder = 'nothing — the connection itself failed';
  } else if (looksLikeHtml(reading.detail) || /text\/html/i.test(contentType)) {
    reached = 'no';
    responder = 'something answering HTML, which these APIs never do';
  } else if (status !== null && contentType && !/json/i.test(contentType)) {
    /* Both APIs answer an error with a JSON envelope, always. A non-2xx
       arriving as text/plain is therefore something in the path
       answering on the provider's behalf — an egress allowlist, a
       corporate proxy, a gateway. Observed in exactly this form:
       403 text/plain "Host not in allowlist: api.openai.com". */
    reached = 'no';
    responder = `something answering ${contentType.split(';')[0]}, which these APIs do not do for errors`;
  }

  /* Did authentication succeed. Only a 2xx PROVES it did; everything
     else is read from what the provider said, and where nothing settles
     it the answer is "unknown".

     The status alone is not enough: OpenAI rejects a bad key with 401,
     and Gemini rejects one with 400 INVALID_ARGUMENT — the same status
     it uses for a malformed request. So the message is read too, which
     is the only thing that tells those two 400s apart. */
  const saidAuth = envelope && /api[ _-]?key not valid|invalid[ _-]?api[ _-]?key|api key expired|unauthenticated|permission denied|incorrect api key|invalid authentication/i
    .test(`${envelope.message} ${envelope.type || ''}`);

  let authentication = 'unknown';
  if (reached === 'yes' && (reading.ok || (status >= 200 && status < 300))) authentication = 'accepted';
  else if (saidAuth) authentication = 'rejected';
  else if (status === 401) authentication = 'rejected';
  else if (status === 403 && envelope) authentication = 'rejected';
  else if (envelope && [400, 404, 422, 429].includes(status)) authentication = 'accepted (the request got past auth)';
  else if (envelope && status >= 500) authentication = 'accepted (the request got past auth)';

  return { status, reached, responder, authentication, envelope, headers };
}

/* What a failed call leaves behind.

   `detail` and `headers` are carried, never dropped. A run in which
   every call failed is otherwise indistinguishable from any other run
   in which every call failed, and the whole point of recording a
   failure is being able to say afterwards what it actually was. Both
   fields were redacted by the caller that produced them. */
function recordFailure(query, reading, ms) {
  const failure = classify(reading);
  return {
    query,
    ok: false,
    reason: reading.reason,
    status: reading.status === undefined ? null : reading.status,
    detail: reading.detail || null,
    headers: reading.headers || null,
    reached: failure.reached,
    authentication: failure.authentication,
    said: failure.envelope ? failure.envelope.message : (reading.detail || null),
    ms
  };
}

/* Was the 200 shaped the way the adapter expects? Only answerable on a
   success, and it is the difference between "the model said something
   unusable" and "we are reading the wrong field of a fine reply". */
function shapeVerdict(reading) {
  if (reading.ok) return { asExpected: true, note: 'the documented fields were present and the content parsed as a JSON object' };
  if (reading.reason !== 'unparseable') return { asExpected: null, note: 'not applicable: no 200 to read' };
  return { asExpected: false, note: reading.detail ? `a 200 came back but could not be read as an intent: ${reading.detail}` : 'a 200 came back and could not be read as an intent' };
}

/* ---------------------------------------------------------
   --diagnose: one call per provider, and what it proves
   ---------------------------------------------------------
   At most two calls per provider: the real request, and — only if that
   returns a 400 — the same request once more without the one field most
   likely to have caused it, so a request-shape mismatch is identified
   rather than guessed at.
   --------------------------------------------------------- */

const RETRY_WITHOUT = {
  openai: { field: 'response_format', options: { jsonMode: false } },
  gemini: { field: 'generationConfig.thinkingConfig', options: { thinking: null } }
};

async function diagnoseOne(name, query) {
  const provider = PROVIDERS[name];
  const started = Date.now();
  const reading = await provider.call(query);
  const ms = Date.now() - started;
  const verdict = { name, label: provider.label, model: provider.model(), query, ms, reading, classified: classify(reading) };

  /* a 400 is the one status worth a second question */
  if (!reading.ok && reading.status === 400) {
    const retry = RETRY_WITHOUT[name];
    const second = await provider.call(query, retry.options);
    verdict.retry = { without: retry.field, reading: second, classified: classify(second) };
  }
  return verdict;
}

function reportDiagnosis(v) {
  const r = v.reading;
  const c = v.classified;
  const line = (label, value) => console.log(`  ${pad(label, 26)}${value}`);

  console.log(`\n${v.label}  (${v.model})`);
  console.log(`  request                   POST ${v.name === 'openai' ? interpret.OPENAI_URL : `${gemini.API_ROOT}/${v.model}:generateContent`}`);
  line('authenticated by', v.name === 'openai' ? 'Authorization: Bearer … (header, value never printed)' : 'x-goog-api-key: … (header, value never printed)');
  line('query', JSON.stringify(v.query));
  line('wall clock', `${v.ms}ms`);
  line('HTTP status', c.status === null ? 'none — no response at all' : c.status);
  line('reached the provider', c.reached === 'yes' ? 'yes' : (c.reached === 'no' ? `no — ${c.responder}` : `unknown — ${c.responder}`));
  line('authentication', c.authentication);

  if (Object.keys(c.headers).length) {
    console.log(`  ${pad('response headers', 26)}`);
    Object.entries(c.headers).forEach(([k, val]) => console.log(`    ${pad(k, 24)}${val}`));
  } else {
    line('response headers', 'none reported');
  }

  if (c.envelope) {
    line('provider error code', c.envelope.code === null ? '—' : c.envelope.code);
    line('provider error type', c.envelope.type || '—');
    line('provider message', c.envelope.message);
  } else if (!r.ok) {
    line('provider message', r.detail ? `no error envelope. Body begins: ${String(r.detail).slice(0, 200)}` : 'nothing came back to read');
  }

  const shape = shapeVerdict(r);
  line('response shape', shape.asExpected === null ? 'n/a' : (shape.asExpected ? 'as the adapter expects' : 'NOT as the adapter expects'));
  if (shape.asExpected === false) console.log(`    ${shape.note}`);

  if (v.retry) {
    const rc = v.retry.classified;
    console.log(`\n  asked again without ${v.retry.without}:`);
    console.log(`    ${pad('HTTP status', 24)}${rc.status === null ? 'none' : rc.status}`);
    if (v.retry.reading.ok) {
      console.log(`    ${pad('result', 24)}it worked. ${v.retry.without} is what the first call was rejected for.`);
    } else {
      console.log(`    ${pad('result', 24)}still failing, so ${v.retry.without} is not the cause`);
      if (rc.envelope) console.log(`    ${pad('provider message', 24)}${rc.envelope.message}`);
    }
  }

  if (r.ok) {
    const preferences = interpret.shapePreferences(r.raw);
    line('tokens', `${r.usage.input} in, ${r.usage.output} out${r.usage.thoughts ? `, ${r.usage.thoughts} thinking` : ''}`);
    console.log(`  ${pad('Fynd intent returned', 26)}`);
    console.log(`    ${JSON.stringify(preferences)}`);
    const usable = Object.keys(preferences).length === 11;
    line('verdict', usable ? 'USABLE — a structured Fynd intent came back' : 'NOT usable — the intent is not the shape /api/search reads');
    return usable;
  }

  line('verdict', `NOT usable — ${r.reason}${c.status ? ` ${c.status}` : ''}`);
  if (c.reached === 'no') {
    console.log('    This never got to the provider, so it says nothing about the');
    console.log('    model, the key or the request. It is a network path problem:');
    console.log(`    ${c.responder}.`);
  }
  return false;
}

async function diagnose(names) {
  const query = QUERIES[0].query;
  console.log('\nFynd — interpreter smoke test\n');
  console.log(`  one request per provider (a 400 costs one more, to identify it)`);
  console.log(`  providers      ${names.map((n) => `${PROVIDERS[n].label} (${PROVIDERS[n].model()})`).join(', ')}`);

  const usable = [];
  for (const name of names) {
    usable.push(await diagnoseOne(name, query).then(reportDiagnosis));
  }

  const allUsable = usable.every(Boolean);
  console.log(`\n${allUsable
    ? '  Both returned a usable structured Fynd intent. The 20-query benchmark is worth running.'
    : '  At least one provider did not return a usable intent. Fix that before running the benchmark:'}`);
  if (!allUsable) {
    console.log('  a benchmark over a broken path measures the path, not the models.');
  }
  console.log('');
  return allUsable;
}

async function run() {
  const saved = flag('compare', '');
  if (saved) return renderSaved(saved);

  const only = flag('only', '');
  const names = only ? only.split(',').map((s) => s.trim()).filter((s) => PROVIDERS[s]) : Object.keys(PROVIDERS);
  if (!names.length) {
    console.error(`--only names no provider. Known: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(2);
  }

  const count = Math.max(1, Math.min(QUERIES.length, num('queries', QUERIES.length)));
  const repeat = Math.max(1, num('repeat', 1));
  const set = QUERIES.slice(0, count);
  const calls = set.length * repeat;

  if (!has('diagnose')) {
    console.log(`\nFynd — interpreter benchmark\n`);
    console.log(`  queries        ${set.length}${repeat > 1 ? ` x ${repeat} runs` : ''}`);
    console.log(`  providers      ${names.map((n) => `${PROVIDERS[n].label} (${PROVIDERS[n].model()})`).join(', ')}`);
  }
  if (!has('diagnose')) console.log(`  calls to make  ${calls * names.length} — this spends real credit on each account`);

  if (has('dry-run')) {
    console.log('\n--dry-run: nothing will be called.\n');
    set.forEach((q, i) => console.log(`  ${pad(i + 1, 4)}${q.query}`));
    const sample = buildOpenAIRequest({ query: set[0].query, vocabulary: VOCABULARY });
    console.log(`\n  OpenAI request  POST ${sample.url}`);
    console.log(`                  ${JSON.stringify(JSON.parse(sample.options.body).messages[1].content).slice(0, 120)}…`);
    /* buildRequest is only called for its URL: it needs no key, and the
       options it returns carry one, so they are not printed */
    console.log(`  Gemini request  POST ${gemini.buildRequest({ query: set[0].query, vocabulary: VOCABULARY, systemPrompt: '' }).url}`);
    console.log(`\n  graded fields   ${GRADED_FIELDS.join(', ')}\n`);
    return;
  }

  const missing = names.filter((n) => !String(process.env[PROVIDERS[n].key] || '').trim());
  if (missing.length) {
    console.error(`\n  ${missing.map((n) => PROVIDERS[n].key).join(' and ')} is not set. Set it, or use --only to run one side.\n`);
    process.exit(2);
  }

  if (has('diagnose')) {
    const usable = await diagnose(names);
    process.exit(usable ? 0 : 1);
  }

  const results = {};
  for (const name of names) {
    const provider = PROVIDERS[name];
    const runs = [];
    console.log(`\n${provider.label}`);

    for (let pass = 0; pass < repeat; pass += 1) {
      for (const item of set) {
        const started = Date.now();
        const reading = await provider.call(item.query);
        const ms = Date.now() - started;

        if (!reading.ok) {
          const record = recordFailure(item.query, reading, ms);
          runs.push(record);
          console.log(`  ${pad(`${ms}ms`, 8)}${pad(`${reading.reason}${reading.status ? ` ${reading.status}` : ''}`, 16)}${item.query}`);
          if (record.said) console.log(`            ${pad('', 6)}${String(record.said).slice(0, 140)}`);
          continue;
        }

        const preferences = interpret.shapePreferences(reading.raw);
        const scored = grade(preferences, item.expect);
        runs.push({ query: item.query, ok: true, ms, usage: reading.usage, preferences, grade: scored });
        const mark = scored.wrong.length ? `${scored.correct}/${scored.graded}` : 'all fields';
        console.log(`  ${pad(`${ms}ms`, 8)}${pad(mark, 16)}${item.query}`);
        scored.wrong.forEach(({ field, expected, got }) => {
          console.log(`            ${pad('', 6)}${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
        });
      }
    }

    results[name] = { summary: summarise(name, runs), runs };
  }

  names.forEach((name) => report(results[name].summary));

  let differences = [];
  if (names.length === 2) {
    const [a, b] = names;
    compare(results[a].summary, results[b].summary);
    differences = disagreements(a, results[a].runs, b, results[b].runs, set);
    reportDisagreements(a, b, differences,
      { [a]: results[a].summary.label, [b]: results[b].summary.label });
  }

  const out = flag('out', '');
  if (out) {
    const payload = {
      ranAt: new Date().toISOString(),
      queries: set.length,
      queriesAsked: set,
      repeat,
      vocabulary: VOCABULARY,
      prices: PRICES,
      providers: Object.fromEntries(names.map((n) => [n, results[n]])),
      disagreements: differences
    };
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    console.log(`\n  written to ${out}`);
  }
  console.log('');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('benchmark failed:', gemini.redact(redactOpenAI(err && err.message)));
    process.exit(1);
  });
}

module.exports = { QUERIES, VOCABULARY, GRADED_FIELDS, DISAGREEMENT_FIELDS, PRICES,
  buildOpenAIRequest, grade, fieldMatches, summarise, costPerThousand, percentile, disagreements,
  classify, providerEnvelope, shapeVerdict, headersFrom, recordFailure, diagnoseOne, RETRY_WITHOUT };
