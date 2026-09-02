---
name: ak-plan
description: Plan and execute a multi-Task project through Agent Kanban v2 resources and Realmroot Toolbox. Use only when the user explicitly asks for AK Plan, an Agent Kanban project plan, or execution of a project through an AK board.
---

# AK Plan v2

Model the project as Boards, Tasks, dependencies, Repositories, Assignments,
Review Submissions, and Review Decisions. Realmroot grants provide authority;
there are no Agent role classes, maintainer, mailbox, handoff-routing, or AK
Machine concepts.

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
realmroot toolbox post agent-kanban/boards --content-type application/json --header 'Idempotency-Key: <unique-board-key>' @board.json --json
realmroot toolbox post agent-kanban/repositories --content-type application/json --header 'Idempotency-Key: <unique-repository-key>' @repository.json --json
```

Resolve or create executable Agents through Realmroot Remote and Agency. AK
does not expose Agent resources. Use each selected Agent's stable Realmroot
actor ID for Assignment; if that workflow cannot provide one, report the
blocker instead of creating an AK-local Agent.

For each approved work item, create an unassigned Task, then its Assignment:

```bash
realmroot toolbox post agent-kanban/tasks --content-type application/json --header 'Idempotency-Key: <unique-task-key>' @task.json --json
realmroot toolbox put agent-kanban/task-assignments/<task-id> \
  --content-type application/json \
  '{"agentActorId":"<realmroot-agent-actor-id>"}' --json
```

Encode real prerequisites in `dependsOn`. Tasks with overlapping files or
contracts should be combined or ordered; only independent Tasks should run in
parallel. Do not create AK-local Agents, Machines, Sessions, or subagent
profiles.

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

Ordinary published resource operations use generic verbs. Every generic POST
requires a stable `Idempotency-Key`; reuse it only for an exact retry. Board
labels and destructive management remain browser-owned in this release.
Only AK lifecycle operations use the generated resource-first `task ...`
commands. Never invoke the removed `ak` CLI or invent resource-first CRUD
aliases.
