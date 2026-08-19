-- Fork: local-path repositories. `remote` = cloneable https/git@ URL (upstream
-- behavior); `local` = absolute filesystem path on the daemon host, worktreed
-- in place instead of cloned.
ALTER TABLE repositories ADD COLUMN source_type TEXT NOT NULL DEFAULT 'remote';
