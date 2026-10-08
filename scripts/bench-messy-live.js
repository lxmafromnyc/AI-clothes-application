#!/usr/bin/env node
/* =========================================================
   Fynd — messy-input LIVE benchmark

   Seventy-odd requests the way people really type them — vague,
   misspelled, half-finished, slangy, contradicting themselves,
   "but not a coat", "to wear with jeans" — and a few plain ones as a
   control, put through the real live path:

     the page's own reader (assets/interpret.js), exactly as the browser
       runs it, with /api/interpret answered by the served interpreter
       (OpenAI, or whichever AI_PROVIDER names) in-process — or refused,
       with --reader local, so the page falls back to its local reader
     the body the page then posts to /api/search, shaped by shapeIntent
     searchWithFallback: the configured product source, its offer
       lookups, its cache, its deadlines, the verification gate, the
       garment filter and the ranking

   No stubs anywhere: a run of this costs real searches and real tokens.

   It can run one checkout or compare several on the same requests —
   say the branch before a change and after it:

     node --env-file=.env.local scripts/bench-messy-live.js \
       --roots before=/path/to/old/checkout,after=.

   Each checkout runs in its own process, with its own modules, its own
   cache and its own copy of the page's scripts, and the requests are
   interleaved — one request on each, alternating which goes first — so
   both see the provider at the same minute.

   Every request is graded by the same rules, from here, whichever
   checkout answered it:

     interpretation  the target asked for is what the shopper wants
                     (not what they compared it to or wear it with), every
                     exclusion they stated was recorded and is not asked
                     for, every colour, budget and gender they stated was
                     kept, and nothing they did not state was added
     relevant@4/@8   of the first 4 / 8 products shown, how many plainly
                     are what was asked (an empty slot counts as not)
     strong@8        of the first 8, how many are that and also say every
                     stated colour and the request's other details
     wrong@8         of the first 8, how many are plainly wrong: another
                     garment, something ruled out, another colour or the
                     other gender from the one stated
     hard            across everything shown: over or under a stated
                     budget, a colour or gender the request contradicts,
                     anything the request ruled out
     wrongly removed products the garment filter took out that were
                     plainly what was asked
     cost            provider searches and offer lookups, counted on the
                     wire; interpreter calls; latency

   What "plainly" means is written next to each request below, as
   patterns on the product title. A title that does not say is not
   counted either way: these are lower bounds on both right and wrong.

   Usage:
     node --env-file=.env.local scripts/bench-messy-live.js
       [--roots name=path,name=path]   default: this checkout alone
       [--reader served|local]         default: served
       [--only "query one|query two"]  [--set messy|exact|all]
       [--json] [--out results.json]
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const HERE = path.resolve(__dirname, '..');

/* ---------- the requests, and what plainly right and wrong look like ----------

   target    the search must ask for one of these
   notAsked  the search must not ask for this: a garment it is only worn
             with or compared to, a thing ruled out, or something nobody said
   exclude   what the request ruled out. The reading must record it, the
             search must not ask for it, and no product shown may be it
   mayRule   other exclusions a careful reading may also record
   colours   colour families stated (anything else in the reading is invented)
   maxPrice / minPrice / gender / brands   stated, so they must be kept
   relevant  a title plainly what was asked (a list means all of them)
   strong    a relevant title that also says the rest of what was asked:
             every stated colour, and this pattern when given
   wrong     a title plainly not
*/
const CASES = [
  /* the requests from the brief, verbatim */
  { q: 'idk i want one of those light grey hoodies thats kinda baggy and relaxed but still fits good not huge or sloppy',
    target: /hood/, colours: ['grey'], mayRule: /huge|sloppy|oversiz|baggy/,
    relevant: [/hood/], strong: /relaxed|baggy|loose|boxy/, wrong: /\b(pants|jogger|shorts|t-?shirt|tee|jacket|coat)\b/ },
  { q: 'hoodie but nicer',
    target: /hood|sweatshirt|sweater|knit|zip|crew/,
    relevant: /hood|sweatshirt|knit|sweater|quarter.?zip|half.?zip|cardigan|crew ?neck|pullover/,
    wrong: /\b(pants|shorts|dress|t-?shirt|tee|jeans|skirt|sneakers?|shoes?|socks?)\b/ },
  { q: 'something warm but not a coat',
    target: /sweater|fleece|overshirt|knit|cardigan|hood|sweatshirt|thermal|jumper|pullover|shacket|vest|flannel/,
    notAsked: /\bcoats?\b/, exclude: /\b(over)?coats?\b|\bparkas?\b|\btrench\b/, mayRule: /coat|parka|trench|puffer|jacket|outerwear/,
    relevant: /sweater|fleece|overshirt|knit|cardigan|hood|sweatshirt|thermal|jumper|pullover|shacket|flannel|turtleneck|crew ?neck|quarter.?zip|vest/,
    wrong: /\b(coats?|parka|trench|shorts|tank|sandals?|swim\w*|bikini)\b/ },
  { q: 'that jacket shirt thing',
    target: /shacket|overshirt|shirt jacket/,
    relevant: /shacket|overshirt|shirt.?jacket|jacket.?shirt|\bcpo\b|chore/,
    wrong: /\b(coat|pants|jeans|dress|t-?shirt|tee|hoodie|shorts|blazer)\b/ },
  { q: 'black pants but not skinny',
    target: /pants|trousers|jeans|chinos?|slacks/, colours: ['black'],
    notAsked: /skinny/, exclude: /\bskinny\b/, mayRule: /slim|legging|jegging/,
    relevant: /pant|trouser|chino|slack|jean/, wrong: /\b(skinny|shorts|leggings?|skirt|dress)\b/ },
  { q: 'shirt but heavier',
    target: /heavy|flannel|overshirt|oxford|twill|shirt|tee/,
    relevant: [/shirt|tee\b|shacket/, /heavy|flannel|overshirt|oxford|twill|canvas|chamois|thick|brushed|wool|corduroy|denim|shacket|\d{3} ?gsm|\boz\b|waffle|thermal/], strong: /heavy ?weight|heavy|thick|\d{3} ?gsm/,
    wrong: /\b(coat|pants|dress|shorts|jeans|tank|sheer|lightweight)\b/ },
  { q: 'something cozy to wear with jeans',
    target: /sweater|knit|cardigan|hood|sweatshirt|fleece|pullover|jumper|crew|flannel|turtleneck/,
    notAsked: /\bjeans?\b/,
    relevant: /sweater|knit|cardigan|hood|sweatshirt|fleece|pullover|jumper|crew ?neck|flannel|turtleneck|sherpa|quarter.?zip/,
    wrong: /\b(jeans?|pants|trousers|shorts|skirt|dress|sandals?|leggings?)\b/ },
  { q: 'dress for going out but casual',
    target: /dress/,
    relevant: /dress/, wrong: /\b(pants|shorts|gowns?|bridal|wedding|prom|ball ?gown|jumpsuit)\b/ },
  { q: 'old looking bag but expensive looking',
    target: /bag|tote|satchel|crossbody|messenger|duffel|purse/,
    relevant: /bag|tote|satchel|crossbody|messenger|duffel|purse|briefcase|backpack/,
    wrong: /\b(shoes?|boots?|wallets?|jacket|pants|dress|shirt|belt)\b/ },
  { q: 'something like a sweatshirt but thinner',
    target: /sweatshirt|long ?sleeve|lightweight|tee|crew|henley|knit|waffle|thermal|light/,
    relevant: /long.?sleeve|light.?weight|thin|henley|waffle|thermal|fine.?(gauge|knit)|french terry|jersey|raglan|\btee\b|t-?shirt/,
    wrong: /\b(coat|jacket|pants|shorts|dress|heavyweight|fleece|sherpa|puffer)\b/ },
  { q: 'a short jacket thing people wear over shirts',
    target: /jacket|bomber|cropped|trucker|harrington|blouson|overshirt|shacket/,
    relevant: (t) => /bomber|crop|trucker|harrington|blouson|jacket|bolero|shrug|shacket/.test(t) && !/\b(coat|parka|longline|trench)\b/.test(t),
    wrong: (t) => /\b(coat|parka|trench|overcoat|pants|dress|jeans)\b/.test(t) || (/\bshirts?\b/.test(t) && !/jacket|shacket|overshirt/.test(t)) },
  { q: 'loose black pants that look nice',
    target: /pants|trousers|slacks|chinos?/, colours: ['black'],
    relevant: /pant|trouser|slack|chino|palazzo|culotte/, strong: /wide|relaxed|loose|baggy|pleated|palazzo|straight/, wrong: /\b(skinny|leggings?|shorts|jeggings?)\b/ },
  { q: 'simple black dress not fancy',
    target: /dress/, colours: ['black'], exclude: /\b(sequin\w*|gown|evening|formal|beaded|embellished)\b/, mayRule: /fancy|formal|sequin|evening|gown|cocktail|embellish|beaded|party/,
    notAsked: /fancy|formal|sequin|evening/,
    relevant: /dress/, wrong: /\b(gowns?|sequin\w*|prom|bridal|beaded|embellished|pants|shorts)\b/ },
  { q: 'something skaters would wear',
    target: /skate|baggy|graphic|hood|cargo|clothing|tee|work pant|carpenter/,
    relevant: /skate|baggy|cargo|graphic|hood|carpenter|work pant|dickies|vans|thrasher|loose|wide|flannel|beanie|t-?shirt|\btee\b|sweatshirt/,
    wrong: /\b(dress|heels?|blazer|suit|gown|skirt|ice skates?|figure skat\w*|roller skates?|helmet|wheels?|bearings?|decks?|trucks?|skateboard)\b/ },
  { q: 'women black thing long sleeve cheap',
    target: /long.?sleeve|top|shirt|tee/, colours: ['black'], gender: 'women', maxPrice: null,
    relevant: /long.?sleeve/, wrong: /\b(short.?sleeve|sleeveless|tank|shorts)\b/ },

  /* misspelled */
  { q: 'blak hoddie', target: /hood/, colours: ['black'], relevant: /hood/, wrong: /\b(pants|jogger|shorts|t-?shirt|jacket|coat)\b/ },
  { q: 'jeens that arent skiny', target: /jean|denim/, notAsked: /skinny/, exclude: /\bskinny\b/, mayRule: /slim|jegging/,
    relevant: /jean|denim/, wrong: /\b(skinny|jeggings?|shorts|jacket|skirt)\b/ },
  { q: 'jumpr that isnt itchy', target: /sweater|jumper|knit|pullover|cashmere|merino|cotton/, mayRule: /itch|wool|mohair|scratch/,
    relevant: /sweater|jumper|knit|pullover|crew ?neck|cardigan/, wrong: /\b(pants|dress|coat|shorts|mohair)\b/ },
  { q: 'wite buton up shirt', target: /shirt|button/, colours: ['white'], relevant: /shirt|button/, wrong: /\b(t-?shirt|tee|tank|pants|dress)\b/ },
  { q: 'cardagin for work', target: /cardigan/, relevant: /cardigan/, wrong: /\b(pants|dress|coat|hoodie|shorts)\b/ },
  { q: 'baggy cargo pnts', target: /cargo/, relevant: /cargo/, wrong: /\b(skinny|shorts|jacket|skirt|leggings?)\b/ },
  { q: 'tshirt under 30 bucks black', target: /t-?shirt|tee/, colours: ['black'], maxPrice: 30,
    relevant: /t-?shirt|\btee\b/, wrong: /\b(long.?sleeve|hoodie|tank|dress|pants)\b/ },

  /* fragments */
  { q: 'pants that arent skinny', target: /pant|trouser|chino|jean|slack/, notAsked: /skinny/, exclude: /\bskinny\b/, mayRule: /slim|legging|jegging/,
    relevant: /pant|trouser|chino|slack|jean/, wrong: /\b(skinny|shorts|leggings?|skirt)\b/ },
  { q: 'warm. not bulky. for winter', target: /jacket|sweater|knit|fleece|thermal|base ?layer|down|puffer|merino|vest|cardigan|coat/, mayRule: /bulk|oversiz|puffer|chunky/,
    relevant: /jacket|sweater|knit|fleece|thermal|base ?layer|down|merino|vest|cardigan|coat|pullover/, wrong: /\b(shorts|tank|sandals?|swim\w*|bulky|chunky|oversized)\b/ },
  { q: 'vest thing. puffy', target: /vest|gilet/, relevant: /vest|gilet/, wrong: /\b(suit|waistcoat|tank|undershirt|tuxedo)\b/ },
  { q: 'brown boots... chelsea maybe', target: /boot|chelsea/, colours: ['brown'], relevant: /boot|chelsea/, wrong: /\b(sneakers?|sandals?|loafers?|heels?|socks?)\b/ },

  /* slang and references */
  { q: 'drippy streetwear hoodie', target: /hood/, relevant: /hood/, wrong: /\b(pants|shorts|dress|blazer|suit)\b/ },
  { q: 'lowkey fit for a first date', target: /./, notAsked: /\b(black|red|dress|heels?|suit)\b/,
    relevant: /shirt|top|knit|sweater|jeans|trouser|blazer|dress|polo|chino|overshirt|blouse/, wrong: /\b(tuxedo|gown|sweatpants|pajamas?|swim\w*|gym|bridal)\b/ },
  { q: 'jackets like the ones in top gun', target: /bomber|flight|aviator|leather|jacket/,
    relevant: /bomber|flight|aviator|\bg-?1\b|ma-?1|jacket/, wrong: /\b(sunglasses|glasses|pants|t-?shirt|hat|cap|costume|patch)\b/ },
  { q: 'old money sweater', target: /sweater|knit|cable|cashmere|merino|polo|quarter|cardigan/,
    relevant: /sweater|knit|cable|cardigan|jumper|pullover|quarter.?zip|crew ?neck/, wrong: /\b(hoodie|graphic|pants|shorts|dress|t-?shirt)\b/ },
  { q: 'gorpcore jacket fr', target: /jacket|shell|anorak|fleece|windbreaker|rain|outdoor|hiking/,
    relevant: /jacket|shell|anorak|fleece|windbreaker|rain|parka|softshell|hardshell/, wrong: /\b(blazer|suit|denim|leather|pants|shorts|dress)\b/ },
  { q: 'clean girl aesthetic top', target: /top|tank|bodysuit|tee|knit|cami|shirt/,
    relevant: /top|tank|bodysuit|tee|t-?shirt|knit|cami|shirt|blouse|polo/, wrong: /\b(pants|jeans|skirt|dress|shorts|coat|hoodie)\b/ },

  /* contradictions */
  { q: 'baggy but fitted tee', target: /t-?shirt|tee/, relevant: /t-?shirt|\btee\b/, wrong: /\b(pants|shorts|dress|hoodie|jacket|long.?sleeve)\b/ },
  { q: 'cheap but designer looking blazer', target: /blazer/, maxPrice: null, relevant: /blazer/, wrong: /\b(pants|trousers|vest|dress|shirt|skirt)\b/ },
  { q: 'warm summer sweater', target: /sweater|knit|cardigan|pullover/, relevant: /sweater|knit|cardigan|pullover|jumper/, wrong: /\b(pants|shorts|dress|coat|hoodie)\b/ },
  { q: 'formal but comfy pants', target: /pant|trouser|slack|chino/, relevant: /pant|trouser|slack|chino/, wrong: /\b(shorts|jeans|sweatpants|leggings?|skirt)\b/ },

  /* filler and conversational */
  { q: 'ok so basically i need like a jacket thats not leather for spring', target: /jacket/, notAsked: /leather/, exclude: /\bleather\b/, mayRule: /faux|vegan|pleather|moto|biker/,
    relevant: /jacket/, wrong: /\b(leather|pants|dress|coat|shirt|blazer)\b/ },
  { q: 'umm a top to go with my wide leg trousers', target: /top|blouse|shirt|tee|bodysuit|cami|knit|tank/, notAsked: /trousers?|wide/,
    relevant: /top|blouse|shirt|tee|bodysuit|cami|tank|knit|sweater/, wrong: /\b(trousers?|pants|jeans|skirt|shorts)\b/ },
  { q: 'honestly just want comfy pants for flights', target: /pant|jogger|sweatpant|trouser|lounge|travel/,
    relevant: /pant|jogger|trouser|lounge/, wrong: /\b(jeans|shorts|skinny|leather|dress)\b/ },
  { q: 'can u find me the kind of shoes you wear with suits', target: /oxford|derby|loafer|dress shoe|brogue|monk|shoe/, notAsked: /\bsuits?\b/,
    relevant: /oxford|derby|loafer|dress shoe|brogue|monk|cap.?toe|wingtip/, wrong: /\b(suits?|sneakers?|sandals?|slippers?|trainers?|socks?)\b/ },
  { q: 'need a belt that goes with brown boots', target: /belt/, notAsked: /boots?/, relevant: /belt/, wrong: /\b(boots?|shoes?|bag|wallet)\b/ },
  { q: 'something to wear over a dress when its chilly', target: /cardigan|jacket|shrug|wrap|blazer|bolero|knit|shawl|sweater/, notAsked: /\bdress\b/,
    relevant: /cardigan|jacket|shrug|wrap|blazer|bolero|kimono|shawl|cape|sweater/, wrong: (t) => /\b(skirt|pants|shorts)\b/.test(t) || (/\bdress\b/.test(t) && !/cardigan|jacket|shrug|wrap|blazer|bolero|kimono|shawl|cape|sweater/.test(t)) },
  { q: 'idk smth casual for the weekend', target: /./, notAsked: /\b(black|white|red|dress|heels?|suit)\b/,
    relevant: /tee|t-?shirt|jeans|hoodie|sweatshirt|chino|shorts|polo|sneaker|shirt|sweater|top|overshirt|jogger/, wrong: /\b(suit|tuxedo|gown|heels?|bridal|formal)\b/ },
  { q: 'something nice for dinner', target: /./, notAsked: /\bblack\b|\bheels?\b|\bdress\b(?! (shirt|pants|trousers))/,
    relevant: /blazer|shirt|top|blouse|dress|trouser|knit|sweater|polo|loafer|skirt|chino/, wrong: /\b(hoodie|sweatpants|joggers?|gym|swim\w*|pajamas?|athletic|leggings?)\b/ },
  { q: 'a nice top for dinner but not too dressy', target: /top|blouse|shirt|sweater|knit|tee|cami/, mayRule: /dressy|formal|sequin|evening|gown|fancy/,
    relevant: /top|blouse|shirt|tee|knit|sweater|cami|bodysuit|polo/, wrong: /\b(gowns?|sequin\w*|pants|jeans|skirt|shorts)\b/ },
  { q: 'smth for the gym thats not shorts', target: /legging|jogger|track|sweatpant|tee|tank|gym|training|athletic|pant|top|workout|activewear/, notAsked: /shorts/, exclude: /\bshorts\b/,
    relevant: /legging|jogger|track|sweatpant|pant|tee|tank|top|bra|training|athletic|gym/, wrong: /\b(shorts|jeans|dress|blazer|coat)\b/ },

  /* "but not", "like X but", "with" */
  { q: 'something like a hoodie without the hood', target: /sweatshirt|crew|pullover|sweater/, notAsked: /\bhood(ie|y|ed)?s?\b/, exclude: /\bhood(ie|y|ed)?s?\b/,
    relevant: /sweatshirt|crew ?neck|pullover|sweater/, wrong: /\b(hood(ie|y|ed)?s?|pants|shorts|jacket)\b/ },
  { q: 'hoodie with no logo', target: /hood/, exclude: /\b(logo|graphic)\b/, mayRule: /print|graphic|embroider|brand/,
    relevant: /hood/, wrong: /\b(logo|graphic|pants|shorts)\b/ },
  { q: 'i want the same vibe as a sweatshirt but thinner', target: /sweatshirt|long ?sleeve|lightweight|tee|crew|henley|knit|waffle|light/,
    relevant: /long.?sleeve|light.?weight|thin|henley|waffle|thermal|fine.?(gauge|knit)|french terry|jersey|raglan|\btee\b|t-?shirt/, wrong: /\b(coat|jacket|pants|shorts|heavyweight|fleece|sherpa)\b/ },
  { q: 'a coat but less formal', target: /jacket|parka|shacket|chore|anorak|overshirt|coat|field/,
    relevant: /jacket|parka|shacket|chore|anorak|overshirt|bomber|puffer|coat/, wrong: /\b(tuxedo|chesterfield|pants|dress|shirt)\b/ },
  { q: 'cardigan but more structured', target: /blazer|jacket|cardigan/,
    relevant: /blazer|jacket|cardigan|structured/, wrong: /\b(pants|dress|t-?shirt|tee|shorts|skirt)\b/ },
  { q: 'hoodie but less casual', target: /hood|knit|sweater|zip|cardigan|crew|sweatshirt/,
    relevant: /hood|knit|sweater|quarter.?zip|half.?zip|cardigan|crew ?neck|sweatshirt|pullover/, wrong: /\b(pants|shorts|dress|t-?shirt|tee|jeans)\b/ },
  { q: 'white button up but not see through', target: /button|shirt|oxford/, colours: ['white'], exclude: /\b(sheer|see.?through|mesh)\b/, notAsked: /sheer|see.?through/, mayRule: /lace|thin|transparent/,
    relevant: /shirt|button|oxford/, wrong: /\b(sheer|mesh|see.?through|t-?shirt|tank|dress)\b/ },
  { q: 'white sneakers that arent chunky', target: /sneaker|trainer|shoe/, colours: ['white'], notAsked: /chunky/, exclude: /\b(chunky|platform)\b/, mayRule: /platform|dad/,
    relevant: /sneaker|trainer|shoe|plimsoll/, wrong: /\b(chunky|platform|boots?|sandals?)\b/ },
  { q: 'baggy jeans but not ripped', target: /jean|denim/, notAsked: /ripped|distressed/, exclude: /\b(ripped|distressed|destroyed)\b/, mayRule: /distress|destroy|torn|skinny/,
    relevant: /jean|denim/, wrong: /\b(ripped|distressed|destroyed|skinny|shorts|jacket)\b/ },
  { q: 'cute summer dress no florals', target: /dress/, notAsked: /floral/, exclude: /\bflorals?\b/, mayRule: /flower|print/,
    relevant: /dress/, wrong: /\b(floral|flowers?|pants|coat|sweater)\b/ },
  { q: 'vintage looking denim jacket but not cropped', target: /denim|jean|trucker/, notAsked: /crop/, exclude: /\bcrop(ped)?\b/,
    relevant: [/denim|jean|trucker/, /jacket|trucker/], wrong: /\b(cropped|crop|shorts|skirt)\b/ },
  { q: 'somthing to wear to a wedding as a guest thats not a suit', target: /dress|blazer|jumpsuit|trouser|shirt|sport coat|outfit|guest/, notAsked: /\bsuits?\b/, exclude: /\bsuits?\b/, mayRule: /tux|bridal|white/,
    relevant: /dress|blazer|sport ?coat|jumpsuit|trousers?|dress shirt|slacks|skirt|blouse/, wrong: /\b(suits?|bridal|wedding dress|tuxedo|hoodie|sweatpants|shorts)\b/ },

  /* the brief's required phrasings, and word order, contractions and
     negations of more than one word */
  { q: 'something like a hoodie but cleaner', target: /hood|sweatshirt|zip|crew|pullover|knit|minimal/,
    relevant: /hood|sweatshirt|quarter.?zip|half.?zip|crew ?neck|pullover|knit/, strong: /minimal|clean|plain|essential|basic|premium|heavyweight|zip/, wrong: /\b(graphic|logo|pants|shorts|dress|t-?shirt)\b/ },
  { q: "pants that aren't skinny", target: /pant|trouser|chino|jean|slack/, notAsked: /skinny/, exclude: /\bskinny\b/, mayRule: /slim|legging|jegging/,
    relevant: /pant|trouser|chino|slack|jean/, wrong: /\b(skinny|shorts|leggings?|skirt)\b/ },
  { q: 'hoodie without the hood', target: /sweatshirt|crew|pullover|sweater/, notAsked: /\bhood(ie|y|ed)?s?\b/, exclude: /\bhood(ie|y|ed)?s?\b/,
    relevant: /sweatshirt|crew ?neck|pullover|sweater/, wrong: /\b(hood(ie|y|ed)?s?|pants|shorts|jacket)\b/ },
  { q: 'hoodie grey baggy light', target: /hood/, colours: ['grey'], relevant: /hood/, strong: /relaxed|baggy|loose|oversized|boxy/, wrong: /\b(pants|jogger|shorts|t-?shirt|jacket|coat)\b/ },
  { q: "i don't want skinny jeans", target: /jean|denim/, notAsked: /skinny/, exclude: /\bskinny\b/, mayRule: /slim|jegging/,
    relevant: /jean|denim/, wrong: /\b(skinny|jeggings?|shorts|jacket|skirt)\b/ },
  { q: 'skinny jeans but not too tight', target: /jean|denim/, notAsked: /baggy|relaxed|wide/, mayRule: /tight/,
    relevant: /jean|denim/, strong: /skinny|slim/, wrong: /\b(baggy|wide|relaxed|shorts|jacket|skirt)\b/ },
  { q: 'a coat thats not too long or too heavy', target: /coat|jacket|trench|mac/, notAsked: /heavy|long/, mayRule: /long|heavy|heavyweight|longline|maxi/,
    relevant: /coat|jacket|trench|mac|parka/, strong: /light|short|cropped|mid/, wrong: /\b(longline|maxi|heavyweight|pants|dress|shirt)\b/ },
  { q: 'not into logos, hoodie', target: /hood|sweatshirt|minimal|zip|crew|pullover/, notAsked: /logo|into/, exclude: /\b(logos?|graphics?)\b/, mayRule: /print/,
    relevant: /hood|sweatshirt|pullover/, wrong: /\b(logos?|graphics?|pants|shorts)\b/ },

  /* the brief's second list */
  { q: 'something comfy but not sloppy', target: /sweater|sweatshirt|cardigan|knit|hood|fleece|jogger|lounge|cozy|comfy/, notAsked: /sloppy|dressy/, mayRule: /sloppy/,
    relevant: /sweater|sweatshirt|cardigan|knit|hood|fleece|jogger|lounge|pullover/, wrong: /\b(heels?|blazer|suit|gown|sequin\w*|tuxedo)\b/ },
  { q: 'black pants loose', target: /pant|trouser|slack|chino/, colours: ['black'],
    relevant: /pant|trouser|slack|chino/, strong: /wide|relaxed|loose|baggy|straight|pleated/, wrong: /\b(skinny|leggings?|shorts)\b/ },
  { q: 'i want a shirt thats kinda oversized', target: /shirt/, notAsked: /\b(want|kinda|thats)\b/,
    relevant: /shirt/, strong: /oversized|boxy|relaxed|loose/, wrong: /\b(slim|skinny|fitted|pants|dress)\b/ },
  { q: 'cute top to wear with jeans', target: /top|blouse|shirt|tee|cami|knit/, notAsked: /\bjeans?\b/,
    relevant: /top|blouse|shirt|tee|cami|bodysuit|tank|knit|sweater/, wrong: /\b(jeans?|pants|shorts|skirt|dress)\b/ },
  { q: 'not too tight', target: /./, notAsked: /tight|relaxed|baggy/, mayRule: /tight/,
    relevant: /./, wrong: /\b(tight|bodycon|skinny|compression)\b/ },
  { q: 'not into logos', target: /./, notAsked: /logo|into/, exclude: /\b(logos?|graphics?)\b/, mayRule: /print|brand/,
    relevant: /./, wrong: /\b(logos?|graphics?)\b/ },
  { q: 'not huge or sloppy', target: /./, notAsked: /huge|sloppy|dressy|oversized/, mayRule: /oversiz|huge|sloppy|baggy/,
    relevant: /./, wrong: /\b(oversized|baggy)\b/ },

  /* the plain requests, as a control: these must read and search exactly as before */
  { q: 'red dress', set: 'exact', target: /red/, colours: ['red'], relevant: /dress/, wrong: /\b(pants|shorts|top|shoes?)\b/ },
  { q: 'black oversized hoodie under $80', set: 'exact', target: /hood/, colours: ['black'], maxPrice: 80, relevant: /hood/, wrong: /\b(pants|shorts|jacket|t-?shirt)\b/ },
  { q: 'white sneakers', set: 'exact', target: /sneaker/, colours: ['white'], relevant: /sneaker|trainer|shoe/, wrong: /\b(boots?|sandals?|socks?)\b/ },
  { q: 'navy chinos', set: 'exact', target: /chino/, colours: ['navy'], relevant: /chino|pant|trouser/, wrong: /\b(shorts|jeans|jacket)\b/ },
  { q: 'leather jacket', set: 'exact', target: /leather/, relevant: /jacket/, wrong: /\b(pants|skirt|boots?|bag)\b/ },
  { q: 'nike running shoes', set: 'exact', target: /nike/, brands: ['nike'], relevant: /shoe|sneaker|trainer|running/, wrong: /\b(socks?|shorts|shirt|jacket)\b/ },
  { q: 'gray crewneck sweatshirt', set: 'exact', target: /sweatshirt|crew/, colours: ['grey'], relevant: /sweatshirt|crew/, wrong: /\b(hoodie|hooded|pants|shorts)\b/ },
  { q: 'mens linen pants', set: 'exact', target: /linen/, gender: 'men', relevant: [/linen/, /pant|trouser/], wrong: /\b(shorts|shirt|skirt)\b/ }
];

/* ---------- grading: pure, the same for every checkout ---------- */

const FAMILIES = {
  black: /\b(black|jet|onyx|noir)\b/,
  grey: /\b(gr[ae]y|heather(ed)?|charcoal|ash|silver|slate|graphite|smoke)\b/,
  white: /\b(white|ivory|cream|off.?white|ecru|optic)\b/,
  navy: /\b(navy|midnight|dark blue)\b/,
  blue: /\b(blue|navy|indigo|cobalt|sky|denim blue)\b/,
  red: /\b(red|burgundy|maroon|crimson|wine|scarlet|cherry)\b/,
  green: /\b(green|olive|sage|forest|mint|emerald|khaki green)\b/,
  brown: /\b(brown|tan|cognac|chocolate|camel|chestnut|mocha|espresso|coffee|walnut|tobacco)\b/,
  beige: /\b(beige|khaki|tan|sand|stone|natural|oatmeal|camel|taupe|cream|ecru)\b/,
  pink: /\b(pink|blush|rose|fuchsia|magenta)\b/,
  purple: /\b(purple|lilac|lavender|violet|plum)\b/,
  yellow: /\b(yellow|mustard|lemon|gold)\b/,
  orange: /\b(orange|rust|coral|burnt orange)\b/
};
const ANY_COLOUR = /\b(black|white|gr[ae]y|navy|blue|red|green|pink|purple|yellow|orange|brown|beige|khaki|tan|cream|ivory|olive|burgundy|maroon|charcoal|camel|lilac|lavender|teal|mustard|rust|coral|sage|fuchsia|magenta)\b/g;

/* the catalogue's own colour families, which the served interpreter is
   told to answer in: one of these is invented only when it stands for
   none of the colours stated */
const CATALOGUE_FAMILIES = {
  neutral: ['grey', 'beige', 'white', 'black'], earth: ['brown', 'beige', 'green', 'red', 'yellow', 'orange'],
  bright: ['red', 'pink', 'yellow', 'orange', 'purple'], pastel: ['pink', 'purple', 'blue', 'green', 'yellow'],
  blue: ['blue', 'navy'], green: ['green'], black: ['black'], white: ['white']
};

const low = (s) => String(s || '').toLowerCase();
const listOf = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function matches(rule, title) {
  if (!rule) return false;
  if (typeof rule === 'function') return Boolean(rule(title));
  if (Array.isArray(rule)) return rule.every((one) => matches(one, title));
  return rule.test(title);
}

function familyOf(word) {
  const w = low(word);
  return Object.keys(FAMILIES).filter((name) => FAMILIES[name].test(w));
}

/* a title that names colours, none of them one the request stated */
function colourConflict(title, colours) {
  if (!colours || !colours.length) return false;
  const named = title.match(ANY_COLOUR) || [];
  if (!named.length) return false;
  return !colours.some((family) => FAMILIES[family] && FAMILIES[family].test(title));
}

function genderConflict(title, gender) {
  if (!gender) return false;
  const saysWomen = /\b(women'?s?|womens|ladies|ladies'|female|girls?)\b/.test(title);
  const saysMen = /\b(men'?s?|mens|male|boys?)\b/.test(title);
  const unisex = /\bunisex\b/.test(title);
  if (unisex) return false;
  return gender === 'women' ? saysMen && !saysWomen : gender === 'men' ? saysWomen && !saysMen : false;
}

/* what the reading recorded as ruled out, whichever checkout read it:
   garments (excluded, and their words in drop) and modifiers (without).
   Not `avoid`, which only orders things lower, and not the garments it
   is worn with, which are not searched but are not ruled out either. */
function recordedExclusions(intent) {
  const c = (intent && intent.concepts) || {};
  return [...new Set(listOf(c.drop).concat(listOf(c.without), listOf(c.excluded)).map(low).filter(Boolean))];
}

const genderOf = (word) => {
  const w = low(word);
  if (/^(women|woman|womens|women's|female|ladies|lady|girls?)$/.test(w)) return 'women';
  if (/^(men|man|mens|men's|male|guys?|boys?)$/.test(w)) return 'men';
  return w || null;
};

function gradeReading(c, observed) {
  const intent = observed.intent || {};
  const asked = low(observed.asked);
  const recorded = recordedExclusions(intent);
  const notes = [];

  const targetOk = c.target.test(asked);
  if (!targetOk) notes.push(`asked "${observed.asked}", not the target`);
  const contextOk = !(c.notAsked && c.notAsked.test(asked));
  if (!contextOk) notes.push(`asked for "${(asked.match(c.notAsked) || [''])[0]}", which the request did not want searched`);

  let exclusionOk = true;
  if (c.exclude) {
    const kept = recorded.some((word) => c.exclude.test(word) || (c.mayRule && c.mayRule.test(word)));
    if (!kept) { exclusionOk = false; notes.push('the exclusion was not recorded'); }
    if (c.exclude.test(asked)) { exclusionOk = false; notes.push('the exclusion was searched for'); }
  }
  /* nothing ruled out that the request did not rule out */
  const stray = recorded.filter((word) => !(c.exclude && c.exclude.test(word)) && !(c.mayRule && c.mayRule.test(word)));
  if (stray.length) { exclusionOk = false; notes.push(`ruled out "${stray.join('", "')}", which the request did not`); }

  /* stated constraints kept, nothing unstated added. A colour is kept
     when the search asks for it; a catalogue family ("Bright") alone does
     not put "red" in front of the provider */
  const colours = c.colours || [];
  let constraintsOk = true;
  const covers = (one) => {
    const name = low(one);
    if (CATALOGUE_FAMILIES[name] && !FAMILIES[name]) return CATALOGUE_FAMILIES[name];
    return familyOf(one).concat(CATALOGUE_FAMILIES[name] || []);
  };
  const conceptColours = listOf(intent.concepts && intent.concepts.colors);
  const readColours = listOf(intent.colors).concat(conceptColours, asked.match(ANY_COLOUR) || []);
  const invented = readColours.filter((one) => !covers(one).some((f) => colours.includes(f)));
  if (invented.length) { constraintsOk = false; notes.push(`colour "${[...new Set(invented)].join('", "')}" was never stated`); }
  const searched = (asked.match(ANY_COLOUR) || []).concat(conceptColours);
  for (const family of colours) {
    if (!searched.some((one) => familyOf(one).includes(family))) { constraintsOk = false; notes.push(`the stated ${family} is not searched`); }
  }
  const wantMax = c.maxPrice == null ? null : c.maxPrice;
  if ((intent.maxPrice || null) !== wantMax) { constraintsOk = false; notes.push(`budget ${intent.maxPrice || 'none'}, stated ${wantMax || 'none'}`); }
  if (intent.minPrice) { constraintsOk = false; notes.push(`a minimum price of ${intent.minPrice} was never stated`); }
  const gender = genderOf(intent.gender || (intent.concepts && intent.concepts.gender) || '');
  const said = c.gender || null;
  if (gender && !said) { constraintsOk = false; notes.push(`gender "${gender}" was never stated`); }
  if (said && !gender && !asked.split(/\s+/).some((w) => genderOf(w) === said)) { constraintsOk = false; notes.push(`the stated ${said} was lost`); }
  if (gender && said && gender !== said) { constraintsOk = false; notes.push(`gender "${gender}", stated ${said}`); }
  const brands = listOf(intent.brands).map(low).filter((b) => !(c.brands || []).includes(b));
  if (brands.length) { constraintsOk = false; notes.push(`brand "${brands.join('", "')}" was never stated`); }

  return {
    correct: targetOk && contextOk && exclusionOk && constraintsOk,
    targetOk: targetOk && contextOk,
    exclusionOk,
    constraintsOk,
    notes
  };
}

function gradeProduct(c, product) {
  const title = low(product.name);
  const excluded = Boolean(c.exclude && c.exclude.test(title));
  const colour = colourConflict(title, c.colours);
  const gender = genderConflict(title, c.gender);
  const over = c.maxPrice != null && product.price > c.maxPrice;
  const under = c.minPrice != null && product.price < c.minPrice;
  const wrong = excluded || colour || gender || matches(c.wrong, title);
  const relevant = !wrong && matches(c.relevant, title);
  /* plainly what was asked, and says so about every detail stated */
  const statesColours = (c.colours || []).every((family) => FAMILIES[family] && FAMILIES[family].test(title));
  const strong = relevant && statesColours && (!c.strong || matches(c.strong, title));
  const hard = [];
  if (excluded) hard.push('ruled out');
  if (colour) hard.push('another colour');
  if (gender) hard.push('the other gender');
  if (over) hard.push(`over the stated $${c.maxPrice}`);
  if (under) hard.push(`under the stated $${c.minPrice}`);
  return { relevant, strong, wrong, excluded, hard };
}

function grade(c, observed) {
  const reading = gradeReading(c, observed);
  const products = (observed.products || []).map((p) => Object.assign({}, p, gradeProduct(c, p)));
  const top = (k) => products.slice(0, k);
  const removed = (observed.removed || []).map((r) => Object.assign({}, r, gradeProduct(c, { name: r.name, price: 0 })));
  return {
    reading,
    relevantAt4: top(4).filter((p) => p.relevant).length / 4,
    relevantAt8: top(8).filter((p) => p.relevant).length / 8,
    strongAt8: top(8).filter((p) => p.strong).length,
    wrongAt8: top(8).filter((p) => p.wrong).length,
    hardViolations: products.reduce((n, p) => n + p.hard.length, 0),
    exclusionViolations: products.filter((p) => p.excluded).length,
    wronglyRemoved: removed.filter((r) => r.relevant).length,
    products,
    removed
  };
}

/* ---------- a worker: one checkout, in a process of its own ---------- */

function worker(root, reader) {
  const at = (...parts) => path.join(root, ...parts);
  const { interpretQuery } = require(at('api', 'interpret'));
  const { shapeIntent, searchWithFallback, requestBudget, DEFAULT_LIMIT } = require(at('api', 'search'));
  const { getProvider } = require(at('api', '_providers', 'product-source'));
  const { queryFrom } = require(at('api', '_providers', 'query'));
  const cache = require(at('api', '_cache'));

  /* the page, exactly as the browser loads it */
  require(at('assets', 'products.js'));
  const catalogue = at('assets', 'catalog.js');
  if (fs.existsSync(catalogue)) {
    require('vm').runInThisContext(`${fs.readFileSync(catalogue, 'utf8')}\n;globalThis.__fyndDemoProducts = typeof DEMO_PRODUCTS === 'undefined' ? [] : DEMO_PRODUCTS;`, { filename: catalogue });
  }
  for (const file of ['interpret.js', 'search.js']) require(at('assets', file));
  const loaded = Promise.resolve(globalThis.Products.load(globalThis.__fyndDemoProducts || []));
  const vocabulary = () => {
    const Products = globalThis.Products;
    const f = Products.facets();
    return {
      categories: [...new Set(Products.all().map((p) => p.category).filter(Boolean))],
      colors: [...f.colors.keys()], occasions: [...f.occasions.keys()], fits: [...f.fits.keys()],
      brands: [...f.brands.keys()], styles: [...f.styles.keys()]
    };
  };

  const realFetch = globalThis.fetch;
  globalThis.FINDWEAR_API = 'http://page.invalid/api/interpret';
  globalThis.FINDWEAR_SEARCH_API = 'http://page.invalid/api/search';

  async function one(query) {
    await loaded;
    cache.reset();
    const wire = { interpreter: 0, searches: [], offers: 0, other: 0 };
    let phase = 'interpret';
    let posted = null;
    let reading = null;
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    globalThis.fetch = async (input, init) => {
      const href = String(input && input.url ? input.url : input);
      if (href === globalThis.FINDWEAR_API) {
        /* /api/interpret, as its handler answers: 503 when nothing is
           configured to read with (the page then reads it locally), the
           reading when it worked, 502 when it did not */
        const configured = process.env.AI_PROVIDER || process.env.OPENAI_API_KEY;
        if (reader === 'local' || !configured) return reply(503, { error: 'Interpreter is not configured.' });
        const body = JSON.parse(init.body);
        reading = await interpretQuery({ query: body.query, vocabulary: body.vocabulary || {} });
        if (!reading.ok) return reply(502, { error: 'The interpreter is unavailable right now.' });
        return reply(200, { source: reading.source, query: body.query, preferences: reading.preferences });
      }
      if (href === globalThis.FINDWEAR_SEARCH_API) { posted = JSON.parse(init.body); return reply(599, { error: 'captured' }); }
      if (phase === 'page') throw new Error(`the page made an unexpected request: ${href}`);
      try {
        const url = new URL(href);
        if (phase === 'interpret') wire.interpreter += 1;
        else if (/\/search$|\/shopping$|\/search\.json$/.test(url.pathname)) wire.searches.push(url.searchParams.get('q'));
        else if (/offers/.test(url.pathname)) wire.offers += 1;
        else wire.other += 1;
      } catch (err) { wire.other += 1; }
      return realFetch(input, init);
    };

    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await globalThis.Interpreter.interpret(query, vocabulary());
      phase = 'page';
      await globalThis.ProductSearch.find(outcome.preferences, undefined, []);
    } finally {
      phase = 'search';
    }
    const interpretMs = Date.now() - startedAt;
    const intent = shapeIntent(posted ? posted.intent : {});
    const limit = Math.min(Math.max(Number(posted && posted.limit) || DEFAULT_LIMIT, 1), 48);

    const searchStarted = Date.now();
    let found = null;
    let failed = null;
    try {
      found = await searchWithFallback(getProvider(), intent, limit, cache.counters(), Date.now() + requestBudget());
    } catch (err) {
      failed = { message: String(err && err.message).split('\n')[0].slice(0, 200), status: Number.isInteger(err && err.status) ? err.status : null };
    } finally {
      globalThis.fetch = realFetch;
    }
    const searchMs = Date.now() - searchStarted;
    const offers = found && found.funnel && found.funnel.offers;
    return {
      query,
      interpreter: outcome.source,
      interpreterNotice: outcome.notice || null,
      modelUsed: Boolean(reading && reading.ok),
      understood: reading && reading.understood ? reading.understood : null,
      intent,
      asked: wire.searches[0] != null ? wire.searches[0] : queryFrom(intent),
      providerAnswered: found ? found.provider : null,
      fellBackFrom: found && found.fellBackFrom ? found.fellBackFrom : null,
      failed,
      interpretMs,
      searchMs,
      totalMs: interpretMs + searchMs,
      interpreterCalls: wire.interpreter,
      providerSearches: wire.searches.length,
      providerQueries: wire.searches,
      offerLookups: wire.offers,
      lookupsMade: offers && Number.isFinite(Number(offers.lookupsMade)) ? Number(offers.lookupsMade) : null,
      otherProviderRequests: wire.other,
      reachedGate: found ? found.records.length : 0,
      verified: found ? found.products.length : 0,
      reordered: found ? Boolean(found.reordered) : false,
      rejected: found ? found.rejected : {},
      products: found ? found.products.map((p) => ({ name: p.name, price: p.price, retailer: p.retailer, productUrl: p.productUrl, imageUrl: p.imageUrl, id: p.id })) : [],
      removed: found && Array.isArray(found.semanticRemoved) ? found.semanticRemoved.map((r) => ({ name: r.name, kind: r.kind, why: r.why, position: r.position })) : []
    };
  }

  process.on('message', async (msg) => {
    try {
      process.send({ id: msg.id, ok: true, result: await one(msg.query) });
    } catch (err) {
      process.send({ id: msg.id, ok: false, error: String(err && err.stack || err).slice(0, 600) });
    }
  });
  process.send({ ready: true });
}

/* ---------- the run ---------- */

function startWorker(name, root, reader) {
  const child = fork(__filename, ['--worker', root, reader], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const waiting = new Map();
  let next = 0;
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (msg) => {
      if (msg.ready) return resolve();
      const done = waiting.get(msg.id);
      if (done) { waiting.delete(msg.id); done(msg); }
    });
    child.once('exit', (code) => {
      for (const done of waiting.values()) done({ ok: false, error: `worker exited (${code})` });
      waiting.clear();
      reject(new Error(`${name} exited before it was ready (${code})`));
    });
  });
  return {
    name, root, ready,
    ask: (query, ms) => new Promise((resolve) => {
      const id = next += 1;
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, error: `no answer in ${ms}ms` }); }, ms);
      waiting.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.send({ id, query });
    }),
    stop: () => child.kill()
  };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const pct = (xs, p) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

function summarise(rows) {
  const ok = rows.filter((r) => r.observed);
  const g = (f) => ok.map((r) => f(r));
  const withExclusion = ok.filter((r) => r.case.exclude);
  const sources = {};
  for (const r of ok) sources[r.observed.interpreter] = (sources[r.observed.interpreter] || 0) + 1;
  return {
    requests: rows.length,
    answered: ok.length,
    crashed: rows.length - ok.length,
    providerFailures: ok.filter((r) => r.observed.failed).length,
    interpreterSources: sources,
    interpretationCorrect: mean(g((r) => (r.graded.reading.correct ? 1 : 0))),
    targetCorrect: mean(g((r) => (r.graded.reading.targetOk ? 1 : 0))),
    exclusionCorrect: mean(g((r) => (r.graded.reading.exclusionOk ? 1 : 0))),
    exclusionRecordedWhereStated: withExclusion.length ? mean(withExclusion.map((r) => (r.graded.reading.exclusionOk ? 1 : 0))) : null,
    constraintsCorrect: mean(g((r) => (r.graded.reading.constraintsOk ? 1 : 0))),
    relevantAt4: mean(g((r) => r.graded.relevantAt4)),
    relevantAt8: mean(g((r) => r.graded.relevantAt8)),
    strongAt8: sum(g((r) => r.graded.strongAt8)),
    wrongAt8: sum(g((r) => r.graded.wrongAt8)),
    hardViolations: sum(g((r) => r.graded.hardViolations)),
    exclusionViolations: sum(g((r) => r.graded.exclusionViolations)),
    wronglyRemoved: sum(g((r) => r.graded.wronglyRemoved)),
    removed: sum(g((r) => r.observed.removed.length)),
    zeroResults: ok.filter((r) => !r.observed.verified).length,
    verifiedMean: mean(g((r) => r.observed.verified)),
    providerSearchesMean: mean(g((r) => r.observed.providerSearches)),
    providerSearchesMax: Math.max(0, ...g((r) => r.observed.providerSearches)),
    offerLookupsMean: mean(g((r) => r.observed.offerLookups)),
    offerLookupsMax: Math.max(0, ...g((r) => r.observed.offerLookups)),
    interpreterCallsMean: mean(g((r) => r.observed.interpreterCalls)),
    interpretMsP50: pct(g((r) => r.observed.interpretMs), 0.5),
    interpretMsP95: pct(g((r) => r.observed.interpretMs), 0.95),
    searchMsP50: pct(g((r) => r.observed.searchMs), 0.5),
    searchMsP95: pct(g((r) => r.observed.searchMs), 0.95),
    totalMsP50: pct(g((r) => r.observed.totalMs), 0.5),
    totalMsP95: pct(g((r) => r.observed.totalMs), 0.95)
  };
}

/* the same request on two checkouts: what changed */
function differences(cases, byRoot, before, after) {
  const out = [];
  cases.forEach((c, i) => {
    const a = byRoot[before][i];
    const b = byRoot[after][i];
    if (!a.observed || !b.observed) return;
    const urls = (r) => r.observed.products.slice(0, 8).map((p) => p.productUrl);
    const shared = urls(a).filter((u) => urls(b).includes(u)).length;
    out.push({
      query: c.q,
      set: c.set || 'messy',
      askedBefore: a.observed.asked,
      askedAfter: b.observed.asked,
      sameQuery: a.observed.asked === b.observed.asked,
      sharedTop8: shared,
      relevantAt8: [a.graded.relevantAt8, b.graded.relevantAt8],
      strongAt8: [a.graded.strongAt8, b.graded.strongAt8],
      wrongAt8: [a.graded.wrongAt8, b.graded.wrongAt8],
      correct: [a.graded.reading.correct, b.graded.reading.correct],
      score: (b.graded.relevantAt8 - a.graded.relevantAt8) - (b.graded.wrongAt8 - a.graded.wrongAt8) / 8
        + ((b.graded.reading.correct ? 1 : 0) - (a.graded.reading.correct ? 1 : 0)) * 0.25
    });
  });
  return out;
}

async function run(options) {
  const opts = options || {};
  const roots = opts.roots && opts.roots.length ? opts.roots : [{ name: 'this', root: HERE }];
  const reader = opts.reader === 'local' ? 'local' : 'served';
  let cases = CASES.filter((c) => opts.set === 'all' || !opts.set || (c.set || 'messy') === opts.set);
  if (opts.only) cases = opts.only.map((q) => CASES.find((c) => c.q === q) || { q, target: /./, relevant: /./ });
  const workers = roots.map((r) => startWorker(r.name, path.resolve(r.root), reader));
  await Promise.all(workers.map((w) => w.ready));
  const byRoot = {};
  for (const w of workers) byRoot[w.name] = [];
  try {
    for (let i = 0; i < cases.length; i += 1) {
      const c = cases[i];
      /* alternate who asks first, so neither always meets a warmer provider */
      const order = i % 2 ? workers.slice().reverse() : workers;
      for (const w of order) {
        const answer = await w.ask(c.q, opts.timeoutMs || 120000);
        const row = { case: c, observed: answer.ok ? answer.result : null, error: answer.ok ? null : answer.error };
        row.graded = row.observed ? grade(c, row.observed) : null;
        byRoot[w.name][i] = row;
        if (opts.progress) opts.progress(w.name, i, cases.length, row);
      }
    }
  } finally {
    workers.forEach((w) => w.stop());
  }
  const summary = {};
  for (const w of workers) summary[w.name] = summarise(byRoot[w.name]);
  const names = workers.map((w) => w.name);
  const compared = names.length > 1 ? differences(cases, byRoot, names[0], names[names.length - 1]) : null;
  return { reader, roots: roots.map((r) => ({ name: r.name, root: path.resolve(r.root) })), cases: cases.map((c) => c.q), byRoot, summary, compared };
}

/* ---------- the report ---------- */

const f2 = (n) => (n == null ? '—' : Number(n).toFixed(2));
const p0 = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);

function print(out) {
  const names = Object.keys(out.summary);
  const line = (label, f) => console.log(`${label.padEnd(34)}${names.map((n) => String(f(out.summary[n])).padStart(14)).join('')}`);
  console.log(`\nreader: ${out.reader} · ${out.cases.length} requests · ${names.map((n) => `${n} = ${out.roots.find((r) => r.name === n).root}`).join(' · ')}\n`);
  console.log(`${''.padEnd(34)}${names.map((n) => n.padStart(14)).join('')}`);
  line('interpreter answered', (s) => Object.entries(s.interpreterSources).map(([k, v]) => `${k}:${v}`).join(' '));
  line('crashed / provider failed', (s) => `${s.crashed} / ${s.providerFailures}`);
  line('interpretation correct', (s) => p0(s.interpretationCorrect));
  line('  target correct', (s) => p0(s.targetCorrect));
  line('  exclusions correct', (s) => p0(s.exclusionCorrect));
  line('  exclusions kept, where stated', (s) => p0(s.exclusionRecordedWhereStated));
  line('  constraints kept, none invented', (s) => p0(s.constraintsCorrect));
  line('relevant@4 (mean)', (s) => f2(s.relevantAt4));
  line('relevant@8 (mean)', (s) => f2(s.relevantAt8));
  line('strong matches in top 8 (total)', (s) => s.strongAt8);
  line('clearly wrong in top 8 (total)', (s) => s.wrongAt8);
  line('hard-constraint violations', (s) => s.hardViolations);
  line('  of which ruled-out shown', (s) => s.exclusionViolations);
  line('wrongly removed by the filter', (s) => s.wronglyRemoved);
  line('removed by the filter (all)', (s) => s.removed);
  line('zero results', (s) => s.zeroResults);
  line('verified per search (mean)', (s) => f2(s.verifiedMean));
  line('provider searches (mean / max)', (s) => `${f2(s.providerSearchesMean)} / ${s.providerSearchesMax}`);
  line('offer lookups (mean / max)', (s) => `${f2(s.offerLookupsMean)} / ${s.offerLookupsMax}`);
  line('interpreter calls (mean)', (s) => f2(s.interpreterCallsMean));
  line('interpret ms p50 / p95', (s) => `${s.interpretMsP50} / ${s.interpretMsP95}`);
  line('search ms p50 / p95', (s) => `${s.searchMsP50} / ${s.searchMsP95}`);
  line('total ms p50 / p95', (s) => `${s.totalMsP50} / ${s.totalMsP95}`);

  for (const name of names) {
    console.log(`\n=== ${name} ===`);
    out.byRoot[name].forEach((row) => {
      if (!row.observed) { console.log(`\n${row.case.q}\n  CRASHED ${row.error}`); return; }
      const o = row.observed;
      const g = row.graded;
      console.log(`\n${row.case.q}\n  ${o.interpreter}${o.understood ? ` (${o.understood.by})` : ''} · asked "${o.asked}" · ${o.providerSearches} search, ${o.offerLookups} lookups · ${o.verified} verified · ${o.totalMs}ms`
        + ` · r@4 ${f2(g.relevantAt4)} r@8 ${f2(g.relevantAt8)} wrong ${g.wrongAt8}${o.failed ? ` · FAILED ${o.failed.message}` : ''}`);
      if (g.reading.notes.length) console.log(`  reading: ${g.reading.notes.join('; ')}`);
      g.products.slice(0, 8).forEach((p, i) => console.log(`   ${i + 1}. ${p.strong ? '★' : p.relevant ? '✓' : p.wrong ? '✗' : '·'} ${p.name} — $${p.price} at ${p.retailer}${p.hard.length ? `   !! ${p.hard.join(', ')}` : ''}`));
      g.removed.forEach((r) => console.log(`   − removed #${r.position} ${r.relevant ? '(WRONGLY) ' : ''}${r.name} — ${r.why}`));
    });
  }

  if (out.compared) {
    const [before, after] = [names[0], names[names.length - 1]];
    const exact = out.compared.filter((d) => d.set === 'exact');
    console.log(`\n=== ${before} → ${after} ===`);
    if (exact.length) console.log(`plain requests: same provider query ${exact.filter((d) => d.sameQuery).length}/${exact.length}; top-8 products shared ${exact.map((d) => d.sharedTop8).join(', ')}`);
    const ranked = out.compared.slice().sort((a, b) => a.score - b.score);
    const show = (d) => console.log(`  ${d.score >= 0 ? '+' : ''}${f2(d.score)}  ${d.query}\n         "${d.askedBefore}" → "${d.askedAfter}" · r@8 ${f2(d.relevantAt8[0])}→${f2(d.relevantAt8[1])} · wrong ${d.wrongAt8[0]}→${d.wrongAt8[1]} · reading ${d.correct[0] ? 'ok' : 'wrong'}→${d.correct[1] ? 'ok' : 'wrong'}`);
    console.log('worst regressions:');
    ranked.filter((d) => d.score < 0).slice(0, 8).forEach(show);
    console.log('best improvements:');
    ranked.filter((d) => d.score > 0).reverse().slice(0, 8).forEach(show);
  }
}

function parseRoots(text) {
  return String(text).split(',').filter(Boolean).map((pair) => {
    const at = pair.indexOf('=');
    return at === -1 ? { name: path.basename(path.resolve(pair)), root: pair } : { name: pair.slice(0, at), root: pair.slice(at + 1) };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') return worker(args[1], args[2]);
  const value = (flag) => { const at = args.indexOf(flag); return at === -1 ? null : args[at + 1]; };
  const out = await run({
    roots: value('--roots') ? parseRoots(value('--roots')) : null,
    reader: value('--reader') || 'served',
    only: value('--only') ? value('--only').split('|') : null,
    set: value('--set') || 'all',
    progress: args.includes('--json') ? null : (name, i, n, row) => process.stderr.write(`\r${name} ${i + 1}/${n} ${row.observed ? '' : 'crashed '}`.padEnd(40))
  });
  process.stderr.write('\n');
  const file = value('--out');
  if (file) fs.writeFileSync(file, JSON.stringify(out, (k, v) => (v instanceof RegExp ? String(v) : typeof v === 'function' ? '[rule]' : v), 2));
  if (args.includes('--json')) console.log(JSON.stringify(out.summary, null, 2));
  else print(out);
  /* the one that ran last is the one being judged */
  const judged = out.summary[Object.keys(out.summary).pop()];
  if (judged.crashed || judged.exclusionViolations || judged.providerSearchesMax > 1) process.exitCode = 1;
}

if (require.main === module) main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });

module.exports = { run, grade, gradeReading, gradeProduct, colourConflict, genderConflict, recordedExclusions, summarise, CASES };
