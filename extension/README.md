# Fynd for Chrome — size check and Fit panel

A Manifest V3 Chrome extension with two parts:

- **The popup** (unchanged). On a clothing product page, click the Fynd button,
  then **Check sizing with Fynd**. Fynd reads the page already open in your
  browser, finds its size chart, and shows it with its source, units and what
  it measures. **Open in Fynd** takes the chart to Find Fit.
- **The Fit panel** (new). **Find my size — open the Fit panel** opens Chrome's
  side panel beside the shop. It asks once which garment you already own fits
  the way you like (your *Fit Anchor*), reads the product you're looking at, and
  compares the product's garment measurements with your reference, size by size.
  See [The Fit panel](#the-fit-panel).

This is the first version, loaded unpacked. It isn't on the Chrome Web Store.

## Install it locally

1. Get this repository on your computer (clone it, or download it as a ZIP and unzip it).
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension/` folder inside the repository.
5. Optional: pin **Fynd** from the puzzle-piece menu so its button stays on the toolbar.

The Fit panel needs Chrome 116 or later (`chrome.sidePanel.open`).

After changing any file in `extension/`, click the reload icon on Fynd's card
in `chrome://extensions`.

**Open in Fynd** goes to `https://ai-clothes-application.vercel.app` by default.
To use a Vercel preview instead, change `FYND_SITE` in `extension/config.js`
and reload the extension.

## Using it

1. Open a clothing product page on any retailer's site.
2. Some retailers only show their chart inside a **Size guide** pop-up. If so,
   open it on the page first.
3. Click the Fynd button, then **Check sizing with Fynd**.

What you'll see:

- **One clear size chart:** the chart, with its sizes, columns and values exactly
  as the page shows them. Under it:
  - what it measures (body measurements, finished-garment measurements, or not
    stated);
  - its unit, or that the page doesn't give one;
  - one line saying where it came from.
- **Several tables that could each be the chart:** you choose which one, each
  saying whether it measures the body or the garment. One exception: in a size
  guide with a body tab and a product tab (both open in its dialog, or tab
  panels side by side), the product's own garment table is shown first,
  even if the guide opened on the body tab. The body tab stays one click away
  under **Choose another table on this page**.
- **Sizes only, no measurements:** the sizes, and a note that no measurements
  were found.
- **No chart:** why, and what to try next, such as opening the retailer's size
  guide and checking again. **Check Fynd's catalog** opens Find Fit with the
  product's address, to look for a chart Fynd has already checked.
- **A page Fynd can't read** (such as `chrome://` pages or the Web Store): it
  says so.

A chart read by the extension is always labelled **read from your browser, not
checked by Fynd**. It is never marked verified, and Find Fit never compares it
with your fit profile. Body-size charts are never compared with a garment at
all. Only charts Fynd has checked (from its catalog, via **Check Fynd's
catalog**) can be compared with your saved reference garment in Find Fit.
The Fit panel is separate: it compares a garment chart read from the page with
the Fit Anchor saved in your browser, and says the chart was read from the page.

## The Fit panel

### Your Fit Anchor

The first question is **"Which clothes already fit you the way you like?"**:

- brand, kind of garment (T-shirt, shirt, sweatshirt or hoodie, sweater,
  jacket or coat, jeans, trousers, shorts) and the size on its label;
- how it fits: feels tight, just right or feels loose;
- its length: feels short, just right or feels long;
- optionally its product link or name.

No tape measure is needed. Fynd then looks for that garment's
**finished-garment measurements**, in this order:

1. **The exact garment.** A product link Fynd has a record for: its garment
   chart, in the size on your label. Stored as `fynd-record`, `verified` as
   the record is.
2. **A similar product.** The same brand, kind and size in Fynd's records
   (for example another UNIQLO sweatshirt in M). You pick one or skip it; it
   is stored as `similar-product` and every number from it is called an
   estimate ("about 23½ in").
3. **Your own numbers**, if you'd rather measure (`shopper`).
4. **Nothing.** The anchor keeps the brand, kind and size only. Fynd never
   invents dimensions from a brand and a size label: until you open that
   garment's product page and press **This fits me — use as a reference**,
   or enter its measurements, the panel can only show a same-brand label
   match, at low confidence.

Every measurement keeps its value (in inches), how it's measured (centre back
or shoulder seam, for example), its source, and whether it was verified. You
can add more anchors (one per kind of garment works best); the panel uses the
one of the same kind as the product, then one of the same family (tops,
outerwear, bottoms), and never compares tops with trousers.

### On a product page

1. **Reading the product.** On a supported retailer (below) the panel reads
   the product when you open it. Elsewhere, press Fynd's toolbar button first:
   that press is what lets the panel read the tab.
2. **The chart.** It shows the garment chart it found, where it came from
   (Fynd's record, or this page), its unit, and what it measures. If the page
   has several tables you choose; if the retailer's chart is in a size guide,
   open it and press **Read this page**.
3. **What's missing.** A body-size chart is never compared with a garment; the
   panel says so and offers only the label match. A chart that doesn't say
   what it measures needs you to confirm it measures the garment, and the
   result is low confidence. No chart: the panel says so.
4. **Corrections.** **Correct a measurement** lets you fix any value; a
   corrected chart is treated as yours (`shopper`) and caps confidence.
5. **The recommendation.** The closest size, a confidence (high, medium or
   low) with every reason it isn't higher, a plain explanation ("This L
   measures 25 in — about what you like"), the next closest size, and the
   whole comparison table. Measurements not compared are listed with why.
6. **Feedback.** After buying: too tight, about right, too loose, too short or
   too long. The outcome is stored on the anchor with the size's measurements,
   and narrows your preferred range on that dimension from then on.

### Supported retailers

| Retailer | What works | Tested against |
|---|---|---|
| UNIQLO US (`www.uniqlo.com/us/en/products/E######-###`) | Recognised from the address. The product's canonical address is looked up in Fynd's records; for a product Fynd has checked (the Sweat Pullover Hoodie E475378 and Sweatshirt E475377) its verified garment chart is used. With the optional permission granted, the panel also reads the page's own tables when you open its size guide. | A fixture page shaped like UNIQLO's address, **not** the live site |
| Any other site | The same reading as the popup, after a press of Fynd's toolbar button | Fixture pages |

**Live retailer pages are not verified.** The tests run on invented fixture
pages; nothing here has been run against uniqlo.com itself. Fynd doesn't read
UNIQLO pages from its server and doesn't scrape its catalog.

**Adding a retailer:** add an entry to `extension/retailers.js` (hosts, a
`product(url)` that recognises a product address, and its origin), add the
origin to `optional_host_permissions` in `manifest.json`
(`test-extension` checks the two agree), and add a fixture and a test.

### What the panel reads, stores and sends

- **Reads:** the same page reading as the popup (`collect.js`), only on the
  tab you pressed Fynd's button on, or on a supported retailer's page after
  you've granted that retailer. It never reads other tabs, your history or
  form fields.
- **Stores:** your anchors, their measurements, outcomes, and the inch/cm
  choice, in `chrome.storage.local` — on this computer only, in this browser
  profile. They aren't synced and aren't sent anywhere. **Remove** deletes an
  anchor.
- **Sends** to Fynd's site (`FYND_SITE`), without cookies:
  - on a supported retailer, the product's canonical address
    (`?chart=https://www.uniqlo.com/us/en/products/E475377-000/00`), to look
    up Fynd's record;
  - when you save an anchor, its link, if you gave one (`?chart=`), or its
    brand, kind and size label (`?reference=1&rbrand=&rcategory=&rsize=`), to
    find its measurements.

  Nothing else: not the page's tables, not your fit, not your outcomes, not
  other addresses. On other sites nothing is sent at all.
- The privacy note at the bottom of the panel says the same.

## What it can and can't do

- **Permissions:**
  - `activeTab` and `scripting`: it can read a page only after you click its
    button, and only the tab you clicked it on.
  - `sidePanel`: the Fit panel.
  - `storage`: your Fit Anchors, in this browser only.
  - Host access to Fynd's own site, so the panel can ask Fynd's records
    (above). No retailer's site is allowed in advance.
  - Optional, asked for in the panel only if you choose: UNIQLO US
    (`https://www.uniqlo.com/*`), so the panel can read its product pages
    without a toolbar press.
  - No `tabs`, `history` or all-sites access, no content scripts, and no
    background page. It never watches your browsing.
- **What it reads, only when you press the button:**
  - the page's title and address;
  - the product's name, brand, code and sizes from the page's structured data;
  - a "Fit" the page states;
  - up to 12 tables, as text;
  - up to 3 size-guide links.
- **What it never reads:** form fields or anything you typed. It skips any table
  that contains a form control.
- **It doesn't interact with the page:** it clicks nothing and opens nothing.
  JSON-LD is parsed as data, and nothing from the page is ever run.
- **The popup makes no network requests of its own:**
  - What it reads stays in the popup.
  - **Open in Fynd** puts the chart in the Find Fit address after `#`, which
    browsers never send to a server. Find Fit checks it, shows it, and removes
    it from the address.
  - Nothing private, and no fit-profile data, ever goes in that address.
- **It doesn't get around retailers' protections.** If a retailer's page
  doesn't show a chart, the extension doesn't either.
- **No AI and no paid services:** extraction is fixed rules over the page's
  tables.

## How it works

| File | What it does |
|---|---|
| `manifest.json` | Manifest V3; permissions `activeTab`, `scripting`, `sidePanel`, `storage`; Fynd's site; UNIQLO US optional |
| `popup.html`, `popup.css`, `popup.js` | The popup, with the button that opens the Fit panel |
| `sidepanel.html`, `sidepanel.css`, `sidepanel.js` | The Fit panel |
| `retailers.js` | Supported retailers: how each product address is recognised |
| `vendor/fit-anchor.js` | The Fit Anchor model and the comparison (`assets/fit-anchor.js`) |
| `collect.js` | `fyndCollect`, run once in the page when you press the button; returns plain text only |
| `vendor/sizing-tables.js` | How a size table is recognised and labelled — the same code Fynd's server uses (`assets/sizing-tables.js`) |
| `vendor/fynd-payload.js` | Ranks the candidate tables; builds, validates and encodes the chart handed to Find Fit (`assets/fynd-payload.js`) |
| `vendor/size-chart.js` | Draws the chart the way Find Fit does (`assets/size-chart.js`) |
| `config.js` | Fynd's site: where **Open in Fynd** goes and what the panel asks |

Chrome loads an unpacked extension from its own folder only, so `vendor/`
holds copies of the shared files in `assets/`. After changing any of those,
run `node scripts/sync-extension.js`. `test-extension` fails while a copy
differs from its original.

## Tests

- `node scripts/test-extension.js` checks, without a browser:
  - the manifest's permissions;
  - that the shared copies match the originals;
  - table ranking;
  - payload validation, including malformed and hostile payloads;
  - that charts from the browser are never verified or comparable;
  - that the panel makes one kind of request, to Fynd's site without
    cookies, stores only locally, and asks only for the retailers it supports.
- `node scripts/test-fit-anchor.js` tests the comparison itself: units,
  circumference and flat widths, inferred units and methods, missing and
  inconsistent charts, body charts, categories, fit and length preferences,
  confidence, and outcomes.
- `node scripts/test-fit-panel-browser.js` loads the extension with the panel
  in Chromium against Fynd's real request handler and fixture pages in
  `scripts/fixtures/fit-panel/` (onboarding, a UNIQLO-shaped page, a generic
  shop, a body chart, an unlabelled chart, no chart, corrections, outcomes,
  and exactly which queries reach Fynd).
- `node scripts/test-extension-browser.js` loads the unpacked extension in
  Playwright's Chromium. It runs it against invented fixture pages in
  `scripts/fixtures/extension/` (each labelled as a fixture; none is a real
  retailer's page) and opens the results in the real Find Fit page.
- **How the browser test gets around the toolbar click:** a test can't press
  the toolbar button that grants `activeTab`. So the suite loads a test copy
  whose manifest also allows `http://127.0.0.1/*`, and aims the popup at the
  fixture tab with `popup.html?tab=<id>`. A second launch loads the extension
  exactly as shipped, and shows that without a press it can read no page.
  `?tab=` reaches nothing the extension isn't already allowed to read.
