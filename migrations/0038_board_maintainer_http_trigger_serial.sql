ALTER TABLE board_maintainers ADD COLUMN ama_http_trigger_serialized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board_maintainers ADD COLUMN ama_http_trigger_serialization_attempted_at TEXT;

CREATE INDEX idx_board_maintainers_http_trigger_serialized
  ON board_maintainers(ama_http_trigger_serialized, status, ama_http_trigger_serialization_attempted_at, created_at)
  WHERE ama_http_trigger_id IS NOT NULL;
