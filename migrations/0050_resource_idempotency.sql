CREATE TABLE resource_idempotency_records (
  owner_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  api_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, actor_id, api_version, idempotency_key)
);

CREATE INDEX idx_resource_idempotency_records_created
  ON resource_idempotency_records(expires_at);
