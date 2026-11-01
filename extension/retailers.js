/* =========================================================
   Fynd extension — retailer modules

   Any site can be read: press Fynd's toolbar button on a product page and
   the panel reads the size tables it shows (collect.js). A module here
   only adds what Fynd knows about one retailer:

     product(url)  recognises one of its product pages, and the product's
                   own code
     brand         the brand its products are sold under
     chartHint     where its garment chart is, when the page shows none

   Recognising an address is all a module does: it gives Fynd no access
   to the site, and says nothing about whether its live pages can be
   read. Each module records whether that was checked against live
   pages (liveChecked) — none has been yet.

   To add a retailer: add an entry, and a test in
   scripts/test-extension.js. Nothing else changes.
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
      liveChecked: false,
      /* /us/en/products/E475377-000/00, colour and size in the query */
      product(url) {
        const m = /\/us\/en\/products\/(E\d{6}-\d{3})(?:\/\d{2})?\/?$/.exec(url.pathname);
        return m ? { code: m[1], canonical: `https://www.uniqlo.com/us/en/products/${m[1]}/00` } : null;
      },
      chartHint: 'Open “Size guide” on the page and choose its Product Size tab, then press Read this page.'
    },
    {
      id: 'zara-us',
      name: 'Zara US',
      brand: 'Zara',
      hosts: ['www.zara.com'],
      liveChecked: false,
      /* /us/en/basic-medium-weight-t-shirt--02-p01887411.html */
      product(url) {
        const m = /^\/us\/en\/[^/]*-p(\d{8})\.html$/.exec(url.pathname);
        return m ? { code: m[1], canonical: `https://www.zara.com${url.pathname}` } : null;
      },
      chartHint: 'Zara shows “Product measurements” under the size selector: open it, switch it to inches if you like, then press Read this page.'
    },
    {
      id: 'hm-us',
      name: 'H&M US',
      brand: 'H&M',
      hosts: ['www2.hm.com'],
      liveChecked: false,
      /* /en_us/productpage.0685816001.html: product 0685816, colour 001 */
      product(url) {
        const m = /^\/en_us\/productpage\.(\d{7})(\d{3})\.html$/.exec(url.pathname);
        return m ? { code: m[1], canonical: `https://www2.hm.com/en_us/productpage.${m[1]}${m[2]}.html` } : null;
      },
      chartHint: 'H&M’s “Size guide” shows body measurements only; Fynd can’t compare those with a garment.'
    },
    {
      id: 'nike-us',
      name: 'Nike US',
      brand: 'Nike',
      hosts: ['www.nike.com'],
      liveChecked: false,
      /* /t/sportswear-premium-essentials-mens-t-shirt-KvYyYtT6/IH1121-491 */
      product(url) {
        const m = /^\/t\/[^/]+\/([A-Z0-9]{6})-\d{3}\/?$/.exec(url.pathname);
        return m ? { code: m[1], canonical: `https://www.nike.com${url.pathname}` } : null;
      },
      chartHint: 'Nike’s size guide shows body measurements only; Fynd can’t compare those with a garment.'
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
      return { retailer: r, product: r.product(url) };
    }
    return null;
  }

  return { RETAILERS, match };
})();
