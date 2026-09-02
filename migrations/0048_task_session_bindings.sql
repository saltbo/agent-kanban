CREATE TABLE task_session_bindings (
  task_id            TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  claim_action_id    TEXT NOT NULL UNIQUE,
  agent_actor_id     TEXT NOT NULL,
  runtime            TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  bound_at           TEXT NOT NULL,
  CHECK(length(agent_actor_id) > 0),
  CHECK(length(runtime) BETWEEN 1 AND 64),
  CHECK(length(runtime_session_id) BETWEEN 1 AND 1024),
  FOREIGN KEY (claim_action_id, task_id)
    REFERENCES task_actions(id, task_id) ON DELETE CASCADE
);

CREATE INDEX idx_task_session_bindings_runtime_session
  ON task_session_bindings(runtime, runtime_session_id);
