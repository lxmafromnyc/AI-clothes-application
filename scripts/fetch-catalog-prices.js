#!/usr/bin/env node
/* =========================================================
   Fynd — read each catalogue row's price off the retailer's own page

   The rows that name a productUrl point at a real listing, and that
   listing charges a real amount for it. This reads that amount off the
   page the row already links to, so the number written back is the
   retailer's own.

   A price is harder to read than a photo, because a product page is
   full of figures that are not what this product costs: the list price
   it is discounted from, the four instalments a financing widget
   offers, the free-shipping threshold, the prices of the six products
   in the recommendation strip. Any of them parses as money. None of
   them is the answer.

   So a candidate has to survive four gates before it may be written:

     found     it appeared on the linked product page — in its
               structured record, or as a figure the page rendered —
               never computed, carried over or inferred from a sibling
     money     it reads as a positive amount in a currency the page
               itself names, not a rating, a size or a percentage
     this      its own DOM or its own structured record ties it to THIS
               product: the price block it sits in names the listing's
               code, or the offer carrying it belongs to a product
               record whose sku matches. The page being the canonical
               page for the listing is NOT this gate. Canonical vouches
               for the page; it says nothing about which of the page's
               figures is this product's price.
     charged   something on the page says this is the amount charged:
               itemprop="price" inside the offer, an element the page
               marks as the current or sale price, a figure that is not
               struck through. A list price and a "4 payments of" are
               refused here by name.

   A row records the price of the variant the page had SELECTED. A
   product with variant-dependent pricing — UNIQLO prices colours of
   one sweater at 7.90 and 49.90 — has no single price, and the one
   worth recording is the one a shopper is being offered when the
   listing is opened. The evidence written beside it names which
   variant, so the row can never be mistaken for the product's only
   price.

   And then one rule over all of them: if more than one distinct amount
   clears every gate, the run FAILS CLOSED. Two figures both claiming to
   be the charged price is not a tie to be broken by picking the lowest,
   the first or the biggest — it means the page has not said, and a
   catalogue row is better empty than confidently wrong.

   Two ways in, in this order. Plain HTTP first, because a page that
   publishes an offer in its JSON-LD has already answered. When that
   yields nothing usable the page is opened in a real Chromium, which
   runs its scripts and renders its price block — and what is read there
   is the price ELEMENT and its ancestry, not just the text, because the
   ancestry is the only thing that can say whose price it is.

   It reports by default and changes nothing. --write is what edits
   assets/catalog.js, and it only ever fills in rows that verified.

   Run it from a machine with an ordinary internet connection. Behind a
   proxy that refuses retailer hosts every row comes back UNREACHABLE,
   and the report is about the proxy rather than about the catalogue.

   Usage
     node scripts/fetch-catalog-prices.js
     node scripts/fetch-catalog-prices.js --write
     node scripts/fetch-catalog-prices.js --only jcrew-broken-in-oxford
     node scripts/fetch-catalog-prices.js --refresh        re-read rows that have one
     node scripts/fetch-catalog-prices.js --no-browser     plain HTTP only
     node scripts/fetch-catalog-prices.js --explain        every candidate and its DOM
     node scripts/fetch-catalog-prices.js --explain --json  the same, as a capture
     node scripts/fetch-catalog-prices.js --inspect <url>   one page's rendered
                                                            figures and their ancestry
     node scripts/fetch-catalog-prices.js --inspect-data <url>  the scripts, state
                                                            and JSON the page carries
     node scripts/fetch-catalog-prices.js --inspect-api <endpoint> --for <productUrl>
                                                            one API response, read
                                                            from inside the page
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

/* the parts of reading a retailer's page that are not about images:
   one definition of a listing's code, one cookie-wall list, one way in */
const {
  BROWSER, fetchPage, jsonLdNodes, parseLdBlock, metaContent, skuOf,
  identifiersFrom, samePage, readCatalog, loadPlaywright, dismissConsent,
  coaxLazyImages, rowEndsAt
} = require('./fetch-catalog-images');

const CATALOG = path.join(__dirname, '..', 'assets', 'catalog.js');
const BROWSER_TIMEOUT = 45000;
const MAX_PRICE = 100000;   // above this it is an account number, not a price
const MIN_PRICE = 0.5;      // below it, a unit price or a shipping rounding

/* ---------- the command line ----------

   Read once, into a shape the rest of the file asks questions of. It
   was a scan of process.argv for an exact string, and that is how
   --inspect-api=<url> became a catalogue verification: the equals form
   is invisible to an includes() test, so the flag was not there, so the
   run fell through to the ordinary path and priced a row from the
   page's markup. Every option is therefore accepted in both spellings
   and in any case, and anything not recognised STOPS the run rather
   than being ignored — an ignored option is a different command than
   the one that was typed. */
const OPTIONS = {
  '--help': 'boolean',
  '--version': 'boolean',
  '--write': 'boolean',
  '--refresh': 'boolean',
  '--no-browser': 'boolean',
  '--explain': 'boolean',
  '--json': 'boolean',
  '--only': 'value',
  '--inspect': 'value',
  '--inspect-data': 'value',
  '--inspect-api': 'value',
  '--hunt': 'value',
  '--datalayer': 'value',
  '--find': 'value',
  '--for': 'value',
  '--codes': 'value'
};

function parseArgs(argv) {
  const flags = {};
  const errors = [];

  for (let at = 0; at < argv.length; at += 1) {
    const token = String(argv[at]);
    if (!token.startsWith('--')) {
      errors.push(`stray argument "${token}" — options are written --like-this`);
      continue;
    }

    const equals = token.indexOf('=');
    const name = (equals >= 0 ? token.slice(0, equals) : token).toLowerCase();
    let value = equals >= 0 ? token.slice(equals + 1) : undefined;

    const kind = OPTIONS[name];
    if (!kind) {
      errors.push(`unknown option "${name}"`);
      continue;
    }
    if (kind === 'boolean') {
      if (value !== undefined) errors.push(`${name} takes no value`);
      flags[name] = true;
      continue;
    }
    if (value === undefined) {
      const next = argv[at + 1];
      if (next !== undefined && !String(next).startsWith('--')) {
        value = String(next);
        at += 1;
      }
    }
    flags[name] = value === undefined || value === '' ? null : value;
  }

  return { flags, errors };
}

/* Which command was typed. One function, so the answer is the same
   whether a person, a test or the dispatcher is asking. */
function chooseMode(parsed) {
  const flags = (parsed && parsed.flags) || {};
  const named = (name) => Object.prototype.hasOwnProperty.call(flags, name);
  const stop = ' Nothing was inspected, and the catalogue was not read.';

  if (named('--version')) return { mode: 'version' };
  if (named('--help')) return { mode: 'help' };

  if (named('--inspect-api')) {
    const endpoint = flags['--inspect-api'];
    if (!endpoint) {
      return { mode: 'inspect-api', error: '--inspect-api needs the API URL to read: --inspect-api "<url>" --for "<productUrl>".' + stop };
    }
    if (!/^https?:\/\//i.test(endpoint)) {
      return { mode: 'inspect-api', error: `--inspect-api needs an http(s) URL, and got "${endpoint}".` + stop };
    }
    if (named('--for') && !flags['--for']) {
      return { mode: 'inspect-api', error: '--for needs the product URL the endpoint belongs to.' + stop };
    }
    return {
      mode: 'inspect-api',
      endpoint,
      forUrl: flags['--for'] || null,
      codes: String(flags['--codes'] || '').split(',').map((code) => code.trim()).filter(Boolean)
    };
  }

  if (named('--datalayer')) {
    const url = flags['--datalayer'];
    return url ? { mode: 'datalayer', url } : { mode: 'datalayer', error: '--datalayer needs the product URL to load.' + stop };
  }

  if (named('--hunt')) {
    const url = flags['--hunt'];
    if (!url) return { mode: 'hunt', error: '--hunt needs the product URL to load.' + stop };
    return {
      mode: 'hunt',
      url,
      find: String(flags['--find'] || '').split(',').map((needle) => needle.trim()).filter(Boolean)
    };
  }

  if (named('--inspect-data')) {
    const url = flags['--inspect-data'];
    return url ? { mode: 'inspect-data', url } : { mode: 'inspect-data', error: '--inspect-data needs the product URL to read.' + stop };
  }

  if (named('--inspect')) {
    const url = flags['--inspect'];
    return url ? { mode: 'inspect', url } : { mode: 'inspect', error: '--inspect needs the product URL to read.' + stop };
  }

  return { mode: 'verify' };
}

/* Every command this file can run. Kept beside the dispatcher rather
   than in a comment, so --version can list what a build actually does
   and a test can hold the list to what chooseMode will produce. */
const MODES = ['verify', 'inspect', 'inspect-data', 'inspect-api', 'hunt', 'datalayer', 'help', 'version'];

/* What build is this? The question has now been asked three times in
   the shape "the feature you describe is not in my copy", and answering
   it should not need git: the file fingerprints itself and lists the
   commands it has. If a mode is missing from this output it is missing
   from this build, whatever anyone says about it. */
function buildStamp() {
  const crypto = require('crypto');
  const stamp = { file: __filename, digest: null, bytes: null, commit: null, modes: MODES, options: Object.keys(OPTIONS).sort() };

  try {
    const body = fs.readFileSync(__filename);
    stamp.bytes = body.length;
    stamp.digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  } catch (err) { /* a build that cannot read itself still reports what it can */ }

  try {
    const gitDir = path.join(__dirname, '..', '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      try {
        stamp.commit = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 12);
      } catch (err) {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        const line = packed.split('\n').find((entry) => entry.endsWith(' ' + ref));
        if (line) stamp.commit = line.split(' ')[0].slice(0, 12);
      }
      stamp.branch = ref.replace('refs/heads/', '');
    } else {
      stamp.commit = head.slice(0, 12);
    }
  } catch (err) { /* outside a checkout, the digest is the identity */ }

  return stamp;
}

function printBuild(stamp) {
  console.log('\n  fetch-catalog-prices');
  console.log(`  build     sha256:${stamp.digest || 'unreadable'}${stamp.bytes ? `, ${size(stamp.bytes)}` : ''}`);
  console.log(`  commit    ${stamp.commit || 'unknown'}${stamp.branch ? ` on ${stamp.branch}` : ''}`);
  console.log(`  modes     ${stamp.modes.join(', ')}`);
  console.log(`  options   ${stamp.options.join(' ')}`);
  console.log('\n  A mode missing from this list is missing from this build.\n');
}

const USAGE = `
  Fynd — read each catalogue row's price off the retailer's own page

  Verifying the catalogue
    --only <row-id>      just this row
    --refresh            re-read rows that already carry a price
    --no-browser         plain HTTP only, no Chromium
    --write              write what verified into assets/catalog.js
    --explain            every candidate, with the DOM behind it
    --json               emit the run as a capture

  Diagnostics — these read ONE page or ONE response. They never touch
  the catalogue and never write anything.
    --inspect <productUrl>          every figure the page renders, its
                                    ancestry, and what each gate says
    --inspect-data <productUrl>     the scripts, window state and JSON
                                    the page carries, and which records
                                    hold the listing's code AND a price
    --inspect-api <apiUrl> --for <productUrl>
                                    one API response, fetched from
                                    inside the opened product page.
                                    Answers from that response alone —
                                    never from the page's DOM or its
                                    JSON-LD. Add --codes a,b,c to search
                                    for identities beyond the URL's own.
    --hunt <productUrl> --find 49.90,49.9
                                    every response, script and state
                                    object the page loaded, searched for
                                    those amounts and for this listing's
                                    identities. Each hit is reported with
                                    its JSON path, the record around it,
                                    whether that record is tied to the
                                    product, and the nearest currency.
                                    An amount is also hunted in the other
                                    shapes an API may carry it in — 49.90
                                    as 4990 in cents — which is how a
                                    displayed price that is nowhere to be
                                    found turns up. Hunts decide nothing.
    --datalayer <productUrl>        the page's dataLayer ecommerce
                                    events in full, every variant its
                                    data prices, and the chain link by
                                    link: selected variant -> the API's
                                    amount -> the event's currency and
                                    product ids -> the figure on screen.
                                    Says what the ordinary gates make of
                                    it, and writes nothing.
    --help                          this
    --version                       what this build is: a fingerprint of
                                    the file, the commit it came from,
                                    and every mode and option it has

  Options may be written --flag value or --flag=value. An unrecognised
  option stops the run: being ignored would silently make it a
  different command.
`;

const args = process.argv.slice(2);
const parsedArgs = parseArgs(args);
const has = (name) => Object.prototype.hasOwnProperty.call(parsedArgs.flags, name);
const flag = (name) => (has(name) ? parsedArgs.flags[name] : null);

const only = flag('--only');
const writing = has('--write');
const refreshing = has('--refresh');
const useBrowser = !has('--no-browser');
const explaining = has('--explain');
const asJson = has('--json');

/* ---------- is this figure money? ----------

   A number becomes a price only where something names a currency: the
   structured record's priceCurrency, or the symbol the page printed
   next to it. "429066" and "4.5" and "100% cotton" are all numbers on
   these pages, and none of them is an amount. */
const CURRENCY_SYMBOLS = { $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR' };
const CODES = /\b(USD|GBP|EUR|JPY|INR|CAD|AUD|CHF|SEK|PLN|MXN|BRL)\b/i;

function toAmount(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/,/g, '').trim();
  const match = raw.match(/\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n < MIN_PRICE || n > MAX_PRICE) return null;
  return Number(n.toFixed(2));
}

function currencyIn(value) {
  const raw = String(value === null || value === undefined ? '' : value);
  const code = raw.match(CODES);
  if (code) return code[1].toUpperCase();
  for (const symbol of Object.keys(CURRENCY_SYMBOLS)) {
    if (raw.includes(symbol)) return CURRENCY_SYMBOLS[symbol];
  }
  return null;
}

/* money as a page prints it: a currency marker and a figure together.
   The marker is required — a bare number in a price block is a size
   chart entry as often as it is an amount. */
function moneyInText(text) {
  const raw = String(text === null || text === undefined ? '' : text);
  const marked = raw.match(/(?:US\s*\$|\$|USD|£|€)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i)
    || raw.match(/([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:USD|GBP|EUR)\b/i);
  if (!marked) return null;
  const amount = toAmount(marked[1]);
  if (amount === null) return null;
  return { amount, currency: currencyIn(raw) || 'USD', text: raw.trim().slice(0, 60) };
}

/* ---------- what the structured record offers ----------

   schema.org says this plainly when a retailer fills it in: a Product
   carries offers, an Offer carries a price, and the Product carries the
   sku that says which product it is about. That is the whole chain, and
   where it is complete nothing has to be inferred from the layout.

   An AggregateOffer is a range. lowPrice 58 highPrice 148 is not a
   price this product is sold at; it is the span of a group. It is kept
   as a candidate only so the report can say it was seen and refused. */
function offersIn(node) {
  const raw = node && (node.offers || node.offer);
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.filter((o) => o && typeof o === 'object');
}

function isProductNode(node) {
  return Boolean(node) && /product/i.test(String(node['@type'] || ''));
}

function offerAmounts(offer) {
  const out = [];
  const currency = currencyIn(offer.priceCurrency) || null;
  const spec = offer.priceSpecification && typeof offer.priceSpecification === 'object'
    ? offer.priceSpecification : null;

  const direct = toAmount(offer.price !== undefined ? offer.price : (spec ? spec.price : undefined));
  if (direct !== null) {
    out.push({ amount: direct, currency: currency || currencyIn(spec && spec.priceCurrency) || 'USD', kind: 'price' });
    return out;
  }

  const low = toAmount(offer.lowPrice);
  const high = toAmount(offer.highPrice);
  if (low !== null && high !== null && low === high) {
    out.push({ amount: low, currency: currency || 'USD', kind: 'price' });
    return out;
  }
  if (low !== null || high !== null) {
    out.push({
      amount: low === null ? high : low,
      currency: currency || 'USD',
      kind: 'range',
      span: [low, high]
    });
  }
  return out;
}

/* Every offer on the page, kept WITH the product record that carries it
   — the record is what ties the amount to a product, so an offer that
   travels without one cannot be used. An empty offers array is recorded
   too: "this product record publishes no price" is an answer, and a
   report that does not say it sends the reader looking for a bug. */
function structuredCandidates(nodes) {
  const out = [];
  const empties = [];

  for (const node of nodes) {
    if (!isProductNode(node)) continue;
    const offers = offersIn(node);
    if (!offers.length) {
      empties.push({
        type: String(node['@type'] || 'Product'),
        skus: skuOf(node),
        name: typeof node.name === 'string' ? node.name : null,
        why: Array.isArray(node.offers) && node.offers.length === 0
          ? 'the product record carries offers: [] — it publishes no price at all'
          : 'the product record carries no offers'
      });
      continue;
    }
    for (const offer of offers) {
      for (const found of offerAmounts(offer)) {
        out.push({
          amount: found.amount,
          currency: found.currency,
          text: `${found.amount}`,
          from: found.kind === 'range' ? 'json-ld aggregate offer' : 'json-ld offer',
          kind: found.kind,
          span: found.span || null,
          node,
          offer,
          availability: typeof offer.availability === 'string' ? offer.availability : null
        });
      }
    }
  }
  return { candidates: out, empties };
}

/* The page's own price meta tags. They are collected so the report can
   show them being refused rather than silently skipped: they describe
   THE PAGE, and a page is not a product — see priceIdentity. */
const PRICE_METAS = ['product:price:amount', 'og:price:amount', 'twitter:data1'];

function metaCandidates(html) {
  const out = [];
  for (const name of PRICE_METAS) {
    const value = metaContent(html, name);
    if (!value) continue;
    const currency = currencyIn(metaContent(html, name.replace(':amount', ':currency')) || '') || currencyIn(value) || 'USD';
    const amount = toAmount(value);
    if (amount === null) continue;
    out.push({ amount, currency, text: String(value), from: name, kind: 'meta' });
  }
  return out;
}

function pricesFromHtml(html) {
  const nodes = jsonLdNodes(html);
  const structured = structuredCandidates(nodes);
  return {
    candidates: [...structured.candidates, ...metaCandidates(html)],
    empties: structured.empties,
    canonical: (function () {
      const link = String(html).match(/<link[^>]+rel=["']canonical["'][^>]*>/i);
      const href = link && link[0].match(/href=["']([^"']+)["']/i);
      return href ? href[1] : (metaContent(html, 'og:url') || null);
    })()
  };
}

/* ---------- is this THIS product's price? ----------

   The gate the previous reading got wrong. A page that declares itself
   the canonical page for a listing has proved something about the PAGE.
   A product page renders many figures, and canonical says nothing about
   which of them is the product's price — so it cannot vouch for one,
   the way it can vouch for an og:image the page publishes as its own.

   What counts instead is provenance the figure carries itself:

     dom-product-scope   the price block it sits in names the listing's
                         code — data-product-id, an itemprop sku, an id
                         carrying the code
     microdata-offer     it is the itemprop="price" of an Offer that
                         sits inside the Product scope for this listing
     json-ld-offer       it is the price of an offer on a product record
                         whose sku matches the listing

   A figure that cannot say which product it belongs to is refused even
   when it is plainly a price, plainly on the right page, and plainly
   the only one there. That is how a recommendation strip's price, a
   promotional banner's price and a hydration artefact get in. */

/* a long code may sit anywhere; a short one has to sit at a boundary,
   so J.Crew's AU763 cannot match its way in from inside a hash */
function namesCode(text, id) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(id || '').toLowerCase();
  if (!haystack || !needle) return false;
  if (needle.length >= 6) return haystack.includes(needle);
  const at = haystack.indexOf(needle);
  if (at < 0) return false;
  const before = haystack[at - 1];
  const after = haystack[at + needle.length];
  const boundary = (c) => c === undefined || /[^a-z0-9]/.test(c);
  return boundary(before) && boundary(after);
}

/* The figure's own code IS the selected variant when it says at least
   as much as the selection does: AU763_WT0002 is the selected
   AU763-WT0002, while the group code AU763 is not — it names the group
   the selection belongs to, which every colour on the page also names. */
/* The same consent shapes the gatherer refuses to collect, refused
   again here. The gate does not get to assume the page was read by a
   gatherer that filtered them: a capture made by an older run, or by
   hand, can carry ot-group-id-C0004 in its selected codes, and a cookie
   category must not promote a figure to "the selected variant" wherever
   it came from. */
const CONSENT_CODE = /^(ot-|c000\d$|optanon)/i;

function selectedAmong(values, selected) {
  const bare = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const value of values || []) {
    const code = bare(value);
    if (!code) continue;
    for (const pick of selected || []) {
      if (CONSENT_CODE.test(String(pick).trim())) continue;
      const chosen = bare(pick);
      if (chosen && code.includes(chosen)) return String(value);
    }
  }
  return null;
}

function matchingCode(values, ids) {
  for (const value of values || []) {
    for (const id of ids) {
      if (namesCode(value, id)) return { value: String(value), id };
    }
  }
  return null;
}

/* ---------- the variant chain ----------

   A commerce response prices ONE variant and says nothing about units.
   An analytics event names that same variant, the product it belongs
   to, and the currency — and carries the same amount. Each link is
   something the page said; the chain is what makes them one statement
   rather than four loose numbers.

   Every link is required. The event must name THIS product, and the
   variant it names must be the one the amount was filed under, and it
   must carry that amount, and the amount must come from the shop's own
   commerce data rather than from the event itself — otherwise the event
   would be corroborating itself. A variant belonging to another
   product contributes nothing, and neither does an event that shares a
   currency but not an amount. */
function variantChain(record, ids) {
  const from = record && record.currencyFrom;
  if (!from || from.via !== 'amount-and-identity' || !from.analytics) return null;
  if (record.authority !== 'commerce-api') return null;

  const fields = from.fields || [];
  const product = fields.find((field) => matchingCode([field.value], ids));
  if (!product) return null;

  const owner = record.mappedFrom || null;
  const l2Id = record.code || (owner && owner.variant) || null;
  if (!l2Id) return null;

  /* the variant has to be a variant: a chain whose "variant" is the
     product code again says nothing about which one was priced */
  if (String(l2Id).toLowerCase() === String(product.value).toLowerCase()) return null;
  if (!fields.some((field) => String(field.value).toLowerCase() === String(l2Id).toLowerCase())) return null;

  const pick = (list, pattern) => (list || []).find((field) => pattern.test(field.key));
  const l1 = pick(fields, /l1/i) || (owner && pick(owner.fields, /l1/i));
  const communication = (owner && pick(owner.fields, /communication/i)) || pick(fields, /communication/i);

  const chain = {
    ok: true,
    via: 'datalayer-variant-price',
    productId: product.value,
    l2Id: String(l2Id),
    currency: record.currency,
    /* what a shipped row is re-proved against: the product code, which
       is the one identifier in the chain that the listing URL carries */
    code: product.value,
    how: `${record.source} prices ${l2Id} at ${record.path}, and ${from.source} names that same variant (${product.key}=${product.value}`
      + `${l1 ? `, ${l1.key}=${l1.value}` : ''}) with the same amount in ${record.currency}`
  };
  if (l1) chain.l1Id = l1.value;
  if (communication) chain.communicationCode = communication.value;
  return chain;
}

function priceIdentity(candidate, productUrl) {
  const ids = identifiersFrom(productUrl);
  if (!ids.length) return { ok: false, why: 'the listing URL carries no product code to match against' };

  /* ---- a structured offer, on a product record that names the sku ---- */
  if (candidate.node) {
    const skus = skuOf(candidate.node);
    const hit = matchingCode(skus, ids);
    if (hit) {
      return {
        ok: true,
        via: 'json-ld-offer',
        sku: hit.value,
        how: `the offer belongs to the product record naming sku ${hit.value}`
      };
    }
    return {
      ok: false,
      why: `the product record carrying this offer names ${skus.length ? skus.join(', ') : 'no sku'}, which is not this listing (${ids.slice(0, 3).join(', ')})`
    };
  }

  /* ---- a record out of the page's own data ---- */
  if (candidate.record) {
    const record = candidate.record;

    /* the strongest thing a page can say about a variant's price */
    const chained = variantChain(record, ids);
    if (chained) return chained;

    if (record.mappedFrom) {
      const owner = record.mappedFrom;
      if (!matchingCode([owner.listing], ids)) {
        return { ok: false, why: `the record pricing ${record.code} is tied to ${owner.listing}, which is not this listing` };
      }
      return {
        ok: true,
        via: 'data-variant-mapping',
        code: owner.listing,
        variant: record.code,
        at: record.recordPath,
        how: `${owner.source} names ${owner.listing} with ${owner.variantKey} ${record.code}, and ${record.source} prices ${record.code} at ${record.path}`
      };
    }

    const named = matchingCode([record.code], ids);
    if (!named) {
      return { ok: false, why: `the data record names ${record.code}, which is not this listing (${ids.slice(0, 3).join(', ')})` };
    }
    if (record.elsewhere) {
      return { ok: false, why: `it sits under "${record.elsewhere}", which holds other products` };
    }
    return {
      ok: true,
      via: 'data-product-record',
      code: record.code,
      at: record.recordPath,
      how: `${record.source} carries ${record.code} and this amount as fields of one record (${record.path})`
    };
  }

  /* ---- a rendered figure, judged on its own ancestry ---- */
  const dom = candidate.dom;
  if (dom) {
    const hit = matchingCode(dom.codes, ids);
    if (hit) {
      /* a group page prices every colour at once, so the figure tied to
         the variant the page has SELECTED says more than one tied only
         to the group all of them belong to */
      const chosen = selectedAmong(dom.codes, (candidate.selected && candidate.selected.codes) || []);
      if (chosen) {
        return {
          ok: true,
          via: 'dom-variant-scope',
          /* both, and for different jobs: the listing's own code is what
             a shipped row can be re-proved against later, while the
             variant names WHICH colour of that listing was on screen
             when the amount was read. A note carrying only the variant
             could never be re-proved, because a variant code such as
             CX449NA6434 does not appear in the listing URL. */
          code: hit.value,
          variant: chosen,
          how: `the ${dom.codeLabel || 'price block'} it sits in names ${chosen}, the variant the page has selected, under this listing's ${hit.value}`
        };
      }
      return {
        ok: true,
        via: 'dom-product-scope',
        code: hit.value,
        how: `the ${dom.codeLabel || 'price block'} it sits in names ${hit.value}`
      };
    }

    if (dom.offerScope && dom.itemprop === 'price') {
      const scoped = matchingCode(dom.scopeSkus, ids);
      if (scoped) {
        return {
          ok: true,
          via: 'microdata-offer',
          sku: scoped.value,
          how: `itemprop="price" inside the offer of the product scope naming sku ${scoped.value}`
        };
      }
      return {
        ok: false,
        why: `itemprop="price", but the offer it belongs to sits in no product scope naming this listing (${ids.slice(0, 3).join(', ')})`
      };
    }

    if ((dom.codes || []).length) {
      return {
        ok: false,
        why: `the block it sits in names ${dom.codes.slice(0, 2).join(', ')}, not this listing (${ids.slice(0, 3).join(', ')})`
      };
    }

    if (candidate.canonical && samePage(candidate.canonical, productUrl)) {
      return {
        ok: false,
        why: 'nothing in its own DOM ties it to this product — the page is this listing\'s canonical page, but that vouches for the page, not for which of its figures is the price'
      };
    }

    return { ok: false, why: `nothing in its own DOM ties it to this product (looked for ${ids.slice(0, 3).join(', ')})` };
  }

  /* ---- a meta tag ---- */
  return {
    ok: false,
    why: `${candidate.from} describes the page, not a product record — it names no sku, so nothing ties it to this listing`
  };
}

/* ---------- is this the amount CHARGED? ----------

   Everything here is read off the page's own markup. A struck-through
   figure is what the product is discounted FROM; "4 payments of" is a
   financing widget; "free over" is a shipping threshold. Each is money,
   each sits in the product's own block, and none is the price. */
const CHARGED = /(^|[^a-z])(current|sale|sales|now|final|selling|offer)([^a-z]|$)/i;
const LIST = /(^|[^a-z])(list|was|original|orig|regular|reg|msrp|compare|comparison|strike|struck|crossed|before|retail|standard)([^a-z]|$)/i;
const INSTALMENT = /(instal|installment|afterpay|klarna|affirm|sezzle|zip-?pay|monthly|per\s*month|\/mo|payments? of|interest-free)/i;
const NOT_THE_PRODUCT = /(shipping|delivery|threshold|free over|coupon|promo|voucher|gift card|subtotal|total|reward|points|tax|fee)/i;

function chargedEvidence(candidate) {
  /* a record states its price rather than displaying it, so what has to
     be ruled out is a list field and an amount with no currency on it */
  if (candidate.record) {
    const record = candidate.record;
    if (record.kind === 'list') {
      return { ok: false, why: `${record.field} is a list or comparison field, not what the record says is charged` };
    }
    if (!record.currency) {
      const hint = record.currencyHint;
      return {
        ok: false,
        why: hint
          ? `the record names no currency beside ${record.field}. ${hint.source} names ${hint.currency} for the same item (${hint.identity} at ${hint.at}) but does not carry ${record.amount}, so it says what units this item's prices are in, not that this is one of them`
          : `the record names no currency beside ${record.field}, so ${record.amount} could be any`
      };
    }
    if (record.currencyFrom) {
      return {
        ok: true,
        via: 'data-record-price',
        how: `${record.field} states it, and ${record.currencyFrom.source} carries the same amount for the same item (${record.currencyFrom.identity} at ${record.currencyFrom.at}) in ${record.currency}`
      };
    }
    return { ok: true, via: 'data-record-price', how: `${record.field} states it, in ${record.currency}` };
  }

  const dom = candidate.dom;

  /* a structured offer says it by being an offer: schema.org's price IS
     the amount charged, and an aggregate's range is not */
  if (!dom) {
    if (candidate.kind === 'range') {
      return { ok: false, why: `an aggregate offer spanning ${candidate.span[0]}–${candidate.span[1]} — a range is not a price this product is sold at` };
    }
    if (candidate.kind === 'meta') {
      return { ok: true, via: 'meta', how: `${candidate.from} states it` };
    }
    return { ok: true, via: 'json-ld-offer-price', how: 'the offer states it as its price' };
  }

  const own = String(dom.own || '');
  const near = String(dom.near || '');
  const text = String(candidate.text || '');

  if (dom.hidden) {
    return { ok: false, why: 'it is not rendered on screen — a hidden figure is a template or a hydration leftover, not what the shopper is charged' };
  }
  if (NOT_THE_PRODUCT.test(own) || NOT_THE_PRODUCT.test(text)) {
    return { ok: false, why: 'it is a shipping, promotion or basket total, not the product\'s own price' };
  }
  if (INSTALMENT.test(own) || INSTALMENT.test(near) || INSTALMENT.test(text)) {
    return { ok: false, why: 'it is a financing instalment, not the amount charged for the product' };
  }
  if (dom.lineThrough) {
    return { ok: false, why: 'it is struck through — that is the price this one is discounted from' };
  }
  if (LIST.test(own) && !CHARGED.test(own)) {
    return { ok: false, why: `the element is marked as the list price (${dom.own})` };
  }

  if (dom.itemprop === 'price' && dom.offerScope) {
    return { ok: true, via: 'microdata-offer-price', how: 'itemprop="price" inside the offer' };
  }
  if (CHARGED.test(own)) {
    return { ok: true, via: 'dom-role', how: `the element itself is marked ${own.match(CHARGED)[2]}` };
  }
  if (dom.aria && CHARGED.test(dom.aria)) {
    return { ok: true, via: 'aria', how: `its accessible name says ${dom.aria}` };
  }
  if (LIST.test(near) && !CHARGED.test(near)) {
    return { ok: false, why: `the block around it is marked as the list price (${near.slice(0, 60)})` };
  }
  if (CHARGED.test(near)) {
    return { ok: true, via: 'dom-role-block', how: `the price block it sits in is marked ${near.match(CHARGED)[2]}` };
  }

  return { ok: false, why: 'nothing on the element or its block says this is the amount charged' };
}

/* ---------- the decision ----------

   Fails closed on purpose. Zero survivors is "the page did not say".
   More than one distinct survivor is ALSO "the page did not say" — the
   five figures a group page renders, four of them marked current, are
   not an invitation to choose. */
function decide(candidates, productUrl) {
  const refusals = [];
  let survivors = [];

  for (const candidate of candidates) {
    const note = (gate, why) => refusals.push({
      amount: candidate.amount,
      currency: candidate.currency,
      text: candidate.text,
      from: candidate.from,
      gate,
      why,
      dom: explaining && candidate.dom ? candidate.dom : undefined
    });

    const identity = priceIdentity(candidate, productUrl);
    if (!identity.ok) { note('this', identity.why); continue; }

    const charged = chargedEvidence(candidate);
    if (!charged.ok) { note('charged', charged.why); continue; }

    survivors.push({ candidate, identity, charged });
  }

  /* ---- corroboration, before anything is ranked ----

     A record from the page's schema.org markup may confirm an amount
     that something the page actually prices from also carries. On its
     own it answers nothing: UNIQLO's @graph ProductGroup names
     E429066-000 and offers 7.90, the page charges something else, and
     "the id and the amount are in one record" was true the whole time.
     Carrying the product's id is what lets a record be considered, not
     what makes it true. */
  const authoritative = survivors.filter((s) => !s.candidate.record || s.candidate.record.authority !== 'markup');
  if (authoritative.length < survivors.length) {
    const backed = new Set(authoritative.map((s) => s.candidate.amount));
    const kept = [];
    for (const survivor of survivors) {
      const record = survivor.candidate.record;
      if (!record || record.authority !== 'markup' || backed.has(survivor.candidate.amount)) {
        kept.push(survivor);
        continue;
      }
      refusals.push({
        amount: survivor.candidate.amount,
        currency: survivor.candidate.currency,
        text: survivor.candidate.text,
        from: survivor.candidate.from,
        gate: 'corroboration',
        why: `only the page's schema.org markup says so (${record.source} at ${record.path}), and nothing the page prices from — no commerce API record, no hydrated state, no figure on the page — carries ${survivor.candidate.amount}`
      });
    }
    survivors = kept;
  }

  /* ---- and a record alone is still not the shop ----

     What is left may be nothing but payloads. A hydration blob is built
     from the same source as the markup beside it and inherits its
     staleness — UNIQLO's page carries 7.90 in both, and charges neither
     — so one agreeing with the other is one source speaking twice. A
     row is written from data only where the shop's own commerce data
     says the amount, or where the page draws it somewhere a shopper can
     see and it is tied to this product. */
  const drawn = survivors.filter((s) => !s.candidate.record);
  if (!drawn.length && survivors.length) {
    const commerce = survivors.filter((s) => s.candidate.record.authority === 'commerce-api');
    if (!commerce.length) {
      for (const survivor of survivors) {
        refusals.push({
          amount: survivor.candidate.amount,
          currency: survivor.candidate.currency,
          text: survivor.candidate.text,
          from: survivor.candidate.from,
          gate: 'authority',
          why: `it is only in the page's own payloads (${survivor.candidate.record.authority}) — no commerce API response carries it, and the page draws no figure tied to this product that does either`
        });
      }
      survivors = [];
    }
  }

  if (!survivors.length) return { refusals };

  /* Ranking, and the only ranking there is: WITHIN the rendered page, a
     figure tied to a named sku or to the variant the page has selected
     says which product's price it is, while one tied only to the group
     says which GROUP's — and a group prices every colour it contains.
     So the specific ones answer and the group-level ones step aside.

     A structured offer is deliberately NOT in this list. It is the
     retailer's own statement, but it comes from a different layer, and
     a record saying 98 while the screen says 58.50 is a disagreement
     about what a shopper pays rather than a tie to break in the
     record's favour. Two survivors that disagree, at the same rank or
     across layers, still fail closed. */
  const SPECIFIC = ['microdata-offer', 'dom-variant-scope'];
  const specific = survivors.filter((s) => SPECIFIC.includes(s.identity.via));
  let inPlay = survivors;

  if (specific.length && specific.length < survivors.length) {
    const better = specific[0].identity.how;
    for (const stepped of survivors) {
      if (SPECIFIC.includes(stepped.identity.via)) continue;
      refusals.push({
        amount: stepped.candidate.amount,
        currency: stepped.candidate.currency,
        text: stepped.candidate.text,
        from: stepped.candidate.from,
        gate: 'this',
        why: `tied only to the product group, while another figure is tied more exactly — ${better}`,
        dom: explaining && stepped.candidate.dom ? stepped.candidate.dom : undefined
      });
    }
    inPlay = specific;
  }

  const distinct = [...new Set(inPlay.map((s) => s.candidate.amount))];
  if (distinct.length > 1) {
    return {
      refusals,
      ambiguous: distinct.sort((a, b) => a - b),
      why: `${distinct.length} different amounts each carry evidence of being the charged price (${distinct.sort((a, b) => a - b).map((n) => '$' + n).join(', ')}), and nothing on the page says which one is`,
      survivors: inPlay.map((s) => ({
        amount: s.candidate.amount,
        from: s.candidate.from,
        text: s.candidate.text,
        identity: s.identity.how,
        charged: s.charged.how,
        dom: explaining && s.candidate.dom ? s.candidate.dom : undefined
      }))
    };
  }

  /* Which survivor gets RECORDED, when several agree on the amount.
     This does not choose an amount — that was settled above, and a
     disagreement still fails closed. It chooses which evidence the row
     will carry, and a chain that names the variant, the product and the
     currency is worth more on a shipped row than a record that merely
     held the number. */
  const STRENGTH = [
    'datalayer-variant-price', 'dom-variant-scope', 'microdata-offer',
    'json-ld-offer', 'data-variant-mapping', 'data-product-record', 'dom-product-scope'
  ];
  const strength = (survivor) => {
    const at = STRENGTH.indexOf(survivor.identity.via);
    return at < 0 ? STRENGTH.length : at;
  };
  const best = [...inPlay].sort((left, right) => strength(left) - strength(right))[0];
  return {
    refusals,
    price: best.candidate.amount,
    currency: best.candidate.currency,
    from: best.candidate.from,
    identity: best.identity,
    charged: best.charged,
    why: `${best.identity.how}, and ${best.charged.how}`,
    agreed: inPlay.length
  };
}

/* ---------- product records in a page's data ----------

   A product page ships its facts twice: once as the DOM a shopper
   reads, and once as the payload the page was built from — a
   __NEXT_DATA__ script, a hydration blob on window, an XHR to a
   commerce API. UNIQLO renders no figure that can be tied to E429066,
   so if it publishes a price at all, that second copy is where it is.

   The rule for reading it is the rule the DOM gates already use, and it
   is the only thing keeping this honest: the amount and the listing's
   own code have to be fields of the SAME product record. A document
   that mentions 429066 somewhere and 49.90 somewhere else says nothing
   — a catalogue response holds fifty products, and "both strings are in
   this file" is how the wrong one gets written. */

/* Keys arrive camelCased, snake_cased and dotted — productId, l1_id,
   communicationCode, basePrice. Matching a substring would take
   "candidate" for a code and "brandValue" for an amount, so a key is
   split into its words first and the words are what get matched. */
function keyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

const ID_WORD = /^(id|ids|code|codes|sku|skus|mpn|gtin|number|style|styles|l1|l2|communication|pid|product|item|key)$/;
const PRICE_WORD = /^(price|prices|amount|amounts)$/;

/* Words that turn a price-shaped key into something else entirely.
   priceValidUntil is the one that matters: "2024-03-31" parses as 2024,
   and an expiry date read as an amount is both a wrong price and a
   wrong reason to distrust the page. */
const NOT_PRICE_WORD = /^(valid|until|expire[sd]?|expiry|date|datetime|time|timestamp|updated|created|start|ends?|version|count|quantity|qty|stock|rating|score|reviews?|weight|length|width|height|percent|percentage|rate|ratio|index|position|type|label|text|display|format)$/;

/* a date is not an amount, whatever the key is called */
const DATEISH = /^\d{4}-\d{2}(-\d{2})?([T ]|$)|^\d{2}\/\d{2}\/\d{4}/;
const PRICE_KEY = /^(price|baseprice|base|current|currentprice|sale|saleprice|selling|sellingprice|promo|promoprice|amount|value|unitprice|min|max)$/i;

function isIdKey(key) {
  const words = keyWords(key);
  if (!words.length) return false;
  /* the last word decides. item_id and item_product_id are
     identifiers; item_name is a name that happens to start with the
     same word, and counting it made every analytics item look like it
     carried four ids. */
  return ID_WORD.test(words[words.length - 1]);
}

function isPriceKey(key) {
  const words = keyWords(key);
  if (words.some((word) => NOT_PRICE_WORD.test(word))) return false;
  if (PRICE_KEY.test(key)) return true;
  return words.some((word) => PRICE_WORD.test(word));
}
const LIST_KEY = /(list|was|original|orig|msrp|compare|strike|regular|standard|previous|before|max)/i;
const ELSEWHERE_KEY = /(recommend|related|carousel|also|similar|crosssell|cross_sell|upsell|up_sell|viewed|bundle|outfit|complete|youmay|coordinate)/i;
const CURRENCY_KEY = /currenc/i;
const VARIANT_KEY = /(variant|colou?r|communication|sku|size|choice|l1|l2)/i;

/* every object in a structure, with the path that reached it. Bounded,
   because a hydration blob can be enormous and a diagnostic that hangs
   is not a diagnostic. */
function walkData(value, visit) {
  const seen = new Set();
  const budget = { left: 40000 };
  const step = (node, path) => {
    if (!node || typeof node !== 'object' || budget.left <= 0 || seen.has(node)) return;
    seen.add(node);
    budget.left -= 1;
    visit(node, path);
    if (Array.isArray(node)) {
      for (let at = 0; at < node.length; at += 1) step(node[at], path.concat(`[${at}]`));
    } else {
      for (const key of Object.keys(node)) step(node[key], path.concat(key));
    }
  };
  step(value, []);
  return budget.left <= 0;
}

/* the values in THIS object that look like identifiers, and whether one
   of them is the listing's own code */
function namesListing(node, ids) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  for (const key of Object.keys(node)) {
    if (!isIdKey(key)) continue;
    const raw = node[key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const text = String(value);
      if (text.length > 64) continue;
      for (const id of ids) {
        if (namesCode(text, id)) return { key, value: text, id };
      }
    }
  }
  return null;
}

function currencyNear(node) {
  if (!node || typeof node !== 'object') return null;
  for (const key of Object.keys(node)) {
    if (!CURRENCY_KEY.test(key)) continue;
    const found = currencyIn(node[key]);
    if (found) return found;
  }
  return null;
}

function variantsIn(node) {
  const out = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const key of Object.keys(node)) {
    if (!VARIANT_KEY.test(key)) continue;
    const raw = node[key];
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      const text = String(value).trim();
      if (text.length >= 3 && text.length <= 64 && /\d/.test(text)) out.push({ key, value: text });
    }
  }
  return out;
}

/* the amounts inside ONE record, shallow, and never through a key that
   holds other products — a "recommended" array under a product record
   is a different product's price sitting in this one's subtree */
function pricesUnder(node, inherited) {
  const out = [];
  const step = (value, path, depth, currency) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    const here = currencyNear(value) || currency;
    const label = (key) => (Array.isArray(value) ? `[${key}]` : key);
    for (const key of Object.keys(value)) {
      if (ELSEWHERE_KEY.test(key)) continue;
      const child = value[key];
      if (child && typeof child === 'object') { step(child, path.concat(label(key)), depth + 1, here); continue; }
      if (!isPriceKey(key)) continue;
      if (typeof child === 'string' && DATEISH.test(child.trim())) continue;
      const amount = toAmount(child);
      if (amount === null) continue;
      const at = path.concat(label(key));
      /* what the object holding the amount says ABOUT the amount: an
         offer that expired last spring, or one marked out of stock, is
         still a number in a record naming the product */
      const context = {};
      for (const sibling of Object.keys(value)) {
        const raw = value[sibling];
        if (typeof raw !== 'string' && typeof raw !== 'number') continue;
        if (/valid|until|expire/i.test(sibling)) context.validUntil = String(raw).slice(0, 40);
        else if (/availab|stock/i.test(sibling)) context.availability = String(raw).slice(0, 60);
      }

      out.push({
        path: at,
        field: at.join('.'),
        amount,
        currency: here || null,
        kind: at.some((segment) => LIST_KEY.test(segment)) ? 'list' : 'price',
        context
      });
    }
  };
  step(node, [], 0, inherited || currencyNear(node));
  return out;
}

/* Every place in one payload where this listing's code and an amount
   are fields of the same record. `elsewhere` marks a hit that was found
   under a recommendation key — kept so the diagnostic can show it was
   seen and set aside, never offered as a candidate. */
function productRecords(value, ids, source) {
  const hits = [];
  const already = new Set();
  if (!ids || !ids.length) return hits;

  walkData(value, (node, path) => {
    if (Array.isArray(node)) return;

    /* A record is identified by its fields — or by the key it is filed
       under. UNIQLO's l2s response keeps prices in a map whose keys ARE
       the variant ids: result.prices["438783-COL09-004"].base.value.
       The key is the identity there, and reading only fields would miss
       every price the endpoint publishes. */
    let named = namesListing(node, ids);
    if (!named && path.length) {
      const key = String(path[path.length - 1]);
      for (const id of ids) {
        if (namesCode(key, id)) { named = { key: '(map key)', value: key, id }; break; }
      }
    }
    if (!named) return;
    const elsewhere = path.find((segment) => ELSEWHERE_KEY.test(segment)) || null;

    for (const price of pricesUnder(node)) {
      /* a group record and the variant inside it reach the same field;
         it is one amount in one place, so it is reported once */
      const at = [...path, ...price.path].join('.');
      const once = `${at}|${price.amount}`;
      if (already.has(once)) continue;
      already.add(once);

      hits.push({
        source: source || 'data',
        authority: sourceAuthority(source),
        recordPath: path.join('.') || '(root)',
        path: [...path, ...price.path].join('.'),
        code: named.value,
        codeKey: named.key,
        field: price.field,
        amount: price.amount,
        currency: price.currency,
        kind: price.kind,
        context: price.context || {},
        variants: variantsIn(node).map((v) => v.value).slice(0, 6),
        elsewhere
      });
    }
  });
  return hits;
}

/* ---------- how much a payload's word is worth ----------

   Not every record is the page's own answer about what it charges.

     commerce-api   JSON the page fetched to build itself — the request
                    a shopper's browser makes to find out the price
     app-state      the payload the page hydrated from: __NEXT_DATA__,
                    a blob on window. The page renders from this.
     markup         schema.org in a <script type="application/ld+json">.
                    It is there for crawlers. Nothing on the page reads
                    it, nothing breaks when it goes stale, and a
                    ProductGroup whose hasVariant[].offers.price says
                    7.90 on a page that charges something else is the
                    ordinary condition of SEO metadata rather than a bug
                    in the reader.

   The tier is not a preference between amounts. It decides which
   sources may ANSWER and which may only agree: see decide(). */
function sourceAuthority(source) {
  const text = String(source || '');
  if (/^network /i.test(text)) {
    return /\/api\/|graphql|\/commerce\/|price|l2s|sku|inventory|product/i.test(text) ? 'commerce-api' : 'app-state';
  }
  if (/^window\./i.test(text)) return 'app-state';
  if (/ld\+json/i.test(text)) return 'markup';
  return 'app-state';
}

/* JSON as a page actually ships it: a bare document, or an assignment
   with something around it. Anything that will not parse is left alone
   rather than guessed at. */
function parseLoosely(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  /* Markup is not a payload. An endpoint that answers with a page — a
     bot wall, a redirect to the listing, a 404 — hands back HTML whose
     only braces may be its JSON-LD block, and carving that out would
     report the PAGE's schema.org as the ENDPOINT's answer. That is how
     a 7.90 written for crawlers ends up wearing a commerce API's
     authority. Anything that starts as markup is refused here. */
  if (raw[0] === '<') return null;

  try { return JSON.parse(raw); } catch (err) { /* not a bare document */ }

  /* an assignment — window.__STATE__ = {...}; — and nothing looser.
     A document is parsed whole or not at all. */
  const assigned = raw.match(/^[^{<]{0,200}=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (assigned) {
    try { return JSON.parse(assigned[1]); } catch (err) { /* not JSON either */ }
  }
  return null;
}

/* schema.org is schema.org wherever it is served from. A page's JSON-LD
   reached through a URL that looks like an API is still markup, and
   must not inherit the authority of the endpoint that returned it. */
function looksLikeSchemaOrg(value) {
  if (!value || typeof value !== 'object') return false;
  const context = String(value['@context'] || '');
  if (/schema\.org/i.test(context)) return true;
  if (Array.isArray(value['@graph'])) return true;
  return typeof value['@type'] === 'string' && Boolean(value['@context']);
}

/* the payloads a rendered page carried, each with a name that says
   where it came from */
function dataPayloads(data) {
  const out = [];
  if (!data) return out;
  for (const script of data.scripts || []) {
    const value = parseLoosely(script.text);
    if (value) out.push({ source: `script${script.id ? '#' + script.id : ''}${script.type ? ` [${script.type}]` : ''}`, value });
  }
  for (const entry of data.state || []) {
    const value = parseLoosely(entry.text);
    if (value) out.push({ source: `window.${entry.key}`, value });
  }
  for (const response of data.responses || []) {
    const value = parseLoosely(response.text);
    if (value) out.push({ source: `network ${response.url}`, value, markup: looksLikeSchemaOrg(value) });
  }
  return out;
}

/* ---------- the colour a price is actually kept under ----------

   A retailer that prices by colour keeps the amount on the variant, not
   on the product: the product record names E429066-000 and lists its
   colour codes, and a second record prices one of those colours. Read
   separately, neither one says what this listing costs. Read as the
   chain they are — product names variant, variant carries price — they
   do, and the chain is what gets recorded so a row can be re-proved.

   The first link has to be a record naming THIS listing. A colour code
   picked up anywhere else would tie a price to nothing. */
function variantPriceRecords(payloads, ids) {
  const owners = [];
  const wanted = new Set();

  for (const payload of payloads) {
    walkData(payload.value, (node, path) => {
      if (Array.isArray(node)) return;
      const named = namesListing(node, ids);
      if (!named) return;
      if (path.some((segment) => ELSEWHERE_KEY.test(segment))) return;
      for (const variant of variantsIn(node)) {
        if (ids.some((id) => namesCode(variant.value, id))) continue; // that is the listing itself
        wanted.add(variant.value);
        owners.push({
          source: payload.source,
          path: path.join('.') || '(root)',
          listing: named.value,
          listingKey: named.key,
          variant: variant.value,
          variantKey: variant.key,
          fields: idFieldsOf(node)
        });
      }
    });
  }

  const priced = [];
  if (wanted.size) {
    const codes = [...wanted];
    for (const payload of payloads) {
      for (const hit of productRecords(payload.value, codes, payload.source)) {
        if (ids.some((id) => namesCode(hit.code, id))) continue; // already a direct hit
        priced.push(hit);
      }
    }
  }
  return { variants: [...wanted], owners, priced };
}

/* The other identifiers a page gives this same product. UNIQLO's page
   calls the sweater 438783 and 429066 both — a legacy code in the URL
   and a current one in the data — and knowing that is what lets an API
   response be searched for the identity the API actually uses. */
function relatedIdentifiers(payloads, ids) {
  const found = new Map();
  for (const payload of payloads) {
    walkData(payload.value, (node, path) => {
      if (Array.isArray(node)) return;
      if (!namesListing(node, ids)) return;
      if (path.some((segment) => ELSEWHERE_KEY.test(segment))) return;
      for (const key of Object.keys(node)) {
        if (!isIdKey(key)) continue;
        const raw = node[key];
        for (const value of Array.isArray(raw) ? raw : [raw]) {
          if (typeof value !== 'string' && typeof value !== 'number') continue;
          const text = String(value).trim();
          if (!text || text.length > 64 || !/\d/.test(text)) continue;
          if (ids.some((id) => namesCode(text, id))) continue;
          if (!found.has(text)) found.set(text, []);
          const where = found.get(text);
          if (where.length < 3) where.push({ source: payload.source, path: path.join('.') || '(root)', key });
        }
      }
    });
  }
  return [...found.entries()].map(([code, where]) => ({ code, where }));
}

/* Why a markup offer should or should not be believed, in the terms the
   markup itself provides. */
function markupAudit(hits, corroborated, now) {
  const when = Number.isFinite(now) ? now : Date.now();
  return hits.filter((hit) => hit.authority === 'markup').map((hit) => {
    const notes = [];
    const context = hit.context || {};

    if (context.validUntil) {
      const until = Date.parse(context.validUntil);
      notes.push(Number.isFinite(until) && until < when
        ? `priceValidUntil ${context.validUntil} is in the past — this offer has expired`
        : `priceValidUntil ${context.validUntil}`);
    }
    if (context.availability && /outofstock|discontinued|soldout|backorder/i.test(context.availability)) {
      notes.push(`availability says ${context.availability}`);
    }
    if (!hit.currency) notes.push('no currency is named beside the amount');
    if (/hasvariant/i.test(hit.path)) {
      notes.push('the amount sits on a variant inside the group, not on the group record itself');
    }
    notes.push(corroborated.has(hit.amount)
      ? 'corroborated: something the page prices from carries the same amount'
      : 'NOT corroborated: nothing the page prices from carries this amount');

    return { amount: hit.amount, currency: hit.currency, source: hit.source, path: hit.path, notes };
  });
}

/* ---------- a currency kept in a different record ----------

   An amount with no currency beside it is refused, and it should be:
   7.9 could be anything. But a page often keeps the currency one
   record away — a commerce API prices a variant and says nothing about
   units, while the analytics event for that same variant names USD.

   That is evidence, not an assumption, PROVIDED the other record is
   about the same thing. So the tie is by identity, and it comes in two
   strengths, which are reported separately because they are not worth
   the same:

     amount-and-identity   the other record names this item AND carries
                           this same amount, with a currency. It is the
                           same price, said twice, once with units.
     identity              the other record names this item and a
                           currency, but not this amount. It says what
                           units this item's prices are in, without
                           saying this is one of them.

   Only the first is allowed to fill in a missing currency. The second
   is reported so a person can see it and decide, and the gate stays
   closed. Markup is never a source of either: it is not what the page
   prices from. */
function identitiesOf(record) {
  const out = [];
  if (!record) return out;
  for (const value of [record.code, record.variant, record.mappedFrom && record.mappedFrom.variant]) {
    const text = String(value || '').trim();
    if (text) out.push(text);
  }
  return [...new Set(out)];
}

/* the identifiers one record carries, which is what a chain is made of */
function idFieldsOf(node) {
  const out = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const key of Object.keys(node)) {
    const raw = node[key];
    if ((typeof raw === 'string' || typeof raw === 'number') && isIdKey(key)) {
      const value = String(raw).trim();
      if (value && value.length <= 64) out.push({ key, value });
    }
  }
  return out;
}

function currencyByIdentity(record, payloads, options) {
  const wanted = identitiesOf(record);
  if (!wanted.length) return null;

  const amount = record.amount;
  let weaker = null;

  const codes = wanted.map((code) => code.toLowerCase());

  for (const payload of payloads || []) {
    if (payload.markup) continue; // markup does not get to name the units either
    let found = null;

    /* walked with the ancestors in hand, because an analytics event
       keeps the currency one level above the item it applies to:
       ecommerce.currency covers ecommerce.items[]. A currency on the
       record itself is preferred; the nearest one above it counts, and
       the report says which it was. */
    const step = (node, path, above) => {
      if (found || !node || typeof node !== 'object') return;
      const here = above.concat([{ node, path }]);

      if (!Array.isArray(node) && !path.some((segment) => ELSEWHERE_KEY.test(String(segment)))) {
        const named = namesListing(node, codes);
        const filed = path.length ? String(path[path.length - 1]) : '';
        const byKey = !named && wanted.some((code) => namesCode(filed, code));

        /* A lender that says this variant belongs to a DIFFERENT
           product is not a second opinion about units, it is a
           contradiction about identity. It lends nothing. */
        const fields = idFieldsOf(node);
        const productish = fields.filter((field) => /product/i.test(field.key));
        const listing = (options && options.ids) || [];
        const contradicts = listing.length && productish.length
          && !productish.some((field) => matchingCode([field.value], listing));

        if ((named || byKey) && !contradicts) {
          let currency = null;
          for (let up = here.length - 1; up >= 0; up -= 1) {
            const carried = currencyNear(here[up].node);
            if (carried) {
              currency = { value: carried, at: here[up].path.join('.') || '(root)', own: up === here.length - 1 };
              break;
            }
          }

          if (currency) {
            const mine = {
              currency: currency.value,
              source: payload.source,
              at: path.join('.') || '(root)',
              currencyAt: currency.at,
              onRecord: currency.own,
              identity: named ? `${named.key}=${named.value}` : `(map key) ${filed}`,
              amounts: pricesUnder(node).map((price) => price.amount),
              /* what this record calls the thing it is about, and whether
                 it is an analytics event — the one place a page names the
                 variant, the product and the currency together */
              fields,
              analytics: /datalayer/i.test(payload.source)
            };

            if (mine.amounts.some((carried) => Math.abs(carried - amount) < 1e-9)) {
              mine.via = 'amount-and-identity';
              found = mine;
              return;
            }
            if (!weaker) {
              mine.via = 'identity';
              weaker = mine;
            }
          }
        }
      }

      const keys = Array.isArray(node) ? node.map((ignored, at) => at) : Object.keys(node);
      for (const key of keys) {
        const child = node[key];
        if (child && typeof child === 'object') step(child, path.concat(Array.isArray(node) ? `[${key}]` : key), here);
        if (found) return;
      }
    };

    step(payload.value, [], []);
    if (found) return found;
  }

  if (weaker && options && options.weak) return weaker;
  return weaker ? Object.assign({}, weaker, { onlyWeak: true }) : null;
}

function dataCandidates(data, pageUrl) {
  const ids = identifiersFrom(pageUrl);
  const payloads = dataPayloads(data);
  const out = [];

  const withCurrency = (hit) => {
    if (hit.currency) return hit;
    const borrowed = currencyByIdentity(hit, payloads, { ids });
    if (!borrowed) return hit;
    if (borrowed.onlyWeak) {
      hit.currencyHint = borrowed; // reported, never used
      return hit;
    }
    hit.currency = borrowed.currency;
    hit.currencyFrom = borrowed;
    return hit;
  };

  for (const payload of payloads) {
    for (const hit of productRecords(payload.value, ids, payload.source)) {
      if (hit.elsewhere) continue; // seen, set aside, never a candidate
      if (payload.markup) hit.authority = 'markup';
      withCurrency(hit);
      out.push({
        amount: hit.amount,
        currency: hit.currency,
        text: `${hit.field} = ${hit.amount}`,
        from: `data ${hit.source}`,
        kind: 'data',
        record: hit
      });
    }
  }

  const mapped = variantPriceRecords(payloads, ids);
  const already = new Set(out.map((candidate) => `${candidate.record.source}|${candidate.record.path}`));
  for (const hit of mapped.priced) {
    if (hit.elsewhere) continue;
    /* a record that names both the listing and its own colour code is
       already a direct hit; reaching it again through the mapping would
       report one amount as two findings */
    if (already.has(`${hit.source}|${hit.path}`)) continue;
    const owner = mapped.owners.find((entry) => entry.variant === hit.code);
    if (!owner) continue;
    withCurrency(hit);
    out.push({
      amount: hit.amount,
      currency: hit.currency,
      text: `${hit.field} = ${hit.amount}`,
      from: `data ${hit.source} via variant ${hit.code}`,
      kind: 'data',
      record: Object.assign({}, hit, { mappedFrom: owner })
    });
  }

  return out;
}

/* ---------- what the rendered page says about its prices ----------

   This runs inside the page, so it sees the figures the scripts put on
   the screen. It reports the price ELEMENT, not the page's text: the
   element's own words, what it is marked as, whether it is struck
   through, and the ancestry above it — because the ancestry is the only
   thing on a rendered page that can say whose price this is.

   The innermost element wins: only text nodes belonging to the element
   itself are read, so a wrapper holding four prices is not reported as
   one figure, and each of its four children is reported on its own. */
function gatherPricesInPage(wanted) {
  const MONEY = /(?:US\s*\$|\$|USD|£|€)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;
  const CODE_ATTR = /(product|prod|sku|pid|style|item|code|group|listing|variant|colou?r|option|article)/i;

  const marks = (el) => [
    el.id || '',
    el.getAttribute('class') || '',
    el.getAttribute('data-testid') || '',
    el.getAttribute('data-test') || '',
    el.getAttribute('data-role') || '',
    el.getAttribute('itemprop') || ''
  ].filter(Boolean).join(' ').trim();

  /* An attribute value only counts as a product code if it could be
     one. Every element has an id, and "app", "root" and "main" are not
     products — collecting them makes the report claim a price block
     names a product when it names nothing at all. A code carries a
     digit: E429066-000, AU763, 129244. */
  const looksLikeCode = (value) => value.length >= 3 && value.length <= 64 && /\d/.test(value);

  const codesOn = (el) => {
    const out = [];
    for (const attr of Array.from(el.attributes || [])) {
      const name = attr.name.toLowerCase();
      const value = (attr.value || '').trim();
      if (!looksLikeCode(value)) continue;
      if (name === 'id' || name === 'itemid' || (name.indexOf('data-') === 0 && CODE_ATTR.test(name))) out.push(value);
    }
    return out;
  };

  const struck = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 4; depth += 1) {
      const tag = node.tagName;
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') return true;
      const style = window.getComputedStyle(node);
      const line = (style && (style.textDecorationLine || style.textDecoration)) || '';
      if (line.indexOf('line-through') >= 0) return true;
      node = node.parentElement;
    }
    return false;
  };

  const shortSelector = (el) => {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  };

  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!own || own.length > 60 || !MONEY.test(own)) continue;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const chain = [];
    const codes = codesOn(el);
    const scopeSkus = [];
    let codeLabel = codes.length ? shortSelector(el) : null;
    let offerScope = Boolean(el.closest('[itemtype*="Offer" i]'));
    let near = '';

    let node = el.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 12; depth += 1) {
      const itemtype = node.getAttribute('itemtype') || '';
      if (/offer/i.test(itemtype)) offerScope = true;
      if (/product/i.test(itemtype)) {
        for (const named of node.querySelectorAll('[itemprop="sku"],[itemprop="productID"],[itemprop="mpn"]')) {
          const value = named.getAttribute('content') || named.textContent || '';
          if (value.trim()) scopeSkus.push(value.trim().slice(0, 64));
        }
      }
      const found = codesOn(node);
      if (found.length) {
        for (const code of found) codes.push(code);
        if (!codeLabel) codeLabel = shortSelector(node);
      }
      if (depth < 3) near += ' ' + marks(node);
      chain.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        cls: node.getAttribute('class') || null,
        testid: node.getAttribute('data-testid') || null,
        role: node.getAttribute('role') || null,
        aria: node.getAttribute('aria-label') || null,
        itemprop: node.getAttribute('itemprop') || null,
        itemtype: itemtype || null,
        codes: found.length ? found : undefined
      });
      node = node.parentElement;
    }

    out.push({
      text: own,
      selector: shortSelector(el),
      own: marks(el),
      near: near.trim(),
      aria: el.getAttribute('aria-label') || null,
      itemprop: el.getAttribute('itemprop') || null,
      content: el.getAttribute('content') || null,
      offerScope,
      codes,
      codeLabel,
      scopeSkus,
      lineThrough: struck(el),
      hidden: rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || style.display === 'none',
      area: Math.round(rect.width * rect.height),
      chain
    });
  }

  /* Where this listing's own code appears in the DOM AT ALL.

     When no figure can be tied to the product, the next question is
     always the same one: does the page name this product anywhere, and
     is there money inside the thing that names it? An element carrying
     E429066-000 whose subtree holds a figure IS the product's price
     block; no such element anywhere means no figure on this page can be
     tied by ancestry, and the answer has to come from somewhere else.
     Answering that takes a search the gates never do, so it is done
     here, where the DOM is. */
  const codeSites = [];
  const looking = Array.isArray(wanted) ? wanted.map((code) => String(code).toLowerCase()) : [];
  if (looking.length) {
    for (const el of document.querySelectorAll('body *')) {
      const attrs = Array.from(el.attributes || [])
        .map((a) => a.name + '="' + a.value + '"').join(' ');
      const flat = attrs.toLowerCase();
      const hit = looking.find((code) => flat.indexOf(code) >= 0);
      if (!hit) continue;
      const inside = (el.textContent || '').match(new RegExp(MONEY.source, 'ig')) || [];
      codeSites.push({
        selector: shortSelector(el),
        code: hit,
        attrs: attrs.slice(0, 240),
        money: inside.slice(0, 8),
        depth: (function () { let d = 0, n = el; while (n && n !== document.body) { d += 1; n = n.parentElement; } return d; })()
      });
      if (codeSites.length >= 30) break;
    }
  }

  const metas = {};
  for (const el of document.querySelectorAll('meta[property], meta[name]')) {
    const key = el.getAttribute('property') || el.getAttribute('name');
    if (key) metas[key.toLowerCase()] = el.getAttribute('content');
  }

  /* What the page has SELECTED. A group page prices several variants at
     once — J.Crew's AU763 renders a figure per colour — and only the
     selected variant's figure is the price being offered for what the
     shopper is looking at. The selection is read off the page's own
     state (a checked input, an aria-selected swatch) and off the URL
     the page was opened with, never guessed from position. */
  const selected = { codes: [], from: [], ignored: [] };
  const SELECTED_BY = [
    '[aria-selected="true"]', '[aria-checked="true"]', '[aria-current="true"]',
    '[aria-current="page"]', '[data-selected="true"]', '[class*="is-selected" i]',
    'input:checked', 'option:checked'
  ];

  /* A cookie wall is full of checked boxes, and every one of them has an
     id. OneTrust's are ot-group-id-C0004 and friends — checked, code
     shaped, and about advertising cookies rather than about a jumper.
     Read as a selected variant they are worse than noise: they are a
     code that could upgrade some unrelated figure to "the variant the
     page has selected". So the consent widget is not a place where a
     variant can be chosen, and anything found there is recorded as
     ignored rather than silently dropped. */
  const CONSENT_SCOPE = '#onetrust-consent-sdk, #onetrust-banner-sdk, #ot-sdk-container,'
    + ' [class*="onetrust" i], [class*="ot-sdk" i], [id*="cookie" i], [class*="cookie" i],'
    + ' [id*="consent" i], [class*="consent" i], [id*="privacy" i], [class*="privacy" i],'
    + ' [id*="gdpr" i], [class*="gdpr" i]';
  const CONSENT_CODE = /^(ot-|c000\d$|optanon)/i;

  const remember = (code, where, el) => {
    const value = String(code || '').trim();
    if (!looksLikeCode(value)) return;
    const consentish = CONSENT_CODE.test(value)
      || (el && (el.closest(CONSENT_SCOPE) || (el.id || '').toLowerCase().indexOf('ot-') === 0));
    if (consentish) {
      selected.ignored.push({ code: value, why: 'it belongs to the cookie consent widget, not to a product' });
      return;
    }
    selected.codes.push(value);
    selected.from.push(where);
  };
  for (const selector of SELECTED_BY) {
    for (const el of Array.from(document.querySelectorAll(selector)).slice(0, 20)) {
      for (const code of codesOn(el)) remember(code, selector, el);
      remember(el.getAttribute('value'), selector + ' [value]', el);
      remember(el.getAttribute('data-value'), selector + ' [data-value]', el);
      remember(el.getAttribute('data-code'), selector + ' [data-code]', el);
    }
  }
  try {
    for (const [key, value] of new URLSearchParams(location.search)) {
      if (/colou?r|variant|sku|product|style|item/i.test(key)) remember(value, 'url:' + key, null);
    }
  } catch (err) { /* a URL with no query is not a problem */ }
  selected.codes = Array.from(new Set(selected.codes));
  selected.ignored = selected.ignored.filter((entry, at, all) => all.findIndex((e) => e.code === entry.code) === at);

  return {
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || metas['og:url'] || null,
    metas,
    selected,
    codeSites,
    jsonld: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent),
    prices: out
  };
}

/* What the page carries BESIDES its DOM: the scripts it shipped, the
   application state it left on window, and the resources it fetched.
   Runs inside the page, like the price gatherer, and caps everything it
   returns — a hydration blob can be megabytes, and a diagnostic that
   cannot be printed is not much use. */
function gatherDataInPage(wanted) {
  const codes = (wanted || []).map((code) => String(code).toLowerCase());
  const CAP = 400000;
  const mentions = (text) => codes.filter((code) => text.toLowerCase().indexOf(code) >= 0);

  const scripts = [];
  for (const el of Array.from(document.querySelectorAll('script')).slice(0, 120)) {
    const text = el.textContent || '';
    if (!text && !el.getAttribute('src')) continue;
    scripts.push({
      id: el.id || null,
      type: el.getAttribute('type') || null,
      src: el.getAttribute('src') || null,
      length: text.length,
      mentions: mentions(text),
      text: text.length <= CAP ? text : text.slice(0, CAP)
    });
  }

  /* application state, where it can be read at all. Some of these are
     getters that throw, some are the window itself, and some are large
     enough to be worth refusing. */
  const SKIP = ['window', 'self', 'top', 'parent', 'frames', 'document', 'location', 'navigator'];
  const INTERESTING = /(^__|^_?initial|state|store|data|props|apollo|redux|nuxt|next|preload|context|product|commerce)/i;
  const state = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    if (SKIP.indexOf(key) >= 0 || !INTERESTING.test(key)) continue;
    let value;
    try { value = window[key]; } catch (err) { continue; }
    if (!value || typeof value !== 'object') continue;

    let text = null;
    try {
      const marked = new WeakSet();
      text = JSON.stringify(value, function (k, v) {
        if (typeof v === 'function') return undefined;
        if (v && typeof v === 'object') {
          if (marked.has(v)) return '[circular]';
          marked.add(v);
        }
        return v;
      });
    } catch (err) { continue; }
    if (!text || text.length < 8) continue;
    state.push({ key, length: text.length, mentions: mentions(text), text: text.slice(0, CAP) });
    if (state.length >= 25) break;
  }

  /* dataLayer explicitly, because an analytics event is often the only
     place a page says what currency its prices are in */
  if (!state.some((entry) => /datalayer/i.test(entry.key))) {
    try {
      const layer = window.dataLayer;
      if (Array.isArray(layer)) {
        const marked = new WeakSet();
        const text = JSON.stringify(layer, function (k, v) {
          if (typeof v === 'function') return undefined;
          if (v && typeof v === 'object') {
            if (marked.has(v)) return '[circular]';
            marked.add(v);
          }
          return v;
        });
        if (text) state.push({ key: 'dataLayer', length: text.length, mentions: mentions(text), text: text.slice(0, CAP) });
      }
    } catch (err) { /* a page without one is the common case */ }
  }

  const resources = performance.getEntriesByType('resource').slice(0, 300).map((entry) => ({
    name: entry.name,
    kind: entry.initiatorType,
    bytes: Math.round(entry.transferSize || 0),
    ms: Math.round(entry.duration)
  }));

  return { scripts, state, resources };
}

/* the rendered page's candidates: its hydrated structured record first,
   because a record that names a sku beats a figure that has to be placed
   by its ancestry, then the figures themselves */
function renderedCandidates(seen, pageUrl) {
  const nodes = [];
  for (const block of seen.jsonld || []) nodes.push(...parseLdBlock(block));
  const structured = structuredCandidates(nodes);

  const out = [];
  for (const candidate of structured.candidates) {
    out.push(Object.assign({}, candidate, { from: `${candidate.from} (rendered)`, canonical: seen.canonical || null }));
  }
  /* the payload the page was built from, where it carried one: a record
     naming this listing AND an amount, in the same record */
  for (const candidate of dataCandidates(seen.data, pageUrl)) out.push(candidate);

  for (const hit of seen.prices || []) {
    const money = moneyInText(hit.text);
    if (!money) continue;
    out.push({
      amount: money.amount,
      currency: money.currency,
      text: hit.text,
      from: `rendered ${hit.selector}`,
      kind: 'rendered',
      dom: hit,
      selected: seen.selected || null,
      canonical: seen.canonical || null
    });
  }
  return { candidates: out, empties: structured.empties };
}

/* One page, in a real browser, reported the way fetchPage reports. */
async function renderPage(url, wanted, options) {
  const chromium = loadPlaywright();
  if (!chromium) return { failed: 'Playwright is not installed here, so the browser path is unavailable', noBrowser: true };

  const launch = { args: ['--disable-blink-features=AutomationControlled'] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;

  let browser;
  try {
    browser = await chromium.launch(launch);
  } catch (err) {
    return { failed: `Chromium would not start (${err && err.message ? err.message.split('\n')[0] : 'unknown'})`, noBrowser: true };
  }

  try {
    const context = await browser.newContext({
      userAgent: BROWSER['User-Agent'],
      locale: 'en-US',
      viewport: { width: 1400, height: 1000 }
    });
    const page = await context.newPage();

    /* The JSON the page fetches while it builds itself. Bodies are read
       later, together, because reading one inside the handler blocks
       the response it is reading. */
    const pending = [];
    if (!options || options.data !== false) {
      page.on('response', (response) => {
        try {
          const wide = options && options.capture === 'all';
          if (pending.length >= (wide ? 150 : 80) || response.status() !== 200) return;
          const type = response.headers()['content-type'] || '';
          const at = response.url();
          const jsonish = /json/i.test(type) || /\.json(\?|$)|\/api\/|graphql/i.test(at);
          /* a hunt reads everything text-shaped, because an amount can
             be sitting in a bundle or an HTML fragment rather than in
             the tidy JSON an ordinary read looks for */
          const textish = wide && /json|javascript|text|xml/i.test(type);
          if (!jsonish && !textish) return;
          pending.push({
            url: at,
            type: type.split(';')[0],
            kind: response.request().resourceType(),
            body: response.text().catch(() => null)
          });
        } catch (err) { /* a response that cannot be described is skipped */ }
      });
    }

    let status = null;
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT });
      status = response ? response.status() : null;
    } catch (err) {
      await browser.close();
      return { failed: `the browser could not open the page (${String(err.message).split('\n')[0]})` };
    }

    /* a price is one of the last things a product page fills in, because
       it waits on inventory: the wait is for the figure, not the markup */
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const consent = await dismissConsent(page);
    if (consent) await page.waitForTimeout(800);
    await coaxLazyImages(page);

    const codes = wanted || identifiersFrom(url);
    const seen = await page.evaluate(gatherPricesInPage, codes);

    if (!options || options.data !== false) {
      const responses = [];
      for (const entry of pending) {
        const text = await entry.body;
        if (!text || text.length > 3000000) continue;
        responses.push({
          url: entry.url,
          type: entry.type,
          kind: entry.kind,
          length: text.length,
          mentions: codes.filter((code) => text.toLowerCase().indexOf(String(code).toLowerCase()) >= 0),
          text
        });
      }
      const carried = await page.evaluate(gatherDataInPage, codes);
      seen.data = Object.assign({ responses }, carried);
    }

    await browser.close();

    if (status && status >= 400) return { failed: `the page answered ${status} to a real browser too` };
    return { seen };
  } catch (err) {
    await browser.close().catch(() => {});
    return { failed: `the browser path failed (${err && err.message ? String(err.message).split('\n')[0] : 'unknown'})` };
  }
}

/* ---------- one row ---------- */
async function resolveRow(row) {
  const notes = [];
  const trail = { id: row.id, productUrl: row.productUrl, readThrough: null, plain: null, browser: null };

  /* Every capture says which layer answered it, and one that never
     reached the browser says so IN THE CAPTURE. A file holding only the
     served markup reads exactly like a page that renders no price, and
     those are not the same finding: the first is a run that stopped
     early, the second is evidence. Nothing about the rendered page may
     be concluded from a capture whose browser never ran. */
  const finish = (result, readThrough, browserSkipped) => {
    trail.readThrough = readThrough;
    if (!trail.browser) trail.browser = { ran: false, why: browserSkipped || 'it was not reached' };
    return Object.assign({ id: row.id, notes, trail }, result);
  };

  /* ---- plain HTTP ---- */
  const page = await fetchPage(row.productUrl);
  let served = null;

  if (page.html) {
    const read = pricesFromHtml(page.html);
    for (const candidate of read.candidates) candidate.canonical = read.canonical;
    trail.plain = {
      reachable: true,
      canonical: read.canonical,
      candidates: read.candidates.map(reportable),
      empties: read.empties
    };
    notes.push(`plain HTTP: ${read.candidates.length} price candidate${read.candidates.length === 1 ? '' : 's'}`);
    for (const empty of read.empties) {
      notes.push(`plain HTTP: ${empty.type}${empty.skus.length ? ` ${empty.skus[0]}` : ''} — ${empty.why}`);
    }

    if (read.candidates.length) {
      served = decide(read.candidates, row.productUrl);
      if (served.price) {
        return finish(
          { verdict: 'VERIFIED', why: served.why, price: served.price, currency: served.currency, from: served.from, identity: served.identity },
          'plain HTTP',
          'not needed — the served markup already answered'
        );
      }
    }
  } else if (page.blocked) {
    trail.plain = { reachable: false, failed: page.failed, blocked: true };
    return finish(
      { verdict: 'UNREACHABLE', why: page.failed, price: null, blocked: true },
      'nothing',
      'the network refused the host, and a real browser is refused the same way'
    );
  } else {
    trail.plain = { reachable: false, failed: page.failed };
    notes.push(`plain HTTP: ${page.failed}`);
  }

  /* ---- a real browser ---- */
  if (!useBrowser) {
    return finish(
      {
        verdict: page.html ? 'NO PRICE FOUND' : 'UNREACHABLE',
        why: `${page.html ? 'nothing usable in the served markup' : page.failed} (browser path off)`,
        price: null,
        refusals: served ? served.refusals : [],
        incomplete: 'the rendered page was never read, so this run says nothing about the figures it draws'
      },
      page.html ? 'plain HTTP' : 'nothing',
      'off (--no-browser)'
    );
  }

  const rendered = await renderPage(row.productUrl);
  if (rendered.failed) {
    trail.browser = { ran: false, why: rendered.failed };
    notes.push(`browser: ${rendered.failed}`);
    return finish(
      {
        verdict: page.html ? 'NO PRICE FOUND' : 'UNREACHABLE',
        why: rendered.noBrowser && page.html ? `nothing usable in the served markup, and ${rendered.failed}` : rendered.failed,
        price: null,
        refusals: served ? served.refusals : [],
        incomplete: 'the rendered page was never read, so this run says nothing about the figures it draws'
      },
      page.html ? 'plain HTTP' : 'nothing'
    );
  }

  const read = renderedCandidates(rendered.seen, row.productUrl);
  trail.browser = {
    ran: true,
    canonical: rendered.seen.canonical || null,
    selected: rendered.seen.selected || null,
    codeSites: explaining ? rendered.seen.codeSites : undefined,
    candidates: read.candidates.map(reportable),
    empties: read.empties,
    /* the DOM behind every figure, which is what a price disagreement
       has to be settled from */
    prices: explaining ? rendered.seen.prices : undefined
  };
  notes.push(`browser: ${read.candidates.length} price candidate${read.candidates.length === 1 ? '' : 's'}`);
  if (rendered.seen.selected && rendered.seen.selected.codes.length) {
    notes.push(`browser: the page has ${rendered.seen.selected.codes.slice(0, 3).join(', ')} selected`);
  }
  for (const empty of read.empties) {
    notes.push(`browser: ${empty.type}${empty.skus.length ? ` ${empty.skus[0]}` : ''} — ${empty.why}`);
  }

  if (!read.candidates.length) {
    return finish(
      { verdict: 'NO PRICE FOUND', why: 'the rendered page published no figure that reads as a price either', price: null, refusals: served ? served.refusals : [] },
      'browser'
    );
  }

  const found = decide(read.candidates, row.productUrl);
  if (found.price) {
    return finish(
      { verdict: 'VERIFIED', why: found.why, price: found.price, currency: found.currency, from: found.from, identity: found.identity },
      'browser'
    );
  }

  const refusals = [...(served && served.refusals ? served.refusals : []), ...found.refusals];

  if (found.ambiguous) {
    return finish(
      { verdict: 'AMBIGUOUS', why: found.why, price: null, ambiguous: found.ambiguous, survivors: found.survivors, refusals },
      'browser'
    );
  }

  return finish(
    { verdict: 'NO PRICE FOUND', why: `${refusals.length} figure${refusals.length === 1 ? '' : 's'} found, none cleared every gate`, price: null, refusals },
    'browser'
  );
}

/* a candidate as a capture records it: the amount, where it came from,
   and — for a rendered one — the DOM that has to justify it */
function reportable(candidate) {
  return {
    amount: candidate.amount,
    currency: candidate.currency,
    text: candidate.text,
    from: candidate.from,
    kind: candidate.kind || null,
    sku: candidate.node ? skuOf(candidate.node)[0] || null : null,
    dom: candidate.dom ? {
      selector: candidate.dom.selector,
      own: candidate.dom.own,
      near: candidate.dom.near,
      itemprop: candidate.dom.itemprop,
      offerScope: candidate.dom.offerScope,
      codes: candidate.dom.codes,
      scopeSkus: candidate.dom.scopeSkus,
      lineThrough: candidate.dom.lineThrough,
      hidden: candidate.dom.hidden,
      aria: candidate.dom.aria
    } : undefined
  };
}

/* ---------- writing it back ----------

   A targeted edit, like the image extractor's: the file keeps its
   comments, its spacing and its row order, and only the price belonging
   to the row being filled is touched.

   Every written price carries a note saying how it was tied to the
   product, with no exception for the "obvious" case. An image URL can
   be its own evidence, because it can carry the product's code; 84.95
   carries nothing. A number in a catalogue with no provenance is a
   number nobody can check again. */
function writePrice(source, id, amount, evidence) {
  const idAt = source.indexOf(`id: '${id}'`);
  if (idAt === -1) throw new Error(`could not find the row for ${id}`);

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`refusing to write ${amount} as a price for ${id}`);
  }

  const field = /(\n\s*price:\s*)(null|-?[\d.]+)/;
  const rest = source.slice(idAt);
  const m = rest.match(field);
  if (!m) throw new Error(`could not find a price for ${id}`);

  /* A number carries no provenance of its own, so a price whose
     evidence cannot be written as a note is not writable at all —
     otherwise a verified run could ship a figure that the catalogue
     could never re-prove, which is the state this whole file exists to
     prevent. */
  const note = priceEvidenceNote(evidence);
  if (!note) throw new Error(`refusing to write a price for ${id} with no provenance to record`);

  const at = idAt + m.index;
  const indent = m[1].replace(/\n/, '').replace(/price:\s*$/, '');
  const out = source.slice(0, at) + m[1] + String(amount) + source.slice(at + m[0].length);
  return setPriceEvidence(out, id, note, indent);
}

function priceEvidenceNote(evidence) {
  if (!evidence || !evidence.ok) return null;
  const safe = (value) => String(value).replace(/'/g, '');
  if (evidence.via === 'json-ld-offer' && evidence.sku) {
    return `{ via: 'json-ld-offer', sku: '${safe(evidence.sku)}' }`;
  }
  if (evidence.via === 'microdata-offer' && evidence.sku) {
    return `{ via: 'microdata-offer', sku: '${safe(evidence.sku)}' }`;
  }
  if (evidence.via === 'dom-product-scope' && evidence.code) {
    return `{ via: 'dom-product-scope', code: '${safe(evidence.code)}' }`;
  }
  if (evidence.via === 'datalayer-variant-price' && evidence.productId && evidence.l2Id) {
    const parts = [`via: 'datalayer-variant-price'`, `productId: '${safe(evidence.productId)}'`];
    if (evidence.l1Id) parts.push(`l1Id: '${safe(evidence.l1Id)}'`);
    parts.push(`l2Id: '${safe(evidence.l2Id)}'`);
    if (evidence.communicationCode) parts.push(`communicationCode: '${safe(evidence.communicationCode)}'`);
    if (evidence.currency) parts.push(`currency: '${safe(evidence.currency)}'`);
    return `{ ${parts.join(', ')} }`;
  }
  if (evidence.via === 'data-variant-mapping' && evidence.code && evidence.variant) {
    return `{ via: 'data-variant-mapping', code: '${safe(evidence.code)}', variant: '${safe(evidence.variant)}' }`;
  }
  if (evidence.via === 'data-product-record' && evidence.code) {
    return evidence.at
      ? `{ via: 'data-product-record', code: '${safe(evidence.code)}', at: '${safe(String(evidence.at).slice(0, 80))}' }`
      : `{ via: 'data-product-record', code: '${safe(evidence.code)}' }`;
  }
  if (evidence.via === 'dom-variant-scope' && evidence.code) {
    return evidence.variant
      ? `{ via: 'dom-variant-scope', code: '${safe(evidence.code)}', variant: '${safe(evidence.variant)}' }`
      : `{ via: 'dom-variant-scope', code: '${safe(evidence.code)}' }`;
  }
  return null;
}

function setPriceEvidence(source, id, note, indent) {
  const idAt = source.indexOf(`id: '${id}'`);
  const rest = source.slice(idAt, rowEndsAt(source, idAt));
  const existing = rest.match(/\n\s*priceEvidence:\s*(\{[^}]*\}|null),?/);

  if (existing) {
    const at = idAt + existing.index;
    return source.slice(0, at) + (note ? `\n${indent}priceEvidence: ${note},` : '') + source.slice(at + existing[0].length);
  }
  if (!note) return source;

  const after = rest.match(/(\n\s*price:\s*(?:null|-?[\d.]+),)/);
  if (!after) return source;
  const at = idAt + after.index + after[0].length;
  return source.slice(0, at) + `\n${indent}priceEvidence: ${note},` + source.slice(at);
}

/* ---------- is a SHIPPED row's price still accounted for? ----------

   Re-proved, never taken on faith: a recorded sku or product code has
   to be a code in the row's own listing URL. A price with no note, or
   with a note naming another product, fails exactly as a made-up URL
   does in the image extractor. */
function catalogRowPrice(row) {
  if (!row || row.price === null || row.price === undefined) return { ok: true, how: 'no price to account for' };
  if (typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0) {
    return { ok: false, why: `${row.price} is not an amount` };
  }
  if (!row.productUrl) {
    /* the sample rows: invented products with invented prices, which is
       what a demo catalogue is for. They link to nothing, so there is
       nothing to re-prove them against and nothing claiming they are
       real. */
    return { ok: true, how: 'a sample row, priced by the demo rather than by a retailer' };
  }

  const evidence = row.priceEvidence;
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, why: 'carries a price read off a retailer with no record of how it was tied to the product' };
  }

  const ids = identifiersFrom(row.productUrl);
  const claimed = String(evidence.sku || evidence.code || evidence.productId || '').toLowerCase();
  if (!claimed) return { ok: false, why: 'the recorded evidence names no sku or product code' };
  /* a variant chain is re-proved by the product it names, because that
     is the identifier the listing URL carries; the variant codes beside
     it are what the row records about WHICH price this is */

  const bare = claimed.replace(/[^a-z0-9]/g, '');
  const matched = ids.find((id) => bare.includes(id) || id.includes(bare) || namesCode(claimed, id));
  if (!matched) {
    return { ok: false, why: `the recorded ${evidence.sku ? 'sku' : 'code'} ${evidence.sku || evidence.code} is not a code in this row's own listing URL` };
  }

  const kinds = ['json-ld-offer', 'microdata-offer', 'dom-product-scope', 'dom-variant-scope', 'data-product-record', 'data-variant-mapping', 'datalayer-variant-price'];
  if (!kinds.includes(evidence.via)) {
    return { ok: false, why: `the recorded evidence names no recognised kind (${evidence.via || 'none'})` };
  }
  return { ok: true, via: evidence.via, how: `its listing ties ${evidence.sku || evidence.code} to this price by ${evidence.via}` };
}

/* ---------- inspecting one page's rendered prices ----------

   The captures answer for the served markup. They cannot answer for the
   figures a page draws after its scripts run, and a question about
   THOSE — which element produces this amount, does it belong to the
   product or to a recommendation, is any of them tied to the variant
   the page has selected — is a question about a DOM that only exists
   inside a browser.

   So this opens the page and prints every figure on it with the
   ancestry above it and what each gate says about it, against a listing
   URL rather than against a catalogue row. It writes nothing. */
async function inspectUrl(url) {
  const rendered = await renderPage(url);
  if (rendered.failed) return { url, failed: rendered.failed };

  const seen = rendered.seen;
  const read = renderedCandidates(seen, url);
  const figures = read.candidates.map((candidate) => {
    const identity = priceIdentity(candidate, url);
    const charged = identity.ok ? chargedEvidence(candidate) : null;
    return {
      amount: candidate.amount,
      currency: candidate.currency,
      text: candidate.text,
      from: candidate.from,
      identity,
      charged,
      elsewhere: elsewhereIn(candidate.dom),
      dom: candidate.dom || null
    };
  });

  return {
    url,
    canonical: seen.canonical || null,
    selected: seen.selected || { codes: [], from: [] },
    listingCodes: identifiersFrom(url),
    codeSites: seen.codeSites || [],
    empties: read.empties,
    figures,
    verdict: decide(read.candidates, url)
  };
}

/* The containers a retailer puts OTHER products in. Naming one is not a
   gate — a tile that names this listing's code is still this listing's
   price — but "which block is this figure in" is the first thing a
   person asks of a rendered price, so the inspection answers it. */
const ELSEWHERE = /(you-?may-?also-?like|complete-the-look|recently-?viewed|bought-?together|recommend\w*|also-?like|related|similar|carousel|cross-?sell|up-?sell)/i;

function elsewhereIn(dom) {
  if (!dom) return null;
  const hay = [dom.own, dom.near, ...(dom.chain || []).map((l) => [l.id, l.cls, l.testid].filter(Boolean).join(' '))].join(' ');
  const hit = hay.match(ELSEWHERE);
  return hit ? hit[0] : null;
}

function chainOf(dom) {
  if (!dom || !dom.chain) return '';
  return [dom.selector, ...dom.chain.map((link) => {
    const cls = (link.cls || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    return link.tag + (link.id ? '#' + link.id : '') + (cls ? '.' + cls : '') +
      (link.testid ? `[testid=${link.testid}]` : '') +
      (link.itemtype ? `[itemtype=${String(link.itemtype).split('/').pop()}]` : '') +
      (link.codes ? `{${link.codes.slice(0, 2).join(',')}}` : '');
  })].join(' < ');
}

function printInspection(report) {
  if (report.failed) {
    console.log(`\n  ${report.url}`);
    console.log(`  could not be read: ${report.failed}\n`);
    return;
  }

  console.log(`\n  ${report.url}`);
  console.log(`  canonical   ${report.canonical || 'none'}`);
  console.log(`  listing code${report.listingCodes.length === 1 ? ' ' : 's'} ${report.listingCodes.slice(0, 6).join(', ') || 'none'}`);
  console.log(`  selected    ${report.selected.codes.length ? report.selected.codes.join(', ') : 'the page names no selected variant'}`);
  if (report.selected.codes.length) console.log(`              via ${[...new Set(report.selected.from)].slice(0, 4).join(', ')}`);
  for (const ignored of (report.selected.ignored || []).slice(0, 6)) {
    console.log(`              ignored ${ignored.code} — ${ignored.why}`);
  }
  for (const empty of report.empties) console.log(`  structured  ${empty.type} — ${empty.why}`);

  /* the question a refused page always raises next: does this DOM name
     the product anywhere, and is there money inside the thing that
     names it? */
  const sites = report.codeSites || [];
  if (sites.length) {
    console.log(`\n  where this listing's code appears in the DOM (${sites.length}${sites.length === 30 ? '+' : ''}):`);
    for (const site of sites.slice(0, 12)) {
      console.log(`     ${site.selector}  depth ${site.depth}  ${site.money.length ? `money inside: ${site.money.slice(0, 4).join(' ')}` : 'no money inside'}`);
      console.log(`       ${short(site.attrs, 150)}`);
    }
    if (sites.some((site) => site.money.length)) {
      console.log('     -> a figure inside one of the blocks above is this product\'s, and');
      console.log('        that is exactly what the "this" gate reads.');
    } else {
      console.log('     -> the page names the product, but no block that names it contains');
      console.log('        a figure, so its price is not published inside its own block.');
    }
  } else {
    console.log(`\n  this listing's code (${report.listingCodes.slice(0, 4).join(', ')}) appears in NO element's`);
    console.log('  attributes on this page. No figure here can be tied to the product by');
    console.log('  ancestry, so a price can only come from the page\'s structured record,');
    console.log('  from a variant the page marks as selected, or stay unread.');
  }

  console.log(`\n  ${report.figures.length} figure${report.figures.length === 1 ? '' : 's'} that read as money:\n`);

  for (const figure of report.figures) {
    const dom = figure.dom;
    console.log(`  $${figure.amount} "${short(figure.text, 40)}" — ${figure.from}`);
    if (dom) {
      console.log(`     chain   ${short(chainOf(dom), 220)}`);
      console.log(`     marks   own="${dom.own || ''}" near="${short(dom.near || '', 50)}"${dom.aria ? ` aria="${dom.aria}"` : ''}`);
      console.log(`     state   ${dom.lineThrough ? 'struck through' : 'not struck'}, ${dom.hidden ? 'not visible' : `${dom.area}px2 on screen`}${dom.itemprop ? `, itemprop=${dom.itemprop}` : ''}${dom.offerScope ? ', inside an Offer scope' : ''}`);
      console.log(`     codes   ${(dom.codes || []).length ? dom.codes.slice(0, 4).join(', ') : 'none in its ancestry'}`);
      const elsewhere = elsewhereIn(dom);
      if (elsewhere) console.log(`     note    it sits inside a "${elsewhere}" block — another product's, unless the codes above say otherwise`);
    }
    console.log(`     this    ${figure.identity.ok ? `OK via ${figure.identity.via} — ${figure.identity.how}` : `REFUSED — ${figure.identity.why}`}`);
    if (figure.charged) {
      console.log(`     charged ${figure.charged.ok ? `OK — ${figure.charged.how}` : `REFUSED — ${figure.charged.why}`}`);
    }
    console.log('');
  }

  const verdict = report.verdict;
  if (verdict.price) {
    console.log(`  WOULD WRITE $${verdict.price} — ${verdict.why}\n`);
  } else if (verdict.ambiguous) {
    console.log(`  WOULD FAIL CLOSED — ${verdict.why}\n`);
  } else {
    console.log('  WOULD FAIL CLOSED — no figure on this page cleared every gate\n');
  }
}

/* ---------- where a page actually publishes its price ----------

   --inspect-data. The DOM inspection answers "which element is this
   figure?"; this one answers the question that follows when no element
   can be tied to the product: does the page carry the price anywhere
   ELSE — in a script it shipped, in state it left on window, in JSON it
   fetched — and is it in the same record as the listing's own code.

   It writes nothing and decides nothing. It reports what is there,
   including what it deliberately set aside. */
async function inspectData(url) {
  const ids = identifiersFrom(url);
  const rendered = await renderPage(url, ids, { data: true });
  if (rendered.failed) return { url, ids, failed: rendered.failed };

  const data = rendered.seen.data || {};
  const payloads = dataPayloads(data);

  const searched = [];
  const hits = [];
  const setAside = [];

  for (const payload of payloads) {
    const found = productRecords(payload.value, ids, payload.source);
    searched.push({ source: payload.source, records: found.length });
    for (const hit of found) (hit.elsewhere ? setAside : hits).push(hit);
  }

  /* everything that MENTIONS the code, parseable or not — a payload
     that names the product but yields no record is the next place to
     look by hand, and silence about it would hide that */
  const mentions = [];
  for (const script of data.scripts || []) {
    if (script.mentions && script.mentions.length) {
      mentions.push({ where: `script${script.id ? '#' + script.id : ''}${script.type ? ` [${script.type}]` : ''}`, bytes: script.length, parsed: Boolean(parseLoosely(script.text)) });
    }
  }
  for (const entry of data.state || []) {
    if (entry.mentions && entry.mentions.length) {
      mentions.push({ where: `window.${entry.key}`, bytes: entry.length, parsed: Boolean(parseLoosely(entry.text)) });
    }
  }
  for (const response of data.responses || []) {
    if (response.mentions && response.mentions.length) {
      mentions.push({ where: `network ${response.url}`, bytes: response.length, parsed: Boolean(parseLoosely(response.text)) });
    }
  }

  const mapped = variantPriceRecords(payloads, ids);
  const related = relatedIdentifiers(payloads, ids);

  /* and what the parser would make of all of it, through the same gates
     as everything else — no separate path, no relaxed rule */
  const candidates = dataCandidates(data, url);

  /* what a markup offer is worth here, judged against what the page
     actually prices from */
  const domCandidates = renderedCandidates(rendered.seen, url).candidates
    .filter((candidate) => candidate.dom)
    .filter((candidate) => priceIdentity(candidate, url).ok && chargedEvidence(candidate).ok);
  const corroborated = new Set([
    ...hits.filter((hit) => hit.authority !== 'markup').map((hit) => hit.amount),
    /* a figure the page draws corroborates only if it cleared its own
       gates — the refused $7.90 confirms nothing, least of all itself */
    ...domCandidates.map((candidate) => candidate.amount)
  ]);
  const audit = markupAudit(hits, corroborated, Date.now());
  const judged = candidates.map((candidate) => ({
    amount: candidate.amount,
    currency: candidate.currency,
    from: candidate.from,
    at: candidate.record.path,
    identity: priceIdentity(candidate, url),
    charged: chargedEvidence(candidate)
  }));

  return {
    url,
    ids,
    selected: rendered.seen.selected || { codes: [], from: [], ignored: [] },
    searched,
    mentions,
    hits,
    setAside,
    related,
    audit,
    variants: mapped,
    candidates: judged,
    verdict: decide(candidates, url),
    resources: (data.resources || []).filter((entry) => /\/api\/|graphql|\.json/i.test(entry.name)).slice(0, 40),
    counts: {
      scripts: (data.scripts || []).length,
      state: (data.state || []).length,
      responses: (data.responses || []).length,
      resources: (data.resources || []).length
    }
  };
}

const size = (bytes) => (bytes < 1024 ? `${bytes}B` : `${Math.round(bytes / 1024)}KB`);

function printDataInspection(report) {
  if (report.failed) {
    console.log(`\n  ${report.url}`);
    console.log(`  could not be read: ${report.failed}\n`);
    return;
  }

  console.log(`\n  ${report.url}`);
  console.log(`  looking for   ${report.ids.slice(0, 6).join(', ')}`);
  console.log(`  read          ${report.counts.scripts} scripts, ${report.counts.state} state objects, ${report.counts.responses} JSON responses, ${report.counts.resources} resources`);
  console.log(`  selected      ${report.selected.codes.length ? report.selected.codes.join(', ') : 'no selected variant named by the page'}`);
  for (const ignored of (report.selected.ignored || []).slice(0, 4)) {
    console.log(`                ignored ${ignored.code} — ${ignored.why}`);
  }

  console.log(`\n  payloads naming this product (${report.mentions.length}):`);
  if (!report.mentions.length) console.log('     none — the code does not appear in any script, state object or JSON response');
  for (const mention of report.mentions.slice(0, 15)) {
    console.log(`     ${short(mention.where, 110)}  ${size(mention.bytes)}  ${mention.parsed ? 'parsed' : 'NOT PARSEABLE as JSON'}`);
  }

  if (report.related.length) {
    console.log(`\n  other identifiers this page gives the same product (${report.related.length}):`);
    for (const other of report.related.slice(0, 8)) {
      console.log(`     ${other.code}  (${other.where[0].key} in ${short(other.where[0].source, 60)} at ${short(other.where[0].path, 50)})`);
    }
    console.log('     -> the listing URL\'s code is not the only identity this product has;');
    console.log('        an API response may key its price by one of these instead.');
  }

  console.log(`\n  records holding the code AND an amount (${report.hits.length}):`);
  if (!report.hits.length) console.log('     none — no payload carries this listing\'s code and a price in one record');
  for (const hit of report.hits.slice(0, 12)) {
    console.log(`     $${hit.amount}${hit.currency ? ' ' + hit.currency : ' (no currency named)'}  ${hit.kind === 'list' ? '[list field]' : ''}`);
    console.log(`       source  ${short(hit.source, 120)}`);
    console.log(`       record  ${short(hit.recordPath, 110)}  (${hit.codeKey}: ${hit.code})`);
    console.log(`       field   ${short(hit.field, 110)}`);
    if (hit.variants.length) console.log(`       variants ${hit.variants.slice(0, 5).join(', ')}`);
  }

  if (report.setAside.length) {
    console.log(`\n  set aside as another product's (${report.setAside.length}):`);
    for (const hit of report.setAside.slice(0, 6)) {
      console.log(`     $${hit.amount} under "${hit.elsewhere}" — ${short(hit.recordPath, 90)}`);
    }
  }

  if (report.audit.length) {
    console.log(`\n  what the page's schema.org markup offers (${report.audit.length}):`);
    for (const entry of report.audit.slice(0, 8)) {
      console.log(`     $${entry.amount}${entry.currency ? ' ' + entry.currency : ''} at ${short(entry.path, 90)}`);
      for (const note of entry.notes) console.log(`       ${note}`);
    }
    console.log('     -> markup may CONFIRM an amount the page prices from. On its own it');
    console.log('        answers nothing: it is written for crawlers, and nothing on the');
    console.log('        page breaks when it goes stale.');
  }

  console.log(`\n  variant mapping:`);
  if (!report.variants.variants.length) {
    console.log('     no record naming this listing carries variant or colour codes');
  } else {
    console.log(`     this listing names ${report.variants.variants.slice(0, 8).join(', ')}`);
    for (const owner of report.variants.owners.slice(0, 4)) {
      console.log(`       from ${short(owner.source, 70)} at ${short(owner.path, 60)} (${owner.variantKey})`);
    }
    if (!report.variants.priced.length) console.log('     and no record prices any of those codes');
    for (const hit of report.variants.priced.slice(0, 6)) {
      console.log(`     $${hit.amount}${hit.currency ? ' ' + hit.currency : ''} for ${hit.code} — ${short(hit.source, 80)} at ${short(hit.field, 60)}`);
    }
  }

  if (report.resources.length) {
    console.log(`\n  API-ish requests the page made (${report.resources.length}):`);
    for (const entry of report.resources.slice(0, 12)) {
      console.log(`     ${short(entry.name, 120)}  ${entry.kind} ${size(entry.bytes)}`);
    }
  }

  console.log(`\n  through the gates (${report.candidates.length} candidate${report.candidates.length === 1 ? '' : 's'}):`);
  for (const judged of report.candidates.slice(0, 12)) {
    console.log(`     $${judged.amount} — ${short(judged.from, 100)}`);
    console.log(`       this    ${judged.identity.ok ? `OK via ${judged.identity.via} — ${judged.identity.how}` : `REFUSED — ${judged.identity.why}`}`);
    console.log(`       charged ${judged.charged.ok ? `OK — ${judged.charged.how}` : `REFUSED — ${judged.charged.why}`}`);
  }

  const verdict = report.verdict;
  if (verdict.price) {
    console.log(`\n  WOULD WRITE $${verdict.price} — ${verdict.why}\n`);
  } else if (verdict.ambiguous) {
    console.log(`\n  WOULD FAIL CLOSED — ${verdict.why}\n`);
  } else {
    console.log('\n  WOULD FAIL CLOSED — no record cleared every gate\n');
  }
}

/* ---------- the analytics event, and what it ties together ----------

   A commerce API prices a variant and says nothing about units. The
   analytics event for that same variant names the currency, the
   product, the legacy id and often the amount — it is the one place a
   page says all of it at once, because that is what analytics is for.

   This dumps it whole and then walks the chain link by link: which
   variant the page has selected, what the API charges for it, what the
   event calls it and in what currency, and whether the figure on the
   screen is that amount. It decides nothing; it reports each link and
   what the ordinary gates make of the result. */
function ecommerceEvents(data) {
  const out = [];
  for (const state of (data && data.state) || []) {
    if (!/datalayer/i.test(state.key)) continue;
    const value = parseLoosely(state.text);
    if (!Array.isArray(value)) continue;

    value.forEach((entry, at) => {
      if (!entry || typeof entry !== 'object' || !entry.ecommerce || typeof entry.ecommerce !== 'object') return;
      const ecommerce = entry.ecommerce;
      const items = Array.isArray(ecommerce.items) ? ecommerce.items : [];

      out.push({
        at,
        key: state.key,
        event: typeof entry.event === 'string' ? entry.event : null,
        currency: currencyIn(ecommerce.currency) || null,
        value: toAmount(ecommerce.value),
        items: items.slice(0, 25).map((item, index) => {
          const ids = [];
          if (item && typeof item === 'object') {
            for (const key of Object.keys(item)) {
              const raw = item[key];
              if ((typeof raw === 'string' || typeof raw === 'number') && isIdKey(key)) {
                ids.push({ key, value: String(raw).slice(0, 64) });
              }
            }
          }
          return {
            index,
            ids,
            price: item ? toAmount(item.price) : null,
            currency: item ? currencyIn(item.currency) || null : null,
            name: item && typeof item.item_name === 'string' ? item.item_name : null
          };
        }),
        text: (function () { try { return JSON.stringify(entry, null, 2); } catch (err) { return null; } })()
      });
    });
  }
  return out;
}

/* every variant this page's data prices, so one cheap colour among
   expensive ones is visible rather than inferred */
function pricedVariants(payloads) {
  const out = [];
  for (const payload of payloads || []) {
    const table = variantTable(payload.value);
    for (const map of table.maps) {
      const joined = table.joined.find((join) => join.map.key === map.key);
      out.push({
        source: payload.source,
        key: map.key,
        amounts: map.amounts,
        variant: joined ? joined.variant.ids.map((id) => `${id.key}=${id.value}`).join(' · ') : null,
        describe: joined ? joined.variant.describe.map((d) => `${d.key}=${d.value}`).join(' · ') : null
      });
    }
  }
  return out;
}

function priceChains(url, seen, payloads, events) {
  const ids = identifiersFrom(url);
  const priced = pricedVariants(payloads);
  const drawn = (seen.prices || []).map((figure) => {
    const money = moneyInText(figure.text);
    return money ? { amount: money.amount, text: figure.text, selector: figure.selector, codes: figure.codes || [] } : null;
  }).filter(Boolean);

  const chains = [];
  for (const event of events) {
    for (const item of event.items) {
      for (const id of item.ids) {
        const match = priced.find((entry) => String(entry.key).toLowerCase() === String(id.value).toLowerCase());
        if (!match) continue;

        const charged = match.amounts.filter((amount) => amount.kind !== 'list');
        const product = item.ids.find((other) => ids.some((code) => namesCode(other.value, code))) || null;

        chains.push({
          variant: id.value,
          variantKey: id.key,
          event: { at: event.at, event: event.event, currency: event.currency, itemPrice: item.price, itemCurrency: item.currency },
          product,
          otherIds: item.ids.filter((other) => other !== id),
          amounts: charged.map((amount) => ({ amount: amount.amount, at: amount.at, currency: amount.currency })),
          source: match.source,
          describe: match.describe,
          rendered: charged.length
            ? drawn.filter((figure) => charged.some((amount) => Math.abs(amount.amount - figure.amount) < 1e-9))
            : []
        });
      }
    }
  }
  return { chains, priced, drawn };
}

async function inspectDataLayer(url) {
  const ids = identifiersFrom(url);
  const rendered = await renderPage(url, ids, { data: true, capture: 'all' });
  if (rendered.failed) return { url, ids, failed: rendered.failed };

  const seen = rendered.seen;
  const data = seen.data || {};
  const payloads = dataPayloads(data);
  const events = ecommerceEvents(data);
  const walked = priceChains(url, seen, payloads, events);

  /* and what the ordinary gates make of it — the same functions the
     verifier uses, so this cannot describe a different program */
  const candidates = dataCandidates(data, url);
  const judged = candidates.map((candidate) => ({
    amount: candidate.amount,
    currency: candidate.currency,
    from: candidate.from,
    at: candidate.record.path,
    currencyFrom: candidate.record.currencyFrom || null,
    currencyHint: candidate.record.currencyHint || null,
    identity: priceIdentity(candidate, url),
    charged: chargedEvidence(candidate)
  }));

  return {
    url,
    ids,
    selected: seen.selected || { codes: [], from: [], ignored: [] },
    events,
    chains: walked.chains,
    priced: walked.priced,
    drawn: walked.drawn,
    candidates: judged,
    verdict: decide(candidates, url)
  };
}

function printDataLayer(report) {
  if (report.failed) {
    console.log(`\n  ${report.url}`);
    console.log(`  could not be read: ${report.failed}\n`);
    return;
  }

  console.log(`\n  ${short(report.url, 130)}`);
  console.log(`  listing codes ${report.ids.slice(0, 6).join(', ')}`);
  console.log(`  selected      ${report.selected.codes.length ? report.selected.codes.join(', ') : 'the page names no selected variant'}`);

  console.log(`\n  dataLayer ecommerce events (${report.events.length}):`);
  if (!report.events.length) console.log('     none — this page pushes no ecommerce event, or none was captured');
  for (const event of report.events.slice(0, 6)) {
    console.log(`\n     dataLayer[${event.at}]${event.event ? ` event=${event.event}` : ''}`);
    console.log(`       currency ${event.currency || 'not named'}${event.value !== null ? `, value ${event.value}` : ''}`);
    for (const item of event.items.slice(0, 8)) {
      console.log(`       items[${item.index}] ${item.ids.map((id) => `${id.key}=${id.value}`).join(' · ') || 'no id fields'}`);
      console.log(`         price ${item.price === null ? 'not carried on the item' : item.price}${item.currency ? ` ${item.currency}` : ''}${item.name ? ` — ${short(item.name, 40)}` : ''}`);
    }
    if (event.text) {
      console.log('       the object in full:');
      for (const line of String(event.text).split('\n').slice(0, 60)) console.log(`         ${short(line, 120)}`);
    }
  }

  console.log(`\n  every variant this page's data prices (${report.priced.length}):`);
  for (const entry of report.priced.slice(0, 20)) {
    const amounts = entry.amounts.map((amount) => `$${amount.amount}${amount.currency ? ' ' + amount.currency : ''}${amount.kind === 'list' ? ' [list]' : ''}`).join(', ');
    console.log(`     ${entry.key}  ${amounts}`);
    if (entry.variant) console.log(`       ${short(entry.variant, 110)}`);
    if (entry.describe) console.log(`       ${short(entry.describe, 110)}`);
  }
  const spread = [...new Set(report.priced.flatMap((entry) => entry.amounts.filter((a) => a.kind !== 'list').map((a) => a.amount)))];
  if (spread.length > 1) {
    console.log(`     -> this page prices its variants at ${spread.sort((a, b) => a - b).map((n) => '$' + n).join(', ')};`);
    console.log('        which one a shopper sees depends on the variant selected.');
  }

  console.log(`\n  the chain, link by link (${report.chains.length}):`);
  if (!report.chains.length) console.log('     no dataLayer item id matches a key in any price map this page loaded');
  for (const chain of report.chains.slice(0, 6)) {
    console.log(`\n     variant   ${chain.variant}   (${chain.variantKey}, and the key of a price map)`);
    console.log(`     product   ${chain.product ? `${chain.product.key}=${chain.product.value} — MATCHES this listing` : 'no id on this item matches the listing'}`);
    if (chain.otherIds.length) console.log(`     also      ${chain.otherIds.map((id) => `${id.key}=${id.value}`).join(' · ')}`);
    for (const amount of chain.amounts) {
      console.log(`     amount    ${amount.amount} at ${short(amount.at, 80)}`);
      console.log(`               ${amount.currency ? `currency ${amount.currency} in that record` : 'NO currency in that record'}`);
    }
    console.log(`     currency  ${chain.event.currency || 'not named by the event'} (dataLayer[${chain.event.at}].ecommerce.currency)`);
    console.log(`     the event ${chain.event.itemPrice === null ? 'does NOT carry this item\'s price' : `carries price ${chain.event.itemPrice} on the item`}`);
    console.log(`     rendered  ${chain.rendered.length ? chain.rendered.map((figure) => `${figure.text} (${figure.selector})`).join(', ') : 'no figure on the page draws this amount'}`);
  }

  console.log(`\n  what the gates make of it (${report.candidates.length} candidate${report.candidates.length === 1 ? '' : 's'}):`);
  for (const judged of report.candidates.slice(0, 10)) {
    console.log(`     $${judged.amount}${judged.currency ? ' ' + judged.currency : ' (no currency)'} — ${short(judged.from, 90)}`);
    console.log(`       this    ${judged.identity.ok ? `OK via ${judged.identity.via}` : `REFUSED — ${judged.identity.why}`}`);
    console.log(`       charged ${judged.charged.ok ? `OK — ${judged.charged.how}` : `REFUSED — ${judged.charged.why}`}`);
    if (judged.currencyFrom) console.log(`       currency borrowed from ${short(judged.currencyFrom.source, 60)} (${judged.currencyFrom.identity}, ${judged.currencyFrom.via})`);
    if (judged.currencyHint) console.log(`       currency NOT borrowed: ${short(judged.currencyHint.source, 60)} names ${judged.currencyHint.currency} for ${judged.currencyHint.identity} but not this amount`);
  }

  const verdict = report.verdict;
  console.log(verdict.price
    ? `\n  THE GATES WOULD WRITE $${verdict.price} — ${verdict.why}`
    : `\n  THE GATES FAIL CLOSED — ${verdict.why || 'nothing cleared them'}`);
  console.log('  This command writes nothing.\n');
}

/* ---------- hunting an amount through everything a page loaded ----

   The question this answers is not "what does the reader accept" but
   "where does the number a shopper sees actually come from". UNIQLO's
   l2s endpoint returns 7.9 with no currency beside it, the page shows
   49.90, and both facts can be true: the displayed amount may come from
   another response, from state the page holds, or from a field in a
   different unit — 4990 in cents is the same number wearing a
   different shape.

   So nothing is assumed about what to look for. The amounts hunted are
   the ones passed in with --find, expanded mechanically into the forms
   an API might carry them in; the identities are the listing's own
   codes plus whatever other identifiers the page's records tie to
   them. Nothing here decides anything, and no amount is ever written
   from a hunt. */
const HUNT_TOKENS = ['usd', 'currency', 'price', 'amount'];

/* 49.90 as an API might carry it: as written, to two decimals, or as an
   integer number of cents. This is an expansion of what was typed, not
   a guess about what the price is. */
function needleForms(needle) {
  const text = String(needle == null ? '' : needle).trim();
  if (!text) return [];

  const forms = new Map();
  const add = (form, kind, numeric) => {
    const key = String(form).toLowerCase();
    if (form !== '' && !forms.has(key)) forms.set(key, { form: String(form), kind, numeric: numeric === undefined ? null : numeric });
  };

  if (!/^\d+(\.\d+)?$/.test(text)) {
    add(text, 'as written');
    return [...forms.values()];
  }

  const n = Number(text);
  add(text, 'as written', n);
  add(n.toFixed(2), 'to two decimals', n);
  add(String(n), 'as a number', n);
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) < 1e-9) add(String(cents), 'in cents', cents);
  return [...forms.values()];
}

/* does this key/value pair answer to one of the forms? */
function scalarMatches(key, value, entry) {
  const name = String(key).toLowerCase();
  const text = String(value == null ? '' : value).trim();
  const bare = text.replace(/[$£€,\s]/g, '').toLowerCase();

  for (const form of entry.forms) {
    if (form.numeric !== null) {
      if (typeof value === 'number' && value === form.numeric) return { form, where: 'value' };
      if (bare && bare === form.form.toLowerCase()) return { form, where: 'value' };
      continue;
    }
    const needle = form.form.toLowerCase();
    if (name.includes(needle)) return { form, where: 'key' };
    if (bare.includes(needle)) return { form, where: 'value' };
  }
  return null;
}

/* every place in one payload where a needle turns up, with the record
   around it: what identifies it, whether that identity is this
   listing's, and where the nearest currency is */
function huntIn(value, needles, ids, limit) {
  const wanted = needles.map((needle) => ({ needle: String(needle), forms: needleForms(needle) })).filter((e) => e.forms.length);
  const out = [];
  const cap = limit || 60;

  const visit = (node, path, ancestors) => {
    if (out.length >= cap || !node || typeof node !== 'object') return;
    const here = ancestors.concat([{ node, path }]);
    const keys = Array.isArray(node) ? node.map((ignored, at) => at) : Object.keys(node);

    for (const key of keys) {
      if (out.length >= cap) return;
      const child = node[key];
      const at = path.concat(Array.isArray(node) ? `[${key}]` : key);
      if (child && typeof child === 'object') { visit(child, at, here); continue; }

      for (const entry of wanted) {
        const hit = scalarMatches(key, child, entry);
        if (!hit) continue;

        /* the nearest record that names something, and whether what it
           names is this listing */
        let identity = null;
        let currency = null;
        for (let up = here.length - 1; up >= 0; up -= 1) {
          const step = here[up];
          if (!identity) {
            const named = namesListing(step.node, ids);
            if (named) {
              identity = { key: named.key, value: named.value, at: step.path.join('.') || '(root)', tied: true };
            } else if (step.path.length) {
              /* a price map keyed by the variant id: the key is the
                 identity, the same way productRecords reads it */
              const filed = String(step.path[step.path.length - 1]);
              for (const id of ids) {
                if (namesCode(filed, id)) {
                  identity = { key: '(map key)', value: filed, at: step.path.join('.'), tied: true };
                  break;
                }
              }
            }
          }
          if (!currency) {
            const found = currencyNear(step.node);
            if (found) currency = { value: found, at: step.path.join('.') || '(root)' };
          }
          if (identity && currency) break;
        }

        const record = here[here.length - 1].node;
        const fields = [];
        if (record && !Array.isArray(record)) {
          for (const field of Object.keys(record)) {
            const raw = record[field];
            if ((typeof raw === 'string' || typeof raw === 'number') && isIdKey(field)) {
              fields.push({ key: field, value: String(raw).slice(0, 64) });
            }
          }
        }

        out.push({
          needle: entry.needle,
          form: hit.form.form,
          kind: hit.form.kind,
          where: hit.where,
          path: at.join('.'),
          key: String(key),
          value: typeof child === 'string' ? child.slice(0, 80) : child,
          record: here[here.length - 1].path.join('.') || '(root)',
          idFields: fields.slice(0, 6),
          identity,
          currency,
          tied: Boolean(identity),
          elsewhere: at.find((segment) => ELSEWHERE_KEY.test(String(segment))) || null
        });
        break;
      }
    }
  };

  visit(value, [], []);
  return out;
}

/* a payload that will not parse still gets read, as text, because a
   bundle can carry the number the page prints */
function huntInText(text, needles, limit) {
  const body = String(text || '');
  const out = [];
  const cap = limit || 6;

  for (const needle of needles) {
    for (const form of needleForms(needle)) {
      if (form.numeric === null && HUNT_TOKENS.includes(form.form.toLowerCase())) continue; // too common to be useful in a bundle
      let at = body.indexOf(form.form);
      let seen = 0;
      while (at >= 0 && seen < 2 && out.length < cap) {
        /* 49.90 and 49.9 are the same sighting when they start at the
           same place; reporting it twice is noise */
        if (out.some((found) => found.offset === at)) { at = body.indexOf(form.form, at + 1); continue; }
        out.push({
          needle: String(needle),
          form: form.form,
          kind: form.kind,
          offset: at,
          context: body.slice(Math.max(0, at - 60), at + form.form.length + 60).replace(/\s+/g, ' ')
        });
        seen += 1;
        at = body.indexOf(form.form, at + form.form.length);
      }
    }
  }
  return out;
}

async function huntPage(url, options) {
  const settings = options || {};
  const ids = identifiersFrom(url);
  const rendered = await renderPage(url, ids, { data: true, capture: 'all' });
  if (rendered.failed) return { url, ids, failed: rendered.failed };

  const data = rendered.seen.data || {};
  const parsedPayloads = dataPayloads(data);

  /* the identities to look for: the listing's own, plus the other codes
     its records tie to it — 438783 arrives this way rather than by
     being typed in */
  const related = relatedIdentifiers(parsedPayloads, ids).map((entry) => entry.code);
  const asked = (settings.find || []).map((needle) => String(needle).trim()).filter(Boolean);
  const needles = [...new Set([...asked, ...ids, ...related, ...HUNT_TOKENS])];
  const numeric = asked.filter((needle) => /^\d+(\.\d+)?$/.test(needle)).map(Number);

  const sources = [];

  const consider = (where, kind, text, extra) => {
    const body = String(text || '');
    const value = parseLoosely(body);
    const entry = Object.assign({
      where,
      kind,
      bytes: body.length,
      parsed: Boolean(value),
      matches: value ? huntIn(value, needles, ids, 40) : [],
      textMatches: value ? [] : huntInText(body, asked.length ? asked : ids, 6)
    }, extra || {});
    if (entry.matches.length || entry.textMatches.length) sources.push(entry);
  };

  for (const response of data.responses || []) consider(`network ${response.url}`, 'network', response.text, { url: response.url, type: response.type });
  for (const script of data.scripts || []) {
    consider(`script${script.id ? '#' + script.id : ''}${script.type ? ` [${script.type}]` : ''}`, 'script', script.text, { src: script.src || null });
  }
  for (const state of data.state || []) consider(`window.${state.key}`, 'window', state.text, { key: state.key });

  /* and what the page actually draws, because "the number is on screen
     but in no payload" is itself the finding */
  const drawn = (rendered.seen.prices || []).map((figure) => {
    const money = moneyInText(figure.text);
    return money ? { amount: money.amount, text: figure.text, selector: figure.selector, codes: figure.codes, own: figure.own, near: figure.near } : null;
  }).filter(Boolean).filter((figure) => !numeric.length || numeric.some((want) => Math.abs(want - figure.amount) < 1e-9));

  /* the four questions, answered from what was found */
  const numericMatches = sources.flatMap((source) => source.matches
    .filter((match) => numeric.some((want) => {
      const forms = needleForms(String(want)).map((form) => form.form.toLowerCase());
      return forms.includes(String(match.form).toLowerCase());
    }))
    /* the source's kind and the form's kind are different questions,
       and merging them under one name made every match look like it
       came from nowhere */
    .map((match) => Object.assign({ source: source.where, sourceKind: source.kind }, match)));

  const answers = {
    anotherApi: numericMatches.filter((match) => match.sourceKind === 'network' && match.tied),
    currencyElsewhere: sources.map((source) => ({
      where: source.where,
      currencies: source.matches.filter((match) => /currenc/i.test(match.key) || match.needle === 'currency').slice(0, 6)
    })).filter((entry) => entry.currencies.length),
    pageState: numericMatches.filter((match) => match.sourceKind === 'window' || match.sourceKind === 'script'),
    /* the same number wearing a different shape: 4990 in cents is the
       answer to "where does the rendered 49.90 come from" as much as a
       field literally holding 49.90 would be */
    transformed: numericMatches.filter((match) => match.kind !== 'as written' && match.kind !== 'as a number'),
    drawn
  };

  return {
    url,
    ids,
    related,
    needles,
    numeric,
    counts: {
      responses: (data.responses || []).length,
      scripts: (data.scripts || []).length,
      state: (data.state || []).length
    },
    sources,
    drawn,
    answers
  };
}

function printHunt(report) {
  if (report.failed) {
    console.log(`\n  ${report.url}`);
    console.log(`  could not be read: ${report.failed}\n`);
    return;
  }

  console.log(`\n  ${short(report.url, 130)}`);
  console.log(`  read          ${report.counts.responses} responses, ${report.counts.scripts} scripts, ${report.counts.state} state objects`);
  console.log(`  listing codes ${report.ids.slice(0, 6).join(', ')}`);
  if (report.related.length) console.log(`  also tied to  ${report.related.slice(0, 8).join(', ')}`);
  console.log(`  hunting for   ${report.needles.slice(0, 12).join(', ')}`);
  if (report.numeric.length) {
    const forms = report.numeric.flatMap((n) => needleForms(String(n)).map((f) => `${f.form} (${f.kind})`));
    console.log(`  amount forms  ${[...new Set(forms)].join(', ')}`);
  }

  console.log(`\n  sources carrying something (${report.sources.length}):`);
  if (!report.sources.length) console.log('     none — nothing the page loaded carries any of those');

  for (const source of report.sources.slice(0, 20)) {
    console.log(`\n     ${short(source.where, 120)}`);
    console.log(`       ${size(source.bytes)}${source.type ? ', ' + String(source.type).split(';')[0] : ''}${source.parsed ? '' : ', NOT PARSEABLE as JSON'}`);
    for (const match of source.matches.slice(0, 10)) {
      console.log(`       ${match.path} = ${typeof match.value === 'string' ? '"' + short(match.value, 40) + '"' : match.value}  [${match.needle} ${match.kind}, in the ${match.where}]`);
      console.log(`         record ${short(match.record, 90)}${match.elsewhere ? `  (under "${match.elsewhere}")` : ''}`);
      console.log(`         identity ${match.identity ? `${match.identity.key}=${match.identity.value} at ${short(match.identity.at, 60)} — TIED to this listing` : 'none — no record around it names this listing'}`);
      if (match.idFields.length) console.log(`         fields ${match.idFields.map((f) => f.key + '=' + f.value).join(' · ')}`);
      console.log(`         currency ${match.currency ? `${match.currency.value} at ${short(match.currency.at, 60)}` : 'none anywhere above it in this payload'}`);
    }
    const more = source.matches.length - 10;
    if (more > 0) console.log(`       …and ${more} more`);
    for (const match of source.textMatches.slice(0, 4)) {
      console.log(`       text at ${match.offset}: …${short(match.context, 110)}…  [${match.needle} ${match.kind}]`);
    }
  }

  console.log('\n  what the page draws:');
  if (!report.drawn.length) console.log('     no rendered figure matches the amounts hunted');
  for (const figure of report.drawn.slice(0, 8)) {
    console.log(`     ${figure.text} — ${figure.selector}  codes: ${(figure.codes || []).slice(0, 3).join(', ') || 'none in its ancestry'}`);
  }

  console.log('\n  the questions:');
  console.log(`     1. another response carries it, tied to this product: ${report.answers.anotherApi.length
    ? report.answers.anotherApi.slice(0, 4).map((m) => `${short(m.source, 70)} at ${m.path}`).join('; ')
    : 'no'}`);
  console.log(`     2. currency metadata elsewhere in a payload that has the amount: ${report.answers.currencyElsewhere.length
    ? report.answers.currencyElsewhere.slice(0, 3).map((e) => `${short(e.where, 60)} (${e.currencies.map((c) => c.path).slice(0, 3).join(', ')})`).join('; ')
    : 'none found'}`);
  console.log(`     3. page state or a shipped script carries it: ${report.answers.pageState.length
    ? report.answers.pageState.slice(0, 4).map((m) => `${short(m.source, 60)} at ${m.path}`).join('; ')
    : 'no'}`);
  console.log(`     4. it appears in another unit or shape: ${report.answers.transformed.length
    ? report.answers.transformed.slice(0, 4).map((m) => `${m.form} (${m.kind}) at ${short(m.source, 50)} ${m.path}`).join('; ')
    : 'no'}`);
  if (report.drawn.length && !report.answers.anotherApi.length && !report.answers.pageState.length && !report.answers.transformed.length) {
    console.log('     -> the page draws it and no payload it loaded carries it in any form,');
    console.log('        so it is computed in the browser or fetched after this read.');
  }
  console.log('\n  A hunt decides nothing and writes nothing.\n');
}

/* ---------- one endpoint, read the way the page reads it ----------

   --inspect-api. The page inspection says which requests a product page
   makes; this one opens a single response and asks the question those
   requests exist to answer: is there a record here carrying a product
   or variant identity AND the amount a shopper is charged.

   It is fetched from inside the page rather than from Node, so the
   request carries the session, the cookies and the origin the retailer
   expects — an API that answers a browser and refuses a bare client is
   read the way the browser reads it. */
function allAmounts(value) {
  const out = [];
  walkData(value, (node, path) => {
    if (Array.isArray(node) || out.length >= 60) return;
    const inherited = currencyNear(node);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') continue;
      if (!isPriceKey(key)) continue;
      if (typeof child === 'string' && DATEISH.test(child.trim())) continue;
      const amount = toAmount(child);
      if (amount === null || out.length >= 60) continue;
      const at = path.concat(key);
      out.push({
        path: at.join('.'),
        amount,
        currency: inherited,
        kind: at.some((segment) => LIST_KEY.test(segment)) ? 'list' : 'price'
      });
    }
  });
  return out;
}

function colourFields(value) {
  const out = [];
  walkData(value, (node, path) => {
    if (Array.isArray(node) || out.length >= 30) return;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child !== 'string' && typeof child !== 'number') continue;
      if (!/(colou?r|display|selected|representative|main)/i.test(key)) continue;
      const text = String(child).trim();
      if (!text || text.length > 64) continue;
      out.push({ path: path.concat(key).join('.'), key, value: text });
      if (out.length >= 30) return;
    }
  });
  return out;
}

/* ---------- the variant table a commerce endpoint answers with ----

   UNIQLO's l2s response is two structures that mean nothing apart: an
   array of variant records (result.l2s[*], each naming an l2Id, the
   productId it belongs to, a colour and a size) and a map of amounts
   keyed by those same l2Ids (result.prices[...]). Joining them is what
   turns "there is a 49.90 in this file" into "this product's colour 09
   in size M costs 49.90". */
const VARIANT_ARRAY_KEY = /^(l2s|l1s|items|variants|skus|goods|products|entries)$/i;
const PRICE_MAP_KEY = /^(prices|price|pricemap|priceinfo|amounts)$/i;

function variantTable(value) {
  const rows = [];
  const maps = [];

  walkData(value, (node, path) => {
    const key = path.length ? String(path[path.length - 1]) : '';

    if (Array.isArray(node) && VARIANT_ARRAY_KEY.test(key)) {
      node.slice(0, 40).forEach((entry, at) => {
        if (!entry || typeof entry !== 'object') return;
        const ids = [];
        const describe = [];
        for (const field of Object.keys(entry)) {
          const raw = entry[field];
          if (typeof raw === 'string' || typeof raw === 'number') {
            const text = String(raw).trim();
            if (isIdKey(field) && text && text.length <= 64) ids.push({ key: field, value: text });
            else if (/colou?r|size|name|display/i.test(field) && text) describe.push({ key: field, value: text.slice(0, 40) });
          } else if (raw && typeof raw === 'object') {
            for (const inner of Object.keys(raw)) {
              const deep = raw[inner];
              if (typeof deep !== 'string' && typeof deep !== 'number') continue;
              if (/colou?r|size|display|name/i.test(field)) describe.push({ key: `${field}.${inner}`, value: String(deep).slice(0, 40) });
              else if (isIdKey(inner)) ids.push({ key: `${field}.${inner}`, value: String(deep).slice(0, 64) });
            }
          }
        }
        if (ids.length) rows.push({ at: path.concat(`[${at}]`).join('.'), ids, describe });
      });
      return;
    }

    if (!Array.isArray(node) && PRICE_MAP_KEY.test(key)) {
      for (const mapKey of Object.keys(node).slice(0, 60)) {
        const entry = node[mapKey];
        if (!entry || typeof entry !== 'object') continue;
        const amounts = pricesUnder(entry).map((price) => ({
          field: price.field,
          amount: price.amount,
          currency: price.currency,
          kind: price.kind,
          at: path.concat(mapKey, price.path).join('.')
        }));
        if (amounts.length) maps.push({ key: mapKey, at: path.concat(mapKey).join('.'), amounts });
      }
    }
  });

  /* join them on the identity the variant record carries */
  const joined = [];
  for (const row of rows) {
    for (const map of maps) {
      const matched = row.ids.find((id) => id.value.toLowerCase() === map.key.toLowerCase());
      if (!matched) continue;
      joined.push({ variant: row, map, on: matched });
    }
  }
  return { rows, maps, joined };
}

async function inspectEndpoint(endpoint, options) {
  const settings = options || {};
  const chromium = loadPlaywright();
  if (!chromium) return { endpoint, failed: 'Playwright is not installed here, so the endpoint cannot be read the way the page reads it' };

  const launch = { args: ['--disable-blink-features=AutomationControlled'] };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;

  let browser;
  try {
    browser = await chromium.launch(launch);
  } catch (err) {
    return { endpoint, failed: `Chromium would not start (${err && err.message ? err.message.split('\n')[0] : 'unknown'})` };
  }

  let fetched;
  const opened = settings.forUrl || (() => { try { return new URL(endpoint).origin; } catch (err) { return null; } })();
  try {
    const context = await browser.newContext({ userAgent: BROWSER['User-Agent'], locale: 'en-US', viewport: { width: 1400, height: 1000 } });
    const page = await context.newPage();
    if (opened) {
      await page.goto(opened, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT }).catch(() => {});
      await dismissConsent(page).catch(() => null);
    }
    fetched = await page.evaluate(async (target) => {
      try {
        const response = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
        const text = await response.text();
        return { status: response.status, type: response.headers.get('content-type') || '', text: text.slice(0, 2000000), bytes: text.length };
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    }, endpoint);
    await browser.close();
  } catch (err) {
    await browser.close().catch(() => {});
    return { endpoint, failed: `the browser path failed (${err && err.message ? String(err.message).split('\n')[0] : 'unknown'})` };
  }

  if (!fetched || fetched.error) return { endpoint, openedFrom: opened, failed: fetched ? fetched.error : 'no response' };

  const codes = [...new Set([
    ...(settings.codes || []),
    ...identifiersFrom(settings.forUrl || ''),
    ...identifiersFrom(endpoint)
  ].filter(Boolean))];

  /* What came back has to BE an API response. An endpoint that answers
     with a page — a bot wall, a redirect to the listing, a 404 — hands
     back markup, and reading a product page's JSON-LD out of it would
     report the page's schema.org as the endpoint's answer, wearing a
     commerce API's authority. That is refused here, by name. */
  const body = String(fetched.text || '');
  const trimmed = body.trim();
  const preview = trimmed.slice(0, 200).replace(/\s+/g, ' ');
  const declared = String(fetched.type || '');
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');

  if (!looksJson) {
    return {
      endpoint,
      openedFrom: opened,
      status: fetched.status,
      type: declared,
      bytes: fetched.bytes,
      codes,
      notJson: true,
      preview,
      failed: `the endpoint answered ${declared.split(';')[0] || 'no content-type'} that does not begin as JSON`
        + (trimmed.startsWith('<') ? ' — this is a page, not an API response (a bot wall, a redirect or a 404)' : '')
    };
  }

  const value = parseLoosely(body);
  if (!value) {
    return {
      endpoint, openedFrom: opened, status: fetched.status, type: declared, bytes: fetched.bytes,
      codes, notJson: true, preview, failed: 'the response did not parse as JSON'
    };
  }
  if (looksLikeSchemaOrg(value)) {
    return {
      endpoint, openedFrom: opened, status: fetched.status, type: declared, bytes: fetched.bytes,
      codes, notJson: true, preview,
      failed: 'the response is schema.org markup, not commerce data — it is written for crawlers, and this command will not report it as an endpoint\'s answer'
    };
  }

  const source = `network ${endpoint}`;
  const payloads = [{ source, value }];
  const hits = productRecords(value, codes, source);
  const forUrl = settings.forUrl || endpoint;
  const built = dataCandidates({ responses: [{ url: endpoint, text: body, mentions: codes }] }, forUrl);

  /* Nothing but this response may reach the verdict. The DOM is not
     read here, the page's JSON-LD is not read here, and a candidate
     from anywhere else would be a bug rather than a finding. */
  const candidates = built.filter((candidate) => candidate.record && candidate.record.source === source);
  const foreign = built.length - candidates.length;

  /* "Does this endpoint price the product" is a question about each
     identity the product answers to, and it has to count the amounts
     kept under a variant code as well as the ones on the record itself
     — UNIQLO's endpoint keeps every price in a map keyed by variant. So
     this is built from the candidates the parser would build, not from
     the direct hits alone. */
  const byCode = {};
  for (const candidate of candidates) {
    const identity = priceIdentity(candidate, forUrl);
    const charged = chargedEvidence(candidate);
    const key = identity.code || candidate.record.code;
    byCode[key] = byCode[key] || { code: key, priced: [], refused: [] };
    const entry = {
      amount: candidate.amount,
      currency: candidate.currency,
      field: candidate.record.field,
      at: candidate.record.path,
      variant: identity.variant || null,
      via: identity.via || null,
      why: identity.ok ? charged.why : identity.why
    };
    (identity.ok && charged.ok ? byCode[key].priced : byCode[key].refused).push(entry);
  }

  return {
    endpoint,
    openedFrom: opened,
    status: fetched.status,
    type: fetched.type,
    bytes: fetched.bytes,
    codes,
    hits,
    byCode: Object.values(byCode),
    related: relatedIdentifiers(payloads, codes),
    variants: variantPriceRecords(payloads, codes),
    table: variantTable(value),
    colours: colourFields(value),
    amounts: allAmounts(value),
    sources: [...new Set(candidates.map((candidate) => candidate.record.source))],
    foreign,
    verdict: decide(candidates, forUrl)
  };
}

function printEndpointInspection(report) {
  console.log(`\n  ${short(report.endpoint, 140)}`);
  if (report.openedFrom) console.log(`  fetched from  ${short(report.openedFrom, 120)}`);
  if (report.failed) {
    if (report.status) console.log(`  answered      ${report.status} ${String(report.type || '').split(';')[0]}, ${size(report.bytes || 0)}`);
    console.log(`  NOT INSPECTED: ${report.failed}`);
    if (report.preview) console.log(`  it begins     ${short(report.preview, 140)}`);
    console.log('  No price can come from this. Nothing else was read — this command');
    console.log('  does not fall back to the page, its DOM or its JSON-LD.\n');
    return;
  }

  console.log(`  answered      ${report.status} ${report.type.split(';')[0]}, ${size(report.bytes)}`);
  console.log(`  looking for   ${report.codes.slice(0, 8).join(', ')}`);

  console.log(`\n  records carrying one of those codes AND an amount (${report.hits.length}):`);
  if (!report.hits.length) {
    console.log(report.variants.priced.length
      ? '     none directly — this endpoint keeps its amounts under variant codes, below'
      : '     none');
  }
  for (const hit of report.hits.slice(0, 15)) {
    console.log(`     $${hit.amount}${hit.currency ? ' ' + hit.currency : ' (no currency named)'}${hit.kind === 'list' ? '  [list field]' : ''}${hit.elsewhere ? `  [under "${hit.elsewhere}"]` : ''}`);
    console.log(`       record ${short(hit.recordPath, 100)}  (${hit.codeKey}: ${hit.code})`);
    console.log(`       field  ${short(hit.field, 100)}`);
    if (hit.context && hit.context.availability) console.log(`       stock  ${hit.context.availability}`);
  }

  if (report.related.length) {
    console.log(`\n  other identities in the same records (${report.related.length}):`);
    for (const other of report.related.slice(0, 10)) console.log(`     ${other.code}  (${other.where[0].key})`);
  }

  if (report.colours.length) {
    console.log(`\n  colour and display fields (${report.colours.length}):`);
    for (const colour of report.colours.slice(0, 10)) console.log(`     ${short(colour.path, 80)} = ${colour.value}`);
  }

  if (report.variants.priced.length) {
    console.log(`\n  prices kept under a variant code (${report.variants.priced.length}):`);
    for (const hit of report.variants.priced.slice(0, 10)) {
      console.log(`     $${hit.amount}${hit.currency ? ' ' + hit.currency : ''} for ${hit.code} at ${short(hit.field, 70)}`);
    }
  }

  console.log(`\n  every amount-looking field in the response (${report.amounts.length}${report.amounts.length === 60 ? '+' : ''}):`);
  for (const amount of report.amounts.slice(0, 20)) {
    console.log(`     ${short(amount.path, 90)} = ${amount.amount}${amount.currency ? ' ' + amount.currency : ''}${amount.kind === 'list' ? ' [list]' : ''}`);
  }

  const table = report.table || { rows: [], maps: [], joined: [] };
  if (table.rows.length || table.maps.length) {
    console.log(`\n  variant records and the price map (${table.rows.length} record${table.rows.length === 1 ? '' : 's'}, ${table.maps.length} priced key${table.maps.length === 1 ? '' : 's'}):`);
    for (const join of table.joined.slice(0, 12)) {
      const ids = join.variant.ids.map((id) => `${id.key}=${id.value}`).join(' · ');
      const described = join.variant.describe.map((d) => `${d.key}=${d.value}`).join(' · ');
      console.log(`     ${short(ids, 130)}`);
      if (described) console.log(`       ${short(described, 130)}`);
      for (const amount of join.map.amounts.slice(0, 4)) {
        console.log(`       $${amount.amount}${amount.currency ? ' ' + amount.currency : ''}${amount.kind === 'list' ? ' [list]' : ''}  ${short(amount.at, 90)}`);
      }
      console.log(`       joined on ${join.on.key} = ${join.on.value}`);
    }
    if (!table.joined.length) {
      console.log('     no variant record\'s identity matches a key in the price map — the two');
      console.log('     structures are here but nothing joins them');
      for (const row of table.rows.slice(0, 4)) console.log(`       record ${short(row.ids.map((id) => id.key + '=' + id.value).join(' · '), 110)}`);
      for (const map of table.maps.slice(0, 4)) console.log(`       priced ${map.key} -> ${map.amounts.map((a) => '$' + a.amount).slice(0, 3).join(', ')}`);
    }
  }

  console.log('\n  does this endpoint carry a selling price for the product?');
  if (!report.byCode.length) {
    console.log('     NO — no record here carries one of those codes together with an amount.');
  }
  for (const entry of report.byCode) {
    const distinct = [...new Set(entry.priced.map((hit) => hit.amount))];
    if (!distinct.length) {
      console.log(`     ${entry.code}: no charged amount — ${entry.refused.length} record${entry.refused.length === 1 ? '' : 's'} refused`);
      for (const refused of entry.refused.slice(0, 3)) console.log(`       $${refused.amount} at ${short(refused.at, 70)} — ${refused.why}`);
    } else if (distinct.length === 1) {
      const first = entry.priced[0];
      console.log(`     ${entry.code}: $${distinct[0]}${first.currency ? ' ' + first.currency : ''} — ${short(first.at, 80)}`);
      if (first.variant) console.log(`       kept under variant ${first.variant}, tied by ${first.via}`);
    } else {
      console.log(`     ${entry.code}: ${distinct.length} different amounts (${distinct.map((n) => '$' + n).join(', ')}) — nothing here says which is charged`);
    }
  }

  console.log(`\n  read from ${report.sources.length ? report.sources.map((source) => short(source, 100)).join(', ') : 'this response alone'}`);
  if (report.foreign) console.log(`  ${report.foreign} candidate(s) from anywhere else were dropped — this command reads one response`);

  const verdict = report.verdict;
  console.log(verdict.price
    ? `\n  THIS ENDPOINT ALONE WOULD WRITE $${verdict.price} — ${verdict.why}\n`
    : `\n  THIS ENDPOINT ALONE WOULD FAIL CLOSED — ${verdict.why || 'no record cleared every gate'}\n`);
}

/* ---------- report ---------- */
const say = (...line) => { if (!asJson) console.log(...line); };

function short(value, width = 96) {
  const text = String(value === null || value === undefined ? '' : value);
  return text.length <= width ? text : `${text.slice(0, width - 14)}…${text.slice(-13)}`;
}

function explainCandidate(pad, entry) {
  say(`  ${pad}   [${entry.gate}] $${entry.amount} ${entry.text ? `"${short(entry.text, 30)}"` : ''}`);
  say(`  ${pad}     from ${entry.from} — ${entry.why}`);
  if (explaining && entry.dom) {
    const dom = entry.dom;
    say(`  ${pad}     dom  ${dom.selector}${dom.itemprop ? ` itemprop=${dom.itemprop}` : ''}${dom.lineThrough ? ' struck' : ''}${dom.hidden ? ' hidden' : ''}`);
    if (dom.own) say(`  ${pad}     own  ${short(dom.own, 70)}`);
    if (dom.near) say(`  ${pad}     near ${short(dom.near, 70)}`);
    say(`  ${pad}     ties ${(dom.codes || []).length ? dom.codes.slice(0, 4).join(', ') : 'no product code in its ancestry'}`);
  }
}

async function main() {
  /* One dispatch, and every command leaves through it. The mode is
     decided before anything is read, so a diagnostic can never become a
     catalogue verification on its way through. */
  if (parsedArgs.errors.length) {
    for (const problem of parsedArgs.errors) console.error(`  ${problem}`);
    console.error(USAGE);
    throw new Error('nothing was run: the command line was not understood');
  }

  const chosen = chooseMode(parsedArgs);
  if (chosen.error) {
    console.error(`  ${chosen.error}`);
    console.error(USAGE);
    throw new Error(`--${chosen.mode} was given nothing usable to read`);
  }

  if (chosen.mode === 'version') {
    printBuild(buildStamp());
    return;
  }

  if (chosen.mode === 'help') {
    console.log(USAGE);
    return;
  }

  if (chosen.mode === 'inspect-api') {
    say('\n  API INSPECTION — one endpoint, fetched from inside the product page.');
    say('  The catalogue is not read, the page\'s DOM and JSON-LD are not read,');
    say('  and nothing is written.');
    const report = await inspectEndpoint(chosen.endpoint, { forUrl: chosen.forUrl, codes: chosen.codes });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printEndpointInspection(report);
    return;
  }

  if (chosen.mode === 'datalayer') {
    say('\n  DATALAYER — the page\'s analytics events, its variant prices and the');
    say('  chain between them. It decides nothing and writes nothing.');
    const report = await inspectDataLayer(chosen.url);
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printDataLayer(report);
    return;
  }

  if (chosen.mode === 'hunt') {
    say('\n  HUNT — every payload one page loaded, searched for what you named.');
    say('  It decides nothing, prices nothing and writes nothing.');
    const report = await huntPage(chosen.url, { find: chosen.find });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printHunt(report);
    return;
  }

  if (chosen.mode === 'inspect-data') {
    say('\n  PAGE DATA INSPECTION — the payloads one page carries. Nothing is written.');
    const report = await inspectData(chosen.url);
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printDataInspection(report);
    return;
  }

  if (chosen.mode === 'inspect') {
    say('\n  PAGE INSPECTION — the figures one page renders. Nothing is written.');
    const report = await inspectUrl(chosen.url);
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printInspection(report);
    return;
  }

  const { source, rows } = readCatalog();

  let targets = rows.filter((r) => r && r.productUrl);
  if (only) targets = targets.filter((r) => r.id === only);

  if (!targets.length) {
    say(only
      ? `\nNo catalogue row with a productUrl has the id ${only}.\n`
      : '\nNo catalogue row carries a productUrl, so there is no page to read a price from.\n');
    if (asJson) console.log(JSON.stringify({ ran: new Date().toISOString(), rows: [] }, null, 2));
    return;
  }

  const priced = (row) => row.price !== null && row.price !== undefined;
  const already = refreshing ? [] : targets.filter(priced);
  const todo = refreshing ? targets : targets.filter((r) => !priced(r));

  say(`\nReading ${todo.length} linked product page${todo.length === 1 ? '' : 's'}${writing ? ', and writing what verifies' : ''}.`);
  if (already.length) {
    say(`${already.length} row${already.length === 1 ? '' : 's'} already carr${already.length === 1 ? 'ies' : 'y'} a price and ${already.length === 1 ? 'is' : 'are'} left alone — pass --refresh to re-read.`);
  }
  say(useBrowser ? 'A page that gives up no price over plain HTTP is opened in a real browser.\n' : 'Plain HTTP only (--no-browser).\n');

  /* a shipped price is re-proved against its own note before anything
     else runs, so a row that lost its provenance is reported here rather
     than quietly trusted */
  for (const row of already) {
    const accounted = catalogRowPrice(row);
    say(`  ${'KEPT'.padEnd(15)} ${row.brand} — $${row.price}`);
    say(`  ${''.padEnd(15)} ${accounted.ok ? accounted.how : `UNACCOUNTED: ${accounted.why}`}`);
  }

  const results = [];
  for (const row of todo) {
    const result = await resolveRow(row);
    result.brand = row.brand;
    result.name = row.name;
    result.productUrl = row.productUrl;
    results.push(result);

    say(`  ${result.verdict.padEnd(15)} ${row.brand} — ${String(row.name).slice(0, 44)}`);
    say(`  ${''.padEnd(15)} · read through ${result.trail.readThrough}`);
    for (const note of result.notes || []) say(`  ${''.padEnd(15)} · ${note}`);
    /* a run that never opened the page cannot be read as evidence about
       what the page draws, and says so where the verdict is */
    if (result.incomplete) say(`  ${''.padEnd(15)} ! ${result.incomplete} (browser: ${result.trail.browser.why})`);
    if (result.price) {
      say(`  ${''.padEnd(15)} $${result.price} ${result.currency || ''}`);
      say(`  ${''.padEnd(15)} ${result.why}${result.from ? ` [${result.from}]` : ''}`);
    } else {
      say(`  ${''.padEnd(15)} ${result.why}`);
      for (const survivor of result.survivors || []) {
        say(`  ${''.padEnd(15)}   $${survivor.amount} — ${survivor.identity}, and ${survivor.charged}`);
      }
      for (const refusal of (result.refusals || []).slice(0, 14)) explainCandidate(''.padEnd(15), refusal);
      const extra = (result.refusals || []).length - 14;
      if (extra > 0) say(`  ${''.padEnd(15)}   …and ${extra} more`);
    }
  }

  const tally = {};
  for (const r of results) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  const verified = results.filter((r) => r.verdict === 'VERIFIED');

  say('\n  ' + ['VERIFIED', 'AMBIGUOUS', 'NO PRICE FOUND', 'UNREACHABLE']
    .filter((k) => tally[k]).map((k) => `${tally[k]} ${k}`).join(', '));

  if (results.some((r) => r.blocked)) {
    const hosts = [...new Set(results.filter((r) => r.blocked).map((r) => new URL(r.productUrl).hostname))].join(', ');
    say('\n  UNREACHABLE here is this machine, not the listings: ' + hosts);
    say('  is refused by the network egress policy, and a real browser is refused');
    say('  the same way. Run this from an ordinary connection, or allow those hosts.');
  }

  if (asJson) {
    const rendered = results.filter((r) => r.trail && r.trail.browser && r.trail.browser.ran);
    console.log(JSON.stringify({
      ran: new Date().toISOString(),
      command: `fetch-catalog-prices ${args.join(' ')}`.trim(),
      /* What this capture can be used to argue. A run that never
         reached a browser holds no evidence about the figures a page
         renders, and saying so here means a reader never has to infer
         it from an absence. */
      readThrough: [...new Set(results.map((r) => (r.trail ? r.trail.readThrough : 'nothing')))],
      complete: results.length > 0 && rendered.length === results.length,
      incomplete: rendered.length === results.length ? null
        : `${results.length - rendered.length} of ${results.length} rows were never opened in a browser, so this capture says nothing about the figures those pages render`,
      kept: already.map((row) => ({ id: row.id, price: row.price, accounted: catalogRowPrice(row) })),
      rows: results.map((r) => ({
        id: r.id,
        brand: r.brand,
        productUrl: r.productUrl,
        verdict: r.verdict,
        readThrough: r.trail ? r.trail.readThrough : null,
        why: r.why,
        price: r.price === undefined ? null : r.price,
        currency: r.currency || null,
        evidence: r.identity || null,
        ambiguous: r.ambiguous || null,
        survivors: r.survivors || null,
        refusals: r.refusals || [],
        notes: r.notes || [],
        trail: r.trail
      }))
    }, null, 2));
  }

  if (!writing) {
    say(verified.length
      ? `\n  Re-run with --write to put ${verified.length} verified price${verified.length === 1 ? '' : 's'} into assets/catalog.js.\n`
      : '\n  Nothing verified, so there is nothing to write. A row keeps price: null\n  rather than a figure the page did not vouch for.\n');
    return;
  }

  if (!verified.length) {
    say('\n  Nothing verified — assets/catalog.js is left exactly as it was.\n');
    return;
  }

  let next = source;
  for (const r of verified) next = writePrice(next, r.id, r.price, r.identity);
  fs.writeFileSync(CATALOG, next);
  say(`\n  Wrote ${verified.length} price${verified.length === 1 ? '' : 's'} into assets/catalog.js.\n`);
}

/* The gates are the part worth testing, and they are decidable without a
   retailer: a captured structured record, a captured price element and
   its ancestry, and what the file looks like afterwards. Required as a
   module it hands those over and runs nothing. */
if (require.main === module) {
  main().catch((err) => { console.error(err && err.message); process.exit(1); });
} else {
  module.exports = {
    toAmount, currencyIn, moneyInText, offerAmounts, structuredCandidates,
    metaCandidates, pricesFromHtml, namesCode, priceIdentity, chargedEvidence,
    decide, gatherPricesInPage, renderedCandidates, renderPage, resolveRow,
    inspectUrl, inspectData, selectedAmong, elsewhereIn, isIdKey, isPriceKey, keyWords,
    sourceAuthority, relatedIdentifiers, markupAudit, looksLikeSchemaOrg,
    currencyByIdentity, identitiesOf, variantChain, idFieldsOf,
    inspectEndpoint, allAmounts, colourFields, variantTable,
    huntPage, huntIn, huntInText, needleForms, scalarMatches, printHunt,
    inspectDataLayer, ecommerceEvents, pricedVariants, priceChains,
    parseArgs, chooseMode, OPTIONS, USAGE, MODES, buildStamp,
    productRecords, dataPayloads, dataCandidates, variantPriceRecords,
    parseLoosely, gatherDataInPage, walkData, namesListing, pricesUnder,
    writePrice, priceEvidenceNote, setPriceEvidence, catalogRowPrice, readCatalog
  };
}
