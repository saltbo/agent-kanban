CREATE TABLE task_review_submission_order (
  ordinal       INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL UNIQUE REFERENCES task_actions(id) ON DELETE CASCADE
);

INSERT INTO task_review_submission_order (submission_id)
SELECT id
FROM task_actions
WHERE action = 'review_requested' AND actor_type = 'realmroot:agent'
ORDER BY created_at, id;

CREATE TABLE task_review_decisions (
  review_submission_id TEXT PRIMARY KEY REFERENCES task_actions(id) ON DELETE CASCADE,
  task_id              TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK(kind IN ('rejection', 'completion')),
  reason               TEXT,
  actor_type           TEXT NOT NULL CHECK(actor_type IN ('user', 'realmroot:agent', 'system')),
  actor_id             TEXT NOT NULL,
  reservation_id       TEXT NOT NULL UNIQUE,
  state                TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'accepted')),
  effect_state         TEXT NOT NULL DEFAULT 'pending' CHECK(effect_state IN ('pending', 'delivered')),
  action_id            TEXT UNIQUE REFERENCES task_actions(id) ON DELETE CASCADE,
  created_at           TEXT NOT NULL,
  decided_at           TEXT,
  effect_delivered_at  TEXT,
  CHECK((state = 'pending' AND action_id IS NULL AND decided_at IS NULL)
     OR (state = 'accepted' AND action_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK((effect_state = 'pending' AND effect_delivered_at IS NULL)
     OR (effect_state = 'delivered' AND state = 'accepted' AND effect_delivered_at IS NOT NULL)),
  CHECK((kind = 'rejection') OR reason IS NULL)
);

CREATE INDEX idx_task_review_decisions_task ON task_review_decisions(task_id, created_at);
CREATE INDEX idx_task_review_decisions_state ON task_review_decisions(state, created_at);
