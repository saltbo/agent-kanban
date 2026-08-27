# Agent Kanban v2

Agent Kanban is the task-coordination layer for Realmroot Agents executed by AMA. It owns boards, repositories, tasks, dependencies, memberships, assignments, runs, progress, messages, submissions, and reviews. It does not create Agents, store their keys, select runtimes, or operate runners.

AK stores the selected AMA `agentId` on BoardMembership and TaskAssignment resources. AMA remains the source of truth for the Agent's Realmroot identity, profile, Vault state, runtime placement, and Sessions; AK never stores or accepts Realmroot identity fields as assignment identifiers.

## Interfaces

- Humans use the complete browser workspace. Board, task, repository, membership, assignment, and review operations call AK; Agent and Machine pages call AMA directly without copying AMA resources into AK.
- Agents use `realmroot toolbox agent-kanban`, generated from the live OpenAPI document.
- Self-hosted execution uses `ama-runner`. The retired `ak` CLI and `ak start` are not part of v2.

The Resource Server is published at `/api`, RFC 9728 metadata at `/.well-known/oauth-protected-resource`, OpenAPI at `/api/openapi.json`, and Agent Skills discovery at `/.well-known/agent-skills/index.json`. Resource operations require `API-Version: 2026-08-22`; POST creation requires `Idempotency-Key`; mutable resources use `ETag` and `If-Match`.

## Authentication and service calls

The browser is a Realmroot public Application using Authorization Code with PKCE. It requests consent for the AK and AMA Resources, keeps tokens in session storage, and sends only the token whose exact audience matches the called Resource Server. AK has no Web Session, auth cookie, AMA user grant, or secondary authorization header.

AK's scheduled dispatch and server-side AMA validation use an AK Machine Application with the client-credentials grant. Configure its client ID and secret as `AK_SERVICE_CLIENT_ID` and `AK_SERVICE_CLIENT_SECRET`; grant `agents:read environments:read projects:read runners:read sessions:read sessions:write`; and add that client ID to AMA's trusted bearer clients. The browser Application must likewise be registered for both Resource scope sets and listed as an AMA trusted bearer client. DPoP is required only for Realmroot Agent tokens; human and Machine Application Resource tokens use Bearer.

## Development

```sh
pnpm install
pnpm --filter @agent-kanban/web db:migrate
pnpm dev
```

Verification:

```sh
pnpm typecheck
pnpm build
npx vitest run
```

The v1 implementation and migrations are retained as unmounted historical source under `apps/web/server-v1` and `apps/web/migrations-v1`. They are not compiled, routed, documented, or deployed.
