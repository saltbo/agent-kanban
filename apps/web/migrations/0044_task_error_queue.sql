-- Persist non-quota runtime failures without discarding task workspaces.
-- SQLite cannot ALTER a CHECK constraint, so rebuild tasks and task_actions.
-- D1 enforces foreign keys inside an implicit transaction and does not allow
-- PRAGMA foreign_keys=OFF. Back up and drop child tables first because deferred
-- constraints do not disable ON DELETE CASCADE actions.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE task_dependencies_backup AS SELECT task_id, depends_on FROM task_dependencies;
CREATE TABLE messages_backup AS SELECT id, task_id, sender_type, sender_id, content, created_at FROM messages;
CREATE TABLE task_actions_backup AS
  SELECT id, task_id, actor_type, actor_id, action, detail, session_id, created_at FROM task_actions;
DROP TABLE task_dependencies;
DROP TABLE messages;
DROP TABLE task_actions;

CREATE TABLE tasks_new (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'todo'
                CHECK(status IN ('todo', 'in_progress', 'in_review', 'error', 'done', 'cancelled')),
  title         TEXT NOT NULL,
  description   TEXT,
  repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  labels        TEXT,
  created_by    TEXT,
  assigned_to   TEXT REFERENCES agents(id) ON DELETE SET NULL,
  result        TEXT,
  pr_url        TEXT,
  input         TEXT,
  created_from  TEXT REFERENCES tasks_new(id) ON DELETE SET NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  seq           INTEGER NOT NULL DEFAULT 0,
  scheduled_at  TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO tasks_new (
  id, board_id, status, title, description, repository_id, labels, created_by,
  assigned_to, result, pr_url, input, created_from, position, created_at,
  updated_at, seq, scheduled_at, metadata
)
SELECT
  id, board_id, status, title, description, repository_id, labels, created_by,
  assigned_to, result, pr_url, input, created_from, position, created_at,
  updated_at, seq, scheduled_at, metadata
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_board ON tasks(board_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_repository ON tasks(repository_id);
CREATE INDEX idx_tasks_created_from ON tasks(created_from);
CREATE UNIQUE INDEX idx_tasks_board_seq ON tasks(board_id, seq);
CREATE INDEX idx_tasks_assigned_status ON tasks(assigned_to, status);

CREATE TABLE task_actions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_type  TEXT NOT NULL CHECK(actor_type IN ('user', 'machine', 'agent:worker', 'agent:leader', 'system')),
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK(action IN (
    'created', 'claimed', 'moved', 'commented', 'completed',
    'assigned', 'released', 'timed_out', 'cancelled', 'rejected', 'review_requested',
    'dispatched', 'dispatch_failed', 'failed', 'retried'
  )),
  detail      TEXT,
  session_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO task_actions (id, task_id, actor_type, actor_id, action, detail, session_id, created_at)
SELECT id, task_id, actor_type, actor_id, action, detail, session_id, created_at FROM task_actions_backup;
DROP TABLE task_actions_backup;
CREATE INDEX idx_task_actions_task ON task_actions(task_id, created_at);
CREATE INDEX idx_task_actions_actor ON task_actions(actor_id);
CREATE INDEX idx_task_actions_session ON task_actions(session_id);

CREATE TABLE task_dependencies (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK(task_id != depends_on)
);
INSERT INTO task_dependencies (task_id, depends_on)
SELECT task_id, depends_on FROM task_dependencies_backup;
DROP TABLE task_dependencies_backup;
CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on);

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent')),
  sender_id   TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO messages (id, task_id, sender_type, sender_id, content, created_at)
SELECT id, task_id, sender_type, sender_id, content, created_at FROM messages_backup;
DROP TABLE messages_backup;
CREATE INDEX idx_messages_task ON messages(task_id, created_at);

CREATE TABLE task_errors (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id  TEXT,
  runtime     TEXT,
  category    TEXT NOT NULL CHECK(category IN ('quota', 'authentication', 'configuration', 'provider', 'protocol', 'unknown')),
  code        TEXT,
  message     TEXT NOT NULL,
  http_status INTEGER,
  retryable   INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
  reset_at    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE INDEX idx_task_errors_task ON task_errors(task_id, created_at);
CREATE INDEX idx_task_errors_unresolved ON task_errors(task_id, resolved_at);

PRAGMA defer_foreign_keys = OFF;
