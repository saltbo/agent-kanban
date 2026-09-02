DROP INDEX IF EXISTS idx_agents_owner_runtime_leader;

CREATE UNIQUE INDEX idx_agents_owner_runtime_leader ON agents(owner_id, runtime)
  WHERE kind = 'leader' AND runtime IS NOT NULL AND version = 'latest';
