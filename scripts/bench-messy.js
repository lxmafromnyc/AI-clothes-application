#!/usr/bin/env node
/* =========================================================
   Fynd — messy-input benchmark (offline)

   How people actually type: fragments, slang, misspellings, "not this",
   "like that but", "to wear with", "idk", run-on sentences. Each request
   below goes through the same real server path as
   scripts/bench-concepts.js — the reading, /api/search's intent, the
   OpenWeb Ninja adapter with its offer lookups, the verification gate,
   the garment filter and the ranking — against the same stand-in
   provider and listing pool, so a before and an after are the same
   measurement:

     git worktree add /tmp/fynd-base <base-commit>
     node scripts/bench-messy.js --root /tmp/fynd-base --out before.json
     node scripts/bench-messy.js --out after.json
     node scripts/bench-messy.js --compare before.json after.json

   Every case was written from the request's words before any run:

     strong / ok / wrong   how a shown product is graded (wrong wins)
     phraseNot             the provider must not be asked for this — it
                           is what the request ruled out, its setting, or
                           filler no shop titles anything with
     phraseHas             the provider must be asked for this — the
                           request plainly says it
     shownNot              a shown product matching this breaks an
                           explicit negative ("not skinny", "no logo")

   What the stand-in provider is NOT: Google Shopping. It matches words.
   So this measures what Fynd controls — what it understood, what it
   asked, what it removed and how it ordered — not what a real index
   would return for the same phrase.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { run, SHOWN } = require('./bench-concepts.js');

const ANY = /./;
const NONE = null;
const HOODIE_PLAIN = /(essential|minimal|plain|organic).*hoodie|hoodie pullover|heavyweight (fleece )?hoodie|black hoodie/i;
const LOUD = /graphic|tie dye|skull|logo|cartoon|distressed|christmas/i;
const LOOSE_PANTS = /(wide leg|palazzo|relaxed|baggy|loose|straight).*(pant|trouser|jean)|(pant|trouser|jean).*(wide leg|relaxed|straight)/i;
const PANTS = /\bpants?\b|trouser|chino/i;

/* [category, request, strong, ok, wrong, expect] */
const CASES = [
  /* exact: already in shop words — must not change */
  ['exact', 'black oversized hoodie under $80', /hoodie.*black|black.*hoodie/i, /hoodie/i, LOUD],
  ['exact', 'cream linen midi dress for summer', /(cream|ivory).*linen.*midi|linen.*midi.*(cream|ivory)|cream midi.*linen/i, /linen.*dress|midi dress/i, /gown|sequin|cocktail/i],
  ['exact', 'vintage Prada bag under $500', /vintage prada/i, /prada/i, NONE],
  ['exact', 'navy quarter zip pullover', /quarter.?zip.*navy|navy.*quarter/i, /quarter.?zip|half zip/i, NONE],
  ['exact', 'cropped denim jacket', /cropped.*denim|cropped trucker/i, /cropped.*jacket|denim jacket/i, NONE],
  ['exact', 'white sneakers', /white.*sneaker|sneaker.*white/i, /sneaker/i, NONE],
  ['exact', 'black wide leg trousers', /wide leg.*black|black.*wide leg|palazzo.*black/i, /trouser|pant/i, /jean|legging|jogger|skinny/i],
  ['exact', 'brown pants under 100', /brown.*(pant|trouser|chino|cord)/i, /pant|trouser|chino/i, /jean|legging|short/i],
  ['exact', 'high waisted wide leg pants', /wide leg|palazzo/i, /pant|trouser/i, /skinny|legging/i],
  ['exact', 'a fitted black tee', /fitted tee black|black.*fitted|slim tee|baby tee/i, /tee|t-shirt/i, /oversized|boxy|relaxed|dress/i],

  /* the requests that started this */
  ['slang', 'hoodie but like nicer', /quarter.?zip|half zip|crewneck sweatshirt|knit pullover/i, /hoodie|sweatshirt|pullover/i, LOUD, { phraseNot: /\blike\b|nicer/ }],
  ['vague', 'something comfy but not sloppy', /sweater|knit|cardigan|crewneck sweatshirt|quarter.?zip/i, /sweatshirt|fleece|hoodie|lounge/i, /graphic|tie dye|distressed|ripped|jean|jogger/i, { phraseNot: /sloppy|something/ }],
  ['fragment', 'black pants loose', /(wide leg|palazzo|relaxed|baggy|loose|straight).*black|black.*(wide leg|palazzo|relaxed|baggy|loose|straight)/i, /pant|trouser/i, /skinny|legging|slim/i],
  ['slang', 'that jacket shirt thing', /overshirt|shirt jacket|shacket|chore (jacket|coat)/i, /utility jacket|lightweight jacket/i, /bomber|puffer|leather|parka|windbreaker|rain jacket|varsity|blazer|moto|\btee\b|oxford|button down/i, { phraseNot: /thing/ }],
  ['contradictory', 'dress for going out but casual', /going out.*dress|mini dress|jersey.*dress|casual.*dress|slip dress/i, /dress/i, /gown|sequin|cocktail|formal|evening|maxi/i, { phraseNot: /\bbut\b|everyday/ }],
  ['negative', 'something like a hoodie without the hood', /crewneck|sweatshirt|quarter.?zip|knit pullover|pullover sweater/i, /sweater|pullover/i, /hood|dress|vest/i, { phraseNot: /hood|without/, shownNot: /hood/i }],
  ['fit', 'i want a shirt thats kinda oversized', /oversized.*\b(shirt|button down|oxford)\b|\b(shirt|oxford)\b.*oversized/i, /\bshirt\b|\btee\b|t-shirt/i, /dress|jacket|sweatshirt|hoodie/i, { phraseNot: /\bwant\b|thats|kinda/ }],
  ['negative', 'pants that arent skinny', LOOSE_PANTS, /pant|trouser|chino/i, /skinny|legging/i, { phraseNot: /skinny|slim/, shownNot: /skinny/i }],
  ['negative', 'something warm but not a coat', /sweater|fleece|knit|cardigan|sherpa|quilted jacket|overshirt|thermal|sweatshirt/i, /jacket|hoodie|vest/i, /coat|parka|trench/i, { phraseNot: /coat/, shownNot: /\bcoat\b|overcoat|parka|trench/i }],
  ['contextual', 'cute top to wear with jeans', /\btop\b|blouse|baby tee|camisole|knit top/i, /tee|\bshirt\b|sweater|cardigan|bodysuit/i, /jean|pant|trouser|short|skirt|dress|\bbag\b|jacket/i, { phraseNot: /jean/, shownNot: /\bjean/i }],
  ['visual', 'simple black dress not fancy', /shift dress black|simple cotton midi dress black|casual jersey (mini )?dress|black.*(shift|t-shirt|jersey) dress/i, /dress/i, /gown|sequin|cocktail|formal|evening|beaded/i, { phraseNot: /fancy/ }],
  ['visual', 'old looking bag but expensive looking', /vintage (style|inspired)|retro|structured|top handle|saddle/i, /bag|tote/i, /backpack|sweatshirt|jean/i, { phraseNot: /\bold\b|expensive|looking/ }],
  ['slang', 'something like what skaters wear', /skate|skater|carpenter|baggy.*jean|graphic tee/i, /hoodie|tee|jean|cargo/i, /dress|blazer|gown|heel|tailored|blouse/i, { phraseNot: /something|\bwhat\b|\bwear\b/ }],
  ['slang', 'idk like a loose clean jacket', /(relaxed|minimal|boxy|oversized|lightweight).*jacket|overshirt|chore jacket|shirt jacket/i, /jacket/i, /tailored|blazer|puffer|parka|leather|varsity|moto/i, { phraseNot: /idk|tailored/ }],
  ['negative', 'not too baggy black pants', /straight.*black|black.*straight|black (trousers|pants)|tailored trousers|slim/i, /pant|trouser|chino/i, /baggy|palazzo|legging/i, { phraseNot: /baggy/, shownNot: /baggy/i }],
  ['comparative', 'a shirt but heavier', /heavyweight (cotton shirt|pocket tee|tee)|heavy twill|overshirt|flannel|chore|shirt jacket/i, /\bshirt\b|\btee\b/i, /lightweight|linen|silk|tank|camisole|dress/i, { phraseHas: /heavy/ }],
  ['comparative', 'jacket that isnt really a jacket', /overshirt|shirt jacket|shacket|chore|cardigan|lightweight jacket|sweater jacket/i, /jacket|vest/i, /puffer|parka|coat|leather|blazer|bomber|rain/i, { phraseNot: /isnt|really/ }],
  ['contextual', 'something you can wear over a hoodie', /denim jacket|chore|overshirt|puffer vest|trucker|bomber|parka|overcoat/i, /jacket|vest/i, /hood|sweatshirt|\btee\b|pant|jean|dress|cardigan/i, { phraseNot: /hood/, shownNot: /hood/i }],
  ['fragment', 'women black thing long sleeve cheap', /black.*long sleeve|long sleeve.*black/i, /long sleeve|\btop\b|bodysuit/i, /\bmen'?s\b|pant|jean|coat|jacket/i, { phraseNot: /thing|cheap/ }],
  ['fit', 'oversized tee but fitted arms', /oversized.*tee|tee.*oversized|boxy.*tee/i, /\btee\b|t-shirt/i, /fitted tee|slim|dress/i, { phraseNot: /slim|fitted|arms/ }],
  ['comparative', 'i want the same vibe as a sweatshirt but thinner', /lightweight.*(sweatshirt|crewneck)|long sleeve tee|french terry|thermal/i, /sweatshirt|\btee\b|crewneck/i, /heavyweight|fleece|sherpa|puffer|hoodie|coat/i, { phraseHas: /light/, phraseNot: /vibe|same|want/ }],

  /* misspellings */
  ['misspelling', 'blak hoddie', /black.*hoodie|hoodie.*black/i, /hoodie/i, LOUD, { phraseHas: /hoodie/ }],
  ['misspelling', 'oversize sweter', /oversized.*sweater|sweater.*oversized|chunky knit oversized/i, /sweater|knit/i, /jacket|pant/i, { phraseHas: /sweater/ }],
  ['misspelling', 'jeens that arent skiny', /(straight|relaxed|wide leg|baggy|loose).*jean|jean.*(straight|relaxed|wide)/i, /jean/i, /skinny/i, { phraseHas: /jean/, phraseNot: /skin/, shownNot: /skinny/i }],
  ['misspelling', 'lether jaket', /leather.*jacket|leather biker|moto/i, /jacket/i, /coat|dress|\bbag\b/i, { phraseHas: /leather/ }],
  ['misspelling', 'cardigen', /cardigan/i, /knit|sweater/i, /jean|pant/i, { phraseHas: /cardigan/ }],
  ['misspelling', 'sneekers white', /white.*sneaker|sneaker.*white/i, /sneaker|shoe/i, /boot|heel/i, { phraseHas: /sneaker/ }],
  ['misspelling', 'grey sweatshrit under 50 dollars', /grey.*sweatshirt|sweatshirt.*grey/i, /sweatshirt|crewneck/i, /hoodie|graphic|cartoon/i, { phraseHas: /sweatshirt/ }],
  ['misspelling', 'womens dres for a weding', /wedding guest|midi dress|wrap dress|slip dress/i, /dress/i, /jean|pant|hoodie/i, { phraseHas: /dress/ }],
  ['misspelling', 'pnats loose', /(wide leg|palazzo|relaxed|baggy|loose).*(pant|trouser)/i, /pant|trouser/i, /skinny|legging|slim/i, { phraseHas: /pant|trouser/ }],

  /* slang and shorthand */
  ['slang', 'trackies', /track pant|jogger|sweatpant/i, /pant/i, /jean|trouser|dress/i, { phraseHas: /track|jogger|sweatpant/ }],
  ['slang', 'a crewneck', /crewneck sweatshirt|crew neck sweatshirt|crewneck sweater/i, /crewneck|sweater|sweatshirt/i, /\btee\b|t-shirt|hoodie/i],
  ['slang', 'comfy fit for the weekend', /sweater|sweatshirt|cardigan|fleece|lounge|jogger|hoodie/i, /knit|\btee\b/i, /blazer|tailored|gown|heel|oxford/i, { phraseNot: /\bfit\b/ }],
  ['slang', 'lowkey hoodie but not as sloppy', HOODIE_PLAIN, /hoodie/i, LOUD],
  ['slang', 'kicks for school', /sneaker|skate shoe/i, /shoe/i, /boot|heel|dress/i, { phraseHas: /sneaker|shoe/ }],

  /* comparative */
  ['comparative', 'something like a hoodie but cleaner', /quarter.?zip|half zip|crewneck sweatshirt|knit pullover|crewneck sweater/i, /sweatshirt|sweater|hoodie|pullover/i, /graphic|tie dye|skull|logo|cartoon|christmas|distressed|jacket|zip up|dress|vest/i],
  ['comparative', 'a shirt that looks like a jacket', /overshirt|shirt jacket|shacket|chore (jacket|coat)/i, /utility jacket|lightweight jacket|flannel/i, /bomber|puffer|leather|parka|windbreaker|rain jacket|varsity|blazer|moto/i],
  ['comparative', 'like a cardigan but more structured', /knit blazer|sweater jacket|knit jacket|blazer/i, /cardigan|jacket/i, /hoodie|\btee\b|puffer/i],
  ['comparative', 'something between a sweater and a jacket', /sweater jacket|knit jacket|cardigan|fleece (pullover|jacket)|polar fleece|sherpa/i, /jacket|sweater/i, /puffer|parka|coat|leather|\btee\b|jean|jogger|pant|dress/i],
  ['comparative', 'a sweatshirt but nicer', /quarter.?zip|half zip|knit pullover|crewneck sweater|fine knit/i, /sweatshirt|sweater|pullover/i, /graphic|tie dye|skull|logo|cartoon|distressed|christmas|dress|vest/i],

  /* negative */
  ['negative', 'jeans but not skinny', /(straight|relaxed|wide leg|baggy|loose).*jean|jean.*(straight|relaxed)/i, /jean/i, /skinny/i, { phraseNot: /skinny/, shownNot: /skinny/i }],
  ['negative', 'a jacket thats not leather', /(denim|nylon|twill|canvas|bomber|chore|fleece|quilted|utility|sherpa|lightweight|trucker).*jacket|jacket.*(denim|nylon|twill)/i, /jacket/i, /leather|moto|biker/i, { phraseNot: /leather/, shownNot: /leather|moto|biker/i }],
  ['negative', 'hoodie with no logo', HOODIE_PLAIN, /hoodie/i, /logo|graphic|print|tie dye|skull/i, { phraseNot: /logo/, shownNot: /logo|graphic|print/i }],
  ['negative', 'a dress that isnt black', /dress/i, NONE, /black/i, { phraseNot: /black/, shownNot: /black/i }],
  ['negative', 'not a hoodie, something warmer', /sweater|fleece|sherpa|knit|quilted|puffer vest/i, /sweatshirt|cardigan|jacket/i, /hood|\btee\b|tank/i, { phraseNot: /hood/, shownNot: /hood/i }],
  ['negative', 'pants not jeans', /trouser|chino|pant/i, NONE, /jean/i, { phraseNot: /jean/, shownNot: /jean/i }],
  ['negative', 'top without sleeves', /tank|camisole|sleeveless|\bcami\b/i, /\btop\b/i, /long sleeve|sweater|sweatshirt|jacket/i, { phraseNot: /without/ }],

  /* contextual */
  ['contextual', 'something cozy I can wear with jeans', /sweater|sweatshirt|cardigan|hoodie|fleece|sherpa/i, /knit|flannel/i, /jean|pant|trouser|legging|jogger|short/i, { phraseNot: /jean/ }],
  ['contextual', 'shoes to go with a black dress', /heel|sneaker|boot|sandal|loafer|shoe/i, NONE, /dress|\bbag\b/i, { phraseNot: /dress/, shownNot: /dress/i }],
  ['contextual', 'something to wear over a dress', /cardigan|cropped.*jacket|shrug/i, /jacket|denim jacket/i, /dress|gown/i, { phraseNot: /dress/, shownNot: /dress/i }],
  ['contextual', 'a top for under a blazer', /knit top|fitted tee|tank|camisole|bodysuit|mock neck|baby tee|ribbed/i, /\btop\b|\btee\b|blouse/i, /blazer|jacket|coat/i, { phraseNot: /blazer/, shownNot: /blazer/i }],
  ['contextual', 'pants to go with my brown boots', /pant|trouser|jean|chino/i, NONE, /boot|shoe|sneaker/i, { phraseNot: /brown|boot/, shownNot: /boot/i }],

  /* visual */
  ['visual', 'loose black pants that look nice', /(wide leg|palazzo|relaxed|pleated).*black|black.*(wide leg|palazzo|relaxed|pleated)/i, /wide leg|palazzo|relaxed|pleated|tailored trouser/i, /skinny|legging|jogger|sweatpant|jean|cargo|slim/i],
  ['visual', 'a bag that looks vintage but not crazy expensive', /vintage (style|inspired)|retro/i, /shoulder bag|top handle|saddle/i, /prada|gucci/i],
  ['visual', 'clean white shirt that looks expensive', /white.*(oxford|button down|shirt)|(oxford|button down|linen) .*white/i, /\bshirt\b|blouse/i, /\btee\b|t-shirt|graphic|sweatshirt/i, { phraseNot: /expensive|looks/ }],

  /* fit */
  ['fit', 'jeans that are kinda baggy', /baggy|relaxed|wide leg|loose/i, /jean/i, /skinny|slim/i, { phraseNot: /kinda/ }],
  ['fit', 'oversized but not sloppy hoodie', /oversized.*hoodie|hoodie.*oversized|heavyweight (fleece )?hoodie/i, /hoodie/i, LOUD],

  /* contradictory or ambiguous */
  ['contradictory', 'oversized but fitted shirt', /\bshirt\b|oxford|button/i, /\btee\b/i, /dress|jacket/i],
  ['contradictory', 'black but not too dark jacket', /jacket/i, NONE, /coat|parka/i, { phraseHas: /jacket/ }],
  ['contradictory', 'warm but lightweight jacket', /fleece|quilted|lightweight|puffer vest|sherpa|packable/i, /jacket/i, /\bcoat\b|parka|leather/i, { phraseHas: /jacket/ }],
  ['contradictory', 'cheap but expensive looking bag', /structured|top handle|leather shoulder|saddle|vintage style/i, /\bbag\b|tote/i, /backpack/i, { phraseNot: /cheap|expensive/ }],

  /* incomplete and adversarial: must not be made up */
  ['adversarial', 'something nice for dinner', /blouse|silk|satin|slip dress|shift dress|tailored|blazer|pleated trouser|wrap dress|camisole/i, /dress|trouser|shirt|heel|skirt/i, /hoodie|sweatpant|jogger|graphic|legging|sneaker|skate/i, { phraseNot: /\bdress\b|black|heel/ }],
  ['adversarial', 'something for a party', /going out|satin|sequin|mini dress|camisole|slip dress/i, /dress|\btop\b|skirt|heel/i, /hoodie|sweatpant|jogger|fleece|puffer|thermal/i, { phraseNot: /\bdress\b|black|heel/ }],
  ['adversarial', 'gift for my dad', /\bmen'?s\b/i, /sweater|shirt|jacket|polo|cardigan|wallet|hat/i, /\bdress\b|heel|skirt|bodysuit|camisole|women/i, { phraseNot: /dress|heel|black/ }],
  ['adversarial', 'outfit for a date', ANY, NONE, NONE, { phraseNot: /\bdress\b|heel|black/ }],
  ['adversarial', 'clothes for a job interview', /blazer|tailored|trouser|oxford|button down|shift dress|pleated/i, /shirt|pant|skirt/i, /hoodie|jogger|graphic|sweatpant|skate|sneaker/i, { phraseNot: /black|heel/ }],
  ['adversarial', 'something like what my mom wears', ANY, NONE, NONE, { phraseNot: /\bmom\b|wears/ }],
  ['incomplete', 'anything under $30', ANY, NONE, NONE],
  ['incomplete', 'something black', /black/i, NONE, NONE],

  /* very short */
  ['short', 'hoodie', /hoodie/i, /sweatshirt/i, NONE],
  ['short', 'jeans', /jean/i, NONE, NONE],
  ['short', 'cozy', /sweater|sweatshirt|cardigan|fleece|sherpa|knit|hoodie/i, /lounge/i, /blazer|tailored|heel|\bbag\b/i],
  ['short', 'linen', /linen/i, NONE, NONE],

  /* long and conversational */
  ['conversational', 'hey so i need something for my cousins wedding but i dont want to look too dressed up, maybe like a nice shirt or something', /linen shirt|oxford|button down|silk blouse|shirt dress|knit polo/i, /\bshirt\b|blouse|polo/i, /gown|sequin|tuxedo|hoodie|graphic|sweatpant|\btee\b/i, { phraseNot: /cousin|hey|dressed|maybe|\bdont\b/ }],
  ['conversational', 'im looking for some pants for work that are comfortable but still look professional', /tailored|pleated|trouser|dress pant|straight leg|chino/i, /pant/i, /jogger|sweatpant|legging|jean|cargo|skate/i, { phraseNot: /looking|still|comfortable/ }],
  ['conversational', 'i need a jacket for spring thats not too heavy and goes with everything', /lightweight|overshirt|denim jacket|chore|trucker|nylon|twill|shirt jacket|bomber|harrington/i, /jacket/i, /puffer|parka|down|sherpa|\bcoat\b|teddy/i, { phraseNot: /heavy|everything|goes/ }],
  ['conversational', 'can you find me a simple black dress i can wear to work', /shift dress|simple.*dress|t-shirt dress|shirt dress/i, /dress/i, /gown|sequin|cocktail|bodycon|slip/i, { phraseNot: /\bcan\b|find|\byou\b/ }],
  ['conversational', 'my boyfriend wants a hoodie but he hates logos', HOODIE_PLAIN, /hoodie/i, /logo|graphic|print|skull|tie dye|women/i, { phraseNot: /boyfriend|hates|logo/, shownNot: /logo|graphic/i }]
];

/* ---------- reporting ---------- */

const total = (list, pick) => list.reduce((sum, one) => sum + pick(one), 0);

function compare(before, after) {
  const lines = [];
  for (const reading of Object.keys(after.readings)) {
    const b = before.readings[reading];
    const a = after.readings[reading];
    lines.push(`\n## ${reading === 'local' ? 'Local reading (the page\'s fallback reader)' : 'Served reading (api/interpret.js, model answer stubbed empty)'}\n`);
    const cats = [...new Set(a.map((row) => row.category))];
    lines.push(`| category | n | relevant@${SHOWN} | strong@${SHOWN} | wrong@${SHOWN} | false readings | hard violations | relevant removed by filter | better | worse |`);
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    const score = (row) => row.strong * 2 + row.relevant - row.wrong * 2 - row.hardViolations * 3 - row.falseReading * 2;
    for (const cat of cats.concat(['ALL'])) {
      const pick = (list) => list.filter((row) => cat === 'ALL' || row.category === cat);
      const ar = pick(a); const br = pick(b);
      let better = 0; let worse = 0;
      ar.forEach((row) => {
        const old = b.find((x) => x.query === row.query);
        const d = score(row) - score(old);
        if (d > 0) better += 1; else if (d < 0) worse += 1;
      });
      const f = (pickOne) => `${total(br, pickOne)} → ${total(ar, pickOne)}`;
      lines.push(`| ${cat} | ${ar.length} | ${f((r) => r.relevant)} | ${f((r) => r.strong)} | ${f((r) => r.wrong)} | ${f((r) => r.falseReading)} | ${f((r) => r.hardViolations)} | ${f((r) => r.removedRelevant)} | ${better} | ${worse} |`);
    }
    lines.push('\n| request | relevant | strong | wrong | false reading | violations | phrase before → after |');
    lines.push('|---|---|---|---|---|---|---|');
    a.forEach((row) => {
      const old = b.find((x) => x.query === row.query);
      const mark = score(row) < score(old) ? ' ⚠︎' : '';
      lines.push(`| ${row.query}${mark} | ${old.relevant}→${row.relevant} | ${old.strong}→${row.strong} | ${old.wrong}→${row.wrong} | ${old.falseReading}→${row.falseReading} | ${old.hardViolations}→${row.hardViolations} | \`${old.phrase}\` → \`${row.phrase}\` |`);
    });
    const per = (list, pickOne) => (total(list, pickOne) / list.length).toFixed(2);
    lines.push(`\nprovider searches per Fynd search: ${per(b, (r) => r.calls.search)} → ${per(a, (r) => r.calls.search)}; offer lookups: ${per(b, (r) => r.calls.offers)} → ${per(a, (r) => r.calls.offers)}; unexpected requests: ${total(b, (r) => r.calls.other)} → ${total(a, (r) => r.calls.other)}`);
    const looked = (list) => (total(list, (r) => r.verified) / Math.max(1, total(list, (r) => r.calls.offers))).toFixed(2);
    lines.push(`verified products per offer lookup bought: ${looked(b)} → ${looked(a)}`);
    const reasons = (list) => { const t = {}; list.forEach((r) => Object.entries(r.gateReasons || {}).forEach(([k, n]) => { t[k] = (t[k] || 0) + n; })); return JSON.stringify(t); };
    lines.push(`gate refusals by reason: ${reasons(b)} → ${reasons(a)}`);
    const exact = a.filter((row) => row.category === 'exact');
    const same = exact.filter((row) => {
      const old = b.find((x) => x.query === row.query);
      return JSON.stringify(old.asked) === JSON.stringify(row.asked) && JSON.stringify(old.shown) === JSON.stringify(row.shown);
    });
    lines.push(`exact requests asked and shown identically: ${same.length} of ${exact.length}`);
    lines.push(`searches that showed nothing: ${b.filter((r) => !r.shown.length).length} → ${a.filter((r) => !r.shown.length).length}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const at = args.indexOf(name); return at === -1 ? null : args[at + 1]; };
  if (args[0] === '--compare') {
    const revive = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(compare(revive(args[1]), revive(args[2])));
    return;
  }
  const root = path.resolve(flag('--root') || path.join(__dirname, '..'));
  const result = await run(root, CASES);
  const json = JSON.stringify(result, null, 2);
  if (flag('--out')) fs.writeFileSync(flag('--out'), json);
  else console.log(json);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { CASES, compare };
