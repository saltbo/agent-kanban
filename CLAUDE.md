# Agent Kanban

Agent-first kanban board. React SPA + Hono API on Cloudflare Workers + D1.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

## Architecture
- Monorepo: pnpm workspaces
- Frontend: apps/web/src/ — React + Vite + Tailwind + shadcn/ui
- Backend: apps/web/server/ — Hono API, repo layer, auth, SSE
- Worker entry: apps/web/worker/index.ts — exports Hono app + TunnelRelay DO
- Build: @cloudflare/vite-plugin — produces client assets + worker bundle
- Database: Cloudflare D1 (SQLite)
- Durable Objects: TunnelRelay (WebSocket relay for runtime sessions ↔ browser)
- CLI: packages/cli/ — TypeScript, published to npm
- Shared types: packages/shared/ — proper package with build step
- Agent skill: skills/agent-kanban/ — installed via `npx skills add` to target repos

## UI Principles
- **Read-only board** — the web UI is for observation and review, not task management
- **No task creation UI** — tasks are created exclusively by agents via CLI/API
- **No status transition buttons** — no claim/cancel/release/assign in the UI
- **No drag-and-drop** — card ordering is managed by agents
- **Only two review actions in UI**: reject (send back to agent) and complete (accept) — can be performed by humans or lead agents via API
- Board switcher and task detail (logs, PR, chat) are the only navigation interactions

## Patterns
- Data access: thin repo layer (taskRepo.ts, boardRepo.ts, agentRepo.ts, messageRepo.ts) — no raw SQL in route handlers
- Error handling: Hono onError + HTTPException — centralized error envelope { error: { code, message } }
- Claim atomicity: db.batch() for race-condition-free task claims
- Auth: Three identity types — **user** (Better Auth session), **machine** (@better-auth/api-key), **agent** (@better-auth/agent-auth Ed25519 JWT). Machines assign tasks; agents claim/review with own JWT. Data scoped by `owner_id`.
- Agent identity: registered via `POST /api/agents` with Ed25519 public key. Each agent has a cryptographic identity (identicon, fingerprint). Daemon generates ephemeral keypair per spawn.
- Agent status: idle → working (on claim/assign) → idle (on complete/release/cancel with no other active tasks) → offline (on stale timeout)
- Task lifecycle: Todo → Todo+assigned (AMA runtime dispatch) → In Progress (agent claim) → In Review (agent review+PR) → Done (reviewer complete) or Cancelled (cancel at any stage). Reviewer = human or lead agent.
- Task dependencies: `depends_on` JSON array, cycle detection via recursive CTE (taskDeps.ts), `blocked` computed on read
- Task origin: `created_from` for single-level subtask tracking
- Stale detection: write-on-read in GET /api/boards/:id and inline before assign (taskStale.ts). 2h timeout, idempotent.
- SSE: TransformStream-based, 2s poll for 25s (CF Workers limit), Last-Event-ID resume via log ID → timestamp resolution (sse.ts). Emits typed events (`event: log` for task_logs, `event: message` for messages).
- Messages: `messages` table for human ↔ agent chat. `agent_id` = agent runtime session ID. D1 as message bus — AMA/runtime sessions handle agent-side delivery, browser reads via SSE.
- Runtime implementation: **AMA is the current source of truth** for runtime dispatch, quota/usage, health, and schedulability. Check `apps/web/server/amaRuntime.ts`, `apps/web/server/taskDispatch.ts`, AMA runner/provider data, and related API routes before considering any legacy local daemon behavior.
- `ak start` is the current supported entrypoint for starting a local AK runtime/machine context. The deprecated part is the old local daemon scheduling implementation and historical assumptions about daemon polling/provider availability, not the `ak start` command itself. Do not use old daemon heartbeat, local provider availability, or legacy daemon smoke behavior as the explanation for current runtime scheduling unless the task explicitly asks about legacy daemon support.
- Repo management: `ak create repo` registers repo at tenant level. `ak get repo` lists registered repos.
- Data model: Board is the workspace unit. Repositories belong to owner (tenant-level, like machines). Tasks belong to boards, optionally linked to a repository. Machines belong to owner (user/org).

## Post-Write Workflow
After every significant code change, follow the `ak-verify` skill (`skills/ak-verify/SKILL.md`): Tests → Review → Regression, with the Author/Test author/E2E author/Reviewer role split and ownership rule defined there.

Role mapping in this repository: Author = main agent; Test author = test-writer subagent; E2E author = playwright-test-generator (and playwright-test-healer for broken existing E2E tests) — invoked when changes touch frontend components (`apps/web/src/`); Reviewer = clean-code-reviewer subagent.

Regression commands for this repo: `pnpm build && pnpm typecheck && npx vitest run`. Use `pnpm typecheck`, NOT `tsc --noEmit` at the root: the root tsconfig is solution-style (`files: []` + `references`), so `tsc --noEmit` there checks nothing.

Project-specific additional step — **legacy daemon smoke test**: if changes explicitly touch deprecated daemon code (`packages/cli/src/daemon/`), run `./scripts/daemon-smoke-test.sh` and ensure it passes before considering that legacy path done.
   - Before smoke, always refresh the local CLI with `bash scripts/install-cli.sh`.
   - Smoke is mandatory. Missing arguments are not a reason to skip it: discover existing resources with `ak get board -o json`, `ak get repo -o json`, and `ak get agent -o json`, or create the missing resources.
   - The default smoke target is the Demo board with the `slink` repository. The smoke script auto-discovers these defaults when arguments are omitted.

## Testing
- Framework: vitest (root `vitest.config.ts`)
- Run: `npx vitest run`
- Run with coverage: `npx vitest run --coverage --coverage.include='<glob>'`
- Coverage provider: `@vitest/coverage-v8` (install with `pnpm add -Dw @vitest/coverage-v8` if missing)
- Tests in `tests/` directory
- Unit tests: `*.test.ts` — direct import of modules, pure Node/jsdom. Miniflare/D1-backed integration tests were removed (flaky under concurrency, slow git hooks); do not reintroduce Miniflare-based vitest cases.
- E2E tests: `*.spec.ts` — Playwright browser tests against the dev server (which uses its own local D1)
