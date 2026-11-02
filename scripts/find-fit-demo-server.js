/* Serves a checkout of the site with Fynd's real API handlers (auth, account,
   fit profile, size recommendation) on a free local port, for the Find Fit
   walkthrough and link check (scripts/find-fit-walkthrough.js,
   scripts/find-fit-links.js). REPO names another checkout, e.g. main. */
'use strict';
const path = require('path');
const REPO = process.env.REPO || path.join(__dirname, '..');
process.env.AUTH_SECRET = 'screenshot-secret-of-sufficient-length';
['RESEND_API_KEY','POSTMARK_SERVER_TOKEN','ALLOWED_ORIGIN','OPENAI_API_KEY','GEMINI_API_KEY'].forEach((k) => delete process.env[k]);
const http = require('http'); const fs = require('fs');
const H = {};
for (const n of ['auth', 'account', 'fit-profile', 'size-recommendation']) H[`/api/${n}`] = require(path.join(REPO, 'api', n));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
function readBody(req) { return new Promise((r) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => r(d)); }); }
module.exports = function serve() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const h = H[u.pathname];
    if (h) {
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (p) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(p)); return res; };
      const raw = req.method === 'POST' ? await readBody(req) : '';
      if (raw) { try { req.body = JSON.parse(raw); } catch (e) { req.body = raw; } }
      req.query = Object.fromEntries(u.searchParams);
      try { await h(req, res); } catch (e) { if (!res.writableEnded) { res.statusCode = 500; res.end('{}'); } }
      if (!res.writableEnded) res.end();
      return;
    }
    if (u.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('{}'); }
    const file = path.join(REPO, u.pathname === '/' ? 'index.html' : u.pathname.slice(1));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
};
