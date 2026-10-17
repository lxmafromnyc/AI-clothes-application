#!/usr/bin/env node
/* =========================================================
   Fynd — copy the shared sizing code into the browser extension

   Chrome loads an unpacked extension from its own folder only, so the
   extension carries copies of three files the site and server use:

     assets/sizing-tables.js   how a size table is recognised and labelled
     assets/fynd-payload.js    the chart payload, checked both ways
     assets/size-chart.js      how a chart is drawn

   Run after changing any of them:  node scripts/sync-extension.js
   test-extension fails while a copy differs from its original.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SHARED = ['sizing-tables.js', 'fynd-payload.js', 'size-chart.js'];

function sync() {
  fs.mkdirSync(path.join(REPO, 'extension/vendor'), { recursive: true });
  SHARED.forEach((name) => fs.copyFileSync(path.join(REPO, 'assets', name), path.join(REPO, 'extension/vendor', name)));
}

if (require.main === module) {
  sync();
  console.log(`Copied ${SHARED.join(', ')} into extension/vendor/.`);
}

module.exports = { SHARED, sync };
