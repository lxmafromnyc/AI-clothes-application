# Fynd for Chrome — the Fit panel

A Manifest V3 Chrome extension for shopping on a computer. Click Fynd's
toolbar button on a clothing product page: Chrome's side panel opens beside
the page, Fynd reads the product's size chart, and compares it with a garment
you already own that fits you the way you like (your *reference*). It
recommends the closest size, says how sure it is and why, and shows every
measurement it compared.

It is a first version, loaded unpacked. It isn't on the Chrome Web Store.

**What has been verified, and what hasn't** (details under [Tests](#tests)):

- The whole workflow runs in a real, visible Chrome with the extension as
  shipped. That includes a real click on the toolbar button, on invented shop
  pages served from the test machine.
- **No real retailer's page has been checked.** The environment it was built
  in could not reach any retailer. `node scripts/test-fit-panel-real-chrome.js
  --live <url> …` runs the same check against real pages wherever they can be
  reached.
- No accuracy figure is claimed. See [How sure it is](#how-sure-it-is).

## Install it locally

1. Get this repository on your computer (clone it, or download it as a ZIP and unzip it).
2. In Chrome (116 or later), go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension/` folder inside the repository.
5. Pin **Fynd** from the puzzle-piece menu, so its button stays on the toolbar.

After changing any file in `extension/`, click the reload icon on Fynd's card
in `chrome://extensions`.

## Using it

1. **Open a clothing product page** on a shop's site.
2. **Click Fynd's toolbar button.** The side panel opens beside the page. The
   click is what lets Fynd read that page (Chrome's `activeTab`).
3. **The first time, add a reference.** The panel asks *"Which clothes already
   fit you the way you like?"*:
   - the brand, the kind of garment, and the size on its label;
   - its cut, if you know it;
   - whether it feels tight, just right or loose;
   - whether its length feels short, just right or long.

   No tape measure and no product link are needed. Fynd saves the reference at
   once with the measurements it can find for it (see below) and shows what
   they rest on. If you recognise your exact product in the list, pick it.
4. **The panel shows the product and its chart.** If the shop keeps its chart
   in a size guide, open the guide on the page and press **Read this page**.
5. **Read the recommendation:**
   - the size, and the confidence (high, medium or low) with every reason it
     isn't higher;
   - the measurement-by-measurement explanation, and the table of all sizes;
   - which measurements weren't compared, and why.
6. **Keep shopping.** On the same site, Chrome keeps Fynd's access as you move
   from page to page, and the panel follows you. On another site, click Fynd
   again. You can let Fynd follow you on one site without clicking
   (**Read *site* pages as I shop**); Chrome asks you to confirm, for that site
   only.
7. **After buying, say how it fit:** too tight, about right, too loose, too
   short or too long. Fynd keeps the size's measurements with your answer and
   narrows your preferred range from then on.

You can also:

- **Correct a measurement** in the chart. Fynd then treats it as yours, and
  confidence can't be high.
- **This fits me — use as a reference:** make the product in view a reference
  from its own chart.
- **Open in Find Fit:** take the chart to Fynd's site.

## Where your reference's measurements come from

Fynd never turns a size label into numbers by itself: a Medium isn't one size.
It uses measurements that brands publish on their own pages, read into Fynd's
records (`api/_sizing/records/`). Each record keeps:

- the product's identity and address;
- where every value came from, and when;
- how each measurement is taken (flat or around; from the centre back or the
  shoulder seam);
- whether Fynd has checked it against the source.

`scripts/build-fit-references.js` turns those records into
`assets/fit-reference-data.js`, and the extension carries a copy. The lookup
runs in your browser and sends nothing. For brand, kind and size, the panel
uses the first of these that exists, and says which:

| What Fynd has | What your reference gets | Shown as |
|---|---|---|
| Your exact product (you picked it, or gave its link) | Its own published garment measurements in your size | Its own published measurements |
| Other products of that brand and kind, in your size | Their median, and their spread as a range, never narrower than ±¾ in on the chest | Estimated from the same brand's products |
| Only the brand's body-size chart | Chest only: the body range plus the room this kind of garment has over the body in brands that publish both | Estimated from the brand's size chart — chest only |
| Nothing from this brand | The range across other brands' products of this kind with this size label | Rough estimate from other brands |
| Nothing for this kind of garment | No measurements; you can add them or use a product page | No measurements yet |

An estimate is a range, and the comparison widens your preferred range by it.
Estimated numbers are always said with "about", and confidence is low.

**What the data holds today:**

- **9 products with garment measurements:**
  - UNIQLO: SUPIMA Cotton T-Shirt, Sweatshirt, Sweat Pullover Hoodie and Sweat
    Oversized Pullover Hoodie.
  - Zara: Basic Medium Weight T-Shirt and four hoodies.
- **5 body charts:** UNIQLO, Nike (two), H&M and Carhartt.
- **2 products checked by Fynd:** the UNIQLO Sweatshirt and Sweat Pullover
  Hoodie. The rest are as published, not yet checked, and say so.
- **Nothing for Levi's or any trousers, jeans or shorts.** A jeans reference
  starts with no measurements.

Adding a brand means adding records (with their sources) and rerunning
`node scripts/build-fit-references.js` and `node scripts/sync-extension.js`.

## How sure it is

- **Weights, tolerances and shifts are starting hypotheses.**
  - They are not fitted to outcomes.
  - "Feels tight" moves your preferred chest somewhere between ¼ in and 1½ in
    wider, not by one fixed amount.
  - They are all in `HEURISTICS` in `assets/fit-anchor.js`.
- **Confidence comes from the data, never from the score.** It drops for:
  - estimated or unchecked measurements;
  - one-answer preferences;
  - inferred units;
  - near ties;
  - lengths measured differently;
  - comparing different kinds of garment.
- **No accuracy has been measured.** That needs real outcomes, collected with
  consent, and a documented evaluation.

## Retailer modules

Any site can be read after a click on Fynd. `extension/retailers.js` adds
what Fynd knows about particular retailers: how to recognise a product page,
the product's code, and where its garment chart usually is. A product Fynd
holds measurements for is then compared from those, even if the page's own
chart isn't open.

| Module | Recognises | Checked against live pages |
|---|---|---|
| UNIQLO US | `/us/en/products/E######-###` | No |
| Zara US | `/us/en/…-p########.html` | No |
| H&M US | `/en_us/productpage.##########.html` | No |
| Nike US | `/t/…/XXXXXX-###` | No |

A module grants no access and says nothing about whether the live site can be
read. To add one, add an entry to `retailers.js` and a test in
`scripts/test-extension.js`.

## What it reads, stores and sends

- **Permissions:**
  - **`activeTab` and `scripting`:** it reads a page only after you click
    Fynd on it, and Chrome keeps that access only while you stay on that site
    in that tab.
  - **`sidePanel`:** the panel.
  - **`storage`:** your references, on this computer only.
  - **No site at install:** no `<all_urls>`, no `tabs`, no `history`, no
    content scripts.
  - **One site at a time, if you ask:** `optional_host_permissions` lists
    `https://*/*` so the panel can offer **Read *site* pages as I shop**. It
    then asks Chrome for that one site's origin, Chrome asks you, and you can
    remove it in Chrome's extension settings. Nothing is granted unless you
    confirm.
- **What it reads, only from a page you clicked Fynd on (or a site you allowed):**
  - the address, canonical address and title;
  - the product's name, brand, code and sizes from its structured data;
  - a "Fit" it states;
  - up to 12 tables, as text;
  - the words of up to 3 size-guide links or buttons.

  It never reads form fields or anything you type. It clicks nothing, opens
  nothing on the page, and runs nothing it finds.
- **What it stores:** in `chrome.storage.local`, your references, their
  measurements and sources, your outcomes, and inches or centimetres. Nothing
  is synced. The tab you last clicked Fynd on is kept in
  `chrome.storage.session` (memory only) so the panel can read it as it opens.
- **What it sends:** nothing. The panel makes no network request, and the
  tests check that. **Open in Find Fit** opens Fynd's site with the chart after
  `#` in the address, which browsers never send to a server.
- **When something goes wrong,** the panel says what happened and what to do:
  - "Click Fynd to read this page";
  - "Chrome doesn't let extensions read this page";
  - "This page didn't load";
  - "No size chart found… open it, then press Read this page".

  Chrome's own error is kept under **Technical details** and in the panel's
  console (right-click the panel → Inspect).

## How it works

| File | What it does |
|---|---|
| `manifest.json` | Manifest V3; the permissions above |
| `background.js` | The toolbar button: opens the panel in the click itself, and tells it which tab to read |
| `sidepanel.html`, `sidepanel.css`, `sidepanel.js` | The Fit panel |
| `retailers.js` | Retailer modules |
| `collect.js` | `fyndCollect`, run once in the page when it is read; returns plain text only |
| `vendor/fit-anchor.js` | References, estimates, the comparison, confidence and explanations (`assets/fit-anchor.js`) |
| `vendor/fit-reference-data.js` | Measurements from Fynd's records, with their sources (`assets/fit-reference-data.js`, generated) |
| `vendor/sizing-tables.js`, `vendor/fynd-payload.js`, `vendor/size-chart.js` | How a size table is recognised and labelled, ranked, and drawn — the same code Fynd's site uses |
| `config.js` | Where **Open in Find Fit** goes |
| `popup.html`, `popup.css`, `popup.js` | The earlier chart check. It is no longer on the toolbar, which now opens the panel. It is kept because `test-extension-browser` covers the page reader and the Find Fit handover through it. |

Chrome loads an unpacked extension from its own folder only, so `vendor/`
holds copies of shared files in `assets/`. After changing any of them, run
`node scripts/sync-extension.js`; `test-extension` fails while a copy differs.

## Tests

| Suite | What it covers | Where it runs |
|---|---|---|
| `node scripts/test-fit-anchor.js` | The comparison: units, methods, broken and body charts, categories, preferences, outcomes, confidence; every reference tier against the real data; the data being up to date | Node |
| `node scripts/test-extension.js` | The exact permissions; the panel makes no request and asks for one site at a time; retailer modules; shared copies | Node |
| `node scripts/test-fit-panel-browser.js` | The panel's many states, quickly: every reference tier, the UNIQLO address, shop charts, body and unlabelled charts, corrections, units, outcomes, no request | Headless Chromium, on fixtures, with a test copy that may read this machine's pages and a `?tab=` hook |
| `node scripts/test-extension-browser.js` | The page reader and the Find Fit handover, through the earlier popup page | Headless Chromium, on fixtures |
| `node scripts/test-fit-panel-real-chrome.js` | **The workflow end to end** (below) | **Headed Chromium on Xvfb, the extension as shipped, real X11 clicks on its toolbar button**, on invented shop pages |

**The real-Chrome suite** runs Chromium visibly on a virtual display, loads
`extension/` unchanged, and clicks Fynd's toolbar button with a genuine mouse
click (XTEST), found on a screenshot. That click is what Chrome turns into
`activeTab` access and what opens the side panel. The suite then:

1. creates a reference from brand, kind, size and fit only;
2. reads a shop page whose size guide is built only when opened, opens it, and
   reads it;
3. checks the recommendation, its confidence, reasons and table;
4. moves to another page on the same site (followed), then to another site
   (asked to click);
5. checks a body-only chart, a page without a chart, UNIQLO US's product
   address (resolved to the test server), a Chrome page and a page that didn't
   load;
6. records an outcome;
7. reloads the panel;
8. checks that the panel made no network request and logged no console error.

Screenshots of every step go to `FYND_SHOTS`.

It needs Xvfb, ImageMagick's `import`, and python3 with python-xlib and Pillow
(`node scripts/ci-tests.js real-chrome`; CI installs them). With
`--live URL …` it runs the same click-and-read against real pages and reports
what the panel read and recommended. That is the live-compatibility check, and
it needs network access to the retailer.

**The pages in these suites are invented** (`scripts/fixtures/`). Passing them
shows the extension's own workflow in Chrome; it is not evidence that any
retailer's live pages work.
