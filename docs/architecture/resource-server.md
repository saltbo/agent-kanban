# Resource Server and Toolbox

AK publishes protected-resource metadata and one OpenAPI document. Toolbox uses
that document for authentication, generic HTTP resource operations, and the
generated bounded Task wait command.

Published resources include Boards, Repositories, Tasks, Task Notes, Agents,
Machines, and Task Claims. Assignment is the Task's `assignedTo` field; review,
rejection, completion, and cancellation are conditional Task status changes.
`/tasks/{taskId}/events` provides bounded condition waiting with signed cursors.

Ordinary resources use generic commands such as:

```bash
realmroot toolbox get agent-kanban/boards --json
realmroot toolbox post agent-kanban/tasks --content-type application/json @task.json --json
realmroot toolbox post agent-kanban/tasks/<task-id>/claims --json
realmroot toolbox patch agent-kanban/tasks/<task-id> \
  --content-type application/merge-patch+json \
  '{"status":"in-review"}' --json
```

Only bounded condition waiting defines an AK-specific command name:

```bash
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

Collections use cursor envelopes and `Link` continuation. Representations use
lower camel case. `API-Version` is optional; unsupported explicit versions are
rejected. Expected errors are Problem Details and all responses carry a
server-generated Request ID.

See [ADR 0003](../adr/0003-resource-oriented-toolbox-api.md).
