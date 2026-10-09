#!/usr/bin/env node
/* =========================================================
   Fynd — descriptive-request benchmark (offline)

   Does Fynd find better products for people who do not know what the
   clothes are called? Measured, not asserted: each request below is put
   through the REAL server path —

     1. the reading      the page's local reader (assets/interpret.js),
                         and the served interpreter (api/interpret.js
                         interpretQuery) with the model's answer stubbed
                         EMPTY, so only the deterministic part of its
                         reading counts and no model is credited or
                         blamed for anything
     2. the intent       api/search.js shapeIntent()
     3. the search       api/search.js searchWithFallback(): the real
                         OpenWeb Ninja adapter, its offer lookups, the
                         verification gate, the garment filter and, where
                         it exists, the ranking

   — with `fetch` stubbed by a stand-in for the provider: a plain
   word-matching search over the fixed pool in bench-concepts-pool.js.
   It is NOT Google Shopping. It rewards a phrase whose words are in a
   listing's title and nothing else, so what it measures is the phrase
   Fynd asks and the order Fynd shows — the parts this code controls —
   and not how a real index would answer.

   The same harness runs against any checkout (--root), so before and
   after are the same measurement:

     git worktree add /tmp/fynd-base <base-commit>
     node scripts/bench-concepts.js --root /tmp/fynd-base --out before.json
     node scripts/bench-concepts.js --out after.json
     node scripts/bench-concepts.js --compare before.json after.json

   Each result in the first page shown is graded by what the request
   meant: 2 a strong match, 1 acceptable, 0 not what was asked for.
   Grades are written per request below, before any run, from the
   request's words — not from what any version returned.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { POOL } = require('./bench-concepts-pool.js');

const SHOWN = 8;

/* [category, request, strong, acceptable, wrong] — wrong overrides both */
const CASES = [
  /* exact: the shopper names the garment in shop words */
  ['exact', 'black oversized hoodie under $80', /hoodie.*black|black.*hoodie/i, /hoodie/i, /graphic|tie dye|skull|logo/i],
  ['exact', 'cream linen midi dress for summer', /(cream|ivory).*linen.*midi|linen.*midi.*(cream|ivory)|cream midi.*linen/i, /linen.*dress|midi dress/i, /gown|sequin|cocktail/i],
  ['exact', 'vintage Prada bag under $500', /vintage prada/i, /prada/i, null],
  ['exact', 'black wide leg trousers', /wide leg.*black|black.*wide leg|palazzo.*black/i, /trouser|pants/i, /jean|legging|jogger|skinny/i],
  ['exact', 'navy quarter zip pullover', /quarter.?zip.*navy|navy.*quarter/i, /quarter.?zip|half zip/i, null],
  ['exact', 'cropped denim jacket', /cropped.*denim|cropped trucker/i, /cropped.*jacket|denim jacket/i, null],

  /* comparative: described by what it is like */
  ['comparative', 'something like a hoodie but cleaner', /quarter.?zip|half zip|crewneck sweatshirt|knit pullover|crewneck sweater|(essential|minimal|plain).*hoodie/i, /sweatshirt|sweater|hoodie|pullover/i, /graphic|tie dye|skull|logo|cartoon|christmas|distressed|jacket|zip up/i],
  ['comparative', 'something like a hoodie but more polished', /quarter.?zip|half zip|crewneck sweatshirt|knit pullover|crewneck sweater|fine knit/i, /sweatshirt|sweater|hoodie|pullover/i, /graphic|tie dye|skull|logo|cartoon|christmas|distressed|jacket/i],
  ['comparative', 'a shirt that looks like a jacket', /overshirt|shirt jacket|shacket|chore (jacket|coat)/i, /utility jacket|lightweight jacket|flannel/i, /bomber|puffer|leather|parka|windbreaker|rain jacket|varsity|blazer|moto/i],
  ['comparative', 'between a shirt and a jacket', /overshirt|shirt jacket|shacket|chore (jacket|coat)/i, /utility jacket|lightweight jacket/i, /bomber|puffer|leather|parka|windbreaker|rain jacket|varsity|blazer|moto/i],
  ['comparative', 'a jacket like a bomber but less loud', /bomber|varsity|harrington/i, /jacket/i, /puffer|parka|leather|rain/i],

  /* visual and vague: what it should look like */
  ['visual', 'loose black pants that look nice', /(wide leg|palazzo|relaxed|pleated).*(black)|black.*(wide leg|palazzo|relaxed|pleated)/i, /wide leg|palazzo|relaxed|pleated|tailored trouser/i, /skinny|legging|jogger|sweatpant|jean|cargo|slim/i],
  ['visual', "a dress that's simple but not too formal", /shift dress|t-shirt dress|shirt dress|jersey dress|simple cotton/i, /dress/i, /gown|sequin|cocktail|formal|evening|bodycon/i],
  ['visual', 'a bag that looks vintage but not crazy expensive', /vintage (style|inspired)|retro/i, /shoulder bag|top handle|saddle/i, /prada|gucci/i],
  ['vague', 'something cozy', /sweater|sweatshirt|cardigan|fleece|sherpa|hoodie/i, /knit|lounge/i, null],

  /* contextual: named by what it is worn with */
  ['contextual', 'something cozy I can wear with jeans', /sweater|sweatshirt|cardigan|hoodie|fleece|sherpa/i, /knit|flannel/i, /jean|pant|trouser|legging|jogger|short/i],
  ['contextual', 'that short jacket thing people wear over shirts', /cropped.*jacket|overshirt|shirt jacket|shacket|cropped trucker/i, /chore|utility|denim jacket/i, /puffer|parka|leather|blazer|rain|tee|shirt$|oxford|button down/i],
  ['contextual', 'something to wear over a dress', /cardigan|cropped.*jacket|shrug/i, /jacket|denim jacket/i, /dress|gown/i],
  ['contextual', 'a white tee to wear under a blazer', /white.*(tee|t-shirt)|(tee|t-shirt).*white/i, /tee|t-shirt/i, /blazer|jacket/i],

  /* incomplete: little to go on — must not be made up */
  ['incomplete', 'something nice for dinner', /blouse|silk|satin|slip dress|shift dress|tailored|blazer|pleated trouser|wrap dress/i, /dress|trouser|shirt|camisole|heel/i, /hoodie|sweatpant|jogger|graphic|legging|sneaker/i],
  ['incomplete', 'cozy top', /sweater|sweatshirt|knit top|cardigan|fleece/i, /hoodie|knit/i, /jean|pant|dress/i],

  /* slang and informal */
  ['slang', 'comfy fit to wear with my baggy jeans', /sweater|sweatshirt|cardigan|hoodie|fleece|sherpa/i, /knit|flannel/i, /jean|pant|trouser|legging|jogger/i],
  ['slang', 'lowkey hoodie but not as sloppy', /(essential|minimal|plain).*hoodie|hoodie.*(essential|minimal|plain)|organic cotton hoodie/i, /hoodie/i, /graphic|tie dye|skull|logo|distressed/i],
  ['slang', 'jacket thing thats kinda like a shirt', /overshirt|shirt jacket|shacket|chore (jacket|coat)/i, /utility jacket|lightweight jacket/i, /bomber|puffer|leather|parka|windbreaker|rain jacket|varsity|blazer|moto/i]
];

function grade(title, [, , strong, ok, wrong]) {
  if (wrong && wrong.test(title)) return 0;
  if (strong && strong.test(title)) return 2;
  if (ok && ok.test(title)) return 1;
  return 0;
}

/* ---------- the stand-in provider ---------- */

function singular(word) {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(word)) return word.slice(0, -2);
  if (/ss$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}
const tokens = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(singular);
/* the few equivalences any shopping index knows, so neither version is
   punished for "pants" where a shop wrote "trousers" */
const SAME = { pant: ['trouser'], trouser: ['pant'], tee: ['t', 'shirt'], hoody: ['hoodie'] };

const docs = POOL.map((item) => ({ item, words: new Set(tokens(item.title)) }));
const df = {};
docs.forEach(({ words }) => words.forEach((w) => { df[w] = (df[w] || 0) + 1; }));
const idf = (w) => Math.log(1 + POOL.length / (df[w] || 0.5));

function searchPool(q, { limit, min, max }) {
  const asked = [...new Set(tokens(q))];
  return docs.map(({ item, words }, at) => {
    let score = 0;
    for (const word of asked) {
      if (words.has(word) || (SAME[word] || []).some((other) => words.has(other))) score += idf(word);
    }
    return { item, at, score: score / Math.sqrt(words.size) };
  })
    .filter((one) => one.score > 0)
    .filter((one) => (!max || one.item.price <= max) && (!min || one.item.price >= min))
    .sort((a, b) => (b.score - a.score) || (a.at - b.at))
    .slice(0, limit)
    .map(({ item }) => ({
      product_id: item.id,
      product_title: item.title,
      product_photos: [`https://img.example-cdn.com/pool/${item.id}.jpg`],
      product_page_url: `https://www.google.com/shopping/product/${item.id}`,
      product_attributes: { Brand: item.brand }
    }));
}

const byId = new Map(POOL.map((item) => [item.id, item]));
const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

function stubFetch(calls) {
  return async (input) => {
    const url = new URL(String(input && input.url ? input.url : input));
    if (url.hostname === 'api.openai.com') {
      calls.model += 1;
      return reply({ choices: [{ message: { content: '{}' } }], usage: { total_tokens: 0 } });
    }
    if (url.pathname.endsWith('/search')) {
      calls.search += 1;
      calls.asked.push(url.searchParams.get('q'));
      const data = searchPool(url.searchParams.get('q'), {
        limit: Number(url.searchParams.get('limit')) || 24,
        min: Number(url.searchParams.get('min_price')) || 0,
        max: Number(url.searchParams.get('max_price')) || 0
      });
      return reply({ status: 'OK', data });
    }
    if (url.pathname.endsWith('/product-offers')) {
      calls.offers += 1;
      const item = byId.get(url.searchParams.get('product_id'));
      return reply({ status: 'OK', data: { offers: item ? [{ store_name: item.store, price: `$${item.price}.00`, offer_page_url: `https://www.${item.store}/products/${item.id}` }] : [] } });
    }
    calls.other += 1;
    throw new Error(`the benchmark has no stand-in for ${url.hostname}${url.pathname}`);
  };
}

/* what the garment filter removes after the gate, as opposed to what the
   gate itself refuses */
const FILTER_REASONS = new Set(['contradicts-the-requested-garment', 'ruled-out-by-the-request']);

/* ---------- one run, against one checkout ---------- */

async function run(root, cases) {
  const list = cases || CASES;
  Object.assign(process.env, { OPENWEBNINJA_API_KEY: 'bench', OPENAI_API_KEY: 'bench', FYND_CACHE: 'off' });
  ['PRODUCT_SOURCE', 'SERPER_API_KEY', 'SERPAPI_API_KEY', 'AI_PROVIDER'].forEach((key) => { delete process.env[key]; });
  const from = (file) => require(path.join(root, file));
  from('assets/interpret.js');
  const page = globalThis.Interpreter;
  const { interpretQuery } = from('api/interpret.js');
  const { shapeIntent, searchWithFallback } = from('api/search.js');
  const { getProvider } = from('api/_providers/product-source.js');
  const { queryFrom } = from('api/_providers/query.js');
  const cache = from('api/_cache.js');

  const readings = {
    local: async (query) => page.localInterpret(query, {}),
    served: async (query) => {
      const read = await interpretQuery({ query, vocabulary: {} });
      if (!read.ok) throw new Error(`the served reading failed: ${read.reason}`);
      return read.preferences;
    }
  };

  const out = { root, readings: {} };
  for (const [name, read] of Object.entries(readings)) {
    out.readings[name] = [];
    for (const one of list) {
      const [category, query] = one;
      const expect = one[5] || {};
      cache.reset();
      const calls = { search: 0, offers: 0, model: 0, other: 0, asked: [] };
      const realFetch = global.fetch;
      global.fetch = stubFetch(calls);
      let found;
      let intent;
      try {
        intent = shapeIntent(await read(query));
        calls.model = 0;
        found = await searchWithFallback(getProvider(), intent, 12, cache.counters(), Date.now() + 60000);
      } finally {
        global.fetch = realFetch;
      }
      const shown = found.products.slice(0, SHOWN);
      const grades = shown.map((p) => grade(p.name, one));
      const phrase = queryFrom(intent);
      const removed = Array.isArray(found.semanticRemoved) ? found.semanticRemoved : [];
      out.readings[name].push({
        category,
        query,
        asked: calls.asked,
        phrase,
        garments: intent.garments,
        /* the reading itself went wrong: the phrase asked for what the
           request ruled out, or missed what it plainly asked for */
        falseReading: (expect.phraseNot && expect.phraseNot.test(phrase) ? 1 : 0) + (expect.phraseHas && !expect.phraseHas.test(phrase) ? 1 : 0),
        /* a result the request ruled out, or one over a stated budget */
        hardViolations: shown.filter((p) => (expect.shownNot && expect.shownNot.test(p.name)) || (intent.maxPrice && p.price > intent.maxPrice)).length,
        /* products the garment filter removed that the request would
           have accepted */
        removedRelevant: removed.filter((r) => grade(r.name, one) > 0).length,
        shown: shown.map((p) => p.name),
        grades,
        relevant: grades.filter((g) => g > 0).length,
        strong: grades.filter((g) => g === 2).length,
        wrong: grades.filter((g) => g === 0).length,
        firstStrong: grades.indexOf(2) + 1,
        calls: { search: calls.search, offers: calls.offers, other: calls.other },
        reachedGate: found.records.length,
        /* passed the gate: what is shown, plus what the garment filter
           then removed */
        verified: found.products.length + removed.length,
        rejectedByGate: Object.entries(found.rejected || {}).filter(([k]) => !FILTER_REASONS.has(k)).reduce((sum, [, n]) => sum + n, 0),
        removedAsAnotherGarment: removed.length,
        /* why the gate refused what it refused: a record the capped
           lookups never reached has no link, which is not a record the
           gate judged and failed */
        gateReasons: Object.fromEntries(Object.entries(found.rejected || {}).filter(([k]) => !FILTER_REASONS.has(k)))
      });
    }
  }
  return out;
}

/* ---------- reporting ---------- */

const sum = (list, field) => list.reduce((total, one) => total + one[field], 0);

function compare(before, after) {
  const lines = [];
  for (const reading of Object.keys(after.readings)) {
    const b = before.readings[reading];
    const a = after.readings[reading];
    lines.push(`\n## ${reading === 'local' ? 'Local reading (the page\'s fallback reader)' : 'Served reading (api/interpret.js, model answer stubbed empty)'}\n`);
    lines.push('| category | request | relevant@8 before → after | strong@8 | wrong@8 | provider calls (search+offers) | phrase asked after |');
    lines.push('|---|---|---|---|---|---|---|');
    a.forEach((row, at) => {
      const old = b[at];
      lines.push(`| ${row.category} | ${row.query} | ${old.relevant} → ${row.relevant} | ${old.strong} → ${row.strong} | ${old.wrong} → ${row.wrong} | ${old.calls.search}+${old.calls.offers} → ${row.calls.search}+${row.calls.offers} | \`${row.phrase}\` |`);
    });
    const cats = [...new Set(a.map((row) => row.category))];
    lines.push('\n| category | requests | relevant@8 | strong@8 | wrong@8 | improved | worse | unchanged |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const cat of cats.concat(['ALL'])) {
      const pick = (list) => list.filter((row) => cat === 'ALL' || row.category === cat);
      const ar = pick(a);
      const br = pick(b);
      let improved = 0; let worse = 0; let same = 0;
      ar.forEach((row) => {
        const old = b.find((x) => x.query === row.query);
        const delta = (row.strong * 2 + row.relevant - row.wrong * 2) - (old.strong * 2 + old.relevant - old.wrong * 2);
        if (delta > 0) improved += 1; else if (delta < 0) worse += 1; else same += 1;
      });
      lines.push(`| ${cat} | ${ar.length} | ${sum(br, 'relevant')} → ${sum(ar, 'relevant')} | ${sum(br, 'strong')} → ${sum(ar, 'strong')} | ${sum(br, 'wrong')} → ${sum(ar, 'wrong')} | ${improved} | ${worse} | ${same} |`);
    }
    const calls = (list) => ({ search: sum(list.map((r) => ({ n: r.calls.search })), 'n'), offers: sum(list.map((r) => ({ n: r.calls.offers })), 'n') });
    const cb = calls(b); const ca = calls(a);
    lines.push(`\nprovider calls per search: search ${(cb.search / b.length).toFixed(2)} → ${(ca.search / a.length).toFixed(2)}, offer lookups ${(cb.offers / b.length).toFixed(2)} → ${(ca.offers / a.length).toFixed(2)}, unexpected ${sum(b.map((r) => ({ n: r.calls.other })), 'n')} → ${sum(a.map((r) => ({ n: r.calls.other })), 'n')}`);
    const rate = (list) => { const reached = list.reduce((t, r) => t + r.verified + r.rejectedByGate, 0); return reached ? (list.reduce((t, r) => t + r.verified, 0) / reached) : 0; };
    lines.push(`gate pass rate (verified / records offered to the gate): ${(rate(b) * 100).toFixed(1)}% → ${(rate(a) * 100).toFixed(1)}%`);
    const reasons = (list) => { const t = {}; list.forEach((r) => Object.entries(r.gateReasons || {}).forEach(([k, n]) => { t[k] = (t[k] || 0) + n; })); return JSON.stringify(t); };
    lines.push(`gate refusals by reason: ${reasons(b)} → ${reasons(a)}`);
    const looked = (list) => { const resolved = list.reduce((t, r) => t + r.verified, 0); const bought = list.reduce((t, r) => t + r.calls.offers, 0); return bought ? resolved / bought : 0; };
    lines.push(`verified per offer lookup bought: ${looked(b).toFixed(2)} → ${looked(a).toFixed(2)}`);
    lines.push(`searches that showed nothing: ${b.filter((r) => !r.shown.length).length} → ${a.filter((r) => !r.shown.length).length}`);
    lines.push(`removed as another garment: ${sum(b, 'removedAsAnotherGarment')} → ${sum(a, 'removedAsAnotherGarment')}`);
    const exact = a.filter((row) => row.category === 'exact');
    const identical = exact.filter((row) => {
      const old = b.find((x) => x.query === row.query);
      return JSON.stringify(old.asked) === JSON.stringify(row.asked) && JSON.stringify(old.shown) === JSON.stringify(row.shown);
    });
    lines.push(`exact requests asked and shown identically: ${identical.length} of ${exact.length}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1]; };
  if (args[0] === '--compare') {
    const [before, after] = [args[1], args[2]].map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    console.log(compare(before, after));
    return;
  }
  const root = path.resolve(flag('--root') || path.join(__dirname, '..'));
  const result = await run(root);
  const json = JSON.stringify(result, null, 2);
  if (flag('--out')) fs.writeFileSync(flag('--out'), json);
  else console.log(json);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { CASES, grade, searchPool, run, compare, SHOWN };
