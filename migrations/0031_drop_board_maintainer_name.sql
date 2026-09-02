DROP INDEX IF EXISTS idx_board_maintainers_owner_board;
DROP INDEX IF EXISTS idx_board_maintainers_ama_schedule;
DROP INDEX IF EXISTS idx_board_maintainers_ama_http_trigger;
DROP INDEX IF EXISTS idx_board_maintainers_ama_memory_store;

CREATE TABLE board_maintainers_next (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  ama_schedule_id TEXT NOT NULL,
  ama_http_trigger_id TEXT,
  ama_memory_store_id TEXT,
  prompt TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL DEFAULT 86400,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  last_run_at TEXT,
  last_ama_session_id TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES user(id) ON DELETE CASCADE
);

INSERT INTO board_maintainers_next (
  id, owner_id, board_id, agent_id, ama_schedule_id, ama_http_trigger_id, ama_memory_store_id,
  prompt, interval_seconds, status, last_run_at, last_ama_session_id, last_error_message, created_at, updated_at
)
SELECT
  id, owner_id, board_id, agent_id, ama_schedule_id, ama_http_trigger_id, ama_memory_store_id,
  prompt, interval_seconds, status, last_run_at, last_ama_session_id, last_error_message, created_at, updated_at
FROM board_maintainers;

DROP TABLE board_maintainers;
ALTER TABLE board_maintainers_next RENAME TO board_maintainers;

CREATE INDEX idx_board_maintainers_owner_board ON board_maintainers(owner_id, board_id);
CREATE UNIQUE INDEX idx_board_maintainers_ama_schedule ON board_maintainers(ama_schedule_id);
CREATE UNIQUE INDEX idx_board_maintainers_ama_http_trigger ON board_maintainers(ama_http_trigger_id) WHERE ama_http_trigger_id IS NOT NULL;
CREATE INDEX idx_board_maintainers_ama_memory_store ON board_maintainers(ama_memory_store_id) WHERE ama_memory_store_id IS NOT NULL;
