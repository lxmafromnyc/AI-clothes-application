#!/usr/bin/env node
/* =========================================================
   Fynd — are the product photos actually loadable?

   Every product /api/search returns carries an image URL: the gate in
   api/_providers/product-source.js drops any record without one, so a
   card on the page always has a src. Whether the browser can FETCH that
   src is a different question, and the answer decides which fix is
   needed:

     an invalid URL          the provider handed us a dead link
     a hotlink block         the host serves the image, but not to us
     a mixed-content URL     an http image on an https page: the browser
                             refuses it before a request is ever made
     a working URL           the photo is fine, look elsewhere

   This reads a SAVED /api/search reply. It needs no API key, spends no
   provider quota, and sends nothing anywhere except a request for each
   image, once plainly and once carrying the site's own Referer — which
   is what tells a hotlink block apart from a dead URL.

   Run it from a machine with an ordinary internet connection: behind a
   proxy that refuses hosts, every photo comes back BLOCKED and the
   verdict is about the proxy rather than about the image.

   Usage
     node scripts/probe-images.js reply.json
     node scripts/probe-images.js reply.json --site https://example.github.io
     node scripts/probe-images.js --url https://host/photo.jpg

   Where reply.json is whatever /api/search answered, saved as-is:
     curl -sS -X POST "$SITE/api/search" -H 'content-type: application/json' \
       -d '{"intent":{"categories":["jacket"]},"limit":12}' > reply.json
   ========================================================= */

'use strict';

const fs = require('fs');

const TIMEOUT = 10000;
const CONCURRENCY = 4;
const DEFAULT_SITE = 'https://lxmafromnyc.github.io';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const site = flag('--site') || DEFAULT_SITE;

/* Every image URL in a saved reply, in the order the page would draw
   them. Only products are read: the diagnostic blocks, the usage counters
   and everything else in the reply are left alone. */
function urlsFrom(file) {
  const reply = JSON.parse(fs.readFileSync(file, 'utf8'));
  const products = Array.isArray(reply.products) ? reply.products : [];
  return products.map((p, i) => ({ label: `${i + 1}. ${String(p.name || '').slice(0, 40)}`, url: p.imageUrl }));
}

/* One request, with its headers read and its body dropped: this asks
   whether the host will serve the image, not what the image is. */
async function ask(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: referer ? { Referer: referer } : {}
    });
    if (response.body) await response.body.cancel();
    return { status: response.status, type: response.headers.get('content-type') || '' };
  } catch (err) {
    return { status: null, type: '', failed: (err && err.name === 'AbortError') ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

const refused = (status) => status === 401 || status === 403;
const gone = (status) => status === 404 || status === 410;

/* One verdict per URL, from the two answers. */
function verdictOf(url, plain, withReferer) {
  let parsed;
  try { parsed = new URL(url); } catch (err) { return ['UNPARSEABLE', 'not a URL at all']; }

  if (parsed.protocol === 'http:') {
    return ['MIXED CONTENT', 'an https page refuses this before any request is made'];
  }
  if (plain.failed && withReferer.failed) return ['INVALID', `host ${plain.failed}`];
  if (gone(plain.status) && gone(withReferer.status)) return ['INVALID', `the host answered ${plain.status}`];
  if (refused(plain.status) && refused(withReferer.status)) {
    return ['BLOCKED', `refused with and without a Referer (${plain.status})`];
  }
  if (!refused(plain.status) && refused(withReferer.status)) {
    return ['HOTLINK BLOCKED', `served plainly, refused for ${site} (${withReferer.status})`];
  }
  if (withReferer.status === 200 && !/^image\//i.test(withReferer.type)) {
    return ['NOT AN IMAGE', `answered 200 as ${withReferer.type.split(';')[0] || 'no type'}`];
  }
  if (withReferer.status === 200) return ['OK', 'the browser can load this'];
  return ['UNKNOWN', `the host answered ${withReferer.status}`];
}

async function classify(entry) {
  if (!entry.url) return Object.assign({ verdict: 'NO URL', why: 'the product carried no imageUrl', host: '(none)' }, entry);
  let host = '';
  try { host = new URL(entry.url).host; } catch (err) { host = '(unparseable)'; }

  /* http never reaches the network here: the browser would not have
     made the request either, and the verdict is about that refusal */
  const skip = entry.url.startsWith('http://');
  const plain = skip ? {} : await ask(entry.url, null);
  const withReferer = skip ? {} : await ask(entry.url, site);
  const [verdict, why] = verdictOf(entry.url, plain, withReferer);
  return Object.assign({ verdict, why, host }, entry);
}

/* A few at a time, so a page of twelve does not open twelve sockets. */
async function classifyAll(entries) {
  const out = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      out[i] = await classify(entries[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

(async () => {
  const single = flag('--url');
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--site' && args[args.indexOf(a) - 1] !== '--url');

  let entries;
  if (single) entries = [{ label: '1.', url: single }];
  else if (file) entries = urlsFrom(file);
  else {
    console.error('Give it a saved /api/search reply, or --url <one image URL>.');
    process.exit(2);
  }

  if (!entries.length) {
    console.log('That reply carried no products, so there are no photos to check.');
    return;
  }

  console.log(`\nChecking ${entries.length} photo${entries.length === 1 ? '' : 's'}, as a browser on ${site} would.\n`);

  const results = await classifyAll(entries);
  const tally = {};
  for (const r of results) {
    tally[r.verdict] = (tally[r.verdict] || 0) + 1;
    console.log(`  ${r.verdict.padEnd(16)} ${r.label}`);
    console.log(`  ${''.padEnd(16)} ${r.host} — ${r.why}`);
  }

  console.log('\n  ' + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ') + '\n');

  /* the two that have code fixes, named as such */
  if (tally['MIXED CONTENT']) {
    console.log('  MIXED CONTENT is ours to fix: the gate accepts http image URLs and an');
    console.log('  https page will not load them. Requiring https there is a one-line change.\n');
  }
  if (tally['HOTLINK BLOCKED']) {
    console.log('  HOTLINK BLOCKED is the host refusing our Referer. A referrer policy of');
    console.log('  no-referrer on the pages that show products is the smallest answer.\n');
  }
})().catch((err) => { console.error(err && err.message); process.exit(1); });
