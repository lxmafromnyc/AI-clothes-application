#!/usr/bin/env node
/* =========================================================
   Fynd — may a retailer's page be shown inside Find Fit?

     node scripts/check-embed.js [url ...]

   Asks each page once, as a browser would, and reports what its
   headers say about being framed by another site: X-Frame-Options and
   Content-Security-Policy frame-ancestors. Run it from a machine that
   can reach the retailer; it changes nothing and sends nothing but a
   plain GET.

   Even a page that may be framed can't tell Find Fit which product was
   clicked inside the frame (the browser keeps another origin's page to
   itself), so a frame alone can't start a sizing lookup — which is why
   Find Fit browses products natively (api/_sizing/brands).
   ========================================================= */

'use strict';

const DEFAULTS = ['https://www.uniqlo.com/us/en/', 'https://www.uniqlo.com/us/en/products/E475378-000/00'];

async function check(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; FyndEmbedCheck/1.0)' }, signal: AbortSignal.timeout(15000) });
    const xfo = res.headers.get('x-frame-options');
    const csp = res.headers.get('content-security-policy') || '';
    const ancestors = (/frame-ancestors[^;]*/i.exec(csp) || [null])[0];
    const blocked = (xfo && /deny|sameorigin/i.test(xfo)) || (ancestors && !/\*/.test(ancestors));
    console.log(`${url}\n  status ${res.status}\n  x-frame-options: ${xfo || '(none)'}\n  frame-ancestors: ${ancestors || '(none)'}\n  framing by Find Fit: ${blocked ? 'refused' : 'not refused by headers'}\n`);
  } catch (err) {
    console.log(`${url}\n  could not be read: ${err.message}\n`);
  }
}

(async () => {
  for (const url of process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS) await check(url);
})();
