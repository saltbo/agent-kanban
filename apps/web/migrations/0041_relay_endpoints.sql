-- Relay endpoint configs for the Agents → 配额 tab: Kimi/DeepSeek-style
-- relays whose quota the server probes live. The token is stored plaintext
-- (the server-side live probe needs it); the API only ever returns
-- maskToken(token). Follow-up (v2): deliver these configs to daemons via the
-- heartbeat response so `ak start` can apply them to settings.json env.
CREATE TABLE IF NOT EXISTS relay_endpoints (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  token TEXT NOT NULL,
  model TEXT,
  model_map TEXT NOT NULL DEFAULT '{}',
  extra_env TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_endpoints_owner ON relay_endpoints(owner_id);
