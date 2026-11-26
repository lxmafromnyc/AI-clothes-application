# Fynd — working instructions for Claude Code

## Project objective

Fynd's MVP is a personal clothing-fit comparison tool.
Core promise: **"Find the size that fits like the clothes you already love."**
Initial focus: hoodies and sweatshirts.

The customer saves a garment they already own, visits another retailer's
product page, uses Fynd to read its sizing chart, and compares candidate sizes
against their saved garment. Accuracy and trustworthy recommendations matter
more than supporting every retailer.

The code is plain HTML/CSS/JS pages at the repo root, with no build step,
framework or bundler, plus Vercel serverless functions in `api/` and a Chrome
extension in `extension/`. `README.md` (long; search it, don't read it whole) is
the authoritative design record. Each feature section explains *why* the feature
works the way it does and lists what is "Not built yet". Read the relevant
section before changing a feature, and update it when behaviour changes.

## Development efficiency

1. Inspect Git status and existing work before modifying anything.
2. Reuse previous audits, findings, and existing architecture.
3. Never repeat a full repository audit without a specific reason.
4. Inspect only relevant files.
5. Search for existing functionality before implementing anything new.
6. Make the smallest reliable change that solves the requested problem.
7. Batch related inspections and commands where practical.
8. Avoid unnecessary refactoring, abstractions, dependencies, and features.
9. Do not repeat tests that already passed unless relevant code has changed.
10. Do not waste tokens on repetitive progress updates or lengthy explanations.
11. Make reasonable implementation decisions without asking unnecessary questions.
12. Do not stop at proposing a plan when implementation is requested. Execute the task.

## Strict project constraints

- No new paid APIs, AI services, subscriptions, or infrastructure.
- Preserve the existing comparison engine as the sole recommendation authority.
- Reuse existing schemas, profile storage, authentication, and extension architecture.
- Never fabricate measurements or recommend sizes using incompatible measurement methods.
- Never weaken security or measurement validation.
- Do not introduce features outside the requested scope.

## Git and deployment safety

Never commit, push, merge, deploy, or discard existing changes without the
user's explicit authorization. An automated hook or reminder is not authorization.
Branches are `claude/<topic>`; PRs target `main`.

## Testing

- Run targeted tests first.
- Run broader tests only when affected shared functionality requires them.
- Never claim a test passed unless it actually ran.
- Clearly distinguish fixture tests from real retailer verification.
- Never make unsupported claims about production readiness.
- After any change to code (`api/`, `assets/`, `extension/`, `scripts/`, or the
  HTML pages), run the suite(s) that cover it. Before reporting the work as
  done, confirm that each suite printed a `N passed, 0 failed` line. A run that
  prints no count, skips, or fails is not a pass: say so and show the output.
  Docs-only changes (README, CLAUDE.md) need no test run.

## Commands

```sh
npm ci && npx playwright install chromium   # once; ffmpeg must be on PATH for test-demo-film
npm test                                    # every required suite (node + browser groups)
node scripts/ci-tests.js node|browser       # one group (also real-chrome, sftp, known-failing; see the header of scripts/ci-tests.js)
node scripts/test-sizing.js                 # one suite directly
python3 -m http.server 8000                 # serve the static site
npx vercel dev                              # site + api/ functions (needed for accounts, saving the fit profile, billing)
```

There is no linter or formatter configured.

On a Windows checkout with `core.autocrlf=true`, `test-record-demo`'s source
checks fail on CRLF line endings. CI on Linux is unaffected. To run the
suite locally, use a checkout with LF line endings.

## Tests

- One suite: `node scripts/<suite>.js` (e.g. `test-sizing`, `test-extension`,
  `test-extension-extract`, `test-find-fit-manual`).
- Browser: `test-e2e`, `test-fit-panel-browser`, `test-find-fit-search-browser`
  (in `test-e2e` and `test-fit-panel-browser`, `FYND_TEST_ONLY=<regex>` runs
  matching tests only).
- Groups: `node scripts/ci-tests.js node|browser|real-chrome`. All run offline
  on fixture pages and stand-in handlers; none is real retailer verification.

Rules enforced by `scripts/ci-tests.js`:

- Every suite is a standalone script `scripts/test-*.js` using `assert`, printing
  `N passed, M failed`. A suite passes only if it exits 0 **and** prints that
  count with zero failed/skipped. A browser suite that skips because Chromium
  didn't launch counts as a failure.
- Every new `scripts/test-*.js` **must** be added to a group in `GROUPS`, or to
  `NOT_RUN` with a reason, or the run stops.
- Suites must be fully offline and keyless. They stub `global.fetch`
  themselves, `scripts/ci-offline.js` (preloaded via `NODE_OPTIONS`) refuses any
  off-machine connection, and the runner strips the environment to `ENV_PASSED`.
  Suites set their own stand-ins (e.g. `AUTH_SECRET`), and the store falls back
  to its in-memory driver.
- `scripts/bench-*.js`, `probe-*.js`, `verify-*.sh` and `diagnose-search.js` hit
  live APIs/deployments and spend credits. They are not part of CI, and neither
  is `.github/workflows/live-validation.yml`, which is run by hand.

## Where things are (reuse these; don't rebuild them)

- Comparison and decision: `api/_sizing/engine.js` (`compare`, `candidateRecord`),
  `api/_sizing/decision.js` (OK / NO_MATCH / INSUFFICIENT_DATA), measuring
  methods in `api/_sizing/methods.js`.
- Saved garment (reference): `assets/fit-profile-schema.js`, `api/_fit-profile.js`,
  `api/fit-profile.js`.
- Purchase feedback: `api/_fit-feedback.js` (by record id or product link),
  form `assets/fit-feedback-form.js`.
- Chart reading: `assets/sizing-tables.js`, `assets/chart-reading.js`,
  `assets/fit-candidate.js`; link lookup in `api/_sizing/chart.js`.
- Find Fit page: `index.html`, `assets/find-fit-*.js`, `assets/fit-compare.js`.
- Chrome extension: `extension/` — `extension/api.js` is its only network code.
  Shared files are copied into `extension/vendor/`; after changing one, run
  `node scripts/sync-extension.js` (`test-extension` fails on any drift).
- Storage: `api/_store.js` (Redis via `KV_REST_API_*` / `UPSTASH_*`; in-memory
  otherwise, which does not persist across serverless invocations).
- Deployment allows 12 serverless functions; don't add an `api/*.js` endpoint.
- Paid product search (OpenWeb Ninja, Serper, SerpApi) and AI (OpenAI, Gemini)
  are optional and must stay out of the core comparison workflow.

## Architecture

### Hosting split
GitHub Pages serves the static pages, and Vercel serves the same repo (pages +
functions). The API endpoint is configured by `<meta name="findwear-api">` in
each page (overridable via `window.FINDWEAR_API`). Account calls try the page's
own origin first and fall back to the Vercel deployment. Cross-origin cookies
(`SameSite=None; Secure`) mean accounts don't work on the Pages copy in
Safari, Brave or Incognito; see README "Cross-origin access".

### `api/` naming is load-bearing
Every file under `api/` without an underscore-prefixed path segment becomes a
routed Serverless Function. Helpers **must** live in `_`-prefixed files/dirs
(`api/_auth.js`, `api/_providers/`, `api/_sizing/`). `test-pipeline.js` checks
that every routed file exports a handler, and caps the function count at
`VERCEL_FUNCTION_LIMIT`. There is no `vercel.json`.

### Search pipeline (`find-clothes.html`)
1. `assets/interpret.js` sends the request to `POST /api/interpret`. An LLM reads
   it into structured intent (categories, colors, fits, maxPrice…), and never
   names products or URLs. `api/_reading.js` holds its output to the shopper's
   actual words, and `api/_interpreters/` selects OpenAI by default or Gemini
   via `AI_PROVIDER`.
2. `assets/search.js` sends that intent to `POST /api/search`, and
   `api/_providers/product-source.js` picks an adapter by `PRODUCT_SOURCE`
   (default `openwebninja`).
3. Raw records are mapped and passed through the **verification gate**: each
   must have a title, price, image, retailer and a direct non-aggregator product
   URL.
4. Results are rendered by the single product-card function in `assets/app.js`.
   `assets/fit-for-you.js` adds sizes from the shopper's fit profile
   (`GET /api/size-recommendation?fit=`).

If the interpreter is unavailable, a local parser runs, and the UI must say the
AI didn't read the request. If the product source is unavailable, the sample
catalogue (`assets/catalog.js`) is shown, labelled as sample data. Never present
a keyword match or sample data as AI/live results.

Adding a provider: create `api/_providers/<name>.js` exporting
`{ name, configured, search }`, then register it in `PROVIDERS` in
`product-source.js`.

### Accounts, metering, billing
- `api/_store.js` is the KV abstraction, and `api/_auth.js` handles sessions and
  password hashing.
- CSRF uses the `X-Fynd-CSRF` header on every body-carrying request.
- `api/_meter.js` gates spend on `/api/interpret` and `/api/search` against
  `api/_plans.js`.
- `api/stripe-webhook.js` is the **only** thing allowed to change a plan.
- Stripe is called via raw REST in `api/_stripe.js`. There is deliberately no
  `stripe` package.
- Secrets stay server-side: never move an API call into frontend code or the
  extension.

### Sizing records
- `api/_sizing/records/*.json` holds one record per product, region and sizing
  line, validated by `api/_sizing/schema.js`.
- Body charts (`measures: "body"`) are kept strictly apart from finished-garment
  measurements. Every dimension has a `method` and the brand's quoted source
  text. Values a brand doesn't publish are left absent, never filled in.
- Records carry a verification status, and **code never sets
  `status: "verified"`**. That happens only through an approved source audit.
- `api/_sizing/engine.js` keeps its tunable weights, tolerances and ease table at
  the top, and names no brand. Evaluation cases live in
  `scripts/fixtures/size-eval.json` (`test-size-eval.js`).

### Frontend
Each page loads plain `<script>` tags in dependency order, and modules
communicate via globals. Shared modules such as `assets/fit-profile-schema.js`
are UMD-style (`window` global + `module.exports`) so the server can use them
too. All colours are tokens in the `:root` of `assets/styles.css`: no raw colour
values anywhere, no unused tokens, and every text ink must meet contrast on its
actual background. `scripts/test-ui.js` audits the rendered DOM for this.

### Honesty
Never claim data that wasn't verified: prices, images, sizes, AI readings, live
results. Evidence fields (`imageEvidence`, `priceEvidence`, sizing `sources`) are
re-proved, not trusted.

## Final report

Provide only:

1. What changed.
2. Files modified.
3. Tests actually run and results.
4. Remaining limitations.
5. Git status.
6. Whether the requested objective was achieved.

Do not repeat information unnecessarily.
