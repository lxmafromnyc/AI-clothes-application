---
description: Sync main, branch, recon, plan for approval, then implement and verify a task
argument-hint: <task description>
---

Task: $ARGUMENTS

Follow this workflow exactly, in order. CLAUDE.md still applies throughout.

## 1. Sync & branch

- Run `git status`. If the working tree has uncommitted changes, STOP and ask
  how to handle them. Never stash, discard or commit them on your own.
- `git fetch origin`, then create a fresh branch from the latest `origin/main`:
  `git switch -c claude/<short-topic-name> origin/main` (a short kebab-case
  name derived from the task). If that branch name already exists, pick a
  different one rather than reusing or resetting it.

## 2. Recon first (no coding yet)

- `git log -n 5 --oneline`.
- Search `README.md` for the section matching this task and read that section
  (don't read the whole file), including its "Not built yet" notes.
- Inspect only the relevant files (use "Where things are" in CLAUDE.md), and
  search for existing functionality before planning anything new.
- Do not edit any file in this step.

## 3. Plan & ask approval

Present a concise bullet-point plan:

- Exact files to create or edit, and what changes in each.
- Edge cases and how each is handled.
- Which `scripts/test-*.js` suite(s) will verify it, and which tests will be
  added or updated (new suites must be registered in `scripts/ci-tests.js`).
- Whether the README section needs updating.

Then STOP. Do not edit any file until the user replies "go" (or otherwise
clearly approves). If the user changes the plan, present the revised plan and
wait again.

## 4. Execute & verify

- Implement the approved plan with the smallest reliable change.
- Add or update offline tests (no network, no keys; follow the
  `scripts/ci-tests.js` rules).
- If a file shared with the extension changed, run
  `node scripts/sync-extension.js`.
- Run the matching `node scripts/test-*.js` suite(s) and fix failures until
  each prints `N passed, 0 failed`. A run that prints no count, skips or fails
  is not a pass: report it with its output.
- Update the README section if behaviour changed.
- Do not commit, push or open a PR unless the user explicitly asks.
- Finish with the final report format from CLAUDE.md: what changed, files
  modified, tests actually run and results, remaining limitations, git status,
  and whether the objective was achieved.
