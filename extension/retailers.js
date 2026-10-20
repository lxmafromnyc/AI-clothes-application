/* =========================================================
   Fynd extension — the retailers the Fit panel supports

   One entry per retailer. Each says how to recognise one of its product
   pages and the product's own code, its page's canonical address (sent
   to Fynd only to look for a sizing record Fynd holds), and the origins
   the shopper may let the panel read without pressing the toolbar
   button on each page (optional_host_permissions in manifest.json —
   requested only when the shopper asks, revocable in Chrome).

   Any other site still works the ordinary way: press the toolbar
   button on the page, and the panel reads whatever size chart it
   shows — nothing about that site is assumed.

   To add a retailer: add an entry here and its origin to
   optional_host_permissions, and a fixture test in
   scripts/test-fit-panel-browser.js. Verify it against the retailer's
   live pages before calling it supported.
   ========================================================= */

/* exported FyndRetailers */
const FyndRetailers = (function () {
  'use strict';

  const RETAILERS = [
    {
      id: 'uniqlo-us',
      name: 'UNIQLO US',
      brand: 'UNIQLO',
      hosts: ['www.uniqlo.com'],
      origins: ['https://www.uniqlo.com/*'],
      /* a product page: /us/en/products/E475377-000/00, colour and size in the query */
      product(url) {
        const m = /\/us\/en\/products\/(E\d{6}-\d{3})(?:\/\d{2})?\/?$/.exec(url.pathname);
        return m ? { code: m[1], canonical: `https://www.uniqlo.com/us/en/products/${m[1]}/00` } : null;
      },
      /* where its garment chart is: UNIQLO shows "Product Size" in its size guide */
      chartHint: 'Open “Size guide” on the page and choose its Product Size tab, then press Read this page again.'
    }
  ];

  /* hosts can be widened for the browser tests (config.js on a test copy) */
  const extraHosts = typeof FYND_RETAILER_HOSTS === 'object' && FYND_RETAILER_HOSTS ? FYND_RETAILER_HOSTS : {};

  function match(href) {
    let url;
    try { url = new URL(href); } catch (err) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    for (const r of RETAILERS) {
      const hosts = r.hosts.concat(extraHosts[r.id] || []);
      if (!hosts.includes(url.hostname) && !hosts.includes(url.host)) continue;
      const product = r.product(url);
      return { retailer: r, product };
    }
    return null;
  }

  return { RETAILERS, match };
})();
