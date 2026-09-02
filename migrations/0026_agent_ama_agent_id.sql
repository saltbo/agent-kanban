-- The AMA agent backing each AK agent is now created eagerly at agent creation
-- (not lazily at dispatch). Persist its id so dispatch reads it instead of
-- creating one. NULL means no AMA agent yet (e.g. builtin/seed agents created
-- before AMA was connected).
ALTER TABLE agents ADD COLUMN ama_agent_id TEXT;
