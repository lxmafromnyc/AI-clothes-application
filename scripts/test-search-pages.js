#!/usr/bin/env node
/* =========================================================
   Fynd — product discovery beyond Fynd's own five products, and its
   pages ("Load more")

   Runs the real /api/search handler (api/search.js) on a stand-in
   product source registered the way any adapter is
   (product-source.registerProvider). The stand-in answers each search
   from a generated inventory — hundreds of listings across many
   garments and brands — so what is asserted is what the handler does
   with a real source's pages, not what one fixture happens to hold.
   Nothing here touches the network.

   What is asserted:
     inventory   results are not Fynd's five UNIQLO products; different
                 queries reach the source and come back different
     pages       paginate: true answers page 1 of 20 with a cursor; the
                 cursor asks the SAME source for page 2 (the source sees
                 page: 2), never the same records again; nothing repeats
                 across pages; a new search starts at page 1
     the cursor  holds the search on the server (an edited request can't
                 change it), single use (a second click is 409), refused
                 when never issued, five source pages per paid search
     endings     an empty page ends the list; a source that doesn't page
                 never offers more; a failed page gives its cursor back
     metering    a new search is one metered search, as before; Load more
                 is not; an exhausted allowance stops new searches but not
                 the pages of one already paid for; `search:more` paces
                 pages; no fit-analysis or AI allowance is touched
     unchanged   a request without `paginate` is answered exactly as it
                 was, with no page fields
     step 01     a listing kept as the garment owned brings no
                 measurements: only the exact, checked product in the
                 label's size, or the shopper's own, stand in

   Usage: node scripts/test-search-pages.js
   ========================================================= */

'use strict';

const assert = require('assert');
const store = require('../api/_store');
const cache = require('../api/_cache');
const pages = require('../api/_providers/pages');
const source = require('../api/_providers/product-source');
const limits = require('../api/_ratelimit');
const usage = require('../api/_usage');
const { SEARCHES, AI_TOKENS } = require('../api/_plans');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    store.reset && store.reset();
    cache.reset();
    calls.length = 0;
    standin.failNext = 0;
    standin.emptyFrom = Infinity;
    standin.pagesTo = true;
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n        ') : err}`);
  }
}

/* ---------- a stand-in source with a real inventory and real pages ---------- */

const BRANDS = ['Nike', "Levi's", 'Uniqlo', 'Zara', 'H&M', 'Carhartt', 'Patagonia', 'Champion', 'Everlane', 'J.Crew'];
const GARMENTS = ['hoodie', 'zip-up hoodie', 'jeans', '501 jeans', 'wool coat', 't-shirt', 'straight-leg trousers', 'sweatshirt', 'puffer jacket', 'chinos'];
const COLOURS = ['black', 'white', 'navy', 'grey', 'olive', 'cream'];
const FITS = ['oversized', 'relaxed', 'regular', 'slim'];
const SHOPS = ['nordstrom.com', 'macys.com', 'zappos.com', 'asos.com', 'urbanoutfitters.com'];
const INVENTORY = [];
BRANDS.forEach((brand, b) => GARMENTS.forEach((garment, g) => COLOURS.forEach((colour, c) => {
  const fit = FITS[(b + g + c) % FITS.length];
  const shop = SHOPS[(b + c) % SHOPS.length];
  const id = `${b}-${g}-${c}`;
  INVENTORY.push({
    product_id: id,
    title: `${brand} ${fit} ${colour} ${garment}`,
    brand,
    price: 20 + ((b * 7 + g * 11 + c * 3) % 180),
    image: `https://img.shop.example/${id}.jpg`,
    /* a tracking parameter, as real shop links carry */
    link: `https://www.${shop}/p/${id}?utm_source=feed`,
    store: shop
  });
})));

const calls = [];
const standin = {
  name: 'standin',
  paginates: true,
  configured: () => true,
  failNext: 0,
  emptyFrom: Infinity,
  async search(intent, options) {
    const page = options && options.page ? options.page : 1;
    const limit = options && options.limit ? options.limit : 12;
    const words = [].concat(intent.keywords || [], intent.brands || [], intent.colors || [], intent.fits || [], intent.categories || [])
      .map((w) => String(w).toLowerCase().replace(/'/g, '')).filter(Boolean);
    calls.push({ page, limit, words: words.join(' ') });
    if (this.failNext > 0) { this.failNext -= 1; throw Object.assign(new Error('Standin responded 500 on search'), { status: 500 }); }
    if (page >= this.emptyFrom) return [];
    const matching = INVENTORY.filter((p) => words.every((w) => p.title.toLowerCase().replace(/'/g, '').includes(w)));
    /* a page overlaps the one before by two listings, as engines do */
    const size = limit;
    const start = Math.max(0, (page - 1) * size - 2);
    return matching.slice(start, start + size);
  }
};
const flat = Object.assign({}, standin, { name: 'flat', paginates: false, search: standin.search });
source.registerProvider(standin);
source.registerProvider(flat);
process.env.PRODUCT_SOURCE = 'standin';

const handler = require('../api/search');

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.getHeader = (k) => res.headers[k];
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.end = () => res;
  return res;
}
/* one caller per address: the anonymous subject is the address hash */
async function post(body, who) {
  const res = fakeRes();
  await handler({ method: 'POST', headers: { 'x-forwarded-for': who || '203.0.113.1', 'user-agent': 'test' }, body, on: () => {} }, res);
  return res;
}
const intentOf = (text) => ({ keywords: text.toLowerCase().split(/\s+/) });
const keysOf = (products) => products.map((p) => p.productUrl);

const FYND_FIVE = ['Sweat Oversized Pullover Hoodie', 'Sweat Pullover Hoodie', 'Sweatshirt', 'SUPIMA® Cotton T-Shirt', "Men's Extra Fine Merino Crew Neck Long-Sleeve Sweater"];

(async () => {
  console.log('\ninventory');

  await test('a search is answered from the connected source, not from Fynd’s five UNIQLO products', async () => {
    const res = await post({ intent: intentOf('black hoodie'), limit: 20, paginate: true });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.source, 'standin');
    assert.strictEqual(res.body.products.length, 20);
    assert.ok(res.body.products.every((p) => !FYND_FIVE.includes(p.name)));
    assert.ok(res.body.products.every((p) => /black/i.test(p.name) && /hoodie/i.test(p.name)));
  });

  await test('the six example requests reach the source and come back different from each other', async () => {
    const asked = ['black oversized hoodie', 'nike zip-up hoodie', 'levis 501 jeans', 'wool coat', 'white oversized t-shirt', 'straight-leg trousers'];
    const seen = [];
    for (const [i, text] of asked.entries()) {
      const res = await post({ intent: intentOf(text), limit: 20, paginate: true }, `198.51.100.${i + 1}`);
      assert.strictEqual(res.statusCode, 200, text);
      assert.ok(res.body.products.length > 0, `${text}: nothing found`);
      const words = text.replace(/'/g, '').split(' ');
      assert.ok(res.body.products.every((p) => words.every((w) => p.name.toLowerCase().replace(/'/g, '').includes(w))), `${text}: a product that does not match`);
      seen.push(keysOf(res.body.products).join('|'));
    }
    assert.strictEqual(new Set(seen).size, asked.length, 'two requests answered with the same list');
    assert.deepStrictEqual(calls.map((c) => c.words), asked.map((t) => t.replace(/'/g, '')), 'each request was its own search at the source');
  });

  await test('every product shown is the source’s own: title, image, price and link as the source gave them', async () => {
    const res = await post({ intent: intentOf('olive chinos'), limit: 20, paginate: true });
    for (const p of res.body.products) {
      const raw = INVENTORY.find((r) => r.link === p.productUrl);
      assert.ok(raw, `a product the source never listed: ${p.productUrl}`);
      assert.strictEqual(p.name, raw.title);
      assert.strictEqual(p.imageUrl, raw.image);
      assert.strictEqual(p.price, raw.price);
      assert.strictEqual(p.brand, raw.brand);
    }
  });

  console.log('\npages');

  await test('page 1 offers more; the cursor fetches page 2 from the source, and nothing repeats', async () => {
    const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true });
    assert.strictEqual(one.body.page, 1);
    assert.strictEqual(one.body.hasMore, true);
    assert.match(one.body.nextCursor, /^[A-Za-z0-9_-]{20,64}$/);
    const two = await post({ cursor: one.body.nextCursor });
    assert.strictEqual(two.statusCode, 200);
    assert.strictEqual(two.body.page, 2);
    assert.deepStrictEqual(calls.map((c) => c.page), [1, 2], 'page 2 was asked of the source');
    assert.ok(two.body.products.length > 0);
    const first = new Set(keysOf(one.body.products));
    assert.ok(keysOf(two.body.products).every((k) => !first.has(k)), 'a product from page 1 came back on page 2');
    /* the source overlapped its pages by two: the server removed them */
    assert.strictEqual(two.body.pagination.repeatedRemoved, 2);
  });

  await test('the same product under two tracking links shows once', async () => {
    const one = INVENTORY[0];
    const twin = Object.assign({}, one, { product_id: 'twin', link: one.link.replace('utm_source=feed', 'utm_source=other&gclid=x') });
    const real = standin.search;
    standin.search = async () => [one, twin, INVENTORY[1]];
    try {
      const res = await post({ intent: intentOf('anything'), limit: 20, paginate: true });
      assert.strictEqual(res.body.products.length, 2);
    } finally { standin.search = real; }
  });

  await test('browsing to the end: five pages at most, no product twice, and the list says when it ends', async () => {
    let res = await post({ intent: intentOf('jeans'), limit: 20, paginate: true });
    const all = keysOf(res.body.products);
    let n = 1;
    while (res.body.hasMore) {
      res = await post({ cursor: res.body.nextCursor });
      assert.strictEqual(res.statusCode, 200);
      all.push(...keysOf(res.body.products));
      n += 1;
    }
    assert.strictEqual(n, pages.MAX_PAGES);
    assert.strictEqual(res.body.nextCursor, null);
    assert.strictEqual(new Set(all).size, all.length, 'a product repeated across pages');
    assert.ok(all.length > 20 * 3, `only ${all.length} products over ${n} pages`);
  });

  await test('a new search starts again at page 1, with its own cursor', async () => {
    const a = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true });
    await post({ cursor: a.body.nextCursor });
    const b = await post({ intent: intentOf('coat'), limit: 20, paginate: true });
    assert.strictEqual(b.body.page, 1);
    assert.notStrictEqual(b.body.nextCursor, a.body.nextCursor);
    assert.deepStrictEqual(calls.map((c) => c.page), [1, 2, 1]);
    assert.ok(b.body.products.every((p) => /coat/i.test(p.name)));
  });

  console.log('\nthe cursor');

  await test('the cursor holds the search: anything else sent beside it is ignored', async () => {
    const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true });
    const two = await post({ cursor: one.body.nextCursor, intent: intentOf('jeans'), limit: 24 });
    assert.strictEqual(calls[1].words, 'hoodie');
    assert.strictEqual(calls[1].limit, 20);
    assert.ok(two.body.products.every((p) => /hoodie/i.test(p.name)));
  });

  await test('a cursor is used once: a second click on the same one is 409, and buys nothing', async () => {
    const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true });
    const [a, b] = await Promise.all([post({ cursor: one.body.nextCursor }), post({ cursor: one.body.nextCursor })]);
    assert.deepStrictEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.strictEqual(calls.filter((c) => c.page === 2).length, 1);
  });

  await test('a cursor never issued, or already used up, is refused before the source is asked', async () => {
    const made = await post({ cursor: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    assert.strictEqual(made.statusCode, 410);
    assert.strictEqual(made.body.reason, 'cursor-expired');
    const odd = await post({ cursor: '../../etc' });
    assert.strictEqual(odd.statusCode, 410);
    assert.deepStrictEqual(calls, [], 'a refused cursor reached the source');
  });

  await test('an anonymous browser keeps its cursor when its device cookie arrives after page 1', async () => {
    /* page 1 is metered by address (no cookie yet), page 2 by the device cookie it was given */
    const res1 = fakeRes();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'test' }, body: { intent: intentOf('hoodie'), limit: 20, paginate: true }, on: () => {} }, res1);
    const cookie = String([].concat(res1.headers['Set-Cookie'] || res1.headers['set-cookie'] || [])[0] || '').split(';')[0];
    assert.ok(cookie, 'no device cookie was offered');
    const res2 = fakeRes();
    await handler({ method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9', 'user-agent': 'test', cookie }, body: { cursor: res1.body.nextCursor }, on: () => {} }, res2);
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.body.page, 2);
  });

  await test('however many hold a cursor, one paid search buys at most five source pages', async () => {
    let res = await post({ intent: intentOf('jeans'), limit: 20, paginate: true }, '203.0.113.30');
    let n = 0;
    while (res.body.nextCursor) {
      const cursor = res.body.nextCursor;
      const [a, b] = await Promise.all([post({ cursor }, '203.0.113.31'), post({ cursor }, '203.0.113.32')]);
      res = a.statusCode === 200 ? a : b;
      assert.strictEqual(res.statusCode, 200);
      n += 1;
    }
    assert.strictEqual(calls.length, pages.MAX_PAGES);
    assert.strictEqual(n, pages.MAX_PAGES - 1);
  });

  console.log('\nendings');

  await test('an empty page from the source ends the list', async () => {
    standin.emptyFrom = 2;
    const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true });
    const two = await post({ cursor: one.body.nextCursor });
    assert.strictEqual(two.statusCode, 200);
    assert.deepStrictEqual(two.body.products, []);
    assert.strictEqual(two.body.hasMore, false);
    assert.strictEqual(two.body.nextCursor, null);
  });

  await test('a short page is the last: no Load more is offered over it', async () => {
    const res = await post({ intent: intentOf('patagonia black hoodie'), limit: 20, paginate: true });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.products.length > 0 && res.body.products.length < 20);
    assert.strictEqual(res.body.hasMore, false);
    assert.strictEqual(res.body.nextCursor, null);
  });

  await test('nothing found: an honest empty page, and no Load more', async () => {
    const res = await post({ intent: intentOf('sequinned kilt'), limit: 20, paginate: true });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.products, []);
    assert.strictEqual(res.body.hasMore, false);
  });

  await test('a source that does not page never offers more', async () => {
    process.env.PRODUCT_SOURCE = 'flat';
    try {
      const res = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true });
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.products.length > 0);
      assert.strictEqual(res.body.hasMore, false);
      assert.strictEqual(res.body.nextCursor, null);
      assert.strictEqual(res.body.pagination.supported, false);
    } finally { process.env.PRODUCT_SOURCE = 'standin'; }
  });

  await test('a source failure on a first search is a 502, not charged; on a later page the cursor is given back', async () => {
    standin.failNext = 1;
    const failed = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true }, '203.0.113.20');
    assert.strictEqual(failed.statusCode, 502);
    const state = await usage.check(await subjectOf('203.0.113.20'), 'free', SEARCHES);
    assert.strictEqual(state.used, 0, 'a failed search was charged');

    const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true });
    standin.failNext = 1;
    const two = await post({ cursor: one.body.nextCursor });
    assert.strictEqual(two.statusCode, 502);
    const again = await post({ cursor: one.body.nextCursor });
    assert.strictEqual(again.statusCode, 200, 'the cursor was not given back');
    assert.strictEqual(again.body.page, 2);
  });

  console.log('\nmetering');

  await test('a new search is one metered search; Load more is not', async () => {
    const who = '192.0.2.50';
    const subject = await subjectOf(who);
    const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true }, who);
    assert.strictEqual(one.body.usage.used, 1);
    const two = await post({ cursor: one.body.nextCursor }, who);
    const three = await post({ cursor: two.body.nextCursor }, who);
    assert.strictEqual(three.statusCode, 200);
    assert.strictEqual((await usage.check(subject, 'free', SEARCHES)).used, 1, 'a page was charged as a search');
    assert.strictEqual(three.body.usage.used, 1);
  });

  await test('with the allowance used up, a new search is refused but the paid search can still be browsed', async () => {
    const who = '192.0.2.51';
    let last;
    for (let i = 0; i < 3; i += 1) last = await post({ intent: intentOf(['hoodie', 'jeans', 'coat'][i]), limit: 20, paginate: true }, who);
    assert.strictEqual(last.body.usage.remaining, 0);
    const refused = await post({ intent: intentOf('chinos'), limit: 20, paginate: true }, who);
    assert.strictEqual(refused.statusCode, 429);
    assert.strictEqual(refused.body.reason, 'over-limit');
    const page = await post({ cursor: last.body.nextCursor }, who);
    assert.strictEqual(page.statusCode, 200);
    assert.ok(page.body.products.every((p) => /coat/i.test(p.name)));
  });

  await test('pages are paced per caller (search:more), apart from the plan’s allowance', async () => {
    const who = '192.0.2.52';
    const subject = await subjectOf(who);
    for (let i = 0; i < limits.LIMITS['search:more'].max; i += 1) await limits.note('search:more', subject);
    const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true }, who);
    const two = await post({ cursor: one.body.nextCursor }, who);
    assert.strictEqual(two.statusCode, 429);
    assert.strictEqual(two.body.reason, 'rate-limited');
    assert.deepStrictEqual(calls.map((c) => c.page), [1]);
    /* the cursor was not spent by the refusal */
    await limits.clear('search:more', subject);
    assert.strictEqual((await post({ cursor: one.body.nextCursor }, who)).statusCode, 200);
  });

  await test('discovery touches no fit-analysis or AI allowance', async () => {
    const who = '192.0.2.53';
    const subject = await subjectOf(who);
    const noted = [];
    const realNote = limits.note;
    limits.note = async (name, s) => { noted.push(name); return realNote(name, s); };
    try {
      const one = await post({ intent: intentOf('hoodie'), limit: 20, paginate: true }, who);
      await post({ cursor: one.body.nextCursor }, who);
    } finally { limits.note = realNote; }
    assert.deepStrictEqual([...new Set(noted)], ['search:more']);
    assert.strictEqual((await usage.check(subject, 'free', AI_TOKENS)).used, 0);
  });

  console.log('\nunchanged');

  await test('a request without paginate is answered as before: no page fields, no cursor', async () => {
    const res = await post({ intent: intentOf('hoodie'), limit: 12 });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.products.length, 12);
    ['page', 'hasMore', 'nextCursor', 'pagination'].forEach((k) => assert.ok(!(k in res.body), `${k} on an unpaginated answer`));
    assert.deepStrictEqual(calls.map((c) => c.page), [1]);
  });

  await test('the pages module: tracking parameters never make two products, a product id in the query does', async () => {
    assert.strictEqual(pages.urlKey('https://www.shop.example/p/1?utm_source=a&gclid=b'), pages.urlKey('https://shop.example/p/1/'));
    assert.notStrictEqual(pages.urlKey('https://shop.example/item?pid=1'), pages.urlKey('https://shop.example/item?pid=2'));
    const a = { name: 'Hoodie', retailer: 'shop.example', productUrl: 'https://shop.example/p/1' };
    const b = { name: 'Hoodie', retailer: 'shop.example', productUrl: 'https://shop.example/p/1?colour=black' };
    const out = pages.unseen([a, b], [], 10);
    assert.strictEqual(out.products.length, 1, 'same retailer and name');
    /* a product cut by the page size is not marked seen */
    const cut = pages.unseen([a, { name: 'Coat', retailer: 'x', productUrl: 'https://x.example/c' }], [], 1);
    assert.strictEqual(pages.unseen([{ name: 'Coat', retailer: 'x', productUrl: 'https://x.example/c' }], cut.seen, 5).products.length, 1);
  });

  console.log('\nthe adapters');

  await test('OpenWeb Ninja: page 1 is the request it always was; Load more adds the source’s own page', async () => {
    const own = require('../api/_providers/openwebninja');
    const first = own.searchRequest(intentOf('black hoodie'), { limit: 20 });
    const paged = own.searchRequest(intentOf('black hoodie'), { limit: 20, page: 3 });
    assert.strictEqual(first.params.has('page'), false);
    assert.strictEqual(paged.params.get('page'), '3');
    const rest = (p) => [...p.entries()].filter(([k]) => k !== 'page');
    assert.deepStrictEqual(rest(paged.params), rest(first.params));
    assert.strictEqual(own.paginates, true);
  });

  await test('Serper: both endpoints send `page` from page 2 on, and nothing new on page 1', async () => {
    const serper = require('../api/_providers/serper');
    process.env.SERPER_API_KEY = 'test-key';
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ shopping: [], organic: [] }), text: async () => '{}' }; };
    try {
      await serper.search(intentOf('hoodie'), { limit: 20 });
      await serper.search(intentOf('hoodie'), { limit: 20, page: 2 });
      await serper.searchOrganic(intentOf('hoodie'), { limit: 20, page: 2 });
    } finally { global.fetch = realFetch; delete process.env.SERPER_API_KEY; }
    assert.strictEqual('page' in sent[0].body, false);
    assert.strictEqual(sent[1].body.page, 2);
    assert.strictEqual(sent[2].body.page, 2);
    assert.strictEqual(serper.paginates, true);
  });

  await test('SerpApi says it does not page, so no Load more is ever offered over it', async () => {
    assert.strictEqual(require('../api/_providers/serpapi').paginates, false);
    assert.strictEqual(pages.supports(require('../api/_providers/serpapi')), false);
  });

  console.log('\na listing as the garment you own (step 01)');

  /* What step 01 sends when a listing is kept: its brand, the label's
     size and the listing's link — and measurements only if the shopper
     entered them. The engine decides what stands in, by its own rule. */
  const { asChecked, UQ_PAIR } = require('./fixtures/as-checked');
  const engine = require('../api/_sizing/engine');
  const records = require('../api/_sizing/records');
  const Schema = require('../assets/fit-profile-schema.js');
  const owning = (anchor) => Object.assign(Schema.empty(), { garments: { sweatshirts: Object.assign(Schema.emptyGarment('sweatshirts'), { favorite: 'perfect', line: 'men', anchor }) } });
  const ITEM = 'uniqlo-e475378-sweat-pullover-hoodie-us';

  await test('a listing Fynd holds no record of brings no measurements: another model of the same brand is never borrowed', () => asChecked(UQ_PAIR, () => {
    /* a shop's listing of a UNIQLO sweatshirt, not UNIQLO's own page for the checked one */
    const listing = owning({ brand: 'UNIQLO', size: 'M', product: { url: 'https://www.shop.example/p/uniqlo-sweatshirt-grey' } });
    const v = engine.validate(listing, records.byId(ITEM));
    assert.strictEqual(v.code, 'no-reference-measurements');
    assert.strictEqual(v.canRecommend, false);
    /* a brand and a size alone: no brand chart stands in either */
    const bare = engine.validate(owning({ brand: 'UNIQLO', size: 'M' }), records.byId(ITEM));
    assert.ok(['no-reference', 'no-reference-measurements'].includes(bare.code), bare.code);
    assert.strictEqual(bare.canRecommend, false);
  }));

  await test('the exact product, checked, in the label’s size: its verified measurements stand in', () => asChecked(UQ_PAIR, () => {
    const exact = owning({ brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } });
    const v = engine.validate(exact, records.byId(ITEM));
    assert.strictEqual(v.ready, true, JSON.stringify(v));
    assert.ok(engine.compare(exact, records.byId(ITEM)).recommended);
  }));

  await test('the exact product, not yet checked: its measurements do not stand in', () => {
    const exact = owning({ brand: 'UNIQLO', size: 'M', product: { url: 'https://www.uniqlo.com/us/en/products/E475377-000/00' } });
    const item = records.byId(ITEM);
    /* the item checked, the reference left as production holds it */
    return asChecked([ITEM], () => {
      assert.strictEqual(engine.validate(exact, item).code, 'no-reference-measurements');
    });
  });

  await test('a listing with the shopper’s own measurements is compared on those, through the same engine', () => asChecked(UQ_PAIR, () => {
    const mine = owning({ brand: 'Nike', size: 'L', product: { url: 'https://www.shop.example/p/0-0-0' }, measurements: { unit: 'cm', chestWidth: 60, bodyLength: 70, shoulderWidth: 54, sleeveLength: 61 } });
    const { answers, errors } = Schema.normaliseGuide({ garments: { sweatshirts: mine.garments.sweatshirts } });
    assert.deepStrictEqual(errors, []);
    const profile = Object.assign(Schema.empty(), { garments: { sweatshirts: answers.garments.sweatshirts } });
    const v = engine.validate(profile, records.byId(ITEM));
    /* the engine reads the shopper's numbers, and holds them to its own
       method rules (here UNIQLO measures length from the centre back) */
    assert.notStrictEqual(v.code, 'no-reference-measurements');
    assert.ok(v.dimensions.length && v.dimensions.every((d) => d.reference && d.reference.status === 'shopper-measured'), JSON.stringify(v.dimensions));
  }));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();

/* the anonymous subject one address is metered under (api/_auth.js) */
async function subjectOf(who) {
  const { identify } = require('../api/_auth');
  const users = require('../api/_users');
  const id = await identify({ headers: { 'x-forwarded-for': who, 'user-agent': 'test' } }, null, users);
  return id.subject;
}
