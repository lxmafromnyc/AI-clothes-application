/* =========================================================
   Fynd — fetching a feed from an authorized API

   Only for a source whose adapter names the host it may be fetched from
   (FEED_HOSTS). The rules:

     https only, to a host the adapter lists — an address anywhere else
       is refused before any connection, and so is a redirect (a
       redirect could carry the credential somewhere else)
     the credential comes from the environment (the adapter's env.token),
       is sent only as an Authorization header to that host, and never
       appears in an error, a log line or the report
     a timeout, and a size cap read as the body streams in
     an answer that isn't 200 and JSON (or JSON Lines) is a failure,
       said plainly; nothing is retried here

   The caller (scripts/sync-catalog.js) keeps the catalogue it has when
   this fails, and records the failed attempt.
   ========================================================= */

'use strict';

const { LIMITS, FeedError } = require('./import');

const TIMEOUT_MS = 60000;

function feedUrl(adapter, value) {
  let u;
  try { u = new URL(value); } catch (err) { throw new FeedError('The feed address isn’t a URL.', 'bad-url'); }
  if (u.protocol !== 'https:') throw new FeedError('The feed address must be https.', 'bad-url');
  if (u.username || u.password) throw new FeedError('Put the feed’s credential in its environment variable, not in the address.', 'bad-url');
  if (!adapter.FEED_HOSTS.includes(u.hostname)) {
    throw new FeedError(adapter.FEED_HOSTS.length
      ? `${u.hostname} isn’t a host this source may be fetched from (${adapter.FEED_HOSTS.join(', ')}).`
      : `No feed host has been authorized for ${adapter.brand} yet, so nothing is fetched. Add the authorized host to FEED_HOSTS in api/_catalog/sources/${adapter.id}.js in a reviewed change.`, 'host-not-allowed');
  }
  return u;
}

/* never let a credential out in a message */
const redact = (message, secret) => (secret ? String(message).split(secret).join('[redacted]') : String(message));

async function fetchFeed(adapter, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const address = opts.url || env[adapter.env.url];
  if (!address) throw new FeedError(`Set ${adapter.env.url} to the authorized feed’s address.`, 'not-configured');
  const url = feedUrl(adapter, address);
  const token = env[adapter.env.token] || null;
  const doFetch = opts.fetch || global.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  const maxBytes = opts.maxBytes || LIMITS.bytes;
  try {
    let res;
    try {
      res = await doFetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: Object.assign({ Accept: 'application/json, application/x-ndjson', 'User-Agent': 'FyndCatalogSync/1.0' }, token ? { Authorization: `Bearer ${token}` } : {})
      });
    } catch (err) {
      throw new FeedError(err && err.name === 'AbortError' ? 'The feed didn’t answer in time.' : `The feed couldn’t be reached: ${redact(err && err.message, token)}`, err && err.name === 'AbortError' ? 'timeout' : 'unreachable');
    }
    if (res.status >= 300 && res.status < 400) throw new FeedError(`The feed answered with a redirect (${res.status}); redirects aren’t followed.`, 'redirect');
    if (res.status === 401 || res.status === 403) throw new FeedError(`The feed refused the credential (${res.status}). Check ${adapter.env.token}.`, 'unauthorized');
    if (res.status !== 200) throw new FeedError(`The feed answered ${res.status}.`, 'bad-status');
    const type = (res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '') || '';
    if (!/^application\/(json|x-ndjson|jsonl|json-seq)\b|^text\/plain\b/i.test(type)) throw new FeedError(`The feed answered with ${type || 'no content type'}, not JSON.`, 'bad-type');
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared > maxBytes) throw new FeedError('The feed is larger than the import reads.', 'too-large');
    /* read as it streams, and stop at the cap */
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { try { await reader.cancel(); } catch (err) { /* already closed */ } throw new FeedError('The feed is larger than the import reads.', 'too-large'); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    const body = await res.text();
    if (Buffer.byteLength(body) > maxBytes) throw new FeedError('The feed is larger than the import reads.', 'too-large');
    return body;
  } catch (err) {
    if (err instanceof FeedError) { err.message = redact(err.message, token); throw err; }
    if (err && err.name === 'AbortError') throw new FeedError('The feed didn’t finish in time.', 'timeout');
    throw new FeedError(`The feed couldn’t be read: ${redact(err && err.message, token)}`, 'unreadable');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchFeed, feedUrl, redact, TIMEOUT_MS };
