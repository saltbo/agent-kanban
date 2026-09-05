---
name: agent-kanban
description: Work on an assigned Agent Kanban v2 Task through Realmroot Toolbox. Use when an Agent running in an Agency Session needs to inspect, claim, update, or submit assigned work.
---

# Agent Kanban v2 assigned Agent

Use the Realmroot identity already attached to the Agency Agent. Never run the
removed `ak` CLI or create AK credentials, Machines, runtime Sessions, mailbox
state, signing keys, or Agent roles.

## Task lifecycle

1. Read the Task with the generic Toolbox resource operation:

   ```bash
   realmroot toolbox get agent-kanban/tasks/<task-id> --include --json
   ```

   Treat the returned representation as authoritative. Task PATCH operations
   perform their own optimistic concurrency check; if one returns `409`, reread
   the Task before deciding whether to retry.

2. Claim it before changing the target repository:

   ```bash
   realmroot toolbox post agent-kanban/tasks/<task-id>/claims --json
   ```

   If the claim is rejected, stop without modifying the repository. Only the
   verified Realmroot Agent actor currently assigned to the Task can claim it.

3. Record useful progress as Task Note resources:

   ```bash
   realmroot toolbox post agent-kanban/tasks/<task-id>/notes \
     --content-type application/json \
     '{"detail":"Implemented the parser and verified malformed input."}' --json
   ```

   Realmroot Toolbox v0.5.0 or newer generates the required idempotency key and
   reuses it across transient retries of this invocation. Supply an explicit
   `Idempotency-Key` only when recovering with the known key from an earlier
   invocation whose outcome remained unknown.

4. Perform the work and run the smallest checks that prove the changed
   behavior and boundaries. Put repository work on a reviewable branch. For
   authenticated GitHub commands use Realmroot's GitHub Resource, for example
   `realmroot exec github -- git push` or `realmroot exec github -- gh ...`.

5. Post a final note containing the outcome, exact checks, and any remaining
   blocker, then submit the Task for review:

   ```bash
   realmroot toolbox get agent-kanban/tasks/<task-id> --include --json
   realmroot toolbox patch agent-kanban/tasks/<task-id> \
     --content-type application/merge-patch+json \
     '{"status":"in-review","pullRequestUrl":"https://github.com/owner/repo/pull/123"}' --json
   ```

   Submit an explicit empty representation when the Task has no pull request:

   ```bash
   realmroot toolbox patch agent-kanban/tasks/<task-id> \
     --content-type application/merge-patch+json \
     '{"status":"in-review"}' --json
   ```

Before an Agency work Session stops, its claimed Task must be submitted for
review. If work cannot continue, explain the blocker in the final Task Note and
submit the current state; do not leave an inactive Session represented as
`in_progress`.

## Published commands

Use Toolbox's generic verb-first operations for AK resources:

```bash
realmroot toolbox get agent-kanban/tasks/<task-id> --json
realmroot toolbox get agent-kanban/tasks/<task-id>/notes --json
realmroot toolbox post agent-kanban/tasks/<task-id>/notes \
  --content-type application/json @note.json --json
realmroot toolbox post agent-kanban/tasks/<task-id>/claims --json
realmroot toolbox patch agent-kanban/tasks/<task-id> \
  --content-type application/merge-patch+json \
  '{"status":"in-review"}' --json
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

`task wait` is the only AK-generated resource-first convenience command. Do
not use the removed `task claim`, `task release`, `task review`, `task reject`,
`task complete`, or `task cancel` aliases.

If Toolbox still displays those removed aliases after the server contract is
deployed, refresh its cached operation inventory once:

```bash
realmroot toolbox sync agent-kanban
```

If a generated command's request shape is unclear, inspect the contract instead
of guessing flags:

```bash
realmroot toolbox patch agent-kanban/tasks/<task-id> --generate-body
```

Assignment starts an Enbor Session directly. Its initial prompt supplies the
Task ID and exact AK Context ID. Use that Context for every Toolbox operation,
then read the Task before acting. Claim the Task using your own attached Agent
identity; never write or guess a Session ID. AK's Session annotation records the
creation receipt, while Claim records the verified execution identity.

Review rejection sends feedback to the same Session. Reread the Task and Notes,
continue under the existing Claim, and submit a new review when finished.
Completion and cancellation close the associated Session. Inbox messages are
not the startup or continuation mechanism.

For historical business references with a personal Owner ID encoded as
`user:<subject-id>`, the Context ID is `<subject-id>`; use an organization Owner
ID unchanged. Delayed scheduling is not implemented.

## Failure handling

- `401` or invalid DPoP: Realmroot authority is unavailable; do not create a
  fallback credential.
- `403`: the verified actor or grant lacks the required authority; changing a
  request body cannot grant it.
- `409`: reread the affected resource and decide from its current state; do not
  replay a conflicting transition blindly.
- `412`: a conditional delete used a stale resource ETag; reread before deciding
  whether deletion remains appropriate.
- `429` or `503`: honor `Retry-After`. After an unknown Task PATCH outcome,
  reread its current representation before deciding whether to retry. Claim
  creation is idempotency-key protected.
