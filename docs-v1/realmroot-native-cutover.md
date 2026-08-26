# Realmroot user-auth cutover

AK uses Realmroot for human, CLI, machine, and canonical tenant authentication.
AK does not integrate Realmroot Agent identity. AK Agents retain their own
Ed25519 identity and authenticate short-lived runtime Sessions with
`agent+jwt`. An AK worker mirrors to an AMA Agent through `ama_agent_id`; AMA
alone decides whether that AMA Agent has a Realmroot Agent identity and owns any
corresponding key material.

## Registrations and grants

| Object | Type | Configuration |
| --- | --- | --- |
| Agent Kanban Web | `confidential_web` | Authorization Code + PKCE, callback `https://agent-kanban.dev/api/auth/callback`, refresh tokens |
| Agent Kanban CLI | `public_native` | Loopback Authorization Code + PKCE, refresh tokens, AK Resource |
| Agent Kanban API | Native Resource Server | Resource URL `https://agent-kanban.dev/api`, no Connector |

The Web Application requests both the AK and AMA Resource URLs in one
authorization request, together with `openid profile email offline_access`, AK
Web scopes, and AMA control-plane scopes. The authorization-code exchange
selects the AK Resource. AK then uses the rotated refresh grant with
`resource=https://ama.tftt.cc/api` to obtain an AMA-audience Bearer token.

Refresh and AMA access tokens are AES-GCM encrypted at rest with
`REALMROOT_SESSION_ENCRYPTION_KEY`. They never reach browser storage. AK calls
AMA with `Authorization: Bearer` and `X-AMA-Project-ID`; the canonical Realmroot
tenant comes from the access-token claims. AK does not send a custom tenant
header. Logout deletes the AK Session and grant, revokes the refresh token when
Realmroot advertises a revocation endpoint, and performs RP-initiated logout.

## Data and deployment

- Preserve the historical Better Auth `user`, `account`, `session`,
  `verification`, and `apikey` tables as migration source-of-record data. The
  runtime never reads them.
- Owner foreign keys already contain final Realmroot tenant IDs. Do not create
  or retain an AK owner mapping table and never infer identity from email.
- Migration `0041` removes the temporary owner mapping table. Migration `0042`
  creates encrypted user AMA grants and Agent JWT replay storage, and removes
  the incorrect `agents.realmroot_agent_id` and
  `agents.realmroot_credential_ref` columns.
- Existing `agents.ama_agent_id` values remain the AK-to-AMA resource mapping.
  New worker Agents create an AMA Agent with `realmroot: null`; AMA may attach
  its own Realmroot Agent identity independently.
- Migration `0042` expires pre-cutover AK Web Sessions so every active user
  completes the new multi-resource authorization once.

Before production deployment: back up D1, apply migrations, set
`REALMROOT_SESSION_ENCRYPTION_KEY`, deploy, sign in again, and validate Web,
CLI/machine, AK Agent `agent+jwt`, AK-to-AMA Bearer/project isolation, runtime
dispatch, and WebSocket proxy paths. Roll back the Worker and D1 backup together
before credentials are rotated; repair forward afterward.
