ALTER TABLE board_maintainers ADD COLUMN ama_http_trigger_id TEXT;
ALTER TABLE board_maintainers ADD COLUMN ama_memory_store_id TEXT;
ALTER TABLE board_maintainers ADD COLUMN repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_board_maintainers_ama_http_trigger ON board_maintainers(ama_http_trigger_id) WHERE ama_http_trigger_id IS NOT NULL;
CREATE INDEX idx_board_maintainers_ama_memory_store ON board_maintainers(ama_memory_store_id) WHERE ama_memory_store_id IS NOT NULL;
CREATE INDEX idx_board_maintainers_repository ON board_maintainers(repository_id) WHERE repository_id IS NOT NULL;
