-- Agent identity: username for email, gpg_subkey_id for commit signing.
ALTER TABLE agents ADD COLUMN username TEXT;
ALTER TABLE agents ADD COLUMN gpg_subkey_id TEXT;

-- Backfill username from name
UPDATE agents SET username = lower(replace(name, ' ', '-'));
UPDATE agents SET username = 'agent-' || substr(id, 1, 8) WHERE username IS NULL OR username = '';

-- Unique per owner
CREATE UNIQUE INDEX idx_agents_owner_username ON agents(owner_id, username);
