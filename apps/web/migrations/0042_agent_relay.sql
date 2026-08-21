-- Agents can pin a relay endpoint (Agents → Relay tab)
-- Dispatch injects the relay's ANTHROPIC_BASE_URL/model env and delivers its
-- token via the session vault secret. Nullable — NULL = default provider.
ALTER TABLE agents ADD COLUMN relay_id TEXT;
