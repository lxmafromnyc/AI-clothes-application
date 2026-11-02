# Find Fit redesign: before and after

Screenshots from a local server running Fynd's real API handlers
(`/api/auth`, `/api/fit-profile`, `/api/size-recommendation`) in Chromium. The
products are Fynd's own sizing records (Zara, UNIQLO); the shoppers and their
garments are invented.

| | |
|---|---|
| `1-before-desktop.png`, `2-before-phone.png` | **Before.** 26 controls on screen at once: a type and a unit up front; the garment's type, size, brand, product, "sold as", fit and four measurements; and the item's brand, name, one size, four values and four method dropdowns, all typed by hand. |
| `3-after-desktop-start.png`, `4-after-phone-start.png` | **After, first sight.** Two questions and 5 controls: the garment's search (name or link), type, size and brand, and the item's link. Measurements, details and hand entry are folded until wanted. |
| `5-after-returning-link-found.png` | **A returning shopper** pastes a Zara link. Their saved hoodie is chosen for a hoodie, and their T-shirt is marked a different kind. Fynd found every size and the measurements; the one thing asked is to check them. |
| `6-after-returning-result.png`, `7-after-phone-result.png` | **One tick later:** every size compared in one request, the recommended size first, then why, each measurement, the caveats and sources, and every size folded beneath. |

**Manual effort to one successful comparison** (counted by `assets/fit-metrics.js`, asserted in `scripts/test-e2e.js`):

| Who | Before (minimum) | After |
|---|---|---|
| Returning shopper (saved garment), item with a garment chart | 9: the size being considered, four values and four method dropdowns (plus type and unit when not the defaults) | **2**: the link and the tick |
| Item Fynd holds *checked* measurements for | the same 9 | **1**: the link, with no check needed. No such record is in production yet: all of Fynd's garment records still await checking |
| Guest, garment measured at home | 15: the garment's size, brand and four measurements, then the item's 9 | 6: the link, four measurements and the tick (the brand and size are no longer required when measurements are given) |

What still needs the shopper, and why, is in the PR description.
