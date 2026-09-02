-- Create new table
CREATE TABLE task_actions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type  TEXT NOT NULL CHECK(actor_type IN ('user', 'machine', 'agent:worker', 'agent:leader')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK(action IN (
    'created', 'claimed', 'moved', 'commented', 'completed',
    'assigned', 'released', 'timed_out', 'cancelled', 'rejected', 'review_requested'
  )),
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_task_actions_task ON task_actions(task_id, created_at);
CREATE INDEX idx_task_actions_actor ON task_actions(actor_id);

-- Migrate data from task_notes
INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, created_at)
SELECT id, task_id,
  CASE WHEN agent_id IS NOT NULL THEN 'agent:worker' ELSE 'machine' END,
  COALESCE(agent_id, 'system'),
  action, detail, created_at
FROM task_notes;

-- Drop old table
DROP TABLE task_notes;
