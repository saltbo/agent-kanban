# Authentication and tenancy

## Browser

The browser starts Realmroot OIDC authorization code flow with PKCE. The
callback validates the Realmroot identity and stores an opaque AK session in an
HttpOnly cookie. Access and refresh grants used for downstream Agency access
remain server-side. Unsafe browser mutations require the session CSRF token;
logout removes the local session before redirecting to Realmroot logout.

## Resource Server

Agents and non-browser clients present Realmroot access tokens. AK validates
issuer, audience, expiry, proof binding, and required scopes, then normalizes a
principal containing tenant, controller, and optional Agent actor. The
controller establishes tenant context; the Agent actor identifies the executor.

## Tenant isolation

The canonical Realmroot tenant identifier becomes `owner_id`. Every AK-owned
Board, Repository, Task, Note, integration binding, and idempotency operation is
scoped through that value. Callers cannot choose a tenant or Agency Project in
request data.

Each tenant's Agency Project binding is created lazily as described in
[ADR 0007](../adr/0007-lazy-tenant-agency-project.md). Downstream requests are
authorized independently with server-held or exchanged Agency grants.

See [ADR 0002](../adr/0002-realmroot-authentication-and-tenancy.md).
