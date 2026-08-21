# Realmroot Native cutover

AK has no Better Auth compatibility mode. The cutover is a maintenance-window
operation and the old issuer must not be accepted in parallel.

## Realmroot registrations

Register all objects in the AK owner organization. Do not create a Connector.

| Object | Type | Required configuration |
| --- | --- | --- |
| Agent Kanban Web | `confidential_web` | `authorization_code`, PKCE, callback `https://agent-kanban.dev/api/auth/callback`, logout `https://agent-kanban.dev/` |
| Agent Kanban CLI | `public_native` | device authorization, PKCE, `authorization_code`, `refresh_token`, no client secret |
| Agent Kanban AMA Service | `machine` | `client_credentials`, `client_secret_basic`, direct permission to the AMA Resource scopes configured in `AMA_MACHINE_SCOPES` |
| Agent Kanban API | Native Resource Server | identifier `agent-kanban`, Resource URL `https://agent-kanban.dev/api`, available to Agents, no Connector |

The Web Application requests only `openid profile email`. AK stores the ID
claims in its own opaque server session and deliberately does not request or
persist a Web refresh token. Logout requires the AK CSRF token, destroys that
session, then redirects through Realmroot's advertised `end_session_endpoint`.
Consequently there is no AK-held Web refresh grant to revoke. CLI refresh
tokens and their DPoP private key remain isolated in the operating-system
Keychain and rotate there independently.

After Device Flow, `ak start` registers its stable device ID once. AK records a
single `(tenant, machine) -> Realmroot subject` binding and the daemon includes
`X-AK-Machine-ID` on machine-context requests. AK verifies that header against
the binding before granting machine operations; another tenant member cannot
take over an already-bound device by replaying its device ID.

The Resource Server discovers scopes from
`https://agent-kanban.dev/.well-known/oauth-protected-resource/api` and the
contract from `https://agent-kanban.dev/api/openapi.json`. Register it only
after those URLs are live in the target environment.

Before staging, verify AMA's deployed Native Resource contract accepts the AK
Machine Application client ID and validates `X-AK-Tenant-ID` together with
`X-AMA-Project-ID`. A project ID must belong to the asserted AK tenant; the
header is business context, not a replacement identity. Do not cut over while
AMA discovery or this cross-tenant isolation check is unavailable.

Set `REALMROOT_WEB_CLIENT_ID`, `REALMROOT_CLI_CLIENT_ID`, and
`AMA_MACHINE_CLIENT_ID` as Worker variables. AK accepts Resource tokens only
from that Native client or Realmroot's `realmroot-cli` Agent Toolbox client.
Set `REALMROOT_WEB_CLIENT_SECRET`, `AMA_MACHINE_CLIENT_SECRET`, and an ES256
private JWK in `AMA_DPOP_PRIVATE_JWK` as Worker secrets. Never put secret values
in this repository or a shell history.

## Data cutover

1. Apply migrations through `0040_ama_resource_initialization_claims.sql`
   only, then validate Web, CLI, Agent, and AK-to-AMA flows in staging. Do not
   apply `0041_drop_realmroot_identity_mappings.sql` while legacy owner ids
   still need to be rewritten.
2. Stop production writes and create a D1 backup.
3. Export the authoritative Realmroot merge as `owners.json`:

   ```json
   [{"legacyOwnerId":"legacy-id","tenantId":"realmroot-tenant-id","subjectId":"realmroot-subject","email":"user@example.com","name":"User"}]
   ```

4. Export all latest AK Agent bindings as `agents.json`. Every worker requires
   an active AMA Vault state credential:

   ```json
   [{"agentId":"ak-agent-id","realmrootAgentId":"realmroot-agent-id","credentialRef":"ama://vaults/vault-id/credentials/credential-id"}]
   ```

5. Preview and then execute the exact migration:

   ```sh
   pnpm migrate:realmroot-owners -- --mapping owners.json --agent-mapping agents.json --database agent-kanban-db --remote
   pnpm migrate:realmroot-owners -- --mapping owners.json --agent-mapping agents.json --database agent-kanban-db --remote --apply
   ```

   The command rejects missing or unknown owners/Agents, preserves business row
   counts, verifies foreign keys, rejects chained mappings and merge collisions,
   and rejects unbound Agents. Every legacy owner must point directly at its
   final tenant; the command never infers a mapping from email.

6. After the owner migration and its post-validation succeed, apply
   `0041_drop_realmroot_identity_mappings.sql`. Then deploy the Realmroot-only
   configuration and force every Web, CLI, machine, and Agent runtime to
   authenticate again. Environments already migrated through `0040` must run
   step 5 before an unbounded `wrangler d1 migrations apply`.
7. Revoke Better Auth Sessions/API keys/Agent tokens, the old issuer clients,
   and old secrets. Retain the Better Auth tables as migration
   source-of-record data; the Realmroot-only runtime does not read them. After
   the observation window, execute `scripts/realmroot-contract.sql` only to
   remove retired non-BA artifacts such as the GPG private-key store.

Rollback means restoring the D1 backup and the prior deployment. After old
credentials are revoked, repair forward only.
