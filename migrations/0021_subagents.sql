CREATE TABLE subagents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  bio TEXT,
  soul TEXT,
  role TEXT,
  models TEXT,
  skills TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO subagents (id, owner_id, name, username, bio, soul, role, models, skills, created_at, updated_at)
SELECT DISTINCT
  source.id,
  source.owner_id,
  source.name,
  source.username,
  source.bio,
  source.soul,
  source.role,
  CASE
    WHEN source.model IS NOT NULL AND source.model != '' THEN json_object(source.runtime, source.model)
    ELSE NULL
  END,
  source.skills,
  source.created_at,
  source.updated_at
FROM agents parent, json_each(parent.subagents) ref
JOIN agents source ON source.id = ref.value AND source.owner_id = parent.owner_id
WHERE parent.version = 'latest' AND source.version = 'latest';

CREATE UNIQUE INDEX idx_subagents_owner_username ON subagents(owner_id, username);
