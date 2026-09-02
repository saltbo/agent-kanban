-- Board type: 'dev' for development boards (git/PR workflow), 'ops' for operations boards (no repo)
ALTER TABLE boards ADD COLUMN type TEXT NOT NULL DEFAULT 'dev'
  CHECK(type IN ('dev', 'ops'));
