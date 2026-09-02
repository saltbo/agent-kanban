CREATE TABLE task_event_offsets (
  sequence  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   TEXT NOT NULL,
  action_id TEXT UNIQUE REFERENCES task_actions(id) ON DELETE SET NULL
);
CREATE INDEX idx_task_event_offsets_task_sequence ON task_event_offsets(task_id, sequence DESC);

INSERT INTO task_event_offsets (task_id, action_id)
SELECT task_id, id
FROM task_actions
ORDER BY created_at ASC, id ASC;

CREATE TRIGGER task_actions_event_offset_after_insert
AFTER INSERT ON task_actions
BEGIN
  INSERT INTO task_event_offsets (task_id, action_id) VALUES (NEW.task_id, NEW.id);
END;

CREATE TRIGGER task_actions_event_offset_after_delete
AFTER DELETE ON task_actions
BEGIN
  INSERT INTO task_event_offsets (task_id, action_id) VALUES (OLD.task_id, NULL);
END;

CREATE TRIGGER tasks_event_offsets_after_delete
AFTER DELETE ON tasks
BEGIN
  DELETE FROM task_event_offsets WHERE task_id = OLD.id;
END;
