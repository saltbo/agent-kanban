# Resource Server and Toolbox

AK publishes protected-resource metadata and one OpenAPI document. Toolbox uses
that document for authentication, generic HTTP operations, and generated
resource-first Task lifecycle commands.

Published resources include Boards, Repositories, Tasks, Task Notes, Agents,
Machines, and singleton Task Assignment, Claim, Review Submission, Review
Rejection, Review Completion, and Cancellation resources. `/task-events`
provides bounded condition waiting with signed cursors.

Ordinary resources use generic commands such as:

```bash
realmroot toolbox get agent-kanban/boards --json
realmroot toolbox post agent-kanban/tasks --content-type application/json @task.json --json
```

Only lifecycle resources define AK-specific names such as:

```bash
realmroot toolbox agent-kanban task claim <task-id> --json
realmroot toolbox agent-kanban task review <task-id> '{}' --json
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

Collections use cursor envelopes and `Link` continuation. Representations use
lower camel case. `API-Version` is optional; unsupported explicit versions are
rejected. Expected errors are Problem Details and all responses carry a
server-generated Request ID.

See [ADR 0003](../adr/0003-resource-oriented-toolbox-api.md).
