/* =========================================================
   Fynd — durable key/value store

   Everything the billing system has to remember outlives a request:
   who a user is, which Stripe customer they are, what plan their
   subscription entitles them to, how much of it they have used, and
   which webhook deliveries have already been applied. A serverless
   function keeps nothing between invocations, so all of it lives here.

   ---------------------------------------------------------
   Which driver runs
   ---------------------------------------------------------
   1. Redis over HTTP — Vercel KV or Upstash. Selected when a URL and a
      token are both present, under either naming:

        KV_REST_API_URL          / KV_REST_API_TOKEN            (Vercel KV)
        UPSTASH_REDIS_REST_URL   / UPSTASH_REDIS_REST_TOKEN     (Upstash)

      Chosen because it is reachable with fetch alone: this repository
      has no build step and no node_modules, and adding a database
      driver would give it both.

   2. Memory, when nothing is configured. It survives one warm function
      instance and nothing more, which is right for `node scripts/…`
      and for reading the site locally, and wrong for anything else.
      `durable()` answers false so callers can say so out loud rather
      than quietly appearing to have saved something.

   The store deliberately exposes very little: get, set, delete, an
   atomic add, and a set-if-absent. Two of those carry the weight —
   `add` is what makes a usage counter safe under concurrent requests,
   and `setIfAbsent` is what makes a duplicate webhook delivery a no-op.
   Doing either by read-then-write would be a race, so neither is.
   ========================================================= */

'use strict';

const memory = new Map();

const now = () => Date.now();

function memoryRead(key) {
  const row = memory.get(key);
  if (!row) return null;
  if (row.expires && row.expires <= now()) {
    memory.delete(key);
    return null;
  }
  return row;
}

/* ---------------------------------------------------------
   The Redis-over-HTTP driver
   --------------------------------------------------------- */

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url.trim() || !token.trim()) return null;
  return { url: url.trim().replace(/\/+$/, ''), token: token.trim() };
}

/* One command, sent as the JSON array the REST API takes. Errors are
   thrown rather than swallowed: a store that silently fails to write
   would hand out a plan nobody paid for, or forget one somebody did. */
async function redisCommand(config, command) {
  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command.map((part) => String(part)))
  });

  if (!response.ok) {
    /* the command is named, never its arguments — a value here may be a
       session token or a Stripe customer id */
    throw new Error(`store ${command[0]} failed with ${response.status}`);
  }

  const payload = await response.json();
  if (payload && payload.error) throw new Error(`store ${command[0]} rejected`);
  return payload ? payload.result : null;
}

/* ---------------------------------------------------------
   The interface both drivers answer
   --------------------------------------------------------- */

/* JSON in, JSON out. Callers store objects; nothing below this line
   cares what shape they are. */
async function get(key) {
  const config = redisConfig();
  if (config) {
    const raw = await redisCommand(config, ['GET', key]);
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  }
  const row = memoryRead(key);
  return row ? JSON.parse(row.value) : null;
}

async function set(key, value, options) {
  const ttl = options && Number(options.ttlSeconds) > 0 ? Math.floor(Number(options.ttlSeconds)) : 0;
  const raw = JSON.stringify(value);
  const config = redisConfig();
  if (config) {
    await redisCommand(config, ttl ? ['SET', key, raw, 'EX', ttl] : ['SET', key, raw]);
    return true;
  }
  memory.set(key, { value: raw, expires: ttl ? now() + ttl * 1000 : 0 });
  return true;
}

/* Writes only when the key is absent, and reports which happened.

   This is the whole of the webhook's duplicate protection: Stripe
   retries a delivery it did not hear a 2xx for, and at-least-once means
   the same event can arrive twice, or twice at the same moment on two
   instances. Whoever wins this write applies the event; the other one
   sees false and stops. A read followed by a write would let both
   through. */
async function setIfAbsent(key, value, options) {
  const ttl = options && Number(options.ttlSeconds) > 0 ? Math.floor(Number(options.ttlSeconds)) : 0;
  const raw = JSON.stringify(value);
  const config = redisConfig();
  if (config) {
    const command = ttl ? ['SET', key, raw, 'EX', ttl, 'NX'] : ['SET', key, raw, 'NX'];
    return (await redisCommand(config, command)) !== null;
  }
  if (memoryRead(key)) return false;
  memory.set(key, { value: raw, expires: ttl ? now() + ttl * 1000 : 0 });
  return true;
}

async function remove(key) {
  const config = redisConfig();
  if (config) {
    await redisCommand(config, ['DEL', key]);
    return true;
  }
  memory.delete(key);
  return true;
}

/* Atomic increment, returning the new total. Usage counters are read by
   every search and every interpretation, sometimes at once from the same
   shopper's two tabs; incrementing them by hand would lose counts and
   hand out more than the plan allows.

   The expiry is set only when the counter is created — reapplying it on
   every increment would push the reset time forward all day and the
   period would never end. */
async function add(key, amount, options) {
  const step = Math.floor(Number(amount) || 0);
  const ttl = options && Number(options.ttlSeconds) > 0 ? Math.floor(Number(options.ttlSeconds)) : 0;
  const config = redisConfig();

  if (config) {
    const total = Number(await redisCommand(config, ['INCRBY', key, step]));
    if (ttl && total === step) await redisCommand(config, ['EXPIRE', key, ttl]);
    return total;
  }

  const row = memoryRead(key);
  const total = (row ? Number(row.value) : 0) + step;
  memory.set(key, {
    value: String(total),
    expires: row ? row.expires : (ttl ? now() + ttl * 1000 : 0)
  });
  return total;
}

async function readNumber(key) {
  const config = redisConfig();
  if (config) {
    const raw = await redisCommand(config, ['GET', key]);
    return raw === null || raw === undefined ? 0 : (Number(raw) || 0);
  }
  const row = memoryRead(key);
  return row ? (Number(row.value) || 0) : 0;
}

/* Which driver is running, so an endpoint can say plainly that nothing
   it just wrote will still be there tomorrow. */
const durable = () => Boolean(redisConfig());
const driver = () => (redisConfig() ? 'redis' : 'memory');

/* Tests own the memory driver's contents; nothing in api/ calls this. */
const reset = () => memory.clear();

module.exports = { get, set, setIfAbsent, remove, add, readNumber, durable, driver, reset };
