-- The supported migration commands run scripts/check-v2-upgrade.ts before this
-- structural rebuild. It refuses the upgrade and reports every non-terminal
-- v1 Task. Legacy assignment values are retained without assigning them a v2
-- identity type; v2 never interprets them as Realmroot actors.
DROP TABLE IF EXISTS v2_terminal_task_guard;
CREATE TABLE v2_terminal_task_guard (
  blocking_task_count INTEGER NOT NULL CHECK(blocking_task_count = 0)
);
INSERT INTO v2_terminal_task_guard (blocking_task_count)
SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done', 'cancelled');
DROP TABLE v2_terminal_task_guard;

PRAGMA defer_foreign_keys = ON;

CREATE TABLE tasks_v2 (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'todo'
                CHECK(status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
  title         TEXT NOT NULL,
  description   TEXT,
  repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  labels        TEXT,
  created_by    TEXT,
  assigned_to   TEXT,
  assignee_identity_type TEXT CHECK(assignee_identity_type IN ('ak_agent', 'realmroot_actor')),
  transition_token TEXT,
  result        TEXT,
  pr_url        TEXT,
  input         TEXT,
  created_from  TEXT REFERENCES tasks_v2(id) ON DELETE SET NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  seq           INTEGER NOT NULL DEFAULT 0,
  scheduled_at  TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO tasks_v2 (
  id, board_id, status, title, description, repository_id, labels, created_by,
  assigned_to, assignee_identity_type, transition_token, result, pr_url, input, created_from, position, created_at,
  updated_at, seq, scheduled_at, metadata
)
SELECT
  id, board_id, status, title, description, repository_id, labels, created_by,
  assigned_to, NULL, NULL,
  result, pr_url, input, created_from, position, created_at,
  updated_at, seq, scheduled_at, metadata
FROM tasks;

CREATE TABLE task_dependencies_v2 (
  task_id    TEXT NOT NULL REFERENCES tasks_v2(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks_v2(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK(task_id != depends_on)
);
INSERT INTO task_dependencies_v2 (task_id, depends_on)
SELECT task_id, depends_on FROM task_dependencies;

CREATE TABLE task_actions_v2 (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks_v2(id) ON DELETE CASCADE,
  actor_type  TEXT NOT NULL CHECK(actor_type IN ('user', 'machine', 'realmroot:agent', 'agent:worker', 'agent:leader', 'system')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK(action IN (
    'created', 'claimed', 'moved', 'commented', 'completed',
    'assigned', 'released', 'timed_out', 'cancelled', 'rejected',
    'review_requested', 'dispatched', 'dispatch_failed'
  )),
  detail      TEXT,
  session_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO task_actions_v2 (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
SELECT id, task_id, actor_type, actor_id, action, detail, session_id, created_at FROM task_actions;

CREATE TABLE messages_v2 (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks_v2(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent')),
  sender_id   TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO messages_v2 (id, task_id, sender_type, sender_id, content, created_at)
SELECT id, task_id, sender_type, sender_id, content, created_at FROM messages;

DROP TABLE task_dependencies;
DROP TABLE task_actions;
DROP TABLE messages;
DROP TABLE tasks;

ALTER TABLE tasks_v2 RENAME TO tasks;
ALTER TABLE task_dependencies_v2 RENAME TO task_dependencies;
ALTER TABLE task_actions_v2 RENAME TO task_actions;
ALTER TABLE messages_v2 RENAME TO messages;

CREATE INDEX idx_tasks_board ON tasks(board_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_repository ON tasks(repository_id);
CREATE INDEX idx_tasks_created_from ON tasks(created_from);
CREATE UNIQUE INDEX idx_tasks_board_seq ON tasks(board_id, seq);
CREATE INDEX idx_tasks_assigned_status ON tasks(assigned_to, status);
CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on);
CREATE INDEX idx_task_actions_task ON task_actions(task_id, created_at);
CREATE INDEX idx_task_actions_actor ON task_actions(actor_id);
CREATE INDEX idx_task_actions_session ON task_actions(session_id);
CREATE INDEX idx_messages_task ON messages(task_id, created_at);

PRAGMA defer_foreign_keys = OFF;
