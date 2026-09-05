# Code structure

The repository is one pnpm package and TypeScript project.

Server dependencies point inward:

```text
worker -> HTTP composition -> use cases -> domain
                 adapters ────────┘
```

- `server/domain/` owns deterministic product rules and value semantics.
- `server/usecases/` coordinates operations through explicit ports.
- `server/adapters/` implements D1, Agency, GitHub, and streaming edges.
- `server/auth/` owns standard OIDC browser authentication and the additional
  Realmroot Agent Resource-token profile.
- `server/http/` owns validation, representations, middleware, routes, and the
  single OpenAPI document.
- `server/worker/` creates the Cloudflare entry point.

React code is grouped by product feature under `src/features/`. Shared UI
primitives live under `src/components/ui/`; narrow browser infrastructure lives
under `src/lib/`; cross-boundary representations live under `shared/`.

Route handlers contain no raw SQL. V2 workflows use feature-owned repository
adapters. Legacy tables may remain in migration history but have no v2
repository or business consumer.

See [ADR 0001](../adr/0001-single-package-layered-application.md).
