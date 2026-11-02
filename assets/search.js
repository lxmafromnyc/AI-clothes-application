/* =========================================================
   Fynd — product search (client side)

   Sends the structured intent from the interpreter to /api/search, which
   holds the product source's credentials server-side and returns only
   records that passed verification.

   What comes back is a `state`, and it decides what the page may show:

     ok               verified products; they are what is rendered
     not-configured   the endpoint answered 503, meaning no product source
                      is connected at all. Only here may the sample
                      catalogue stand in, and every row is labelled.
     unavailable      a source IS connected but the call failed. Samples
                      are NOT shown: a configured deployment showing
                      placeholder rows would read as real stock.
     empty            the source answered and nothing passed the gate.
                      Also no samples — the honest answer is "nothing
                      matched", not a page of demo items.
     limit            the plan's live searches for this period are used
                      up. Nothing was searched, so there is nothing to
                      show and nothing to stand in for it — the page
                      says what ran out and when it comes back.

   Pages: find(intent, limit, attached, { paginate: true }) asks for a
   first page that can be continued, and find(null, null, null,
   { cursor }) asks the server for the NEXT page of that same search
   (api/search.js, "Pages"). An answer carries `page`, `hasMore` and
   `nextCursor`; a cursor page adds two states of its own:

     expired          the cursor is gone (30 minutes, or never valid):
                      search again to see more
     busy             that page is already being fetched, or the
                      caller is asking for pages too fast

   Endpoint: derived from the interpreter endpoint, so one meta tag
   configures both. Override separately if needed:

     <meta name="findwear-search-api" content="https://host/api/search">
   ========================================================= */

(function (global) {
  'use strict';

  const REQUEST_TIMEOUT = 15000;

  function endpoint() {
    if (global.FINDWEAR_SEARCH_API) return String(global.FINDWEAR_SEARCH_API);
    const tag = global.document && global.document.querySelector('meta[name="findwear-search-api"]');
    const explicit = tag && tag.getAttribute('content');
    if (explicit) return explicit.trim();

    /* same deployment as the interpreter */
    const base = (global.Interpreter && global.Interpreter.endpoint)
      ? global.Interpreter.endpoint()
      : '/api/interpret';
    return base.replace(/\/interpret(\/)?$/, '/search');
  }

  const NOT_CONNECTED = 'No product source is connected yet, so these are Fynd’s sample items rather than real listings.';
  const UNAVAILABLE = 'The product search could not be reached, so no live results are available right now.';
  const FAILED = 'The product search failed, so no live results are available right now.';
  const NOTHING = 'The product search ran but returned nothing that could be verified for this request.';
  const TIMED_OUT = 'The product search found items but could not confirm their prices in time, so no live results are shown right now.';
  const OVER_LIMIT = 'You have used the live product searches your plan allows for this period.';
  const EXPIRED = 'These results have expired. Search again to see more.';
  const BUSY = 'Too many pages at once. Wait a moment and try again.';

  const answer = (state, extra) => Object.assign({ source: null, products: [], notice: null, state }, extra || {});

  /* `attached` is a manifest — each file's name, type and size. No file
     contents travel: nothing on the server can read one yet, and sending
     megabytes to be discarded would spend the shopper's bandwidth and
     put their photos somewhere for no purpose. */
  async function find(intent, limit, attached, options) {
    const o = options || {};
    const cursor = typeof o.cursor === 'string' && o.cursor ? o.cursor : null;
    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      response = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /* sends the session cookie so the search is counted against the
           shopper's own plan. The plan itself is never sent from here:
           the server reads it from the session. */
        credentials: 'include',
        body: JSON.stringify(cursor ? { cursor } : Object.assign({
          intent: intent || {},
          limit: limit || 12,
          attachments: Array.isArray(attached) ? attached : []
        }, o.paginate ? { paginate: true } : {})),
        signal: controller.signal
      });
      clearTimeout(timer);
    } catch (err) {
      /* the endpoint could not be reached at all. Whether a source is
         configured behind it is unknowable from here, so this is treated
         as an outage rather than as an unconfigured deployment: showing
         samples on what may be a live site is the worse mistake. */
      return answer('unavailable', { notice: UNAVAILABLE });
    }

    /* 503 is this endpoint's own "no product source is configured", and
       404 means it is not deployed. Both mean nothing is connected, which
       is the one case the sample catalogue may stand in for. */
    if (response.status === 503 || response.status === 404) {
      return answer('not-configured', { notice: NOT_CONNECTED });
    }
    /* Out of allowance. Distinct from an outage on purpose: this is
       about the shopper's plan and has an answer — wait for the reset,
       or move up a plan — where an outage has neither. */
    if (cursor && (response.status === 410 || response.status === 409)) {
      return answer(response.status === 410 ? 'expired' : 'busy', { notice: response.status === 410 ? EXPIRED : BUSY });
    }
    if (response.status === 429) {
      const detail = await response.json().catch(() => ({}));
      /* pacing on Load more, not the plan's allowance */
      if (detail && detail.reason === 'rate-limited') return answer('busy', { notice: BUSY });
      return answer('limit', {
        notice: OVER_LIMIT,
        usage: detail.usage || null,
        upgrade: Boolean(detail.upgrade)
      });
    }
    if (!response.ok) {
      /* a search whose sellers' prices could not be confirmed in time says
         so, rather than reading as an outage or as "nothing matched" */
      const detail = await response.json().catch(() => ({}));
      const late = detail && detail.reason === 'timeout' && detail.stage === 'offers';
      return answer('unavailable', { notice: late ? TIMED_OUT : FAILED });
    }

    try {
      const data = await response.json();
      const products = Array.isArray(data.products) ? data.products : [];
      /* only present on a paginated answer */
      const paging = typeof data.page === 'number' ? {
        page: data.page,
        hasMore: Boolean(data.hasMore && data.nextCursor),
        nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null,
        pagination: data.pagination || null
      } : {};
      if (!products.length) {
        /* the source answered but had nothing verifiable for this request */
        return answer('empty', Object.assign({ source: data.source || null, notice: NOTHING, rejected: data.rejected || null, usage: data.usage || null }, paging));
      }
      return Object.assign({ source: data.source || 'provider', products, notice: null, state: 'ok', usage: data.usage || null }, paging);
    } catch (err) {
      return answer('unavailable', { notice: FAILED });
    }
  }

  global.ProductSearch = { find, endpoint };
})(typeof window !== 'undefined' ? window : globalThis);
