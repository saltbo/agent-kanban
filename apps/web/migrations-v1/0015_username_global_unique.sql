-- Username must be globally unique (shared email domain @mails.agent-kanban.dev).
-- Deduplicate: append owner_id prefix to duplicates before adding unique constraint.
UPDATE agents SET username = username || '-' || SUBSTR(owner_id, 1, 6)
  WHERE rowid NOT IN (SELECT MIN(rowid) FROM agents GROUP BY username);
DROP INDEX IF EXISTS idx_agents_owner_username;
CREATE UNIQUE INDEX idx_agents_username ON agents(username);
