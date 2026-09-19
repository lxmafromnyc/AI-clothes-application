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
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const prices = require('./fetch-catalog-prices');

const SCRIPT = path.join(__dirname, 'fetch-catalog-prices.js');

/* the command as a person runs it, so what is asserted is the command
   rather than the function behind it */
async function run(args) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [SCRIPT, ...args], { env: process.env, timeout: 120000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code === undefined ? 1 : err.code, stdout: err.stdout || '', stderr: err.stderr || String(err.message) };
  }
}

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

/* the shipped catalogue, read once: several tests write into a copy of
   it and check what the rows become */
const catalogSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'catalog.js'), 'utf8');

const amounts = (list) => list.map((c) => c.amount);
const gates = (refusals) => refusals.map((r) => r.gate);
const because = (refusals, amount) => (refusals.find((r) => r.amount === amount) || {}).why || '';
const becauseGate = (refusals, amount, gate) =>
  (refusals.find((r) => r.amount === amount && r.gate === gate) || {}).why || '';

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

/* The real inspection of the live page, filtered to what it established:
   the $7.90 figure carries no product code in its ancestry at all, and
   the page's other figures are each tied to a DIFFERENT product. */
const uniqloInspected = seenOf(UNIQLO, [
  figure({ text: '$7.90', selector: 'span.fr-ec-price-text', own: 'fr-ec-price-text', near: 'fr-ec-price', codes: [] }),
  figure({ text: '$19.90', own: 'fr-ec-price-text', near: 'fr-ec-product-tile', codes: ['E465185-000'], codeLabel: 'div#product-E465185-000' }),
  figure({ text: '$39.90', own: 'fr-ec-price-text', near: 'fr-ec-product-tile', codes: ['E471809-000'], codeLabel: 'div#product-E471809-000' })
]);

test('the live page: $7.90 has no code of its own, and the rest belong to other products', () => {
  const verdict = prices.decide(prices.renderedCandidates(uniqloInspected, UNIQLO).candidates, UNIQLO);

  assert.strictEqual(verdict.price, undefined, 'nothing on this page may be written');
  assert.strictEqual(verdict.ambiguous, undefined, 'and it is not an ambiguity either — none of them qualified');
  assert.deepStrictEqual(gates(verdict.refusals), ['this', 'this', 'this']);

  assert.match(because(verdict.refusals, 7.9), /nothing in its own DOM ties it to this product/);
  assert.match(because(verdict.refusals, 19.9), /names E465185-000, not this listing/);
  assert.match(because(verdict.refusals, 39.9), /names E471809-000, not this listing/);
});

test('E465185-000 is refused for being another product, not for being unmarked', () => {
  /* it clears every other gate: it is money, it is on the retailer's own
     page, it is marked as a price. Only WHOSE price stops it. */
  const other = prices.renderedCandidates(uniqloInspected, UNIQLO).candidates
    .find((c) => c.amount === 19.9);
  assert.strictEqual(prices.priceIdentity(other, UNIQLO).ok, false);
  assert.strictEqual(prices.chargedEvidence(other).ok, false,
    'and its block says nothing about being charged either — two reasons, not one');
});

test('a cookie-consent id is not a selected variant', () => {
  /* the live inspection reported ot-group-id-C0004 and C0004 as the
     page's "selected" state. Those are OneTrust cookie categories. A
     figure must not become variant-scoped by sitting near one. */
  const withConsent = seenOf(UNIQLO, [
    figure({ text: '$7.90', own: 'fr-ec-price-text', near: 'fr-ec-price', codes: [] }),
    figure({ text: '$59.90', own: 'price-current', near: 'fr-ec-price', codes: ['E429066-000', 'C0004'] })
  ]);
  withConsent.selected = { codes: ['ot-group-id-C0004', 'C0004'], from: ['input:checked'], ignored: [] };

  const verdict = prices.decide(prices.renderedCandidates(withConsent, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, 59.9, 'the figure naming the product still wins on the product code');
  assert.strictEqual(verdict.identity.via, 'dom-product-scope',
    'but NOT on a consent id: C0004 says which cookies were accepted, not which jumper is on screen');
  assert.match(because(verdict.refusals, 7.9), /nothing in its own DOM ties it to this product/);
});

test('E429066-000 is what a UNIQLO price would have to name', () => {
  const tied = seenOf(UNIQLO, [
    figure({ text: '$49.90', own: 'price-current', near: 'fr-ec-price', codes: ['E429066-000'], codeLabel: 'div#product-E429066-000' })
  ]);
  const verdict = prices.decide(prices.renderedCandidates(tied, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, 49.9, 'the gate is not impossible — it is unmet on the live page');
  assert.strictEqual(verdict.identity.via, 'dom-product-scope');
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

test('a figure tied to the SELECTED variant outranks the group-level ones', () => {
  /* the same five figures, on a page that says which colour is being
     looked at. One of them is tied to that colour; the rest are tied
     only to the group every colour belongs to. */
  const selected = { codes: ['AU763_WT0002'], from: ['[aria-checked="true"]'] };
  const picked = Object.assign({}, jcrewRendered, {
    selected,
    prices: jcrewRendered.prices.map((p) => (p.text === '$98'
      ? Object.assign({}, p, { codes: ['AU763_WT0002', 'AU763'], codeLabel: 'div.variant#AU763_WT0002' })
      : p))
  });

  const verdict = prices.decide(prices.renderedCandidates(picked, JCREW).candidates, JCREW);
  assert.strictEqual(verdict.price, 98);
  assert.strictEqual(verdict.identity.via, 'dom-variant-scope');
  assert.match(verdict.identity.how, /the variant the page has selected/);
  for (const amount of [118, 58.5, 148]) {
    assert.match(because(verdict.refusals, amount), /tied only to the product group/);
  }
});

test('two figures tied to the SAME selected variant still fail closed', () => {
  const selected = { codes: ['AU763_WT0002'], from: ['url:colorProductCode'] };
  const both = seenOf(JCREW, [
    figure({ text: '$98', own: 'is-price--current', codes: ['AU763_WT0002'] }),
    figure({ text: '$58.50', own: 'is-price--sale', codes: ['AU763_WT0002'] })
  ]);
  both.selected = selected;
  const verdict = prices.decide(prices.renderedCandidates(both, JCREW).candidates, JCREW);
  assert.strictEqual(verdict.price, undefined);
  assert.deepStrictEqual(verdict.ambiguous, [58.5, 98], 'specificity breaks a tie between scopes, never between amounts');
});

test('the group code is not the selected variant', () => {
  assert.strictEqual(prices.selectedAmong(['AU763'], ['AU763_WT0002']), null,
    'every colour on the page names the group, so the group cannot identify one of them');
  assert.strictEqual(prices.selectedAmong(['AU763_WT0002'], ['AU763-WT0002']), 'AU763_WT0002',
    'the separator a retailer writes it with is not part of the code');
  assert.strictEqual(prices.selectedAmong(['AU763_BL0001'], ['AU763_WT0002']), null);
});

test('the live page: the selected colour block resolves J.Crew to $98', () => {
  /* the shape the real inspection reported: the figure sits in
     div#productPriceSelectColors-CX449NA6434, that id names the colour
     the page has selected, the block around it is marked sale, and the
     listing's own AU763 is above it. */
  const live = seenOf(JCREW, [
    figure({
      text: '$98',
      selector: 'span.price-value',
      own: 'price-value',
      near: 'product-price-sale is-price',
      codes: ['productPriceSelectColors-CX449NA6434', 'AU763'],
      codeLabel: 'div#productPriceSelectColors-CX449NA6434'
    }),
    figure({ text: '$128', own: 'price-list', near: 'product-price', codes: ['AU763'], lineThrough: true }),
    figure({ text: '$79.50', own: 'price-value', near: 'you-may-also-like is-price--sale', codes: ['BD640'] }),
    figure({ text: '$148', own: 'price-value', near: 'recently-viewed is-price--sale', codes: ['CV102'] })
  ]);
  live.selected = { codes: ['CX449NA6434'], from: ['[aria-checked="true"] [data-code]'] };

  const verdict = prices.decide(prices.renderedCandidates(live, JCREW).candidates, JCREW);
  assert.strictEqual(verdict.price, 98);
  assert.strictEqual(verdict.identity.via, 'dom-variant-scope');
  assert.strictEqual(verdict.identity.variant, 'productPriceSelectColors-CX449NA6434');
  assert.strictEqual(verdict.identity.code, 'AU763', 'the listing code is kept, because that is what a row re-proves against');
  assert.match(verdict.charged.how, /marked sale/);

  /* and the recommendations were never in the running */
  assert.match(because(verdict.refusals, 79.5), /not this listing/);
  assert.match(because(verdict.refusals, 148), /not this listing/);
  assert.match(because(verdict.refusals, 128), /struck through/);
});

test('the live J.Crew element resolves whether the sale class is on it or above it', () => {
  /* the live inspection: div#productPriceSelectColors-CX449NA6434, DOM
     codes CX449 and AU763, marked tile__detail--price--sale, with the
     page's selected variant CX449NA6434. Whether that class sits on the
     figure or on the block around it is a detail of J.Crew's markup, so
     both readings have to reach the same answer. */
  const codes = ['productPriceSelectColors-CX449NA6434', 'CX449', 'AU763'];
  const label = 'div#productPriceSelectColors-CX449NA6434';

  for (const marking of [
    { own: 'tile__detail--price--sale', near: 'productPriceSelectColors', via: 'dom-role' },
    { own: 'tile__detail--price--value', near: 'tile__detail--price--sale', via: 'dom-role-block' }
  ]) {
    const live = seenOf(JCREW, [
      figure({ text: '$98', selector: 'span.tile__detail--price', own: marking.own, near: marking.near, codes, codeLabel: label })
    ]);
    live.selected = { codes: ['CX449NA6434'], from: ['[aria-checked="true"] [data-code]'], ignored: [] };

    const verdict = prices.decide(prices.renderedCandidates(live, JCREW).candidates, JCREW);
    assert.strictEqual(verdict.price, 98, `${marking.via}: the selected colour's figure is the answer`);
    assert.strictEqual(verdict.identity.via, 'dom-variant-scope');
    assert.strictEqual(verdict.identity.code, 'AU763');
    assert.strictEqual(verdict.identity.variant, 'productPriceSelectColors-CX449NA6434');
    assert.strictEqual(verdict.charged.via, marking.via);
    assert.match(verdict.charged.how, /sale/);
  }
});

test('the shipped J.Crew row carries that exact evidence, and re-proves it', () => {
  const row = evaluate(catalogSource).find((r) => r.id === 'jcrew-broken-in-oxford');
  assert.strictEqual(row.price, 98);
  assert.deepStrictEqual(plain(row.priceEvidence), {
    via: 'dom-variant-scope',
    code: 'AU763',
    variant: 'productPriceSelectColors-CX449NA6434'
  });
  assert.strictEqual(prices.catalogRowPrice(row).ok, true);
});

test('that evidence is writable, and a written row re-proves it', () => {
  const evidence = { ok: true, via: 'dom-variant-scope', code: 'AU763', variant: 'productPriceSelectColors-CX449NA6434' };
  const note = prices.priceEvidenceNote(evidence);
  assert.strictEqual(note, "{ via: 'dom-variant-scope', code: 'AU763', variant: 'productPriceSelectColors-CX449NA6434' }");

  const next = prices.writePrice(catalogSource, 'jcrew-broken-in-oxford', 98, evidence);
  const row = evaluate(next).find((r) => r.id === 'jcrew-broken-in-oxford');
  assert.strictEqual(row.price, 98);
  assert.strictEqual(prices.catalogRowPrice(row).ok, true, 'a variant note has to survive the re-proof a shipped row gets');

  /* the variant alone could not: CX449NA6434 is nowhere in the listing URL */
  const variantOnly = Object.assign({}, row, { priceEvidence: { via: 'dom-variant-scope', code: 'CX449NA6434' } });
  assert.strictEqual(prices.catalogRowPrice(variantOnly).ok, false);
});

test('a price whose evidence cannot be recorded is not writable at all', () => {
  assert.throws(
    () => prices.writePrice(catalogSource, 'jcrew-broken-in-oxford', 98, { ok: true, via: 'canonical' }),
    /no provenance to record/,
    'a verified run must never ship a figure the catalogue cannot re-prove'
  );
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

test('a figure sitting in a recommendation block is named as one', () => {
  assert.strictEqual(
    prices.elsewhereIn({ own: 'current-price', near: 'you-may-also-like', chain: [{ cls: 'you-may-also-like carousel' }] }),
    'you-may-also-like'
  );
  assert.strictEqual(prices.elsewhereIn({ own: 'is-price--current', near: 'product-price', chain: [] }), null,
    "the product's own price block is not somewhere else");
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
   What a page carries besides its DOM

   UNIQLO renders no figure that can be tied to E429066, so the question
   is whether it publishes the price anywhere else — and the answer is
   only usable if the amount and the code are in the SAME record.
   --------------------------------------------------------- */

console.log('\nThe payloads a page ships\n');

const UNIQLO_IDS = ['e429066', '429066'];

test('a record holding the code AND the amount is found, with its path', () => {
  const payload = { result: { items: [{
    productId: 'E429066-000',
    l1Id: '429066',
    name: 'Extra Fine Merino Crew Neck Long-Sleeve Sweater',
    prices: { base: { value: 49.9, currency: 'USD' } }
  }] } };

  const hits = prices.productRecords(payload, UNIQLO_IDS, 'script#__NEXT_DATA__');
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].amount, 49.9);
  assert.strictEqual(hits[0].currency, 'USD');
  assert.strictEqual(hits[0].code, 'E429066-000');
  assert.strictEqual(hits[0].codeKey, 'productId');
  assert.strictEqual(hits[0].field, 'prices.base.value');
  assert.strictEqual(hits[0].recordPath, 'result.items.[0]');
});

test('the code in one record and a price in another is NOT evidence', () => {
  /* the whole point. A catalogue response holds fifty products; "both
     strings are somewhere in this file" is how the wrong one gets
     written. */
  const payload = { items: [
    { productId: 'E429066-000', name: 'the sweater' },
    { productId: 'E465185-000', name: 'something else', prices: { base: { value: 19.9, currency: 'USD' } } }
  ] };
  assert.deepStrictEqual(prices.productRecords(payload, UNIQLO_IDS, 'network /api/products'), []);
});

test('a price under a recommendation key is set aside, never offered', () => {
  const payload = {
    product: { productId: 'E429066-000', prices: { base: { value: 49.9, currency: 'USD' } } },
    recommendations: { items: [{ productId: 'E429066-000', prices: { base: { value: 9.9, currency: 'USD' } } }] }
  };
  const hits = prices.productRecords(payload, UNIQLO_IDS, 'window.__STATE__');
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits.find((h) => h.amount === 9.9).elsewhere, 'recommendations');
  assert.strictEqual(hits.find((h) => h.amount === 49.9).elsewhere, null);

  const offered = prices.dataCandidates({ state: [{ key: '__STATE__', text: JSON.stringify(payload), mentions: UNIQLO_IDS }] }, UNIQLO);
  assert.deepStrictEqual(amounts(offered), [49.9], 'the recommendation price is not a candidate at all');
});

test('a list field is read as a list field, and the base price wins', () => {
  const payload = { product: { productId: 'E429066-000', prices: {
    base: { value: 49.9, currency: 'USD' },
    listPrice: { value: 59.9, currency: 'USD' }
  } } };
  const candidates = prices.dataCandidates({ scripts: [{ id: 'x', type: 'application/json', text: JSON.stringify(payload), mentions: UNIQLO_IDS }] }, UNIQLO);
  assert.deepStrictEqual(amounts(candidates).sort((a, b) => a - b), [49.9, 59.9]);

  const verdict = prices.decide(candidates, UNIQLO);
  assert.strictEqual(verdict.price, 49.9);
  assert.strictEqual(verdict.identity.via, 'data-product-record');
  assert.match(because(verdict.refusals, 59.9), /list or comparison field/);
});

test('an amount with no currency beside it is refused', () => {
  const payload = { product: { productId: 'E429066-000', prices: { base: { value: 49.9 } } } };
  const candidates = prices.dataCandidates({ scripts: [{ text: JSON.stringify(payload), mentions: UNIQLO_IDS }] }, UNIQLO);
  const verdict = prices.decide(candidates, UNIQLO);
  assert.strictEqual(verdict.price, undefined);
  assert.match(because(verdict.refusals, 49.9), /names no currency/);
});

test('another product\'s record is refused by the same gate as a DOM figure', () => {
  const payload = { product: { productId: 'E465185-000', prices: { base: { value: 19.9, currency: 'USD' } } } };
  const candidates = prices.dataCandidates({ scripts: [{ text: JSON.stringify(payload) }] }, UNIQLO);
  assert.deepStrictEqual(candidates, [], 'it never even becomes a candidate for this listing');
});

test('a price kept under the colour code is tied through the mapping', () => {
  /* product record names the listing and its colour codes; a second
     payload prices one of those colours */
  const data = {
    scripts: [{ id: '__NEXT_DATA__', type: 'application/json', mentions: UNIQLO_IDS, text: JSON.stringify({
      product: { productId: 'E429066-000', communicationCodes: ['COL09X'] }
    }) }],
    responses: [{ url: 'https://www.uniqlo.com/us/en/api/commerce/v3/en/prices', mentions: [], length: 90, text: JSON.stringify({
      prices: [{ communicationCode: 'COL09X', base: { value: 49.9, currency: 'USD' } }]
    }) }]
  };

  const candidates = prices.dataCandidates(data, UNIQLO);
  assert.deepStrictEqual(amounts(candidates), [49.9]);

  const verdict = prices.decide(candidates, UNIQLO);
  assert.strictEqual(verdict.price, 49.9);
  assert.strictEqual(verdict.identity.via, 'data-variant-mapping');
  assert.strictEqual(verdict.identity.code, 'E429066-000');
  assert.strictEqual(verdict.identity.variant, 'COL09X');
  assert.match(verdict.identity.how, /names E429066-000 with communicationCodes COL09X/);

  const note = prices.priceEvidenceNote(verdict.identity);
  assert.strictEqual(note, "{ via: 'data-variant-mapping', code: 'E429066-000', variant: 'COL09X' }");
});

test('a colour code nobody tied to this listing prices nothing', () => {
  const data = {
    responses: [{ url: '/api/prices', text: JSON.stringify({ prices: [{ communicationCode: 'COL09X', base: { value: 49.9, currency: 'USD' } }] }) }]
  };
  assert.deepStrictEqual(prices.dataCandidates(data, UNIQLO), [],
    'without a record naming E429066-000, COL09X is a code from nowhere');
});

test('the data route does not rescue the $7.90 figure', () => {
  /* the live page, with a payload added: the figure is still refused on
     its own DOM, and what resolves is the record, not the rendering */
  const seen = seenOf(UNIQLO, [figure({ text: '$7.90', own: 'fr-ec-price-text', near: 'fr-ec-price', codes: [] })]);
  seen.data = { scripts: [{ id: '__NEXT_DATA__', type: 'application/json', mentions: UNIQLO_IDS, text: JSON.stringify({
    product: { productId: 'E429066-000', prices: { base: { value: 49.9, currency: 'USD' } } }
  }) }] };

  const read = prices.renderedCandidates(seen, UNIQLO);
  assert.deepStrictEqual(amounts(read.candidates), [49.9, 7.9]);

  const verdict = prices.decide(read.candidates, UNIQLO);
  assert.strictEqual(verdict.price, 49.9);
  assert.match(because(verdict.refusals, 7.9), /nothing in its own DOM ties it to this product/);
});

test('two records that disagree still fail closed', () => {
  const data = { scripts: [
    { text: JSON.stringify({ product: { productId: 'E429066-000', prices: { base: { value: 49.9, currency: 'USD' } } } }) },
    { text: JSON.stringify({ product: { productId: 'E429066-000', prices: { base: { value: 39.9, currency: 'USD' } } } }) }
  ] };
  const verdict = prices.decide(prices.dataCandidates(data, UNIQLO), UNIQLO);
  assert.strictEqual(verdict.price, undefined);
  assert.deepStrictEqual(verdict.ambiguous, [39.9, 49.9]);
});

test('keys are matched by their words, not by substring', () => {
  assert.strictEqual(prices.isIdKey('productId'), true);
  assert.strictEqual(prices.isIdKey('l1_id'), true);
  assert.strictEqual(prices.isIdKey('communicationCode'), true);
  assert.strictEqual(prices.isIdKey('candidate'), false, '"candidate" contains no id word');
  assert.strictEqual(prices.isPriceKey('basePrice'), true);
  assert.strictEqual(prices.isPriceKey('priceValue'), true);
  assert.strictEqual(prices.isPriceKey('brandValue'), false, '"brandValue" is not an amount');
});

test('a payload is parsed however the page shipped it', () => {
  assert.deepStrictEqual(prices.parseLoosely('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(prices.parseLoosely('window.__STATE__ = {"a":1};'), { a: 1 });
  assert.deepStrictEqual(prices.parseLoosely('var x = 3'), null, 'nothing parseable is left alone rather than guessed at');
});

/* ---------------------------------------------------------
   The live UNIQLO case: markup that says $7.90 on a page that
   charges something else
   --------------------------------------------------------- */

console.log('\nWhat a payload is worth, and what it is not\n');

/* the shape the live inspection found: a ProductGroup in the page's
   @graph naming E429066-000, with the amount on a variant's offer */
const UNIQLO_GRAPH = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'BreadcrumbList', itemListElement: [] },
    { '@type': 'WebPage', url: UNIQLO },
    {
      '@type': 'ProductGroup',
      productGroupID: 'E429066-000',
      name: 'Extra Fine Merino Crew Neck Long-Sleeve Sweater',
      hasVariant: [{
        '@type': 'Product',
        sku: 'E429066-000-COL09-004',
        offers: { '@type': 'Offer', price: 7.9, priceCurrency: 'USD', priceValidUntil: '2024-03-31', availability: 'https://schema.org/InStock' }
      }]
    }
  ]
};

/* and the endpoint the live page actually asks for its price, in the
   shape UNIQLO answers with: the variants in one array, the amounts in
   a map keyed by the variant id */
const L2S_URL = 'https://www.uniqlo.com/us/api/commerce/v5/en/products/E429066-000/price-groups/00/l2s?withPrices=true';
const L2S = { status: 'ok', result: {
  l2s: [{ l2Id: '438783-COL09-004', productId: 'E429066-000', communicationCode: 'COL09', color: { code: '09', displayCode: '09 GRAY' }, size: { code: '004' } }],
  prices: { '438783-COL09-004': { base: { value: 49.9, currency: 'USD' }, promo: null } }
} };

const markupOnly = () => ({
  scripts: [{ id: null, type: 'application/ld+json', mentions: ['e429066'], text: JSON.stringify(UNIQLO_GRAPH) }]
});

test('schema.org markup alone does NOT write a price', () => {
  /* the live failure this rule exists for: the record really does carry
     E429066-000 and 7.9 together, and it is still not what the page
     charges */
  const seen = seenOf(UNIQLO, [figure({ text: '$7.90', own: 'fr-ec-price-text', near: 'fr-ec-price', codes: [] })]);
  seen.data = markupOnly();

  const verdict = prices.decide(prices.renderedCandidates(seen, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, undefined, '$7.90 must not be written');
  assert.ok(verdict.refusals.some((r) => r.gate === 'corroboration'), 'and the reason is its lack of corroboration');
  assert.match(becauseGate(verdict.refusals, 7.9, 'corroboration'), /only the page's schema.org markup says so/);
  assert.match(becauseGate(verdict.refusals, 7.9, 'corroboration'), /nothing the page prices from/);
  assert.match(becauseGate(verdict.refusals, 7.9, 'this'), /nothing in its own DOM ties it/,
    'the rendered figure is refused on its own terms, as it was before');
});

test('containing the product id is what lets a record be considered, not what makes it true', () => {
  const hits = prices.productRecords(UNIQLO_GRAPH, ['e429066', '429066'], 'script [application/ld+json]');
  assert.ok(hits.length, 'the record is found — the analyzer is not what refuses it');
  assert.ok(hits.every((hit) => hit.authority === 'markup'));
  assert.strictEqual(hits[0].code, 'E429066-000');
});

test('the commerce API answers, and the markup then only agrees or steps aside', () => {
  const seen = seenOf(UNIQLO, [figure({ text: '$7.90', own: 'fr-ec-price-text', codes: [] })]);
  seen.data = Object.assign(markupOnly(), {
    responses: [{ url: L2S_URL, text: JSON.stringify(L2S), mentions: ['e429066'] }]
  });

  const verdict = prices.decide(prices.renderedCandidates(seen, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, 49.9, "the endpoint the page prices from is what answers");
  assert.strictEqual(verdict.identity.via, 'data-variant-mapping');
  assert.strictEqual(verdict.identity.code, 'E429066-000');
  assert.strictEqual(verdict.identity.variant, '438783-COL09-004');
  assert.match(becauseGate(verdict.refusals, 7.9, 'corroboration'), /only the page's schema.org markup says so/);
});

test('a date is not a price', () => {
  /* priceValidUntil "2024-03-31" parses as 2024 to anything that reads
     a price-shaped key without looking at the value */
  const offer = { product: { productId: 'E429066-000', offers: { price: 7.9, priceCurrency: 'USD', priceValidUntil: '2024-03-31' } } };
  const hits = prices.productRecords(offer, ['e429066'], 'script [application/ld+json]');
  assert.deepStrictEqual(hits.map((h) => h.amount), [7.9], 'the expiry date is not among the amounts');
  assert.strictEqual(prices.isPriceKey('priceValidUntil'), false);
  assert.strictEqual(prices.isPriceKey('basePrice'), true);
  assert.strictEqual(prices.isPriceKey('discountRate'), false, 'a rate is not an amount');
});

test('a price map keyed by the variant id is read through its key', () => {
  /* result.prices["438783-COL09-004"].base.value — the key IS the
     identity, and reading only fields would miss every amount UNIQLO's
     endpoint publishes */
  const hits = prices.productRecords(L2S, ['438783-COL09-004'], 'network ' + L2S_URL);
  const mapped = hits.find((hit) => hit.codeKey === '(map key)');
  assert.ok(mapped, 'the map key identifies the record');
  assert.strictEqual(mapped.amount, 49.9);
  assert.strictEqual(mapped.currency, 'USD');
  assert.strictEqual(mapped.field, 'base.value');
});

test('markup that agrees with the endpoint is kept, not refused', () => {
  const agreeing = JSON.parse(JSON.stringify(UNIQLO_GRAPH));
  agreeing['@graph'][2].hasVariant[0].offers.price = 49.9;

  const seen = seenOf(UNIQLO, []);
  seen.data = {
    scripts: [{ type: 'application/ld+json', mentions: ['e429066'], text: JSON.stringify(agreeing) }],
    responses: [{ url: L2S_URL, text: JSON.stringify(L2S), mentions: ['e429066'] }]
  };

  const verdict = prices.decide(prices.renderedCandidates(seen, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, 49.9);
  assert.ok(!verdict.refusals.some((r) => r.gate === 'corroboration'), 'agreement is not a refusal');
});

test('two authoritative sources that disagree fail closed', () => {
  const seen = seenOf(UNIQLO, []);
  seen.data = {
    responses: [{ url: L2S_URL, text: JSON.stringify(L2S), mentions: ['e429066'] }],
    state: [{ key: '__NEXT_DATA__', mentions: ['e429066'], text: JSON.stringify({
      product: { productId: 'E429066-000', prices: { base: { value: 39.9, currency: 'USD' } } }
    }) }]
  };
  const verdict = prices.decide(prices.renderedCandidates(seen, UNIQLO).candidates, UNIQLO);
  assert.strictEqual(verdict.price, undefined);
  assert.deepStrictEqual(verdict.ambiguous, [39.9, 49.9]);
});

test('sources are ranked by what they are, not by what they say', () => {
  assert.strictEqual(prices.sourceAuthority('script [application/ld+json]'), 'markup');
  assert.strictEqual(prices.sourceAuthority('script#__NEXT_DATA__ [application/json]'), 'app-state');
  assert.strictEqual(prices.sourceAuthority('window.__UNIQLO_STATE__'), 'app-state');
  assert.strictEqual(prices.sourceAuthority('network ' + L2S_URL), 'commerce-api');
});

test('the markup audit says why an offer should not be believed', () => {
  const hits = prices.productRecords(UNIQLO_GRAPH, ['e429066'], 'script [application/ld+json]');
  const audit = prices.markupAudit(hits, new Set(), Date.parse('2026-09-19'));
  assert.strictEqual(audit.length, hits.length);

  const notes = audit[0].notes.join(' | ');
  assert.match(notes, /priceValidUntil 2024-03-31 is in the past/);
  assert.match(notes, /variant inside the group/);
  assert.match(notes, /NOT corroborated/);

  const confirmed = prices.markupAudit(hits, new Set([7.9]), Date.parse('2026-09-19'));
  assert.match(confirmed[0].notes.join(' | '), /corroborated: something the page prices from/);
});

test('the other identity the page gives the product is reported', () => {
  const payloads = [{ source: 'window.__STATE__', value: {
    product: { productId: 'E429066-000', l1Id: '429066', representativeProductId: '438783' }
  } }];
  const related = prices.relatedIdentifiers(payloads, ['e429066', '429066']);
  assert.ok(related.some((entry) => entry.code === '438783'),
    'the listing URL\'s code is not the only identity this product answers to');
  assert.ok(!related.some((entry) => entry.code === '429066'), 'the listing\'s own code is not "other"');
});

test('the corroboration rule leaves the structured offer route alone', () => {
  /* L.L.Bean is read through json-ld-offer on the product record, which
     is a different route with its own sku gate — it carries no data
     record, so the markup rule never touches it */
  const verdict = prices.decide(prices.pricesFromHtml(llbeanServed).candidates, LLBEAN);
  assert.strictEqual(verdict.price, 84.95);
  assert.strictEqual(verdict.identity.via, 'json-ld-offer');
  assert.ok(!verdict.refusals.some((r) => r.gate === 'corroboration'));
});

/* ---------------------------------------------------------
   --inspect-api is a command of its own

   It answers from ONE response. The ways it could quietly stop doing
   that — a URL the shell swallowed, an endpoint that hands back a page
   — are the ways a page's schema.org 7.90 ends up reported as a
   commerce API's answer, wearing an authority it never had.
   --------------------------------------------------------- */

console.log('\nThe endpoint command, and what it refuses to become\n');

test('markup is never a payload, however it arrives', () => {
  const page = '<!doctype html><html><head><script type="application/ld+json">'
    + JSON.stringify(UNIQLO_GRAPH)
    + '</scr' + 'ipt></head><body><div id="app"></div></body></html>';

  assert.strictEqual(prices.parseLoosely(page), null,
    "an endpoint that answers with a page must not have its page's JSON-LD carved out and read as its response");
  assert.deepStrictEqual(prices.parseLoosely('{"a":1}'), { a: 1 }, 'real JSON still parses');
});

test('schema.org served from an API URL is still schema.org', () => {
  assert.strictEqual(prices.looksLikeSchemaOrg(UNIQLO_GRAPH), true);
  assert.strictEqual(prices.looksLikeSchemaOrg(L2S), false);

  const served = prices.dataCandidates({
    responses: [{ url: L2S_URL, text: JSON.stringify(UNIQLO_GRAPH), mentions: ['e429066'] }]
  }, UNIQLO);
  assert.deepStrictEqual(served.map((c) => c.record.authority), ['markup'],
    'the URL it came through cannot lend it authority');

  const verdict = prices.decide(served, UNIQLO);
  assert.strictEqual(verdict.price, undefined, 'so it still cannot answer alone');
  assert.match(becauseGate(verdict.refusals, 7.9, 'corroboration'), /schema.org markup/);
});

test('the l2s array and the price map are joined on the variant identity', () => {
  const table = prices.variantTable(L2S);
  assert.strictEqual(table.rows.length, 1, 'result.l2s[*] is read as variant records');
  assert.strictEqual(table.maps.length, 1, 'result.prices[...] is read as a price map');
  assert.strictEqual(table.joined.length, 1);

  const join = table.joined[0];
  assert.strictEqual(join.on.key, 'l2Id');
  assert.strictEqual(join.on.value, '438783-COL09-004');
  assert.deepStrictEqual(join.map.amounts.map((a) => a.amount), [49.9]);
  assert.ok(join.variant.ids.some((id) => id.key === 'productId' && id.value === 'E429066-000'),
    'and the record naming the product is what ties the price to it');
  assert.ok(join.variant.describe.some((d) => /09 GRAY/.test(d.value)), 'with the colour it belongs to');
});

/* ---------------------------------------------------------
   What gets written, and what a written row has to keep proving
   --------------------------------------------------------- */

console.log('\nWriting it back\n');


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
      assert.deepStrictEqual(plain(is.priceEvidence), plain(was.priceEvidence),
        `${was.id} kept exactly the note it had, and gained none it did not earn`);
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

const NEXT_DATA = {
  props: { pageProps: { product: {
    productId: 'E429066-000',
    l1Id: '429066',
    name: 'Extra Fine Merino Crew Neck Long-Sleeve Sweater',
    prices: { base: { value: 49.9, currency: 'USD' }, listPrice: { value: 59.9, currency: 'USD' } }
  } } }
};

const API_PAYLOAD = {
  result: {
    items: [{ productId: 'E429066-000', prices: { base: { value: 49.9, currency: 'USD' } } }],
    recommendations: [{ productId: 'E465185-000', prices: { base: { value: 19.9, currency: 'USD' } } }]
  }
};

const API_WRONG = { result: { items: [{ productId: 'E465185-000', prices: { base: { value: 19.9, currency: 'USD' } } }] } };

function hydratingRetailer() {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const port = server.address().port;
    const here = `http://127.0.0.1:${port}${url}`;

    /* the commerce API the page fetches while it builds itself */
    if (url.startsWith('/api/commerce')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(L2S));
    }
    if (url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(url.startsWith('/api/wrong') ? API_WRONG : API_PAYLOAD));
    }

    /* the live UNIQLO shape: schema.org markup offering 7.90 on a page
       that prices itself from an endpoint, and one untied figure drawn
       in the DOM */
    if (url.startsWith('/stale') || url.startsWith('/l2s')) {
      const asks = url.startsWith('/l2s');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head>
        <link rel="canonical" href="${here}">
        <script type="application/ld+json">${JSON.stringify(UNIQLO_GRAPH)}</script>
        <title>Markup says 7.90</title></head>
        <body><div id="app"><div class="fr-ec-price"><span class="fr-ec-price-text">$7.90</span></div></div>
        ${asks ? `<script>fetch('/api/commerce/v5/en/products/E429066-000/price-groups/00/l2s?withPrices=true').then(function (r) { return r.json(); }).then(function (j) { window.__L2S__ = j; });</script>` : ''}
        </body></html>`);
    }

    /* the figure the page renders, and the block it renders it in */
    /* a page that publishes its price only in the payload it was built
       from — the UNIQLO shape — while rendering one untied figure */
    if (url.startsWith('/data')) {
      const wrong = url.startsWith('/data-wrong');
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><head>
        <link rel="canonical" href="${here}">
        <script id="__NEXT_DATA__" type="application/json">${wrong ? JSON.stringify(API_WRONG) : JSON.stringify(NEXT_DATA)}</script>
        <title>Hydrating data</title></head>
        <body><div id="app"><div class="fr-ec-price"><span class="fr-ec-price-text">$7.90</span></div></div>
        <script>
          window.__UNIQLO_STATE__ = { loaded: true };
          fetch('${wrong ? '/api/wrong/products' : '/api/products'}?productIds=E429066-000')
            .then(function (r) { return r.json(); })
            .then(function (json) { window.__UNIQLO_STATE__.products = json; });
        </script></body></html>`);
    }

    const block = url.startsWith('/consent')
      ? `<div id="onetrust-consent-sdk" style="position:fixed;bottom:0">
           <label><input type="checkbox" id="ot-group-id-C0004" checked> Targeting Cookies</label>
           <button id="ot-noop">Save</button>
         </div>
         <img src="/img/goods_03_429066_3x4.jpg" alt="sweater" style="width:300px;height:300px">
         <link-ish data-preload="/img/429066_hero.jpg"></link-ish>
         <div class="fr-ec-price"><span class="fr-ec-price-text">$7.90</span></div>`
      : url.startsWith('/scoped')
      ? `<div class="product-main" data-product-id="E429066-000">
           <span class="current-price">$49.90</span>
         </div>`
      : url.startsWith('/variant/p/AU763')
        ? `<div class="product-details" data-product-id="AU763">
             <div class="swatches">
               <button aria-checked="false" data-variant-id="AU763_BL0001">Blue</button>
               <button aria-checked="true" data-variant-id="AU763_WT0002">White</button>
             </div>
             <div data-variant-id="AU763_BL0001"><span class="is-price--current">$118</span></div>
             <div data-variant-id="AU763_WT0002"><span class="is-price--current">$98</span></div>
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
    skipped += 21;
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

    await testAsync('the selected colour is read off the page, and settles the group', async () => {
      const url = listing('/variant/p/AU763');
      const rendered = await prices.renderPage(url);
      assert.ok(!rendered.failed, rendered.failed);
      assert.ok(rendered.seen.selected.codes.includes('AU763_WT0002'),
        'the checked swatch says which colour the page is showing');

      const verdict = prices.decide(prices.renderedCandidates(rendered.seen, url).candidates, url);
      assert.strictEqual(verdict.price, 98);
      assert.strictEqual(verdict.identity.via, 'dom-variant-scope');
      assert.match(because(verdict.refusals, 118), /tied only to the product group/);
    });

    await testAsync('a row read through the browser says so in its trail', async () => {
      const row = { id: 'local', brand: 'Local', name: 'Hydrating', price: null, productUrl: listing('/products/E429066-000/00') };
      const result = await prices.resolveRow(row);

      assert.strictEqual(result.trail.readThrough, 'browser', 'a capture has to name the layer it was read through');
      assert.strictEqual(result.trail.browser.ran, true);
      assert.ok(result.trail.browser.candidates.length, 'and carry what the rendered page offered');
      assert.strictEqual(result.verdict, 'NO PRICE FOUND');
      assert.strictEqual(result.incomplete, undefined, 'this run DID read the rendered page');
    });

    await testAsync('--inspect prints the element chain behind a figure', async () => {
      const url = listing('/products/E429066-000/00');
      const report = await prices.inspectUrl(url);

      const seven = report.figures.find((f) => f.amount === 7.9);
      assert.ok(seven, 'the hydrated figure is in the inspection');
      assert.ok(seven.dom.chain.length, 'with the ancestry above it');
      assert.ok(seven.dom.chain.some((link) => link.cls && link.cls.includes('fr-ec-price')),
        'naming the block it actually sits in');
      assert.strictEqual(seven.identity.ok, false);
      assert.match(seven.identity.why, /vouches for the page/);
      assert.ok(report.verdict.price === undefined, 'and the inspection would write nothing');
    });

    await testAsync('a checked cookie category is not reported as a selected variant', async () => {
      /* the live UNIQLO reading: ot-group-id-C0004 and C0004 arrived as
         the page's "selected" state, and they are OneTrust categories */
      const report = await prices.inspectUrl(listing('/consent/products/E429066-000/00'));

      assert.deepStrictEqual(report.selected.codes, [],
        'a cookie category is not a colour, and must not reach the gates as one');
      assert.ok(report.selected.ignored.some((i) => /ot-group-id-C0004/i.test(i.code)),
        'and the inspection names what it ignored, so nobody reads C0004 as a variant');
    });

    await testAsync('the product code in image URLs is found, and named as having no figure', async () => {
      /* the other live UNIQLO finding: the code appears in the DOM, but
         only where the pictures are — never around a price */
      const report = await prices.inspectUrl(listing('/consent/products/E429066-000/00'));

      assert.ok(report.codeSites.length, 'the code does appear in this DOM');
      assert.ok(report.codeSites.every((site) => site.money.length === 0),
        'but nothing carrying it contains a figure, which is why no price can be tied');
      assert.ok(report.codeSites.some((site) => /goods_03_429066/.test(site.attrs)), 'the image is one of them');
      assert.strictEqual(report.verdict.price, undefined);
    });

    await testAsync('the inspection says when the listing\'s code is nowhere in the DOM', async () => {
      /* the live UNIQLO finding, end to end: a figure with no code in
         its ancestry, on a page whose body never names the product */
      const report = await prices.inspectUrl(listing('/products/E429066-000/00'));
      assert.deepStrictEqual(report.codeSites, [],
        'nothing in the body carries the listing code, and the inspection has to say so rather than leave it inferred');
      assert.ok(report.listingCodes.includes('e429066'), 'while knowing exactly what it looked for');
      assert.strictEqual(report.verdict.price, undefined);
    });

    await testAsync('and points at the block when the code IS in the DOM', async () => {
      const report = await prices.inspectUrl(listing('/scoped/products/E429066-000/00'));
      assert.ok(report.codeSites.length, 'the block naming the product is found');

      const site = report.codeSites[0];
      assert.match(site.attrs, /data-product-id="E429066-000"/);
      assert.deepStrictEqual(site.money, ['$49.90'], 'and the figure inside it is reported with it');
      assert.strictEqual(report.verdict.price, 49.9);
    });

    await testAsync('the live shape: markup offers 7.90 and the run fails closed', async () => {
      const report = await prices.inspectData(listing('/stale/products/E429066-000/00'));

      const markup = report.hits.find((hit) => hit.amount === 7.9);
      assert.ok(markup, 'the markup record is found');
      assert.strictEqual(markup.authority, 'markup');

      const audited = report.audit.find((entry) => entry.amount === 7.9);
      assert.ok(audited, 'and audited');
      assert.match(audited.notes.join(' | '), /NOT corroborated/);
      assert.match(audited.notes.join(' | '), /priceValidUntil 2024-03-31 is in the past/);

      assert.strictEqual(report.verdict.price, undefined, '$7.90 is not written');
      assert.ok(report.verdict.refusals.some((r) => r.gate === 'corroboration'));
    });

    await testAsync('the live shape: the endpoint the page asks answers instead', async () => {
      const url = listing('/l2s/products/E429066-000/00');
      const rendered = await prices.renderPage(url, undefined, { data: true });
      assert.ok(!rendered.failed, rendered.failed);

      const verdict = prices.decide(prices.renderedCandidates(rendered.seen, url).candidates, url);
      assert.strictEqual(verdict.price, 49.9);
      assert.strictEqual(verdict.identity.via, 'data-variant-mapping');
      assert.strictEqual(verdict.identity.variant, '438783-COL09-004');
      assert.match(becauseGate(verdict.refusals, 7.9, 'corroboration'), /schema.org markup/);
      assert.match(becauseGate(verdict.refusals, 7.9, 'this'), /nothing in its own DOM ties it/);
    });

    await testAsync('--inspect-api with no URL stops, and reads no catalogue', async () => {
      const result = await run(['--inspect-api', '--for', listing('/l2s/products/E429066-000/00')]);

      assert.notStrictEqual(result.code, 0, 'a swallowed URL has to stop the run');
      assert.match(result.stderr, /--inspect-api needs the API URL/);
      assert.match(result.stderr, /the catalogue was not read/);
      assert.doesNotMatch(result.stdout, /Reading \d+ linked product page/,
        'it must never quietly become a catalogue verification');
      assert.doesNotMatch(result.stdout, /7\.9/);
    });

    await testAsync('--inspect-api on an endpoint that answers a page reports THAT', async () => {
      /* the live symptom: the URL answers HTML, and the page it answers
         with carries the 7.90 markup */
      const result = await run(['--inspect-api', listing('/stale/products/E429066-000/00'), '--for', listing('/stale/products/E429066-000/00')]);

      assert.match(result.stdout, /NOT INSPECTED/);
      assert.match(result.stdout, /this is a page, not an API response/);
      assert.match(result.stdout, /does not fall back to the page, its DOM or its JSON-LD/);
      assert.doesNotMatch(result.stdout, /WOULD WRITE/, 'nothing may be written from a page');
      assert.doesNotMatch(result.stdout, /7\.9/, "and the page's markup price must not appear as the endpoint's answer");
      assert.doesNotMatch(result.stdout, /Reading \d+ linked product page/);
    });

    await testAsync('--inspect-api on the real endpoint reports the chain', async () => {
      const result = await run([
        '--inspect-api', listing('/api/commerce/v5/en/products/E429066-000/price-groups/00/l2s?withPrices=true'),
        '--for', listing('/l2s/products/E429066-000/00')
      ]);

      assert.strictEqual(result.code, 0, result.stderr);
      assert.match(result.stdout, /joined on l2Id = 438783-COL09-004/);
      assert.match(result.stdout, /E429066-000: \$49\.9 USD/);
      assert.match(result.stdout, /THIS ENDPOINT ALONE WOULD WRITE \$49\.9/);
      assert.doesNotMatch(result.stdout, /Reading \d+ linked product page/);
    });

    await testAsync('the endpoint command reads that response and nothing else', async () => {
      const report = await prices.inspectEndpoint(
        listing('/api/commerce/v5/en/products/E429066-000/price-groups/00/l2s?withPrices=true'),
        { forUrl: listing('/l2s/products/E429066-000/00') }
      );
      assert.strictEqual(report.foreign, 0, 'nothing from outside this response was even offered');
      assert.deepStrictEqual(report.sources, [`network ${listing('/api/commerce/v5/en/products/E429066-000/price-groups/00/l2s?withPrices=true')}`]);
    });

    await testAsync('an endpoint that answers a page is refused, with the page named', async () => {
      const report = await prices.inspectEndpoint(listing('/stale/products/E429066-000/00'), {
        forUrl: listing('/stale/products/E429066-000/00')
      });
      assert.strictEqual(report.notJson, true);
      assert.match(report.failed, /page, not an API response/);
      assert.strictEqual(report.verdict, undefined, 'a refused read has no verdict at all');
      assert.strictEqual(report.hits, undefined);
    });

    await testAsync('--inspect-api reads one endpoint the way the page reads it', async () => {
      const report = await prices.inspectEndpoint(
        listing('/api/commerce/v5/en/products/E429066-000/price-groups/00/l2s?withPrices=true'),
        { forUrl: listing('/l2s/products/E429066-000/00') }
      );

      assert.ok(!report.failed, report.failed);
      assert.strictEqual(report.status, 200);
      assert.ok(report.codes.includes('e429066'), 'it looks for the codes the listing answers to');

      /* the amounts live in a map keyed by variant, so the endpoint
         prices the product through that key rather than on the record */
      const mapped = report.variants.priced.find((hit) => hit.amount === 49.9);
      assert.ok(mapped, 'the endpoint carries the amount under the variant id');
      assert.strictEqual(mapped.currency, 'USD');
      assert.strictEqual(mapped.codeKey, '(map key)');

      const answer = report.byCode.find((entry) => /E429066-000/i.test(entry.code));
      assert.ok(answer, 'and the answer is reported against the listing, not the map key');
      assert.deepStrictEqual(answer.priced.map((p) => p.amount), [49.9]);
      assert.strictEqual(answer.priced[0].variant, '438783-COL09-004');

      assert.ok(report.related.some((entry) => /438783/.test(entry.code)), 'the identity it keys by is reported');
      assert.ok(report.colours.length, 'and the colour fields it carries');
      assert.strictEqual(report.verdict.price, 49.9, 'this endpoint alone would answer');
    });

    await testAsync('--inspect-data finds the record the page was built from', async () => {
      const report = await prices.inspectData(listing('/data/products/E429066-000/00'));

      assert.ok(report.mentions.some((m) => /__NEXT_DATA__/.test(m.where)), 'the script that names the product is reported');
      assert.ok(report.mentions.some((m) => /network .*\/api\/products/.test(m.where)), 'so is the JSON the page fetched');

      const record = report.hits.find((h) => h.amount === 49.9);
      assert.ok(record, 'the record holding the code and the amount is found');
      assert.strictEqual(record.currency, 'USD');
      assert.strictEqual(record.code, 'E429066-000');
      assert.match(record.field, /prices\.base\.value/);

      assert.ok(report.hits.every((h) => h.amount !== 19.9), "the recommendation's price is not among the hits");
      assert.strictEqual(report.verdict.price, 49.9);
      assert.ok(report.candidates.some((c) => c.identity.via === 'data-product-record'));
    });

    await testAsync('the page\'s own untied figure is still refused in that same run', async () => {
      const url = listing('/data/products/E429066-000/00');
      const rendered = await prices.renderPage(url, undefined, { data: true });
      assert.ok(!rendered.failed, rendered.failed);

      const read = prices.renderedCandidates(rendered.seen, url);
      assert.ok(amounts(read.candidates).includes(7.9), 'the $7.90 figure is still read');

      const verdict = prices.decide(read.candidates, url);
      assert.strictEqual(verdict.price, 49.9, 'the record answers');
      assert.match(because(verdict.refusals, 7.9), /nothing in its own DOM ties it to this product/);
      assert.match(because(verdict.refusals, 59.9), /list or comparison field/);
    });

    await testAsync('a payload naming another product resolves nothing', async () => {
      const report = await prices.inspectData(listing('/data-wrong/products/E429066-000/00'));
      assert.deepStrictEqual(report.hits, [], 'no record names this listing');
      assert.strictEqual(report.verdict.price, undefined, 'and the run fails closed');
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
