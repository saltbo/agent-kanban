CREATE TABLE realmroot_tenants (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Legacy owner ids are temporary tenant ids until the maintenance-window
-- migration replaces them with the authoritative Realmroot ids.
INSERT INTO realmroot_tenants (id)
SELECT id FROM user;

CREATE TABLE realmroot_tenant_members (
  tenant_id TEXT NOT NULL REFERENCES realmroot_tenants(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, subject_id)
);

CREATE TABLE realmroot_login_attempts (
  id_hash TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE realmroot_web_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES realmroot_tenants(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  image TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_realmroot_web_sessions_expiry ON realmroot_web_sessions(expires_at);
CREATE INDEX idx_realmroot_web_sessions_subject ON realmroot_web_sessions(subject_id);

-- Native Device Flow grants identify the human subject, not an AK machine.
-- Persist the explicit subject-to-machine registration so heartbeat/session
-- operations cannot select an arbitrary machine in the same tenant.
CREATE TABLE realmroot_native_machine_bindings (
  tenant_id TEXT NOT NULL REFERENCES realmroot_tenants(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, machine_id)
);
CREATE INDEX idx_realmroot_native_machine_bindings_subject
  ON realmroot_native_machine_bindings(tenant_id, subject_id);

CREATE TABLE realmroot_dpop_replays (
  thumbprint TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (thumbprint, jti)
);
CREATE INDEX idx_realmroot_dpop_replays_expiry ON realmroot_dpop_replays(expires_at);

CREATE TABLE realmroot_identity_mappings (
  legacy_owner_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES realmroot_tenants(id),
  migrated_at TEXT
);

ALTER TABLE agents ADD COLUMN realmroot_agent_id TEXT;
ALTER TABLE agents ADD COLUMN realmroot_credential_ref TEXT;
CREATE UNIQUE INDEX idx_agents_owner_realmroot_agent
  ON agents(owner_id, realmroot_agent_id)
  WHERE realmroot_agent_id IS NOT NULL AND version = 'latest';

ALTER TABLE ama_owner_integrations RENAME TO ama_owner_integrations_legacy;
CREATE TABLE ama_owner_integrations (
  tenant_id TEXT PRIMARY KEY,
  ama_project_id TEXT NOT NULL,
  session_secret_vault_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO ama_owner_integrations (
  tenant_id,
  ama_project_id,
  session_secret_vault_id,
  metadata,
  created_at,
  updated_at
)
SELECT
  owner_id,
  ama_project_id,
  session_secret_vault_id,
  metadata,
  created_at,
  updated_at
FROM ama_owner_integrations_legacy;
DROP TABLE ama_owner_integrations_legacy;

ALTER TABLE gpg_keys RENAME TO gpg_keys_legacy;
CREATE TABLE gpg_keys (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL REFERENCES realmroot_tenants(id) ON DELETE CASCADE,
  armored_private_key TEXT NOT NULL,
  armored_public_key  TEXT NOT NULL,
  fingerprint         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (owner_id)
);
INSERT INTO gpg_keys SELECT * FROM gpg_keys_legacy;
DROP TABLE gpg_keys_legacy;

DROP INDEX IF EXISTS idx_board_maintainers_owner_board;
DROP INDEX IF EXISTS idx_board_maintainers_ama_schedule;
DROP INDEX IF EXISTS idx_board_maintainers_ama_http_trigger;
DROP INDEX IF EXISTS idx_board_maintainers_ama_memory_store;
DROP INDEX IF EXISTS idx_board_maintainers_http_trigger_serialized;

ALTER TABLE board_maintainers RENAME TO board_maintainers_legacy;
CREATE TABLE board_maintainers (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES realmroot_tenants(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  ama_schedule_id TEXT NOT NULL,
  ama_http_trigger_id TEXT,
  ama_http_trigger_serialized INTEGER NOT NULL DEFAULT 0,
  ama_http_trigger_serialization_attempted_at TEXT,
  ama_memory_store_id TEXT,
  ama_board_vault_id TEXT,
  prompt TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 86400,
  heartbeat_enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  last_run_at TEXT,
  last_ama_session_id TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO board_maintainers (
  id, owner_id, board_id, agent_id, ama_schedule_id, ama_http_trigger_id,
  ama_http_trigger_serialized, ama_http_trigger_serialization_attempted_at,
  ama_memory_store_id, ama_board_vault_id, prompt, interval_seconds,
  heartbeat_enabled, status, last_run_at, last_ama_session_id,
  last_error_message, created_at, updated_at
)
SELECT
  id, owner_id, board_id, agent_id, ama_schedule_id, ama_http_trigger_id,
  ama_http_trigger_serialized, NULL,
  ama_memory_store_id, ama_board_vault_id, prompt, interval_seconds,
  heartbeat_enabled, status, last_run_at, last_ama_session_id,
  last_error_message, created_at, updated_at
FROM board_maintainers_legacy;
DROP TABLE board_maintainers_legacy;

CREATE INDEX idx_board_maintainers_owner_board ON board_maintainers(owner_id, board_id);
CREATE UNIQUE INDEX idx_board_maintainers_ama_schedule ON board_maintainers(ama_schedule_id);
CREATE UNIQUE INDEX idx_board_maintainers_ama_http_trigger ON board_maintainers(ama_http_trigger_id) WHERE ama_http_trigger_id IS NOT NULL;
CREATE INDEX idx_board_maintainers_ama_memory_store ON board_maintainers(ama_memory_store_id) WHERE ama_memory_store_id IS NOT NULL;
CREATE INDEX idx_board_maintainers_http_trigger_serialized
  ON board_maintainers(ama_http_trigger_serialized, status, ama_http_trigger_serialization_attempted_at, created_at)
  WHERE ama_http_trigger_id IS NOT NULL;
