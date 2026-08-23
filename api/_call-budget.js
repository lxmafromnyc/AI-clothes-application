/* =========================================================
   Fynd — per-search upstream call cap

   A hard ceiling on how many billable upstream calls one search may
   make, enforced by counting them rather than by trusting the code that
   makes them.

   ---------------------------------------------------------
   What this is guarding against
   ---------------------------------------------------------
   One Fynd search is not one provider call. The product search
   returns records that mostly carry no retailer link, so each one needs
   a separate offers lookup to become showable. With a limit of 24 and a
   bad batch, a single search could make one search call plus two dozen
   offer lookups — every one of them billed.

   Before this, the only thing bounding that fan-out was a wall-clock
   budget. Wall-clock is the wrong unit: it does not bound COST. A fast
   provider on a fast day is the case that spends the most, because more
   calls fit inside the same milliseconds. A slow provider is billed
   less. The safety limit was inversely proportional to speed, which is
   the opposite of what it needed to be.

   Counting calls bounds the bill directly. The time budget is kept —
   it protects the request's own latency, which is a different problem.

   ---------------------------------------------------------
   How it behaves at the ceiling
   ---------------------------------------------------------
   The search does not fail. It stops making new calls and returns what
   it already has, with `exhausted` set so the reason appears in the
   diagnostics rather than looking like a provider that ran dry. A
   shopper sees fewer results; nobody sees a surprise invoice.
   ========================================================= */

'use strict';

/* One search call plus enough offer lookups to fill a page of results,
   with a little headroom. Deliberately a small number: the fan-out is
   the expensive part and a search that needs more than this is not
   going to produce a good page anyway. */
const DEFAULT_MAX_CALLS = 12;

/* Never allow configuration to remove the cap. A deployment may tighten
   it or loosen it within reason; it may not turn it off. */
const CEILING = 40;

function maxCallsPerSearch() {
  const configured = Number(process.env.MAX_UPSTREAM_CALLS_PER_SEARCH);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_CALLS;
  return Math.min(Math.floor(configured), CEILING);
}

/* A counter with a ceiling.

     take()      claim one call. true when it may be made, false when the
                 budget is spent — callers must not call upstream on false
     used        how many were claimed
     max         the ceiling
     exhausted   whether the ceiling was reached  */
function createCallBudget(max) {
  const ceiling = Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), CEILING) : maxCallsPerSearch();
  let used = 0;
  let refused = 0;

  return {
    get max() { return ceiling; },
    get used() { return used; },
    get refused() { return refused; },
    get remaining() { return Math.max(0, ceiling - used); },
    get exhausted() { return used >= ceiling; },
    take() {
      if (used >= ceiling) { refused += 1; return false; }
      used += 1;
      return true;
    },
    report() {
      return { max: ceiling, used, refused, exhausted: used >= ceiling };
    }
  };
}

/* A budget that never refuses, for callers that do not supply one. Used
   only where a call site must keep working without a budget threaded
   through it; every path that spends money passes a real one. */
const unlimitedBudget = () => ({
  max: Infinity,
  used: 0,
  refused: 0,
  remaining: Infinity,
  exhausted: false,
  take: () => true,
  report: () => ({ max: null, used: 0, refused: 0, exhausted: false })
});

module.exports = { createCallBudget, unlimitedBudget, maxCallsPerSearch, DEFAULT_MAX_CALLS, CEILING };
