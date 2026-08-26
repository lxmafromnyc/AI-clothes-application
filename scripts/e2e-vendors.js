/* =========================================================
   Fynd — vendor doubles

   Stand-ins for the two external services, at the HTTP boundary only.
   They exist so the whole chain can be exercised without a key, and they
   are deliberately NOT permissive: each behaves the way its real
   counterpart does, including the parts that make Fynd's own bugs
   visible.

   openai()   answers the way a compliant model answers THIS prompt — it
              obeys the instruction to choose only from the vocabulary it
              was handed. A double that ignored that instruction would
              hide what the instruction costs.

   ninja()    answers like a product search engine: it matches the query
              against an inventory and returns only what matches. A double
              that returned its whole inventory regardless of the query
              would make any query look like it worked.
   ========================================================= */

'use strict';

/* ---------------------------------------------------------
   A small inventory, in the vendor's documented record shape
   --------------------------------------------------------- */

const item = (id, title, terms, store, price, offerUrl) => ({
  product_id: id,
  product_title: title,
  price: `$${price.toFixed(2)}`,
  store_name: store,
  product_photos: [`https://img.example-cdn.com/${id}.jpg`],
  /* Google's own page for the item — never a retailer URL */
  product_page_url: `https://www.google.com/shopping/product/${id}`,
  product_attributes: { Brand: title.split(' ')[0] },
  _terms: terms,
  _offerUrl: offerUrl,
  _offerPrice: price,
  _offerStore: store
});

const INVENTORY = [
  item('h1', 'Champion Reverse Weave Oversized Hoodie, Black', ['hoodie', 'oversized', 'black', 'sweatshirt'], 'Nordstrom', 68, 'https://www.nordstrom.com/s/reverse-weave-hoodie/7654321'),
  item('h2', 'Hanes EcoSmart Fleece Hoodie, Black', ['hoodie', 'black', 'fleece'], 'Walmart', 22.5, 'https://www.walmart.com/ip/hanes-ecosmart-hoodie/1122334'),
  item('h3', 'Nike Sportswear Club Fleece Pullover Hoodie', ['hoodie', 'black', 'fleece', 'pullover'], 'Nike', 60, 'https://www.nike.com/t/sportswear-club-fleece-pullover-hoodie-abc123'),
  item('h4', 'Carhartt Loose Fit Midweight Hoodie, Black', ['hoodie', 'black', 'loose', 'oversized'], 'Carhartt', 54.99, 'https://www.carhartt.com/product/K288/loose-fit-hoodie'),
  item('j1', "Levi's 550 Relaxed Fit Jeans, Medium Blue", ['jeans', 'relaxed', 'blue', 'denim'], 'Macys', 69.5, 'https://www.macys.com/shop/product/levis-550-relaxed-fit-jeans/1234567'),
  item('j2', 'Wrangler Relaxed Fit Jeans, Stonewash Blue', ['jeans', 'relaxed', 'blue', 'denim'], 'Walmart', 29.94, 'https://www.walmart.com/ip/wrangler-relaxed-jeans/5566778'),
  item('j3', 'Gap Standard Fit Jeans, Dark Indigo', ['jeans', 'blue', 'denim', 'standard'], 'Gap', 79.95, 'https://www.gap.com/browse/product.do?pid=440111002'),
  item('s1', 'Van Heusen Regular Fit Oxford Shirt, White', ['shirt', 'white', 'button-up', 'oxford', 'button'], 'Kohls', 39.99, 'https://www.kohls.com/product/prd-4512345/van-heusen-oxford-shirt.jsp'),
  item('s2', 'Amazon Essentials Slim-Fit Poplin Shirt, White', ['shirt', 'white', 'button-up', 'poplin', 'button'], 'Amazon', 24.9, 'https://www.amazon.com/dp/B07CFDKPTP'),
  item('s3', 'Uniqlo Extra Fine Cotton Broadcloth Shirt, White', ['shirt', 'white', 'button-up', 'cotton', 'button'], 'Uniqlo', 29.9, 'https://www.uniqlo.com/us/en/products/E455650-000/00'),
  item('k1', 'Everlane Cashmere Crew Sweater, Oatmeal', ['sweater', 'knit', 'neutral', 'minimal', 'fall'], 'Everlane', 130, 'https://www.everlane.com/products/womens-cashmere-crew-oatmeal'),
  item('k2', 'COS Merino Wool Jumper, Beige', ['sweater', 'knit', 'neutral', 'minimal', 'fall', 'wool'], 'COS', 89, 'https://www.cos.com/en_usd/men/knitwear/product.merino-wool-jumper-beige.1099999.html'),
  item('k3', 'Arket Wool Cardigan, Stone', ['cardigan', 'knit', 'neutral', 'minimal', 'fall', 'wool'], 'Arket', 119, 'https://www.arket.com/en/product/wool-cardigan-stone-1234567.html'),
  item('n1', 'Adidas Grand Court Sneakers, Black', ['sneakers', 'sneaker', 'black', 'shoes', 'trainers'], 'Adidas', 64.99, 'https://www.adidas.com/us/grand-court-shoes/GW9199.html'),
  item('n2', 'Converse Chuck Taylor All Star Low, Black', ['sneakers', 'sneaker', 'black', 'shoes', 'trainers'], 'Converse', 55, 'https://www.converse.com/shop/p/chuck-taylor-all-star-low-top/M5039.html'),
  item('n3', 'Vans Old Skool Sneakers, Black/White', ['sneakers', 'sneaker', 'black', 'shoes', 'skate'], 'Zappos', 70, 'https://www.zappos.com/p/vans-old-skool-black-white/product/7212868'),
  item('t1', 'Uniqlo Supima Cotton Crew Neck T-Shirt, White', ['tee', 't-shirt', 'white', 'cotton'], 'Uniqlo', 14.9, 'https://www.uniqlo.com/us/en/products/E422990-000/00'),
  item('c1', 'Everlane ReNew Long Puffer Coat, Black', ['coat', 'puffer', 'black', 'winter'], 'Everlane', 198, 'https://www.everlane.com/products/womens-renew-long-puffer-black')
];

/* A query matches an item when the item covers the query's meaningful
   terms. Terms the item does not know about count against it, exactly
   the way an over-constrained phrase loses results on a real engine. */
const STOPWORDS = new Set(['for', 'the', 'and', 'a', 'an', 'with', 'under', 'over', 'clothes', 'clothing', 'wear', 'my']);

function matches(item, query) {
  const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t && !STOPWORDS.has(t));
  if (!terms.length) return 0;
  const known = new Set(item._terms.concat(item.product_title.toLowerCase().split(/[\s,./]+/)));
  const hits = terms.filter((t) => [...known].some((k) => k === t || k.startsWith(t) || t.startsWith(k))).length;
  /* every term must land somewhere, like a search engine ANDing them */
  return hits === terms.length ? hits : 0;
}

function ninja(options) {
  const o = options || {};
  const state = { searchCalls: 0, offerCalls: 0, lastQuery: null, queries: [] };

  const handler = async (href) => {
    const url = new URL(href);

    if (url.pathname.endsWith('/search')) {
      state.searchCalls += 1;
      const q = url.searchParams.get('q') || '';
      state.lastQuery = q;
      state.queries.push(q);
      if (o.searchStatus) return { status: o.searchStatus, body: o.searchBody || { error: 'rate limited' }, headers: o.headers };
      if (o.searchDelayMs) return { status: 200, body: { status: 'OK', data: [] }, delayMs: o.searchDelayMs };
      if (o.malformedSearch) return { status: 200, body: { status: 'OK', data: { unexpected: true } } };

      const min = Number(url.searchParams.get('min_price')) || 0;
      const max = Number(url.searchParams.get('max_price')) || Infinity;
      const limit = Number(url.searchParams.get('limit')) || 12;
      const found = INVENTORY
        .map((it) => ({ it, score: matches(it, q) }))
        .filter((r) => r.score > 0 && r.it._offerPrice >= min && r.it._offerPrice <= max)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => {
          const copy = Object.assign({}, r.it);
          delete copy._terms; delete copy._offerUrl; delete copy._offerPrice; delete copy._offerStore;
          return copy;
        });
      return { status: 200, body: { status: 'OK', request_id: 'req', data: found } };
    }

    if (url.pathname.endsWith('/product-offers')) {
      state.offerCalls += 1;
      if (o.offerStatus) return { status: o.offerStatus, body: { error: 'rate limited' }, headers: o.headers };
      if (o.offerDelayMs) return { status: 200, body: { status: 'OK', data: [] }, delayMs: o.offerDelayMs };
      if (o.offersEmpty) return { status: 200, body: { status: 'OK', data: [] } };
      /* every Nth lookup fails, to prove one bad lookup cannot sink a search */
      if (o.offerFailEvery && state.offerCalls % o.offerFailEvery === 0) {
        return { status: 500, body: { error: 'upstream' } };
      }
      const id = url.searchParams.get('product_id');
      const found = INVENTORY.find((it) => it.product_id === id);
      if (!found) return { status: 200, body: { status: 'OK', data: [] } };
      return {
        status: 200,
        body: {
          status: 'OK',
          data: [
            { store_name: found._offerStore, price: `$${found._offerPrice.toFixed(2)}`, offer_page_url: found._offerUrl, product_condition: 'NEW' },
            { store_name: 'eBay', price: `$${(found._offerPrice * 0.9).toFixed(2)}`, offer_page_url: `https://www.ebay.com/itm/${found.product_id}` }
          ]
        }
      };
    }
    return { status: 404, body: { error: 'unknown endpoint' } };
  };
  handler.state = state;
  return handler;
}

/* ---------------------------------------------------------
   The model
   --------------------------------------------------------- */

const CATEGORY_WORDS = {
  hoodie: ['hoodie', 'hoodies', 'sweatshirt'], jeans: ['jeans', 'denim'], shirt: ['shirt', 'button-up', 'button up', 'oxford'],
  tee: ['tee', 't-shirt', 'tshirt'], sneakers: ['sneaker', 'sneakers', 'trainers', 'shoes'],
  sweater: ['sweater', 'jumper', 'knit'], coat: ['coat', 'overcoat', 'parka'], jacket: ['jacket', 'blazer'],
  dress: ['dress'], skirt: ['skirt'], shorts: ['shorts'], trousers: ['trousers', 'pants', 'chinos']
};
const COLOR_WORDS = { black: ['black'], white: ['white'], blue: ['blue', 'navy', 'indigo'], neutral: ['neutral', 'beige', 'oatmeal', 'stone', 'grey', 'gray'], green: ['green'], red: ['red'] };
const FIT_WORDS = { oversized: ['oversized', 'oversize', 'boxy'], relaxed: ['relaxed', 'loose', 'baggy'], slim: ['slim', 'fitted', 'skinny'], regular: ['regular'] };
const OCCASION_WORDS = { everyday: ['everyday', 'daily', 'casual'], school: ['school'], work: ['work', 'office'], evening: ['evening', 'party'], weekend: ['weekend'] };

const pick = (text, groups) => Object.keys(groups).filter((k) => groups[k].some((w) => text.includes(w)));

/* Honours "choose only from that list" when a list is supplied, which is
   what the deployed prompt asks a model to do. */
function constrain(values, allowed) {
  if (!Array.isArray(allowed) || !allowed.length) return values;
  const lower = allowed.map((a) => String(a).toLowerCase());
  const SYNONYM = { hoodie: 'knit', sweater: 'knit', sweatshirt: 'knit', jeans: 'trousers', sneakers: 'sneaker', pants: 'trousers' };
  return values.map((v) => {
    if (lower.includes(v)) return allowed[lower.indexOf(v)];
    const mapped = SYNONYM[v];
    if (mapped && lower.includes(mapped)) return allowed[lower.indexOf(mapped)];
    return null;
  }).filter(Boolean);
}

function openai(options) {
  const o = options || {};
  /* `drifting: true` emulates a model that ignores the instruction and
     maps the garment onto the vocabulary anyway — the failure mode the
     server-side fallback has to survive without the model's help. */
  const state = { calls: 0, lastPrompt: null };
  const handler = async (href, init) => {
    state.calls += 1;
    if (o.status) return { status: o.status, body: o.body || { error: { message: 'insufficient_quota', type: 'insufficient_quota' } } };
    if (o.delayMs) return { status: 200, body: {}, delayMs: o.delayMs };
    if (o.garbage) return { status: 200, body: { choices: [{ message: { content: 'not json at all' } }] } };

    const sent = JSON.parse(init.body);
    const userMessage = sent.messages[sent.messages.length - 1].content;
    state.lastPrompt = userMessage;
    const query = userMessage.split("Shopper's request:")[1].trim().toLowerCase();
    let vocabulary = {};
    try { vocabulary = JSON.parse(userMessage.split('Vocabulary available in the catalogue:')[1].split("\n\nShopper's request:")[0]); } catch (e) { vocabulary = {}; }

    const under = query.match(/(?:under|below|less than|up to)\s*\$?\s*(\d+(?:\.\d+)?)/);
    const preferences = {
      /* the prompt tells the model to keep the shopper's garment word,
         so a compliant model does not map it onto a local vocabulary */
      categories: o.drifting
        ? constrain(pick(query, CATEGORY_WORDS), vocabulary.categories)
        : pick(query, CATEGORY_WORDS),
      colors: constrain(pick(query, COLOR_WORDS), vocabulary.colors),
      fits: constrain(pick(query, FIT_WORDS), vocabulary.fits),
      occasions: constrain(pick(query, OCCASION_WORDS), vocabulary.occasions),
      brands: [], styles: [],
      maxPrice: under ? Number(under[1]) : null,
      minPrice: null,
      season: (query.match(/\b(spring|summer|fall|autumn|winter)\b/) || [])[1] || null,
      gender: (query.match(/\b(women|men|womens|mens|unisex)\b/) || [])[1] || null,
      keywords: query.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2)
    };
    return { status: 200, body: { choices: [{ message: { content: JSON.stringify(preferences) } }] } };
  };
  handler.state = state;
  return handler;
}

/* One double that routes by host. */
function vendors(openaiOpts, ninjaOpts) {
  const ai = openai(openaiOpts);
  const shop = ninja(ninjaOpts);
  const handler = async (href, init) => {
    if (href.includes('api.openai.com')) return ai(href, init);
    if (href.includes('api.openwebninja.com')) return shop(href, init);
    return { status: 404, body: { error: 'unexpected host' } };
  };
  handler.openai = ai.state;
  handler.ninja = shop.state;
  return handler;
}

module.exports = { vendors, openai, ninja, INVENTORY, matches };
