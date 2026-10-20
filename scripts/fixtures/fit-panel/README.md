# Fit panel fixtures

Invented pages for `scripts/test-fit-panel-browser.js`. Every page carries a
FIXTURE banner. None is a copy of a real retailer's page, and none of their
measurements is a real product's. The `uniqlo-product.html` page is served at
a UNIQLO-shaped address (`/us/en/products/E475377-000/00`) only so the panel's
UNIQLO US adapter recognises it. Its own size table is invented. The
measurements the panel compares come from Fynd's own sizing record for that
code (`api/_sizing/records`), answered by the real handler.

Passing these tests shows the panel works on pages shaped like these. It
doesn't show that any live retailer page works.
