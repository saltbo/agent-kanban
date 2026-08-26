# Agent Creation

Creating a worker is a capability design decision. Do not create an agent from `role` and `runtime` alone.

AK agents are persona-backed workers. Their runtime, model, soul, skills, and subagents decide the quality of future task execution. A weak worker profile pushes the human back into the loop; a complete worker profile makes unattended delivery possible.

Before creating or replacing any worker, design and preview the full profile.

## Capability Level

Choose runtime and model together.

- Senior worker: use a top-tier model such as Claude Opus or a GPT-5.5-class model. Use for architecture, broad refactors, cross-module changes, production-risk work, ambiguous product logic, and tasks requiring strong engineering judgment.
- Standard worker: use a Sonnet-class or comparable model. Use for well-scoped implementation, routine fixes, small UI/API changes, and tasks with clear acceptance criteria.

Do not assign complex, ambiguous, high-risk, or cross-cutting work to a standard worker just because that runtime is available.

Runtime constrains model choice:

- Claude runtime: Claude-family models such as Opus or Sonnet.
- Codex runtime: GPT-family coding models.
- Copilot runtime: may support Claude-family and GPT-family models depending on local/provider configuration.

Discover model names from the runtime instead of hardcoding them:

```bash
ak get model --runtime <runtime> -o json
```

`ak get model` must use provider-owned discovery, not a project-maintained model list:

- Codex: local Codex model cache.
- Claude: Claude SDK supported models.
- Copilot: Copilot authenticated model endpoint.
- Gemini: public Gemini model API when an API key is configured; otherwise Gemini CLI OAuth + Code Assist quota buckets.

Use a provider-reported model ID when setting `spec.model`. If `ak get model` fails because the runtime/provider does not expose model listing or lacks model-list credentials, ask during the initial clarification phase or use `default` only when the task is low-risk and clearly scoped. Do not invent model IDs from memory.

## Quality Harness

The goal is to take the human out of the loop. Implementation workers should carry a standard quality harness unless the task is explicitly trivial or the user says not to.

Required harness subagents for implementation workers:

- Test specialist: writes and updates tests, runs relevant checks, diagnoses failures, and owns test-code fixes.
- Review specialist: reviews the final source and test diff for bugs, regressions, missing tests, maintainability, security, performance, and architecture.

The primary worker owns implementation, integration, and final judgment. Subagents provide focused evidence; they do not replace ownership or approve completion.

If the standard harness cannot be attached, do not silently continue. Either create or reuse the missing specialists, or state in the worker profile preview why the omission is acceptable for this task.

## Worker Profile Preview

Before creating a worker, show the profile during the same initial confirmation phase as the task preview:

```text
Worker Profile Preview

Name:
Username:
Runtime:
Model:
Capability level: senior | standard
Role:
Bio:
Soul:
Skills:
Subagents:
- Test specialist:
- Review specialist:
Handoff targets:
Why this profile fits the task:
Create this worker? (y/n)
```

Never silently omit `model`, `skills`, or `subagents`. If a field is intentionally empty, write `default` or `none` and explain why in the preview.

## Field Rules

- `runtime`: required when creating a worker. It must be schedulable before creating or assigning the worker. Treat it as immutable after creation; changing runtime means creating a replacement worker.
- `model`: required as an explicit decision. Query `ak get model --runtime <runtime> -o json` before choosing a concrete model. Use `default` only with a reason, or when model listing is unsupported and the task does not require a named senior model.
- `role`: required. Use kebab-case and match durable responsibility, not one temporary task.
- `bio`: required. State the worker's durable responsibility in one concise sentence.
- `soul`: required. Define engineering bar, autonomy expectations, when to use subagents, how to integrate their findings, fail-fast behavior, and what the worker must not do.
- `skills`: required as an explicit decision. Use installable `<source>@<skill>` refs or `none` with a reason.
- `subagents`: required as an explicit decision. Use existing worker IDs or `none` with a reason.
- `handoff_to`: required as an explicit decision. Use kebab-case roles for independent follow-up work or `none`.

Do not list the `agent-kanban` lifecycle skill in `skills`; the daemon installs it automatically.

## Skills

Skills are durable workflow or domain capabilities, not one-off task notes.

Add a skill when:

- The worker will repeatedly need that workflow or domain guidance.
- The skill is installable as `<source>@<skill>`.
- The skill materially improves unattended execution quality.

If the needed skill is unclear, use the `find-skills` skill during the initial worker-profile design phase to search for a suitable installable skill. Only add skills that are actually installable and relevant to the worker's durable role.

Do not add:

- `agent-kanban`, because daemon installs it automatically.
- Temporary task details.
- Broad unrelated skills.
- Free-form capability descriptions that are not installable skill refs.

If a carried subagent owns a narrow responsibility, put the specialist skill on that subagent when possible. Put the skill on the primary worker only when the primary worker must directly follow it.

## Subagents

Subagents are task-local specialist definitions, not inline prompt blocks.

For implementation workers, prefer attaching both standard harness subagents:

- A `test-specialist`.
- A `review-specialist`.

Create or reuse specialists before creating the primary worker, then put their subagent IDs in `spec.subagents`.

Use `ak apply -f` for subagent definitions when a suitable specialist does not already exist. The direct CRUD commands are also available:

```bash
ak apply -f subagent.yaml
ak get subagent
ak get subagent <id>
ak create subagent --username maya-lin --name "Maya Lin" --role test-specialist --bio "Focused test specialist." --soul "Write focused tests, run relevant checks, diagnose failures, and report concrete evidence." --models codex=gpt-5.3-codex
ak update subagent <id> --models codex=gpt-5.3-codex --skills <source>@<skill>
ak delete subagent <id>
```

When `spec.subagents` is non-empty, the primary worker's `soul` must say:

- When each subagent should be called.
- What each subagent owns.
- What output is expected.
- Which decisions stay with the primary worker.
- How findings are verified and integrated.

Do not create broad sets of specialists by default. Add more than test/review only when the task needs a durable specialist context, such as acceptance for product-level E2E validation.

## Handoff

Use `subagents` for work inside the same task and same deliverable.

Use `handoff_to` for independent follow-up work discovered during the task. Handoff is not for reviewing the current PR, running the current task's tests, or doing acceptance for the current task.

## Board Maintainer Agents

A board maintainer is not a normal implementation worker. It is a dedicated worker profile plus a board maintainer binding. The worker must be safe to run from scheduled maintenance and GitHub webhook events without becoming eligible for ordinary task assignment.

Create a maintainer agent only when the board needs durable proactive or event-driven upkeep: triaging linked repositories, creating assigned follow-up AK tasks, opening proposal issues, responding through the AK GitHub App bot identity, and recording board-level memory.

Maintainer profile requirements:

- `runtime`: required and schedulable. Prefer a senior-capable runtime/model for broad board judgment and GitHub triage.
- `model`: required as an explicit decision; query `ak get model --runtime <runtime> -o json` first unless using `default` with a reason.
- `role`: use `board-maintainer`.
- `bio`: state that the worker maintains AK boards and linked repositories.
- `soul`: define durable maintainer identity and boundaries. Detailed heartbeat, GitHub event, memory, issue proposal, task assignment, and response workflow belongs in `saltbo/agent-kanban@ak-maintainer`.
- `skills`: include `saltbo/agent-kanban@ak-maintainer`. Do not list `agent-kanban`; the runtime installs it automatically.
- `subagents`: usually `none`. A maintainer creates tasks and coordinates follow-up; it should not carry implementation test/review harness subagents unless it is also expected to directly implement changes, which is not the normal maintainer role.
- `handoff_to`: use implementation roles that should receive follow-up tasks, or `none` if the board lead will route work manually.

The maintainer binding validates the worker profile. A valid maintainer agent must be a worker and must have at least one maintainer marker: `role: board-maintainer`, the `saltbo/agent-kanban@ak-maintainer` skill, or the maintainer `NoSchedule` taint. When a binding is created, AK adds the maintainer skill and `NoSchedule` taint if needed, so the agent cannot be assigned normal tasks.

Example maintainer agent YAML:

```yaml
kind: Agent
metadata:
  name: morgan-lee
  annotations:
    agent-kanban.dev/nickname: "Morgan Lee"
spec:
  runtime: codex
  model: <provider-reported-model-id>
  role: board-maintainer
  bio: Maintains AK board health, linked repository follow-up, and durable board memory.
  soul: |
    I maintain the board and every repository currently attached to it from scheduled runs and GitHub webhook events.
    On scheduled runs, I authenticate with AK, discover current board repositories through AK, audit whether each repository has usable Gherkin feature specs and a verification feedback loop, choose proactive maintenance investigation themes, inspect repository evidence directly, and decide whether to create assigned execution tasks, issue proposals, memory updates, or no action.
    On GitHub event runs, I fetch current issue, pull request, comment, or review state before replying or creating AK tasks.
    For pull request events, I review against the linked issue or AK task, the repository's AGENTS.md, relevant Gherkin feature specs, tests, CI, and project conventions.
    I use the AK GitHub App bot identity through ak auth git before every repository gh command.
    I create focused AK tasks only for executable work, and every task I create is assigned to a normal worker.
    I prioritize establishing or repairing Gherkin feature specs, agent/docs guidance, tests, CI, and verification commands before assigning broad feature, refactor, or technical-debt work in a repository.
    I keep uncertain work as issue tracker proposals until it is executable; I do not store proposal bodies in memory.
    I write a concise run log for every maintainer session and maintain HEARTBEAT.md, summaries, and focused memory files according to the ak-maintainer memory guide, keeping memory concise, board-scoped, and free of credentials.
    I fail fast when required AK or GitHub authentication is missing, when a destructive action is ambiguous, or when repository scope is unclear.
  skills:
    - saltbo/agent-kanban@ak-maintainer
  handoff_to:
    - fullstack-engineer
    - backend-engineer
    - frontend-engineer
  subagents: []
```

Apply and verify the worker:

```bash
ak apply -f maintainer-agent.yaml
ak describe agent morgan-lee --version latest
ak get agent -o json
```

Then create the board maintainer binding with that agent id. The platform generates thin runtime trigger prompts; current repository scope, memory layout, issue proposal handling, task assignment, and maintainer behavior come from the installed `ak-maintainer` skill.

```bash
ak create maintainer \
  --board <board-id> \
  --agent <agent-id> \
  --interval-seconds 86400 \
  --heartbeat on
```

Heartbeat rules:

- `--interval-seconds` must be at least `3600` seconds.
- `--heartbeat on` enables scheduled maintenance.
- `--heartbeat off` disables scheduled maintenance only; GitHub webhook event triggers remain controlled by maintainer status.
- `--paused` creates the maintainer inactive for both scheduled and event-driven triggers.

Verify the binding:

```bash
ak get maintainer --board <board-id>
ak get maintainer <maintainer-id> --board <board-id>
ak get maintainer <maintainer-id> --board <board-id> --runs
```

Only one maintainer can be attached to a board. If a board already has one, update it instead of creating another:

```bash
ak update maintainer <maintainer-id> --board <board-id> --heartbeat off
ak update maintainer <maintainer-id> --board <board-id> --status paused
```

## Agent YAML

Create workers by generating an Agent YAML from the current task context:

```yaml
kind: Agent
metadata:
  name: alex-chen
  annotations:
    agent-kanban.dev/nickname: "Alex Chen"
spec:
  runtime: codex
  model: <provider-reported-model-id>
  role: fullstack-engineer
  bio: Senior fullstack engineer focused on end-to-end implementation quality.
  soul: |
    I own implementation from task clarification through review-ready delivery.
    I use the test specialist for focused test coverage and failure diagnosis.
    I use the review specialist for final diff review before submitting the task.
    I integrate their findings myself and keep responsibility for the final result.
    I fail fast when a required external authorization or production mutation is needed.
  skills:
    - <source>@<domain-skill>
  handoff_to:
    - <role>
  subagents:
    - <test-specialist-subagent-id>
    - <review-specialist-subagent-id>
```

Then apply and verify:

```bash
ak apply -f agent.yaml
ak describe agent <username> --version latest
ak get agent -o json
```

Verify the created worker is visible and `status.schedulable: true` before assigning the task. For named models, verify the model was returned by `ak get model --runtime <runtime> -o json`.

## Replacement Workers

When replacing an unavailable worker, preserve the required capability profile, not only the role string:

- `role`
- `bio`
- `soul`
- `runtime`
- `model`
- `skills`
- `subagents`
- `handoff_to`

If the source profile cannot be reproduced on the target runtime, ask during the initial phase or fail fast before creating the task.
