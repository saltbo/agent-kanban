-- Add scheduled_at for deferred task scheduling (one-time, not recurring).
-- NULL means immediately schedulable.
ALTER TABLE tasks ADD COLUMN scheduled_at TEXT;
