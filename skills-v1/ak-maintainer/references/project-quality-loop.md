# Project Quality Loop

This reference helps an AK maintainer judge whether a repository is ready for high-quality autonomous iteration.

The goal is to give agents and maintainers an objective standard for decisions and a feedback loop that proves whether implementation matches that standard. Use the repository's established conventions when they exist. If the repository has no reliable convention, create work to establish one.

## Contents

- [Principle](#principle)
- [First Audit For A Repository](#first-audit-for-a-repository)
- [Behavior Expectations](#behavior-expectations)
- [Other Project Knowledge](#other-project-knowledge)
- [Feedback Loop Expectations](#feedback-loop-expectations)
- [Readiness Levels](#readiness-levels)
- [Maintainer Actions](#maintainer-actions)
- [When Work Can Proceed](#when-work-can-proceed)
- [Memory Update](#memory-update)

## Principle

Agents need two anchors:

- Behavior expectations: specs, acceptance criteria, issue decisions, feature files, product docs, or another project-approved source that defines what correct means.
- Feedback loop: automated checks and repeatable verification that tell an agent whether the work actually meets the target.

Gherkin `.feature` files under `spec/` are a good default when a repository has no better standard for user-visible behavior. They are not the only acceptable standard. Technical decisions, architecture, stack choices, setup instructions, and agent-specific operating rules belong in the repository's normal documentation surfaces.

Without a quality loop, autonomous iteration is low-confidence. The maintainer should establish the loop before assigning broad feature, refactor, or technical-debt work that cannot otherwise be accepted reliably.

## First Audit For A Repository

On the first scheduled heartbeat that touches a repository, audit whether the repository has an autonomous delivery loop.

Check for:

- A project-approved source of behavior expectations: feature specs, acceptance criteria, product docs, issue decisions, or equivalent.
- Agent-facing repo instructions such as `AGENTS.md`.
- Architecture and technical decision records in `docs/`, `docs/adr/`, or the repository's existing decision-doc location.
- Stack and dependency decisions outside behavior specs.
- Local setup and run instructions.
- Local test command.
- Typecheck/lint/build command where applicable.
- CI workflow that runs meaningful checks.
- Integration, E2E, contract, regression, or behavior tests for important paths.
- Test data or fixtures needed for repeatable verification.
- Clear task acceptance criteria conventions.

Record the result in repository memory under `repos/<owner>__<repo>.md`.

## Behavior Expectations

Behavior expectations should describe product or system behavior in a way that can be verified. They should not become a dump for all project knowledge.

Good behavior expectations:

- Define user-visible or externally observable behavior.
- Include concrete acceptance criteria, examples, scenarios, or invariants.
- Identify important edge cases and regressions.
- Are stable enough to guide future work.
- Can be connected to tests, manual verification, browser automation, or another harness.

Bad behavior expectations:

- Pseudocode that mirrors implementation line-by-line.
- Architecture decisions without behavioral impact.
- Stack choices.
- Agent workflow instructions.
- Setup or deployment instructions.
- Temporary task notes.
- Raw issue discussions copied wholesale.
- Large generated dumps.
- Aspirational text with no testable behavior.

See `example-feature-spec.feature` for one concrete format when Gherkin is appropriate.

## Other Project Knowledge

Use existing repository conventions when they exist. If the repository has no convention, prefer:

- `AGENTS.md` for agent-facing operating instructions, required commands, coding rules, quality gates, and repo-specific workflow.
- `docs/adr/` for architecture decisions and tradeoffs.
- `docs/architecture.md` for current architecture overview.
- `docs/development.md` for local setup, run commands, verification commands, and troubleshooting.
- `README.md` for human-facing quickstart and project overview.

The maintainer may create tasks to establish these files when their absence prevents reliable autonomous work.

The worker workflow belongs in the target repository's `AGENTS.md` or equivalent agent instruction file. The maintainer should review whether workers followed it; the maintainer skill should not duplicate every repository's worker workflow.

See `example-agents.md` for a repository `AGENTS.md` starting point when a repository has no agent-facing quality rules.

## Feedback Loop Expectations

The feedback loop should let an implementation agent answer:

- What behavior am I trying to preserve or create?
- How do I run the project locally?
- Which tests or checks prove this change?
- What failure means I should keep working?
- What passing signal means the task is ready for review?

Look for:

- Unit tests for core logic.
- Integration tests for API/data boundaries.
- E2E or workflow tests for user-visible flows.
- Browser automation for UI, website, and product-flow behavior.
- Contract tests for public API or protocol behavior.
- Regression tests for known bugs.
- Typecheck/lint/build where useful.
- CI that runs meaningful checks.
- Minimal fixtures, seed data, or test harnesses.

Do not require every project to have every test type. Require the smallest meaningful loop that can catch the risks of that repository and change.

## Readiness Levels

Use these levels in repository memory:

- `missing`: no usable behavior expectations and no meaningful verification.
- `partial`: some specs, docs, or checks exist, but agents cannot reliably know whether changes meet the target.
- `usable`: behavior expectations and verification are good enough for normal assigned implementation tasks.
- `strong`: behavior expectations, supporting docs, tests, CI, and acceptance conventions support confident autonomous iteration.

## Maintainer Actions

If readiness is `missing` or `partial`, prioritize assigned tasks that build the loop:

- Add or reorganize behavior expectations for core workflows.
- Move non-behavior knowledge into `AGENTS.md`, `docs/`, or ADR files.
- Document local setup and verification commands.
- Add regression tests around known bugs or high-risk behavior.
- Add integration/E2E/contract tests for critical paths.
- Add browser automation for important UI or product flows.
- Add CI for meaningful checks.
- Add fixtures or test harnesses that make verification repeatable.

Do not create vague "improve tests" tasks. Create concrete, assigned tasks with a target surface, acceptance criteria, and the checks that should exist afterward.

## When Work Can Proceed

Feature, refactor, and broad maintenance work can proceed when:

- The relevant behavior has an accepted source of truth: spec, issue decision, proposal, docs, or task acceptance criteria.
- The task has concrete acceptance criteria.
- There is a verification path that can fail before the fix and pass after it, or the task includes creating that verification path first.
- The assigned worker can run the checks locally or in CI.

If these conditions are not true, create a feedback-loop task first.

## Memory Update

For each repository, keep a short quality-loop section in `repos/<owner>__<repo>.md`:

```markdown
## Quality Loop
- Readiness: missing | partial | usable | strong
- Behavior source: <spec/docs/issues/tasks path or none>
- Agent/docs paths: <AGENTS.md/docs paths or none>
- Main verification command: <command or none>
- CI: <workflow/status or none>
- Critical gaps: <bullets>
- Last audited: <iso-time>
```

Do not store full specs or docs in memory. Store paths, readiness, gaps, decisions, and links to tasks or issue proposals.
