/* =========================================================
   Fynd — which retailer pages the sizing reader may fetch

   A pasted link is answered from Fynd's own records and official charts
   first; reading the product's page is the step after that, and it is
   only taken where two things both hold:

     1  permission   the site's own terms have been read and don't forbid
                     it. Each domain is listed in DOMAINS below with what
                     was found, where and when. A domain not listed has
                     not been reviewed, so permission hasn't been
                     established and nothing is fetched: unreviewed is
                     treated as not permitted, never as allowed.
     2  robots.txt   the site's robots.txt (RFC 9309) allows the path for
                     Fynd's product token, FyndSizing, or failing a group
                     for it, for `*`. Checked for every address fetched —
                     the page, each redirect, each size guide. A
                     robots.txt that can't be read (a server error, no
                     answer) means nothing may be fetched; one that
                     doesn't exist (a 4xx) sets no rules of its own.

   robots.txt alone is never taken as permission: it is a crawler
   convention, not a licence, so it can only narrow what step 1 allows.

   When either says no, the reader fetches nothing and says why
   ('not-permitted', 'unreviewed', 'robots-disallowed',
   'robots-unavailable'); the lookup then answers from Fynd's record or
   the brand's official chart where it holds one, and otherwise as
   unavailable.

   To allow a domain: read its current terms of use, record the clause
   (or that there is none) in DOMAINS with the URL and date, set access
   to 'permitted' only if nothing in them forbids automated retrieval of
   a product page, and add a test. Recheck when the terms change.
   ========================================================= */

'use strict';

const store = require('../_store');

/* Fynd's product token, as robots.txt groups name it (RFC 9309 §2.2.1) */
const PRODUCT_TOKEN = 'fyndsizing';

/* RFC 9309 asks for at least 500 KiB to be parsed; a robots.txt rarely
   holds 64. Cached for up to a day (§2.4), a failure for an hour. */
const ROBOTS_MAX_BYTES = 512 * 1024;
const ROBOTS_TIMEOUT_MS = 3000;
const ROBOTS_MAX_REDIRECTS = 5;
const ROBOTS_OK_SECONDS = 24 * 60 * 60;
const ROBOTS_FAIL_SECONDS = 60 * 60;
const ROBOTS_CACHE = 'robots:v1:';

/* What each domain's terms say about automated retrieval, read by a
   person (or, for this first pass, recorded from the terms as fetched),
   with where and when. access: 'permitted' | 'not-permitted'. A domain
   matches its own host and every subdomain of it. */
const DOMAINS = {};

let overrides = null;
/* for the test suites, whose shops are invented: replaces DOMAINS */
const setPolicy = (map) => { overrides = map || null; };
const policy = () => overrides || DOMAINS;

/* The policy entry for a host: its own, or its nearest listed parent. */
function entryFor(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  const table = policy();
  const parts = h.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const domain = parts.slice(i).join('.');
    if (Object.prototype.hasOwnProperty.call(table, domain)) return Object.assign({ domain }, table[domain]);
  }
  return null;
}

/* Step 1 alone, with no request: may this host's pages be fetched at all? */
function permission(host) {
  const entry = entryFor(host);
  if (!entry) return { allowed: false, reason: 'unreviewed', domain: null };
  if (entry.access !== 'permitted') return { allowed: false, reason: 'not-permitted', domain: entry.domain, basis: entry.basis || null };
  return { allowed: true, domain: entry.domain };
}

/* ---------- robots.txt (RFC 9309) ---------- */

/* The groups of a robots.txt, each { agents: [...], rules: [{ allow, path }] }.
   Consecutive user-agent lines share one group; anything unreadable is
   skipped. */
function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  String(text || '').split(/\r\n|\r|\n/).forEach((raw) => {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if ((key === 'allow' || key === 'disallow') && current) {
      /* an empty Disallow allows everything: no rule */
      if (value || key === 'allow') current.rules.push({ allow: key === 'allow', path: value });
    }
  });
  return groups;
}

/* The rules that apply to Fynd: every group naming its product token,
   merged (§2.2.1); else every `*` group; else none. */
function rulesFor(groups) {
  const own = groups.filter((g) => g.agents.some((a) => a === PRODUCT_TOKEN));
  const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
  return chosen.reduce((all, g) => all.concat(g.rules), []);
}

/* A rule's path as a pattern: `*` any run of characters, a final `$`
   the end of the path; everything else literal, compared after
   percent-decoding the unreserved characters both sides may use. */
const normalise = (p) => p.replace(/%([0-9A-Fa-f]{2})/g, (all, hex) => {
  const c = String.fromCharCode(parseInt(hex, 16));
  return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${hex.toUpperCase()}`;
});
function matches(rulePath, path) {
  const anchored = rulePath.endsWith('$');
  const body = normalise(anchored ? rulePath.slice(0, -1) : rulePath);
  const pattern = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(normalise(path));
}

/* Allowed by these rules? The longest matching path wins; on a tie,
   Allow (§2.2.2). /robots.txt itself is always allowed. */
function allowedBy(rules, path) {
  if (path === '/robots.txt') return true;
  let best = null;
  rules.forEach((r) => {
    if (!r.path || !matches(r.path, path)) return;
    const length = r.path.length;
    if (!best || length > best.length || (length === best.length && r.allow && !best.allow)) best = { length, allow: r.allow };
  });
  return best ? best.allow : true;
}

/* The robots.txt for an origin: { state: 'rules', rules } when it was
   read, { state: 'none' } when the site has none (a 4xx), or
   { state: 'unavailable', why } when it couldn't be read — in which case
   nothing may be fetched. Read through the same guarded transport as the
   page itself, so the same addresses are refused. */
async function robotsFor(origin, doFetch, headers, clock, noCache) {
  const key = `${ROBOTS_CACHE}${origin}`;
  const cached = noCache ? null : await store.get(key).catch(() => null);
  if (cached && cached.state) return cached;
  const answer = await readRobots(origin, doFetch, headers, clock);
  if (!noCache) await store.set(key, answer, { ttlSeconds: answer.state === 'unavailable' ? ROBOTS_FAIL_SECONDS : ROBOTS_OK_SECONDS }).catch(() => {});
  return answer;
}

async function readRobots(origin, doFetch, headers, clock) {
  const left = clock ? clock.left() : ROBOTS_TIMEOUT_MS;
  if (left <= 0) return { state: 'unavailable', why: 'no-answer' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(ROBOTS_TIMEOUT_MS, left));
  let url = `${origin}/robots.txt`;
  try {
    for (let hop = 0; hop <= ROBOTS_MAX_REDIRECTS; hop += 1) {
      let response;
      try {
        response = await doFetch(url, { redirect: 'manual', signal: controller.signal, headers: Object.assign({}, headers, { Accept: 'text/plain' }) });
      } catch (err) {
        if (err && (err.code === 'EBLOCKED' || err.message === 'blocked-address')) return { state: 'unavailable', why: 'blocked-address' };
        return { state: 'unavailable', why: controller.signal.aborted ? 'no-answer' : 'unreachable' };
      }
      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers && response.headers.get && response.headers.get('location');
        if (response.discard) response.discard();
        if (!location) return { state: 'unavailable', why: 'bad-redirect' };
        let next;
        try { next = new URL(location, url); } catch (err) { return { state: 'unavailable', why: 'bad-redirect' }; }
        if (next.protocol !== 'https:' && next.protocol !== 'http:') return { state: 'unavailable', why: 'bad-redirect' };
        url = next.toString();
        continue;
      }
      /* 429 is the site asking for less, not "no rules": treated as unreadable */
      if (status === 429) { if (response.discard) response.discard(); return { state: 'unavailable', why: 'http-429' }; }
      if (status >= 400 && status < 500) { if (response.discard) response.discard(); return { state: 'none' }; }
      if (!(status >= 200 && status < 300)) { if (response.discard) response.discard(); return { state: 'unavailable', why: `http-${status}` }; }
      let text;
      try { text = await response.text(); } catch (err) { return { state: 'unavailable', why: 'unreadable' }; }
      /* the transport's own cap answers null past its limit: what arrived up to ours is enough */
      if (text === null) return { state: 'unavailable', why: 'too-large' };
      return { state: 'rules', rules: rulesFor(parseRobots(String(text).slice(0, ROBOTS_MAX_BYTES))) };
    }
    return { state: 'unavailable', why: 'too-many-redirects' };
  } finally {
    clearTimeout(timer);
  }
}

/* Both steps, for one address about to be fetched:
   { allowed: true } or { allowed: false, reason }. An address the
   transport refuses outright answers 'blocked-address', as the page
   itself would. */
async function check(url, doFetch, headers, clock, options) {
  let u;
  try { u = new URL(url); } catch (err) { return { allowed: false, reason: 'unreviewed' }; }
  const may = permission(u.hostname);
  if (!may.allowed) return may;
  const robots = await robotsFor(u.origin, doFetch, headers, clock, Boolean(options && options.noCache));
  if (robots.state === 'unavailable' && robots.why === 'blocked-address') return { allowed: false, reason: 'blocked-address', domain: may.domain };
  if (robots.state === 'unavailable') return { allowed: false, reason: 'robots-unavailable', domain: may.domain, why: robots.why };
  if (robots.state === 'rules' && !allowedBy(robots.rules, `${u.pathname}${u.search}`)) return { allowed: false, reason: 'robots-disallowed', domain: may.domain };
  return { allowed: true, domain: may.domain };
}

module.exports = { DOMAINS, PRODUCT_TOKEN, setPolicy, entryFor, permission, parseRobots, rulesFor, allowedBy, robotsFor, check };
