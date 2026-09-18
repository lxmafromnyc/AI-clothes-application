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

  /* ---- a rendered figure, judged on its own ancestry ---- */
  const dom = candidate.dom;
  if (dom) {
    const hit = matchingCode(dom.codes, ids);
    if (hit) {
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
  const survivors = [];

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

  if (!survivors.length) return { refusals };

  const distinct = [...new Set(survivors.map((s) => s.candidate.amount))];
  if (distinct.length > 1) {
    return {
      refusals,
      ambiguous: distinct.sort((a, b) => a - b),
      why: `${distinct.length} different amounts each carry evidence of being the charged price (${distinct.sort((a, b) => a - b).map((n) => '$' + n).join(', ')}), and nothing on the page says which one is`,
      survivors: survivors.map((s) => ({
        amount: s.candidate.amount,
        from: s.candidate.from,
        text: s.candidate.text,
        identity: s.identity.how,
        charged: s.charged.how,
        dom: explaining && s.candidate.dom ? s.candidate.dom : undefined
      }))
    };
  }

  const best = survivors[0];
  return {
    refusals,
    price: best.candidate.amount,
    currency: best.candidate.currency,
    from: best.candidate.from,
    identity: best.identity,
    charged: best.charged,
    why: `${best.identity.how}, and ${best.charged.how}`,
    agreed: survivors.length
  };
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
function gatherPricesInPage() {
  const MONEY = /(?:US\s*\$|\$|USD|£|€)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/i;
  const CODE_ATTR = /(product|prod|sku|pid|style|item|code|group|listing)/i;

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
    for (let depth = 0; node && node !== document.body && depth < 8; depth += 1) {
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

  const metas = {};
  for (const el of document.querySelectorAll('meta[property], meta[name]')) {
    const key = el.getAttribute('property') || el.getAttribute('name');
    if (key) metas[key.toLowerCase()] = el.getAttribute('content');
  }

  return {
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || metas['og:url'] || null,
    metas,
    jsonld: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent),
    prices: out
  };
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
      canonical: seen.canonical || null
    });
  }
  return { candidates: out, empties: structured.empties };
}

/* One page, in a real browser, reported the way fetchPage reports. */
async function renderPage(url) {
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

    const seen = await page.evaluate(gatherPricesInPage);
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
  const trail = { id: row.id, productUrl: row.productUrl, plain: null, browser: null };

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
        return { id: row.id, verdict: 'VERIFIED', why: served.why, price: served.price, currency: served.currency, from: served.from, identity: served.identity, notes, trail };
      }
    }
  } else if (page.blocked) {
    trail.plain = { reachable: false, failed: page.failed, blocked: true };
    return { id: row.id, verdict: 'UNREACHABLE', why: page.failed, price: null, blocked: true, notes, trail };
  } else {
    trail.plain = { reachable: false, failed: page.failed };
    notes.push(`plain HTTP: ${page.failed}`);
  }

  /* ---- a real browser ---- */
  if (!useBrowser) {
    return {
      id: row.id,
      verdict: page.html ? 'NO PRICE FOUND' : 'UNREACHABLE',
      why: `${page.html ? 'nothing usable in the served markup' : page.failed} (browser path off)`,
      price: null,
      refusals: served ? served.refusals : [],
      notes,
      trail
    };
  }

  const rendered = await renderPage(row.productUrl);
  if (rendered.failed) {
    trail.browser = { ran: false, failed: rendered.failed };
    notes.push(`browser: ${rendered.failed}`);
    return {
      id: row.id,
      verdict: page.html ? 'NO PRICE FOUND' : 'UNREACHABLE',
      why: rendered.noBrowser && page.html ? `nothing usable in the served markup, and ${rendered.failed}` : rendered.failed,
      price: null,
      refusals: served ? served.refusals : [],
      notes,
      trail
    };
  }

  const read = renderedCandidates(rendered.seen, row.productUrl);
  trail.browser = {
    ran: true,
    canonical: rendered.seen.canonical || null,
    candidates: read.candidates.map(reportable),
    empties: read.empties,
    /* the DOM behind every figure, which is what a price disagreement
       has to be settled from */
    prices: explaining ? rendered.seen.prices : undefined
  };
  notes.push(`browser: ${read.candidates.length} price candidate${read.candidates.length === 1 ? '' : 's'}`);
  for (const empty of read.empties) {
    notes.push(`browser: ${empty.type}${empty.skus.length ? ` ${empty.skus[0]}` : ''} — ${empty.why}`);
  }

  if (!read.candidates.length) {
    return { id: row.id, verdict: 'NO PRICE FOUND', why: 'the rendered page published no figure that reads as a price either', price: null, refusals: served ? served.refusals : [], notes, trail };
  }

  const found = decide(read.candidates, row.productUrl);
  if (found.price) {
    return { id: row.id, verdict: 'VERIFIED', why: found.why, price: found.price, currency: found.currency, from: found.from, identity: found.identity, notes, trail };
  }

  const refusals = [...(served && served.refusals ? served.refusals : []), ...found.refusals];

  if (found.ambiguous) {
    return {
      id: row.id,
      verdict: 'AMBIGUOUS',
      why: found.why,
      price: null,
      ambiguous: found.ambiguous,
      survivors: found.survivors,
      refusals,
      notes,
      trail
    };
  }

  return {
    id: row.id,
    verdict: 'NO PRICE FOUND',
    why: `${refusals.length} figure${refusals.length === 1 ? '' : 's'} found, none cleared every gate`,
    price: null,
    refusals,
    notes,
    trail
  };
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

  const at = idAt + m.index;
  const indent = m[1].replace(/\n/, '').replace(/price:\s*$/, '');
  const out = source.slice(0, at) + m[1] + String(amount) + source.slice(at + m[0].length);
  return setPriceEvidence(out, id, priceEvidenceNote(evidence), indent);
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

  const kinds = ['json-ld-offer', 'microdata-offer', 'dom-product-scope'];
  if (!kinds.includes(evidence.via)) {
    return { ok: false, why: `the recorded evidence names no recognised kind (${evidence.via || 'none'})` };
  }
  return { ok: true, via: evidence.via, how: `its listing ties ${evidence.sku || evidence.code} to this price by ${evidence.via}` };
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
    for (const note of result.notes || []) say(`  ${''.padEnd(15)} · ${note}`);
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
    console.log(JSON.stringify({
      ran: new Date().toISOString(),
      command: `fetch-catalog-prices ${args.join(' ')}`.trim(),
      kept: already.map((row) => ({ id: row.id, price: row.price, accounted: catalogRowPrice(row) })),
      rows: results.map((r) => ({
        id: r.id,
        brand: r.brand,
        productUrl: r.productUrl,
        verdict: r.verdict,
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
    writePrice, priceEvidenceNote, setPriceEvidence, catalogRowPrice, readCatalog
  };
}
