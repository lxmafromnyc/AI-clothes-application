# Fynd for Chrome — check this product's sizing

A Manifest V3 Chrome extension. On a clothing product page, click the Fynd
button, then **Check sizing with Fynd**. Fynd reads the page already open in
your browser, finds its size chart, and shows it with its source, units and
what it measures. **Open in Fynd** takes the chart to Find Fit.

This is the first version, loaded unpacked. It isn't on the Chrome Web Store.

## Install it locally

1. Get this repository on your computer (clone it, or download it as a ZIP and unzip it).
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension/` folder inside the repository.
5. Optional: pin **Fynd** from the puzzle-piece menu so its button stays on the toolbar.

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
catalog**) can be compared with your saved reference garment.

## What it can and can't do

- **Permissions: only `activeTab` and `scripting`.**
  - It can read a page only after you click its button, and only the tab you
    clicked it on.
  - It has no access to any site in advance, no content scripts, and no
    background page.
  - It never watches your browsing.
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
- **No network requests of its own:**
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
| `manifest.json` | Manifest V3; permissions `activeTab`, `scripting` |
| `popup.html`, `popup.css`, `popup.js` | The popup |
| `collect.js` | `fyndCollect`, run once in the page when you press the button; returns plain text only |
| `vendor/sizing-tables.js` | How a size table is recognised and labelled — the same code Fynd's server uses (`assets/sizing-tables.js`) |
| `vendor/fynd-payload.js` | Ranks the candidate tables; builds, validates and encodes the chart handed to Find Fit (`assets/fynd-payload.js`) |
| `vendor/size-chart.js` | Draws the chart the way Find Fit does (`assets/size-chart.js`) |
| `config.js` | Where **Open in Fynd** goes |

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
  - that charts from the browser are never verified or comparable.
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
