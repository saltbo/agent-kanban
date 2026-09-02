---
name: ak-task
description: Create, assign, monitor, and review one Agent Kanban v2 Task through Realmroot Toolbox. Use only when the user explicitly asks for an AK Task, Agent Kanban task delegation, or execution through an AK board.
---

# AK Task v2

Operate AK as a Realmroot Resource Server. There are no Agent role classes or
board maintainer role: Realmroot grants authorize management operations, Task
Assignment identifies the assigned Agent, and any authorized human or Agent
may review a Task assigned to someone else. An Agent cannot reject or complete
its own assigned Task.

## Before creation

Use generic Toolbox reads to resolve the Board, Repository, and existing Tasks:

```bash
realmroot toolbox get agent-kanban/boards --json
realmroot toolbox get agent-kanban/repositories --json
realmroot toolbox get 'agent-kanban/tasks?boardId=<board-id>' --json
```

Discover assignment candidates through AK's Agency-backed Agent projection:

```bash
realmroot toolbox get 'agent-kanban/agents?schedulable=true' --json
```

Use the selected Agent's `subject` as the Assignment actor ID; never use its
AK projection ID or an Agency object ID. If no suitable Agent exists and the
caller is authorized to provision one, create it through AK's generic
`/agents` collection operation. AK orchestrates the upstream Identity and
Agent creation; execution remains owned by Realmroot Remote and Agency.

Resolve material ambiguity and show the user the exact Task preview before
creating it. The preview must include title, Board, Repository, assignee,
description, dependencies, and acceptance checks.

## Create and assign

Create an unassigned Task with the generic collection operation, then create
its singleton Assignment. Do not put identity fields or an assignee into the
Task representation.

```bash
realmroot toolbox post agent-kanban/tasks \
  --content-type application/json \
  @task.json --json

realmroot toolbox put agent-kanban/task-assignments/<task-id> \
  --content-type application/json \
  '{"agentActorId":"<realmroot-agent-actor-id>"}' --json
```

Realmroot Toolbox v0.5.0 or newer generates the required idempotency key and
reuses it across transient retries of this invocation. Supply an explicit
`Idempotency-Key` only when recovering with the known key from an earlier
invocation whose outcome remained unknown.

The Task body uses lowerCamelCase resource fields such as `boardId`, `title`,
`description`, `repositoryId`, `labels`, `dependsOn`, `createdFrom`, and
`scheduledAt`. Assignment records intent only; Remote owns starting and
hosting the Agent. Retry the same Assignment after an unknown outcome; do not
create another Task or Assignment.

## Monitor

Use bounded `task wait` calls and carry the returned cursor into the next call.
Do not build an unbounded polling loop.

```bash
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

Inspect the Task and Notes after each meaningful state change with generic GET
operations. A cancelled Task is terminal.

## Review

When the Task reaches `in_review`, verify the submitted work and read the
current Review Submission resource. Use its unquoted response `ETag` as the
decision representation's `reviewSubmissionVersion`:

```bash
realmroot toolbox get agent-kanban/task-review-submissions/<task-id> --json

realmroot toolbox agent-kanban task reject <task-id> \
  '{"reviewSubmissionVersion":"<version>","reason":"Describe the required correction"}' --json

realmroot toolbox agent-kanban task complete <task-id> \
  '{"reviewSubmissionVersion":"<version>"}' --json
```

Reject when acceptance evidence or implementation is insufficient, then wait
for a new Review Submission and use its new `ETag`. Complete only after the
requested outcome is proven. If the verified reviewer actor equals the Task's
`assigned_to`, do not attempt either decision; another authorized principal
must review.

Use generic verb-first Toolbox operations for all ordinary CRUD. Use
resource-first syntax only for the published lifecycle commands (`task claim`,
`release`, `review`, `reject`, `complete`, `cancel`, and `wait`). Never invoke
the removed `ak` CLI.
