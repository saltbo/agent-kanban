# Agent Instructions

## Behavior-First Rule

Before changing product behavior, identify the source that defines the expected behavior. Use the repository's established standard: feature specs, acceptance criteria, issue decisions, product docs, or another approved format.

If the repository uses Gherkin `.feature` files, update an existing file when the change extends an existing capability, or create a new file when the change introduces a durable new capability.

Do not implement product behavior until the expected behavior is captured in a reviewable and verifiable form.

## Test Rule

Every behavior change must include tests or another project-approved verification path that proves the relevant behavior.

Tests do not need to execute behavior specs directly, but they must prove the same behavior described by the accepted source of truth.

A task is not done until:

- the expected behavior is documented in the project-standard form,
- the implementation matches that expected behavior,
- tests or accepted verification prove the behavior,
- the project verification command passes.

## Verification

Run the smallest meaningful checks for the changed surface.

Before submitting for review, run the repository's documented typecheck, test, build, and E2E commands that apply to the change.

## Review Standard

A PR should be sent back for changes when product behavior changed without updating the accepted behavior source, tests or verification do not prove the changed behavior, implementation contradicts the expected behavior, verification commands fail, or the change bypasses project architecture without an accepted decision.
