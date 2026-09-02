-- Keep the current Claim generation explicit so a conditional DELETE never
-- infers ownership from action timestamps or deletes a later Claim generation.
ALTER TABLE tasks ADD COLUMN active_claim_id TEXT REFERENCES task_actions(id) ON DELETE SET NULL;

UPDATE tasks
SET active_claim_id = (
  SELECT action.id
  FROM task_actions action
  WHERE action.task_id = tasks.id
    AND action.action = 'claimed'
    AND action.actor_type = 'realmroot:agent'
    AND action.actor_id = tasks.assigned_to
)
WHERE status IN ('in_progress', 'in_review')
  AND assignee_identity_type = 'realmroot_actor'
  AND 1 = (
    SELECT COUNT(*)
    FROM task_actions action
    WHERE action.task_id = tasks.id
      AND action.action = 'claimed'
      AND action.actor_type = 'realmroot:agent'
      AND action.actor_id = tasks.assigned_to
  )
  AND NOT EXISTS (
    SELECT 1
    FROM task_actions action
    WHERE action.task_id = tasks.id
      AND action.action IN ('released', 'timed_out')
  );

CREATE UNIQUE INDEX idx_task_actions_id_task ON task_actions(id, task_id);

CREATE TABLE task_claim_deletions (
  claim_id       TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action_id      TEXT NOT NULL UNIQUE,
  actor_type     TEXT NOT NULL CHECK(actor_type IN ('realmroot:agent', 'system')),
  actor_id       TEXT NOT NULL,
  deleted_at     TEXT NOT NULL,
  FOREIGN KEY (claim_id, task_id) REFERENCES task_actions(id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (action_id, task_id) REFERENCES task_actions(id, task_id) ON DELETE CASCADE
);

CREATE INDEX idx_task_claim_deletions_task ON task_claim_deletions(task_id, deleted_at);
