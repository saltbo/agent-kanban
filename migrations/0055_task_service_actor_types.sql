PRAGMA defer_foreign_keys = ON;

CREATE TABLE task_actor_sequence_v3 (
  name TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);

INSERT INTO task_actor_sequence_v3 (name, seq)
SELECT name, seq
FROM sqlite_sequence
WHERE name IN ('task_review_submission_order', 'task_event_offsets');

CREATE TABLE tasks_v3 (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
  title TEXT NOT NULL,
  description TEXT,
  repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  labels TEXT,
  created_by TEXT,
  assigned_to TEXT,
  assignee_identity_type TEXT CHECK(assignee_identity_type IN ('ak_agent', 'realmroot_actor')),
  transition_token TEXT,
  result TEXT,
  pr_url TEXT,
  input TEXT,
  created_from TEXT REFERENCES tasks_v3(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  seq INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  creation_token TEXT,
  active_claim_id TEXT REFERENCES task_actions_v3(id) ON DELETE SET NULL,
  assignee_name TEXT
);

CREATE TABLE task_actions_v3 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks_v3(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK(actor_type IN (
    'user', 'machine', 'service', 'realmroot:agent', 'agent:worker', 'agent:leader', 'system'
  )),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
    'created', 'claimed', 'moved', 'commented', 'completed',
    'assigned', 'released', 'timed_out', 'cancelled', 'rejected',
    'review_requested', 'dispatched', 'dispatch_failed'
  )),
  detail TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  actor_name TEXT
);

CREATE UNIQUE INDEX idx_task_actions_v3_id_task ON task_actions_v3(id, task_id);

CREATE TABLE task_dependencies_v3 (
  task_id TEXT NOT NULL REFERENCES tasks_v3(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks_v3(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK(task_id != depends_on)
);

CREATE TABLE messages_v3 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks_v3(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK(sender_type IN ('user', 'agent')),
  sender_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE task_review_submission_order_v3 (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL UNIQUE REFERENCES task_actions_v3(id) ON DELETE CASCADE
);

CREATE TABLE task_review_decisions_v3 (
  review_submission_id TEXT PRIMARY KEY REFERENCES task_actions_v3(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks_v3(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('rejection', 'completion')),
  reason TEXT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'machine', 'service', 'realmroot:agent', 'system')),
  actor_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'accepted')),
  effect_state TEXT NOT NULL DEFAULT 'pending' CHECK(effect_state IN ('pending', 'delivered')),
  action_id TEXT UNIQUE REFERENCES task_actions_v3(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  effect_delivered_at TEXT,
  CHECK((state = 'pending' AND action_id IS NULL AND decided_at IS NULL)
     OR (state = 'accepted' AND action_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK((effect_state = 'pending' AND effect_delivered_at IS NULL)
     OR (effect_state = 'delivered' AND state = 'accepted' AND effect_delivered_at IS NOT NULL)),
  CHECK((kind = 'rejection') OR reason IS NULL)
);

CREATE TABLE task_claim_deletions_v3 (
  claim_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks_v3(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL UNIQUE,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('realmroot:agent', 'system')),
  actor_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  FOREIGN KEY (claim_id, task_id) REFERENCES task_actions_v3(id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (action_id, task_id) REFERENCES task_actions_v3(id, task_id) ON DELETE CASCADE
);

CREATE TABLE task_event_offsets_v3 (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  action_id TEXT UNIQUE REFERENCES task_actions_v3(id) ON DELETE SET NULL
);

CREATE TABLE task_session_bindings_v3 (
  task_id TEXT PRIMARY KEY REFERENCES tasks_v3(id) ON DELETE CASCADE,
  claim_action_id TEXT NOT NULL UNIQUE,
  agent_actor_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  CHECK(length(agent_actor_id) > 0),
  CHECK(length(runtime) BETWEEN 1 AND 64),
  CHECK(length(runtime_session_id) BETWEEN 1 AND 1024),
  FOREIGN KEY (claim_action_id, task_id)
    REFERENCES task_actions_v3(id, task_id) ON DELETE CASCADE
);

INSERT INTO tasks_v3 (
  id, board_id, status, title, description, repository_id, labels, created_by,
  assigned_to, assignee_identity_type, transition_token, result, pr_url, input,
  created_from, position, created_at, updated_at, seq, scheduled_at, metadata,
  creation_token, active_claim_id, assignee_name
)
SELECT
  id, board_id, status, title, description, repository_id, labels, created_by,
  assigned_to, assignee_identity_type, transition_token, result, pr_url, input,
  created_from, position, created_at, updated_at, seq, scheduled_at, metadata,
  creation_token, active_claim_id, assignee_name
FROM tasks;

INSERT INTO task_actions_v3 (
  id, task_id, actor_type, actor_id, action, detail, session_id, created_at, actor_name
)
SELECT id, task_id, actor_type, actor_id, action, detail, session_id, created_at, actor_name
FROM task_actions;

INSERT INTO task_dependencies_v3 SELECT task_id, depends_on FROM task_dependencies;
INSERT INTO messages_v3 SELECT id, task_id, sender_type, sender_id, content, created_at FROM messages;
INSERT INTO task_review_submission_order_v3 SELECT ordinal, submission_id FROM task_review_submission_order;
INSERT INTO task_review_decisions_v3 SELECT * FROM task_review_decisions;
INSERT INTO task_claim_deletions_v3 SELECT * FROM task_claim_deletions;
INSERT INTO task_event_offsets_v3 SELECT sequence, task_id, action_id FROM task_event_offsets;
INSERT INTO task_session_bindings_v3 SELECT * FROM task_session_bindings;

DROP TRIGGER task_actions_event_offset_after_insert;
DROP TRIGGER task_actions_event_offset_after_delete;
DROP TRIGGER tasks_event_offsets_after_delete;
DROP TRIGGER task_actions_snapshot_assigned_realmroot_actor_name;

DROP TABLE task_review_decisions;
DROP TABLE task_review_submission_order;
DROP TABLE task_claim_deletions;
DROP TABLE task_session_bindings;
DROP TABLE task_event_offsets;
DROP TABLE messages;
DROP TABLE task_dependencies;
DROP TABLE tasks;
DROP TABLE task_actions;

ALTER TABLE tasks_v3 RENAME TO tasks;
ALTER TABLE task_actions_v3 RENAME TO task_actions;
ALTER TABLE task_dependencies_v3 RENAME TO task_dependencies;
ALTER TABLE messages_v3 RENAME TO messages;
ALTER TABLE task_review_submission_order_v3 RENAME TO task_review_submission_order;
ALTER TABLE task_review_decisions_v3 RENAME TO task_review_decisions;
ALTER TABLE task_claim_deletions_v3 RENAME TO task_claim_deletions;
ALTER TABLE task_event_offsets_v3 RENAME TO task_event_offsets;
ALTER TABLE task_session_bindings_v3 RENAME TO task_session_bindings;

DELETE FROM sqlite_sequence
WHERE name IN ('task_review_submission_order', 'task_event_offsets');
INSERT INTO sqlite_sequence (name, seq)
VALUES (
  'task_review_submission_order',
  MAX(
    COALESCE((SELECT seq FROM task_actor_sequence_v3 WHERE name = 'task_review_submission_order'), 0),
    COALESCE((SELECT MAX(ordinal) FROM task_review_submission_order), 0)
  )
);
INSERT INTO sqlite_sequence (name, seq)
VALUES (
  'task_event_offsets',
  MAX(
    COALESCE((SELECT seq FROM task_actor_sequence_v3 WHERE name = 'task_event_offsets'), 0),
    COALESCE((SELECT MAX(sequence) FROM task_event_offsets), 0)
  )
);
DROP TABLE task_actor_sequence_v3;

CREATE INDEX idx_tasks_board ON tasks(board_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_repository ON tasks(repository_id);
CREATE INDEX idx_tasks_created_from ON tasks(created_from);
CREATE UNIQUE INDEX idx_tasks_board_seq ON tasks(board_id, seq);
CREATE INDEX idx_tasks_assigned_status ON tasks(assigned_to, status);
CREATE INDEX idx_task_deps_depends ON task_dependencies(depends_on);
CREATE INDEX idx_messages_task ON messages(task_id, created_at);
CREATE INDEX idx_task_actions_task ON task_actions(task_id, created_at);
CREATE INDEX idx_task_actions_actor ON task_actions(actor_id);
CREATE INDEX idx_task_actions_session ON task_actions(session_id);
DROP INDEX idx_task_actions_v3_id_task;
CREATE UNIQUE INDEX idx_task_actions_id_task ON task_actions(id, task_id);
CREATE INDEX idx_task_review_decisions_task ON task_review_decisions(task_id, created_at);
CREATE INDEX idx_task_review_decisions_state ON task_review_decisions(state, created_at);
CREATE INDEX idx_task_claim_deletions_task ON task_claim_deletions(task_id, deleted_at);
CREATE INDEX idx_task_event_offsets_task_sequence ON task_event_offsets(task_id, sequence DESC);
CREATE INDEX idx_task_session_bindings_runtime_session ON task_session_bindings(runtime, runtime_session_id);

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

CREATE TRIGGER task_actions_snapshot_assigned_realmroot_actor_name
AFTER INSERT ON task_actions
WHEN NEW.actor_type = 'realmroot:agent'
  AND NEW.actor_name IS NULL
BEGIN
  UPDATE task_actions
  SET actor_name = (
    SELECT task.assignee_name
    FROM tasks task
    WHERE task.id = NEW.task_id
      AND task.assigned_to = NEW.actor_id
      AND task.assignee_identity_type = 'realmroot_actor'
  )
  WHERE id = NEW.id
    AND EXISTS (
      SELECT 1
      FROM tasks task
      WHERE task.id = NEW.task_id
        AND task.assigned_to = NEW.actor_id
        AND task.assignee_identity_type = 'realmroot_actor'
        AND task.assignee_name IS NOT NULL
    );
END;

PRAGMA defer_foreign_keys = OFF;
