ALTER TABLE task_actions ADD COLUMN session_id TEXT;
CREATE INDEX idx_task_actions_session ON task_actions(session_id);
