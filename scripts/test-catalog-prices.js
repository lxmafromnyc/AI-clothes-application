#!/usr/bin/env node
/* =========================================================
   Fynd — catalogue price extractor test

   scripts/fetch-catalog-prices.js reads what a product costs off the
   page a catalogue row already links to. Like the image extractor, it
   is worth nothing on the strength of having run: a product page is
   full of figures that parse as money, and the only thing that makes
   the reader useful is which ones it REFUSES.

   The two that matter are here in the shapes the real pages produce,
   taken from --explain --json captures of the live listings:

     UNIQLO   serves no price at all over plain HTTP, and renders
              exactly one figure — which sits in no product-specific
              block. The page IS the canonical page for the listing,
              and the previous reading let that vouch for the figure.
              It must not: canonical vouches for the page, not for
              which of the page's figures is this product's price.

     J.Crew   publishes a ProductGroup AU763 with sku AU763-WT0002,
              a name and an image, and offers: [] — no price in the
              structured record at all. Rendered, it shows $98, $128,
              $118, $58.50 and $148, four of them marked as the current
              price. Nothing says which is charged, so the answer is to
              fail closed rather than to pick one.

   Both are asserted as refusals, and then the same structures with the
   provenance they would need are asserted as acceptances — otherwise a
   reader that refuses everything would pass this file.

   The browser path is exercised for real: a local server plays a
   retailer that hydrates its price in JavaScript, and Chromium is sent
   at it exactly as the extractor would. No retailer is contacted, so
   this runs anywhere, including behind a proxy that refuses every host
   on the internet.

   Usage: node scripts/test-catalog-prices.js
   Skips the browser section with a clear message if Playwright is absent.
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const prices = require('./fetch-catalog-prices');

let passed = 0;
let skipped = 0;
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

const UNIQLO = 'https://www.uniqlo.com/us/en/products/E429066-000/00';
const JCREW = 'https://www.jcrew.com/p/mens/categories/clothing/shirts/broken-in-oxford/broken-in-organic-cotton-oxford-shirt/AU763';
const LLBEAN = 'https://www.llbean.com/llb/shop/129244';

const amounts = (list) => list.map((c) => c.amount);
const gates = (refusals) => refusals.map((r) => r.gate);
const because = (refusals, amount) => (refusals.find((r) => r.amount === amount) || {}).why || '';

/* a rendered figure in the shape gatherPricesInPage reports one, so a
   fixture says only what it means to say and inherits the rest */
function figure(extra) {
  return Object.assign({
    text: '$0.00',
    selector: 'span.price',
    own: '',
    near: '',
    aria: null,
    itemprop: null,
    content: null,
    offerScope: false,
    codes: [],
    codeLabel: null,
    scopeSkus: [],
    lineThrough: false,
    hidden: false,
    area: 1400,
    chain: []
  }, extra);
}

const seenOf = (canonical, list, jsonld) => ({
  canonical,
  metas: { 'og:url': canonical },
  jsonld: jsonld || [],
  prices: list
});

/* ---------------------------------------------------------
   UNIQLO, as the capture has it
   --------------------------------------------------------- */

/* what plain HTTP serves: a product record with a sku and no offer.
   The price is hydrated, so the served markup carries no figure. */
const uniqloServed = `<!doctype html><html><head>
<link rel="canonical" href="${UNIQLO}">
<meta property="og:title" content="Extra Fine Merino Crew Neck Long-Sleeve Sweater">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","sku":"E429066-000",
 "name":"Extra Fine Merino Crew Neck Long-Sleeve Sweater",
 "image":["https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/429066/item/goods_03_429066_3x4.jpg"]}
</script></head><body><div id="root"></div></body></html>`;

/* what the browser run finds: one figure, in a block that names no
   product, on a page that is the listing's canonical page */
const uniqloRendered = seenOf(UNIQLO, [
  figure({
    text: '$7.90',
    selector: 'span.fr-ec-price-text',
    own: 'fr-ec-price-text',
    near: 'fr-ec-price fr-ec-text-color-accent',
    area: 900
  })
], [uniqloServed.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]]);

console.log('\nUNIQLO — a rendered figure the page never ties to the product\n');

test('plain HTTP offers no price candidate at all', () => {
  const read = prices.pricesFromHtml(uniqloServed);
  assert.deepStrictEqual(read.candidates, [], 'the served markup carries no price, so nothing may be offered as one');
});

test('and says so: the product record publishes no offer', () => {
  const read = prices.pricesFromHtml(uniqloServed);
  assert.strictEqual(read.empties.length, 1);
  assert.match(read.empties[0].why, /no offers/);
  assert.deepStrictEqual(read.empties[0].skus, ['e429066-000']);
});

test('the one rendered figure is REFUSED — canonical is not product-specific', () => {
  const read = prices.renderedCandidates(uniqloRendered, UNIQLO);
  assert.strictEqual(read.candidates.length, 1, 'the capture holds exactly one rendered candidate');
  assert.strictEqual(read.candidates[0].amount, 7.9);

  const verdict = prices.decide(read.candidates, UNIQLO);
  assert.strictEqual(verdict.price, undefined, 'nothing may be written from a figure with no product-specific provenance');
  assert.deepStrictEqual(gates(verdict.refusals), ['this']);
  assert.match(because(verdict.refusals, 7.9), /canonical page/);
  assert.match(because(verdict.refusals, 7.9), /vouches for the page, not for which of its figures/);
});

test('the refusal is about provenance, not about the amount', () => {
  const verdict = prices.decide(prices.renderedCandidates(uniqloRendered, UNIQLO).candidates, UNIQLO);
  assert.doesNotMatch(because(verdict.refusals, 7.9), /too (low|small|cheap)/,
    'refusing 7.90 for being a suspicious number would accept the next wrong figure that looks plausible');
});

test('the same figure IS accepted once its own block names the product', () => {
  /* the amount here is illustrative: what the test is about is that a
     price element sitting in THIS product's price block clears the gate
     the canonical page could not */
  const scoped = seenOf(UNIQLO, [
    figure({
      text: '$49.90',
      selector: 'span.price-limited',
      own: 'price-limited current-price',
      near: 'fr-ec-price product-price-block',
      codes: ['E429066-000'],
      codeLabel: 'div.product-main#product-E429066-000'
    })
  ]);
  const verdict = prices.decide(prices.renderedCandidates(scoped, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, 49.9);
  assert.strictEqual(verdict.identity.via, 'dom-product-scope');
  assert.match(verdict.why, /names E429066-000/);
});

test('a price block naming ANOTHER product is refused by name', () => {
  const strip = seenOf(UNIQLO, [
    figure({
      text: '$19.90',
      own: 'current-price',
      near: 'recommendation-tile',
      codes: ['E457263-000'],
      codeLabel: 'div.rec-tile#product-E457263-000'
    })
  ]);
  const verdict = prices.decide(prices.renderedCandidates(strip, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, undefined);
  assert.match(because(verdict.refusals, 19.9), /not this listing/);
});

/* ---------------------------------------------------------
   J.Crew, as the capture has it
   --------------------------------------------------------- */

const jcrewServed = `<!doctype html><html><head>
<link rel="canonical" href="${JCREW}">
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"ProductGroup","productGroupID":"AU763","sku":"AU763-WT0002",
 "name":"Broken-in organic cotton oxford shirt",
 "image":"https://www.jcrew.com/s7-img-facade/AU763_WT0002",
 "offers":[]}
</script></head><body></body></html>`;

/* five figures, four of them marked as the current price, all of them
   inside the group's own product block */
const jcrewRendered = seenOf(JCREW, [
  figure({ text: '$98', selector: 'span.is-price--current', own: 'is-price--current', near: 'product-price AU763', codes: ['AU763'], codeLabel: 'div.product-details#AU763' }),
  figure({ text: '$128', selector: 'span.is-price--list', own: 'is-price--list', near: 'product-price', codes: ['AU763'], lineThrough: true }),
  figure({ text: '$118', selector: 'span.is-price--current', own: 'is-price--current', near: 'product-price', codes: ['AU763'] }),
  figure({ text: '$58.50', selector: 'span.is-price--sale', own: 'is-price--sale', near: 'product-price', codes: ['AU763'] }),
  figure({ text: '$148', selector: 'span.current-price', own: 'current-price', near: 'product-price', codes: ['AU763'] })
], [jcrewServed.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]]);

console.log('\nJ.Crew — a product record with no offer, and five rendered figures\n');

test('the ProductGroup publishes offers: [] and so offers no candidate', () => {
  const read = prices.pricesFromHtml(jcrewServed);
  assert.deepStrictEqual(read.candidates, [], 'an empty offers array is not a price');
  assert.strictEqual(read.empties.length, 1);
  assert.strictEqual(read.empties[0].type, 'ProductGroup');
  assert.match(read.empties[0].why, /offers: \[\]/);
  assert.ok(read.empties[0].skus.includes('au763-wt0002'), 'the record names the sku it does have');
});

test('five rendered figures, four claiming to be current, FAIL CLOSED', () => {
  const read = prices.renderedCandidates(jcrewRendered, JCREW);
  assert.deepStrictEqual(amounts(read.candidates), [98, 128, 118, 58.5, 148]);

  const verdict = prices.decide(read.candidates, JCREW);
  assert.strictEqual(verdict.price, undefined, 'no figure may be chosen when the page has not said which is charged');
  assert.deepStrictEqual(verdict.ambiguous, [58.5, 98, 118, 148]);
  assert.match(verdict.why, /4 different amounts/);
  assert.match(verdict.why, /nothing on the page says which one is/);
});

test('the struck-through 128 is refused as the list price, not counted as current', () => {
  const verdict = prices.decide(prices.renderedCandidates(jcrewRendered, JCREW).candidates, JCREW);
  assert.ok(!verdict.ambiguous.includes(128), '128 is what the others are discounted from');
  assert.match(because(verdict.refusals, 128), /struck through/);
});

test('the ambiguity is reported with every survivor and its evidence', () => {
  const verdict = prices.decide(prices.renderedCandidates(jcrewRendered, JCREW).candidates, JCREW);
  assert.strictEqual(verdict.survivors.length, 4);
  for (const survivor of verdict.survivors) {
    assert.match(survivor.identity, /names AU763/);
    assert.ok(survivor.charged, 'a survivor has to say what made it look charged');
  }
});

test('one figure charged and the rest accounted for IS resolvable', () => {
  const settled = seenOf(JCREW, [
    figure({ text: '$98', own: 'is-price--current', near: 'product-price', codes: ['AU763'], codeLabel: 'div.product-details#AU763' }),
    figure({ text: '$128', own: 'is-price--list', near: 'product-price', codes: ['AU763'], lineThrough: true }),
    figure({ text: '$118', own: 'is-price--current', near: 'product-price', codes: ['AU763'], hidden: true }),
    figure({ text: '$58.50', own: 'afterpay-instalment', near: 'financing', codes: ['AU763'] }),
    figure({ text: '$148', own: 'current-price', near: 'you-may-also-like', codes: ['BD640'] })
  ]);
  const verdict = prices.decide(prices.renderedCandidates(settled, JCREW).candidates, JCREW);
  assert.strictEqual(verdict.price, 98);
  assert.strictEqual(verdict.identity.via, 'dom-product-scope');
  assert.match(because(verdict.refusals, 118), /not rendered on screen/);
  assert.match(because(verdict.refusals, 58.5), /financing instalment/);
  assert.match(because(verdict.refusals, 148), /not this listing/);
});

test('a hydrated JSON-LD offer settles a page whose display agrees with it', () => {
  const hydrated = seenOf(JCREW, [
    figure({ text: '$98', own: 'is-price--current', near: 'product-price', codes: ['AU763'] }),
    figure({ text: '$128', own: 'is-price--list', near: 'product-price', codes: ['AU763'], lineThrough: true })
  ], [
    JSON.stringify({
      '@type': 'ProductGroup',
      productGroupID: 'AU763',
      sku: 'AU763-WT0002',
      offers: { '@type': 'Offer', price: '98.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' }
    })
  ]);
  const verdict = prices.decide(prices.renderedCandidates(hydrated, JCREW).candidates, JCREW);
  assert.strictEqual(verdict.price, 98);
  assert.strictEqual(verdict.identity.via, 'json-ld-offer');
  assert.match(verdict.identity.sku, /au763-wt0002/i);
  assert.strictEqual(verdict.agreed, 2, 'the record and the figure on the screen are the same amount');
});

test('a record that disagrees with the display still fails closed', () => {
  /* the case a rank order would get wrong: schema.org is the retailer's
     own statement, but a page showing something else as current is a
     disagreement about what a shopper pays, not a tie to be broken in
     the record's favour */
  const conflicted = seenOf(JCREW, jcrewRendered.prices, [
    JSON.stringify({
      '@type': 'ProductGroup', productGroupID: 'AU763', sku: 'AU763-WT0002',
      offers: { '@type': 'Offer', price: '98.00', priceCurrency: 'USD' }
    })
  ]);
  const verdict = prices.decide(prices.renderedCandidates(conflicted, JCREW).candidates, JCREW);
  assert.strictEqual(verdict.price, undefined);
  assert.deepStrictEqual(verdict.ambiguous, [58.5, 98, 118, 148]);
  assert.ok(verdict.survivors.some((s) => /json-ld offer/.test(s.from)), 'the record is one of the voices in the disagreement');
  assert.ok(verdict.survivors.some((s) => /rendered/.test(s.from)), 'and the screen is another');
});

test('an aggregate offer is a range, and a range is not a price', () => {
  const grouped = `<!doctype html><html><head><script type="application/ld+json">
  {"@type":"ProductGroup","sku":"AU763-WT0002","offers":{"@type":"AggregateOffer","lowPrice":"58.50","highPrice":"148.00","priceCurrency":"USD"}}
  </script></head><body></body></html>`;
  const read = prices.pricesFromHtml(grouped);
  assert.strictEqual(read.candidates.length, 1);
  assert.strictEqual(read.candidates[0].kind, 'range');
  const verdict = prices.decide(read.candidates, JCREW);
  assert.strictEqual(verdict.price, undefined);
  assert.deepStrictEqual(gates(verdict.refusals), ['charged']);
  assert.match(verdict.refusals[0].why, /range is not a price/);
});

test('an aggregate whose low and high are the same IS one price', () => {
  const single = `<!doctype html><html><head><script type="application/ld+json">
  {"@type":"ProductGroup","sku":"AU763-WT0002","offers":{"@type":"AggregateOffer","lowPrice":"98.00","highPrice":"98.00","priceCurrency":"USD"}}
  </script></head><body></body></html>`;
  const verdict = prices.decide(prices.pricesFromHtml(single).candidates, JCREW);
  assert.strictEqual(verdict.price, 98);
});

/* ---------------------------------------------------------
   L.L.Bean — the shape that DOES answer, so the reader is not
   just a machine for saying no
   --------------------------------------------------------- */

const llbeanServed = `<!doctype html><html><head>
<link rel="canonical" href="${LLBEAN}">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","sku":"129244",
 "name":"Men's VentureStretch Commuter Chinos","brand":{"@type":"Brand","name":"L.L.Bean"},
 "offers":{"@type":"Offer","price":"84.95","priceCurrency":"USD","availability":"https://schema.org/InStock",
           "url":"${LLBEAN}"}}
</script></head><body></body></html>`;

console.log('\nL.L.Bean — an offer on a product record that names the sku\n');

test('the offer is read, and tied to the product by its sku', () => {
  const read = prices.pricesFromHtml(llbeanServed);
  assert.deepStrictEqual(amounts(read.candidates), [84.95]);

  const verdict = prices.decide(read.candidates, LLBEAN);
  assert.strictEqual(verdict.price, 84.95);
  assert.strictEqual(verdict.currency, 'USD');
  assert.strictEqual(verdict.identity.via, 'json-ld-offer');
  assert.strictEqual(verdict.identity.sku, '129244');
});

test('the same offer on a record naming another product is refused', () => {
  const wrong = llbeanServed.replace('"sku":"129244"', '"sku":"512244"');
  const verdict = prices.decide(prices.pricesFromHtml(wrong).candidates, LLBEAN);
  assert.strictEqual(verdict.price, undefined);
  assert.match(because(verdict.refusals, 84.95), /not this listing/);
});

/* ---------------------------------------------------------
   The figures that are money and are not the price
   --------------------------------------------------------- */

console.log('\nThe other figures on a product page\n');

test('a price meta tag describes the page, so it cannot name the product', () => {
  const metaOnly = `<!doctype html><html><head>
    <link rel="canonical" href="${UNIQLO}">
    <meta property="product:price:amount" content="7.90">
    <meta property="product:price:currency" content="USD">
    </head><body></body></html>`;
  const read = prices.pricesFromHtml(metaOnly);
  assert.deepStrictEqual(amounts(read.candidates), [7.9], 'it is collected, so the report can show it refused');

  const verdict = prices.decide(read.candidates, UNIQLO);
  assert.strictEqual(verdict.price, undefined);
  assert.match(because(verdict.refusals, 7.9), /describes the page, not a product record/);
});

test('a free-shipping threshold is refused', () => {
  const seen = seenOf(UNIQLO, [figure({ text: '$50', own: 'free-shipping-threshold', near: 'promo-banner', codes: ['E429066-000'] })]);
  const verdict = prices.decide(prices.renderedCandidates(seen, UNIQLO).candidates, UNIQLO);
  assert.match(because(verdict.refusals, 50), /shipping, promotion or basket total/);
});

test('a financing instalment is refused', () => {
  const seen = seenOf(UNIQLO, [figure({ text: '4 payments of $12.48', own: 'klarna-widget', near: 'product-price', codes: ['E429066-000'] })]);
  const verdict = prices.decide(prices.renderedCandidates(seen, UNIQLO).candidates, UNIQLO);
  assert.match(because(verdict.refusals, 12.48), /financing instalment/);
});

test('a figure in the product block that claims nothing is refused', () => {
  const seen = seenOf(UNIQLO, [figure({ text: '$39.90', own: 'text-sm', near: 'product-detail', codes: ['E429066-000'] })]);
  const verdict = prices.decide(prices.renderedCandidates(seen, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, undefined);
  assert.match(because(verdict.refusals, 39.9), /nothing on the element or its block says this is the amount charged/);
});

test('a number with no currency on it is not money', () => {
  assert.strictEqual(prices.moneyInText('429066'), null);
  assert.strictEqual(prices.moneyInText('4.5 out of 5'), null);
  assert.strictEqual(prices.moneyInText('100% cotton'), null);
  assert.strictEqual(prices.moneyInText('Size 32'), null);
  assert.deepStrictEqual(prices.moneyInText('$7.90'), { amount: 7.9, currency: 'USD', text: '$7.90' });
  assert.strictEqual(prices.moneyInText('US $1,248.00').amount, 1248);
});

test('a listing URL with no code in it can never clear the identity gate', () => {
  const verdict = prices.decide(
    prices.renderedCandidates(seenOf('https://shop.example/x', [figure({ text: '$10', own: 'current-price' })]), 'https://shop.example/x').candidates,
    'https://shop.example/x'
  );
  assert.match(verdict.refusals[0].why, /no product code to match against/);
});

/* ---------------------------------------------------------
   What gets written, and what a written row has to keep proving
   --------------------------------------------------------- */

console.log('\nWriting it back\n');

const catalogSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'catalog.js'), 'utf8');

/* the same catalogue with L.L.Bean's price taken back out, so the write
   is exercised on a real row that has none — which is the state every
   row is in before a run reads one */
const unpriced = catalogSource.replace(
  /(\n\s*)price: 84\.95,\n\s*priceEvidence: \{[^}]*\},/,
  '$1price: null,'
);
assert.ok(/price: null,\n\s*productUrl: 'https:\/\/www\.llbean\.com/.test(unpriced), 'the fixture has to start unpriced');

test('a verified price lands on the right row, with its provenance', () => {
  const next = prices.writePrice(unpriced, 'llbean-venturestretch-chino', 84.95, { ok: true, via: 'json-ld-offer', sku: '129244' });
  const before = evaluate(unpriced);
  const after = evaluate(next);

  const row = after.find((r) => r.id === 'llbean-venturestretch-chino');
  assert.strictEqual(row.price, 84.95);
  assert.deepStrictEqual(plain(row.priceEvidence), { via: 'json-ld-offer', sku: '129244' });

  assert.strictEqual(after.length, before.length, 'no row appeared or vanished');
  for (let i = 0; i < before.length; i += 1) {
    const was = before[i];
    const is = after[i];
    assert.strictEqual(is.id, was.id);
    assert.strictEqual(is.imageUrl, was.imageUrl, `${was.id} kept its photo`);
    assert.strictEqual(is.productUrl, was.productUrl, `${was.id} kept its listing`);
    assert.strictEqual(is.name, was.name);
    if (is.id !== 'llbean-venturestretch-chino') {
      assert.strictEqual(is.price, was.price, `${was.id} kept its price`);
      assert.strictEqual(is.priceEvidence, undefined, `${was.id} got no note it did not earn`);
    }
  }
});

test('writing twice is the same file as writing once', () => {
  const evidence = { ok: true, via: 'json-ld-offer', sku: '129244' };
  const once = prices.writePrice(unpriced, 'llbean-venturestretch-chino', 84.95, evidence);
  const twice = prices.writePrice(once, 'llbean-venturestretch-chino', 84.95, evidence);
  assert.strictEqual(twice, once, 'a re-run must not stack notes or drift the file');
});

test('a re-read that disagrees replaces the price AND its note', () => {
  /* the shipped row already carries one, which is the case --refresh
     lands in: the old note must not outlive the price it explained */
  const next = prices.writePrice(catalogSource, 'llbean-venturestretch-chino', 79.99, { ok: true, via: 'microdata-offer', sku: '129244' });
  const row = evaluate(next).find((r) => r.id === 'llbean-venturestretch-chino');
  assert.strictEqual(row.price, 79.99);
  assert.deepStrictEqual(plain(row.priceEvidence), { via: 'microdata-offer', sku: '129244' });
  assert.strictEqual(next.split('\n').length, catalogSource.split('\n').length, 'a replacement adds no lines');
});

test('the file keeps its comments and its shape', () => {
  const next = prices.writePrice(unpriced, 'llbean-venturestretch-chino', 84.95, { ok: true, via: 'json-ld-offer', sku: '129244' });
  assert.ok(next.includes('Fynd — demo product source'), 'the header comment survived');
  assert.strictEqual(next.split('\n').length, unpriced.split('\n').length + 1, 'exactly one line was added: the note');
});

test('a price that is not an amount is refused before it reaches the file', () => {
  for (const bad of [0, -5, NaN, null, '84.95']) {
    assert.throws(() => prices.writePrice(unpriced, 'llbean-venturestretch-chino', bad, { ok: true, via: 'json-ld-offer', sku: '129244' }),
      /refusing to write/, `${bad} should never be written`);
  }
});

test('a row whose price has no provenance is reported UNACCOUNTED', () => {
  const orphan = { id: 'x', price: 84.95, productUrl: LLBEAN };
  const checked = prices.catalogRowPrice(orphan);
  assert.strictEqual(checked.ok, false);
  assert.match(checked.why, /no record of how it was tied/);
});

test('a made-up note fails exactly as a made-up price would', () => {
  const lying = { id: 'x', price: 84.95, productUrl: LLBEAN, priceEvidence: { via: 'json-ld-offer', sku: '987654' } };
  assert.strictEqual(prices.catalogRowPrice(lying).ok, false);
  assert.match(prices.catalogRowPrice(lying).why, /not a code in this row's own listing URL/);

  const invented = { id: 'x', price: 84.95, productUrl: LLBEAN, priceEvidence: { via: 'a-person-said-so', sku: '129244' } };
  assert.strictEqual(prices.catalogRowPrice(invented).ok, false);
  assert.match(prices.catalogRowPrice(invented).why, /no recognised kind/);
});

test('a re-provable note passes, and a sample row needs none', () => {
  const real = { id: 'x', price: 84.95, productUrl: LLBEAN, priceEvidence: { via: 'json-ld-offer', sku: '129244' } };
  assert.strictEqual(prices.catalogRowPrice(real).ok, true);

  const sample = { id: 'sample', price: 42, productUrl: null };
  assert.strictEqual(prices.catalogRowPrice(sample).ok, true);

  const unpriced = { id: 'uniqlo-merino-crew', price: null, productUrl: UNIQLO };
  assert.strictEqual(prices.catalogRowPrice(unpriced).ok, true);
});

test('every row the catalogue ships today accounts for its price', () => {
  const rows = evaluate(catalogSource);
  for (const row of rows) {
    const checked = prices.catalogRowPrice(row);
    assert.strictEqual(checked.ok, true, `${row.id}: ${checked.why}`);
  }
});

/* ---------------------------------------------------------
   The browser path, for real

   A retailer that serves no price and hydrates one in JavaScript is
   exactly the UNIQLO shape, and it is the shape a reader gets wrong by
   trusting the page instead of the element. Chromium is sent at a local
   server playing that retailer, and what comes back is judged by the
   same gates as the captures above.
   --------------------------------------------------------- */

function hydratingRetailer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const port = server.address().port;
    const here = `http://127.0.0.1:${port}${url}`;

    /* the figure the page renders, and the block it renders it in */
    const block = url.startsWith('/scoped')
      ? `<div class="product-main" data-product-id="E429066-000">
           <span class="current-price">$49.90</span>
         </div>`
      : url.startsWith('/p/AU763')
        ? `<div class="product-details" data-product-id="AU763">
             <span class="is-price--list" style="text-decoration: line-through">$128</span>
             <span class="is-price--current">$98</span>
             <span class="is-price--current">$118</span>
             <span class="is-price--sale">$58.50</span>
             <span class="current-price">$148</span>
           </div>
           <div class="you-may-also-like" data-product-id="BD640">
             <span class="current-price">$79.50</span>
           </div>`
        : `<div class="fr-ec-price"><span class="fr-ec-price-text">$7.90</span></div>`;

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head>
      <link rel="canonical" href="${here}">
      <title>Hydrating</title></head>
      <body><div id="app">
        <p class="reviews">4.5 out of 5</p>
        <p class="promo">Free shipping over $50</p>
      </div>
      <script>
        /* nothing above is a price, and the price only exists after this
           runs — which is why plain HTTP comes back with nothing */
        setTimeout(function () {
          document.getElementById('app').insertAdjacentHTML('beforeend', ${JSON.stringify(block)});
        }, 60);
      </script></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  console.log('\nThrough a real browser\n');

  let chromium = null;
  try { chromium = require('playwright').chromium; } catch (err) { chromium = null; }

  if (!chromium) {
    skipped += 3;
    console.log('  skip  the browser section — Playwright is not installed here');
    console.log('        npm install, then re-run, to exercise the hydration path');
  } else {
    const server = await hydratingRetailer();
    const port = server.address().port;
    const listing = (p) => `http://127.0.0.1:${port}${p}`;

    await testAsync('a hydrated figure with no product-specific block is refused', async () => {
      const url = listing('/products/E429066-000/00');
      const served = await new Promise((resolve) => {
        http.get(url, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve(body));
        });
      });
      assert.deepStrictEqual(prices.pricesFromHtml(served).candidates, [], 'plain HTTP sees no price, as with UNIQLO');

      const rendered = await prices.renderPage(url);
      assert.ok(!rendered.failed, rendered.failed);

      const read = prices.renderedCandidates(rendered.seen, url);
      assert.deepStrictEqual(amounts(read.candidates).sort((a, b) => a - b), [7.9, 50],
        'the browser sees the hydrated figure and the shipping threshold, and nothing else counts as money');

      const verdict = prices.decide(read.candidates, url);
      assert.strictEqual(verdict.price, undefined, 'the page being canonical for this listing is not provenance for its figures');
      assert.match(because(verdict.refusals, 7.9), /vouches for the page/);
      /* the banner's figure never reaches the charged gate: it is in no
         product's block, so the first question already answers it */
      assert.deepStrictEqual(gates(verdict.refusals), ['this', 'this']);
      assert.match(because(verdict.refusals, 50), /nothing in its own DOM ties it/);
    });

    await testAsync('the same page IS read once the figure sits in the product block', async () => {
      const url = listing('/scoped/products/E429066-000/00');
      const rendered = await prices.renderPage(url);
      assert.ok(!rendered.failed, rendered.failed);

      const verdict = prices.decide(prices.renderedCandidates(rendered.seen, url).candidates, url);
      assert.strictEqual(verdict.price, 49.9);
      assert.strictEqual(verdict.identity.via, 'dom-product-scope');
      assert.match(verdict.identity.code, /E429066-000/i);
    });

    await testAsync('a group page rendering four current figures fails closed', async () => {
      const url = listing('/p/AU763');
      const rendered = await prices.renderPage(url);
      assert.ok(!rendered.failed, rendered.failed);

      const struck = rendered.seen.prices.find((p) => p.text.includes('128'));
      assert.strictEqual(struck.lineThrough, true, 'line-through is read off the computed style, not guessed from a class name');

      const verdict = prices.decide(prices.renderedCandidates(rendered.seen, url).candidates, url);
      assert.strictEqual(verdict.price, undefined);
      assert.deepStrictEqual(verdict.ambiguous, [58.5, 98, 118, 148]);
      assert.ok(!verdict.ambiguous.includes(79.5), "the neighbouring product's price never entered the tie");
    });

    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  process.exit(failures.length ? 1 : 0);
})();

/* A catalogue row comes back from a vm context, so its objects carry
   that realm's prototype and deepStrictEqual refuses them however
   identical the contents. Copied into this realm they compare on what
   they actually hold. */
function plain(value) {
  return value == null ? value : Object.assign({}, value);
}

function evaluate(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(source + ';this.__rows = DEMO_PRODUCTS;').runInContext(sandbox, { timeout: 5000 });
  return sandbox.__rows;
}
