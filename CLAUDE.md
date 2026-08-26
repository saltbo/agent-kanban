# Agent Kanban v2

Agent-first task coordination. React observation/review SPA + Hono Resource Server on Cloudflare Workers + D1.

## Architecture

- Monorepo managed by pnpm.
- Production frontend: `apps/web/src`.
- Production backend: `apps/web/server`; Worker composition root: `apps/web/worker/index.ts`.
- v2 migrations: `apps/web/migrations` and a fresh D1 database.
- `apps/web/server-v1`, `apps/web/migrations-v1`, `apps/web/src-v1`, `packages/cli-v1`, `packages/shared-v1`, and `skills-v1` are unmounted historical source. Never import, compile, route, document, deploy, publish, or run them.
- AK owns Board/Task coordination state. AMA owns Agents, Profiles, Vault state, runtime placement, runners, and Sessions. Realmroot owns stable identity and authorization. Dependency direction is `AK → AMA → Realmroot`.
- AK persists AMA `agentId` on memberships and assignments, never Realmroot identity fields, runtime definitions, Agent keys, or Vault references.
- There is no AK CLI, daemon, `ak start`, Machine, TunnelRelay, local Agent JWT, leader/worker identity kind, or runtime catalog. Agents use `realmroot toolbox agent-kanban`; self-hosted execution uses `ama-runner`.

## Product and UI

Read `DESIGN.md` before visual work. The AK browser is a complete product workspace: Board/Task/Repository coordination is AK-owned; Agents and Machines remain first-class pages backed by AMA through connection-scoped browser BFF projections. Forms live in a modal, drawer, or secondary page. AK never persists AMA Agent, Environment, Runner, runtime, Session, Vault, or credential definitions.

## API

- Resource-only paths; no action routes.
- Required `API-Version: 2026-08-22` on protected operations.
- RFC 9457 Problem Details, opaque cursor pagination, `Request-Id`, W3C trace propagation, POST `Idempotency-Key`, and conditional `ETag`/`If-Match` writes.
- Realmroot native Resource Server with exact issuer/audience, fine-grained scopes, DPoP proof/replay validation, and stable Agent actor preservation.
- OpenAPI at `/api/openapi.json` is the only Toolbox source. RFC 9728 metadata and Agent Skills discovery are public. The only published skill source is `skills/agent-kanban/SKILL.md`.
- D1 access stays behind repository/domain helpers; tenant, resource ownership, lifecycle, and Agent assignment checks are mandatory.
- The scheduled Worker only dispatches/reconciles the v2 AMA outbox. AK creates Sessions through AMA's generic `agentId + volumes` API and AMA remains the Session status source.

## Verification and ownership

The main implementation agent modifies production source only. Test agents own `*.test.ts`, `*.spec.ts`, and black-box smoke tests.

After source changes:

1. Test agents add/update focused D1, contract, auth, AMA adapter, UI, and black-box tests.
2. Independent reviewers assess outcome and engineering; resolve blocking findings.
3. Run `pnpm typecheck`, `pnpm build`, Biome, OpenAPI/path audits, D1 migration drift, Vitest, Playwright, and the v2 black-box smoke.

Do not run the v1 daemon smoke. The v2 black-box smoke must cover metadata/OpenAPI/Skill discovery and the complete Organization/Board/Repository/Task/Membership/Assignment/Run/Progress/Submission/Review path against real HTTP, D1, and a contract-faithful local AMA boundary.
