/* =========================================================
   Fynd — reading a JSON request body

   The billing endpoints all take a small JSON object and all have the
   same three cases to cover: a host that already parsed the body, a
   host that left it a string, and a host that left it a stream. One
   reader rather than one per endpoint.

   Nothing here validates: every endpoint shapes its own fields, because
   what is acceptable is a property of the endpoint and not of JSON.

   The webhook does NOT use this. It needs the bytes exactly as Stripe
   sent them, so it reads the raw stream itself — see _stripe.readRawBody.
   ========================================================= */

'use strict';

const MAX_BODY = 10000;

function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(String(req.body))); } catch (err) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > MAX_BODY) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (err) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = { readJson, MAX_BODY };
