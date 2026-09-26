/* =========================================================
   Fynd — one provider call, inside the request's clock

   /api/search answers within its budget (api/search.js), and says that
   every provider call is bounded by what is left of it. OpenWeb Ninja
   honoured that; SerpApi and Serper did not. Each gave every call its
   own fixed 15 seconds and ignored the deadline it was handed, so a
   slow answer ran on past the point the browser had stopped listening,
   and when the 15 seconds did run out the abort surfaced as the bare
   runtime message "This operation was aborted" — which names neither
   the provider nor the ceiling, and reads the same as any other abort.

   Two things, shared so the adapters cannot drift apart again:

     legTimeout   how long one call may take: its own ceiling, never
                  past the request's deadline, and short of it by a
                  reserve when the caller still has work to do after it.
                  No deadline means exactly what it always meant — the
                  call's own ceiling — so a caller that never passes one
                  (catalogue discovery, which carries its own clock) is
                  unaffected.
     fetchWithin  one fetch under that timeout, whose timeout is an
                  error that SAYS it is a timeout, and which provider,
                  and how long it was given. A spent budget refuses
                  before a connection is opened.

   Neither changes what a timeout MEANS. It is a fault to report, not a
   sign the allowance is spent — the message deliberately carries none
   of the words product-source.js reads as "out of searches" — so a
   timeout never sends a search to the fallback. Nothing about the
   message ever carries a URL, which on SerpApi holds the key.
   ========================================================= */

'use strict';

/* The least time worth opening a connection with. Below this the call
   would be aborted before any provider could answer, costing a request
   and returning nothing. */
const MIN_CALL_WINDOW_MS = 250;

function legTimeout(deadline, reserve, ceiling) {
  const own = Number(ceiling) > 0 ? Number(ceiling) : 15000;
  if (!deadline) return own;
  const remaining = Number(deadline) - Date.now();
  if (remaining < MIN_CALL_WINDOW_MS) return 0;
  const room = reserve && remaining - reserve >= MIN_CALL_WINDOW_MS ? remaining - reserve : remaining;
  return Math.min(own, room);
}

/* The two errors a clock produces, told apart from everything else by
   their own wording, so a benchmark row or a server log says "timed
   out" rather than "aborted". */
const TIMED_OUT = /did not answer within|ran out before the request was made/;

async function fetchWithin(who, url, init, ms) {
  if (!(ms > 0)) {
    throw new Error(`${who}: the time budget for this search ran out before the request was made`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }));
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${who} did not answer within ${Math.round(ms)}ms (timed out)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const timedOut = (err) => TIMED_OUT.test(err && err.message ? err.message : String(err));

module.exports = { legTimeout, fetchWithin, timedOut, MIN_CALL_WINDOW_MS };
