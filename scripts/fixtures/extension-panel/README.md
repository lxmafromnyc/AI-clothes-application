# Extension fixtures

Invented pages for the Fynd extension's tests: `scripts/test-extension-extract.js`
(in Node, through a DOM) and `scripts/test-fit-panel-browser.js` (the Fit panel
in Chromium). Every page carries a FIXTURE banner. None is a copy of a real
retailer's page, and none of their measurements is a real product's.

- `variants-hoodie.html`: structured product data (a ProductGroup with size
  variants, colour and availability), a size picker, and a garment chart in
  centimetres whose headings say how each measurement is taken.
- `html-only-tee.html`: no structured data. The name, brand and sizes come
  from what the page shows. Its chart has an ambiguous value (`21-22`) and a
  blank.
- `not-a-product.html`: an article, with no product on it.

The panel suite also uses `scripts/fixtures/fit-panel/` (a garment chart, a
body chart, an unlabelled chart and a page with no chart).

Passing these tests shows the extension works on pages shaped like these. It
doesn't show that any live retailer's page works.
