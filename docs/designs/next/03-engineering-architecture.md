# v2 engineering architecture

Status: implemented

## Ownership boundary

- Realmroot authenticates humans and Agents and provides Toolbox.
- Realmroot Remote owns Agent execution and attaches verified runtime Session
  provenance to Agent credentials.
- Agency owns Agent, Machine, Environment, Runner, and Session resources.
- AK owns Boards, Repositories, Tasks, Notes, lifecycle resources, review
  policy, and the public representation of live Agent and Machine projections.

AK does not persist Agent/Machine entities, dispatch Sessions, compute
scheduling, close Sessions, or reconcile Agency runtime state. Agent
create/update/archive operations and Agent/Machine reads cross one explicit
Agency adapter boundary.

## Repository shape

```text
src/
  components/ui/       shared presentation primitives
  features/            auth, boards, repositories, and tasks
  lib/                 narrow browser infrastructure
server/
  domain/              pure product rules
  usecases/            application orchestration and ports
  adapters/            D1, Agency, GitHub, email, and streaming boundaries
  auth/                Realmroot credential normalization
  db/                  D1 primitives
  http/                Hono routes, middleware, and OpenAPI composition
  observability/       structured logging
  worker/              Cloudflare entry
shared/                cross-boundary wire types
migrations/            D1 history
spec/                  executable BDD-lite product specification
tests/                 scenario proofs by layer
```

There is one root package and TypeScript project. There are no pnpm workspaces,
nested package manifests, `apps/`, `packages/`, video app, CLI, or local runtime
daemon.

## Dependency direction

```text
http + adapters -> usecases -> domain
worker          -> http composition
React features  -> browser lib + shared wire contract
```

Domain and use cases do not import Hono, React, D1, Cloudflare bindings, or
Realmroot/Agency transport models. External failures remain explicit at their
adapter or HTTP boundary.

## Task execution flow

```text
Task created (todo)
  -> Agent discovery through the Agency projection
  -> Caller selects the Agent's published Realmroot subject
  -> Assignment stores that subject directly (todo + assigned actor)
  -> Remote starts/hosts the Agent independently
  -> assigned Agent Claim with signed runtime/session binding (in_progress)
  -> Review Submission (in_review)
  -> Rejection (in_progress) or Completion (done)
```

Assignment has no dispatch side effect. Rejection, completion, cancellation,
and release have no Session message or close side effect.

## Session observation

Task Claim stores Remote's verified `runtime` and `session_id` in a dedicated
binding row. A Task may expose that value object for the board, but clients
cannot write it.

The observation adapter treats the signed `session_id` as the canonical Agency
Session ID. It uses the current caller's delegated Agency authority and the
tenant's mapped Agency Project to read the standard Session resource, verifies
the returned identity and Project, and relays its event socket read-only. Agency
does not contain an AK-specific client, configuration, endpoint, query, or
authorization branch.
The relay accepts only history-backfill requests; it never guesses by Agent,
accepts a browser-provided URL, forwards runtime commands, or falls back to a
stored AK runtime.

## Legacy data

V1 Agent, Machine, Session, runtime, mailbox, and maintainer tables may remain
in migration history and storage. V2 has no repository or business consumer for
them. The v1-to-v2 upgrade is a separate deliverable and must require every old
Task to be terminal before cutover.
