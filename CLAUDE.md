# Agent Kanban

Agent-first kanban board. React SPA + Hono API on Cloudflare Workers + D1.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Architecture
- Single pnpm package; do not add workspaces or nested package manifests
- Frontend: `src/` — React + Vite + Tailwind + shadcn/ui
- Backend: `server/` — domain, use cases, adapters, auth, HTTP composition
- Worker entry: `server/worker/index.ts`
- Build: @cloudflare/vite-plugin — produces client assets + worker bundle
- Database: Cloudflare D1 (SQLite)
- Shared types: `shared/` — source in the same TypeScript project
- Agent skills use Realmroot Toolbox commands published by the AK Resource Server

## UI Principles
- **Read-only board** — the web UI is for observation and review, not task management
- **No task creation UI** — tasks are created by agents through Realmroot Toolbox
- **No status transition buttons** — no claim/cancel/release/assign in the UI
- **No drag-and-drop** — card ordering is managed by agents
- **Only two review actions in UI**: reject (send back to agent) and complete (accept) — can be performed by humans or lead agents via API
- Board switcher, task detail (logs, PR, chat), and Agent/Machine list/detail pages are the primary navigation interactions

## Patterns
- Data access: feature-owned repositories for v2 workflows. Legacy Agent,
  Machine, Session, Maintainer, mailbox, and runtime rows may remain stored but
  have no v2 repository or business-logic consumer; no raw SQL in route handlers
- Error handling: v2 Resource operations use RFC 9457 `application/problem+json`; browser-internal legacy routes retain the centralized `{ error: { code, message } }` envelope.
- Claim atomicity: db.batch() for race-condition-free task claims
- Auth: browser sign-in uses standard OIDC authorization code flow with PKCE and an opaque AK Session Cookie; Realmroot is the configured provider. Resource-token access uses Realmroot's Toolbox client profile with standard DPoP. Realmroot's Agent actor chain identifies Agent callers, its optional organization claim selects organization tenancy, and its runtime binding is required specifically for Task Claim. Business data is scoped by the normalized OIDC subject or Realmroot organization ID in `owner_id`.
- Agency owns Agent and Session execution and the authoritative Agent, Project, Environment, Runner, and Session resources. Enbor Runner hosts self-hosted execution. AK may hold a server-side Agency grant and translate Project, Agent, and Environment lifecycle for its public projections, but it stores no local Agent/Machine entity and never creates, messages, or closes Agency Sessions.
- The dependency direction is strictly AK to Agency. Agency must not contain AK-specific names, client configuration, routes, query parameters, authorization branches, fixtures, or compatibility behavior; AK owns every business-specific binding to generic Agency resources.
- Task lifecycle: Todo → Todo+assigned → In Progress (Agent Claim) → In Review (Review Submission) → Done (Review Completion) or Cancelled. Assignment does not dispatch runtime work. The assignee cannot complete or reject its own Review Submission.
- Task Claim stores the verified `runtime` and `session_id` carried by the Realmroot-issued Agent binding. Never accept a caller-authored Session id/socket URL or infer a latest Session by Agent.
- Task dependencies: `depends_on` JSON array, cycle detection via recursive CTE (taskDeps.ts), `blocked` computed on read
- Task origin: `created_from` for single-level subtask tracking
- SSE: TransformStream-based, 2s poll for 25s (CF Workers limit), Last-Event-ID resume via Task Note ID → timestamp resolution. Task streams emit Task Notes only.
- Agency is the source of truth for runtime work. The Realmroot-issued Agent binding supplies claim provenance; AK resolves that exact Session through Agency and relays Session events read-only without forwarding runtime commands.
- The v2 `ak` CLI is removed. Do not add new CLI commands or runtime behavior; expose Agent operations through the Resource Server and Realmroot Toolbox.
- v1-to-v2 data migration is a separate deliverable. Do not add compatibility
  readers, verifiers, cleanup ledgers, destructive cutover jobs, or legacy
  runtime fallbacks to the v2 application. The future upgrade must stop unless
  every v1 Task is `done` or `cancelled`.
- Data model: Board is the workspace unit. Repositories belong to owner (tenant-level). Tasks belong to boards, optionally linked to a repository.
- BDD source of truth: product behaviour lives in `spec/*.feature`; proving tests carry `[spec: capability/scenario]`.

## Post-Write Workflow
After every significant code change, follow this sequence:

1. **Test** — invoke test-writer agent to write/update unit/integration tests and run them.
   - If changes touch frontend components (`src/`), also invoke playwright-test-generator agent to create/update E2E tests, and playwright-test-healer to fix any broken existing E2E tests.
   - All behavior-selected cases pass → proceed to step 2.
   - FAILURES → you (main agent) read the failure, decide if the bug is in source code or test code.
     - Source bug → fix the source code, re-run tests yourself.
     - Test bug → state why the test is wrong, then forward to test-writer (unit) or playwright-test-healer (E2E) agent to fix.
   - After the behavior-selected cases pass, proceed to step 2.
2. **Review** — invoke clean-code-reviewer agent (reviews both source and test code).
   - REVISE on source code → you (main agent) fix, then re-run review.
   - REVISE on test code → forward issues to the appropriate test agent to fix.
   - PASS → proceed to step 3.

**Ownership rule**: you (main agent) only modify source code. Test code is owned by test agents — all test modifications go through them.
3. **Agent development verification** — follow `docs/architecture/test-pyramid.md`.
   Before running anything, identify the observable behavior changed and the
   smallest set of exact cases that proves it. Run only those cases. Do not
   default to a whole test file, package, layer, or repository suite.
   - Apply the same rule to static checks. Select the smallest command that
     covers the changed boundary; do not repeatedly run all checks while iterating.
   - Any failure → fix and re-run the failed or directly affected cases. If the
     fix touches source code, go back to step 1.
## Testing
- Framework: vitest (root `vitest.config.ts`)
- Normative layer and case-placement rules:
  `docs/architecture/test-pyramid.md`
- Default run: exact named cases selected from the changed behavior. Use an
  owning file only when every case in it is relevant. Do not run a complete
  layer or default to `npx vitest run`.
- Run with coverage: `npx vitest run --coverage --coverage.include='<glob>'`
- Coverage provider: `@vitest/coverage-v8` (install with `pnpm add -Dw @vitest/coverage-v8` if missing)
- Pure domain/use-case/component tests live beside their owning source. Cross-
  boundary integration and contract tests live in `tests/`; browser journeys
  live in `e2e/`.
- Unit tests use pure dependencies or explicit port fakes and never Miniflare.
- Adapter/migration and HTTP integration tests may use real D1 via Miniflare
  with bounded workers and explicit disposal. Contract tests verify the
  published schema/runtime agreement without depending on repository internals.
- E2E tests: `*.spec.ts` — Playwright browser tests
- Test data setup: Miniflare D1 with migrations from `migrations/`, seed helpers in test files
