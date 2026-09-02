-- GitHub App installation tracking. Lets AK know which installations an owner
-- has and which repos each covers, so repo onboarding can show App status and
-- offer browse-and-import. Kept fresh by installation webhooks + the setup
-- callback. The live dispatch token path (mintGithubInstallationToken) does NOT
-- read these tables — it resolves installations against GitHub directly.

CREATE TABLE github_installations (
  installation_id      INTEGER PRIMARY KEY,        -- GitHub numeric installation id
  owner_id             TEXT,                       -- AK owner, NULL until setup callback / backfill
  account_login        TEXT NOT NULL,              -- GitHub account login (user or org), stored lowercased
  account_id           INTEGER NOT NULL,           -- GitHub numeric account id (backfill join key)
  account_type         TEXT NOT NULL,              -- 'User' | 'Organization'
  repository_selection TEXT NOT NULL,              -- 'all' | 'selected'
  suspended_at         TEXT,                       -- non-null when suspended
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_github_installations_owner ON github_installations(owner_id);
CREATE INDEX idx_github_installations_account_login ON github_installations(account_login);

CREATE TABLE github_installation_repositories (
  installation_id INTEGER NOT NULL REFERENCES github_installations(installation_id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,                   -- 'owner/repo', lowercased
  repo_id         INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (installation_id, full_name)
);

CREATE INDEX idx_github_installation_repos_full_name ON github_installation_repositories(full_name);
