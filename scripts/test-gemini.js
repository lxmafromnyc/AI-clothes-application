#!/usr/bin/env node
/* =========================================================
   Fynd — Gemini interpreter test

   Exercises api/_interpreters/gemini.js and the AI_PROVIDER selection in
   api/interpret.js without touching the network: stubbed replies in the
   shape Google's generateContent endpoint documents, through the
   adapter's request construction, its parsing, and the endpoint's own
   shapePreferences().

   What it is really testing is the promise the adapter is built on:
   nothing downstream can tell which model answered, and nothing
   upstream changes for a deployment that never names one.

     * the request Gemini is sent, down to where the key rides
     * the reply, parsed, and every way it can be malformed
     * an API error, a timeout, and a missing key
     * the key never reaching a log, a response or an error
     * the shaped output being the same object /api/search already reads
     * production — AI_PROVIDER unset — still calling OpenAI and nothing
       else, and a typo in AI_PROVIDER calling nobody

   Usage: node scripts/test-gemini.js
   ========================================================= */

'use strict';

const assert = require('assert');
const gemini = require('../api/_interpreters/gemini');
const registry = require('../api/_interpreters');
const interpret = require('../api/interpret');
const { AI_TOKENS } = require('../api/_plans');
const bench = require('./bench-interpreters');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

/* ---------------------------------------------------------
   Fixtures, in the documented response shape
   --------------------------------------------------------- */

/* Never a real key, and long enough that redact() cannot swallow an
   ordinary word in the test output the way a one-letter key would. */
const FAKE_KEY = 'AIzaSyTEST-not-a-real-key';
const SECRET_KEY = 'AIzaSy-super-secret-key';

const INTENT = {
  categories: ['knit'], colors: ['Black'], occasions: ['Everyday'], fits: ['Oversized'],
  brands: [], styles: [], maxPrice: 80, minPrice: null, season: null, gender: null,
  keywords: ['hoodie']
};

const VOCABULARY = {
  categories: ['knit', 'shirt', 'trousers', 'tee', 'jacket'],
  colors: ['Black', 'White', 'Neutral', 'Blue'],
  occasions: ['Everyday', 'Work', 'Evening'],
  fits: ['Slim', 'Regular', 'Relaxed', 'Oversized'],
  brands: ['UNIQLO', 'ZARA']
};

/* A generateContent reply as the API documents it: one candidate,
   whose content is parts of text, plus Google's own token accounting. */
const reply = (text, usage) => ({
  candidates: [{
    content: { role: 'model', parts: [{ text }] },
    finishReason: 'STOP',
    index: 0
  }],
  usageMetadata: Object.assign({
    promptTokenCount: 310, candidatesTokenCount: 48, totalTokenCount: 358
  }, usage),
  modelVersion: 'gemini-2.5-flash'
});

const okReply = (over) => reply(JSON.stringify(Object.assign({}, INTENT, over)));

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload)
});

/* ---------------------------------------------------------
   Harness
   --------------------------------------------------------- */

function withStubbedFetch(handler, run) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options: options || {} });
    return handler(String(url), options || {}, calls);
  };
  return Promise.resolve(run(calls)).finally(() => { global.fetch = original; });
}

/* Environment is global, and these tests move it about. Every one that
   does runs inside this, so a failure cannot leak a key or a provider
   into the next test. */
function withEnv(env, run) {
  const keys = ['AI_PROVIDER', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_THINKING_BUDGET', 'GEMINI_THINKING_LEVEL', 'OPENAI_API_KEY', 'OPENAI_MODEL'];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; });
  keys.forEach((k) => { delete process.env[k]; });
  Object.keys(env).forEach((k) => { process.env[k] = env[k]; });
  const restore = () => keys.forEach((k) => {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
  return Promise.resolve().then(run).finally(restore);
}

function fakeRes() {
  const res = { statusCode: null, payload: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.payload = payload; return res; };
  res.end = () => res;
  return res;
}

const request = (body) => ({ method: 'POST', headers: { host: 'fynd.test' }, body, on: () => {} });

/* Captures console output so a test can assert what a log line could
   possibly have carried. */
function captureLogs(run) {
  const lines = [];
  const real = { warn: console.warn, error: console.error, log: console.log };
  const grab = (...args) => { lines.push(args.map((a) => String(a)).join(' ')); };
  console.warn = grab; console.error = grab;
  return Promise.resolve().then(run).finally(() => {
    console.warn = real.warn; console.error = real.error; console.log = real.log;
  }).then((value) => ({ value, lines }));
}

const bodyOf = (call) => JSON.parse(call.options.body);

(async () => {
  console.log('\nrequest construction');

  await testAsync('the request goes to the current Gemini model, by POST', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => {
      const { url, options } = gemini.buildRequest({ query: 'a black oversized hoodie under $80', vocabulary: VOCABULARY, systemPrompt: interpret.SYSTEM_PROMPT });
      assert.strictEqual(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
      assert.strictEqual(options.method, 'POST');
      /* gemini-2.5-flash answers a request for it with a 404: it is not
         available to accounts that had not already been using it. */
      assert.strictEqual(gemini.DEFAULT_MODEL, 'gemini-3.6-flash');
    });
  });

  test('the model name alone decides which family’s rules apply', () => {
    ['gemini-3.6-flash', 'gemini-3.6-flash-preview', 'GEMINI-3.6-FLASH'].forEach((m) =>
      assert.strictEqual(gemini.isGemini3(m), true, m));
    ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'].forEach((m) =>
      assert.strictEqual(gemini.isGemini3(m), false, m));
  });

  await testAsync('GEMINI_MODEL overrides the model, and only the model', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: 'gemini-2.5-flash-lite' }, () => {
      const { url } = gemini.buildRequest({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' });
      assert.ok(url.endsWith('/models/gemini-2.5-flash-lite:generateContent'), url);
    });
  });

  await testAsync('the key travels as a header, never in the URL', async () => {
    await withEnv({ GEMINI_API_KEY: 'super-secret-key' }, () => {
      const { url, options } = gemini.buildRequest({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' });
      assert.strictEqual(options.headers['x-goog-api-key'], 'super-secret-key');
      assert.ok(!url.includes('super-secret-key'), 'the key must not be in the URL');
      assert.ok(!url.includes('key='), 'the key must not be a query parameter');
      assert.ok(!options.body.includes('super-secret-key'), 'the key must not be in the body');
    });
  });

  await testAsync('the system prompt is the endpoint’s own, and the request is the user turn', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => {
      const { options } = gemini.buildRequest({ query: 'a black oversized hoodie under $80', vocabulary: VOCABULARY, systemPrompt: interpret.SYSTEM_PROMPT });
      const body = JSON.parse(options.body);
      assert.strictEqual(body.systemInstruction.parts[0].text, interpret.SYSTEM_PROMPT);
      assert.strictEqual(body.contents[0].role, 'user');
      assert.ok(body.contents[0].parts[0].text.includes('a black oversized hoodie under $80'));
      assert.ok(body.contents[0].parts[0].text.includes('"Oversized"'), 'the catalogue vocabulary must be sent');
    });
  });

  const configOf = (env) => withEnv(Object.assign({ GEMINI_API_KEY: FAKE_KEY }, env), () =>
    JSON.parse(gemini.buildRequest({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' }).options.body).generationConfig);

  await testAsync('a 3.x request asks for JSON at minimal thinking, and sends no temperature', async () => {
    const config = await configOf({});
    assert.strictEqual(config.responseMimeType, 'application/json');
    assert.deepStrictEqual(config.thinkingConfig, { thinkingLevel: 'minimal' });
    /* Gemini 3 ignores temperature, and Google's guidance is to leave it
       out rather than send a value the model will discard */
    assert.strictEqual(config.temperature, undefined, 'a 3.x request must not send temperature');
    assert.strictEqual(config.responseSchema, undefined,
      'no schema is sent: it would flatter this provider in the benchmark');
  });

  await testAsync('a 2.5 request keeps the shape that model takes', async () => {
    const config = await configOf({ GEMINI_MODEL: 'gemini-2.5-flash' });
    assert.strictEqual(config.responseMimeType, 'application/json');
    assert.strictEqual(config.temperature, 0, '2.5 honours temperature, and 0 made it repeatable');
    assert.deepStrictEqual(config.thinkingConfig, { thinkingBudget: 0 });
  });

  await testAsync('the two thinking fields never travel together', async () => {
    /* sending thinkingLevel and the legacy thinkingBudget in one request
       is a 400, so exactly one is ever built */
    for (const name of ['gemini-3.6-flash', 'gemini-2.5-flash']) {
      const config = await configOf({ GEMINI_MODEL: name, GEMINI_THINKING_LEVEL: 'high', GEMINI_THINKING_BUDGET: '512' });
      const fields = Object.keys(config.thinkingConfig);
      assert.strictEqual(fields.length, 1, `${name} sent ${fields.join(' and ')}`);
    }
  });

  await testAsync('GEMINI_THINKING_LEVEL is honoured, and a typo is not forwarded', async () => {
    assert.deepStrictEqual(gemini.THINKING_LEVELS, ['minimal', 'low', 'medium', 'high']);
    for (const level of gemini.THINKING_LEVELS) {
      const config = await configOf({ GEMINI_THINKING_LEVEL: level });
      assert.strictEqual(config.thinkingConfig.thinkingLevel, level);
    }
    const typo = await configOf({ GEMINI_THINKING_LEVEL: 'maximum' });
    assert.strictEqual(typo.thinkingConfig.thinkingLevel, 'minimal',
      'the field is an enum, so a typo must fall back rather than become a 400');
    const cased = await configOf({ GEMINI_THINKING_LEVEL: 'HIGH' });
    assert.strictEqual(cased.thinkingConfig.thinkingLevel, 'high');
  });

  await testAsync('GEMINI_THINKING_BUDGET still governs a 2.5 request, and nonsense does not', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY, GEMINI_THINKING_BUDGET: '512' }, () => {
      assert.strictEqual(gemini.thinkingBudget(), 512);
    });
    await withEnv({ GEMINI_API_KEY: FAKE_KEY, GEMINI_THINKING_BUDGET: '-1' }, () => {
      assert.strictEqual(gemini.thinkingBudget(), -1, '-1 asks the model to choose');
    });
    await withEnv({ GEMINI_API_KEY: FAKE_KEY, GEMINI_THINKING_BUDGET: 'lots' }, () => {
      assert.strictEqual(gemini.thinkingBudget(), 0, 'an unreadable budget falls back to off');
    });
  });

  await testAsync('both providers are sent the same prompt', async () => {
    /* The one thing that would make a benchmark meaningless is the two
       models being asked different questions. This captures what
       /api/interpret actually sends OpenAI and holds the adapter's user
       turn identical to it. */
    const query = 'a black oversized hoodie under $80';
    const sent = await withEnv({ OPENAI_API_KEY: 'sk-test' }, () => withStubbedFetch(
      async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify(INTENT) } }], usage: { total_tokens: 100 } }),
      async (calls) => {
        await interpret(request({ query, vocabulary: VOCABULARY }), fakeRes());
        return bodyOf(calls[0]);
      }
    ));

    assert.strictEqual(sent.messages[0].content, interpret.SYSTEM_PROMPT);
    assert.strictEqual(sent.messages[1].content, gemini.userPrompt(query, VOCABULARY),
      'the Gemini adapter must compose the same user message the OpenAI path composes');
    assert.strictEqual(sent.temperature, 0);
  });

  console.log('\nresponse parsing');

  test('a well-formed reply parses into the raw intent', () => {
    const parsed = gemini.parseReply(okReply());
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.raw, INTENT);
  });

  test('a reply split across parts is read whole', () => {
    const split = {
      candidates: [{ content: { parts: [{ text: '{"categories":["shirt"],' }, { text: '"colors":["White"]}' }] } }]
    };
    const parsed = gemini.parseReply(split);
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.raw, { categories: ['shirt'], colors: ['White'] });
  });

  test('a thought part is not concatenated into the answer', () => {
    /* thinking is off and thought summaries are not asked for, so this
       should never arrive — and if it does it must not corrupt the JSON */
    const withThought = {
      candidates: [{ content: { parts: [
        { text: 'The shopper wants something black.', thought: true },
        { text: '{"categories":["tee"],"colors":["Black"]}' }
      ] } }]
    };
    const parsed = gemini.parseReply(withThought);
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.raw, { categories: ['tee'], colors: ['Black'] });
  });

  test('the token counts are Google’s own, not an estimate', () => {
    const parsed = gemini.parseReply(okReply());
    assert.deepStrictEqual(parsed.usage, { input: 310, output: 48, thoughts: 0, total: 358 });
  });

  test('thinking tokens are reported when the model spent any', () => {
    const parsed = gemini.parseReply(reply(JSON.stringify(INTENT), { thoughtsTokenCount: 120, totalTokenCount: 478 }));
    assert.strictEqual(parsed.usage.thoughts, 120);
    assert.strictEqual(parsed.usage.total, 478);
  });

  test('a reply carrying no usage block counts as nothing, never as a guess', () => {
    const parsed = gemini.parseReply({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.usage, { input: 0, output: 0, thoughts: 0, total: 0 });
  });

  console.log('\nmalformed replies');

  const malformed = {
    'prose instead of JSON': reply('Sure! Here is what I understood.'),
    'a fenced code block': reply('```json\n{"categories":["knit"]}\n```'),
    'JSON cut off mid-object': reply('{"categories":["knit"'),
    'a JSON array rather than an object': reply('[{"categories":["knit"]}]'),
    'a bare JSON string': reply('"a black hoodie"'),
    'an empty text part': reply(''),
    'no candidates at all': { candidates: [], usageMetadata: { totalTokenCount: 12 } },
    'a candidate blocked before it wrote anything': { candidates: [{ finishReason: 'SAFETY' }] },
    'nothing whatsoever': {}
  };

  Object.keys(malformed).forEach((label) => {
    test(`${label} is reported malformed, never repaired`, () => {
      const parsed = gemini.parseReply(malformed[label]);
      assert.strictEqual(parsed.ok, false);
      assert.strictEqual(parsed.reason, 'unparseable');
      assert.strictEqual(parsed.raw, undefined, 'nothing may be invented from an unusable reply');
    });
  });

  await testAsync('a malformed reply reaches the caller as 502, not as an empty intent', async () => {
    const res = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, reply('not json at all')),
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie', vocabulary: VOCABULARY }), r);
        return r;
      }
    ));
    assert.strictEqual(res.statusCode, 502);
    assert.deepStrictEqual(res.payload, { error: 'The interpreter returned an unexpected answer.' });
  });

  console.log('\nAPI errors');

  await testAsync('a 429 from Gemini is an upstream failure, and its body is not surfaced', async () => {
    const result = await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(429, { error: { code: 429, message: 'Quota exceeded for requests', status: 'RESOURCE_EXHAUSTED' } }),
      () => gemini.interpret({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' })
    ));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'upstream');
    assert.strictEqual(result.status, 429);
  });

  await testAsync('a 400 reaches the caller as 502 with no upstream detail in it', async () => {
    const res = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }),
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie' }), r);
        return r;
      }
    ));
    assert.strictEqual(res.statusCode, 502);
    assert.deepStrictEqual(res.payload, { error: 'The interpreter is unavailable right now.' });
    assert.ok(!JSON.stringify(res.payload).includes('API key not valid'),
      'an upstream message can echo the request and must not be returned');
  });

  await testAsync('nothing answering is unreachable, not a crash', async () => {
    const result = await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => { throw new Error('socket hang up'); },
      () => gemini.interpret({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' })
    ));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'unreachable');
  });

  await testAsync('a reply that is not JSON at the HTTP level is unparseable, not a crash', async () => {
    const result = await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected token < in JSON'); } }),
      () => gemini.interpret({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' })
    ));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'unparseable');
  });

  await testAsync('the call is bounded by a timeout rather than hanging', async () => {
    assert.ok(Number.isFinite(gemini.REQUEST_TIMEOUT) && gemini.REQUEST_TIMEOUT > 0);
    const result = await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async (url, options) => {
        /* the adapter must pass an abort signal it can actually fire */
        assert.ok(options.signal, 'the request must carry an abort signal');
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
      () => gemini.interpret({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' })
    ));
    assert.strictEqual(result.reason, 'unreachable');
  });

  console.log('\na missing key');

  await testAsync('an unconfigured adapter says so rather than half-working', async () => {
    await withEnv({}, () => {
      assert.strictEqual(gemini.configured(), false);
    });
    await withEnv({ GEMINI_API_KEY: '   ' }, () => {
      assert.strictEqual(gemini.configured(), false, 'a blank key is not a key');
    });
    await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => {
      assert.strictEqual(gemini.configured(), true);
    });
  });

  await testAsync('it refuses to call Gemini at all without a key', async () => {
    const result = await withEnv({}, () => withStubbedFetch(
      async () => { throw new Error('the network must not be touched'); },
      () => gemini.interpret({ query: 'a hoodie', vocabulary: {}, systemPrompt: 'x' })
    ));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'not-configured');
  });

  await testAsync('AI_PROVIDER=gemini with no key is a 503, the same one the page reads locally on', async () => {
    const { value: res, lines } = await captureLogs(() => withEnv({ AI_PROVIDER: 'gemini' }, () => withStubbedFetch(
      async () => { throw new Error('the network must not be touched'); },
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie' }), r);
        return r;
      }
    )));
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.payload, { error: 'Interpreter is not configured.' });
    assert.ok(lines.join(' ').includes('GEMINI_API_KEY=absent'),
      'the log must say which variable is missing, as a state');
  });

  await testAsync('AI_PROVIDER naming nobody selects nobody, rather than quietly using OpenAI', async () => {
    const res = await withEnv({ AI_PROVIDER: 'gemeni', OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => { throw new Error('a typo must not spend anybody’s credit'); },
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie' }), r);
        return r;
      }
    ));
    assert.strictEqual(res.statusCode, 503, 'a typo should be visible, not answered by another provider');
  });

  console.log('\nthe key');

  test('the key never appears in a message that could be logged', () => {
    process.env.GEMINI_API_KEY = SECRET_KEY;
    const message = `POST .../gemini-2.5-flash:generateContent failed for key ${SECRET_KEY}`;
    assert.ok(!gemini.redact(message).includes(SECRET_KEY));
    assert.ok(gemini.redact(message).includes('***'));
    delete process.env.GEMINI_API_KEY;
  });

  test('redaction is safe when there is no key to redact', () => {
    delete process.env.GEMINI_API_KEY;
    assert.strictEqual(gemini.redact('nothing to hide'), 'nothing to hide');
    assert.strictEqual(gemini.redact(undefined), '');
  });

  await testAsync('an upstream body that echoes the key is redacted before it is logged', async () => {
    const { value: res, lines } = await captureLogs(() => withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET_KEY }, () => withStubbedFetch(
      async () => ({
        ok: false,
        status: 403,
        text: async () => `Requests to this API are blocked for key ${SECRET_KEY}`
      }),
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie' }), r);
        return r;
      }
    )));
    const logged = lines.join('\n');
    assert.ok(!logged.includes('AIzaSy-super-secret-key'), `a log line carried the key: ${logged}`);
    assert.ok(logged.includes('***'), 'the redacted stand-in should be what was logged');
    assert.ok(!JSON.stringify(res.payload).includes('AIzaSy'), 'and the response carries none of it');
  });

  await testAsync('a successful reply carries no key material at all', async () => {
    const res = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: SECRET_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, okReply()),
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black oversized hoodie under $80', vocabulary: VOCABULARY }), r);
        return r;
      }
    ));
    const body = JSON.stringify(res.payload);
    assert.ok(!body.includes('AIzaSy'), 'no key');
    assert.ok(!body.includes('x-goog-api-key'), 'no auth header');
    assert.ok(!body.includes('sk-'), 'no OpenAI key either');
  });

  console.log('\nschema compatibility with the Fynd intent');

  /* The exact object /api/search, assets/products.js and the local
     fallback in assets/interpret.js all agree on. */
  const INTENT_KEYS = ['categories', 'colors', 'occasions', 'fits', 'brands', 'styles',
    'maxPrice', 'minPrice', 'season', 'gender', 'keywords'];

  await testAsync('a Gemini reading is shaped into the same object an OpenAI reading is', async () => {
    const query = 'a black oversized hoodie under $80';

    const fromOpenAI = await withEnv({ OPENAI_API_KEY: 'sk-test' }, () => withStubbedFetch(
      async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify(INTENT) } }], usage: { total_tokens: 358 } }),
      async () => {
        const r = fakeRes();
        await interpret(request({ query, vocabulary: VOCABULARY }), r);
        return r.payload;
      }
    ));

    const fromGemini = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, okReply()),
      async () => {
        const r = fakeRes();
        await interpret(request({ query, vocabulary: VOCABULARY }), r);
        return r.payload;
      }
    ));

    assert.deepStrictEqual(Object.keys(fromGemini).sort(), Object.keys(fromOpenAI).sort(),
      'the reply must carry the same top-level fields');
    assert.deepStrictEqual(fromGemini.preferences, fromOpenAI.preferences,
      'the same reading must produce the same intent whichever model returned it');
    assert.deepStrictEqual(Object.keys(fromGemini.preferences), INTENT_KEYS);
    assert.strictEqual(fromGemini.query, query);
    /* the only difference, and the point of the exercise */
    assert.strictEqual(fromOpenAI.source, 'openai');
    assert.strictEqual(fromGemini.source, 'gemini');
  });

  await testAsync('a Gemini reply with junk in it is shaped, not trusted', async () => {
    const junk = {
      categories: 'knit, shirt',            /* a string where an array belongs */
      colors: ['Black', 42, '', '  White '], /* non-strings and blanks */
      maxPrice: '$80',                       /* a price with a symbol */
      minPrice: -5,                          /* a negative budget */
      season: '   ',                         /* blank */
      gender: 'women',
      keywords: null,
      hallucinated: 'a field nothing asked for'
    };
    const res = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, reply(JSON.stringify(junk))),
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie', vocabulary: VOCABULARY }), r);
        return r;
      }
    ));
    assert.deepStrictEqual(res.payload.preferences, {
      categories: ['knit', 'shirt'],
      colors: ['Black', 'White'],
      occasions: [], fits: [], brands: [], styles: [],
      maxPrice: 80,
      minPrice: null,
      season: null,
      gender: 'women',
      keywords: []
    });
    assert.strictEqual(res.payload.preferences.hallucinated, undefined,
      'a field the schema does not have must not reach the frontend');
  });

  console.log('\nwhat did not change');

  await testAsync('production — AI_PROVIDER unset — still calls OpenAI and nothing else', async () => {
    const calls = await withEnv({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, { choices: [{ message: { content: '{}' } }], usage: { total_tokens: 40 } }),
      async (made) => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie' }), r);
        assert.strictEqual(r.statusCode, 200);
        assert.strictEqual(r.payload.source, 'openai');
        return made;
      }
    ));
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.startsWith('https://api.openai.com/'), calls[0].url);
    assert.strictEqual(registry.getInterpreter(), null,
      'with AI_PROVIDER unset the registry must select nobody at all');
  });

  await testAsync('AI_PROVIDER=openai is the same built-in path, not an adapter', async () => {
    const calls = await withEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' }, () => withStubbedFetch(
      async () => jsonResponse(200, { choices: [{ message: { content: '{}' } }], usage: { total_tokens: 40 } }),
      async (made) => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie' }), r);
        assert.strictEqual(r.payload.source, 'openai');
        return made;
      }
    ));
    assert.ok(calls[0].url.startsWith('https://api.openai.com/'));
  });

  await testAsync('a missing OPENAI_API_KEY is still a 503 on the default path', async () => {
    await captureLogs(() => withEnv({}, async () => {
      const r = fakeRes();
      await interpret(request({ query: 'a black hoodie' }), r);
      assert.strictEqual(r.statusCode, 503);
    }));
  });

  console.log('\nvalidation and limits, unchanged on both paths');

  await testAsync('the 400-character query limit applies to Gemini too', async () => {
    const long = `black hoodie ${'x'.repeat(600)}`;
    const sent = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, okReply()),
      async (calls) => {
        await interpret(request({ query: long, vocabulary: {} }), fakeRes());
        return bodyOf(calls[0]).contents[0].parts[0].text;
      }
    ));
    const asked = sent.split("Shopper's request:\n")[1];
    assert.strictEqual(asked.length, interpret.MAX_QUERY);
    assert.strictEqual(interpret.MAX_QUERY, 400, 'the limit itself must not have moved');
  });

  await testAsync('an empty query is refused before Gemini is called', async () => {
    const calls = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => { throw new Error('nothing should be spent on an empty query'); },
      async (made) => {
        const r = fakeRes();
        await interpret(request({ query: '   ' }), r);
        assert.strictEqual(r.statusCode, 400);
        assert.deepStrictEqual(r.payload, { error: 'Say what you are looking for.' });
        return made;
      }
    ));
    assert.strictEqual(calls.length, 0);
  });

  await testAsync('GET is still refused with 405, whichever provider is selected', async () => {
    await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, async () => {
      const r = fakeRes();
      await interpret({ method: 'GET', headers: {}, on: () => {} }, r);
      assert.strictEqual(r.statusCode, 405);
    });
  });

  await testAsync('a Gemini interpretation is metered at the tokens Google reported', async () => {
    const res = await withEnv({ AI_PROVIDER: 'gemini', GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, okReply()),
      async () => {
        const r = fakeRes();
        await interpret(request({ query: 'a black hoodie' }), r);
        return r;
      }
    ));
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.payload.usage, 'the reply carries the usage the meters on screen read');
    assert.strictEqual(res.payload.usage.used, 358, 'the reported total, not an estimate');
    assert.strictEqual(res.payload.usage.metric, AI_TOKENS);
  });

  console.log('\nthe benchmark measures what production actually sends');

  await testAsync('the benchmark builds the same OpenAI request /api/interpret sends', async () => {
    /* A benchmark comparing a request production never makes would be
       worse than no benchmark. This captures the live handler's call and
       holds the script's builder identical to it. */
    const query = 'a black oversized hoodie under $80';
    const live = await withEnv({ OPENAI_API_KEY: 'sk-test' }, () => withStubbedFetch(
      async () => jsonResponse(200, { choices: [{ message: { content: JSON.stringify(INTENT) } }], usage: { total_tokens: 100 } }),
      async (calls) => {
        await interpret(request({ query, vocabulary: bench.VOCABULARY }), fakeRes());
        return calls[0];
      }
    ));

    await withEnv({ OPENAI_API_KEY: 'sk-test' }, () => {
      const built = bench.buildOpenAIRequest({ query, vocabulary: bench.VOCABULARY });
      assert.strictEqual(built.url, live.url);
      assert.deepStrictEqual(JSON.parse(built.options.body), JSON.parse(live.options.body),
        'the benchmark must send the body the endpoint sends, field for field');
      assert.deepStrictEqual(built.options.headers, live.options.headers);
    });
  });

  test('the benchmark asks twenty questions and grades only what a request decides', () => {
    assert.strictEqual(bench.QUERIES.length, 20);
    bench.QUERIES.forEach(({ query, expect }) => {
      assert.ok(typeof query === 'string' && query.trim(), 'every query is a request');
      const fields = Object.keys(expect);
      assert.ok(fields.length, `${query} grades nothing`);
      fields.forEach((f) => assert.ok(bench.GRADED_FIELDS.includes(f), `${query} grades an unknown field: ${f}`));
    });
  });

  test('the grader marks a right answer right and a wrong one wrong', () => {
    const shaped = interpret.shapePreferences({ colors: ['black'], fits: ['Oversized'], maxPrice: 80, minPrice: null });
    const right = bench.grade(shaped, { colors: ['Black'], fits: ['Oversized'], maxPrice: 80, minPrice: null });
    assert.strictEqual(right.correct, 4, 'colour matching is case-insensitive, as the catalogue is');
    assert.deepStrictEqual(right.wrong, []);

    const invented = bench.grade(interpret.shapePreferences({ maxPrice: 40 }), { maxPrice: null });
    assert.strictEqual(invented.correct, 0, 'a budget nobody stated must count as wrong');

    const partial = bench.grade(interpret.shapePreferences({ colors: ['Black', 'White'] }), { colors: ['Black'] });
    assert.strictEqual(partial.correct, 0, 'an extra value in a graded field is a wrong answer, not a near miss');
  });

  test('the grader accepts either reading where the prompt allows two', () => {
    const either = { fits: { oneOf: [['Relaxed'], ['Oversized']] } };
    assert.strictEqual(bench.grade(interpret.shapePreferences({ fits: ['Relaxed'] }), either).correct, 1);
    assert.strictEqual(bench.grade(interpret.shapePreferences({ fits: ['Oversized'] }), either).correct, 1);
    assert.strictEqual(bench.grade(interpret.shapePreferences({ fits: ['Slim'] }), either).correct, 0);
  });

  test('cost per 1,000 searches is the reported tokens at the stated price', () => {
    /* 300 in and 100 out at $0.15/$0.60 per 1M is $0.105 per thousand */
    const cost = bench.costPerThousand({ input: 300, output: 100, thoughts: 0 }, { input: 0.15, output: 0.60 });
    assert.strictEqual(Number(cost.toFixed(4)), 0.105);
    /* thinking tokens are billed as output, so they are costed as output */
    const thinking = bench.costPerThousand({ input: 300, output: 100, thoughts: 200 }, { input: 0.30, output: 2.50 });
    assert.strictEqual(Number(thinking.toFixed(4)), 0.84);
  });

  test('a provider that reports no tokens gets no invented cost', () => {
    const summary = bench.summarise('gemini', [{
      query: 'a black hoodie', ok: true, ms: 100,
      usage: { input: 0, output: 0, thoughts: 0, total: 0 },
      preferences: interpret.shapePreferences({}), grade: { graded: 1, correct: 0, wrong: [] }
    }]);
    assert.strictEqual(summary.tokens, null);
    assert.strictEqual(summary.costPer1000, null, 'a gap is better than a guessed bill');
  });

  test('the rates are counted off the calls, malformed apart from errored', () => {
    const runs = [
      { query: 'a', ok: true, ms: 100, usage: { input: 10, output: 5, thoughts: 0, total: 15 }, preferences: {}, grade: { graded: 2, correct: 2, wrong: [] } },
      { query: 'b', ok: false, reason: 'unparseable', ms: 120 },
      { query: 'c', ok: false, reason: 'upstream', status: 429, ms: 90 },
      { query: 'd', ok: true, ms: 200, usage: { input: 10, output: 5, thoughts: 0, total: 15 }, preferences: {}, grade: { graded: 2, correct: 1, wrong: [{ field: 'colors' }] } }
    ];
    const s = bench.summarise('openai', runs);
    assert.strictEqual(s.validRate, 0.5);
    assert.strictEqual(s.malformedRate, 0.25);
    assert.strictEqual(s.errorRate, 0.25);
    assert.strictEqual(s.fieldAccuracy, 0.75);
    assert.deepStrictEqual(s.wrongByField, { colors: 1 });
    assert.strictEqual(s.latencyMs.max, 200);
  });

  console.log('\nwhere the two models disagree');

  const reading = (query, prefs, over) => Object.assign({
    query, ok: true, ms: 100, usage: { input: 300, output: 40, thoughts: 0, total: 340 },
    preferences: interpret.shapePreferences(prefs), grade: { graded: 0, correct: 0, wrong: [] }
  }, over);

  test('two identical readings produce no disagreement at all', () => {
    const prefs = { colors: ['Black'], categories: ['tee'], maxPrice: 30 };
    const rows = bench.disagreements(
      'openai', [reading('cheap black tee', prefs)],
      'gemini', [reading('cheap black tee', prefs)],
      [{ query: 'cheap black tee', expect: { colors: ['Black'] } }]
    );
    assert.deepStrictEqual(rows, []);
  });

  test('a graded disagreement names the reading that matches the rubric', () => {
    const rows = bench.disagreements(
      'openai', [reading('cheap black tee', { colors: ['Black'], maxPrice: null })],
      'gemini', [reading('cheap black tee', { colors: ['Black'], maxPrice: 25 })],
      [{ query: 'cheap black tee', expect: { maxPrice: null } }]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].fields.length, 1);
    const budget = rows[0].fields[0];
    assert.strictEqual(budget.field, 'maxPrice');
    assert.strictEqual(budget.label, 'budget (max)');
    assert.strictEqual(budget.openai, null);
    assert.strictEqual(budget.gemini, 25);
    assert.strictEqual(budget.matches, 'openai', 'the rubric forbids inventing a budget');
  });

  test('a disagreement where both are wrong crowns neither', () => {
    const rows = bench.disagreements(
      'openai', [reading('q', { colors: ['White'] })],
      'gemini', [reading('q', { colors: ['Blue'] })],
      [{ query: 'q', expect: { colors: ['Black'] } }]
    );
    assert.strictEqual(rows[0].fields[0].matches, null);
    assert.strictEqual(rows[0].fields[0].graded, true);
  });

  test('a disagreement the rubric has no opinion on is shown, not scored', () => {
    const rows = bench.disagreements(
      'openai', [reading('q', { styles: ['Minimal'] })],
      'gemini', [reading('q', { styles: ['Classic'] })],
      [{ query: 'q', expect: { colors: ['Black'] } }]
    );
    assert.strictEqual(rows[0].fields[0].label, 'style');
    assert.strictEqual(rows[0].fields[0].graded, false);
    assert.strictEqual(rows[0].fields[0].matches, null, 'inventing a verdict here would invent a result');
  });

  test('a side that returned nothing usable is reported as that, not as a field', () => {
    const rows = bench.disagreements(
      'openai', [reading('q', { colors: ['Black'] })],
      'gemini', [{ query: 'q', ok: false, reason: 'unparseable', ms: 90 }],
      [{ query: 'q', expect: { colors: ['Black'] } }]
    );
    assert.deepStrictEqual(rows[0].missing, [{ provider: 'gemini', reason: 'unparseable' }]);
    assert.deepStrictEqual(rows[0].fields, []);
  });

  test('the report reads the first pass only, so --repeat does not multiply it', () => {
    const rows = bench.disagreements(
      'openai', [reading('q', { colors: ['Black'] }), reading('q', { colors: ['White'] })],
      'gemini', [reading('q', { colors: ['Black'] }), reading('q', { colors: ['Blue'] })],
      [{ query: 'q', expect: { colors: ['Black'] } }]
    );
    assert.deepStrictEqual(rows, [], 'the first readings agreed, so there is nothing to report');
  });

  test('every field the request named is compared', () => {
    const labels = bench.DISAGREEMENT_FIELDS.map((f) => f.label);
    ['budget (max)', 'budget (min)', 'colour', 'category', 'fit', 'brand', 'occasion', 'style']
      .forEach((label) => assert.ok(labels.includes(label), `${label} is not compared`));
  });

  console.log('\nfailures say what they were');

  /* The bodies these providers actually return, as they document them.
     A failure the tooling cannot name is a failure nobody can fix. */
  const OPENAI_401 = JSON.stringify({ error: { message: 'Incorrect API key provided: sk-abc***. You can find your API key at https://platform.openai.com/account/api-keys.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } });
  const GEMINI_400_KEY = JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
  const GEMINI_400_FIELD = JSON.stringify({ error: { code: 400, message: 'Invalid JSON payload received. Unknown name "thinkingConfig" at \'generation_config\'.', status: 'INVALID_ARGUMENT' } });
  const OPENAI_429 = JSON.stringify({ error: { message: 'Rate limit reached for gpt-4o-mini', type: 'requests', code: 'rate_limit_exceeded' } });
  const PROXY_403 = '<!DOCTYPE html><html><head><title>403 Forbidden</title></head><body>Access denied by policy</body></html>';

  test('a provider error envelope is read; anything else is not mistaken for one', () => {
    const openai = bench.providerEnvelope(OPENAI_401);
    assert.strictEqual(openai.code, 'invalid_api_key');
    assert.strictEqual(openai.type, 'invalid_request_error');
    assert.ok(openai.message.includes('Incorrect API key provided'));

    const google = bench.providerEnvelope(GEMINI_400_KEY);
    assert.strictEqual(google.code, 400);
    assert.strictEqual(google.type, 'INVALID_ARGUMENT');

    assert.strictEqual(bench.providerEnvelope(PROXY_403), null, 'HTML is not an envelope');
    assert.strictEqual(bench.providerEnvelope('Bad Gateway'), null);
    assert.strictEqual(bench.providerEnvelope('{"nope":1}'), null);
    assert.strictEqual(bench.providerEnvelope(undefined), null);
  });

  test('an OpenAI 401 is named as the provider rejecting the key', () => {
    const c = bench.classify({ ok: false, reason: 'upstream', status: 401, detail: OPENAI_401, headers: { 'content-type': 'application/json' } });
    assert.strictEqual(c.reached, 'yes');
    assert.strictEqual(c.authentication, 'rejected');
    assert.strictEqual(c.envelope.code, 'invalid_api_key');
  });

  test('a Gemini bad key — a 400, not a 401 — is still named as a rejected key', () => {
    /* the status alone would read as "the request got past auth", which
       is exactly wrong, and is why the message is read too */
    const c = bench.classify({ ok: false, reason: 'upstream', status: 400, detail: GEMINI_400_KEY, headers: {} });
    assert.strictEqual(c.reached, 'yes');
    assert.strictEqual(c.authentication, 'rejected');
  });

  test('a Gemini 400 about an unknown field is auth accepted, and a request-shape problem', () => {
    const c = bench.classify({ ok: false, reason: 'upstream', status: 400, detail: GEMINI_400_FIELD, headers: {} });
    assert.strictEqual(c.reached, 'yes');
    assert.ok(c.authentication.startsWith('accepted'), c.authentication);
    assert.ok(c.envelope.message.includes('thinkingConfig'));
  });

  test('a rate limit is the provider talking, past authentication', () => {
    const c = bench.classify({ ok: false, reason: 'upstream', status: 429, detail: OPENAI_429, headers: {} });
    assert.strictEqual(c.reached, 'yes');
    assert.ok(c.authentication.startsWith('accepted'));
  });

  test('an HTML 403 is named as something that is not the provider', () => {
    const c = bench.classify({ ok: false, reason: 'upstream', status: 403, detail: PROXY_403, headers: { 'content-type': 'text/html' } });
    assert.strictEqual(c.reached, 'no');
    assert.ok(/never do/.test(c.responder), c.responder);
    assert.strictEqual(c.authentication, 'unknown', 'nothing here proves anything about our key');
  });

  test('a long error is still nameable — the envelope is parsed before truncation', () => {
    /* Google pads an error with a `details` array that runs past any
       sensible log line. Truncating first left a fragment that would not
       parse, and a failure nobody could name. Found by running the
       diagnostic against the live endpoint with an invalid key. */
    const long = JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com', method: 'google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent' } },
          { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'API key not valid. Please pass a valid API key.' },
          { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Google developers console API key', url: 'https://console.developers.google.com/project/_/apiui/credential' }] }]
      }
    });
    assert.ok(long.length > 500, 'the fixture must be longer than the log truncation');

    const envelope = gemini.errorEnvelope(long);
    assert.strictEqual(envelope.message, 'API key not valid. Please pass a valid API key.');
    assert.strictEqual(envelope.type, 'INVALID_ARGUMENT');

    /* and the classifier must use it rather than the truncated body */
    const c = bench.classify({ ok: false, reason: 'upstream', status: 400, error: envelope, detail: long.slice(0, 500), headers: {} });
    assert.strictEqual(c.reached, 'yes');
    assert.strictEqual(c.authentication, 'rejected');
  });

  test('an egress allowlist answering for the provider is named as not the provider', () => {
    /* Observed live, in exactly this shape: a 403 with a text/plain body
       from a proxy. It is an HTTP response, so it classifies as
       `upstream` — which is what makes a whole run of them look like a
       provider problem when it is a network path problem. */
    const c = bench.classify({
      ok: false, reason: 'upstream', status: 403,
      detail: 'Host not in allowlist: api.openai.com. Add this host to your network egress settings to allow access.',
      headers: { 'content-type': 'text/plain' }
    });
    assert.strictEqual(c.reached, 'no');
    assert.ok(/text\/plain/.test(c.responder), c.responder);
    assert.strictEqual(c.authentication, 'unknown', 'nothing here proves anything about the key');
  });

  test('a 407 is named as a proxy in the way', () => {
    const c = bench.classify({ ok: false, reason: 'upstream', status: 407, detail: 'Proxy Authentication Required', headers: {} });
    assert.strictEqual(c.reached, 'no');
    assert.ok(/proxy/i.test(c.responder));
  });

  test('a connection that never landed is not reported as an upstream error', () => {
    const c = bench.classify({ ok: false, reason: 'unreachable', detail: 'fetch failed' });
    assert.strictEqual(c.reached, 'no');
    assert.strictEqual(c.status, null);
  });

  test('a success is the only thing that proves authentication worked', () => {
    const c = bench.classify({ ok: true, status: 200, headers: {} });
    assert.strictEqual(c.reached, 'yes');
    assert.strictEqual(c.authentication, 'accepted');
  });

  test('a 200 that could not be read is a shape problem, not an API error', () => {
    const v = bench.shapeVerdict({ ok: false, reason: 'unparseable', status: 200, detail: 'Sure! Here is the intent' });
    assert.strictEqual(v.asExpected, false);
    assert.ok(v.note.includes('could not be read'));
    assert.strictEqual(bench.shapeVerdict({ ok: true }).asExpected, true);
    assert.strictEqual(bench.shapeVerdict({ ok: false, reason: 'upstream', status: 500 }).asExpected, null);
  });

  test('a recorded failure keeps the status, the message and what it proved', () => {
    const record = bench.recordFailure('a black hoodie',
      { ok: false, reason: 'upstream', status: 401, detail: OPENAI_401, headers: { 'content-type': 'application/json' } }, 240);
    assert.strictEqual(record.status, 401);
    assert.ok(record.detail.includes('Incorrect API key'), 'the body must survive into the run record');
    assert.strictEqual(record.reached, 'yes');
    assert.strictEqual(record.authentication, 'rejected');
    assert.ok(record.said.includes('Incorrect API key'));
    assert.deepStrictEqual(record.headers, { 'content-type': 'application/json' });
  });

  test('a run of identical failures reads as one problem, with an example', () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      bench.recordFailure(`query ${i}`, { ok: false, reason: 'upstream', status: 401, detail: OPENAI_401, headers: {} }, 200));
    const summary = bench.summarise('openai', runs);
    assert.strictEqual(summary.errorRate, 1);
    assert.strictEqual(summary.errorsByKind.length, 1);
    assert.strictEqual(summary.errorsByKind[0].kind, 'upstream 401');
    assert.strictEqual(summary.errorsByKind[0].count, 20);
    assert.ok(summary.errorsByKind[0].example.includes('Incorrect API key'));
    assert.ok(summary.errors[0].detail, 'the JSON must carry the detail, not just the count');
    assert.strictEqual(summary.errors[0].authentication, 'rejected');
  });

  console.log('\nthe smoke test');

  test('the retry drops exactly the field most likely to have caused a 400', () => {
    assert.strictEqual(bench.RETRY_WITHOUT.openai.field, 'response_format');
    assert.strictEqual(bench.RETRY_WITHOUT.gemini.field, 'generationConfig.thinkingConfig');

    const normal = JSON.parse(bench.buildOpenAIRequest({ query: 'q', vocabulary: {} }).options.body);
    assert.deepStrictEqual(normal.response_format, { type: 'json_object' }, 'the default must be untouched');
    const retried = JSON.parse(bench.buildOpenAIRequest({ query: 'q', vocabulary: {}, jsonMode: false }).options.body);
    assert.strictEqual(retried.response_format, undefined);
    assert.deepStrictEqual(retried.messages, normal.messages, 'and nothing else may change');
  });

  await testAsync('omitting thinkingConfig omits only that, and is not the default', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => {
      const normal = JSON.parse(gemini.buildRequest({ query: 'q', vocabulary: {}, systemPrompt: 'x' }).options.body);
      assert.deepStrictEqual(normal.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });

      const without = JSON.parse(gemini.buildRequest({ query: 'q', vocabulary: {}, systemPrompt: 'x', thinking: null }).options.body);
      assert.strictEqual(without.generationConfig.thinkingConfig, undefined);
      assert.strictEqual(without.generationConfig.responseMimeType, 'application/json', 'JSON mode still asked for');
      assert.deepStrictEqual(Object.keys(without.generationConfig), ['responseMimeType'],
        'nothing else may change when the field is dropped');
    });
  });

  await testAsync('a smoke test is one call, and a 400 costs exactly one more', async () => {
    const calls = await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async () => jsonResponse(200, okReply()),
      async (made) => {
        const v = await bench.diagnoseOne('gemini', 'a black oversized hoodie under $80');
        assert.strictEqual(v.reading.ok, true);
        assert.strictEqual(v.retry, undefined, 'a success must not cost a second call');
        return made;
      }
    ));
    assert.strictEqual(calls.length, 1, 'exactly one call');

    const retried = await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => withStubbedFetch(
      async (url, options) => {
        const sent = JSON.parse(options.body);
        /* the second call is the one without thinkingConfig, and it works */
        return sent.generationConfig.thinkingConfig
          ? { ok: false, status: 400, text: async () => GEMINI_400_FIELD, headers: { get: () => null } }
          : jsonResponse(200, okReply());
      },
      async (made) => {
        const v = await bench.diagnoseOne('gemini', 'a black oversized hoodie under $80');
        assert.strictEqual(v.reading.status, 400);
        assert.strictEqual(v.retry.without, 'generationConfig.thinkingConfig');
        assert.strictEqual(v.retry.reading.ok, true, 'the retry identifies the field as the cause');
        return made;
      }
    ));
    assert.strictEqual(retried.length, 2, 'one call, then one more to name the 400');
  });

  await testAsync('the diagnostic reports a 401 without ever printing the key', async () => {
    const { value, lines } = await captureLogs(() => withEnv({ GEMINI_API_KEY: SECRET_KEY }, () => withStubbedFetch(
      async () => ({
        ok: false,
        status: 401,
        text: async () => `{"error":{"code":401,"message":"Invalid authentication for key ${SECRET_KEY}","status":"UNAUTHENTICATED"}}`,
        headers: { get: (name) => (name === 'content-type' ? 'application/json' : null) }
      }),
      async () => bench.diagnoseOne('gemini', 'a black hoodie')
    )));
    assert.strictEqual(value.classified.authentication, 'rejected');
    assert.strictEqual(value.classified.reached, 'yes');
    assert.ok(!JSON.stringify(value).includes(SECRET_KEY), 'the key must not survive into the diagnosis');
    assert.ok(!lines.join('\n').includes(SECRET_KEY), 'nor into anything printed');
  });

  console.log('\nwhich model is being called, and why');

  /* A model name on its own cannot tell you whether the default moved,
     an environment variable is overriding it, or the checkout is behind.
     Reporting only the name sent a debugging session looking in the
     wrong one of those three. */

  const withArgv = (args, run) => {
    const saved = process.argv;
    process.argv = ['node', 'bench-interpreters.js', ...args];
    try { return run(); } finally { process.argv = saved; }
  };

  await testAsync('with nothing overriding it, the model is the adapter default', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY }, () => withArgv([], () => {
      const p = bench.modelProvenance('gemini');
      assert.strictEqual(p.value, 'gemini-3.6-flash');
      assert.strictEqual(p.overridden, false);
      assert.ok(p.from.includes('api/_interpreters/gemini.js'), p.from);
    }));
  });

  await testAsync('GEMINI_MODEL is named as the thing overriding the default', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: 'gemini-2.5-flash' }, () => withArgv([], () => {
      const p = bench.modelProvenance('gemini');
      assert.strictEqual(p.value, 'gemini-2.5-flash');
      assert.strictEqual(p.overridden, true);
      assert.ok(p.from.includes('GEMINI_MODEL'), p.from);
    }));
  });

  await testAsync('--gemini-model= is named, and outranks the environment', async () => {
    await withEnv({ GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: 'gemini-2.5-flash' }, () =>
      withArgv(['--gemini-model=gemini-3.6-flash-preview'], () => {
        const p = bench.modelProvenance('gemini');
        assert.strictEqual(p.value, 'gemini-3.6-flash-preview');
        assert.strictEqual(p.overridden, true);
        assert.ok(p.from.includes('--gemini-model='), p.from);
      }));
  });

  await testAsync('the same question is answerable for OpenAI', async () => {
    await withEnv({ OPENAI_API_KEY: 'sk-test' }, () => withArgv([], () => {
      assert.strictEqual(bench.modelProvenance('openai').overridden, false);
    }));
    await withEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-4o' }, () => withArgv([], () => {
      const p = bench.modelProvenance('openai');
      assert.strictEqual(p.value, 'gpt-4o');
      assert.ok(p.from.includes('OPENAI_MODEL'), p.from);
    }));
  });

  test('a withdrawn model is one the tooling can name, with its replacement', () => {
    assert.strictEqual(bench.RETIRED_MODELS['gemini-2.5-flash'], 'gemini-3.6-flash');
    assert.strictEqual(bench.RETIRED_MODELS[gemini.DEFAULT_MODEL], undefined,
      'the default must never be a model the provider has withdrawn');
  });

  test('the running commit is reported, or reported as unknown, never guessed', () => {
    const state = bench.checkoutState();
    if (state === null) return;   /* not a git checkout: saying nothing is correct */
    assert.ok(/^[0-9a-f]{7,40}$/.test(state.commit), state.commit);
    assert.strictEqual(typeof state.dirty, 'boolean');
  });

  console.log('\nthe experiment stays removable');

  test('nothing in api/ refers to Gemini outside the marked block', () => {
    const fs = require('fs');
    const path = require('path');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '_interpreters' ? [] : walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
    const offenders = walk(path.join(__dirname, '..', 'api'))
      .filter((file) => file !== path.join(__dirname, '..', 'api', 'interpret.js'))
      .filter((file) => /gemini/i.test(fs.readFileSync(file, 'utf8')))
      /* the env report names the variable so a 503 can be explained; it
         holds no logic and reading a state is not a dependency */
      .filter((file) => path.basename(file) !== '_env-report.js');
    assert.deepStrictEqual(offenders, [],
      'removing api/_interpreters/ must not break anything but api/interpret.js');
  });

  test('nothing under assets/ knows a second provider exists', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'assets');
    const leaked = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => /gemini|GEMINI_API_KEY|AI_PROVIDER/i.test(fs.readFileSync(path.join(dir, name), 'utf8')));
    assert.deepStrictEqual(leaked, [], 'the browser must learn nothing about the server’s providers');
  });

  test('the interpreter modules are helpers, not routed endpoints', () => {
    const path = require('path');
    /* Vercel routes every file under api/ except underscore-prefixed
       paths. api/_interpreters/ must stay one, or these two modules
       become endpoints that answer nothing and cost two of the twelve
       function slots. See scripts/test-pipeline.js. */
    assert.ok(path.basename(path.dirname(require.resolve('../api/_interpreters'))).startsWith('_'));
    assert.strictEqual(typeof registry.getInterpreter, 'function');
    assert.strictEqual(typeof gemini.interpret, 'function');
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
