# Authentication and tenancy

AK uses two related but distinct authentication profiles. Human browser sign-in
uses standard OpenID Connect. Agent access to the Resource Server additionally
depends on Realmroot-specific identity and Toolbox semantics.

## Browser

The browser discovers the configured OIDC issuer and starts authorization code
flow with PKCE, `state`, and `nonce`. The callback validates the ID token issuer,
audience, signature, lifetime, and nonce before storing an opaque AK session in
an HttpOnly cookie. Access and refresh grants used for downstream Agency access
remain encrypted server-side in `realmroot_user_grants`, keyed by tenant and
user subject. This replaces `realmroot_web_session_grants`; there is no second
copy of the grant per Task. Reauthentication updates that user's existing grant.
Browser logout removes the login Session, while the user authorization remains
available for already assigned background work. Invalid refresh authorization
requires the user to sign in again. Unsafe browser mutations require the session CSRF token;
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

## Task background authorization

An Agent creating a Task must have a saved AK web-login grant for its controller
in the same tenant. Without it, creation returns `409 user-login-required`, asks
the associated user to sign in to AK in a browser, and writes no Task. Another
member's grant cannot satisfy this requirement. Assignment also checks the grant
and atomically records the authorizing user at
`metadata["agent-kanban.dev/authorization-subject"]`. This reserved value is a
user ID, never a token, and clients cannot change it through metadata writes.

A signed GitHub PR close/merge event performs the normal Task transition, settles
its exact Session, and dispatches eligible dependent Tasks. Each Task uses its
own recorded user's grant and the tenant's existing Project binding. AK refreshes
its user access token when needed and exchanges it for narrowly scoped Enbor
access using the same Web Application. No client-credentials token or M2M identity
is used. A refresh lease in the same grant row prevents concurrent requests from
rotating one refresh token twice; a busy refresh is an explicit temporary error.
Repeated webhook delivery can finish terminal Task effects without duplicating
Session creation. Errors propagate to the webhook caller; failed effects are
not reported as completed.

## Permissions for newly created Agents

`POST /api/agents` exchanges the creating user's saved AK grant for Realmroot
`agents:write` using the existing AK Web Application.
Its token exchange policy maps AK `agent:write` to those target scopes. Agent
credentials are not used as a substitute for the user's grant.

After Enbor creates the bound identity and Agent, AK sends one GitHub permission POST
containing only the Resource URL, scopes, and persistent lifetime. Realmroot
resolves the controller's connected GitHub installation Contexts internally.
AK permissions use the existing native automatic authorization; AK neither
creates explicit AK grants nor queries permission Contexts. The
GitHub Resource URL is configured by `GITHUB_RESOURCE`; provider connection and
installation scope limits remain enforced by Realmroot and its Adapter.

The GitHub defaults are metadata read, contents read/write, pull requests
read/write, checks read, statuses read, actions read/write, workflows write,
and issues read/write. The current Git transport requires workflows write for
all pushes. Contexts retain the GitHub App installation's repository selection.
No external automatic-approval policy is introduced.

Creation returns success only after permission configuration succeeds. A 409
`agent-permissions-incomplete` identifies the created Enbor Agent through its
Location header and detail. Retry the same creation and Idempotency-Key to
reuse Enbor resources and complete equivalent permissions. No local Agent or
permission table is added. Existing Agent reads and assignments do not backfill
grants; this change applies only to new creations.

Acceptance: create a new Agent through Toolbox in Demo, inspect its permissions
before assignment, then run a repository Task including Issue, PR, CI log, and
review continuation operations. Use a new Session to prove existing grants can
be acquired without controller approval. Keep existing Agent grants unchanged.

## Permissions for existing Agents

`POST /api/agents/{agentId}/permissions` requires `agent:write` and an empty JSON
object. AK resolves the existing identity through the tenant-scoped Enbor project,
then uses the same saved user grant, Token Exchange and GitHub defaults as Agent
creation. It returns 204 after Realmroot confirms the grants. Equivalent grants
are reused and other permissions are retained. It does not create or delete
Agents or identities, and does not modify AK native grants. An unbound identity
or missing user login returns 409; a permission upstream failure returns 502 with
the cause. Repeating the explicit POST completes missing permissions. Ordinary
reads and assignments still do not change existing permissions.
