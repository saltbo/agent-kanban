# Runtime-Aware Delegation

AK provides data. The leader makes the scheduling decision.

Before assigning tasks or creating workers, run:

```bash
ak get agent -o json
```

Use these fields:

- `kind`: assign implementation tasks only to workers, not leaders.
- `role`: match the task domain first.
- `runtime`: the worker's runtime.
- `status.schedulable`: the only hard scheduling gate; only `true` can receive new work.
- `status.tasks.todo`: todo tasks already assigned to the worker.
- `status.tasks.in_progress`: in-progress tasks currently owned by the worker.
- `status.tasks.in_review`: tasks currently waiting for review.
- `status.tasks.done` / `status.tasks.cancelled`: historical assigned task counts.

## Runtime Choice

Runtime selection is a hard stop before task creation.

If multiple runtimes are schedulable for the needed role and the user has not expressed a runtime preference, ask which runtime to use before creating a new worker or assigning the task. Present only agents with `status.schedulable: true`, plus the relevant trade-off: existing matching worker, current load, model preference, or runtime-specific capability.

When creating a worker or choosing a non-default model, query provider-reported model availability:

```bash
ak get model --runtime <runtime> -o json
```

Treat the command as the source of truth. It reads from the runtime/provider's own authenticated surface where available: Codex cache, Claude SDK, Copilot model endpoint, or Gemini public API / Code Assist quota.

Use a returned model ID in `spec.model`. If `ak get model` fails because the runtime/provider does not expose model listing or lacks model-list credentials, follow `references/agent-creation.md` and either ask during the initial phase or use `default` only for low-risk, clearly scoped work.

Do not ask when there is only one schedulable runtime for the required capability profile, or when the user already specified a schedulable runtime.

## Assignment Rules

1. Pick a worker whose `role` matches the task.
2. Exclude workers with `status.schedulable !== true`.
3. Prefer the matching worker with the lowest `status.tasks.in_progress + status.tasks.in_review`, then lowest `status.tasks.todo`.
4. If the user specified a runtime, exclude workers whose `runtime` does not match.
5. If the user specified a runtime and no worker or machine reports that runtime as schedulable, stop and ask the user to choose an available runtime.
6. If no matching worker is schedulable, create a worker with the required capability profile on a schedulable runtime using `references/agent-creation.md`.
7. If a matching worker exists only on an unavailable runtime, copy the required capability profile into the new worker using `references/agent-creation.md`.
8. Do not assign to a runtime just because the CLI exists on a machine. Runtime availability is whatever AK reports.

## Same-Role Worker Creation

`Same role` means capability-compatible for the current task, not only the same `role` string. Follow `references/agent-creation.md` before creating or assigning the replacement worker.

## Creating Workers

Create workers only when needed for the current task:

- Missing role.
- Matching role exists but every matching worker has unavailable runtime.
- The task should run now and matching workers are already busy.

Do not create duplicate workers for hypothetical future work. When creation is needed, follow `references/agent-creation.md`.

## Complex Task Execution Model

For complex but coherent work, prefer one primary worker carrying focused task-local subagents over splitting the same outcome across multiple role-based workers. The primary worker owns the task, implementation direction, final integration, and review submission. Subagents handle independent, narrow work that would otherwise bloat the primary worker's context and cause attention drift.

Subagents are task-local specialist definitions, not inline prompt blocks. Create or reuse the specialist definition first, then put its ID in the primary worker's `spec.subagents`.

Good reusable subagent profiles:

- Test specialist: writes focused tests, runs relevant checks, diagnoses failures, and fixes test code when the failure is in the test.
- Review specialist: reviews the final diff for bugs, maintainability, security, performance, architecture, and other durable quality concerns.
- Acceptance specialist: validates the completed product behavior from the user's perspective after implementation review, tests, and CI pass; uses E2E or manual acceptance checks to confirm the feature actually works before the task is completed.

Do not create all of these by default. Create or attach only the specialist subagents that the primary worker will repeatedly use. Do not split one stable specialist context into separate action agents such as writer, runner, fixer, or reviewer phases. Split specialists only when the work needs different durable domain context, review bar, or runtime.

For concrete specialist Subagent YAML examples, read `references/specialist-profiles.md`.

Creation order:

1. Create or reuse specialist subagent definitions with their own `role`, `bio`, `soul`, runtime model mappings, and `skills`.
2. Run `ak get subagent -o json` and collect their subagent IDs.
3. Create or update the primary worker with those IDs in `spec.subagents`.
4. In the primary worker's `soul`, define the collaboration contract: when each subagent should be called, what output is expected, which decisions stay with the primary worker, and how findings are verified before being acted on.

Subagent apply and CRUD:

```bash
ak apply -f subagent.yaml
ak get subagent
ak get subagent <id>
ak create subagent --username maya-lin --name "Maya Lin" --role test-specialist --bio "Focused test specialist." --soul "Write focused tests, run relevant checks, diagnose failures, and report concrete evidence." --models codex=gpt-5.3-codex
ak update subagent <id> --models codex=gpt-5.3-codex --skills <source>@<skill>
ak delete subagent <id>
```

## Subagents vs Handoff

Use `subagents` for delegation inside the same task. The context overlaps with the primary task outcome, but a narrow specialist can inspect, test, review, or validate without loading the primary worker with every detail. The primary worker keeps ownership of the task, integrates the findings, and submits the same PR for review.

Use `handoff_to` for new independent work discovered while doing the task. The context overlap is low enough that it should become a separate task with its own description, owner, lifecycle, and review. Handoff is not for reviewing the current PR, running the current task's tests, or doing acceptance for the current task.

Rule of thumb:

- High context overlap + same deliverable → keep one task and use subagents if specialist focus helps.
- Low context overlap + separate deliverable → create a follow-up task through handoff.
- Shared files, data model, or API contract usually means high overlap; merge the work into one task or make it sequential with `--depends-on`.

Create workers by generating an Agent YAML from the current task context.

```yaml
kind: Agent
metadata:
  name: alex-chen
  annotations:
    agent-kanban.dev/nickname: "Alex Chen"
spec:
  runtime: codex
  model: <provider-reported-model-id>
  role: frontend-reviewer
  bio: Frontend reviewer focused on React, Tailwind, accessibility, and visual consistency.
  soul: |
    I review frontend changes for user-facing correctness, accessibility, and visual consistency.
    I inspect the changed UI against the existing design system before suggesting new patterns.
    I verify responsive behavior and key interactions when the change affects layout or flow.
    When task-local subagents are installed, I delegate focused checks to them only where their role gives better coverage than doing it myself.
    I use a test specialist for focused test work, a review specialist for final diff review, and an acceptance specialist for product-level E2E validation when those specialists are attached.
    I keep ownership of the final decision, integrate their findings, and do not treat subagent output as approval.
  skills:
    - <source>@<domain-skill>
  handoff_to:
    - <role>
  subagents:
    - <test-specialist-subagent-id>
    - <review-specialist-subagent-id>
    - <acceptance-specialist-subagent-id>
```

```bash
ak apply -f agent.yaml
ak get agent <username>
ak describe agent <username> --version latest
ak get agent -o json
```

Agent creation rules:

- `metadata.name` is the stable username. Use a human-like username such as `alex-chen`, not a role slug or temporary task name.
- `metadata.annotations["agent-kanban.dev/nickname"]` is the human nickname, such as `Alex Chen`.
- `spec.role` carries the job responsibility. Use kebab-case such as `frontend-reviewer`, `test-specialist`, or `acceptance-specialist`. Do not encode the role into the name.
- `spec.model` is optional. Set it only when the worker should use a specific model for its runtime.
- `spec.bio` is a short public responsibility summary.
- `spec.soul` is the worker's durable behavior policy: principles and decision rules that should affect future tasks for this agent.
- `skills` must be installable skill refs in `<source>@<skill>` format, matching what `npx skills add <source> --skill <skill>` can install.
- `handoff_to` should list kebab-case roles this agent may hand off newly discovered independent work to, not concrete agent IDs. At handoff time, the worker resolves the role to an available worker with `ak get agent -o json`.
- `subagents` should list existing subagent IDs to install as task-local subagents for this agent. They must be created or discovered before applying the primary worker YAML.
- If `subagents` is non-empty, `soul` must say how this agent collaborates with those subagents: when to call them, what they own, and how their output is reviewed or integrated.
- Agent YAML updates the current `latest` profile for `metadata.name`. If the profile changed, AK keeps the previous `latest` as a hash-version snapshot.
- Use `ak get agent <username>` to list snapshots and `ak describe agent <username> --version latest` to inspect the current approved profile.
- Verify `status.schedulable: true` before assigning any task to the new worker.

Skill selection rules:

- `skills` are installable skill references, not free-form capability descriptions.
- Do not list the `agent-kanban` lifecycle skill here; the daemon installs it automatically for AK workers.
- Add domain skills only when they provide concrete workflow, review, tool, or domain guidance the worker will repeatedly need.
- Match skills to the worker's durable role and expected task surface, not to one temporary assignment.
- Prefer a small, high-signal skill set. Do not add broad or unrelated skills just because they might help someday.
- If a carried subagent owns a narrow responsibility, put the specialist skill on that subagent when possible; put it on the primary worker only when the primary worker must directly follow that skill.
- If no installable skill exists for a repeated need, leave it out and describe the behavior in `soul`; workers may later propose adding a real skill when one becomes available.

Recommended skill examples:

- Web regression, browser E2E, visual flow checks, or product acceptance for web apps: `microsoft/playwright-cli@playwright-cli`.
- UI/UX implementation or visual review for web/mobile interfaces: `nextlevelbuilder/ui-ux-pro-max-skill@ui-ux-pro-max` or `vercel-labs/agent-skills@web-design-guidelines`.
- GitHub PR, issue, or CI workflows: use the relevant GitHub workflow skill when it is installed in the runtime; add it to YAML only if it has a valid `<source>/<repo>@<skill>` installable ref.

Soul writing rules:

- Include durable workflow preferences, review bar, handoff rules, and domain-specific principles.
- Include subagent collaboration rules when `spec.subagents` is set.
- Write first-person behavior rules for the agent, not task instructions for one assignment.
- Keep platform workflow out of `soul`; task claim/review/CI/completion-note rules belong to the installed `agent-kanban` skill.
- Do not include one-off task context, project facts, secrets, temporary user preferences, or implementation todos.
- If the rule should disappear after one task, it does not belong in `soul`.

## Reviewing Agent Profile Candidates

Every completed worker task must include a completion summary. The leader must read the task notes before merging the PR and check whether the worker proposed an agent profile change. Workers may propose profile changes when their current `bio`, `soul`, `skills`, `subagents`, or handoff targets caused durable behavior that should change for future tasks. Treat these as candidates, not approvals.

When a worker proposes a candidate:

1. Read the reason and candidate Agent YAML.
2. Accept only if the change is durable, role-appropriate, and not task-specific.
3. Apply accepted candidates with `ak apply -f <file>`; this updates the current `latest` profile. If the profile changed, AK snapshots the previous latest.
4. Verify with `ak describe agent <username> --version latest` and `ak get agent <username>`.
5. Reject by leaving `latest` unchanged and telling the worker why.

Do not apply changes that store one-off task context, project facts, temporary user preferences, or fixes that belong in source code or task descriptions.

If no proposal is present, no agent version action is needed unless the leader observed a durable behavior problem directly.

## Leader-Driven Profile Iteration

The leader may update a worker profile even when the worker did not propose a change. Use this when the worker's process or output shows a durable mismatch with the role, such as using the wrong review bar, ignoring required verification, choosing an unsuitable model for the task class, misusing or failing to use attached subagents, repeatedly misunderstanding task boundaries, or producing work that is far from the expected capability level.

Profile updates do not affect the currently running agent session. They prevent the same mistake on later tasks. Handle the current task through review actions only: reject with concrete instructions when the current attempt can be corrected, or close the PR and cancel the task when the attempt should be abandoned.

Never change an existing agent's `runtime` during profile iteration. Runtime is chosen when the agent is created and is treated as immutable. If the same capability is needed on a different runtime, create a replacement worker with a new profile on that runtime.

Do not use profile iteration for one-off task facts, temporary user preferences, missing task context, or source bugs that should be fixed in the current PR. Put those in the task rejection reason or follow-up task description instead.

When profile iteration is needed:

1. During `in_review`, decide the current task outcome first.
2. If the current attempt is recoverable, reject with specific instructions. This is the only way to send correction back into the active session.
3. If the current attempt is badly off-course, close the PR if one exists and cancel the active task. Recreate the task only after deciding what feedback belongs in the new task description.
4. After the current task is completed, cancelled, or otherwise no longer being worked, identify the durable profile cause: `soul`, `bio`, `skills`, `subagents`, handoff targets, or `model`.
5. Write an updated `Agent` YAML using the same `metadata.name` username. Do not include or change `runtime`.
6. Apply it with `ak apply -f <file>`; this updates `latest` for future task sessions and snapshots the previous profile when changed.
7. Verify with `ak describe agent <username> --version latest` and `ak get agent <username>`.
8. If the task was cancelled and still needs to be done, recreate it with the original goal plus the review findings, and assign it to the updated worker.

Use cancel-and-recreate instead of repeated rejection when the current task has accumulated the wrong branch direction, wrong architecture, wrong model behavior, or review feedback so broad that continuing the same attempt would preserve bad context. Update the profile after ending the current attempt, then use the updated profile for the next task session.

```bash
gh pr close <pr-number> --repo <owner>/<repo> --delete-branch
ak task cancel <task-id>
ak apply -f agent.yaml
ak describe agent <username> --version latest
ak create task --board <board-id> --title "..." --description "..." --repo <repo-id> --assign-to <agent-id>
```

## Runtime Failure Handling

If an assignment fails because the runtime is unavailable, refresh agent data and choose again:

```bash
ak get agent -o json
```

If the desired role is unavailable, create a replacement worker on an available runtime and assign to it.
