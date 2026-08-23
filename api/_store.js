/* =========================================================
   FindWear — usage store

   Where the counters live. Follows the same adapter shape as
   providers/product-source.js: one interface, an adapter per backend,
   and the choice made by what is in the environment.

   ---------------------------------------------------------
   Why this cannot be a variable, a file, or the browser
   ---------------------------------------------------------
   The API is a set of serverless functions. Two requests from the same
   shopper may be served by two different instances, on different
   machines, that share no memory and no disk, and an instance is
   discarded without warning. A counter kept in a module variable is
   therefore not a limit — it is a suggestion that resets whenever the
   platform feels like it. A counter kept in the browser is not a limit
   at all, because the browser is the thing being limited.

   So the store has to be external, shared by every instance, and — the
   part that is easy to miss — able to increment ATOMICALLY.

   ---------------------------------------------------------
   Why atomic increment, specifically
   ---------------------------------------------------------
   Read-then-write cannot enforce a limit under concurrency. Two requests
   that both read "2 of 3 used" will both conclude they may proceed, and
   both write 3. The shopper gets four searches from a limit of three,
   and nothing in the logs looks wrong.

   INCRBY returns the value AFTER adding, in one indivisible step, so of
   two simultaneous requests one is told 3 and the other 4. The one told
   4 knows it went over and hands the slot back. That single property is
   what makes the whole enforcement layer correct, and it is why the
   interface below is built around it rather than around get/set.

   ---------------------------------------------------------
   Adapters
   ---------------------------------------------------------
     redis   Upstash Redis over its REST API. The production choice.
             REST rather than a TCP client on purpose: serverless
             functions cannot hold a connection pool across invocations,
             and a per-invocation TCP handshake to Redis costs more than
             the HTTP call it replaces.

               UPSTASH_REDIS_REST_URL
               UPSTASH_REDIS_REST_TOKEN

             Any Redis-compatible service with a REST endpoint of the
             same shape works; Vercel KV is this API.

     memory  In-process. For tests and local development ONLY. It is
             correct within one process — Node runs the read-modify-write
             below without interruption, so it is genuinely atomic here —
             and it is worthless across instances. Selected only when no
             Redis is configured, and it says so in the log once.
   ========================================================= */

'use strict';

/* ---------------------------------------------------------
   The interface every adapter implements

     incrBy(key, amount, ttlSeconds) -> number   value AFTER adding
     decrBy(key, amount)             -> number   value AFTER subtracting
     get(key)                        -> number   0 when absent
     claim(key, value, ttlSeconds)   -> boolean  true if WE set it
     read(key)                       -> string|null
     write(key, value, ttlSeconds)   -> void
     del(key)                        -> void

   `claim` is set-if-absent. It returns true only for the caller that
   actually created the key, which is how one submission out of a
   double-click is allowed to proceed and the other is recognised as a
   repeat.
   --------------------------------------------------------- */

/* ---------------------------------------------------------
   memory
   --------------------------------------------------------- */

function createMemoryStore() {
  /* key -> { value, expiresAt } */
  const cells = new Map();

  const live = (key) => {
    const cell = cells.get(key);
    if (!cell) return null;
    if (cell.expiresAt && cell.expiresAt <= Date.now()) { cells.delete(key); return null; }
    return cell;
  };

  const ttlToMs = (ttl) => (Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : 0);

  return {
    name: 'memory',
    durable: false,
    configured: () => true,

    /* Node will not interleave another request between these lines, so
       this is atomic in the only sense available to one process. */
    async incrBy(key, amount, ttlSeconds) {
      const cell = live(key);
      const next = (cell ? Number(cell.value) : 0) + Number(amount);
      cells.set(key, { value: next, expiresAt: cell ? cell.expiresAt : ttlToMs(ttlSeconds) });
      return next;
    },

    async decrBy(key, amount) {
      const cell = live(key);
      const next = (cell ? Number(cell.value) : 0) - Number(amount);
      cells.set(key, { value: next, expiresAt: cell ? cell.expiresAt : 0 });
      return next;
    },

    async get(key) {
      const cell = live(key);
      return cell ? Number(cell.value) : 0;
    },

    async claim(key, value, ttlSeconds) {
      if (live(key)) return false;
      cells.set(key, { value: String(value), expiresAt: ttlToMs(ttlSeconds) });
      return true;
    },

    async read(key) {
      const cell = live(key);
      return cell ? String(cell.value) : null;
    },

    async write(key, value, ttlSeconds) {
      cells.set(key, { value: String(value), expiresAt: ttlToMs(ttlSeconds) });
    },

    async del(key) {
      cells.delete(key);
    },

    /* tests only; never called by a handler */
    _reset() { cells.clear(); },
    _size() { return cells.size; }
  };
}

/* ---------------------------------------------------------
   redis (Upstash REST)
   --------------------------------------------------------- */

const REST_URL = () => String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const REST_TOKEN = () => String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();

function createRedisStore() {
  /* One round trip for a list of commands. Upstash answers a pipeline
     with an array of { result } | { error } in the order sent. */
  async function pipeline(commands) {
    const response = await fetch(`${REST_URL()}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REST_TOKEN()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      /* the URL is not logged: it carries the database identifier */
      throw new Error(`usage store refused the write (${response.status}) ${detail.slice(0, 200)}`);
    }
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : [payload];
    rows.forEach((row) => {
      if (row && row.error) throw new Error(`usage store command failed: ${String(row.error).slice(0, 200)}`);
    });
    return rows.map((row) => (row ? row.result : null));
  }

  return {
    name: 'redis',
    durable: true,
    configured: () => Boolean(REST_URL() && REST_TOKEN()),

    /* INCRBY then EXPIRE ... NX: the expiry is set when the counter is
       created and never pushed forward afterwards, so a busy account's
       window still ends when the calendar says it does. */
    async incrBy(key, amount, ttlSeconds) {
      const commands = [['INCRBY', key, String(amount)]];
      if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
        commands.push(['EXPIRE', key, String(Math.ceil(ttlSeconds)), 'NX']);
      }
      const [value] = await pipeline(commands);
      return Number(value);
    },

    async decrBy(key, amount) {
      const [value] = await pipeline([['DECRBY', key, String(amount)]]);
      return Number(value);
    },

    async get(key) {
      const [value] = await pipeline([['GET', key]]);
      return value == null ? 0 : Number(value);
    },

    async claim(key, value, ttlSeconds) {
      const command = ['SET', key, String(value), 'NX'];
      if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) command.push('EX', String(Math.ceil(ttlSeconds)));
      const [result] = await pipeline([command]);
      /* Redis answers OK when it set the key and nil when it did not */
      return result === 'OK';
    },

    async read(key) {
      const [value] = await pipeline([['GET', key]]);
      return value == null ? null : String(value);
    },

    async write(key, value, ttlSeconds) {
      const command = ['SET', key, String(value)];
      if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) command.push('EX', String(Math.ceil(ttlSeconds)));
      await pipeline([command]);
    },

    async del(key) {
      await pipeline([['DEL', key]]);
    }
  };
}

/* ---------------------------------------------------------
   Selection
   --------------------------------------------------------- */

const ADAPTERS = { redis: createRedisStore, memory: createMemoryStore };

let cached = null;
let cachedKind = null;
let warned = false;

/* Redis when it is configured, memory otherwise. USAGE_STORE names an
   adapter explicitly, which is how a test pins the memory store and how
   a deployment can refuse to fall back. */
function storeKind() {
  const named = String(process.env.USAGE_STORE || '').trim().toLowerCase();
  if (named && ADAPTERS[named]) return named;
  return createRedisStore().configured() ? 'redis' : 'memory';
}

function getStore() {
  const kind = storeKind();
  if (cached && cachedKind === kind) return cached;
  cached = ADAPTERS[kind]();
  cachedKind = kind;
  if (kind === 'memory' && !warned && process.env.NODE_ENV !== 'test') {
    warned = true;
    /* Once, and loudly. A deployment running on this is not enforcing
       anything across instances, and that must not be discovered later. */
    console.warn('FindWear usage store is in-process memory: limits are NOT enforced across instances. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  }
  return cached;
}

/* tests swap adapters between cases */
function resetStore() {
  if (cached && cached._reset) cached._reset();
  cached = null;
  cachedKind = null;
  warned = false;
}

module.exports = { getStore, resetStore, storeKind, createMemoryStore, createRedisStore };
