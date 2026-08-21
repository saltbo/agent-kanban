CREATE TABLE ama_resource_initializations (
  tenant_id TEXT PRIMARY KEY REFERENCES realmroot_tenants(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_ama_resource_initializations_expiry
  ON ama_resource_initializations(expires_at);
