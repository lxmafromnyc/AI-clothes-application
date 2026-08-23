/* =========================================================
   FindWear — product search (client side)

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

  const NOT_CONNECTED = 'No product source is connected yet, so these are FindWear’s sample items rather than real listings.';
  const UNAVAILABLE = 'The product search could not be reached, so no live results are available right now.';
  const FAILED = 'The product search failed, so no live results are available right now.';
  const NOTHING = 'The product search ran but returned nothing that could be verified for this request.';

  const answer = (state, extra) => Object.assign({ source: null, products: [], notice: null, state }, extra || {});

  /* `attached` is a manifest — each file's name, type and size. No file
     contents travel: nothing on the server can read one yet, and sending
     megabytes to be discarded would spend the shopper's bandwidth and
     put their photos somewhere for no purpose. */
  async function find(intent, limit, attached) {
    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      response = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    if (!response.ok) {
      return answer('unavailable', { notice: FAILED });
    }

    try {
      const data = await response.json();
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
