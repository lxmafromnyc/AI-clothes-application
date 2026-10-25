#!/usr/bin/env node
/* =========================================================
   Fynd — which retailer pages the sizing reader may fetch

   api/_sizing/page-access.js: a page is fetched only where the site's
   terms were reviewed and permit it AND its robots.txt allows the path.
   Unreviewed is not permitted; robots.txt alone never is permission.
   What a shopper then gets: Fynd's record or the brand's official chart
   where it has one, otherwise an honest "unavailable" — with nothing
   fetched.

   Offline: every request goes to an in-process stub, counted.

   Usage: node scripts/test-page-access.js
   ========================================================= */

'use strict';

const assert = require('assert');
const access = require('../api/_sizing/page-access');
const charts = require('../api/_sizing/chart');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok    ${name}`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message.split('\n').slice(0, 12).join('\n        ') : err}`); }
}

/* a stub transport: routes by URL, every request counted; a missing
   robots.txt is a 404, anything else missing can't be reached */
const shop = (routes) => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    const r = routes[url] || (/\/robots\.txt$/.test(url) ? { status: 404, body: '' } : null);
    if (!r) throw new Error('unreachable');
    if (r.throws) throw Object.assign(new Error(r.throws), r.throws === 'blocked' ? { code: 'EBLOCKED' } : {});
    const headers = new Map(Object.entries(Object.assign({ 'content-type': /robots/.test(url) ? 'text/plain' : 'text/html' }, r.headers || {})));
    return { status: r.status || 200, ok: (r.status || 200) < 300, headers: { get: (k) => headers.get(k.toLowerCase()) || null }, text: async () => r.body || '' };
  };
  return { fetch, asked };
};

const GARMENT = `<!doctype html><html><head><title>Illustrative Tee</title></head><body><main><h1>Illustrative Tee</h1>
  <p>${'A plain cotton tee in a regular fit, described at length so the page reads as a real page rather than an empty shell. '.repeat(6)}</p>
  <h2>Garment measurements</h2><p>Measured laid flat, in cm.</p>
  <table><caption>Product size (cm)</caption><tr><th>Size</th><th>Chest width</th><th>Body length</th></tr>
  <tr><td>S</td><td>51</td><td>70</td></tr><tr><td>M</td><td>54</td><td>72</td></tr></table></main></body></html>`;

const PERMITTED = { 'reviewed.example': { access: 'permitted', basis: 'invented test shop' }, 'forbidden.example': { access: 'not-permitted', basis: 'invented: terms forbid automated access' } };

(async () => {
  console.log('\nthe policy');

  await test('as deployed, no retailer domain is permitted: permission was not established for any', () => {
    access.setPolicy(null);
    assert.deepStrictEqual(Object.keys(access.DOMAINS), []);
    const hosts = ['www.uniqlo.com', 'faq-us.uniqlo.com', 'www.nike.com', 'www.carhartt.com', 'www2.hm.com', 'www.zara.com', 'www.gap.com', 'bananarepublic.gap.com',
      'bananarepublicfactory.gapfactory.com', 'www.jcrew.com', 'www.llbean.com', 'www.madewell.com', 'www.ae.com', 'www.eileenfisher.com', 'unboundmerino.com', 'shop.example.test'];
    hosts.forEach((h) => assert.deepStrictEqual(access.permission(h), { allowed: false, reason: 'unreviewed', domain: null }, h));
  });

  await test('a listed domain covers its subdomains; not-permitted is said as such; a look-alike is not covered', () => {
    access.setPolicy(PERMITTED);
    assert.strictEqual(access.permission('www.reviewed.example').allowed, true);
    assert.strictEqual(access.permission('reviewed.example').allowed, true);
    assert.strictEqual(access.permission('notreviewed.example').reason, 'unreviewed');
    assert.strictEqual(access.permission('reviewed.example.evil.test').reason, 'unreviewed');
    assert.strictEqual(access.permission('www.forbidden.example').reason, 'not-permitted');
  });

  console.log('\nrobots.txt (RFC 9309)');

  await test('Fynd’s own group, else `*`; longest match wins; Allow wins a tie; `*` and `$` patterns; /robots.txt always allowed', () => {
    const txt = `# comment
User-agent: *
Disallow: /checkout
Disallow: /*.pdf$
Allow: /products/public

User-agent: OtherBot
Disallow: /

User-agent: FyndSizing
User-agent: SomethingElse
Disallow: /products/
Allow: /products/E1
`;
    const groups = access.parseRobots(txt);
    const own = access.rulesFor(groups);
    assert.strictEqual(access.allowedBy(own, '/products/E123'), true, 'longer Allow');
    assert.strictEqual(access.allowedBy(own, '/products/X9'), false);
    assert.strictEqual(access.allowedBy(own, '/checkout'), true, 'Fynd’s own group replaces `*`');
    const star = access.rulesFor(access.parseRobots(txt.split('User-agent: OtherBot')[0]));
    assert.strictEqual(access.allowedBy(star, '/checkout/step'), false);
    assert.strictEqual(access.allowedBy(star, '/guide.pdf'), false);
    assert.strictEqual(access.allowedBy(star, '/guide.pdf?x=1'), true, '$ anchors the end');
    assert.strictEqual(access.allowedBy(star, '/robots.txt'), true);
    assert.strictEqual(access.allowedBy(access.rulesFor(access.parseRobots('User-agent: *\nDisallow:\n')), '/anything'), true, 'an empty Disallow allows all');
    assert.strictEqual(access.allowedBy(access.rulesFor(access.parseRobots('User-agent: *\nDisallow: /\nAllow: /\n')), '/x'), true, 'tie: Allow');
    assert.strictEqual(access.allowedBy(access.rulesFor(access.parseRobots('User-agent: *\nDisallow: /%7Eproducts\n')), '/~products/1'), false, 'percent-encoded unreserved characters match');
  });

  console.log('\nthe reader, page by page');
  access.setPolicy(PERMITTED);

  await test('a permitted shop whose robots.txt allows the page: read, and its chart shown', async () => {
    const s = shop({ 'https://www.reviewed.example/robots.txt': { body: 'User-agent: *\nDisallow: /account\n' }, 'https://www.reviewed.example/p/1': { body: GARMENT } });
    const r = await charts.chartFor('https://www.reviewed.example/p/1', { noCache: true, fetch: s.fetch });
    assert.deepStrictEqual([r.status, r.charts[0].measures], ['ok', 'finished-garment']);
    assert.deepStrictEqual(s.asked, ['https://www.reviewed.example/robots.txt', 'https://www.reviewed.example/p/1'], 'robots.txt first');
  });

  await test('robots.txt disallowing the page: not fetched, and said — whether for `*` or for FyndSizing by name', async () => {
    for (const body of ['User-agent: *\nDisallow: /p/\n', 'User-agent: *\nAllow: /\n\nUser-agent: FyndSizing\nDisallow: /\n']) {
      const s = shop({ 'https://www.reviewed.example/robots.txt': { body }, 'https://www.reviewed.example/p/1': { body: GARMENT } });
      const r = await charts.chartFor('https://www.reviewed.example/p/1', { noCache: true, fetch: s.fetch });
      assert.deepStrictEqual([r.status, r.reason, r.charts], ['unavailable', 'robots-disallowed', []]);
      assert.deepStrictEqual(s.asked, ['https://www.reviewed.example/robots.txt'], 'the page itself never asked for');
      assert.match(r.note[0], /robots\.txt asks automated readers not to fetch this page/);
    }
  });

  await test('a robots.txt that can’t be read (5xx, 429, no answer) means nothing is fetched; one that doesn’t exist (404) sets no rules', async () => {
    for (const robots of [{ status: 503 }, { status: 500 }, { status: 429 }, { throws: 'reset' }]) {
      const s = shop({ 'https://www.reviewed.example/robots.txt': robots, 'https://www.reviewed.example/p/1': { body: GARMENT } });
      const r = await charts.chartFor('https://www.reviewed.example/p/1', { noCache: true, fetch: s.fetch });
      assert.deepStrictEqual([r.reason, s.asked.length], ['robots-unavailable', 1], JSON.stringify(robots));
    }
    const none = shop({ 'https://www.reviewed.example/robots.txt': { status: 404 }, 'https://www.reviewed.example/p/1': { body: GARMENT } });
    assert.strictEqual((await charts.chartFor('https://www.reviewed.example/p/1', { noCache: true, fetch: none.fetch })).status, 'ok');
  });

  await test('robots.txt alone is never permission: an unreviewed or forbidden shop is not fetched at all, robots.txt included', async () => {
    for (const host of ['www.unreviewed.example', 'www.forbidden.example']) {
      const s = shop({ [`https://${host}/robots.txt`]: { body: 'User-agent: *\nAllow: /\n' }, [`https://${host}/p/1`]: { body: GARMENT } });
      const r = await charts.chartFor(`https://${host}/p/1`, { noCache: true, fetch: s.fetch });
      assert.deepStrictEqual([r.status, r.reason, s.asked], ['unavailable', host.includes('forbidden') ? 'not-permitted' : 'unreviewed', []], host);
      assert.ok(r.note.some((n) => /You can open the original product page/.test(n)), 'the shopper is pointed to the page itself');
    }
  });

  await test('a redirect is checked again: to an unreviewed site, or to a path robots.txt disallows, it is not followed', async () => {
    const away = shop({ 'https://www.reviewed.example/p/1': { status: 301, headers: { location: 'https://www.elsewhere.example/p/1' } }, 'https://www.elsewhere.example/p/1': { body: GARMENT } });
    const r1 = await charts.chartFor('https://www.reviewed.example/p/1', { noCache: true, fetch: away.fetch });
    assert.strictEqual(r1.reason, 'unreviewed');
    assert.ok(!away.asked.some((u) => u.startsWith('https://www.elsewhere.example')));
    const inside = shop({ 'https://www.reviewed.example/robots.txt': { body: 'User-agent: *\nDisallow: /private/\n' }, 'https://www.reviewed.example/p/1': { status: 302, headers: { location: '/private/p/1' } }, 'https://www.reviewed.example/private/p/1': { body: GARMENT } });
    const r2 = await charts.chartFor('https://www.reviewed.example/p/1', { noCache: true, fetch: inside.fetch });
    assert.strictEqual(r2.reason, 'robots-disallowed');
    assert.ok(!inside.asked.includes('https://www.reviewed.example/private/p/1'));
  });

  await test('a size guide robots.txt disallows is not read: the page says it links a guide that couldn’t be read', async () => {
    const page = GARMENT.replace(/<h2>Garment[\s\S]*<\/table>/, '<a href="/size-guide">Size guide</a>');
    const s = shop({ 'https://www.reviewed.example/robots.txt': { body: 'User-agent: *\nDisallow: /size-guide\n' }, 'https://www.reviewed.example/p/1': { body: page }, 'https://www.reviewed.example/size-guide': { body: GARMENT } });
    const r = await charts.chartFor('https://www.reviewed.example/p/1', { noCache: true, fetch: s.fetch });
    assert.ok(!s.asked.includes('https://www.reviewed.example/size-guide'), s.asked.join(' '));
    assert.strictEqual(r.status, 'unavailable');
    assert.strictEqual(r.charts.length, 0);
  });

  console.log('\nwhat a shopper gets, as deployed');
  access.setPolicy(null);

  await test('the five UNIQLO products: the four with records answer from them, unchanged, with nothing fetched; the one without says so', async () => {
    const s = shop({});
    /* each record's own status: the UNIQLO pair is pending review */
    const expect = { 'E475378-000': 'unverified', 'E475377-000': 'unverified', 'E471808-000': 'unverified', 'E455365-000': 'unverified' };
    for (const code of ['E475378-000', 'E475377-000', 'E471808-000', 'E455365-000', 'E429066-000']) {
      const r = await charts.chartFor(`https://www.uniqlo.com/us/en/products/${code}/00`, { noCache: true, fetch: s.fetch });
      if (expect[code]) {
        assert.deepStrictEqual([r.status, r.from, r.verification], ['ok', 'fynd-record', expect[code]], code);
        assert.ok(r.charts.length > 0, code);
      } else {
        assert.deepStrictEqual([r.status, r.reason, r.charts], ['unavailable', 'unreviewed', []], code);
      }
    }
    assert.deepStrictEqual(s.asked, [], 'no UNIQLO page, and no robots.txt, was requested');
  });

  await test('a body-only record (Nike) keeps its chart and says the product’s own measurements weren’t looked for — not that the page failed', async () => {
    const s = shop({});
    const r = await charts.chartFor('https://www.nike.com/t/club-mens-fleece-crew-RU1Il4yl/FN3886-010', { noCache: true, fetch: s.fetch });
    assert.deepStrictEqual([r.status, r.from, s.asked], ['ok', 'fynd-record', []]);
    assert.ok(r.charts.length > 0 && r.charts.every((c) => c.measures === 'body'));
    assert.ok(r.note.some((n) => /weren’t looked for: Fynd doesn’t read Nike’s pages without confirmed permission\./.test(n)), r.note.join('\n'));
  });

  await test('another shop’s link: nothing fetched, an honest unavailable, and the page linked', async () => {
    const s = shop({});
    const r = await charts.chartFor('https://www.gap.com/browse/product.do?pid=821270112', { noCache: true, fetch: s.fetch });
    assert.deepStrictEqual([r.status, r.reason, r.charts, s.asked], ['unavailable', 'unreviewed', [], []]);
    assert.strictEqual(r.source.url, 'https://www.gap.com/browse/product.do?pid=821270112');
    assert.match(r.note[0], /hasn’t confirmed that this retailer allows its pages to be read automatically/);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exit(1);
})();
