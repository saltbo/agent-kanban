-- Rename task_logs table to task_notes
ALTER TABLE task_logs RENAME TO task_notes;

-- Recreate index with new name
DROP INDEX IF EXISTS idx_task_logs_task;
CREATE INDEX idx_task_notes_task ON task_notes (task_id, created_at);
