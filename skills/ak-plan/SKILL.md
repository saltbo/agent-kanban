---
name: ak-plan
description: Plan and execute a multi-Task project through Agent Kanban v2 resources and Realmroot Toolbox. Use only when the user explicitly asks for AK Plan, an Agent Kanban project plan, or execution of a project through an AK board.
---

# AK Plan v2

Model the project as Boards, Tasks, dependencies, Repositories, Assignments,
Review Submissions, and Review Decisions. Realmroot grants provide authority;
there are no Agent role classes, maintainer, mailbox, handoff-routing, or
AK-owned Agent/Machine runtime entities. AK exposes Agency-backed Agent and
Machine projections as product resources.

## Plan before creating

Read the repository and existing AK resources before decomposition:

```bash
realmroot toolbox get agent-kanban/boards --json
realmroot toolbox get agent-kanban/repositories --json
realmroot toolbox get 'agent-kanban/tasks?boardId=<board-id>' --json
```

Define the architecture direction, shared contracts, ownership boundaries, and
dependency graph. Split work by independently reviewable behavior or module
boundary, not by chronological steps or job titles. Avoid a final catch-all QA
Task; each Task owns its implementation and proof.

Show the user the complete Board/Task preview and get confirmation before any
creation. Include every Task's goal, assignee, repository, dependencies, and
acceptance checks.

## Create resources

Use Toolbox's generic verb-first operations. Create a Board or Repository only
when it does not already exist:

```bash
realmroot toolbox post agent-kanban/boards --content-type application/json @board.json --json
realmroot toolbox post agent-kanban/repositories --content-type application/json @repository.json --json
```

Discover executable Agents through AK's Agency-backed projection and select
only an Agent that currently reports `schedulable: true`:

```bash
realmroot toolbox get 'agent-kanban/agents?schedulable=true' --json
```

Use the selected Agent's `subject` as the Assignment actor ID. If no suitable
Agent exists and the caller is authorized to provision one, create it through
AK's generic `/agents` collection operation; AK owns the Identity-plus-Agent
orchestration. Do not call Agency directly or create an AK-local Agent row.

For each approved work item, create an unassigned Task, then its Assignment:

```bash
realmroot toolbox post agent-kanban/tasks --content-type application/json @task.json --json
realmroot toolbox put agent-kanban/task-assignments/<task-id> \
  --content-type application/json \
  '{"agentActorId":"<realmroot-agent-actor-id>"}' --json
```

Realmroot Toolbox v0.5.0 or newer generates the required idempotency key and
reuses it across transient retries of this invocation. Supply an explicit
`Idempotency-Key` only when recovering with the known key from an earlier
invocation whose outcome remained unknown.

Encode real prerequisites in `dependsOn`. Tasks with overlapping files or
contracts should be combined or ordered; only independent Tasks should run in
parallel. Do not create AK-local Agent, Machine, Session, or subagent rows.

## Execute and review

After creation, continue until every Task is terminal unless the user asks to
stop. Use bounded waits with continuation cursors:

```bash
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

As Tasks reach review, follow the review procedure in the installed `ak-task`
skill: read the current Review Submission and its `ETag`, verify the work, then
reject or complete from a different verified actor. A rejection creates another
work iteration and a later Review Submission with a new `ETag`.

When one prerequisite completes, continue monitoring its dependents. Remote
owns Agent execution; AK only exposes the updated dependency and Task state.
Report the final Task states, review outcomes, and unresolved external blockers.

Ordinary published resource operations use generic verbs. Toolbox generates
the required idempotency key for Task, Task Note, Agent, and Machine creation
and reuses it across transient retries. Board and Repository creation do not
require the header. Board labels and destructive management remain
browser-owned in this release.
Only AK lifecycle operations use the generated resource-first `task ...`
commands. Never invoke the removed `ak` CLI or invent resource-first CRUD
aliases.
