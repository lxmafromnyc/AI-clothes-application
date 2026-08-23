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
     limit            the account has used its live-search allowance. The
                      server refused, and the reply carries what was hit,
                      how much of it, and when it comes back. NOT an
                      outage and never sample items: the shopper has not
                      been failed, they have run out.

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
  const LIMIT_REACHED = 'You have used your live product searches for now.';
  const ALREADY_RUNNING = 'That search is already running — one moment.';

  const answer = (state, extra) => Object.assign({ source: null, products: [], notice: null, state }, extra || {});

  /* `attached` is a manifest — each file's name, type and size. No file
     contents travel: nothing on the server can read one yet, and sending
     megabytes to be discarded would spend the shopper's bandwidth and
     put their photos somewhere for no purpose. */
  async function find(intent, limit, attached, submissionKey) {
    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      /* The account's credential, and a key identifying THIS submission.
         The key is what lets the server recognise a double-click or a
         retry as the same search rather than as a second one — see
         api/_usage.js. It is generated per submission by the caller, not
         here, so a retry of the same submission carries the same key. */
      const headers = Object.assign(
        { 'Content-Type': 'application/json' },
        (global.Usage && global.Usage.authHeaders) ? global.Usage.authHeaders() : {}
      );
      if (submissionKey) headers['Idempotency-Key'] = submissionKey;

      response = await fetch(endpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          intent: intent || {},
          limit: limit || 12,
          attachments: Array.isArray(attached) ? attached : []
        }),
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

    /* Out of allowance. Distinct from an outage: nothing is broken, and
       showing sample items here would suggest the search had run. */
    if (response.status === 429) {
      const limit = await response.json().catch(() => null);
      if (limit && global.Usage) global.Usage.refresh();
      return answer('limit', {
        limit,
        notice: (global.Usage && limit) ? global.Usage.limitMessage(limit) : LIMIT_REACHED
      });
    }

    /* The same submission is already running. Treated as an outage would
       be wrong — the original is about to answer — so it says so and
       nothing is charged. */
    if (response.status === 409) {
      const body = await response.json().catch(() => null);
      if (body && body.usage && global.Usage) global.Usage.absorb(body.usage);
      return answer('duplicate', { notice: ALREADY_RUNNING });
    }

    if (!response.ok) {
      return answer('unavailable', { notice: FAILED });
    }

    try {
      const data = await response.json();

      /* The meter is the server's number, adopted as-is. The page never
         adds one to its own tally: a second opinion would drift the
         moment a search happened in another tab. */
      if (data && data.usage && global.Usage) global.Usage.absorb(data.usage);

      const products = Array.isArray(data.products) ? data.products : [];
      if (!products.length) {
        /* the source answered but had nothing verifiable for this request */
        return answer('empty', { source: data.source || null, notice: NOTHING, rejected: data.rejected || null });
      }
      return { source: data.source || 'provider', products, notice: null, state: 'ok' };
    } catch (err) {
      return answer('unavailable', { notice: FAILED });
    }
  }

  global.ProductSearch = { find, endpoint };
})(typeof window !== 'undefined' ? window : globalThis);
