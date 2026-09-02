ALTER TABLE boards ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';

UPDATE boards
SET labels = COALESCE(
  (
    SELECT json_group_array(json_object('name', label, 'color', '#71717A', 'description', ''))
    FROM (
      SELECT DISTINCT json_each.value AS label
      FROM tasks, json_each(tasks.labels)
      WHERE tasks.board_id = boards.id
        AND json_each.value IS NOT NULL
        AND json_each.value != ''
      ORDER BY label
    )
  ),
  '[]'
);

ALTER TABLE tasks DROP COLUMN priority;
