# Fynd for Chrome: the Fit panel (MVP)

A Manifest V3 Chrome extension for shopping on a computer. On a clothing
product page, click Fynd's toolbar button and Chrome's side panel opens beside
the page. It works in five steps:

1. **Product.** Fynd reads the product: its name, brand, colour, code and the
   sizes on offer. You confirm or correct it, and say what kind of garment it
   is.
2. **Measurements.** Fynd finds the size tables on the page and says whether
   each one measures the **finished garment**, the **body**, or doesn't say.
   A body chart is never used as the garment's. With no chart, you can enter
   the measurements by hand.
3. **Review.** You check every value it read, correct anything wrong, and say
   how the chart measures each one. Anything Fynd can't tell stays unknown and
   is never guessed.
4. **Your garment.** You choose a garment saved on your Fynd fit profile. It
   is read from Fynd with your own sign-in; nothing is stored in the extension.
5. **Results.** **Fynd's server** compares every size with that garment in
   **one request**, using the same engine and decision rules as Find Fit on
   the site. The panel shows the server's answer as it is. It never ranks,
   scores or recommends anything itself.

It is a first version, loaded unpacked. It isn't on the Chrome Web Store.

**What has been verified, and what hasn't** (details under [Tests](#tests)):

- **Verified:** the whole workflow, in a real, visible Chrome, with the
  extension as shipped. That covers:
  - a real click on the toolbar button;
  - a real Fynd session cookie, sent with the extension's requests to Fynd's
    API under its production name (answered by Fynd's own handlers on the test
    machine);
  - **synthetic shop pages** served from that machine.
- **Not verified:** no real retailer's page and no request to the live
  deployment has been checked. `node scripts/test-fit-panel-real-chrome.js
  --live <url> …` reads real pages wherever they can be reached.

## Install it locally

1. Get this repository on your computer: clone it, or download it as a ZIP
   and unzip it.
2. In Chrome (116 or later), go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension/` folder inside the
   repository.
5. Pin **Fynd** from the puzzle-piece menu, so its button stays on the
   toolbar.
6. Sign in to Fynd in the same Chrome profile
   (<https://ai-clothes-application.vercel.app/account.html>). On your fit
   profile, save at least one garment you own with its measurements.

After changing any file in `extension/`, click the reload icon on Fynd's card
in `chrome://extensions`.

The manifest's `key` fixes the extension's ID at
`jnjodlmanmolanoodeojaeajcjdhbjdd`, wherever it is loaded from. That ID is the
one extension origin Fynd's API accepts (`api/_cors.js`, `EXTENSION_ORIGINS`).

## What it may do

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | To read the page you clicked Fynd on, once per click. No page is read without a click, and no content script runs on any site. |
| `sidePanel` | The Fit panel. |
| `storage` | Only `storage.session`: which tab the toolbar was clicked on, so the panel can read it as it opens. It is cleared when Chrome closes. Nothing is kept on disk. |
| host `https://ai-clothes-application.vercel.app/*` | Fynd's own API, for your saved garments, the comparison and the AI-assisted chart reading. This is the only host. No retailer's site and no AI provider is ever requested. |

There are no optional permissions and no remote code. The content security
policy allows only the extension's own scripts.

## What is read, and what is sent

**Read from the page, in your browser, on your click:**

- the product's structured data (JSON-LD `Product` / `ProductGroup`, its
  variants and their availability);
- otherwise, its meta tags, heading and size picker;
- its size tables and how each is labelled.

Form fields you've typed into are never read, and nothing on the page is
clicked or changed.

**Sent to Fynd (`extension/api.js`, the only code that makes requests).** The
first two below always happen; the third only when a chart needs the
AI-assisted reading (next section):

1. `GET /api/fit-profile`: your saved garments, with your Fynd session cookie.
2. `POST /api/size-recommendation?compare=1&candidate=1` with this body:

   ```json
   { "chart": { "measures": "finished-garment", "type": "hoodies",
                "brand": "…", "name": "…", "url": "https://shop…/product",
                "unit": "cm",
                "methods": { "registry": 1, "chestWidth": "flat-width-armpit-to-armpit", "…": "…" },
                "sizes": [ { "size": "M",
                             "measurements": { "chestWidth": 55.5, "…": 0 },
                             "provenance": { "chestWidth": { "source": "page-table", "header": "Chest (½)", "corrected": false } } } ] },
     "referenceType": "hoodies" }
   ```

   - **The address:** the page's canonical address, with tracking parameters
     and the fragment removed.
   - **Provenance:** for every value, its source (`page-table`, or `shopper`
     for one you typed in), the column heading it came from, and whether you
     corrected it. The server keeps it as given; it is never treated as
     trusted, and it doesn't change what is compared.
   - **Methods:** how the chart measures each value. A method the chart doesn't
     state is sent as `not-stated`, and the engine never compares those.

**What the server does with it:**

- **Reads the chart.** `assets/fit-candidate.js` `readChart` refuses:
  - a body chart, with reason `body-measurements`;
  - a chart that doesn't say what it measures, with reason
    `measures-not-stated`;
  - anything malformed, with reason `invalid-chart` and a message for each
    field.
- **Builds one record.** `engine.candidateRecord` turns the chart into one
  shopper-entered record with every size. Its values are labelled
  `shopper-entered`, with the page as their source. They are never
  "verified", so reliability is at most medium.
- **Compares and decides.** The existing `compare` and `decide` run on that
  record and your chosen garment, giving OK, NO_MATCH or INSUFFICIENT_DATA.
- **Keeps the existing limits.** These are the same rate limit as Find Fit's
  hand-entered comparison: `sizing:compare-unsaved`, 60 per 10 minutes per
  address, and a whole chart counts once. The plan's usage meter isn't
  touched, and nothing is billed.
- **Handles a missing or unknown garment.** Without a session it answers
  401 `sign-in-required`. For a garment type you haven't saved it answers
  404 `reference-not-found`.

## Automatic, or checked by you

A reading is **automatic** only when Fynd read everything from the chart
itself and nothing is uncertain:

- the unit, each method and "garment measurements" are stated in the chart's
  own caption or headings;
- the rows line up with the headings;
- the reading is complete.

Anything else is shown for you to check, and you can't go on until you tick
**I've checked these against the chart on the page**. That covers:

- a unit, method or "garment measurements" stated only in text near the
  table. That text may be about something else, or written to mislead;
- rows that don't line up with their headings;
- a part Fynd couldn't read on its own;
- every AI-assisted reading.

Text near the table that is addressed to software is not used at all.
Spotting it relies on keywords, so it is only one layer: nothing depends on
it. Merged heading cells are expanded before anything is read, so a column
always reads its own values.

## When Fynd asks its AI to read a chart

Most charts are read **deterministically**, in your browser, by Fynd's own
rules (`assets/sizing-tables.js`, `assets/chart-reading.js`,
`extract.js`). No model is involved. That is the fast path.

Fynd asks its AI only when a table is plainly a size chart (a column of
sizes, numbers beside it) that it can't interpret reliably, and the page has
words its own reading didn't use (`extract.js` `interpretationNeeds`):

- headings it doesn't know ("Pit to Pit", "Back", "Arm"), so it can't read
  the table at all;
- headings spread over two rows, or a merged heading cell;
- a measuring method written outside the headings (for example in a note
  above the table);
- a unit written somewhere its own reading doesn't look.

A body chart is never sent. When a method or unit simply isn't on the page,
no model is asked either: you choose it.

**What is sent:** `POST /api/size-recommendation?parse=1` to Fynd's own server, with the
table's cell text, its caption and the words just before it. Nothing about
you, and nothing else from the page. The extension never calls a model, and
holds no key.

**What Fynd's server does** (`api/_sizing/parse-chart.js`,
`api/_sizing/chart-ai.js`):

1. **Checks the caller.** You must be signed in, the request must be JSON,
   and the body is at most 12,000 characters. The limit is 20 per 10 minutes.
   Each model call counts against your plan's existing AI allowance (the same
   one Fynd's search interpreter uses). There is a daily ceiling across all
   shoppers (`PARSE_CHART_DAILY_MODEL_CALLS`). Each request makes one call,
   with no retry, a 12-second timeout and at most 2,048 output tokens.
2. **Asks Gemini to propose a reading.** The proposal covers which rows are
   headings, which column holds sizes, each column's measurement and method,
   the unit, and what the table measures. Every claim must quote the exact
   words on the page, and the model returns **no values**.
3. **Checks every part of the proposal against the page,** with Fynd's own
   deterministic readers:
   - each quote must really be on the page, where it says;
   - a measurement must agree with what its heading names, and is never a
     body measurement (waist, hips…);
   - a method must be stated by the quoted words, by Fynd's own reading;
   - a unit or method is filled in only when the chart's own caption or
     headings state it. One stated only in text near the table comes back as
     a suggestion you choose yourself. A unit is never inferred from the size
     of the numbers, never taken against the page, and never converted;
   - a body chart stays a body chart, and a chart that doesn't say what it
     measures stays unconfirmed until you confirm it;
   - page text addressed to software ("ignore previous instructions…") is
     never evidence;
   - an answer with any extra field (a value, "verified", a recommendation) is
     refused whole.
4. **Recovers every value** from the original cell, through Fynd's own
   parser.
5. **Sends back a proposal.** Anything it couldn't support is left
   unresolved, with the reason. The answer is never "verified" and carries no
   size.

**What you see:** the panel says "Reading this chart more closely" while
waiting, and you can choose **Review it myself instead**. Then each suggestion
is shown with the page's own words. **You must tick "I've checked these
suggestions"** before continuing. Values from an AI-assisted reading are sent
marked `interpretedBy: "ai"`, and the comparison reads them through the same
`readChart`, engine and decision as any other chart.

**If the AI reading fails** (not signed in, unavailable, rate-limited, too
slow, an answer that broke the rules, a table it can't make out), the panel
says why and keeps **Fynd's own reading** for you to correct. A table Fynd
couldn't read at all falls back to entering the measurements by hand. No size
is ever made up.

Repeated charts are cached on the server for 7 days. The cache key is the
table's text, the garment type, the model, the prompt version and the answer
schema's version, never you. A cached answer is
checked again on every use and spends no allowance.

## What the panel shows

| State | What you see |
|---|---|
| Not a product page | "No product found on this page", with the choice to enter it by hand |
| Page Chrome won't let extensions read (settings, Web Store, PDFs) | Says so |
| Clicked on another page or site | "Click Fynd to read this page" |
| No chart on the page | Says so, with where the shop keeps it (for known shops) and manual entry |
| Body chart only | Shown, labelled *Body measurements*, and can't be chosen |
| Chart that doesn't say what it measures | Used only after you confirm it is the garment's own measurements |
| Range, word or blank in the chart | Flagged. A blank is left out, and a range must be corrected or cleared |
| Signed out of Fynd | "Sign in to Fynd…", with a link, and **Try again** |
| No garment saved | Says so, with a link to add one |
| OK | The size that meets Fynd's comparison criteria, every size's differences, reliability and caveats |
| NO_MATCH | "No size meets Fynd's comparison criteria", and the closest size, marked *not a recommendation* |
| INSUFFICIENT_DATA | Why, measurement by measurement. No size is shown |
| 401 / 404 / 429 / 400 / 5xx / timeout | What happened and what to do. Nothing is shown as compared |

The results always say where the measurements came from: read from the page
and confirmed by you (with your corrections, if any), or entered by you, and
*not verified by Fynd*.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Permissions, the key, the side panel |
| `background.js` | A toolbar click opens the panel and records which tab was clicked (`storage.session`) |
| `config.js` | `FYND_SITE` / `FYND_API`: Fynd's address |
| `collect.js` | Runs in the page on your click (`scripting.executeScript`). Returns the product and the tables |
| `extract.js` | The product, the columns, the methods (only as the chart states them), the values, the review, and the chart that is sent |
| `api.js` | The three requests (saved garments, the comparison, the AI-assisted reading), their timeouts, and the failures they name |
| `sidepanel.html` / `.js` / `.css` | The panel and its states |
| `retailers.js` | Recognises known shops' product addresses and where their chart is kept. These are hints only, and no measurements are stored |
| `vendor/` | Copies of the site's shared table reader and payload code (`scripts/sync-extension.js` keeps them identical) |
| `popup.*` | The earlier chart check that hands a chart to Find Fit on the site |

## Tests

| Suite | What it covers |
|---|---|
| `node scripts/test-extension.js` | Permissions, the one network route, the vendor copies, the engine's families |
| `node scripts/test-chart-ai.js` | The AI-assisted reading offline, with Gemini scripted: the fast path, the validator on right, wrong, injected and malformed answers, provider failures, caching, sign-in, the rate limit and the AI allowance |
| `node scripts/eval-chart-extraction.js [--live]` | Accuracy against hand-checked readings of 13 invented charts, scored separately for:<br>• the deterministic reading<br>• the live AI-assisted reading (only with `--live` and a key)<br>• a validator check with scripted answers, which is **not** a model measurement<br>Every reading is split into automatic and needs-confirmation |
| `node scripts/test-extension-extract.js` | Reading, corrections and provenance in Node. The batch request through the real handler: per-size results equal to comparing each size alone, the server's refusals, saved garments by session (401/404), the rate limit, the extension's CORS origin, and every `api.js` failure |
| `node scripts/test-fit-panel-browser.js` | The panel in headless Chromium against Fynd's real handlers on this machine: every state and failure above, on fixture pages (`scripts/fixtures/extension-panel/`, `scripts/fixtures/fit-panel/`) |
| `node scripts/test-fit-panel-real-chrome.js` | A visible Chrome on Xvfb, the extension as shipped, a real toolbar click, and Fynd's handlers answering under the production API name over TLS with a real session cookie |
| `node scripts/test-extension-browser.js` | The popup's chart hand-off to Find Fit |

## Check it on a real shop page

Every automated test uses invented pages. In your own Chrome, it takes about
five minutes:

1. Load the extension (above). Sign in to Fynd and save a garment on your fit
   profile.
2. Open a hoodie, sweatshirt or T-shirt product page that has a garment
   measurement chart, and click Fynd.
3. Check the product. If the shop keeps its chart in a size guide, open the
   guide on the page (its *product* or *garment* measurements tab), then press
   **Read the page again**.
4. Choose the garment-measurement chart, check every value and method, then
   choose your garment and **Compare every size**.
5. If anything fails, send back:
   - a screenshot of the panel;
   - anything under **Technical details**;
   - your Chrome version (`chrome://version`);
   - any red **Errors** shown on Fynd's card in `chrome://extensions`.

## Limitations

- **Garments:** hoodies, sweatshirts and T-shirts only. Those are the kinds
  Fynd's engine compares.
- **Readable charts:** only charts drawn as HTML tables, or with ARIA table
  roles, can be read. A chart in an image, a canvas or an iframe can't; enter
  it by hand.
- **Retailers:** none is supported as a whole. Pages shaped like the fixtures
  work; anything else is untested.
- **Sign-in:** happens on Fynd's site, in the same Chrome profile. The panel
  links there.
- **Size of a chart:** up to 30 sizes. Vercel parses the request before Fynd
  sees it. On a host that streams it to `api/_body.js`, a request over
  10,000 characters is cut off; a full 30-size chart with provenance is about
  12 kB.
- **AI-assisted reading, needs a key:** it needs `GEMINI_API_KEY` on the
  server. Without one, `/api/size-recommendation?parse=1` answers "unavailable" and the panel
  keeps Fynd's own reading.
- **AI-assisted reading, accuracy unknown:** its accuracy with a real model
  has not been measured. The environment it was built in had no Gemini key.
  Run `node scripts/eval-chart-extraction.js --live` with one; the 13
  invented charts there are a test set, not a benchmark.
- **The cache:** it is shared only when Fynd's store is (Upstash/KV).
  Without it, each server instance keeps its own.
