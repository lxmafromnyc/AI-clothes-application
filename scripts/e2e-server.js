/* =========================================================
   Fynd — the real stack, on a local port

   Mounts the REAL /api/interpret and /api/search handlers behind a real
   HTTP server and serves the REAL pages, so a browser can drive the whole
   chain: page -> fetch -> handler -> provider adapter -> verification
   gate -> JSON -> render.

   The only thing replaced is the outermost boundary: global fetch, for
   the two vendor hosts. Everything between the browser and that boundary
   is the code that runs in production, unmodified.

   A vendor double is supplied by the caller, so one test can serve a
   normal catalogue and the next can serve 429s, timeouts, malformed
   payloads or nothing at all.
   ========================================================= */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

/* The Vercel/Next handler signature the API files are written against,
   over a plain node response. */
function shim(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = (body) => { res.end(String(body)); return res; };
  return res;
}

/* Routes vendor calls to the double and lets anything else fail loudly —
   a test must never reach a real vendor by accident. */
function installFetch(vendor) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const href = String(url);
    const answer = await vendor(href, options || {});
    if (!answer) throw new Error(`no vendor double for ${href}`);
    const { status = 200, body = {}, delayMs = 0, abortable = true } = answer;

    if (delayMs) {
      /* honour the caller's AbortSignal the way a real fetch does, so a
         timeout in the adapter is a real timeout here */
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        const signal = options && options.signal;
        if (abortable && signal) {
          if (signal.aborted) { clearTimeout(timer); return reject(abortError()); }
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
        }
      });
    }

    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (answer.headers || {})[String(k).toLowerCase()] || null },
      async json() { return JSON.parse(text); },
      async text() { return text; }
    };
  };
  return () => { globalThis.fetch = real; };
}

function abortError() {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/* Fresh copies of the handlers per run, so module-level state and env
   reads cannot leak between scenarios. */
function loadHandlers() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join(REPO, 'api'))) delete require.cache[key];
  }
  return {
    interpret: require(path.join(REPO, 'api', 'interpret.js')),
    search: require(path.join(REPO, 'api', 'search.js'))
  };
}

function start(port, vendor, options) {
  const opts = options || {};
  const calls = [];
  const restore = installFetch(async (href, init) => {
    calls.push({ url: href, at: Date.now() });
    return vendor(href, init, calls);
  });
  const { interpret, search } = loadHandlers();
  /* Server logs are collected so a test can assert on what production
     would have recorded — and on what it must never record. The capture
     is scoped to a handler call rather than left on the process, so a
     test's own output still reaches the terminal. */
  const logs = [];
  async function withCapturedLogs(run) {
    const original = { warn: console.warn, error: console.error, log: console.log };
    ['warn', 'error', 'log'].forEach((level) => {
      console[level] = (...args) => {
        logs.push({ level, text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
        if (opts.echoLogs) original[level](...args);
      };
    });
    try { return await run(); } finally { Object.assign(console, original); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/interpret') return await withCapturedLogs(() => interpret(req, shim(res)));
      if (url.pathname === '/api/search') return await withCapturedLogs(() => search(req, shim(res)));
    } catch (err) {
      /* a handler that throws is itself a finding: surface it, do not hide it */
      logs.push({ level: 'error', text: `HANDLER THREW: ${err && err.stack}` });
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: 'handler threw' }));
    }

    const file = path.join(REPO, url.pathname.replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      server,
      calls,
      logs,
      close: () => new Promise((done) => { restore(); server.close(done); })
    }));
  });
}

module.exports = { start, shim, installFetch, loadHandlers };
