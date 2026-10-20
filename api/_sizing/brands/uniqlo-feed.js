/* =========================================================
   Fynd — UNIQLO's authorized catalogue, loaded once

   The committed catalogue for the uniqlo-us source (api/_catalog), read
   and checked once per process, for the two places that need it: the
   UNIQLO brand module (uniqlo.js), and the official-chart fallback
   (../official-charts.js), which needs a product's category and line
   from the source before UNIQLO's general chart can stand in for the
   product's own. Whether it may be served is asked at each use, since a
   process can outlive the catalogue's freshness.
   ========================================================= */

'use strict';

const adapter = require('../../_catalog/sources/uniqlo-us');
const store = require('../../_catalog/store');

const LOADED = store.load(adapter);
const byCodeMap = new Map(LOADED.products.map((p) => [p.code, p]));

const freshness = (now) => store.freshness(LOADED, adapter, now);
/* a product of the catalogue, only while the catalogue may be served */
const byCode = (code, now) => (freshness(now).served ? byCodeMap.get(code) || null : null);

module.exports = { adapter, LOADED, freshness, byCode };
