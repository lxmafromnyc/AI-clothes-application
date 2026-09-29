# Fynd UI validation — polish pass

Validated commit: `da62936` (this file is added in the commit after it).
Previous commit, the "before" state: `6e7417b`.
Date: 2026-09-29. Browser: Chromium (Playwright), real rendering with the site's Inter font loaded.

## 1. Test results

No test files were modified.

| Suite | Result |
|---|---|
| UI (`scripts/test-ui.js`) | **55/55 passed** |
| E2E (`scripts/test-e2e.js`) | **23/23 passed** |
| `test-search` | 37 passed, 0 failed |
| `test-pipeline` | 155 passed, 0 failed |
| `test-auth` | 84 passed, 0 failed |
| `test-cache` | 53 passed, 0 failed |
| `test-stripe` | 82 passed, 0 failed |
| `test-deadline` | 18 passed, 0 failed |
| `test-gemini` | 102 passed, 0 failed |
| `test-catalog-images` | 235 passed, 0 failed |
| `test-catalog-prices` | 114 passed, **1 failed**, 29 skipped |

Backend regression total: **766 passed, 0 failed** across the eight suites above.

The known `test-catalog-prices` failure is **still present, and unchanged**: "every row the catalogue ships today accounts for its price". The row `sample-northfold-boxy-cotton-tee` carries a price with no `priceEvidence` record. This is catalogue data. It predates the UI work, and nothing in this pass touches it.

## 2. Responsive validation

Every width was checked on all six pages (54 page/width combinations). An automated in-browser audit ran at each width, alongside visual inspection of screenshots.

The audit checks:
- **Horizontal scrolling:** the document is no wider than the viewport.
- **Clipped text:** no text runs past the viewport or is cut off inside its box. The deliberate two-line product-name clamp and single-line brand ellipsis are exempt. The search field's text must fit the field.
- **Overlap:** no overlap between logo, headline, supporting text, search box and examples, or between any two nav links.
- **Navigation:** at 768px and above, a single row of five links and no menu button. Below 768px, a 44×44px menu button and no links until the menu opens.
- **Search box:** its width is within its breakpoint's maximum (760, 720, 680px, or 100% below 768px). The Search button is at least 44px and on screen, and is full width below 768px. Icon buttons are at least 44×44px, and all other controls at least 36px tall.
- **Product cards:** equal image widths, the expected column count (4, 4, 3, 3, 2, 2, 2, 2, 2), no card under 150px wide, and every image at exactly 4:5 with `object-fit: cover`.

| Width | Home | Results | Discover | Pricing | About | Account |
|---|---|---|---|---|---|---|
| 1440 | PASS | PASS | PASS | PASS | PASS | PASS |
| 1280 | PASS | PASS | PASS | PASS | PASS | PASS |
| 1024 | PASS | PASS | PASS | PASS | PASS | PASS |
| 820 | PASS | PASS | PASS | PASS | PASS | PASS |
| 768 | PASS | PASS | PASS | PASS | PASS | PASS |
| 767 | PASS (after fix) | PASS (after fix) | PASS | PASS | PASS | PASS |
| 480 | PASS | PASS | PASS | PASS | PASS | PASS |
| 390 | PASS | PASS | PASS | PASS | PASS | PASS |
| 375 | PASS | PASS | PASS | PASS | PASS | PASS |

**Failure found and fixed:** at 767px the search box was held at the tablet maximum of 680px instead of filling the mobile content width. The Search button beneath it then looked out of proportion with the box. Below 768px the box is now 100% of the content width.

## 3. Page validation

All six main pages were inspected at desktop (1440), tablet (820) and phone (390). They share:
- the same header,
- the same opening (a bold title and one muted sentence),
- the same controls (black primary button, outlined pills),
- the same bordered cards,
- the same light footer.

The six pages:
- **Home:** logo and navigation, headline, one sentence, search box, three examples (two below 480px). Nothing else is on the first screen.
- **Search/results:** count, the query in smaller text, then the product grid.
- **Discover:** title, style chips and count, then the product grid.
- **Pricing:** title, the "your plan" banner, three plan cards (stacked below 1024px), then questions.
- **About:** title, three paragraphs, a small grid of what Fynd understands, then questions.
- **Account:** title, a centred sign-in card, then how accounts work.

Polish is consistent across all six.

## 4. Interaction validation

All checks ran at 1440px except the mobile menu, which ran at 390px.

| Check | Result |
|---|---|
| Search input focus state (border turns blue, focus ring added) | PASS |
| Search button hover (background changes) | PASS |
| Search button active (pressed state) | PASS (after fix; previously FAIL) |
| Navigation hover (link colour changes) | PASS |
| Mobile menu open/close | PASS: opens; all 5 links tappable; closes by button, by outside tap, and by Escape (after fix; Escape previously FAIL) |
| Product card hover (image scales, name underlines) | PASS |
| Links remain clickable (hit-test at each visible control's centre) | PASS (10 controls on the first screen) |
| Product links | PASS: open the retailer URL in a new tab with `rel="noopener noreferrer"` |
| Keyboard focus visible (14 consecutive Tab stops) | PASS: every stop shows an outline or the search-box focus ring |

In the first automated run the "search input focus" check read the style mid-way through the 0.15s transition, which was a flaw in the validator. Re-measured after the transition, it passes; the CSS was not changed for it.

## 5. Before and after

This is a polish pass. **The layout and composition were not redesigned:** every page keeps the same sections, order, grid and hierarchy as `6e7417b`. The whole diff is 2 source files, +20/−9 lines.

| Change | Why it improves the UI |
|---|---|
| Search box fills the content width below 768px | At 767px the box stopped 40px short on each side while the button inside it was full width. It now lines up with the page edges and the button, like every other phone width. |
| Buttons scale to 0.98 while pressed (0.1s) | Before, a click or tap gave no feedback until the page responded. Now there's a small, immediate response with no decorative motion. |
| Escape closes the mobile menu and returns focus to the menu button | Keyboard users could open the menu but not dismiss it without tabbing through every link. Focus now goes back where it started. |
| The menu button's accessible name switches between "Open menu" and "Close menu" | Screen readers now announce what the button will do. |

Unchanged:
- colours and type,
- the homepage composition,
- the results layout,
- the card contents (image, brand, name, price, retailer),
- navigation structure,
- every inner page.

## 6. Screenshot evidence

Real Chromium renders, saved in this folder:
- `homepage-1440.png`
- `homepage-390.png`
- `results-1440.png`
- `results-390.png`

Product photography note: this sandbox's network policy blocks every retailer image host, so the product-search responses are stubbed. The products shown have realistic names, prices, brands and retailer domains, but the product images are drawn stand-ins served locally. Everything else is the real page. On the live site the retailers' photos load in the same 4:5 tiles.

## 7. Final integrity check

`git diff 6e7417b da62936` changes only:
- `assets/styles.css`: the mobile search width and the button pressed state.
- `assets/app.js`: the mobile-menu toggle only (Escape, focus return, the button's label).
- the four screenshots above.

Confirmed unchanged:
- **Backend and search logic:** everything under `api/` is untouched, as are `assets/search.js`, `assets/products.js` and `assets/catalog.js`.
- **Gemini/OpenAI interpreter behaviour:** `api/interpret.js`, `api/_interpreters/` and `assets/interpret.js` are untouched.
- **OpenWeb Ninja:** `api/_providers/` is untouched.
- **Product verification:** the gate in `api/_providers/product-source.js` is untouched.
- **Stripe:** `api/_stripe.js`, `api/checkout.js`, `api/portal.js`, `api/stripe-webhook.js` and `assets/billing-ui.js` are untouched.
- **Authentication:** `api/auth.js`, `api/_auth.js` and `assets/account*.js` are untouched.
- **Routing:** the same six pages and the same links.
- **Existing functionality:** preserved, as confirmed by UI 55/55, E2E 23/23 and backend 766/766.

## 8. Summary

- Validated commit: `da62936`
- Source files changed in this pass: 2 (`assets/styles.css`, `assets/app.js`)
- UI tests: 55/55
- E2E tests: 23/23
- Backend tests: 766 passed, 0 failed (plus the known `test-catalog-prices` data failure, unchanged)
- Responsive check: PASS (54/54 page/width combinations after the 767px fix)
- Functional integrity: PASS
