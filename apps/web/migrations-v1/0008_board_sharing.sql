-- Board sharing: visibility toggle and public share slug
ALTER TABLE boards ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE boards ADD COLUMN share_slug TEXT;

CREATE UNIQUE INDEX idx_boards_share_slug ON boards(share_slug);
