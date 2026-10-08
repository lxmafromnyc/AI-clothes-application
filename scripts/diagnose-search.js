#!/usr/bin/env node
/* =========================================================
   Fynd — why did this search come back 502?

   Reproduces, for one or more requests, exactly what a browser does when
   /api/interpret cannot answer (no OpenAI key locally): the page reads
   the request itself, POSTs the result to /api/search, and gets back
   whatever the real handler makes of it. Then, if that was a 502, it
   makes the same search call the handler made and prints the error it
   threw — the name, the message, the cause and the stack — so the
   failing line is read, not guessed.

     1. the body       built by the page's OWN code (assets/products.js,
                       catalog.js, interpret.js and search.js, loaded in
                       the order the page loads them), with /api/interpret
                       answering 503 "Interpreter is not configured." —
                       byte for byte what the browser sends
     2. the handler    api/search.js, the real one, with the real provider
                       and the real key from the environment
     3. upstream       every provider request: host, path, status, time,
                       and for a search its q; any parameter whose name
                       looks like a key is shown as [redacted]
     4. the exception  on a 502 only, the handler's own search call made
                       again with the same arguments, and what it threw
     5. the server     with --server, the same body also POSTed to a
                       running local server (vercel dev, or whatever
                       serves /api), so "the server fails" and "this code
                       with this .env.local fails" can be told apart: if
                       the server says 502 and step 2 says 200, the
                       difference is the server's environment, not code

   Nothing secret is printed: no key, no cookie, no header value. The
   provider's own error messages are already redacted by the adapters.

   Cost: one provider search per request, as in production, plus one
   more for a request that failed (step 4), and the offer lookups each
   of those makes.

   Usage:
     node --env-file=.env.local scripts/diagnose-search.js "a baggy hoodie thats light grey and its cozy"
     node --env-file=.env.local scripts/diagnose-search.js --body body.json   (a body copied from the browser)
     node --env-file=.env.local scripts/diagnose-search.js --server http://localhost:3000 "..."
     add --json for machine-readable output
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

/* ---------- 1. the body, built by the page's own code ---------- */

let pageLoaded = null;
/* The page's scripts, in page order. catalog.js declares its rows as a
   top-level const, which a browser shares between scripts and Node's
   require does not, so it is run as the page runs it and the rows are
   loaded exactly as assets/app.js loads them. */
function loadPage() {
  if (pageLoaded) return pageLoaded;
  require(path.join(REPO, 'assets', 'products.js'));
  const catalogue = path.join(REPO, 'assets', 'catalog.js');
  if (fs.existsSync(catalogue)) {
    require('vm').runInThisContext(`${fs.readFileSync(catalogue, 'utf8')}\n;globalThis.__fyndDemoProducts = typeof DEMO_PRODUCTS === 'undefined' ? [] : DEMO_PRODUCTS;`, { filename: catalogue });
  }
  for (const file of ['interpret.js', 'search.js']) require(path.join(REPO, 'assets', file));
  pageLoaded = Promise.resolve(globalThis.Products.load(globalThis.__fyndDemoProducts || []));
  return pageLoaded;
}

/* exactly what assets/app.js hands the interpreter */
function vocabulary() {
  const Products = globalThis.Products;
  const f = Products.facets();
  return {
    categories: [...new Set(Products.all().map((p) => p.category).filter(Boolean))],
    colors: [...f.colors.keys()],
    occasions: [...f.occasions.keys()],
    fits: [...f.fits.keys()],
    brands: [...f.brands.keys()],
    styles: [...f.styles.keys()]
  };
}

async function browserBody(query) {
  await loadPage();
  const realFetch = globalThis.fetch;
  let posted = null;
  globalThis.FINDWEAR_API = 'http://local.invalid/api/interpret';
  globalThis.FINDWEAR_SEARCH_API = 'http://local.invalid/api/search';
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (href.endsWith('/api/interpret')) return reply(503, { error: 'Interpreter is not configured.' });
    if (href.endsWith('/api/search')) {
      posted = JSON.parse(init.body);
      return reply(599, { error: 'captured' });
    }
    throw new Error(`the page made an unexpected request: ${href}`);
  };
  try {
    const outcome = await globalThis.Interpreter.interpret(query, vocabulary());
    await globalThis.ProductSearch.find(outcome.preferences, undefined, []);
    return { body: posted, interpreter: outcome.source, notice: outcome.notice || null };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* ---------- 3. every provider request, with nothing secret ---------- */

const SECRET_PARAM = /key|token|secret|auth|signature/i;

function watchUpstream() {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const started = Date.now();
    let where = String(url);
    let q = null;
    try {
      const u = new URL(where);
      q = u.searchParams.get('q');
      const names = [...u.searchParams.keys()].map((k) => (SECRET_PARAM.test(k) ? `${k}=[redacted]` : k));
      where = `${u.host}${u.pathname} (${names.join(', ')})`;
    } catch (err) { where = 'unparseable URL'; }
    try {
      const response = await realFetch(url, init);
      calls.push({ where, q, status: response.status, ms: Date.now() - started });
      return response;
    } catch (err) {
      calls.push({ where, q, status: null, ms: Date.now() - started, threw: describe(err) });
      throw err;
    }
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

/* ---------- 4. an exception, in full ---------- */

function describe(err) {
  if (!err || typeof err !== 'object') return { value: String(err) };
  const frames = String(err.stack || '').split('\n').slice(1)
    .map((line) => line.trim().replace(REPO + path.sep, ''))
    .slice(0, 12);
  const out = {
    name: err.name,
    message: err.message,
    code: err.code || null,
    status: err.status || err.statusCode || null,
    frames
  };
  if (err.cause) out.cause = describe(err.cause);
  if (err.fellBackFrom) out.fellBackFrom = err.fellBackFrom;
  return out;
}

function mockRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.getHeader = (k) => res.headers[k];
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

/* 5. the same body, to a running server, exactly as the browser posts it */
async function askServer(server, body) {
  const started = Date.now();
  try {
    const response = await fetch(`${String(server).replace(/\/+$/, '')}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const answer = await response.json().catch(() => null);
    return {
      status: response.status,
      ms: Date.now() - started,
      error: answer && answer.error ? answer.error : null,
      reason: answer && answer.reason ? answer.reason : null,
      kind: answer && answer.kind ? answer.kind : null,
      upstreamStatus: answer && answer.upstreamStatus ? answer.upstreamStatus : null,
      products: answer && Array.isArray(answer.products) ? answer.products.length : null
    };
  } catch (err) {
    return { status: null, ms: Date.now() - started, threw: describe(err) };
  }
}

async function diagnose(query, givenBody, options) {
  const search = require(path.join(REPO, 'api', 'search.js'));
  const { getProvider } = require(path.join(REPO, 'api', '_providers', 'product-source.js'));
  const cache = require(path.join(REPO, 'api', '_cache.js'));

  const built = givenBody ? { body: givenBody, interpreter: 'given', notice: null } : await browserBody(query);
  const report = { query, interpreter: built.interpreter, body: built.body };
  if (options && options.server) report.server = await askServer(options.server, built.body);

  /* the handler's console output, kept with the request it belongs to */
  const logged = [];
  const keep = (level) => (...args) => logged.push(`${level}: ${args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`);
  const real = { error: console.error, warn: console.warn, log: console.log };
  console.error = keep('error');
  console.warn = keep('warn');

  /* 2. the real handler, as the browser posts */
  if (cache.reset) cache.reset();
  let up = watchUpstream();
  const res = mockRes();
  const started = Date.now();
  try {
    await search({
      method: 'POST',
      headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: built.body,
      on: (event, cb) => { if (event === 'end') cb(); }
    }, res);
  } catch (err) {
    report.handlerThrew = describe(err);
  } finally {
    up.restore();
  }
  const answer = res.body || {};
  const d = answer.diagnostics || {};
  report.handler = {
    status: res.statusCode,
    ms: Date.now() - started,
    error: answer.error || null,
    reason: answer.reason || null,
    kind: answer.kind || null,
    upstreamStatus: answer.upstreamStatus || null,
    products: Array.isArray(answer.products) ? answer.products.length : null,
    funnel: answer.diagnostics ? {
      returnedByProvider: d.returnedByProvider, reachedGate: d.reachedGate, verified: d.verified,
      rejected: d.rejected, offers: d.offers && {
        made: d.offers.lookupsMade, failed: d.offers.lookupsFailed, timedOut: d.offers.lookupsTimedOut,
        resolved: d.offers.resolvedFromOffers
      }, timing: d.timing
    } : null
  };
  report.upstream = up.calls;
  report.serverLog = logged.slice();

  /* 4. on a 502, the same call the handler made, to see what it threw */
  if (res.statusCode === 502) {
    logged.length = 0;
    if (cache.reset) cache.reset();
    up = watchUpstream();
    try {
      const intent = search.shapeIntent(built.body.intent);
      const limit = Math.min(Math.max(Number(built.body.limit) || search.DEFAULT_LIMIT, 1), 48);
      await search.searchWithFallback(getProvider(), intent, limit, cache.counters(), Date.now() + search.requestBudget());
      report.exception = 'none on the second attempt — the failure did not repeat';
    } catch (err) {
      report.exception = describe(err);
    } finally {
      up.restore();
    }
    report.retryUpstream = up.calls;
    report.retryLog = logged.slice();
  }

  console.error = real.error;
  console.warn = real.warn;
  return report;
}

function print(r) {
  console.log(`\n=== ${r.query}`);
  console.log(`interpreter: ${r.interpreter}`);
  console.log(`body sent to /api/search:\n  ${JSON.stringify(r.body)}`);
  if (r.server) console.log(`running server: ${r.server.status === null ? `unreachable ${JSON.stringify(r.server.threw)}` : `${r.server.status} in ${r.server.ms}ms${r.server.error ? ` — ${JSON.stringify({ error: r.server.error, reason: r.server.reason, kind: r.server.kind, upstreamStatus: r.server.upstreamStatus })}` : ` — ${r.server.products} products`}`}`);
  const h = r.handler;
  console.log(`handler: ${h.status} in ${h.ms}ms${h.error ? ` — ${JSON.stringify({ error: h.error, reason: h.reason, kind: h.kind, upstreamStatus: h.upstreamStatus })}` : ` — ${h.products} products`}`);
  if (h.funnel) console.log(`funnel: ${JSON.stringify(h.funnel)}`);
  for (const c of r.upstream) console.log(`  upstream ${c.status === null ? 'THREW' : c.status} ${c.ms}ms ${c.where}${c.q ? ` q=${JSON.stringify(c.q)}` : ''}${c.threw ? ` ${JSON.stringify(c.threw)}` : ''}`);
  for (const line of r.serverLog) console.log(`  server ${line}`);
  if (r.handlerThrew) console.log(`handler threw: ${JSON.stringify(r.handlerThrew, null, 2)}`);
  if (r.exception) {
    console.log(`exception from the same search call:\n${typeof r.exception === 'string' ? `  ${r.exception}` : JSON.stringify(r.exception, null, 2)}`);
    for (const c of r.retryUpstream) console.log(`  upstream ${c.status === null ? 'THREW' : c.status} ${c.ms}ms ${c.where}${c.threw ? ` ${JSON.stringify(c.threw)}` : ''}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const at = args.indexOf('--body');
  const given = at === -1 ? null : JSON.parse(fs.readFileSync(args[at + 1], 'utf8'));
  const serverAt = args.indexOf('--server');
  const server = serverAt === -1 ? null : args[serverAt + 1];
  const queries = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--body' && args[i - 1] !== '--server');
  if (!given && !queries.length) {
    console.error('Give a request in quotes, or --body file.json.');
    process.exit(2);
  }
  const reports = [];
  for (const query of given ? ['(given body)'] : queries) reports.push(await diagnose(query, given && (given.intent ? given : { intent: given }), { server }));
  if (json) console.log(JSON.stringify(reports, null, 2));
  else reports.forEach(print);
}

if (require.main === module) main().catch((err) => { console.error(err && err.stack); process.exit(1); });

/* the vocabulary the page sends the interpreter, for the live benchmark */
async function pageVocabulary() {
  await loadPage();
  return vocabulary();
}

module.exports = { browserBody, diagnose, describe, pageVocabulary };
