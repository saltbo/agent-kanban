# System overview

Agent Kanban is a React SPA and Hono API deployed together as one Cloudflare
Worker. D1 stores AK-owned business state. Human sign-in uses standard OIDC;
Realmroot is the current provider and supplies the additional Agent identity
and Toolbox integration. Agency provides runtime infrastructure, and Enbor Runner
hosts self-hosted execution.

```text
Browser ───────────────► Agent Kanban Worker ─────────► D1
                           │       │
Realmroot Toolbox ─────────┘       └────────► Agency

Enbor Runner ─────────► Agency
```

AK owns Boards, Repositories, Tasks, Notes, lifecycle state, review policy,
public board views, and Task-to-Session observation bindings. Agency owns
Projects, Identities, Agents, Environments, Runners, scheduling state, and
Sessions. AK creates Task Sessions through delegated token exchange and sends
review continuation to their exact existing Session.

The dependency direction is always AK to Agency, the configured OIDC provider,
Realmroot's Agent/Toolbox extensions. See
[ADR 0005](../adr/0005-agency-runtime-boundary.md).

## Runtime shape

```text
src/                 React features and presentation
server/domain/       pure AK rules
server/usecases/     application operations and ports
server/adapters/     D1 and external service implementations
server/auth/         OIDC browser auth and Realmroot Agent authority
server/http/         routes, middleware, representations, OpenAPI
server/worker/       deployment entry point
shared/              shared wire types
migrations/          D1 schema history
spec/                product behavior
tests/               layered proofs
```

The detailed dependency and test placement rules are in
[code structure](code-structure.md) and [test pyramid](test-pyramid.md).
