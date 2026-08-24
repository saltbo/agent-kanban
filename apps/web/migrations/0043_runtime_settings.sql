-- Per-owner local runtime preferences. The JSON document is normalized by
-- the route layer and delivered to machines through heartbeat responses.
ALTER TABLE owner_settings ADD COLUMN runtime TEXT NOT NULL DEFAULT '{}';
