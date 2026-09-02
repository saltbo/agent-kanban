---
name: agent-kanban
description: Work on an assigned Agent Kanban v2 Task through Realmroot Toolbox. Use when a Remote-hosted Agent needs to inspect, claim, update, or submit assigned work.
user-invocable: false
---

# Agent Kanban v2 assigned Agent

Use the Realmroot identity already attached to the Agency Agent. Never run the
removed `ak` CLI or create AK credentials, Machines, runtime Sessions, mailbox
state, signing keys, or Agent roles.

## Task lifecycle

1. Read the Task with the generic Toolbox resource operation:

   ```bash
   realmroot toolbox get agent-kanban/tasks/<task-id> --json
   ```

2. Claim it before changing the target repository:

   ```bash
   realmroot toolbox agent-kanban task claim <task-id> --json
   ```

   If the claim is rejected, stop without modifying the repository. Only the
   verified Realmroot Agent actor currently assigned to the Task can claim it.

3. Record useful progress as Task Note resources:

   ```bash
   realmroot toolbox post agent-kanban/tasks/<task-id>/notes \
     --content-type application/json \
     --header 'Idempotency-Key: <unique-note-key>' \
     '{"detail":"Implemented the parser and verified malformed input."}' --json
   ```

4. Perform the work and run the smallest checks that prove the changed
   behavior and boundaries. Put repository work on a reviewable branch. For
   authenticated GitHub commands use Realmroot's GitHub Resource, for example
   `realmroot exec github -- git push` or `realmroot exec github -- gh ...`.

5. Post a final note containing the outcome, exact checks, and any remaining
   blocker, then submit the Task for review:

   ```bash
   realmroot toolbox agent-kanban task review <task-id> \
     '{"pullRequestUrl":"https://github.com/owner/repo/pull/123"}' --json
   ```

   Submit an explicit empty representation when the Task has no pull request:

   ```bash
   realmroot toolbox agent-kanban task review <task-id> '{}' --json
   ```

Before an Agency work Session stops, its claimed Task must be submitted for
review. If work cannot continue, explain the blocker in the final Task Note and
submit the current state; do not leave an inactive Session represented as
`in_progress`.

## Generic versus specialized commands

Use Toolbox's generic verb-first operations for ordinary resources:

```bash
realmroot toolbox get agent-kanban/tasks/<task-id> --json
realmroot toolbox get agent-kanban/tasks/<task-id>/notes --json
realmroot toolbox post agent-kanban/tasks/<task-id>/notes \
  --header 'Idempotency-Key: <unique-note-key>' \
  --content-type application/json @note.json --json
```

Use only the published resource-first commands for AK lifecycle workflows:

```bash
realmroot toolbox agent-kanban task claim <task-id> --json
realmroot toolbox agent-kanban task review <task-id> '{}' --json
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

Do not invent aliases such as `task get`, `task create`, or `agent create`.
Toolbox owns generic resource verbs; AK owns only the specialized commands
advertised by its live OpenAPI document.

If a generated command's request shape is unclear, inspect the contract instead
of guessing flags:

```bash
realmroot toolbox agent-kanban task review <task-id> --generate-body
```

Assignment, review rejection, completion, and cancellation arrive through
Inbox. Treat the message as a wake-up or state-change signal, then reread the
Task through Toolbox before acting; the Task resource is authoritative.
If the reread Task is `done` or `cancelled`, stop without adding Notes,
claiming, or submitting another Review Submission.

## Failure handling

- `401` or invalid DPoP: Realmroot authority is unavailable; do not create a
  fallback credential.
- `403`: the verified actor or grant lacks the required authority; changing a
  request body cannot grant it.
- `409` or `412`: reread the affected resource and decide from its current
  state; do not replay a stale transition blindly.
- `429` or `503`: honor `Retry-After`. Lifecycle `PUT` operations are
  idempotent, so retry the same intended resource state rather than creating a
  second workflow.
