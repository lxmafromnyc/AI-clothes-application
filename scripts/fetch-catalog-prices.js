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

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : null;
};

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
      return { ok: false, why: `the record names no currency beside ${record.field}, so ${record.amount} could be any` };
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

  const best = inPlay[0];
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
  return keyWords(key).some((word) => ID_WORD.test(word));
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
  try { return JSON.parse(raw); } catch (err) { /* not a bare document */ }

  const assigned = raw.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (assigned) {
    try { return JSON.parse(assigned[1]); } catch (err) { /* not JSON either */ }
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (err) { /* nothing parseable */ }
  }
  return null;
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
    if (value) out.push({ source: `network ${response.url}`, value });
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
          variantKey: variant.key
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

function dataCandidates(data, pageUrl) {
  const ids = identifiersFrom(pageUrl);
  const payloads = dataPayloads(data);
  const out = [];

  for (const payload of payloads) {
    for (const hit of productRecords(payload.value, ids, payload.source)) {
      if (hit.elsewhere) continue; // seen, set aside, never a candidate
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
          if (pending.length >= 80 || response.status() !== 200) return;
          const type = response.headers()['content-type'] || '';
          const at = response.url();
          const jsonish = /json/i.test(type) || /\.json(\?|$)|\/api\/|graphql/i.test(at);
          if (!jsonish) return;
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
        if (!text || text.length > 2000000) continue;
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
  const claimed = String(evidence.sku || evidence.code || '').toLowerCase();
  if (!claimed) return { ok: false, why: 'the recorded evidence names no sku or product code' };

  const bare = claimed.replace(/[^a-z0-9]/g, '');
  const matched = ids.find((id) => bare.includes(id) || id.includes(bare) || namesCode(claimed, id));
  if (!matched) {
    return { ok: false, why: `the recorded ${evidence.sku ? 'sku' : 'code'} ${evidence.sku || evidence.code} is not a code in this row's own listing URL` };
  }

  const kinds = ['json-ld-offer', 'microdata-offer', 'dom-product-scope', 'dom-variant-scope', 'data-product-record', 'data-variant-mapping'];
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

  const value = parseLoosely(fetched.text);
  if (!value) {
    return { endpoint, openedFrom: opened, status: fetched.status, type: fetched.type, bytes: fetched.bytes, codes, failed: 'the response did not parse as JSON' };
  }

  const source = `network ${endpoint}`;
  const payloads = [{ source, value }];
  const hits = productRecords(value, codes, source);
  const forUrl = settings.forUrl || endpoint;
  const candidates = dataCandidates({ responses: [{ url: endpoint, text: fetched.text, mentions: codes }] }, forUrl);

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
    colours: colourFields(value),
    amounts: allAmounts(value),
    verdict: decide(candidates, forUrl)
  };
}

function printEndpointInspection(report) {
  console.log(`\n  ${short(report.endpoint, 140)}`);
  if (report.openedFrom) console.log(`  fetched from  ${short(report.openedFrom, 120)}`);
  if (report.failed) {
    console.log(`  could not be read: ${report.failed}\n`);
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
  /* --inspect <url> : one page's rendered figures, and what each gate
     says about them. Reads nothing from the catalogue and writes
     nothing to it. */
  /* --inspect-api <endpoint> [--for <productUrl>] [--codes a,b,c] */
  const endpoint = flag('--inspect-api');
  if (endpoint) {
    const report = await inspectEndpoint(endpoint, {
      forUrl: flag('--for'),
      codes: (flag('--codes') || '').split(',').map((code) => code.trim()).filter(Boolean)
    });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printEndpointInspection(report);
    return;
  }

  const inspectingData = flag('--inspect-data');
  if (inspectingData) {
    const report = await inspectData(inspectingData);
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else printDataInspection(report);
    return;
  }

  const inspecting = flag('--inspect');
  if (inspecting) {
    const report = await inspectUrl(inspecting);
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
    sourceAuthority, relatedIdentifiers, markupAudit,
    inspectEndpoint, allAmounts, colourFields,
    productRecords, dataPayloads, dataCandidates, variantPriceRecords,
    parseLoosely, gatherDataInPage, walkData, namesListing, pricesUnder,
    writePrice, priceEvidenceNote, setPriceEvidence, catalogRowPrice, readCatalog
  };
}
