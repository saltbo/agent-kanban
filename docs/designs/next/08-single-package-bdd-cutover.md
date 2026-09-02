# v2 single-package and BDD cutover

Status: implemented

This decision replaces the workspace and Session-dispatch portions of
`03-engineering-architecture.md`. The restored, narrower
`04-agent-machine-projections.md` governs Agent/Machine product projections and
does not restore AK runtime ownership.

## Runtime boundary

Realmroot Remote starts and owns Agency Sessions. Agency remains authoritative
for Projects, Identities, Agents, Environments, Runners, and Sessions. AK
exposes Agent/Machine projections, translates Agent lifecycle operations and
Machine Environment lifecycle, but does not register Runners, dispatch
assignments, or close Sessions. Runner registration remains an AMA Runner
operation initiated from AK's Add Machine guidance.

When an Agency-hosted Agent invokes AK through Realmroot Toolbox, Remote adds the
signed `runtime` and `session_id` fields to the Realmroot Agent binding claim.
A successful Task Claim persists that exact runtime resume token from the
verified principal. AK never accepts a caller-authored socket URL or Session id
in the request body and never guesses the latest Session for an Agent.

The board resolves the exact Agency Session through the stored binding and an
authorized Agency Session collection query. AK exposes the Session and relays
its canonical event socket read-only. Only backfill requests cross from the
browser to Agency; runtime commands are rejected at the AK boundary.

## Target repository

```text
agent-kanban/
  src/                 React application and feature UI
  server/
    domain/            pure product rules
    usecases/          application orchestration and ports
    adapters/          D1, Agency observation, GitHub, and other boundaries
    auth/              Realmroot authentication and authorization
    db/                database primitives
    http/              Hono routes, contracts, and composition
    worker/            Cloudflare entry point
  shared/              wire and cross-boundary types
  migrations/          D1 schema history
  spec/                BDD-lite product specifications
  tests/               integration, contract, and small Playwright tests
  public/
```

There is one root `package.json`, one lockfile, one TypeScript project, and no
`pnpm-workspace.yaml`. `apps/web` moves to the repository root. `apps/video`,
the AK CLI, generated reports, duplicate backups, and retired runtime tooling
are deleted.

## Dependency direction

```text
http / adapters -> usecases -> domain
React features  -> shared client boundary
worker          -> http composition
```

Domain and use cases do not depend on Hono, D1, Cloudflare bindings, React,
environment variables, or Agency SDK transport models. Adapters convert external
data at their boundary and fail explicitly.

## BDD development rule

Every product behaviour starts or changes in `spec/*.feature`. Each scenario
has one stable id and one proof layer. The proving Vitest or Playwright test
contains `[spec: capability/scenario]`. Gherkin is not coupled to Cucumber;
`pnpm lint:spec` enforces traceability.

Tests follow `05-test-pyramid.md`: pure rules first, use cases second, real
adapter/HTTP contracts only where needed, component tests for UI behaviour,
and very few browser journeys. During development, run the exact changed cases,
not the full file or repository by default.

## Cutover sequence

1. Flatten the web app and shared code into the root package.
2. Establish `spec/` and traceability enforcement.
3. Remove local Agent/Machine persistence and Agency Session dispatch code;
   restore only the Agency-backed projections defined in document 04.
4. Add verified Remote execution context to Task Claim and persist its Session
   observation binding.
5. Keep the task-specific board work UI and connect the bounded, read-only
   Agency observation adapter.
6. Move retained backend modules into domain/usecase/adapter/http boundaries.
7. Delete obsolete tests and add scenario-owned tests at the cheapest layer.

The v1-to-v2 data upgrade remains a separate change. This implementation adds
no compatibility readers, migration workflow, or fallback runtime.
