ALTER TABLE tasks ADD COLUMN assignee_name TEXT;
ALTER TABLE task_actions ADD COLUMN actor_name TEXT;

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
