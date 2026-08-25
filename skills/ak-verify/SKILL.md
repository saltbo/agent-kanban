---
name: ak-verify
description: |
  Post-write verification workflow: test, review, and regression-check code
  changes through distinct author/test/reviewer roles. Use after any
  non-trivial code change, or as the acceptance standard when reviewing
  someone else's changes. Do not use for trivial edits, docs-only changes,
  or pure research tasks.
---

# AK Verify — Post-Write Verification Workflow

Every non-trivial code change goes through three ordered steps: **Tests → Review → Regression**. Each step is owned by a distinct role.

## Roles

The workflow is role-based, not tied to any specific runtime or subagent implementation:

- **Author** — orchestrates the whole workflow and is the *only* role allowed to modify source code.
- **Test author** — writes and updates unit/integration tests, runs them.
- **E2E author** — writes and updates browser/E2E tests. Only involved when the change touches frontend/UI code.
- **Reviewer** — reviews both source and test code for quality, reuse, and efficiency. Returns `PASS` or `REVISE` with specific findings.

**Runtime mapping**: on runtimes with subagent support (e.g. Claude Code with dedicated test-writer / code-reviewer subagents), the Author delegates each role to an independent subagent. On single-agent runtimes, one agent plays each role in sequence — the review pass is never skipped or merged into the authoring pass.

**Ownership rule**: the Author only modifies source code. All test-code modifications go through the Test author / E2E author roles, even on single-agent runtimes (keep changes mentally separated and attribute them correctly).

## Step 1 — Tests

Write or update tests that cover the change, then run them:

- Unit/integration tests for every code change.
- Browser/E2E tests additionally when the change touches frontend components.

- **ALL PASS** → proceed to Step 2.
- **FAILURES** → the Author reads the failure and triages:
  - **Source bug** → the Author fixes the source code and re-runs the tests.
  - **Test bug** → state *why* the test is wrong, then hand it to the Test author (unit) or E2E author (browser) role to fix.

## Step 2 — Review

The Reviewer role reviews both source and test code (clean-code standards: reuse, quality, efficiency, consistency with surrounding conventions).

- **REVISE on source code** → the Author fixes and re-runs the review.
- **REVISE on test code** → forward the findings to the appropriate test role to fix.
- **PASS** → proceed to Step 3.

## Step 3 — Regression

Run the repository's full build, type check, and test suite to catch breakage.

Discover the commands from the repository's own configuration (package.json scripts, CI config, Makefile, CLAUDE.md/AGENTS.md) rather than assuming. Typical example for a pnpm monorepo:

```bash
pnpm build && pnpm typecheck && npx vitest run
```

Caution: in repos with a solution-style root `tsconfig.json` (`"files": []` + `references`), running `tsc --noEmit` at the root checks nothing — use the repo's own typecheck script instead.

Any failure → fix and re-run. If the fix touches source code, go back to Step 1.

## Project-Specific Steps

The repository's own `CLAUDE.md` / `AGENTS.md` may define additional mandatory checks on top of this workflow (smoke tests, lint gates, migration checks, etc.). Read them and run those steps where they apply.

## Maintainer Perspective (Reviewing Others' Changes)

When acting as a reviewer of someone else's PR (e.g. an AK board maintainer):

- Treat Step 1 and Step 3 outputs as **verification evidence**: re-run or inspect them yourself when the stakes warrant it; do not blindly trust the worker's claim.
- Perform Step 2 yourself — that *is* the code review.
- Map the outcome to the review decision: all steps pass → accept/complete; any step fails or evidence is missing → reject with specific findings.
