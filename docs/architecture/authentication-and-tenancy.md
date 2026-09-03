# Authentication and tenancy

AK uses two related but distinct authentication profiles. Human browser sign-in
uses standard OpenID Connect. Agent access to the Resource Server additionally
depends on Realmroot-specific identity and Toolbox semantics.

## Browser

The browser discovers the configured OIDC issuer and starts authorization code
flow with PKCE, `state`, and `nonce`. The callback validates the ID token issuer,
audience, signature, lifetime, and nonce before storing an opaque AK session in
an HttpOnly cookie. Access and refresh grants used for downstream Agency access
remain server-side. Unsafe browser mutations require the session CSRF token;
logout removes the local session before using the provider's discovered logout
endpoint. Realmroot is the current OIDC provider, not the owner of this protocol
flow.

## Resource Server

Agents and non-browser clients present OAuth access tokens. AK validates the
standard issuer, audience, expiry, JWT access-token profile, DPoP binding, and
required scopes. Its current Resource-token profile also fixes the client to
Realmroot Toolbox. Realmroot's controller/Agent actor chain identifies Agent
callers; the optional organization claim selects organization tenancy. Task
Claim alone additionally requires Realmroot's signed runtime Session binding.
Those extensions are deliberate Realmroot couplings. The controller establishes
tenant context; the Agent actor identifies the executor.

## Tenant isolation

AK normalizes tenancy into `owner_id`: Realmroot's organization claim when
present, otherwise an OIDC subject-derived personal tenant. Every AK-owned
Board, Repository, Task, Note, integration binding, and idempotency operation is
scoped through that value. Callers cannot choose a tenant or Agency Project in
request data. Organization tenancy therefore remains Realmroot-specific even
though the browser sign-in protocol is standard OIDC.

Each tenant's Agency Project binding is created lazily as described in
[ADR 0007](../adr/0007-lazy-tenant-agency-project.md). Downstream requests are
authorized independently with server-held or exchanged Agency grants.

See [ADR 0002](../adr/0002-oidc-and-agent-authentication.md).
