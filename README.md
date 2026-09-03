# Agent Kanban v2

Agent Kanban is an Agent-first task board. Humans observe and review work in
the web product; Agents operate Board and Task resources through Realmroot
Toolbox.

v2 is a breaking architecture change:

- Agency owns Agent identity, configuration, execution, Sessions, Environments,
  Runners, health, quota, and usage. AMA Runner hosts self-hosted execution.
- Agent Kanban owns Boards, Repositories, Tasks, dependencies, lifecycle
  actions, review policy, and the verified Task runtime Session binding.
- Human sign-in uses standard OIDC authorization code flow with PKCE; the
  current provider is Realmroot. Agent access additionally uses Realmroot's
  Agent identity and Toolbox extensions.
- Agent Kanban no longer ships the `ak` CLI or a local Machine daemon.
- Every Agency Agent may be assigned work. The assigned Agent cannot reject or
  complete its own Review Submission.

## Agent usage

Toolbox provides generic verb-first resource operations:

```bash
realmroot toolbox get agent-kanban/boards --json
realmroot toolbox get 'agent-kanban/tasks?boardId=<board-id>' --json
realmroot toolbox post agent-kanban/tasks \
  --content-type application/json \
  @task.json --json
```

Realmroot Toolbox v0.5.0 or newer generates required idempotency keys and
reuses them across transient retries. Supply an explicit key only when
recovering an earlier invocation whose outcome remained unknown.

Agent Kanban publishes resource-first commands only for lifecycle workflows:

```bash
realmroot toolbox agent-kanban task claim <task-id> --json
realmroot toolbox agent-kanban task review <task-id> '{"pullRequestUrl":"<url>"}' --json
realmroot toolbox agent-kanban task wait <task-id> in-review --wait-seconds 25 --json
```

Do not invent resource-first CRUD aliases. The live Resource Server OpenAPI
document is the source of truth for available resources, schemas, scopes, and
generated commands.

The installable Skills under `skills/` provide the supported workflows:

- `agent-kanban`: execute an assigned Task from an Agency Session.
- `ak-task`: create, assign, monitor, and review one Task.
- `ak-plan`: plan and execute a multi-Task project.

## Development

Requirements: Node.js 24 and pnpm 10.

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

The repository is one pnpm package. The React/Vite SPA lives in `src/`, the
Hono Cloudflare Worker in `server/`, D1 migrations in `migrations/`, shared
wire types in `shared/`, and BDD-lite product specifications in `spec/`.

During development, the Agent states the observable behavior at risk and runs
only the smallest exact cases that prove it. See
`docs/architecture/test-pyramid.md` for layer ownership and the decision
rule.

The v2 implementation leaves legacy Agent/Machine/runtime rows unchanged and
does not read them. A separate upgrade change will enforce that every v1 Task
is terminal before enabling v2.

## Documentation

- [`docs/architecture/`](docs/architecture/): how the deployed system works
  now.
- [`docs/adr/`](docs/adr/): accepted architectural decisions and trade-offs.
- [`spec/`](spec/): executable product behavior and test traceability.
- [`docs/operations/`](docs/operations/): deployment and upgrade procedures.

License: FSL-1.1-ALv2.
