/* =========================================================
   FindWear — product search (client side)

   Sends the structured intent from the interpreter to /api/search, which
   holds the product source's credentials server-side and returns only
   records that passed verification.

   When no product source is configured the endpoint answers 503, and this
   module reports that plainly. FindWear then falls back to its sample
   catalogue, which is labelled as such on every card — a placeholder row
   is never presented as a real listing.

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
  const UNAVAILABLE = 'The product source could not be reached, so these are FindWear’s sample items rather than real listings.';

  async function find(intent, limit) {
    let response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      response = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: intent || {}, limit: limit || 12 }),
        signal: controller.signal
      });
      clearTimeout(timer);
    } catch (err) {
      return { source: null, products: [], notice: NOT_CONNECTED };
    }

    if (response.status === 503 || response.status === 404) {
      return { source: null, products: [], notice: NOT_CONNECTED };
    }
    if (!response.ok) {
      return { source: null, products: [], notice: UNAVAILABLE };
    }

    try {
      const data = await response.json();
      const products = Array.isArray(data.products) ? data.products : [];
      if (!products.length) {
        /* the source answered but had nothing verifiable for this request */
        return { source: data.source || null, products: [], notice: null, empty: true };
      }
      return { source: data.source || 'provider', products, notice: null };
    } catch (err) {
      return { source: null, products: [], notice: UNAVAILABLE };
    }
  }

  global.ProductSearch = { find, endpoint };
})(typeof window !== 'undefined' ? window : globalThis);
