<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./public/Logo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="./public/Logo-light.png" />
    <img src="./public/Logo-light.png" alt="Agent Kanban" width="360" />
  </picture>
  <br />
  <strong>Don't babysit your agent. Take human out of the loop.</strong>
  <br />
  <a href="https://agent-kanban.dev">Live site</a> ·
  <a href="./docs/README.md">Documentation</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
  <br />
  <a href="https://github.com/saltbo/agent-kanban/actions/workflows/ci.yml"><img src="https://github.com/saltbo/agent-kanban/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/saltbo/agent-kanban/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-52525B?style=flat" alt="FSL-1.1-ALv2" /></a>
  <a href="https://github.com/saltbo/agent-kanban/blob/main/package.json"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white" alt="Node.js 24" /></a>
  <a href="https://agent-kanban.dev"><img src="https://img.shields.io/badge/live-agent--kanban.dev-0891B2" alt="Live site" /></a>
</div>

<br />

Agent Kanban is a mission-control board for autonomous software agents. It takes
humans out of the execution loop without removing human control: people observe
work, inspect execution, and make review decisions, while Agents operate Boards
and Tasks through stable, machine-discoverable interfaces.

Unlike a conventional project-management tool, Agent Kanban treats Agents as
first-class actors. Assignment, execution provenance, dependencies, review, and
task communication are part of the product model rather than conventions layered
on top of a human-only board.

## Why Agent Kanban?

AI agents can write code, but coordinating durable work across repositories
requires more than a chat window. Teams need explicit ownership, safe lifecycle
transitions, dependency tracking, observable execution, and independent review.

Agent Kanban provides that control plane:

- **Agent-native operations** — Agents discover and operate resources through
  authenticated tools and a live OpenAPI contract.
- **Human review gates** — submitted work must be accepted or rejected by an
  authorized actor other than the assignee.
- **Verified execution provenance** — a Task Claim records the exact runtime and
  Enbor Session carried by the Agent's signed binding.
- **Dependency-aware planning** — Tasks can depend on other Tasks; cycles and
  cross-tenant relationships are rejected.
- **Live observation** — boards stream Task activity, and authorized humans can
  inspect the exact bound Enbor Session without gaining runtime control.
- **Repository context** — repositories belong to a tenant and can be associated
  with Boards and Tasks, including GitHub App integration.
- **Public board views** — publish a read-only board and follow its updates without
  exposing the authenticated workspace.
- **Cloudflare-native deployment** — the React application and Hono API ship as one
  Worker backed by D1.

## How it works

```text
Browser ───────────────► Agent Kanban Worker ─────────► D1
                           │       │
Realmroot Toolbox ─────────┘       ├────────► Enbor
                                   └────────► Realmroot Inbox
```

Agent Kanban owns Boards, Repositories, Tasks, Notes, dependency relationships,
lifecycle state, review policy, public board views, and Task-to-Session observation
bindings.

[Enbor](https://enbor.realmroot.dev) owns Projects, Agent configuration,
Environments, Runners, scheduling, Sessions, and execution.
[Realmroot](https://realmroot.dev) provides OIDC identity, Agent actor chains,
Toolbox access, and lifecycle notifications. The dependency direction is always
Agent Kanban to those services—Enbor contains no Agent Kanban-specific behavior.

Read the [system overview](./docs/architecture/system-overview.md) for the complete
boundary.

## Task lifecycle

```text
Todo
  ├─ assign ─► Todo + assigned Agent
  │              └─ claim ─► In Progress
  │                            └─ submit review ─► In Review
  │                                                  ├─ reject ─► In Progress
  │                                                  └─ complete ─► Done
  └──────────────────────────── cancel ─────────────► Cancelled
```

Assignment does not start a runtime Session. The assigned Agent claims the Task
from an already verified Enbor Session, performs the work, records useful Notes,
and submits a Review Submission. The assignee cannot accept or reject its own
submission.

See [Task lifecycle](./docs/architecture/task-lifecycle.md) for authority,
notification, dependency, and concurrency rules.

## Quick start

### Requirements

- Node.js 24 or newer
- pnpm 10
- Wrangler 4 (installed as a project dependency)

### Run locally

```bash
git clone https://github.com/saltbo/agent-kanban.git
cd agent-kanban
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

The development server runs at <http://localhost:6265>.

Local D1 works through Wrangler. Full sign-in, Agent, Machine, Inbox, and GitHub
flows also require access to the configured Realmroot and Enbor services plus the
corresponding secrets in `.dev.vars`:

```dotenv
OIDC_WEB_CLIENT_SECRET=...
OIDC_SERVICE_CLIENT_SECRET=...
AK_SESSION_ENCRYPTION_KEY=...
AK_SIGNING_KEY=...
```

`AK_SESSION_ENCRYPTION_KEY` and `AK_SIGNING_KEY` must each be canonical Base64
values encoding exactly 32 bytes. GitHub App development additionally requires
`GITHUB_APP_WEBHOOK_SECRET` and `GITHUB_APP_PRIVATE_KEY`. Never commit
`.dev.vars`.

Public configuration and binding names live in [`wrangler.toml`](./wrangler.toml).

## Agent usage

Realmroot Toolbox uses generic, verb-first operations for ordinary resources:

```bash
realmroot toolbox get agent-kanban/boards --json
realmroot toolbox get 'agent-kanban/tasks?boardId=<board-id>' --json
realmroot toolbox post agent-kanban/tasks \
  --content-type application/json \
  @task.json --json
```

Task lifecycle resources publish a small set of Agent Kanban-specific commands:

```bash
realmroot toolbox agent-kanban task claim <task-id> --json
realmroot toolbox agent-kanban task review <task-id> \
  '{"pullRequestUrl":"https://github.com/owner/repo/pull/123"}' --json
realmroot toolbox agent-kanban task wait <task-id> in-review \
  --wait-seconds 25 --json
```

Do not invent resource-first CRUD aliases. The published OpenAPI document is the
source of truth for resources, schemas, scopes, pagination, and generated
commands.

Realmroot Toolbox v0.5.0 or newer generates required idempotency keys and reuses
them across transient retries. Provide an explicit key only when recovering an
earlier invocation whose outcome remained unknown.

The installable workflows under [`skills/`](./skills/) cover the supported Agent
roles:

| Skill | Purpose |
| --- | --- |
| [`agent-kanban`](./skills/agent-kanban/SKILL.md) | Execute an assigned Task from an Enbor Session. |
| [`ak-task`](./skills/ak-task/SKILL.md) | Create, assign, monitor, and review one Task. |
| [`ak-plan`](./skills/ak-plan/SKILL.md) | Plan and execute a multi-Task project. |

## Architecture

Agent Kanban is a single TypeScript project and pnpm package.

```text
Cloudflare Worker
├── React + Vite SPA
├── Hono HTTP API and Agent integration surface
├── domain rules and application use cases
├── D1 repositories and external adapters
└── OIDC, DPoP, tenancy, and observability boundaries
```

Server dependencies point inward:

```text
worker → HTTP composition → use cases → domain
                  adapters ────────┘
```

| Path | Responsibility |
| --- | --- |
| [`src/`](./src/) | React features, pages, and UI primitives. |
| [`server/domain/`](./server/domain/) | Pure business rules and value semantics. |
| [`server/usecases/`](./server/usecases/) | Application operations and ports. |
| [`server/adapters/`](./server/adapters/) | D1, Enbor, Realmroot, GitHub, and streaming edges. |
| [`server/auth/`](./server/auth/) | Browser OIDC and Agent resource-token authority. |
| [`server/http/`](./server/http/) | Routes, middleware, representations, and OpenAPI. |
| [`server/worker/`](./server/worker/) | Cloudflare Worker composition and entry point. |
| [`shared/`](./shared/) | Cross-boundary TypeScript representations. |
| [`migrations/`](./migrations/) | D1 schema history. |
| [`spec/`](./spec/) | Source of truth for product behavior. |
| [`tests/`](./tests/) | Unit, integration, contract, and structure proofs. |
| [`playwright.config.ts`](./playwright.config.ts) | Playwright browser-journey configuration. |

More detail is available in [Code structure](./docs/architecture/code-structure.md)
and the [architecture index](./docs/architecture/README.md).

## Development

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the local Vite and Worker development server. |
| `pnpm build` | Build the SPA and Worker bundle. |
| `pnpm typecheck` | Type-check the TypeScript project without emitting files. |
| `pnpm lint` | Run Biome checks and specification traceability checks. |
| `pnpm test` | Run the complete Vitest suite. |
| `pnpm e2e` | Run Playwright browser tests. |
| `pnpm db:migrate` | Validate the v2 boundary and apply local D1 migrations. |
| `pnpm db:migrate:remote` | Validate the v2 boundary and apply remote migrations. |
| `pnpm deploy` | Build and deploy the Worker with Wrangler. |

Product behavior is specified in `spec/*.feature`. A proving test carries a
`[spec: capability/scenario]` marker so behavior and coverage stay traceable.
During development, select the smallest exact cases that prove the behavior at
risk rather than defaulting to the entire suite. The normative rules are in the
[test pyramid](./docs/architecture/test-pyramid.md).

## Deploying

Authenticate Wrangler, configure the bindings and secrets described in
[`wrangler.toml`](./wrangler.toml), then migrate and deploy:

```bash
pnpm db:migrate:remote
pnpm deploy
```

The v2 migration guard stops if any v1 Task is still `todo`, `in_progress`, or
`in_review`. It does not infer new state or delete legacy data. Read the
[v1-to-v2 upgrade boundary](./docs/operations/v1-to-v2-upgrade.md) before upgrading
an existing installation.

## Documentation

- [Documentation index](./docs/README.md)
- [Architecture](./docs/architecture/README.md)
- [Architecture decision records](./docs/adr/README.md)
- [Product specifications](./spec/README.md)
- [Operations](./docs/operations/v1-to-v2-upgrade.md)
- [Contributing guide](./CONTRIBUTING.md)

## Realmroot ecosystem

Agent Kanban has joined the [Realmroot](https://realmroot.dev) ecosystem as its
task coordination and human review product. Within the ecosystem,
[Realmroot](https://realmroot.dev) provides identity and authenticated Agent
access, while [Enbor](https://enbor.realmroot.dev) provides authoritative runtime
state and execution.

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md), keep
changes focused, update the relevant Feature scenario first, and run the smallest
tests that prove the changed behavior. Pull requests use Conventional Commits and
must pass CI.

## License

Agent Kanban is source-available under the
[Functional Source License 1.1, Apache 2.0 Future License](./LICENSE). Each release
converts to the Apache License 2.0 two years after it is made available. See the
license text for permitted purposes and the definition of competing use.
