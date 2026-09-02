ALTER TABLE tasks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE machines ADD COLUMN ama_environment_id TEXT;

CREATE TABLE board_maintainers (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  board_id            TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  ama_schedule_id     TEXT NOT NULL,
  name                TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  interval_seconds    INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  last_run_at         TEXT,
  last_ama_session_id TEXT,
  last_error_message  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX idx_board_maintainers_owner_board ON board_maintainers(owner_id, board_id);
CREATE UNIQUE INDEX idx_board_maintainers_ama_schedule ON board_maintainers(ama_schedule_id);

CREATE TABLE ama_agent_sessions (
  id                    TEXT PRIMARY KEY,
  owner_id              TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ama_session_id        TEXT,
  status                TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'closed')),
  public_key            TEXT NOT NULL,
  delegation_proof      TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at             TEXT
);

CREATE INDEX idx_ama_agent_sessions_owner ON ama_agent_sessions(owner_id);
CREATE INDEX idx_ama_agent_sessions_agent ON ama_agent_sessions(agent_id);
CREATE INDEX idx_ama_agent_sessions_ama_session ON ama_agent_sessions(ama_session_id);

CREATE TABLE ama_owner_integrations (
  owner_id TEXT PRIMARY KEY,
  ama_project_id TEXT NOT NULL,
  external_tenant_id TEXT NOT NULL,
  session_secret_vault_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
