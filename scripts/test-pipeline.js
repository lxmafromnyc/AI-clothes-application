#!/usr/bin/env node
/* =========================================================
   Fynd — product pipeline test

   Exercises the whole server side of a search without touching the
   network: interpreted intent -> adapter query -> provider response ->
   verification gate -> the JSON the browser receives.

   The provider's HTTP call is stubbed with a payload in the shape the
   OpenWeb Ninja Real-Time Product Search API documents, so what is being
   tested is Fynd's handling of it — the mapping, the gate, and the
   rules about which links and which missing fields are unacceptable.

   A live check of the real response shape is a separate script:
     OPENWEBNINJA_API_KEY=... node scripts/probe-openwebninja.js

   Usage: node scripts/test-pipeline.js
   ========================================================= */

'use strict';

const assert = require('assert');

/* Metering is exercised in scripts/test-usage.js. Here it must simply
   not interfere: the in-process store keeps these cases off Redis, and
   NODE_ENV silences the store's "not durable" warning so the tests that
   count log lines still count only what they are about. */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.USAGE_STORE = 'memory';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'pipeline-test-secret';

const provider = require('../api/providers/openwebninja');
const { verifyAll, linkFault } = require('../api/providers/product-source');
const { resetStore } = require('../api/_store');

/* Every case below is one shopper's first search. Without this the
   fourth search in the file would be refused by the Free daily limit —
   correct behaviour, but a different suite's subject. */
const freshMeters = () => resetStore();

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, message: err && err.message });
    console.log(`  FAIL  ${name}\n        ${err && err.message}`);
  }
}

/* ---------------------------------------------------------
   Fixtures, in the documented response shape
   --------------------------------------------------------- */

/* A search record in the shape a LIVE response returns: the commerce
   fields at the top level, and product_page_url pointing at Google. */
const product = (over) => Object.assign({
  product_id: 'p1',
  product_title: "Nike Men's Air Force 1 '07 Sneakers",
  price: '$87.97',
  store_name: 'nike.com',
  product_photos: ['https://img.example-cdn.com/nike/af1-white-1.jpg'],
  product_page_url: 'https://www.google.com/search?q=nike+air+force+1&tbm=shop',
  product_attributes: { Brand: 'Nike', Material: 'Leather' }
}, over);

/* The older shape, with an embedded offer carrying a real retailer link.
   Both have been observed, so both are covered. */
const productWithInlineOffer = (over) => Object.assign({
  product_id: 'p2',
  product_title: 'Champion Reverse Weave Oversized Hoodie, Black',
  product_photos: ['https://img.example-cdn.com/champion/hoodie-black-1.jpg'],
  product_page_url: 'https://www.google.com/shopping/product/111',
  product_attributes: { Brand: 'Champion' },
  offer: {
    store_name: 'Nordstrom',
    price: '$68.00',
    offer_page_url: 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321'
  }
}, over);

/* One page of /product-offers for a product_id. */
const offersPayload = (offers) => ({ status: 'OK', request_id: 'req-offers', data: offers });

const offer = (store, price, url) => ({ store_name: store, price, offer_page_url: url, product_condition: 'NEW' });

const envelope = (products) => ({ status: 'OK', request_id: 'req-1', data: products });

/* ---------------------------------------------------------
   1. Intent -> query
   --------------------------------------------------------- */

console.log('\nattachment rules');

const A = require('../assets/attachments.js');
const { shapeAttachments } = require('../api/search');

const fileOf = (name, type, size, modified) => ({ name, type, size: size || 1024, lastModified: modified || 1 });

test('takes the image types a shopper actually has', () => {
  ['photo.jpg', 'photo.jpeg', 'shot.png', 'pic.webp', 'anim.gif']
    .forEach((name) => assert.ok(A.isImage(fileOf(name, 'image/' + name.split('.').pop().replace('jpg', 'jpeg'))), name));
});

test('takes documents, and does not call them images', () => {
  const pdf = fileOf('receipt.pdf', 'application/pdf');
  assert.ok(A.isDocument(pdf));
  assert.ok(!A.isImage(pdf), 'a PDF must never be previewed as a picture');
});

test('falls back to the extension when the browser gives no type', () => {
  assert.strictEqual(A.typeOf(fileOf('from-phone.HEIC', '')), 'image/heic');
  assert.strictEqual(A.typeOf(fileOf('notes.pdf', '')), 'application/pdf');
});

test('refuses a type Fynd does not take', () => {
  const bad = fileOf('malware.exe', 'application/x-msdownload');
  assert.ok(/does not take/.test(A.reject(bad, [])), A.reject(bad, []));
  assert.ok(/does not take/.test(A.reject(fileOf('clip.mp4', 'video/mp4'), [])));
  assert.ok(/does not take/.test(A.reject(fileOf('archive.zip', 'application/zip'), [])));
});

test('refuses a file over the per-file limit', () => {
  const huge = fileOf('huge.png', 'image/png', A.MAX_FILE_BYTES + 1);
  assert.ok(/limit is .* per file/.test(A.reject(huge, [])), A.reject(huge, []));
  assert.strictEqual(A.reject(fileOf('ok.png', 'image/png', A.MAX_FILE_BYTES), []), null, 'exactly the limit is fine');
});

test('refuses more than the file count allows', () => {
  const existing = Array.from({ length: A.MAX_FILES }, (_, i) => fileOf(`f${i}.png`, 'image/png'));
  assert.ok(/up to 8 files/.test(A.reject(fileOf('one-more.png', 'image/png'), existing)));
});

test('refuses a batch that busts the total, counting cumulatively', () => {
  const big = () => fileOf(Math.random() + '.png', 'image/png', 9 * 1024 * 1024);
  const batch = Array.from({ length: 6 }, big);
  const { kept, errors } = A.sift(batch, []);
  assert.ok(kept.length < batch.length, 'some must be refused');
  assert.ok(errors.some((e) => /altogether/.test(e)), errors.join(' | '));
  assert.ok(kept.reduce((n, f) => n + f.size, 0) <= A.MAX_TOTAL_BYTES);
});

test('the same file dropped twice is attached once', () => {
  const file = fileOf('same.png', 'image/png');
  const first = A.sift([file], []);
  const second = A.sift([file], first.kept);
  assert.strictEqual(first.kept.length, 1);
  assert.strictEqual(second.kept.length, 0, 'no duplicate');
  assert.strictEqual(second.errors.length, 0, 'and no complaint about it either');
});

test('a mixed batch keeps the good and reports the bad', () => {
  const { kept, errors } = A.sift([
    fileOf('good.png', 'image/png'),
    fileOf('bad.exe', 'application/x-msdownload'),
    fileOf('good.pdf', 'application/pdf')
  ], []);
  assert.strictEqual(kept.length, 2);
  assert.strictEqual(errors.length, 1);
});

test('labels a document by its type rather than guessing a picture', () => {
  assert.strictEqual(A.labelFor(fileOf('a.pdf', 'application/pdf')), 'PDF');
  assert.strictEqual(A.labelFor(fileOf('a.png', 'image/png')), 'PNG');
  assert.strictEqual(A.labelFor(fileOf('a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')), 'DOCX');
});

test('the manifest carries names, types and sizes — and no content', () => {
  const m = A.manifest([fileOf('photo.jpg', 'image/jpeg', 2048), fileOf('spec.pdf', 'application/pdf', 4096)]);
  assert.deepStrictEqual(m, [
    { name: 'photo.jpg', type: 'image/jpeg', size: 2048, kind: 'image' },
    { name: 'spec.pdf', type: 'application/pdf', size: 4096, kind: 'document' }
  ]);
  const serialised = JSON.stringify(m);
  assert.ok(!/data:|base64|content|bytes/i.test(serialised), 'no file content may be in the manifest');
});

test('the server shapes the manifest and refuses anything else in it', () => {
  const shaped = shapeAttachments([
    { name: 'photo.jpg', type: 'image/jpeg', size: 2048, kind: 'image', content: 'data:image/jpeg;base64,AAAA' },
    { name: '', type: 'image/png', size: 1 },
    'not an object',
    { name: 'doc.pdf', type: 'application/pdf', size: -5, kind: 'nonsense' }
  ]);
  assert.strictEqual(shaped.length, 2, 'the nameless and the non-object are dropped');
  assert.ok(!('content' in shaped[0]), 'a smuggled payload is not carried through');
  assert.strictEqual(shaped[1].size, 0, 'a negative size is normalised');
  assert.strictEqual(shaped[1].kind, 'document', 'an unknown kind falls back');
});

test('the server caps how many attachments it will consider', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `f${i}.png`, type: 'image/png', size: 1 }));
  assert.ok(shapeAttachments(many).length <= 8);
});

test('sizes read the way a person would say them', () => {
  assert.strictEqual(A.formatSize(512), '512 B');
  assert.strictEqual(A.formatSize(2048), '2 KB');
  assert.strictEqual(A.formatSize(1024 * 1024 * 2.5), '2.5 MB');
});

console.log('\nconfiguration reporting');

const { envReport, stateOf, REPORTED } = require('../api/_env-report');

const SECRET = 'sk-proj-DO-NOT-LOG-abcdef0123456789';

const withReported = (env, fn) => {
  const saved = {};
  REPORTED.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env);
  try { return fn(); }
  finally { REPORTED.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
};

test('reports the three states the 503 needs told apart', () => {
  withReported({ OPENAI_API_KEY: SECRET, OPENWEBNINJA_API_KEY: '', VERCEL_ENV: 'production' }, () => {
    assert.strictEqual(stateOf('OPENAI_API_KEY'), 'present');
    assert.strictEqual(stateOf('OPENWEBNINJA_API_KEY'), 'empty', 'a blank value looks configured in a dashboard');
    assert.strictEqual(stateOf('ALLOWED_ORIGIN'), 'absent');
    assert.strictEqual(stateOf('VERCEL_ENV'), 'present');
  });
});

test('the report never contains a value, however hostile', () => {
  const hostile = [SECRET, 'a'.repeat(200), 'present', 'absent', 'OPENAI_API_KEY=leaked', '\n\nOPENAI_API_KEY=leaked'];
  hostile.forEach((value) => {
    withReported({ OPENAI_API_KEY: value, OPENWEBNINJA_API_KEY: value, ALLOWED_ORIGIN: value, VERCEL_ENV: value }, () => {
      const report = envReport();
      assert.ok(!report.includes(SECRET), 'a key must never appear');
      assert.ok(!report.includes('leaked'), 'a crafted value must not forge a field');
      assert.ok(!report.includes('aaaa'), 'no value fragment may appear');
      /* the only strings it may emit are the fixed names and three words */
      report.split(' ').forEach((pair) => {
        const [name, state] = pair.split('=');
        assert.ok(REPORTED.includes(name), `unexpected name ${name}`);
        assert.ok(['present', 'empty', 'absent'].includes(state), `unexpected state ${state}`);
      });
    });
  });
});

test('the report cannot reveal a value length', () => {
  const short = withReported({ OPENAI_API_KEY: 'x' }, envReport);
  const long = withReported({ OPENAI_API_KEY: 'x'.repeat(500) }, envReport);
  assert.strictEqual(short, long, 'a short and a long key must be indistinguishable');
});

/* The list is pinned deliberately: adding a name here makes its STATE
   loggable, and this test is the moment someone has to decide that on
   purpose rather than by accident. */
test('only the named variables are ever reported', () => {
  assert.deepStrictEqual(REPORTED, [
    'OPENAI_API_KEY',
    'OPENWEBNINJA_API_KEY',
    'ALLOWED_ORIGIN',
    'VERCEL_ENV',
    /* metering: both fail quietly, so their state belongs in the report */
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'SESSION_SECRET'
  ]);
});

console.log('\ncross-origin access control');

const { isAllowed, configuredOrigins, handledPreflight } = require('../api/_cors');

const withEnv = (env, fn) => {
  const keys = ['ALLOWED_ORIGIN', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_BRANCH_URL', 'VERCEL_URL'];
  const saved = {};
  keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env);
  try { return fn(); }
  finally { keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); }
};

const reqFrom = (origin, host) => ({ headers: Object.assign({}, origin ? { origin } : {}, host ? { host } : {}) });

test('the published site is allowed with no environment variables at all', () => {
  withEnv({}, () => {
    const origin = 'https://lxmafromnyc.github.io';
    assert.ok(isAllowed(reqFrom(origin), origin),
      'the site must never be locked out of its own API by a missing env var');
  });
});

test('ALLOWED_ORIGIN adds to the built-in list and cannot remove from it', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://somewhere.else' }, () => {
    assert.ok(isAllowed(reqFrom('https://lxmafromnyc.github.io'), 'https://lxmafromnyc.github.io'));
    assert.ok(isAllowed(reqFrom('https://somewhere.else'), 'https://somewhere.else'));
  });
});

test('building the site origin in does not widen the allowlist', () => {
  withEnv({}, () => {
    ['https://evil.example.com', 'https://lxmafromnyc.github.io.evil.com', 'https://notlxmafromnyc.github.io']
      .forEach((origin) => assert.ok(!isAllowed(reqFrom(origin), origin), `${origin} must stay refused`));
  });
});

test('an origin named in ALLOWED_ORIGIN is allowed', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://lxmafromnyc.github.io' }, () => {
    assert.ok(isAllowed(reqFrom('https://lxmafromnyc.github.io'), 'https://lxmafromnyc.github.io'));
  });
});

test('ALLOWED_ORIGIN accepts a comma-separated list', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://a.example, https://b.example' }, () => {
    assert.ok(isAllowed(reqFrom('https://a.example'), 'https://a.example'));
    assert.ok(isAllowed(reqFrom('https://b.example'), 'https://b.example'));
    assert.ok(!isAllowed(reqFrom('https://c.example'), 'https://c.example'));
  });
});

test('a trailing slash in the configured value is tolerated', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://lxmafromnyc.github.io/' }, () => {
    assert.ok(isAllowed(reqFrom('https://lxmafromnyc.github.io'), 'https://lxmafromnyc.github.io'),
      'the pasted-URL slash must not break the match');
  });
});

test("the deployment's own Vercel origins are allowed without configuration", () => {
  withEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'ai-clothes-application.vercel.app', VERCEL_URL: 'ai-clothes-application-abc.vercel.app' }, () => {
    assert.ok(isAllowed(reqFrom('https://ai-clothes-application.vercel.app'), 'https://ai-clothes-application.vercel.app'));
    assert.ok(isAllowed(reqFrom('https://ai-clothes-application-abc.vercel.app'), 'https://ai-clothes-application-abc.vercel.app'));
  });
});

test('a page on the same host as the function is allowed with no configuration at all', () => {
  withEnv({}, () => {
    assert.ok(isAllowed(reqFrom('https://anything.example', 'anything.example'), 'https://anything.example'));
    assert.ok(!configuredOrigins().has('https://anything.example'),
      'the Host match allows it, not the configured list');
  });
});

[
  ['another site', 'https://evil.example.com'],
  ['a different Vercel app', 'https://somebody-else.vercel.app'],
  ['a file:// page', 'null'],
  ['http where https is allowed', 'http://lxmafromnyc.github.io'],
  ['an origin carrying a trailing slash', 'https://lxmafromnyc.github.io/']
].forEach(([label, origin]) => {
  test(`rejects ${label}`, () => {
    withEnv({ ALLOWED_ORIGIN: 'https://lxmafromnyc.github.io' }, () => {
      assert.ok(!isAllowed(reqFrom(origin), origin));
    });
  });
});

test('no wildcard: nothing is allowed just for being on vercel.app', () => {
  withEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'ai-clothes-application.vercel.app' }, () => {
    assert.ok(!isAllowed(reqFrom('https://attacker.vercel.app'), 'https://attacker.vercel.app'));
  });
});

const fakeCorsRes = () => {
  const res = { statusCode: null, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
};

test('a rejected preflight answers 403, never a headerless 204', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://lxmafromnyc.github.io' }, () => {
    const res = fakeCorsRes();
    const stop = handledPreflight(Object.assign(reqFrom('https://evil.example.com'), { method: 'OPTIONS' }), res);
    assert.strictEqual(stop, true);
    assert.strictEqual(res.statusCode, 403, 'a 204 here would read as success in the log');
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
  });
});

test('an accepted preflight answers 204 and echoes the caller, with Vary', () => {
  withEnv({ ALLOWED_ORIGIN: 'https://lxmafromnyc.github.io' }, () => {
    const res = fakeCorsRes();
    handledPreflight(Object.assign(reqFrom('https://lxmafromnyc.github.io'), { method: 'OPTIONS' }), res);
    assert.strictEqual(res.statusCode, 204);
    assert.strictEqual(res.headers['access-control-allow-origin'], 'https://lxmafromnyc.github.io');
    assert.strictEqual(res.headers['vary'], 'Origin');
    assert.ok(/POST/.test(res.headers['access-control-allow-methods']));
    assert.ok(/Content-Type/i.test(res.headers['access-control-allow-headers']));
  });
});

test('a request with no Origin is left alone, so curl still works', () => {
  withEnv({}, () => {
    const res = fakeCorsRes();
    const stop = handledPreflight({ headers: {}, method: 'POST' }, res);
    assert.strictEqual(stop, false, 'it must fall through to the handler');
    assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
  });
});

console.log('\nprovider selection');

const { getProvider, DEFAULT_SOURCE } = require('../api/providers/product-source');

const selectWith = (env) => {
  const saved = {};
  ['PRODUCT_SOURCE', 'OPENWEBNINJA_API_KEY', 'ETSY_API_KEY'].forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
  Object.assign(process.env, env);
  try { return getProvider(); }
  finally {
    ['PRODUCT_SOURCE', 'OPENWEBNINJA_API_KEY', 'ETSY_API_KEY'].forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
  }
};

test('the key alone is enough to go live — PRODUCT_SOURCE is optional', () => {
  assert.strictEqual(selectWith({ OPENWEBNINJA_API_KEY: 'k' }).name, 'openwebninja');
});

test('naming the default explicitly selects the same provider', () => {
  assert.strictEqual(selectWith({ PRODUCT_SOURCE: 'openwebninja', OPENWEBNINJA_API_KEY: 'k' }).name, 'openwebninja');
});

test('no key and no setting selects nothing, so /api/search answers 503', () => {
  const p = selectWith({});
  assert.strictEqual(p.name, 'none');
  assert.strictEqual(p.configured(), false);
});

test('Etsy is never selected unless it is asked for by name', () => {
  assert.notStrictEqual(selectWith({ ETSY_API_KEY: 'k' }).name, 'etsy');
  assert.strictEqual(selectWith({ PRODUCT_SOURCE: 'etsy', ETSY_API_KEY: 'k' }).name, 'etsy');
});

test('a misspelt PRODUCT_SOURCE selects nothing rather than silently defaulting', () => {
  assert.strictEqual(selectWith({ PRODUCT_SOURCE: 'openwebninjaa', OPENWEBNINJA_API_KEY: 'k' }).name, 'none');
});

test('the default source is the OpenWeb Ninja adapter', () => {
  assert.strictEqual(DEFAULT_SOURCE, 'openwebninja');
});

console.log('\nintent -> search query');

/* what /api/interpret produces for "black oversized Nike hoodie under $80" */
const nikeIntent = {
  categories: ['hoodie'], colors: ['black'], occasions: [], fits: ['oversized'],
  brands: ['Nike'], styles: [], keywords: ['hoodie', 'black'],
  maxPrice: 80, minPrice: null, season: null, gender: null
};

test('reads as a shopper would type it', () => {
  assert.strictEqual(provider.queryFrom(nikeIntent), 'black oversized nike hoodie');
});

test('duplicate keywords do not repeat in the query', () => {
  assert.strictEqual((provider.queryFrom(nikeIntent).match(/hoodie/g) || []).length, 1);
});

test('gender leads the phrase when the request stated one', () => {
  assert.strictEqual(
    provider.queryFrom({ gender: 'women', colors: ['black'], categories: ['hoodie'] }),
    'women black hoodie'
  );
});

test('season is left out of the query', () => {
  assert.strictEqual(provider.queryFrom({ categories: ['coat'], season: 'fall' }), 'coat');
});

test('an empty intent produces an empty query, not an invented one', () => {
  assert.strictEqual(provider.queryFrom({}), '');
});

/* ---------------------------------------------------------
   2. Mapping one product
   --------------------------------------------------------- */

console.log('\nproduct -> record');

test('maps the live top-level fields', () => {
  const r = provider.toRecord(product());
  assert.strictEqual(r.title, "Nike Men's Air Force 1 '07 Sneakers");
  assert.strictEqual(r.imageUrl, 'https://img.example-cdn.com/nike/af1-white-1.jpg');
  assert.strictEqual(r.brand, 'Nike');
});

test('a Google product_page_url yields NO product URL, price or retailer', () => {
  const r = provider.toRecord(product());
  assert.strictEqual(r.productUrl, undefined, 'Google is never the retailer page');
  assert.strictEqual(r.price, undefined, 'price without a link to it is not shown');
  assert.strictEqual(r.retailer, undefined);
  assert.ok(!JSON.stringify(r).includes('google.'), 'no Google URL may survive into a record');
});

test('no URL is ever built out of the store domain', () => {
  const r = provider.toRecord(product());
  assert.ok(!JSON.stringify(r).includes('nike.com/'), 'a domain is not a product page');
});

[
  ['a Google search URL', 'https://www.google.com/search?q=nike&tbm=shop'],
  ['a Google Shopping product page', 'https://www.google.com/shopping/product/111'],
  ['a Google country domain', 'https://www.google.co.uk/shopping/product/111'],
  ['googleusercontent', 'https://lh3.googleusercontent.com/thing'],
  ['not a URL at all', 'nike.com'],
  ['a javascript: URL', 'javascript:alert(1)']
].forEach(([label, url]) => {
  test(`looksDirect refuses ${label}`, () => {
    assert.strictEqual(provider.looksDirect(url), null);
  });
});

test('looksDirect accepts a real retailer URL', () => {
  assert.strictEqual(provider.looksDirect('https://www.nike.com/t/air-force-1-07-shoe/CW2288-111'),
    'https://www.nike.com/t/air-force-1-07-shoe/CW2288-111');
});

test('an inline offer with a real link is used without a second call', () => {
  const r = provider.toRecord(productWithInlineOffer());
  assert.strictEqual(r.productUrl, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321');
  assert.strictEqual(r.price, 68);
  assert.strictEqual(r.retailer, 'Nordstrom');
});

test('reads brand out of product_attributes', () => {
  assert.strictEqual(provider.brandFrom(product()), 'Nike');
});

test('omits brand rather than borrowing the store domain', () => {
  const r = provider.toRecord(product({ product_attributes: {} }));
  assert.strictEqual(r.brand, undefined);
});

test('parses live price strings', () => {
  assert.strictEqual(provider.toPrice('$87.97'), 87.97);
  assert.strictEqual(provider.toPrice('$1,299.00'), 1299);
  assert.strictEqual(provider.toPrice('Out of stock'), null);
});

test('takes the first usable photo, and none at all when there are none', () => {
  assert.strictEqual(provider.imageFrom({ product_photos: [] }), null);
  assert.strictEqual(provider.imageFrom({ product_photos: ['', 'https://a/b.jpg'] }), 'https://a/b.jpg');
});

console.log('\noffer resolution');

test('pickOffer prefers the store the search result named', () => {
  const chosen = provider.pickOffer([
    offer('walmart.com', '$92.00', 'https://www.walmart.com/ip/af1/123'),
    offer('nike.com', '$87.97', 'https://www.nike.com/t/air-force-1-07-shoe/CW2288-111')
  ], 'nike.com');
  assert.strictEqual(chosen.retailer, 'nike.com');
  assert.strictEqual(chosen.productUrl, 'https://www.nike.com/t/air-force-1-07-shoe/CW2288-111');
  assert.strictEqual(chosen.price, 87.97, 'the price must be the one at the shop being linked to');
});

test('pickOffer falls back to the first seller with a usable link', () => {
  const chosen = provider.pickOffer([
    offer('somewhere.com', '$50.00', 'https://www.google.com/shopping/product/9'),
    offer('target.com', '$91.00', 'https://www.target.com/p/af1/-/A-123')
  ], 'nike.com');
  assert.strictEqual(chosen.retailer, 'target.com');
});

test('pickOffer returns nothing when no seller has a real link', () => {
  assert.strictEqual(provider.pickOffer([
    offer('a.com', '$1.00', 'https://www.google.com/search?q=x'),
    offer('b.com', '$2.00', '')
  ], 'nike.com'), null);
});

test('price, retailer and link always come from ONE offer', () => {
  const chosen = provider.pickOffer([
    offer('target.com', '$91.00', 'https://www.target.com/p/af1/-/A-123'),
    offer('walmart.com', '$12.00', 'https://www.walmart.com/ip/af1/999')
  ], null);
  assert.strictEqual(chosen.retailer, 'target.com');
  assert.strictEqual(chosen.price, 91);
  assert.ok(chosen.productUrl.includes('target.com'), 'never the cheap price with the other shop\'s link');
});

console.log('\nimage and product URL belong to the same product');

test('each record keeps its own photo and its own link', () => {
  const batch = [
    product({ product_id: 'a', product_photos: ['https://img/a.jpg'], offer: { store_name: 'Target', price: '$40.00', offer_page_url: 'https://www.target.com/p/a/-/A-111' } }),
    product({ product_id: 'b', product_photos: ['https://img/b.jpg'], offer: { store_name: 'Walmart', price: '$45.00', offer_page_url: 'https://www.walmart.com/ip/b/222' } })
  ];
  const records = batch.map(provider.toRecord);
  assert.strictEqual(records[0].imageUrl, 'https://img/a.jpg');
  assert.strictEqual(records[0].productUrl, 'https://www.target.com/p/a/-/A-111');
  assert.strictEqual(records[1].imageUrl, 'https://img/b.jpg');
  assert.strictEqual(records[1].productUrl, 'https://www.walmart.com/ip/b/222');
});

test('a product with photos but no obtainable link yields no link, not another product\'s', () => {
  const batch = [
    product({ product_id: 'a', product_photos: ['https://img/a.jpg'] }),
    productWithInlineOffer({ product_id: 'b', product_photos: ['https://img/b.jpg'] })
  ];
  const records = batch.map(provider.toRecord);
  assert.strictEqual(records[0].productUrl, undefined, 'a Google-only record gets no link');
  assert.strictEqual(records[0].imageUrl, 'https://img/a.jpg', 'it keeps its own photo');
  assert.strictEqual(records[1].productUrl, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321');
});

test('price, retailer and link always come from one and the same offer', () => {
  const r = provider.toRecord(productWithInlineOffer({
    offer: { store_name: 'REI', price: '$88.50', offer_page_url: 'https://www.rei.com/product/999/hoodie' },
    offers: [{ store_name: 'Zappos', price: '$12.00', offer_page_url: 'https://www.zappos.com/p/other' }]
  }));
  assert.strictEqual(r.retailer, 'REI');
  assert.strictEqual(r.price, 88.5);
  assert.strictEqual(r.productUrl, 'https://www.rei.com/product/999/hoodie');
});

test('a resolved offer replaces price and retailer together with its link', async () => {
  const record = provider.toRecord(product());
  record.retailerHint = 'nike.com';
  assert.strictEqual(record.productUrl, undefined);

  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}',
    json: async () => offersPayload([offer('nike.com', '$87.97', 'https://www.nike.com/t/air-force-1-07-shoe/CW2288-111')]) });
  process.env.OPENWEBNINJA_API_KEY = 'test-key';
  try {
    await provider.resolveMissingOffers([record], 1, { country: 'us', language: 'en' });
  } finally { global.fetch = real; }

  assert.strictEqual(record.productUrl, 'https://www.nike.com/t/air-force-1-07-shoe/CW2288-111');
  assert.strictEqual(record.retailer, 'nike.com');
  assert.strictEqual(record.price, 87.97);
  assert.strictEqual(record.imageUrl, 'https://img.example-cdn.com/nike/af1-white-1.jpg', 'the photo is still its own');
});

test('a failed offer lookup leaves the record linkless rather than failing the search', async () => {
  const record = provider.toRecord(product());
  const real = global.fetch;
  global.fetch = async () => { throw new Error('offers endpoint down'); };
  process.env.OPENWEBNINJA_API_KEY = 'test-key';
  try {
    await provider.resolveMissingOffers([record], 1, { country: 'us', language: 'en' });
  } finally { global.fetch = real; }
  assert.strictEqual(record.productUrl, undefined);
});

/* ---------------------------------------------------------
   4. The verification gate
   --------------------------------------------------------- */

console.log('\nverification gate');

const gate = (records) => verifyAll(records, { retailer: provider.defaultRetailer });

test('a complete record passes', () => {
  const { products, rejected } = gate([provider.toRecord(productWithInlineOffer())]);
  assert.strictEqual(products.length, 1);
  assert.deepStrictEqual(rejected, {});
  assert.strictEqual(products[0].retailer, 'Nordstrom');
});

test('a record with no brand still passes, and carries no brand key', () => {
  const { products } = gate([provider.toRecord(productWithInlineOffer({ product_attributes: {} }))]);
  assert.strictEqual(products.length, 1);
  assert.ok(!('brand' in products[0]), 'brand must be absent, not empty');
});

[
  ['missing title', { product_title: '' }, 'missing-title'],
  ['missing image', { product_photos: [] }, 'missing-image-url'],
  ['missing price', { offer: { store_name: 'Target', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-price'],
  ['missing retailer', { offer: { price: '$20.00', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-retailer'],
  ['no obtainable product URL', { offer: undefined }, 'missing-price'],
  ['zero price', { offer: { store_name: 'Target', price: '$0.00', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-price'],
  ['unparseable price', { offer: { store_name: 'Target', price: 'see site', offer_page_url: 'https://www.target.com/p/x/-/A-1' } }, 'missing-price']
].forEach(([label, over, reason]) => {
  test(`rejects a record with a ${label}`, () => {
    const { products, rejected } = gate([provider.toRecord(productWithInlineOffer(over))]);
    assert.strictEqual(products.length, 0, 'nothing may pass');
    assert.strictEqual(rejected[reason], 1, `expected ${reason}, got ${JSON.stringify(rejected)}`);
  });
});

/* Adversarial: a provider that hands back a Google URL despite the
   adapter. The gate is the second line of defence and must refuse it. */
const rawRecord = (url) => ({
  title: "Nike Men's Air Force 1 '07 Sneakers",
  imageUrl: 'https://img.example-cdn.com/nike/af1-white-1.jpg',
  price: '$87.97',
  retailer: 'nike.com',
  productUrl: url
});

[
  ['a Google Shopping product page', 'https://www.google.com/shopping/product/111', 'product-url-not-a-retailer-page'],
  ['a Google search URL', 'https://www.google.com/search?q=nike+air+force+1&tbm=shop', 'product-url-not-a-retailer-page'],
  ['a Google country domain', 'https://www.google.co.uk/shopping/product/111', 'product-url-not-a-retailer-page'],
  ['a Google ad click', 'https://www.googleadservices.com/pagead/aclk?adurl=https%3A%2F%2Fshop.com%2Fp', 'product-url-not-a-retailer-page'],
  ['a redirector', 'https://www.example.com/aclk?u=https://shop.com/p/1', 'product-url-is-a-redirect'],
  ['a homepage', 'https://www.uniqlo.com/', 'product-url-not-a-product-page'],
  ['a search listing', 'https://www.uniqlo.com/search', 'product-url-not-a-product-page'],
  ['a category listing', 'https://www.uniqlo.com/collections', 'product-url-not-a-product-page']
].forEach(([label, url, reason]) => {
  test(`the gate refuses ${label} even if a provider returns it`, () => {
    const { products, rejected } = gate([rawRecord(url)]);
    assert.strictEqual(products.length, 0, 'nothing may pass');
    assert.strictEqual(rejected[reason], 1, `expected ${reason}, got ${JSON.stringify(rejected)}`);
  });
});

test('the adapter strips a Google URL before the gate ever sees it', () => {
  const record = provider.toRecord(product());
  assert.strictEqual(record.productUrl, undefined, 'defence in depth: refused twice');
});

test('keeps a real product URL that carries a tracking parameter', () => {
  assert.strictEqual(linkFault('https://www.gap.com/browse/product.do?pid=525built&returnUrl=https://www.gap.com/cart'), null);
});

test('two products sharing a URL are counted once', () => {
  const records = [provider.toRecord(productWithInlineOffer()), provider.toRecord(productWithInlineOffer({ product_id: 'pX' }))];
  const { products } = gate(records);
  assert.strictEqual(products.length, 1);
});

/* ---------------------------------------------------------
   5. The adapter's request, and the budget
   --------------------------------------------------------- */

console.log('\nadapter request');

function withStubbedFetch(handler, run) {
  const real = global.fetch;
  global.fetch = handler;
  return Promise.resolve(run()).finally(() => { global.fetch = real; });
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

/* The live integration is two endpoints: /search for products, then
   /product-offers per product for the seller links. This answers both,
   and records every URL called so the request shape can be asserted. */
function twoEndpointStub(searchPayload, offersByProductId) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/product-offers')) {
      const id = new URL(String(url)).searchParams.get('product_id');
      return okResponse(offersPayload((offersByProductId || {})[id] || []));
    }
    return okResponse(searchPayload);
  };
  impl.calls = calls;
  return impl;
}

(async () => {
  await testAsync('sends the query, the budget and the key as x-api-key', async () => {
    let seen = null;
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    const stub = twoEndpointStub(envelope([productWithInlineOffer()]));
    await withStubbedFetch(async (url, init) => { if (!seen) seen = { url, init }; return stub(url, init); },
      () => provider.search(nikeIntent, { limit: 12 }));

    const url = new URL(seen.url);
    assert.strictEqual(url.origin + url.pathname, provider.SEARCH_URL);
    assert.strictEqual(url.searchParams.get('q'), 'black oversized nike hoodie');
    assert.strictEqual(url.searchParams.get('max_price'), '80');
    assert.strictEqual(url.searchParams.get('country'), 'us');
    assert.strictEqual(seen.init.headers['x-api-key'], 'test-key');
    assert.ok(!seen.url.includes('test-key'), 'the key must not travel in the query string');
  });

  await testAsync('looks up offers only for products that arrived without a link', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    const stub = twoEndpointStub(
      envelope([productWithInlineOffer({ product_id: 'has-link' }), product({ product_id: 'needs-link' })]),
      { 'needs-link': [offer('nike.com', '$54.00', 'https://www.nike.com/t/af1/CW2288-111')] }
    );
    const records = await withStubbedFetch(stub, () => provider.search(nikeIntent, { limit: 12 }));

    const offerCalls = stub.calls.filter((u) => u.includes('/product-offers'));
    assert.strictEqual(offerCalls.length, 1, 'the record that already had a link must not be looked up');
    assert.ok(offerCalls[0].includes('product_id=needs-link'));
    assert.strictEqual(records.length, 2);
  });

  await testAsync('offer lookups can be turned off entirely', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.OPENWEBNINJA_RESOLVE_OFFERS = 'off';
    const stub = twoEndpointStub(envelope([product()]), { p1: [offer('nike.com', '$87.97', 'https://www.nike.com/t/af1/1')] });
    const records = await withStubbedFetch(stub, () => provider.search(nikeIntent, { limit: 12 }));
    assert.strictEqual(stub.calls.filter((u) => u.includes('/product-offers')).length, 0);
    assert.strictEqual(records[0].productUrl, undefined, 'and nothing is invented in its place');
    delete process.env.OPENWEBNINJA_RESOLVE_OFFERS;
  });

  await testAsync('never sends a limit above the endpoint maximum', async () => {
    let seen = null;
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    await withStubbedFetch(async (url) => { seen = url; return okResponse(envelope([])); },
      () => provider.search(nikeIntent, { limit: 100 }));
    assert.ok(Number(new URL(seen).searchParams.get('limit')) <= 120);
  });

  await testAsync('drops an offer above the stated budget', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    const records = await withStubbedFetch(
      twoEndpointStub(envelope([
        productWithInlineOffer({ product_id: 'cheap', offer: { store_name: 'Target', price: '$54.00', offer_page_url: 'https://www.target.com/p/a/-/A-1' } }),
        productWithInlineOffer({ product_id: 'dear', offer: { store_name: 'Target', price: '$130.00', offer_page_url: 'https://www.target.com/p/b/-/A-2' } })
      ])),
      () => provider.search(nikeIntent, { limit: 12 }));
    assert.strictEqual(records.length, 1, 'the $130 offer must not survive "under $80"');
    assert.strictEqual(records[0].price, 54);
  });

  await testAsync('surfaces an upstream failure instead of returning nothing quietly', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    await assert.rejects(
      withStubbedFetch(async () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
        () => provider.search(nikeIntent, { limit: 12 })),
      /429/
    );
  });

  await testAsync('refuses to search without a key', async () => {
    delete process.env.OPENWEBNINJA_API_KEY;
    await assert.rejects(() => provider.search(nikeIntent, { limit: 12 }), /OPENWEBNINJA_API_KEY/);
  });

  /* -------------------------------------------------------
     6. End to end through /api/search
     ------------------------------------------------------- */

  console.log('\n/api/search end to end');

  function fakeRes() {
    const res = { statusCode: null, body: null, headers: {} };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.end = () => res;
    return res;
  }

  const callSearch = async (intent, payload) => {
    /* required in here so the provider registry reads the env we just set */
    const handler = require('../api/search');
    freshMeters();
    freshMeters();
    const res = fakeRes();
    await withStubbedFetch(async () => okResponse(payload),
      () => handler({ method: 'POST', body: { intent, limit: 12 }, on: () => {} }, res));
    return res;
  };

  await testAsync('answers 503, not a fabricated product, when no source is configured', async () => {
    delete process.env.OPENWEBNINJA_API_KEY;
    process.env.PRODUCT_SOURCE = 'openwebninja';
    const res = await callSearch(nikeIntent, envelope([product()]));
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(res.body, { error: 'No product source is configured.', source: null });
  });

  await testAsync('"black oversized hoodie under $80" reaches the browser as real records', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.PRODUCT_SOURCE = 'openwebninja';

    /* live shape: commerce at the top level, product_page_url on Google */
    const payload = envelope([
      product({ product_id: '1', product_title: 'Champion Reverse Weave Oversized Hoodie, Black',
                product_photos: ['https://img.example-cdn.com/champion-black.jpg'],
                store_name: 'nordstrom.com', price: '$68.00', product_attributes: { Brand: 'Champion' } }),
      product({ product_id: '2', product_title: 'Hanes ComfortWash Garment Dyed Hoodie, Black',
                product_photos: ['https://img.example-cdn.com/hanes-black.jpg'],
                store_name: 'walmart.com', price: '$24.98', product_attributes: {} }),
      /* no photos: dropped whatever its offers say */
      product({ product_id: '3', product_photos: [], store_name: 'target.com', price: '$30.00' }),
      /* every seller links to Google: dropped, never shown */
      product({ product_id: '4', store_name: 'shop.com', price: '$40.00' }),
      /* over the stated budget */
      product({ product_id: '5', store_name: 'saks.com', price: '$240.00' })
    ]);

    const offers = {
      '1': [offer('nordstrom.com', '$68.00', 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321')],
      '2': [offer('walmart.com', '$24.98', 'https://www.walmart.com/ip/Hanes-ComfortWash-Hoodie/558123456')],
      '3': [offer('target.com', '$30.00', 'https://www.target.com/p/x/-/A-9')],
      '4': [offer('shop.com', '$40.00', 'https://www.google.com/shopping/product/999')],
      '5': [offer('saks.com', '$240.00', 'https://www.saks.com/product/hoodie-0400012345678')]
    };

    const handler = require('../api/search');
    freshMeters();
    const res = fakeRes();
    await withStubbedFetch(twoEndpointStub(payload, offers),
      () => handler({ method: 'POST', headers: {}, body: { intent: nikeIntent, limit: 12 }, on: () => {} }, res));

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.source, 'openwebninja');

    const products = res.body.products;
    assert.strictEqual(products.length, 2, `expected 2 verified products, got ${products.length}: ${JSON.stringify(res.body.rejected)}`);
    assert.strictEqual(res.body.rejected['missing-image-url'], 1, 'the photoless record');

    products.forEach((p) => {
      assert.ok(p.name, 'every card needs a title');
      assert.ok(/^https:\/\//.test(p.imageUrl), 'every card needs an absolute image URL');
      assert.ok(typeof p.price === 'number' && p.price > 0, 'every card needs a real price');
      assert.ok(p.retailer, 'every card names its retailer');
      assert.ok(/^https:\/\//.test(p.productUrl), 'every card links to a page');
      assert.strictEqual(linkFault(p.productUrl), null, 'every link is a retailer product page');
      assert.ok(p.price <= 80, 'nothing over the stated budget');
      assert.ok(!/google\./i.test(p.productUrl), 'no Google URL reaches the browser');
    });

    /* the pairing survives both calls */
    const nordstrom = products.find((p) => p.retailer === 'nordstrom.com');
    assert.strictEqual(nordstrom.imageUrl, 'https://img.example-cdn.com/champion-black.jpg');
    assert.strictEqual(nordstrom.productUrl, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321');
    assert.strictEqual(nordstrom.price, 68);
    assert.strictEqual(nordstrom.brand, 'Champion');

    const walmart = products.find((p) => p.retailer === 'walmart.com');
    assert.strictEqual(walmart.imageUrl, 'https://img.example-cdn.com/hanes-black.jpg');
    assert.ok(!('brand' in walmart), 'a brandless product still shows, without a brand');
  });

  await testAsync('an empty upstream answer returns no products rather than invented ones', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.PRODUCT_SOURCE = 'openwebninja';
    const res = await callSearch(nikeIntent, envelope([]));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.products, []);
  });

  await testAsync('a provider failure answers 502 without leaking the key or the upstream body', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.PRODUCT_SOURCE = 'openwebninja';
    const handler = require('../api/search');
    freshMeters();
    const res = fakeRes();
    await withStubbedFetch(async () => ({ ok: false, status: 500, text: async () => 'upstream detail with test-key' }),
      () => handler({ method: 'POST', body: { intent: nikeIntent, limit: 12 }, on: () => {} }, res));
    assert.strictEqual(res.statusCode, 502);
    assert.ok(!JSON.stringify(res.body).includes('test-key'));
    assert.ok(!JSON.stringify(res.body).includes('upstream detail'));
  });

  /* -------------------------------------------------------
     7. What the page is allowed to show
     -------------------------------------------------------
     The sample catalogue may stand in only when nothing is connected.
     Once a source IS configured, a failed or empty search must say so
     rather than pad the page with demo rows. assets/search.js decides
     that, so it is loaded here and driven directly. */

  console.log('\nwhat reaches the log');

  const captureWarnings = async (fn) => {
    const real = console.warn; const lines = [];
    console.warn = (...args) => lines.push(args.join(' '));
    try { await fn(); } finally { console.warn = real; }
    return lines;
  };

  await testAsync('a 503 logs the configuration state, with no value in it', async () => {
    delete process.env.OPENWEBNINJA_API_KEY;
    delete process.env.PRODUCT_SOURCE;
    process.env.OPENAI_API_KEY = SECRET;
    const handler = require('../api/search');
    freshMeters();
    const lines = await captureWarnings(() => handler({ method: 'POST', headers: {}, body: { intent: {} }, on: () => {} }, fakeRes()));
    assert.strictEqual(lines.length, 1, 'exactly one line');
    assert.ok(/OPENWEBNINJA_API_KEY=absent/.test(lines[0]), lines[0]);
    assert.ok(/OPENAI_API_KEY=present/.test(lines[0]), lines[0]);
    assert.ok(!lines[0].includes(SECRET), 'the key must not be in the log');
    delete process.env.OPENAI_API_KEY;
  });

  await testAsync('a search that verifies something logs nothing at all', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    delete process.env.PRODUCT_SOURCE;
    const handler = require('../api/search');
    freshMeters();
    const lines = await captureWarnings(() => withStubbedFetch(
      twoEndpointStub(envelope([productWithInlineOffer()])),
      () => handler({ method: 'POST', headers: {}, body: { intent: nikeIntent, limit: 3 }, on: () => {} }, fakeRes())));
    assert.strictEqual(lines.length, 0, 'no request contents, no env state, nothing');
  });

  await testAsync('a search that verifies nothing logs the funnel, with no record content', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    delete process.env.PRODUCT_SOURCE;
    const handler = require('../api/search');
    freshMeters();
    const res = fakeRes();
    const lines = await captureWarnings(() => withStubbedFetch(
      twoEndpointStub(envelope([product()]), {}),
      () => handler({ method: 'POST', headers: {}, body: { intent: nikeIntent, limit: 3 }, on: () => {} }, res)));

    assert.strictEqual(lines.length, 1, 'exactly one line');
    assert.ok(/returnedByProvider/.test(lines[0]), lines[0]);
    assert.ok(!lines[0].includes('Air Force'), 'no product title in the log');
    assert.ok(!lines[0].includes('img.example-cdn'), 'no URL from a record in the log');

    const d = res.body.diagnostics;
    assert.strictEqual(d.returnedByProvider, 1);
    assert.strictEqual(d.normalized, 1);
    assert.strictEqual(d.withInlineLink, 0);
    assert.strictEqual(d.offers.neededOfferLookup, 1);
    assert.strictEqual(d.offers.lookupsEmpty, 1);
    assert.strictEqual(d.withAnyLink, 0);
    assert.strictEqual(d.verified, 0);
  });

  console.log('\nthe funnel accounts for every lost record');

  await testAsync('reports records lost to the budget filter separately', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    const records = await withStubbedFetch(
      twoEndpointStub(envelope([product({ product_id: 'dear' })]), { dear: [offer('saks.com', '$240.00', 'https://www.saks.com/product/x-123')] }),
      () => provider.search(nikeIntent, { limit: 12 }));
    assert.strictEqual(records.length, 0);
    assert.strictEqual(records.diagnostics.withAnyLink, 1, 'it did get a link');
    assert.strictEqual(records.diagnostics.droppedOverBudget, 1, 'and was dropped for the price, not the link');
  });

  await testAsync('reports an unreadable offers payload as a shape, not as silence', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    const records = await withStubbedFetch(
      async (url) => String(url).includes('/product-offers')
        /* the array under a key resultsFrom does not read */
        ? okResponse({ status: 'OK', request_id: 'r', data: { offers: [offer('nike.com', '$70', 'https://www.nike.com/t/x/1')] } })
        : okResponse(envelope([product()])),
      () => provider.search(nikeIntent, { limit: 12 }));

    const d = records.diagnostics;
    assert.strictEqual(d.offers.lookupsEmpty, 1);
    assert.ok(/data=\{.*offers.*\}/.test(d.offers.offersShape), `shape should name the key: ${d.offers.offersShape}`);
    assert.ok(!d.offers.offersShape.includes('nike.com'), 'shape carries key names only, never values');
  });

  await testAsync('reports a failed lookup separately from an empty one', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    const records = await withStubbedFetch(
      async (url) => { if (String(url).includes('/product-offers')) throw new Error('down'); return okResponse(envelope([product()])); },
      () => provider.search(nikeIntent, { limit: 12 }));
    assert.strictEqual(records.diagnostics.offers.lookupsFailed, 1);
    assert.strictEqual(records.diagnostics.offers.lookupsEmpty, 0);
  });

  await testAsync('reports an expired offer budget', async () => {
    process.env.OPENWEBNINJA_API_KEY = 'test-key';
    process.env.OPENWEBNINJA_OFFER_BUDGET_MS = '1';
    const many = Array.from({ length: 8 }, (_, i) => product({ product_id: `p${i}` }));
    const base = twoEndpointStub(envelope(many), {});
    /* a real pause, so the deadline is genuinely passed rather than
       depending on how fast the machine happens to be */
    const slow = async (url, init) => {
      if (String(url).includes('/product-offers')) await new Promise((r) => setTimeout(r, 12));
      return base(url, init);
    };
    const records = await withStubbedFetch(slow, () => provider.search(nikeIntent, { limit: 12 }));
    assert.strictEqual(records.diagnostics.offers.budgetExpired, true);
    delete process.env.OPENWEBNINJA_OFFER_BUDGET_MS;
  });

  console.log('\nclient search states');

  const loadClient = () => {
    const g = { fetch: null, AbortController, setTimeout, clearTimeout, FINDWEAR_SEARCH_API: 'http://test/api/search' };
    const src = require('fs').readFileSync(require('path').join(__dirname, '../assets/search.js'), 'utf8');
    new Function('window', 'globalThis', `${src}`).call(g, g, g);
    return g.ProductSearch;
  };

  const clientAnswer = async (fetchImpl) => {
    const client = loadClient();
    const realFetch = global.fetch;
    global.fetch = fetchImpl;
    try { return await client.find({ categories: ['hoodie'] }, 12); }
    finally { global.fetch = realFetch; }
  };

  const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  await testAsync('verified products come back as state "ok"', async () => {
    const r = await clientAnswer(async () => jsonResponse(200, { source: 'openwebninja', products: [{ name: 'Hoodie', productUrl: 'https://shop.com/p/1' }] }));
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.products.length, 1);
  });

  await testAsync('503 is the only state that permits the sample catalogue', async () => {
    const r = await clientAnswer(async () => jsonResponse(503, { error: 'No product source is configured.' }));
    assert.strictEqual(r.state, 'not-configured');
  });

  await testAsync('a configured source that fails is "unavailable", not "not-configured"', async () => {
    const r = await clientAnswer(async () => jsonResponse(502, { error: 'unavailable' }));
    assert.strictEqual(r.state, 'unavailable', 'samples must not be shown for a 502');
    assert.ok(r.notice && !/sample/i.test(r.notice), 'the notice must not promise sample items');
  });

  await testAsync('an unreachable endpoint is "unavailable" rather than assumed unconfigured', async () => {
    const r = await clientAnswer(async () => { throw new Error('network down'); });
    assert.strictEqual(r.state, 'unavailable');
  });

  await testAsync('a source answering with nothing verifiable is "empty"', async () => {
    const r = await clientAnswer(async () => jsonResponse(200, { source: 'openwebninja', products: [], rejected: { 'missing-image-url': 3 } }));
    assert.strictEqual(r.state, 'empty');
    assert.strictEqual(r.products.length, 0);
    assert.deepStrictEqual(r.rejected, { 'missing-image-url': 3 });
  });

  await testAsync('no state but "not-configured" ever promises sample items', async () => {
    for (const [label, impl] of [
      ['502', async () => jsonResponse(502, {})],
      ['network failure', async () => { throw new Error('down'); }],
      ['empty result', async () => jsonResponse(200, { source: 'openwebninja', products: [] })]
    ]) {
      const r = await clientAnswer(impl);
      assert.ok(!/sample/i.test(r.notice || ''), `${label} must not offer sample items`);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
})();
