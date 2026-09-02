-- Enforce a single leader per owner/runtime pair while allowing many workers.
CREATE UNIQUE INDEX idx_agents_owner_runtime_leader ON agents(owner_id, runtime)
  WHERE kind = 'leader' AND runtime IS NOT NULL;
