-- Add per-board auto-increment sequence for tasks
ALTER TABLE boards ADD COLUMN task_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;

-- Backfill existing tasks: assign seq per board ordered by created_at
UPDATE tasks SET seq = (
  SELECT COUNT(*)
  FROM tasks t2
  WHERE t2.board_id = tasks.board_id
    AND (t2.created_at < tasks.created_at OR (t2.created_at = tasks.created_at AND t2.id <= tasks.id))
);

-- Update boards.task_seq to the current max
UPDATE boards SET task_seq = (
  SELECT COALESCE(MAX(seq), 0) FROM tasks WHERE tasks.board_id = boards.id
);

-- Unique index: no duplicate seq within a board (seq values start at 1, 0 is unused default)
CREATE UNIQUE INDEX idx_tasks_board_seq ON tasks (board_id, seq);
