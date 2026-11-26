# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Fynd: an AI clothing finder with a fit-first flow. Plain HTML/CSS/JS pages at the repo root (no build step, no framework, no bundler) plus Vercel serverless functions in `api/`. `README.md` (~3500 lines) is the authoritative design record — each feature section explains *why* it works the way it does and lists what is "Not built yet". Read the relevant section before changing a feature, and update it when behaviour changes.

## Commands

```sh
npm ci && npx playwright install chromium   # once; ffmpeg must be on PATH for test-demo-film
npm test                                    # every required suite (node + browser groups)
node scripts/ci-tests.js node               # only the Node suites
node scripts/ci-tests.js browser            # only the Playwright suites
node scripts/test-sizing.js                 # run a single suite directly
python3 -m http.server 8000                 # serve the static site
npx vercel dev                              # site + api/ functions (needed for accounts, saving the fit guide, billing)
```

There is no linter or formatter configured.

### Verify every code change before finishing

After any change to code (`api/`, `assets/`, `scripts/`, or the HTML pages), run the suite(s) that cover it — the matching `node scripts/test-*.js` for a focused change, `npm test` when the change crosses areas or you are unsure which suite covers it. Before reporting the work as done, confirm the output shows each suite's `N passed, 0 failed` line. A run that prints no count, skips, or fails is not a pass: say so and show the output rather than claiming success. Docs-only changes (README, CLAUDE.md) need no test run.

### Test rules (enforced by `scripts/ci-tests.js`)

- Every suite is a standalone script `scripts/test-*.js` using `assert`, printing `N passed, M failed`. A suite only passes if it exits 0 **and** prints that count with zero failed/skipped — a browser suite that skips because Chromium didn't launch counts as a failure.
- Every new `scripts/test-*.js` **must** be added to `GROUPS.node` / `GROUPS.browser` in `scripts/ci-tests.js`, or to `NOT_RUN` with a reason, or the run stops.
- Suites must be fully offline and keyless: they stub `global.fetch` themselves, `scripts/ci-offline.js` (preloaded via `NODE_OPTIONS`) refuses any off-machine connection, and the runner strips the environment to `ENV_PASSED`. Suites set their own stand-ins (e.g. `AUTH_SECRET`); the store falls back to its in-memory driver.
- `test-catalog-prices` is known-failing on main and runs non-blocking (`known-failing` group).
- `scripts/bench-*.js`, `probe-*.js`, `verify-*.sh` and `diagnose-search.js` hit live APIs/deployments and spend credits — not part of CI. `.github/workflows/live-validation.yml` is run by hand.

## Architecture

### Hosting split
GitHub Pages serves the static pages; Vercel serves the same repo (pages + functions). The interpreter endpoint is configured in one place: `<meta name="findwear-api">` in `index.html` / `find-clothes.html` (overridable via `window.FINDWEAR_API`). Account calls try the page's own origin first and fall back to the Vercel deployment. Cross-origin cookies (`SameSite=None; Secure`) mean accounts don't work on the Pages copy in Safari/Brave/Incognito — see README "Cross-origin access".

### `api/` naming is load-bearing
Every file under `api/` without an underscore-prefixed path segment becomes a routed Serverless Function. Helpers **must** live in `_`-prefixed files/dirs (`api/_auth.js`, `api/_providers/`, `api/_sizing/`). `test-pipeline.js` checks every routed file exports a handler and caps the function count. No `vercel.json`.

### Search pipeline
`assets/interpret.js` → `POST /api/interpret` (LLM reads the request into structured intent: categories, colors, fits, maxPrice…; the model never names products/URLs; `api/_reading.js` holds its output to the shopper's actual words; `api/_interpreters/` selects OpenAI by default or Gemini via `AI_PROVIDER`) → `assets/search.js` → `POST /api/search` → `api/_providers/product-source.js` picks an adapter by `PRODUCT_SOURCE` (default `openwebninja`; serpapi/serper/etsy also present) → raw records mapped and passed through the **verification gate** (must have title, price, image, retailer, direct non-aggregator product URL) → rendered by the single product-card function in `assets/app.js`. If the interpreter is unavailable, a local parser runs and the UI must say the AI didn't read the request; if the product source is unavailable, the sample catalogue (`assets/catalog.js`) is shown labelled as sample data. Never present a keyword match or sample data as AI/live results.

Adding a provider: `api/_providers/<name>.js` exporting `{ name, configured, search }`, register in `PROVIDERS` in `product-source.js`.

### Accounts, metering, billing
`api/_store.js` is the KV abstraction (Vercel KV / Upstash REST, else in-memory). `api/_auth.js` (sessions, password hashing), CSRF via the `X-Fynd-CSRF` header on every body-carrying request, `api/_meter.js` gates spend on `/api/interpret` and `/api/search` against `api/_plans.js`. `api/stripe-webhook.js` is the **only** thing allowed to change a plan; Stripe is called via raw REST in `api/_stripe.js` (no `stripe` package, deliberately). Secrets stay server-side — never move an API call into frontend code.

### Fit profile and sizing
- `assets/fit-profile-schema.js` is a versioned schema shared by browser and server (UMD-style: `window` global + `module.exports`); `api/fit-profile.js` runs every save through its `normalise()`. Fit guide answers are stored per clothing type and never read across types.
- `api/_sizing/records/*.json` — one record per product/region/sizing line, validated by `api/_sizing/schema.js`. Body charts (`measures: "body"`) are kept strictly apart from finished-garment measurements; every dimension has a `method` and the brand's quoted source text. Values a brand doesn't publish are absent, never filled in.
- Records carry a verification status. The engine refuses unverified records, and **code never sets `status: "verified"`** — that happens only via an approved source audit.
- `api/_sizing/engine.js` (tunable weights/tolerances/ease table at the top; names no brand) and `api/_sizing/personalize.js` (reads search results against the shopper's Fit Guide; deterministic, no AI, never removes/reorders results) back `api/size-recommendation.js`. Evaluation cases live in `scripts/fixtures/size-eval.json` (`test-size-eval.js`).

### Frontend
Each page loads plain `<script>` tags in dependency order (e.g. `products.js`, `interpret.js`, `search.js`, `account.js`, `app.js`); modules communicate via globals. All colours are tokens in the `:root` of `assets/styles.css` — no raw colour values anywhere, no unused tokens, and every text ink must meet contrast on its actual background; `scripts/test-ui.js` audits the rendered DOM for this.

## Conventions

- Honesty constraints run through the codebase and its tests: never claim data that wasn't verified (prices, images, sizes, AI readings, live results). Evidence fields (`imageEvidence`, `priceEvidence`, sizing `sources`) are re-proved, not trusted.
- Branches are `claude/<topic>`; PRs target `main`.
