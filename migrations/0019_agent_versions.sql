ALTER TABLE agents ADD COLUMN version TEXT NOT NULL DEFAULT 'latest';

DROP INDEX IF EXISTS idx_agents_username;
CREATE UNIQUE INDEX idx_agents_username_version ON agents(username, version);
