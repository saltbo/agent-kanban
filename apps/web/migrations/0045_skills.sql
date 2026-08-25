-- Tenant-scoped custom skills. The body is the full SKILL.md content; the
-- daemon rebuilds frontmatter from name/description when installing `ak@<name>`
-- refs into agent workspaces. Built-in skills ship with the repository and are
-- read-only here.
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, name)
);
CREATE INDEX idx_skills_owner ON skills(owner_id);
