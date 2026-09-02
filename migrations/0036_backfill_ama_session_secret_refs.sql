UPDATE ama_agent_sessions
SET secret_ref = 'ama://vaults/' || (
  SELECT session_secret_vault_id
  FROM ama_owner_integrations
  WHERE ama_owner_integrations.owner_id = ama_agent_sessions.owner_id
) || '/credentials/' || secret_credential_id
WHERE secret_ref IS NULL
  AND secret_credential_id IS NOT NULL
  AND secret_credential_id != ''
  AND EXISTS (
    SELECT 1
    FROM ama_owner_integrations
    WHERE ama_owner_integrations.owner_id = ama_agent_sessions.owner_id
      AND session_secret_vault_id IS NOT NULL
      AND session_secret_vault_id != ''
  );

DROP INDEX IF EXISTS idx_ama_agent_sessions_owner;
DROP INDEX IF EXISTS idx_ama_agent_sessions_agent;
DROP INDEX IF EXISTS idx_ama_agent_sessions_ama_session;

CREATE TABLE ama_agent_sessions_next (
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
  closed_at             TEXT,
  secret_ref            TEXT
);

INSERT INTO ama_agent_sessions_next (
  id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd,
  created_at, closed_at, secret_ref
)
SELECT
  id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd,
  created_at, closed_at, secret_ref
FROM ama_agent_sessions;

DROP TABLE ama_agent_sessions;
ALTER TABLE ama_agent_sessions_next RENAME TO ama_agent_sessions;

CREATE INDEX idx_ama_agent_sessions_owner ON ama_agent_sessions(owner_id);
CREATE INDEX idx_ama_agent_sessions_agent ON ama_agent_sessions(agent_id);
CREATE INDEX idx_ama_agent_sessions_ama_session ON ama_agent_sessions(ama_session_id);
