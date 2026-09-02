-- Add a `system` actor type and dispatch actions so the control-plane's dispatch
-- of a task to AMA shows up on the task timeline as a system action.
-- SQLite cannot ALTER a CHECK constraint, so rebuild the table.
CREATE TABLE task_actions_new (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type  TEXT NOT NULL CHECK(actor_type IN ('user', 'machine', 'agent:worker', 'agent:leader', 'system')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK(action IN (
    'created', 'claimed', 'moved', 'commented', 'completed',
    'assigned', 'released', 'timed_out', 'cancelled', 'rejected', 'review_requested',
    'dispatched', 'dispatch_failed'
  )),
  detail      TEXT,
  session_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO task_actions_new (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
  SELECT id, task_id, actor_type, actor_id, action, detail, session_id, created_at FROM task_actions;
DROP TABLE task_actions;
ALTER TABLE task_actions_new RENAME TO task_actions;
CREATE INDEX idx_task_actions_task ON task_actions(task_id, created_at);
CREATE INDEX idx_task_actions_actor ON task_actions(actor_id);
CREATE INDEX idx_task_actions_session ON task_actions(session_id);
