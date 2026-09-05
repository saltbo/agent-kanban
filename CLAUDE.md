# Agent Kanban

Agent-first kanban board. React SPA + Hono API on Cloudflare Workers + D1.
One pnpm package: `src/` contains the UI, `server/` the backend, and `shared/`
the shared types. The Worker entry is `server/worker/index.ts`.

## Context for the task

Read the documents relevant to the change; this is a map, not a reading checklist.

- Product and interaction direction: [product principles](docs/product-principles.md).
  For visual decisions, also consult the relevant parts of [DESIGN.md](DESIGN.md).
- Observable behavior and acceptance scenarios: [spec/README.md](spec/README.md)
  and the relevant `spec/*.feature`. Tests link to scenarios using
  `[spec: capability/scenario]`.
- Architecture decisions: [ADRs](docs/adr/README.md). Check the relevant record's
  status and any superseding decision when changing an architectural boundary.
- Current implementation: [architecture overview](docs/architecture/system-overview.md)
  and [code structure](docs/architecture/code-structure.md). Authentication,
  task lifecycle, Resource Server, projections, and Session observation each
  have focused documents in `docs/architecture/`.
- Test placement and selection: [test pyramid](docs/architecture/test-pyramid.md).
- Upgrade work: [v1-to-v2 procedure](docs/operations/v1-to-v2-upgrade.md).

Keep detailed decisions and behavior in their existing documents rather than
copying them here. If code and documentation disagree on something relevant to
the task, identify the discrepancy before treating either as obsolete.

## Commands and verification

Use the Node and pnpm versions declared in `package.json`.

- Local app: `pnpm dev`; local database migrations: `pnpm db:migrate`.
- Focused tests: `pnpm exec vitest run --project <project> <file> -t '<case>'`.
  Project names are in `vitest.config.ts`.
- Browser journeys: `pnpm exec playwright test <file>`; tests are in `tests/e2e/`.
- Static checks: `pnpm typecheck`, `pnpm lint`; scenario traceability: `pnpm lint:spec`.
- Build: `pnpm build`; bundled skill consistency: `pnpm check:skills`.
- Deployment: `pnpm deploy`; remote migrations: `pnpm db:migrate:remote`.
  See the upgrade procedure before migration work.

Complete local acceptance appropriate to the change. Start with the smallest
meaningful checks, and broaden when shared boundaries or required CI checks
justify it. Reuse passing evidence while its inputs remain unchanged.
The implementer may update both source and tests; a frontend edit alone does
not require new E2E tests or a fixed sequence of specialist agents.

For an authorized deployment, include regression checks against the deployed
result. The current Playwright setup starts a local server and seeds local D1;
it is not directly reusable against production. Assess a safe reusable subset
or a small adaptation, otherwise verify the affected journeys manually.
