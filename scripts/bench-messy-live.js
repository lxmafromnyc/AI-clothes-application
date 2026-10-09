#!/usr/bin/env node
/* =========================================================
   Fynd — messy-search LIVE benchmark

   The requests in scripts/bench-messy-queries.js — 99 messy ones
   (misspelt, run together, abbreviated, half-finished, slangy,
   contradicting themselves, "but not a coat", "to wear with jeans",
   sizes, several attributes at once, a few nothing honest can answer)
   and 8 plain ones as a control — put through Fynd's real search path,
   with real provider results. No stand-ins: a run costs real searches
   and real tokens.

   Two ways to run it:

   IN-PROCESS (default) — each checkout in a process of its own:
     the page's own scripts (assets/interpret.js, assets/search.js) read
       the request exactly as the browser does,
     the page's call to /api/interpret is answered by that checkout's
       real /api/interpret handler (503 when no interpreter is
       configured, and the page then falls back to its local reader),
     the body the page posts goes to that checkout's real /api/search
       handler: allowance, provider, offer lookups, cache, deadline,
       verification gate, garment filter, ranking — the HTTP status and
       JSON body the browser would get.
     Each request is a new anonymous visitor (no cookie), so the Free
     allowance of one visitor never stops a run. The cache and the
     allowance counters live in memory unless --store env is given, so
     a run never writes into a configured Redis.

       node --env-file=.env.local scripts/bench-messy-live.js \
         --roots before=../fynd-main,after=. --out-dir bench-results/run1

   AGAINST RUNNING SERVERS — the page's two requests go over HTTP to a
   server, `vercel dev` or a deployment, with whatever environment it
   runs with:

       node scripts/bench-messy-live.js --servers after=http://localhost:3005

     Interpretation is graded on the phrase this checkout's query
     builder makes of the posted body (a server does not say what it
     asked); provider calls are read off the server's own diagnostics;
     what the garment filter removed is not visible over HTTP.

   Checkouts run interleaved, one request on each, alternating which
   goes first, so both meet the provider in the same minute.

   Output: --out-dir (default bench-results/messy-live-<time>/) gets
     results.json   every request: HTTP status, latencies, sanitized
                    error, the phrase asked, provider calls, the products
                    shown and how each was graded
     summary.md     the same, for a person
   bench-results/ is ignored by git.

   Other flags: --reader local (the page's local reader even where an
   interpreter is configured), --set messy|plain|all, --only "ID|query",
   --types negation,size, --json (print the summary as JSON),
   --retries N (default 1) and --retry-delay-ms N (default 5000): a 502
   that is rate-limited, a server error, a network failure or a timeout
   is tried again, N times at most; a refused key, a bad request or
   spent credits never are.

   Exit status: 2 when no search succeeded on a checkout (the record
   then measures interpretation only, and says so), 1 when the judged
   checkout crashed, showed something ruled out or made more than one
   provider search per request, 0 otherwise.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { QUERIES, TYPES } = require('./bench-messy-queries');

const HERE = path.resolve(__dirname, '..');
const CASES = QUERIES;

/* ---------- grading: pure, the same for every checkout ---------- */

const FAMILIES = {
  black: /\b(black|jet|onyx|noir)\b/,
  grey: /\b(gr[ae]y|heather(ed)?|charcoal|ash|silver|slate|graphite|smoke)\b/,
  white: /\b(white|ivory|cream|off.?white|ecru|optic)\b/,
  navy: /\b(navy|midnight|dark blue)\b/,
  blue: /\b(blue|navy|indigo|cobalt|sky|denim blue)\b/,
  red: /\b(red|burgundy|maroon|crimson|wine|scarlet|cherry)\b/,
  green: /\b(green|olive|sage|forest|mint|emerald|khaki green)\b/,
  brown: /\b(brown|tan|cognac|chocolate|camel|chestnut|mocha|espresso|coffee|walnut|tobacco)\b/,
  beige: /\b(beige|khaki|tan|sand|stone|natural|oatmeal|camel|taupe|cream|ecru)\b/,
  pink: /\b(pink|blush|rose|fuchsia|magenta)\b/,
  purple: /\b(purple|lilac|lavender|violet|plum)\b/,
  yellow: /\b(yellow|mustard|lemon|gold)\b/,
  orange: /\b(orange|rust|coral|burnt orange)\b/
};
const ANY_COLOUR = /\b(black|white|gr[ae]y|navy|blue|red|green|pink|purple|yellow|orange|brown|beige|khaki|tan|cream|ivory|olive|burgundy|maroon|charcoal|camel|lilac|lavender|teal|mustard|rust|coral|sage|fuchsia|magenta)\b/g;

/* the catalogue's own colour families, which the served interpreter is
   told to answer in: one of these is invented only when it stands for
   none of the colours stated */
const CATALOGUE_FAMILIES = {
  neutral: ['grey', 'beige', 'white', 'black'], earth: ['brown', 'beige', 'green', 'red', 'yellow', 'orange'],
  bright: ['red', 'pink', 'yellow', 'orange', 'purple'], pastel: ['pink', 'purple', 'blue', 'green', 'yellow'],
  blue: ['blue', 'navy'], green: ['green'], black: ['black'], white: ['white']
};

const low = (s) => String(s || '').toLowerCase();
const listOf = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function matches(rule, title) {
  if (!rule) return false;
  if (typeof rule === 'function') return Boolean(rule(title));
  if (Array.isArray(rule)) return rule.every((one) => matches(one, title));
  return rule.test(title);
}

function familyOf(word) {
  const w = low(word);
  return Object.keys(FAMILIES).filter((name) => FAMILIES[name].test(w));
}

/* a title that names colours, none of them one the request stated */
function colourConflict(title, colours) {
  if (!colours || !colours.length) return false;
  const named = title.match(ANY_COLOUR) || [];
  if (!named.length) return false;
  return !colours.some((family) => FAMILIES[family] && FAMILIES[family].test(title));
}

function genderConflict(title, gender) {
  if (!gender) return false;
  const saysWomen = /\b(women'?s?|womens|ladies|ladies'|female|girls?)\b/.test(title);
  const saysMen = /\b(men'?s?|mens|male|boys?)\b/.test(title);
  const unisex = /\bunisex\b/.test(title);
  if (unisex) return false;
  return gender === 'women' ? saysMen && !saysWomen : gender === 'men' ? saysWomen && !saysMen : false;
}

/* what the reading recorded as ruled out, whichever checkout read it:
   garments (excluded, and their words in drop) and modifiers (without).
   Not `avoid`, which only orders things lower, and not the garments it
   is worn with, which are not searched but are not ruled out either. */
function recordedExclusions(intent) {
  const c = (intent && intent.concepts) || {};
  return [...new Set(listOf(c.drop).concat(listOf(c.without), listOf(c.excluded)).map(low).filter(Boolean))];
}

const genderOf = (word) => {
  const w = low(word);
  if (/^(women|woman|womens|women's|female|ladies|lady|girls?)$/.test(w)) return 'women';
  if (/^(men|man|mens|men's|male|guys?|boys?)$/.test(w)) return 'men';
  return w || null;
};

function gradeReading(c, observed) {
  const intent = observed.intent || {};
  const asked = low(observed.asked);
  const recorded = recordedExclusions(intent);
  const notes = [];

  const targetOk = c.target.test(asked);
  if (!targetOk) notes.push(`asked "${observed.asked}", not the target`);
  const contextOk = !(c.notAsked && c.notAsked.test(asked));
  if (!contextOk) notes.push(`asked for "${(asked.match(c.notAsked) || [''])[0]}", which the request did not want searched`);

  let exclusionOk = true;
  if (c.exclude) {
    const kept = recorded.some((word) => c.exclude.test(word) || (c.mayRule && c.mayRule.test(word)));
    if (!kept) { exclusionOk = false; notes.push('the exclusion was not recorded'); }
    if (c.exclude.test(asked)) { exclusionOk = false; notes.push('the exclusion was searched for'); }
  }
  /* nothing ruled out that the request did not rule out */
  const stray = recorded.filter((word) => !(c.exclude && c.exclude.test(word)) && !(c.mayRule && c.mayRule.test(word)));
  if (stray.length) { exclusionOk = false; notes.push(`ruled out "${stray.join('", "')}", which the request did not`); }

  /* stated constraints kept, nothing unstated added. A colour is kept
     when the search asks for it; a catalogue family ("Bright") alone does
     not put "red" in front of the provider */
  const colours = c.colours || [];
  let constraintsOk = true;
  const covers = (one) => {
    const name = low(one);
    if (CATALOGUE_FAMILIES[name] && !FAMILIES[name]) return CATALOGUE_FAMILIES[name];
    return familyOf(one).concat(CATALOGUE_FAMILIES[name] || []);
  };
  const conceptColours = listOf(intent.concepts && intent.concepts.colors);
  const readColours = listOf(intent.colors).concat(conceptColours, asked.match(ANY_COLOUR) || []);
  const invented = readColours.filter((one) => !covers(one).some((f) => colours.includes(f)));
  if (invented.length) { constraintsOk = false; notes.push(`colour "${[...new Set(invented)].join('", "')}" was never stated`); }
  const searched = (asked.match(ANY_COLOUR) || []).concat(conceptColours);
  for (const family of colours) {
    if (!searched.some((one) => familyOf(one).includes(family))) { constraintsOk = false; notes.push(`the stated ${family} is not searched`); }
  }
  const wantMax = c.maxPrice == null ? null : c.maxPrice;
  if ((intent.maxPrice || null) !== wantMax) { constraintsOk = false; notes.push(`budget ${intent.maxPrice || 'none'}, stated ${wantMax || 'none'}`); }
  if (intent.minPrice) { constraintsOk = false; notes.push(`a minimum price of ${intent.minPrice} was never stated`); }
  const gender = genderOf(intent.gender || (intent.concepts && intent.concepts.gender) || '');
  const said = c.gender || null;
  if (gender && !said) { constraintsOk = false; notes.push(`gender "${gender}" was never stated`); }
  if (said && !gender && !asked.split(/\s+/).some((w) => genderOf(w) === said)) { constraintsOk = false; notes.push(`the stated ${said} was lost`); }
  if (gender && said && gender !== said) { constraintsOk = false; notes.push(`gender "${gender}", stated ${said}`); }
  const brands = listOf(intent.brands).map(low).filter((b) => !(c.brands || []).includes(b));
  if (brands.length) { constraintsOk = false; notes.push(`brand "${brands.join('", "')}" was never stated`); }

  return {
    correct: targetOk && contextOk && exclusionOk && constraintsOk,
    targetOk: targetOk && contextOk,
    exclusionOk,
    constraintsOk,
    notes
  };
}

function gradeProduct(c, product) {
  const title = low(product.name);
  const excluded = Boolean(c.exclude && c.exclude.test(title));
  const colour = colourConflict(title, c.colours);
  const gender = genderConflict(title, c.gender);
  const over = c.maxPrice != null && product.price > c.maxPrice;
  const under = c.minPrice != null && product.price < c.minPrice;
  const wrong = excluded || colour || gender || matches(c.wrong, title);
  const relevant = !wrong && matches(c.relevant, title);
  /* plainly what was asked, and says so about every detail stated */
  const statesColours = (c.colours || []).every((family) => FAMILIES[family] && FAMILIES[family].test(title));
  const strong = relevant && statesColours && (!c.strong || matches(c.strong, title));
  const hard = [];
  if (excluded) hard.push('ruled out');
  if (colour) hard.push('another colour');
  if (gender) hard.push('the other gender');
  if (over) hard.push(`over the stated $${c.maxPrice}`);
  if (under) hard.push(`under the stated $${c.minPrice}`);
  return { relevant, strong, wrong, excluded, hard };
}

function grade(c, observed) {
  const reading = gradeReading(c, observed);
  const products = (observed.products || []).map((p) => Object.assign({}, p, gradeProduct(c, p)));
  const top = (k) => products.slice(0, k);
  const removed = (observed.removed || []).map((r) => Object.assign({}, r, gradeProduct(c, { name: r.name, price: 0 })));
  return {
    reading,
    /* a request nothing honest can answer: zero products is the right answer */
    noneExpected: Boolean(c.expectNone),
    noneCorrect: c.expectNone ? products.length === 0 : null,
    relevantAt4: top(4).filter((p) => p.relevant).length / 4,
    relevantAt8: top(8).filter((p) => p.relevant).length / 8,
    strongAt8: top(8).filter((p) => p.strong).length,
    wrongAt8: top(8).filter((p) => p.wrong).length,
    hardViolations: products.reduce((n, p) => n + p.hard.length, 0),
    exclusionViolations: products.filter((p) => p.excluded).length,
    wronglyRemoved: removed.filter((r) => r.relevant).length,
    products,
    removed
  };
}

/* ---------- a worker: one checkout, in a process of its own ---------- */

const STORE_VARS = ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const INTERPRETER_HOSTS = new Set(['api.openai.com', 'generativelanguage.googleapis.com']);

/* Whose failure a non-200 is, so a provider having a bad minute, an
   environment with nothing configured and a fault of Fynd's own are
   never counted as the same thing — and none of them as a search. */
function failureClass(status, body) {
  const b = body || {};
  if (status === 200) return null;
  if (status === 503) return 'environment: no product source configured';
  /* the source answered, and no seller's price came back in time */
  if (status === 502 && b.stage === 'offers') return 'provider: offer lookups timed out';
  if (status === 502) return `provider: ${b.kind || b.reason || 'failed'}`;
  if (status === 500) return `fynd: ${b.stage || 'internal'}`;
  if (status === 429) return 'allowance: over limit';
  if (!status) return 'unreachable: no HTTP answer';
  return `http ${status}`;
}

/* what may be kept of a failure: the route's own classification, never a message from upstream */
const sanitizedFailure = (status, body) => (status === 200 || !body ? null : {
  class: failureClass(status, body),
  reason: body.reason || null, kind: body.kind || null, upstreamStatus: body.upstreamStatus === undefined ? null : body.upstreamStatus,
  stage: body.stage || null, error: typeof body.error === 'string' ? body.error.slice(0, 120) : null
});

/* a provider failure that may pass: worth one more try after a pause.
   Never a refused key, a bad request or spent credits, which would only
   fail again and spend more of the allowance doing it */
const TRANSIENT = new Set(['rate-limited', 'rate-limited-or-credits', 'server-error', 'network', 'timeout']);
const transient = (observed) => Boolean(observed && observed.status === 502 && observed.failure && TRANSIENT.has(observed.failure.kind));

function worker(root, reader, store, server) {
  if (store !== 'env') STORE_VARS.forEach((name) => { delete process.env[name]; });
  const at = (...parts) => path.join(root, ...parts);

  /* What the garment filter removed, observed — never changed: the
     wrapper hands back exactly what the filter returned. Installed
     before the route is loaded, because the route takes the function
     when it loads. */
  let removed = [];
  const filter = require(at('api', '_providers', 'garment-filter'));
  const realFilter = filter.withoutContradictions;
  filter.withoutContradictions = (...args) => {
    const out = realFilter(...args);
    removed = (out && out.removed ? out.removed : []).map((r) => ({ name: r.name, kind: r.kind, why: r.why, position: r.position }));
    return out;
  };
  const searchRoute = require(at('api', 'search'));
  const interpretRoute = require(at('api', 'interpret'));
  const { queryFrom } = require(at('api', '_providers', 'query'));
  const cache = require(at('api', '_cache'));
  /* the q the provider is sent for an intent, when it was not seen on
     the wire: the adapter's own builder where the checkout has one, and
     otherwise what its search() sends — the phrase, or "clothing" */
  const adapter = require(at('api', '_providers', 'openwebninja'));
  const providerQ = (intent) => (typeof adapter.searchRequest === 'function'
    ? adapter.searchRequest(intent, { limit: 12 }).params.get('q')
    : queryFrom(intent) || 'clothing');

  /* the page, exactly as the browser loads it */
  require(at('assets', 'products.js'));
  const catalogue = at('assets', 'catalog.js');
  if (fs.existsSync(catalogue)) {
    require('vm').runInThisContext(`${fs.readFileSync(catalogue, 'utf8')}\n;globalThis.__fyndDemoProducts = typeof DEMO_PRODUCTS === 'undefined' ? [] : DEMO_PRODUCTS;`, { filename: catalogue });
  }
  for (const file of ['interpret.js', 'search.js']) require(at('assets', file));
  const loaded = Promise.resolve(globalThis.Products.load(globalThis.__fyndDemoProducts || []));
  const vocabulary = () => {
    const Products = globalThis.Products;
    const f = Products.facets();
    return {
      categories: [...new Set(Products.all().map((p) => p.category).filter(Boolean))],
      colors: [...f.colors.keys()], occasions: [...f.occasions.keys()], fits: [...f.fits.keys()],
      brands: [...f.brands.keys()], styles: [...f.styles.keys()]
    };
  };

  const realFetch = globalThis.fetch;
  const base = server ? server.replace(/\/+$/, '') : 'http://page.invalid';
  globalThis.FINDWEAR_API = `${base}/api/interpret`;
  globalThis.FINDWEAR_SEARCH_API = `${base}/api/search`;

  /* one call to a route handler, as a new anonymous visitor */
  async function route(handler, body) {
    const res = { statusCode: 0, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.getHeader = (k) => res.headers[k];
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.end = () => res;
    await handler({ method: 'POST', headers: { 'content-type': 'application/json' }, body, on: () => {} }, res);
    return res;
  }
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this; } });

  async function one(query) {
    await loaded;
    cache.reset();
    removed = [];
    const wire = { interpreter: 0, searches: [], offers: 0, other: 0 };
    const seen = { interpret: null, search: null };
    let posted = null;

    globalThis.fetch = async (input, init) => {
      const href = String(input && input.url ? input.url : input);
      /* the page's two requests: to the route handlers in this process, or over HTTP to the server */
      if (href === globalThis.FINDWEAR_API || href === globalThis.FINDWEAR_SEARCH_API) {
        const which = href === globalThis.FINDWEAR_API ? 'interpret' : 'search';
        const body = JSON.parse(init.body);
        if (which === 'interpret' && reader === 'local') {
          seen.interpret = { status: 503, ms: 0, skipped: true };
          return reply(503, { error: 'Interpreter is not configured.' });
        }
        if (which === 'search') posted = body;
        const startedAt = Date.now();
        let status;
        let answer;
        if (server) {
          try {
            const response = await realFetch(href, init);
            status = response.status;
            answer = await response.json().catch(() => null);
          } catch (err) {
            status = 0;
            answer = { error: `could not reach the server: ${String(err && err.cause && err.cause.code || err && err.message).slice(0, 60)}` };
          }
        } else {
          const res = await route(which === 'interpret' ? interpretRoute : searchRoute, body);
          status = res.statusCode;
          answer = res.body;
        }
        seen[which] = { status, body: answer, ms: Date.now() - startedAt };
        return reply(status, answer);
      }
      let url;
      try { url = new URL(href); } catch (err) { wire.other += 1; return realFetch(input, init); }
      if (INTERPRETER_HOSTS.has(url.hostname)) wire.interpreter += 1;
      else if (/\/search$|\/shopping$|\/search\.json$/.test(url.pathname)) wire.searches.push({ host: url.hostname, q: url.searchParams.get('q') });
      else if (/offers/.test(url.pathname)) wire.offers += 1;
      else wire.other += 1;
      return realFetch(input, init);
    };

    const startedAt = Date.now();
    let outcome;
    let crashed = null;
    try {
      outcome = await globalThis.Interpreter.interpret(query, vocabulary());
      await globalThis.ProductSearch.find(outcome.preferences, undefined, []);
    } catch (err) {
      crashed = String(err && err.message).split('\n')[0].slice(0, 160);
    } finally {
      globalThis.fetch = realFetch;
    }
    const totalMs = Date.now() - startedAt;
    const intent = searchRoute.shapeIntent(posted ? posted.intent : {});
    const s = seen.search || {};
    const body = s.body || {};
    const d = body.diagnostics || {};
    const fromServer = Boolean(server);
    const products = Array.isArray(body.products) ? body.products : [];
    return {
      query,
      crashed,
      interpreter: outcome ? outcome.source : null,
      interpretStatus: seen.interpret ? seen.interpret.status : null,
      interpretMs: seen.interpret ? seen.interpret.ms : null,
      status: s.status === undefined ? null : s.status,
      failure: sanitizedFailure(s.status, body),
      searchMs: s.ms === undefined ? null : s.ms,
      totalMs,
      intent,
      /* the phrase the provider was asked: off the wire in this process; built from the posted body for a server */
      asked: !fromServer && wire.searches[0] && wire.searches[0].q != null ? wire.searches[0].q : providerQ(intent),
      askedFrom: !fromServer && wire.searches[0] && wire.searches[0].q != null ? 'wire' : fromServer ? 'built from the posted body' : 'built (served from cache)',
      providerSearches: fromServer ? (d.cache && d.cache.servedFromCache ? 0 : (s.status === 200 || s.status === 502 ? 1 : 0)) : wire.searches.length,
      /* searches per provider host, off the wire (null over HTTP) */
      searchesBySource: fromServer ? null : wire.searches.reduce((by, w) => Object.assign(by, { [w.host]: (by[w.host] || 0) + 1 }), {}),
      /* the configured source refused for want of searches and the route
         asked its fallback — the one case with more than one source asked */
      fellBack: Boolean(d.fellBackFrom) || (!fromServer && new Set(wire.searches.map((w) => w.host)).size > 1),
      offerLookups: fromServer ? Number(d.offers && d.offers.lookupsMade) || 0 : wire.offers,
      interpreterCalls: fromServer ? null : wire.interpreter,
      providerCallsSeenBy: fromServer ? 'the server\'s diagnostics' : 'the wire',
      returnedByProvider: Number(body.returned) || 0,
      verified: products.length,
      servedFromCache: Boolean(d.cache && d.cache.servedFromCache),
      rejected: body.rejected || {},
      products: products.map((p) => ({ name: p.name, price: p.price, currency: p.currency || null, retailer: p.retailer, productUrl: p.productUrl, image: Boolean(p.imageUrl) })),
      removed: fromServer ? null : removed
    };
  }

  process.on('message', async (msg) => {
    try {
      process.send({ id: msg.id, ok: true, result: await one(msg.query) });
    } catch (err) {
      process.send({ id: msg.id, ok: false, error: String(err && err.stack || err).slice(0, 600) });
    }
  });
  /* what this checkout is configured with, as states — never a value */
  let envStates = null;
  try { envStates = require(at('api', '_env-report')).envReport(); } catch (err) { envStates = null; }
  const provider = require(at('api', '_providers', 'product-source')).getProvider();
  process.send({
    ready: true,
    config: {
      provider: provider.name,
      providerConfigured: Boolean(provider.configured()),
      interpreterConfigured: Boolean(process.env.AI_PROVIDER || process.env.OPENAI_API_KEY),
      store: store === 'env' && STORE_VARS.some((name) => process.env[name]) ? 'configured store' : 'memory',
      env: typeof envStates === 'string' ? envStates : envStates ? JSON.stringify(envStates) : null
    }
  });
}

/* ---------- the run ---------- */

function startWorker(spec, reader, store) {
  const args = ['--worker', spec.root, reader, store || 'memory', spec.server || ''];
  const child = fork(__filename, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const waiting = new Map();
  let next = 0;
  const spec2 = spec;
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (msg) => {
      if (msg.ready) { spec2.config = msg.config || null; return resolve(); }
      const done = waiting.get(msg.id);
      if (done) { waiting.delete(msg.id); done(msg); }
    });
    child.once('exit', (code) => {
      for (const done of waiting.values()) done({ ok: false, error: `worker exited (${code})` });
      waiting.clear();
      reject(new Error(`${spec.name} exited before it was ready (${code})`));
    });
  });
  return {
    name: spec.name, root: spec.root, server: spec.server || null, ready,
    ask: (query, ms) => new Promise((resolve) => {
      const id = next += 1;
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: `no answer in ${ms}ms` }); }, ms);
      waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.send({ id, query });
    }),
    stop: () => child.kill()
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const pct = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

/* a provider that said it is out of capacity, after any retries */
const RATE_KINDS = new Set(['rate-limited', 'rate-limited-or-credits', 'credits-exhausted']);

function summarise(rows, options) {
  const o = options || {};
  const ok = rows.filter((r) => r.observed && !r.observed.crashed);
  const answered = ok.filter((r) => r.observed.status === 200);
  const judged = answered.filter((r) => !r.case.expectNone);
  const g = (list, f) => list.map(f).filter((v) => v !== null && v !== undefined);
  const statuses = {};
  for (const r of rows) { const k = r.observed ? String(r.observed.status) : 'crashed'; statuses[k] = (statuses[k] || 0) + 1; }
  const sources = {};
  for (const r of ok) sources[r.observed.interpreter] = (sources[r.observed.interpreter] || 0) + 1;
  const failures = {};
  for (const r of ok) if (r.observed.failure) { const k = r.observed.failure.class || `http ${r.observed.status}`; failures[k] = (failures[k] || 0) + 1; }
  /* only an answer can be right about having nothing to show */
  const none = answered.filter((r) => r.case.expectNone);
  const withExclusion = ok.filter((r) => r.case.exclude);
  /* one search per request from the configured source; a fallback after
     a refusal is the one exception, counted on its own */
  const direct = ok.filter((r) => !r.observed.fellBack);
  return {
    requests: rows.length,
    /* every dataset request is accounted for as one of these */
    attempted: rows.length,
    completed: answered.length,
    failed: rows.length - answered.length,
    rateLimited: ok.filter((r) => r.observed.failure && RATE_KINDS.has(r.observed.failure.kind)).length,
    skipped: Number(o.skipped) || 0,
    crashed: rows.length - ok.length,
    httpStatuses: statuses,
    successfulRequests: answered.length,
    failures,
    /* a run that searched nothing measured nothing about search */
    live: answered.length > 0,
    retried: ok.filter((r) => r.observed.attempts > 1).length,
    interpreterSources: sources,
    interpretationCorrect: mean(g(ok, (r) => (r.graded.reading.correct ? 1 : 0))),
    targetCorrect: mean(g(ok, (r) => (r.graded.reading.targetOk ? 1 : 0))),
    exclusionCorrect: mean(g(ok, (r) => (r.graded.reading.exclusionOk ? 1 : 0))),
    exclusionRecordedWhereStated: mean(g(withExclusion, (r) => (r.graded.reading.exclusionOk ? 1 : 0))),
    constraintsCorrect: mean(g(ok, (r) => (r.graded.reading.constraintsOk ? 1 : 0))),
    relevantAt4: mean(g(judged, (r) => r.graded.relevantAt4)),
    relevantAt8: mean(g(judged, (r) => r.graded.relevantAt8)),
    strongAt8: sum(g(judged, (r) => r.graded.strongAt8)),
    wrongAt8: sum(g(judged, (r) => r.graded.wrongAt8)),
    hardViolations: sum(g(answered, (r) => r.graded.hardViolations)),
    exclusionViolations: sum(g(answered, (r) => r.graded.exclusionViolations)),
    wronglyRemoved: sum(g(answered, (r) => (r.observed.removed ? r.graded.wronglyRemoved : null))),
    removedByFilter: sum(g(answered, (r) => (r.observed.removed ? r.observed.removed.length : null))),
    unexpectedlyEmpty: judged.filter((r) => !r.observed.verified).length,
    noResultCorrect: none.length ? `${none.filter((r) => r.graded.noneCorrect).length}/${none.length}` : null,
    verifiedMean: mean(g(answered, (r) => r.observed.verified)),
    providerSearchesMean: mean(g(direct, (r) => r.observed.providerSearches)),
    providerSearchesMax: Math.max(0, ...g(direct, (r) => r.observed.providerSearches)),
    fellBack: ok.length - direct.length,
    offerLookupsMean: mean(g(ok, (r) => r.observed.offerLookups)),
    offerLookupsMax: Math.max(0, ...g(ok, (r) => r.observed.offerLookups)),
    interpreterCallsMean: mean(g(ok, (r) => r.observed.interpreterCalls)),
    interpretMsP50: pct(g(ok, (r) => r.observed.interpretMs), 0.5),
    interpretMsP95: pct(g(ok, (r) => r.observed.interpretMs), 0.95),
    searchMsP50: pct(g(ok, (r) => r.observed.searchMs), 0.5),
    searchMsP95: pct(g(ok, (r) => r.observed.searchMs), 0.95),
    totalMsP50: pct(g(ok, (r) => r.observed.totalMs), 0.5),
    totalMsP95: pct(g(ok, (r) => r.observed.totalMs), 0.95)
  };
}

/* relevance and wrongness by kind of request */
function byType(rows) {
  const out = {};
  for (const type of TYPES) {
    const here = rows.filter((r) => r.case.type === type && r.observed && r.observed.status === 200 && !r.case.expectNone);
    if (!here.length) continue;
    out[type] = { n: here.length, relevantAt8: mean(here.map((r) => r.graded.relevantAt8)), wrongAt8: sum(here.map((r) => r.graded.wrongAt8)), readCorrectly: mean(here.map((r) => (r.graded.reading.correct ? 1 : 0))) };
  }
  return out;
}

/* the same request on two checkouts: what changed */
function differences(cases, byRoot, before, after) {
  const out = [];
  cases.forEach((c, i) => {
    const a = byRoot[before][i];
    const b = byRoot[after][i];
    if (!a.observed || !b.observed || !a.graded || !b.graded) return;
    const urls = (r) => r.observed.products.slice(0, 8).map((p) => p.productUrl);
    const shared = urls(a).filter((u) => urls(b).includes(u)).length;
    out.push({
      id: c.id,
      query: c.q,
      type: c.type,
      set: c.set,
      status: [a.observed.status, b.observed.status],
      askedBefore: a.observed.asked,
      askedAfter: b.observed.asked,
      sameQuery: a.observed.asked === b.observed.asked,
      sharedTop8: shared,
      relevantAt8: [a.graded.relevantAt8, b.graded.relevantAt8],
      strongAt8: [a.graded.strongAt8, b.graded.strongAt8],
      wrongAt8: [a.graded.wrongAt8, b.graded.wrongAt8],
      verified: [a.observed.verified, b.observed.verified],
      correct: [a.graded.reading.correct, b.graded.reading.correct],
      score: (b.graded.relevantAt8 - a.graded.relevantAt8) - (b.graded.wrongAt8 - a.graded.wrongAt8) / 8
        + ((b.graded.reading.correct ? 1 : 0) - (a.graded.reading.correct ? 1 : 0)) * 0.25
        + (b.observed.status === 200 ? 0 : -1) - (a.observed.status === 200 ? 0 : -1)
    });
  });
  return out;
}

async function run(options) {
  const opts = options || {};
  const reader = opts.reader === 'local' ? 'local' : 'served';
  const specs = opts.servers && opts.servers.length
    ? opts.servers.map((s) => ({ name: s.name, server: s.url, root: path.resolve(s.root || HERE) }))
    : (opts.roots && opts.roots.length ? opts.roots : [{ name: 'this', root: HERE }]).map((r) => ({ name: r.name, root: path.resolve(r.root) }));
  let cases = CASES.filter((c) => !opts.set || opts.set === 'all' || c.set === opts.set);
  if (opts.types) cases = cases.filter((c) => opts.types.includes(c.type));
  if (opts.only) cases = opts.only.map((key) => CASES.find((c) => c.id === key || c.q === key) || { id: 'ad-hoc', type: 'natural-language', set: 'messy', q: key, intent: '(not in the dataset)', target: /./, relevant: /./ });
  const retries = Number.isInteger(opts.retries) && opts.retries >= 0 ? opts.retries : 1;
  const retryDelayMs = Number(opts.retryDelayMs) >= 0 ? Number(opts.retryDelayMs) : 5000;
  const workers = specs.map((spec) => startWorker(spec, reader, opts.store));
  await Promise.all(workers.map((w) => w.ready));
  const byRoot = {};
  for (const w of workers) byRoot[w.name] = [];
  const startedAt = new Date().toISOString();
  try {
    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      /* alternate who asks first, so neither always meets a warmer provider */
      const order = i % 2 ? workers.slice().reverse() : workers;
      for (const w of order) {
        let answer = await w.ask(c.q, opts.timeoutMs || 120000);
        let attempts = 1;
        /* a transient provider failure is tried again, a bounded number of
           times, after a pause; every attempt is recorded */
        const earlier = [];
        while (answer.ok && transient(answer.result) && attempts <= retries) {
          earlier.push(answer.result.failure);
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempts));
          answer = await w.ask(c.q, opts.timeoutMs || 120000);
          attempts += 1;
        }
        if (answer.ok) Object.assign(answer.result, { attempts, earlierFailures: earlier });
        const row = { case: c, observed: answer.ok ? answer.result : null, error: answer.ok ? null : answer.error };
        row.graded = row.observed && !row.observed.crashed ? grade(c, row.observed) : null;
        byRoot[w.name][i] = row;
        if (opts.progress) opts.progress(w.name, i, cases.length, row);
      }
    }
  } finally {
    workers.forEach((w) => w.stop());
  }
  const summary = {};
  const types = {};
  /* dataset requests this run left out (--only, --set, --types) */
  const skipped = CASES.filter((c) => !cases.includes(c)).length;
  for (const w of workers) { summary[w.name] = summarise(byRoot[w.name], { skipped }); types[w.name] = byType(byRoot[w.name]); }
  const names = workers.map((w) => w.name);
  const compared = names.length > 1 ? differences(cases, byRoot, names[0], names[names.length - 1]) : null;
  const messy = CASES.filter((c) => c.set === 'messy').length;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: specs.some((s) => s.server) ? 'servers' : 'in-process',
    reader,
    store: opts.store === 'env' ? 'the configured store' : 'memory',
    dataset: { file: 'scripts/bench-messy-queries.js', total: CASES.length, messy, plain: CASES.length - messy, run: cases.length },
    retries: { max: retries, delayMs: retryDelayMs, kinds: [...TRANSIENT] },
    /* a server runs with its own environment, which this process cannot
       see: its configuration is not reported as this process's */
    checkouts: specs.map((s) => ({ name: s.name, root: s.root, server: s.server || null, config: s.server ? null : s.config || null })),
    cases: cases.map((c) => c.id),
    byRoot,
    summary,
    types,
    compared
  };
}

/* ---------- the record ---------- */

const f2 = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));
const p0 = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 100)}%`);
const LINES = [
  ['attempted', (s) => s.attempted],
  ['completed (HTTP 200)', (s) => s.completed],
  ['failed (any other answer, or none)', (s) => s.failed],
  ['  of which rate-limited or out of credits', (s) => s.rateLimited],
  ['skipped (left out of this run)', (s) => s.skipped],
  ['HTTP statuses', (s) => Object.entries(s.httpStatuses).map(([k, v]) => `${k}×${v}`).join(' ')],
  ['failures, by whose', (s) => Object.entries(s.failures).map(([k, v]) => `${k} ×${v}`).join('; ') || 'none'],
  ['requests retried (transient provider errors)', (s) => s.retried],
  ['interpreter answered', (s) => Object.entries(s.interpreterSources).map(([k, v]) => `${k}:${v}`).join(' ')],
  ['interpretation correct', (s) => p0(s.interpretationCorrect)],
  ['  target correct', (s) => p0(s.targetCorrect)],
  ['  exclusions correct', (s) => p0(s.exclusionCorrect)],
  ['  exclusions kept, where stated', (s) => p0(s.exclusionRecordedWhereStated)],
  ['  constraints kept, none invented', (s) => p0(s.constraintsCorrect)],
  ['relevant@4 (mean)', (s) => f2(s.relevantAt4)],
  ['relevant@8 (mean)', (s) => f2(s.relevantAt8)],
  ['strong matches in top 8 (total)', (s) => s.strongAt8],
  ['clearly wrong in top 8 (total)', (s) => s.wrongAt8],
  ['hard-constraint violations', (s) => s.hardViolations],
  ['  of which ruled-out shown', (s) => s.exclusionViolations],
  ['wrongly removed by the filter', (s) => s.wronglyRemoved],
  ['no products where some were expected', (s) => s.unexpectedlyEmpty],
  ['nothing shown where nothing is right', (s) => s.noResultCorrect || '—'],
  ['verified per search (mean)', (s) => f2(s.verifiedMean)],
  ['provider searches per search (mean/max)', (s) => `${f2(s.providerSearchesMean)} / ${s.providerSearchesMax}`],
  ['  fell back to the second source (quota refusal)', (s) => s.fellBack],
  ['offer lookups per search (mean/max)', (s) => `${f2(s.offerLookupsMean)} / ${s.offerLookupsMax}`],
  ['interpreter calls per search (mean)', (s) => f2(s.interpreterCallsMean)],
  ['interpret ms p50 / p95', (s) => `${s.interpretMsP50} / ${s.interpretMsP95}`],
  ['search ms p50 / p95', (s) => `${s.searchMsP50} / ${s.searchMsP95}`],
  ['total ms p50 / p95', (s) => `${s.totalMsP50} / ${s.totalMsP95}`]
];

/* everything, as data: what each request asked, got and was graded */
function resultsJson(out) {
  return {
    startedAt: out.startedAt, finishedAt: out.finishedAt, mode: out.mode, reader: out.reader, store: out.store,
    dataset: out.dataset, checkouts: out.checkouts, summary: out.summary, types: out.types, compared: out.compared,
    results: out.cases.map((id, i) => {
      const row = { id, type: out.byRoot[out.checkouts[0].name][i].case.type, query: out.byRoot[out.checkouts[0].name][i].case.q, intent: out.byRoot[out.checkouts[0].name][i].case.intent };
      for (const c of out.checkouts) {
        const r = out.byRoot[c.name][i];
        row[c.name] = r.observed ? Object.assign({}, r.observed, {
          intent: undefined,
          products: r.graded ? r.graded.products.slice(0, 8).map((p) => ({ name: p.name, price: p.price, retailer: p.retailer, productUrl: p.productUrl, image: p.image, relevant: p.relevant, strong: p.strong, wrong: p.wrong, hard: p.hard })) : r.observed.products.slice(0, 8),
          /* null over HTTP: what the filter removed is not visible there */
          removed: r.observed.removed === null ? null : r.graded ? r.graded.removed : r.observed.removed,
          graded: r.graded ? { reading: r.graded.reading, relevantAt4: r.graded.relevantAt4, relevantAt8: r.graded.relevantAt8, strongAt8: r.graded.strongAt8, wrongAt8: r.graded.wrongAt8, hardViolations: r.graded.hardViolations, wronglyRemoved: r.graded.wronglyRemoved, noneCorrect: r.graded.noneCorrect } : null
        }) : { crashed: r.error };
      }
      return row;
    })
  };
}

const cell = (v) => String(v === null || v === undefined ? '' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/* What a person reading the record should look at first: the best
   answers, and the worst, each for a different reason. Chosen by the
   grading rules alone — never by reading the products. */
function representative(rows) {
  const answered = rows.filter((r) => r.observed && !r.observed.crashed && r.graded);
  const judged = answered.filter((r) => r.observed.status === 200 && !r.case.expectNone);
  const successes = judged
    .filter((r) => r.graded.relevantAt8 > 0 && !r.graded.wrongAt8 && !r.graded.hardViolations)
    .sort((a, b) => b.graded.relevantAt8 - a.graded.relevantAt8 || b.graded.strongAt8 - a.graded.strongAt8)
    .slice(0, 3)
    .map((r) => ({ row: r, why: `relevant@8 ${f2(r.graded.relevantAt8)}, ${r.graded.strongAt8} strong, nothing wrong` }));
  const failures = [];
  const taken = new Set();
  const add = (r, why) => { if (r && !taken.has(r.case.id) && failures.length < 6) { taken.add(r.case.id); failures.push({ row: r, why }); } };
  /* one per kind of failed request */
  const classes = new Set();
  for (const r of rows) {
    const k = !r.observed ? 'no answer' : r.observed.crashed ? 'crashed' : r.observed.status !== 200 ? (r.observed.failure && r.observed.failure.class) || `http ${r.observed.status}` : null;
    if (k && !classes.has(k)) { classes.add(k); add(r, k === 'no answer' ? `no answer: ${r.error}` : k === 'crashed' ? `crashed: ${r.observed.crashed}` : k); }
  }
  answered.filter((r) => r.graded.exclusionViolations).forEach((r) => add(r, `${r.graded.exclusionViolations} ruled-out product(s) shown`));
  answered.filter((r) => r.graded.hardViolations).forEach((r) => add(r, `${r.graded.hardViolations} hard-constraint violation(s)`));
  answered.filter((r) => r.graded.noneExpected && r.graded.noneCorrect === false).forEach((r) => add(r, 'products shown where nothing is right'));
  judged.filter((r) => !r.observed.verified).forEach((r) => add(r, 'no products where some were expected'));
  judged.filter((r) => r.graded.wrongAt8).sort((a, b) => b.graded.wrongAt8 - a.graded.wrongAt8).forEach((r) => add(r, `${r.graded.wrongAt8} clearly wrong in the top 8`));
  answered.filter((r) => !r.graded.reading.correct).forEach((r) => add(r, `misread: ${r.graded.reading.notes.join('; ')}`));
  return { successes, failures };
}

/* How often each kind of failure happened, by kind of request: counts
   only. Saying what to fix is left to a person reading the rows. */
function failurePatterns(rows) {
  const counts = {};
  const bump = (pattern, type) => {
    const p = counts[pattern] || (counts[pattern] = { n: 0, types: {} });
    p.n += 1;
    p.types[type] = (p.types[type] || 0) + 1;
  };
  for (const r of rows) {
    const type = r.case.type;
    if (!r.observed) { bump('no answer from the checkout', type); continue; }
    if (r.observed.crashed) { bump('the page\'s code crashed', type); continue; }
    if (r.observed.status !== 200) bump((r.observed.failure && r.observed.failure.class) || `http ${r.observed.status}`, type);
    const gr = r.graded;
    if (!gr) continue;
    for (const note of gr.reading.notes) bump(`misread: ${note.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, 'N')}`, type);
    if (r.observed.status !== 200) continue;
    if (gr.exclusionViolations) bump('ruled-out product shown', type);
    if (gr.hardViolations) bump('hard constraint broken (budget, stated colour or gender)', type);
    if (gr.noneExpected && gr.noneCorrect === false) bump('products shown where nothing is right', type);
    if (!gr.noneExpected && !r.observed.verified) bump('no products where some were expected', type);
    if (!gr.noneExpected && r.observed.verified && !gr.relevantAt8) bump('products shown, none relevant', type);
    if (gr.wrongAt8) bump('clearly wrong product in the top 8', type);
    if (gr.wronglyRemoved) bump('a plainly relevant product removed by the filter', type);
  }
  return Object.entries(counts).sort((a, b) => b[1].n - a[1].n).map(([pattern, p]) => ({ pattern, n: p.n, types: p.types }));
}

function summaryMarkdown(out) {
  const names = out.checkouts.map((c) => c.name);
  const lines = [];
  lines.push('# Messy-search live benchmark', '');
  const dead = out.checkouts.filter((c) => !out.summary[c.name].live).map((c) => c.name);
  if (dead.length) {
    lines.push(`> **Not a live result for ${dead.join(', ')}: no search succeeded.** Every request ended in`,
      `> ${dead.map((n) => Object.entries(out.summary[n].failures).map(([k, v]) => `${k} ×${v}`).join('; ')).join(' / ')}.`,
      '> Interpretation is still measured (it runs before the provider is asked); nothing about products is.', '');
  }
  lines.push(`- run: ${out.startedAt} → ${out.finishedAt}`);
  lines.push(`- mode: ${out.mode}; reader: ${out.reader}; store: ${out.store}`);
  lines.push(`- dataset: ${out.dataset.file} — ${out.dataset.messy} messy + ${out.dataset.plain} plain; ${out.dataset.run} run`);
  out.checkouts.forEach((c) => lines.push(`- ${c.name}: ${c.server ? `${c.server} (page code from ${c.root}) — the server's own environment, not visible from here` : c.root}${c.config ? ` — provider ${c.config.provider} ${c.config.providerConfigured ? 'configured' : 'NOT configured'}, interpreter ${c.config.interpreterConfigured ? 'configured' : 'not configured'}, ${c.config.store}` : ''}`));
  lines.push(`- retries: up to ${out.retries.max} per request, for ${out.retries.kinds.join(', ')}`);
  lines.push('', '## Summary', '', `| | ${names.join(' | ')} |`, `|---|${names.map(() => '---').join('|')}|`);
  for (const [label, f] of LINES) lines.push(`| ${label.trim()} | ${names.map((n) => cell(f(out.summary[n]))).join(' | ')} |`);
  lines.push('', '### How this is measured', '',
    '- A search **succeeded** only when /api/search answered 200. A 503 (nothing configured), 502 (the provider), 500 (Fynd) or 429 (allowance) is a failure and is never counted as a search.',
    '- **Intent satisfaction** is the interpretation grade: the target garment, the exclusions recorded, the stated constraints kept (budget, colour, gender), nothing invented — graded from the body the page posted.',
    '- **Relevance** (relevant@k, strong, clearly wrong, hard-constraint violations) is graded automatically against patterns written for each request in scripts/bench-messy-queries.js before any run, on the product title, price and retailer. A title that does not say is counted neither way. **No manual relevance judgment has been made**: relevant@k is a lower bound, and a difference worth acting on should be read against the product titles in results.json.',
    '- Latency is wall-clock time in this process: the interpreter call, the /api/search call, and the whole request as the page makes it.');
  lines.push('', '## By kind of request (relevant@8 / clearly wrong / read correctly)', '', `| type | n | ${names.join(' | ')} |`, `|---|---|${names.map(() => '---').join('|')}|`);
  for (const type of TYPES) {
    const first = out.types[names[0]][type];
    if (!first) continue;
    lines.push(`| ${type} | ${first.n} | ${names.map((n) => { const t = out.types[n][type]; return t ? `${f2(t.relevantAt8)} / ${t.wrongAt8} / ${p0(t.readCorrectly)}` : '—'; }).join(' | ')} |`);
  }
  const products = (r) => (r.graded ? r.graded.products : r.observed && r.observed.products || []).slice(0, 3).map((p) => `${String(p.name || '').slice(0, 48)} (${p.price === null || p.price === undefined ? '?' : p.price}, ${p.retailer || '?'})`).join('; ');
  for (const name of names) {
    const picked = representative(out.byRoot[name]);
    if (!picked.successes.length && !picked.failures.length) continue;
    lines.push('', `## Representative results — ${name}`, '', '| | id | type | request | HTTP | why | top products |', '|---|---|---|---|---|---|---|');
    for (const [label, list] of [['success', picked.successes], ['failure', picked.failures]]) {
      for (const { row, why } of list) lines.push(`| ${label} | ${row.case.id} | ${row.case.type} | ${cell(row.case.q)} | ${row.observed ? row.observed.status : '—'} | ${cell(why)} | ${cell(products(row))} |`);
    }
    const patterns = failurePatterns(out.byRoot[name]);
    lines.push('', `### Failure patterns — ${name}`, '');
    if (!patterns.length) lines.push('None recorded.');
    else {
      lines.push('| pattern | requests | most affected kinds |', '|---|---|---|');
      for (const p of patterns.slice(0, 12)) lines.push(`| ${cell(p.pattern)} | ${p.n} | ${Object.entries(p.types).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} ×${n}`).join(', ')} |`);
    }
    lines.push('', 'Counts only: what to fix is for a person to decide from these rows and the products in results.json.');
  }
  if (out.compared) {
    const ranked = out.compared.slice().sort((a, b) => a.score - b.score);
    const row = (d) => `| ${d.id} | ${cell(d.query)} | ${cell(d.askedBefore)} → ${cell(d.askedAfter)} | ${d.status.join('→')} | ${f2(d.relevantAt8[0])}→${f2(d.relevantAt8[1])} | ${d.wrongAt8.join('→')} | ${f2(d.score)} |`;
    const head = ['| id | request | asked | status | relevant@8 | wrong@8 | score |', '|---|---|---|---|---|---|---|'];
    const plain = out.compared.filter((d) => d.set === 'plain');
    lines.push('', `## ${names[0]} → ${names[names.length - 1]}`, '');
    if (plain.length) lines.push(`Plain requests asking the same phrase: ${plain.filter((d) => d.sameQuery).length}/${plain.length}.`, '');
    lines.push('### Worst regressions', '', ...head, ...ranked.filter((d) => d.score < 0).slice(0, 10).map(row));
    lines.push('', '### Best improvements', '', ...head, ...ranked.filter((d) => d.score > 0).reverse().slice(0, 10).map(row));
  }
  for (const name of names) {
    lines.push('', `## Every request — ${name}`, '', '| id | type | request | HTTP | ms | asked | verified | relevant@8 | strong | wrong | notes |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of out.byRoot[name]) {
      if (!r.observed || r.observed.crashed) { lines.push(`| ${r.case.id} | ${r.case.type} | ${cell(r.case.q)} | — | — | — | — | — | — | — | crashed: ${cell(r.error || r.observed.crashed)} |`); continue; }
      const o = r.observed;
      const notes = [].concat(r.graded.reading.notes, o.failure ? [`${o.failure.reason || ''} ${o.failure.kind || o.failure.stage || ''}`.trim()] : [], r.graded.noneExpected ? [r.graded.noneCorrect ? 'nothing shown: right' : 'products shown where nothing is right'] : []);
      lines.push(`| ${r.case.id} | ${r.case.type} | ${cell(r.case.q)} | ${o.status} | ${o.totalMs} | ${cell(o.asked)} | ${o.verified} | ${f2(r.graded.relevantAt8)} | ${r.graded.strongAt8} | ${r.graded.wrongAt8} | ${cell(notes.join('; '))} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeRecord(out, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(resultsJson(out), (k, v) => (v instanceof RegExp ? String(v) : typeof v === 'function' ? '[rule]' : v), 2));
  fs.writeFileSync(path.join(dir, 'summary.md'), summaryMarkdown(out));
  return dir;
}

function print(out) {
  const names = out.checkouts.map((c) => c.name);
  console.log(`\n${out.mode} · reader ${out.reader} · ${out.cases.length} requests · ${out.checkouts.map((c) => `${c.name} = ${c.server || c.root}`).join(' · ')}\n`);
  console.log(`${''.padEnd(40)}${names.map((n) => n.padStart(16)).join('')}`);
  for (const [label, f] of LINES) console.log(`${label.padEnd(40)}${names.map((n) => String(f(out.summary[n])).padStart(16)).join('')}`);
}

function parsePairs(text) {
  return String(text).split(',').filter(Boolean).map((pair) => {
    const at = pair.indexOf('=');
    return at === -1 ? { name: path.basename(path.resolve(pair)), value: pair } : { name: pair.slice(0, at), value: pair.slice(at + 1) };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') return worker(args[1], args[2], args[3], args[4] || null);
  const value = (flag) => { const at = args.indexOf(flag); return at === -1 ? null : args[at + 1]; };
  const roots = value('--roots') ? parsePairs(value('--roots')).map((p) => ({ name: p.name, root: p.value })) : null;
  const serverRoots = value('--roots') ? Object.fromEntries(roots.map((r) => [r.name, r.root])) : {};
  const servers = value('--servers') ? parsePairs(value('--servers')).map((p) => ({ name: p.name, url: p.value, root: serverRoots[p.name] })) : null;
  const out = await run({
    roots: servers ? null : roots,
    servers,
    reader: value('--reader') || 'served',
    store: value('--store') || 'memory',
    only: value('--only') ? value('--only').split('|') : null,
    set: value('--set') || 'all',
    types: value('--types') ? value('--types').split(',') : null,
    retries: value('--retries') === null ? undefined : Number(value('--retries')),
    retryDelayMs: value('--retry-delay-ms') === null ? undefined : Number(value('--retry-delay-ms')),
    progress: (name, i, n, row) => process.stderr.write(`\r${name} ${i + 1}/${n} ${row.case.id} ${row.observed ? row.observed.status : 'crashed'}`.padEnd(60))
  });
  process.stderr.write('\n');
  const dir = writeRecord(out, value('--out-dir') || path.join(HERE, 'bench-results', `messy-live-${out.startedAt.replace(/[:.]/g, '-')}`));
  if (args.includes('--json')) console.log(JSON.stringify(out.summary, null, 2));
  else print(out);
  console.log(`\nwritten: ${path.join(dir, 'results.json')} and summary.md`);
  /* a checkout on which no search succeeded measured nothing about
     search: that is never a pass, whatever else went right */
  const dead = out.checkouts.filter((c) => !out.summary[c.name].live);
  if (dead.length) {
    console.error(`\nNOT A LIVE RESULT: no search succeeded on ${dead.map((c) => `${c.name} (${Object.entries(out.summary[c.name].failures).map(([k, v]) => `${k} ×${v}`).join('; ')})`).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  /* the one that ran last is the one being judged */
  const judged = out.summary[out.checkouts[out.checkouts.length - 1].name];
  if (judged.crashed || judged.exclusionViolations || judged.providerSearchesMax > 1) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });

module.exports = { representative, failurePatterns, run, failureClass, transient, grade, gradeReading, gradeProduct, colourConflict, genderConflict, recordedExclusions, summarise, byType, resultsJson, summaryMarkdown, writeRecord, CASES, QUERIES };
