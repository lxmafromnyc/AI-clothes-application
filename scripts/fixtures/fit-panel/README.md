# Fit panel fixtures

Invented pages for the Fit panel's browser tests. Every page carries a FIXTURE
banner. None is a copy of a real retailer's page, and none of their
measurements is a real product's.

- **The top-level pages** (`garment-tee.html`, `body-chart.html`,
  `unlabelled.html`, `no-chart.html`) are used by
  `scripts/test-fit-panel-browser.js`, which runs headless, together with
  `scripts/fixtures/extension-panel/`.
- **`shop/`** is used by `scripts/test-fit-panel-real-chrome.js`, in a visible
  Chrome clicked through its toolbar button. These are shaped like shop pages:
  structured product data with size variants, size buttons, and a size guide
  that is built only when opened (a `<dialog>` with Body and Product tabs).

Passing these tests shows the panel works on pages shaped like these. It
doesn't show that any live retailer page works: that is
`node scripts/test-fit-panel-real-chrome.js --live <url> …`, run where
retailers can be reached.
