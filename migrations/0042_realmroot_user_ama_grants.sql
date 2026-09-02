-- Store the browser user's multi-resource Realmroot grant server-side. Existing
-- Better Auth tables remain untouched for audit/rollback purposes.
CREATE TABLE realmroot_user_ama_grants (
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  refresh_token_nonce TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  access_token_nonce TEXT NOT NULL,
  access_token_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, subject_id),
  FOREIGN KEY (tenant_id) REFERENCES realmroot_tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_realmroot_user_ama_grants_tenant
  ON realmroot_user_ama_grants(tenant_id, updated_at DESC);

-- Pre-0042 Sessions have no AMA grant. Force a one-time sign-in so every
-- active browser Session is backed by the new multi-resource authorization.
DELETE FROM realmroot_web_sessions;

CREATE TABLE ak_agent_jwt_replays (
  session_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (session_id, jti)
);

CREATE INDEX idx_ak_agent_jwt_replays_expires
  ON ak_agent_jwt_replays(expires_at);

-- Realmroot Agent identity belongs to AMA. AK Agents retain only their own
-- Ed25519 identity and the AMA resource id used for runtime dispatch.
DROP INDEX IF EXISTS idx_agents_owner_realmroot_agent;
ALTER TABLE agents DROP COLUMN realmroot_credential_ref;
ALTER TABLE agents DROP COLUMN realmroot_agent_id;
