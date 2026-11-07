# Fynd — working instructions for Claude Code

## Project objective

Fynd's MVP is a personal clothing-fit comparison tool.
Core promise: **"Find the size that fits like the clothes you already love."**
Initial focus: hoodies and sweatshirts.

The customer saves a garment they already own, visits another retailer's
product page, uses Fynd to read its sizing chart, and compares candidate sizes
against their saved garment. Accuracy and trustworthy recommendations matter
more than supporting every retailer.

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

## Testing

- Run targeted tests first.
- Run broader tests only when affected shared functionality requires them.
- Never claim a test passed unless it actually ran.
- Clearly distinguish fixture tests from real retailer verification.
- Never make unsupported claims about production readiness.

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

## Tests

- One suite: `node scripts/<suite>.js` (e.g. `test-sizing`, `test-extension`,
  `test-extension-extract`, `test-find-fit-manual`).
- Browser: `test-e2e`, `test-fit-panel-browser`, `test-find-fit-search-browser`
  (in `test-e2e` and `test-fit-panel-browser`, `FYND_TEST_ONLY=<regex>` runs
  matching tests only).
- Groups: `node scripts/ci-tests.js node|browser|real-chrome`. All run offline
  on fixture pages and stand-in handlers; none is real retailer verification.

## Final report

Provide only:

1. What changed.
2. Files modified.
3. Tests actually run and results.
4. Remaining limitations.
5. Git status.
6. Whether the requested objective was achieved.

Do not repeat information unnecessarily.
